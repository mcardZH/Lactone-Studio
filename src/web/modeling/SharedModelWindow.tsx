import {DismissibleNotice} from '../DismissibleNotice';
import { createRemoteHeldUndo } from './workspace-undo';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_DISPLAY, type ClipboardPayload, type DesktopBridge, type ModelCommand, type ModelDocument, type ModelSelection, type PickResult } from '../../modeling/contracts';
import type { WorkspaceDesktopBridge, WorkspaceDocumentSnapshot, WorkspaceMembership } from '../../modeling/workspace-contracts';
import { createWorkspaceReplica, normalizeWorkspaceJSON, isWorkspaceClosePendingError, WorkspaceClosePendingError, type WorkspaceBridgeState } from '../../modeling/platform/workspace-bridge';
import ModelViewport from './ModelViewport';
import type {ModelViewportProps} from './ModelViewport';
import {currentPreparedCipUsage,type CipViewportUsage} from './use-cip-usage';
import {createViewportDisplayConsumer,openViewportDisplayPort,type ViewportDisplayConsumer,type ProjectedDisplayProperties,type ReadonlyViewportDisplayDocument} from './viewport-display-channel';
import CanvasClearToolbar from './CanvasClearToolbar';
import ViewportImageExportMenu from './ViewportImageExportMenu';
import { exportViewportImage, exportBlob, type OffscreenCaptureSnapshot, type ViewportImageExportOptions } from '../results/export-image';
import { editableTarget, viewportCommand, workspaceSpacePressAllowed } from './workspace-actions';
import { createDetachedTabDrag, type DockTarget } from './detached-window-drag';
import { viewportJSON, type WorkspaceViewportEvent, type WorkspaceViewportState } from './workspace-viewport';
import type { ViewportStateMarker } from './viewport-overlays';
import './shared-model-window.css';
import { createViewportActivationPointerGate, viewportActivationTarget, type ViewportInteractionOwner } from './viewport-activation-pointer';
import { bindInterfaceFontDocument } from '../interface-font-preferences';
import TrajectoryControls from '../results/TrajectoryControls';
import {trajectoryControlCallbacks,trajectoryOverlayControlCallbacks,type TrajectoryPlaybackCommand} from '../results/trajectory-playback-bridge';
import {PlaybackOverlayControls} from '../MultiframeDisplayControls';
import {WorkspaceTabTitle,WorkspaceTabActions,WorkspaceTabCloseIcon} from './WorkspaceTab';
import {useTransientLayerScope} from '../TransientLayer';
import EnvironmentSettings from '../EnvironmentSettings';
import {subscribeGlobalSettings} from '../global-settings-events';

type Replica = ReturnType<typeof createWorkspaceReplica>;
type OptionalWindowBridge = WorkspaceDesktopBridge & Partial<Pick<DesktopBridge, 'writeClipboard' | 'openModelWindow'>>;
const editingTypes = new Set(['place-element', 'add-single-hydrogen', 'delete-objects', 'set-bond-order', 'transform-fragment']);
const noSubscribe = () => () => {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptyPick = (): PickResult => ({ kind: 'none', worldPoint: [0, 0, 0] });
/** A display snapshot from this window, never a request to the model owner or
 * a fallback to the hidden owner canvas. No runtime or Store is duplicated. */
export function detachedDisplayDocument(target:ModelDocument,projection?:ReadonlyViewportDisplayDocument):ModelDocument{
  if(!projection)return target;
  if(projection.document.id!==target.id||projection.document.revision!==target.revision)throw new Error('只读显示结构与当前认证容器不同步。');
  return projection.document;
}
export function detachedViewportImageSnapshot(document:ModelDocument,viewport:WorkspaceViewportState&Pick<ProjectedDisplayProperties,'displayDocument'>,cameraView:readonly number[],size:{width:number;height:number}):OffscreenCaptureSnapshot{
  if(viewport.documentId!==document.id||viewport.revision!==document.revision)throw new Error('当前窗口的模型显示尚未同步，请稍后导出。');
  if(!size.width||!size.height||![size.width,size.height].every(value=>Number.isFinite(value)&&value>0)||cameraView.length!==8||!cameraView.every(Number.isFinite))throw new Error('当前窗口的视角或画布尺寸尚未就绪。');
  return structuredClone({document:detachedDisplayDocument(document,viewport.displayDocument),cameraView:[...cameraView],display:viewport.display??DEFAULT_DISPLAY,showAxes:viewport.showAxes??false,width:1600,height:1200,viewportWidth:size.width,viewportHeight:size.height,
    multiframeDisplay:viewport.multiframeDisplay,samplingSphere:viewport.samplingSphere,calculationRanges:viewport.calculationRanges,hiddenAtomIds:viewport.hiddenAtomIds,previewGuides:viewport.previewGuides,previewCell:viewport.previewCell,cellGuides:viewport.cellGuides,
    measurement:viewport.measurement,vibrationVectors:viewport.vibrationVectors,orbitalLayer:viewport.orbitalLayer,ntoLayer:viewport.ntoLayer,surfaceLayer:viewport.surfaceLayer,surfaceLayers:viewport.surfaceLayers,surfaceExtrema:viewport.surfaceExtrema,
    atomScalarValues:viewport.atomScalarValues,atomScalarColor:viewport.atomScalarColor,atomScalarLabels:viewport.atomScalarLabels,dipoleVector:viewport.dipoleVector,viewTransform:viewport.viewTransform,
    resultBondValues:viewport.resultBondValues,resultBondLabels:viewport.resultBondLabels,resultBondColor:viewport.resultBondColor,resultAtomLabels:viewport.resultAtomLabels,resultHighlights:viewport.resultHighlights,resultColorbar:viewport.resultColorbar});
}
/** Shift can change event.key casing between press and release. */
export function createDetachedKeyTracker() {
  const keys = new Set<string>();
  return {
    add(key: string) { keys.add(key.toLowerCase()); },
    has(key: string) { return keys.has(key.toLowerCase()); },
    delete(key: string) { return keys.delete(key.toLowerCase()); },
    clear() { keys.clear(); },
    [Symbol.iterator]() { return keys.values(); },
  };
}
export function sharedWindowRuntimePhase(snapshot: WorkspaceDocumentSnapshot): string {
  const runtime = snapshot.runtime;
  return runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? typeof runtime.phase === 'string' ? runtime.phase : 'unknown' : 'idle';
}
export function sharedWindowEditingAllowed(state: WorkspaceBridgeState): boolean {
  if (state.status !== 'ready' || state.pending || state.closing || !state.membership) return false;
  const viewport=state.membership.snapshot.viewport as unknown as WorkspaceViewportState|undefined;
  if(viewport?.structureLocked||viewport?.allowModelEditing===false)return false;
  return Boolean(viewport?.allowModelEditing)||['idle', 'completed', 'stopped', 'error'].includes(sharedWindowRuntimePhase(state.membership.snapshot));
}
/** Retained for existing callers; the detached UI has no clipboard/tool owner. */
export function sharedWindowClipboardPayload(snapshot: WorkspaceDocumentSnapshot): ClipboardPayload {
  const document = snapshot.document;
  return normalizeWorkspaceJSON({ schema: 'sciyue-model-fragment', version: 1, sourceDocumentId: document.id, fragment: {
    structure: document.draft.structure, assignments: document.draft.assignments,
    auxiliaryRelations: document.auxiliaryRelations, deletedBonds: document.deletedBonds,
    internalCoordinates: document.internalCoordinates, sharedConstraints: document.sharedConstraints, coordinateObjects: document.coordinateObjects, gaussianBoundCoordinates: document.gaussianBoundCoordinates, attachmentPorts: document.attachmentPorts,
  } });
}
export function createSharedWindowActions(replica: Replica, bridge: OptionalWindowBridge) {
  function editable() { if (!sharedWindowEditingAllowed(replica.getState())) throw new Error('共享视图正在等待确认、运行锁定或 owner 不可用；不能编辑。'); }
  return {
    async model(command: ModelCommand) { editable(); if (!editingTypes.has(command.type)) throw new Error('此共享视图尚未开放该模型命令。'); return replica.dispatch({ type: 'model.execute', command: viewportCommand(command) }); },
    async select(selection: ModelSelection) { editable(); return replica.dispatch({ type: 'model.select', selection }); },
    async undo() { editable(); return replica.dispatch({ type: 'model.undo' }); },
    async redo() { editable(); return replica.dispatch({ type: 'model.redo' }); },
    async leave() { if (replica.getState().pending) throw new Error('请先等待本次共享命令回执。'); await replica.leave(); replica.dispose(); },
    async copy() { if (typeof bridge.writeClipboard !== 'function') throw new Error('此窗口未提供真实 desktop 剪贴板能力。'); await bridge.writeClipboard(sharedWindowClipboardPayload(replica.getWorkspaceSnapshot())); },
    async independentWindow() { if (typeof bridge.openModelWindow !== 'function') throw new Error('此窗口未提供 desktop 新窗口能力。'); return bridge.openModelWindow(); },
  };
}

/** A bounded transport queue, never an optimistic model store. Scientific picks
 * retain their originating revision; camera messages may coalesce while waiting. */
export function createDetachedViewportDispatcher(replica: Pick<Replica, 'dispatch' | 'getWorkspaceSnapshot'> & Partial<Pick<Replica, 'getState' | 'subscribeState'>>) {
  type Item = { event: WorkspaceViewportEvent; documentId: string; revision: number; waiters: { resolve(): void; reject(error: unknown): void }[] };
  const queue: Item[] = [];
  let running = false, disposed = false;
  let suspended = Boolean(replica.getState?.().closing);
  let pendingSave: { documentId: string; promise: Promise<void> } | null = null;
  const unsubscribeClose = replica.subscribeState?.(() => {
    suspended = Boolean(replica.getState?.().closing);
    if (suspended) for (const item of queue.splice(0)) item.waiters.forEach(waiter => waiter.reject(new WorkspaceClosePendingError()));
  });
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const item = queue.shift()!;
        try {
          if (disposed) throw new Error('外部视口已关闭。');
          if (suspended) throw new WorkspaceClosePendingError();
          const snapshot = replica.getWorkspaceSnapshot(), current = snapshot.document;
          // A measurement click first selects its coordinate object, which can
          // advance revision before the same click activates its label. Resolve
          // only that UI activation by stable ID against the confirmed record.
          if (item.event.type === 'measurement-select') {
            const recordId = item.event.recordId, projection = snapshot.viewport as unknown as WorkspaceViewportState | undefined;
            if (projection?.documentId !== current.id || !projection.measurement?.records?.some(record => record.id === recordId)) throw new Error('测量记录已变化，请重新选择。');
          }
          const revisionIndependent = item.event.type === 'camera' || item.event.type === 'save' || item.event.type === 'measurement-select' || item.event.type === 'key' && item.event.release;
          if (current.id !== item.documentId || !revisionIndependent && current.revision !== item.revision) throw new Error('模型修订已变化，请重新操作。');
          await replica.dispatch({ type: 'workspace.viewport-event', event: viewportJSON(item.event) });
          item.waiters.forEach(waiter => waiter.resolve());
        } catch (cause) { item.waiters.forEach(waiter => waiter.reject(cause)); }
      }
    } finally { running = false; }
  }
  return {
    dispatch(event: WorkspaceViewportEvent): Promise<void> {
      if (disposed) return Promise.reject(new Error('外部视口已关闭。'));
      if (suspended || replica.getState?.().closing) return Promise.reject(new WorkspaceClosePendingError());
      const document = replica.getWorkspaceSnapshot().document;
      if (event.type === 'save' && pendingSave?.documentId === document.id) return pendingSave.promise;
      const operation = new Promise<void>((resolve, reject) => {
        const tail = queue.at(-1);
        if ((event.type === 'camera' && tail?.event.type === 'camera' || event.type==='sampling-sphere'&&tail?.event.type==='sampling-sphere'||event.type==='cell-editor'&&event.action==='length'&&tail?.event.type==='cell-editor'&&tail.event.action==='length'&&tail.event.axis===event.axis) && tail.documentId === document.id) { tail.event = structuredClone(event); tail.waiters.push({ resolve, reject }); }
        else {
          if (queue.length >= 32) { reject(new Error('操作尚未确认，请稍后重试。')); return; }
          queue.push({ event: structuredClone(event), documentId: document.id, revision: document.revision, waiters: [{ resolve, reject }] });
        }
        void drain();
      });
      if (event.type === 'save') {
        const saving = { documentId: document.id, promise: operation }; pendingSave = saving;
        const clear = () => { if (pendingSave === saving) pendingSave = null; };
        void operation.then(clear, clear);
      }
      return operation;
    },
    dispose() { disposed = true; unsubscribeClose?.(); for (const item of queue.splice(0)) item.waiters.forEach(waiter => waiter.reject(new Error('外部视口已关闭。'))); },
  };
}

/** Saving is a document intent, independent of a temporarily lagging viewport
 * projection. All edits still require that projection and a live replica. */
export function dispatchDetachedViewportEvent(
  source: { transport: { dispatch(event: WorkspaceViewportEvent): Promise<void> } | null; replica: Pick<Replica, 'getState'> | null; hasProjection: boolean; readonlyDisplay?:boolean },
  event: WorkspaceViewportEvent,
): Promise<void> {
  if(source.readonlyDisplay)return Promise.reject(new Error('只读来源显示不能向容器模型发送编辑、选择或任务命令。'));
  const current = source.replica?.getState(), status = current?.status;
  if (!source.transport || !source.replica || status === 'unavailable' || status === 'disposed') {
    return Promise.reject(new Error('外部视口尚未连接或主工作台不可用。'));
  }
  if (current?.closing) return Promise.reject(new WorkspaceClosePendingError());
  if (event.type !== 'save' && !source.hasProjection) return Promise.reject(new Error('外部视口尚未连接或主工作台不可用。'));
  return source.transport.dispatch(event);
}

export interface SharedModelWindowProps { membership: WorkspaceMembership; bridge: WorkspaceDesktopBridge }
export default function SharedModelWindow({ membership, bridge }: SharedModelWindowProps) {
  useEffect(()=>{if(!window.sciyueDesktop?.requestProjectAction)return;const key=(event:globalThis.KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();void window.sciyueDesktop!.requestProjectAction!(event.shiftKey?'save-as':'save');}};window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[]);
  const [replica, setReplica] = useState<Replica | null>(null), [error, setError] = useState('');
  const [temporaryPointerMode, setTemporaryPointerMode] = useState<'select' | 'freeze' | null>(null);
  const scope = useRef<HTMLElement | null>(null), stage = useRef<HTMLDivElement | null>(null);
  const viewportGetter=useRef<(()=>number[])|null>(null),imageExportAbort=useRef<AbortController|null>(null);
  const [viewReady,setViewReady]=useState(false),[imageExporting,setImageExporting]=useState(false),[imageExportOpenRequest,setImageExportOpenRequest]=useState(0);
  const [settingsOpen,setSettingsOpen]=useState(false);
  useEffect(()=>subscribeGlobalSettings(window.sciyueDesktop,()=>setSettingsOpen(true)),[]);
  useEffect(()=>window.sciyueDesktop?.onWorkbenchFileAction?.(request=>{if(request.action==='export-image'&&(!request.documentId||request.documentId===membership.documentId))setImageExportOpenRequest(value=>value+1);}),[membership.documentId]);
  const [mirrorDisplayInput,setMirrorDisplay]=useState<{sourceKey:string;projection:ProjectedDisplayProperties}|null>(null),[displayHidden,setDisplayHidden]=useState(()=>typeof document!=='undefined'&&document.visibilityState==='hidden');
  const readonlyObservationContainer=useRef<string|null>(null);
  const displayConsumer=useRef<ViewportDisplayConsumer|null>(null);
  useEffect(()=>{const owner=scope.current?.ownerDocument??document,update=()=>setDisplayHidden(owner.visibilityState==='hidden');update();owner.addEventListener('visibilitychange',update);return()=>owner.removeEventListener('visibilitychange',update);},[]);
  const onViewReady=useCallback((getter:(()=>number[])|null)=>{viewportGetter.current=getter;setViewReady(Boolean(getter));},[]);
  useEffect(()=>()=>imageExportAbort.current?.abort(),[]);
  useLayoutEffect(() => bindInterfaceFontDocument(scope.current?.ownerDocument ?? document), []);
  const activationPointer = useRef(createViewportActivationPointerGate(true));
  const hover = useRef({ pick: emptyPick(), revision: membership.revision });
  const hoveredMarker = useRef<ViewportStateMarker | null>(null), hoveredMeasurement = useRef<string | null>(null);
  const held = useRef<{ key: string; mode: 'select' | 'freeze'; used: boolean } | null>(null), keys = useRef(createDetachedKeyTracker());
  const [remoteUndo] = useState(createRemoteHeldUndo);
  const gesture = useRef<'box' | 'camera' | 'fragment' | null>(null), cameraPending = useRef(0), cameraGeneration = useRef(0), drag = useRef(createDetachedTabDrag());
  const cameraOwnerKey=JSON.stringify([membership.documentId,membership.membershipNonce]);
  const cipReceipts=useRef(new Map<string,'pending'|'sent'>());
  const cameraOwner=useRef(cameraOwnerKey);
  if(cameraOwner.current!==cameraOwnerKey){cameraOwner.current=cameraOwnerKey;cameraGeneration.current++;cameraPending.current=0;gesture.current=null;}
  const [dragging, setDragging] = useState(false), [cameraState,setCameraState]=useState<{owner:string;view?:number[]}>({owner:cameraOwnerKey});
  const cameraView=cameraState.owner===cameraOwnerKey?cameraState.view:undefined;
  const setCameraView=(view:number[]|undefined)=>setCameraState(previous=>cameraOwner.current!==cameraOwnerKey?previous:previous.owner===cameraOwnerKey&&JSON.stringify(previous.view)===JSON.stringify(view)?previous:{owner:cameraOwnerKey,view:view?[...view]:undefined});
  useEffect(() => {
    let next: Replica, live = true;
    try { next = createWorkspaceReplica({ bridge, membership }); setReplica(next); }
    catch (cause) { setError(message(cause)); return; }
    void bridge.readWorkspaceDocuments().then(entries => {
      if (!live || ['unavailable', 'disposed'].includes(next.getState().status)) return;
      const fresh = entries.find(entry => entry.documentId === membership.documentId && entry.membershipNonce === membership.membershipNonce);
      if (fresh && fresh.snapshot.publicationSerial > next.getWorkspaceSnapshot().publicationSerial) {
        const replacement = createWorkspaceReplica({ bridge, membership: fresh }); next.dispose(); next = replacement; setReplica(next);
      }
    }).catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; next.dispose(); };
  }, [bridge, membership.documentId, membership.membershipNonce]);
  const model = useSyncExternalStore(replica?.store.subscribe ?? noSubscribe, replica?.store.getSnapshot ?? (() => membership.snapshot.document), () => membership.snapshot.document);
  const initialState = useMemo<WorkspaceBridgeState>(() => ({ status: 'registering', pending: true, error: null, membership }), [membership]);
  const state = useSyncExternalStore(replica?.subscribeState ?? noSubscribe, replica?.getState ?? (() => initialState), () => initialState);
  const snapshot = state.membership?.snapshot ?? membership.snapshot;
  const viewportKey = JSON.stringify(snapshot.viewport ?? null);
  const viewport = useMemo(() => {
    const value = snapshot.viewport;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const projection = value as unknown as WorkspaceViewportState & { dockTarget?: DockTarget };
    return projection.documentId === model.id && projection.revision === model.revision ? projection : null;
  }, [viewportKey, model.id, model.revision]);
  const transport = useMemo(() => replica ? createDetachedViewportDispatcher(replica) : null, [replica]);
  useEffect(() => () => transport?.dispose(), [transport]);
  const unavailable = state.status === 'unavailable' || state.status === 'disposed';
  const closing = Boolean(state.closing), readOnly = closing || unavailable || !replica || !viewport;
  useTransientLayerScope(scope.current?.ownerDocument??(typeof document==='undefined'?null:document),JSON.stringify([
    membership.documentId,membership.membershipNonce,viewport?.trajectoryPlayback?.resultId,
    viewport?.trajectoryPlayback?.collectionIdentity?.collectionId,viewport?.trajectoryPlayback?.collectionIdentity?.sourceId,
    viewport?.trajectoryPlayback?.collectionIdentity?.stageId
  ]));
  useEffect(()=>{if(closing||unavailable)imageExportAbort.current?.abort();},[closing,unavailable]);
  const displayDescription=viewport?.displayProjection;
  const candidateDisplay=!displayHidden&&mirrorDisplayInput?.sourceKey===displayDescription?.sourceKey?mirrorDisplayInput?.projection:null;
  const mirrorDisplay=candidateDisplay?.displayDocument&&(candidateDisplay.displayDocument.document.id!==model.id||candidateDisplay.displayDocument.document.revision!==model.revision)?null:candidateDisplay;
  const observationContainer=JSON.stringify([model.id,membership.membershipNonce]);
  // A missing payload is a transport gap, not evidence that the owner left its
  // readonly observation. Only an explicit descriptor removal or an accepted
  // non-readonly projection restores normal owner camera/editing behaviour.
  if(viewport&&!displayDescription)readonlyObservationContainer.current=null;
  else if(mirrorDisplay)readonlyObservationContainer.current=mirrorDisplay.displayDocument?observationContainer:null;
  const readonlyProjection=Boolean(mirrorDisplay?.displayDocument||readonlyObservationContainer.current===observationContainer);
  const displayWaiting=Boolean(displayDescription&&!mirrorDisplay);
  const displayMirrorState=!displayDescription?'inactive':displayHidden?'paused':mirrorDisplay?'accepted':'waiting';
  const observedModel=detachedDisplayDocument(model,mirrorDisplay?.displayDocument);
  useEffect(()=>{void window.sciyueDesktop?.updateWorkbenchFileState?.({canImport:!readOnly,canExportStructure:!readOnly&&!displayWaiting&&observedModel.draft.structure.atoms.length>0,canExportImage:!readOnly&&!displayWaiting&&viewReady&&!imageExporting&&observedModel.draft.structure.atoms.length>0}).catch(()=>{});},[readOnly,displayWaiting,viewReady,imageExporting,observedModel.draft.structure.atoms.length]);
  useEffect(()=>{
    if(!displayDescription||!transport||readOnly||displayHidden){setMirrorDisplay(null);return;}
    setMirrorDisplay(null);
    let alive=true;const token=`${membership.membershipNonce}:${crypto.randomUUID()}`;
    const consumer=createViewportDisplayConsumer({port:openViewportDisplayPort(model.id,token),token,expected:displayDescription,onProjection:projection=>{if(alive)setMirrorDisplay(projection?{sourceKey:displayDescription.sourceKey,projection}:null);},onError:setError});displayConsumer.current=consumer;
    // This exact path is authorized by the existing host's member(doc,nonce)
    // check, then the owner verifies requesterWindowId is its detached member.
    void transport.dispatch({type:'display-subscribe',channelToken:token}).then(()=>{if(alive)consumer.authorize();},cause=>{if(alive&&!isWorkspaceClosePendingError(cause))setError(message(cause));});
    return()=>{alive=false;consumer.close();if(displayConsumer.current===consumer)displayConsumer.current=null;};
  },[transport,membership.membershipNonce,model.id,model.revision,displayDescription?.sourceKey,readOnly,displayHidden]);
  useEffect(()=>{if(displayDescription)displayConsumer.current?.expect(displayDescription);},[displayDescription?.projectionSerial]);
  const cameraRequestKey = JSON.stringify(viewport?.cameraRequest), cameraKey = JSON.stringify(viewport?.cameraView);
  // A new adapter restores the saved view. Requests already consumed by the
  // owner before detachment must not reset that view a second time.
  const initialCameraRequests = useRef<{ documentId: string; request?: string; reset?: number } | null>(null);
  if (viewport && initialCameraRequests.current?.documentId !== model.id) initialCameraRequests.current = { documentId: model.id, request: cameraRequestKey, reset: viewport.resetViewRequest };
  const cameraRequest = useMemo(() => cameraRequestKey !== initialCameraRequests.current?.request ? viewport?.cameraRequest : undefined, [cameraRequestKey]);
  const resetViewRequest = viewport?.resetViewRequest !== initialCameraRequests.current?.reset ? viewport?.resetViewRequest : undefined;
  const latest = useRef({ model, viewport, transport, replica, readOnly,mirrorDisplay,readonlyProjection,displayWaiting,displayHidden,cameraView,cameraOwnerKey }); latest.current = { model, viewport, transport, replica, readOnly,mirrorDisplay,readonlyProjection,displayWaiting,displayHidden,cameraView,cameraOwnerKey };
  function interactionOwner(): ViewportInteractionOwner {
    // Confirmed replica publication can precede React rendering. Read its owner
    // identity directly, as we already do when restoring the confirmed camera.
    const raw = latest.current.replica?.getWorkspaceSnapshot().viewport ?? membership.snapshot.viewport;
    const projection = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as unknown as WorkspaceViewportState : null;
    if (projection?.documentId !== latest.current.model.id) return {};
    return { active: projection.interactionOwnerActive, activationEpoch: projection.interactionActivationEpoch };
  }
  function send(event: WorkspaceViewportEvent) {
    const own = latest.current;
    if (!own.replica?.getState().closing) setError('');
    return dispatchDetachedViewportEvent({ transport: own.transport, replica: own.replica, hasProjection: Boolean(own.viewport),readonlyDisplay:own.readonlyProjection&&!own.viewport?.allowModelEditing||own.displayWaiting }, event).catch(cause => { if (!isWorkspaceClosePendingError(cause)) setError(message(cause)); throw cause; });
  }
  function emit(event: WorkspaceViewportEvent) { void send(event).catch(() => {}); }
  function emitCipUsage(receipt:CipViewportUsage){
    const own=latest.current,currentSnapshot=own.replica?.getWorkspaceSnapshot();
    if(!own.transport||!own.replica||!currentSnapshot||own.readOnly||own.displayWaiting||own.displayHidden||own.replica.getState().closing)return;
    const document=detachedDisplayDocument(own.model,own.mirrorDisplay?.displayDocument);
    if(!currentPreparedCipUsage(document,receipt))return;
    const key=JSON.stringify([membership.membershipNonce,receipt.documentId,receipt.software,receipt.version,receipt.operation]);
    if(cipReceipts.current.has(key))return;
    const projection=currentSnapshot.viewport as unknown as WorkspaceViewportState|undefined;
    cipReceipts.current.set(key,'pending');
    // This explicitly read-only event uses the authenticated replica transport;
    // it bypasses no editable-event guard and never requests activation/focus.
    void own.transport.dispatch({type:'cip-used',documentEpoch:currentSnapshot.documentEpoch,projectionSerial:projection?.displayProjection?.projectionSerial??null,receipt}).then(
      ()=>{cipReceipts.current.set(key,'sent');},()=>{cipReceipts.current.delete(key);});
  }
  function dispatchPlayback(command:TrajectoryPlaybackCommand) {
    const playback=viewport?.trajectoryPlayback;if(!playback)return;
    emit({type:'trajectory-playback',resultId:playback.resultId,
      ...(playback.projectionKey!==undefined?{projectionKey:playback.projectionKey}:{}),
      ...(playback.collectionIdentity?{collectionIdentity:playback.collectionIdentity}:{}),command});
  }
  function syncCamera() {
    if(latest.current.cameraOwnerKey!==cameraOwnerKey)return;
    // Props can advance to a new nonce one render before the old replica is
    // replaced. Its matching document/revision does not authorize its camera.
    const member=latest.current.replica?latest.current.replica.getState().membership:membership;
    if(!member||member.documentId!==membership.documentId||member.membershipNonce!==membership.membershipNonce)return;
    if (gesture.current || cameraPending.current || latest.current.replica?.getState().closing) return;
    // A transport receipt can precede React's next render. Read its confirmed
    // projection directly rather than briefly restoring the preceding view.
    const raw = latest.current.replica?.getWorkspaceSnapshot().viewport;
    const confirmed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as unknown as WorkspaceViewportState : null;
    const owner=confirmed?.documentId === latest.current.model.id ? confirmed : latest.current.viewport;
    if(latest.current.readonlyProjection||latest.current.displayWaiting){
      // Inherit the accepted owner's actual pose once. Subsequent owner
      // publications, hidden-window resumes and source reconnects must retain
      // this member's local observation camera rather than linking cameras.
      const view=owner?.cameraView;
      if(latest.current.cameraView||owner?.documentId!==membership.documentId||owner?.revision!==latest.current.model.revision||!Array.isArray(view)||view.length!==8||!view.every(Number.isFinite)||Math.hypot(...view.slice(4))<1e-10)return;
      setCameraView(view);return;
    }
    setCameraView(owner?.cameraView);
  }
  useEffect(syncCamera, [cameraKey,cameraOwnerKey]);
  useEffect(syncCamera,[readonlyProjection,displayWaiting,cameraOwnerKey]);
  useEffect(() => {
    if (!replica) return;
    const reset = () => {
      if (!replica.getState().closing) { syncCamera(); return; }
      held.current = null; keys.current.clear(); setTemporaryPointerMode(null);
      hover.current = { pick: emptyPick(), revision: latest.current.model.revision }; hoveredMarker.current = null; hoveredMeasurement.current = null;
      gesture.current = null; cameraPending.current = 0; cameraGeneration.current++; drag.current.cancel(); setDragging(false);
      setError(previous => isWorkspaceClosePendingError(previous) ? '' : previous);
    };
    reset(); return replica.subscribeState(reset);
  }, [replica]);
  function activate() {
    if (unavailable || replica?.getState().closing || latest.current.viewport?.workspaceDocumentPickMode || !bridge.activateWorkspaceDocument) return;
    void bridge.activateWorkspaceDocument({ documentId: membership.documentId, membershipNonce: membership.membershipNonce }).catch(cause => { if (!isWorkspaceClosePendingError(cause)) setError(message(cause)); });
  }
  function currentHover() { return hover.current.revision === latest.current.model.revision ? hover.current.pick : emptyPick(); }
  function releaseHeldKeys() {
    remoteUndo.stop();
    if (!latest.current.replica?.getState().closing) for (const key of keys.current) emit({ type: 'key', key, release: true, hover: emptyPick(), heldUsed: true });
    keys.current.clear(); held.current = null; setTemporaryPointerMode(null);
  }
  useEffect(() => {
    const focus = () => { activationPointer.current.focus(interactionOwner()); scope.current?.focus({ preventScroll: true }); activate(); };
    const blur = () => { activationPointer.current.blur(); releaseHeldKeys(); hover.current = { pick: emptyPick(), revision: latest.current.model.revision }; hoveredMarker.current = null; hoveredMeasurement.current = null; };
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    activationPointer.current.focus(interactionOwner());
    scope.current?.focus({ preventScroll: true });
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  }, [bridge, membership.documentId, membership.membershipNonce, transport]);
  useEffect(() => () => remoteUndo.stop(), [remoteUndo, cameraOwnerKey]);
  useEffect(() => { if(readOnly || displayWaiting || closing || displayHidden) remoteUndo.stop(); }, [remoteUndo, readOnly, displayWaiting, closing, displayHidden]);
  function keyboard(event: KeyboardEvent<HTMLElement>, release: boolean) {
    const releasedKey=event.key.toLowerCase();
    if(release&&['z','control','meta'].includes(releasedKey))remoteUndo.stop();
    // Releases belong to the owner that recorded the press, even when a
    // textbox, export menu or a new readonly projection now owns focus.
    if(release&&(editableTarget(event.target)||event.nativeEvent.isComposing||latest.current.readOnly||latest.current.readonlyProjection&&!latest.current.viewport?.allowModelEditing||latest.current.displayWaiting)){
      const owned=[...keys.current].filter(key=>key.toLowerCase()===releasedKey);
      for(const key of owned)keys.current.delete(key);
      if(held.current?.key===releasedKey){held.current=null;setTemporaryPointerMode(null);}
      if(owned.length&&!latest.current.replica?.getState().closing)emit({type:'key',key:event.key,release:true,hover:emptyPick(),heldUsed:true});
      return;
    }
    if (editableTarget(event.target) || event.nativeEvent.isComposing) return;
    if (latest.current.replica?.getState().closing) { event.preventDefault(); return; }
    if(latest.current.readonlyProjection&&!latest.current.viewport?.allowModelEditing||latest.current.displayWaiting){event.preventDefault();return;}
    const key = event.key.toLowerCase(), own = latest.current.viewport;
    if(own?.workspaceDocumentPickMode){event.preventDefault();if(!release&&key==='escape')emit({type:'cancel-document-pick'});return;}
    // Modifier flags travel on the actionable key. Standalone Control/Meta
    // events have no owner operation and must not add a publication race.
    if (key === 'control' || key === 'meta') return;
    if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); if (!release && !event.repeat) emit({ type: 'save' }); return; }
    if (latest.current.readOnly) return;
    if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if(!release&&!event.repeat){
        const ownerKey=latest.current.cameraOwnerKey;
        remoteUndo.start(() => send({type:'key',key:'z',release:false,ctrlKey:event.ctrlKey,metaKey:event.metaKey,repeat:false,hover:emptyPick()}), () => {
          const current=latest.current;
          return current.cameraOwnerKey===ownerKey&&!current.readOnly&&!current.displayWaiting&&!current.displayHidden&&!(current.readonlyProjection&&!current.viewport?.allowModelEditing)&&!current.replica?.getState().closing&&current.model.canUndo&&!editableTarget(scope.current?.ownerDocument.activeElement??null);
        }, cause => { if(!isWorkspaceClosePendingError(cause))setError(message(cause)); });
      }
      return;
    }
    if (event.code === 'Space' || event.key === ' ') {
      if (workspaceSpacePressAllowed(event.nativeEvent, release, event.target, event.currentTarget.ownerDocument.activeElement)) {
        event.preventDefault();
        emit({ type: 'key', key: ' ', release: false, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, hover: currentHover() });
      }
      return;
    }
    if (release && !keys.current.has(event.key)) return;
    let heldUsed = false;
    if (release) {
      keys.current.delete(event.key);
      if (held.current?.key === key) { heldUsed = held.current.used; held.current = null; setTemporaryPointerMode(null); }
    } else {
      keys.current.add(event.key);
      if (!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        const mode = key === own?.selectShortcut.toLowerCase() ? 'select' : key === own?.freezeShortcut.toLowerCase() ? 'freeze' : null;
        if (mode && !held.current) { held.current = { key, mode, used: false }; setTemporaryPointerMode(mode); }
        else if (/^[a-z]$/.test(key) && held.current && held.current.key !== key) { held.current = null; setTemporaryPointerMode(null); }
      }
      if (key === 'escape') { held.current = null; setTemporaryPointerMode(null); }
    }
    event.preventDefault();
    emit({ type: 'key', key: event.key, release, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, hover: currentHover(), heldUsed, marker: hoveredMarker.current, measurementRecordId: hoveredMeasurement.current });
  }
  function finishDrag(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const outcome = drag.current.finish(event.pointerId, event.screenX, event.screenY, latest.current.viewport?.dockTarget, cancel);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (outcome.dock && !replica?.getState().closing && bridge.dockWorkspaceDocument) void bridge.dockWorkspaceDocument({ documentId: membership.documentId, membershipNonce: membership.membershipNonce }).catch(cause => { if (!isWorkspaceClosePendingError(cause)) setError(message(cause)); });
  }
  function viewportSize(){const bounds=stage.current?.querySelector('.model-viewport-stage')?.getBoundingClientRect();return bounds?{width:bounds.width,height:bounds.height}:undefined;}
  async function exportCurrentViewport(options:ViewportImageExportOptions,ownerDocument:Document){
    const own=latest.current,size=viewportSize(),getView=viewportGetter.current;
    if(imageExportAbort.current||own.readOnly||own.displayWaiting||!own.viewport||!size||!getView)return;
    const controller=new AbortController();imageExportAbort.current=controller;setImageExporting(true);
    try{
      const scene=detachedViewportImageSnapshot(own.model,{...own.viewport,...own.mirrorDisplay},getView(),size);
      const blob=await exportViewportImage(scene,{...options,viewportWidth:size.width,viewportHeight:size.height},ownerDocument,controller.signal);
      if(!controller.signal.aborted)exportBlob(blob,`${own.model.draft.structure.name||'Ester-Studio'}.${options.format}`,ownerDocument);
    }catch(cause){if(!controller.signal.aborted)setError(message(cause));}
    finally{if(imageExportAbort.current===controller){imageExportAbort.current=null;setImageExporting(false);}}
  }
  return <section ref={scope} className="shared-model-window" tabIndex={0} aria-label="外部模型视口" data-testid="shared-model-window" data-display-hidden={displayHidden} data-display-mirror-state={displayMirrorState} data-interaction-owner-active={viewport?.interactionOwnerActive??false} data-interaction-activation-epoch={viewport?.interactionActivationEpoch??0} data-document-pick-mode={viewport?.workspaceDocumentPickMode??''} data-link-selected={viewport?.workspaceDocumentPickSelected??false} data-document-id={model.id} data-owner-id={membership.ownerWindowId} data-editable={Boolean(!readOnly && (!readonlyProjection||viewport?.allowModelEditing) && !displayWaiting && !viewport?.structureLocked)}
    onKeyDown={event => keyboard(event, false)} onKeyUpCapture={event => keyboard(event, true)} onFocusCapture={event=>{if(editableTarget(event.target))releaseHeldKeys();activate();}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))releaseHeldKeys();}}
    onPointerDownCapture={event => {
      if(latest.current.viewport?.workspaceDocumentPickMode){event.preventDefault();event.stopPropagation();if(event.button===0)emit({type:'document-pick'});return;}
      const canvas = viewportActivationTarget(event.target);
      if(canvas&&(latest.current.readOnly||latest.current.displayWaiting||latest.current.displayHidden)){event.preventDefault();event.stopPropagation();return;}
      // An accepted readonly mirror owns a local observation camera, not an
      // editing lease. Keep real owner metadata untouched while permitting its
      // camera pointer to reach ModelViewport's existing read-only path.
      const localCamera=canvas&&latest.current.readonlyProjection&&Boolean(latest.current.mirrorDisplay?.displayDocument);
      if(localCamera){activationPointer.current.cancel(event.pointerId);activationPointer.current.explicitActivation();}
      const activationOnly = canvas && !localCamera && activationPointer.current.begin(event.pointerId, interactionOwner());
      if (!canvas) activationPointer.current.explicitActivation();
      activate();
      if (activationOnly) { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); return; }
      if (!editableTarget(event.target) && !(event.target instanceof Element && event.target.closest('button'))) scope.current?.focus({ preventScroll: true });
    }}
    onPointerMoveCapture={event => { if (activationPointer.current.consumes(event.pointerId)) { event.preventDefault(); event.stopPropagation(); } }}
    onPointerUpCapture={event => { if (activationPointer.current.end(event.pointerId)) { event.preventDefault(); event.stopPropagation(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancelCapture={event => { if (activationPointer.current.cancel(event.pointerId)) { event.preventDefault(); event.stopPropagation(); } }}
    onLostPointerCaptureCapture={event => activationPointer.current.lostCapture(event.pointerId)}
    onClickCapture={event => { if (activationPointer.current.click((event.nativeEvent as PointerEvent).pointerId, event.detail)) { event.preventDefault(); event.stopPropagation(); } }}>
    <header className="shared-model-heading" aria-label="模型窗口标题栏">
      <div className="shared-model-tab" role="tab" aria-selected="true" tabIndex={0} data-testid="detached-model-tab" data-dragging={dragging} title="拖回主窗口模型标签栏以停靠；拖动右侧空白可移动窗口"
        onPointerDown={event => { if (event.button !== 0 || !event.isPrimary || replica?.getState().closing) return; event.preventDefault(); drag.current.start(event.pointerId, event.screenX, event.screenY); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current.move(event.pointerId, event.screenX, event.screenY)) setDragging(true); }}
        onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={() => { drag.current.cancel(); setDragging(false); }}>
        <WorkspaceTabTitle className="shared-model-tab-name" dirty={model.draft.dirty}>{snapshot.metadata?.label || model.draft.structure.name || '模型'}</WorkspaceTabTitle>
        <WorkspaceTabActions><button type="button" className="workspace-tab-close" aria-label="关闭模型" disabled={closing || unavailable || !bridge.requestWorkspaceDocumentClose} onClick={() => { void bridge.requestWorkspaceDocumentClose?.({ documentId: membership.documentId, membershipNonce: membership.membershipNonce }).catch(cause => { if (!isWorkspaceClosePendingError(cause)) setError(message(cause)); }); }}><WorkspaceTabCloseIcon/></button></WorkspaceTabActions>
      </div>
      <span className="shared-model-window-drag" aria-hidden="true" />
      <div className="shared-model-image-export"><button type="button" onClick={()=>setSettingsOpen(true)}>显示设置</button><ViewportImageExportMenu openRequest={imageExportOpenRequest} getViewportSize={viewportSize} disabled={!viewReady||readOnly||!observedModel.draft.structure.atoms.length||Boolean(displayDescription&&!mirrorDisplay)} exporting={imageExporting} onExport={exportCurrentViewport}/></div>
      <output className="shared-model-status" role="status" aria-live="polite">{unavailable ? '主工作台不可用' : closing ? '正在确认关闭…' : !viewport || !replica ? '正在连接…' : state.pending ? '正在同步…' : ''}</output>
    </header>
    {viewport?.trajectoryPlayback&&viewport.trajectoryPlayback.count>0&&<div className="trajectory-player-row" data-testid="trajectory-top-playback"><TrajectoryControls {...viewport.trajectoryPlayback} disabled={readOnly||viewport.trajectoryPlayback.disabled} {...trajectoryControlCallbacks(dispatchPlayback)} detailsContent={viewport.trajectoryPlayback.overlay&&<PlaybackOverlayControls {...viewport.trajectoryPlayback.overlay} {...trajectoryOverlayControlCallbacks(dispatchPlayback)}/>}/></div>}
    <div ref={stage} className="shared-model-stage" onPointerDownCapture={event => { if (held.current && event.target instanceof Element && event.target.closest('[data-testid="model-interaction-surface"]')) held.current.used = true; }}>
      {!!viewport?.workspaceInputRoles?.length&&<div className="workspace-task-roles">{viewport.workspaceInputRoles.map(role=><span key={role.role} className="workspace-task-role" data-testid="workspace-task-role" data-input-task-id={role.taskId} data-source-document-id={model.id} data-source-role={role.role}>{role.label}</span>)}</div>}
      <ModelViewport {...viewport} {...mirrorDisplay} onCipLabelsUsed={emitCipUsage} sceneOwnerEpoch={!readonlyProjection?snapshot.documentEpoch:undefined} document={observedModel} active={!unavailable && !closing} legendVisible={viewport?.legendVisible} display={viewport?.display ?? DEFAULT_DISPLAY} interaction={viewport?.interaction ?? { element: null, box: false, alt: false, gesture: 'none' }}
        cellEditorDraft={!readOnly&&!displayWaiting&&viewport?.cellEditor?{...viewport.cellEditor,onAxisHover:axis=>emit({type:'cell-editor',documentId:viewport.cellEditor!.documentId,expectedRevision:viewport.cellEditor!.expectedRevision,action:'hover',axis}),onLengthChange:(axis,length)=>emit({type:'cell-editor',documentId:viewport.cellEditor!.documentId,expectedRevision:viewport.cellEditor!.expectedRevision,action:'length',axis,length}),onLengthCommit:(axis,length)=>emit({type:'cell-editor',documentId:viewport.cellEditor!.documentId,expectedRevision:viewport.cellEditor!.expectedRevision,action:'commit',axis,length}),onDragStart:()=>emit({type:'cell-editor',documentId:viewport.cellEditor!.documentId,expectedRevision:viewport.cellEditor!.expectedRevision,action:'start'}),onDragEnd:cancel=>emit({type:'cell-editor',documentId:viewport.cellEditor!.documentId,expectedRevision:viewport.cellEditor!.expectedRevision,action:'end',cancel:cancel===true})}:null}
        samplingSphereDraft={!readOnly&&!displayWaiting?viewport?.samplingSphereEditor:null} onSamplingSphereRadiusChange={change=>emit({type:'sampling-sphere',...change})}
        onViewReady={onViewReady}
        onSurfaceMeshState={(mesh,document)=>displayConsumer.current?.mesh(mesh,document)}
        onResultColorbarLayoutChange={mirrorDisplay?.resultColorbarOwnerKey?layout=>{displayConsumer.current?.colorbarLayout(layout);}:undefined}
        readOnly={readOnly || viewport?.readOnly || readonlyProjection || displayWaiting} allowModelEditing={!readOnly&&!displayWaiting&&viewport?.allowModelEditing} temporaryPointerMode={readonlyProjection&&!viewport?.allowModelEditing||displayWaiting?null:temporaryPointerMode ?? viewport?.temporaryPointerMode} getPointerMode={() => latest.current.readonlyProjection&&!latest.current.viewport?.allowModelEditing||latest.current.displayWaiting?null:held.current?.mode ?? latest.current.viewport?.temporaryPointerMode ?? null}
        getDocument={() => detachedDisplayDocument(latest.current.model,latest.current.mirrorDisplay?.displayDocument)} selectionShortcut={viewport?.selectShortcut.toUpperCase()} cameraRequest={readonlyProjection?undefined:cameraRequest} resetViewRequest={readonlyProjection?undefined:resetViewRequest} cameraView={cameraView}
        onCameraViewChange={view => { if (latest.current.cameraOwnerKey!==cameraOwnerKey||latest.current.replica?.getState().closing) return; const generation = cameraGeneration.current; setCameraView(view);if(latest.current.readonlyProjection||latest.current.displayWaiting)return; cameraPending.current++; void send({ type: 'camera', view }).catch(() => {}).finally(() => { if (latest.current.cameraOwnerKey!==cameraOwnerKey||generation !== cameraGeneration.current) return; cameraPending.current--; syncCamera(); }); }}
        onHover={pick => { hover.current = { pick: latest.current.replica?.getState().closing ? emptyPick() : pick, revision: latest.current.model.revision }; }} onStateMarkerHover={marker => { hoveredMarker.current = latest.current.replica?.getState().closing ? null : marker; }} onMeasurementRecordHover={record => { hoveredMeasurement.current = latest.current.replica?.getState().closing ? null : record?.id ?? null; }}
        onGestureStart={kind => { if (latest.current.replica?.getState().closing) return; gesture.current = kind; if (held.current) held.current.used = true; }} onGestureEnd={() => { gesture.current = null; syncCamera(); }}
        onSelection={selection => emit({ type: 'selection', selection })} onCommand={command => emit({ type: 'command', command: viewportCommand(command) })}
        onAtomStateChange={(atomIds, action) => emit({ type: 'atom-state', atomIds, action })} onObjectStateChange={(objects, action) => emit({ type: 'object-state', objects, action })}
        onStateMarkerDelete={marker => emit({ type: 'marker-delete', marker })} onObjectDelete={pick => emit({ type: 'object-delete', pick })}
        onMeasurementPick={atomId => emit({ type: 'measurement-pick', atomId })} onMeasurementRecordSelect={record => emit({ type: 'measurement-select', recordId: record.id })}
        onMeasurementRecordDelete={recordId => emit({ type: 'measurement-delete', recordId })} onMeasurementRecordWheel={(record, deltaY) => emit({ type: 'measurement-wheel', recordId: record.id, deltaY })}
        onCapturePick={atomId => emit({ type: 'capture-pick', atomId })} onCaptureBox={(atomIds,images) => emit({ type: 'capture-box', atomIds,...(images?{images}:{}) })} onAtomNumberPick={viewport?.numberingPickActive?atomId=>emit({type:'atom-number-pick',atomId}):undefined} onError={setError} />
      <CanvasClearToolbar containerRef={stage} disabled={readOnly || viewport?.structureLocked || readonlyProjection&&!viewport?.allowModelEditing || displayWaiting} onClearSelection={() => emit({ type: 'clear', kind: 'selection' })} onClearFrozen={() => emit({ type: 'clear', kind: 'frozen' })} onClearCoordinates={() => emit({ type: 'clear', kind: 'coordinates' })} />
    </div>
    {(error || state.error || viewport?.error) && <DismissibleNotice className="shared-model-error" identity={cameraOwnerKey}>{error || state.error || viewport?.error}</DismissibleNotice>}
    {settingsOpen&&<EnvironmentSettings onClose={()=>setSettingsOpen(false)} display={readOnly?undefined:viewport?.display??DEFAULT_DISPLAY} onDisplayChange={readOnly?undefined:display=>emit({type:'display-settings',display})} atoms={observedModel.draft.structure.atoms} hasCell={!!observedModel.draft.structure.cell} targetLabel={snapshot.metadata?.label??observedModel.draft.structure.name} showAxes={viewport?.showAxes??false} onShowAxesChange={visible=>emit({type:'axes-visible',visible})}/>}
  </section>;
}
