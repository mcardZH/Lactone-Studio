'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');
const { checkDirectory, directoryIdentity, identity } = require('./portable-storage.cjs');

const inode = stat => `${stat.dev}:${stat.ino}`;

async function describeFile(file) {
  const parent = await directoryIdentity(path.dirname(file));
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'STREAM_FILE_CHANGED: 路径已经变化。');
  return { path:file, parent, identity:identity(stat), bytesLength:stat.size };
}

async function* fileChunks(source) {
  await checkDirectory(path.dirname(source.path), source.parent);
  const current = await fs.lstat(source.path);
  assert(current.isFile() && !current.isSymbolicLink() && identity(current) === source.identity,
    'STREAM_FILE_CHANGED: 读取前文件已经变化。');
  const handle = await fs.open(source.path, 'r');
  try {
    assert(identity(await handle.stat()) === source.identity, 'STREAM_FILE_CHANGED: 文件已被替换。');
    yield* handle.createReadStream({ autoClose:false, highWaterMark:1024 * 1024 });
    assert(identity(await handle.stat()) === source.identity && identity(await fs.lstat(source.path)) === source.identity,
      'STREAM_FILE_CHANGED: 读取期间文件已经变化。');
    await checkDirectory(path.dirname(source.path), source.parent);
  } finally { await handle.close(); }
}

async function inspectStreamFile(file) {
  const description = await describeFile(file), hash = createHash('sha256');
  let size = 0;
  for await (const bytes of fileChunks(description)) { hash.update(bytes); size += bytes.byteLength; }
  assert(size === description.bytesLength, 'STREAM_FILE_CHANGED: 读取期间文件长度已经变化。');
  return { ...description, sha256:hash.digest('hex') };
}
async function currentStreamFile(file) {
  try { return await inspectStreamFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Stage and verify a complete stream before changing the user-selected file. */
async function atomicWriteStream(file, source, previous, parent) {
  await checkDirectory(path.dirname(file), parent);
  const temporary = path.join(path.dirname(file), `.es-stream-${randomUUID()}.tmp`);
  let owned, published = false, failure;
  try {
    const handle = await fs.open(temporary, 'wx'), hash = createHash('sha256');
    let size = 0;
    try {
      owned = inode(await handle.stat());
      for await (const chunk of source.chunks) {
        for (let offset = 0; offset < chunk.byteLength;) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          assert(bytesWritten > 0, 'STREAM_FILE_WRITE: 文件写入未完成。');
          offset += bytesWritten;
        }
        hash.update(chunk); size += chunk.byteLength;
      }
      await handle.sync();
    } finally { await handle.close(); }
    const digest = hash.digest('hex');
    assert((source.sha256 === undefined || digest === source.sha256) && size === source.bytesLength,
      'STREAM_FILE_CHANGED: 源文件校验失败。');
    const prepared = await inspectStreamFile(temporary);
    assert(prepared.sha256 === digest && prepared.bytesLength === size && inode(await fs.lstat(temporary)) === owned,
      'STREAM_FILE_WRITE: 暂存文件的字节校验失败。');
    const existing = await currentStreamFile(file);
    assert(previous === null ? existing === null : existing && existing.identity === previous.identity && existing.sha256 === previous.sha256,
      'STREAM_FILE_CHANGED: 导出目标已经变化，原文件已保留。');
    await checkDirectory(path.dirname(file), parent);
    if (previous) { await fs.rename(temporary, file); published = true; }
    else { await fs.link(temporary, file); published = true; await fs.unlink(temporary); }
    owned = undefined;
    return { bytesLength:size, sha256:digest };
  } catch (error) { failure = error; if (published) error.publicationPerformed = true; throw error; }
  finally {
    if (owned) try {
      await checkDirectory(path.dirname(file), parent);
      const stat = await fs.lstat(temporary);
      if (stat.isFile() && !stat.isSymbolicLink() && inode(stat) === owned) await fs.unlink(temporary);
    } catch (error) { if (error.code !== 'ENOENT' && failure) failure.temporaryCleanupFailed = true; }
  }
}

module.exports = { describeFile, fileChunks, currentStreamFile, atomicWriteStream };
