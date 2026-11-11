'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWindowsAssociationRegistry } = require('./windows-association-registry.cjs');
const CLASSES = 'HKCU\\Software\\Classes\\';
const PROGRAM_ID = 'SciYue.Project';
const SCIENTIFIC_ID = 'SciYue.ScientificFile';
const CAPABILITIES = 'Software\\SciYue\\SY-Studio\\Capabilities';
const JOURNAL = { key: 'HKCU\\Software\\SciYue\\SY-Studio\\FileAssociationState', name: 'State' };
// Suffixes nominate an application; the existing content recognizer still owns
// scientific format, source role and any analysis/structure choice.
const SUPPORTED_EXTENSIONS = Object.freeze(['.es', '.sy', '.sciyue', '.gjf', '.com', '.inp', '.restart', '.log', '.out', '.fch', '.fchk', '.xyz', '.extxyz', '.mol', '.sdf', '.pdb', '.cif', '.vasp', '.poscar', '.hess', '.molden', '.input']);
const value = data => ({ type: 'String', data });
const same = (a, b) => a == null || b == null ? a == null && b == null : a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data);
const failure = (code, message) => Object.assign(new Error(message), { code });
const idFor = (key, name = '') => `${key.toLowerCase()}|${name.toLowerCase()}`;
function associationEntries(executablePath) {
  const command = `"${executablePath}" "%1"`, rows = [];
  const add = (key, name, data, options = {}) => rows.push({ key, name, id: idFor(key, name), value: value(data), ...options });
  for (const [programId, label] of [[PROGRAM_ID, 'Ester Studio Project'], [SCIENTIFIC_ID, 'Ester Studio Scientific File']]) {
    add(CLASSES + programId, '', label, { core: true });
    add(`${CLASSES}${programId}\\DefaultIcon`, '', `"${executablePath}",0`, { core: true });
    add(`${CLASSES}${programId}\\shell\\open\\command`, '', command, { core: true });
  }
  // Stable registry identities keep previous ownership journals recoverable.
  // Windows displays FriendlyAppName/ApplicationName and launches the command.
  const application = `${CLASSES}Applications\\SY-Studio.exe`;
  add(application, 'FriendlyAppName', 'Ester Studio', { core: true });
  add(application + '\\shell\\open\\command', '', command, { core: true });
  add(application + '\\shell\\open', 'MultiSelectModel', 'Document', { core: true });
  add('HKCU\\' + CAPABILITIES, 'ApplicationName', 'Ester Studio', { core: true });
  add('HKCU\\' + CAPABILITIES, 'ApplicationDescription', '本地计算化学建模、输入与已保存结果读取', { core: true });
  for (const extension of SUPPORTED_EXTENSIONS) {
    const programId = extension === '.es' || extension === '.sy' ? PROGRAM_ID : SCIENTIFIC_ID;
    add(`${CLASSES}${extension}\\OpenWithProgids`, programId, '');
    add(application + '\\SupportedTypes', extension, '');
    // Command/script suffixes remain explicit Open With candidates only.
    if (extension !== '.com' && extension !== '.input') add('HKCU\\' + CAPABILITIES + '\\FileAssociations', extension, programId);
  }
  add('HKCU\\Software\\RegisteredApplications', 'SY-Studio', CAPABILITIES);
  // Read/retire the old four-key registration only. Never create an extension
  // default: an absent HKCU value can still have an effective HKLM default.
  add(CLASSES + '.sy', '', PROGRAM_ID, { legacyDefault: true });
  return rows;
}
const ALLOWED_PORTABLE_EXECUTABLES = Object.freeze([
  'lactone studio.exe',
  'lactone-studio.exe',
  'ester-studio.exe',
  'sy-studio.exe',
]);
function launcherPath(executablePath) {
  if (typeof executablePath !== 'string' || !/^[a-z]:[\\/]/i.test(executablePath) || !path.win32.isAbsolute(executablePath)
    || /["%\x00-\x1f]/.test(executablePath) || !ALLOWED_PORTABLE_EXECUTABLES.includes(path.win32.basename(executablePath).toLowerCase())) {
    throw failure('SY_ASSOCIATION_INVALID_EXECUTABLE', '文件关联需要本机盘符下当前便携目录中的 Lactone Studio.exe / Ester-Studio.exe（兼容旧版 SY-Studio.exe）；暂不支持 UNC 网络程序路径，以及含引号、控制字符或 Windows 命令占位符 % 的程序路径。导入文件路径不受此注册限制。');
  }
  return path.win32.normalize(executablePath);
}
function parseState(raw, entries, values) {
  const empty = { schema: 'sciyue-associations/v1', records: {}, pending: null };
  if (!raw) return empty;
  if (raw.type !== 'String' || typeof raw.data !== 'string' || raw.data.length > 1024 * 1024) throw failure('SY_ASSOCIATION_STATE_INVALID', '关联恢复记录不可读；已保留现有设置。');
  let state;
  try { state = JSON.parse(raw.data); } catch { throw failure('SY_ASSOCIATION_STATE_INVALID', '关联恢复记录损坏；已保留现有设置。'); }
  const allowed = new Map(entries.map(entry => [entry.id, entry]));
  const validValue = entry => entry === null || entry && entry.type === 'String' && typeof entry.data === 'string' && entry.data.length <= 32768;
  const validRecord = record => record && validValue(record.before) && validValue(record.written) && record.written !== null;
  if (!state || state.schema !== empty.schema || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)
    || Object.keys(state.records).length > entries.length || Object.entries(state.records).some(([id, record]) => !allowed.has(id) || !validRecord(record))) {
    throw failure('SY_ASSOCIATION_STATE_INVALID', '关联恢复记录不符合本程序范围；已保留现有设置。');
  }
  if (state.pending) {
    const pending = state.pending;
    if (!allowed.has(pending.id) || !validValue(pending.expected) || !validValue(pending.value) || pending.recordAfter !== null && !validRecord(pending.recordAfter)) throw failure('SY_ASSOCIATION_STATE_INVALID', '关联恢复记录不符合本程序范围；已保留现有设置。');
    const current = values[pending.id] ?? null;
    if (same(current, pending.value) || !same(current, pending.expected)) {
      if (pending.recordAfter) state.records[pending.id] = pending.recordAfter;
      else delete state.records[pending.id];
    }
    state.pending = null;
  }
  return state;
}
function legacyOwned(entries, values) {
  const commandEntry = entries.find(entry => entry.key === CLASSES + PROGRAM_ID + '\\shell\\open\\command');
  const command = values[commandEntry.id];
  if (command?.type !== 'String' || !/^"[^"%\r\n]+\\(?:SY-Studio|Ester-Studio)\.exe" "%1"$/i.test(command.data)) return new Set();
  const legacyPath = command.data.slice(1, command.data.indexOf('"', 1));
  const rows = associationEntries(legacyPath), known = rows.filter(entry => entry.key.startsWith(CLASSES + PROGRAM_ID));
  // Before journals existed, the old three ProgID values carried the old label.
  const matches = label => known.every(entry => same(values[entry.id], entry.name === '' && entry.key === CLASSES + PROGRAM_ID ? value(label) : entry.value));
  if (!matches('Ester Studio Project') && !matches('SY-Studio Project')) return new Set();
  const owned = new Set(known.map(entry => entry.id)), legacyDefault = rows.find(entry => entry.legacyDefault);
  if (same(values[legacyDefault.id], legacyDefault.value)) owned.add(legacyDefault.id);
  return owned;
}
function createSyProjectAssociation({ executablePath = process.execPath, platform = process.platform, registry = createWindowsAssociationRegistry(), stat = fs.lstat } = {}) {
  let tail = Promise.resolve();
  const serialize = operation => { const pending = tail.then(operation, operation); tail = pending.catch(() => {}); return pending; };
  async function inspect() {
    if (platform !== 'win32') return { supported: false, state: 'unsupported', executablePath, extensions: [...SUPPORTED_EXTENSIONS], issues: [], ownedCount: 0, requiresWindowsDefaultChoice: true };
    const absolute = launcherPath(executablePath), entries = associationEntries(absolute);
    const snapshot = await registry.read(entries, JOURNAL);
    if (!snapshot || !snapshot.values || typeof snapshot.values !== 'object') throw failure('SY_ASSOCIATION_REGISTRY_RESPONSE', '文件关联状态回执无效。');
    const state = parseState(snapshot.journal, entries, snapshot.values), issues = [];
    const ownedCount = Object.keys(state.records).length;
    // Legacy adoption is a one-time migration. A later user-created value must
    // not become owned just because it resembles the former four-key layout.
    const legacy = snapshot.journal ? new Set() : legacyOwned(entries, snapshot.values);
    for (const entry of entries) {
      const current = snapshot.values[entry.id] ?? null, record = state.records[entry.id];
      if (record && !same(current, record.written)) issues.push({ code: 'user-change', target: entry.key + (entry.name ? ` [${entry.name}]` : ''), message: '此值已由用户或其他程序修改，予以保留。' });
    }
    const needed = entries.filter(entry => !entry.legacyDefault), matching = needed.filter(entry => same(snapshot.values[entry.id], entry.value)).length;
    const oldCommand = state.records[idFor(CLASSES + PROGRAM_ID + '\\shell\\open\\command')]?.written?.data;
    let status = matching === needed.length && !issues.length ? 'registered' : ownedCount || legacy.size ? 'partial' : 'unregistered';
    if (status === 'partial' && !issues.length && oldCommand && oldCommand !== `"${absolute}" "%1"`) status = 'update-needed';
    return { supported: true, state: status, executablePath: absolute, registeredExecutablePath: oldCommand?.match(/^"([^"]+)"/)?.[1], extensions: [...SUPPORTED_EXTENSIONS], issues, ownedCount, requiresWindowsDefaultChoice: true,
      _entries: entries, _snapshot: snapshot, _state: state, _legacy: legacy };
  }
  const publicStatus = result => { const { _entries, _snapshot, _state, _legacy, ...status } = result; return { ...status, registered: status.state === 'registered', programId: PROGRAM_ID }; };
  async function operate(action, assertOwner = () => {}) {
    assertOwner(); const inspected = await inspect(); assertOwner();
    if (!inspected.supported) {
      if (action === 'status') return publicStatus(inspected);
      throw failure('SY_ASSOCIATION_UNSUPPORTED', 'Windows 文件关联仅在 Windows 中可用。');
    }
    if (action === 'status') return publicStatus(inspected);
    if (action !== 'register' && action !== 'remove') throw failure('SY_INVALID_REQUEST', '未知文件关联操作。');
    if (action === 'register') {
      const selected = await stat(inspected.executablePath); assertOwner();
      if (!selected.isFile() || selected.isSymbolicLink()) throw failure('SY_ASSOCIATION_INVALID_EXECUTABLE', '当前 Ester Studio 启动器不可用；请从完整便携目录启动。');
    }
    const { _entries: entries, _snapshot: snapshot, _state: state, _legacy: legacy } = inspected;
    const steps = [], issues = [], retained = [];
    if (action === 'register') {
      for (const entry of entries.filter(row => row.core)) {
        const current = snapshot.values[entry.id] ?? null, record = state.records[entry.id];
        if (current && !same(current, entry.value) && !(record && same(current, record.written)) && !legacy.has(entry.id)) issues.push({ code: 'registration-conflict', target: entry.key, message: '程序注册值已存在其他设置，未覆盖。' });
      }
      if (issues.length) return { ...publicStatus(inspected), state: 'partial', operation: action, changedCount: 0, issues: [...inspected.issues, ...issues] };
    }
    // Checkpoint the complete proven legacy group before its first value is
    // changed/deleted, so an interrupted migration does not lose the remainder.
    for (const id of legacy) if (!state.records[id]) state.records[id] = { before: null, written: snapshot.values[id] };
    for (const entry of entries) {
      const current = snapshot.values[entry.id] ?? null;
      let record = state.records[entry.id];
      if (!record && legacy.has(entry.id)) record = { before: null, written: current };
      if (action === 'remove') {
        if (!record) continue;
        if (!same(current, record.written)) { retained.push(entry.id); continue; }
        steps.push({ target: entry, expected: current, value: record.before, recordAfter: null });
      } else {
        if (entry.legacyDefault) continue;
        if (record && !same(current, record.written)) { retained.push(entry.id); continue; }
        if (!record && current) {
          if (!same(current, entry.value)) issues.push({ code: 'registration-conflict', target: entry.key, message: '已有注册值保留；此项未注册。' });
          continue;
        }
        if (same(current, entry.value) && state.records[entry.id]) continue;
        steps.push({ target: entry, expected: current, value: entry.value, recordAfter: { before: record ? record.before : current, written: entry.value } });
      }
    }
    assertOwner();
    const applied = await registry.apply({ state, expectedJournal: snapshot.journal ?? null, steps }, JOURNAL);
    // A dispatched native operation finishes its recovery checkpoint even if
    // the initiating window closes. No following operation is dispatched.
    assertOwner();
    for (const row of applied.results ?? []) if (row.status !== 'changed') issues.push({ code: row.status === 'conflict' ? 'user-change' : 'write-failed', target: entries.find(entry => entry.id === row.id)?.key ?? row.id, message: row.message ?? '写入前发现设置已改变，已保留；请刷新后重试。' });
    const after = await inspect(); assertOwner();
    const result = { ...publicStatus(after), operation: action, changedCount: (applied.results ?? []).filter(row => row.status === 'changed').length, retainedCount: retained.length, issues: [...after.issues, ...issues] };
    if (result.issues.length) result.state = 'partial';
    return result;
  }
  return { status: options => serialize(() => operate('status', options?.assertOwner)), register: options => serialize(() => operate('register', options?.assertOwner)), remove: options => serialize(() => operate('remove', options?.assertOwner)) };
}
async function associateSyProject(options) { return createSyProjectAssociation(options).register(); }
module.exports = { associateSyProject, createSyProjectAssociation, associationEntries, SUPPORTED_EXTENSIONS, JOURNAL, PROGRAM_ID, SCIENTIFIC_ID };
