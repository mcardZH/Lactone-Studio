import type { Structure } from './types';
import { builderDoubleBondConfiguration } from './builder-stereo';

function diagram(structure: Structure): Structure {
  return { ...structure, cell: undefined, atoms: structure.atoms.map(atom => {
    const point = structure.layout2D?.[atom.id!];
    return { ...atom, x: point?.x ?? atom.x, y: point?.y ?? atom.y, z: 0 };
  }) };
}

function separatedSide(structure: Structure, start: number, opposite: number): number[] | null {
  const visited = new Set<number>([start]), pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    for (const bond of structure.bonds ?? []) {
      if (bond.kind === 'coordination' || (bond.a === start && bond.b === opposite) || (bond.b === start && bond.a === opposite)) continue;
      const neighbour = bond.a === current ? bond.b : bond.b === current ? bond.a : -1;
      if (neighbour < 0 || visited.has(neighbour)) continue;
      if (neighbour === opposite) return null;
      visited.add(neighbour); pending.push(neighbour);
    }
  }
  return [...visited];
}

/** Reflect only one separable diagram branch when its defined E/Z disagrees
 * with an explicit Cartesian edit. All Cartesian coordinates stay untouched.
 * Undefined diagram configurations remain undefined, rather than inventing a
 * display orientation. A ring/multiple-boundary mismatch is rejected. */
export function synchronizeBuilderDoubleBondLayout(input: Structure, touchedIds: string[] = []): Structure {
  if (!input.layout2D || input.cell?.pbc.some(Boolean)) return input;
  let structure: Structure = { ...input, layout2D: Object.fromEntries(Object.entries(input.layout2D).map(([id,point]) => [id,{...point}])) };
  const touched = new Set(touchedIds);
  for (const bond of structure.bonds ?? []) {
    if (bond.order !== 2 || bond.aromatic || bond.kind === 'coordination') continue;
    const a = structure.atoms[bond.a].id!, b = structure.atoms[bond.b].id!;
    const actual = builderDoubleBondConfiguration(structure,a,b), shown = builderDoubleBondConfiguration(diagram(structure),a,b);
    if (actual === 'undefined' || shown === 'undefined' || actual === shown) continue;
    const candidates = [separatedSide(structure,bond.b,bond.a),separatedSide(structure,bond.a,bond.b)].filter((side):side is number[] => side !== null);
    if (!candidates.length) throw new Error('双键的二维/三维构型不一致，且环或多个连接边界无法独立翻转一侧；请明确调整局部二维布局。');
    candidates.sort((left,right) => {
      const affected = (side:number[]) => side.filter(i => touched.has(structure.atoms[i].id!)).length;
      return affected(right)-affected(left) || left.length-right.length;
    });
    const first = structure.layout2D![a], last = structure.layout2D![b];
    if (!first || !last) continue;
    const dx = last.x-first.x, dy = last.y-first.y, length = Math.hypot(dx,dy);
    if (length < 1e-8) continue;
    const ux=dx/length, uy=dy/length, layout={...structure.layout2D};
    for (const index of candidates[0]) {
      if (index === bond.a || index === bond.b) continue;
      const id=structure.atoms[index].id!, point=layout[id];
      if (!point) continue;
      const vx=point.x-first.x, vy=point.y-first.y, projection=vx*ux+vy*uy;
      layout[id]={x:first.x+2*projection*ux-vx,y:first.y+2*projection*uy-vy};
    }
    structure={...structure,layout2D:layout};
    if (builderDoubleBondConfiguration(diagram(structure),a,b) !== actual) throw new Error('双键局部二维翻转未能匹配三维构型；未应用该编辑。');
  }
  return structure;
}
