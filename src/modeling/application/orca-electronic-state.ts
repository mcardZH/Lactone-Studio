import type { OrcaJobRequest } from '../../core/orca';

/** Every task uses the shared, explicitly confirmed electronic state.
 * Target spin/root affect writer validation, never the input charge or multiplicity. */
export function resolveOrcaElectronicState(request: OrcaJobRequest) {
  return { effectiveRequest: request };
}
