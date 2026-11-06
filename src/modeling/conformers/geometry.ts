import type { Structure, Vector3 } from '../../core/types';
import { effectiveSharedFreezes } from '../constraints';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import { builderCoordinateValue, builderPosition, builderRotate, builderVector } from '../../core/builder-geometry';
import { assertBuilderStereoPreserved, builderDoubleBondConfiguration } from '../../core/builder-stereo';

export interface ConformerSourceIdentity {
  documentId: string; revision: number; frameId?: string; sourceId?: string;
}
/** Deep-frozen, detached source. IDs are required, never generated or reindexed. */
export interface ConformerSnapshot {
  readonly source: Readonly<ConformerSourceIdentity>;
  readonly structure: Structure;
  readonly constraints: SharedModelConstraints;
  readonly geometryUnits: 'angstrom';
}
export type TorsionAtoms = readonly [string, string, string, string];
export type TorsionRejection = 'missing-atoms' | 'missing-bond' | 'unknown-bond-order' | 'non-single-bond'
  | 'restricted-conjugation' | 'closed-ring' | 'degenerate-axis' | 'undefined-dihedral' | 'frozen-conflict';
export interface ConformerTorsion {
  atomIds: [string, string, string, string];
  /** Which whole component moves after cutting B–C. Axis atoms stay exact. */
  movingSide: 'first' | 'last'; movingAtomIds: string[]; sourceDegrees: number;
  /** Explicit manual definition, not an automatic chemical rotatability claim. */
  origin?: 'automatic' | 'manual';
}
export interface ConformerTorsionRow {
  id: string; atomIds: [string, string, string, string]; enabled: boolean; pointCount: number; origin: 'automatic' | 'manual';
}
export type TorsionInspection = { accepted: true; torsion: ConformerTorsion }
  | { accepted: false; reason: TorsionRejection };
export interface TorsionDiscovery {
  torsions: ConformerTorsion[];
  excluded: { axisAtomIds: [string, string]; reason: TorsionRejection | 'terminal-heavy-bond' }[];
}
export interface TorsionAngleRange { startDegrees: number; endDegrees: number }

export const CONFORMER_GEOMETRY_TOLERANCE = Object.freeze({
  positionAngstrom: 1e-7, bondAngstrom: 1e-6, angleDegrees: 1e-5,
  axisAngstrom: 1e-9, maxPointsPerTorsion: 4096,
});
const { sub } = builderVector;
const length = (p: Vector3) => Math.hypot(...p);
const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
export const normalizeTorsionDegrees = (n: number): number => ((n % 360 + 540) % 360) - 180;
const angleError = (a: number, b: number) => Math.abs(normalizeTorsionDegrees(a - b));

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function createConformerSnapshot(structure: Structure, source: ConformerSourceIdentity,
  constraints: SharedModelConstraints = { frozenAtomIds: [], coordinates: [] }): ConformerSnapshot {
  if (!source.documentId || !Number.isInteger(source.revision) || source.revision < 0) throw new Error('构象来源身份无效。');
  if (!structure.atoms.length || structure.atoms.some(a => !a.id || ![a.x, a.y, a.z].every(Number.isFinite))
    || new Set(structure.atoms.map(a => a.id)).size !== structure.atoms.length) throw new Error('构象来源需要有限坐标与唯一稳定原子ID。');
  if (structure.dimension === 2) throw new Error('二维示意坐标不能用于三维构象搜索。');
  if (structure.cell?.pbc.some(Boolean) || structure.periodicSource || structure.bonds?.some(b => b.image?.some(Boolean))) throw new Error('本构象搜索仅接受有限孤立结构。');
  if (!Array.isArray(structure.bonds)) throw new Error('构象搜索需要已有连接图，不自动猜键。');
  const edges = new Set<string>();
  for (const b of structure.bonds) {
    if (![b.a, b.b].every(i => Number.isInteger(i) && i >= 0 && i < structure.atoms.length) || b.a === b.b
      || !Number.isFinite(b.order) || b.order <= 0 || edges.has(edgeKey(b.a, b.b))) throw new Error('构象来源连接图无效或重复。');
    if (length(sub(builderPosition(structure.atoms[b.a]), builderPosition(structure.atoms[b.b]))) < CONFORMER_GEOMETRY_TOLERANCE.axisAngstrom) throw new Error('构象来源含退化连接。');
    edges.add(edgeKey(b.a, b.b));
  }
  const ids = new Set(structure.atoms.map(a => a.id!));
  if (new Set(constraints.frozenAtomIds).size !== constraints.frozenAtomIds.length || constraints.frozenAtomIds.some(id => !ids.has(id))) throw new Error('冻结原子身份无效。');
  for (const c of constraints.coordinates) {
    if (c.action !== 'freeze' || c.atomIds.length !== ({ B: 2, A: 3, D: 4 }[c.type])
      || new Set(c.atomIds).size !== c.atomIds.length || c.atomIds.some(id => !ids.has(id)) || c.images?.some(p => p.some(Boolean))) throw new Error('构象冻结内坐标定义无效。');
    const actual = builderCoordinateValue(structure, c.type, c.atomIds);
    if (c.value !== undefined && (!Number.isFinite(c.value)
      || (c.type === 'D' ? angleError(actual, c.value) : Math.abs(actual - c.value))
        > (c.type === 'B' ? CONFORMER_GEOMETRY_TOLERANCE.bondAngstrom : CONFORMER_GEOMETRY_TOLERANCE.angleDegrees))) throw new Error('冻结目标与来源几何不一致，不能在初猜生成时隐式调整。');
  }
  return freezeTree({ structure: structuredClone(structure), source: { ...source },
    constraints: structuredClone(constraints), geometryUnits: 'angstrom' as const });
}

function component(structure: Structure, root: number, cut: string): number[] {
  const graph = structure.atoms.map(() => [] as number[]);
  for (const b of structure.bonds!) if (edgeKey(b.a, b.b) !== cut) { graph[b.a].push(b.b); graph[b.b].push(b.a); }
  const seen = new Set([root]), todo = [root];
  while (todo.length) for (const n of graph[todo.pop()!]!) if (!seen.has(n)) { seen.add(n); todo.push(n); }
  return [...seen].sort((a, b) => a - b);
}

function isRestrictedConjugation(s: Structure, b: number, c: number): boolean {
  // Explicit graph motif only: N–C(=O/S/N), not guessed aromaticity or FF typing.
  return [[b, c], [c, b]].some(([n, carbon]) => s.atoms[n].element === 'N' && s.atoms[carbon].element === 'C'
    && s.bonds!.some(bond => bond.orderKnown !== false && bond.order === 2
      && (bond.a === carbon || bond.b === carbon)
      && ['O', 'S', 'N'].includes(s.atoms[bond.a === carbon ? bond.b : bond.a].element)));
}

function rawRotation(structure: Structure, torsion: ConformerTorsion, degrees: number): Structure {
  const ids = new Set(torsion.movingAtomIds), [, b, c] = torsion.atomIds;
  const pivot = builderPosition(structure.atoms.find(a => a.id === b)!);
  const end = builderPosition(structure.atoms.find(a => a.id === c)!);
  const old = builderCoordinateValue(structure, 'D', torsion.atomIds);
  const radians = normalizeTorsionDegrees(degrees - old) * Math.PI / 180 * (torsion.movingSide === 'last' ? 1 : -1);
  const atoms = structure.atoms.map(atom => {
    // Axis coordinates are copied exactly, including when they are frozen.
    if (!ids.has(atom.id!) || atom.id === b || atom.id === c) return { ...atom };
    const p = builderRotate(builderPosition(atom), pivot, sub(end, pivot), radians);
    return { ...atom, x: p[0], y: p[1], z: p[2] };
  });
  // Preparation energies describe the old geometry; retain source provenance in
  // the immutable snapshot rather than presenting them on a new uncomputed guess.
  return { ...structuredClone(structure), atoms, molfile: undefined, preparation: undefined };
}

/** Checks the source contract, not just the latest rotation step. */
export function assertConformerGeometryProtected(snapshot: ConformerSnapshot, candidate: Structure,
  manuallyEditableAxes: readonly (readonly [string, string])[] = []): void {
  const source = snapshot.structure;
  if (candidate.atoms.length !== source.atoms.length || candidate.atoms.some((a, i) => a.id !== source.atoms[i].id
    || a.element !== source.atoms[i].element || a.sourceIndex !== source.atoms[i].sourceIndex || ![a.x, a.y, a.z].every(Number.isFinite))
    || JSON.stringify(candidate.bonds) !== JSON.stringify(source.bonds)
    || candidate.charge !== source.charge || candidate.multiplicity !== source.multiplicity) throw new Error('构象改变了来源身份、连接或电子态。');
  const indices = new Map(source.atoms.map((a, i) => [a.id!, i]));
  for (const id of effectiveSharedFreezes(snapshot.constraints).frozenAtomIds) {
    const i = indices.get(id)!;
    if (length(sub(builderPosition(candidate.atoms[i]), builderPosition(source.atoms[i]))) > CONFORMER_GEOMETRY_TOLERANCE.positionAngstrom) throw new Error('构象与冻结原子冲突。');
  }
  for (const b of source.bonds!) {
    const before = length(sub(builderPosition(source.atoms[b.a]), builderPosition(source.atoms[b.b])));
    const after = length(sub(builderPosition(candidate.atoms[b.a]), builderPosition(candidate.atoms[b.b])));
    if (Math.abs(before - after) > CONFORMER_GEOMETRY_TOLERANCE.bondAngstrom) throw new Error('构象旋转破坏了片段连接几何。');
  }
  const neighbors = source.atoms.map(() => [] as number[]);
  for (const b of source.bonds!) { neighbors[b.a].push(b.b); neighbors[b.b].push(b.a); }
  for (let center = 0; center < neighbors.length; center++) {
    const list = neighbors[center];
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const ids = [source.atoms[list[a]].id!, source.atoms[center].id!, source.atoms[list[b]].id!];
      if (Math.abs(builderCoordinateValue(source, 'A', ids) - builderCoordinateValue(candidate, 'A', ids)) > CONFORMER_GEOMETRY_TOLERANCE.angleDegrees) throw new Error('构象旋转破坏了片段键角。');
    }
  }
  for (const c of effectiveSharedFreezes(snapshot.constraints).coordinates) {
    const original = builderCoordinateValue(source, c.type, c.atomIds), actual = builderCoordinateValue(candidate, c.type, c.atomIds);
    const error = c.type === 'D' ? angleError(original, actual) : Math.abs(original - actual);
    if (error > (c.type === 'B' ? CONFORMER_GEOMETRY_TOLERANCE.bondAngstrom : CONFORMER_GEOMETRY_TOLERANCE.angleDegrees)) throw new Error('构象与冻结内坐标冲突。');
  }
  // Tetrahedral centres and every NON-target double bond retain the ordinary
  // guard. Explicit target-axis E/Z changes are geometry, not a claimed same stereoisomer.
  assertBuilderStereoPreserved(source, candidate, manuallyEditableAxes.length === 0);
  if (manuallyEditableAxes.length) for (const bond of source.bonds!) {
    if (bond.order !== 2) continue;
    const a = source.atoms[bond.a].id!, b = source.atoms[bond.b].id!;
    if (manuallyEditableAxes.some(axis => axis.includes(a) && axis.includes(b))) continue;
    const previous = builderDoubleBondConfiguration(source, a, b);
    if (previous !== 'undefined' && builderDoubleBondConfiguration(candidate, a, b) !== previous) throw new Error('非目标双键E/Z构型改变。');
  }
}

export function inspectConformerTorsion(snapshot: ConformerSnapshot, atomIds: TorsionAtoms,
  movingSide?: 'first' | 'last'): TorsionInspection {
  return inspectTorsion(snapshot, atomIds, movingSide, false);
}
export function inspectManualConformerTorsion(snapshot: ConformerSnapshot, atomIds: TorsionAtoms,
  movingSide?: 'first' | 'last'): TorsionInspection {
  return inspectTorsion(snapshot, atomIds, movingSide, true);
}
function inspectTorsion(snapshot: ConformerSnapshot, atomIds: TorsionAtoms,
  movingSide: 'first' | 'last' | undefined, manual: boolean): TorsionInspection {
  const s = snapshot.structure, indices = atomIds.map(id => s.atoms.findIndex(a => a.id === id));
  if (atomIds.length !== 4 || new Set(atomIds).size !== 4 || indices.some(i => i < 0)) return { accepted: false, reason: 'missing-atoms' };
  const [a, b, c, d] = indices;
  const edge = (i: number, j: number) => s.bonds!.find(e => edgeKey(e.a, e.b) === edgeKey(i, j));
  const axis = edge(b, c);
  if (!axis || !edge(a, b) || !edge(c, d)) return { accepted: false, reason: 'missing-bond' };
  if (axis.orderKnown === false) return { accepted: false, reason: 'unknown-bond-order' };
  if ((!manual && (axis.order !== 1 || axis.aromatic)) || axis.kind === 'coordination') return { accepted: false, reason: 'non-single-bond' };
  const last = component(s, c, edgeKey(b, c));
  if (last.includes(b)) return { accepted: false, reason: 'closed-ring' };
  if (!manual && isRestrictedConjugation(s, b, c)) return { accepted: false, reason: 'restricted-conjugation' };
  if (length(sub(builderPosition(s.atoms[b]), builderPosition(s.atoms[c]))) < CONFORMER_GEOMETRY_TOLERANCE.axisAngstrom) return { accepted: false, reason: 'degenerate-axis' };
  let sourceDegrees: number;
  try { sourceDegrees = builderCoordinateValue(s, 'D', [...atomIds]); }
  catch { return { accepted: false, reason: 'undefined-dihedral' }; }
  for (const side of movingSide ? [movingSide] : ['last', 'first'] as const) {
    const moving = side === 'last' ? last : component(s, b, edgeKey(b, c));
    const torsion: ConformerTorsion = { atomIds: [...atomIds], movingSide: side, movingAtomIds: moving.map(i => s.atoms[i].id!), sourceDegrees, ...(manual ? { origin: 'manual' as const } : {}) };
    try { assertConformerGeometryProtected(snapshot, rawRotation(s, torsion, sourceDegrees + 1), manual ? [[atomIds[1], atomIds[2]]] : []); return { accepted: true, torsion }; }
    catch { /* Try the opposite whole side if that preserves the source freezes. */ }
  }
  return { accepted: false, reason: 'frozen-conflict' };
}

export function findRotatableTorsions(snapshot: ConformerSnapshot): TorsionDiscovery {
  const s = snapshot.structure, torsions: ConformerTorsion[] = [], excluded: TorsionDiscovery['excluded'] = [];
  const neighbors = (i: number, except: number) => s.bonds!.filter(b => b.kind !== 'coordination' && (b.a === i || b.b === i))
    .map(b => b.a === i ? b.b : b.a).filter(n => n !== except && s.atoms[n].element !== 'H')
    .sort((a, b) => s.atoms[a].id!.localeCompare(s.atoms[b].id!));
  for (const bond of s.bonds!) {
    const [b, c] = s.atoms[bond.a].id! < s.atoms[bond.b].id! ? [bond.a, bond.b] : [bond.b, bond.a];
    if (s.atoms[b].element === 'H' || s.atoms[c].element === 'H') continue;
    const left = neighbors(b, c), right = neighbors(c, b), axisAtomIds: [string, string] = [s.atoms[b].id!, s.atoms[c].id!];
    if (!left.length || !right.length) { excluded.push({ axisAtomIds, reason: 'terminal-heavy-bond' }); continue; }
    let inspected: TorsionInspection | undefined;
    outer: for (const a of left) for (const d of right) {
      inspected = inspectConformerTorsion(snapshot, [s.atoms[a].id!, ...axisAtomIds, s.atoms[d].id!]);
      if (inspected.accepted || inspected.reason !== 'undefined-dihedral') break outer;
    }
    if (inspected?.accepted) torsions.push(inspected.torsion);
    else excluded.push({ axisAtomIds, reason: inspected && !inspected.accepted ? inspected.reason : 'undefined-dihedral' });
  }
  return { torsions, excluded };
}

/** Revalidates caller-supplied geometry descriptors; mutable payloads cannot bypass ring/freeze checks. */
export function rotateConformerTorsion(snapshot: ConformerSnapshot, torsion: ConformerTorsion,
  targetDegrees: number, current: Structure = snapshot.structure, otherManualTorsions: readonly ConformerTorsion[] = []): Structure {
  if (!Number.isFinite(targetDegrees)) throw new Error('二面角目标必须有限。');
  const admitted = (torsion.origin === 'manual' ? inspectManualConformerTorsion : inspectConformerTorsion)(snapshot, torsion.atomIds, torsion.movingSide);
  if (!admitted.accepted) throw new Error(`二面角不准入：${admitted.reason}`);
  const editableAxes: [string, string][] = [];
  for (const row of [torsion, ...otherManualTorsions]) if (row.origin === 'manual') {
    const checked = inspectManualConformerTorsion(snapshot, row.atomIds, row.movingSide);
    if (!checked.accepted) throw new Error(`手动二面角不准入：${checked.reason}`);
    editableAxes.push([row.atomIds[1], row.atomIds[2]]);
  }
  assertConformerGeometryProtected(snapshot, current, editableAxes);
  const result = rawRotation(current, admitted.torsion, targetDegrees);
  assertConformerGeometryProtected(snapshot, result, editableAxes);
  if (angleError(builderCoordinateValue(result, 'D', admitted.torsion.atomIds), targetDegrees) > CONFORMER_GEOMETRY_TOLERANCE.angleDegrees) throw new Error('片段旋转未达到目标二面角。');
  return result;
}
export function discoverConformerTorsionRows(snapshot: ConformerSnapshot, pointCount = 3): ConformerTorsionRow[] {
  sampleTorsionAngles(pointCount);
  return findRotatableTorsions(snapshot).torsions.map(torsion => ({ id: `torsion-${torsion.atomIds.slice(1,3).join('-')}`,
    atomIds: [...torsion.atomIds], enabled: true, pointCount, origin: 'automatic' }));
}

function rangeSpan(range: TorsionAngleRange): number {
  const span = range.endDegrees - range.startDegrees;
  if (![range.startDegrees, range.endDegrees, span].every(Number.isFinite) || Math.abs(span) > 360 + 1e-9) throw new Error('角度范围须有限且不超过完整一圈。');
  return span;
}
/** Directed, unwrapped arc: 170→190 crosses the ±180 display boundary; 170→-170 means a -340° arc. */
export function torsionAngleInRange(degrees: number, range: TorsionAngleRange): boolean {
  const span = rangeSpan(range);
  if (Math.abs(span) >= 360 - 1e-9) return true;
  if (Math.abs(span) < 1e-9) return angleError(degrees, range.startDegrees) < CONFORMER_GEOMETRY_TOLERANCE.angleDegrees;
  const direction = Math.sign(span), progress = ((direction * (degrees - range.startDegrees)) % 360 + 360) % 360;
  return progress <= Math.abs(span) + CONFORMER_GEOMETRY_TOLERANCE.angleDegrees || 360 - progress < CONFORMER_GEOMETRY_TOLERANCE.angleDegrees;
}
export function sampleTorsionAngles(pointCount: number, range: TorsionAngleRange = { startDegrees: -180, endDegrees: 180 }): number[] {
  if (!Number.isInteger(pointCount) || pointCount < 1 || pointCount > CONFORMER_GEOMETRY_TOLERANCE.maxPointsPerTorsion) throw new Error('二面角点数超出有界范围。');
  const span = rangeSpan(range);
  if (Math.abs(span) < 1e-9 || pointCount === 1) return [normalizeTorsionDegrees(range.startDegrees)];
  const denominator = Math.abs(span) >= 360 - 1e-9 ? pointCount : pointCount - 1;
  return Array.from({ length: pointCount }, (_, i) => normalizeTorsionDegrees(range.startDegrees + span * i / denominator));
}
