import { useId,useState,type ReactNode } from 'react';
import {useProjectState} from '../projects/ui-state';
import {adaptiveNumericStep} from './numeric-step';
import './numeric-input.css';
import './shared-input-settings.css';

export interface InputSettingsCardProps { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; titleRole?:'subcard'; sectionKey?: string; ariaLabel?: string; status?: 'pending'|'error'|'confirmed'|'unavailable'; testId?:string; field?:string; tabIndex?:number; level?:'card'|'subcard'|'inline';collapsible?:boolean;stack?:boolean;disclosure?:{collapsed:boolean;onChange(next:boolean):void} }
/** An explicit subcard title keeps the same role when the header is hosted
 * inside a selection field rather than directly inside its surrounding card. */
export function InputSettingsCardHeader({title,actions,titleRole}:{title?:ReactNode;actions?:ReactNode;titleRole?:'subcard'}) {
  return <header className="shared-input-card-header">{title&&<h3 className="shared-input-card-title" data-input-title-role={titleRole}
    style={titleRole==='subcard'?{fontSize:'var(--ui-control-font)',lineHeight:'var(--ui-control-line)',fontWeight:600,color:'var(--ui-section-ink)'}:undefined}>{title}</h3>}{actions&&<div className="shared-input-card-actions">{actions}</div>}</header>;
}
export function inputSettingsCardClass(level:InputSettingsCardProps['level']='card',className='') {
  return `shared-input-card${level==='card'?'':` shared-input-${level}`} ${className}`;
}
export function InputSettingsCard({ title, children, className = '', actions, titleRole, sectionKey, ariaLabel, status, testId, field, tabIndex, level='card',collapsible=false,stack=false,disclosure }: InputSettingsCardProps) {
  const [storedCollapsed,setStoredCollapsed]=useProjectState<boolean | undefined>('input-card.collapsed',disclosure ? undefined : false,sectionKey??testId??ariaLabel??(typeof title==='string'?title:className)),bodyId=useId();
  const canCollapse=collapsible || disclosure!==undefined;
  const collapsed=disclosure?.collapsed ?? storedCollapsed ?? false;
  function toggle() {
    if(disclosure) disclosure.onChange(!collapsed);
    else setStoredCollapsed(value=>!value);
  }
  const body=stack?<InputSettingsStack>{children}</InputSettingsStack>:children;
  return <section className={inputSettingsCardClass(level,className)} data-input-section={sectionKey} aria-label={ariaLabel} data-state={status} data-testid={testId} data-field={field} tabIndex={tabIndex}>
    {(title||actions)&&<InputSettingsCardHeader title={title&&(canCollapse?<button type="button" className="shared-input-card-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={toggle}><span aria-hidden="true">{collapsed?'▸':'▾'}</span><span className="shared-input-card-title-text">{title}</span></button>:title)} actions={actions} titleRole={titleRole}/>}
    {canCollapse?<div className="shared-input-card-body" id={bodyId} hidden={collapsed}>{body}</div>:body}
  </section>;
}

export function InputSettingsStack({ children, className = '', kind = 'fields' }: { children: ReactNode; className?: string; kind?: 'fields'|'cards' }) {
  return <div className={'shared-input-stack ' + className} data-input-stack={kind}>{children}</div>;
}

export function InputSettingsRow({ children, className = '', variant }: { children: ReactNode; className?: string; variant?: 'actions' }) {
  return <div className={'shared-input-row ' + className} data-input-row={variant}>{children}</div>;
}

/** A controlled presentation field. State and scientific defaults belong to its caller. */
export function InputSettingsField({ label, children, className = '', caption, controlWidth, unit }: { label: ReactNode; children: ReactNode; className?: string; caption?: ReactNode; unit?:ReactNode;
  controlWidth?: 'short'|'number'|'long-number'|'text'|'select'|'full' }) {
  return <label className={'shared-input-field field ' + className} data-input-width={controlWidth}>
    <span className="shared-input-field-label">{label}</span>
    <span className="shared-input-field-control">{children}{unit!=null&&<span className="shared-input-field-unit">{unit}</span>}</span>
    {caption&&<small className="shared-input-field-caption">{caption}</small>}
  </label>;
}

/** The owner receives numbers, while unfinished decimals/exponents stay editable as typed. */
export function InputSettingsNumericControl({value,onValue,onCommit,ariaLabel,disabled=false,min,max,step,integer=false,invalid=false,scale=1}: {
  value:number; onValue(value:number):void; onCommit?(value:number):void; ariaLabel:string; disabled?:boolean;
  min?:number;max?:number;step?:number;integer?:boolean;invalid?:boolean;scale?:number;
}) {
  const number=(text:string)=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())&&Number.isFinite(Number(text))?Number(text):NaN;
  const canonical=Number.isFinite(value)?String(value/scale):'';
  const [draft,setDraft]=useState(canonical);
  const draftValue=number(draft)*scale;
  const equivalent=Object.is(draftValue,value)||draftValue===value;
  const text=equivalent?draft:canonical;
  if(!equivalent&&draft!==canonical)setDraft(canonical);
  const parsed=number(text);
  const valid=Number.isFinite(parsed)&&(!integer||Number.isSafeInteger(parsed))&&(min===undefined||parsed>=min)&&(max===undefined||parsed<=max);
  const change=(raw:string)=>{setDraft(raw);onValue(number(raw)*scale);};
  const increment=(direction:1|-1)=>{
    if(disabled||step===undefined)return;
    const next=adaptiveNumericStep(text,direction,step,min,max);
    if(next!==null)change(next);
  };
  const input=<input type="text" className="numeric-input-direct" inputMode={integer?'numeric':'decimal'} role={step===undefined?undefined:'spinbutton'}
    aria-label={ariaLabel} aria-invalid={invalid||!valid||undefined} aria-valuenow={step!==undefined&&valid?parsed:undefined}
    aria-valuemin={step!==undefined?min:undefined} aria-valuemax={step!==undefined?max:undefined} disabled={disabled} value={text}
    onChange={event=>change(event.target.value)} onBlur={()=>onCommit?.(parsed*scale)} onKeyDown={event=>{
      if(step!==undefined&&!event.nativeEvent.isComposing&&(event.key==='ArrowUp'||event.key==='ArrowDown')){event.preventDefault();increment(event.key==='ArrowUp'?1:-1);}
    }}/>;
  return step===undefined?input:<span className="numeric-adaptive">{input}<span className="numeric-adaptive-arrows">
    <button type="button" tabIndex={-1} aria-label={`增大${ariaLabel}`} disabled={disabled} onPointerDown={event=>event.preventDefault()} onClick={()=>increment(1)}>▴</button>
    <button type="button" tabIndex={-1} aria-label={`减小${ariaLabel}`} disabled={disabled} onPointerDown={event=>event.preventDefault()} onClick={()=>increment(-1)}>▾</button>
  </span></span>;
}
