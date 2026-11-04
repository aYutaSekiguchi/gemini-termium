import fs from 'node:fs';
import path from 'node:path';
import {
  applyFileChangesToDisk,
  executeShellCommand,
  readFileFromDisk,
  formatWorkspaceTree,
  scanWorkspaceFiles
} from './workspace.js';

/**
 * Minimal Chrome DevTools Protocol (CDP) client using native Node.js WebSockets.
 * Used to inject the in-page bridge script into the Gemini tab and relay bridge calls.
 */

export class ChromeDevToolsClient {
  constructor(port = 9222) {
    this.port = port;
    this.ws = null;
    this.msgId = 1;
    this.pendingRequests = new Map();
    this.eventListeners = new Map();
  }

  async getGeminiTarget() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!res.ok) {
      throw new Error(`Failed to query Chrome targets on port ${this.port}: ${res.statusText}`);
    }
    const targets = await res.json();
    const geminiPage = targets.find((t) => t.type === 'page' && t.url.includes('gemini.google.com')) ||
                       targets.find((t) => t.type === 'page');

    if (!geminiPage || !geminiPage.webSocketDebuggerUrl) {
      throw new Error('No inspectable Gemini tab found on Chrome debugging port.');
    }
    return geminiPage;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const target = await this.getGeminiTarget();
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl);

      this.ws.onopen = async () => {
        try {
          await this.send('Page.enable');
          await this.send('DOM.enable');
          await this.send('Runtime.enable');
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          } else if (msg.method) {
            const listeners = this.eventListeners.get(msg.method) || [];
            for (const fn of listeners) {
              try { fn(msg.params); } catch {}
            }
          }
        } catch {}
      };

      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('CDP WebSocket not connected'));
      }
      const id = this.msgId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, handler) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
  }

  off(event, handler) {
    const list = this.eventListeners.get(event);
    if (list) {
      this.eventListeners.set(event, list.filter((h) => h !== handler));
    }
  }

  waitForEvent(event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for event: ${event}`));
      }, timeoutMs);

      const handler = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

/**
 * Automatically injects the workspace bridge content script into active/navigating Gemini tabs via CDP.
 * Bypasses Chrome's extension loading restrictions in --app and official consumer builds,
 * and sets up a robust bi-directional CDP binding channel (__GTW_CDP_BRIDGE__).
 */
export function startAutoInjector({
  cwd = process.cwd(),
  cdpPort = 9222,
  bridgePort = 45140,
  scriptPath
}) {
  let isRunning = true;
  let activeWs = null;
  let lastInjectedTargetId = null;
  let msgSeq = 100;

  async function loop() {
    while (isRunning) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).catch(() => null);
        if (res && res.ok) {
          const targets = await res.json();
          const geminiPage = targets.find((t) => t.type === 'page' && t.url.includes('gemini.google.com')) ||
                             targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));

          if (geminiPage && geminiPage.webSocketDebuggerUrl) {
            if (geminiPage.id !== lastInjectedTargetId || !activeWs) {
              if (activeWs) {
                try { activeWs.close(); } catch {}
                activeWs = null;
              }

              lastInjectedTargetId = geminiPage.id;
              const rawScript = fs.readFileSync(scriptPath, 'utf8');
              const customizedScript =
                `window.__GEMINI_TERMIUM_PORT__ = ${bridgePort};\n` +
                rawScript;

              const ws = new WebSocket(geminiPage.webSocketDebuggerUrl);
              activeWs = ws;

              ws.onopen = () => {
                ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
                ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
                ws.send(JSON.stringify({ id: 3, method: 'Page.setBypassCSP', params: { enabled: true } }));
                ws.send(JSON.stringify({ id: 4, method: 'Runtime.addBinding', params: { name: '__GTW_CDP_BRIDGE__' } }));
                ws.send(JSON.stringify({
                  id: 5,
                  method: 'Page.addScriptToEvaluateOnNewDocument',
                  params: { source: customizedScript }
                }));
                ws.send(JSON.stringify({
                  id: 6,
                  method: 'Runtime.evaluate',
                  params: { expression: customizedScript }
                }));
                console.log('  🔌 CDP:       Injected in-page workspace bridge into Gemini WebUI');
              };

              ws.onmessage = async (event) => {
                try {
                  const data = JSON.parse(event.data);

                  // Re-apply binding and script only on main frame navigation or page load
                  const isMainFrameNav = data.method === 'Page.frameNavigated' && !data.params?.frame?.parentId;
                  if (data.method === 'Page.loadEventFired' || isMainFrameNav) {
                    ws.send(JSON.stringify({ id: msgSeq++, method: 'Page.setBypassCSP', params: { enabled: true } }));
                    ws.send(JSON.stringify({ id: msgSeq++, method: 'Runtime.addBinding', params: { name: '__GTW_CDP_BRIDGE__' } }));
                    ws.send(JSON.stringify({
                      id: msgSeq++,
                      method: 'Runtime.evaluate',
                      params: { expression: customizedScript }
                    }));
                  }

                  if (data.method === 'Runtime.bindingCalled' && data.params?.name === '__GTW_CDP_BRIDGE__') {
                    const parsed = JSON.parse(data.params.payload || '{}');
                    const { id, action, payload } = parsed;
                    let result = { ok: false, error: 'Unknown action' };

                    try {
                      if (action === 'get_workspace') {
                        const files = scanWorkspaceFiles(cwd, 300);
                        const fileTree = formatWorkspaceTree(cwd, 200);
                        result = {
                          ok: true,
                          cwd,
                          name: path.basename(cwd),
                          files,
                          fileTree,
                          totalFiles: files.length
                        };
                      } else if (action === 'help') {
                        console.log('  ⚡ Command:   /help');
                        result = { ok: true };
                      } else if (action === 'status') {
                        console.log(`  ⚡ Command:   /status (Workspace: ${path.basename(cwd)})`);
                        result = { ok: true, cwd, name: path.basename(cwd) };
                      } else if (action === 'run') {
                        const cmd = payload?.command || '';
                        console.log(`  ⚡ Command:   /run ${cmd}`);
                        result = await executeShellCommand(cmd, cwd);
                      } else if (action === 'apply') {
                        const fileActions = payload?.fileActions || [];
                        console.log(`  ⚡ Command:   /apply (${fileActions.length} files)`);
                        const applyRes = applyFileChangesToDisk(fileActions, cwd);
                        result = { ok: true, ...applyRes, totalApplied: applyRes.applied.length };
                      } else if (action === 'read') {
                        const filePath = (payload?.filePath || payload?.path || '').trim();
                        console.log(`  ⚡ Command:   read ${filePath}`);
                        const readRes = readFileFromDisk(filePath, cwd);
                        result = { ok: true, ...readRes };
                      }
                    } catch (err) {
                      result = { ok: false, error: err.message };
                    }

                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({
                        id: msgSeq++,
                        method: 'Runtime.evaluate',
                        params: {
                          expression: `window.__GTW_HANDLE_RESPONSE__ && window.__GTW_HANDLE_RESPONSE__(${JSON.stringify(id)}, ${JSON.stringify(result)})`
                        }
                      }));
                    }
                  }
                } catch {}
              };

              ws.onerror = () => {
                if (activeWs === ws) activeWs = null;
              };
              ws.onclose = () => {
                if (activeWs === ws) activeWs = null;
              };
            }
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  loop();

  return {
    stop: () => {
      isRunning = false;
      if (activeWs) {
        try { activeWs.close(); } catch {}
        activeWs = null;
      }
    }
  };
}
