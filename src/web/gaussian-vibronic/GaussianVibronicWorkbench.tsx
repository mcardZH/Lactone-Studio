import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildVibronicInput, identifyVibronicFile, readVibronicText, inspectVibronicLogJobs, pairBinding, parseVibronicEvidence, stateBinding, validateVibronicRequest, type VibronicMode, type VibronicRequest, type VibronicFileIdentity, type VibronicLogJob } from '../../core/gaussian-vibronic';
import './vibronic.css';

export interface GaussianVibronicWorkbenchProps { mode:VibronicMode; onBack?:()=>void; availableFiles?:readonly File[] }
function save(name:string,text:string) {
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export default function GaussianVibronicWorkbench({mode,onBack,availableFiles=[]}:GaussianVibronicWorkbenchProps) {
  const [request,setRequest]=useState<VibronicRequest>({mode,theory:'FC',direction:'absorption',calculation:'reuse-frequencies',initial:{},final:{},name:mode==='huang-rhys'?'huang-rhys':'vibronic',memoryGB:0,cores:0});
  const [fileErrors,setFileErrors]=useState<Record<string,string>>({}),[busy,setBusy]=useState<Record<string,boolean>>({});
  const [logChoices,setLogChoices]=useState<Partial<Record<'initial'|'final',{identity:VibronicFileIdentity;text:string;jobs:VibronicLogJob[]}>>>({});
  const epochs=useRef<Record<string,number>>({}),mounted=useRef(true);
  const readers=useRef<Record<string,AbortController>>({});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epochs.current={};Object.values(readers.current).forEach(reader=>reader.abort());readers.current={};};},[]);
  useEffect(()=>{setRequest(current=>({...current,mode}));},[mode]);
  const current={...request,mode};
  const validation=useMemo(()=>validateVibronicRequest(current),[request,mode]);
  const output=useMemo(()=>validation.valid?buildVibronicInput(current):null,[request,mode,validation.valid]);
  function update(patch:Partial<VibronicRequest>) {setRequest(r=>({...r,...patch}));}
  async function select(side:'initial'|'final',kind:'log'|'fchk'|'checkpoint',file:File|undefined) {
    const id=`${side}-${kind}`,epoch=(epochs.current[id]??0)+1;epochs.current[id]=epoch;
    readers.current[id]?.abort();const controller=new AbortController();readers.current[id]=controller;
    if(kind==='log')setLogChoices(value=>({...value,[side]:undefined}));
    setRequest(r=>({...r,[side]:{...r[side],[kind]:undefined,confirmedBinding:undefined},correspondenceBinding:undefined}));
    setFileErrors(e=>({...e,[id]:''}));if(!file){delete readers.current[id];setBusy(b=>({...b,[id]:false}));return;}
    setBusy(b=>({...b,[id]:true}));
    try {
      if(kind==='checkpoint') {
        if(!/\.chk$/i.test(file.name))throw new Error('请选择实际二进制CHK；FCHK不能直接替代。');
        const sample=new Uint8Array(await file.slice(0,4096).arrayBuffer());
        if(sample.length<16||sample.every(v=>v===9||v===10||v===13||v>=32&&v<=126))throw new Error('所选文件为空、过短或为文本，不能冒充二进制CHK。');
      }
      const identity=await identifyVibronicFile(file,controller.signal);
      const text=kind==='checkpoint'?'':await readVibronicText(file,controller.signal);
      if(kind==='log'){
        const jobs=inspectVibronicLogJobs(text);
        if(jobs.length>1){if(mounted.current&&epochs.current[id]===epoch)setLogChoices(value=>({...value,[side]:{identity,text,jobs}}));return;}
      }
      const value=kind==='checkpoint'?identity:parseVibronicEvidence(identity,text);
      if(kind!=='checkpoint'&&'format' in value&&value.format!==kind)throw new Error(`文件内容不是${kind.toUpperCase()}。`);
      if(mounted.current&&epochs.current[id]===epoch)setRequest(r=>({...r,[side]:{...r[side],[kind]:value,confirmedBinding:undefined},correspondenceBinding:undefined}));
    } catch(error) {if(mounted.current&&epochs.current[id]===epoch)setFileErrors(e=>({...e,[id]:error instanceof Error?error.message:String(error)}));}
    finally {if(readers.current[id]===controller)delete readers.current[id];if(mounted.current&&epochs.current[id]===epoch)setBusy(b=>({...b,[id]:false}));}
  }
  function selectLogJob(side:'initial'|'final',value:string) {
    const choices=logChoices[side],id=`${side}-log`;if(!choices)return;
    setRequest(r=>({...r,[side]:{...r[side],log:undefined,confirmedBinding:undefined},correspondenceBinding:undefined}));
    setFileErrors(errors=>({...errors,[id]:''}));if(value==='')return;
    try {const log=parseVibronicEvidence(choices.identity,choices.text,{jobIndex:Number(value)});setRequest(r=>({...r,[side]:{...r[side],log,confirmedBinding:undefined},correspondenceBinding:undefined}));}
    catch(error){setFileErrors(errors=>({...errors,[id]:error instanceof Error?error.message:String(error)}));}
  }
  const anyBusy=Object.values(busy).some(Boolean);
  function stateCard(side:'initial'|'final') {
    const state=request[side],label=side==='initial'?'初态':'末态',evidence=state.log;
    const enough=Boolean(state.log&&state.fchk&&state.checkpoint);
    return <section className="vibronic-state" aria-label={`${label}来源`}>
      <h3>{label} · {request.direction==='absorption'?(side==='initial'?'基态':'激发态'):(side==='initial'?'激发态':'基态')}</h3>
      {(['log','fchk','checkpoint'] as const).map(kind=>{
        const id=`${side}-${kind}`,asset=kind==='checkpoint'?state.checkpoint:state[kind]?.identity??(kind==='log'?logChoices[side]?.identity:undefined);
        const suffix=kind==='log'?/\.(log|out)$/i:kind==='fchk'?/\.(fchk|fch)$/i:/\.chk$/i;
        const loaded=availableFiles.map((file,index)=>({file,index})).filter(entry=>suffix.test(entry.file.name));
        return <div className="vibronic-source" key={kind}><label>{kind==='checkpoint'?'实际CHK':kind==='log'?'频率LOG / OUT':'对应FCHK'}<input type="file" aria-label={`${label}${kind==='checkpoint'?'CHK':kind.toUpperCase()}`} accept={kind==='log'?'.log,.out':kind==='fchk'?'.fchk,.fch':'.chk'} onChange={e=>{void select(side,kind,e.currentTarget.files?.[0]);e.currentTarget.value='';}}/></label>
          <label>从已载入文件选择<select aria-label={`${label}${kind==='checkpoint'?'CHK':kind.toUpperCase()}已载入文件`} value="" disabled={!loaded.length} onChange={e=>{if(e.currentTarget.value==='')return;const chosen=loaded.find(entry=>entry.index===Number(e.currentTarget.value));if(chosen)void select(side,kind,chosen.file);}}><option value="">{loaded.length?'请选择文件…':'暂无对应类型的已载入文件'}</option>{loaded.map(({file,index})=><option key={index} value={index}>{index+1}. {file.name} · {file.size.toLocaleString()} bytes</option>)}</select></label>
          {kind==='log'&&logChoices[side]&&<label>选择文件内频率作业<select aria-label={`${label}LOG频率作业`} value={state.log?.selectedJob?.index??''} onChange={e=>selectLogJob(side,e.target.value)}><option value="">文件含多个作业，请明确选择…</option>{logChoices[side]!.jobs.map(job=><option key={job.index} value={job.index} disabled={!job.hasFrequencyData}>作业 {job.index+1} · 第 {job.startLine}–{job.endLine} 行 · {job.hasFrequencyData?'有频率':'无频率'} · {job.normalTermination?'正常结束':'未正常结束'} · {job.route}</option>)}</select></label>}
          {busy[id]?<><p role="status">正在分块读取与核对…</p><button type="button" aria-label={`取消${label}${kind==='checkpoint'?'CHK':kind.toUpperCase()}读取`} onClick={()=>readers.current[id]?.abort()}>取消读取</button></>:asset?<p title={`SHA-256 ${asset.sha256}`}>{asset.name} · {asset.size.toLocaleString()} bytes</p>:<p>尚未选择</p>}
          {fileErrors[id]&&<DismissibleNotice role="alert" className="vibronic-error">{fileErrors[id]}</DismissibleNotice>}
        </div>;
      })}
      {evidence&&<div className="vibronic-evidence"><p>{evidence.atoms.length} 原子 · 电荷 {evidence.charge} · 多重度 {evidence.multiplicity} · {evidence.root===null?'基态 / 未识别目标根':`Root ${evidence.root}`} · {evidence.frequencies.length}/{evidence.modeCount} 频率{evidence.selectedJob&&` · 作业 ${evidence.selectedJob.index+1}`}</p><code>{evidence.route}</code>{evidence.selectedJob?.inheritedFrom&&<details><summary>作业来源与继承记录</summary><p>所选作业原始Route：</p><code>{evidence.selectedJob.route}</code><p>相邻优化作业Route：</p><code>{evidence.selectedJob.inheritedFrom.route}</code>{evidence.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}</div>}
      <label className="vibronic-check"><input type="checkbox" disabled={!enough||anyBusy} checked={enough&&state.confirmedBinding===stateBinding(state)} onChange={e=>{const checked=e.currentTarget.checked;setRequest(r=>({...r,[side]:{...r[side],confirmedBinding:checked?stateBinding(r[side]):undefined},correspondenceBinding:undefined}));}}/>我已核对这三个文件来自同一目标电子态的同一次频率计算，频率几何是所需极小点。</label>
    </section>;
  }
  return <main className="vibronic-workbench" aria-label={mode==='huang-rhys'?'Gaussian Huang–Rhys输入工作台':'Gaussian振动分辨输入工作台'}>
    <header><div><p className="vibronic-eyebrow">Gaussian · 输入准备</p><h1>{mode==='huang-rhys'?'Huang–Rhys 黄昆因子':'振动分辨吸收 / 发射'}</h1><p>两个极小点的完整频率来源 · Adiabatic Hessian · 保留原方法、基组及环境</p></div>{onBack&&<button type="button" onClick={onBack}>返回工作台</button>}</header>
    <div className="vibronic-controls"><label>跃迁方向<select aria-label="振电跃迁方向" value={request.direction} onChange={e=>update({direction:e.target.value as VibronicRequest['direction'],correspondenceBinding:undefined})}><option value="absorption">吸收：基态 → 激发态</option><option value="emission">发射：激发态 → 基态</option></select></label>
      <label>跃迁近似<select aria-label="振电近似" value={request.theory} onChange={e=>update({theory:e.target.value as VibronicRequest['theory']})}><option value="FC">FC · Franck–Condon</option><option value="HT">HT · Herzberg–Teller</option><option value="FCHT">FCHT · FC + HT</option></select></label>
      <label>作业名称<input aria-label="振电作业名称" value={request.name} onChange={e=>update({name:e.target.value})}/></label>
      <label>内存 / GB<NumericInput aria-label="振电内存GB" min="0" step="any" value={request.memoryGB||''} placeholder="已分配内存" onChange={e=>update({memoryGB:Number(e.target.value)})}/></label>
      <label>CPU核数<NumericInput aria-label="振电CPU核数" stepper min="1" value={request.cores||''} placeholder="已分配核数" onChange={e=>update({cores:Number(e.target.value)})}/></label>
      <label>温度 / K<NumericInput aria-label="振电温度K"  min="0.001" step="any" value={request.temperatureK??''} placeholder="Gaussian默认" onChange={e=>update({temperatureK:e.target.value===''?undefined:Number(e.target.value)})}/></label></div>
    <details className="vibronic-spectrum"><summary>谱范围与展宽（可选）</summary><p>范围相对0–0跃迁，所有频率参数单位为cm⁻¹。留空采用Gaussian默认；HWHM为半高半宽，Stick为不展宽的离散谱。</p><div className="vibronic-spectrum-grid">
      {([['lower','谱下限'],['upper','谱上限'],['grain','采样间隔'],['hwhm','半高半宽HWHM']] as const).map(([field,label])=><label key={field}>{label} / cm⁻¹<NumericInput  step="any" aria-label={`${label}cm-1`} placeholder="Gaussian默认" value={request.spectrum?.[field]??''} onChange={e=>update({spectrum:{...request.spectrum,[field]:e.target.value===''?undefined:Number(e.target.value)}})}/></label>)}
      <label>展宽形状<select aria-label="振电展宽形状" value={request.spectrum?.broadening??''} onChange={e=>update({spectrum:{...request.spectrum,broadening:e.target.value===''?undefined:e.target.value as 'Gaussian'|'Lorentzian'|'Stick'}})}><option value="">Gaussian默认</option><option value="Gaussian">Gaussian</option><option value="Lorentzian">Lorentzian</option><option value="Stick">Stick · 不展宽</option></select></label>
    </div></details>
    <p className="vibronic-guide">每态选择频率 LOG、对应 FCHK 和实际 CHK。FCHK用于核对完整Hessian、模式与质量，LOG用于核对正常终止和目标根；CHK为Gaussian运行依赖。文件名相同不作为对应证明。来源完整读取，分块读取可取消；实际读取或内存分配失败会保留具体原因。</p>
    <label className="vibronic-calculation">频率处理<select aria-label="振电频率处理" value={request.calculation??'reuse-frequencies'} onChange={e=>update({calculation:e.target.value as VibronicRequest['calculation']})}><option value="reuse-frequencies">复用已有两态频率（ReadFC，默认）</option><option value="recompute-ground">重新计算基态频率（显式坐标，会增加计算）</option></select></label>
    <p className="vibronic-guide">{request.calculation==='recompute-ground'?'将用基态LOG的原方法和显式坐标重新计算基态频率，激发态数据仍从所选CHK读取。':'专用ReadFC输入从基态CHK继承几何、质量与力常数；另建新CHK，吸收和发射均复用已完成两态频率。'}</p>
    <div className="vibronic-states">{stateCard('initial')}{stateCard('final')}</div>
    <label className="vibronic-check vibronic-pair"><input type="checkbox" disabled={anyBusy||!request.initial.log||!request.final.log||request.initial.confirmedBinding!==stateBinding(request.initial)||request.final.confirmedBinding!==stateBinding(request.final)} checked={request.correspondenceBinding===pairBinding(request.initial,request.final)} onChange={e=>update({correspondenceBinding:e.target.checked?pairBinding(request.initial,request.final):undefined})}/>我已逐原子核对两态的物理对应与同位素，确认目标根与吸收／发射顺序；没有交换同元素原子。</label>
    <div className="vibronic-result"><section><h2>来源与适用性检查</h2>{validation.valid?<p className="vibronic-success">输入准备条件已满足，可以导出。</p>:<ul aria-label="振电缺项">{validation.errors.map((issue,i)=><li key={`${issue.code}-${i}`}>{issue.message}</li>)}</ul>}<details><summary>计算范围与运行依赖</summary>{validation.warnings.map((message,i)=><p key={i}>{message}</p>)}<p>HT/FCHT需要目标根跃迁偶极矩及完整TD/CIS频率计算前提。永久偶极矩、IR强度或两份几何不能代替。</p><p>本版本未执行Gaussian生产计算；导出的输入需在已获准的Gaussian环境运行。</p></details></section>
      <section className="vibronic-preview"><h2>完整输入预览</h2>{output?<><pre aria-label="振电输入预览">{output.text}</pre><p>运行依赖：{output.dependencies.map(d=>d.name).join('、')}（需自行放入同一运行目录）。</p></>:<p className="vibronic-empty">补齐来源及检查项后显示完整GJF。</p>}<button type="button" className="vibronic-primary" disabled={!output||anyBusy} onClick={()=>{if(output&&!anyBusy)save(output.name,output.text);}}>下载 .gjf</button><button type="button" disabled={!output||anyBusy} onClick={()=>{if(output&&!anyBusy)save(`${request.name}-sources.json`,JSON.stringify({schema:'sciyue-gaussian-vibronic/1',request:current,dependencies:output.dependencies,notes:output.notes},null,2)+'\n');}}>下载来源与依赖说明</button></section></div>
  </main>;
}
