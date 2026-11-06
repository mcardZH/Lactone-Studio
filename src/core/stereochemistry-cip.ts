import {ELEMENTS} from './elements';
import type {Structure} from './types';

export type CarbonCipLabel='R'|'S';
export interface CipGeometryInput {mol:string;structure:Structure}
/** Build a fresh, full-precision 3D connection table. Imported MOL/wedge/parity
 * assets are deliberately excluded: these labels describe the current geometry.
 * The locked Indigo implementation performs full CIP ranking, including rings,
 * duplicate nodes for multiple bonds and remote stereocentres. */
export function cipGeometryInput(structure:Structure):CipGeometryInput|null{
  const {atoms,bonds}=structure;
  if(structure.dimension===2||structure.cell?.pbc.some(Boolean)||!atoms.length||!bonds?.length)return null;
  if(atoms.some(atom=>!ELEMENTS.includes(atom.element)||![atom.x,atom.y,atom.z].every(Number.isFinite)||atom.formalCharge!==undefined&&!Number.isSafeInteger(atom.formalCharge)))return null;
  const seen=new Set<string>();
  for(const bond of bonds){
    if(!Number.isSafeInteger(bond.a)||!Number.isSafeInteger(bond.b)||bond.a<0||bond.b<0||bond.a>=atoms.length||bond.b>=atoms.length||bond.a===bond.b||bond.kind==='coordination'||bond.orderKnown===false||bond.fractional||bond.image?.some(Boolean)||!([1,2,3].includes(bond.order)||bond.aromatic&&bond.order===1.5))return null;
    const key=[Math.min(bond.a,bond.b),Math.max(bond.a,bond.b)].join(':');if(seen.has(key))return null;seen.add(key);
  }
  const lines=['ES current geometry','  ES                3D','','  0  0  0     0  0            999 V3000','M  V30 BEGIN CTAB',`M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`,'M  V30 BEGIN ATOM'];
  atoms.forEach((atom,index)=>lines.push(`M  V30 ${index+1} ${atom.element} ${atom.x} ${atom.y} ${atom.z} ${index+1}${atom.formalCharge?` CHG=${atom.formalCharge}`:''}${atom.hydrogenMode==='explicit'?' HCOUNT=-1':''}`));
  lines.push('M  V30 END ATOM','M  V30 BEGIN BOND');
  bonds.forEach((bond,index)=>lines.push(`M  V30 ${index+1} ${bond.aromatic?4:bond.order} ${bond.a+1} ${bond.b+1}`));
  lines.push('M  V30 END BOND','M  V30 END CTAB','M  END','');
  return {mol:lines.join('\n'),structure};
}

/** Check the actual mapped atoms, coordinates, charges and complete graph before
 * accepting descriptors. No index-order assumption and no parity-to-R/S map. */
export function readCarbonCipLabels(input:CipGeometryInput,ket:string):ReadonlyMap<number,CarbonCipLabel>{
  const data=JSON.parse(ket),{atoms,bonds}=input.structure,found=new Set<number>(),edges:string[]=[],labels=new Map<number,CarbonCipLabel>();
  if(!Array.isArray(data?.root?.nodes))throw Error('立体化学解析未返回完整分子。');
  const key=(a:number,b:number,order:number)=>`${Math.min(a,b)}:${Math.max(a,b)}:${order}`;
  for(const ref of data.root.nodes){
    const node=data[ref.$ref];if(node?.type!=='molecule'||!Array.isArray(node.atoms)||!Array.isArray(node.bonds))throw Error('立体化学解析返回了不支持的结构。');
    const indices:number[]=[];
    for(const atom of node.atoms){
      const index=atom.mapping-1,source=atoms[index];
      if(!Number.isInteger(index)||!source||found.has(index)||atom.label!==source.element||(atom.charge??0)!==(source.formalCharge??0)||!Array.isArray(atom.location)||atom.location.length!==3||atom.location.some((v:unknown,axis:number)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v-[source.x,source.y,source.z][axis])>1e-6*Math.max(1,Math.abs(v))))throw Error('立体化学解析原子与当前结构不一致。');
      found.add(index);indices.push(index);
      if(source.element==='C'&&(atom.cip==='R'||atom.cip==='S'))labels.set(index,atom.cip);
    }
    for(const bond of node.bonds){if(!Array.isArray(bond.atoms)||bond.atoms.length!==2||bond.atoms.some((i:number)=>!Number.isInteger(i)||indices[i]===undefined)||![1,2,3,4].includes(bond.type))throw Error('立体化学解析键图不完整。');edges.push(key(indices[bond.atoms[0]],indices[bond.atoms[1]],bond.type));}
  }
  const expected=bonds!.map(bond=>key(bond.a,bond.b,bond.aromatic?4:bond.order)).sort();
  if(found.size!==atoms.length||JSON.stringify(edges.sort())!==JSON.stringify(expected))throw Error('立体化学解析未保留当前完整键图。');
  return labels;
}
