'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const { assert, within } = require('./security.cjs');
const { checkDirectory, directoryIdentity } = require('./portable-storage.cjs');
const { SCHEMA, validateStart, validateIdentity, validateEvent, validateFrame, requiresResidentLibrary } = require('./pes-security.cjs');

// This grace period is only for an already-requested stop. A running
// calculation has no host wall-time, evaluation, frame or output ceiling.
const STOP_GRACE_MS = 2000;

function errorDetail(error) { return String(error?.message ?? error ?? ''); }

// Rendering may use an empirical graph while this same PES run holds the
// scientific lease. Keep only fingerprints, never a second coordinate history.
function displayGeometryFingerprint(structure, positions) {
  const atoms = structure.atoms.map((atom, index) => {
    const { x, y, z, stereoParity, aromaticHydrogen, ...metadata } = atom;
    return [Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)), positions?.[index] ?? [x, y, z]];
  });
  return createHash('sha256').update(JSON.stringify([structure.id, atoms,
    structure.charge ?? 0, structure.multiplicity ?? 1, structure.cell ?? null])).digest('hex');
}

function pythonEnvironment(executable) {
  const python = path.dirname(executable);
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot || 'C:\\Windows';
    // Windows compares environment keys case-insensitively. Do not let the
    // inherited Path take precedence over the portable interpreter's DLLs.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    env.PATH = [path.join(python, 'Library', 'bin'), python, path.join(windows, 'System32'), windows].join(path.delimiter);
    return env;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:PATH$|CONDA_|_CONDA_|VIRTUAL_ENV$|PYTHON|_PYTHON_|_CE_CONDA$|_CE_M$|DYLD_|LD_|RDBASE$)/i.test(key)));
  env.PATH = [python, '/usr/bin', '/bin'].join(path.delimiter);
  const libPaths = [path.resolve(python, '..', 'lib'), python, ...(process.platform === 'darwin' ? ['/usr/lib'] : [])].join(path.delimiter);
  if (process.platform === 'darwin') env.DYLD_FALLBACK_LIBRARY_PATH = libPaths;
  else env.LD_LIBRARY_PATH = libPaths;
  return env;
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

function createPesHost({ spawn, resolveRuntime, resolveXtbRuntime, jobRoot, resultRoot = `${jobRoot}-records`, resolveResources, admit, sendToWindow,
  fs = require('node:fs/promises') }) {
  assert(path.isAbsolute(jobRoot) && typeof admit === 'function', 'Trusted PES job root and shared admission required');
  assert(path.isAbsolute(resultRoot) && !within(jobRoot, resultRoot), 'PES records need a separate owned result root');
  const sessions = new Map(), retained = new Map(), closedOwners = new Set();
  let disposed = false, rootIdentity, resultRootIdentity;
  const sessionKey = (owner, identity) => JSON.stringify([owner, identity.groupId, identity.taskId, identity.runId]);

  function registerDisplayFrames(session, frames, aliases) {
    for (const alias of aliases) {
      let fingerprints = session.displayFrames.get(alias);
      if (!fingerprints) session.displayFrames.set(alias, fingerprints = new Set());
      for (const frame of frames) fingerprints.add(displayGeometryFingerprint({ ...session.request.structure,
        charge: session.request.charge, multiplicity: session.request.uhf + 1 }, frame.positions));
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
    const fingerprint = displayGeometryFingerprint(request.structure);
    for (const session of sessions.values()) {
      if (session.owner === owner && !session.ownerClosed && session.child
        && session.displayFrames.get(request.stamp.documentId)?.has(fingerprint)) {
        return { sourceDocumentId: session.request.sourceDocumentId, runIdentity: { ...session.request.runIdentity } };
      }
    }
    return undefined;
  }

  function send(session, event, data = {}) {
    if (session.ownerClosed) return;
    try {
      sendToWindow(session.owner, { schema: SCHEMA, runIdentity: session.request.runIdentity, seq: session.nextEvent++, event, ...data });
    } catch {
      closeOwner(session.owner);
    }
  }

  async function workspace() {
    const parent = path.dirname(jobRoot), parentIdentity = await directoryIdentity(parent, fs);
    try { await fs.mkdir(jobRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkDirectory(parent, parentIdentity, fs);
    const current = await directoryIdentity(jobRoot, fs);
    rootIdentity ??= current;
    assert(current === rootIdentity, 'PES job root identity changed');
    const directory = await fs.mkdtemp(path.join(jobRoot, 'pes-'));
    assert(path.dirname(directory) === path.resolve(jobRoot) && within(jobRoot, directory), 'PES workspace escaped the job root');
    const identity = await directoryIdentity(directory, fs);
    await checkDirectory(jobRoot, rootIdentity, fs);
    return { directory, identity };
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
    if (!session.liveFrames.size && !session.pathRecords.size && !session.scanPoints.size) return undefined;
    return {
      status: status === 'stopped' ? 'stopped' : 'partial', frames: [...session.liveFrames.values()],
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
    if (!session.failure && !session.reader?.incomplete() && terminal && (code === 0 && !signal || terminal.status === 'failed' && !signal)) {
      // If the worker completed while a stop crossed its final packet, its
      // result retains the actual scientific terminal state.
      return { status: terminal.status, ...(terminal.result === undefined ? {} : { result: terminal.result }),
        ...(terminal.error === undefined ? {} : { error: terminal.error }) };
    }
    const status = !session.failure && session.userStop ? 'stopped' : 'failed';
    const result = fallback(session, status);
    const missingLibrary = !session.liveFrames.size && typeof code === 'number' && (code >>> 0) === 0xC0000135;
    const message = missingLibrary ? 'PES 运行库加载失败，Windows 找不到所需的动态库。'
      : !session.child ? '无法启动 PES 计算。' : 'PES 工作进程未返回有效终态。';
    const detail = [errorDetail(session.failure), session.stopTransportError,
      missingLibrary ? `${session.request.operation} · ${session.launch.executable} · 0xC0000135` : '',
      session.child ? `worker exit code=${code}, signal=${signal ?? 'none'}` : '', session.stderr].filter(Boolean).join('\n');
    return { status, ...(result ? { result } : {}), ...(status === 'failed' ? {
      error: { message, ...(detail ? { detail } : {}) },
    } : {}) };
  }

  async function preserveFailure(session, outcome, code, signal) {
    if (!session.workspace || outcome.status === 'completed' && !session.ownerClosed) return;
    const { directory, identity } = session.workspace;
    await checkDirectory(directory, identity, fs);
    const write = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value) + '\n', { flag: 'wx' });
    // Register recovery first. If a later write encounters a storage failure,
    // the shared cache still preserves the available native raw files.
    await write('.retain-recovery.json', { schema: 1, reason: `pes-${outcome.status}` });
    await write('run-diagnostics.json', { schema: SCHEMA, runIdentity: session.request.runIdentity,
      sourceDocumentId: session.request.sourceDocumentId, worker: session.launch, engineIdentity: session.engineIdentity,
      status: outcome.status, exit: { code, signal }, error: outcome.error, stderr: session.stderr,
      acceptedFrames: session.liveFrames.size });
    if (outcome.result) await write('run-result.json', outcome.result);
    await checkDirectory(directory, identity, fs);
  }

  async function finish(session, code = null, signal = null) {
    if (session.finalizing) return;
    session.finalizing = true;
    clearTimeout(session.killTimer);
    await session.output;
    let outcome = closeResult(session, code, signal);
    try {
      await preserveFailure(session, outcome, code, signal);
    } catch (error) {
      const warning = `PES 恢复资料保存失败：${errorDetail(error)}`;
      if (outcome.error) outcome.error = { ...outcome.error, detail: [outcome.error.detail, warning].filter(Boolean).join('\n') };
      if (outcome.result) outcome.result = { ...outcome.result, provenance: { ...outcome.result.provenance, recoveryWarning: warning } };
    }
    try {
      await session.release?.();
    } catch (error) {
      session.failure ??= error;
      outcome = closeResult(session, code, signal);
    } finally {
      sessions.delete(session.key);
      if (session.releaseRecordsRequested) {
        try { await releasePathRecords(session.owner, session.request.runIdentity); }
        catch (error) {
          if (outcome.result) outcome.result = { ...outcome.result,
            provenance: { ...outcome.result.provenance, releaseWarning: errorDetail(error) } };
        }
      }
      send(session, 'terminal', { workerSettled: true, ...outcome });
      // A closing renderer has no live readers. Its recovery manifest and
      // coordinate files remain for an interrupted save; drop only JS leases.
      if (session.ownerClosed) retained.delete(session.key);
      session.resolveFinished();
    }
  }

  async function observe(session, packet) {
    assert(!session.terminal, 'Worker produced PES output after terminal');
    const value = validateEvent(packet, session.request, session.nextWorkerEvent++);
    if (value.event === 'terminal') {
      const finalFrames = new Map(value.result?.frames.map(frame => [frame.id, frame]));
      for (const [id, frame] of session.liveFrames) {
        assert(isDeepStrictEqual(frame, finalFrames.get(id)), 'PES terminal changed or omitted an accepted live frame');
      }
      const finalRecords = new Map(value.result?.pathRecords?.map(record => [record.id, record]));
      assert(finalRecords.size === session.pathRecords.size, 'PES terminal contains an unavailable path asset');
      for (const [id, record] of session.pathRecords) {
        const final = finalRecords.get(id);
        assert(isDeepStrictEqual(record, final) || final?.kind === 'final'
          && isDeepStrictEqual({ ...record, kind: 'final' }, final), 'PES terminal changed or omitted a path record');
      }
      for (const point of session.scanPoints.values()) assert(isDeepStrictEqual(point,
        value.result?.scanPoints?.find(item => item.pointIndex === point.pointIndex)), 'PES terminal changed a scan point');
      if (session.assets) {
        await checkDirectory(session.assets.directory, session.assets.identity, fs);
        await fs.writeFile(path.join(session.assets.directory, 'recovery.json.tmp'), JSON.stringify({ schema: SCHEMA,
          request: session.request, records: [...session.assets.files.values()], result: value.result,
          status: value.status, error: value.error }) + '\n', { flag: 'wx' });
        await fs.rename(path.join(session.assets.directory, 'recovery.json.tmp'), path.join(session.assets.directory, 'recovery.json'));
      }
      session.terminal = value;
    } else if (value.event === 'path-record') {
      await recordAsset(session, value);
    } else if (value.event === 'scan-point') {
      assert(!session.scanPoints.has(value.point.pointIndex), 'Duplicate live PES scan point');
      session.scanPoints.set(value.point.pointIndex, value.point);
      send(session, 'scan-point', { point: value.point });
    } else if (value.event === 'frame') {
      assert(!session.liveFrames.has(value.frame.id), 'Duplicate live PES frame');
      session.liveFrames.set(value.frame.id, value.frame);
      const frame = value.frame, runId = session.request.runIdentity.runId;
      registerDisplayFrames(session, [frame], [`${runId}:${frame.seriesId}`,
        ...(frame.seriesId === 'path-iterations' ? [`${runId}:${frame.seriesId}:${frame.phase}:${frame.step}`] : []),
        ...(session.request.operation === 'scan' ? [`${runId}:scan-other:${frame.id}`] : [])]);
      send(session, 'frame', { frame: value.frame });
    } else if (!session.stopSent) {
      const { schema, runIdentity, seq, event, ...data } = value;
      send(session, 'progress', data);
    }
  }

  async function start(owner, raw, beforeStart = () => {}) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner), 'PES owner is unavailable');
    const request = validateStart(raw), key = sessionKey(owner, request.runIdentity);
    assert(!sessions.has(key) && !retained.has(key), 'PES run identity is already active or owned');
    const session = { owner, key, request, abort: new AbortController(), nextWorkerEvent: 0, nextEvent: 0,
      liveFrames: new Map(), pathRecords: new Map(), scanPoints: new Map(), displayFrames: new Map(), output: Promise.resolve(), stderr: '' };
    session.displayFrames.set(request.sourceDocumentId, new Set([displayGeometryFingerprint({ ...request.structure,
      charge: request.charge, multiplicity: request.uhf + 1 })]));
    session.finished = new Promise(resolve => { session.resolveFinished = resolve; });
    sessions.set(key, session);
    const { signal } = session.abort;
    try {
      const resources = resolveResources ? await abortable(resolveResources(owner, structuredClone(request)), signal) : undefined;
      if (signal.aborted) throw new Error('PES start stopped');
      beforeStart();
      // Await shared admission itself. Even a provider that returns a late
      // grant after abort must release it before settle/stop resolves.
      const release = await admit(owner, structuredClone(request), { signal, resources });
      assert(typeof release === 'function', 'Missing PES shared resource release');
      session.release = release;
      const actual = release.resources;
      assert(Number.isSafeInteger(actual?.threads) && actual.threads > 0
        && Number.isSafeInteger(actual.memoryBudgetBytes) && actual.memoryBudgetBytes > 0, 'Missing PES shared resource grant');
      request.threads = actual.threads;
      request.memoryBudgetBytes = actual.memoryBudgetBytes;
      if (signal.aborted) throw new Error('PES start stopped');
      const [worker, xtbRuntime] = await abortable(Promise.all([resolveRuntime(request), resolveXtbRuntime(request)]), signal);
      assert(worker && path.isAbsolute(worker.executable) && path.isAbsolute(worker.cwd)
        && Array.isArray(worker.args) && worker.args.every(arg => typeof arg === 'string') && worker.args.includes('--pes-worker'), 'Trusted PES worker runtime required');
      assert(xtbRuntime && ['executable', 'directory', 'dataDirectory'].every(key => path.isAbsolute(xtbRuntime[key])), 'Trusted PES xTB runtime required');
      const resident = requiresResidentLibrary(request);
      if (resident) assert(typeof worker.libxtbRoot === 'string' && path.isAbsolute(worker.libxtbRoot),
        `PES v222 常驻 xTB 运行库不可用。${worker.libxtbError ? ` ${worker.libxtbError}` : ''}`);
      // Renderer data never supplies a runtime path. Legacy requests retain
      // their native CLI runtime even when resident libraries are unavailable.
      const runtime = { ...xtbRuntime, ...(resident ? { libxtbRoot: worker.libxtbRoot,
        libxtbManifestSha256: worker.libxtbManifestSha256 } : {}) };
      const owned = await workspace();
      session.workspace = owned;
      session.launch = { executable: worker.executable, args: worker.args,
        ...(resident ? { libxtbRoot: worker.libxtbRoot } : {}) };
      session.engineIdentity = runtime.engineIdentity;
      await checkDirectory(owned.directory, owned.identity, fs);
      const input = JSON.stringify({ request, runtime, workspace: owned.directory }) + '\n';
      beforeStart();
      if (signal.aborted) throw new Error('PES start stopped');
      const child = session.child = spawn(worker.executable, worker.args, {
        cwd: owned.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...pythonEnvironment(worker.executable), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: String(request.threads),
          OMP_MAX_ACTIVE_LEVELS: '1', OMP_DYNAMIC: 'FALSE', OPENBLAS_NUM_THREADS: String(request.threads), MKL_NUM_THREADS: String(request.threads),
          MPLCONFIGDIR: path.join(owned.directory, 'mpl-cache'), NUMBA_CACHE_DIR: path.join(owned.directory, 'numba-cache') },
      });
      session.reader = ndjson(packet => {
        session.output = session.output.then(() => { if (!session.failure) return observe(session, packet); })
          .catch(error => rejectOutput(session, error));
      });
      child.stdout.on('data', chunk => {
        if (session.failure || session.finalizing) return;
        try { session.reader.write(chunk); } catch (error) { rejectOutput(session, error); }
      });
      child.stderr.on('data', chunk => {
        // Full library output is kept by the worker in its job log. Retain
        // an excerpt of bootstrap errors without using it as a run limit.
        session.stderr = (session.stderr + chunk.toString()).slice(-8192);
      });
      child.stdin.on('error', error => { if (!session.userStop && !session.terminal) rejectOutput(session, error); });
      child.once('error', error => rejectOutput(session, error));
      child.once('close', (code, signal) => { void finish(session, code, signal); });
      child.stdin.write(input);
      send(session, 'started');
    } catch (error) {
      if (!session.userStop) session.failure ??= error;
      if (session.child) requestStop(session);
      else await finish(session);
    }
  }

  function stop(owner, identity) {
    const session = sessions.get(sessionKey(owner, validateIdentity(identity)));
    assert(session, 'PES run is not owned or active');
    session.userStop = true;
    requestStop(session);
    return session.finished;
  }

  function closeOwner(owner) {
    closedOwners.add(owner);
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
    for (const session of sessions.values()) closeOwner(session.owner);
  }

  async function settle(owner) {
    await Promise.all([...sessions.values()].filter(session => owner === undefined || session.owner === owner)
      .map(session => session.finished));
  }

  return { start, stop, closeOwner, dispose, settle, readPathRecord, releasePathRecords, authorizeEmpiricalDisplay, activeCount: () => sessions.size };
}

module.exports = { createPesHost };
