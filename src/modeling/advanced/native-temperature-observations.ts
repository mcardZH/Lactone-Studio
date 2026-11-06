import type { AdvancedResultFrame } from './contracts';
import type { ConformerNativeTemperatureObservation, ConformerSamplingRequest } from './sampling-contracts';

export const NATIVE_TEMPERATURE_SOURCE = '5071a8869720fb0ecd788af977159869b64a277c';
export interface NativeTemperatureObservationResult { applied: number; skipped: boolean; diagnostic?: string }

/** Enrich only existing frames of this closed native session; geometry and frame identity stay untouched. */
export function applyNativeTemperatureObservations(frames: AdvancedResultFrame[], sessionId: string,
  request: ConformerSamplingRequest, observations?: ConformerNativeTemperatureObservation[]): NativeTemperatureObservationResult {
  if (observations === undefined || Array.isArray(observations) && observations.length === 0) return { applied: 0, skipped: false };
  if (!Array.isArray(observations) || request.driver !== 'native-xtb-md' || observations.length > Math.ceil((request.maxSteps ?? 0) / 200))
    return { applied: 0, skipped: true, diagnostic: '原生温度观察的来源或数量无效；已跳过可选温度元数据。' };
  const seen = new Set<number>(), updates: { frame: AdvancedResultFrame; value: ConformerNativeTemperatureObservation }[] = [];
  for (const value of observations) {
    if (!value || !Number.isSafeInteger(value.step) || value.step < 0 || value.step >= (request.maxSteps ?? 0)
      || value.printedAtStep !== value.step + 1 || value.printedAtStep % 200 !== 0 || seen.has(value.step)
      || !Number.isFinite(value.timeFs) || Math.abs(value.timeFs - value.step * (request.dtFs ?? 2)) > 1e-8
      || !Number.isFinite(value.temperatureK) || value.temperatureK < 0 || value.temperatureK > 10000
      || !Number.isFinite(value.kineticEnergyEV) || value.kineticEnergyEV < 0
      || value.sourceArtifact !== 'stdout.txt' || value.sourceCommit !== NATIVE_TEMPERATURE_SOURCE
      || value.velocityPhase !== 'centred-before-SHAKE-and-rmrottr'
      || value.temperatureResolutionK !== 1 || value.kineticEnergyResolutionHartree !== 0.0001)
      return { applied: 0, skipped: true, diagnostic: '原生温度观察与已验证步号／相位不符；已跳过可选温度元数据。' };
    seen.add(value.step);
    for (const frame of frames) if (frame.sessionId === sessionId && frame.process?.kind === 'sampling'
      && frame.process.data.driver === 'native-xtb-md' && frame.process.data.step === value.step
      && frame.process.data.nativeMD?.sourceArtifact === 'xtb.trj') updates.push({ frame, value });
  }
  for (const { frame, value } of updates) {
    if (frame.process?.kind !== 'sampling') continue;
    const data = frame.process.data;
    data.temperatureK = value.temperatureK;
    data.kineticEnergyEV = value.kineticEnergyEV;
    if (data.nativeMD) data.nativeMD.temperatureObservation = structuredClone(value);
  }
  return { applied: updates.length, skipped: false };
}
