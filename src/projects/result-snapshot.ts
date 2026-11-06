import type { TrajectoryResult, ResultInputFile } from '../results/contracts';
import { assertResultNotAborted } from '../results/contracts';
import { createLazyTrajectoryResult } from '../results/lazy-trajectory';
import { readPostprocessSourceBytes, retainPostprocessSourceBytes, type PostprocessAttachment, type PostprocessDocument } from '../results/postprocess-document';
import type { PostprocessSource, PostprocessSourcePair } from '../results/postprocess-sources';
import type { Structure } from '../core/types';
import { createLazyConformerTrajectory, type ConformerTrajectoryResult } from '../modeling/conformers/trajectory';
import { captureProjectCompanionBundles, restoreProjectCompanionBundles, captureRawProjectCompanionCandidates, restoreRawProjectCompanionCandidates, rawProjectCompanionOutputIdentity, projectCompanionVersion, type ProjectCompanionBundleSnapshot, type ProjectRawCompanionBundleSnapshot } from './companion-sources';
import { createRestoredManagedSource } from './managed-source';
import {PROJECT_ASSET_BATCH_COUNT,PROJECT_CHUNK_BYTES,type ProjectAssetWrite} from './desktop-bridge';
import {VibronicSha256} from '../core/gaussian-vibronic/sha256-stream';
import { readGeneratedXtbSourcePackage, retainGeneratedXtbSourcePackage, validateGeneratedXtbBundle, type GeneratedXtbSourcePackage } from '../results/xtb-generated-source';
import { getPostprocessTaskAssociation, setPostprocessTaskAssociation, type PostprocessManagedTaskReference } from './postprocess-task-association';
import { postprocessSourceExtras, retainPostprocessSourceExtras } from './postprocess-extra-sources';
import { isScientificFileDocument, retainPostprocessFileSourceBytes, readPostprocessFileSourceBytes, type PostprocessFileDocument, type PostprocessScientificFileDocument } from '../results/postprocess-document';
import {postprocessFileJobSource, type PostprocessScientificFileSource} from '../results/postprocess-sources';
import type { ResultDiagnostic, ResultDiagnosticSnapshot } from '../results/contracts';

export interface ProjectAssetWriter { write(category: string, name: string, bytes: Uint8Array | string): Promise<{ assetId: string }>;writeMany?(values:readonly ProjectAssetWrite[]):Promise<{assetId:string}[]> }
export interface ProjectAssetReader { read(assetId: string): Promise<Uint8Array>;readMany?(assetIds:readonly string[]):Promise<Uint8Array[]> }
type ResultData = Omit<TrajectoryResult, 'getFrame' | 'dispose'>;
export interface TrajectoryResultSnapshot { schema: 1; data: ResultData; frameAssets: string[];
  conformer?: Pick<ConformerTrajectoryResult, 'identity' | 'frameIds' | 'protectedAtomIds'> }
export interface PostprocessAttachmentSnapshot {
  role?: import('../results/postprocess-document').PostprocessAttachmentRole;
  data: Omit<PostprocessSource, 'result' | 'results'>;
  result: TrajectoryResultSnapshot; results: TrajectoryResultSnapshot[];
  raw: { sourceId: string; name: string; size: number; revision?: string; chunks: { assetId: string; bytes: number }[] };
  companionBundles?: ProjectCompanionBundleSnapshot[];
  rawCompanionCandidates?: ProjectRawCompanionBundleSnapshot[];
  generatedXtbPackage?: { assetId: string };
}
export interface PostprocessDocumentSnapshot {
  schema: 1 | 2 | 3 | 4; id: string; result: TrajectoryResultSnapshot;
  output?: PostprocessAttachmentSnapshot; wavefunction?: PostprocessAttachmentSnapshot;
  companions?: PostprocessAttachmentSnapshot[];
  pair?: Omit<PostprocessSourcePair, 'primary' | 'wavefunction'>;
  wavefunctionFrameIndex?: number | null;
  managedTask?: PostprocessManagedTaskReference;
  extraSources?: {name:string;sourceId:string;revision:string;byteSize:number;format:string;chunks:{assetId:string;bytes:number}[]}[];
}
/** Outer writer must advertise scientific-file-v1 before committing schema 4. */
export interface PostprocessScientificFileDocumentSnapshot {
  schema: 4; kind: 'scientific-file'; id: string;
  output: { data: Omit<PostprocessScientificFileSource, 'jobs' | 'dispose'>; role?: import('../results/postprocess-document').PostprocessAttachmentRole;
    jobs: ({ kind: 'diagnostic'; data: ResultDiagnosticSnapshot } | { kind: 'geometry'; snapshot: TrajectoryResultSnapshot })[];
    raw: PostprocessAttachmentSnapshot['raw'] };
  wavefunction?: PostprocessAttachmentSnapshot; companions?: PostprocessAttachmentSnapshot[];
  displayResult?: TrajectoryResultSnapshot; sourceWarnings?: PostprocessScientificFileDocument['sourceWarnings'];
  pair?: { jobId: string; waveSourceId: string; waveRevision: string; proof: Omit<PostprocessSourcePair, 'primary' | 'wavefunction'> };
  extraSources?: {name:string;sourceId:string;revision:string;byteSize:number;format:string;role?:string;chunks:{assetId:string;bytes:number}[]}[];
}
export type PostprocessFileDocumentSnapshot = PostprocessDocumentSnapshot | PostprocessScientificFileDocumentSnapshot;
export const POSTPROCESS_SCIENTIFIC_FILE_CAPABILITY = 'scientific-file-v1';
const encoder = new TextEncoder();
function json(value: unknown): string {
  return JSON.stringify(value, (_key, part) => {
    if (typeof part === 'function' || part instanceof Map || part instanceof Set || ArrayBuffer.isView(part)) throw new Error('项目结果包含未适配的运行对象。');
    if (typeof part === 'number' && !Number.isFinite(part)) throw new Error('项目结果包含无效数值。');
    return part;
  });
}
const clone = <T>(value: T): T => JSON.parse(json(value)) as T;

/** Freeze metadata before awaiting IO; each geometry is a bounded independent
 * asset. Opening reads metadata/first geometry only, subsequent frames lazily. */
export async function encodeTrajectoryResult(result: TrajectoryResult, writer: ProjectAssetWriter): Promise<TrajectoryResultSnapshot> {
  const { getFrame: _get, dispose: _dispose, ...metadata } = result;
  const data = clone(metadata), frameAssets: string[] = [];
  let batch:ProjectAssetWrite[]=[],batchBytes=0;
  const flush=async()=>{if(!batch.length)return;const values=batch;batch=[];batchBytes=0;
    const written=writer.writeMany?await writer.writeMany(values):await Promise.all(values.map(value=>writer.write(value.category,value.name,value.bytes)));
    if(written.length!==values.length||written.some(value=>typeof value.assetId!=='string'||!value.assetId))throw new Error('项目轨迹批写回执不完整。');
    frameAssets.push(...written.map(value=>value.assetId));};
  for (let index = 0; index < data.frames.length; index++) {
    const structure = await result.getFrame(index);
    const bytes=encoder.encode(json(structure)),name=`${result.id}-${index}.json`;
    if(!writer.writeMany){frameAssets.push((await writer.write('trajectories',name,bytes)).assetId);continue;}
    if(bytes.byteLength>PROJECT_CHUNK_BYTES){await flush();frameAssets.push((await writer.write('trajectories',name,bytes)).assetId);continue;}
    if(batch.length===PROJECT_ASSET_BATCH_COUNT||batchBytes+bytes.byteLength>PROJECT_CHUNK_BYTES)await flush();
    batch.push({category:'trajectories',name,bytes});batchBytes+=bytes.byteLength;
    if(batch.length===PROJECT_ASSET_BATCH_COUNT)await flush();
  }
  await flush();
  const collection = result as Partial<ConformerTrajectoryResult>;
  return { schema: 1, data, frameAssets, ...(collection.identity && collection.frameIds ? { conformer: clone({ identity: collection.identity, frameIds: collection.frameIds, protectedAtomIds: collection.protectedAtomIds ?? [] }) } : {}) };
}
export function decodeTrajectoryResult(snapshot: TrajectoryResultSnapshot, reader: ProjectAssetReader): TrajectoryResult {
  if (snapshot.schema !== 1 || snapshot.frameAssets.length !== snapshot.data.frames.length) throw new Error('项目轨迹索引无效。');
  const input = { ...clone(snapshot.data), async readFrame(index: number, signal?: AbortSignal) {
    assertResultNotAborted(signal);
    const bytes = await reader.read(snapshot.frameAssets[index]); assertResultNotAborted(signal);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Structure;
  } };
  return snapshot.conformer ? createLazyConformerTrajectory({ ...input, ...clone(snapshot.conformer) }) : createLazyTrajectoryResult(input);
}

const CHUNK_BYTES = 8 * 1024 ** 2;
async function encodeAttachment(attachment: PostprocessAttachment, writer: ProjectAssetWriter, memo: Map<TrajectoryResult, Promise<TrajectoryResultSnapshot>>): Promise<PostprocessAttachmentSnapshot> {
  const companionRevision = projectCompanionVersion(attachment);
  const { result, results, ...sourceData } = attachment.source;
  const data = clone(sourceData), identity = clone(result.source), chunks: PostprocessAttachmentSnapshot['raw']['chunks'] = [];
  // OUT persistence needs raw bytes only. Do not trigger a full-text fallback
  // (or an extra source scan) merely to save a source that has no wave metadata.
  const inspected = sourceData.metadata && attachment.readSourceText ? await attachment.readSourceText() : undefined;
  const rawOutput = rawProjectCompanionOutputIdentity(attachment);
  const rawOutputHash = rawOutput ? new VibronicSha256() : undefined;
  if (rawOutput && (rawOutput.sourceId !== identity.id || rawOutput.name !== identity.name || rawOutput.size !== identity.size || inspected && rawOutput.revision !== inspected.sourceRevision)) throw new Error('原始候选集合与当前OUT来源身份冲突。');
  const legacyBytes = inspected?.text === undefined ? undefined : encoder.encode(inspected.text);
  if (sourceData.metadata && (!inspected || inspected.sourceId !== identity.id || inspected.sourceRevision !== sourceData.metadata.sourceRevision)) throw new Error('无法核对已绑定波函数的来源快照。');
  const encode = (value: TrajectoryResult) => {
    let pending = memo.get(value); if (!pending) { pending = encodeTrajectoryResult(value, writer); memo.set(value, pending); } return pending;
  };
  // Copy original bytes from the import lease, including BOM/line endings.
  // A changed or missing lease fails this generation rather than mixing sources.
  for (let start = 0; start < identity.size; start += CHUNK_BYTES) {
    const bytes = await readPostprocessSourceBytes(attachment, start, Math.min(start + CHUNK_BYTES, identity.size));
    rawOutputHash?.update(bytes);
    if (legacyBytes && (legacyBytes.byteLength !== identity.size || bytes.some((value, offset) => value !== legacyBytes[start + offset]))) throw new Error('原始波函数字节已变化，未将新来源和旧结果混存。');
    chunks.push({ ...(await writer.write('sources', identity.name, bytes)), bytes: bytes.byteLength });
  }
  if(rawOutputHash&&rawOutputHash.digest()!==rawOutput!.revision)throw new Error('保存OUT原字节与候选绑定SHA不符。');
  if (inspected && attachment.readSourceText) { const current = await attachment.readSourceText(); if (current.sourceId !== inspected.sourceId || current.sourceRevision !== inspected.sourceRevision) throw new Error('原始来源在保存时改变。'); }
  if (json(result.source) !== json(identity)) throw new Error('保存期间后处理来源身份已变化。');
  const companionBundles=await captureProjectCompanionBundles(attachment,writer);
  const rawCompanionCandidates=await captureRawProjectCompanionCandidates(attachment,writer);
  const sourceRevision=inspected?.sourceRevision??rawOutput?.revision;
  const generatedPackage = await readGeneratedXtbSourcePackage(attachment.source);
  const generatedXtbPackage = generatedPackage ? await writer.write('sources', 'gfn2-source-package.json', encoder.encode(json(generatedPackage))) : undefined;
  if (projectCompanionVersion(attachment) !== companionRevision) throw Error('保存期间来源配套集合变化；未提交混合快照。');
  return { data, ...(attachment.role ? { role: attachment.role } : {}), result: await encode(result), results: await Promise.all(results.map(encode)), raw: { sourceId: identity.id, name: identity.name, size: identity.size, ...(sourceRevision ? { revision: sourceRevision } : {}), chunks },...(companionBundles?{companionBundles}:{}),...(rawCompanionCandidates?{rawCompanionCandidates}:{}), ...(generatedXtbPackage ? { generatedXtbPackage } : {}) };
}
export async function encodePostprocessDocument(document: PostprocessDocument, writer: ProjectAssetWriter): Promise<PostprocessDocumentSnapshot> {
  const memo = new Map<TrajectoryResult, Promise<TrajectoryResultSnapshot>>();
  const output = document.output ? await encodeAttachment(document.output, writer, memo) : undefined;
  const wavefunction = document.wavefunction ? await encodeAttachment(document.wavefunction, writer, memo) : undefined;
  const companions = document.companions ? await Promise.all(document.companions.map(value => encodeAttachment(value, writer, memo))) : undefined;
  const { primary: _primary, wavefunction: _wave, ...pair } = document.pair ?? {} as PostprocessSourcePair;
  const hasRawCandidates=[output,wavefunction,...companions??[]].some(value=>Boolean(value?.rawCompanionCandidates?.length));
  const extraSources:NonNullable<PostprocessDocumentSnapshot['extraSources']>=[];
  for(const extra of postprocessSourceExtras(document)){const chunks=[],hash=new VibronicSha256();for(let start=0;start<extra.byteSize;start+=CHUNK_BYTES){const bytes=await extra.readRange(start,Math.min(extra.byteSize,start+CHUNK_BYTES));hash.update(bytes);chunks.push({...await writer.write('sources',extra.name,bytes),bytes:bytes.byteLength});}if(hash.digest()!==extra.revision)throw Error('附加原始来源在保存时改变。');extraSources.push({name:extra.name,sourceId:extra.sourceId,revision:extra.revision,byteSize:extra.byteSize,format:extra.format,chunks});}
  const hasGeneratedPackage=[output,wavefunction,...companions??[]].some(value=>Boolean(value?.generatedXtbPackage)), managedTask=getPostprocessTaskAssociation(document);
  const fileRoles = [output,wavefunction,...companions??[]].some(value => value?.role || value?.data.excitationCompanionSelection);
  return { schema: fileRoles?4:hasGeneratedPackage||managedTask||extraSources.length?3:hasRawCandidates?2:1, id: document.id, ...(managedTask?{managedTask:clone(managedTask)}:{}),...(extraSources.length?{extraSources}:{}), result: await encodeTrajectoryResult(document.result, writer), output, wavefunction, companions,
    ...(document.pair ? { pair: clone(pair) } : {}), ...(document.wavefunctionFrameIndex !== undefined ? { wavefunctionFrameIndex: document.wavefunctionFrameIndex } : {}) };
}

function restoreAttachment(snapshot: PostprocessAttachmentSnapshot, reader: ProjectAssetReader): PostprocessAttachment {
  const source: PostprocessSource = { ...clone(snapshot.data), result: decodeTrajectoryResult(snapshot.result, reader), results: snapshot.results.map(result => decodeTrajectoryResult(result, reader)) };
  if (snapshot.generatedXtbPackage) retainGeneratedXtbSourcePackage(source, async () => {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.read(snapshot.generatedXtbPackage!.assetId))) as GeneratedXtbSourcePackage;
    if (value.schema !== 1 || value.bundle.artifactId !== source.generatedXtb?.artifactId) throw Error('GFN2原始来源包身份无效。');
    await validateGeneratedXtbBundle(value.bundle, value.expected);
    if (value.bundle.files.find(file => file.role === 'molden')?.sha256 !== source.metadata?.sourceRevision) throw Error('GFN2原始来源包与波函数版本不一致。');
    return value;
  });
  const raw = snapshot.raw;
  if (raw.sourceId !== source.result.source.id || raw.name !== source.result.source.name || raw.size !== source.result.source.size
    || raw.chunks.reduce((sum, part) => sum + part.bytes, 0) !== raw.size) throw new Error('项目原始来源身份或分块长度不一致。');
  let closed = false;
  const managed = createRestoredManagedSource({ name: raw.name, size: raw.size, revision: raw.revision ?? source.metadata?.sourceRevision, stream: () => input.stream() });
  const input: ResultInputFile = { id: raw.sourceId, name: raw.name, size: raw.size,
    stream() { let index = 0; return new ReadableStream<Uint8Array>({ async pull(controller) { if (closed) return controller.error(new Error('项目来源已关闭。')); if (index === raw.chunks.length) return controller.close(); const part = raw.chunks[index++]; const bytes = await reader.read(part.assetId); if (bytes.byteLength !== part.bytes) return controller.error(new Error('项目来源分块损坏。')); controller.enqueue(bytes); } }); },
    async readRange(start, end, signal) {
      assertResultNotAborted(signal); if (closed) throw new Error('项目来源已关闭。');
      if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > raw.size || end - start > 64 * 1024 ** 2) throw new Error('项目来源范围无效。');
      const output = new Uint8Array(end - start); let offset = 0;
      for (const part of raw.chunks) { const next = offset + part.bytes; if (next > start && offset < end) { const bytes = await reader.read(part.assetId); assertResultNotAborted(signal); if (closed || bytes.byteLength !== part.bytes) throw new Error('项目来源分块损坏或已关闭。'); const first = Math.max(start, offset), last = Math.min(end, next); output.set(bytes.subarray(first - offset, last - offset), first - start); } offset = next; }
      return output;
    }, readCompanionSourceToken: signal => managed.token(signal),
    readCompanionSourceDescriptor: signal => managed.describe(signal),
    async close() { closed = true; await managed.close(); } };
  for (const result of new Set([source.result, ...source.results])) { const dispose = result.dispose.bind(result); result.dispose = async () => { closed = true; await managed.close(); return dispose(); }; }
  const attachment=retainPostprocessSourceBytes({ source, ...(snapshot.role ? { role: snapshot.role } : {}), async readSourceText(signal) {
    if (!managed.available()) {
      const decoder = new TextDecoder('utf-8', { fatal: true }), pieces: string[] = [];
      for (let start = 0; start < raw.size; start += CHUNK_BYTES) { const bytes = await input.readRange(start, Math.min(raw.size, start + CHUNK_BYTES), signal); pieces.push(decoder.decode(bytes, { stream: true })); }
      pieces.push(decoder.decode()); const text = pieces.join('');
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text)); assertResultNotAborted(signal);
      const revision = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (source.metadata && revision !== source.metadata.sourceRevision) throw new Error('项目波函数与保存来源修订不一致。');
      return Object.freeze({ name: raw.name, text, sourceId: raw.sourceId, sourceRevision: revision });
    }
    const descriptor = await managed.describe(signal);
    return Object.freeze({ name: raw.name, sourceToken: descriptor.token, sourceId: raw.sourceId, sourceRevision: descriptor.revision });
  }, readCompanionSourceToken: signal => managed.token(signal) }, input);
  if(snapshot.companionBundles)restoreProjectCompanionBundles(attachment,snapshot.companionBundles,reader);
  if(snapshot.rawCompanionCandidates)restoreRawProjectCompanionCandidates(attachment,snapshot.rawCompanionCandidates,reader,raw.revision);
  return attachment;
}
export function decodePostprocessDocument(snapshot: PostprocessDocumentSnapshot, reader: ProjectAssetReader): PostprocessDocument {
  if ('kind' in snapshot) throw Error('文件级来源须通过通用科学文件恢复入口读取。');
  if (snapshot.schema !== 1 && snapshot.schema !== 2 && snapshot.schema !== 3 && snapshot.schema !== 4) throw new Error('不支持的项目后处理版本。');
  if(snapshot.schema<3&&[snapshot.output,snapshot.wavefunction,...snapshot.companions??[]].some(value=>value?.generatedXtbPackage))throw new Error('GFN2完整来源包需要新版来源索引，不能降级读取。');
  if(snapshot.schema===1&&[snapshot.output,snapshot.wavefunction,...snapshot.companions??[]].some(value=>value?.rawCompanionCandidates!==undefined))throw new Error('原始配套候选需要新版来源索引，不能按旧schema降级读取。');
  const output = snapshot.output ? restoreAttachment(snapshot.output, reader) : undefined, wavefunction = snapshot.wavefunction ? restoreAttachment(snapshot.wavefunction, reader) : undefined;
  if (snapshot.pair && (!output || !wavefunction)) throw new Error('项目配对证明缺少对应来源。');
  const document: PostprocessDocument = { id: snapshot.id, result: decodeTrajectoryResult(snapshot.result, reader), output, wavefunction,
    companions: snapshot.companions?.map(value => restoreAttachment(value, reader)),
    ...(snapshot.pair ? { pair: { ...clone(snapshot.pair), primary: output!.source, wavefunction: wavefunction!.source } } : {}),
    ...(snapshot.wavefunctionFrameIndex !== undefined ? { wavefunctionFrameIndex: snapshot.wavefunctionFrameIndex } : {}) };
  if (snapshot.managedTask) { const value = snapshot.managedTask; if (snapshot.schema < 3 || !value.taskId || !value.sourceSetId || !value.sourceVersion || value.archived !== true) throw Error('项目受管理来源引用无效或需要较新格式。'); setPostprocessTaskAssociation(document, value, true); }
  if(snapshot.extraSources){if(snapshot.schema<3)throw Error('附加原始来源需要较新格式。');let closed=false;const dispose=document.result.dispose.bind(document.result);document.result.dispose=async()=>{closed=true;return dispose();};retainPostprocessSourceExtras(document,snapshot.extraSources.map(extra=>{if(extra.chunks.reduce((sum,part)=>sum+part.bytes,0)!==extra.byteSize)throw Error('附加原始来源分块无效。');return{...extra,async readRange(start,end,signal){assertResultNotAborted(signal);if(closed||start<0||end<start||end>extra.byteSize)throw Error('附加来源已关闭或读取范围无效。');const bytes=new Uint8Array(end-start);let offset=0;for(const chunk of extra.chunks){const next=offset+chunk.bytes;if(next>start&&offset<end){const value=await reader.read(chunk.assetId);assertResultNotAborted(signal);if(closed||value.length!==chunk.bytes)throw Error('附加原始来源已关闭或损坏。');const first=Math.max(start,offset),last=Math.min(end,next);bytes.set(value.subarray(first-offset,last-offset),first-start);}offset=next;}return bytes;}};}));}
  return document;
}

export async function encodePostprocessFileDocument(document: PostprocessFileDocument, writer: ProjectAssetWriter): Promise<PostprocessFileDocumentSnapshot> {
  if (!isScientificFileDocument(document)) return encodePostprocessDocument(document, writer);
  const source = document.output.source, { jobs: _jobs, dispose: _dispose, ...metadata } = source;
  const data = clone(metadata), identity = clone(source.identity), chunks: PostprocessAttachmentSnapshot['raw']['chunks'] = [], hash = new VibronicSha256();
  for (let start = 0; start < identity.size; start += CHUNK_BYTES) {
    const end = Math.min(identity.size, start + CHUNK_BYTES), bytes = await readPostprocessFileSourceBytes(document.output, start, end);
    hash.update(bytes); chunks.push({ ...await writer.write('sources', identity.name, bytes), bytes: bytes.length });
  }
  const revision = hash.digest();
  if (identity.sha256 && identity.sha256 !== revision || json(identity) !== json(source.identity)) throw Error('科学文件在读取或保存后变化；上一有效项目保持。');
  const memo = new Map<TrajectoryResult, Promise<TrajectoryResultSnapshot>>();
  const pair = document.pair;
  if (pair && (!document.wavefunction || pair.wavefunction !== document.wavefunction.source || pair.primary.result.id !== source.selectedJobId || !postprocessFileJobSource(source))) throw Error('科学文件配对证明与所保存job不一致。');
  const { primary: _primary, wavefunction: _wave, ...proof } = pair ?? {} as PostprocessSourcePair;
  const jobs: PostprocessScientificFileDocumentSnapshot['output']['jobs'] = [];
  for (const job of source.jobs) {
    if ('kind' in job && job.kind === 'diagnostic') { const { readSourceRange: _read, dispose: _close, ...value } = job; jobs.push({ kind: 'diagnostic', data: clone(value) }); }
    else jobs.push({ kind: 'geometry', snapshot: await encodeTrajectoryResult(job as TrajectoryResult, writer) });
  }
  const extraSources: NonNullable<PostprocessScientificFileDocumentSnapshot['extraSources']> = [];
  for (const extra of document.extraSources ?? []) {
    if (!/^[a-f0-9]{64}$/.test(extra.revision) || !Number.isSafeInteger(extra.byteSize) || extra.byteSize < 0) throw Error('附加科学资产身份无效。');
    const chunks = [], hash = new VibronicSha256();
    for (let start = 0; start < extra.byteSize; start += CHUNK_BYTES) { const end = Math.min(extra.byteSize, start + CHUNK_BYTES), bytes = await extra.readRange(start, end); if (bytes.length !== end - start) throw Error('附加科学资产长度变化。'); hash.update(bytes); chunks.push({ ...await writer.write('sources', extra.name, bytes), bytes: bytes.length }); }
    if (hash.digest() !== extra.revision) throw Error('附加科学资产SHA变化，未提交混合来源。');
    extraSources.push({ name: extra.name, sourceId: extra.sourceId, revision: extra.revision, byteSize: extra.byteSize, format: extra.format, ...(extra.role ? { role: extra.role } : {}), chunks });
  }
  return { schema: 4, kind: 'scientific-file', id: document.id, output: { data, ...(document.output.role ? { role: document.output.role } : {}), jobs, raw: { sourceId: identity.id, name: identity.name, size: identity.size, revision, chunks } },
    ...(pair ? { pair: { jobId: pair.primary.result.id, waveSourceId: pair.wavefunction.result.source.id, waveRevision: pair.wavefunction.metadata!.sourceRevision, proof: clone(proof) } } : {}),
    ...(document.wavefunction ? { wavefunction: await encodeAttachment(document.wavefunction, writer, memo) } : {}),
    ...(document.companions ? { companions: await Promise.all(document.companions.map(item => encodeAttachment(item, writer, memo))) } : {}),
    ...(document.displayResult ? { displayResult: await encodeTrajectoryResult(document.displayResult, writer) } : {}),
    ...(document.sourceWarnings ? { sourceWarnings: clone(document.sourceWarnings) } : {}), ...(extraSources.length ? { extraSources } : {}) };
}

/** Restores source bytes and scientific facts directly. No parser, engine, or converter runs. */
export function decodePostprocessFileDocument(snapshot: PostprocessFileDocumentSnapshot, reader: ProjectAssetReader): PostprocessFileDocument {
  if (!('kind' in snapshot)) return decodePostprocessDocument(snapshot, reader);
  if (snapshot.kind !== 'scientific-file') throw Error('未知科学文件schema4类型。');
  const raw = clone(snapshot.output.raw), metadata = clone(snapshot.output.data);
  if (!metadata.fileOnly || metadata.identity.id !== raw.sourceId || metadata.identity.name !== raw.name || metadata.identity.size !== raw.size || !Number.isSafeInteger(raw.size) || raw.size < 0
    || !raw.chunks.every(part => typeof part.assetId === 'string' && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= CHUNK_BYTES) || raw.chunks.reduce((sum, part) => sum + part.bytes, 0) !== raw.size || !raw.revision || metadata.identity.sha256 && metadata.identity.sha256 !== raw.revision) throw Error('科学文件原始资产索引不一致。');
  let closed = false, remaining = snapshot.output.jobs.length;
  const input: ResultInputFile = { id: raw.sourceId, name: raw.name, size: raw.size,
    stream() { let index = 0; return new ReadableStream<Uint8Array>({ async pull(controller) { if (closed) return controller.error(Error('科学文件已关闭。')); if (index === raw.chunks.length) return controller.close(); const part = raw.chunks[index++], bytes = await reader.read(part.assetId); if (closed || bytes.length !== part.bytes) return controller.error(Error('科学文件分块损坏或已关闭。')); controller.enqueue(bytes); } }); },
    async readRange(start, end, signal) {
      assertResultNotAborted(signal); if (closed) throw Error('科学文件已关闭。');
      if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > raw.size) throw Error('科学文件字节范围无效。');
      const bytes = new Uint8Array(end - start); let offset = 0;
      for (const part of raw.chunks) { const next = offset + part.bytes; if (next > start && offset < end) { const block = await reader.read(part.assetId); assertResultNotAborted(signal); if (closed || block.length !== part.bytes) throw Error('科学文件分块损坏或已关闭。'); const first = Math.max(start, offset), last = Math.min(end, next); bytes.set(block.subarray(first - offset, last - offset), first - start); } offset = next; }
      return bytes;
    }, close() { closed = true; } };
  const release = () => { if (--remaining === 0) closed = true; };
  const jobs = snapshot.output.jobs.map(item => {
    let disposed = false;
    if (item.kind === 'diagnostic') {
      const data = clone(item.data);
      if (data.kind !== 'diagnostic' || data.source.id !== raw.sourceId || data.source.name !== raw.name || data.source.size !== raw.size) throw Error('诊断job不属于所保存文件。');
      return { ...data, async readSourceRange(start: number, end: number, signal?: AbortSignal) { if (disposed) throw Error('诊断job已关闭。'); return input.readRange(start, end, signal); }, dispose() { if (disposed) return; disposed = true; release(); } } as ResultDiagnostic;
    }
    const result = decodeTrajectoryResult(item.snapshot, reader), dispose = result.dispose.bind(result);
    if (result.source.id !== raw.sourceId || result.source.name !== raw.name || result.source.size !== raw.size) throw Error('几何job不属于所保存文件。');
    result.dispose = async () => { if (disposed) return; await dispose(); disposed = true; release(); }; return result;
  });
  if (!jobs.length || metadata.selectedJobId && !jobs.some(job => job.id === metadata.selectedJobId)) throw Error('科学文件job选择或集合无效。');
  const source: PostprocessScientificFileSource = { ...metadata, identity: { ...metadata.identity, sha256: raw.revision }, jobs, async dispose() { await Promise.all(jobs.map(job => job.dispose())); } };
  const output = retainPostprocessFileSourceBytes({ source, ...(snapshot.output.role ? { role: snapshot.output.role } : {}) }, input);
  const displayResult = snapshot.displayResult ? decodeTrajectoryResult(snapshot.displayResult, reader) : undefined;
  if (displayResult && (!source.selectedJobId || displayResult.scientific?.ircEvidence?.outputId !== source.selectedJobId && displayResult.id !== source.selectedJobId)) throw Error('科学文件显示轨迹缺少所选job对应。');
  const extraSources = snapshot.extraSources?.map(supplied => {
    const extra = clone(supplied); let disposed = false;
    if (!/^[a-f0-9]{64}$/.test(extra.revision) || !Number.isSafeInteger(extra.byteSize) || extra.byteSize < 0 || !extra.chunks.every(part => part.assetId && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= CHUNK_BYTES) || extra.chunks.reduce((sum, part) => sum + part.bytes, 0) !== extra.byteSize) throw Error('附加科学资产索引无效。');
    return { name: extra.name, sourceId: extra.sourceId, revision: extra.revision, byteSize: extra.byteSize, format: extra.format, role: extra.role,
      async readRange(start: number, end: number, signal?: AbortSignal) { assertResultNotAborted(signal); if (disposed || ![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > extra.byteSize) throw Error('附加科学资产范围无效或已关闭。'); const bytes = new Uint8Array(end - start); let offset = 0; for (const part of extra.chunks) { const next = offset + part.bytes; if (next > start && offset < end) { const block = await reader.read(part.assetId); assertResultNotAborted(signal); if (disposed || block.length !== part.bytes) throw Error('附加科学资产已关闭或分块损坏。'); const first = Math.max(start, offset), last = Math.min(end, next); bytes.set(block.subarray(first - offset, last - offset), first - start); } offset = next; } return bytes; }, dispose() { disposed = true; } };
  });
  const wavefunction = snapshot.wavefunction ? restoreAttachment(snapshot.wavefunction, reader) : undefined;
  const primary = postprocessFileJobSource(source), savedPair = snapshot.pair;
  if (savedPair && (!primary || !wavefunction || savedPair.proof.conflicts.length || savedPair.proof.notices.some(note => /^来源.+记录不一致/.test(note)) || savedPair.jobId !== primary.result.id || savedPair.waveSourceId !== wavefunction.source.result.source.id || savedPair.waveRevision !== wavefunction.source.metadata?.sourceRevision || !primary.result.frames.some(frame => frame.index === savedPair.proof.frameIndex))) throw Error('科学文件保存的job/波函数配对身份不一致。');
  return { kind: 'scientific-file', id: snapshot.id, output, ...(wavefunction ? { wavefunction } : {}), ...(savedPair && primary && wavefunction ? { pair: { ...clone(savedPair.proof), primary, wavefunction: wavefunction.source } } : {}),
    ...(snapshot.companions ? { companions: snapshot.companions.map(item => restoreAttachment(item, reader)) } : {}), ...(displayResult ? { displayResult } : {}), ...(snapshot.sourceWarnings ? { sourceWarnings: clone(snapshot.sourceWarnings) } : {}), ...(extraSources?.length ? { extraSources } : {}) };
}
export const encodeResult = encodeTrajectoryResult;
export const decodeResult = decodeTrajectoryResult;
