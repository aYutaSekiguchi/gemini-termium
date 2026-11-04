import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

export function locateChromeBinary(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const platform = os.platform();
  const candidates = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/brave-browser'
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  return null;
}

export function locateSystemChromeProfile() {
  const platform = os.platform();
  const candidates = [];

  if (platform === 'darwin') {
    candidates.push(
      path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Chromium')
    );
  } else if (platform === 'linux') {
    candidates.push(
      path.join(os.homedir(), '.config', 'google-chrome'),
      path.join(os.homedir(), '.config', 'chromium')
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  return null;
}

export async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => {
      s.close(() => resolve(true));
    });
    s.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(startPort = 9222, maxAttempts = 100) {
  for (let p = startPort; p < startPort + maxAttempts; p++) {
    if (await isPortAvailable(p)) return p;
  }
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.once('listening', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.listen(0, '127.0.0.1');
  });
}
