'use strict';
const MARKER = '__esManagedResult';
const typedConstructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
function check(condition, message) { if (!condition) throw new Error(message); }
function descriptor(value) { return value && typeof value === 'object' && value[MARKER] === 'v1'; }
function aborted(signal) { if (signal?.aborted) { const error = new Error('Managed-result transfer cancelled'); error.name = 'AbortError'; throw error; } }

/** invoke(request) is bound to the already-authorized sender by the preload.
 * All references found, including unread siblings, are released on failure. */
async function hydrateManagedResult(value, invoke, { signal } = {}) {
  check(typeof invoke === 'function', 'Managed-result invoke required');
  const tokens = new Set(), released = new Set(), seen = new WeakSet(), managed = new WeakSet();
  function collect(node) {
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node)) return false;
    if (seen.has(node)) return managed.has(node);
    seen.add(node);
    if (descriptor(node)) { check(typeof node.token === 'string', 'Invalid managed-result token'); tokens.add(node.token); managed.add(node); return true; }
    let required = false;
    for (const entry of Object.values(node)) if (collect(entry)) required = true;
    if (required) managed.add(node);
    return required;
  }
  async function release(token) { if (!released.has(token)) { await invoke({ action: 'release', token }); released.add(token); } }
  async function hydrate(node) {
    aborted(signal);
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node) || !managed.has(node)) return node;
    if (!descriptor(node)) {
      let result = node;
      for (const [key, entry] of Object.entries(node)) {
        const hydrated = entry && typeof entry === 'object' && managed.has(entry) ? await hydrate(entry) : entry;
        if (!Object.is(hydrated, entry)) {
          if (result === node) result = Array.isArray(node) ? node.slice() : Object.setPrototypeOf(Object.assign(Object.create(null), node), Object.getPrototypeOf(node));
          Object.defineProperty(result, key, { value: hydrated, enumerable: true, configurable: true, writable: true });
        }
      }
      return result;
    }
    const { token, kind, length } = node;
    check(Number.isSafeInteger(length) && length >= 0 && ['array', 'typed', 'string', 'object'].includes(kind), 'Invalid managed-result descriptor');
    let result, bytes;
    if (kind === 'typed') {
      const Constructor = typedConstructors[node.type]; check(Constructor, 'Invalid managed-result typed array');
      bytes = new Uint8Array(length); result = node.type === 'DataView' ? new DataView(bytes.buffer) : new Constructor(bytes.buffer);
    } else result = kind === 'array' ? new Array(length) : kind === 'string' ? [] : Object.create(node.nullPrototype ? null : Object.prototype);
    let start = 0, failure;
    try {
      while (start < length) {
        aborted(signal); const chunk = await invoke({ action: 'read', token, start }); collect(chunk); aborted(signal);
        check(chunk && Number.isSafeInteger(chunk.next) && chunk.next > start && chunk.next <= length && chunk.done === (chunk.next === length), 'Invalid managed-result chunk progress');
        if (kind === 'typed') { check(chunk.bytes instanceof Uint8Array && chunk.bytes.length === chunk.next - start, 'Invalid managed-result byte chunk'); bytes.set(chunk.bytes, start); }
        else if (kind === 'string') { check(typeof chunk.text === 'string' && chunk.text.length === chunk.next - start, 'Invalid managed-result text chunk'); result.push(chunk.text); }
        else {
          check(Array.isArray(chunk.items) && chunk.items.length === chunk.next - start, 'Invalid managed-result item chunk');
          for (let index = 0; index < chunk.items.length; index++) {
            const entry = chunk.items[index];
            if (kind === 'array') { if (!chunk.holes?.includes(index)) result[start + index] = entry && typeof entry === 'object' && managed.has(entry) ? await hydrate(entry) : entry; }
            else {
              check(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string', 'Invalid managed-result object entry');
              const hydrated = entry[1] && typeof entry[1] === 'object' && managed.has(entry[1]) ? await hydrate(entry[1]) : entry[1];
              Object.defineProperty(result, entry[0], { value: hydrated, enumerable: true, configurable: true, writable: true });
            }
          }
        }
        start = chunk.next;
      }
      return kind === 'string' ? result.join('') : result;
    } catch (error) { failure = error; throw error; }
    // eslint-disable-next-line no-unsafe-finally -- Preserve the hydration error; a sole release failure cannot report success.
    finally { try { await release(token); } catch (error) { if (!failure) throw error; } }
  }
  let primaryFailure;
  try { collect(value); return await hydrate(value); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    let cleanupFailure;
    for (const token of tokens) try { await release(token); } catch (error) { cleanupFailure ??= error; }
    // eslint-disable-next-line no-unsafe-finally -- Preserve cancellation/read failure; a sole release failure must not be reported as success.
    if (!primaryFailure && cleanupFailure) throw cleanupFailure;
  }
}
module.exports = { hydrateManagedResult };
