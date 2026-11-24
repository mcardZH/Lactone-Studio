import { flushSync } from 'react-dom';
import { MAX_VIBRATION_AMPLITUDE_ANGSTROM } from '../../results/vibrations';
import { vibrationViews, type VibrationViewPatch } from '../results/vibration-view-port';
import { hessianReadRecovery, type ResultToolsContext } from './result-tools';
import { objectSchema, toolError, type McTool } from './types';

const textSchema={type:'string',minLength:1};
const numberSchema={type:'number'};
const patchSchema=objectSchema({
  setIndex:{type:'integer',minimum:0},mode:{type:'integer',minimum:1},
  amplitudeAngstrom:{...numberSchema,minimum:0,maximum:MAX_VIBRATION_AMPLITUDE_ANGSTROM},periodMs:{...numberSchema,minimum:40},
  playing:{type:'boolean'},phase:{...numberSchema,minimum:-1,maximum:1},
});

export function vibrationTools(ctx:Pick<ResultToolsContext,'getResult'|'resultRegistry'>):McTool[] {
  return [{
    name:'vibration_view',
    description:'Read or configure the active native Vibrations panel. Open it with analysis_view page vibrations. Read frequencies from an original PES Hessian run with es_run_read and hessian.modes. Mode is the displayed 1-based number; setIndex is zero-based. Phase is the signed displacement fraction from −1 to +1, and pauses unless playing is explicitly true. Scene status follows the native viewport.',
    inputSchema:objectSchema({targetRef:textSchema,viewRef:textSchema,expectedRevision:textSchema,patch:patchSchema}),
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
      const {port,state}=candidates[0];
      if(args.patch===undefined)return state;
      if(args.expectedRevision!==state.revision)throw toolError('revision_conflict','振动模式、显示设置或来源帧已变化，请重新读取。',state);
      flushSync(()=>port.configure(args.patch as VibrationViewPatch));
      const after=port.read();
      if(!after.active||after.viewRef!==state.viewRef||after.resultId!==state.resultId||after.sourceId!==state.sourceId||after.sourceSha256!==state.sourceSha256||after.jobIndex!==state.jobIndex||after.frameIndex!==state.frameIndex)throw toolError('vibration_view_changed','应用期间振动视图已变化。');
      return after;
    },
  }];
}
