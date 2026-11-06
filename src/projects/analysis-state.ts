import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';
import type { SurfaceContext } from '../results/surface-contracts';
import type { CubeAtom, SurfaceGrid, SurfaceValidDomain, SurfaceScalarField } from '../results/surface-contracts';

/** Scientific caches contain data only. Native owners, workers and meshes are
 * deliberately rejected rather than silently omitted from a complete save. */
type Encoded = null | boolean | string | number | Encoded[] | { [key: string]: Encoded };
export interface AnalysisProjectEntry { key: string; assetId: string; citationMetadata?:unknown; /** Complete immutable dependency closure, including assetId itself. */ assetReferences?: string[] }
export interface AnalysisProjectState { schema: 1; entries: AnalysisProjectEntry[]; /** Legacy entries lack dependency indexes; same-project GC must conservatively retain the prior manifest. */ preserveUnlistedAssets?: true }
export interface AnalysisProjectScope { documentId: string; documentIds?: readonly string[]; sourceIds: readonly string[] }
/** Compare parsed identity tokens, never substrings (document `a` is not `aa`). */
export function analysisProjectEntryInScope(key: string, scope: AnalysisProjectScope): boolean {
  const start = key.indexOf('['); if (start < 0) return false;
  let parts: unknown; try { parts = JSON.parse(key.slice(start)); } catch { return false; }
  if (!Array.isArray(parts)) return false;
  const documentIndex = key.startsWith('controls:') ? 2 : ['cube-source:', 'surface-family:', 'excitation-selection:', 'postprocess-plot-windows:', 'hirshfeld:', 'analysis-panel:'].some(prefix => key.startsWith(prefix)) ? 0 : -1;
  if (documentIndex >= 0) return parts[documentIndex] === scope.documentId || scope.documentIds?.includes(parts[documentIndex] as string) === true || key.startsWith('controls:') && parts[documentIndex] === null && scope.sourceIds.includes(parts[0] as string);
  return parts.some(value => value === scope.documentId) || parts.some(value => typeof value === 'string' && scope.sourceIds.includes(value));
}
interface Owner { capture(): unknown | Promise<unknown>; citationMetadata?():unknown; restore?(value: unknown): void; onError?(message: string): void }
export interface AnalysisCitationOwner {documentId?:string;sourceId?:string;sourceRevision?:string;analysisId?:string}
export const AnalysisCitationContext=createContext<AnalysisCitationOwner|undefined>(undefined);
const retainedCitationMetadata=new Map<string,unknown>();
/** Pure projection: do not touch getters, scientific buffers, grids or runtime owners. */
export function analysisCitationMetadata(value:unknown,owner?:AnalysisCitationOwner):unknown {
 const emptyArrays=new Set(['atoms','bonds','vertices','pairs','frontier','points','bins','metrics','integrals']);
 const skipped=new Set(['values','coordinates','originalBytes','precision','grid','mask','rawArtifacts','request','pending','controller','file','pendingFile','failedFile']);
 const seen=new WeakSet<object>();
 const visit=(v:unknown):unknown=>{
  if(!v||typeof v!=='object')return typeof v==='function'?undefined:v;
  if(ArrayBuffer.isView(v)||v instanceof ArrayBuffer||seen.has(v))return undefined;
  seen.add(v);
  try{if(v instanceof Map)return new Map([...v].map(([k,x])=>[k,visit(x)]));if(Array.isArray(v))return v.map(visit);if(v instanceof Set)return [...v].map(visit);if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)return undefined;const result:Record<string,unknown>={};for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(skipped.has(k)||!('value'in d))continue;result[k]=emptyArrays.has(k)?[]:visit(d.value);}return result;}finally{seen.delete(v);}
 };
 const data=visit(value);return owner?{citationOwner:{...owner},citationData:data}:data;
}
const owners = new Map<string, Owner>();
const retained = new Map<string, unknown | Promise<unknown>>();
const lazy = new Map<string, { assetId: string; citationMetadata?:unknown; assetReferences?: string[]; reader: ProjectAssetReader; pending?: Promise<unknown> }>();
const loading = new Map<string, Promise<void>>();
const settledAnalysisPromises=new WeakSet<Promise<unknown>>();
function trackAnalysisPromise<T>(promise:Promise<T>):Promise<T>{void promise.then(()=>settledAnalysisPromises.add(promise),()=>settledAnalysisPromises.add(promise));return promise;}
let analysisRevision = 0;
const analysisListeners = new Set<() => void>();
export const getAnalysisProjectRevision = () => analysisRevision;
export function subscribeAnalysisProjectState(listener: () => void): () => void { analysisListeners.add(listener); return () => { analysisListeners.delete(listener); }; }
export function notifyAnalysisProjectStateChanged(): void { analysisRevision++; for (const listener of analysisListeners) listener(); }
const restoredData = new WeakSet<object>();
function markRestored(value: unknown): void {
  if (!value || typeof value !== 'object' || restoredData.has(value)) return;
  restoredData.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  if (value instanceof Map) { for (const [key, item] of value) { markRestored(key); markRestored(item); } }
  else if (value instanceof Set) for (const item of value) markRestored(item);
  else for (const item of Object.values(value)) markRestored(item);
}
export function isRestoredAnalysisData(value: unknown): boolean { return !!value && typeof value === 'object' && restoredData.has(value); }
export function markRestoredAnalysisData<T>(value: T): T { markRestored(value); return value; }
export interface AnalysisOriginalCube { name: string; originalBytes: Uint8Array; sourceRevision: string; fieldMetadata: Omit<SurfaceScalarField, 'values'> }
export const analysisOriginalCubeKey = (analysisId: string, context: SurfaceContext, fieldId: string) => `cube-source:${JSON.stringify([context.documentId, analysisId, context.sourceId, context.sourceRevision, fieldId])}`;
export async function captureAnalysisOriginalSources(scope: AnalysisProjectScope): Promise<{ key: string; source: AnalysisOriginalCube }[]> {
  const keys = new Set([...retained.keys(), ...lazy.keys()]); const result: { key: string; source: AnalysisOriginalCube }[] = [];
  for (const key of keys) if (key.startsWith('cube-source:') && analysisProjectEntryInScope(key, scope)) {
    const value = await load(key) as AnalysisOriginalCube | undefined;
    if (!value || !(value.originalBytes instanceof Uint8Array) || !value.sourceRevision || !value.name) throw Error('插入的Cube原始来源不完整，不能保存任务。');
    result.push({ key, source: { ...value, originalBytes: value.originalBytes.slice() } });
  }
  return result;
}
export function retainAnalysisProjectSnapshot(key: string, value: unknown): void { retained.set(key, freeze(value, key));retainedCitationMetadata.set(key,analysisCitationMetadata(value)); notifyAnalysisProjectStateChanged(); }
const typed = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
const bad = (path: string, detail: string): never => { throw new Error(`无法完整保存分析结果 ${path}：${detail}`); };
function freeze(value: unknown, path: string, stack = new Set<object>()): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') return bad(path, '存在函数或其他未适配的运行对象。');
  if (!value || typeof value !== 'object') return value;
  if (stack.has(value)) return bad(path, '存在循环引用。');
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    if (value instanceof DataView) return bad(path, 'DataView尚未适配。');
    return structuredClone(value);
  }
  stack.add(value);
  try {
    if (value instanceof Map) return new Map([...value].map(([key, item]) => [freeze(key, path, stack), freeze(item, path, stack)]));
    if (value instanceof Set) return new Set([...value].map(item => freeze(item, path, stack)));
    if (Array.isArray(value)) return value.map((item, index) => freeze(item, `${path}[${index}]`, stack));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return bad(path, `${value.constructor?.name ?? '对象'}尚未适配。`);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item, `${path}.${key}`, stack)]));
  } finally { stack.delete(value); }
}

async function encode(value: unknown, writer: ProjectAssetWriter, path: string, stack = new Set<object>()): Promise<Encoded> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { $sy: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'undefined') return { $sy: 'undefined' };
  if (typeof value === 'bigint') return { $sy: 'bigint', value: String(value) };
  if (typeof value !== 'object') return bad(path, '存在函数或其他未适配的运行对象。');
  if (stack.has(value)) return bad(path, '存在循环引用。');
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    if (value instanceof DataView) return bad(path, 'DataView尚未适配。');
    const name = value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name;
    if (name !== 'ArrayBuffer' && !Object.hasOwn(typed, name)) return bad(path, '未知类型化数组。');
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const { assetId } = await writer.write(path.endsWith('.originalBytes') ? 'sources' : 'results', path.endsWith('.originalBytes') ? 'original-cube.bin' : 'analysis-grid.bin', bytes);
    return { $sy: 'buffer', type: name, assetId, bytes: bytes.byteLength, role: path.endsWith('.originalBytes') ? 'source' : 'grid' };
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) return { $sy: 'array', values: await Promise.all(value.map((item, index) => encode(item, writer, `${path}[${index}]`, new Set(stack)))) };
    if (value instanceof Map) return { $sy: 'map', values: await Promise.all([...value].map(async ([key, item], index) => [await encode(key, writer, `${path}.key${index}`, new Set(stack)), await encode(item, writer, `${path}.value${index}`, new Set(stack))])) };
    if (value instanceof Set) return { $sy: 'set', values: await Promise.all([...value].map((item, index) => encode(item, writer, `${path}.set${index}`, new Set(stack)))) };
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return bad(path, `${value.constructor?.name ?? '对象'}尚未适配。`);
    return { $sy: 'object', values: await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item, writer, `${path}.${key}`, new Set(stack))])) };
  } finally { stack.delete(value); }
}
async function decode(value: Encoded, reader: ProjectAssetReader): Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) throw new Error('项目分析数组索引无效。');
  if (value.$sy === 'undefined') return undefined;
  if (value.$sy === 'number') return value.value === '-0' ? -0 : Number(value.value);
  if (value.$sy === 'bigint') return BigInt(value.value as string);
  if (value.$sy === 'buffer') {
    const bytes = await reader.read(value.assetId as string);
    if (bytes.byteLength !== value.bytes) throw new Error('项目分析格点字节长度不符。');
    const buffer = bytes.slice().buffer;
    if (value.type === 'ArrayBuffer') return buffer;
    const ctor = typed[value.type as keyof typeof typed];
    if (!ctor || buffer.byteLength % ctor.BYTES_PER_ELEMENT) throw new Error('项目分析格点类型或长度无效。');
    return new ctor(buffer);
  }
  if (!Array.isArray(value.values)) throw new Error('项目分析结果索引无效。');
  if (value.$sy === 'array' || value.$sy === 'set') {
    const entries = await Promise.all(value.values.map(item => decode(item, reader)));
    return value.$sy === 'array' ? entries : new Set(entries);
  }
  if (value.$sy === 'map' || value.$sy === 'object') {
    const entries = await Promise.all(value.values.map(async pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('项目分析键值索引无效。');
      return [value.$sy === 'map' ? await decode(pair[0], reader) : pair[0], await decode(pair[1], reader)] as [string, unknown];
    }));
    return value.$sy === 'map' ? new Map(entries) : Object.fromEntries(entries);
  }
  throw new Error('未知项目分析数据类型。');
}

export function readAnalysisProjectSnapshot<T>(key: string): T | undefined {
  const value = retained.get(key);
  if (value instanceof Promise) return undefined;
  return value as T | undefined;
}
async function load(key: string): Promise<unknown> {
  const entry = lazy.get(key);
  if (!entry) return retained.get(key);
  entry.pending ??= trackAnalysisPromise((async () => {
    const value = await decode(JSON.parse(text.decode(await entry.reader.read(entry.assetId))) as Encoded, entry.reader);
    markRestored(value);
    if (lazy.get(key) === entry) { retained.set(key, value);if(entry.citationMetadata!==undefined)retainedCitationMetadata.set(key,decodeCitationMetadata(entry.citationMetadata as Encoded));lazy.delete(key); }
    return value;
  })());
  return entry.pending;
}
export async function loadAnalysisProjectSnapshot<T>(key: string): Promise<T | undefined> { return await load(key) as T | undefined; }
function decodeCitationMetadata(value:Encoded):unknown {
 if(!value||typeof value!=='object')return value;if(Array.isArray(value))return value.map(decodeCitationMetadata);
 if(value.$sy==='buffer'||value.$sy==='undefined')return undefined;if(value.$sy==='number')return Number(value.value);
 if(value.$sy==='array'||value.$sy==='set')return (value.values as Encoded[]).map(decodeCitationMetadata);
 if(value.$sy==='object'||value.$sy==='map'){
  const skip=new Set(['values','coordinates','originalBytes','grid','mask','rawArtifacts']),empty=new Set(['atoms','bonds','vertices','pairs','frontier','points','bins','metrics','integrals']);
  const pairs=(value.values as Encoded[][]).filter(pair=>value.$sy==='map'||!skip.has(String(pair[0]))).map(pair=>[value.$sy==='map'?decodeCitationMetadata(pair[0]):pair[0],value.$sy==='object'&&empty.has(String(pair[0]))?[]:decodeCitationMetadata(pair[1])]);
  return value.$sy==='map'?new Map(pairs as [unknown,unknown][]):Object.fromEntries(pairs as [string,unknown][]);
 }
 return undefined;
}
/** Bibliography inspection decodes only saved JSON metadata. Buffer assets are
 * deliberately not read, and no owner restoration or scientific task is run. */
export async function captureAnalysisCitationSnapshots(): Promise<{key:string;snapshot:unknown;warning?:string}[]> {
  const withLegacyOwner=(key:string,snapshot:unknown)=>{if(snapshot&&typeof snapshot==='object'&&'citationOwner'in snapshot)return snapshot;try{if(key.startsWith('analysis-panel:')){const parts=JSON.parse(key.slice('analysis-panel:'.length));return {citationOwner:{analysisId:parts[1],sourceId:parts[3],sourceRevision:parts[4]??parts[3]},citationData:snapshot};}if(key.startsWith('controls:')){const parts=JSON.parse(key.slice(key.indexOf('[')));if(typeof parts[9]==='string')return {citationOwner:{sourceId:parts[0],sourceRevision:parts[1],documentId:parts[2]??undefined,analysisId:parts[9]},citationData:snapshot};}}catch{/* Unsupported old keys do not establish an owner. */}return snapshot;};
  const metadata=decodeCitationMetadata;
  const result:{key:string;snapshot:unknown;warning?:string}[]=[];
  for (const key of new Set([...retained.keys(),...lazy.keys(),...owners.keys()])) {
    const entry=lazy.get(key);
    if(entry){result.push({key,snapshot:withLegacyOwner(key,entry.citationMetadata!==undefined?metadata(entry.citationMetadata as Encoded):metadata(JSON.parse(text.decode(await entry.reader.read(entry.assetId))) as Encoded))});continue;}
    const owner=owners.get(key);
    if(owner){if(owner.citationMetadata)result.push({key,snapshot:analysisCitationMetadata(owner.citationMetadata())});else result.push({key,snapshot:null,warning:`分析条目尚无只读引用元数据适配：${key}`});}
    else result.push({key,snapshot:withLegacyOwner(key,retainedCitationMetadata.has(key)?retainedCitationMetadata.get(key):analysisCitationMetadata(await retained.get(key)))});
  }
  return result;
}
/** Activation is a live view lease, never scientific identity. Rebind only an
 * exact source/job/frame/document match; unrelated cached frames stay intact. */
export function rebindAnalysisContext<T>(value: T, context: SurfaceContext): T {
  const visit = (part: unknown): unknown => {
    if (!part || typeof part !== 'object' || ArrayBuffer.isView(part) || part instanceof ArrayBuffer) return part;
    if (part instanceof Map) return new Map([...part].map(([key, item]) => [key, visit(item)]));
    if (part instanceof Set) return new Set([...part].map(visit));
    if (Array.isArray(part)) return part.map(visit);
    const record = part as Record<string, unknown>;
    const keys = ['sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation', 'documentId', 'documentRevision'] as const;
    const matches = 'activationEpoch' in record && keys.every(key => record[key] === context[key]);
    const result = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, matches && key === 'activationEpoch' ? context.activationEpoch : visit(item)]));
    if (restoredData.has(part)) restoredData.add(result);
    return result;
  };
  return visit(value) as T;
}
export function registerAnalysisProjectSnapshot(key: string, owner: Owner): () => void {
  if (!key || owners.has(key)) throw new Error(`分析结果保存owner重复：${key}`);
  const saved = retained.get(key);
  if (saved !== undefined && !(saved instanceof Promise)) owner.restore?.(saved);
  owners.set(key, owner);
  if (!lazy.has(key) && saved === undefined) notifyAnalysisProjectStateChanged();
  if (lazy.has(key) || saved instanceof Promise) {
    const pending = trackAnalysisPromise(load(key).then(value => { if (owners.get(key) === owner) owner.restore?.(value); }));
    loading.set(key, pending);
    void pending.then(() => { if (loading.get(key) === pending) loading.delete(key); }, error => owner.onError?.(error instanceof Error ? error.message : String(error)));
  }
  return () => {
    if (owners.get(key) !== owner) return;
    if(owner.citationMetadata)retainedCitationMetadata.set(key,analysisCitationMetadata(owner.citationMetadata()));
    if (!loading.has(key) && !lazy.has(key)) {
      try {
        const value = owner.capture();
        if (value instanceof Promise) {
          const pending = trackAnalysisPromise(value.then(snapshot => freeze(snapshot, key))); retained.set(key, pending);
          void pending.then(snapshot => { if (retained.get(key) === pending) retained.set(key, snapshot); }, error => owner.onError?.(error instanceof Error ? error.message : String(error)));
        } else retained.set(key, freeze(value, key));
      } catch (error) { const failed = trackAnalysisPromise(Promise.reject(error)); void failed.catch(() => {}); retained.set(key, failed); owner.onError?.(error instanceof Error ? error.message : String(error)); }
    }
    owners.delete(key);
  };
}
/** Capture must exclude transient request/progress/hover and include every
 * completed numeric result and scientific field, including node masks. */
export function useAnalysisProjectSnapshot<T>(key: string, capture: () => T | Promise<T>, restore: (value: T) => void, onError?: (message: string) => void, citationMetadata?:()=>unknown): void {
  const citationOwner=useContext(AnalysisCitationContext);
  const latest = useMemo(() => ({ current: { capture, restore, onError,citationMetadata,citationOwner } }), [key]); latest.current = { capture, restore, onError,citationMetadata,citationOwner };
  useEffect(() => registerAnalysisProjectSnapshot(key, { capture: () => latest.current.capture(), ...(citationMetadata?{citationMetadata:()=>analysisCitationMetadata(latest.current.citationMetadata!(),latest.current.citationOwner)}:{}),restore: value => latest.current.restore(value as T), onError: message => latest.current.onError?.(message) }), [key,latest,Boolean(citationMetadata)]);
}
export function forgetAnalysisProjectSnapshots(prefix?: string): void {
  for(const key of retainedCitationMetadata.keys())if(prefix===undefined||key.startsWith(prefix))retainedCitationMetadata.delete(key);
  for (const key of owners.keys()) if (prefix === undefined || key.startsWith(prefix)) owners.delete(key);
  for (const key of retained.keys()) if (prefix === undefined || key.startsWith(prefix)) retained.delete(key);
  for (const key of lazy.keys()) if (prefix === undefined || key.startsWith(prefix)) lazy.delete(key);
  for (const key of loading.keys()) if (prefix === undefined || key.startsWith(prefix)) loading.delete(key);
  notifyAnalysisProjectStateChanged();
}
/** Source-only orbital/charge entries can be shared by two documents. Main
 * supplies still-live source IDs so closing one consumer retains shared data. */
const analysisOwnerTokens=new WeakMap<object,number>();let analysisOwnerSerial=0;
export function describeAnalysisProjectDocument(documentId:string,sourceIds:readonly string[]=[]):{revision:string;hasData:boolean;busy:boolean;labels:string[]}{
  const quotedDocument=JSON.stringify(documentId),sources=sourceIds.map(id=>JSON.stringify(id));
  const keys=[...new Set([...owners.keys(),...retained.keys(),...lazy.keys(),...loading.keys()])].filter(key=>key.includes(quotedDocument)||sources.some(source=>key.includes(source))).sort();
  const token=(value:unknown):unknown=>{if(!value||typeof value!=='object')return value;let id=analysisOwnerTokens.get(value);if(!id){id=++analysisOwnerSerial;analysisOwnerTokens.set(value,id);}return id;};
  const busy=keys.some(key=>[loading.get(key),retained.get(key),lazy.get(key)?.pending].some(value=>value instanceof Promise&&!settledAnalysisPromises.has(value)));
  return{revision:JSON.stringify([analysisRevision,keys.map(key=>[key,token(owners.get(key)),token(retained.get(key)),token(lazy.get(key)),token(loading.get(key))])]),hasData:keys.length>0,busy,labels:keys.length?['已保存或已挂载的分析内容']:[]};
}
export function forgetAnalysisProjectDocument(documentId: string, sourceIds: readonly string[] = [], stillLiveSourceIds: readonly string[] = []): void {
  const quotedDocument = JSON.stringify(documentId), sources = sourceIds.filter(id => !stillLiveSourceIds.includes(id)).map(id => JSON.stringify(id));
  const keys = new Set([...owners.keys(), ...retained.keys(), ...lazy.keys()]);
  const documentBound=(key:string)=>{
    try{const start=key.indexOf('[');if(start<0)return false;const parts=JSON.parse(key.slice(start));if(!Array.isArray(parts))return false;
      return(key.startsWith('controls:')?parts[2]:['cube-source:','surface-family:','excitation-selection:','postprocess-plot-windows:','hirshfeld:','analysis-panel:'].some(prefix=>key.startsWith(prefix))?parts[0]:undefined)===documentId;
    }catch{return false;}
  };
  for (const key of keys) if (documentBound(key) || !stillLiveSourceIds.includes(documentId)&&key.includes(quotedDocument) || sources.some(source => key.includes(source))) {
    owners.delete(key); retained.delete(key); lazy.delete(key); loading.delete(key);
    retainedCitationMetadata.delete(key);
  }
  notifyAnalysisProjectStateChanged();
}
export async function captureAnalysisProjectState(writer: ProjectAssetWriter, options: { reuse?: boolean; scope?: AnalysisProjectScope } = {}): Promise<AnalysisProjectState> {
  const included = (key: string) => !options.scope || analysisProjectEntryInScope(key, options.scope);
  // Freeze every owner before the first asset write, so later UI updates cannot
  // mix source revisions or half-completed numeric buffers into this generation.
  await Promise.all([...loading].filter(([key]) => included(key)).map(async ([key, pending]) => {
    try { await pending; } catch (error) {
      // A failed partial read does not authorize replacing an existing object
      // with its empty UI defaults. Keep the immutable old entry in this root.
      if (!options.reuse || !lazy.has(key)) throw error;
    }
  }));
  const values = new Map([...retained].filter(([key]) => included(key)));
  if (options.reuse) for (const key of lazy.keys()) values.delete(key);
  for (const [key, owner] of owners) if (included(key) && (!options.reuse || !lazy.has(key))) values.set(key, owner.capture());
  const frozen = await Promise.all([...values].map(async ([key, value]) => [key, freeze(await value, key)] as const));
  const entries: AnalysisProjectState['entries'] = [];
  const trackedWriter = (references: Set<string>): ProjectAssetWriter => ({ async write(category, name, bytes) {
    const result = await writer.write(category, name, bytes); references.add(result.assetId); return result;
  } });
  for (const [key, value] of frozen) {
    const references = new Set<string>(), target = trackedWriter(references);
    const encoded = await encode(value, target, key);
    const owner=owners.get(key),citation=owner?.citationMetadata?owner.citationMetadata():retainedCitationMetadata.get(key)??analysisCitationMetadata(value);
    entries.push({ key, citationMetadata:await encode(analysisCitationMetadata(citation),target,`${key}:citation-metadata`),...(await target.write('results', 'analysis-state.json', utf8.encode(JSON.stringify(encoded)))), assetReferences: [...references] });
  }
  // Untouched entries are copied as encoded assets, without allocating their
  // scientific grids. This also makes Save As self-contained in the new root.
  const copy = async (encoded: Encoded, reader: ProjectAssetReader, target: ProjectAssetWriter, path = ''): Promise<Encoded> => {
    if (!encoded || typeof encoded !== 'object') return encoded;
    if (Array.isArray(encoded)) return Promise.all(encoded.map(item => copy(item, reader, target, path)));
    if (encoded.$sy === 'buffer') {
      const bytes = await reader.read(encoded.assetId as string);
      if (bytes.byteLength !== encoded.bytes) throw new Error('项目分析格点字节长度不符。');
      return { ...encoded, ...(await target.write(encoded.role === 'source' ? 'sources' : 'results', encoded.role === 'source' ? 'original-cube.bin' : 'analysis-grid.bin', bytes)) };
    }
    return Object.fromEntries(await Promise.all(Object.entries(encoded).map(async ([key, item]) => [key, await copy(item, reader, target, `${path}.${key}`)])));
  };
  let preserveUnlistedAssets = false;
  for (const [key, entry] of lazy) if (included(key) && !values.has(key)) {
    if (options.reuse) {
      entries.push({ key, assetId: entry.assetId,...(entry.citationMetadata!==undefined?{citationMetadata:entry.citationMetadata}:{}), ...(entry.assetReferences ? { assetReferences: [...entry.assetReferences] } : {}) });
      if (!entry.assetReferences) preserveUnlistedAssets = true;
      continue;
    }
    const references = new Set<string>(), target = trackedWriter(references);
    const encoded = JSON.parse(text.decode(await entry.reader.read(entry.assetId))) as Encoded;
    entries.push({ key, ...(entry.citationMetadata!==undefined?{citationMetadata:entry.citationMetadata}:{}),...(await target.write('results', 'analysis-state.json', utf8.encode(JSON.stringify(await copy(encoded, entry.reader, target))))), assetReferences: [...references] });
  }
  return { schema: 1, entries, ...(preserveUnlistedAssets ? { preserveUnlistedAssets: true as const } : {}) };
}
/** Call before mounting restored documents. This only reads saved data; no
 * native session, worker, mesh or scientific command is created. */
export async function restoreAnalysisProjectState(dto: AnalysisProjectState, reader: ProjectAssetReader, options: { additive?: boolean; scope?: AnalysisProjectScope; transform?(value: unknown): unknown; transformCitation?(value: unknown): unknown; onInvalidEntry?(key: string, error: unknown): void } = {}): Promise<void> {
  if (dto.schema !== 1 || !Array.isArray(dto.entries)) throw new Error('不支持的项目分析结果版本。');
  const next = new Map<string, { assetId: string; citationMetadata?:unknown; assetReferences?: string[]; reader: ProjectAssetReader }>();
  const conflicting = new Set<string>();
  for (const entry of dto.entries) {
    try {
    if (options.scope && !analysisProjectEntryInScope(entry.key, options.scope)) continue;
    if (typeof entry.key !== 'string' || next.has(entry.key) || conflicting.has(entry.key)) { if(typeof entry.key==='string'){next.delete(entry.key);conflicting.add(entry.key);}throw new Error('项目分析结果身份重复或无效。'); }
    if (typeof entry.assetId !== 'string' || !entry.assetId) throw new Error('项目分析结果资产身份无效。');
    if (entry.assetReferences !== undefined && (!Array.isArray(entry.assetReferences) || entry.assetReferences.some(id => typeof id !== 'string' || !id))) throw new Error('项目分析资产依赖索引无效。');
    next.set(entry.key, { assetId: entry.assetId, reader,...(entry.citationMetadata!==undefined?{citationMetadata:entry.citationMetadata}:{}), ...(entry.assetReferences ? { assetReferences: [...new Set([...entry.assetReferences, entry.assetId])] } : {}) });
    } catch (error) { if(!options.additive)throw error;options.onInvalidEntry?.(entry.key,error); }
  }
  if (!options.additive) { retained.clear();retainedCitationMetadata.clear(); lazy.clear(); loading.clear(); }
  for (const [key, value] of next) {
    if (options.additive) {
      try { const decoded = await decode(JSON.parse(text.decode(await value.reader.read(value.assetId))) as Encoded, value.reader); const restored = options.transform ? options.transform(decoded) : decoded; markRestored(restored); retained.set(key, restored); }
      catch (error) { options.onInvalidEntry?.(key, error); next.delete(key); continue; }
      retainedCitationMetadata.delete(key);if(value.citationMetadata!==undefined){const citation=decodeCitationMetadata(value.citationMetadata as Encoded);retainedCitationMetadata.set(key,options.transformCitation?options.transformCitation(citation):citation);}loading.delete(key); lazy.delete(key); continue;
    }
    lazy.set(key, value);
  }
  for (const [key, owner] of owners) if (next.has(key)) {
    const pending = load(key).then(value => { if (owners.get(key) === owner) owner.restore?.(value); }); loading.set(key, pending);
    void pending.then(() => { if (loading.get(key) === pending) loading.delete(key); }, error => owner.onError?.(error instanceof Error ? error.message : String(error)));
  }
  notifyAnalysisProjectStateChanged();
}

/** Export saved scientific grids directly. The companion records physical
 * units/domain; a restricted node mask is never presented as a full-grid field. */
export function analysisProjectCubeArtifacts(field: { grid: SurfaceGrid; atoms: readonly CubeAtom[]; values: Float64Array; valueUnit: string | null; validDomain: SurfaceValidDomain }, label = 'Ester Studio saved scientific field'): { cube: string; metadata: string } {
  const { grid, atoms, values } = field;
  if (grid.ordering !== 'z-fastest' || values.length !== grid.dimensions.reduce((a, b) => a * b, 1) || !values.every(Number.isFinite)) throw new Error('保存格点的数值、尺寸或排序无效，不能导出Cube。');
  const number = (value: number) => { if (!Number.isFinite(value)) throw new Error('Cube包含无效坐标。'); return Object.is(value, -0) ? '-0.0000000000000000e+0' : value.toExponential(16); };
  const rows = [label.replace(/[\r\n]/g, ' '), `valueUnit=${field.valueUnit ?? 'unknown'}; validDomain=${field.validDomain.kind}; see .metadata.json`, `${atoms.length} ${grid.origin.map(number).join(' ')}`];
  grid.axes.forEach((axis, index) => rows.push(`${grid.coordinateUnit === 'angstrom' ? -grid.dimensions[index] : grid.dimensions[index]} ${axis.map(number).join(' ')}`));
  for (const atom of atoms) rows.push(`${atom.atomicNumber} ${number(atom.nuclearCharge)} ${atom.position.map(number).join(' ')}`);
  for (let start = 0; start < values.length; start += 6) rows.push([...values.subarray(start, start + 6)].map(number).join(' '));
  const { values: _values, ...metadata } = field;
  return { cube: rows.join('\n') + '\n', metadata: JSON.stringify({ schema: 'sciyue-saved-grid/v1', ...metadata }, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value, 2) };
}
