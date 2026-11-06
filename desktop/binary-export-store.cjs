'use strict';
const nativeFS = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { directoryIdentity, checkDirectory } = require('./portable-storage.cjs');
const { assert, plain } = require('./security.cjs');
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const inode = stat => [stat.dev, stat.ino].join(':');
async function fileIdentity(file, fs, retainedHandles) {
  let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert(stat.isFile() && !stat.isSymbolicLink(), 'EXPORT_PATH_CHANGED: 导出目标不是普通文件。');
  const handle = await fs.open(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024); let failure;
  retainedHandles.add(handle);
  try {
    assert(signature(await handle.stat()) === signature(stat), 'EXPORT_PATH_CHANGED: 文件已变化。');
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    assert(signature(await handle.stat()) === signature(stat) && signature(await fs.lstat(file)) === signature(stat), 'EXPORT_PATH_CHANGED: 读取期间文件已变化。');
    return { signature: signature(stat), hash: hash.digest('hex'), bytes: stat.size };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await handle.close(); retainedHandles.delete(handle); }
    catch (error) {
      try { await handle.close(); retainedHandles.delete(handle); } catch { if (failure) failure.readHandleCleanupFailed = true; }
      // eslint-disable-next-line no-unsafe-finally -- Preserve the read error; a sole close failure must veto a successful identity check.
      if (!failure) throw error;
    }
  }
}
function createBinaryExportStore({ chooseDestination, assertDestination, ownerAlive, fs = nativeFS }) {
  const entries = new Map(), closedOwners = new Set(), readHandles = new Map(); let disposed = false;
  function readers(owner) { if (!readHandles.has(owner)) readHandles.set(owner, new Set()); return readHandles.get(owner); }
  const checkParent = entry => checkDirectory(path.dirname(entry.target), entry.parent, fs);
  function alive(owner) { assert(!disposed && !closedOwners.has(owner), 'EXPORT_CLOSED: 导出窗口已关闭。'); ownerAlive(owner); }
  function find(owner, token) { const entry = entries.get(token); assert(entry && entry.owner === owner, 'EXPORT_OWNER: 导出操作已关闭或属于其他窗口。'); return entry; }
  function active(entry) { alive(entry.owner); assert(entries.get(entry.token) === entry && !entry.closed && entry.handle, 'EXPORT_CLOSED: 导出操作已关闭。'); }
  function serial(entry, operation) { const next = entry.queue.then(operation); entry.queue = next.catch(() => {}); return next; }
  async function clean(entry) {
    // Retain a failed-close handle and entry so abort/disposal can release it.
    if (entry.handle) { await entry.handle.close(); entry.handle = null; }
    if (entry.owned) {
      try {
        const stat = await fs.lstat(entry.temporary);
        if (stat.isFile() && !stat.isSymbolicLink() && inode(stat) === entry.owned) { await checkParent(entry); await fs.unlink(entry.temporary); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    entries.delete(entry.token);
  }
  async function finish(entry, failure, published = false) {
    entry.closed = true;
    try { await clean(entry); }
    catch (error) {
      if (failure) failure.temporaryCleanupFailed = true;
      else { if (published) error.publicationPerformed = true; error.temporaryCleanupFailed = true; throw error; }
    }
  }
  async function disposeOwner(owner) {
    // Seal synchronously, before waiting for queued preparation/append/commit.
    closedOwners.add(owner);
    const owned = [...entries.values()].filter(entry => entry.owner === owner);
    for (const entry of owned) entry.closed = true;
    const results = await Promise.allSettled(owned.map(entry => serial(entry, () => finish(entry))));
    const handles = readers(owner);
    const closed = await Promise.allSettled([...handles].map(async handle => { await handle.close(); handles.delete(handle); }));
    if (!handles.size) readHandles.delete(owner);
    const failed = [...results, ...closed].find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
  return {
    async begin(owner, request) {
      assert(plain(request) && Object.keys(request).every(key => ['name', 'extension'].includes(key)) && typeof request.name === 'string' && request.name.length > 0 && request.name.length < 256 && !/[\\/\x00-\x1f]/.test(request.name) && typeof request.extension === 'string' && /^[a-z0-9]{1,12}$/i.test(request.extension), 'EXPORT_REQUEST: 导出名称无效。');
      alive(owner); const chosen = await chooseDestination(owner, request); alive(owner); if (!chosen) return null;
      assert(plain(chosen) && typeof chosen.path === 'string' && path.isAbsolute(chosen.path), 'EXPORT_REQUEST: 导出目标无效。');
      const target = path.resolve(chosen.path); assertDestination(target);
      const parent = await directoryIdentity(path.dirname(target), fs), expected = await fileIdentity(target, fs, readers(owner));
      assert(!expected || chosen.overwriteConfirmed === true, 'EXPORT_OVERWRITE: 未确认覆盖目标文件。');
      await checkDirectory(path.dirname(target), parent, fs); alive(owner);
      const token = randomUUID(), temporary = path.join(path.dirname(target), '.es-export-' + token + '.tmp');
      const entry = { owner, token, target, parent, expected, temporary, handle: null, owned: null, bytes: 0, hash: createHash('sha256'), queue: Promise.resolve(), closed: false };
      entries.set(token, entry);
      return serial(entry, async () => {
        try {
          alive(owner); entry.handle = await fs.open(temporary, 'wx'); entry.owned = inode(await entry.handle.stat());
          active(entry); return { token };
        } catch (error) { await finish(entry, error); throw error; }
      });
    },
    append(owner, token, bytes) {
      const entry = find(owner, token);
      assert(bytes instanceof Uint8Array && bytes.byteLength <= 8 * 1024 ** 2, 'EXPORT_CHUNK: 导出传输块无效。');
      return serial(entry, async () => {
        try {
          active(entry); await checkParent(entry);
          const stat = await fs.lstat(entry.temporary);
          assert(stat.isFile() && !stat.isSymbolicLink() && inode(await entry.handle.stat()) === entry.owned && inode(stat) === entry.owned, 'EXPORT_PATH_CHANGED: 临时文件已变化。');
          let offset = 0;
          while (offset < bytes.length) {
            active(entry); const result = await entry.handle.write(bytes, offset, bytes.length - offset, null);
            assert(Number.isInteger(result.bytesWritten) && result.bytesWritten > 0 && result.bytesWritten <= bytes.length - offset, 'EXPORT_WRITE: 磁盘未正确写入数据。'); offset += result.bytesWritten; active(entry);
          }
          entry.hash.update(bytes); entry.bytes += bytes.length; assert(Number.isSafeInteger(entry.bytes), 'EXPORT_SIZE: 文件尺寸无法准确表示。');
        } catch (error) { await finish(entry, error); throw error; }
      });
    },
    commit(owner, token) {
      const entry = find(owner, token);
      return serial(entry, async () => {
        let published = false, failure;
        try {
          active(entry); await entry.handle.sync(); await entry.handle.close(); entry.handle = null;
          await checkParent(entry); assertDestination(entry.target);
          const current = await fileIdentity(entry.target, fs, readers(owner));
          assert(JSON.stringify(current) === JSON.stringify(entry.expected), 'EXPORT_PATH_CHANGED: 导出目标已变化，原文件已保留。');
          const ready = await fileIdentity(entry.temporary, fs, readers(owner)), digest = entry.hash.digest('hex');
          assert(ready?.bytes === entry.bytes && ready.hash === digest && inode(await fs.lstat(entry.temporary)) === entry.owned, 'EXPORT_PATH_CHANGED: 临时输出校验失败。');
          await checkParent(entry); alive(owner); assert(!entry.closed, 'EXPORT_CLOSED: 导出操作已关闭。');
          if (entry.expected) await fs.rename(entry.temporary, entry.target);
          else await fs.link(entry.temporary, entry.target);
          published = true;
          const saved = await fileIdentity(entry.target, fs, readers(owner));
          assert(saved?.bytes === entry.bytes && saved.hash === digest, 'EXPORT_VERIFY: 写入后文件校验失败。');
          return { written: true, bytes: entry.bytes };
        } catch (error) { failure = error; if (published) error.publicationPerformed = true; throw error; }
        finally { await finish(entry, failure, published); }
      });
    },
    abort(owner, token) { const entry = entries.get(token); if (!entry) return Promise.resolve(); assert(entry.owner === owner, 'EXPORT_OWNER: 导出操作属于其他窗口。'); entry.closed = true; return serial(entry, () => finish(entry)); },
    disposeOwner,
    async dispose() { disposed = true; const results = await Promise.allSettled([...new Set([...entries.values()].map(entry => entry.owner).concat([...readHandles.keys()]))].map(disposeOwner)); const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason; },
    size: () => entries.size,
  };
}
module.exports = { createBinaryExportStore };
