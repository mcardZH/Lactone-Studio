import type {Structure} from '../core/types';
import type {AdvancedProjectSnapshot} from './advanced-snapshot';
import type {ProjectAssetReader,ProjectAssetWriter} from './result-snapshot';
import {PROJECT_ASSET_BATCH_COUNT,PROJECT_CHUNK_BYTES,type ProjectAssetWrite} from './desktop-bridge';

type Value=null|boolean|number|string|{ref:number};
type Node={kind:'object';entries:[string,Value][]}|{kind:'array';values:Value[]}|{kind:'structure';assetId:string;bytes:number};
export interface AdvancedAssetSnapshot {schema:'ester-advanced-assets/v1';version:1;root:Value;nodes:Node[];assetReferences:string[]}
const text=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const invalid=()=>new Error('项目高级任务共享引用或科学资产无效。');
const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(v=>v.toString(16).padStart(2,'0')).join('');
function scientificJSON(value:unknown){return JSON.stringify(value,(_key,part)=>{if(typeof part==='function'||part instanceof Map||part instanceof Set||ArrayBuffer.isView(part)||typeof part==='number'&&!Number.isFinite(part))throw invalid();return part;});}
function structure(value:unknown):value is Structure{
 const s=value as Structure;if(!s||typeof s!=='object'||typeof s.id!=='string'||typeof s.name!=='string'||typeof s.format!=='string'||!Array.isArray(s.atoms)||!s.atoms.length||!Array.isArray(s.notes))return false;
 const ids=new Set<string>();for(const atom of s.atoms){if(!atom||typeof atom.id!=='string'||!atom.id||ids.has(atom.id)||typeof atom.element!=='string'||![atom.x,atom.y,atom.z].every(Number.isFinite))return false;ids.add(atom.id);}
 if(s.bonds!==undefined&&(!Array.isArray(s.bonds)||s.bonds.some(b=>!Number.isSafeInteger(b.a)||!Number.isSafeInteger(b.b)||b.a<0||b.b<0||b.a>=s.atoms.length||b.b>=s.atoms.length||b.a===b.b)))return false;
 return (s.charge===null||Number.isFinite(s.charge))&&(s.multiplicity===null||Number.isFinite(s.multiplicity));
}
function assertSnapshot(snapshot:AdvancedProjectSnapshot){
 if(!snapshot||![1,2].includes(snapshot.schema)||!Array.isArray(snapshot.tasks))throw invalid();
 const source=(value:unknown)=>{const s=value as import('../modeling/advanced/frame-source').AdvancedFrameSource;
  if(!s||!structure(s.structure)||!s.ref||typeof s.ref.documentId!=='string'||typeof s.ref.documentEpoch!=='string'||!Number.isSafeInteger(s.ref.revision)||s.ref.revision<0||!s.stamp||s.stamp.documentId!==s.ref.documentId||s.stamp.revision!==s.ref.revision||!s.constraints||!Array.isArray(s.constraints.frozenAtomIds)||!Array.isArray(s.constraints.coordinates)||s.coordinateUnit!=='angstrom')throw invalid();
  const ids=new Set(s.structure.atoms.map(a=>a.id));if(s.constraints.frozenAtomIds.some(id=>!ids.has(id))||s.constraints.coordinates.some(row=>!Array.isArray(row.atomIds)||row.atomIds.some(id=>!ids.has(id))))throw invalid();
 };
 for(const task of snapshot.tasks){if(!task||!task.spec||!Array.isArray(task.guessFrames)||!Array.isArray(task.runs))throw invalid();source(task.spec.source);
  for(const frame of [...task.guessFrames,...task.runs.flatMap(run=>{if(!Array.isArray(run.frames))throw invalid();return run.frames;})]){source(frame.source);if(frame.samplingOrigin)source(frame.samplingOrigin.source);}
  for(const initial of task.mixedSampling?.initialGuesses??[])source(initial.source);
  for(const batch of task.mixedSampling?.batches??[]){source(batch.source);for(const card of batch.cards)for(const segment of card.segments)source(segment.source);}
 }
}
/** The outer project and trajectory formats stay unchanged. Only this explicitly
 * versioned advanced asset stores shared metadata nodes and exact structure bytes. */
export async function encodeAdvancedAsset(snapshot:AdvancedProjectSnapshot,writer:ProjectAssetWriter):Promise<AdvancedAssetSnapshot>{
 assertSnapshot(snapshot);
 const nodes:Node[]=[],memo=new WeakMap<object,number>(),active=new WeakSet<object>(),queuedAssets=new Set<string>(),references=new Set<string>();
 let pending:ProjectAssetWrite[]=[],pendingBytes=0;
 const flush=async()=>{if(!pending.length)return;const values=pending;pending=[];pendingBytes=0;const receipts=writer.writeMany?await writer.writeMany(values):await Promise.all(values.map(v=>writer.write(v.category,v.name,v.bytes)));if(receipts.length!==values.length)throw invalid();for(let i=0;i<values.length;i++){const expected=values[i].name.slice(0,-5);if(receipts[i].assetId!==expected)throw invalid();references.add(expected);}};
 const visit=async(value:unknown,key=''):Promise<Value>=>{
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw invalid();return value;}
  if(!value||typeof value!=='object'||active.has(value))throw invalid();
  const cached=memo.get(value);if(cached!==undefined)return{ref:cached};
  if(key==='structure'&&structure(value)){
   const bytes=text.encode(scientificJSON(value)),assetId=await digest(bytes);
   const index=nodes.length;nodes.push({kind:'structure',assetId,bytes:bytes.length});memo.set(value,index);
   // Equal bytes share disk content, never the logical Structure instance.
   if(queuedAssets.has(assetId))return{ref:index};queuedAssets.add(assetId);
   if(bytes.length>PROJECT_CHUNK_BYTES){await flush();const receipt=await writer.write('trajectories',assetId+'.json',bytes);if(receipt.assetId!==assetId)throw invalid();references.add(assetId);}
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
/** Accept old self-contained schema1 assets; new graph assets are fully checked
 * before they become a controller snapshot. Missing refs never synthesize data. */
export async function decodeAdvancedAsset(value:unknown,reader:ProjectAssetReader):Promise<AdvancedProjectSnapshot>{
 if(value&&typeof value==='object'&&[1,2].includes((value as {schema:number}).schema)){const old=value as AdvancedProjectSnapshot;assertSnapshot(old);return old;}
 const data=value as AdvancedAssetSnapshot;if(!data||data.schema!=='ester-advanced-assets/v1'||data.version!==1||!Array.isArray(data.nodes)||!Array.isArray(data.assetReferences)||new Set(data.assetReferences).size!==data.assetReferences.length||data.assetReferences.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw invalid();
 const references=new Set(data.assetReferences),structures=new Map<string,Structure>(),sizes=new Map<string,number>();
 const exact=(part:object,keys:string[])=>Object.keys(part).length===keys.length&&keys.every(key=>Object.hasOwn(part,key));
 if(!exact(data,['schema','version','root','nodes','assetReferences']))throw invalid();
 const check=(part:Value)=>{if(part===null||typeof part==='string'||typeof part==='boolean'||typeof part==='number'&&Number.isFinite(part))return;if(!part||typeof part!=='object'||!exact(part,['ref'])||!Number.isSafeInteger(part.ref)||part.ref<0||part.ref>=data.nodes.length)throw invalid();};
 check(data.root);
 for(const node of data.nodes){if(!node||typeof node!=='object')throw invalid();
  if(node.kind==='structure'){if(!exact(node,['kind','assetId','bytes'])||typeof node.assetId!=='string'||!references.has(node.assetId)||!Number.isSafeInteger(node.bytes)||node.bytes<1||sizes.has(node.assetId)&&sizes.get(node.assetId)!==node.bytes)throw invalid();sizes.set(node.assetId,node.bytes);}
  else if(node.kind==='array'){if(!exact(node,['kind','values'])||!Array.isArray(node.values))throw invalid();node.values.forEach(check);}
  else if(node.kind==='object'){if(!exact(node,['kind','entries'])||!Array.isArray(node.entries))throw invalid();const keys=new Set<string>();for(const entry of node.entries){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||keys.has(entry[0]))throw invalid();keys.add(entry[0]);check(entry[1]);}}
  else throw invalid();
 }
 if(sizes.size!==references.size)throw invalid();
 let batch:string[]=[],batchBytes=0;
 const accept=async(id:string,bytes:Uint8Array)=>{if(bytes.length!==sizes.get(id)||await digest(bytes)!==id)throw invalid();const parsed=JSON.parse(decoder.decode(bytes));if(!structure(parsed))throw invalid();structures.set(id,parsed);};
 const flush=async()=>{if(!batch.length)return;const ids=batch;batch=[];batchBytes=0;const parts=reader.readMany?await reader.readMany(ids):await Promise.all(ids.map(id=>reader.read(id)));if(parts.length!==ids.length)throw invalid();for(let i=0;i<ids.length;i++)await accept(ids[i],parts[i]);};
 for(const[id,bytes]of sizes){if(bytes>PROJECT_CHUNK_BYTES){await flush();await accept(id,await reader.read(id));continue;}if(batch.length===PROJECT_ASSET_BATCH_COUNT||batchBytes+bytes>PROJECT_CHUNK_BYTES)await flush();batch.push(id);batchBytes+=bytes;if(batch.length===PROJECT_ASSET_BATCH_COUNT)await flush();}await flush();
 const decoded:unknown[]=[],states:number[]=[];
 const read=(part:Value):unknown=>{if(part===null||typeof part!=='object')return part;const index=part.ref;if(states[index]===1)throw invalid();if(states[index]===2)return decoded[index];states[index]=1;const node=data.nodes[index];
  const item=node.kind==='structure'?structuredClone(structures.get(node.assetId)):node.kind==='array'?node.values.map(read):Object.fromEntries(node.entries.map(([key,value])=>[key,read(value)]));decoded[index]=item;states[index]=2;return item;};
 const snapshot=read(data.root) as AdvancedProjectSnapshot;assertSnapshot(snapshot);return snapshot;
}
