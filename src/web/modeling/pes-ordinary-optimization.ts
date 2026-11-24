import type {ChemistryPort,DocumentStamp,ModelDocument,ModelStore} from '../../modeling/contracts';
import type {Structure} from '../../core/types';
import {builderCoordinateValue} from '../../core/builder-geometry';
import {isPeriodic,perceivePeriodicConnections,requireConfirmedPeriodicity} from '../../core/periodic';
import {isXtbMethod,supportsXtbAlpb,usesXtbSccIterations} from '../../core/xtb-capabilities';
import type {XtbBondOrders} from '../../modeling/xtb/contracts';
import {validateBondOrderEvidence} from '../../modeling/bond-orders';
import {DEFAULT_EMPIRICAL_BOND_PARAMETERS,validateEmpiricalBondParameters,type EmpiricalBondPerceptionParameters} from '../../core/bond-perception-parameters';
import type {PesController} from '../../modeling/pes/controller';
import {PES_CALC_PROFILE,PES_SCHEMA,isPesNetMethod,type PesFrame,type PesEvent,type PesGeometry,type PesRun,type PesOptimizationInput,type PesOptimizationTiming,type PesRequest} from '../../modeling/pes/contracts';
import {lastOrdinaryOptimizationFrame} from '../../modeling/pes/frames';
import {ordinaryOptimizationPreparation,projectOrdinaryOptimizationStructure} from '../../modeling/pes/ordinary-optimization-geometry';
import {desktopBridge} from '../../modeling/platform/desktop';
import {createPesFfModel} from '../../modeling/pes/ff-model';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';
import {effectiveModelCoordinates} from '../../modeling/constraints';
import {getMovableAtomIds} from '../../core/modeling/graph';
import {availableOrdinaryOptimizer,resolveOrdinaryOptimizer,selectWorkspaceOptimizationMethod,workspaceNetSettings,workspaceOptimizationKind,workspaceOptimizationMethodAvailable,workspaceXtbSettings,type WorkspaceOptimizationPreferences} from './tool-session';
import {ordinaryRunSettingsValid,validConvergence,xtbPanelSubmission,type XtbPanelOptions} from './XtbOptimizationPanel';
import {electronicStateParameterError} from '../../core/elements';
import type {ScienceOptOptions} from '../mcp/science-runtime';

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
  if(options.scope!==undefined)preferences={...preferences,scope:options.scope};
  const {optimizer,convergencePreset,convergenceLimits,maxSteps,rebuildBonds}=options;
  const overrides={...(optimizer===undefined?{}:{optimizer}),...(convergencePreset===undefined?{}:{convergencePreset}),
    ...(convergenceLimits===undefined?{}:{convergenceLimits}),...(maxSteps===undefined?{}:{maxSteps}),...(rebuildBonds===undefined?{}:{rebuildBonds})};
  if(workspaceOptimizationKind(preferences,periodic)==='net')throw Error('此版本提供 xTB 计算，请先选择可用的预优化方法。');
  const current=workspaceXtbSettings(preferences,periodic);
  const method=current.method;
  if(convergenceLimits&&(convergencePreset??current.convergencePreset??'loose')!=='custom')throw Error('自定义收敛限度需配合自定义预设。');
  if(options.maxSccIterations!==undefined&&!usesXtbSccIterations(method))throw Error('所选优化方法不使用 SCC 迭代上限。');
  if(optimizer&&!availableOrdinaryOptimizer(method,periodic,optimizer))throw Error('所选优化器不适用于本次优化方法。');
  if(!ordinaryRunSettingsValid(method,{...current,...overrides,...(options.maxSccIterations===undefined?{}:{maxSccIterations:options.maxSccIterations})}))
    throw Error('本次优化设置包含无效的步数或收敛条件。');
  const solvation=options.solvation===undefined?current.solvation:options.solvation??undefined;
  if(solvation&&(solvation.model!=='alpb'||!supportsXtbAlpb(method,solvation.solvent,periodic)))throw Error('所选优化方法或周期条件不支持该溶剂。');
  const {charge,multiplicity}=options.electronic??structure;
  const xtbOptions=xtbPanelSubmission({...current,...overrides,charge:charge??NaN,multiplicity:multiplicity??NaN,
    solvation:solvation?{model:'alpb',solvent:solvation.solvent}:undefined,maxSccIterations:options.maxSccIterations??current.maxSccIterations},periodic);
  if(!xtbOptions)throw Error('请先核对当前模型的电荷、多重度和优化参数。');
  return {preferences,sharedMethodPreferences,method,xtbOptions};
}

export function ordinaryOptimizationInput(document:ModelDocument,preferences:WorkspaceOptimizationPreferences,xtbOptions?:XtbPanelOptions,
  empiricalBondParameters?:EmpiricalBondPerceptionParameters):PesOptimizationInput {
  const {structure}=document.draft;
  const periodic=isPeriodic(structure);
  const net=workspaceOptimizationKind(preferences,periodic)==='net';
  const settings=net?workspaceNetSettings(preferences,periodic):xtbOptions;
  if(!settings)throw Error('当前 xTB 优化设置尚未确认。');
  if(structure.periodicSource?.completeness==='partial')throw Error('周期矢量不完整，不能运行优化。');
  if(!validConvergence(settings))throw Error('请填写有效的自定义收敛限度。');
  const charge=(net?structure.charge:xtbOptions?.charge)??Number.NaN;
  const multiplicity=(net?structure.multiplicity:xtbOptions?.multiplicity)??Number.NaN;
  const method=settings.method;
  if(!isPesNetMethod(method)&&!isXtbMethod(method)||!workspaceOptimizationMethodAvailable(method,periodic))throw Error('当前运行环境尚未接入所选优化方法。');
  const confirmedMultiplicity=method==='gfnff'&&!Number.isSafeInteger(multiplicity)?1:multiplicity;
  const electronicError=electronicStateParameterError(charge,confirmedMultiplicity);
  if(electronicError)throw Error(electronicError);
  const selected=new Set(document.selection.atomIds);
  const {scope}=preferences;
  const movable=new Set(getMovableAtomIds(document,'all').filter(id=>scope==='all'||(scope==='selection'?selected.has(id):!selected.has(id))));
  if(!movable.size)throw Error('本次范围没有可动原子。');
  const solvation=xtbOptions?.solvation;
  if(!net&&solvation&&solvation.model!=='alpb')throw Error('共用优化器使用 ALPB。请选择 ALPB 溶剂或气相。');
  const device='device' in settings?settings.device:undefined;
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
    ...(device?{device}:{}),...(!net&&solvation?.model==='alpb'?{solvation:{model:'alpb',solvent:solvation.solvent}}:{}),
    frozenAtomIds:structure.atoms.flatMap(atom=>movable.has(atom.id!)?[]:[atom.id!]),
    coordinates:freezes.map((row,index)=>({id:row.id??`constraint-${index}`,type:row.type,atomIds:row.atomIds,
      value:row.value??builderCoordinateValue(structure,row.type,row.atomIds,row.images),...(row.images?{images:row.images}:{})})),
    parameters:{maxSteps:settings.maxSteps??(periodic?1000:500),maxStepAngstrom:0.1,convergencePreset:settings.convergencePreset??'loose',
      ...(settings.convergencePreset==='custom'?settings.convergenceLimits:{}),
      ...(usesXtbSccIterations(method)?{maxSccIterations:xtbOptions?.maxSccIterations??250}:{}),...(!net||rebuildBonds?{rebuildBonds}:{}),
      ...(rebuildBonds&&empiricalBondParameters?{empiricalBondParameters:validateEmpiricalBondParameters(empiricalBondParameters)}:{})},
  };
}

export function standaloneOptimizationRequest(document:ModelDocument,input:PesOptimizationInput,runId:string):PesRequest {
  const structure=structuredClone(document.draft.structure);
  const ffModel=input.method==='gfnff'?createPesFfModel(runId,structure,input.charge,input.multiplicity,input.solvation):undefined;
  return {schema:PES_SCHEMA,id:runId,operation:'opt',runIdentity:{groupId:`model-${runId}`,taskId:runId,runId},sourceDocumentId:document.id,
    method:input.method,algorithm:input.algorithm,structure,charge:input.charge,uhf:input.multiplicity-1,
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

export async function rebuildOrdinaryOptimizationBonds(
  structure:Structure,frame:PesFrame,request:Pick<PesRequest,'method'|'parameters'|'constraints'>&Partial<OptimizationTimingOwner>,stamp:DocumentStamp,port:ChemistryPort,
  signal?:AbortSignal,
):Promise<Structure>{
  if(request.parameters.rebuildBonds!==true)return structure;
  signal?.throwIfAborted();
  const owner = request.runIdentity && request.sourceDocumentId && {runIdentity:request.runIdentity,sourceDocumentId:request.sourceDocumentId,method:request.method};
  if(owner)markOrdinaryOptimizationPhase(owner,{phase:'bond-rebuild-started',step:frame.step});
  try{return await perceiveOptimizationBonds(structure,frame,request,stamp,port,signal);}
  finally{if(owner)markOrdinaryOptimizationPhase(owner,{phase:'bond-rebuild-finished',step:frame.step});}
}

async function perceiveOptimizationBonds(
  structure:Structure,frame:PesFrame,request:Pick<PesRequest,'method'|'parameters'|'constraints'>,stamp:DocumentStamp,port:ChemistryPort,
  signal?:AbortSignal,
):Promise<Structure>{
  const parameters=validateEmpiricalBondParameters(
    (request.parameters.empiricalBondParameters as EmpiricalBondPerceptionParameters|undefined)??DEFAULT_EMPIRICAL_BOND_PARAMETERS);
  if(isPeriodic(structure)){
    const {bonds,issues}=perceivePeriodicConnections(structure,{parameters,preserveExisting:false});
    signal?.throwIfAborted();
    return {...structure,bonds,bondSource:'inferred',bondPerceptionIssues:issues.length?issues:undefined,molfile:undefined};
  }
  const matrix=frame.bondOrders,atoms=structure.atoms;
  let evidence:XtbBondOrders|undefined;
  if(request.method==='gfn2'&&Array.isArray(matrix)&&matrix.length===atoms.length&&matrix.every(row=>Array.isArray(row)&&row.length===atoms.length&&row.every(Number.isFinite))){
    const entries:XtbBondOrders['entries']=[];
    for(let a=0;a<atoms.length;a++)for(let b=a+1;b<atoms.length;b++){
      const value=matrix[a][b];
      if(value>=.1)entries.push({atomIds:[atoms[a].id!,atoms[b].id!],value});
    }
    evidence={definition:'mayer-ao',sourceField:'wbo',threshold:.1,entries};
    validateBondOrderEvidence(evidence,structure);
  }
  const fixed=new Set(request.constraints.frozenAtomIds);
  const movableAtomIds=structure.atoms.flatMap(atom=>atom.id&&!fixed.has(atom.id)?[atom.id]:[]);
  const job=port.start({stamp,operation:'perceive-bonds',structure,movableAtomIds,aggression:'standard',bondPerceptionPolicy:'composite-v1',
    ...(evidence?{bondOrderEvidence:evidence}:{empiricalBondParameters:parameters})});
  const cancel=()=>job.cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(signal?.aborted)cancel();
    const result=await job.promise;
    signal?.throwIfAborted();
    if(result.operation!=='perceive-bonds'||result.bondPerceptionPolicy!=='composite-v1'||JSON.stringify(result.stamp)!==JSON.stringify(stamp)
      ||JSON.stringify(result.structure.atoms)!==JSON.stringify(structure.atoms)||result.structure.charge!==structure.charge||result.structure.multiplicity!==structure.multiplicity
      ||!Array.isArray(result.structure.bonds)||result.bondPerceptionSummary?.method!==(evidence?'gfn2-assisted':'empirical'))throw Error('优化后成键结果与本次结构不匹配。');
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
  try{
    args.assertCurrent?.();
    const current=store.getSnapshot();
    if(current.id!==source.id||current.revision!==source.revision)throw Error('优化所属模型已变化，未覆盖现有结构。');
    if(args.status==='completed'&&!args.error&&['completed','converged'].includes(result.status)&&final.converged!==false&&
      request.parameters.rebuildBonds===true&&!signal.aborted){
      try{structure=await rebuildOrdinaryOptimizationBonds(structure,final,request,store.stamp(),args.chemistry(),signal);}
      catch(error){if(!signal.aborted)result={...result,provenance:{...result.provenance,bondPerceptionWarning:error instanceof Error?error.message:String(error)}};}
    }
    args.assertCurrent?.();
    args.releaseRuntime();
    store.execute({type:'apply-optimization-geometry',structure:{...structure,preparation:ordinaryOptimizationPreparation(args.status,result,final)},
      documentId:source.id,expectedRevision:source.revision});
    markOrdinaryOptimizationPhase(request,{phase:'geometry-adopted',step:final.step},args.spaceKeydownAtMs);
  }catch(error){result={...result,provenance:{...result.provenance,geometryAdoptionError:error instanceof Error?error.message:String(error)}};}
  return {...result,frames:args.retainFrames?result.frames:[final]};
}

/** Use the ordinary driver and wait for the owning PES page to settle. */
export async function runPesOrdinaryOptimization(args:{controller:PesController;groupId:string;nodeId:string;source:PesGeometry;
  document:ModelDocument;preferences:WorkspaceOptimizationPreferences;xtbOptions?:XtbPanelOptions;
  empiricalBondParameters?:EmpiricalBondPerceptionParameters;spaceKeydownAtMs?:number;
  retainTrajectory?:boolean;
  onRunStarted?:import('../mcp/science-runtime').ObservePesStart}) {
  const {controller,groupId,nodeId,source,document,preferences}=args;
  // A derived result carries its own electronic state. The preoptimization
  // pane can still hold the draft of the editable parent.
  const options=source.source?.frameId&&args.xtbOptions
    ?{...args.xtbOptions,charge:source.structure.charge??NaN,multiplicity:source.structure.multiplicity??NaN}
    :args.xtbOptions;
  const input=ordinaryOptimizationInput(document,preferences,options,args.empiricalBondParameters);
  const node=controller.startOrdinaryOptimization(groupId,nodeId,source,{...input,retainTrajectory:args.retainTrajectory});
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
