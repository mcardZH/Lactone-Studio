import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import './workspace-tab.css';

type TabDataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
export interface WorkspaceTabProps {
  label:ReactNode;dirty?:boolean;active:boolean;onActivate():void;actions?:ReactNode;className?:string;
  containerProps?:HTMLAttributes<HTMLDivElement>&TabDataAttributes;
  buttonProps?:Omit<ButtonHTMLAttributes<HTMLButtonElement>,'type'|'role'|'aria-selected'|'children'|'onClick'>&TabDataAttributes;
}
/** Same title/dirty layout also fits the independent window's existing drag root. */
export function WorkspaceTabTitle({children,dirty=false,className=''}:{children:ReactNode;dirty?:boolean;className?:string}){
  return <span className={`workspace-tab-title ${className}`}><span className="workspace-tab-title-text">{children}</span>{dirty&&<span className="workspace-tab-dirty">{' *'}</span>}</span>;
}
/** Action events never become a title activation or a tab/window drag. */
export function WorkspaceTabActions({children}:{children:ReactNode}){
  return <span className="workspace-tab-actions" data-workspace-tab-actions="true" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>{children}</span>;
}
/** Only shared chrome: callers keep close, confirmation and drag authority. */
export default function WorkspaceTab({label,dirty=false,active,onActivate,actions,className='',containerProps,buttonProps}:WorkspaceTabProps){
  return <div {...containerProps} className={`workspace-tab ${className}${active?' active is-active':''}`}>
    <button type="button" role="tab" aria-selected={active} onClick={onActivate} {...buttonProps} className={`workspace-tab-label ${buttonProps?.className??''}`}><WorkspaceTabTitle dirty={dirty}>{label}</WorkspaceTabTitle></button>{actions&&<WorkspaceTabActions>{actions}</WorkspaceTabActions>}
  </div>;
}
