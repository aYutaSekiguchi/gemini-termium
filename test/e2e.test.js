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

    assert.match(toastMessage, /\/apply/);
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

  it('7. Detects agent tool call tag, prompts Human-in-the-Loop card, and executes upon user approval', async () => {
    // Inject a simulated agent response with %<write path="agent_test.txt">created by autonomous agent%</write>%
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = '%<write path="agent_test.txt">created by autonomous agent%</write>%';
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
      return text && text.includes('%<tool_result>%') ? text : null;
    }, 5000);
    assert.match(editorResult, /%<tool_result>%/);
    assert.match(editorResult, /Successfully applied 1 file change/);
  });

  it('8. Intercepts /agent command and auto-injects workspace file tree into prompt', async () => {
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

    // Verify prompt was populated with agent instructions, workspace file tree, and task
    const editorContent = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('【ワークスペース構造】') ? text : null;
    }, 5000);

    assert.ok(editorContent.includes('tree_sample.js'), 'Prompt must contain workspace file tree');
    assert.ok(editorContent.includes('%<read>%'), 'Prompt must contain %<read>% instruction');
    assert.ok(editorContent.includes('fix tree_sample.js bug'), 'Prompt must contain user task');
  });

  it('9. Auto-detects file read in %<tool_call>%%%README.md%%%</tool_call>% and reads file on approval without zsh error', async () => {
    // Write sample README.md file in workspace
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'README.md'), '# Autonomous Agent Documentation\nSafe TOS Compliant Execution');

    // Simulate Gemini emitting %<tool_call>%%%README.md%%%</tool_call>% (the exact bug pattern reported by user)
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = '%<tool_call>%%%README.md%%%</tool_call>%';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify Human-in-the-Loop card appears with title for Read Workspace File (auto-detected, NOT Shell Command)
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('README.md'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must auto-detect file read and sanitize delimiters');

    // User approves
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify prompt input contains the file contents formatted for reply
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('[File: README.md]') ? text : null;
    }, 5000);

    assert.ok(editorResult.includes('%<tool_result>%'));
    assert.ok(editorResult.includes('[File: README.md]'));
    assert.ok(editorResult.includes('Safe TOS Compliant Execution'));
    assert.ok(!editorResult.includes('zsh:fg:1'), 'Must not execute zsh job control fg error');
  });

  it('10. Detects bracket format [read]package.json[/read] and executes file read upon approval', async () => {
    // Write sample package.json file in workspace
    fs.writeFileSync(path.join(tmpWorkspaceDir, 'package.json'), '{"name": "termium-agent-test"}');

    // Simulate Gemini emitting bracket format [read]package.json[/read] (immune to Google SafeHtml stripping)
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = '[read]package.json[/read]';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify Human-in-the-Loop card appears
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Read Workspace File') && card.innerText.includes('package.json'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must appear for bracket [read] tag');

    // User approves
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify prompt input contains the file contents formatted for reply
    const editorResult = await pollUntil(async () => {
      const text = await evaluateInPage(`document.querySelector('[contenteditable="true"]')?.textContent.trim()`);
      return text && text.includes('[File: package.json]') ? text : null;
    }, 5000);

    assert.ok(editorResult.includes('%<tool_result>%'));
    assert.ok(editorResult.includes('termium-agent-test'));
  });

  it('11. Prioritizes outer enclosing write over nested tags in write body', async () => {
    // Simulate Gemini emitting write block containing nested [read] tag in body
    await evaluateInPage(`
      (() => {
        const resp = document.createElement('model-response');
        const inner = document.createElement('div');
        inner.className = 'model-response-text';
        inner.textContent = '%<write path="nested_guide.md">Usage: [read]src/server.js[/read]%</write>%';
        resp.appendChild(inner);
        document.body.appendChild(resp);
      })()
    `);

    // Verify modal appears for WRITE (nested [read] must NOT hijack outer write)
    const cardFound = await pollUntil(async () => {
      return evaluateInPage(`
        (() => {
          const card = document.querySelector('.gtw-agent-approval-card');
          return Boolean(card && card.innerText.includes('Write Workspace File') && card.innerText.includes('nested_guide.md'));
        })()
      `);
    }, 5000);
    assert.equal(cardFound, true, 'Approval modal must prioritize outer write operation');

    // User approves
    await evaluateInPage(`
      (() => {
        const btn = document.querySelector('.gtw-agent-btn-approve');
        if (btn) btn.click();
      })()
    `);

    // Verify file written to disk with inner tag preserved as body text
    const targetFile = path.join(tmpWorkspaceDir, 'nested_guide.md');
    const written = await pollUntil(async () => {
      return fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : null;
    }, 5000);
    assert.equal(written, 'Usage: [read]src/server.js[/read]');
  });

  it('12. Detects tool call from rendered DOM code block with language attribute', async () => {
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

    assert.ok(editorResult.includes('%<tool_result>%'));
    assert.ok(editorResult.includes('dom_bash_success'));
  });

  it('13. Guards untagged bare response fallback against premature evaluation during active streaming', async () => {
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
});
