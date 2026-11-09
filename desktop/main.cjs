'use strict';
const { app, BrowserWindow, Menu, MenuItem, ipcMain, protocol, dialog, clipboard, ClipboardItem, session, shell, screen, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const security = require('./security.cjs');
const { chemistryRuntime } = require('./runtime.cjs');
const { createChemistryJob } = require('./chemistry-job.cjs');
const { packagedBackendInfo, currentRuntimeEnvironment } = require('./current-runtime.cjs');
const { createFileReader } = require('./file-read.cjs');
const { createLaunchSources } = require('./launch-sources.cjs');
const { createTaskSystemComposition } = require('./task-system-composition.cjs');
const { launchPaths, createLaunchImportQueue } = require('./launch-import.cjs');
const { resolvePortableLayout } = require('./portable-layout.cjs');
const { pickReferenceFile } = require('./reference-files.cjs');
const { createDynamicsHost } = require('./dynamics-host.cjs');
const { createXtbHost } = require('./xtb-host.cjs');
const { createAdvancedPathHost } = require('./advanced-path-host.cjs');
const { createConformerSamplingHost } = require('./conformer-sampling-host.cjs');
const { createConformerOptimizationBatch } = require('./conformer-optimization-batch.cjs');
const { createConformerBatchAdapter } = require('./conformer-batch-adapter.cjs');
const { createOcrRuntime } = require('./ocr-runtime.cjs');
const { createOcrHost } = require('./ocr-host.cjs');
const { createAissHost } = require('./aiss-host.cjs');
const { createAdvancedOutputStore } = require('./advanced-output.cjs');
const { createBinaryExportStore } = require('./binary-export-store.cjs');
const { createManagedResultTransfers } = require('./managed-result-transfer.cjs');
const { createFrontendWorkAdmission } = require('./frontend-work-admission.cjs');
const { createSyProjectStore } = require('./sy-project-store.cjs');
const { createSyProjectIPC } = require('./sy-project-ipc.cjs');
const { createProjectCompanionSources } = require('./project-companion-sources.cjs');
const { createXtbElectronicArtifacts } = require('./xtb-electronic-artifacts.cjs');
const { readCpuResources, cpuResourceSnapshot, closeCpuResources } = require('./cpu-resources.cjs');
const { createOrbitalHost } = require('./orbital-host.cjs');
const { identity: orbitalSessionIdentity } = require('./orbital-security.cjs');
const { createOrbitalBackendStore } = require('./orbital-runtime.cjs');
const { xtbRuntime } = require('./xtb-runtime.cjs');
const { createWorkbenchPreferencesStore } = require('./preferences.cjs');
const { createModelDisplayPreferencesStore } = require('./model-display-preferences.cjs');
const { createSurfaceDisplayPreferencesStore } = require('./surface-display-preferences.cjs');
const { createRuntimeModelDisplayStore } = require('./runtime-model-display.cjs');
const { createModelHoldKeyPreferencesStore } = require('./model-hold-key-preferences.cjs');
const { createComputeResources, attachComputeResourceGrant } = require('./compute-resources.cjs');
const { createFirstRunLicense } = require('./first-run-license.cjs');
const { createTaskCache, cleanRenderCaches } = require('./task-cache.cjs');
const { createWindowClosePolicy } = require('./window-close-policy.cjs');
const { createModelClipboard } = require('./model-clipboard.cjs');
const { installWorkbenchMenu, refreshWorkbenchMenu, workbenchFileActionRoute, FILE_ACTION_CHANNEL } = require('./workbench-menu.cjs');
const { createForcedShutdown } = require('./forced-shutdown.cjs');
const { createCloseDiagnostics } = require('./close-diagnostics.cjs');
const { prepareVersionProfile } = require('./version-profile.cjs');
const { createPortableProfile } = require('./portable-profile.cjs');
const { createPortableServices, finishPortableRun } = require('./portable-services.cjs');
const { createPortableLog } = require('./portable-log.cjs');
const { classifyStorageError, directoryIdentity, readChecked, currentFile, atomicWrite } = require('./portable-storage.cjs');
const { createPersonalFragmentStore } = require('./personal-fragments.cjs');
const {createCitationExport}=require('./citation-export.cjs');
const { assertExportDestination, assertUnmanagedDestination } = require('./portable-export.cjs');
const { createNativeProcessTracker } = require('./native-process.cjs');
const { createPostExitCleanup } = require('./post-exit-cleanup.cjs');
const { createEmpiricalChemistryHost } = require('./empirical-chemistry-host.cjs');
const { createCrystalModelingHost } = require('./crystal-modeling.cjs');
const { createSurfaceSourceFiles } = require('./surface-source-files.cjs');
const { createMultiwfnScheduler } = require('./multiwfn-scheduler.cjs');
const { checkNativeRuntime } = require('./native-runtime-diagnostics.cjs');
const { createNativeCapabilities } = require('./native-capabilities.cjs');
const { createWorkspaceDocuments } = require('./workspace-documents.cjs');
const { createAnalysisWindowHost } = require('./analysis-window-host.cjs');
const { createMcpLiveHost } = require('./mcp/live-bridge.cjs');
const { assert, plain, string, boundedJSON, within, validateClipboard, validateChemistry, validateSaveRequest, formatForPath, allowedURL, createNavigationGuard } = security;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
const appPath = path.resolve(__dirname, '..');
const appMetadata = require('../package.json'), appVersion = appMetadata.version, appDisplayVersion=appMetadata.displayVersion??appVersion, appVersionLabel=`${appDisplayVersion}${appMetadata.releaseChannel==='development'?' · 开发版 · 仅内测':''}`;
const appBuildRevision = appMetadata.sciyueBuildRevision ?? '';
assert(appBuildRevision === '' || /^r(?:[2-9]|[1-9]\d+)$/.test(appBuildRevision), 'Invalid portable package revision');
const development = !app.isPackaged && process.env.SCIYUE_DESKTOP_DEV === '1';
const isolatedIO = !app.isPackaged && process.env.SCIYUE_TEST_ISOLATED_IO === '1';
let isolatedRoot = null;
let portableProfile = null;
if (isolatedIO) {
  assert(string(process.env.SCIYUE_TEST_DATA_DIR, 4096), 'Isolated I/O requires an explicit project test directory');
  isolatedRoot = path.resolve(process.env.SCIYUE_TEST_DATA_DIR);
  assert(within(appPath, isolatedRoot) && isolatedRoot !== appPath, 'Isolated I/O directory must be inside this candidate');
  fsSync.mkdirSync(isolatedRoot, { recursive: true });
  assert(within(fsSync.realpathSync(appPath), fsSync.realpathSync(isolatedRoot)), 'Isolated I/O directory cannot escape via a link');
  portableProfile = createPortableProfile({ app, executable: process.execPath, root: isolatedRoot, version: appVersion, revision: appBuildRevision });
} else if (app.isPackaged && process.platform === 'win32') {
  try {
    const layout = resolvePortableLayout({ executable: process.execPath, version: appVersion });
    portableProfile = createPortableProfile({ app, executable: process.execPath, version: appVersion, revision: appBuildRevision, root: layout.stateRoot, layout });
  }
  catch (error) { dialog.showErrorBox?.('Ester Studio 便携目录不可用', classifyStorageError(error).message + '\n请将完整程序解压到支持安全保存的可写目录。'); throw error; }
} else {
  const profile = prepareVersionProfile(fsSync, app.getPath('appData'), appVersion + (appBuildRevision ? '-' + appBuildRevision : ''));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
// Electron's single-instance lock is scoped to the version's userData root.
// Another launch uses this version's host, never a second canonical writer.
// A retained hidden workbench is restored before creating a fresh window.
const postExitCleanup = createPostExitCleanup({profile:portableProfile});
const ownsProfile = app.requestSingleInstanceLock();
// Let this launch register its owned cleanup before the duplicate host quits.
if (!ownsProfile) queueMicrotask(() => app.quit());
let pendingModelWindows = 0;
let hostWindowsReady = false;
const pendingFileLaunches = [];
function readLaunchRequest(argv, cwd) {
  try { return { paths: launchPaths(argv, cwd || process.cwd?.() || appPath, app.isPackaged) }; }
  catch (error) { return { paths: [], error: error.message }; }
}
app.on('second-instance', (_event, argv, cwd) => {
  if (!ownsProfile) return;
  const request = readLaunchRequest(argv, cwd);
  if (app.isReady() && hostWindowsReady) {
    const window = restoreHiddenWorkspaceOwner() || createModelWindow();
    if (request.paths.length || request.error) enqueueLaunch(window, request);
  } else if (request.paths.length || request.error) {
    if (pendingFileLaunches.length < 32) pendingFileLaunches.push(request);
    else dialog.showErrorBox?.('启动文件导入失败', '启动导入队列已满，请完成启动后重试。');
  }
  else pendingModelWindows++;
});
const headless = isolatedIO && process.env.SCIYUE_DESKTOP_TEST_HEADLESS === '1';
const workbenchPreferences = createWorkbenchPreferencesStore(app.getPath('userData'));
const modelDisplayPreferences = createModelDisplayPreferencesStore(app.getPath('userData'));
const surfaceDisplayPreferences = createSurfaceDisplayPreferencesStore(app.getPath('userData'));
const modelHoldKeyPreferences = createModelHoldKeyPreferencesStore(app.getPath('userData'));
const computeResources = createComputeResources({profileRoot:app.getPath('userData'),retainedMemoryEstimate:()=>retainedMemoryEstimate()});
const firstRunLicense = createFirstRunLicense({profileRoot:portableProfile?.paths?.data??app.getPath('userData'),licensePath:path.join(portableProfile?.layout?.distributionRoot??appPath,'LICENSE.txt')});
const taskCache = createTaskCache({root:path.join(portableProfile?.paths.cache ?? app.getPath('userData'), 'tasks'),report:entry=>console.info('TASK_CACHE',JSON.stringify(entry))});
const windows = new Map();
const workbenchFileStates = new Map(); let workbenchMenu = null;
const refreshNativeMenu = () => { if (workbenchMenu) refreshWorkbenchMenu(workbenchMenu, BrowserWindow.getFocusedWindow?.()); };
const runtimeModelDisplay = createRuntimeModelDisplayStore({ scopeFor(owner) {
  const member=workspaceDocuments.read(owner).find(row=>!row.isOwner);
  return member?Number(member.ownerWindowId):owner;
}, send(owner, snapshot) {
  const window = ownerWindow(owner);
  assert(allowedURL(window.webContents.mainFrame.url, development), 'Untrusted runtime display recipient');
  window.webContents.send('sciyue:runtime-model-display', snapshot);
} });
// The first full workbench created by this process owns application-X semantics.
// Detached model shells and later independent workbenches are secondary windows.
let primaryWorkbenchWindowId = null;
const detachedWorkspaceWindows = new Map(), approvedShellCloses = new Set(), pendingShellCloses = new Set(), closeConfirmations = new Map();
const hiddenWorkspaceOwners = new Set();
function restoreHiddenWorkspaceOwner() {
  for (const id of hiddenWorkspaceOwners) {
    const owner = windows.get(id);
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) { hiddenWorkspaceOwners.delete(id); continue; }
    hiddenWorkspaceOwners.delete(id);
    if (!headless) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
    owner.webContents.send('sciyue:workspace-document-event',{kind:'owner-view-restored',schema:'sciyue-workspace-document',version:1,ownerWindowId:String(id)});
    return owner;
  }
  return false;
}
let quitting = false, forcingExit = false;
const workspaceDocuments = createWorkspaceDocuments({
  send(owner, event) {
    const window = windows.get(owner);
    assert(window && !window.isDestroyed() && !window.webContents.isDestroyed(), 'Workspace member window is unavailable');
    window.webContents.send('sciyue:workspace-document-event', event);
  },
  onOwnerIdle(owner) {
    windows.get(owner)?.webContents.setBackgroundThrottling(true);
    if (hiddenWorkspaceOwners.has(owner)) {
      hiddenWorkspaceOwners.delete(owner);
      // Let the synchronous close-document IPC receipt leave the renderer
      // before destroying its now-unneeded hidden authority window.
      setTimeout(() => { if (!workspaceDocuments.hasOwnedDocuments(owner)) windows.get(owner)?.close(); }, 0);
    }
  },
});
const tokens = new Map();
const jobs = new Map();
function terminateOwnedChild(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return Promise.resolve(); }
  // The PID comes from a still-owned ChildProcess handle, never renderer input,
  // a process-name search, or another version's host. /T includes its descendants.
  return new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); resolve(); }, 4000);
    killer.once('error', () => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(); });
    killer.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
const forcedShutdown = createForcedShutdown({ terminate: terminateOwnedChild, exit: code => app.exit(code), beforeExit: () => closeDiagnostics.flush(), report: (phase, details) => { void closeDiagnostics.record(phase, details); } });
const nativeProcesses = createNativeProcessTracker({ spawn:(...args)=>forcedShutdown.track(taskCache.track(spawn(...args))), environment: (executable, _args, options) => ({
  ...currentRuntimeEnvironment({ packaged: app.isPackaged, appPath, executable, environment: options?.env ?? process.env }),
  ...(portableProfile?.workerEnv ?? {}),
}) });
const nativeCapabilities = createNativeCapabilities({ spawn: nativeProcesses.spawn });
const multiwfnScheduler = createMultiwfnScheduler();
const preparedMemoryEstimates=new Map();
const retainedMemoryEstimate=()=>{let total=0;for(const bytes of preparedMemoryEstimates.values())total+=bytes;return Math.min(Number.MAX_SAFE_INTEGER,total);};
const { createCandidatePoolAdmission } = require('./candidate-pool-admission.cjs');
// Advanced calculations join the existing shared scientific lease; their
// task controller owns stage order, this host lease owns native admission.
const advancedLeaseActive = () => multiwfnScheduler.status().active?.key.startsWith('advanced:') === true;
function legacyScienceAdmission(request,willAcquire=false) {
  assert(willAcquire || request?.runIdentity || !advancedLeaseActive(), 'NATIVE_BUSY: 高级任务正在使用本机计算资源，请等待任务结束或停止。');
}
async function admitAdvancedScience(owner, request, { signal, resolveResources } = {}) {
  const key = request.runIdentity?`advanced:${request.runIdentity.taskId}:${request.runIdentity.runId}`:`internal:${owner}:${randomUUID()}`;
  const lease = await multiwfnScheduler.acquire({ owner, key, signal });
  try {
    assert(!signal?.aborted && !maintenanceBusy && !quitting, 'NATIVE_CANCELLED: 等待中的高级计算已取消');
    ownerWindow(owner);
    workspaceDocuments.assertRuntimeOwner(owner, request.stamp.documentId);
    assert(nativeProcesses.unleasedCount() === 0 && ![...jobs.values()].some(job => !job.advanced&&!job.resourceManaged), 'NATIVE_BUSY: 已有建模计算或其子进程尚未实际结束，请结束后再启动高级任务。');
    // A queued run has no grant yet. Read the policy only after admission, then
    // recheck ownership/cancellation before publishing its immutable grant.
    const snapshot=await (resolveResources?resolveResources(owner,request):computeResources.resolveForRun(owner,request));
    assert(!signal?.aborted && !maintenanceBusy && !quitting, 'NATIVE_CANCELLED: 等待中的高级计算已取消');
    ownerWindow(owner);workspaceDocuments.assertRuntimeOwner(owner, request.stamp.documentId);
    return attachComputeResourceGrant(() => lease.release(),lease,snapshot,request);
  } catch (error) { lease.release(); throw error; }
}
function localResources(domain,owner,request={}) {
  const cpu=cpuResourceSnapshot(),cores=cpu.physicalCoreCount??cpu.logicalCpuCount;
  if(domain==='forcefield')return computeResources.resolveForRun(owner,{...request,method:request.forcefield??'UFF'},{maxThreads:1,reason:'当前力场实现为单线程'});
  const maxThreads=domain==='aiss'?Math.min(2,cores):cpu.logicalCpuCount;
  return computeResources.resolveForRun(owner,request,{maxThreads,reason:domain==='aiss'?'既有aISS接口上限2线程':'本机可用逻辑处理器'});
}
function assertCandidatePoolCurrent(owner, request) {
  assert(!maintenanceBusy && !quitting, 'NATIVE_CANCELLED: 候选优化已取消');
  ownerWindow(owner); workspaceDocuments.assertRuntimeOwner(owner, request.stamp.documentId);
}
const candidatePoolAdmission = createCandidatePoolAdmission({ scheduler: multiwfnScheduler,
  maxConcurrent: () => cpuResourceSnapshot().logicalCpuCount,
  resolveResources: (owner, request) => computeResources.resolveForRun(owner, request),
  assertCurrent: assertCandidatePoolCurrent,
  assertInitial(owner, request) {
    assertCandidatePoolCurrent(owner, request);
    assert(nativeProcesses.unleasedCount() === 0 && ![...jobs.values()].some(job => !job.advanced && !job.resourceManaged), 'NATIVE_BUSY: 已有非受管计算尚未结束');
  },
});
const localAdmission=domain=>(owner,request,options={})=>request.optimizationPool
  ? candidatePoolAdmission.admit(owner,request,options)
  : admitAdvancedScience(owner,request,{...options,resolveResources:(owner,value)=>localResources(domain,owner,value)});
const ocrRuntime = createOcrRuntime({distributionRoot:portableProfile?.layout?.distributionRoot ?? appPath});
const ocr = createOcrHost({runtime:ocrRuntime,spawn:nativeProcesses.spawn,terminate:terminateOwnedChild,jobRoot:path.join(taskCache.root,'ocr'),
  async admit(owner,request,{signal}={}) {
    const lease=await multiwfnScheduler.acquire({owner,key:`ocr:${owner}:${request.requestId}`,signal});
    try {
      ownerWindow(owner);assert(!signal?.aborted&&!maintenanceBusy&&!quitting,'OCR_CANCELLED: 图片识别已取消。');
      assert(nativeProcesses.unleasedCount()===0&&![...jobs.values()].some(job=>!job.advanced&&!job.resourceManaged),'NATIVE_BUSY: 请等待当前本机计算结束。');
      const resources=await computeResources.resolveForRun(owner,{}, {maxThreads:4,reason:'本地图片识别最多4线程'});
      ownerWindow(owner);assert(!signal?.aborted&&!maintenanceBusy&&!quitting,'OCR_CANCELLED: 图片识别已取消。');
      return attachComputeResourceGrant(()=>lease.release(),lease,resources,{});
    } catch(error) {lease.release();throw error;}
  },
});
const frontendWorkAdmission=createFrontendWorkAdmission({
  assertCurrent(owner,request){ownerWindow(owner);assert(!quitting&&!maintenanceBusy,'NATIVE_CANCELLED: 后台工作已取消');const stamp=request.stamp;assert(plain(stamp)&&string(stamp.documentId)&&Number.isSafeInteger(stamp.revision)&&stamp.revision>=0&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(key=>typeof stamp[key]==='string'),'Invalid worker document stamp');workspaceDocuments.assertRuntimeOwner(owner,stamp.documentId);},
  admit:(owner,request,options)=>admitAdvancedScience(owner,request,options),
});
const empiricalChemistry = createEmpiricalChemistryHost({
  spawn: nativeProcesses.spawnRetainedAnalysis,
  canSpawn: () => !maintenanceBusy && !quitting,
  resolveRuntime: () => chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
});
const crystalModeling = createCrystalModelingHost({
  spawn: nativeProcesses.spawnRetainedAnalysis,
  canSpawn: () => !maintenanceBusy && !quitting,
  resolveRuntime: () => chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
});
let maintenanceBusy = false, fileOperations = 0;
const pendingFileOperations = new Set(), runtimeChecks = new Map();
function exportRoots() { return { root: portableProfile?.layout?.distributionRoot ?? portableProfile?.root ?? appPath, layout: portableProfile?.layout, managedRoots: [app.getPath('userData')], applicationRoots: [path.join(appPath, 'desktop'), path.join(appPath, 'dist')] }; }
const dynamics = createDynamicsHost({
  spawn: nativeProcesses.spawn,
  admit:(owner,request,options)=>localAdmission(request.method?'xtb':'forcefield')(owner,request,options),
  resolveResources:(owner,request)=>localResources(request.method?'xtb':'forcefield',owner,request),
  resolveXtbRuntime:()=>xtbRuntime({packaged:app.isPackaged,resourcesPath:process.resourcesPath,appPath}),
  jobRoot:path.join(taskCache.root,'dynamics'),
  sendToWindow(owner, event) {
    const window = windows.get(owner);
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:dynamics-event', event);
  },
  resolveRuntime() {
    const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath });
    return { ...runtime, args: [...runtime.args, '--dynamics'] };
  },
});
const fileReader = createFileReader();
const launchSources = createLaunchSources();
const launchImports = createLaunchImportQueue({ sources: launchSources, notify(owner) {
  const window = windows.get(owner);
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:launch-import-available');
} });
function enqueueLaunch(window, request) {
  try { const ordinary=[];for(const selected of request.paths){if(['.es','.sy'].includes(path.extname(selected).toLowerCase()))projectIPC.enqueue(window,selected);else ordinary.push(selected);}if(ordinary.length||request.error)launchImports.enqueue(window.webContents.id, ordinary, request.error); }
  catch (error) { if (!headless) dialog.showErrorBox?.('启动文件导入失败', error.message); }
}
const syProjectStore=createSyProjectStore({appVersion:appDisplayVersion});
const projectIPC=createSyProjectIPC({store:syProjectStore,dialog,ownerWindow:window=>window,createWindow:()=>createModelWindow(),appVersion:appDisplayVersion,executablePath:portableProfile?.layout?.distributionRoot?path.join(portableProfile.layout.distributionRoot,path.basename(process.execPath).toLowerCase()==='ester-studio-host.exe'?'Ester-Studio.exe':'SY-Studio.exe'):process.execPath});
const projectCompanionSources=createProjectCompanionSources({root:path.join(portableProfile?.paths.temp??app.getPath('temp'),'project-companions'),openLaunchSources:(owner,paths,options)=>launchSources.open(owner,paths,options),closeLaunchSource:(owner,token)=>launchSources.close(owner,token)});
const xtbElectronicSources = createXtbElectronicArtifacts({ root: path.join(app.getPath('userData'), 'xtb-electronic-sources') });
const xtb = createXtbHost({
  spawn: nativeProcesses.spawn,
  admit: localAdmission('xtb'),
  resolveResources:(owner,request)=>computeResources.resolveForRun(owner,request),
  jobRoot: path.join(taskCache.root, 'xtb'),
  retainElectronicArtifacts: (owner, value) => xtbElectronicSources.retain(owner, value),
  resolveRuntime: () => xtbRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
  resolvePeriodicRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--xtb-periodic'] }; },
  sendToWindow(owner, event) {
    if(event.event==='error')logEvent('error',/^[A-Z0-9_-]{1,80}$/.test(event.error?.code??'')?event.error.code:'XTB_TASK_FAILED');
    const window = windows.get(owner);
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:xtb-event', event);
  },
});
const advancedPath = createAdvancedPathHost({
  spawn: nativeProcesses.spawn, admit: localAdmission('path'), fs,
  resolveResources:(owner,request)=>computeResources.resolveForRun(owner,request),
  jobRoot: path.join(taskCache.root, 'advanced-path'),
  resolveXtbRuntime: () => xtbRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
  resolveRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--advanced-path'] }; },
  sendToWindow(owner, event) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:advanced-path-event', event); },
});
const conformerSampling = createConformerSamplingHost({
  spawn: nativeProcesses.spawn, admit: localAdmission('sampling'), fs,
  resolveResources:(owner,request)=>computeResources.resolveForRun(owner,request),
  jobRoot: path.join(taskCache.root, 'sampling'),
  resultRoot: path.join(app.getPath('userData'), 'conformer-results', 'sampling'),
  resolveXtbRuntime: () => xtbRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
  resolveRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--conformer-sampling'] }; },
  sendToWindow(owner, event) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:conformer-sampling-event', event); },
});
const conformerBatch = createConformerOptimizationBatch({
  root: path.join(app.getPath('userData'), 'conformer-results', 'optimization'),
  assertCurrent(owner) { ownerWindow(owner); assert(!maintenanceBusy && !quitting, 'NATIVE_CANCELLED: 构象后台任务已取消'); },
  resolveResources: (owner) => computeResources.resolveForRun(owner, {}),
  resolveCapacity(_owner, request) { const value=request.resources; return Math.min(cpuResourceSnapshot().logicalCpuCount,value.configured?.threads??value.threads,Math.max(1,Math.floor((value.memoryBudgetBytes-(value.retainedMemoryEstimateBytes??0))/(256*1024**2)))); },
  onRunStart: (owner, request) => candidatePoolAdmission.hold(owner,request.identity,request.resources),
  sendToOwner(owner,event) { const window=windows.get(owner); if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('sciyue:conformer-batch-progress',event); },
  launchCandidate: createConformerBatchAdapter({xtb,
    assertCurrent(owner,source) { ownerWindow(owner); assert(!maintenanceBusy&&!quitting,'NATIVE_CANCELLED: 构象后台任务已取消'); workspaceDocuments.assertRuntimeOwner(owner,source.stamp.documentId); },
    runChemistry: (owner,request,id,lifecycle) => runChemistry(ownerWindow(owner),request,id,lifecycle),
    cancelChemistry: (owner,id) => jobs.get(`${owner}:${id}`)?.abort('CHEMISTRY_CANCELLED: 用户取消任务'),
    async preserveFailure(owner,evidence) {
      const root=path.join(app.getPath('userData'),'conformer-results','diagnostics');await fs.mkdir(root,{recursive:true});await directoryIdentity(root);
      const directory=await fs.mkdtemp(path.join(root,'forcefield-'));await directoryIdentity(directory);
      const file=await fs.open(path.join(directory,'failure.json'),'wx');try{await file.writeFile(JSON.stringify({...evidence,owner})+'\n','utf8');await file.sync();}finally{await file.close();}
      console.warn('CONFORMER_FORCEFIELD_DIAGNOSTIC_RETAINED',directory);
    },
  }),
});
let conformerBatchDisposal;
const aiss = createAissHost({
  spawn: nativeProcesses.spawn, admit: localAdmission('aiss'),
  resolveResources:(owner,request)=>{const cpu=cpuResourceSnapshot();return computeResources.resolveForRun(owner,request,{maxThreads:Math.min(2,cpu.physicalCoreCount??cpu.logicalCpuCount),reason:'既有aISS接口上限2线程'});},
  jobRoot: path.join(taskCache.root, 'aiss'),
  resolveRuntime: () => xtbRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }),
  sendToWindow(owner, event) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:aiss-event', event); },
});
const advancedOutputs = createAdvancedOutputStore({
  ownerAlive: owner => { ownerWindow(owner); return true; },
  assertDestination: destination => assertUnmanagedDestination(destination, exportRoots()),
  async chooseDestination(owner, request) {
    const window = ownerWindow(owner);
    if (isolatedIO) { const config = await readTestDialogConfig(); return config.savePath ? testPath(config.savePath, false) : null; }
    if (request.mode === 'existing-directory') {
      const choice = await dialog.showOpenDialog(window, { title: `选择输出目录 · ${request.files.length} 个文件`, properties: ['openDirectory'], buttonLabel: '输出到此目录' });
      ownerWindow(owner); return choice.canceled ? null : choice.filePaths?.[0] ?? null;
    }
    const choice = await dialog.showSaveDialog(window, { title: `新建输出目录 · ${request.files.length} 个文件`, defaultPath: request.directoryName, buttonLabel: '选择新目录名称' });
    ownerWindow(owner); return choice.canceled ? null : choice.filePath ?? null;
  },
});
const managedResults = createManagedResultTransfers();
const binaryExports = createBinaryExportStore({
  ownerAlive: owner => ownerWindow(owner),
  assertDestination: destination => assertUnmanagedDestination(destination, exportRoots()),
  async chooseDestination(owner,request) {
    const window=ownerWindow(owner);
    if(isolatedIO){const config=await readTestDialogConfig();return config.savePath?{path:await testPath(config.savePath,false),overwriteConfirmed:config.confirmOverwrite===true}:null;}
    const choice=await dialog.showSaveDialog(window,{title:'导出文件',defaultPath:request.name,filters:[{name:request.extension.toUpperCase(),extensions:[request.extension]}],properties:['showOverwriteConfirmation']});
    return choice.canceled||!choice.filePath?null:{path:choice.filePath,overwriteConfirmed:true};
  },
});
const personalFragments = createPersonalFragmentStore({ root: app.getPath('userData') });
const orbitalBackend = createOrbitalBackendStore(app.getPath('userData'));
const orbitals = createOrbitalHost({
  snapshotSource: (owner,token,options) => launchSources.snapshotSource(owner,token,options),
  scheduler: multiwfnScheduler,
  resolveResources:(owner,request)=>computeResources.resolveForRun(owner,request),
  spawn: nativeProcesses.spawnRetainedAnalysis,
  jobRoot: path.join(taskCache.root, 'orbital'),
  resolveBackend: () => orbitalBackend.info(),
  resolveRuntime() {
    const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath });
    return { ...runtime, args: [...runtime.args, '--orbitals'] };
  },
  sendToWindow(owner, event) { ownerWindow(owner).webContents.send('sciyue:orbital-event', event); },
  sendProgress(owner, snapshot) { ownerWindow(owner).webContents.send('sciyue:multiwfn-progress', snapshot); },
});
const surfaceSources = createSurfaceSourceFiles({ snapshotSource:(owner,token,options)=>launchSources.snapshotSource(owner,token,options), root: path.join(app.getPath('userData'), 'surface-sources') });
// Reuse the trusted snapshot implementation with a separate session namespace.
// A renderer-supplied interaction id cannot release another surface's source.
const interactionSources = createSurfaceSourceFiles({ snapshotSource:(owner,token,options)=>launchSources.snapshotSource(owner,token,options), root: path.join(app.getPath('userData'), 'interaction-sources') });
const excitationSources = createSurfaceSourceFiles({ snapshotSource:(owner,token,options)=>launchSources.snapshotSource(owner,token,options), root: path.join(app.getPath('userData'), 'excitation-sources') });
const reactivitySources = createSurfaceSourceFiles({ snapshotSource:(owner,token,options)=>launchSources.snapshotSource(owner,token,options), root: path.join(app.getPath('userData'), 'reactivity-sources') });
let surfaceService = null;
let interactionService = null;
let electronicService = null;
const surfaceCloseTasks = new Set();
const xtbSourceCloseTasks = new Set();
function surfaces() {
  if (!surfaceService) surfaceService = require('./surface-analysis.cjs').createSurfaceAnalysisHost({
    scheduler: multiwfnScheduler,
    spawn(...args) { return nativeProcesses.spawnRetainedAnalysis(...args); },
    jobRoot: path.join(taskCache.root, 'surface'),
    resolveBackend: () => orbitalBackend.info(),
    captureResources:owner=>computeResources.resolveForRun(owner),
    resolveResources: (owner, overrides,captured) => orbitals.resources(owner, overrides,captured),
    resolveRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--surface'] }; },
    sendToWindow(owner, event) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:surface-event', event); },
    sendProgress(owner, snapshot) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:multiwfn-progress', snapshot); },
  });
  return surfaceService;
}
function interactions() {
  if (!interactionService) interactionService = require('./interaction-analysis.cjs').createInteractionAnalysisHost({
    scheduler: multiwfnScheduler,
    spawn(...args) { return nativeProcesses.spawnRetainedAnalysis(...args); },
    jobRoot: path.join(taskCache.root, 'interaction'),
    resolveBackend: () => orbitalBackend.info(),
    captureResources:owner=>computeResources.resolveForRun(owner),
    resolveResources: (owner,_overrides,captured) => orbitals.resources(owner,undefined,captured),
    resolveRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--interactions'] }; },
    sendProgress(owner, snapshot) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:multiwfn-progress', snapshot); },
  });
  return interactionService;
}
function electronicAnalyses() {
  if (!electronicService) electronicService = require('./electronic-analysis.cjs').createElectronicAnalysisHost({
    snapshotSource: (owner,token,options) => launchSources.snapshotSource(owner,token,options),
    scheduler: multiwfnScheduler,
    spawn(...args) { return nativeProcesses.spawnRetainedAnalysis(...args); },
    jobRoot: path.join(taskCache.root, 'electronic'),
    resolveBackend: () => orbitalBackend.info(),
    captureResources:owner=>computeResources.resolveForRun(owner),
    resolveResources: (owner,_overrides,captured) => orbitals.resources(owner,undefined,captured),
    resolveRuntime() { const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); return { ...runtime, args: [...runtime.args, '--electronic-analysis'] }; },
    resolveCompanions: (owner, token, request) => launchSources.snapshotCompanions(owner, token, request),
    verifyCompanionSource: (owner, token, request) => launchSources.verifyCompanionSource(owner, token, request),
    sendProgress(owner, snapshot) { const window = windows.get(owner); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:multiwfn-progress', snapshot); },
  });
  return electronicService;
}
multiwfnScheduler.addReservationProvider('orbital', context => orbitals.reservedMemoryBytes?.(context) ?? 0);
multiwfnScheduler.addReservationProvider('surface', context => surfaceService?.reservedMemoryBytes?.(context) ?? 0);
multiwfnScheduler.addReservationProvider('interactions', context => interactionService?.reservedMemoryBytes?.(context) ?? 0);
multiwfnScheduler.addReservationProvider('electronic', context => electronicService?.reservedMemoryBytes?.(context) ?? 0);
const portableLog = portableProfile && ownsProfile ? createPortableLog({ profile: portableProfile }) : null;
const closeDiagnostics = createCloseDiagnostics({ directory: portableProfile?.paths.logs ?? app.getPath('userData'), identity: portableProfile?.identities.logs });
const logEvent = (level, code) => { void portableLog?.append({ level, code }).catch(() => {}); };
const hostBusy = () => nativeProcesses.count() > orbitals.workerCount() + empiricalChemistry.workerCount() + (surfaceService?.workerCount() ?? 0) + (interactionService?.workerCount() ?? 0) + (electronicService?.workerCount() ?? 0) + crystalModeling.workerCount() || crystalModeling.activeCount() > 0 || orbitals.sessionCount() > 0 || orbitals.activeCount() > 0 || (surfaceService?.activeCount() ?? 0) > 0 || (interactionService?.activeCount() ?? 0) > 0 || (electronicService?.activeCount() ?? 0) > 0 || surfaceCloseTasks.size > 0 || xtbSourceCloseTasks.size > 0 || jobs.size > 0 || dynamics.workerCount() > 0 || xtb.activeCount() > 0 || conformerBatch.activeCount() > 0 || advancedPath.activeCount() > 0 || conformerSampling.activeCount() > 0 || ocr.activeCount() > 0 || aiss.activeCount() > 0 || fileOperations > 0 || fileReader.activeCount() > 0;
function ownerWindow(owner) { const window = windows.get(owner); assert(window && !window.isDestroyed() && !window.webContents.isDestroyed(), 'Owned window closed'); return window; }
function resolveMcpTargetWindow(requestedWindowId) {
  if (Number.isInteger(requestedWindowId)) {
    const requested = windows.get(requestedWindowId);
    if (requested && !requested.isDestroyed() && !requested.webContents.isDestroyed()) return requested;
  }
  if (primaryWorkbenchWindowId !== null) {
    const primary = windows.get(primaryWorkbenchWindowId);
    if (primary && !primary.isDestroyed() && !primary.webContents.isDestroyed()) return primary;
  }
  for (const [id, win] of windows.entries()) {
    if (!detachedWorkspaceWindows.has(id) && !win.isDestroyed() && !win.webContents.isDestroyed()) return win;
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) return win;
  }
  return null;
}
const mcpLiveHost = createMcpLiveHost({
  sessionFilePath: process.env.ESTER_MCP_SESSION_FILE
    ? path.resolve(process.env.ESTER_MCP_SESSION_FILE)
    : path.join(app.getPath('userData'), 'mcp-session.json'),
  serverVersion: appVersion,
  getTargetWindow: resolveMcpTargetWindow,
  getHostStatus: () => ({
    windowCount: windows.size,
    primaryWorkbenchWindowId,
    detachedWindowCount: detachedWorkspaceWindows.size,
  }),
});
const analysisWindows = createAnalysisWindowHost({headless,icon:path.join(appPath,'dist','brand-icon.png'),sendToOwner(owner,event){ownerWindow(owner).webContents.send('sciyue:analysis-window-event',event);}});
async function portableSaveSelection(owner, kind) {
  const window = ownerWindow(owner);
  if (isolatedIO) { const config = await readTestDialogConfig(); if (!config.savePath) return null; return { path: await testPath(config.savePath, false), overwriteConfirmed: config.confirmOverwrite === true }; }
  const title = kind === 'diagnostics' ? '导出脱敏诊断' : '导出偏好';
  const result = await dialog.showSaveDialog(window, { title, defaultPath: path.join(portableProfile.root, kind === 'diagnostics' ? 'Ester-Studio-diagnostics.json' : 'Ester-Studio-preferences.json'), filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
  ownerWindow(owner); return result.canceled || !result.filePath ? null : { path: result.filePath, overwriteConfirmed: true };
}
async function portableImportSelection(owner) {
  const window = ownerWindow(owner);
  if (isolatedIO) { const config = await readTestDialogConfig(); const value = config.openFiles?.[0]; return value ? { path: await testPath(value, true) } : null; }
  const choice = await dialog.showMessageBox(window, { type: 'question', title: '导入偏好', message: '选择偏好来源', detail: '只读取你明确选择的偏好文件或旧版本配置目录；原文件不会移动或删除。', buttons: ['偏好 JSON 文件', '旧版本配置目录', '取消'], cancelId: 2, defaultId: 0 });
  ownerWindow(owner); if (choice.response === 2) return null;
  const result = await dialog.showOpenDialog(window, { title: '选择偏好来源', properties: [choice.response === 1 ? 'openDirectory' : 'openFile'], ...(choice.response === 1 ? {} : { filters: [{ name: 'Ester Studio 偏好', extensions: ['json'] }] }) });
  ownerWindow(owner); return result.canceled || result.filePaths.length !== 1 ? null : { path: result.filePaths[0] };
}
async function bundleBackendInfo() {
  return packagedBackendInfo({ packaged: app.isPackaged, resourcesPath: process.resourcesPath,
    provenanceRoot: portableProfile && (portableProfile.layout?.provenanceRoot ?? path.join(portableProfile.root, 'provenance')) });
}
const portableServices = portableProfile ? createPortableServices({
  profile: portableProfile, workbenchStore: workbenchPreferences, displayStore: modelDisplayPreferences,
  dialog: { selectImport: portableImportSelection, selectExport: owner => portableSaveSelection(owner, 'preferences'), selectDiagnosticsExport: owner => portableSaveSelection(owner, 'diagnostics') },
  openPath: location => { assert(typeof shell?.openPath === 'function', 'Directory opening unavailable'); return shell.openPath(location); },
  clearCache: () => session.defaultSession.clearCache(), isBusy: hostBusy, backendInfo: bundleBackendInfo,
  runtimeCheck: async owner => {
    ownerWindow(owner); assert(!quitting, 'Application closing');
    const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }), controller = new AbortController();
    runtimeChecks.set(owner, controller);
    try { return await checkNativeRuntime({ runtime, spawn: nativeProcesses.spawn, signal: controller.signal }); }
    finally { if (runtimeChecks.get(owner) === controller) runtimeChecks.delete(owner); }
  },
}) : null;
const expireFileStreams = setInterval(() => void fileReader.expire().catch(() => {}), 30_000);
expireFileStreams.unref();
let isolatedClipboard = null, isolatedClipboardText = '';
let modelClipboardVersion = 0;
const modelClipboard = createModelClipboard({ clipboard, ClipboardItem });
function taskGlobalDirectory(){
  if(!isolatedIO)return path.join(app.getPath('appData'),'EsterStudio','task-system');
  const selected=path.resolve(process.env.SCIYUE_TEST_TASK_GLOBAL_DIR||path.join(isolatedRoot,'task-system-global'));
  assert(within(appPath,selected)&&selected!==appPath,'Isolated task global directory must stay in this project');
  let parent=selected;while(!fsSync.existsSync(parent))parent=path.dirname(parent);
  assert(within(fsSync.realpathSync(appPath),fsSync.realpathSync(parent)),'Isolated task global directory cannot escape via a link');
  return selected;
}
const taskSystem=createTaskSystemComposition({
  globalDirectory:taskGlobalDirectory(),
  openPath: location => { assert(typeof shell?.openPath === 'function', 'Directory opening unavailable'); return shell.openPath(location); },
  snapshotRoot:path.join(portableProfile?.paths.temp??app.getPath('userData'),'external-task-snapshots'),safeStorage,launchSources,assertOwner:ownerWindow,
  async chooseDirectory({purpose,ownerId,path:initialPath}){
    if(isolatedIO){const config=await readTestDialogConfig(),selected=config.taskDirectories?.[purpose]??config.taskDirectory;return selected?testPath(selected,true):null;}
    const titles={associate:'选择固定任务库',migrate:'选择迁入目录','source-save':'选择本次来源归档父目录','task-marker':'选择结果任务目录','working-root':'选择默认工作根','scratch-root':'选择Scratch目录'};
    const result=await dialog.showOpenDialog(ownerWindow(Number(ownerId)),{title:titles[purpose]??'选择任务库恢复目录',...(typeof initialPath==='string'&&initialPath?{defaultPath:initialPath}:{}),properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0]??null;
  },
  async chooseOpenFile({purpose,ownerId,path:initialPath}){
    assert(purpose==='executable'||purpose==='private-key','Unsupported environment file chooser purpose');
    if(isolatedIO){const config=await readTestDialogConfig(),selected=config.taskFiles?.[purpose]??config.openFiles?.[0];return selected?testPath(selected,true):null;}
    const result=await dialog.showOpenDialog(ownerWindow(Number(ownerId)),{title:purpose==='private-key'?'选择本机私钥文件':'选择本机软件可执行文件',...(typeof initialPath==='string'&&initialPath?{defaultPath:initialPath}:{}),properties:['openFile']});return result.canceled?null:result.filePaths[0]??null;
  },
  async chooseDependencyFiles({ownerId}){
    if(isolatedIO){const config=await readTestDialogConfig();return Promise.all((config.taskDependencies??config.openFiles??[]).map(value=>testPath(value,true)));}
    const result=await dialog.showOpenDialog(ownerWindow(Number(ownerId)),{title:'选择本次输入依赖',properties:['openFile','multiSelections']});return result.canceled?[]:result.filePaths;
  },
  async chooseSaveFile({purpose,ownerId}){
    if(isolatedIO){const config=await readTestDialogConfig();return config.savePath?testPath(config.savePath,false):null;}
    const result=await dialog.showSaveDialog(ownerWindow(Number(ownerId)),{title:purpose==='environment'?'导出无秘密环境配置':'另存文件副本',...(purpose==='environment'?{defaultPath:'environment.json',filters:[{name:'环境配置',extensions:['json']}]}:{})});
    if(result.canceled||!result.filePath)return null;
    assert(purpose==='environment'||purpose==='artifact-copy','Unsupported task export purpose');
    if(purpose==='environment')assertExportDestination(result.filePath,exportRoots());
    else assertUnmanagedDestination(result.filePath,exportRoots());
    return result.filePath;
  },
  async chooseImportFile({ownerId}){
    if(isolatedIO){const config=await readTestDialogConfig();return config.openFiles?.[0]?testPath(config.openFiles[0],true):null;}
    const result=await dialog.showOpenDialog(ownerWindow(Number(ownerId)),{title:'导入环境配置',properties:['openFile'],filters:[{name:'环境配置',extensions:['json']}]});return result.canceled?null:result.filePaths[0]??null;
  },
  writeClipboard:text=>{if(isolatedIO)isolatedClipboardText=text;else clipboard.writeText(text);},
  async confirmImpact(scope){
    if(isolatedIO)return(await readTestDialogConfig()).confirmTaskImpact===true;
    const labels={'empty-recycle':'永久清空任务回收区',migrate:'迁移任务库','recover-library':'恢复任务库'},label=labels[scope.purpose]??'执行任务库操作';
    const detail=scope.source?`来源：${typeof scope.source==='string'?scope.source:scope.source.root}\n目标：${scope.target}\n原任务库保留。`:`将永久删除回收区内 ${scope.impact?.count??0} 个文件，共 ${((scope.impact?.logicalBytes??0)/1024**2).toFixed(2)} MiB。\n独立项目快照与原计算目录保留。`;
    const result=await dialog.showMessageBox(ownerWindow(Number(scope.ownerId)),{type:'question',title:label,message:label+'？',detail,buttons:['取消','继续'],defaultId:0,cancelId:0,noLink:true});return result.response===1;
  },
  onError:value=>logEvent('warning','EXTERNAL_TASK_'+(value.code??'ERROR')),
});
async function prepareExternalTaskExit(window){
  const summary=taskSystem.exitSummary();if(!summary.requiresChoice)return true;
  let choice;
  if(isolatedIO)choice=(await readTestDialogConfig()).externalTaskExitChoice??'cancel';
  else{
    const options={type:'question',title:'外部计算任务',message:'退出后如何处理外部任务？',detail:`运行或待核实任务：${summary.runs.length}\n已登记操作：${summary.operations.length}\n继续计算将保留外部进程与持久记录；文件操作先安全收尾。`,buttons:['取消退出','继续计算并退出','停止任务后退出'],defaultId:0,cancelId:0,noLink:true};
    const answer=window&&!window.isDestroyed()?await dialog.showMessageBox(window,options):await dialog.showMessageBox(options);choice=['cancel','continue','stop'][answer.response]??'cancel';
  }
  if(choice==='cancel')return false;
  const current=taskSystem.exitSummary();if(current.runs.some(row=>!summary.runs.some(prior=>prior.runId===row.runId)))throw Error('确认期间出现新的外部任务，请重新确认退出。');
  const result=await taskSystem.prepareExit(choice);if(!result.ready)throw Error(result.reason??'外部任务尚未确认安全结束，已保留窗口。');return true;
}
const entryURL = development ? 'http://127.0.0.1:4181/' : 'app://studio/index.html';

function senderWindow(event) {
  const window = windows.get(event.sender.id);
  assert(window && !window.isDestroyed() && event.senderFrame === event.sender.mainFrame && allowedURL(event.senderFrame.url, development), 'Untrusted desktop IPC sender');
  return window;
}
const fileChannels = new Set(['export-citations', 'sy-project', 'describe-excitation-project-companions', 'read-excitation-project-companion', 'release-excitation-project-companions', 'begin-project-companion-bundle', 'append-project-companion-bundle', 'commit-project-companion-bundle', 'abort-project-companion-bundle', 'close-project-companion-bundle', 'open-files', 'claim-launch-import', 'read-launch-source', 'register-selected-output-source', 'pick-reference-file', 'read-file-chunk', 'choose-save-path', 'write-chosen-file', 'choose-orbital-backend', 'import-personal-fragments', 'export-personal-fragments', 'open-surface-session', 'import-surface-cube', 'register-surface-cube', 'read-registered-surface-cube', 'release-surface-cube', 'export-surface-cube', 'export-registered-surface-cube', 'open-interaction-session', 'export-interaction-cube', 'open-excitation-session', 'open-reactivity-session', 'export-excitation-cube', 'choose-advanced-output', 'write-advanced-output', 'abandon-advanced-output', 'open-hirshfeld-session', 'export-hirshfeld-cube', 'open-xtb-orbital-session']);
function handle(channel, listener) {
  ipcMain.handle(`sciyue:${channel}`, (event, ...args) => {
    const window = senderWindow(event); assert(!quitting, 'APPLICATION_CLOSING: 应用正在关闭');
    const run=()=>Promise.resolve(listener(window,...args)).then(value=>managedResultChannels.has(channel)?(ownerWindow(window.webContents.id),managedResults.pack(window.webContents.id,value)):value);
    if (!fileChannels.has(channel)) return run();
    if (channel === 'claim-launch-import') launchImports.markReady(window.webContents.id);
    assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束，请稍后重试'); fileOperations++;
    const pending = Promise.resolve().then(run).catch(error => {
      if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENODEV', 'EIO', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(error?.code)) {
        const storage = classifyStorageError(error); logEvent('warning', storage.code); throw new Error(storage.code + ': ' + storage.message);
      }
      throw error;
    }).finally(() => { fileOperations--; pendingFileOperations.delete(pending); });
    pendingFileOperations.add(pending); return pending;
  });
}
const managedResultChannels = new Set(['read-xtb-electronic-artifacts','analyze-wavefunction','read-orbital-field','analyze-surface','generate-surface','surface-restore-fields','surface-distribution','generate-interaction','interaction-contributions','restore-interaction-fields','run-excitation','restore-excitation-fields','analyze-reactivity','analyze-hirshfeld','restore-hirshfeld-fields','read-registered-surface-cube','import-surface-cube','open-orbital-session','open-xtb-orbital-session']);
managedResultChannels.add('task-system-request');
handle('task-system-request',(window,request)=>taskSystem.request(window.webContents.id,request));
handle('task-system-cancel',(window,requestId)=>taskSystem.cancel(window.webContents.id,requestId));
handle('mcp-frontend-reply',(window,response)=>mcpLiveHost.handleFrontendReply(window.webContents.id,response));
for(const channel of ['begin-binary-export','append-binary-export','commit-binary-export','abort-binary-export','describe-launch-source'])fileChannels.add(channel);
handle('managed-result-transfer',(window,request)=>{assert(plain(request)&&['read','release'].includes(request.action),'Invalid managed result action');return request.action==='read'?managedResults.read(window.webContents.id,request.token,request.start):managedResults.release(window.webContents.id,request.token);});
handle('acquire-worker-resources',(window,request)=>frontendWorkAdmission.acquire(window.webContents.id,request));
handle('cancel-worker-resources',async(window,id)=>{await frontendWorkAdmission.cancel(window.webContents.id,id);});
handle('release-worker-resources',async(window,id)=>{await frontendWorkAdmission.release(window.webContents.id,id);});
handle('report-prepared-trajectory-memory',(window,bytes)=>{assert(Number.isSafeInteger(bytes)&&bytes>=0,'Invalid retained trajectory estimate');preparedMemoryEstimates.set(window.webContents.id,bytes);});
handle('begin-binary-export',(window,request)=>binaryExports.begin(window.webContents.id,request));
handle('append-binary-export',(window,token,bytes)=>binaryExports.append(window.webContents.id,token,bytes));
handle('commit-binary-export',(window,token)=>binaryExports.commit(window.webContents.id,token));
handle('abort-binary-export',(window,token)=>binaryExports.abort(window.webContents.id,token));
handle('sy-project',(window,request)=>projectIPC.invoke(window,request));
function workbenchActionTarget(window) {
  const member = workspaceDocuments.read(window.webContents.id).find(row => !row.isOwner);
  const target = member ? ownerWindow(Number(member.ownerWindowId)) : window;
  if (hiddenWorkspaceOwners.delete(target.webContents.id)) { target.show(); target.webContents.send('sciyue:workspace-document-event', { kind: 'owner-view-restored', schema: 'sciyue-workspace-document', version: 1, ownerWindowId: String(target.webContents.id) }); }
  return { target, member };
}
function requestProjectAction(window, action) {
  assert(['save', 'save-as', 'open'].includes(action), 'Invalid project action');
  workbenchActionTarget(window).target.webContents.send('sciyue:project-action', action); return { accepted: true };
}
function canWorkbenchFileAction(window, action) {
  const state = workbenchFileStates.get(window?.webContents.id);
  return !quitting && state?.[{ import: 'canImport', 'export-structure': 'canExportStructure', 'export-image': 'canExportImage' }[action]] === true;
}
function requestWorkbenchFileAction(window, action) {
  if (!canWorkbenchFileAction(window, action)) return false;
  const member = workspaceDocuments.read(window.webContents.id).find(row => !row.isOwner);
  const { target, request } = workbenchFileActionRoute(window, action, member, ownerWindow);
  if (target !== window && hiddenWorkspaceOwners.delete(target.webContents.id)) { target.show(); target.webContents.send('sciyue:workspace-document-event', { kind: 'owner-view-restored', schema: 'sciyue-workspace-document', version: 1, ownerWindowId: String(target.webContents.id) }); }
  target.webContents.send(FILE_ACTION_CHANNEL, request); return true;
}
function requestCitations(window){
  const {target,member}=workbenchActionTarget(window);ownerWindow(target.webContents.id);
  if(target!==window){
    target.show();target.focus();
  }
  target.webContents.send('sciyue:citations-open',member?{documentId:member.documentId}:{});return true;
}
const exportCitations=createCitationExport({fs,assertOwner:ownerWindow,roots:exportRoots,select:async(window,format)=>{
  if(isolatedIO){const config=await readTestDialogConfig();return {cancelled:!config.savePath,path:config.savePath?await testPath(config.savePath,false):undefined,overwriteConfirmed:config.confirmOverwrite===true};}
  const result=await dialog.showSaveDialog(window,{title:'导出文献',defaultPath:`Ester-Studio-citations.${format}`,filters:[{name:format==='bib'?'BibTeX':format.toUpperCase(),extensions:[format]}],properties:['showOverwriteConfirmation']});
  return {cancelled:result.canceled,path:result.filePath,overwriteConfirmed:true};
}});
handle('export-citations',exportCitations);
handle('request-project-action', requestProjectAction);
handle('update-workbench-file-state', (window, state) => {
  assert(plain(state) && Object.keys(state).length === 3 && ['canImport', 'canExportStructure', 'canExportImage'].every(key => typeof state[key] === 'boolean'), 'Invalid workbench file capabilities');
  workbenchFileStates.set(window.webContents.id, { ...state }); refreshNativeMenu(); return { accepted: true };
});
handle('read-project-window-placements',window=>{const owner=String(window.webContents.id),detached={};for(const [id,child]of windows)if(id!==window.webContents.id&&!child.isDestroyed())for(const row of workspaceDocuments.read(id))if(!row.isOwner&&row.ownerWindowId===owner)detached[row.documentId]=child.getBounds();return{main:{...window.getBounds(),maximized:window.isMaximized()},detached};});
handle('restore-project-window-placement',(window,bounds)=>{assert(plain(bounds)&&['x','y','width','height'].every(key=>Number.isFinite(bounds[key])),'Invalid project window placement');const area=screen.getDisplayMatching(bounds).workArea,width=Math.min(Math.max(640,Math.round(bounds.width)),area.width),height=Math.min(Math.max(480,Math.round(bounds.height)),area.height);window.setBounds({x:Math.max(area.x,Math.min(Math.round(bounds.x),area.x+area.width-width)),y:Math.max(area.y,Math.min(Math.round(bounds.y),area.y+area.height-height)),width,height});if(bounds.maximized)window.maximize();return{restored:true};});
handle('describe-excitation-project-companions',(window,id)=>electronicAnalyses().describeProjectCompanions(window.webContents.id,id));
handle('read-excitation-project-companion',(window,id,role,start,end)=>electronicAnalyses().readProjectCompanion(window.webContents.id,id,role,start,end));
handle('release-excitation-project-companions',(window,id)=>electronicAnalyses().releaseProjectCompanions(window.webContents.id,id));
handle('begin-project-companion-bundle',(window,request)=>projectCompanionSources.begin(window.webContents.id,request));
handle('append-project-companion-bundle',(window,id,role,start,bytes)=>projectCompanionSources.append(window.webContents.id,id,role,start,bytes));
handle('commit-project-companion-bundle',(window,id)=>projectCompanionSources.commit(window.webContents.id,id));
handle('abort-project-companion-bundle',(window,id)=>projectCompanionSources.abort(window.webContents.id,id));
handle('close-project-companion-bundle',(window,id)=>projectCompanionSources.close(window.webContents.id,id));
function cancelWindowJobs(webContentsId) {
  // Forced exit preserves incomplete transactions and source directories.
  if (forcingExit) return;
  mcpLiveHost.disposeOwner(webContentsId);
  void taskSystem.releaseOwner(webContentsId).catch(error=>logEvent('warning','EXTERNAL_TASK_OWNER_CLOSE_FAILED',error.message));
  managedResults.disposeOwner(webContentsId);
  preparedMemoryEstimates.delete(webContentsId);
  void frontendWorkAdmission.disposeOwner(webContentsId).catch(error=>logEvent('warning','WORKER_RESOURCE_CLOSE_FAILED',error.message));
  const exportsClosing=binaryExports.disposeOwner(webContentsId);pendingFileOperations.add(exportsClosing);exportsClosing.catch(error=>logEvent('warning','EXPORT_CLOSE_FAILED',error.message)).finally(()=>pendingFileOperations.delete(exportsClosing));
  void projectIPC.disposeOwner(webContentsId).catch(error=>console.warn('PROJECT_CLOSE',error.message));
  runtimeModelDisplay.disposeOwner(webContentsId);
  multiwfnScheduler.cancelOwner(webContentsId);
  runtimeChecks.get(webContentsId)?.abort();
  // During application shutdown, already accepted publications must finish
  // even if their renderer disappears. Global disposal follows actual settle.
  if (!quitting || quitFinalized) {
    portableServices?.disposeOwner(webContentsId);
    personalFragments.disposeOwner(webContentsId);
    workbenchPreferences.disposeOwner(webContentsId);
    modelDisplayPreferences.disposeOwner(webContentsId);
    surfaceDisplayPreferences.disposeOwner(webContentsId);
    modelHoldKeyPreferences.disposeOwner(webContentsId);
    computeResources.disposeOwner(webContentsId);
    firstRunLicense.disposeOwner(webContentsId);
  }
  windowClosePolicy.disposeWindow(webContentsId);
  void fileReader.disposeOwner(webContentsId);
  void projectCompanionSources.closeOwner(webContentsId).then(()=>launchImports.disposeOwner(webContentsId)).catch(error=>logEvent('warning','PROJECT_COMPANION_CLOSE_FAILED',error.message));
  dynamics.closeOwner(webContentsId);
  empiricalChemistry.closeOwner(webContentsId);
  nativeCapabilities.closeOwner(webContentsId);
  crystalModeling.cancelOwner(webContentsId);
  const batchOwnerClosing=conformerBatch.closeOwner(webContentsId);
  xtb.closeOwner(webContentsId);
  advancedPath.closeOwner(webContentsId);
  conformerSampling.closeOwner(webContentsId);
  ocr.closeOwner(webContentsId);
  aiss.closeOwner(webContentsId); advancedOutputs.closeOwner(webContentsId);
  const xtbSourcesClosing = Promise.all([batchOwnerClosing,xtb.settle(webContentsId)]).then(() => xtbElectronicSources.closeOwner(webContentsId));
  xtbSourceCloseTasks.add(xtbSourcesClosing);
  xtbSourcesClosing.catch(() => logEvent('warning', 'XTB_SOURCE_CLOSE_FAILED')).finally(() => xtbSourceCloseTasks.delete(xtbSourcesClosing));
  orbitals.closeOwner(webContentsId);
  const surfaceClosing = Promise.resolve().then(() => Promise.all([surfaceService?.closeOwner(webContentsId), interactionService?.closeOwner(webContentsId), electronicService?.closeOwner(webContentsId)])).then(() => Promise.all([surfaceSources.closeOwner(webContentsId), interactionSources.closeOwner(webContentsId), excitationSources.closeOwner(webContentsId), reactivitySources.closeOwner(webContentsId)]));
  surfaceCloseTasks.add(surfaceClosing); surfaceClosing.catch(() => logEvent('warning', 'SURFACE_SOURCE_CLOSE_FAILED')).finally(() => surfaceCloseTasks.delete(surfaceClosing));
  for (const job of jobs.values()) if (job.owner === webContentsId) job.abort('CHEMISTRY_CANCELLED: 模型窗口已关闭');
  for (const [token, value] of tokens) if (value.owner === webContentsId) tokens.delete(token);
}
const windowClosePolicy = createWindowClosePolicy({
  prepareApplicationExit:prepareExternalTaskExit,
  cancelApplicationExit:()=>taskSystem.resumeAfterCancelledExit(),
  windows, readDocuments: owner => workspaceDocuments.read(owner), hasOwnedDocuments: owner => workspaceDocuments.hasOwnedDocuments(owner),
  // A separate full workspace/project is independent even when the first
  // window closes. Shared views of the same owner keep application-X semantics.
  isApplicationWindow: owner => owner === primaryWorkbenchWindowId && ![...windows.keys()].some(other => other !== owner && workspaceDocuments.hasOwnedDocuments(other)),
  hasRunningTasks: () => nativeProcesses.count() > orbitals.workerCount() + empiricalChemistry.workerCount() + (surfaceService?.workerCount() ?? 0) + (interactionService?.workerCount() ?? 0) + (electronicService?.workerCount() ?? 0) + crystalModeling.workerCount() || crystalModeling.activeCount() > 0 || orbitals.activeCount() > 0 || (surfaceService?.activeCount() ?? 0) > 0 || (interactionService?.activeCount() ?? 0) > 0 || (electronicService?.activeCount() ?? 0) > 0 || jobs.size > 0 || dynamics.activeCount() > 0 || xtb.activeCount() > 0 || conformerBatch.activeCount() > 0 || advancedPath.activeCount() > 0 || conformerSampling.activeCount() > 0 || ocr.activeCount() > 0 || aiss.activeCount() > 0,
  isRetainedOwner: owner => hiddenWorkspaceOwners.has(owner),
  canDestroyWindows: () => quitFinalized,
  isQuitting: () => quitting, quit: () => app.quit(),
  retainOwner(window) {
    const id = window.webContents.id;
    hiddenWorkspaceOwners.add(id); window.hide();
    window.webContents.send('sciyue:workspace-document-event', { kind: 'owner-view-hidden', schema: 'sciyue-workspace-document', version: 1, ownerWindowId: String(id) });
  },
  async confirmDiscard(window, dirty, exitingApp, { runningTasks = false } = {}) {
    if (isolatedIO) return (await readTestDialogConfig()).confirmDiscardOnClose === true;
    const choice = await dialog.showMessageBox(window, { type: 'warning', title: exitingApp ? '退出 Ester Studio' : '关闭工作窗',
      message: exitingApp ? runningTasks ? '本实例仍有运行任务，是否停止任务、放弃未保存修改并退出？' : '有未保存的模型或输入，是否放弃修改并退出？' : '有未保存的模型或输入，是否放弃修改并关闭？',
      detail: dirty.map(row => row.label + (row.running ? '（任务运行中）' : '')).join('\n') + (exitingApp ? '\n本实例的运行任务将结束；正在保存的文件会完成写入。' : ''),
      buttons: ['取消', exitingApp ? '放弃修改并退出' : '放弃修改并关闭'], defaultId: 0, cancelId: 0, noLink: true });
    return choice.response === 1;
  },
  settleWindowWrites: () => Promise.allSettled([personalFragments.settle(), workbenchPreferences.settle(), modelDisplayPreferences.settle(), surfaceDisplayPreferences.settle(), modelHoldKeyPreferences.settle(), computeResources.settle(), ...pendingFileOperations]),
  reportError(window, error) {
    logEvent('warning', 'APPLICATION_CLOSE_CANCELLED');
    void closeDiagnostics.record('close-cancelled', { owner: window.webContents.id, error: error.message, stack: error.stack });
    if (!headless) void dialog.showMessageBox(window, { type: 'error', title: '关闭已取消', message: error.message || '关闭准备失败；窗口及文件保留。', buttons: ['确定'] }).catch(() => {});
  },
  reportStage: (phase, details) => { void closeDiagnostics.record(phase, details); },
  async confirmForceExit(window, details) {
    if (isolatedIO) return (await readTestDialogConfig()).forceExit === true;
    const options = { type: 'warning', title: '退出 Ester Studio', message: '关闭尚未完成。是否强制退出本实例？',
      detail: '未保存的修改将丢失；正在保存的操作可能未完成。原成功保存点及未完成材料将保留，不执行完成后的清理。\n只结束当前实例及其受管任务。\n阶段：' + details.phase,
      buttons: ['继续等待', '强制退出本实例'], defaultId: 0, cancelId: 0, noLink: true };
    const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  async forceQuit() {
    forcingExit = true; quitting = true; nativeProcesses.closeAdmission(); refreshNativeMenu();
    logEvent('warning', 'APPLICATION_FORCE_EXIT');
    await forcedShutdown.shutdown();
  },
});
function createModelWindow(workspaceOpen) {
  const detached = workspaceOpen?.detached === true;
  const window = new BrowserWindow({ icon:path.join(appPath,'dist','brand-icon.png'), width: detached ? 1000 : 1500, height: detached ? 760 : 940, minWidth: detached ? 640 : 800, minHeight: detached ? 480 : 600, ...workspaceOpen?.placement, show: !headless, title: `Ester Studio v${appVersionLabel}${appBuildRevision ? ' (' + appBuildRevision + ')' : ''} · 分子建模`,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged },
  });
  const id = window.webContents.id;
  windows.set(id, window);
  if (!workspaceOpen && primaryWorkbenchWindowId === null) primaryWorkbenchWindowId = id;
  workspaceDocuments.attachWindow(id);
  if (workspaceOpen) workspaceDocuments.join(workspaceOpen.requester, id, workspaceOpen.request);
  if (detached) detachedWorkspaceWindows.set(id, workspaceOpen.request.documentId);
  analysisWindows.attachOwner(window);
  const navigationGuard = createNavigationGuard(development);
  window.webContents.on('will-navigate', navigationGuard);
  window.webContents.on('will-frame-navigate', navigationGuard);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (forcingExit) return;
    if (approvedShellCloses.has(id)) return;
    if (detachedWorkspaceWindows.has(id) && !quitting) {
      event.preventDefault();
      if (pendingShellCloses.has(id) || windowClosePolicy.isRendererUnavailable(id)) { void windowClosePolicy.requestEmergencyExit(window, 'detached-close-waiting'); return; }
      const membership = workspaceDocuments.read(id).find(row => row.documentId === detachedWorkspaceWindows.get(id));
      if (!membership) { closeDetachedShell(id); return; }
      pendingShellCloses.add(id);
      const closeWarning = setTimeout(() => { void windowClosePolicy.requestEmergencyExit(window, 'detached-close-timeout'); }, 10000);
      void requestWorkspaceClose(id, { documentId: membership.documentId, membershipNonce: membership.membershipNonce })
        .catch(error => { logEvent('warning', 'DOCUMENT_CLOSE_CANCELLED'); if (!headless && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '关闭已取消', message: error.message, buttons: ['确定'] }).catch(() => {}); })
        .finally(() => { clearTimeout(closeWarning); pendingShellCloses.delete(id); });
      return;
    }
    windowClosePolicy.onClose(window, event);
  });
  window.on('focus', () => { refreshNativeMenu(); if (detachedWorkspaceWindows.has(id)) { try { workspaceDocuments.activateDetachedWindow(id); } catch { /* A closing/crashed owner cannot acquire a new authority. */ } } });
  window.on('unresponsive', () => { workbenchFileStates.delete(id); refreshNativeMenu(); windowClosePolicy.rendererUnavailable(id, 'renderer-unresponsive'); });
  window.on('responsive', () => { windowClosePolicy.rendererResponsive(id); refreshNativeMenu(); });
  window.webContents.on('console-message', (_event, details, oldMessage) => { const message = typeof details === 'object' ? details.message : oldMessage; const level = typeof details === 'object' ? details.level : details; if (level === 'error' || level === 3) void closeDiagnostics.record('renderer-error', { owner: id, error: String(message ?? '') }); });
  window.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame !== false) { workbenchFileStates.delete(id); refreshNativeMenu(); windowClosePolicy.rendererUnavailable(id, 'renderer-load-failed'); void closeDiagnostics.record('renderer-load-failed', { owner: id, error: description, exitCode: code }); } });
  window.webContents.on('render-process-gone', (_event, details) => { workbenchFileStates.delete(id); refreshNativeMenu(); windowClosePolicy.rendererUnavailable(id, 'renderer-gone'); void closeDiagnostics.record('renderer-gone', { owner: id, reason: details?.reason, exitCode: details?.exitCode }); if (!forcingExit) { workspaceDocuments.detachWindow(id); cancelWindowJobs(id); } });
  window.on('closed', () => { workbenchFileStates.delete(id); if (!forcingExit) workspaceDocuments.detachWindow(id); detachedWorkspaceWindows.delete(id); approvedShellCloses.delete(id); hiddenWorkspaceOwners.delete(id); cancelWindowJobs(id); windows.delete(id); refreshNativeMenu(); });
  void window.loadURL(entryURL);
  return window;
}
function closeDetachedShell(id) {
  const window = windows.get(Number(id)); if (!window || window.isDestroyed()) return;
  detachedWorkspaceWindows.delete(Number(id)); approvedShellCloses.add(Number(id)); window.close();
}
async function requestWorkspaceClose(owner, request) {
  const result = await workspaceDocuments.requestClose(owner, request);
  if (forcingExit) return { status: 'cancelled' };
  if (result.status === 'closed' && result.windowId !== null) closeDetachedShell(result.windowId);
  return { status: result.status };
}
async function readTestDialogConfig() {
  assert(isolatedIO, 'Test dialog adapter unavailable');
  const configPath = path.join(isolatedRoot, 'dialog-requests.json');
  try { const config = JSON.parse(await fs.readFile(configPath, 'utf8')); assert(plain(config), 'Invalid isolated dialog config'); return config; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function testPath(value, existing) {
  assert(string(value, 4096), 'Invalid isolated dialog target');
  const target = path.resolve(isolatedRoot, value);
  assert(within(isolatedRoot, target) && target !== isolatedRoot, 'Test dialog target is outside its isolated directory');
  const resolved = await fs.realpath(existing ? target : path.dirname(target));
  assert(within(await fs.realpath(isolatedRoot), resolved), 'Test dialog target escapes through a link');
  return target;
}
handle('citation-runtime-info', () => ({ electronVersion: process.versions.electron, nodeVersion: process.versions.node, chromiumVersion: process.versions.chrome }));
handle('info', async window => {
  const cpuResources = await readCpuResources();
  let nativeChemistry = false;
  let capabilities = { periodicGfn2BondOrders: false };
  try { const runtime=chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath }); nativeChemistry = true; if(!maintenanceBusy&&!quitting&&nativeProcesses.count()<8)capabilities=await nativeCapabilities.read(window.webContents.id,runtime); } catch { /* Capability is unavailable, never silently substitute a runtime. */ }
  return { version: appDisplayVersion, machineVersion:appVersion, releaseChannel:appMetadata.releaseChannel, platform: process.platform, nativeChemistry, ...capabilities, ...cpuResources };
});
handle('workspace-window-geometry', window => {
  const { x, y, width, height } = window.getContentBounds();
  return { x, y, width, height };
});
handle('portable-tools', async (window, request) => {
  if (!portableServices) return { ok: false, action: request?.action ?? 'invalid', error: { code: 'PORTABLE_UNAVAILABLE', message: '当前平台或运行模式未启用 Windows 便携目录服务。', retryable: false, preserved: true } };
  const exclusive = ['import-apply', 'cache-apply', 'runtime-check'].includes(request?.action);
  if (maintenanceBusy || quitting || exclusive && hostBusy()) return { ok: false, action: request?.action ?? 'invalid', error: { code: 'PORTABLE_BUSY', message: '运行任务或文件操作尚未结束，请稍后重试。', retryable: true, preserved: true } };
  if (exclusive) maintenanceBusy = true;
  try { const result = await portableServices.handle(request, { ownerId: window.webContents.id }); if (!result.ok) logEvent('warning', /^[A-Z0-9_-]{1,80}$/.test(result.error.code) ? result.error.code : 'PORTABLE_OPERATION_FAILED'); return result; }
  finally { if (exclusive) { maintenanceBusy = false; launchImports.wake(); } }
});
handle('read-personal-fragments', window => personalFragments.read(window.webContents.id));
handle('update-personal-fragments', (window, request) => { assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待维护操作结束'); return personalFragments.update(window.webContents.id, request); });
handle('import-personal-fragments', async window => {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待维护操作结束'); fileOperations++;
  try {
    let selected;
    if (isolatedIO) { const config = await readTestDialogConfig(); selected = config.openFiles?.[0] ? await testPath(config.openFiles[0], true) : null; }
    else { const result = await dialog.showOpenDialog(window, { title: '导入个人片段库', properties: ['openFile'], filters: [{ name: 'Ester Studio 个人片段 JSON', extensions: ['json'] }] }); selected = result.canceled ? null : result.filePaths[0]; }
    ownerWindow(window.webContents.id); if (!selected) return { cancelled: true };
    const schema = await import('./personal-fragments-schema.mjs');
    const record = await readChecked(selected, schema.PERSONAL_FRAGMENT_LIMITS.bytes);
    const library = schema.validatePersonalFragmentLibrary(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes)));
    ownerWindow(window.webContents.id); return { cancelled: false, library };
  } finally { fileOperations--; }
});
handle('export-personal-fragments', async (window, library) => {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待维护操作结束'); fileOperations++;
  try {
    const schema = await import('./personal-fragments-schema.mjs'); const bytes = Buffer.from(schema.serializePersonalFragmentLibrary(schema.validatePersonalFragmentLibrary(library)));
    let selected, overwriteConfirmed = false;
    if (isolatedIO) { const config = await readTestDialogConfig(); selected = config.savePath ? await testPath(config.savePath, false) : null; overwriteConfirmed = config.confirmOverwrite === true; }
    else { const result = await dialog.showSaveDialog(window, { title: '导出个人片段库', defaultPath: path.join(portableProfile?.root ?? app.getPath('documents'), 'Ester-Studio-personal-fragments.json'), filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] }); selected = result.canceled ? null : result.filePath; overwriteConfirmed = true; }
    ownerWindow(window.webContents.id); if (!selected) return { cancelled: true };
    assertExportDestination(selected, exportRoots());
    const prior = await currentFile(selected, fs, schema.PERSONAL_FRAGMENT_LIMITS.bytes), parent = await directoryIdentity(path.dirname(selected)); assert(!prior || overwriteConfirmed, 'Existing target requires overwrite confirmation');
    ownerWindow(window.webContents.id); await atomicWrite(selected, bytes, prior, parent, fs, schema.PERSONAL_FRAGMENT_LIMITS.bytes); return { cancelled: false, path: selected };
  } finally { fileOperations--; }
});
handle('open-model-window', (window, request) => {
  if (request === undefined) return String(createModelWindow().webContents.id);
  const authorized = workspaceDocuments.authorizeOpen(window.webContents.id, request);
  return String(createModelWindow({ requester: window.webContents.id, request: authorized }).webContents.id);
});
handle('prepare-analysis-window', (window, request) => analysisWindows.prepare(window.webContents.id, request));
handle('release-analysis-window', (window, request) => analysisWindows.release(window.webContents.id, request));
handle('detach-workspace-document', (window, raw) => {
  assert(plain(raw) && Object.keys(raw).every(key => ['documentId', 'membershipNonce', 'placement'].includes(key)), 'Invalid workspace detach fields');
  let placement;
  if (raw.placement !== undefined) {
    const value = raw.placement;
    assert(plain(value) && Object.keys(value).every(key => ['x', 'y', 'width', 'height'].includes(key)) && Object.values(value).every(Number.isSafeInteger), 'Invalid detached window placement');
    assert(['x', 'y'].every(key => value[key] === undefined || Math.abs(value[key]) <= 100000) && (value.width === undefined || value.width >= 640 && value.width <= 4000) && (value.height === undefined || value.height >= 480 && value.height <= 4000), 'Detached window placement exceeds bounds');
    placement = { ...value };
  }
  const request = workspaceDocuments.authorizeDetach(window.webContents.id, { documentId: raw.documentId, membershipNonce: raw.membershipNonce });
  const floating = createModelWindow({ requester: window.webContents.id, request, detached: true, placement });
  try { return workspaceDocuments.markDetached(window.webContents.id, floating.webContents.id, request); }
  catch (error) { closeDetachedShell(floating.webContents.id); throw error; }
});
handle('dock-workspace-document', (window, request) => {
  const result = workspaceDocuments.dock(window.webContents.id, request); closeDetachedShell(result.windowId); return { status: 'docked' };
});
handle('activate-workspace-document', (window, request) => workspaceDocuments.activate(window.webContents.id, request));
handle('request-workspace-document-close', (window, request) => requestWorkspaceClose(window.webContents.id, request));
handle('confirm-workspace-document-close', (window, request) => {
  const owner = window.webContents.id, authorized = workspaceDocuments.authorizeCloseConfirmation(owner, request);
  const key = JSON.stringify([owner, request.documentId, request.requestId]);
  if (closeConfirmations.has(key)) return closeConfirmations.get(key);
  const operation = (async () => {
    const requester = windows.get(Number(authorized.requesterWindowId));
    const live = () => requester && !requester.isDestroyed() && !requester.webContents.isDestroyed();
    if (!live()) return { decision: 'cancel' };
    let discard = false;
    try {
      if (isolatedIO) discard = (await readTestDialogConfig()).confirmDiscardOnClose === true;
      else {
        const choice = await dialog.showMessageBox(requester, { type: 'warning', title: '关闭工作窗', message: '有未保存的模型或输入，是否放弃修改并关闭？',
          detail: authorized.label + '\n只关闭这个模型，不删除磁盘文件。', buttons: ['取消', '放弃修改并关闭'], defaultId: 0, cancelId: 0, noLink: true });
        discard = choice.response === 1;
      }
      const current = workspaceDocuments.authorizeCloseConfirmation(owner, request);
      if (window.isDestroyed() || window.webContents.isDestroyed() || !live() || current.requesterWindowId !== authorized.requesterWindowId) return { decision: 'cancel' };
    } catch { return { decision: 'cancel' }; }
    return { decision: discard ? 'discard' : 'cancel' };
  })();
  closeConfirmations.set(key, operation);
  void operation.finally(() => { if (closeConfirmations.get(key) === operation) closeConfirmations.delete(key); });
  return operation;
});
handle('reply-workspace-document-close', (window, request) => workspaceDocuments.replyClose(window.webContents.id, request));
handle('confirm-workspace-scientific-edit', async (window, request) => {
  const owner = window.webContents.id, authorized = workspaceDocuments.authorizeScientificEditConfirmation(owner, request);
  const requester = windows.get(Number(authorized.requesterWindowId));
  if (!requester || requester.isDestroyed() || requester.webContents.isDestroyed()) return { decision: 'cancel' };
  let decision = 'cancel';
  if (isolatedIO) {
    const value = (await readTestDialogConfig()).scientificEditDecision;
    if (value === 'copy' || value === 'current' && request.copyOnly !== true) decision = value;
  } else {
    const copyOnly=request.copyOnly===true,fileImport=request.purpose==='file-import';
    const answer = await dialog.showMessageBox(requester, { type: 'question', title: copyOnly?'在新标签页继续':'修改来源结构', message: fileImport?'在新标签页载入文件，原构象帧保留。':copyOnly?'当前帧属于构象搜索，原始帧将保留。':'此修改会使当前结构的后处理结果暂不可用。',
      detail: authorized.label + (fileImport?'':copyOnly?'\n将复制当前帧，在新标签页继续本次操作。':'\n撤销相关修改后可恢复。'), buttons: copyOnly?[fileImport?'在新标签页载入文件':'在新标签页继续','取消']:['在新标签页建模', '在当前标签页建模', '取消'], defaultId: 0, cancelId: copyOnly?1:2, noLink: true });
    decision = (copyOnly?['copy','cancel']:['copy', 'current', 'cancel'])[answer.response] || 'cancel';
  }
  try {
    const current = workspaceDocuments.authorizeScientificEditConfirmation(owner, request);
    if (window.isDestroyed() || requester.isDestroyed() || current.requesterWindowId !== authorized.requesterWindowId) return { decision: 'cancel' };
  } catch { return { decision: 'cancel' }; }
  return { decision };
});
handle('register-workspace-document', (window, request) => {
  const membership = workspaceDocuments.register(window.webContents.id, request);
  // Only authoritative owners need to service document/native callbacks while
  // hidden; ordinary floating replicas retain Electron's default throttling.
  window.webContents.setBackgroundThrottling(false);
  return membership;
});
handle('read-workspace-documents', window => workspaceDocuments.read(window.webContents.id));
handle('publish-workspace-document', (window, request) => workspaceDocuments.publish(window.webContents.id, request));
handle('command-workspace-document', (window, request) => workspaceDocuments.command(window.webContents.id, request));
handle('reply-workspace-document-command', (window, request) => workspaceDocuments.reply(window.webContents.id, request));
handle('leave-workspace-document', (window, request) => workspaceDocuments.leave(window.webContents.id, request));
handle('close-workspace-document', (window, request) => workspaceDocuments.closeDocument(window.webContents.id, request));
handle('restore-workspace-owner',(window,request)=>{
  const authorized=workspaceDocuments.authorizeOpen(window.webContents.id,request);
  const membership=workspaceDocuments.read(window.webContents.id).find(value=>value.documentId===authorized.documentId);
  assert(membership,'Workspace member is unavailable');
  const owner=windows.get(Number(membership.ownerWindowId));assert(owner&&!owner.isDestroyed(),'Workspace owner is unavailable');
  hiddenWorkspaceOwners.delete(owner.webContents.id);
  if(!headless){if(owner.isMinimized())owner.restore();owner.show();owner.focus();}
  owner.webContents.send('sciyue:workspace-document-event',{kind:'activate-owner',schema:'sciyue-workspace-document',version:1,documentId:membership.documentId,ownerWindowId:membership.ownerWindowId});
  return {status:headless?'restored-headless':'shown',windowId:membership.ownerWindowId};
});
handle('read-workbench-preferences', window => workbenchPreferences.read(window.webContents.id));
handle('write-workbench-preferences', (window, preferences) => workbenchPreferences.write(window.webContents.id, preferences));
handle('read-workbench-preference-snapshot', window => workbenchPreferences.readSnapshot(window.webContents.id));
handle('write-workbench-preference-snapshot', (window, request) => workbenchPreferences.writeSnapshot(window.webContents.id, request));
handle('read-model-display-preferences', window => modelDisplayPreferences.read(window.webContents.id));
handle('read-runtime-model-display', window => runtimeModelDisplay.read(window.webContents.id));
handle('update-runtime-model-display', (window, request) => runtimeModelDisplay.update(window.webContents.id, request));
handle('write-model-display-preferences', (window, request) => modelDisplayPreferences.write(window.webContents.id, request));
handle('restore-model-display-preferences', (window, baseVersion) => modelDisplayPreferences.restoreFactory(window.webContents.id, baseVersion));
handle('read-surface-display-preferences', window => surfaceDisplayPreferences.read(window.webContents.id));
handle('read-compute-resources', window => computeResources.read(window.webContents.id));
handle('ocr-capabilities', async window => { const result=await ocrRuntime.capabilities();ownerWindow(window.webContents.id);return result; });
handle('ocr-choose-component', async window => {
  const choice=await dialog.showOpenDialog(window,{title:'选择已准备的离线识别组件目录',properties:['openDirectory']});
  ownerWindow(window.webContents.id);
  if(choice.canceled||!choice.filePaths?.[0])return ocrRuntime.capabilities();
  const result=await ocrRuntime.select(choice.filePaths[0]);ownerWindow(window.webContents.id);return result;
});
handle('ocr-recognize', (window,request) => ocr.recognize(window.webContents.id,request));
handle('ocr-cancel', (window,requestId) => ocr.cancel(window.webContents.id,requestId));
handle('read-first-run-license', window => window.webContents.id === primaryWorkbenchWindowId
  ? firstRunLicense.read(window.webContents.id)
  : {text:'',sha256:'',acknowledged:false,prompt:false});
handle('acknowledge-first-run-license', (window,request) => {
  assert(window.webContents.id === primaryWorkbenchWindowId,'LICENSE_OWNER: 首启阅读由主工作区确认。');
  return firstRunLicense.acknowledge(window.webContents.id,request);
});
handle('write-compute-resources', async (window,request) => {
  const snapshot=await computeResources.write(window.webContents.id,request);
  for(const target of windows.values())try{if(!target.isDestroyed()&&!target.webContents.isDestroyed())target.webContents.send('sciyue:compute-resources-changed',snapshot);}catch{/* A closing subscriber cannot turn a published preference into a failed save. */}
  return snapshot;
});
handle('write-surface-display-preferences', (window, request) => surfaceDisplayPreferences.write(window.webContents.id, request));
handle('restore-surface-display-preferences', (window, request) => surfaceDisplayPreferences.restoreFactory(window.webContents.id, request));
handle('read-model-hold-key-preferences', window => modelHoldKeyPreferences.read(window.webContents.id));
handle('write-model-hold-key-preferences', (window, request) => modelHoldKeyPreferences.write(window.webContents.id, request));
handle('restore-model-hold-key-preferences', (window, baseVersion) => modelHoldKeyPreferences.restoreFactory(window.webContents.id, baseVersion));
handle('complete-application-close-preparation', (window, response) => windowClosePolicy.completePreparation(window.webContents.id, response));
handle('read-clipboard', async () => {
  if (isolatedIO) return isolatedClipboard === null ? null : structuredClone(isolatedClipboard);
  return modelClipboard.read();
});
handle('write-clipboard', async (_window, payload) => {
  validateClipboard(payload);
  if (isolatedIO) isolatedClipboard = structuredClone(payload);
  else await modelClipboard.write(payload);
  const notification = { version: ++modelClipboardVersion };
  for (const window of windows.values()) {
    try { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('sciyue:model-clipboard-changed', notification); }
    catch { /* A closed view cannot turn a successful write into a failed copy. */ }
  }
});
handle('write-clipboard-text', async (_window,text) => {
  assert(typeof text==='string','CLIPBOARD_TEXT: 复制内容必须为文本。');
  if(isolatedIO){isolatedClipboardText=text;isolatedClipboard=null;return;}
  clipboard.writeText(text);
  assert(clipboard.readText()===text,'CLIPBOARD_TEXT: 剪贴板写入未能确认，请重试或下载文件。');
});
handle('open-files', async window => {
  let paths;
  if (isolatedIO) {
    const config = await readTestDialogConfig();
    assert(config.openFiles === undefined || Array.isArray(config.openFiles) && config.openFiles.every(value=>typeof value==='string'), 'Invalid test open files');
    paths = await Promise.all((config.openFiles || []).map(value => testPath(value, true)));
  } else {
    const selection = await dialog.showOpenDialog(window, { title: '打开模型文件', properties: ['openFile', 'multiSelections'], filters: [{ name: '结构与计算文件', extensions: ['sciyue', 'gjf', 'com', 'inp', 'log', 'out', 'fch', 'fchk', 'xyz', 'extxyz', 'mol', 'sdf', 'pdb', 'cif', 'vasp', 'poscar'] }, { name: '全部文件', extensions: ['*'] }] });
    if (selection.canceled) return []; paths = selection.filePaths;
  }
  return fileReader.openFiles(window.webContents.id, paths);
});
handle('claim-launch-import', window => launchImports.claim(window.webContents.id));
handle('finish-launch-import', (window, id) => launchImports.finish(window.webContents.id, id));
handle('describe-launch-source', (window, token) => launchSources.describe(window.webContents.id, token));
handle('read-launch-source', (window, token, start, end) => launchSources.read(window.webContents.id, token, start, end));
handle('close-launch-source', (window, token) => launchSources.close(window.webContents.id, token));
handle('register-selected-output-source', async (window, selected) => {
  const owner = window.webContents.id; assert(string(selected, 32768) && path.isAbsolute(selected), 'A selected output File is required'); ownerWindow(owner);
  const [source] = await launchSources.open(owner, [selected]);
  try { ownerWindow(owner); return source; }
  catch (error) { await launchSources.close(owner, source.token); throw error; }
});
handle('read-file-chunk', (window, token, offset) => fileReader.readChunk(window.webContents.id, token, offset));
handle('pick-reference-file', (window, request) => pickReferenceFile({ window, request, dialog,
  assertOwner: () => ownerWindow(window.webContents.id),
  testSelection: isolatedIO ? async () => { const config = await readTestDialogConfig(); return config.openFiles?.[0] ? testPath(config.openFiles[0], true) : null; } : undefined,
}));
handle('close-file-stream', (window, token) => fileReader.closeStream(window.webContents.id, token));
handle('choose-save-path', async (window, request) => {
  assert(plain(request) && Array.isArray(request.formats) && request.formats.length > 0, 'Invalid save request');
  const defaultFormat = request.defaultFormat ?? request.formats[0]?.id;
  request = structuredClone(request); request.name = security.suggestedSaveName(request.name, defaultFormat);
  validateSaveRequest(request);
  let selectedPath;
  let overwriteConfirmed = false;
  if (isolatedIO) {
    const config = await readTestDialogConfig();
    if (!config.savePath) return { status: 'cancelled' };
    selectedPath = await testPath(config.savePath, false);
    overwriteConfirmed = config.confirmOverwrite === true;
  } else {
    const selection = await dialog.showSaveDialog(window, { title: '保存模型', defaultPath: request.name, filters: request.formats.map(format => ({ name: format.label, extensions: format.extensions })), properties: ['showOverwriteConfirmation'] });
    if (selection.canceled || !selection.filePath) return { status: 'cancelled' };
    selectedPath = selection.filePath;
    // Electron's native dialog owns confirmation for a selected existing filename.
    overwriteConfirmed = true;
  }
  // The selected suffix is authoritative. Add only a missing suffix; an
  // explicit unknown suffix is rejected below rather than silently rewritten.
  if (!path.extname(selectedPath) && !(defaultFormat === 'poscar' && path.basename(selectedPath).toLowerCase() === 'poscar')) selectedPath += '.' + security.FORMATS[defaultFormat][0];
  ownerWindow(window.webContents.id); assertUnmanagedDestination(selectedPath, exportRoots());
  const format = formatForPath(selectedPath, request.formats);
  const identity = await currentFile(selectedPath, fs, Number.MAX_SAFE_INTEGER);
  assert(!identity || overwriteConfirmed, 'Existing test target requires explicit simulated overwrite confirmation');
  const token = randomUUID();
  const parent = await directoryIdentity(path.dirname(selectedPath));
  ownerWindow(window.webContents.id); assert(!quitting, 'Application closing');
  tokens.set(token, { owner: window.webContents.id, path: selectedPath, parent, identity, expires: Date.now() + 120_000 });
  return { status: 'selected', token, format, name: path.basename(selectedPath), path: selectedPath };
});
handle('write-chosen-file', async (window, request) => {
  assert(plain(request) && string(request.token, 100) && typeof request.text === 'string', 'Invalid save payload');
  const selection = tokens.get(request.token);
  assert(selection && selection.owner === window.webContents.id && selection.expires >= Date.now(), 'Save selection expired or belongs to another model window');
  tokens.delete(request.token);
  assertUnmanagedDestination(selection.path, exportRoots());
  await atomicWrite(selection.path, Buffer.from(request.text, 'utf8'), selection.identity, selection.parent, fs, Number.MAX_SAFE_INTEGER);
  return { status: 'saved', path: selection.path };
});
handle('choose-advanced-output', (window, request) => advancedOutputs.choose(window.webContents.id, request));
handle('abandon-advanced-output', (window, token) => advancedOutputs.abandon(window.webContents.id, token));
handle('write-advanced-output', async (window, token) => {
  try { return await advancedOutputs.write(window.webContents.id, token); }
  catch (error) { return { status: 'failed', error: { code: error.code ?? 'ADVANCED_OUTPUT_FAILED', message: String(error.message ?? error), ...(error.advancedOutput ? { advancedOutput: error.advancedOutput } : {}) } }; }
});
async function runChemistry(window, request, jobId, lifecycle) {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护操作尚未结束，请稍后启动计算');
  validateChemistry(request);
  const resourceManaged=['optimize','generate3d'].includes(request.operation);
  legacyScienceAdmission(request,resourceManaged);
  workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.stamp.documentId);
  assert(string(jobId, 100) && /^[a-zA-Z0-9_-]+$/.test(jobId), 'Invalid chemistry job identity');
  const owner = window.webContents.id;
  const key = `${owner}:${jobId}`;
  assert(!jobs.has(key), 'Duplicate chemistry job identity');
  if (request.operation === 'perceive-bonds') {
    const promise = empiricalChemistry.start(owner, request, jobId);
    jobs.set(key, { owner, abort: reason => empiricalChemistry.cancel(owner, jobId, reason) });
    return promise.finally(() => jobs.delete(key));
  }
  const pending = new AbortController();
  let release;
  jobs.set(key, { owner, advanced: Boolean(request.runIdentity),resourceManaged, abort: () => pending.abort() });
  try {
  if (resourceManaged||request.runIdentity)release = await localAdmission('forcefield')(owner, request, { signal: pending.signal });
  assert(!pending.signal.aborted && !maintenanceBusy && !quitting, 'CHEMISTRY_CANCELLED: 等待中的原生化学任务已取消');
  ownerWindow(owner); workspaceDocuments.assertRuntimeOwner(owner, request.stamp.documentId);
  legacyScienceAdmission(request,resourceManaged);
  const runtime = chemistryRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath });
  lifecycle?.onNativeEvidence?.({request,runtime:{executable:runtime.executable,args:runtime.args,cwd:runtime.cwd},resourceGrant:release?.resources});
  const child = nativeProcesses.spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
  lifecycle?.onStarted?.();
  const job = createChemistryJob(child, {
    timeoutMs: request.maxWallTimeSeconds === undefined ? undefined : request.maxWallTimeSeconds * 1000,
    parse(stdout, stderr, code, signal) {
        lifecycle?.onNativeEvidence?.({stdout,stderr,code,signal,request,runtime:{executable:runtime.executable,args:runtime.args,cwd:runtime.cwd}});
        assert(signal === null, `CHEMISTRY_INTERRUPTED: 原生引擎被信号 ${signal} 中断`);
        assert(stdout.trim().length > 0, `CHEMISTRY_STARTUP_FAILED: 原生引擎未返回数据（exit ${code}）。请保留完整便携目录；过长安装路径也可能阻止Windows加载原生库。`);
        const result = JSON.parse(stdout.trim());
        if (code !== 0 || result.error) throw new Error(`${result.error?.code || 'CHEMISTRY_FAILED'}: ${result.error?.message || stderr || `exit ${code}`}`);
        assert(plain(result) && result.operation === request.operation && JSON.stringify(result.stamp) === JSON.stringify(request.stamp) && Array.isArray(result.warnings) && string(result.engine) && typeof result.engineVersion === 'string', 'Invalid chemistry engine response');
        security.validateStructure(result.structure);
        assert(JSON.stringify(result.movableAtomIds) === JSON.stringify(request.movableAtomIds), 'Chemistry response movable identities changed');
        return release?.resources?{...result,resourceGrant:release.resources}:result;
    },
  });
  jobs.set(key, { owner, child, advanced: Boolean(request.runIdentity),resourceManaged, abort: job.abort });
  child.stdin.end(`${boundedJSON(request)}\n`);
  const result=await job.promise; await lifecycle?.onResult?.(result); return result;
  } catch(error) { await lifecycle?.onError?.(error); throw error;
  } finally { await release?.(); jobs.delete(key); }
}
handle('run-chemistry', (window,request,jobId) => runChemistry(window,request,jobId));
handle('cancel-chemistry', (window, jobId) => {
  assert(string(jobId, 100), 'Invalid chemistry job identity');
  jobs.get(`${window.webContents.id}:${jobId}`)?.abort('CHEMISTRY_CANCELLED: 用户取消任务');
});
handle('run-crystal-modeling', (window, request) => {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护或退出操作尚未结束');
  legacyScienceAdmission();
  assert(plain(request) && string(request.documentId) && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0, 'Invalid crystal modeling document identity');
  workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.documentId);
  return crystalModeling.run(window.webContents.id, request);
});
handle('start-dynamics', async (window, request, sessionId) => {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护操作尚未结束，请稍后启动计算');
  legacyScienceAdmission(request,true);
  assert(plain(request) && plain(request.stamp), 'Invalid dynamics document identity');
  workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.stamp.documentId);
  await dynamics.startWhenPreviousClosed(window.webContents.id, request, sessionId, () => {
    assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护操作尚未结束，请稍后启动计算');
    legacyScienceAdmission(request,true);
    workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.stamp.documentId);
  });
});
handle('command-dynamics', (window, sessionId, command) => {
  dynamics.command(window.webContents.id, sessionId, command);
});
handle('start-xtb', async (window, request, sessionId) => {
  const beforeStart = () => {
    assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护或退出操作尚未结束');
    legacyScienceAdmission(request,true);
    assert(plain(request) && plain(request.stamp), 'Invalid xTB document identity');
    workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.stamp.documentId);
  };
  beforeStart();
  await readCpuResources();
  beforeStart();
  return xtb.start(window.webContents.id, request, sessionId, beforeStart);
});
handle('command-xtb', (window, sessionId, command) => xtb.command(window.webContents.id, sessionId, command));
handle('release-xtb-optimization-caches', (window, sessionIds) => xtb.releaseOptimizationCaches(window.webContents.id, sessionIds));
handle('conformer-batch-command',async(window,command,payload)=>{
  const owner=window.webContents.id;
  assert(['begin','upload','seal','start','stop','status','read','restore','destroy'].includes(command)&&plain(payload),'Invalid conformer batch command');
  if(command==='begin'){assert(!maintenanceBusy&&!quitting,'PORTABLE_BUSY: 请等待维护结束');await readCpuResources();return conformerBatch.begin(owner,payload);}
  assert(string(payload.batchId,100),'Invalid conformer batch handle');
  if(command==='upload')return conformerBatch.upload(owner,payload.batchId,{offset:payload.offset,inputs:payload.inputs});
  if(command==='read')return conformerBatch.read(owner,payload.batchId,{offset:payload.offset,limit:payload.limit});
  return conformerBatch[command](owner,payload.batchId);
});
handle('read-conformer-sampling-result',(window,id,offset,limit)=>conformerSampling.readResult(window.webContents.id,id,offset,limit));
handle('release-conformer-sampling-result',(window,id)=>conformerSampling.releaseResult(window.webContents.id,id));
for (const [channel, host] of [['advanced-path', advancedPath], ['conformer-sampling', conformerSampling], ['aiss', aiss]]) {
  handle(`start-${channel}`, async (window, request, sessionId) => {
    const beforeStart = () => {
      assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护或退出操作尚未结束');
      assert(plain(request) && plain(request.stamp), 'Invalid advanced task source identity');
      workspaceDocuments.assertRuntimeOwner(window.webContents.id, request.stamp.documentId);
      if (channel === 'aiss' && Array.isArray(request.sources)) for (const source of request.sources) workspaceDocuments.assertRuntimeOwner(window.webContents.id, source?.stamp?.documentId);
      };
    beforeStart(); await readCpuResources(); beforeStart();
    return host.start(window.webContents.id, request, sessionId, beforeStart);
  });
  handle(`command-${channel}`, (window, sessionId, command) => host.command(window.webContents.id, sessionId, command));
}
handle('read-xtb-electronic-artifacts', (window, artifactId) => xtbElectronicSources.read(window.webContents.id, artifactId));
handle('release-xtb-electronic-artifacts', (window, artifactId) => xtbElectronicSources.release(window.webContents.id, artifactId));
handle('orbital-backend-info', () => orbitalBackend.info());
handle('choose-orbital-backend', async window => {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 应用正在维护或关闭');
  const choice = await dialog.showOpenDialog(window, { title: '选择 Multiwfn 所在文件夹', properties: ['openDirectory'] });
  ownerWindow(window.webContents.id); assert(!quitting && !maintenanceBusy, 'APPLICATION_CLOSING: 应用正在关闭');
  if (choice.canceled || choice.filePaths.length !== 1) return orbitalBackend.info();
  const info=await orbitalBackend.select(choice.filePaths[0]);
  for(const target of windows.values())try{if(!target.isDestroyed()&&!target.webContents.isDestroyed())target.webContents.send('sciyue:multiwfn-configuration-changed',info);}catch{/* Closing subscribers do not invalidate a published path. */}
  return info;
});
handle('open-orbital-session', (window, request) => {
  assert(!maintenanceBusy, 'PORTABLE_BUSY: 请等待本机任务结束');
  return orbitals.open(window.webContents.id, request);
});
handle('open-xtb-orbital-session', async (window, artifactId, sessionId) => {
  const owner = window.webContents.id;
  orbitalSessionIdentity(sessionId);
  const current = () => { ownerWindow(owner); assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待本机任务结束'); };
  current();
  // Only the host-owned retained artifact supplies bytes and electronic state.
  // The renderer cannot replace its text, expected charge, or source digest.
  const bundle = await xtbElectronicSources.read(owner, artifactId); current();
  const source = bundle.files.find(file => file.role === 'molden'), info = bundle.metadata;
  assert(source && source.name === 'molden.input' && info.engine === 'xtb' && info.method === 'gfn2' && info.calculation === 'singlepoint' && info.converged === true && info.periodic === undefined, 'Invalid managed GFN2 orbital source');
  assert(Number.isSafeInteger(info.charge) && Number.isSafeInteger(info.uhf) && info.uhf >= 0 && Array.isArray(info.orderedAtoms) && info.orderedAtoms.length > 0, 'Invalid managed GFN2 electronic state');
  let opened = false;
  try {
    const metadata = await orbitals.open(owner, { sessionId, sourceId: `xtb-${bundle.artifactId}:molden`, name: source.name, text: source.text }); opened = true; current();
    const binding = await orbitals.bindTrustedSourceExpectation(owner, sessionId, { kind: 'generated-gfn2-sp', artifactId: bundle.artifactId, sourceSha256: source.sha256, charge: info.charge, uhf: info.uhf, atomElements: info.orderedAtoms.map(atom => atom.element) });
    assert(binding.metadata.sourceId === metadata.sourceId && binding.metadata.sourceRevision === metadata.sourceRevision, 'Managed analysis binding changed the source identity');
    current(); return binding.metadata;
  } catch (error) {
    if (opened) await orbitals.command(owner, sessionId, { operation: 'close' }).catch(() => {});
    throw error;
  }
});
handle('plan-orbital-session', (window, sessionId, request) => { assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束'); return orbitals.plan(window.webContents.id, sessionId, request); });
handle('fork-orbital-session', (window, parentSessionId, instanceId) => { assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束'); return orbitals.forkSession(window.webContents.id, parentSessionId, instanceId); });
handle('close-orbital-session', (window, sessionId) => orbitals.command(window.webContents.id, sessionId, {operation:'close'}));
handle('orbital-resource-info', window => orbitals.resources(window.webContents.id));
handle('reserve-orbital-views', (window, sessionId, viewCount) => { assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束'); return orbitals.reserveViews(window.webContents.id, sessionId, viewCount); });
handle('command-orbitals', (window, sessionId, request, progressIdentity) => { assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束'); return orbitals.command(window.webContents.id, sessionId, request, progressIdentity); });
handle('read-orbital-field', (window, sessionId, key) => orbitals.field(window.webContents.id, sessionId, key));
handle('export-orbital-cube', (window, sessionId, key) => orbitals.cube(window.webContents.id, sessionId, key));
handle('analyze-wavefunction', (window, sessionId, request, progressIdentity) => { assert(!maintenanceBusy, 'PORTABLE_BUSY: 维护操作尚未结束'); return orbitals.analyze(window.webContents.id, sessionId, request, progressIdentity); });
handle('cancel-wavefunction-analysis', (window, sessionId) => orbitals.cancelAnalysis(window.webContents.id, sessionId));

function assertSurfaceOperation(owner, request) {
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 维护或退出操作尚未结束'); ownerWindow(owner);
  assert(plain(request) && plain(request.stamp), 'Invalid surface request stamp');
  if (request.stamp.documentId !== undefined) workspaceDocuments.assertRuntimeOwner(owner, request.stamp.documentId);
}
handle('surface-capabilities', (window, sessionId) => surfaces().capabilities(window.webContents.id, sessionId));
handle('open-surface-session', async (window, request) => {
  const owner = window.webContents.id; assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待本机任务结束');
  if (request?.source?.context?.documentId !== undefined) workspaceDocuments.assertRuntimeOwner(owner, request.source.context.documentId);
  const trusted = await surfaceSources.open(owner, request);
  try { ownerWindow(owner); const result = await surfaces().open(owner, trusted); ownerWindow(owner); return result; }
  catch (error) { await surfaceService?.closeSession(owner, request.sessionId); await surfaceSources.closeSession(owner, request.sessionId); throw error; }
});
handle('open-hirshfeld-session', async (window, request) => {
  const owner = window.webContents.id;
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待本机任务结束');
  assert(plain(request) && Object.keys(request).every(key => ['sessionId', 'source', 'resources'].includes(key)) && plain(request.source) && request.source.kind === 'hirshfeld-cluster', 'Invalid Hirshfeld cluster source');
  if (request.source.context?.documentId !== undefined) workspaceDocuments.assertRuntimeOwner(owner, request.source.context.documentId);
  let opened = false;
  try { const result = await surfaces().open(owner, { ...request.source, sessionId: request.sessionId }, request.resources); opened = true; ownerWindow(owner); return result; }
  catch (error) { if (opened) await surfaceService?.closeSession(owner, request.sessionId); throw error; }
});
for (const [channel, operation] of [['analyze-hirshfeld', 'hirshfeldAnalyze'], ['restore-hirshfeld-fields', 'hirshfeldRestore']]) handle(channel, (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); return surfaces()[operation](window.webContents.id, sessionId, request); });
for (const [channel, operation] of [['analyze-surface', 'analyze'], ['surface-region', 'region'], ['generate-surface', 'generate'], ['surface-distribution', 'distribution']]) handle(channel, (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); return surfaces()[operation](window.webContents.id, sessionId, request); });
handle('surface-restore-fields', (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); assert(string(request.generationId, 256), 'Invalid generated surface artifact identity'); return surfaces().restoreFields(window.webContents.id, sessionId, request); });
handle('cancel-surface', async (window, sessionId) => { await surfaces().cancel(window.webContents.id, sessionId); return { cancelled: true }; });
handle('close-surface-session', async (window, sessionId) => { await surfaces().closeSession(window.webContents.id, sessionId); await surfaceSources.closeSession(window.webContents.id, sessionId); return { closed: true }; });
handle('open-interaction-session', async (window, request) => {
  const owner = window.webContents.id;
  assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待本机任务结束');
  assert(plain(request) && plain(request.source) && ['wavefunction', 'structure'].includes(request.source.kind), 'Invalid interaction source');
  if (request.source.context?.documentId !== undefined) workspaceDocuments.assertRuntimeOwner(owner, request.source.context.documentId);
  const trusted = request.source.kind === 'wavefunction'
    ? await interactionSources.open(owner, request)
    : { sessionId: request.sessionId, kind: 'structure', structure: request.source.structure, context: request.source.context };
  let opened = false;
  try { ownerWindow(owner); const result = await interactions().open(owner, trusted); opened = true; ownerWindow(owner); return result; }
  catch (error) {
    // A rejected duplicate open must never close the pre-existing session.
    if (opened) await interactionService?.closeSession(owner, request.sessionId);
    if (request.source.kind === 'wavefunction') await interactionSources.closeSession(owner, request.sessionId);
    throw error;
  }
});
for (const [channel, operation] of [['generate-interaction', 'generate'], ['interaction-contributions', 'contributions'], ['restore-interaction-fields', 'restoreFields']]) handle(channel, (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); return interactions()[operation](window.webContents.id, sessionId, request); });
handle('cancel-interaction', (window, sessionId) => interactions().cancel(window.webContents.id, sessionId));
handle('close-interaction-session', async (window, sessionId) => {
  const result = await interactions().closeSession(window.webContents.id, sessionId);
  await interactionSources.closeSession(window.webContents.id, sessionId); return result;
});
for (const family of ['excitation', 'reactivity']) {
  const sources = family === 'excitation' ? excitationSources : reactivitySources;
  handle('open-' + family + '-session', async (window, request) => {
    const owner = window.webContents.id;
    assert(!maintenanceBusy && !quitting, 'PORTABLE_BUSY: 请等待本机任务结束');
    assert(plain(request) && Object.keys(request).every(key => ['sessionId', 'source', ...(family === 'excitation' ? ['output'] : [])].includes(key)) && plain(request.source) && request.source.kind === 'wavefunction', 'Invalid electronic source request');
    const { orbitalRepresentation, orbitalRepresentationEvidence, ...source } = request.source;
    assert(family === 'reactivity' || orbitalRepresentation === undefined && orbitalRepresentationEvidence === undefined, 'Invalid excitation source metadata');
    if (orbitalRepresentation !== undefined) assert(['canonical', 'natural', 'localized', 'nto', 'unknown'].includes(orbitalRepresentation) && (orbitalRepresentationEvidence === undefined || string(orbitalRepresentationEvidence, 4096)), 'Invalid orbital representation evidence');
    if (source.context?.documentId !== undefined) workspaceDocuments.assertRuntimeOwner(owner, source.context.documentId);
    const trusted = await sources.open(owner, { sessionId: request.sessionId, source });
    let opened = false;
    try {
      ownerWindow(owner);
      const result = await electronicAnalyses().open(owner, { ...trusted, family, name: source.name, output: request.output, orbitalRepresentation, orbitalRepresentationEvidence });
      opened = true; ownerWindow(owner); return result;
    } catch (error) {
      // A rejected duplicate never acquires source ownership and cannot close
      // the earlier family/session. The host cleans any newly failed open.
      try { if (opened) await electronicService?.closeSession(owner, request.sessionId); }
      finally { await sources.closeSession(owner, request.sessionId); } throw error;
    }
  });
  const checked = (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); electronicAnalyses().assertFamily(window.webContents.id, sessionId, family); };
  handle(family === 'excitation' ? 'run-excitation' : 'analyze-reactivity', (window, sessionId, request) => { checked(window, sessionId, request); return electronicAnalyses().run(window.webContents.id, sessionId, request); });
  handle('cancel-' + family, (window, sessionId) => { electronicAnalyses().assertFamily(window.webContents.id, sessionId, family); return electronicAnalyses().cancel(window.webContents.id, sessionId); });
  handle('close-' + family + '-session', async (window, sessionId) => {
    const owner = window.webContents.id; electronicAnalyses().assertFamily(owner, sessionId, family, true);
    try { return await electronicAnalyses().closeSession(owner, sessionId); }
    finally { await sources.closeSession(owner, sessionId); }
  });
}
handle('restore-excitation-fields', (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); electronicAnalyses().assertFamily(window.webContents.id, sessionId, 'excitation'); return electronicAnalyses().restoreFields(window.webContents.id, sessionId, request); });
handle('export-excitation-cube', async (window, sessionId, request) => { assertSurfaceOperation(window.webContents.id, request); electronicAnalyses().assertFamily(window.webContents.id, sessionId, 'excitation'); const result = await saveSurfaceCube(window, await electronicAnalyses().exportCube(window.webContents.id, sessionId, request)); return { saved: !result.cancelled, ...result }; });
handle('release-surface-cube', (window, token) => surfaceSources.release(window.webContents.id, token));
handle('register-surface-cube', (window, request) => surfaceSources.register(window.webContents.id, request));
handle('read-registered-surface-cube', (window, token) => surfaceSources.read(window.webContents.id, token));
handle('import-surface-cube', async (window, selected) => {
  const owner = window.webContents.id;
  if (selected === undefined) {
    if (isolatedIO) { const config = await readTestDialogConfig(); selected = config.openFiles?.[0] ? await testPath(config.openFiles[0], true) : null; }
    else { const choice = await dialog.showOpenDialog(window, { title: '导入 Cube', properties: ['openFile'], filters: [{ name: 'Cube', extensions: ['cube', 'cub'] }] }); selected = choice.canceled ? null : choice.filePaths[0]; }
  }
  ownerWindow(owner); if (!selected) return null;
  assert(string(selected, 4096) && path.isAbsolute(selected) && /\.(cube|cub)$/i.test(selected), 'Invalid selected Cube path');
  const file = await readChecked(selected, Number.MAX_SAFE_INTEGER); ownerWindow(owner);
  const text = file.bytes.toString('utf8'); assert(Buffer.from(text, 'utf8').equals(file.bytes), 'Cube source must be UTF-8');
  const sidecar = await currentFile(selected + '.sciyue-domain.json', fs, Number.MAX_SAFE_INTEGER);
  if (sidecar) await surfaceSources.rememberDomain(text, sidecar.bytes.toString('utf8'));
  ownerWindow(owner); return surfaceSources.register(owner, { name: path.basename(selected), text }, selected);
});
async function saveSurfaceCube(window, payload) {
  const owner = window.webContents.id;
  assert(plain(payload) && string(payload.name, 256) && !/[\\/]/.test(payload.name) && typeof payload.text === 'string' && Buffer.byteLength(payload.text) <= Number.MAX_SAFE_INTEGER, 'Invalid completed Cube export');
  if (payload.domain) { assert(plain(payload.domain) && typeof payload.domain.text === 'string' && Buffer.byteLength(payload.domain.text) <= Number.MAX_SAFE_INTEGER, 'Invalid Cube domain export'); await surfaceSources.rememberDomain(payload.text, payload.domain.text); }
  let selected, confirmed;
  if (isolatedIO) { const config = await readTestDialogConfig(); if (!config.savePath) return { cancelled: true }; selected = await testPath(config.savePath, false); confirmed = config.confirmOverwrite === true; }
  else { const choice = await dialog.showSaveDialog(window, { title: '导出 Cube', defaultPath: payload.name, filters: [{ name: 'Cube', extensions: ['cube'] }], properties: ['showOverwriteConfirmation'] }); if (choice.canceled || !choice.filePath) return { cancelled: true }; selected = choice.filePath; confirmed = true; }
  if (!path.extname(selected)) selected += '.cube';
  assert(/\.(cube|cub)$/i.test(selected), 'Cube export requires a .cube or .cub filename');
  const outputs = [{ path: selected, text: payload.text }, ...(payload.domain ? [{ path: selected + '.sciyue-domain.json', text: payload.domain.text }] : [])];
  for (const output of outputs) { ownerWindow(owner); assertUnmanagedDestination(output.path, exportRoots()); surfaceSources.assertExport(owner, output.path); output.parent = await directoryIdentity(path.dirname(output.path)); output.previous = await currentFile(output.path, fs, Number.MAX_SAFE_INTEGER); assert(!output.previous || confirmed, 'Existing export requires overwrite confirmation'); }
  if (outputs[1]?.previous && !isolatedIO) { const answer = await dialog.showMessageBox(window, { type: 'question', title: '替换 Cube 域记录', message: '同名的 Cube 域记录已存在，是否替换？', buttons: ['替换', '取消'], defaultId: 1, cancelId: 1 }); ownerWindow(owner); if (answer.response !== 0) return { cancelled: true }; }
  ownerWindow(owner); assert(!quitting, 'Application closing');
  let published = false;
  // After accepting the complete publication, renderer loss/quit must not
  // interrupt the second file. The global file-operation settle owns its life.
  try { for (const output of [...outputs].reverse()) { assertUnmanagedDestination(output.path, exportRoots()); surfaceSources.assertExport(owner, output.path); await atomicWrite(output.path, Buffer.from(output.text, 'utf8'), output.previous, output.parent, fs, Number.MAX_SAFE_INTEGER); published = true; } }
  catch (error) { if (published) { error.publicationPerformed = true; error.message = 'Cube/域记录保存未全部确认，请核对目标文件；' + error.message; } throw error; }
  return { cancelled: false, path: selected, ...(payload.domain ? { domainPath: outputs[1].path } : {}) };
}
handle('export-surface-cube', async (window, sessionId, request) => saveSurfaceCube(window, await surfaces().exportCube(window.webContents.id, sessionId, request)));
handle('export-hirshfeld-cube', async (window, sessionId, request) => {
  assertSurfaceOperation(window.webContents.id, request);
  const result = await saveSurfaceCube(window, await surfaces().hirshfeldExport(window.webContents.id, sessionId, request));
  return { saved: !result.cancelled, cancelled: result.cancelled };
});
handle('export-interaction-cube', async (window, sessionId, request) => {
  assertSurfaceOperation(window.webContents.id, request);
  const result = await saveSurfaceCube(window, await interactions().exportCube(window.webContents.id, sessionId, request));
  return { saved: !result.cancelled, cancelled: result.cancelled };
});
handle('export-registered-surface-cube', async (window, request) => saveSurfaceCube(window, await surfaceSources.exportRegistered(window.webContents.id, request)));

if (ownsProfile) app.whenReady().then(async () => {
  await taskCache.ready();
  await cleanRenderCaches(app.getPath('sessionData'),entry=>console.info('TASK_CACHE',JSON.stringify(entry)));
  if (!development) {
    const distRoot = await fs.realpath(path.join(appPath, 'dist'));
    protocol.handle('app', async request => {
      try {
        const url = new URL(request.url); assert(allowedURL(request.url, false));
        const decoded = decodeURIComponent(url.pathname);
        assert(!decoded.includes('\0') && !decoded.includes('\\'));
        const asset = path.resolve(distRoot, `.${decoded === '/' ? '/index.html' : decoded}`);
        assert(within(distRoot, asset));
        const actual = await fs.realpath(asset); assert(within(distRoot, actual));
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' };
        const headers = new Headers({ 'Content-Type': types[path.extname(actual)] || 'application/octet-stream' });
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'");
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(await fs.readFile(actual), { status: 200, headers });
      } catch { return new Response('Asset unavailable', { status: 404 }); }
    });
  }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = allowedURL(details.url, development) || details.url.startsWith('blob:') || details.url.startsWith('data:');
    if (development && details.url.startsWith('ws://127.0.0.1:4181/')) allowed = true;
    callback({ cancel: !allowed });
  });
  const initialWindow = createModelWindow();
  hostWindowsReady = true;
  await mcpLiveHost.start().catch(error => console.warn('MCP_LIVE_HOST_START_FAILED', error.message));
  const initialLaunch = readLaunchRequest(process.argv, process.cwd?.() || appPath);
  if (initialLaunch.paths.length || initialLaunch.error) enqueueLaunch(initialWindow, initialLaunch);
  logEvent('info', 'PORTABLE_HOST_READY');
  // Electron always exposes Menu; older instance-private unit fixtures may omit it.
  if (Menu) workbenchMenu = installWorkbenchMenu({ Menu, MenuItem, BrowserWindow, windows, development, requestProjectAction, requestFileAction: requestWorkbenchFileAction, requestCitations, canFileAction: canWorkbenchFileAction, requestQuit: () => windowClosePolicy.requestQuit(), isClosing: () => quitting });
  while (pendingModelWindows > 0) { pendingModelWindows--; createModelWindow(); }
  for (const request of pendingFileLaunches.splice(0)) enqueueLaunch(createModelWindow(), request);
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
let quitFinalized = false, closingTask = null;
app.on('before-quit', event => {
  if (forcingExit) { event?.preventDefault?.(); return; }
  if (quitFinalized) return;
  if (!windowClosePolicy.isQuitApproved()) { event?.preventDefault?.(); windowClosePolicy.requestQuit(); return; }
  event?.preventDefault?.(); if (closingTask) return;
  quitting = true; void mcpLiveHost.dispose(); nativeProcesses.closeAdmission?.(); analysisWindows.dispose(); workspaceDocuments.dispose(); clearInterval(expireFileStreams);
  refreshNativeMenu(); windowClosePolicy.beginShutdown();
  for (const controller of runtimeChecks.values()) controller.abort();
  conformerBatchDisposal=conformerBatch.dispose();void conformerBatchDisposal.catch(()=>{});
  nativeCapabilities.dispose(); multiwfnScheduler.dispose(); dynamics.dispose(); xtb.dispose(); advancedPath.dispose(); conformerSampling.dispose(); ocr.dispose(); aiss.dispose(); orbitals.dispose(); empiricalChemistry.dispose(); crystalModeling.dispose(); surfaceService?.dispose(); interactionService?.dispose(); electronicService?.dispose(); for (const job of jobs.values()) job.abort('CHEMISTRY_CANCELLED: 应用退出');
  closingTask = (async () => {
    const graceful = () => { assert(!forcingExit, 'APPLICATION_FORCE_EXIT: unfinished source and storage material retained'); };
    // Independent drains start together. A failed component still joins every
    // other component; source reclamation below retains its producer gate.
    const settleGroup = entries => Promise.allSettled(entries.map(([, settle]) => Promise.resolve().then(() => { graceful(); return settle(); }))).then(results => {
      for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') {
        const code = `PORTABLE_${entries[index][0]}_CLOSE_FAILED`; logEvent('warning', code); console.warn(code);
      }
      return results;
    });
    const settleOwnerCloses = async tasks => {
      const results = await Promise.allSettled([...tasks]);
      assert(results.every(result => result.status === 'fulfilled'), 'OWNER_SOURCE_CLOSE_UNCONFIRMED');
    };
    const hostEntries = [
      ['ORBITAL', () => orbitals.settle()], ['XTB', () => xtb.settle()], ['ADVANCED_PATH', () => advancedPath.settle()],
      ['CONFORMER_BATCH', () => conformerBatchDisposal??conformerBatch.settle()],
      ['SAMPLING', () => conformerSampling.settle()], ['OCR', () => ocr.settle()], ['AISS', () => aiss.settle()], ['EMPIRICAL', () => empiricalChemistry.settle()],
      ['CRYSTAL', () => crystalModeling.settle()], ['CAPABILITY', () => nativeCapabilities.settle()],
      ['SURFACE', () => surfaceService?.settle()], ['INTERACTION', () => interactionService?.settle()], ['ELECTRONIC', () => electronicService?.settle()],
      ['MULTIWFN', () => multiwfnScheduler.whenIdle()], ['XTB_OWNER', () => settleOwnerCloses(xtbSourceCloseTasks)], ['SURFACE_OWNER', () => settleOwnerCloses(surfaceCloseTasks)],
    ];
    windowClosePolicy.shutdownPhase('native-and-storage');
    const childrenSettled = (async () => {
      if (!await nativeProcesses.waitClosed(6000)) { logEvent('warning', 'PORTABLE_NATIVE_CLOSE_PENDING'); await nativeProcesses.whenClosed(); }
      graceful();
      return true;
    })();
    // Some hosts enqueue final source/job cleanup from their child's close
    // callback. Begin their drains after that callback, while writes can still
    // settle independently, so an initially empty cleanup set is not mistaken
    // for completion.
    const hostsSettled = childrenSettled.then(() => settleGroup(hostEntries));
    let timeout;
    const storageSettled = Promise.allSettled([
      () => closeCpuResources(), () => fileReader.dispose(), async () => { await taskSystem.dispose(); await launchImports.dispose(); }, () => portableServices?.settle(), () => personalFragments.settle(), () => workbenchPreferences.settle(), () => modelDisplayPreferences.settle(), () => surfaceDisplayPreferences.settle(), () => modelHoldKeyPreferences.settle(), () => computeResources.settle(), () => firstRunLicense.settle(), () => Promise.allSettled([...pendingFileOperations]),
    ].map(settle => Promise.resolve().then(settle)));
    let storageResults = await Promise.race([
      storageSettled,
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 6000); }),
    ]); clearTimeout(timeout);
    // A warning deadline must never terminate an in-flight user file write.
    // No new IPC can enter while quitting. Finish on actual settled handles.
    if (!storageResults) { logEvent('warning', 'PORTABLE_SAVE_CLOSE_PENDING'); storageResults = await storageSettled; }
    graceful();
    portableServices?.dispose(); advancedOutputs.dispose(); personalFragments.dispose(); workbenchPreferences.dispose(); modelDisplayPreferences.dispose(); surfaceDisplayPreferences.dispose(); runtimeModelDisplay.dispose(); modelHoldKeyPreferences.dispose(); computeResources.dispose(); firstRunLicense.dispose();
    const storageClosed = storageResults.every(result => result.status === 'fulfilled');
    const [childrenClosed, hostResults] = await Promise.all([childrenSettled, hostsSettled]);
    graceful(); windowClosePolicy.shutdownPhase('source-cleanup');
    const hostClosed = name => hostResults[hostEntries.findIndex(([key]) => key === name)].status === 'fulfilled';
    const disposeSource = (producer, dispose) => () => {
      assert(childrenClosed && hostClosed(producer), 'SOURCE_CLOSE_PRODUCER_UNCONFIRMED'); return dispose();
    };
    const sourceResults = await settleGroup([
      ['XTB_SOURCE', disposeSource('XTB', () => xtbElectronicSources.dispose())],
      ['SURFACE_SOURCE', disposeSource('SURFACE', () => surfaceSources.dispose())],
      ['INTERACTION_SOURCE', disposeSource('INTERACTION', () => interactionSources.dispose())],
      ['EXCITATION_SOURCE', disposeSource('ELECTRONIC', () => excitationSources.dispose())],
      ['REACTIVITY_SOURCE', disposeSource('ELECTRONIC', () => reactivitySources.dispose())],
    ]);
    graceful();
    const resourcesClosed = [...hostResults, ...sourceResults].every(result => result.status === 'fulfilled');
    let cacheClosed = false, taskCacheClosed = false;
    if(storageClosed && childrenClosed && fileOperations === 0) {
      windowClosePolicy.shutdownPhase('task-cache-cleanup');
      // A retained source/failed producer must not be erased by root cleanup.
      // Render caches still drain if task cleanup fails. Keep window destroy
      // after task cleanup so closed-owner callbacks cannot race its manifest.
      const taskCacheResults = await settleGroup([
        ['TASK_CACHE', () => { assert(resourcesClosed, 'TASK_CACHE_RESOURCES_UNCONFIRMED'); return taskCache.finish(); }],
      ]);
      taskCacheClosed = taskCacheResults.every(result => result.status === 'fulfilled');
      graceful(); windowClosePolicy.shutdownPhase('render-cache-cleanup');
      const renderCacheResults = await settleGroup([
        ['RENDER_CACHE', async () => {
          // Writers are settled and quit has been approved. Release owned
          // renderers before reclaiming GPU/code cache, never browser storage.
          for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.destroy();
          // A duplicate launcher owns its task directory, never the running
          // primary's shared Chromium session.
          if(!ownsProfile)return;
          await session.defaultSession.clearCache();
          graceful();
          await session.defaultSession.clearCodeCaches({urls:[]});
          graceful();
          const cleaned = await cleanRenderCaches(app.getPath('sessionData'),entry=>console.info('TASK_CACHE',JSON.stringify(entry)));
          assert(!cleaned?.retained?.length, 'RENDER_CACHE_CLOSE_INCOMPLETE');
        }],
      ]);
      cacheClosed = [...taskCacheResults, ...renderCacheResults].every(result => result.status === 'fulfilled');
    }
    graceful();
    // Never label an interrupted/unknown writer as a reclaimable closed run.
    if (portableProfile && storageClosed && childrenClosed && resourcesClosed && taskCacheClosed && fileOperations === 0) {
      if(ownsProfile&&postExitCleanup){
        if(postExitCleanup.available){await postExitCleanup.defer();logEvent('info','PORTABLE_RENDER_CACHE_POST_EXIT_DEFERRED');}
        else logEvent('warning','PORTABLE_RENDER_CACHE_POST_EXIT_UNAVAILABLE');
      }else if(cacheClosed)await finishPortableRun(portableProfile);
      else logEvent('warning','PORTABLE_RUN_CLOSE_UNCONFIRMED');
    }
    else logEvent('warning', 'PORTABLE_RUN_CLOSE_UNCONFIRMED');
    windowClosePolicy.shutdownPhase('final-log');
    await closeDiagnostics.flush(); await portableLog?.flush(); await portableLog?.close();
  })().catch(error => { console.error('PORTABLE_RUN_CLOSE_UNCONFIRMED'); if (!forcingExit) void closeDiagnostics.record('cleanup-failed', { error: error.message, stack: error.stack }); }).finally(() => { if (!forcingExit) { windowClosePolicy.finishShutdown(); quitFinalized = true; app.quit(); } });
});
