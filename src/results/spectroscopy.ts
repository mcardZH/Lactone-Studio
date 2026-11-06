import type { Structure, Vector3 } from '../core/types';
import type { ExcitedState, ScientificData, VibrationMode, Vibrations, FrequencyElectronicTarget } from './scientific-contracts';
import { displacedVibrationStructure, MAX_VIBRATION_AMPLITUDE_ANGSTROM } from './vibrations';

/** hc/e, from the exact SI definitions of h, c and e, in eV nm. */
export const EV_NM = 1239.8419843320026;
export const ABSORPTION_FWHM_EV = 0.2;
export const INFRARED_FWHM_CM = 16;
export const MULTIPLICITY_NOTE = '*：由⟨S²⟩反解得到的重态数。';

export function energyEvToNm(value: number): number | null {
  const result = EV_NM / value;
  return Number.isFinite(value) && value > 0 && Number.isFinite(result) ? result : null;
}
export function wavelengthNmToEv(value: number): number | null { return energyEvToNm(value); }
/** Prefer the printed wavelength. A missing value can be projected from ΔE;
 * the source state remains untouched and the UI identifies the conversion. */
export function excitedStateWavelength(state: ExcitedState): { value: number; source: 'printed' | 'energy' } | null {
  if (state.wavelengthNm != null && Number.isFinite(state.wavelengthNm) && state.wavelengthNm > 0) return { value: state.wavelengthNm, source: 'printed' };
  const value = energyEvToNm(state.energyEv);
  return value === null ? null : { value, source: 'energy' };
}
export function effectiveMultiplicity(spinSquared: number | null | undefined): number | null {
  if (spinSquared == null || !Number.isFinite(spinSquared) || spinSquared < 0) return null;
  // Avoid overflowing 4<S²> for otherwise finite values.
  return 2 * Math.sqrt(spinSquared + 0.25);
}
/** Display precision only: there is no tolerance, classification or integer rounding. */
export function spinMultiplicityLabel(spinSquared: number | null | undefined): string | null {
  const value = effectiveMultiplicity(spinSquared);
  return value === null ? null : `${Number(value.toPrecision(9))}*`;
}

export function excitedStatesForFrame(data: ScientificData | undefined, frameIndex: number): ExcitedState[] {
  return data?.excitedStates.filter(state => state.frameIndex === frameIndex) ?? [];
}
export function vibrationSetsForFrame(data: ScientificData | undefined, frameIndex: number): Vibrations[] {
  const sets = data?.vibrationSets ?? (data?.vibrations ? [data.vibrations] : []);
  return sets.filter(set => set.frameIndex === frameIndex);
}
/** Labels only established target information; unrestricted reference alone is not an excited-state identity. */
export function frequencyTargetLabel(target:FrequencyElectronicTarget|undefined):string|null {
  if(!target)return null;
  const method={td:'TD',tda:'TDA',scf:'SCF',udft:'UDFT',unknown:''}[target.method];
  const state=target.state==='ground'?'基态':target.state==='excited'&&target.root!==null?`态 ${target.root}`:'目标态未确认';
  return [method,state,target.multiplicity===null?'':`${target.multiplicity}重态`].filter(Boolean).join(' · ');
}
export interface ProjectedVibrationMode extends VibrationMode {
  displayIndex: number; sourceIndex: number; originalFrequency: number; correctedFrequency: number;
}
export interface ModeProjectionOptions { scaleFactor?: number; includeRigid?: boolean; /** Within the matching frame's source-order sets. */ setIndex?: number }
export function correctedFrequency(frequency: number, factor = 1): number {
  positive(factor, '频率校正因子');
  if (!Number.isFinite(frequency) || !Number.isFinite(frequency * factor)) throw new Error('频率须为有限数。');
  return frequency * factor;
}
/** Only explicit translation/rotation identities are excluded; small/imaginary modes remain. */
export function projectVibrationModes(modes: readonly VibrationMode[], options: ModeProjectionOptions = {}): ProjectedVibrationMode[] {
  const factor = options.scaleFactor ?? 1;
  positive(factor, '频率校正因子');
  return modes.filter(mode => options.includeRigid || mode.kind !== 'translation' && mode.kind !== 'rotation')
    .map((mode, index) => ({ ...mode, displayIndex: index + 1, sourceIndex: mode.sourceIndex ?? mode.index,
      originalFrequency: mode.frequency, correctedFrequency: correctedFrequency(mode.frequency, factor) }));
}
/** Multiple calculations stay distinct. Default selects the first matching source group. */
export function vibrationModesForFrame(data: ScientificData | undefined, frameIndex: number, options: ModeProjectionOptions = {}): ProjectedVibrationMode[] {
  const sets = vibrationSetsForFrame(data, frameIndex), index = options.setIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('频率组序号无效。');
  return projectVibrationModes(sets[index]?.modes ?? [], options);
}

export interface SpectrumPoint { x: number; y: number }
export interface SpectrumStick extends SpectrumPoint { sourceIndex: number; sourceLine: number }
export interface SpectrumProjection {
  sticks: SpectrumStick[]; points: SpectrumPoint[];
  xUnit: 'eV' | 'nm' | 'cm⁻¹'; stickIntensityUnit: string; intensityUnit: string;
  range: [number, number]; fwhm: number; fwhmUnit: 'eV' | 'cm⁻¹';
  normalized: boolean; normalizationDivisor: number; peakShape: 'gaussian' | 'lorentzian';
}
export interface SpectrumOptions { range?: readonly [number, number]; fwhm?: number; normalize?: boolean; samples?: number }
export interface AbsorptionSpectrumOptions extends SpectrumOptions { axis?: 'eV' | 'nm' }
export interface InfraredSpectrumOptions extends SpectrumOptions { scaleFactor?: number; /** Select a native unit explicitly when the input contains different IR quantities. */ intensityUnit?: string }

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}须为正有限数。`);
}
/** Unit-area kernel: the printed oscillator strength is the integrated eV-domain weight. */
export function gaussianPeak(delta: number, fwhm = ABSORPTION_FWHM_EV): number {
  positive(fwhm, 'FWHM');
  return Math.sqrt(4 * Math.LN2 / Math.PI) / fwhm * Math.exp(-4 * Math.LN2 * (delta / fwhm) ** 2);
}
/** Unit-area kernel; fwhm/2 is the half width. */
export function lorentzianPeak(delta: number, fwhm = INFRARED_FWHM_CM): number {
  positive(fwhm, 'FWHM');
  const ratio = 2 * delta / fwhm;
  return 2 / (Math.PI * fwhm) / (1 + ratio * ratio);
}
function spectrumRange(range: readonly [number, number] | undefined, fallback: [number, number], strictlyPositive = false): [number, number] {
  const selected = range ?? fallback;
  if (selected.length !== 2 || !selected.every(Number.isFinite) || selected[0] >= selected[1] || (strictlyPositive && selected[0] <= 0)) throw new Error('谱图范围须为递增的有限区间。');
  return [selected[0], selected[1]];
}
function sampleSpectrum(range: [number, number], samples: number | undefined, evaluate: (x: number) => number): SpectrumPoint[] {
  const count = samples ?? 1001;
  if (!Number.isSafeInteger(count) || count < 2 || count > 100_001) throw new Error('谱图采样点数须为2–100001的整数。');
  return Array.from({ length: count }, (_, index) => {
    const x = index === count - 1 ? range[1] : range[0] + (range[1] - range[0]) * index / (count - 1);
    const y = evaluate(x);
    if (!Number.isFinite(y)) throw new Error('谱图强度超出有限数范围。');
    return { x, y };
  });
}
function normalizeSpectrum(points: SpectrumPoint[], enabled: boolean): number {
  const maximum = points.reduce((value, point) => Math.max(value, point.y), 0);
  const divisor = enabled && maximum > 0 ? maximum : 1;
  if (enabled) for (const point of points) point.y /= divisor;
  return divisor;
}
function extent(values: readonly number[], fallback: [number, number]): [number, number] {
  if (!values.length) return fallback;
  return values.reduce<[number, number]>(([min, max], value) => [Math.min(min, value), Math.max(max, value)], [values[0], values[0]]);
}

/** Caller supplies the current frame's states. Missing f remains missing; f=0 remains a dark stick. */
export function buildAbsorptionSpectrum(states: readonly ExcitedState[], options: AbsorptionSpectrumOptions = {}): SpectrumProjection {
  const axis = options.axis ?? 'eV', fwhm = options.fwhm ?? ABSORPTION_FWHM_EV;
  positive(fwhm, 'FWHM');
  const available = states.filter(state => energyEvToNm(state.energyEv) !== null && state.oscillatorStrength != null
    && Number.isFinite(state.oscillatorStrength) && state.oscillatorStrength >= 0);
  const [min, max] = extent(available.map(state => state.energyEv), [1, 6]);
  const energyRange: [number, number] = [Math.max(min / 10, min - 5 * fwhm), max + 5 * fwhm];
  const fallback: [number, number] = axis === 'nm' ? [energyEvToNm(energyRange[1])!, energyEvToNm(energyRange[0])!] : energyRange;
  const range = spectrumRange(options.range, fallback, true);
  const points = sampleSpectrum(range, options.samples, x => {
    const energy = axis === 'nm' ? wavelengthNmToEv(x) : x;
    if (energy === null) throw new Error('波长范围无法换算为有限正能量。');
    return available.reduce((sum, state) => sum + state.oscillatorStrength! * gaussianPeak(energy - state.energyEv, fwhm), 0);
  });
  const normalized = options.normalize ?? false, normalizationDivisor = normalizeSpectrum(points, normalized);
  return { points, sticks: available.map(state => ({ x: axis === 'nm' ? energyEvToNm(state.energyEv)! : state.energyEv,
    y: state.oscillatorStrength!, sourceIndex: state.index, sourceLine: state.sourceLine })),
    range, xUnit: axis, stickIntensityUnit: 'f', intensityUnit: normalized ? '归一化强度' : 'f/eV',
    fwhm, fwhmUnit: 'eV', normalized, normalizationDivisor, peakShape: 'gaussian' };
}

/** Never combines native T² with km/mol. Imaginary peaks remain on the signed wavenumber axis. */
export function buildInfraredSpectrum(modes: readonly VibrationMode[], options: InfraredSpectrumOptions = {}): SpectrumProjection {
  const fwhm = options.fwhm ?? INFRARED_FWHM_CM, factor = options.scaleFactor ?? 1;
  positive(fwhm, 'FWHM'); positive(factor, '频率校正因子');
  const candidates = modes.filter(mode => mode.kind !== 'translation' && mode.kind !== 'rotation' && Number.isFinite(mode.frequency)
    && mode.irIntensity != null && Number.isFinite(mode.irIntensity) && mode.irIntensity >= 0);
  const units = new Set(candidates.map(mode => mode.irIntensityUnit ?? '单位未确认'));
  if (units.size > 1 && options.intensityUnit === undefined) throw new Error('不同原生红外强度单位须分别绘谱。');
  const unit = options.intensityUnit ?? [...units][0] ?? '单位未确认';
  const available = candidates.filter(mode => (mode.irIntensityUnit ?? '单位未确认') === unit);
  const sticks = available.map(mode => ({ x: correctedFrequency(mode.frequency, factor), y: mode.irIntensity!, sourceIndex: mode.sourceIndex ?? mode.index, sourceLine: mode.sourceLine }));
  const [min, max] = extent(sticks.map(stick => stick.x), [0, 4000]);
  const range = spectrumRange(options.range, [min - 5 * fwhm, max + 5 * fwhm]);
  const points = sampleSpectrum(range, options.samples, x => sticks.reduce((sum, stick) => sum + stick.y * lorentzianPeak(x - stick.x, fwhm), 0));
  const normalized = options.normalize ?? false, normalizationDivisor = normalizeSpectrum(points, normalized);
  return { points, sticks, range, xUnit: 'cm⁻¹', stickIntensityUnit: unit,
    intensityUnit: normalized ? '归一化强度' : `${unit}/(cm⁻¹)`, fwhm, fwhmUnit: 'cm⁻¹', normalized, normalizationDivisor, peakShape: 'lorentzian' };
}

/** hc/k in cm·K, calculated from the exact SI values of h, c and k. */
export const RAMAN_SECOND_RADIATION_CONSTANT = 6.62607015e-34 * 299792458 * 100 / 1.380649e-23;
export interface RamanStokesParameters { laserWavelengthNm: number; temperatureK: number }
export type RamanUnavailableReason = 'missing-activity' | 'unconfirmed-activity-unit' | 'missing-source'
  | 'unconfirmed-activity-convention' | 'dynamic-excitation-mismatch'
  | 'non-vibrational-mode' | 'outside-stokes-range' | 'numeric-range';
export interface RamanStokesMode {
  mode: VibrationMode; sourceIndex: number; intensity: number | null; unavailableReason: RamanUnavailableReason | null;
}
export interface RamanSpectrumOptions extends RamanStokesParameters {
  /** Display peak positions only; raw-frequency Stokes weights are unchanged. */
  scaleFactor?: number;
  /** Explicit cm⁻¹ width and peak shape; no implicit Raman broadening default. */
  fwhm: number; peakShape: 'gaussian' | 'lorentzian';
  range?: readonly [number, number]; samples?: number; normalize?: boolean;
}
export interface RamanSpectrumProjection extends SpectrumProjection, RamanStokesParameters {
  scattering: 'nonresonant-stokes';
  /** Frequency basis used to calculate intensity, independently of peak display. */
  frequencyBasis: 'raw'; displayScaleFactor: number; modeIntensities: RamanStokesMode[];
}
function validateRamanParameters(parameters: RamanStokesParameters): number {
  positive(parameters.laserWavelengthNm, 'Raman激光波长/nm'); positive(parameters.temperatureK, 'Raman温度/K');
  const laser = 1e7 / parameters.laserWavelengthNm;
  if (!Number.isFinite(laser) || laser <= 0) throw new Error('Raman激光波长不能换算为有限正波数。');
  return laser;
}
function ramanModeProjection(mode: VibrationMode, parameters: RamanStokesParameters, laser: number): RamanStokesMode {
  const result = (intensity: number | null, unavailableReason: RamanUnavailableReason | null): RamanStokesMode => ({ mode, sourceIndex: mode.sourceIndex ?? mode.index, intensity, unavailableReason });
  if (mode.ramanActivity == null || !Number.isFinite(mode.ramanActivity) || mode.ramanActivity < 0) return result(null, 'missing-activity');
  // Explicit source unit plus its source line establish the raw activity. Never
  // infer the unit from a file suffix, a nonnegative value or an IR intensity.
  if (!['Å⁴/amu', 'Å^4/amu', 'Å⁴/AMU', 'Å^4/AMU'].includes(mode.ramanActivityUnit ?? '')) return result(null, 'unconfirmed-activity-unit');
  const activityLine = mode.ramanActivitySourceLine ?? mode.sourceLine;
  if (!Number.isSafeInteger(activityLine) || activityLine < 1) return result(null, 'missing-source');
  if (mode.ramanActivityConvention !== 'static' && mode.ramanActivityConvention !== 'dynamic') return result(null, 'unconfirmed-activity-convention');
  if (mode.ramanActivityConvention === 'dynamic' && (!Number.isFinite(mode.ramanExcitationWavelengthNm) || mode.ramanExcitationWavelengthNm! <= 0
    || Math.abs(mode.ramanExcitationWavelengthNm! - parameters.laserWavelengthNm) > 8 * Number.EPSILON * Math.max(mode.ramanExcitationWavelengthNm!, parameters.laserWavelengthNm))) return result(null, 'dynamic-excitation-mismatch');
  if (mode.kind === 'translation' || mode.kind === 'rotation') return result(null, 'non-vibrational-mode');
  const frequency = mode.frequency, scattered = laser - frequency;
  // Reject an unresolved cutoff within the source frequency's printed interval
  // or floating-point resolution. There is no empirical near-laser threshold.
  const boundary = Math.max(Number.isFinite(mode.frequencyRounding) && mode.frequencyRounding! > 0 ? mode.frequencyRounding! : 0,
    8 * Number.EPSILON * Math.max(Math.abs(laser), Math.abs(frequency)));
  if (!Number.isFinite(frequency) || frequency <= 0 || !(scattered > boundary)) return result(null, 'outside-stokes-range');
  if (mode.ramanActivity === 0) return result(0, null);
  // ORCA 6.1 manual, Raman Spectra: I = f(ν0-ν)^4 S /
  // [ν(1-exp(-hcν/kT))]. f=1 is common to all modes: these are a.u. relative
  // Stokes weights, not absolute experimental intensities or resonance Raman.
  // Use raw cm⁻¹ frequencies. A display correction cannot change this weight.
  const exponent = RAMAN_SECOND_RADIATION_CONSTANT * (frequency / parameters.temperatureK);
  const population = -Math.expm1(-exponent);
  const logPopulation = population === 0
    ? Math.log(RAMAN_SECOND_RADIATION_CONSTANT) + Math.log(frequency) - Math.log(parameters.temperatureK)
    : Math.log(population);
  const logIntensity = 4 * Math.log(scattered) + Math.log(mode.ramanActivity) - Math.log(frequency) - logPopulation;
  const intensity = Math.exp(logIntensity);
  return Number.isFinite(intensity) && intensity > 0 ? result(intensity, null) : result(null, 'numeric-range');
}
/** Raw activity and frequency remain untouched. Invalid/missing mode quantities
 * yield null, while an explicitly printed zero activity yields a zero weight. */
export function ramanStokesIntensity(mode: VibrationMode, parameters: RamanStokesParameters): number | null {
  return ramanModeProjection(mode, parameters, validateRamanParameters(parameters)).intensity;
}
/** Retains every source mode, including imaginary, rigid and unavailable rows. */
export function projectRamanStokesModes(modes: readonly VibrationMode[], parameters: RamanStokesParameters): RamanStokesMode[] {
  const laser = validateRamanParameters(parameters);
  return modes.map(mode => ramanModeProjection(mode, parameters, laser));
}
/** Unit-area broadening of explicitly parameterized, non-resonant Stokes
 * weights. No anti-Stokes branch, implicit laser, temperature or FWHM. */
export function buildRamanSpectrum(modes: readonly VibrationMode[], options: RamanSpectrumOptions): RamanSpectrumProjection {
  positive(options.fwhm, 'Raman FWHM/cm⁻¹');
  const factor = options.scaleFactor ?? 1;
  positive(factor, '频率校正因子');
  if (options.peakShape !== 'gaussian' && options.peakShape !== 'lorentzian') throw new Error('Raman展宽峰型须显式选择Gaussian或Lorentzian。');
  const modeIntensities = projectRamanStokesModes(modes, options);
  const sticks = modeIntensities.flatMap(row => row.intensity === null ? [] : [{ x: correctedFrequency(row.mode.frequency, factor), y: row.intensity, sourceIndex: row.sourceIndex, sourceLine: row.mode.sourceLine }]);
  const [min, max] = extent(sticks.map(stick => stick.x), [0, 4000]);
  const range = spectrumRange(options.range, [Math.max(0, min - 5 * options.fwhm), max + 5 * options.fwhm]);
  const kernel = options.peakShape === 'gaussian' ? gaussianPeak : lorentzianPeak;
  const points = sampleSpectrum(range, options.samples, x => sticks.reduce((sum, stick) => sum + stick.y * kernel(x - stick.x, options.fwhm), 0));
  const normalized = options.normalize ?? false, normalizationDivisor = normalizeSpectrum(points, normalized);
  return { points, sticks, modeIntensities, range, xUnit: 'cm⁻¹', stickIntensityUnit: 'a.u.', intensityUnit: normalized ? '归一化强度' : 'a.u./(cm⁻¹)',
    fwhm: options.fwhm, fwhmUnit: 'cm⁻¹', normalized, normalizationDivisor, peakShape: options.peakShape,
    laserWavelengthNm: options.laserWavelengthNm, temperatureK: options.temperatureK, scattering: 'nonresonant-stokes', frequencyBasis: 'raw', displayScaleFactor: factor };
}

/** Direction vectors scaled so the largest atomic norm is one, without a mass transform. */
export function normalizedCartesianMode(mode: VibrationMode): Vector3[] {
  if (mode.displacementConvention !== 'cartesian') throw new Error('正常模式尚未确认为笛卡尔位移，不能生成位移。');
  const vectors = mode.displacements;
  if (!vectors?.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite))) throw new Error('正常模式向量缺失、形状不符或含非有限数。');
  let maximum = 0;
  for (const vector of vectors) for (const value of vector) maximum = Math.max(maximum, Math.abs(value));
  if (maximum === 0) throw new Error('全零正常模式不能生成振动位移。');
  const scaled = vectors.map(vector => vector.map(value => value / maximum) as Vector3);
  let norm = 0;
  for (const vector of scaled) norm = Math.max(norm, Math.hypot(...vector));
  return scaled.map(vector => vector.map(value => value / norm) as Vector3);
}
/** Manual signed Å displacement: independent derived structure, no mutation of the source. */
export function signedVibrationStructure(structure: Structure, mode: VibrationMode, displacementAngstrom: number): Structure {
  normalizedCartesianMode(mode);
  return displacedVibrationStructure(structure, mode, Math.abs(displacementAngstrom), displacementAngstrom < 0 ? -1 : 1);
}
/** Playback amplitude remains nonnegative; only phase oscillates between -1 and +1. */
export function vibrationPlaybackStructure(structure: Structure, mode: VibrationMode, amplitudeAngstrom: number, phase: number): Structure {
  normalizedCartesianMode(mode);
  return displacedVibrationStructure(structure, mode, amplitudeAngstrom, phase);
}

/** Prepare one immutable display mode, then update only coordinates per paint.
 * Scientific extraction still uses signedVibrationStructure and its full record. */
export function prepareVibrationPlayback(structure: Structure, mode: VibrationMode) {
  const vectors = normalizedCartesianMode(mode), base = signedVibrationStructure(structure, mode, 0);
  const atoms = base.atoms;
  return { vectors, sample(amplitude: number, phase: number): Structure {
    if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > MAX_VIBRATION_AMPLITUDE_ANGSTROM || !Number.isFinite(phase) || Math.abs(phase) > 1) throw new Error('振动显示幅度或相位无效。');
    const scale = amplitude * phase;
    return { ...base, atoms: atoms.map((atom, i) => ({ ...atom, x: atom.x + vectors[i][0] * scale, y: atom.y + vectors[i][1] * scale, z: atom.z + vectors[i][2] * scale })) };
  } };
}
