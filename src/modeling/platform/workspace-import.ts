import { importStructureFiles, reconcileGaussianSources, type StructureImportFile } from '../../core/file-import';
import type { Structure } from '../../core/types';
import type { ScientificSourceFile } from '../../results/input-file';
import { referencedXyz } from '../../core/orca-readers';
import type { DesktopBridge, FragmentSnapshot, OpenedModelFile } from '../contracts';
import { desktopFile, browserFile } from './import-model';
import { modelFragmentsFromStructures, parseModelFiles } from './files';

const gaussian = (name: string) => /\.(gjf|com|fch|fchk|out|log)$/i.test(name);
const streamed = (name: string) => /\.(fch|fchk|out|log)$/i.test(name);
const input = (name: string) => /\.(?:inp|restart)(?:-\d+)?$/i.test(name);
const normalized = (name: string) => name.replace(/\\/g, '/').replace(/^\.\//, '');
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('模型导入已取消。'); };
const cp2kMissing = /^CP2K依赖外部文件(.+)，请一起提供；不读取任意本机路径。$/;
export type RestoredWorkspaceModel = 'native' | 'sdf-metadata';

/** The existing SDF restorer is authoritative. Reject claimed empty/malformed
 * extension tags before it can interpret a record as ordinary connection data. */
function assertSdfMetadataTags(text: string) {
  const normalizedText = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const claimedRecords: boolean[] = [];
  for (const record of normalizedText.split(/^\$\$\$\$\s*$/m).filter(value => value.trim())) {
    const claimed = [...record.matchAll(/^\s*>[^\n]*SCIYUE_MODEL_METADATA_[^\n]*$/gim)];
    claimedRecords.push(claimed.length > 0);
    if (!claimed.length) continue;
    const supported = [...record.matchAll(/^>[^\n]*<SCIYUE_MODEL_METADATA_V1>[^\n]*\n([^\n]+)/gm)];
    if (claimed.length !== 1 || supported.length !== 1 || !supported[0][1].trim()) throw new Error('SDF建模元数据字段损坏、重复或版本未支持；不能退回普通解析。');
    // Semantic decoding belongs to parseModelFiles/restoreSdfMetadata only.
    // Keep this envelope guard: malformed claims must never become plain SDF.
  }
  return claimedRecords;
}

/** Returns fragments only: the registry creates a fresh document for every
 * result. It never constructs a temporary ModelStore or rewrites stable IDs.
 * Dependency components are imported together by the existing scientific core. */
export async function importWorkspaceSources(sources: ScientificSourceFile[] | OpenedModelFile[], bridge?: DesktopBridge, signal?: AbortSignal, restoredModels?: WeakMap<FragmentSnapshot, RestoredWorkspaceModel>): Promise<FragmentSnapshot[]> {
  const opened = Array.isArray(sources) ? (sources as OpenedModelFile[]).filter(file => typeof file?.streamToken === 'string') : [];
  try {
    aborted(signal);
    if (!Array.isArray(sources) || !sources.length) throw new Error('没有选择模型文件。');
    const isBrowser = (file: ScientificSourceFile | OpenedModelFile) => typeof file?.text === 'function' && typeof (file as ScientificSourceFile).size === 'number';
    const browser = sources.every(isBrowser), desktop = sources.every(file => !isBrowser(file) && Number.isSafeInteger((file as OpenedModelFile).bytes));
    if (!browser && !desktop) throw new Error('不能混合浏览器 File 与桌面来源；请重新完整选择。');
    const names = new Set<string>(), tokens = new Set<string>();
    const files: StructureImportFile[] = sources.map(source => {
      if (typeof source.name !== 'string' || !source.name || source.name.includes('\0')) throw new Error('模型文件名无效。');
      const key = normalized(source.name).toLowerCase();
      if (names.has(key)) throw new Error('来源文件名重复，不能唯一确定依赖：' + source.name);
      names.add(key);
      if (!browser) {
        const token = (source as OpenedModelFile).streamToken;
        if (token) { if (tokens.has(token)) throw new Error('桌面来源重复使用同一文件流 token。'); tokens.add(token); }
      }
      return browser ? browserFile(source as ScientificSourceFile, signal) : desktopFile(source as OpenedModelFile, bridge ?? {} as DesktopBridge, signal);
    });
    const textCache = new Map<number, string>();
    async function read(index: number): Promise<string> {
      aborted(signal);
      const file = files[index];
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('普通结构/依赖文件字节数无效：' + file.name);
      if (streamed(file.name)) throw new Error('输出流不能作为普通文本包含文件：' + file.name);
      if (!textCache.has(index)) {
        const text = await file.text(); aborted(signal);
        if (typeof text !== 'string' || text.includes('\0')) throw new Error('结构/依赖必须为可读UTF-8文本：' + file.name);
        textCache.set(index, text);
      }
      return textCache.get(index)!;
    }
    const coreFile = (index: number): StructureImportFile => ({ ...files[index], name: files[index].name, size: files[index].size, text: () => read(index), stream: () => files[index].stream() });
    // Validate rich SDF through the authoritative decoder before reading potentially
    // GiB-sized quantum streams. Reuse these exact fragments, not a second parse
    // with newly assigned identities or a lossy ordinary-structure fallback.
    const sdfFragments = new Map<number, FragmentSnapshot[]>();
    for (let index = 0; index < files.length; index++) if (/\.(sdf|sciyue)$/i.test(files[index].name)) {
      const text = await read(index);
      // A CP2K include or coordinate dependency may have an arbitrary extension.
      // Without a metadata claim, preserve dependency grouping before decoding.
      const native = /\.sciyue$/i.test(files[index].name), records = native ? [] : assertSdfMetadataTags(text);
      if (native || records.some(Boolean)) {
        const fragments = parseModelFiles([{ name: files[index].name, bytes: files[index].size, text }]);
        // Only a successful authoritative decode earns this ephemeral I/O
        // provenance. It is neither inferred from model contents nor persisted.
        fragments.forEach((fragment, record) => {
          if (native || records[record]) restoredModels?.set(fragment, native ? 'native' : 'sdf-metadata');
        });
        sdfFragments.set(index, fragments);
      }
    }
    const claimed = new Map<number, string>(), results: { index: number; fragments: FragmentSnapshot[] }[] = [];
    const claim = (indices: number[], main: string) => {
      for (const index of indices) {
        const previous = claimed.get(index);
        if (previous !== undefined) throw new Error(`来源 ${files[index].name} 被 ${previous} 与 ${main} 同时引用，依赖分组有歧义；请分别导入。`);
      }
      for (const index of indices) claimed.set(index, main);
    };
    const candidates: { index: number; text: string; cp2k: boolean }[] = [];
    for (let index = 0; index < files.length; index++) if (input(files[index].name)) {
      const text = await read(index);
      candidates.push({ index, text, cp2k: /^\s*&(?:SUBSYS|FORCE_EVAL)\b/im.test(text) });
    }
    // An explicitly referenced SUBSYS include is not a second document. Full
    // FORCE_EVAL roots run first; ownership is still proven by core references.
    const rootPriority = (candidate: typeof candidates[number]) => !candidate.cp2k ? 0 : /^\s*&FORCE_EVAL\b/im.test(candidate.text) ? 3 : /^\s*@INCLUDE\b/im.test(candidate.text) ? 2 : 1;
    candidates.sort((a, b) => rootPriority(b) - rootPriority(a) || a.index - b.index);
    for (const candidate of candidates) {
      if (claimed.has(candidate.index)) continue;
      const main = files[candidate.index], indices = [candidate.index];
      if (candidate.cp2k) {
        // Ask the existing CP2K parser for each unresolved explicit dependency.
        // Its own @SET/@INCLUDE/unit/section logic chooses paths; this adapter
        // neither reimplements preprocessing nor scans the local filesystem.
        for (let attempt = 0; ; attempt++) {
          aborted(signal);
          try {
            const structures = await importStructureFiles(indices.map(coreFile)); aborted(signal);
            claim(indices, main.name); results.push({ index: candidate.index, fragments: modelFragmentsFromStructures(structures) }); break;
          } catch (cause) {
            const missing = cause instanceof Error ? cause.message.match(cp2kMissing)?.[1] : undefined;
            if (!missing) throw cause;
            if (attempt >= files.length) throw new Error('CP2K依赖发现未能有界收束。');
            const matches = files.flatMap((file, index) => normalized(file.name) === normalized(missing) ? [index] : []);
            if (matches.length !== 1) throw new Error('请明确一起选择CP2K依赖，不能猜测路径：' + missing);
            const dependency = matches[0];
            if (indices.includes(dependency)) throw new Error('CP2K依赖重复/循环或路径不能由当前科学读取器证明：' + missing);
            if (claimed.has(dependency)) throw new Error('CP2K依赖被多个主文件引用，分组有歧义：' + missing);
            await read(dependency); indices.push(dependency);
          }
        }
      } else {
        for (const name of new Set(referencedXyz(candidate.text))) {
          const matches = files.flatMap((file, index) => index !== candidate.index && file.name.toLowerCase() === name.toLowerCase() ? [index] : []);
          if (matches.length !== 1) throw new Error('请将INP唯一引用的XYZ一起选择：' + name);
          if (claimed.has(matches[0])) throw new Error('INP依赖被多个主文件引用，分组有歧义：' + name);
          await read(matches[0]); indices.push(matches[0]);
        }
        const structures = await importStructureFiles(indices.map(coreFile)); aborted(signal);
        claim(indices, main.name); results.push({ index: candidate.index, fragments: modelFragmentsFromStructures(structures) });
      }
    }
    const gaussianIndices = files.flatMap((file, index) => !claimed.has(index) && gaussian(file.name) ? [index] : []);
    if (gaussianIndices.length) {
      const structures: Structure[] = [];
      for (const index of gaussianIndices) {
        if (/\.(gjf|com)$/i.test(files[index].name)) structures.push(...parseModelFiles([{ name: files[index].name, bytes: files[index].size, text: await read(index) }]).map(fragment => fragment.structure));
        else structures.push(...await importStructureFiles([coreFile(index)]));
        aborted(signal);
      }
      claim(gaussianIndices, 'Gaussian/量化来源组'); results.push({ index: gaussianIndices[0], fragments: modelFragmentsFromStructures(reconcileGaussianSources(structures)) });
    }
    for (let index = 0; index < files.length; index++) if (!claimed.has(index)) {
      const text = await read(index);
      // One independent source at a time retains all records and the native
      // SCIYUE SDF restore path; bad metadata is never caught/fallback-parsed.
      const fragments = sdfFragments.get(index) ?? parseModelFiles([{ name: files[index].name, bytes: files[index].size, text }]);
      if (!fragments.length) throw new Error('未能消费独立来源文件：' + files[index].name);
      claim([index], files[index].name); results.push({ index, fragments });
    }
    aborted(signal);
    if (claimed.size !== files.length) throw new Error('存在未消费的文件或依赖歧义。');
    return results.sort((a, b) => a.index - b.index).flatMap(result => result.fragments);
  } finally {
    if (bridge?.closeFileStream) await Promise.all([...new Set(opened.map(file => file.streamToken!))].map(token => bridge.closeFileStream!(token).catch(() => ({ closed: false }))));
  }
}
