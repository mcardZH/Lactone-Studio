import capability from '../../data/conformer-solvation.json';
import type {XtbSolvationEvidence} from '../xtb/contracts';
import type {AdvancedTaskRecord,AdvancedMixedSamplingDefinition} from './contracts';

/** Display projection only. Native dielectric/parameter values never enter UI input. */
export const CONFORMER_ALPB_PRESETS:readonly Readonly<{id:string;label:string;dielectric:number}>[]=Object.freeze(capability.presets.map(({id,label,dielectric})=>Object.freeze({id,label,dielectric})));
export function conformerAlpbPresets(method:string){return capability.nativeMethods.includes(method)?CONFORMER_ALPB_PRESETS:[];}
export function isConformerAlpbSupported(method:string,solvent:string):boolean{return capability.nativeMethods.includes(method)&&capability.presets.some(row=>row.id===solvent);}
export function conformerSolvationIssue(method:string,model:string,solvent:string):string|undefined{
 if(model==='none')return;
 if(model!=='alpb')return '此构象卡的新运行使用ALPB；请明确选择气相或ALPB溶剂，历史结果保留原介质。';
 if(!isConformerAlpbSupported(method,solvent))return '此构象方法不支持所选ALPB溶剂；请在本卡选择有效介质。';
}
/** Protect actual native-FF ALPB configuration slots, including a persisted
 * next-run draft. This is a write floor, never evidence that a run took place. */
export function conformerTaskRequiresAlpbSemantics(task:AdvancedTaskRecord):boolean{
 const changed=(value:{operation:string;method:string;solvation?:{model:string}}|undefined)=>!!value
  &&['md','metadynamics'].includes(value.operation)&&value.method==='gfnff'&&value.solvation?.model==='alpb';
 const cards=(definition:AdvancedMixedSamplingDefinition|undefined)=>definition?.cards.some(card=>card.kind==='sampling'&&changed(card.sampling))??false;
 if(task.spec.kind==='sampling'&&(changed(task.spec.sampling)||cards(task.spec.mixedSampling)))return true;
 if(cards(task.mixedSampling?.draft)||task.mixedSampling?.batches?.some(batch=>cards(batch.definition)||batch.cards.some(card=>card.configuration.kind==='sampling'&&changed(card.configuration.sampling))))return true;
 return task.runs.some(run=>run.sourceConfiguration?.kind==='sampling'&&changed(run.sourceConfiguration.sampling)||cards(run.mixedSampling?.definition)
  ||run.sampling?.stageEvents.some(event=>changed(event.configuration))
  ||run.mixedSampling?.cards.some(card=>card.sampling?.stageEvents.some(event=>changed(event.configuration))));
}
export interface ConformerNativeSolvationEvidence extends Omit<XtbSolvationEvidence,'temperatureKelvin'> {temperatureKelvin:number;dielectricConstant:number}
/** Readback evidence is mandatory for newly consumed native solvent frames.
 * Historical stored results are not revalidated or relabelled on project load. */
export function validateConformerNativeSolvation(request:{method:string;operation:string;molecularMD?:{temperatureK?:number};metadynamics?:{temperatureK?:number};solvation?:{model:string;solvent:string}},evidence:ConformerNativeSolvationEvidence|undefined):void{
 if(!request.solvation){if(evidence!==undefined)throw Error('气相采样混入原生隐式溶剂结果。');return;}
 const wanted=request.solvation,methodLabel:Record<string,string>={gfnff:'GFN-FF',gfn1:'GFN1-xTB',gfn2:'GFN2-xTB'};
 const target=request.operation==='metadynamics'?request.metadynamics?.temperatureK??300:request.molecularMD?.temperatureK??600;
 if(!evidence||evidence.model!==wanted.model||evidence.solvent!==wanted.solvent||evidence.kernel!==(wanted.model==='alpb'?'p16':'still')
  ||evidence.referenceState!=='gsolv'||evidence.temperatureKelvin!==Number(target.toExponential(4))||evidence.sourceField!=='stdout:solvation-model'
  ||evidence.parameterSet!==`internal ${methodLabel[request.method]}/${wanted.model.toUpperCase()}`
  ||!Number.isFinite(evidence.dielectricConstant)||evidence.dielectricConstant<=0)throw Error('采样缺少与本次请求一致的原生溶剂模型及参数来源。');
 if(wanted.model==='alpb'&&isConformerAlpbSupported(request.method,wanted.solvent)){
  const row=capability.presets.find(row=>row.id===wanted.solvent)!,expected=row.nativeDielectric[request.method as keyof typeof row.nativeDielectric];
  // Native output uses a fixed display precision. This checks that readback,
  // without replacing it by the distinct 298 K UI property.
  if(Math.abs(evidence.dielectricConstant-expected)>.000051)throw Error('原生ALPB介电参数回执与所选方法参数集不一致。');
 }
}
