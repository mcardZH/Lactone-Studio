import { ELEMENTS } from '../core/elements';
import type { SurfacePairValidation } from './surface-field';
import { sameSurfaceContext, sameSurfaceStamp, scalarFieldCompatibilityReasons, validateSurfaceScalarField } from './surface-field';
import type { HirshfeldAnalyzeRequest, HirshfeldAnalysisResult, HirshfeldCluster, HirshfeldContacts, HirshfeldFieldPair, HirshfeldSelection } from './hirshfeld-contracts';

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finiteVector = (value: readonly number[], count = 3) => Array.isArray(value) && value.length === count && value.every(Number.isFinite);
const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance + 64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const text = (error: unknown) => error instanceof Error ? error.message : String(error);

export function validateHirshfeldCluster(cluster: HirshfeldCluster, selection?: HirshfeldSelection): void {
  requireValue(cluster.kind === 'finite-cluster' && cluster.coordinateUnit === 'angstrom' && cluster.completeFiniteCluster === true
    && nonempty(cluster.sourceId) && nonempty(cluster.sourceRevision) && cluster.atoms.length >= 2,
  'Hirshfeld分析需要已准备的完整有限团簇和明确来源。');
  const ids = new Set<string>();
  cluster.atoms.forEach((atom, index) => {
    requireValue(atom.sourceIndex === index + 1 && nonempty(atom.stableId) && !ids.has(atom.stableId) && ELEMENTS.includes(atom.element)
      && finiteVector(atom.position) && (atom.coordinatePrecisionAngstrom === undefined || Number.isFinite(atom.coordinatePrecisionAngstrom) && atom.coordinatePrecisionAngstrom >= 0),
    'Hirshfeld团簇的原子编号、身份、元素或坐标无效。');
    ids.add(atom.stableId);
    if (atom.imageRef) requireValue(nonempty(atom.imageRef.sourceAtomId) && finiteVector(atom.imageRef.translation)
      && atom.imageRef.translation.every(Number.isSafeInteger), 'Hirshfeld镜像缺少原子身份或整数晶格平移。');
  });
  if (!selection) return;
  const inside = selection.targetAtomIndices, outside = selection.environmentAtomIndices;
  requireValue([inside, outside].every(values => Array.isArray(values) && values.length > 0
    && values.every(value => Number.isSafeInteger(value) && value >= 1 && value <= cluster.atoms.length) && new Set(values).size === values.length)
    && inside.length + outside.length === cluster.atoms.length && new Set([...inside, ...outside]).size === cluster.atoms.length,
  '目标与环境必须为非空、不重叠且覆盖完整团簇的源原子集合。');
}

/** Shared field geometry and mesh admission, with an independent HS definition. */
export function validateHirshfeldFieldPair(pair: HirshfeldFieldPair): SurfacePairValidation {
  const reasons: string[] = [];
  if (pair.kind !== 'hirshfeld' || pair.definition !== 'hirshfeld-weight' || pair.isovalue !== .5 || pair.inside !== 'above') reasons.push('Hirshfeld表面必须为目标片段权重0.5且内部为高权重侧。');
  if (!pair.shape || !pair.mapping) return { compatible: false, reasons: [...reasons, 'Hirshfeld表面需要同次分析的权重与dnorm网格。'] };
  for (const field of [pair.shape, pair.mapping]) try { validateSurfaceScalarField(field); } catch (error) { reasons.push(text(error)); }
  if (reasons.length) return { compatible: false, reasons };
  reasons.push(...scalarFieldCompatibilityReasons(pair.shape, pair.mapping));
  if (pair.shape.function !== 'hirshfeld-weight' || pair.mapping.function !== 'dnorm'
    || [pair.shape, pair.mapping].some(field => field.valueUnit !== 'dimensionless')) reasons.push('HS权重与dnorm需要各自明确的无量纲函数，不能冒电子密度。');
  if (pair.shape.id === pair.mapping.id) reasons.push('HS权重与dnorm须有独立格点数据身份。');
  for (const field of [pair.shape, pair.mapping]) {
    if (field.validDomain.kind !== 'full-grid' || !nonempty(field.validDomain.evidence)) reasons.push('HS仅接受有完整有效域依据的原生同一数据网格。');
    if (field.definitionEvidence.kind !== 'native-output' || !nonempty(field.definitionEvidence.description)) reasons.push('HS网格函数需要本次原生菜单与导出角色依据。');
  }
  if (pair.shape.values.some(value => value < 0 || value > 1)) reasons.push('Hirshfeld权重必须在0至1之间，不裁剪或补零。');
  const [nx, ny, nz] = pair.shape.grid.dimensions;
  if (Math.min(nx, ny, nz) < 3) reasons.push('HS闭合检查需要每轴至少3个节点。');
  else {
    let interior = false, exterior = false, boundaryCrossing = false;
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      const value = pair.shape.values[(x * ny + y) * nz + z];
      if (value > .5) interior = true;
      if (value < .5) exterior = true;
      if ((x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) && value >= .5) boundaryCrossing = true;
    }
    if (!interior || !exterior || boundaryCrossing && pair.topology !== 'open') reasons.push('HS权重0.5表面缺少内部或碰到网格边界，不能加盖或冒闭合表面。');
  }
  return { compatible: reasons.length === 0, reasons };
}

function printed(raw: string): { value: number; precision: number } {
  requireValue(typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[dDeE][+-]?\d+)?$/.test(raw), '原生HS表格数值格式无效。');
  const [mantissa, exponent = '0'] = raw.split(/[eEdD]/), decimals = mantissa.split('.')[1]?.length ?? 0;
  const value = Number(raw.replace(/[dD]/, 'e')), precision = .5 * 10 ** (Number(exponent) - decimals);
  requireValue(Number.isFinite(value) && Number.isFinite(precision) && precision > 0
    && (value !== 0 || !/[1-9]/.test(mantissa)), '原生HS数值溢出或下溢，不能伪装成零。');
  return { value, precision };
}

export function validateHirshfeldContacts(contacts: HirshfeldContacts): void {
  requireValue(contacts.method === 'native-area' && contacts.areaUnit === 'angstrom^2'
    && contacts.denominator.scope === 'whole-hirshfeld-surface' && nonempty(contacts.mergedRule), '接触比例须使用固定完整HS原生面积分母。');
  const total = printed(contacts.denominator.rawValue);
  requireValue(total.value > total.precision && contacts.denominator.area === total.value, '原生完整HS面积分母无效。');
  const directed = new Map<string, { area: number; areaPrecision: number; percent: number; percentPrecision: number }>();
  for (const [rows, merged] of [[contacts.directedRows, false], [contacts.mergedRows, true]] as const) {
    requireValue(rows.length > 0, '原生接触面积表为空。');
    const keys = new Set<string>(); let sum = 0, sumPrecision = total.precision;
    for (const row of rows) {
      requireValue(ELEMENTS.includes(row.insideElement) && ELEMENTS.includes(row.outsideElement), '原生接触表元素无效。');
      const area = printed(row.areaRaw), percent = printed(row.percentRaw);
      requireValue(row.area === area.value && row.nativePercent === percent.value && row.areaPrecision === area.precision && row.percentPrecision === percent.precision
        && area.value >= 0 && percent.value >= 0 && percent.value <= 100, '原生接触面积或百分比与其打印数值不一致。');
      const ratioPrecision = 100 * (area.precision / total.value + area.value * total.precision / (total.value * (total.value - total.precision)));
      requireValue(close(percent.value, 100 * area.value / total.value, percent.precision + ratioPrecision), '接触百分比与固定总面积分母不一致。');
      const key = merged ? [row.insideElement, row.outsideElement].sort().join(':') : [row.insideElement, row.outsideElement].join(':');
      requireValue(!keys.has(key), '原生接触表出现重复元素对。'); keys.add(key);
      sum += area.value; sumPrecision += area.precision;
      const mergedKey = [row.insideElement, row.outsideElement].sort().join(':');
      if (!merged) {
        const group = directed.get(mergedKey) ?? { area: 0, areaPrecision: 0, percent: 0, percentPrecision: 0 };
        group.area += area.value; group.areaPrecision += area.precision; group.percent += percent.value; group.percentPrecision += percent.precision;
        directed.set(mergedKey, group);
      } else {
        const group = directed.get(mergedKey);
        requireValue(group && close(area.value, group.area, area.precision + group.areaPrecision)
          && close(percent.value, group.percent, percent.precision + group.percentPrecision), '合并接触不等于相反有向接触之和。');
      }
    }
    requireValue(close(sum, total.value, sumPrecision), '接触面积未覆盖完整HS表面。');
    if (merged) requireValue(keys.size === directed.size, '有向与合并接触元素对集合不一致。');
  }
}

export function validateHirshfeldAnalysisResult(result: HirshfeldAnalysisResult, expected?: HirshfeldAnalyzeRequest): void {
  const info = result.sessionInfo, resources = info?.resources;
  requireValue(info?.family === 'hirshfeld' && nonempty(info.sessionId) && sameSurfaceContext(info.context, result.stamp)
    && info.atomCount === result.source.atoms.length && ['open-grant', 'analysis-grant'].includes(info.resourceSnapshot), 'HS缺少匹配来源的宿主资源快照。');
  requireValue(resources && ['threads', 'memoryBudgetBytes', 'configuredMemoryBudgetBytes', 'totalPhysicalMemoryBytes', 'logicalCpuCount'].every(key => {
    const value = resources[key as keyof typeof resources]; return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }) && Number.isSafeInteger(resources.sharedReservedBytes) && resources.sharedReservedBytes >= 0
    && resources.memoryBudgetBytes + resources.sharedReservedBytes === resources.configuredMemoryBudgetBytes
    && ['settings', 'logical-cpus', 'request'].includes(resources.threadSource) && ['physical-ram', 'request'].includes(resources.memorySource)
    && resources.configured === true && resources.memoryIsBudget === true && resources.retainedOtherSettings === true
    && typeof resources.settingsPresent === 'boolean' && /^[a-f0-9]{64}$/.test(resources.settingsRevision), 'HS配置上限、共享扣减或可用预算记录无效。');
  requireValue(result.schema === 'sciyue-hirshfeld-native/v1' && result.kind === 'hirshfeld' && result.surface.available === true
    && result.surface.representation === 'native-weight-grid' && nonempty(result.surface.sampleRelationship), '结果缺少真正HS表面网格。');
  const stamp = result.stamp;
  requireValue(nonempty(stamp.requestId) && nonempty(stamp.analysisId) && result.source.sourceId === stamp.sourceId && result.source.sourceRevision === stamp.sourceRevision,
    'HS结果缺少对应科学来源与分析身份。');
  validateHirshfeldCluster(result.source, result.source);
  requireValue(result.definition.function === 'hirshfeld-weight' && result.definition.isovalue === .5 && result.definition.mapping === 'dnorm'
    && result.definition.mappingUnit === 'dimensionless' && nonempty(result.definition.atomicDensity) && nonempty(result.definition.vdwRadii)
    && result.quantitativeGrid.mode === 'spacing' && Number.isFinite(result.quantitativeGrid.spacingBohr) && result.quantitativeGrid.spacingBohr > 0, 'HS定义或定量格距不明确。');
  const validation = validateHirshfeldFieldPair(result.pair); requireValue(validation.compatible, validation.reasons.join('；'));
  requireValue(sameSurfaceContext(result.pair.shape.context, stamp), 'Hirshfeld格点与定量结果身份不同。');
  const factor = result.pair.shape.grid.coordinateUnit === 'bohr' ? .529177210903 : 1;
  requireValue(result.pair.shape.atoms.length === result.source.atoms.length && result.pair.shape.atoms.every((atom, i) => {
    const expectedAtom = result.source.atoms[i];
    return ELEMENTS[atom.atomicNumber - 1] === expectedAtom.element && atom.position.every((value, axis) => close(value * factor, expectedAtom.position[axis],
      result.pair.shape.precision.atomCoordinates[i][axis] * factor + (expectedAtom.coordinatePrecisionAngstrom ?? 0)));
  }), 'HS原生Cube没有保留完整源团簇的逐序元素和几何。');
  const open = result.mode === 'open-preview';
  requireValue(result.mode === undefined || ['closed', 'open-preview'].includes(result.mode), 'HS结果模式无效。');
  if (open) requireValue(result.contacts === null && result.quantitativeSummary === null && result.fingerprint.scope === 'current-range', '开放预览不能声明完整表面面积、体积或总面积分母。');
  else {
  requireValue(result.contacts && result.quantitativeSummary && result.pair.topology !== 'open', '完整HS结果缺少原生定量库存或包含开放网格。');
  validateHirshfeldContacts(result.contacts);
  const summary = result.quantitativeSummary, total = printed(summary.totalAreaRaw);
  requireValue(summary.totalArea === total.value && summary.totalAreaPrecision === total.precision && summary.totalArea === result.contacts.denominator.area
    && [summary.vertexCount, summary.edgeCount, summary.triangleCount].every(n => Number.isSafeInteger(n) && n > 0)
    && summary.vertexCount === result.vertices.length, 'HS定量表面库存或总面积不一致。');
  }
  requireValue(result.fingerprint.method === 'native-surface-vertex-samples' && result.fingerprint.areaWeighted === false
    && result.fingerprint.coordinateUnit === 'angstrom' && nonempty(result.fingerprint.correspondence), '指纹顶点采样不能冒面积权重。');
  const target = new Set(result.source.targetAtomIndices), environment = new Set(result.source.environmentAtomIndices), serials = new Set<number>();
  const insideElements = new Set([...target].map(index => result.source.atoms[index - 1].element)), outsideElements = new Set([...environment].map(index => result.source.atoms[index - 1].element));
  requireValue((result.contacts?.directedRows ?? []).every(row => insideElements.has(row.insideElement) && outsideElements.has(row.outsideElement)), '接触有向元素不属于对应目标或环境集合。');
  result.vertices.forEach((vertex, index) => {
    requireValue(vertex.index === index && Number.isSafeInteger(vertex.nativeSerial) && vertex.nativeSerial > 0 && (!serials.has(vertex.nativeSerial) || vertex.nativeSerial === 99999)
      && finiteVector(vertex.position) && finiteVector(vertex.coordinatePrecisionAngstrom) && vertex.coordinatePrecisionAngstrom.every(n => n >= 0)
      && [vertex.dnorm, vertex.di, vertex.de].every(Number.isFinite) && vertex.di >= 0 && vertex.de >= 0
      && printed(vertex.dnormRaw).value === vertex.dnorm && vertex.dnormUnit === 'dimensionless' && vertex.distanceUnit === 'angstrom'
      && finiteVector(vertex.distancePrecisionAngstrom, 2) && vertex.distancePrecisionAngstrom.every(n => n >= 0), '指纹顶点数值、顺序、距离或精度无效。');
    serials.add(vertex.nativeSerial);
    for (const [indices, ids, allowed] of [[vertex.insideAtomIndices, vertex.insideAtomIds, target], [vertex.outsideAtomIndices, vertex.outsideAtomIds, environment]] as const) {
      requireValue(indices.length > 0 && indices.length === ids.length && new Set(indices).size === indices.length
        && indices.every((n, i) => allowed.has(n) && result.source.atoms[n - 1]?.stableId === ids[i]), '指纹内外最近原子身份与源集合不符。');
    }
  });
  const provenance = result.provenance;
  requireValue(provenance.backend.name === 'Multiwfn' && nonempty(provenance.backend.version) && provenance.sourceIds.includes(stamp.sourceId)
    && provenance.parameters.definition === 'hirshfeld-weight' && provenance.parameters.isovalue === .5 && provenance.parameters.mapping === 'dnorm'
    && provenance.parameters.spacingBohr === result.quantitativeGrid.spacingBohr, 'HS原生定义或后端来源记录不一致。');
  for (const [key, selection] of [['targetAtomIndices', target], ['environmentAtomIndices', environment]] as const) {
    const recorded = provenance.parameters[key];
    requireValue(Array.isArray(recorded) && recorded.length === selection.size && recorded.every(n => typeof n === 'number' && selection.has(n)), 'HS原生参数记录与本次目标或环境集合不一致。');
  }
  requireValue(!open || result.fingerprint.samplesAvailable === (result.vertices.length > 0), '开放指纹可用状态与原生样本不符。');
  for (const role of ['cluster-source', 'native-output', 'native-menu', 'effective-settings', ...(!open || result.vertices.length ? ['surface-vertices', 'fingerprint-distances'] : [])]) {
    requireValue(provenance.rawArtifacts.some(artifact => artifact.role === role && nonempty(artifact.name) && nonempty(artifact.revision)), 'HS原生几何、菜单、设置或指纹产物记录缺失。');
  }
  for (const [field, role] of [[result.pair.shape, 'hirshfeld-weight-cube'], [result.pair.mapping, 'dnorm-cube']] as const) {
    requireValue(field.source.kind === 'generated-cube' && field.source.producer === 'multiwfn'
      && provenance.rawArtifacts.some(artifact => artifact.role === role && artifact.name === field.source.name && artifact.revision === field.source.revision), 'Hirshfeld格点缺少匹配原始Cube角色和内容修订。');
  }
  if (expected) requireValue(sameSurfaceStamp(stamp, expected.stamp) && expected.mapping === 'dnorm'
    && (expected.mode ?? 'closed') === (result.mode ?? 'closed')
    && expected.quantitativeGrid.mode === 'spacing' && expected.quantitativeGrid.spacingBohr === result.quantitativeGrid.spacingBohr
    && expected.targetAtomIndices.length === target.size && expected.targetAtomIndices.every(n => target.has(n))
    && expected.environmentAtomIndices.length === environment.size && expected.environmentAtomIndices.every(n => environment.has(n)), 'HS结果与本次请求的选择、定量格距或身份不符。');
}
