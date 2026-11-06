import type { Atom, Structure, Vector3 } from '../../../core/types';
import { add, centroid, coordinates, cross, dot, point, scale, subtract } from './geometry';

export type Rotation = [Vector3, Vector3, Vector3];
export interface RigidTransform { rotation: Rotation; translation: Vector3; anchorIds: string[] }
export const identityTransform = (): RigidTransform => ({ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], anchorIds: [] });
export const rotate = (r: Rotation, p: Vector3): Vector3 => r.map(row => dot(row, p)) as Vector3;
export const inverseRotate = (r: Rotation, p: Vector3): Vector3 => [0, 1, 2].map(k => r.reduce((sum, row, i) => sum + row[k] * p[i], 0)) as Vector3;
export const transformPoint = (t: RigidTransform, p: Vector3): Vector3 => add(rotate(t.rotation, p), t.translation);
export const inversePoint = (t: RigidTransform, p: Vector3): Vector3 => inverseRotate(t.rotation, subtract(p, t.translation));
export const transformAtoms = (atoms: Atom[], t: RigidTransform): Atom[] => atoms.map(atom => ({ ...atom, ...point(transformPoint(t, coordinates(atom))) }));
/** Composition keeps a new session's raw reference at its existing displayed
 * pose, while the new relative fit still acts on untouched physical XYZ. */
export function composeTransforms(outer: RigidTransform, inner: RigidTransform): RigidTransform {
  const rotation = outer.rotation.map(row => [0, 1, 2].map(k => row.reduce((sum, v, j) => sum + v * inner.rotation[j][k], 0))) as Rotation;
  return { rotation, translation: transformPoint(outer, inner.translation), anchorIds: [...inner.anchorIds] };
}
export interface ObservationViewState {
  documentId?: string; modelKey?: string; epoch?: string; frame?: number; mode?: string; anchorKey?: string;
  base: RigidTransform; relative: RigidTransform; transform: RigidTransform;
}
export const emptyObservationView = (): ObservationViewState => ({ base: identityTransform(), relative: identityTransform(), transform: identityTransform() });
const modelKey = (structure: Structure) => structure.id;
/** Terminal states and coordinate edits hold the last observation transform.
 * Only a new validated sequence refits; a new document/model identity resets.
 * New runs compose with the old display pose instead of jumping back to raw. */
export function updateObservationView(previous: ObservationViewState, input: {
  documentId: string; structure: Structure; reference?: Structure; epoch?: string; frame?: number;
  mode?: 'auto' | 'heavy' | 'off'; frozenAtomIds?: readonly string[]; softAnchorAtomIds?: readonly string[]; fixedFrame?: boolean;
}): ObservationViewState {
  const key = modelKey(input.structure), mode = input.mode ?? 'auto';
  const same = previous.documentId === input.documentId && previous.modelKey === key;
  const old = same ? previous : emptyObservationView();
  const reset = (): ObservationViewState => ({ ...emptyObservationView(), documentId: input.documentId, modelKey: key, mode });
  if (mode === 'off' || input.fixedFrame || input.structure.cell?.pbc.some(Boolean) || input.reference?.cell?.pbc.some(Boolean)) return reset();
  if (input.frozenAtomIds?.length && input.softAnchorAtomIds === undefined) {
    // Freezing changes model state, not its already accepted display pose.
    // Remember observed frames without fitting them: thawing that same frame
    // must not suddenly fit a reference that was skipped while frozen.
    const newRun = input.epoch && old.epoch !== input.epoch;
    return { ...old, documentId: input.documentId, modelKey: key, mode,
      ...(input.reference && input.epoch ? { epoch: input.epoch, frame: input.frame,
        ...(newRun ? { base: old.transform, relative: identityTransform() } : {}) } : {}) };
  }
  if (!input.reference || !input.epoch) return { ...old, documentId: input.documentId, modelKey: key, mode };
  const newRun = old.epoch !== input.epoch;
  const anchorKey=JSON.stringify(input.softAnchorAtomIds??null);
  if (!newRun && old.frame === input.frame && old.mode === mode && old.anchorKey === anchorKey) return old;
  const ids = input.reference.atoms.map(a => [a.id, a.element]);
  // Manual add/delete/element edits invalidate the old physical run, but keep
  // the already accepted visual pose. Never fit the stale reference to them.
  if (JSON.stringify(ids) !== JSON.stringify(input.structure.atoms.map(a => [a.id, a.element]))) return { ...old, documentId: input.documentId, modelKey: key, mode };
  const base = newRun ? old.transform : old.base;
  const relative = observationAlignment(input.structure, input.reference, { mode, previous: newRun ? undefined : old.relative, softAnchorAtomIds:input.softAnchorAtomIds });
  return { documentId: input.documentId, modelKey: key, epoch: input.epoch, frame: input.frame, mode, anchorKey, base, relative, transform: composeTransforms(base, relative) };
}
type Pair = { id: string; source: Atom; target: Atom };

function quaternionRotation(q: number[]): Rotation {
  const [w, x, y, z] = q;
  return [[1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)], [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)], [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)]];
}
/** Symmetric Jacobi eigensolver: unlike power iteration this selects the
 * greatest algebraic eigenvalue even for planar or nearly degenerate frames. */
function largestEigenvector(input: number[][]): number[] {
  const a = input.map(row => [...row]), v = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => Number(i === j)));
  for (let step = 0; step < 64; step++) {
    let p = 0, q = 1;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-13) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    for (let k = 0; k < 4; k++) if (k !== p && k !== q) { const x = a[k][p], y = a[k][q]; a[k][p] = a[p][k] = c*x - s*y; a[k][q] = a[q][k] = s*x + c*y; }
    a[p][p] = c*c*app - 2*c*s*apq + s*s*aqq; a[q][q] = s*s*app + 2*c*s*apq + c*c*aqq; a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 4; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c*x - s*y; v[k][q] = s*x + c*y; }
  }
  const index = a.reduce((best, row, i) => row[i] > a[best][best] ? i : best, 0);
  return v.map(row => row[index]);
}
function rankOne(pairs: Pair[]): boolean {
  if (pairs.length < 3) return true;
  const c = centroid(pairs.map(p => p.source)), vectors = pairs.map(p => subtract(coordinates(p.source), c));
  const axis = vectors.reduce((a, b) => dot(a, a) > dot(b, b) ? a : b);
  return vectors.every(v => Math.hypot(...cross(axis, v)) < 1e-7 * Math.max(1, dot(axis, axis)));
}
function fit(pairs: Pair[], previous: RigidTransform): RigidTransform {
  const source = centroid(pairs.map(p => p.source)), target = centroid(pairs.map(p => p.target));
  let rotation: Rotation = previous.rotation.map(row => [...row]) as Rotation;
  if (rankOne(pairs)) {
    // Preserve the previous free rotation about a single/collinear anchor.
    // Align the longest identified pair with the minimum additional rotation.
    let a = pairs[0], b = pairs[0], distance = 0;
    for (const p of pairs) for (const q of pairs) { const d = dot(subtract(coordinates(p.source), coordinates(q.source)), subtract(coordinates(p.source), coordinates(q.source))); if (d > distance) { a = p; b = q; distance = d; } }
    const u0 = rotate(rotation, subtract(coordinates(b.source), coordinates(a.source))), v0 = subtract(coordinates(b.target), coordinates(a.target));
    if (Math.hypot(...u0) > 1e-9 && Math.hypot(...v0) > 1e-9) {
      const u = scale(u0, 1 / Math.hypot(...u0)), v = scale(v0, 1 / Math.hypot(...v0)), cosine = Math.max(-1, Math.min(1, dot(u, v)));
      let axis = cross(u, v), length = Math.hypot(...axis);
      if (length < 1e-9 && cosine < 0) { axis = cross(u, Math.abs(u[0]) < .8 ? [1, 0, 0] : [0, 1, 0]); length = Math.hypot(...axis); }
      if (length > 1e-9) {
        axis = scale(axis, 1 / length); const angle = Math.acos(cosine), sine = Math.sin(angle);
        const turn = (w: Vector3) => add(add(scale(w, cosine), scale(cross(axis, w), sine)), scale(axis, dot(axis, w) * (1 - cosine)));
        const cols = [0, 1, 2].map(k => turn(rotation.map(row => row[k]) as Vector3));
        rotation = [0, 1, 2].map(i => cols.map(col => col[i])) as Rotation;
      }
    }
  } else {
    const s = Array.from({ length: 3 }, () => [0, 0, 0]);
    for (const pair of pairs) { const x = subtract(coordinates(pair.source), source), y = subtract(coordinates(pair.target), target); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s[i][j] += x[i] * y[j]; }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = s;
    rotation = quaternionRotation(largestEigenvector([[xx+yy+zz, yz-zy, zx-xz, xy-yx], [yz-zy, xx-yy-zz, xy+yx, zx+xz], [zx-xz, xy+yx, -xx+yy-zz, yz+zy], [xy-yx, zx+xz, yz+zy, -xx-yy+zz]]));
  }
  return { rotation, translation: subtract(target, rotate(rotation, source)), anchorIds: pairs.map(p => p.id) };
}
const residual = (t: RigidTransform, p: Pair) => Math.hypot(...subtract(transformPoint(t, coordinates(p.source)), coordinates(p.target)));
const continuity = (t: RigidTransform, previous: RigidTransform) => t.rotation.reduce((sum, row, i) => sum + row.reduce((s, v, j) => s + (v - previous.rotation[i][j]) ** 2, 0), 0);

/** Raw XYZ enters, a proper rigid display transform leaves. IDs/order are never
 * permuted. Explicit soft anchors include H; otherwise heavy atoms are preferred. auto uses a
 * deterministic trimmed majority fit, seeded by the prior frame for continuity. */
export function observationAlignment(structure: Structure, reference: Structure, options: {
  mode?: 'auto' | 'heavy' | 'off'; previous?: RigidTransform; frozenAtomIds?: readonly string[]; softAnchorAtomIds?: readonly string[]; fixedFrame?: boolean;
} = {}): RigidTransform {
  const identity = identityTransform(), previous = options.previous ?? identity;
  if (options.mode === 'off' || options.fixedFrame || options.frozenAtomIds?.length && options.softAnchorAtomIds === undefined || structure.cell?.pbc.some(Boolean) || reference.cell?.pbc.some(Boolean)) return identity;
  if (structure.atoms.length !== reference.atoms.length) return identity;
  const targets = new Map(reference.atoms.map(a => [a.id, a]));
  if (targets.size !== reference.atoms.length || new Set(structure.atoms.map(a => a.id)).size !== structure.atoms.length || structure.atoms.some(a => !a.id || targets.get(a.id)?.element !== a.element || ![a.x, a.y, a.z].every(Number.isFinite))) return identity;
  let pairs = structure.atoms.map(source => ({ id: source.id!, source, target: targets.get(source.id)! }));
  if (pairs.some(p => ![p.target.x, p.target.y, p.target.z].every(Number.isFinite))) return identity;
  if(options.mode!=='heavy' && options.softAnchorAtomIds?.length){
    const chosen=new Set(options.softAnchorAtomIds);
    if(chosen.size!==options.softAnchorAtomIds.length || [...chosen].some(id=>!targets.has(id)))return identity;
    return fit(pairs.filter(pair=>chosen.has(pair.id)),previous);
  }
  const heavy = pairs.filter(p => p.source.element !== 'H'); if (heavy.length) pairs = heavy;
  if (!pairs.length) return identity;
  if (options.mode === 'heavy' || pairs.length < 4) return fit(pairs, previous);
  const majority = Math.max(3, Math.ceil(pairs.length * .65));
  const candidates = [fit(pairs, previous), previous];
  const oldAnchors = pairs.filter(p => previous.anchorIds.includes(p.id)); if (oldAnchors.length >= majority) candidates.push(fit(oldAnchors, previous));
  // Bounded deterministic RANSAC avoids a changed terminal group pulling the
  // entire body. No random state is shared with the physical dynamics engine.
  let seed = 0x6d2b79f5;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % pairs.length; };
  for (let i = 0; i < 96; i++) { const indices = new Set([next(), next(), next()]); if (indices.size === 3) candidates.push(fit([...indices].map(k => pairs[k]), previous)); }
  let best = candidates[0], score = Infinity;
  for (const candidate of candidates) {
    const ordered = pairs.map(p => ({ p, r: residual(candidate, p) })).sort((a, b) => a.r - b.r), chosen = ordered.slice(0, majority).map(x => x.p), refined = fit(chosen, previous);
    const errors = pairs.map(p => residual(refined, p)).sort((a, b) => a - b), value = errors.slice(0, majority).reduce((sum, e) => sum + e * e, 0) / majority;
    if (value < score - 1e-10 || Math.abs(value - score) <= 1e-10 && continuity(refined, previous) < continuity(best, previous)) { score = value; best = refined; }
  }
  // Retain all agreeing anchors rather than arbitrarily changing the trimmed
  // subset in an exactly rigid frame. This stabilizes the following frame.
  const threshold = Math.max(.015, Math.sqrt(score) * 3), anchors = pairs.filter(p => residual(best, p) <= threshold);
  return anchors.length >= majority ? fit(anchors, previous) : best;
}
