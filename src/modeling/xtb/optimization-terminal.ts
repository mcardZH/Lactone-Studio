import type { XtbMetadata, XtbRequest } from './contracts';
import { isPeriodic } from '../../core/periodic';

/** RF may finish its last micro-iteration segment after the printed limit. */
export function validXtbOptimizationTerminal(request: XtbRequest, metadata: XtbMetadata): boolean {
  const limit = metadata.maxSteps;
  const iterations = metadata.iterations;
  if (limit===undefined || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(iterations) || iterations! < 0)
    return false;
  const exceedsLimit = iterations! > limit;
  if (metadata.stepLimitExceeded !== undefined && metadata.stepLimitExceeded !== exceedsLimit)
    return false;
  const nativeRfSegment = !isPeriodic(request.structure)
    && (request.optimizationStepPolicy === 'native-default' || Boolean(request.optimizationPool));
  if (exceedsLimit && (!nativeRfSegment || metadata.stepLimitExceeded !== true)) return false;
  if (metadata.converged === true)
    return metadata.convergenceStatus === undefined || metadata.convergenceStatus === 'converged';
  return metadata.converged === false && metadata.convergenceStatus === 'step-limit'
    && (nativeRfSegment ? iterations! >= limit : iterations === limit);
}
