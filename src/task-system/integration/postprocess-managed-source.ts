import { readPostprocessSourceBytes, type PostprocessAttachment, type PostprocessDocument } from '../../results/postprocess-document';
import { readGeneratedXtbSourcePackage } from '../../results/xtb-generated-source';
import { captureAnalysisOriginalSources, type AnalysisProjectScope } from '../../projects/analysis-state';
import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';
import type { ManagedSourceOrigin, ManagedSourceSetView, SourceSaveResult, TaskSystemBridge } from '../application-contracts';
import { captureProjectCompanionBundles, captureRawProjectCompanionCandidates, type ProjectCompanionFile } from '../../projects/companion-sources';
import { postprocessSourceExtras } from '../../projects/postprocess-extra-sources';

export interface ManagedPostprocessSourceFile { fileId: string; role: string; name: string; sourceId: string; revision: string; byteSize: number; required: boolean; representation?: 'text' | 'binary'; format?: string | null; sourceIdentity?: Record<string, unknown>; companionCandidate?: {kind:string;rawReadable:boolean;originVerified:boolean;unambiguous:boolean;scientificState:string;evidence:string[]}; readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> }
export interface ManagedPostprocessSourceSet { descriptor: ManagedSourceSetView; files: ManagedPostprocessSourceFile[]; scope: AnalysisProjectScope }
export interface PostprocessTaskAssociation extends SourceSaveResult { documentId: string; sourceIdentity: string }
const encoder = new TextEncoder();
const hash = (bytes: Uint8Array) => { const digest = new VibronicSha256(); digest.update(bytes); return digest.digest(); };
export function postprocessSourceIdentity(document: PostprocessDocument): string { return JSON.stringify([document.id, ...[document.output, document.wavefunction, ...document.companions ?? []].filter((row): row is PostprocessAttachment => Boolean(row)).map(row => [row.source.result.source.id, row.source.result.source.size, row.source.metadata?.sourceRevision, row.source.result.jobIndex])]); }
export async function captureManagedPostprocessSourceSet(input: { documentId: string; document: PostprocessDocument; sourceSetId?: string; origin?: ManagedSourceOrigin; guard?(): void; signal?: AbortSignal }): Promise<ManagedPostprocessSourceSet> {
 const guard = () => { if (input.signal?.aborted) throw new DOMException('已取消保存', 'AbortError'); input.guard?.(); };
 const attachments = [input.document.output, input.document.wavefunction, ...input.document.companions ?? []].filter((row): row is PostprocessAttachment => Boolean(row));
 const scope = { documentId: input.document.id, documentIds: [...new Set([input.document.id, input.documentId])], sourceIds: [...new Set([input.document.result.source.id, ...attachments.map(row => row.source.result.source.id)])] };
 const files: ManagedPostprocessSourceFile[] = [], seen = new Set<string>();
 async function add(name: string, role: string, sourceId: string, byteSize: number, readRange: ManagedPostprocessSourceFile['readRange'], expected?: string) {
  guard(); const digest = new VibronicSha256(); for (let start = 0; start < byteSize; start += 1024 ** 2) { const bytes = await readRange(start, Math.min(byteSize, start + 1024 ** 2), input.signal); guard(); digest.update(bytes); }
  const revision = digest.digest(); if (expected && revision !== expected) throw Error('原始来源内容与已展示结果版本不一致。'); const key = JSON.stringify([sourceId, revision, role]); if (seen.has(key)) return; seen.add(key);
  files.push({ fileId: 'source-' + files.length, role, name, sourceId, revision, byteSize, required: true, readRange });
 }
 for (const attachment of attachments) {
  const identity = attachment.source.result.source;
  if (attachment.source.generatedXtb) {
   const pkg = await readGeneratedXtbSourcePackage(attachment.source); guard();
   if (!pkg) throw Error('此历史GFN2来源缺少完整原始输出包；已有Molden和结果保留，不能冒完整来源归档。');
   for (const file of pkg.bundle.files) { const bytes = encoder.encode(file.text); await add(file.name, file.role === 'molden' ? 'wavefunction' : file.role === 'stdout' || file.role === 'stderr' ? 'diagnostic' : 'other', `xtb-${pkg.bundle.artifactId}:${file.role}`, bytes.byteLength, async (start, end) => bytes.slice(start, end), file.sha256); files.at(-1)!.format = file.role === 'molden' ? 'molden' : file.role === 'stdout' ? 'xtb-output' : file.role; }
   const { files: nativeFiles, ...metadata } = pkg.bundle;
   const bytes = encoder.encode(JSON.stringify({ schema: 'ester-gfn2-source-package/v1', metadata, expected: pkg.expected, analysisPolicy: pkg.analysisPolicy, files: nativeFiles.map(({ text: _text, ...file }) => file) }));
   await add('gfn2-provenance.json', 'other', `xtb-${pkg.bundle.artifactId}:provenance`, bytes.byteLength, async (start, end) => bytes.slice(start, end));
   files.at(-1)!.format = 'ester-gfn2-provenance';
  } else { const kind=attachment.source.kind,role=kind==='fchk'||kind==='molden'?'wavefunction':kind==='xyz'?'trajectory':kind==='hess'?'modes':kind==='gaussian-output'||kind==='orca-output'?'primary-output':'other';await add(identity.name,role,identity.id,identity.size,(start,end,signal)=>readPostprocessSourceBytes(attachment,start,end,signal),attachment.source.metadata?.sourceRevision); files.at(-1)!.format=kind; }
  const chunks = new Map<string, Uint8Array>();
  const writer = { async write(_category: string, _name: string, value: Uint8Array | string) { guard(); const bytes = typeof value === 'string' ? encoder.encode(value) : value.slice(), assetId = 'chunk-' + chunks.size; chunks.set(assetId, bytes); return { assetId }; } };
  const raw = await captureRawProjectCompanionCandidates(attachment, writer), bundles = await captureProjectCompanionBundles(attachment, writer); guard();
  const rawFiles = raw?.flatMap(bundle => bundle.files) ?? [];
  const rawByIdentity = new Map(rawFiles.map(file => [JSON.stringify([file.role,file.name,file.revision]),file]));
  const allFiles:(ProjectCompanionFile & {chunks:{assetId:string;bytes:number}[]})[]=[...rawFiles,...bundles?.flatMap(bundle=>bundle.files.filter(file=>file.role!=='output'))??[]];
  for (const file of allFiles) {
   const rawFile=rawByIdentity.get(JSON.stringify([file.role,file.name,file.revision]));
   await add(file.name, 'other', rawFile?.candidateId ?? `${identity.id}:${file.role}`, file.bytes, async (start, end) => { guard(); const bytes = new Uint8Array(end - start); let offset = 0; for (const chunk of file.chunks) { const next = offset + chunk.bytes; if (next > start && offset < end) { const value = chunks.get(chunk.assetId); if (!value || value.byteLength !== chunk.bytes) throw Error('配套原始来源分块不可用。'); const first = Math.max(start, offset), last = Math.min(end, next); bytes.set(value.subarray(first - offset, last - offset), first - start); } offset = next; } return bytes; }, file.revision);
   const saved = files.at(-1)!; saved.representation = file.role === 'orcaCis' ? 'binary' : 'text'; saved.format = file.role === 'orcaCis' ? 'cis' : 'orca-json';
   if (rawFile) { saved.sourceIdentity = structuredClone(rawFile.sourceIdentity); saved.companionCandidate = { ...rawFile.classification }; }
  }
 }
 for (const extra of postprocessSourceExtras(input.document)) { await add(extra.name,'other',extra.sourceId,extra.byteSize,extra.readRange,extra.revision);files.at(-1)!.format=extra.format; }
 for (const { source } of await captureAnalysisOriginalSources(scope)) { const bytes = source.originalBytes; await add(source.name, 'other', source.sourceRevision, bytes.byteLength, async (start, end) => bytes.slice(start, end), source.sourceRevision); files.at(-1)!.format='cube'; }
 guard(); if (!files.length) throw Error('当前页没有可取得的原始来源。');
 const sourceVersion = hash(encoder.encode(JSON.stringify(files.map(({ name, role, revision, byteSize }) => [name, role, revision, byteSize]))));
 const sourceSetId = input.sourceSetId ?? 'sources-' + hash(encoder.encode(JSON.stringify([input.documentId, scope.sourceIds]))).slice(0, 32);
 const descriptor: ManagedSourceSetView = { sourceSetId, sourceVersion, documentId: input.document.id, origin: input.origin ?? { kind: input.document.wavefunction?.source.generatedXtb ? 'xtb-generated' : 'postprocess' }, files: files.map(({ readRange: _read, ...file }) => ({ ...file, category: 'source' as const })) };
 const result=input.document.result,last=result.frames.at(-1),primary=input.document.output??input.document.wavefunction;
 if(last&&primary){const structure=await result.getFrame(last.index);guard();const ownerFile=files.find(file=>file.sourceId===result.source.id)??files.find(file=>file.sourceId===primary.source.result.source.id);
  if(ownerFile&&structure.atoms.length){const generated=input.document.wavefunction?.source.generatedXtb,method=result.scientific?.summary.find(field=>field.key==='method'&&typeof field.value==='string')?.value;
   const tasks=primary.source.tasks,taskKind=tasks.includes('opt')&&tasks.includes('freq')?'optfreq':tasks[0]??'unknown';
   descriptor.summary={schema:1,sourceSetId,sourceVersion,sourceSha256:ownerFile.revision,sourceId:ownerFile.sourceId,engineId:generated?'xtb':primary.source.software&&primary.source.software!=='unknown'?primary.source.software:result.engine==='structure'?'unknown':result.engine,taskKind,frameIndex:last.index,sourceFrameIndex:last.sourceFrameIndex??null,structure,energy:last.energy?{...last.energy}:null,...(generated?{method:'GFN2-xTB',capabilities:[...generated.capabilities]}:typeof method==='string'?{method}:{})};
  }
 }
 return { descriptor, files, scope };
}
export async function saveManagedPostprocessSourceSet(bridge: TaskSystemBridge, source: ManagedPostprocessSourceSet, input: { displayName: string; taskId?: string; groupIds?: string[]; archiveRootOverride?: string; guard?(): void; onProgress?(value: { phase: string; completed: number; total: number }): void }): Promise<SourceSaveResult> {
 input.guard?.(); const request = await bridge.request('source-save.begin', { requestId: crypto.randomUUID(), displayName: input.displayName, taskId: input.taskId, groupIds: input.groupIds ?? [], archiveRootOverride: input.archiveRootOverride, sourceSet: source.descriptor });
 const total = source.files.reduce((sum, file) => sum + file.byteSize, 0); let completed = 0;
 try { for (const file of source.files) for (let offset = 0; offset < file.byteSize; offset += 1024 ** 2) { input.guard?.(); const bytes = await file.readRange(offset, Math.min(file.byteSize, offset + 1024 ** 2)); input.guard?.(); const receipt = await bridge.request('source-save.append', { uploadId: request.uploadId, fileId: file.fileId, offset, bytes }); if (receipt.written !== bytes.byteLength) throw Error('来源归档写入不完整。'); completed += bytes.byteLength; input.onProgress?.({ phase: '归档源文件', completed, total }); } input.guard?.(); input.onProgress?.({phase:'登记任务',completed:0,total:0});return await bridge.request('source-save.commit', { uploadId: request.uploadId }); }
 catch (error) { await bridge.request('source-save.abort', { uploadId: request.uploadId }).catch(() => {}); throw error; }
}
