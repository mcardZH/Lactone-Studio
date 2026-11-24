import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import {calculationRangeFromGrid,estimatedCalculationRange,uniqueCalculationRanges} from '../../results/calculation-range';
import CalculationRangeControl from './CalculationRangeControl';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useAnalysisProjectSnapshot,rebindAnalysisContext,isRestoredAnalysisData} from '../../projects/analysis-state';
import { exportSavedCube } from './export-saved-cube';
import type {ExcitationResult,ExcitationRunRequest,HoleElectronResult,NtoAnalysisResult,NtoField,NtoPair} from '../../results/excitation-contracts';
import {sameSurfaceContext} from '../../results/surface-field';
import {DEFAULT_MESH_FINISH} from '../../results/mesh-appearance';
import {formatResultValue} from '../../results/numeric-format';
import {InputSettingsAction,InputSettingsCheckbox} from '../InputSettingsLayout';
import {ScientificDataTable} from './ScientificDataTable';
import {scientificTableText,type ScientificTableProjection} from './scientific-table';
import {exportBlob} from './export-image';
import {ResultsMcpPortRegistration} from './results-mcp-context';
import {patchMeshFinish,settingBool,settingColor,settingDecimals,settingEnum,settingFraction,settingMeshFinish,settingPositive,settingText} from './analysis-mcp-settings';
import {analysisCube,analysisText} from './analysis-mcp-assets';
import {objectSchema} from '../mcp/types';
import MultiwfnProgress from './MultiwfnProgress';
import MultiwfnErrorNotice from './MultiwfnErrorNotice';
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
type ExcitationError = {message:string; requestId:string};
export interface ExcitationMeshReceipt {
 requestId: string;
 key: string;
 status: 'pending' | 'drawn' | 'failed';
 error?: string;
}
type ControlProps = ExcitationAnalysisControlsProps & {
 companionIdentity?: string;
 meshReceipts?: { nto: ExcitationMeshReceipt | null; density: ExcitationMeshReceipt | null };
};
interface StateCache {showNtoRange:boolean;showEhRange:boolean;rangeOwner:'nto'|'electron-hole';ehResultQuality?:string;nto:NtoAnalysisResult|null;holeElectron:HoleElectronResult|null;fields:Map<string,{field:NtoField;requestId:string}>;pairKey:string|null;side:'hole'|'electron';owner:'nto'|'electron-hole'|null;ntoDisplay:OrbitalLayerSettings;densityDisplay:ExcitationDensityDisplay;includeCoulomb:boolean;quality:ExcitationQuality;spacingBohr:number;ehQuality:ExcitationQuality;ehSpacingBohr:number;ntoError?:ExcitationError;ehError?:ExcitationError}
export function initialExcitationState():StateCache{return{showNtoRange:true,showEhRange:true,rangeOwner:'nto',nto:null,holeElectron:null,fields:new Map(),pairKey:null,side:'hole',owner:null,ntoDisplay:{...DEFAULT_ORBITAL_LAYER},densityDisplay:excitationDensityAppearance({mode:'overlay',visible:true,isovalue:.001,opacity:.65,holeColor:'#3976d2',electronColor:'#d04b4b',finish:DEFAULT_MESH_FINISH},'gallery-dual'),includeCoulomb:false,quality:'medium',spacingBohr:.2,ehQuality:'medium',ehSpacingBohr:.2};}
const excitationErrorKey=(density:boolean)=>density?'ehError':'ntoError';
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
function ExcitationAnalysisControlsInner(p:ControlProps){
 const appearanceDefaults=useSurfaceAppearanceDefaults(),appearanceInitialized=useRef(new Set<string>());
 const cache=useRef(new Map<string,StateCache>()),pending=useRef(new Map<string,{abort:AbortController;requestId:string;owner:'nto'|'electron-hole';cancel():void|Promise<void>}>()),alive=useRef(true),latest=useRef(p);latest.current=p;
 const [,refresh]=useState(0),[showAll,setShowAll]=useProjectState('ExcitationAnalysisControls.showAll', false),[allPairs,setAllPairs]=useProjectState('ExcitationAnalysisControls.allPairs', false),[pairDecimals,setPairDecimals]=useProjectState('ExcitationAnalysisControls.pairDecimals', 2),[moDecimals,setMoDecimals]=useProjectState('ExcitationAnalysisControls.moDecimals', 2),[decimals,setDecimals]=useProjectState('ExcitationAnalysisControls.decimals', 2),[lengthUnit,setLengthUnit]=useProjectState<'angstrom'|'bohr'>('ExcitationAnalysisControls.lengthUnit', 'angstrom'),[activeOwner,setActiveOwner]=useProjectState<'nto'|'electron-hole'>('ExcitationAnalysisControls.activeOwner', 'nto'),[plotRevision,setPlotRevision]=useState(0);
 const displayIntent=useRef(0);
 const densityState=p.electronHoleState===undefined?p.state:p.electronHoleState;
 const key=p.state?excitationStateKey(p.context,p.state):'',densityKey=densityState?excitationStateKey(p.context,densityState):'';
 const entryFor=(key:string)=>{if(!key)return null;let item=cache.current.get(key);if(!item){item=initialExcitationState();cache.current.set(key,item);}return item;};
 // Project restore can replace the cache while the active keys stay identical.
 const entry=entryFor(key),densityEntry=entryFor(densityKey);
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
 function selectOwner(owner:'nto'|'electron-hole'){displayIntent.current++;setActiveOwner(owner);}
 function patch(values:Partial<StateCache>,density=false){const own=density?densityEntry:entry;if(own){appearanceInitialized.current.add(density?densityKey:key);Object.assign(own,values);if(values.rangeOwner||values.owner)selectOwner(density?'electron-hole':'nto');touch();}}
 async function run(operation:ExcitationRunRequest['operation'],chosenPair=pair,side=entry?.side??'hole'){
  const density=operation==='hole-electron',own=density?densityEntry:entry,state=density?densityState:p.state;
  if(!own||!state||!p.bridge.run||!(density?ehAvailable:ntoAvailable)||pending.current.size>0)return;
  if(operation==='nto-field'&&!chosenPair)return;
  const context=p.context,quality=density?excitationQuality(own.ehQuality,own.ehSpacingBohr):excitationQuality(own.quality,own.spacingBohr),onAccepted=p.onAccepted,requestId=crypto.randomUUID(),abort=new AbortController();
  const owner=density?'electron-hole':'nto', intent=displayIntent.current;
  delete own[excitationErrorKey(density)];
  const cancel=p.bridge.cancel;
  pending.current.set(requestId,{requestId,abort,owner,cancel:()=>cancel?.(requestId)});touch();
  try{const value=await p.bridge.run({requestId,context,operation,state,quality,includeCoulomb:operation==='hole-electron'?own.includeCoulomb:undefined,...(operation==='nto-field'?{pairIndex:chosenPair!.index,spin:chosenPair!.spin,side,generationId:own.nto?.stamp.requestId}:{})},abort.signal);
   if(abort.signal.aborted||!alive.current)return;
   if(value.operation!==operation||!sameSurfaceContext(value.stamp,context)||value.stamp.requestId!==requestId||excitationStateKey(context,value.state)!==excitationStateKey(context,state))throw new Error('激发态结果与请求来源或态不一致。');
   if(value.operation==='nto'){own.nto=value;own.fields.clear();own.pairKey=value.pairs[0]?excitationPairKey(value.pairs[0]):null;}
   else if(value.operation==='hole-electron'){own.holeElectron=value;own.ehResultQuality=JSON.stringify(quality);}
   else own.fields.set(fieldKey(chosenPair!,side,JSON.stringify(quality)),{field:value.field,requestId});
   own.owner=owner;own.rangeOwner=owner;
   const current=latest.current,currentState=density?(current.electronHoleState===undefined?current.state:current.electronHoleState):current.state;
   const currentTarget=current.active&&current.available!==false&&currentState&&excitationStateKey(current.context,currentState)===excitationStateKey(context,state);
   const takeDisplay=!!currentTarget&&intent===displayIntent.current;
   if(value.operation==='nto-field'&&(!currentTarget||takeDisplay)){own.pairKey=excitationPairKey(chosenPair!);own.side=side;setPlotRevision(value=>value+1);}
   if(takeDisplay)selectOwner(owner);
   const fieldVisible=operation==='hole-electron' ? own.densityDisplay.visible
     : operation==='nto-field' && own.ntoDisplay.visible && JSON.stringify(excitationQuality(own.quality,own.spacingBohr))===JSON.stringify(quality);
   onAccepted?.(requestId,operation,takeDisplay&&fieldVisible);
  }catch(error){if(!abort.signal.aborted&&alive.current)own[excitationErrorKey(density)]={message:error instanceof Error?error.message:String(error),requestId};}
  finally{pending.current.delete(requestId);touch();}
 }
 function prepareField(chosen:NtoPair,side:'hole'|'electron'){
  if(!entry||busy)return;
  if(entry.fields.has(fieldKey(chosen,side,qualityKey))){
   patch({pairKey:excitationPairKey(chosen),side,owner:'nto',rangeOwner:'nto'});setPlotRevision(value=>value+1);
  }else void run('nto-field',chosen,side);
 }
 function choosePair(value:string){const chosen=entry?.nto?.pairs.find(item=>excitationPairKey(item)===value);if(chosen)prepareField(chosen,'hole');}
 function chooseSide(side:'hole'|'electron'){if(pair)prepareField(pair,side);}
 function selectTargetState(state:NonNullable<typeof p.state>,density:boolean){
  selectOwner(density?'electron-hole':'nto');p.onStateChange?.(state,density?'electron-hole':'nto');
 }
 const stateOptions=p.states?.map(state=>({id:excitationStateKey(p.context,state),label:excitationStateDisplayLabel(state),state}))??[];
 const excitationQualitySetting=settingEnum(EXCITATION_QUALITY.map(row=>row.value));
 const mcpPort=<ResultsMcpPortRegistration kind="runs" id={p.analysisId??null} port={{
  sourceRevision:JSON.stringify([key,densityKey,qualityKey,ehQualityKey,entry?.pairKey,entry?.side,densityEntry?.includeCoulomb,entry?.showNtoRange,densityEntry?.showEhRange,decimals,lengthUnit,activeOwner,entry?.ntoDisplay,densityEntry?.densityDisplay,fieldEntry?.requestId,densityEntry?.holeElectron?.stamp.requestId]),
  methods:[...(ntoAvailable?['nto',...(pair?['nto-field']:[])]:[]),...(ehAvailable?['hole-electron']:[])],
  assets:()=>{
   if(!p.active||p.available===false)return [];
   const density=densityEntry?.holeElectron;
   return [...(field?[analysisCube('nto-orbital',field,{context:field.context,state:field.state,spin:field.spin,side:field.side,requestId:fieldEntry?.requestId})]:[]),
    ...(entry?.nto?[analysisText('nto-weights',()=>JSON.stringify(entry.nto,null,2),{stamp:entry.nto.stamp,state:entry.nto.state},'json')]:[]),
    ...(density?[analysisCube('hole-density',density.hole,{stamp:density.stamp,state:density.state,source:density.hole.source}),
     analysisCube('electron-density',density.electron,{stamp:density.stamp,state:density.state,source:density.electron.source}),
     analysisText('electron-hole-metrics',()=>JSON.stringify({metrics:density.metrics,coulomb:density.coulomb,coefficients:density.coefficients},null,2),{stamp:density.stamp,state:density.state,provenance:density.provenance},'json')]:[])];
  },
  read:()=>({kind:'excited',busy:pending.current.size>0,progress:p.progress,unavailableReason:p.unavailableReason,
   nto:{state:p.state,quality:entry?excitationQuality(entry.quality,entry.spacingBohr):undefined,result:entry?.nto,
    pairKey:entry?.pairKey,side:entry?.side,field:field?{id:field.id,grid:field.grid}:null},
   holeElectron:{state:densityState,quality:densityEntry?excitationQuality(densityEntry.ehQuality,densityEntry.ehSpacingBohr):undefined,
    includeCoulomb:densityEntry?.includeCoulomb,result:densityEntry?.holeElectron&&{stamp:densityEntry.holeElectron.stamp,coefficients:densityEntry.holeElectron.coefficients,
     metrics:densityEntry.holeElectron.metrics,coulomb:densityEntry.holeElectron.coulomb,provenance:densityEntry.holeElectron.provenance,
     hole:densityEntry.holeElectron.hole.grid,electron:densityEntry.holeElectron.electron.grid}},
  }),
  execution:()=>{
   const current=pending.current.values().next().value;
   return {status:current?.abort.signal.aborted?'stopping':p.progress?.phase??(current?'running':'idle'),
    requestId:current?.requestId??p.progress?.identity.runId,stoppable:Boolean(current&&!current.abort.signal.aborted),progress:p.progress};
  },
  stop,
  configuration:{schema:objectSchema({...(p.onStateChange&&stateOptions.length?{ntoState:settingEnum(stateOptions.map(row=>row.id)),holeElectronState:settingEnum(stateOptions.map(row=>row.id))}:{}),
    ntoQuality:excitationQualitySetting,ntoSpacingBohr:settingPositive,pairKey:settingText,side:settingEnum(['hole','electron']),ntoShowRange:settingBool,
    holeElectronQuality:excitationQualitySetting,holeElectronSpacingBohr:settingPositive,includeCoulomb:settingBool,holeElectronShowRange:settingBool,decimals:settingDecimals,lengthUnit:settingEnum(['angstrom','bohr'])}),
   read:()=>({states:stateOptions,ntoState:key,holeElectronState:densityKey,ntoQuality:entry?.quality,ntoSpacingBohr:entry?.spacingBohr,
    pairKey:entry?.pairKey,pairs:entry?.nto?.pairs.map(excitationPairKey),side:entry?.side,ntoShowRange:entry?.showNtoRange,
    holeElectronQuality:densityEntry?.ehQuality,holeElectronSpacingBohr:densityEntry?.ehSpacingBohr,includeCoulomb:densityEntry?.includeCoulomb,holeElectronShowRange:densityEntry?.showEhRange,decimals,lengthUnit}),
   apply(values){
    if(!p.active||p.available===false||pending.current.size)throw new Error('当前激发态设置不可编辑。');
    const patch=values as Partial<{ntoState:string;holeElectronState:string;ntoQuality:ExcitationQuality;ntoSpacingBohr:number;pairKey:string;side:StateCache['side'];ntoShowRange:boolean;
     holeElectronQuality:ExcitationQuality;holeElectronSpacingBohr:number;includeCoulomb:boolean;holeElectronShowRange:boolean;decimals:number;lengthUnit:typeof lengthUnit}>;
    if(patch.ntoQuality&&patch.ntoQuality!=='custom'&&patch.ntoSpacingBohr!==undefined||patch.holeElectronQuality&&patch.holeElectronQuality!=='custom'&&patch.holeElectronSpacingBohr!==undefined)
     throw new Error('仅自定义质量使用显式格距。');
    const ntoState=stateOptions.find(row=>row.id===patch.ntoState),ehState=stateOptions.find(row=>row.id===patch.holeElectronState);
    const ntoTarget=entryFor(ntoState?.id??key),ehTarget=entryFor(ehState?.id??densityKey);
    if(patch.pairKey!==undefined&&!ntoTarget?.nto?.pairs.some(row=>excitationPairKey(row)===patch.pairKey))throw new Error('目标态尚未生成该 NTO 对。');
    if((patch.ntoQuality!==undefined||patch.ntoSpacingBohr!==undefined||patch.side!==undefined||patch.ntoShowRange!==undefined)&&!ntoTarget)
     throw new Error('请先选定 NTO 电子态。');
    if((patch.holeElectronQuality!==undefined||patch.holeElectronSpacingBohr!==undefined||patch.includeCoulomb!==undefined||patch.holeElectronShowRange!==undefined)&&!ehTarget)
     throw new Error('请先选定电子-空穴态。');
    if(ntoTarget){
     ntoTarget.quality=patch.ntoQuality??(patch.ntoSpacingBohr===undefined?ntoTarget.quality:'custom');
     ntoTarget.spacingBohr=patch.ntoSpacingBohr??ntoTarget.spacingBohr;ntoTarget.pairKey=patch.pairKey??ntoTarget.pairKey;
     ntoTarget.side=patch.side??ntoTarget.side;ntoTarget.showNtoRange=patch.ntoShowRange??ntoTarget.showNtoRange;
    }
    if(ehTarget){
     ehTarget.ehQuality=patch.holeElectronQuality??(patch.holeElectronSpacingBohr===undefined?ehTarget.ehQuality:'custom');
     ehTarget.ehSpacingBohr=patch.holeElectronSpacingBohr??ehTarget.ehSpacingBohr;ehTarget.includeCoulomb=patch.includeCoulomb??ehTarget.includeCoulomb;
     ehTarget.showEhRange=patch.holeElectronShowRange??ehTarget.showEhRange;
    }
    if(ntoState)selectTargetState(ntoState.state,false);
    if(ehState)selectTargetState(ehState.state,true);
    if(patch.decimals!==undefined)setDecimals(patch.decimals);
    if(patch.lengthUnit!==undefined)setLengthUnit(patch.lengthUnit);
    touch();
   }},
  presentation:{
   schema:objectSchema({
    activeLayer:settingEnum(['nto','electron-hole']),
    ...(entry?{nto:objectSchema({visible:settingBool,opacity:settingFraction,isovalue:settingPositive,
      phase:settingEnum(['both','positive','negative']),positiveColor:settingColor,negativeColor:settingColor,finish:settingMeshFinish})}:{}),
    ...(densityEntry?{electronHole:objectSchema({visible:settingBool,opacity:settingFraction,isovalue:settingPositive,
      mode:settingEnum(['hole','electron','overlay']),holeColor:settingColor,electronColor:settingColor,finish:settingMeshFinish})}:{}),
   }),
   read:()=>({activeLayer:activeOwner,
    nto:entry&&{...entry.ntoDisplay,stateId:key,fieldAvailable:Boolean(field),mesh:activeOwner==='nto'&&entry.ntoDisplay.visible?ntoMesh?.status:undefined},
    electronHole:densityEntry&&{...densityEntry.densityDisplay,stateId:densityKey,fieldAvailable:Boolean(densityEntry.holeElectron),
     mesh:activeOwner==='electron-hole'&&densityEntry.densityDisplay.visible?densityMesh?.status:undefined},
   }),
   apply(values){
    if(!p.active||p.available===false)throw new Error('当前激发态显示不可编辑。');
    const {activeLayer,nto,electronHole}=values as {activeLayer?:'nto'|'electron-hole';nto?:Partial<OrbitalLayerSettings>;electronHole?:Partial<ExcitationDensityDisplay>};
    if((nto||activeLayer==='nto')&&!entry||(electronHole||activeLayer==='electron-hole')&&!densityEntry)
     throw new Error('请先选择对应分析的电子态。');
    if(entry&&(nto||activeLayer==='nto')){
     const {finish,...display}=nto??{};
     patch({ntoDisplay:{...entry.ntoDisplay,...display,...(finish!==undefined&&{finish:patchMeshFinish(entry.ntoDisplay.finish,finish)})},
      ...(activeLayer==='nto'&&{owner:'nto'})});
    }
    if(densityEntry&&(electronHole||activeLayer==='electron-hole')){
     const {finish,...display}=electronHole??{};
     patch({densityDisplay:{...densityEntry.densityDisplay,...display,
      ...(finish!==undefined&&{finish:patchMeshFinish(densityEntry.densityDisplay.finish,finish)})},
      ...((activeLayer==='electron-hole'||activeLayer===undefined&&display.mode!==undefined)&&{owner:'electron-hole'})},true);
    }
   },
  },
  run(method,retry,parameters){
   if(Object.keys(parameters).length)throw new Error('激发态分析使用当前面板选中的态、轨道对和精度。');
   if(method==='hole-electron'?!ehAvailable:!ntoAvailable||method!=='nto'&&(method!=='nto-field'||!pair))
    throw new Error(p.unavailableReason||'当前来源与选中的电子态未开放此分析。');
   if(pending.current.size)throw new Error('已有激发态分析正在运行。');
   const existing=method==='nto'?entry?.nto?.stamp.requestId:method==='nto-field'?fieldEntry?.requestId:densityEntry?.ehResultQuality===ehQualityKey&&densityEntry.holeElectron?.coulomb.requested===densityEntry.includeCoulomb?densityEntry.holeElectron.stamp.requestId:undefined;
   if(existing&&!retry)return {status:'ready',requestId:existing};
   void run(method as ExcitationRunRequest['operation']);
   return {status:'submitted',requestId:[...pending.current.keys()][0],state:method==='hole-electron'?densityState:p.state};
  },
 }}/>;
 function stop(){for(const request of pending.current.values()){request.abort.abort();void Promise.resolve(request.cancel()).catch(error=>latest.current.onError?.(String(error)));}touch();}
 async function exportField(selected:NtoField|HoleElectronResult['hole'],density=false){
  const own=density?densityEntry:entry;if(!own)return;
  const errorKey=excitationErrorKey(density),requestId=crypto.randomUUID();
  delete own[errorKey];touch();
  try{
   if(isRestoredAnalysisData(selected)){
    await exportSavedCube(selected,'Ester-Studio-excitation.cube',{desktop:window.sciyueDesktop});
   }else if(p.bridge.exportCube)await p.bridge.exportCube(selected,new AbortController().signal);
  }catch(error){if(alive.current){own[errorKey]={message:error instanceof Error?error.message:String(error),requestId};touch();}}
 }
 const metrics=densityEntry?.holeElectron?holeElectronTables(densityEntry.holeElectron,decimals,lengthUnit):null;
 const missingFor=(density=false)=>p.unavailableReason||(!p.wavefunctionAvailable?'当前帧缺少匹配波函数。':!p.info?'等待激发态分析会话就绪。':!(density?densityAdmitted:admitted)?'当前态不属于此阶段可分析的末批 TD 输出。':excitationCapabilityReason(p.info));
 const qualityControl=(density=false)=><><CalculationQualityControl value={(density?densityEntry?.ehQuality:entry?.quality)??'medium'} options={EXCITATION_QUALITY} ariaLabel={density?'电子空穴网格质量':'激发态网格质量'} onChange={value=>patch(density?{ehQuality:value,rangeOwner:'electron-hole'}:{quality:value,rangeOwner:'nto'},density)} effectiveParameters={excitationQualityDescription((density?densityEntry?.ehQuality:entry?.quality)??'medium',(density?densityEntry?.ehSpacingBohr:entry?.spacingBohr)??.2)}>
 {(density?densityEntry?.ehQuality:entry?.quality)==='custom'&&<label>自定义格距 / bohr<NumericInput aria-label={density?'电子空穴自定义格距':'NTO自定义格距'} min={.000001} step={.05} value={(density?densityEntry?.ehSpacingBohr:entry?.spacingBohr)??.2} onChange={event=>{const spacing=Number(event.target.value);if(Number.isFinite(spacing)&&spacing>0)patch(density?{ehQuality:'custom',ehSpacingBohr:spacing,rangeOwner:'electron-hole'}:{quality:'custom',spacingBohr:spacing,rangeOwner:'nto'},density);}}/></label>}</CalculationQualityControl><CalculationRangeControl checked={(density?densityEntry?.showEhRange:entry?.showNtoRange)??true} onChange={value=>patch(density?{showEhRange:value,rangeOwner:'electron-hole'}:{showNtoRange:value,rangeOwner:'nto'},density)} range={density?ehRange:ntoRange} disabled={!(density?densityEntry:entry)}/></>;
 const restoreQuality=(density=false)=>{const defaults=initialExcitationState();patch(density?{ehQuality:defaults.ehQuality,ehSpacingBohr:defaults.ehSpacingBohr,showEhRange:defaults.showEhRange,rangeOwner:'electron-hole'}:{quality:defaults.quality,spacingBohr:defaults.spacingBohr,showNtoRange:defaults.showNtoRange,rangeOwner:'nto'},density);};
 const running=pending.current.values().next().value,runningOwner=running?.owner;
 const runningProgress=running&&p.progress?.identity.runId===running.requestId?p.progress:null;
 const progress=busy?<><MultiwfnProgress progress={runningProgress} operationLabel="激发态分析" showFailureReason={false}/>{!runningProgress&&<p role="status">正在准备激发态分析…</p>}</>:null;
 const stopAction=busy&&<button type="button" disabled={[...pending.current.values()].every(request=>request.abort.signal.aborted)} onClick={stop}>停止激发态分析</button>;
 const targetControl=(density=false)=>p.states&&p.onStateChange&&<div className="spectroscopy-control-row excitation-target"><label>目标态<select aria-label={density?'电子空穴目标态':'NTO目标态'} value={density?densityKey:key} onChange={event=>{const state=stateOptions.find(item=>item.id===event.target.value)?.state;if(state)selectTargetState(state,density);}}>{stateOptions.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label></div>;
 const ntoMesh=p.meshReceipts?.nto?.requestId===fieldEntry?.requestId?p.meshReceipts?.nto:null;
 const densityMesh=p.meshReceipts?.density?.requestId===densityEntry?.holeElectron?.stamp.requestId?p.meshReceipts?.density:null;
 return <div className="analysis-task-stack excitation-analysis">{mcpPort}
 <AnalysisTaskLayout variant="card" onRestoreQuality={entry?()=>restoreQuality():undefined} qualityDisabled={busy} title="自然跃迁轨道 NTO" className="spectroscopy-card" setup={targetControl()} quality={qualityControl()} actions={<><InputSettingsAction variant="primary" disabled={!ntoAvailable||busy} onClick={()=>void run('nto')}>计算当前态 NTO</InputSettingsAction>{runningOwner==='nto'&&stopAction}</>} progress={runningOwner==='nto'?progress:null}>
 {!ntoAvailable&&<p className="postprocess-note">{missingFor()}</p>}
 {entry?.ntoError&&<MultiwfnErrorNotice message={entry.ntoError.message} identity={entry.ntoError.requestId}/>}
 {ntoDisplayed&&entry?.ntoDisplay.visible&&ntoMesh?.status==='failed'&&<MultiwfnErrorNotice label="NTO 绘制失败" message={ntoMesh.error??'当前等值未形成可绘制的 NTO。'} identity={ntoMesh}/>}
 {field&&<ExcitationGridSummary field={field}/>}
 {entry?.nto&&<><ExcitationIntegrity result={entry.nto} details={false}/>
 <AnalysisTaskSection key={entry.nto.stamp.requestId} title="NTO 轨道对" className="nto-pair-list"><ResultTable variant="numeric" hideTitle initialColumnMinWidths={[112,64,96]} title="NTO 轨道对" projection={ntoPairTable(entry.nto,pairDecimals,allPairs)} exportProjection={ntoPairTable(entry.nto,pairDecimals,true)} format={{decimals:pairDecimals,onDecimalsChange:setPairDecimals,hideUnit:true,ariaLabel:'NTO 轨道对格式'}} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'pairs'])} fileName="Ester-Studio-nto-pairs.txt" selectedKey={entry.pairKey} onChoose={busy?undefined:choosePair}/><div className="analysis-actions"><InputSettingsAction onClick={()=>setAllPairs(value=>!value)}>{allPairs?'仅显示原始权重 >1%':'展开全部轨道对'}</InputSettingsAction></div></AnalysisTaskSection>
 <AnalysisPlotSettings testId="nto-plot-settings" key={`${key}:${plotRevision}`} onRestore={()=>{const saved=appearanceDefaults.snapshot?.value.orbital,base={...DEFAULT_ORBITAL_LAYER,phase:entry.ntoDisplay.phase,isovalue:entry.ntoDisplay.isovalue};patch({ntoDisplay:saved && 'colors' in saved?restoreOrbitalAppearance(base,saved):base});}}>
 {pair&&<div className="spectroscopy-control-row" role="group" aria-label="当前NTO分量"><span>轨道对 {pair.index}</span>{(['hole','electron'] as const).map(side=><button key={side} className="excitation-nto-side" type="button" disabled={busy} aria-pressed={ntoDisplayed&&entry.side===side&&field?.side===side} onClick={()=>chooseSide(side)}>{side==='hole'?'空穴 NTO':'电子 NTO'}</button>)}</div>}
 <OrbitalDrawOptions embedded value={entry.ntoDisplay} onChange={ntoDisplay=>patch({ntoDisplay})}/>
 <details className="postprocess-metadata-details" open><summary>导出</summary><div className="analysis-actions"><InputSettingsAction disabled={!field||!p.bridge.exportCube} onClick={()=>{if(field)void exportField(field);}}>导出当前 NTO Cube</InputSettingsAction></div></details>
 </AnalysisPlotSettings>
 <details className="postprocess-metadata-details"><summary>来源与方法详情</summary><ExcitationIntegrity result={entry.nto} warnings={false}/><output>λ 总和 {formatResultValue(entry.nto.eigenvalueSum,pairDecimals)}</output><ResultTable title="NTO 特征值" projection={ntoEigenvalueTable(entry.nto,pairDecimals)} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'eigenvalues'])} fileName="Ester-Studio-nto-eigenvalues.txt"/>{pair&&<><details><summary>MO 展开 · 轨道对 {pair.index}</summary>{entry.nto.expansion.available?<ResultTable variant="numeric" title="NTO 的 MO 展开" projection={ntoMoTable(pair,moDecimals)} format={{decimals:moDecimals,onDecimalsChange:setMoDecimals,ariaLabel:'NTO MO 展开格式'}} selectionScope={JSON.stringify([key,entry.nto.stamp.requestId,'mo',excitationPairKey(pair)])} fileName="Ester-Studio-nto-mo-contributions.txt"/>:<p role="status">{entry.nto.expansion.reason??'当前来源不能可靠展开原 MO。'}</p>}</details></>}</details></>}
 </AnalysisTaskLayout>
 <AnalysisTaskLayout variant="card" onRestoreQuality={densityEntry?()=>restoreQuality(true):undefined} qualityDisabled={busy} title="电子–空穴分析" className="spectroscopy-card" setup={targetControl(true)} quality={<>{qualityControl(true)}<InputSettingsCheckbox label="计算库仑模型" checked={densityEntry?.includeCoulomb??false} onChange={includeCoulomb=>patch({includeCoulomb},true)}/></>} actions={<><InputSettingsAction variant="primary" disabled={!ehAvailable||busy} onClick={()=>void run('hole-electron')}>计算当前态电子–空穴</InputSettingsAction>{runningOwner==='electron-hole'&&stopAction}</>} progress={runningOwner==='electron-hole'?progress:null}>
 {!ehAvailable&&<p className="postprocess-note">{missingFor(true)}</p>}
 {densityEntry?.ehError&&<MultiwfnErrorNotice message={densityEntry.ehError.message} identity={densityEntry.ehError.requestId}/>}
 {p.active&&activeOwner==='electron-hole'&&densityEntry?.densityDisplay.visible&&densityMesh?.status==='failed'&&<MultiwfnErrorNotice label="电子–空穴绘制失败" message={densityMesh.error??'当前等值未形成可绘制的密度表面。'} identity={densityMesh}/>}
 {densityEntry?.holeElectron&&<ExcitationGridSummary field={densityEntry.holeElectron.hole}/>}
 {metrics&&densityEntry&&<><ExcitationIntegrity result={densityEntry.holeElectron!} details={false}/><AnalysisTaskSection title="数值结果"><ResultTable title="电子–空穴指标" projection={showAll?metrics.complete:metrics.summary} exportProjection={metrics.complete} format={{decimals,onDecimalsChange:setDecimals,unit:lengthUnit,units:[{value:'angstrom',label:'Å（长度）'},{value:'bohr',label:'bohr（长度）'}],onUnitChange:value=>setLengthUnit(value as 'angstrom'|'bohr'),ariaLabel:'电子空穴指标格式'}} expansion={{expanded:showAll,onToggle:()=>setShowAll(value=>!value)}} selectionScope={JSON.stringify([densityKey,densityEntry.holeElectron!.stamp.requestId,'hole-electron'])} fileName="Ester-Studio-hole-electron.txt" layout="metrics"/></AnalysisTaskSection>
 <AnalysisPlotSettings testId="electron-hole-plot-settings" onRestore={()=>{const saved=appearanceDefaults.snapshot?.value['electron-hole'],base={...initialExcitationState().densityDisplay,isovalue:densityEntry.densityDisplay.isovalue,mode:densityEntry.densityDisplay.mode};patch({densityDisplay:saved && 'colors' in saved?restoreDensityAppearance(base,saved):base},true);}}><div className="spectroscopy-control-row">{(['hole','electron','overlay'] as const).map(mode=><button key={mode} type="button" aria-pressed={densityEntry.densityDisplay.mode===mode&&activeOwner==='electron-hole'} onClick={()=>patch({owner:'electron-hole',densityDisplay:{...densityEntry.densityDisplay,mode}},true)}>{mode==='hole'?'空穴密度':mode==='electron'?'电子密度':'叠加'}</button>)}<InputSettingsCheckbox label="显示密度" checked={densityEntry.densityDisplay.visible} onChange={visible=>patch({densityDisplay:{...densityEntry.densityDisplay,visible}},true)}/></div>
 <div className="orbital-draw-row orbital-draw-numbers">{(['opacity','isovalue'] as const).map(name=><label className="orbital-numeric-control" key={name}><span>{name==='opacity'?'不透明度':'等值'}</span><input type="range" aria-label={`电子空穴${name==='opacity'?'不透明度':'等值'}滑杆`} {...matchingSliderRange(densityEntry.densityDisplay[name],name==='opacity'?0:.0001,name==='opacity'?1:.02,name==='opacity'?.01:.0001)} value={densityEntry.densityDisplay[name]} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))patch({densityDisplay:{...densityEntry.densityDisplay,[name]:value}},true);}}/><NumericInput stepper adaptiveStep={name==='opacity'?.1:.01} aria-label={`电子空穴${name==='opacity'?'不透明度':'等值'}`} min={name==='opacity'?0:.000001} max={name==='opacity'?1:undefined} step={name==='opacity'?.01:.0001} value={densityEntry.densityDisplay[name]} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&(name==='opacity'?value>=0&&value<=1:value>0))patch({densityDisplay:{...densityEntry.densityDisplay,[name]:value}},true);}}/></label>)}</div>
 <SurfaceAppearanceControls label="电子空穴" presets={['dual']} value={densityEntry.densityDisplay.appearancePreset} onChange={id=>patch({densityDisplay:excitationDensityAppearance(densityEntry.densityDisplay,id)},true)} actions={<SaveSurfaceAppearanceDefault family="electron-hole" appearance={captureDensityAppearance(densityEntry.densityDisplay)}/>}><div className="orbital-draw-row">{(['holeColor','electronColor'] as const).map(name=><label key={name}>{name==='holeColor'?'空穴':'电子'}<input type="color" aria-label={`电子空穴${name==='holeColor'?'空穴':'电子'}颜色`} value={densityEntry.densityDisplay[name]} onChange={event=>patch({densityDisplay:{...densityEntry.densityDisplay,[name]:event.target.value}},true)}/></label>)}</div><MeshFinishControls labelPrefix="电子空穴" value={densityEntry.densityDisplay.finish} onChange={finish=>patch({densityDisplay:{...densityEntry.densityDisplay,finish}},true)}/></SurfaceAppearanceControls><details className="postprocess-metadata-details" open><summary>导出</summary><div className="analysis-actions"><InputSettingsAction disabled={!p.bridge.exportCube} onClick={()=>void exportField(densityEntry.holeElectron!.hole,true)}>导出空穴 Cube…</InputSettingsAction><InputSettingsAction disabled={!p.bridge.exportCube} onClick={()=>void exportField(densityEntry.holeElectron!.electron,true)}>导出电子 Cube…</InputSettingsAction></div></details></AnalysisPlotSettings><details className="postprocess-metadata-details"><summary>来源与方法详情</summary><ExcitationIntegrity result={densityEntry.holeElectron!} warnings={false}/></details></>}
 </AnalysisTaskLayout></div>;
}

export default function ExcitationAnalysisControls(p: Parameters<typeof ExcitationAnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['ExcitationAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><ExcitationAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:ExcitationAnalysisControlsInner(p);
}
