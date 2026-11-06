'use strict';
const { readManagedResult,inspectManagedSource } = require('./analysis-result-wire.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { createHash } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');
const { context, stamp, hydrate } = require('./surface-analysis.cjs');
const { readChecked, directoryIdentity } = require('./portable-storage.cjs');
const { progressIdentity, createMultiwfnProgress } = require('./multiwfn-progress.cjs');
const SCIENCE = new Set(['generate', 'contributions']);
const METHODS = ['iri', 'rdg', 'igmh', 'migm', 'igm'];
function fragments(raw, method, atomCount) {
  assert(Array.isArray(raw), 'Explicit interaction fragments required');
  if (method === 'iri' || method === 'rdg') assert(!raw.length, 'Global interaction methods do not accept fragments');
  else assert(raw.length >= 2 && raw.length <= atomCount, 'At least two nonempty interaction fragments required');
  const ids = new Set(), atoms = new Set();
  for (const fragment of raw) {
    assert(plain(fragment) && string(fragment.id, 256) && !ids.has(fragment.id) && string(fragment.label, 512) && Array.isArray(fragment.atomIndices) && fragment.atomIndices.length, 'Invalid/duplicate interaction fragment'); ids.add(fragment.id);
    for (const index of fragment.atomIndices) { assert(Number.isSafeInteger(index) && index > 0 && index <= atomCount && !atoms.has(index), 'Invalid/overlapping interaction atom'); atoms.add(index); }
  }
}
function checkedRequest(operation, raw, s) {
  assert(plain(raw), 'Interaction request required'); const identity = stamp(raw.stamp, s.context);
  const allowed = operation === 'generate' ? ['stamp', 'method', 'fragments', 'quality'] : operation === 'contributions' ? ['stamp', 'method', 'fragments', 'pair', 'integrationQuality'] : operation === 'restore-fields' ? ['stamp', 'generationId'] : ['stamp', 'fieldId'];
  assert(Object.keys(raw).every(key => allowed.includes(key)), 'Unknown interaction request field');
  if (SCIENCE.has(operation)) {
    assert(s.info.methods.includes(raw.method), 'Interaction method is unavailable for this source'); fragments(raw.fragments, raw.method, s.info.atomCount);
    if (operation === 'generate') assert(plain(raw.quality) && (['low', 'medium', 'high'].includes(raw.quality.mode) && Object.keys(raw.quality).length === 1
      || raw.quality.mode === 'target-points' && Object.keys(raw.quality).length===2 && [32768,4096000].includes(raw.quality.targetPoints)
      || raw.quality.mode === 'spacing' && Object.keys(raw.quality).length === 2 && Number.isFinite(raw.quality.spacingBohr) && raw.quality.spacingBohr > 0
      || raw.quality.mode === 'dimensions' && Object.keys(raw.quality).length === 2 && Array.isArray(raw.quality.dimensions) && raw.quality.dimensions.length === 3
      && raw.quality.dimensions.every(value => Number.isSafeInteger(value) && value >= 2) && Number.isSafeInteger(raw.quality.dimensions.reduce((total, value) => total * value, 1)*8)), 'Invalid interaction grid quality');
    else assert(['igmh', 'migm'].includes(raw.method) && [2, 3, 4].includes(raw.integrationQuality) && Array.isArray(raw.pair) && raw.pair.length === 2 && raw.pair[0] !== raw.pair[1] && raw.pair.every(id => raw.fragments.some(fragment => fragment.id === id)), 'Invalid explicit interaction contribution pair/quality');
  } else assert(string(operation === 'restore-fields' ? raw.generationId : raw.fieldId, 256), 'Interaction artifact identity required');
  return { ...structuredClone(raw), stamp: identity };
}

/** Independent analysis owner, sharing the existing single-Multiwfn lease.
 * Surface's pure context/stamp/scalar wire decoder are reused, never its
 * density-only scientific service or capabilities. No renderer path is trusted. */
function createInteractionAnalysisHost({ spawn, resolveRuntime, resolveBackend, resolveResources, captureResources, jobRoot, scheduler, sendProgress = () => {}, limits = {} }) {
  assert(scheduler && typeof resolveResources === 'function', 'Interaction host requires the shared scheduler/resource owner');
  const policy = { requestMs: 0, stopMs: 6000, ...limits };
  const sessions = new Map(), pending = new Map(), tasks = new Set(), closedOwners = new Set(); let worker, disposed = false, sequence = 0;
  function track(promise) { tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; }
  function owned(owner, id) { const s = sessions.get(id); assert(s && s.owner === owner && !s.closed && !s.failed && !closedOwners.has(owner) && !disposed, 'Interaction session is not owned/available'); return s; }
  function clean(s) { return s.cleanup ??= (async () => {
    if (!s.directory) return;
    const files = [], directories = [], root = path.resolve(s.directory);
    assert(root.startsWith(path.resolve(jobRoot) + path.sep), 'Interaction cleanup escaped its owned session');
    async function list(directory) {
      await directoryIdentity(directory); directories.push(directory);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), stat = await fs.lstat(file);
        assert(!stat.isSymbolicLink(), 'Interaction cleanup preserves unexpected links');
        if (stat.isDirectory()) await list(file);
        else { assert(stat.isFile() && stat.nlink === 1, 'Interaction cleanup preserves shared/unknown files'); files.push({ file, dev: stat.dev, ino: stat.ino }); }
      }
    }
    try { await list(root); } catch (error) { if (error.code === 'ENOENT' && !directories.length) return; throw error; }
    // Native/executor settlement precedes this exact manifest. Never recurse
    // through links or replace a file manifest with a broad directory delete.
    for (const row of files) { await directoryIdentity(path.dirname(row.file)); const stat = await fs.lstat(row.file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === row.dev && stat.ino === row.ino, 'Interaction cleanup file identity changed'); await fs.unlink(row.file); }
    for (const directory of directories.reverse()) { await directoryIdentity(directory); await fs.rmdir(directory); }
  })(); }
  async function stopWorker(w = worker, error = new Error('Interaction worker closed')) {
    if (!w) return;
    if (!w.closing) { w.closing = true; try { w.child.stdin.end(); } catch {} w.timer = setTimeout(() => { if (!w.closed) w.child.kill(); }, policy.stopMs); w.timer.unref?.(); }
    await w.finished;
    for (const [id, entry] of pending) if (entry.w === w) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
  }
  function ensureWorker() {
    assert(!disposed, 'Interaction host disposed'); if (worker) { assert(!worker.closing, 'Interaction worker is stopping'); return worker; }
    const runtime = resolveRuntime(), child = spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } });
    const w = worker = { child, closed: false, closing: false, parts: [], bytes: 0 };
    w.finished = new Promise(resolve => { w.finish = resolve; });
    function message(packet) {
      assert(plain(packet), 'Invalid interaction worker packet'); const entry = pending.get(packet.id);
      assert(entry && packet.sessionId === entry.s.sessionId, 'Interaction reply owner/request identity changed');
      if (packet.event === 'task-progress') { assert(plain(packet.progress), 'Invalid interaction progress'); entry.progress?.report(packet.progress.phase, packet.progress); return; }
      assert(typeof packet.ok === 'boolean', 'Invalid interaction worker status');
      if (SCIENCE.has(entry.operation) && packet.nativeSettled !== true) { void stopWorker(w, new Error('INTERACTION_NATIVE_UNSETTLED')).catch(() => {}); return; }
      if (packet.retainedMemoryBytes !== undefined) { assert(Number.isSafeInteger(packet.retainedMemoryBytes) && packet.retainedMemoryBytes >= 0, 'Invalid interaction reservation'); entry.s.retainedBytes = packet.retainedMemoryBytes; }
      if (!packet.ok) assert(plain(packet.error) && string(packet.error.code, 128) && string(packet.error.message, 16384), 'Invalid interaction error');
      pending.delete(packet.id); clearTimeout(entry.timer); packet.ok ? entry.resolve(packet.result) : entry.reject(new Error(packet.error.code + ': ' + packet.error.message));
    }
    child.stdout.on('data', chunk => { if (w.closing) return; try { let bytes = Buffer.from(chunk); while (bytes.length) { const index = bytes.indexOf(10), part = index < 0 ? bytes : bytes.subarray(0, index); w.parts.push(part); w.bytes += part.length; if (index < 0) break; const line = Buffer.concat(w.parts, w.bytes).toString('utf8'); w.parts = []; w.bytes = 0; message(JSON.parse(line)); bytes = bytes.subarray(index + 1); } } catch (error) { void stopWorker(w, error); } });
    child.stderr.on('data', () => {}); child.stdin.on('error', error => { void stopWorker(w, error); }); child.on('error', error => { void stopWorker(w, error); });
    child.once('close', code => { w.closed = true; clearTimeout(w.timer); if (worker === w) { worker = null; for (const s of sessions.values()) if (s.worker === w) s.failed = true; } w.finish(code); for (const [id, entry] of pending) if (entry.w === w) { clearTimeout(entry.timer); pending.delete(id); entry.reject(new Error('Interaction worker exited (' + code + ')')); } });
    return w;
  }
  function request(operation, s, payload = {}, progress) {
     const w = ensureWorker(), id = 'interaction-' + ++sequence; if (operation === 'open') s.worker = w;
    return new Promise((resolve, reject) => { const timer = policy.requestMs>0?setTimeout(() => { void stopWorker(w, new Error('INTERACTION_TIMEOUT')); }, policy.requestMs):undefined; timer?.unref?.(); pending.set(id, { w, s, operation, resolve, reject, timer, progress }); try { w.child.stdin.write(JSON.stringify({ id, operation, sessionId: s.sessionId, ...payload }) + '\n'); } catch (error) { void stopWorker(w, error); } }).then(value=>readManagedResult(value,s.directory));
  }
  async function resources(owner, s, lease, captured) { const value = await resolveResources(owner,undefined,captured); assert(plain(value) && Number.isSafeInteger(value.threads) && value.threads > 0 && Number.isSafeInteger(value.memoryBudgetBytes) && value.memoryBudgetBytes > 0, 'Interaction resources unavailable'); const budget = lease.budget(value.memoryBudgetBytes, { domain: 'interactions', sessionId: s.sessionId }); return { ...value, memoryBudgetBytes: budget.availableBytes, sharedReservedBytes: budget.reservedBytes, configuredMemoryBudgetBytes: budget.memoryBudgetBytes }; }
  function reservePublished(s, result, lease, ceiling) {
    if (!plain(result.fields) || !result.mapping) return;
    const batch = new Map(); let added = 0;
    for (const field of [...Object.values(result.fields), result.mapping]) {
      assert(plain(field) && string(field.id, 512) && field.values instanceof Float64Array && !batch.has(field.id), 'Invalid/duplicate published interaction field');
      const values = Buffer.from(field.values.buffer, field.values.byteOffset, field.values.byteLength), mask = field.validDomain?.mask;
      assert(mask === undefined || mask instanceof Uint8Array, 'Invalid published interaction mask');
      const bytes = values.length + (mask?.byteLength ?? 0), hash = createHash('sha256').update(values);
      if (mask) hash.update(mask);
      hash.update(JSON.stringify(field, (key, value) => key === 'values' || key === 'mask' ? undefined : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value));
      const identity = { bytes, sha256: hash.digest('hex') }, previous = s.published?.get(field.id);
      assert(!previous || same(previous, identity), 'Interaction field id was reused for different content');
      batch.set(field.id, identity); if (!previous) added += bytes;
    }
    const available = lease.budget(ceiling, { domain: 'interactions', sessionId: s.sessionId }).availableBytes;
    assert(Number.isSafeInteger(added) && added <= available, 'INTERACTION_MEMORY_BUDGET: Published fields exceed the remaining shared ceiling');
    s.published ??= new Map(); for (const [id, identity] of batch) s.published.set(id, identity);
  }
  async function open(owner, trusted) {
    assert(Number.isSafeInteger(owner) && owner >= 0 && !disposed && !closedOwners.has(owner) && plain(trusted) && string(trusted.sessionId, 200) && !sessions.has(trusted.sessionId), 'Interaction owner/session unavailable');
    const s = { owner, sessionId: trusted.sessionId, context: context(trusted.context), closed: false, retainedBytes: 0, inflight: new Set(), opening: new AbortController() }; sessions.set(s.sessionId, s);
    let lease;
    try {
      assert(['wavefunction', 'structure'].includes(trusted.kind), 'Invalid interaction source');
      if (trusted.kind === 'wavefunction') { assert(path.isAbsolute(trusted.sourcePath), 'Host-resolved wavefunction path required'); const snapshot = await inspectManagedSource(trusted.sourcePath); assert(snapshot.sha256 === trusted.sourceRevision, 'Interaction source snapshot changed'); }
      else { const atoms = trusted.structure?.atoms; assert(!trusted.structure?.cell && !trusted.structure?.periodicSource, 'Only isolated finite interaction structures are supported'); assert(Array.isArray(atoms) && atoms.length && atoms.every(atom => string(atom.id, 256) && string(atom.element, 3) && [atom.x, atom.y, atom.z].every(Number.isFinite)) && new Set(atoms.map(atom => atom.id)).size === atoms.length, 'Invalid finite interaction structure snapshot'); }
      lease = await scheduler.acquire({ owner, key: 'interactions:open:' + s.sessionId, signal: s.opening.signal }); owned(owner, s.sessionId);
      const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,s.opening.signal):undefined;owned(owner,s.sessionId);assert(!s.opening.signal.aborted,'INTERACTION_CANCELLED');
      const backend = await resolveBackend(); assert(backend.configured && string(backend.path, 4096), 'INTERACTION_BACKEND_MISSING');
      s.backendPath=backend.path;
      const configured = await resources(owner, s, lease, captured); if (worker?.closing) await worker.finished; owned(owner, s.sessionId); await fs.mkdir(jobRoot, { recursive: true }); s.directory = await fs.mkdtemp(path.join(jobRoot, 'interaction-'));
      const result = await request('open', s, { source: { ...trusted, sessionId: undefined, context: s.context }, workspacePath: s.directory, executable: backend.path, resources: configured }); owned(owner, s.sessionId);
      assert(plain(result) && result.sessionId === s.sessionId && same(context(result.context), s.context) && Array.isArray(result.methods) && result.methods.length && result.methods.every(method => METHODS.includes(method)) && (trusted.kind !== 'structure' || same(result.methods, ['migm', 'igm'])) && Number.isSafeInteger(result.atomCount) && result.atomCount > 0 && Number.isSafeInteger(result.retainedMemoryBytes) && result.retainedMemoryBytes >= 0, 'Interaction open identity/capabilities changed');
      s.info = result; s.retainedBytes = result.retainedMemoryBytes; return result;
    } catch (error) { if (worker && !worker.closing) await request('close', s).catch(() => {}); if (worker?.closing) await worker.finished; sessions.delete(s.sessionId); try { await clean(s); } finally { if (!sessions.size) await stopWorker(); } throw error; }
    finally { lease?.release(); }
  }
  async function operate(owner, id, operation, raw) {
    const s = owned(owner, id); assert(s.info && !s.busy, 'INTERACTION_BUSY'); const checked = checkedRequest(operation, raw, s), controller = new AbortController();
    assert(!s.analysisId || s.analysisId === checked.stamp.analysisId, 'Interaction analysis owner changed'); s.analysisId = checked.stamp.analysisId;
    if (SCIENCE.has(operation)) { s.requestIds ??= new Set(); assert(!s.requestIds.has(checked.stamp.requestId), 'Interaction science request identity already used'); s.requestIds.add(checked.stamp.requestId); }
    s.busy = true; s.controller = controller;
    const scientific = SCIENCE.has(operation);
    const progress = createMultiwfnProgress(progressIdentity({ ownerId: checked.stamp.analysisId, analysisId: checked.stamp.analysisId, runId: checked.stamp.requestId, sessionId: id, sourceId: s.context.sourceId, sourceRevision: s.context.sourceRevision, jobIndex: s.context.jobIndex, sourceFrameIndex: s.context.sourceFrameIndex, generation: s.context.generation, operation }, { sessionId: id, sourceId: s.context.sourceId, sourceRevision: s.context.sourceRevision }), value => sendProgress(owner, value)); s.progress = progress; progress.report('queued', scientific ? {} : { stageLabel: '等待读取资源' });
    let lease, submitted = false, passed = false;
    try {
      lease = await scheduler.acquire({ owner, key: 'interactions:' + (scientific ? operation : 'read') + ':' + id, signal: controller.signal }); owned(owner, id); assert(!controller.signal.aborted, 'INTERACTION_CANCELLED');
      const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,controller.signal):undefined;owned(owner,id);assert(!controller.signal.aborted,'INTERACTION_CANCELLED');
      if(scientific){const backend=await resolveBackend();owned(owner,id);assert(!controller.signal.aborted,'INTERACTION_CANCELLED');assert(backend.configured&&string(backend.path,4096)&&path.resolve(backend.path).toLowerCase()===path.resolve(s.backendPath).toLowerCase(),'INTERACTION_BACKEND_CHANGED: Multiwfn 路径已变化或不可用，请重新打开此分析来源；已有结果保留。');}
      const configured = await resources(owner, s, lease, captured);
      if (operation === 'generate' && checked.quality.mode === 'dimensions') {
        const points = checked.quality.dimensions.reduce((total, value) => total * value, 1), fields = ['iri', 'rdg'].includes(checked.method) ? 2 : 4;
      }
      owned(owner, id); assert(!controller.signal.aborted, 'INTERACTION_CANCELLED'); submitted = true; progress.report(scientific ? 'running' : 'reading', scientific ? {} : { stageLabel: '读取已保存数据' });
      const result = await request(operation, s, { request: checked, resources: configured }, progress); owned(owner, id); assert(!controller.signal.aborted, 'INTERACTION_CANCELLED');
      assert(plain(result), 'Invalid interaction result');
      if (operation === 'export-cube') assert(string(result.name, 512) && path.basename(result.name) === result.name && typeof result.text === 'string' && (!result.domain || string(result.domain.name, 512) && path.basename(result.domain.name) === result.domain.name && typeof result.domain.text === 'string'), 'Unsafe interaction Cube export');
      else { assert(same(stamp(result.stamp, s.context), checked.stamp), 'Interaction result stamp changed'); if (SCIENCE.has(operation)) assert(result.method === checked.method && same(result.fragments, checked.fragments) && (operation === 'generate' ? same(result.quality, checked.quality) : same(result.pair, checked.pair) && result.integrationQuality === checked.integrationQuality), 'Interaction scientific request identity changed'); }
      const value = hydrate(result); reservePublished(s, value, lease, configured.configuredMemoryBudgetBytes); passed = true; progress?.report('parse', { stageLabel: '等待结果接受', validated: true, settlement: 'native-settled' }); return value;
    } finally { lease?.release(); if (controller.signal.aborted) progress?.report('stopped', { settlement: submitted ? 'native-settled' : 'cancelled-before-start' }); else if (!passed) progress?.report('failed', { settlement: submitted ? 'native-settled' : 'not-started' }); if (s.controller === controller) s.controller = null; s.progress = null; s.busy = false; }
  }
  function operation(owner, id, name, raw) { const s = owned(owner, id), task = operate(owner, id, name, raw); s.inflight.add(task); task.then(() => s.inflight.delete(task), () => s.inflight.delete(task)); return track(task); }
  async function cancel(owner, id) { const s = owned(owner, id); s.controller?.abort(); s.progress?.report('stopping'); const running = [...s.inflight]; if (worker && !worker.closing) { const result = await request('cancel', s); if (result?.nativeSettled !== true) await stopWorker(worker, new Error('Interaction cancel did not settle native')); } await Promise.allSettled(running); return { cancelled: true, nativeSettled: true, activeOperationPending: false }; }
  async function closeSession(owner, id) {
    const s = sessions.get(id); if (!s) return { sessionId: id, status: 'closed' }; assert(s.owner === owner, 'Interaction session belongs to another owner'); if (s.closeTask) return s.closeTask;
    s.closed = true; s.opening.abort(); s.controller?.abort();
    return s.closeTask = (async () => { try { await s.openTask?.catch(() => {}); if (sessions.has(id) && worker && !worker.closing) await request('close', s); await Promise.allSettled([...s.inflight]); if (worker?.closing) await worker.finished; } finally { sessions.delete(id); try { await clean(s); } finally { if (!sessions.size) await stopWorker(); } } return { sessionId: id, status: 'closed' }; })();
  }
  async function closeOwner(owner) { closedOwners.add(owner); await Promise.all([...sessions.values()].filter(s => s.owner === owner).map(s => closeSession(owner, s.sessionId))); }
  function dispose() { if (disposed) return; disposed = true; for (const s of sessions.values()) { s.closed = true; s.opening.abort(); s.controller?.abort(); } const before = [...tasks]; track((async () => { await stopWorker(); await Promise.allSettled(before); for (const s of sessions.values()) await clean(s); sessions.clear(); })()); }
  return { open: (...args) => { const task = open(...args), s = sessions.get(args[1]?.sessionId); if (s) s.openTask = task; return track(task); }, generate: (owner, id, raw) => operation(owner, id, 'generate', raw), contributions: (owner, id, raw) => operation(owner, id, 'contributions', raw), restoreFields: (owner, id, raw) => operation(owner, id, 'restore-fields', raw), exportCube: (owner, id, raw) => operation(owner, id, 'export-cube', raw), cancel: (...args) => track(cancel(...args)), closeSession: (...args) => track(closeSession(...args)), closeOwner: (...args) => track(closeOwner(...args)), dispose,
    settle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); }, workerCount: () => worker && !worker.closed ? 1 : 0, sessionCount: () => sessions.size, activeCount: () => [...sessions.values()].filter(s => s.busy || !s.info).length,
    reservedMemoryBytes: () => [...sessions.values()].reduce((total, s) => total + s.retainedBytes + [...(s.published?.values() ?? [])].reduce((bytes, field) => bytes + field.bytes, 0), 0), evidence: (owner, id) => request('evidence', owned(owner, id)) };
}
module.exports = { createInteractionAnalysisHost, checkedRequest };
