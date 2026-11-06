import type {AdvancedResultFrame,AdvancedTaskRun,AdvancedTaskSpec,AdvancedControllerState} from '../../modeling/advanced/contracts';
import type {ConformerSamplingRequest} from '../../modeling/advanced/sampling-contracts';
import {conformerSamplingSchedule,type ConformerWorkProgress} from '../../modeling/advanced/sampling-progress';
import type {SamplingTimeProgress} from './sampling-time-estimate';
import type {ScientificTableProjection} from '../results/scientific-table';
import {advancedFrameEnergyLabel} from './advanced-presentation';

const pathStages:Record<string,string>={'initial-path':'初切片','reactant-opt':'反应物预优化','product-opt':'产品预优化',neb:'NEB','climbing-neb':'攀爬 NEB','ts-dimer':'TS 候选搜索','neb-ts-dimer':'NEB 后 TS 候选搜索'};
const annealStages:Record<string,string>={heating:'升温','high-hold':'高温保持',cooling:'降温','low-hold':'低温保持',end:'候选'};
const samplingStages:Record<string,string>={md:'高温 MD',metadynamics:'元动力学','spherical-md':'球内 MD'};
export function advancedCheckpointAvailable(kind:AdvancedTaskSpec['kind'],run:AdvancedTaskRun):boolean{
 return run.status==='checkpoint'&&(kind!=='docking'||Boolean(run.docking?.acceptedCompletion||run.docking?.acceptedSearchCheckpoint));
}
function samplingTotalSteps(configuration:ConformerSamplingRequest|undefined):number|null{
 return configuration?conformerSamplingSchedule(configuration)?.totalSteps??null:null;
}
/** Uses only the selected run's actual owned sampling events, not editable drafts or budgets. */
export function advancedSamplingTimeProgress(state:AdvancedControllerState,taskId:string,runId:string):SamplingTimeProgress|null{
 const task=state.tasks.find(row=>row.id===taskId),run=task?.runs.find(row=>row.id===runId),owner=state.activeNative;
 if(task?.spec.kind!=='sampling'||run?.status!=='running'||!run.sampling||run.sampling.terminal||run.sampling.acceptedCompletion
  ||owner?.taskId!==taskId||owner.runId!==runId||owner.stageId!=='sampling')return null;
 const owned=(event:{sessionId:string;runIdentity:{taskId:string;runId:string}})=>event.sessionId===owner.sessionId&&event.runIdentity.taskId===taskId&&event.runIdentity.runId===runId;
 let stage:typeof run.sampling.stageEvents[number]|undefined;for(let i=run.sampling.stageEvents.length-1;i>=0;i--)if(owned(run.sampling.stageEvents[i])){stage=run.sampling.stageEvents[i];break;}
 let frame:AdvancedResultFrame|undefined;for(let i=run.frames.length-1;i>=0;i--)if(run.frames[i].process?.kind==='sampling'&&run.frames[i].taskId===taskId&&run.frames[i].runId===runId&&run.frames[i].sessionId===owner.sessionId){frame=run.frames[i];break;}
 let bias:typeof run.sampling.biasEvents[number]|undefined;for(let i=run.sampling.biasEvents.length-1;i>=0;i--)if(owned(run.sampling.biasEvents[i])){bias=run.sampling.biasEvents[i];break;}
 const data=frame?.process?.kind==='sampling'?frame.process.data:undefined,configuration=run.sampling.stageEvents.find(row=>owned(row)&&row.configuration)?.configuration;
 const progress=run.sampling.progress,progressStep=progress&&owned(progress)?progress.step:0;
 const step=Math.max(stage?.step??0,data?.step??0,bias?.historyEntry.step??0,progressStep);
 const rateStage=task.spec.sampling.method+':'+(task.spec.sampling.operation==='anneal'?(stage&&stage.step>=(data?.step??0)?stage.stageId:data?.stageId??'sampling'):task.spec.sampling.operation);
 return{identity:JSON.stringify([taskId,runId,owner.sessionId,task.spec.source.ref,task.spec.source.stamp]),rateStage,step,totalSteps:samplingTotalSteps(configuration)};
}

/** Candidate/processed counts are derived from accepted records, never raw MD output counts. */
export function advancedConformerWorkProgress(state:AdvancedControllerState,taskId:string,runId:string,stageId?:string):ConformerWorkProgress|null{
 const task=state.tasks.find(row=>row.id===taskId),run=task?.runs.find(row=>row.id===runId);
 if(!task||!run)return null;
 const phase=(done:boolean,all:boolean):ConformerWorkProgress['phase']=>run.status==='stopping'?'stopping':run.status==='stopped'?'stopped':run.status==='failed'?'failed':done?'complete':all?'finishing':'running';
 if(stageId){
  const stage=run.stages.find(s=>s.id===stageId||s.configurationId===stageId);if(!stage)return null;
  const workflow=task.conformerWorkflow?.stages.find(value=>value.stageId===(stage.configurationId??stage.id)),cumulative=workflow?.progress;
  if(cumulative)return{kind:'optimization',completed:cumulative.completed+cumulative.interrupted+cumulative.failed,total:cumulative.total,remaining:cumulative.pending,valid:cumulative.completed,failed:cumulative.failed,recordCount:workflow.resultFrameIds?.length??0,phase:phase(Boolean(workflow.completed),cumulative.pending===0&&cumulative.interrupted===0)};
  const processed=stage.results.filter(r=>r.status==='completed'||r.status==='failed'||r.status==='stopped'),valid=processed.filter(r=>r.status==='completed').length;
  const total=stage.inputCandidateIds.length,done=stage.status==='completed';
  return{kind:'optimization',completed:processed.length,total,remaining:Math.max(0,total-processed.length),valid,failed:processed.filter(r=>r.status==='failed').length,recordCount:run.frames.filter(f=>f.stageId===stage.id).length,phase:phase(done,processed.length>=total)};
 }
 if(task.spec.kind==='sampling'&&run.sampling){
  const config=run.sampling.stageEvents.find(e=>e.configuration)?.configuration??task.spec.sampling;
  const total=conformerSamplingSchedule(config)?.candidateCount??null,completed=run.sampling.candidateFrameIds.length;
  return{kind:'sampling',completed,total,remaining:total===null?null:Math.max(0,total-completed),valid:completed,failed:0,recordCount:run.frames.filter(f=>f.process?.kind==='sampling').length,phase:phase(run.sampling.acceptedCompletion,total!==null&&completed>=total)};
 }
 if(task.spec.kind==='conformer-search'){
  const completed=task.conformerWorkflow?.candidateSet?.frameIds.length??task.guessFrames.length,total=task.spec.search.samplingLimits?.maxCandidates??task.budget.maxCandidates;
  return{kind:'torsion',completed,total,remaining:Math.max(0,total-completed),valid:completed,failed:0,recordCount:completed,phase:phase(Boolean(task.conformerWorkflow?.candidateSet?.valid),false)};
 }
 return null;
}

/** Per-candidate timings reset for each stage/method, including failed processed candidates. */
export function advancedOptimizationTimeProgress(state:AdvancedControllerState,taskId:string,runId:string,stageId:string):SamplingTimeProgress|null{
 const task=state.tasks.find(t=>t.id===taskId),run=task?.runs.find(r=>r.id===runId),stage=run?.stages.find(s=>s.id===stageId);
 if(!task||!run||!stage||run.status!=='running'||stage.status!=='running')return null;
 return{identity:JSON.stringify([taskId,runId,stageId]),rateStage:JSON.stringify(stage.configuration?.method??stageId),step:stage.results.filter(r=>r.status==='completed'||r.status==='failed'||r.status==='stopped').length,totalSteps:stage.inputCandidateIds.length};
}
export function processStageLabel(stage:string){
 const scan=stage.match(/^scan-point-(\d+)$/);if(scan)return`扫描点 ${Number(scan[1])+1}`;
 const anneal=stage.match(/^cycle-(\d+)-(heating|high-hold|cooling|low-hold|end)$/);
 if(anneal)return`循环 ${anneal[1]} · ${annealStages[anneal[2]]}`;
 return pathStages[stage]??samplingStages[stage]??'采样阶段';
}
export interface AdvancedFrameCollection{id:string;label:string;frames:AdvancedResultFrame[]}
/** Each collection has one process dimension. A NEB round contains images,
 * never frames from other rounds, scan points or subsequent TS stages. */
export function advancedFrameCollections(frames:AdvancedResultFrame[],run?:AdvancedTaskRun):AdvancedFrameCollection[]{
 const groups=new Map<string,AdvancedFrameCollection>();
 for(const frame of frames){
  const process=frame.process;
  let id:string,label:string;
  if(process?.kind==='path'){
   const d=process.data,round=d.imageIndex!==undefined&&d.role!=='initial-path';
   id=JSON.stringify(['path',d.collectionId,d.stageId,round?d.iteration:null]);label=processStageLabel(d.stageId)+(round?` · 第 ${d.iteration+1} 轮 images`:'');
  }else if(process?.kind==='sampling'){
   const d=process.data;id=JSON.stringify(['sampling',d.collectionId,d.stageId]);label=`${processStageLabel(d.stageId)} · ${d.role==='sampled-candidate'?'待无偏优化候选':'采样轨迹'}`;
  }else if(process?.kind==='docking-screened'||process?.kind==='docking-refined'){
   id=JSON.stringify([process.kind,frame.stageId]);label=process.kind==='docking-screened'?(run?.docking?.acceptedSearchCheckpoint?'aISS 完整搜索候选（待独立优化）':'aISS 初筛姿态'):'aISS 原生精化候选（待无偏优化）';
  }else{
   const stage=run?.stages.find(row=>row.id===frame.stageId);
   id=JSON.stringify([frame.stageId,frame.kind==='intermediate'?frame.candidateId:null,frame.kind==='intermediate'?'process':'results']);
   label=frame.kind==='guess'?'初猜':stage?`第 ${stage.index+1} 级 · ${frame.kind==='intermediate'?'点内优化':'优化结果'}`:'单点结果';
  }
  if(!groups.has(id))groups.set(id,{id,label,frames:[]});groups.get(id)!.frames.push(frame);
 }
 return[...groups.values()];
}
export function advancedFrameTable(frames:AdvancedResultFrame[],run?:AdvancedTaskRun):ScientificTableProjection{
 const finite=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?String(value):'—';
 const process=frames[0]?.process;
 if(process?.kind==='docking-screened')return{columns:[{key:'pose',label:'姿态'},{key:'score',label:'xTB-IFF 评分 / kcal·mol⁻¹',precision:'source'},...(run?.docking?.acceptedSearchCheckpoint?[{key:'acceptance',label:'优化状态'}]:[])],rows:frames.map(frame=>{if(frame.process?.kind!=='docking-screened')throw Error('初筛集合混入了其他过程。');return{key:frame.id,cells:[String(frame.process.data.poseIndex+1),String(frame.process.data.screening.value),...(run?.docking?.acceptedSearchCheckpoint?['待独立无偏优化']:[])]};})};
 if(process?.kind==='docking-refined')return{columns:[{key:'candidate',label:'候选'},{key:'energy',label:'原生精化电子能量 / Eh',precision:'source'},{key:'acceptance',label:'优化状态'}],rows:frames.map(frame=>{if(frame.process?.kind!=='docking-refined')throw Error('原生精化集合混入了其他过程。');return{key:frame.id,cells:[String(frame.process.data.candidateIndex+1),String(frame.process.data.refinementEnergyHartree),'待独立无偏优化']};})};
 if(process?.kind==='path')return{columns:[{key:'frame',label:process.data.imageIndex!==undefined?'Image':'帧'},{key:'iteration',label:'轮次'},{key:'kind',label:'类型'},{key:'energy',label:'物理能量 / eV',precision:'source'},{key:'force',label:'投影力 / eV·Å⁻¹',precision:'source'},{key:'target',label:'扫描目标',precision:'source'}],rows:frames.map(frame=>{const d=frame.process!;if(d.kind!=='path')throw Error('路径集合混入了其他过程。');const v=d.data;return{key:frame.id,cells:[String((v.imageIndex??v.frameIndex)+1),String(v.iteration+1),v.role==='initial-path'?'几何初切片':v.role==='candidate'?'TS候选':v.role==='point-result'?'扫描点结果':'优化过程',v.energyEV===undefined?'—':String(v.energyEV),v.projectedForceMaxEVPerAngstrom===undefined?'—':String(v.projectedForceMaxEVPerAngstrom),v.target===undefined?'—':String(v.target)]};})};
 if(process?.kind==='sampling'){
  const hasNativeTotal=frames.some(frame=>frame.process?.kind==='sampling'&&frame.process.data.nativeMD?.energyDefinition==='native-total-including-sampling-potentials');
  const showPhysical=!hasNativeTotal||frames.some(frame=>frame.process?.kind==='sampling'&&Number.isFinite(frame.process.data.physicalEnergyEV));
  return{columns:[{key:'frame',label:'帧'},{key:'time',label:'时间 / fs',precision:'source'},{key:'temperature',label:'温度 / K',precision:'source'},...(showPhysical?[{key:'physical',label:'物理能量 / eV',precision:'source' as const}]:[]),...(hasNativeTotal?[{key:'sampledTotal',label:'采样总势能（含附加势） / eV',precision:'source' as const}]:[]),{key:'core',label:'核心偏置 / eV',precision:'source'},{key:'meta',label:'RMSD偏置 / eV',precision:'source'},{key:'sphere',label:'球壁偏置 / eV',precision:'source'}],rows:frames.map(frame=>{const d=frame.process!;if(d.kind!=='sampling')throw Error('采样集合混入了其他过程。');const v=d.data;return{key:frame.id,cells:[String(v.frameIndex+1),finite(v.timeFs),finite(v.temperatureK),...(showPhysical?[finite(v.physicalEnergyEV)]:[]),...(hasNativeTotal?[v.nativeMD?.energyDefinition==='native-total-including-sampling-potentials'?finite(v.sampledPotentialEV):'—']:[]),finite(v.coreBiasEV),finite(v.metaBiasEV),finite(v.sphereBiasEV)]};})};
 }
 return{columns:[{key:'frame',label:'帧'},{key:'kind',label:'结构类型'},{key:'energyKind',label:'能量类型'},{key:'energy',label:'能量 / Eh',precision:'source'}],rows:frames.map((frame,index)=>({key:frame.id,cells:[String(index+1),frame.kind==='guess'?'初猜':frame.kind==='singlepoint'?'单点':frame.kind==='optimized'?'优化结果':'优化过程',advancedFrameEnergyLabel(frame,run),frame.energyHartree===undefined?'—':String(frame.energyHartree)]}))};
}
