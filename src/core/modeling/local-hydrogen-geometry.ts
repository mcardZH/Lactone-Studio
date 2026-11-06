import type { Vector3 } from '../types';
import { builderVector } from '../builder-geometry';

const { add, sub, scale, dot, cross } = builderVector;
const unit = (v: Vector3): Vector3 | null => {
  const length = Math.hypot(...v);
  return Number.isFinite(length) && length > 1e-10 ? scale(v, 1 / length) : null;
};
const sphere = Array.from({ length: 96 }, (_, i): Vector3 => {
  const z = 1 - 2 * (i + .5) / 96, r = Math.sqrt(1 - z * z), angle = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(angle), r * Math.sin(angle), z];
});

/** Explicit coordination templates. Bond multiplicity and lone pairs do not
 * create additional directions for this interactive construction policy. */
export function neighbourCountSlots(count: number): Vector3[] | undefined {
  if (count === 1) return [[1, 0, 0]];
  if (count === 2) return [[1, 0, 0], [-1, 0, 0]];
  if (count === 3) return [[1, 0, 0], [-.5, Math.sqrt(3) / 2, 0], [-.5, -Math.sqrt(3) / 2, 0]];
  if (count === 4) return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(v => unit(v as Vector3)!);
  if (count === 5) return [...neighbourCountSlots(3)!, [0, 0, 1], [0, 0, -1]];
  if (count === 6) return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  if (count === 7) return [...Array.from({length:5},(_,i):Vector3=>[Math.cos(i*2*Math.PI/5),Math.sin(i*2*Math.PI/5),0]),[0,0,1],[0,0,-1]];
  // The existing square-antiprismatic construction seed, reused here solely
  // as eight local directions; no electronic-state or equilibrium claim.
  if (count === 8) return [1,-1].flatMap(sign=>Array.from({length:4},(_,i)=>{
    const angle=i*Math.PI/2+(sign<0?Math.PI/4:0);
    return unit([Math.cos(angle),Math.sin(angle),sign*Math.sqrt(Math.SQRT1_2)])!;
  }));
  return undefined;
}

/** Fit a finite, discrete slot template using proper rotations only. Fixed
 * neighbours retain their XYZ even when their angles cannot fit the template.
 * Search all correspondences through six slots; larger named presets use a
 * bounded beam. The acceptance callback owns clash and stereochemical gates.
 * Null fixed directions still consume slots (e.g. a coincident frozen atom). */
export function fitLocalHydrogenSlots(
  slots: readonly Vector3[], fixed: readonly (Vector3 | null)[], initial: readonly (Vector3 | null)[],
  accept: (directions: Vector3[]) => boolean,
): Vector3[] {
  const references = [...fixed, ...initial];
  if (references.length > slots.length || slots.length > 10 || !initial.length) throw new Error('显式几何槽位不足，未改变原结构。');
  const perpendicular = (v: Vector3) => unit(cross(v, Math.abs(v[0]) < .8 ? [1, 0, 0] : [0, 1, 0]))!;
  let assignments: { indices: number[]; score: number }[] = [{ indices: [], score: 0 }];
  for (let depth = 0; depth < references.length; depth++) {
    const next: typeof assignments = [];
    for (const prior of assignments) for (let slot = 0; slot < slots.length; slot++) {
      if (prior.indices.includes(slot)) continue;
      let score = prior.score;
      if (references[depth]) for (let j = 0; j < depth; j++) if (references[j]) {
        const weight = depth < fixed.length && j < fixed.length ? 1 : .000001;
        score += weight * (dot(slots[slot], slots[prior.indices[j]]) - dot(references[depth]!, references[j]!)) ** 2;
      }
      next.push({ indices: [...prior.indices, slot], score });
    }
    next.sort((a, b) => a.score - b.score);
    assignments = slots.length <= 6 ? next : next.slice(0, 256);
  }
  const candidates: { directions: Vector3[]; fixedScore: number; movement: number; order: number }[] = [];
  for (const { indices } of assignments) {
    const first = references.findIndex(v => !!v);
    const a: Vector3 = first < 0 ? [1, 0, 0] : slots[indices[first]];
    const x: Vector3 = first < 0 ? [1, 0, 0] : references[first]!;
    const validPair = (i: number) => i !== first && !!references[i] && Math.hypot(...cross(a, slots[indices[i]])) > 1e-8 && Math.hypot(...cross(x, references[i]!)) > 1e-8;
    const fixedPair = references.findIndex((_, i) => i < fixed.length && validPair(i));
    const pair = fixedPair >= 0 ? fixedPair : references.findIndex((_, i) => validPair(i));
    const b = pair < 0 ? perpendicular(a) : unit(sub(slots[indices[pair]], scale(a, dot(a, slots[indices[pair]]))))!;
    const y = pair < 0 ? perpendicular(x) : unit(sub(references[pair]!, scale(x, dot(x, references[pair]!))))!;
    const c = cross(a, b), z = cross(x, y);
    // A single/collinear fixed axis leaves a free torsion. Sample that torsion
    // around a seed taken from old H; never reflect a tetrahedral template.
    const twists = fixedPair < 0 ? 32 : 1;
    for (let twist = 0; twist < twists; twist++) {
      const angle = twist * 2 * Math.PI / twists;
      const yt = add(scale(y, Math.cos(angle)), scale(z, Math.sin(angle)));
      const zt = sub(scale(z, Math.cos(angle)), scale(y, Math.sin(angle)));
      const rotate = (v: Vector3) => add(add(scale(x, dot(v, a)), scale(yt, dot(v, b))), scale(zt, dot(v, c)));
      const rotated = indices.map(i => rotate(slots[i]));
      const fixedScore = fixed.reduce((sum, v, i) => sum + (v ? 1 - dot(v, rotated[i]) : 0), 0);
      const movement = initial.reduce((sum, v, i) => sum + (v ? 1 - dot(v, rotated[i + fixed.length]) : 0), 0);
      candidates.push({ directions: rotated.slice(fixed.length), fixedScore, movement, order: candidates.length });
    }
  }
  candidates.sort((a, b) => Math.abs(a.fixedScore - b.fixedScore) > 1e-9 ? a.fixedScore - b.fixedScore
    : Math.abs(a.movement - b.movement) > 1e-9 ? a.movement - b.movement : a.order - b.order);
  for (const candidate of candidates) if (accept(candidate.directions)) return candidate.directions;
  throw new Error('固定局部几何、已指定手性或明显重叠防线下无安全加氢槽位候选。');
}

/** A bounded local angular fit, not a force field or a molecular optimization.
 * Fixed directions are never variables. Incompatible skeleton angles therefore
 * remain incompatible; the H positions only minimize their own angular error. */
export function fitLocalHydrogenDirections(
  fixed: readonly Vector3[], initial: readonly (Vector3 | null)[], targetCosine: number,
  accept: (directions: Vector3[]) => boolean = () => true,
  planeNormal?: Vector3,
): Vector3[] {
  const anchor = fixed[0] ?? initial.find((v): v is Vector3 => !!v) ?? [1, 0, 0];
  const tangent = unit(cross(anchor, Math.abs(anchor[0]) < .8 ? [1, 0, 0] : [0, 1, 0]))!;
  const normal = cross(anchor, tangent);
  const inPlane = (v: Vector3): Vector3 => planeNormal
    ? unit(sub(v, scale(planeNormal, dot(v, planeNormal)))) ?? unit(cross(planeNormal, Math.abs(planeNormal[0]) < .8 ? [1, 0, 0] : [0, 1, 0]))!
    : v;
  const cone = (angle: number) => add(scale(anchor, targetCosine), add(
    scale(tangent, Math.sqrt(1 - targetCosine * targetCosine) * Math.cos(angle)),
    scale(normal, Math.sqrt(1 - targetCosine * targetCosine) * Math.sin(angle)),
  ));
  const angularScore = (moving: readonly Vector3[]) => {
    let score = 0;
    for (let i = 0; i < moving.length; i++) {
      for (const other of fixed) score += (dot(moving[i], other) - targetCosine) ** 2;
      for (let j = 0; j < i; j++) score += (dot(moving[i], moving[j]) - targetCosine) ** 2;
    }
    return score;
  };
  // Beyond a very crowded explicit centre, avoid quadratic iterative work. Keep
  // every existing H and place just the new H by angular separation below.
  const crowded = fixed.length + initial.length > 12;
  const greedy: Vector3[] = [];
  for (let i = 0; i < initial.length; i++) {
    if (crowded && initial[i]) { greedy.push(initial[i]!); continue; }
    const neighbours = [...fixed, ...greedy];
    const candidates = [cone(i * 2 * Math.PI / 3), scale(anchor, -1), ...sphere];
    const score = (v: Vector3) => neighbours.length ? Math.max(...neighbours.map(other => dot(v, other))) : 0;
    greedy.push(candidates.reduce((best, v) => score(v) < score(best) ? v : best));
  }
  if (crowded && accept(greedy)) return greedy;
  if (crowded) {
    // Keep every old direction, trying only a bounded new-H direction. The
    // caller's acceptance includes old XYZ/stereo and obvious-clash guards.
    for (const candidate of sphere) {
      const fallback = greedy.map((v,i)=>i===greedy.length-1?inPlane(candidate):v);
      if (accept(fallback)) return fallback;
    }
    throw new Error('局部加氢无安全候选，未改变旧原子。');
  }

  // A single new H has no old-H variables. Zero/one/two fixed directions have
  // closed angular solutions; trying these bounded analytic candidates avoids
  // eleven 320-step fits on the ordinary interactive add-H path. The caller's
  // full clash/stereo gate still decides acceptance, and fixed XYZ never move.
  if (initial.length === 1 && initial[0] === null && fixed.length <= 2) {
    const analytic: Vector3[] = [];
    if (!fixed.length) analytic.push(greedy[0]);
    else if (fixed.length === 1) {
      for (let step = 0; step < 32; step++) analytic.push(inPlane(cone(step * Math.PI / 16)));
    } else {
      const sum = unit(add(fixed[0], fixed[1])), perpendicular = unit(cross(fixed[0], fixed[1]));
      if (sum) {
        const cosine = dot(sum, fixed[0]), along = Math.max(-1, Math.min(1, targetCosine / cosine));
        if (perpendicular) {
          const side = Math.sqrt(1 - along * along);
          analytic.push(inPlane(add(scale(sum, along), scale(perpendicular, side))), inPlane(sub(scale(sum, along), scale(perpendicular, side))));
        } else {
          for (let step = 0; step < 32; step++) analytic.push(inPlane(cone(step * Math.PI / 16)));
        }
      } else {
        // Antiparallel fixed directions minimize their equal angular error on
        // the perpendicular great circle, independently of target cosine.
        for (let step = 0; step < 32; step++) analytic.push(inPlane(add(scale(tangent, Math.cos(step * Math.PI / 16)), scale(normal, Math.sin(step * Math.PI / 16)))));
      }
    }
    const ranked = analytic.map((direction, order) => ({ direction, order, score: angularScore([direction]) }))
      .sort((a, b) => Math.abs(a.score - b.score) > 1e-9 ? a.score - b.score : a.order - b.order);
    for (const { direction } of ranked) if (accept([direction])) return [direction];
    // As in the former fallback, angular preferences never weaken the caller's
    // hard finite/clash/stereo checks. Exhaustion rejects without a force field.
    for (const candidate of sphere) { const direction = inPlane(candidate); if (accept([direction])) return [direction]; }
    throw new Error('固定局部几何、已指定手性或明显重叠防线下无安全加氢候选。');
  }
  if (initial.length === 1 && initial[0] === null && fixed.length === 3) {
    const [a, b, c] = fixed, determinant = dot(a, cross(b, c));
    if (Math.abs(determinant) > 1e-10) {
      const exact = scale(add(add(cross(b, c), cross(c, a)), cross(a, b)), targetCosine / determinant);
      if (Math.abs(Math.hypot(...exact) - 1) < 1e-8) {
        const direction = inPlane(unit(exact)!);
        if (angularScore([direction]) < 1e-14 && accept([direction])) return [direction];
      }
    }
  }

  const starts: Vector3[][] = [
    initial.map((v, i) => v ?? greedy[i]), greedy,
    initial.map((v, i) => v ?? unit(scale(fixed.reduce((sum, direction) => add(sum, direction), [0, 0, 0] as Vector3), -1)) ?? greedy[i]),
    // Exact tetrahedral/planar cones remove the coincident-vector stationary
    // point and make one fixed neighbour independent of laboratory axes.
    initial.map((_, i) => fixed.length ? cone(i * 2 * Math.PI / 3) : i === 0 ? anchor : cone((i - 1) * 2 * Math.PI / 3)),
    ...Array.from({ length: 7 }, (_, seed) => initial.map((_, i) => sphere[(seed * 13 + i * 29) % sphere.length])),
  ];
  let best: Vector3[] | undefined, bestScore = Infinity, bestMovement = Infinity;
  for (const start of starts) {
    let moving = start.map(v => inPlane([...v] as Vector3)), score = angularScore(moving), step = .18;
    for (let iteration = 0; iteration < 320; iteration++) {
      const next = moving.map((v, i) => {
        let gradient: Vector3 = [0, 0, 0];
        for (const other of fixed) gradient = add(gradient, scale(other, 2 * (dot(v, other) - targetCosine)));
        for (let j = 0; j < moving.length; j++) if (i !== j) gradient = add(gradient, scale(moving[j], 2 * (dot(v, moving[j]) - targetCosine)));
        const projected = sub(gradient, scale(v, dot(v, gradient)));
        return inPlane(unit(sub(v, scale(projected, step))) ?? v);
      });
      const nextScore = angularScore(next);
      if (nextScore > score + 1e-14) { step *= .5; if (step < 1e-9) break; continue; }
      moving = next; score = nextScore; step = Math.min(.2, step * 1.025);
      if (score < 1e-14) break;
    }
    if (!accept(moving)) continue;
    const movement = moving.reduce((sum, v, i) => sum + (initial[i] ? 1 - dot(v, initial[i]!) : 0), 0);
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && movement < bestMovement)) {
      best = moving; bestScore = score; bestMovement = movement;
    }
  }
  // Existing directions are a safe fallback when fixed constraints and an
  // explicitly specified parity leave no accepted fitted candidate.
  if (best) return best;
  for (const candidate of sphere) {
    const fallback = initial.map((v, i) => inPlane(v ?? (i === initial.length - 1 ? candidate : greedy[i])));
    if (accept(fallback)) return fallback;
  }
  throw new Error('固定局部几何、已指定手性或明显重叠防线下无安全加氢候选。');
}
