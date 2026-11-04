import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { locateChromeBinary, findAvailablePort } from '../src/chromeManager.js';
import { createTermiumGrpcServer } from '../src/termiumGrpcService.js';
import grpc from '@grpc/grpc-js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bc = require('../vendor/termium/server/dist/generated/bc.js');

test('Termium gRPC Service: attaches to Chrome and captures screenshot', async (t) => {
  const chromeBin = locateChromeBinary();
  if (!chromeBin) {
    console.log('Skipping test: Chrome binary not found');
    return;
  }

  const cdpPort = await findAvailablePort(9300);
  const grpcPort = await findAvailablePort(50100);
  const tmpProfile = path.join(os.tmpdir(), `test-profile-${Date.now()}`);
  fs.mkdirSync(tmpProfile, { recursive: true });

  const chromeProcess = spawn(chromeBin, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    'about:blank'
  ]);

  t.after(() => {
    try { chromeProcess.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  });

  // Wait for DevTools listening
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      const data = await res.json();
      if (data.webSocketDebuggerUrl) {
        wsUrl = data.webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }
  assert.ok(wsUrl, 'Chrome WebSocket Debugger URL should be available');

  // Start in-process Termium gRPC Server
  const grpcServer = createTermiumGrpcServer({
    browserWsUrl: wsUrl,
    port: grpcPort,
    homepage: 'about:blank'
  });
  const activeGrpcPort = await grpcServer.listen(grpcPort);
  assert.strictEqual(activeGrpcPort, grpcPort);

  t.after(async () => {
    await grpcServer.close();
  });

  // Test via gRPC Client
  const client = new bc.BrowserControlClient(
    `127.0.0.1:${activeGrpcPort}`,
    grpc.credentials.createInsecure()
  );

  const state = await new Promise((resolve, reject) => {
    client.getBrowserState({}, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

  assert.ok(state, 'Should return browser state');
  console.log(`Test passed: URL=${state.url}, title=${state.title}`);

  // Test screenshot capture
  const screenshot = await new Promise((resolve, reject) => {
    client.captureScreenshot({ format: 'png' }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

  assert.ok(screenshot.data.length > 0, 'Screenshot data length should be > 0');
  console.log(`Test passed: screenshot length=${screenshot.data.length}`);
});
