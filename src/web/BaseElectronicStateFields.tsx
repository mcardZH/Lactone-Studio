import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import ElectronicStateWarning from './ElectronicStateWarning';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {Atom} from '../core/types';
import {pairEditedElectronicState,type BaseElectronicStateValues,type ElectronicStateEditField} from '../core/base-electronic-state';
import {electronicStateParameterError} from '../core/elements';
import './base-electronic-state.css';
import { InputSettingsAction } from './InputSettingsLayout';
import { InputSettingsField, InputSettingsNumericControl, InputSettingsRow } from './InputSettingsFields';

export function electronicStateIntegerInput({text,field,label,disabled,onChange,onBlur,onCommit,invalid}:{text:string;field:'charge'|'multiplicity';label:string;disabled?:boolean;onChange(text:string):void;onBlur?():void;onCommit?(text:string):void;invalid?:boolean}){
  const valid=/^[+-]?\d+$/.test(text)&&Number.isSafeInteger(Number(text));
  const step=(direction:number)=>{if(!valid)return;const next=Number(text)+direction;if(!Number.isSafeInteger(next)||field==='multiplicity'&&next<1)return;onChange(String(next));onCommit?.(String(next));};
  return <span className="numeric-adaptive"><input type="text" inputMode="numeric" role="spinbutton" aria-label={label} disabled={disabled} value={text}
    aria-invalid={invalid||undefined} aria-valuenow={valid?Number(text):undefined} aria-valuemin={field==='multiplicity'?1:undefined}
    className="numeric-input-direct" onChange={event=>onChange(event.target.value)} onBlur={event=>{onCommit?.(event?.currentTarget.value??text);onBlur?.();}}
    onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Enter'){event.preventDefault();onCommit?.(event.currentTarget.value);}else if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();step(event.key==='ArrowUp'?1:-1);}}}/>
    <span className="numeric-adaptive-arrows"><button type="button" tabIndex={-1} aria-label={`增大${label}`} disabled={disabled||!valid} onPointerDown={event=>event.preventDefault()} onClick={()=>step(1)}>▴</button><button type="button" tabIndex={-1} aria-label={`减小${label}`} disabled={disabled||!valid||field==='multiplicity'&&Number(text)<=1} onPointerDown={event=>event.preventDefault()} onClick={()=>step(-1)}>▾</button></span></span>;
}

export interface BaseElectronicStateFieldsProps {
  charge: number;
  multiplicity: number;
  disabled?: boolean;
  confirmationDisabled?:boolean;
  error?: string | null;
  warning?:string|null;
  confirmed?: boolean;
  chargeLabel?: string;
  multiplicityLabel?: string;
  onChargeChange: (charge: number) => void;
  onMultiplicityChange: (multiplicity: number) => void;
  onConfirm?: (values?:BaseElectronicStateValues) => void;
  onReset?:()=>void;
  confirmationLabel?: string;
  confirmButtonText?: string;
  children?: ReactNode;
  /** Optional lossless draft channel. Legacy numeric consumers are unchanged. */
  rawText?: { charge: string; multiplicity: string };
  onRawTextChange?: (field: 'charge' | 'multiplicity', text: string) => void;
  onRawTextBlur?: (field: 'charge' | 'multiplicity') => void;
  /** Synchronous field submission with the actual text, including step/Enter. */
  onRawTextCommit?: (field: 'charge' | 'multiplicity', text: string) => void;
  rawInvalid?: { charge: boolean; multiplicity: boolean };
  embedded?: boolean;
  chargeFieldLabel?: string;
  preserveNumericDraft?:boolean;
  /** Numeric-mode consumers submit the pair once for this exact atom scope. */
  atoms?:readonly Atom[];
  onElectronicStateChange?:(values:BaseElectronicStateValues)=>void;
}

/** Compact controlled base-state fields. The owning workflow supplies its
 * explicit confirmation action; this component never confirms a task or source. */
function PairedNumericElectronicFields(props:BaseElectronicStateFieldsProps){
  const [pairingIssue,setPairingIssue]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const initial=()=>({charge:Number.isFinite(props.charge)?String(props.charge):'',multiplicity:Number.isFinite(props.multiplicity)?String(props.multiplicity):''});
  const [raw,setRaw]=useState(initial),current=useRef(raw),lastField=useRef<ElectronicStateEditField|null>(null);
  const integer=(text:string)=>/^[+-]?\d+$/.test(text)&&Number.isSafeInteger(Number(text))?Number(text):NaN;
  useEffect(()=>{if(Object.is(integer(current.current.charge),props.charge)&&Object.is(integer(current.current.multiplicity),props.multiplicity)){if(!electronicStateParameterError(props.charge,props.multiplicity)){setPending(false);lastField.current=null;}return;}const next=initial();current.current=next;setRaw(next);lastField.current=null;setPending(false);setPairingIssue(null);},[props.charge,props.multiplicity]);
  const change=(field:ElectronicStateEditField,text:string)=>{
    const next={...current.current,[field]:text};current.current=next;lastField.current=field;setRaw(next);setPending(true);setPairingIssue(null);
    // Numeric-mode owners are input drafts (fragments/links/product), not a
    // running model. Retain their established invalid-parameter channel so a
    // partial text cannot be hidden behind an older, valid input configuration.
    const value=integer(text);if(!Number.isSafeInteger(value)||field==='multiplicity'&&value<1)(field==='charge'?props.onChargeChange:props.onMultiplicityChange)(value);
  };
  const submit=(field:ElectronicStateEditField,text:string,apply=true)=>{
    if(lastField.current!==field&&text===current.current[field])return;
    const draft={...current.current,[field]:text};current.current=draft;setRaw(draft);
    if(!/^[+-]?\d+$/.test(draft.charge)||!/^\+?\d+$/.test(draft.multiplicity))return;
    const values={charge:Number(draft.charge),multiplicity:Number(draft.multiplicity)};
    const result=pairEditedElectronicState(props.atoms!,values,field,values[field]);setPairingIssue(result.error);
    if(!result.error){const next={charge:String(result.values.charge),multiplicity:String(result.values.multiplicity)};current.current=next;setRaw(next);lastField.current=null;}
    // A representable, unmatched pair remains an unconfirmed input draft. Its
    // explicit confirmation/writer retains the original parameter contract.
    if(apply)props.onElectronicStateChange!(result.error?values:result.values);
  };
  const parameters=/^[+-]?\d+$/.test(raw.charge)&&/^\+?\d+$/.test(raw.multiplicity)?{charge:Number(raw.charge),multiplicity:Number(raw.multiplicity)}:null;
  const parameterIssue=parameters?electronicStateParameterError(parameters.charge,parameters.multiplicity):'电荷须为整数，多重度须为正整数。';
  return <BaseElectronicStateFields {...props} atoms={undefined} onElectronicStateChange={undefined}
    rawText={raw} onRawTextChange={change} onRawTextCommit={submit} confirmed={props.confirmed&&!pending} error={props.error||parameterIssue} warning={pairingIssue||props.warning}
    onConfirm={props.onConfirm?()=>{if(lastField.current)submit(lastField.current,current.current[lastField.current],false);const values={charge:Number(current.current.charge),multiplicity:Number(current.current.multiplicity)};if(!current.current.charge.trim()||!current.current.multiplicity.trim()||electronicStateParameterError(values.charge,values.multiplicity))return;setPending(false);props.onConfirm!(values);}:undefined}/>;
}
export default function BaseElectronicStateFields(props:BaseElectronicStateFieldsProps) {
  if(props.atoms&&props.onElectronicStateChange&&!props.rawText)return <PairedNumericElectronicFields {...props}/>;
  const { charge, multiplicity, disabled = false, confirmationDisabled=false, error, warning, confirmed = false,
  chargeLabel = '总电荷', multiplicityLabel = '自旋多重度', onChargeChange, onMultiplicityChange, onConfirm, confirmationLabel, confirmButtonText='确认', children, onReset,
  rawText,onRawTextChange,onRawTextBlur,onRawTextCommit,rawInvalid,embedded=false,chargeFieldLabel='总电荷',preserveNumericDraft=false,atoms,onElectronicStateChange,
  }=props;
  const submitNumeric=(field:ElectronicStateEditField,value:number)=>(field==='charge'?onChargeChange:onMultiplicityChange)(value);
  const shown = (value: number) => Number.isFinite(value) ? value : '';
  const edited = (text: string) => text === '' ? Number.NaN : Number(text);
  function rawField(field:'charge'|'multiplicity',label:string){
    return electronicStateIntegerInput({text:rawText![field],field,label,disabled,invalid:rawInvalid?.[field],onChange:text=>onRawTextChange?.(field,text),onBlur:()=>onRawTextBlur?.(field),onCommit:text=>onRawTextCommit?.(field,text)});
  }
  return <section className={embedded?'base-electronic-state-card':'base-electronic-state-card shared-input-card'} aria-label="基础电荷与自旋多重度" data-input-section="electronic-state" data-state={error?'error':disabled?'unavailable':confirmed?'confirmed':'pending'}>
    {!embedded&&<header className="shared-input-card-header"><h3 className="shared-input-card-title">电荷与自旋多重度</h3>{onReset&&<InputSettingsAction reset ariaLabel="恢复电子态默认" onClick={onReset}>恢复默认</InputSettingsAction>}</header>}
    <InputSettingsRow className="base-electronic-state-fields">
      <InputSettingsField label={chargeFieldLabel} controlWidth="short">{rawText?rawField('charge',chargeLabel):preserveNumericDraft?<InputSettingsNumericControl ariaLabel={chargeLabel} step={1} integer disabled={disabled} value={charge} onValue={value=>submitNumeric('charge',value)}/>:<NumericInput aria-label={chargeLabel} stepper step="1" disabled={disabled} value={shown(charge)} onChange={event => submitNumeric('charge',edited(event.target.value))} />}</InputSettingsField>
      <InputSettingsField label="自旋多重度" controlWidth="short">{rawText?rawField('multiplicity',multiplicityLabel):preserveNumericDraft?<InputSettingsNumericControl ariaLabel={multiplicityLabel} step={1} integer min={1} disabled={disabled} value={multiplicity} onValue={value=>submitNumeric('multiplicity',value)}/>:<NumericInput aria-label={multiplicityLabel} stepper step="1" min="1" disabled={disabled} value={shown(multiplicity)} onChange={event => submitNumeric('multiplicity',edited(event.target.value))} />}</InputSettingsField>
      {onConfirm&&<button type="button" className="button button-primary electronic-state-confirm" aria-label={confirmationLabel??'确认基础电子态'} disabled={disabled||confirmationDisabled||!!error||confirmed} onClick={()=>onConfirm()}>{confirmed?'已确认':confirmButtonText}</button>}
      <ElectronicStateWarning message={warning}/>
    </InputSettingsRow>
    {error && <DismissibleNotice className="base-electronic-state-error" role="alert">{error}</DismissibleNotice>}
    {children}
  </section>;
}
