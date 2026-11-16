import { PES_SCHEMA, pesCardParameterDraft, pesSnapshotUsesExecutionProfile, type PesCard, type PesGroup, type PesNode, type PesProjectSnapshot, type PesRun, type PesFrame, type PesPathRecord } from '../modeling/pes/contracts';
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
const invalid = () => Error('项目势能面工作台或科学记录无效，原始资产引用已保留。');
const record = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

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

/** Freeze the accepted scientific DTO before the first asynchronous write. */
export function serializePesAsset(snapshot: PesProjectSnapshot): string | undefined {
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
        ...(run.pathRecords===undefined?{}:{pathRecords:run.pathRecords}),...(run.scanPoints===undefined?{}:{scanPoints:run.scanPoints}) }];
    })),
  }));
  const data: SavedPes = { schema: PES_SCHEMA, groups };
  checkPes(data);
  return JSON.stringify(data, (_key, part: unknown) => {
    if (typeof part === 'number' && !Number.isFinite(part)) throw invalid();
    if (typeof part === 'function' || typeof part === 'symbol' ||
        part !== null && typeof part === 'object' && !Array.isArray(part) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(part))) throw invalid();
    return part;
  });
}

export async function writePesAsset(writer: ProjectAssetWriter, bytes: string | Uint8Array): Promise<string> {
  const expected=typeof bytes==='string'?sha256Utf8(bytes):await projectAssetSha256(bytes),saved=(await writer.write('results',assetName,bytes)).assetId;
  if(saved!==expected)throw Error('势能面索引写入回执与实际内容不一致，未提交项目。');return saved;
}

function checkPathAssets(data:SavedPes):void{
  const expected=new Map(data.groups.flatMap(group=>Object.entries(group.runs).flatMap(([runId,run])=>pesPathRecords(run as PesRun).map(record=>[JSON.stringify([group.id,runId,record.id]),record] as const))));
  if(data.assetVersion===undefined){if(expected.size)throw Error('路径轮缺少分块结构资产，原始索引已保留。');return;}
  if(data.assetVersion!==2||!Array.isArray(data.pathAssets)||!Array.isArray(data.assetReferences))throw invalid();
  const references=new Set(data.assetReferences),used=new Set<string>();
  if(references.size!==data.assetReferences.length||[...references].some(id=>!/^[a-f0-9]{64}$/.test(id)))throw invalid();
  for(const row of data.pathAssets){
    const identity=JSON.stringify([row.groupId,row.runId,row.recordId]),record=expected.get(identity);if(!record||used.has(identity)||!Array.isArray(row.chunks)||row.indexDigest!==sha256Utf8(pesPathRecordVersion(record)))throw invalid();used.add(identity);
    let end=0;for(const chunk of row.chunks){if(!references.has(chunk.assetId)||chunk.start!==end||!Number.isSafeInteger(chunk.count)||chunk.count<1||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1)throw invalid();end+=chunk.count;}
    if(end!==record.frames.length)throw invalid();
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
/** One complete round is read at a time; the index is committed by the existing
 * project transaction only after every referenced immutable chunk is written. */
export async function capturePesAsset(snapshot:PesProjectSnapshot,writer:ProjectAssetWriter,reuse:boolean,capturedBytes?:string,reader?:ProjectAssetReader):Promise<PesAssetCapture>{
  const serialized=capturedBytes??serializePesAsset(snapshot);if(serialized===undefined)return{assetReferences:[],requiresFormat11:false,requiresFormat12:false};
  const requiresFormat12=pesSnapshotUsesExecutionProfile(snapshot);
  const requiresFormat13=snapshot.groups.some(group=>group.lifecycleVersion==='v223'||Object.values(group.runs).some(run=>run.request.parameters.pathSemantics==='v223'));
  const requiresFormat15=pesSnapshotUsesFfModel(snapshot);
  const requiresFormat16=requiresProjectFormat16(snapshot);
  const scanFormat11=snapshot.groups.some(group=>group.cards.some(scanRequiresFormat11));
  if(!snapshot.groups.some(group=>Object.values(group.runs).some(run=>pesPathRecords(run).length)))return{assetId:await writePesAsset(writer,serialized),assetReferences:[],requiresFormat11:scanFormat11,requiresFormat12,requiresFormat13,requiresFormat15,requiresFormat16};
  const data=JSON.parse(serialized) as SavedPes;
  const pathAssets:PathRecordAsset[]=[],references=new Set<string>();
  const committedSources:{owner:PesPathRecordOwner;groupId:string;runId:string;records:readonly PesPathRecord[]}[]=[];
  for(const group of snapshot.groups)for(const [runId,run]of Object.entries(group.runs)){
    const records=pesPathRecords(run);if(!records.length)continue;
    const owner=pesPathRecordOwner(run);if(!owner)throw Error('路径轮缺少可读取的结构来源，未提交不完整项目。');
    const persisted=persistedPathSources.get(owner);
    committedSources.push({owner,groupId:group.id,runId,records});
    for(const record of records){
      const indexDigest=sha256Utf8(pesPathRecordVersion(record)),previous=persisted?.assets.find(row=>row.groupId===group.id&&row.runId===runId&&row.recordId===record.id&&row.indexDigest===indexDigest);
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
        await flush();pathAssets.push({groupId:group.id,runId,recordId:record.id,indexDigest,chunks});
      }finally{lease.release();}
    }
  }
  const encoded:SavedPes={...data,assetVersion:2,pathAssets,assetReferences:[...references]};checkPathAssets(encoded);
  return{assetId:await writePesAsset(writer,JSON.stringify(encoded)),assetReferences:[...references],requiresFormat11:true,requiresFormat12,requiresFormat13,requiresFormat15,requiresFormat16,commit:reader?()=>{
    for(const source of committedSources){const assets=pathAssets.filter(row=>row.groupId===source.groupId&&row.runId===source.runId);
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
    if(assetReferences.length){const data=JSON.parse(decoder.decode(bytes)) as SavedPes;checkPes(data);checkPathAssets(data);if(data.assetReferences?.length!==assetReferences.length||data.assetReferences.some(id=>!assetReferences.includes(id)))throw invalid();}
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
        checkPathAssets(data);
        const snapshot:PesProjectSnapshot={
          schema: data.schema,
          groups: data.groups.map(group => ({
            ...group,
            runs: Object.fromEntries(Object.entries(group.runs).map(([id, run]) => [id, {
              request: run.request, source: run.source, nodeId: run.nodeId, status: run.status,
              ...(run.inputSources === undefined ? {} : { inputSources: run.inputSources }),
              ...(run.result === undefined ? {} : { result: run.result }),
              ...(run.error === undefined ? {} : { error: run.error }),
              ...(run.pathRecords===undefined?{}:{pathRecords:run.pathRecords}),...(run.scanPoints===undefined?{}:{scanPoints:run.scanPoints}),
              lastSeq: -1,
            }])),
          })),
        };
        for(const group of snapshot.groups)for(const [runId,run]of Object.entries(group.runs))if(pesPathRecords(run).length){
          const assets=data.pathAssets!.filter(row=>row.groupId===group.id&&row.runId===runId),byId=new Map(assets.map(row=>[row.recordId,row]));
          const records=new Map(pesPathRecords(run).map(record=>[record.id,record]));
          const owner=new PesPathRecordOwner(run.request.structure.atoms.length,(id,signal)=>{const row=byId.get(id),record=records.get(id);if(!row||!record)throw invalid();return readPathFrames(this.reader,row,record,run.request.structure.atoms.length,signal);});
          bindPesPathRecordOwner(run,owner);persistedPathSources.set(owner,{assets,reader:this.reader});
        }
        return snapshot;
      } catch (error) {
        // A completed Save As has synchronously moved the shared reader router.
        if (reference === this.reference) throw error;
      }
    }
  }
}
