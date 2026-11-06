import NumericInput from './NumericInput';
import { Children, type ReactNode } from 'react';
import type { FileSettings,GaussianSettings,Structure,TaskOptions,FragmentDefinition,GaussianQstSettings,InputStructureSource,JobRequest } from '../core/types';
import { defaultTaskOptions,spectrumStates,ircPoints,supportsConstraints,isOptimizationTask,TASKS } from '../core/tasks';
import { formatAtomSelection } from '../core/structures';
import { suggestedMultiplicity } from '../core/elements';
import { isXtb,xtbNeedsFrequency } from '../core/xtb';
import { isUksOptimization,excitedOptimizationFrequency,excitedFrequencyOnly } from '../core/excited-state';
import { CoreParameterGroup, FrequencyCoreControls, GaussianOptimizationControls } from './TaskCoreControls';
import { supportsGaussianRaman } from '../core/gaussian';
import ExcitedStructureStageControls from './ExcitedStructureStageControls';
import { fragmentColor } from '../core/regions';
import GeometryControls from './GeometryControls';
import QstOptions from './QstOptions';
import type { MultiStructureSourceActions } from './MultiStructureSourcePicker';
import { isQstTask } from '../core/gaussian-qst';
import type { AtomPickerRequest } from './AtomPickerModal';
import InteractiveSelectionField,{SelectionGroupHeader,SelectionRemoveButton,SelectionAddButton,type InteractiveSelectionFieldProps} from './InteractiveSelectionField';
import {applyRegionSelection,planRegionSelection,remainingRegionAtomIds,regionSelectionIdentityError} from '../modeling/application/region-selection';
import { inputSelectionIndices } from '../core/input-selection';
import { recommendedExcitedStates } from '../core/input-recommendations';
import { InputSettingsAction } from './InputSettingsLayout';
import { InputSettingsCard } from './InputSettingsFields';
import './task-controls-eight.css';
type UpdateFiles=<K extends keyof FileSettings>(key:K,value:FileSettings[K])=>void;
export interface TaskParametersProps extends MultiStructureSourceActions {sharedFreezeCounts?:{atoms:number;coordinates:number};settings:GaussianSettings;updateSettings?:<K extends keyof GaussianSettings>(key:K,value:GaussianSettings[K])=>void;files:FileSettings;structure:Structure|null;selected:number[];multiplicity:number;onChange:(options:TaskOptions)=>void;onExcitedChange?:(patch:Partial<TaskOptions['excited']>)=>void;onResetTask?:()=>void;updateFile:UpdateFiles;onPick:(request:AtomPickerRequest)=>void;onRequestSelection?:InteractiveSelectionFieldProps['onRequestSelection'];qstRequest?:JobRequest;sourceCandidates?:InputStructureSource[];onQstChange?:(qst:GaussianQstSettings)=>void;onQstReactantSourceChange?:(source:InputStructureSource|null)=>void;qstReactantSource?:InputStructureSource|null;children?:ReactNode}
export default function TaskParameters({sharedFreezeCounts,settings,updateSettings,files,structure,selected,multiplicity,onChange,onExcitedChange,onResetTask,updateFile,onPick,onRequestSelection,qstRequest,sourceCandidates=[],onQstChange,onQstReactantSourceChange,qstReactantSource,onRequestSourcePick,onImportSources,children}:TaskParametersProps){
  const task=settings.task,options=settings.taskOptions??defaultTaskOptions(),atoms=structure?.atoms??[];
  const external=isXtb(settings.method);
  // Legacy populated fragments carry explicit scientific values; preserve them.
  const spinMode=(item:FragmentDefinition)=>item.multiplicityMode??(item.atoms.length?'manual':'auto');
  const change=(patch:Partial<TaskOptions>)=>onChange({...options,...patch});
  const excited=(patch:Partial<TaskOptions['excited']>)=>onExcitedChange?onExcitedChange(patch):change({excited:{...options.excited,...patch}});
  const uks=isUksOptimization(settings);
  const resetAction=(title:string)=>onResetTask&&<InputSettingsAction reset ariaLabel={'恢复'+title+'默认'} onClick={onResetTask}>恢复默认</InputSettingsAction>;
  const fragmentCounts=new Map<number,number>();
  for(const item of options.fragments)for(const index of item.atoms)fragmentCounts.set(index,(fragmentCounts.get(index)??0)+1);
  const unassigned=atoms.map((_,index)=>index).filter(index=>!fragmentCounts.has(index+1));
  const overlapping=[...fragmentCounts].filter(([,count])=>count>1).map(([index])=>index-1);
  function fragment(index:number,patch:Partial<FragmentDefinition>){change({fragmentStatesConfirmed:false,fragments:options.fragments.map((item,i)=>i===index?{...item,...patch}:item)});}
  const fragmentId=(item:FragmentDefinition,index:number)=>item.id??'gaussian-fragment-'+index;
  const fragmentRows=options.fragments.map((item,i)=>({id:fragmentId(item,i),label:'片段'+(i+1),atomIds:item.atoms.map(n=>atoms[n-1]?.id??'invalid-number:'+n)}));
  function commitFragment(index:number,ids:string[],guard:()=>void,overwrite:boolean){
    if(!structure)throw new Error('请先提供结构。');
    const next=applyRegionSelection(fragmentRows,planRegionSelection(structure,fragmentRows,fragmentId(options.fragments[index],index),ids),overwrite,guard);
    change({fragmentStatesConfirmed:false,fragments:options.fragments.map((item,i)=>{
      const indices=inputSelectionIndices(structure,next[i].atomIds).map(n=>n+1);
      const multiplicityMode=spinMode(item);
      return {...item,atoms:indices,multiplicityMode,multiplicity:i===index&&multiplicityMode==='auto'?suggestedMultiplicity(indices.map(n=>atoms[n-1]),item.charge):item.multiplicity};
    })});
  }
  if(task==='sp')return null;
  const optimization=isOptimizationTask(task)&&!excitedFrequencyOnly(settings);
  const frequency=task==='freq'||task==='optfreq'||task==='ts'||excitedOptimizationFrequency(settings);
  const ramanSupported=supportsGaussianRaman(settings,files);
  if(isQstTask(task))return <InputSettingsCard title="核心参数" sectionKey="task-parameters" className="task-specific" field="task-parameters" tabIndex={-1}><p role="status">QST2/QST3已撤下新建与输入生成，历史来源可继续查看。</p></InputSettingsCard>;
  return <InputSettingsCard title={<>核心参数 <span className="input-task-code">{TASKS.find(value=>value.id===task)?.code??task.toUpperCase()}</span></>} sectionKey="task-parameters" className="task-specific" actions={resetAction('核心参数')} field="task-parameters" tabIndex={-1}>
    {task==='scan'&&<GeometryControls mode="scan" sharedFreezeCounts={sharedFreezeCounts} settings={settings} files={files} structure={structure} selected={selected} onChange={onChange} onPick={onPick} onRequestSelection={onRequestSelection}/>}
    {task==='ts'&&external&&xtbNeedsFrequency(settings,files,structure?.atoms.length)&&<p className="muted-note">本次生成TS输入；完成后需另做Freq。</p>}
    {task==='irc'&&<CoreParameterGroup title="双向IRC" field="irc-options" tabIndex={-1}><label className="field">初始Hessian<select aria-label="IRC Hessian" disabled={external} value={!external&&files.hessian==='rcfc'?'rcfc':'calcfc'} onChange={event=>updateFile('hessian',event.target.value as 'rcfc'|'calcfc')}><option value="calcfc">CalcFC · 起点重新计算</option><option disabled={external} value="rcfc">RCFC · 读取兼容TS频率Hessian（优先有可用来源时）</option></select></label><div className="two-fields"><label className="field">每方向点数<NumericInput aria-label="IRC每方向点数" stepper={false} min="1" value={options.irc.maxPoints??''} placeholder={'当前推荐 '+(external?100:ircPoints(structure?.atoms.length))} onChange={event=>change({irc:{...options.irc,maxPoints:event.target.value===''?null:Number(event.target.value)}})}/></label><label className="field">步长 / 0.01 Bohr<NumericInput aria-label="IRC StepSize" stepper={false} min="1" step="1" value={options.irc.stepSize??''} placeholder="留空用程序默认" onChange={event=>change({irc:{...options.irc,stepSize:event.target.value===''?null:Number(event.target.value)}})}/></label></div><label className="check-line"><input type="checkbox" checked={options.irc.lqa} onChange={event=>change({irc:{...options.irc,lqa:event.target.checked}})}/><span>LQA</span></label></CoreParameterGroup>}
    {(task==='td'||task==='tdopt')&&<CoreParameterGroup title="激发态" field="excited-options" tabIndex={-1}>
      {task==='tdopt'&&<ExcitedStructureStageControls section="stage" frequency={options.excited.frequency} frequencyOnly={options.excited.frequencyOnly} useUks={options.excited.useUks} uksAllowed={options.excited.targetSpin==='triplets'&&options.excited.root===1} onStageChange={excited} onUksChange={useUks=>excited({useUks})}/>}
      <div className="two-fields"><label className="field">近似<select aria-label="激发态近似" disabled={uks} value={options.excited.approximation} onChange={event=>excited({approximation:event.target.value as TaskOptions['excited']['approximation']})}><option value="td">TDDFT</option><option value="tda">TDA</option>{task==='td'&&<option value="zindo">ZINDO/S · 半经验垂直激发</option>}</select></label>
      {task==='td'?<label className="field">自旋选项<select aria-label="TD自旋选项" value={options.excited.spin} onChange={event=>excited({spin:event.target.value as TaskOptions['excited']['spin']})}><option value="default">参考态对应程序默认</option><option value="singlets" disabled={multiplicity!==1||!!settings.unrestricted}>Singlets · 闭壳层单重态参考</option><option value="triplets" disabled={multiplicity!==1||!!settings.unrestricted}>Triplets · 闭壳层单重态参考</option><option value="50-50" disabled={multiplicity!==1||!!settings.unrestricted}>50-50 · 同时求单重态与三重态</option></select></label>:<label className="field">自旋选项<select aria-label="优化目标自旋" value={options.excited.targetSpin} onChange={event=>{const targetSpin=event.target.value as 'singlets'|'triplets';excited({targetSpin,useUks:targetSpin==='triplets'&&options.excited.root===1});}}><option value="singlets">S · 单重激发态</option><option value="triplets">T · 三重激发态</option></select></label>}</div>
      <div className="two-fields"><label className="field">求解态数<NumericInput aria-label="TD求解态数" disabled={uks} stepper={false} min="1" value={options.excited.nstatesMode==='manual'||options.excited.nstatesMode===undefined&&options.excited.nstates!==null?options.excited.nstates??'':recommendedExcitedStates(atoms.length,task==='tdopt'?'tdopt':'td',options.excited.root)} placeholder={String(recommendedExcitedStates(atoms.length,task==='tdopt'?'tdopt':'td',options.excited.root))} onChange={event=>excited({nstates:event.target.value===''?null:Number(event.target.value),nstatesMode:event.target.value===''?'auto':'manual'})}/></label><label className="field">目标Root<NumericInput aria-label="TD目标Root" stepper={true} min="1" value={options.excited.root} onChange={event=>{const root=Number(event.target.value);excited({root,...(task==='tdopt'?{useUks:options.excited.targetSpin==='triplets'&&root===1}:{} )});}}/></label></div>
      {task==='tdopt'&&<ExcitedStructureStageControls section="uks" frequency={options.excited.frequency} frequencyOnly={options.excited.frequencyOnly} useUks={options.excited.useUks} uksAllowed={options.excited.targetSpin==='triplets'&&options.excited.root===1} onStageChange={excited} onUksChange={useUks=>excited({useUks})}/>}

      <label className="check-line"><input aria-label="打印更多激发态组态系数" type="checkbox" disabled={uks} checked={!!options.excited.printCoefficients} onChange={event=>excited({printCoefficients:event.target.checked})}/><span>输出组态系数</span></label>
    </CoreParameterGroup>}
    {optimization&&updateSettings&&<CoreParameterGroup title={task==='ts'?'TS优化':'结构优化'}><GaussianOptimizationControls settings={settings} files={files} atomCount={atoms.length} updateSettings={updateSettings} updateFile={updateFile}/></CoreParameterGroup>}
    {task==='nmr'&&<div data-field="nmr-options" tabIndex={-1}><label className="field">计算内容<select aria-label="NMR内容" value={options.nmr.mode} onChange={event=>change({nmr:{mode:event.target.value as TaskOptions['nmr']['mode']}})}><option value="giao">GIAO核磁屏蔽（默认）</option><option value="spinspin">SpinSpin · 明确计算J耦合</option><option value="mixed">SpinSpin + Mixed · 明确两阶段近似</option></select></label></div>}
    {task==='stable'&&<div data-field="stable-options" tabIndex={-1}><label className="field">稳定性任务<select aria-label="稳定性任务" value={options.stable.optimize?'opt':'check'} onChange={event=>change({stable:{...options.stable,optimize:event.target.value==='opt'}})}><option value="check">Stable · 只检测</option><option value="opt">Stable=Opt · 必要时优化波函数</option></select></label></div>}
    {task==='bsse'&&<details className="fragment-list-group" data-field="fragments" tabIndex={-1} open>
      <summary><SelectionGroupHeader title={'片段（'+options.fragments.length+'）'} actions={<SelectionAddButton label="添加片段" disabled={!structure} onClick={()=>change({fragmentStatesConfirmed:false,fragments:[...options.fragments,{id:crypto.randomUUID(),atoms:[],charge:0,multiplicity:1,multiplicityMode:'auto'}]})}/>}/></summary>
      <p className="fragment-assignment-status" aria-live="polite">{unassigned.length?'未分配原子：'+formatAtomSelection(unassigned)+'。':'全部原子已分配。'}{overlapping.length?' 片段重叠原子：'+formatAtomSelection(overlapping)+'；请修正归属。':' 没有片段重叠。'}</p>
      {options.fragments.map((item,i)=><article className="fragment-editor shared-input-card shared-input-subcard" data-state={options.fragmentStatesConfirmed?'confirmed':'pending'} key={fragmentId(item,i)} data-fragment-index={i}>
        <InteractiveSelectionField renderHeader={actions=><header className="interactive-selection-header"><strong className="shared-input-card-title"><i className="fragment-color-dot" style={{background:fragmentColor(i)}} aria-hidden="true"/>片段{i+1}</strong>{actions}<SelectionRemoveButton label={'删除片段'+(i+1)} onClick={()=>change({fragmentStatesConfirmed:false,fragments:options.fragments.filter((_,index)=>index!==i)})}/></header>} structure={structure} label={'片段'+(i+1)} rowId={fragmentId(item,i)} engine="gaussian" purpose="fragment" taskId={task} atomIds={fragmentRows[i].atomIds} contextKey={JSON.stringify([settings,multiplicity])} disabled={files.geometry!=='explicit'||structure?.dimension===2} onRequestSelection={onRequestSelection} onPick={onPick} onConfirm={(ids,guard,overwrite)=>commitFragment(i,ids,guard,overwrite)} remainingAtomIds={structure&&!regionSelectionIdentityError(structure)?remainingRegionAtomIds(structure,fragmentRows,fragmentId(item,i)):[]}/>
        {!item.atoms.length?<p className="interactive-selection-empty">空片段草稿：确认成员后设置电子态；被覆盖移空的片段和原参数仍保留。</p>:<div className="fragment-electronic-state"><div className="two-fields"><label className="field">电荷<NumericInput aria-label={'片段'+(i+1)+'电荷'} stepper={true} step="1" value={item.charge} onChange={event=>{const charge=event.target.value===''?Number.NaN:Number(event.target.value);fragment(i,{charge,multiplicityMode:spinMode(item),...(spinMode(item)==='auto'?{multiplicity:suggestedMultiplicity(item.atoms.map(n=>atoms[n-1]),charge)}:{})});}}/></label><label className="field">多重度<NumericInput aria-label={'片段'+(i+1)+'多重度'} stepper={true} min="1" step="1" value={item.multiplicity} onChange={event=>{fragment(i,{multiplicity:event.target.value===''?Number.NaN:Number(event.target.value),multiplicityMode:'manual'});}}/></label></div></div>}
      </article>)}
      {!options.fragments.length&&<p className="interactive-selection-empty">尚未添加片段；生成BSSE仍需要至少两个完整片段。</p>}
      {options.fragments.length>=2&&options.fragments.every(item=>item.atoms.length>0)&&<label className="check-line"><input data-field="fragment-confirmation" type="checkbox" checked={options.fragmentStatesConfirmed} onChange={event=>change({fragmentStatesConfirmed:event.target.checked})}/><span>确认片段电子态</span></label>}</details>}
    {frequency?<CoreParameterGroup title="频率"><FrequencyCoreControls value={options.frequency} onChange={frequency=>change({frequency})} disabled={external&&task==='ts'&&xtbNeedsFrequency(settings,files,atoms.length)} ramanSupported={ramanSupported}/>{children}</CoreParameterGroup>:children}
  </InputSettingsCard>;
}
