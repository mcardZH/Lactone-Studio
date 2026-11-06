import { assertResultNotAborted, type ResultFrameSummary, type ResultStage, type ResultStageKind, type TrajectoryResult } from './contracts';
import type { ScientificData } from './scientific-contracts';
import { getPreparedTrajectoryFrame, registerPreparedTrajectoryProjection } from './prepared-trajectory';
import { projectNmrCouplingFrames } from './nmr-coupling-projection';
import { projectMdDifferences, projectMdStepFrames } from './md-observations';

/** Stage metadata references the original index. It neither reads geometry nor computes results. */
export function attachTrajectoryStages(result: TrajectoryResult): TrajectoryResult {
  if (result.stages?.length) return result;
  const frames = result.frames, tasks = result.scientific?.tasks ?? [];
  const stages: ResultStage[] = [];
  const add = (id: string, kind: ResultStageKind, label: string, indices: number[], extra: Partial<ResultStage> = {}) => {
    if (indices.length) stages.push({ id, kind, label, frameIndices: indices, ...extra });
  };
  if (tasks.includes('scan') || result.role === 'scan-point-set') {
    const points = frames.filter(frame => result.role === 'scan-point-set' || frame.pathPoint).map(frame => frame.index);
    add('scan-points', 'scan-points', '扫描点', points);
    if (result.role !== 'scan-point-set') {
      const nodes = new Map<number, number[]>();
      for (const frame of frames) if (frame.pathNode !== undefined) {
        const entries = nodes.get(frame.pathNode) ?? []; entries.push(frame.index); nodes.set(frame.pathNode, entries);
      }
      for (const [node, indices] of nodes) add(`scan-optimization:${node}`, 'scan-optimization', `扫描点 ${node} · 优化`, indices);
      const unassigned = frames.filter(frame => frame.pathNode === undefined).map(frame => frame.index);
      add('scan-unassigned', 'trajectory', '未归属扫描点的结构', unassigned);
    }
  } else if (tasks.includes('irc') || result.role === 'irc-full' || result.role === 'irc-branch') {
    const ts = frames.find(frame => frame.pathDirection === 'ts');
    const accepted = frames.some(frame => frame.pathPoint) ? frames.filter(frame => frame.pathPoint || frame.pathDirection === 'ts') : [...frames];
    if (ts && accepted.every(frame => frame.pathDirection)) {
      const rank = { reverse: 0, ts: 1, forward: 2 };
      accepted.sort((a, b) => rank[a.pathDirection!] - rank[b.pathDirection!]
        || (a.pathDirection === 'reverse' ? (b.pathNode ?? b.index) - (a.pathNode ?? a.index) : (a.pathNode ?? a.index) - (b.pathNode ?? b.index)));
    }
    add('irc', 'irc', 'IRC', accepted.map(frame => frame.index), ts ? { tsFrameIndex: ts.index } : {});
    const selected = new Set(accepted.map(frame => frame.index));
    add('irc-unassigned', 'trajectory', '未归属IRC路径的结构', frames.filter(frame => !selected.has(frame.index)).map(frame => frame.index));
  } else if (tasks.includes('neb') || result.role === 'neb-path' || result.role === 'neb-iterations') {
    const pathFrames = frames.filter(frame => frame.stageId !== 'neb-saddle' && (frame.stageId === 'neb-path' || frame.pathImage !== undefined || result.role === 'neb-path' || result.role === 'neb-iterations'));
    const unassigned = result.role === 'neb-iterations' ? pathFrames.filter(frame => frame.pathIteration === undefined || frame.pathImage === undefined) : [];
    const confirmed = result.role === 'neb-iterations' ? pathFrames.filter(frame => frame.pathIteration !== undefined && frame.pathImage !== undefined) : pathFrames;
    const iterations = confirmed.flatMap(frame => frame.pathIteration === undefined ? [] : [frame.pathIteration]);
    if (unassigned.length) {
      result = { ...result, messages: [...result.messages, '部分NEB历轮结构缺少可靠轮次/image对应；保留原帧，已确认路径仅代表可证明部分。'] };
      add('neb-unassigned', 'trajectory', '未归属NEB轮次的结构', unassigned.map(frame => frame.index));
    }
    if (confirmed.length) {
      const latest = iterations.length ? iterations.reduce((maximum, iteration) => Math.max(maximum, iteration), -Infinity) : undefined;
      const selected = confirmed.filter(frame => latest === undefined || frame.pathIteration === latest);
      if (selected.length && selected.every(frame => frame.pathImage !== undefined)) {
        const images = new Set(selected.map(frame => frame.pathImage));
        if (images.size === selected.length) {
          const ci=selected.filter(frame=>frame.climbingImage&&frame.geometryAssociation?.iteration===frame.climbingImage.iteration&&frame.geometryAssociation.image===frame.climbingImage.image-frame.climbingImage.imageBase&&frame.pathIteration===frame.climbingImage.iteration);
          add('neb-path', 'neb-path', latest === undefined ? '路径（轮次未确认）' : unassigned.length ? '最新已确认路径' : '最新路径', selected.map(frame => frame.index), {...(latest===undefined?{}:{sourceIteration:latest}),...(ci.length===1?{ciFrameIndex:ci[0].index}:{})});
        }
      } else if (result.role === 'neb-path' && !iterations.length) add('neb-path', 'neb-path', '路径', selected.map(frame => frame.index));
    }
    add('neb-saddle', 'trajectory', 'NEB CI候选几何', frames.filter(frame => frame.stageId === 'neb-saddle').map(frame => frame.index));
    add('ts-optimization', 'ts-optimization', 'TS优化', frames.filter(frame => frame.stageId === 'ts-optimization').map(frame => frame.index));
    const pathIndices = new Set(pathFrames.map(frame => frame.index));
    add('neb-other', 'optimization', '其他已输出结构', frames.filter(frame => !pathIndices.has(frame.index) && frame.stageId !== 'ts-optimization' && frame.stageId !== 'neb-saddle').map(frame => frame.index));
  } else if (result.role === 'md-trajectory' && tasks.includes('md')) {
    add('md', 'trajectory', '分子动力学 MD', frames.map(frame => frame.index));
  } else {
    add('trajectory', tasks.some(task => task === 'opt' || task === 'ts') ? 'optimization' : 'trajectory', tasks.includes('ts') ? 'TS优化' : '结构', frames.map(frame => frame.index));
  }
  return { ...result, stages };
}

/** Preserve source-bound values only when their original frame belongs to the projection. */
export function projectScientificFrames(data: ScientificData, indices: readonly (number | null)[]): ScientificData {
  const mapping = new Map(indices.flatMap((original, index) => original === null ? [] : [[original, index] as const]));
  const mapRows = <T extends { frameIndex?: number | null }>(rows: readonly T[]): T[] => rows.flatMap(row => {
    if (row.frameIndex === undefined || row.frameIndex === null) return [row];
    const frameIndex = mapping.get(row.frameIndex);
    return frameIndex === undefined ? [] : [{ ...row, frameIndex }];
  });
  const groups = data.vibrationSets ?? (data.vibrations ? [data.vibrations] : []);
  const vibrationSets = mapRows(groups);
  return {
    ...data, summary: mapRows(data.summary), properties: mapRows(data.properties), scfCycles: mapRows(data.scfCycles),
    orbitals: mapRows(data.orbitals), atomicProperties: mapRows(data.atomicProperties),
    ...(data.nmrCouplings ? { nmrCouplings: projectNmrCouplingFrames(data.nmrCouplings, indices) } : {}),
    ...(data.mdSteps ? { mdSteps: projectMdStepFrames(data.mdSteps, indices) } : {}),
    ...(data.mdSourceDifferences ? { mdSourceDifferences: projectMdDifferences(data.mdSourceDifferences, indices) } : {}),
    excitedStates: mapRows(data.excitedStates), thermochemistry: mapRows(data.thermochemistry), stability: mapRows(data.stability), bsse: mapRows(data.bsse),
    vibrations: data.vibrations ? mapRows([data.vibrations])[0] : undefined,
    ...(data.vibrationSets ? { vibrationSets } : {}),
  };
}

/** A non-owning view. The source result remains the sole owner of its reader/cache/lifetime. */
export async function projectTrajectoryStage(result: TrajectoryResult, stageId: string, signal?: AbortSignal): Promise<TrajectoryResult> {
  const staged = attachTrajectoryStages(result), stage = staged.stages?.find(entry => entry.id === stageId);
  if (!stage?.frameIndices.length) throw new Error('此阶段没有可靠的完整结构。');
  assertResultNotAborted(signal);
  const indices = [...stage.frameIndices];
  if (indices.some(index => !Number.isSafeInteger(index) || !result.frames[index])) throw new Error('阶段帧映射无效。');
  const frames: ResultFrameSummary[] = indices.map((source, index) => ({ ...result.frames[source], index, stageId, sourceFrameIndex: result.frames[source].sourceFrameIndex ?? source }));
  const initialStructure = getPreparedTrajectoryFrame(result, indices[0])?.raw ?? await result.getFrame(indices[0], signal);
  const projection: TrajectoryResult = {
    ...result, id: `${result.id}:stage:${stageId}`, label: `${result.label} · ${stage.label}`, frames, initialStructure,
    scientific: result.scientific ? projectScientificFrames(result.scientific, indices) : undefined,
    stages: [{ ...stage, frameIndices: frames.map(frame => frame.index), ...(stage.tsFrameIndex === undefined ? {} : { tsFrameIndex: indices.indexOf(stage.tsFrameIndex) }), ...(stage.ciFrameIndex === undefined ? {} : { ciFrameIndex: indices.indexOf(stage.ciFrameIndex) }) }],
    getFrame(index, abort) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= indices.length) return Promise.reject(new Error('阶段帧索引超出范围。'));
      return result.getFrame(indices[index], abort);
    },
    dispose() { /* The original result, not a stage switch, releases source resources. */ },
  };
  registerPreparedTrajectoryProjection(result, projection, indices);
  return projection;
}
