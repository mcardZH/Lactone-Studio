import type {AnalysisCanvas} from '../results/analysis-canvas';
import type {PesGroup,PesNode} from '../../modeling/pes/contracts';
import {currentWorkbenchResult,editableNodeActiveRun} from '../../modeling/pes/controller';

/** The protection rule also applies before a restored reader publishes its canvas. */
export function pesNodeObserving(group:PesGroup|undefined,node:PesNode|undefined):boolean {
  if(!group||!node)return false;
  if(node.kind==='result'||node.kind==='snapshot')return true;
  const active=editableNodeActiveRun(group,node.id);
  return active?.request.operation==='opt'?false:Boolean(currentWorkbenchResult(group,node.id)||active);
}

export interface PesCanvasOwner {id:string;epoch:string}
export interface PesCanvasProjection {documentId:string;canvas:AnalysisCanvas;observation:boolean}
export type PesCanvasCache=ReadonlyMap<string,{epoch:string;projection:PesCanvasProjection}>;

/** Published views are document-lifetime owned; clearing A cannot erase B or
 * a restored document that happens to reuse A's ID. */
export function updatePesCanvas(cache:PesCanvasCache,owner:PesCanvasOwner,value:PesCanvasProjection|null):PesCanvasCache {
  const previous=cache.get(owner.id);
  if(value&&value.documentId!==owner.id)return cache;
  if(!value){if(previous?.epoch!==owner.epoch)return cache;const next=new Map(cache);next.delete(owner.id);return next;}
  if(previous?.epoch===owner.epoch&&previous.projection.canvas===value.canvas&&previous.projection.observation===value.observation)return cache;
  const next=new Map(cache);next.set(owner.id,{epoch:owner.epoch,projection:value});return next;
}
export function currentPesCanvas(cache:PesCanvasCache,owner:PesCanvasOwner|undefined):PesCanvasProjection|undefined {
  if(!owner)return;
  const value=cache.get(owner.id);return value?.epoch===owner.epoch?value.projection:undefined;
}
export function retainPesCanvases(cache:PesCanvasCache,owners:readonly PesCanvasOwner[]):PesCanvasCache {
  const valid=new Map(owners.map(owner=>[owner.id,owner.epoch]));
  if([...cache].every(([id,value])=>valid.get(id)===value.epoch))return cache;
  return new Map([...cache].filter(([id,value])=>valid.get(id)===value.epoch));
}
