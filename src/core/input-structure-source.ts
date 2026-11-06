import type { InputStructureSource, Structure } from './types';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
/** Source provenance only. Engine method/default/PES rules stay in each writer. */
export function inputStructureSourceIdentity(value:unknown):string|null{
  if(!object(value)||!text(value.documentId)||!Number.isSafeInteger(value.revision)||Number(value.revision)<0||typeof value.confirmed!=='boolean'||value.geometryUnits!=='angstrom'||!Number.isSafeInteger(value.charge)||!Number.isSafeInteger(value.multiplicity)||Number(value.multiplicity)<1)return null;
  if(value.documentEpoch!==undefined&&!text(value.documentEpoch)||value.sourceEpoch!==undefined&&(!Number.isSafeInteger(value.sourceEpoch)||Number(value.sourceEpoch)<0))return null;
  if(!object(value.structure)||!text(value.structure.id)||!Array.isArray(value.structure.atoms))return null;
  const s=value.structure,atoms=s.atoms as unknown[];
  if(atoms.some(a=>!object(a)||!text(a.id)||typeof a.element!=='string'||![a.x,a.y,a.z].every(v=>typeof v==='number'&&Number.isFinite(v))))return null;
  try{return JSON.stringify([value.documentId,value.documentEpoch??null,value.sourceEpoch??null,value.revision,value.charge,value.multiplicity,value.confirmed,value.geometryUnits,s.id,s.dimension,s.cell??null,s.charge,s.multiplicity,atoms.map(a=>{const atom=a as Record<string,unknown>;return [atom.id,atom.element,atom.x,atom.y,atom.z];})]);}catch{return null;}
}
export const inputStructureSourceKey=(source:InputStructureSource)=>JSON.stringify([source.documentId,source.revision,source.documentEpoch??null,source.sourceEpoch??null]);
export function inputStructureSourceIsCurrent(source:InputStructureSource|null|undefined,candidates:unknown):boolean{
  const identity=inputStructureSourceIdentity(source);if(!identity||!Array.isArray(candidates))return false;
  const matches=candidates.filter(candidate=>object(candidate)&&candidate.documentId===source!.documentId);
  return matches.length>0&&matches.every(candidate=>inputStructureSourceIdentity(candidate)===identity);
}
export function inputStructureBodyMatches(source:InputStructureSource,structure:Structure|null|undefined,charge:number,multiplicity:number):boolean{
  if(!inputStructureSourceIdentity(source)||!object(structure)||!Array.isArray(structure.atoms)||structure.atoms.some(a=>!object(a)||![a.x,a.y,a.z].every(v=>typeof v==='number'&&Number.isFinite(v))))return false;
  const body=(s:Structure)=>JSON.stringify([s.id,s.dimension,s.cell??null,s.atoms.map(a=>[a.id,a.element,a.x,a.y,a.z])]);
  try{return source.charge===charge&&source.multiplicity===multiplicity&&body(source.structure)===body(structure);}catch{return false;}
}
