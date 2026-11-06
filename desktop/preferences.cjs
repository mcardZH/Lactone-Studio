'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { normalizeWorkbenchPreferences, createDefaultWorkbenchPreferences } = require('./workbench-layout-runtime.cjs');
const LIMIT = 1024 * 1024;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const version = (name, bytes) => createHash('sha256').update(name + '\0').update(bytes).digest('hex');
function request(value) {
  let text; try { text = JSON.stringify(value); } catch { throw new Error('Invalid workbench preferences'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2, 3].includes(value.schemaVersion) || !Array.isArray(value.layouts) || !value.layouts.length || value.layouts.length > 32 || typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('Invalid workbench preference schema or size');
  if (value.layouts.some(layout => !layout || typeof layout !== 'object' || Array.isArray(layout) || typeof layout.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(layout.id) || typeof layout.name !== 'string' || !layout.name.trim() || layout.name.trim().length > 80) || !value.layouts.some(layout => layout.id === value.defaultLayoutId)) throw new Error('Invalid layout identity/name or default pointer');
  const result = normalizeWorkbenchPreferences(value);
  if (result.layouts.length !== value.layouts.length) throw new Error('Invalid or duplicate layout identity');
  const names = new Set();
  for (const layout of result.layouts) { if (names.has(layout.name)) throw new Error('同名布局已存在，请使用不同方案名称。'); names.add(layout.name); }
  return result;
}
function merge(baseline, desired, current) {
  const before = new Map(baseline.layouts.map(layout => [layout.id, layout]));
  const after = new Map(desired.layouts.map(layout => [layout.id, layout]));
  const combined = new Map(current.layouts.map(layout => [layout.id, layout]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), next = after.get(id); if (equal(old, next)) continue;
    const now = combined.get(id);
    if (!equal(now, old) && !equal(now, next)) throw new Error('WORKBENCH_CONFLICT: 同一布局已由另一窗口修改，请重新读取或另存。');
    if (next) combined.set(id, next); else combined.delete(id);
  }
  const defaultChanged = desired.defaultLayoutId !== baseline.defaultLayoutId;
  if (defaultChanged && current.defaultLayoutId !== baseline.defaultLayoutId && current.defaultLayoutId !== desired.defaultLayoutId) throw new Error('WORKBENCH_CONFLICT: 默认布局已由另一窗口修改，请重新读取。');
  const defaultLayoutId = defaultChanged ? desired.defaultLayoutId : current.defaultLayoutId;
  if (!combined.has(defaultLayoutId)) throw new Error('WORKBENCH_CONFLICT: 默认布局已改变，请重新读取。');
  return request({ schemaVersion: 3, defaultLayoutId, layouts: [...combined.values()] });
}
/** A single host owns this queue. v1/v2 stay read-only; v3 is created only on explicit save. */
function createWorkbenchPreferencesStore(profileRoot) {
  if (typeof profileRoot !== 'string' || !path.isAbsolute(profileRoot)) throw new Error('Invalid workbench profile root');
  const root = path.resolve(profileRoot), file = path.join(root, 'workbench-layout-v3.json'), previous = path.join(root, 'workbench-layout-v2.json'), legacy = path.join(root, 'workbench-layout-v1.json');
  const baselines = new Map(), epochs = new Map(); let queue = Promise.resolve(), closed = false;
  const ancestors = []; for (let cursor = root;; cursor = path.dirname(cursor)) { ancestors.unshift(cursor); if (path.dirname(cursor) === cursor) break; }
  const pinned = new Map(); let pinError;
  const directoryKey = (real, stat) => `${real}:${stat.dev}:${stat.ino}`;
  const changed = message => Object.assign(new Error(message), { code: 'PORTABLE_PATH_CHANGED' });
  // Capture all existing ancestors at construction, not a newly-read replacement.
  try { for (const directory of ancestors) { let stat; try { stat = fsSync.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') break; throw error; } if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('Workbench profile ancestors must not be links'); pinned.set(directory, directoryKey(fsSync.realpathSync(directory), stat)); } } catch (error) { pinError = error; }
  async function checkPinned() { if (pinError) throw pinError; for (const [directory, key] of pinned) { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || directoryKey(await fs.realpath(directory), stat) !== key) throw changed('Workbench profile ancestor identity changed'); } }
  const epoch = owner => epochs.get(owner) || 0;
  const active = (owner, generation) => { if (closed || generation !== epoch(owner)) throw new Error('WORKBENCH_CLOSED: Preference owner or store closed'); };
  const serialize = operation => { const pending = queue.then(operation); queue = pending.catch(() => {}); return pending; };
  async function parent() {
    await checkPinned();
    for (const directory of ancestors) { if (pinned.has(directory)) continue; await checkPinned(); try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed('Workbench profile directory must not be a link'); pinned.set(directory, directoryKey(await fs.realpath(directory), stat)); }
    await checkPinned(); return pinned.get(root);
  }
  async function load() {
    const parentIdentity = await parent();
    for (const candidate of [file, previous, legacy]) {
      let handle;
      try {
        const selected = await fs.lstat(candidate);
        if (!selected.isFile() || selected.isSymbolicLink() || selected.size > LIMIT) throw new Error('Invalid workbench preference file or size');
        handle = await fs.open(candidate, 'r'); const opened = await handle.stat();
        if (identity(opened) !== identity(selected)) throw new Error('Workbench preference file changed while opening');
        const bytes = await handle.readFile();
        if (bytes.length > LIMIT || identity(opened) !== identity(await fs.lstat(candidate))) throw new Error('Workbench preference file changed while reading');
        await parent();
        const token = version(path.basename(candidate), bytes);
        try { return { preferences: request(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), version: token, writable: true, parentIdentity, source: candidate }; }
        catch (error) { return { preferences: createDefaultWorkbenchPreferences(), version: token, writable: false, parentIdentity, source: candidate, error: '布局格式无法读取，已保留原文件：' + error.message }; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { if (handle) await handle.close(); }
    }
    await parent(); return { preferences: createDefaultWorkbenchPreferences(), version: 'missing', writable: true, parentIdentity, source: null };
  }
  const snapshot = state => ({ preferences: structuredClone(state.preferences), version: state.version, writable: state.writable, ...(state.error ? { error: state.error } : {}) });
  async function read(owner, generation) { active(owner, generation); const state = await load(); active(owner, generation); baselines.set(owner, state); return snapshot(state); }
  async function write(owner, generation, update, legacyCaller = false) {
    active(owner, generation);
    if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).length !== 2 || !Object.hasOwn(update, 'preferences') || typeof update.baseVersion !== 'string' || update.baseVersion.length > 64) throw new Error('Invalid workbench snapshot update');
    const desired = request(update.preferences), baseline = baselines.get(owner);
    if (!baseline || baseline.version !== update.baseVersion) throw new Error('WORKBENCH_BASE: 请先读取布局，再保存方案。');
    const current = await load(); active(owner, generation);
    if (!baseline.writable || !current.writable) throw new Error('WORKBENCH_SCHEMA: 损坏或未来格式已保留，禁止覆写。');
    if (current.parentIdentity !== baseline.parentIdentity) throw new Error('WORKBENCH_CONFLICT: 布局目录已变化，请重新读取。');
    const preferences = merge(baseline.preferences, desired, current.preferences);
    const bytes = Buffer.from(JSON.stringify(preferences, null, 2) + '\n'), temporary = path.join(root, '.workbench-' + randomUUID() + '.tmp'); let ownedTemporary, writtenTemporary, publicationPerformed = false;
    const publicationError = error => { error.publicationPerformed = true; error.message = '布局写入操作已提交，但后续确认失败；未报告保存成功，请重新读取。' + error.message; return error; };
    const ownedKey = stat => `${stat.dev}:${stat.ino}`;
    async function cleanupTemporary() { if (!ownedTemporary) return; try { await checkPinned(); const stat = await fs.lstat(temporary); if (stat.isFile() && !stat.isSymbolicLink() && ownedKey(stat) === ownedTemporary) await fs.unlink(temporary); } catch { /* Uncertain/replaced paths remain untouched. */ } }
    try {
      const handle = await fs.open(temporary, 'wx'); ownedTemporary = ownedKey(await handle.stat());
      try { active(owner, generation); await handle.writeFile(bytes); await handle.sync(); writtenTemporary = identity(await handle.stat()); } finally { await handle.close(); }
      const check = await load(); active(owner, generation);
      if (!check.writable || check.version !== current.version || check.parentIdentity !== current.parentIdentity || check.source !== current.source) throw new Error('WORKBENCH_CONFLICT: 布局文件在保存时发生变化，请重新读取。');
      await checkPinned(); const selected = await fs.lstat(temporary); if (!selected.isFile() || selected.isSymbolicLink() || identity(selected) !== writtenTemporary) throw changed('Workbench owned temporary changed before publication');
      active(owner, generation);
      if (current.source !== file) { await fs.link(temporary, file); publicationPerformed = true; active(owner, generation); await cleanupTemporary(); } else { await fs.rename(temporary, file); publicationPerformed = true; ownedTemporary = undefined; active(owner, generation); }
    } catch (error) { await cleanupTemporary(); throw publicationPerformed ? publicationError(error) : error; }
    let saved;
    try { saved = await load(); active(owner, generation); if (saved.version !== version(path.basename(file), bytes)) throw new Error('WORKBENCH_CONFLICT: 保存后布局已被外部修改，请重新读取。'); }
    catch (error) { throw publicationError(error); }
    // Legacy void writers never received the merged list; preserve their own baseline.
    if (!closed && epoch(owner) === generation) baselines.set(owner, legacyCaller ? { ...saved, preferences: desired } : saved);
    return snapshot(saved);
  }
  return {
    readSnapshot(owner) { const generation = epoch(owner); return serialize(() => read(owner, generation)); },
    writeSnapshot(owner, update) { const generation = epoch(owner); return serialize(() => write(owner, generation, update)); },
    read(owner) { const generation = epoch(owner); return serialize(async () => (await read(owner, generation)).preferences); },
    write(owner, value) { const generation = epoch(owner); return serialize(async () => { const baseline = baselines.get(owner); await write(owner, generation, { baseVersion: baseline?.version ?? '', preferences: value }, true); }); },
    // Import holds both stores in a fixed order; regular window writes stay queued.
    exclusive(owner, operation) { const generation = epoch(owner); return serialize(async () => { active(owner, generation); return operation({ read: () => read(owner, generation), write: update => write(owner, generation, update) }); }); },
    disposeOwner(owner) { epochs.set(owner, epoch(owner) + 1); baselines.delete(owner); },
    dispose() { closed = true; baselines.clear(); },
    settle: () => queue,
  };
}
module.exports = { createWorkbenchPreferencesStore, validateWorkbenchPreferences: request, LIMIT };
