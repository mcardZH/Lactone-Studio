import { useRef, useState } from 'react';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import BondPerceptionParameters from './BondPerceptionParameters';
import {useTransientLayer} from '../TransientLayer';

export type BondPerceptionMethod = 'empirical' | 'gfn2';
export default function BondPerceptionControls({ method, disabled, periodic=false, periodicGfn2Available=false, elements=[], parameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS, onMethodChange, onPerceive }: {
  method: BondPerceptionMethod; disabled: boolean; periodic?:boolean; periodicGfn2Available?:boolean;
  elements?:string[]; parameters?:EmpiricalBondPerceptionParameters;
  onMethodChange(value: BondPerceptionMethod): void; onPerceive(parameters?:EmpiricalBondPerceptionParameters): void;
}) {
  const [open,setOpen]=useState(false),[parameterOpen,setParameterOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const methodTrigger=useRef<HTMLButtonElement>(null),methodPopup=useRef<HTMLDivElement>(null);
  useTransientLayer({open:open&&!disabled,triggerRef:methodTrigger,contentRef:methodPopup,onDismiss:()=>setOpen(false)});
  const label=method==='gfn2'?'GFN2-xTB辅助':'经验判断',unavailable=periodic&&method==='gfn2'&&!periodicGfn2Available;
  return <div ref={root} className="model-bond-perception-controls" data-testid="bond-perception-controls" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node)){setOpen(false);setParameterOpen(false);}}} onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);setParameterOpen(false);event.stopPropagation();}}}>
    <button ref={trigger} type="button" disabled={disabled||unavailable} title={'判断成键 · '+label} aria-expanded={method==='empirical'?parameterOpen&&!disabled:undefined} onClick={()=>{if(disabled||unavailable)return;setOpen(false);if(method==='empirical')setParameterOpen(!parameterOpen);else onPerceive();}}>判断成键</button>
    <button ref={methodTrigger} type="button" className="model-bond-perception-menu-toggle" disabled={disabled} aria-label="选择成键判断方式" aria-expanded={open&&!disabled} title={'当前：'+label} onClick={()=>{if(!disabled){setParameterOpen(false);setOpen(!open);}}}>▾</button>
    {open&&!disabled&&<div ref={methodPopup} className="model-bond-perception-menu" role="menu" aria-label="成键判断方式">
      {([['empirical','经验判断'],['gfn2','GFN2-xTB辅助']] as const).map(([value,text])=><button type="button" role="menuitemradio" aria-checked={method===value} disabled={periodic&&value==='gfn2'&&!periodicGfn2Available} title={periodic&&value==='gfn2'&&!periodicGfn2Available?'周期GFN2辅助尚未通过当前后端验证':undefined} key={value} onClick={()=>{if(!disabled&&!(periodic&&value==='gfn2'&&!periodicGfn2Available)){onMethodChange(value);setOpen(false);}}}>{text}</button>)}
    </div>}
    {parameterOpen&&!disabled&&method==='empirical'&&<BondPerceptionParameters anchor={trigger} elements={elements} initial={parameters} onCancel={()=>setParameterOpen(false)} onApply={value=>{setParameterOpen(false);onPerceive(value);}}/>}
  </div>;
}
