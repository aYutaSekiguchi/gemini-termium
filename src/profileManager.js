import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

/**
 * Checks whether a given Chromium profile directory contains saved session cookies.
 */
export function isProfileLoggedIn(profileDir) {
  if (!fs.existsSync(profileDir)) return false;

  const cookieCandidates = [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Network', 'Cookies')
  ];

  for (const c of cookieCandidates) {
    if (fs.existsSync(c)) {
      try {
        const stat = fs.statSync(c);
        if (stat.size > 0) return true;
      } catch {}
    }
  }
  return false;
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
  if (!fs.existsSync(workspaceProfileDir) || !fs.existsSync(MASTER_PROFILE_DIR)) {
    return false;
  }

  const wsNetworkDir = path.join(workspaceProfileDir, 'Default', 'Network');
  const masterNetworkDir = path.join(MASTER_PROFILE_DIR, 'Default', 'Network');

  if (fs.existsSync(wsNetworkDir)) {
    try {
      fs.mkdirSync(masterNetworkDir, { recursive: true });
      fs.cpSync(wsNetworkDir, masterNetworkDir, {
        recursive: true,
        filter: (src) => !SKIP_FILENAMES.has(path.basename(src))
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Ensures a workspace profile is ready, automatically seeding Google authentication
 * from the master profile (or system profile) if the workspace profile is not yet initialized.
 *
 * @param {string} cwd - Workspace root
 * @returns {{ profileDir: string, isSeeded: boolean, isFirstTime: boolean }}
 */
export function ensureWorkspaceProfile(cwd = process.cwd()) {
  const profileDir = getWorkspaceProfileDir(cwd);
  let isSeeded = false;
  let isFirstTime = false;

  // Auto-seed master profile from system if needed
  trySeedMasterFromSystem();

  if (!fs.existsSync(profileDir) || !isProfileLoggedIn(profileDir)) {
    isFirstTime = true;
    if (isProfileLoggedIn(MASTER_PROFILE_DIR)) {
      cloneProfile(MASTER_PROFILE_DIR, profileDir);
      isSeeded = true;
    } else {
      fs.mkdirSync(profileDir, { recursive: true });
    }
  }

  return {
    profileDir,
    isSeeded,
    isFirstTime
  };
}
