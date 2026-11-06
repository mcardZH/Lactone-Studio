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
export type WorkspaceViewportEvent =
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
 | {type:'display-subscribe';channelToken:string};
export interface WorkspaceViewportController { dispatch(event:WorkspaceViewportEvent):void|Promise<void>;isBusy():boolean;cancelInteraction?():void;getCameraView?():number[]|undefined }
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
