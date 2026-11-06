import type { ResultFrameSummary, ResultQuantity } from './contracts';

export type EnergyUnit = 'hartree' | 'eV' | 'kJ/mol' | 'kcal/mol';
export type EnergyReference = 'first' | 'last' | 'min' | 'max' | 'current' | 'ts';
export interface EnergyDisplayOptions {
  unit?: EnergyUnit;
  relative?: boolean;
  reference?: EnergyReference;
  currentIndex?: number;
}
export interface EnergySeries {
  unit: EnergyUnit;
  relative: boolean;
  reference: EnergyReference;
  referenceIndex: number | null;
  /** Absolute reference energy in the display unit. */
  referenceValue: number | null;
  points: { index: number; sourceStep: number | null; raw: ResultQuantity | null; value: number | null }[];
}

// CODATA 2022; kcal is the thermochemical calorie (exactly 4.184 J).
const perHartree: Record<EnergyUnit, number> = {
  hartree: 1, eV: 27.211386245981, 'kJ/mol': 2625.4996394799, 'kcal/mol': 627.5094740631,
};
function canonicalUnit(unit: string): EnergyUnit | 'meV' | null {
  // SI prefix case is significant: MeV is mega, never milli.
  if (/^M[eE][vV]$/.test(unit.trim())) return null;
  const token = unit.trim().toLowerCase().replace(/\s/g, '');
  if (['hartree', 'hartrees', 'eh', 'ha', 'a.u.', 'au'].includes(token)) return 'hartree';
  if (token === 'ev') return 'eV';
  if (token === 'mev') return 'meV';
  if (['kj/mol', 'kjmol-1', 'kjmol^-1'].includes(token)) return 'kJ/mol';
  if (['kcal/mol', 'kcalmol-1', 'kcalmol^-1'].includes(token)) return 'kcal/mol';
  return null;
}

/** Unknown units and missing/nonfinite observations remain gaps. */
export function convertEnergy(energy: ResultQuantity | null, unit: EnergyUnit): number | null {
  if (!energy || !Number.isFinite(energy.value)) return null;
  const sourceUnit = canonicalUnit(energy.unit);
  if (!sourceUnit || !(unit in perHartree)) return null;
  const sourceScale = sourceUnit === 'meV' ? perHartree.eV * 1000 : perHartree[sourceUnit];
  const result = energy.value / sourceScale * perHartree[unit];
  return Number.isFinite(result) ? result : null;
}

export function buildEnergySeries(frames: readonly ResultFrameSummary[], options: EnergyDisplayOptions = {}): EnergySeries {
  const { unit = 'hartree', relative = false, reference = 'first', currentIndex = 0 } = options;
  const absolute = frames.map(frame => convertEnergy(frame.energy, unit));
  let referencePosition: number | null = reference === 'current' ? frames.findIndex(frame => frame.index === currentIndex) : reference === 'last' ? frames.length - 1 : 0;
  if (reference === 'ts') {
    const candidates = frames.flatMap((frame, index) => frame.pathDirection === 'ts' ? [index] : []);
    referencePosition = candidates.length === 1 ? candidates[0] : null;
  }
  if (reference === 'min' || reference === 'max') {
    referencePosition = null;
    absolute.forEach((value, index) => {
      if (value !== null && (referencePosition === null || (reference === 'min' ? value < absolute[referencePosition]! : value > absolute[referencePosition]!))) referencePosition = index;
    });
  }
  const referenceValue = referencePosition !== null ? absolute[referencePosition] ?? null : null;
  const referenceIndex = referenceValue === null || referencePosition === null ? null : frames[referencePosition]?.index ?? null;
  return {
    unit, relative, reference, referenceIndex, referenceValue,
    points: frames.map((frame, index) => ({
      index: frame.index, sourceStep: frame.sourceStep, raw: frame.energy ? { ...frame.energy } : null,
      value: absolute[index] === null || (relative && referenceValue === null)
        ? null : absolute[index]! - (relative ? referenceValue! : 0),
    })),
  };
}

/** Bounded SVG presentation; exports retain every original point. Gaps are never bridged. */
export function sampleEnergyPlotPoints(points: EnergySeries['points'], maxPoints = 1200): EnergySeries['points'] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 8) throw new Error('绘图采样预算无效。');
  if (points.length <= maxPoints) return points;
  const width = Math.ceil(points.length / Math.floor(maxPoints / 4));
  const sampled: EnergySeries['points'] = [];
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(points.length, start + width) - 1;
    let min = start, max = start, firstGap = -1;
    for (let index = start; index <= end; index++) {
      const value = points[index].value;
      if (value === null) { if (firstGap === -1) firstGap = index; }
      else {
        if (points[min].value === null || value < points[min].value!) min = index;
        if (points[max].value === null || value > points[max].value!) max = index;
      }
    }
    // A bin containing gaps is conservatively disconnected internally. Its first/last
    // samples can still connect to adjacent bins without spanning an unknown value.
    const indexes = firstGap === -1 ? [start, min, max, end] : [start, firstGap, end];
    for (const index of [...new Set(indexes)].sort((a, b) => a - b)) sampled.push(points[index]);
  }
  return sampled;
}
