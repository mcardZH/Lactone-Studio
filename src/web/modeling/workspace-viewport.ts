import type {ModelViewportProps} from './ModelViewport';
import type {CameraZoomReceipt} from './render/adapter';
import type {JsonValue} from '../../modeling/workspace-contracts';
import type {DisplaySettings,InteractionState,ModelCommand,ModelDocument,ModelSelection,PickResult} from '../../modeling/contracts';
import type {CellEditorRequest} from '../../core/modeling/cell-editor';
import type {StructureTransformEdit} from '../../core/modeling/structure-transform';
import type {PeriodicInspectRequest,PeriodicModelingRequest} from './PeriodicModelingPanel';
import type {EmpiricalBondPerceptionParameters} from '../../core/bond-perception-parameters';
import type {AtomStateAction,ViewportObjectState,ViewportStateMarker} from './viewport-overlays';
import {normalizeWorkspaceJSON,normalizeWorkspaceViewportJSON} from '../../modeling/platform/workspace-bridge';
import type {ViewportDisplayDescriptor} from './viewport-display-channel';
import type {CellEditorViewportDraft} from './CellEditorPanel';
import type {SamplingSphereViewportDraft} from '../../modeling/advanced/sampling-sphere';
import type {TrajectoryPlaybackCommand,TrajectoryPlaybackState} from '../results/trajectory-playback-bridge';
import type {PlaybackCollectionIdentity} from '../../results/playback-collection';
import type {CipViewportUsage} from './use-cip-usage';
import {sameViewportRenderIdentity,type ViewportRenderIdentity} from './render/render-completion';

/** A display/interaction projection only. The one ModelStore and native owner
 * remain in the main workspace; no history or executable callbacks cross IPC. */
type DataKeys = {[K in keyof ModelViewportProps]: NonNullable<ModelViewportProps[K]> extends (...args:any[])=>any ? never : K}[keyof ModelViewportProps];
export type WorkspaceViewportState = Partial<Pick<ModelViewportProps,Exclude<DataKeys,undefined|'document'>>> & {
  frameBondEditing?:FrameBondEditingState;
  readonlyClearSelection?:boolean;
  documentId:string;revision:number;interaction:InteractionState;
  selectShortcut:string;freezeShortcut:string;
  dockTarget?:{x:number;y:number;width:number;height:number};error?:string;
  workspaceDocumentPickMode?:'source'|'link';workspaceDocumentPickSelected?:boolean;
  interactionOwnerActive?:boolean;interactionActivationEpoch?:number;
  displayProjection?:ViewportDisplayDescriptor;
  cellEditor?:Pick<CellEditorViewportDraft,'documentId'|'expectedRevision'|'cell'|'lengths'|'activeAxis'>;
  samplingSphereEditor?:SamplingSphereViewportDraft;
  trajectoryPlayback?:TrajectoryPlaybackState;
  workspaceInputRoles?:{taskId:string;role:'reactant'|'product'|'tsGuess';label:string}[];
};
export interface FrameBondEditingState {frameKey:string;blocked:boolean;canUndo:boolean;canRedo:boolean}
export interface FrameBondTarget {frameKey:string;projectionSerial:number}
export interface DetachedFrameTarget {
  documentId:string;
  revision:number;
  documentEpoch:string;
  projectionSerial:number|null;
  exportSourceIdentity?:string;
  renderIdentity?:ViewportRenderIdentity;
}
export function checkedFrameBondEditing(value:FrameBondEditingState):FrameBondEditingState {
 const tuple=JSON.parse(value.frameKey);
 if(!value||Object.keys(value).some(key=>!['frameKey','blocked','canUndo','canRedo'].includes(key))||!Array.isArray(tuple)||tuple.length!==5
  ||![tuple[0],tuple[1],tuple[3],tuple[4]].every(part=>typeof part==='string'&&part.length>0)||!Number.isSafeInteger(tuple[2])||tuple[2]<0
  ||![value.blocked,value.canUndo,value.canRedo].every(part=>typeof part==='boolean'))throw Error('帧显示键编辑能力身份无效。');
 return value;
}
export type WorkspaceViewportEvent = ({frameBondTarget?:FrameBondTarget;detachedFrameTarget?:DetachedFrameTarget}&(
 | {type:'cip-used';documentEpoch:string;projectionSerial:number|null;receipt:CipViewportUsage}
 | {type:'sampling-sphere';sourceDocumentId:string;sourceRevision:number;radiusAngstrom:number}
 | {type:'trajectory-playback';resultId:string;projectionKey?:string;collectionIdentity?:PlaybackCollectionIdentity;command:TrajectoryPlaybackCommand}
 | {type:'cell-editor';documentId:string;expectedRevision:number;action:'hover'|'start'|'length'|'commit'|'end';axis?:0|1|2|null;length?:number;cancel?:boolean}
 | {type:'command';command:ModelCommand}
 | {type:'selection';selection:ModelSelection}
 | {type:'atom-state';atomIds:string[];action:AtomStateAction}
 | {type:'object-state';objects:ViewportObjectState;action:AtomStateAction}
 | {type:'marker-delete';marker:ViewportStateMarker}
 | {type:'object-delete';pick:Exclude<PickResult,{kind:'none'}>}
 | {type:'measurement-pick';atomId:string|null}
 | {type:'measurement-select'|'measurement-delete';recordId:string}
 | {type:'measurement-wheel';recordId:string;deltaY:number}
 | {type:'capture-pick';atomId:string|null}
 | {type:'capture-box';atomIds:string[];images?:import('../../core/types').Vector3[]}
 | {type:'atom-number-pick';atomId:string}
 | {type:'document-pick'|'cancel-document-pick'}
 | {type:'camera';view:number[]}
 | {type:'key';key:string;release:boolean;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean;repeat?:boolean;hover:PickResult;heldUsed?:boolean;marker?:ViewportStateMarker|null;measurementRecordId?:string|null}
 | {type:'clear';kind:'selection'|'frozen'|'coordinates'}
 | {type:'save'}
 | {type:'file-action';action:'import'|'export-structure'|'export-image'}
 | {type:'display-settings';display:DisplaySettings}
 | {type:'axes-visible';visible:boolean}
 | {type:'display-subscribe';channelToken:string}));
export function isDetachedFrameAction(event:WorkspaceViewportEvent):boolean {
  return event.type==='key'&&event.key===' '&&!event.release||event.type==='clear'&&event.kind==='selection';
}
export function assertDetachedFrameTarget(current:DetachedFrameTarget,event:WorkspaceViewportEvent):void {
  if(!isDetachedFrameAction(event))return;
  const target=event.detachedFrameTarget;
  if(!target||target.documentId!==current.documentId||target.revision!==current.revision||target.documentEpoch!==current.documentEpoch
    ||target.projectionSerial!==current.projectionSerial||target.exportSourceIdentity!==current.exportSourceIdentity
    ||(target.renderIdentity||current.renderIdentity)&&!sameViewportRenderIdentity(target.renderIdentity,current.renderIdentity)){
    throw Error('独立窗口所属文档或科学帧已变化，请在当前画面重新操作。');
  }
}
/** Requires a source-bound intent whenever the owner presents a scientific frame.
 * Camera, save and detached frame actions retain their own scopes. */
export function isFrameBondViewportEdit(event:WorkspaceViewportEvent):boolean {
 if(event.type==='object-delete')return ['bond','auxiliary','port'].includes(event.pick.kind);
 if(event.type==='command'){
  const command=event.command;return ['set-bond-order','break-bond','infer-bonds','delete-objects'].includes(command.type)
    ||command.type==='legacy'&&['set-bond','delete-bond'].includes(command.command.type);
 }
 return event.type==='key'&&(['Delete','Backspace'].includes(event.key)||/^[1-5]$/.test(event.key)
  ||Boolean((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())));
}
export function frameBondTargetCurrent(state:FrameBondEditingState|undefined,projectionSerial:number|undefined,event:WorkspaceViewportEvent):boolean {
 const target=event.frameBondTarget;if(!target)return !state||!isFrameBondViewportEdit(event);
 return Boolean(state&&target.frameKey===state.frameKey&&Number.isSafeInteger(target.projectionSerial)&&target.projectionSerial>=0&&target.projectionSerial===projectionSerial);
}
type CameraRequest = NonNullable<ModelViewportProps['cameraRequest']>;
export type ModelCameraCommand = {kind:'reset'}|{kind:'view';view:number[]}|{kind:'zoom';factor:number}|Omit<CameraRequest,'serial'>;
export interface ModelBondPerceptionRequest {
  method?:'empirical'|'gfn2';
  mode:'supplement'|'rebuild';
  parameters?:Partial<EmpiricalBondPerceptionParameters>;
  electronic?:{charge:number;multiplicity:number};
  solvent?:string;
  maxSccIterations?:number;
}
export interface WorkspaceModelCommandPort {
  frameKey():string|undefined;
  selection():ModelSelection;
  subscribeObservedSelection(listener:(change:{revision:number;frameKey:string|undefined})=>void):()=>void;
  edit(expectedRevision:number,commands:ModelCommand[],background?:boolean):ModelDocument;
  select(expectedRevision:number,selection:ModelSelection):ModelSelection;
  history(expectedRevision:number,direction:'undo'|'redo'):boolean;
  source(expectedRevision:number):ModelDocument;
  camera(expectedRevision:number,command:ModelCameraCommand):CameraZoomReceipt|void;
  inspectCrystal(expectedRevision:number,request:PeriodicInspectRequest):Promise<unknown>;
  transform(expectedRevision:number,request:StructureTransformEdit|PeriodicModelingRequest|CellEditorRequest,derive:boolean):Promise<void>;
  perceiveBonds(expectedRevision:number,request:ModelBondPerceptionRequest,signal?:AbortSignal):Promise<unknown>;
}
/** The workspace owner supplies this locally after authenticating the detached window. */
export interface WorkspaceViewportDispatchContext {detached?:true}
export interface WorkspaceViewportController { dispatch(event:WorkspaceViewportEvent,source?:WorkspaceViewportDispatchContext):void|Promise<void>;isBusy():boolean;cancelInteraction?():void;getCameraView?():number[]|undefined;getCameraZoomDistance?():number|undefined;preoptimize?(settings?:Omit<import('../results/analysis-canvas').WorkspaceSpaceOptimizationRequest,'source'|'onRunStarted'>):Promise<void>;model?:WorkspaceModelCommandPort }
/** An independent window can hold a valid result ID after its collection was
 * replaced. Check the complete publication identity before consuming a command. */
export function trajectoryPlaybackEventCurrent(state:TrajectoryPlaybackState,event:Extract<WorkspaceViewportEvent,{type:'trajectory-playback'}>):boolean {
 if(state.resultId!==event.resultId||state.projectionKey!==event.projectionKey)return false;
 const current=state.collectionIdentity,submitted=event.collectionIdentity;
 if(!current||!submitted)return current===submitted;
 return current.ownerId===submitted.ownerId&&current.collectionId===submitted.collectionId
  &&current.sourceId===submitted.sourceId&&current.sourceGeneration===submitted.sourceGeneration
  &&current.revision===submitted.revision&&current.stageId===submitted.stageId;
}
export function viewportJSON(value:unknown):JsonValue {return normalizeWorkspaceJSON(value) as JsonValue;}
/** Snapshot-only wire admission. Commands keep the generic JSON guard above. */
export function viewportSnapshotJSON(value:WorkspaceViewportState):JsonValue {return normalizeWorkspaceViewportJSON(value) as unknown as JsonValue;}
