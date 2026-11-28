import { isPeriodic } from '../periodic';
import type { Structure } from '../types';
import type { BondOrderObservation, XtbBondOrders } from './contracts';

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function validateBondOrderEvidence(value: XtbBondOrders, structure: Structure): void {
  const aggregate=value?.definition==='mayer-wiberg'&&value.sourceField==='tblite:bond-orders'&&value.threshold===0;
  requireValue((aggregate||value?.definition === 'mayer-ao' && value.sourceField === 'wbo' && value.threshold === .1) && Array.isArray(value.entries), 'MBO来源定义无效。');
  const known = new Set(structure.atoms.map(atom => atom.id)), seen = new Set<string>();
  requireValue(value.entries.length <= structure.atoms.length * (structure.atoms.length - 1) / 2, 'MBO原子对数量无效。');
  if(aggregate)requireValue(isPeriodic(structure)&&value.entries.length===structure.atoms.length*(structure.atoms.length-1)/2,'周期原子对聚合键级必须保留完整原子对矩阵。');
  for (const row of value.entries) {
    requireValue(Array.isArray(row.atomIds) && row.atomIds.length === 2 && row.atomIds[0] !== row.atomIds[1] && row.atomIds.every(id => typeof id === 'string' && known.has(id)), 'MBO原子身份无效。');
    requireValue(Number.isFinite(row.value) && (aggregate||row.value >= .1), 'MBO值不符合原生输出。');
    const key = JSON.stringify([...row.atomIds].sort());
    requireValue(!seen.has(key), 'MBO原子对重复。'); seen.add(key);
  }
}
export function validateOptimizationBondOrderObservation(value: BondOrderObservation, structure: Structure): void {
  validateBondOrderEvidence(value,structure);
  const periodic=isPeriodic(structure);
  requireValue(typeof value.runId==='string'&&value.runId.length>0&&value.runId.length<=100&&
    typeof value.version==='string'&&value.version.length>0&&value.method==='gfn2'&&
    Number.isSafeInteger(value.charge)&&Number.isSafeInteger(value.uhf)&&value.uhf>=0&&
    value.charge===structure.charge&&value.uhf+1===structure.multiplicity&&
    (periodic?value.engine==='tblite'&&value.sourceField==='tblite:bond-orders'&&value.calculation==='singlepoint'
      :value.engine==='xtb'&&value.sourceField==='wbo'&&value.calculation==='optimize'), '键级结果与本次优化的来源或电子态不一致。');
}
