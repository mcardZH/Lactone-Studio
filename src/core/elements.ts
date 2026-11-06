import type { Atom } from './types';

export const ELEMENTS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');

export function elementSymbol(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const z = Number(trimmed);
    if (z < 1 || z > ELEMENTS.length) throw new Error(`不支持原子序数 ${trimmed}。`);
    return ELEMENTS[z - 1];
  }
  const result = trimmed[0]?.toUpperCase() + trimmed.slice(1).toLowerCase();
  if (!ELEMENTS.includes(result)) throw new Error(`无法识别元素“${value}”；不会丢弃该原子。`);
  return result;
}

export function atomicNumber(element: string): number {
  const n = ELEMENTS.indexOf(element) + 1;
  if (!n) throw new Error(`未知元素 ${element}。`);
  return n;
}

export function electronCount(atoms: Atom[], charge: number): number {
  return atoms.reduce((total, atom) => total + atomicNumber(atom.element), 0) - charge;
}

export function suggestedMultiplicity(atoms: Atom[], charge: number): number {
  return electronCount(atoms, charge) % 2 === 0 ? 1 : 2;
}

export function electronicStateError(atoms: Atom[], charge: number, multiplicity: number): string | null {
  if (!Number.isInteger(charge)) return '总电荷必须是整数。';
  if (!Number.isInteger(multiplicity) || multiplicity < 1) return '自旋多重度必须是正整数。';
  const count = electronCount(atoms, charge);
  if (count < 1) return '当前原型需要至少一个电子，请核对结构和总电荷。';
  if (multiplicity - 1 > count) return '自旋多重度超出了当前电子数允许的范围。';
  if ((count - (multiplicity - 1)) % 2 !== 0) return `${count} 个电子与多重度 ${multiplicity} 奇偶不相容，请合理选择电荷和自旋。`;
  return null;
}

export function molecularFormula(atoms: Atom[]): string {
  const counts = new Map<string, number>();
  atoms.forEach(atom => counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1));
  const symbols = [...counts.keys()].sort((a, b) => {
    if (counts.has('C')) {
      if (a === 'C') return -1;
      if (b === 'C') return 1;
      if (a === 'H') return -1;
      if (b === 'H') return 1;
    }
    return a.localeCompare(b);
  });
  return symbols.map(symbol => `${symbol}${counts.get(symbol)! > 1 ? counts.get(symbol) : ''}`).join('');
}
