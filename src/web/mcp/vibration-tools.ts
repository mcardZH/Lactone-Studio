import { flushSync } from 'react-dom';
import { MAX_VIBRATION_AMPLITUDE_ANGSTROM } from '../../results/vibrations';
import type {RamanStokesParameters} from '../../results/spectroscopy';
import { vibrationViews, type VibrationViewPatch, type VibrationViewSnapshot } from '../results/vibration-view-port';
import { hessianReadRecovery, type ResultToolsContext } from './result-tools';
import { objectSchema, toolError, type McTool } from './types';

const textSchema={type:'string',minLength:1};
const numberSchema={type:'number'};
const positive={...numberSchema,exclusiveMinimum:0};
const ramanSchema=objectSchema({laserWavelengthNm:positive,temperatureK:positive},['laserWavelengthNm','temperatureK']);
const patchSchema=objectSchema({
  setIndex:{type:'integer',minimum:0},mode:{type:'integer',minimum:1},
  amplitudeAngstrom:{...numberSchema,minimum:0,maximum:MAX_VIBRATION_AMPLITUDE_ANGSTROM},periodMs:{...numberSchema,minimum:40},
  playing:{type:'boolean'},phase:{...numberSchema,minimum:-1,maximum:1},
});

export function vibrationTools(ctx:Pick<ResultToolsContext,'getResult'|'resultRegistry'>):McTool[] {
  return [{
    name:'vibration_view',
    description:'Read or configure the active native Vibrations panel. Open analysis_view page vibrations first. For a Raman Stokes spectrum, read this view and apply ramanStokes with laserWavelengthNm, temperatureK and the current expectedRevision. The receipt identifies the native chart and plot_export actions for PNG and scientific TXT. Read frequencies from an original PES Hessian run with es_run_read and hessian.modes. Mode is the displayed 1-based number; setIndex is zero-based. Phase is the signed displacement fraction from −1 to +1 and pauses unless playing is explicitly true.',
    inputSchema:objectSchema({targetRef:textSchema,viewRef:textSchema,expectedRevision:textSchema,patch:patchSchema,ramanStokes:ramanSchema}),
    call(args,call){
      call?.signal.throwIfAborted();
      const target=ctx.getResult(args.targetRef as string|undefined),requested=args.viewRef as string|undefined;
      const registered=ctx.resultRegistry?.resultViews;
      const currentResult=target.result;
      const candidates=vibrationViews(ctx.resultRegistry).flatMap(port=>{
        const state=port.read();
        if(!state.active||state.ownerId!==target.ownerId||requested&&state.viewRef!==requested)return [];
        const ownerViews=[...registered?.values()??[]].filter(view=>view.ownerId===state.ownerId&&view.active&&view.result.id===state.resultId);
        const views=ownerViews.filter(view=>view.available&&view.frameReady&&view.frameIndex===state.frameIndex);
        if(ownerViews.length&&!views.length)return [];
        if(currentResult&&state.resultId!==currentResult.id&&!views.some(view=>view.sourceResultId===currentResult.id||view.rootResultId===currentResult.id))return [];
        return [{port,state}];
      });
      if(candidates.length!==1){
        if(candidates.length>1)throw toolError('vibration_view_ambiguous','Specify the exact visible vibration view.',{views:candidates.map(row=>row.state.viewRef)});
        const targetRef=target.navigationRef??target.ownerId,hessian=hessianReadRecovery(target);
        throw toolError('vibration_view_unavailable',hessian?'当前来源没有可用的原生振动视口。该 PES Hessian 的频率可从原运行读取。':'请打开目标结果的振动分析页并等待来源帧就绪。',
          {ownerId:target.ownerId,targetRef,resultId:target.result?.id,recovery:hessian??{tool:'analysis_view',arguments:{targetRef,page:'vibrations',waitMs:2000}}});
      }
      const {port,state}=candidates[0],targetRef=target.navigationRef??target.ownerId;
      const read={tool:'vibration_view',arguments:{targetRef,viewRef:state.viewRef}};
      const receipt=(current:VibrationViewSnapshot)=>{
        if(!current.raman)return current;
        const {raman}=current;
        const plot=raman.parameters&&raman.usableStokesModeCount>0&&[...ctx.resultRegistry?.plots.values()??[]].find(row=>
          row.kind==='raman'&&row.ownerId===current.ownerId&&row.resultId===current.resultId&&row.jobIndex===current.jobIndex&&
          row.frameIndex===current.frameIndex&&row.source?.id===current.sourceId&&row.source.sha256===current.sourceSha256&&row.display?.active);
        const parameters=raman.parameters??raman.defaults;
        const apply=raman.activityModeCount>0&&port.applyRaman&&parameters?.laserWavelengthNm&&parameters.temperatureK?
          {tool:'vibration_view',arguments:{...read.arguments,expectedRevision:current.revision,ramanStokes:parameters}}:undefined;
        const status=plot?'ready':raman.usableStokesModeCount>0?'preparing':
          raman.parameters||!raman.activityModeCount?'data-unavailable':'parameters-required';
        return {...current,raman:{...raman,status,apply,...(plot?{plot:{plotId:plot.id,revision:plot.revision,
          exports:plot.port.read().formats.map(format=>({format,export:{tool:'plot_export',arguments:{plotId:plot.id,format,save:true}}}))}}:
          raman.usableStokesModeCount>0?{read}:{})}};
      };
      if(args.patch===undefined&&args.ramanStokes===undefined)return receipt(state);
      if(args.expectedRevision!==state.revision)
        throw toolError('revision_conflict','振动模式、显示设置或来源帧已变化，请重新读取。',{...receipt(state),recovery:read});
      if(args.ramanStokes!==undefined){
        if(args.patch!==undefined)throw toolError('invalid_arguments','Apply Raman parameters separately from a vibration set or mode change.',{recovery:read});
        if(!port.applyRaman||!state.raman?.activityModeCount)
          throw toolError('raman_activity_unavailable','The selected frequency set has no attributed Raman activity.',{recovery:read});
        const parameters=args.ramanStokes as RamanStokesParameters;
        if(![parameters?.laserWavelengthNm,parameters?.temperatureK].every(value=>Number.isFinite(value)&&value>0))
          throw toolError('invalid_arguments','Provide a finite positive laser wavelength in nm and temperature in K.',{recovery:read});
        flushSync(()=>port.applyRaman!(parameters));
      }else flushSync(()=>port.configure(args.patch as VibrationViewPatch));
      const after=port.read();
      if(!after.active||after.viewRef!==state.viewRef||after.resultId!==state.resultId||after.sourceId!==state.sourceId||after.sourceSha256!==state.sourceSha256||after.jobIndex!==state.jobIndex||after.frameIndex!==state.frameIndex)throw toolError('vibration_view_changed','应用期间振动视图已变化。');
      return receipt(after);
    },
  }];
}
