import type { Bond, Structure } from './types';
import { imagesWithin, minimumImage, requireConfirmedPeriodicity } from './periodic';

/** Rendering bins, not universal chemical thresholds. Exact ties choose lower. */
export function quantizeMbo(value: number): 0 | 0.5 | 1 | 1.5 | 2 | 3 {
  if (!Number.isFinite(value) || value < 0) throw new Error('MBO必须为有限非负数。');
  return value <= .25 ? 0 : value <= .75 ? .5 : value <= 1.25 ? 1 : value <= 1.75 ? 1.5 : value <= 2.5 ? 2 : 3;
}

/** Shared in-memory/file boundary. Atom endpoint validation stays with its owner. */
export function validateBondSemantics(bond: Bond, structure?: Structure): void {
  if (![.5, 1, 1.5, 2, 3, 4].includes(bond.order)) throw new Error('不支持该键级。');
  if (bond.aromatic !== undefined && typeof bond.aromatic !== 'boolean'
      || bond.fractional !== undefined && typeof bond.fractional !== 'boolean'
      || bond.fractional && (![.5, 1.5].includes(bond.order) || bond.aromatic === true)
      || bond.order === .5 && bond.fractional !== true)
    throw new Error('非芳香0.5/1.5分数键标记与实际键级冲突。');
  if (bond.orderKnown !== undefined && bond.orderKnown !== false || bond.orderKnown === false && !['periodic-distance','empirical-distance'].includes(bond.perception??'')) throw new Error('未知键级必须有明确经验几何连接来源。');
  if (bond.perception === 'periodic-distance') {
    if (bond.orderKnown !== false || bond.order !== 1 || bond.aromatic || bond.fractional || bond.mbo !== undefined || !bond.image || bond.image.length !== 3 || !bond.image.every(Number.isSafeInteger)) throw new Error('周期经验连接必须保留整数镜像和未知键级，不能冒共价单键或MBO。');
    return;
  }
  if (bond.perception === 'empirical-distance') {
    if (bond.orderKnown !== false || bond.order !== 1 || bond.aromatic || bond.fractional || bond.mbo !== undefined
        || bond.image && (bond.image.length !== 3 || !bond.image.every(Number.isSafeInteger))) throw new Error('经验连接必须保留未知键级，不能冒化学单键或MBO。');
    return;
  }
  if (bond.perception === 'empirical-organic') {
    if (bond.orderKnown === false || ![1,1.5,2,3].includes(bond.order) || bond.fractional || bond.mbo !== undefined || bond.kind === 'coordination'
        || (bond.order === 1.5) !== Boolean(bond.aromatic)
        || bond.image && (bond.image.length !== 3 || !bond.image.every(Number.isSafeInteger))) throw new Error('局部有机经验键型与来源标记不一致。');
    return;
  }
  if (bond.perception === undefined) {
    if (bond.mbo !== undefined) throw new Error('MBO缺少对应的成键判断来源。');
    return;
  }
  if (bond.perception === 'periodic-gfn2') {
    if (!structure || !structure.cell?.pbc.some(Boolean) || !Number.isSafeInteger(bond.a) || !Number.isSafeInteger(bond.b)
        || bond.a===bond.b || !structure.atoms[bond.a] || !structure.atoms[bond.b]
        || !bond.image || bond.image.length!==3 || bond.image.some((value,axis)=>!Number.isSafeInteger(value)||value!==0&&!structure.cell!.pbc[axis])
        || typeof bond.mbo!=='number' || !Number.isFinite(bond.mbo) || bond.mbo<=.25 || quantizeMbo(bond.mbo)!==bond.order
        || bond.aromatic===true || bond.kind==='coordination' || bond.orderKnown===false
        || Boolean(bond.fractional)!==[.5,1.5].includes(bond.order)) throw new Error('周期GFN2辅助需要真实晶胞、明确镜像与一致的MBO原值。');
    const cell=requireConfirmedPeriodicity(structure),nearest=minimumImage(structure,bond.a,bond.b),tolerance=Math.max(1e-7,nearest.distance*1e-7);
    const a=structure.atoms[bond.a],b=structure.atoms[bond.b];let nearestCount=0;
    imagesWithin(cell,[b.x-a.x,b.y-a.y,b.z-a.z],nearest.distance+tolerance,(_image,_delta,distance)=>{if(Math.abs(distance-nearest.distance)<=tolerance)nearestCount++;});
    if(nearestCount!==1||bond.image.some((value,axis)=>value!==nearest.image[axis]))throw new Error('周期GFN2辅助只能对应无歧义的唯一最近镜像。');
    return;
  }
  if (bond.perception === 'gfn2-mbo') {
    if (typeof bond.mbo !== 'number' || !Number.isFinite(bond.mbo) || bond.mbo <= .25
        || quantizeMbo(bond.mbo) !== bond.order || bond.aromatic === true || bond.kind === 'coordination'
        || Boolean(bond.fractional) !== [.5, 1.5].includes(bond.order) || bond.image?.some(Boolean))
      throw new Error('MBO原值、分档键级或分数键来源不一致。');
  } else if (bond.perception === 'metal-distance') {
    if (bond.order !== 1 || bond.kind !== 'coordination' || bond.fractional === true || bond.aromatic === true
        || bond.image?.some(Boolean) || bond.mbo !== undefined && (!Number.isFinite(bond.mbo) || bond.mbo <= .1 || bond.mbo > .25))
      throw new Error('距离辅助配位连接的类型或MBO来源无效。');
  } else throw new Error('未知成键判断来源。');
}

export function validateBondPerceptionIssues(structure: Structure): void {
  const issues = structure.bondPerceptionIssues;
  if (issues === undefined) return;
  if (!Array.isArray(issues) || issues.length > (structure.cell ? 250_000 : structure.atoms.length * (structure.atoms.length - 1) / 2))
    throw new Error('未确定连接的数量或格式无效。');
  const ids = new Set(structure.atoms.map(atom => atom.id)), seen = new Set<string>();
  for (const issue of issues) {
    if (!issue || Object.keys(issue).some(key => !['atomIds', 'image', 'kind', 'reason'].includes(key))
        || !Array.isArray(issue.atomIds) || issue.atomIds.length !== 2 || issue.atomIds[0] === issue.atomIds[1] && !issue.image?.some(Boolean)
        || issue.atomIds.some(id => typeof id !== 'string' || !ids.has(id))
        || !['partial', 'weak-contact', 'unresolved'].includes(issue.kind)
        || typeof issue.reason !== 'string' || !issue.reason.trim() || issue.reason.length > 1000)
      throw new Error('未确定连接的原子对应或说明无效。');
    if (issue.image && (!structure.cell || issue.image.length !== 3 || issue.image.some((value, index) => !Number.isSafeInteger(value) || value !== 0 && !structure.cell!.pbc[index]))) throw new Error('接触候选的晶胞镜像无效。');
    const reverse = issue.atomIds[0] > issue.atomIds[1] || issue.atomIds[0] === issue.atomIds[1] && (issue.image?.find(value => value !== 0) ?? 0) < 0;
    const pair = JSON.stringify([...(reverse ? [...issue.atomIds].reverse() : issue.atomIds), (issue.image ?? [0,0,0]).map(value => reverse ? -value || 0 : value)]);
    if (seen.has(pair)) throw new Error('未确定连接的原子对重复。');
    seen.add(pair);
  }
}

/** Bond drawings are not inputs to a singlepoint; nuclei/state are. */
export function bondEvidenceGeometryKey(structure: Structure): string {
  return JSON.stringify([structure.charge, structure.multiplicity, structure.cell ?? null,
    structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.x, atom.y, atom.z])]);
}

export function clearBondEvidence(structure: Structure): void {
  for (const bond of structure.bonds ?? []) { delete bond.mbo; if (!['periodic-distance','empirical-distance','empirical-organic'].includes(bond.perception??'')) delete bond.perception; }
  // An unresolved graph does not become resolved after a rigid translation,
  // electronic-state edit or copy. Retain its surviving atom-pair annotations.
  if (structure.bondPerceptionIssues) {
    const ids = new Set(structure.atoms.map(atom => atom.id));
    structure.bondPerceptionIssues = structure.bondPerceptionIssues.filter(issue => issue.atomIds.every(id => ids.has(id)));
    if (!structure.bondPerceptionIssues.length) delete structure.bondPerceptionIssues;
  }
}
