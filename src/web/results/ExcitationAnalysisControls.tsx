import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import {calculationRangeFromGrid,estimatedCalculationRange,uniqueCalculationRanges} from '../../results/calculation-range';
import CalculationRangeControl from './CalculationRangeControl';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useAnalysisProjectSnapshot,rebindAnalysisContext,isRestoredAnalysisData,analysisProjectCubeArtifacts} from '../../projects/analysis-state';
import type {ExcitationResult,ExcitationRunRequest,HoleElectronResult,NtoAnalysisResult,NtoField,NtoPair} from '../../results/excitation-contracts';
import {sameSurfaceContext} from '../../results/surface-field';
import {DEFAULT_MESH_FINISH} from '../../results/mesh-appearance';
import {formatResultValue} from '../../results/numeric-format';
import {InputSettingsAction,InputSettingsCheckbox} from '../InputSettingsLayout';
import {ScientificDataTable} from './ScientificDataTable';
import {scientificTableText,type ScientificTableProjection} from './scientific-table';
import {exportBlob} from './export-image';
import MultiwfnProgress from './MultiwfnProgress';
import MeshFinishControls from './MeshFinishControls';
import SurfaceAppearanceControls from './SurfaceAppearanceControls';
import { excitationDensityAppearance } from './surface-appearance';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import { captureDensityAppearance, restoreDensityAppearance, restoreOrbitalAppearance } from './surface-appearance-defaults';
import {OrbitalDrawOptions} from './OrbitalControls';
import {DEFAULT_ORBITAL_LAYER,type OrbitalLayerSettings} from './orbital-display';
import {EXCITATION_QUALITY,excitationQuality,excitationQualityDescription,type ExcitationQuality,type ExcitationAnalysisControlsProps,type ExcitationDensityDisplay} from './excitation-controls-contracts';
import {AnalysisTaskLayout,AnalysisTaskSection,AnalysisPlotSettings,CalculationQualityControl} from './AnalysisTaskLayout';
import {excitationIntegrity,excitationCapabilityReason,excitationPairKey,excitationStateDisplayLabel,excitationStateKey,holeElectronTables,ntoEigenvalueTable,ntoMoTable,ntoPairTable} from './excitation-presentation';
import './SpectroscopyControls.css';
import './ExcitationAnalysisControls.css';
function ExcitationGridSummary({field}:{field:NtoField|HoleElectronResult['hole']}){
 const grid=field.grid;
 return <output className="analysis-quality-effective">实际网格 {grid.dimensions.join(' × ')}；格距 {grid.axes.map(axis=>Number(Math.hypot(...axis).toPrecision(5))).join(' / ')} {grid.coordinateUnit==='bohr'?'bohr':'Å'}</output>;
}
interface StateCache {showNtoRange:boolean;showEhRange:boolean;rangeOwner:'nto'|'electron-hole';ehResultQuality?:string;nto:NtoAnalysisResult|null;holeElectron:HoleElectronResult|null;fields:Map<string,{field:NtoField;requestId:string}>;pairKey:string|null;side:'hole'|'electron';owner:'nto'|'electron-hole'|null;ntoDisplay:OrbitalLayerSettings;densityDisplay:ExcitationDensityDisplay;includeCoulomb:boolean;quality:ExcitationQuality;spacingBohr:number;ehQuality:ExcitationQuality;ehSpacingBohr:number;error:string}
export function initialExcitationState():StateCache{return{showNtoRange:true,showEhRange:true,rangeOwner:'nto',nto:null,holeElectron:null,fields:new Map(),pairKey:null,side:'hole',owner:null,ntoDisplay:{...DEFAULT_ORBITAL_LAYER},densityDisplay:excitationDensityAppearance({mode:'overlay',visible:true,isovalue:.001,opacity:.65,holeColor:'#3976d2',electronColor:'#d04b4b',finish:DEFAULT_MESH_FINISH},'gallery-dual'),includeCoulomb:false,quality:'medium',spacingBohr:.2,ehQuality:'medium',ehSpacingBohr:.2,error:''};}
const fieldKey=(pair:NtoPair,side:'hole'|'electron',quality:string)=>`${excitationPairKey(pair)}:${side}:${quality}`;
function ResultTable(p:{title:string;hideTitle?:boolean;initialColumnMinWidths?:readonly number[];projection:ScientificTableProjection;exportProjection?:ScientificTableProjection;fileName:string;selectionScope:string;variant?:'numeric'|'legacy';expansion?:Parameters<typeof ScientificDataTable>[0]['expansion'];format?:Parameters<typeof ScientificDataTable>[0]['format'];layout?:'metrics';selectedKey?:string|null;onChoose?(key:string):void}){
 const root=useRef<HTMLDivElement>(null);
 const save=()=>exportBlob(new Blob([scientificTableText(p.exportProjection??p.projection)],{type:'text/plain;charset=utf-8'}),p.fileName,root.current?.ownerDocument);
 return <div ref={root} className="analysis-result"><ScientificDataTable variant={p.variant} title={p.title} hideTitle={p.hideTitle} initialColumnMinWidths={p.initialColumnMinWidths} projection={p.projection} selectionScope={p.selectionScope} layout={p.layout} format={p.format} expansion={p.expansion} onExport={save} activeRowKey={p.selectedKey??undefined} onRowActivate={p.onChoose?row=>p.onChoose?.(row.key):undefined}/></div>;
}
export function ExcitationIntegrity({result,details=true,warnings=true}:{result:NtoAnalysisResult|HoleElectronResult;details?:boolean;warnings?:boolean}){
 const integrity=excitationIntegrity(result);
 return <>{warnings&&integrity.warnings.map(warning=><p key={warning} role="status" className="postprocess-warning">警告：{warning}</p>)}{details&&<details className="postprocess-metadata-details"><summary>来源与完整性</summary><dl className="postprocess-values" aria-label="来源与完整性原始值">{integrity.details.map(row=><div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>{integrity.notices.length>0&&<ul aria-label="原始来源提示">{integrity.notices.map((notice,index)=><li key={index}>{notice}</li>)}</ul>}</details>}</>;
}
/** Results stay keyed to their original state. Visibility and cache misses never run science. */
export function excitationControlsProjectKey(p:ExcitationAnalysisControlsProps&{companionIdentity?:string}){
 const identity=projectUiSourceIdentity(p);
 return `controls:excitation:${p.companionIdentity===undefined?identity:JSON.stringify([...JSON.parse(identity),{companionIdentity:p.companionIdentity}])}`;
}
function ExcitationAnalysisControlsInner(p:ExcitationAnalysisControlsProps&{companionIdentity?:string}){
 const appearanceDefaults=useSurfaceAppearanceDefaults(),appearanceInitialized=useRef(new Set<string>());
 const cache=useRef(new Map<string,StateCache>()),pending=useRef(new Map<string,{abort:AbortController;requestId:string;owner:'nto'|'electron-hole';cancel():void|Promise<void>}>()),alive=useRef(true),latest=useRef(p);latest.current=p;
 const [,refresh]=useState(0),[showAll,setShowAll]=useProjectState('ExcitationAnalysisControls.showAll', false),[allPairs,setAllPairs]=useProjectState('ExcitationAnalysisControls.allPairs', false),[pairDecimals,setPairDecimals]=useProjectState('ExcitationAnalysisControls.pairDecimals', 2),[moDecimals,setMoDecimals]=useProjectState('ExcitationAnalysisControls.moDecimals', 2),[decimals,setDecimals]=useProjectState('ExcitationAnalysisControls.decimals', 2),[lengthUnit,setLengthUnit]=useProjectState<'angstrom'|'bohr'>('ExcitationAnalysisControls.lengthUnit', 'angstrom'),[activeOwner,setActiveOwner]=useProjectState<'nto'|'electron-hole'>('ExcitationAnalysisControls.activeOwner', 'nto'),[plotRevision,setPlotRevision]=useState(0);
 const visibleOwner=useRef(activeOwner);visibleOwner.current=activeOwner;
 const densityState=p.electronHoleState===undefined?p.state:p.electronHoleState;
 const key=p.state?excitationStateKey(p.context,p.state):'',densityKey=densityState?excitationStateKey(p.context,densityState):'';
 const entryFor=(key:string)=>{if(!key)return null;let item=cache.current.get(key);if(!item){item=initialExcitationState();cache.current.set(key,item);}return item;};
 const entry=useMemo(()=>entryFor(key),[key]),densityEntry=useMemo(()=>entryFor(densityKey),[densityKey]);
 const touch=()=>{if(alive.current)refresh(value=>value+1);};
 useAnalysisProjectSnapshot(excitationControlsProjectKey(p),()=>new Map(cache.current),saved=>{
  cache.current=rebindAnalysisContext(saved,p.context);for(const key of cache.current.keys())appearanceInitialized.current.add(key);touch();
 },undefined,()=>cache.current);
 useEffect(()=>{if(!appearanceDefaults.ready)return;let changed=false;for(const [id,item] of [[key,entry],[densityKey,densityEntry]] as const){if(!item||appearanceInitialized.current.has(id))continue;appearanceInitialized.current.add(id);const orbital=appearanceDefaults.snapshot?.value.orbital,density=appearanceDefaults.snapshot?.value['electron-hole'];if(orbital&&'colors' in orbital)item.ntoDisplay=restoreOrbitalAppearance(item.ntoDisplay,orbital);if(density&&'colors' in density)item.densityDisplay=restoreDensityAppearance(item.densityDisplay,density);changed=changed||!!orbital||!!density;}if(changed)touch();},[key,entry,densityKey,densityEntry,appearanceDefaults.ready,appearanceDefaults.snapshot]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const request of pending.current.values()){request.abort.abort();void request.cancel();}pending.current.clear();};},[]);
 const qualityKey=entry?JSON.stringify(excitationQuality(entry.quality,entry.spacingBohr)):'';
 const pair=entry?.nto?.pairs.find(row=>excitationPairKey(row)===entry.pairKey)??null,fieldEntry=entry&&pair?entry.fields.get(fieldKey(pair,entry.side,qualityKey))??null:null,field=fieldEntry?.field??null;
 const admits=(selected:typeof p.state)=>!!selected&&!!p.info?.states.some(state=>state.index===selected.index&&state.sourceLine===selected.sourceLine&&state.frameIndex===selected.frameIndex&&state.multiplicity===selected.multiplicity);
 const admitted=admits(p.state),densityAdmitted=admits(densityState);
 const ready=p.active&&p.available!==false&&!p.unavailableReason&&p.wavefunctionAvailable&&!!p.bridge.run&&!!p.info&&sameSurfaceContext(p.info.context,p.context);
 const ntoAvailable=ready&&admitted&&p.info?.capabilities.nto===true,ehAvailable=ready&&densityAdmitted&&p.info?.capabilities.holeElectron===true;
 const busy=pending.current.size>0;
  const ntoDisplayed=!!(p.active&&p.available!==false&&activeOwner==='nto'&&entry?.owner==='nto'&&field);
 const ntoRange=useMemo(()=>field?calculationRangeFromGrid(field.grid,`${key}:nto:${field.id}`,'NTO'):entry&&p.structure?estimatedCalculationRange(p.structure,excitationQuality(entry.quality,entry.spacingBohr),6,`${key}:nto:planned:${qualityKey}`,'NTO'):null,[key,field,p.structure,entry?.quality,entry?.spacingBohr,qualityKey]);
 const ehQualityKey=densityEntry?JSON.stringify(excitationQuality(densityEntry.ehQuality,densityEntry.ehSpacingBohr)):'';
 const ehRange=useMemo(()=>densityEntry?.holeElectron&&densityEntry.ehResultQuality===ehQualityKey?calculationRangeFromGrid(densityEntry.holeElectron.hole.grid,`${densityKey}:eh:${densityEntry.holeElectron.stamp.requestId}`,'电子–空穴'):densityEntry&&p.structure?estimatedCalculationRange(p.structure,excitationQuality(densityEntry.ehQuality,densityEntry.ehSpacingBohr),6,`${densityKey}:eh:planned:${ehQualityKey}`,'电子–空穴'):null,[densityKey,p.structure,densityEntry?.holeElectron,densityEntry?.ehResultQuality,ehQualityKey]);
 const calculationRanges=useMemo(()=>uniqueCalculationRanges(activeOwner==='electron-hole'?densityEntry?.showEhRange&&ehRange?[ehRange]:[]:entry?.showNtoRange&&ntoRange?[ntoRange]:[]),[activeOwner,entry?.showNtoRange,densityEntry?.showEhRange,ntoRange,ehRange]);
 useEffect(()=>{const selected=activeOwner==='nto'?p.state:densityState,own=activeOwner==='nto'?entry:densityEntry;if(!entry||!own||!selected||!p.active||p.available===false){p.onProjection(null);return;}
  const eh=densityEntry?.holeElectron??null,display=densityEntry?.densityDisplay??entry.densityDisplay,owner=own.owner?activeOwner:null;
  p.onProjection({calculationRanges,context:p.context,state:selected,displayOwner:owner,nto:entry.nto,ntoField:owner==='nto'?field:null,ntoFieldRequestId:fieldEntry?.requestId??null,ntoDisplay:entry.ntoDisplay,holeElectron:eh,densityFields:owner==='electron-hole'&&eh?(display.mode==='hole'?[eh.hole]:display.mode==='electron'?[eh.electron]:[eh.hole,eh.electron]):[],densityDisplay:display,decimals});
 },[p.context,key,densityKey,p.active,p.available,p.onProjection,entry,densityEntry,field,activeOwner,entry?.owner,densityEntry?.owner,entry?.nto,densityEntry?.holeElectron,entry?.ntoDisplay,densityEntry?.densityDisplay,decimals,calculationRanges]);
 function patch(values:Partial<StateCache>,density=false){const own=density?densityEntry:entry;if(own){appearanceInitialized.current.add(density?densityKey:key);Object.assign(own,values);if(values.rangeOwner||values.owner)setActiveOwner(density?'electron-hole':'nto');touch();}}
 async function run(operation:ExcitationRunRequest['operation'],chosenPair=pair,side=entry?.side??'hole'){
  const density=operation==='hole-electron',own=density?densityEntry:entry,state=density?densityState:p.state;
  if(!own||!state||!p.bridge.run||!(density?ehAvailable:ntoAvailable)||pending.current.size>0)return;
  if(operation==='nto-field'&&!chosenPair)return;
  const context=p.context,quality=density?excitationQuality(own.ehQuality,own.ehSpacingBohr):excitationQuality(own.quality,own.spacingBohr),onAccepted=p.onAccepted,requestId=crypto.randomUUID(),abort=new AbortController();
  setActiveOwner(density?'electron-hole':'nto');
  own.owner=operation==='hole-electron'?'electron-hole':'nto';own.rangeOwner=own.owner;own.error='';const cancel=p.bridge.cancel;pending.current.set(requestId,{requestId,abort,owner:own.owner,cancel:()=>cancel?.(requestId)});touch();
  try{const value=await p.bridge.run({requestId,context,operation,state,quality,includeCoulomb:operation==='hole-electron'?own.includeCoulomb:undefined,...(operation==='nto-field'?{pairIndex:chosenPair!.index,spin:chosenPair!.spin,side,generationId:own.nto?.stamp.requestId}:{})},abort.signal);
   if(abort.signal.aborted||!alive.current)return;
   if(value.operation!==operation||!sameSurfaceContext(value.stamp,context)||value.stamp.requestId!==requestId||excitationStateKey(context,value.state)!==excitationStateKey(context,state))throw new Error('激发态结果与请求来源或态不一致。');
   if(value.operation==='nto'){own.nto=value;own.fields.clear();own.pairKey=value.pairs[0]?excitationPairKey(value.pairs[0]):null;}
   else if(value.operation==='hole-electron'){own.holeElectron=value;own.ehResultQuality=JSON.stringify(quality);}
   else own.fields.set(fieldKey(chosenPair!,side,JSON.stringify(quality)),{field:value.field,requestId});
   const current=latest.current,currentState=density?(current.electronHoleState===undefined?current.state:current.electronHoleState):current.state,visible=current.active&&current.available!==false&&visibleOwner.current===(density?'electron-hole':'nto')&&currentState&&excitationStateKey(current.context,currentState)===excitationStateKey(context,state);
   onAccepted?.(requestId,operation,operation!=='nto'&&!!visible);
  }catch(error){if(!abort.signal.aborted&&alive.current){own.error=error instanceof Error?error.message:String(error);latest.current.onError?.(own.error);}}
  finally{pending.current.delete(requestId);touch();}
 }
 function prepareField(chosen:NtoPair,side:'hole'|'electron'){
  patch({pairKey:excitationPairKey(chosen),side,owner:'nto',rangeOwner:'nto'});setPlotRevision(value=>value+1);
  if(entry&&!entry.fields.has(fieldKey(chosen,side,qualityKey)))void run('nto-field',chosen,side);
 }
 function choosePair(value:string){const chosen=entry?.nto?.pairs.find(item=>excitationPairKey(item)===value);if(chosen)prepareField(chosen,'hole');}
 function chooseSide(side:'hole'|'electron'){if(pair)prepareField(pair,side);}
 function stop(){for(const request of pending.current.values()){request.abort.abort();void request.cancel();}touch();}
 async function exportField(selected:NtoField|HoleElectronResult['hole'],density=false){if(isRestoredAnalysisData(selected)){try{const files=analysisProjectCubeArtifacts(selected);exportBlob(new Blob([files.cube],{type:'text/plain'}),'Ester-Studio-excitation.cube');exportBlob(new Blob([files.metadata],{type:'application/json'}),'Ester-Studio-excitation.sciyue-domain.json');}catch(error){patch({error:error instanceof Error?error.message:String(error)},density);}return;}if(!p.bridge.exportCube)return;const abort=new AbortController();try{await p.bridge.exportCube(selected,abort.signal);}catch(error){patch({error:error instanceof Error?error.message:String(error)},density);}}
 const metrics=densityEntry?.holeElectron?holeElectronTables(densityEntry.holeElectron,decimals,lengthUnit):null;
 const missingFor=(density=false)=>p.unavailableReason||(!p.wavefunctionAvailable?'当前帧缺少匹配波函数。':!p.info?'等待激发态分析会话就绪。':!(density?densityAdmitted:admitted)?'当前态不属于此阶段可分析的末批 TD 输出。':excitationCapabilityReason(p.info));
 const qualityControl=(density=false)=><><CalculationQualityControl value={(density?densityEntry?.ehQuality:entry?.quality)??'medium'} options={EXCITATION_QUALITY} ariaLabel={density?'电子空穴网格质量':'激发态网格质量'} onChange={value=>patch(density?{ehQuality:value,rangeOwner:'electron-hole'}:{quality:value,rangeOwner:'nto'},density)} effectiveParameters={excitationQualityDescription((density?densityEntry?.ehQuality:entry?.quality)??'medium',(density?densityEntry?.ehSpacingBohr:entry?.spacingBohr)??.2)}>
 {(density?densityEntry?.ehQuality:entry?.quality)==='custom'&&<label>自定义格距 / bohr<NumericInput aria-label={density?'电子空穴自定义格距':'NTO自定义格距'} min={.000001} step={.05} value={(density?densityEntry?.ehSpacingBohr:entry?.spacingBohr)??.2} onChange={event=>{const spacing=Number(event.target.value);if(Number.isFinite(spacing)&&spacing>0)patch(density?{ehQuality:'custom',ehSpacingBohr:spacing,rangeOwner:'electron-hole'}:{quality:'custom',spacingBohr:spacing,rangeOwner:'nto'},density);}}/></label>}</CalculationQualityControl><CalculationRangeControl checked={(density?densityEntry?.showEhRange:entry?.showNtoRange)??true} onChange={value=>patch(density?{showEhRange:value,rangeOwner:'electron-hole'}:{showNtoRange:value,rangeOwner:'nto'},density)} range={density?ehRange:ntoRange} disabled={!(density?densityEntry:entry)}/></>;
 const restoreQuality=(density=false)=>{const defaults=initialExcitationState();patch(density?{ehQuality:defaults.ehQuality,ehSpacingBohr:defaults.ehSpacingBohr,showEhRange:defaults.showEhRange,rangeOwner:'electron-hole'}:{quality:defaults.quality,spacingBohr:defaults.spacingBohr,showNtoRange:defaults.showNtoRange,rangeOwner:'nto'},density);};
 const progress=busy?<><MultiwfnProgress progress={p.progress??null} operationLabel="激发态分析" onStop={stop}/>{!p.progress&&<p role="status">正在准备激发态分析…</p>}</>:null;
 const runningOwner=[...pending.current.values()][0]?.owner;
 const stopAction=busy&&<button type="button" disabled={[...pending.current.values()].every(request=>request.abort.signal.aborted)} onClick={stop}>停止激发态分析</button>;
 const targetControl=(density=false)=>p.states&&p.onStateChange&&<div className="spectroscopy-control-row excitation-target"><label>目标态<select aria-label={density?'电子空穴目标态':'NTO目标态'} value={density?densityKey:key} onChange={event=>{const state=p.states?.find(item=>excitationStateKey(p.context,item)===event.target.value);if(state){setActiveOwner(density?'electron-hole':'nto');p.onStateChange?.(state,density?'electron-hole':'nto');}}}>{p.states.map(state=><option key={excitationStateKey(p.context,state)} value={excitationStateKey(p.context,state)}>{excitationStateDisplayLabel(state)}</option>)}</select></label></div>;
 return <div className="analysis-task-stack excitation-analysis">
 <AnalysisTaskLayout variant="card" onRestoreQuality={entry?()=>restoreQuality():undefined} qualityDisabled={busy} title="自然跃迁轨道 NTO" className="spectroscopy-card" setup={targetControl()} quality={qualityControl()} actions={<><InputSettingsAction variant="primary" disabled={!ntoAvailable||busy} onClick={()=>void run('nto')}>计算当前态 NTO</InputSettingsAction>{runningOwner==='nto'&&stopAction}</>} progress={runningOwner==='nto'?progress:null}>
 {!ntoAvailable&&<p className="postprocess-note">{missingFor()}</p>}
 {field&&<ExcitationGridSummary field={field}/>}
 {entry?.nto&&<><ExcitationIntegrity result={entry.nto} details={false}/>
 <AnalysisTaskSection key={entry.nto.stamp.requestId} title="NTO 轨道对" className="nto-pair-list"><ResultTable variant="numeric" hideTitle initialColumnMinWidths={[112,64,96]} title="NTO 轨道对" projection={ntoPairTable(entry.nto,pairDecimals,allPairs)} exportProjection={ntoPairTable(entry.nto,pairDecimals,true)} format={{decimals:pairDecimals,onDecimalsChange:setPairDecimals,hideUnit:true,ariaLabel:'NTO 轨道对格式'}} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'pairs'])} fileName="Ester-Studio-nto-pairs.txt" selectedKey={entry.pairKey} onChoose={busy?undefined:choosePair}/><div className="analysis-actions"><InputSettingsAction onClick={()=>setAllPairs(value=>!value)}>{allPairs?'仅显示原始权重 >1%':'展开全部轨道对'}</InputSettingsAction></div></AnalysisTaskSection>
 <AnalysisPlotSettings key={`${key}:${plotRevision}`} onRestore={()=>{const saved=appearanceDefaults.snapshot?.value.orbital,base={...DEFAULT_ORBITAL_LAYER,isovalue:entry.ntoDisplay.isovalue};patch({ntoDisplay:saved && 'colors' in saved?restoreOrbitalAppearance(base,saved):base});}}>
 {pair&&<div className="spectroscopy-control-row" role="group" aria-label="当前NTO分量"><span>轨道对 {pair.index}</span>{(['hole','electron'] as const).map(side=><button key={side} className="excitation-nto-side" type="button" disabled={busy} aria-pressed={ntoDisplayed&&entry.side===side&&field?.side===side} onClick={()=>chooseSide(side)}>{side==='hole'?'空穴 NTO':'电子 NTO'}</button>)}</div>}
 <OrbitalDrawOptions embedded value={entry.ntoDisplay} onChange={ntoDisplay=>patch({ntoDisplay})}/>
 <details className="postprocess-metadata-details" open><summary>导出</summary><div className="analysis-actions"><InputSettingsAction disabled={!field||!p.bridge.exportCube} onClick={()=>{if(field)void exportField(field);}}>导出当前 NTO Cube</InputSettingsAction></div></details>
 </AnalysisPlotSettings>
 <details className="postprocess-metadata-details"><summary>来源与方法详情</summary><ExcitationIntegrity result={entry.nto} warnings={false}/><output>λ 总和 {formatResultValue(entry.nto.eigenvalueSum,pairDecimals)}</output><ResultTable title="NTO 特征值" projection={ntoEigenvalueTable(entry.nto,pairDecimals)} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'eigenvalues'])} fileName="Ester-Studio-nto-eigenvalues.txt"/>{pair&&<><details><summary>MO 展开 · 轨道对 {pair.index}</summary>{entry.nto.expansion.available?<ResultTable variant="numeric" title="NTO 的 MO 展开" projection={ntoMoTable(pair,moDecimals)} format={{decimals:moDecimals,onDecimalsChange:setMoDecimals,ariaLabel:'NTO MO 展开格式'}} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'mo',excitationPairKey(pair)])} fileName="Ester-Studio-nto-mo-contributions.txt"/>:<p role="status">{entry.nto.expansion.reason??'当前来源不能可靠展开原 MO。'}</p>}</details></>}</details></>}
 </AnalysisTaskLayout>
 <AnalysisTaskLayout variant="card" onRestoreQuality={densityEntry?()=>restoreQuality(true):undefined} qualityDisabled={busy} title="电子–空穴分析" className="spectroscopy-card" setup={targetControl(true)} quality={<>{qualityControl(true)}<InputSettingsCheckbox label="计算库仑模型" checked={densityEntry?.includeCoulomb??false} onChange={includeCoulomb=>patch({includeCoulomb},true)}/></>} actions={<><InputSettingsAction variant="primary" disabled={!ehAvailable||busy} onClick={()=>void run('hole-electron')}>计算当前态电子–空穴</InputSettingsAction>{runningOwner==='electron-hole'&&stopAction}</>} progress={runningOwner==='electron-hole'?progress:null}>
 {!ehAvailable&&<p className="postprocess-note">{missingFor(true)}</p>}
 {densityEntry?.holeElectron&&<ExcitationGridSummary field={densityEntry.holeElectron.hole}/>}
 {metrics&&densityEntry&&<><ExcitationIntegrity result={densityEntry.holeElectron!} details={false}/><AnalysisTaskSection title="数值结果"><ResultTable title="电子–空穴指标" projection={showAll?metrics.complete:metrics.summary} exportProjection={metrics.complete} format={{decimals,onDecimalsChange:setDecimals,unit:lengthUnit,units:[{value:'angstrom',label:'Å（长度）'},{value:'bohr',label:'bohr（长度）'}],onUnitChange:value=>setLengthUnit(value as 'angstrom'|'bohr'),ariaLabel:'电子空穴指标格式'}} expansion={{expanded:showAll,onToggle:()=>setShowAll(value=>!value)}} selectionScope={JSON.stringify([densityKey,densityEntry.holeElectron!.stamp.requestId,'hole-electron'])} fileName="Ester-Studio-hole-electron.txt" layout="metrics"/></AnalysisTaskSection>
 <AnalysisPlotSettings onRestore={()=>{const saved=appearanceDefaults.snapshot?.value['electron-hole'],base={...initialExcitationState().densityDisplay,isovalue:densityEntry.densityDisplay.isovalue,mode:densityEntry.densityDisplay.mode};patch({densityDisplay:saved && 'colors' in saved?restoreDensityAppearance(base,saved):base},true);}}><div className="spectroscopy-control-row">{(['hole','electron','overlay'] as const).map(mode=><button key={mode} type="button" aria-pressed={densityEntry.densityDisplay.mode===mode&&activeOwner==='electron-hole'} onClick={()=>patch({owner:'electron-hole',densityDisplay:{...densityEntry.densityDisplay,mode}},true)}>{mode==='hole'?'空穴密度':mode==='electron'?'电子密度':'叠加'}</button>)}<InputSettingsCheckbox label="显示密度" checked={densityEntry.densityDisplay.visible} onChange={visible=>patch({densityDisplay:{...densityEntry.densityDisplay,visible}},true)}/></div>
 <div className="orbital-draw-row orbital-draw-numbers">{(['opacity','isovalue'] as const).map(name=><label className="orbital-numeric-control" key={name}><span>{name==='opacity'?'不透明度':'等值'}</span><input type="range" aria-label={`电子空穴${name==='opacity'?'不透明度':'等值'}滑杆`} {...matchingSliderRange(densityEntry.densityDisplay[name],name==='opacity'?0:.0001,name==='opacity'?1:.02,name==='opacity'?.01:.0001)} value={densityEntry.densityDisplay[name]} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))patch({densityDisplay:{...densityEntry.densityDisplay,[name]:value}},true);}}/><NumericInput stepper adaptiveStep={name==='opacity'?.1:.01} aria-label={`电子空穴${name==='opacity'?'不透明度':'等值'}`} min={name==='opacity'?0:.000001} max={name==='opacity'?1:undefined} step={name==='opacity'?.01:.0001} value={densityEntry.densityDisplay[name]} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&(name==='opacity'?value>=0&&value<=1:value>0))patch({densityDisplay:{...densityEntry.densityDisplay,[name]:value}},true);}}/></label>)}</div>
 <SurfaceAppearanceControls label="电子空穴" presets={['dual']} value={densityEntry.densityDisplay.appearancePreset} onChange={id=>patch({densityDisplay:excitationDensityAppearance(densityEntry.densityDisplay,id)},true)} actions={<SaveSurfaceAppearanceDefault family="electron-hole" appearance={captureDensityAppearance(densityEntry.densityDisplay)}/>}><div className="orbital-draw-row">{(['holeColor','electronColor'] as const).map(name=><label key={name}>{name==='holeColor'?'空穴':'电子'}<input type="color" aria-label={`电子空穴${name==='holeColor'?'空穴':'电子'}颜色`} value={densityEntry.densityDisplay[name]} onChange={event=>patch({densityDisplay:{...densityEntry.densityDisplay,[name]:event.target.value}},true)}/></label>)}</div><MeshFinishControls labelPrefix="电子空穴" value={densityEntry.densityDisplay.finish} onChange={finish=>patch({densityDisplay:{...densityEntry.densityDisplay,finish}},true)}/></SurfaceAppearanceControls><details className="postprocess-metadata-details" open><summary>导出</summary><div className="analysis-actions"><InputSettingsAction disabled={!p.bridge.exportCube} onClick={()=>void exportField(densityEntry.holeElectron!.hole,true)}>导出空穴 Cube…</InputSettingsAction><InputSettingsAction disabled={!p.bridge.exportCube} onClick={()=>void exportField(densityEntry.holeElectron!.electron,true)}>导出电子 Cube…</InputSettingsAction></div></details></AnalysisPlotSettings><details className="postprocess-metadata-details"><summary>来源与方法详情</summary><ExcitationIntegrity result={densityEntry.holeElectron!} warnings={false}/></details></>}
 </AnalysisTaskLayout>{entry?.error&&<DismissibleNotice role="alert">{entry.error}</DismissibleNotice>}{densityEntry!==entry&&densityEntry?.error&&<DismissibleNotice role="alert">{densityEntry.error}</DismissibleNotice>}</div>;
}

export default function ExcitationAnalysisControls(p: Parameters<typeof ExcitationAnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['ExcitationAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><ExcitationAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:ExcitationAnalysisControlsInner(p);
}
