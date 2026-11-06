import { useRef } from 'react';
import type { Structure } from '../../core/types';
import { applyRegionSelection, planRegionSelection, regionMembershipSignature, remainingRegionAtomIds } from '../../modeling/application/region-selection';
import InteractiveSelectionField from '../InteractiveSelectionField';
import { assertAnalysisSelectionPort, type AnalysisSelectionPort } from '../analysis-selection-intent';
import type { InteractionFragmentSelectionProps } from './interaction-controls-contracts';
import type { InteractionFragment } from '../../results/interaction-contracts';

export function interactionFragmentTransaction(structure: Structure, fragments: readonly InteractionFragment[], fragmentId: string,
  atomIds: readonly string[], overwrite: boolean, assertCurrent: () => void): InteractionFragment[] {
  return applyRegionSelection(fragments, planRegionSelection(structure, fragments, fragmentId, atomIds), overwrite, assertCurrent);
}

/** Analysis membership only. Input fragments, model selection and freezes are
 * deliberately absent; the shared field owns drafts and overwrite prompts. */
export default function InteractionFragmentSelection(p: InteractionFragmentSelectionProps & { structure: Structure; capture: AnalysisSelectionPort }) {
  const signature = regionMembershipSignature(p.fragments), latest = useRef(signature); latest.current = signature;
  const remaining = remainingRegionAtomIds(p.structure, p.fragments, p.fragmentId);
  return <InteractiveSelectionField structure={p.structure} label={`片段 ${p.label}`} rowId={`interaction-fragment:${p.fragmentId}`} kind="atoms"
    atomIds={p.atomIds} disabled={p.disabled} remainingAtomIds={remaining} renderHeader={p.renderHeader} captureOwner={p.capture.owner} contextKey={p.capture.contextKey}
    analysisPurpose="interaction-fragment" onRequestAnalysisSelection={intent => { assertAnalysisSelectionPort(p.capture); return p.capture.requestSelection(intent); }}
    onConfirm={(ids, assertFieldCurrent, overwrite) => {
      const assertCurrent = () => {
        if (p.disabled || latest.current !== signature) throw new Error('相互作用片段定义已变化，请重新选择。');
        assertAnalysisSelectionPort(p.capture); assertFieldCurrent();
      };
      assertCurrent();
      const transaction = interactionFragmentTransaction(p.structure, p.fragments, p.fragmentId, ids, overwrite, assertCurrent);
      p.onConfirm(transaction, assertCurrent);
    }}/>;
}
