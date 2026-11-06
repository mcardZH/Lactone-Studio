import {useEffect,useState} from 'react';
import type {ComputeResourcePreferencesBridge,ComputeResourceSnapshot} from '../modeling/resource-preferences';

export function checkComputeResourceSnapshot(value:ComputeResourceSnapshot):ComputeResourceSnapshot{
  const positive=(number:number)=>Number.isSafeInteger(number)&&number>0;
  if(!value||typeof value.version!=='string'||!(/^[a-f0-9]{64}$/.test(value.version)||value.version==='missing')||!/^[a-f0-9]{64}$/.test(value.revision)||!positive(value.logicalCpuCount)||!positive(value.totalPhysicalMemoryBytes)||typeof value.writable!=='boolean'||typeof value.source!=='string')throw Error('本机计算资源回执无效。');
  if(value.error||!value.writable)throw Error(value.error??'计算资源偏好不可用。');
  for(const setting of [value.effective,value.defaults,...(value.value?[value.value]:[])])if(!setting||!positive(setting.threads)||!positive(setting.memoryBudgetBytes)||setting.threads>value.logicalCpuCount||setting.memoryBudgetBytes>value.totalPhysicalMemoryBytes||(setting.outputBudgetBytes!==undefined&&(!positive(setting.outputBudgetBytes)||setting.outputBudgetBytes<1024||setting.outputBudgetBytes>1024**4)))throw Error('本机计算资源超过可用范围。');
  return structuredClone(value);
}
/** Subscribe before reading so a late initial read cannot overwrite a newer
 * explicit global choice. No missing-backend or malformed-value fallback. */
export function useComputeResources(bridge:Partial<ComputeResourcePreferencesBridge>|undefined=typeof window==='undefined'?undefined:window.sciyueDesktop){
  const [state,setState]=useState<{snapshot:ComputeResourceSnapshot|null;loading:boolean;error:string}>({snapshot:null,loading:true,error:''});
  useEffect(()=>{
    let active=true,sequence=0,off=()=>{};setState({snapshot:null,loading:true,error:''});
    const receive=(value:ComputeResourceSnapshot)=>{if(!active)return;try{setState({snapshot:checkComputeResourceSnapshot(value),loading:false,error:''});}catch(error){setState({snapshot:null,loading:false,error:error instanceof Error?error.message:String(error)});}};
    const failed=(error:unknown)=>{if(active)setState({snapshot:null,loading:false,error:error instanceof Error?error.message:String(error)});};
    if(!bridge?.readComputeResources||!bridge.onComputeResourcesChanged){failed(Error('当前环境不能读取统一计算资源。'));return()=>{active=false;};}
    const refresh=()=>{const own=++sequence;void bridge.readComputeResources!().then(value=>{if(active&&own===sequence)receive(value);}).catch(error=>{if(own===sequence)failed(error);});};
    // Every owner establishes its own optimistic-write baseline after a change;
    // another window's broadcast is not permission to overwrite stale bytes.
    try{off=bridge.onComputeResourcesChanged(()=>refresh());refresh();}catch(error){failed(error);}
    return()=>{active=false;sequence++;off();};
  },[bridge]);
  return state;
}
