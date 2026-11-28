import {useRef} from 'react';
import type {InterfaceSurface} from './interface-surface-preferences';

const choices=[
  {id:'flagship',label:'现代旗舰精工（默认）',note:'柔和层次与轻投影，工具栏去框化'},
  {id:'flat',label:'极致克制扁平',note:'零投影与紧凑圆角，回归极简科研线条'},
  {id:'glass',label:'微玻璃强层次',note:'浮层与弹窗轻磨砂，卡片层次更清晰'},
] as const;

export default function InterfaceSurfaceControl({value,onChange}:{value:InterfaceSurface;onChange(value:InterfaceSurface):void}){
  const controls=useRef<Array<HTMLButtonElement|null>>([]);
  return <div className="settings-surface-choices" role="radiogroup" aria-label="界面质感">{choices.map((choice,index)=><button
    type="button" key={choice.id} ref={node=>{controls.current[index]=node;}} role="radio" aria-label={choice.label} aria-checked={value===choice.id}
    title={choice.note} tabIndex={value===choice.id?0:-1} className="settings-theme-choice settings-surface-choice" data-surface-choice={choice.id} onClick={()=>onChange(choice.id)}
    onKeyDown={event=>{
      const next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%choices.length:event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+choices.length-1)%choices.length:event.key==='Home'?0:event.key==='End'?choices.length-1:null;
      if(next===null)return;event.preventDefault();onChange(choices[next].id);controls.current[next]?.focus();
    }}>
    <span className="settings-surface-swatch" data-surface-preview={choice.id} aria-hidden="true"><i/></span>
    <span className="settings-theme-label">{choice.label}</span>
  </button>)}</div>;
}
