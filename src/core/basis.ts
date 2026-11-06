import countsData from '../data/basis-counts.json';
import maData from '../data/ma-def2-tzvp.json';
import { atomicNumber, ELEMENTS } from './elements';
import { canonicalBasis } from './catalog';
import type { GaussianSettings, Structure } from './types';

interface CountData { elements: Record<string, { spherical: number; cartesianD: number }> }
const counts = countsData as Record<string, CountData>;
const ma = maData as { source: string; rawSha256: string; basis: Record<string,string>; ecp: Record<string,string>; counts: Record<string,number>; all: string };
export type DForm = '5D'|'6D';
export type FForm = '7F'|'10F';
/** G16 manual, Basis Sets pp.21-22: ordinary 6-31G uses 6D; Gen and 6-311G use 5D. */
export function basisDefaultDForm(basisName:string):DForm {
  return /^6-31(?:\+)?G\(/i.test(canonicalBasis(basisName))?'6D':'5D';
}
/** Resolve actual global shells separately from whether route keywords were explicitly requested. */
export function angularBasisPlan(settings:GaussianSettings,basisKeyword?:string):{dForm:DForm;fForm:FForm;keywords:string[]} {
  const inherited=settings.inheritedRoute,mixed=settings.mixedBasis;
  const general=Boolean(mixed?.enabled||/^(?:gen|genecp)$/i.test(basisKeyword??'')||inherited?.basisKeyword||canonicalBasis(settings.basis)==='ma-def2TZVP');
  let dForm:DForm=general?'5D':basisDefaultDForm(settings.basis),fForm:FForm='7F',keywords:string[]=[];
  // Missing angularExplicit belongs to the pre-v0.12 saved-form contract: dForm was explicit.
  const explicitMixed=mixed?.enabled&&(mixed.angularExplicit===true||!inherited?.sourceId&&mixed.angularExplicit!==false||!inherited?.sourceId&&mixed.dForm==='6D');
  if(explicitMixed){dForm=mixed!.dForm;keywords=[dForm.toLowerCase(),'7f'];}
  else if(inherited){
    dForm=inherited.angular??dForm;fForm=inherited.fForm??fForm;
    keywords=[inherited.angular,inherited.fForm].flatMap(value=>value?[value.toLowerCase()]:[]);
  }
  if(settings.use5D){dForm='5D';keywords=keywords.filter(value=>!['5d','6d'].includes(value));keywords.unshift('5d');}
  return {dForm,fForm,keywords};
}
/** Gen has one global d-shell convention, even when builtin basis families are mixed. */
export function basisElementCount(basisName:string,element:string,dForm:'5D'|'6D'='5D'):number|null {
  const basis=canonicalBasis(basisName);
  if(unsupportedElements(basis,[element]).length||basis==='def2SVPP')return null;
  if(basis==='ma-def2TZVP')return dForm==='5D'?ma.counts[element]??null:null;
  return counts[basis]?.elements[String(atomicNumber(element))]?.[dForm==='6D'?'cartesianD':'spherical']??null;
}
export function unsupportedElements(basisName: string, elements: string[]): string[] {
  const basis = canonicalBasis(basisName);
  if (basis === 'ma-def2TZVP') return [...new Set(elements)].filter(element => !ma.basis[element]);
  if (basis === 'def2SVPP') return [...new Set(elements)].filter(element => { const z = atomicNumber(element); return z > 86 || z >= 58 && z <= 71; });
  if (!counts[basis]) return [...new Set(elements)];
  return [...new Set(elements)].filter(element => !counts[basis].elements[String(atomicNumber(element))] || /^def2/.test(basis) && atomicNumber(element) >= 58 && atomicNumber(element) <= 71);
}
export function basisSize(structure: Structure | null, basisName: string,dForm?:DForm,fForm:FForm='7F'): { count: number | null; unsupported: string[]; convention: string; reason?: string } {
  if (!structure) return { count: null, unsupported: [], convention: '', reason: '没有显式坐标，不统计' };
  const basis = canonicalBasis(basisName);
  const elements = structure.atoms.map(atom => atom.element);
  const unsupported = unsupportedElements(basis, elements);
  if (unsupported.length) return { count: null, unsupported, convention: '', reason: '不支持元素：' + unsupported.join(', ') };
  if (basis === 'def2SVPP') return { count: null, unsupported, convention: 'Gaussian内置', reason: '该Gaussian关键词暂无独立核实的计数数据，不猜数目' };
  const resolvedD=dForm??basisDefaultDForm(basis),convention=resolvedD+' / '+fForm+(dForm?'（当前全局壳形式）':'（该基组的Gaussian默认）');
  if(fForm==='10F')return {count:null,unsupported:[],convention,reason:'10F及更高Cartesian壳暂无独立核实的计数数据，不猜数目'};
  const values=elements.map(element=>basisElementCount(basis,element,resolvedD));
  if(values.some(value=>value===null))return {count:null,unsupported:[],convention,reason:'当前壳形式暂无独立核实的计数数据，不猜数目'};
  return { count:values.reduce<number>((total,value)=>total+value!,0), unsupported: [], convention };
}
export function basisComparison(structure: Structure | null, basis: string, recommended: string,dForm?:DForm,fForm:FForm='7F',referenceDForm?:DForm,referenceFForm:FForm='7F') {
  const current = basisSize(structure, basis,dForm,fForm); const reference = basisSize(structure, recommended,referenceDForm,referenceFForm);
  const ratio = current.count && reference.count ? current.count / reference.count : null;
  return { ...current, reference: reference.count, ratio, costIndex: ratio === null ? null : ratio ** 4 };
}
export function externalMaBasis(elements: string[] | null): { keyword: string; tail: string } {
  if (!elements) return { keyword: 'genecp', tail: ma.all.trimEnd() + '\n\n' };
  const unique = [...new Set(elements)];
  const missing = unique.filter(element => !ma.basis[element]);
  if (missing.length) throw new Error('ma-def2-TZVP缺少元素：' + missing.join(', '));
  const ecpElements = unique.filter(element => ma.ecp[element]);
  return { keyword: ecpElements.length ? 'genecp' : 'gen', tail: unique.map(element => ma.basis[element].trimEnd()).join('\n') + '\n\n' + (ecpElements.length ? ecpElements.map(element => ma.ecp[element].trimEnd()).join('\n') + '\n\n' : '') };
}
export function unknownDef2Basis(basis: string): { keyword: string; tail: string } {
  // Negative centers are ignored by Gaussian when absent: no element declaration or browser check.
  const elements = ELEMENTS.slice(0,86).filter((_, index) => index < 57 || index >= 71);
  const heavy = elements.filter(element => atomicNumber(element) >= 37);
  return { keyword: 'genecp', tail: elements.map(element => '-' + element + ' 0\n' + basis + '\n****').join('\n') + '\n\n' + heavy.map(element => '-' + element + ' 0\ndef2').join('\n') + '\n\n' };
}
export const BASIS_DATA_SOURCES = { standard: 'https://www.basissetexchange.org/', ma: ma.source, maSha256: ma.rawSha256 };
