'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert } = require('./security.cjs');

/** argv is already tokenized by the OS; never split or shell-evaluate it. */
function launchPaths(argv, cwd, packaged = true, paths = path) {
  if (!Array.isArray(argv)) return [];
  const selected = argv.slice(packaged ? 1 : 2).filter(value => typeof value === 'string' && value && !value.startsWith('-'));
  return selected.map(value => {
    assert(value.length <= 32768 && !value.includes('\0') && !/^[a-z][a-z\d+.-]*:\/\//i.test(value), '启动来源路径无效。');
    return paths.resolve(cwd, value);
  });
}

/** One in-flight batch per renderer, with explicit claim/finish and bounded history. */
function createLaunchImportQueue({ sources, notify }) {
  const pending = [], inflight = new Map(), ready = new Set(), completed = new Map();
  function enqueue(owner, paths, error) {
    if (!paths.length && !error) return null;
    const batch = { id: randomUUID(), owner, paths, error };
    pending.push(batch);
    if (ready.has(owner)) notify(owner);
    return batch.id;
  }
  async function claim(owner) {
    ready.add(owner);
    if (inflight.has(owner)) return null;
    const index = pending.findIndex(batch => batch.owner === owner);
    if (index < 0) return null;
    const [batch] = pending.splice(index, 1); inflight.set(owner, batch);
    try { return { id: batch.id, sources: batch.error ? [] : await sources.open(owner, batch.paths), error: batch.error }; }
    catch (error) { return { id: batch.id, sources: [], error: error.message || '启动来源读取失败。' }; }
  }
  function finish(owner, id) {
    const batch = inflight.get(owner);
    if (!batch || batch.id !== id) {
      assert(completed.get(id) === owner, '启动导入回执不属于本窗口或批次。');
      return { accepted: false };
    }
    inflight.delete(owner); completed.set(id, owner);
    if (completed.size > 128) completed.delete(completed.keys().next().value);
    if (ready.has(owner) && pending.some(row => row.owner === owner)) notify(owner);
    return { accepted: true };
  }
  function disposeOwner(owner) {
    ready.delete(owner); inflight.delete(owner);
    for (let index = pending.length - 1; index >= 0; index--) if (pending[index].owner === owner) pending.splice(index, 1);
    for (const [id, value] of completed) if (value === owner) completed.delete(id);
    return sources.disposeOwner(owner);
  }
  function dispose() { pending.length = 0; inflight.clear(); ready.clear(); completed.clear(); return sources.dispose(); }
  function wake() { for (const owner of ready) if (pending.some(batch => batch.owner === owner)) notify(owner); }
  return { enqueue, claim, finish, disposeOwner, dispose, markReady: owner => ready.add(owner), wake };
}
module.exports = { launchPaths, createLaunchImportQueue };
