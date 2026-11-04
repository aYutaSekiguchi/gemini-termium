import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChromeArgs } from '../src/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../bin/gemini-termium.js');

test('CLI: --help prints usage and exits cleanly', async () => {
  const child = spawn(process.execPath, [CLI_PATH, '--help']);
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });

  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.strictEqual(code, 0);
  assert.ok(stdout.includes('gemini-termium: Cross-Platform'));
  assert.ok(stdout.includes('--login'));
  assert.ok(stdout.includes('/apply'));
});

test('CLI: launches backend without reference errors', async (t) => {
  const child = spawn(process.execPath, [CLI_PATH, '--renderer', 'tcell'], {
    env: { ...process.env }
  });

  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
  });

  let output = '';
  const started = await new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      output += d.toString();
      if (output.includes('Starting Gemini Termium Bridge') && output.includes('Launching Chrome')) {
        resolve(true);
      }
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    setTimeout(() => resolve(false), 8000);
  });

  assert.ok(started, `CLI should start backend without crashing: ${output}`);
  assert.ok(!output.includes('chromeBin is not defined'), 'Must not have chromeBin reference error');
});

test('buildChromeArgs: omits blocked flags and ensures botguard integrity', () => {
  const args = buildChromeArgs({
    profileDir: '/tmp/test-profile',
    cdpPort: 9222,
    isHeadless: true
  });

  const argStr = args.join(' ');

  // Must NOT include flags that trigger Google "This browser or app may not be secure" or "エラーが発生しました (1)"
  assert.ok(!argStr.includes('--disable-web-security'), 'Must not have --disable-web-security');
  assert.ok(!argStr.includes('--allow-running-insecure-content'), 'Must not have --allow-running-insecure-content');
  assert.ok(!argStr.includes('--disable-background-networking'), 'Must not have --disable-background-networking');
  assert.ok(!argStr.includes('--disable-sync'), 'Must not have --disable-sync');

  // Must have stealth and proper environment attributes
  assert.ok(argStr.includes('--disable-blink-features=AutomationControlled'), 'Must disable AutomationControlled');
  assert.ok(argStr.includes('--user-agent='), 'Must provide clean desktop user agent');
  assert.ok(!argStr.includes('HeadlessChrome'), 'Must not leak HeadlessChrome in user agent');
  assert.ok(argStr.includes('--window-size=1280,800'), 'Must provide standard desktop window size');
});
