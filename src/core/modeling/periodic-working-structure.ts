import type { Structure } from '../types';
import { cellInverse } from '../periodic';

/** Adapt editable work models only. Raw file readers and result objects retain
 * their original scientific periodicity and all source calculation conditions. */
export function periodicWorkingStructure(source:Structure):Structure {
  if(!source.cell?.pbc.some(Boolean)||source.periodicSource)return source;
  cellInverse(source.cell);
  if(source.cell.pbc.every(Boolean)&&source.dimension!==2)return source;
  const structure=structuredClone(source);
  structure.periodicWorkingSource??={structureId:source.id,name:source.name,format:source.format,
    cell:structuredClone(source.cell),atoms:structuredClone(source.atoms),coordinateUnit:'angstrom'};
  structure.cell!.pbc=[true,true,true];
  structure.cell!.pbcProvenance={kind:'format-defined',evidence:'Ester Studio三维周期工作表示；原来源晶胞、坐标与PBC独立保存在periodicWorkingSource。'};
  structure.dimension=3;
  return structure;
}
