import type {Structure} from '../../../core/types';
import {cipGeometryInput,readCarbonCipLabels,type CarbonCipLabel} from '../../../core/stereochemistry-cip';

const empty:ReadonlyMap<number,CarbonCipLabel>=new Map();
export interface CipDisplayUsage {sourceId:string;software:'Indigo';version:'1.46.0';operation:'calculateCip';status:'succeeded';assignments:{atomId:string;element:'C';label:CarbonCipLabel}[]}
export interface CipLabelWarning {identity:string;reason:string}
interface PreparedCip {key:string;labels?:ReadonlyMap<number,CarbonCipLabel>;sourceId?:string;warning?:CipLabelWarning;pending?:Promise<ReadonlyMap<number,CarbonCipLabel>>}
// The frame/structure owner holds its source arrays. Weak keys retain prepared
// frames while that owner lives, without a size cap or an application-wide leak.
const cache=new WeakMap<Structure['atoms'],WeakMap<NonNullable<Structure['bonds']>,PreparedCip>>();
function entry(structure:Structure):{input:ReturnType<typeof cipGeometryInput>;value?:PreparedCip}{
  const input=cipGeometryInput(structure);if(!input)return {input};
  let byBonds=cache.get(structure.atoms);if(!byBonds){byBonds=new WeakMap();cache.set(structure.atoms,byBonds);}
  const previous=byBonds.get(structure.bonds!);if(previous?.key===input.mol)return {input,value:previous};
  const value:PreparedCip={key:input.mol};byBonds.set(structure.bonds!,value);return {input,value};
}
export function preparedCarbonCipLabels(structure:Structure):ReadonlyMap<number,CarbonCipLabel>{return entry(structure).value?.labels??empty;}
export function preparedCarbonCipWarning(structure:Structure):CipLabelWarning|undefined{return entry(structure).value?.warning;}
export function preparedCarbonCipUsage(structure:Structure,hiddenAtomIds:readonly string[]=[]):CipDisplayUsage|undefined{
  const value=entry(structure).value;if(!value?.sourceId||!value.labels?.size)return;
  const hidden=new Set(hiddenAtomIds),assignments=[...value.labels].flatMap(([index,label])=>{const atom=structure.atoms[index];return atom?.id&&!hidden.has(atom.id)?[{atomId:atom.id,element:'C' as const,label}]:[];});
  if(assignments.length)return {sourceId:value.sourceId,software:'Indigo',version:'1.46.0',operation:'calculateCip',status:'succeeded',assignments};
}
export async function prepareCarbonCipLabels(structure:Structure,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const {input,value}=entry(structure);if(!input||!value||value.labels)return;
  // Import only after the user enables the feature. Browser worker ownership
  // stays with the already shared standalone service, never with a single draw.
  value.pending??=(async()=>{
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.mol));value.sourceId='cip-geometry-sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    try{const service=await import('../two-d-editor-service');return value.labels=readCarbonCipLabels(input,await service.calculateGeometryCip(input.mol));}
    catch(error){const reason=error instanceof Error?error.message:String(error);value.warning={identity:value.sourceId+':'+reason,reason};return value.labels=empty;}
  })().catch(error=>{value.pending=undefined;throw error;});
  if(!signal){await value.pending;return;}
  // Cancellation releases this draw immediately. It does not terminate the
  // shared worker or another consumer's request; a completed result may cache.
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new DOMException('显示准备已取消。','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    value.pending!.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
    if(signal.aborted)abort();
  });signal.throwIfAborted();
}
