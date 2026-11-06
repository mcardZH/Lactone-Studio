import {DismissibleNotice} from '../DismissibleNotice';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { elementPairKey, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import {dialogSurfaceStyle} from '../DialogShell';
import './bond-perception-parameters.css';

export default function BondPerceptionParameters({anchor,initial,elements,onApply,onCancel}:{anchor:RefObject<HTMLElement|null>;initial:EmpiricalBondPerceptionParameters;elements:string[];onApply(value:EmpiricalBondPerceptionParameters):void;onCancel():void}){
  const [draft,setDraft]=useState(()=>structuredClone(initial)),[error,setError]=useState('');
  const panel=useRef<HTMLDivElement>(null),[position,setPosition]=useState({left:12,top:12});
  useLayoutEffect(()=>{
    const node=panel.current,trigger=anchor.current,owner=trigger?.ownerDocument.defaultView;if(!node||!trigger||!owner)return;
    const locate=()=>{
      const box=trigger.getBoundingClientRect(),width=node.getBoundingClientRect().width,height=node.getBoundingClientRect().height;
      const left=Math.max(12,Math.min(owner.innerWidth-width-12,box.right-width)),below=box.bottom+5,above=box.top-height-5;
      const top=Math.max(12,Math.min(owner.innerHeight-height-12,below+height<=owner.innerHeight-12?below:above>=12?above:below));
      setPosition(previous=>previous.left===left&&previous.top===top?previous:{left,top});
    };
    // Match the existing fragment/settings popovers: the browser top layer
    // owns clipping and hit testing while coordinates use this document.
    if(!node.matches(':popover-open'))node.showPopover();
    locate();const observer=new ResizeObserver(locate);observer.observe(node);
    owner.addEventListener('resize',locate);trigger.ownerDocument.addEventListener('scroll',locate,true);
    return()=>{observer.disconnect();owner.removeEventListener('resize',locate);trigger.ownerDocument.removeEventListener('scroll',locate,true);};
  },[anchor]);
  const present=[...new Set(elements)].sort(),[first,setFirst]=useState(present[0]??''),[second,setSecond]=useState(present[1]??present[0]??'');
  const update=(change:Partial<EmpiricalBondPerceptionParameters>)=>{setDraft({...draft,...change});setError('');};
  const factor=(key:'minDistanceFactor'|'maxDistanceFactor',label:string)=><label className="bond-perception-factor"><span>{label}</span><input type="range" aria-label={label+'滑杆'} min="0" max="3" step=".01" value={Number.isFinite(draft[key])?draft[key]:0} onChange={event=>update({[key]:Number(event.target.value)})}/><input type="number" aria-label={label} min="0" max="3" step=".01" value={Number.isNaN(draft[key])?'':draft[key]} onChange={event=>update({[key]:event.target.value===''?NaN:Number(event.target.value)})}/></label>;
  const apply=()=>{try{onApply(validateEmpiricalBondParameters(draft));}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}};
  return <div ref={panel} className="bond-perception-parameters" role="dialog" aria-modal="false" popover="auto" style={{...dialogSurfaceStyle(),...position}} aria-label="经验成键参数" data-testid="bond-perception-parameters" data-no-reorder="true"
    onToggle={event=>{if(event.newState==='closed'&&event.currentTarget.isConnected)onCancel();}}
    onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}
    onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();onCancel();return;}const target=event.target as HTMLElement;if(event.key==='Enter'&&target.tagName==='INPUT'&&(target as HTMLInputElement).type==='number'){event.preventDefault();apply();}}}>
    <div className="bond-perception-parameter-title">经验成键</div>
    {factor('minDistanceFactor','距离下限倍数')}{factor('maxDistanceFactor','距离上限倍数')}
    <label className="bond-perception-order-mode"><span>键型</span><select aria-label="经验成键键型" value={draft.bondOrderMode} onChange={event=>update({bondOrderMode:event.target.value as EmpiricalBondPerceptionParameters['bondOrderMode']})}><option value="auto-organic">自动有机键型</option><option value="connectivity-only">仅连接</option></select></label>
    <details><summary>高级</summary>
      <div className="bond-perception-pair-picker"><select aria-label="元素对第一个元素" value={first} onChange={event=>setFirst(event.target.value)}>{present.map(element=><option key={element}>{element}</option>)}</select><span>–</span><select aria-label="元素对第二个元素" value={second} onChange={event=>setSecond(event.target.value)}>{present.map(element=><option key={element}>{element}</option>)}</select><button type="button" disabled={!first||!second||draft.pairOverrides.some(entry=>elementPairKey(...entry.elements)===elementPairKey(first,second))} onClick={()=>update({pairOverrides:[...draft.pairOverrides,{elements:[first,second],minDistance:.35,maxDistance:2}]})}>添加距离覆盖</button></div>
      {draft.pairOverrides.map((entry,index)=><div className="bond-perception-pair-row" key={elementPairKey(...entry.elements)}><span>{entry.elements.join('–')}</span>{(['minDistance','maxDistance'] as const).map((key,i)=><input type="number" min="0" max="20" step=".01" key={key} aria-label={entry.elements.join('–')+(i?'距离上限 Å':'距离下限 Å')} value={Number.isNaN(entry[key])?'':entry[key]} onChange={event=>update({pairOverrides:draft.pairOverrides.map((item,j)=>j===index?{...item,[key]:event.target.value===''?NaN:Number(event.target.value)}:item)})}/>)}<span>Å</span><button type="button" aria-label={'删除'+entry.elements.join('–')+'距离覆盖'} onClick={()=>update({pairOverrides:draft.pairOverrides.filter((_,j)=>j!==index)})}>×</button></div>)}
      {!!present.length&&<div className="bond-perception-exclusions"><span>排除元素</span>{present.map(element=><label key={element}><input type="checkbox" aria-label={'排除元素'+element} checked={draft.excludedElements.includes(element)} onChange={event=>update({excludedElements:event.target.checked?[...draft.excludedElements,element]:draft.excludedElements.filter(item=>item!==element)})}/>{element}</label>)}</div>}
    </details>
    {error&&<DismissibleNotice>{error}</DismissibleNotice>}
    <div className="bond-perception-parameter-actions"><button type="button" onClick={onCancel}>取消</button><button type="button" onClick={apply}>应用</button></div>
  </div>;
}
