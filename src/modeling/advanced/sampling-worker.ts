import { generateConformerGuessSteps } from '../conformers/sampling';
import { isMixedSamplingDuplicate } from './mixed-sampling';
import { clusterConformerResults, createConformerGeometryComparer } from '../conformers/clustering';
import type { SamplingWorkRequest } from './sampling-work';
import {samplingGenerationProgress} from './sampling-generation-progress';

// Each worker owns one immutable batch. No application/store/native owner is
// transferred here; terminating this worker cannot affect a newer run.
let cancelled = false;
self.onmessage = async (event: MessageEvent<SamplingWorkRequest | { kind: 'stop' }>) => {
  const request = event.data;
  if (request.kind === 'stop') { cancelled = true; return; }
  let last = 0;
  const progress = (completed: number, total: number | null, extra = {}) => {
    const now = performance.now();
    if (now - last < 250) return;
    last = now; self.postMessage({ kind: 'progress', completed, total, ...extra });
  };
  try {
    let result: unknown;
    if (request.kind === 'generate') {
      const iterator = generateConformerGuessSteps(request.snapshot, request.entries, request.quantity, request.options);
      let next = iterator.next();
      const report=(state:Parameters<typeof samplingGenerationProgress>[0])=>{last=performance.now();self.postMessage({kind:'progress',...samplingGenerationProgress(state,request.options)});};
      if(!next.done)report(next.value.state);
      while (!next.done) {
        const { state, total } = next.value;
        if (performance.now() - last >= 100) {
          report(state);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (cancelled) { state.status='partial';state.stopReason='cancelled';report(state);result = state; iterator.return(state); break; }
        next = iterator.next();
      }
      if (next.done){report(next.value);result = next.value;}
    } else if (request.kind === 'deduplicate') {
      const retained = [...request.retained], accepted: number[] = [];
      const compare=createConformerGeometryComparer();
      let processed = 0;
      for (let index = 0; index < request.candidates.length; index++) {
        const candidate = request.candidates[index];
        if (!isMixedSamplingDuplicate(candidate, retained, request.threshold,compare)) { accepted.push(index); retained.push(candidate); }
        progress(index + 1, request.candidates.length);
        processed = index + 1;
        if (performance.now() - last < 5) await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelled) {
          // Keep all not-yet-compared valid structures as an explicitly
          // unfinished deduplication prefix, never discard them on stop.
          for (let remaining=index+1;remaining<request.candidates.length;remaining++)accepted.push(remaining);
          break;
        }
      }
      result = {acceptedIndices:accepted,processed,completed:processed===request.candidates.length};
    } else result = clusterConformerResults(request.records, request.policy);
    self.postMessage({ kind: 'result', result });
  } catch (error) { self.postMessage({ kind: 'error', error: error instanceof Error ? error.message : String(error) }); }
};
