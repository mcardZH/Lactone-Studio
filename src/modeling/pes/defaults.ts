import { PES_EXECUTION_PROFILE, type PesAxis, type PesCard, type PesCardKind, type PesEventDraft, type PesExpressionDraft, type PesMethodDraft, type PesParameters, type PesTsDraft, type PesConvergencePreset, type PesSellaCoordinateSystem } from './contracts';

export function pesId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }

export const PES_CARD_LABELS = { scan: '内坐标扫描', path: '两端链接', explore: '单端反应探索' } satisfies Record<PesCardKind, string>;
export const PES_ALGORITHMS = {
  scan: { 'sella-scan': 'Sella', 'lbfgs-scan': 'L-BFGS', 'fire2-scan': 'FIRE2' },
  path: { 'ci-neb': 'CI-NEB', 'de-gsm': '双端GSM', fsm: 'FSM' },
  explore: { 'se-gsm': 'SE-GSM', afir: 'AFIR' },
  ts: { prfo: 'RS-P-RFO', rfo: 'RFO 鞍点步', qn: '最低模跟随＋准牛顿步', dimer: 'Improved Dimer', climb: '指定内坐标爬坡' },
};

export interface PesParameterField {
  key: string;
  label: string;
  initial: string | boolean;
  unit?: string;
  integer?: boolean;
  minimum?: number;
  options?: Readonly<Record<string, string>>;
  optional?: boolean;
  exclusiveMinimum?: boolean;
}
export interface PesParameterSection { title?: string; fields: PesParameterField[] }
export const OPT_CONVERGENCE_PRESETS = {
  loose: { energyDifferenceHartree: 5e-5, gradientNormHartreePerBohr: 4e-3 },
  medium: { energyDifferenceHartree: 5e-6, gradientNormHartreePerBohr: 1e-3 },
  tight: { energyDifferenceHartree: 1e-6, gradientNormHartreePerBohr: 8e-4 },
} as const;
export const SELLA_CONVERGENCE_PRESETS = {
  loose: { fmaxHartreePerBohr: '0.002500' },
  medium: { fmaxHartreePerBohr: '0.000450' },
  tight: { fmaxHartreePerBohr: '0.000015' },
} as const;
export const NEB_CONVERGENCE_PRESETS = {
  loose: { ciMaxForce: '0.002', ciRmsForce: '0.001', nebMaxForce: '0.020', nebRmsForce: '0.010' },
  medium: { ciMaxForce: '0.0005', ciRmsForce: '0.00025', nebMaxForce: '0.005', nebRmsForce: '0.0025' },
  tight: { ciMaxForce: '0.0001', ciRmsForce: '0.00005', nebMaxForce: '0.001', nebRmsForce: '0.0005' },
} as const;
export const GSM_CONVERGENCE_PRESETS = {
  loose: { gsmMaxGradient: '0.002', gsmRmsGradient: '0.001' },
  medium: { gsmMaxGradient: '0.001', gsmRmsGradient: '0.0005' },
  tight: { gsmMaxGradient: '0.0005', gsmRmsGradient: '0.00025' },
} as const;
export const PES_CONVERGENCE_OPTIONS = { loose: 'Loose', medium: 'Normal', tight: 'Tight', custom: '自定义' } as const;
export function projectedForcePreset(values: PesParameters, fallback: PesConvergencePreset): PesConvergencePreset {
  const selected = values.convergencePreset;
  if (typeof selected === 'string' && Object.hasOwn(PES_CONVERGENCE_OPTIONS, selected)) return selected as PesConvergencePreset;
  return values.maxForceHartreePerBohr !== undefined ? 'custom' : fallback;
}
export const isPesScanOptimizer = (algorithm: string) => Object.hasOwn(PES_ALGORITHMS.scan, algorithm);
export const PES_DEFAULT_SCAN_ALGORITHM = 'lbfgs-scan';
export const PES_CI_NEB_MINIMUM_BEADS = 3;
export const PES_DEFAULT_HESSIAN_STEP_BOHR = .002;
export const PES_IRC_NUMBER_FIELDS = {
  stepMassAngstrom: { initial: .10, label: '路径步长', unit: 'Å·√amu', exclusiveMinimum: 0 },
  maxSteps: { initial: 50, label: '每向最大步数', integer: true, minimum: 1 },
  endpointForce: { initial: .05, label: '端点力', unit: 'eV/Å', exclusiveMinimum: 0 },
  correctorForce: { initial: .01, label: '点内校正力', unit: 'eV/Å', exclusiveMinimum: 0 },
  recalcInterval: { initial: 0, label: 'Hessian 重算间隔', unit: '有效路径点', integer: true, minimum: 0 },
} as const;
export function effectivePesScanAlgorithm(algorithm: string, periodic: boolean): string {
  if (periodic && algorithm !== 'fire2-scan') return 'lbfgs-scan';
  return isPesScanOptimizer(algorithm) ? algorithm : 'sella-scan';
}
export const isSellaTsAlgorithm = (algorithm: string) => ['prfo', 'rfo', 'qn'].includes(algorithm);
const number = (key: string, label: string, initial: number | '', unit?: string, integer = false, minimum = 0): PesParameterField =>
  ({ key, label, initial: String(initial), unit, integer, minimum, optional: initial === '' });
const positive = (key: string, label: string, initial: number | '', unit?: string): PesParameterField =>
  ({ ...number(key, label, initial, unit), exclusiveMinimum: true });
const count = (key: string, label: string, initial: number | '', minimum = 1) => number(key, label, initial, undefined, true, minimum);
const toggle = (key: string, label: string, initial: boolean): PesParameterField => ({ key, label, initial });
const select = (key: string, label: string, initial: string, options: Record<string, string>): PesParameterField => ({ key, label, initial, options });
const pathAdvanced: PesParameterField[] = [
  count('sidppIterations', 'S-IDPP最大几何初始化迭代', 7000),
  positive('sidppGrowthTolerance', 'S-IDPP生长阈值', .01, '原生单位'),
  positive('sidppFinalTolerance', 'S-IDPP最终整理阈值', .01, '原生单位'),
  toggle('sidppReparameterize', '加入全部节点后重分布', true),
];
const pathBase = { fields: [count('beads', '总珠子数（含两端）', 12, 2)] };
const pathRecordedBase = { fields: [count('beads', '总珠子数（含两端）', 12, 2), count('recordInterval', '记录间隔（每 N 轮）', 5)] };
const ciNebBase = { fields: [count('beads', '总珠子数（含两端）', 12, PES_CI_NEB_MINIMUM_BEADS), count('recordInterval', '记录间隔（每 N 轮）', 5)] };
const fsmLocalFields = [count('fsmNodeSteps', '每个新节点优化步数', 2),
  count('fsmLineSearchSteps', '每步最大回溯次数', 3), positive('fsmBoxAngstrom', '节点局部坐标框半宽', .3, 'Å')];
const optimizeTs: PesParameterSection[] = [
  { title: '优化设置', fields: [count('maxSteps', '最大优化步数', 200), positive('maxStepAngstrom', '每步最大原子位移', .1, 'Å')] },
  { title: '收敛标准 · Gaussian 默认', fields: [positive('maxForceHartreePerBohr', '最大力', .00045, 'Eh/Bohr'), positive('rmsForceHartreePerBohr', 'RMS 力', .0003, 'Eh/Bohr'),
    positive('maxDisplacementBohr', '最大位移', .0018, 'Bohr'), positive('rmsDisplacementBohr', 'RMS 位移', .0012, 'Bohr')] },
  { title: '电子结构设置', fields: [count('maxSccIterations', 'SCC迭代上限', 250)] },
];
const sellaTs = [{ fields: [select('hessianStrategy', 'Hessian策略', 'calcfc', { auto: '自动／迭代估计', calcfc: 'CalcFC', recalcfc: 'RecalcFC=N' }), count('recalcInterval', '重算间隔（正式优化步）', 5)] }, ...optimizeTs];
const aseTs = [{ fields: [select('hessianStrategy', 'Hessian策略', 'auto', { auto: '自动／迭代估计' })] }, ...optimizeTs];
const orientation = { current: '使用当前摆放构型', random: '自动生成相对取向' };

export const LEGACY_PES_PARAMETERS: Record<string, PesParameterSection[]> = {
  slsqp: [{ title: '每点优化设置', fields: [count('maxSteps', '每点最大优化步数', 200), positive('maxForceHartreePerBohr', '最大投影力阈值', .00045, 'Eh/Bohr'),
    positive('rmsForceHartreePerBohr', 'RMS投影力阈值', .0003, 'Eh/Bohr')] }],
  'ci-neb': [ciNebBase, { title: '路径优化设置 · FIRE', fields: [count('nebIterations', '最大路径迭代（含爬坡）', 1000),
    positive('nebMaxForce', '普通NEB最大垂直力', .001, 'Eh/Bohr'), positive('nebRmsForce', '普通NEB RMS垂直力', .0005, 'Eh/Bohr'),
    positive('ciMaxForce', 'CI最大力', .0005, 'Eh/Bohr'), positive('ciRmsForce', 'CI RMS力', .00025, 'Eh/Bohr'),
    positive('ciToleranceScale', 'CI阶段普通节点容差倍率', 10), positive('ciTriggerForce', '启用CI的最大力阈值', .2, 'Eh/Bohr')] },
  { title: '高级设置', fields: [positive('springConstantEvAngstrom2', '固定弹簧常数', .1, 'eV/Å²'), positive('nebComponentStepAngstrom', '最大笛卡尔分量位移', .1, 'Å'), ...pathAdvanced] }],
  'de-gsm': [pathRecordedBase, { title: '路径优化设置', fields: [count('gsmGrowthRounds', '最大生长轮数', 50), count('gsmOptimizationRounds', '最大整弦优化轮数', 50),
    count('gsmNodeSteps', '每节点每轮优化步数', 3), positive('gsmRmsGradient', '节点梯度RMS阈值', .0005, '原生单位'),
    positive('gsmMaxGradient', '节点最大梯度阈值', .001, '原生单位')] },
  { title: '高级设置', fields: [positive('gsmAddNodeTolerance', '新节点加入阈值', .1, '原生单位'), toggle('gsmClimb', '路径爬坡', true), positive('gsmDmax', '初始DMAX', .1, '原生单位'), ...pathAdvanced] }],
  fsm: [pathBase, { title: '路径优化设置 · L-BFGS-B', fields: [count('fsmNodeSteps', '每个新节点优化步数', 2)] },
    { title: '高级设置', fields: [count('fsmLineSearchSteps', '每步最大回溯次数', 3), positive('fsmBoxAngstrom', '节点局部坐标框半宽', .3, 'Å'), ...pathAdvanced] }],
  'se-gsm': [{ fields: [count('nodes', '节点容量（含反应物）', 20, 2), count('recordInterval', '记录间隔（每 N 轮）', 5)] }, { title: '路径与优化设置', fields: [count('growthIterations', '生长轮数', 50),
    count('optimizationIterations', '整弦优化轮数', 50), count('growthStepsPerNode', '生长期每轮每节点步数', 10),
    count('optimizationStepsPerNode', '整弦期每轮每节点步数', 3), count('endpointSteps', '末节点局部优化步数', 100)] }],
  afir: [{ fields: [select('initialOrientation', '初始构型', 'current', orientation), count('orientationCount', '初始取向数', 10), count('seed', '随机种子（空值自动）', '', 0),
    positive('gammaKjMol', 'γ', 200, 'kJ/mol'), select('direction', '人工力方向', 'attract', { attract: '吸引', repel: '排斥' })] },
    { title: '路径与优化设置', fields: [select('mode', '组分模式', 'auto', { auto: '按片段自动', sc: 'SC 单组分', mc: 'MC 多组分' }),
      select('gammaMode', 'γ模式', 'fixed', { fixed: '固定值', schedule: '分级上限' }), count('gammaLevels', 'γ级数', 1),
      count('maxSteps', '每次人工力局部优化步数', 125), count('maxTrials', '试探路径数上限（可选）', '')] }],
  prfo: sellaTs, rfo: sellaTs, qn: sellaTs, dimer: aseTs, climb: aseTs,
};

const projectedForce = positive('fmaxHartreePerBohr', '最大投影力阈值', .00045, 'Eh/Bohr');
const pointOptimization = [{ title: '每点优化设置', fields: [count('maxSteps', '每点最大优化步数', 500), { ...projectedForce, initial: SELLA_CONVERGENCE_PRESETS.loose.fmaxHartreePerBohr }] }];
const tsConvergence = { title: '收敛设置', fields: [projectedForce] };
const nativeTsOptimization = { ...optimizeTs[0], fields: [count('maxSteps', '最大优化步数', 500), optimizeTs[0].fields[1]] };
const nativeSellaTs = [sellaTs[0], nativeTsOptimization, tsConvergence, optimizeTs[2]];
const nativeAseTs = [aseTs[0], nativeTsOptimization, tsConvergence, optimizeTs[2]];
export const PES_PARAMETERS: Record<string, PesParameterSection[]> = {
  ...LEGACY_PES_PARAMETERS,
  'sella-scan': pointOptimization, 'lbfgs-scan': pointOptimization, 'fire2-scan': pointOptimization,
  'ci-neb': [{ fields: [count('beads', '总珠子数（含两端）', 24, PES_CI_NEB_MINIMUM_BEADS), count('recordInterval', '记录间隔（每 N 轮）', 10)] },
    { title: '路径优化设置', fields: [count('nebIterations', '最大路径迭代（含爬坡）', 1000),
    positive('ciMaxForce', '攀爬珠子最大力', .002, 'Eh/Bohr'), positive('ciRmsForce', '攀爬珠子RMS力', .001, 'Eh/Bohr'),
    positive('nebMaxForce', '普通珠子最大垂直力', .020, 'Eh/Bohr'), positive('nebRmsForce', '普通珠子RMS垂直力', .010, 'Eh/Bohr'),
    positive('ciTriggerForce', '启用CI的最大垂直力', .2, 'Eh/Bohr')] },
    { title: 'FSM 初始路径', fields: fsmLocalFields }, LEGACY_PES_PARAMETERS['ci-neb'][2]],
  'de-gsm': [pathRecordedBase, ...LEGACY_PES_PARAMETERS['de-gsm'].slice(1)],
  fsm: [{ fields: [count('beads', '总珠子数（含两端）', 12, 2), count('recordInterval', '记录间隔（每 N 轮）', 10)] }, ...LEGACY_PES_PARAMETERS.fsm.slice(1)],
  prfo: nativeSellaTs, rfo: nativeSellaTs, qn: nativeSellaTs, dimer: nativeAseTs, climb: nativeAseTs,
};

export const usesPesExecutionProfile = (values: PesParameters) => values.executionProfile === PES_EXECUTION_PROFILE;
/** New cards store their choices explicitly. Missing values on older drafts
 * retain the original initializer, optimizer and execution profile. */
export function effectivePesPathParameters(algorithm: string, values: PesParameters): PesParameters {
  if (algorithm === 'ci-neb') return { pathInitializer: 'sidpp', beads: '12', recordInterval: '5', ...values,
    nebOptimizer: values.nebOptimizer ?? (usesPesExecutionProfile(values) ? 'fire2' : 'fire') };
  if (algorithm === 'fsm') return { fsmGrowth: 'sidpp', recordInterval: '5', ...values };
  return values;
}
export function pesParameterSections(algorithm: string, values: PesParameters): readonly PesParameterSection[] {
  const effective = effectivePesPathParameters(algorithm, values);
  const sections = ((usesPesExecutionProfile(effective) || isPesScanOptimizer(algorithm) ? PES_PARAMETERS : LEGACY_PES_PARAMETERS)[algorithm] ?? [])
    .filter(section => section.fields.some(field => parameterVisible(field.key, effective)));
  return ['ci-neb', 'fsm', 'de-gsm'].includes(algorithm)
    ? sections.map(section => section.title?.startsWith('路径优化设置') ? { ...section, title: '路径优化设置' } : section) : sections;
}
export function legacyDefaultParameters(algorithm: string): PesParameters {
  return Object.fromEntries((LEGACY_PES_PARAMETERS[algorithm] ?? []).flatMap(section => section.fields.map(field => [field.key, field.initial])));
}

export function defaultParameters(algorithm: string): PesParameters {
  const values: PesParameters = Object.fromEntries((PES_PARAMETERS[algorithm] ?? []).flatMap(section => section.fields.map(field => [field.key, field.initial])));
  if (Object.hasOwn(PES_ALGORITHMS.ts, algorithm)) Object.assign(values, { executionProfile: PES_EXECUTION_PROFILE, coordinateSystem: 'xyz', convergencePreset: 'medium', ...SELLA_CONVERGENCE_PRESETS.medium });
  if (isPesScanOptimizer(algorithm)) Object.assign(values, { executionProfile: PES_EXECUTION_PROFILE,
    coordinateSystem: algorithm === 'sella-scan' ? 'ric' : 'xyz', convergencePreset: 'loose', ...SELLA_CONVERGENCE_PRESETS.loose });
  if (algorithm === 'ci-neb') Object.assign(values, { executionProfile: PES_EXECUTION_PROFILE, coordinateSystem: 'xyz', nebOptimizer: 'lbfgs', nebConvergencePreset: 'loose', pathInitializer: 'fsm', ...NEB_CONVERGENCE_PRESETS.loose });
  if (algorithm === 'de-gsm') Object.assign(values, { executionProfile: PES_EXECUTION_PROFILE, gsmGrowth: 'native', gsmConvergencePreset: 'loose', ...GSM_CONVERGENCE_PRESETS.loose });
  // The profile also selects the validated GFN1/2 electronic provider for
  // non-Sella TS and per-node SE-GSM. Their geometry algorithms stay unchanged.
  if (['fsm', 'dimer', 'climb', 'se-gsm'].includes(algorithm)) Object.assign(values, { executionProfile: PES_EXECUTION_PROFILE });
  if (algorithm === 'fsm') Object.assign(values, { fsmGrowth: 'native' });
  if (['ci-neb', 'de-gsm', 'fsm'].includes(algorithm)) Object.assign(values, { pathSemantics: 'v223' });
  if (usesPesExecutionProfile(values)) Object.assign(values, { accuracy: '0.1', electronicTemperatureK: '300', maxSccIterations: values.maxSccIterations ?? '250' });
  return values;
}
/** Selecting a new native criterion is an explicit edit, never restore-time
 * migration. Custom starts with the actual visible threshold. */
export function sellaPresetParameters(algorithm: string, values: PesParameters, preset: PesConvergencePreset): PesParameters {
  const { maxForceHartreePerBohr, rmsForceHartreePerBohr: _rms, maxDisplacementBohr: _maxStep, rmsDisplacementBohr: _rmsStep, ...active } = values;
  const defaults = defaultParameters(algorithm);
  return { ...defaults, maxSteps: '200', ...active, executionProfile: PES_EXECUTION_PROFILE, convergencePreset: preset,
    ...(preset === 'custom' ? { fmaxHartreePerBohr: maxForceHartreePerBohr ?? active.fmaxHartreePerBohr ?? defaults.fmaxHartreePerBohr } : SELLA_CONVERGENCE_PRESETS[preset]) };
}
export function nebPresetParameters(values: PesParameters, preset: PesConvergencePreset): PesParameters {
  const { pathSemantics: _pathSemantics, ...defaults } = defaultParameters('ci-neb');
  return { ...defaults, ...effectivePesPathParameters('ci-neb', values), executionProfile: PES_EXECUTION_PROFILE, nebConvergencePreset: preset,
    ...(preset === 'custom' ? {} : NEB_CONVERGENCE_PRESETS[preset]) };
}
/** One explicit coordinate edit applies to the shared Sella choice. Historical
 * algorithms keep their actual force value when adopting the native criterion. */
export function withTsSellaCoordinates(draft: PesTsDraft, coordinateSystem: PesSellaCoordinateSystem): PesTsDraft {
  const parametersByAlgorithm = { ...draft.parametersByAlgorithm };
  for (const algorithm of ['prfo', 'rfo', 'qn']) {
    const values = parametersByAlgorithm[algorithm] ?? {};
    const preset = usesPesExecutionProfile(values) ? String(values.convergencePreset ?? 'custom') as PesConvergencePreset : 'custom';
    parametersByAlgorithm[algorithm] = { ...sellaPresetParameters(algorithm, values, preset), coordinateSystem };
  }
  return { ...draft, sellaCoordinateSystem: coordinateSystem, parametersByAlgorithm };
}
export const defaultPesMethod = (): PesMethodDraft => ({ method: 'gfn2', solvationModel: 'none', solvent: '' });
export const defaultPesExpression = (): PesExpressionDraft => ({ coordinates: [], expression: '' });
export const defaultPesEventDraft = (): PesEventDraft => ({ mode: 'manual', activityAtomIds: [], maxFormed: '1', maxBroken: '1', manual: [], automatic: [] });
const axis = (index: number): PesAxis => ({ id: pesId('axis'), name: index === 1 ? 'q' : `q${index}`, definition: defaultPesExpression(), lower: '', lowerMode: 'automatic', upper: '', points: '11' });
export function defaultPesCard(kind: PesCardKind, name: string): PesCard {
  const algorithms = Object.keys(PES_ALGORITHMS[kind]);
  return { id: pesId('card'), kind, name, algorithm: kind === 'scan' ? PES_DEFAULT_SCAN_ALGORITHM : algorithms[0], method: defaultPesMethod(), slots: {}, keys: [], dimension: 1,
    axes: [axis(1), axis(2)], parametersByAlgorithm: Object.fromEntries(algorithms.map(key => [key, defaultParameters(key)])),
    eventsByAlgorithm: kind === 'explore' ? { 'se-gsm': defaultPesEventDraft() } : {}, runIds: [], collapsed: false,
    ...(kind === 'scan' ? { scanCoordinates: [], scanCoordinateDrafts: [], scanCoordinateOrder: [], scanConvergencePreset: 'loose' as const } : {}) };
}
export function defaultPesTs(): PesTsDraft {
  return { algorithm: 'prfo', method: defaultPesMethod(), reaction: defaultPesExpression(),
    sellaCoordinateSystem: 'xyz', parametersByAlgorithm: Object.fromEntries(Object.keys(PES_ALGORITHMS.ts).map(key => [key, defaultParameters(key)])) };
}

export function parameterVisible(key: string, values: PesParameters): boolean {
  if (key.startsWith('sidpp') && usesPesExecutionProfile(values)) {
    if (values.pathInitializer !== undefined) return values.pathInitializer !== 'fsm';
    if (values.fsmGrowth !== undefined) return values.fsmGrowth !== 'native';
    if (values.gsmGrowth !== undefined) return values.gsmGrowth !== 'native';
  }
  if (key.startsWith('fsm') && values.pathInitializer !== undefined) return values.pathInitializer === 'fsm';
  if (key === 'recalcInterval') return values.hessianStrategy === 'recalcfc';
  if (key === 'orientationCount' || (key === 'seed' && 'initialOrientation' in values)) return values.initialOrientation === 'random';
  if (key === 'gammaLevels') return values.gammaMode === 'schedule';
  return true;
}
