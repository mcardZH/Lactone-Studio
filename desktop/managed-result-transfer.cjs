'use strict';
const { randomUUID } = require('node:crypto');
const MARKER = '__esManagedResult';
const CHUNK_BYTES = 64 * 1024, CHUNK_ITEMS = 4096;
const typedNames = new Set(['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView']);
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function check(condition, message) { if (!condition) throw new Error(message); }

/** Host-owned transfer references only. No renderer paths, serialization, scientific
 * transformations or copies of complete large buffers are accepted here. */
function createManagedResultTransfers({ idleMs = 120000, now = Date.now } = {}) {
  check(Number.isFinite(idleMs) && idleMs > 0, 'Invalid managed-result idle retention');
  const records = new Map(); let closed = false;
  function owner(value) { check(Number.isSafeInteger(value) && value > 0, 'Invalid managed-result owner'); }
  function drop(token) {
    const record = records.get(token); if (!record) return;
    records.delete(token);
    if (record.parent) records.get(record.parent)?.children.delete(token);
    for (const child of record.children) drop(child);
  }
  function touch(record) {
    // Sibling descriptors from the same invocation remain valid while any part
    // of that invocation is being drained.
    record.group.expires = now() + idleMs;
  }
  function sweep() { const time = now(); for (const [token, record] of records) if (record.group.expires <= time) drop(token); }
  const timer = setInterval(sweep, Math.min(idleMs, 30000)); timer.unref?.();
  function hold(ownerId, value, kind, parent, created, group) {
    const token = randomUUID(), keys = kind === 'object' ? Object.keys(value) : undefined;
    const type = kind === 'typed' ? (Buffer.isBuffer(value) ? 'Uint8Array' : value.constructor.name) : undefined;
    const length = kind === 'typed' ? value.byteLength : kind === 'object' ? keys.length : value.length;
    const record = { owner: ownerId, value, kind, type, keys, length, parent, children: new Set(), group };
    records.set(token, record); created.push(token); if (parent) records.get(parent).children.add(token);
    return { [MARKER]: 'v1', token, kind, length, ...(type ? { type } : {}), ...(kind === 'object' && Object.getPrototypeOf(value) === null ? { nullPrototype: true } : {}) };
  }
  function packNode(ownerId, value, parent, created, budget, visiting, group) {
    if (typeof value === 'string') {
      const size = Buffer.byteLength(value, 'utf8');
      if (size > Math.max(0, budget.bytes)) { budget.bytes -= 160; return hold(ownerId, value, 'string', parent, created, group); }
      budget.bytes -= size + 8; return value;
    }
    if (ArrayBuffer.isView(value)) {
      check(typedNames.has(value.constructor.name) || Buffer.isBuffer(value), 'Unsupported managed-result typed array');
      if (value.byteLength > Math.max(0, budget.bytes)) { budget.bytes -= 160; return hold(ownerId, value, 'typed', parent, created, group); }
      budget.bytes -= value.byteLength + 16; return value;
    }
    if (!Array.isArray(value) && !plain(value)) { budget.bytes -= 16; return value; }
    check(!visiting.has(value), 'Cyclic managed analysis result');
    const isArray = Array.isArray(value), keys = isArray ? undefined : Object.keys(value), length = isArray ? value.length : keys.length;
    if (length > CHUNK_ITEMS || length * 16 > Math.max(0, budget.bytes)) { budget.bytes -= 160; return hold(ownerId, value, isArray ? 'array' : 'object', parent, created, group); }
    visiting.add(value);
    try {
      const budgetBefore = budget.bytes, createdAt = created.length; let result = value;
      for (const key of isArray ? value.keys() : keys) {
        // Preserve array holes and ordinary own-property semantics.
        if (!Object.hasOwn(value, key)) continue;
        if (!isArray) budget.bytes -= Buffer.byteLength(key, 'utf8') + 8;
        const entry = packNode(ownerId, value[key], parent, created, budget, visiting, group);
        if (!Object.is(entry, value[key])) {
          if (result === value) result = isArray ? value.slice() : Object.setPrototypeOf(Object.assign(Object.create(null), value), Object.getPrototypeOf(value));
          Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true, writable: true });
        }
      }
      if (budget.bytes < 0) {
        for (const token of created.splice(createdAt)) drop(token);
        budget.bytes = budgetBefore - 160;
        return hold(ownerId, value, isArray ? 'array' : 'object', parent, created, group);
      }
      return result;
    } finally { visiting.delete(value); }
  }
  function pack(ownerId, value) {
    owner(ownerId); check(!closed, 'Managed-result transfers disposed'); sweep(); const created = [];
    try { return packNode(ownerId, value, undefined, created, { bytes: CHUNK_BYTES }, new Set(), { expires: now() + idleMs }); }
    catch (error) { for (const token of created) drop(token); throw error; }
  }
  function read(ownerId, token, start) {
    owner(ownerId); sweep(); const record = records.get(token);
    check(record && record.owner === ownerId, 'Managed-result token unavailable for owner');
    check(Number.isSafeInteger(start) && start >= 0 && start <= record.length, 'Invalid managed-result offset'); touch(record);
    if (record.kind === 'typed') {
      const next = Math.min(record.length, start + CHUNK_BYTES);
      return { bytes: new Uint8Array(record.value.buffer, record.value.byteOffset + start, next - start), next, done: next === record.length };
    }
    if (record.kind === 'string') {
      // At most three UTF-8 bytes per UTF-16 unit. Avoid splitting a valid pair;
      // lone surrogates remain unchanged because chunks travel as strings.
      let next = Math.min(record.length, start + Math.floor(CHUNK_BYTES / 3));
      if (next < record.length && next > start && /[\uD800-\uDBFF]/.test(record.value[next - 1]) && /[\uDC00-\uDFFF]/.test(record.value[next])) next--;
      return { text: record.value.slice(start, next), next, done: next === record.length };
    }
    const items = [], holes = [], created = [], budget = { bytes: CHUNK_BYTES }, ancestors = new Set(); let next = start;
    for (let ancestor = record; ancestor; ancestor = records.get(ancestor.parent)) ancestors.add(ancestor.value);
    try {
      while (next < record.length && items.length < CHUNK_ITEMS && (items.length === 0 || budget.bytes >= 512)) {
        const key = record.kind === 'object' ? record.keys[next] : next;
        const entry = packNode(ownerId, record.value[key], token, created, budget, new Set(ancestors), record.group);
        if (record.kind === 'object') { budget.bytes -= Buffer.byteLength(key, 'utf8') + 8; items.push([key, entry]); }
        else { if (!Object.hasOwn(record.value, key)) holes.push(items.length); items.push(entry); }
        next++;
      }
      return { items, ...(holes.length ? { holes } : {}), next, done: next === record.length };
    } catch (error) { for (const child of created) drop(child); throw error; }
  }
  function release(ownerId, token) {
    owner(ownerId); const record = records.get(token);
    if (!record) return false;
    check(record.owner === ownerId, 'Managed-result token unavailable for owner'); drop(token); return true;
  }
  function disposeOwner(ownerId) { owner(ownerId); for (const [token, record] of records) if (record.owner === ownerId) drop(token); }
  function dispose() { closed = true; clearInterval(timer); records.clear(); }
  return { pack, read, release, disposeOwner, dispose, sweep, get pendingCount() { return records.size; } };
}
module.exports = { createManagedResultTransfers, CHUNK_BYTES, CHUNK_ITEMS };
