import type { TrajectoryResult } from '../../results/contracts';
import type { ExcitedState, ScientificData } from '../../results/scientific-contracts';
import type { StickPoint } from './ScientificStickPlot';
import { fullPrecisionValue } from '../../results/numeric-format';

export type ResultPanelId = 'summary' | 'geometry' | 'orbitals' | 'atoms' | 'vibrations' | 'thermo' | 'td' | 'stability' | 'bsse';
export interface ResultPanel { id: ResultPanelId; label: string }
/** One source-provenance decision shared by display groups, labels and derived admission. */
export const isNativeEstimatedMultiplicity=(state:Pick<ExcitedState,'multiplicityProvenance'>|null|undefined)=>state?.multiplicityProvenance==='native-estimated';
/** Printed labels define spin groups; missing multiplicity is never inferred. */
export function excitedStateGroups(states: readonly ExcitedState[]): { key: string; label: string; states: ExcitedState[] }[] {
  const groups = [
    { key: 'singlet', label: 'S · 单重态', states: [] as ExcitedState[] },
    { key: 'triplet', label: 'T · 三重态', states: [] as ExcitedState[] },
    { key: 'other', label: '其它或未确认自旋', states: [] as ExcitedState[] },
  ];
  for (const state of states) {
    const spin = state.multiplicity?.trim() ?? '';
    groups[isNativeEstimatedMultiplicity(state)?2:/^(singlet|1)$/i.test(spin) ? 0 : /^(triplet|3)$/i.test(spin) ? 1 : 2].states.push(state);
  }
  return groups.filter(group => group.states.length);
}
/** Capabilities select shared panels, independently of the originating engine. */
export function scientificPanels(result: Pick<TrajectoryResult, 'scientific' | 'frames'>): ResultPanel[] {
  const data = result.scientific;
  const panels: ResultPanel[] = [{ id: 'summary', label: '概览' }];
  if (result.frames.length > 1 || data?.scfCycles.length || result.frames.some(frame => frame.convergence.length)) panels.push({ id: 'geometry', label: '几何 / SCF' });
  if (data?.orbitals.length) panels.push({ id: 'orbitals', label: '轨道数值' });
  if (data?.atomicProperties.length) panels.push({ id: 'atoms', label: '原子性质' });
  if (data?.vibrations?.modes.length || data?.vibrationSets?.some(group => group.modes.length)) panels.push({ id: 'vibrations', label: '振动' });
  if (data?.thermochemistry.length) panels.push({ id: 'thermo', label: '热化学' });
  if (data?.excitedStates.length) panels.push({ id: 'td', label: '激发态' });
  if (data?.stability.length) panels.push({ id: 'stability', label: '稳定性' });
  if (data?.bsse.length) panels.push({ id: 'bsse', label: 'BSSE' });
  return panels;
}
export function preferredScientificPanel(data?: ScientificData): ResultPanelId {
  if ((data?.vibrations?.modes.length || data?.vibrationSets?.some(group => group.modes.length)) && data.tasks.includes('freq')) return 'vibrations';
  if (data?.tasks.some(task => ['opt', 'ts', 'irc', 'scan'].includes(task))) return 'geometry';
  if (data?.excitedStates.length && data.tasks.includes('td')) return 'td';
  return 'summary';
}
/** First entry targets only the default frequency group's confirmed source geometry. */
export function initialScientificFrame(result: Pick<TrajectoryResult, 'scientific' | 'frames'>): number | null {
  if (preferredScientificPanel(result.scientific) !== 'vibrations') return null;
  const data = result.scientific;
  const group = data?.vibrationSets?.length ? data.vibrationSets[data.vibrationSets.length - 1] : data?.vibrations;
  const index = group?.frameIndex;
  return index != null && Number.isSafeInteger(index) && index >= 0 && index < result.frames.length ? index : null;
}
export function frameBindingLabel(frameIndex: number | null | undefined): string {
  return frameIndex == null ? '结构归属未确认' : `绑定帧 ${frameIndex + 1}`;
}
export function scientificDisplayValue(value: number | string | null | undefined): string {
  return fullPrecisionValue(value);
}
export function vibrationStickSpectra(modes: NonNullable<ScientificData['vibrations']>['modes'], kind: 'ir' | 'raman', frequencyScale = 1): { unit: string; points: StickPoint[] }[] {
  if (!Number.isFinite(frequencyScale) || frequencyScale <= 0) throw new Error('附加频率显示缩放必须为正有限数。');
  const grouped = new Map<string, StickPoint[]>();
  for (const mode of modes) {
    const intensity = kind === 'ir' ? mode.irIntensity : mode.ramanActivity;
    const unit = (kind === 'ir' ? mode.irIntensityUnit : mode.ramanActivityUnit) ?? '单位未确认';
    if (intensity == null || !Number.isFinite(intensity) || !Number.isFinite(mode.frequency) || mode.frequency < 0) continue;
    const rows = grouped.get(unit) ?? []; rows.push({ x: mode.frequency * frequencyScale, rawX: mode.frequency, y: intensity, label: `模式 ${mode.index}`, sourceLine: mode.sourceLine }); grouped.set(unit, rows);
  }
  return Array.from(grouped, ([unit, points]) => ({ unit, points }));
}
/** Each cycle is independent; missing observations explicitly split the path. */
export function scfPlot(cycle: ScientificData['scfCycles'][number]) {
  let low = Infinity, high = -Infinity;
  for (const point of cycle.points) if (point.energy != null && Number.isFinite(point.energy)) { low = Math.min(low, point.energy); high = Math.max(high, point.energy); }
  if (!Number.isFinite(low)) return null;
  const padding = (high - low) * .1 || 1e-6; low -= padding; high += padding;
  let minIteration = Infinity, maxIteration = -Infinity;
  for (const point of cycle.points) { minIteration = Math.min(minIteration, point.iteration); maxIteration = Math.max(maxIteration, point.iteration); }
  const x = (iteration: number) => 45 + (iteration - minIteration) / Math.max(1, maxIteration - minIteration) * 270;
  const y = (energy: number) => 140 - (energy - low) / (high - low) * 110;
  const paths: string[] = []; let path = '';
  const points: typeof cycle.points = [];
  const width = Math.ceil(cycle.points.length / 300);
  for (let start = 0; start < cycle.points.length; start += width) {
    const end = Math.min(cycle.points.length, start + width) - 1;
    let min = start, max = start, gap = -1;
    for (let index = start; index <= end; index++) {
      const value = cycle.points[index].energy;
      if (value == null || !Number.isFinite(value)) { if (gap < 0) gap = index; }
      else { if (cycle.points[min].energy == null || value < cycle.points[min].energy!) min = index; if (cycle.points[max].energy == null || value > cycle.points[max].energy!) max = index; }
    }
    const indices = gap < 0 ? [start, min, max, end] : [start, gap, end];
    for (const index of [...new Set(indices)].sort((a,b) => a - b)) points.push(cycle.points[index]);
  }
  for (const point of points) {
    if (point.energy == null || !Number.isFinite(point.energy)) { if (path) paths.push(path); path = ''; }
    else path += `${path ? ' L' : 'M'}${x(point.iteration)},${y(point.energy)}`;
  }
  if (path) paths.push(path);
  return { low, high, paths, x, y, points };
}
