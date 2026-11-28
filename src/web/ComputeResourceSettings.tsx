import {useEffect,useRef,useState} from 'react';
import {needsComputeResourceConfirmation,type ComputeResourcePreferenceValues,type ComputeResourceSnapshot,type XtbSingleTaskThreadMode} from '../modeling/resource-preferences';
import {DismissibleNotice} from './DismissibleNotice';
import {InputSettingsField,InputSettingsRow} from './InputSettingsFields';
import {InputSettingsAction,InputSettingsSection} from './InputSettingsLayout';
import NumericInput from './NumericInput';
import {useComputeResources} from './useComputeResources';

const GIB=1024**3;
const threadFields=['multiwfnThreads','xtbSingleTaskThreads','xtbBatchParallelism'] as const;
type ThreadField=typeof threadFields[number];
type ResourceDraft=Record<ThreadField,string>&{threads:number;xtbSingleTaskMode:XtbSingleTaskThreadMode;memoryGiB:string;outputGiB:string};

const emptyDraft:ResourceDraft={threads:4,multiwfnThreads:'',xtbSingleTaskMode:'auto',xtbSingleTaskThreads:'',xtbBatchParallelism:'',memoryGiB:'',outputGiB:''};

function resourceDraft(snapshot:ComputeResourceSnapshot):ResourceDraft{
  const value=snapshot.effective;
  return {
    threads:value.threads,
    multiwfnThreads:String(value.multiwfnThreads??value.threads),
    xtbSingleTaskMode:value.xtbSingleTaskMode??'auto',
    xtbSingleTaskThreads:String(value.xtbSingleTaskThreads??value.threads),
    xtbBatchParallelism:String(value.xtbBatchParallelism??value.threads),
    memoryGiB:String(value.memoryBudgetBytes/GIB),
    outputGiB:value.outputBudgetBytes===undefined?'':String(value.outputBudgetBytes/GIB),
  };
}

function preferenceValues(draft:ResourceDraft):ComputeResourcePreferenceValues{
  const next={threads:draft.threads,multiwfnThreads:Number(draft.multiwfnThreads),
    xtbSingleTaskMode:draft.xtbSingleTaskMode,xtbSingleTaskThreads:Number(draft.xtbSingleTaskThreads),
    xtbBatchParallelism:Number(draft.xtbBatchParallelism),
    memoryBudgetBytes:Number(draft.memoryGiB)*GIB,...(draft.outputGiB.trim()?{outputBudgetBytes:Number(draft.outputGiB)*GIB}:{})};
  if(![...threadFields.map(field=>next[field]),next.memoryBudgetBytes].every(value=>Number.isSafeInteger(value)&&value>0)||
    next.outputBudgetBytes!==undefined&&(!Number.isSafeInteger(next.outputBudgetBytes)||next.outputBudgetBytes<1024))
    throw Error('请填写有效的线程数、并行数和内存。累计输出预算可留空，填写时至少 1 KiB。');
  return next;
}

export default function ComputeResourceSettings(){
  const bridge=typeof window==='undefined'?undefined:window.sciyueDesktop;
  const {snapshot,loading,error}=useComputeResources(bridge);
  const edited=useRef(false),editVersion=useRef<string|null>(null);
  const [draft,setDraft]=useState(emptyDraft),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const disabled=loading||saving||!!error;

  useEffect(()=>{if(snapshot&&!edited.current)setDraft(resourceDraft(snapshot));},[snapshot]);
  function change(patch:Partial<ResourceDraft>){
    if(!edited.current)editVersion.current=snapshot?.version??null;
    edited.current=true;setNotice('');setDraft(old=>({...old,...patch}));
  }
  async function save(factory=false){
    if(!snapshot||!bridge?.writeComputeResources||saving)return;
    setSaving(true);setNotice('');
    try{
      const value=factory?preferenceValues(resourceDraft({...snapshot,value:null,effective:snapshot.defaults})):preferenceValues(draft);
      const saved=await bridge.writeComputeResources({baseVersion:factory?snapshot.version:editVersion.current??snapshot.version,value});
      edited.current=false;editVersion.current=null;setDraft(resourceDraft(saved));
      setNotice('设置已应用。等待中的任务在启动时读取新设置。');
    }catch(cause){setNotice(cause instanceof Error?cause.message:String(cause));}
    finally{setSaving(false);}
  }
  function threadInput(field:ThreadField,label:string){
    return <InputSettingsField label={label} controlWidth="number"><NumericInput aria-label={label} stepper min={1} max={snapshot?.logicalCpuCount}
      step={1} disabled={disabled} value={draft[field]} onChange={event=>change({[field]:event.currentTarget.value})}/></InputSettingsField>;
  }
  const auto=draft.xtbSingleTaskMode==='auto';
  return <InputSettingsSection className="settings-resource-card" stack>
    {snapshot&&needsComputeResourceConfirmation(snapshot)&&<p role="status">首次使用，请核对可供 Ester Studio 使用的计算资源。</p>}
    <InputSettingsRow className="settings-resource-fields">
      {threadInput('multiwfnThreads','Multiwfn 线程')}
      <InputSettingsField label="xTB 单任务线程模式" controlWidth="select"><select aria-label="xTB 单任务线程模式" disabled={disabled}
        value={draft.xtbSingleTaskMode} onChange={event=>change({xtbSingleTaskMode:event.currentTarget.value==='fixed'?'fixed':'auto'})}>
        <option value="auto">自动</option><option value="fixed">固定</option>
      </select></InputSettingsField>
      {threadInput('xtbSingleTaskThreads',auto?'xTB 单任务线程上限':'xTB 单任务固定线程')}
      {threadInput('xtbBatchParallelism','xTB 批量并行数')}
    </InputSettingsRow>
    <InputSettingsRow className="settings-resource-fields">
      <InputSettingsField label="内存预算" unit="GiB" controlWidth="long-number"><NumericInput aria-label="内置计算内存预算GiB" min={1/GIB}
        max={snapshot?snapshot.totalPhysicalMemoryBytes/GIB:undefined} step={.125} disabled={disabled} value={draft.memoryGiB}
        onChange={event=>change({memoryGiB:event.currentTarget.value})}/></InputSettingsField>
      <InputSettingsField label="累计输出预算" unit="GiB" controlWidth="long-number"><NumericInput aria-label="内置计算累计输出预算GiB"
        placeholder="不限制" min={1/1024**2} step={.125} disabled={disabled} value={draft.outputGiB}
        onChange={event=>change({outputGiB:event.currentTarget.value})}/></InputSettingsField>
    </InputSettingsRow>
    <InputSettingsRow variant="actions">
      <InputSettingsAction variant="primary" disabled={!snapshot||disabled} onClick={()=>void save()}>应用计算资源</InputSettingsAction>
      <InputSettingsAction variant="surface" disabled={!snapshot||disabled} onClick={()=>void save(true)}>恢复计算资源默认</InputSettingsAction>
    </InputSettingsRow>
    <details><summary>预算说明</summary><p>自动模式下，分子 GFN2-xTB 少于 40 个原子使用 1 线程，其他 xTB 单任务按设置的线程上限运行。xTB 批量优化的每个候选使用 1 线程。内存预算由本机任务与保留缓存共用。累计输出预算留空时不限。</p></details>
    {(error||notice)&&<DismissibleNotice role={error?'alert':'status'}>{error||notice}</DismissibleNotice>}
  </InputSettingsSection>;
}
