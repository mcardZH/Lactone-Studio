import type {AdvancedDockingTaskOptions,AdvancedSameFrameFragments} from '../../modeling/advanced/contracts';
import {prepareSameFrameDocking,remainingDockingAtomIds} from '../../modeling/conformers';
import type {AnalysisSelectionPort} from '../analysis-selection-intent';
import InteractiveSelectionField from '../InteractiveSelectionField';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {assertAdvancedIsolated} from '../../modeling/advanced/frame-source';
import {dockingSettings} from '../../modeling/advanced/route-data';
import {InputSettingsCard,InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsSection,InputSettingsCheckbox} from '../InputSettingsLayout';
import {AdvancedNumberFields} from './AdvancedProcessControls';

export type DockingDraft=ReturnType<typeof dockingSettings>&{threads:number;maxWallTimeSeconds:number};
export const initialDockingDraft:DockingDraft={...dockingSettings({method:'gfn2',threads:2,maxWallTimeSeconds:30}),threads:2,maxWallTimeSeconds:30};
export function compileDocking(draft:DockingDraft,source:AdvancedFrameSource,partner:AdvancedFrameSource|null):AdvancedDockingTaskOptions{
 if(!partner)throw Error('请独立取用第二个完整分子来源。');
 for(const input of [source,partner]){
  assertAdvancedIsolated(input);
  if(input.structure.charge!==0||input.structure.multiplicity!==1)throw Error('aISS首批仅接受两个显式中性闭壳层来源，不会修改电荷或多重度。');
  if(input.constraints.frozenAtomIds.length||input.constraints.coordinates.length||input.structure.modelLayers?.some(layer=>layer.frozen))throw Error('aISS尚未支持来源冻结；不会静默移除原子、B/A/D或层冻结。');
 }
 if(source.structure.atoms.length+partner.structure.atoms.length>500)throw Error('两个分子合计最多500个原子。');
 return{...dockingSettings(draft),threads:draft.threads};
}
export function compileSameFrameDocking(draft:DockingDraft,source:AdvancedFrameSource,fragments:AdvancedSameFrameFragments){const pair=prepareSameFrameDocking(source,fragments);return compileDocking(draft,pair.sources[0],pair.sources[1]);}
export function AdvancedDockingControls(p:{value:DockingDraft;onChange(value:DockingDraft):void;source:AdvancedFrameSource|null;partner?:AdvancedFrameSource|null;onCapturePartner?():void;fragments?:AdvancedSameFrameFragments;onFragments?(value:AdvancedSameFrameFragments):void;fragmentPort?:AnalysisSelectionPort;selectionEnabled?:boolean;onRequest?():void;electronicStatesConfirmed?:boolean;onElectronicStatesConfirmed?(confirmed:boolean):void}){
 const d=p.value,update=(patch:Partial<DockingDraft>)=>p.onChange({...d,...patch});
 if(p.fragments&&p.fragmentPort){
  const fragments=p.fragments,field=(side:'aAtomIds'|'bAtomIds',label:string)=><InteractiveSelectionField structure={p.source?.structure??null} label={label} rowId={`docking-${side}`} kind="atoms" atomIds={fragments[side]} disabled={!p.selectionEnabled} captureOwner={p.fragmentPort!.owner} contextKey={p.fragmentPort!.contextKey} analysisPurpose="advanced-region" clearLabel="清空定义" remainingAtomIds={side==='bAtomIds'&&p.source&&fragments.aAtomIds.length?remainingDockingAtomIds(p.source,fragments.aAtomIds):undefined} onRequestAnalysisSelection={intent=>{p.onRequest?.();return p.fragmentPort!.requestSelection(intent);}} onConfirm={(ids,guard)=>{guard();p.onFragments?.({...fragments,[side]:ids});p.onElectronicStatesConfirmed?.(false);}} onClear={()=>{p.onFragments?.({...fragments,[side]:[]});p.onElectronicStatesConfirmed?.(false);}}/>;
  return <InputSettingsCard title="双分子对接" testId="conformer-same-frame-docking"><InputSettingsSection level="subcard" title="分子A" className="conformer-fragment-group">{field('aAtomIds','片段A')}</InputSettingsSection><InputSettingsSection level="subcard" title="分子B" className="conformer-fragment-group">{field('bAtomIds','片段B')}</InputSettingsSection><InputSettingsRow><output>A：{fragments.aAtomIds.length} 原子</output><output>B：{fragments.bAtomIds.length} 原子</output></InputSettingsRow>
    <InputSettingsCheckbox label="确认A/B均为中性闭壳层（电荷0，多重度1）" checked={!!p.electronicStatesConfirmed} onChange={checked=>p.onElectronicStatesConfirmed?.(checked)}/>
    <InputSettingsSection level="subcard" title="对接搜索设置" collapsible><AdvancedNumberFields value={d.search} onChange={search=>update({search})} fields={[[ 'maxGenerations','遗传代数',1],['maxParents','父代数',1],['stackPoints','堆叠点数',1],['radialStepBohr','径向步长 / Bohr',.01]]}/><AdvancedNumberFields value={d} onChange={p.onChange} fields={[[ 'maxWallTimeSeconds','对接时间上限 / s']]}/></InputSettingsSection>
  </InputSettingsCard>;
 }
 return <InputSettingsCard title="双分子对接"><InputSettingsAction variant="surface" onClick={()=>p.onCapturePartner?.()}>取用当前帧为第二分子</InputSettingsAction>
  <p className="muted-note">第一分子：{p.source?.label??'尚未取用'}</p><p className="muted-note">第二分子：{p.partner?.label??'尚未取用'}</p>
  {p.partner&&<p className="muted-note">{p.partner.structure.atoms.length} 原子 · 电荷 {p.partner.structure.charge} · 多重度 {p.partner.structure.multiplicity}</p>}
  <p role="status">aISS 原生精化路线尚未通过科学验收。首批仅中性闭壳层、气相；初筛评分不是结合自由能。</p>
  <InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="对接方法"><select value="gfn2" aria-label="对接方法" disabled><option value="gfn2">GFN2 / xTB-IFF</option></select></InputSettingsField><InputSettingsField label="对接介质"><select value="gas" aria-label="对接介质" disabled><option value="gas">气相</option></select></InputSettingsField></InputSettingsRow>
  <AdvancedNumberFields value={d} onChange={p.onChange} fields={[[ 'threads','对接线程',1],['maxWallTimeSeconds','对接时间上限 / s']]}/>
  <InputSettingsSection level="subcard" title="初筛搜索" collapsible defaultOpen><AdvancedNumberFields value={d.search} onChange={search=>update({search})} fields={[[ 'maxGenerations','遗传代数',1],['maxParents','父代数',1],['stackPoints','堆叠点数',1],['radialStepBohr','径向步长 / Bohr',.01]]}/><InputSettingsField label="角度步长 / °"><select aria-label="对接角度步长" value={d.search.angularStepDegrees} onChange={event=>update({search:{...d.search,angularStepDegrees:Number(event.target.value) as DockingDraft['search']['angularStepDegrees']}})}>{[45,60,90,120,180].map(value=><option key={value} value={value}>{value}</option>)}</select></InputSettingsField></InputSettingsSection>
  <InputSettingsSection level="subcard" title="原生精化候选" collapsible defaultOpen><AdvancedNumberFields value={d.refinement} onChange={refinement=>update({refinement})} fields={[[ 'candidateCount','精化候选数',1],['maxSteps','原生精化步数',1]]}/><AdvancedNumberFields value={d.calculator} onChange={calculator=>update({calculator})} fields={[[ 'maxIterations','单次 SCC 迭代上限',1]]}/></InputSettingsSection>
 </InputSettingsCard>;
}
