'use strict';
const { StringDecoder } = require('node:string_decoder');
const { assert, plain, string, validateChemistry, validateStructure, MAX_BYTES } = require('./security.cjs');
const INPUT_LIMIT = 8 * 1024 * 1024;
/** One serial reusable worker; only the existing perceive-bonds operation is accepted. */
function createEmpiricalChemistryHost({ spawn, resolveRuntime, canSpawn = () => true, limits = {} }) {
  const policy = { closeMs: 6000, idleMs: 30000, ...limits };
  assert(typeof spawn === 'function' && typeof resolveRuntime === 'function');
  assert((policy.requestMs === undefined || Number.isSafeInteger(policy.requestMs) && policy.requestMs > 0) && Number.isInteger(policy.closeMs) && policy.closeMs > 0 && policy.closeMs <= 10000 && Number.isInteger(policy.idleMs) && policy.idleMs >= 0 && policy.idleMs <= 60000 && (policy.maxPending === undefined || Number.isSafeInteger(policy.maxPending) && policy.maxPending > 0), 'Invalid empirical worker bounds');
  const pending = [], jobs = new Map(), closedOwners = new Set(); let worker = null, active = null, serial = 0, disposed = false;
  const key = (owner, id) => `${owner}:${id}`;
  function finish(job, error, result) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); jobs.delete(job.key);
    if (active === job) active = null;
    error ? job.reject(error) : job.resolve(result);
  }
  function closeWorker(reason, kill = false) {
    const w = worker; if (!w || w.closing) return;
    w.closing = true; clearTimeout(w.idleTimer);
    if (active?.worker === w) finish(active, new Error(reason));
    try { if (kill) w.child.kill(); else w.child.stdin.end(); } catch { /* Actual close is still required. */ }
    w.killTimer = setTimeout(() => { if (!w.closed) try { w.child.kill(); } catch {} }, policy.closeMs); w.killTimer.unref?.();
  }
  function schedule() { queueMicrotask(pump); }
  function ensureWorker() {
    if (worker) { assert(!worker.closing, 'Empirical worker is closing'); clearTimeout(worker.idleTimer); worker.idleTimer = null; return worker; }
    assert(canSpawn(), 'Native chemistry concurrency limit reached');
    const runtime = resolveRuntime(), child = spawn(runtime.executable, [...runtime.args, '--empirical-worker'], { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const w = worker = { child, decoder: new StringDecoder('utf8'), buffer: '', stderr: '', closing: false, closed: false };
    w.closedPromise = new Promise(resolve => { w.resolveClosed = resolve; });
    child.stdout.on('data', bytes => {
      if (w.closing || worker !== w) return;
      try {
        w.buffer += w.decoder.write(bytes);
        for (;;) {
          const end = w.buffer.indexOf('\n'); if (end < 0) break;
          const line = w.buffer.slice(0, end); w.buffer = w.buffer.slice(end + 1);
          const response = JSON.parse(line), job = active;
          assert(job && job.worker === w && plain(response) && response.id === job.transportId && typeof response.ok === 'boolean', 'Invalid empirical worker response identity');
          if (!response.ok) { assert(plain(response.error) && string(response.error.code) && string(response.error.message, 8192)); finish(job, new Error(response.error.code + ': ' + response.error.message)); }
          else {
            const result = response.result;
            assert(plain(result) && result.operation === job.request.operation && JSON.stringify(result.stamp) === JSON.stringify(job.request.stamp) && Array.isArray(result.warnings) && string(result.engine) && typeof result.engineVersion === 'string', 'Invalid chemistry engine response');
            validateStructure(result.structure); assert(JSON.stringify(result.movableAtomIds) === JSON.stringify(job.request.movableAtomIds), 'Chemistry response movable identities changed');
            if (result.error) finish(job, new Error(`${result.error.code || 'CHEMISTRY_FAILED'}: ${result.error.message || '经验成键失败'}`)); else finish(job, null, result);
          }
          schedule();
        }
      } catch (error) { closeWorker('CHEMISTRY_PROTOCOL: ' + error.message, true); }
    });
    child.stderr.on('data', bytes => { w.stderr = (w.stderr + bytes.toString('utf8')).slice(-8192); });
    child.stdin.on('error', error => closeWorker('CHEMISTRY_INPUT_FAILED: ' + error.message, true));
    child.on('error', error => closeWorker('CHEMISTRY_SPAWN_FAILED: ' + error.message, true));
    child.once('close', (code, signal) => {
      w.closed = true; clearTimeout(w.killTimer); clearTimeout(w.idleTimer);
      if (worker === w) { worker = null; if (active?.worker === w) finish(active, new Error(`CHEMISTRY_WORKER_EXIT: ${code}, ${signal ?? 'none'} ${w.stderr}`)); }
      w.resolveClosed(); schedule();
    });
    return w;
  }
  function pump() {
    if (disposed || active || worker?.closing) return;
    const job = pending.shift();
    if (!job) {
      if (worker && !worker.idleTimer) { worker.idleTimer = setTimeout(() => closeWorker('Empirical worker idle'), policy.idleMs); worker.idleTimer.unref?.(); }
      return;
    }
    if (job.settled || closedOwners.has(job.owner)) { if (!job.settled) finish(job, new Error('CHEMISTRY_CANCELLED: 窗口已关闭')); schedule(); return; }
    try {
      active = job; const w = job.worker = ensureWorker();
      if (policy.requestMs !== undefined) { job.timer = setTimeout(() => closeWorker('CHEMISTRY_TIMEOUT: 原生化学任务超过显式时限', true), policy.requestMs); job.timer.unref?.(); }
      w.child.stdin.write(job.payload + '\n');
    } catch (error) { finish(job, error); schedule(); }
  }
  function start(owner, request, jobId) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner), 'Empirical owner closed');
    assert(string(jobId, 100) && /^[a-zA-Z0-9_-]+$/.test(jobId), 'Invalid chemistry job identity');
    assert(plain(request) && request.operation === 'perceive-bonds', 'Reusable worker accepts empirical perception only'); validateChemistry(request);
    assert(!jobs.has(key(owner, jobId)) && (policy.maxPending === undefined || jobs.size < policy.maxPending), 'Empirical pending budget reached');
    const snapshot = structuredClone(request), transportId = `empirical-${++serial}`, payload = JSON.stringify({ id: transportId, request: snapshot });
    return new Promise((resolve, reject) => { const job = { owner, key: key(owner, jobId), request: snapshot, payload, transportId, resolve, reject, settled: false }; jobs.set(job.key, job); pending.push(job); schedule(); });
  }
  function cancel(owner, jobId, reason = 'CHEMISTRY_CANCELLED: 用户取消任务') {
    const job = jobs.get(key(owner, jobId)); if (!job) return;
    if (job === active) closeWorker(reason, true); else { finish(job, new Error(reason)); const index = pending.indexOf(job); if (index >= 0) pending.splice(index, 1); }
  }
  function closeOwner(owner) { closedOwners.add(owner); for (const job of [...jobs.values()]) if (job.owner === owner) cancel(owner, job.key.slice(String(owner).length + 1), 'CHEMISTRY_CANCELLED: 模型窗口已关闭'); }
  function dispose() {
    // finish() clears active; retain whether shutdown must interrupt native work.
    const hadActive = Boolean(worker && active?.worker === worker);
    disposed = true;
    for (const job of [...jobs.values()]) finish(job, new Error('CHEMISTRY_CANCELLED: 应用退出'));
    pending.length = 0;
    closeWorker('CHEMISTRY_CANCELLED: 应用退出', hadActive);
  }
  return { start, cancel, closeOwner, dispose, settle: () => worker?.closedPromise ?? Promise.resolve(), workerCount: () => worker && !worker.closed ? 1 : 0, activeCount: () => jobs.size };
}
module.exports = { createEmpiricalChemistryHost };
