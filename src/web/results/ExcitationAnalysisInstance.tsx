import {transformCalculationRange} from '../../results/calculation-range';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {Structure} from '../../core/types';
import type {ModelDocument} from '../../modeling/contracts';
import type {PostprocessDocument} from '../../results/postprocess-document';
import {projectPostprocessFrame} from '../../results/postprocess-document';
import type {SurfaceContext} from '../../results/surface-contracts';
import type {ExcitationStateRef} from '../../results/excitation-contracts';
import type {ExcitedState} from '../../results/scientific-contracts';
import {excitedStatesForFrame} from '../../results/spectroscopy';
import {InputSettingsCard} from '../InputSettingsFields';
import type {MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import {sameSurfaceContext} from '../../results/surface-field';
import type {ViewportSurfaceLayer,SurfaceLayerMeshState,SurfaceMeshState} from '../modeling/render/surface-layer';
import type {ViewportNtoLayer,NtoMeshState} from '../modeling/render/orbital-layer';
import TDDFTControls,{tddftStateKey} from './TDDFTControls';
import ExcitationAnalysisControls, { type ExcitationMeshReceipt } from './ExcitationAnalysisControls';
import MultiwfnErrorNotice from './MultiwfnErrorNotice';
import { isMultiwfnBackendFailure } from './multiwfn-errors';
import { MULTIWFN_CONFIGURATION_CHANGED } from '../global-settings-events';
import type {ExcitationProjection} from './excitation-controls-contracts';
import {createExcitationDesktopBridge,type ExcitationDesktopApi} from './excitation-desktop-bridge';
import {surfaceScientificContextKey,surfaceSourceLifetimeKey} from './surface-context-pool';
import {listExplicitExcitationCompanions} from '../../projects/companion-sources';
import {isNativeEstimatedMultiplicity} from './scientific-presentation';
import { useAnalysisProjectSnapshot } from '../../projects/analysis-state';

export interface ExcitationViewportProjection extends ExcitationProjection {ntoLayer:ViewportNtoLayer|null;surfaceLayers:readonly (ViewportSurfaceLayer & {id:string})[]}
/** Only explicit printed multiplicities are adapted; no inference from S² or labels. */
export function excitationPrintedMultiplicity(value: string | null): number | undefined {
 const text=value?.trim().toLowerCase();
 const named:Record<string,number>={singlet:1,singlets:1,doublet:2,doublets:2,triplet:3,triplets:3,quartet:4,quartets:4,quintet:5,quintets:5,sextet:6,sextets:6,septet:7,septets:7,octet:8,octets:8,nonet:9,nonets:9};
 if(!text)return undefined;if(named[text]!==undefined)return named[text];
 const explicit=text.match(/^(?:mult(?:iplicity)?\s*[=:]?\s*)?([1-9]\d*)$/);if(!explicit)return undefined;
 const number=Number(explicit[1]);return Number.isSafeInteger(number)?number:undefined;
}
export function excitationStateAdmission(state:Pick<ExcitedState,'multiplicity'|'multiplicityProvenance'>|undefined){
 if(isNativeEstimatedMultiplicity(state))return{supported:false as const,reason:'原生 Mult 为估计值，不满足当前 NTO/电子–空穴分析支持的受限闭壳层参考态条件。'};
 return{supported:true as const,multiplicity:excitationPrintedMultiplicity(state?.multiplicity??null)};
}
export interface ExcitationMeshObserver {nto(state:Readonly<NtoMeshState>,document:Pick<ModelDocument,'id'|'revision'>):void;density(states:readonly SurfaceLayerMeshState[],document:Pick<ModelDocument,'id'|'revision'>):void}
export function createExcitationMeshObservers(){const observers=new Map<string,ExcitationMeshObserver>(),bindings=new Map<string,(value:ExcitationMeshObserver|null)=>void>();return{get:(id:string)=>observers.get(id),binding(id:string){let binding=bindings.get(id);if(!binding){binding=value=>{if(bindings.get(id)!==binding)return;if(value)observers.set(id,value);else observers.delete(id);};bindings.set(id,binding);}return binding;},release(id:string){observers.delete(id);bindings.delete(id);}};}
export interface ExcitationAnalysisInstanceProps {
 analysisId:string;context:SurfaceContext;document:PostprocessDocument;structure:Structure;modelDocument:ModelDocument;currentIndex:number;
 wavefunctionAvailable:boolean;active:boolean;available?:boolean;desktop?:ExcitationDesktopApi|null;decimals:number;onDecimalsChange(value:number):void;
 onProjection(value:ExcitationViewportProjection|null):void;onMeshObserverReady?(observer:ExcitationMeshObserver|null):void;onExportImage?():void|Promise<void>;onError(message:string):void;
}
/** Display-only adapter: NTO amplitudes retain their own DTO; density is never an orbital amplitude. */
export function excitationInstanceProjection(projection:ExcitationProjection|null,p:Pick<ExcitationAnalysisInstanceProps,'analysisId'|'context'|'document'|'modelDocument'>):ExcitationViewportProjection|null {
 if(!projection||!sameSurfaceContext(projection.context,p.context))return null;
 const proof=p.document.pair&&p.document.pair.primary===p.document.output?.source&&p.document.pair.wavefunction===p.document.wavefunction?.source?p.document.pair:null;
 const fit=proof?.sourceToDisplay,documentId=p.modelDocument.id,geometryRevision=p.modelDocument.revision,display=projection.densityDisplay;
 return {...projection,calculationRanges:projection.calculationRanges?.map(range=>transformCalculationRange(range,fit)),ntoLayer:projection.displayOwner==='nto'&&projection.ntoField?{kind:'nto',field:projection.ntoField,documentId,geometryRevision,...projection.ntoDisplay,sourceToDocument:fit}:null,
  surfaceLayers:projection.displayOwner==='electron-hole'?projection.densityFields.map(field=>({id:`${p.analysisId}:${field.excitationRole}`,pair:{kind:'excitation-density' as const,shape:field,mapping:null,isovalue:display.isovalue},documentId,geometryRevision,visible:display.visible,opacity:display.opacity,finish:display.finish,solidColor:field.excitationRole==='hole-density'?display.holeColor:display.electronColor,sourceToDocument:fit})):[]};
}
type MeshDocument = Pick<ModelDocument, 'id' | 'revision'>;
type MeshReceipts = { nto: ExcitationMeshReceipt | null; density: ExcitationMeshReceipt | null };
function currentMeshDocument(layer: { documentId: string; geometryRevision: number }, actual: MeshDocument) {
 return layer.documentId === actual.id && layer.geometryRevision === actual.revision;
}
function emptySubmittedMesh(state: Readonly<SurfaceMeshState>) {
 return meshSubmitted(state) && (state.vertexCount === 0 || state.triangleCount === 0);
}
function meshSubmitted(state: Readonly<SurfaceMeshState>) {
 return state.status === 'committed' && state.submitted && !!state.attemptKey && state.attemptKey === state.committedKey;
}
export function excitationNtoMeshReceipt(projection: ExcitationViewportProjection | null, state: Readonly<NtoMeshState>, actual: MeshDocument): ExcitationMeshReceipt | null {
 const layer = projection?.ntoLayer, requestId = projection?.ntoFieldRequestId;
 if (!layer?.visible || !requestId || !currentMeshDocument(layer, actual) || state.fieldId !== layer.field.id || !state.attemptKey) return null;
 const key = state.attemptKey;
 if (state.status === 'failed') return { requestId, key, status: 'failed', error: state.error };
 if (emptySubmittedMesh(state)) return { requestId, key, status: 'failed', error: '当前等值未形成可绘制的 NTO。' };
 return { requestId, key, status: meshSubmitted(state) ? 'drawn' : 'pending' };
}
export function excitationDensityMeshReceipt(projection: ExcitationViewportProjection | null, states: readonly SurfaceLayerMeshState[], actual: MeshDocument): ExcitationMeshReceipt | null {
 const result = projection?.holeElectron, layers = projection?.surfaceLayers;
 if (!result || !layers?.length || layers.some(layer => !layer.visible || !currentMeshDocument(layer, actual))) return null;
 const current = layers.map(layer => states.find(state => state.layerId === layer.id && state.shapeId === layer.pair.shape.id && state.attemptKey));
 if (!current.some(Boolean)) return null;
 const requestId = result.stamp.requestId, key = JSON.stringify(current.map(state => state?.attemptKey ?? null));
 const failed = current.find(state => state?.status === 'failed' || state && emptySubmittedMesh(state));
 if (failed) return { requestId, key, status: 'failed', error: failed.error ?? '当前等值未形成可绘制的密度表面。' };
 return { requestId, key, status: current.every(state => state && meshSubmitted(state)) ? 'drawn' : 'pending' };
}
type Controller=ReturnType<typeof createExcitationDesktopBridge>;
interface Entry {controller:Controller;progress:MultiwfnProgressSnapshot|null;unsubscribe():void}
interface Pool {entries:Map<string,Entry>;disposed:boolean;ready:Promise<void>}
export default function ExcitationAnalysisInstance(p:ExcitationAnalysisInstanceProps){
 const desktop=p.desktop===undefined?(typeof window==='undefined'?null:window.sciyueDesktop??null):p.desktop;
 const companionIdentity=JSON.stringify([p.document.output?.source.excitationCompanionSelection??'automatic',p.document.output?listExplicitExcitationCompanions(p.document.output).map(file=>[file.role,file.name,file.revision,file.bytes]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))):[]]);
 const key=surfaceScientificContextKey(p.context),lifetime=`${surfaceSourceLifetimeKey(p.analysisId,p.context)}:companions:${companionIdentity}`,latest=useRef(p);latest.current=p;
 const lifetimeRef=useRef(lifetime);lifetimeRef.current=lifetime;
 const closeBarrier=useRef<Promise<void>>(Promise.resolve());
 const [poolState,setPoolState]=useState<{lifetime:string;pool:Pool}|null>(null),[,refresh]=useState(0),[selection,setSelection]=useState<Record<string,string>>({}),[targets,setTargets]=useState<Record<string,{nto:string;electronHole:string}>>({});
 useAnalysisProjectSnapshot(`excitation-selection:${JSON.stringify([p.context.documentId,p.analysisId,p.context.sourceId,p.context.sourceRevision])}`,()=>({selection,targets}),saved=>{setSelection(saved.selection);setTargets(saved.targets);},p.onError,()=>null);
 const frame=useMemo(()=>projectPostprocessFrame(p.document,p.currentIndex),[p.document,p.currentIndex]);
 const states=excitedStatesForFrame(frame.scientific,p.currentIndex),selectedState=states.find(state=>tddftStateKey(frame.result,state)===selection[key])??states[0];
 const targetState=states.find(state=>tddftStateKey(frame.result,state)===targets[key]?.nto)??selectedState;
 const electronHoleState=states.find(state=>tddftStateKey(frame.result,state)===targets[key]?.electronHole)??selectedState;
 const hasPairConflict=(p.document.pair?.conflicts.length??0)>0;
 const supported=excitationStateAdmission(targetState).supported||excitationStateAdmission(electronHoleState).supported,admittedRef=useRef(supported);admittedRef.current=supported;
 const pool=poolState?.lifetime===lifetime?poolState.pool:null,current=pool?.entries.get(key),controller=current?.controller;
 const latestProjection=useRef<ExcitationViewportProjection|null>(null);
 const [meshReceipts,setMeshReceipts]=useState<MeshReceipts>({nto:null,density:null});
 const [openFailure,setOpenFailure]=useState<{key:string;message:string}|null>(null),[retry,setRetry]=useState(0);
 useEffect(()=>{
  if(openFailure?.key!==lifetime||!isMultiwfnBackendFailure(openFailure.message))return;
  const recheck=()=>setRetry(value=>value+1);
  window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED,recheck);
  return()=>window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED,recheck);
 },[lifetime,openFailure]);
 useEffect(()=>{const pool:Pool={entries:new Map(),disposed:false,ready:closeBarrier.current};setPoolState({lifetime,pool});return()=>{pool.disposed=true;const entries=[...pool.entries.values()];for(const entry of entries)entry.unsubscribe();pool.entries.clear();const closing=pool.ready.then(()=>Promise.all(entries.map(entry=>entry.controller.dispose()))).then(()=>{});closeBarrier.current=closing;void closing.catch(error=>latest.current.onError(String(error instanceof Error?error.message:error)));};},[lifetime,desktop,p.document.wavefunction?.readSourceText,p.document.output?.readSourceText]);
 useEffect(()=>{if(!pool||!desktop)return;let alive=true;const props=latest.current;
  for(const [other,entry] of pool.entries)if(other!==key)void entry.controller.setActive(false).catch(error=>latest.current.onError(String(error)));
  if(!props.wavefunctionAvailable||props.available===false||!props.active||!supported||hasPairConflict)return;
  let entry=pool.entries.get(key);
  if(!entry){const controller=createExcitationDesktopBridge({analysisId:props.analysisId,context:props.context,document:props.document,structure:props.structure,desktop,active:false,onCleanupError:message=>latest.current.onError(message)});entry={controller,progress:null,unsubscribe:()=>{}};const own=entry;entry.unsubscribe=controller.onProgress(progress=>{own.progress=progress;if(!pool.disposed)refresh(value=>value+1);});pool.entries.set(key,entry);}
  const owned=entry;void (async()=>{
   await pool.ready;
   if(!alive||pool.disposed)return;
   await owned.controller.setActive(true);
   if(!alive||pool.disposed)return;
   // Read the source and capabilities before enabling explicit science actions.
   await owned.controller.open();
   if(alive&&!pool.disposed){setOpenFailure(null);refresh(value=>value+1);}
  })().catch(error=>{if(alive&&!pool.disposed)setOpenFailure({key:lifetime,message:error instanceof Error?error.message:String(error)});});
  return()=>{alive=false;void owned.controller.setActive(false).catch(()=>{});};
 },[pool,desktop,key,p.active,p.available,p.wavefunctionAvailable,supported,hasPairConflict,retry]);
 const publish=useCallback((projection:ExcitationProjection|null)=>{const props=latest.current;if(lifetimeRef.current!==lifetime||!admittedRef.current||surfaceScientificContextKey(props.context)!==key)return;const next=excitationInstanceProjection(projection,props);latestProjection.current=next;props.onProjection(next);},[key,lifetime]);
 useEffect(()=>{if(!supported){latestProjection.current=null;latest.current.onProjection(null);}},[supported,key]);
 const accepted=useCallback((requestId:string,_operation:string,renderRequired:boolean)=>{controller?.accepted(requestId,renderRequired);},[controller]);
 const observer=useMemo<ExcitationMeshObserver>(()=>{
  function receive(owner: keyof MeshReceipts, receipt: ExcitationMeshReceipt | null) {
   if (!receipt) return;
   setMeshReceipts(previous=>{
    const old=previous[owner];
    return old?.requestId===receipt.requestId&&old.key===receipt.key&&old.status===receipt.status&&old.error===receipt.error ? previous : {...previous,[owner]:receipt};
   });
   if(receipt.status==='failed')controller?.renderFailed(receipt.requestId,receipt.error??'激发态格点绘制失败。');
   else if(receipt.status==='drawn')controller?.renderCommitted(receipt.requestId);
  }
  const current=()=>{
   const props=latest.current,projection=latestProjection.current;
   return props.active&&props.available!==false&&projection&&sameSurfaceContext(projection.context,props.context)?projection:null;
  };
  return {
   nto(state,document){receive('nto',excitationNtoMeshReceipt(current(),state,document));},
   density(states,document){receive('density',excitationDensityMeshReceipt(current(),states,document));}
  };
 },[controller]);
 useEffect(()=>{p.onMeshObserverReady?.(observer);return()=>p.onMeshObserverReady?.(null);},[observer,p.onMeshObserverReady]);
 useEffect(()=>()=>{latestProjection.current=null;latest.current.onProjection(null);},[]);
 return <TDDFTControls result={frame.result} currentIndex={p.currentIndex} decimals={p.decimals} onDecimalsChange={p.onDecimalsChange} selectedStateKey={selection[key]} onSelectedState={state=>{const selected=tddftStateKey(frame.result,state);setSelection(previous=>({...previous,[key]:selected}));setTargets(previous=>({...previous,[key]:{nto:selected,electronHole:selected}}));}} renderAnalysis={()=>{
  const state=targetState;if(!state)return null;
  const admission=excitationStateAdmission(state);
  if(!admission.supported)return <InputSettingsCard title="激发态派生分析"><p role="status" className="postprocess-note">{admission.reason}</p></InputSettingsCard>;
  const multiplicity=admission.multiplicity;
  const native:ExcitationStateRef={index:state.index,sourceLine:state.sourceLine,frameIndex:p.context.sourceFrameIndex??p.currentIndex,energyEv:state.energyEv,label:state.label,...(multiplicity!==undefined?{multiplicity}:{})};
  const refs=states.flatMap(item=>{const admission=excitationStateAdmission(item);return admission.supported?[{index:item.index,sourceLine:item.sourceLine,frameIndex:p.context.sourceFrameIndex??p.currentIndex,energyEv:item.energyEv,label:item.label,...(admission.multiplicity!==undefined?{multiplicity:admission.multiplicity}:{})}]:[];});
  const densityState=refs.find(item=>item.index===electronHoleState?.index&&item.sourceLine===electronHoleState?.sourceLine&&item.multiplicity===excitationPrintedMultiplicity(electronHoleState?.multiplicity??null))??native;
  return <>{openFailure?.key===lifetime && <MultiwfnErrorNotice message={openFailure.message} identity={openFailure}/>}<ExcitationAnalysisControls key={lifetime} analysisId={p.analysisId} companionIdentity={companionIdentity} structure={p.document.wavefunction?.source.metadata?.structure??p.structure} context={p.context} state={native} electronHoleState={densityState} states={refs} onStateChange={(next,owner='nto')=>{const state=states.find(item=>item.index===next.index&&item.sourceLine===next.sourceLine&&excitationPrintedMultiplicity(item.multiplicity)===next.multiplicity);if(state)setTargets(previous=>({...previous,[key]:{nto:previous[key]?.nto??tddftStateKey(frame.result,targetState),electronHole:previous[key]?.electronHole??tddftStateKey(frame.result,electronHoleState),[owner==='nto'?'nto':'electronHole']:tddftStateKey(frame.result,state)}}));}} active={p.active} available={p.available} wavefunctionAvailable={p.wavefunctionAvailable} unavailableReason={hasPairConflict?'OUT与波函数的电子态数据存在差异，需一致的配套来源。':undefined} info={controller?.info??null} bridge={controller?.bridge??{}} progress={current?.progress??null} meshReceipts={meshReceipts} decimals={p.decimals} onProjection={publish} onAccepted={accepted} onExportImage={p.onExportImage} onError={p.onError}/></>;
 }}/>;
}
