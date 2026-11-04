import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { locateSystemChromeProfile } from './chromeManager.js';

export const CONFIG_ROOT = path.join(os.homedir(), '.config', 'gemini-termium');
export const MASTER_PROFILE_DIR = path.join(CONFIG_ROOT, 'master-profile');
export const PROFILES_DIR = path.join(CONFIG_ROOT, 'profiles');

const SKIP_FILENAMES = new Set([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile'
]);

/**
 * Returns the deterministic profile directory for a given workspace path.
 */
export function getWorkspaceProfileDir(cwd = process.cwd()) {
  const absPath = path.resolve(cwd);
  const hash = crypto.createHash('md5').update(absPath).digest('hex').slice(0, 12);
  const baseName = path.basename(absPath).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PROFILES_DIR, `ws_${baseName}_${hash}`);
}

function getCookieFile(profileDir) {
  const candidates = [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Network', 'Cookies')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const stat = fs.statSync(c);
        if (stat.size > 0) return c;
      } catch {}
    }
  }
  return null;
}

/**
 * Checks whether a given Chromium profile directory contains verified Google authentication cookies.
 * Inspects sqlite cookie database for Google authentication signatures (__Secure-OSID, __Secure-1PSID, SID, SAPISID).
 */
export function isProfileLoggedIn(profileDir) {
  if (!fs.existsSync(profileDir)) return false;

  const cookieFile = getCookieFile(profileDir);
  if (!cookieFile) return false;

  try {
    const buf = fs.readFileSync(cookieFile);
    // Verified Google auth token keys in sqlite DB
    const hasAuthToken =
      buf.includes(Buffer.from('__Secure-OSID')) ||
      buf.includes(Buffer.from('__Secure-1PSID')) ||
      buf.includes(Buffer.from('SAPISID')) ||
      buf.includes(Buffer.from('APISID')) ||
      buf.includes(Buffer.from('OSID'));
    return hasAuthToken;
  } catch {
    return false;
  }
}

/**
 * Returns the mtime timestamp of the profile's Cookie file.
 */
export function getProfileCookieMtime(profileDir) {
  const cookieFile = getCookieFile(profileDir);
  if (!cookieFile) return 0;
  try {
    return fs.statSync(cookieFile).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Clones essential profile state (Cookies, Local Storage, Preferences) from source to target.
 * Skips ephemeral lock files and heavy cache directories to complete in milliseconds.
 */
export function cloneProfile(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source profile does not exist: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      // Skip runtime locks
      if (SKIP_FILENAMES.has(base)) return false;
      // Skip cache directories to keep cloning ultra-fast and lightweight
      if (base.includes('Cache') || base === 'DawnCache' || base === 'GPUCache') return false;
      return true;
    }
  });
}

/**
 * Copies core authentication files (Cookies, Login Data, Local State) from source to target.
 */
export function syncAuthFiles(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) return false;

  const filesToSync = [
    ['Default', 'Cookies'],
    ['Default', 'Cookies-journal'],
    ['Default', 'Login Data'],
    ['Default', 'Login Data-journal'],
    ['Default', 'Network', 'Cookies'],
    ['Default', 'Network', 'Cookies-journal'],
    ['Local State']
  ];

  let copied = false;
  for (const parts of filesToSync) {
    const src = path.join(sourceDir, ...parts);
    const dest = path.join(targetDir, ...parts);
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied = true;
      } catch {}
    }
  }
  return copied;
}

/**
 * Attempts to automatically seed master profile from the system's Google Chrome profile
 * if master profile is not yet logged in.
 */
export function trySeedMasterFromSystem() {
  if (isProfileLoggedIn(MASTER_PROFILE_DIR)) {
    return true;
  }

  const systemProfile = locateSystemChromeProfile();
  if (systemProfile && isProfileLoggedIn(systemProfile)) {
    try {
      console.log(`✦ Seeding initial authentication from system browser (${systemProfile})...`);
      cloneProfile(systemProfile, MASTER_PROFILE_DIR);
      return isProfileLoggedIn(MASTER_PROFILE_DIR);
    } catch (err) {
      console.warn(`⚠ Could not auto-seed system Chrome profile: ${err.message}`);
    }
  }
  return false;
}

/**
 * Synchronizes refreshed session cookies from a workspace profile back to the master profile.
 */
export function syncCookiesToMaster(workspaceProfileDir) {
  return syncAuthFiles(workspaceProfileDir, MASTER_PROFILE_DIR);
}

/**
 * Checks if a PID is alive.
 */
export function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Checks if a process belongs to Chrome/Chromium.
 */
export function isChromeProcess(pid, profileDir = '') {
  try {
    if (process.platform === 'linux') {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.toLowerCase().includes('chrom') || (profileDir && cmdline.includes(profileDir));
    } else if (process.platform === 'darwin') {
      const out = execSync(`ps -p ${pid} -o command=`, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });
      return out.toLowerCase().includes('chrom') || (profileDir && out.includes(profileDir));
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Cleans up stale profile locks (SingletonLock, SingletonSocket, SingletonCookie, lockfile)
 * and safely terminates orphan Chrome processes holding the profile lock.
 *
 * @param {string} profileDir - Path to the Chromium user-data-dir
 * @returns {boolean}
 */
export function cleanStaleProfileLocks(profileDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return false;

  const lockFiles = [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'lockfile'
  ];

  const singletonLockPath = path.join(profileDir, 'SingletonLock');
  try {
    const stat = fs.lstatSync(singletonLockPath, { throwIfNoEntry: false });
    if (stat) {
      let target = '';
      if (stat.isSymbolicLink()) {
        target = fs.readlinkSync(singletonLockPath);
      } else {
        target = fs.readFileSync(singletonLockPath, 'utf8');
      }
      const match = target.match(/-(\d+)(?:\0|$)/);
      const pid = match ? parseInt(match[1], 10) : null;
      if (pid && pid !== process.pid && isProcessRunning(pid)) {
        if (isChromeProcess(pid, profileDir)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
          const start = Date.now();
          while (Date.now() - start < 300) {
            if (!isProcessRunning(pid)) break;
          }
          if (isProcessRunning(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
        }
      }
    }
  } catch {}

  // Remove stale lock files (using rmSync to handle broken symlinks cleanly)
  for (const name of lockFiles) {
    const lockPath = path.join(profileDir, name);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }

  return true;
}

/**
 * Ensures a workspace profile is ready and fully synchronized with the master profile.
 *
 * @param {string} cwd - Workspace root
 * @returns {{ profileDir: string, isSeeded: boolean, isFirstTime: boolean }}
 */
export function ensureWorkspaceProfile(cwd = process.cwd()) {
  const profileDir = getWorkspaceProfileDir(cwd);
  cleanStaleProfileLocks(profileDir);
  let isSeeded = false;
  let isFirstTime = false;

  // Auto-seed master profile from system if needed
  trySeedMasterFromSystem();

  const masterHasAuth = isProfileLoggedIn(MASTER_PROFILE_DIR);
  const wsHasAuth = isProfileLoggedIn(profileDir);

  if (!fs.existsSync(profileDir)) {
    isFirstTime = true;
    if (masterHasAuth) {
      cloneProfile(MASTER_PROFILE_DIR, profileDir);
      isSeeded = true;
    } else {
      fs.mkdirSync(profileDir, { recursive: true });
    }
  } else if (masterHasAuth) {
    // If workspace profile lacks auth, or master profile was recently updated via --login
    const masterMtime = getProfileCookieMtime(MASTER_PROFILE_DIR);
    const wsMtime = getProfileCookieMtime(profileDir);

    if (!wsHasAuth || masterMtime > wsMtime) {
      cloneProfile(MASTER_PROFILE_DIR, profileDir);
      isSeeded = true;
    }
  }

  return {
    profileDir,
    isSeeded,
    isFirstTime
  };
}
