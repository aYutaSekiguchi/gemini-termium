import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBridgeServer } from '../src/server.js';
import { startAutoInjector } from '../src/cdpClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.resolve(PROJECT_ROOT, 'extension/content.js');

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function findChromeBinary() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

describe('E2E: Workspace Bridge & Slash Command Interception in Gemini DOM', () => {
  let bridgePort;
  let cdpPort;
  let webPort;
  let tmpWorkspaceDir;
  let webServer;
  let bridgeServer;
  let chromeProcess;
  let autoInjector;
  let cdpWs;
  let msgSeq = 1;

  function evaluateInPage(expression) {
    return new Promise((resolve, reject) => {
      if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('CDP WebSocket is not connected'));
      }
      const id = msgSeq++;
      const onMessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            cdpWs.removeEventListener('message', onMessage);
            if (data.error) {
              reject(new Error(data.error.message || JSON.stringify(data.error)));
            } else if (data.result?.exceptionDetails) {
              reject(new Error(data.result.exceptionDetails.text || 'Script threw an exception'));
            } else {
              resolve(data.result?.result?.value);
            }
          }
        } catch {}
      };
      cdpWs.addEventListener('message', onMessage);
      cdpWs.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });
  }

  async function pollUntil(fn, timeoutMs = 8000, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fn();
      if (res) return res;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
  }

  before(async () => {
    const chromeBin = findChromeBinary();
    if (!chromeBin) {
      throw new Error('No compatible Chrome/Chromium binary found for E2E testing.');
    }

    bridgePort = await getAvailablePort();
    cdpPort = await getAvailablePort();
    webPort = await getAvailablePort();
    tmpWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtw-e2e-suite-'));

    // 1. Mock Gemini DOM Page Server
    const mockHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Gemini E2E Mock Page</title>
</head>
<body>
  <div class="chat-app">
    <div class="chat-history">
      <div class="conversation-container">
        <model-response>
          <div class="model-response-text">
            <p>Assistant response with runnable shell snippet and code file:</p>
            <pre class="language-bash"><code>echo "snippet-executed"</code></pre>
            <pre class="language-javascript"><code>// filepath: e2e_sample.js
console.log("hello from e2e test");</code></pre>
          </div>
        </model-response>
      </div>
    </div>

    <div class="bottom-container">
      <rich-textarea>
        <div contenteditable="true" role="textbox" aria-label="Ask Gemini">
          <p><br></p>
        </div>
      </rich-textarea>
      <button data-test-id="send-button" aria-label="Send message">Send</button>
    </div>
  </div>
</body>
</html>`;

    webServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mockHtml);
    });
    await new Promise((resolve) => webServer.listen(webPort, '127.0.0.1', resolve));

    // 2. Start Local Bridge Server
    bridgeServer = createBridgeServer({ cwd: tmpWorkspaceDir, cdpPort });
    await bridgeServer.listen(bridgePort);

    // 3. Launch Chrome Headless
    chromeProcess = spawn(chromeBin, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-web-security',
      '--allow-running-insecure-content',
      `http://127.0.0.1:${webPort}`
    ]);

    // 4. Start Auto Injector with CDP Binding & In-Page Script
    autoInjector = startAutoInjector({
      cwd: tmpWorkspaceDir,
      cdpPort,
      bridgePort,
      scriptPath: SCRIPT_PATH
    });

    // 5. Connect CDP test client to the mock Gemini tab
    const targetPage = await pollUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        if (!res.ok) return null;
        const targets = await res.json();
        return targets.find((t) => t.type === 'page' && t.url.includes(`:${webPort}`));
      } catch {
        return null;
      }
    }, 6000);

    cdpWs = new WebSocket(targetPage.webSocketDebuggerUrl);
    await new Promise((resolve) => { cdpWs.onopen = resolve; });
  });

  after(async () => {
    if (cdpWs) {
      try { cdpWs.close(); } catch {}
    }
    if (autoInjector) {
      autoInjector.stop();
    }
    if (chromeProcess && !chromeProcess.killed) {
      try { chromeProcess.kill('SIGTERM'); } catch {}
    }
    if (bridgeServer) {
      await bridgeServer.close();
    }
    if (webServer) {
      await new Promise((resolve) => webServer.close(resolve));
    }
    if (tmpWorkspaceDir && fs.existsSync(tmpWorkspaceDir)) {
      fs.rmSync(tmpWorkspaceDir, { recursive: true, force: true });
    }
  });

  it('1. Verifies in-page bridge HUD badge connects and displays active workspace name', async () => {
    const badgeConnected = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const badge = document.querySelector('.gtw-hud-badge');
          if (badge && badge.classList.contains('connected')) {
            return badge.textContent.trim();
          }
          return null;
        })()
      `);
    }, 8000);

    const workspaceName = path.basename(tmpWorkspaceDir);
    assert.match(badgeConnected, new RegExp(workspaceName));
  });

  it('2. Intercepts /help command on Enter, displays toast, and clears prompt input', async () => {
    const toastMessage = await evaluateInPage(`
      (() => {
        const ed = document.querySelector('[contenteditable="true"]');
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = document.createElement('p');
        p.textContent = '/help';
        ed.appendChild(p);

        const ev = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true
        });
        p.dispatchEvent(ev);

        const toast = document.querySelector('.gtw-hud-toast');
        return toast ? toast.textContent.trim() : '';
      })()
    `);

    assert.match(toastMessage, /\/apply/);
    assert.match(toastMessage, /\/run/);
    assert.match(toastMessage, /\/zip/);

    // Verify prompt input was cleared back to an empty paragraph
    const editorText = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
    assert.equal(editorText, '');
  });

  it('3. Intercepts /status command via Send button click and shows workspace toast', async () => {
    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('[contenteditable="true"]');
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = document.createElement('p');
        p.textContent = '/status';
        ed.appendChild(p);

        const btn = document.querySelector('button[data-test-id="send-button"]');
        btn.click();
      })()
    `);

    const toastMessage = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('.gtw-hud-toast')?.textContent.trim()`);
      return text && text.includes('Connected to workspace:') ? text : null;
    }, 5000);

    assert.match(toastMessage, /Connected to workspace:/);
    assert.match(toastMessage, new RegExp(path.basename(tmpWorkspaceDir)));
  });

  it('4. Intercepts /run [command] and renders stdout in the console drawer', async () => {
    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('[contenteditable="true"]');
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = document.createElement('p');
        p.textContent = '/run echo "e2e_command_success"';
        ed.appendChild(p);

        const ev = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true
        });
        p.dispatchEvent(ev);
      })()
    `);

    const output = await pollUntil(async () => {
      const drawerBody = await evaluateInPage(`
        (() => {
          const drawer = document.querySelector('.gtw-console-drawer');
          if (drawer && drawer.style.display !== 'none') {
            return document.querySelector('.gtw-console-body')?.textContent.trim();
          }
          return null;
        })()
      `);
      return drawerBody && drawerBody.includes('e2e_command_success') ? drawerBody : null;
    }, 6000);

    assert.match(output, /e2e_command_success/);
  });

  it('5. Intercepts /apply and writes code block to local workspace file on disk', async () => {
    const targetFilePath = path.join(tmpWorkspaceDir, 'e2e_sample.js');
    assert.equal(fs.existsSync(targetFilePath), false, 'File should not exist before apply');

    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('[contenteditable="true"]');
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = document.createElement('p');
        p.textContent = '/apply';
        ed.appendChild(p);

        const ev = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true
        });
        p.dispatchEvent(ev);
      })()
    `);

    const toastMessage = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('.gtw-hud-toast')?.textContent.trim()`);
      return text && text.includes('Applied 1 file(s): e2e_sample.js') ? text : null;
    }, 6000);

    assert.match(toastMessage, /Applied 1 file\(s\): e2e_sample\.js/);
    assert.equal(fs.existsSync(targetFilePath), true, 'File should now exist on disk');

    const fileContent = fs.readFileSync(targetFilePath, 'utf8');
    assert.match(fileContent, /hello from e2e test/);
  });

  it('6. Injects action buttons onto code blocks and executes command on button click', async () => {
    const buttonsInjected = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const runBtn = document.querySelector('.gtw-code-btn.run');
          const applyBtn = document.querySelector('.gtw-code-btn.apply');
          return Boolean(runBtn && applyBtn);
        })()
      `);
    }, 5000);

    assert.equal(buttonsInjected, true, 'Code block action buttons must be injected into DOM');

    // Click the "⚡ Run Locally" button
    await evaluateInPage(`
      (() => {
        const runBtn = document.querySelector('.gtw-code-btn.run');
        runBtn.click();
      })()
    `);

    const output = await pollUntil(async () => {
      const drawerBody = await evaluateInPage(`
        document.querySelector('.gtw-console-body')?.textContent.trim()
      `);
      return drawerBody && drawerBody.includes('snippet-executed') ? drawerBody : null;
    }, 6000);

    assert.match(output, /snippet-executed/);
  });
});
