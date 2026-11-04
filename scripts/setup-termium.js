import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.resolve(PROJECT_ROOT, 'vendor/termium');
const BIN_DIR = path.resolve(VENDOR_DIR, 'bin');
const TARGET_BIN = path.resolve(BIN_DIR, 'termium');

const TERMIUM_VERSION = 'v0.2.4';

export function resolveTermiumRelease() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return `termium-darwin-arm64.tar.gz`;
    } else if (arch === 'x64') {
      return `termium-darwin-amd64.tar.gz`;
    }
  } else if (platform === 'linux') {
    if (arch === 'x64') {
      return `termium-linux-amd64.tar.gz`;
    }
  }

  throw new Error(`Unsupported platform/architecture for Termium: ${platform} ${arch}`);
}

export async function ensureTermiumBinary(force = false) {
  if (!force && fs.existsSync(TARGET_BIN)) {
    return TARGET_BIN;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const archiveName = resolveTermiumRelease();
  const url = `https://github.com/codr1/termium/releases/download/${TERMIUM_VERSION}/${archiveName}`;

  console.log(`✦ Downloading Termium binary (${TERMIUM_VERSION} for ${os.platform()}-${os.arch()})...`);
  console.log(`  Source: ${url}`);

  const tempTar = path.resolve(BIN_DIR, 'termium-temp.tar.gz');
  const tempExtractDir = path.resolve(BIN_DIR, 'temp-extract');

  try {
    execSync(`curl -fsSL "${url}" -o "${tempTar}"`, { stdio: 'inherit' });
    fs.mkdirSync(tempExtractDir, { recursive: true });
    execSync(`tar -xzf "${tempTar}" -C "${tempExtractDir}"`, { stdio: 'inherit' });

    // The release archive has bin/termium
    const extractedBin = path.resolve(tempExtractDir, 'bin/termium');
    if (fs.existsSync(extractedBin)) {
      fs.copyFileSync(extractedBin, TARGET_BIN);
      fs.chmodSync(TARGET_BIN, 0o755);
      console.log(`✔ Termium binary installed to ${TARGET_BIN}`);
    } else {
      throw new Error(`Extracted archive did not contain bin/termium`);
    }
  } finally {
    try { fs.rmSync(tempTar, { force: true }); } catch {}
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch {}
  }

  return TARGET_BIN;
}

// If executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureTermiumBinary()
    .then((bin) => {
      console.log(`Termium binary ready: ${bin}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`✖ Failed to setup Termium binary: ${err.message}`);
      process.exit(1);
    });
}
