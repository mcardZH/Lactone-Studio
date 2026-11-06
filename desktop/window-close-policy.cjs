'use strict';
const { randomUUID } = require('node:crypto');
const { assert, plain } = require('./security.cjs');
const PREPARATION_CHANNEL = 'sciyue:application-close-preparation';
const alive = window => window && !window.isDestroyed() && !window.webContents.isDestroyed();
function dirtyDocuments(documents) {
  return documents.filter(row => row.snapshot?.document?.draft?.dirty || row.snapshot?.metadata?.inputDirty?.gaussian || row.snapshot?.metadata?.inputDirty?.orca)
    .map(row => ({ documentId: row.documentId, documentEpoch: row.snapshot?.documentEpoch, label: row.snapshot?.metadata?.label || '未命名模型' }));
}
function createWindowClosePolicy({ windows, readDocuments, hasOwnedDocuments, isApplicationWindow = () => false, hasRunningTasks = () => false, isRetainedOwner = () => false, canDestroyWindows = () => true, isQuitting, quit, confirmDiscard, retainOwner, settleWindowWrites = () => Promise.resolve(), prepareApplicationExit = async () => true, cancelApplicationExit = async () => {}, reportError = () => {}, confirmForceExit = async () => false, forceQuit = async () => {}, reportStage = () => {}, preparationTimeoutMs = 10000, shutdownWarningMs = 6000 }) {
  assert(windows && ['entries', 'values', 'keys', 'get'].every(method => typeof windows[method] === 'function') && Number.isInteger(preparationTimeoutMs) && preparationTimeoutMs > 0 && preparationTimeoutMs <= 30000, 'Invalid owned window close policy');
  const pendingPreparations = new Map(), pendingCloses = new Map(), approvedCloses = new Set(), failedRenderers = new Map(); let queue = Promise.resolve(), quitApproved = false, quitPending = false, forceApproved = false, emergencyPending = null, shutdownTimer = null, shutdownPhase = 'cleanup';
  const phase = (name, details = {}) => { try { reportStage(name, details); } catch {} };
  const nativeWindow = preferred => preferred && !preferred.isDestroyed() ? preferred : [...windows.values()].find(value => !value.isDestroyed());
  async function requestEmergencyExit(window, reason = 'close-waiting') {
    if (forceApproved || canDestroyWindows() && isQuitting()) return;
    if (emergencyPending) return emergencyPending;
    const target = nativeWindow(window);
    emergencyPending = (async () => {
      const details = { owner: target?.webContents.id, reason, phase: isQuitting() ? shutdownPhase : reason };
      phase('force-choice', details);
      if (!await confirmForceExit(target, details) || forceApproved || canDestroyWindows() && isQuitting()) { phase('force-choice-cancelled', details); return; }
      forceApproved = true; quitApproved = true; clearTimeout(shutdownTimer);
      for (const [requestId, pending] of pendingPreparations) { clearTimeout(pending.timer); pendingPreparations.delete(requestId); pending.reject(new Error('强制退出已确认；旧关闭握手失效。')); }
      phase('force-approved', details);
      await forceQuit(details);
    })().catch(error => report(target, error)).finally(() => { emergencyPending = null; });
    return emergencyPending;
  }
  const stopped = () => forceApproved || isQuitting();
  function beginShutdown() {
    clearTimeout(shutdownTimer); shutdownPhase = 'cleanup'; phase('cleanup-start');
    shutdownTimer = setTimeout(() => { shutdownTimer = null; void requestEmergencyExit(undefined, 'cleanup-timeout'); }, shutdownWarningMs);
  }
  // A registered work view remains logically open before show, while minimized,
  // or when hidden by its host. Only an explicitly retained authority is excluded.
  const workingView = window => alive(window) && !isRetainedOwner(window.webContents.id);
  const otherAccessible = id => [...windows.entries()].filter(([other, window]) => other !== id && workingView(window));
  const ownedDocuments = ids => ids.flatMap(id => readDocuments(id).filter(row => row.isOwner));
  const exitWorkspaceIdentity = () => JSON.stringify([...windows.keys()].filter(owner=>alive(windows.get(owner))&&hasOwnedDocuments(owner)).map(owner=>[owner,ownedDocuments([owner]).map(row=>[row.documentId,row.snapshot?.documentEpoch,row.snapshot?.publicationSerial,row.snapshot?.document?.revision,row.snapshot?.metadata?.sourceEpoch])]));
  const protectedDocuments = (ids, exitingApp) => {
    const rows = ownedDocuments(ids), dirty = dirtyDocuments(rows);
    if (!exitingApp) return dirty;
    for (const row of rows) if (['starting', 'running', 'pausing', 'paused', 'stopping'].includes(row.snapshot?.runtime?.phase)) {
      const prior = dirty.find(value => value.documentId === row.documentId && value.documentEpoch === row.snapshot.documentEpoch);
      if (prior) prior.running = true;
      else dirty.push({ documentId: row.documentId, documentEpoch: row.snapshot.documentEpoch, label: row.snapshot?.metadata?.label || '未命名模型', running: true });
    }
    return dirty;
  };
  const report = (window, error) => { if (alive(window)) { try { reportError(window, error); } catch { /* A diagnostic dialog cannot turn a cancelled close into a quit. */ } } };
  function prepare(owner) {
    const window = windows.get(owner); assert(alive(window), 'Workspace owner is unavailable for close preparation');
    if(isRetainedOwner(owner))window.show?.();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingPreparations.delete(requestId); const error = new Error('关闭准备未完成；可取消退出或通过原生窗口强制退出本实例。'); error.closeReason = 'preparation-timeout'; reject(error); }, preparationTimeoutMs);
      pendingPreparations.set(requestId, { owner, resolve, reject, timer });
      phase('preparation-requested', { owner, requestId });
      try { window.webContents.send(PREPARATION_CHANNEL, { requestId }); }
      catch (error) { clearTimeout(timer); pendingPreparations.delete(requestId); reject(error); }
    });
  }
  function completePreparation(owner, response) {
    assert(plain(response) && Object.keys(response).every(key => ['requestId', 'status', 'error', 'projectHandled'].includes(key)) && typeof response.requestId === 'string' && /^[a-f0-9-]{36}$/.test(response.requestId) && ['waiting', 'ready', 'cancelled', 'failed'].includes(response.status) && (response.error === undefined || typeof response.error === 'string' && response.error.length <= 2048) && (response.projectHandled === undefined || response.status === 'ready' && typeof response.projectHandled === 'boolean'), 'Invalid close preparation response');
    const pending = pendingPreparations.get(response.requestId);
    if (!pending) return { accepted: false };
    assert(pending.owner === owner, 'Close preparation response belongs to another window');
    // The short timeout protects the renderer handshake. Once the owner has
    // explicitly taken over a project choice/save, actual user/IO completion
    // owns the lifetime; neither silence nor elapsed time authorizes closing.
    phase('preparation-' + response.status, { owner, requestId: response.requestId, error: response.error });
    if (response.status === 'waiting') { clearTimeout(pending.timer); pending.timer = null; return { accepted: true }; }
    clearTimeout(pending.timer); pendingPreparations.delete(response.requestId);
    if (response.status === 'ready') pending.resolve({ projectHandled: response.projectHandled === true });
    else pending.reject(new Error(response.status === 'cancelled' ? '窗口取消了关闭。' : response.error || '关闭准备失败；未退出。'));
    return { accepted: true };
  }
  async function close(window, forceQuit = false) {
    const id = window.webContents.id;
    if (!alive(window) || stopped()) return;
    if (failedRenderers.has(id)) { await requestEmergencyExit(window, failedRenderers.get(id)); return; }
    const others = otherAccessible(id);
    // Retain a canonical owner only when an open shared view still uses it.
    const shared = others.some(([other]) => readDocuments(other).some(row => Number(row.ownerWindowId) === id && !row.isOwner));
    if (!forceQuit && shared && hasOwnedDocuments(id)) { retainOwner(window); return; }
    let exitingApp = forceQuit || others.length === 0;
    let owners = exitingApp ? [...windows.keys()].filter(owner => alive(windows.get(owner)) && hasOwnedDocuments(owner)) : hasOwnedDocuments(id) ? [id] : [];
    const projectHandledOwners = new Set();
    const prepareOwners = ids => Promise.all(ids.map(async owner => { const response = await prepare(owner); if (response.projectHandled) projectHandledOwners.add(owner); }));
    await prepareOwners(owners);
    if (emergencyPending) await emergencyPending;
    if (!alive(window) || stopped()) return;
    // An unrelated window can disappear during preparation. Then this close
    // becomes application exit and must also flush any hidden authority owners.
    if (!exitingApp && otherAccessible(id).length === 0) {
      exitingApp = true;
      const allOwners = [...windows.keys()].filter(owner => alive(windows.get(owner)) && hasOwnedDocuments(owner));
      await prepareOwners(allOwners.filter(owner => !owners.includes(owner))); owners = allOwners;
    }
    const dirty = protectedDocuments(owners, exitingApp), runningTasks = exitingApp && (hasRunningTasks() || dirty.some(row => row.running));
    const projectHandled = owners.length > 0 && owners.every(owner => projectHandledOwners.has(owner));
    if ((dirty.length || runningTasks) && !projectHandled && !await confirmDiscard(window, dirty, exitingApp, { runningTasks })) return;
    if (emergencyPending) await emergencyPending;
    if (!alive(window) || stopped()) return;
    if (exitingApp) {
      const currentOwners = [...windows.keys()].filter(owner => alive(windows.get(owner)) && hasOwnedDocuments(owner));
      assert(currentOwners.every(owner => owners.includes(owner)), '确认期间出现新的工作窗；关闭已取消。');
      // A new open view changes a window-X back into a local view close.
      // An explicit application Quit keeps its application-wide meaning.
      if (!forceQuit && otherAccessible(id).length > 0) exitingApp = false;
    }
    // New dirty documents created in another window while the dialog is open
    // need their own confirmation. Never discard unseen documents.
    const currentDirty = protectedDocuments(owners, exitingApp);
    assert(currentDirty.every(row => dirty.some(prior => prior.documentId === row.documentId && prior.documentEpoch === row.documentEpoch)), '确认期间出现新的未保存文档；关闭已取消。');
    assert(!exitingApp || !hasRunningTasks() || runningTasks, '确认期间启动了新的运行任务；退出已取消，请重新确认。');
    if (exitingApp) {
      const identity=exitWorkspaceIdentity();
      try{
        if (!await prepareApplicationExit(window)) {await cancelApplicationExit();return;}
        if (!alive(window) || stopped()) return;
        assert(exitWorkspaceIdentity()===identity,'等待外部任务收尾期间工作区已变化，退出已取消，请重新保存或确认。');
        assert(!hasRunningTasks()||runningTasks,'确认期间启动了新的运行任务；退出已取消，请重新确认。');
        quitApproved = true; quit();
      }catch(error){if(!stopped())await cancelApplicationExit();throw error;}
    }
    else {
      const timer = setTimeout(() => { void requestEmergencyExit(window, 'window-storage-timeout'); }, shutdownWarningMs);
      try { await settleWindowWrites(id); } finally { clearTimeout(timer); }
      if (!alive(window) || stopped()) return;
      const sharedNow = otherAccessible(id).some(([other]) => readDocuments(other).some(row => Number(row.ownerWindowId) === id && !row.isOwner));
      if (sharedNow && hasOwnedDocuments(id)) { retainOwner(window); return; }
      approvedCloses.add(id); window.close();
    }
  }
  function onClose(window, event) {
    const id = window.webContents.id;
    if (isQuitting()) { if (!canDestroyWindows()) { event.preventDefault(); void requestEmergencyExit(window, 'cleanup-waiting'); } return; }
    if (approvedCloses.has(id)) return;
    event.preventDefault();
    if (pendingCloses.size || quitPending || failedRenderers.has(id)) { void requestEmergencyExit(window, failedRenderers.get(id) || 'close-waiting'); return; }
    const operation = queue.then(() => close(window, isApplicationWindow(id))).catch(async error => { if (forceApproved) return; if (error.closeReason || failedRenderers.has(id)) await requestEmergencyExit(window, error.closeReason || failedRenderers.get(id)); else report(window, error); });
    pendingCloses.set(id, operation); queue = operation;
    void operation.finally(() => pendingCloses.delete(id));
  }
  function disposeWindow(owner) {
    approvedCloses.delete(owner);
    for (const [requestId, pending] of pendingPreparations) if (pending.owner === owner) {
      clearTimeout(pending.timer); pendingPreparations.delete(requestId); pending.reject(new Error('关闭准备窗口已关闭；本次退出已取消。'));
    }
  }
  function requestQuit() {
    if (forceApproved) return;
    if (quitPending || isQuitting() || pendingCloses.size) { void requestEmergencyExit(undefined, isQuitting() ? 'cleanup-waiting' : 'close-waiting'); return; }
    quitPending = true;
    const operation = queue.then(async () => {
      const window = [...windows.values()].find(workingView) || [...windows.values()].find(alive);
      if (window) await close(window, true);
      else if (await prepareApplicationExit(undefined)) { quitApproved = true; quit(); } else await cancelApplicationExit();
    }).catch(async error => { if (forceApproved) return; if (error.closeReason) await requestEmergencyExit(undefined, error.closeReason); else report([...windows.values()].find(alive), error); })
      .finally(() => { quitPending = false; });
    queue = operation;
  }
  function rendererUnavailable(owner, reason = 'renderer-unavailable') {
    failedRenderers.set(owner, reason); phase(reason, { owner });
    if (pendingCloses.has(owner) || quitPending) void requestEmergencyExit(windows.get(owner), reason);
  }
  return { onClose, completePreparation, disposeWindow, requestQuit, requestEmergencyExit, rendererUnavailable,
    rendererResponsive(owner) { failedRenderers.delete(owner); phase('renderer-responsive', { owner }); },
    beginShutdown, shutdownPhase(value) { shutdownPhase = value; phase(value); clearTimeout(shutdownTimer); if (!forceApproved) shutdownTimer = setTimeout(() => { shutdownTimer = null; void requestEmergencyExit(undefined, 'cleanup-timeout'); }, shutdownWarningMs); }, finishShutdown() { clearTimeout(shutdownTimer); },
    isRendererUnavailable: owner => failedRenderers.has(owner),
    isForceApproved: () => forceApproved, isQuitApproved: () => quitApproved, settle: () => queue };
}
module.exports = { createWindowClosePolicy, dirtyDocuments, PREPARATION_CHANNEL };
