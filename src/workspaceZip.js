import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

const MAX_WORKSPACE_ZIP_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB limit
// Core git internal directory (never part of workspace source tree)
const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git'
]);

// Archive files to prevent recursive archive packaging
const DEFAULT_EXCLUDE_EXTS = new Set([
  '.zip'
]);

// CRC-32 lookup table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

function calculateCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xFFFF;
  const dosDate = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  return ((dosDate << 16) | dosTime) >>> 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Convert a gitignore glob pattern to a RegExp
 */
function patternToRegex(pattern, isAnchored) {
  let regexStr = '';
  let i = 0;

  if (pattern.startsWith('**/')) {
    regexStr += '(?:.*/)?';
    i = 3;
    isAnchored = true;
  }

  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (char === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if (char === '[' && pattern.indexOf(']', i) !== -1) {
      const closeIdx = pattern.indexOf(']', i);
      const inner = pattern.slice(i + 1, closeIdx);
      regexStr += '[' + inner.replace(/\\/g, '\\\\') + ']';
      i = closeIdx + 1;
    } else if ('.+^$()|{}\\'.includes(char)) {
      regexStr += '\\' + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  if (isAnchored) {
    return new RegExp('^' + regexStr + '(?=$|/)');
  } else {
    return new RegExp('(?:^|/)' + regexStr + '(?=$|/)');
  }
}

/**
 * Matcher for .gitignore and .git/info/exclude rules
 */
class GitIgnoreMatcher {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
    this.rules = [];
    this.loadedFiles = new Set();
    this.loadRootRules();
  }

  loadRootRules() {
    // 1. .git/info/exclude (local repository excludes)
    const gitExcludePath = path.join(this.rootDir, '.git', 'info', 'exclude');
    if (fs.existsSync(gitExcludePath)) {
      this.addRulesFromFile(gitExcludePath, '');
    }

    // 2. root .gitignore
    const rootGitignorePath = path.join(this.rootDir, '.gitignore');
    if (fs.existsSync(rootGitignorePath)) {
      this.addRulesFromFile(rootGitignorePath, '');
    }
  }

  addRulesFromFile(filePath, baseRelDir = '') {
    if (this.loadedFiles.has(filePath)) return;
    this.loadedFiles.add(filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      this.addRulesFromContent(content, baseRelDir);
    } catch {}
  }

  addRulesFromContent(content, baseRelDir = '') {
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      let pattern = trimmed;
      let negated = false;
      if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1).trim();
      }

      let directoryOnly = false;
      if (pattern.endsWith('/')) {
        directoryOnly = true;
        pattern = pattern.slice(0, -1);
      }

      let isAnchored = false;
      if (pattern.startsWith('/')) {
        isAnchored = true;
        pattern = pattern.slice(1);
      } else if (pattern.includes('/')) {
        isAnchored = true;
      }

      // If rule comes from a subfolder, anchor it to baseRelDir
      if (baseRelDir) {
        pattern = path.posix.join(baseRelDir.replace(/\\/g, '/'), pattern);
        isAnchored = true;
      }

      try {
        const regex = patternToRegex(pattern, isAnchored);
        this.rules.push({
          pattern,
          regex,
          negated,
          directoryOnly
        });
      } catch {}
    }
  }

  /**
   * Check whether a given path is ignored
   * @param {string} relPath - Relative path from rootDir
   * @param {boolean} isDirectory - Whether the target is a directory
   * @returns {boolean} true if ignored
   */
  isIgnored(relPath, isDirectory = false) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return false;

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }

      if (rule.regex.test(normalized)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }
}

function scanDirectory(dir, rootDir, state, matcher, options = {}) {
  // If subfolder has its own .gitignore, load it scoped to this directory
  if (dir !== rootDir) {
    const subGitignore = path.join(dir, '.gitignore');
    if (fs.existsSync(subGitignore)) {
      const baseRelDir = path.relative(rootDir, dir);
      matcher.addRulesFromFile(subGitignore, baseRelDir);
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name) || matcher.isIgnored(relPath, true)) {
        continue;
      }
      scanDirectory(fullPath, rootDir, state, matcher, options);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (DEFAULT_EXCLUDE_EXTS.has(ext) || matcher.isIgnored(relPath, false)) {
        continue;
      }

      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch {
        continue;
      }

      state.totalSize += stats.size;
      if (state.totalSize > state.maxSizeBytes) {
        throw new Error(
          `Workspace size exceeds the 1GB limit (accumulated ${formatBytes(state.totalSize)}). Zip packaging prohibited.`
        );
      }

      state.files.push({
        fullPath,
        relativePath: relPath
      });
    }
  }
}

async function buildZipArchive(fileEntries, outputPath) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;
  const dosTime = getDosDateTime();

  for (const entry of fileEntries) {
    const rawName = entry.relativePath.replace(/\\/g, '/');
    const nameBuf = Buffer.from(rawName, 'utf8');

    let fileData;
    try {
      fileData = fs.readFileSync(entry.fullPath);
    } catch {
      continue;
    }

    const uncompressedSize = fileData.length;
    const crc = calculateCrc32(fileData);
    const compressedData = zlib.deflateRawSync(fileData, { level: 6 });
    const compressedSize = compressedData.length;

    // Local file header (30 bytes + nameBuf.length)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);          // Compression method (8 = Deflate)
    localHeader.writeUInt32LE(dosTime, 10);    // Last mod file time and date
    localHeader.writeUInt32LE(crc, 14);        // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);   // File name length
    localHeader.writeUInt16LE(0, 28);                // Extra field length

    localChunks.push(localHeader, nameBuf, compressedData);

    // Central directory header (46 bytes + nameBuf.length)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    cdHeader.writeUInt16LE(20, 4);         // Version made by (2.0)
    cdHeader.writeUInt16LE(20, 6);         // Version needed to extract (2.0)
    cdHeader.writeUInt16LE(0x0800, 8);     // General purpose bit flag (UTF-8)
    cdHeader.writeUInt16LE(8, 10);         // Compression method (8 = Deflate)
    cdHeader.writeUInt32LE(dosTime, 12);    // Last mod file time and date
    cdHeader.writeUInt32LE(crc, 16);        // CRC-32
    cdHeader.writeUInt32LE(compressedSize, 20);   // Compressed size
    cdHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    cdHeader.writeUInt16LE(nameBuf.length, 28);   // File name length
    cdHeader.writeUInt16LE(0, 30);                // Extra field length
    cdHeader.writeUInt16LE(0, 32);                // File comment length
    cdHeader.writeUInt16LE(0, 34);                // Disk number start
    cdHeader.writeUInt16LE(0, 36);                // Internal file attributes
    cdHeader.writeUInt32LE(0, 38);                // External file attributes
    cdHeader.writeUInt32LE(offset, 42);           // Relative offset of local header

    cdChunks.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressedData.length;
  }

  const centralDirSize = cdChunks.reduce((acc, c) => acc + c.length, 0);
  const centralDirOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk where central directory starts
  eocd.writeUInt16LE(fileEntries.length, 8);  // Number of central directory records on this disk
  eocd.writeUInt16LE(fileEntries.length, 10); // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);     // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);   // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                  // ZIP file comment length

  const fullArchive = Buffer.concat([...localChunks, ...cdChunks, eocd]);
  fs.writeFileSync(outputPath, fullArchive);

  return {
    path: outputPath,
    size: fullArchive.length,
    fileCount: fileEntries.length
  };
}

async function createCliWorkspaceZip(rootDir = process.cwd(), options = {}) {
  const maxSizeBytes = options.maxSizeBytes || MAX_WORKSPACE_ZIP_SIZE_BYTES;
  const state = {
    totalSize: 0,
    maxSizeBytes,
    files: []
  };

  const matcher = new GitIgnoreMatcher(rootDir);

  scanDirectory(rootDir, rootDir, state, matcher, options);

  if (!state.files.length) {
    throw new Error('No files found in workspace to package into zip.');
  }

  const wsName = path.basename(rootDir).replace(/[^a-zA-Z0-9_-]/g, '_') || 'workspace';
  const zipName = `${wsName}.zip`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ws-'));
  const tmpPath = path.join(tmpDir, zipName);

  const result = await buildZipArchive(state.files, tmpPath);

  return {
    zipPath: result.path,
    zipSize: result.size,
    totalUncompressedSize: state.totalSize,
    fileCount: result.fileCount,
    zipName
  };
}

export {
  MAX_WORKSPACE_ZIP_SIZE_BYTES,
  formatBytes,
  buildZipArchive,
  createCliWorkspaceZip,
  GitIgnoreMatcher
};
