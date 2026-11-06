import type { Atom } from '../../../core/types';

/** Exact canonical-symbol Jmol table from locked 3Dmol 2.5.5 colors.ts.
 * Case aliases are not different elements. Do not recolour common elements to
 * obtain an arbitrary new palette. Every defined real element has a distinct
 * Jmol colour, so that table needs no duplicate-colour override. */
export const ELEMENT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  H: '#ffffff', He: '#d9ffff', Li: '#cc80ff', Be: '#c2ff00', B: '#ffb5b5',
  C: '#909090', N: '#3050f8', O: '#ff0d0d', F: '#90e050', Ne: '#b3e3f5',
  Na: '#ab5cf2', Mg: '#8aff00', Al: '#bfa6a6', Si: '#f0c8a0', P: '#ff8000',
  S: '#ffff30', Cl: '#1ff01f', Ar: '#80d1e3', K: '#8f40d4', Ca: '#3dff00',
  Sc: '#e6e6e6', Ti: '#bfc2c7', V: '#a6a6ab', Cr: '#8a99c7', Mn: '#9c7ac7',
  Fe: '#e06633', Co: '#f090a0', Ni: '#50d050', Cu: '#c88033', Zn: '#7d80b0',
  Ga: '#c28f8f', Ge: '#668f8f', As: '#bd80e3', Se: '#ffa100', Br: '#a62929',
  Kr: '#5cb8d1', Rb: '#702eb0', Sr: '#00ff00', Y: '#94ffff', Zr: '#94e0e0',
  Nb: '#73c2c9', Mo: '#54b5b5', Tc: '#3b9e9e', Ru: '#248f8f', Rh: '#0a7d8c',
  Pd: '#006985', Ag: '#c0c0c0', Cd: '#ffd98f', In: '#a67573', Sn: '#668080',
  Sb: '#9e63b5', Te: '#d47a00', I: '#940094', Xe: '#429eb0', Cs: '#57178f',
  Ba: '#00c900', La: '#70d4ff', Ce: '#ffffc7', Pr: '#d9ffc7', Nd: '#c7ffc7',
  Pm: '#a3ffc7', Sm: '#8fffc7', Eu: '#61ffc7', Gd: '#45ffc7', Tb: '#30ffc7',
  Dy: '#1fffc7', Ho: '#00ff9c', Er: '#00e675', Tm: '#00d452', Yb: '#00bf38',
  Lu: '#00ab24', Hf: '#4dc2ff', Ta: '#4da6ff', W: '#2194d6', Re: '#267dab',
  Os: '#266696', Ir: '#175487', Pt: '#d0d0e0', Au: '#ffd123', Hg: '#b8b8d0',
  Tl: '#a6544d', Pb: '#575961', Bi: '#9e4fb5', Po: '#ab5c00', At: '#754f45',
  Rn: '#428296', Fr: '#420066', Ra: '#007d00', Ac: '#70abfa', Th: '#00baff',
  Pa: '#00a1ff', U: '#008fff', Np: '#0080ff', Pu: '#006bff', Am: '#545cf2',
  Cm: '#785ce3', Bk: '#8a4fe3', Cf: '#a136d4', Es: '#b31fd4', Fm: '#b31fba',
  Md: '#b30da6', No: '#bd0d87', Lr: '#c70066', Rf: '#cc0059', Db: '#d1004f',
  Sg: '#d90045', Bh: '#e00038', Hs: '#e6002e', Mt: '#eb0026',
});
/** Only elements absent from Jmol share its fallback. Split that collision
 * without changing any existing canonical Jmol colour. */
const MISSING_JMOL: Readonly<Record<string, string>> = Object.freeze({
  Ds: '#7c9da8', Rg: '#8d8bb1', Cn: '#af9da8', Nh: '#a8aa7e', Fl: '#7fab95',
  Mc: '#ac82a4', Lv: '#ab9980', Ts: '#8394b6', Og: '#a8b2bd',
});
const FALLBACK = '#8d9da8';
export function elementColor(element: string, custom?: Record<string, string>): string {
  const color = custom?.[element];
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : ELEMENT_COLORS[element] ?? MISSING_JMOL[element] ?? FALLBACK;
}
export function presentElementColors(atoms: readonly Atom[], custom?: Record<string, string>) {
  const counts = new Map<string, number>();
  for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1);
  return [...counts].map(([element, count]) => ({ element, count, color: elementColor(element, custom) }));
}
