import type { ReactNode } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { InputSettingsCard, InputSettingsRow, inputSettingsCardClass, type InputSettingsCardProps } from './InputSettingsFields';

/** Shared presentation only. Callers keep engine-specific state and writer rules. */
export function InputSettingsLayout({ children, className='' }: { children:ReactNode; className?:string }) {
  return <div className={'input-settings-layout input-settings-surface '+className}>{children}</div>;
}
export function InputSettingsSection({ collapsible=false, defaultOpen=false, ...props }: InputSettingsCardProps & { collapsible?:boolean; defaultOpen?:boolean }) {
  if(!collapsible)return <InputSettingsCard {...props}/>;
  return <details className={inputSettingsCardClass(props.level,'shared-input-section '+(props.className??''))} data-input-section={props.sectionKey} aria-label={props.ariaLabel} data-state={props.status} data-testid={props.testId} data-field={props.field} tabIndex={props.tabIndex} open={defaultOpen||undefined}>
    <summary className="shared-input-card-title"><span>{props.title}</span>{props.actions&&<div className="shared-input-card-actions">{props.actions}</div>}</summary>
    {props.children}
  </details>;
}
export function InputSettingsAction({ children, onClick, disabled=false, ariaLabel, reset=false, variant }: { children:ReactNode; onClick():void; disabled?:boolean; ariaLabel?:string; reset?:boolean; variant?:'primary'|'surface' }) {
  return <button type="button" className={'shared-input-action'+(variant==='primary'?' button button-primary':'')} data-input-action="true" data-input-reset={reset||undefined} data-input-variant={variant} title={reset?ariaLabel??'恢复默认':undefined} aria-label={ariaLabel} disabled={disabled} onClick={event=>{if(reset){event.preventDefault();event.stopPropagation();}onClick();}}>{reset&&<RotateCcw size={14}/>}<span>{children}</span></button>;
}
/** Controlled enablement: callers own effective settings and retained drafts. */
export function InputSettingsEnableCard({ enabled, onEnabledChange, disabled=false, switchLabel, children, title, className='', actions, ...props }: InputSettingsCardProps & { enabled:boolean; onEnabledChange(enabled:boolean):void; disabled?:boolean; switchLabel?:string }) {
  return <section className={inputSettingsCardClass(props.level,'shared-input-enable-card '+className)} data-input-section={props.sectionKey} aria-label={props.ariaLabel} data-testid={props.testId} data-field={props.field} tabIndex={props.tabIndex} data-enabled={enabled}>
    <header className="shared-input-card-header"><button type="button" className="shared-input-enable-toggle" role="switch" aria-label={switchLabel} aria-checked={enabled} disabled={disabled} onClick={()=>onEnabledChange(!enabled)}><span className="shared-input-switch-track" aria-hidden="true"><span/></span><span className="shared-input-card-title">{title}</span></button>{actions&&<div className="shared-input-card-actions">{actions}</div>}</header>
    {enabled&&<div className="shared-input-enable-content">{children}</div>}
  </section>;
}
export function InputSettingsReferenceRow({children}:{children:ReactNode}) {
  return <InputSettingsRow className="shared-reference-row">{children}</InputSettingsRow>;
}
export function InputSettingsCheckbox({label,checked,onChange,disabled=false,ariaLabel,className=''}:{label:ReactNode;checked:boolean;onChange(checked:boolean):void;disabled?:boolean;ariaLabel?:string;className?:string}) {
  return <label className={'shared-input-checkbox check-line '+className}><input type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={event=>onChange(event.target.checked)}/><span>{label}</span></label>;
}
export function InputTaskChoice({label,code,icon,selected,onSelect,disabled=false,title,testId}:{label:string;code:string;icon:ReactNode;selected:boolean;onSelect():void;disabled?:boolean;title?:string;testId?:string}) {
  return <button type="button" className={'task-card shared-task-choice'+(selected?' selected':'')} aria-pressed={selected} disabled={disabled} title={title} data-testid={testId} onClick={()=>{if(!disabled)onSelect();}}><span className="task-top"><span className="task-icon" aria-hidden="true">{icon}</span><strong className="task-title">{label}</strong><span className="task-code">{code}</span><span className="task-check" aria-hidden="true">{selected&&<Check size={12}/>}</span></span></button>;
}
