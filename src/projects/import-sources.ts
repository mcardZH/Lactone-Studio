import { resultFile, type ScientificSourceFile } from '../results/input-file';
import type { ResultInputFile } from '../results/contracts';
import { assertResultNotAborted } from '../results/contracts';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';

export interface ImportedModelSource {
  sourceId: string; name: string; size: number;
  chunks: { assetId: string; bytes: number }[];
}
export interface ImportedModelSourcesSnapshot {
  schema: 1;
  sources: ImportedModelSource[];
  bundles: { bundleId: string; sourceIds: string[]; documentIds: string[] }[];
}
interface OwnedSource { input: ResultInputFile; identity: { sourceId: string; name: string; size: number }; closed: boolean }
interface Bundle { bundleId: string; sourceIds: string[]; documentIds: Set<string> }
const sources = new Map<string, OwnedSource>(), bundles = new Map<string, Bundle>();
const pendingSourceCloses=new Set<OwnedSource>(),sourceCloseTasks=new WeakMap<OwnedSource,Promise<void>>();
async function releaseRetiredSources():Promise<void>{
  const outcomes=await Promise.allSettled([...pendingSourceCloses].map(source=>{
    const existing=sourceCloseTasks.get(source);if(existing)return existing;
    const task=Promise.resolve().then(()=>source.input.close?.()).then(()=>{pendingSourceCloses.delete(source);}).finally(()=>{sourceCloseTasks.delete(source);});sourceCloseTasks.set(source,task);return task;
  }));
  const failures=outcomes.filter((result):result is PromiseRejectedResult=>result.status==='rejected');if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'部分模型来源读取owner仍待实际关闭。');
}
const fileSources = new WeakMap<ScientificSourceFile, string>();
const CHUNK_BYTES = 8 * 1024 ** 2;

/** Register inside the successful import call, before the launch batch's root
 * lease closes. A bundle records the explicit selected dependency set rather
 * than guessing file/document pairing from similar names. No bytes are saved
 * to disk and no project/recovery directory is created by this operation. */
export async function registerImportedModelSources(documentIds: readonly string[], files: readonly ScientificSourceFile[]): Promise<string | null> {
  const ids = [...new Set(documentIds)];
  if (!ids.length || !files.length) return null;
  if (ids.some(id => typeof id !== 'string' || !id)) throw new Error('导入模型来源缺少有效文档身份。');
  const prepared: OwnedSource[] = [], sourceIds: string[] = [];
  const staged = new Map<ScientificSourceFile, OwnedSource>();
  try {
    for (const file of files) {
      if (file.close && !file.retain) throw new Error('模型来源不提供可保留的读取租约；请在原来源关闭前保留读取器，未改读同名路径。');
      const sameFile = staged.get(file); if (sameFile) { sourceIds.push(sameFile.identity.sourceId); continue; }
      const existingId = fileSources.get(file), existing = existingId ? sources.get(existingId) : undefined;
      if (existing && !existing.closed) { await existing.input.readRange(0, 0); sourceIds.push(existing.identity.sourceId); continue; }
      const input = resultFile(file);
      const owned: OwnedSource = { input, identity: { sourceId: input.id, name: input.name, size: input.size }, closed: false };
      prepared.push(owned); staged.set(file, owned); await input.readRange(0, 0); sourceIds.push(input.id);
    }
    const bundleId = `import-bundle-${crypto.randomUUID()}`;
    for (const owned of prepared) sources.set(owned.identity.sourceId, owned);
    files.forEach((file, index) => fileSources.set(file, sourceIds[index]));
    bundles.set(bundleId, { bundleId, sourceIds: [...new Set(sourceIds)], documentIds: new Set(ids) });
    return bundleId;
  } catch (error) {
    await Promise.allSettled(prepared.map(async owned => { owned.closed = true; await owned.input.close?.(); })); throw error;
  }
}

/** Reuse is an explicit reference to assets already present in THIS target.
 * Save As omits it and copies the source through bounded ranges. */
export async function captureImportedModelSources(writer: ProjectAssetWriter, options: {
  reuse?: ImportedModelSourcesSnapshot; documentIds?: readonly string[];
} = {}): Promise<ImportedModelSourcesSnapshot> {
  const accepted = options.documentIds ? new Set(options.documentIds) : null;
  const selected = [...bundles.values()].map(bundle => ({ bundleId: bundle.bundleId, sourceIds: [...bundle.sourceIds], documentIds: [...bundle.documentIds].filter(id => !accepted || accepted.has(id)) })).filter(bundle => bundle.documentIds.length);
  const ids = new Set(selected.flatMap(bundle => bundle.sourceIds));
  const owned = [...ids].map(id => { const value = sources.get(id); if (!value || value.closed) throw new Error('已导入模型的原始来源已释放；没有改读同名路径。'); return value; });
  const reused = new Map(options.reuse?.sources.map(source => [source.sourceId, source]) ?? []), snapshots: ImportedModelSource[] = [];
  for (const value of owned) {
    const identity = { ...value.identity }, previous = reused.get(identity.sourceId);
    if (previous && previous.name === identity.name && previous.size === identity.size) {
      snapshots.push(structuredClone(previous)); continue;
    }
    const chunks: ImportedModelSource['chunks'] = [];
    for (let start = 0; start < identity.size; start += CHUNK_BYTES) {
      if (value.closed) throw new Error('保存期间导入模型来源已释放。');
      const end = Math.min(start + CHUNK_BYTES, identity.size), bytes = await value.input.readRange(start, end);
      if (value.closed || bytes.byteLength !== end - start) throw new Error('导入模型原始来源读取不完整或已关闭。');
      chunks.push({ ...(await writer.write('sources', identity.name, bytes)), bytes: bytes.byteLength });
    }
    snapshots.push({ ...identity, chunks });
  }
  return { schema: 1, sources: snapshots, bundles: selected };
}

/** Validate the complete object graph before replacing the current source
 * owner. Large source assets remain unopened until a save/export needs them. */
export async function restoreImportedModelSources(snapshot: ImportedModelSourcesSnapshot, reader: ProjectAssetReader): Promise<void> {
  if (snapshot.schema !== 1 || !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.bundles)) throw new Error('不支持的模型原始来源快照。');
  const data = structuredClone(snapshot), ids = new Set<string>(), bundleIds = new Set<string>();
  for (const source of data.sources) {
    if (!source.sourceId || ids.has(source.sourceId) || typeof source.name !== 'string' || !source.name || !Number.isSafeInteger(source.size) || source.size < 0
      || !Array.isArray(source.chunks) || source.chunks.some(chunk => !chunk.assetId || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > CHUNK_BYTES)
      || source.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== source.size) throw new Error('模型原始来源身份或分块无效。');
    ids.add(source.sourceId);
  }
  for (const bundle of data.bundles) {
    if (!bundle.bundleId || bundleIds.has(bundle.bundleId) || !bundle.documentIds.length || new Set(bundle.documentIds).size !== bundle.documentIds.length
      || bundle.documentIds.some(id => typeof id !== 'string' || !id) || !bundle.sourceIds.length || new Set(bundle.sourceIds).size !== bundle.sourceIds.length || bundle.sourceIds.some(id => !ids.has(id))) throw new Error('模型来源bundle或文档归属无效。');
    bundleIds.add(bundle.bundleId);
  }
  await clearImportedModelSources();
  for (const source of data.sources) {
    let closed = false;
    const readRange = async (start: number, end: number, signal?: AbortSignal) => {
      assertResultNotAborted(signal);
      if (closed) throw new Error('模型原始来源已关闭。');
      if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > source.size || end - start > 64 * 1024 ** 2) throw new Error('模型原始来源字节范围无效。');
      const output = new Uint8Array(end - start); let offset = 0;
      for (const chunk of source.chunks) {
        const next = offset + chunk.bytes;
        if (next > start && offset < end) {
          const bytes = await reader.read(chunk.assetId); assertResultNotAborted(signal);
          if (closed || bytes.byteLength !== chunk.bytes) throw new Error('模型原始来源分块已损坏或关闭。');
          const first = Math.max(start, offset), last = Math.min(end, next); output.set(bytes.subarray(first - offset, last - offset), first - start);
        }
        offset = next;
      }
      return output;
    };
    const input: ResultInputFile = { id: source.sourceId, name: source.name, size: source.size, readRange,
      stream() { let offset = 0; return new ReadableStream<Uint8Array>({ async pull(controller) { if (offset === source.size) return controller.close(); const end = Math.min(source.size, offset + CHUNK_BYTES); controller.enqueue(await readRange(offset, end)); offset = end; } }); },
      close() { closed = true; } };
    sources.set(source.sourceId, { input, identity: { sourceId: source.sourceId, name: source.name, size: source.size }, closed: false });
  }
  for (const bundle of data.bundles) bundles.set(bundle.bundleId, { ...bundle, documentIds: new Set(bundle.documentIds) });
}

export async function forgetImportedModelSources(documentId: string): Promise<void> {
  for (const [id, bundle] of bundles) { bundle.documentIds.delete(documentId); if (!bundle.documentIds.size) bundles.delete(id); }
  const liveIds = new Set([...bundles.values()].flatMap(bundle => bundle.sourceIds));
  const retiring = [...sources].filter(([id]) => !liveIds.has(id));
  for (const [id, source] of retiring) { source.closed = true; sources.delete(id);pendingSourceCloses.add(source); }
  await releaseRetiredSources();
}

/** Synchronous publication after a successful Store transaction. Preparation
 * uses a private owner so cancellation never removes the target's old sources. */
export function commitImportedModelSourceBundle(bundleId:string,preparedOwner:string,documentId:string):void {
  const bundle=bundles.get(bundleId);
  if(!bundle||!preparedOwner||!documentId||preparedOwner===documentId||bundle.documentIds.size!==1||!bundle.documentIds.has(preparedOwner))throw new Error('二维来源预提交身份已失效。');
  bundle.documentIds.add(documentId);bundle.documentIds.delete(preparedOwner);
}
export async function clearImportedModelSources(): Promise<void> {
  const previous = [...sources.values()]; bundles.clear(); sources.clear(); previous.forEach(source => { source.closed = true;pendingSourceCloses.add(source); });
  await releaseRetiredSources();
}

/** Read-only handles for small provenance manifests in explicitly owned bundles.
 * Names locate candidates only; consumers must validate the content schema.
 * Every read rechecks the exact bundle/source objects and requested documents,
 * so a late read cannot attach retired assets to a newly opened document. */
export function readImportedModelSourceManifests(documentIds: readonly string[], name: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 ** 2) throw new Error('模型来源manifest读取上限无效。');
  const accepted = new Set(documentIds);
  return [...bundles.values()].flatMap(bundle => {
    const documents = [...bundle.documentIds].filter(id => accepted.has(id));
    if (!documents.length) return [];
    const owned = bundle.sourceIds.map(id => sources.get(id));
    const current = () => bundles.get(bundle.bundleId) === bundle && documents.every(id => bundle.documentIds.has(id))
      && owned.every((source, index) => source && !source.closed && sources.get(bundle.sourceIds[index]) === source);
    const members = owned.flatMap(source => source ? [{ ...source.identity }] : []);
    return owned.flatMap(source => source?.identity.name === name ? [{
      bundleId: bundle.bundleId, documentIds: [...documents], sources: members.map(member => ({ ...member })),
      manifest: { ...source.identity }, isCurrent: current,
      async readSource(sourceId: string, limit = maxBytes): Promise<Uint8Array> {
        const value = owned.find(member => member?.identity.sourceId === sourceId);
        if (!current() || !value || !Number.isSafeInteger(limit) || limit < 0 || limit > 1024 ** 2 || value.identity.size > limit) throw new Error('模型来源已释放、归属变化或超过manifest读取上限。');
        const bytes = await value.input.readRange(0, value.identity.size);
        if (!current() || bytes.byteLength !== value.identity.size) throw new Error('模型来源读取不完整或归属已变化。');
        return bytes;
      },
    }] : []);
  });
}
