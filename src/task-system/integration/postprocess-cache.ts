import { captureAnalysisProjectState, restoreAnalysisProjectState, type AnalysisProjectState } from '../../projects/analysis-state';
import type { ProjectUiStore } from '../../projects/ui-state';
import type { PostprocessCacheManifest, TaskSystemBridge } from '../application-contracts';
import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';
import type { ManagedPostprocessSourceSet, PostprocessTaskAssociation } from './postprocess-managed-source';

const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
const sha = (bytes: Uint8Array) => { const hash = new VibronicSha256(); hash.update(bytes); return hash.digest(); };
export const TASK_POSTPROCESS_CACHE_CAPABILITY = 'es:task-postprocess-cache-v1';
function sameSource(association: PostprocessTaskAssociation, source: ManagedPostprocessSourceSet) { if (association.sourceSetId !== source.descriptor.sourceSetId || association.sourceVersion !== source.descriptor.sourceVersion) throw Error('当前页来源已改变，请先保存对应新来源，再保存后处理缓存。'); }
function taskUiValues(store: ProjectUiStore | undefined, documentId: string): Record<string, unknown> {
 if (!store) return {}; return Object.fromEntries(Object.entries(store.capture().values).filter(([key]) => { try { const parts = JSON.parse(key) as unknown[]; const index = parts.indexOf('document'); return index >= 0 && parts[index + 1] === documentId && parts.slice(index + 2).some(value => typeof value === 'string' && /analysis|postprocess/.test(value)); } catch { return false; } }));
}
export async function saveTaskPostprocessCache(bridge: TaskSystemBridge, association: PostprocessTaskAssociation, source: ManagedPostprocessSourceSet, options: { uiStore?: ProjectUiStore; guard?(): void; onProgress?(value: { phase: string; completed: number; total: number }): void } = {}) {
 sameSource(association, source); options.guard?.();
 const data = new Map<string, { bytes: Uint8Array; role: 'derived-cache' | 'state-index'; name: string }>();
 const writer = { async write(category: string, name: string, value: Uint8Array | string) { options.guard?.(); const bytes = typeof value === 'string' ? utf8.encode(value) : value, assetId = sha(bytes); if (category === 'sources') { if (!source.files.some(file => file.revision === assetId && file.byteSize === bytes.byteLength)) throw Error('缓存包含尚未归档的新原始Cube，请先保存新来源。'); return { assetId }; } if (!data.has(assetId)) data.set(assetId, { bytes: bytes.slice(), role: name.endsWith('.json') ? 'state-index' : 'derived-cache', name }); return { assetId }; } };
 const state = await captureAnalysisProjectState(writer, { scope: source.scope }); options.guard?.();
 const ui = taskUiValues(options.uiStore, association.documentId);
 if (Object.keys(ui).length) { const value = await writer.write('results', 'task-ui.json', utf8.encode(JSON.stringify({ documentId: association.documentId, values: ui }))); state.entries.push({ key: 'task-ui:' + JSON.stringify([source.scope.documentId]), ...value, assetReferences: [value.assetId] }); }
 const cacheId = 'cache-' + crypto.randomUUID(), manifest: Omit<PostprocessCacheManifest, 'savedAt' | 'byteSize' | 'state'> = { schema: 1, capabilities: [TASK_POSTPROCESS_CACHE_CAPABILITY], requiredCapabilities: [TASK_POSTPROCESS_CACHE_CAPABILITY], cacheId, taskId: association.taskId, sourceSetId: association.sourceSetId, sourceVersion: association.sourceVersion, documentId: source.scope.documentId, modelDocumentId: association.documentId, sourceBindings: source.files.map(file => ({ sourceId: file.sourceId, sourceRevision: file.revision, role: file.role })), entries: state.entries.map(entry => ({ ...entry, assetReferences: entry.assetReferences ?? [entry.assetId], parametersIdentity: sha(data.get(entry.assetId)!.bytes) })), assets: [...data].map(([assetId, item]) => ({ assetId, fileId: assetId, role: item.role, byteSize: item.bytes.byteLength })) };
 const begun = await bridge.request('postprocess-cache.begin', { requestId: crypto.randomUUID(), taskId: association.taskId, sourceSetId: association.sourceSetId, sourceVersion: association.sourceVersion, manifest, files: [...data].map(([fileId, item]) => ({ fileId, role: item.role, name: item.name, byteSize: item.bytes.byteLength })) });
 let completed = 0; const total = [...data.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
 try { for (const [fileId, item] of data) for (let offset = 0; offset < item.bytes.byteLength; offset += 1024 ** 2) { options.guard?.(); const bytes = item.bytes.subarray(offset, Math.min(item.bytes.byteLength, offset + 1024 ** 2)); const receipt = await bridge.request('postprocess-cache.append', { uploadId: begun.uploadId, fileId, offset, bytes }); if (receipt.written !== bytes.byteLength) throw Error('后处理缓存写入不完整。'); completed += bytes.byteLength; options.onProgress?.({ phase: '保存后处理缓存', completed, total }); } options.guard?.();options.onProgress?.({phase:'提交缓存',completed:0,total:0});return await bridge.request('postprocess-cache.commit', { uploadId: begun.uploadId }); }
 catch (error) { await bridge.request('postprocess-cache.abort', { uploadId: begun.uploadId }).catch(() => {}); throw error; }
}
export async function restoreTaskPostprocessCache(bridge: TaskSystemBridge, association: PostprocessTaskAssociation, source: ManagedPostprocessSourceSet, options: { uiStore?: ProjectUiStore; guard?(): void; onWarning?(message: string): void } = {}): Promise<{ restored: boolean; release(): Promise<void> }> {
 sameSource(association, source); const info = await bridge.request('postprocess-cache.describe', association); options.guard?.();
 if (info.state !== 'complete' || !info.manifest || !info.cacheId) return { restored: false, async release() {} };
 const manifest = info.manifest, cacheId = info.cacheId, { leaseId } = await bridge.request('postprocess-cache.retain', { taskId: association.taskId, cacheId }); let released = false;
 const release = async () => { if (!released) { await bridge.request('postprocess-cache.release', { leaseId }); released = true; } };
 const sourceIds = new Map<string, string>(); for (const old of manifest.sourceBindings ?? []) { const next = source.files.filter(file => file.revision === old.sourceRevision && file.role === old.role); if (next.length === 1) sourceIds.set(old.sourceId, next[0].sourceId); }
 const sourceRevisions=new Map((manifest.sourceBindings??[]).map(binding=>[binding.sourceId,binding.sourceRevision]));
 const documentId = (value: unknown) => value === manifest.documentId ? source.scope.documentId : value === manifest.modelDocumentId ? association.documentId : value;
 function keyMap(key: string) {
  const index = key.indexOf('['); if (index < 0) return key;
  try { const parts = JSON.parse(key.slice(index)) as unknown[]; if (!Array.isArray(parts)) return key;
   if (key.startsWith('controls:')) { if (typeof parts[0] === 'string' && sourceIds.has(parts[0])) parts[0] = sourceIds.get(parts[0]); parts[2] = documentId(parts[2]); }
   else if (['cube-source:', 'surface-family:', 'excitation-selection:', 'postprocess-plot-windows:', 'hirshfeld:', 'analysis-panel:'].some(prefix => key.startsWith(prefix))) { parts[0] = documentId(parts[0]); for (const offset of key.startsWith('cube-source:') || key.startsWith('surface-family:') || key.startsWith('excitation-selection:') ? [2] : key.startsWith('analysis-panel:') ? [3] : []) if (typeof parts[offset] === 'string' && sourceIds.has(parts[offset] as string)) parts[offset] = sourceIds.get(parts[offset] as string); }
   else return key; return key.slice(0, index) + JSON.stringify(parts);
  } catch { return key; }
 }
 /** Rebind only the documented SurfaceContext shape. Native observations and
  * arbitrary objects keep their original provenance even if names coincide. */
 function remap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [typeof key === 'string' ? keyMap(key) : remap(key), remap(item)]));
  if (value instanceof Set) return new Set([...value].map(remap)); if (Array.isArray(value)) return value.map(remap);
  const record = value as Record<string, unknown>, hasContext = typeof record.sourceId === 'string' && typeof record.sourceRevision === 'string' && typeof record.generation === 'number' && 'jobIndex' in record && 'sourceFrameIndex' in record;
  if(hasContext&&sourceIds.has(record.sourceId as string)&&record.sourceRevision!==sourceRevisions.get(record.sourceId as string))throw Error('缓存科学上下文不属于此来源版本。');
  if (hasContext && sourceIds.has(record.sourceId as string) && (record.documentId === manifest.documentId || record.documentId === manifest.modelDocumentId || record.documentId === undefined)) return { ...record, sourceId: sourceIds.get(record.sourceId as string), ...(record.documentId !== undefined ? { documentId: documentId(record.documentId) } : {}) };
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, remap(item)]));
 }
 function citation(value:unknown):unknown {if(!value||typeof value!=='object'||!('citationOwner'in value))return value;const saved=value as {citationOwner?:{documentId?:string;sourceId?:string;sourceRevision?:string;analysisId?:string};citationData?:unknown},owner=saved.citationOwner;if(!owner||owner.sourceId&&(!sourceIds.has(owner.sourceId)||owner.sourceRevision!==undefined&&owner.sourceRevision!==sourceRevisions.get(owner.sourceId)))return value;return{...saved,citationOwner:{...owner,...(owner.documentId?{documentId:documentId(owner.documentId)}:{}),...(owner.sourceId?{sourceId:sourceIds.get(owner.sourceId)}:{})}};}
 const reader = { async read(assetId: string) { if (released) throw Error('后处理缓存读取owner已释放。'); options.guard?.(); const asset = manifest.assets.find(item => item.assetId === assetId), original = source.files.find(file => file.revision === assetId); if (!asset && !original) throw Error('缓存依赖未登记。'); const size = asset?.byteSize ?? original!.byteSize, bytes = new Uint8Array(size); for (let offset = 0; offset < size; offset += 1024 ** 2) { const receipt = await bridge.request('postprocess-cache.read', { taskId: association.taskId, cacheId, leaseId, fileId: asset?.fileId ?? assetId, offset, length: Math.min(1024 ** 2, size - offset) }); options.guard?.(); if (receipt.offset !== offset || receipt.bytes.byteLength !== Math.min(1024 ** 2, size - offset)) throw Error('缓存读取回执无效。'); bytes.set(receipt.bytes, offset); } if (sha(bytes) !== assetId) throw Error('缓存依赖内容校验失败。'); return bytes; } };
 try {
  const entries: AnalysisProjectState['entries'] = [];
  for (const entry of manifest.entries) { if (entry.key.startsWith('task-ui:')) { if (options.uiStore) { try {
   const saved = JSON.parse(text.decode(await reader.read(entry.assetId))) as {documentId:string;values:Record<string, unknown>};
   const sourceIdentity=(value:unknown)=>{if(typeof value!=='string')return value;try{const tuple=JSON.parse(value) as unknown[];if(!Array.isArray(tuple)||tuple.length!==4||tuple[0]!==manifest.documentId||typeof tuple[1]!=='string'||!sourceIds.has(tuple[1]))return value;return JSON.stringify([source.scope.documentId,sourceIds.get(tuple[1]),tuple[2],tuple[3]]);}catch{return value;}};
   for (const [key, value] of Object.entries(saved.values)) { const parts = JSON.parse(key) as unknown[], documentIndex = parts.indexOf('document'); if (documentIndex < 0 || parts[documentIndex + 1] !== saved.documentId) continue; parts[documentIndex + 1] = association.documentId;const workspaceIndex=parts.indexOf('analysis-workspace');if(workspaceIndex>=0)parts[workspaceIndex+1]=sourceIdentity(parts[workspaceIndex+1]);const next=parts.at(-1)==='postprocess.activeSelection'&&value&&typeof value==='object'?{...value as Record<string,unknown>,source:sourceIdentity((value as Record<string,unknown>).source)}:value; options.uiStore.set(JSON.stringify(parts), next); }
  } catch (error) { options.onWarning?.(String(error)); } } continue; } entries.push({ ...entry, key: keyMap(entry.key) }); }
  await restoreAnalysisProjectState({ schema: 1, entries }, reader, { additive: true, scope: source.scope, transform: remap, transformCitation:citation, onInvalidEntry: (key, error) => options.onWarning?.(`${key}：${String(error)}`) }); options.guard?.(); return { restored: true, release };
 } catch (error) { await release(); throw error; }
}
