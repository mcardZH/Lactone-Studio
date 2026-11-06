import type { Structure } from '../core/types';
import { assertResultNotAborted, type ResultDiagnostic, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { scientificRoundingInterval, type ScientificData } from './scientific-contracts';
import { outputLines } from './optimization-reader';
import { projectScientificFrames } from './trajectory-stages';
import { registerPreparedTrajectoryProjection } from './prepared-trajectory';

export type IrcOutputSource = Pick<TrajectoryResult, 'id' | 'source' | 'jobIndex' | 'status' | 'messages' | 'scientific'> & { initialStructure?: Structure };
export interface IrcOutputContext {
  outputId: string;
  output: IrcOutputSource;
  references: { name: string; role: 'irc-full' | 'irc-forward' | 'irc-reverse'; sourceLine: number }[];
}
const stem = (name: string) => name.replace(/\\/g, '/').split('/').at(-1)!.replace(/(?:_trj)?\.xyz$/i, '').toLowerCase();
const inventory = (a: Structure, b: Structure) => a.atoms.length === b.atoms.length && a.atoms.every((atom, i) => atom.element === b.atoms[i].element)
  && (a.charge === null || b.charge === null || a.charge === b.charge) && (a.multiplicity === null || b.multiplicity === null || a.multiplicity === b.multiplicity);
const machineError = (a: number, b: number) => Number.EPSILON * 8 * Math.max(1, Math.abs(a), Math.abs(b));

/** Reads native reference labels only from the indexed job. No referenced path is opened. */
export async function readIrcOutputContext(file: ResultInputFile, output: TrajectoryResult | ResultDiagnostic, options: ResultReadOptions = {}): Promise<IrcOutputContext | null> {
  if (output.engine !== 'orca' || output.jobIndex === null || !output.scientific?.tasks.includes('irc')) return null;
  const declared = output.scientific.relatedFiles?.filter(ref => ref.role === 'irc-full' || ref.role === 'irc-branch') ?? [];
  const wanted = new Map(declared.map(ref => [ref.sourceLine, ref]));
  const references: IrcOutputContext['references'] = [];
  for await (const line of outputLines(file, options, () => undefined)) {
    const ref = wanted.get(line.number); if (!ref) continue;
    const match = line.text.match(/^\s*Storing (full IRC|forward|backward) trajectory in\s*\.+\s+(\S+\.xyz)\s*$/i);
    if (match && match[2] === ref.name) references.push({ name: ref.name, sourceLine: line.number, role: /full/i.test(match[1]) ? 'irc-full' : /forward/i.test(match[1]) ? 'irc-forward' : 'irc-reverse' });
  }
  return references.length ? { outputId: output.id, output: { ...output, jobIndex: output.jobIndex }, references } : null;
}

/** Proven complete/partial native IRC geometry. A source OUT need not have any computed geometry. */
export async function bindIrcCompanion(context: IrcOutputContext, trajectory: TrajectoryResult, signal?: AbortSignal): Promise<TrajectoryResult | null> {
  assertResultNotAborted(signal);
  const output = context.output, data = output.scientific;
  if (!data || !data.tasks.includes('irc') || trajectory.engine !== 'xyz' || trajectory.source.software !== 'orca' || !trajectory.source.nativeJobName || !trajectory.frames.length) return null;
  const refs = context.references.filter(ref => stem(ref.name) === stem(trajectory.source.nativeJobName!));
  if (refs.length !== 1) return null;
  const ref = refs[0], rows = data.pathSummary?.filter(row => row.kind === 'irc');
  if (!rows?.length || rows.some(row => row.unit !== 'hartree' || row.energyReference === 'relative-to-ts' || !Number.isFinite(row.energy) || !Number.isFinite(row.energyRounding) || row.energyRounding <= 0)) return null;
  if (new Set(rows.map(row => row.sourceNode)).size !== rows.length || rows.some((row, i) => i > 0 && row.sourceNode !== rows[i - 1].sourceNode + 1)) return null;
  const ts = rows.flatMap((row, i) => row.isTs ? [i] : []);
  if (ts.length !== 1) return null;
  const tsIndex = ts[0], anchor = data.inputGeometry?.structure ?? output.initialStructure;
  if (!anchor?.atoms.length || !inventory(anchor, trajectory.initialStructure)) return null;
  // Native Full table is reverse endpoint -> TS -> forward endpoint. Branch
  // writer starts at the TS and follows its own direction, or omits the TS.
  const branch = ref.role === 'irc-forward' ? rows.slice(tsIndex + 1) : rows.slice(0, tsIndex).reverse();
  const candidates = ref.role === 'irc-full' ? [rows] : [[rows[tsIndex], ...branch], branch];
  const valid: typeof rows[] = [];
  for (const expected of candidates) {
    if (trajectory.frames.length > expected.length || trajectory.frames.length < expected.length && trajectory.status !== 'incomplete') continue;
    const prefix = expected.slice(0, trajectory.frames.length);
    const agrees = prefix.every((row, index) => {
      const frame = trajectory.frames[index], obs = frame.energyObservations?.find(item => item.kind === 'xyz-comment');
      if (frame.energy && !['Eh', 'Ha', 'hartree'].includes(frame.energy.unit)) return false;
      if (obs?.unit && !['Eh', 'Ha', 'hartree'].includes(obs.unit)) return false;
      const value = obs?.value ?? frame.unqualifiedEnergy ?? frame.energy?.value;
      const rounding = obs ? scientificRoundingInterval(obs.rawValue) : undefined;
      return value !== undefined && rounding !== undefined && Math.abs(value - row.energy) <= row.energyRounding + rounding + machineError(value, row.energy);
    });
    if (agrees) valid.push(prefix);
  }
  if (valid.length !== 1) return null;
  const mapping = valid[0], mappedTs = mapping.findIndex(row => row.isTs);
  for (let index = 0; index < trajectory.frames.length; index++) {
    const structure = await trajectory.getFrame(index, signal); assertResultNotAborted(signal);
    if (!inventory(anchor, structure)) return null;
    if (index === mappedTs && data.inputGeometry) {
      const a = data.inputGeometry.coordinateRoundingAngstrom, b = trajectory.frames[index].coordinateRoundingAngstrom;
      if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
      if (!structure.atoms.every((atom, i) => ['x', 'y', 'z'].every(axis => { const x = atom[axis as 'x'], y = anchor.atoms[i][axis as 'x']; return Math.abs(x - y) <= a + b + machineError(x, y); }))) return null;
    }
  }
  const complete = mapping.length === (ref.role === 'irc-full' ? rows.length : candidates.find(candidate => candidate[0] === mapping[0])?.length);
  const frames = trajectory.frames.map((frame, index) => {
    const row = mapping[index], direction = row.isTs ? 'ts' as const : row.sourceNode < rows[tsIndex].sourceNode ? 'reverse' as const : 'forward' as const;
    return { ...frame, geometrySource: { id: trajectory.source.id, name: trajectory.source.name, sourceFrameIndex: frame.sourceFrameIndex ?? frame.index, sourceLine: frame.sourceLine }, energy: { value: frame.unqualifiedEnergy ?? frame.energy!.value, unit: 'hartree' }, pathNode: row.sourceNode, pathDirection: direction, pathPoint: true, stageId: 'irc',
      coordinate: { value: row.sourceNode - rows[tsIndex].sourceNode, unit: 'step', label: '相对TS分支步数' } };
  });
  const science: ScientificData = { ...projectScientificFrames(data, frames.map(() => null)), source: { id: output.source.id, name: output.source.name },
    ircEvidence: { outputId: output.id, jobIndex: output.jobIndex, role: ref.role, complete, summaryNodes: mapping.map(row => row.sourceNode), ...(mappedTs >= 0 ? { tsFrameIndex: mappedTs } : {}), evidence: [`OUT原生引用源行${ref.sourceLine}`, '逐序原子及电子态无冲突', '有单位路径表与全部完整帧能量在各自打印精度内一致', '唯一原生TS标记'] } };
  // Initial SP/TS properties have no proven per-path-frame binding. They stay
  // in the owning OUT job, not in every trajectory frame's property view.
  science.summary = science.summary.filter(field => typeof field.value !== 'number' || !/energy/i.test(field.key));
  const initialStructure = structuredClone(trajectory.initialStructure); initialStructure.charge ??= anchor.charge; initialStructure.multiplicity ??= anchor.multiplicity;
  const result: TrajectoryResult = { ...trajectory, scientific: science, jobIndex: output.jobIndex, role: ref.role === 'irc-full' ? 'irc-full' : 'irc-branch', frames, stages: [{ id: 'irc', kind: 'irc', label: ref.role === 'irc-full' ? 'IRC' : ref.role === 'irc-forward' ? 'IRC正向' : 'IRC反向', frameIndices: frames.map(frame => frame.index), ...(mappedTs >= 0 ? { tsFrameIndex: mappedTs } : {}) }],
    initialStructure,
    status: complete ? output.status : 'incomplete', messages: [...trajectory.messages, `IRC配套已核对；${complete ? '所选角色完整' : '仅完整前缀'}，科学收敛仍按OUT分支状态。`],
    async getFrame(index, readSignal) { const structure = await trajectory.getFrame(index, readSignal); structure.charge ??= anchor.charge; structure.multiplicity ??= anchor.multiplicity; return structure; } };
  registerPreparedTrajectoryProjection(trajectory, result, frames.map((_, index) => index));
  return result;
}

/** Only two independently proven same-job opposite branches can form one path. */
export async function mergeIrcBranches(forward: TrajectoryResult, reverse: TrajectoryResult, signal?: AbortSignal): Promise<TrajectoryResult | null> {
  const a = forward.scientific?.ircEvidence, b = reverse.scientific?.ircEvidence;
  if (!a || !b || a.role !== 'irc-forward' || b.role !== 'irc-reverse' || a.outputId !== b.outputId || a.jobIndex !== b.jobIndex || a.tsFrameIndex === undefined || b.tsFrameIndex === undefined) return null;
  const tsA = await forward.getFrame(a.tsFrameIndex, signal), tsB = await reverse.getFrame(b.tsFrameIndex, signal);
  const tsRounding = (forward.frames[a.tsFrameIndex].coordinateRoundingAngstrom ?? 0) + (reverse.frames[b.tsFrameIndex].coordinateRoundingAngstrom ?? 0);
  if (!inventory(tsA, tsB) || !tsA.atoms.every((atom, i) => ['x', 'y', 'z'].every(axis => Math.abs(atom[axis as 'x'] - tsB.atoms[i][axis as 'x']) <= tsRounding + machineError(atom[axis as 'x'], tsB.atoms[i][axis as 'x'])))) return null;
  const ordered = [...reverse.frames.map((frame, index) => ({ frame, index, owner: reverse })).reverse(), ...forward.frames.flatMap((frame, index) => index === a.tsFrameIndex ? [] : [{ frame, index, owner: forward }])];
  const tsFrameIndex = ordered.findIndex(item => item.frame.pathDirection === 'ts');
  const initialStructure = await ordered[0].owner.getFrame(ordered[0].index, signal), atomIds = initialStructure.atoms.map(atom => atom.id);
  const result: TrajectoryResult = { ...forward, id: `${forward.id}:merged:${reverse.id}`, label: 'IRC双分支', role: 'irc-full', frames: ordered.map((item, index) => ({ ...item.frame, index, sourceFrameIndex: index })), stages: [{ id: 'irc', kind: 'irc', label: 'IRC双分支', frameIndices: ordered.map((_, index) => index), tsFrameIndex }],
    scientific: { ...forward.scientific!, ircEvidence: { ...a, role: 'irc-full', complete: a.complete && b.complete, summaryNodes: ordered.map(item => item.frame.pathNode!), tsFrameIndex, evidence: [...a.evidence, '同job双分支与共同TS核对'] } },
    initialStructure,
    async getFrame(index, readSignal) { assertResultNotAborted(readSignal); const item = ordered[index]; if (!item) throw Error('IRC帧越界。'); const structure = await item.owner.getFrame(item.index, readSignal); return { ...structure, atoms: structure.atoms.map((atom, ordinal) => ({ ...atom, id: atomIds[ordinal] })) }; },
    dispose() { /* Non-owning projection; both source attachments retain their leases. */ } };
  return result;
}
