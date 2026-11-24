import type { Structure, Vector3 } from '../../core/types';
import { XTB_METHOD_LABELS, type XtbRequest } from '../xtb/contracts';
import { isPesNetMethod, PES_CALC_PROFILE, PES_SCHEMA, type PesFfModel, type PesNetMethod, type PesFrame, type PesGeometryLimits, type PesRequest, type PesResult } from '../pes/contracts';
import { createPesFfModel } from '../pes/ff-model';
import type { ComputeResourceEvidence } from '../resource-preferences';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { isPeriodic, validatePeriodicEndpointImages } from '../../core/periodic';
import { NET_METHOD_SCOPE } from '../pes/net-model-settings';
import { periodicPesOperationAvailable } from '../pes/periodic-capabilities';
import type { AdvancedOptimizationMethod, ConformerOptimizerSettings } from './contracts';

export type ConformerOptimizationRequest = Omit<XtbRequest, 'method'> & {
  method: XtbRequest['method'] | PesNetMethod;
  device?: 'cpu' | 'gpu';
  ffModel?: PesFfModel;
};

type BatchOptRequest = PesRequest & { operation: 'opt' };
const limitKeys = ['energyDifferenceHartree', 'gradientNormHartreePerBohr'] as const;
const historicalLimitKeys = ['maxForceHartreePerBohr', 'rmsForceHartreePerBohr', 'maxDisplacementBohr', 'rmsDisplacementBohr'] as const;
const limitValues = (values?: PesGeometryLimits) => values as Record<string, number> | undefined;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const equalityTolerance = 1e-7;

/** Validate the grant against the requested memory budget, when one was captured. */
function assertConformerBatchGrant(grant: ComputeResourceEvidence | undefined, memoryBudgetBytes?: number): void {
  if (!grant && memoryBudgetBytes === undefined) return;
  const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  if (!grant || grant.threads !== 1 || !positive(grant.memoryBudgetBytes)
    || !/^[a-f0-9]{64}$/.test(grant.version) || typeof grant.source !== 'string' || !grant.source.trim()
    || grant.memoryEnforced !== false || !positive(grant.configured?.threads) || !positive(grant.configured?.memoryBudgetBytes)
    || !positive(grant.requested?.threads) || !positive(grant.requested?.memoryBudgetBytes)
    || (memoryBudgetBytes !== undefined && (grant.requested.threads !== 1 || grant.requested.memoryBudgetBytes !== memoryBudgetBytes))
    || (grant.configured.threads !== 1 && !(typeof grant.threadLimitReason === 'string' && grant.threadLimitReason.trim()))
    || !Number.isSafeInteger(grant.reservedBytes) || grant.reservedBytes < 0
    || grant.memoryBudgetBytes + grant.reservedBytes !== grant.configured.memoryBudgetBytes)
    throw new Error('构象优化缺少匹配的受管全局资源回执。');
}

export interface ConformerSharedOptimizationEvidence {
  frameId: string;
  steps: number;
  converged: boolean;
  maxFrozenDisplacementAngstrom?: number;
  provenance: PesResult['provenance'];
}

export function normalizeConformerOptimizationMethod(method: AdvancedOptimizationMethod): AdvancedOptimizationMethod {
  if (method.backend === 'forcefield') return method;
  if (method.backend === 'net') return { ...method,
    optimizer: method.optimizer ?? { algorithm: 'lbfgs', convergencePreset: 'loose' } };
  const { optimizationStepPolicy: _legacyPolicy, ...options } = method.options;
  return {
    ...method,
    options: { ...options, maxSteps: options.maxSteps ?? 500 },
    optimizer: method.optimizer ?? { algorithm: 'lbfgs', convergencePreset: 'loose' },
  };
}

export function validConformerOptimizer(settings: ConformerOptimizerSettings, historical = false): boolean {
  const limits = limitValues(settings.convergenceLimits);
  return ['lbfgs', 'precon-exp', 'fire2', 'sella-xyz', 'sella-ric'].includes(settings.algorithm)
    && ['loose', 'medium', 'tight', 'custom'].includes(settings.convergencePreset)
    && (settings.convergencePreset !== 'custom' || (historical ? historicalLimitKeys : limitKeys).every(key =>
      Number.isFinite(limits?.[key]) && limits![key] > 0));
}

/** The persisted candidate carries the ordinary source, electronics and constraints;
 * only the trusted desktop host chooses the actual executable and resource grant. */
export function conformerOptimizerAvailable(method: ConformerOptimizationRequest['method'], periodic: boolean, algorithm: ConformerOptimizerSettings['algorithm']): boolean {
  if (isPesNetMethod(method) && (NET_METHOD_SCOPE[method] === 'periodic') !== periodic) return false;
  return periodic ? periodicPesOperationAvailable(method, 'opt', algorithm) : algorithm !== 'precon-exp';
}

export function conformerCoordinateImages(structure: Structure, row: Pick<ConformerOptimizationRequest['constraints'][number], 'atomIds' | 'images'>): Vector3[] | undefined {
  return row.images ?? (isPeriodic(structure) ? row.atomIds.map(() => [0, 0, 0]) : undefined);
}

export function conformerPesRequest(input: ConformerOptimizationRequest, settings: ConformerOptimizerSettings, sessionId: string, historical = false): BatchOptRequest {
  const periodic = isPeriodic(input.structure), net = isPesNetMethod(input.method);
  if (!validConformerOptimizer(settings, historical) || !conformerOptimizerAvailable(input.method, periodic, settings.algorithm)
    || (net ? input.device !== 'cpu' && input.device !== 'gpu' : input.device !== undefined)
    || (periodic || net) && input.solvation || input.calculation !== 'optimize' || !input.maxSteps
    || input.solvation && input.solvation.model !== 'alpb' || input.constraints.length && !input.internalConstraintsConfirmed)
    throw Error('构象共用优化的方法、步数、ALPB 或 B/A/D 确认无效。');
  const multiplicity = input.structure.multiplicity ?? (input.uhf ?? 0) + 1;
  const solvation = input.solvation ? { model: 'alpb' as const, solvent: input.solvation.solvent } : undefined;
  const constraints = input.constraints.map((row, index) => {
    const images = conformerCoordinateImages(input.structure, row);
    validatePeriodicEndpointImages(input.structure, row.atomIds, images);
    return { id: `freeze-${index}`, type: row.type, atomIds: row.atomIds, value: row.value!, ...(images ? { images } : {}) };
  });
  return {
    schema: PES_SCHEMA, id: sessionId, runIdentity: { groupId: sessionId, taskId: sessionId, runId: sessionId },
    operation: 'opt', method: input.method, algorithm: settings.algorithm,
    sourceDocumentId: input.stamp.documentId, structure: input.structure, charge: input.charge, uhf: multiplicity - 1,
    ...(solvation ? { solvation } : {}), ...(input.method === 'gfnff'
      ? { ffModel: input.ffModel ?? createPesFfModel(sessionId, input.structure, input.charge, multiplicity, solvation) } : {}),
    constraints: { frozenAtomIds: input.frozenAtomIds, coordinates: constraints },
    coordinates: [], threads: 1, ...(input.memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes: input.memoryBudgetBytes }),
    parameters: { calcProfile: PES_CALC_PROFILE, policyVersion: 'v212', maxSteps: input.maxSteps,
      maxStepAngstrom: .1, maxSccIterations: input.maxSccIterations ?? 250, convergencePreset: settings.convergencePreset,
      ...(settings.convergencePreset === 'custom' ? settings.convergenceLimits : {}), ...(net ? { device: input.device } : {}) },
  };
}

/** Compact terminal-only receipt. The same authority validates the host's
 * native handoff and the renderer's recovery from the canonical batch store. */
export function acceptConformerPesResult(input: ConformerOptimizationRequest, settings: ConformerOptimizerSettings, sessionId: string,
  frame: PesFrame, provenance: PesResult['provenance'], converged: boolean, grant: ComputeResourceEvidence, restoring = false) {
  const optimizerLimits = (provenance?.optimizer as Record<string, unknown> | undefined)?.limits as PesGeometryLimits | undefined;
  const limits = limitValues(optimizerLimits);
  const historical = restoring && !limitKeys.every(key => Number.isFinite(limits?.[key]));
  const activeKeys = historical ? historicalLimitKeys : limitKeys;
  const request = conformerPesRequest(input, settings, sessionId, historical);
  const custom = limitValues(settings.convergenceLimits);
  const optimizer = provenance?.optimizer as Record<string, unknown> | undefined;
  const metrics = provenance?.convergence as (PesGeometryLimits & {constraintsSatisfied?: boolean; constraintResiduals?: Record<string, number>}) | undefined;
  const values = limitValues(metrics);
  const energyDifference = values?.stationaryEnergyVerificationHartree ?? values?.energyDifferenceHartree;
  const missingInitialDifference = !historical && !converged && frame.step === 0
    && optimizer?.terminationReason === 'no-feasible-step' && energyDifference === undefined;
  const metric = (key: string) => key === 'energyDifferenceHartree' ? energyDifference : values?.[key];
  const residuals = metrics?.constraintResiduals;
  const solvent = provenance?.solvationEvidence as Record<string, unknown> | null | undefined;
  const version = provenance?.version;
  const net = isPesNetMethod(input.method), periodic = isPeriodic(input.structure);
  const actualNetMethod = input.method === 'aimnet2-auto' ? (request.uhf > 0 ? 'aimnet2-nse' : 'aimnet2') : input.method;
  const runtime = net ? { engine: provenance?.engine, version, weightSha256: provenance?.weightSha256,
    head: provenance?.head, assetId: provenance?.assetId, device: provenance?.device,
    runtime: provenance?.netRuntime && (provenance.netRuntime as Record<string, unknown>).backend } : provenance?.engineIdentity;
  const ffRuntime = provenance?.ffModelRuntime as Record<string, unknown> | undefined;
  assertConformerBatchGrant(grant, input.memoryBudgetBytes);
  if (!grant || provenance?.sourceDocumentId !== request.sourceDocumentId || provenance.method !== request.method
    || provenance.algorithm !== request.algorithm || provenance.charge !== request.charge || provenance.uhf !== request.uhf
    || provenance.coordinateUnit !== 'angstrom' || provenance.energyUnit !== 'hartree' || provenance.threads !== grant.threads
    || provenance.memoryBudgetBytes !== grant.memoryBudgetBytes || !runtime || typeof version !== 'string' || !version
    || net && (provenance.engine !== actualNetMethod || provenance.device !== input.device
      || typeof provenance.weightSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(provenance.weightSha256))
    || periodic && !same(optimizer?.fixedCellAngstrom, input.structure.cell!.vectors)
    || periodic && request.ffModel && (!ffRuntime || ffRuntime.modelId !== request.ffModel.modelId || !ffRuntime.parameterIdentity
      || typeof ffRuntime.referenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ffRuntime.referenceSha256))
    || request.ffModel && !same(provenance.ffModel,request.ffModel)
    || (request.solvation ? solvent?.model !== request.solvation.model || solvent?.solvent !== request.solvation.solvent : !!solvent)
    || optimizer?.name !== request.algorithm || optimizer?.coordinateSystem !== (settings.algorithm === 'sella-ric' ? 'ric' : 'xyz')
    || optimizer?.maximumSteps !== input.maxSteps || optimizer?.maxStepAngstrom !== request.parameters.maxStepAngstrom
    || !Number.isSafeInteger(frame.step) || frame.step < 0 || frame.step > input.maxSteps!
    || frame.id !== `${sessionId}:opt:${frame.step}` || frame.phase !== 'opt' || frame.seriesId !== 'opt'
    || provenance.acceptedSteps !== frame.step || !Number.isFinite(frame.energyHartree)
    || frame.converged !== converged || frame.status !== (converged ? 'converged' : 'accepted')
    || (converged ? optimizer.terminationReason !== 'converged' : !['step-limit', 'no-feasible-step'].includes(String(optimizer.terminationReason)))
    || typeof metrics?.constraintsSatisfied !== 'boolean' || !residuals || Object.keys(residuals).length !== request.constraints.coordinates.length
    || !request.constraints.coordinates.every(row => Number.isFinite(residuals[row.id]) && Math.abs(residuals[row.id]) <= equalityTolerance)
    || !activeKeys.every(key => (Number.isFinite(metric(key)) || key === 'energyDifferenceHartree' && missingInitialDifference)
      && Number.isFinite(limits?.[key]) && limits![key] > 0
      && (settings.convergencePreset !== 'custom' || limits![key] === custom![key]))
    || converged !== activeKeys.every(key => (metric(key) ?? Infinity) <= limits![key]))
    throw Error('构象共用优化终态、算法、冻结残差、收敛或资源回执不符。');
  if (!Array.isArray(frame.positions) || frame.positions.length !== input.structure.atoms.length)
    throw Error('构象优化终态的原子数不符。');
  const structure = structuredClone(input.structure), fixed = new Set(input.frozenAtomIds);
  let maxFrozenDisplacementAngstrom = 0;
  structure.atoms = input.structure.atoms.map((atom, index) => {
    const point = frame.positions[index];
    if (!Array.isArray(point) || point.length !== 3 || !point.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6))
      throw Error('构象优化终态坐标无效。');
    const [x, y, z] = point;
    if (fixed.has(atom.id!)) {
      maxFrozenDisplacementAngstrom = Math.max(maxFrozenDisplacementAngstrom, Math.hypot(x - atom.x, y - atom.y, z - atom.z));
    }
    return { ...atom, x, y, z };
  });
  structure.preparation = undefined;
  structure.molfile = undefined;
  if (!metrics.constraintsSatisfied && maxFrozenDisplacementAngstrom === 0)
    throw Error('构象共用优化的精确约束回执不符。');
  if (periodic || maxFrozenDisplacementAngstrom > 0) for (const row of request.constraints.coordinates) {
    const difference = builderCoordinateValue(structure, row.type, row.atomIds, row.images) - row.value;
    const residual = row.type === 'D' ? ((difference + 180) % 360 + 360) % 360 - 180 : difference;
    if (Math.abs(residual) > equalityTolerance) throw Error('构象优化实际坐标的 B/A/D 冻结残差超出求解精度。');
  }
  const evidence: ConformerSharedOptimizationEvidence = { frameId: frame.id, steps: frame.step, converged, provenance,
    ...(maxFrozenDisplacementAngstrom > 0 ? { maxFrozenDisplacementAngstrom } : {}) };
  return { structure, evidence, identity: {
    method: `${isPesNetMethod(input.method) ? input.method : XTB_METHOD_LABELS[input.method]}:${version}`,
    solvent: request.solvation ? `alpb:${request.solvation.solvent}` : 'none',
    energyKind: input.method === 'gfnff' ? 'forcefield-potential' as const : 'electronic' as const,
    charge: request.charge, multiplicity: request.uhf + 1,
    settingsKey: JSON.stringify({ constraints: input.constraints, frozenAtomIds: input.frozenAtomIds,
      runtime, ...(periodic ? { fixedCell: { vectors: input.structure.cell!.vectors, pbc: input.structure.cell!.pbc,
        origin: input.structure.cell!.origin ?? [0, 0, 0] },
        ...(request.ffModel ? { ffReferenceSha256: ffRuntime?.referenceSha256, parameterIdentity: ffRuntime?.parameterIdentity } : {}) } : {}),
      optimizer: settings, maxSteps: input.maxSteps, maxSccIterations: request.parameters.maxSccIterations }),
  } };
}

export function restoreConformerPesFrame(structure: Structure, energyHartree: number, evidence: ConformerSharedOptimizationEvidence): PesFrame {
  return { id: evidence.frameId, step: evidence.steps, converged: evidence.converged,
    phase: 'opt', seriesId: 'opt', status: evidence.converged ? 'converged' : 'accepted',
    energyHartree, positions: structure.atoms.map(atom => [atom.x, atom.y, atom.z]) };
}
