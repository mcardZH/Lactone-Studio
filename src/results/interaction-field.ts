import { ELEMENTS } from '../core/elements';
import type { InteractionComponent, InteractionContributionRequest, InteractionContributions, InteractionFieldPair, InteractionGeneratedFields, InteractionGenerateRequest, InteractionGridQuality, InteractionMethod, InteractionSourceFragment } from './interaction-contracts';
import type { ScalarFieldFunction, SurfaceProvenance, SurfaceScalarField, SurfaceStamp } from './surface-contracts';
import { isSurfaceDensityAtomicUnit, sameSurfaceContext, sameSurfaceStamp, scalarFieldCompatibilityReasons, validateSurfaceScalarField, type SurfacePairValidation } from './surface-field';

const COMPONENTS = Object.freeze({ iri: ['iri'], rdg: ['rdg'], igmh: ['inter', 'intra', 'total'], migm: ['inter', 'intra', 'total'], igm: ['inter', 'intra', 'total'] } as const);
const FUNCTIONS = Object.freeze({ iri: 'iri', rdg: 'rdg', inter: 'delta-g-inter', intra: 'delta-g-intra', total: 'delta-g' } as const);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function interactionComponents(method: InteractionMethod): readonly InteractionComponent[] {
  requireCondition(Object.hasOwn(COMPONENTS, method), '未知相互作用方法；不静默替换方法。');
  return COMPONENTS[method];
}
export function interactionDefaultComponent(method: InteractionMethod): InteractionComponent { return interactionComponents(method)[0]; }
export function interactionFieldFunction(component: InteractionComponent): ScalarFieldFunction {
  requireCondition(Object.hasOwn(FUNCTIONS, component), '未知相互作用格点分量。');
  return FUNCTIONS[component];
}
/** Scatter has no isovalue prerequisite. Only surface-bound domain metadata,
 * when present, additionally needs its original explicit isovalue. */
export type InteractionScatterPair = Omit<InteractionFieldPair, 'isovalue'> & { isovalue?: number };

function hasMethodUnit(field: SurfaceScalarField, component: InteractionComponent): boolean {
  // Native main-20 reports a.u.; do not infer units from values or file names.
  if (field.valueUnit === 'a.u.') return true;
  return component === 'rdg' && (field.valueUnit === '1' || field.valueUnit === 'dimensionless');
}
function domainReasons(field: SurfaceScalarField, pair: InteractionScatterPair): string[] {
  const domain = field.validDomain;
  if (domain.kind === 'unknown') return ['相互作用格点有效域未知，不能把未算节点或哨兵值当作物理值。'];
  if (!nonempty(domain.evidence)) return ['相互作用格点有效域缺少明确来源依据。'];
  if (domain.kind !== 'node-mask' || !domain.restrictedTo) return [];
  const binding = domain.restrictedTo, shape = pair.shape;
  const matches = binding.shapeSourceRevision !== undefined
    ? /^[a-f0-9]{64}$/i.test(binding.shapeSourceRevision) && binding.shapeSourceRevision === shape.source.revision
    : binding.shapeFieldId === shape.id;
  return matches && Number.isFinite(pair.isovalue) && binding.isovalue === pair.isovalue ? [] : ['受限相互作用格点与当前形状格点内容身份或明确等值不符。'];
}
function interactionPairReasons(pair: InteractionScatterPair): string[] {
  const reasons: string[] = [];
  if (pair.kind !== 'interaction') reasons.push('相互作用格点对缺少明确科学类型标记。');
  try { if (!interactionComponents(pair.method).includes(pair.component)) reasons.push('格点分量不属于当前相互作用方法。'); } catch (error) { reasons.push(errorText(error)); }
  const inside = pair.method === 'iri' || pair.method === 'rdg' ? 'below' : 'above';
  if (pair.inside !== inside) reasons.push('相互作用等值内外方向与方法定义不一致。');
  if (!pair.shape || !pair.mapping) return [...reasons, '相互作用绘图需要明确的方法格点与sign(λ₂)ρ映射格点。'];
  for (const field of [pair.shape, pair.mapping]) try { validateSurfaceScalarField(field); } catch (error) { reasons.push(errorText(error)); }
  if (reasons.length) return reasons;
  reasons.push(...scalarFieldCompatibilityReasons(pair.shape, pair.mapping));
  const shape = pair.shape, mapping = pair.mapping;
  if (shape.id === mapping.id) reasons.push('方法格点与映射格点须保留独立格点数据身份。');
  if (shape.function !== interactionFieldFunction(pair.component) || !hasMethodUnit(shape, pair.component)) reasons.push('方法格点函数或单位未确认，不能冒用电子密度、其他分量或未知单位。');
  if (mapping.function !== 'sign-lambda2-rho' || !isSurfaceDensityAtomicUnit(mapping.valueUnit)) reasons.push('映射格点须明确为原子单位sign(λ₂)ρ；不按普通密度或其他单位猜测。');
  for (const field of [shape, mapping]) {
    if (!['native-output', 'user-provided'].includes(field.definitionEvidence.kind) || !nonempty(field.definitionEvidence.description)) reasons.push('相互作用格点角色缺少明确来源或用户声明。');
    reasons.push(...domainReasons(field, pair));
  }
  return reasons;
}
/** External pairs may call this directly; a fabricated native session/result is
 * neither needed nor accepted as evidence. No mutation, fitting or resampling. */
export function validateInteractionFieldPair(pair: InteractionFieldPair): SurfacePairValidation {
  const reasons = interactionPairReasons(pair);
  if (!Number.isFinite(pair.isovalue) || pair.isovalue <= 0) reasons.push('相互作用等值须为明确的正有限数。');
  return { compatible: reasons.length === 0, reasons };
}
export function interactionScatterData(pair: InteractionScatterPair): { x: Float64Array; y: Float64Array; valid?: Uint8Array } {
  const reasons = interactionPairReasons(pair);
  requireCondition(!reasons.length, reasons.join('；'));
  const x = pair.mapping.values, y = pair.shape.values, shapeDomain = pair.shape.validDomain, mappingDomain = pair.mapping.validDomain;
  if (shapeDomain.kind === 'full-grid' && mappingDomain.kind === 'full-grid') return { x, y };
  const valid = new Uint8Array(x.length);
  for (let i = 0; i < valid.length; i++) valid[i] = (shapeDomain.kind === 'full-grid' || shapeDomain.kind === 'node-mask' && shapeDomain.mask[i] === 1)
    && (mappingDomain.kind === 'full-grid' || mappingDomain.kind === 'node-mask' && mappingDomain.mask[i] === 1) ? 1 : 0;
  return { x, y, valid };
}

function validateStamp(stamp: SurfaceStamp): void {
  requireCondition(nonempty(stamp.sourceId) && nonempty(stamp.sourceRevision) && nonempty(stamp.requestId) && nonempty(stamp.analysisId)
    && Number.isSafeInteger(stamp.generation) && stamp.generation >= 0, '相互作用结果缺少可靠来源、请求、分析或代际身份。');
  requireCondition([stamp.jobIndex, stamp.sourceFrameIndex].every(value => value === null || Number.isSafeInteger(value) && value >= 0)
    && [stamp.documentRevision, stamp.activationEpoch].every(value => value === undefined || Number.isSafeInteger(value) && value >= 0)
    && (stamp.documentId === undefined || nonempty(stamp.documentId)), '相互作用结果的来源帧或修订身份无效。');
}
function validateFragments(method: InteractionMethod, fragments: readonly InteractionSourceFragment[], atomCount?: number): void {
  interactionComponents(method);
  if (method === 'iri' || method === 'rdg') { requireCondition(fragments.length === 0, '全局IRI/RDG不能夹带片段定义。'); return; }
  requireCondition(fragments.length > 0, 'IGM/IGMH/mIGM需要明确的非空片段定义。');
  const ids = new Set<string>(), atoms = new Set<number>();
  for (const fragment of fragments) {
    requireCondition(nonempty(fragment.id) && nonempty(fragment.label) && !ids.has(fragment.id) && fragment.atomIndices.length > 0, '相互作用片段身份重复、标签缺失或片段为空。');
    ids.add(fragment.id);
    for (const index of fragment.atomIndices) {
      requireCondition(Number.isSafeInteger(index) && index >= 1 && (atomCount === undefined || index <= atomCount) && !atoms.has(index), '相互作用片段原子须为不重叠的一基源编号。');
      atoms.add(index);
    }
  }
}
function sameFragments(a: readonly InteractionSourceFragment[], b: readonly InteractionSourceFragment[]): boolean {
  return a.length === b.length && a.every((fragment, index) => fragment.id === b[index].id && fragment.label === b[index].label
    && fragment.atomIndices.length === b[index].atomIndices.length && fragment.atomIndices.every((atom, ordinal) => atom === b[index].atomIndices[ordinal]));
}
export function validateInteractionGridQuality(quality: InteractionGridQuality): void {
  requireCondition(!!quality && ['low', 'medium', 'high', 'spacing', 'dimensions', 'target-points'].includes(quality.mode), '未知相互作用网格质量。');
  const keys = Object.keys(quality);
  if(quality.mode==='target-points') requireCondition(keys.length===2&&[32768,4096000].includes(quality.targetPoints),'目标网格只支持已批准的玩具或艺术总点数。');
  else if (quality.mode === 'spacing') requireCondition(keys.length === 2 && Number.isFinite(quality.spacingBohr) && quality.spacingBohr > 0, '相互作用自定义格距须为正有限数，不夹带其他网格参数。');
  else if (quality.mode === 'dimensions') requireCondition(keys.length === 2 && Array.isArray(quality.dimensions) && quality.dimensions.length === 3
    && quality.dimensions.every(value => Number.isSafeInteger(value) && value >= 2)
    && Number.isSafeInteger(quality.dimensions.reduce((total, value) => total * value, 1)*8), '相互作用 XYZ 点数须为至少 2 的整数，且总点数可精确表示。');
  else requireCondition(keys.length === 1, '原生质量档不能夹带自定义网格参数。');
}
function sameQuality(a: InteractionGridQuality, b: InteractionGridQuality): boolean { return a.mode === b.mode
  && (a.mode!=='target-points'||b.mode==='target-points'&&a.targetPoints===b.targetPoints)
  && (a.mode !== 'spacing' || b.mode === 'spacing' && a.spacingBohr === b.spacingBohr)
  && (a.mode !== 'dimensions' || b.mode === 'dimensions' && a.dimensions.every((value, index) => value === b.dimensions[index])); }
function validateProvenance(provenance: SurfaceProvenance, stamp: SurfaceStamp, method: InteractionMethod): void {
  requireCondition(nonempty(provenance.backend.name) && nonempty(provenance.backend.version) && provenance.sourceIds.includes(stamp.sourceId), '相互作用来源记录缺少后端或当前科学来源。');
  requireCondition(provenance.parameters.method === method && provenance.parameters.densitySource === (method === 'migm' || method === 'igm' ? 'promolecular' : 'actual-wavefunction'), '相互作用方法或实际/预分子密度来源与记录冲突。');
  requireCondition(provenance.rawArtifacts.length > 0 && provenance.rawArtifacts.every(artifact => nonempty(artifact.role) && nonempty(artifact.name) && nonempty(artifact.revision)), '相互作用原始产物记录缺少身份或内容修订。');
}
function requireGeneratedField(field: SurfaceScalarField, stamp: SurfaceStamp, provenance: SurfaceProvenance, role: string): void {
  requireCondition(sameSurfaceContext(field.context, stamp) && field.source.kind === 'generated-cube' && field.source.producer === 'multiwfn'
    && field.definitionEvidence.kind === 'native-output', '原生相互作用格点的来源、帧、代际或生成角色不一致。');
  requireCondition(provenance.rawArtifacts.some(artifact => artifact.role === role && artifact.name === field.source.name && artifact.revision === field.source.revision), '相互作用格点没有匹配其名称、角色和内容修订的原始Cube记录。');
}
export function validateInteractionGeneratedFields(result: InteractionGeneratedFields, expectedRequest?: InteractionGenerateRequest): void {
  validateStamp(result.stamp); validateInteractionGridQuality(result.quality); validateProvenance(result.provenance, result.stamp, result.method);
  const components = interactionComponents(result.method);
  validateSurfaceScalarField(result.mapping); validateFragments(result.method, result.fragments, result.mapping.atoms.length);
  requireCondition(Object.keys(result.fields).length === components.length && Object.keys(result.fields).every(key => components.includes(key as InteractionComponent)), '相互作用方法格点分量缺失、重复或夹带其他方法结果。');
  requireCondition(result.provenance.parameters.quality === result.quality.mode
    && result.provenance.parameters.mappingDensitySource === (result.method === 'migm' || result.method === 'igm' ? 'promolecular' : 'actual-wavefunction'), '相互作用网格质量或着色密度来源与记录冲突。');
  const dimensions = result.provenance.parameters.actualDimensions, selectedAtoms = result.provenance.parameters.selectedAtomIndices;
  if (result.quality.mode === 'dimensions') requireCondition(result.quality.dimensions.every((value, index) => value === result.mapping.grid.dimensions[index]), '相互作用原生点数与明确请求不符，不能替换为其他质量档。');
  const union = result.fragments.flatMap(fragment => [...fragment.atomIndices]).sort((a, b) => a - b);
  requireCondition(Array.isArray(dimensions) && dimensions.length === 3 && dimensions.every((value, index) => value === result.mapping.grid.dimensions[index])
    && Array.isArray(selectedAtoms) && selectedAtoms.length === union.length && selectedAtoms.every((value, index) => value === union[index]), '相互作用网格点数或参与原子与来源记录冲突。');
  requireGeneratedField(result.mapping, result.stamp, result.provenance, 'mapping-cube');
  const ids = new Set([result.mapping.id]);
  for (const component of components) {
    const shape = result.fields[component]; requireCondition(shape, '相互作用方法格点缺失。');
    const pair: InteractionScatterPair = { kind: 'interaction', method: result.method, component, shape, mapping: result.mapping, inside: component === 'iri' || component === 'rdg' ? 'below' : 'above' };
    const reasons = interactionPairReasons(pair); requireCondition(!reasons.length, reasons.join('；'));
    requireCondition(!ids.has(shape.id), '相互作用不同分量不能复用同一格点数据身份。'); ids.add(shape.id);
    requireGeneratedField(shape, result.stamp, result.provenance, `${component}-cube`);
  }
  const integralComponents = new Set<string>();
  for (const integral of result.integrals) {
    requireCondition(components.includes(integral.component) && !integralComponents.has(integral.component) && Number.isFinite(integral.value) && integral.value >= 0 && integral.unit === 'a.u.', '相互作用积分分量、数值或单位无效。');
    integralComponents.add(integral.component);
  }
  requireCondition(integralComponents.size === (result.method === 'iri' || result.method === 'rdg' ? 0 : 3), '相互作用方法所需原生积分缺失。');
  if (expectedRequest) requireCondition(sameSurfaceStamp(result.stamp, expectedRequest.stamp) && result.method === expectedRequest.method
    && sameFragments(result.fragments, expectedRequest.fragments) && sameQuality(result.quality, expectedRequest.quality), '相互作用返回来源、请求、方法、片段或质量不属于当前请求。');
}
/** Geometry construction requires an explicit isovalue, unlike scatter. */
export function interactionFieldPair(generated: InteractionGeneratedFields, component: InteractionComponent, isovalue: number): InteractionFieldPair {
  validateInteractionGeneratedFields(generated);
  requireCondition(interactionComponents(generated.method).includes(component) && generated.fields[component], '当前方法未生成所选格点分量。');
  const pair: InteractionFieldPair = { kind: 'interaction', method: generated.method, component, shape: generated.fields[component]!, mapping: generated.mapping, isovalue,
    inside: component === 'iri' || component === 'rdg' ? 'below' : 'above' };
  const checked = validateInteractionFieldPair(pair); requireCondition(checked.compatible, checked.reasons.join('；'));
  return pair;
}
export function validateInteractionContributions(result: InteractionContributions, expectedRequest?: InteractionContributionRequest): void {
  validateStamp(result.stamp); validateFragments(result.method, result.fragments); validateProvenance(result.provenance, result.stamp, result.method);
  requireCondition(['igmh', 'migm'].includes(result.method) && [2, 3, 4].includes(result.integrationQuality) && result.provenance.parameters.integrationQuality === result.integrationQuality,
    '贡献方法或独立积分质量无效。');
  requireCondition(result.pair.length === 2 && result.pair[0] !== result.pair[1] && result.pair.every(id => result.fragments.some(fragment => fragment.id === id)), '贡献结果须绑定两个不同的已定义片段。');
  requireCondition(result.unit === 'a.u.' && Number.isFinite(result.pairSum) && result.pairSum >= 0
    && result.percentageDefinition === 'atoms-within-each-fragment;pairs-within-selected-pair', '贡献单位、原生分母或百分比定义无效；不能将所有片段原子归一为100%。');
  const selected = result.pair.map(id => result.fragments.find(fragment => fragment.id === id)!);
  const nativeSelection = result.provenance.parameters.selectedFragmentIndices, requestedSelection = result.provenance.parameters.requestedFragmentIndices;
  const requestedIndices = selected.map(fragment => result.fragments.indexOf(fragment) + 1), nativeIndices = [...requestedIndices].sort((a, b) => a - b);
  // Native evaluates the pair in definition order. Returned rows are restored
  // to caller order; these two provenance fields must not be conflated.
  requireCondition(Array.isArray(nativeSelection) && nativeSelection.length === 2 && nativeSelection.every((value, index) => value === nativeIndices[index]), '贡献片段对与原生运行顺序记录冲突。');
  requireCondition(Array.isArray(requestedSelection) && requestedSelection.length === 2 && requestedSelection.every((value, index) => value === requestedIndices[index]), '贡献片段对与请求方向记录冲突。');
  requireCondition(result.provenance.rawArtifacts.some(artifact => artifact.role === 'atomic-pair-contributions'), '贡献结果缺少原生贡献表来源。');
  const atomIds = new Set<number>(), pairIds = new Set<string>();
  const validValue = (value: number, percent: number | null) => Number.isFinite(value) && value >= 0 && (percent === null || Number.isFinite(percent) && percent >= 0 && percent <= 100);
  for (const atom of result.atoms) {
    requireCondition(!atomIds.has(atom.sourceIndex) && selected.some(fragment => fragment.id === atom.fragmentId && fragment.atomIndices.includes(atom.sourceIndex))
      && ELEMENTS.includes(atom.element) && validValue(atom.value, atom.percent), '原子贡献身份、片段归属、数值或百分比无效。');
    atomIds.add(atom.sourceIndex);
  }
  requireCondition(atomIds.size === selected.reduce((sum, fragment) => sum + fragment.atomIndices.length, 0), '所选片段的原子贡献表不完整。');
  for (const row of result.pairs) {
    const key = `${row.sourceIndex1}:${row.sourceIndex2}`;
    requireCondition(!pairIds.has(key) && selected[0].atomIndices.includes(row.sourceIndex1) && selected[1].atomIndices.includes(row.sourceIndex2)
      && validValue(row.value, row.percent), '原子对贡献身份、方向、数值或百分比无效。');
    pairIds.add(key);
  }
  // Printed sums/percentages are validated by the native parser with its own
  // documented print intervals, never with a new frontend tolerance or renormalization.
  if (expectedRequest) requireCondition(sameSurfaceStamp(result.stamp, expectedRequest.stamp) && result.method === expectedRequest.method
    && sameFragments(result.fragments, expectedRequest.fragments) && result.pair.every((id, index) => id === expectedRequest.pair[index]) && result.integrationQuality === expectedRequest.integrationQuality,
    '贡献返回来源、请求、方法、片段对或积分质量不属于当前请求。');
}
