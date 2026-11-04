import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { locateChromeBinary, findAvailablePort } from '../src/chromeManager.js';
import { startBackend } from '../src/backend.js';
import grpc from '@grpc/grpc-js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bc = require('../vendor/termium/server/dist/generated/bc.js');

test('Termium Full Integration & E2E: Unified Backend + Termium Client communication', async (t) => {
  const chromeBin = locateChromeBinary();
  if (!chromeBin) {
    console.log('Skipping E2E test: Google Chrome binary not found');
    return;
  }

  const tmpWorkspace = path.join(os.tmpdir(), `test-ws-termium-${Date.now()}`);
  const tmpProfile = path.join(os.tmpdir(), `test-prof-termium-${Date.now()}`);
  fs.mkdirSync(tmpWorkspace, { recursive: true });
  fs.mkdirSync(tmpProfile, { recursive: true });

  fs.writeFileSync(path.join(tmpWorkspace, 'initial.txt'), 'Hello Termium');

  const cdpPort = await findAvailablePort(9400);
  const bridgePort = await findAvailablePort(45200);
  const grpcPort = await findAvailablePort(50200);

  console.log(`[E2E] Starting unified backend...`);
  const backend = await startBackend({
    cwd: tmpWorkspace,
    profileDir: tmpProfile,
    chromeBin,
    cdpPort,
    grpcPort,
    bridgePort,
    isHeadless: true
  });

  t.after(async () => {
    console.log(`[E2E] Tearing down backend and cleaning up temporary dirs...`);
    await backend.close();
    try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  });

  // 1. Verify Bridge HTTP Server
  console.log(`[E2E] Verifying Bridge Server on port ${backend.bridgePort}...`);
  const healthRes = await fetch(`http://127.0.0.1:${backend.bridgePort}/v1/health`);
  assert.strictEqual(healthRes.status, 200);
  const health = await healthRes.json();
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.cwd, tmpWorkspace);

  // 2. Verify Workspace Action (/apply)
  console.log(`[E2E] Verifying Workspace apply API...`);
  const applyRes = await fetch(`http://127.0.0.1:${backend.bridgePort}/v1/actions/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileActions: [
        {
          filePath: 'new_feature.js',
          code: 'console.log("Termium rocks!");'
        }
      ]
    })
  });
  assert.strictEqual(applyRes.status, 200);
  const applyJson = await applyRes.json();
  assert.strictEqual(applyJson.ok, true);
  assert.strictEqual(applyJson.totalApplied, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(tmpWorkspace, 'new_feature.js'), 'utf-8'),
    'console.log("Termium rocks!");'
  );

  // 3. Verify gRPC Termium Client Communication
  console.log(`[E2E] Verifying gRPC Termium service on port ${backend.grpcPort}...`);
  const client = new bc.BrowserControlClient(
    `127.0.0.1:${backend.grpcPort}`,
    grpc.credentials.createInsecure()
  );

  const state = await new Promise((resolve, reject) => {
    client.getBrowserState({}, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

  assert.ok(state, 'Browser state should be returned');
  assert.ok(typeof state.generation !== 'undefined', 'Generation must exist');
  console.log(`[E2E] Browser state generation: ${state.generation}, tabs: ${state.tabs?.length || 0}`);

  // 4. Verify Screenshot Capture
  console.log(`[E2E] Capturing screenshot via Termium gRPC...`);
  const frame = await new Promise((resolve, reject) => {
    client.captureScreenshot({ format: 'png' }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });

  assert.ok(frame.data.length > 0, 'Screenshot data must not be empty');
  console.log(`[E2E] Successfully received screenshot frame: ${frame.data.length} bytes`);
});
