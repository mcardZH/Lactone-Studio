import type {Structure} from '../core/types';
import {isImmutableAdvancedProjectStructure,rememberDecodedAdvancedProjectStructure,type AdvancedProjectSnapshot} from './advanced-snapshot';
import type {ProjectAssetReader,ProjectAssetWriter} from './result-snapshot';
import {PROJECT_ASSET_BATCH_COUNT,PROJECT_CHUNK_BYTES,type ProjectAssetWrite} from './desktop-bridge';

type Value=null|boolean|number|string|{ref:number};
type Node={kind:'object';entries:[string,Value][]}|{kind:'array';values:Value[]}|{kind:'structure';assetId:string;bytes:number};
export interface AdvancedAssetSnapshot {schema:'ester-advanced-assets/v1';version:1;root:Value;nodes:Node[];assetReferences:string[]}
export interface RetainedAdvancedTasks {
 graph:AdvancedAssetSnapshot;
 originalOrder:string[];
 unavailable:string[];
}
const text=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const invalid=()=>new Error('项目高级任务共享引用或科学资产无效。');
const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(v=>v.toString(16).padStart(2,'0')).join('');
type StructureNode=Extract<Node,{kind:'structure'}>;
const immutableAssetAddresses=new WeakMap<Structure,StructureNode>();
function scientificJSON(value:unknown){return JSON.stringify(value,(_key,part)=>{if(typeof part==='function'||part instanceof Map||part instanceof Set||ArrayBuffer.isView(part)||typeof part==='number'&&!Number.isFinite(part))throw invalid();return part;});}
function structureAtomIds(value:unknown):Set<string>|undefined{
 const s=value as Structure;if(!s||typeof s!=='object'||typeof s.id!=='string'||typeof s.name!=='string'||typeof s.format!=='string'||!Array.isArray(s.atoms)||!s.atoms.length||!Array.isArray(s.notes))return;
 const ids=new Set<string>();for(const atom of s.atoms){if(!atom||typeof atom.id!=='string'||!atom.id||ids.has(atom.id)||typeof atom.element!=='string'||!Number.isFinite(atom.x)||!Number.isFinite(atom.y)||!Number.isFinite(atom.z))return;ids.add(atom.id);}
 if(s.bonds!==undefined&&(!Array.isArray(s.bonds)||s.bonds.some(b=>!b||!Number.isSafeInteger(b.a)||!Number.isSafeInteger(b.b)||b.a<0||b.b<0||b.a>=s.atoms.length||b.b>=s.atoms.length||b.a===b.b)))return;
 if((s.charge===null||Number.isFinite(s.charge))&&(s.multiplicity===null||Number.isFinite(s.multiplicity)))return ids;
}
function structure(value:unknown):value is Structure{return !!structureAtomIds(value);}
function assertSnapshot(snapshot:AdvancedProjectSnapshot){
 if(!snapshot||![1,2].includes(snapshot.schema)||!Array.isArray(snapshot.tasks))throw invalid();
 const verifiedSources=new WeakSet<object>();
 const source=(value:unknown)=>{const s=value as import('../modeling/advanced/frame-source').AdvancedFrameSource;
  if(!s||typeof s!=='object')throw invalid();
  if(verifiedSources.has(s))return;
  const ids=structureAtomIds(s.structure);
  if(!ids||!s.ref||typeof s.ref.documentId!=='string'||typeof s.ref.documentEpoch!=='string'||!Number.isSafeInteger(s.ref.revision)||s.ref.revision<0||!s.stamp||s.stamp.documentId!==s.ref.documentId||s.stamp.revision!==s.ref.revision||!s.constraints||!Array.isArray(s.constraints.frozenAtomIds)||!Array.isArray(s.constraints.coordinates)||s.coordinateUnit!=='angstrom')throw invalid();
  if(s.constraints.frozenAtomIds.some(id=>!ids.has(id))||s.constraints.coordinates.some(row=>!row||!Array.isArray(row.atomIds)||row.atomIds.some(id=>!ids.has(id))))throw invalid();
  verifiedSources.add(s);
 };
 const frameSource=(frame:AdvancedProjectSnapshot['tasks'][number]['guessFrames'][number])=>{source(frame.source);if(frame.samplingOrigin)source(frame.samplingOrigin.source);};
 for(const task of snapshot.tasks){if(!task||!task.spec||!Array.isArray(task.guessFrames)||!Array.isArray(task.runs))throw invalid();source(task.spec.source);
  for(const frame of task.guessFrames)frameSource(frame);
  for(const run of task.runs){if(!Array.isArray(run.frames))throw invalid();for(const frame of run.frames)frameSource(frame);}
  for(const initial of task.mixedSampling?.initialGuesses??[])source(initial.source);
  for(const batch of task.mixedSampling?.batches??[]){source(batch.source);for(const card of batch.cards)for(const segment of card.segments)source(segment.source);}
 }
}
/** The outer project and trajectory formats stay unchanged. Only this explicitly
 * versioned advanced asset stores shared metadata nodes and exact structure bytes. */
export async function encodeAdvancedAsset(snapshot:AdvancedProjectSnapshot,writer:ProjectAssetWriter):Promise<AdvancedAssetSnapshot>{
 assertSnapshot(snapshot);
 const nodes:Node[]=[],memo=new WeakMap<object,number>(),active=new WeakSet<object>(),references=new Set<string>();
 let pending:ProjectAssetWrite[]=[],pendingBytes=0;
 const reusable=writer as ProjectAssetWriter&{hasAsset?(id:string):boolean;retainAsset?(id:string):void};
 const flush=async()=>{
  const values=pending;pending=[];pendingBytes=0;
  if(!values.length)return;
  const receipts=writer.writeMany?await writer.writeMany(values):undefined;
  if(receipts&&receipts.length!==values.length)throw invalid();
  for(let i=0;i<values.length;i++){
   const {category,name,bytes}=values[i],expected=name.slice(0,-5);
   const receipt=receipts?receipts[i]:await writer.write(category,name,bytes);
   if(receipt.assetId!==expected)throw invalid();
  }
 };
 const visit=async(value:unknown,key=''):Promise<Value>=>{
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw invalid();return value;}
  if(!value||typeof value!=='object'||active.has(value))throw invalid();
  const cached=memo.get(value);if(cached!==undefined)return{ref:cached};
  if(key==='structure'&&structure(value)){
   const known=immutableAssetAddresses.get(value),index=nodes.length;
   memo.set(value,index);
   if(known&&references.has(known.assetId)){nodes.push({...known});return{ref:index};}
   if(known&&reusable.retainAsset&&reusable.hasAsset?.(known.assetId)){
    nodes.push({...known});reusable.retainAsset(known.assetId);references.add(known.assetId);return{ref:index};
   }
   const bytes=text.encode(scientificJSON(value)),assetId=known?.assetId??await digest(bytes);
   const node:StructureNode={kind:'structure',assetId,bytes:bytes.length};nodes.push(node);
   if(!known&&isImmutableAdvancedProjectStructure(value))immutableAssetAddresses.set(value,Object.freeze({...node}));
   // Equal bytes share disk content, never the logical Structure instance.
   if(references.has(assetId))return{ref:index};references.add(assetId);
   if(bytes.length>PROJECT_CHUNK_BYTES){await flush();const receipt=await writer.write('trajectories',assetId+'.json',bytes);if(receipt.assetId!==assetId)throw invalid();}
   else{if(pending.length===PROJECT_ASSET_BATCH_COUNT||pendingBytes+bytes.length>PROJECT_CHUNK_BYTES)await flush();pending.push({category:'trajectories',name:assetId+'.json',bytes});pendingBytes+=bytes.length;if(pending.length===PROJECT_ASSET_BATCH_COUNT)await flush();}
   return{ref:index};
  }
  active.add(value);
  const index=nodes.length;nodes.push({kind:'array',values:[]});memo.set(value,index);
  let node:Node;
  if(Array.isArray(value)){const values:Value[]=[];for(const item of value)values.push(await visit(item));node={kind:'array',values};}
  else{const entries:[string,Value][]=[];for(const[name,item]of Object.entries(value)){if(item===undefined)continue;entries.push([name,await visit(item,name)]);}node={kind:'object',entries};}
  active.delete(value);nodes[index]=node;return{ref:index};
 };
 const root=await visit(snapshot);await flush();return{schema:'ester-advanced-assets/v1',version:1,root,nodes,assetReferences:[...references]};
}
interface TaskNode {id:string;graph:AdvancedAssetSnapshot;value:{ref:number}}

function taskNodes(graph:AdvancedAssetSnapshot):{schema:1|2;tasks:TaskNode[]} {
 const object=(part:Value|undefined)=>{
  const node=part&&typeof part==='object'?graph.nodes[part.ref]:undefined;
  if(node?.kind!=='object')throw invalid();
  return Object.fromEntries(node.entries) as Record<string,Value>;
 };
 const root=object(graph.root),array=root.tasks&&typeof root.tasks==='object'?graph.nodes[root.tasks.ref]:undefined;
 if(Object.keys(root).length!==2||(root.schema!==1&&root.schema!==2)||array?.kind!=='array')throw invalid();
 const ids=new Set<string>();
 const tasks=array.values.map(value=>{
  const id=object(value).id;
  if(!value||typeof value!=='object'||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id)||ids.has(id))throw invalid();
  ids.add(id);return {id,graph,value};
 });
 return {schema:root.schema,tasks};
}

/** Copy only the reachable metadata nodes. Coordinate blobs keep their original
 * content addresses, including the addresses of unavailable sources. */
function collectTaskGraph(schema:1|2,tasks:TaskNode[]):AdvancedAssetSnapshot {
 const values:Value[]=[],nodes:Node[]=[{kind:'object',entries:[['schema',schema],['tasks',{ref:1}]]},{kind:'array',values}];
 const maps=new Map<AdvancedAssetSnapshot,Map<number,number>>(),references=new Set<string>();
 const copy=(graph:AdvancedAssetSnapshot,part:Value,map:Map<number,number>):Value=>{
  if(part===null||typeof part!=='object')return part;
  const known=map.get(part.ref);if(known!==undefined)return {ref:known};
  const ref=nodes.length,source=graph.nodes[part.ref];
  map.set(part.ref,ref);nodes.push(source);
  if(source.kind==='structure')references.add(source.assetId);
  else if(source.kind==='array')nodes[ref]={kind:'array',values:source.values.map(v=>copy(graph,v,map))};
  else nodes[ref]={kind:'object',entries:source.entries.map(([key,v])=>[key,copy(graph,v,map)])};
  return {ref};
 };
 for(const task of tasks){
  let map=maps.get(task.graph);if(!map)maps.set(task.graph,map=new Map());
  values.push(copy(task.graph,task.value,map));
 }
 return {schema:'ester-advanced-assets/v1',version:1,root:{ref:0},nodes,assetReferences:[...references]};
}

export function mergeRetainedAdvancedTasks(current:AdvancedAssetSnapshot,retained:RetainedAdvancedTasks):AdvancedAssetSnapshot {
 const {schema,tasks}=taskNodes(current),old=taskNodes(retained.graph).tasks;
 const byId=new Map(tasks.map(row=>[row.id,row]));
 for(const row of old){
  if(byId.has(row.id))throw Error('高级任务身份与保留的受损任务冲突，原始记录仍保留。');
  byId.set(row.id,row);
 }
 const ordered:TaskNode[]=[];
 for(const id of retained.originalOrder){const row=byId.get(id);if(row){ordered.push(row);byId.delete(id);}}
 return collectTaskGraph(schema,[...ordered,...byId.values()]);
}

/** Accept old self-contained schema1 assets; new graph assets are fully checked
 * before they become a controller snapshot. Missing refs never synthesize data. */
export async function decodeAdvancedAsset(value:unknown,reader:ProjectAssetReader,onPartial?:(retained:RetainedAdvancedTasks)=>void,options:{transientReads?:boolean}={}):Promise<AdvancedProjectSnapshot>{
 if(value&&typeof value==='object'&&[1,2].includes((value as {schema:number}).schema)){const old=value as AdvancedProjectSnapshot;assertSnapshot(old);return old;}
 const data=value as AdvancedAssetSnapshot;if(!data||data.schema!=='ester-advanced-assets/v1'||data.version!==1||!Array.isArray(data.nodes)||!Array.isArray(data.assetReferences)||new Set(data.assetReferences).size!==data.assetReferences.length||data.assetReferences.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw invalid();
 const references=new Set(data.assetReferences),locations=new Map<string,{bytes:number;firstIndex:number}>();
 const exact=(part:object,keys:string[])=>Object.keys(part).length===keys.length&&keys.every(key=>Object.hasOwn(part,key));
 if(!exact(data,['schema','version','root','nodes','assetReferences']))throw invalid();
 const check=(part:Value)=>{if(part===null||typeof part==='string'||typeof part==='boolean'||typeof part==='number'&&Number.isFinite(part))return;if(!part||typeof part!=='object'||!exact(part,['ref'])||!Number.isSafeInteger(part.ref)||part.ref<0||part.ref>=data.nodes.length)throw invalid();};
 check(data.root);
 for(let index=0;index<data.nodes.length;index++){const node=data.nodes[index];if(!node||typeof node!=='object')throw invalid();
  if(node.kind==='structure'){
   const existing=locations.get(node.assetId);
   if(!exact(node,['kind','assetId','bytes'])||typeof node.assetId!=='string'||!references.has(node.assetId)||!Number.isSafeInteger(node.bytes)||node.bytes<1||existing&&existing.bytes!==node.bytes)throw invalid();
   if(!existing)locations.set(node.assetId,{bytes:node.bytes,firstIndex:index});
  }
  else if(node.kind==='array'){if(!exact(node,['kind','values'])||!Array.isArray(node.values))throw invalid();node.values.forEach(check);}
  else if(node.kind==='object'){if(!exact(node,['kind','entries'])||!Array.isArray(node.entries))throw invalid();const keys=new Set<string>();for(const entry of node.entries){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||keys.has(entry[0]))throw invalid();keys.add(entry[0]);check(entry[1]);}}
  else throw invalid();
 }
 if(locations.size!==references.size)throw invalid();
 const decoded:unknown[]=new Array(data.nodes.length),states=new Uint8Array(data.nodes.length);
 let batch:string[]=[],batchBytes=0;
 const accept=async(id:string,bytes:Uint8Array)=>{
  const location=locations.get(id)!;
  if(bytes.length!==location.bytes||await digest(bytes)!==id)throw invalid();
  const parsed=JSON.parse(decoder.decode(bytes));if(!structure(parsed))throw invalid();
  rememberDecodedAdvancedProjectStructure(parsed);decoded[location.firstIndex]=parsed;states[location.firstIndex]=2;
 };
 const unavailable=new Set<string>();
 const router=reader as ProjectAssetReader&{readManyTransient?(ids:readonly string[]):Promise<Uint8Array[]>};
 const readMany=(options.transientReads?router.readManyTransient:undefined)??reader.readMany;
 const single=async(id:string)=>{
  try{await accept(id,await reader.read(id));}
  catch(error){if(!onPartial)throw error;unavailable.add(id);}
 };
 const flush=async()=>{
  if(!batch.length)return;
  const ids=batch;batch=[];batchBytes=0;
  if(!readMany){for(const id of ids)await single(id);return;}
  try{
   const parts=await readMany.call(reader,ids);if(parts.length!==ids.length)throw invalid();
   for(let i=0;i<ids.length;i++)await accept(ids[i],parts[i]);
  }catch(error){
   if(!onPartial)throw error;
   // A group read is atomic. Verify each unresolved member on its own before
   // attributing the failure to a task, never accept an incomplete group reply.
   for(const id of ids)if(states[locations.get(id)!.firstIndex]!==2)await single(id);
  }
 };
 for(const[id,{bytes}]of locations){if(bytes>PROJECT_CHUNK_BYTES){await flush();await single(id);continue;}if(batch.length===PROJECT_ASSET_BATCH_COUNT||batchBytes+bytes>PROJECT_CHUNK_BYTES)await flush();batch.push(id);batchBytes+=bytes;if(batch.length===PROJECT_ASSET_BATCH_COUNT)await flush();}await flush();
 const read=(part:Value):unknown=>{if(part===null||typeof part!=='object')return part;const index=part.ref;if(states[index]===1)throw invalid();if(states[index]===2)return decoded[index];states[index]=1;const node=data.nodes[index];
  let item:unknown;
  if(node.kind==='structure'){
   const original=decoded[locations.get(node.assetId)!.firstIndex];if(!original)throw invalid();
   // Each distinct graph node stays independently editable. The first node
   // already owns the parsed geometry and needs no extra full-size copy.
   item=structuredClone(original);rememberDecodedAdvancedProjectStructure(item as Structure);
  }else item=node.kind==='array'?node.values.map(read):Object.fromEntries(node.entries.map(([key,value])=>[key,read(value)]));
  decoded[index]=item;states[index]=2;return item;};
 if(unavailable.size&&onPartial){
  const {schema,tasks}=taskNodes(data),blockedMemo=new Map<number,boolean>(),visiting=new Set<number>();
  const blocked=(part:Value):boolean=>{
   if(part===null||typeof part!=='object')return false;
   const ref=part.ref,prior=blockedMemo.get(ref);if(prior!==undefined)return prior;
   if(visiting.has(ref))throw invalid();visiting.add(ref);
   const node=data.nodes[ref];
   let damaged=false;
   if(node.kind==='structure')damaged=unavailable.has(node.assetId);
   else if(node.kind==='array'){for(const v of node.values)if(blocked(v))damaged=true;}
   else {for(const [,v] of node.entries)if(blocked(v))damaged=true;}
   visiting.delete(ref);blockedMemo.set(ref,damaged);return damaged;
  };
  const bad=tasks.filter(t=>blocked(t.value));
  if(!bad.length)throw invalid();
  const badIds=new Set(bad.map(t=>t.id));
  const snapshot:AdvancedProjectSnapshot={schema,tasks:tasks.filter(t=>!badIds.has(t.id)).map(t=>read(t.value) as AdvancedProjectSnapshot['tasks'][number])};
  assertSnapshot(snapshot);
  onPartial({graph:collectTaskGraph(schema,bad),originalOrder:tasks.map(t=>t.id),unavailable:[...badIds]});
  return snapshot;
 }
 const snapshot=read(data.root) as AdvancedProjectSnapshot;assertSnapshot(snapshot);return snapshot;
}
