import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getWorkspaceProfileDir,
  isProfileLoggedIn,
  cloneProfile,
  ensureWorkspaceProfile
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
