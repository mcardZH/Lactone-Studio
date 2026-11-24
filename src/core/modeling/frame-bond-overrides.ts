import type { Structure, Bond } from '../types';
import type { ModelCommand } from '../../modeling/contracts';
import type { ModelDocument, AuxiliaryRelation, DeletedBond, AttachmentPort, ModelSelection } from './contracts';
import { sha256Utf8 } from '../file-identity';
import { validateBondSemantics, validateBondPerceptionIssues } from '../bond-semantics';

/** Source/run generation and stage are stable across append-only content updates.
 * frameId is the original source frame identity, never a sorted display position. */
export interface FrameBondIdentity { sourceId:string; resultId:string; jobIndex:number; stageId:string; frameId:string }
export interface FrameBondGraph {
  bonds:Bond[]; auxiliaryRelations:AuxiliaryRelation[]; deletedBonds:DeletedBond[]; attachmentPorts:AttachmentPort[];
  bondPerceptionIssues?:Structure['bondPerceptionIssues'];
}
export interface FrameBondOverride {
  identity:FrameBondIdentity; scientificFingerprint:string; atomIds:string[];
  graph:FrameBondGraph|null; past:(FrameBondGraph|null)[]; future:(FrameBondGraph|null)[];
}
export type FrameBondOverrides = Record<string,FrameBondOverride>;

export function frameBondIdentityKey(identity:FrameBondIdentity):string {
  if (![identity.sourceId,identity.resultId,identity.stageId,identity.frameId].every(value=>typeof value==='string'&&value.length>0)
    || !Number.isSafeInteger(identity.jobIndex)||identity.jobIndex<0) throw Error('帧显示键图的来源身份不完整。');
  return JSON.stringify([identity.sourceId,identity.resultId,identity.jobIndex,identity.stageId,identity.frameId]);
}
/** A digest, rather than another copy of the scientific coordinates in project metadata. */
export function frameBondScientificFingerprint(structure:Structure):string {
  const cell=structure.cell,partial=structure.periodicSource;
  return sha256Utf8(JSON.stringify([structure.atoms.map(atom=>[atom.id,atom.element,atom.x,atom.y,atom.z,atom.formalCharge??0]),
    cell?[cell.vectors,cell.pbc,cell.origin??[0,0,0]]:null,partial?[partial.translationVectors,partial.completeness]:null,structure.charge,structure.multiplicity]));
}
export function defaultFrameBondIdentity(document:ModelDocument):FrameBondIdentity|undefined {
  const binding=document.analysisBindingId;
  if(binding&&document.analysisFrameBondOrigin?.bindingId===binding)return document.analysisFrameBondOrigin.identity;
  return binding?{sourceId:binding,resultId:binding,jobIndex:0,stageId:'bound-structure',frameId:'0'}:undefined;
}
export function isFrameBondCommand(command:ModelCommand,selection:ModelSelection):boolean {
  if(command.type==='set-bond-order'||command.type==='break-bond'||command.type==='infer-bonds')return true;
  if(command.type==='delete-objects'){
    const picked=command.selection??selection;
    return !picked.atomIds.length&&!picked.coordinateIds?.length&&Boolean(picked.bonds.length||picked.auxiliaryIds.length||picked.portIds?.length);
  }
  if(command.type==='legacy')return command.command.type==='delete-bond'||command.command.type==='set-bond';
  return false;
}
export function frameBondGraph(document:ModelDocument):FrameBondGraph {
  return structuredClone({bonds:document.draft.structure.bonds??[],auxiliaryRelations:document.auxiliaryRelations,
    deletedBonds:document.deletedBonds,attachmentPorts:document.attachmentPorts??[],
    ...(document.draft.structure.bondPerceptionIssues?{bondPerceptionIssues:document.draft.structure.bondPerceptionIssues}:{})});
}
function entryFor(owner:ModelDocument,projected:ModelDocument,identity:FrameBondIdentity):FrameBondOverride|undefined {
  const entry=owner.frameBondOverrides?.[frameBondIdentityKey(identity)];
  if (!entry) return undefined;
  return entry.scientificFingerprint === frameBondScientificFingerprint(projected.draft.structure) ? entry : undefined;
}
/** Only the final display graph changes. Source atoms, q/M, provenance and all
 * result data remain owned by the original prepared scientific frame. */
export function applyFrameBondOverride(owner:ModelDocument,projected:ModelDocument,identity:FrameBondIdentity):ModelDocument {
  const graph=entryFor(owner,projected,identity)?.graph;
  if(!graph)return projected;
  const structure={...projected.draft.structure,bonds:graph.bonds};
  if(graph.bondPerceptionIssues)structure.bondPerceptionIssues=graph.bondPerceptionIssues;
  else delete structure.bondPerceptionIssues;
  for(const bond of graph.bonds)validateBondSemantics(bond,structure);
  validateBondPerceptionIssues(structure);
  return {...projected,draft:{...projected.draft,structure},auxiliaryRelations:graph.auxiliaryRelations,
    deletedBonds:graph.deletedBonds,attachmentPorts:graph.attachmentPorts};
}
export function frameBondHistoryState(owner:ModelDocument,projected:ModelDocument,identity:FrameBondIdentity){
  const entry=entryFor(owner,projected,identity);
  return {canUndo:Boolean(entry?.past.length),canRedo:Boolean(entry?.future.length)};
}
export function recordFrameBondOverride(owner:ModelDocument,projected:ModelDocument,identity:FrameBondIdentity,candidate:ModelDocument):FrameBondOverrides {
  const key=frameBondIdentityKey(identity),previous=entryFor(owner,projected,identity),graph=frameBondGraph(candidate);
  const shown=applyFrameBondOverride(owner,projected,identity);
  if(JSON.stringify(graph)===JSON.stringify(frameBondGraph(shown)))return owner.frameBondOverrides??{};
  const entry:FrameBondOverride={identity:structuredClone(identity),scientificFingerprint:frameBondScientificFingerprint(projected.draft.structure),
    atomIds:projected.draft.structure.atoms.map(atom=>atom.id!),graph,past:[...(previous?.past??[]),previous?.graph??null],future:[]};
  return {...owner.frameBondOverrides,[key]:entry};
}
export function replayFrameBondOverride(owner:ModelDocument,projected:ModelDocument,identity:FrameBondIdentity,direction:'undo'|'redo'):FrameBondOverrides|undefined {
  const previous=entryFor(owner,projected,identity);if(!previous)return;
  const entries=direction==='undo'?previous.past:previous.future;if(!entries.length)return;
  const next=structuredClone(previous);
  if(direction==='undo'){next.graph=next.past.pop()!;next.future.unshift(previous.graph);}
  else {next.graph=next.future.shift()!;next.past.push(previous.graph);}
  return {...owner.frameBondOverrides,[frameBondIdentityKey(identity)]:next};
}
/** Project restore checks identities and graph payload shape without pretending
 * the owner's working geometry is every historical/result frame. Exact-frame
 * scientific matching and bond validation happen when that frame is consumed. */
export function validateFrameBondOverrides(overrides:FrameBondOverrides|undefined):void {
  if(overrides===undefined)return;
  if(!overrides||Array.isArray(overrides)||typeof overrides!=='object')throw Error('项目帧显示键图无效。');
  for(const [key,entry]of Object.entries(overrides)){
    if(!entry||key!==frameBondIdentityKey(entry.identity)||!/^[a-f0-9]{64}$/.test(entry.scientificFingerprint)
      ||!Array.isArray(entry.atomIds)||entry.atomIds.some(id=>typeof id!=='string'||!id)||new Set(entry.atomIds).size!==entry.atomIds.length
      ||!Array.isArray(entry.past)||!Array.isArray(entry.future))throw Error('项目帧显示键图身份或历史无效。');
    const ids=new Set(entry.atomIds);
    for(const graph of [entry.graph,...entry.past,...entry.future]){
      if(graph===null)continue;
      if(!graph||![graph.bonds,graph.auxiliaryRelations,graph.deletedBonds,graph.attachmentPorts].every(Array.isArray))throw Error('项目帧显示键图数据无效。');
      for(const bond of graph.bonds){
        if(!Number.isSafeInteger(bond.a)||!Number.isSafeInteger(bond.b)||bond.a<0||bond.b<0||bond.a>=entry.atomIds.length||bond.b>=entry.atomIds.length||bond.a===bond.b&&!bond.image?.some(Boolean)||!Number.isFinite(bond.order)
          ||bond.image!==undefined&&(!Array.isArray(bond.image)||bond.image.length!==3||!bond.image.every(Number.isSafeInteger)))throw Error('项目帧显示键图端点无效。');
        // Coordinate-dependent evidence is checked again with its exact frame.
        if(bond.perception!=='periodic-gfn2')validateBondSemantics(bond);
      }
      if(graph.auxiliaryRelations.some(row=>!row||typeof row.id!=='string'||!ids.has(row.a)||!ids.has(row.b)||row.a===row.b||row.kind!=='auxiliary'||row.order!==.5)
        ||graph.deletedBonds.some(row=>!row||!Array.isArray(row.atomIds)||row.atomIds.length!==2||row.atomIds.some(id=>!ids.has(id)))
        ||graph.attachmentPorts.some(row=>!row||typeof row.id!=='string'||!ids.has(row.hostAtomId)||!Array.isArray(row.direction)||row.direction.length!==3||!row.direction.every(Number.isFinite)||!Number.isFinite(row.displayLength)))throw Error('项目帧显示连接数据无效。');
    }
  }
}
