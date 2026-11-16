import type {Structure} from '../../../core/types';
import {cipGeometryInput,readCarbonCipLabels,type CarbonCipLabel} from '../../../core/stereochemistry-cip';

const empty:ReadonlyMap<number,CarbonCipLabel>=new Map();
export interface CipDisplayUsage {sourceId:string;software:'Indigo';version:'1.46.0';operation:'calculateCip';status:'succeeded';assignments:{atomId:string;element:'C';label:CarbonCipLabel}[]}
export interface CipLabelWarning {identity:string;reason:string}
interface CipResult {labels:ReadonlyMap<number,CarbonCipLabel>;sourceId?:string;warning?:CipLabelWarning}
export const emptyCarbonCip:CipResult={labels:empty};
interface CipSource {result?:CipResult}
// Scientific drafts and prepared frames publish immutable atom and bond arrays.
// Camera, style and other display projections keep those scientific identities.
const cache=new WeakMap<Structure['atoms'],WeakMap<NonNullable<Structure['bonds']>,CipSource>>();
export function carbonCipSource(structure:Structure):CipSource|undefined {
  if(structure.dimension===2||structure.cell?.pbc.some(Boolean)||!structure.atoms.length||!structure.bonds?.length)return;
  let byBonds=cache.get(structure.atoms);
  if(!byBonds){byBonds=new WeakMap();cache.set(structure.atoms,byBonds);}
  let source=byBonds.get(structure.bonds);
  if(!source){source={};byBonds.set(structure.bonds,source);}
  return source;
}
export function preparedCarbonCipUsage(structure:Structure,hiddenAtomIds:readonly string[]=[]):CipDisplayUsage|undefined{
  const value=carbonCipSource(structure)?.result;
  if(!value?.sourceId||!value.labels.size)return;
  const hidden=new Set(hiddenAtomIds),assignments=[...value.labels].flatMap(([index,label])=>{const atom=structure.atoms[index];return atom?.id&&!hidden.has(atom.id)?[{atomId:atom.id,element:'C' as const,label}]:[];});
  if(assignments.length)return {sourceId:value.sourceId,software:'Indigo',version:'1.46.0',operation:'calculateCip',status:'succeeded',assignments};
}
async function calculate(structure:Structure,signal:AbortSignal):Promise<CipResult>{
  signal.throwIfAborted();
  const input=cipGeometryInput(structure);
  if(!input?.eligibleCarbons.size)return emptyCarbonCip;
  let sourceId:string|undefined;
  try{
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.mol));
    sourceId='cip-geometry-sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    signal.throwIfAborted();
    const service=await import('../two-d-editor-service');
    const ket=await service.calculateGeometryCip(input.mol,signal);
    signal.throwIfAborted();
    return {labels:readCarbonCipLabels(input,ket),sourceId};
  }catch(error){
    signal.throwIfAborted();
    const reason=error instanceof Error?error.message:String(error);
    return {labels:empty,warning:{identity:(sourceId??'cip-geometry')+':'+reason,reason}};
  }
}
/** Offscreen capture awaits the annotation before reading pixels. Its caller
 * can leave immediately on abort while an already posted worker call drains. */
export async function prepareCarbonCipLabels(structure:Structure,signal=new AbortController().signal):Promise<void>{
  const source=carbonCipSource(structure);
  if(!source||source.result)return;
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    void calculate(structure,signal).then(result=>{
      if(!signal.aborted)source.result=result;
      resolve();
    },reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
interface CipRequest {
  key:object;
  structure():Structure;
  source?:CipSource;
  publish(result:CipResult):void|Promise<void>;
  onError(error:unknown):void;
}
interface RunningCip {request:CipRequest;controller:AbortController}

/** Each viewport has one current worker lease and one replaceable pending
 * request. A posted call must drain through the shared editor transport before
 * another starts. Aborted work never publishes or populates the source cache. */
export function createCarbonCipRequests(){
  let running:RunningCip|undefined,pending:CipRequest|undefined,scheduled=false;
  function schedule(){
    if(scheduled||running||!pending)return;
    scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;
      const request=pending;
      if(!request||running)return;
      pending=undefined;
      const controller=new AbortController(),own={request,controller};running=own;
      void (async()=>{
        const value=request.source?.result??await calculate(request.structure(),controller.signal);
        if(controller.signal.aborted)return;
        if(request.source)request.source.result=value;
        await own.request.publish(value);
      })().catch(error=>{if(!controller.signal.aborted)own.request.onError(error);}).finally(()=>{
        running=undefined;schedule();
      });
    });
  }
  return {
    request(request:CipRequest){
      if(running&&!running.controller.signal.aborted&&running.request.key===request.key){
        running.request=request;pending=undefined;return;
      }
      running?.controller.abort();
      pending=request;
      schedule();
    },
    cancel(){
      pending=undefined;
      running?.controller.abort();
    }
  };
}
