import type { Structure } from '../core/types';
import { assertResultNotAborted, type ResultDiagnostic, type ResultEnergyObservation, type ResultFileRole, type ResultFrameSummary, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { scientificRoundingInterval, type NebAuxiliaryData, type NebEvidence } from './scientific-contracts';
import type { NebAuxiliarySource } from './neb-auxiliary-reader';
import { attachTrajectoryStages, projectScientificFrames } from './trajectory-stages';
import { registerPreparedTrajectoryProjection } from './prepared-trajectory';
import { outputLines } from './optimization-reader';

const BOHR = .529177210903;
const leaf = (name: string) => name.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
const nativeStem = (name: string) => name.replace(/\\/g, '/').replace(/(?:_trj)?\.xyz$|\.allxyz$/i, '').toLowerCase();
const cohort = (name: string) => nativeStem(name).replace(/_MEP(?:_ALL)?$|_initial_path$/i, '');
const sameAtoms = (a: Structure, b: Structure) => a.atoms.length === b.atoms.length && a.atoms.every((atom, index) => atom.element === b.atoms[index].element);
type ReferenceKind = 'initial' | 'path' | 'history' | 'interpolation' | 'log';
type NebOutputSource = Pick<TrajectoryResult, 'id' | 'source' | 'jobIndex' | 'status' | 'messages' | 'scientific'>;
export interface NebOutputContext {
  outputId: string; version: string;
  output: NebOutputSource;
  references: { kind: ReferenceKind; name: string; sourceLine: number }[];
  sourceLines: Record<number, string>;
}
/** Reads only native references/raw tokens already indexed by the scientific reader. */
export async function readNebOutputContext(file: ResultInputFile, output: TrajectoryResult | ResultDiagnostic, options: ResultReadOptions = {}): Promise<NebOutputContext | null> {
  if (output.engine !== 'orca' || output.jobIndex === null || output.scientific?.version !== '6.1.0' || !output.scientific.tasks.includes('neb')) return null;
  const references: NebOutputContext['references'] = [];
  const patterns: [ReferenceKind, RegExp][] = [
    ['initial', /^\s*Writing initial trajectory to file\s+\.+\s+(\S+\.xyz)\s*$/i],
    ['interpolation', /^\s*Energy profile during opt\. written to\s+\.+\s+(\S+\.interp)\s*$/i],
    ['log', /^\s*Optimization log-file\s+\.+\s+(\S+\.NEB\.log)\s*$/i],
    ['path', /^\s*(?:Current trajectory will be written to|and to allxyz file)\s+\.+\s+(\S+\.(?:xyz|allxyz))\s*$/i],
    ['history', /^\s*Trajectory history will be written to\s+\.+\s+(\S+\.xyz)\s*$/i],
  ];
  const sourceLines: Record<number, string> = {};
  const wanted = new Set((output.scientific.pathSummary ?? []).filter(row => row.kind === 'neb').map(row => row.sourceLine));
  for await (const line of outputLines(file, options, () => {})) {
    for (const [kind, pattern] of patterns) { const match = line.text.match(pattern); if (match) references.push({ kind, name: match[1], sourceLine: line.number }); }
    if (wanted.has(line.number)) sourceLines[line.number] = line.text;
  }
  if (!references.some(ref => ref.kind === 'path')) return null;
  return { outputId: output.id, output: { id: output.id, source: output.source, jobIndex: output.jobIndex, status: output.status, messages: output.messages, scientific: output.scientific }, version: '6.1.0', references, sourceLines };
}

function interval(raw: string) { return scientificRoundingInterval(raw) ?? 0; }
function compatibleDistances(a: NebAuxiliaryData['iterations'][number], b: NebAuxiliaryData['iterations'][number]) {
  return a.images.length === b.images.length && a.images.every((row, image) => Math.abs(row.distanceBohr - b.images[image].distanceBohr) <= interval(row.distanceRaw) + interval(b.images[image].distanceRaw) + 1e-10);
}
function conflicts(interpolation: NebAuxiliaryData | undefined, log: NebAuxiliaryData | undefined): NebEvidence['conflicts'] {
  const result: NebEvidence['conflicts'] = [];
  for (const table of interpolation?.iterations ?? []) {
    const matches = log?.iterations.filter(row => row.iteration === table.iteration) ?? [];
    if (matches.length !== 1 || !compatibleDistances(table, matches[0])) continue;
    const logged = matches[0], first = logged.images[0].energy;
    if (!first) continue;
    table.images.forEach((row, image) => {
      const raw = logged.images[image]?.energy, printed = row.relativeEnergy;
      if (!raw || !printed) return;
      const value = raw.value - first.value, bound = interval(raw.rawValue) + interval(first.rawValue) + interval(printed.rawValue) + 1e-10;
      if (Math.abs(value - printed.value) > bound) result.push({ iteration: table.iteration, image, kind: 'relative-energy', values: [printed, { ...raw, value, relative: true, rawValue: `${raw.rawValue} - ${first.rawValue}`, origin: 'derived' }] });
    });
  }
  return result;
}

/** No rigid fitting: native Cartesian arc distance fingerprints use the source
 * print intervals, while energy vectors receive their own native iteration. */
export async function bindNebCompanion(output: NebOutputSource, trajectory: TrajectoryResult, context: NebOutputContext, auxiliaries: readonly NebAuxiliarySource[], signal?: AbortSignal): Promise<TrajectoryResult | null> {
  assertResultNotAborted(signal);
  const data = output.scientific, imageCount = data?.pathImageCount, nativeName = trajectory.source.nativeJobName;
  if (!data || !imageCount || imageCount < 3 || !nativeName || trajectory.source.software !== 'orca' || context.outputId !== output.id) return null;
  const explicit = context.references.filter(ref => ['initial', 'path', 'history'].includes(ref.kind) && nativeStem(ref.name) === nativeStem(nativeName));
  const nativeCohorts = new Set(context.references.filter(ref => ref.kind === 'path').map(ref => cohort(ref.name)));
  const isCohort = nativeCohorts.size === 1 && nativeCohorts.has(cohort(nativeName));
  if (!explicit.length && !isCohort) return null;
  const kind = explicit[0]?.kind ?? (/_MEP_ALL$/i.test(nativeName) ? 'history' : /_initial_path$/i.test(nativeName) ? 'initial' : /_MEP$/i.test(nativeName) ? 'path' : null);
  if (!kind || !['initial', 'path', 'history'].includes(kind)) return null;
  const role: ResultFileRole = kind === 'history' ? 'neb-iterations' : 'neb-path';
  const select = (kind: 'interpolation' | 'log') => {
    const refs = context.references.filter(ref => ref.kind === kind), names = new Set(refs.map(ref => leaf(ref.name)));
    const selected = auxiliaries.filter(aux => aux.data.kind === kind && names.has(leaf(aux.data.source.name)));
    return selected.length === 1 && refs.length === 1 ? selected[0] : undefined;
  };
  const interpSource = select('interpolation'), logSource = select('log'), interpolation = interpSource?.data, log = logSource?.data;
  const sources = [interpolation, log].filter((value): value is NebAuxiliaryData => !!value);
  const evidence: NebEvidence = { version: context.version, association: [explicit.length ? '原生OUT明确文件引用与XYZ原生作业路径一致' : 'ORCA 6.1.0唯一完整原生作业路径cohort；仍须逐组arc指纹与OUT汇总核对'], auxiliaries: sources, conflicts: conflicts(interpolation, log), geometryMapped: 0, geometryTotal: trajectory.frames.length, energyMapped: 0 };
  const frames: ResultFrameSummary[] = trajectory.frames.map(frame => ({ ...frame, energy: null, pathIteration: undefined, climbingImage: undefined, geometryAssociation: undefined, energyAssociation: undefined, ...(frame.pathImage === undefined ? {} : { sourcePathImage: frame.pathImage }), energyObservations: (frame.energyObservations ?? []).map(row => ({ ...row, iteration: undefined, image: undefined, association: 'unresolved' })) }));
  const notices = ['NEB comment能量与同帧几何独立核对；未证实同iteration/image的能量保持空缺。'];
  const summary = data.pathSummary?.filter(row => row.kind === 'neb');
  const groups = Math.floor(frames.length / imageCount);
  for (let group = 0; group < groups; group++) {
    assertResultNotAborted(signal);
    const start = group * imageCount, band = frames.slice(start, start + imageCount);
    const ids = band.map(frame => frame.sourcePathImage);
    if (ids.some(id => id !== undefined) && !ids.every((id, image) => id === image) && !ids.every((id, image) => id === image + 1)) { notices.push('原生image序号与完整有序band不一致；未猜测映射。'); continue; }
    const arc = [0], bounds = [0]; let previous: Structure | null = null, atomOrder: string | null = null;
    let valid = true;
    for (let image = 0; image < imageCount; image++) {
      const structure = await trajectory.getFrame(start + image, signal), order = structure.atoms.map(atom => atom.element).join(',');
      const precision = band[image].coordinateRoundingAngstrom;
      if (!Number.isFinite(precision) || precision! <= 0 || (atomOrder !== null && atomOrder !== order)) { valid = false; break; }
      atomOrder = order;
      if (previous) {
        if (!sameAtoms(previous, structure)) { valid = false; break; }
        const displacement = Math.sqrt(structure.atoms.reduce((sum, atom, index) => sum + (atom.x - previous!.atoms[index].x) ** 2 + (atom.y - previous!.atoms[index].y) ** 2 + (atom.z - previous!.atoms[index].z) ** 2, 0)) / BOHR;
        arc.push(arc[image - 1] + displacement);
        bounds.push(bounds[image - 1] + Math.sqrt(structure.atoms.length * 3) * (precision! + band[image - 1].coordinateRoundingAngstrom!) / BOHR);
      }
      previous = structure;
    }
    if (!valid) continue;
    const matches = interpolation?.iterations.filter(table => table.images.length === imageCount && table.images.every((row, image) => Math.abs(row.distanceBohr - arc[image]) <= bounds[image] + interval(row.distanceRaw) + 1e-10)) ?? [];
    const comments = band.map(frame => frame.energyObservations?.find(row => row.kind === 'xyz-comment'));
    const initialPlaceholder = kind === 'initial' && comments.every(row => row?.value === 0);
    if (initialPlaceholder) comments.forEach(row => { if (row) row.placeholder = true; });
    const energyMatches = log?.iterations.filter(table => table.images.length === imageCount && table.images.every((row, image) => row.energy && comments[image] && Math.abs(row.energy.value - comments[image]!.value) <= interval(row.energy.rawValue) + interval(comments[image]!.rawValue) + 1e-10)) ?? [];
    if (!initialPlaceholder && energyMatches.length === 1) comments.forEach((observation, image) => { if (observation) { observation.unit = 'hartree'; observation.iteration = energyMatches[0].iteration; observation.image = image; observation.association = 'energy-vector'; } });
    if (matches.length !== 1) { notices.push(`来源band ${group + 1}的几何迭代未取得唯一arc指纹；未以帧序号生成native iteration。`); continue; }
    const table = matches[0];
    // A cohort-only source also needs a consistent final OUT summary or a
    // separate explicitly referenced log table at the same native iteration.
    const logTables = log?.iterations.filter(row => row.iteration === table.iteration && compatibleDistances(table, row)) ?? [];
    const summaryImages = summary?.every((row, image) => row.sourceNode === image) || summary?.every((row, image) => row.sourceNode === image + 1);
    const summaryAgrees = summary?.length === imageCount && summaryImages && summary.every((row, image) => {
      const token = context.sourceLines[row.sourceLine]?.trim().split(/\s+/)[1];
      return row.coordinate?.unit === 'angstrom' && Number.isFinite(Number(token)) && Math.abs(row.coordinate.value / BOHR - arc[image]) <= bounds[image] + interval(token) / BOHR + 1e-10;
    });
    if (!explicit.length && logTables.length !== 1 && !summaryAgrees) continue;
    band.forEach((frame, image) => {
      frame.stageId = 'neb-path'; frame.pathIteration = table.iteration; frame.pathImage = image;
      frame.geometryAssociation = { iteration: table.iteration, image, source: { id: trajectory.source.id, name: trajectory.source.name, line: frame.sourceLine }, evidenceSource: { id: interpolation!.source.id, name: interpolation!.source.name, line: table.sourceLine }, evidence: 'native-arc-distances', maximumResidualBohr: Math.max(...table.images.map((row, i) => Math.abs(row.distanceBohr - arc[i]))), boundBohr: bounds.at(-1)! + interval(table.images.at(-1)!.distanceRaw) };
      // Only the complete native summary's explicit marker may identify CI.
      // The optimizer CI column uses a different ordinal in real ORCA output;
      // neither that column nor an independent SADDLE POINT is a band mapping.
      if(summaryAgrees&&summary){
        const marked=summary.filter(row=>/<=\s*CI\s*$/i.test(context.sourceLines[row.sourceLine]??''));
        const base=summary.every((row,i)=>row.sourceNode===i)?0:summary.every((row,i)=>row.sourceNode===i+1)?1:undefined;
        if(marked.length===1&&base!==undefined&&marked[0]===summary[image])frame.climbingImage={iteration:table.iteration,image:marked[0].sourceNode!,imageBase:base,source:{id:output.source.id,name:output.source.name,line:marked[0].sourceLine}};
      }
      evidence.geometryMapped++;
      const relative = table.images[image].relativeEnergy;
      if (relative) frame.energyObservations!.push(relative);
      let absolute = logTables.length === 1 ? logTables[0].images[image].energy : undefined;
      if (!absolute && summaryAgrees) {
        const row = summary![image], token = context.sourceLines[row.sourceLine].trim().split(/\s+/)[2];
        absolute = { kind: 'output-summary', value: row.energy, rawValue: token, unit: 'hartree', source: { id: output.source.id, name: output.source.name, line: row.sourceLine }, iteration: table.iteration, image, association: 'native-table', origin: 'observation' };
      }
      if (absolute) { frame.energyObservations!.push(absolute); frame.energy = { value: absolute.value, unit: absolute.unit! }; frame.energyAssociation = { iteration: table.iteration, image, source: absolute.source, ...(evidence.conflicts.some(row => row.iteration === table.iteration && row.image === image) ? { relativeSourceConflict: true } : {}) }; evidence.energyMapped++; }
    });
  }
  if (frames.length % imageCount) notices.push('末band仅有部分image，保留原帧且未借前轮补齐。');
  if (!evidence.geometryMapped && !explicit.length) return null;
  if (evidence.conflicts.length) notices.push('相同原生iteration的interp相对能与log差分能存在打印精度外冲突；保留双方，frame绝对能明确引用log/OUT原观测，未平均或用interp反解替代。');
  const scientific = projectScientificFrames(data, frames.map(() => null)); scientific.nebEvidence = evidence;
  scientific.source = { id: output.source.id, name: output.source.name };
  scientific.notices = [...scientific.notices, ...notices];
  const completeMapping = evidence.geometryMapped === frames.length && evidence.energyMapped === frames.length && sources.every(source => source.status === 'complete');
  const status = output.status === 'failed' ? 'failed' : output.status === 'incomplete' || !completeMapping ? 'incomplete' : trajectory.status;
  const result = attachTrajectoryStages({ ...trajectory, role, jobIndex: output.jobIndex, scientific, stages: undefined, frames, status, messages: [...trajectory.messages, ...notices] });
  registerPreparedTrajectoryProjection(trajectory, result, frames.map((_, index) => index));
  return result;
}
