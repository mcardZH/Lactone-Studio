'use strict';
const { createHash, randomBytes } = require('node:crypto');
const { assert, plain } = require('./security.cjs');
const { createConformerBatchStore } = require('./conformer-batch-store.cjs');
const token = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(value);
const failure = error => ({ code: token(error?.code) ? error.code : 'CONFORMER_BATCH_FAILED', message: String(error?.message ?? error).slice(0, 8192) });
const recordHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Scheduling only: all scientific validation stays in the trusted existing
 * engine adapters. launch.promise observes actual native close; release runs
 * only after the canonical terminal record and manifest have been committed. */
function createConformerOptimizationBatch({ root, store = createConformerBatchStore({ root }), launchCandidate, resolveCapacity,
  assertCurrent = () => {}, sendToOwner = () => {}, resolveResources, captureRuntime, onRunStart, now = Date.now, limits = {} }) {
  assert(typeof launchCandidate === 'function' && typeof resolveCapacity === 'function', 'Trusted batch launch and resource adapters required');
  const policy = { maxUploadBytes: 8 * 1024 ** 2, readPageTargetBytes: 8 * 1024 ** 2, maxUploadCount: 32, maxReadCount: 64, ...limits };
  const batches = new Map(), closedOwners = new Set(), closingOwners = new Set(); let disposed = false, disposing = false;
  function owned(owner, id) { assert(!disposed && !closedOwners.has(owner), 'Conformer batch owner closed'); const batch = batches.get(id); assert(batch && batch.owner === owner, 'Conformer batch is not owned'); return batch; }
  function counts(b) { const c = { succeeded: 0, discarded: 0, pending: 0, running: 0 }; for (const status of b.states) c[status]++; return c; }
  function snapshot(b) {
    const c = counts(b), elapsedMs = b.elapsedMs + (b.startedAt === undefined ? 0 : Math.max(0, now() - b.startedAt));
    const processed = c.succeeded + c.discarded - (b.baseline ?? 0), remaining = c.pending + c.running;
    return { schema: 1, batchId: b.id, identity: structuredClone(b.request.identity), seq: b.seq, phase: b.phase, total: b.request.total, ...c,
      elapsedMs, etaMs: processed > 0 && b.startedAt !== undefined ? Math.max(0, now() - b.startedAt) / processed * remaining : null,
      ...(['completed', 'stopped', 'error'].includes(b.phase) && b.request.resources ? { requestedResources: structuredClone(b.request.resources) } : {}),
      ...(b.error ? { error: { ...b.error } } : {}) };
  }
  function emit(b) { b.seq++; const value = snapshot(b); try { sendToOwner(b.owner, value); } catch { /* Owner shutdown calls closeOwner; event delivery cannot corrupt a commit. */ } return value; }
  function manifest(b) { return { schema: 1, id: b.id, owner: b.owner, request: b.request, received: b.received, sealed: b.sealed,
    states: b.states, commits: b.commits, uncommitted: [...b.uncommitted],
    phase: b.phase, seq: b.seq, elapsedMs: b.elapsedMs, error: b.error, runResources: b.runResources }; }
  const runtimeRequest = b => ({ ...structuredClone(b.request), requestedResources: structuredClone(b.request.resources), resources: structuredClone(b.runResources) });
  const save = b => store.write(b.id, 'manifest.json', manifest(b));
  // Serialize metadata publications while candidate work remains concurrent.
  function transaction(b, operation) { const task = b.io.then(operation); b.io = task.catch(() => {}); return task; }
  async function begin(owner, request) {
    assert(!disposed && !disposing && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner) && !closingOwners.has(owner) && plain(request), 'Invalid batch owner/request');
    const identity = request.identity;
    assert(plain(identity) && ['taskId', 'runId', 'stageId'].every(key => token(identity[key])) && Number.isSafeInteger(identity.revision) && identity.revision >= 0, 'Invalid batch identity');
    assert(Number.isSafeInteger(request.total) && request.total > 0 && ['xtb', 'forcefield'].includes(request.method?.backend), 'Invalid batch input/method');
    assert(request.total <= 0xffffffff, 'Candidate count exceeds the batch index representation');
    assert(Buffer.byteLength(JSON.stringify(request)) <= policy.maxUploadBytes, 'Batch metadata exceeds bound');
    assertCurrent(owner, request);
    const id = `cb-${randomBytes(16).toString('hex')}`, b = { id, owner, request: structuredClone(request), received: 0, sealed: false, states: Array(request.total).fill('pending'), commits: {}, uncommitted: new Set(), phase: 'registering', seq: 0, elapsedMs: 0, active: new Map(), ids: new Set(), io: Promise.resolve() };
    await store.create(id, manifest(b));
    if(disposed || disposing || closedOwners.has(owner) || closingOwners.has(owner)) { await store.destroy(id); throw Error('Conformer batch owner closed during registration'); }
    batches.set(id, b); return { batchId: id };
  }
  async function upload(owner, id, { offset, inputs }) {
    const b = owned(owner, id);
    return transaction(b, async () => {
      assert(b.phase === 'registering' && offset === b.received && Array.isArray(inputs) && inputs.length > 0 && inputs.length <= policy.maxUploadCount && offset + inputs.length <= b.request.total, 'Invalid contiguous batch upload');
      assert(inputs.length === 1 || Buffer.byteLength(JSON.stringify(inputs)) <= policy.maxUploadBytes, 'Batch upload must send a large candidate by itself');
      const ids = new Set();
      for (const input of inputs) { assert(plain(input) && token(input.candidateId) && !ids.has(input.candidateId) && !b.ids.has(input.candidateId) && plain(input.source) && Array.isArray(input.source.structure?.atoms) && input.source.structure.atoms.length > 0, 'Invalid or duplicate batch candidate'); ids.add(input.candidateId); }
      assertCurrent(owner, b.request);
      for (let index = 0; index < inputs.length; index++) await store.write(id, `input-${offset + index}.json`, inputs[index]);
      b.received += inputs.length;
      try { await save(b); } catch (error) { b.received -= inputs.length; throw error; }
      for (const value of ids) b.ids.add(value);
      return { received: b.received };
    });
  }
  async function seal(owner, id) {
    const b = owned(owner, id);
    return transaction(b, async () => {
      assert(b.phase === 'registering' && b.received === b.request.total, 'Batch inputs incomplete');
      b.sealed = true; b.phase = 'ready';
      try { await save(b); } catch (error) { b.sealed = false; b.phase = 'registering'; throw error; }
      return emit(b);
    });
  }
  function halt(b, error) {
    b.error ??= failure(error);
    if (b.phase === 'running') { b.phase = 'stopping'; b.runtimeAbort?.abort(); emit(b); }
    for (const record of b.active.values()) void Promise.resolve().then(() => record.job?.stop()).catch(error => { b.error ??= failure(error); });
  }
  async function candidate(b, index, record) {
    let job, committed = false, releaseStarted = false;
    try {
      const input = await store.read(b.id, `input-${index}.json`);
      if (b.phase !== 'running') { b.states[index] = 'pending'; return; }
      assertCurrent(b.owner, b.request);
      await transaction(b, () => save(b));
      if (b.phase !== 'running') { b.states[index] = 'pending'; return; }
      job = record.job = launchCandidate(b.owner, { batchId: b.id, ...runtimeRequest(b), capturedRuntime:b.capturedRuntime, input, index });
      assert(job && job.promise && typeof job.stop === 'function', 'Invalid native batch adapter');
      if (b.phase !== 'running') void Promise.resolve(job.stop()).catch(error => halt(b, error));
      const outcome = await job.promise;
      assert(outcome && ['succeeded', 'discarded', 'pending'].includes(outcome.status), 'Invalid native candidate outcome');
      if (outcome.status === 'pending' && b.phase === 'running')
        throw Object.assign(Error(outcome.reason?.message ?? 'Native candidate did not start'), { code: outcome.reason?.code, nativeStarted: false });
      if (outcome.status === 'succeeded' || outcome.result)
        assert(outcome.result && Number.isFinite(outcome.result.energyHartree) && Array.isArray(outcome.result.structure?.atoms), 'Native candidate has no accepted canonical result');
      await transaction(b, async () => {
        const result = { index, candidateId: input.candidateId, status: outcome.status, ...(outcome.result ? { result: outcome.result } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) };
        const digest = recordHash(result);
        await store.write(b.id, `result-${index}.json`, result);
        b.states[index] = outcome.status; b.commits[index] = digest;
        try { await save(b); }
        catch (error) { b.states[index] = 'running'; delete b.commits[index]; throw error; }
        committed = true; emit(b);
      });
      releaseStarted = true; await job.release?.({ committed: true, ...(outcome.preserveDiagnostics ? { preserveDiagnostics: true } : {}) });
    } catch (error) {
      // Protocol, persistence and start errors are batch errors, never silent D.
      if (!committed && !job) b.states[index] = 'pending';
      if (!committed && job) {
        b.states[index] = 'pending';
        // A registered adapter is not evidence of spawn. A possible native
        // result without a committed manifest must remain available for recovery.
        if (error.nativeStarted !== false) b.uncommitted.add(index);
      }
      halt(b, error);
      // Keep an uncommitted engine result/its owned files available to recover.
      if(job && !releaseStarted) { releaseStarted = true; await Promise.resolve().then(() => job.release?.({ committed: false, error: failure(error) })).catch(releaseError => { b.error ??= failure(releaseError); }); }
    } finally {
      b.active.delete(index);
    }
  }
  async function run(b) {
    let releaseStage;
    try {
      // Renderer resources are provenance/request hints only. A trusted host
      // snapshot is captured once for this start and passed to every child.
      if(captureRuntime){b.runtimeAbort=new AbortController();b.capturedRuntime = await captureRuntime(b.owner, structuredClone(b.request),{signal:b.runtimeAbort.signal});}
      b.runResources = await resolveResources?.(b.owner, structuredClone(b.request));
      if (b.phase !== 'running') return;
      if(b.runResources) { assert(Number.isSafeInteger(b.runResources.threads) && b.runResources.threads > 0 && Number.isSafeInteger(b.runResources.memoryBudgetBytes) && b.runResources.memoryBudgetBytes > 0, 'Invalid trusted batch resources'); b.runResources = structuredClone(b.runResources); }
      releaseStage = await onRunStart?.(b.owner, runtimeRequest(b));
      assert(releaseStage === undefined || typeof releaseStage === 'function', 'Invalid batch lifecycle release');
      if (b.phase !== 'running') return;
      const capacity = await resolveCapacity(b.owner, runtimeRequest(b));
      assert(Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 1024, 'Invalid native batch capacity');
      while (b.phase === 'running' || b.active.size) {
        while (b.phase === 'running' && b.active.size < capacity) {
          const index = b.states.indexOf('pending'); if (index < 0) break;
          b.states[index] = 'running'; const record = {}; b.active.set(index, record);
          record.task = candidate(b, index, record); emit(b);
        }
        if (!b.active.size) break;
        await Promise.race([...b.active.values()].map(record => record.task));
      }
    } catch (error) { if(!b.runtimeAbort?.signal.aborted)halt(b, error); }
    finally {
      // Promise.race/one failed release cannot announce a terminal while its
      // sibling candidates still own native closes or queued canonical writes.
      const settled = await Promise.allSettled([...b.active.values()].map(record => record.task));
      for (const result of settled) if (result.status === 'rejected') b.error ??= failure(result.reason);
      await b.io;
      try { await releaseStage?.(); } catch(error) { b.error ??= failure(error); }
      b.elapsedMs += Math.max(0, now() - b.startedAt); b.startedAt = undefined;
      b.phase = b.error ? 'error' : b.states.includes('pending') ? 'stopped' : 'completed';
      await transaction(b, () => save(b)).catch(error => { b.error = failure(error); b.phase = 'error'; }); emit(b);
    }
  }
  async function start(owner, id) {
    const b = owned(owner, id);
    return transaction(b, async () => {
      assert(!disposing && !closingOwners.has(owner) && batches.get(id) === b && b.sealed && b.received === b.request.total
        && ['ready', 'stopped', 'error'].includes(b.phase) && !b.runTask && !b.uncommitted.size && !b.states.includes('running'), 'Batch not ready to start; recover the uncommitted terminal first'); assertCurrent(owner, b.request);
      const previous = b.phase, previousError = b.error;
      b.error = undefined; b.baseline = b.states.filter(status => status === 'succeeded' || status === 'discarded').length;
      b.phase = 'running'; b.startedAt = now();
      try { await save(b); } catch (error) { b.phase = previous; b.error = previousError; b.startedAt = undefined; throw error; }
      b.runTask = run(b).finally(() => { b.runTask = undefined; }); return emit(b);
    });
  }
  async function stop(owner, id) {
    const b = owned(owner, id);
    const active = await transaction(b, async () => {
      if (['registering', 'ready'].includes(b.phase)) {
        const previous = b.phase; b.phase = 'stopped';
        try { await save(b); } catch (error) { b.phase = previous; throw error; }
        emit(b);
      }
      if (b.phase === 'running') { b.phase = 'stopping'; b.runtimeAbort?.abort(); emit(b); }
      return { task: b.runTask, jobs: [...b.active.values()] };
    });
    if (active.task) {
      await Promise.all(active.jobs.map(record => Promise.resolve().then(() => record.job?.stop()).catch(error => { b.error ??= failure(error); })));
      await active.task;
    }
    return snapshot(b);
  }
  async function read(owner, id, { offset, limit }) {
    const b = owned(owner, id); await b.io;
    if (['completed', 'stopped', 'error'].includes(b.phase) && b.runTask) await b.runTask;
    assert(!b.runTask && ['completed', 'stopped', 'error'].includes(b.phase) && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= policy.maxReadCount, 'Invalid terminal batch page');
    const entries = []; let bytes = 0;
    for (let index = offset; index < Math.min(offset + limit, b.received); index++) {
      if (entries.length && bytes >= policy.readPageTargetBytes) break;
      try {
        assert(!b.uncommitted.has(index) && b.states[index] !== 'running',
          'CONFORMER_BATCH_UNCOMMITTED: ' + (b.error?.message ?? 'Native result was not durably committed'));
        const input = await store.read(id, `input-${index}.json`);
        const terminal = b.states[index] === 'pending' ? { index, candidateId: input.candidateId, status: 'pending' } : await store.read(id, `result-${index}.json`);
        assert(terminal.index === index && terminal.candidateId === input.candidateId && terminal.status === b.states[index], 'Canonical result identity/state mismatch');
        if (b.states[index] !== 'pending' && b.commits[index])
          assert(recordHash(terminal) === b.commits[index], 'Canonical result does not match its committed digest');
        const entry = { ...input, index, status: terminal.status, result: terminal.result, reason: terminal.reason };
        const size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 2);
        if (entries.length && bytes + size > policy.readPageTargetBytes) break;
        entries.push(entry); bytes += size;
      } catch (error) {
        if (entries.length) break; // Publish the readable prefix before reporting the affected record.
        throw Error(`CONFORMER_BATCH_RECORD[${index}]: ${failure(error).message}`);
      }
    }
    return { entries, total: b.request.total };
  }
  async function restore(owner, id) {
    if (batches.has(id)) return snapshot(owned(owner, id));
    assert(!disposed && !closedOwners.has(owner), 'Batch owner closed'); const value = await store.read(id, 'manifest.json');
    assert(value.schema === 1 && value.id === id && value.owner === owner && value.states.length === value.request.total
      && Number.isSafeInteger(value.received) && value.received >= 0 && value.received <= value.request.total
      && value.states.every((status, index) => ['pending', 'running', 'succeeded', 'discarded'].includes(status) && (index < value.received || status === 'pending')), 'Batch recovery ownership/manifest mismatch');
    const commits = value.commits ?? {}, uncommitted = value.uncommitted ?? [];
    assert(plain(commits) && Object.entries(commits).every(([index, digest]) => /^\d+$/.test(index) && Number(index) < value.received && /^[a-f0-9]{64}$/.test(digest))
      && Array.isArray(uncommitted) && uncommitted.every(index => Number.isSafeInteger(index) && index >= 0 && index < value.received && value.states[index] === 'pending'), 'Invalid batch commit manifest');
    const b = { ...value, commits, uncommitted: new Set(uncommitted), sealed: value.sealed ?? (value.phase !== 'registering'), active: new Map(), ids: new Set(), io: Promise.resolve() };
    assertCurrent(owner, b.request);
    // A durably closed batch is readable as stored. Leave every original
    // record intact and validate each requested entry at the read boundary.
    if (['completed', 'stopped', 'error'].includes(b.phase) && !b.states.includes('running')) {
      batches.set(id, b); return snapshot(b);
    }
    // A child from an earlier host is never resumed or inferred converged.
    b.states = [...value.states];
    for (let index = 0; index < value.received; index++) {
      let input, terminal;
      try {
        input = await store.read(id, `input-${index}.json`);
        assert(token(input.candidateId) && !b.ids.has(input.candidateId), 'Recovery candidate identity mismatch');
        b.ids.add(input.candidateId);
        if (value.states[index] !== 'running' && value.states[index] !== 'pending') continue;
        try { terminal = await store.read(id, `result-${index}.json`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (terminal) assert(terminal.index === index && terminal.candidateId === input.candidateId
          && ['pending', 'succeeded', 'discarded'].includes(terminal.status), 'Recovery terminal identity mismatch');
      } catch (error) {
        if (value.states[index] !== 'running' && value.states[index] !== 'pending') continue;
        b.states[index] = 'pending'; b.uncommitted.add(index); b.error ??= failure(error);
        continue;
      }
      if (terminal && terminal.status !== 'pending') {
        // Presence of a result file does not commit it. Keep both the file and
        // the manifest's unresolved slot; other slots remain readable.
        b.states[index] = 'pending'; b.uncommitted.add(index);
      } else if (value.states[index] === 'running') {
        b.states[index] = 'pending';
      }
    }
    if (b.uncommitted.size) { b.phase = 'error'; b.error ??= failure(Error('Native batch has an uncommitted canonical record')); }
    else if (['running', 'stopping'].includes(b.phase)) b.phase = 'stopped';
    await save(b); batches.set(id, b); return snapshot(b);
  }
  async function destroy(owner, id) {
    const b = owned(owner, id);
    return transaction(b, async () => {
      assert(!b.runTask && !b.active.size && batches.get(id) === b, 'Cannot destroy an active or released native batch');
      try { await store.destroy(id); }
      catch (error) {
        if (error.code !== 'CONFORMER_BATCH_CLEANUP_FAILED') throw error;
        batches.delete(id);
        return { destroyed: false, retained: true, cleanupWarning: failure(error) };
      }
      batches.delete(id); return { destroyed: true };
    });
  }
  async function closeOwner(owner) { if(closedOwners.has(owner))return; closingOwners.add(owner); const ownedBatches = [...batches.values()].filter(b => b.owner === owner); await Promise.all(ownedBatches.map(b => stop(owner, b.id))); closedOwners.add(owner); closingOwners.delete(owner); }
  async function dispose() { disposing = true; await Promise.all([...new Set([...batches.values()].map(b => b.owner))].map(closeOwner)); disposed = true; }
  return { begin, upload, seal, start, stop, read, restore, destroy, status: async (owner, id) => snapshot(owned(owner, id)), closeOwner, dispose, settle: async owner => Promise.all([...batches.values()].filter(b => owner === undefined || b.owner === owner).map(b => b.runTask)), activeCount: () => [...batches.values()].reduce((sum, b) => sum + Math.max(b.active.size,b.runTask?1:0), 0) };
}
module.exports = { createConformerOptimizationBatch };
