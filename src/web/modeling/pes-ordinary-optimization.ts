import type {ModelDocument,ModelStore} from '../../modeling/contracts';
import type {DocumentRuntimeOwner} from '../../modeling/application/document-runtime-owner';
import type {PesController} from '../../modeling/pes/controller';
import type {PesGeometry,PesFrame,PesRunIdentity} from '../../modeling/pes/contracts';
import {createPesXtbOptimizationObserver} from '../../modeling/pes/ordinary-optimization';
import {effectiveModelCoordinates} from '../../modeling/constraints';
import {getMovableAtomIds} from '../../core/modeling/graph';
import {createOptimizationCoordinator} from './optimization-coordinator';
import type {WorkspaceOptimizationPreferences} from './tool-session';
import type {XtbPanelOptions} from './XtbOptimizationPanel';
import {electronicStateParameterError} from '../../core/elements';
import {assertOrcaForcefieldTargets} from '../../modeling/application/orca-bridge';

/** Use the ordinary driver, adopting one successful final geometry into this page. */
export async function runPesOrdinaryOptimization(args:{controller:PesController;groupId:string;nodeId:string;source:PesGeometry;
  document:ModelDocument;store:ModelStore;runtime:DocumentRuntimeOwner;preferences:WorkspaceOptimizationPreferences;xtbOptions?:XtbPanelOptions;onNotice?:(text:string)=>void}) {
  const {controller,groupId,nodeId,source,document,store,runtime,preferences}=args;
  if(preferences.defaultKind==='xtb'){
    if(!args.xtbOptions)throw Error('当前xTB优化设置尚未确认。');
    const options={...args.xtbOptions,...(args.xtbOptions.method==='gfnff'&&source.ffModel?{ffModel:source.ffModel}:{})};
    await runtime.xtb.run(options,'optimize','rebuild',createPesXtbOptimizationObserver(controller,groupId,nodeId,source,()=>runtime.xtb.stop()),document);
    return;
  }
  const method=document.draft.structure.cell?'geometry':preferences.forcefield.method,range=preferences.forcefield.scope;
  const charge=document.draft.structure.charge,multiplicity=document.draft.structure.multiplicity;
  if(document.draft.structure.periodicSource?.completeness==='partial')throw Error('周期矢量不完整，不能运行整理。');
  if(method!=='geometry'){
    if(electronicStateParameterError(charge??Number.NaN,multiplicity??Number.NaN))throw Error('请先核对有效电荷和多重度，再运行力场优化。');
    assertOrcaForcefieldTargets(document.draft.structure,effectiveModelCoordinates(document));
  }
  let identity:PesRunIdentity|undefined,phase=0,lastFrameKey='',unsubscribe=()=>{};
  const frames:PesFrame[]=[],phases:Record<string,unknown>[]=[];
  const recordState=()=>{
    if(!identity)return;
    const state=runtime.dynamics.getSnapshot(),value=state.lastFrame;
    const pending=phases.at(-1);
    if(pending&&!pending.sessionId&&state.status==='starting'&&state.sessionId){pending.sessionId=state.sessionId;pending.request=runtime.dynamics.getRequestSnapshot();}
    if(state.sessionId&&state.mode)controller.recordOptimization(identity,{event:'progress',stage:state.mode,completed:value?.step});
    const key=value&&`${value.sessionId}:${value.seq}`;
    if(!value||key===lastFrameKey||!phases.some(row=>row.sessionId===value.sessionId))return;
    lastFrameKey=key!;
    const frame:PesFrame={id:key!,seriesId:`opt-${phase}`,phase:value.operation,step:value.step,status:value.event,
      positions:value.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),converged:value.converged,
      ...(value.energyEV===undefined?{}:{energyHartree:value.energyEV/27.211386245988}),
      nativeSessionId:value.sessionId,nativeFrameSequence:value.seq,geometryObjective:value.geometryObjective,hybridGeometry:value.hybridGeometry,
      engine:value.engine,engineVersion:value.engineVersion,aseVersion:value.aseVersion,forcefield:value.forcefield};
    frames.push(frame);controller.recordOptimization(identity,{event:'frame',frame});
  };
  const coordinator=createOptimizationCoordinator({
    capture(scope){
      runtime.dynamics.assertCanEditStructure();
      const selected=new Set(document.selection.atomIds);
      const movableAtomIds=getMovableAtomIds(document,'all').filter(id=>scope==='all'||(scope==='selection'?selected.has(id):!selected.has(id))),stamp=store.stamp(movableAtomIds),constraints=structuredClone(effectiveModelCoordinates(document));
      if(!movableAtomIds.length)throw Error('本次范围没有可动原子。');
      return{stamp,movableAtomIds,constraints,assertCurrent(){if(JSON.stringify(stamp)!==JSON.stringify(store.stamp(movableAtomIds)))throw Error('优化文档、坐标、可动范围或约束已变化。');}};
    },
    runtime:{getSnapshot:()=>runtime.dynamics.getSnapshot(),subscribe:listener=>runtime.dynamics.subscribe(listener),
      async start(mode,config){
        phase++;
        if(!identity){
          const movable=new Set(config.movableAtomIds);
          identity=controller.beginOptimization(groupId,nodeId,source,{method,algorithm:'workspace-forcefield',charge:charge??Number.NaN,multiplicity:multiplicity??Number.NaN,
            frozenAtomIds:source.structure.atoms.flatMap(atom=>movable.has(atom.id!)?[]:[atom.id!]),
            coordinates:effectiveModelCoordinates(document).map((row,index)=>({id:row.id??`constraint-${index}`,type:row.type,atomIds:row.atomIds,value:row.value!})),
            parameters:{preferences:structuredClone(preferences),phaseInputs:phases}},async()=>{await runtime.dynamics.stop();}).identity;
          unsubscribe=runtime.dynamics.subscribe(recordState);
        }
        const phaseRow:Record<string,unknown>={mode,config:structuredClone(config)};phases.push(phaseRow);
        await runtime.startOptimizationPhase(mode,config,document,{deferApplication:true});
        phaseRow.sessionId=runtime.dynamics.getSnapshot().sessionId;recordState();
        controller.recordOptimization(identity!,{event:'started'});
      },waitForTermination:id=>runtime.dynamics.waitForTermination(id)},
    notice:text=>args.onNotice?.(text),failure:()=>{},
  });
  const activity=runtime.registerActivity(()=>coordinator.busy);
  let failure:unknown;
  try{await coordinator.run(method,range,500);}catch(error){failure=error;throw error;}
  finally{
    recordState();unsubscribe();activity();
    if(identity){
      const state=runtime.dynamics.getSnapshot();
      if(state.sessionId&&['completed','stopped','error'].includes(state.status))await runtime.dynamics.waitForTermination(state.sessionId);
      controller.recordOptimization(identity,{event:'terminal',workerSettled:true,status:failure?'failed':state.status==='stopped'?'stopped':'completed',
        result:{frames,status:failure?'failed':state.status,...(state.lastFrame?{finalStructure:structuredClone(state.lastFrame.structure)}:{}),series:phases.map((row,index)=>({id:`opt-${index+1}`,label:row.mode==='geometry'?'机械调整':'力场优化'})),provenance:{coordinateUnit:'angstrom',energyUnit:'hartree',method,algorithm:'workspace-forcefield',driver:'workspace-forcefield',phases:structuredClone(phases),terminalFailure:state.terminalFailure}},
        ...(failure?{error:{message:failure instanceof Error?failure.message:String(failure)}}:{})});
    }
  }
}
