import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import type { ExcitedState } from '../../results/scientific-contracts';
import { buildAbsorptionSpectrum, excitedStatesForFrame, MULTIPLICITY_NOTE } from '../../results/spectroscopy';
import { InputSettingsCard } from '../InputSettingsFields';
import { InputSettingsLayout } from '../InputSettingsLayout';
import SpectroscopyControls, { SpectroscopyTable } from './SpectroscopyControls';
import { excitedStateDetails, excitedStateLabel, excitedStateTable, transitionTable } from './spectroscopy-presentation';

export const tddftStateKey=(result:TrajectoryResult,state:ExcitedState)=>JSON.stringify([result.source.id,result.jobIndex,state.frameIndex,state.sourceLine,state.index]);
function TDDFTControlsInner(p: { result: TrajectoryResult; currentIndex: number;decimals?:number;onDecimalsChange?(value:number):void;selectedStateKey?:string|null;onSelectedState?(state:ExcitedState):void;renderAnalysis?(state:ExcitedState):ReactNode }) {
  const [localDecimals,setLocalDecimals]=useProjectState('TDDFTControls.localDecimals', 2),decimals=p.decimals??localDecimals;
  const setDecimals=(value:number)=>{setLocalDecimals(value);p.onDecimalsChange?.(value);};
  const [transitionDecimals,setTransitionDecimals]=useProjectState('TDDFTControls.transitionDecimals', 2);
  const [axis, setAxis] = useProjectState<'eV' | 'nm'>('TDDFTControls.axis', 'eV'), [selected, setSelected] = useProjectState<string|null>('TDDFTControls.selected', null);
  const states = useMemo(() => excitedStatesForFrame(p.result.scientific, p.currentIndex), [p.result, p.currentIndex]);
  const state = states.find(item=>tddftStateKey(p.result,item)===(p.selectedStateKey??selected))??states[0], identity = `${p.result.source.id}:${p.result.jobIndex}:${p.currentIndex}`;
  const selectIndex=(index:number)=>{const next=states[index];if(!next)return;setSelected(tddftStateKey(p.result,next));p.onSelectedState?.(next);};
  const build = useCallback((options: { range?: [number, number]; fwhm: number; normalize: boolean }) => buildAbsorptionSpectrum(states, { ...options, axis }), [states, axis]);
  const reference = p.result.scientific?.reference;
  const unrestricted = reference === 'unrestricted' || (reference == null || reference === 'unknown') && (p.result.scientific?.orbitals.some(channel => channel.frameIndex === p.currentIndex && channel.spin !== 'restricted') || /\b(?:UHF|UKS|UB3LYP|UPBE\w*)\b/i.test(p.result.scientific?.route ?? ''));
  if (!states.length) return <InputSettingsCard collapsible title="TDDFT"><p className="postprocess-note">当前帧未输出激发态数据。</p></InputSettingsCard>;
  return <InputSettingsLayout><InputSettingsCard collapsible title="激发态" className="spectroscopy-card"><SpectroscopyTable projection={excitedStateTable(states, unrestricted,decimals)} format={{decimals,onDecimalsChange:setDecimals,ariaLabel:'激发态表格格式'}} selectionScope={`${identity}:states`} fileName="Ester-Studio-excited-states.txt" selectedKey={String(states.indexOf(state))} onSelect={key => selectIndex(Number(key))} hideTitle/>
      <details><summary>来源与态详情</summary>{excitedStateDetails(state, decimals).map(detail=><p className="postprocess-note" key={detail}>{detail}</p>)}
        {p.result.scientific?.properties.filter(field=>field.key.startsWith(`excited-${state.sourceLine}-`)).map(field=><p className="postprocess-note" key={field.key}>{field.label}：{String(field.value)} {field.unit} · 源行 {field.sourceLine}</p>)}
        <p className="postprocess-note">{MULTIPLICITY_NOTE}</p></details></InputSettingsCard>
    <InputSettingsCard collapsible title={`${excitedStateLabel(state, unrestricted)} · 组态组成`} className="spectroscopy-card">{state.transitions.length ? <><SpectroscopyTable projection={transitionTable(state,transitionDecimals,{engine:p.result.engine,reference,channels:p.result.scientific?.orbitals.filter(channel=>channel.frameIndex===p.currentIndex)??[]})} format={{decimals:transitionDecimals,onDecimalsChange:setTransitionDecimals,ariaLabel:'组态组成表格格式'}} selectionScope={`${identity}:${tddftStateKey(p.result,state)}:transitions`} fileName="Ester-Studio-transitions.txt" initialColumnMinWidths={[112,112,64,96,96]} hideTitle/>
      <details><summary>来源与组态详情</summary><p className="postprocess-note">{p.result.engine==='orca'?'贡献采用原生组态权重 × 100；没有打印的有符号系数显示为 —。':'受限闭壳层正向激发在占据数可确认时采用 2c² × 100；其余未确认贡献显示为 —。'} 截断列表不重新归一化。</p>
        {state.transitions.map((row,index)=><p className="postprocess-note" key={index}>{row.from} {row.direction??'→'} {row.to} · 系数 {row.amplitude??'—'} · 原生权重 {row.weight??'—'}{row.sourceLine==null?'':` · 源行 ${row.sourceLine}`}</p>)}</details></> : <p className="postprocess-note">此态未输出组态组成。</p>}</InputSettingsCard>
    <div className="spectroscopy-control-row"><label>吸收谱横轴<select aria-label="吸收谱横轴" value={axis} onChange={event => setAxis(event.target.value as typeof axis)}><option value="eV">eV</option><option value="nm">nm</option></select></label></div>
    {states.some(item => item.oscillatorStrength != null && Number.isFinite(item.oscillatorStrength)) ? <SpectroscopyControls title="吸收谱" decimals={decimals} identity={identity} axis={axis} fwhmUnit="eV" defaultFwhm={.2} build={build} selectedIndex={states.indexOf(state)} onSelectIndex={selectIndex} sourceIndex={(line,sourceIndex) => states.findIndex(item => item.sourceLine === line&&(sourceIndex===undefined||item.index===sourceIndex))}/> : <InputSettingsCard collapsible title="吸收谱"><p className="postprocess-note">当前帧未输出振子强度。</p></InputSettingsCard>}
    {p.renderAnalysis?.(state)}
  </InputSettingsLayout>;
}

export default function TDDFTControls(p: Parameters<typeof TDDFTControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['TDDFTControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><TDDFTControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:TDDFTControlsInner(p);
}
