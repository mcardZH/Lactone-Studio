import type { Structure } from '../../core/types';
import { assertResultNotAborted, type TrajectoryResult } from '../../results/contracts';
import { attachTrajectoryStages } from '../../results/trajectory-stages';
import type { MonitorGeometry, TaskMonitorResultView, TaskMonitorView } from '../application-contracts';
import type { PreparedScientificMonitor } from './prepared-scientific-monitor';
import {createScientificStructureMetadata} from '../../results/scientific-structure-metadata';

/** Metadata projection of the existing parser snapshot. Geometry is already
 * decoded by the source owner and travels only in the existing geometry delta. */
export function preparedMonitorResultViews(prepared: PreparedScientificMonitor): TaskMonitorResultView[] {
  const views: TaskMonitorResultView[] = [];
  let flat = 0;
  const name = prepared.sourceIdentity.path.split(/[\\/]/).at(-1) || 'output';
  for (const job of prepared.jobs) {
    if (!job.frames.length || job.data.centers?.some(center => center.kind !== 'real') || job.frames.some(frame => frame.geometry.centers?.some(center => center.kind !== 'real'))) continue;
    const indices = job.frames.map(() => flat++), first = prepared.frames[indices[0]];
    if (!first) throw new Error('监控结果与驻留几何映射不完整。');
    const id = `${prepared.collectionId}:scientific:${job.jobIndex}:${job.segmentIndex}`;
    const applyMetadata=createScientificStructureMetadata({engine:job.engine,data:job.data,jobIndex:job.jobIndex,charge:job.charge,multiplicity:job.multiplicity,name,resultId:id});
    const initialStructure: Structure = applyMetadata({ id: `${id}:frame:0`, name: `${name} · 帧 1`, format: `${job.engine} result`,
      atoms: first.atoms.map(atom => ({ ...atom })), charge: job.charge, multiplicity: job.multiplicity,
      dimension: 3, sourceRoute: job.data.route || undefined, notes: [`来源 ${name}，job ${job.jobIndex + 1}；只读结果，未执行新计算。`],
      ...(first.cell ? { cell: structuredClone(first.cell) as Structure['cell'] } : {}) },0,job.frames[0].geometry.line);
    const staged = attachTrajectoryStages({ id, label: `${name} · ${job.data.tasks.join(' / ').toUpperCase() || '结果'} · job ${job.jobIndex + 1}`,
      kind: job.data.tasks.some(task => ['opt','ts','irc','scan'].includes(task)) ? 'optimization' : 'calculation', engine: job.engine,
      source: { id: prepared.collectionId, name, size: prepared.sourceBoundary.publishedByteRange.end, software: job.engine },
      jobIndex: job.jobIndex, status: job.status, messages: [...job.messages], scientific: { ...job.data, source: { id: prepared.collectionId, name } },
      frames: job.frames.map(({ geometry: _geometry, ...frame }) => frame), initialStructure,
      async getFrame() { throw new Error('传输投影不拥有几何读取。'); }, dispose() {} });
    const { getFrame: _get, dispose: _dispose, ...result } = staged;
    views.push({ result, geometryIndices: indices });
  }
  return views;
}

/** Renderer consumer over immutable, resident frames. No OUT access, semantic
 * parsing, bond algorithm, scientific task, Store, or Undo history lives here. */
export function createMonitorResults(view: Pick<TaskMonitorView, 'collectionId' | 'revision' | 'results'>, geometries: readonly MonitorGeometry[]): TrajectoryResult[] {
  if (!view.collectionId || !view.revision) return [];
  return (view.results ?? []).map(entry => {
    let retained: (MonitorGeometry | undefined)[] = entry.geometryIndices.map(index => geometries[index]);
    if (retained.some(frame => !frame || frame.sourceKey !== view.collectionId) || retained.length !== entry.result.frames.length) throw new Error('监控结果与当前来源版本不一致。');
    let closed = false;
    const applyMetadata=(entry.result.engine==='gaussian'||entry.result.engine==='orca')&&entry.result.scientific?createScientificStructureMetadata({engine:entry.result.engine,data:entry.result.scientific,jobIndex:entry.result.jobIndex,charge:entry.result.initialStructure.charge,multiplicity:entry.result.initialStructure.multiplicity,name:entry.result.source.name,resultId:entry.result.id}):undefined;
    const result: TrajectoryResult = { ...entry.result,
      async getFrame(index, signal) {
        assertResultNotAborted(signal);
        if (closed) throw new Error('监控结果消费者已释放。');
        if (!Number.isSafeInteger(index) || index < 0 || index >= retained.length) throw new Error('监控结果帧序号越界。');
        const frame = retained[index]!;
        const structure:Structure={ ...structuredClone(entry.result.initialStructure), id: `${entry.result.id}:frame:${index}`, name: `${entry.result.source.name} · 帧 ${index + 1}`,
          atoms: frame.atoms.map(atom => ({ ...atom })), bonds: frame.bonds?.map(bond => ({ ...bond })),
          ...(frame.cell ? { cell: structuredClone(frame.cell) as Structure['cell'] } : {}) };
        return applyMetadata?applyMetadata(structure,index,entry.result.frames[index].sourceLine):structure;
      },
      dispose() { if (closed) return; closed = true; retained = []; }
    };
    return result;
  });
}
