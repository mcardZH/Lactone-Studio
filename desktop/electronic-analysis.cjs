'use strict';
const { readManagedResult,inspectManagedSource } = require('./analysis-result-wire.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { assert, plain, string } = require('./security.cjs');
const { context, stamp, hydrate } = require('./surface-analysis.cjs');
const { readChecked, directoryIdentity, checkDirectory } = require('./portable-storage.cjs');
const { progressIdentity, createMultiwfnProgress } = require('./multiwfn-progress.cjs');
const FAMILIES = new Set(['excitation', 'reactivity']);
const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;

function checkedRequest(operation, raw, s) {
  assert(plain(raw), 'Electronic analysis request required');
  assert(plain(raw.stamp) && (raw.stamp.activationEpoch === undefined || Number.isSafeInteger(raw.stamp.activationEpoch) && raw.stamp.activationEpoch >= 0), 'Invalid electronic activation epoch');
  // Activation belongs to the current view/request. The immutable scientific
  // session survives switching away and back; every other context key stays
  // strict, and the response must echo this exact current request epoch.
  const identity = stamp(raw.stamp, { ...s.context, activationEpoch: raw.stamp.activationEpoch });
  // Scientific parameters are validated by their family owner, never converted
  // into arbitrary Multiwfn commands or filesystem paths by this transport.
  const allowed = operation === 'run'
    ? (s.family === 'reactivity' ? ['stamp'] : ['stamp', 'operation', 'state', 'quality', 'includeCoulomb', 'pairIndex', 'spin', 'side', 'generationId'])
    : operation === 'restore-fields' ? ['stamp', 'generationId'] : ['stamp', 'fieldId'];
  assert(Object.keys(raw).every(key => allowed.includes(key)), 'Unknown electronic analysis request field');
  if (operation !== 'run') assert(string(operation === 'restore-fields' ? raw.generationId : raw.fieldId, 256), 'Electronic artifact identity required');
  return { ...structuredClone(raw), stamp: identity };
}

/** Two independent scientific families, with one worker and the shared native
 * lease. The worker owns science; this host owns identity, memory and lifetime. */
function createElectronicAnalysisHost({ spawn, resolveRuntime, resolveBackend, resolveResources, captureResources, resolveCompanions, verifyCompanionSource, snapshotSource, jobRoot, scheduler, sendProgress = () => {}, limits = {} }) {
  assert(scheduler && typeof resolveResources === 'function', 'Electronic host requires shared scheduler/resources');
  const policy = { requestMs: 0, stopMs: 6000, ...limits };
  const sessions = new Map(), pending = new Map(), tasks = new Set(), closedOwners = new Set();
  const projectSourceLeases = new Map();
  async function releaseProjectCompanions(owner,id){const lease=projectSourceLeases.get(id);if(!lease)return{released:true};assert(lease.owner===owner,'Project source owner differs');if(lease.releaseTask)return lease.releaseTask;if(lease.aliases.size>1){lease.aliases.delete(id);projectSourceLeases.delete(id);return{released:true};}return lease.releaseTask=(async()=>{await Promise.allSettled([...(lease.reads??[])]);await checkDirectory(lease.directory,lease.pinned);for(const item of [lease.projectOutput,...Object.values(lease.projectCompanions)].filter(Boolean)){const stat=await fs.lstat(item.path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.dev===item.dev&&stat.ino===item.ino,'Project source cleanup identity changed');await fs.unlink(item.path);}await fs.rmdir(lease.directory);projectSourceLeases.delete(id);return{released:true};})();}
  async function retainProjectCompanions(s){if(!Object.keys(s.projectCompanions??{}).length)return;const{activationEpoch:_epoch,...science}=s.context,key=JSON.stringify([s.owner,science,[s.projectOutput.name,s.projectOutput.revision],Object.entries(s.projectCompanions).map(([role,file])=>[role,file.name,file.revision,file.bytes])]);const existing=[...projectSourceLeases.values()].find(lease=>lease.key===key);if(existing){existing.aliases.add(s.sessionId);projectSourceLeases.set(s.sessionId,existing);return;}const directory=await fs.mkdtemp(path.join(jobRoot,'project-source-')),pinned=await directoryIdentity(directory);const lease={owner:s.owner,sessionId:s.sessionId,key,aliases:new Set([s.sessionId]),family:'excitation',info:true,context:s.context,directory,pinned,projectCompanions:{}};projectSourceLeases.set(s.sessionId,lease);
    try{for(const [role,file]of [['output',s.projectOutput],...Object.entries(s.projectCompanions)]){const before=await fs.lstat(file.path);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size===file.bytes,'Project source snapshot changed');const target=path.join(directory,path.basename(file.path));await fs.copyFile(file.path,target,require('node:fs').constants.COPYFILE_EXCL);const after=await fs.lstat(file.path),saved=await fs.lstat(target);assert(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&saved.isFile()&&!saved.isSymbolicLink()&&saved.size===file.bytes,'Project source snapshot copy changed');const retained={...file,path:target,dev:saved.dev,ino:saved.ino,statIdentity:[saved.dev,saved.ino,saved.size,saved.mtimeMs,saved.ctimeMs].join(':')};if(role==='output')lease.projectOutput=retained;else lease.projectCompanions[role]=retained;}}
    catch(error){await releaseProjectCompanions(s.owner,s.sessionId);throw error;}}
  let worker, sequence = 0, disposed = false;
  function track(task) { tasks.add(task); task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  function owned(owner, id) { const s = sessions.get(id); assert(s && s.owner === owner && !s.closed && !s.failed && !disposed && !closedOwners.has(owner), 'Electronic session is not owned/available'); return s; }
  function clean(s) { return s.cleanup ??= (async () => {
    if (!s.directory) return;
    const root = path.resolve(s.directory), files = [], directories = [];
    assert(root.startsWith(path.resolve(jobRoot) + path.sep), 'Electronic cleanup escaped its session');
    async function list(directory) {
      await directoryIdentity(directory); directories.push(directory);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), stat = await fs.lstat(file);
        assert(!stat.isSymbolicLink(), 'Electronic cleanup preserves unexpected links');
        if (stat.isDirectory()) await list(file);
        else { assert(stat.isFile() && stat.nlink === 1, 'Electronic cleanup preserves shared/unknown files'); files.push({ file, dev: stat.dev, ino: stat.ino }); }
      }
    }
    try { await list(root); } catch (error) { if (error.code === 'ENOENT' && !directories.length) return; throw error; }
    for (const row of files) { await directoryIdentity(path.dirname(row.file)); const stat = await fs.lstat(row.file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === row.dev && stat.ino === row.ino, 'Electronic cleanup file identity changed'); await fs.unlink(row.file); }
    for (const directory of directories.reverse()) { await directoryIdentity(directory); await fs.rmdir(directory); }
  })(); }
  async function stopWorker(w = worker, error = new Error('Electronic worker closed')) {
    if (!w) return;
    if (!w.closing) { w.closing = true; try { w.child.stdin.end(); } catch {} w.timer = setTimeout(() => { if (!w.closed) w.child.kill(); }, policy.stopMs); w.timer.unref?.(); }
    await w.finished;
    for (const [id, entry] of pending) if (entry.w === w) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
  }
  function ensureWorker() {
    assert(!disposed, 'Electronic host disposed');
    if (worker) { assert(!worker.closing, 'Electronic worker is stopping'); return worker; }
    const runtime = resolveRuntime(), child = spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } });
    const w = worker = { child, closed: false, closing: false, parts: [], bytes: 0 };
    w.finished = new Promise(resolve => { w.finish = resolve; });
    function message(packet) {
      assert(plain(packet), 'Invalid electronic worker packet');
      const entry = pending.get(packet.id);
      assert(entry && packet.sessionId === entry.s.sessionId && packet.family === entry.s.family, 'Electronic reply owner/family/request identity changed');
      if (packet.event === 'task-progress') {
        assert(plain(packet.progress), 'Invalid electronic progress');
        // The unmeasured service intention precedes Popen. A measured native
        // stage comes from the existing scanner of actual native stdout.
        if (entry.s.family === 'reactivity' && entry.operation === 'run' && packet.progress.phase === 'running' && packet.progress.measure === undefined) entry.progress?.report('running', { stageLabel: '计算指标' });
        else entry.progress?.report(packet.progress.phase, packet.progress);
        return;
      }
      assert(typeof packet.ok === 'boolean', 'Invalid electronic worker status');
      if (entry.operation === 'run' && packet.nativeSettled !== true) { void stopWorker(w, new Error('ELECTRONIC_NATIVE_UNSETTLED')).catch(() => {}); return; }
      if (packet.settlement !== undefined) {
        assert(['not-started', 'cancelled-before-start', 'native-settled'].includes(packet.settlement), 'Invalid electronic native disposition');
        if (['run', 'restore-fields', 'export-cube'].includes(entry.operation)) { entry.s.lastDisposition = packet.settlement; entry.s.lastDispositionConfirmed = true; }
      }
      if (packet.retainedMemoryBytes !== undefined) { assert(Number.isSafeInteger(packet.retainedMemoryBytes) && packet.retainedMemoryBytes >= 0, 'Invalid electronic reservation'); entry.s.retainedBytes = packet.retainedMemoryBytes; }
      if (!packet.ok) assert(plain(packet.error) && string(packet.error.code, 128) && string(packet.error.message, 16384), 'Invalid electronic error');
      pending.delete(packet.id); clearTimeout(entry.timer);
      packet.ok ? entry.resolve(packet.result) : entry.reject(new Error(packet.error.code + ': ' + packet.error.message));
    }
    child.stdout.on('data', chunk => { if (w.closing) return; try { let bytes = Buffer.from(chunk); while (bytes.length) { const index = bytes.indexOf(10), part = index < 0 ? bytes : bytes.subarray(0, index); w.parts.push(part); w.bytes += part.length; if (index < 0) break; const line = Buffer.concat(w.parts, w.bytes).toString('utf8'); w.parts = []; w.bytes = 0; message(JSON.parse(line)); bytes = bytes.subarray(index + 1); } } catch (error) { void stopWorker(w, error).catch(() => {}); } });
    child.stderr.on('data', () => {}); child.stdin.on('error', error => { void stopWorker(w, error).catch(() => {}); }); child.on('error', error => { void stopWorker(w, error).catch(() => {}); });
    child.once('close', code => { w.closed = true; clearTimeout(w.timer); if (worker === w) { worker = null; for (const s of sessions.values()) if (s.worker === w) s.failed = true; } w.finish(code); for (const [id, entry] of pending) if (entry.w === w) { clearTimeout(entry.timer); pending.delete(id); entry.reject(new Error('Electronic worker exited (' + code + ')')); } });
    return w;
  }
  function request(operation, s, payload = {}, progress) {

    const w = ensureWorker(), id = 'electronic-' + ++sequence;
    if (operation === 'open') s.worker = w;
    return new Promise((resolve, reject) => {
      const timer = policy.requestMs>0?setTimeout(() => { void stopWorker(w, new Error('ELECTRONIC_TIMEOUT')).catch(() => {}); }, policy.requestMs):undefined; timer?.unref?.();
      pending.set(id, { w, s, operation, resolve, reject, timer, progress });
      try { w.child.stdin.write(JSON.stringify({ id, operation, sessionId: s.sessionId, family: s.family, ...payload }) + '\n'); } catch (error) { void stopWorker(w, error).catch(() => {}); }
    }).then(value=>readManagedResult(value,s.directory));
  }
  async function resources(owner, s, lease, captured) {
    const configured = await resolveResources(owner,undefined,captured);
    assert(plain(configured) && Number.isSafeInteger(configured.threads) && configured.threads > 0 && Number.isSafeInteger(configured.memoryBudgetBytes) && configured.memoryBudgetBytes > 0, 'Electronic resources unavailable');
    const budget = lease.budget(configured.memoryBudgetBytes, { domain: 'electronic', sessionId: s.sessionId });
    return { ...configured, memoryBudgetBytes: budget.availableBytes, sharedReservedBytes: budget.reservedBytes, configuredMemoryBudgetBytes: budget.memoryBudgetBytes };
  }
  // Count every published field, including nested NTO pairs and both densities.
  // A stable field id may be restored, but never silently reused for new values.
  function preflightFields(s, value, lease, ceiling) {
    const ids = new Set(); let added = 0;
    function visit(item) {
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return;
      if (Object.hasOwn(item, 'valuesBase64') || Object.hasOwn(item, 'values')) {
        assert(plain(item.grid) && Array.isArray(item.grid.dimensions) && item.grid.dimensions.length === 3 && string(item.id, 512) && !ids.has(item.id), 'Invalid/duplicate electronic field');
        ids.add(item.id);
        const count = item.grid.dimensions.reduce((total, dimension) => { assert(Number.isSafeInteger(dimension) && dimension > 0, 'Invalid electronic field dimension'); return total * dimension; }, 1);
        assert(Number.isSafeInteger(count) && Number.isSafeInteger(count*8), 'Electronic field exceeds integer representation');
        if (item.valuesBase64 !== undefined) {
          assert(item.values === undefined && (item.valuesBase64 instanceof Uint8Array ? item.valuesBase64.byteLength===count*8 : typeof item.valuesBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(item.valuesBase64) && item.valuesBase64.length === 4 * Math.ceil(count * 8 / 3)) && (item.valueEncoding === undefined || item.valueEncoding === 'float64-le'), 'Invalid electronic float64 field wire');
        } else assert(Array.isArray(item.values) && item.values.length === count && item.values.every(Number.isFinite), 'Invalid electronic raw field values');
        const mask = item.validDomain?.kind === 'node-mask' ? item.validDomain : null;
        if (mask) assert(mask.maskBase64 instanceof Uint8Array ? mask.maskBase64.byteLength===count : typeof mask.maskBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(mask.maskBase64) && mask.maskBase64.length === 4 * Math.ceil(count / 3), 'Invalid electronic mask wire');
        if (!s.published?.has(item.id)) added += count * 8 + (mask ? count : 0);
        return;
      }
      for (const child of Object.values(item)) visit(child);
    }
    visit(value);
    assert(Number.isSafeInteger(added) && added <= lease.budget(ceiling, { domain: 'electronic', sessionId: s.sessionId }).availableBytes, 'ELECTRONIC_MEMORY_BUDGET: Published fields exceed shared ceiling before allocation');
  }
  function hydrateFields(value) {
    const result = hydrate(value);
    function visit(item) {
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return;
      if (Array.isArray(item.values)) item.values = Float64Array.from(item.values);
      if (item.values instanceof Float64Array) delete item.valueEncoding;
      for (const child of Object.values(item)) visit(child);
    }
    visit(result); return result;
  }
  function reservePublished(s, value, lease, ceiling) {
    const batch = new Map();
    function visit(item) {
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return;
      if (item.values instanceof Float64Array) {
        assert(string(item.id, 512) && !batch.has(item.id), 'Invalid/duplicate electronic field identity');
        const bytes = Buffer.from(item.values.buffer, item.values.byteOffset, item.values.byteLength), mask = item.validDomain?.mask;
        assert(mask === undefined || mask instanceof Uint8Array, 'Invalid electronic field mask');
        const hash = createHash('sha256').update(bytes); if (mask) hash.update(mask);
        hash.update(JSON.stringify(item, (key, entry) => ['values', 'mask', 'activationEpoch'].includes(key) ? undefined : plain(entry) ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry));
        const identity = { bytes: bytes.length + (mask?.byteLength ?? 0), sha256: hash.digest('hex') }, previous = s.published?.get(item.id);
        assert(!previous || same(previous, identity), 'Electronic field id was reused for different content'); batch.set(item.id, identity); return;
      }
      for (const child of Object.values(item)) visit(child);
    }
    visit(value);
    const added = [...batch].reduce((total, [id, identity]) => total + (s.published?.has(id) ? 0 : identity.bytes), 0);
    assert(Number.isSafeInteger(added) && added <= lease.budget(ceiling, { domain: 'electronic', sessionId: s.sessionId }).availableBytes, 'ELECTRONIC_MEMORY_BUDGET: Published fields exceed shared ceiling');
    s.published ??= new Map(); for (const [id, identity] of batch) s.published.set(id, identity);
  }
  async function snapshot(s, raw, role) {
    assert(plain(raw) && Object.keys(raw).every(key => ['name', 'text', 'sourceToken', 'revision', 'sourceId'].includes(key)) && string(raw.name, 256) && path.basename(raw.name) === raw.name, 'Invalid electronic output snapshot');
    if(raw.sourceToken!==undefined){
      assert(string(raw.sourceToken,256)&&raw.text===undefined&&typeof snapshotSource==='function','Managed electronic source channel unavailable');
      // Logical OUT source IDs are separate from byte hashes. Validate a supplied
      // content revision only when it is an actual digest.
      const saved=await snapshotSource(s.owner,raw.sourceToken,{directory:s.directory,name:raw.name,...(/^[a-f0-9]{64}$/.test(raw.revision??'')?{revision:raw.revision}:{})});
      assert(path.dirname(saved.path)===s.directory&&/^[a-f0-9]{64}$/.test(saved.revision)&&Number.isSafeInteger(saved.bytes)&&saved.bytes>0,'Invalid owned electronic snapshot');
      return {...saved,...(raw.sourceId?{sourceId:raw.sourceId}:{})};
    }
    assert(typeof raw.text==='string'&&raw.text.length,'Complete electronic output snapshot is required');
    const bytes = Buffer.from(raw.text, 'utf8'), revision = createHash('sha256').update(bytes).digest('hex');
    assert(raw.revision === undefined || raw.revision === revision, 'Electronic output snapshot revision differs');
    const file = path.join(s.directory, role === 'output' ? 'source-output.out' : 'source-orca.json');
    await fs.writeFile(file, bytes, { flag: 'wx' }); return { name: raw.name, path: file, revision, bytes: bytes.length, ...(raw.sourceId ? { sourceId: raw.sourceId } : {}) };
  }
  async function open(owner, trusted) {
    assert(Number.isSafeInteger(owner) && owner >= 0 && !disposed && !closedOwners.has(owner) && plain(trusted) && FAMILIES.has(trusted.family) && string(trusted.sessionId, 100) && /^[A-Za-z0-9_-]+$/.test(trusted.sessionId) && !sessions.has(trusted.sessionId), 'Electronic owner/session unavailable');
    const s = { owner, family: trusted.family, sessionId: trusted.sessionId, context: context(trusted.context), closed: false, retainedBytes: 0, inflight: new Set(), opening: new AbortController() }; sessions.set(s.sessionId, s);
    let lease;
    try {
      assert(trusted.kind === 'wavefunction' && path.isAbsolute(trusted.sourcePath), 'Host-owned electronic wavefunction snapshot required');
      const checked = await inspectManagedSource(trusted.sourcePath); assert(checked.sha256 === trusted.sourceRevision, 'Electronic source snapshot changed');
      assert(string(trusted.sourceId, 256) && s.context.sourceRevision === checked.sha256, 'Electronic source context differs from snapshot');
      if (s.family === 'excitation') {
        // Excitation's logical analysis owner is its OUT source. Its physical
        // wavefunction retains a separate id and content SHA in the payload.
        assert(plain(trusted.output) && string(trusted.output.sourceId, 256) && trusted.output.sourceId === s.context.sourceId, 'Excitation output owner differs from logical source context');
        assert(trusted.orcaJson === undefined && trusted.orcaCis === undefined, 'Renderer companion text/path is forbidden');
      }
      lease = await scheduler.acquire({ owner, key: 'electronic:open:' + s.sessionId, signal: s.opening.signal }); owned(owner, s.sessionId);
      const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,s.opening.signal):undefined;owned(owner,s.sessionId);assert(!s.opening.signal.aborted,'ELECTRONIC_CANCELLED');
      const backend = await resolveBackend(); assert(backend.configured && string(backend.path, 4096), 'ELECTRONIC_BACKEND_MISSING');
      s.backendPath=backend.path;
      const configured = await resources(owner, s, lease, captured); if (worker?.closing) await worker.finished; owned(owner, s.sessionId);
      await fs.mkdir(jobRoot, { recursive: true }); s.directory = await fs.mkdtemp(path.join(jobRoot, 'electronic-'));
      const { companionSourceToken, ...outputSource } = trusted.output ?? {};
      const output = trusted.output ? await snapshot(s, outputSource, 'output') : undefined;
      let companions = {};
      if (companionSourceToken !== undefined) {
        assert(s.family === 'excitation' && string(companionSourceToken, 100) && typeof resolveCompanions === 'function' && typeof verifyCompanionSource === 'function', 'Host-owned companion capability required');
        s.companionSource = { token: companionSourceToken, name: output.name, revision: output.revision, bytes: output.bytes };
        companions = await resolveCompanions(owner, companionSourceToken, { ...s.companionSource, directory: s.directory, memoryBudgetBytes: configured.memoryBudgetBytes });
        owned(owner, s.sessionId); assert(plain(companions) && Object.keys(companions).every(key => ['orcaJson', 'orcaCis'].includes(key)), 'Invalid host companion result');
        for (const companion of Object.values(companions)) {
          assert(plain(companion) && path.dirname(companion.path) === s.directory && string(companion.name, 256) && path.basename(companion.name) === companion.name && /^[a-f0-9]{64}$/.test(companion.revision) && Number.isSafeInteger(companion.bytes) && companion.bytes >= 0, 'Companion is not an owned snapshot');
        }
      }
      s.projectOutput = output; s.projectCompanions = companions;
      await retainProjectCompanions(s);
      const source = { kind: 'wavefunction', sourcePath: trusted.sourcePath, name: trusted.name, sourceRevision: trusted.sourceRevision, sourceId: trusted.sourceId, context: s.context, ...(trusted.orbitalRepresentation ? { orbitalRepresentation: trusted.orbitalRepresentation, orbitalRepresentationEvidence: trusted.orbitalRepresentationEvidence } : {}) };
      const result = await request('open', s, { source, output, ...companions, workspacePath: s.directory, executable: backend.path, resources: configured }); owned(owner, s.sessionId);
      if (s.companionSource) await verifyCompanionSource(owner, companionSourceToken, s.companionSource);
      assert(plain(result) && result.sessionId === s.sessionId && same(context(result.context), s.context), 'Electronic open identity changed');
      s.info = result; return result;
    } catch (error) {
      if (s.worker && !s.worker.closing && !s.worker.closed) await request('close', s).catch(() => {});
      if (s.worker?.closing) await s.worker.finished;
      if (sessions.get(s.sessionId) === s) sessions.delete(s.sessionId);
      try { await clean(s);await releaseProjectCompanions(owner,s.sessionId); } finally { if (!sessions.size) await stopWorker(); } throw error;
    } finally { lease?.release(); }
  }
  async function operate(owner, id, operation, raw) {
    const s = owned(owner, id); assert(s.info && !s.busy, 'ELECTRONIC_BUSY');
    const checked = checkedRequest(operation, raw, s), scientific = operation === 'run', controller = new AbortController();
    assert(!s.analysisId || s.analysisId === checked.stamp.analysisId, 'Electronic analysis owner changed'); s.analysisId = checked.stamp.analysisId;
    if (scientific) { s.requestIds ??= new Set(); assert(!s.requestIds.has(checked.stamp.requestId), 'Electronic science request identity already used'); s.requestIds.add(checked.stamp.requestId); }
    s.busy = true; s.controller = controller; s.submitted = false; s.lastDisposition = 'not-started'; s.lastDispositionConfirmed = false;
    const progress = createMultiwfnProgress(progressIdentity({ ownerId: checked.stamp.analysisId, analysisId: checked.stamp.analysisId, runId: checked.stamp.requestId, sessionId: id, sourceId: s.context.sourceId, sourceRevision: s.context.sourceRevision, jobIndex: s.context.jobIndex, sourceFrameIndex: s.context.sourceFrameIndex, generation: s.context.generation, operation: s.family + '-' + operation }, { sessionId: id, sourceId: s.context.sourceId, sourceRevision: s.context.sourceRevision }), value => sendProgress(owner, value));
    s.progress = progress; progress.report('queued', scientific ? {} : { stageLabel: '等待读取资源' });
    let lease, submitted = false, passed = false;
    try {
      lease = await scheduler.acquire({ owner, key: 'electronic:' + operation + ':' + id, signal: controller.signal }); owned(owner, id); assert(!controller.signal.aborted, 'ELECTRONIC_CANCELLED');
      const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,controller.signal):undefined;owned(owner,id);assert(!controller.signal.aborted,'ELECTRONIC_CANCELLED');
      if(scientific){const backend=await resolveBackend();owned(owner,id);assert(!controller.signal.aborted,'ELECTRONIC_CANCELLED');assert(backend.configured&&string(backend.path,4096)&&path.resolve(backend.path).toLowerCase()===path.resolve(s.backendPath).toLowerCase(),'ELECTRONIC_BACKEND_CHANGED: Multiwfn 路径已变化或不可用，请重新打开此分析来源；已有结果保留。');}
      const configured = await resources(owner, s, lease, captured); owned(owner, id); assert(!controller.signal.aborted, 'ELECTRONIC_CANCELLED');
      if (s.companionSource) await verifyCompanionSource(owner, s.companionSource.token, s.companionSource);
      owned(owner, id); assert(!controller.signal.aborted, 'ELECTRONIC_CANCELLED');
      submitted = true; s.submitted = true; progress.report(scientific ? 'running' : 'reading', scientific ? s.family === 'reactivity' ? { stageLabel: '计算指标' } : {} : { stageLabel: '读取已保存数据' });
      const result = await request(operation, s, { request: checked, resources: configured }, progress); owned(owner, id); assert(!controller.signal.aborted, 'ELECTRONIC_CANCELLED');
      if (s.companionSource) await verifyCompanionSource(owner, s.companionSource.token, s.companionSource);
      owned(owner, id); assert(!controller.signal.aborted, 'ELECTRONIC_CANCELLED');
      assert(plain(result), 'Invalid electronic result');
      if (operation === 'export-cube') assert(string(result.name, 512) && path.basename(result.name) === result.name && typeof result.text === 'string' && Buffer.byteLength(result.text) <= MAX_SOURCE_BYTES, 'Unsafe electronic Cube export');
      else {
        assert(same(stamp(result.stamp, { ...s.context, activationEpoch: checked.stamp.activationEpoch }), checked.stamp), 'Electronic result stamp changed');
        if (scientific && s.family === 'excitation') assert(result.operation === checked.operation && same(result.state, checked.state), 'Excitation result state/operation changed');
      }
      preflightFields(s, result, lease, configured.configuredMemoryBudgetBytes);
      const value = hydrateFields(result); reservePublished(s, value, lease, configured.configuredMemoryBudgetBytes);
      let progressSettlement = s.lastDisposition;
      if (scientific && s.family === 'reactivity') {
        assert(s.lastDispositionConfirmed && plain(value.provenance), 'Reactivity native disposition is not confirmed');
        if (s.lastDisposition === 'not-started') {
          assert(value.provenance.settlement === 'not-started' && value.provenance.backend === null, 'Reactivity native disposition conflicts with derived-only provenance');
          // This is a successful pure derivation, not an interrupted native
          // request. Keep the scientific backend/null provenance unchanged.
          progressSettlement = 'not-required';
        } else assert(s.lastDisposition === 'native-settled' && value.provenance.settlement === 'native-settled' && plain(value.provenance.backend), 'Reactivity native disposition conflicts with native provenance');
      }
      passed = true; progress.report('parse', { stageLabel: '等待结果接受', validated: true, settlement: progressSettlement }); return value;
    } finally {
      lease?.release();
      const disposition = !submitted ? (controller.signal.aborted ? 'cancelled-before-start' : 'not-started') : s.worker?.closed && scientific ? 'native-settled' : s.lastDisposition;
      s.lastDisposition = disposition;
      if (controller.signal.aborted) progress.report('stopped', { settlement: disposition === 'not-started' ? 'cancelled-before-start' : disposition });
      else if (!passed) progress.report('failed', { settlement: disposition });
      if (s.controller === controller) s.controller = null; s.progress = null; s.busy = false;
    }
  }
  function operation(owner, id, name, raw) { const s = owned(owner, id), task = operate(owner, id, name, raw); s.inflight.add(task); task.then(() => s.inflight.delete(task), () => s.inflight.delete(task)); return track(task); }
  async function cancel(owner, id) {
    const s = owned(owner, id), hadOperation = s.busy, hadSubmitted = s.submitted; s.controller?.abort(); if (!s.info) s.opening.abort(); s.progress?.report('stopping'); const running = [...s.inflight];
    if (s.worker && !s.worker.closing && !s.worker.closed) {
      try { const result = await request('cancel', s); if (result?.nativeSettled !== true) await stopWorker(s.worker, new Error('Electronic cancellation did not settle native')); }
      catch (error) { await stopWorker(s.worker, error); await Promise.allSettled(running); throw error; }
    }
    if (!s.info) await s.openTask?.catch(() => {});
    await Promise.allSettled(running); return { cancelled: true, nativeSettled: true, activeOperationPending: false, settlement: !hadOperation ? 'not-started' : !hadSubmitted ? 'cancelled-before-start' : s.lastDisposition };
  }
  async function closeSession(owner, id) {
    const s = sessions.get(id); if (!s) return { sessionId: id, status: 'closed' }; assert(s.owner === owner, 'Electronic session belongs to another owner'); if (s.closeTask) return s.closeTask;
    s.closed = true; s.opening.abort(); s.controller?.abort();
    return s.closeTask = (async () => {
      let failure;
      try {
        await s.openTask?.catch(() => {});
        if (sessions.get(id) === s && s.worker && !s.worker.closing && !s.worker.closed) {
          try { await request('close', s); }
          catch (error) { failure = error; await stopWorker(s.worker, error); }
        }
        await Promise.allSettled([...s.inflight]); if (s.worker?.closing) await s.worker.finished;
      }
      finally { if (sessions.get(id) === s) sessions.delete(id); try { await clean(s); } finally { if (!sessions.size) await stopWorker(); } }
      if (failure) throw failure;
      return { sessionId: id, status: 'closed' };
    })();
  }
  async function closeOwner(owner) { closedOwners.add(owner); await Promise.all([...sessions.values()].filter(s => s.owner === owner).map(s => closeSession(owner, s.sessionId)));for(const [id,lease]of [...projectSourceLeases])if(lease.owner===owner)await releaseProjectCompanions(owner,id); }
  function projectOwned(owner,id){const s=projectSourceLeases.get(id)??owned(owner,id);assert(s.owner===owner&&!disposed&&!closedOwners.has(owner),'Project companion source owner unavailable');return s;}
  function projectReadTask(owner,id,execute){const source=projectOwned(owner,id),task=execute();source.reads??=new Set();source.reads.add(task);void task.then(()=>source.reads.delete(task),()=>source.reads.delete(task));return track(task);}
  async function projectFile(s, role) {
    const file = role === 'output' ? s.projectOutput : s.projectCompanions?.[role];
    assert(file && ['output', 'orcaJson', 'orcaCis'].includes(role) && path.dirname(file.path) === s.directory, 'Project companion role is not retained');
    const handle = await fs.open(file.path, 'r');
    const identity = stat => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
    try {
      const before=await handle.stat(),selected=await fs.lstat(file.path);
      assert(before.isFile()&&selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1&&before.size===file.bytes&&identity(before)===identity(selected)&&(!file.statIdentity||file.statIdentity===identity(before)),'Project companion snapshot changed');
      return {file,handle,before,identity};
    } catch(error){await handle.close();throw error;}
  }
  async function describeProjectCompanions(owner,id) {
    const s=projectOwned(owner,id);assert(s.family==='excitation'&&s.info,'Excitation source is not ready');
    const roles=Object.keys(s.projectCompanions??{});if(!roles.length)return null;
    const files=[];
    for(const role of ['output',...roles]){
      const entry=await projectFile(s,role);
      try{const hash=createHash('sha256'),buffer=Buffer.alloc(1024**2);let offset=0;
        if(!entry.file.verified)while(offset<entry.file.bytes){const length=Math.min(buffer.length,entry.file.bytes-offset),read=await entry.handle.read(buffer,0,length,offset);assert(read.bytesRead===length,'Project companion truncated');hash.update(buffer.subarray(0,length));offset+=length;}
        const after=await entry.handle.stat(),selected=await fs.lstat(entry.file.path);projectOwned(owner,id);
        assert(entry.identity(after)===entry.identity(entry.before)&&entry.identity(selected)===entry.identity(entry.before)&&(entry.file.verified||hash.digest('hex')===entry.file.revision),'Project companion content differs from its original calculation snapshot');entry.file.verified=true;
        files.push({role,name:entry.file.name,revision:entry.file.revision,bytes:entry.file.bytes});
      }finally{await entry.handle.close();}
    }
    return {context:structuredClone(s.context),sourceId:s.projectOutput.sourceId,files};
  }
  async function readProjectCompanion(owner,id,role,start,end) {
    const s=projectOwned(owner,id);assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>=start&&end-start<=1024**2,'Project companion chunk exceeds 1 MiB');
    const entry=await projectFile(s,role);
    try{assert(end<=entry.file.bytes,'Project companion range invalid');const bytes=Buffer.alloc(end-start);let offset=0;while(offset<bytes.length){const read=await entry.handle.read(bytes,offset,bytes.length-offset,start+offset);assert(read.bytesRead>0,'Project companion truncated');offset+=read.bytesRead;}
      projectOwned(owner,id);const after=await entry.handle.stat(),selected=await fs.lstat(entry.file.path);assert(entry.identity(after)===entry.identity(entry.before)&&entry.identity(selected)===entry.identity(entry.before),'Project companion snapshot changed');return new Uint8Array(bytes);
    }finally{await entry.handle.close();}
  }
  function dispose() { if (disposed) return; disposed = true; for (const s of sessions.values()) { s.closed = true; s.opening.abort(); s.controller?.abort(); } const before = [...tasks]; track((async () => { await stopWorker(); await Promise.allSettled(before); for (const s of sessions.values()) await clean(s); sessions.clear();for(const [id,lease]of [...projectSourceLeases])await releaseProjectCompanions(lease.owner,id); })()); }
  return {
    assertFamily(owner, id, family, absent = false) { const s = sessions.get(id); if (!s && absent) return; assert(owned(owner, id).family === family, 'Electronic session belongs to another family'); },
    open: (...args) => { const task = open(...args), s = sessions.get(args[1]?.sessionId); if (s) s.openTask = task; return track(task); },
    run: (owner, id, raw) => operation(owner, id, 'run', raw), restoreFields: (owner, id, raw) => operation(owner, id, 'restore-fields', raw), exportCube: (owner, id, raw) => operation(owner, id, 'export-cube', raw),
    cancel: (...args) => track(cancel(...args)), closeSession: (...args) => track(closeSession(...args)), closeOwner: (...args) => track(closeOwner(...args)), dispose,
    describeProjectCompanions:async(owner,id)=>projectReadTask(owner,id,()=>describeProjectCompanions(owner,id)),readProjectCompanion:async(owner,id,...args)=>projectReadTask(owner,id,()=>readProjectCompanion(owner,id,...args)),
    releaseProjectCompanions:(...args)=>track(releaseProjectCompanions(...args)),
    settle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); }, workerCount: () => worker && !worker.closed ? 1 : 0, sessionCount: () => sessions.size, activeCount: () => [...sessions.values()].filter(s => s.busy || !s.info).length,
    reservedMemoryBytes: () => [...sessions.values()].reduce((total, s) => total + s.retainedBytes + [...(s.published?.values() ?? [])].reduce((bytes, field) => bytes + field.bytes, 0), 0),
  };
}
module.exports = { createElectronicAnalysisHost, checkedRequest };
