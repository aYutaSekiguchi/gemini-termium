import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isPathInsideRootDir,
  applyUnifiedDiff,
  applyFileChangesToDisk,
  executeShellCommand,
  scanWorkspaceFiles,
  readFileFromDisk
} from '../src/workspace.js';

test('isPathInsideRootDir - security boundary enforcement', () => {
  const root = path.join(os.tmpdir(), `gtw-test-root-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });

  try {
    assert.equal(isPathInsideRootDir('src/index.js', root), true);
    assert.equal(isPathInsideRootDir('README.md', root), true);
    assert.equal(isPathInsideRootDir('./nested/sub/file.txt', root), true);

    // Path traversal attacks
    assert.equal(isPathInsideRootDir('../outside.txt', root), false);
    assert.equal(isPathInsideRootDir('../../etc/passwd', root), false);
    assert.equal(isPathInsideRootDir('/etc/shadow', root), false);
    assert.equal(isPathInsideRootDir('/tmp', root), false);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('applyUnifiedDiff - patches content cleanly', () => {
  const original = [
    'line 1',
    'line 2 to change',
    'line 3',
    'line 4'
  ].join('\n');

  const diff = [
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1,4 +1,4 @@',
    ' line 1',
    '-line 2 to change',
    '+line 2 modified',
    ' line 3',
    ' line 4'
  ].join('\n');

  const patched = applyUnifiedDiff(original, diff);
  const lines = patched.split('\n');
  assert.equal(lines[1], 'line 2 modified');
  assert.equal(lines[0], 'line 1');
  assert.equal(lines[2], 'line 3');
});

test('applyFileChangesToDisk - writes and patches files within root', () => {
  const root = path.join(os.tmpdir(), `gtw-disk-test-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });

  try {
    const actions = [
      { filePath: 'src/main.js', content: 'console.log("hello");', language: 'javascript' },
      { filePath: '../hack.js', content: 'alert("hacked");', language: 'javascript' }
    ];

    const result = applyFileChangesToDisk(actions, root);
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.applied[0].filePath, 'src/main.js');

    const written = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
    assert.equal(written, 'console.log("hello");');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('executeShellCommand - captures stdout and exit code', async () => {
  const res = await executeShellCommand('echo "test-termway-123"');
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('test-termway-123'));

  const failRes = await executeShellCommand('exit 42');
  assert.equal(failRes.ok, false);
  assert.equal(failRes.code, 42);
});

test('scanWorkspaceFiles - ignores .git and returns relative paths', () => {
  const root = path.join(os.tmpdir(), `gtw-scan-test-${Date.now()}`);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/config'), 'test');
  fs.writeFileSync(path.join(root, 'src/app.js'), 'test');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  try {
    const files = scanWorkspaceFiles(root);
    assert.ok(files.includes('src/app.js'));
    assert.ok(files.includes('package.json'));
    assert.ok(!files.some((f) => f.includes('.git')));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('readFileFromDisk - securely reads files and enforces boundaries', () => {
  const root = path.join(os.tmpdir(), `gtw-read-test-${Date.now()}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/hello.txt'), 'hello agent');

  try {
    const res = readFileFromDisk('src/hello.txt', root);
    assert.equal(res.filePath, 'src/hello.txt');
    assert.equal(res.content, 'hello agent');

    // Outside boundary
    assert.throws(() => readFileFromDisk('../secret.txt', root), /outside workspace root/);
    // Non-existent
    assert.throws(() => readFileFromDisk('missing.txt', root), /File not found/);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
