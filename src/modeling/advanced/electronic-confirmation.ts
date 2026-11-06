import type { AdvancedFrameSource } from './frame-source';
import { graphFingerprint } from '../../core/modeling/graph';

/** A user confirmation belongs to this complete scientific source identity.
 * Mere presence of charge/multiplicity is never a confirmation receipt. */
export function advancedElectronicSourceConfirmationKey(source: AdvancedFrameSource | null | undefined,
  state: { charge: number; multiplicity: number }): string {
  // Confirming q/M can return through a new immutable source copy. Normalize
  // only those explicitly confirmed fields while retaining the full graph.
  const graph=source?graphFingerprint({...source.structure,charge:state.charge,multiplicity:state.multiplicity}):undefined;
  // Source captures and retained frames use different stamp envelopes. Bind the
  // confirmation to their actual shared constraints, not that envelope; a save
  // and reopen can legitimately recapture the same source through either path.
  const constraints=source?JSON.stringify(source.constraints):undefined;
  return JSON.stringify([source?.ref, source?.stamp.coordinatesFingerprint, graph,
    constraints, state.charge, state.multiplicity]);
}
