'use strict';
const { assert, plain } = require('./security.cjs');
const { validateModelDisplay } = require('./model-display-preferences.cjs');
const canonical = value => JSON.stringify(value, (_key, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Runtime presentation is shared only by consumers of the same workspace.
 * Omitting scopeFor preserves the original process-wide sharing contract. */
function createRuntimeModelDisplayStore({ send, scopeFor = () => 'global' }) {
  assert(typeof scopeFor === 'function', 'Invalid runtime model display scope resolver');
  let disposed = false;
  const buckets = new Map(), memberships = new Map();
  const snapshot = bucket => ({ revision: bucket.revision, display: bucket.display === null ? null : structuredClone(bucket.display) });
  const active = () => assert(!disposed, 'Runtime model display store closed');
  function removeOwner(owner) {
    const scope = memberships.get(owner); if (!memberships.has(owner)) return;
    memberships.delete(owner); const bucket = buckets.get(scope); if (!bucket) return;
    bucket.owners.delete(owner); if (!bucket.owners.size) buckets.delete(scope);
  }
  function join(owner) {
    const scope = scopeFor(owner);
    assert(scope !== undefined && scope !== null, 'Runtime model display scope unavailable');
    if (memberships.has(owner) && memberships.get(owner) !== scope) removeOwner(owner);
    let bucket = buckets.get(scope);
    if (!bucket) { bucket = { revision: 0, display: null, key: '', owners: new Set() }; buckets.set(scope, bucket); }
    memberships.set(owner, scope); bucket.owners.add(owner); return bucket;
  }
  return {
    read(owner) { active(); return snapshot(join(owner)); },
    update(owner, request) {
      active(); assert(memberships.has(owner) && memberships.get(owner) === scopeFor(owner), 'Read runtime model display before updating or after changing workspace scope');
      const scope = memberships.get(owner), bucket = buckets.get(scope);
      assert(plain(request) && Object.keys(request).length === 2 && Object.hasOwn(request, 'baseRevision') && Object.hasOwn(request, 'display') && Number.isSafeInteger(request.baseRevision) && request.baseRevision >= 0, 'Invalid runtime model display update');
      const next = validateModelDisplay(request.display), nextKey = canonical(next);
      if (request.baseRevision !== bucket.revision) return { ...snapshot(bucket), accepted: false };
      if (nextKey === bucket.key) return { ...snapshot(bucket), accepted: true };
      assert(bucket.revision < Number.MAX_SAFE_INTEGER, 'Runtime model display revision exhausted');
      bucket.display = next; bucket.key = nextKey; bucket.revision++;
      for (const recipient of bucket.owners) { try { if (scopeFor(recipient) !== scope) { removeOwner(recipient); continue; } send(recipient, snapshot(bucket)); } catch { removeOwner(recipient); } }
      return { ...snapshot(bucket), accepted: true };
    },
    disposeOwner: removeOwner,
    dispose() { disposed = true; memberships.clear(); buckets.clear(); },
  };
}
module.exports = { createRuntimeModelDisplayStore };
