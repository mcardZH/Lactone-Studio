import {DismissibleNotice} from '../DismissibleNotice';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type SetStateAction} from 'react';
import {formatResultValue} from '../../results/numeric-format';
import {createPortal} from 'react-dom';
import type {DisplaySettings,InteractionState,ModelDocument} from '../../modeling/contracts';
import type {Structure,Vector3} from '../../core/types';
import {applyFrameBondOverride,type FrameBondIdentity} from '../../core/modeling/frame-bond-overrides';
import {resultFrameBondSource,resultFrameBondIdentity,type ResultFrameBondSource} from '../../results/frame-bond-identity';
import type {ViewportOrbitalLayer} from '../../results/orbital-contracts';
import type {PostprocessDocument} from '../../results/postprocess-document';
import {postprocessDipole,projectPostprocessFrame,projectPostprocessStage,observePostprocessSource} from '../../results/postprocess-document';
import {attachTrajectoryStages,projectTrajectoryStage} from '../../results/trajectory-stages';
import type {TrajectoryResult} from '../../results/contracts';
import type {OptPlaybackViewState} from '../../results/opt-playback';
import {inheritPreparedTrajectoryPrefix,type PreparedTrajectoryView} from '../../results/prepared-trajectory';
import type {SurfaceContext} from '../../results/surface-contracts';
import {sameSurfaceContext} from '../../results/surface-field';
import {captureVibrationGif} from './vibration-gif-capture';
import {pauseVibrationProjection,type VibrationGifRequest} from './VibrationControls';
import {trajectoryViewDocument} from '../../results/playback';
import {ResultViewBonds} from '../../results/view-bonds';
import {emptyMeasurement,pickMeasurement,pickBondMeasurement} from '../modeling/measurement-state';
import type {MeasurementRecord} from '../../core/modeling/contracts';
import {mergeCoordinateAnnotations} from '../modeling/coordinate-annotations';
import ModelViewport,{type ModelViewportProps} from '../modeling/ModelViewport';
import {useCurrentCipUsage} from '../modeling/use-cip-usage';
import ModelWorkspaceToolbar from '../modeling/ModelWorkspaceToolbar';
import CanvasClearToolbar from '../modeling/CanvasClearToolbar';
import {useObservationInteraction} from '../modeling/use-observation-interaction';
import {PlaybackOverlayControls} from '../MultiframeDisplayControls';
import {createPlaybackCollection,initialPlaybackFrame,type PlaybackCollection} from '../../results/playback-collection';
import {playbackScopeIdentity} from '../../results/playback-owner';
import type {CenterResourcePort} from '../../results/trajectory-center';
import {playbackOverlayPresentation,trajectoryPlaybackState,type TrajectoryPlaybackBridge,type TrajectoryPlaybackCommand} from './trajectory-playback-bridge';
import ElementColorControls from '../modeling/ElementColorControls';
import type {PostprocessPlotSnapshot} from './PostprocessPresentation';
import {exportViewportImage,exportBlob,openBinaryExportSink,type OffscreenCaptureSnapshot,type ViewportImageExportOptions} from './export-image';
import ViewportImageExportMenu from '../modeling/ViewportImageExportMenu';
import {captureViewportLegend} from './viewport-legend-export';
import {mapComparedAnalysisResult,mapAnalysisHighlight,visibleBondDisplayValues} from './analysis-viewport';
import {analysisRange,type AnalysisColorbar,type AnalysisDisplaySettings} from './analysis-display';
import type {AnalysisColorbarLayout} from './analysis-colorbar-layout';
import AnalysisWorkspace from './AnalysisWorkspace';
import {AnalysisPanelInstance,type AnalysisProjection} from './AnalysisPanelInstance';
import type {AnalysisCanvas} from './analysis-canvas';
import type {StructureExportSource} from './structure-export-source';
import {captureDisplayedStructureDocument} from '../modeling/scientific-frame-source';
import {useOptPlayback,canContinuePlayback,playbackFramesExtend,type PlaybackContinuationIdentity} from './useOptPlayback';
import TrajectoryControls from './TrajectoryControls';
import TrajectoryAnalysisControls,{type TrajectoryAnalysisControlsProps} from './TrajectoryAnalysisControls';
import {sourceChargeViewport} from './source-charge-viewport';
import {empiricalFramePreparationState,prepareTrajectoryView,usePreparedTrajectory,type TrajectoryGeometryPreparation} from './usePreparedTrajectory';
import {usePostprocessMultiframe} from './usePostprocessMultiframe';
import {observePreparedTrajectory,emitTrajectoryRenderCompletion,useTrajectoryObservationEnabled} from './trajectory-observation';
import SurfaceAnalysisInstance,{surfaceSourceAtomOrder} from './SurfaceAnalysisInstance';
import {useAnalysisAtomCapture} from './useAnalysisAtomCapture';
import type {SurfaceInteractionPort,SurfaceProjection} from './surface-controls-contracts';
import InteractionAnalysisInstance,{createInteractionMeshObservers,withoutInteractionProjection,type InteractionViewportProjection} from './InteractionAnalysisInstance';
import ExcitationAnalysisInstance,{createExcitationMeshObservers,type ExcitationViewportProjection} from './ExcitationAnalysisInstance';
import ReactivityAnalysisInstance,{type ReactivityViewportProjection} from './ReactivityAnalysisInstance';
import type {ReactivityInteractionPort} from './reactivity-controls-contracts';
import {reactivityAtomDisplay,REACTIVITY_ATOM_LABELS,reactivityMetricUnit} from './reactivity-presentation';
import {professionalChargeColumns,professionalChargeDisplay} from './analysis-comparison';
import {compositionRows} from './AnalysisControls';
import {DEFAULT_ORBITAL_LAYER} from './orbital-display';
import type {McpAnalysisFrameRequest,McpAnalysisPanelRequest,McpAnalysisViewportOverlay} from '../mcp/analysis-export';
import type {InteractionInteractionPort,InteractionScatterSnapshot} from './interaction-controls-contracts';
import type {SurfaceMeshState} from '../modeling/render/surface-layer';
import PostprocessPlotDeck,{type InteractionPlotWindowSnapshot,type HirshfeldPlotWindowSnapshot} from './PostprocessPlotDeck';
import type {HirshfeldProjection,HirshfeldFingerprintSnapshot} from './hirshfeld-controls-contracts';
import {surfaceScientificContextKey} from './surface-context-pool';
import {isGeneratedXtbAnalysisPolicy} from '../../results/generated-xtb-policy';
import {INTERACTION_COMPONENT_LABELS,INTERACTION_METHOD_LABELS} from './interaction-presentation';
import './trajectory.css';
import './Postprocess.css';
import type {AnalysisPage} from './PostprocessDisplayPanel';
import {generatedXtbAnalysisReason} from './PostprocessDisplayPanel';
import {ProjectUiScope,useProjectState,useProjectUiSnapshot,useProjectUiScope} from '../../projects/ui-state';
import {useAnalysisProjectSnapshot,notifyAnalysisProjectStateChanged} from '../../projects/analysis-state';
const interaction:InteractionState={element:null,box:false,alt:false,gesture:'none'},noEdit=()=>{};
export const DEFAULT_MCP_BOND_DISPLAY:Readonly<AnalysisDisplaySettings>=Object.freeze({color:true,labels:true,spin:false,decimals:2});
export type PostprocessPlotWindows=readonly(InteractionPlotWindowSnapshot|HirshfeldPlotWindowSnapshot)[];
export const postprocessPlotWindowsKey=(documentId:string,sourceIdentity:string,resultId:string)=>`postprocess-plot-windows:${JSON.stringify([documentId,sourceIdentity,resultId])}`;
/** Fixed scientific plot data and provenance only; no renderer projections,
 * meshes, sessions, capture callbacks or hover objects enter this boundary. */
export function capturePostprocessPlotWindows(plots:PostprocessPlotWindows):PostprocessPlotWindows{
 return plots.map(plot=>{
  const common={id:plot.id,kind:plot.kind,title:plot.title,source:plot.source,resultId:plot.resultId,jobIndex:plot.jobIndex,frameIndex:plot.frameIndex};
  if(plot.kind==='interaction-scatter'){
   if(plot.data.x.length!==plot.data.y.length||plot.data.valid&&plot.data.valid.length!==plot.data.x.length)throw new Error('独立散点图的数据或有效域长度不匹配。');
   return{...common,kind:plot.kind,context:plot.context,method:plot.method,component:plot.component,data:{x:plot.data.x,y:plot.data.y,...(plot.data.valid?{valid:plot.data.valid}:{})},xLabel:plot.xLabel,yLabel:plot.yLabel,display:plot.display,decimals:plot.decimals};
  }
  if(plot.kind==='hirshfeld-fingerprint')return{...common,kind:plot.kind,result:{stamp:plot.result.stamp,source:plot.result.source,vertices:plot.result.vertices,contacts:plot.result.contacts},focus:plot.focus,decimals:plot.decimals,merged:plot.merged,plotDisplay:plot.plotDisplay};
  throw new Error('独立科研图窗类型无效。');
 });
}
export interface ResultStageChoice {id:string;label:string;result:TrajectoryResult;stageId:string;sourceResultId?:string}
interface StageBrowseSnapshot {frameIndex:number;cameraView?:number[];playback?:OptPlaybackViewState}
export interface RetainedStageBrowse {selected?:string;browse:[string,StageBrowseSnapshot][]}
interface StageBrowsePort {stageKey:string;snapshot():StageBrowseSnapshot;pause():void}
interface StageProjection {ownerId:string;key:string;source:PostprocessDocument;original:TrajectoryResult;document:PostprocessDocument;continuity:PostprocessResultViewProps['playbackContinuity']}
interface StagePresentationOwner {
 id:string;document:PostprocessDocument;identity:string;continuity:PostprocessResultViewProps['playbackContinuity'];
 browse:Map<string,StageBrowseSnapshot>;cameraViews:Map<string,number[]>;
 projection:Map<string,{original:TrajectoryResult;result:TrajectoryResult}>;returnStageId?:string;
}
function sameResultSeries(previous:TrajectoryResult,next:TrajectoryResult){return previous.id===next.id&&previous.source.id===next.source.id&&previous.jobIndex===next.jobIndex;}
function stageContinuity(identity:PostprocessResultViewProps['playbackContinuity'],stageId:string):PlaybackContinuationIdentity|undefined{return identity?{...identity,stageId}:undefined;}
interface StageViewProps {contextControls?:ReactNode;stageKey:string;frameBondSource?:ResultFrameBondSource;restore?:StageBrowseSnapshot;cameraView?:number[];canReturnToTrajectory:boolean;onBrowsePort(port:StageBrowsePort|null):void|(()=>void);onAnalysisRequest(kind:AnalysisPage):void}
const exclusivePreparations=new WeakMap<PreparedTrajectoryView['owner'],Set<object>>();
function retainExclusivePreparation(view:PreparedTrajectoryView){
 let consumers=exclusivePreparations.get(view.owner);if(!consumers){consumers=new Set();exclusivePreparations.set(view.owner,consumers);}
 const token={};consumers.add(token);
 return()=>{consumers!.delete(token);queueMicrotask(()=>{if(!consumers!.size&&exclusivePreparations.get(view.owner)===consumers){exclusivePreparations.delete(view.owner);void view.owner.source.dispose();}});};
}
/** Document/view ids may be aliases. Keep the reader's result identity separate. */
export function resultStageChoices(document:PostprocessDocument):ResultStageChoice[]{
 const entries:ResultStageChoice[]=[],seen=new Set<string>(),attachments=[document.output,...(document.companions??[]),document.wavefunction];
 const add=(result:TrajectoryResult,primary:boolean)=>{
  const key=`${result.source.id}:${result.jobIndex}:${result.id}`;if(seen.has(key))return;seen.add(key);
  const originals=attachments.flatMap(attachment=>attachment?.source.results??[]).filter(row=>row.source.id===result.source.id&&row.jobIndex===result.jobIndex);
  const ids=new Set(originals.map(row=>row.id)),sourceResultId=ids.has(result.id)?result.id:ids.size===1?[...ids][0]:undefined;
  const staged=attachTrajectoryStages(result);
  for(const stage of staged.stages??[]){const tasks=result.scientific?.tasks??[],label=stage.kind==='trajectory'?(tasks.includes('freq')?'频率':tasks.includes('td')?'激发态':stage.label):stage.kind==='optimization'?'优化':stage.label;entries.push({id:`${key}:${stage.id}`,label:`${primary?'当前来源':`job ${(result.jobIndex??0)+1}`} · ${label}`,result,stageId:stage.id,sourceResultId});}
 };
 add(document.result,true);
 for(const attachment of attachments)for(const result of attachment?.source.results??[]){if(result.source.id===document.result.source.id&&result.jobIndex===document.result.jobIndex)continue;add(result,false);}
 return entries;
}
/** Only the source reader's validated native continuation may drive a scientific-stage jump. */
export function requestedResultStage(document:PostprocessDocument,choices:readonly ResultStageChoice[],current:ResultStageChoice,kind:AnalysisPage,returnStageId?:string):ResultStageChoice|undefined {
 const attachments=[document.output,...(document.companions??[]),document.wavefunction];
 for(const attachment of attachments){
  if(attachment?.source.result.source.id!==current.result.source.id)continue;
  for(const proof of attachment.source.nativeContinuations??[]){
   const optimization=choices.find(choice=>(choice.sourceResultId??choice.result.id)===proof.optimizationResultId&&choice.result.source.id===current.result.source.id);
   const frequency=choices.find(choice=>(choice.sourceResultId??choice.result.id)===proof.frequencyResultId&&choice.result.source.id===current.result.source.id);
   if(!optimization||!frequency||optimization.result.jobIndex===frequency.result.jobIndex)continue;
   if(kind==='vibrations'&&(current.sourceResultId??current.result.id)===proof.optimizationResultId&&frequency.result.scientific?.vibrations?.modes.length)return frequency;
   if(kind==='trajectory'&&(current.sourceResultId??current.result.id)===proof.frequencyResultId&&returnStageId){const back=choices.find(choice=>choice.id===returnStageId);if(back&&(back.sourceResultId??back.result.id)===proof.optimizationResultId)return back;}
  }
 }
 return undefined;
}
export interface PostprocessResultViewProps {
 /** File/job views cannot publish a player before their selected stage exists. */
 stageAdmission?:'defer-unattributed';
 playbackCollection?:PlaybackCollection;collectionFixed?:boolean;centerResources?:CenterResourcePort;
 /** Read-only migration fallback from a host's former shared presentation scope. */
 legacyStageBrowse?:RetainedStageBrowse;
 playbackContinuity?:Omit<PlaybackContinuationIdentity,'stageId'>;
 allowedPages?:readonly AnalysisPage[];
 observationOnly?:boolean;
 initialPage?:AnalysisPage;
 requestedPage?:McpAnalysisPanelRequest;
 requestedFrame?:McpAnalysisFrameRequest;
 mcpOverlay?:McpAnalysisViewportOverlay|null;
 /** Explicit owner navigation, cancelled by its caller when activation changes. */
 requestedAnalysisPage?:{id:string;kind:AnalysisPage};
 trajectoryExtension?:TrajectoryAnalysisControlsProps['extension'];
 /** The caller exclusively owns this observation source, including display
  * preparation. Other source consumers keep their ordinary shared lifetime. */
 releasePreparedSource?:boolean;
 onTrajectoryBrowseIntent?():void;
 onStructureExportSource?(source:StructureExportSource|null):void;
 onExportStructure?():void;
 structureExportBusy?:boolean;
 onImageExportReady?(exportImage:(()=>void)|null):void;
 /** Source-series frame, mapped into the common stage projection. */
 initialSourceFrameIndex?:number;
 startEmpty?:boolean;
 /** Window-session observation hosts can resume playback; saved projects reopen paused. */
 resumeObservedPlayback?:boolean;
 /** Stable observation owner for incremental publications of the same source. */
 presentationOwnerId?:string;
 loadingHost?:HTMLElement|null;
 onObservedFrame?(structure:Structure|null):void;
 onActiveResult?(result:TrajectoryResult|null):void;
 document:PostprocessDocument;active:boolean;selected:boolean;toolHost:HTMLElement|null;toolbarHost?:HTMLElement|null;
 modelDocument?:ModelDocument;available?:boolean;onCanvas?(value:AnalysisCanvas|null):void;
 onCipLabelsUsed?:ModelViewportProps['onCipLabelsUsed'];
 geometryPreparation?:TrajectoryGeometryPreparation;
 display:DisplaySettings;onDisplay(display:DisplaySettings):void;onOpenPlot(snapshot:PostprocessPlotSnapshot):void;onExtract(structure:Structure):void;onError(message:string):void;
 layoutActions?:ReactNode;onCompare?():void;onNewDocument?():void;onImportFiles?(files:File[]):Promise<void>;
 sharedShowAxes?:boolean;onSharedShowAxesChange?(value:boolean):void;legendVisible?:boolean;legendExpanded?:boolean;onLegendExpandedChange?(value:boolean):void;onLegendSurfaceChange?(surface:ReactNode):void;onToolbarSurfaceChange?(surface:ReactNode):void;onActivate?():void;
}
/** One molecule viewport; analysis instances only own controls and display state. */
export default function PostprocessResultView(p:PostprocessResultViewProps){
 const choices=useMemo(()=>resultStageChoices(p.document),[p.document]);
 const browsePort=useRef<StageBrowsePort|null>(null);
 const stored=useProjectUiSnapshot<RetainedStageBrowse>('postprocess.stage-browse',():RetainedStageBrowse=>({selected:selected?.id,browse:[...stageOwner.browse,...(browsePort.current?.stageKey?[[browsePort.current.stageKey,browsePort.current.snapshot()] as [string,StageBrowseSnapshot]]:[])]}));
 const retained=stored===undefined?p.legacyStageBrowse:stored;
 // A loading placeholder never identified a reader stage. Preserve attributed
 // snapshots, including stages not currently displayed, without adopting ''.
 const presentation=useRef<StagePresentationOwner|null>(null);
 const stageOwner=useMemo(()=>{
  const before=presentation.current,identity=JSON.stringify([p.presentationOwnerId,p.document.id,p.playbackContinuity?.ownerId,p.playbackContinuity?.collectionId,p.playbackContinuity?.sourceGeneration]);
  const output=p.document.output?.source,nativeSwitch=!!p.presentationOwnerId&&!!output&&before?.document.output?.source===output&&output.results.includes(before.document.result)&&output.results.includes(p.document.result);
  const same=before?.identity===identity&&(before.document.result===p.document.result||nativeSwitch||!!p.presentationOwnerId&&sameResultSeries(before.document.result,p.document.result)&&playbackFramesExtend(before.document.result,p.document.result)&&canContinuePlayback(stageContinuity(before.continuity,'source'),stageContinuity(p.playbackContinuity,'source')));
  const owner:StagePresentationOwner=same?before!:{id:crypto.randomUUID(),document:p.document,identity,continuity:p.playbackContinuity,browse:new Map((retained?.browse??[]).filter(([key])=>key!=='')),cameraViews:new Map(),projection:new Map()};
  owner.document=p.document;owner.continuity=p.playbackContinuity;presentation.current=owner;return owner;
 },[p.presentationOwnerId,p.document,p.playbackContinuity]);
 const [selection,setSelection]=useState<{ownerId:string;id:string}|null>(null);
 const selected=choices.find(choice=>selection?.ownerId===stageOwner.id&&choice.id===selection.id)??choices.find(choice=>choice.id===retained?.selected)??choices[0];
 const projectionEpoch=useRef(0);
 const [projection,setProjection]=useState<StageProjection|null>(null);
 const displayed=useRef<StageProjection|null>(null);
 const selectStage=useCallback((id:string)=>{if(!selected||selected.id===id||!choices.some(choice=>choice.id===id))return;const port=browsePort.current;if(port?.stageKey===selected.id){const snapshot=port.snapshot();stageOwner.browse.set(selected.id,snapshot);if(!stageOwner.browse.has(id)&&snapshot.cameraView)stageOwner.cameraViews.set(id,snapshot.cameraView);port.pause();}setSelection({ownerId:stageOwner.id,id});},[selected,choices,stageOwner]);
 const requestAnalysis=useCallback((kind:AnalysisPage)=>{if(!selected)return;const next=requestedResultStage(p.document,choices,selected,kind,stageOwner.returnStageId);if(next){if(kind==='vibrations')stageOwner.returnStageId=selected.id;selectStage(next.id);}},[p.document,choices,selected,stageOwner,selectStage]);
 const receiveBrowsePort=useCallback((port:StageBrowsePort|null)=>{
  if(!port?.stageKey)return;
  if(browsePort.current)stageOwner.browse.set(browsePort.current.stageKey,browsePort.current.snapshot());
  browsePort.current=port;
  return()=>{if(browsePort.current!==port)return;stageOwner.browse.set(port.stageKey,port.snapshot());browsePort.current=null;};
 },[stageOwner]);
 useEffect(()=>{
  if(!selected)return;
  const controller=new AbortController(),epoch=++projectionEpoch.current,cached=stageOwner.projection.get(selected.id);
  let preparing:PreparedTrajectoryView|undefined;
  const current=()=>!controller.signal.aborted&&projectionEpoch.current===epoch;
  const commit=(result:TrajectoryResult,continuity:PostprocessResultViewProps['playbackContinuity'])=>{
   if(!current())return;
   const document=projectPostprocessStage(observePostprocessSource(p.document,selected.result),result);
   stageOwner.projection.set(selected.id,{original:selected.result,result:document.result});
   setProjection({ownerId:stageOwner.id,key:selected.id,source:p.document,original:selected.result,document,continuity});
  };
  const publish=async(result:TrajectoryResult)=>{
   if(!current())return;
   const before=displayed.current,sameStage=before?.ownerId===stageOwner.id&&before.key===selected.id;
   // Every intervening source revision was admitted above. Fold only that
   // verified chain to the last displayed revision when an intermediate
   // publication was superseded before it could finish preparing.
   const continuity=sameStage&&p.playbackContinuity&&before.continuity&&before.original!==selected.result?{...p.playbackContinuity,baseRevision:before.continuity.revision}:p.playbackContinuity;
   if(sameStage&&before.original!==selected.result&&sameResultSeries(before.original,selected.result)&&canContinuePlayback(stageContinuity(before.continuity,selected.id),stageContinuity(continuity,selected.id))){
    const previous=prepareTrajectoryView(before.document.result,p.geometryPreparation);
    try{preparing=prepareTrajectoryView(result,p.geometryPreparation);if(playbackFramesExtend(before.document.result,result))inheritPreparedTrajectoryPrefix(previous,preparing);await preparing.prepare(controller.signal);}finally{previous.release();}
    if(!current())return;
   }
   commit(result,continuity);
  };
  if(cached?.original===selected.result){const before=displayed.current;commit(cached.result,before?.ownerId===stageOwner.id&&before.key===selected.id&&before.original===selected.result?before.continuity:p.playbackContinuity);}
  else void projectTrajectoryStage(selected.result,selected.stageId,controller.signal).then(publish).catch(error=>{if(current())p.onError(error instanceof Error?error.message:String(error));}).finally(()=>preparing?.release());
  return()=>controller.abort();
 },[p.document,selected?.id,stageOwner,p.geometryPreparation,p.playbackContinuity?.revision]);
 const ready=!!selected&&projection?.ownerId===stageOwner.id&&projection.key===selected.id&&projection.source===p.document;
 const held=!!selected&&projection?.ownerId===stageOwner.id&&projection.key===selected.id&&(projection.original===selected.result||sameResultSeries(projection.original,selected.result)&&playbackFramesExtend(projection.original,selected.result)&&canContinuePlayback(stageContinuity(projection.continuity,selected.id),stageContinuity(p.playbackContinuity&&projection.continuity?{...p.playbackContinuity,baseRevision:projection.continuity.revision}:undefined,selected.id)));
 const available=ready||held;
 const shown=projection?.ownerId===stageOwner.id?projection:null;
 // Browse snapshots are captured on every port replacement. Restore one only
 // when entering a stage, never as a new initial cursor during a live revision.
 const restore=useMemo(()=>shown?stageOwner.browse.get(shown.key):undefined,[stageOwner,shown?.key]);
 const cameraView=useMemo(()=>restore?.cameraView??(shown?stageOwner.cameraViews.get(shown.key):undefined),[stageOwner,shown?.key,restore]);
 useLayoutEffect(()=>{displayed.current=projection?.ownerId===stageOwner.id?projection:null;},[projection,stageOwner]);
 useLayoutEffect(()=>{p.onActiveResult?.(p.active&&available?projection!.document.result:null);},[p.active,available,projection,p.onActiveResult]);
 const activeResultCallback=useRef(p.onActiveResult);activeResultCallback.current=p.onActiveResult;
 useLayoutEffect(()=>()=>{activeResultCallback.current?.(null);},[]);
 useLayoutEffect(()=>{if(!selected)p.onCanvas?.(null);},[selected?.id,p.onCanvas]);
 const contextControls=useMemo(()=>choices.length>1?<label className="trajectory-stage-choice">阶段<select aria-label="结果来源与阶段" value={selected?.id??''} onChange={event=>selectStage(event.target.value)}>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>:null,[choices,selected?.id,selectStage]);
 if(!selected){const message=<p className="postprocess-note" role="status">{p.document.result.frames.length?'已有结构缺少可靠的路径阶段对应，请补入主 OUT；来源数据已保留。':'来源尚未输出完整结构帧，已有元数据保留。'}</p>;return <section className="postprocess-result-view" data-testid="postprocess-result-view" data-result-id={p.document.result.id}>{p.toolHost?createPortal(message,p.toolHost):message}</section>;}
 // A loading projection has no attributed stage. Do not mount a frame/player
 // against its placeholder: that owner could publish frame0 over saved browse.
 // An existing projection of this same stage stays mounted with its own
 // publication token until replacement, so prepared prefixes can transfer.
 if(p.stageAdmission==='defer-unattributed'&&!ready&&shown?.key!==selected.id)return <section className="postprocess-result-view" aria-label="准备结果来源与阶段">{contextControls}<p role="status">正在准备结果来源与阶段…</p>{p.trajectoryExtension?.controls}{p.trajectoryExtension?.energyPlot}{p.trajectoryExtension?.details}</section>;
 const shownChoice=choices.find(choice=>choice.id===shown?.key)??selected;
 const frameBondSource=resultFrameBondSource(shown?.original??shownChoice.result,shownChoice.stageId,shown?shown.continuity:p.playbackContinuity,shownChoice.sourceResultId??(shown?.original??shownChoice.result).id);
 return <PreparedPostprocessFrameView frameBondSource={frameBondSource} key={p.stageAdmission==='defer-unattributed'?`${stageOwner.id}:${shown?.key??''}`:stageOwner.id} {...p} document={shown?.document??p.document} playbackContinuity={shown?shown.continuity:p.playbackContinuity} available={p.available!==false&&available} contextControls={contextControls} stageKey={shown?.key??''} restore={restore} cameraView={cameraView} canReturnToTrajectory={!!requestedResultStage(p.document,choices,selected,'trajectory',stageOwner.returnStageId)} onBrowsePort={receiveBrowsePort} onAnalysisRequest={requestAnalysis}/>;
}
function PreparedPostprocessFrameView(p:PostprocessResultViewProps&StageViewProps){
 const [retry,setRetry]=useState(0),admission=usePreparedTrajectory(p.document.result,retry,p.geometryPreparation);
 const previous=useRef<{result:TrajectoryResult;prepared:PreparedTrajectoryView;continuity:PlaybackContinuationIdentity|undefined}|null>(null);
 const continuity=p.playbackContinuity?{...p.playbackContinuity,stageId:p.stageKey}:undefined;
 useMemo(()=>{const before=previous.current;if(admission.prepared&&before&&before.result!==p.document.result&&playbackFramesExtend(before.result,p.document.result)&&canContinuePlayback(before.continuity,continuity))inheritPreparedTrajectoryPrefix(before.prepared,admission.prepared);},[admission.prepared,p.document.result,p.stageKey,p.playbackContinuity?.revision]);
 useLayoutEffect(()=>{previous.current=admission.prepared?{result:p.document.result,prepared:admission.prepared,continuity}:null;},[admission.prepared,p.document.result,p.stageKey,p.playbackContinuity?.revision]);
 useEffect(()=>p.releasePreparedSource&&admission.prepared?retainExclusivePreparation(admission.prepared):undefined,[admission.prepared,p.releasePreparedSource]);
 useLayoutEffect(()=>{if(admission.error){p.onCanvas?.(null);if(p.allowedPages)p.onError(admission.error.message);}},[admission.error,p.onCanvas,p.allowedPages,p.onError]);
 if(admission.error){const retryButton=<button onClick={()=>setRetry(value=>value+1)}>重新准备</button>,failure=p.allowedPages?retryButton:<DismissibleNotice className="postprocess-warning" identity={admission.error}><p>{admission.error.message}</p>{retryButton}</DismissibleNotice>;return <section className="postprocess-result-view">{p.toolHost?createPortal(failure,p.toolHost):failure}</section>;}
 return <PostprocessFrameView {...p} prepared={admission.prepared}/>;
}
function PostprocessFrameView(p:PostprocessResultViewProps&StageViewProps&{prepared:PreparedTrajectoryView}){
 const result=p.document.result,metadata=p.document.wavefunction?.source.metadata??null;
 const generatedXtb=p.document.wavefunction?.source.generatedXtb,generatedPolicy=metadata?.analysisPolicy;
 const electronicSurfaceMethods=generatedXtb?metadata&&isGeneratedXtbAnalysisPolicy(generatedPolicy,metadata.sourceRevision)?generatedPolicy.realSpaceMethods.filter((method):method is 'esp'|'alie'=>method==='esp'||method==='alie'):[]:undefined;
 const electronicSurfaceAllowed=electronicSurfaceMethods===undefined||electronicSurfaceMethods.length>0;
 const nativeGroup=[p.document.output,...(p.document.companions??[])].flatMap(attachment=>{
  if(attachment?.source.result.source.id!==result.source.id)return[];
  const original=attachment.source.results.find(row=>row.jobIndex===result.jobIndex);
  return (attachment.source.nativeContinuations??[]).filter(proof=>original&&(proof.optimizationResultId===original.id||proof.frequencyResultId===original.id)).map(proof=>proof.optimizationResultId);
 })[0];
 const sourceIdentity=JSON.stringify([p.document.id,result.source.id,metadata?.sourceRevision,nativeGroup??result.jobIndex]);
 const [activeSelection,setActiveSelection]=useProjectState<{source:string;id:string|null}>('postprocess.activeSelection',{source:sourceIdentity,id:null},sourceIdentity),[projections,setProjections]=useState<Record<string,AnalysisProjection>>({});
 const activeId=activeSelection.source===sourceIdentity?activeSelection.id:null;
 const [surfaces,setSurfaces]=useState<Record<string,SurfaceProjection|null>>({});
 const [hirshfelds,setHirshfelds]=useState<Record<string,HirshfeldProjection|null>>({});
 const [surfaceFamilies,setSurfaceFamilies]=useState<Record<string,'electronic'|'hirshfeld'>>({});
 const surfaceInteractions=useRef(new Map<string,SurfaceInteractionPort>());
 const hirshfeldLayouts=useRef(new Map<string,(layout:AnalysisColorbarLayout)=>void>());
 const hirshfeldMeshes=useRef(new Map<string,(state:Readonly<SurfaceMeshState>,actual:Pick<ModelDocument,'id'|'revision'>)=>void>());
 const [interactions,setInteractions]=useState<Record<string,InteractionViewportProjection|null>>({});
 const interactionPorts=useRef(new Map<string,InteractionInteractionPort>());
 const interactionMeshes=useRef(createInteractionMeshObservers());
 const [excitations,setExcitations]=useState<Record<string,ExcitationViewportProjection|null>>({});
 const excitationMeshes=useRef(createExcitationMeshObservers());
 const [reactivities,setReactivities]=useState<Record<string,ReactivityViewportProjection|null>>({});
 const reactivityPorts=useRef(new Map<string,ReactivityInteractionPort>());
 const colorbarLayoutPorts=useRef(new Map<string,(layout:AnalysisColorbarLayout)=>void>());
 const receiveExcitation=useCallback((id:string,value:ExcitationViewportProjection|null)=>setExcitations(previous=>previous[id]===value?previous:{...previous,[id]:value}),[]);
 const receiveReactivity=useCallback((id:string,value:ReactivityViewportProjection|null)=>setReactivities(previous=>previous[id]===value?previous:{...previous,[id]:value}),[]);
 const plotWindowsKey=postprocessPlotWindowsKey(p.modelDocument?.id??p.document.id,sourceIdentity,result.id);
 const [plotOwners,setPlotOwners]=useState<Record<string,PostprocessPlotWindows>>({}),scatterPlots=plotOwners[plotWindowsKey]??[];
 const setScatterPlots=useCallback((action:SetStateAction<PostprocessPlotWindows>)=>setPlotOwners(previous=>{const before=previous[plotWindowsKey]??[],next=typeof action==='function'?action(before):action;return Object.is(before,next)?previous:{...previous,[plotWindowsKey]:next};}),[plotWindowsKey]);
 useAnalysisProjectSnapshot(plotWindowsKey,()=>capturePostprocessPlotWindows(scatterPlots),saved=>setScatterPlots(capturePostprocessPlotWindows(saved)),p.onError,()=>null);
 const receiveHirshfeld=useCallback((id:string,value:HirshfeldProjection|null)=>setHirshfelds(previous=>previous[id]===value?previous:{...previous,[id]:value}),[]);
 const receiveInteraction=useCallback((id:string,value:InteractionViewportProjection|null)=>setInteractions(previous=>previous[id]===value?previous:{...previous,[id]:value}),[]);
 const receiveSurface=useCallback((id:string,value:SurfaceProjection|null)=>setSurfaces(previous=>previous[id]===value?previous:{...previous,[id]:value}),[]);
 const receiveProjection=useCallback((value:AnalysisProjection)=>setProjections(previous=>previous[value.id]===value?previous:{...previous,[value.id]:value}),[]);
 const disposeProjection=useCallback((id:string)=>{
  interactionPorts.current.delete(id);interactionMeshes.current.release(id);
  excitationMeshes.current.release(id);reactivityPorts.current.delete(id);colorbarLayoutPorts.current.delete(id);
  setExcitations(previous=>withoutInteractionProjection(previous,id));setReactivities(previous=>withoutInteractionProjection(previous,id));
  setInteractions(previous=>withoutInteractionProjection(previous,id));
  setHirshfelds(previous=>withoutInteractionProjection(previous,id));setSurfaces(previous=>withoutInteractionProjection(previous,id));
  setSurfaceFamilies(previous=>withoutInteractionProjection(previous,id));surfaceInteractions.current.delete(id);hirshfeldLayouts.current.delete(id);hirshfeldMeshes.current.delete(id);
  setProjections(previous=>{if(!previous[id])return previous;const next={...previous};delete next[id];return next;});
 },[]);
 const current=activeId?projections[activeId]:undefined,page=current?.kind;
 const measurementOwner=JSON.stringify([sourceIdentity,result.id]);
 const [measurement,setMeasurement]=useProjectState('postprocess.measurement',()=>emptyMeasurement('auto'),measurementOwner),[resetView,setResetView]=useState(0),[localShowAxes,setLocalShowAxes]=useProjectState('postprocess.localShowAxes',false,measurementOwner);
 const [cameraRequest,setCameraRequest]=useState<ModelViewportProps['cameraRequest']>();
 const showAxes=p.sharedShowAxes??localShowAxes,toggleAxes=()=>p.sharedShowAxes!==undefined?p.onSharedShowAxesChange?.(!p.sharedShowAxes):setLocalShowAxes(value=>!value);
 const viewport=useRef<HTMLDivElement>(null),getView=useRef<(()=>number[])|null>(null),lastView=useRef<number[]|undefined>(undefined),fileInput=useRef<HTMLInputElement>(null);
 const [viewReady,setViewReady]=useState(false),[exporting,setExporting]=useState(false);
 const prepared=p.prepared;
 const bondingWarnings=useRef(new Set<string>());
 const [bondRetry,setBondRetry]=useState<{key:string;error:string}|null>(null);
 const uiScope=useProjectUiScope();
 const localPlaybackScope=useRef({});
 const collection=useMemo(()=>p.playbackCollection??createPlaybackCollection(result,{ownerId:playbackScopeIdentity(uiScope?.store??localPlaybackScope.current,p.document.id),stageId:p.stageKey,fixed:p.collectionFixed??!p.observationOnly,generation:p.playbackContinuity?.sourceGeneration,revision:p.playbackContinuity?.revision}),[p.playbackCollection,result,uiScope?.store,p.document.id,p.stageKey,p.collectionFixed,p.observationOnly,p.playbackContinuity?.sourceGeneration,p.playbackContinuity?.revision]);
 const initialFrameIndex=useMemo(()=>{
  const mapped=p.initialSourceFrameIndex===undefined?-1:result.frames.findIndex((frame,index)=>(frame.sourceFrameIndex??index)===p.initialSourceFrameIndex);
  return mapped>=0?mapped:initialPlaybackFrame(result,collection);
 },[p.initialSourceFrameIndex,result,collection]);
 const savedIndex=p.restore?.frameIndex;
 const playback=useOptPlayback(result,{collection,active:p.active&&p.available!==false,ready:viewReady,autoPreview:false,initialFrameIndex:savedIndex===undefined?initialFrameIndex:Math.max(0,Math.min(savedIndex,result.frames.length-1)),prepared,onError:p.onError,restored:p.restore?.playback,liveContinuation:p.resumeObservedPlayback?p.restore?.playback:undefined,continuation:p.playbackContinuity?{...p.playbackContinuity,stageId:p.stageKey}:undefined});
 const browseIntent=useRef(p.onTrajectoryBrowseIntent),liveControls=useRef(playback.controls);browseIntent.current=p.onTrajectoryBrowseIntent;liveControls.current=playback.controls;
 const userSeek=useCallback((index:number)=>{browseIntent.current?.();liveControls.current.onSeek(index);},[]);
 const userStep=useCallback((direction:1|-1)=>{browseIntent.current?.();liveControls.current.onStep(direction);},[]);
 const userPause=useCallback(()=>{browseIntent.current?.();liveControls.current.onPause();},[]);
 const userPlay=useCallback(()=>{browseIntent.current?.();liveControls.current.onPlay();},[]);
 const frame=playback.frame,currentIndex=frame.index;
 const scientificFrameReady=p.available!==false&&!playback.busy&&!playback.loading&&!!prepared.get(currentIndex);
 const annotationScope=useMemo(()=>({}),[result,currentIndex]);
 const liveAnnotationScope=useRef(annotationScope);liveAnnotationScope.current=annotationScope;
 const [annotationOwners,setAnnotationOwners]=useState<Record<string,{scope:object;records:readonly MeasurementRecord[]}>>({});
 const annotationCallbacks=useMemo(()=>new Map<string,(records:readonly MeasurementRecord[])=>void>(),[annotationScope]);
 const coordinateAnnotationCallback=(id:string)=>{
  let callback=annotationCallbacks.get(id);
  if(!callback){callback=records=>{if(liveAnnotationScope.current===annotationScope)setAnnotationOwners(previous=>previous[id]?.scope===annotationScope&&previous[id].records===records?previous:{...previous,[id]:{scope:annotationScope,records}});};annotationCallbacks.set(id,callback);}
  return callback;
 };
 const coordinateAnnotations=useMemo(()=>p.active&&scientificFrameReady&&page==='trajectory'&&activeId&&annotationOwners[activeId]?.scope===annotationScope?annotationOwners[activeId].records:[],[p.active,scientificFrameReady,page,activeId,annotationOwners,annotationScope]);
 const displayedMeasurement=useMemo(()=>({...measurement,records:mergeCoordinateAnnotations(measurement.records??[],coordinateAnnotations)}),[measurement,coordinateAnnotations]);
 const multiframe=usePostprocessMultiframe({result,prepared,documentId:p.document.id,sourceRevision:metadata?.sourceRevision??result.source.id,
  stageId:p.stageKey,currentIndex,active:p.active&&p.available!==false&&page!=='vibrations',collection,centerResources:p.centerResources});
 // Each port closes over its own stage/session cell. A new render must not
 // replace the values an old port will capture during layout-effect cleanup.
 const browseState=useMemo(()=>({index:currentIndex,pause:playback.controls.onPause,capture:playback.captureViewState}),[p.stageKey,playback.captureViewState]);browseState.index=currentIndex;
 useLayoutEffect(()=>{if(!p.stageKey)return;return p.onBrowsePort({stageKey:p.stageKey,snapshot:()=>{const playback=browseState.capture();return{frameIndex:playback.frameIndex,cameraView:getView.current?.().slice()??lastView.current,playback};},pause:()=>browseState.pause()});},[p.onBrowsePort,p.stageKey,browseState]);
 const handledRequestedFrameSerial=useRef(0);
 useEffect(()=>{
  if(!p.requestedFrame||p.requestedFrame.serial===handledRequestedFrameSerial.current||!result.frames.length)return;
  if(!p.active||p.available===false||!viewReady||!p.stageKey||playback.controls.disabled)return;
  const targetIdx=Math.max(0,Math.min(p.requestedFrame.frameIndex,result.frames.length-1));
  if(currentIndex===targetIdx){
   if(playback.playing||playback.previewing)playback.controls.onPause();
   handledRequestedFrameSerial.current=p.requestedFrame.serial;
   return;
  }
  playback.controls.onPause();
  playback.controls.onSeek(targetIdx);
 },[p.requestedFrame?.serial,p.requestedFrame?.frameIndex,p.active,p.available,viewReady,p.stageKey,playback.controls,playback.playing,playback.previewing,currentIndex,result.frames.length]);
 const cameraView=p.cameraView;
 const observing=useTrajectoryObservationEnabled();
 const frameProjection=useMemo(()=>projectPostprocessFrame(p.document,currentIndex),[p.document,currentIndex]);
 const frameWaveAvailable=frameProjection.wavefunctionAvailable&&current?.frameIndex===currentIndex;
 const onViewReady=useCallback((getter:(()=>number[])|null)=>{if(!getter)lastView.current=getView.current?.().slice()??lastView.current;getView.current=getter;setViewReady(!!getter);},[]);
 const bondCache=useMemo(()=>new ResultViewBonds(result),[result]);
 const view=useMemo(()=>({structure:{...frame.structure,bonds:frame.structure.bonds??[]},message:playback.busy?'读取当前帧…':'当前帧'}),[frame.structure,playback.busy]);
 const vibration=page==='vibrations'&&current?.vibration?.sourceId===result.source.id&&current.vibration.jobIndex===result.jobIndex&&current.vibration.frameIndex===currentIndex?current.vibration:null;
 const shownStructure=useMemo(()=>vibration?{...vibration.structure,bonds:view.structure.bonds,bondSource:view.structure.bondSource}:view.structure,[vibration,view.structure]);
 const vibrationVectors=useMemo(()=>vibration?.arrows?vibration.vectors.map((vector,index)=>({atomId:view.structure.atoms[index].id!,vector:vector.map(value=>value*vibration.arrowAmplitude) as Vector3,appearance:vibration.arrowAppearance})):undefined,[vibration?.arrows,vibration?.vectors,vibration?.arrowAmplitude,vibration?.arrowAppearance,view.structure]);
 const frameBondIdentity=useMemo<FrameBondIdentity>(()=>resultFrameBondIdentity(p.frameBondSource??resultFrameBondSource(result,result.stages?.[0]?.id??'trajectory',p.playbackContinuity),result.frames[currentIndex]?.sourceFrameIndex??currentIndex),[result,JSON.stringify(p.frameBondSource),p.playbackContinuity?.ownerId,p.playbackContinuity?.collectionId,p.playbackContinuity?.sourceGeneration,currentIndex]);
 const bondPreparation=empiricalFramePreparationState(prepared,currentIndex);
 const bondWarningKey=JSON.stringify([frameBondIdentity,bondPreparation?.status,bondPreparation?.warnings]);
 const bondWarning=bondPreparation&&bondPreparation.status!=='inferred'&&!bondingWarnings.current.has(bondWarningKey)?<DismissibleNotice className="postprocess-warning" identity={bondWarningKey} onDismiss={()=>bondingWarnings.current.add(bondWarningKey)}>
  <details><summary>当前帧显示连接未完整准备</summary><p>{bondPreparation.warnings.join('\n')||'已保留本帧原子与可用来源连接。'}</p>
   {bondRetry?.key===bondWarningKey&&bondRetry.error&&<p>{bondRetry.error}</p>}
   <button disabled={bondRetry?.key===bondWarningKey&&!bondRetry.error||playback.playing||playback.previewing||!scientificFrameReady} onClick={()=>{
    setBondRetry({key:bondWarningKey,error:''});void prepared.retryFrame(currentIndex).then(()=>{playback.refreshPreparedFrame();setBondRetry(before=>before?.key===bondWarningKey?null:before);}).catch(error=>setBondRetry(before=>before?.key===bondWarningKey?{key:bondWarningKey,error:error instanceof Error?error.message:String(error)}:before));
   }}>重新准备显示连接</button></details>
 </DismissibleNotice>:null;
 const rawDocument=useMemo(()=>{const projected=trajectoryViewDocument(result,view.structure,currentIndex);return p.modelDocument?applyFrameBondOverride(p.modelDocument,{...projected,id:p.modelDocument.id},frameBondIdentity):projected;},[p.modelDocument,result,view.structure,currentIndex,frameBondIdentity]);
 const observation=useObservationInteraction({root:viewport,document:rawDocument,active:p.active&&!p.onCanvas,setMeasurement});
 const document=useMemo(()=>p.onCanvas?rawDocument:{...rawDocument,selection:observation.selection},[rawDocument,p.onCanvas,observation.selection]);
 const onCipLabelsUsed=useCurrentCipUsage(document,p.active&&p.available!==false,p.onCipLabelsUsed);
 const staticDocument=rawDocument;
 const structureExportIdentity=JSON.stringify([sourceIdentity,result.id,result.source.sha256]);
 const structureExportLive=useRef({identity:structureExportIdentity,active:p.active,ready:p.available!==false&&scientificFrameReady&&viewReady,document:staticDocument,structure:shownStructure});
 useLayoutEffect(()=>{structureExportLive.current={identity:structureExportIdentity,active:p.active,ready:p.available!==false&&scientificFrameReady&&viewReady,document:staticDocument,structure:shownStructure};});
 const structureExportAlive=useRef(true);useEffect(()=>{structureExportAlive.current=true;return()=>{structureExportAlive.current=false;};},[]);
 const captureStructureExport=useCallback(()=>{
  const current=structureExportLive.current;
  if(!structureExportAlive.current||!current.active||!current.ready||current.identity!==structureExportIdentity)throw Error('当前结果帧尚未准备完整，请稍后导出。');
  const document=captureDisplayedStructureDocument(current.document,{structure:current.structure});
  return{document,name:document.draft.structure.name,assertCurrent:()=>{const live=structureExportLive.current;if(!structureExportAlive.current||!live.active||live.identity!==structureExportIdentity)throw Error('结构导出所属文件或作业已切换。');}};
 },[structureExportIdentity]);
 const structureExportSource=useMemo<StructureExportSource>(()=>({available:p.active&&p.available!==false&&scientificFrameReady&&viewReady,capture:captureStructureExport}),[p.active,p.available,scientificFrameReady,viewReady,captureStructureExport]);
 useLayoutEffect(()=>{p.onStructureExportSource?.(structureExportSource);return()=>p.onStructureExportSource?.(null);},[p.onStructureExportSource,structureExportSource]);
 useLayoutEffect(()=>{
  p.onObservedFrame?.(p.active&&p.available!==false&&scientificFrameReady?staticDocument.draft.structure:null);
 },[p.onObservedFrame,p.active,p.available,scientificFrameReady,staticDocument]);
 const observedFrameCallback=useRef(p.onObservedFrame);observedFrameCallback.current=p.onObservedFrame;
 useLayoutEffect(()=>()=>observedFrameCallback.current?.(null),[]);
 const editObservation=useRef({frame:view.structure,pause:playback.controls.onPause,vibration,multiframe});editObservation.current={frame:view.structure,pause:playback.controls.onPause,vibration,multiframe};
 const prepareModelEdit=useCallback(()=>{const current=editObservation.current;current.pause();pauseVibrationProjection(current.vibration);if(current.multiframe.enabled)current.multiframe.onToggle();return structuredClone(current.frame);},[]);
 const surfaceContext=useMemo<SurfaceContext>(()=>({sourceId:result.source.id,sourceRevision:metadata?.sourceRevision??result.source.id,jobIndex:result.jobIndex,sourceFrameIndex:result.frames[currentIndex]?.sourceFrameIndex??currentIndex,generation:0,documentId:document.id,documentRevision:document.revision}),[result,currentIndex,metadata?.sourceRevision,document.id,document.revision]);
 const renderIdentity=useMemo(()=>observing?{sourceId:result.source.id,sourceRevision:surfaceContext.sourceRevision,jobIndex:result.jobIndex,frameIndex:currentIndex,generation:surfaceContext.generation,requestId:`${result.id}:${currentIndex}:${playback.previewing?'preview':playback.playing?'play':'pause'}`} : undefined,[observing,result,surfaceContext.sourceRevision,surfaceContext.generation,currentIndex,playback.playing,playback.previewing]);
 const onRenderComplete=useMemo<ModelViewportProps['onRenderComplete']>(()=>{if(!observing)return;const phase={playing:playback.playing,previewing:playback.previewing,prepared:!!prepared.get(currentIndex)};return event=>emitTrajectoryRenderCompletion(event,phase);},[observing,playback.playing,playback.previewing,prepared,currentIndex]);
 useEffect(()=>{if(renderIdentity)observePreparedTrajectory(prepared,{...renderIdentity,documentId:document.id});},[observing,prepared,result,document.id,renderIdentity?.sourceRevision]);
 const hsFamily=!!activeId&&surfaceFamilies[activeId]==='hirshfeld';
 const surface=page==='surface'&&!hsFamily&&activeId&&surfaces[activeId]&&sameSurfaceContext(surfaces[activeId]!.context,surfaceContext)?surfaces[activeId]!:null;
 const hirshfeld=page==='surface'&&hsFamily&&activeId&&hirshfelds[activeId]&&sameSurfaceContext(hirshfelds[activeId]!.context,surfaceContext)?hirshfelds[activeId]!:null;
 const interactionProjection=page==='interaction'&&activeId&&interactions[activeId]&&sameSurfaceContext(interactions[activeId]!.context,surfaceContext)?interactions[activeId]!:null;
 const excitationProjection=page==='excited'&&activeId&&excitations[activeId]&&sameSurfaceContext(excitations[activeId]!.context,surfaceContext)?excitations[activeId]!:null;
 const reactivityProjection=page==='reactivity'&&activeId&&reactivities[activeId]&&sameSurfaceContext(reactivities[activeId]!.context,surfaceContext)?reactivities[activeId]!:null;
 const capture=useAnalysisAtomCapture({ownerId:activeId??'',purpose:page==='trajectory'?'advanced-coordinate':page==='interaction'?'interaction-fragment':page==='surface'&&hsFamily?'hirshfeld-target':'surface-region',structure:view.structure,documentId:document.id,revision:document.revision,sourceId:result.source.id,sourceRevision:surfaceContext.sourceRevision,jobIndex:result.jobIndex,frameIndex:currentIndex,activationEpoch:sourceIdentity+':'+(activeId??'')+':'+(hsFamily?'hirshfeld':'electronic'),active:p.active&&p.available!==false&&(page==='surface'||page==='interaction'||page==='trajectory'),onError:p.onError});
 const hoverSurface=useCallback((id:string|null)=>{if(activeId)surfaceInteractions.current.get(activeId)?.hover(id);},[activeId]);
 const pickSurface=useCallback((id:string)=>{if(activeId)surfaceInteractions.current.get(activeId)?.toggle(id);},[activeId]);
 const onSurfaceMeshState=useCallback((state:Readonly<SurfaceMeshState>,actual:Pick<ModelDocument,'id'|'revision'>)=>{if(activeId&&page==='interaction')interactionMeshes.current.get(activeId)?.(state,actual);else if(activeId&&page==='surface'&&hsFamily)hirshfeldMeshes.current.get(activeId)?.(state,actual);},[activeId,page,hsFamily]);
 const onSurfaceMeshStates=useCallback<NonNullable<ModelViewportProps['onSurfaceMeshStates']>>((states,actual)=>{if(activeId&&page==='excited')excitationMeshes.current.get(activeId)?.density(states,actual);},[activeId,page]);
 const onNtoMeshState=useCallback<NonNullable<ModelViewportProps['onNtoMeshState']>>((state,actual)=>{if(activeId&&page==='excited')excitationMeshes.current.get(activeId)?.nto(state,actual);},[activeId,page]);
 const surfaceViewport=useMemo(()=>({calculationRanges:page==='excited'?excitationProjection?.calculationRanges:page==='interaction'?interactionProjection?.calculationRanges:hirshfeld?.calculationRanges,surfaceLayer:interactionProjection?.surfaceLayer??hirshfeld?.surfaceLayer??surface?.surfaceLayer??undefined,surfaceLayers:page==='excited'?excitationProjection?.surfaceLayers:undefined,surfaceExtrema:surface?.surfaceExtrema??undefined,hiddenAtomIds:hirshfeld?.hiddenAtomIds,onSurfaceExtremumHover:hoverSurface,onSurfaceExtremumPick:pickSurface,analysisAtomCapture:capture.viewportCapture,renderIdentity,onRenderComplete,onSurfaceMeshState,onSurfaceMeshStates}),[page,excitationProjection?.calculationRanges,interactionProjection?.calculationRanges,hirshfeld?.calculationRanges,excitationProjection?.surfaceLayers,interactionProjection?.surfaceLayer,hirshfeld?.surfaceLayer,hirshfeld?.hiddenAtomIds,surface?.surfaceLayer,surface?.surfaceExtrema,hoverSurface,pickSurface,capture.viewportCapture,renderIdentity,onRenderComplete,onSurfaceMeshState,onSurfaceMeshStates]);
 const display=useMemo(()=>({...p.display,alignment:'off' as const}),[p.display]);
 const activeMcpOverlay=p.mcpOverlay&&frameProjection.wavefunctionAvailable&&p.mcpOverlay.sourceId===result.source.id&&p.mcpOverlay.sourceRevision===(metadata?.sourceRevision??result.source.id)&&p.mcpOverlay.frameIndex===currentIndex&&(!page||page===p.mcpOverlay.page)?p.mcpOverlay:null;
 const effectivePage=page??activeMcpOverlay?.page;
 const uiBond=page==='bonds'&&current&&frameWaveAvailable&&current.bond.result?.sessionId===current.sessionId&&current.bond.result.sourceRevision===metadata?.sourceRevision?current.bond.result:null;
 const mcpBond=!uiBond&&effectivePage==='bonds'&&activeMcpOverlay?.bondResult&&activeMcpOverlay.bondResult.sourceRevision===metadata?.sourceRevision?activeMcpOverlay.bondResult:null;
 const bond=uiBond??mcpBond;
 const bondDisplay=uiBond?current!.bond.display:DEFAULT_MCP_BOND_DISPLAY;
 const mcpChargeDisplay=useMemo(()=>{
  if(effectivePage!=='charges'||!activeMcpOverlay?.chargeResult||!metadata)return null;
  if(current?.sourceChargeDisplay?.columns.some(col=>col.origin.producedBy==='calculated'))return null;
  const ctx={result,structure:view.structure,frameIndex:currentIndex,wavefunctionAvailable:true,generatedXtb:!!generatedXtb,nativeAtomIds:metadata.structure.atoms.map(atom=>atom.id!),nativeSessionId:activeMcpOverlay.chargeResult.sessionId,nativeSourceRevision:metadata.sourceRevision};
  const cols=professionalChargeColumns(ctx,[activeMcpOverlay.chargeResult],[activeMcpOverlay.chargeResult.method],false);
  return cols.length?professionalChargeDisplay(ctx,cols,activeMcpOverlay.chargeResult.method,{color:true,labels:true,spin:false,decimals:2}):null;
 },[effectivePage,activeMcpOverlay?.chargeResult,metadata,current?.sourceChargeDisplay,result,view.structure,currentIndex,generatedXtb]);
 const chargeView=useMemo(()=>effectivePage==='charges'?sourceChargeViewport(mcpChargeDisplay??current?.sourceChargeDisplay,result,view.structure,currentIndex,mcpChargeDisplay?undefined:current?.printedHighlights):null,[effectivePage,mcpChargeDisplay,current?.sourceChargeDisplay,current?.printedHighlights,result,view.structure,currentIndex]);
 const mcpReactivityDisplay=useMemo(()=>{
  if(effectivePage!=='reactivity'||reactivityProjection?.result||!activeMcpOverlay?.reactivityResult)return null;
  const metric=activeMcpOverlay.reactivityMetric??'dual';
  const order=surfaceSourceAtomOrder(view.structure,document,metadata?.structure)??[];
  const rows=reactivityAtomDisplay(activeMcpOverlay.reactivityResult,metric,order,view.structure,2);
  const range=analysisRange(rows.map(r=>r.value),{color:true,labels:false,spin:false},metric==='dual');
  const unit=reactivityMetricUnit(metric);
  return {
   scalarValues:rows,
   color:true,
   highlights:rows,
   colorbar:range?{...range,palette:'blue-red' as const,decimals:2,label:`${REACTIVITY_ATOM_LABELS[metric]}${unit?` / ${unit}`:''}`}:undefined
  };
 },[effectivePage,reactivityProjection?.result,activeMcpOverlay?.reactivityResult,activeMcpOverlay?.reactivityMetric,view.structure,document,metadata?.structure]);
 const scalarValues=useMemo(()=>effectivePage==='reactivity'?((reactivityProjection?.result?reactivityProjection.scalarValues:mcpReactivityDisplay?.scalarValues)??[]).flatMap(row=>{const atomIndex=view.structure.atoms.findIndex(atom=>atom.id===row.atomId);return atomIndex<0?[]:[{atomIndex,value:row.value,color:row.color,label:row.label}];}):chargeView?.scalarValues??[],[effectivePage,reactivityProjection,mcpReactivityDisplay,view.structure,chargeView]),chargeColor=effectivePage==='reactivity'?(reactivityProjection?.result?!!reactivityProjection.color:!!mcpReactivityDisplay?.color):!!chargeView?.color;
 const bondValues=useMemo(()=>effectivePage==='interaction'?(interactionProjection?.highlights.pairs??[]).map(row=>{const atoms=row.atomIds.map(id=>view.structure.atoms.find(atom=>atom.id===id));return{...row,measurementLabel:row.label,length:atoms.every(Boolean)?Math.hypot(atoms[0]!.x-atoms[1]!.x,atoms[0]!.y-atoms[1]!.y,atoms[0]!.z-atoms[1]!.z):undefined,decimals:interactionProjection?.decimals};}):bond&&metadata?visibleBondDisplayValues(mapComparedAnalysisResult(bond,uiBond?current?.bond.comparisons:undefined,metadata,view.structure,bondDisplay).bonds,bondDisplay):[],[effectivePage,interactionProjection,bond,uiBond,metadata,view.structure,bondDisplay,current?.bond.comparisons]);
 const mcpCompositionHighlights=useMemo(()=>{
  if(effectivePage!=='orbitals'||current?.highlights.values?.length||!activeMcpOverlay?.compositionResult||!metadata)return null;
  const top=compositionRows(activeMcpOverlay.compositionResult,'threshold');
  return top.map(row=>({atomId:mapAnalysisHighlight([row.atomId],metadata,view.structure)[0],label:`贡献 ${formatResultValue(row.value,2)} %`}));
 },[effectivePage,current?.highlights.values,activeMcpOverlay?.compositionResult,metadata,view.structure]);
 const resultHighlights=useMemo(()=>{if(effectivePage==='reactivity')return{atomIds:((reactivityProjection?.result?reactivityProjection.highlights:mcpReactivityDisplay?.highlights)??[]).map(row=>row.atomId),bondPairs:[]};if(effectivePage==='interaction')return{atomIds:(interactionProjection?.highlights.atoms??[]).map(row=>row.atomId),bondPairs:(interactionProjection?.highlights.pairs??[]).map(row=>row.atomIds)};if(mcpCompositionHighlights)return{atomIds:mcpCompositionHighlights.map(row=>row.atomId),bondPairs:[]};const native=effectivePage!=='charges'&&metadata&&current&&frameWaveAvailable?mapAnalysisHighlight(current.highlights.ids,metadata,view.structure):[];return{atomIds:effectivePage==='charges'?chargeView?.ids??[]:native,bondPairs:effectivePage==='bonds'&&metadata&&current&&frameWaveAvailable?current.pairs.map(pair=>mapAnalysisHighlight(pair,metadata,view.structure) as [string,string]):[]};},[reactivityProjection,mcpReactivityDisplay,interactionProjection,mcpCompositionHighlights,metadata,current?.highlights,current?.pairs,effectivePage,view.structure,frameWaveAvailable,chargeView]);
 const atomLabels=useMemo(()=>{
  if(effectivePage==='charges')return chargeView?.atomLabels??[];
  if(effectivePage==='reactivity')return (reactivityProjection?.result?reactivityProjection.highlights:mcpReactivityDisplay?.highlights)??[];
  if(effectivePage==='interaction')return interactionProjection?.highlights.atoms??[];
  if(mcpCompositionHighlights)return mcpCompositionHighlights;
  return metadata&&current&&frameWaveAvailable&&effectivePage==='orbitals'?(current.highlights.values??[]).map(row=>({atomId:mapAnalysisHighlight([row.atomId],metadata,view.structure)[0],label:row.label??'贡献 '+formatResultValue(row.value,2)+' %'})):[];
 },[metadata,current?.highlights,effectivePage,view.structure,frameWaveAvailable,chargeView,interactionProjection,reactivityProjection,mcpReactivityDisplay,mcpCompositionHighlights]);
 const colorbar=useMemo<AnalysisColorbar|undefined>(()=>{
  if(effectivePage==='surface')return hirshfeld?.colorbar??surface?.colorbar??undefined;
  if(effectivePage==='reactivity')return (reactivityProjection?.result?reactivityProjection.colorbar:mcpReactivityDisplay?.colorbar)??undefined;
  if(effectivePage==='interaction')return interactionProjection?.colorbar??undefined;
  if(effectivePage==='charges')return chargeView?.colorbar;
  const settings=effectivePage==='bonds'?bondDisplay:undefined;
  if(!settings?.color)return;const range=analysisRange(bondValues.map(row=>row.value),settings,false);
  return range?{...range,palette:settings.palette??'blue-red',decimals:settings.decimals??2,label:'BO'+(bond?.method?` · ${bond.method}`:''),layout:settings.colorbarLayout}:undefined;
 },[effectivePage,chargeView,bondDisplay,bondValues,bond?.method,hirshfeld?.colorbar,surface?.colorbar,interactionProjection?.colorbar,reactivityProjection,mcpReactivityDisplay]);
 const colorbarOwnerKey=activeId&&colorbar?JSON.stringify([sourceIdentity,activeId,effectivePage,currentIndex,document.id,document.revision]):undefined;
 const changeColorbarLayout=useCallback((layout:AnalysisColorbarLayout)=>{
  if(!activeId||!p.active||p.available===false)return;
  if(page==='surface'&&hirshfeld)hirshfeldLayouts.current.get(activeId)?.(layout);
  else if(page==='surface'&&surface)surfaceInteractions.current.get(activeId)?.setColorbarLayout?.(layout);
  else if(page==='interaction'&&interactionProjection)interactionPorts.current.get(activeId)?.setColorbarLayout?.(layout);
  else if(page==='reactivity'&&reactivityProjection)reactivityPorts.current.get(activeId)?.setColorbarLayout?.(layout);
  else if(page==='charges'||page==='bonds')colorbarLayoutPorts.current.get(activeId)?.(layout);
 },[activeId,p.active,p.available,page,surface,hirshfeld,interactionProjection,reactivityProjection]);
 const dipole=postprocessDipole(frameProjection.scientific,currentIndex);
 const dipoleVector=useMemo(()=>{
  if(page!=='energy'||!current?.dipoleVisible||!dipole||Math.hypot(...dipole.vector)<1e-7)return;
  const atoms=view.structure.atoms,origin=[0,1,2].map(axis=>atoms.reduce((sum,atom)=>sum+[atom.x,atom.y,atom.z][axis],0)/atoms.length) as Vector3;
  const rotation=dipole.sourceId===p.document.wavefunction?.source.result.source.id?p.document.pair?.sourceToDisplay.rotation:undefined;
  const vector=rotation?rotation.map(row=>row.reduce((sum,value,index)=>sum+value*dipole.vector[index],0)) as Vector3:dipole.vector,norm=Math.hypot(...vector);
  return{origin,vector:vector.map(value=>3*value/norm) as Vector3,color:'#ae4dbe'};
 },[page,current?.dipoleVisible,dipole?.vector.join(','),view.structure,p.document.pair]);
 const orbitalLayer=useMemo<ViewportOrbitalLayer|undefined>(()=>{
  if(effectivePage==='reactivity')return reactivityProjection?.orbitalLayer??undefined;
  const field=current?.field;
  if(page==='orbitals'&&frameWaveAvailable&&field&&metadata&&field.sourceRevision===metadata.sourceRevision&&field.sessionId===current.sessionId&&field.orbitalKey===current.selectedKey){
   return{field,documentId:document.id,geometryRevision:document.revision,...current.layer,sourceToDocument:p.document.pair?.sourceToDisplay};
  }
  if(effectivePage==='orbitals'&&activeMcpOverlay?.orbitalField&&metadata&&activeMcpOverlay.orbitalField.sourceRevision===metadata.sourceRevision){
   return{field:activeMcpOverlay.orbitalField,documentId:document.id,geometryRevision:document.revision,...DEFAULT_ORBITAL_LAYER,visible:true,isovalue:activeMcpOverlay.orbitalIsovalue??DEFAULT_ORBITAL_LAYER.isovalue,sourceToDocument:p.document.pair?.sourceToDisplay};
  }
  return undefined;
 },[effectivePage,page,reactivityProjection?.orbitalLayer,current?.field,current?.layer,current?.selectedKey,current?.sessionId,activeMcpOverlay?.orbitalField,activeMcpOverlay?.orbitalIsovalue,metadata,document.id,document.revision,p.document.pair,frameWaveAvailable]);
 const ntoLayer=page==='excited'?excitationProjection?.ntoLayer??undefined:undefined;
 const resultBondValues=effectivePage==='bonds'||effectivePage==='interaction'?bondValues:undefined;
 const resultBondLabels=effectivePage==='interaction'||effectivePage==='bonds'&&!!bondDisplay.labels;
 const resultBondColor=effectivePage==='bonds'&&!!bondDisplay.color;
 const modelEditingBlocked=Boolean(playback.playing||playback.previewing||playback.busy||playback.loading||vibration?.playing);
 const sourceRevision=String(collection.identity.revision);
 const exportController=useRef<AbortController|null>(null);
 useEffect(()=>()=>exportController.current?.abort(),[]);
 async function exportGif(request:VibrationGifRequest){
  if(!getView.current||exporting)throw new Error('画布尚未准备完成，或已有导出正在进行。');
  if(request.sourceId!==result.source.id||request.jobIndex!==result.jobIndex||request.frameIndex!==currentIndex)throw new Error('振动来源或当前帧已变化，请重新导出。');
  const controller=new AbortController();exportController.current=controller;setExporting(true);
  const abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)controller.abort();
  let sink:Awaited<ReturnType<typeof openBinaryExportSink>>=null,committed=false;
  try{sink=await openBinaryExportSink('Ester-Studio-mode-'+request.displayIndex,'gif',controller.signal);if(sink==='cancelled')return;const bounds=viewport.current?.getBoundingClientRect();const output=await captureVibrationGif({snapshot:{document,cameraView:getView.current(),display,showAxes,width:640,height:480,viewportWidth:bounds?.width??800,viewportHeight:bounds?.height??600,measurement:displayedMeasurement,resultKind:result.kind,scalarSourceFrameIndex:currentIndex,vibrationVectors},mode:request.mode,baseStructure:{...request.baseStructure,bonds:view.structure.bonds,bondSource:view.structure.bondSource},amplitude:request.amplitude,periodMs:request.periodMs,durationSeconds:request.durationSeconds,signal:controller.signal,onProgress:request.onProgress,sink:sink??undefined});if(!controller.signal.aborted){if(sink){await sink.close();committed=true;}else exportBlob(output.blob,`Ester-Studio-mode-${request.displayIndex}.gif`);}}finally{if(sink&&sink!=='cancelled'&&!committed)await sink.abort();request.signal?.removeEventListener('abort',abort);if(exportController.current===controller){exportController.current=null;setExporting(false);}}
 }
 function captureImage(options:ViewportImageExportOptions,ownerDocument:Document,signal:AbortSignal){
  const host=viewport.current?.querySelector('.model-viewport-stage');
  const localOwner=host??fileInput.current, getCamera=getView.current, bounds=host?.getBoundingClientRect();
  if(!p.active||p.available===false||!getCamera||!localOwner?.isConnected||localOwner.ownerDocument!==ownerDocument||
      (!host&&!p.onCanvas)||bounds&&(bounds.width<=0||bounds.height<=0))
   throw new Error('当前分析视口尚未准备好。');
  const displayDocument=vibration?{...document,draft:{...document.draft,structure:{...shownStructure,bonds:document.draft.structure.bonds}}}:document;
  const snapshot:OffscreenCaptureSnapshot={
   document:displayDocument,cameraView:[...getCamera()],display,showAxes,multiframeDisplay:multiframe.plan,
   hiddenAtomIds:surfaceViewport.hiddenAtomIds,calculationRanges:surfaceViewport.calculationRanges,
   width:1600,height:1200,viewportWidth:bounds?.width??800,viewportHeight:bounds?.height??600,measurement:displayedMeasurement,
   legend:host?captureViewportLegend(host,document.id):undefined,
   atomScalarValues:scalarValues,atomScalarColor:chargeColor,atomScalarLabels:false,orbitalLayer,ntoLayer,dipoleVector,
   surfaceLayer:surfaceViewport.surfaceLayer,surfaceLayers:surfaceViewport.surfaceLayers,surfaceExtrema:surfaceViewport.surfaceExtrema,
   resultKind:result.kind,viewBonds:bondCache.snapshot(document.draft.structure,currentIndex),resultBondValues,resultBondLabels,resultBondColor,
   resultAtomLabels:atomLabels,resultHighlights,resultColorbar:colorbar,vibrationVectors,
   displayGeometry:vibration?'vibration':undefined,vibrationBaseStructure:vibration?view.structure:undefined
  };
  return exportViewportImage(snapshot,options,ownerDocument,signal);
 }
 async function exportImage(options:ViewportImageExportOptions={format:'png',includeAnnotations:true},requestedOwner?:Document){
  if(!getView.current||exporting||exportController.current)return;
  const owner=requestedOwner??viewport.current?.ownerDocument??p.toolbarHost?.ownerDocument??p.toolHost?.ownerDocument??fileInput.current?.ownerDocument;
  if(!owner){p.onError('导出窗口尚未准备完成。');return;}
  const controller=new AbortController();exportController.current=controller;setExporting(true);
  try{const blob=await captureImage(options,owner,controller.signal);if(!controller.signal.aborted)exportBlob(blob,'Ester-Studio-'+(current?.selectedKey?.replace(':','-')??effectivePage??'structure')+'.'+options.format,owner);}catch(error){if(!controller.signal.aborted)p.onError(error instanceof Error?error.message:String(error));}finally{if(exportController.current===controller){exportController.current=null;setExporting(false);}}
 }
 const overlayKey=JSON.stringify(playbackOverlayPresentation(multiframe));
 const multiframeControls=useMemo(()=><PlaybackOverlayControls {...multiframe} disabled={!p.active||p.available===false||!viewReady||page==='vibrations'}/>,[overlayKey,p.active,p.available,viewReady,page,multiframe.onToggle,multiframe.onFitAtoms,multiframe.onReference,multiframe.onReferenceIndex,multiframe.onCurrentReference,multiframe.onCancelCenter]);
 const dispatchPlayback=(command:TrajectoryPlaybackCommand)=>{const c=playback.controls;if(command.action==='play')c.onPlay();else if(command.action==='pause')c.onPause();else if(command.action==='seek')c.onSeek(command.index);else if(command.action==='step')c.onStep(command.direction);else if(command.action==='fps')c.onFps(command.value);else if(command.action==='direction')c.onDirection(command.direction);else if(command.action==='mode')c.onMode(command.mode);else if(command.action==='range')c.onRange(command.range);else if(command.action==='endpoint-pause')c.onEndpointPause?.(command.value);else if(command.action==='seek-target')c.onSeekTarget?.(command.kind);else if(command.action==='overlay-toggle')multiframe.onToggle();else if(command.action==='overlay-atoms')multiframe.onFitAtoms(command.value);else if(command.action==='overlay-reference')multiframe.onReference(command.kind);else if(command.action==='overlay-reference-index')multiframe.onReferenceIndex(command.index);else if(command.action==='overlay-current-reference')multiframe.onCurrentReference();else if(command.action==='center-cancel')multiframe.onCancelCenter();else if(command.action==='prepare')c.onPrepare?.();else if(command.action==='cancel-preparation')c.onCancelPreparation?.();else if(command.action==='silent-loading')c.onSilentLoading?.(command.value);};
 const dispatchRef=useRef(dispatchPlayback);dispatchRef.current=dispatchPlayback;
 const dispatchBridge=useCallback((command:TrajectoryPlaybackCommand,intent?:'workflow')=>{if(intent!=='workflow'&&['play','pause','seek','step','seek-target','range'].includes(command.action))browseIntent.current?.();dispatchRef.current(command);},[]);
 const latestImageExport=useRef<()=>void>(()=>{});useLayoutEffect(()=>{latestImageExport.current=()=>{void exportImage();};});
 const requestImageExport=useCallback(()=>latestImageExport.current(),[]);
 useLayoutEffect(()=>{p.onImageExportReady?.(p.active&&p.available!==false&&viewReady?requestImageExport:null);return()=>p.onImageExportReady?.(null);},[p.onImageExportReady,p.active,p.available,viewReady,requestImageExport]);
 const toolbar=<ModelWorkspaceToolbar readOnly readOnlySaveAllowed={structureExportSource.available} onSave={p.onExportStructure} disabled={{save:!structureExportSource.available||p.structureExportBusy}} observationOnly={p.observationOnly} display={p.display} onDisplayChange={p.onDisplay} onNew={p.onNewDocument} onImport={p.onImportFiles?()=>fileInput.current?.click():undefined} onActivate={p.onActivate} layoutActions={p.layoutActions}
  imageExport={<ViewportImageExportMenu disabled={!viewReady||p.available===false} captureDisabled={!p.active||!scientificFrameReady} exporting={exporting}
    onExport={exportImage} onCapture={captureImage} captureKey={p.active?sourceIdentity:null} getViewportSize={()=>viewport.current?.querySelector('.model-viewport-stage')?.getBoundingClientRect()}/>}
  actions={<select aria-label="后处理只读测量" value={measurement.mode??''} onChange={event=>setMeasurement(emptyMeasurement((event.target.value||null) as typeof measurement.mode))}><option value="">不测量</option><option value="auto">自动 B/A/D</option><option value="distance">距离</option><option value="angle">键角</option><option value="dihedral">二面角</option></select>}
  settingsContent={<ElementColorControls atoms={view.structure.atoms} display={p.display} onChange={p.onDisplay}/>} view={{showAxes,hasAtoms:!!view.structure.atoms.length,hasCell:!!view.structure.cell,showCell:display.cell,onCamera:request=>setCameraRequest(previous=>({...request,serial:(previous?.serial??0)+1})),onReset:()=>setResetView(value=>value+1),onToggleAxes:toggleAxes,onToggleCell:()=>p.onDisplay({...p.display,cell:!display.cell})}}/>;
 useLayoutEffect(()=>{if(p.selected&&!p.onCanvas)p.onToolbarSurfaceChange?.(toolbar);});
 const playbackControls=useMemo(()=><div data-testid="postprocess-playback" data-frame-index={currentIndex} data-frame-count={result.frames.length} data-playing={playback.playing} data-previewing={playback.previewing} data-wavefunction-available={frameProjection.wavefunctionAvailable} data-preparation-mode={playback.preparation?.mode} data-prepared-count={playback.preparation?.completed} data-preparation-bytes={playback.preparation?.retainedBytes} data-preparation-peak-bytes={playback.preparation?.peakBytes}>
  {p.contextControls}
  {bondWarning}
  {(result.frames.length>1||playback.preparation)&&<TrajectoryControls {...playback.controls} onSeek={userSeek} onStep={userStep} onPause={userPause} onPlay={userPlay} loadingHost={p.loadingHost} detailsContent={multiframeControls}/>}
 </div>,[p.contextControls,bondWarningKey,bondRetry,multiframeControls,result,currentIndex,playback.playing,playback.previewing,playback.busy,playback.frameDelayMs,playback.fps,playback.direction,playback.mode,playback.range,playback.endpointPauseMs,playback.tsFrameIndex,playback.preparation,playback.loading,playback.loadCancelled,playback.silentLoading,p.active,p.available,viewReady,frameProjection.wavefunctionAvailable]);
 const trajectoryPlayback=useMemo<TrajectoryPlaybackBridge>(()=>({state:{...trajectoryPlaybackState(playback.controls),resultId:result.id,projectionKey:collection.identity.revision,collectionIdentity:collection.identity,frameId:collection.frames.find(frame=>frame.sourceFrameIndex===currentIndex)?.frameId,targets:collection.targets,overlay:playbackOverlayPresentation({...multiframe,disabled:!p.active||p.available===false||!viewReady})},dispatch:dispatchBridge}),[playbackControls,collection,currentIndex,dispatchBridge]);
 const canvas=useMemo<AnalysisCanvas>(()=>({document,staticDocument,coordinateAnnotations,exportStructure:scientificFrameReady?shownStructure:undefined,prepareModelEdit,result,frameIndex:currentIndex,sourceRevision,scientificFrameReady,modelEditingBlocked,frameBondIdentity,bondEditingBlocked:!scientificFrameReady||modelEditingBlocked,controls:playbackControls,trajectoryPlayback,viewport:{displayAtoms:vibration?shownStructure.atoms:undefined,...surfaceViewport,cameraView,multiframeDisplay:multiframe.plan,vibrationVectors,atomScalarValues:scalarValues,atomScalarColor:chargeColor,atomScalarLabels:false,orbitalLayer,ntoLayer,onNtoMeshState,dipoleVector,resultBondValues,resultBondLabels,resultBondColor,resultHighlights,resultColorbar:colorbar,resultColorbarOwnerKey:colorbarOwnerKey,onResultColorbarLayoutChange:changeColorbarLayout,resultAtomLabels:atomLabels},onViewReady,onExport:()=>void exportImage(),onExportImage:exportImage,onCaptureImage:captureImage,exportAvailable:viewReady&&p.available!==false,exporting}),[coordinateAnnotations,displayedMeasurement,shownStructure,vibration,surfaceViewport,cameraView,multiframe.plan,multiframeControls,scalarValues,chargeColor,effectivePage,bondDisplay,current?.selectedKey,orbitalLayer,ntoLayer,onNtoMeshState,dipoleVector,resultBondValues,resultBondLabels,resultBondColor,resultHighlights,colorbar,colorbarOwnerKey,changeColorbarLayout,atomLabels,onViewReady,exporting,viewReady,p.active,p.available,p.onCanvas,document,staticDocument,prepareModelEdit,display,showAxes,playbackControls,trajectoryPlayback,currentIndex,vibrationVectors,result,sourceRevision,scientificFrameReady,modelEditingBlocked,frameBondIdentity]);
 useLayoutEffect(()=>p.onCanvas?.(p.active&&p.available!==false?canvas:null),[p.onCanvas,p.active,p.available,canvas]);
 const onCanvasRef=useRef(p.onCanvas);onCanvasRef.current=p.onCanvas;
 useEffect(()=>()=>onCanvasRef.current?.(null),[]);
 function openScatter(snapshot:InteractionScatterSnapshot){
  if(!sameSurfaceContext(snapshot.context,surfaceContext))return;
  setScatterPlots(previous=>[...previous,{...snapshot,id:`interaction-scatter-${crypto.randomUUID()}`,kind:'interaction-scatter',
    title:`${INTERACTION_METHOD_LABELS[snapshot.method]} · ${INTERACTION_COMPONENT_LABELS[snapshot.component]}`,source:{...result.source},resultId:result.id,jobIndex:result.jobIndex,frameIndex:currentIndex}]);
  notifyAnalysisProjectStateChanged();
 }
 function openHirshfeldFingerprint(snapshot:HirshfeldFingerprintSnapshot){
  if(surfaceScientificContextKey(snapshot.result.stamp)!==surfaceScientificContextKey(surfaceContext))return;
  setScatterPlots(previous=>[...previous,{...snapshot,id:`hirshfeld-fingerprint-${crypto.randomUUID()}`,kind:'hirshfeld-fingerprint',title:'Hirshfeld指纹',source:{...result.source},resultId:result.id,jobIndex:result.jobIndex,frameIndex:currentIndex}]);
  notifyAnalysisProjectStateChanged();
 }
 const controls=<AnalysisWorkspace key={sourceIdentity} sourceId={sourceIdentity} allowedPages={p.allowedPages} initialPage={p.initialPage} requestedPage={p.requestedAnalysisPage} mcpRequestedPage={p.requestedPage} startEmpty={p.startEmpty} active={p.active&&p.available!==false} unavailableReason={kind=>generatedXtbAnalysisReason(p.document.wavefunction?.source.generatedXtb,kind,{analysisRevision:metadata?.sourceRevision,structureAvailable:view.structure.atoms.length>0})??(p.available===false?'当前结构已修改或阶段正在读取。':kind==='trajectory'&&result.frames.length<2&&!p.canReturnToTrajectory&&!p.allowedPages?'当前来源只有一个结构帧。':undefined)} onActive={id=>setActiveSelection({source:sourceIdentity,id})} onActivate={()=>p.onActivate?.()} onRequest={p.onAnalysisRequest} onError={p.onError} render={(instance,active)=><AnalysisPanelInstance id={instance.id} kind={instance.kind} document={p.document} structure={view.structure} currentIndex={currentIndex} onColorbarLayoutReady={setter=>{if(setter)colorbarLayoutPorts.current.set(instance.id,setter);else colorbarLayoutPorts.current.delete(instance.id);}}
   surfaceControls={instance.kind==='surface'?<SurfaceAnalysisInstance analysisId={instance.id} context={surfaceContext} document={p.document} structure={view.structure} modelDocument={document} wavefunctionAvailable={frameProjection.wavefunctionAvailable} electronicSurfaceAllowed={electronicSurfaceAllowed} electronicSurfaceMethods={electronicSurfaceMethods} active={active} available={p.available} capturePort={capture.selectionPort} onProjection={value=>receiveSurface(instance.id,value)} onHirshfeldProjection={value=>receiveHirshfeld(instance.id,value)} onSurfaceFamilyChange={family=>setSurfaceFamilies(previous=>previous[instance.id]===family?previous:{...previous,[instance.id]:family})} onOpenHirshfeldFingerprint={openHirshfeldFingerprint}
     onHirshfeldColorbarLayoutReady={setter=>{if(setter)hirshfeldLayouts.current.set(instance.id,setter);else hirshfeldLayouts.current.delete(instance.id);}}
     onHirshfeldMeshObserverReady={observer=>{if(observer)hirshfeldMeshes.current.set(instance.id,observer);else hirshfeldMeshes.current.delete(instance.id);}}
     onInteractionReady={port=>{if(port)surfaceInteractions.current.set(instance.id,port);else surfaceInteractions.current.delete(instance.id);}} onExportImage={()=>void exportImage()} onError={p.onError}/>:undefined}
   interactionControls={instance.kind==='interaction'?<InteractionAnalysisInstance analysisId={instance.id} context={surfaceContext} document={p.document} structure={view.structure} modelDocument={document} wavefunctionAvailable={frameProjection.wavefunctionAvailable} active={active} available={p.available} capturePort={capture.selectionPort} onProjection={value=>receiveInteraction(instance.id,value)} onInteractionReady={port=>{if(port)interactionPorts.current.set(instance.id,port);else interactionPorts.current.delete(instance.id);}} onMeshObserverReady={interactionMeshes.current.binding(instance.id)} onOpenScatter={openScatter} onExportImage={()=>void exportImage()} onError={p.onError}/>:undefined}
   excitationControls={instance.kind==='excited'?(decimals,onDecimalsChange)=><ExcitationAnalysisInstance analysisId={instance.id} context={surfaceContext} document={p.document} structure={view.structure} modelDocument={document} currentIndex={currentIndex} wavefunctionAvailable={frameProjection.wavefunctionAvailable} active={active} available={p.available} decimals={decimals} onDecimalsChange={onDecimalsChange} onProjection={value=>receiveExcitation(instance.id,value)} onMeshObserverReady={excitationMeshes.current.binding(instance.id)} onExportImage={()=>void exportImage()} onError={p.onError}/>:undefined}
   reactivityControls={instance.kind==='reactivity'?<ReactivityAnalysisInstance analysisId={instance.id} context={surfaceContext} document={p.document} structure={view.structure} modelDocument={document} wavefunctionAvailable={frameProjection.wavefunctionAvailable} active={active} available={p.available} onProjection={value=>receiveReactivity(instance.id,value)} onInteractionReady={port=>{if(port)reactivityPorts.current.set(instance.id,port);else reactivityPorts.current.delete(instance.id);}} onExportImage={()=>void exportImage()} onError={p.onError}/>:undefined}
   trajectoryControls={result.frames.length>1||p.allowedPages?.includes('trajectory')?<TrajectoryAnalysisControls result={result} currentIndex={currentIndex} structure={view.structure} active={active} extension={p.trajectoryExtension} capturePort={capture.selectionPort} onCoordinateAnnotations={coordinateAnnotationCallback(instance.id)} onSeek={userSeek} onPause={userPause} onError={p.onError}/>:undefined} active={active} available={p.available} onProjection={receiveProjection} onDispose={disposeProjection} onError={p.onError} onOpenPlot={p.onOpenPlot} onExport={()=>void exportImage()} onExtractStructure={p.onExtract} onExportGif={exportGif}/>}/>;
 return <section className="postprocess-result-view" data-testid="postprocess-result-view" data-result-id={result.id} data-frame-index={currentIndex} data-wavefunction-available={frameProjection.wavefunctionAvailable} data-active-analysis-instance={activeId??''}>
  {!p.onToolbarSurfaceChange&&p.toolbarHost&&p.selected?createPortal(toolbar,p.toolbarHost):null}<input hidden ref={fileInput} type="file" multiple aria-label="后处理视口导入文件" onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';if(files.length)void p.onImportFiles?.(files).catch(error=>p.onError(error instanceof Error?error.message:String(error)));}}/>
  {p.toolHost?createPortal(controls,p.toolHost):null}
  {scatterPlots.length>0&&p.toolHost?createPortal(<ProjectUiScope scope={['postprocess-scatter-plots',plotWindowsKey]}><PostprocessPlotDeck snapshots={scatterPlots} active={p.active&&p.available!==false} onClose={id=>{setScatterPlots(previous=>previous.filter(plot=>plot.id!==id));notifyAnalysisProjectStateChanged();}}/></ProjectUiScope>,p.toolHost.ownerDocument.body):null}
  {!p.onCanvas&&<>{playbackControls}<div className="postprocess-model-canvas" ref={viewport}><CanvasClearToolbar containerRef={viewport} frozenDisabled onClearFrozen={noEdit} onClearSelection={observation.clearSelection} onClearCoordinates={observation.clearCoordinates}/><ModelViewport onCipLabelsUsed={onCipLabelsUsed} document={document} display={display} interaction={observation.interaction} active={p.active} readOnly structureLocked observationSelection observationFixedFrame observationTool="rotate" showAxes={showAxes} resetViewRequest={resetView} cameraRequest={cameraRequest} cameraView={cameraView}
   legendVisible={p.legendVisible} legendExpanded={p.legendExpanded} onLegendExpandedChange={p.onLegendExpandedChange} onLegendSurfaceChange={p.onLegendSurfaceChange?surface=>{if(p.selected)p.onLegendSurfaceChange?.(surface);}:undefined}
   measurement={displayedMeasurement} onMeasurementPick={(id,image)=>setMeasurement(value=>id?pickMeasurement(value,id,image):emptyMeasurement(value.mode))} onMeasurementBondPick={pick=>setMeasurement(value=>pickBondMeasurement(value,pick))}
   displayAtoms={vibration?shownStructure.atoms:undefined} {...surfaceViewport} multiframeDisplay={multiframe.plan} vibrationVectors={vibrationVectors} atomScalarValues={scalarValues} atomScalarColor={chargeColor} atomScalarLabels={false} orbitalLayer={orbitalLayer} ntoLayer={ntoLayer} onNtoMeshState={onNtoMeshState} dipoleVector={dipoleVector}
   resultBondValues={resultBondValues} resultBondLabels={resultBondLabels} resultBondColor={resultBondColor} resultHighlights={resultHighlights} resultColorbar={colorbar} resultColorbarOwnerKey={colorbarOwnerKey} onResultColorbarLayoutChange={changeColorbarLayout} resultAtomLabels={atomLabels}
   onViewReady={onViewReady} onHover={observation.onHover} onGestureStart={noEdit} onGestureEnd={noEdit} onSelection={observation.onSelection} onCommand={noEdit} onError={p.onError}/></div>
  <div className="postprocess-view-caption">{view.structure.atoms.length} 原子 · {view.message}</div></>}
 </section>;
}
