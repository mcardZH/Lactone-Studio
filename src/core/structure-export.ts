import type { Structure } from './types';
import { cartesianToFractional, cellInverse, cellParameters } from './periodic';
import { validatePeriodicSourceMetadata } from './periodic-parsers';

const f=(n:number):string=>{if(!Number.isFinite(n))throw new Error('不能导出非有限坐标。');return Object.is(n,-0)?'0':Number(n.toPrecision(15)).toString();};
const quote=(s:string):string=>{if(!s.includes("'"))return `'${s}'`;if(!s.includes('"'))return `"${s}"`;throw new Error('CIF标签含两种引号，不能安全导出。');};
/** Structure-only export. POSCAR requires a real cell; no artificial bounding box is ever created. */
export function exportStructure(s:Structure,format:'xyz'|'extxyz'|'cif'|'poscar',withCell:boolean):string {
  if(!s.atoms.length)throw new Error('没有可导出的原子。');s.atoms.forEach(a=>[a.x,a.y,a.z].forEach(f));
  validatePeriodicSourceMetadata(s);
  const cell=withCell?s.cell:undefined;if(cell)cellInverse(cell);
  if(s.periodicSource&&s.cell)throw new Error('部分平移来源与完整晶胞同时存在，不能明确保存周期来源。');
  const periodicMetadata=cell?.pbcProvenance||s.periodicSource||s.periodicWorkingSource?encodeURIComponent(JSON.stringify({version:1,coordinateUnit:'angstrom',...(cell?.pbcProvenance?{pbcProvenance:cell.pbcProvenance}:{}),...(s.periodicSource?{periodicSource:s.periodicSource}:{}),...(s.periodicWorkingSource?{periodicWorkingSource:s.periodicWorkingSource}:{})})).replace(/'/g,'%27'):undefined;
  const periodicComment=periodicMetadata?` builder_periodic=${periodicMetadata}`:'';
  const name=s.name.replace(/[\r\n"]/g,' '),electronic=`${s.charge!==null?` charge=${s.charge}`:''}${s.multiplicity!==null?` multiplicity=${s.multiplicity}`:''}`;
  if(format==='xyz'){
    const lattice=cell?` Lattice="${cell.vectors.flat().map(f).join(' ')}" pbc="${cell.pbc.map(v=>v?'T':'F').join(' ')}"${cell.origin?` Origin="${cell.origin.map(f).join(' ')}"`:''}`:'';
    const provenance=encodeURIComponent(JSON.stringify(s.atoms.map((a,i)=>({id:a.id??`${s.id}:atom:${i+1}`,sourceIndex:a.sourceIndex??i+1}))));
    return `${s.atoms.length}\n${name}${electronic}${lattice}${periodicComment} builder_atoms=${provenance}${s.cell&&!withCell?' cell_omitted=true':''}\n${s.atoms.map(a=>`${a.element} ${[a.x,a.y,a.z].map(f).join(' ')}`).join('\n')}\n`;
  }
  if(format==='extxyz'){
    const lattice=cell?` Lattice="${cell.vectors.flat().map(f).join(' ')}" pbc="${cell.pbc.map(v=>v?'T':'F').join(' ')}"${cell.origin?` Origin="${cell.origin.map(f).join(' ')}"`:''}`:'';
    return `${s.atoms.length}\nname="${name}" Properties=species:S:1:pos:R:3:id:S:1:source_index:I:1${lattice}${electronic}${periodicComment}${s.cell&&!withCell?' cell_omitted=true':''}\n${s.atoms.map((a,i)=>`${a.element} ${[a.x,a.y,a.z].map(f).join(' ')} ${encodeURIComponent(a.id??`${s.id}:atom:${i+1}`)} ${a.sourceIndex??i+1}`).join('\n')}\n`;
  }
  if(format==='cif'){
    const lines=[`data_${name.replace(/[^A-Za-z0-9_.-]/g,'_')||'structure'}`,"_space_group_name_H-M_alt 'P 1'",'_space_group_IT_number 1'];
    if(cell){const params=cellParameters(cell);['length_a','length_b','length_c','angle_alpha','angle_beta','angle_gamma'].forEach((key,i)=>lines.push(`_cell_${key} ${f(params[i])}`));lines.push(`_builder_cell_vectors '${cell.vectors.flat().map(f).join(' ')}'`,`_builder_cell_pbc '${cell.pbc.map(v=>v?'T':'F').join(' ')}'`);if(cell.origin)lines.push(`_builder_cell_origin '${cell.origin.map(f).join(' ')}'`);}
    if(periodicMetadata)lines.push(`_builder_periodic_metadata '${periodicMetadata}'`);
    // Cartesian columns plus the actual vectors retain orientation, absolute coordinates and origin.
    // A normal CIF consumer can reconstruct the equivalent canonical cell from lengths/angles.
    lines.push('loop_','_atom_site_label','_atom_site_type_symbol');
    if(cell)lines.push('_atom_site_fract_x','_atom_site_fract_y','_atom_site_fract_z');
    lines.push('_atom_site_Cartn_x','_atom_site_Cartn_y','_atom_site_Cartn_z','_atom_site_occupancy','_atom_site_builder_source_index');
    s.atoms.forEach((a,i)=>lines.push(`${quote(a.id??`${a.element}${i+1}`)} ${a.element} ${cell?cartesianToFractional(cell,[a.x,a.y,a.z]).map(f).join(' ')+' ':''}${[a.x,a.y,a.z].map(f).join(' ')} 1 ${a.sourceIndex??i+1}`));
    return lines.join('\n')+'\n';
  }
  if(format==='poscar'){
    if(!cell)throw new Error('POSCAR必须保留真实晶胞；无晶胞或关闭晶胞时请导出XYZ/CIF。');
    // Consecutive groups preserve atom order, even when one element occurs in multiple blocks.
    const species:string[]=[],counts:number[]=[];s.atoms.forEach(a=>{if(species.at(-1)===a.element)counts[counts.length-1]++;else{species.push(a.element);counts.push(1);}});
    const lines=[name,'1',...cell.vectors.map(v=>v.map(f).join(' ')),species.join(' '),counts.join(' '),'Cartesian'];
    s.atoms.forEach((a,i)=>lines.push(`${[a.x,a.y,a.z].map(f).join(' ')} id=${encodeURIComponent(a.id??`${s.id}:atom:${i+1}`)}`));
    lines.push(`# builder_metadata ${JSON.stringify({origin:cell.origin,pbc:cell.pbc,sourceIndices:s.atoms.map((a,i)=>a.sourceIndex??i+1),...(periodicMetadata?{periodicMetadata}:{})})}`);
    return lines.join('\n')+'\n';
  }
  throw new Error(`未覆盖结构导出格式${format}。`);
}
