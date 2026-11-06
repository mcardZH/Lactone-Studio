'use strict';
const path = require('node:path');
const { assert, plain } = require('./security.cjs');
const { directoryIdentity, checkDirectory, currentFile, atomicWrite } = require('./portable-storage.cjs');
const LIMIT = 4096;
const DEFAULT_BINDINGS = Object.freeze({ select: 'r', freeze: 'f' });
function exact(value, fields) { assert(plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), 'Invalid hold-key preference fields'); }
function validateModelHoldKeys(value) {
  exact(value, ['select', 'freeze']);
  assert(['select', 'freeze'].every(field => typeof value[field] === 'string' && /^[a-z]$/i.test(value[field])), '选择/冻结快捷键须为单个英文字母。');
  const bindings = { select: value.select.toLowerCase(), freeze: value.freeze.toLowerCase() };
  assert(bindings.select !== bindings.freeze, '选择与冻结快捷键不能相同。');
  return bindings;
}
function createModelHoldKeyPreferencesStore(profileRoot) {
  assert(typeof profileRoot === 'string' && path.isAbsolute(profileRoot), 'Invalid hold-key profile root');
  const root = path.resolve(profileRoot), file = path.join(root, 'model-hold-key-preferences-v1.json');
  const pinned = directoryIdentity(root); pinned.catch(() => {});
  const baselines = new Map(), epochs = new Map(); let queue = Promise.resolve(), closed = false;
  const epoch = owner => epochs.get(owner) || 0;
  const active = (owner, generation) => assert(!closed && generation === epoch(owner), 'MODEL_HOLD_KEY_CLOSED: 快捷键窗口或存储已关闭。');
  const serialize = operation => { const pending = queue.then(operation); queue = pending.catch(() => {}); return pending; };
  async function load() {
    const parent = await pinned; await checkDirectory(root, parent);
    let record;
    try { record = await currentFile(file, undefined, LIMIT); }
    catch (error) { if (error.code === 'PORTABLE_INVALID_FILE') return { version: 'invalid', bindings: { ...DEFAULT_BINDINGS }, writable: false, error: '快捷键偏好文件无效，原文件已保留。', parent, record: null }; throw error; }
    if (!record) return { version: 'missing', bindings: { ...DEFAULT_BINDINGS }, writable: true, parent, record };
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes)); exact(value, ['schemaVersion', 'bindings']);
      assert(value.schemaVersion === 1, 'Unknown hold-key preference schema');
      return { version: record.sha256, bindings: validateModelHoldKeys(value.bindings), writable: true, parent, record };
    } catch (error) { return { version: record.sha256, bindings: { ...DEFAULT_BINDINGS }, writable: false, error: '快捷键偏好格式无法读取，原文件已保留：' + error.message, parent, record }; }
  }
  const snapshot = state => ({ version: state.version, bindings: { ...state.bindings }, writable: state.writable, ...(state.error ? { error: state.error } : {}) });
  async function write(owner, generation, request) {
    active(owner, generation); exact(request, ['baseVersion', 'bindings']);
    assert(typeof request.baseVersion === 'string' && request.baseVersion.length <= 64, 'Invalid hold-key base version');
    const bindings = validateModelHoldKeys(request.bindings), baseline = baselines.get(owner);
    assert(baseline && baseline.version === request.baseVersion, 'MODEL_HOLD_KEY_BASE: 请先读取快捷键偏好，再保存。');
    const current = await load(); active(owner, generation);
    assert(baseline.writable && current.writable, 'MODEL_HOLD_KEY_SCHEMA: 损坏或未来版本偏好须保留。');
    assert(current.version === baseline.version && current.parent === baseline.parent, 'MODEL_HOLD_KEY_CONFLICT: 另一窗口已修改快捷键，请重新读取。');
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, bindings }, null, 2) + '\n', 'utf8');
    // Once publication starts it must settle, including during application quit.
    // The existing portable writer checks directory/file identity before publish.
    const savedRecord = await atomicWrite(file, bytes, current.record, current.parent, undefined, LIMIT);
    const saved = { version: savedRecord.sha256, bindings, writable: true, parent: current.parent, record: savedRecord };
    try { active(owner, generation); } catch (error) { error.publicationPerformed = true; throw error; }
    baselines.set(owner, saved); return snapshot(saved);
  }
  return {
    read(owner) { const generation = epoch(owner); return serialize(async () => { active(owner, generation); const state = await load(); active(owner, generation); baselines.set(owner, state); return snapshot(state); }); },
    write(owner, request) { const generation = epoch(owner); return serialize(() => write(owner, generation, request)); },
    restoreFactory(owner, baseVersion) { const generation = epoch(owner); return serialize(() => write(owner, generation, { baseVersion, bindings: { ...DEFAULT_BINDINGS } })); },
    disposeOwner(owner) { epochs.set(owner, epoch(owner) + 1); baselines.delete(owner); },
    dispose() { closed = true; baselines.clear(); }, settle: () => queue,
  };
}
module.exports = { createModelHoldKeyPreferencesStore, validateModelHoldKeys, DEFAULT_BINDINGS, LIMIT };
