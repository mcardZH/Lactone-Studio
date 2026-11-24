import {isPeriodic} from '../../core/periodic';
import {GxtbAvailability,useGxtbBackend,gxtbMethodLabel} from '../results/GxtbPathControl';
import NumericInput from '../NumericInput';
import {useState,type ReactNode} from 'react';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {supportsXtbOperation} from '../../core/xtb-capabilities';
import {effectiveSharedFreezes} from '../../modeling/constraints';
import {isPesNetMethod} from '../../modeling/pes/contracts';
import {conformerAlpbPresets} from '../../modeling/advanced/conformer-solvation';
import {getConformerSamplingCapability,suggestConformerSamplingSphere,NATIVE_CONFORMER_CORE_PROTECTION,NATIVE_CONFORMER_SEED_MAX} from '../../modeling/advanced/sampling-contracts';
import {InputSettingsCard,InputSettingsField,InputSettingsNumericControl,InputSettingsRow,InputSettingsStack} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsCheckbox,InputSettingsSection} from '../InputSettingsLayout';
import {CONFORMER_OPTIMIZATION_METHODS} from './AdvancedMethodControls';
import ConformerSolventField from './ConformerSolventField';
import {applyConformerSamplingPreset,conformerSamplingPresetId,CONFORMER_SAMPLING_PRESETS} from './conformer-sampling-presets';
import {changeSamplingMethod,NATIVE_MD_CORE_UNAVAILABLE,type SamplingDraft} from './process-config';
import {protectionStrengthToDisplay,protectionStrengthToNative} from './protection-units';
import {ConformerMethodField,conformerNetMethods} from './ConformerMethodFields';

export default function ConformerMolecularSamplingControls(p:{value:SamplingDraft;onChange(value:SamplingDraft):void;source:AdvancedFrameSource|null;renderRegion(label:string,ids:string[],onConfirm:(ids:string[])=>void):ReactNode;spherePreview?:boolean;onToggleSphere?():void;progress?:ReactNode;actions?:ReactNode;frameSummary?:ReactNode;sphereControls?:ReactNode;embedded?:boolean;sharedConstraints?:boolean}){
  const gxtbBackend=useGxtbBackend();
  const [custom,setCustom]=useState(false);
  const d=p.value,preset=custom?'custom':conformerSamplingPresetId(d);
  const update=(patch:Partial<SamplingDraft>)=>p.onChange({...d,...patch});
  const number=(key:keyof SamplingDraft,label:string,unit?:string,integer=false)=> <InputSettingsField label={label} unit={unit} controlWidth="number"><InputSettingsNumericControl ariaLabel={unit?`${label} / ${unit}`:label} integer={integer} value={Number(d[key])} onValue={value=>update({[key]:value})}/></InputSettingsField>;
  const time=(key:keyof SamplingDraft,label:string)=> <InputSettingsField label={label} unit="ps" controlWidth="number"><InputSettingsNumericControl ariaLabel={`${label} / ps`} min={0} value={Number(d[key])} scale={1000} onValue={value=>update({[key]:value})}/></InputSettingsField>;
  const duration=d.operation==='md'?['molecularDurationFs','molecularSampleEveryFs'] as const:['durationFs','sampleEveryFs'] as const;
  const periodic=isPeriodic(p.source?.structure),net=isPesNetMethod(d.method);
  const capability=getConformerSamplingCapability({...d,periodic});
  const native=capability.driver==='native-xtb-md',choices=['gfnff','gfn0','gfn1','gfn2','gxtb'];
  const hasCore=Boolean(p.source&&effectiveSharedFreezes(p.source.constraints).frozenAtomIds.length)||!p.sharedConstraints&&d.coreProtectionEnabled!==false&&d.coreIds.length>0;
  const methods=choices.flatMap(id=>{
    const option=CONFORMER_OPTIMIZATION_METHODS.find(([value])=>value===id);
    if(!option||!supportsXtbOperation(id,d.operation==='metadynamics'?'metadynamics':'md',periodic))return [];
    return [[id,id==='gxtb'?gxtbMethodLabel(gxtbBackend):option[1]+(id==='gfnff'?'（推荐）':'')] as const];
  });
  const selectableIntegrator=!periodic&&d.operation==='md'&&d.method!=='gxtb'&&supportsXtbOperation(d.method,'md');
  const shakeSupported=d.method!=='gfnff'&&capability.shakeSupported;
  const shakeHydrogenBonds=shakeSupported&&d.shakeHydrogenBonds;
  const hydrogenMass=d.integrator!==undefined||periodic||net?(shakeHydrogenBonds?1:4):d.hydrogenMassAmu;
  const seedMax=native?NATIVE_CONFORMER_SEED_MAX:0xffffffff;
  const invalidSeed=!Number.isInteger(d.seed)||d.seed<0||d.seed>seedMax;
  const content=<>
    {p.progress}<GxtbAvailability method={d.method}/>
    <InputSettingsRow>
      <ConformerMethodField method={d.method} ariaLabel="采样方法" xtb={methods} net={d.operation==='md'?conformerNetMethods(periodic):[]} onChange={method=>p.onChange(changeSamplingMethod(d,method as SamplingDraft['method'],periodic))}/>
      {!net&&!periodic&&conformerAlpbPresets(d.method).length>0&&<ConformerSolventField method={d.method} value={d} onChange={value=>update(value)} ariaLabel="采样溶剂"/>}
    </InputSettingsRow>
    <InputSettingsRow>
      <InputSettingsField label="采样档位" controlWidth="select"><select aria-label="采样档位" value={preset} onChange={event=>{setCustom(event.target.value==='custom');const selected=applyConformerSamplingPreset(d,event.target.value as Parameters<typeof applyConformerSamplingPreset>[1]);p.onChange(selected.draft);}}><option value="random">随缘</option>{CONFORMER_SAMPLING_PRESETS.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}<option value="custom">自定义</option></select></InputSettingsField>
      <InputSettingsField label="步长" unit="fs" controlWidth="short">{native&&(!hasCore||d.dtFs!==2)?
        <InputSettingsNumericControl ariaLabel="步长 / fs" min={hasCore?2:.01} max={2} value={d.dtFs} onValue={dtFs=>update({dtFs})}/>:
        <input aria-label="步长 / fs" value={d.dtFs} readOnly />}</InputSettingsField>
      {selectableIntegrator?<InputSettingsField label="积分器" controlWidth="select"><select aria-label="采样积分器" value={capability.integrator} onChange={event=>{const ase=event.currentTarget.value==='ase';update({integrator:ase?'ase':'xtb',...(ase?{dtFs:2}:{})});}}><option value="xtb">xTB 原生</option><option value="ase">ASE</option></select></InputSettingsField>:
        <span className="conformer-inline-fact">积分器 <output aria-label="采样积分器">{native?'xTB 原生':'ASE'}</output></span>}
    </InputSettingsRow>
    <InputSettingsRow>{number(d.operation==='md'?'molecularTemperatureK':'temperatureK','温度','K')}{time(duration[0],'总时间')}{time(duration[1],'抽帧间隔')}{p.frameSummary}</InputSettingsRow>
    {d.operation==='anneal'&&<output role="status">退火已停用，历史结果仍可查看。</output>}
    <InputSettingsRow><InputSettingsCheckbox label="含氢键长约束" ariaLabel="含氢键长约束" checked={shakeHydrogenBonds} disabled={!shakeSupported} onChange={shakeHydrogenBonds=>{if(shakeSupported)update({integrator:d.integrator??capability.integrator,shakeHydrogenBonds,hydrogenMassAmu:shakeHydrogenBonds?1:4});}}/><output aria-label="采样氢质量">氢质量 {hydrogenMass===undefined?'自然质量':`${hydrogenMass} amu`}</output></InputSettingsRow>
    {d.operation==='metadynamics'&&<><InputSettingsRow>{number('heightEV','偏置势强度','eV')}{number('sigmaAngstrom','RMSD宽度','Å')}{time('depositEveryFs','加偏置间隔')}{number('maxHistory','历史帧上限',undefined,true)}<InputSettingsField label="偏置作用范围" controlWidth="select"><select aria-label="偏置作用范围" value={d.metaScope??(d.metaIds.length?'selected':'all')} onChange={event=>update({metaScope:event.target.value as 'all'|'selected'})}><option value="all">全体原子（{p.source?.structure.atoms.length??0}）</option><option value="selected">指定原子</option></select></InputSettingsField></InputSettingsRow>{capability.driver==='native-xtb-md'&&<p>原生偏置按指定间隔记录并动态调整最新历史势；强度为峰值，历史从初始结构开始。</p>}{(d.metaScope??(d.metaIds.length?'selected':'all'))==='selected'&&p.renderRegion('偏置作用原子',d.metaIds,metaIds=>update({metaIds}))}</>}
    {!p.sharedConstraints&&<><InputSettingsSection level={p.embedded?"inline":"subcard"} title="保护核心" collapsible stack>
      {p.renderRegion('保护原子',d.coreIds,coreIds=>update({coreIds}))}
      {capability.driver==='native-xtb-md'?(capability.coreProtectionSupported?<InputSettingsRow className="shared-input-row-compact"><output aria-label="原生核心保护强度">保护力常数：{Number(protectionStrengthToDisplay(d.coreForce).toPrecision(10)).toLocaleString('en-US')} kJ·mol⁻¹·nm⁻²</output><output aria-label="原生核心保护容差">核心 RMSD ＜ {NATIVE_CONFORMER_CORE_PROTECTION.maxRmsdAngstrom} Å</output></InputSettingsRow>:<p role="status">{NATIVE_MD_CORE_UNAVAILABLE}</p>):<InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="保护力常数 / kJ·mol⁻¹·nm⁻²"><NumericInput aria-label="保护力常数 / kJ·mol⁻¹·nm⁻²" style={{width:'8em'}}  min={0} step={500} value={Number(protectionStrengthToDisplay(d.coreForce).toPrecision(10))} onChange={event=>update({coreForce:protectionStrengthToNative(event.currentTarget.valueAsNumber)})}/></InputSettingsField></InputSettingsRow>}
    </InputSettingsSection>
    {!periodic&&<InputSettingsSection level={p.embedded?"inline":"subcard"} title="将体系限制在一个球内" collapsible stack>
      <InputSettingsCheckbox label="启用" ariaLabel="将体系限制在一个球内" checked={d.sphereEnabled} disabled={!capability.sphereSupported} onChange={sphereEnabled=>update({sphereEnabled,...(sphereEnabled&&p.source?{sphere:suggestConformerSamplingSphere(p.source.structure,d.spherePaddingAngstrom)}:{})})}/>
      {d.sphereEnabled&&(p.sphereControls??<><InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="外扩距离 / Å"><NumericInput aria-label="球形采样外扩距离"  min={0} step={.5} value={d.spherePaddingAngstrom} onChange={event=>{const padding=event.currentTarget.valueAsNumber;update({spherePaddingAngstrom:padding,...(p.source&&Number.isFinite(padding)&&padding>=0?{sphere:suggestConformerSamplingSphere(p.source.structure,padding)}:{})});}}/></InputSettingsField></InputSettingsRow>{p.onToggleSphere&&<InputSettingsAction disabled={!p.source} onClick={p.onToggleSphere}>{p.spherePreview?'隐藏球预览':'显示球预览'}</InputSettingsAction>}</>)}
    </InputSettingsSection>}</>}
    <InputSettingsSection level={p.embedded?"inline":"subcard"} title="运行细节" collapsible stack>
      <InputSettingsRow>
        <output aria-label="采样温控">温控 {native?'Berendsen':'V-rescale'}</output>
        {!native&&<output>耦合时间 500 fs</output>}
        {d.method!=='gxtb'&&<InputSettingsField label="随机种子"><select aria-label="随机种子模式" value={d.seedMode??'explicit'} onChange={event=>update({seedMode:event.target.value==='auto'?'auto':'explicit'})}><option value="auto">自动</option><option value="explicit">指定</option></select></InputSettingsField>}
        {d.method!=='gxtb'&&(d.seedMode??'explicit')==='explicit'&&<InputSettingsField label="采样随机种子" controlWidth="long-number"><InputSettingsNumericControl ariaLabel="采样随机种子" invalid={invalidSeed} min={0} max={seedMax} integer value={d.seed} onValue={seed=>update({seed})}/></InputSettingsField>}
        {number('reportEvery','记录步间隔',undefined,true)}
      </InputSettingsRow>
    </InputSettingsSection>
    {p.actions}
  </>;
  return p.embedded?<InputSettingsStack>{content}</InputSettingsStack>:<InputSettingsCard stack title="采样设置" testId="conformer-molecular-sampling">{content}</InputSettingsCard>;
}
