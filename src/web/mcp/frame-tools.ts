import type { ModelDocument } from '../../modeling/contracts';
import type { Structure, Vector3 } from '../../core/types';
import { baseElectronicStateParameterError } from '../../core/base-electronic-state';
import { graphFingerprint } from '../../core/modeling/graph';
import { captureAdvancedFrame, type AdvancedFrameRef, type AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import type { ElectronicStateSourceContext } from '../../modeling/application/electronic-state-draft';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import type { ResultFrameSummary, TrajectoryRange, TrajectoryResult } from '../../results/contracts';
import { convertEnergy, type EnergyUnit } from '../../results/energy';
import type { PlaybackCollectionIdentity } from '../../results/playback-collection';
import { getPreparedTrajectoryFrame } from '../../results/prepared-trajectory';
import { playbackRange } from '../../results/playback';
import type { ResultByteSink, TrajectoryExportOrigin } from '../../results/export';
import { attachTrajectoryStages, projectScientificFrames } from '../../results/trajectory-stages';
import { captureWorkspaceAdvancedSource, captureWorkspaceElectronicSourceContext } from '../advanced/capture-source';
import type { AnalysisCanvas } from '../results/analysis-canvas';
import { exportWorkspaceTrajectoryData, scientificTrajectoryFormats, type ScientificTrajectoryFormat } from '../results/export-workspace';
import type { PublicTrajectoryPlaybackCommand } from '../results/trajectory-playback-bridge';
import { mcpBridge } from './bridge';
import { objectSchema as properties, toolError, type McCall, type McTool } from './types';

export interface FrameOwner {
  targetId: string;
  document: ModelDocument;
  documentEpoch: string;
  sourceEpoch: number | string;
  label: string;
  result?: TrajectoryResult;
  collection?: PlaybackCollectionIdentity;
  currentIndex?: number;
  outputJob?: AdvancedFrameRef['outputJob'];
  selectOutputJob?: boolean;
  advancedFrame?(index: number): AdvancedFrameSource | undefined;
}

export interface FrameToolContext {
  owner(targetId?: string, collectionId?: string): FrameOwner;
  prepareOwner?(targetId?: string, collectionId?: string, signal?: AbortSignal):
    { targetId: string; collectionId: string } | Promise<{ targetId: string; collectionId: string }> | void;
  captureCurrent(): Promise<AdvancedFrameSource>;
  extract(source: ElectronicStateSourceContext, label?: string): unknown;
  derive(result: TrajectoryResult): unknown;
  /** Route to the owned native player and read back its current state. */
  view(owner: FrameOwner, command?: PublicTrajectoryPlaybackCommand, requestId?: string, signal?: AbortSignal, waitFor?: 'selected' | 'scene'): unknown | Promise<unknown>;
}

type FrameIdentity = readonly [
  version: 'es-frame-v1', targetId: string, collectionId: string | null, index: number | null,
  documentId: string, documentEpoch: string, revision: number, sourceEpoch: number | string,
  resultId: string | null, sourceId: string | null, sourceSha256: string | null,
  jobIndex: number | null, outputJobId: string | null, outputJobSource: string | null,
  outputJobRevision: string | null, outputJobIndex: number | null, collectionRevision: string | null,
  frameIdentity: string | null,
];

function identity(owner: FrameOwner, index?: number): FrameIdentity {
  const { result, outputJob, collection } = owner;
  const frame = index === undefined ? undefined : result?.frames[index];
  if (result && !frame) throw Error('当前集合没有所选帧。');
  return ['es-frame-v1', owner.targetId, collection?.collectionId ?? result?.id ?? null, index ?? null,
    owner.document.id, owner.documentEpoch, owner.document.revision, owner.sourceEpoch,
    result?.id ?? null, result?.source.id ?? null, result?.source.sha256 ?? null, result?.jobIndex ?? null,
    outputJob?.id ?? null, outputJob?.sourceId ?? null, outputJob?.sourceRevision ?? null, outputJob?.index ?? null, collection?.revision ?? null,
    frame ? JSON.stringify([frame.index, frame.sourceFrameIndex, frame.stageId, frame.sourceLine, frame.geometrySource ?? null, frame.pesOrigin ?? null]) : null];
}

const nonempty = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${name} 需为非空字符串。`);
  return value;
};
const optionalText = (value: unknown, name: string) => value === undefined ? undefined : nonempty(value, name);
const frameIndex = (value: unknown, name: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error(`${name} 需为从 0 开始的整数。`);
  return value;
};
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} 需为对象。`);
  return value as Record<string, unknown>;
}
function rangeOf(value: unknown): TrajectoryRange {
  const range = record(value, 'range');
  const start = frameIndex(range.start, 'range.start'), end = frameIndex(range.end, 'range.end');
  const stride = range.stride === undefined ? 1 : frameIndex(range.stride, 'range.stride');
  if (!stride) throw Error('range.stride 需为正整数。');
  return { start, end, stride };
}

function descriptor(owner: FrameOwner, index?: number) {
  const result = owner.result, frame = index === undefined ? undefined : result?.frames[index];
  const advanced = index === undefined ? undefined : owner.advancedFrame?.(index)?.ref;
  const pes = frame?.pesOrigin;
  return {
    frameRef: JSON.stringify(identity(owner, index)), targetId: owner.targetId,
    documentId: owner.document.id, documentEpoch: owner.documentEpoch, revision: owner.document.revision,
    collectionId: owner.collection?.collectionId ?? result?.id ?? null, collectionRevision: owner.collection?.revision ?? null,
    index: index ?? null, frameNumber: index === undefined ? null : index + 1,
    sourceFrameIndex: frame?.sourceFrameIndex ?? index ?? null,
    frameId: pes?.frameId ?? advanced?.frameId ?? (result && index !== undefined ? `${result.id}:${frame?.sourceFrameIndex??index}` : null),
    taskId: pes?.taskId ?? advanced?.taskId ?? null, runId: pes?.runId ?? advanced?.runId ?? null,
    groupId: pes?.groupId ?? null, nodeId: pes?.nodeId ?? null, recordId: pes?.recordId ?? null, seriesId: pes?.seriesId ?? null,
    pesOrigin: pes ?? null,
    stageId: frame?.stageId ?? owner.collection?.stageId ?? null, sourceStep: frame?.sourceStep ?? null,
    source: result?.source ?? null, jobIndex: result?.jobIndex ?? null, outputJob: owner.outputJob ?? null,
    geometrySource: frame?.geometrySource ?? null, sourceLine: frame?.sourceLine ?? null,
    energy: frame?.energy ?? null, energyQuantity: frame?.energyQuantity ?? null,
    time: frame?.time ?? null, label: frame?.label ?? owner.label,
  };
}

function indicesForFrameIds(owner: FrameOwner, frameIds: readonly string[], seriesId?: string) {
  const result = owner.result;
  if (!result) throw Error('当前模型没有轨迹集合。');
  const byId = new Map<string, number | null>();
  result.frames.forEach((frame, index) => {
    if (seriesId && frame.pesOrigin?.seriesId !== seriesId) return;
    const id = frame.pesOrigin?.frameId ?? owner.advancedFrame?.(index)?.ref.frameId ?? `${result.id}:${frame.sourceFrameIndex ?? index}`;
    byId.set(id, byId.has(id) ? null : index);
  });
  return frameIds.map(id => {
    const index = byId.get(id);
    if (index === undefined || index === null) {
      const collectionId = owner.collection?.collectionId ?? result.id;
      throw toolError('frame_id_conflict', `指定集合中没有唯一帧 ${id}，请核对来源和 seriesId。`, {
        targetId: owner.targetId, collectionId, frameId: id, seriesId, committed: false,
        reason: index === null ? 'ambiguous-native-frame-id' : 'native-frame-id-not-in-collection',
        recovery: { tool: 'frames_select', arguments: { targetId: owner.targetId, collectionId, limit: 20 } },
      });
    }
    return index;
  });
}

function selectedIndices(owner: FrameOwner, args: Record<string, unknown>): number[] {
  if (!owner.result) return [];
  const result = owner.result;
  const stageId = optionalText(args.stageId, 'stageId');
  const stage = stageId && attachTrajectoryStages(result).stages?.find(value => value.id === stageId);
  const stageFrames = stageId ? stage ? stage.frameIndices : result.frames.flatMap((frame, index) => frame.stageId === stageId ? [index] : []) : undefined;
  if (stageId && !stageFrames?.length) throw Error('当前来源没有指定阶段。');
  if ([args.indices, args.range, args.frameIds].filter(value => value !== undefined).length > 1)
    throw Error('请使用 indices、range 或 frameIds 指定帧。');
  let indices: number[];
  const seriesId = optionalText(args.seriesId, 'seriesId');
  if (args.frameIds !== undefined) {
    if (!Array.isArray(args.frameIds)) throw Error('frameIds 需为原生帧引用数组。');
    indices = indicesForFrameIds(owner, args.frameIds.map(id => nonempty(id, 'frameIds')), seriesId);
  } else if (args.indices !== undefined) {
    if (!Array.isArray(args.indices)) throw Error('indices 需为帧索引数组。');
    indices = args.indices.map(index => frameIndex(index, 'indices'));
  } else if (args.range !== undefined) {
    const { start, end, stride } = rangeOf(args.range);
    if (!result.frames[start] || !result.frames[end]) throw Error('范围端点超出当前集合。');
    const direction = start <= end ? 1 : -1;
    indices = Array.from({ length: Math.floor(Math.abs(end - start) / stride) + 1 }, (_, position) => start + position * stride * direction);
  } else indices = stageFrames ? [...stageFrames] : result.frames.map((_frame, index) => index);
  if (indices.some(index => !result.frames[index]) || new Set(indices).size !== indices.length)
    throw Error('帧索引须存在且不得重复。');
  if (stageFrames && (args.indices !== undefined || args.range !== undefined || args.frameIds !== undefined)) {
    const members = new Set(stageFrames);
    indices = indices.filter(index => members.has(index));
  }
  if (seriesId && args.frameIds === undefined) indices = indices.filter(index => result.frames[index].pesOrigin?.seriesId === seriesId);
  const order = args.order ?? 'selection';
  if (!['selection', 'source', 'energy-ascending', 'energy-descending'].includes(order as string)) throw Error('帧顺序无效。');
  if (order === 'source') indices.sort((a, b) => a - b);
  return indices;
}

const units = ['hartree', 'eV', 'kJ/mol', 'kcal/mol'] as const;
function selection(owner: FrameOwner, args: Record<string, unknown>) {
  const indices = selectedIndices(owner, args);
  const offset=args.offset===undefined?0:frameIndex(args.offset,'offset');
  const limit=args.limit===undefined?undefined:frameIndex(args.limit,'limit');
  if(limit===0)throw Error('limit 需要大于零。');
  if (!owner.result && (args.indices !== undefined || args.range !== undefined || args.frameIds !== undefined || args.stageId !== undefined || args.seriesId !== undefined))
    throw Error('当前模型没有轨迹集合。');
  const requested = optionalText(args.order, 'order') ?? 'selection';
  const energyFilter = args.energy === undefined ? undefined : record(args.energy, 'energy');
  const energySort = requested === 'energy-ascending' || requested === 'energy-descending';
  if (!owner.result) {
    const available = owner.document.draft.structure.atoms.length > 0;
    return { frames: !energyFilter && available && offset===0 ? [descriptor(owner)] : [], total:!energyFilter&&available?1:0, nextOffset:null, excludedMissingEnergy: energyFilter && available ? 1 : 0 };
  }
  let ranked = indices.map(index => ({ index, energy: null as number | null }));
  let excludedMissingEnergy = 0;
  if (energyFilter || energySort) {
    const unit = energyFilter?.unit ?? 'hartree';
    if (!units.includes(unit as EnergyUnit)) throw Error('能量单位无效。');
    const min = energyFilter?.min, max = energyFilter?.max, quantity = energyFilter?.quantity;
    if ((min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) ||
        (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) ||
        (typeof min === 'number' && typeof max === 'number' && min > max)) throw Error('能量范围无效。');
    if (quantity !== undefined && quantity !== 'electronic' && quantity !== 'potential') throw Error('能量类型无效。');
    const frames = owner.result.frames;
    const quantities = new Set(ranked.flatMap(({index}) => frames[index].energy ? [frames[index].energyQuantity ?? 'unspecified'] : []));
    if (quantity === undefined && quantities.size > 1) throw Error('当前集合的能量类型不同，请明确 energy.quantity。');
    ranked = ranked.flatMap(({index}) => {
      const frame = frames[index];
      if (quantity !== undefined && frame.energyQuantity !== quantity) return [];
      const energy = convertEnergy(frame.energy, unit as EnergyUnit);
      if (energy === null && energyFilter) { excludedMissingEnergy++; return []; }
      if (energy !== null && (typeof min === 'number' && energy < min || typeof max === 'number' && energy > max)) return [];
      return [{ index, energy }];
    });
    if (energySort) ranked.sort((a, b) => a.energy === null ? b.energy === null ? 0 : 1 : b.energy === null ? -1
      : (a.energy - b.energy) * (requested === 'energy-descending' ? -1 : 1));
  }
  const selected=ranked.slice(offset,limit===undefined?undefined:offset+limit);
  return { frames: selected.map(({ index }) => descriptor(owner, index)), total:ranked.length, nextOffset:offset+selected.length<ranked.length?offset+selected.length:null, excludedMissingEnergy };
}

function stageSubset(result: TrajectoryResult, indices: readonly number[]) {
  const mapping = new Map(indices.map((index, position) => [index, position]));
  return attachTrajectoryStages(result).stages?.flatMap(stage => {
    const members = new Set(stage.frameIndices);
    const frameIndices = indices.flatMap((index, position) => members.has(index) ? [position] : []);
    if (!frameIndices.length) return [];
    const tsFrameIndex = stage.tsFrameIndex === undefined ? undefined : mapping.get(stage.tsFrameIndex);
    const ciFrameIndex = stage.ciFrameIndex === undefined ? undefined : mapping.get(stage.ciFrameIndex);
    return [{ ...stage, frameIndices, tsFrameIndex, ciFrameIndex }];
  });
}

/** Materialize selected raw frames once so an independently opened result outlives the source reader. */
async function deriveResult(result: TrajectoryResult, indices: readonly number[], assertCurrent: () => void, label?: string, signal?: AbortSignal): Promise<TrajectoryResult> {
  const structures: Structure[] = [];
  for (const index of indices) {
    assertCurrent();
    const retained = getPreparedTrajectoryFrame(result, index)?.raw;
    const structure = structuredClone(retained ?? await result.getFrame(index, signal));
    if (!structure.atoms.length || structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite)))
      throw Error(`帧 ${index} 缺少完整坐标。`);
    structures.push(structure);
  }
  assertCurrent();
  const frames: ResultFrameSummary[] = indices.map((source, index) => {
    const summary = structuredClone(result.frames[source]);
    const sourceFrameIndex = summary.sourceFrameIndex ?? source;
    return { ...summary, index, sourceFrameIndex,
      geometrySource: summary.geometrySource ?? { id: result.source.id, name: result.source.name, sourceFrameIndex, sourceLine: summary.sourceLine } };
  });
  return {
    ...result, id: `derived-${crypto.randomUUID()}`, label: label ?? `${result.label} · 派生轨迹`,
    frames, stages: stageSubset(result, indices), initialStructure: structures[0],
    scientific: result.scientific ? projectScientificFrames(result.scientific, indices) : undefined,
    async getFrame(index, signal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(index) || !structures[index]) throw Error('派生轨迹帧索引超出范围。');
      return structuredClone(structures[index]);
    },
    dispose() { structures.length = 0; },
  };
}

function captureParameters(owner: FrameOwner, index: number | undefined, guard: () => void, signal?: AbortSignal) {
  return { document: owner.document, documentEpoch: owner.documentEpoch, label: owner.label, result: owner.result, frameIndex: index, guard, signal };
}
function sourced<T extends ElectronicStateSourceContext>(source: T, owner: FrameOwner, index?: number): T {
  const outputJob = source.ref.outputJob ?? (owner.outputJob ? Object.freeze({ ...owner.outputJob }) : undefined);
  const stageId = source.ref.stageId ?? owner.collection?.stageId;
  const pes = index === undefined ? undefined : owner.result?.frames[index]?.pesOrigin;
  return outputJob !== source.ref.outputJob || stageId !== source.ref.stageId || pes
    ? Object.freeze({ ...source, ref: Object.freeze({ ...source.ref, outputJob, stageId,
      ...(pes ? { frameId: pes.frameId, runId: pes.runId, pesOrigin: Object.freeze({ ...pes }) } : {}) }) }) : source;
}
const frameFields = ['version', 'targetId', 'collectionId', 'index', 'documentId', 'documentEpoch', 'revision',
  'sourceEpoch', 'resultId', 'sourceId', 'sourceSha256', 'jobIndex', 'outputJobId', 'outputJobSource',
  'outputJobRevision', 'outputJobIndex', 'collectionRevision', 'frameIdentity'] as const;
function frameSelection(targetId: string, collectionId?: string, index?: number) {
  return { tool: 'frames_select', arguments: { targetId, ...(collectionId === undefined ? {} : { collectionId }),
    ...(index === undefined ? {} : { indices: [index] }) } };
}
function invalidFrameRef(reason: string, parsed?: unknown[]) {
  const targetId = typeof parsed?.[1] === 'string' && parsed[1] ? parsed[1] : undefined;
  const collectionId = typeof parsed?.[2] === 'string' && parsed[2] ? parsed[2] : undefined;
  return toolError('invalid_frame_ref', '帧引用的格式有误，请原样使用工具返回的完整 frameRef。', {
    reason, committed: false, recovery: targetId ? frameSelection(targetId, collectionId) : { tool: 'es_targets', arguments: { kind: 'collection' } },
  });
}
export function isFrameReference(ref: string) {
  return /^\s*\[\s*"es-frame(?:-v\d+)?"/.test(ref);
}
function frameReference(ref: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(ref); } catch { throw invalidFrameRef('invalid-json'); }
  if (!Array.isArray(parsed)) throw invalidFrameRef('invalid-shape');
  const stringAt = (position: number, nullable = false) => nullable && parsed[position] === null ||
    typeof parsed[position] === 'string' && Boolean(parsed[position].trim());
  const indexAt = (position: number, nullable = false) => nullable && parsed[position] === null ||
    Number.isSafeInteger(parsed[position]) && parsed[position] >= 0;
  if (parsed.length !== frameFields.length || parsed[0] !== 'es-frame-v1' ||
    ![1, 4, 5].every(position => stringAt(position)) ||
    ![2, 8, 9, 10, 12, 13, 14, 16, 17].every(position => stringAt(position, true)) ||
    ![3, 11, 15].every(position => indexAt(position, true)) ||
    !indexAt(6) || !(stringAt(7) || indexAt(7)) ||
    (parsed[2] === null) !== (parsed[3] === null) || (parsed[3] === null) !== (parsed[17] === null))
    throw invalidFrameRef('invalid-identity', parsed);
  const targetId: string = parsed[1], collectionId: string | undefined = parsed[2] ?? undefined;
  const index: number | undefined = parsed[3] ?? undefined;
  return { targetId, collectionId, index, parsed };
}

async function prepareFrameReference(context: FrameToolContext, ref: string, signal?: AbortSignal) {
  if (!context.prepareOwner) return;
  const { targetId, collectionId } = frameReference(ref);
  await context.prepareOwner(targetId, collectionId, signal);
}

function rawFrame(context: FrameToolContext, ref: string) {
  const { targetId, collectionId, index, parsed } = frameReference(ref);
  function conflict(reason: string, fields?: string[], current?: FrameOwner) {
    const available = current?.result && index !== undefined && current.result.frames[index];
    return toolError('frame_ref_conflict', '选定帧的文档、来源或集合已经变化，请重新选择。', {
      targetId, collectionId, index, reason, fields, committed: false,
      recovery: current ? frameSelection(targetId, collectionId, available ? index : undefined)
        : {tool: 'es_targets', arguments: {kind: 'collection'}},
    });
  }
  const resolve = () => {
    try { return context.owner(targetId, collectionId); }
    catch (error) { throw conflict(error instanceof Error ? error.message : 'owner-unavailable'); }
  };
  const owner = resolve();
  const guard = () => {
    const current = resolve();
    if (current.result ? index === undefined || !current.result.frames[index] : index !== undefined)
      throw conflict('frame-unavailable', undefined, current);
    const actual = identity(current, index);
    const fields = frameFields.filter((_field, position) => actual[position] !== parsed[position]);
    if (fields.length) throw conflict('identity-changed', fields, current);
  };
  guard();
  return { owner, index, guard };
}

function ownerArguments(args: Record<string, unknown>) {
  if (args.targetId !== undefined && args.targetRef !== undefined) throw Error('请用 targetId 或 targetRef 指定轨迹归属。');
  return { targetId: optionalText(args.targetId ?? args.targetRef, 'targetRef'), collectionId: optionalText(args.collectionId, 'collectionId') };
}
function argsOwner(context: FrameToolContext, args: Record<string, unknown>) {
  const { targetId, collectionId } = ownerArguments(args);
  return context.owner(targetId, collectionId);
}
function prepareArgsOwner(context: FrameToolContext, args: Record<string, unknown>, signal?: AbortSignal) {
  const { targetId, collectionId } = ownerArguments(args);
  return context.prepareOwner?.(targetId, collectionId, signal);
}

async function readScientificFrame(context: FrameToolContext, ref: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await prepareFrameReference(context, ref, signal);
  const { owner, index, guard } = rawFrame(context, ref);
  const owned = index === undefined ? undefined : owner.advancedFrame?.(index);
  const source = owned ?? await captureWorkspaceElectronicSourceContext(captureParameters(owner, index, guard, signal));
  guard();
  signal?.throwIfAborted();
  return { source: owned ?? sourced(source, owner, index), descriptor: descriptor(owner, index), guard };
}

/** Observe raw coordinates without preparing a display graph or creating a model. */
async function readFrame(context: FrameToolContext, ref: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await prepareFrameReference(context, ref, signal);
  const { owner, index, guard } = rawFrame(context, ref);
  const result = owner.result;
  const structure = result && index !== undefined
    ? getPreparedTrajectoryFrame(result, index)?.raw ?? await result.getFrame(index, signal)
    : owner.document.draft.structure;
  guard();
  signal?.throwIfAborted();
  return { frame: descriptor(owner, index), coordinateUnit: 'angstrom' as const, structure: structuredClone(structure) };
}

export function confirmFrameElectronicState(
  source: ElectronicStateSourceContext & Pick<AdvancedFrameSource, 'sourceElectronicState' | 'protection' | 'samplingPreparation'>,
  electronic: { charge: number; multiplicity: number },
): AdvancedFrameSource {
  const structure = { ...source.structure, charge: electronic.charge, multiplicity: electronic.multiplicity };
  const invalid = baseElectronicStateParameterError(structure, electronic);
  if (invalid) throw Error(invalid);
  const stamp = { ...source.stamp, graphFingerprint: graphFingerprint(structure) };
  const confirmed = captureAdvancedFrame(structure, source.ref, stamp, source.label, source.constraints);
  const sourceElectronicState = source.sourceElectronicState ?? {
    charge: source.structure.charge ?? null, multiplicity: source.structure.multiplicity ?? null,
  };
  return Object.freeze({
    ...confirmed, sourceElectronicState: Object.freeze({ ...sourceElectronicState }),
    ...(source.protection ? { protection: source.protection } : {}),
    ...(source.samplingPreparation ? { samplingPreparation: source.samplingPreparation } : {}),
  });
}

export interface FrameAccess {
  context(): FrameToolContext;
  current(owner: FrameOwner): ReturnType<typeof descriptor> | null;
  describe(owner: FrameOwner, index?: number): ReturnType<typeof descriptor>;
  reference(frameRef: string, signal?: AbortSignal): Promise<{owner: FrameOwner; index?: number; guard(): void}>;
  readAdvancedFrame(frameRef?: string, signal?: AbortSignal, electronic?: { charge: number; multiplicity: number }): Promise<AdvancedFrameSource>;
  readScientificFrame(frameRef: string, signal?: AbortSignal): Promise<ElectronicStateSourceContext>;
  readFrame(frameRef: string, signal?: AbortSignal): ReturnType<typeof readFrame>;
}
export function createFrameAccess(getContext: () => FrameToolContext): FrameAccess {
  const context = (): FrameToolContext => ({ ...getContext(), owner: (...args) => getContext().owner(...args) });
  const access: FrameAccess = {
    context,
    describe: descriptor,
    readFrame: (frameRef, signal) => readFrame(context(), frameRef, signal),
    async reference(frameRef, signal) {
      const ctx = context();
      await prepareFrameReference(ctx, frameRef, signal);
      signal?.throwIfAborted();
      return rawFrame(ctx, frameRef);
    },
    current: owner => owner.result
      ? owner.currentIndex === undefined ? null : descriptor(owner, owner.currentIndex)
      : owner.document.draft.structure.atoms.length ? descriptor(owner) : null,
    async readScientificFrame(frameRef, signal) {
      return (await readScientificFrame(context(), frameRef, signal)).source;
    },
    async readAdvancedFrame(frameRef, signal, electronic) {
      signal?.throwIfAborted();
      const ctx = context();
      if (electronic !== undefined) {
        const ref = frameRef ?? access.current(ctx.owner())?.frameRef;
        if (!ref) throw Error('当前目标缺少可确认电子态的科学几何。');
        const frame = await readScientificFrame(ctx, ref, signal);
        frame.guard();
        signal?.throwIfAborted();
        return confirmFrameElectronicState(frame.source, electronic);
      }
      if (frameRef === undefined) return ctx.captureCurrent();
      await prepareFrameReference(ctx, frameRef, signal);
      const { owner, index, guard } = rawFrame(ctx, frameRef);
      const owned = index === undefined ? undefined : owner.advancedFrame?.(index);
      if (owned) return owned;
      const source = await captureWorkspaceAdvancedSource(captureParameters(owner, index, guard, signal));
      return sourced(source, owner, index);
    },
  };
  return access;
}

const string = { type: 'string', minLength: 1 };
const index = { type: 'integer', minimum: 0 };
const ownerProperties = { targetId: string, targetRef: string, collectionId: string };
const rangeProperties = properties({ start: index, end: index, stride: { type: 'integer', minimum: 1 } }, ['start', 'end']);
const filterProperties = {
  indices: { type: 'array', items: index, uniqueItems: true },
  frameIds: { type: 'array', items: string, minItems: 1, uniqueItems: true },
  range: rangeProperties,
  stageId: string,
  seriesId: string,
  order: { enum: ['selection', 'source', 'energy-ascending', 'energy-descending'] },
  energy: properties({ unit: { enum: units }, quantity: { enum: ['electronic', 'potential'] }, min: { type: 'number' }, max: { type: 'number' } }),
};
const referenceSelection = { frameRefs: { type: 'array', items: string, minItems: 1, uniqueItems: true } };
const measurementSchema = properties({
  id: string, atomIds: { type: 'array', items: string, minItems: 2, maxItems: 4 },
  images: { type:'array', minItems: 2, maxItems: 4,
    items: { type:'array', minItems: 3, maxItems: 3, items: { type:'integer' } } },
}, ['atomIds']);

async function selectedTrajectory(ctx: FrameToolContext, args: Record<string, unknown>, signal?: AbortSignal) {
  if (args.frameRefs !== undefined && (!Array.isArray(args.frameRefs) || !args.frameRefs.length
    || [...Object.keys(ownerProperties), ...Object.keys(filterProperties)].some(key => args[key] !== undefined))) throw Error('请单独提供明确的 frameRefs，或按所属集合筛选。');
  const refs = Array.isArray(args.frameRefs) ? args.frameRefs.map(ref => nonempty(ref, 'frameRefs')) : undefined;
  if (refs?.length) await prepareFrameReference(ctx, refs[0], signal);
  const prepared = refs ? undefined : await prepareArgsOwner(ctx, args, signal);
  const selected = refs?.map(ref => rawFrame(ctx, ref));
  const owner = selected?.[0]?.owner ?? (prepared ? ctx.owner(prepared.targetId, prepared.collectionId) : argsOwner(ctx, args)), result = owner.result;
  if (!result) throw Error('当前模型没有轨迹集合。');
  const version = (target: FrameOwner) => JSON.stringify(identity(target, 0).slice(4, -1));
  const baseline = version(owner);
  if (selected?.some(item => item.index === undefined || !item.owner.result || item.owner.targetId !== owner.targetId || version(item.owner) !== baseline))
    throw Error('明确帧引用须来自同一集合版本。');
  const indices = selected?.map(item => item.index!) ?? selection(owner, args).frames.map(frame => frame.index!);
  if (!indices.length || new Set(indices).size !== indices.length) throw Error('请选择至少一个不同的有效来源帧。');
  const collectionId = owner.collection?.collectionId ?? result.id;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (version(ctx.owner(owner.targetId, collectionId)) !== baseline) throw Error('读取期间轨迹来源或集合版本已变化。');
  };
  return { owner, result, indices, collectionId, assertCurrent };
}

function geometryOrigin(result: TrajectoryResult, source: number) {
  const frame = result.frames[source], sourceFrameIndex = frame.sourceFrameIndex ?? source;
  return frame.geometrySource ?? { id: result.source.id, name: result.source.name, sourceFrameIndex, sourceLine: frame.sourceLine };
}

/** Borrow the exact scientific reader during export. Raw coordinates are read one frame at a time. */
function exportSelection(picked: Awaited<ReturnType<typeof selectedTrajectory>>, format: ScientificTrajectoryFormat) {
  const { owner, result, indices, assertCurrent } = picked;
  const origins: TrajectoryExportOrigin[] = indices.map(index => ({
    resultFrameIndex: index, sourceFrameIndex: result.frames[index].sourceFrameIndex ?? index,
    stageId: result.frames[index].stageId ?? owner.collection?.stageId, geometrySource: geometryOrigin(result, index),
    outputJob: owner.outputJob, pesOrigin: result.frames[index].pesOrigin,
  }));
  const projection: TrajectoryResult = {
    ...result,
    frames: indices.map((source, index) => ({
      ...result.frames[source], index, sourceFrameIndex: origins[index].sourceFrameIndex, geometrySource: origins[index].geometrySource,
    })),
    scientific: result.scientific && (format === 'txt' || format === 'txt-json') ? projectScientificFrames(result.scientific, indices) : undefined,
    async getFrame(index, signal) {
      assertCurrent();
      const source = indices[index];
      const structure = getPreparedTrajectoryFrame(result, source)?.raw ?? await result.getFrame(source, signal);
      assertCurrent();
      return structure;
    },
    dispose() {},
  };
  return { origins, projection, range: { start: 0, end: indices.length - 1, stride: 1 } };
}

async function inlineTrajectory(blob: Blob, format: ScientificTrajectoryFormat) {
  if (format !== 'txt-json') return { encoding: 'utf-8', data: await blob.text(), byteLength: blob.size };
  const parts: string[] = [], chunk = 3 * 4096; // Only the final segment may contain base64 padding.
  for (let offset = 0; offset < blob.size; offset += chunk) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunk).arrayBuffer());
    parts.push(btoa(String.fromCharCode(...bytes)));
  }
  return { encoding: 'base64', data: parts.join(''), byteLength: blob.size };
}

async function deliverTrajectory(
  produce: (sink?: ResultByteSink) => Promise<{ blob: Blob; filename: string }>,
  assertCurrent: () => void, call: McCall | undefined, defaultDestination: boolean,
) {
  const bridge = typeof window === 'undefined' ? undefined : mcpBridge(), desktop = typeof window === 'undefined' ? undefined : window.sciyueDesktop;
  if (!bridge || !call) throw Error('当前连接没有原生文件交付入口。');
  const request = { requestId: call.requestId, ...(call.batchIndex === undefined ? {} : { batchIndex: call.batchIndex }) };
  const publicationStatus = (delivery: unknown) =>
    delivery && typeof delivery === 'object' && 'status' in delivery && delivery.status === 'publication_unconfirmed'
      ? 'publication_unconfirmed' : 'exported';
  if (!desktop?.beginBinaryAsset || !desktop.appendBinaryAsset || !desktop.sealBinaryAsset || !desktop.releaseBinaryAsset) {
    const { blob, filename } = await produce();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assertCurrent();
    const delivery = await bridge.file({ ...request, action: 'write', bytes, ...(defaultDestination ? {fileName: filename} : {}) });
    return { status: publicationStatus(delivery), filename, mimeType: blob.type, byteLength: blob.size, delivery };
  }
  assertCurrent();
  const { id } = await desktop.beginBinaryAsset();
  const buffer = new Uint8Array(1024 * 1024);
  let size = 0, buffered = 0;
  const flush = async () => {
    if (!buffered) return;
    assertCurrent();
    size += buffered;
    if ((await desktop.appendBinaryAsset!(id, buffer.subarray(0, buffered))).size !== size) throw Error('轨迹暂存字节数不一致。');
    buffered = 0;
  };
  const sink: ResultByteSink = {
    async write(data) {
      const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]);
      for (let offset = 0; offset < blob.size;) {
        assertCurrent();
        const end = Math.min(blob.size, offset + buffer.length - buffered);
        const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        assertCurrent();
        buffer.set(bytes, buffered);
        buffered += bytes.length;
        offset = end;
        if (buffered === buffer.length) await flush();
      }
    },
    close: flush,
    async abort() {},
  };
  let receipt: {status:string;filename:string;mimeType:string;byteLength:number;delivery:unknown};
  let cleanupWarning: string | undefined;
  try {
    const { blob, filename } = await produce(sink);
    if (blob.size) await sink.write(blob);
    await sink.close();
    assertCurrent();
    const sealed = await desktop.sealBinaryAsset(id);
    if (sealed.size !== size || !sealed.sha256) throw Error('轨迹暂存校验失败。');
    assertCurrent();
    const delivery = await bridge.file({ ...request, action: 'write-export', assetId: id, ...(defaultDestination ? {fileName: filename} : {}) });
    receipt={status:publicationStatus(delivery),filename,mimeType:blob.type,byteLength:size,delivery};
  } finally {
    try{await desktop.releaseBinaryAsset(id);}
    catch(error){cleanupWarning=error instanceof Error?error.message:String(error);}
  }
  return {...receipt,...(cleanupWarning?{cleanupWarning}:{})};
}

function viewCommand(args: Record<string, unknown>, frame?: number): PublicTrajectoryPlaybackCommand | undefined {
  const action = args.action ?? (frame === undefined ? 'status' : 'seek');
  if (frame !== undefined && action !== 'seek') throw Error('帧引用或索引仅用于 seek。');
  if (action === 'status') return undefined;
  if (action === 'seek') return { action, index: frameIndex(frame, 'index') };
  if (action === 'play' || action === 'pause' || action === 'prepare' || action === 'cancel-preparation') return { action };
  if (action === 'range') return { action, range: rangeOf(args.range) };
  if (action === 'direction' || action === 'step') {
    if (args.direction !== 1 && args.direction !== -1) throw Error('播放方向须为 1 或 -1。');
    return { action, direction: args.direction };
  }
  if (action === 'mode') {
    const mode = args.mode;
    if (mode !== 'once' && mode !== 'loop' && mode !== 'bounce') throw Error('播放模式无效。');
    return { action, mode };
  }
  if (action === 'fps') {
    const value = args.fps;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isFinite(1000 / value)) throw Error('播放速度无效。');
    return { action, value };
  }
  throw Error('轨迹操作无效。');
}

export function frameTools(access: FrameAccess): McTool[] {
  return [
    {
      name: 'frames_select',
      description: 'Get stable scientific frame references from a model or trajectory. Select native frameIds or zero-based indices/range in the named collection. frameNumber is the one-based number within that collection. Copy frameRef verbatim for the next operation. Energy sorting is stable with missing values last.',
      inputSchema: properties({ ...ownerProperties, ...filterProperties,offset:index,limit:{type:'integer',minimum:1} }),
      call(args, call) {
        const ctx = access.context();
        const finish = (target?: {targetId: string; collectionId: string}) => {
          const owner = target ? ctx.owner(target.targetId, target.collectionId) : argsOwner(ctx, args);
          const selected = selection(owner, args);
          return { targetId: owner.targetId, collectionId: owner.collection?.collectionId ?? owner.result?.id ?? null,
          current: access.current(owner), ...selected };
        };
        const prepared = prepareArgsOwner(ctx, args, call?.signal);
        return prepared instanceof Promise ? prepared.then(finish) : finish(prepared || undefined);
      },
    },
    {
      name: 'frame_extract',
      description: 'Extract an immutable scientific frame as a new editable model. Uses raw geometry, periodic cell, atom identities and compatible constraints; a frame reference is returned by frames_select.',
      inputSchema: properties({ frameRef: string, label: string }, ['frameRef']),
      async call(args, call) {
        call?.signal.throwIfAborted();
        const ctx = access.context();
        const ref = nonempty(args.frameRef, 'frameRef'), label = optionalText(args.label, 'label');
        const frame = await readScientificFrame(ctx, ref, call?.signal);
        frame.guard();
        call?.signal.throwIfAborted();
        return { source: frame.descriptor, extracted: await access.context().extract(frame.source, label) };
      },
    },
    {
      name: 'frame_read',
      description: 'Read an exact scientific frame by frameRef. Returns original Cartesian coordinates, atom identities, cell and provenance without changing the open views.',
      inputSchema: properties({ frameRef: string }, ['frameRef']),
      call(args, call) { return access.readFrame(nonempty(args.frameRef, 'frameRef'), call?.signal); },
    },
    {
      name: 'frame_measure',
      description: 'Measure one or more ordered distances, angles or dihedrals in one exact frame. Measurements share an original geometry read and return independently. Use batch_apply for multiple frames.',
      inputSchema: properties({ frameRef: string, measurements: { type: 'array', items: measurementSchema, minItems: 1 } }, ['frameRef', 'measurements']),
      async call(args, call) {
        const { frame, structure, coordinateUnit } = await access.readFrame(nonempty(args.frameRef, 'frameRef'), call?.signal);
        if (!Array.isArray(args.measurements) || !args.measurements.length) throw Error('请选择至少一项测量。');
        const measurements = args.measurements.map((item, index) => {
          let id: string | undefined;
          try {
            const row = record(item, 'measurement');
            id = optionalText(row.id, 'measurement.id');
            if (!Array.isArray(row.atomIds)) throw Error('请选择有序原子 ID。');
            const atomIds = row.atomIds.map(value => nonempty(value, 'atomIds'));
            const images = row.images as Vector3[] | undefined;
            const measured = confirmCoordinateSelection(structure, atomIds, images);
            return { index, id, status: 'measured', ...measured, ...(images ? { images } : {}) };
          } catch (error) {
            return { index, id, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
          }
        });
        const count = measurements.filter(item => item.status === 'measured').length;
        return { status: count === measurements.length ? 'measured' : count ? 'partial' : 'failed', frame, coordinateUnit, measurements };
      },
    },
    {
      name: 'trajectory_view',
      description: 'Read or command the native trajectory player. Seek via frameRef, native frameId, zero-based index or one-based frameNumber in the named collection. The response separates pending reads, native player frame number and viewport submission.',
      inputSchema: properties({ ...ownerProperties, frameRef: string, frameId: string, seriesId: string, index, frameNumber: { type: 'integer', minimum: 1 }, requestId: string, waitFor: { enum: ['selected', 'scene'] },
        action: { enum: ['status', 'seek', 'play', 'pause', 'prepare', 'cancel-preparation', 'step', 'direction', 'mode', 'range', 'fps'] },
        range: rangeProperties, direction: { enum: [-1, 1] }, mode: { enum: ['once', 'loop', 'bounce'] }, fps: { type: 'number', exclusiveMinimum: 0 } }),
      async call(args, call) {
        call?.signal.throwIfAborted();
        const ctx = access.context();
        const ref = optionalText(args.frameRef, 'frameRef');
        const requestId = optionalText(args.requestId, 'requestId');
        if (ref && (args.targetId !== undefined || args.targetRef !== undefined || args.collectionId !== undefined ||
          args.index !== undefined || args.frameNumber !== undefined || args.frameId !== undefined || args.seriesId !== undefined))
          throw Error('frameRef 已指定具体帧及归属。');
        if ([args.frameId, args.index, args.frameNumber].filter(value => value !== undefined).length > 1)
          throw Error('请指定 frameId、index 或 frameNumber 中的一项。');
        if (args.seriesId !== undefined && args.frameId === undefined) throw Error('定位指定 seriesId 时须传入 frameId。');
        if (ref) await prepareFrameReference(ctx, ref, call?.signal);
        const prepared = ref ? undefined : await prepareArgsOwner(ctx, args, call?.signal);
        const resolved = ref ? rawFrame(ctx, ref) : undefined;
        const owner = resolved?.owner ?? (prepared ? ctx.owner(prepared.targetId, prepared.collectionId) : argsOwner(ctx, args));
        if (!owner.result) throw Error('当前模型没有轨迹播放器。');
        const requestedNumber = args.frameNumber === undefined ? undefined : frameIndex(args.frameNumber, 'frameNumber');
        if (requestedNumber === 0) throw Error('frameNumber 需为从 1 开始的帧号。');
        const frame = resolved?.index ?? (args.frameId !== undefined
          ? indicesForFrameIds(owner, [nonempty(args.frameId, 'frameId')], optionalText(args.seriesId, 'seriesId'))[0]
          : requestedNumber !== undefined ? requestedNumber - 1
            : args.index === undefined ? undefined : frameIndex(args.index, 'index'));
        if (frame !== undefined && !owner.result.frames[frame]) throw Error('帧索引超出当前集合。');
        const command = viewCommand(args, frame);
        if (command && requestId) throw Error('requestId 用于读取已发出的定位状态。');
        const waitFor = args.waitFor;
        if (waitFor !== undefined && waitFor !== 'selected' && waitFor !== 'scene') throw Error('等待阶段无效。');
        const outcome = await ctx.view(owner, command, requestId, call?.signal, waitFor);
        return frame === undefined || !outcome || typeof outcome !== 'object'
          ? outcome : { ...outcome, requestedFrame: descriptor(owner, frame) };
      },
    },
    {
      name: 'trajectory_derive',
      description: 'Create a separate trajectory or structure collection from selected scientific frames in their requested order. Native source ordinals, stages, energy units and raw coordinates are preserved.',
      inputSchema: properties({ ...ownerProperties, ...filterProperties, ...referenceSelection, label: string }),
      async call(args, call) {
        call?.signal.throwIfAborted();
        const ctx = access.context(), label = optionalText(args.label, 'label');
        const { owner, result, indices, assertCurrent } = await selectedTrajectory(ctx, args, call?.signal);
        const derived = await deriveResult(result, indices, assertCurrent, label, call?.signal);
        const sourceFrames = indices.map(index => descriptor(owner, index));
        return { status: 'derived', sourceFrames, resultId: derived.id, frameCount: derived.frames.length, derived: await access.context().derive(derived) };
      },
    },
    {
      name: 'trajectory_export',
      description: 'Export original scientific trajectory data using native XYZ, extXYZ, TXT or the paired TXT/JSON ZIP. Select ordered frame references or filter one collection. Pass an absolute file destination or directory to save there, or save:true to use the portable exports folder. The default response returns inline text or bytes.',
      inputSchema: properties({ ...ownerProperties, ...filterProperties, ...referenceSelection, format: { enum: scientificTrajectoryFormats },
        destination: string, directory: string, save: {type:'boolean'}, onExists: { enum: ['error', 'overwrite'] } }, ['format']),
      async call(args, call) {
        call?.signal.throwIfAborted();
        const format = args.format as ScientificTrajectoryFormat;
        if (!scientificTrajectoryFormats.includes(format)) throw Error('请选择原生科学轨迹导出格式。');
        const destination = optionalText(args.destination, 'destination');
        const directory = optionalText(args.directory, 'directory');
        if(destination&&directory)throw toolError('invalid_arguments','请只指定完整文件路径 destination 或目录 directory 中的一项。');
        const picked = await selectedTrajectory(access.context(), args, call?.signal);
        const { origins, projection, range } = exportSelection(picked, format);
        const produce = (sink?: ResultByteSink) => exportWorkspaceTrajectoryData(projection, range, format, {
          origins, signal: call?.signal, sink,
        });
        picked.assertCurrent();
        const origin = {
          status: 'exported', format, targetId: picked.owner.targetId, collectionId: picked.collectionId,
          resultId: picked.result.id, source: picked.result.source, coordinateUnit: 'angstrom',
          frameCount: picked.indices.length,
          frames: picked.indices.map((index, position) => ({
            frameRef: JSON.stringify(identity(picked.owner, index)), outputFrameIndex: position,
            frameNumber: index + 1,
            ...origins[position], energy: picked.result.frames[index].energy,
          })),
        };
        if (destination || directory || args.save === true) return { ...origin, ...await deliverTrajectory(produce, picked.assertCurrent, call, destination===undefined) };
        const { blob, filename } = await produce();
        const inline = await inlineTrajectory(blob, format);
        picked.assertCurrent();
        return { ...origin, filename, mimeType: blob.type, ...inline };
      },
    },
  ];
}

/** Same native dispatch as the visible playback controls. The scene receipt is read independently of dispatch. */
export function viewTrajectoryCanvas(canvas: AnalysisCanvas | null | undefined, command?: PublicTrajectoryPlaybackCommand, requestId?: string) {
  const player = canvas?.trajectoryPlayback;
  if (!canvas?.result || !player) return { status: 'view-unavailable', reason: '当前目标轨迹的原生播放器尚未接管。' };
  const state = player.state;
  const scene = player.readScene?.() ?? null;
  const currentScene = scene?.sourceId === canvas.result.source.id && scene.frameIndex === canvas.frameIndex
    && scene.sourceRevision === canvas.viewport.renderIdentity?.sourceRevision;
  const navigation = player.readNavigation?.();
  const frame = canvas.frameIndex === undefined ? undefined : canvas.result.frames[canvas.frameIndex];
  const playerIndex = canvas.frameIndex === undefined ? -1 : state.sourceOrder?.indexOf(canvas.frameIndex) ?? canvas.frameIndex;
  const current = {
    index: canvas.frameIndex ?? null, frameNumber: playerIndex < 0 ? null : playerIndex + 1,
    frameId: frame?.pesOrigin?.frameId ?? state.frameId ?? null,
    pesOrigin: frame?.pesOrigin ?? null, scientificFrameReady: canvas.scientificFrameReady === true,
    requestedIndex: navigation?.status === 'pending' ? navigation.index
      : state.requestedIndex === undefined ? null : state.sourceOrder?.[state.requestedIndex] ?? state.requestedIndex,
    sceneSubmitted: scene, preparation: state.preparation ?? null, loading: state.loading === true, playing: state.playing,
  };
  const { sourceOrder, ...playerState } = state;
  const base = { resultId: canvas.result.id, collection: state.collectionIdentity ?? null, current, player: playerState };
  if (requestId) {
    if (navigation?.id !== requestId) return { status: 'superseded', requestId, ...base };
    if (navigation.status === 'failed') return { status: 'failed', requestId, reason: navigation.error, ...base };
    const submitted = navigation.status === 'selected' && currentScene && scene?.requestId === navigation.id;
    return { status: submitted ? 'submitted' : navigation.status === 'pending' ? 'preparing' : 'awaiting-scene', requestId, requestedIndex: navigation.index, ...base };
  }
  if (!command) return { status: 'observed', ...base };
  const seeks = command.action === 'seek' || command.action === 'step' || command.action === 'seek-target';
  const accessible = ['pause', 'prepare', 'cancel-preparation'].includes(command.action) || (seeks ? !(state.seekDisabled ?? state.disabled) : !state.disabled);
  if (!accessible) return { status: 'view-unavailable', reason: '当前播放器状态尚未开放该操作。', ...base };
  if (command.action === 'play' && playbackRange(state.range, state.count).length < 2)
    return { status: 'view-unavailable', reason: '播放范围至少需要两个帧。', ...base };
  if (command.action === 'seek') {
    if (command.index === canvas.frameIndex && canvas.scientificFrameReady && currentScene
      && !state.playing && !state.busy) return { status: 'already-submitted', ...base };
    const displayIndex = sourceOrder?.indexOf(command.index) ?? command.index;
    if (displayIndex < 0 || displayIndex >= state.count) throw Error('所选来源帧不在原生视图的当前集合。');
    player.dispatch({ action: 'seek', index: displayIndex });
    const requested = player.readNavigation?.();
    if (!requested || requested.id === navigation?.id || requested.index !== command.index)
      return { status: 'view-unavailable', reason: '原生播放器当前未接收定位。', ...base };
    return { status: requested.status === 'pending' ? 'preparing' : 'awaiting-scene', requestId: requested.id, action: command.action, requestedIndex: command.index, before: base };
  }
  player.dispatch(command);
  return { status: 'dispatched', action: command.action, before: base };
}
