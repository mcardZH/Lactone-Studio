import { elementSymbol } from '../core/elements';
import type { Atom, Structure } from '../core/types';
import { assertResultNotAborted, ScientificDiagnosticError, UnsupportedResultKindError, type ResultDiagnostic, type ResultInputFile, type ResultReadOptions, type ScientificFileResults, type TrajectoryResult } from './contracts';
import { GaussianScientificParser } from './gaussian-scientific-parser';
import { OrcaScientificParser } from './orca-scientific-parser';
import { outputLines } from './optimization-reader';
import { emptyScientificDiagnostics, scientificAtom, type ScientificGeometry, type ScientificJob, type ScientificParser, type ScientificParserSnapshot } from './scientific-contracts';
import { abortableResultRead } from './xyz-reader';
import { outputSoftwareOnLine, recognizeResultSource } from './source-recognition';
import { attachTrajectoryStages } from './trajectory-stages';
import { createTrajectoryOperationBatch, traceTrajectoryOperation } from './trajectory-operations';
import { readResultSourceRange } from './source-range';
import {createScientificStructureMetadata} from './scientific-structure-metadata';

/** Decode one proven complete coordinate block. Shared by static results and
 * incremental monitoring; this performs no chemistry or bond inference. */
export function decodeScientificGeometry(bytes: Uint8Array, geometry: ScientificGeometry): Atom[] {
  const atoms: Atom[] = [];
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/), gaussian = geometry.format === 'gaussian-orientation';
    if (gaussian ? fields.length !== 6 || Number(fields[0]) !== atoms.length + 1 : fields.length !== 4) throw new Error('来源坐标格式与索引不一致。');
    let element: string;
    try { element = elementSymbol(gaussian ? fields[1] : fields[0]); } catch { throw new Error('来源坐标含不支持的原子或虚中心。'); }
    const atom = scientificAtom(element, gaussian ? fields.slice(3) : fields.slice(1), atoms.length);
    if (!atom || element !== geometry.elements[atoms.length]) throw new Error('来源坐标或原子顺序已改变。');
    atoms.push(atom);
  }
  if (atoms.length !== geometry.elements.length) throw new Error('来源原子数与结果索引不一致。');
  return atoms;
}

/** Streaming semantic index, with bounded lazy coordinate reads shared by both engines. */
export async function readScientificFileResults(file: ResultInputFile, options: ResultReadOptions = {}): Promise<ScientificFileResults> {
  return scientificFileResults(file, options);
}
/** Project an already parsed immutable index. The caller binds file to this
 * exact fixed source boundary; this path never reconsumes text or infers EOF. */
export async function readScientificSnapshotResults(file: ResultInputFile, snapshot: ScientificParserSnapshot, options: ResultReadOptions = {}): Promise<ScientificFileResults> {
  return scientificFileResults(file, options, snapshot);
}
async function scientificFileResults(file: ResultInputFile, options: ResultReadOptions, snapshot?: ScientificParserSnapshot): Promise<ScientificFileResults> {
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close?.(); } };
  const results: TrajectoryResult[] = [];
  const diagnostics: ResultDiagnostic[] = [];
  try {
    assertResultNotAborted(options.signal);
    let jobs: readonly ScientificJob[];
    if (snapshot) {
      if (!Number.isSafeInteger(snapshot.publishedByteEnd) || snapshot.publishedByteEnd < 0 || snapshot.publishedByteEnd > file.size) throw new Error('科学快照范围与固定来源不一致。');
      jobs = snapshot.jobs;
    } else {
    const identity = await recognizeResultSource(file, options);
    if (identity.status === 'conflict' || identity.format !== 'output' || !['gaussian', 'orca'].includes(identity.software)) {
      throw new UnsupportedResultKindError(identity.message ?? (identity.software === 'cp2k' ? '识别为CP2K输出；未作为Gaussian/ORCA解析。' : '输出前1 MiB没有可确认的 Gaussian/ORCA 身份。'));
    }
    const parser: ScientificParser = identity.software === 'gaussian' ? new GaussianScientificParser() : new OrcaScientificParser();
    let damagedTailLine:number|null=null, interruption: unknown;
    // Samples are consume calls, not frames. Keep original streaming order and
    // time only each synchronous parser segment, never the intervening reads.
    const indexTrace = createTrajectoryOperationBatch('parse', { sourceId: file.id, workPhase: 'semantic-index' });
    try {
      for await (const line of outputLines(file, options, sourceLine=>{damagedTailLine=sourceLine;})) {
        const software = outputSoftwareOnLine(line.text);
        if (software && software !== identity.software) throw new UnsupportedResultKindError('来源后续出现不同软件运行身份；未跨软件读取结果。');
        indexTrace.run(() => parser.consume(line));
      }
    } catch (error) { interruption = error; }
    finally { indexTrace.flush(); }
    jobs = createTrajectoryOperationBatch('parse', { sourceId: file.id, workPhase: 'semantic-index-finalize' }, 1)
      .run(() => parser.finish());
    if (interruption && jobs.length) {
      const message = options.signal?.aborted ? '读取已取消；保留此前完整有效结构与科学字段，未读取后续来源。' : `读取停止；保留此前完整有效数据：${interruption instanceof Error ? interruption.message : String(interruption)}`;
      const last = jobs.at(-1)!; if (last.status !== 'failed') last.status = 'incomplete';
      last.messages.push(message); last.data.notices.push(message);
    }
    if (interruption && !jobs.length) throw interruption;
    if(damagedTailLine!==null&&jobs.length){
      const message=`源行${damagedTailLine}含NUL损坏；已停止该行及后续读取，仅保留此前完整数据，未将后文终止/收敛标记用于本结果。`;
      const last=jobs.at(-1)!;if(last.status!=='failed')last.status='incomplete';
      last.messages.push(message);last.data.notices.push(message);
      // File integrity is shared provenance. Only the unfinished last job's
      // legacy status changes; earlier completed jobs retain their outcome.
      for (const job of jobs) (job.data.diagnostics ??= emptyScientificDiagnostics()).integrity = { status: 'damaged-tail', sourceLine: damagedTailLine, message };
    }
    }
    if (!jobs.length) throw new Error('已确认Gaussian/ORCA文件身份，但未取得可保存的作业诊断；未回退为普通结构。');
    let remaining = jobs.length;
    for (const indexedJob of jobs) {
      // Source metadata is a new spine; frozen scientific blocks remain shared.
      const job = { ...indexedJob, data: { ...indexedJob.data, source: { id: file.id, name: file.name }, diagnostics: indexedJob.data.diagnostics ?? emptyScientificDiagnostics() } };
      let disposed = false;
      const lifetime = new AbortController(), cache = new Map<number, Structure>();
      const id = `${file.id}:scientific:${job.jobIndex}:${job.segmentIndex}`;
      const dispose = async () => { if (disposed) return; disposed = true; lifetime.abort(); cache.clear(); if (--remaining === 0) await close(); };
      const label = `${file.name} · ${job.data.tasks.join(' / ').toUpperCase() || '结果'} · job ${job.jobIndex + 1}${job.segmentIndex ? ` / 段 ${job.segmentIndex + 1}` : ''}`;
      const unsupportedCenters = job.data.centers?.some(center => center.kind !== 'real')
        || job.frames.some(frame => frame.geometry.centers?.some(center => center.kind !== 'real'));
      if (!job.frames.length || unsupportedCenters) {
        const message = unsupportedCenters ? '来源含ghost、dummy或未确认身份的中心；保留原始中心与科学诊断，未转换为普通原子模型。' : '该作业没有完整普通原子结构；保留文件身份、输入与已打印科学信息。';
        diagnostics.push({ kind: 'diagnostic', id, label, engine: job.engine,
          sourceRole: 'output',
          source: { id: file.id, name: file.name, size: file.size, software: job.engine }, jobIndex: job.jobIndex, segmentIndex: job.segmentIndex,
          charge: job.charge, multiplicity: job.multiplicity, status: job.status,
          messages: [...job.messages, message], scientific: job.data,
          async readSourceRange(start, end, signal) {
            assertResultNotAborted(signal);
            if (disposed || closed) throw new Error('诊断来源已关闭。');
            const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
            const bytes = await abortableResultRead(file.readRange(start, end, combined), combined);
            if (bytes.length !== end - start) throw new Error('诊断来源长度发生变化。');
            return bytes;
          }, dispose });
        continue;
      }
      const applyMetadata=createScientificStructureMetadata({engine:job.engine,data:job.data,jobIndex:job.jobIndex,charge:job.charge,multiplicity:job.multiplicity,name:file.name,resultId:id});
      async function getFrame(index: number, signal?: AbortSignal): Promise<Structure> {
        assertResultNotAborted(signal);
        if (disposed || closed) throw new Error('结果文档已关闭。');
        if (!Number.isSafeInteger(index) || index < 0 || index >= job.frames.length) throw new Error('结果帧序号越界。');
        const found = cache.get(index);
        if (found) { cache.delete(index); cache.set(index, found); return structuredClone(found); }
        const geometry = job.frames[index].geometry;
        const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
        const traceContext = { sourceId: file.id, resultId: id, jobIndex: job.jobIndex, sourceFrameIndex: index };
        const read = () => readResultSourceRange(file, geometry.start, geometry.end, combined);
        const bytes = await abortableResultRead(file.readTrace === 'source-boundary' ? read()
          : traceTrajectoryOperation('read', traceContext, read), combined);
        assertResultNotAborted(combined);
        if (disposed || closed) throw new Error('结果文档已关闭。');
        if (bytes.length !== geometry.end - geometry.start) throw new Error('结果来源已截断，不能使用旧索引。');
        const structure = traceTrajectoryOperation('parse', { ...traceContext, workPhase: 'frame-parse' }, () => {
          const atoms = decodeScientificGeometry(bytes, geometry);
          const structure: Structure = { id: `${id}:frame:${index}`, name: `${file.name} · 帧 ${index + 1}`, format: `${job.engine} result`, atoms,
            charge: job.charge, multiplicity: job.multiplicity, dimension: 3, sourceRoute: job.data.route || undefined,
            notes: [`来源 ${file.name}，job ${job.jobIndex + 1}，源行 ${geometry.line}；只读结果，未执行新计算。`] };
          return applyMetadata(structure,index,geometry.line);
        });
        cache.set(index, structure);
        while (cache.size > 3) cache.delete(cache.keys().next().value!);
        return structuredClone(structure);
      }
      const initialStructure = await getFrame(0, options.signal?.aborted ? undefined : options.signal);
      const kind = job.data.tasks.some(task => ['opt', 'ts', 'irc', 'scan'].includes(task)) ? 'optimization' : 'calculation';
      results.push(attachTrajectoryStages({ id, label,
        kind, engine: job.engine, source: { id: file.id, name: file.name, size: file.size }, jobIndex: job.jobIndex,
        status: job.status, messages: job.messages, scientific: job.data,
        frames: job.frames.map(({ geometry: _geometry, ...frame }) => frame), initialStructure, getFrame,
        dispose }));
    }
    return { results, diagnostics };
  } catch (error) {
    await Promise.all(results.map(result => Promise.resolve(result.dispose())));
    await Promise.all(diagnostics.map(result => Promise.resolve(result.dispose())));
    await close(); throw error;
  }
}

/** Compatibility entry for geometry-dependent analysis. The general file reader
 * above is required when early failures or unsupported centers are possible. */
export async function readScientificResults(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  const read = await readScientificFileResults(file, options);
  if (!read.diagnostics.length) return read.results;
  try {
    await options.onDiagnostics?.(read.diagnostics);
    assertResultNotAborted(options.signal);
  } catch (error) {
    await Promise.all([...read.results, ...read.diagnostics].map(result => Promise.resolve(result.dispose())));
    throw error;
  }
  const snapshots = read.diagnostics.map(({ dispose: _dispose, readSourceRange: _readSourceRange, ...diagnostic }) => structuredClone(diagnostic));
  await Promise.all(read.diagnostics.map(result => Promise.resolve(result.dispose())));
  if (!read.results.length) throw new ScientificDiagnosticError(read.diagnostics);
  return read.results.map(result => ({ ...result, fileDiagnostics: snapshots,
    messages: [...result.messages, ...snapshots.map(item => `${item.jobIndex === null ? '未关联作业来源' : `同文件job ${item.jobIndex + 1}`}保留为文件级诊断：${item.messages.join('；')}`)] }));
}
