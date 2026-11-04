import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBridgeServer } from './server.js';
import { startAutoInjector } from './cdpClient.js';
import { createTermiumGrpcServer } from './termiumGrpcService.js';
import { locateChromeBinary, findAvailablePort } from './chromeManager.js';
import { cleanStaleProfileLocks } from './profileManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.resolve(PROJECT_ROOT, 'extension');

export function buildChromeArgs({ profileDir, cdpPort, isHeadless = true } = {}) {
  const userAgent = process.platform === 'darwin'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${userAgent}`,
    '--window-size=1280,800',
    // Memory optimizations
    '--disable-breakpad',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--js-flags=--max-old-space-size=256',
    '--app=https://gemini.google.com'
  ];

  if (isHeadless) {
    chromeArgs.unshift('--headless=new');
  }

  return chromeArgs;
}

export async function waitForChromeWsUrl(cdpPort, chromeProcess = null, maxRetries = 40, intervalMs = 150) {
  if (typeof chromeProcess === 'number') {
    maxRetries = chromeProcess;
    chromeProcess = null;
  }

  for (let i = 0; i < maxRetries; i++) {
    if (chromeProcess && chromeProcess.exitCode !== null) {
      const code = chromeProcess.exitCode;
      const stderr = typeof chromeProcess.lastStderr === 'function'
        ? chromeProcess.lastStderr()
        : (chromeProcess.lastStderr || '');
      const detail = stderr ? `\nChrome stderr: ${stderr.trim()}` : '';
      if (code === 21) {
        throw new Error(`Chrome exited prematurely with code 21 (Profile in use). The profile directory is locked by another process.${detail}`);
      }
      throw new Error(`Chrome exited prematurely with code ${code}.${detail}`);
    }

    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) {
        const data = await res.json();
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl;
        }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for Chrome DevTools on port ${cdpPort}`);
}

export async function startBackend({
  cwd = process.cwd(),
  profileDir,
  chromeBin = locateChromeBinary(),
  cdpPort = null,
  grpcPort = null,
  bridgePort = null,
  isHeadless = true
} = {}) {
  if (!chromeBin) {
    throw new Error('No compatible Google Chrome / Chromium binary found.');
  }

  // 0. Clean stale locks and orphan processes for this profile before port binding
  if (profileDir) {
    cleanStaleProfileLocks(profileDir);
  }

  // 1. Resolve available ports
  const activeCdpPort = cdpPort || (await findAvailablePort(9222));
  const activeBridgePort = bridgePort || (await findAvailablePort(45140));
  const activeGrpcPort = grpcPort || (await findAvailablePort(50051));

  // 2. Assemble Chrome args with memory optimization and security integrity
  const chromeArgs = buildChromeArgs({
    profileDir,
    cdpPort: activeCdpPort,
    isHeadless
  });

  console.log(`✦ Launching Chrome (${isHeadless ? 'headless' : 'desktop window'})...`);
  let lastStderr = '';
  const chromeProcess = spawn(chromeBin, chromeArgs, {
    stdio: isHeadless ? ['ignore', 'ignore', 'pipe'] : 'inherit'
  });
  if (chromeProcess.stderr) {
    chromeProcess.stderr.on('data', (chunk) => {
      lastStderr += chunk.toString();
      if (lastStderr.length > 2000) {
        lastStderr = lastStderr.slice(-2000);
      }
    });
  }
  chromeProcess.lastStderr = () => lastStderr;

  let isClosed = false;
  let bridgeServer = null;
  let grpcServer = null;
  let autoInjector = null;

  const close = async () => {
    if (isClosed) return;
    isClosed = true;

    if (autoInjector) {
      try { autoInjector.stop(); } catch {}
    }
    if (grpcServer) {
      try { await grpcServer.close(); } catch {}
    }
    if (bridgeServer) {
      try { await bridgeServer.close(); } catch {}
    }
    if (chromeProcess && !chromeProcess.killed) {
      try { chromeProcess.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { chromeProcess.kill('SIGKILL'); } catch {}
      }, 1000).unref();
    }
    if (profileDir) {
      cleanStaleProfileLocks(profileDir);
    }
  };

  chromeProcess.on('exit', () => {
    close();
  });

  try {
    // 3. Wait for DevTools WS endpoint
    const wsUrl = await waitForChromeWsUrl(activeCdpPort, chromeProcess);

    // 4. Start local workspace bridge HTTP server
    bridgeServer = createBridgeServer({ cwd, cdpPort: activeCdpPort });
    const boundBridgePort = await bridgeServer.listen(activeBridgePort);

    // 5. Start in-process Termium gRPC server
    grpcServer = createTermiumGrpcServer({
      browserWsUrl: wsUrl,
      port: activeGrpcPort,
      homepage: 'https://gemini.google.com'
    });
    const boundGrpcPort = await grpcServer.listen(activeGrpcPort);

    // 6. Start CDP Auto Injector for Slash Commands & Trusted Types
    autoInjector = startAutoInjector({
      cwd,
      cdpPort: activeCdpPort,
      bridgePort: boundBridgePort,
      scriptPath: path.resolve(EXTENSION_DIR, 'content.js')
    });

    return {
      cdpPort: activeCdpPort,
      bridgePort: boundBridgePort,
      grpcPort: boundGrpcPort,
      wsUrl,
      chromeProcess,
      close
    };
  } catch (err) {
    await close();
    throw err;
  }
}
