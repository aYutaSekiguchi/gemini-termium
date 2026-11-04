import http from 'node:http';
import path from 'node:path';
import {
  applyFileChangesToDisk,
  executeShellCommand,
  scanWorkspaceFiles,
  readFileFromDisk,
  formatWorkspaceTree
} from './workspace.js';

export function createBridgeServer({ cwd = process.cwd(), skillName = 'pair-programmer' } = {}) {

  const server = http.createServer(async (req, res) => {
    // Restrict CORS to Gemini web origin and local test origin
    const origin = req.headers.origin;
    const isAllowedOrigin = !origin ||
      origin === 'https://gemini.google.com' ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.startsWith('http://localhost:');

    if (origin && isAllowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      if (!isAllowedOrigin) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (origin && !isAllowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden: CORS origin not allowed' }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Health check
      if (req.method === 'GET' && pathname === '/v1/health') {
        return sendJson(200, { ok: true, cwd, pid: process.pid });
      }

      // 2. Workspace info & file tree
      if (req.method === 'GET' && pathname === '/v1/workspace') {
        const files = scanWorkspaceFiles(cwd, 300);
        const fileTree = formatWorkspaceTree(cwd, 200);
        return sendJson(200, {
          ok: true,
          cwd,
          name: path.basename(cwd),
          files,
          fileTree,
          totalFiles: files.length,
          skillName
        });
      }

      // Read JSON request body for POST endpoints
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw) {
          try { body = JSON.parse(raw); } catch {
            return sendJson(400, { ok: false, error: 'Malformed JSON payload' });
          }
        }
      }

      // 5. Apply file changes/diffs to workspace
      if (req.method === 'POST' && pathname === '/v1/actions/apply') {
        const fileActions = Array.isArray(body.fileActions) ? body.fileActions : [];
        if (fileActions.length === 0) {
          return sendJson(400, { ok: false, error: 'No file actions provided' });
        }
        const result = applyFileChangesToDisk(fileActions, cwd);
        return sendJson(200, {
          ok: true,
          applied: result.applied,
          skipped: result.skipped,
          totalApplied: result.applied.length
        });
      }

      // 5b. Read file from workspace
      if (req.method === 'POST' && pathname === '/v1/actions/read') {
        const filePath = (body.filePath || body.path || '').trim();
        if (!filePath) {
          return sendJson(400, { ok: false, error: 'No file path provided' });
        }
        try {
          const res = readFileFromDisk(filePath, cwd);
          return sendJson(200, { ok: true, ...res });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }

      // 6. Execute shell command in workspace
      if (req.method === 'POST' && pathname === '/v1/actions/run') {
        const command = (body.command || '').trim();
        if (!command) {
          return sendJson(400, { ok: false, error: 'Empty command string' });
        }
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 60000;
        const result = await executeShellCommand(command, cwd, timeoutMs);
        return sendJson(result.ok ? 200 : 500, result);
      }

      sendJson(404, { ok: false, error: `Endpoint not found: ${pathname}` });
    } catch (err) {
      sendJson(500, { ok: false, error: err.message });
    }
  });

  return {
    server,
    listen: (port = 45140, host = '127.0.0.1') => {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
        server.on('error', reject);
      });
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
