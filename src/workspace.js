import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Verify whether targetPath is strictly inside rootDir, guarding against
 * path traversal (../), absolute paths outside root, and symlink escapes.
 * Handles canonical realpath resolution across symlinked directories (e.g., macOS /var -> /private/var).
 */
export function isPathInsideRootDir(targetPath, rootDir = process.cwd()) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    const realRootDir = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);

    // Resolve relative paths against realRootDir; resolve absolute paths as-is
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(realRootDir, targetPath);

    // Canonicalize real target path, handling symlinks (e.g. macOS /var -> /private/var)
    let realTarget = resolvedPath;
    if (fs.existsSync(resolvedPath)) {
      realTarget = fs.realpathSync(resolvedPath);
    } else {
      let current = resolvedPath;
      let suffix = '';
      while (current && current !== path.dirname(current)) {
        if (fs.existsSync(current)) {
          realTarget = path.join(fs.realpathSync(current), suffix);
          break;
        }
        suffix = suffix ? path.join(path.basename(current), suffix) : path.basename(current);
        current = path.dirname(current);
      }
    }

    // Canonical containment check
    const rel = path.relative(realRootDir, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }

    // Symlink escape check: check realpath for every existing ancestor
    let current = realTarget;
    while (current && current !== realRootDir && current !== path.dirname(current)) {
      if (fs.existsSync(current)) {
        const realCurrent = fs.realpathSync(current);
        const currentRel = path.relative(realRootDir, realCurrent);
        if (currentRel.startsWith('..') || path.isAbsolute(currentRel)) {
          return false;
        }
      }
      current = path.dirname(current);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Applies a unified diff to original content string.
 */
export function applyUnifiedDiff(originalContent, diffContent) {
  const lines = originalContent.split(/\r?\n/);
  const diffLines = diffContent.split(/\r?\n/);
  const result = [];
  let origIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const targetOrigLine = parseInt(hunkMatch[1], 10) - 1;
      while (origIdx < targetOrigLine && origIdx < lines.length) {
        result.push(lines[origIdx++]);
      }
      continue;
    }

    if (line.startsWith('+')) {
      result.push(line.slice(1));
    } else if (line.startsWith('-')) {
      origIdx++;
    } else if (line.startsWith(' ') || line === '') {
      if (origIdx < lines.length) {
        result.push(lines[origIdx++]);
      }
    }
  }

  while (origIdx < lines.length) {
    result.push(lines[origIdx++]);
  }

  return result.join('\n');
}

/**
 * Applies an array of file change actions { filePath, content, language } to disk.
 */
export function applyFileChangesToDisk(fileActions, rootDir = process.cwd()) {
  const applied = [];
  const skipped = [];

  for (const action of fileActions) {
    if (!action.filePath) {
      skipped.push({ ...action, reason: 'Empty file path' });
      continue;
    }

    if (!isPathInsideRootDir(action.filePath, rootDir)) {
      skipped.push({ ...action, reason: 'Access denied: Path resides outside workspace root' });
      continue;
    }

    const fullPath = path.resolve(rootDir, action.filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = action.content ?? action.code ?? '';
    let finalContent = content;
    const isDiff = (action.language === 'diff' || content.includes('@@ -')) &&
                   content.includes('--- ') && content.includes('+++ ');

    if (isDiff && fs.existsSync(fullPath)) {
      try {
        const orig = fs.readFileSync(fullPath, 'utf8');
        finalContent = applyUnifiedDiff(orig, content);
      } catch {
        // fallback to writing content directly if diff patch fails
      }
    }

    fs.writeFileSync(fullPath, finalContent, 'utf8');
    applied.push({ filePath: action.filePath, fullPath, isDiff });
  }

  return { applied, skipped };
}

/**
 * Executes a shell command in the workspace root, capturing output.
 */
export function executeShellCommand(command, rootDir = process.cwd(), timeoutMs = 60000) {
  return new Promise((resolve) => {
    const rawCmd = (command || '').trim();
    // Sanitize any accidental leading/trailing '%' or backticks (e.g. from LLM prompt delimiters)
    // to prevent shell job control errors like "zsh:fg:1: no job control in this shell"
    const sanitizedCommand = rawCmd.replace(/^[%`\s]+|[%`\s]+$/g, '').trim();
    if (!sanitizedCommand) {
      resolve({
        ok: false,
        code: 1,
        stdout: '',
        stderr: 'Error: Empty command string after sanitization',
        command
      });
      return;
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    const child = spawn(shell, [process.platform === 'win32' ? '/c' : '-c', sanitizedCommand], {
      cwd: rootDir,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: stderr + '\n[Process timed out after ' + (timeoutMs / 1000) + 's]',
        command
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        command
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: err.message,
        command
      });
    });
  });
}

/**
 * Recursively scans workspace files for autocomplete.
 */
export function scanWorkspaceFiles(rootDir = process.cwd(), maxFiles = 500) {
  const results = [];
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.cache', 'vendor']);

  function walk(currentDir) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(rootDir, fullPath);
        results.push(relPath);
        if (results.length >= maxFiles) break;
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Formats a clean workspace file list for prompt context injection.
 */
export function formatWorkspaceTree(rootDir = process.cwd(), maxFiles = 200) {
  const files = scanWorkspaceFiles(rootDir, maxFiles + 1);
  const truncated = files.length > maxFiles;
  const list = truncated ? files.slice(0, maxFiles) : files;
  let text = list.map((f) => `- ${f}`).join('\n');
  if (truncated) {
    text += `\n... (${files.length} files total, truncated to first ${maxFiles})`;
  }
  return text || '(empty workspace)';
}

/**
 * Reads a workspace file securely within the root directory.
 */
export function readFileFromDisk(filePath, rootDir = process.cwd(), maxBytes = 2 * 1024 * 1024) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }
  const fullPath = path.resolve(rootDir, filePath);
  if (!isPathInsideRootDir(fullPath, rootDir)) {
    throw new Error('Access denied: Path is outside workspace root');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds maximum size limit of ${Math.round(maxBytes / 1024 / 1024)}MB`);
  }
  return {
    filePath: path.relative(rootDir, fullPath),
    content: fs.readFileSync(fullPath, 'utf8'),
    size: stat.size
  };
}
