import type { PesFrame, PesRun } from '../../modeling/pes/contracts';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function branchEndpoint(frames: readonly PesFrame[], direction: unknown) {
  let last: PesFrame | undefined;
  for (const frame of frames) {
    if (frame.ircDirection !== direction || typeof frame.ircStep !== 'number') continue;
    if (!last || frame.ircStep > Number(last.ircStep)) last = frame;
  }
  return last && {
    frameId: last.id, seriesId: last.seriesId, step: last.ircStep,
    status: last.status, converged: last.converged, energyHartree: last.energyHartree,
  };
}

/** Read terminal scientific evidence from the same run which owns the frames.
 * Keep dense Hessian matrices and mode displacements in their native readers. */
export function pesRunScientificEvidence(run: PesRun) {
  const result = run.result;
  if (!result) return {};
  const hessian = object(result.hessian), irc = object(result.irc);
  const hessianEvidence = hessian && {
    runId: run.request.runIdentity.runId, frameId: hessian.frameId,
    derivativeMethod: hessian.derivativeMethod, derivativeEvaluations: hessian.derivativeEvaluations,
    nativeHessianCalls: hessian.nativeHessianCalls, displacementBohr: hessian.displacementBohr,
    vibrationalDegreesOfFreedom: hessian.vibrationalDegreesOfFreedom, imaginaryCount: hessian.imaginaryCount,
    source: hessian.source, space: hessian.space,
    modes: Array.isArray(result.frequencies) ? result.frequencies.flatMap(value => {
      const mode = object(value);
      return mode ? [{ mode: mode.mode, wavenumberCm1: mode.wavenumberCm1, imaginary: mode.imaginary }] : [];
    }) : [],
  };
  const ircEvidence = irc && {
    kind: irc.kind, mode: irc.mode, imaginaryCount: irc.imaginaryCount,
    originFrameId: result.frames.find(frame => frame.ircDirection === 'origin')?.id,
    branches: Array.isArray(irc.branches) ? irc.branches.flatMap(value => {
      const branch = object(value);
      return branch ? [{
        direction: branch.direction, status: branch.status, attemptedSteps: branch.attemptedSteps,
        acceptedSteps: branch.acceptedSteps, error: branch.error,
        endpoint: branchEndpoint(result.frames, branch.direction),
      }] : [];
    }) : [],
  };
  return {
    ...(run.request.operation === 'ts' && { stationaryPoint: result.stationaryPoint, converged: result.converged }),
    ...(hessianEvidence && { hessian: hessianEvidence }),
    ...(ircEvidence && { irc: ircEvidence }),
  };
}
