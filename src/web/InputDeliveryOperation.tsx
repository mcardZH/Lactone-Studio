import {useCallback,useEffect,useRef,useState} from 'react';
import DialogShell from './DialogShell';

export type InputDeliveryRunner=<T>(label:string,operation:()=>T|Promise<T>)=>Promise<T>;

/** A short file/clipboard action owns its actual Promise. No artificial delay
 * or percentage is added, and completion never navigates to another page. */
export function useInputDeliveryOperation(){
  const [label,setLabel]=useState<string|null>(null),active=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run:InputDeliveryRunner=useCallback(async<T,>(title:string,operation:()=>T|Promise<T>)=>{
    if(active.current)throw Error('输入文件正在处理，请稍候。');
    active.current=true;if(alive.current)setLabel(title);
    try{return await operation();}
    finally{active.current=false;if(alive.current)setLabel(null);}
  },[]);
  const isBusy=useCallback(()=>active.current,[]);
  return {label,run,isBusy};
}

export function InputDeliveryDialog({label}:{label:string|null}){
  return label?<DialogShell aria-label={label} onCancel={()=>{}} style={{width:'min(340px, calc(100vw - 40px))'}}>
    <h2>{label}</h2><progress aria-label="输入文件处理进度" style={{display:'block',width:'100%'}}/>
  </DialogShell>:null;
}
