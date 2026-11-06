import type { Structure } from '../../core/types';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { assertBuilderStereoPreserved } from '../../core/builder-stereo';
import { XTB_INTERNAL_CONSTRAINT_POLICY } from '../xtb/accept-result';
import type { XtbCoordinate, XtbMetadata, XtbRequest, XtbResourceGrant } from '../xtb/contracts';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const delta = (type: string, n: number) => type === 'D' ? ((n + 180) % 360 + 360) % 360 - 180 : n;
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Pure acceptance of an isolated request. No Store/model publication or activation guard. */
export function advancedXtbCoordinates(request: XtbRequest, coordinates: readonly XtbCoordinate[], final = false): Structure {
  requireValue(Array.isArray(coordinates) && coordinates.length === request.structure.atoms.length, '高级任务原子数量不匹配。');
  const fixed = new Set(request.frozenAtomIds), singlepoint = request.calculation === 'singlepoint';
  const result = structuredClone(request.structure);
  result.atoms = request.structure.atoms.map((atom, i) => {
    const p = coordinates[i];
    requireValue(p?.id === atom.id && p.element === atom.element && [p.x, p.y, p.z].every(v => Number.isFinite(v) && Math.abs(v) <= 1e6), '高级任务帧身份、顺序或有限坐标无效。');
    if (fixed.has(atom.id!) || singlepoint) requireValue(Object.is(p.x, atom.x) && Object.is(p.y, atom.y) && Object.is(p.z, atom.z), '高级任务改变了固定原子或单点坐标。');
    return { ...atom, x: p.x, y: p.y, z: p.z };
  });
  result.preparation = undefined; result.molfile = undefined;
  assertBuilderStereoPreserved(request.structure, result);
  if (final) for (const row of request.constraints) {
    const target = row.value ?? builderCoordinateValue(request.structure, row.type, row.atomIds);
    const actual = builderCoordinateValue(result, row.type, row.atomIds), residual = delta(row.type, actual - target);
    const tolerance = row.type === 'B' ? XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom : XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree;
    requireValue(Number.isFinite(residual) && Math.abs(residual) <= tolerance, '高级任务最终冻结内坐标残差未达标。');
  }
  return result;
}

export function validateAdvancedXtbResult(request: XtbRequest, coordinates: readonly XtbCoordinate[], metadata: XtbMetadata,
  effectiveResources?: XtbResourceGrant): Structure {
  const grant = metadata?.resourceGrant;
  if (grant || effectiveResources || request.memoryBudgetBytes !== undefined) {
    const positive = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
    requireValue(grant && (!effectiveResources || same(grant, effectiveResources))
      && positive(grant.threads) && positive(grant.memoryBudgetBytes) && typeof grant.source === 'string' && !!grant.source
      && /^[a-f0-9]{64}$/.test(grant.version) && grant.memoryEnforced === false
      && positive(grant.configured?.threads) && positive(grant.configured?.memoryBudgetBytes)
      && positive(grant.requested?.threads) && positive(grant.requested?.memoryBudgetBytes)
      && grant.requested.threads === request.threads && (request.memoryBudgetBytes === undefined || grant.requested.memoryBudgetBytes === request.memoryBudgetBytes)
      && grant.threads <= grant.configured.threads && (grant.threads === grant.configured.threads || typeof grant.threadLimitReason === 'string' && !!grant.threadLimitReason.trim())
      && Number.isSafeInteger(grant.reservedBytes) && grant.reservedBytes >= 0 && grant.memoryBudgetBytes + grant.reservedBytes === grant.configured.memoryBudgetBytes
      && metadata.threads === grant.threads, '高级任务缺少匹配的受管全局资源授权回执。');
  }
  requireValue(metadata?.converged === true && metadata.engine === 'xtb' && metadata.method === request.method
    && metadata.calculation === request.calculation && metadata.charge === request.charge
    && metadata.uhf === (request.method === 'gfnff' ? null : request.uhf)
    && metadata.energyUnit === 'hartree' && metadata.coordinateUnit === 'angstrom' && Number.isFinite(metadata.energyHartree)
    && typeof metadata.version === 'string' && metadata.version.length > 0 && metadata.periodic === undefined
    && metadata.threads === (grant?.threads ?? request.threads) && metadata.maxSteps === request.maxSteps
    && (!request.optimizationPool || metadata.threads===1)
    && metadata.maxWallTimeSeconds === request.maxWallTimeSeconds, '高级任务完成方法、资源、单位或电子态回执不匹配。');
  if (request.solvation) {
    const evidence = metadata.solvation;
    requireValue(evidence?.model === request.solvation.model && evidence.solvent === request.solvation.solvent
      && evidence.kernel === (request.solvation.model === 'alpb' ? 'p16' : 'still') && evidence.referenceState === 'gsolv'
      && evidence.temperatureKelvin === 298.15 && evidence.sourceField === 'stdout:solvation-model'
      && evidence.parameterSet === `internal ${{ gfn0: '', gfn1: 'GFN1-xTB', gfn2: 'GFN2-xTB', gfnff: 'GFN-FF' }[request.method]}/${request.solvation.model.toUpperCase()}`, '高级任务缺少匹配的原生隐式溶剂模型回执。');
  } else requireValue(metadata.solvation === undefined, '气相高级任务混入隐式溶剂结果。');
  requireValue(same([...metadata.frozenAtomIds].sort(), [...request.frozenAtomIds].sort())
    && metadata.internalConstraintMode === (request.constraints.length ? 'native-harmonic' : 'none')
    && metadata.internalConstraints.length === request.constraints.length, '高级任务冻结回执库存不匹配。');
  if (request.calculation === 'singlepoint') {
    requireValue(Number.isSafeInteger(metadata.sccIterations) && metadata.sccIterations! >= 1
      && metadata.sccIterations! <= (request.maxSccIterations??250) && metadata.sccIterationLimit === (request.maxSccIterations??250), '高级单点缺少真实SCC完成回执。');
  } else requireValue(Number.isSafeInteger(metadata.iterations) && metadata.iterations! >= 0 && metadata.iterations! <= request.maxSteps!, '高级优化缺少有效完成迭代回执。');
  const result = advancedXtbCoordinates(request, coordinates, true);
  for (const row of request.constraints) {
    const measured = metadata.internalConstraints.find(c => c.type === row.type && same(c.atomIds, row.atomIds));
    const target = row.value ?? builderCoordinateValue(request.structure, row.type, row.atomIds);
    const actual = builderCoordinateValue(result, row.type, row.atomIds), residual = delta(row.type, actual - target);
    requireValue(measured && measured.mode === 'native-harmonic' && measured.unit === (row.type === 'B' ? 'angstrom' : 'degree')
      && [measured.target, measured.actual, measured.residual].every(Number.isFinite)
      && Math.abs(measured.target - target) < 1e-7 && Math.abs(delta(row.type, measured.actual - actual)) < 1e-6
      && Math.abs(measured.residual - residual) < 1e-6, '高级任务约束实际值与回执不一致。');
  }
  return result;
}
