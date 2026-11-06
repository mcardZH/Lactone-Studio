import type { Atom, Bond, Vector3 } from '../types';
import { builderPosition, builderVector } from '../builder-geometry';

type Graph = { atoms: readonly Atom[]; bonds: readonly Bond[] };
/** Narrow construction rule: neutral, single-bonded N directly attached to
 * an explicit C=O. Not a general conjugation/hybridization or amide detector.
 * Only template construction calls this; imported/copied XYZ is not repaired. */
export function templateAmideCarbonyl(graph: Graph, nitrogenIndex: number): { carbon: number; oxygen: number } | undefined {
  const nitrogen = graph.atoms[nitrogenIndex];
  if (nitrogen?.element !== 'N' || (nitrogen.formalCharge ?? 0) !== 0) return undefined;
  const edges = graph.bonds.filter(b => b.a === nitrogenIndex || b.b === nitrogenIndex);
  if (!edges.length || edges.some(b => b.order !== 1 || b.aromatic || b.kind === 'coordination')) return undefined;
  for (const edge of edges) {
    const carbon = edge.a === nitrogenIndex ? edge.b : edge.a;
    if (graph.atoms[carbon]?.element !== 'C' || (graph.atoms[carbon].formalCharge ?? 0) !== 0) continue;
    const carbonyl = graph.bonds.find(b => (b.a === carbon || b.b === carbon) && b.order === 2 && !b.aromatic && b.kind !== 'coordination'
      && graph.atoms[b.a === carbon ? b.b : b.a]?.element === 'O' && (graph.atoms[b.a === carbon ? b.b : b.a].formalCharge ?? 0) === 0);
    if (carbonyl) return { carbon, oxygen: carbonyl.a === carbon ? carbonyl.b : carbonyl.a };
  }
  return undefined;
}

export function templateAmidePlaneNormal(graph: Graph, nitrogenIndex: number): Vector3 | undefined {
  const carbonyl = templateAmideCarbonyl(graph, nitrogenIndex);
  if (!carbonyl) return undefined;
  const n = builderPosition(graph.atoms[nitrogenIndex]), c = builderPosition(graph.atoms[carbonyl.carbon]), o = builderPosition(graph.atoms[carbonyl.oxygen]);
  const normal = builderVector.cross(builderVector.sub(c, n), builderVector.sub(o, n)), length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length < 1e-9) throw new Error('酰胺模板的N-C=O平面方向退化，未猜测补H平面。');
  return builderVector.scale(normal, 1 / length);
}
