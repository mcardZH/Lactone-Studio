import type { SharedModelConstraints } from '../contracts';
import { captureAdvancedFrame, type AdvancedFrameSource } from '../advanced/frame-source';
import { prepareAdvancedFrameInputs, type AdvancedInputTemplate, type AdvancedFrameOutputPlan } from './advanced-frame-output';
import { projectCanonicalGaussianFreezes, projectCanonicalOrcaFreezes } from './canonical-freezes';

export interface BatchInputSession {
  id: string;
  sources: readonly AdvancedFrameSource[];
  coreIds: readonly string[];
  representativeFrameId: string;
}
const gaussianTasks = new Set(['sp','opt','freq','optfreq','constrained','ts','td','tdopt','t1opt','nmr','stable']);
const orcaTasks = new Set(['sp','opt','freq','optfreq','ts','td','tdopt','nmr','stable']);
export function batchInputTaskAllowed(engine:'gaussian'|'orca', task:string):boolean {
  return (engine === 'gaussian' ? gaussianTasks : orcaTasks).has(task);
}
function freeze<T>(value:T):T {
  if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
export function createBatchInputSession({sources,coreIds=[],activeFrameId}:{sources:readonly AdvancedFrameSource[];coreIds?:readonly string[];activeFrameId?:string}):BatchInputSession {
  if(!sources.length)throw new Error('请先选择需要产生输入文件的优化结果。');
  const snapshots=sources.map(source=>{
    const captured=captureAdvancedFrame(source.structure,source.ref,source.stamp,source.label,source.constraints);
    return source.samplingPreparation?freeze({...captured,samplingPreparation:structuredClone(source.samplingPreparation)}):captured;
  });
  const reference=snapshots[0].structure.atoms;
  for(const [index,source] of snapshots.entries())if(source.structure.atoms.length!==reference.length || source.structure.atoms.some((atom,i)=>atom.id!==reference[i].id||atom.element!==reference[i].element))throw new Error(`第${index+1}项原子身份或顺序与本批不兼容。`);
  const ids=new Set(reference.map(atom=>atom.id!));
  if(coreIds.some(id=>!ids.has(id)))throw new Error('保护核心与本批原子身份不匹配。');
  const representative=snapshots.find(source=>source.ref.frameId===activeFrameId)??snapshots[0];
  return freeze({id:crypto.randomUUID(),sources:snapshots,coreIds:[...new Set(coreIds)],representativeFrameId:representative.ref.frameId??'first'});
}
export function batchInputRepresentative(session:BatchInputSession):AdvancedFrameSource {
  return session.sources.find(source=>source.ref.frameId===session.representativeFrameId)??session.sources[0];
}
export function batchInputInitialConstraints(session:BatchInputSession):SharedModelConstraints {
  return {canonical:true,enabled:true,frozenAtomIds:[...new Set([...session.coreIds,...session.sources.flatMap(source=>source.constraints.frozenAtomIds)])],coordinates:[]};
}
/** One confirmed shared configuration, but each member keeps its own scientific coordinates. */
export function prepareBatchInputPlan(session:BatchInputSession, template:AdvancedInputTemplate, constraints:SharedModelConstraints):AdvancedFrameOutputPlan {
  if(!batchInputTaskAllowed(template.engine,template.request.settings.task))throw new Error('批量模式仅支持可共享设置的单结构任务。');
  const reference=template.request.structure?.atoms;
  if(!reference)throw new Error('代表帧结构已失效。');
  for(const [index,source] of session.sources.entries())if(source.structure.atoms.length!==reference.length||source.structure.atoms.some((atom,i)=>atom.id!==reference[i].id||atom.element!==reference[i].element))throw new Error(`第${index+1}项与代表帧的原子身份或顺序不匹配。`);
  const frozenAtomIds=[...constraints.frozenAtomIds];
  const clean:SharedModelConstraints={canonical:true,enabled:constraints.enabled!==false,frozenAtomIds,coordinates:[]};
  template=structuredClone(template);
  if(template.engine==='gaussian'){
    template.request.settings=projectCanonicalGaussianFreezes(template.request.structure,template.request.settings,clean);
    if(template.request.settings.taskOptions){template.request.settings.taskOptions.coordinates=[];template.request.settings.taskOptions.coordinateDrafts=[];}
  }else{template.request.settings=projectCanonicalOrcaFreezes(template.request.structure,template.request.settings,clean);template.request.settings.constraints=[];}
  return prepareAdvancedFrameInputs({template,manifestStem:`${template.request.name}-inputs`,independentRuntimeNames:true,
    frames:session.sources.map((source,index)=>({source:{...source,constraints:clean},stem:`${template.request.name}-${String(index+1).padStart(3,'0')}`,electronicState:{charge:template.request.charge,multiplicity:template.request.multiplicity,confirmed:template.request.electronicStateConfirmed===true}}))});
}
