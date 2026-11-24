'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const { assert, within } = require('./security.cjs');
const { checkDirectory, directoryIdentity } = require('./portable-storage.cjs');
const { pythonEnvironment } = require('./pes-runtime.cjs');
const { SCHEMA, validateStart, validateIdentity, validateEvent, validateFrame, requiresResidentLibrary, usesFixedCellTblite } = require('./pes-security.cjs');

// This grace period is only for an already-requested stop. A running
// calculation has no host wall-time, evaluation, frame or output ceiling.
const STOP_GRACE_MS = 2000;
const RESIDENT_SCHEMA = 'es-pes-resident/v1';
const candidateFailureCodes = new Set(['PES_XTB_SCC', 'PES_XTB_GEOMETRY', 'PES_XTB_EVALUATION',
  'PES_OPT_LINE_SEARCH', 'PES_OPT_COORDINATE']);
const DEFAULT_PREPARATION = { operation: 'opt', algorithm: 'lbfgs', method: 'gfn2' };
const OPTIMIZER_IMPORTS = new Map([['fire2', 'fire2'], ['sella-xyz', 'sella'], ['sella-ric', 'sella']]);
const residentProfile = request => ({
  operation: request.operation, algorithm: request.algorithm,
  parameters: { executionProfile: request.parameters?.executionProfile },
});
const residentProfileKey = profile => JSON.stringify(profile);
const declareResident = (command, data = {}) => JSON.stringify({ schema: RESIDENT_SCHEMA, command, ...data }) + '\n';

function errorDetail(error) { return String(error?.message ?? error ?? ''); }

// Rendering may use an empirical graph while this same PES run holds the
// scientific lease. Keep only fingerprints, never a second coordinate history.
function displayGeometryFingerprinter(structure) {
  const metadata = structure.atoms.map(atom => {
    const { x, y, z, stereoParity, aromaticHydrogen, ...metadata } = atom;
    return JSON.stringify(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)));
  });
  const start = `[${JSON.stringify(structure.id)},[`;
  const end = `],${JSON.stringify([structure.charge ?? 0, structure.multiplicity ?? 1, structure.cell ?? null]).slice(1)}`;
  return positions => {
    const atoms=metadata.map((atom, index) => {
      const {x,y,z}=structure.atoms[index];
      return `[${atom},${JSON.stringify(positions?.[index] ?? [x,y,z])}]`;
    });
    return createHash('sha256').update(start + atoms.join(',') + end).digest('hex');
  };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error('PES start stopped'));
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

function ndjson(accept) {
  let pending = [], bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        const end = buffer.indexOf(0x0a, offset);
        const part = buffer.subarray(offset, end === -1 ? buffer.length : end);
        pending.push(part);
        bytes += part.length;
        if (end === -1) break;
        const line = pending.length === 1 ? part : Buffer.concat(pending, bytes);
        pending = [];
        bytes = 0;
        accept(JSON.parse(decoder.decode(line)));
        offset = end + 1;
      }
    },
    incomplete: () => pending.length !== 0,
  };
}

function createPesHost({ spawn, spawnResident, resolveRuntime, resolveXtbRuntime,
  jobRoot, resultRoot = `${jobRoot}-records`, resolveResources, admit, admitCandidate, sendToWindow,
  pagedTerminalFrames = false, registerBinaryAsset, fs = require('node:fs/promises') }) {
  assert(path.isAbsolute(jobRoot) && typeof admit === 'function', 'Trusted PES job root and shared admission required');
  assert(path.isAbsolute(resultRoot) && !within(jobRoot, resultRoot), 'PES records need a separate owned result root');
  const sessions = new Map(), retained = new Map(), closedOwners = new Set(), residentWorkers = new Set();
  const preparingOwners = new Map(), terminalFrames = new Map();
  let disposed = false, rootIdentity, resultRootIdentity;
  const sessionKey = (owner, identity) => JSON.stringify([owner, identity.groupId, identity.taskId, identity.runId]);

  function registerDisplayFrames(session, frames, aliases) {
    if (!session.fingerprintDisplayGeometry) return;
    const targets = aliases.map(alias => {
      let fingerprints = session.displayFrames.get(alias);
      if (!fingerprints) session.displayFrames.set(alias, fingerprints = new Set());
      return fingerprints;
    });
    for (const frame of frames) {
      const fingerprint = session.fingerprintDisplayGeometry(frame.positions);
      for (const target of targets) target.add(fingerprint);
    }
  }

  function authorizeEmpiricalDisplay(owner, request) {
    if (request.operation !== 'perceive-bonds' || request.bondPerceptionPolicy !== 'composite-v1'
      || request.bondOrderEvidence !== undefined || request.runIdentity !== undefined
      || request.forcefield !== undefined || request.steps !== undefined || request.format !== undefined
      || request.optimizationPool !== undefined || request.optimizationStepPolicy !== undefined
      || request.constraints?.length || request.structure.bonds !== undefined) return undefined;
    const ids = request.structure.atoms.map(atom => atom.id);
    if (!isDeepStrictEqual(ids, request.movableAtomIds)) return undefined;
    const fingerprint = displayGeometryFingerprinter(request.structure)();
    for (const session of sessions.values()) {
      if (session.owner === owner && !session.ownerClosed && session.child
        && session.displayFrames.get(request.stamp.documentId)?.has(fingerprint)) {
        return { sourceDocumentId: session.request.sourceDocumentId, runIdentity: { ...session.request.runIdentity } };
      }
    }
    return undefined;
  }

  function send(session, event, data = {}) {
    if (session.batch) return;
    if (session.ownerClosed) return;
    try {
      sendToWindow(session.owner, { schema: SCHEMA, runIdentity: session.request.runIdentity, seq: session.nextEvent++, event, ...data });
    } catch {
      closeOwner(session.owner);
    }
  }

  function noteOptimizationTiming(session, timing) {
    if (session.optStarted === undefined) return;
    const recorded={ ...timing, hostElapsedMs: performance.now() - session.optStarted };
    (session.optimizationTimings??=[]).push(recorded);
    send(session, 'optimization-timing', { timing: recorded });
  }

  async function workspace(prefix = 'pes-') {
    const parent = path.dirname(jobRoot), parentIdentity = await directoryIdentity(parent, fs);
    try { await fs.mkdir(jobRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkDirectory(parent, parentIdentity, fs);
    const current = await directoryIdentity(jobRoot, fs);
    rootIdentity ??= current;
    assert(current === rootIdentity, 'PES job root identity changed');
    const directory = await fs.mkdtemp(path.join(jobRoot, prefix));
    assert(path.dirname(directory) === path.resolve(jobRoot) && within(jobRoot, directory), 'PES workspace escaped the job root');
    const identity = await directoryIdentity(directory, fs);
    await checkDirectory(jobRoot, rootIdentity, fs);
    return { directory, identity };
  }

  function workerIdentity(worker) {
    return JSON.stringify([worker.executable, worker.args, worker.cwd, worker.workerIdentity]);
  }

  function workerEnvironment(worker, cwd, threads) {
    return { ...pythonEnvironment(worker.executable), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: String(threads),
      OMP_MAX_ACTIVE_LEVELS: '1', OMP_DYNAMIC: 'FALSE', OPENBLAS_NUM_THREADS: String(threads), MKL_NUM_THREADS: String(threads),
      MPLCONFIGDIR: path.join(cwd, 'mpl-cache'), NUMBA_CACHE_DIR: path.join(cwd, 'numba-cache') };
  }

  function shutdownWorker(worker) {
    if (worker.closing) return;
    worker.closing = true;
    if (!worker.child) return;
    try { worker.child.stdin.write(declareResident('shutdown')); } catch { /* Close is observed below. */ }
    worker.killTimer = setTimeout(() => {
      try { worker.child.kill(); } catch { /* The process close remains authoritative. */ }
    }, STOP_GRACE_MS);
    worker.killTimer.unref?.();
  }

  function trimIdleWorkers(keep) {
    for (const worker of residentWorkers) {
      if (worker !== keep && !worker.claimed && !worker.session) shutdownWorker(worker);
    }
  }

  function residentPacket(worker, packet) {
    const session = worker.session;
    if (packet?.schema !== RESIDENT_SCHEMA) {
      assert(session, 'Idle PES worker produced task output');
      session.output = session.output.then(() => { if (!session.failure) return observe(session, packet); })
        .catch(error => rejectOutput(session, error));
      return;
    }
    if (packet.event === 'released') {
      assert(session && isDeepStrictEqual(packet.runIdentity, session.request.runIdentity), 'PES worker released a different task lease');
      worker.session = null;
      void finish(session, null, null, true);
      return;
    }
    if (packet.event === 'optimizer-prepared') {
      const optimizer = worker.optimizers.get(packet.optimizer);
      assert(optimizer && !optimizer.settled && !worker.pending?.initial
        && typeof packet.ready === 'boolean' && (packet.ready || typeof packet.detail === 'string'),
      'Invalid PES optimizer preparation response');
      optimizer.settled = true;
      if (packet.ready) optimizer.resolve();
      else optimizer.reject(new Error(packet.detail));
      return;
    }
    const pending = worker.pending;
    assert(!session && pending, 'Unexpected PES resident control response');
    assert((pending.initial ? ['ready'] : ['prepared', 'prepare-failed']).includes(packet.event), 'Invalid PES resident control response');
    worker.pending = null;
    if (packet.event === 'prepare-failed') pending.reject(new Error(packet.detail));
    else {
      worker.profileKeys.add(pending.key);
      pending.resolve();
    }
  }

  function residentFailure(worker, error) {
    worker.failure ??= error;
    worker.pending?.reject(error);
    for (const optimizer of worker.optimizers.values()) optimizer.reject(error);
    if (worker.session) rejectOutput(worker.session, error);
    else shutdownWorker(worker);
  }

  function acquireWorker(resolved, profile, maySpawn) {
    const identity = workerIdentity(resolved), key = residentProfileKey(profile);
    const matches = [...residentWorkers].filter(worker => worker.identity === identity && !worker.closing && !worker.failure
      && !worker.claimed && !worker.session);
    const idle = matches.find(worker => worker.profileKeys.has(key)) ?? matches[0];
    if (idle) return idle;
    if (!maySpawn || !spawnResident || disposed) return undefined;
    const worker = { identity, claimed: false, session: null, pending: null, profileKeys: new Set(),
      optimizers: new Map(), stderr: '' };
    if (resolved.libxtbRoot) {
      for (const name of new Set(OPTIMIZER_IMPORTS.values())) {
        const optimizer = {};
        optimizer.ready = new Promise((resolve, reject) => Object.assign(optimizer, { resolve, reject }));
        optimizer.ready.catch(() => {});
        worker.optimizers.set(name, optimizer);
      }
    }
    worker.closed = new Promise(resolve => { worker.resolveClosed = resolve; });
    residentWorkers.add(worker);
    worker.launch = (async () => {
      try {
        const owned = await workspace('worker-');
        if (worker.closing || disposed) throw new Error('PES worker preparation stopped');
        await checkDirectory(owned.directory, owned.identity, fs);
        if (worker.closing || disposed) throw new Error('PES worker preparation stopped');
        const child = worker.child = spawnResident(resolved.executable, resolved.args, {
          cwd: owned.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: workerEnvironment(resolved, owned.directory, 1),
        });
        worker.reader = ndjson(packet => residentPacket(worker, packet));
        child.stdout.on('data', chunk => {
          try {
            worker.session?.release?.consumeOutput?.(chunk.length);
            worker.reader.write(chunk);
          } catch (error) { residentFailure(worker, error); }
        });
        child.stderr.on('data', chunk => {
          const excerpt = chunk.toString();
          if (worker.session) worker.session.stderr = (worker.session.stderr + excerpt).slice(-8192);
          else worker.stderr = (worker.stderr + excerpt).slice(-8192);
        });
        child.stdin.on('error', error => { if (!worker.closing) residentFailure(worker, error); });
        child.once('error', error => residentFailure(worker, error));
        child.once('close', (code, signal) => {
          clearTimeout(worker.killTimer);
          residentWorkers.delete(worker);
          worker.closing = true;
          const error = worker.failure ?? new Error(worker.stderr || `PES resident worker closed (${code}, ${signal})`);
          worker.pending?.reject(error);
          for (const optimizer of worker.optimizers.values()) optimizer.reject(error);
          if (worker.session) {
            if (worker.reader.incomplete()) worker.session.failure ??= new Error('Incomplete PES worker packet');
            void finish(worker.session, code, signal);
            worker.session = null;
          }
          worker.resolveClosed();
        });
        const prepared = new Promise((resolve, reject) => { worker.pending = { initial: true, key, resolve, reject }; });
        const library = resolved.libxtbRoot ? { libxtbRoot: resolved.libxtbRoot, libxtbManifestSha256: resolved.libxtbManifestSha256 } : null;
        child.stdin.write(declareResident('resident', { library, profile }));
        await prepared;
      } catch (error) {
        if (worker.child) residentFailure(worker, error);
        else { residentWorkers.delete(worker); worker.resolveClosed(); }
        throw error;
      }
    })();
    worker.launch.catch(() => {});
    return worker;
  }

  async function readyWorker(worker, profile) {
    await worker.launch;
    const key = residentProfileKey(profile);
    if (worker.profileKeys.has(key)) return;
    assert(!worker.closing && !worker.pending && !worker.session, 'PES worker is unavailable for preparation');
    try {
      await new Promise((resolve, reject) => {
        worker.pending = { initial: false, key, resolve, reject };
        worker.child.stdin.write(declareResident('prepare', { profile }));
      });
    } catch (error) {
      // A failed optional import does not poison a different solver's profile.
      if (worker.pending) residentFailure(worker, error);
      throw error;
    }
  }

  function queuePreparation(worker, profile) {
    const previous = worker.prepared;
    const preparing = (previous ? previous.catch(() => {}) : worker.launch).then(() => readyWorker(worker, profile));
    worker.claimed = worker.preparing = true;
    worker.prepared = preparing;
    void preparing.finally(() => {
      if (worker.prepared !== preparing) return;
      worker.preparing = false;
      worker.prepared = null;
      if (!worker.reserved) worker.claimed = false;
    }).catch(() => {});
    return preparing;
  }

  function prepareOnWorker(worker, profile) {
    const optimizer = profile.operation === 'opt' && worker.optimizers.get(OPTIMIZER_IMPORTS.get(profile.algorithm));
    // Ordinary optional imports already have a preparation on this worker.
    // Waiting on that dependency leaves the command queue available.
    return optimizer ? worker.launch.then(() => worker.profileKeys.has(residentProfileKey(profile))
      ? undefined : optimizer.ready) : queuePreparation(worker, profile);
  }

  async function prepareRequest(request, signal) {
    const resident = requiresResidentLibrary(request), fixedCellTblite = usesFixedCellTblite(request);
    const profile = residentProfile(request);
    if (!spawnResident || disposed || !(resident || fixedCellTblite)) return { state: 'deferred' };
    const resolved = await resolveRuntime(request);
    if (signal?.aborted || disposed) return { state: 'deferred' };
    if (resident && !resolved.libxtbRoot || fixedCellTblite && !resolved.tblite) {
      return { state: 'deferred' };
    }
    const worker = acquireWorker(resolved, profile, residentWorkers.size === 0)
      ?? [...residentWorkers].find(candidate => candidate.identity === workerIdentity(resolved)
        && candidate.preparing && !candidate.reserved && !candidate.failure && !candidate.closing);
    if (!worker) return { state: 'deferred' };
    const provider = Promise.resolve().then(() => fixedCellTblite ? resolved.tblite : resolveXtbRuntime(request, signal));
    const [local, backend] = await Promise.allSettled([prepareOnWorker(worker, profile), provider]);
    if (signal?.aborted || disposed || local.status !== 'fulfilled' || backend.status !== 'fulfilled' || !backend.value) {
      return { state: 'deferred' };
    }
    return { state: 'ready', provider: fixedCellTblite ? 'tblite' : 'libxtb' };
  }

  async function recordAsset(session, packet) {
    assert(!session.pathRecords.has(packet.record.id), 'Duplicate PES path record');
    const sourceDirectory = path.join(session.workspace.directory, 'path-records');
    const sourceIdentity = await directoryIdentity(sourceDirectory, fs);
    const source = path.join(sourceDirectory, packet.artifact.name);
    const stat = await fs.lstat(source);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === packet.artifact.bytes, 'PES path asset changed');
    const bytes = await fs.readFile(source);
    assert(bytes.length === packet.artifact.bytes && createHash('sha256').update(bytes).digest('hex') === packet.artifact.sha256,
      'PES path asset checksum mismatch');
    await checkDirectory(sourceDirectory, sourceIdentity, fs);
    const frames = JSON.parse(bytes.toString('utf8'));
    assert(Array.isArray(frames) && frames.length === packet.record.frames.length, 'PES path asset frame count mismatch');
    frames.forEach((frame, index) => {
      validateFrame(frame, session.request);
      const { positions, ...metadata } = frame;
      assert(isDeepStrictEqual(metadata, packet.record.frames[index]), 'PES path asset/index mismatch');
    });
    if (!session.assets) {
      const parent = path.dirname(resultRoot), parentIdentity = await directoryIdentity(parent, fs);
      try { await fs.mkdir(resultRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await checkDirectory(parent, parentIdentity, fs);
      const current = await directoryIdentity(resultRoot, fs);
      resultRootIdentity ??= current;
      assert(current === resultRootIdentity, 'PES record root identity changed');
      const directory = await fs.mkdtemp(path.join(resultRoot, 'run-'));
      session.assets = { directory, identity: await directoryIdentity(directory, fs), files: new Map(),
        readers: new Set(), request: session.request, owner: session.owner, key: session.key };
      retained.set(session.key, session.assets);
    }
    const assets = session.assets;
    await checkDirectory(resultRoot, resultRootIdentity, fs);
    await checkDirectory(assets.directory, assets.identity, fs);
    // Copy verified bytes out of the compute cache before exposing the index
    // or returning the grant. Recovery survives a main-process interruption.
    const target = path.join(assets.directory, packet.artifact.name);
    await fs.writeFile(target, bytes, { flag: 'wx' });
    assets.files.set(packet.record.id, { ...packet.artifact, record: packet.record });
    await fs.writeFile(path.join(assets.directory, 'recovery.json.tmp'), JSON.stringify({ schema: SCHEMA,
      request: session.request, records: [...assets.files.values()] }) + '\n', { flag: 'wx' });
    await fs.rename(path.join(assets.directory, 'recovery.json.tmp'), path.join(assets.directory, 'recovery.json'));
    await checkDirectory(assets.directory, assets.identity, fs);
    session.pathRecords.set(packet.record.id, packet.record);
    registerDisplayFrames(session, frames, [`${session.request.runIdentity.runId}:${packet.record.id}`]);
    send(session, 'path-record', { record: packet.record });
  }

  async function readPathRecord(owner, raw) {
    assert(raw && typeof raw.recordId === 'string', 'Invalid PES path read request');
    const identity = validateIdentity(raw.runIdentity);
    const assets = retained.get(sessionKey(owner, identity));
    assert(assets && !assets.releasing && !closedOwners.has(owner), 'PES path record is not owned or available');
    const entry = assets.files.get(raw.recordId);
    assert(entry, 'PES path record is unavailable');
    const reading = (async () => {
      await checkDirectory(resultRoot, resultRootIdentity, fs);
      await checkDirectory(assets.directory, assets.identity, fs);
      const target = path.join(assets.directory, entry.name), stat = await fs.lstat(target);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'PES path asset is not a regular file');
      const bytes = await fs.readFile(target);
      assert(bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256,
        'PES path asset checksum mismatch');
      await checkDirectory(assets.directory, assets.identity, fs);
      const frames = JSON.parse(bytes.toString('utf8'));
      frames.forEach(frame => validateFrame(frame, assets.request));
      return frames;
    })();
    assets.readers.add(reading);
    try { return await reading; } finally { assets.readers.delete(reading); }
  }

  async function releasePathRecords(owner, identity) {
    const key = sessionKey(owner, validateIdentity(identity));
    const active = sessions.get(key);
    if (active) { active.releaseRecordsRequested = true; return; }
    const assets = retained.get(key);
    if (!assets) return;
    if (assets.releasing) return assets.releasing;
    assets.releasing = (async () => {
      await Promise.allSettled([...assets.readers]);
      await checkDirectory(resultRoot, resultRootIdentity, fs);
      await checkDirectory(assets.directory, assets.identity, fs);
      const unlink = async name => { try { await fs.unlink(path.join(assets.directory, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; } };
      for (const entry of assets.files.values()) await unlink(entry.name);
      await unlink('recovery.json');
      await unlink('recovery.json.tmp');
      await fs.rmdir(assets.directory);
      retained.delete(key);
    })();
    try { await assets.releasing; } finally { assets.releasing = undefined; }
  }

  function requestStop(session) {
    if (session.finalizing || session.stopSent) return;
    session.stopSent = true;
    session.abort.abort();
    const child = session.child;
    if (!child) return;
    try {
      child.stdin.write(JSON.stringify({ schema: SCHEMA, runIdentity: session.request.runIdentity, command: 'stop' }) + '\n');
    } catch (error) {
      session.stopTransportError = errorDetail(error);
    }
    session.killTimer = setTimeout(() => {
      if (!session.finalizing) {
        try { child.kill(); } catch (error) { session.stopTransportError = errorDetail(error); }
      }
    }, STOP_GRACE_MS);
    session.killTimer.unref?.();
  }

  function rejectOutput(session, error) {
    session.failure ??= error;
    requestStop(session);
  }

  function fallback(session, status) {
    if (!session.liveFrames.size && !session.terminalOnlyFrames.size && !session.pathRecords.size && !session.scanPoints.size) return undefined;
    return {
      status: status === 'stopped' ? 'stopped' : 'partial', frames: [...session.liveFrames.values(), ...session.terminalOnlyFrames.values()],
      pathRecords: [...session.pathRecords.values()], scanPoints: [...session.scanPoints.values()],
      lastPathRecordId: [...session.pathRecords.keys()].at(-1),
      provenance: { collection: 'validated-worker-frame-prefix', sourceDocumentId: session.request.sourceDocumentId,
        method: session.request.method, algorithm: session.request.algorithm,
        coordinateUnit: 'angstrom', energyUnit: 'hartree',
        threads: session.request.threads, memoryBudgetBytes: session.request.memoryBudgetBytes },
    };
  }

  function closeResult(session, code, signal) {
    const terminal = session.terminal;
    const cause = terminal?.result?.error;
    const knownCandidateCause = session.batch && terminal?.status === 'failed' && candidateFailureCodes.has(cause?.code)
      && typeof cause.message === 'string' && cause.message.length > 0;
    const leaseSettled = session.launch?.resident ? session.workerReleased : !signal && (code === 0 || code === 1);
    if (!session.failure && !session.reader?.incomplete() && terminal
      && (!knownCandidateCause || leaseSettled)
      && (session.workerReleased || code === 0 && !signal || terminal.status === 'failed' && !signal)) {
      // If the worker completed while a stop crossed its final packet, its
      // result retains the actual scientific terminal state.
      return { status: terminal.status, ...(terminal.result === undefined ? {} : { result: terminal.result }),
        ...(terminal.error === undefined ? {} : { error: terminal.error }),
        ...(knownCandidateCause ? { candidateFailure: cause } : {}) };
    }
    const status = !session.failure && session.userStop ? 'stopped' : 'failed';
    const result = fallback(session, status) ?? (knownCandidateCause ? terminal.result : undefined);
    const missingLibrary = !session.liveFrames.size && typeof code === 'number' && (code >>> 0) === 0xC0000135;
    const message = missingLibrary ? 'PES 运行库加载失败，Windows 找不到所需的动态库。'
      : !session.child ? '无法启动 PES 计算。' : 'PES 工作进程未返回有效终态。';
    const detail = [errorDetail(session.failure), session.stopTransportError,
      knownCandidateCause && !leaseSettled ? 'PES candidate terminal arrived without a settled worker lease' : '',
      knownCandidateCause ? cause.message : '',
      missingLibrary ? `${session.request.operation} · ${session.launch.executable} · 0xC0000135` : '',
      session.workerReleased ? 'resident worker released the task lease'
        : session.child ? `worker exit code=${code}, signal=${signal ?? 'none'}` : '', session.stderr].filter(Boolean).join('\n');
    const protectionFault = signal === 'SIGSEGV' || typeof code === 'number' && (code >>> 0) === 0xC0000005;
    // libxtb and tblite can exit the resident process from inside a native call.
    // Only a validated E/G boundary from the active xTB lease qualifies a bare exit 1.
    const xTBBackend = session.launch?.libxtbRoot ? 'libxtb' : usesFixedCellTblite(session.request) ? 'tblite' : undefined;
    const nativeExitOne = code === 1 && !signal && xTBBackend && session.evaluationBackend === xTBBackend;
    const candidateFailure = session.batch && !session.failure && !session.userStop && !terminal
      && session.launch?.resident && session.evaluationBackend && (protectionFault || nativeExitOne)
      ? { code: 'PES_CANDIDATE_NATIVE_EXIT', message: `本构象求值进程异常退出。 ${detail}` } : undefined;
    return { status, ...(result ? { result } : {}), ...(status === 'failed' ? {
      error: { message, ...(detail ? { detail } : {}) },
    } : {}), ...(candidateFailure ? { candidateFailure } : {}) };
  }

  async function preserveFailure(session, outcome, code, signal) {
    if (!session.workspace || outcome.status === 'completed' && !session.ownerClosed
      && (!session.batch||outcome.result?.status==='completed'&&!session.batchRecovery)) return;
    const { directory, identity } = session.workspace;
    await checkDirectory(directory, identity, fs);
    const write = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value) + '\n', { flag: 'wx' });
    // Register recovery first. If a later write encounters a storage failure,
    // the shared cache still preserves the available native raw files.
    await write('.retain-recovery.json', { schema: 1, reason: `pes-${outcome.status}` });
    await write('run-diagnostics.json', { schema: SCHEMA, runIdentity: session.request.runIdentity,
      sourceDocumentId: session.request.sourceDocumentId, worker: session.launch, engineIdentity: session.engineIdentity,
      status: outcome.status, ...(session.workerReleased ? { workerLeaseReleased: true } : { exit: { code, signal } }),
      error: outcome.error, candidateFailure: outcome.candidateFailure, stderr: session.stderr,
      acceptedFrames: session.liveFrames.size,
      ...(session.optimizationTimings ? { optimizationTimings: session.optimizationTimings } : {}) });
    if (outcome.result) await write('run-result.json', outcome.result);
    await checkDirectory(directory, identity, fs);
  }

  async function finish(session, code = null, signal = null, workerReleased = false) {
    if (session.finalizing) return;
    session.finalizing = true;
    session.workerReleased = workerReleased;
    clearTimeout(session.killTimer);
    await session.output;
    let outcome = closeResult(session, code, signal);
    if(session.batch){
      try {
        await session.batch.onTerminal({ ...outcome, nativeStarted:!!session.child,
          resourceGrant:session.release?.resources });
      } catch(error) {
        session.batchRecovery=true;
        session.failure??=error;
      }
    }
    try {
      await preserveFailure(session, outcome, code, signal);
    } catch (error) {
      const warning = `PES 恢复资料保存失败：${errorDetail(error)}`;
      if (outcome.error) outcome.error = { ...outcome.error, detail: [outcome.error.detail, warning].filter(Boolean).join('\n') };
      if (outcome.result) outcome.result = { ...outcome.result, provenance: { ...outcome.result.provenance, recoveryWarning: warning } };
    }
    let terminalRecord, numericAssets;
    const identity = session.request.runIdentity;
    const standaloneOpt = session.request.operation === 'opt'
      && identity.groupId === `model-${identity.runId}` && identity.taskId === identity.runId;
    if (pagedTerminalFrames && !session.batch && !standaloneOpt && outcome.result
      && (outcome.result.frames.length > 1 || session.numericFiles)) {
      try {
        let numericMarker = false;
        if (session.numericFiles) {
          // Establish the owner recovery hold before writing any destination
          // manifest. A renderer or host loss cannot orphan the source values.
          const marker = path.join(session.workspace.directory, '.retain-recovery.json');
          try {
            await fs.writeFile(marker, JSON.stringify({ schema: 1, reason: 'pes-terminal-binary', runIdentity: identity,
              files: [...session.numericFiles.values()].map(({ name, shape, bytes, sha256 }) => ({ name, shape, bytes, sha256 })) }) + '\n', { flag: 'wx' });
            numericMarker = true;
          } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        terminalRecord = await persistTerminalFrames(session, outcome);
        terminalRecord.numericMarker = numericMarker;
        terminalRecord.runIdentity = identity;
        terminalRecord.keepNumericalRecovery = !!session.numericFiles
          && (outcome.status !== 'completed' || outcome.result.status !== 'completed' || !!outcome.error);
        if (session.numericFiles) {
          if (!session.ownerClosed) {
            numericAssets = {};
            for (const [kind, file] of session.numericFiles) {
              const descriptor = await registerBinaryAsset(session.owner, file.target, { sha256: file.sha256 });
              assert(descriptor && typeof descriptor.id === 'string' && descriptor.bytesLength === file.bytes,
                'PES binary terminal registration changed its receipt');
              numericAssets[kind] = { ...descriptor, shape: file.shape, sha256: file.sha256 };
            }
          }
        }
      }
      catch (error) {
        // Keep the verified in-process prefix if the result volume reports
        // an actual write failure, and expose that limited recovery state.
        terminalRecord ??= { owner: session.owner, frames: outcome.result.frames };
        numericAssets = undefined;
        if (session.numericFiles) outcome.error ??= { message: '优化数值结果接管受限。', detail: errorDetail(error) };
        outcome.result = { ...outcome.result, provenance: { ...outcome.result.provenance,
          terminalRecoveryWarning: errorDetail(error) } };
      }
    }
    try {
      await session.release?.();
    } catch (error) {
      session.releaseFailure = error;
      session.failure ??= error;
      outcome = closeResult(session, code, signal);
    } finally {
      sessions.delete(session.key);
      const worker = session.residentWorker;
      if (worker) {
        worker.reserved = false;
        worker.claimed = worker.preparing;
        if (disposed || session.child && (session.failure || !session.terminal)) shutdownWorker(worker);
        else if (!worker.claimed && !worker.closing) trimIdleWorkers(worker);
      }
      if (session.releaseRecordsRequested) {
        try { await releasePathRecords(session.owner, session.request.runIdentity); }
        catch (error) {
          if (outcome.result) outcome.result = { ...outcome.result,
            provenance: { ...outcome.result.provenance, releaseWarning: errorDetail(error) } };
        }
      }
      const frames = outcome.result?.frames;
      noteOptimizationTiming(session, { phase: 'terminal-published' });
      if (pagedTerminalFrames && !session.batch && !session.ownerClosed && standaloneOpt && frames?.length > 1) {
        // The standalone model OPT consumer takes only the last valid result.
        send(session, 'terminal', { workerSettled: true, ...outcome,
          result: { ...outcome.result, frames: [frames.at(-1)] } });
      } else if (terminalRecord && !session.ownerClosed && (frames?.length > 1 || numericAssets)) {
        terminalFrames.set(session.key, terminalRecord);
        send(session, 'terminal', { workerSettled: true, ...outcome,
          ...(frames?.length > 1 ? { result: { ...outcome.result, frames: [] }, resultFrameIds: frames.map(frame => frame.id) } : {}),
          ...(numericAssets ? { resultNumericAssets: numericAssets } : {}) });
      } else {
        send(session, 'terminal', { workerSettled: true, ...outcome });
      }
      // A closing renderer has no live readers. Its recovery manifest and
      // coordinate files remain for an interrupted save; drop only JS leases.
      if (session.ownerClosed) retained.delete(session.key);
      session.resolveFinished();
    }
  }

  async function observe(session, packet) {
    assert(!session.terminal, 'Worker produced PES output after terminal');
    const knownFrames = packet?.event === 'terminal' && session.terminalOnlyFrames.size
      ? new Map([...session.liveFrames, ...session.terminalOnlyFrames]) : session.liveFrames;
    const value = validateEvent(packet, session.request, session.nextWorkerEvent++, knownFrames);
    if (value.event === 'terminal') {
      const finalFrames = new Map(value.result?.frames.map(frame => [frame.id, frame]));
      for (const [id, frame] of session.liveFrames) {
        assert(frame === finalFrames.get(id) || isDeepStrictEqual(frame, finalFrames.get(id)), 'PES terminal changed or omitted an accepted live frame');
      }
      const finalRecords = new Map(value.result?.pathRecords?.map(record => [record.id, record]));
      assert(finalRecords.size === session.pathRecords.size, 'PES terminal contains an unavailable path asset');
      for (const [id, record] of session.pathRecords) {
        const final = finalRecords.get(id);
        assert(isDeepStrictEqual(record, final) || final?.kind === 'final'
          && isDeepStrictEqual({ ...record, kind: 'final' }, final), 'PES terminal changed or omitted a path record');
      }
      if (session.scanPoints.size) {
        const finalPoints = new Map(value.result?.scanPoints?.map(item => [item.pointIndex, item]));
        for (const point of session.scanPoints.values())
          assert(isDeepStrictEqual(point, finalPoints.get(point.pointIndex)), 'PES terminal changed a scan point');
      }
      if (session.assets) {
        await checkDirectory(session.assets.directory, session.assets.identity, fs);
        await fs.writeFile(path.join(session.assets.directory, 'recovery.json.tmp'), JSON.stringify({ schema: SCHEMA,
          request: session.request, records: [...session.assets.files.values()], result: value.result,
          status: value.status, error: value.error }) + '\n', { flag: 'wx' });
        await fs.rename(path.join(session.assets.directory, 'recovery.json.tmp'), path.join(session.assets.directory, 'recovery.json'));
      }
      if (value.resultNumericFiles) {
        assert(typeof registerBinaryAsset === 'function' && !session.batch, 'Unexpected PES binary terminal data');
        session.numericFiles = await verifyTerminalNumericalFiles(session, value.resultNumericFiles);
      }
      session.terminal = value;
    } else if (value.event === 'path-record') {
      await recordAsset(session, value);
    } else if (value.event === 'scan-point') {
      assert(!session.scanPoints.has(value.point.pointIndex), 'Duplicate live PES scan point');
      session.scanPoints.set(value.point.pointIndex, value.point);
      send(session, 'scan-point', { point: value.point });
    } else if (value.event === 'terminal-frame') {
      assert(pagedTerminalFrames && !session.batch && !session.liveFrames.has(value.frame.id)
        && !session.terminalOnlyFrames.has(value.frame.id), 'Duplicate or unexpected PES terminal-only frame');
      session.terminalOnlyFrames.set(value.frame.id, value.frame);
    } else if (value.event === 'frame') {
      assert(!session.terminalOnlyFrames.size, 'Live PES frame followed terminal-only data');
      assert(!session.liveFrames.has(value.frame.id), 'Duplicate live PES frame');
      session.liveFrames.set(value.frame.id, value.frame);
      const frame = value.frame, runId = session.request.runIdentity.runId;
      registerDisplayFrames(session, [frame], [`${runId}:${frame.seriesId}`,
        ...(frame.seriesId === 'path-iterations' ? [`${runId}:${frame.seriesId}:${frame.phase}:${frame.step}`] : []),
        ...(session.request.operation === 'scan' ? [`${runId}:scan-other:${frame.id}`] : [])]);
      send(session, 'frame', { frame: value.frame });
      if (session.optStarted !== undefined && frame.seriesId === 'opt') {
        if (frame.step === 0) noteOptimizationTiming(session, { phase: 'initial-frame', step: frame.step });
        else if (!session.optAcceptedStep) {
          session.optAcceptedStep = true;
          noteOptimizationTiming(session, { phase: 'first-accepted-step', step: frame.step });
        }
      }
    } else if (value.event === 'evaluation-started') {
      assert(!session.evaluationBackend, 'PES worker repeated its first physical evaluation timestamp');
      const { physicalEvaluationStartedAtMs, backend, clockSource } = value;
      session.evaluationBackend = backend;
      send(session, 'evaluation-started', { physicalEvaluationStartedAtMs, backend, clockSource });
    } else if (value.event === 'optimization-timing') {
      noteOptimizationTiming(session, value.timing);
    } else if (!session.stopSent) {
      const { schema, runIdentity, seq, event, ...data } = value;
      send(session, 'progress', data);
    }
  }

  async function startOwned(owner, raw, beforeStart, batch) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner), 'PES owner is unavailable');
    const request = validateStart(raw), key = sessionKey(owner, request.runIdentity);
    assert(request.parameters.batchFinalOnly===undefined,'PES batch output policy is reserved for the trusted conformer host');
    if(batch)request.parameters.batchFinalOnly=true;
    assert(!sessions.has(key) && !retained.has(key) && !terminalFrames.has(key), 'PES run identity is already active or owned');
    const session = { owner, key, request, batch, abort: new AbortController(), nextWorkerEvent: 0, nextEvent: 0,
      liveFrames: new Map(), terminalOnlyFrames: new Map(), pathRecords: new Map(), scanPoints: new Map(), displayFrames: new Map(), output: Promise.resolve(), stderr: '' };
    if (request.operation === 'opt' && !batch) session.optStarted = performance.now();
    if(!batch){
      session.fingerprintDisplayGeometry=displayGeometryFingerprinter({ ...request.structure, charge: request.charge, multiplicity: request.uhf + 1 });
      session.displayFrames.set(request.sourceDocumentId, new Set([session.fingerprintDisplayGeometry()]));
    }
    session.finished = new Promise(resolve => { session.resolveFinished = resolve; });
    sessions.set(key, session);
    const { signal } = session.abort;
    try {
      noteOptimizationTiming(session, { phase: 'resource-resolution' });
      const resources = !batch&&resolveResources ? await abortable(resolveResources(owner, structuredClone(request)), signal) : undefined;
      if (signal.aborted) throw new Error('PES start stopped');
      beforeStart();
      // Await shared admission itself. Even a provider that returns a late
      // grant after abort must release it before settle/stop resolves.
      noteOptimizationTiming(session, { phase: 'admission-wait' });
      const release = await (batch ? admitCandidate(owner,batch.admissionRequest,{signal})
        : admit(owner, structuredClone(request), { signal, resources }));
      assert(typeof release === 'function', 'Missing PES shared resource release');
      session.release = release;
      const actual = release.resources;
      assert(Number.isSafeInteger(actual?.threads) && actual.threads > 0
        && Number.isSafeInteger(actual.memoryBudgetBytes) && actual.memoryBudgetBytes > 0, 'Missing PES shared resource grant');
      request.threads = actual.threads;
      request.memoryBudgetBytes = actual.memoryBudgetBytes;
      if (signal.aborted) throw new Error('PES start stopped');
      noteOptimizationTiming(session, { phase: 'runtime-resolution' });
      const worker = await abortable(resolveRuntime(request), signal);
      assert(worker && path.isAbsolute(worker.executable) && path.isAbsolute(worker.cwd)
        && Array.isArray(worker.args) && worker.args.every(arg => typeof arg === 'string') && worker.args.includes('--pes-worker'), 'Trusted PES worker runtime required');
      const resident = requiresResidentLibrary(request);
      if (resident) assert(typeof worker.libxtbRoot === 'string' && path.isAbsolute(worker.libxtbRoot),
        `PES v222 常驻 xTB 运行库不可用。${worker.libxtbError ? ` ${worker.libxtbError}` : ''}`);
      const tblite = usesFixedCellTblite(request) ? worker.tblite : undefined;
      let provider;
      if (tblite) {
        provider = { tblite };
      } else {
        provider = await abortable(batch?.capturedRuntime ?? resolveXtbRuntime(request, signal), signal);
        assert(provider && ['executable', 'directory', 'dataDirectory'].every(key => typeof provider[key] === 'string' && path.isAbsolute(provider[key])),
          'PES 需要可信的 xTB 命令行运行组件。');
      }
      const runtime = { ...provider, ...(pagedTerminalFrames && !batch ? { compactTerminalFrames: true,
        ...(!batch && registerBinaryAsset ? { binaryTerminalFields: true } : {}) } : {}),
        ...(resident ? { libxtbRoot: worker.libxtbRoot,
        libxtbManifestSha256: worker.libxtbManifestSha256 } : {}) };
      noteOptimizationTiming(session, { phase: 'workspace-preparation' });
      const owned = await workspace();
      session.workspace = owned;
      session.launch = { executable: worker.executable, args: worker.args,
        ...(resident ? { libxtbRoot: worker.libxtbRoot } : {}) };
      session.engineIdentity = runtime.engineIdentity;
      await checkDirectory(owned.directory, owned.identity, fs);
      beforeStart();
      if (signal.aborted) throw new Error('PES start stopped');
      if (spawnResident && (resident || tblite)) {
        const profile = residentProfile(request);
        const previousLane = acquireWorker(worker, profile, false) ?? [...residentWorkers].find(candidate => candidate.identity === workerIdentity(worker)
          && !candidate.closing && !candidate.failure && candidate.preparing && !candidate.reserved);
        const lane = previousLane ?? acquireWorker(worker, profile, true);
        assert(lane, 'PES resident worker unavailable');
        noteOptimizationTiming(session, { phase: 'worker-readiness', workerMode: !previousLane ? 'resident-new'
          : lane.profileKeys.has(residentProfileKey(profile)) && !lane.preparing ? 'resident-ready' : 'resident-preparing' });
        session.residentWorker = lane;
        lane.claimed = lane.reserved = true;
        // A previously dispatched explicit prepare still owns its response.
        // Eager imports only publish independent optimizer-ready messages.
        if (lane.prepared) await abortable(lane.prepared.catch(() => {}), signal);
        await abortable(prepareOnWorker(lane, profile), signal);
        assert(!lane.closing && !lane.session && !lane.failure, 'PES resident worker no longer owns a free lease');
        beforeStart();
        if (signal.aborted) throw new Error('PES start stopped');
        lane.session = session;
        session.child = lane.child;
        session.launch.resident = true;
        lane.child.stdin.write(declareResident('run', { payload: { request, runtime, workspace: owned.directory } }));
        send(session, 'started');
        noteOptimizationTiming(session, { phase: 'worker-dispatched' });
        return;
      }
      noteOptimizationTiming(session, { phase: 'worker-readiness', workerMode: 'process' });
      const child = session.child = spawn(worker.executable, worker.args, {
        cwd: owned.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: workerEnvironment(worker, owned.directory, request.threads),
      });
      session.reader = ndjson(packet => {
        session.output = session.output.then(() => { if (!session.failure) return observe(session, packet); })
          .catch(error => rejectOutput(session, error));
      });
      child.stdout.on('data', chunk => {
        if (session.failure || session.finalizing) return;
        try { if(batch)session.release?.consumeOutput?.(chunk.length); session.reader.write(chunk); } catch (error) { rejectOutput(session, error); }
      });
      child.stderr.on('data', chunk => {
        // Full library output is kept by the worker in its job log. Retain
        // an excerpt of bootstrap errors without using it as a run limit.
        session.stderr = (session.stderr + chunk.toString()).slice(-8192);
      });
      child.stdin.on('error', error => { if (!session.userStop && !session.terminal) rejectOutput(session, error); });
      child.once('error', error => rejectOutput(session, error));
      child.once('close', (code, signal) => { void finish(session, code, signal); });
      child.stdin.write(JSON.stringify({ request, runtime, workspace: owned.directory }) + '\n');
      send(session, 'started');
      noteOptimizationTiming(session, { phase: 'worker-dispatched' });
    } catch (error) {
      if (!session.userStop) session.failure ??= error;
      if (session.child) requestStop(session);
      else await finish(session);
    }
  }

  function start(owner, raw, beforeStart = () => {}) {
    return startOwned(owner,raw,beforeStart);
  }

  async function prepare(owner, raw, beforeStart = () => {}) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner), 'PES owner is unavailable');
    const request = validateStart(raw);
    assert(request.parameters.batchFinalOnly === undefined, 'PES batch output policy is reserved for the trusted conformer host');
    beforeStart();
    const sameProfile = JSON.stringify([residentProfile(request), request.method, request.parameters.device,
      request.structure.cell?.pbc, request.uhf]);
    const previous = preparingOwners.get(owner);
    if (previous?.profile === sameProfile) return previous.promise;
    previous?.abort.abort();
    const preparation = { profile: sameProfile, abort: new AbortController() };
    preparation.promise = prepareRequest(request, preparation.abort.signal).catch(() => ({ state: 'deferred' }));
    preparingOwners.set(owner, preparation);
    try { return await preparation.promise; }
    finally { if (preparingOwners.get(owner) === preparation) preparingOwners.delete(owner); }
  }

  async function prewarm() {
    try { return await prepareRequest(DEFAULT_PREPARATION); }
    catch { return { state: 'deferred' }; }
  }

  function startCandidate(owner, raw, admissionRequest, beforeStart, onTerminal, capturedRuntime) {
    assert(raw.operation==='opt'&&admissionRequest.calculation==='optimize'
      &&raw.method===admissionRequest.method&&raw.sourceDocumentId===admissionRequest.stamp?.documentId
      &&admissionRequest.optimizationPool&&typeof admitCandidate==='function'
      &&typeof onTerminal==='function','Dedicated conformer candidate admission required');
    const starting=startOwned(owner,raw,beforeStart,{admissionRequest,onTerminal,capturedRuntime});
    const session=sessions.get(sessionKey(owner,raw.runIdentity));
    return Promise.all([starting, session?.finished]).then(result => {
      if (session?.releaseFailure) throw session.releaseFailure;
      return result;
    });
  }

  function stop(owner, identity) {
    const session = sessions.get(sessionKey(owner, validateIdentity(identity)));
    assert(session, 'PES run is not owned or active');
    session.userStop = true;
    requestStop(session);
    return session.finished;
  }

  async function verifyTerminalNumericalFiles(session, files) {
    const { directory, identity } = session.workspace;
    await checkDirectory(directory, identity, fs);
    const records = new Map();
    for (const [kind, expected] of Object.entries(files)) {
      const target = path.join(directory, expected.name), selected = await fs.lstat(target);
      assert(selected.isFile() && !selected.isSymbolicLink() && selected.nlink === 1 && selected.size === expected.bytes,
        'PES binary terminal evidence changed');
      const handle = await fs.open(target, 'r');
      try {
        const opened = await handle.stat();
        assert(opened.dev === selected.dev && opened.ino === selected.ino && opened.size === selected.size,
          'PES binary terminal evidence changed while opening');
        const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, expected.bytes));
        for (let offset = 0; offset < expected.bytes;) {
          const length = Math.min(buffer.length, expected.bytes - offset);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
            assert(bytesRead > 0, 'PES binary terminal evidence truncated');
            read += bytesRead;
          }
          for (let at = 0; at < length; at += 8)
            assert(Number.isFinite(buffer.readDoubleLE(at)), 'Nonfinite PES numerical terminal evidence');
          digest.update(buffer.subarray(0, length));
          offset += length;
        }
        const closed = await handle.stat(), current = await fs.lstat(target);
        assert(digest.digest('hex') === expected.sha256 && closed.size === selected.size
          && closed.mtimeMs === selected.mtimeMs && current.dev === selected.dev && current.ino === selected.ino
          && current.size === selected.size && current.mtimeMs === selected.mtimeMs,
          'PES binary terminal evidence checksum or identity changed');
        records.set(kind, { ...expected, target, inode: selected.ino, device: selected.dev });
      } finally { await handle.close(); }
    }
    await checkDirectory(directory, identity, fs);
    return records;
  }

  async function persistTerminalFrames(session, outcome) {
    const frames = outcome.result.frames;
    // Unit hosts built without a real disk implement only the lightweight
    // read/write facade. A real desktop always provides ordinary fs.open.
    if (typeof fs.open !== 'function') return { owner: session.owner, frames };
    const parent = path.dirname(resultRoot), parentIdentity = await directoryIdentity(parent, fs);
    try { await fs.mkdir(resultRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkDirectory(parent, parentIdentity, fs);
    const current = await directoryIdentity(resultRoot, fs);
    resultRootIdentity ??= current;
    assert(current === resultRootIdentity, 'PES result root identity changed');
    const directory = await fs.mkdtemp(path.join(resultRoot, 'terminal-'));
    const identity = await directoryIdentity(directory, fs);
    const rows = [], target = path.join(directory, 'frames.jsonl');
    const output = await fs.open(target, 'wx');
    let offset = 0;
    try {
      for (const frame of frames) {
        const bytes = Buffer.from(JSON.stringify(frame) + '\n');
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await output.write(bytes, written, bytes.length - written, offset + written);
          assert(bytesWritten > 0, 'PES terminal frame write stalled');
          written += bytesWritten;
        }
        rows.push({ id: frame.id, offset, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        offset += bytes.length;
      }
      await output.sync();
    } finally { await output.close(); }
    await checkDirectory(directory, identity, fs);
    const manifest = path.join(directory, 'terminal.json');
    const write = await fs.open(manifest, 'wx');
    try {
      const { frames: _frames, hessian, frequencies, ...metadata } = outcome.result;
      const numerical = session.numericFiles ? {
        workspace: session.workspace.directory,
        files: Object.fromEntries([...session.numericFiles].map(([kind, { name, shape, bytes, sha256 }]) =>
          [kind, { name, shape, bytes, sha256 }])),
        hessian, frequencies,
      } : undefined;
      await write.writeFile(JSON.stringify({ schema: 'ester-pes-terminal/v1', identity: session.request.runIdentity,
        request: session.request, status: outcome.status, result: metadata, error: outcome.error, rows, numerical }) + '\n');
      await write.sync();
    } finally { await write.close(); }
    return { owner: session.owner, directory, identity, rows, bytes: offset, reads: new Set(), numericalFiles: session.numericFiles, workspace: session.workspace };
  }

  async function readTerminalFrames(owner, { runIdentity, offset, limit }) {
    const record = terminalFrames.get(sessionKey(owner, validateIdentity(runIdentity)));
    assert(record?.owner === owner && !closedOwners.has(owner), 'PES terminal frames are not owned or available');
    const count = record.rows?.length ?? record.frames.length;
    assert(!record.releasing && Number.isSafeInteger(offset) && offset >= 0 && offset <= count &&
      Number.isSafeInteger(limit) && limit > 0, 'Invalid PES terminal frame page');
    const reading = (async () => {
      const frames = [];
      let size = 0;
      if (record.rows) await checkDirectory(record.directory, record.identity, fs);
      const handle = record.rows ? await fs.open(path.join(record.directory, 'frames.jsonl'), 'r') : null;
      try {
        if (handle) {
          const stat = await handle.stat();
          assert(stat.isFile() && stat.nlink === 1 && stat.size === record.bytes, 'PES terminal frame record changed');
        }
        for (let index = offset; index < Math.min(count, offset + Math.min(limit, 64)); index++) {
          const row = record.rows?.[index], bytes = row?.length ?? record.frames[index].positions.length * 56 + 256;
          if (frames.length && size + bytes > 8 * 1024 ** 2) break;
          if (!row) frames.push(record.frames[index]);
          else {
            const data = Buffer.allocUnsafe(row.length);
            let read = 0;
            while (read < data.length) {
              const { bytesRead } = await handle.read(data, read, data.length - read, row.offset + read);
              assert(bytesRead > 0, 'PES terminal frame record truncated');
              read += bytesRead;
            }
            assert(createHash('sha256').update(data).digest('hex') === row.sha256, 'PES terminal frame checksum changed');
            const frame = JSON.parse(data.toString('utf8'));
            assert(frame.id === row.id, 'PES terminal frame identity changed');
            frames.push(frame);
          }
          size += bytes;
        }
      } finally { await handle?.close(); }
      return { frames, offset, total: count, done: offset + frames.length === count };
    })();
    record.reads?.add(reading);
    try { return await reading; } finally { record.reads?.delete(reading); }
  }

  async function releaseTerminalFrames(owner, identity) {
    const key = sessionKey(owner, validateIdentity(identity)), record = terminalFrames.get(key);
    if (!record) return false;
    if (record.releasing) return record.releasing;
    record.releasing = (async () => {
      await Promise.allSettled([...(record.reads ?? [])]);
      if (record.keepNumericalRecovery) {
        terminalFrames.delete(key);
        return true;
      }
      if (record.numericalFiles) {
        const { directory, identity } = record.workspace;
        await checkDirectory(directory, identity, fs);
        for (const file of record.numericalFiles.values()) {
          const current = await fs.lstat(file.target);
          assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.size === file.bytes
            && current.dev === file.device && current.ino === file.inode, 'PES numerical recovery file changed');
          await fs.unlink(file.target);
        }
        if (record.numericMarker) {
          const marker = path.join(directory, '.retain-recovery.json');
          const raw = JSON.parse(await fs.readFile(marker, 'utf8'));
          assert(raw.reason === 'pes-terminal-binary' && isDeepStrictEqual(raw.runIdentity, record.runIdentity), 'PES recovery marker changed');
          await fs.unlink(marker);
        }
      }
      if (record.directory) {
        await checkDirectory(record.directory, record.identity, fs);
        for (const fixed of ['frames.jsonl', 'terminal.json']) {
          const target = path.join(record.directory, fixed), stat = await fs.lstat(target);
          assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'PES terminal recovery file changed');
          await fs.unlink(target);
        }
        await fs.rmdir(record.directory);
      }
      terminalFrames.delete(key);
      return true;
    })();
    try { return await record.releasing; } finally { record.releasing = undefined; }
  }

  function closeOwner(owner) {
    closedOwners.add(owner);
    for (const [key, record] of terminalFrames) if (record.owner === owner) terminalFrames.delete(key);
    preparingOwners.get(owner)?.abort.abort();
    for (const session of sessions.values()) {
      if (session.owner !== owner) continue;
      session.ownerClosed = session.userStop = true;
      requestStop(session);
    }
    for (const [key, assets] of retained) {
      if (assets.owner === owner && !sessions.has(key)) retained.delete(key);
    }
  }

  function dispose() {
    disposed = true;
    terminalFrames.clear();
    for (const preparation of preparingOwners.values()) preparation.abort.abort();
    for (const session of sessions.values()) closeOwner(session.owner);
    for (const worker of residentWorkers) if (!worker.session) shutdownWorker(worker);
  }

  async function settle(owner) {
    await Promise.all([...sessions.values()].filter(session => owner === undefined || session.owner === owner)
      .map(session => session.finished));
    if (disposed && owner === undefined) await Promise.all([...residentWorkers].map(worker => worker.closed));
  }

  return { start, startCandidate, prepare, prewarm, stop, closeOwner, dispose, settle,
    readPathRecord, releasePathRecords, readTerminalFrames, releaseTerminalFrames, authorizeEmpiricalDisplay, activeCount: () => sessions.size,
    workerCount: () => [...residentWorkers].filter(worker => worker.child).length };
}

module.exports = { createPesHost };
