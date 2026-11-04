/**
 * Gemini Termium Bridge - In-Page Content Script
 * Intercepts slash commands (/agent, /run, /status, /help) in the Gemini web UI,
 * detects agent tool requests in responses and asks the user to approve them.
 */

(function () {
  // Prevent double-initialization in the same context
  if (window.__GTW_INITIALIZED__) return;
  window.__GTW_INITIALIZED__ = true;

  const port = window.__GEMINI_TERMIUM_PORT__ || window.__GEMINI_TERMWAY_PORT__ || 45140;
  const BRIDGE_URL = `http://127.0.0.1:${port}`;

  let workspaceInfo = null;
  window.__GTW_PENDING__ = window.__GTW_PENDING__ || new Map();
  const pendingRequests = window.__GTW_PENDING__;
  let requestIdCounter = Date.now();

  console.log('[gemini-termium] In-page workspace bridge initializing...');

  // Response dispatcher for CDP binding responses
  window.__GTW_HANDLE_RESPONSE__ = function (id, data) {
    if (pendingRequests.has(id)) {
      const { resolve } = pendingRequests.get(id);
      pendingRequests.delete(id);
      resolve(data);
    }
  };

  /**
   * Dual-transport bridge client:
   * Uses Chrome DevTools Protocol binding (__GTW_CDP_BRIDGE__) when available
   * (immune to CSP, Mixed Content, and CORS), falling back to local HTTP fetch.
   */
  async function callBridge(action, payload = {}) {
    // Transport 1: Direct CDP Binding
    if (typeof window.__GTW_CDP_BRIDGE__ === 'function') {
      const id = 'req_' + (requestIdCounter++);
      const cdpResult = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            resolve(null); // Fall through to HTTP fetch on timeout
          }
        }, 2000);

        pendingRequests.set(id, {
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          }
        });

        try {
          window.__GTW_CDP_BRIDGE__(JSON.stringify({ id, action, payload }));
        } catch (err) {
          clearTimeout(timer);
          pendingRequests.delete(id);
          resolve(null);
        }
      });

      if (cdpResult && cdpResult.ok !== undefined) {
        return cdpResult;
      }
    }

    // Transport 2: HTTP Fetch fallback
    try {
      const endpoints = {
        get_workspace: { path: '/v1/workspace', method: 'GET' },
        run: { path: '/v1/actions/run', method: 'POST', body: payload },
        read: { path: '/v1/actions/read', method: 'POST', body: payload },
        apply: { path: '/v1/actions/apply', method: 'POST', body: payload }
      };

      const ep = endpoints[action];
      if (!ep) return { ok: false, error: `Unknown action: ${action}` };

      const opts = { method: ep.method };
      if (ep.body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(ep.body);
      }

      const res = await fetch(`${BRIDGE_URL}${ep.path}`, opts);
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function startBridge() {
    if (window.__GTW_DOM_READY__) return;
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startBridge, { once: true });
      } else {
        setTimeout(startBridge, 50);
      }
      return;
    }
    window.__GTW_DOM_READY__ = true;

    initDOMAndEvents();
  }

  const SLASH_COMMANDS = [
    { command: '/agent', label: '🤖 /agent [prompt]', desc: 'Start autonomous agent with workspace file tree & tools' },
    { command: '/run', label: '⚡ /run [cmd]', desc: 'Execute shell command on local workspace' },
    { command: '/status', label: 'ℹ️ /status', desc: 'Show workspace connection details' },
    { command: '/help', label: '❓ /help', desc: 'Show slash command list and usage' }
  ];

  function initDOMAndEvents() {
    // 1. Inject Styles without innerHTML
    if (!document.getElementById('gtw-injected-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'gtw-injected-styles';
      styleEl.textContent = `
        .gtw-hud-badge {
          position: fixed;
          bottom: 12px;
          right: 16px;
          background: rgba(20, 24, 32, 0.9);
          backdrop-filter: blur(8px);
          color: #e0e6ed;
          border: 1px solid rgba(100, 150, 255, 0.4);
          border-radius: 8px;
          padding: 6px 14px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          z-index: 999999;
          display: flex;
          align-items: center;
          gap: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
          user-select: none;
        }
        .gtw-hud-badge.connected { border-color: #22c55e; }
        .gtw-hud-badge .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: #eab308;
          box-shadow: 0 0 6px currentColor;
          display: inline-block;
        }
        .gtw-hud-badge.connected .dot {
          background-color: #22c55e;
          box-shadow: 0 0 6px #22c55e;
        }
        .gtw-hud-toast {
          position: fixed;
          top: 24px;
          right: 24px;
          background: #181d28;
          color: #ffffff;
          border: 1px solid #3b82f6;
          border-radius: 8px;
          padding: 12px 18px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          z-index: 1000000;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
          opacity: 0;
          transform: translateY(-8px);
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          pointer-events: none;
          max-width: 520px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .gtw-hud-toast.visible {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
        }
        .gtw-hud-toast.success { border-color: #22c55e; }
        .gtw-hud-toast.error { border-color: #ef4444; }
        .gtw-hud-toast.info { border-color: #3b82f6; }

        /* Slash Command Autocomplete Menu */
        .gtw-slash-menu {
          position: fixed;
          background: #151922;
          border: 1px solid #3b82f6;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.7);
          z-index: 1000002;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          min-width: 380px;
        }
        .gtw-slash-header {
          padding: 6px 12px;
          background: #0f131a;
          border-bottom: 1px solid #232a3b;
          font-size: 11px;
          color: #94a3b8;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .gtw-slash-list {
          list-style: none;
          margin: 0;
          padding: 4px 0;
          max-height: 220px;
          overflow-y: auto;
        }
        .gtw-slash-item {
          padding: 8px 12px;
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          color: #cbd5e1;
          transition: background 0.1s ease;
        }
        .gtw-slash-item:hover, .gtw-slash-item.selected {
          background: #2563eb;
          color: #ffffff;
        }
        .gtw-slash-cmd {
          font-weight: 700;
          color: #60a5fa;
        }
        .gtw-slash-item:hover .gtw-slash-cmd, .gtw-slash-item.selected .gtw-slash-cmd {
          color: #ffffff;
        }
        .gtw-slash-desc {
          font-size: 11px;
          color: #94a3b8;
          margin-left: auto;
        }
        .gtw-slash-item:hover .gtw-slash-desc, .gtw-slash-item.selected .gtw-slash-desc {
          color: #e2e8f0;
        }

        .gtw-console-drawer {
          position: fixed;
          bottom: 50px;
          right: 24px;
          width: 560px;
          max-height: 400px;
          background: #11151c;
          border: 1px solid #374151;
          border-radius: 8px;
          z-index: 999998;
          display: flex;
          flex-direction: column;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7);
          overflow: hidden;
          font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .gtw-console-header {
          background: #1a202c;
          padding: 8px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #2d3748;
          font-size: 12px;
          font-weight: 600;
          color: #cbd5e1;
        }
        .gtw-console-body {
          padding: 10px 12px;
          font-size: 11px;
          color: #e2e8f0;
          overflow-y: auto;
          white-space: pre-wrap;
          max-height: 340px;
          line-height: 1.45;
        }
        .gtw-code-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: #1e293b;
          color: #94a3b8;
          border: 1px solid #334155;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          margin-left: 6px;
          transition: all 0.15s ease;
        }
        .gtw-code-btn:hover { background: #334155; color: #f8fafc; border-color: #64748b; }
        .gtw-code-btn.apply:hover { border-color: #22c55e; color: #86efac; }
        .gtw-code-btn.run:hover { border-color: #38bdf8; color: #7dd3fc; }

        /* Agent Human-in-the-Loop Approval Card */
        .gtw-agent-approval-card {
          position: fixed;
          bottom: 80px;
          left: 50%;
          transform: translateX(-50%);
          width: 90%;
          max-width: 640px;
          background: #0f172a;
          border: 2px solid #38bdf8;
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7);
          z-index: 1000000;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: #f8fafc;
          overflow: hidden;
          animation: gtwSlideUp 0.15s ease-out;
        }
        @keyframes gtwSlideUp {
          from { transform: translate(-50%, 20px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
        .gtw-agent-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
          background: #1e293b;
          border-bottom: 1px solid #334155;
        }
        .gtw-agent-title {
          font-weight: 700;
          font-size: 13px;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #38bdf8;
        }
        .gtw-agent-policy {
          font-size: 11px;
          color: #94a3b8;
          background: rgba(255, 255, 255, 0.05);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .gtw-agent-body {
          padding: 12px 16px;
          max-height: 240px;
          overflow-y: auto;
          font-size: 12px;
        }
        .gtw-agent-body code {
          background: #1e293b;
          padding: 4px 8px;
          border-radius: 4px;
          display: block;
          white-space: pre-wrap;
          word-break: break-all;
          color: #a5f3fc;
        }
        .gtw-agent-preview {
          margin-top: 6px;
          background: #090d16;
          padding: 8px;
          border-radius: 6px;
          font-size: 11px;
          color: #cbd5e1;
          max-height: 120px;
          overflow-y: auto;
          white-space: pre-wrap;
        }
        .gtw-agent-actions {
          display: flex;
          gap: 10px;
          padding: 10px 16px;
          background: #1e293b;
          border-top: 1px solid #334155;
          justify-content: flex-end;
        }
        .gtw-agent-btn-approve {
          background: #16a34a;
          color: #ffffff;
          border: none;
          padding: 6px 14px;
          border-radius: 6px;
          font-weight: 600;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .gtw-agent-btn-approve:hover {
          background: #22c55e;
        }
        .gtw-agent-btn-reject {
          background: #475569;
          color: #f1f5f9;
          border: none;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
        }
        .gtw-agent-btn-reject:hover {
          background: #64748b;
        }
      `;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    // 2. Initialize HUD elements (Built cleanly with DOM methods to satisfy Trusted Types)
    const hudBadge = document.createElement('div');
    hudBadge.className = 'gtw-hud-badge';

    const dot = document.createElement('span');
    dot.className = 'dot';
    hudBadge.appendChild(dot);

    const badgeLabel = document.createElement('span');
    badgeLabel.className = 'gtw-badge-label';
    badgeLabel.textContent = 'Connecting to workspace...';
    hudBadge.appendChild(badgeLabel);

    document.body.appendChild(hudBadge);

    const toastElem = document.createElement('div');
    toastElem.className = 'gtw-hud-toast';
    document.body.appendChild(toastElem);

    let toastTimer = null;
    function showToast(message, type = 'info', durationMs = 4500) {
      if (toastTimer) clearTimeout(toastTimer);
      toastElem.className = `gtw-hud-toast visible ${type}`;
      toastElem.textContent = message;
      toastTimer = setTimeout(() => {
        toastElem.className = 'gtw-hud-toast';
      }, durationMs);
    }

    // 3. Initialize Slash Command Menu
    const slashMenu = document.createElement('div');
    slashMenu.className = 'gtw-slash-menu';
    slashMenu.style.display = 'none';

    const slashHeader = document.createElement('div');
    slashHeader.className = 'gtw-slash-header';
    const headerTitle = document.createElement('span');
    headerTitle.textContent = '⚡ Workspace Slash Commands';
    const headerTip = document.createElement('span');
    headerTip.textContent = '↑↓ navigate • Enter select';
    slashHeader.appendChild(headerTitle);
    slashHeader.appendChild(headerTip);
    slashMenu.appendChild(slashHeader);

    const slashList = document.createElement('ul');
    slashList.className = 'gtw-slash-list';
    slashMenu.appendChild(slashList);

    document.body.appendChild(slashMenu);

    let selectedMenuIndex = 0;
    let activeFilteredCommands = [];

    function updateMenuPosition() {
      const editor = findPromptEditor();
      if (!editor) return;
      const rect = editor.getBoundingClientRect();
      slashMenu.style.left = `${Math.max(16, rect.left)}px`;
      slashMenu.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 8)}px`;
      slashMenu.style.width = `${Math.min(480, Math.max(380, rect.width || 420))}px`;
    }

    function renderSlashMenuItems() {
      while (slashList.firstChild) {
        slashList.removeChild(slashList.firstChild);
      }

      activeFilteredCommands.forEach((cmd, idx) => {
        const item = document.createElement('li');
        item.className = 'gtw-slash-item' + (idx === selectedMenuIndex ? ' selected' : '');

        const cmdSpan = document.createElement('span');
        cmdSpan.className = 'gtw-slash-cmd';
        cmdSpan.textContent = cmd.label;

        const descSpan = document.createElement('span');
        descSpan.className = 'gtw-slash-desc';
        descSpan.textContent = cmd.desc;

        item.appendChild(cmdSpan);
        item.appendChild(descSpan);

        item.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectSlashCommand(cmd);
        };

        slashList.appendChild(item);
      });
    }

    function selectSlashCommand(cmd) {
      const editor = findPromptEditor();
      if (!editor) return;

      slashMenu.style.display = 'none';

      if (cmd.command === '/run') {
        setPromptText(editor, '/run ');
        return;
      }
      if (cmd.command === '/agent') {
        setPromptText(editor, '/agent ');
        return;
      }

      clearPromptText(editor);

      if (cmd.command === '/status') {
        callBridge('status').then((res) => {
          const name = res?.name || workspaceInfo?.name || 'unknown';
          const loc = res?.cwd || workspaceInfo?.cwd || '';
          showToast(`Connected to workspace: ${name} (${loc})`, 'success', 5000);
        });
      } else if (cmd.command === '/help') {
        callBridge('help');
        showToast('Commands: /agent [prompt] (autonomous agent) | /run [cmd] (execute shell) | /status', 'info', 7000);
      }
    }

    function updateSlashMenu() {
      const editor = findPromptEditor();
      if (!editor) {
        slashMenu.style.display = 'none';
        return;
      }

      const text = getPromptText(editor);
      if (!text.startsWith('/')) {
        slashMenu.style.display = 'none';
        return;
      }

      const parts = text.split(/\s+/);
      const query = parts[0].toLowerCase().slice(1);

      activeFilteredCommands = SLASH_COMMANDS.filter((cmd) =>
        cmd.command.slice(1).startsWith(query)
      );

      if (activeFilteredCommands.length === 0) {
        slashMenu.style.display = 'none';
        return;
      }

      if (selectedMenuIndex >= activeFilteredCommands.length) {
        selectedMenuIndex = 0;
      }

      updateMenuPosition();
      renderSlashMenuItems();
      slashMenu.style.display = 'flex';
    }

    // 4. Console output drawer
    const consoleDrawer = document.createElement('div');
    consoleDrawer.className = 'gtw-console-drawer';
    consoleDrawer.style.display = 'none';

    const consoleHeader = document.createElement('div');
    consoleHeader.className = 'gtw-console-header';

    const consoleTitle = document.createElement('span');
    consoleTitle.className = 'gtw-console-title';
    consoleTitle.textContent = '⚡ Command Output';
    consoleHeader.appendChild(consoleTitle);

    const consoleClose = document.createElement('button');
    consoleClose.className = 'gtw-console-close';
    consoleClose.textContent = '✕';
    consoleClose.style.cssText = 'background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;';
    consoleClose.onclick = () => {
      consoleDrawer.style.display = 'none';
    };
    consoleHeader.appendChild(consoleClose);
    consoleDrawer.appendChild(consoleHeader);

    const consoleBody = document.createElement('div');
    consoleBody.className = 'gtw-console-body';
    consoleDrawer.appendChild(consoleBody);

    document.body.appendChild(consoleDrawer);

    function showConsoleOutput(command, result) {
      consoleDrawer.style.display = 'flex';
      consoleTitle.textContent = `⚡ $ ${command}`;
      const out = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
      consoleBody.textContent = out || `(Command exited with code ${result.code})`;
      consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    // 5. Connect to local workspace bridge
    async function checkConnection() {
      try {
        const data = await callBridge('get_workspace');
        if (data && data.ok) {
          workspaceInfo = data;
          hudBadge.className = 'gtw-hud-badge connected';
          badgeLabel.textContent = `Workspace: ${data.name}`;
          return true;
        }
      } catch {}

      hudBadge.className = 'gtw-hud-badge';
      badgeLabel.textContent = 'Bridge Offline';
      return false;
    }

    setInterval(checkConnection, 4000);
    checkConnection();

    // 6. Robust DOM input detection
    function isUsableEditor(el) {
      if (!el) return false;
      if (el.classList && el.classList.contains('ql-clipboard')) return false;
      if (el.getAttribute && el.getAttribute('tabindex') === '-1' && !el.classList.contains('ql-editor')) return false;
      return true;
    }

    function findPromptEditor(e = null) {
      if (e && e.target) {
        const target = e.target;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
          return target;
        }
        if (target.isContentEditable && isUsableEditor(target)) {
          const editorParent = target.closest('.ql-editor:not(.ql-clipboard)') || target.closest('[contenteditable="true"]:not(.ql-clipboard)');
          return editorParent || target;
        }
      }

      const active = document.activeElement;
      if (active && isUsableEditor(active)) {
        if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
          return active;
        }
        if (active.isContentEditable) {
          const editorParent = active.closest('.ql-editor:not(.ql-clipboard)') || active.closest('[contenteditable="true"]:not(.ql-clipboard)');
          return editorParent || active;
        }
      }

      // Priority 1: Gemini Angular custom elements (rich-textarea)
      const richEditor = document.querySelector('rich-textarea .ql-editor:not(.ql-clipboard)')
        || document.querySelector('rich-textarea div[contenteditable="true"]:not(.ql-clipboard)');
      if (richEditor) {
        return richEditor;
      }

      // Priority 2: Standard Quill editor or textarea
      const qlEditor = document.querySelector('.ql-editor:not(.ql-clipboard)');
      if (qlEditor) {
        return qlEditor;
      }

      // Priority 3: Fallback contenteditable or textarea
      const candidates = Array.from(document.querySelectorAll(
        '[contenteditable="true"]:not(.ql-clipboard), textarea, input[type="text"]'
      )).filter(isUsableEditor);

      if (candidates.length > 0) {
        return candidates[0];
      }
      return null;
    }

    function getPromptText(editor) {
      if (!editor) return '';
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        return (editor.value || '').trim();
      }
      return (editor.innerText || editor.textContent || '').trim();
    }

    function setPromptText(editor, text) {
      if (!editor) return;
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      while (editor.firstChild) {
        editor.removeChild(editor.firstChild);
      }

      const lines = String(text || '').split('\n');
      for (const line of lines) {
        const p = document.createElement('p');
        if (line) {
          p.textContent = line;
        } else {
          p.appendChild(document.createElement('br'));
        }
        editor.appendChild(p);
      }

      if (editor.classList) {
        editor.classList.remove('ql-blank');
      }

      try {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}

      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearPromptText(editor) {
      if (!editor) return;
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        editor.value = '';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      try {
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      } catch {}

      // Reset DOM cleanly without innerHTML
      while (editor.firstChild) {
        editor.removeChild(editor.firstChild);
      }
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      editor.appendChild(p);

      if (editor.classList) {
        editor.classList.add('ql-blank');
      }

      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function submitCurrentPrompt(retries = 5, interval = 200) {
      const trySubmit = (remaining) => {
        const sendButtonSelectors = [
          'button[aria-label="プロンプトを送信"]',
          'button[aria-label="Send prompt"]',
          'button[aria-label="Send message"]',
          'button[aria-label*="送信"]',
          'button[aria-label*="Send" i]',
          '[data-test-id="send-button-container"] button',
          '.send-button-container button',
          '.send-button button',
          'button.send-button'
        ];

        for (const sel of sendButtonSelectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
            btn.click();
            return true;
          }
        }

        if (remaining > 0) {
          setTimeout(() => trySubmit(remaining - 1), interval);
          return;
        }

        // Fallback: Dispatch Enter key on active prompt editor
        const editor = findPromptEditor();
        if (editor) {
          editor.focus();
          const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          const enterUp = new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          editor.dispatchEvent(enterDown);
          editor.dispatchEvent(enterUp);
          return true;
        }
        return false;
      };

      trySubmit(retries);
    }

    // 7. Code block & action extraction
    function extractLatestActions() {
      const responses = Array.from(document.querySelectorAll('model-response, .conversation-container'));
      if (responses.length === 0) return { fileActions: [], commandActions: [] };

      const latest = responses[responses.length - 1];
      const rawText = latest.innerText || latest.textContent || '';
      const fileActions = [];
      const commandActions = [];

      // 1. Direct tag parsing for %<write path="...">% or <write path="...">
      const writeMatches = Array.from(rawText.matchAll(/(?:%<|<)write\s+path=["']?([^"'>]+)["']?(?:>|%>)([\s\S]*?)(?:%<\/|<\/)write(?:>|%>)/gi));
      for (const wm of writeMatches) {
        fileActions.push({
          filePath: wm[1].trim(),
          content: wm[2]
        });
      }

      // 2. Direct tag parsing for %<tool_call>% or <tool_call>
      const cmdMatches = Array.from(rawText.matchAll(/(?:%<|<)tool_call(?:>|%>)([\s\S]*?)(?:%<\/|<\/)tool_call(?:>|%>)/gi));
      for (const cm of cmdMatches) {
        commandActions.push({
          language: 'bash',
          content: cm[1].trim()
        });
      }

      const codeBlocks = Array.from(latest.querySelectorAll('pre, code-block, [class*="code-block"]'));

      for (const block of codeBlocks) {
        const codeElem = block.querySelector('code') || block;
        const content = (codeElem.innerText || codeElem.textContent || '').trim();
        if (!content) continue;

        const classes = `${codeElem.className || ''} ${block.className || ''}`.toLowerCase();
        const langMatch = classes.match(/(?:language|lang)-([a-z0-9_+-]+)/i) ||
                          block.getAttribute('data-language');
        const lang = langMatch ? (typeof langMatch === 'string' ? langMatch : langMatch[1]).toLowerCase() : '';

        const isCmd = ['bash', 'sh', 'shell', 'zsh', 'terminal'].includes(lang) ||
                      content.startsWith('$ ') || content.startsWith('npm ') ||
                      content.startsWith('git ') || content.startsWith('cargo ') ||
                      content.startsWith('docker ');

        let filePath = null;
        const explicit = content.match(/(?:\/\/|#|\/\*|<!--)\s*(?:filepath|filename|file):\s*([^\s*]+)/i) ||
                         content.match(/^(?:File:\s*)([^\s\n]+)/im);
        if (explicit) {
          filePath = explicit[1].trim();
        } else {
          const firstLines = content.split('\n').slice(0, 3).join('\n');
          const commentPath = firstLines.match(/(?:\/\/|#|\/\*|<!--)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/);
          if (commentPath && !commentPath[1].startsWith('http')) {
            filePath = commentPath[1].trim();
          }
        }

        if (!filePath && block.previousElementSibling) {
          const prevText = block.previousElementSibling.textContent || '';
          const prevMatch = prevText.match(/`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`/) ||
                            prevText.match(/(?:file|path|ファイル):\s*`?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`?/i);
          if (prevMatch) {
            filePath = prevMatch[1].trim();
          }
        }

        if (isCmd) {
          commandActions.push({
            language: lang || 'bash',
            content: content.replace(/^\$\s+/gm, '').trim()
          });
        } else if (filePath) {
          fileActions.push({
            language: lang,
            filePath,
            content
          });
        }
      }

      return { fileActions, commandActions };
    }

    // 8. Action handlers
    async function handleRunCommand(cmdString = null) {
      let commandToRun = cmdString;
      if (!commandToRun) {
        const { commandActions } = extractLatestActions();
        if (commandActions.length > 0) {
          commandToRun = commandActions[0].content;
        }
      }

      if (!commandToRun) {
        showToast('⚠ No shell command found to execute.', 'error');
        return;
      }

      showToast(`Executing: ${commandToRun.slice(0, 40)}...`, 'info');
      const data = await callBridge('run', { command: commandToRun });
      showConsoleOutput(commandToRun, data);
      showToast(data.ok ? `✔ Command finished (code 0)` : `✖ Command failed (code ${data.code})`, data.ok ? 'success' : 'error');
    }

    // 9. Intercept Slash Commands
    function handleSendIntercept(e) {
      const editor = findPromptEditor(e);
      if (!editor) return false;

      const text = getPromptText(editor);
      if (!text.startsWith('/')) return false;

      const parts = text.split(/\s+/);
      const command = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      if (['/run', '/status', '/help', '/agent'].includes(command)) {
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }

        clearPromptText(editor);
        slashMenu.style.display = 'none';

        if (command === '/agent') {
          handleAgentCommand(arg, editor);
        } else if (command === '/run') {
          handleRunCommand(arg || null);
        } else if (command === '/status') {
          callBridge('status').then((res) => {
            const name = res?.name || workspaceInfo?.name || 'unknown';
            const loc = res?.cwd || workspaceInfo?.cwd || '';
            showToast(`Connected to workspace: ${name} (${loc})`, 'success', 5000);
          });
        } else if (command === '/help') {
          callBridge('help');
          showToast('Commands: /agent [prompt] (autonomous agent) | /run [cmd] (execute shell) | /status', 'info', 7000);
        }
        return true;
      }
      return false;
    }

    async function handleAgentCommand(arg, editor) {
      showToast('🔍 Scanning workspace file tree...', 'info', 2000);
      const wsData = await callBridge('get_workspace');
      const wsName = wsData?.name || workspaceInfo?.name || 'workspace';
      const wsTree = wsData?.fileTree || '(empty workspace)';

      const promptInstruction = `You are an autonomous coding agent operating in the user's local workspace.
Current workspace structure:

[WORKSPACE STRUCTURE]
Working Directory: ${wsName}
Files:
${wsTree}

[OPERATION RULES]
To interact with the local workspace (reading files, writing code, executing commands), you MUST use the following bracket tags ([tag]...[/tag]). Do NOT use HTML angle tags (<read>, etc.) because browser HTML sanitizers strip them out.

1. Read File:
   When you need to inspect or read a file, output ONLY:
   [read]file_path[/read]
   (e.g., [read]README.md[/read] or [read]src/server.js[/read])

2. Write / Edit File:
   When creating new files or modifying existing files, output:
   [write path="file_path"]file_content[/write]

3. Execute Shell Command:
   When you need to run tests, build tools, inspect git status, or check environment, output:
   [exec]shell_command[/exec]
   (e.g., [exec]npm test[/exec] or [exec]git status[/exec])

[CRITICAL RULES]
- Always use square brackets ([read], [write], [exec]) instead of HTML tags to prevent DOM sanitization issues.
- To read file contents, ALWAYS use [read]file_path[/read] rather than shell commands (cat/less).
- After emitting a tool call tag, completely STOP generating further thoughts or text, and WAIT until the user provides the execution result.
- Emit at most one tool call per turn.`;

      if (arg) {
        const fullPrompt = `${promptInstruction}\n\n[USER INSTRUCTION]\n${arg}`;
        setPromptText(editor, fullPrompt);
        showToast('🤖 Agent prompt prepared with file tree. Starting...', 'info', 3000);
        setTimeout(() => submitCurrentPrompt(), 300);
      } else {
        const template = `${promptInstruction}\n\n[USER INSTRUCTION]\n`;
        setPromptText(editor, template);
        showToast('🤖 Agent template with file tree inserted. Add your prompt and press Enter.', 'info', 6000);
      }
    }

    // Export interceptor for programmatic/testing use
    window.__GTW_HANDLE_INTERCEPT__ = handleSendIntercept;
    window.__GTW_SUBMIT_CURRENT_PROMPT__ = submitCurrentPrompt;
    window.__GTW_FIND_PROMPT_EDITOR__ = findPromptEditor;
    window.__GTW_SET_PROMPT_TEXT__ = setPromptText;

    // Listen for input changes to show slash command autocomplete menu
    document.addEventListener('input', () => {
      updateSlashMenu();
    }, true);

    document.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      updateSlashMenu();
    }, true);

    // Listen for keyboard navigation in slash menu and Enter submission
    document.addEventListener('keydown', (e) => {
      // Menu Navigation
      if (slashMenu.style.display !== 'none' && activeFilteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          selectedMenuIndex = (selectedMenuIndex + 1) % activeFilteredCommands.length;
          renderSlashMenuItems();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          selectedMenuIndex = (selectedMenuIndex - 1 + activeFilteredCommands.length) % activeFilteredCommands.length;
          renderSlashMenuItems();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          slashMenu.style.display = 'none';
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          const targetCmd = activeFilteredCommands[selectedMenuIndex];
          if (targetCmd) {
            selectSlashCommand(targetCmd);
          }
          return;
        }
      }

      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return; // Ignore IME confirmation Enter

      // If slash menu is visible and user presses Enter on a bare command or partial query
      if (slashMenu.style.display !== 'none' && activeFilteredCommands.length > 0) {
        const editor = findPromptEditor(e);
        const text = getPromptText(editor);
        if (text === '/' || !text.includes(' ')) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const targetCmd = activeFilteredCommands[selectedMenuIndex];
          if (targetCmd) {
            selectSlashCommand(targetCmd);
          }
          return;
        }
      }

      handleSendIntercept(e);
    }, true);

    // Listen for Send button clicks
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target) return;
      const sendBtn = target.closest('button[aria-label*="Send"], button[aria-label*="送信"], [data-test-id="send-button"], button.send-button');
      if (sendBtn) {
        handleSendIntercept(e);
      }
    }, true);

    // Close menu when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (slashMenu.style.display !== 'none' && !slashMenu.contains(e.target)) {
        slashMenu.style.display = 'none';
      }
    }, true);

    // 10. In-DOM Code Block Action Buttons
    function decorateCodeBlocks() {
      const codeContainers = document.querySelectorAll(
        'model-response pre:not([data-gtw-decorated]), model-response code-block:not([data-gtw-decorated]), .conversation-container pre:not([data-gtw-decorated]), .conversation-container code-block:not([data-gtw-decorated])'
      );

      codeContainers.forEach((block) => {
        block.setAttribute('data-gtw-decorated', 'true');

        const codeElem = block.querySelector('code') || block;
        const content = (codeElem.innerText || codeElem.textContent || '').trim();
        if (!content) return;

        const classes = `${codeElem.className || ''} ${block.className || ''}`.toLowerCase();
        const langMatch = classes.match(/(?:language|lang)-([a-z0-9_+-]+)/i) ||
                          block.getAttribute('data-language');
        const lang = langMatch ? (typeof langMatch === 'string' ? langMatch : langMatch[1]).toLowerCase() : '';

        const isCmd = ['bash', 'sh', 'shell', 'zsh', 'terminal'].includes(lang) ||
                      content.startsWith('$ ') || content.startsWith('npm ') ||
                      content.startsWith('git ') || content.startsWith('cargo ') ||
                      content.startsWith('docker ');

        let filePath = null;
        const tagMatch = content.match(/(?:%<|<)write\s+path=["']?([^"'>]+)["']?>/i);
        if (tagMatch) {
          filePath = tagMatch[1].trim();
        } else {
          const explicit = content.match(/(?:\/\/|#|\/\*|<!--)\s*(?:filepath|filename|file):\s*([^\s*]+)/i) ||
                           content.match(/^(?:File:\s*)([^\s\n]+)/im);
          if (explicit) {
            filePath = explicit[1].trim();
          } else {
            const firstLines = content.split('\n').slice(0, 3).join('\n');
            const commentPath = firstLines.match(/(?:\/\/|#|\/\*|<!--)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/);
            if (commentPath && !commentPath[1].startsWith('http')) {
              filePath = commentPath[1].trim();
            }
          }
        }

        if (!filePath && block.previousElementSibling) {
          const prevText = block.previousElementSibling.textContent || '';
          const prevMatch = prevText.match(/`([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`/) ||
                            prevText.match(/(?:file|path|ファイル):\s*`?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)`?/i);
          if (prevMatch) {
            filePath = prevMatch[1].trim();
          }
        }

        let header = block.querySelector('.code-block-decoration-header') ||
                     block.querySelector('.code-block-header') ||
                     block.parentElement?.querySelector('.header');
        if (!header) {
          header = document.createElement('div');
          header.className = 'gtw-code-header';
          header.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:4px;';
          block.parentNode.insertBefore(header, block);
        }

        if (isCmd) {
          const runBtn = document.createElement('button');
          runBtn.className = 'gtw-code-btn run';
          runBtn.textContent = '⚡ Run Locally';
          runBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleRunCommand(content.replace(/^\$\s+/gm, '').trim());
          };
          header.appendChild(runBtn);
        }
      });
    }

    // 11. Autonomous Agent Engine with Human-in-the-Loop Confirmation
    let activeAgentModal = null;
    let activeModalResponse = null;
    const processedToolCallIds = new Set();

    function sanitizeTagValue(val) {
      if (!val) return '';
      return val
        .trim()
        .replace(/^[%`'"\s]+|[%`'"\s]+$/g, '')
        .trim();
    }

    function looksLikeFilePath(str) {
      if (!str || typeof str !== 'string') return false;
      const s = str.trim();
      // Cannot contain spaces or shell control characters
      if (/[\s\n\r|;&><$`()]/.test(s)) return false;
      // Common source / config / doc file extensions
      const extRegex = /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|html|css|scss|sass|less|yaml|yml|toml|xml|csv|log|sh|env|sql|rs|go|c|cpp|h|hpp|rb|php|java|kt|swift|scala|vue|svelte)$/i;
      if (extRegex.test(s)) return true;
      // Relative path starting with ./ or ../ or containing path separators without being a known command
      if ((s.startsWith('./') || s.startsWith('../') || s.includes('/')) && !/^(ls|cd|rm|cp|mv|cat|chmod|chown)$/i.test(s)) {
        return true;
      }
      return false;
    }

    function isResponseComplete(responseEl) {
      if (!responseEl) return true;

      // 1. Explicit data-complete attribute (used in testing or explicit state markers)
      if (responseEl.getAttribute('data-complete') === 'false') return false;
      if (responseEl.getAttribute('data-complete') === 'true') return true;

      // 2. aria-busy attribute: while streaming, Gemini sets aria-busy="true" on markdown/message-content
      if (responseEl.getAttribute('aria-busy') === 'true') return false;
      const busyChild = responseEl.querySelector('[aria-busy="true"]');
      if (busyChild) return false;

      // 3. Stop generation button: while streaming, the stop button is visible and active
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop"], button[aria-label*="停止"], [data-test-id="stop-button"], button.stop-button'
      );
      if (stopBtn && stopBtn.offsetParent !== null && !stopBtn.disabled) {
        return false;
      }

      return true;
    }

    function parseToolCallsFromText(rawText, options = {}) {
      if (!rawText) return null;
      const isComplete = options.isComplete !== false;

      const candidates = [];

      function addCandidate(type, title, payload, match, rawTag) {
        candidates.push({
          type,
          title,
          ...payload,
          rawTag: rawTag || match[0],
          startIndex: match.index,
          endIndex: match.index + (rawTag || match[0]).length
        });
      }

      // 1. Bracket Write: [write path="..."]content[/write]
      const bracketWriteRegex = /\[write\s+path=["']?([^"'\]]+)["']?\]([\s\S]*?)\[\/write\]/gi;
      let m;
      while ((m = bracketWriteRegex.exec(rawText)) !== null) {
        const filePath = sanitizeTagValue(m[1]);
        const content = (m[2] || '').trim();
        if (filePath) {
          addCandidate('write', 'Write Workspace File', { filePath, content }, m);
        }
      }

      // 2. XML / Percent Write: %<write path="...">content%</write>% or <write path="...">content</write>
      const xmlWriteRegex = /(?:%<|<)write\s+path=["']?([^"'>]+)["']?\s*(?:>%|>|%)\s*([\s\S]*?)\s*(?:%<\/|<\/|%)write\s*(?:>%|>|%)/gi;
      while ((m = xmlWriteRegex.exec(rawText)) !== null) {
        const filePath = sanitizeTagValue(m[1]);
        let content = m[2] || '';
        content = content.replace(/^%*\r?\n?/, '').replace(/\r?\n?%*$/, '');
        if (filePath) {
          addCandidate('write', 'Write Workspace File', { filePath, content }, m);
        }
      }

      // 3. Bracket Read: [read]path[/read] or [read: path]
      const bracketReadRegex = /\[read(?::|\s*)\]?([\s\S]*?)\[\/read\]/gi;
      while ((m = bracketReadRegex.exec(rawText)) !== null) {
        const filePath = sanitizeTagValue(m[1]);
        if (filePath) {
          addCandidate('read', 'Read Workspace File', { filePath }, m);
        }
      }
      const bracketReadColonRegex = /\[read:\s*([^\]]+)\]/gi;
      while ((m = bracketReadColonRegex.exec(rawText)) !== null) {
        const filePath = sanitizeTagValue(m[1]);
        if (filePath) {
          addCandidate('read', 'Read Workspace File', { filePath }, m);
        }
      }

      // 4. XML / Percent Read: %<read>%path%</read>% or <read>path</read>
      const xmlReadRegex = /(?:%<|<)read\s*(?:>%|>|%)\s*([\s\S]*?)\s*(?:%<\/|<\/|%)read\s*(?:>%|>|%)/gi;
      while ((m = xmlReadRegex.exec(rawText)) !== null) {
        const filePath = sanitizeTagValue(m[1]);
        if (filePath) {
          addCandidate('read', 'Read Workspace File', { filePath }, m);
        }
      }

      // 5. Bracket Exec: [exec]cmd[/exec] or [tool_call]cmd[/tool_call]
      const bracketExecRegex = /\[(?:exec|tool_call|command|bash)\]([\s\S]*?)\[\/(?:exec|tool_call|command|bash)\]/gi;
      while ((m = bracketExecRegex.exec(rawText)) !== null) {
        const rawCmd = sanitizeTagValue(m[1]);
        if (rawCmd) {
          if (looksLikeFilePath(rawCmd)) {
            addCandidate('read', 'Read Workspace File', { filePath: rawCmd }, m);
          } else {
            addCandidate('tool_call', 'Execute Shell Command', { command: rawCmd }, m);
          }
        }
      }
      const bracketExecColonRegex = /\[(?:exec|tool_call|command|bash):\s*([^\]]+)\]/gi;
      while ((m = bracketExecColonRegex.exec(rawText)) !== null) {
        const rawCmd = sanitizeTagValue(m[1]);
        if (rawCmd) {
          if (looksLikeFilePath(rawCmd)) {
            addCandidate('read', 'Read Workspace File', { filePath: rawCmd }, m);
          } else {
            addCandidate('tool_call', 'Execute Shell Command', { command: rawCmd }, m);
          }
        }
      }

      // 6. XML / Percent Exec: %<exec>cmd%</exec>% or <exec>cmd</exec>
      const xmlExecRegex = /(?:%<|<)(?:exec|tool_call|command|bash)\s*(?:>%|>|%)\s*([\s\S]*?)\s*(?:%<\/|<\/|%)(?:exec|tool_call|command|bash)\s*(?:>%|>|%)/gi;
      while ((m = xmlExecRegex.exec(rawText)) !== null) {
        const rawCmd = sanitizeTagValue(m[1]);
        if (rawCmd) {
          if (looksLikeFilePath(rawCmd)) {
            addCandidate('read', 'Read Workspace File', { filePath: rawCmd }, m);
          } else {
            addCandidate('tool_call', 'Execute Shell Command', { command: rawCmd }, m);
          }
        }
      }

      // Filter out candidates that are completely enclosed within another candidate!
      // This guarantees an outer [write] or %<write>% is NEVER hijacked by inner tags in its body.
      const topLevelCandidates = candidates.filter((cand) => {
        return !candidates.some((other) => {
          if (cand === other) return false;
          return other.startIndex <= cand.startIndex && other.endIndex >= cand.endIndex;
        });
      });

      if (topLevelCandidates.length > 0) {
        topLevelCandidates.sort((a, b) => a.startIndex - b.startIndex);
        const chosen = topLevelCandidates[0];
        return {
          type: chosen.type,
          title: chosen.title,
          filePath: chosen.filePath,
          content: chosen.content,
          command: chosen.command,
          rawTag: chosen.rawTag
        };
      }

      // 7. Delimiter-bleed or stripped fallback: %%filename.ext%% (Turn 1 bug)
      const percentFileMatch = rawText.match(/%%([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)%%/);
      if (percentFileMatch) {
        const filePath = sanitizeTagValue(percentFileMatch[1]);
        if (looksLikeFilePath(filePath)) {
          return {
            type: 'read',
            title: 'Read Workspace File',
            filePath,
            rawTag: percentFileMatch[0]
          };
        }
      }

      // 8. Sanitized Bare Response fallback: ONLY when response generation is COMPLETED!
      // Guards against partial streaming tokens (e.g. initial chunk "package.json") triggering premature read
      if (isComplete) {
        const cleanLines = rawText
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('Gemini の回答') && !l.startsWith('Gemini') && !l.startsWith('Model'));
        if (cleanLines.length === 1 && looksLikeFilePath(cleanLines[0])) {
          const filePath = sanitizeTagValue(cleanLines[0]);
          return {
            type: 'read',
            title: 'Read Workspace File',
            filePath,
            rawTag: filePath
          };
        }
      }

      return null;
    }

    function parseToolCallsFromDOM(responseEl) {
      if (!responseEl) return null;

      // Inspect rendered code blocks: pre, code-block, .code-block
      const codeBlocks = Array.from(responseEl.querySelectorAll('pre, code-block, .code-block'));
      for (const block of codeBlocks) {
        const codeElem = block.querySelector('code') || block;
        const content = (codeElem.innerText || codeElem.textContent || '').trim();
        if (!content) continue;

        const classes = `${codeElem.className || ''} ${block.className || ''}`.toLowerCase();
        const langMatch = classes.match(/(?:language|lang)-([a-z0-9_+-]+)/i) ||
                          block.getAttribute('data-language');
        const lang = langMatch ? (typeof langMatch === 'string' ? langMatch : langMatch[1]).toLowerCase() : '';

        // 1. Read block: ```read
        if (lang === 'read') {
          const filePath = sanitizeTagValue(content);
          if (filePath) {
            return {
              type: 'read',
              title: 'Read Workspace File',
              filePath,
              rawTag: block.outerHTML || content
            };
          }
        }

        // 2. Write block: ```write or code block with file path metadata
        let writePath = block.getAttribute('data-filepath') || block.getAttribute('data-path');
        if (!writePath && (lang === 'write' || lang.startsWith('write'))) {
          const pathInLang = lang.match(/write[:=]([^\s]+)/);
          if (pathInLang) writePath = pathInLang[1];
        }
        if (!writePath) {
          const tagMatch = content.match(/(?:%<|<|\[)write\s+path=["']?([^"'\]>]+)["']?/i);
          if (tagMatch) writePath = tagMatch[1];
        }
        if (!writePath) {
          const explicit = content.match(/(?:\/\/|#|\/\*|<!--)\s*(?:filepath|filename|file):\s*([^\s*]+)/i) ||
                           content.match(/^(?:File:\s*)([^\s\n]+)/im);
          if (explicit) writePath = explicit[1];
        }
        if (writePath) {
          return {
            type: 'write',
            title: 'Write Workspace File',
            filePath: sanitizeTagValue(writePath),
            content,
            rawTag: block.outerHTML || content
          };
        }

        // 3. Exec block: ```bash, ```sh, ```exec, ```zsh, ```terminal
        if (['exec', 'tool_call', 'bash', 'sh', 'shell', 'zsh', 'terminal', 'cmd'].includes(lang)) {
          // If the block is a generic bash/sh/shell/terminal block, verify it is an intentional tool execution block
          // (not an explanatory multi-snippet response or normal text with code example)
          const isToolLang = ['exec', 'tool_call', 'command'].includes(lang);
          const isExplicitTool = isToolLang ||
                                 block.hasAttribute('data-tool') ||
                                 block.classList.contains('agent-tool') ||
                                 responseEl.hasAttribute('data-agent') ||
                                 (codeBlocks.length === 1 && !responseEl.querySelector('p:not(.model-response-label-announcer *)'));
          if (isExplicitTool) {
            const rawCmd = sanitizeTagValue(content.replace(/^\$\s+/gm, ''));
            if (rawCmd) {
              if (looksLikeFilePath(rawCmd)) {
                return {
                  type: 'read',
                  title: 'Read Workspace File',
                  filePath: rawCmd,
                  rawTag: block.outerHTML || content
                };
              }
              return {
                type: 'tool_call',
                title: 'Execute Shell Command',
                command: rawCmd,
                rawTag: block.outerHTML || content
              };
            }
          }
        }
      }

      return null;
    }

    function checkForAgentToolCalls() {
      // Prioritize model-response elements so we never mistakenly match on user-query prompt text
      let responses = Array.from(document.querySelectorAll('model-response'));
      if (responses.length === 0) {
        responses = Array.from(document.querySelectorAll('.conversation-container'));
      }
      if (responses.length === 0) return;
      const latest = responses[responses.length - 1];

      // If active modal is showing for an older response that has been superseded by a new turn, dismiss it
      if (activeAgentModal) {
        if (activeModalResponse && activeModalResponse !== latest) {
          try { activeAgentModal.remove(); } catch {}
          activeAgentModal = null;
          activeModalResponse = null;
        } else if (document.body.contains(activeAgentModal)) {
          return;
        } else {
          activeAgentModal = null;
          activeModalResponse = null;
        }
      }

      const isComplete = isResponseComplete(latest);
      const rawText = latest.innerText || latest.textContent || '';

      // 1. First parse structured text tags with enclosing block priority
      let toolCall = parseToolCallsFromText(rawText, { isComplete });

      // 2. If no text tags matched, parse rendered DOM code blocks (pre/code-block with language attribute)
      if (!toolCall) {
        toolCall = parseToolCallsFromDOM(latest);
      }

      if (!toolCall) return;

      const callId = `${toolCall.type}:${toolCall.command || toolCall.filePath}:${toolCall.rawTag.length}`;
      if (processedToolCallIds.has(callId)) return;

      showAgentApprovalModal(toolCall, callId, latest);
    }

    function showAgentApprovalModal(toolCall, callId, responseEl) {
      if (activeAgentModal) {
        try { activeAgentModal.remove(); } catch {}
        activeAgentModal = null;
        activeModalResponse = null;
      }

      const modal = document.createElement('div');
      modal.className = 'gtw-agent-approval-card';
      activeAgentModal = modal;
      activeModalResponse = responseEl || null;

      // Header
      const header = document.createElement('div');
      header.className = 'gtw-agent-header';

      const title = document.createElement('div');
      title.className = 'gtw-agent-title';
      title.textContent = `🤖 Agent Request: ${toolCall.title}`;

      const policyBadge = document.createElement('div');
      policyBadge.className = 'gtw-agent-policy';
      policyBadge.textContent = 'Human Approval Required';

      header.appendChild(title);
      header.appendChild(policyBadge);
      modal.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'gtw-agent-body';

      if (toolCall.type === 'tool_call') {
        const desc = document.createElement('div');
        desc.style.marginBottom = '6px';
        desc.textContent = 'Gemini requested to run this command in your workspace:';
        const code = document.createElement('code');
        code.textContent = toolCall.command;
        body.appendChild(desc);
        body.appendChild(code);
      } else if (toolCall.type === 'read') {
        const desc = document.createElement('div');
        desc.style.marginBottom = '6px';
        desc.textContent = 'Gemini requested to read this workspace file:';
        const code = document.createElement('code');
        code.textContent = toolCall.filePath;
        body.appendChild(desc);
        body.appendChild(code);
      } else if (toolCall.type === 'write') {
        const desc = document.createElement('div');
        desc.style.marginBottom = '6px';
        desc.textContent = `Gemini requested to write to file:`;
        const code = document.createElement('code');
        const lineCount = toolCall.content.split('\n').length;
        code.textContent = `${toolCall.filePath} (${lineCount} lines)`;
        const preview = document.createElement('pre');
        preview.className = 'gtw-agent-preview';
        preview.textContent = toolCall.content.slice(0, 350) + (toolCall.content.length > 350 ? '\n...(truncated)' : '');
        body.appendChild(desc);
        body.appendChild(code);
        body.appendChild(preview);
      }
      modal.appendChild(body);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'gtw-agent-actions';

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'gtw-agent-btn-reject';
      rejectBtn.textContent = '✖ Reject [n]';

      const approveBtn = document.createElement('button');
      approveBtn.className = 'gtw-agent-btn-approve';
      approveBtn.textContent = '✔ Approve & Reply [y]';

      actions.appendChild(rejectBtn);
      actions.appendChild(approveBtn);
      modal.appendChild(actions);

      document.body.appendChild(modal);

      const cleanup = () => {
        window.removeEventListener('keydown', onKey);
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (activeAgentModal === modal) {
          activeAgentModal = null;
          activeModalResponse = null;
        }
      };

      const handleApprove = async () => {
        cleanup();
        processedToolCallIds.add(callId);
        showToast(`⚡ Human approved: executing ${toolCall.type}...`, 'info', 3000);

        let resultPayload = '';
        if (toolCall.type === 'tool_call') {
          const res = await callBridge('run', { command: toolCall.command });
          showConsoleOutput(toolCall.command, res);
          const out = (res.stdout || '') + (res.stderr || '');
          resultPayload = `%<tool_result>%\n[Command: ${toolCall.command}]\nExit Code: ${res.code}\nOutput:\n${out.trim() || '(no output)'}\n%</tool_result>%`;
        } else if (toolCall.type === 'read') {
          const res = await callBridge('read', { filePath: toolCall.filePath });
          if (res && res.ok) {
            resultPayload = `%<tool_result>%\n[File: ${toolCall.filePath}]\n${res.content}\n%</tool_result>%`;
          } else {
            resultPayload = `%<tool_result>%\n[File: ${toolCall.filePath}]\nError: ${res?.error || 'Failed to read file'}\n%</tool_result>%`;
          }
        } else if (toolCall.type === 'write') {
          const res = await callBridge('apply', {
            fileActions: [{ filePath: toolCall.filePath, content: toolCall.content }]
          });
          if (res && res.ok) {
            const count = res.totalApplied || res.applied?.length || 1;
            resultPayload = `%<tool_result>%\n[Write: ${toolCall.filePath}]\nSuccessfully applied ${count} file change(s).\n%</tool_result>%`;
          } else {
            resultPayload = `%<tool_result>%\n[Write: ${toolCall.filePath}]\nError: ${res?.error || 'Failed to write file'}\n%</tool_result>%`;
          }
        }

        // Post result to prompt input and submit as human-triggered reply
        const editor = findPromptEditor();
        if (editor) {
          setPromptText(editor, resultPayload);
          showToast('✔ Result submitted to Gemini.', 'success', 3000);
          setTimeout(() => submitCurrentPrompt(), 300);
        }
      };

      const handleReject = () => {
        cleanup();
        processedToolCallIds.add(callId);
        showToast('✖ Action rejected by user.', 'info', 3000);
        const editor = findPromptEditor();
        if (editor) {
          setPromptText(editor, `%<tool_result>%\n[User rejected this tool call: ${toolCall.title}]\n%</tool_result>%`);
        }
      };

      approveBtn.onclick = handleApprove;
      rejectBtn.onclick = handleReject;

      const onKey = (e) => {
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'textarea' || tag === 'input' || e.target?.isContentEditable) {
          if (e.key === 'Escape') {
            e.preventDefault();
            handleReject();
          }
          return;
        }

        if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') {
          e.preventDefault();
          handleApprove();
        } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
          e.preventDefault();
          handleReject();
        }
      };

      window.addEventListener('keydown', onKey);
    }

    const observer = new MutationObserver(() => {
      decorateCodeBlocks();
      checkForAgentToolCalls();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      decorateCodeBlocks();
      checkForAgentToolCalls();
    }, 1000);

    console.log('[gemini-termium] In-page workspace bridge & agent engine ready.');
  }

  startBridge();
})();
