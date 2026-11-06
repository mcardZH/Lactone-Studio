import type { ExcitationDensityField, ExcitationDensityFieldPair, ExcitationResult, NtoField } from './excitation-contracts';
import { sameSurfaceContext, validateSurfaceScalarField } from './surface-field';
import type { SurfaceScalarField } from './surface-contracts';

function validState(state: NtoField['state']): boolean {
  return !!state && [state.index, state.sourceLine].every(n => Number.isSafeInteger(n) && n >= 1)
    && (state.multiplicity === undefined || Number.isSafeInteger(state.multiplicity) && state.multiplicity >= 1)
    && Number.isSafeInteger(state.frameIndex) && state.frameIndex >= 0 && Number.isFinite(state.energyEv) && typeof state.label === 'string';
}
export function sameExcitationState(a: NtoField['state'], b: NtoField['state']): boolean {
  return (['index', 'sourceLine', 'frameIndex', 'energyEv', 'label', 'multiplicity'] as const).every(key => a[key] === b[key]);
}
export function validateNtoField(field: NtoField): void {
  // Validate the shared grid/atom/array contract without giving NTO amplitudes a
  // density role or adding any orbital-energy metadata to the real DTO.
  const structural = { ...field, source: { id: field.id, name: field.id, revision: field.context.sourceRevision, kind: 'generated-cube', producer: 'multiwfn' },
    function: 'external', functionLabel: 'NTO wavefunction', definitionEvidence: { kind: 'native-output', description: 'Native signed NTO wavefunction' } } as SurfaceScalarField;
  validateSurfaceScalarField(structural);
  if (field.valueUnit !== 'bohr^-3/2' || field.grid.coordinateUnit !== 'bohr' || !validState(field.state)
    || field.context.sourceFrameIndex !== field.state.frameIndex || !Number.isSafeInteger(field.pairIndex) || field.pairIndex < 1
    || !['restricted', 'alpha', 'beta'].includes(field.spin) || !['hole', 'electron'].includes(field.side)
    || !Number.isFinite(field.eigenvalue) || field.eigenvalue < -1e-10 || field.validDomain.kind !== 'full-grid') throw new Error('NTO格点须有明确态/轨道对、原子单位振幅和完整计算域；特征值不是轨道能量。');
}
export function validateExcitationDensityField(field: ExcitationDensityField): void {
  validateSurfaceScalarField(field);
  if (field.function !== 'electron-density' || field.valueUnit !== 'bohr^-3' || field.grid.coordinateUnit !== 'bohr'
    || !['hole-density', 'electron-density'].includes(field.excitationRole) || !validState(field.state) || field.context.sourceFrameIndex !== field.state.frameIndex
    || field.definitionEvidence.kind !== 'native-output' || field.source.producer !== 'multiwfn' || field.validDomain.kind !== 'full-grid'
    || field.values.some(value => value < 0)) throw new Error('电子-空穴格点须为指定态的非负Total密度、原子单位和完整有效域。');
}
export function validateExcitationDensityFieldPair(pair: ExcitationDensityFieldPair): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  try { validateExcitationDensityField(pair.shape); } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  if (pair.kind !== 'excitation-density' || pair.mapping !== null || !Number.isFinite(pair.isovalue) || pair.isovalue <= 0) reasons.push('电子-空穴表面须有正有限等值且不夹带映射格点。');
  return { compatible: reasons.length === 0, reasons };
}
export function validateExcitationResult(result: ExcitationResult): void {
  const stamp = result.stamp;
  if (!stamp?.sourceId || !stamp.sourceRevision || !stamp.requestId || !stamp.analysisId || !validState(result.state)
    || stamp.sourceFrameIndex !== result.state.frameIndex || !Number.isSafeInteger(stamp.generation) || stamp.generation < 0) throw new Error('激发态结果缺少明确来源、帧、态或请求身份。');
  const orca = result.provenance.orcaAmplitudes;
  if (orca && (orca.sourceStateIndex !== result.state.index || orca.sourceLine !== result.state.sourceLine || orca.multiplicity !== result.state.multiplicity
    || !['out-tda', 'json-rpa', 'cis-rpa', 'cis-verified-json-recovery'].includes(orca.route)
    || ![orca.rpaNorm, orca.xSquared, orca.ySquared].every(Number.isFinite) || orca.xSquared < 0 || orca.ySquared < 0
    || Math.abs(orca.xSquared - orca.ySquared - orca.rpaNorm) > 1e-8)) throw new Error('ORCA原始幅来源的态、multiplicity或X/Y范数不一致。');
  if (result.operation !== 'nto-field') {
    const evidence = result.coefficients;
    if (!evidence || evidence.sourceLine !== result.state.sourceLine || !evidence.blockRevision || !Number.isSafeInteger(evidence.coefficientCount) || evidence.coefficientCount < 1
      || [evidence.excitationSquared, evidence.deexcitationSquared, evidence.netSquared, evidence.expectedNormalization, evidence.normalizationDeviation].some(value => !Number.isFinite(value))
      || evidence.excitationSquared < 0 || evidence.deexcitationSquared < 0 || evidence.expectedNormalization <= 0 || evidence.normalizationDeviation < 0
      || Math.abs(evidence.netSquared - (evidence.excitationSquared - evidence.deexcitationSquared)) > 1e-8) throw new Error('激发态原始系数证据、方向归一或源行身份无效。');
  }
  if (result.operation === 'nto-field') {
    validateNtoField(result.field);
    if (!sameSurfaceContext(stamp, result.field.context) || !sameExcitationState(result.state, result.field.state)) throw new Error('NTO格点与结果上下文或激发态不一致。');
  } else if (result.operation === 'hole-electron') {
    validateExcitationDensityField(result.hole); validateExcitationDensityField(result.electron);
    if (result.hole.excitationRole !== 'hole-density' || result.electron.excitationRole !== 'electron-density'
      || !sameSurfaceContext(stamp, result.hole.context) || !sameSurfaceContext(stamp, result.electron.context)
      || !sameExcitationState(result.state, result.hole.state) || !sameExcitationState(result.state, result.electron.state)
      || JSON.stringify(result.hole.grid) !== JSON.stringify(result.electron.grid) || JSON.stringify(result.hole.atoms) !== JSON.stringify(result.electron.atoms)) throw new Error('总空穴/电子格点身份、网格或逐序原子不一致。');
    if (result.metrics.some(metric => metric.value !== null && !Number.isFinite(metric.value))) throw new Error('非有限原生指标须保留缺项及原值，不能填0。');
    if ([result.coulomb.valueHartree, result.coulomb.valueEV].some(value => value !== null && !Number.isFinite(value))) throw new Error('库仑模型能量须为有限值或缺项。');
    if (result.coulomb.definition !== 'hole-electron-coulomb-model' || !result.coulomb.requested && (result.coulomb.valueHartree !== null || result.coulomb.valueEV !== null)) throw new Error('库仑模型只能来自本次明确请求，不能夹带其他网格的能量。');
  } else if (result.operation === 'nto') {
    const pairs = new Set<string>();
    for (const pair of result.pairs) {
      const identity = `${pair.spin}:${pair.index}`;
      if (pairs.has(identity) || !Number.isSafeInteger(pair.index) || pair.index < 1 || !['restricted', 'alpha', 'beta'].includes(pair.spin)
        || !Number.isFinite(pair.eigenvalue) || pair.eigenvalue < -1e-10 || pair.weightPercent !== 100 * pair.eigenvalue) throw new Error('NTO对须保留原始特征值及100λ权重，不能重复、裁剪或归一化。');
      pairs.add(identity);
      for (const [side, orbital] of [['hole', pair.hole], ['electron', pair.electron]] as const) {
        const sources = new Set(orbital.moContributions.map(row => `${row.spin}:${row.sourceIndex}`));
        if (orbital.side !== side || !Number.isSafeInteger(orbital.nativeIndex) || orbital.nativeIndex < 1
          || !Number.isSafeInteger(orbital.sourceIndex) || orbital.sourceIndex < 1 || sources.size !== orbital.moContributions.length
          || orbital.moContributions.some(row => row.spin !== pair.spin || !Number.isSafeInteger(row.sourceIndex) || row.sourceIndex < 1 || !Number.isFinite(row.amplitude) || !Number.isFinite(row.percent) || row.percent < 0
            || Math.abs(row.percent - 100 * row.amplitude ** 2) > 1e-10 * Math.max(1, row.percent))) throw new Error('NTO展开须保留带符号MO系数及其平方贡献。');
        if (result.expansion.available && (!orbital.moContributions.length || Math.abs(orbital.moContributions.reduce((sum, row) => sum + row.percent, 0) - 100) > .01)) throw new Error('可用NTO展开须给出完整MO贡献及可靠范数。');
      }
    }
    if (!pairs.size || !Number.isFinite(result.eigenvalueSum) || Math.abs(result.eigenvalueSum - result.pairs.reduce((sum, p) => sum + p.eigenvalue, 0)) > 1e-8) throw new Error('NTO全对特征值和不一致。');
  } else throw new Error('未知激发态结果类型。');
}
