import type { Bond, Structure, Vector3 } from '../core/types';
import { canonicalPeriodicBond, imagesWithin, minimumImage, perceivePeriodicConnections } from '../core/periodic';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from '../core/bond-perception-parameters';
import { validateXtbPeriodicity } from './xtb/accept-result';
import { bondEvidenceGeometryKey } from '../core/bond-semantics';
import type { BondOrderObservation, XtbBondOrders, XtbCoordinateResult } from './xtb/contracts';

/** Intentionally excludes display, selection, freeze and revision metadata. */
export function bondOrderStructureKey(structure: Structure): string {
  return bondEvidenceGeometryKey(structure);
}
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function validateBondOrderEvidence(value: XtbBondOrders, structure: Structure): void {
  const aggregate=value?.definition==='mayer-wiberg'&&value.sourceField==='tblite:bond-orders'&&value.threshold===0;
  requireValue((aggregate||value?.definition === 'mayer-ao' && value.sourceField === 'wbo' && value.threshold === .1) && Array.isArray(value.entries), 'MBO来源定义无效。');
  const known = new Set(structure.atoms.map(atom => atom.id)), seen = new Set<string>();
  requireValue(value.entries.length <= structure.atoms.length * (structure.atoms.length - 1) / 2, 'MBO原子对数量无效。');
  if(aggregate)requireValue(!!structure.cell&&value.entries.length===structure.atoms.length*(structure.atoms.length-1)/2,'周期原子对聚合键级必须保留完整原子对矩阵。');
  for (const row of value.entries) {
    requireValue(Array.isArray(row.atomIds) && row.atomIds.length === 2 && row.atomIds[0] !== row.atomIds[1] && row.atomIds.every(id => typeof id === 'string' && known.has(id)), 'MBO原子身份无效。');
    requireValue(Number.isFinite(row.value) && (aggregate||row.value >= .1), 'MBO值不符合原生输出。');
    const key = JSON.stringify([...row.atomIds].sort());
    requireValue(!seen.has(key), 'MBO原子对重复。'); seen.add(key);
  }
}
export function bondOrderObservation(result: XtbCoordinateResult, current: Structure, runId: string): BondOrderObservation {
  const { request, coordinates, metadata } = result;
  requireValue(typeof runId === 'string' && runId.length > 0 && runId.length <= 100, 'MBO运行身份无效。');
  const periodic=Boolean(request.structure.cell);
  requireValue(request.method === 'gfn2' && metadata.engine === (periodic?'tblite':'xtb') && metadata.method === 'gfn2' && metadata.converged === true, 'MBO需要成功的GFN2-xTB结果。');
  validateXtbPeriodicity(request,metadata.periodic);
  requireValue(metadata.charge === request.charge && metadata.uhf === request.uhf && Number.isSafeInteger(metadata.charge) && Number.isSafeInteger(metadata.uhf) && metadata.uhf! >= 0, 'MBO电子态来源不匹配。');
  const calculation = request.calculation ?? 'optimize';
  requireValue((metadata.calculation ?? 'optimize') === calculation, 'MBO计算类型不匹配。');
  requireValue(typeof metadata.version === 'string' && metadata.version.length > 0 && Number.isFinite(metadata.energyHartree) && metadata.energyUnit === 'hartree' && metadata.coordinateUnit === 'angstrom', 'MBO结果来源或单位无效。');
  requireValue(current.atoms.length === coordinates.length && request.structure.atoms.length === coordinates.length, 'MBO原子数已变化。');
  current.atoms.forEach((atom, index) => {
    const point = coordinates[index], source = request.structure.atoms[index];
    requireValue(point?.id === atom.id && source?.id === atom.id && point.element === atom.element && source.element === atom.element && [point.x, point.y, point.z].every(Number.isFinite), 'MBO原子对应已变化。');
    requireValue(Object.is(atom.x, point.x) && Object.is(atom.y, point.y) && Object.is(atom.z, point.z), 'MBO不属于当前坐标。');
    if (calculation === 'singlepoint') requireValue(Object.is(source.x, point.x) && Object.is(source.y, point.y) && Object.is(source.z, point.z), 'MBO单点结果不能改变坐标。');
  });
  requireValue(metadata.bondOrders, '本次GFN2结果没有有效MBO。');
  requireValue(periodic?calculation==='singlepoint'&&metadata.bondOrders.sourceField==='tblite:bond-orders':metadata.bondOrders.sourceField==='wbo','MBO计算域与来源不匹配。');
  validateBondOrderEvidence(metadata.bondOrders, current);
  return { ...structuredClone(metadata.bondOrders), runId, engine: metadata.engine, version: metadata.version, method: 'gfn2', calculation, charge: metadata.charge, uhf: metadata.uhf! };
}

/** A periodic aggregate is only an aid for one geometrically unambiguous
 * nearest relation. It is never copied onto every image or a self image. */
export function periodicBondOrderConnections(structure:Structure,evidence:XtbBondOrders,parameters:EmpiricalBondPerceptionParameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS):{bonds:Bond[];issues:NonNullable<Structure['bondPerceptionIssues']>} {
  requireValue(evidence.sourceField==='tblite:bond-orders'&&structure.cell,'周期辅助成键需要真实周期原子对聚合结果。');
  requireValue(structure.cell.pbc.some(Boolean)&&structure.cell.pbcProvenance?.kind!=='unconfirmed','周期辅助连接需要明确且非空的周期轴；原始原子对结果仍可保留。');
  validateBondOrderEvidence(evidence,structure);const validated=validateEmpiricalBondParameters(parameters);
  const empirical=perceivePeriodicConnections({...structure,bonds:[]},{parameters:validated,preserveExisting:false,allowUnconfirmedPreview:true});
  const bonds=new Map(empirical.bonds.map(bond=>[canonicalPeriodicBond(bond.a,bond.b,bond.image).key,bond])),indices=new Map(structure.atoms.map((atom,index)=>[atom.id,index]));
  const quantize=(value:number)=>value<=.25?0:value<=.75?.5:value<=1.25?1:value<=1.75?1.5:value<=2.5?2:3;
  for(const entry of evidence.entries){
    const a=indices.get(entry.atomIds[0])!,b=indices.get(entry.atomIds[1])!,aa=structure.atoms[a],bb=structure.atoms[b];
    if(validated.excludedElements.includes(aa.element)||validated.excludedElements.includes(bb.element))continue;
    const nearest=minimumImage(structure,a,b),tolerance=1e-7*Math.max(1,nearest.distance),q:Vector3=[bb.x-aa.x,bb.y-aa.y,bb.z-aa.z];
    let matches=0;imagesWithin(structure.cell!,q,nearest.distance+tolerance,(_image,_delta,distance)=>{if(Math.abs(distance-nearest.distance)<=tolerance)matches++;});
    if(matches!==1)continue;
    const canonical=canonicalPeriodicBond(a,b,nearest.image),previous=bonds.get(canonical.key),order=quantize(entry.value);
    // Low aggregate values do not erase empirical metal coordination.
    if(!order){if(previous?.kind!=='coordination')bonds.delete(canonical.key);continue;}
    const bond:Bond={a:canonical.a,b:canonical.b,image:canonical.image,order,perception:'periodic-gfn2',mbo:entry.value,...(order===.5||order===1.5?{fractional:true}:{})};
    bonds.set(canonical.key,bond);
  }
  return {bonds:[...bonds.values()],issues:empirical.issues};
}
