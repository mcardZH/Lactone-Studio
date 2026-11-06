import { atomicNumber } from './elements';
import type { Structure } from './types';

export function withAtomIds(structure: Structure): Structure {
  const prefix = globalThis.crypto?.randomUUID?.() ?? 'structure-' + Date.now() + '-' + Math.random();
  return { ...structure, atoms: structure.atoms.map((atom, i) => ({ ...atom, id: atom.id ?? prefix + ':' + i, sourceIndex: atom.sourceIndex ?? i + 1 })) };
}
export function parseAtomSelection(text: string, count: number): number[] {
  const normalized = text.trim().replace(/，/g, ',');
  if (!normalized) return [];
  const selected = new Set<number>();
  for (const token of normalized.split(',')) {
    const match = token.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) throw new Error('原子编号使用1-10,21,23这样的形式。');
    const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > count || last < first || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw new Error('原子编号须在1–' + count + '内，区间从小到大。');
    for (let i = first; i <= last; i++) selected.add(i - 1);
  }
  return [...selected].sort((a,b) => a-b);
}
export function formatAtomSelection(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a,b) => a-b); const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) { const start = sorted[i]; let end = start; while (sorted[i+1] === end+1) end = sorted[++i]; ranges.push(start === end ? String(start+1) : (start+1) + '-' + (end+1)); }
  return ranges.join(',');
}
export function extractSelection(structure: Structure, indices: number[]): Structure {
  const selected = [...new Set(indices)].sort((a,b) => a-b);
  if (!selected.length || selected.some(index => !Number.isInteger(index) || index < 0 || index >= structure.atoms.length)) throw new Error('请选择有效原子，不能提取空结构。');
  const map = new Map(selected.map((index, current) => [index, current]));
  const severed = structure.bonds?.filter(bond => map.has(bond.a) !== map.has(bond.b)).length ?? 0;
  return { ...structure, id: structure.id + '-fragment', name: structure.name.replace(/\.[^.]+$/, '') + '_fragment.xyz', atoms: selected.map(index => ({ ...structure.atoms[index] })), bonds: structure.bonds?.filter(bond => map.has(bond.a) && map.has(bond.b)).map(bond => ({ ...bond, a: map.get(bond.a)!, b: map.get(bond.b)! })), charge: null, multiplicity: null, sourceRoute: undefined, molfile: undefined, groups: [], preparation: undefined, mapping: selected.map((index, current) => ({ original: structure.atoms[index].sourceIndex ?? index+1, current: current+1 })), notes: ['已提取所选原子，保留原顺序；电荷/多重度须重新核对。', severed ? '截断了' + severed + '根已知共价键，尚未自动封端；请按需要加氢或编辑。' : '未自动加氢/封端；未知成键信息时请自行核对边界。'] };
}
export function toXyz(structure: Structure): string { return structure.atoms.length + '\nGenerated structure\n' + structure.atoms.map(atom => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`).join('\n') + '\n'; }
export function toMolfile(structure: Structure): string {
  if (structure.molfile) return structure.molfile;
  if (structure.atoms.length > 999 || (structure.bonds?.length ?? 0) > 999) throw new Error('当前编辑器桥接使用V2000，限999原子/键；输入生成不受此桥接限制。');
  const bonds = structure.bonds ?? [];
  let text = 'Ester Studio working structure\n' + '  ES'.padEnd(20, ' ') + (structure.dimension === 2 ? '2D' : '3D') + '\n\n' + String(structure.atoms.length).padStart(3) + String(bonds.length).padStart(3) + '  0  0  0  0            999 V2000\n';
  text += structure.atoms.map(atom => [atom.x,atom.y,atom.z].map(value => value.toFixed(4).padStart(10)).join('') + ' ' + atom.element.padEnd(3) + ' 0  0  0  0  0  0  0  0  0  0  0  0').join('\n') + '\n';
  text += bonds.map(bond => String(bond.a+1).padStart(3) + String(bond.b+1).padStart(3) + String(bond.aromatic ? 4 : bond.order).padStart(3) + String(bond.stereo??0).padStart(3) + '  0  0  0').join('\n');
  if (bonds.length) text += '\n';
  const charges = structure.atoms.map((atom,i) => [i+1,atom.formalCharge ?? 0]).filter(([,charge]) => charge !== 0);
  for (let i = 0; i < charges.length; i += 8) { const part = charges.slice(i,i+8); text += 'M  CHG' + String(part.length).padStart(3) + part.map(([index, charge]) => String(index).padStart(4) + String(charge).padStart(4)).join('') + '\n'; }
  return text + 'M  END\n';
}
export function topologyFingerprint(structure: Structure): string { return JSON.stringify({ elements: structure.atoms.map(atom => atomicNumber(atom.element)), charges: structure.atoms.map(atom => atom.formalCharge ?? 0), bonds: structure.bonds ?? [] }); }
