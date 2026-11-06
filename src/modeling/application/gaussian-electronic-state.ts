import type { GaussianSettings } from '../../core/types';
export interface BaseElectronicState { charge: number; multiplicity: number; confirmed: boolean }
/** Task selection cannot override the shared, explicitly confirmed electronic state. */
export function resolveGaussianElectronicState(_settings: GaussianSettings, base: BaseElectronicState) {
  return {
    charge: base.charge,
    multiplicity: base.multiplicity,
    electronicStateConfirmed: base.confirmed,
  };
}
