import { applyGaussianLink0, parseGaussianSource } from '../core/gaussian-source';
import { parseOrcaInputSource } from '../core/orca/input-source';
import type { Structure } from '../core/types';
import type { ScientificData } from './scientific-contracts';

/** The original reader's metadata adaptation, shared with resident monitor
 * geometries. It does not read/decode coordinates or infer scientific defaults. */
export function createScientificStructureMetadata(input:{engine:'gaussian'|'orca';data:ScientificData;jobIndex:number;charge:number|null;multiplicity:number|null;name:string;resultId:string}) {
 const {engine,data,jobIndex,charge,multiplicity,name,resultId}=input;
 const gaussianSource=engine==='gaussian'?parseGaussianSource(data.route,'out',name,jobIndex):null;
 if(gaussianSource){
  const link0:string[]=[];
  for(const key of ['input-memory','input-shared-processors'] as const){
   const requested=data.summary.filter(field=>field.key===key&&field.origin==='input-request');
   if(requested.length>1){gaussianSource.issues.push({code:'input-resource-ambiguous',field:'files',severity:'conflict',message:`本job存在重复的${key}输入证据，未推定有效请求；原始字段仍保留。`});continue;}
   const field=requested[0];if(!field||typeof field.value!=='number'||!Number.isFinite(field.value))continue;
   if(key==='input-shared-processors'){if(Number.isSafeInteger(field.value)&&field.value>0)link0.push(`%nprocshared=${field.value}`);}
   else{const unit=field.unit?.trim().toUpperCase(),amount=field.rawValue&&/^\d+(?:\.\d+)?$/.test(field.rawValue)&&Number(field.rawValue)===field.value?field.rawValue:String(field.value);if(unit&&/^(GB|MB|GW|MW)$/.test(unit)&&/^\d+(?:\.\d+)?$/.test(amount))link0.push(`%mem=${amount}${unit}`);}
  }
  if(link0.length)applyGaussianLink0(gaussianSource,link0);
 }
 return (structure:Structure,index:number,sourceLine:number):Structure=>{
  structure.id=`${resultId}:frame:${index}`;structure.name=`${name} · 帧 ${index+1}`;structure.format=`${engine} result`;structure.charge=charge;structure.multiplicity=multiplicity;structure.dimension=3;structure.sourceRoute=data.route||undefined;
  structure.notes=[`来源 ${name}，job ${jobIndex+1}，源行 ${sourceLine}；只读结果，未执行新计算。`];
  if(gaussianSource){structure.gaussianSource=structuredClone(gaussianSource);structure.gaussianSource.id=`${resultId}:frame:${index}:source`;structure.gaussianSource.routeOverrides.sourceId=structure.gaussianSource.id;structure.gaussianSource.charge=charge;structure.gaussianSource.multiplicity=multiplicity;structure.notes.push('所选帧不自动继承最终收敛、频率、检查点或冻结/约束确认。');}
  if(engine==='orca'&&data.route&&charge!==null&&multiplicity!==null){structure.orcaSource=parseOrcaInputSource(data.route,name,jobIndex,structure.atoms.length,charge,multiplicity);structure.notes.push('保留本job输入回显作级别核对；未确认冻结、数值条件或外部依赖可直接续用。');}
  return structure;
 };
}
