import type {PesController} from './controller';
import type {PesFrame,PesGeometry,PesRunIdentity} from './contracts';
import type {XtbRunObserver} from '../xtb/controller';
import type {XtbPreviewFrame} from '../xtb/contracts';

function frame(value:XtbPreviewFrame):PesFrame {
  return{id:`${value.sessionId}:${value.seq}`,seriesId:'opt',phase:'opt',step:value.step,status:'accepted',
    positions:value.coordinates.map(atom=>[atom.x,atom.y,atom.z]),...(value.energyHartree===undefined?{}:{energyHartree:value.energyHartree}),
    nativeSessionId:value.sessionId,nativeFrameSequence:value.seq,stepKind:value.stepKind};
}

/** Observe the already admitted ordinary xTB driver. This adapter starts no work. */
export function createPesXtbOptimizationObserver(controller:PesController,groupId:string,nodeId:string,source:PesGeometry,stop:()=>Promise<void>):XtbRunObserver {
  let identity:PesRunIdentity|undefined;
  return{
    deferApplication:true,
    onStart(request,sessionId){
      const captured={...source,documentId:request.stamp.documentId,revision:request.stamp.revision,structure:request.structure};
      identity=controller.beginOptimization(groupId,nodeId,captured,{method:request.method,algorithm:'ordinary-xtb',
        charge:request.charge,multiplicity:source.structure.multiplicity??(request.uhf??0)+1,frozenAtomIds:request.frozenAtomIds,
        coordinates:request.constraints.map((row,index)=>({id:row.id??`constraint-${index}`,type:row.type,atomIds:row.atomIds,value:row.value!})),
        parameters:{nativeSessionId:sessionId,request}},stop).identity;
    },
    onEvent(event){
      if(!identity)return;
      if(event.event==='started')controller.recordOptimization(identity,{event:'started'});
      if(event.event==='progress')controller.recordOptimization(identity,{event:'progress',stage:event.status??'OPT',completed:event.step});
      if(event.event==='frame'&&event.coordinates&&event.step!==undefined&&event.stepKind)controller.recordOptimization(identity,{event:'frame',frame:frame(event as XtbPreviewFrame)});
    },
    onSettled(value){
      if(!identity)return;
      const frames=value.frames.filter(row=>row.sessionId===value.sessionId).map(frame),result=value.result;
      const completedGeometry=value.status==='completed'&&result?.metadata.converged===true&&!!value.document;
      if(result){
        const last=frames.at(-1),positions=result.coordinates.map(atom=>[atom.x,atom.y,atom.z] as [number,number,number]);
        const terminal={status:result.metadata.converged?'converged':'step-limit',energyHartree:result.metadata.energyHartree,converged:result.metadata.converged};
        if(!last||JSON.stringify(last.positions)!==JSON.stringify(positions))frames.push({id:`${value.sessionId}:final`,seriesId:'opt',phase:'opt',step:(last?.step??-1)+1,...terminal,positions});
        else frames[frames.length-1]={...last,...terminal};
      }
      controller.recordOptimization(identity,{event:'terminal',workerSettled:true,status:value.status,result:{frames,status:result?(result.metadata.converged?'converged':'unconverged'):value.status,
        ...(value.document?{finalStructure:value.document.draft.structure}:{}),
        provenance:{coordinateUnit:'angstrom',energyUnit:'hartree',method:value.request.method,algorithm:'ordinary-xtb',nativeSessionId:value.sessionId,nativeRequest:value.request,...(result?{metadata:result.metadata,engineIdentity:result.metadata.engineIdentity,ffModelRuntime:result.metadata.ffModelRuntime}:{}),...(value.request.ffModel?{ffModel:value.request.ffModel}:{}),
          ...(completedGeometry&&value.error?{warnings:[value.error]}:{})}},
        ...(value.error&&!completedGeometry?{error:{message:value.error}}:{})});
    },
  };
}
