import { basisElementCount, unsupportedElements, type DForm, type FForm } from './basis';
import { BASES, canonicalBasis } from './catalog';
import { atomicNumber } from './elements';
import type { JobRequest, Structure } from './types';

/** Atom numbers are one based, matching Gaussian center identifiers. */
export interface BasisRegion { id:string;name:string;basis:string;atoms:number[] }
export interface MixedBasisSettings { enabled:boolean;dForm:'5D'|'6D';/** Absent preserves pre-v0.12 explicit shell selections. */angularExplicit?:boolean;regions:BasisRegion[] }
export const defaultMixedBasis=():MixedBasisSettings=>({enabled:false,dForm:'5D',angularExplicit:false,regions:[]});
export const MIXED_BASES=BASES.filter(entry=>entry.value!=='ma-def2TZVP'&&!entry.pending);
export const isMixedBuiltin=(basis:string)=>MIXED_BASES.some(entry=>entry.value===canonicalBasis(basis));
const mixed=(request:JobRequest)=>(request.settings as JobRequest['settings']&{mixedBasis?:MixedBasisSettings}).mixedBasis;

export function mixedBasisAssignments(structure:Structure,globalBasis:string,settings:MixedBasisSettings):string[] {
  const assignments=structure.atoms.map(()=>canonicalBasis(globalBasis));
  if(settings.enabled)for(const region of settings.regions)for(const number of region.atoms)if(Number.isSafeInteger(number)&&number>=1&&number<=assignments.length)assignments[number-1]=canonicalBasis(region.basis);
  return assignments;
}
export function mixedBasisErrors(request:JobRequest):string[] {
  const settings=mixed(request);
  if(!settings?.enabled)return [];
  const errors:string[]=[];
  const structure=request.structure;
  if((request.files?.geometry??'explicit')!=='explicit'||!structure?.atoms.length)errors.push('混合基组需要完整显式坐标，不能向未知CHK几何分配原子中心。');
  if(request.files?.basisFromCheckpoint)errors.push('混合基组不能与ChkBasis同时使用。');
  if(request.settings.task==='freq'&&request.files?.hessian==='readfc')errors.push('Freq=ReadFC沿用已有力常数，不重新分配混合基组。');
  if(['pm6','pm7','gfn2-xtb'].includes(request.settings.method)||request.settings.task==='td'&&request.settings.taskOptions?.excited.approximation==='zindo')errors.push('当前方法不使用混合轨道基组。');
  if(!['5D','6D'].includes(settings.dForm))errors.push('混合基组的d壳形式须选择5D或6D；f及更高角动量统一使用纯函数。');
  if(!isMixedBuiltin(request.settings.basis))errors.push('混合基组的全局基组须为本页已核实的Gaussian内置基组，不支持外部ma或任意Gen文本。');
  const count=structure?.atoms.length??0,owner=new Map<number,string>();
  for(const [index,region] of settings.regions.entries()){
    const label=region.name.trim()||'区域'+(index+1);
    if(!isMixedBuiltin(region.basis))errors.push('混合基组'+label+'须选择已核实的Gaussian内置基组。');
    if(!region.atoms.length)errors.push('混合基组'+label+'尚未分配原子。');
    const within=new Set<number>();
    for(const number of region.atoms){
      if(!Number.isSafeInteger(number)||number<1||number>count){errors.push('混合基组'+label+'包含无效原子编号：'+number+'。');continue;}
      if(within.has(number))errors.push('混合基组'+label+'重复包含原子'+number+'。');
      within.add(number);
      const previous=owner.get(number);
      if(previous&&previous!==region.id)errors.push('混合基组区域重叠：原子'+number+'同时分配给多个区域。');
      owner.set(number,region.id);
    }
  }
  if(new Set(settings.regions.map(region=>region.id)).size!==settings.regions.length)errors.push('混合基组区域标识重复，请删除重复区域后重新定义。');
  if(structure){
    const assignments=mixedBasisAssignments(structure,request.settings.basis,settings);
    assignments.forEach((basis,index)=>{if(isMixedBuiltin(basis)&&unsupportedElements(basis,[structure.atoms[index].element]).length)errors.push('混合基组原子'+(index+1)+' '+structure.atoms[index].element+'缺少'+basis+'已核实覆盖。');});
  }
  return [...new Set(errors)];
}
/** Numeric centers are disjoint. Repeated element blocks would ADD functions, not override. */
export function mixedBasisPlan(request:JobRequest):{keyword:string;tail:string} {
  const settings=mixed(request);
  if(!settings?.enabled)return {keyword:canonicalBasis(request.settings.basis),tail:''};
  const errors=mixedBasisErrors(request);
  if(errors.length)throw new Error(errors.join('\n'));
  const structure=request.structure!,assignments=mixedBasisAssignments(structure,request.settings.basis,settings);
  const blocks=new Map<string,number[]>();
  assignments.forEach((basis,index)=>{const centers=blocks.get(basis)??[];centers.push(index+1);blocks.set(basis,centers);});
  const orbital=[...blocks].map(([basis,centers])=>centers.join(' ')+' 0\n'+basis+'\n****').join('\n');
  const ecp=assignments.flatMap((basis,index)=>/^def2/.test(basis)&&atomicNumber(structure.atoms[index].element)>=37?[index+1]:[]);
  return {keyword:ecp.length?'genecp':'gen',tail:orbital+'\n\n'+(ecp.length?ecp.join(' ')+' 0\ndef2\n\n':'')};
}
export interface MixedBasisSize {count:number|null;unsupported:string[];convention:string;reason?:string;regions:{id:string;name:string;count:number|null;atoms:number}[];remaining:number;remainingCount:number|null}
export function mixedBasisSize(structure:Structure|null,globalBasis:string,settings:MixedBasisSettings,dForm:DForm=settings.dForm,fForm:FForm='7F'):MixedBasisSize {
  const convention=dForm+' / '+fForm+(settings.angularExplicit===false&&dForm==='5D'?'（Gen默认）':'（混合基组统一形式）');
  const empty:MixedBasisSize={count:null,unsupported:[],convention,regions:[],remaining:0,remainingCount:null};
  if(!structure)return {...empty,reason:'没有显式坐标，不统计'};
  if(fForm==='10F')return {...empty,reason:'10F及更高Cartesian壳暂无独立核实的计数数据，不猜数目'};
  const assignments=mixedBasisAssignments(structure,globalBasis,settings),owners=new Map<number,number>();
  let invalid=false;
  if(!['5D','6D'].includes(dForm))return {...empty,reason:'d壳形式无效'};
  if(settings.enabled)for(const [index,region] of settings.regions.entries()){
    if(!region.atoms.length)invalid=true;
    for(const number of region.atoms){if(!Number.isSafeInteger(number)||number<1||number>structure.atoms.length||owners.has(number))invalid=true;owners.set(number,index);}
  }
  if(invalid)return {...empty,reason:'区域为空、重叠或编号无效，完成有效分配后统计'};
  const unsupported=assignments.flatMap((basis,index)=>!isMixedBuiltin(basis)||unsupportedElements(basis,[structure.atoms[index].element]).length?[structure.atoms[index].element+' / '+basis]:[]);
  const counts=assignments.map((basis,index)=>basisElementCount(basis,structure.atoms[index].element,dForm));
  const sum=(indices:number[])=>indices.every(index=>counts[index]!==null)?indices.reduce((total,index)=>total+counts[index]!,0):null;
  const remaining=structure.atoms.flatMap((_,index)=>owners.has(index+1)?[]:[index]);
  return {count:unsupported.length?null:sum(structure.atoms.map((_,index)=>index)),unsupported:[...new Set(unsupported)],convention,reason:unsupported.length?'所选基组缺少元素覆盖':counts.some(count=>count===null)?'部分基组没有独立核实的计数数据，不猜数目':undefined,regions:settings.enabled?settings.regions.map(region=>({id:region.id,name:region.name,atoms:region.atoms.length,count:sum(region.atoms.map(number=>number-1))})):[],remaining:remaining.length,remainingCount:sum(remaining)};
}
