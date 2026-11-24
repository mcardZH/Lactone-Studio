'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { checkDirectory, directoryIdentity, identity } = require('./portable-storage.cjs');

const fileKey = stat => `${stat.dev}:${stat.ino}`;
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Renderer-visible handles refer only to owned files. The file itself backs
 * prepared ranges, so neither process needs to assemble the entire asset. */
function createBinaryAssetStore({ root, ownerAlive, ready = async () => {}, io = fs }) {
  const entries = new Map();
  let directory, disposed = false;

  function active(owner) {
    assert(!disposed, 'BINARY_ASSET_CLOSED: 资源存储已关闭。');
    ownerAlive(owner);
  }
  function lookup(owner, id) {
    const entry = entries.get(id);
    assert(entry?.owner === owner, 'BINARY_ASSET_OWNER: 资源已释放或属于其他窗口。');
    return entry;
  }
  function serial(entry, work) {
    const result = entry.queue.then(work);
    entry.queue = result.catch(() => {});
    return result;
  }
  async function checkFile(entry) {
    await checkDirectory(path.dirname(entry.path), entry.parent, io);
    const stat = await io.lstat(entry.path);
    assert(stat.isFile() && !stat.isSymbolicLink() && fileKey(stat) === entry.key,
      'BINARY_ASSET_CHANGED: 二进制资源文件已变化。');
    return stat;
  }
  async function unlinkOwned(entry) {
    try { await checkFile(entry); await io.unlink(entry.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function release(entry) {
    return entry.closing ??= serial(entry, async () => {
      if (entry.handle) { await entry.handle.close(); entry.handle = null; }
      await entry.disposeFile?.();
      if (entries.get(entry.id) === entry) entries.delete(entry.id);
    }).catch(error => { entry.closing = undefined; throw error; });
  }
  function use(entry) {
    assert(entry.handle && !entry.closing && !entry.transferred, 'BINARY_ASSET_CLOSED: 二进制资源已关闭。');
    return entry.handle;
  }
  async function add(owner, file, parent, writable, expectedBytes, disposeFile) {
    active(owner);
    const id = randomUUID();
    const before = writable ? undefined : await io.lstat(file);
    assert(writable || before?.isFile() && !before.isSymbolicLink(), 'BINARY_ASSET_FILE: 二进制资源须为普通文件。');
    const handle = await io.open(file, writable ? 'wx+' : 'r');
    let entry;
    try {
      const stat = await handle.stat();
      entry = { id, owner, path: file, parent, key: fileKey(stat), handle, expectedBytes, size: stat.size,
        sealed: !writable, hash: writable ? createHash('sha256') : undefined, queue: Promise.resolve() };
      entry.disposeFile = writable ? () => unlinkOwned(entry) : disposeFile;
      active(owner);
      assert(stat.isFile() && (writable || fileKey(before) === entry.key && before.size === stat.size),
        'BINARY_ASSET_CHANGED: 二进制资源打开时已变化。');
      await checkDirectory(path.dirname(file), parent, io);
      active(owner);
      entries.set(id, entry);
      return entry;
    } catch (error) {
      await handle.close();
      if (writable && entry?.key) await unlinkOwned(entry);
      throw error;
    }
  }
  async function closeOwner(owner) {
    const results = await Promise.allSettled([...entries.values()].filter(entry => entry.owner === owner).map(release));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  function rootIdentity() {
    directory ??= ready().then(async () => {
      await io.mkdir(root, { recursive: true });
      return directoryIdentity(root, io);
    }).catch(error => { directory = undefined; throw error; });
    return directory;
  }

  return {
    async begin(owner, expectedBytes) {
      active(owner);
      assert(expectedBytes === undefined || count(expectedBytes), 'BINARY_ASSET_SIZE: 二进制资源长度无效。');
      const parent = await rootIdentity();
      const entry = await add(owner, path.join(root, `${randomUUID()}.bin`), parent, true, expectedBytes);
      return { id: entry.id };
    },
    append(owner, id, bytes) {
      active(owner);
      const entry = lookup(owner, id);
      assert(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer, 'BINARY_ASSET_CHUNK: 二进制分块无效。');
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return serial(entry, async () => {
        const handle = use(entry), size = entry.size + data.byteLength;
        assert(!entry.sealed && !entry.damaged && count(size) && (entry.expectedBytes === undefined || size <= entry.expectedBytes),
          'BINARY_ASSET_SIZE: 写入范围与声明的二进制资源不符。');
        let written = 0;
        try {
          while (written < data.byteLength) {
            const { bytesWritten } = await handle.write(data, written, data.byteLength - written, entry.size + written);
            assert(bytesWritten > 0, 'BINARY_ASSET_WRITE: 未完成二进制分块写入。');
            written += bytesWritten;
          }
          entry.hash.update(data);
          entry.size = size;
          return { size };
        } catch (error) {
          try { await handle.truncate(entry.size); } catch { entry.damaged = true; }
          throw error;
        }
      });
    },
    seal(owner, id) {
      active(owner);
      const entry = lookup(owner, id);
      return serial(entry, async () => {
        const handle = use(entry);
        assert(!entry.damaged && (entry.expectedBytes === undefined || entry.size === entry.expectedBytes),
          'BINARY_ASSET_INCOMPLETE: 二进制资源尚未写完。');
        if (!entry.sealed) {
          await handle.sync();
          const stat = await checkFile(entry);
          assert(stat.size === entry.size, 'BINARY_ASSET_CHANGED: 二进制资源长度已变化。');
          entry.sha256 = entry.hash.digest('hex');
          entry.hash = undefined;
          entry.sealed = true;
        }
        return { size: entry.size, sha256: entry.sha256 };
      });
    },
    read(owner, id, offset, length) {
      active(owner);
      const entry = lookup(owner, id);
      return serial(entry, async () => {
        const handle = use(entry);
        assert(count(offset) && count(length) && count(offset + length) && offset + length <= entry.size,
          'BINARY_ASSET_RANGE: 二进制读取范围尚未写入。');
        const buffer = new ArrayBuffer(length), data = new Uint8Array(buffer);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(data, read, length - read, offset + read);
          assert(bytesRead > 0, 'BINARY_ASSET_READ: 二进制资源提前结束。');
          read += bytesRead;
        }
        return buffer;
      });
    },
    async registerOwned(owner, file, { disposeFile, sha256 } = {}) {
      active(owner);
      assert(path.isAbsolute(file), 'BINARY_ASSET_FILE: 内部文件路径无效。');
      const parent = await directoryIdentity(path.dirname(file), io);
      const entry = await add(owner, file, parent, false, undefined, disposeFile);
      entry.sha256 = sha256;
      return { id: entry.id, bytesLength: entry.size };
    },
    async adoptVerifiedFile(owner, source) {
      active(owner);
      assert(path.isAbsolute(source.path) && count(source.bytesLength) && /^[a-f0-9]{64}$/.test(source.sha256),
        'BINARY_ASSET_FILE: 内部源文件凭据无效。');
      const parent = await rootIdentity(), target = path.join(root, `${randomUUID()}.bin`);
      await checkDirectory(path.dirname(source.path), source.parent, io);
      const original = await io.lstat(source.path);
      assert(original.isFile() && !original.isSymbolicLink() && original.nlink === 1 && identity(original) === source.identity && original.size === source.bytesLength,
        'BINARY_ASSET_CHANGED: 内部源文件接管前已变化。');
      await checkDirectory(root, parent, io);
      active(owner);
      await io.rename(source.path, target);
      // Adopt on the same task volume. Check the inode across rename, which
      // can itself change the file's ctime on some filesystems.
      const moved = await io.lstat(target);
      assert(moved.isFile() && !moved.isSymbolicLink() && fileKey(moved) === fileKey(original) && moved.size === original.size,
        'BINARY_ASSET_CHANGED: 内部源文件接管时已变化。');
      const entry = await add(owner, target, parent, false);
      entry.sha256 = source.sha256;
      entry.disposeFile = () => unlinkOwned(entry);
      return { id: entry.id, bytesLength: entry.size };
    },
    takeOwned(owner, id) {
      active(owner);
      const entry = lookup(owner, id);
      return serial(entry, async () => {
        const handle = use(entry);
        assert(entry.sealed, 'BINARY_ASSET_INCOMPLETE: 仅完整二进制资源可接管。');
        await checkFile(entry);
        active(owner);
        assert(!entry.closing, 'BINARY_ASSET_CLOSED: 接管资源的窗口已关闭。');
        await handle.close(); entry.handle = null;
        if (entry.closing) throw Error('BINARY_ASSET_CLOSED: 接管资源的窗口已关闭。');
        entry.transferred = true;
        entries.delete(id);
        return { path: entry.path, bytesLength: entry.size, sha256: entry.sha256, parent: entry.parent,
          close: () => release(entry) };
      });
    },
    async release(owner, id) {
      if (entries.has(id)) await release(lookup(owner, id));
    },
    closeOwner,
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...entries.values()].map(release));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

module.exports = { createBinaryAssetStore };
