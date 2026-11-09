import type {AdvancedTaskSpec,AdvancedOptimizationStageConfig} from '../../modeling/advanced/contracts';
import {getConformerSamplingCapability,suggestConformerSamplingSphere} from '../../modeling/advanced/sampling-contracts';
import {convertEnergy} from '../../results/energy';
import {initialAdvancedMethod,type AdvancedMethodDraft} from './AdvancedMethodControls';
import {initialSamplingDraft,type SamplingDraft} from './process-config';
import type {ConformerOptimizationDraft} from './ConformerOptimizationStages';
import type {ConformerTorsionDraft} from './ConformerTorsionControls';

export function restoreConformerStages(stages:readonly AdvancedOptimizationStageConfig[]):ConformerOptimizationDraft[]{
  return stages.map((stage,index)=>{
    const method=stage.method,options=method.backend==='xtb'?method.options:null;
    const draft:AdvancedMethodDraft={...initialAdvancedMethod,method:options?.method??(method.backend==='forcefield'&&method.forcefield!=='auto'?method.forcefield:'gfn2'),threads:options?.threads??(method.backend==='forcefield'?method.threads:1),maxSteps:options?.maxSteps??(method.backend==='forcefield'?method.maxSteps:500),internalConstraintsConfirmed:options?.internalConstraintsConfirmed??false,solvationModel:options?.solvation?.model??'none',solvent:options?.solvation?.solvent??'water'};
    return{id:stage.id,method:draft,energyThresholdKcalMol:stage.clustering?.maxDeltaEnergyHartree===undefined?.25:convertEnergy({value:stage.clustering.maxDeltaEnergyHartree,unit:'hartree'},'kcal/mol')!,rmsdThresholdAngstrom:stage.clustering?.rmsdThresholdAngstrom??.1,rmsdMatching:stage.clustering?.rmsdMatching??'fixed',eliminateEquivalent:stage.clustering?.eliminateEquivalent===true,inputStride:stage.inputStride??1,...(index?{inputClusterCount:stage.inputClusterCount??stages[index-1].advanceCount??10}:{}),checkpointAfter:stage.checkpointAfter};
  });
}

/** Reverse only the existing UI fields; scientific source/config snapshots stay owned by the task. */
export function restoreConformerTaskDraft(spec:AdvancedTaskSpec){
  if(!['sampling','conformer-search','docking'].includes(spec.kind))throw Error('不是构象任务。');
  const stages=restoreConformerStages(spec.kind==='conformer-search'?spec.search.stages:spec.kind==='sampling'||spec.kind==='docking'?spec.optimizationStages:[]);
  let reason='';
  const savedStages=spec.kind==='conformer-search'?spec.search.stages:spec.kind==='sampling'||spec.kind==='docking'?spec.optimizationStages:[];
  if(savedStages.some(stage=>stage.method.backend==='forcefield'&&stage.method.forcefield==='auto'))reason='此历史任务使用自动力场策略；保留原任务只读浏览。';
  let sampling:SamplingDraft={...structuredClone(initialSamplingDraft),sphere:suggestConformerSamplingSphere(spec.source.structure)};
  let torsions:ConformerTorsionDraft[]=[];
  if(spec.kind==='sampling'){
    const saved=spec.sampling;
    sampling={...sampling,operation:saved.operation,method:saved.method,threads:saved.threads,maxSteps:saved.maxSteps,maxEvaluations:saved.maxEvaluations,maxWallTimeSeconds:saved.maxWallTimeSeconds??sampling.maxWallTimeSeconds,seed:saved.seed??sampling.seed,dtFs:saved.dtFs??.5,frictionPerFs:saved.frictionPerFs??sampling.frictionPerFs,reportEvery:saved.reportEvery??sampling.reportEvery,maxFrames:saved.maxFrames??sampling.maxFrames,shakeHydrogenBonds:saved.shakeHydrogenBonds??getConformerSamplingCapability(saved).shakeDefaultEnabled,hydrogenMassAmu:saved.hydrogenMassAmu,memoryBudgetBytes:saved.memoryBudgetBytes,solvationModel:saved.solvation?.model??'none',solvent:saved.solvation?.solvent??'water',coreIds:[...saved.coreProtection?.atomIds??[]],coreForce:saved.coreProtection?.forceConstantEVPerAngstrom2??sampling.coreForce,sphereEnabled:!!saved.sphere,sphere:structuredClone(saved.sphere??sampling.sphere)};
    if(saved.nativeProtection?.core)sampling={...sampling,coreIds:[...saved.nativeProtection.core.atomIds],coreForce:saved.nativeProtection.core.forceConstantEVPerAngstrom2};
    if(saved.nativeProtection?.sphere)sampling={...sampling,sphereEnabled:true,sphere:{centerAngstrom:[...saved.nativeProtection.sphere.centerAngstrom],radiusAngstrom:saved.nativeProtection.sphere.radiusAngstrom,forceConstantEVPerAngstrom2:initialSamplingDraft.sphere.forceConstantEVPerAngstrom2}};
    if(saved.sphere||saved.nativeProtection?.sphere){const extent=suggestConformerSamplingSphere(spec.source.structure,.01).radiusAngstrom-.01;sampling.spherePaddingAngstrom=sampling.sphere.radiusAngstrom-extent;}
    if(saved.operation==='md')sampling={...sampling,molecularTemperatureK:saved.molecularMD?.temperatureK??sampling.molecularTemperatureK,molecularDurationFs:saved.molecularMD?.durationFs??10000,molecularSampleEveryFs:saved.molecularMD?.sampleEveryFs??sampling.molecularSampleEveryFs};
    if(saved.operation==='metadynamics')sampling={...sampling,temperatureK:saved.metadynamics?.temperatureK??sampling.temperatureK,durationFs:saved.metadynamics?.durationFs??sampling.durationFs,sampleEveryFs:saved.metadynamics?.sampleEveryFs??sampling.sampleEveryFs,depositEveryFs:saved.metadynamics?.depositEveryFs??sampling.depositEveryFs,heightEV:saved.metadynamics?.heightEV??sampling.heightEV,sigmaAngstrom:saved.metadynamics?.sigmaAngstrom??sampling.sigmaAngstrom,maxHistory:saved.metadynamics?.maxHistory??sampling.maxHistory,metaScope:saved.metadynamics?.atomIds===undefined?'all':'selected',metaIds:[...saved.metadynamics?.atomIds??[]]};
    if(saved.operation==='anneal'){
      sampling={...sampling,lowTemperatureK:saved.annealing?.lowTemperatureK??sampling.lowTemperatureK,highTemperatureK:saved.annealing?.highTemperatureK??sampling.highTemperatureK,cycleDurationFs:saved.annealing?.cycleDurationFs??sampling.cycleDurationFs,cycles:saved.annealing?.cycles??sampling.cycles};
      if(saved.annealing?.cycleDurationFs===undefined)reason='此历史任务使用旧四段退火程序；保留原任务只读浏览。';
    }
    if(saved.operation==='spherical-md')reason='此历史任务使用旧独立球形MD入口；保留原任务只读浏览。';
    if(saved.calculator)reason='此历史任务含当前界面未提供的计算器参数；保留原任务只读浏览。';
    if(getConformerSamplingCapability(saved).driver==='native-xtb-md'&&(saved.coreProtection||saved.sphere))reason='此历史任务使用旧ASE保护势，不能自动改为原生保护定义；保留原任务只读浏览。';
  }
  if(spec.kind==='conformer-search'){
    torsions=spec.search.torsions.map((row,index)=>({id:`restored-torsion-${index}`,atomIds:[...row.torsion.atomIds],pointCount:row.pointCount??spec.search.quantity.pointsPerTorsion,pointCountMode:row.pointCountMode,enabled:true,origin:row.torsion.origin??'automatic'}));
    if(spec.search.clashPolicy||spec.search.torsions.some(row=>row.range))reason='此历史任务含当前界面未提供的采样策略；保留原任务只读浏览。';
  }
  if(spec.kind==='docking'&&!spec.fragments)reason='此历史任务使用双来源对接；保留原任务只读浏览。';
  return{stages,sampling,torsions,reason,candidateLimit:spec.kind==='conformer-search'?spec.search.samplingLimits?.maxCandidates??spec.budget?.maxCandidates??64:64};
}
