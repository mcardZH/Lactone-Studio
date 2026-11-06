import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import {useEffect,useRef,useState} from 'react';
import {needsComputeResourceConfirmation,type ComputeResourceValues} from '../modeling/resource-preferences';
import {useComputeResources} from './useComputeResources';
import {InputSettingsField,InputSettingsRow} from './InputSettingsFields';
import {InputSettingsAction,InputSettingsSection} from './InputSettingsLayout';

export default function ComputeResourceSettings(){
  const bridge=typeof window==='undefined'?undefined:window.sciyueDesktop,{snapshot,loading,error}=useComputeResources(bridge),edited=useRef(false),editVersion=useRef<string|null>(null),[draft,setDraft]=useState({threads:'',memoryGiB:'',outputGiB:''}),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{if(snapshot&&!edited.current)setDraft({threads:String(snapshot.effective.threads),memoryGiB:String(snapshot.effective.memoryBudgetBytes/1024**3),outputGiB:snapshot.effective.outputBudgetBytes===undefined?'':String(snapshot.effective.outputBudgetBytes/1024**3)});},[snapshot]);
  const change=(patch:Partial<typeof draft>)=>{if(!edited.current)editVersion.current=snapshot?.version??null;edited.current=true;setNotice('');setDraft(old=>({...old,...patch}));};
  async function save(factory=false){
    if(!snapshot||!bridge?.writeComputeResources||saving)return;setSaving(true);setNotice('');
    try{const value:ComputeResourceValues=factory?{...snapshot.defaults}:{threads:Number(draft.threads),memoryBudgetBytes:Number(draft.memoryGiB)*1024**3,...(draft.outputGiB.trim()?{outputBudgetBytes:Number(draft.outputGiB)*1024**3}:{})};if(!draft.threads.trim()&&!factory||!Number.isSafeInteger(value.threads)||value.threads<1||!Number.isSafeInteger(value.memoryBudgetBytes)||value.memoryBudgetBytes<1||value.outputBudgetBytes!==undefined&&(!Number.isSafeInteger(value.outputBudgetBytes)||value.outputBudgetBytes<1024))throw Error('请填写有效线程和内存；输出预算可留空不限制，填写时至少1 KiB。');const saved=await bridge.writeComputeResources({baseVersion:factory?snapshot.version:editVersion.current??snapshot.version,value});edited.current=false;editVersion.current=null;setDraft({threads:String(saved.effective.threads),memoryGiB:String(saved.effective.memoryBudgetBytes/1024**3),outputGiB:saved.effective.outputBudgetBytes===undefined?'':String(saved.effective.outputBudgetBytes/1024**3)});setNotice('已立即应用；等待中的任务启动时使用新设置，正在运行的任务保持原资源。');}catch(cause){setNotice(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  }
  return <InputSettingsSection title="计算资源">
    {snapshot&&needsComputeResourceConfirmation(snapshot)&&<p role="status">首次使用，请核对可供 Ester Studio 使用的计算资源。</p>}
    <InputSettingsRow><InputSettingsField label="CPU 核数"><NumericInput aria-label="内置计算线程" stepper min={1} max={snapshot?.logicalCpuCount} step={1} disabled={loading||saving||!!error} value={draft.threads} onChange={event=>change({threads:event.currentTarget.value})}/></InputSettingsField><InputSettingsField label="内存预算 / GiB"><NumericInput aria-label="内置计算内存预算GiB"  min={1/1024**3} max={snapshot? snapshot.totalPhysicalMemoryBytes/1024**3:undefined} step={.125} disabled={loading||saving||!!error} value={draft.memoryGiB} onChange={event=>change({memoryGiB:event.currentTarget.value})}/></InputSettingsField><InputSettingsField label="累计输出预算 / GiB"><NumericInput aria-label="内置计算累计输出预算GiB" placeholder="不限制" min={1/1024**2} step={.125} disabled={loading||saving||!!error} value={draft.outputGiB} onChange={event=>change({outputGiB:event.currentTarget.value})}/></InputSettingsField></InputSettingsRow>
    <InputSettingsRow><InputSettingsAction disabled={!snapshot||saving||!!error} onClick={()=>void save()}>应用计算资源</InputSettingsAction><InputSettingsAction reset disabled={!snapshot||saving||!!error} onClick={()=>void save(true)}>恢复计算资源默认</InputSettingsAction></InputSettingsRow>
    <p className="analysis-environment-path">线程为允许上限；内存为本机任务与保留缓存共用预算，非预分配或统一硬限。Gaussian/ORCA 导出输入资源独立设置。</p>
    {(error||notice)&&<DismissibleNotice role={error?'alert':'status'}>{error||notice}</DismissibleNotice>}
  </InputSettingsSection>;
}
