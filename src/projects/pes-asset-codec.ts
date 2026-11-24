import { PES_SCHEMA, pesCardParameterDraft, pesSnapshotUsesExecutionProfile, type PesCard, type PesGroup, type PesNode, type PesProjectSnapshot, type PesRun, type PesResult, type PesFrame, type PesPathRecord } from '../modeling/pes/contracts';
import { hasSuccessfulWorkbenchResult } from '../modeling/pes/input-state';
import {PesPathRecordOwner,bindPesPathRecordOwner,pesPathRecordOwner,pesPathRecords,pesPathRecordVersion,validPesPathRecord} from '../modeling/pes/path-records';
import {sha256Utf8} from '../core/file-identity';
import {PROJECT_CHUNK_BYTES,projectAssetSha256} from './desktop-bridge';
import {scanRequiresFormat11} from '../modeling/pes/expressions';
import {isPesFfModel,pesSnapshotUsesFfModel} from '../modeling/pes/ff-model';
import type { Structure } from '../core/types';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';
import {requiresProjectFormat16} from './format16';

type SavedRun = Omit<PesRun, 'lastSeq' | 'progress' | 'preview' | 'acceptedFrames' | 'status'> & {
  status: 'completed' | 'stopped' | 'failed' | 'interrupted';
};
type SavedNode = Omit<PesNode, 'followRunId'>;
type SavedGroup = Omit<PesGroup, 'runs' | 'nodes'> & { nodes: SavedNode[]; runs: Record<string, SavedRun> };
interface PathCoordinateChunk{assetId:string;start:number;count:number;bytes:number}
interface PathRecordAsset{groupId:string;runId:string;recordId:string;indexDigest:string;chunks:PathCoordinateChunk[]}
type SavedPes = { schema: typeof PES_SCHEMA; groups: SavedGroup[];assetVersion?:2;pathAssets?:PathRecordAsset[];assetReferences?:string[] };
const persistedPathSources=new WeakMap<PesPathRecordOwner,{assets:PathRecordAsset[];reader:ProjectAssetReader}>();
const assetName = 'pes-workspace.json';
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const invalid = () => Error('项目势能面工作台或科学记录无效，原始资产引用已保留。');
const record = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const recordValue=(value:unknown)=>record(value)?value as Record<string,unknown>:undefined;
const decodedPesSnapshots=new WeakSet<PesProjectSnapshot>();
const fixedNumericRows=new WeakSet<number[][]>();

function ownNumericRows(value:unknown):void{
  if(!Array.isArray(value)||fixedNumericRows.has(value)||!value.every(row=>Array.isArray(row)&&row.every(Number.isFinite)))return;
  for(const row of value)Object.freeze(row);
  Object.freeze(value);fixedNumericRows.add(value);
}

/** The caller has just adopted this result from its verified scientific owner. */
export function ownPesResultNumerics(result:PesResult|undefined):void{
  ownNumericRows(recordValue(result?.hessian)?.matrixHartreePerBohr2);
  if(Array.isArray(result?.frequencies))for(const mode of result.frequencies)ownNumericRows(recordValue(mode)?.displacements);
}

/** Detach editable records without duplicating certified fixed numerical payloads. */
export function clonePesSnapshotForPersistence(snapshot:PesProjectSnapshot):PesProjectSnapshot{
  const adopt=decodedPesSnapshots.has(snapshot);
  const borrowed:{group:number;runId:string;path:(string|number)[];key:string;rows:number[][]}[]=[];
  const groups=snapshot.groups.map((group,index)=>({...group,runs:Object.fromEntries(Object.entries(group.runs).map(([runId,run])=>{
    const initial=run.request.parameters.initialHessian;
    if(adopt){ownNumericRows(recordValue(initial)?.matrixHartreePerBohr2);ownPesResultNumerics(run.result);}
    const withoutRows=(owner:unknown,key:string,path:(string|number)[])=>{
      const item=recordValue(owner),rows=item?.[key];
      if(!Array.isArray(rows)||!fixedNumericRows.has(rows))return owner;
      borrowed.push({group:index,runId,path,key,rows});
      return {...item,[key]:undefined};
    };
    const result=run.result;
    const hessian=withoutRows(result?.hessian,'matrixHartreePerBohr2',['result','hessian']);
    const frequencies=Array.isArray(result?.frequencies)?result.frequencies.map((mode,modeIndex)=>withoutRows(mode,'displacements',['result','frequencies',modeIndex])):result?.frequencies;
    const initialHessian=withoutRows(initial,'matrixHartreePerBohr2',['request','parameters','initialHessian']);
    return [runId,{...run,
      ...(initialHessian===initial?{}:{request:{...run.request,parameters:{...run.request.parameters,initialHessian}}}),
      ...(result?{result:{...result,...(hessian===result.hessian?{}:{hessian}),...(frequencies===result.frequencies?{}:{frequencies})}}:{}),
    }];
  }))}));
  const copy=structuredClone({...snapshot,groups});
  for(const entry of borrowed){
    let owner:unknown=copy.groups[entry.group].runs[entry.runId];
    for(const key of entry.path)owner=(owner as Record<typeof key,unknown>)[key];
    (owner as Record<string,unknown>)[entry.key]=entry.rows;
  }
  return copy;
}

function checkGeometry(structure: Structure | undefined): void {
  if (!structure || !Array.isArray(structure.atoms)) throw invalid();
  const ids = new Set<string>();
  for (const atom of structure.atoms) {
    if (!atom || typeof atom.id !== 'string' || !atom.id || ids.has(atom.id) ||
        typeof atom.element !== 'string' || ![atom.x, atom.y, atom.z].every(Number.isFinite)) throw invalid();
    ids.add(atom.id);
  }
}

function checkSlotSources(sources: Pick<PesCard, 'slots' | 'mappings'>): void {
  if (!record(sources.slots)) throw invalid();
  for (const slot of Object.values(sources.slots)) if (slot !== undefined) {
    if (!slot || typeof slot.documentId !== 'string' || !slot.documentId ||
        !Number.isSafeInteger(slot.revision) || slot.revision < 0) throw invalid();
    checkGeometry(slot.structure);
  }
  if (sources.mappings !== undefined && (!record(sources.mappings) ||
      Object.values(sources.mappings).some(mapping => !record(mapping) ||
        Object.values(mapping).some(atomId => typeof atomId !== 'string' || !atomId)))) throw invalid();
}

function checkPes(value: unknown): asserts value is SavedPes {
  const snapshot = value as SavedPes;
  if (snapshot?.schema !== PES_SCHEMA || !Array.isArray(snapshot.groups)) throw invalid();
  const groupIds = new Set<string>();
  for (const group of snapshot.groups) {
    if (!group || typeof group.id !== 'string' || !group.id || groupIds.has(group.id) ||
        !Array.isArray(group.cards) || !Array.isArray(group.nodes) || !record(group.runs) ||
        !record(group.electronic) || !record(group.constraints) || !record(group.ts)) throw invalid();
    groupIds.add(group.id);
    if(group.calcSequence!==undefined&&(!Number.isSafeInteger(group.calcSequence)||group.calcSequence<0))throw invalid();
    if (group.lifecycleVersion !== undefined && group.lifecycleVersion !== 'v223') throw invalid();
    if (group.lifecycleVersion === 'v223' && group.cards.length > 1) throw invalid();
    const nodeIds = new Set<string>();
    for (const node of group.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) ||
          !Array.isArray(node.runIds) || !['initial', 'snapshot', 'result', 'workbench'].includes(node.kind) ||
          Object.hasOwn(node, 'followRunId')) throw invalid();
      nodeIds.add(node.id);
      if(node.calcProfile!==undefined&&node.calcProfile!=='es-calc/v1')throw invalid();
      checkGeometry(node.geometry?.structure);
    }
    if (!nodeIds.has(group.initialNodeId) || !nodeIds.has(group.activeNodeId)) throw invalid();
    const cardIds = new Set<string>();
    if (group.cardDrafts !== undefined && !record(group.cardDrafts)) throw invalid();
    for (const card of [...group.cards,...Object.values(group.cardDrafts ?? {})]) {
      if (!card || typeof card.id !== 'string' || !card.id || cardIds.has(card.id) ||
          !Array.isArray(card.runIds) || !Array.isArray(card.axes) || card.axes.length !== 2) throw invalid();
      cardIds.add(card.id);
      checkSlotSources(card);
      if (card.requiredSlots !== undefined && (!Array.isArray(card.requiredSlots) || card.requiredSlots.some(slot => typeof slot !== 'string'))) throw invalid();
    }
    for (const [runId, run] of Object.entries(group.runs)) {
      if (!run || !['completed', 'stopped', 'failed', 'interrupted'].includes(run.status) ||
          run.request?.schema !== PES_SCHEMA || run.request.runIdentity?.runId !== runId ||
          run.request.runIdentity.groupId !== group.id) throw invalid();
      checkGeometry(run.source?.structure);
      checkGeometry(run.request.structure);
      if (run.request.ffModel !== undefined && !isPesFfModel(run.request.ffModel)) throw invalid();
      if (run.inputSources !== undefined) {
        if (!record(run.inputSources)) throw invalid();
        checkSlotSources(run.inputSources);
      }
      const count = run.request.structure.atoms.length;
      if (!count) throw invalid();
      const records=pesPathRecords(run as PesRun);
      if(records.some(record=>!validPesPathRecord(record))||new Set(records.map(record=>record.id)).size!==records.length)throw invalid();
      if (run.result === undefined) continue;
      if (!run.result || !Array.isArray(run.result.frames) || !record(run.result.provenance)) throw invalid();
      const frameIds = new Map<string, Set<string>>();
      for (const frame of run.result.frames) {
        if (!frame || typeof frame.id !== 'string' || !frame.id || typeof frame.seriesId !== 'string' || !frame.seriesId ||
            !Number.isSafeInteger(frame.step) || typeof frame.phase !== 'string' || typeof frame.status !== 'string' ||
            !Array.isArray(frame.positions) || frame.positions.length !== count ||
            frame.positions.some(xyz => !Array.isArray(xyz) || xyz.length !== 3 || !xyz.every(Number.isFinite)) ||
            frame.energyHartree != null && !Number.isFinite(frame.energyHartree)) throw invalid();
        let series = frameIds.get(frame.seriesId);
        if (!series) frameIds.set(frame.seriesId, series = new Set());
        if (series.has(frame.id)) throw invalid();
        series.add(frame.id);
      }
    }
  }
}

function savedNodeRun(group: SavedGroup, node: SavedNode, id: string): SavedRun | undefined {
  const run = Object.hasOwn(group.runs, id) ? group.runs[id] : undefined;
  if (run?.nodeId === node.id && run.request.id === id && run.request.runIdentity.taskId === node.id) return run;
}

/** Older assets did not write the marker. Require evidence that the node
 * actually adopted the terminal OPT geometry, beyond a merely finished run. */
function adoptedSavedOptimization(group: SavedGroup, node: SavedNode): string | undefined {
  const source = node.geometry.source;
  if (source?.groupId !== group.id || source.nodeId !== node.id || typeof source.runId !== 'string' ||
      !source.frameId || !source.seriesId || source.recordId !== undefined) return;
  const run = savedNodeRun(group, node, source.runId);
  if (run?.request.operation !== 'opt' || run.status === 'interrupted' || !run.result ||
      run.result.provenance.geometryAdoptionError !== undefined) return;
  const observation = recordValue(run.result.finalObservation);
  if (observation?.id !== source.frameId || observation.seriesId !== source.seriesId || !Number.isSafeInteger(observation.step)) return;

  const finalAtoms = recordValue(run.result.finalStructure)?.atoms;
  const requestAtoms = run.request.structure.atoms;
  const nodeAtoms = node.geometry.structure.atoms;
  if (!Array.isArray(finalAtoms) || finalAtoms.length !== requestAtoms.length || finalAtoms.length !== nodeAtoms.length) return;
  if (finalAtoms.every((value, index) => {
    const atom = recordValue(value), input = requestAtoms[index], adopted = nodeAtoms[index];
    return !!atom && atom.id === input.id && atom.element === input.element && atom.id === adopted.id && atom.element === adopted.element &&
      atom.x === adopted.x && atom.y === adopted.y && atom.z === adopted.z;
  })) return source.runId;
}

function restoredWorkbenchRetirements(group: SavedGroup): Map<string, string> {
  const retirements = new Map<string, string>();
  for (const node of group.nodes) {
    if ((node.kind !== 'workbench' && node.kind !== 'initial') || node.runIds.length < 2) continue;
    const order = new Map(node.runIds.map((id, index) => [id, index]));
    if (order.size !== node.runIds.length) continue;
    const adopted = adoptedSavedOptimization(group, node);
    for (const [id, index] of order) {
      if (typeof id !== 'string') continue;
      const run = savedNodeRun(group, node, id);
      if (run?.status !== 'completed' || !['ts', 'hessian'].includes(run.request.operation)) continue;
      const marker = run.supersededByRunId;
      const target = marker === undefined && hasSuccessfulWorkbenchResult(run) ? adopted : marker;
      if (typeof target !== 'string' || (order.get(target) ?? -1) <= index) continue;
      const replacement = savedNodeRun(group, node, target);
      if (replacement && (replacement.request.operation === 'opt' && replacement.status !== 'interrupted' ||
          ['ts', 'hessian'].includes(replacement.request.operation) && replacement.status === 'completed')) retirements.set(id, target);
    }
  }
  return retirements;
}

function savedPesIndex(snapshot: PesProjectSnapshot): SavedPes | undefined {
  if (snapshot?.schema !== PES_SCHEMA || !Array.isArray(snapshot.groups)) throw invalid();
  if (!snapshot.groups.length) return;
  const groups: SavedGroup[] = snapshot.groups.map(group => ({
    ...group,
    cards: group.lifecycleVersion === 'v223' ? group.cards.map(pesCardParameterDraft) : group.cards,
    ...(group.cardDrafts ? {cardDrafts:Object.fromEntries(Object.entries(group.cardDrafts).map(([key,card])=>[key,pesCardParameterDraft(card)]))} : {}),
    nodes: group.nodes.map(({ followRunId: _followRunId, ...node }) => node),
    runs: Object.fromEntries(Object.entries(group.runs).map(([id, run]): [string, SavedRun] => {
      const status = run.status === 'starting' || run.status === 'running' || run.status === 'stopping'
        ? 'interrupted' : run.status;
      const result = status === 'interrupted' && run.acceptedFrames?.length
        ? { status, provenance: {}, frames: [...run.acceptedFrames] } : run.result;
      const savedResult=result&&(run.pathRecords!==undefined||run.scanPoints!==undefined)?{...result,
        ...(run.pathRecords===undefined?{}:{pathRecords:undefined}),...(run.scanPoints===undefined?{}:{scanPoints:undefined})}:result;
      return [id, { request: run.request, source: run.source, inputSources: run.inputSources,
        nodeId: run.nodeId, status, result:savedResult, error: run.error,
        ...(run.supersededByRunId === undefined ? {} : { supersededByRunId: run.supersededByRunId }),
        ...(run.pathRecords===undefined?{}:{pathRecords:run.pathRecords}),...(run.scanPoints===undefined?{}:{scanPoints:run.scanPoints}) }];
    })),
  }));
  const data: SavedPes = { schema: PES_SCHEMA, groups };
  checkPes(data);
  return data;
}

function stringifyIndex(data: SavedPes): string {
  return JSON.stringify(data, (_key, part: unknown) => {
    if (typeof part === 'number' && !Number.isFinite(part)) throw invalid();
    if (typeof part === 'function' || typeof part === 'symbol' ||
        part !== null && typeof part === 'object' && !Array.isArray(part) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(part))) throw invalid();
    return part;
  });
}

/** Capture the accepted scientific DTO before the first asynchronous write. */
export function serializePesAsset(snapshot: PesProjectSnapshot): string | undefined {
  const data=savedPesIndex(snapshot);return data&&stringifyIndex(data);
}

export async function writePesAsset(writer: ProjectAssetWriter, supplied: string | Uint8Array): Promise<string> {
  const bytes=typeof supplied==='string'?encoder.encode(supplied):supplied;
  const expected=await projectAssetSha256(bytes),saved=(await writer.write('results',assetName,bytes)).assetId;
  if(saved!==expected)throw Error('势能面索引写入回执与实际内容不一致，未提交项目。');return saved;
}

const pathIdentity=(groupId:string,runId:string,recordId:string)=>JSON.stringify([groupId,runId,recordId]);
type PathIndexCheck={indexDigest:string;count:number};
function expectedPathIndex(data:SavedPes):Map<string,PathIndexCheck>{
  const expected=new Map<string,PathIndexCheck>();
  for(const group of data.groups)for(const [runId,run]of Object.entries(group.runs))for(const record of pesPathRecords(run as PesRun)){
    expected.set(pathIdentity(group.id,runId,record.id),{indexDigest:sha256Utf8(pesPathRecordVersion(record)),count:record.frames.length});
  }
  return expected;
}
function checkPathAssets(data:Pick<SavedPes,'assetVersion'|'pathAssets'|'assetReferences'>,expected:ReadonlyMap<string,PathIndexCheck>):void{
  if(data.assetVersion===undefined){if(expected.size)throw Error('路径轮缺少分块结构资产，原始索引已保留。');return;}
  if(data.assetVersion!==2||!Array.isArray(data.pathAssets)||!Array.isArray(data.assetReferences))throw invalid();
  const references=new Set(data.assetReferences),used=new Set<string>();
  if(references.size!==data.assetReferences.length||[...references].some(id=>!/^[a-f0-9]{64}$/.test(id)))throw invalid();
  for(const row of data.pathAssets){
    const identity=pathIdentity(row.groupId,row.runId,row.recordId),record=expected.get(identity);if(!record||used.has(identity)||!Array.isArray(row.chunks)||row.indexDigest!==record.indexDigest)throw invalid();used.add(identity);
    let end=0;for(const chunk of row.chunks){if(!references.has(chunk.assetId)||chunk.start!==end||!Number.isSafeInteger(chunk.count)||chunk.count<1||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1)throw invalid();end+=chunk.count;}
    if(end!==record.count)throw invalid();
  }
  if(used.size!==expected.size)throw invalid();
}
async function verifiedAsset(reader:ProjectAssetReader,assetId:string){
  const bytes=await reader.read(assetId);if(await projectAssetSha256(bytes)!==assetId)throw Error('项目势能面资产校验失败，原始资产引用已保留。');return bytes;
}
async function readPathFrames(reader:ProjectAssetReader,row:PathRecordAsset,record:PesPathRecord,atoms:number,signal?:AbortSignal):Promise<readonly PesFrame[]>{
  const frames:PesFrame[]=[];
  for(const chunk of row.chunks){
    signal?.throwIfAborted();const bytes=await verifiedAsset(reader,chunk.assetId);signal?.throwIfAborted();
    if(bytes.length!==chunk.bytes)throw invalid();
    const data=JSON.parse(decoder.decode(bytes)) as {schema:string;coordinates:PesFrame['positions'][]};
    if(data.schema!=='ester-pes-coordinates/v1'||!Array.isArray(data.coordinates)||data.coordinates.length!==chunk.count||data.coordinates.some(positions=>!Array.isArray(positions)||positions.length!==atoms||positions.some(xyz=>!Array.isArray(xyz)||xyz.length!==3||!xyz.every(Number.isFinite))))throw invalid();
    data.coordinates.forEach((positions,index)=>frames.push({...record.frames[chunk.start+index],positions}));
  }
  return frames;
}
export interface PesAssetCapture{assetId?:string;assetReferences:string[];requiresFormat11:boolean;requiresFormat12:boolean;requiresFormat13?:boolean;requiresFormat15?:boolean;requiresFormat16?:boolean;commit?():void}
interface PreparedPesIndex{
  json:string;
  expected:Map<string,PathIndexCheck>;
  pathSources:{owner:PesPathRecordOwner;groupId:string;runId:string;records:readonly PesPathRecord[]}[];
  formats:Pick<PesAssetCapture,'requiresFormat11'|'requiresFormat12'|'requiresFormat13'|'requiresFormat15'|'requiresFormat16'>;
}

export function preparePesIndex(snapshot:PesProjectSnapshot):PreparedPesIndex|null{
  const data=savedPesIndex(snapshot);if(!data)return null;
  const expected=expectedPathIndex(data),pathSources:PreparedPesIndex['pathSources']=[];
  if(expected.size)for(const group of snapshot.groups)for(const[runId,run]of Object.entries(group.runs)){
    const records=pesPathRecords(run);if(!records.length)continue;
    const owner=pesPathRecordOwner(run);if(!owner)throw Error('路径轮缺少可读取的结构来源，未提交不完整项目。');
    // Only frame index metadata is copied. Coordinate leases are acquired later.
    pathSources.push({owner,groupId:group.id,runId,records:structuredClone(records)});
  }
  const formats={
    requiresFormat11:expected.size>0||snapshot.groups.some(group=>group.cards.some(scanRequiresFormat11)),
    requiresFormat12:pesSnapshotUsesExecutionProfile(snapshot),
    requiresFormat13:snapshot.groups.some(group=>group.lifecycleVersion==='v223'||Object.values(group.runs).some(run=>run.request.parameters.pathSemantics==='v223')),
    requiresFormat15:pesSnapshotUsesFfModel(snapshot),
    requiresFormat16:requiresProjectFormat16(snapshot),
  };
  return{json:stringifyIndex(data),expected,pathSources,formats};
}

/** One complete round is read at a time; the index is committed by the existing
 * project transaction only after every referenced immutable chunk is written. */
export async function capturePesAsset(snapshot:PesProjectSnapshot,writer:ProjectAssetWriter,reuse:boolean,capture?:PreparedPesIndex|null,reader?:ProjectAssetReader):Promise<PesAssetCapture>{
  const prepared=capture===undefined?preparePesIndex(snapshot):capture;if(!prepared)return{assetReferences:[],requiresFormat11:false,requiresFormat12:false};
  if(!prepared.expected.size)return{assetId:await writePesAsset(writer,prepared.json),assetReferences:[],...prepared.formats};
  const pathAssets:PathRecordAsset[]=[],references=new Set<string>();
  for(const {owner,groupId,runId,records} of prepared.pathSources){
    const persisted=persistedPathSources.get(owner);
    for(const record of records){
      const identity=pathIdentity(groupId,runId,record.id),expected=prepared.expected.get(identity);
      if(!expected)throw invalid();
      const {indexDigest}=expected,previous=persisted?.assets.find(row=>row.groupId===groupId&&row.runId===runId&&row.recordId===record.id&&row.indexDigest===indexDigest);
      if(previous){
        for(const chunk of previous.chunks){
          if(!reuse){const bytes=await verifiedAsset(persisted!.reader,chunk.assetId);if((await writer.write('trajectories',`pes-${record.id}.json`,bytes)).assetId!==chunk.assetId)throw Error('路径轮另存回执与原始资产不一致。');}
          references.add(chunk.assetId);
        }
        pathAssets.push(previous);continue;
      }
      const lease=owner.acquire(record.id),chunks:PathCoordinateChunk[]=[];
      try{
        const frames=await lease.prepare();let parts:string[]=[],characters=0,start=0;
        const flush=async()=>{if(!parts.length)return;const bytes=`{"schema":"ester-pes-coordinates/v1","coordinates":[${parts.join(',')}]}`;
          const {assetId}=await writer.write('trajectories',`pes-round-${record.step}.json`,bytes);if(assetId!==sha256Utf8(bytes))throw Error('路径轮结构写入回执与实际内容不一致，未提交项目。');chunks.push({assetId,start,count:parts.length,bytes:bytes.length});references.add(assetId);start+=parts.length;parts=[];characters=0;};
        for(const frame of frames){const text=JSON.stringify(frame.positions);if(parts.length&&characters+text.length+1>PROJECT_CHUNK_BYTES)await flush();parts.push(text);characters+=text.length+1;}
        await flush();pathAssets.push({groupId,runId,recordId:record.id,indexDigest,chunks});
      }finally{lease.release();}
    }
  }
  const appendix={assetVersion:2 as const,pathAssets,assetReferences:[...references]};checkPathAssets(appendix,prepared.expected);
  const index=prepared.json.slice(0,-1)+','+JSON.stringify(appendix).slice(1);
  return{assetId:await writePesAsset(writer,index),assetReferences:[...references],...prepared.formats,commit:reader?()=>{
    for(const source of prepared.pathSources){const assets=pathAssets.filter(row=>row.groupId===source.groupId&&row.runId===source.runId);
      persistedPathSources.set(source.owner,{assets,reader});
      for(const record of source.records){const asset=assets.find(row=>row.recordId===record.id)!;source.owner.setRecordReader(record.id,(_id,signal)=>readPathFrames(reader,asset,record,source.owner.atomCount,signal));}
    }
  }:undefined};
}

/** A restored workspace owns this reference, including while PES is unvisited. */
export class WorkspacePesAsset {
  private reference: { assetId?: string;assetReferences:string[] };

  constructor(assetId: string, private readonly reader: ProjectAssetReader,assetReferences:readonly string[]=[],private format11=false,private format12=false,private format13=false,private format15=false,private format16=false) {
    this.reference = { assetId,assetReferences:[...assetReferences] };
  }

  get assetId(): string | undefined { return this.reference.assetId; }
  get assetReferences():readonly string[]{return this.reference.assetReferences;}
  get requiresFormat11(){return this.format11;}
  get requiresFormat12(){return this.format12;}
  get requiresFormat13(){return this.format13;}
  get requiresFormat15(){return this.format15;}
  get requiresFormat16(){return this.format16;}

  rebind(assetId?: string,assetReferences:readonly string[]=this.reference.assetReferences,format11=this.format11,format12=this.format12,format13=this.format13,format15=this.format15,format16=this.format16): void { this.reference = { assetId,assetReferences:[...assetReferences] };this.format11=format11;this.format12=format12;this.format13=format13;this.format15=format15;this.format16=format16; }

  private async verifiedBytes(assetId: string): Promise<Uint8Array> {
    return verifiedAsset(this.reader,assetId);
  }

  async copyTo(writer: ProjectAssetWriter): Promise<string | undefined> {
    const { assetId,assetReferences } = this.reference;
    if (!assetId) return;
    const bytes=await this.verifiedBytes(assetId);
    const protectedData=JSON.parse(decoder.decode(bytes));
    if(requiresProjectFormat16(protectedData)&&!this.format16)throw Error('CALC计算记录缺少格式 16 写入保护声明，原资产引用已保留。');
    if(assetReferences.length){checkPes(protectedData);checkPathAssets(protectedData,expectedPathIndex(protectedData));if(protectedData.assetReferences?.length!==assetReferences.length||protectedData.assetReferences.some(id=>!assetReferences.includes(id)))throw invalid();}
    for(const id of assetReferences){const chunk=await this.verifiedBytes(id);if((await writer.write('trajectories',`pes-${id}.json`,chunk)).assetId!==id)throw Error('路径轮另存回执与原始资产不一致。');}
    const saved = await writePesAsset(writer,bytes);
    if (saved !== assetId) throw Error('势能面项目资产另存回执与来源不一致。');
    return saved;
  }

  async read(): Promise<PesProjectSnapshot | undefined> {
    for (;;) {
      const reference = this.reference;
      if (!reference.assetId) return;
      try {
        const bytes = await this.verifiedBytes(reference.assetId);
        if (reference !== this.reference) continue;
        const data: unknown = JSON.parse(decoder.decode(bytes));
        checkPes(data);
        if(requiresProjectFormat16(data)&&!this.format16)throw Error('CALC计算记录缺少格式 16 写入保护声明，原资产引用已保留。');
        if (pesSnapshotUsesFfModel(data) && !this.format15) throw Error('固定力场模型缺少格式 15 写入保护声明，原资产引用已保留。');
        checkPathAssets(data,expectedPathIndex(data));
        const snapshot:PesProjectSnapshot={
          schema: data.schema,
          groups: data.groups.map(group => {
            const retirements = restoredWorkbenchRetirements(group);
            return {
              ...group,
              runs: Object.fromEntries(Object.entries(group.runs).map(([id, run]) => {
                const supersededByRunId = retirements.get(id);
                return [id, {
                  request: run.request, source: run.source, nodeId: run.nodeId, status: run.status,
                  ...(run.inputSources === undefined ? {} : { inputSources: run.inputSources }),
                  ...(run.result === undefined ? {} : { result: run.result }),
                  ...(run.error === undefined ? {} : { error: run.error }),
                  ...(supersededByRunId === undefined ? {} : { supersededByRunId }),
                  ...(run.pathRecords===undefined?{}:{pathRecords:run.pathRecords}),...(run.scanPoints===undefined?{}:{scanPoints:run.scanPoints}),
                  lastSeq: -1,
                }];
              })),
            };
          }),
        };
        for(const group of snapshot.groups)for(const [runId,run]of Object.entries(group.runs))if(pesPathRecords(run).length){
          const assets=data.pathAssets!.filter(row=>row.groupId===group.id&&row.runId===runId),byId=new Map(assets.map(row=>[row.recordId,row]));
          const records=new Map(pesPathRecords(run).map(record=>[record.id,record]));
          const owner=new PesPathRecordOwner(run.request.structure.atoms.length,(id,signal)=>{const row=byId.get(id),record=records.get(id);if(!row||!record)throw invalid();return readPathFrames(this.reader,row,record,run.request.structure.atoms.length,signal);});
          bindPesPathRecordOwner(run,owner);persistedPathSources.set(owner,{assets,reader:this.reader});
        }
        decodedPesSnapshots.add(snapshot);
        return snapshot;
      } catch (error) {
        // A completed Save As has synchronously moved the shared reader router.
        if (reference === this.reference) throw error;
      }
    }
  }
}
