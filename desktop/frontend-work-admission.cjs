'use strict';
const { assert, plain } = require('./security.cjs');

const cancelled = () => Object.assign(new Error('FRONTEND_WORK_CANCELLED: 前台工作资源等待已取消。'), { name: 'AbortError', code: 'FRONTEND_WORK_CANCELLED' });
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const resourceValues = value => plain(value) && Number.isSafeInteger(value.threads) && value.threads > 0 && Number.isSafeInteger(value.memoryBudgetBytes) && value.memoryBudgetBytes > 0;

/** This is an owner/lifetime adapter, not a resource scheduler. The injected
 * admission function owns the single shared CPU/memory budget and grant. */
function createFrontendWorkAdmission({ admit, assertCurrent } = {}) {
  assert(typeof admit === 'function' && typeof assertCurrent === 'function', 'Frontend admission requires the shared scheduler and current-owner validator');
  const owners = new Map(), closedOwners = new Set(); let disposed = false;
  const ownerKey = owner => { assert(Number.isSafeInteger(owner) && owner >= 0, 'Invalid frontend work owner'); return owner; };
  const idKey = id => { assert(typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id), 'Invalid frontend work id'); return id; };
  function snapshot(request) {
    assert(plain(request) && Object.keys(request).length === 2 && ['id', 'stamp'].every(key => Object.hasOwn(request, key)), 'Invalid frontend work request fields');
    for (const key of ['id', 'stamp']) assert(Object.hasOwn(Object.getOwnPropertyDescriptor(request, key), 'value'), 'Frontend work request cannot contain accessors');
    idKey(request.id); assert(plain(request.stamp), 'Invalid frontend work document stamp');
    // Document stamps are scalar identity fields. They do not carry scientific
    // structures, callbacks, paths or caller-provided resource grants.
    const stamp = {};
    for (const key of Object.keys(request.stamp)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe frontend work stamp field');
      const descriptor = Object.getOwnPropertyDescriptor(request.stamp, key);
      assert(descriptor && Object.hasOwn(descriptor, 'value') && (typeof descriptor.value === 'string' || typeof descriptor.value === 'boolean' || typeof descriptor.value === 'number' && Number.isFinite(descriptor.value) || descriptor.value === null), 'Invalid frontend work stamp value');
      stamp[key] = descriptor.value;
    }
    return Object.freeze({ id: request.id, stamp: Object.freeze(stamp) });
  }
  const current = record => {
    if (disposed || closedOwners.has(record.owner)) throw failure('FRONTEND_WORK_OWNER_CLOSED', '前台工作所属窗口已关闭。');
    assertCurrent(record.owner, record.request);
  };
  function remove(record) {
    const group = owners.get(record.owner);
    if (group?.get(record.id) === record) { group.delete(record.id); if (!group.size) owners.delete(record.owner); }
  }
  function releaseGrant(record) {
    if (!record.releaseGrant) return Promise.resolve(false);
    if (record.releasing) return record.releasing;
    record.state = 'releasing';
    record.releasing = Promise.resolve().then(() => record.releaseGrant()).then(() => { record.state = 'released'; remove(record); return true; }, error => { record.state = 'release-failed'; throw error; });
    return record.releasing;
  }
  function cancelRecord(record) {
    if (record.state !== 'waiting') return false;
    record.state = 'cancelled'; record.reject(cancelled()); record.abort.abort(); return true;
  }
  function acquire(owner, raw) {
    try {
      ownerKey(owner); const request = snapshot(raw), id = request.id;
      if (disposed || closedOwners.has(owner)) throw failure('FRONTEND_WORK_OWNER_CLOSED', '前台工作所属窗口已关闭。');
      assertCurrent(owner, request);
      const group = owners.get(owner) ?? new Map();
      if (group.has(id)) throw failure('FRONTEND_WORK_DUPLICATE', '同一前台工作已在等待或持有资源。');
      let resolve, reject;
      const result = new Promise((accept, fail) => { resolve = accept; reject = fail; });
      const record = { owner, id, request, state: 'waiting', abort: new AbortController(), resolve, reject };
      owners.set(owner, group); group.set(id, record);
      record.operation = Promise.resolve().then(async () => {
        if (record.state !== 'waiting') { remove(record); return; }
        let grant;
        try {
          current(record);
          grant = await admit(owner, request, { signal: record.abort.signal });
          assert(typeof grant === 'function', 'Frontend admission must return a trusted release function');
          record.releaseGrant = grant;
          // A cancellation/closed owner can win while an admission backend is
          // still resolving. Never expose or keep that late grant.
          if (record.state !== 'waiting' || record.abort.signal.aborted) { await releaseGrant(record); return; }
          current(record);
          const resources = grant.resources;
          assert(resourceValues(resources) && resourceValues(resources.configured) && resourceValues(resources.requested)
            && typeof resources.version === 'string' && resources.version.length > 0 && typeof resources.source === 'string' && resources.source.length > 0
            && Number.isSafeInteger(resources.reservedBytes) && resources.reservedBytes >= 0 && resources.memoryEnforced === false,
          'FRONTEND_WORK_RESOURCE_GRANT: 缺少共享调度器的实际软资源授权。');
          const evidence = structuredClone(resources); current(record);
          record.state = 'active'; resolve(evidence);
        } catch (error) {
          if (record.releaseGrant) {
            try { await releaseGrant(record); }
            catch (releaseError) { if (record.state !== 'cancelled') reject(releaseError); return; }
          } else remove(record);
          reject(error);
        }
      });
      // The public result owns every acquisition error. The background waiter
      // remains attached after cancellation solely to release a late grant.
      void record.operation.catch(error => { reject(error); });
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  function cancel(owner, id) { ownerKey(owner); idKey(id); return { cancelled: cancelRecord(owners.get(owner)?.get(id) ?? {}) }; }
  async function release(owner, id) {
    ownerKey(owner); idKey(id); const record = owners.get(owner)?.get(id);
    if (!record || !['active', 'releasing', 'release-failed'].includes(record.state)) return { released: false };
    return { released: await releaseGrant(record) };
  }
  async function disposeOwner(owner) {
    ownerKey(owner); closedOwners.add(owner); const releases = [];
    for (const record of owners.get(owner)?.values() ?? []) {
      if (record.state === 'waiting') cancelRecord(record);
      else if (['active', 'releasing', 'release-failed'].includes(record.state)) releases.push(releaseGrant(record));
    }
    // Pending admissions are aborted; ignored aborts retain their attached late
    // cleanup instead of blocking window teardown indefinitely.
    const results = await Promise.allSettled(releases), failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function dispose() {
    disposed = true;
    const results = await Promise.allSettled([...owners.keys()].map(disposeOwner)), failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return { acquire, cancel, release, disposeOwner, dispose };
}
module.exports = { createFrontendWorkAdmission };
