import type { Vector3 } from '../../../core/types';
import type { SurfaceGrid, SurfaceValidDomain } from '../../../results/surface-contracts';

type GradientField = { grid: SurfaceGrid; values: Float64Array; validDomain?: SurfaceValidDomain };
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

/** Presentation normals only, sampled at unchanged source-double mesh points.
 * Cache only requested node derivatives for this one construction (both MO
 * phases may share it). No whole-volume vector array or persistent field cache.
 * The caller passes the SHAPE field, never its separately restricted mapping.
 */
export function createScalarGradientNormals(field: GradientField) {
  const { grid, values, validDomain: domain } = field, [a,b,c] = grid.axes, [,ny,nz] = grid.dimensions;
  const numerator = [cross(b,c), cross(c,a), cross(a,b)], determinant = a.reduce((sum,v,i) => sum+v*numerator[0][i],0);
  const inverse = numerator.map(row => row.map(v => v/determinant));
  const usable = domain?.kind !== 'unknown' && Number.isFinite(determinant) && determinant !== 0 && inverse.flat().every(Number.isFinite);
  const cache = new Map<number, Vector3 | null>();
  const index = (p: Vector3) => (p[0]*ny+p[1])*nz+p[2];
  const valid = (i: number) => (domain?.kind !== 'node-mask' || domain.mask[i] === 1) && Number.isFinite(values[i]);
  function nodeGradient(p: Vector3): Vector3 | null {
    const key = index(p); if (cache.has(key)) return cache.get(key)!;
    let result: Vector3 | null = null;
    if (valid(key)) {
      const derivative: number[] = [];
      for (let axis=0; axis<3; axis++) {
        const lo = [...p] as Vector3, hi = [...p] as Vector3;
        // One-sided differences are only for the actual physical box boundary.
        // An internal missing neighbour must never be bridged/extrapolated.
        lo[axis] = Math.max(0,p[axis]-1); hi[axis] = Math.min(grid.dimensions[axis]-1,p[axis]+1);
        if (!valid(index(lo)) || !valid(index(hi))) { cache.set(key,null); return null; }
        derivative.push((values[index(hi)]-values[index(lo)])/(hi[axis]-lo[axis]));
      }
      // Axes are step vectors (matrix columns): world gradient = A^-T df/di.
      const world = [0,1,2].map(axis => inverse.reduce((sum,row,i) => sum+row[axis]*derivative[i],0)) as Vector3;
      if (world.every(Number.isFinite)) result = world;
    }
    cache.set(key,result); return result;
  }
  return (position: Vector3, outward: -1 | 1 = -1): Vector3 | null => {
    if (!usable || !position.every(Number.isFinite)) return null;
    const relative = position.map((v,i) => v-grid.origin[i]), local = inverse.map(row => row.reduce((sum,v,i) => sum+v*relative[i],0));
    for (let axis=0; axis<3; axis++) {
      const roundoff = 128*Number.EPSILON*Math.max(1,Math.abs(local[axis]),inverse[axis].reduce((sum,v,i) => sum+Math.abs(v)*(Math.abs(position[i])+Math.abs(grid.origin[i])),0));
      if (!Number.isFinite(local[axis]) || local[axis] < -roundoff || local[axis] > grid.dimensions[axis]-1+roundoff) return null;
      local[axis] = Math.max(0,Math.min(grid.dimensions[axis]-1,local[axis]));
    }
    const base = local.map((v,i) => Math.min(Math.floor(v),grid.dimensions[i]-2)), fraction = local.map((v,i) => v-base[i]);
    const gradient: Vector3 = [0,0,0]; let contributionScale = 0;
    for (let x=0; x<2; x++) for (let y=0; y<2; y++) for (let z=0; z<2; z++) {
      const node = nodeGradient([base[0]+x,base[1]+y,base[2]+z]);
      // Even zero-weight corner derivatives must be reliable. This does not
      // relax shape or mapping domain admission elsewhere in the pipeline.
      if (!node) return null;
      const weight = (x?fraction[0]:1-fraction[0])*(y?fraction[1]:1-fraction[1])*(z?fraction[2]:1-fraction[2]);
      for (let axis=0; axis<3; axis++) gradient[axis] += weight*node[axis];
      contributionScale += weight*Math.hypot(...node);
    }
    const length = Math.hypot(...gradient);
    // Relative cancellation/zero-gradient fallback, not an absolute threshold
    // in field units: a tiny but reliable nonzero field still has a direction.
    if (!Number.isFinite(length) || length === 0 || length <= 64*Number.EPSILON*contributionScale) return null;
    return gradient.map(v => outward*v/length) as Vector3;
  };
}
