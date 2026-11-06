import type { Structure } from '../../core/types';

/** Geometry, graph and electron inventory have different confirmation scopes. */
export function modelChange(previous: Structure | null, next: Structure | null) {
  const inventory = (s: Structure | null) => JSON.stringify(s?.atoms.map(a => [a.id, a.element, a.formalCharge ?? 0]) ?? null);
  const geometry = (s: Structure | null) => JSON.stringify(s && [s.atoms.map(a => [a.id, a.x, a.y, a.z]), s.cell ?? null, s.dimension]);
  const graph = (s: Structure | null) => JSON.stringify(s && (s.bonds ?? []).map(b => [s.atoms[b.a]?.id, s.atoms[b.b]?.id, b.order, b.kind, b.image]));
  return { inventory: inventory(previous) !== inventory(next), geometry: geometry(previous) !== geometry(next), graph: graph(previous) !== graph(next) };
}
