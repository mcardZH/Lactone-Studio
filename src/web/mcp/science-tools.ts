import { baseElectronicStateError, baseElectronicStateParameterError } from '../../core/base-electronic-state';
import { isPeriodic } from '../../core/periodic';
import { isXtbMethod, supportsXtbAlpb, supportsXtbOperation, usesXtbSccIterations, XTB_METHOD_IDS } from '../../core/xtb-capabilities';
import type { AdvancedController } from '../../modeling/advanced/controller';
import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import type { AdvancedTaskRecord, AdvancedTaskRun, AdvancedResultFrame } from '../../modeling/advanced/contracts';
import { buildAdvancedClusterCollection } from '../../modeling/advanced/conformer-cluster-collection';
import { getConformerSamplingCapability, NATIVE_CONFORMER_SEED_MAX, type ConformerSamplingMethod } from '../../modeling/advanced/sampling-contracts';
import type { PesRun, PesFrame, PesPathRecord } from '../../modeling/pes/contracts';
import { pesPathRecords } from '../../modeling/pes/path-records';
import type { ComputeResourceSnapshot } from '../../modeling/resource-preferences';
import { desktopBridge } from '../../modeling/platform/desktop';
import { compileAdvancedSinglepointOptions, initialAdvancedMethod, type AdvancedMethodDraft } from '../advanced/AdvancedMethodControls';
import { changeSamplingMethod, type SamplingDraft } from '../advanced/process-config';
import { compileMixedDefinition, compileMixedStages, createMixedConformerDraft, createMixedSamplingCard,
  createMixedTaskSpec, defaultMixedStages, MixedConformerConfigurationError, restoreMixedConformerDraft, type MixedConformerDraft, type MixedSamplingCardDraft } from '../advanced/mixed-conformer-draft';
import { ordinaryOptimizers } from '../modeling/tool-session';
import { gxtbRunBlocked } from '../results/GxtbPathControl';
import { electronicOptions, flag, integer, oneOf, positive, record, targetSchema, textArray, textValue } from './science-arguments';
import { pesTools, pesRuns, pesSourceEvidence, type SciencePesContext } from './science-pes-tools';
import { isScienceFrameReference, pesFrameEvidence, pesRequestEvidence, presentScienceRun, type ScienceMdOptions, type ScienceModelRuntime, type ScienceOptOptions, type ScienceOptSubmission, type ScienceRuntimeRun } from './science-runtime';
import { publishConformerMcpConfiguration } from './science-conformer-state';
import { pesRunScientificEvidence } from './pes-evidence';
import { conformerRunCollectionId, conformerRunCollectionRef, pesRecordRef, retainedOptimizationCollection } from './frame-shell';
import { objectSchema, presentationFields, presentationMode, toolError, type McCall, type McpPresentationMode, type McTool } from './types';
import { checkToolArguments } from './tool-arguments';

export interface ScienceToolsContext extends SciencePesContext {
  advanced(): AdvancedController | undefined | Promise<AdvancedController | undefined>;
  resources(): ComputeResourceSnapshot;
  modelRuntime(target: unknown, options?:{allowInactive?:boolean}): ScienceModelRuntime;
  startFrameOptimization?(source:AdvancedFrameSource, options:ScienceOptOptions):Promise<ScienceOptSubmission>;
  runtimes(): readonly ScienceModelRuntime[];
  bindConformerTask(taskId:string,source:AdvancedFrameSource):void;
  readConformerSource?(taskId:string):AdvancedFrameSource;
  prepareWavefunctionSource?(source:AdvancedFrameSource):Promise<AdvancedFrameSource>;
  prepareConformerSource?(source:AdvancedFrameSource):Promise<AdvancedFrameSource>;
  wavefunctionSettings?(ownerId:string):AdvancedMethodDraft|undefined;
  onWavefunctionTask?(ownerId:string,selection:{taskId:string;runId:string}):void;
  presentConformerConfiguration?(taskId:string,mode:McpPresentationMode,call?:McCall):unknown|Promise<unknown>;
}

const string = {type:'string'};
const boolean = {type:'boolean'};
const positiveInteger = {type:'integer',minimum:1};
const positiveNumber = {type:'number',exclusiveMinimum:0};
const aseSamplingSeedMax = 0xffffffff;
const solvents = {anyOf:[{type:'null'},objectSchema({model:{const:'alpb'},solvent:string},['model','solvent'])]};
const convergence = ['loose','medium','tight','custom'] as const;
const limits = objectSchema({energyDifferenceHartree:positiveNumber,gradientNormHartreePerBohr:positiveNumber},
  ['energyDifferenceHartree','gradientNormHartreePerBohr']);
const optimizationSchema = {
  method:{enum:XTB_METHOD_IDS},optimizer:{enum:Object.keys(ordinaryOptimizers)},
  convergencePreset:{enum:convergence},convergenceLimits:limits,maxSteps:positiveInteger,maxSccIterations:positiveInteger,solvation:solvents,
};
const mdSchema = {method:{enum:XTB_METHOD_IDS},integrator:{enum:['xtb','ase']},temperatureK:{type:'number',minimum:0.01,maximum:5000},
  seed:{type:'integer',minimum:0,maximum:2147483647,description:'Realtime MD seed. Omit for g-xTB, which initializes its own random numbers.'},
  shakeHydrogenBonds:boolean,solvation:solvents,maxWallTimeSeconds:positiveNumber};
const scheduleSchema={temperatureK:positiveNumber,durationFs:positiveNumber,sampleEveryFs:positiveNumber};
const samplingCommon={id:string,shakeHydrogenBonds:boolean,solvation:solvents,dtFs:{type:'number',minimum:0.01,maximum:2},reportEvery:positiveInteger};
const samplingSchema={oneOf:[
  objectSchema({...samplingCommon,kind:{const:'md'},...scheduleSchema,seed:{type:'integer',minimum:0,maximum:aseSamplingSeedMax,
    description:'Native xTB accepts 0–2147483647. ASE accepts 0–4294967295. Omit for g-xTB.'},
    molecularTemperatureK:positiveNumber,molecularDurationFs:positiveNumber,molecularSampleEveryFs:positiveNumber,
    method:{enum:XTB_METHOD_IDS},integrator:{enum:['xtb','ase']}},['kind']),
  objectSchema({...samplingCommon,kind:{const:'metadynamics'},...scheduleSchema,method:{enum:XTB_METHOD_IDS},integrator:{const:'xtb'},
    seed:{type:'integer',minimum:0,maximum:NATIVE_CONFORMER_SEED_MAX,description:'Omit for g-xTB.'},
    metaAtomIds:{type:'array',items:string},depositEveryFs:positiveNumber,heightEV:positiveNumber,sigmaAngstrom:positiveNumber,maxHistory:positiveInteger},['kind']),
  objectSchema({id:string,kind:{const:'conformer-search'},targetCount:{anyOf:[{type:'null'},positiveInteger]},
    torsions:{type:'array',items:objectSchema({id:string,atomIds:{type:'array',items:string,minItems:4,maxItems:4},pointCount:positiveInteger,enabled:boolean},['atomIds'])}},['kind']),
]};
const stageSchema = objectSchema({
  ...optimizationSchema,id:string,inputStride:positiveInteger,inputClusterCount:positiveInteger,
  energyThresholdKcalMol:{type:'number',minimum:0},rmsdThresholdAngstrom:positiveNumber,eliminateEquivalent:boolean,internalConstraintsConfirmed:boolean,
});

function solvation(value:unknown) {
  if(value===undefined||value===null)return value;
  const options=record(value,'solvation');
  if(options.model!=='alpb')throw toolError('INVALID_ARGUMENT','请选择 ALPB 或气相。');
  return {model:'alpb' as const,solvent:textValue(options.solvent,'solvation.solvent')};
}

function optOptions(args:Record<string,unknown>):ScienceOptOptions {
  if(Object.hasOwn(args,'device'))throw toolError('INVALID_ARGUMENT','优化不接受 device 参数。',{field:'device',submitted:false});
  const requested=args.convergenceLimits===undefined?undefined:record(args.convergenceLimits,'convergenceLimits');
  const convergenceLimits=requested?{energyDifferenceHartree:positive(requested.energyDifferenceHartree,'energyDifferenceHartree')!,
    gradientNormHartreePerBohr:positive(requested.gradientNormHartreePerBohr,'gradientNormHartreePerBohr')!}:undefined;
  return {method:oneOf(args.method,XTB_METHOD_IDS,'method'),
    scope:oneOf(args.scope,['all','selection','unselected'],'scope'),optimizer:oneOf(args.optimizer,Object.keys(ordinaryOptimizers),'optimizer') as ScienceOptOptions['optimizer'],
    convergencePreset:oneOf(args.convergencePreset,convergence,'convergencePreset'),convergenceLimits,
    maxSteps:integer(args.maxSteps,'maxSteps',1),maxSccIterations:integer(args.maxSccIterations,'maxSccIterations',1),
    rebuildBonds:flag(args.rebuildBonds,'rebuildBonds'),solvation:solvation(args.solvation)};
}

function mdOptions(args:Record<string,unknown>):ScienceMdOptions{
  return {method:oneOf(args.method,XTB_METHOD_IDS,'method'),integrator:oneOf(args.integrator,['xtb','ase'],'integrator'),
    temperatureK:positive(args.temperatureK,'temperatureK'),seed:integer(args.seed,'seed',0),
    shakeHydrogenBonds:flag(args.shakeHydrogenBonds,'shakeHydrogenBonds'),solvation:solvation(args.solvation),
    maxWallTimeSeconds:positive(args.maxWallTimeSeconds,'maxWallTimeSeconds')};
}

async function advancedController(ctx:ScienceToolsContext){
  const controller=await ctx.advanced();
  if(!controller)throw toolError('UNAVAILABLE','高级任务控制器尚未就绪。');
  return controller;
}

function taskRecord(controller:AdvancedController,value:unknown):AdvancedTaskRecord{
  const id=textValue(value,'taskId'),task=controller.getSnapshot().tasks.find(row=>row.id===id);
  if(!task)throw toolError('TARGET_MISSING','高级任务已关闭或不属于当前项目。');
  return task;
}

function conformerTask(controller:AdvancedController,value:unknown){
  const task=taskRecord(controller,value);
  if(!task.mixedSampling||task.spec.kind!=='sampling')throw toolError('UNAVAILABLE','此入口配置当前混合构象工作台。');
  return task as AdvancedTaskRecord&{mixedSampling:NonNullable<AdvancedTaskRecord['mixedSampling']>;spec:Extract<AdvancedTaskRecord['spec'],{kind:'sampling'}>};
}

function availableSamplingCards(source:AdvancedFrameSource){
  const periodic=isPeriodic(source.structure);
  const mdMethods=XTB_METHOD_IDS.filter(method=>supportsXtbOperation(method,'md',periodic));
  const seedRanges={xtb:{minimum:0,maximum:NATIVE_CONFORMER_SEED_MAX},ase:{minimum:0,maximum:aseSamplingSeedMax}};
  return [{kind:'md',methods:mdMethods,integrators:periodic?['ase']:['xtb','ase'],
    seedRanges:periodic?{ase:seedRanges.ase}:seedRanges,omitSeedFor:['gxtb']},
    ...(!periodic?[{kind:'metadynamics',methods:XTB_METHOD_IDS.filter(method=>supportsXtbOperation(method,'metadynamics')),
      integrators:['xtb'],seedRanges:{xtb:seedRanges.xtb},omitSeedFor:['gxtb']},
      {kind:'conformer-search',requires:'independently rotatable torsions'}]:[])];
}

function candidateReadiness(task:ReturnType<typeof conformerTask>){
  const workflow=task.conformerWorkflow,candidateSet=workflow?.candidateSet;
  const producer=task.runs.find(run=>run.id===candidateSet?.producerRunId);
  const samplingRuns=task.runs.filter(run=>run.intent==='sampling'||run.mixedSampling);
  const active=samplingRuns.filter(run=>['queued','running','stopping'].includes(run.status)).at(-1);
  const latest=samplingRuns.at(-1);
  const state=candidateSet?.valid?'available':active?'sampling-in-progress':candidateSet?.frameIds.length?'retained-candidates-invalidated':
    latest?.status==='failed'?'sampling-failed':latest?.status==='stopped'?'sampling-stopped':latest?'no-accepted-candidates':'sampling-required';
  const readRun=active??latest??producer;
  return {state,workflowRevision:workflow?.revision,candidateRevision:candidateSet?.revision,candidateSetId:candidateSet?.id,
    candidateCount:candidateSet?.frameIds.length??0,producerRunId:candidateSet?.producerRunId,
    producerWorkflowRevision:producer?.workflowRevision,samplingRunId:readRun?.id,samplingStatus:readRun?.status,samplingError:latest?.error,
    ...(state==='available'?{}:{recovery:active?{tool:'es_run_wait',arguments:{runId:active.id,waitMs:5000}}:
      readRun?{tool:'es_run_read',arguments:{runId:readRun.id}}:{tool:'es_conformer_read',arguments:{taskId:task.id}}})};
}

function conformerSummary(task:ReturnType<typeof conformerTask>){
  return {taskId:task.id,revision:task.revision??0,workflowRevision:task.conformerWorkflow?.revision,
    source:task.spec.source.ref,origin:task.spec.originFrame,electronic:{charge:task.spec.source.structure.charge,multiplicity:task.spec.source.structure.multiplicity,
      confirmed:Boolean(task.mixedSampling.electronicConfirmation)},
    sampling:task.mixedSampling.draft,availableSamplingCards:availableSamplingCards(task.spec.source),stages:task.spec.optimizationStages,
    candidateReadiness:candidateReadiness(task),
    collections:task.conformerWorkflow?.stages.map(stage=>{
      const producer=task.runs.find(run=>run.id===stage.producerRunId),collection=buildAdvancedClusterCollection(task,stage.stageId);
      const retained=stage.valid&&stage.completed&&producer&&stage.representativeFrameIds.every(id=>producer.frames.some(frame=>frame.id===id));
      const plottable=collection?.comparison&&collection.clusters.some(row=>typeof row.energyHartree==='number'&&Number.isFinite(row.energyHartree));
      return {stageId:stage.stageId,producerRunId:stage.producerRunId,collectionId:stage.collectionId,
        valid:stage.valid,completed:stage.completed,representativeCount:stage.representativeFrameIds.length,
        ...(retained?{representativeSelection:{targetRef:conformerRunCollectionRef(task.id,stage.producerRunId),frameIds:[...stage.representativeFrameIds]}}:{}),
        ...(plottable?{plotTargetRef:stage.collectionId}:{})};
    }),
    candidateSet:task.conformerWorkflow?.candidateSet&&{id:task.conformerWorkflow.candidateSet.id,revision:task.conformerWorkflow.candidateSet.revision,producerRunId:task.conformerWorkflow.candidateSet.producerRunId,
      valid:task.conformerWorkflow.candidateSet.valid,count:task.conformerWorkflow.candidateSet.frameIds.length},
    retainedCollections:task.runs.filter(run=>run.frames.length&&!['queued','running','stopping'].includes(run.status)).map(run=>({ref:conformerRunCollectionRef(task.id,run.id),
      collectionId:conformerRunCollectionId(run.id),taskId:task.id,runId:run.id,frameCount:run.frames.length,status:run.status})),
    runs:task.runs.map(run=>({runId:run.id,status:run.status,intent:run.intent}))};
}

function conformerConfiguration<T>(source:AdvancedFrameSource,taskId:string|undefined,compile:()=>T):T {
  try{return compile();}
  catch(cause){
    if(!(cause instanceof MixedConformerConfigurationError))throw cause;
    throw toolError('CONFORMER_CARD_INVALID',cause.message,{taskId,source:source.ref,submitted:false,configurationChanged:false,
      issues:cause.issues,availableSamplingCards:availableSamplingCards(source),
      ...(taskId?{recovery:{tool:'es_conformer_read',arguments:{taskId}}}:{}),
      configureTool:'es_conformer_configure'});
  }
}

function samplingCard(value:unknown,source:AdvancedFrameSource,previous:readonly MixedSamplingCardDraft[]):MixedSamplingCardDraft{
  checkToolArguments(samplingSchema,value);
  const args=record(value,'sampling card');
  const kind=oneOf(args.kind,['md','metadynamics','conformer-search'],'kind');
  if(!kind)throw toolError('INVALID_ARGUMENT','请选择采样卡类型。');
  const id=args.id===undefined?undefined:textValue(args.id,'id');
  const card={...(previous.find(row=>row.id===id&&row.kind===kind)??createMixedSamplingCard(kind,source)),...(id?{id}:{})};
  if(kind==='conformer-search'){
    if(args.torsions!==undefined){
      if(!Array.isArray(args.torsions))throw toolError('INVALID_ARGUMENT','torsions 需要数组。');
      card.torsions=args.torsions.map(item=>{
        const row=record(item,'torsion'),atomIds=textArray(row.atomIds,'atomIds');
        if(atomIds.length!==4||new Set(atomIds).size!==4)throw toolError('INVALID_ARGUMENT','柔性键需要四个不同原子。');
        return {id:row.id===undefined?crypto.randomUUID():textValue(row.id,'id'),atomIds,origin:'manual',
          enabled:flag(row.enabled,'enabled')??true,pointCount:integer(row.pointCount,'pointCount',1)??3,
          pointCountMode:row.pointCount===undefined?'automatic':'manual'};
      });
      card.activeTorsionId=card.torsions[0]?.id??'';
    }
    if(args.targetCount!==undefined)card.targetText=args.targetCount===null?'':String(integer(args.targetCount,'targetCount',1));
    return card;
  }
  const periodic=isPeriodic(source.structure);
  const method=args.method===undefined?card.sampling.method:textValue(args.method,'method');
  if(!supportsXtbOperation(method,kind,periodic))throw toolError('INVALID_ARGUMENT','请选择当前体系支持的 xTB 采样方法。');
  const medium=solvation(args.solvation);
  const requestedIntegrator=oneOf(args.integrator,['xtb','ase'],'integrator');
  const integrator=requestedIntegrator??(periodic?'ase':card.sampling.integrator);
  const sampling=changeSamplingMethod({...card.sampling,integrator},method as ConformerSamplingMethod,periodic);
  const capability=getConformerSamplingCapability({...sampling,periodic});
  if(requestedIntegrator&&requestedIntegrator!==capability.integrator)throw toolError('INVALID_ARGUMENT','当前体系和方法不支持所选的采样积分器。');
  if(medium&&!supportsXtbAlpb(method,medium.solvent,periodic))throw toolError('INVALID_ARGUMENT','当前体系或方法不支持所选的 ALPB 溶剂。');
  const settings:Partial<SamplingDraft>={};
  const keys=kind==='md'?(['dtFs','reportEvery'] as const):(['dtFs','reportEvery','temperatureK','durationFs','sampleEveryFs','depositEveryFs','heightEV','sigmaAngstrom','maxHistory'] as const);
  for(const key of keys){
    if(args[key]!==undefined)settings[key]=args[key] as number;
  }
  if(kind==='md')for(const [canonical,alias] of [['molecularTemperatureK','temperatureK'],['molecularDurationFs','durationFs'],['molecularSampleEveryFs','sampleEveryFs']] as const){
    if(args[canonical]!==undefined&&args[alias]!==undefined&&args[canonical]!==args[alias])throw toolError('INVALID_ARGUMENT',`${alias} 和 ${canonical} 的取值须一致。`);
    const selected=args[canonical]??args[alias];if(selected!==undefined)settings[canonical]=selected as number;
  }
  const seed=integer(args.seed,'seed',0);
  const shakeHydrogenBonds=flag(args.shakeHydrogenBonds,'shakeHydrogenBonds');
  const seedMax=capability.driver==='native-xtb-md'?NATIVE_CONFORMER_SEED_MAX:aseSamplingSeedMax;
  if(seed!==undefined&&method==='gxtb')throw toolError('INVALID_ARGUMENT','g-xTB 由程序初始化随机种子，请省略 seed。',
    {field:'seed',method,integrator:capability.integrator,seedTreatment:'native-program-random',submitted:false});
  if(seed!==undefined&&seed>seedMax)throw toolError('INVALID_ARGUMENT',`当前采样后端的随机种子须为 0–${seedMax} 的整数。`,
    {field:'seed',method,integrator:capability.integrator,minimum:0,maximum:seedMax,submitted:false});
  if(shakeHydrogenBonds&&!capability.shakeSupported)throw toolError('INVALID_ARGUMENT','所选采样方法和积分器不支持 X–H SHAKE。');
  card.sampling={...sampling,...settings,...(seed===undefined?{}:{seed,seedMode:'explicit'}),
    ...(shakeHydrogenBonds===undefined?{}:{shakeHydrogenBonds,hydrogenMassAmu:shakeHydrogenBonds?1:4}),
    ...(medium===undefined?{}:{solvationModel:medium?'alpb':'none',solvent:medium?.solvent??sampling.solvent}),
    ...(args.metaAtomIds===undefined?{}:{metaIds:textArray(args.metaAtomIds,'metaAtomIds'),metaScope:'selected'})};
  return card;
}

function stageDraft(value:unknown,index:number,previous:MixedConformerDraft['stages'],periodic:boolean):MixedConformerDraft['stages'][number]{
  checkToolArguments(stageSchema,value);
  const args=record(value,'stage'),id=args.id===undefined?'stage-'+(index+1):textValue(args.id,'id');
  const defaults=previous.find(row=>row.id===id)??{...defaultMixedStages()[0],id};
  const options=optOptions(args),method=options.method??defaults.method.method;
  if(!isXtbMethod(method))throw toolError('INVALID_ARGUMENT','请为此构象优化级选择支持的 xTB 方法。');
  if(options.convergenceLimits&&(options.convergencePreset??defaults.method.convergencePreset??'loose')!=='custom')throw toolError('INVALID_ARGUMENT','自定义收敛限度需配合自定义预设。');
  if(options.maxSccIterations!==undefined&&!usesXtbSccIterations(method))throw toolError('INVALID_ARGUMENT','所选方法不使用 SCC 迭代上限。');
  if(options.solvation&&!supportsXtbAlpb(method,options.solvation.solvent,periodic))throw toolError('INVALID_ARGUMENT','当前体系或方法不支持所选的 ALPB 溶剂。');
  if(index===0&&args.inputClusterCount!==undefined||index!==0&&args.inputStride!==undefined)throw toolError('INVALID_ARGUMENT','第一级使用抽帧间隔，后续级使用输入簇数。');
  if(periodic&&args.eliminateEquivalent===true)throw toolError('INVALID_ARGUMENT','固定晶胞归簇现有流程不进行分子等价消除。');
  const energy=args.energyThresholdKcalMol??defaults.energyThresholdKcalMol;
  if(typeof energy!=='number'||!Number.isFinite(energy)||energy<0)throw toolError('INVALID_ARGUMENT','归簇能量差须为非负数。');
  return {...defaults,energyThresholdKcalMol:energy,rmsdThresholdAngstrom:positive(args.rmsdThresholdAngstrom,'rmsdThresholdAngstrom')??defaults.rmsdThresholdAngstrom,
    inputStride:integer(args.inputStride,'inputStride',1)??defaults.inputStride,inputClusterCount:integer(args.inputClusterCount,'inputClusterCount',1)??defaults.inputClusterCount,
    eliminateEquivalent:flag(args.eliminateEquivalent,'eliminateEquivalent')??defaults.eliminateEquivalent,
    method:{...defaults.method,method:method as typeof defaults.method.method,retiredMethod:undefined,
      device:undefined,optimizer:options.optimizer??defaults.method.optimizer,maxSteps:options.maxSteps??defaults.method.maxSteps,
      convergencePreset:options.convergencePreset??defaults.method.convergencePreset,convergenceLimits:options.convergenceLimits??defaults.method.convergenceLimits,
      ...(options.maxSccIterations===undefined?{}:{sccIterationLimit:options.maxSccIterations,sccIterationLimitExplicit:true}),
      ...(options.solvation===undefined?{}:{solvationModel:options.solvation?'alpb':'none',solvent:options.solvation?.solvent??defaults.method.solvent}),
      internalConstraintsConfirmed:flag(args.internalConstraintsConfirmed,'internalConstraintsConfirmed')??defaults.method.internalConstraintsConfirmed}};
}

export async function checkGxtb(method:string) {
  if(method!=='gxtb')return;
  const state=await desktopBridge()?.gxtbBackendInfo?.();
  if(!state||gxtbRunBlocked(state,method))throw toolError('UNAVAILABLE','请先在全局设置中配置可用的 g-xTB 程序。');
}

function explicitElectronic(source:AdvancedFrameSource, value:unknown){
  const existing={charge:source.structure.charge!,multiplicity:source.structure.multiplicity!};
  if(value!==undefined){
    const args=record(value,'electronic');
    if(integer(args.charge,'charge')!==existing.charge||integer(args.multiplicity,'multiplicity',1)!==existing.multiplicity)
      throw toolError('CONFLICT','请求电子态与当前来源不同。请先在所属模型提交电荷和多重度。');
  }
  const issue=baseElectronicStateParameterError(source.structure,existing);
  if(issue)throw toolError('INVALID_ARGUMENT',issue);
  return existing;
}

async function generateWavefunction(ctx:ScienceToolsContext,controller:AdvancedController,args:Record<string,unknown>,target:unknown,call?:McCall){
  const electronic=electronicOptions(args.electronic);
  let source=await ctx.resolveSource(target,call?.signal,electronic);
  const origin=source.ref;
  const draft=ctx.wavefunctionSettings?.(source.ref.documentId)??initialAdvancedMethod;
  const method=oneOf(args.method,['gfn2','gxtb'],'method')??draft.method;
  const medium=solvation(args.solvation);
  const options=compileAdvancedSinglepointOptions({...draft,method,threads:ctx.resources().effective.threads,
    ...(args.maxSccIterations===undefined?{}:{sccIterationLimit:integer(args.maxSccIterations,'maxSccIterations',1)!,sccIterationLimitText:undefined}),
    ...(medium===undefined?{}:{solvationModel:medium?'alpb':'none',solvent:medium?.solvent??draft.solvent})});
  explicitElectronic(source,args.electronic);
  await checkGxtb(method);
  call?.signal.throwIfAborted();
  if(ctx.prepareWavefunctionSource)source=await ctx.prepareWavefunctionSource(source);
  call?.signal.throwIfAborted();
  const taskId=controller.createTask({kind:'singlepoint',source,options,...(origin===source.ref?{}:{originFrame:origin})});
  let runId:string;
  try{runId=controller.start(taskId);}
  catch(cause){throw toolError('START_FAILED',cause instanceof Error?cause.message:String(cause),{taskId,source:source.ref,origin});}
  ctx.onWavefunctionTask?.(source.ref.documentId,{taskId,runId});
  const {maxSteps:_maxSteps,optimizationStepPolicy:_optimizationStepPolicy,internalConstraintsConfirmed:_internalConstraintsConfirmed,...request}=options;
  return {kind:'advanced' as const,taskId,runId,documentId:source.ref.documentId,operation:'singlepoint',status:taskRecord(controller,taskId).runs.find(run=>run.id===runId)?.status,
    source:source.ref,origin,request,notApplicable:['maxSteps','geometryOptimization','geometryConstraints'],accepted:true};
}

function runSummary(task:AdvancedTaskRecord,run:AdvancedTaskRun,controller:AdvancedController){
  const native=controller.getSnapshot().activeNative;
  const capturedSource=run.mixedSampling?.source;
  const legacySource=run.stages[0]?.inputs?.[0]?.source??run.results[0]?.input??task.spec.source;
  const identity=capturedSource?{ref:capturedSource.ref,origin:run.sourceIdentity?.origin??task.spec.originFrame,
    charge:capturedSource.structure.charge,multiplicity:capturedSource.structure.multiplicity}:run.sourceIdentity??
    {ref:legacySource.ref,origin:task.spec.originFrame,charge:legacySource.structure.charge,multiplicity:legacySource.structure.multiplicity};
  const mixed=run.mixedSampling;
  const mixedTask=!!(task.mixedSampling||task.spec.kind==='sampling'&&task.spec.mixedSampling);
  const singlepoint=task.spec.kind==='singlepoint'?task.spec.options:undefined;
  const electronicRequest=singlepoint&&(({
    maxSteps:_maxSteps,optimizationStepPolicy:_optimizationStepPolicy,internalConstraintsConfirmed:_internalConstraintsConfirmed,...scientific
  })=>scientific)(singlepoint);
  const acceptedMetadata=singlepoint?run.results[0]?.metadata:undefined;
  const executions=mixed?.executions?.map(({frameIds,candidateFrameIds,stages,...row})=>({...row,frameCount:frameIds?.length,candidateFrameCount:candidateFrameIds?.length,
    retainedThroughTimeFs:row.completedTimeFs,effective:stages?.filter(stage=>stage.configuration||stage.integration),
    ...(row.kind==='sampling'?{notApplicable:['frictionPerFs']}: {})}));
  return {kind:'advanced' as const,taskId:task.id,runId:run.id,documentId:identity.ref.documentId,operation:mixedTask?'mixed-conformer':task.spec.kind,status:run.status,mode:run.mode,intent:run.intent,
    ...(mixedTask&&run.frames.length?{collectionRef:conformerRunCollectionRef(task.id,run.id),collectionId:conformerRunCollectionId(run.id)}:{}),
    source:identity.ref,origin:identity.origin,fromRunId:run.fromRunId,createdAt:run.createdAt,startedAt:run.startedAt,finishedAt:run.finishedAt,
    electronic:{charge:identity.charge,multiplicity:identity.multiplicity},
    activeNative:native?.runId===run.id?native:undefined,progress:run.backgroundProgress,checkpoint:run.checkpoint,
    frameCount:run.frames.length,resultCount:run.results.length,stopReason:run.stopReason,error:run.error,
    request:electronicRequest??(mixedTask?undefined:run.sourceConfiguration),
    ...(singlepoint?{notApplicable:['maxSteps','geometryOptimization','geometryConstraints'],effective:acceptedMetadata&&{
      method:acceptedMetadata.method,threads:acceptedMetadata.threads,resourceGrant:acceptedMetadata.resourceGrant,
      sccIterationLimit:acceptedMetadata.sccIterationLimit,sccIterations:acceptedMetadata.sccIterations,solvation:acceptedMetadata.solvation,
      engine:acceptedMetadata.engine,version:acceptedMetadata.version,engineIdentity:acceptedMetadata.engineIdentity}}:{}),
    mixedSampling:mixed&&{batchId:mixed.batchId,initialGuessId:mixed.initialGuessId,action:mixed.action,mode:mixed.mode,
      definition:mixed.definition,currentSegmentId:mixed.currentSegmentId,
      batchCounts:{generated:mixed.generated,duplicates:mixed.duplicates,coreRejected:mixed.coreRejected,accepted:mixed.accepted},
      deduplication:mixed.deduplication&&{...mixed.deduplication,processed:mixed.deduplicationProcessed,total:mixed.deduplicationTotal,completed:mixed.deduplicationCompleted},
      cards:mixed.cards.map(({sampling,frameIds,...card})=>{
        const legacy=sampling?.stageEvents.filter(stage=>stage.runIdentity.runId===run.id).flatMap(stage=>{
          if(!stage.configuration&&!stage.integration)return [];
          const {structure:_structure,frictionPerFs:_friction,...configuration}=stage.configuration??{};
          return [{stageId:stage.stageId,status:stage.status,step:stage.step,integration:stage.integration,configuration:stage.configuration?configuration:undefined}];
        });
        return {...card,candidateFrameCount:frameIds.length,...(!executions&&legacy?.length?{lastObservedSegment:{effective:legacy}}:{})};
      }),executions},
    stages:run.stages.map(stage=>({stageId:stage.id,configurationId:stage.configurationId,status:stage.status,progress:stage.progress,outcome:stage.outcome,
      configuration:stage.configuration,collectionId:stage.collectionId,batchId:stage.batchId,adoptionError:stage.adoptionError,
      inputCount:stage.inputCandidateIds.length,promotedCount:stage.promotedCandidateIds.length,batchProgress:stage.batchProgress,
      counts:{completed:stage.results.filter(row=>row.status==='completed').length,unconverged:stage.results.filter(row=>row.status==='unconverged').length,
        failed:stage.results.filter(row=>row.status==='failed').length,stopped:stage.results.filter(row=>row.status==='stopped').length},
      clustering:stage.clustering&&{inputCount:stage.results.length,acceptedCount:stage.clustering.acceptedCount,rejectedCount:stage.clustering.rejected.length,
        representativeCount:stage.clustering.groups.reduce((sum,group)=>sum+group.clusters.length,0),policy:stage.clustering.policy,equivalence:stage.clustering.equivalence}})),
    scientificStatus:run.results.length===1?run.results[0].status:undefined,
    adoption:task.spec.kind==='singlepoint'?run.results[0]?.electronic:undefined};
}

function pesRecordSelection(targetRef:string|undefined,record:PesPathRecord){
  return targetRef&&record.frames.length?{targetRef:pesRecordRef(targetRef,record.id)}:undefined;
}

function pesRunSummary(run:PesRun,targetRef?:string){
  const records=pesPathRecords(run);
  const latestRecord=records.at(-1);
  return {kind:'pes',...run.request.runIdentity,nodeId:run.nodeId,targetRef,operation:run.request.operation,algorithm:run.request.algorithm,status:run.status,
    request:pesRequestEvidence(run.request),progress:run.progress,scientificStatus:run.result?.status,
    nativeStarted:run.nativeStarted,nativeBackend:run.nativeBackend,workerSettled:run.workerSettled,
    ...pesSourceEvidence(run.source),inputs:run.inputSources&&{atomMappings:run.inputSources.mappings,
      slots:Object.fromEntries(Object.entries(run.inputSources.slots).map(([key,value])=>[key,value&&{...pesSourceEvidence(value),
        inputSnapshotId:value.inputSnapshotId,documentId:value.documentId,revision:value.revision}]))},
    frameCount:(run.result?.frames??run.acceptedFrames??[]).length,recordCount:records.length,...retainedOptimizationCollection(run),
    latestRecord:latestRecord&&{recordId:latestRecord.id,frameCount:latestRecord.frames.length,frameSelection:pesRecordSelection(targetRef,latestRecord)},
    error:run.error,supersededByRunId:run.supersededByRunId,...pesRunScientificEvidence(run)};
}

async function readRuns(ctx:ScienceToolsContext){
  const [advanced,pes]=await Promise.allSettled([Promise.resolve().then(()=>ctx.advanced()),Promise.resolve().then(()=>ctx.pes())]);
  const message=(result:PromiseRejectedResult)=>result.reason instanceof Error?result.reason.message:String(result.reason);
  return {advanced:advanced.status==='fulfilled'?advanced.value:undefined,pes:pes.status==='fulfilled'?pes.value:undefined,
    pesTarget:ctx.pesTarget?.bind(ctx),runtimes:ctx.runtimes(),
    unavailable:{...(advanced.status==='rejected'?{advanced:message(advanced)}:{}),...(pes.status==='rejected'?{pes:message(pes)}:{})}};
}
type RunOwners=Awaited<ReturnType<typeof readRuns>>;
type OwnedRun={kind:'advanced';controller:AdvancedController;task:AdvancedTaskRecord;run:AdvancedTaskRun}|
  {kind:'pes';controller:NonNullable<Awaited<ReturnType<SciencePesContext['pes']>>>;run:PesRun;targetRef?:string}|
  {kind:'model';runtime:ScienceModelRuntime;run:ScienceRuntimeRun};

function ownedRun(owners:RunOwners,value:unknown):OwnedRun{
  const runId=textValue(value,'runId');
  if(owners.advanced){
    for(const task of owners.advanced.getSnapshot().tasks){
      const run=task.runs.find(row=>row.id===runId);
      if(run)return {kind:'advanced',controller:owners.advanced,task,run};
    }
  }
  const pes=owners.pes&&pesRuns(owners.pes).find(run=>run.request.id===runId);
  if(owners.pes&&pes)return {kind:'pes',controller:owners.pes,run:pes,targetRef:owners.pesTarget?.(pes.request.runIdentity.groupId,pes.nodeId)};
  for(const runtime of owners.runtimes){
    const run=runtime.runs().find(row=>row.runId===runId);
    if(run)return {kind:'model',runtime,run};
  }
  if(Object.keys(owners.unavailable).length)throw toolError('UNAVAILABLE','部分运行记录暂不可读取。',owners.unavailable);
  throw toolError('TARGET_MISSING','运行已关闭或不属于当前项目。');
}

function ownedSummary(owner:OwnedRun){
  switch(owner.kind){
    case 'advanced':return runSummary(owner.task,owner.run,owner.controller);
    case 'pes':return pesRunSummary(owner.run,owner.targetRef);
    case 'model':return {...owner.run};
  }
}

function settledStopDisposition(owner:OwnedRun) {
  const {status}=owner.run;
  if(status==='stopping')return 'already-stopping';
  if((owner.kind!=='advanced'&&owner.run.workerSettled===true)||
    ['completed','stopped','failed','error','interrupted','checkpoint'].includes(status))return 'already-finished';
}

function runObservationSettled(owner:OwnedRun) {
  if(!['completed','stopped','failed','error','interrupted','checkpoint'].includes(owner.run.status))return false;
  if(owner.kind==='advanced')return owner.controller.getSnapshot().activeNative?.runId!==owner.run.id;
  if(owner.kind==='model'&&(owner.run.resultAdoption==='pending'||owner.run.workerSettled===false))return false;
  return owner.run.workerSettled===true||!owner.run.nativeStarted;
}

function sameRunOwner(before:OwnedRun,after:OwnedRun) {
  if(before.kind==='model')return after.kind==='model'&&(before.runtime.identity??before.runtime)===(after.runtime.identity??after.runtime);
  return after.kind===before.kind&&before.controller===after.controller;
}

function waitForRunUpdate(owner:OwnedRun,ms:number,signal?:AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve,reject)=>{
    let release=()=>{};
    const cleanup=()=>{clearTimeout(timer);release();signal?.removeEventListener('abort',abort);};
    const done=()=>{cleanup();resolve();};
    const abort=()=>{cleanup();reject(signal?.reason);};
    const timer=setTimeout(done,ms);
    release=owner.kind==='model'?owner.runtime.subscribe?.(done)??(()=>{}):owner.controller.subscribe(done);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
}

function frameSummary(frame:AdvancedResultFrame,geometry:boolean){
  const data=frame.process?.kind==='sampling'?frame.process.data:undefined;
  return {frameId:frame.id,source:frame.source.ref,parentRef:frame.parentRef,parentRefs:frame.parentRefs,
    sessionId:frame.sessionId,taskId:frame.taskId,runId:frame.runId,stageId:frame.stageId,candidateId:frame.candidateId,kind:frame.kind,
    coordinateUnit:frame.source.coordinateUnit,energyUnit:'hartree',energyHartree:frame.energyHartree,step:frame.step,
    atomCount:frame.source.structure.atoms.length,preparation:frame.source.samplingPreparation,samplingOrigin:frame.samplingOrigin&&{
      initialGuessId:frame.samplingOrigin.initialGuessId,cardId:frame.samplingOrigin.cardId,cardRevision:frame.samplingOrigin.cardRevision,
      batchId:frame.samplingOrigin.batchId,segmentId:frame.samplingOrigin.segmentId,source:frame.samplingOrigin.source.ref,
      protectedAtomIds:frame.samplingOrigin.protectedAtomIds,discreteTorsions:frame.samplingOrigin.discreteTorsions},
    sampling:data&&{driver:data.driver,timeFs:data.timeFs,localStep:data.localStep,localTimeFs:data.localTimeFs,cumulativeStep:data.cumulativeStep,cumulativeTimeFs:data.cumulativeTimeFs,
      temperatureK:data.temperatureK,targetTemperatureK:data.targetTemperatureK,biasHistoryCount:data.biasHistoryCount,source:data.nativeMD,
      energyEV:{physical:data.physicalEnergyEV,coreBias:data.coreBiasEV,metaBias:data.metaBiasEV,sphereBias:data.sphereBiasEV,sampledPotential:data.sampledPotentialEV,kinetic:data.kineticEnergyEV}},
    ...(geometry?{structure:frame.source.structure}:{})};
}

function modelTarget(source:AdvancedFrameSource) {
  return {modelRef:source.ref.documentId,revision:source.ref.revision};
}

function scienceStartError(cause:unknown,source:AdvancedFrameSource,target:unknown){
  if(!(cause instanceof Error)||!('code' in cause)||typeof cause.code!=='string'||
    !['SCIENCE_SOURCE_CHANGED','SCIENCE_FRAME_UNAVAILABLE','SCIENCE_MD_EDITABLE_SOURCE_REQUIRED'].includes(cause.code))return cause;
  const frameRef=typeof target==='string'&&target.startsWith('["es-frame-v1",')?target:
    target&&typeof target==='object'&&'frameRef' in target&&typeof target.frameRef==='string'?target.frameRef:undefined;
  const targetRef=source.ref.documentId;
  const recovery=cause.code==='SCIENCE_MD_EDITABLE_SOURCE_REQUIRED'&&frameRef?{tool:'frame_extract',arguments:{frameRef}}:
    isScienceFrameReference(source.ref)?{tool:'frames_select',arguments:{targetRef}}:{tool:'model_read',arguments:{modelRef:targetRef}};
  return toolError(cause.code,cause.message,{...('data'in cause&&cause.data&&typeof cause.data==='object'?cause.data:{}),recovery});
}

export function scienceTools(ctx:ScienceToolsContext):McTool[]{
  const wavefunctionSchema={method:{enum:['gfn2','gxtb']},maxSccIterations:positiveInteger,solvation:solvents,
    electronic:objectSchema({charge:{type:'integer'},multiplicity:positiveInteger},['charge','multiplicity'])};
  async function presentConformerConfiguration(config:ReturnType<typeof conformerSummary>,args:Record<string,unknown>,call?:McCall){
    if(!ctx.presentConformerConfiguration)return config;
    const mode=presentationMode(args);
    if(mode==='background')return {...config,presentation:{mode,status:'background'}};
    if(call?.signal.aborted)return {...config,presentation:{mode,status:'cancelled'}};
    try{return {...config,presentation:await ctx.presentConformerConfiguration(config.taskId,mode,call)};}
    catch(cause){return {...config,presentation:{mode,status:'unavailable',message:cause instanceof Error?cause.message:String(cause)}};}
  }
  return [...pesTools(ctx),{
    name:'es_opt_start',description:'Start ordinary optimization with the applied modeling method (also used by Space), or explicitly select a method for this system type. A compatible electronic pair updates the editable model or applies to this derived result-frame run. Set retainTrajectory=true for subsequent crop, export or frame-based inputs. Read the finished run with es_run_read, then pass its collectionRef as frames_select targetRef.',
    inputSchema:objectSchema({target:targetSchema,...optimizationSchema,electronic:wavefunctionSchema.electronic,
      scope:{enum:['all','selection','unselected']},rebuildBonds:boolean,retainTrajectory:boolean,...presentationFields}),
    async call(args,call){
      const electronic=electronicOptions(args.electronic),presentation=presentationMode(args);
      const source=await ctx.resolveSource(args.target,call?.signal,electronic);
      call?.signal.throwIfAborted();
      try{
        if(electronic){
          const issue=baseElectronicStateError(source.structure,electronic);
          if(issue)throw toolError('INVALID_ARGUMENT',issue,{field:'electronic',source:source.ref,submitted:false});
        }
        const options={...optOptions(args),electronic,retainTrajectory:flag(args.retainTrajectory,'retainTrajectory'),presentation};
        const run=isScienceFrameReference(source.ref)&&ctx.startFrameOptimization
          ?await ctx.startFrameOptimization(source,options)
          :await ctx.modelRuntime(modelTarget(source),{allowInactive:true}).startOptimization(source,options);
        return presentScienceRun(ctx,{...run,documentId:source.ref.documentId,operation:'opt'},args,call);
      }catch(cause){throw scienceStartError(cause,source,args.target);}
    },
  },{
    name:'es_md_start',description:'Start native realtime MD on an editable model. If the requested result frame has no realtime owner, extract the exact frame and use the returned editable model. Use es_run_wait to follow an existing run and es_run_control to stop continuous MD.',
    inputSchema:objectSchema({target:targetSchema,...mdSchema,...presentationFields}),
    async call(args,call){
      const source=await ctx.resolveSource(args.target,call?.signal);
      call?.signal.throwIfAborted();
      try{
        const run=await ctx.modelRuntime(modelTarget(source)).startMd(source,mdOptions(args));
        return presentScienceRun(ctx,{...run,next:{tool:'es_run_read',arguments:{runId:run.runId}}},args,call);
      }catch(cause){throw scienceStartError(cause,source,args.target);}
    },
  },{
    name:'es_xtb2_generate',description:'Generate a managed Molden wavefunction using the same GFN2-xTB or g-xTB product operation. Provide a single model/frame target or independently configured members.',
    inputSchema:objectSchema({target:targetSchema,...wavefunctionSchema,...presentationFields,items:{type:'array',minItems:1,items:objectSchema({target:targetSchema,...wavefunctionSchema},['target'])}}),
    async call(args,call){
      const controller=await advancedController(ctx);
      if(args.items===undefined)return presentScienceRun(ctx,await generateWavefunction(ctx,controller,args,args.target,call),args,call);
      if(!Array.isArray(args.items)||!args.items.length)throw toolError('INVALID_ARGUMENT','请指定一个或多个单点来源。');
      const items=[];
      let first:Awaited<ReturnType<typeof generateWavefunction>>|undefined;
      for(const [index,value] of args.items.entries()){
        try{
          call?.signal.throwIfAborted();
          const item=record(value,'item');
          if(item.target===undefined)throw toolError('INVALID_ARGUMENT','批量成员需要明确来源。');
          const receipt=await generateWavefunction(ctx,controller,{...args,...item},item.target,call);
          first??=receipt;items.push({index,...receipt});
        }catch(cause){items.push({index,status:call?.signal.aborted?'cancelled':'rejected',error:cause instanceof Error?cause.message:String(cause),
          details:cause instanceof Error&&'data' in cause?cause.data:undefined});}
      }
      const focused=first&&await presentScienceRun(ctx,first,args,call);
      return {items,...(focused&&'presentation' in focused?{presentation:focused.presentation}:{})};
    },
  },{
    name:'es_conformer_read',description:'Read settings, results and run references from the live mixed conformer workflow.',
    inputSchema:objectSchema({taskId:string}),
    async call(args){
      const controller=await advancedController(ctx);
      if(args.taskId!==undefined)return conformerSummary(conformerTask(controller,args.taskId));
      return {tasks:controller.getSnapshot().tasks.filter(task=>task.mixedSampling&&task.spec.kind==='sampling').map(task=>conformerSummary(conformerTask(controller,task.id)))};
    },
  },{
    name:'es_conformer_configure',description:'Create or update the native mixed conformer workflow. Omitted sampling cards and stages preserve current settings; supplied lists replace them.',
    inputSchema:objectSchema({target:targetSchema,taskId:string,expectedRevision:{type:'integer',minimum:0},expectedWorkflowRevision:{type:'integer',minimum:0},electronic:wavefunctionSchema.electronic,
      cards:{type:'array',items:samplingSchema},stages:{type:'array',items:stageSchema},deduplicationEnabled:boolean,dedupRmsdAngstrom:positiveNumber,
      allowResultInvalidation:boolean,...presentationFields}),
    async call(args,call){
      const controller=await advancedController(ctx),task=args.taskId===undefined?undefined:conformerTask(controller,args.taskId);
      if(task&&args.target!==undefined)throw toolError('INVALID_ARGUMENT','已有任务沿用其实际初猜页，请先在该页修改或单独新建任务。');
      if(task&&args.electronic!==undefined)throw toolError('INVALID_ARGUMENT','已有任务的电子态来自实际初猜页，请在其所属模型上确认。');
      const expected=integer(args.expectedRevision,'expectedRevision',0);
      const workflow=integer(args.expectedWorkflowRevision,'expectedWorkflowRevision',0);
      if(task&&((expected!==undefined&&expected!==(task.revision??0))||
        (workflow!==undefined&&workflow!==task.conformerWorkflow?.revision)))throw toolError('CONFLICT','构象配置或来源已变化，请重新读取。');
      if(task?.runs.some(run=>['queued','running','stopping'].includes(run.status)))throw toolError('CONFLICT','所属构象任务仍在运行，请在结算后再设置。');
      const source=task?(ctx.readConformerSource?.(task.id)??task.spec.source):await ctx.resolveSource(args.target,call?.signal,electronicOptions(args.electronic));
      const draft=task?restoreMixedConformerDraft(task):createMixedConformerDraft();
      const resources=ctx.resources().effective;
      if(args.cards!==undefined){
        if(!Array.isArray(args.cards))throw toolError('INVALID_ARGUMENT','cards 需要数组。');
        draft.cards=args.cards.map(card=>samplingCard(card,source,draft.cards));
      }
      if(args.stages!==undefined){
        if(!Array.isArray(args.stages))throw toolError('INVALID_ARGUMENT','stages 需要数组。');
        draft.stages=args.stages.map((stage,index)=>stageDraft(stage,index,draft.stages,isPeriodic(source.structure)));
      }
      draft.deduplicationEnabled=flag(args.deduplicationEnabled,'deduplicationEnabled')??draft.deduplicationEnabled;
      draft.dedupRmsdAngstrom=positive(args.dedupRmsdAngstrom,'dedupRmsdAngstrom')??draft.dedupRmsdAngstrom;
      call?.signal.throwIfAborted();
      if(task){
        const configureSampling=args.cards!==undefined||args.deduplicationEnabled!==undefined||args.dedupRmsdAngstrom!==undefined;
        const definition=configureSampling?conformerConfiguration(source,task.id,()=>compileMixedDefinition(draft,source,resources)):undefined;
        const stages=args.stages===undefined?undefined:compileMixedStages(draft.stages,resources.threads,isPeriodic(source.structure));
        const samplingImpact=definition&&controller.previewMixedConfiguration(task.id,definition);
        const stageImpact=stages&&controller.previewStageConfiguration(task.id,stages);
        const dedupChanged=definition&&((definition.deduplicationEnabled!==false)!==(task.mixedSampling.draft.deduplicationEnabled!==false)||
          definition.dedupRmsdAngstrom!==(task.mixedSampling.draft.dedupRmsdAngstrom??.01));
        const dedupHasDownstream=dedupChanged&&task.runs.some(run=>run.stages.length>0);
        if((samplingImpact?.requiresConfirmation||stageImpact?.requiresConfirmation||dedupHasDownstream)&&args.allowResultInvalidation!==true)
          throw toolError('CONFIRMATION_REQUIRED','配置会影响已有构象结果。确认影响后可提交同一组设置。',{samplingImpact,stageImpact,dedupHasDownstream});
        if(stages)controller.configureStages(task.id,stages);
        if(definition)controller.configureMixedSampling(task.id,definition);
        const current=conformerTask(controller,task.id);
        if((definition&&current.revision!==task.revision)||(stages&&JSON.stringify(current.spec.optimizationStages)!==JSON.stringify(task.spec.optimizationStages)))
          publishConformerMcpConfiguration(controller,task.id);
        return presentConformerConfiguration(conformerSummary(current),args,call);
      }
      const spec=conformerConfiguration(source,undefined,()=>createMixedTaskSpec(source,draft,resources));
      const owned=ctx.prepareConformerSource?await ctx.prepareConformerSource(source):source;
      call?.signal.throwIfAborted();
      const id=controller.createTask({...spec,source:owned,...(source.ref===owned.ref?{}:{originFrame:source.ref})});
      ctx.bindConformerTask(id,owned);
      return presentConformerConfiguration({...conformerSummary(conformerTask(controller,id)),origin:source.ref},args,call);
    },
  },{
    name:'es_conformer_run',description:'Submit, continue, append or restart sampling, or start/continue/restart a native conformer optimization stage.',
    inputSchema:objectSchema({taskId:string,expectedRevision:{type:'integer',minimum:0},expectedWorkflowRevision:{type:'integer',minimum:0},action:{enum:['sampling','sampling-append','sampling-restart','sampling-reorganize','stage','stage-continue','stage-restart','all-stages']},stageId:string,
      electronic:wavefunctionSchema.electronic,...presentationFields},['taskId','action']),
    async call(args,call){
      const controller=await advancedController(ctx),task=conformerTask(controller,args.taskId);
      const action=oneOf(args.action,['sampling','sampling-append','sampling-restart','sampling-reorganize','stage','stage-continue','stage-restart','all-stages'],'action');
      if(!action)throw toolError('INVALID_ARGUMENT','需要构象任务动作。');
      const expected=integer(args.expectedRevision,'expectedRevision',0)??(task.revision??0);
      const workflow=integer(args.expectedWorkflowRevision,'expectedWorkflowRevision',0)??task.conformerWorkflow?.revision;
      const guardRevision=()=>{
        const current=conformerTask(controller,task.id);
        if(expected!==(current.revision??0)||workflow!==current.conformerWorkflow?.revision)
          throw toolError('CONFLICT','构象配置或来源已变化，请重新读取。');
      };
      guardRevision();
      if(args.stageId!==undefined&&(action.startsWith('sampling')||action==='all-stages'))throw toolError('INVALID_ARGUMENT','stageId 仅用于单个构象优化步骤。');
      if(args.electronic!==undefined&&action==='sampling-reorganize')throw toolError('INVALID_ARGUMENT','整理现有候选不会重新指定电子态。');
      let runId:string;
      call?.signal.throwIfAborted();
      if(action==='sampling-reorganize')runId=controller.reorganizeSampling(task.id);
      else if(action.startsWith('sampling')){
        const preview=action==='sampling'?controller.previewMixedConfiguration(task.id,task.mixedSampling.draft):undefined;
        const pendingMethods=task.mixedSampling.draft.cards.flatMap(card=>card.kind==='sampling'&&
          (!preview||preview.pendingCardIds.includes(card.id))?[card.sampling.method]:[]);
        if(pendingMethods.some(method=>!isXtbMethod(method)))throw toolError('INVALID_ARGUMENT','请为待运行的采样卡选择支持的 xTB 方法。',{taskId:task.id,submitted:false});
        if(pendingMethods.includes('gxtb'))await checkGxtb('gxtb');
        call?.signal.throwIfAborted();guardRevision();
        const source=ctx.readConformerSource?.(task.id)??conformerTask(controller,task.id).spec.source;
        controller.confirmMixedInitialSource(task.id,source,explicitElectronic(source,args.electronic));
        runId=action==='sampling-append'?controller.appendSampling(task.id):action==='sampling-restart'?controller.restartSampling(task.id):controller.continueSampling(task.id);
      }else{
        const stageId=action==='all-stages'?undefined:textValue(args.stageId,'stageId');
        const stages=stageId?task.spec.optimizationStages.filter(stage=>stage.id===stageId):task.spec.optimizationStages;
        if(!stages.length)throw toolError('TARGET_MISSING','没有对应的构象优化级。');
        if(stages.some(stage=>stage.method.backend==='net'))throw toolError('INVALID_ARGUMENT','请为待运行的构象优化级选择支持的 xTB 方法。',
          {taskId:task.id,stageId,submitted:false});
        const readiness=candidateReadiness(task);
        if(readiness.state!=='available')throw toolError('CONFORMER_CANDIDATES_UNAVAILABLE','当前优化级没有可用的上游采样候选。',
          {taskId:task.id,stageId,submitted:false,configurationChanged:false,...readiness});
        const stageIndex=stageId?task.spec.optimizationStages.findIndex(stage=>stage.id===stageId):0;
        const upstreamId=stageIndex>0?task.spec.optimizationStages[stageIndex-1].id:undefined;
        if(upstreamId){
          const upstream=task.conformerWorkflow?.stages.find(stage=>stage.stageId===upstreamId);
          if(!upstream?.valid)throw toolError('CONFORMER_UPSTREAM_UNAVAILABLE','上一级构象优化尚未完成或其结果已失效。',
            {taskId:task.id,stageId,upstreamStageId:upstreamId,submitted:false,state:upstream?'upstream-invalid':'upstream-missing',
              upstreamRunId:upstream?.producerRunId,
              recovery:upstream?{tool:'es_run_read',arguments:{runId:upstream.producerRunId}}:{tool:'es_conformer_read',arguments:{taskId:task.id}}});
        }
        if(stages.some(stage=>stage.method.backend==='xtb'&&stage.method.options.method==='gxtb'))await checkGxtb('gxtb');
        call?.signal.throwIfAborted();guardRevision();
        const source=ctx.readConformerSource?.(task.id)??conformerTask(controller,task.id).spec.source;
        controller.confirmMixedInitialSource(task.id,source,explicitElectronic(source,args.electronic));
        if(!stageId)runId=controller.runAllStages(task.id);
        else runId=action==='stage-restart'?controller.restartStage(task.id,stageId):action==='stage-continue'?controller.continueStage(task.id,stageId):controller.startStage(task.id,stageId);
      }
      const recorded=conformerTask(controller,task.id),run=recorded.runs.find(run=>run.id===runId)!;
      return presentScienceRun(ctx,{...runSummary(recorded,run,controller),stageId:run.stages[0]?.configurationId,accepted:true},args,call);
    },
  },...runTools(ctx)];
}

function runTools(ctx:ScienceToolsContext):McTool[]{
  return [{
    name:'es_run_list',description:'List current-project internal ES runs and their actual status and result counts.',
    inputSchema:objectSchema({offset:{type:'integer',minimum:0},limit:positiveInteger}),
    async call(args){
      const {advanced,pes,runtimes,unavailable}=await readRuns(ctx);
      const rows=[
        ...runtimes.flatMap(runtime=>runtime.runs().map(run=>({kind:run.kind,runId:run.runId,status:run.status,documentId:run.documentId}))),
        ...pesRuns(pes).map(run=>({kind:'pes',...run.request.runIdentity,status:run.status,operation:run.request.operation})),
        ...(advanced?.getSnapshot().tasks.flatMap(task=>task.runs.map(run=>({kind:'advanced',taskId:task.id,runId:run.id,status:run.status,operation:task.spec.kind})))??[]),
      ];
      const offset=integer(args.offset,'offset',0)??0,limit=integer(args.limit,'limit',1)??50;
      return {count:rows.length,offset,nextOffset:offset+limit<rows.length?offset+limit:undefined,items:rows.slice(offset,offset+limit),unavailable};
    },
  },{
    name:'es_run_read',description:'Read an identified internal run, its input settings, execution status, scientific state, and retained-result identity.',
    inputSchema:objectSchema({runId:string},['runId']),
    async call(args){return ownedSummary(ownedRun(await readRuns(ctx),args.runId));},
  },{
    name:'es_run_wait',description:'Observe the exact internal ES run for up to waitMs, returning its actual scientific state and retained results when native execution and result adoption settle. A timeout, cancellation or disconnected observer never stops or resubmits the calculation. Reuse runId to continue waiting.',
    inputSchema:objectSchema({runId:string,waitMs:{type:'integer',minimum:0}},['runId','waitMs']),
    async call(args,call){
      const waitMs=integer(args.waitMs,'waitMs',0)!;
      const original=ownedRun(await readRuns(ctx),args.runId),started=performance.now();
      while(true){
        call?.signal.throwIfAborted();
        let current:OwnedRun;
        try{current=ownedRun(await readRuns(ctx),args.runId);}
        catch(cause){
          if((cause as {code?:string})?.code!=='TARGET_MISSING')throw cause;
          return {...ownedSummary(original),waitDisposition:'target-missing'};
        }
        if(!sameRunOwner(original,current))return {...ownedSummary(current),waitDisposition:'owner-changed'};
        if(runObservationSettled(current))return {...ownedSummary(current),waitDisposition:'observed-terminal'};
        const remaining=waitMs-(performance.now()-started);
        if(remaining<=0)return {...ownedSummary(current),waitDisposition:'observation-timeout'};
        await waitForRunUpdate(current,Math.min(remaining,500),call?.signal);
      }
    },
  },{
    name:'es_run_control',description:'Stop an identified live run or explicitly continue a supported advanced checkpoint or retryable run.',
    inputSchema:objectSchema({runId:string,action:{enum:['stop','continue','retry']},...presentationFields},['runId','action']),
    async call(args,call){
      const owners=await readRuns(ctx),owner=ownedRun(owners,args.runId);
      const action=oneOf(args.action,['stop','continue','retry'],'action');
      if(!action)throw toolError('INVALID_ARGUMENT','需要运行控制动作。');
      call?.signal.throwIfAborted();
      if(action==='stop'){
        const originalDisposition=settledStopDisposition(owner);
        if(originalDisposition)return {...ownedSummary(owner),stopDisposition:originalDisposition};
        try{
          if(owner.kind==='advanced')await owner.controller.stop(owner.task.id,owner.run.id);
          else if(owner.kind==='pes')await owner.controller.stop(owner.run.request.runIdentity.groupId,owner.run.request.id);
          else await owner.runtime.stop(owner.run.runId);
        }catch(cause){
          // The exact run may have ended during stop admission. Never forward
          // the request to a different session occupying the same model.
          const current=ownedRun(owners,args.runId),disposition=settledStopDisposition(current);
          if(disposition)return {...ownedSummary(current),stopDisposition:disposition};
          throw cause;
        }
        return {...ownedSummary(ownedRun(owners,args.runId)),stopDisposition:'requested'};
      }
      if(owner.kind==='advanced'){
        const runId=action==='retry'?owner.controller.retry(owner.task.id,owner.run.id):owner.controller.resume(owner.task.id,owner.run.id);
        const continued=ownedRun(owners,runId);
        if(continued.kind!=='advanced')throw toolError('CONFLICT','续算的运行身份不匹配。');
        return presentScienceRun(ctx,{...runSummary(continued.task,continued.run,continued.controller),continuedFromRunId:owner.run.id},args,call);
      }
      throw toolError('UNAVAILABLE','该运行没有此续算入口。请按其所属计算工具提交新运行。');
    },
  },{
    name:'es_run_diagnostics',description:'Read native diagnostics, actual resource reports and adoption errors still owned by an internal ES run.',
    inputSchema:objectSchema({runId:string,offset:{type:'integer',minimum:0},limit:positiveInteger},['runId']),
    async call(args){
      const owner=ownedRun(await readRuns(ctx),args.runId),summary=ownedSummary(owner);
      if(owner.kind==='model')return summary;
      if(owner.kind==='pes')return {...summary,provenance:owner.run.result?.provenance,
        pathRecords:owner.controller.pathRecordDiagnostics(owner.run.request.runIdentity.groupId,owner.run.request.id)};
      const {run}=owner,offset=integer(args.offset,'offset',0)??0,limit=integer(args.limit,'limit',1)??50;
      return {...summary,offset,count:run.results.length,items:run.results.slice(offset,offset+limit).map(result=>{
        const {maxSteps:_geometrySteps,...electronicMetadata}=result.metadata??{};
        return {candidateId:result.candidateId,stageId:result.stageId,status:result.status,input:result.input.ref,originalInput:result.originalInput?.ref,
          sessionId:result.sessionId,frameId:result.frameId,reusedFromRunId:result.reusedFromRunId,
          diagnosticDirectory:result.diagnosticDirectory,error:result.error,electronic:result.electronic,
          metadata:owner.task.spec.kind==='singlepoint'&&result.metadata?electronicMetadata:result.metadata,
          sharedOptimization:result.sharedOptimization,resourceRequests:run.resourceRequests?.filter(row=>row.candidateId===result.candidateId&&row.stageId===result.stageId)};
      }),samplingExecutions:run.mixedSampling?.executions?.map(({frameIds,candidateFrameIds,...execution})=>({...execution,
        frameCount:frameIds?.length,candidateFrameCount:candidateFrameIds?.length})),optionalDiagnostics:run.mixedSampling?undefined:run.sampling?.optionalDiagnostics};
    },
  },{
    name:'es_run_frame_read',description:'Read provenance and energy for a real retained frame. Use geometry to include coordinates. For retained OPT or conformer runs, pass collectionRef as frames_select targetRef to get immutable frameRefs for input, crop, export or display. listRecords describes PES path records, not OPT trajectory frames.',
    inputSchema:objectSchema({runId:string,frameId:string,recordId:string,seriesId:string,geometry:boolean,listRecords:boolean,
      offset:{type:'integer',minimum:0},limit:positiveInteger},['runId']),
    async call(args,call){
      const owner=ownedRun(await readRuns(ctx),args.runId),geometry=flag(args.geometry,'geometry')===true;
      const offset=integer(args.offset,'offset',0)??0,limit=integer(args.limit,'limit',1)??50;
      const frameId=args.frameId===undefined?undefined:textValue(args.frameId,'frameId');
      if(owner.kind==='model'){
        if(geometry)throw toolError('UNAVAILABLE','该实时会话只保留最后读到的帧凭据。用当前模型或实际结果帧入口读取几何。');
        return {runId:owner.run.runId,source:owner.run.source,frame:owner.run.frame};
      }
      if(owner.kind==='advanced'){
        const frames=owner.run.frames;
        const collection=!['queued','running','stopping'].includes(owner.run.status)&&
          (owner.task.mixedSampling||['sampling','conformer-search','docking'].includes(owner.task.spec.kind))
          ?{collectionRef:conformerRunCollectionRef(owner.task.id,owner.run.id),collectionId:conformerRunCollectionId(owner.run.id)}:{};
        const runId=owner.run.id;
        const frameSelection=collection.collectionRef?{targetRef:collection.collectionRef,...(frameId?{frameIds:[frameId]}:{})}:undefined;
        if(frameId){
          const frame=frames.find(row=>row.id===frameId);
          if(!frame)throw toolError('TARGET_MISSING','当前运行没有此帧。',
            {runId,frameId,recovery:{tool:'es_run_frame_read',arguments:{runId}}});
          return {...frameSummary(frame,geometry),...collection,frameSelection};
        }
        return {runId,...collection,frameSelection,count:frames.length,range:'all-retained-run-frames',
          offset,nextOffset:offset+limit<frames.length?offset+limit:undefined,items:frames.slice(offset,offset+limit).map(frame=>frameSummary(frame,geometry))};
      }
      const {controller,run,targetRef}=owner,{groupId,runId}=run.request.runIdentity;
      const collection=retainedOptimizationCollection(run);
      let recordId=args.recordId===undefined?undefined:textValue(args.recordId,'recordId');
      const records=pesPathRecords(run);
      if(flag(args.listRecords,'listRecords'))return {groupId,runId,...collection,count:records.length,offset,
        nextOffset:offset+limit<records.length?offset+limit:undefined,
        items:records.slice(offset,offset+limit).map(record=>{
          const {frames,connections,...metadata}=record;
          return {...metadata,frameCount:frames.length,frameSelection:pesRecordSelection(targetRef,record),
            readFrames:{runId,recordId:record.id}};
        })};
      const seriesId=args.seriesId===undefined?undefined:textValue(args.seriesId,'seriesId');
      const frameList={tool:'es_run_frame_read',arguments:{runId,listRecords:true}};
      const matchesFrame=(frame:{id:string;seriesId:string})=>frame.id===frameId&&(!seriesId||frame.seriesId===seriesId);
      const baseFrames=run.result?.frames??run.acceptedFrames??[];
      if(!recordId&&frameId&&!baseFrames.some(matchesFrame)){
        const matching=records.filter(record=>record.frames.some(matchesFrame));
        if(matching.length===1)recordId=matching[0].id;
        if(matching.length>1)throw toolError('PES_RECORD_REQUIRED','此原生帧 ID 出现在多条路径记录中，请指定 recordId。',
          {runId,frameId,seriesId,matchingRecordCount:matching.length,
            records:matching.slice(0,10).map(record=>({recordId:record.id,phase:record.phase,step:record.step,kind:record.kind,
              readFrame:{runId,recordId:record.id,frameId,seriesId},frameSelection:pesRecordSelection(targetRef,record)})),recovery:frameList});
      }
      const selected=recordId?records.find(row=>row.id===recordId):undefined;
      if(recordId&&!selected)throw toolError('TARGET_MISSING','当前运行没有此路径记录。',{runId,recordId,recovery:frameList});
      const frames=selected?.frames??baseFrames;
      const selectionTarget=selected?pesRecordSelection(targetRef,selected):collection?.collectionRef?{targetRef:collection.collectionRef}:undefined;
      const frameSelection=selectionTarget?{...selectionTarget,...(frameId?{frameIds:[frameId]}:{})}:undefined;
      const origin=pesSourceEvidence(run.source);
      if(!frameId){
        if(geometry)throw toolError('INVALID_ARGUMENT','读取 PES 坐标时请指定实际 frameId。',
          {runId,recordId,recovery:{tool:'es_run_frame_read',arguments:{runId,recordId}}});
        return {groupId,runId,...collection,recordId,frameSelection,...origin,count:frames.length,offset,
          nextOffset:offset+limit<frames.length?offset+limit:undefined,items:frames.slice(offset,offset+limit).map(frame=>
          Array.isArray(frame.positions)?pesFrameEvidence(frame as PesFrame):{...frame,coordinateUnit:'angstrom',energyUnit:'hartree'})};
      }
      const matches=frames.filter(matchesFrame);
      if(matches.length!==1)throw toolError(matches.length?'PES_SERIES_REQUIRED':'TARGET_MISSING',
        matches.length?'此原生帧 ID 出现在多个序列中，请指定 seriesId。':'当前集合没有此原生帧。',
        {runId,recordId,frameId,seriesId,matchingSeries:matches.map(frame=>frame.seriesId),
          recovery:selected||!records.length?{tool:'es_run_frame_read',arguments:{runId,recordId}}:frameList});
      const frame=await controller.readFrame(groupId,runId,matches[0].seriesId,frameId,call?.signal,recordId);
      return {groupId,runId,...collection,recordId,frameSelection,...origin,frame:pesFrameEvidence(frame),...(geometry?{positions:frame.positions}:{}),
        atomIds:run.request.structure.atoms.map(atom=>atom.id)};
    },
  }];
}
