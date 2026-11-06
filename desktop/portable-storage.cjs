'use strict';
const nativeFS = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const parentToken = (real, stat) => `${real}:${stat.dev}:${stat.ino}`;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function classifyStorageError(error) {
  if (error?.portableStartupFailure) return { code: error.portableStartupFailure.rawCode || error.code || 'PORTABLE_STARTUP_FAILED', ...error.portableStartupFailure, retryable: true, preserved: true };
  const code = error?.code ?? '';
  if (error?.publicationPerformed === true) return { code: 'STORAGE_CONFIRMATION_FAILED', message: '写入操作已提交，但后续确认失败；未报告保存成功，请重新读取目标文件。', retryable: false, preserved: false, publicationPerformed: true };
  if (code === 'ENOSPC' || code === 'EDQUOT') return { code: 'STORAGE_FULL', message: '磁盘空间不足；未保存，请选择有空间的可写目录。', retryable: true, preserved: true };
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return { code: 'STORAGE_READ_ONLY', message: '目录只读或没有写权限；未保存，原数据已保留。', retryable: true, preserved: true };
  if (['ENOENT', 'ENODEV', 'EIO'].includes(code)) return { code: 'STORAGE_UNAVAILABLE', message: '存储位置不可用或介质已断开；未保存，请恢复磁盘或另存。', retryable: true, preserved: true };
  if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'PORTABLE_FILESYSTEM_UNSUPPORTED'].includes(code)) return { code: 'PORTABLE_FILESYSTEM_UNSUPPORTED', message: '此目录不支持当前安全保存方式；未保存，请改用支持的文件系统。', retryable: false, preserved: true };
  if (code === 'PORTABLE_PATH_CHANGED') return { code, message: '目录或文件身份已变化；已停止操作，请重新读取。', retryable: true, preserved: true };
  return { code: code || 'PORTABLE_OPERATION_FAILED', message: error?.message || '操作失败；原数据已保留。', retryable: false, preserved: true };
}
async function directoryIdentity(directory, fs = nativeFS) {
  const absolute = path.resolve(directory);
  for (let current = absolute;; current = path.dirname(current)) { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('PORTABLE_PATH_CHANGED', 'Directory links/replacement forbidden'); if (path.dirname(current) === current) break; }
  return parentToken(await fs.realpath(absolute), await fs.lstat(absolute));
}
async function checkDirectory(directory, expected, fs = nativeFS) { if (await directoryIdentity(directory, fs) !== expected) throw failure('PORTABLE_PATH_CHANGED', 'Portable directory identity changed'); }
async function checkWritable(directory, expected, fs = nativeFS) {
  await checkDirectory(directory, expected, fs); const file = path.join(directory, `.portable-write-probe-${randomUUID()}.tmp`); let owned;
  try { const handle = await fs.open(file, 'wx'); const stat = await handle.stat(); owned = `${stat.dev}:${stat.ino}`; try { await handle.writeFile('portable'); await handle.sync(); } finally { await handle.close(); } await checkDirectory(directory, expected, fs); return true; }
  // eslint-disable-next-line no-unsafe-finally -- A replaced owned probe must veto success and leave the foreign file untouched.
  finally { if (owned) { const stat = await fs.lstat(file); if (stat.isFile() && !stat.isSymbolicLink() && `${stat.dev}:${stat.ino}` === owned) { await checkDirectory(directory, expected, fs); await fs.unlink(file); } else throw failure('PORTABLE_PATH_CHANGED', 'Writable probe replaced'); } }
}
async function readChecked(file, limit = 2 * 1024 * 1024, fs = nativeFS) {
  const parent = await directoryIdentity(path.dirname(file), fs), selected = await fs.lstat(file);
  if (!selected.isFile() || selected.isSymbolicLink() || selected.size > limit) throw failure('PORTABLE_INVALID_FILE', 'Invalid selected file or size');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat(); if (identity(opened) !== identity(selected)) throw failure('PORTABLE_PATH_CHANGED', 'Selected file changed before read');
    const bytes = await handle.readFile(); if (bytes.length > limit || identity(opened) !== identity(await fs.lstat(file))) throw failure('PORTABLE_PATH_CHANGED', 'Selected file changed during read');
    await checkDirectory(path.dirname(file), parent, fs); return { path: file, bytes, sha256: hash(bytes), identity: identity(selected), parent };
  } finally { await handle.close(); }
}
async function currentFile(file, fs = nativeFS, limit = 2 * 1024 * 1024) { try { return await readChecked(file, limit, fs); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function sameFile(file, expected, fs = nativeFS, limit = 2 * 1024 * 1024) {
  const current = await currentFile(file, fs, limit); if ((!current) !== (!expected) || (current && (current.identity !== expected.identity || current.sha256 !== expected.sha256))) throw failure('PORTABLE_PATH_CHANGED', 'File identity changed; re-preview required'); return current;
}
async function atomicWrite(file, bytes, expected, parent, fs = nativeFS, limit = 2 * 1024 * 1024) {
  if (!Number.isSafeInteger(limit) || limit < 1 || bytes.length > limit) throw failure('PORTABLE_INVALID_FILE', 'Invalid publication size');
  await checkDirectory(path.dirname(file), parent, fs); await sameFile(file, expected, fs, limit);
  const temporary = path.join(path.dirname(file), `.portable-${randomUUID()}.tmp`); let owned, writtenIdentity, primaryFailure, publicationPerformed = false;
  try {
    const handle = await fs.open(temporary, 'wx'); const stat = await handle.stat(); owned = `${stat.dev}:${stat.ino}`;
    try { await handle.writeFile(bytes); await handle.sync(); writtenIdentity = identity(await handle.stat()); } finally { await handle.close(); }
    await checkDirectory(path.dirname(file), parent, fs); await sameFile(file, expected, fs, limit);
    const ready = await fs.lstat(temporary); if (!ready.isFile() || ready.isSymbolicLink() || identity(ready) !== writtenIdentity) throw failure('PORTABLE_PATH_CHANGED', 'Owned temporary file changed before publish');
    if (expected) { await fs.rename(temporary, file); publicationPerformed = true; } else { await fs.link(temporary, file); publicationPerformed = true; await fs.unlink(temporary); } owned = undefined;
    const saved = await readChecked(file, limit, fs); if (saved.sha256 !== hash(bytes)) throw failure('PORTABLE_PATH_CHANGED', 'Saved file changed after publish'); return saved;
  } catch (error) {
    if (publicationPerformed) error.publicationPerformed = true;
    primaryFailure = error;
    throw error;
  } finally {
    if (owned) { try { const stat = await fs.lstat(temporary); if (stat.isFile() && !stat.isSymbolicLink() && await directoryIdentity(path.dirname(file), fs) === parent && `${stat.dev}:${stat.ino}` === owned) await fs.unlink(temporary); } catch (error) {
      if (error.code !== 'ENOENT') {
        if (primaryFailure) primaryFailure.temporaryCleanupFailed = true;
        // eslint-disable-next-line no-unsafe-finally -- Cleanup failure must veto success only when no primary error already owns the failure.
        else { if (publicationPerformed) error.publicationPerformed = true; error.temporaryCleanupFailed = true; throw error; }
      }
    } }
  }
}
async function inventory(directory, expected, { fs = nativeFS, maxFiles = 10000, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  await checkDirectory(directory, expected, fs); const files = [], directories = []; let bytes = 0;
  async function walk(current) {
    const token = await directoryIdentity(current, fs); directories.push({ path: current, identity: token });
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name), stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw failure('PORTABLE_PATH_CHANGED', 'Linked cache/data entry forbidden');
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile()) { if (stat.nlink > 1) throw failure('PORTABLE_LINKED_FILE', 'Hardlinked mutable file forbidden'); bytes += stat.size; if (files.length >= maxFiles || bytes > maxBytes) throw failure('PORTABLE_INVENTORY_LIMIT', 'Portable inventory exceeds bounded limit'); files.push({ path: target, identity: identity(stat), bytes: stat.size }); }
      else throw failure('PORTABLE_INVALID_FILE', 'Non-regular portable entry forbidden');
    }
    await checkDirectory(current, token, fs);
  }
  await walk(directory); await checkDirectory(directory, expected, fs); return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories, bytes };
}
module.exports = { hash, identity, failure, classifyStorageError, directoryIdentity, checkDirectory, checkWritable, readChecked, currentFile, sameFile, atomicWrite, inventory };
