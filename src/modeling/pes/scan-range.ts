import type { PesAxis } from './contracts';
import { numberDraft } from './request';

export type ScanRangeField = 'lower' | 'upper' | 'points' | 'step';
export const scanRangeNumber = (raw: string): number | undefined => {
  try { return numberDraft(raw, '扫描范围'); } catch { return undefined; }
};

/** Point counts include both endpoints; the step is always a magnitude. */
export function scanRangeStep(start: number, end: number, points: number): number | undefined {
  if (![start, end].every(Number.isFinite) || !Number.isSafeInteger(points) || points < 2) return undefined;
  return Math.abs(end - start) / (points - 1);
}

export function scanPointsForStep(start: number, end: number, step: number): number | undefined {
  if (![start, end, step].every(Number.isFinite) || step <= 0 || start === end) return undefined;
  const intervals = Math.max(1, Math.round(Math.abs(end - start) / step));
  return Number.isSafeInteger(intervals + 1) ? intervals + 1 : undefined;
}

export function scanRangeValues(axis: PesAxis, automaticStart?: number) {
  const automatic = axis.lowerMode === 'automatic' || axis.lowerMode === undefined && !axis.lower;
  const start = automatic ? automaticStart : scanRangeNumber(axis.lower), end = scanRangeNumber(axis.upper);
  const points = scanRangeNumber(axis.points);
  const actualStep = start === undefined || end === undefined || points === undefined ? undefined : scanRangeStep(start, end, points);
  return { start, end, points, actualStep };
}

/** Preserve invalid drafts and the last usable dependent value until editing is valid. */
export function editScanRange(axis: PesAxis, field: ScanRangeField, text: string, automaticStart?: number): PesAxis {
  const next: PesAxis = { ...axis, [field]: text,
    ...(field === 'lower' ? { lowerMode: 'manual' as const } : {}),
    ...((field === 'points' || field === 'step') ? { rangeDriver: field } : {}) };
  const { start, end, actualStep } = scanRangeValues(next, automaticStart);
  if (next.rangeDriver === 'step') {
    const step = scanRangeNumber(next.step ?? '');
    const points = start === undefined || end === undefined || step === undefined ? undefined : scanPointsForStep(start, end, step);
    if (points !== undefined) next.points = String(points);
  } else if (actualStep !== undefined) next.step = String(actualStep);
  return next;
}

export function settleScanStep(axis: PesAxis, automaticStart?: number): PesAxis {
  const entered = scanRangeNumber(axis.step ?? '');
  if (axis.rangeDriver !== 'step' || entered === undefined || entered <= 0) return axis;
  const { actualStep } = scanRangeValues(axis, automaticStart);
  return actualStep === undefined ? axis : { ...axis, step: String(actualStep) };
}
