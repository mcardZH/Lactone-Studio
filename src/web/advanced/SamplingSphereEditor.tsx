import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useEffect, useState } from 'react';
import { withSamplingSphereMargin, withSamplingSphereRadius, type SamplingSphereDraft } from '../../modeling/advanced/sampling-sphere';
import './sampling-sphere-editor.css';

export interface SamplingSphereEditorProps {
  draft: SamplingSphereDraft | null;
  disabled?: boolean;
  onChange(draft: SamplingSphereDraft): void;
  onRefit?(): void;
}
const text = (value: number) => String(Number(value.toPrecision(12)));

/** Controlled parameter editor. All geometry and preview ownership stays with
 * the sampling task; incomplete typed numbers are presentation-only drafts. */
export default function SamplingSphereEditor({ draft, disabled, onChange, onRefit }: SamplingSphereEditorProps) {
  const [margin, setMargin] = useState(draft ? text(draft.marginAngstrom) : '');
  const [radius, setRadius] = useState(draft ? text(draft.radiusAngstrom) : '');
  const [error, setError] = useState('');
  useEffect(() => {
    setMargin(draft ? text(draft.marginAngstrom) : '');
    setRadius(draft ? text(draft.radiusAngstrom) : '');
    setError('');
  }, [draft?.sourceDocumentId, draft?.sourceRevision, draft?.marginAngstrom, draft?.radiusAngstrom]);
  if (!draft) return <p className="sampling-sphere-empty" role="status">当前来源没有可用的球形约束。</p>;
  const edit = (field: 'margin' | 'radius', value: string) => {
    if (disabled) return;
    if (field === 'margin') setMargin(value); else setRadius(value);
    try {
      const number = value.trim() ? Number(value) : NaN;
      const next = field === 'margin' ? withSamplingSphereMargin(draft, number) : withSamplingSphereRadius(draft, number);
      setError(''); onChange(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="sampling-sphere-editor ui-control-surface" data-testid="sampling-sphere-editor">
    <fieldset disabled={disabled}>
      <div className="sampling-sphere-control-flow">
        <span className="sampling-sphere-minimum">最小半径 <output aria-label="最小半径 / Å">{text(draft.minimumRadiusAngstrom)}</output> Å</span>
        <label>外扩 / Å<NumericInput aria-label="球形约束外扩 / Å"  min="0" step="any" value={margin} onChange={event => edit('margin', event.target.value)}
          onBlur={() => { setMargin(text(draft.marginAngstrom)); setError(''); }}/></label>
        <label>最终半径 / Å<NumericInput aria-label="球形约束最终半径 / Å"  min={draft.minimumRadiusAngstrom} step="any" value={radius} onChange={event => edit('radius', event.target.value)}
          onBlur={() => { setRadius(text(draft.radiusAngstrom)); setError(''); }}/></label>
        <label className="sampling-sphere-preview-toggle"><input aria-label="球形约束实时预览" type="checkbox" checked={draft.previewEnabled}
          onChange={event => onChange({ ...draft, previewEnabled: event.target.checked })}/>实时预览</label>
        {onRefit && <button type="button" onClick={onRefit}>重新贴合</button>}
        <button type="button" onClick={() => onChange(withSamplingSphereMargin(draft, 3))}>恢复默认外扩</button>
      </div>
    </fieldset>
    {error && <DismissibleNotice className="sampling-sphere-error" role="alert">{error}</DismissibleNotice>}
  </div>;
}
