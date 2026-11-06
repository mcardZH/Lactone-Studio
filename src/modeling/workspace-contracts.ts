import type { InputStructureSource } from '../core/types';
import type { ClipboardPayload, ChemistryRequest, ModelCommand, ModelCoordinate, ModelDocument, ModelSelection } from './contracts';
import type { BuilderAssignments } from '../core/builder-draft';
import type { DynamicsCommand, DynamicsRequest } from './dynamics/contracts';

export type WorkspaceModule = 'modeling' | 'advanced-modeling' | 'input' | 'advanced' | 'analysis' | 'plot';
/** Shared views route history to the workspace owner, including derived tabs. */
export interface WorkspaceHistoryOwner {
  undo(documentId?:string):boolean;
  redo(documentId?:string):boolean;
}
export type WorkspaceViewKind = 'tab' | 'comparison' | 'floating';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]:JsonValue };
export interface WorkspaceActivationStamp {
  documentId:string; documentEpoch:string; revision:number;
  viewId:string; activationEpoch:number;
}
/** One resumable input owner, independent of the currently focused model view. */
export interface WorkspaceInputTask { id:string; documentId:string; activationEpoch:number }
export interface WorkspaceInputTaskStamp {
  taskId:string; documentId:string; documentEpoch:string; revision:number; activationEpoch:number;
}
export interface WorkspaceTaskSource extends InputStructureSource { documentEpoch:string; sourceEpoch:number }
/** A result collection has an immutable producer identity, separate from its
 * editable document and from the currently observed frame. */
export interface WorkspaceTrajectoryIdentity {
  taskId:string; runId:string; stageId:string; collectionId:string;
}
export interface WorkspaceTrajectoryBinding {
  identity:Readonly<WorkspaceTrajectoryIdentity>;
  frameIds:readonly string[];
  currentFrameId:string;
}
export type WorkspaceConformerGroup = {taskId:string;role:'collection'} | {taskId:string;role:'initial';initialId?:string;initialIndex?:number};
export interface WorkspaceDiscardDocument {
  id:string;epoch:string;revision:number;sourceEpoch:number;label:string;
  hasData:boolean;readOnly:boolean;consumerIds:readonly string[];consumerReasons:readonly string[];
}
/** An immutable impact preview. Registry-issued plans carry an internal
 * identity lease; serialized/copied plans cannot authorize a later discard. */
export interface WorkspaceDiscardPlan {
  id:string;rootDocumentIds:readonly string[];documentIds:readonly string[];
  documents:readonly WorkspaceDiscardDocument[];requiresConfirmation:boolean;
}
/** Prepare is read-only; commit removes logical ownership synchronously.
 * Release follows actual worker/IO completion and can report pending cleanup. */
export interface WorkspaceDiscardTransaction {
  /** Existing runtime/source consumer memberships retired by this owner. */
  readonly consumerIds?:readonly string[];
  assertCurrent?():void;
  commit():void;
  release():Promise<void>;
}
export interface WorkspaceContext { assignments:BuilderAssignments; coordinates:ModelCoordinate[] }
export interface WorkspaceDocumentSnapshot {
  schema:'sciyue-workspace-document'; version:1; documentEpoch:string; publicationSerial:number;
  /** Replica history is empty; Undo/Redo is executed by the authoritative owner. */
  document:ModelDocument;
  contexts?:{gaussian?:WorkspaceContext;orca?:WorkspaceContext};
  metadata?:{label:string;electronicStateConfirmed:boolean;sourceEpoch:number;inputDirty:{gaussian:boolean;orca:boolean}};
  ui?:JsonValue; runtime?:JsonValue; viewport?:JsonValue;
}
export type WorkspaceCommand =
  | {type:'model.execute'; command:ModelCommand}
  | {type:'model.select'; selection:ModelSelection}
  | {type:'model.undo'|'model.redo'}
  | {type:'model.context'; engine:'gaussian'|'orca'; context:WorkspaceContext}
  | {type:'model.electronic-state'; charge:number; multiplicity:number}
  | {type:'chemistry.start'; request:ChemistryRequest; jobId:string}
  | {type:'chemistry.cancel'; jobId:string}
  | {type:'dynamics.start'; request:DynamicsRequest; sessionId:string}
  | {type:'dynamics.command'; sessionId:string; command:DynamicsCommand}
  | {type:'input.draft-update'; engine:'gaussian'|'orca'; value:JsonValue}
  | {type:'workspace.close-view';viewId:string}
  | {type:'workspace.viewport-event';event:JsonValue};
export interface WorkspaceMembership {
  schema:'sciyue-workspace-document';version:1;documentId:string;
  ownerWindowId:string;memberWindowId:string;isOwner:boolean;membershipNonce:string;
  revision:number;snapshot:WorkspaceDocumentSnapshot;
}
export type WorkspaceDocumentEvent =
  | {kind:'placement';schema:'sciyue-workspace-document';version:1;documentId:string;ownerWindowId:string;detachedWindowId:string|null}
  | {kind:'activate-document';schema:'sciyue-workspace-document';version:1;documentId:string;ownerWindowId:string}
  | {kind:'close-request';schema:'sciyue-workspace-document';version:1;documentId:string;requestId:string;requesterWindowId:string}
  | {kind:'close-state';schema:'sciyue-workspace-document';version:1;documentId:string;requestId:string;requesterWindowId:string;phase:'pending'|'cancelled'|'failed'}
  | {kind:'owner-view-hidden';schema:'sciyue-workspace-document';version:1;ownerWindowId:string}
  | {kind:'owner-view-restored';schema:'sciyue-workspace-document';version:1;ownerWindowId:string}
  | {kind:'activate-owner';schema:'sciyue-workspace-document';version:1;documentId:string;ownerWindowId:string}
  | ({kind:'snapshot'} & WorkspaceMembership)
  | {kind:'command';schema:'sciyue-workspace-document';version:1;documentId:string;requestId:string;requesterWindowId:string;expectedRevision:number;command:WorkspaceCommand}
  | {kind:'unavailable';schema:'sciyue-workspace-document';version:1;documentId:string;reason:'owner-closed'|'document-closed'};
export interface WorkspaceMemberAuth {documentId:string;membershipNonce:string}
export interface WorkspaceDesktopBridge {
  workspaceWindowGeometry?():Promise<{x:number;y:number;width:number;height:number}>;
  detachWorkspaceDocument?(request:WorkspaceMemberAuth&{placement?:{x?:number;y?:number;width?:number;height?:number}}):Promise<{windowId:string}>;
  dockWorkspaceDocument?(request:WorkspaceMemberAuth):Promise<{status:'docked'}>;
  activateWorkspaceDocument?(request:WorkspaceMemberAuth):Promise<{status:'activated'}>;
  requestWorkspaceDocumentClose?(request:WorkspaceMemberAuth):Promise<{status:'closed'|'cancelled'}>;
  /** Owner-only confirmation; the host chooses the original requester's native
   * window from its pending close transaction, never from caller-supplied IDs. */
  confirmWorkspaceDocumentClose?(request:WorkspaceMemberAuth&{requestId:string}):Promise<{decision:'cancel'|'discard'}>;
  /** Owner-authenticated prompt shown on this document's actual floating window. */
  confirmWorkspaceScientificEdit?(request:WorkspaceMemberAuth&{expectedRevision:number;copyOnly?:boolean;purpose?:'file-import'}):Promise<{decision:'current'|'copy'|'cancel'}>;
  replyWorkspaceDocumentClose?(request:WorkspaceMemberAuth&{requestId:string;status:'closed'|'cancelled';error?:string}):Promise<{status:'closed'|'cancelled'}>;
  restoreWorkspaceOwner?(request:WorkspaceMemberAuth):Promise<{status:'shown'|'restored-headless';windowId:string}>;
  registerWorkspaceDocument(request:{documentId:string;revision:number;snapshot:WorkspaceDocumentSnapshot}):Promise<WorkspaceMembership>;
  readWorkspaceDocuments():Promise<WorkspaceMembership[]>;
  publishWorkspaceDocument(request:WorkspaceMemberAuth&{expectedRevision:number;revision:number;snapshot:WorkspaceDocumentSnapshot}):Promise<WorkspaceMembership>;
  commandWorkspaceDocument(request:WorkspaceMemberAuth&{expectedRevision:number;command:WorkspaceCommand}):Promise<WorkspaceMembership&{status:'committed'}>;
  replyWorkspaceDocumentCommand(request:WorkspaceMemberAuth&({requestId:string;status:'committed';revision:number;snapshot:WorkspaceDocumentSnapshot}|{requestId:string;status:'rejected';error:string})):Promise<unknown>;
  leaveWorkspaceDocument(request:WorkspaceMemberAuth):Promise<unknown>;
  closeWorkspaceDocument(request:WorkspaceMemberAuth):Promise<unknown>;
  onWorkspaceDocumentEvent(listener:(event:WorkspaceDocumentEvent)=>void):()=>void;
}
export interface CopiedFragmentPlacement {
  payload:ClipboardPayload;activeIndex:number;mode:'independent'|'graft';
  position:[number,number,number];rotation?:[[number,number,number],[number,number,number],[number,number,number]];
  targetAtomId?:string;targetPortId?:string;consumeHydrogenIds?:string[];consumePortIds?:string[];
}
