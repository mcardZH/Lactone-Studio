import type { Structure } from '../../core/types';
import type { DocumentStamp, SharedModelConstraints } from '../../core/modeling/contracts';

export interface AdvancedFrameRef {
  documentId: string;
  documentEpoch: string;
  revision: number;
  sourceId?: string;
  taskId?: string;
  runId?: string;
  stageId?: string;
  collectionId?: string;
  frameId?: string;
  /** Source numbering is not replaced by the front-end 1-based display index. */
  sourceFrameIndex?: number;
}
export interface AdvancedFrameSource {
  ref: Readonly<AdvancedFrameRef>;
  label: string;
  structure: Structure;
  stamp: DocumentStamp;
  constraints: SharedModelConstraints;
  coordinateUnit: 'angstrom';
  samplingPreparation?: { kind:'rigid-fit-then-exact-core-restore'; rawFrame:Readonly<AdvancedFrameRef>;
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
/** Capture the scientific coordinates, never the displayed/aligned projection. */
export function captureAdvancedFrame(structure: Structure, ref: AdvancedFrameRef,
  stamp: DocumentStamp, label: string,
  constraints: SharedModelConstraints = { frozenAtomIds: [], coordinates: [] }): AdvancedFrameSource {
  if (!ref.documentId || !ref.documentEpoch || !Number.isSafeInteger(ref.revision) || ref.revision < 0
    || stamp.documentId !== ref.documentId || stamp.revision !== ref.revision) throw new Error('当前帧来源身份不一致。');
  if (ref.sourceFrameIndex !== undefined && (!Number.isSafeInteger(ref.sourceFrameIndex) || ref.sourceFrameIndex < 0)) throw new Error('当前帧源编号无效。');
  if (!structure.atoms.length || structure.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite))
    || new Set(structure.atoms.map(atom => atom.id)).size !== structure.atoms.length) throw new Error('当前帧需要完整有限坐标和唯一原子身份。');
  if (!Number.isInteger(structure.charge) || !Number.isInteger(structure.multiplicity) || structure.multiplicity! < 1) throw new Error('请先确定当前结构的电荷和多重度。');
  const ids = new Set(structure.atoms.map(atom => atom.id!));
  if (constraints.frozenAtomIds.some(id => !ids.has(id)) || constraints.coordinates.some(row => row.atomIds.some(id => !ids.has(id)))) throw new Error('当前帧的冻结定义不匹配原子身份。');
  return frozen({ ref: structuredClone(ref), stamp: structuredClone(stamp), label,
    structure: structuredClone(structure), constraints: structuredClone(constraints), coordinateUnit: 'angstrom' as const });
}

/** All supported successors receive a fresh working copy and preserve parent lineage. */
export function advancedFrameWorkingCopy(source: AdvancedFrameSource): Structure {
  const result = structuredClone(source.structure);
  // A previous geometry's optimizer bookkeeping must not become a new job result.
  result.preparation = undefined;
  return result;
}
export function assertAdvancedIsolated(source: AdvancedFrameSource): void {
  if (source.structure.dimension === 2 || source.structure.cell || source.structure.periodicSource
    || source.structure.bonds?.some(bond => bond.image?.some(Boolean))) throw new Error('此高级计算仅接受已明确为孤立体系的三维结构。');
}
export function sameAdvancedFrame(a: AdvancedFrameRef, b: AdvancedFrameRef): boolean {
  return a.documentId === b.documentId && a.documentEpoch === b.documentEpoch && a.revision === b.revision
    && a.sourceId === b.sourceId && a.taskId === b.taskId && a.runId === b.runId && a.stageId === b.stageId
    && a.collectionId === b.collectionId && a.frameId === b.frameId && a.sourceFrameIndex === b.sourceFrameIndex;
}
