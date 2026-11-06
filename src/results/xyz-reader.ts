import { parseStructures } from '../core/parsers';
import type { Structure } from '../core/types';
import { assertResultNotAborted, type ResultFileRole, type ResultFrameSummary, type ResultInputFile, type ResultQuantity, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { attachTrajectoryStages } from './trajectory-stages';
import { traceTrajectoryOperation } from './trajectory-operations';
import { emptyScientificData, scientificRoundingInterval, type MdStepObservation } from './scientific-contracts';
import { readResultSourceRange } from './source-range';

const CACHE_FRAMES = 8;
const CACHE_ATOMS = 100000;
/** Validate representable counters; file size never limits a complete scientific index. */
export function xyzIndexLimitMessage(frames: number, segments: number, initialAtoms: number, nextInitialAtoms: number): string | null {
  if (![frames, segments, initialAtoms, nextInitialAtoms, initialAtoms + nextInitialAtoms].every(value => Number.isSafeInteger(value) && value >= 0)) return '索引计数无效';
  return null;
}
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eEdD][+-]?\\d+)?';
interface FrameIndex { start: number; end: number; line: number; summary: ResultFrameSummary }
interface Segment { frames: FrameIndex[]; initial: Structure; identity: string; status: TrajectoryResult['status']; messages: string[]; role?: ResultFileRole; nativeOrca: boolean; nativeJobName?: string; firstNativeImage?: number; displayImage: number; mdSteps: MdStepObservation[] }

/** Native producer grammar establishes numeric observations and saved-point meaning.
 * A bare ORCA E column still needs independently established unit evidence. */
export function orcaXyzComment(comment: string): Partial<ResultFrameSummary> & { role?: ResultFileRole; nativeJobName?: string } {
  const match = comment.match(new RegExp(`^\\s*Coordinates from ORCA-job\\s+(\\S+)(?:\\s+(?:Relaxed Surface Scan Step\\s+(\\d+)|NEB Path Image\\s+(\\d+)))?\\s+E\\s+(${NUMBER})(?:\\s+(Eh|Ha|Hartree))?\\s*$`, 'i'));
  if (!match) return {};
  const value = Number(match[4].replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) return {};
  const node = match[2] === undefined ? undefined : Number(match[2]);
  const image = match[3] === undefined ? undefined : Number(match[3]);
  if (image !== undefined && !Number.isSafeInteger(image)) return {};
  return { nativeJobName: match[1], ...(match[5] && image === undefined ? { energy: { value, unit: 'Eh' } } : { unqualifiedEnergy: value }),
    energyObservations: [{ kind: 'xyz-comment', value, rawValue: match[4], raw: comment, ...(match[5] ? { unit: 'hartree' } : {}), source: { id: '', name: '', line: 0 }, association: 'unresolved', origin: 'observation' }],
    // Native ORCA image numbering varies by source; only the indexed path order
    // establishes its one-based presentation ordinal.
    ...(image === undefined ? {} : { pathImage: image, role: 'neb-path', stageId: 'neb-path' }),
    ...(node !== undefined && Number.isSafeInteger(node) ? { pathNode: node, sourceStep: node, pathPoint: true, role: 'scan-point-set', label: `Scan node ${node}` } : {}) };
}
/** Literal native AIMD source fields, not a trajectory inferred from its name. */
export function orcaMdXyzComment(comment: string): Partial<ResultFrameSummary> & { role?: ResultFileRole; mdStep?: MdStepObservation } {
  if (!/^\s*#\s*ORCA AIMD Position Step\b/.test(comment)) return {};
  const match = comment.match(new RegExp(`^\\s*#\\s*ORCA AIMD Position Step (\\d+), t=(${NUMBER}) (fs|ps), E_Pot=(${NUMBER}) (kJ mol\\^-1), Unit is Angstrom\\s*$`));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('ORCA AIMD注释的步/时间/能量/坐标单位未确认；未按普通XYZ忽略声明。');
  const sourceStep = Number(match[1]), time = Number(match[2].replace(/[dD]/, 'e')), energy = Number(match[4].replace(/[dD]/, 'e'));
  if (![time, energy].every(Number.isFinite)) throw new Error('ORCA AIMD观测不是有限数。');
  return { role: 'md-trajectory', sourceStep, time: { value: time, unit: match[3] }, energy: { value: energy, unit: 'kJ/mol' }, energyQuantity: 'potential',
    energyObservations: [{ kind: 'xyz-comment', quantity: 'potential', value: energy, rawValue: match[4], unit: 'kJ/mol', rawUnit: match[5], raw: comment, source: { id: '', name: '', line: 0 }, origin: 'observation' }],
    mdStep: { sourceStep, rawStep: match[1], sourceLine: 0, jobIndex: null, frameIndex: null, stageId: 'md', time: { value: time, rawValue: match[2], unit: match[3], rawUnit: match[3], sourceLine: 0 }, potentialEnergy: { value: energy, rawValue: match[4], unit: 'kJ/mol', rawUnit: match[5], sourceLine: 0 } },
  };
}

/** Shared by result readers: cancellation also works with a slow provider. */
export async function abortableResultRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertResultNotAborted(signal);
  if (!signal) return promise;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('读取已取消。', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Byte-oriented line boundaries keep offsets exact even across multibyte UTF-8 chunks. */
async function* lines(file: ResultInputFile, options: ResultReadOptions): AsyncGenerator<{ text: string; start: number; end: number; line: number }> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [], length = 0, offset = 0, start = 0, line = 1, skipLf = false, complete = false;
  const decode = (tail?: Uint8Array) => {
    const bytes = new Uint8Array(length + (tail?.length ?? 0));
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    if (tail) bytes.set(tail, at);
    parts = []; length = 0;
    return decoder.decode(bytes);
  };
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const next = await abortableResultRead(reader.read(), options.signal);
      assertResultNotAborted(options.signal);
      if (next.done) { complete = true; break; }
      const bytes = next.value;
      let from = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (skipLf) {
          skipLf = false;
          if (bytes[i] === 10) { from = i + 1; start = offset + i + 1; continue; }
        }
        if (bytes[i] !== 10 && bytes[i] !== 13) continue;
        const text = decode(bytes.subarray(from, i));
        const end = offset + i + 1;
        yield { text, start, end, line: line++ };
        start = end; from = i + 1; skipLf = bytes[i] === 13;
      }
      if (from < bytes.length) {
        // Copy only the unfinished line; do not retain a large backing chunk.
        const part = bytes.slice(from); parts.push(part); length += part.length;
      }
      offset += bytes.length;
      options.onProgress?.(offset, file.size);
    }
    if (length) yield { text: decode(), start, end: offset, line };
    if (offset !== file.size) throw new Error('XYZ来源读取长度发生变化。');
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function attributes(comment: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const m of comment.matchAll(/([A-Za-z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g)) values[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  return values;
}
function quantity(comment: string, key: 'time' | 'energy'): ResultQuantity | null {
  const attrs = attributes(comment);
  const units = key === 'time' ? '(?:fs|ps|ns|us|ms|s)' : '(?:eV|meV|Eh|Ha|Hartree|kJ/mol|kcal/mol)';
  const inline = comment.match(new RegExp(`\\b${key}\\s*(?:\\[(${units})\\]|\\((${units})\\))?\\s*[=:]\\s*["']?(${NUMBER})\\s*(${units})?(?=[\\s,;"']|$)`, 'i'));
  if (!inline) return null;
  const declared = attrs[`${key}_unit`] ?? attrs[`${key}_units`];
  const unit = inline[1] ?? inline[2] ?? inline[4] ?? declared;
  if (!unit || !new RegExp(`^${units}$`, 'i').test(unit)) return null;
  // SI prefixes are case-sensitive: MeV must never become milli-electronvolt.
  // Retain the project's explicit lowercase compatibility spelling only.
  if ([unit, declared].some(value => value && /^mev$/i.test(value) && value !== 'meV' && value !== 'mev')) return null;
  if (declared && unit.toLowerCase() !== declared.toLowerCase()) return null;
  const value = Number(inline[3].replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) return null;
  const canonical: Record<string, string> = { ev: 'eV', mev: 'meV', eh: 'Eh', ha: 'Eh', hartree: 'Eh', 'kj/mol': 'kJ/mol', 'kcal/mol': 'kcal/mol' };
  return { value, unit: canonical[unit.toLowerCase()] ?? unit.toLowerCase() };
}
function parsedFrame(text: string, name: string, id: string): Structure {
  const structures = parseStructures(text, `${name.replace(/\.[^.]*$/, '')}.xyz`);
  if (structures.length !== 1) throw new Error('XYZ帧索引对应的结构数量不是1。');
  const structure = structures[0]; structure.id = id; structure.name = name;
  // The original extended parser accepts multiplicity, while ordinary XYZ also accepts mult.
  const attrs = attributes(text.replace(/\r\n?/g, '\n').split('\n')[1] ?? '');
  if (attrs.mult !== undefined && structure.multiplicity === null) {
    const mult = Number(attrs.mult);
    if (!/^\+?\d+$/.test(attrs.mult) || !Number.isSafeInteger(mult) || mult < 1) throw new Error('XYZ多重度元数据无效。');
    structure.multiplicity = mult;
  }
  return structure;
}
function frameIdentity(structure: Structure, comment: string): string {
  const attrs = attributes(comment);
  return JSON.stringify([structure.atoms.map(a => a.element), structure.charge, structure.multiplicity,
    attrs.state ?? attrs.electronic_state ?? null, attrs.mode ?? null, attrs.properties ?? null,
    structure.cell?.pbc ?? null, structure.atoms.map(a => a.id ?? null)]);
}

/** Index once, retain only summaries/byte ranges and a bounded source-wide frame cache. */
export async function readXyzTrajectory(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  const segments: Segment[] = [];
  let rows: string[] = [], atomCount = -1, frameStart = 0, frameLine = 0, frameEnd = 0, globalIndex = 0, initialAtoms = 0;
  let closed = false, closePromise: Promise<void> | undefined;
  const close = () => {
    if (!closed) { closed = true; closePromise = Promise.resolve().then(() => file.close?.()).then(() => undefined); }
    return closePromise!;
  };
  try {
    try {
      for await (const line of lines(file, options)) {
        assertResultNotAborted(options.signal);
        if (!rows.length) {
          if (!line.text.trim() || line.text.trim() === '>') continue;
          if (!/^\d+$/.test(line.text.trim())) throw new Error(`XYZ第${line.line}行应为原子数。`);
          atomCount = Number(line.text);
          if (!Number.isSafeInteger(atomCount) || atomCount < 1) throw new Error(`XYZ第${line.line}行原子数须为正安全整数。`);
          frameStart = line.start; frameLine = line.line;
        }
        rows.push(line.text); frameEnd = line.end;
        if (rows.length !== atomCount + 2) continue;
        // Segment/job identity is not known before this actual indexing parse.
        const structure = traceTrajectoryOperation('parse', { sourceId: file.id, workPhase: 'xyz-index-frame' },
          () => parsedFrame(rows.join('\n'), file.name, `${file.id}:xyz:frame:${globalIndex}`));
        const comment = rows[1], native = { ...orcaXyzComment(comment), ...orcaMdXyzComment(comment) }, identity = frameIdentity(structure, comment);
        const nativeRounding = rows.slice(2).every(row => row.trim().split(/\s+/).length === 4)
          ? rows.slice(2).flatMap(row => row.trim().split(/\s+/).slice(1).map(scientificRoundingInterval)) : [];
        const coordinateRounding = nativeRounding.length && nativeRounding.every(value => value !== undefined && Number.isFinite(value)) ? (nativeRounding as number[]).reduce((largest,value)=>Math.max(largest,value),0) : undefined;
        let segment = segments.at(-1);
        const nativeOrca = native.unqualifiedEnergy !== undefined || native.energy !== undefined;
        const newSegment = !segment || segment.identity !== identity || segment.role !== native.role || segment.nativeOrca !== nativeOrca || segment.nativeJobName !== native.nativeJobName;
        const limit = xyzIndexLimitMessage(globalIndex, segments.length, initialAtoms, newSegment ? structure.atoms.length : 0);
        if (limit) {
          if (!segment) throw new Error(`XYZ首帧超过资源门：${limit}；请拆分来源。`);
          segment.status = 'incomplete';
          segment.messages.push(`已达到${limit}；文件未读完，仅保留此前${globalIndex}个完整帧。请拆分来源后读取余下内容。`);
          rows = [];
          break;
        }
        if (newSegment) {
          segment = { frames: [], initial: structure, identity, status: 'completed', messages: [], role: native.role, nativeOrca, nativeJobName: native.nativeJobName, displayImage: 0, mdSteps: [] };
          if (segments.length) segment.messages.push('结构身份、电子态、模式或原生作业/阶段标签变化：已开始独立段。');
          segments.push(segment);
          initialAtoms += structure.atoms.length;
        }
        const step = attributes(comment).step;
        const sourceStep = step !== undefined && /^[+-]?\d+$/.test(step) && Number.isSafeInteger(Number(step)) ? Number(step) : null;
        let imageLabel: string | undefined;
        if (native.pathImage !== undefined) {
          segment!.firstNativeImage ??= native.pathImage;
          // A repeated first native image restarts presentation order only; it
          // does not establish a scientific iteration or authorize path grouping.
          if (native.pathImage === segment!.firstNativeImage) segment!.displayImage = 0;
          imageLabel = `NEB image ${++segment!.displayImage}`;
        }
        segment!.frames.push({ start: frameStart, end: frameEnd, line: frameLine, summary: {
          index: segment!.frames.length, sourceStep, time: quantity(comment, 'time'), energy: quantity(comment, 'energy'), convergence: [], sourceLine: frameLine,
          ...Object.fromEntries(Object.entries(native).filter(([key]) => key !== 'role' && key !== 'nativeJobName' && key !== 'mdStep')),
          ...(native.energyObservations ? { energyObservations: native.energyObservations.map(observation => ({ ...observation, source: { id: file.id, name: file.name, line: frameLine + 1 } })) } : {}),
          ...(nativeOrca && coordinateRounding !== undefined ? { coordinateRoundingAngstrom: coordinateRounding } : {}),
          ...(imageLabel ? { label: imageLabel } : {}),
        } });
        if (native.mdStep) {
          const row = { ...native.mdStep, sourceId: file.id, sourceName: file.name, sourceLine: frameLine + 1, frameIndex: segment!.frames.length - 1 };
          for (const key of ['time', 'potentialEnergy'] as const) { const value = row[key]; if (value) row[key] = { ...value, sourceLine: frameLine + 1, sourceId: file.id, sourceName: file.name }; }
          segment!.mdSteps.push(row);
        }
        globalIndex++; rows = [];
        // Yield a browser task periodically so user cancellation is observable
        // even when a provider supplies the entire source in one large chunk.
        if (globalIndex % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (rows.length) {
        if (!segments.length) throw new Error(`XYZ第${frameLine}行开始的首帧截断，尚无完整帧。`);
        segments.at(-1)!.status = 'incomplete';
        segments.at(-1)!.messages.push(`XYZ第${frameLine}行开始的末帧截断；仅保留此前${globalIndex}个完整帧。`);
      }
    } catch (error) {
      if (!segments.length) throw error;
      const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      segments.at(-1)!.status = cancelled ? 'incomplete' : 'failed';
      segments.at(-1)!.messages.push(`${cancelled ? '读取已取消；' : ''}在第${frameLine || 1}行附近停止读取，保留${globalIndex}个完整帧：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!segments.length) throw new Error('XYZ中没有完整结构。');
    const cache = new Map<string, Structure>();
    let cachedAtoms = 0, remaining = segments.length;
    return segments.map((segment, segmentIndex) => {
      const id = `${file.id}:xyz:segment:${segmentIndex}`;
      const initial = segment.initial;
      initial.atoms.forEach((atom, index) => { atom.id ??= `${id}:atom:${index + 1}`; });
      const lifetime = new AbortController();
      let disposed = false;
      const result: TrajectoryResult = {
        id, label: segments.length > 1 ? `${file.name} · 段${segmentIndex + 1}` : file.name,
        kind: 'trajectory', engine: 'xyz', source: { id: file.id, name: file.name, size: file.size, ...(segment.nativeOrca ? { software: 'orca' as const, nativeJobName: segment.nativeJobName } : {}) }, jobIndex: 0,
        status: segment.status, messages: segment.messages, frames: segment.frames.map(f => f.summary), initialStructure: structuredClone(initial),
        ...(segment.mdSteps.length ? { scientific: { ...emptyScientificData(), tasks: ['md' as const], source: { id: file.id, name: file.name }, mdSteps: segment.mdSteps } } : {}),
        async getFrame(index, signal) {
          assertResultNotAborted(signal);
          if (disposed) throw new Error('轨迹段已关闭。');
          if (!Number.isSafeInteger(index) || index < 0 || index >= segment.frames.length) throw new Error('轨迹帧索引超出范围。');
          if (index === 0) return structuredClone(initial);
          const entry = segment.frames[index], key = `${id}:${index}`;
          const cached = cache.get(key);
          if (cached) { cache.delete(key); cache.set(key, cached); return structuredClone(cached); }
          const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const traceContext = { sourceId: file.id, resultId: id, jobIndex: result.jobIndex, sourceFrameIndex: index };
          const read = () => readResultSourceRange(file, entry.start, entry.end, combined);
          const bytes = await abortableResultRead(file.readTrace === 'source-boundary' ? read()
            : traceTrajectoryOperation('read', traceContext, read), combined);
          assertResultNotAborted(combined);
          if (bytes.length !== entry.end - entry.start) throw new Error('来源文件帧范围已截断或发生变化。');
          const structure = traceTrajectoryOperation('parse', { ...traceContext, workPhase: 'frame-parse' },
            () => parsedFrame(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file.name, `${file.id}:xyz:byte:${entry.start}`));
          structure.atoms.forEach((atom, atomIndex) => { atom.id ??= `${id}:atom:${atomIndex + 1}`; });
          // Concurrent readers may complete the same range; count its cache entry only once.
          const existing = cache.get(key); if (existing) cachedAtoms -= existing.atoms.length;
          cache.delete(key); cache.set(key, structure); cachedAtoms += structure.atoms.length;
          while (cache.size > CACHE_FRAMES || cachedAtoms > CACHE_ATOMS) {
            const first = cache.keys().next().value!; cachedAtoms -= cache.get(first)!.atoms.length; cache.delete(first);
          }
          return structuredClone(structure);
        },
        async dispose() {
          if (disposed) return;
          disposed = true; lifetime.abort();
          for (const [key, structure] of cache) if (key.startsWith(`${id}:`)) { cachedAtoms -= structure.atoms.length; cache.delete(key); }
          if (--remaining === 0) { cache.clear(); await close(); }
        },
      };
      return attachTrajectoryStages({ ...result, role: segment.role ?? 'unknown' });
    });
  } catch (error) { await close(); throw error; }
}
