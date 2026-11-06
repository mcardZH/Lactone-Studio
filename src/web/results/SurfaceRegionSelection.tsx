import type { Structure } from '../../core/types';
import { inputSelectionIndices } from '../../core/input-selection';
import InteractiveSelectionField from '../InteractiveSelectionField';
import { assertAnalysisSelectionPort, type AnalysisSelectionPort } from '../analysis-selection-intent';
import type { SurfaceRegionSelectionProps } from './surface-controls-contracts';

export interface SurfaceRegionSelectionComponentProps extends SurfaceRegionSelectionProps {
  structure: Structure;
  capture: AnalysisSelectionPort;
}

/** The shared field owns only a draft. The actual analysis broker seals the
 * document/revision/activation and supplies a preview-only canvas capture. */
export default function SurfaceRegionSelection(props: SurfaceRegionSelectionComponentProps) {
  const label = props.kind === 'fragment' ? '表面片段分区' : '表面原子分区';
  return <InteractiveSelectionField structure={props.structure} label={label} rowId={`surface-region-${props.kind}`} kind="atoms" atomIds={props.atomIds} disabled={props.disabled}
    remainingAtomIds={props.structure.atoms.flatMap(atom=>atom.id&&!props.atomIds.includes(atom.id)?[atom.id]:[])}
    captureOwner={props.capture.owner} contextKey={props.capture.contextKey}
    onRequestAnalysisSelection={intent => { assertAnalysisSelectionPort(props.capture); return props.capture.requestSelection(intent); }}
    onConfirm={(ids, assertFieldCurrent) => {
      const assertCurrent = () => {
        if (props.disabled) throw new Error('当前表面分区不可修改。');
        assertAnalysisSelectionPort(props.capture); assertFieldCurrent();
      };
      assertCurrent();
      if (!ids.length) throw new Error('请先选择原子。');
      inputSelectionIndices(props.structure, ids);
      props.onConfirm([...ids], assertCurrent);
    }}/>;
}
