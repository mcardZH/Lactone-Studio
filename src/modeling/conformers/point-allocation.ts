import {CONFORMER_GEOMETRY_TOLERANCE} from './geometry';

export type ConformerPointCountMode = 'automatic'|'manual';
export interface ConformerPointAllocationRow {enabled:boolean;pointCount:number;pointCountMode?:ConformerPointCountMode}
export function conformerTorsionCombinationCount(rows:readonly ConformerPointAllocationRow[]):string {
  const active=rows.filter(row=>row.enabled);
  if(!active.length)return '0';
  return active.reduce((count,row)=>{
    if(!Number.isSafeInteger(row.pointCount)||row.pointCount<1||row.pointCount>CONFORMER_GEOMETRY_TOLERANCE.maxPointsPerTorsion)throw Error('柔性键撒点数须为1–4096的整数。');
    return count*BigInt(row.pointCount);
  },1n).toString();
}
/** Manual locks and disabled rows survive target changes. A blank target retains
 * every current count. Balanced automatic axes create a pool, not promised frames. */
export function allocateConformerTorsionPoints<T extends ConformerPointAllocationRow>(rows:readonly T[],target:number|null):T[] {
  if(target===null)return rows.map(row=>({...row}));
  if(!Number.isSafeInteger(target)||target<1)throw Error('预期有效帧数须为正整数或留空。');
  const next=rows.map(row=>({...row}));
  const automatic=next.filter(row=>row.enabled&&row.pointCountMode!=='manual');
  automatic.forEach(row=>{row.pointCount=1;});
  let product=BigInt(conformerTorsionCombinationCount(next));
  while(product<BigInt(target)){
    const candidate=automatic.filter(row=>row.pointCount<CONFORMER_GEOMETRY_TOLERANCE.maxPointsPerTorsion)
      .sort((a,b)=>a.pointCount-b.pointCount)[0];
    if(!candidate)break;
    product=product/BigInt(candidate.pointCount)*BigInt(candidate.pointCount+1);candidate.pointCount++;
  }
  return next;
}
