import type {Structure} from '../../../core/types';
import {cipGeometryComponentInputs,cipGeometryInput,readCarbonCipLabels,type CarbonCipLabel} from '../../../core/stereochemistry-cip';

const empty:ReadonlyMap<number,CarbonCipLabel>=new Map();
export interface CipDisplayUsage {sourceId:string;software:'Indigo';version:'1.46.0';operation:'calculateCip';status:'succeeded';assignments:{atomId:string;element:'C';label:CarbonCipLabel}[]}
export interface CipLabelWarning {identity:string;reason:string;partial?:boolean}
interface CipResult {labels:ReadonlyMap<number,CarbonCipLabel>;sourceId?:string;warning?:CipLabelWarning}
export const emptyCarbonCip:CipResult={labels:empty};
interface CipSource {result?:CipResult; failure?:CipResult}
const noIssues = {};
// Camera and style projections preserve these immutable scientific arrays.
const cache = new WeakMap<Structure['atoms'], WeakMap<NonNullable<Structure['bonds']>, WeakMap<object, CipSource>>>();

/** Results may have a separately owned scientific graph. An unbound graph
 * or a projection from any other frame must never label the displayed atoms. */
export function cipStructureForDisplay(displayed: Structure, projected?: Structure | null): Structure | undefined {
  if (projected === undefined) return displayed;
  if (!projected || displayed.dimension === 2 || displayed.cell?.pbc.some(Boolean) ||
      displayed.periodicSource?.completeness === 'partial') return;
  if (projected.atoms === displayed.atoms) return projected;
  if (projected.atoms.length !== displayed.atoms.length || projected.atoms.some((atom, index) => {
    const current = displayed.atoms[index];
    return !atom.id || atom.id !== current.id || atom.element !== current.element ||
      (atom.formalCharge ?? 0) !== (current.formalCharge ?? 0) ||
      atom.hydrogenMode !== current.hydrogenMode || atom.aromaticHydrogen !== current.aromaticHydrogen ||
      atom.x !== current.x || atom.y !== current.y || atom.z !== current.z;
  })) return;
  return projected;
}

export function carbonCipSource(structure: Structure | undefined): CipSource | undefined {
  if (!structure || structure.dimension === 2 || structure.cell?.pbc.some(Boolean) ||
      structure.periodicSource?.completeness === 'partial' || !structure.atoms.length || !structure.bonds?.length) return;
  let byBonds = cache.get(structure.atoms);
  if (!byBonds) { byBonds = new WeakMap(); cache.set(structure.atoms, byBonds); }
  let byIssues = byBonds.get(structure.bonds);
  if (!byIssues) { byIssues = new WeakMap(); byBonds.set(structure.bonds, byIssues); }
  const issues = structure.bondPerceptionIssues ?? noIssues;
  let source = byIssues.get(issues);
  if (!source) { source = {}; byIssues.set(issues, source); }
  return source;
}

function retainResult(source: CipSource, value: CipResult) {
  if (value.warning) source.failure = value;
  else { source.result = value; source.failure = undefined; }
}
export function preparedCarbonCipUsage(structure:Structure,hiddenAtomIds:readonly string[]=[]):CipDisplayUsage|undefined{
  const source=carbonCipSource(structure),value=source?.result??source?.failure;
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
    const run=async(fragment:typeof input)=>{
      const ket=await service.calculateGeometryCip(fragment.mol,signal);
      signal.throwIfAborted();
      return readCarbonCipLabels(fragment,ket);
    };
    try{
      return {labels:await run(input),sourceId};
    }catch(error){
      signal.throwIfAborted();
      const components=cipGeometryComponentInputs(input);
      if(!components.length)throw error;
      const labels=new Map<number,CarbonCipLabel>(),failures=new Set<string>();
      for(const component of components){
        try{
          for(const [index,label] of await run(component))labels.set(index,label);
        }catch(error){
          signal.throwIfAborted();
          failures.add(error instanceof Error?error.message:String(error));
        }
      }
      if(!failures.size)return {labels,sourceId};
      const reason=[...failures].join('；');
      return {labels,sourceId,warning:{identity:sourceId+':'+reason,reason,partial:labels.size>0}};
    }
  }catch(error){
    signal.throwIfAborted();
    const reason=error instanceof Error?error.message:String(error);
    return {labels:empty,warning:{identity:(sourceId??'cip-geometry')+':'+reason,reason}};
  }
}
/** Offscreen capture awaits the annotation before reading pixels. Its caller
 * can leave immediately on abort while an already posted worker call drains. */
export async function prepareCarbonCipLabels(structure:Structure|undefined,signal=new AbortController().signal):Promise<void>{
  const source=carbonCipSource(structure);
  if(!structure||!source||source.result||source.failure)return;
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    void calculate(structure,signal).then(result=>{
      if(!signal.aborted)retainResult(source,result);
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
        const value=request.source?.result??request.source?.failure??await calculate(request.structure(),controller.signal);
        if(controller.signal.aborted)return;
        if(request.source)retainResult(request.source,value);
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
