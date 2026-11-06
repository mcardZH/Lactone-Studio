/** Fixed-path JSON transport for authored workspace snapshots.
 * No chemistry, Store, executable callback, arbitrary reference or opaque JSON
 * string is interpreted here. Generic commands retain their separate guard. */
const MAX_DEPTH = 64;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const join = (prefix, key) => { const escaped = String(key).replace(/~/g, '~0').replace(/\//g, '~1'); return prefix ? `${prefix}/${escaped}` : escaped; };
const at = (prefix, path) => prefix ? `${prefix}/${path}` : path;
const roots = Object.freeze({ snapshot: ['document', 'viewport/editingDocument'], envelope: ['snapshot/document', 'snapshot/viewport/editingDocument'], viewport: ['editingDocument'], document: [''], 'display-metadata': ['displayDocument/document'] });
const commandFields = Object.freeze({
  'model.execute': ['command'], 'model.select': ['selection'], 'model.undo': [], 'model.redo': [],
  'model.context': ['engine', 'context'], 'model.electronic-state': ['charge', 'multiplicity'],
  'chemistry.start': ['request', 'jobId'], 'chemistry.cancel': ['jobId'],
  'dynamics.start': ['request', 'sessionId'], 'dynamics.command': ['sessionId', 'command'],
  'input.draft-update': ['engine', 'value'], 'workspace.close-view': ['viewId'], 'workspace.viewport-event': ['event'],
});

/** Only the declared application command route uses this clone. It validates
 * its complete JSON value without a total byte/node count; the owner Store and
 * existing application validators still exclusively decide scientific edits.
 * Non-command messages keep the ordinary bounded generic JSON validator. */
export function copyWorkspaceCommandJSON(value, kind = 'command') {
  const stack = new Set();
  function visit(item, depth, inArray = false) {
    assert(depth <= MAX_DEPTH, '共享文档 JSON 复杂度超过上限。');
    if (item === undefined && !inArray) return undefined;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') { assert(Number.isFinite(item), '共享文档数值必须有限。'); return item === 0 ? 0 : item; }
    assert(Array.isArray(item) || plain(item), '共享文档只能传输普通 JSON。');
    assert(!stack.has(item), '共享文档不能传输循环引用。');
    const keys = Object.keys(item), array = Array.isArray(item), result = array ? [] : {};
    if (array) assert(keys.length === item.length && keys.every(key => /^(0|[1-9]\d*)$/.test(key)), '共享文档不能传输稀疏或附加属性数组。');
    stack.add(item);
    for (const key of keys) {
      assert(!FORBIDDEN.has(key), '共享文档包含不安全 JSON 字段。');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      assert(descriptor && 'value' in descriptor, '共享文档不能传输访问器。');
      const copied = visit(descriptor.value, depth + 1, array);
      if (array || copied !== undefined) result[key] = copied;
    }
    stack.delete(item); return result;
  }
  const copied = visit(value, 0);
  const exact = (object, fields) => plain(object) && Object.keys(object).length === fields.length && fields.every(key => Object.hasOwn(object, key));
  let command;
  if (kind === 'command') command = copied;
  else if (kind === 'request') {
    assert(exact(copied, ['documentId', 'membershipNonce', 'expectedRevision', 'command']), 'Invalid workspace command request fields'); command = copied.command;
  } else if (kind === 'event') {
    assert(exact(copied, ['kind', 'schema', 'version', 'documentId', 'requestId', 'requesterWindowId', 'expectedRevision', 'command']) && copied.kind === 'command' && copied.schema === 'sciyue-workspace-document' && copied.version === 1, 'Invalid workspace command event fields'); command = copied.command;
  } else throw new Error('Unknown workspace command codec kind');
  assert(plain(command) && Object.hasOwn(commandFields, command.type) && exact(command, ['type', ...commandFields[command.type]]), 'Unsupported workspace transport command type or fields');
  if (command.type === 'model.execute') assert(plain(command.command) && typeof command.command.type === 'string', 'Invalid workspace application command');
  if (command.type === 'dynamics.command') assert(plain(command.command) && ['pause', 'resume', 'stop'].includes(command.command.command), 'Invalid workspace dynamics command');
  return copied;
}

/** Validated clones may share equal scientific blocks, only at these declared
 * paths. This is in-memory aliasing; there are no caller supplied ref tokens,
 * strings to parse, recursion into another envelope or mutable global cache. */
export function copyWorkspaceSnapshotJSON(value, kind = 'snapshot') {
  assert(Object.hasOwn(roots, kind), 'Unknown workspace snapshot codec kind');
  const structures = new Set(roots[kind].flatMap(root => ['draft/structure', 'draft/baseStructure', 'cellCheckpoint/structure'].map(path => at(root, path))));
  const scientificPaths = new Set(roots[kind].flatMap(root => ['draft/assignments', 'draft/baseAssignments', 'draft/baseAtomIds', 'draft/selectedIds', 'draft/touchedIds', 'draft/createdFrom', 'selection', 'auxiliaryRelations', 'deletedBonds', 'internalCoordinates', 'sharedConstraints', 'coordinateObjects', 'gaussianBoundCoordinates', 'attachmentPorts', 'bondOrderObservation'].map(path => at(root, path))));
  for (const prefix of kind === 'snapshot' ? [''] : kind === 'envelope' ? ['snapshot'] : []) for (const engine of ['gaussian', 'orca']) scientificPaths.add(at(prefix, `contexts/${engine}`));
  const displayPrefixes = kind === 'display-metadata' ? ['display'] : kind === 'viewport' ? [''] : kind === 'snapshot' ? ['viewport'] : kind === 'envelope' ? ['snapshot/viewport'] : [];
  const isStructure = path => structures.has(path) || displayPrefixes.some(prefix => new RegExp(`^${prefix ? prefix + '/' : ''}multiframeDisplay/frames/\\d+/structure$`).test(path));
  const blocks = new Map(), stack = new Set();
  // Complete authored snapshots have no aggregate byte/node ceiling. Only the
  // declared small scientific records below retain a record-complexity guard.
  const envelopeBudget = { nodes: 0 };
  function property(item, key) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    assert(descriptor && 'value' in descriptor, '共享文档不能传输访问器。');
    return descriptor.value;
  }
  function visit(item, path, depth, budget, scientific = false, inArray = false) {
    if (!scientific && scientificPaths.has(path)) { scientific = true; budget = { nodes: 0 }; }
    assert(depth <= MAX_DEPTH && (budget.maximum === undefined || ++budget.nodes <= budget.maximum), '共享文档 JSON 复杂度超过上限。');
    if (item === undefined && !inArray) return undefined;
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return item;
    if (typeof item === 'number') { assert(Number.isFinite(item), '共享文档数值必须有限。'); return item === 0 ? 0 : item; }
    assert(Array.isArray(item) || plain(item), '共享文档只能传输普通 JSON。');
    assert(!stack.has(item), '共享文档不能传输循环引用。');
    if (!scientific && isStructure(path)) {
      assert(plain(item), '共享科学结构必须为普通对象。');
      const atoms = property(item, 'atoms');
      assert(Array.isArray(atoms), '共享科学结构原子必须为数组。');
      const scientificArrays = new Set(['atoms', 'bonds', 'bondPerceptionIssues']);
      const result = {};
      stack.add(item);
      for (const key of Object.keys(item)) {
        assert(!FORBIDDEN.has(key), '共享文档包含不安全 JSON 字段。');
        const entry = property(item, key);
        if (scientificArrays.has(key) && entry !== undefined) {
          assert(Array.isArray(entry), `共享科学结构 ${key} 必须为数组。`);
          const keys = Object.keys(entry);
          assert(keys.length === entry.length && keys.every(key => /^(0|[1-9]\d*)$/.test(key)), '共享文档不能传输稀疏或附加属性数组。');
          assert(!stack.has(entry), '共享文档不能传输循环引用。'); stack.add(entry);
          // Each atom/bond/contact record has its own small JSON allowance;
          // a large record cannot borrow the budgets of thousands of atoms.
          result[key] = keys.map(index => visit(property(entry, index), '', depth + 2, { nodes: 0, maximum: 64 }, true, true));
          stack.delete(entry);
        } else if (key === 'layout2D' && entry !== undefined) {
          assert(plain(entry), '共享二维布局必须为普通对象。');
          const layout = {}; stack.add(entry);
          for (const id of Object.keys(entry)) { assert(!FORBIDDEN.has(id), '共享文档包含不安全 JSON 字段。'); layout[id] = visit(property(entry, id), '', depth + 2, { nodes: 0, maximum: 64 }, true); }
          stack.delete(entry); result[key] = layout;
        } else {
          const copied = visit(entry, '', depth + 1, envelopeBudget, true);
          if (copied !== undefined) result[key] = copied;
        }
      }
      stack.delete(item);
      const key = JSON.stringify(result), previous = blocks.get(key);
      if (previous) return previous;
      blocks.set(key, result); return result;
    }
    const keys = Object.keys(item), array = Array.isArray(item), result = array ? [] : {};
    if (array) assert(keys.length === item.length && keys.every(key => /^(0|[1-9]\d*)$/.test(key)), '共享文档不能传输稀疏或附加属性数组。');
    stack.add(item);
    for (const key of keys) {
      assert(!FORBIDDEN.has(key), '共享文档包含不安全 JSON 字段。');
      const copied = visit(property(item, key), scientific ? '' : join(path, key), depth + 1, budget, scientific, array);
      if (array || copied !== undefined) result[key] = copied;
    }
    stack.delete(item); return result;
  }
  const result = visit(value, '', 0, envelopeBudget);
  return result;
}
