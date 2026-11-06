import type {ConformerGuessSet,ConformerGenerationOptions} from '../conformers/sampling';

export interface SamplingGenerationCounters {
  received:number;target:number;baselineReceived:number;attempts:number;baselineAttempts:number;
}
/** Safe-boundary scalar projection. No candidate, coordinate or traversal arrays
 * enter the progress channel; failed trials never become received frames. */
export function samplingGenerationProgress(state:ConformerGuessSet,options:ConformerGenerationOptions){
  const received=state.guesses.length,target=state.boundedTargetCount;
  return {completed:received,total:target,valid:received,generation:{received,target,
    baselineReceived:options.resume?.accepted.length??0,attempts:state.attempts,baselineAttempts:options.resume?.continuation.attempts??0}};
}
