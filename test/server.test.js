import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBridgeServer } from '../src/server.js';

test('createBridgeServer - HTTP API endpoints integration', async () => {
  const root = path.join(os.tmpdir(), `gtw-server-test-${Date.now()}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/hello.js'), 'export const hello = "world";');

  const bridge = createBridgeServer({ cwd: root });
  const port = await bridge.listen(0);

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.ok, true);
    assert.equal(healthData.cwd, root);

    // 2. Workspace info
    const wsRes = await fetch(`http://127.0.0.1:${port}/v1/workspace`);
    assert.equal(wsRes.status, 200);
    const wsData = await wsRes.json();
    assert.equal(wsData.ok, true);
    assert.equal(wsData.name, path.basename(root));

    // 3. Workspace file suggestion
    const filesRes = await fetch(`http://127.0.0.1:${port}/v1/workspace/files?q=hello`);
    assert.equal(filesRes.status, 200);
    const filesData = await filesRes.json();
    assert.equal(filesData.ok, true);
    assert.ok(filesData.files.includes('src/hello.js'));

    // 4. Action: Apply file change
    const applyRes = await fetch(`http://127.0.0.1:${port}/v1/actions/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileActions: [
          { filePath: 'src/new-file.js', content: 'console.log("created!");', language: 'javascript' }
        ]
      })
    });
    assert.equal(applyRes.status, 200);
    const applyData = await applyRes.json();
    assert.equal(applyData.ok, true);
    assert.equal(applyData.totalApplied, 1);
    assert.equal(fs.readFileSync(path.join(root, 'src/new-file.js'), 'utf8'), 'console.log("created!");');

    // 5. Action: Execute shell command
    const runRes = await fetch(`http://127.0.0.1:${port}/v1/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo "daemon-run-success"' })
    });
    assert.equal(runRes.status, 200);
    const runData = await runRes.json();
    assert.equal(runData.ok, true);
    assert.ok(runData.stdout.includes('daemon-run-success'));

    // 6. Action: Read file
    const readRes = await fetch(`http://127.0.0.1:${port}/v1/actions/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'src/hello.js' })
    });
    assert.equal(readRes.status, 200);
    const readData = await readRes.json();
    assert.equal(readData.ok, true);
    assert.equal(readData.content, 'export const hello = "world";');

    // 7. Action: Package workspace zip
    const zipRes = await fetch(`http://127.0.0.1:${port}/v1/workspace/zip`, {
      method: 'POST'
    });
    assert.equal(zipRes.status, 200);
    const zipData = await zipRes.json();
    assert.equal(zipData.ok, true);
    assert.ok(zipData.zipPath && fs.existsSync(zipData.zipPath));
    try { fs.unlinkSync(zipData.zipPath); } catch {}
  } finally {
    await bridge.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
