import type {JobRequest} from '../../core/types';
import type {OrcaJobRequest} from '../../core/orca/types';

/** A selected reactant is an input snapshot, never a replacement ModelStore.
 * Source freshness, electronic state and mapping remain writer validations. */
export function projectGaussianTaskStructure(request:JobRequest):JobRequest {
  const source=(request.settings.task==='qst2'||request.settings.task==='qst3')?request.settings.qst?.reactantSource:null;
  return source?{...request,structure:source.structure}:request;
}
export function projectOrcaTaskStructure(request:OrcaJobRequest):OrcaJobRequest {
  const source=request.settings.task==='neb'?request.settings.neb.reactantSource:null;
  return source?{...request,structure:source.structure}:request;
}
