'use strict';
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const { assert } = require('./security.cjs');
const { MAX_EVENT_BYTES, TERMINAL_EVENTS, graph, sessionIdentity, validateStart, validateCommand, validateEvent } = require('./dynamics-security.cjs');

/** Owner is a trusted webContents ID, never supplied by renderer payloads. */
function createDynamicsHost({ spawn, sendToWindow, resolveRuntime, resolveXtbRuntime, jobRoot, resolveResources, admit, now = Date.now, setInterval: every = setInterval, clearInterval: clearEvery = clearInterval, setTimeout: later = setTimeout, clearTimeout: clearLater = clearTimeout, limits = {} }) {
  const policy = { stopMs: 2000, tickMs: 250, frameMs: 33, displayFrames:24, displayBytes:2*1024*1024, ...limits };
  assert(Number.isSafeInteger(policy.displayFrames)&&policy.displayFrames>0&&Number.isSafeInteger(policy.displayBytes)&&policy.displayBytes>0,'Invalid dynamics display queue limits');
  const sessions = new Map();
  // A terminal session releases its window immediately, but its exact child
  // remains owned until close or the bounded kill fallback completes.
  const workers = new Set();
  // finish() is a logical retirement (including kill-request fallback), not
  // proof that the OS child closed. Only the child's actual close removes it.
  const ownedChildren = new Set(), pendingStarts = new Map(), closedOwners = new Set();
  let disposed = false;
  const keyFor = (owner, sessionId) => `${owner}:${sessionIdentity(sessionId)}`;
  function emit(session, event) {
    if (!session.ownerClosed) {
      try { sendToWindow(session.owner, {...event,...(session.effectiveResources?{effectiveResources:session.effectiveResources}:{})}); }
      catch { session.ownerClosed = true; discardFrame(session); stop(session); }
    }
  }
  function discardFrame(session) {
    clearLater(session.frameTimer);
    session.frameTimer = undefined;
    session.pendingFrame = undefined;
    session.pendingDisplayFrames = [];
    session.pendingDisplayBytes = 0;
  }
  function flushFrame(session) {
    const frame = session.pendingFrame;
    const displayFrames = (session.pendingDisplayFrames ?? []).map(entry=>entry.frame);
    discardFrame(session);
    if (!frame || session.done || session.ownerClosed) return;
    session.lastFrameAt = now();
    emit(session, frame.operation==='md'?{...frame,displayFrames}:frame);
  }
  function queueFrame(session, frame) {
    if (session.ownerClosed) return;
    // One scientific latest slot; an independent bounded batch preserves real
    // presentation samples that would otherwise vanish during native bursts.
    session.pendingFrame = frame;
    if(frame.operation==='md'){
      const bytes=Buffer.byteLength(JSON.stringify(frame),'utf8');
      session.pendingDisplayFrames ??=[];session.pendingDisplayBytes ??=0;
      if(bytes<=policy.displayBytes){
        while(session.pendingDisplayFrames.length&&(session.pendingDisplayFrames.length>=policy.displayFrames||session.pendingDisplayBytes+bytes>policy.displayBytes)){session.pendingDisplayBytes-=session.pendingDisplayFrames.shift().bytes;}
        session.pendingDisplayFrames.push({frame,bytes});session.pendingDisplayBytes+=bytes;
      }
    }
    const remaining = policy.frameMs - (now() - session.lastFrameAt);
    if (remaining <= 0) flushFrame(session);
    else if (session.frameTimer === undefined) {
      session.frameTimer = later(() => flushFrame(session), remaining);
      session.frameTimer.unref?.();
    }
  }
  function accrue(session, timestamp) {
    if (session.state === 'running') session.runningMs += Math.max(0, timestamp - session.previousTick);
    session.previousTick = timestamp;
  }
  function releaseOwnership(session) {
    clearEvery(session.timer);
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }
  function finish(session) {
    if (session.done) return;
    session.done = true;
    releaseOwnership(session);
    clearLater(session.killTimer);
    discardFrame(session);
    workers.delete(session);
  }
  function fail(session, code, message) {
    if (session.done || session.failing) return;
    session.failing = true;
    flushFrame(session);
    releaseOwnership(session);
    stop(session);
    emit(session, { schema: 1, sessionId: session.sessionId, event: 'error', seq: session.lastSeq + 1, stamp: session.request.stamp, operation: session.request.operation, step: session.lastStep, timeFs: session.lastTimeFs, error: { code, message } });
  }
  function write(session, command) {
    assert(!session.done, 'Dynamics session already ended');
    session.child.stdin.write(`${JSON.stringify({ schema: 1, sessionId: session.sessionId, ...command })}\n`);
  }
  function stop(session) {
    if (session.done || session.stopping) return;
    session.stopping = true;
    try { write(session, { command: 'stop' }); } catch { /* Child may already have closed stdin. */ }
    session.killTimer = later(() => {
      // Only the exact owned ChildProcess is killed, never a PID tree or shell.
      if (!session.closed) session.child.kill();
      finish(session);
    }, policy.stopMs);
    session.killTimer.unref?.();
  }
  function onEvent(session, raw) {
    if (session.done || session.failing) return;
    const value = validateEvent(raw, session);
    assert(value.event !== 'ready' || !session.ready, 'Duplicate dynamics ready event');
    assert(session.ready || value.event === 'ready' || value.event === 'error', 'Dynamics event before ready');
    const timestamp = now();
    accrue(session, timestamp);
    if (value.event === 'ready') session.ready = true;
    if (value.step > session.lastStep) session.progressAt = timestamp;
    session.lastSeq = value.seq;
    session.lastStep = value.step ?? session.lastStep;
    session.lastTimeFs = value.timeFs ?? session.lastTimeFs;
    session.heartbeatAt = timestamp;
    if (value.event === 'paused') { session.pausedAt = timestamp; session.state = 'paused'; }
    else if (value.event === 'resumed' || value.event === 'started') { session.state = 'running'; session.progressAt = timestamp; }
    if (value.event === 'frame') queueFrame(session, value);
    else {
      // Status/control acknowledgements and terminal snapshots follow the
      // newest candidate, preserving increasing sequence and pause snapshots.
      flushFrame(session);
      if (TERMINAL_EVENTS.has(value.event)) {
        session.terminal = true;
        session.failing = true; // Disallow every late event from this child.
        releaseOwnership(session);
        stop(session); // Retain owned shutdown before the UI starts anew.
      }
      emit(session, value);
    }
  }
  function startNow(owner, rawRequest, sessionId, releaseAdmission, validated=false, resolvedXtb) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0, 'Invalid dynamics owner');
    assert(!pendingStarts.has(owner), 'Dynamics start already waiting for owned child close');
    const key = keyFor(owner, sessionId);
    assert(!sessions.has(key), 'Duplicate dynamics session identity');
    assert(![...sessions.values()].some(session => session.owner === owner), 'Only one dynamics session per window');
    assert((policy.maxSessions === undefined || workers.size < policy.maxSessions), 'Dynamics concurrency limit reached');
    const request = validated?rawRequest:validateStart(rawRequest);
    const runtime = resolveRuntime(); // Trusted host-only resolver, no renderer paths.
    let nativeContext;
    if(request.method){assert(resolvedXtb&&path.isAbsolute(jobRoot),'Native MD requires trusted xTB/runtime workspace');fs.mkdirSync(jobRoot,{recursive:true});nativeContext={runtime:resolvedXtb,workspacePath:fs.mkdtempSync(path.join(jobRoot,'md-')),threads:releaseAdmission?.resources?.threads??1,memoryBudgetBytes:releaseAdmission?.resources?.memoryBudgetBytes};}
    const child = spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } });
    const timestamp = now();
    const session = { key, owner, sessionId, request, child, releaseAdmission, effectiveResources:releaseAdmission?.resources?structuredClone(releaseAdmission.resources):undefined, graph: graph(request.structure), movable: new Set(request.movableAtomIds), lastSeq: -1, lastStep: 0, lastTimeFs: 0, state: 'starting', ready: false, createdAt: timestamp, heartbeatAt: timestamp, progressAt: timestamp, previousTick: timestamp, runningMs: 0, lastFrameAt: -Infinity, pendingFrame: undefined, frameTimer: undefined, done: false, buffer: '', stderr: '', decoder: new StringDecoder('utf8') };
    sessions.set(key, session);
    workers.add(session);
    ownedChildren.add(session);
    session.closeTask = new Promise((resolve,reject) => { session.resolveClosed = resolve;session.rejectClosed=reject; });void session.closeTask.catch(()=>{});
    session.timer = every(() => {
      const current = now();
      accrue(session, current);
      if (session.stopping || session.done) return;
      if (policy.readyMs !== undefined && !session.ready && current - session.createdAt > policy.readyMs) fail(session, 'DYNAMICS_READY_TIMEOUT', '原生动力学引擎未在启动期限内就绪');
      else if (policy.readyMs !== undefined && session.state === 'starting' && current - session.createdAt > policy.readyMs) fail(session, 'DYNAMICS_START_TIMEOUT', '原生动力学引擎未在启动期限内完成初始化');
      else if (policy.heartbeatMs !== undefined && session.ready && current - session.heartbeatAt > policy.heartbeatMs) fail(session, 'DYNAMICS_HEARTBEAT_TIMEOUT', '原生动力学引擎心跳中断');
      else if (policy.pausedMs !== undefined && session.state === 'paused' && current - session.pausedAt > policy.pausedMs) fail(session, 'DYNAMICS_PAUSE_TIMEOUT', '动力学暂停超过会话保留期限');
      else if (request.maxWallTimeSeconds !== undefined && session.state === 'running' && session.runningMs > request.maxWallTimeSeconds * 1000) fail(session, 'DYNAMICS_WALL_TIMEOUT', '动力学超过累计运行时间上限');
      else if (policy.progressMs !== undefined && session.state === 'running' && current - session.progressAt > policy.progressMs) fail(session, 'DYNAMICS_PROGRESS_TIMEOUT', '原生动力学有心跳但长时间无步数进展');
    }, policy.tickMs);
    session.timer.unref?.();
    child.stdout.on('data', chunk => {
      if (session.done || session.failing) return;
      try {
        session.buffer += session.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let newline;
        while ((newline = session.buffer.indexOf('\n')) >= 0) {
          const line = session.buffer.slice(0, newline).replace(/\r$/, '');
          session.buffer = session.buffer.slice(newline + 1);
          assert(line.length > 0, 'Empty dynamics protocol line');
          onEvent(session, JSON.parse(line));
          if (session.failing) { session.buffer = ''; return; }
        }
      } catch (error) { fail(session, 'DYNAMICS_PROTOCOL_ERROR', error.message); }
    });
    child.stderr.on('data', chunk => { session.stderr = Buffer.concat([Buffer.from(session.stderr), Buffer.from(chunk)]).subarray(-8192).toString('utf8'); });
    child.stdin.on('error', error => fail(session, 'DYNAMICS_INPUT_FAILED', error.message));
    child.on('error', error => fail(session, 'DYNAMICS_SPAWN_FAILED', error.message));
    child.on('close', code => {
      if(session.closed)return;
      session.closed = true;
      if (!session.done && !session.terminal && !session.failing && !session.ownerClosed) {
        const message = session.buffer ? '原生动力学协议末行被截断' : `原生动力学引擎未返回终态（exit ${code}）${session.stderr ? `: ${session.stderr}` : ''}`;
        fail(session, 'DYNAMICS_UNEXPECTED_EXIT', message);
      }
      finish(session);
      if(!session.releaseAdmission){ownedChildren.delete(session);session.resolveClosed();}
      else void Promise.resolve().then(()=>session.releaseAdmission()).then(()=>{ownedChildren.delete(session);session.resolveClosed();},error=>session.rejectClosed(error));
    });
    try { write(session, { command: 'start', request, ...(nativeContext?{nativeContext}:{}) }); }
    catch (error) { fail(session, 'DYNAMICS_INPUT_FAILED', error.message); }
    return { sessionId, status: 'starting' };
  }
  function start(owner,rawRequest,sessionId){return resolveResources||admit||rawRequest?.method?startWhenPreviousClosed(owner,rawRequest,sessionId):startNow(owner,rawRequest,sessionId);}
  async function startWhenPreviousClosed(owner, rawRequest, sessionId, beforeStart = () => {}) {
    assert(!disposed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner), 'Dynamics owner already closed or disposed');
    keyFor(owner, sessionId);
    assert(typeof beforeStart === 'function', 'Trusted dynamics start guard required');
    assert(!pendingStarts.has(owner), 'Dynamics start already waiting for owned child close');
    assert(![...sessions.values()].some(session => session.owner === owner), 'Only one dynamics session per window');
    const request = validateStart(rawRequest); // Detach identity before any await.
    const previous = [...ownedChildren].filter(session => session.owner === owner);
    assert(previous.every(session => !session.ownerClosed && (session.terminal || session.failing || session.done)), 'Dynamics previous child is not retired');
    if (!previous.length&&!resolveResources&&!admit&&!request.method) { beforeStart(); return startNow(owner, request, sessionId,undefined,true); }
    const pending = {sessionId,abort:new AbortController()};let release;
    pending.cancel=message=>{pending.abort.abort();pending.error=new Error(message);pending.reject?.(pending.error);};
    pendingStarts.set(owner, pending);
    try {
      const snapshot=resolveResources?await new Promise((resolve,reject)=>{pending.reject=reject;Promise.resolve(resolveResources(owner,{...structuredClone(request),method:request.method??request.forcefield??'UFF'})).then(resolve,reject);}):undefined;
      assert(!pending.abort.signal.aborted,'DYNAMICS_CANCELLED: resource capture cancelled');
      if(previous.length)await new Promise((resolve, reject) => {
        pending.reject=reject;
        pending.timer = later(() => pending.cancel('DYNAMICS_PREVIOUS_CLOSE_TIMEOUT: owned native child did not actually close'), policy.stopMs + 250);
        Promise.all(previous.map(session => session.closeTask)).then(() => { clearLater(pending.timer); resolve(); },reject);
      });
      assert(!disposed && !closedOwners.has(owner) && pendingStarts.get(owner) === pending, 'Dynamics owner closed while awaiting native child');
      assert(previous.every(session => session.closed) && ![...ownedChildren].some(session => session.owner === owner), 'Dynamics actual owned child close not confirmed');
      beforeStart(); // Main rechecks maintenance/document/concurrency after wait.
      if(admit){release=await admit(owner,request,{signal:pending.abort.signal,resources:snapshot});assert(typeof release==='function','Dynamics admission must return a trusted release');if(snapshot)assert(release.resources&&Number.isSafeInteger(release.resources.threads)&&release.resources.threads>=1&&(request.method||release.resources.threads===1)&&Number.isSafeInteger(release.resources.memoryBudgetBytes)&&release.resources.memoryBudgetBytes>0,'DYNAMICS_RESOURCE_GRANT: Actual soft grant required');}
      assert(!pending.abort.signal.aborted&&!disposed&&!closedOwners.has(owner),'DYNAMICS_CANCELLED: queued start cancelled');beforeStart();
      const resolvedXtb=request.method?await resolveXtbRuntime():undefined;
      assert(!pending.abort.signal.aborted&&!disposed&&!closedOwners.has(owner),'DYNAMICS_CANCELLED: native runtime resolve cancelled');
      pendingStarts.delete(owner);
      const result=startNow(owner,request,sessionId,release,true,resolvedXtb);release=undefined;return result;
    } finally {
      clearLater(pending.timer);
      if(release)await release();
      if (pendingStarts.get(owner) === pending) pendingStarts.delete(owner);
    }
  }
  function command(owner, sessionId, rawCommand) {
    const pending=pendingStarts.get(owner);if(pending?.sessionId===sessionId){const value=validateCommand(rawCommand);assert(value.command==='stop','Queued dynamics only supports stop');pending.cancel('DYNAMICS_CANCELLED: 用户取消等待中的计算');return{sessionId,status:'stopping'};}
    const session = sessions.get(keyFor(owner, sessionId));
    assert(session && !session.done && !session.failing && !session.stopping, 'Dynamics session not owned or no longer active');
    const value = validateCommand(rawCommand);
    assert(!session.request.untilStopped || value.command === 'stop', 'Continuous MD only accepts Stop');
    assert(value.command !== 'set-temperature' || session.request.operation === 'md', 'Only MD has a physical temperature control');
    if (value.command === 'stop') stop(session);
    else {
      assert(session.ready, 'Dynamics session is not ready');
      if (value.command === 'pause') assert(session.state === 'running', 'Dynamics is not running');
      if (value.command === 'resume' || value.command === 'set-temperature') assert(session.state === 'paused', 'Dynamics must be paused');
      write(session, value);
    }
    return { sessionId, status: value.command === 'stop' ? 'stopping' : 'sent' };
  }
  function closeOwner(owner) { closedOwners.add(owner); pendingStarts.get(owner)?.cancel('DYNAMICS_OWNER_CLOSED: native start cancelled'); for (const session of ownedChildren) if (session.owner === owner) { session.ownerClosed = true; discardFrame(session); stop(session); } }
  function dispose() { disposed = true; for (const pending of pendingStarts.values()) pending.cancel('DYNAMICS_DISPOSED: native start cancelled'); for (const session of ownedChildren) { session.ownerClosed = true; discardFrame(session); stop(session); } }
  return { start, startWhenPreviousClosed, command, closeOwner, dispose, activeCount: () => sessions.size+pendingStarts.size, workerCount: () => workers.size };
}
module.exports = { createDynamicsHost };
