#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { locateChromeBinary } from '../src/chromeManager.js';
import {
  MASTER_PROFILE_DIR,
  isProfileLoggedIn,
  ensureWorkspaceProfile,
  syncCookiesToMaster,
  getWorkspaceProfileDir,
  cloneProfile
} from '../src/profileManager.js';
import { ensureTermiumBinary } from '../scripts/setup-termium.js';
import { startBackend } from '../src/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.resolve(PROJECT_ROOT, 'extension');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
gemini-termium: Cross-Platform In-Terminal Google Gemini with Local Workspace Bridge

Usage:
  gemini-termium [options]

Options:
  -h, --help               Show this help message
  --login                  Open a desktop window to sign in to Google once (login is saved and reused)
  --gui                    Launch as a standard desktop window (for testing/login)
  --port <number>          Local workspace bridge server port (default: auto free port starting at 45140)
  --cdp-port <number>      Chrome remote debugging port (default: auto free port starting at 9222)
  --grpc-port <number>     Termium gRPC port (default: auto free port starting at 50051)
  --renderer <proto>       Rendering protocol: auto, kitty, sixel, tcell (default: auto)
  --palette <name>         Color palette: adaptive, websafe, plan9 (default: websafe)
  --skill <name>           Gemini Skill name to invoke for /agent (default: termium)
  --browser <path>         Custom Google Chrome / Chromium executable path

Features:
  - Terminal display: Gemini web UI rendered in your terminal via Termium
    (Kitty Graphics, Sixel, or ASCII/half-block). macOS and Linux.
  - Local workspace: file access and commands are limited to the current directory ($PWD)
  - Native Slash Commands:
      /agent [prompt]      Start autonomous coding agent with workspace file tree & tools
      /run [cmd]           Run shell commands on local workspace
      /status              Show workspace connection details
    `);
    process.exit(0);
  }

  const isLogin = args.includes('--login');
  const isGui = args.includes('--gui') || isLogin;

  // Resolve custom or system browser
  const browserIdx = args.findIndex((a) => a === '--browser');
  const customBrowser = browserIdx !== -1 && args[browserIdx + 1] ? args[browserIdx + 1] : null;
  const chromeBin = locateChromeBinary(customBrowser);

  if (!chromeBin) {
    console.error('✖ Error: No compatible Google Chrome or Chromium binary found.');
    console.error('  Please install Google Chrome or specify its path with --browser.');
    process.exit(1);
  }

  // Handle --login: Launch master profile in GUI mode
  if (isLogin) {
    console.log(`✦ Launching Master Profile login window...`);
    console.log(`  👤 Master Profile: ${MASTER_PROFILE_DIR}`);
    console.log(`  👉 Please sign in to your Google Account in the browser, then close the window.\n`);

    fs.mkdirSync(MASTER_PROFILE_DIR, { recursive: true });
    const loginArgs = [
      `--user-data-dir=${MASTER_PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--app=https://gemini.google.com'
    ];

    const child = spawn(chromeBin, loginArgs, { stdio: 'inherit' });
    child.on('close', () => {
      if (isProfileLoggedIn(MASTER_PROFILE_DIR)) {
        console.log(`\n✔ Master Google login saved! All projects will now automatically start logged in.`);
        try {
          const wsDir = getWorkspaceProfileDir(process.cwd());
          cloneProfile(MASTER_PROFILE_DIR, wsDir);
        } catch {}
      } else {
        console.log(`\n⚠ Closed login window without saving session.`);
      }
      process.exit(0);
    });
    return;
  }

  // Ensure Termium client binary is installed
  const termiumBin = await ensureTermiumBinary();

  // Setup workspace profile
  const cwd = process.cwd();
  const { profileDir, isSeeded } = ensureWorkspaceProfile(cwd);

  const portIdx = args.findIndex((a) => a === '--port');
  const bridgePort = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : null;

  const cdpIdx = args.findIndex((a) => a === '--cdp-port');
  const cdpPort = cdpIdx !== -1 && args[cdpIdx + 1] ? parseInt(args[cdpIdx + 1], 10) : null;

  const grpcIdx = args.findIndex((a) => a === '--grpc-port');
  const grpcPort = grpcIdx !== -1 && args[grpcIdx + 1] ? parseInt(args[grpcIdx + 1], 10) : null;

  const rendererIdx = args.findIndex((a) => a === '--renderer');
  const renderer = rendererIdx !== -1 && args[rendererIdx + 1] ? args[rendererIdx + 1] : 'auto';

  const paletteIdx = args.findIndex((a) => a === '--palette');
  const palette = paletteIdx !== -1 && args[paletteIdx + 1] ? args[paletteIdx + 1] : 'websafe';

  const skillIdx = args.findIndex((a) => a === '--skill');
  const skillName = skillIdx !== -1 && args[skillIdx + 1] ? args[skillIdx + 1] : 'termium';

  console.log(`✦ Starting Gemini Termium Bridge...`);
  console.log(`  📁 Workspace: ${cwd}`);
  console.log(`  👤 Profile:   ${profileDir}`);
  if (skillName && skillName !== 'none') {
    console.log(`  🤖 Skill:     @${skillName}`);
  }
  if (isSeeded) {
    console.log(`  🔑 Auth:      ✔ Inherited Google login from Chrome profile`);
  } else if (!isProfileLoggedIn(profileDir)) {
    console.log(`  💡 Tip:       Run "gemini-termium --login" once to log in if not signed in.`);
  }

  // Start in-process unified backend (Chrome + gRPC Server + Bridge + CDP Injector)
  const backend = await startBackend({
    cwd,
    profileDir,
    chromeBin,
    cdpPort,
    grpcPort,
    bridgePort,
    skillName,
    isHeadless: !isGui
  });

  console.log(`  🔌 CDP Port:  ${backend.cdpPort}`);
  console.log(`  ⚡ Bridge:    http://127.0.0.1:${backend.bridgePort}`);
  console.log(`  🖥 gRPC Port:  ${backend.grpcPort}`);

  let clientProcess = null;
  let isCleaningUp = false;

  const cleanup = async (exitCode = 0) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try { syncCookiesToMaster(profileDir); } catch {}
    if (clientProcess && !clientProcess.killed) {
      try { clientProcess.kill('SIGTERM'); } catch {}
    }
    if (backend) {
      try { await backend.close(); } catch {}
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => cleanup(130));
  process.on('SIGTERM', () => cleanup(143));
  process.on('SIGHUP', () => cleanup(129));

  if (isGui) {
    console.log(`🌐 Running in desktop GUI mode. Close browser window to exit.`);
    backend.chromeProcess.on('close', async (code) => {
      await cleanup(code || 0);
    });
    return;
  }

  console.log(`🖥 Launching in-terminal session via Termium (${renderer} renderer)...`);

  const termiumArgs = [
    '-s', `127.0.0.1:${backend.grpcPort}`,
    '-r', renderer,
    '-p', palette,
    'https://gemini.google.com'
  ];

  clientProcess = spawn(termiumBin, termiumArgs, { stdio: 'inherit' });

  clientProcess.on('close', async (code) => {
    await cleanup(code || 0);
  });
}

main().catch((err) => {
  console.error(`✖ Error: ${err.message}`);
  process.exit(1);
});
