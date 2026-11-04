import test from 'node:test';
import assert from 'node:assert';
import { locateChromeBinary, locateSystemChromeProfile, findAvailablePort, isPortAvailable } from '../src/chromeManager.js';

test('chromeManager: locateChromeBinary finds browser on current system', () => {
  const bin = locateChromeBinary();
  assert.ok(bin, 'Should find a Chrome or Chromium binary on test machine');
  console.log(`Found Chrome binary at: ${bin}`);
});

test('chromeManager: custom browser path is honored', () => {
  const custom = locateChromeBinary(process.execPath);
  assert.strictEqual(custom, process.execPath);
});

test('chromeManager: findAvailablePort finds free port', async () => {
  const port = await findAvailablePort(9500);
  assert.ok(port >= 9500, 'Port should be >= 9500');
  const available = await isPortAvailable(port);
  assert.strictEqual(available, true, 'Port should be available');
});
