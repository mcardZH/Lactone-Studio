import {isPeriodic} from '../../core/periodic';
import type {AdvancedTaskSpec,AdvancedOptimizationStageConfig} from '../../modeling/advanced/contracts';
import {DEFAULT_CONFORMER_CONVERGENCE,LEGACY_CONFORMER_CONVERGENCE} from '../../modeling/advanced/conformer-shared-optimization';
import {getConformerSamplingCapability,suggestConformerSamplingSphere} from '../../modeling/advanced/sampling-contracts';
import {convertEnergy} from '../../results/energy';
import {initialAdvancedMethod} from './AdvancedMethodControls';
import {initialSamplingDraft,type SamplingDraft} from './process-config';
import type {ConformerOptimizationDraft} from './ConformerOptimizationStages';
import type {ConformerTorsionDraft} from './ConformerTorsionControls';

const {maxSteps:_genericOptimizationSteps,...conformerStageMethod}=initialAdvancedMethod;
export const initialConformerStageMethod:Readonly<ConformerOptimizationDraft['method']>=Object.freeze({
  ...conformerStageMethod,convergencePreset:DEFAULT_CONFORMER_CONVERGENCE,
});

export function resetConformerConvergence(method:ConformerOptimizationDraft['method']):ConformerOptimizationDraft['method']{
  const {convergenceLimits:_oldLimits,...next}=method;
  return {...next,convergencePreset:DEFAULT_CONFORMER_CONVERGENCE};
}

export function restoreConformerStages(stages:readonly AdvancedOptimizationStageConfig[]):ConformerOptimizationDraft[]{
  return stages.map((stage,index)=>{
    const method=stage.method,options=method.backend==='forcefield'?null:method.options,solvation=method.backend==='xtb'?method.options.solvation:undefined;
    const draft:ConformerOptimizationDraft['method']={...initialConformerStageMethod,optimizer:'lbfgs',convergencePreset:LEGACY_CONFORMER_CONVERGENCE,
      method:options?.method??'gfn2',threads:options?.threads??1,internalConstraintsConfirmed:options?.internalConstraintsConfirmed??false,
      solvationModel:solvation?.model??'none',solvent:solvation?.solvent??'water'};
    if(method.backend==='forcefield')draft.retiredMethod=method.forcefield;
    if(method.backend==='net'){
      draft.device=method.options.device;
      if(method.options.netGpuBatchLimit!==undefined)draft.netGpuBatchLimit=method.options.netGpuBatchLimit;
    }
    if(method.backend==='xtb'){
      if(method.options.maxSccIterations!==undefined){draft.sccIterationLimit=method.options.maxSccIterations;draft.sccIterationLimitExplicit=true;}
      if(method.options.resourceOverrides!==undefined)draft.resourceOverrides={...method.options.resourceOverrides};
    }
    if(options?.maxSteps!==undefined)draft.maxSteps=options.maxSteps;
    if(method.backend!=='forcefield'&&method.optimizer)Object.assign(draft,{optimizer:method.optimizer.algorithm,
      convergencePreset:method.optimizer.convergencePreset==='custom'&&
        !Number.isFinite((method.optimizer.convergenceLimits as Record<string, number> | undefined)?.energyDifferenceHartree)
        ?LEGACY_CONFORMER_CONVERGENCE:method.optimizer.convergencePreset??LEGACY_CONFORMER_CONVERGENCE,
      convergenceLimits:method.optimizer.convergenceLimits,maxSteps:method.options.maxSteps});
    return{id:stage.id,method:draft,energyThresholdKcalMol:stage.clustering?.maxDeltaEnergyHartree===undefined?.25:convertEnergy({value:stage.clustering.maxDeltaEnergyHartree,unit:'hartree'},'kcal/mol')!,rmsdThresholdAngstrom:stage.clustering?.rmsdThresholdAngstrom??.1,rmsdMatching:stage.clustering?.rmsdMatching??'fixed',eliminateEquivalent:stage.clustering?.eliminateEquivalent===true,...(index?{inputClusterCount:stage.inputClusterCount??stages[index-1].advanceCount??10}:{inputStride:stage.inputStride??1}),checkpointAfter:stage.checkpointAfter};
  });
}

/** Reverse only the existing UI fields; scientific source/config snapshots stay owned by the task. */
export function restoreConformerTaskDraft(spec:AdvancedTaskSpec){
  if(!['sampling','conformer-search','docking'].includes(spec.kind))throw Error('不是构象任务。');
  const stages=restoreConformerStages(spec.kind==='conformer-search'?spec.search.stages:spec.kind==='sampling'||spec.kind==='docking'?spec.optimizationStages:[]);
  let reason='';
  let sampling:SamplingDraft={...structuredClone(initialSamplingDraft),sphere:suggestConformerSamplingSphere(spec.source.structure)};
  let torsions:ConformerTorsionDraft[]=[];
  if(spec.kind==='sampling'){
    const saved=spec.sampling;
    sampling={...sampling,operation:saved.operation,method:saved.method,integrator:saved.integrator,device:saved.device,threads:saved.threads,maxSteps:saved.maxSteps,maxEvaluations:saved.maxEvaluations,maxWallTimeSeconds:saved.maxWallTimeSeconds??sampling.maxWallTimeSeconds,seed:saved.seed??sampling.seed,dtFs:saved.dtFs??.5,frictionPerFs:saved.frictionPerFs??sampling.frictionPerFs,reportEvery:saved.reportEvery??sampling.reportEvery,maxFrames:saved.maxFrames??sampling.maxFrames,shakeHydrogenBonds:saved.shakeHydrogenBonds??(saved.integrator===undefined&&saved.method!=='gfnff'),hydrogenMassAmu:saved.hydrogenMassAmu,memoryBudgetBytes:saved.memoryBudgetBytes,solvationModel:saved.solvation?.model??'none',solvent:saved.solvation?.solvent??'water',coreIds:[...saved.coreProtection?.atomIds??[]],coreForce:saved.coreProtection?.forceConstantEVPerAngstrom2??sampling.coreForce,sphereEnabled:!!saved.sphere,sphere:structuredClone(saved.sphere??sampling.sphere)};
    sampling.seedMode=saved.seedMode??(saved.seed===undefined?'auto':'explicit');
    sampling.seed=saved.seedDraft??saved.seed??sampling.seed;
    if(saved.nativeProtection?.core)sampling={...sampling,coreIds:[...saved.nativeProtection.core.atomIds],coreForce:saved.nativeProtection.core.forceConstantEVPerAngstrom2};
    if(saved.nativeProtection?.sphere)sampling={...sampling,sphereEnabled:true,sphere:{centerAngstrom:[...saved.nativeProtection.sphere.centerAngstrom],radiusAngstrom:saved.nativeProtection.sphere.radiusAngstrom,forceConstantEVPerAngstrom2:initialSamplingDraft.sphere.forceConstantEVPerAngstrom2}};
    if(saved.sphere||saved.nativeProtection?.sphere){const extent=suggestConformerSamplingSphere(spec.source.structure,.01).radiusAngstrom-.01;sampling.spherePaddingAngstrom=sampling.sphere.radiusAngstrom-extent;}
    if(saved.operation==='md')sampling={...sampling,molecularTemperatureK:saved.molecularMD?.temperatureK??sampling.molecularTemperatureK,molecularDurationFs:saved.molecularMD?.durationFs??10000,molecularSampleEveryFs:saved.molecularMD?.sampleEveryFs??sampling.molecularSampleEveryFs};
    if(saved.operation==='metadynamics')sampling={...sampling,temperatureK:saved.metadynamics?.temperatureK??sampling.temperatureK,durationFs:saved.metadynamics?.durationFs??sampling.durationFs,sampleEveryFs:saved.metadynamics?.sampleEveryFs??sampling.sampleEveryFs,depositEveryFs:saved.metadynamics?.depositEveryFs??sampling.depositEveryFs,heightEV:saved.metadynamics?.heightEV??sampling.heightEV,sigmaAngstrom:saved.metadynamics?.sigmaAngstrom??sampling.sigmaAngstrom,maxHistory:saved.metadynamics?.maxHistory??sampling.maxHistory,metaScope:saved.metadynamics?.atomIds===undefined?'all':'selected',metaIds:[...saved.metadynamics?.atomIds??[]]};
    if(saved.operation==='anneal'){
      sampling={...sampling,lowTemperatureK:saved.annealing?.lowTemperatureK??sampling.lowTemperatureK,highTemperatureK:saved.annealing?.highTemperatureK??sampling.highTemperatureK,cycleDurationFs:saved.annealing?.cycleDurationFs??sampling.cycleDurationFs,cycles:saved.annealing?.cycles??sampling.cycles};
      if(saved.annealing?.cycleDurationFs===undefined)reason='此历史任务使用旧四段退火程序；保留原任务只读浏览。';
    }
    if(saved.driver==='ase-langevin'||getConformerSamplingCapability({...saved,periodic:isPeriodic(spec.source.structure)}).driver==='ase-langevin')reason='此历史任务使用已停用的采样方式，原结果仍可查看。';
    if(saved.calculator)reason='此历史任务含当前界面未提供的计算器参数；保留原任务只读浏览。';
    if(getConformerSamplingCapability({...saved,periodic:isPeriodic(spec.source.structure)}).driver==='native-xtb-md'&&(saved.coreProtection||saved.sphere))reason='此历史任务使用旧ASE保护势，不能自动改为原生保护定义；保留原任务只读浏览。';
  }
  if(spec.kind==='conformer-search'){
    torsions=spec.search.torsions.map((row,index)=>({id:`restored-torsion-${index}`,atomIds:[...row.torsion.atomIds],pointCount:row.pointCount??spec.search.quantity.pointsPerTorsion,pointCountMode:row.pointCountMode,enabled:true,origin:row.torsion.origin??'automatic'}));
    if(spec.search.clashPolicy||spec.search.torsions.some(row=>row.range))reason='此历史任务含当前界面未提供的采样策略；保留原任务只读浏览。';
  }
  if(spec.kind==='docking'&&!spec.fragments)reason='此历史任务使用双来源对接；保留原任务只读浏览。';
  return{stages,sampling,torsions,reason,candidateLimit:spec.kind==='conformer-search'?spec.search.samplingLimits?.maxCandidates??spec.budget?.maxCandidates??64:64};
}
