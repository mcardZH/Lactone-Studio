import type { Structure } from '../core/types';
import { cellInverse } from '../core/periodic';

/** Shared geometry admission for automatic display and explicit empirical work.
 * Sample counts are not method limits. Source dimensionality is never rewritten. */
export function empiricalBondAdmission(source: Structure): string | null {
  if (!source.atoms.length) return '经验判断需要至少一个显式原子。';
  if (source.periodicSource?.completeness === 'partial') return '来源只有部分平移矢量，完整晶胞缺失；保留原子及原始矢量，未当作有限分子判断连接。';
  const ids = source.atoms.map(atom => atom.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return '经验判断需要唯一稳定原子身份。';
  if (source.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) return '当前帧含非有限坐标，未进行经验判断。';
  if (source.cell) {
    const cell = source.cell;
    if (!Array.isArray(cell.pbc) || cell.pbc.length !== 3 || !cell.pbc.every(flag => typeof flag === 'boolean') || !cell.pbc.some(Boolean)
      || !Array.isArray(cell.vectors) || cell.vectors.length !== 3 || !cell.vectors.every(vector => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite))
      || cell.origin !== undefined && (!Array.isArray(cell.origin) || cell.origin.length !== 3 || !cell.origin.every(Number.isFinite))) return '经验判断需要完整有效的周期晶胞及实际周期轴。';
    try { cellInverse(cell); } catch { return '经验判断需要完整有效的周期晶胞。'; }
  } else if (source.dimension === 2) return '二维结构缺少完整有效的Cartesian周期晶胞，未当作有限三维分子判断连接。';
  return null;
}
