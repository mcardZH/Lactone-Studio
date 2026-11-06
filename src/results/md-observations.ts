import { convertEnergy } from './energy';
import { scientificRoundingInterval, type MdQuantityObservation, type MdSourceDifference, type MdStepObservation } from './scientific-contracts';

export const mdQuantityKeys = ['time', 'potentialEnergy', 'kineticEnergy', 'totalEnergy', 'temperature', 'scfIterations'] as const;
type Source = { id: string; name: string };
export function bindMdStepSources(rows: readonly MdStepObservation[] | undefined, source: Source, jobIndex?: number): void {
  for (const row of rows ?? []) {
    row.sourceId ??= source.id;
    if (!row.sourceName && row.sourceId === source.id) row.sourceName = source.name;
    if (row.jobIndex === null && row.sourceId === source.id && jobIndex !== undefined) row.jobIndex = jobIndex;
    for (const key of mdQuantityKeys) {
      const value = row[key]; if (!value) continue;
      value.sourceId ??= row.sourceId;
      if (!value.sourceName && value.sourceId === row.sourceId) value.sourceName = row.sourceName;
      if (value.unitEvidence) {
        value.unitEvidence.sourceId ??= value.sourceId;
        if (!value.unitEvidence.sourceName && value.unitEvidence.sourceId === value.sourceId) value.unitEvidence.sourceName = value.sourceName;
      }
    }
  }
}
export function copyMdSteps(rows: readonly MdStepObservation[] | undefined, source: Source): MdStepObservation[] {
  const copy = structuredClone(rows ?? []) as MdStepObservation[]; bindMdStepSources(copy, source); return copy;
}
export function projectMdStepFrames(rows: readonly MdStepObservation[] | undefined, indices: readonly (number | null)[]): MdStepObservation[] | undefined {
  if (!rows) return undefined;
  const mapping = new Map(indices.flatMap((original, index) => original === null ? [] : [[original, index] as const]));
  return rows.flatMap(row => { if (row.frameIndex === null) return [row]; const frameIndex = mapping.get(row.frameIndex); return frameIndex === undefined ? [] : [{ ...row, frameIndex, sourceFrameIndex: row.sourceFrameIndex ?? row.frameIndex }]; });
}
export function projectMdDifferences(rows: readonly MdSourceDifference[] | undefined, indices: readonly (number | null)[]): MdSourceDifference[] | undefined {
  if (!rows) return undefined;
  const mapping = new Map(indices.flatMap((original, index) => original === null ? [] : [[original, index] as const]));
  return rows.flatMap(row => { if (row.frameIndex == null) return [row]; const frameIndex = mapping.get(row.frameIndex); return frameIndex === undefined ? [] : [{ ...row, frameIndex }]; });
}
const rounding = (value: MdQuantityObservation) => scientificRoundingInterval(value.rawValue) ?? 0;
export function mdTimesCompatible(a: MdQuantityObservation | undefined, b: MdQuantityObservation | undefined): boolean {
  if (!a || !b || !a.unit || !b.unit) return false;
  const scale: Record<string, number> = { fs: 1, ps: 1000, ns: 1000000 };
  return a.unit in scale && b.unit in scale && Math.abs(a.value * scale[a.unit] - b.value * scale[b.unit]) <= rounding(a) * scale[a.unit] + rounding(b) * scale[b.unit] + 1e-12;
}
/** Contextual units are copied as evidence from the matching native table, not
 * presented as a unit printed by the statistics source. Every scalar must agree. */
export function qualifyMdStatistics(rows: readonly MdStepObservation[], native: readonly MdStepObservation[]): MdStepObservation[] | null {
  if (!rows.length || rows.length !== native.length || new Set(rows.map(row => row.sourceStep)).size !== rows.length || new Set(native.map(row => row.sourceStep)).size !== native.length) return null;
  const result = structuredClone(rows) as MdStepObservation[];
  for (const row of result) {
    const matches = native.filter(value => value.sourceStep === row.sourceStep);
    if (matches.length !== 1) return null;
    const printed = matches[0];
    for (const key of mdQuantityKeys) {
      const a = row[key], b = printed[key];
      if (!a || !b || a.value !== b.value) return null;
      if (!a.unit && b.unit && b.unitEvidence) {
        a.unit = b.unit;
        a.unitEvidence = { ...b.unitEvidence, sourceId: b.unitEvidence.sourceId ?? b.sourceId, sourceName: b.unitEvidence.sourceName ?? b.sourceName };
      }
    }
  }
  return result;
}
/** Only fixed standard unit conversion is used. Native unprinted scale factors
 * are never reverse-fitted to force cross-source agreement. */
export function mdSourceDifferences(rows: readonly MdStepObservation[]): MdSourceDifference[] {
  const result: MdSourceDifference[] = [];
  const definitions = [['time', 'time'], ['potentialEnergy', 'potential-energy'], ['kineticEnergy', 'kinetic-energy'], ['totalEnergy', 'total-energy'], ['temperature', 'temperature']] as const;
  for (const step of new Set(rows.map(row => row.sourceStep))) for (const [key, quantity] of definitions) {
    const selected = rows.filter(row => row.sourceStep === step && row[key]?.unit);
    const sourceRows = selected, values = sourceRows.map(row => row[key]!);
    if (sourceRows.length < 2) continue;
    let mismatch = false;
    for (let first = 0; first < values.length; first++) for (let second = first + 1; second < values.length; second++) {
      const a = values[first], b = values[second];
      if (key === 'time') { if (!mdTimesCompatible(a, b)) mismatch = true; continue; }
      if (key === 'temperature') { if (a.unit === b.unit && Math.abs(a.value - b.value) > rounding(a) + rounding(b) + 1e-12) mismatch = true; continue; }
      const va = convertEnergy({ value: a.value, unit: a.unit! }, 'hartree'), vb = convertEnergy({ value: b.value, unit: b.unit! }, 'hartree');
      const ra = convertEnergy({ value: rounding(a), unit: a.unit! }, 'hartree'), rb = convertEnergy({ value: rounding(b), unit: b.unit! }, 'hartree');
      if (va !== null && vb !== null && ra !== null && rb !== null && Math.abs(va - vb) > ra + rb + 1e-12) mismatch = true;
    }
    if (mismatch) result.push({ sourceStep: step, frameIndex: sourceRows.find(row => row.frameIndex !== null)?.frameIndex ?? null, quantity, kind: key === 'time' ? 'incompatible-time' : 'converted-value-conflict', values });
  }
  return result;
}
