import { useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {X} from 'lucide-react';
import './workspace-tab.css';

type TabDataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
export interface WorkspaceTabProps {
  label:ReactNode;dirty?:boolean;active:boolean;onActivate(event:MouseEvent<HTMLButtonElement>):void;actions?:ReactNode;className?:string;
  containerProps?:HTMLAttributes<HTMLDivElement>&TabDataAttributes;
  buttonProps?:Omit<ButtonHTMLAttributes<HTMLButtonElement>,'type'|'role'|'aria-selected'|'children'|'onClick'>&TabDataAttributes;
  editor?:ReactNode;
}
/** Identical artwork and dimensions for document, group and detached tab closes. */
export function WorkspaceTabCloseIcon(){return <X size={12} className="workspace-tab-close-icon" aria-hidden="true"/>;}
/** Same title/dirty layout also fits the independent window's existing drag root. */
export function WorkspaceTabTitle({children,dirty=false,className=''}:{children:ReactNode;dirty?:boolean;className?:string}){
  return <span className={`workspace-tab-title ${className}`}><span className="workspace-tab-title-text" title={typeof children==='string'||typeof children==='number'?String(children):undefined}>{children}</span>{dirty&&<span className="workspace-tab-dirty">{' *'}</span>}</span>;
}
/** Action events never become a title activation or a tab/window drag. */
export function WorkspaceTabActions({children}:{children:ReactNode}){
  return <span className="workspace-tab-actions" data-workspace-tab-actions="true" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>{children}</span>;
}
/** Only shared chrome: callers keep close, confirmation and drag authority. */
export default function WorkspaceTab({label,dirty=false,active,onActivate,actions,className='',containerProps,buttonProps,editor}:WorkspaceTabProps){
  return <div {...containerProps} className={`workspace-tab ${className}${active?' active is-active':''}`}>
    {editor??<button type="button" role="tab" aria-selected={active} onClick={onActivate} {...buttonProps} className={`workspace-tab-label ${buttonProps?.className??''}`}><WorkspaceTabTitle dirty={dirty}>{label}</WorkspaceTabTitle></button>}{actions&&<WorkspaceTabActions>{actions}</WorkspaceTabActions>}
  </div>;
}

export function WorkspaceTabNameEditor({label,name,onFinish}:{label:string;name:string;onFinish(value?:string):void}){
  const field=useRef<HTMLInputElement>(null),finished=useRef(false);
  useEffect(()=>{field.current?.focus();field.current?.select();},[]);
  function finish(value?:string){
    if(finished.current)return;
    finished.current=true;
    onFinish(value?.trim()||undefined);
  }
  return <input ref={field} className="workspace-tab-name-editor" aria-label={label} defaultValue={name}
    onBlur={event=>finish(event.currentTarget.value)} onKeyDown={event=>{
      if(event.key!=='Enter'&&event.key!=='Escape')return;
      event.preventDefault();event.stopPropagation();
      finish(event.key==='Enter'?event.currentTarget.value:undefined);
    }}/>;
}

export interface WorkspaceTabMenuAnchor { owner:Document; x:number; y:number; returnTo:HTMLElement }
export function WorkspaceTabMenu({anchor,onRename,onClose}:{anchor:WorkspaceTabMenuAnchor;onRename():void;onClose():void}){
  const menu=useRef<HTMLDivElement>(null);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const element=menu.current;
    if(!element)return;
    const viewport=anchor.owner.documentElement,box=element.getBoundingClientRect();
    element.style.left=`${Math.max(0,Math.min(anchor.x,viewport.clientWidth-box.width))}px`;
    element.style.top=`${Math.max(0,Math.min(anchor.y,viewport.clientHeight-box.height))}px`;
    element.querySelector('button')?.focus();
    const dismiss=(event:PointerEvent)=>{if(!element.contains(event.target as Node))close.current();};
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.stopPropagation();close.current();anchor.returnTo.focus();}
    };
    anchor.owner.addEventListener('pointerdown',dismiss,true);anchor.owner.addEventListener('keydown',key,true);
    return ()=>{anchor.owner.removeEventListener('pointerdown',dismiss,true);anchor.owner.removeEventListener('keydown',key,true);};
  },[anchor]);
  return createPortal(<div ref={menu} className="workspace-tab-context-menu" role="menu" aria-label="标签操作">
    <button type="button" role="menuitem" onClick={onRename}>重命名</button>
  </div>,anchor.owner.body);
}
