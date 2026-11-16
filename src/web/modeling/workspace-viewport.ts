import type {ModelViewportProps} from './ModelViewport';
import type {JsonValue} from '../../modeling/workspace-contracts';
import type {DisplaySettings,InteractionState,ModelCommand,ModelSelection,PickResult} from '../../modeling/contracts';
import type {AtomStateAction,ViewportObjectState,ViewportStateMarker} from './viewport-overlays';
import {normalizeWorkspaceJSON,normalizeWorkspaceViewportJSON} from '../../modeling/platform/workspace-bridge';
import type {ViewportDisplayDescriptor} from './viewport-display-channel';
import type {CellEditorViewportDraft} from './CellEditorPanel';
import type {SamplingSphereViewportDraft} from '../../modeling/advanced/sampling-sphere';
import type {TrajectoryPlaybackCommand,TrajectoryPlaybackState} from '../results/trajectory-playback-bridge';
import type {PlaybackCollectionIdentity} from '../../results/playback-collection';
import type {CipViewportUsage} from './use-cip-usage';

/** A display/interaction projection only. The one ModelStore and native owner
 * remain in the main workspace; no history or executable callbacks cross IPC. */
type DataKeys = {[K in keyof ModelViewportProps]: NonNullable<ModelViewportProps[K]> extends (...args:any[])=>any ? never : K}[keyof ModelViewportProps];
export type WorkspaceViewportState = Partial<Pick<ModelViewportProps,Exclude<DataKeys,undefined|'document'>>> & {
  frameBondEditing?:FrameBondEditingState;
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
export function checkedFrameBondEditing(value:FrameBondEditingState):FrameBondEditingState {
 const tuple=JSON.parse(value.frameKey);
 if(!value||Object.keys(value).some(key=>!['frameKey','blocked','canUndo','canRedo'].includes(key))||!Array.isArray(tuple)||tuple.length!==5
  ||![tuple[0],tuple[1],tuple[3],tuple[4]].every(part=>typeof part==='string'&&part.length>0)||!Number.isSafeInteger(tuple[2])||tuple[2]<0
  ||![value.blocked,value.canUndo,value.canRedo].every(part=>typeof part==='boolean'))throw Error('帧显示键编辑能力身份无效。');
 return value;
}
export type WorkspaceViewportEvent = ({frameBondTarget?:FrameBondTarget}&(
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
/** Requires a source-bound intent whenever the owner presents a scientific frame.
 * Camera, ordinary observation, save and Space playback retain their own scopes. */
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
export interface WorkspaceViewportController { dispatch(event:WorkspaceViewportEvent):void|Promise<void>;isBusy():boolean;cancelInteraction?():void;getCameraView?():number[]|undefined;preoptimize?():Promise<void> }
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
