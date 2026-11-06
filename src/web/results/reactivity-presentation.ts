import type { Structure } from '../../core/types';
import type { ReactivityAnalysisResult, ReactivityFrontierChannel, ReactivityFrontierOrbital, ReactivityMetricKey } from '../../results/reactivity-contracts';
import type { WavefunctionMetadata } from '../../results/orbital-contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import { formatResultValue } from '../../results/numeric-format';
import { analysisColor, analysisRange } from './analysis-display';
import type { ReactivityAnalysisControlsProps, ReactivityAtomDisplay, ReactivityAtomMetric } from './reactivity-controls-contracts';
import { scientificTableText, type ScientificTableProjection } from './scientific-table';

export const REACTIVITY_GLOBAL_CORE: readonly ReactivityMetricKey[] = ['ip', 'ea', 'chi', 'eta', 'softness', 'omega', 'NNu'];
export const REACTIVITY_GLOBAL_ALL: readonly ReactivityMetricKey[] = [...REACTIVITY_GLOBAL_CORE, 'homo', 'lumo', 'gap', 'mu'];
export const REACTIVITY_GLOBAL_LABELS: Record<ReactivityMetricKey, string> = {
  homo: '最高占据轨道能 εHOMO', lumo: '最低未占据轨道能 εLUMO', gap: '前线轨道能隙 GAP', ip: '垂直电离能 IP', ea: '电子亲和能 EA', chi: '电负性 χ', mu: '化学势 μ',
  eta: '硬度 η', softness: '软度 S', omega: '亲电指数 ω', NNu: '亲核指数 NNu',
};
export const REACTIVITY_ATOM_CORE: readonly ReactivityAtomMetric[] = ['fPlus', 'fMinus', 'fZero', 'dual'];
export const REACTIVITY_ATOM_ALL: readonly ReactivityAtomMetric[] = [...REACTIVITY_ATOM_CORE, 'omega', 'NNu', 'sPlus', 'sMinus', 'sZero'];
export const REACTIVITY_ATOM_LABELS: Record<ReactivityAtomMetric, string> = {
  fPlus: '福井函数 f⁺', fMinus: '福井函数 f⁻', fZero: '福井函数 f⁰', dual: '双描述符 Δf', omega: '局部亲电性 ω⁺', NNu: '局部亲核性 NNu⁻', sPlus: '局部软度 s⁺', sMinus: '局部软度 s⁻', sZero: '局部软度 s⁰',
};
export function reactivityMetricUnit(key: ReactivityAtomMetric): string {
  return key === 'omega' || key === 'NNu' ? 'eV' : key.startsWith('s') ? 'eV⁻¹' : '';
}
export function reactivityContextKey(context: SurfaceContext): string {
  return JSON.stringify([context.sourceId, context.sourceRevision, context.jobIndex, context.sourceFrameIndex, context.generation, context.documentId, context.documentRevision]);
}
export function reactivityGlobalTable(result: ReactivityAnalysisResult, decimals = 2, expanded = false): ScientificTableProjection {
  return { columns: [{ key: 'metric', label: '全局量' }, { key: 'value', label: '数值' }, { key: 'unit', label: '单位' }], rows: (expanded ? REACTIVITY_GLOBAL_ALL : REACTIVITY_GLOBAL_CORE).map(key => {
    const metric = result.globalMetrics[key];
    return { key, cells: [REACTIVITY_GLOBAL_LABELS[key], formatResultValue(metric?.value, decimals), metric?.unit === 'eV^-1' ? 'eV⁻¹' : metric?.unit ?? ''] };
  }) };
}
export function reactivityAtomTable(result: ReactivityAnalysisResult, decimals = 2, expanded = false): ScientificTableProjection {
  const keys = expanded ? REACTIVITY_ATOM_ALL : REACTIVITY_ATOM_CORE;
  return { columns: [{ key: 'atom', label: '原子' }, ...keys.map(key => ({ key, label: REACTIVITY_ATOM_LABELS[key] + (reactivityMetricUnit(key) ? ` / ${reactivityMetricUnit(key)}` : ''),heading:REACTIVITY_ATOM_LABELS[key],headerUnit:reactivityMetricUnit(key)||undefined }))],
    rows: [...result.atoms].sort((a, b) => a.sourceIndex - b.sourceIndex).map(row => ({ key: `atom:${row.sourceIndex}`, cells: [`${row.sourceIndex} ${row.element}`, ...keys.map(key => formatResultValue(row[key], decimals))] })) };
}
/** Full public tables retain all fields regardless of the screen disclosure. */
export function reactivityText(result: ReactivityAnalysisResult, decimals = 2, globalDecimals = decimals): string {
  const reasons = REACTIVITY_GLOBAL_ALL.filter(key => result.globalMetrics[key]?.value == null && result.globalMetrics[key]?.reason)
    .map(key => `${REACTIVITY_GLOBAL_LABELS[key]}：${result.globalMetrics[key].reason}`);
  return `FMO 反应性 · 冻结轨道近似 · Hirshfeld 分区\n${scientificTableText(reactivityGlobalTable(result, globalDecimals, true))}\n${scientificTableText(reactivityAtomTable(result, decimals, true))}`
    + (reasons.length || result.notices.length ? `\n${[...reasons, ...result.notices].join('\n')}\n` : '');
}
export function reactivityFrontierRows(frontier: readonly ReactivityFrontierChannel[]) {
  return frontier.flatMap(channel => (['homo', 'lumo'] as const).flatMap(role => {
    const orbital = channel[role];
    return orbital ? [{ orbital, role, label: `${channel.spin === 'restricted' ? '' : channel.spin === 'alpha' ? 'α ' : 'β '}${role.toUpperCase()} · ${orbital.sourceIndex}` }] : [];
  }));
}
/** A native field key must identify the actual saved wavefunction coefficients. */
export function reactivityNativeOrbitalKey(orbital: ReactivityFrontierOrbital | null | undefined, metadata: WavefunctionMetadata | null | undefined): string | null {
  if (!orbital || !metadata) return null;
  const matches = metadata.orbitals.filter(row => row.key === orbital.key && row.spin === orbital.spin && row.sourceIndex === orbital.sourceIndex && row.ordinal === orbital.ordinal);
  return matches.length === 1 ? matches[0].key : null;
}
export function reactivityAtomDisplay(result: ReactivityAnalysisResult | null, metric: ReactivityAtomMetric, order: ReactivityAnalysisControlsProps['sourceAtomOrder'], structure: Structure, decimals = 2): ReactivityAtomDisplay[] {
  if (!result) return [];
  const bySource = new Map(order.map(row => [row.sourceIndex, row.atomId])), elements = new Map(structure.atoms.map(atom => [atom.id, atom.element]));
  if (bySource.size !== order.length || new Set(order.map(row => row.atomId)).size !== order.length || order.some(row => !Number.isSafeInteger(row.sourceIndex) || row.sourceIndex < 1)) return [];
  const rows = result.atoms.flatMap(row => {
    const atomId = bySource.get(row.sourceIndex), value = row[metric], unit = reactivityMetricUnit(metric);
    if (!atomId || elements.get(atomId) !== row.element || value === null || !Number.isFinite(value)) return [];
    return [{ atomId, value, label: `${row.sourceIndex} ${row.element} · FMO ${REACTIVITY_ATOM_LABELS[metric]}=${formatResultValue(value, decimals)}${unit ? ` ${unit}` : ''}` }];
  });
  const range = analysisRange(rows.map(row => row.value), { color: true, labels: false, spin: false }, metric === 'dual');
  return range ? rows.map(row => ({ ...row, color: analysisColor(row.value, range) })) : rows;
}
