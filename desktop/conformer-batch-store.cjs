'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { assert } = require('./security.cjs');
const { identity, failure } = require('./portable-storage.cjs');
const { contentHash, recoveryIds } = require('./conformer-recovery-store.cjs');
const idPattern = /^cb-[a-f0-9]{32}$/;
const recordPattern = /^(?:manifest|input-hashes|input-\d+|result-\d+)\.json$/;
const memberPattern = /^(?:manifest|input-hashes|input-\d+|result-\d+)\.json(?:\.next(?:-[a-f0-9-]{36})?)?$/;
const sharingBackoffMs = [15, 35, 75, 150];

/** Private canonical records. No renderer path is accepted and every operation
 * checks directory/file identity before touching an owned record. */
function createConformerBatchStore({ root, io = fs }) {
  assert(path.isAbsolute(root), 'Absolute private conformer batch root required');
  root = path.resolve(root);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  async function directory(target) {
    const stat = await io.lstat(target);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && same(await io.realpath(target), target), 'Batch directory identity changed');
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');
  }
  function location(id) { assert(idPattern.test(id), 'Invalid conformer batch handle'); return path.join(root, id); }
  function recordName(name) { assert(recordPattern.test(name), 'Invalid batch record'); return name; }
  function regularIdentity(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('PORTABLE_PATH_CHANGED', 'Batch record identity changed');
    return [identity(stat), stat.mode, stat.uid, stat.gid].join(':');
  }
  async function currentRecord(file) {
    try { return regularIdentity(await io.lstat(file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
  }
  function sharingConflict(error, temp, file) {
    return process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code) && error.syscall === 'rename'
      && typeof error.path === 'string' && same(error.path, temp) && typeof error.dest === 'string' && same(error.dest, file);
  }
  async function write(id, name, value, bytes = Buffer.from(JSON.stringify(value) + '\n')) {
    const dir = location(id), rootIdentity = await directory(root), batchIdentity = await directory(dir);
    recordName(name);
    const file = path.join(dir, name), temp = file + '.next-' + randomUUID();
    const previous = await currentRecord(file);
    // Keep the unpublished draft for diagnosis. A later real publication gets
    // its own temporary file, so it cannot hide the original I/O failure.
    const handle = await io.open(temp, 'wx');
    let written;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      written = regularIdentity(await handle.stat());
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    await handle.close();
    let firstFailure;
    for (let attempt = 0; ; attempt++) {
      if (await directory(root) !== rootIdentity || await directory(dir) !== batchIdentity ||
        await currentRecord(file) !== previous || await currentRecord(temp) !== written)
        throw failure('PORTABLE_PATH_CHANGED', 'Batch publication directory or record identity changed');
      if (attempt > 0) {
        await io.access(dir, constants.W_OK);
        await io.access(temp, constants.W_OK);
        if (previous !== undefined) await io.access(file, constants.W_OK);
      }
      try { await io.rename(temp, file); break; }
      catch (error) {
        if (!sharingConflict(error, temp, file)) throw error;
        firstFailure ??= error;
        if (attempt === sharingBackoffMs.length) throw firstFailure;
        await delay(sharingBackoffMs[attempt]);
      }
    }
    return contentHash(bytes.subarray(0, bytes.length - 1));
  }
  async function read(id, name) {
    const dir = location(id); await directory(root); await directory(dir); recordName(name);
    const file = path.join(dir, name), before = await io.lstat(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'Invalid batch record identity');
    const handle = await io.open(file, 'r');
    let failure;
    try {
      const opened = await handle.stat(); assert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'Batch record changed during open');
      const bytes = await handle.readFile(); const after = await handle.stat(), current = await io.lstat(file);
      assert(bytes.length === before.size && after.mtimeMs === opened.mtimeMs && after.size === opened.size && current.dev === opened.dev && current.ino === opened.ino && !current.isSymbolicLink(), 'Batch record changed during read');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) { failure = error; throw error; }
    finally {
      if (failure) await handle.close().catch(() => {});
      else await handle.close();
    }
  }
  async function create(id, manifest) { await io.mkdir(root, { recursive: true }); await directory(root); const dir = location(id); await io.mkdir(dir); await directory(dir); await write(id, 'manifest.json', manifest); }
  async function destroy(id) {
    const dir = location(id); await directory(root); await directory(dir);
    const names = await io.readdir(dir);
    // Exact owned files only; unexpected files/links retain the directory.
    assert(names.every(name => memberPattern.test(name)), 'Unexpected batch member; retained');
    const files = [];
    for (const name of names) { const file = path.join(dir, name), stat = await io.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Batch member identity changed; retained'); files.push(file); }
    for (const file of files) {
      await directory(dir);
      try { await io.unlink(file); }
      catch (error) {
        throw Object.assign(Error('已接管结果的后台批文件暂未清理：' + String(error.message)), {
          code: 'CONFORMER_BATCH_CLEANUP_FAILED', cause: error,
        });
      }
    }
    try { await io.rmdir(dir); }
    catch (error) {
      throw Object.assign(Error('已接管结果的后台批目录暂未清理：' + String(error.message)), {
        code: 'CONFORMER_BATCH_CLEANUP_FAILED', cause: error,
      });
    }
  }
  return { create, read, write, destroy, list: () => recoveryIds(io, root, idPattern) };
}
module.exports = { createConformerBatchStore };
