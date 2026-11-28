import type {BondOrderObservation,ChemistryPort,DocumentStamp,ModelDocument,ModelStore} from '../../modeling/contracts';
import type {Structure} from '../../core/types';
import {builderCoordinateValue} from '../../core/builder-geometry';
import {isPeriodic,perceivePeriodicConnections,requireConfirmedPeriodicity} from '../../core/periodic';
import {supportsXtbAlpb,usesXtbSccIterations} from '../../core/xtb-capabilities';
import type {XtbBondOrders} from '../../modeling/xtb/contracts';
import {periodicBondOrderConnections,validateBondOrderEvidence,validateOptimizationBondOrderObservation} from '../../modeling/bond-orders';
import {DEFAULT_EMPIRICAL_BOND_PARAMETERS,validateEmpiricalBondParameters,type EmpiricalBondPerceptionParameters} from '../../core/bond-perception-parameters';
import type {PesController} from '../../modeling/pes/controller';
import {PES_CALC_PROFILE,PES_SCHEMA,isPesNetMethod,type PesFrame,type PesEvent,type PesGeometry,type PesResult,type PesRun,type PesRunStatus,type PesOptimizationInput,type PesOptimizationTiming,type PesRequest} from '../../modeling/pes/contracts';
import {lastOrdinaryOptimizationFrame} from '../../modeling/pes/frames';
import {ordinaryOptimizationPreparation,projectOrdinaryOptimizationStructure} from '../../modeling/pes/ordinary-optimization-geometry';
import {desktopBridge} from '../../modeling/platform/desktop';
import {createPesFfModel} from '../../modeling/pes/ff-model';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';
import {effectiveModelCoordinates} from '../../modeling/constraints';
import {getMovableAtomIds} from '../../core/modeling/graph';
import {createModelStore} from '../../core/modeling/model-store';
import {XtbController} from '../../modeling/xtb/controller';
import {availableOrdinaryOptimizer,ORDINARY_OPTIMIZATION_DEFAULT_MAX_STEPS,resolveOrdinaryOptimizer,selectWorkspaceOptimizationMethod,workspaceOptimizationKind,workspaceOptimizationMethodAvailable,workspaceXtbSettings,type WorkspaceOptimizationPreferences} from './tool-session';
import {ordinaryRunSettingsValid,validConvergence,xtbPanelSubmission,type XtbPanelOptions} from './XtbOptimizationPanel';
import {electronicStateParameterError} from '../../core/elements';
import type {ScienceOptOptions} from '../mcp/science-runtime';
import {toolError} from '../mcp/types';
import {validXtbResourceOverride} from '../../modeling/resource-preferences';

/** Explicit method selection uses the same preference update as the manual panel.
 * Other arguments describe only this run and leave the applied panel settings intact. */
export function prepareOrdinaryOptimization(preferences:WorkspaceOptimizationPreferences,structure:Structure,options:ScienceOptOptions) {
  const periodic=isPeriodic(structure);
  let sharedMethodPreferences:WorkspaceOptimizationPreferences|undefined;
  if(options.method!==undefined){
    if(!workspaceOptimizationMethodAvailable(options.method,periodic))throw Error('当前体系与运行环境未接入所选优化方法。');
    sharedMethodPreferences=selectWorkspaceOptimizationMethod(preferences,periodic,options.method);
    preferences=sharedMethodPreferences;
  }
  if(preferences.calculationLevel&&!workspaceOptimizationMethodAvailable(preferences.calculationLevel.method,periodic))
    throw Error('本工程的计算级别暂不支持当前体系的普通优化，请修改工程计算级别。');
  if(options.scope!==undefined)preferences={...preferences,scope:options.scope};
  const {optimizer,convergencePreset,convergenceLimits,maxSteps,rebuildBonds}=options;
  const overrides={...(optimizer===undefined?{}:{optimizer}),...(convergencePreset===undefined?{}:{convergencePreset}),
    ...(convergenceLimits===undefined?{}:{convergenceLimits}),...(maxSteps===undefined?{}:{maxSteps}),...(rebuildBonds===undefined?{}:{rebuildBonds})};
  if(workspaceOptimizationKind(preferences,periodic)==='net')throw Error('此版本提供 xTB 计算，请先选择可用的预优化方法。');
  const current=workspaceXtbSettings(preferences,periodic);
  const method=current.method;
  const xtbSingleTaskThreads=options.resourceOverrides?.xtbSingleTaskThreads;
  if(!validXtbResourceOverride(xtbSingleTaskThreads))
    throw toolError('INVALID_ARGUMENT','xTB 单任务线程数须为正整数。');
  if(convergenceLimits&&(convergencePreset??current.convergencePreset??'loose')!=='custom')throw Error('自定义收敛限度需配合自定义预设。');
  if(options.maxSccIterations!==undefined&&!usesXtbSccIterations(method))throw Error('所选优化方法不使用 SCC 迭代上限。');
  if(optimizer&&!availableOrdinaryOptimizer(method,periodic,optimizer))throw Error('所选优化器不适用于本次优化方法。');
  if(!ordinaryRunSettingsValid(method,{...current,...overrides,...(options.maxSccIterations===undefined?{}:{maxSccIterations:options.maxSccIterations})}))
    throw Error('本次优化设置包含无效的步数或收敛条件。');
  const solvation=options.solvation===undefined?current.solvation:options.solvation??undefined;
  if(solvation&&(solvation.model!=='alpb'||!supportsXtbAlpb(method,solvation.solvent,periodic)))throw Error('所选优化方法或周期条件不支持该溶剂。');
  const {charge,multiplicity}=options.electronic??structure;
  const xtbOptions=xtbPanelSubmission({...current,...overrides,charge:charge??NaN,multiplicity:multiplicity??NaN,
    ...(xtbSingleTaskThreads===undefined?{}:{resourceOverrides:{xtbSingleTaskThreads}}),
    solvation:solvation?{model:'alpb',solvent:solvation.solvent}:undefined,maxSccIterations:options.maxSccIterations??current.maxSccIterations},periodic);
  if(!xtbOptions)throw Error('请先核对当前模型的电荷、多重度和优化参数。');
  return {preferences,sharedMethodPreferences,method,xtbOptions};
}

export function ordinaryOptimizationInput(document:ModelDocument,preferences:WorkspaceOptimizationPreferences,xtbOptions?:XtbPanelOptions,
  empiricalBondParameters?:EmpiricalBondPerceptionParameters):PesOptimizationInput {
  const {structure}=document.draft;
  const periodic=isPeriodic(structure);
  if(preferences.calculationLevel&&!workspaceOptimizationMethodAvailable(preferences.calculationLevel.method,periodic))
    throw Error('本工程的计算级别暂不支持当前体系的普通优化，请修改工程计算级别。');
  if(workspaceOptimizationKind(preferences,periodic)==='net')throw Error('此版本提供 xTB 计算，请重新选择优化方法。');
  const settings=xtbOptions;
  if(!settings)throw Error('当前 xTB 优化设置尚未确认。');
  if(structure.periodicSource?.completeness==='partial')throw Error('周期矢量不完整，不能运行优化。');
  if(!validConvergence(settings))throw Error('请填写有效的自定义收敛限度。');
  const {charge,multiplicity}=settings;
  const method=settings.method;
  if(!workspaceOptimizationMethodAvailable(method,periodic))throw Error('当前运行环境尚未接入所选优化方法。');
  const confirmedMultiplicity=method==='gfnff'&&!Number.isSafeInteger(multiplicity)?1:multiplicity;
  const electronicError=electronicStateParameterError(charge,confirmedMultiplicity);
  if(electronicError)throw Error(electronicError);
  const selected=new Set(document.selection.atomIds);
  const {scope}=preferences;
  const movable=new Set(getMovableAtomIds(document,'all').filter(id=>scope==='all'||(scope==='selection'?selected.has(id):!selected.has(id))));
  if(!movable.size)throw Error('本次范围没有可动原子。');
  const solvation=xtbOptions?.solvation;
  if(solvation&&solvation.model!=='alpb')throw Error('共用优化器使用 ALPB。请选择 ALPB 溶剂或气相。');
  const rebuildBonds=settings.rebuildBonds===true;
  const algorithm=resolveOrdinaryOptimizer(method,periodic,settings.optimizer);
  if(periodic){
    if(!requireConfirmedPeriodicity(structure).pbc.every(Boolean))throw Error('固定晶胞优化需要完整的 XYZ 周期。');
    if(!periodicPesOperationAvailable(method,'opt',algorithm))throw Error('当前方法或算法暂不可用于固定晶胞优化。');
  }
  const {sharedConstraints,internalCoordinates}=document;
  const freezes=effectiveModelCoordinates({
    internalCoordinates:internalCoordinates?.filter(row=>row.action==='freeze'),
    sharedConstraints:sharedConstraints?{...sharedConstraints,coordinates:sharedConstraints.coordinates.filter(row=>row.action==='freeze')}:undefined,
  });
  return { method,algorithm,charge,multiplicity:confirmedMultiplicity,
    ...(settings.resourceOverrides?{resourceOverrides:settings.resourceOverrides}:{}),
    ...(solvation?.model==='alpb'?{solvation:{model:'alpb',solvent:solvation.solvent}}:{}),
    frozenAtomIds:structure.atoms.flatMap(atom=>movable.has(atom.id!)?[]:[atom.id!]),
    coordinates:freezes.map((row,index)=>({id:row.id??`constraint-${index}`,type:row.type,atomIds:row.atomIds,
      value:row.value??builderCoordinateValue(structure,row.type,row.atomIds,row.images),...(row.images?{images:row.images}:{})})),
    parameters:{maxSteps:settings.maxSteps??ORDINARY_OPTIMIZATION_DEFAULT_MAX_STEPS,maxStepAngstrom:0.1,convergencePreset:settings.convergencePreset??'loose',
      ...(settings.convergencePreset==='custom'?settings.convergenceLimits:{}),
      ...(usesXtbSccIterations(method)?{maxSccIterations:settings.maxSccIterations??250}:{}),rebuildBonds,
      ...(rebuildBonds&&empiricalBondParameters?{empiricalBondParameters:validateEmpiricalBondParameters(empiricalBondParameters)}:{})},
  };
}

export function standaloneOptimizationRequest(document:ModelDocument,input:PesOptimizationInput,runId:string):PesRequest {
  if(isPesNetMethod(input.method))throw Error('此版本提供 xTB 优化，请重新选择计算级别。');
  const structure=structuredClone(document.draft.structure);
  const ffModel=input.method==='gfnff'?createPesFfModel(runId,structure,input.charge,input.multiplicity,input.solvation):undefined;
  return {schema:PES_SCHEMA,id:runId,operation:'opt',runIdentity:{groupId:`model-${runId}`,taskId:runId,runId},sourceDocumentId:document.id,
    method:input.method,algorithm:input.algorithm,structure,charge:input.charge,uhf:input.multiplicity-1,
    ...(input.resourceOverrides?{resourceOverrides:structuredClone(input.resourceOverrides)}:{}),
    ...(ffModel?{ffModel}:{}),
    constraints:{frozenAtomIds:input.frozenAtomIds,coordinates:input.coordinates??[]},coordinates:[],
    ...(input.solvation?{solvation:input.solvation}:{}),parameters:{...input.parameters,calcProfile:PES_CALC_PROFILE,policyVersion:'v212',...(input.device?{device:input.device}:{})},
  };
}

export function observeOrdinarySpaceTiming(request:PesRequest,spaceKeydownAtMs:number|undefined):((event:PesEvent)=>void)|undefined {
  if(spaceKeydownAtMs===undefined)return;
  const {runIdentity,sourceDocumentId:documentId,method}=request;
  const detail={runIdentity,documentId,method,spaceKeydownAtMs};
  try{performance.mark('sciyue-space-keydown',{startTime:spaceKeydownAtMs-performance.timeOrigin,detail});}
  catch{return;}
  let recorded=false;
  return event=>{
    if(recorded||event.event!=='evaluation-started'||event.schema!==PES_SCHEMA||!Number.isFinite(event.physicalEvaluationStartedAtMs)||
      event.runIdentity.runId!==runIdentity.runId||event.runIdentity.taskId!==runIdentity.taskId||event.runIdentity.groupId!==runIdentity.groupId)return;
    recorded=true;
    const {physicalEvaluationStartedAtMs,backend,clockSource}=event;
    try{performance.mark('sciyue-space-first-evaluation',{startTime:physicalEvaluationStartedAtMs-performance.timeOrigin,
      detail:{...detail,physicalEvaluationStartedAtMs,backend,clockSource,evaluationEventReceivedAtMs:performance.timeOrigin+performance.now(),
        keydownToEvaluationMs:physicalEvaluationStartedAtMs-spaceKeydownAtMs}});}
    catch{/* Observation cannot interrupt the real optimization. */}
  };
}

const OPTIMIZATION_PHASE_MARK = 'sciyue-ordinary-opt-phase';
export function ordinaryOptimizationStartupText(event: PesEvent, net: boolean): string | undefined {
  if (event.event === 'evaluation-started') return '正在求解首个能量和梯度…';
  if (event.event !== 'optimization-timing') return;
  const timing = event.timing;
  const labels: Partial<Record<PesOptimizationTiming['phase'], string>> = {
    'resource-resolution': '正在读取计算资源设置',
    'admission-wait': '正在等待计算资源',
    'runtime-resolution': net ? '正在准备 NET 运行环境' : '正在准备运行库',
    'workspace-preparation': '正在准备计算目录和输入',
    'worker-readiness': '正在准备优化器',
    'worker-dispatched': '正在启动优化器',
    'worker-context-ready': '优化器已就绪，正在准备首个能量和梯度',
    'net-dispatched': '正在连接 NET 求值进程',
    'net-lane-entered': '正在检查或载入 NET 模型权重',
    'net-physical-started': '正在求解首个能量和梯度',
    'initial-frame': '初始构型已算出，正在寻找第 1 个接受步',
  };
  if ('evaluation' in timing && timing.evaluation !== 1) return;
  const label = labels[timing.phase];
  return label ? `${label} · ${Math.max(0, timing.hostElapsedMs / 1000).toFixed(1)} 秒` : undefined;
}
type OptimizationTimingOwner = Pick<PesRequest, 'runIdentity' | 'sourceDocumentId' | 'method'>;
type RendererOptimizationTiming =
  | { phase: 'request-prepared' }
  | { phase: 'first-physical-evaluation'; physicalEvaluationStartedAtMs: number; backend: string }
  | { phase: 'initial-preview-committed' | 'first-step-preview-committed' | 'geometry-adopted'; step: number }
  | { phase: 'bond-rebuild-started' | 'bond-rebuild-finished'; step: number }
  | { phase: 'terminal-received' | 'pes-geometry-settled'; status: string };

function markOrdinaryOptimizationPhase(request:OptimizationTimingOwner,timing:PesOptimizationTiming|RendererOptimizationTiming,spaceKeydownAtMs?:number) {
  const {runIdentity,sourceDocumentId:documentId,method}=request;
  try{performance.mark(OPTIMIZATION_PHASE_MARK,{detail:{...timing,runIdentity,documentId,method,spaceKeydownAtMs}});}
  catch{/* Observation cannot interrupt the real optimization. */}
}

export function observeOrdinaryOptimizationTiming(request:PesRequest,spaceKeydownAtMs?:number) {
  const observeSpace=observeOrdinarySpaceTiming(request,spaceKeydownAtMs);
  const {runIdentity}=request;
  let lastSeq=-1;
  const mark=(timing:PesOptimizationTiming|RendererOptimizationTiming)=>markOrdinaryOptimizationPhase(request,timing,spaceKeydownAtMs);
  mark({phase:'request-prepared'});
  return {mark,observe(event:PesEvent){
    if(event.schema!==PES_SCHEMA||event.runIdentity.runId!==runIdentity.runId||event.runIdentity.taskId!==runIdentity.taskId||
      event.runIdentity.groupId!==runIdentity.groupId||!Number.isSafeInteger(event.seq)||event.seq<=lastSeq)return;
    lastSeq=event.seq;
    observeSpace?.(event);
    if(event.event==='optimization-timing')mark(event.timing);
    if(event.event==='evaluation-started')mark({phase:'first-physical-evaluation',physicalEvaluationStartedAtMs:event.physicalEvaluationStartedAtMs,backend:event.backend});
    if(event.event==='terminal'&&event.workerSettled===true)mark({phase:'terminal-received',status:event.status});
  }};
}

type BondRebuildRequest = Pick<PesRequest,'method'|'parameters'|'constraints'> & Partial<Pick<PesRequest,'charge'|'uhf'>> & Partial<OptimizationTimingOwner>;
interface OrdinaryOptimizationBonds {structure:Structure;bondOrderObservation?:BondOrderObservation;warning?:string}

export function ordinaryOptimizationCanRebuild(status:PesRunStatus,result:PesResult|undefined,request:Pick<PesRequest,'method'|'parameters'>):boolean {
  if(status!=='completed'||!result||request.parameters.rebuildBonds!==true)return false;
  if(['completed','converged'].includes(result.status))return request.method==='gfn2'||result.frames.at(-1)?.converged!==false;
  return request.method==='gfn2'&&['not-converged','unconverged'].includes(result.status);
}

export async function rebuildOrdinaryOptimizationBonds(
  structure:Structure,frame:PesFrame,request:BondRebuildRequest,stamp:DocumentStamp,port:ChemistryPort,signal?:AbortSignal,
):Promise<Structure>{
  return (await prepareOrdinaryOptimizationBonds(structure,frame,request,stamp,port,signal)).structure;
}

export async function prepareOrdinaryOptimizationBonds(
  structure:Structure,frame:PesFrame,request:BondRebuildRequest,stamp:DocumentStamp,port:ChemistryPort,signal?:AbortSignal,result?:PesResult,
):Promise<OrdinaryOptimizationBonds>{
  if(request.parameters.rebuildBonds!==true)return {structure};
  signal?.throwIfAborted();
  const owner = request.runIdentity && request.sourceDocumentId && {runIdentity:request.runIdentity,sourceDocumentId:request.sourceDocumentId,method:request.method};
  if(owner)markOrdinaryOptimizationPhase(owner,{phase:'bond-rebuild-started',step:frame.step});
  try{
    const parameters=validateEmpiricalBondParameters(
      (request.parameters.empiricalBondParameters as EmpiricalBondPerceptionParameters|undefined)??DEFAULT_EMPIRICAL_BOND_PARAMETERS);
    let observation:BondOrderObservation|undefined, warning:string|undefined;
    if(request.method==='gfn2'){
      try{
        const recorded=result?.finalObservation as {id?:string;bondOrderObservation?:BondOrderObservation}|undefined;
        if(recorded?.id===frame.id&&recorded.bondOrderObservation){
          validateOptimizationBondOrderObservation(recorded.bondOrderObservation,structure);
          observation=recorded.bondOrderObservation;
        }else if(isPeriodic(structure)&&owner){
          observation=await periodicOptimizationBondOrders(structure,request,port,signal);
        }else if(!isPeriodic(structure)&&result){
          observation=nativeOptimizationBondOrders(structure,frame,request,result);
        }
      }catch(error){
        signal?.throwIfAborted();
        warning=`MBO 未取得：${error instanceof Error?error.message:String(error)}`;
      }
    }
    try{
      const rebuilt=await perceiveOptimizationBonds(structure,request,stamp,port,parameters,observation??legacyFrameBondOrders(structure,frame,request),signal);
      return {structure:rebuilt,bondOrderObservation:observation,warning};
    }catch(error){
      signal?.throwIfAborted();
      return {structure,bondOrderObservation:observation,warning:[warning,`成键未更新：${error instanceof Error?error.message:String(error)}`].filter(Boolean).join('；')};
    }
  }
  finally{if(owner)markOrdinaryOptimizationPhase(owner,{phase:'bond-rebuild-finished',step:frame.step});}
}

function legacyFrameBondOrders(structure:Structure,frame:PesFrame,request:BondRebuildRequest):XtbBondOrders|undefined {
  if(request.method!=='gfn2'||isPeriodic(structure))return;
  const matrix=frame.bondOrders,atoms=structure.atoms;
  if(!Array.isArray(matrix)||matrix.length!==atoms.length||!matrix.every(row=>Array.isArray(row)&&row.length===atoms.length&&row.every(Number.isFinite)))return;
  const entries:XtbBondOrders['entries']=[];
  for(let a=0;a<atoms.length;a++)for(let b=a+1;b<atoms.length;b++){
    const value=matrix[a][b];
    if(value>=.1)entries.push({atomIds:[atoms[a].id!,atoms[b].id!],value});
  }
  const evidence={definition:'mayer-ao',sourceField:'wbo',threshold:.1,entries} as const;
  validateBondOrderEvidence(evidence,structure);
  return evidence;
}

function nativeOptimizationBondOrders(structure:Structure,frame:PesFrame,request:BondRebuildRequest,result:PesResult):BondOrderObservation|undefined {
  const owner=request.runIdentity;
  if(!owner||request.charge===undefined||request.uhf===undefined)return;
  const native=result.provenance.finalBondOrders as (XtbBondOrders & {frameId?:string;version?:string})|undefined;
  const optimizer=result.provenance.optimizer as {bondOrderWarning?:{message?:string}}|undefined;
  if(!native){
    if(legacyFrameBondOrders(structure,frame,request))return;
    throw Error(optimizer?.bondOrderWarning?.message??'本次 GFN2-xTB 末帧没有可用键级。');
  }
  if(native.frameId!==frame.id||native.sourceField!=='wbo'||typeof native.version!=='string'||!native.version)throw Error('原生键级来源与本次优化末帧不匹配。');
  const {definition,sourceField,threshold,entries,version}=native;
  const observation={definition,sourceField,threshold,entries,version,runId:owner.runId,engine:'xtb',method:'gfn2',calculation:'optimize',charge:request.charge,uhf:request.uhf} as const;
  validateOptimizationBondOrderObservation(observation,structure);
  return observation;
}

async function periodicOptimizationBondOrders(structure:Structure,request:BondRebuildRequest,port:ChemistryPort,signal?:AbortSignal):Promise<BondOrderObservation> {
  const bridge=desktopBridge();
  if(!bridge||!(await bridge.info()).periodicGfn2BondOrders)throw Error('当前运行环境尚未提供周期 GFN2 键级。');
  signal?.throwIfAborted();
  const charge=structure.charge,multiplicity=structure.multiplicity;
  if(charge===null||multiplicity===null)throw Error('末帧电子态未确认。');
  // The normal native singlepoint validates the cell, exact coordinates and
  // provider metadata. Its scratch Store cannot publish to the workbench.
  const scratch=createModelStore(structure);
  const controller=new XtbController({store:scratch,bridge,chemistry:port,confirmConstraints:()=>true,assertCurrent:()=>signal?.throwIfAborted()});
  const cancel=()=>{void controller.stop().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    const maxSccIterations=request.parameters.maxSccIterations as number|undefined;
    await controller.run({method:'gfn2',charge,multiplicity,maxSccIterations,rebuildBonds:true},'singlepoint');
    signal?.throwIfAborted();
    const observation=scratch.getSnapshot().bondOrderObservation;
    if(!observation)throw Error(controller.getSnapshot().error||'周期 GFN2 单点没有返回原子对键级。');
    return observation;
  }finally{
    signal?.removeEventListener('abort',cancel);
    controller.disconnect();
  }
}

async function perceiveOptimizationBonds(
  structure:Structure,request:Pick<PesRequest,'constraints'>,stamp:DocumentStamp,port:ChemistryPort,
  parameters:EmpiricalBondPerceptionParameters,evidence?:XtbBondOrders,signal?:AbortSignal,
):Promise<Structure>{
  if(isPeriodic(structure)){
    const {bonds,issues}=evidence?periodicBondOrderConnections(structure,evidence,parameters):perceivePeriodicConnections(structure,{parameters,preserveExisting:false});
    signal?.throwIfAborted();
    return {...structure,bonds,bondSource:'inferred',bondPerceptionIssues:issues.length?issues:undefined,molfile:undefined};
  }
  const fixed=new Set(request.constraints.frozenAtomIds);
  const movableAtomIds=structure.atoms.flatMap(atom=>atom.id&&!fixed.has(atom.id)?[atom.id]:[]);
  const bondOrderEvidence:XtbBondOrders|undefined=evidence?.sourceField==='wbo'
    ? {definition:evidence.definition,sourceField:evidence.sourceField,threshold:evidence.threshold,entries:evidence.entries}:undefined;
  const job=port.start({stamp,operation:'perceive-bonds',structure,movableAtomIds,aggression:'standard',bondPerceptionPolicy:'composite-v1',
    ...(bondOrderEvidence?{bondOrderEvidence}:{empiricalBondParameters:parameters})});
  const cancel=()=>job.cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(signal?.aborted)cancel();
    const result=await job.promise;
    signal?.throwIfAborted();
    if(result.operation!=='perceive-bonds'||result.bondPerceptionPolicy!=='composite-v1'||JSON.stringify(result.stamp)!==JSON.stringify(stamp)
      ||JSON.stringify(result.structure.atoms)!==JSON.stringify(structure.atoms)||result.structure.charge!==structure.charge||result.structure.multiplicity!==structure.multiplicity
      ||!Array.isArray(result.structure.bonds)||result.bondPerceptionSummary?.method!==(bondOrderEvidence?'gfn2-assisted':'empirical'))throw Error('优化后成键结果与本次结构不匹配。');
    return {...structure,bonds:result.structure.bonds,bondSource:result.structure.bondSource,bondPerceptionIssues:result.structure.bondPerceptionIssues};
  }finally{signal?.removeEventListener('abort',cancel);}
}

export async function finalizeStandaloneOrdinaryOptimization(args:{event:Extract<PesEvent,{event:'terminal'}>;request:PesRequest;
  source:ModelDocument;store:ModelStore;preview?:PesFrame;signal:AbortSignal;releaseRuntime():void;chemistry():ChemistryPort;spaceKeydownAtMs?:number}) {
  return adoptOrdinaryOptimizationGeometry({...args,status:args.event.status,result:args.event.result,error:args.event.error});
}

/** Shared terminal adoption only. Retained PES runs keep their actual complete
 * trajectory in the controller; the original editable Store still gets one commit. */
export async function adoptOrdinaryOptimizationGeometry(args:{status:Extract<PesEvent,{event:'terminal'}>['status'];result?:import('../../modeling/pes/contracts').PesResult;
  error?:Extract<PesEvent,{event:'terminal'}>['error'];request:PesRequest;source:ModelDocument;store:ModelStore;preview?:PesFrame;
  signal:AbortSignal;releaseRuntime():void;chemistry():ChemistryPort;spaceKeydownAtMs?:number;retainFrames?:boolean;assertCurrent?():void}) {
  const {request,source,store,signal}=args;
  const final=lastOrdinaryOptimizationFrame(args.result?.frames??[],request.structure.atoms.length,args.preview);
  if(!final)return args.result;
  let result=args.result??{frames:[final],status:args.status==='failed'?'partial':args.status,provenance:{}};
  let structure=projectOrdinaryOptimizationStructure(request,final);
  let bondOrderObservation:BondOrderObservation|undefined;
  try{
    args.assertCurrent?.();
    const current=store.getSnapshot();
    if(current.id!==source.id||current.revision!==source.revision)throw Error('优化所属模型已变化，未覆盖现有结构。');
    if(ordinaryOptimizationCanRebuild(args.status,result,request)&&!signal.aborted){
      try{
        const prepared=await prepareOrdinaryOptimizationBonds(structure,final,request,store.stamp(),args.chemistry(),signal,result);
        structure=prepared.structure;
        bondOrderObservation=prepared.bondOrderObservation;
        if(prepared.warning)result={...result,provenance:{...result.provenance,bondPerceptionWarning:prepared.warning}};
      }catch(error){
        if(!signal.aborted)result={...result,provenance:{...result.provenance,bondPerceptionWarning:error instanceof Error?error.message:String(error)}};
      }
    }
    args.assertCurrent?.();
    args.releaseRuntime();
    store.execute({type:'apply-optimization-geometry',structure:{...structure,preparation:ordinaryOptimizationPreparation(args.status,result,final)},
      documentId:source.id,expectedRevision:source.revision,bondOrderObservation});
    markOrdinaryOptimizationPhase(request,{phase:'geometry-adopted',step:final.step},args.spaceKeydownAtMs);
  }catch(error){result={...result,provenance:{...result.provenance,geometryAdoptionError:error instanceof Error?error.message:String(error)}};}
  const {positions:_positions,...finalObservation}=final;
  return {...result,frames:args.retainFrames?result.frames:[final],...(bondOrderObservation?{finalObservation:{...finalObservation,bondOrderObservation}}:{})};
}

export function pesOrdinaryOptimizationInput(args:{source:PesGeometry;document:ModelDocument;preferences:WorkspaceOptimizationPreferences;
  xtbOptions?:XtbPanelOptions;empiricalBondParameters?:EmpiricalBondPerceptionParameters}) {
  const {source,document,preferences}=args;
  // A derived result carries its own electronic state. The pane can
  // still hold the draft of the editable parent.
  const options=source.source?.frameId&&args.xtbOptions
    ?{...args.xtbOptions,charge:source.structure.charge??NaN,multiplicity:source.structure.multiplicity??NaN}
    :args.xtbOptions;
  return ordinaryOptimizationInput(document,preferences,options,args.empiricalBondParameters);
}

/** Use the ordinary driver and wait for the owning PES page to settle. */
export async function runPesOrdinaryOptimization(args:Parameters<typeof pesOrdinaryOptimizationInput>[0]&{
  controller:PesController;groupId:string;nodeId:string;input?:PesOptimizationInput;spaceKeydownAtMs?:number;
  bindTarget?:(target:import('../../modeling/pes/contracts').PesNode)=>Pick<PesGeometry,'documentId'|'revision'>;
  retainTrajectory?:boolean;
  onRunStarted?:import('../mcp/science-runtime').ObservePesStart}) {
  const {controller,groupId,nodeId,source}=args;
  const input=args.input??pesOrdinaryOptimizationInput(args);
  const node=controller.startOrdinaryOptimization(groupId,nodeId,source,{...input,retainTrajectory:args.retainTrajectory},args.bindTarget);
  const runId=node.runIds.at(-1)!;
  const request=controller.getSnapshot().groups.find(row=>row.id===groupId)?.runs[runId]?.request;
  if(request)args.onRunStarted?.(request.runIdentity,request);
  const timing=request&&observeOrdinaryOptimizationTiming(request,args.spaceKeydownAtMs);
  const releaseTiming=timing&&desktopBridge()?.onPesEvent?.(timing.observe);
  return new Promise<PesRun|undefined>(resolve=>{
    const check=()=>{
      const owned=controller.getSnapshot().groups.find(row=>row.id===groupId)?.runs[runId];
      if(owned&&['starting','running','stopping'].includes(owned.status))return;
      release();
      // The controller can settle synchronously in the same IPC delivery as
      // its terminal listener. Leave this observer attached for that delivery.
      if(timing)queueMicrotask(()=>{
        if(owned)timing.mark({phase:'pes-geometry-settled',status:owned.status});
        releaseTiming?.();
      });
      resolve(owned);
    };
    const release=controller.subscribe(check);
    check();
  });
}
