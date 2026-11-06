'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
// BEGIN GENERATED MANAGED RESULT HYDRATOR
const {hydrateManagedResult}=(()=>{
'use strict';
const MARKER = '__esManagedResult';
const typedConstructors = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
function check(condition, message) { if (!condition) throw new Error(message); }
function descriptor(value) { return value && typeof value === 'object' && value[MARKER] === 'v1'; }
function aborted(signal) { if (signal?.aborted) { const error = new Error('Managed-result transfer cancelled'); error.name = 'AbortError'; throw error; } }

/** invoke(request) is bound to the already-authorized sender by the preload.
 * All references found, including unread siblings, are released on failure. */
async function hydrateManagedResult(value, invoke, { signal } = {}) {
  check(typeof invoke === 'function', 'Managed-result invoke required');
  const tokens = new Set(), released = new Set(), seen = new WeakSet(), managed = new WeakSet();
  function collect(node) {
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node)) return false;
    if (seen.has(node)) return managed.has(node);
    seen.add(node);
    if (descriptor(node)) { check(typeof node.token === 'string', 'Invalid managed-result token'); tokens.add(node.token); managed.add(node); return true; }
    let required = false;
    for (const entry of Object.values(node)) if (collect(entry)) required = true;
    if (required) managed.add(node);
    return required;
  }
  async function release(token) { if (!released.has(token)) { await invoke({ action: 'release', token }); released.add(token); } }
  async function hydrate(node) {
    aborted(signal);
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node) || !managed.has(node)) return node;
    if (!descriptor(node)) {
      let result = node;
      for (const [key, entry] of Object.entries(node)) {
        const hydrated = entry && typeof entry === 'object' && managed.has(entry) ? await hydrate(entry) : entry;
        if (!Object.is(hydrated, entry)) {
          if (result === node) result = Array.isArray(node) ? node.slice() : Object.setPrototypeOf(Object.assign(Object.create(null), node), Object.getPrototypeOf(node));
          Object.defineProperty(result, key, { value: hydrated, enumerable: true, configurable: true, writable: true });
        }
      }
      return result;
    }
    const { token, kind, length } = node;
    check(Number.isSafeInteger(length) && length >= 0 && ['array', 'typed', 'string', 'object'].includes(kind), 'Invalid managed-result descriptor');
    let result, bytes;
    if (kind === 'typed') {
      const Constructor = typedConstructors[node.type]; check(Constructor, 'Invalid managed-result typed array');
      bytes = new Uint8Array(length); result = node.type === 'DataView' ? new DataView(bytes.buffer) : new Constructor(bytes.buffer);
    } else result = kind === 'array' ? new Array(length) : kind === 'string' ? [] : Object.create(node.nullPrototype ? null : Object.prototype);
    let start = 0, failure;
    try {
      while (start < length) {
        aborted(signal); const chunk = await invoke({ action: 'read', token, start }); collect(chunk); aborted(signal);
        check(chunk && Number.isSafeInteger(chunk.next) && chunk.next > start && chunk.next <= length && chunk.done === (chunk.next === length), 'Invalid managed-result chunk progress');
        if (kind === 'typed') { check(chunk.bytes instanceof Uint8Array && chunk.bytes.length === chunk.next - start, 'Invalid managed-result byte chunk'); bytes.set(chunk.bytes, start); }
        else if (kind === 'string') { check(typeof chunk.text === 'string' && chunk.text.length === chunk.next - start, 'Invalid managed-result text chunk'); result.push(chunk.text); }
        else {
          check(Array.isArray(chunk.items) && chunk.items.length === chunk.next - start, 'Invalid managed-result item chunk');
          for (let index = 0; index < chunk.items.length; index++) {
            const entry = chunk.items[index];
            if (kind === 'array') { if (!chunk.holes?.includes(index)) result[start + index] = entry && typeof entry === 'object' && managed.has(entry) ? await hydrate(entry) : entry; }
            else {
              check(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string', 'Invalid managed-result object entry');
              const hydrated = entry[1] && typeof entry[1] === 'object' && managed.has(entry[1]) ? await hydrate(entry[1]) : entry[1];
              Object.defineProperty(result, entry[0], { value: hydrated, enumerable: true, configurable: true, writable: true });
            }
          }
        }
        start = chunk.next;
      }
      return kind === 'string' ? result.join('') : result;
    } catch (error) { failure = error; throw error; }
    // eslint-disable-next-line no-unsafe-finally -- Preserve the hydration error; a sole release failure cannot report success.
    finally { try { await release(token); } catch (error) { if (!failure) throw error; } }
  }
  let primaryFailure;
  try { collect(value); return await hydrate(value); }
  catch (error) { primaryFailure = error; throw error; }
  finally {
    let cleanupFailure;
    for (const token of tokens) try { await release(token); } catch (error) { cleanupFailure ??= error; }
    // eslint-disable-next-line no-unsafe-finally -- Preserve cancellation/read failure; a sole release failure must not be reported as success.
    if (!primaryFailure && cleanupFailure) throw cleanupFailure;
  }
}
return { hydrateManagedResult };
})();
// END GENERATED MANAGED RESULT HYDRATOR
const invoke=async(channel,...args)=>hydrateManagedResult(await ipcRenderer.invoke(channel,...args),request=>ipcRenderer.invoke('sciyue:managed-result-transfer',request));
// No generic IPC channel, filesystem, shell, process object, or event object crosses the bridge.
// about:blank inherits opener preferences in Chromium. It is a UI-only portal
// surface: do not expose a second desktop bridge in that child document.
if (typeof location === 'undefined' || location.href !== 'about:blank') contextBridge.exposeInMainWorld('sciyueDesktop', Object.freeze({
  taskSystemRequest:request=>invoke('sciyue:task-system-request',request),
  cancelTaskSystemRequest:requestId=>invoke('sciyue:task-system-cancel',requestId),
  syProject: request => invoke('sciyue:sy-project', request),
  citationRuntimeInfo: () => invoke('sciyue:citation-runtime-info'),
  exportCitations: request => invoke('sciyue:export-citations', request),
  onCitationsOpen: listener => {
    if(typeof listener!=='function')throw new TypeError('Citation listener must be a function');
    const receive=(_event,request)=>{if(request&&typeof request==='object'&&(request.documentId===undefined||typeof request.documentId==='string'))listener(request.documentId===undefined?{}:{documentId:request.documentId});};
    ipcRenderer.on('sciyue:citations-open',receive);return()=>ipcRenderer.removeListener('sciyue:citations-open',receive);
  },
  requestProjectAction:action=>invoke('sciyue:request-project-action',action),
  onProjectAction:listener=>{const receive=(_event,action)=>listener(action);ipcRenderer.on('sciyue:project-action',receive);return()=>ipcRenderer.removeListener('sciyue:project-action',receive);},
  updateWorkbenchFileState: state => invoke('sciyue:update-workbench-file-state', state),
  onWorkbenchFileAction: listener => {
    if (typeof listener !== 'function') throw new TypeError('File action listener must be a function');
    const receive = (_event, request) => { if (request && ['import', 'export-structure', 'export-image'].includes(request.action) && (request.documentId === undefined || typeof request.documentId === 'string')) listener({ action: request.action, ...(request.documentId === undefined ? {} : { documentId: request.documentId }) }); };
    ipcRenderer.on('sciyue:workbench-file-action', receive);
    return () => ipcRenderer.removeListener('sciyue:workbench-file-action', receive);
  },
  readProjectWindowPlacements:()=>invoke('sciyue:read-project-window-placements'),
  restoreProjectWindowPlacement:bounds=>invoke('sciyue:restore-project-window-placement',bounds),
  describeExcitationProjectCompanions: id=>invoke('sciyue:describe-excitation-project-companions',id),
  readExcitationProjectCompanion: (id,role,start,end)=>invoke('sciyue:read-excitation-project-companion',id,role,start,end),
  releaseExcitationProjectCompanions: id=>invoke('sciyue:release-excitation-project-companions',id),
  beginProjectCompanionBundle: request=>invoke('sciyue:begin-project-companion-bundle',request),
  appendProjectCompanionBundle: (id,role,start,bytes)=>invoke('sciyue:append-project-companion-bundle',id,role,start,bytes),
  commitProjectCompanionBundle: id=>invoke('sciyue:commit-project-companion-bundle',id),
  abortProjectCompanionBundle: id=>invoke('sciyue:abort-project-companion-bundle',id),
  closeProjectCompanionBundle: id=>invoke('sciyue:close-project-companion-bundle',id),
  info: () => invoke('sciyue:info'),
  ocrCapabilities: () => invoke('sciyue:ocr-capabilities'),
  ocrChooseComponent: () => invoke('sciyue:ocr-choose-component'),
  ocrRecognize: request => invoke('sciyue:ocr-recognize',request),
  ocrCancel: requestId => invoke('sciyue:ocr-cancel',requestId),
  portableTools: request => invoke('sciyue:portable-tools', request),
  readPersonalFragments: () => invoke('sciyue:read-personal-fragments'),
  updatePersonalFragments: request => invoke('sciyue:update-personal-fragments', request),
  importPersonalFragments: () => invoke('sciyue:import-personal-fragments'),
  exportPersonalFragments: library => invoke('sciyue:export-personal-fragments', library),
  openModelWindow: request => invoke('sciyue:open-model-window', request),
  prepareAnalysisWindow: request => invoke('sciyue:prepare-analysis-window', request),
  releaseAnalysisWindow: request => invoke('sciyue:release-analysis-window', request),
  onAnalysisWindowEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Analysis window listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:analysis-window-event', listener);
    return () => ipcRenderer.removeListener('sciyue:analysis-window-event', listener);
  },
  workspaceWindowGeometry: () => invoke('sciyue:workspace-window-geometry'),
  detachWorkspaceDocument: request => invoke('sciyue:detach-workspace-document', request),
  dockWorkspaceDocument: request => invoke('sciyue:dock-workspace-document', request),
  activateWorkspaceDocument: request => invoke('sciyue:activate-workspace-document', request),
  requestWorkspaceDocumentClose: request => invoke('sciyue:request-workspace-document-close', request),
  confirmWorkspaceDocumentClose: request => invoke('sciyue:confirm-workspace-document-close', request),
  confirmWorkspaceScientificEdit: request => invoke('sciyue:confirm-workspace-scientific-edit', request),
  replyWorkspaceDocumentClose: request => invoke('sciyue:reply-workspace-document-close', request),
  registerWorkspaceDocument: request => invoke('sciyue:register-workspace-document', request),
  readWorkspaceDocuments: () => invoke('sciyue:read-workspace-documents'),
  publishWorkspaceDocument: request => invoke('sciyue:publish-workspace-document', request),
  commandWorkspaceDocument: request => invoke('sciyue:command-workspace-document', request),
  replyWorkspaceDocumentCommand: request => invoke('sciyue:reply-workspace-document-command', request),
  leaveWorkspaceDocument: request => invoke('sciyue:leave-workspace-document', request),
  closeWorkspaceDocument: request => invoke('sciyue:close-workspace-document', request),
  restoreWorkspaceOwner: request => invoke('sciyue:restore-workspace-owner', request),
  onWorkspaceDocumentEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Workspace listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:workspace-document-event', listener);
    return () => ipcRenderer.removeListener('sciyue:workspace-document-event', listener);
  },
  onWorkbenchLayoutOpen: callback => {
    if (typeof callback !== 'function') throw new TypeError('Workbench Layout listener must be a function');
    const listener = () => callback();
    ipcRenderer.on('sciyue:workbench-layout-open', listener);
    return () => ipcRenderer.removeListener('sciyue:workbench-layout-open', listener);
  },
  onGlobalSettingsOpen: callback => {
    if (typeof callback !== 'function') throw new TypeError('Global settings listener must be a function');
    const listener = () => callback();
    ipcRenderer.on('sciyue:global-settings-open', listener);
    return () => ipcRenderer.removeListener('sciyue:global-settings-open', listener);
  },
  onMultiwfnConfigurationChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Multiwfn configuration listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:multiwfn-configuration-changed', listener);
    return () => ipcRenderer.removeListener('sciyue:multiwfn-configuration-changed', listener);
  },
  readWorkbenchPreferences: () => invoke('sciyue:read-workbench-preferences'),
  writeWorkbenchPreferences: preferences => invoke('sciyue:write-workbench-preferences', preferences),
  readWorkbenchPreferenceSnapshot: () => invoke('sciyue:read-workbench-preference-snapshot'),
  writeWorkbenchPreferenceSnapshot: request => invoke('sciyue:write-workbench-preference-snapshot', request),
  readModelDisplayPreferences: () => invoke('sciyue:read-model-display-preferences'),
  readSurfaceDisplayPreferences: () => invoke('sciyue:read-surface-display-preferences'),
  readComputeResources: () => invoke('sciyue:read-compute-resources'),
  readFirstRunLicense: () => invoke('sciyue:read-first-run-license'),
  acknowledgeFirstRunLicense: request => invoke('sciyue:acknowledge-first-run-license', request),
  writeComputeResources: request => invoke('sciyue:write-compute-resources', request),
  onComputeResourcesChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Compute resource listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:compute-resources-changed', listener);
    return () => ipcRenderer.removeListener('sciyue:compute-resources-changed', listener);
  },
  readRuntimeModelDisplay: () => invoke('sciyue:read-runtime-model-display'),
  updateRuntimeModelDisplay: request => invoke('sciyue:update-runtime-model-display', request),
  onRuntimeModelDisplay: callback => {
    if (typeof callback !== 'function') throw new TypeError('Runtime display listener must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('sciyue:runtime-model-display', listener);
    return () => ipcRenderer.removeListener('sciyue:runtime-model-display', listener);
  },
  writeModelDisplayPreferences: request => invoke('sciyue:write-model-display-preferences', request),
  restoreModelDisplayPreferences: baseVersion => invoke('sciyue:restore-model-display-preferences', baseVersion),
  writeSurfaceDisplayPreferences: request => invoke('sciyue:write-surface-display-preferences', request),
  restoreSurfaceDisplayPreferences: request => invoke('sciyue:restore-surface-display-preferences', request),
  readModelHoldKeyPreferences: () => invoke('sciyue:read-model-hold-key-preferences'),
  writeModelHoldKeyPreferences: request => invoke('sciyue:write-model-hold-key-preferences', request),
  restoreModelHoldKeyPreferences: baseVersion => invoke('sciyue:restore-model-hold-key-preferences', baseVersion),
  onApplicationClosePreparation: callback => {
    if (typeof callback !== 'function') throw new TypeError('Close preparation listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:application-close-preparation', listener);
    return () => ipcRenderer.removeListener('sciyue:application-close-preparation', listener);
  },
  completeApplicationClosePreparation: response => invoke('sciyue:complete-application-close-preparation', response),
  readClipboard: () => invoke('sciyue:read-clipboard'),
  writeClipboard: payload => invoke('sciyue:write-clipboard', payload),
  writeClipboardText: text => invoke('sciyue:write-clipboard-text', text),
  acquireWorkerResources: request => invoke('sciyue:acquire-worker-resources', request),
  cancelWorkerResources: id => invoke('sciyue:cancel-worker-resources', id),
  releaseWorkerResources: id => invoke('sciyue:release-worker-resources', id),
  reportPreparedTrajectoryMemory: bytes => invoke('sciyue:report-prepared-trajectory-memory', bytes),
  beginBinaryExport: request => invoke('sciyue:begin-binary-export', request),
  appendBinaryExport: (token, bytes) => invoke('sciyue:append-binary-export', token, bytes),
  commitBinaryExport: token => invoke('sciyue:commit-binary-export', token),
  abortBinaryExport: token => invoke('sciyue:abort-binary-export', token),
  onModelClipboardChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Model clipboard listener must be a function');
    const listener = (_event, value) => {
      if (value && Number.isSafeInteger(value.version) && value.version > 0) callback({ version: value.version });
    };
    ipcRenderer.on('sciyue:model-clipboard-changed', listener);
    return () => ipcRenderer.removeListener('sciyue:model-clipboard-changed', listener);
  },
  openFiles: () => invoke('sciyue:open-files'),
  claimLaunchImport: () => invoke('sciyue:claim-launch-import'),
  finishLaunchImport: id => invoke('sciyue:finish-launch-import', id),
  readLaunchSource: (token, start, end) => invoke('sciyue:read-launch-source', token, start, end),
  describeLaunchSource: token => invoke('sciyue:describe-launch-source', token),
  closeLaunchSource: token => invoke('sciyue:close-launch-source', token),
  registerSelectedOutputSource: file => invoke('sciyue:register-selected-output-source', webUtils.getPathForFile(file)),
  onLaunchImportAvailable: callback => {
    if (typeof callback !== 'function') throw new TypeError('Launch import listener must be a function');
    const listener = () => callback();
    ipcRenderer.on('sciyue:launch-import-available', listener);
    return () => ipcRenderer.removeListener('sciyue:launch-import-available', listener);
  },
  pickReferenceFile: request => invoke('sciyue:pick-reference-file', request),
  getReferenceFilePath: file => webUtils.getPathForFile(file),
  readFileChunk: (token, offset) => invoke('sciyue:read-file-chunk', token, offset),
  closeFileStream: token => invoke('sciyue:close-file-stream', token),
  chooseSavePath: request => invoke('sciyue:choose-save-path', request),
  writeChosenFile: request => invoke('sciyue:write-chosen-file', request),
  runChemistry: (request, jobId) => invoke('sciyue:run-chemistry', request, jobId),
  cancelChemistry: jobId => invoke('sciyue:cancel-chemistry', jobId),
  surfaceCapabilities: sessionId => invoke('sciyue:surface-capabilities', sessionId),
  openSurfaceSession: request => invoke('sciyue:open-surface-session', request),
  openHirshfeldSession: request => invoke('sciyue:open-hirshfeld-session', request),
  analyzeHirshfeld: (sessionId, request) => invoke('sciyue:analyze-hirshfeld', sessionId, request),
  restoreHirshfeldFields: (sessionId, request) => invoke('sciyue:restore-hirshfeld-fields', sessionId, request),
  exportHirshfeldCube: (sessionId, request) => invoke('sciyue:export-hirshfeld-cube', sessionId, request),
  analyzeSurface: (sessionId, request) => invoke('sciyue:analyze-surface', sessionId, request),
  surfaceRegion: (sessionId, request) => invoke('sciyue:surface-region', sessionId, request),
  generateSurface: (sessionId, request) => invoke('sciyue:generate-surface', sessionId, request),
  surfaceRestoreFields: (sessionId, request) => invoke('sciyue:surface-restore-fields', sessionId, request),
  surfaceDistribution: (sessionId, request) => invoke('sciyue:surface-distribution', sessionId, request),
  cancelSurface: sessionId => invoke('sciyue:cancel-surface', sessionId),
  closeSurfaceSession: sessionId => invoke('sciyue:close-surface-session', sessionId),
  importSurfaceCube: file => invoke('sciyue:import-surface-cube', file === undefined ? undefined : webUtils.getPathForFile(file)),
  registerSurfaceCube: request => invoke('sciyue:register-surface-cube', request),
  readRegisteredSurfaceCube: token => invoke('sciyue:read-registered-surface-cube', token),
  releaseSurfaceCube: token => invoke('sciyue:release-surface-cube', token),
  exportSurfaceCube: (sessionId, request) => invoke('sciyue:export-surface-cube', sessionId, request),
  exportRegisteredSurfaceCube: request => invoke('sciyue:export-registered-surface-cube', request),
  onSurfaceEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Surface listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:surface-event', listener);
    return () => ipcRenderer.removeListener('sciyue:surface-event', listener);
  },
  orbitalBackendInfo: () => invoke('sciyue:orbital-backend-info'),
  openInteractionSession: request => invoke('sciyue:open-interaction-session', request),
  generateInteraction: (sessionId, request) => invoke('sciyue:generate-interaction', sessionId, request),
  interactionContributions: (sessionId, request) => invoke('sciyue:interaction-contributions', sessionId, request),
  restoreInteractionFields: (sessionId, request) => invoke('sciyue:restore-interaction-fields', sessionId, request),
  exportInteractionCube: (sessionId, request) => invoke('sciyue:export-interaction-cube', sessionId, request),
  cancelInteraction: sessionId => invoke('sciyue:cancel-interaction', sessionId),
  closeInteractionSession: sessionId => invoke('sciyue:close-interaction-session', sessionId),
  openExcitationSession: request => invoke('sciyue:open-excitation-session', request),
  runExcitation: (sessionId, request) => invoke('sciyue:run-excitation', sessionId, request),
  restoreExcitationFields: (sessionId, request) => invoke('sciyue:restore-excitation-fields', sessionId, request),
  exportExcitationCube: (sessionId, request) => invoke('sciyue:export-excitation-cube', sessionId, request),
  cancelExcitation: sessionId => invoke('sciyue:cancel-excitation', sessionId),
  closeExcitationSession: sessionId => invoke('sciyue:close-excitation-session', sessionId),
  openReactivitySession: request => invoke('sciyue:open-reactivity-session', request),
  analyzeReactivity: (sessionId, request) => invoke('sciyue:analyze-reactivity', sessionId, request),
  cancelReactivity: sessionId => invoke('sciyue:cancel-reactivity', sessionId),
  closeReactivitySession: sessionId => invoke('sciyue:close-reactivity-session', sessionId),
  onMultiwfnProgress: callback => {
    if (typeof callback !== 'function') throw new TypeError('Progress callback required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:multiwfn-progress', listener);
    return () => ipcRenderer.removeListener('sciyue:multiwfn-progress', listener);
  },
  chooseOrbitalBackend: () => invoke('sciyue:choose-orbital-backend'),
  analyzeWavefunction: (sessionId, request, progressIdentity) => invoke('sciyue:analyze-wavefunction', sessionId, request, progressIdentity),
  cancelWavefunctionAnalysis: sessionId => invoke('sciyue:cancel-wavefunction-analysis', sessionId),
  openOrbitalSession: request => invoke('sciyue:open-orbital-session', request),
  openXtbOrbitalSession: (artifactId, sessionId) => invoke('sciyue:open-xtb-orbital-session', artifactId, sessionId),
  forkOrbitalSession: (parentSessionId, instanceId) => invoke('sciyue:fork-orbital-session', parentSessionId, instanceId),
  closeOrbitalSession: sessionId => invoke('sciyue:close-orbital-session', sessionId),
  orbitalResourceInfo: () => invoke('sciyue:orbital-resource-info'),
  planOrbitalSession: (sessionId, request) => invoke('sciyue:plan-orbital-session', sessionId, request),
  reserveOrbitalViews: (sessionId, viewCount) => invoke('sciyue:reserve-orbital-views', sessionId, viewCount),
  commandOrbitals: (sessionId, request, progressIdentity) => invoke('sciyue:command-orbitals', sessionId, request, progressIdentity),
  readOrbitalField: (sessionId, key) => invoke('sciyue:read-orbital-field', sessionId, key),
  exportOrbitalCube: (sessionId, key) => invoke('sciyue:export-orbital-cube', sessionId, key),
  onOrbitalEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Orbital listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:orbital-event', listener);
    return () => ipcRenderer.removeListener('sciyue:orbital-event', listener);
  },
  startXtb: (request, sessionId) => invoke('sciyue:start-xtb', request, sessionId),
  releaseXtbOptimizationCaches: sessionIds => invoke('sciyue:release-xtb-optimization-caches', sessionIds),
  readXtbElectronicArtifacts: artifactId => invoke('sciyue:read-xtb-electronic-artifacts', artifactId),
  releaseXtbElectronicArtifacts: artifactId => invoke('sciyue:release-xtb-electronic-artifacts', artifactId),
  runCrystalModeling: request => invoke('sciyue:run-crystal-modeling', request),
  commandXtb: (sessionId, command) => invoke('sciyue:command-xtb', sessionId, command),
  onXtbEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('xTB listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:xtb-event', listener);
    return () => ipcRenderer.removeListener('sciyue:xtb-event', listener);
  },
  startDynamics: (request, sessionId) => invoke('sciyue:start-dynamics', request, sessionId),
  startAdvancedPath: (request, sessionId) => invoke('sciyue:start-advanced-path', request, sessionId),
  startAiss: (request, sessionId) => invoke('sciyue:start-aiss', request, sessionId),
  commandAiss: (sessionId, command) => invoke('sciyue:command-aiss', sessionId, command),
  onAissEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Docking listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:aiss-event', listener);
    return () => ipcRenderer.removeListener('sciyue:aiss-event', listener);
  },
  chooseAdvancedOutput: request => invoke('sciyue:choose-advanced-output', request),
  writeAdvancedOutput: token => invoke('sciyue:write-advanced-output', token),
  abandonAdvancedOutput: token => invoke('sciyue:abandon-advanced-output', token),
  commandAdvancedPath: (sessionId, command) => invoke('sciyue:command-advanced-path', sessionId, command),
  onAdvancedPathEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Advanced path listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:advanced-path-event', listener);
    return () => ipcRenderer.removeListener('sciyue:advanced-path-event', listener);
  },
  startConformerSampling: (request, sessionId) => invoke('sciyue:start-conformer-sampling', request, sessionId),
  readConformerSamplingResult: (id,offset,limit) => invoke('sciyue:read-conformer-sampling-result',id,offset,limit),
  releaseConformerSamplingResult: id => invoke('sciyue:release-conformer-sampling-result',id),
  conformerBatchCommand: (command,payload) => invoke('sciyue:conformer-batch-command',command,payload),
  onConformerBatchProgress: callback => {
    if(typeof callback!=='function')throw new TypeError('Conformer batch listener required');
    const listener=(_event,value)=>callback(value);ipcRenderer.on('sciyue:conformer-batch-progress',listener);
    return()=>ipcRenderer.removeListener('sciyue:conformer-batch-progress',listener);
  },
  commandConformerSampling: (sessionId, command) => invoke('sciyue:command-conformer-sampling', sessionId, command),
  onConformerSamplingEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Conformer sampling listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:conformer-sampling-event', listener);
    return () => ipcRenderer.removeListener('sciyue:conformer-sampling-event', listener);
  },
  commandDynamics: (sessionId, command) => invoke('sciyue:command-dynamics', sessionId, command),
  onDynamicsEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Dynamics listener must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sciyue:dynamics-event', listener);
    return () => ipcRenderer.removeListener('sciyue:dynamics-event', listener);
  },
}));
