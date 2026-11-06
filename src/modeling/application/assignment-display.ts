import type { BuilderAssignment, BuilderAssignments } from '../../core/builder-draft';
import type { Atom } from '../../core/types';
import { fragmentColor } from '../../core/regions';

export type AssignmentDisplayCategory = 'basis' | 'fragments' | 'layers';
/** An identity-bearing display projection, never a new scientific region. */
export interface AssignmentDisplayRegion {
  id: string;
  category: AssignmentDisplayCategory;
  atomIds: readonly string[];
  shortLabel: string;
  description: string;
  color: string;
  kind?: BuilderAssignment['kind'];
}
export interface AssignmentAtomScreenPoint { atomId: string; x: number; y: number }
export interface AssignmentDisplayBadge {
  key: string;
  atomId: string;
  region: AssignmentDisplayRegion;
  x: number;
  y: number;
}
export const assignmentDisplayKey = (region: Pick<AssignmentDisplayRegion, 'category' | 'id'>): string => JSON.stringify([region.category, region.id]);

/** Match modelHighlights' existing category/index palette. Numbering is only
 * presentation: callbacks always retain the assignment's original stable ID.
 * Empty rows retain their display ordinal but create no atom badges. */
export function projectAssignmentDisplay(assignments: BuilderAssignments, atoms: readonly Pick<Atom, 'id'>[]): AssignmentDisplayRegion[] {
  const known = new Set(atoms.flatMap(atom => atom.id ? [atom.id] : []));
  return (['basis', 'fragments', 'layers'] as const).flatMap(category => {
    const rows = assignments[category], counts = new Map<string, number>(), kindCounts = new Map<string, number>();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return rows.flatMap((row, index) => {
      const prefix = category === 'basis' ? '基' : category === 'fragments' ? '片段' : row.kind === 'qm' ? 'QM' : row.kind === 'mm' ? 'MM' : row.kind === 'middle' ? '中间组' : '区域';
      const ordinal = category === 'layers' ? (kindCounts.get(prefix) ?? 0) + 1 : index + 1;
      kindCounts.set(prefix, ordinal);
      // Ambiguous identities cannot be offered as selectable region objects.
      if (!row.id || counts.get(row.id) !== 1) return [];
      const atomIds = [...new Set(row.atomIds)].filter(id => known.has(id));
      const shortLabel = `${prefix}${ordinal}`;
      const details = [shortLabel, row.label?.trim(), row.basis?.trim(), `${atomIds.length} 个原子`];
      if (category === 'fragments' && row.charge !== undefined) details.push(`电荷 ${row.charge}`);
      if (category === 'fragments' && row.multiplicity !== undefined) details.push(`多重度 ${row.multiplicity}`);
      if (category === 'layers' && row.frozen) details.push('层内原子固定');
      if (category === 'layers') details.push(row.kind === 'qm' || row.kind === 'mm' ? '空间分组' : '空间分组，理论映射待确认');
      return [{ id: row.id, category, atomIds, shortLabel, description: [...new Set(details.filter(Boolean))].join(' · '), color: fragmentColor(index + (category === 'basis' ? 5 : category === 'layers' ? 10 : 0)), ...(row.kind ? { kind: row.kind } : {}) }];
    });
  });
}

/** Coordinates are already projected by the owning view, relative to its
 * interaction surface. This helper cannot change camera or model geometry. */
export function projectAssignmentBadges(regions: readonly AssignmentDisplayRegion[], points: readonly AssignmentAtomScreenPoint[]): AssignmentDisplayBadge[] {
  const positions = new Map(points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)).map(point => [point.atomId, point]));
  const lanes = new Map<string, number>();
  return regions.flatMap(region => [...new Set(region.atomIds)].flatMap(atomId => {
    const point = positions.get(atomId);
    if (!point) return [];
    const lane = lanes.get(atomId) ?? 0;
    lanes.set(atomId, lane + 1);
    // Lower-left attachment leaves the selection/freeze/scan upper lanes free.
    return [{ key: JSON.stringify([region.category, region.id, atomId]), atomId, region, x: point.x - 12, y: point.y + 15 + lane * 21 }];
  }));
}

/** Pure click gate: a drag is never interpreted as selecting a region. */
export function assignmentBadgeClickAllowed(start: { x: number; y: number } | null, end: { x: number; y: number }, detail: number, moved = false): boolean {
  return detail === 0 || Boolean(start && !moved && Math.hypot(end.x - start.x, end.y - start.y) < 4);
}
