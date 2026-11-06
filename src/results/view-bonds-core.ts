import type { Bond, Structure, Vector3 } from '../core/types';
import { inferBuilderBonds } from '../core/builder-geometry';
import { cellInverse, norm3, MAX_PERIODIC_CONNECTION_SEARCH_RADIUS, perceivePeriodicConnections } from '../core/periodic';

export interface ViewBondSnapshot {
  source: 'file' | 'inferred' | 'unavailable'; sourceFrame: number; message: string;
  atomIds: string[]; elements: string[]; periodic: boolean; pbc: boolean[];
  bonds: Bond[];
  issues?:NonNullable<Structure['bondPerceptionIssues']>;
  /** Legacy field retained for snapshot consumers; images now come from current geometry. */
  imageOffsets: Vector3[];
  /** Exact display geometry identity; never a scientific calculation cache key. */
  geometryKey?: string;
}
export interface ViewBondResolution { structure: Structure; source: ViewBondSnapshot['source']; message: string }
// Use the core's actual scientific cutoff; no second display-only search rule.
const MAX_PERIODIC_CUTOFF = MAX_PERIODIC_CONNECTION_SEARCH_RADIUS;
function isPeriodic(structure: Structure) { return Boolean(structure.cell?.pbc.some(Boolean)); }
export function viewBondSourceMessage(structure: Structure) { return structure.bonds?.some(bond=>bond.orderKnown===false)?'来源周期经验连接；键级未知（仅显示）':structure.bondSource === 'inferred' ? '来源已有推断键（仅显示）' : '来源显式键'; }
function unavailable(snapshot: ViewBondSnapshot, message: string): ViewBondSnapshot { return { ...snapshot, source: 'unavailable', bonds: [], imageOffsets: [], message }; }
export function viewBondGeometryKey(structure: Structure): string {
  return JSON.stringify([structure.id, structure.revision ?? null, structure.cell ?? null,
    structure.atoms.map(atom => [atom.id, atom.sourceIndex, atom.element, atom.formalCharge ?? 0, atom.x, atom.y, atom.z])]);
}

/** One bounded inference using the existing modeler rules; never modifies source. */
export function createViewBondSnapshot(structure: Structure, index: number): ViewBondSnapshot {
  const snapshot: ViewBondSnapshot = { source: structure.bonds !== undefined ? 'file' : 'inferred', sourceFrame: index,
    message: structure.bonds !== undefined ? viewBondSourceMessage(structure) : isPeriodic(structure)?'当前帧周期经验连接；键级未知（仅显示）':'当前帧几何经验单键（仅显示）',
    atomIds: structure.atoms.map(atom => atom.id!), elements: structure.atoms.map(atom => atom.element), periodic: isPeriodic(structure), pbc: [...(structure.cell?.pbc ?? [false, false, false])], bonds: [], imageOffsets: [] };
  if (structure.bonds !== undefined) return { ...snapshot, bonds: structuredClone(structure.bonds),...(structure.bondPerceptionIssues?{issues:structuredClone(structure.bondPerceptionIssues)}:{}) };
  try {
    if (structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite)))
      return unavailable(snapshot, '当前帧含非有限坐标，未推断显示连接。');
    if (snapshot.periodic) {
      const inverse = cellInverse(structure.cell!);
      // The existing image iterator advances integers by one. A lattice shift
      // outside exact integer representation cannot safely enter that loop.
      const origin = structure.atoms[0];
      const fractional = origin ? structure.atoms.map(atom => {
        const delta = [atom.x - origin.x, atom.y - origin.y, atom.z - origin.z];
        return inverse.map(row => row.reduce((sum, value, j) => sum + value * delta[j], 0));
      }) : [];
      if (inverse.some((row, i) => structure.cell!.pbc[i] && !Number.isSafeInteger(Math.ceil(
        fractional.reduce((maximum,position)=>Math.max(maximum,position[i]),0) - fractional.reduce((minimum,position)=>Math.min(minimum,position[i]),0)
        + norm3(row) * MAX_PERIODIC_CUTOFF + 2))))
        return unavailable(snapshot, '当前帧周期映像位移超出可精确表示范围；当前仅显示原子。');
    }
    const inferred=snapshot.periodic?perceivePeriodicConnections(structure,{allowUnconfirmedPreview:true}):null;
    const bonds = inferred?.bonds??inferBuilderBonds(structure).bonds??[];
    return { ...snapshot, bonds,...(inferred?.issues.length?{issues:inferred.issues}:{}),message:[snapshot.message,...(inferred?.warnings??[])].join('；'),geometryKey: viewBondGeometryKey(structure) };
  } catch (error) { return unavailable(snapshot, `${error instanceof Error ? error.message : String(error)} 当前仅显示原子。`); }
}
