'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert, string } = require('./security.cjs');
// Compatibility exports describe addressable sizes, not an import budget.
const MAX_MODEL_FILE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_STREAM_FILE_BYTES = Number.MAX_SAFE_INTEGER;
const FILE_CHUNK_BYTES = 256 * 1024;
const FILE_STREAM_IDLE_MS = 120_000;
const STREAM_EXTENSIONS = new Set(['.log', '.out', '.fch', '.fchk']);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function createFileReader({ now = Date.now } = {}) {
  const streams = new Map();
  async function release(token) {
    const item = streams.get(token);
    if (!item) return false;
    streams.delete(token);
    await item.handle.close();
    return true;
  }
  async function verify(item) {
    const [handleStat, selectedStat] = await Promise.all([item.handle.stat(), fs.lstat(item.path)]);
    assert(selectedStat.isFile() && !selectedStat.isSymbolicLink() && identity(handleStat) === item.identity && identity(selectedStat) === item.identity,
      'FILE_CHANGED: 选中文件已改变，请重新选择。');
  }
  async function expire() {
    await Promise.all([...streams].filter(([, item]) => item.expires < now()).map(([token]) => release(token)));
  }
  async function openOne(owner, filePath) {
    const handle = await fs.open(filePath, 'r');
    let retained = false;
    try {
      const [stat, selected] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
      assert(stat.isFile() && selected.isFile() && !selected.isSymbolicLink() && identity(stat) === identity(selected), 'Selected file must be an unchanged regular file');
      const metadata = { name: path.basename(filePath), path: filePath, bytes: stat.size };
      if (!STREAM_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && stat.size <= FILE_CHUNK_BYTES) {
        const bytes = await handle.readFile();
        const item = { handle, path: filePath, identity: identity(stat) };
        await verify(item);
        assert(bytes.length === stat.size, 'FILE_CHANGED: 文件大小在读取时改变，请重新选择。');
        return { ...metadata, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      }
      assert(Number.isSafeInteger(stat.size) && stat.size >= 0, '文件大小无法安全表示。');
      await expire();
      const token = randomUUID();
      streams.set(token, { owner, handle, path: filePath, identity: identity(stat), size: stat.size,
                           offset: 0, busy: false, expires: now() + FILE_STREAM_IDLE_MS });
      retained = true;
      return { ...metadata, streamToken: token };
    } finally { if (!retained) await handle.close(); }
  }
  async function openFiles(owner, paths) {
    assert(Array.isArray(paths), 'Selected files must be an array');
    const opened = [];
    try { for (const filePath of paths) opened.push(await openOne(owner, filePath)); return opened; }
    catch (error) { await Promise.all(opened.filter(file => file.streamToken).map(file => release(file.streamToken))); throw error; }
  }
  async function readChunk(owner, token, offset) {
    assert(string(token, 100) && Number.isSafeInteger(offset) && offset >= 0, 'Invalid file stream request');
    const item = streams.get(token);
    assert(item && item.owner === owner, 'FILE_STREAM_UNAVAILABLE: 文件流已结束或不属于本窗口。');
    if (item.expires < now()) { await release(token); throw new Error('FILE_STREAM_EXPIRED: 文件流已过期，请重新选择。'); }
    assert(!item.busy && offset === item.offset, 'FILE_STREAM_ORDER: 文件块必须按顺序读取，不能并发或重放。');
    item.busy = true;
    let finished;
    item.finished = new Promise(resolve => { finished = resolve; });
    try {
      await verify(item);
      const buffer = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, item.size - offset));
      const { bytesRead } = await item.handle.read(buffer, 0, buffer.length, offset);
      await verify(item);
      assert(bytesRead === buffer.length, 'FILE_CHANGED: 文件在分块读取时截断，请重新选择。');
      item.offset += bytesRead;
      item.expires = now() + FILE_STREAM_IDLE_MS;
      const done = item.offset === item.size;
      const result = { bytes: new Uint8Array(buffer), offset, nextOffset: item.offset, done };
      if (done) await release(token);
      return result;
    } catch (error) { await release(token); throw error; }
    finally { item.busy = false; finished(); }
  }
  async function closeStream(owner, token) {
    assert(string(token, 100), 'Invalid file stream token');
    const item = streams.get(token);
    if (!item) return { closed: false };
    assert(item.owner === owner, 'FILE_STREAM_OWNER: 文件流不属于本窗口。');
    if (item.busy) await item.finished;
    return { closed: await release(token) };
  }
  async function disposeOwner(owner) { await Promise.all([...streams].filter(([, item]) => item.owner === owner).map(([token]) => release(token))); }
  async function dispose() { await Promise.all([...streams.keys()].map(release)); }
  return { openFiles, readChunk, closeStream, disposeOwner, dispose, expire, activeCount: () => streams.size };
}
module.exports = { createFileReader, MAX_MODEL_FILE_BYTES, MAX_STREAM_FILE_BYTES, FILE_CHUNK_BYTES, FILE_STREAM_IDLE_MS, STREAM_EXTENSIONS };
