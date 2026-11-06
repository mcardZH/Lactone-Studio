import type { Structure } from '../core/types';
import { superposeViewAtoms } from '../modeling/view-superposition';
import { assertResultNotAborted, type ResultFileRole, type TrajectoryResult } from './contracts';
import { attachTrajectoryStages, projectScientificFrames } from './trajectory-stages';
import { registerPreparedTrajectoryProjection } from './prepared-trajectory';
import { bindNebCompanion, type NebOutputContext } from './neb-companion-association';
import type { NebAuxiliarySource } from './neb-auxiliary-reader';
import type { MdAuxiliarySource } from './md-aux-reader';
import { copyMdSteps, mdSourceDifferences, mdTimesCompatible, qualifyMdStatistics } from './md-observations';
import { bindIrcCompanion, type IrcOutputContext } from './irc-companion-association';

export interface NebCompanionInputs { contexts: readonly NebOutputContext[]; auxiliaries: readonly NebAuxiliarySource[] }
export interface MdCompanionInputs { auxiliaries: readonly MdAuxiliarySource[] }
export interface IrcCompanionInputs { contexts: readonly IrcOutputContext[] }

const fileLeaf = (value: string) => value.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
const nativeTrajectoryStem = (value: string) => fileLeaf(value).replace(/(?:_trj)?\.xyz$|\.allxyz$/i, '');
const sameInventory = (a: Structure, b: Structure) => a.atoms.length === b.atoms.length && a.atoms.every((atom, index) => atom.element === b.atoms[index].element)
  && (a.charge === null || b.charge === null || a.charge === b.charge) && (a.multiplicity === null || b.multiplicity === null || a.multiplicity === b.multiplicity);
export function sourceGeometryMatches(a: Structure, b: Structure): boolean {
  if (!sameInventory(a, b)) return false;
  if (a.atoms.every((atom, index) => ['x', 'y', 'z'].every(axis => Math.abs(atom[axis as 'x'] - b.atoms[index][axis as 'x']) <= 1.1e-6))) return true;
  // ORCA may rigidly align endpoints before constructing a NEB path. Confirm the
  // same sequential atoms using the existing proper fit; never reorder atoms,
  // reflect a structure, or alter either source's geometry.
  const fit = superposeViewAtoms({ movingAtoms: a.atoms, referenceAtoms: b.atoms, mappingConfirmed: true });
  if (!fit.ok) return false;
  return a.atoms.every((atom, index) => {
    const point = [atom.x, atom.y, atom.z];
    const aligned = fit.transform.rotation.map((row, axis) => row.reduce((sum, value, component) => sum + value * point[component], fit.transform.translation[axis]));
    return Math.hypot(aligned[0] - b.atoms[index].x, aligned[1] - b.atoms[index].y, aligned[2] - b.atoms[index].z) <= 2e-6;
  });
}

/** Pair selected sources only. References never authorize filesystem traversal.
 * Bare native XYZ E observations acquire a unit only after agreement with the
 * same output's physical energy and geometry. Missing source data remain missing. */
export async function bindTrajectoryCompanion(output: TrajectoryResult, trajectory: TrajectoryResult, signal?: AbortSignal, neb?: NebCompanionInputs, md?: MdCompanionInputs, irc?: IrcCompanionInputs): Promise<TrajectoryResult | null> {
  assertResultNotAborted(signal);
  if (output.engine !== 'orca' || trajectory.engine !== 'xyz' || trajectory.source.software !== 'orca' || !output.scientific || !sameInventory(output.initialStructure, trajectory.initialStructure)) return null;
  const data = output.scientific;
  if (data.tasks.includes('irc') && irc) { const context = irc.contexts.find(context => context.outputId === output.id); return context ? bindIrcCompanion(context, trajectory, signal) : null; }
  if (data.tasks.includes('md')) return bindMdCompanion(output, trajectory, md?.auxiliaries ?? [], signal);
  if (data.tasks.includes('neb')) {
    const context = neb?.contexts.find(context => context.outputId === output.id);
    if (context) return bindNebCompanion(output, trajectory, context, neb!.auxiliaries, signal);
  }
  const isSavedScan = data.tasks.includes('scan') && trajectory.role === 'scan-point-set';
  const contentReferences = data.relatedFiles?.filter(entry => trajectory.source.nativeJobName && nativeTrajectoryStem(entry.name) === nativeTrajectoryStem(trajectory.source.nativeJobName)) ?? [];
  // Renaming a selected source does not erase its native job text. An explicit
  // output reference is considered only when that producer identity agrees;
  // multiple distinct source roles remain ambiguous.
  const reference = isSavedScan || new Set(contentReferences.map(entry => entry.role)).size !== 1 ? undefined
    : contentReferences.find(entry => fileLeaf(entry.name) === fileLeaf(trajectory.source.name)) ?? contentReferences[0];
  const nativeNames = [...new Set(data.properties.filter(field => field.key === 'native-job-name' && field.origin === 'program-adopted').map(field => String(field.value).replace(/\\/g, '/')))];
  const inferredOptimization = !reference && !isSavedScan && nativeNames.length === 1 && nativeNames[0] === trajectory.source.nativeJobName?.replace(/\\/g, '/') && data.tasks.includes('opt') && !data.tasks.some(task => ['scan','irc','neb','md','ts'].includes(task));
  const role: ResultFileRole | undefined = isSavedScan ? 'scan-point-set' : reference?.role ?? (inferredOptimization ? 'optimization-trajectory' : undefined);
  if (!role) return null;
  if (role === 'neb-path' || role === 'neb-iterations') {
    const frames = trajectory.frames.map(frame => ({ ...frame, energy: null, pathIteration: undefined }));
    const result = attachTrajectoryStages({ ...trajectory, role, frames, stages: undefined, scientific: { ...projectScientificFrames(data, frames.map(() => null)), notices: [...data.notices, '缺少可唯一绑定的NEB辅助证据；comment能量不作同帧几何能量，未生成native轮次。'] }, status: 'incomplete', messages: [...trajectory.messages, 'NEB原始几何保留；能量/几何迭代未证配对，保留空缺。'] });
    registerPreparedTrajectoryProjection(trajectory, result, frames.map((_, index) => index));
    return result;
  }
  if (!sameInventory(output.initialStructure, await trajectory.getFrame(0, signal))) return null;
  const candidates = new Map<string, number[]>();
  for (const frame of output.frames) if (frame.energy && ['hartree', 'Eh', 'Ha'].includes(frame.energy.unit)) {
    const key = frame.energy.value.toFixed(6), entries = candidates.get(key) ?? []; entries.push(frame.index); candidates.set(key, entries);
  }
  const matched: (number | null)[] = trajectory.frames.map(() => null);
  let anchor = false;
  let unitEvidence = '原子、几何及能量锚点匹配';
  for (const frame of trajectory.frames) {
    assertResultNotAborted(signal);
    const energy = frame.unqualifiedEnergy ?? (frame.energy && ['hartree', 'Eh', 'Ha'].includes(frame.energy.unit) ? frame.energy.value : undefined);
    if (energy === undefined) continue;
    const possible = [energy - 1e-7, energy, energy + 1e-7].flatMap(value => candidates.get(value.toFixed(6)) ?? []);
    const unique = [...new Set(possible)].filter(index => Math.abs(output.frames[index].energy!.value - energy) <= 1e-7
      && (role !== 'scan-point-set' || output.frames[index].pathNode === frame.pathNode));
    if (!unique.length) continue;
    const geometry = await trajectory.getFrame(frame.index, signal);
    const geometryMatches: number[] = [];
    for (const index of unique) if (sourceGeometryMatches(await output.getFrame(index, signal), geometry)) geometryMatches.push(index);
    if (geometryMatches.length === 1) { matched[frame.index] = geometryMatches[0]; anchor = true; }
    else if (inferredOptimization && geometryMatches.length > 1) return null;
    // A referenced native writer has one common energy convention; one verified
    // geometry/energy anchor establishes that convention. Scan without a source
    // file reference instead requires every saved node to match independently.
    if (anchor && reference) break;
  }
  const summary = data.pathSummary?.filter(row => row.kind === (role.startsWith('irc') ? 'irc' : 'neb'));
  const rawEnergy = (index: number) => trajectory.frames[index]?.unqualifiedEnergy ?? trajectory.frames[index]?.energy?.value;
  const energyAgrees = (index: number, row: NonNullable<typeof summary>[number]) => {
    const value = rawEnergy(index); return value !== undefined && Math.abs(value - row.energy) <= row.energyRounding + 1e-9;
  };
  // Sparse NEB/IRC output may print only the later TS optimization geometry.
  // Its explicit native writer reference plus an ordered, unit-labelled path
  // summary is separate evidence; demanding unavailable image geometries would
  // discard valid MEP/Full sources. Job text must agree with that reference too.
  const nativeStem = reference ? nativeTrajectoryStem(reference.name) : null;
  const jobAgrees = nativeStem && trajectory.source.nativeJobName?.toLowerCase() === nativeStem;
  if (!anchor && reference && jobAgrees && summary?.length) {
    if (role === 'irc-full' && summary.length === trajectory.frames.length && summary.every((row, index) => energyAgrees(index, row))) anchor = true;
    if (anchor) unitEvidence = '原子对应、原生作业标识及有单位的路径汇总匹配';
  }
  if (!anchor || (!reference && !inferredOptimization && matched.some(index => index === null))) return null;
  if (inferredOptimization) {
    const ordered = matched.filter((index): index is number => index !== null);
    if (ordered.some((index, at) => at > 0 && index <= ordered[at - 1])) return null;
  }
  const frames = trajectory.frames.map(frame => ({ ...frame,
    ...(frame.unqualifiedEnergy === undefined || inferredOptimization && matched[frame.index] === null ? {} : { energy: { value: frame.unqualifiedEnergy, unit: 'hartree' } }),
  }));
  const summaryMatches = summary?.length === frames.length && summary.every((row, index) => frames[index].energy
    && Math.abs(row.energy - frames[index].energy!.value) <= row.energyRounding + 1e-9);
  if (role === 'irc-full' && summaryMatches) {
    const tsIndex = summary!.findIndex(row => row.isTs);
    frames.forEach((frame, index) => {
      frame.pathNode = summary![index].sourceNode; frame.pathPoint = true;
      if (tsIndex >= 0 && summary!.filter(row => row.isTs).length === 1) {
        frame.pathDirection = index === tsIndex ? 'ts' : index < tsIndex ? 'reverse' : 'forward';
        frame.coordinate = { value: index - tsIndex, unit: 'step', label: '相对TS分支步数' };
      }
    });
  }
  if (role === 'ts-optimization-trajectory') frames.forEach(frame => { frame.stageId = 'ts-optimization'; });
  const scientific = projectScientificFrames(data, matched);
  scientific.source = { id: output.source.id, name: output.source.name };
  const bound: TrajectoryResult = { ...trajectory, role, stages: undefined, scientific, frames,
    status: output.status === 'completed' ? trajectory.status : output.status,
    messages: [...trajectory.messages, `配套来源 ${output.source.name}：${unitEvidence}；${reference ? `文件角色由输出源行 ${reference.sourceLine} 确认。` : inferredOptimization ? '原生ORCA优化来源按唯一、顺序一致的逐帧几何和能量匹配；未匹配结构保独立字段。' : '逐扫描点与输出匹配。'}`,
      ],
  };
  const staged = attachTrajectoryStages(bound);
  registerPreparedTrajectoryProjection(trajectory, staged, frames.map((_, index) => index));
  return staged;
}

/** Multiple matches remain independent; do not silently choose a job by order. */
export async function bindTrajectoryCompanions(results: readonly TrajectoryResult[], signal?: AbortSignal, neb?: NebCompanionInputs, md?: MdCompanionInputs, irc?: IrcCompanionInputs): Promise<TrajectoryResult[]> {
  const outputs = results.filter(result => result.engine === 'orca');
  const bound: TrajectoryResult[] = [];
  for (const result of results) {
    assertResultNotAborted(signal);
    if (result.engine !== 'xyz') { bound.push(result); continue; }
    const matches: TrajectoryResult[] = [];
    for (const context of irc?.contexts ?? []) { const match = await bindIrcCompanion(context, result, signal); if (match) matches.push(match); }
    for (const context of neb?.contexts ?? []) { const match = await bindNebCompanion(context.output, result, context, neb!.auxiliaries, signal); if (match) matches.push(match); }
    const ambiguousMdName = result.role === 'md-trajectory' && results.filter(other => other.engine === 'xyz' && fileLeaf(other.source.name) === fileLeaf(result.source.name)).length > 1;
    for (const output of outputs.filter(output => !neb?.contexts.some(context => context.outputId === output.id) && !irc?.contexts.some(context => context.outputId === output.id) && !(ambiguousMdName && output.scientific?.tasks.includes('md')))) { const match = await bindTrajectoryCompanion(output, result, signal, neb, md, irc); if (match) matches.push(match); }
    if (matches.length === 1 && matches[0].scientific?.nebEvidence?.geometryMapped) for (const source of neb?.auxiliaries ?? []) {
      const match = matches[0], evidence = match.scientific!.nebEvidence!;
      if (!evidence.auxiliaries.some(aux => aux.source.id === source.data.source.id)) continue;
      source.diagnostic.engine = 'orca'; source.diagnostic.source.software = 'orca'; source.diagnostic.jobIndex = match.jobIndex;
      source.diagnostic.jobAssociation = { outputSourceId: match.scientific!.source!.id, jobIndex: match.jobIndex, evidence: ['OUT明确辅助引用', 'ORCA 6.1.0已核表语法', 'image数与逐组原坐标arc指纹匹配'] };
    }
    if (matches.length === 1 && matches[0].role === 'md-trajectory') for (const source of md?.auxiliaries ?? []) {
      const match = matches[0], rows = match.scientific?.mdSteps?.filter(row => row.sourceId === source.diagnostic.source.id && row.jobIndex === match.jobIndex) ?? [];
      if (!rows.length) continue;
      source.diagnostic.engine = 'orca'; source.diagnostic.source.software = 'orca'; source.diagnostic.jobIndex = match.jobIndex;
      source.diagnostic.jobAssociation = { outputSourceId: match.scientific!.source!.id, jobIndex: match.jobIndex, evidence: ['原生OUT明确文件引用', '唯一native MD源/初始几何及步-时间打印区间对应；各源能量仍独立'] };
      source.diagnostic.scientific.mdSteps = rows.map(row => ({ ...row, frameIndex: null, sourceFrameIndex: undefined }));
    }
    bound.push(matches.length === 1 ? matches[0] : matches.length > 1 ? { ...result, messages: [...result.messages, '配套轨迹可对应多个输出作业，未自动选定来源。'] } : result);
  }
  return bound;
}

/** Bind an explicit dump's source ownership/step relation, never its energy
 * equality. The XYZ's own potential remains the plotted frame energy. */
async function bindMdCompanion(output: TrajectoryResult, trajectory: TrajectoryResult, auxiliaries: readonly MdAuxiliarySource[], signal?: AbortSignal): Promise<TrajectoryResult | null> {
  const data = output.scientific;
  if (!data || data.version !== '6.1.0' || trajectory.role !== 'md-trajectory' || !trajectory.scientific?.mdSteps?.length) return null;
  const references = data.relatedFiles?.filter(row => row.role === 'md-trajectory' && fileLeaf(row.name) === fileLeaf(trajectory.source.name)) ?? [];
  if (references.length !== 1) return null;
  const native = copyMdSteps(data.mdSteps, output.source);
  // Older saved companion projections may already include observations from
  // OUT or an auxiliary. Only the XYZ's own rows can establish frame identity.
  const own = copyMdSteps(trajectory.scientific.mdSteps, trajectory.source).filter(row => row.sourceId === trajectory.source.id);
  if (!native.length || new Set(native.map(row => row.sourceStep)).size !== native.length || new Set(own.map(row => row.sourceStep)).size !== own.length) return null;
  const first = await trajectory.getFrame(0, signal); assertResultNotAborted(signal);
  const sourceRounding = output.frames[0]?.coordinateRoundingAngstrom, targetRounding = trajectory.frames[0]?.coordinateRoundingAngstrom;
  if (!sameInventory(output.initialStructure, first) || !Number.isFinite(sourceRounding) || !Number.isFinite(targetRounding)) return null;
  const bound = sourceRounding! + targetRounding! + 1e-12;
  if (!first.atoms.every((atom, index) => ['x', 'y', 'z'].every(axis => Math.abs(atom[axis as 'x'] - output.initialStructure.atoms[index][axis as 'x']) <= bound))) return null;
  const firstRow = native.find(row => row.sourceStep === own[0].sourceStep);
  if (!firstRow || !mdTimesCompatible(firstRow.time, own[0].time)) return null;
  const steps = new Map(own.map(row => [row.sourceStep, row]));
  const attachFrames = (rows: ReturnType<typeof copyMdSteps>) => rows.map(row => {
    const target = steps.get(row.sourceStep), compatible = target && mdTimesCompatible(row.time, target.time);
    return { ...row, jobIndex: output.jobIndex, frameIndex: compatible ? target.frameIndex : null };
  });
  const selected: ReturnType<typeof copyMdSteps>[] = [];
  for (const source of auxiliaries) {
    const role = source.kind === 'log' ? 'md-log' : 'md-statistics';
    const refs = data.relatedFiles?.filter(ref => ref.role === role && fileLeaf(ref.name) === fileLeaf(source.diagnostic.source.name)) ?? [];
    if (refs.length !== 1 || auxiliaries.filter(aux => aux.kind === source.kind && fileLeaf(aux.diagnostic.source.name) === fileLeaf(source.diagnostic.source.name)).length !== 1) continue;
    const rows = copyMdSteps(source.diagnostic.scientific.mdSteps, source.diagnostic.source);
    if (new Set(rows.map(row => row.sourceStep)).size !== rows.length) continue;
    if (source.kind === 'log') {
      const declared = source.nativeBaseName?.replace(/\\/g, '/') + '.md.log';
      if (!source.nativeBaseName || declared.toLowerCase() !== refs[0].name.replace(/\\/g, '/').toLowerCase()) continue;
      selected.push(attachFrames(rows));
    } else {
      const qualified = qualifyMdStatistics(rows, native);
      if (qualified) selected.push(attachFrames(qualified));
    }
  }
  const scientific = projectScientificFrames(data, own.map((_, index) => index === 0 ? 0 : null));
  scientific.source = { id: output.source.id, name: output.source.name };
  scientific.mdSteps = [...own.map(row => ({ ...row, jobIndex: output.jobIndex })), ...attachFrames(native), ...selected.flat()];
  scientific.mdSourceDifferences = mdSourceDifferences(scientific.mdSteps);
  const messages = ['MD轨迹按原生Dump引用、初始逐原子几何和步/时间打印区间绑定；每个文件的时间精度与各能量原单位分别保留。'];
  if (scientific.mdSourceDifferences.length) messages.push('MD来源按标准单位换算存在超打印精度差异；保留双方，未反推换算因子或覆盖XYZ势能。');
  if (selected.flat().some(row => row.frameIndex === null)) messages.push('部分辅助步未与所选XYZ帧建立唯一时间对应；保留未归属观测。');
  scientific.notices = [...scientific.notices, ...messages];
  const result = attachTrajectoryStages({ ...trajectory, jobIndex: output.jobIndex, scientific, stages: undefined, status: output.status === 'failed' ? 'failed' : output.status === 'incomplete' || trajectory.status !== 'completed' ? 'incomplete' : 'completed', messages: [...trajectory.messages, ...messages] });
  registerPreparedTrajectoryProjection(trajectory, result, result.frames.map((_, index) => index));
  return result;
}
