import type { Atom, Structure, Vector3 } from '../types';
import { builderRotate, builderVector } from '../builder-geometry';
import { cellInverse, minimumImage } from '../periodic';

/** Deliberately conservative diagram guard, not van-der-Waals clearance or FF.
 * Only severe near-coincidence is rejected; ordinary short bonds remain legal.
 * B=.85 belongs to this legacy guard policy, not the periodic connection cutoff. */
const radii: Record<string, number> = { H: .31, B: .85, C: .76, N: .71, O: .66, F: .57, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.2, I: 1.39, Fe: 1.32, Ca: 1.76 };
export const obviousClashDistance = (a: string, b: string) => Math.min(.8, Math.max(.32, .55 * ((radii[a] ?? .76) + (radii[b] ?? .76))));

/** Inspect affected/new atoms only. Preserved pre-existing bad geometry is not
 * silently repaired or newly rejected unless this edit makes that pair worse. */
export function hasObviousPlacementClash(structure: Structure, affectedIds: readonly string[], baseline?: Structure): boolean {
  return prepareObviousPlacementClash(structure, affectedIds, baseline)();
}

/** Prepare once for a bounded new/local-atom search. Only the affected buffer
 * may change between checks: the old atoms, lattice and baseline are fixed.
 * The index is a conservative broad phase; every possible close pair still
 * passes the same distance/old-geometry guard, including skew/partial PBC. */
export function prepareObviousPlacementClash(structure: Structure, affectedIds: readonly string[], baseline?: Structure): (affectedAtoms?: readonly Atom[]) => boolean {
  return prepareClashSearch(structure, new Set(affectedIds), baseline).check;
}

export interface IncrementalNewAtomClash {
  hasClash(atom: Atom): boolean;
  appendAccepted(atom: Atom): void;
}

/** Private append-only saturation session. Its fixed XYZ/cell never change;
 * an accepted H becomes fixed for the next H. Dispose before rigid placement. */
export function prepareIncrementalNewAtomClash(structure: Structure): IncrementalNewAtomClash {
  const session = prepareClashSearch(structure, new Set(), undefined, true);
  return { hasClash: atom => session.check([atom]), appendAccepted: session.appendAccepted };
}

function prepareClashSearch(structure: Structure, affected: Set<string>, baseline?: Structure, incremental = false) {
  const fixed = structure.atoms.filter(a => !affected.has(a.id!));
  const moving = structure.atoms.filter(a => affected.has(a.id!));
  const fixedIds = new Set(fixed.map(a => a.id));
  if (!incremental && (!moving.length || !fixed.length && moving.length < 2)) return { check: () => false, appendAccepted: (_atom: Atom) => { throw new Error('固定放置检查不能追加原子。'); } };
  const old = new Map(baseline?.atoms.map(a => [a.id, a]) ?? []);
  const periodic = !!structure.cell?.pbc.some(Boolean), cell = structure.cell;
  // Cache the inverse and reciprocal lengths once, not per pair/candidate.
  const inverse = periodic ? cellInverse(cell!) : undefined;
  const reciprocal = inverse?.map(row => Math.hypot(...row));
  const widths = reciprocal?.map(length => length * .8 + 1e-9);
  const bins = widths?.map((width, axis) => cell!.pbc[axis] ? Math.max(1, Math.floor(1 / width)) : 0);
  const fractional = (a: Atom): Vector3 => inverse!.map(row => row[0] * a.x + row[1] * a.y + row[2] * a.z) as Vector3;
  const coordinates = (a: Atom): Vector3 => {
    if (!inverse) return [a.x / .8, a.y / .8, a.z / .8];
    return fractional(a).map((f, axis) => bins![axis] ? (f - Math.floor(f)) * bins![axis] : f / widths![axis]) as Vector3;
  };
  const key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
  const index = new Map<string, Atom[]>();
  // Extreme finite values retain the original distance/error behavior rather
  // than letting floating-point overflow or hash precision hide a close pair.
  const extreme = (a: Atom) => ![a.x, a.y, a.z].every(v => Number.isFinite(v) && Math.abs(v) < 1e12);
  let useIndex = !structure.atoms.some(extreme) && (!widths || widths.every(w => Number.isFinite(w) && w > 0));
  const insert = (a: Atom) => {
    const [x, y, z] = coordinates(a).map(Math.floor), bucket = key(x, y, z);
    const entries = index.get(bucket); if (entries) entries.push(a); else index.set(bucket, [a]);
  };
  if (useIndex) for (const a of fixed) insert(a);
  const cachedDistance = (a: Atom, b: Atom, radius: number): number => {
    const q: Vector3 = [b.x - a.x, b.y - a.y, b.z - a.z];
    if (!q.every(Number.isFinite)) throw new Error('周期坐标必须为有限数值。');
    if (!inverse) return Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2);
    const f = inverse.map(row => row[0] * q[0] + row[1] * q[1] + row[2] * q[2]);
    const bounds = f.map((value, axis) => cell!.pbc[axis]
      ? [Math.ceil(-value - reciprocal![axis] * radius - 1e-9), Math.floor(-value + reciprocal![axis] * radius + 1e-9)] : [0, 0]);
    // An empty axis interval visits no image. Return the same Infinity rather
    // than iterating enormous outer ranges whose innermost loop is empty.
    if (bounds.some(([lo, hi]) => lo > hi)) return Infinity;
    if (bounds.reduce((n, [lo, hi]) => n * Math.max(0, hi - lo + 1), 1) > 2_000_000) throw new Error('晶胞过度倾斜或过小，周期映像枚举超出本地处理范围。');
    let distance = Infinity;
    const [u, v, w] = cell!.vectors;
    for (let i = bounds[0][0]; i <= bounds[0][1]; i++) for (let j = bounds[1][0]; j <= bounds[1][1]; j++) for (let k = bounds[2][0]; k <= bounds[2][1]; k++) {
      const x = q[0] + i * u[0] + j * v[0] + k * w[0], y = q[1] + i * u[1] + j * v[1] + k * w[1], z = q[2] + i * u[2] + j * v[2] + k * w[2];
      distance = Math.min(distance, Math.sqrt(x * x + y * y + z * z));
    }
    // Only distances below radius matter here. If a close image exists, use
    // the exact established nearest-image routine for its 1e-12 tie semantics.
    return distance < radius ? minimumImage(structure, a, b).distance : Infinity;
  };
  const clashes = (a: Atom, b: Atom): boolean => {
    const threshold = obviousClashDistance(a.element, b.element);
    const distance = extreme(a) || extreme(b) ? minimumImage(structure, a, b).distance : cachedDistance(a, b, threshold);
    // Infinity from the PBC threshold enumeration means no close image.
    if (!periodic && !Number.isFinite(distance)) return true;
    if (distance >= threshold) return false;
    const oa = old.get(a.id), ob = old.get(b.id);
    return !(baseline && oa && ob && distance >= minimumImage(baseline, oa, ob).distance - 1e-12);
  };
  const check = (buffer: readonly Atom[] = moving) => {
    if (incremental ? buffer.length !== 1 || fixedIds.has(buffer[0].id) : buffer.length !== moving.length || new Set(buffer.map(a => a.id)).size !== buffer.length) throw new Error('局部碰撞缓冲必须完整保留本次受影响原子身份。');
    for (let i = 0; i < buffer.length; i++) {
      const a = buffer[i];
      if (!incremental && !affected.has(a.id!)) throw new Error('局部碰撞缓冲只能包含本次受影响原子。');
      for (let j = 0; j < i; j++) if (clashes(a, buffer[j])) return true;
      if (!useIndex || extreme(a)) { for (const b of fixed) if (clashes(a, b)) return true; continue; }
      const c = coordinates(a).map(Math.floor), visited = new Set<string>();
      // Adjacent bins cover the maximum .8 Å threshold. One extra bin retains
      // a conservative margin at floating-point/PBC wrapping boundaries.
      for (let x = c[0] - 2; x <= c[0] + 2; x++) for (let y = c[1] - 2; y <= c[1] + 2; y++) for (let z = c[2] - 2; z <= c[2] + 2; z++) {
        const raw = [x, y, z], wrapped = raw.map((value, axis) => bins?.[axis] ? ((value % bins[axis]) + bins[axis]) % bins[axis] : value);
        const bucket = key(wrapped[0], wrapped[1], wrapped[2]);
        if (visited.has(bucket)) continue; visited.add(bucket);
        for (const b of index.get(bucket) ?? []) if (clashes(a, b)) return true;
      }
    }
    return false;
  };
  const appendAccepted = (atom: Atom) => {
    if (!incremental) throw new Error('固定放置检查不能追加原子。');
    if (fixedIds.has(atom.id)) throw new Error('局部碰撞缓冲必须完整保留本次受影响原子身份。');
    fixed.push(atom); fixedIds.add(atom.id);
    if (extreme(atom)) useIndex = false;
    if (useIndex) insert(atom);
  };
  return { check, appendAccepted };
}

const directions: Vector3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)] as Vector3)))];
export interface LocalPlacementSearch { pivot?: Vector3; axis?: Vector3; locked?: boolean; optimizeClearance?: boolean; onRotation?(axis: Vector3, degrees: number): void }
interface ContactScore { overlap:number; proximity:number }
const betterContact=(a:ContactScore,b:ContactScore)=>a.overlap<b.overlap-1e-12||Math.abs(a.overlap-b.overlap)<=1e-12&&a.proximity<b.proximity-1e-12;

/** Soft contact score only ranks legal rigid poses. Exclude 1-2 and 1-3 graph
 * neighbours; a construction bond/angle is not a nonbonded overlap penalty.
 * No intrafragment term can change a copied conformation. */
function prepareContactScore(candidate: Structure, movingIds: Set<string>) {
  const adjacency = new Map<string, Set<string>>();
  for (const bond of candidate.bonds ?? []) {
    const a = candidate.atoms[bond.a].id!, b = candidate.atoms[bond.b].id!;
    if (!adjacency.has(a)) adjacency.set(a, new Set()); if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  }
  const fixed = candidate.atoms.filter(a => !movingIds.has(a.id!));
  const exclusions = new Map<string, Set<string>>();
  for (const id of movingIds) {
    const excluded = new Set(adjacency.get(id) ?? []);
    for (const neighbour of adjacency.get(id) ?? []) for (const next of adjacency.get(neighbour) ?? []) excluded.add(next);
    exclusions.set(id, excluded);
  }
  const contactRadii: Record<string, number> = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98 };
  if (!candidate.cell?.pbc.some(Boolean)) {
    // Rigid buffers change XYZ only. Cache membership/radii once while keeping
    // the original moving/fixed order and overlap-penalty summation.
    const pairs = new Map(candidate.atoms.filter(a => movingIds.has(a.id!)).map(a => {
      const excluded = exclusions.get(a.id!), radius = contactRadii[a.element] ?? 1.8;
      return [a.id!, fixed.filter(b => !excluded?.has(b.id!)).map(b => {
        const clearance = .8 * (radius + (contactRadii[b.element] ?? 1.8));
        return { atom: b, clearance, clearanceSquared: clearance * clearance };
      })] as const;
    }));
    return (moving: readonly Atom[]) => {
      let penalty = 0,proximity=0;
      for (const a of moving) for (const { atom: b, clearance, clearanceSquared } of pairs.get(a.id!)!) {
        const dx = a.x - b.x,dy = a.y - b.y,dz = a.z - b.z;
        // Only pairs within this box can contribute overlap. Keep their original
        // hypot evaluation, while ranking distant pairs directly by squared
        // distance (no square root or overflow-prone reciprocal distance).
        if (Math.abs(dx) < clearance && Math.abs(dy) < clearance && Math.abs(dz) < clearance) {
          const distance = Math.hypot(dx, dy, dz);
          if (distance < clearance) penalty += (1 - distance / clearance) ** 2;
        }
        // Bounded, monotone distance ranking even outside the old soft-contact
        // envelope. Pure geometry, not dispersion/energy or a force-field fit.
        proximity+=(clearanceSquared/(dx*dx+dy*dy+dz*dz+clearanceSquared))**2;
      }
      return {overlap:penalty,proximity};
    };
  }
  // Periodic minimum-image distances and their established evaluation path
  // remain unchanged; Cartesian axis pruning is invalid across cell images.
  return (moving: readonly Atom[]) => {
    let penalty = 0,proximity=0;
    for (const a of moving) for (const b of fixed) {
      if (exclusions.get(a.id!)?.has(b.id!)) continue;
      const distance = candidate.cell?.pbc.some(Boolean) ? minimumImage(candidate, a, b).distance : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const clearance = .8 * ((contactRadii[a.element] ?? 1.8) + (contactRadii[b.element] ?? 1.8));
      if (distance < clearance) penalty += (1 - distance / clearance) ** 2;
      proximity+=(clearance*clearance/(distance*distance+clearance*clearance))**2;
    }
    return {overlap:penalty,proximity};
  };
}

/** Clearance mode: deterministic 15-degree coarse torsions, up to 24 interleaved
 * samples if none is legal, then 8 finer angles around the best coarse pose.
 * All candidates are proper rotations from ONE baseline, never accumulated.
 * Existing atoms, bonds/lattice and the declared attachment axis stay fixed. */
export function avoidObviousNewAtomClashes(baseline: Structure, candidate: Structure, newIds: readonly string[], search: LocalPlacementSearch = {}): Structure {
  const chosen = new Set(newIds), oldIds = new Set(baseline.atoms.map(a => a.id));
  if (newIds.some(id => oldIds.has(id))) throw new Error('局部候选只能调整本次新增原子，不能移动旧骨架。');
  const moving = candidate.atoms.filter(atom => chosen.has(atom.id!)), check = prepareObviousPlacementClash(candidate, newIds, baseline);
  const score = search.optimizeClearance ? prepareContactScore(candidate, chosen) : undefined;
  let bestAtoms: typeof moving | undefined = !check(moving) ? moving : undefined;
  let bestScore:ContactScore = bestAtoms ? score?.(moving) ?? {overlap:0,proximity:0} : {overlap:Infinity,proximity:Infinity};
  let bestRotation: { axis?: Vector3; degrees?: number } | undefined;
  if (bestAtoms && !score) return candidate;
  const variants: { transform(p:Vector3):Vector3; axis?:Vector3; degrees?:number }[] = search.locked ? [] : search.pivot
    ? (search.axis ? [search.axis] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vector3[]).flatMap(axis => (score ? Array.from({ length: 23 }, (_, i) => (i + 1) * 15) : [45, 90, 135, 180, 225, 270, 315]).map(degrees => ({axis,degrees,transform:(p:Vector3)=>builderRotate(p, search.pivot!, axis, degrees * Math.PI / 180)})))
    : [1.1, 1.8].flatMap(radius => directions.map(direction => ({transform:(p:Vector3)=>builderVector.add(p, builderVector.scale(direction, radius))})));
  const evaluate=(variant:typeof variants[number])=>{
    const buffer = moving.map(atom => {
      const p = variant.transform([atom.x, atom.y, atom.z]); return { ...atom, x: p[0], y: p[1], z: p[2] };
    });
    if (!check(buffer)) {
      const value = score?.(buffer) ?? {overlap:0,proximity:0};
      if (betterContact(value,bestScore)) { bestAtoms = buffer; bestScore = value; bestRotation = variant; }
      return !score;
    }
    return false;
  };
  for (const variant of variants) if(evaluate(variant))break;
  if(score&&search.pivot&&!search.locked){
    const axes=search.axis?[search.axis]:[[1,0,0],[0,1,0],[0,0,1]] as Vector3[];
    if(!bestAtoms)for(const axis of axes)for(let i=0;i<24;i++){
      const degrees=7.5+i*15;evaluate({axis,degrees,transform:p=>builderRotate(p,search.pivot!,axis,degrees*Math.PI/180)});
    }
    if(bestAtoms){
      // Snapshot the centre before refinement; later improvements do not shift
      // the grid or create an unbounded greedy/iterative search.
      const refinementAxis=bestRotation?.axis??axes[0],centre=bestRotation?.degrees??0;
      for(const offset of [-7.5,-5.625,-3.75,-1.875,1.875,3.75,5.625,7.5]){
        const degrees=(centre+offset+360)%360;evaluate({axis:refinementAxis,degrees,transform:p=>builderRotate(p,search.pivot!,refinementAxis,degrees*Math.PI/180)});
      }
    }
  }
  if (!bestAtoms) throw new Error('新增位点存在明显重叠，有界局部候选均不可用；未移动旧骨架或提交。');
  if (bestAtoms === moving) return candidate;
  const placed = new Map(bestAtoms.map(atom => [atom.id, atom]));
  if (bestRotation?.axis) search.onRotation?.(bestRotation.axis, bestRotation.degrees!);
  return { ...candidate, atoms: candidate.atoms.map(atom => placed.get(atom.id) ?? atom) };
}
