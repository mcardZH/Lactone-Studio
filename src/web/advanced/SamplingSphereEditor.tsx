import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useId, useState } from 'react';
import { withSamplingSphereMargin, withSamplingSphereRadius, type SamplingSphereDraft } from '../../modeling/advanced/sampling-sphere';
import { InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox } from '../InputSettingsLayout';
import './sampling-sphere-editor.css';

export interface SamplingSphereEditorProps {
  draft: SamplingSphereDraft | null;
  disabled?: boolean;
  onChange(draft: SamplingSphereDraft): void;
  onRefit?(): void;
  onInvalidChange?(invalid:boolean):void;
}
const text = (value: number) => String(value);

/** Controlled parameter editor. All geometry and preview ownership stays with
 * the sampling task; incomplete typed numbers are presentation-only drafts. */
export default function SamplingSphereEditor({ draft, disabled, onChange, onRefit, onInvalidChange }: SamplingSphereEditorProps) {
  const [margin, setMargin] = useState(draft ? text(draft.marginAngstrom) : '');
  const [radius, setRadius] = useState(draft ? text(draft.radiusAngstrom) : '');
  const minimumId=useId();
  const [error, setError] = useState('');
  const [invalidField,setInvalidField]=useState<'margin'|'radius'|null>(null);
  useEffect(() => {
    setMargin(raw=>draft ? raw.trim()&&Number(raw)===draft.marginAngstrom?raw:text(draft.marginAngstrom) : '');
    setRadius(raw=>draft ? raw.trim()&&Number(raw)===draft.radiusAngstrom?raw:text(draft.radiusAngstrom) : '');
    setError('');setInvalidField(null);onInvalidChange?.(false);
  }, [draft?.sourceDocumentId, draft?.sourceRevision, draft?.marginAngstrom, draft?.radiusAngstrom]);
  if (!draft) return <p className="sampling-sphere-empty" role="status">当前来源没有可用的球形约束。</p>;
  const edit = (field: 'margin' | 'radius', value: string) => {
    if (disabled) return;
    if (field === 'margin') setMargin(value); else setRadius(value);
    try {
      const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ? Number(value) : NaN;
      const next = field === 'margin' ? withSamplingSphereMargin(draft, number) : withSamplingSphereRadius(draft, number);
      setError('');setInvalidField(null);onInvalidChange?.(false);onChange(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause));setInvalidField(field);onInvalidChange?.(true); }
  };
  const restore=(action:()=>void)=>{setMargin(text(draft.marginAngstrom));setRadius(text(draft.radiusAngstrom));setError('');setInvalidField(null);onInvalidChange?.(false);action();};
  return <div className="sampling-sphere-editor ui-control-surface" data-testid="sampling-sphere-editor">
    <InputSettingsStack><fieldset disabled={disabled}><InputSettingsStack>
      <output id={minimumId} className="sampling-sphere-minimum" aria-label="最小半径 / Å">最小半径 {text(draft.minimumRadiusAngstrom)} Å</output>
      <InputSettingsRow>
        <InputSettingsField label="外扩" unit="Å" controlWidth="number"><input type="text" inputMode="decimal" aria-label="球形约束外扩 / Å" aria-invalid={invalidField==='margin'||undefined} value={margin} onChange={event=>edit('margin',event.target.value)}/></InputSettingsField>
        <InputSettingsField label="最终半径" unit="Å" controlWidth="long-number"><input type="text" inputMode="decimal" aria-describedby={minimumId} aria-label="球形约束最终半径 / Å" aria-invalid={invalidField==='radius'||undefined} value={radius} onChange={event=>edit('radius',event.target.value)}/></InputSettingsField>
      </InputSettingsRow>
      <InputSettingsRow variant="actions">
        <InputSettingsCheckbox label="实时预览" ariaLabel="球形约束实时预览" checked={draft.previewEnabled} onChange={previewEnabled=>onChange({...draft,previewEnabled})}/>
        {onRefit&&<InputSettingsAction onClick={()=>restore(onRefit)}>重新贴合</InputSettingsAction>}
        <InputSettingsAction onClick={()=>restore(()=>onChange(withSamplingSphereMargin(draft,3)))}>恢复默认外扩</InputSettingsAction>
      </InputSettingsRow>
    </InputSettingsStack></fieldset>
    {error&&<DismissibleNotice className="sampling-sphere-error" role="alert">{error}</DismissibleNotice>}</InputSettingsStack>
  </div>;
}
