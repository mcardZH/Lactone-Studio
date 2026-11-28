import type { Vector3 } from '../../core/types';
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

function vector3(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function pesHessianMode(run: PesRun, modeId: number, requestedFrameId?: string) {
  const result = run.result, hessian = object(result?.hessian);
  const frameId = hessian?.frameId;
  if (!hessian || typeof frameId !== 'string' || !Array.isArray(result?.frequencies))
    return { status: 'unavailable' as const, reason: 'native-hessian-modes-missing' };
  if (requestedFrameId !== undefined && requestedFrameId !== frameId)
    return { status: 'unavailable' as const, reason: 'hessian-belongs-to-another-frame', frameId };
  const summaries = result.frequencies.map(object);
  const matches = summaries.filter(mode => mode?.mode === modeId);
  if (matches.length !== 1 || !Number.isFinite(matches[0]?.wavenumberCm1) || typeof matches[0]?.imaginary !== 'boolean')
    return { status: 'unavailable' as const, reason: 'native-mode-missing', frameId,
      availableModes: summaries.flatMap(mode => Number.isSafeInteger(mode?.mode) ? [mode!.mode] : []) };
  const mode = matches[0]!;
  const summary = { mode: modeId, wavenumberCm1: mode.wavenumberCm1, imaginary: mode.imaginary };
  const atoms = run.request.structure.atoms, positions = hessian.geometryAngstrom, ids = hessian.atomIds;
  const frames = result.frames.filter(frame => frame.id === frameId);
  const frame = frames[0];
  if (frames.length !== 1 || !Array.isArray(ids) || ids.length !== atoms.length || ids.some((id, index) => !id || id !== atoms[index].id) ||
      !Array.isArray(positions) || positions.length !== atoms.length || frame.positions.length !== atoms.length ||
      !positions.every((row, index) => vector3(row) && row.every((value, axis) => frame.positions[index]?.[axis] === value)))
    return { status: 'unavailable' as const, reason: 'hessian-frame-or-atom-identity-mismatch', frameId, ...summary };
  const vectors = mode.displacements;
  if (!Array.isArray(vectors) || vectors.length !== atoms.length || !vectors.every(vector3))
    return { status: 'unavailable' as const, reason: 'native-displacements-missing', frameId, ...summary };
  const displacementNormL2 = vectors.reduce((total, [x,y,z]) => Math.hypot(total,x,y,z), 0);
  if (!(displacementNormL2 > 0) || !Number.isFinite(displacementNormL2))
    return { status: 'unavailable' as const, reason: 'invalid-native-displacement-norm', frameId, ...summary };
  return {
    status: 'available' as const, frameId, seriesId: frame.seriesId, ...summary,
    coordinateUnit: 'angstrom', displacementConvention: 'cartesian-direction', displacementNormL2,
    atoms: atoms.map((atom, index) => ({ atomId: atom.id, element: atom.element, positionAngstrom: positions[index], displacement: vectors[index] })),
    source: hessian.source,
  };
}

/** Read terminal scientific evidence from the same run which owns the frames.
 * Keep dense Hessian matrices and mode displacements in their native readers. */
export function pesRunScientificEvidence(run: PesRun) {
  const result = run.result;
  if (!result) return {};
  const hessian = object(result.hessian), irc = object(result.irc);
  const provenance = result.provenance ?? {};
  const actual = Object.fromEntries(['method','engine','version','optimizer','coordinateSystem','pathInitializer',
    'convergencePreset','accuracy','threads','physicalEvaluations','attemptedPhysicalEvaluations']
    .flatMap(key => {
      const value = provenance[key];
      return typeof value==='string' || typeof value==='number'&&Number.isFinite(value) ? [[key,value]] : [];
    }));
  const hessianEvidence = hessian && {
    runId: run.request.runIdentity.runId, frameId: hessian.frameId,
    derivativeMethod: hessian.derivativeMethod, derivativeEvaluations: hessian.derivativeEvaluations,
    nativeHessianCalls: hessian.nativeHessianCalls, displacementBohr: hessian.displacementBohr,
    vibrationalDegreesOfFreedom: hessian.vibrationalDegreesOfFreedom, imaginaryCount: hessian.imaginaryCount,
    source: hessian.source, space: hessian.space,
    ...(typeof hessian.frameId==='string' && Array.isArray(result.frequencies) &&
      result.frequencies.some(value=>Array.isArray(object(value)?.displacements)) ? {
      readMode: {tool:'es_pes_mode_read',arguments:{runId:run.request.runIdentity.runId,frameId:hessian.frameId},requiredArgument:'mode'},
    } : {}),
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
    ...(Object.keys(actual).length && { actual }),
    ...(run.request.operation === 'ts' && { stationaryPoint: result.stationaryPoint, converged: result.converged }),
    ...(hessianEvidence && { hessian: hessianEvidence }),
    ...(ircEvidence && { irc: ircEvidence }),
  };
}
