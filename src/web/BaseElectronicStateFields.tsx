import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import type { ReactNode } from 'react';
import './base-electronic-state.css';
import { InputSettingsAction } from './InputSettingsLayout';
import { InputSettingsField, InputSettingsRow } from './InputSettingsFields';

export interface BaseElectronicStateFieldsProps {
  charge: number;
  multiplicity: number;
  disabled?: boolean;
  error?: string | null;
  confirmed?: boolean;
  chargeLabel?: string;
  multiplicityLabel?: string;
  onChargeChange: (charge: number) => void;
  onMultiplicityChange: (multiplicity: number) => void;
  onConfirm?: () => void;
  onReset?:()=>void;
  confirmationLabel?: string;
  children?: ReactNode;
  /** Optional lossless draft channel. Legacy numeric consumers are unchanged. */
  rawText?: { charge: string; multiplicity: string };
  onRawTextChange?: (field: 'charge' | 'multiplicity', text: string) => void;
  onRawTextBlur?: (field: 'charge' | 'multiplicity') => void;
  rawInvalid?: { charge: boolean; multiplicity: boolean };
  embedded?: boolean;
  chargeFieldLabel?: string;
}

/** Compact controlled base-state fields. The owning workflow supplies its
 * explicit confirmation action; this component never confirms a task or source. */
export default function BaseElectronicStateFields({ charge, multiplicity, disabled = false, error, confirmed = false,
  chargeLabel = '总电荷', multiplicityLabel = '自旋多重度', onChargeChange, onMultiplicityChange, onConfirm, confirmationLabel, children, onReset,
  rawText,onRawTextChange,onRawTextBlur,rawInvalid,embedded=false,chargeFieldLabel='总电荷',
}: BaseElectronicStateFieldsProps) {
  const shown = (value: number) => Number.isFinite(value) ? value : '';
  const edited = (text: string) => text === '' ? Number.NaN : Number(text);
  function rawField(field:'charge'|'multiplicity',label:string){
    const text=rawText![field],valid=/^[+-]?\d+$/.test(text)&&Number.isSafeInteger(Number(text));
    const step=(direction:number)=>{if(!valid)return;const next=Number(text)+direction;if(!Number.isSafeInteger(next)||field==='multiplicity'&&next<1)return;onRawTextChange?.(field,String(next));};
    return <span className="numeric-adaptive"><input type="text" inputMode="numeric" role="spinbutton" aria-label={label} disabled={disabled} value={text}
      aria-invalid={rawInvalid?.[field]||undefined} aria-valuenow={valid?Number(text):undefined} aria-valuemin={field==='multiplicity'?1:undefined}
      className="numeric-input-direct" onChange={event=>onRawTextChange?.(field,event.target.value)} onBlur={()=>onRawTextBlur?.(field)}
      onKeyDown={event=>{if(!event.nativeEvent.isComposing&&(event.key==='ArrowUp'||event.key==='ArrowDown')){event.preventDefault();step(event.key==='ArrowUp'?1:-1);}}}/>
      <span className="numeric-adaptive-arrows"><button type="button" tabIndex={-1} aria-label={`增大${label}`} disabled={disabled||!valid} onPointerDown={event=>event.preventDefault()} onClick={()=>step(1)}>▴</button><button type="button" tabIndex={-1} aria-label={`减小${label}`} disabled={disabled||!valid||field==='multiplicity'&&Number(text)<=1} onPointerDown={event=>event.preventDefault()} onClick={()=>step(-1)}>▾</button></span></span>;
  }
  return <section className={embedded?'base-electronic-state-card':'base-electronic-state-card shared-input-card'} aria-label="基础电荷与自旋多重度" data-input-section="electronic-state" data-state={error?'error':disabled?'unavailable':confirmed?'confirmed':'pending'}>
    {!embedded&&<header className="shared-input-card-header"><h3>电荷与自旋多重度</h3>{onReset&&<InputSettingsAction reset ariaLabel="恢复电子态默认" onClick={onReset}>恢复默认</InputSettingsAction>}</header>}
    <InputSettingsRow className="base-electronic-state-fields">
      <InputSettingsField label={chargeFieldLabel}>{rawText?rawField('charge',chargeLabel):<NumericInput aria-label={chargeLabel} stepper step="1" disabled={disabled} value={shown(charge)} onChange={event => onChargeChange(edited(event.target.value))} />}</InputSettingsField>
      <InputSettingsField label="自旋多重度">{rawText?rawField('multiplicity',multiplicityLabel):<NumericInput aria-label={multiplicityLabel} stepper step="1" min="1" disabled={disabled} value={shown(multiplicity)} onChange={event => onMultiplicityChange(edited(event.target.value))} />}</InputSettingsField>
      {onConfirm&&<button type="button" className="button button-primary electronic-state-confirm" aria-label={confirmationLabel??'确认基础电子态'} disabled={disabled||!!error||confirmed} onClick={onConfirm}>{confirmed?'已确认':'确认'}</button>}
    </InputSettingsRow>
    {error && <DismissibleNotice className="base-electronic-state-error" role="alert">{error}</DismissibleNotice>}
    {children}
  </section>;
}
