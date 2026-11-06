'use strict';
const { StringDecoder } = require('node:string_decoder');
const { assert, plain, string, MAX_BYTES } = require('./security.cjs');
const OPERATIONS = new Set(['symmetry', 'primitive', 'conventional', 'p1', 'idealize', 'supercell', 'slab-terminations', 'slab']);
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
function validateGeometry(structure) {
  assert(plain(structure) && string(structure.id) && Array.isArray(structure.atoms) && structure.atoms.length > 0, 'Invalid crystal atom inventory');
  const ids = new Set();
  for (const atom of structure.atoms) {
    assert(plain(atom) && string(atom.id) && !ids.has(atom.id) && /^[A-Z][a-z]?$/.test(atom.element) && [atom.x, atom.y, atom.z].every(Number.isFinite), 'Invalid crystal atom identity or coordinates');
    ids.add(atom.id);
  }
  const cell = structure.cell;
  assert(plain(cell) && Array.isArray(cell.vectors) && cell.vectors.length === 3 && cell.vectors.every(finiteVector) && Array.isArray(cell.pbc) && cell.pbc.length === 3 && cell.pbc.every(v => typeof v === 'boolean'), 'Crystal modeling requires a complete cell');
  const [a,b,c] = cell.vectors, determinant = a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  assert(Math.abs(determinant) > 1e-10 && (cell.origin === undefined || finiteVector(cell.origin)), 'Invalid crystal lattice or origin');
  const seenBonds = new Set();
  assert(structure.bonds === undefined || Array.isArray(structure.bonds), 'Invalid crystal bond inventory');
  for (const bond of structure.bonds ?? []) {
    assert(plain(bond) && Number.isSafeInteger(bond.a) && Number.isSafeInteger(bond.b) && bond.a >= 0 && bond.b >= 0 && bond.a < structure.atoms.length && bond.b < structure.atoms.length && [0.5,1,1.5,2,3].includes(bond.order), 'Invalid crystal bond');
    const image = bond.image ?? [0,0,0];
    assert(finiteVector(image) && image.every(Number.isSafeInteger) && image.every((v, i) => !v || cell.pbc[i]) && (bond.a !== bond.b || image.some(Boolean)), 'Invalid crystal bond image');
    const forward = JSON.stringify([bond.a,bond.b,image]), reverse = JSON.stringify([bond.b,bond.a,image.map(v => -v)]), key = forward < reverse ? forward : reverse;
    assert(!seenBonds.has(key), 'Duplicate crystal connection'); seenBonds.add(key);
  }
  return ids;
}
function validateCrystalRequest(request) {
  assert(plain(request) && Object.keys(request).every(k => ['documentId', 'expectedRevision', 'operation', 'structure', 'parameters'].includes(k)), 'Invalid crystal request fields');
  assert(string(request.documentId) && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0 && OPERATIONS.has(request.operation), 'Invalid crystal source identity or operation');
  validateGeometry(request.structure);
  assert(request.parameters === undefined || plain(request.parameters) && Object.keys(request.parameters).every(k => ['symprec', 'angleTolerance', 'matrix', 'miller', 'thickness', 'thicknessMode', 'start', 'position', 'vacuum', 'repeat', 'termination'].includes(k)), 'Invalid crystal parameters');
  const payload = JSON.stringify(request);
  return payload;
}
function validateCrystalResult(result, request) {
  assert(plain(result) && result.documentId === request.documentId && result.expectedRevision === request.expectedRevision && result.operation === request.operation, 'Crystal response source identity changed');
  if (request.operation === 'symmetry') {
    const value = result.symmetry, ids = new Set(request.structure.atoms.map(a => a.id));
    assert(plain(value) && Number.isInteger(value.number) && value.number >= 1 && value.number <= 230 && string(value.symbol) && Array.isArray(value.equivalentAtoms) && value.equivalentAtoms.length === ids.size && new Set(value.equivalentAtoms.map(a => a.atomId)).size === ids.size && value.equivalentAtoms.every(a => ids.has(a.atomId) && ids.has(a.representativeId)), 'Invalid crystal symmetry response');
  } else if (request.operation === 'slab-terminations') {
    assert(Array.isArray(result.terminations) && result.terminations.length > 0 && result.terminations.every((t, i) => plain(t) && t.index === i && Number.isFinite(t.shift) && t.shift >= 0 && t.shift < 1 && Array.isArray(t.lowerElements) && Array.isArray(t.upperElements)) && finiteVector(result.normal) && Number.isFinite(result.interplanarSpacing) && result.interplanarSpacing > 0, 'Invalid crystal termination response');
  } else {
    const value = result.candidate;
    assert(plain(value) && value.documentId === request.documentId && value.expectedRevision === request.expectedRevision && value.operation === request.operation, 'Crystal candidate source identity changed');
    const targets = validateGeometry(value.structure), sources = new Set(request.structure.atoms.map(a => a.id)), seen = new Set();
    if (request.operation === 'slab') assert(value.structure.cell.pbc.every(Boolean), 'Crystal slab must retain a complete XYZ periodic work cell');
    assert(Array.isArray(value.atomMapping) && value.atomMapping.length === targets.size, 'Incomplete crystal atom mapping');
    for (const item of value.atomMapping) {
      assert(plain(item) && targets.has(item.atomId) && !seen.has(item.atomId) && sources.has(item.sourceAtomId) && finiteVector(item.image) && item.image.every(Number.isSafeInteger), 'Invalid crystal atom mapping');
      assert(item.sourceAtomIds === undefined || Array.isArray(item.sourceAtomIds) && item.sourceAtomIds.length > 0 && new Set(item.sourceAtomIds).size === item.sourceAtomIds.length && item.sourceAtomIds.includes(item.sourceAtomId) && item.sourceAtomIds.every(id => sources.has(id)), 'Invalid merged source identity');
      assert(item.copyKey === undefined || string(item.copyKey), 'Invalid crystal copy identity');
      assert(item.image.every((v, i) => !v || request.structure.cell.pbc[i]), 'Crystal source image uses a nonperiodic axis');
      seen.add(item.atomId);
    }
    assert(value.latticeImageBasis === undefined || Array.isArray(value.latticeImageBasis) && value.latticeImageBasis.length === 3 && value.latticeImageBasis.every(finiteVector), 'Invalid crystal image basis');
  }
  return result;
}
const PROTOCOL = 'sciyue-crystal-worker/v1';
/** One bounded serial worker. Only an actual close releases its process slot. */
function createCrystalModelingHost({ spawn, resolveRuntime, canSpawn = () => true, timeoutMs, idleMs = 30000, closeMs = 6000 }) {
  assert(typeof spawn === 'function' && typeof resolveRuntime === 'function' && (timeoutMs === undefined || Number.isSafeInteger(timeoutMs) && timeoutMs > 0) && Number.isInteger(idleMs) && idleMs >= 0 && idleMs <= 60000 && Number.isInteger(closeMs) && closeMs > 0 && closeMs <= 10000, 'Invalid crystal host configuration');
  const jobs = new Set(), pending = []; let disposed = false, worker = null, active = null, serial = 0;
  function finish(job, error, result) {
    clearTimeout(job.timer); jobs.delete(job); if (active === job) active = null;
    error ? job.reject(error) : job.resolve(result); job.done();
  }
  function stopWorker(message) {
    const w = worker; if (!w || w.closing) return;
    w.closing = true; clearTimeout(w.idleTimer);
    if (active?.worker === w) { active.error = new Error(message); clearTimeout(active.timer); }
    try { w.child.kill(); } catch {} // Do not release/restart until the real close event.
    w.killTimer = setTimeout(() => { if (!w.closed) try { w.child.kill('SIGKILL'); } catch {} }, closeMs); w.killTimer.unref?.();
  }
  function schedule() { queueMicrotask(pump); }
  function ensureWorker() {
    if (worker) { assert(!worker.closing, 'Crystal worker is closing'); clearTimeout(worker.idleTimer); worker.idleTimer = null; return worker; }
    assert(canSpawn(), 'Crystal host unavailable or busy');
    const runtime = resolveRuntime(), child = spawn(runtime.executable, [...runtime.args, '--crystal-modeling-worker'], { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
    const w = worker = { child, decoder: new StringDecoder('utf8'), buffer: '', bytes: 0, closing: false, closed: false, owner: null };
    w.closedPromise = new Promise(resolve => { w.done = resolve; });
    child.stdout.on('data', chunk => {
      if (w.closing || worker !== w) return;
      try {
        w.bytes += chunk.length;
        w.buffer += w.decoder.write(chunk);
        for (;;) {
          const end = w.buffer.indexOf('\n'); if (end < 0) break;
          const line = w.buffer.slice(0, end); w.buffer = w.buffer.slice(end + 1);
          const response = JSON.parse(line), job = active;
          assert(job && job.worker === w && plain(response) && response.protocol === PROTOCOL && response.id === job.id && response.owner === job.owner && response.documentId === job.request.documentId && response.expectedRevision === job.request.expectedRevision && typeof response.ok === 'boolean', 'CRYSTAL_PROTOCOL: response identity changed');
          if (!response.ok) {
            assert(plain(response.error) && string(response.error.code) && string(response.error.message, 8192), 'Invalid crystal native error');
            finish(job, new Error(response.error.code + ': ' + response.error.message));
          } else finish(job, null, validateCrystalResult(response.result, job.request));
          schedule();
        }
        // An unsolicited partial response must not become the next job's response.
        assert(active || w.buffer.length === 0, 'CRYSTAL_PROTOCOL: unsolicited response');
      } catch (error) { stopWorker(error.message); }
    });
    child.stderr.on('data', () => {}); // Domain errors are bounded on stdout; never leak runtime paths.
    child.stdin.on('error', () => stopWorker('CRYSTAL_INPUT_FAILED'));
    child.once('error', () => stopWorker('CRYSTAL_SPAWN_FAILED'));
    child.once('close', () => {
      w.closed = true; clearTimeout(w.idleTimer); clearTimeout(w.killTimer);
      if (worker === w) {
        worker = null;
        if (active?.worker === w) finish(active, active.error ?? new Error('CRYSTAL_WORKER_EXIT: 晶体预览进程已退出'));
      }
      w.done(); schedule();
    });
    return w;
  }
  function pump() {
    if (disposed || active || worker?.closing) return;
    const job = pending.shift();
    if (!job) {
      if (worker && !worker.idleTimer) { worker.idleTimer = setTimeout(() => stopWorker('CRYSTAL_IDLE'), idleMs); worker.idleTimer.unref?.(); }
      return;
    }
    try {
      active = job; const w = job.worker = ensureWorker(); w.owner = job.owner; w.bytes = 0;
      if (timeoutMs !== undefined) { job.timer = setTimeout(() => stopWorker('CRYSTAL_TIMEOUT: 晶体预览超过显式时限'), timeoutMs); job.timer.unref?.(); }
      w.child.stdin.write(job.payload + '\n');
    } catch (error) {
      if (job.worker) stopWorker('CRYSTAL_INPUT_FAILED'); else finish(job, error);
      schedule();
    }
  }
  function run(owner, request) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0, 'Crystal host unavailable or busy');
    const snapshot = structuredClone(request); validateCrystalRequest(snapshot);
    const id = `crystal-${++serial}`, payload = JSON.stringify({ protocol: PROTOCOL, id, owner, documentId: snapshot.documentId, expectedRevision: snapshot.expectedRevision, request: snapshot });
    return new Promise((resolve, reject) => {
      const job = { owner, id, request: snapshot, payload, resolve, reject };
      job.closedPromise = new Promise(done => { job.done = done; }); jobs.add(job); pending.push(job); pump();
    });
  }
  function cancelOwner(owner) {
    for (const job of [...pending]) if (job.owner === owner) { pending.splice(pending.indexOf(job), 1); finish(job, new Error('CRYSTAL_CANCELLED: 窗口已关闭')); }
    if (worker?.owner === owner) stopWorker('CRYSTAL_CANCELLED: 窗口已关闭');
  }
  function dispose() {
    disposed = true;
    for (const job of pending.splice(0)) finish(job, new Error('CRYSTAL_CANCELLED: 应用退出'));
    stopWorker('CRYSTAL_CANCELLED: 应用退出');
  }
  return { run, cancelOwner, closeOwner: cancelOwner, dispose, settle: () => Promise.all([...jobs].map(j => j.closedPromise).concat(worker ? [worker.closedPromise] : [])), activeCount: () => jobs.size, workerCount: () => worker && !worker.closed ? 1 : 0 };
}
module.exports = { createCrystalModelingHost, validateCrystalRequest, validateCrystalResult };
