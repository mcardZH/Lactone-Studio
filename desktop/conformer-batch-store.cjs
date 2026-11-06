'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { assert } = require('./security.cjs');
const idPattern = /^cb-[a-f0-9]{32}$/;

/** Private canonical records. No renderer path is accepted and every operation
 * checks directory/file identity before touching an owned record. */
function createConformerBatchStore({ root, io = fs, maxRecordBytes = 32 * 1024 ** 2 }) {
  assert(path.isAbsolute(root), 'Absolute private conformer batch root required');
  root = path.resolve(root);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  async function directory(target) {
    const stat = await io.lstat(target);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && same(await io.realpath(target), target), 'Batch directory identity changed');
  }
  function location(id) { assert(idPattern.test(id), 'Invalid conformer batch handle'); return path.join(root, id); }
  function recordName(name) { assert(/^(?:manifest|input-\d+|result-\d+)\.json$/.test(name), 'Invalid batch record'); return name; }
  async function write(id, name, value) {
    const dir = location(id); await directory(root); await directory(dir); recordName(name);
    const bytes = Buffer.from(JSON.stringify(value) + '\n'); assert(bytes.length <= maxRecordBytes, 'Conformer batch record exceeds bound');
    const file = path.join(dir, name), temp = file + '.next';
    // Fresh temporary files make an interrupted atomic publication recoverable.
    const handle = await io.open(temp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { const old = await io.lstat(file); assert(old.isFile() && !old.isSymbolicLink() && old.nlink === 1, 'Batch record changed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await io.rename(temp, file);
  }
  async function read(id, name) {
    const dir = location(id); await directory(root); await directory(dir); recordName(name);
    const file = path.join(dir, name), before = await io.lstat(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maxRecordBytes, 'Invalid batch record identity');
    const handle = await io.open(file, 'r');
    try {
      const opened = await handle.stat(); assert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'Batch record changed during open');
      const bytes = await handle.readFile(); const after = await handle.stat(), current = await io.lstat(file);
      assert(bytes.length === before.size && after.mtimeMs === opened.mtimeMs && after.size === opened.size && current.dev === opened.dev && current.ino === opened.ino && !current.isSymbolicLink(), 'Batch record changed during read');
      return JSON.parse(bytes.toString('utf8'));
    } finally { await handle.close(); }
  }
  async function create(id, manifest) { await io.mkdir(root, { recursive: true }); await directory(root); const dir = location(id); await io.mkdir(dir); await directory(dir); await write(id, 'manifest.json', manifest); }
  async function destroy(id) {
    const dir = location(id); await directory(root); await directory(dir);
    const names = await io.readdir(dir);
    // Exact owned files only; unexpected files/links retain the directory.
    assert(names.every(name => /^(?:manifest|input-\d+|result-\d+)\.json(?:\.next)?$/.test(name)), 'Unexpected batch member; retained');
    const files = [];
    for (const name of names) { const file = path.join(dir, name), stat = await io.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Batch member identity changed; retained'); files.push(file); }
    for (const file of files) { await directory(dir); await io.unlink(file); }
    await io.rmdir(dir);
  }
  return { create, read, write, destroy };
}
module.exports = { createConformerBatchStore };
