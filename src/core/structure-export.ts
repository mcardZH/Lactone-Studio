import type { Structure } from './types';
import { cartesianToFractional, cellInverse, cellParameters } from './periodic';
import { validatePeriodicSourceMetadata } from './periodic-parsers';
import { atomicNumber } from './elements';
import { automaticStem } from './naming';
import { exportJsonChunks } from './export-json-chunks';

const f=(n:number):string=>{if(!Number.isFinite(n))throw new Error('不能导出非有限坐标。');return Object.is(n,-0)?'0':Number(n.toPrecision(15)).toString();};
const quote=(s:string):string=>{if(!s.includes("'"))return `'${s}'`;if(!s.includes('"'))return `"${s}"`;throw new Error('CIF标签含两种引号，不能安全导出。');};

export function validateGeometryAtoms(atoms: Structure['atoms']): void {
  if (!atoms.length) throw new Error('没有可导出的原子。');
  for (const atom of atoms) {
    atomicNumber(atom.element);
    if (![atom.x, atom.y, atom.z].every(Number.isFinite)) throw new Error('不能导出非有限坐标。');
  }
}

export function validateGeometryAtomIdentity(atoms: Structure['atoms'], fallbackId: (index: number) => string): void {
  const ids = new Set<string>();
  atoms.forEach((atom, index) => {
    const id = atom.id ?? fallbackId(index);
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('导出文件的原子ID缺失或重复。');
    if (atom.sourceIndex !== undefined && !Number.isSafeInteger(atom.sourceIndex)) throw new Error('导出文件的来源原子序号必须为整数。');
    ids.add(id);
  });
}

export function validateGeometryCell(cell: NonNullable<Structure['cell']>): void {
  if (!Array.isArray(cell.vectors) || cell.vectors.length !== 3 || cell.vectors.some(vector => !Array.isArray(vector) || vector.length !== 3)
    || !Array.isArray(cell.pbc) || cell.pbc.length !== 3 || cell.pbc.some(axis => typeof axis !== 'boolean')
    || cell.origin !== undefined && (!Array.isArray(cell.origin) || cell.origin.length !== 3 || !cell.origin.every(Number.isFinite))) throw new Error('导出晶胞的向量、原点或周期轴无效。');
  cellInverse(cell);
}

/** These are the only period fields exported by the geometry writers. */
function validatedGeometryPeriodicity(s: Structure, withCell: boolean): Pick<Structure, 'cell' | 'periodicSource' | 'periodicWorkingSource'> {
  const cell = withCell ? s.cell : undefined;
  const periodicSource = s.cell ? undefined : s.periodicSource;
  if (cell) validateGeometryCell(cell);
  const source = cell ? s.periodicWorkingSource : undefined;
  const fields = { cell, periodicSource, periodicWorkingSource: source };
  validatePeriodicSourceMetadata({ ...s, ...fields });
  return fields;
}
export function geometryPeriodicity(s: Structure, withCell: boolean): Pick<Structure, 'cell' | 'periodicSource' | 'periodicWorkingSource'> {
  const fields = validatedGeometryPeriodicity(s, withCell), source = fields.periodicWorkingSource;
  if (!source) return fields;
  const { structureId, name, format, coordinateUnit } = source;
  return { ...fields, periodicWorkingSource: { structureId, name, format, coordinateUnit, cell: source.cell,
    atoms: source.atoms.map(({ element, id, sourceIndex, x, y, z }) => ({ element, id, sourceIndex, x, y, z })) } };
}

export function validateXyzGeometry(s: Structure, format: 'xyz' | 'extxyz', withCell: boolean): void {
  validateGeometryAtoms(s.atoms);
  validateGeometryAtomIdentity(s.atoms, i => `${s.id}:atom:${i + 1}`);
  validatedGeometryPeriodicity(s, withCell);
  if (format === 'extxyz') for (const [i, atom] of s.atoms.entries()) encodeURIComponent(atom.id ?? `${s.id}:atom:${i + 1}`);
}

/** The comment extension is supplied by the trajectory owner before the first atom. */
export function* exportXyzChunks(s: Structure, format: 'xyz' | 'extxyz', withCell: boolean, commentExtension = ''): Generator<string> {
  validateGeometryAtoms(s.atoms);
  validateGeometryAtomIdentity(s.atoms, i => `${s.id}:atom:${i + 1}`);
  const {cell,periodicSource,periodicWorkingSource}=geometryPeriodicity(s,withCell);
  const name=automaticStem(s.name),electronic=`${Number.isSafeInteger(s.charge)?` charge=${s.charge}`:''}${Number.isSafeInteger(s.multiplicity)&&s.multiplicity!>0?` multiplicity=${s.multiplicity}`:''}`;
  const lattice=cell?` Lattice="${cell.vectors.flat().map(f).join(' ')}" pbc="${cell.pbc.map(v=>v?'T':'F').join(' ')}"${cell.origin?` Origin="${cell.origin.map(f).join(' ')}"`:''}`:'';
  yield `${s.atoms.length}\n`;
  yield format === 'xyz' ? name + electronic + lattice : `name="${name}" Properties=species:S:1:pos:R:3:id:S:1:source_index:I:1${lattice}${electronic}`;
  if (cell?.pbcProvenance || periodicSource || periodicWorkingSource) {
    yield ' builder_periodic=';
    for (const part of exportJsonChunks({version:1,coordinateUnit:'angstrom',pbcProvenance:cell?.pbcProvenance,periodicSource,periodicWorkingSource})) {
      yield encodeURIComponent(part).replace(/'/g,'%27');
    }
  }
  if (format === 'xyz') {
    yield ' builder_atoms=%5B';
    for (const [i, atom] of s.atoms.entries()) {
      const record = { id: atom.id ?? `${s.id}:atom:${i + 1}`, sourceIndex: atom.sourceIndex ?? i + 1 };
      yield (i ? '%2C' : '') + encodeURIComponent(JSON.stringify(record));
    }
    yield '%5D';
  }
  yield `${s.cell&&!withCell?' cell_omitted=true':''}${commentExtension}\n`;
  for (const [i, atom] of s.atoms.entries()) {
    const coordinates = `${atom.element} ${[atom.x,atom.y,atom.z].map(f).join(' ')}`;
    yield format === 'xyz' ? coordinates + '\n'
      : `${coordinates} ${encodeURIComponent(atom.id??`${s.id}:atom:${i+1}`)} ${atom.sourceIndex??i+1}\n`;
  }
}

/** Structure-only export. POSCAR requires a real cell; no artificial bounding box is ever created. */
export function exportStructure(s:Structure,format:'xyz'|'extxyz'|'cif'|'poscar',withCell:boolean):string {
  if(format==='xyz'||format==='extxyz')return [...exportXyzChunks(s,format,withCell)].join('');
  validateGeometryAtoms(s.atoms);
  validateGeometryAtomIdentity(s.atoms, i => format === 'cif' ? `${s.atoms[i].element}${i + 1}` : `${s.id}:atom:${i + 1}`);
  const {cell,periodicSource,periodicWorkingSource}=geometryPeriodicity(s,withCell);
  const periodicMetadata=cell?.pbcProvenance||periodicSource||periodicWorkingSource?encodeURIComponent(JSON.stringify({version:1,coordinateUnit:'angstrom',pbcProvenance:cell?.pbcProvenance,periodicSource,periodicWorkingSource})).replace(/'/g,'%27'):undefined;
  const periodicComment=periodicMetadata?` builder_periodic=${periodicMetadata}`:'';
  const name=automaticStem(s.name);
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
