import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {useTransientLayer} from './TransientLayer';
import './iteration-seven.css';
import './iteration-eight.css';
import './shared-input-settings.css';
export interface CardOption { value:string; label:string; summary?:ReactNode; body:ReactNode; disabled?:boolean }
export default function CardDropdown({label,displayLabel=label,triggerLabel,value,options,disabled=false,onChange,footer,layout='compact'}:{label:string;displayLabel?:string;triggerLabel?:ReactNode;value:string;options:CardOption[];disabled?:boolean;onChange:(value:string)=>void;footer?:ReactNode;layout?:'compact'|'catalog'}){
  const id=useId();const root=useRef<HTMLDivElement>(null);const popup=useRef<HTMLDivElement>(null);const trigger=useRef<HTMLButtonElement>(null);const [open,setOpen]=useState(false);const [active,setActive]=useState(0);
  const wide=layout==='catalog';
  const [position,setPosition]=useState({left:16,top:16,width:600,maxHeight:600});
  const selected=options.find(option=>option.value===value);
  useTransientLayer({open,triggerRef:trigger,contentRef:popup,onDismiss:()=>setOpen(false),peerGroup:'card-dropdown'});
  useLayoutEffect(()=>{
    if(!open||!wide)return;
    const owner=trigger.current?.ownerDocument.defaultView;if(!owner)return;
    const place=()=>{const rect=trigger.current?.getBoundingClientRect();if(!rect)return;const margin=12,width=Math.max(1,Math.min(1120,owner.innerWidth-2*margin));const below=owner.innerHeight-rect.bottom-margin-6,above=rect.top-margin-6;const down=below>=Math.min(480,above);const maxHeight=Math.max(80,down?below:above);setPosition({left:Math.max(margin,Math.min(rect.left+(rect.width-width)/2,owner.innerWidth-width-margin)),top:down?rect.bottom+6:Math.max(margin,rect.top-6-Math.min(650,maxHeight)),width,maxHeight:Math.min(650,maxHeight)});};
    place();owner.addEventListener('resize',place);owner.addEventListener('scroll',place,true);return()=>{owner.removeEventListener('resize',place);owner.removeEventListener('scroll',place,true);};
  },[open,wide]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(!open)return;const list=popup.current?.querySelector<HTMLElement>('[role=listbox]'),option=list?.querySelector<HTMLElement>('[data-active=true]');if(!list||!option)return;const item=option.getBoundingClientRect(),bounds=list.getBoundingClientRect();if(item.top<bounds.top)list.scrollTop-=bounds.top-item.top;else if(item.bottom>bounds.bottom)list.scrollTop+=item.bottom-bounds.bottom;},[active,open]);
  function toggle(){setOpen(previous=>!previous);setActive(Math.max(0,options.findIndex(option=>option.value===value)));}
  function select(index:number){const option=options[index];if(option&&!option.disabled){onChange(option.value);setOpen(false);trigger.current?.focus();}}
  function move(direction:number){let index=active;for(let n=0;n<options.length;n++){index=(index+direction+options.length)%options.length;if(!options[index].disabled){setActive(index);return;}}}
  const panel=open&&<div ref={popup} className={'card-dropdown-popup'+(wide?' method-catalog-popup catalog-popup':'')} data-layout={layout} style={wide?position:undefined}><div id={id+'-list'} role="listbox" aria-label={label+'候选'}>{options.map((option,index)=><div key={option.value} id={id+'-option-'+index} role="option" aria-selected={value===option.value} aria-disabled={!!option.disabled} data-value={option.value} data-active={index===active} className={'dropdown-option '+(value===option.value?'selected':'')} onPointerMove={event=>{if(event.movementX||event.movementY)setActive(index);}} onClick={()=>select(index)}><div className="dropdown-option-title"><strong>{option.label}</strong>{value===option.value&&<Check size={15}/>}</div>{option.body}</div>)}</div>{footer&&<div className="card-dropdown-footer">{footer}</div>}</div>;
  return <div ref={root} className="card-dropdown"><label id={id+'-label'} className="card-dropdown-label">{displayLabel}</label><button ref={trigger} type="button" role="combobox" data-value={value} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id+'-list'} aria-activedescendant={open?id+'-option-'+active:undefined} disabled={disabled} className="card-dropdown-trigger" onClick={toggle} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Home','End','Enter',' ','Escape','Tab'].includes(event.key)){if(event.key==='Tab'){setOpen(false);return;}event.preventDefault();if(event.key==='Escape'){setOpen(false);return;}if(!open){toggle();return;}if(event.key==='ArrowDown')move(1);else if(event.key==='ArrowUp')move(-1);else if(event.key==='Home')setActive(0);else if(event.key==='End')setActive(options.length-1);else select(active);}}}><span><strong>{triggerLabel??selected?.label??value}</strong>{selected?.summary&&<span className="card-dropdown-summary">{selected.summary}</span>}</span><ChevronDown size={16}/></button>
    {wide&&panel?createPortal(panel,trigger.current!.ownerDocument.body):panel}
  </div>;
}
