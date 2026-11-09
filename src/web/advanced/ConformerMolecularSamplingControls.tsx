import NumericInput from '../NumericInput';
import {useState,type ReactNode} from 'react';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {getConformerSamplingCapability,suggestConformerSamplingSphere,NATIVE_CONFORMER_CORE_PROTECTION} from '../../modeling/advanced/sampling-contracts';
import {InputSettingsCard,InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsCheckbox,InputSettingsSection} from '../InputSettingsLayout';
import {ADVANCED_METHODS} from './AdvancedMethodControls';
import ConformerSolventField from './ConformerSolventField';
import {applyConformerSamplingPreset,conformerSamplingPresetId,CONFORMER_SAMPLING_PRESETS} from './conformer-sampling-presets';
import {changeSamplingMethod,NATIVE_MD_CORE_UNAVAILABLE,type SamplingDraft} from './process-config';
import {protectionStrengthToDisplay,protectionStrengthToNative} from './protection-units';

export default function ConformerMolecularSamplingControls(p:{value:SamplingDraft;onChange(value:SamplingDraft):void;source:AdvancedFrameSource|null;renderRegion(label:string,ids:string[],onConfirm:(ids:string[])=>void):ReactNode;spherePreview?:boolean;onToggleSphere?():void;progress?:ReactNode;actions?:ReactNode;frameSummary?:ReactNode;sphereControls?:ReactNode;embedded?:boolean;sharedConstraints?:boolean}){
  const [custom,setCustom]=useState(false);
  const d=p.value,preset=custom?'custom':conformerSamplingPresetId(d);
  const update=(patch:Partial<SamplingDraft>)=>p.onChange({...d,...patch});
  const number=(key:keyof SamplingDraft,label:string,step=.01)=> <InputSettingsField label={label}><NumericInput aria-label={label}  step={step} value={Number(d[key])} onChange={event=>update({[key]:event.currentTarget.valueAsNumber})}/></InputSettingsField>;
  const time=(key:keyof SamplingDraft,label:string)=> <InputSettingsField label={label}><NumericInput aria-label={label}  min={0} step={.001} value={Number(d[key])/1000} onChange={event=>update({[key]:event.currentTarget.valueAsNumber*1000})}/></InputSettingsField>;
  const duration=d.operation==='md'?['molecularDurationFs','molecularSampleEveryFs'] as const:['durationFs','sampleEveryFs'] as const;
  const capability=getConformerSamplingCapability(d);
  const content=<>
    {p.progress}
    <InputSettingsRow className="shared-input-row-compact conformer-compact-fields"><InputSettingsField label="计算级别"><select aria-label="采样方法" value={d.method} onChange={event=>p.onChange(changeSamplingMethod(d,event.target.value as SamplingDraft['method']))}>{(['gfnff','gfn0','gfn1','gfn2','MMFF94','MMFF94s','UFF'] as const).map(id=><option key={id} value={id}>{ADVANCED_METHODS.find(([key])=>key===id)![1]}{id==='gfnff'?'（推荐）':''}</option>)}</select></InputSettingsField>
      <ConformerSolventField method={d.method} value={d} onChange={value=>update(value)} ariaLabel="采样溶剂"/>
    </InputSettingsRow>
    <InputSettingsRow className="shared-input-row-compact conformer-compact-fields"><InputSettingsField label="采样档位"><select aria-label="采样档位" value={preset} onChange={event=>{setCustom(event.target.value==='custom');const selected=applyConformerSamplingPreset(d,event.target.value as Parameters<typeof applyConformerSamplingPreset>[1]);p.onChange(selected.draft);}}><option value="random">随缘</option>{CONFORMER_SAMPLING_PRESETS.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}<option value="custom">自定义</option></select></InputSettingsField>{number('dtFs','步长 / fs',.1)}</InputSettingsRow>
    <InputSettingsRow className="shared-input-row-compact conformer-compact-fields">{number(d.operation==='md'?'molecularTemperatureK':'temperatureK','温度 / K',10)}{time(duration[0],'总时间 / ps')}{time(duration[1],'抽帧间隔 / ps')}{p.frameSummary}</InputSettingsRow>
    {d.operation==='anneal'&&<output role="status">退火已停用，历史结果仍可查看。</output>}
    <InputSettingsRow><InputSettingsCheckbox label="含氢键长约束" ariaLabel="含氢键长约束" checked={capability.shakeSupported&&d.shakeHydrogenBonds} disabled={!capability.shakeSupported} onChange={shakeHydrogenBonds=>{if(capability.shakeSupported)update({shakeHydrogenBonds});}}/><output aria-label="采样氢质量">氢质量：{d.hydrogenMassAmu===4?'4 amu':'自然质量'}</output></InputSettingsRow>
    {d.operation==='metadynamics'&&<><InputSettingsRow className="shared-input-row-compact">{number('heightEV','偏置势强度 / eV',.005)}{number('sigmaAngstrom','RMSD宽度 / Å',.1)}{time('depositEveryFs','加偏置间隔 / ps')}{number('maxHistory','历史帧上限',1)}<InputSettingsField label="偏置作用范围"><select aria-label="偏置作用范围" value={d.metaScope??(d.metaIds.length?'selected':'all')} onChange={event=>update({metaScope:event.target.value as 'all'|'selected'})}><option value="all">全体原子（{p.source?.structure.atoms.length??0}）</option><option value="selected">指定原子</option></select></InputSettingsField></InputSettingsRow>{capability.driver==='native-xtb-md'&&<p className="muted-note">原生偏置按指定间隔记录并动态调整最新历史势；强度为峰值，历史从初始结构开始。</p>}{(d.metaScope??(d.metaIds.length?'selected':'all'))==='selected'&&p.renderRegion('偏置作用原子',d.metaIds,metaIds=>update({metaIds}))}</>}
    {!p.sharedConstraints&&<><InputSettingsSection level={p.embedded?"inline":"subcard"} title="保护核心" collapsible>
      {p.renderRegion('保护原子',d.coreIds,coreIds=>update({coreIds}))}
      {capability.driver==='native-xtb-md'?(capability.coreProtectionSupported?<InputSettingsRow className="shared-input-row-compact"><output aria-label="原生核心保护强度">保护力常数：{Number(protectionStrengthToDisplay(d.coreForce).toPrecision(10)).toLocaleString('en-US')} kJ·mol⁻¹·nm⁻²</output><output aria-label="原生核心保护容差">核心 RMSD ＜ {NATIVE_CONFORMER_CORE_PROTECTION.maxRmsdAngstrom} Å</output></InputSettingsRow>:<p role="status">{NATIVE_MD_CORE_UNAVAILABLE}</p>):<InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="保护力常数 / kJ·mol⁻¹·nm⁻²"><NumericInput aria-label="保护力常数 / kJ·mol⁻¹·nm⁻²" style={{width:'8em'}}  min={0} step={500} value={Number(protectionStrengthToDisplay(d.coreForce).toPrecision(10))} onChange={event=>update({coreForce:protectionStrengthToNative(event.currentTarget.valueAsNumber)})}/></InputSettingsField></InputSettingsRow>}
    </InputSettingsSection>
    <InputSettingsSection level={p.embedded?"inline":"subcard"} title="将体系限制在一个球内" collapsible>
      <InputSettingsCheckbox label="启用" ariaLabel="将体系限制在一个球内" checked={d.sphereEnabled} disabled={!capability.sphereSupported} onChange={sphereEnabled=>update({sphereEnabled,...(sphereEnabled&&p.source?{sphere:suggestConformerSamplingSphere(p.source.structure,d.spherePaddingAngstrom)}:{})})}/>
      {d.sphereEnabled&&(p.sphereControls??<><InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="外扩距离 / Å"><NumericInput aria-label="球形采样外扩距离"  min={0} step={.5} value={d.spherePaddingAngstrom} onChange={event=>{const padding=event.currentTarget.valueAsNumber;update({spherePaddingAngstrom:padding,...(p.source&&Number.isFinite(padding)&&padding>=0?{sphere:suggestConformerSamplingSphere(p.source.structure,padding)}:{})});}}/></InputSettingsField></InputSettingsRow>{p.onToggleSphere&&<InputSettingsAction disabled={!p.source} onClick={p.onToggleSphere}>{p.spherePreview?'隐藏球预览':'显示球预览'}</InputSettingsAction>}</>)}
    </InputSettingsSection></>}
    <InputSettingsSection level={p.embedded?"inline":"subcard"} title="运行细节" collapsible><output aria-label="采样驱动">{capability.driver==='native-xtb-md'?(d.operation==='metadynamics'?'原生xTB RMSD-MTD':'原生xTB MD'):'ASE采样驱动'}</output><InputSettingsRow className="shared-input-row-compact conformer-compact-fields">{number('seed','采样随机种子',1)}{number('frictionPerFs','摩擦系数 / fs⁻¹',.001)}{number('reportEvery','记录步间隔',1)}</InputSettingsRow></InputSettingsSection>
    {p.actions}
  </>;
  return p.embedded?content:<InputSettingsCard title="采样设置" testId="conformer-molecular-sampling">{content}</InputSettingsCard>;
}
