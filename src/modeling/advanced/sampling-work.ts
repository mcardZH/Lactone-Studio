import { generateConformerGuesses,generateConformerGuessSteps } from '../conformers/sampling';
import { clusterConformerResults } from '../conformers/clustering';
import { isMixedSamplingDuplicate } from './mixed-sampling';
import type { Structure } from '../../core/types';
import { startGeometryWorkPool } from './geometry-work-pool';
import {samplingGenerationProgress,type SamplingGenerationCounters} from './sampling-generation-progress';

type GenerationArguments = Parameters<typeof generateConformerGuesses>;
export type SamplingWorkRequest =
  | { kind: 'generate'; snapshot: GenerationArguments[0]; entries: GenerationArguments[1]; quantity: GenerationArguments[2]; options: Omit<NonNullable<GenerationArguments[3]>, 'onProgress'> }
  | { kind: 'deduplicate'; candidates: Structure[]; retained: Structure[]; threshold: number }
  | { kind: 'cluster'; records: Parameters<typeof clusterConformerResults>[0]; policy: Parameters<typeof clusterConformerResults>[1] };
export interface SamplingWorkProgress { completed: number; total: number | null; phase?:'cluster'|'eliminate-equivalent';valid?: number;generation?:SamplingGenerationCounters }
export interface SamplingDeduplicationResult { acceptedIndices: number[]; processed: number; completed: boolean }
export function startSamplingWork<T>(request: SamplingWorkRequest, onProgress: (value: SamplingWorkProgress) => void,
  resources?:{threads:number;memoryBudgetBytes:number;retainedMemoryEstimateBytes?:number}): { promise: Promise<T>; stop(): void } {
  if(typeof Worker!=='undefined'&&request.kind==='deduplicate'&&resources){const pool=startGeometryWorkPool(request,resources,onProgress);return{promise:pool.promise as Promise<T>,stop:pool.stop};}
  // Headless unit consumers have no browser Worker. The desktop/browser route
  // always takes the module worker; this fallback keeps the pure API testable.
  if (typeof Worker === 'undefined') {
    let stopped = false;
    return { stop() { stopped = true; }, promise: Promise.resolve().then(async () => {
      if(request.kind==='generate'){
        const iterator=generateConformerGuessSteps(request.snapshot,request.entries,request.quantity,request.options);let next=iterator.next(),last=performance.now(),boundaries=0;
        const report=(state:ReturnType<typeof generateConformerGuesses>)=>onProgress(samplingGenerationProgress(state,request.options));
        if(!next.done)report(next.value.state);
        while(!next.done){const {state,total}=next.value;
          if(stopped){state.status='partial';state.stopReason='cancelled';report(state);return iterator.return(state).value as T;}
          if(performance.now()-last>=100){report(state);last=performance.now();}
          if(++boundaries%64===0)await new Promise(resolve=>setTimeout(resolve,0));
          next=iterator.next();
        }
        report(next.value);return next.value as T;
      }
      if (stopped) {
        if(request.kind==='deduplicate')return {acceptedIndices:request.candidates.map((_,index)=>index),processed:0,completed:false} as T;
        throw new Error('后台采样已停止。');
      }
      if (request.kind === 'cluster') return clusterConformerResults(request.records, request.policy,onProgress) as T;
      const retained = [...request.retained], accepted: number[] = [];
      request.candidates.forEach((candidate, index) => { if (!isMixedSamplingDuplicate(candidate, retained, request.threshold)) { retained.push(candidate); accepted.push(index); } });
      return {acceptedIndices:accepted,processed:request.candidates.length,completed:true} as T;
    }) };
  }
  const worker = new Worker(new URL('./sampling-worker.ts', import.meta.url), { type: 'module' });
  let settled = false, resolve!: (result: T) => void, reject!: (error: Error) => void;
  const finish = (action: () => void) => { if (settled) return; settled = true; worker.terminate(); action(); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  worker.onmessage = event => {
    if (settled) return; const value = event.data;
    if (value.kind === 'result') finish(() => resolve(value.result));
    else if (value.kind === 'error') finish(() => reject(new Error(value.error)));
    else if (value.kind === 'progress') {
      onProgress({ completed: value.completed, total: value.total, valid: value.valid,...(value.phase?{phase:value.phase}:{}),...(value.generation?{generation:value.generation}:{}) });
    }
  };
  worker.onerror = event => finish(() => reject(new Error(event.message || '后台采样worker失败。')));
  try { worker.postMessage(request); } catch(error) { finish(()=>reject(error instanceof Error?error:new Error(String(error)))); }
  return { promise, stop() { if (!settled) { if (request.kind === 'generate'||request.kind==='deduplicate') worker.postMessage({ kind: 'stop' }); else finish(() => reject(new Error('后台采样已停止。'))); } } };
}
