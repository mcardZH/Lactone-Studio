import type { Structure, Vector3 } from '../types';
import { builderPosition, builderVector } from '../builder-geometry';
import { minimumImage } from '../periodic';

/** Cordero et al. DOI 10.1039/B801115J, checked against official ASE commit
 * 6cb8784ac1056b7b897822ff7b763a323d92a543, ase/data/__init__.py.
 * ASE's `missing = 0.2` entries are deliberately excluded. */
export const METAL_COVALENT_RADII: Readonly<Record<string, number>> = Object.freeze({
  Li:1.28,Be:.96,Na:1.66,Mg:1.41,Al:1.21,K:2.03,Ca:1.76,Sc:1.70,Ti:1.60,V:1.53,
  Cr:1.39,Mn:1.39,Fe:1.32,Co:1.26,Ni:1.24,Cu:1.32,Zn:1.22,Ga:1.22,
  Rb:2.20,Sr:1.95,Y:1.90,Zr:1.75,Nb:1.64,Mo:1.54,Tc:1.47,Ru:1.46,Rh:1.42,Pd:1.39,Ag:1.45,Cd:1.44,In:1.42,Sn:1.39,
  Cs:2.44,Ba:2.15,La:2.07,Ce:2.04,Pr:2.03,Nd:2.01,Pm:1.99,Sm:1.98,Eu:1.98,Gd:1.96,Tb:1.94,Dy:1.92,Ho:1.92,Er:1.89,Tm:1.90,Yb:1.87,Lu:1.87,
  Hf:1.75,Ta:1.70,W:1.62,Re:1.51,Os:1.44,Ir:1.41,Pt:1.36,Au:1.36,Hg:1.32,Tl:1.45,Pb:1.46,Bi:1.48,Po:1.40,
  Fr:2.60,Ra:2.21,Ac:2.15,Th:2.06,Pa:2.00,U:1.96,Np:1.90,Pu:1.87,Am:1.80,Cm:1.69,
});
const unsupportedMetals = new Set('Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv'.split(' '));
/** New explicit single M–H seed only. Other pairs keep their existing policy. */
export function metalHydrogenConstructionLength(element: string): number | undefined {
  const radius = METAL_COVALENT_RADII[element];
  if (radius !== undefined) return .90 * (radius + .31);
  if (unsupportedMetals.has(element)) throw new Error(`${element}–H 缺少已核 Cordero 共价半径，未猜测距离。`);
  return undefined;
}

// Initial construction lengths in Angstrom, not optimized or measured bonds.
// Common organic pairs retain familiar seed lengths; other supported pairs use
// the same covalent radii as the existing builder, with explicit order factors.
// B=.85 is the retained construction seed policy; periodic connectivity uses
// its own B=.84 threshold reference. These are not interchangeable FF parameters.
const radii: Record<string, number> = { H: .31, B: .85, C: .76, N: .71, O: .66, F: .57, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.2, I: 1.39, Fe: 1.32, Ca: 1.76 };
const common: Record<string, readonly number[]> = {
  'C-C': [1.54, 1.4, 1.34, 1.2], 'C-N': [1.47, 1.36, 1.29, 1.16],
  'C-O': [1.43, 1.36, 1.23], 'N-N': [1.45, 1.35, 1.25, 1.1], 'N-O': [1.4, 1.3, 1.21], 'O-O': [1.48, 1.35, 1.21],
  'C-H': [1.09], 'H-N': [1.01], 'H-O': [.96], 'H-S': [1.34],
};
export function constructionBondLength(a: string, b: string, order: number): number {
  const index = [1, 1.5, 2, 3].indexOf(order);
  if (index < 0) throw new Error('新接键需要明确支持的键级。');
  const metalHydrogen = order === 1 ? a === 'H' ? metalHydrogenConstructionLength(b) : b === 'H' ? metalHydrogenConstructionLength(a) : undefined : undefined;
  if (metalHydrogen !== undefined) return metalHydrogen;
  const known = common[[a, b].sort().join('-')]?.[index];
  if (known !== undefined) return known;
  if (radii[a] === undefined || radii[b] === undefined) throw new Error('新接键元素缺少已核构造长度，未猜测距离。');
  return (radii[a] + radii[b]) * [1, .92, .88, .79][index];
}

/** Actual exterior direction, retaining a declared image instead of silently
 * selecting a different periodic neighbour. */
export function externalBondDelta(structure: Structure, hostIndex: number, otherIndex: number): Vector3 {
  const bond = structure.bonds?.find(b => b.a === hostIndex && b.b === otherIndex || b.b === hostIndex && b.a === otherIndex);
  if (bond?.image && structure.cell) {
    return structure.cell.vectors.reduce<Vector3>((delta, axis, k) => builderVector.add(delta, builderVector.scale(axis, bond.image![k] * (bond.a === hostIndex ? 1 : -1))), builderVector.sub(builderPosition(structure.atoms[otherIndex]), builderPosition(structure.atoms[hostIndex])));
  }
  return minimumImage(structure, hostIndex, otherIndex).delta;
}

export function terminalHydrogenSlot(structure: Structure, hostIndex: number, incomingElement: string): { origin: Vector3; direction: Vector3; parentIndex: number } | undefined {
  const host = structure.atoms[hostIndex];
  if (!host || host.element !== 'H') return undefined;
  const edges = (structure.bonds ?? []).filter(b => b.a === hostIndex || b.b === hostIndex);
  if (edges.length !== 1 || edges[0].order !== 1 || edges[0].kind === 'coordination' || edges[0].aromatic) return undefined;
  const parentIndex = edges[0].a === hostIndex ? edges[0].b : edges[0].a;
  if (parentIndex === hostIndex) return undefined;
  const delta = externalBondDelta(structure, hostIndex, parentIndex), distance = Math.hypot(...delta);
  if (!Number.isFinite(distance) || distance < 1e-9) throw new Error('末端H槽的外部连接方向退化，未提交。');
  const direction = builderVector.scale(delta, -1 / distance);
  const length = constructionBondLength(structure.atoms[parentIndex].element, incomingElement, 1);
  return { parentIndex, direction, origin: builderVector.add(builderPosition(host), builderVector.scale(direction, length - distance)) };
}
