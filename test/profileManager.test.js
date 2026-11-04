import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  getWorkspaceProfileDir,
  isProfileLoggedIn,
  cloneProfile,
  ensureWorkspaceProfile,
  cleanStaleProfileLocks,
  isProcessRunning
} from '../src/profileManager.js';

test('getWorkspaceProfileDir - deterministic and sanitized path', () => {
  const p1 = getWorkspaceProfileDir('/home/user/work/my-project');
  const p2 = getWorkspaceProfileDir('/home/user/work/my-project');
  const pOther = getWorkspaceProfileDir('/home/user/work/other-project');

  assert.equal(p1, p2);
  assert.notEqual(p1, pOther);
  assert.ok(p1.includes('ws_my-project_'));
});

test('isProfileLoggedIn - detects presence of verified Google auth cookies', () => {
  const tmp = path.join(os.tmpdir(), `gtw-cookie-test-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });

  try {
    assert.equal(isProfileLoggedIn(tmp), false);

    const netDir = path.join(tmp, 'Default', 'Network');
    fs.mkdirSync(netDir, { recursive: true });
    
    // Unauthenticated tracking cookies should NOT count as logged in
    fs.writeFileSync(path.join(netDir, 'Cookies'), 'fake-unauthenticated-tracking-cookies');
    assert.equal(isProfileLoggedIn(tmp), false);

    // Google authentication token presence must be detected
    fs.writeFileSync(path.join(netDir, 'Cookies'), 'sqlite-binary-__Secure-OSID-session-data');
    assert.equal(isProfileLoggedIn(tmp), true);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('cloneProfile - copies auth state and skips locks/caches', () => {
  const src = path.join(os.tmpdir(), `gtw-clone-src-${Date.now()}`);
  const dest = path.join(os.tmpdir(), `gtw-clone-dest-${Date.now()}`);

  try {
    fs.mkdirSync(path.join(src, 'Default', 'Network'), { recursive: true });
    fs.mkdirSync(path.join(src, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Default', 'Network', 'Cookies'), 'session-tokens');
    fs.writeFileSync(path.join(src, 'Default', 'Preferences'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(src, 'Default', 'Cache', 'large_cache_blob'), 'cache');
    fs.writeFileSync(path.join(src, 'SingletonLock'), '12345');

    cloneProfile(src, dest);

    // Verify auth state is copied
    assert.ok(fs.existsSync(path.join(dest, 'Default', 'Network', 'Cookies')));
    assert.equal(fs.readFileSync(path.join(dest, 'Default', 'Network', 'Cookies'), 'utf8'), 'session-tokens');
    assert.ok(fs.existsSync(path.join(dest, 'Default', 'Preferences')));

    // Verify locks and heavy caches are NOT copied
    assert.ok(!fs.existsSync(path.join(dest, 'SingletonLock')));
    assert.ok(!fs.existsSync(path.join(dest, 'Default', 'Cache', 'large_cache_blob')));
  } finally {
    try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
  }
});

test('cleanStaleProfileLocks - cleans broken symlinks, stale locks, and socket files', () => {
  const tmp = path.join(os.tmpdir(), `gtw-lock-test-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });

  try {
    // Create broken symlinks mimicking abrupt crash or orphan process
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
    for (const name of lockFiles) {
      try {
        fs.symlinkSync(`non-existent-target-${Date.now()}-999999`, path.join(tmp, name));
      } catch {
        fs.writeFileSync(path.join(tmp, name), 'stale');
      }
    }

    // Verify lock files exist in filesystem (even as broken symlinks)
    for (const name of lockFiles) {
      assert.ok(fs.lstatSync(path.join(tmp, name), { throwIfNoEntry: false }) !== undefined);
    }

    cleanStaleProfileLocks(tmp);

    // Verify all lock files are cleaned up
    for (const name of lockFiles) {
      assert.equal(fs.lstatSync(path.join(tmp, name), { throwIfNoEntry: false }), undefined);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('cleanStaleProfileLocks - terminates orphan process and removes locks', async () => {
  const tmp = path.join(os.tmpdir(), `gtw-orphan-unit-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });

  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', '--chrome-test-flag']);
  try {
    const lockPath = path.join(tmp, 'SingletonLock');
    fs.symlinkSync(`test-host-${dummy.pid}`, lockPath);

    cleanStaleProfileLocks(tmp);

    // Wait a tick for OS signal handling
    await new Promise((r) => setTimeout(r, 50));

    // Verify lock is removed and process was terminated
    assert.equal(fs.lstatSync(lockPath, { throwIfNoEntry: false }), undefined);
    assert.ok(dummy.killed || !isProcessRunning(dummy.pid));
  } finally {
    try { dummy.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('isProcessRunning - correctly identifies running and non-existent processes', () => {
  // Current process is alive
  assert.equal(isProcessRunning(process.pid), true);
  // Invalid PID
  assert.equal(isProcessRunning(-1), false);
  assert.equal(isProcessRunning(0), false);
  assert.equal(isProcessRunning(null), false);
  // Extremely high PID unlikely to exist
  assert.equal(isProcessRunning(99999999), false);
});
