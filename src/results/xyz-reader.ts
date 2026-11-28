import { plainXyzFrame } from '../core/parsers';
import { periodicXyzComment, periodicXyzFrame } from '../core/periodic-parsers';
import { assertResultNotAborted, type ResultFileRole, type ResultFrameSummary, type ResultInputFile, type ResultQuantity, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { attachTrajectoryStages } from './trajectory-stages';
import { createTrajectoryOperationBatch } from './trajectory-operations';
import { emptyScientificData, scientificRoundingInterval, type MdStepObservation } from './scientific-contracts';
import { consumeTrajectoryText, ownTrajectoryText, type TrajectoryTextLine } from './trajectory-text-reader';
import { materializePackedTrajectoryFrame, PackedTrajectoryFrames, registerPackedTrajectorySource, type PackedTrajectoryAtom } from './packed-trajectory-source';

export { abortableResultRead } from './trajectory-text-reader';
/** Validate representable counters; file size never limits a complete scientific index. */
export function xyzIndexLimitMessage(frames: number, segments: number, initialAtoms: number, nextInitialAtoms: number): string | null {
  if (![frames, segments, initialAtoms, nextInitialAtoms, initialAtoms + nextInitialAtoms].every(value => Number.isSafeInteger(value) && value >= 0)) return '索引计数无效';
  return null;
}
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eEdD][+-]?\\d+)?';
interface Segment {
  frames: ResultFrameSummary[];
  packed: PackedTrajectoryFrames;
  sourceTopology: readonly PackedTrajectoryAtom[];
  identity: string;
  status: TrajectoryResult['status']; messages: string[]; role?: ResultFileRole; nativeOrca: boolean; nativeJobName?: string;
  firstNativeImage?: number; displayImage: number; mdSteps: MdStepObservation[];
}

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

function attributes(comment: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const m of comment.matchAll(/([A-Za-z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g)) values[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  return values;
}
function quantity(comment: string, key: 'time' | 'energy', attrs: Record<string, string>): ResultQuantity | null {
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
type XyzGrammar = ReturnType<typeof plainXyzFrame> | ReturnType<typeof periodicXyzFrame>;

interface PendingFrame {
  count: number;
  start: number;
  line: number;
  row: number;
  structure?: XyzGrammar;
  comment?: string;
  attrs?: Record<string, string>;
  native?: ReturnType<typeof orcaXyzComment> & ReturnType<typeof orcaMdXyzComment>;
  rounding?: number;
  coordinates?: Float64Array;
  existing?: readonly PackedTrajectoryAtom[];
  changed?: PackedTrajectoryAtom[];
}

function sameAtom(a: PackedTrajectoryAtom | undefined, b: PackedTrajectoryAtom): boolean {
  return a !== undefined && a.element === b.element && a.id === b.id && a.sourceIndex === b.sourceIndex;
}

function growCoordinates(frame: PendingFrame): Float64Array {
  const coordinates = frame.coordinates;
  if (coordinates && coordinates.length > frame.row * 3) return coordinates;
  const next = new Float64Array(Math.min(frame.count * 3, coordinates ? 2 * coordinates.length : 1024 * 3));
  if (coordinates) next.set(coordinates);
  return frame.coordinates = next;
}

/** Validate every row while streaming. Subsequent access borrows packed coordinates
 * or materializes a mutable scientific snapshot without re-reading the file. */
export async function readXyzTrajectory(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  const segments: Segment[] = [];
  const appended = new Set<PackedTrajectoryFrames>();
  const parse = createTrajectoryOperationBatch('parse', { sourceId: file.id, workPhase: 'xyz-index-frame' });
  let pending: PendingFrame | undefined, currentLine = 1, globalIndex = 0, initialAtoms = 0;
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= Promise.resolve().then(() => file.close?.()).then(() => undefined);
  const alias = file.name.replace(/\.[^.]*$/, '') + '.xyz';

  function finish(frame: PendingFrame, grammar: XyzGrammar) {
    const { comment, attrs, native, line, start } = frame as PendingFrame & Required<Pick<PendingFrame, 'comment' | 'attrs' | 'native'>>;
    const { structure } = grammar;
    const sourceTopology = frame.changed ?? frame.existing!;
    const nativeOrca = native.unqualifiedEnergy !== undefined || native.energy !== undefined;
    const identity = JSON.stringify([structure.charge, structure.multiplicity, attrs.state ?? attrs.electronic_state ?? null,
      attrs.mode ?? null, attrs.properties ?? null, structure.cell?.pbc ?? null]);
    const previous = segments.at(-1);
    const newSegment = !previous || frame.existing !== previous.sourceTopology || !!frame.changed || previous.identity !== identity
      || previous.role !== native.role || previous.nativeOrca !== nativeOrca || previous.nativeJobName !== native.nativeJobName;
    const limit = xyzIndexLimitMessage(globalIndex, segments.length, initialAtoms, newSegment ? frame.count : 0);
    if (limit) throw new Error('XYZ来源索引无效：' + limit);
    if (frame.changed && structure.format === 'extended XYZ' && new Set(sourceTopology.map(atom => atom.id)).size !== frame.count) {
      throw new Error('来源含重复原子ID。');
    }
    let segment = previous;
    if (newSegment) {
      segment = { frames: [], packed: new PackedTrajectoryFrames(), sourceTopology, identity, status: 'completed', messages: [], role: native.role,
        nativeOrca, nativeJobName: native.nativeJobName, displayImage: 0, mdSteps: [] };
      if (segments.length) segment.messages.push('结构身份、电子态、模式或原生作业/阶段标签变化：已开始独立段。');
      segments.push(segment);
      initialAtoms += frame.count;
    }
    const selected = segment!;
    const index = selected.frames.length;
    const step = attrs.step;
    const sourceStep = step !== undefined && /^[+-]?\d+$/.test(step) && Number.isSafeInteger(Number(step)) ? Number(step) : null;
    let imageLabel: string | undefined;
    if (native.pathImage !== undefined) {
      selected.firstNativeImage ??= native.pathImage;
      // A repeated first native image changes order only, never scientific iteration.
      if (native.pathImage === selected.firstNativeImage) selected.displayImage = 0;
      imageLabel = 'NEB image ' + (++selected.displayImage);
    }
    const { atoms: _atoms, ...header } = structure;
    const segmentId = file.id + ':xyz:segment:' + (segments.length - 1);
    const topology = selected.packed.metadata(0)?.topology ?? sourceTopology.map((atom, i) => atom.id !== undefined
      ? atom : { ...atom, id: segmentId + ':atom:' + (i + 1) });
    selected.packed.append({ header: { ...header, name: file.name,
      id: index === 0 ? file.id + ':xyz:frame:' + globalIndex : file.id + ':xyz:byte:' + start },
      topology, coordinates: frame.coordinates! });
    appended.add(selected.packed);
    selected.frames.push({
      index, sourceStep, time: quantity(comment, 'time', attrs), energy: quantity(comment, 'energy', attrs), convergence: [], sourceLine: line,
      ...Object.fromEntries(Object.entries(native).filter(([key]) => key !== 'role' && key !== 'nativeJobName' && key !== 'mdStep')),
      ...(native.energyObservations ? { energyObservations: native.energyObservations.map(observation => ({ ...observation, source: { id: file.id, name: file.name, line: line + 1 } })) } : {}),
      ...(nativeOrca && Number.isFinite(frame.rounding) ? { coordinateRoundingAngstrom: frame.rounding } : {}),
      ...(imageLabel ? { label: imageLabel } : {}),
    });
    if (native.mdStep) {
      const row = { ...native.mdStep, sourceId: file.id, sourceName: file.name, sourceLine: line + 1, frameIndex: index };
      for (const key of ['time', 'potentialEnergy'] as const) {
        const value = row[key];
        if (value) row[key] = { ...value, sourceLine: line + 1, sourceId: file.id, sourceName: file.name };
      }
      selected.mdSteps.push(row);
    }
    globalIndex++;
  }

  function consume(line: TrajectoryTextLine) {
    currentLine = line.number;
    if (!pending) {
      const text = line.text.trim();
      if (!text || text === '>') return;
      if (!/^\d+$/.test(text)) throw new Error('XYZ第' + line.number + '行应为原子数。');
      const count = Number(text);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('XYZ第' + line.number + '行原子数须为正安全整数。');
      const existing = segments.at(-1)?.sourceTopology;
      pending = { count, start: line.start, line: line.number, row: 0,
        ...(existing?.length === count ? { existing, coordinates: new Float64Array(count * 3) } : { changed: [] }) };
      return;
    }
    const frame = pending;
    if (!frame.structure) {
      const comment = ownTrajectoryText(line.text);
      frame.comment = comment;
      frame.attrs = attributes(comment);
      frame.native = { ...orcaXyzComment(comment), ...orcaMdXyzComment(comment) };
      if (frame.native.unqualifiedEnergy !== undefined || frame.native.energy !== undefined) frame.rounding = 0;
      frame.structure = periodicXyzComment(comment) ? periodicXyzFrame(alias, comment, frame.count, 0) : plainXyzFrame(alias, comment, 0);
      if (frame.structure.structure.cell) frame.structure.structure.cell.source = file.name;
      return;
    }
    const row = line.text.trim().split(/\s+/);
    const atom = frame.structure.readAtom(row, frame.row);
    if (!frame.changed && !sameAtom(frame.existing![frame.row], atom)) frame.changed = frame.existing!.slice(0, frame.row);
    if (frame.changed) {
      const { x: _x, y: _y, z: _z, ...topology } = atom;
      if (topology.id !== undefined) topology.id = ownTrajectoryText(topology.id);
      frame.changed.push(topology);
    }
    const coordinates = growCoordinates(frame);
    const offset = frame.row * 3;
    coordinates[offset] = atom.x; coordinates[offset + 1] = atom.y; coordinates[offset + 2] = atom.z;
    if (Number.isFinite(frame.rounding)) {
      const values = row.length === 4 ? row.slice(1).map(scientificRoundingInterval) : [];
      frame.rounding = values.length === 3 && values.every(value => Number.isFinite(value)) ? Math.max(frame.rounding!, ...(values as number[])) : NaN;
    }
    if (++frame.row !== frame.count) return;
    finish(frame, frame.structure);
    pending = undefined;
  }

  try {
    try {
      await consumeTrajectoryText(file, options, line => parse.run(() => consume(line)),async()=>{
        for(const packed of appended)await packed.drain();appended.clear();
      });
      if (pending) {
        if (!segments.length) throw new Error('XYZ第' + pending.line + '行开始的首帧截断，尚无完整帧。');
        const last = segments.at(-1)!;
        last.status = 'incomplete';
        last.messages.push('XYZ第' + pending.line + '行开始的末帧截断；仅保留此前' + globalIndex + '个完整帧。');
      }
    } catch (error) {
      if (!segments.length) throw error;
      const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      const last = segments.at(-1)!;
      last.status = cancelled ? 'incomplete' : 'failed';
      last.messages.push((cancelled ? '读取已取消；' : '') + '在第' + (pending?.line ?? currentLine) + '行附近停止读取，保留'
        + globalIndex + '个完整帧：' + (error instanceof Error ? error.message : String(error)));
    } finally { parse.flush(); }
    if (!segments.length) throw new Error('XYZ中没有完整结构。');
    pending = undefined;
    let remaining = segments.length;
    const results:TrajectoryResult[]=[];
    for (let segmentIndex=0; segmentIndex<segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      try{await segment.packed.seal();}catch(error){segment.status='failed';segment.messages.push('轨迹暂存未完成；保留可用坐标：'+(error instanceof Error?error.message:String(error)));}
      const id = file.id + ':xyz:segment:' + segmentIndex;
      let disposed = false;
      const result = attachTrajectoryStages({
        id, label: segments.length > 1 ? file.name + ' · 段' + (segmentIndex + 1) : file.name,
        kind: 'trajectory', engine: 'xyz', source: { id: file.id, name: file.name, size: file.size,
          ...(segment.nativeOrca ? { software: 'orca' as const, nativeJobName: segment.nativeJobName } : {}) }, jobIndex: 0,
        status: segment.status, messages: segment.messages, frames: segment.frames, initialStructure: materializePackedTrajectoryFrame((await segment.packed.read(0))!),
        role: segment.role ?? 'unknown',
        ...(segment.mdSteps.length ? { scientific: { ...emptyScientificData(), tasks: ['md' as const], source: { id: file.id, name: file.name }, mdSteps: segment.mdSteps } } : {}),
        async getFrame(index, signal) {
          assertResultNotAborted(signal);
          if (disposed) throw new Error('轨迹段已关闭。');
          if (!Number.isSafeInteger(index) || index < 0 || index >= segment.frames.length) throw new Error('轨迹帧索引超出范围。');
          await Promise.resolve();
          assertResultNotAborted(signal);
          if (disposed) throw new DOMException('轨迹段已关闭。', 'AbortError');
          return materializePackedTrajectoryFrame((await segment.packed.read(index,signal))!);
        },
        async dispose() {
          if (!disposed) { disposed = true; segment.sourceTopology = [];remaining--; }
          await segment.packed.dispose();
          if (remaining === 0) await close();
        },
      });
      registerPackedTrajectorySource(result, segment.packed.get, {read:segment.packed.read,paged:segment.packed.paged,canonical:true});
      results.push(result);
    }
    return results;
  } catch (error) { await Promise.allSettled(segments.map(segment=>segment.packed.dispose()));await close();throw error; }
}
