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
import { locateChromeBinary } from '../src/chromeManager.js';

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
              const exDesc = data.result.exceptionDetails.exception?.description || data.result.exceptionDetails.text;
              reject(new Error(`In-page exception: ${exDesc}`));
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
    const chromeBin = locateChromeBinary();
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
      '--disable-blink-features=AutomationControlled',
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

    assert.match(toastMessage, /\/run/);
    assert.match(toastMessage, /\/agent/);

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

  it('5. Does not inject in-DOM Run Locally buttons and parses bare run-command block cleanly', async () => {
    // 1. Verify that legacy .gtw-code-btn is NOT injected into the DOM
    const buttonsFound = await evaluateInPage(`
      (() => {
        return Boolean(document.querySelector('.gtw-code-btn'));
      })()
    `);
    assert.equal(buttonsFound, false, 'In-DOM code block action buttons must NOT be injected');

    // 2. Simulate Gemini emitting run-command: with bare code block (no language specified)
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        const p = document.createElement('p');
        p.textContent = 'run-command:';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = 'echo "bare_run_command_success"';
        pre.appendChild(code);
        inner.appendChild(p);
        inner.appendChild(pre);
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting command from bare run-command block (and not "Run locally")
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Execute Shell Command') && card.innerText.includes('bare_run_command_success'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear for bare run-command block');

    // Verify "Run locally" is NOT anywhere in the approval modal or parsed command
    const cardText = await evaluateInPage(`document.querySelector('.gtw-agent-approval-card')?.innerText || ''`);
    assert.doesNotMatch(cardText, /Run locally/i);

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify command output submitted to editor
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`(document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)') || document.querySelector('[contenteditable="true"]'))?.textContent.trim()`);
      return text && text.includes('bare_run_command_success') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive command output from bare run-command block');
  });

  it('6. Detects agent natural save action, prompts Human-in-the-Loop card, and executes upon user approval', async () => {
    // Inject a simulated agent response with natural save: agent_test.txt
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'save: agent_test.txt\\n\`\`\`\\ncreated by autonomous agent\\n\`\`\`';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify Human-in-the-Loop card appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Agent Request') && card.innerText.includes('Human Approval Required'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear when agent tag is emitted');

    // User clicks Approve (or presses 'y')
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file written to disk
    const targetFile = path.join(tmpWorkspaceDir, 'agent_test.txt');
    const written = await pollUntil(async () => {
      return fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : null;
    }, 5000);
    assert.equal(written, 'created by autonomous agent');

    // Verify prompt input contains human-triggered tool result formatted for reply
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('Successfully saved') ? text : null;
    }, 5000);
    assert.match(editorResult, /Successfully saved 1 file change/);
  });

  it('7. Intercepts /agent command and auto-injects workspace file tree into prompt', async () => {
    // Write sample file into workspace so it appears in the tree
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'tree_sample.js'), 'console.log(123);');

    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('[contenteditable="true"]');
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = document.createElement('p');
        p.textContent = '/agent fix tree_sample.js bug';
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

    // Verify prompt was populated with skill invocation, workspace file tree, and task
    const editorContent = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('Workspace files') ? text : null;
    }, 5000);

    assert.ok(editorContent.includes('@pair-programmer'), 'Prompt must invoke @pair-programmer skill');
    assert.ok(editorContent.includes('tree_sample.js'), 'Prompt must contain workspace file tree');
    assert.ok(editorContent.includes('fix tree_sample.js bug'), 'Prompt must contain user task');
  });

  it('8. Detects tool call from rendered DOM code block with language attribute', async () => {
    // Simulate rendered code block from markdown ```bash\necho "dom_bash_success"\n```
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-bash';
        code.textContent = 'echo "dom_bash_success"';
        pre.appendChild(code);
        resp.appendChild(pre);
        document.body.appendChild(resp);
      })()
    `);

    // Verify modal detects command from DOM code block
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Execute Shell Command') && card.innerText.includes('dom_bash_success'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Modal must detect command from rendered DOM code block');

    // User approves
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify command executed and result submitted
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('dom_bash_success') ? text : null;
    }, 5000);

    assert.ok(editorResult.includes('dom_bash_success'));
    assert.ok(editorResult.includes('terminal output'));
  });

  it('9. Guards untagged bare response fallback against premature evaluation during active streaming', async () => {
    // Step 1: Simulate streaming chunk with aria-busy="true"
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const div = document.createElement('div');
        div.id = 'streaming-test-content';
        div.className = 'model-response-text';
        div.setAttribute('aria-busy', 'true');
        div.textContent = 'package.json';
        resp.appendChild(div);
        document.body.appendChild(resp);
      })()
    `);

    // Wait 400ms and verify modal did NOT appear while streaming
    await new Promise((r) => setTimeout(r, 400));
    const cardWhileStreaming = await evaluateInPage(`Boolean(document.querySelector('.gtw-agent-approval-card'))`);
    assert.equal(cardWhileStreaming, false, 'Modal must not trigger on bare token while response is busy/streaming');

    // Step 2: Response updates with explanation and finishes streaming
    await evaluateInPage(`
      (() => {
        const div = document.getElementById('streaming-test-content');
        if (div) {
          div.textContent = 'package.json contains dependencies for this repository.';
          div.setAttribute('aria-busy', 'false');
        }
      })()
    `);

    // Wait 400ms and verify modal did NOT appear (not a tool call)
    await new Promise((r) => setTimeout(r, 400));
    const cardOnExplanation = await evaluateInPage(`Boolean(document.querySelector('.gtw-agent-approval-card'))`);
    assert.equal(cardOnExplanation, false, 'Modal must not trigger on normal explanation text');

    // Step 3: Response genuinely finishes with single bare file path
    await evaluateInPage(`
      (() => {
        const div = document.getElementById('streaming-test-content');
        if (div) {
          div.textContent = 'package.json';
          div.setAttribute('aria-busy', 'false');
        }
      })()
    `);

    // Verify modal DOES appear once completed
    const cardOnCompletion = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('package.json'));
        })()
      `);
    }, 5000);
    assert.equal(cardOnCompletion, true, 'Modal must trigger for completed bare file response');
  });

  it('10. Resolves real editor excluding .ql-clipboard and clicks send button upon approval', async () => {
    // Write sample file
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'test-lib.js'), 'export const hello = "world";');

    // Setup realistic Gemini DOM by adding .ql-clipboard to existing rich-textarea and tracking submit click
    await evaluateInPage(`
      (() => {
        window.__TEST_SUBMIT_CLICKED__ = false;

        const rich = document.querySelector('rich-textarea');
        const realEditor = rich.querySelector('[contenteditable="true"]');
        realEditor.classList.add('ql-editor');
        realEditor.innerHTML = '<p><br></p>';

        // Append hidden clipboard inside rich-textarea AFTER real editor
        let clip = rich.querySelector('.ql-clipboard');
        if (!clip) {
          clip = document.createElement('div');
          clip.className = 'ql-clipboard';
          clip.setAttribute('contenteditable', 'true');
          clip.setAttribute('tabindex', '-1');
          rich.appendChild(clip);
        }
        clip.innerHTML = '';

        // Attach listener to send button
        const sendBtn = document.querySelector('button[aria-label="Send message"], [data-test-id="send-button"]');
        if (sendBtn) {
          sendBtn.onclick = () => {
            window.__TEST_SUBMIT_CLICKED__ = true;
          };
        }

        // Simulate Gemini tool call
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'send-me: test-lib.js';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('test-lib.js'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear');

    // Click approve
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify real editor gets the content and clipboard does NOT, and send button was clicked
    const verifyResult = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const real = document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)');
          const clip = document.querySelector('rich-textarea .ql-clipboard');
          const submitted = window.__TEST_SUBMIT_CLICKED__;

          if (real && real.textContent.includes('test-lib.js') && real.textContent.includes('hello = "world"') && submitted) {
            return {
              ok: true,
              clipEmpty: clip.textContent.trim() === '',
              realText: real.textContent,
              submitted
            };
          }
          return null;
        })()
      `);
    }, 5000);

    assert.ok(verifyResult, 'Must populate real editor and click submit button');
    assert.equal(verifyResult.clipEmpty, true, '.ql-clipboard must remain untouched');
    assert.equal(verifyResult.submitted, true, 'Send button must be clicked');
  });

  it('11. Captures "y" keyboard shortcut to approve tool call even when composer is actively focused', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'key-approve-sample.txt'), 'keyboard_approve_success_payload');

    // Simulate composer actively focused by user, then Gemini emits send-me: request
    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('rich-textarea [contenteditable="true"]');
        if (ed) ed.focus();

        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'send-me: key-approve-sample.txt';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('key-approve-sample.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear');

    // User presses 'y' key in terminal / browser (dispatched to window/document while composer had focus)
    await evaluateInPage(`
      (() => {
        const target = document.activeElement || window;
        const ev = new KeyboardEvent('keydown', {
          key: 'y',
          code: 'KeyY',
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(ev);
      })()
    `);

    // Verify modal dismissed and tool result contains read file content
    const editorResult = await pollUntil(async () => {
      const state = await evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          const ed = document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)') || document.querySelector('[contenteditable="true"]');
          return {
            hasCard: Boolean(card),
            text: ed ? ed.textContent.trim() : ''
          };
        })()
      `);
      if (!state.hasCard && state.text && state.text.includes('keyboard_approve_success_payload')) {
        return state.text;
      }
      return null;
    }, 5000);

    assert.ok(editorResult, 'Modal must close and file content must be submitted via "y" key');
    assert.match(editorResult, /keyboard_approve_success_payload/);
  });

  it('12. Captures "n" keyboard shortcut to reject tool call even when composer is actively focused', async () => {
    // Simulate composer actively focused by user, then Gemini emits send-me: request
    await evaluateInPage(`
      (() => {
        const ed = document.querySelector('rich-textarea [contenteditable="true"]');
        if (ed) ed.focus();

        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'send-me: key-reject-sample.txt';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('key-reject-sample.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear');

    // User presses 'n' key in terminal / browser
    await evaluateInPage(`
      (() => {
        const target = document.activeElement || window;
        const ev = new KeyboardEvent('keydown', {
          key: 'n',
          code: 'KeyN',
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(ev);
      })()
    `);

    // Verify modal dismissed and rejected notification appears in editor without executing file read
    const editorResult = await pollUntil(async () => {
      const state = await evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          const ed = document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)') || document.querySelector('[contenteditable="true"]');
          return {
            hasCard: Boolean(card),
            text: ed ? ed.textContent.trim() : ''
          };
        })()
      `);
      if (!state.hasCard && state.text && state.text.includes('decided not to execute')) {
        return state.text;
      }
      return null;
    }, 5000);

    assert.ok(editorResult, 'Modal must close and rejection text must be populated via "n" key');
    assert.match(editorResult, /decided not to execute/);
  });

  it('13. Approves tool call via pointerdown event on Approve button', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'pointer-approve-sample.txt'), 'pointer_event_success_data');

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'send-me: pointer-approve-sample.txt';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('pointer-approve-sample.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear');

    // Trigger pointerdown (such as from terminal cursor or touch input)
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) {
          const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
          btn.dispatchEvent(ev);
        }
      })()
    `);

    const editorResult = await pollUntil(async () => {
      const state = await evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          const ed = document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)') || document.querySelector('[contenteditable="true"]');
          return {
            hasCard: Boolean(card),
            text: ed ? ed.textContent.trim() : ''
          };
        })()
      `);
      if (!state.hasCard && state.text && state.text.includes('pointer_event_success_data')) {
        return state.text;
      }
      return null;
    }, 5000);

    assert.ok(editorResult, 'Modal must close and file content must be submitted via pointerdown');
    assert.match(editorResult, /pointer_event_success_data/);
  });

  it('14. Detects file read action from natural markdown "cat <file>" bash code block', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'natural-read.txt'), 'natural_markdown_read_content');

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const p = document.createElement('p');
        p.textContent = 'To investigate the problem, let us check natural-read.txt:';
        const pre = document.createElement('pre');
        pre.className = 'language-bash';
        const code = document.createElement('code');
        code.textContent = 'cat natural-read.txt';
        pre.appendChild(code);
        resp.appendChild(p);
        resp.appendChild(pre);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting file read from cat command
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('natural-read.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must detect file read from "cat natural-read.txt"');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file content read from workspace
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('natural_markdown_read_content') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive file content from natural cat block');
  });

  it('15. Detects file write action from natural markdown "// filepath: <file>" code block with conversational explanation', async () => {
    const targetFile = path.join(tmpWorkspaceDir, 'natural-write.js');
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const p = document.createElement('p');
        p.textContent = 'I have updated natural-write.js to resolve the issue:';
        const pre = document.createElement('pre');
        pre.className = 'language-javascript';
        const code = document.createElement('code');
        code.textContent = '// filepath: natural-write.js\\nconsole.log("natural_write_success");';
        pre.appendChild(code);
        resp.appendChild(p);
        resp.appendChild(pre);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting write from // filepath:
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Write Workspace File') && card.innerText.includes('natural-write.js'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must detect write from "// filepath: natural-write.js"');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file written to disk without leading comment
    await pollUntil(async () => fs.existsSync(targetFile) ? true : null, 5000);
    assert.equal(fs.existsSync(targetFile), true);
    const content = fs.readFileSync(targetFile, 'utf8');
    assert.equal(content.trim(), 'console.log("natural_write_success");');
  });

  it('16. Detects tool call from inline code block `cat inline-sample.txt` when no fenced block is present', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'inline-sample.txt'), 'inline_code_detection_success');

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        resp.setAttribute('data-complete', 'true');
        const p = document.createElement('p');
        p.textContent = 'To check this file, you can run \`cat inline-sample.txt\` in your terminal.';
        resp.appendChild(p);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting file read from inline backtick command
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('inline-sample.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must detect file read from inline `cat inline-sample.txt`');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file content read from workspace
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('inline_code_detection_success') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive file content from inline command detection');
  });

  it('17. Never parses tool calls from user-query even if prompt contains send-me: or run-command:', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'actual-model-file.txt'), 'actual_assistant_response_content');

    // Step 1: User sends prompt containing action templates, model response NOT generated yet
    await evaluateInPage(`
      (() => {
        const turn = document.createElement('div');
        turn.className = 'conversation-container';

        const userQ = document.createElement('user-query');
        const userQContent = document.createElement('user-query-content');
        userQContent.textContent = 'Please check my code:\\n\\nsend-me: fake-user-file.txt\\n\\nrun-command:\\n\`\`\`bash\\necho "fake_user_command"\\n\`\`\`';
        userQ.appendChild(userQContent);
        turn.appendChild(userQ);

        document.body.appendChild(turn);
      })()
    `);

    // Wait 300ms to allow MutationObserver to fire and verify NO modal appears for user query
    await new Promise((r) => setTimeout(r, 300));
    const cardFoundOnUserQuery = await evaluateInPage(`Boolean(document.querySelector('.gtw-agent-approval-card'))`);
    assert.equal(cardFoundOnUserQuery, false, 'Modal must NEVER appear for actions inside user-query prompt');

    // Step 2: Model response appears with the assistant action
    await evaluateInPage(`
      (() => {
        const containers = document.querySelectorAll('.conversation-container');
        const latestTurn = containers[containers.length - 1];

        const modelResp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'I will inspect the workspace file:\\n\\nsend-me: actual-model-file.txt';
        modelResp.appendChild(inner);
        latestTurn.appendChild(modelResp);
      })()
    `);

    // Verify modal appears ONLY for the assistant action (actual-model-file.txt), NOT fake-user-file.txt
    const cardFoundOnModel = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('actual-model-file.txt'));
        })()
      `);
    }, 5000);
    assert.equal(cardFoundOnModel, true, 'Approval modal must appear only for the assistant model response');

    // Approve the assistant tool call
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify editor receives content of actual-model-file.txt
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('actual_assistant_response_content') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive file content from assistant model response');
  });

  it('18. Detects natural "send-me: <file>" file request and reads file upon approval', async () => {
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'adhd-send-sample.json'), '{"adhd": "send_me_success"}');

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'To check your settings:\\n\\nsend-me: adhd-send-sample.json';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting file read from "send-me:"
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('adhd-send-sample.json'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear for send-me: request');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file content read from workspace
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('send_me_success') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive file content from send-me: request');
  });

  it('19. Detects natural "save: <file>" followed by code block and writes file upon approval', async () => {
    const targetFile = path.join(tmpWorkspaceDir, 'adhd-save-sample.js');
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);

    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'save: adhd-save-sample.js\\n\`\`\`javascript\\nconsole.log("adhd_save_payload");\\n\`\`\`';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting write from "save:"
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Write Workspace File') && card.innerText.includes('adhd-save-sample.js'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear for save: action');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file written to disk
    await pollUntil(async () => fs.existsSync(targetFile) ? true : null, 5000);
    assert.equal(fs.existsSync(targetFile), true);
    const content = fs.readFileSync(targetFile, 'utf8');
    assert.equal(content.trim(), 'console.log("adhd_save_payload");');
  });

  it('20. Detects natural "run-command:" followed by code block and executes command upon approval', async () => {
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = 'run-command:\\n\`\`\`bash\\necho "adhd_run_success"\\n\`\`\`';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal appears detecting command from "run-command:"
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Execute Shell Command') && card.innerText.includes('adhd_run_success'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear for run-command: action');

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify command output submitted to editor
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('adhd_run_success') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive command output from run-command: action');
  });

  it('21. Never misidentifies "Bash" decoration header at top of code block as command', async () => {
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';

        const p = document.createElement('p');
        p.textContent = 'run-command:';

        const codeBlock = document.createElement('code-block');
        const header = document.createElement('div');
        header.className = 'code-block-decoration header-formatted';
        header.textContent = 'Bash';
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        header.appendChild(copyBtn);

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = 'echo "real_bash_command_success"';
        pre.appendChild(code);

        codeBlock.appendChild(header);
        codeBlock.appendChild(pre);

        inner.appendChild(p);
        inner.appendChild(codeBlock);
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify approval modal detects the actual command (echo "real_bash_command_success") and NOT "Bash"
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Execute Shell Command') && card.innerText.includes('real_bash_command_success'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must capture the command inside the code block');

    // Verify "Bash" is NOT mistaken as the command
    const cardText = await evaluateInPage(`document.querySelector('.gtw-agent-approval-card')?.innerText || ''`);
    assert.doesNotMatch(cardText, /Gemini requested to run this command in your workspace:\s*bash\s*✖/i);

    // Approve action
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify command output submitted to editor
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')?.textContent.trim()`);
      return text && text.includes('real_bash_command_success') ? text : null;
    }, 5000);
    assert.ok(editorResult, 'Editor must receive output from real command');
  });
});
