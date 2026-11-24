import { isPeriodic, requireConfirmedPeriodicity } from '../../core/periodic';
import type { Structure } from '../../core/types';
import type { DocumentStamp, SharedModelConstraints } from '../../core/modeling/contracts';

export interface AdvancedFrameRef {
  documentId: string;
  documentEpoch: string;
  revision: number;
  sourceId?: string;
  sourceRevision?: string;
  /** The OUT job that owns a file page or certifies a companion geometry. */
  outputJob?: Readonly<{ sourceId: string; sourceRevision?: string; id: string; index: number | null }>;
  taskId?: string;
  runId?: string;
  pesOrigin?: Readonly<import('../../results/contracts').PesResultFrameOrigin>;
  stageId?: string;
  collectionId?: string;
  frameId?: string;
  /** Source numbering is not replaced by the front-end 1-based display index. */
  sourceFrameIndex?: number;
}
export interface AdvancedFrameSource {
  protection?:import('./conformer-protection').ConformerProtectionSnapshot;
  /** Printed/imported state before a caller explicitly confirms task-local q/M. */
  sourceElectronicState?: Readonly<{ charge: number | null; multiplicity: number | null }>;
  ref: Readonly<AdvancedFrameRef>;
  label: string;
  structure: Structure;
  stamp: DocumentStamp;
  constraints: SharedModelConstraints;
  coordinateUnit: 'angstrom';
  samplingPreparation?: { kind:'fixed-cell-exact-core-restore'; rawFrame:Readonly<AdvancedFrameRef>;
    referenceFrame:Readonly<AdvancedFrameRef>; protectedAtomIds:string[]; maxResidualAngstrom:number;
    protection?:import('./conformer-protection').ConformerProtectionSnapshot }
  | { kind:'rigid-fit-then-exact-core-restore'; rawFrame:Readonly<AdvancedFrameRef>;
    protection?:import('./conformer-protection').ConformerProtectionSnapshot;
    referenceFrame:Readonly<AdvancedFrameRef>; protectedAtomIds:string[]; fitRmsdAngstrom:number;
    maxResidualAngstrom:number; rotationAmbiguous:boolean };
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const part of Object.values(value)) frozen(part);
    Object.freeze(value);
  }
  return value;
}
const capturedStructures = new WeakSet<Structure>();

/** Only this capture boundary certifies a deeply detached scientific structure. */
export function isCapturedAdvancedStructure(value: object): boolean {
  return capturedStructures.has(value as Structure);
}

/** Capture the scientific coordinates, never the displayed/aligned projection. */
export function captureAdvancedFrame(structure: Structure, ref: AdvancedFrameRef,
  stamp: DocumentStamp, label: string,
  constraints: SharedModelConstraints = { frozenAtomIds: [], coordinates: [] }): AdvancedFrameSource {
  if (!ref.documentId || !ref.documentEpoch || !Number.isSafeInteger(ref.revision) || ref.revision < 0
    || stamp.documentId !== ref.documentId || stamp.revision !== ref.revision) throw new Error('当前帧来源身份不一致。');
  if (ref.sourceFrameIndex !== undefined && (!Number.isSafeInteger(ref.sourceFrameIndex) || ref.sourceFrameIndex < 0)) throw new Error('当前帧源编号无效。');
  const captured = isCapturedAdvancedStructure(structure);
  let ids: Set<string> | undefined;
  if (!captured) {
    ids = new Set<string>();
    if (!structure.atoms.length || structure.atoms.some(atom => {
      if (!atom.id || ids!.has(atom.id) || ![atom.x, atom.y, atom.z].every(Number.isFinite)) return true;
      ids!.add(atom.id);
      return false;
    })) throw new Error('当前帧需要完整有限坐标和唯一原子身份。');
    if (!Number.isInteger(structure.charge) || !Number.isInteger(structure.multiplicity) || structure.multiplicity! < 1) throw new Error('请先确定当前结构的电荷和多重度。');
  }
  if (constraints.frozenAtomIds.length || constraints.coordinates.length) {
    ids ??= new Set(structure.atoms.map(atom => atom.id!));
    if (constraints.frozenAtomIds.some(id => !ids!.has(id)) || constraints.coordinates.some(row => row.atomIds.some(id => !ids!.has(id)))) throw new Error('当前帧的冻结定义不匹配原子身份。');
  }
  const scientific = captured ? structure : frozen(structuredClone(structure));
  capturedStructures.add(scientific);
  return Object.freeze({ ref: frozen(structuredClone(ref)), stamp: frozen(structuredClone(stamp)), label,
    structure: scientific, constraints: frozen(structuredClone(constraints)), coordinateUnit: 'angstrom' as const });
}

/** All supported successors receive a fresh working copy and preserve parent lineage. */
export function advancedFrameWorkingCopy(source: AdvancedFrameSource): Structure {
  const result = structuredClone(source.structure);
  // A previous geometry's optimizer bookkeeping must not become a new job result.
  result.preparation = undefined;
  return result;
}
export function assertAdvancedIsolated(source: AdvancedFrameSource): void {
  if (source.structure.dimension === 2 || isPeriodic(source.structure) || source.structure.periodicSource
    || source.structure.bonds?.some(bond => bond.image?.some(Boolean))) throw new Error('此高级计算仅接受已明确为孤立体系的三维结构。');
}
export function assertFixedCellConformerSource(source: AdvancedFrameSource): void {
  if (source.structure.dimension === 2 || !isPeriodic(source.structure) || !requireConfirmedPeriodicity(source.structure).pbc.every(Boolean))
    throw new Error('固定晶胞构象搜索需要已确认三轴周期性的三维结构。');
}
export function sameAdvancedFrame(a: AdvancedFrameRef, b: AdvancedFrameRef): boolean {
  return a.documentId === b.documentId && a.documentEpoch === b.documentEpoch && a.revision === b.revision
    && a.sourceId === b.sourceId && a.sourceRevision === b.sourceRevision
    && a.outputJob?.sourceId === b.outputJob?.sourceId && a.outputJob?.sourceRevision === b.outputJob?.sourceRevision
    && a.outputJob?.id === b.outputJob?.id && a.outputJob?.index === b.outputJob?.index
    && a.taskId === b.taskId && a.runId === b.runId && a.stageId === b.stageId
    && a.pesOrigin?.groupId === b.pesOrigin?.groupId && a.pesOrigin?.nodeId === b.pesOrigin?.nodeId
    && a.pesOrigin?.taskId === b.pesOrigin?.taskId
    && a.pesOrigin?.runId === b.pesOrigin?.runId && a.pesOrigin?.recordId === b.pesOrigin?.recordId
    && a.pesOrigin?.seriesId === b.pesOrigin?.seriesId && a.pesOrigin?.frameId === b.pesOrigin?.frameId
    && a.collectionId === b.collectionId && a.frameId === b.frameId && a.sourceFrameIndex === b.sourceFrameIndex;
}
