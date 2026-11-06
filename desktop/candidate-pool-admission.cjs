'use strict';
const { assert, plain, string } = require('./security.cjs');
const { attachComputeResourceGrant } = require('./compute-resources.cjs');
const { outputBudget } = require('./output-budget.cjs');

function validateOptimizationPool(request) {
  const value = request.optimizationPool;
  if (value === undefined) return;
  assert(request.runIdentity && (request.operation === 'optimize' || request.calculation === 'optimize')
    && plain(value) && Object.keys(value).length === 2
    && ['stageId', 'candidateId'].every(key => string(value[key], 200) && /^[A-Za-z0-9_:-]+$/.test(value[key])), 'Invalid candidate optimization pool identity');
}

/** One exclusive native lease owns the whole candidate group. Child grants
 * partition that lease; they never request independent global allocations. */
function createCandidatePoolAdmission({ scheduler, resolveResources, assertCurrent, assertInitial = assertCurrent, maxConcurrent = Number.MAX_SAFE_INTEGER, minimumWorkerMemoryBytes = 256 * 1024 ** 2 }) {
  const groups = new Map(), holds = new Map(), heldResources = new Map();
  const keyFor = (owner, identity) => JSON.stringify([owner, identity.taskId, identity.runId, identity.stageId]);
  function releaseIdle(group) {
    if (group.active || group.pending.length || group.starting) return;
    if (!group.failed && (holds.get(group.key) ?? 0) > 0) return;
    if (groups.get(group.key) === group) groups.delete(group.key);
    group.lease?.release();
  }
  function drain(group) {
    if (!group.snapshot) return;
    while (group.pending.length && group.active < group.capacity) {
      const entry = group.pending.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(Error('NATIVE_CANCELLED: 候选优化等待已取消')); continue; }
      try {
        assertCurrent(group.owner, entry.request);
        const configured = group.snapshot.configured ?? group.snapshot;
        const resources = { ...group.snapshot, configured: { threads: configured.threads, memoryBudgetBytes: configured.memoryBudgetBytes, ...(configured.outputBudgetBytes === undefined ? {} : { outputBudgetBytes: configured.outputBudgetBytes }) }, threads: 1, threadLimitReason: '受管候选优化池：每候选1线程',
          requested: { threads: entry.request.threads ?? 1, memoryBudgetBytes: entry.request.memoryBudgetBytes ?? configured.memoryBudgetBytes } };
        let released = false;
        const release = () => { if (released) return; released = true; group.active--; drain(group); releaseIdle(group); };
        release.consumeOutput = bytes => {
          assert(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid candidate output accounting');
          group.outputBytes = (group.outputBytes ?? 0) + bytes;
          assert(group.outputBytes <= outputBudget(group.snapshot), 'XTB_OUTPUT_LIMIT: 整批候选累计输出达到本次上限');
        };
        const budget = { budget: ceiling => {
          assert(ceiling === configured.memoryBudgetBytes, 'Candidate group resource identity changed');
          return { memoryBudgetBytes: ceiling, availableBytes: group.workerMemoryBytes, reservedBytes: ceiling - group.workerMemoryBytes };
        } };
        const granted = attachComputeResourceGrant(release, budget, resources, entry.request);
        group.active++; entry.resolve(granted);
      } catch (error) { entry.reject(error); }
    }
    releaseIdle(group);
  }
  async function initialize(group, request) {
    try {
      group.lease = await scheduler.acquire({ owner: group.owner, key: `advanced:${group.key}`, signal: group.controller.signal });
      assertInitial(group.owner, request);
      group.snapshot = heldResources.has(group.key) ? structuredClone(heldResources.get(group.key)) : await resolveResources(group.owner, request);
      assertCurrent(group.owner, request);
      const configured = group.snapshot.configured ?? group.snapshot;
      const budget = group.lease.budget(configured.memoryBudgetBytes);
      const workerLimit = typeof maxConcurrent === 'function' ? maxConcurrent() : maxConcurrent;
      assert(Number.isSafeInteger(workerLimit) && workerLimit > 0, 'Native candidate worker slots unavailable');
      const schedulingBytes=Math.max(0,budget.availableBytes-(group.snapshot.retainedMemoryEstimateBytes??0));
      group.capacity = Math.min(workerLimit, configured.threads, Math.max(1, Math.floor(schedulingBytes / minimumWorkerMemoryBytes)));
      group.workerMemoryBytes = Math.floor(budget.availableBytes / group.capacity);
      group.starting = false; drain(group);
    } catch (error) {
      group.failed = true;
      group.starting = false;
      for (const entry of group.pending.splice(0)) { entry.signal?.removeEventListener('abort', entry.abort); entry.reject(error); }
      releaseIdle(group);
    }
  }
  function admit(owner, request, { signal } = {}) {
    validateOptimizationPool(request);
    assert(request.optimizationPool && Number.isSafeInteger(owner), 'Candidate pool identity required');
    if (signal?.aborted) return Promise.reject(Error('NATIVE_CANCELLED: 候选优化等待已取消'));
    const key = keyFor(owner, { ...request.runIdentity, stageId: request.optimizationPool.stageId });
    let group = groups.get(key), fresh = false;
    if (!group) { fresh = true; group = { key, owner, pending: [], active: 0, starting: true, controller: new AbortController(), candidateIds: new Set() }; groups.set(key, group); }
    assert(!group.candidateIds.has(request.optimizationPool.candidateId), 'Duplicate candidate within optimization pool');
    group.candidateIds.add(request.optimizationPool.candidateId);
    const promise = new Promise((resolve, reject) => {
      const entry = { request, signal, resolve, reject };
      entry.abort = () => { const index = group.pending.indexOf(entry); if (index < 0) return; group.pending.splice(index, 1); signal?.removeEventListener('abort', entry.abort); reject(Error('NATIVE_CANCELLED: 候选优化等待已取消')); if (!group.active && !group.pending.length && group.starting) group.controller.abort(); releaseIdle(group); };
      signal?.addEventListener('abort', entry.abort, { once: true }); group.pending.push(entry);
    });
    if (fresh) void initialize(group, request); else drain(group);
    return promise;
  }
  /** Pin the existing pool across durable handoff gaps. This reserves no
   * resources until the first child requests normal admission. */
  function hold(owner, identity, resources) {
    assert(Number.isSafeInteger(owner) && owner >= 0 && plain(identity) && ['taskId', 'runId', 'stageId'].every(key => string(identity[key], 200) && /^[A-Za-z0-9_:-]+$/.test(identity[key])), 'Invalid candidate stage hold');
    const key = keyFor(owner, identity);
    if(resources!==undefined) { assert(plain(resources) && Number.isSafeInteger(resources.threads) && resources.threads > 0 && Number.isSafeInteger(resources.memoryBudgetBytes) && resources.memoryBudgetBytes > 0 && !groups.has(key) && !heldResources.has(key), 'Invalid or already active held resource snapshot'); heldResources.set(key, structuredClone(resources)); }
    holds.set(key, (holds.get(key) ?? 0) + 1); let released = false;
    return () => { if (released) return; released = true; const remaining = holds.get(key) - 1; if (remaining) holds.set(key, remaining); else { holds.delete(key); heldResources.delete(key); } const group = groups.get(key); if (group) releaseIdle(group); };
  }
  return { admit, hold, activeGroupCount: () => groups.size };
}
module.exports = { createCandidatePoolAdmission, validateOptimizationPool };
