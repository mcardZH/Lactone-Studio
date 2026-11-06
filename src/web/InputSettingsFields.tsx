import { useId,useState,type ReactNode } from 'react';
import {useProjectState} from '../projects/ui-state';
import './shared-input-settings.css';

export interface InputSettingsCardProps { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; sectionKey?: string; ariaLabel?: string; status?: 'pending'|'error'|'confirmed'|'unavailable'; testId?:string; field?:string; tabIndex?:number; level?:'card'|'subcard'|'inline';collapsible?:boolean }
export function inputSettingsCardClass(level:InputSettingsCardProps['level']='card',className='') {
  return `shared-input-card${level==='card'?'':` shared-input-${level}`} ${className}`;
}
export function InputSettingsCard({ title, children, className = '', actions, sectionKey, ariaLabel, status, testId, field, tabIndex, level='card',collapsible=false }: InputSettingsCardProps) {
  const [collapsed,setCollapsed]=useProjectState('input-card.collapsed',false,sectionKey??testId??ariaLabel??(typeof title==='string'?title:className)),bodyId=useId();
  return <section className={inputSettingsCardClass(level,className)} data-input-section={sectionKey} aria-label={ariaLabel} data-state={status} data-testid={testId} data-field={field} tabIndex={tabIndex}>
    {(title||actions)&&<header className="shared-input-card-header">{title && <h3 className="shared-input-card-title">{collapsible?<button type="button" className="analysis-card-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={()=>setCollapsed(value=>!value)}><span aria-hidden="true">{collapsed?'▸':'▾'}</span>{title}</button>:title}</h3>}{actions&&<div className="shared-input-card-actions">{actions}</div>}</header>}
    {collapsible?<div className="shared-input-card-body" id={bodyId} hidden={collapsed}>{children}</div>:children}
  </section>;
}

export function InputSettingsRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={'shared-input-row ' + className}>{children}</div>;
}

/** A controlled presentation field. State and scientific defaults belong to its caller. */
export function InputSettingsField({ label, children, className = '', caption }: { label: ReactNode; children: ReactNode; className?: string; caption?: ReactNode }) {
  return <label className={'shared-input-field field ' + className}>
    <span className="shared-input-field-label">{label}</span>
    <span className="shared-input-field-control">{children}</span>
    {caption&&<small className="shared-input-field-caption">{caption}</small>}
  </label>;
}
