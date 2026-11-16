import {useRef} from 'react';
import type {InterfaceTheme} from './interface-theme-preferences';
const choices=[{id:'mixed',label:'混合青绿（默认）'},{id:'mint',label:'明亮薄荷'},{id:'clear',label:'清透白青'}] as const;
export default function InterfaceThemeControl({value,onChange}:{value:InterfaceTheme;onChange(value:InterfaceTheme):void}){
  const controls=useRef<Array<HTMLButtonElement|null>>([]);
  return <div className="settings-theme-choices" role="radiogroup" aria-label="界面配色">{choices.map((choice,index)=><button
    type="button" key={choice.id} ref={node=>{controls.current[index]=node;}} role="radio" aria-label={choice.label} aria-checked={value===choice.id}
    tabIndex={value===choice.id?0:-1} className="settings-theme-choice" data-theme-choice={choice.id} onClick={()=>onChange(choice.id)}
    onKeyDown={event=>{
      const next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%choices.length:event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+choices.length-1)%choices.length:event.key==='Home'?0:event.key==='End'?choices.length-1:null;
      if(next===null)return;event.preventDefault();onChange(choices[next].id);controls.current[next]?.focus();
    }}>
    <span className="settings-theme-swatch" data-theme-preview={choice.id} aria-hidden="true"><i/><i/><i/></span>
    <span className="settings-theme-label">{choice.label}</span>
  </button>)}</div>;
}
