import type { FragmentSnapshot } from '../modeling/contracts';
import { importWorkspaceSources, type RestoredWorkspaceModel } from '../modeling/platform/workspace-import';
import { modelFragmentsFromStructures } from '../modeling/platform/files';
import { assertResultNotAborted, UnsupportedResultKindError, type ResultDiagnostic, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { readOrcaInputCenters, referencedXyz } from '../core/orca-readers';
import { resultFile, type ScientificSourceFile } from './input-file';
import { abortableResultRead, readXyzTrajectory } from './xyz-reader';
import { readStructureCollection } from './collection-reader';
import { readScientificFileResults } from './scientific-reader';
import { readFchkScientificResult } from './fchk-scientific-reader';
import { readHessScientificResult } from './hess-scientific-reader';
import { recognizeResultSource } from './source-recognition';
import { bindTrajectoryCompanions } from './trajectory-companions';
import { emptyScientificData, emptyScientificDiagnostics } from './scientific-contracts';
import { readNebAuxiliary, type NebAuxiliarySource } from './neb-auxiliary-reader';
import { readNebOutputContext, type NebOutputContext } from './neb-companion-association';
import { readMdAuxiliary, type MdAuxiliarySource } from './md-aux-reader';
import { readIrcOutputContext, type IrcOutputContext } from './irc-companion-association';

export type WorkspaceImportItem = { kind: 'model'; fragment: FragmentSnapshot; restoredModel?: RestoredWorkspaceModel } | { kind: 'result'; result: TrajectoryResult } | { kind: 'diagnostic'; diagnostic: ResultDiagnostic };
/** Route complete result files without stealing explicitly paired input dependencies. */
export async function importWorkspaceItems(files: ScientificSourceFile[], options: ResultReadOptions & { onSourceError?(file: ScientificSourceFile, error: unknown): void } = {}): Promise<WorkspaceImportItem[]> {
  const items: WorkspaceImportItem[] = [], fallback: ScientificSourceFile[] = [];
  const protectedFiles = new Set<ScientificSourceFile>(), xyzDependencyNames = new Set<string>();
  const fallbackNotes = new Map<ScientificSourceFile,string>();
  const diagnosticInputs = new Set<ScientificSourceFile>();
  const nebAuxiliaries: NebAuxiliarySource[] = [], nebContexts: NebOutputContext[] = [];
  const mdAuxiliaries: MdAuxiliarySource[] = [];
  const ircContexts: IrcOutputContext[] = [];
  let retainedAuxiliaryBytes = 0;
  const sourceFailures: unknown[] = [];
  const failedFiles = new Set<ScientificSourceFile>();
  const failed = (file: ScientificSourceFile, error: unknown) => {
    assertResultNotAborted(options.signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    failedFiles.add(file); sourceFailures.push(error); options.onSourceError?.(file, error);
  };
  try {
  // Input+dependencies retain the existing scientific dependency grouping.
  const inputs = files.filter(file => /\.(?:inp|restart)(?:-\d+)?$/i.test(file.name));
  for (const file of inputs) {
    try {
    const preview = resultFile(file);
    try { if ((await recognizeResultSource(preview, options)).format !== 'unknown') continue; }
    finally { await preview.close?.(); }
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('输入文件字节数无效。');
    const text = await file.text(); assertResultNotAborted(options.signal);
    const centerJobs = readOrcaInputCenters(text);
    if (centerJobs.length) {
      diagnosticInputs.add(file);
      const source = resultFile(file); let remaining = centerJobs.length;
      for (const job of centerJobs) {
        let disposed = false; const lifetime = new AbortController();
        const scientific = emptyScientificData(); scientific.source = { id: source.id, name: source.name };
        scientific.route = job.rawInput; scientific.printedRoute = job.rawInput; scientific.centers = job.centers;
        scientific.diagnostics = emptyScientificDiagnostics();
        scientific.diagnostics.fields.push({ field: 'ordinary-geometry', status: 'unsupported', sourceLine: job.sourceLine, message: '输入含特殊中心，保留输入证据；未作为普通原子模型。' });
        if (job.charge !== null) scientific.summary.push({ key: 'input-charge', label: '输入请求电荷', value: job.charge, sourceLine: job.sourceLine, origin: 'input-request' });
        if (job.multiplicity !== null) scientific.summary.push({ key: 'input-multiplicity', label: '输入请求多重度', value: job.multiplicity, sourceLine: job.sourceLine, origin: 'input-request' });
        items.push({ kind: 'diagnostic', diagnostic: {
          kind: 'diagnostic', id: `${source.id}:input:${job.jobIndex}`, label: `${file.name} · 输入 · job ${job.jobIndex + 1}`,
          engine: 'orca', sourceRole: 'input', source: { id: source.id, name: source.name, size: source.size, software: 'orca' },
          jobIndex: job.jobIndex, segmentIndex: 0, charge: job.charge, multiplicity: job.multiplicity,
          status: 'unknown', messages: ['只读ORCA输入证据，未运行计算；文件含ghost或dummy中心，未转换为普通原子模型。'], scientific,
          async readSourceRange(start, end, signal) {
            assertResultNotAborted(signal); if (disposed) throw new Error('输入诊断来源已关闭。');
            const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
            const bytes = await abortableResultRead(source.readRange(start, end, combined), combined);
            if (bytes.length !== end - start) throw new Error('输入诊断来源长度发生变化。'); return bytes;
          },
          async dispose() { if (disposed) return; disposed = true; lifetime.abort(); if (--remaining === 0) await source.close?.(); },
        } });
      }
      continue;
    }
    protectedFiles.add(file);
    for (const name of referencedXyz(text)) xyzDependencyNames.add(name.toLowerCase());
    // CP2K includes may themselves reference coordinates: let its existing
    // parser resolve the whole selected dependency set without competing reads.
    if (/^\s*&(?:SUBSYS|FORCE_EVAL)\b/im.test(text)) for (const other of files) protectedFiles.add(other);
    } catch (error) { failed(file, error); }
  }
    for (const file of files) if (xyzDependencyNames.has(file.name.toLowerCase())) protectedFiles.add(file);
    for (const file of files) {
      if (failedFiles.has(file)) continue;
      try {
      if (options.signal?.aborted && items.length) return items;
      assertResultNotAborted(options.signal);
      if (diagnosticInputs.has(file)) continue;
      if (protectedFiles.has(file)) { fallback.push(file); continue; }
      const source = resultFile(file);
      let identity;
      try { identity = await recognizeResultSource(source, options); }
      catch (cause) { await source.close?.(); throw cause; }
      // A SANdy module log is a distinct source role, not an ordinary ORCA OUT.
      let mdAuxiliary;
      try { mdAuxiliary = await readMdAuxiliary(source, options); }
      catch (cause) { await source.close?.(); throw cause; }
      if (mdAuxiliary) { retainedAuxiliaryBytes += mdAuxiliary.retainedBytes; mdAuxiliaries.push(mdAuxiliary); items.push({ kind: 'diagnostic', diagnostic: mdAuxiliary.diagnostic }); if(options.signal?.aborted)return items; continue; }
      if (identity.format === 'unknown') {
        let auxiliary;
        try { auxiliary = await readNebAuxiliary(source, options); }
        catch (cause) { await source.close?.(); throw cause; }
        if (auxiliary) { retainedAuxiliaryBytes += auxiliary.retainedBytes; nebAuxiliaries.push(auxiliary); items.push({ kind: 'diagnostic', diagnostic: auxiliary.diagnostic }); if(options.signal?.aborted)return items; continue; }
      }
      if (identity.status === 'conflict' || identity.software === 'cp2k' && identity.format === 'output') {
        await source.close?.();
        throw new Error(identity.message ?? '识别为CP2K来源；本轮未提供CP2K结果解析。');
      }
      const isXyz = identity.format === 'xyz', isOutput = identity.format === 'output';
      const isFchk = identity.format === 'fchk';
      const isHess = identity.format === 'hess';
      const isCollection = /\.(sdf|pdb|cif)$/i.test(file.name);
      if (!isXyz && !isOutput && !isFchk && !isHess && !isCollection) { await source.close?.(); fallback.push(file); continue; }
      // Rich native SDF remains on the existing lossless fragment-restorer path.
      if (isCollection && /\.sdf$/i.test(file.name) && /SCIYUE_MODEL_METADATA_/.test(await file.text())) { await source.close?.(); fallback.push(file); continue; }
      let results: TrajectoryResult[];
      try {
        if (isOutput) {
          const read = await readScientificFileResults(source, options);
          const imported = [
            ...read.results.map(result => ({ kind: 'result' as const, result })),
            ...read.diagnostics.map(diagnostic => ({ kind: 'diagnostic' as const, diagnostic })),
          ].sort((a, b) => { const left = a.kind === 'result' ? a.result.jobIndex : a.diagnostic.jobIndex, right = b.kind === 'result' ? b.result.jobIndex : b.diagnostic.jobIndex; return left === null || right === null ? 0 : left - right; });
          items.push(...imported);
          if (options.signal?.aborted) return items;
          try {
          const neb = [...read.results, ...read.diagnostics].filter(result => result.engine === 'orca' && result.scientific?.tasks.includes('neb'));
          if (neb.length === 1) { const context = await readNebOutputContext(source, neb[0], options); if (context) nebContexts.push(context); }
          for (const job of [...read.results, ...read.diagnostics]) { const context = await readIrcOutputContext(source, job, options); if (context) ircContexts.push(context); }
          } catch (error) { failed(file, error); }
          assertResultNotAborted(options.signal);
          continue;
        } else results = await (isXyz ? readXyzTrajectory(source,options) : isFchk ? readFchkScientificResult(source,options) : isHess ? readHessScientificResult(source,options) : readStructureCollection(source,options));
      }
      catch (cause) { await source.close?.(); if (cause instanceof UnsupportedResultKindError) { fallback.push(file); fallbackNotes.set(file,`以已有结构入口打开；该文件尚未取得完整结果能力。${cause.message}`); continue; } throw cause; }
      if (!results.length) { await source.close?.(); fallback.push(file); continue; }
      if (options.signal?.aborted) { items.push(...results.map(result => ({ kind: 'result' as const, result }))); return items; }
      if (!isOutput && !isFchk && !isHess && results.length === 1 && results[0].frames.length === 1 && results[0].status !== 'failed' && results[0].status !== 'incomplete') {
        try { items.push(...modelFragmentsFromStructures([await results[0].getFrame(0,options.signal)]).map(fragment => ({kind:'model' as const,fragment}))); }
        finally { await results[0].dispose(); }
      } else items.push(...results.map(result => ({kind:'result' as const,result})));
      } catch (error) { failed(file, error); }
    }
    // A declared auxiliary with an unrecognisable damaged header is still a
    // source diagnostic. The declaration proves a role, not a producer or job.
    const mdReferences = items.flatMap(item => item.kind === 'result' ? item.result.scientific?.relatedFiles ?? [] : item.kind === 'diagnostic' && item.diagnostic.sourceRole === 'output' ? item.diagnostic.scientific.relatedFiles ?? [] : []).filter(ref => ref.role === 'md-log' || ref.role === 'md-statistics');
    for (let index = fallback.length - 1; index >= 0; index--) {
      const file = fallback[index], roles = new Set(mdReferences.filter(ref => ref.name.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase() === file.name.toLowerCase()).map(ref => ref.role));
      if (roles.size !== 1) continue;
      const source = resultFile(file), role = [...roles][0] === 'md-log' ? 'log' : 'statistics';
      let auxiliary;
      try { auxiliary = await readMdAuxiliary(source, options, undefined, role); }
      catch (cause) { await source.close?.(); fallback.splice(index, 1); failed(file, cause); continue; }
      if (auxiliary) { fallback.splice(index, 1); retainedAuxiliaryBytes += auxiliary.retainedBytes; mdAuxiliaries.push(auxiliary); items.push({ kind: 'diagnostic', diagnostic: auxiliary.diagnostic }); }
    }
    if (fallback.length) {
      const restoredModels = new WeakMap<FragmentSnapshot, RestoredWorkspaceModel>();
      const dependencies = fallback.filter(file => protectedFiles.has(file));
      const groups = [...(dependencies.length ? [dependencies] : []), ...fallback.filter(file => !protectedFiles.has(file)).map(file => [file])];
      for (const group of groups) {
        try {
          const note = group.length === 1 ? fallbackNotes.get(group[0]) : undefined;
          items.push(...(await importWorkspaceSources(group,undefined,options.signal,restoredModels,{onSourceError(file,error){failed(file as ScientificSourceFile,error);}})).map(fragment=>{if(note)fragment.structure.notes.push(note);const restoredModel=restoredModels.get(fragment);return {kind:'model' as const,fragment,...(restoredModel?{restoredModel}:{})};}));
        } catch (error) { failed(group[0], error); }
      }
    }
    if (!items.length && sourceFailures.length) throw new AggregateError(sourceFailures, sourceFailures.map(error => error instanceof Error ? error.message : String(error)).join('；'));
    const grouped = await bindTrajectoryCompanions(items.flatMap(item => item.kind === 'result' ? [item.result] : []), options.signal, { contexts: nebContexts, auxiliaries: nebAuxiliaries }, { auxiliaries: mdAuxiliaries }, { contexts: ircContexts }, { onPairingError(source, error) {
      const file = files.find(file => file.name === source.source.name);
      if (file) options.onSourceError?.(file, error);
    } });
    let resultIndex = 0;
    for (let index = 0; index < items.length; index++) if (items[index].kind === 'result') items[index] = { kind: 'result', result: grouped[resultIndex++] };
    assertResultNotAborted(options.signal); return items;
  } catch (cause) {
    await Promise.all(items.flatMap(item=>item.kind==='result'?[Promise.resolve(item.result.dispose())]:item.kind==='diagnostic'?[Promise.resolve(item.diagnostic.dispose())]:[])); throw cause;
  }
}
