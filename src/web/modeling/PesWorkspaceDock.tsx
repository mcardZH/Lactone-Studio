import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {DisplaySettings} from '../../modeling/contracts';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {currentWorkbenchResult,editableNodeActiveRun,type PesController} from '../../modeling/pes/controller';
import type {PesFrame,PesGeometry,PesNode} from '../../modeling/pes/contracts';
import {pesPathRecords} from '../../modeling/pes/path-records';
import {pesFramesForPlot,pesPathTrajectory,pesResultSeries,pesSeriesForFrame,pesTrajectory,pesScanPlotGaps} from '../../modeling/pes/result-adapter';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import PostprocessResultView,{type PostprocessResultViewProps} from '../results/PostprocessResultView';
import type {AnalysisCanvas,WorkspaceSpaceOptimizationRequest} from '../results/analysis-canvas';
import {useAnalysisAtomCapture,type AnalysisCaptureTarget} from '../results/useAnalysisAtomCapture';
import PesWorkspace from '../advanced/PesWorkspace';
import {PesResultDetails} from '../advanced/PesResultDetails';
import {PesPathHistory,pesPathEnergyOverlays} from '../advanced/PesPathHistory';
import type {OptimizationEnergyDisplay,OptimizationPlotExtension} from '../results/OptimizationPlot';
import {PesSelect} from '../advanced/pes-fields';
import {InputSettingsCheckbox,InputSettingsLayout} from '../InputSettingsLayout';
import {DismissibleNotice} from '../DismissibleNotice';
import type {AnalysisSelectionIntent} from '../analysis-selection-intent';
import {pickerStructureIdentity} from '../../core/geometry-guides';
import {currentPesRegistryGeometry} from './usePesWorkspaceIntegration';
import {mergeCoordinateAnnotations,pesCoordinateAnnotations} from './coordinate-annotations';
import {pesNodeObserving} from './pes-canvas-publication';
import './pes-workspace-shell.css';

const trajectoryPages=['trajectory'] as const;
const vibrationPages=['vibrations'] as const;
const tsVibrationPages=['trajectory','vibrations'] as const;
const emptyControls=()=>{};
export interface PesWorkspaceProjection {documentId:string;canvas:AnalysisCanvas;observation:boolean}
interface Props {
  controller:PesController;entry:WorkspaceDocumentEntry;configurationHost:HTMLElement|null;resultHost:HTMLElement|null;
  activationEpoch:number;active:boolean;panelActive?:boolean;display:DisplaySettings;onDisplay(value:DisplaySettings):void;
  additionalSources?:PesGeometry[];
  onCanvas(documentId:string,value:PesWorkspaceProjection|null):void;
  onActivateNode(node:PesNode):void;onEditFrame(geometry:PesGeometry):void;
  onOptimize?(geometry:PesGeometry,request:WorkspaceSpaceOptimizationRequest):Promise<void>;
  onElectronicStateChange(values:{charge:number;multiplicity:number}):void;onConstraintsChange(value:SharedModelConstraints):SharedModelConstraints|void;
  onOpenPlot(value:PostprocessPlotSnapshot):void;onError(message:string):void;
}
export default function PesWorkspaceDock(p:Props){
  const panelActive=p.panelActive??p.active;
  const optimizeHandler=useRef(p.onOptimize);optimizeHandler.current=p.onOptimize;
  const canOptimize=Boolean(p.onOptimize);
  const dispatchOptimize=useCallback((geometry:PesGeometry,request:WorkspaceSpaceOptimizationRequest)=>{
    const handler=optimizeHandler.current;
    if(!handler)return Promise.reject(Error('当前工作区无法启动优化。'));
    return handler(geometry,request);
  },[]);
  const snapshot=useSyncExternalStore(p.controller.subscribe,p.controller.getSnapshot,p.controller.getSnapshot);
  const model=p.entry.store.getSnapshot(),link=p.entry.pesGroup!;
  const group=snapshot.groups.find(row=>row.id===link.groupId);
  const node=group?.nodes.find(row=>row.id===link.nodeId);
  const activeOptimization=group&&node?editableNodeActiveRun(group,node.id):undefined;
  const ordinaryOptimizationRunning=activeOptimization?.request.operation==='opt';
  const selectedRunId=node?.selection?.runId??node?.followRunId;
  const selectedRun=group&&node&&(node.kind==='initial'||node.kind==='workbench')
    ?currentWorkbenchResult(group,node.id)??editableNodeActiveRun(group,node.id)
    :selectedRunId?group?.runs[selectedRunId]:undefined;
  // Ordinary optimization updates the editable model; it is never a trajectory page.
  const run=selectedRun?.request.operation==='opt'?undefined:selectedRun;
  const runId=run?.request.id;
  const [energyChoice,setEnergyChoice]=useState<{runId:string;display:OptimizationEnergyDisplay}|null>(null);
  const [overlayChoice,setOverlayChoice]=useState<{runId:string;ids:readonly string[]}|null>(null);
  const [pathAxis,setPathAxis]=useState<'bead'|'arc'>('bead');
  const overlays=overlayChoice&&overlayChoice.runId===runId?overlayChoice.ids:[];
  const energyDisplay=energyChoice&&energyChoice.runId===runId?energyChoice.display:{unit:'hartree' as const,relative:false,reference:'first' as const};
  const [followChoice,setFollowChoice]=useState<{runId:string;enabled:boolean}|null>(null);
  const following=followChoice&&followChoice.runId===runId?followChoice.enabled:true;
  const [seriesChoice,setSeriesChoice]=useState<{runId:string;seriesId:string}|null>(null);
  const terminal=run?.result;
  const records=useMemo(()=>run?pesPathRecords(run):[],[run?.pathRecords,terminal?.pathRecords]);
  const [pathChoice,setPathChoice]=useState<{runId:string;recordId:string;frameId?:string;epoch?:number}|null>(null);
  const explicitPathChoice=pathChoice&&pathChoice.runId===runId?pathChoice:undefined;
  const defaultRecord=useRef<{runId:string;recordId:string}|null>(null);
  if(runId&&records.length&&defaultRecord.current?.runId!==runId){const retained=records.find(record=>node?.selection?.recordId?record.id===node.selection.recordId:record.frames.some(frame=>frame.id===node?.selection?.frameId));defaultRecord.current={runId,recordId:(retained??records[0]).id};}
  const selectedRecord=records.find(record=>record.id===(explicitPathChoice?.recordId??(defaultRecord.current?.runId===runId?defaultRecord.current?.recordId:undefined)))??records[0];
  const recordRevision=useMemo(()=>selectedRecord?JSON.stringify([selectedRecord.frames,selectedRecord.connections??null]):'',[selectedRecord?.frames,selectedRecord?.connections]);
  const pathKey=runId&&selectedRecord?`${runId}:${selectedRecord.id}`:'';
  const [pathPrepared,setPathPrepared]=useState<{key:string;revision:string;frames?:readonly PesFrame[];error?:string}|null>(null),[pathRetry,setPathRetry]=useState(0);
  useEffect(()=>{
    if(!runId||!selectedRecord)return;
    const abort=new AbortController();let lease:ReturnType<PesController['acquirePathRecord']>|undefined;
    setPathPrepared({key:pathKey,revision:recordRevision});
    try{lease=p.controller.acquirePathRecord(link.groupId,runId,selectedRecord.id);void lease.prepare(abort.signal).then(frames=>{if(!abort.signal.aborted)setPathPrepared({key:pathKey,revision:recordRevision,frames});},error=>{if(!abort.signal.aborted)setPathPrepared({key:pathKey,revision:recordRevision,error:error instanceof Error?error.message:String(error)});});}
    catch(error){setPathPrepared({key:pathKey,revision:recordRevision,error:error instanceof Error?error.message:String(error)});}
    // Hiding a page is not the release boundary. This lease stays warm until
    // the user selects another round or the owning document closes.
    return()=>{abort.abort();lease?.release();};
  },[p.controller,link.groupId,runId,selectedRecord?.id,recordRevision,pathRetry]);
  const pathFrames=pathPrepared?.key===pathKey&&pathPrepared.revision===recordRevision?pathPrepared.frames:undefined;
  const pathLoading=!!selectedRecord&&!pathFrames;
  const series=useMemo(()=>run?pesResultSeries(run):[],[terminal,run?.acceptedFrames,run?.request.id,run?.status]);
  const desired=node?.selection&&run?pesSeriesForFrame(run,node.selection.frameId):undefined;
  const seriesId=seriesChoice?.runId===runId?seriesChoice?.seriesId:desired;
  const view=useMemo(()=>run?selectedRecord?pathFrames?pesPathTrajectory(run,selectedRecord,pathFrames):undefined:pesTrajectory(run,seriesId):undefined,[terminal,run?.acceptedFrames,run?.request.id,run?.status,seriesId,selectedRecord,pathFrames]);
  const resultDocument=useMemo(()=>view?{id:view.result.id,result:view.result}:null,[view]);
  const observed=pesNodeObserving(group,node);
  const preview=run?.preview;
  const raw=useMemo(()=>node?p.controller.nodeGeometry(link.groupId,node.id):undefined,[node?.geometry,node?.name,node?.selection,runId,run?.status,terminal,preview,pathFrames,p.controller,link.groupId]);
  const geometry=node?currentPesRegistryGeometry(p.entry,raw??{...node.geometry,label:node.name,source:{groupId:link.groupId,nodeId:node.id}},observed):undefined;
  const [postprocess,setPostprocess]=useState<{key:string;canvas:AnalysisCanvas}|null>(null);
  const sourceKey=view?.result.id??'';
  const [completionLanding,setCompletionLanding]=useState<{runId:string;epoch:number;frameId:string;page:'trajectory'|'vibrations';seekPending?:boolean}|null>(null);
  const previousRun=useRef<{runId:string;live:boolean;active:boolean;epoch:number}|null>(null);
  useEffect(()=>{
    if(!run){previousRun.current=null;return;}
    const before=previousRun.current,live=['starting','running','stopping'].includes(run.status);
    previousRun.current={runId:run.request.id,live,active:p.active,epoch:p.activationEpoch};
    if(!p.active||completionLanding&&completionLanding.epoch!==p.activationEpoch){setCompletionLanding(null);return;}
    if(before?.runId!==run.request.id||!before.live||live||!before.active||before.epoch!==p.activationEpoch||!run.result)return;
    if(run.request.operation==='path'||run.request.operation==='explore'&&run.request.algorithm==='se-gsm'){
      const last=records.find(record=>record.id===run.result?.lastPathRecordId)??[...records].reverse().find(record=>record.kind==='final');
      const target=last?.frames.find(frame=>frame.id===node?.selection?.frameId)??last?.frames[0];
      if(last&&target){setPathChoice({runId:run.request.id,recordId:last.id,frameId:target.id,epoch:p.activationEpoch});setCompletionLanding({runId:run.request.id,epoch:p.activationEpoch,frameId:target.id,page:'trajectory'});}
    }else if(run.request.operation==='ts'&&following){
      const target=(run.result.hessian as {frameId?:string}|undefined)?.frameId;
      if(target&&Array.isArray(run.result.frequencies)&&run.result.frequencies.length){const selected=pesSeriesForFrame(run,target);if(selected)setSeriesChoice({runId:run.request.id,seriesId:selected});setCompletionLanding({runId:run.request.id,epoch:p.activationEpoch,frameId:target,page:'vibrations',seekPending:true});}
    }
  },[run?.request.id,run?.status,run?.result,p.active,p.activationEpoch]);
  const onPostprocess=useCallback((canvas:AnalysisCanvas|null)=>{
    setPostprocess(previous=>canvas?previous?.key===sourceKey&&previous.canvas===canvas?previous:{key:sourceKey,canvas}:previous?.key===sourceKey?null:previous);
  },[sourceKey]);
  const resultCanvas=postprocess?.key===sourceKey?postprocess.canvas:undefined;
  const activeCanvas=resultCanvas?.result?.source.id===sourceKey?resultCanvas:undefined;
  const [pendingSurfaceSeek,setPendingSurfaceSeek]=useState<{sourceKey:string;frameId:string;activationEpoch:number}|null>(null);
  const seekSurfaceFrame=useCallback((frameId:string)=>{
    const player=activeCanvas?.trajectoryPlayback;
    if(!p.active||!activeCanvas?.scientificFrameReady||!player||player.state.disabled)return false;
    const preparation=player.state.preparation;
    if(preparation&&preparation.completed<preparation.total)return false;
    const sourceIndex=view?.frameIds.indexOf(frameId)??-1;
    const index=sourceIndex<0?-1:activeCanvas.result?.frames.findIndex((row,index)=>(row.sourceFrameIndex??index)===sourceIndex)??-1;
    if(index<0)return false;
    player.dispatch({action:'seek',index},'workflow');
    return true;
  },[p.active,view,activeCanvas]);
  // The shared player's environment (active/ready) is installed by its
  // passive effect. Flush a queued pick after that child effect.
  useEffect(()=>{
    if(!pendingSurfaceSeek)return;
    const current=p.active&&pendingSurfaceSeek.sourceKey===sourceKey&&pendingSurfaceSeek.activationEpoch===p.activationEpoch;
    if(!current||seekSurfaceFrame(pendingSurfaceSeek.frameId))setPendingSurfaceSeek(null);
  },[p.active,p.activationEpoch,sourceKey,seekSurfaceFrame,pendingSurfaceSeek]);
  const frameIndex=activeCanvas?.frameIndex;
  const seriesIndex=frameIndex===undefined?undefined:activeCanvas?.result?.frames[frameIndex]?.sourceFrameIndex??frameIndex;
  const visibleFrame=seriesIndex===undefined?undefined:view?.frameIds[seriesIndex];
  const newest=run&&(run.request.operation==='ts'||run.request.operation==='scan')?pesFramesForPlot(run).at(-1):undefined;
  useEffect(()=>{
    if(!p.active||!following||!run||!newest||!['starting','running','stopping'].includes(run.status)||selectedRecord)return;
    const series=pesSeriesForFrame(run,newest.id);if(series&&series!==view?.seriesId){setSeriesChoice({runId:run.request.id,seriesId:series});return;}
    if(visibleFrame!==newest.id)setPendingSurfaceSeek(seekSurfaceFrame(newest.id)?null:{sourceKey,frameId:newest.id,activationEpoch:p.activationEpoch});
  },[p.active,p.activationEpoch,following,newest?.id,run?.status,view,visibleFrame,seekSurfaceFrame]);
  useEffect(()=>{
    const choice=explicitPathChoice,target=choice?.frameId;if(!choice||!target)return;
    const consume=()=>setPathChoice(current=>current===choice?{runId:choice.runId,recordId:choice.recordId}:current);
    if(!p.active||choice.epoch!==p.activationEpoch){consume();return;}
    if(!run||!selectedRecord||!pathFrames||!view)return;
    const frame=pathFrames.find(frame=>frame.id===target);if(!frame)return;
    if(node?.selection?.frameId!==frame.id||node.selection?.recordId!==selectedRecord.id)p.controller.selectFrame(link.groupId,link.nodeId,run.request.id,frame.seriesId,frame.id,selectedRecord.id);
    if(visibleFrame!==frame.id)setPendingSurfaceSeek(seekSurfaceFrame(frame.id)?null:{sourceKey,frameId:frame.id,activationEpoch:p.activationEpoch});
    // The pending seek owns any remaining preparation wait. The choice only
    // selects a round; retaining its landing here would rewind every play step.
    consume();
  },[p.active,p.activationEpoch,runId,selectedRecord?.id,pathFrames,explicitPathChoice,view,visibleFrame,seekSurfaceFrame]);
  useEffect(()=>{
    if(!completionLanding?.seekPending||completionLanding.page!=='vibrations'||completionLanding.runId!==runId||!p.active||completionLanding.epoch!==p.activationEpoch||!view)return;
    if(visibleFrame!==completionLanding.frameId)setPendingSurfaceSeek(seekSurfaceFrame(completionLanding.frameId)?null:{sourceKey,frameId:completionLanding.frameId,activationEpoch:p.activationEpoch});
    setCompletionLanding(current=>current===completionLanding?{...current,seekPending:false}:current);
  },[completionLanding,p.active,p.activationEpoch,runId,view,visibleFrame,seekSurfaceFrame]);
  const baseStructure=activeCanvas?.staticDocument?.draft.structure??geometry?.structure??model.draft.structure;
  const capture=useAnalysisAtomCapture({ownerId:link.nodeId,purpose:'advanced-region',structure:baseStructure,documentId:model.id,revision:model.revision,
    sourceId:sourceKey||link.nodeId,sourceRevision:geometry?.source?.frameId,frameIndex:activeCanvas?.frameIndex??0,activationEpoch:p.activationEpoch,active:panelActive&&!!raw&&!pathLoading&&baseStructure.atoms.length>0,onError:p.onError});
  const [hovered,setHovered]=useState<{target:AnalysisCaptureTarget;ids:readonly string[]}|null>(null);
  const projectionStructure=capture.target?.structure??baseStructure;
  function requestSelection(intent:AnalysisSelectionIntent,target:AnalysisCaptureTarget){
    const handle=capture.requestSelection(intent,target);
    if(intent.origin==='interactive')activeCanvas?.trajectoryPlayback?.dispatch({action:'pause'});
    return handle;
  }
  const sourceGeometry=geometry&&activeCanvas?.scientificFrameReady&&activeCanvas.staticDocument&&run&&view&&visibleFrame
    ?{...geometry,structure:activeCanvas.staticDocument.draft.structure,source:{groupId:link.groupId,nodeId:link.nodeId,runId:run.request.id,seriesId:view.rawSeriesId,frameId:visibleFrame,...(selectedRecord?{recordId:selectedRecord.id}:{})}}
    :geometry;
  // Selecting a cold round already requires that round's scientific frame;
  // its temporary absence must not turn the old geometry into a raw-page source.
  const requiresResultFrame=Boolean(view||selectedRecord);
  const annotationGeometry=capture.target?.displayGeometry??(sourceGeometry&&raw?{...raw,structure:projectionStructure,source:sourceGeometry.source}:undefined);
  const annotationSourceKey=JSON.stringify([link.groupId,link.nodeId,capture.target?.contextKey,annotationGeometry?.source,activeCanvas?.frameIndex]);
  const published=useMemo(()=>{
    if(!geometry||!group)return null;
    // Empty editable initial/workbench pages stay with their real ModelStore.
    // They are not scientific observation frames and must permit the first atom.
    if(!observed&&!capture.target&&model.draft.structure.atoms.length===0)return null;
    const observation=observed||!!capture.target;
    const ids=new Set(projectionStructure.atoms.map(atom=>atom.id));
    const pesConstraints={...group.constraints,frozenAtomIds:group.constraints.frozenAtomIds.filter(id=>ids.has(id)),
      coordinates:group.constraints.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)))};
    const document=observation?{...model,draft:{...model.draft,structure:projectionStructure},coordinateObjects:model.coordinateObjects?.filter(row=>row.atomIds.every(id=>ids.has(id)))}:undefined;
    const sourceCanvas=capture.target||ordinaryOptimizationRunning?undefined:activeCanvas;
    let resultHighlights=sourceCanvas?.viewport.resultHighlights;
    if(hovered){try{
      hovered.target.assertCurrent();
      if(pickerStructureIdentity(hovered.target.structure)===pickerStructureIdentity(projectionStructure))resultHighlights={atomIds:hovered.ids.filter(id=>ids.has(id)),bondPairs:[]};
    }catch{/* A replaced source owns no highlights. */}}
    const canvas:AnalysisCanvas={...(sourceCanvas??{document,staticDocument:document??model,scientificFrameReady:ordinaryOptimizationRunning?undefined:requiresResultFrame?false:undefined,
      onViewReady:activeCanvas?.onViewReady??emptyControls,onExport:emptyControls,viewport:{},useWorkspaceImageExport:true,exportAvailable:!capture.target,exporting:false}),
      ...(capture.target?{displayOnlySourcePreview:true,controls:<output data-testid="pes-capture-source">选择来源 {capture.target.label??projectionStructure.name}</output>}:{}),
      pesConstraints,modelEditingBlocked:observation||ordinaryOptimizationRunning,
      ...(canOptimize&&!capture.target&&sourceGeometry&&(!requiresResultFrame||sourceCanvas?.scientificFrameReady)?{onOptimize:(request:WorkspaceSpaceOptimizationRequest)=>dispatchOptimize(sourceGeometry,request)}:{}),
      coordinateAnnotations:mergeCoordinateAnnotations(sourceCanvas?.coordinateAnnotations??[],
        annotationGeometry&&(capture.target||!requiresResultFrame||sourceCanvas?.scientificFrameReady)
          ?pesCoordinateAnnotations(group,annotationGeometry,annotationSourceKey):[]),
      // The result remains a protected geometry source, while a paused ready
      // frame may own display-only bond edits even during a background run.
      bondEditingBlocked:!!capture.target || (sourceCanvas?.bondEditingBlocked ?? sourceCanvas?.modelEditingBlocked ?? observation),
      viewport:{...sourceCanvas?.viewport,resultHighlights,analysisAtomCapture:capture.viewportCapture}};
    return {documentId:p.entry.id,canvas,observation};
  },[geometry?.source?.frameId,geometry?.structure,group,raw,annotationSourceKey,model,activeCanvas,projectionStructure,capture.viewportCapture,capture.target,hovered,p.entry.id,canOptimize,dispatchOptimize,observed,requiresResultFrame,ordinaryOptimizationRunning]);
  const onCanvas=p.onCanvas;
  // Use effects through the JSX owner so progress-only publications stay local.
  usePublishPesCanvas(onCanvas,p.entry.id,p.active?published:null);
  useObservedPesFrame(p.controller,link.groupId,link.nodeId,run?.request.id,view?.rawSeriesId,visibleFrame,Boolean(p.active&&activeCanvas?.scientificFrameReady),selectedRecord?.id);
  if(!group||!node||!geometry||!sourceGeometry)return null;
  const selectSeries=(id:string)=>{setCompletionLanding(null);if(runId)setSeriesChoice({runId,seriesId:id});};
  const tabs=view?.result.scientific?.vibrations?.modes.length?(run?.request.operation==='ts'?tsVibrationPages:vibrationPages):trajectoryPages;
  const landingFrame=explicitPathChoice?.frameId??node.selection?.frameId;
  const initialFrame=landingFrame&&view?view.frameIds.indexOf(landingFrame):undefined;
  const initialPage=tabs!==trajectoryPages&&(run?.request.operation==='hessian'||run?.request.operation==='ts'&&!!run.result&&following)?'vibrations':'trajectory';
  const ready=!!raw&&!pathLoading&&(!view||Boolean(activeCanvas?.scientificFrameReady));
  const stopFollowing=()=>{if(run&&(run.request.operation==='ts'||run.request.operation==='scan'))setFollowChoice({runId:run.request.id,enabled:false});setCompletionLanding(null);setPendingSurfaceSeek(null);};
  const seekFrame=(frame:PesFrame)=>{
    if(!run||!p.active)return;stopFollowing();
    const selectedSeries=pesSeriesForFrame(run,frame.id);
    if(view&&selectedSeries===view.seriesId){setPendingSurfaceSeek(seekSurfaceFrame(frame.id)?null:{sourceKey,frameId:frame.id,activationEpoch:p.activationEpoch});return;}
    activeCanvas?.trajectoryPlayback?.dispatch({action:'pause'});if(selectedSeries)setSeriesChoice({runId:run.request.id,seriesId:selectedSeries});
    p.controller.selectFrame(group.id,node.id,run.request.id,frame.seriesId,frame.id);
  };
  const viewPathRecord=(recordId:string,frameId?:string)=>{
    if(!run||!p.active)return;const record=records.find(row=>row.id===recordId);if(!record)return;
    setCompletionLanding(null);setPendingSurfaceSeek(null);activeCanvas?.trajectoryPlayback?.dispatch({action:'pause'});
    const target=frameId??(selectedRecord?.id===recordId?visibleFrame:undefined)??record.frames[0]?.id;
    setPathChoice({runId:run.request.id,recordId,frameId:target,epoch:p.activationEpoch});
  };
  const controls=<InputSettingsLayout variant="standard" className="pes-result-controls">
      {run&&(run.request.operation==='ts'||run.request.operation==='scan')&&<InputSettingsCheckbox label="跟随最新" ariaLabel="跟随最新" checked={following} onChange={enabled=>{
        setFollowChoice({runId:run.request.id,enabled});setCompletionLanding(null);setPendingSurfaceSeek(null);
        if(enabled&&newest){const target=pesSeriesForFrame(run,newest.id);if(target)setSeriesChoice({runId:run.request.id,seriesId:target});p.controller.selectFrame(group.id,node.id,run.request.id,newest.seriesId,newest.id);setPendingSurfaceSeek(seekSurfaceFrame(newest.id)?null:{sourceKey,frameId:newest.id,activationEpoch:p.activationEpoch});}
      }}/>}
      {!selectedRecord&&series.length>1&&<PesSelect label="结果集合" value={view?.seriesId??''} options={Object.fromEntries(series.map(row=>[row.id,row.label]))} onChange={selectSeries}/>}
    </InputSettingsLayout>;
  const otherScan=!!view?.seriesId.startsWith('scan-other:');
  const history=run&&records.length>0?<PesPathHistory run={run} recordId={selectedRecord?.id} frameId={visibleFrame} onView={viewPathRecord} overlays={overlays} onOverlaysChange={ids=>setOverlayChoice({runId:run.request.id,ids})}/>:undefined;
  const pathProjection=selectedRecord?pesPathEnergyOverlays([selectedRecord],[selectedRecord.id],pathAxis)[0]:undefined;
  const plot:OptimizationPlotExtension={frameIds:view?.frameIds,display:energyDisplay,onDisplayChange:display=>{if(runId)setEnergyChoice({runId,display});},
    gaps:selectedRecord?pathProjection?.points.flatMap((point,index)=>point.breakBefore?[{beforeIndex:index,x:point.x}]:[]):run&&!otherScan?pesScanPlotGaps(run):undefined,
    ...(pathProjection?{axis:{label:pathAxis==='arc'?'累计路径长度 / Å':'珠子序号',coordinates:pathProjection.points.map(point=>point.x)},
      controls:<PesSelect label="路径横轴" value={pathAxis} options={{bead:'珠子序号',arc:'累计路径长度 / Å'}} onChange={value=>setPathAxis(value as 'bead'|'arc')}/>,
      overlays:pesPathEnergyOverlays(records,overlays.filter(id=>id!==selectedRecord?.id),pathAxis),onSelectOverlay:viewPathRecord}:{}),
  };
  const navigation=completionLanding&&p.active&&completionLanding.runId===runId&&completionLanding.epoch===p.activationEpoch&&ready&&visibleFrame===completionLanding.frameId&&(completionLanding.page==='trajectory'||tabs!==trajectoryPages)
    ?{id:`${completionLanding.runId}:terminal:${completionLanding.page}`,kind:completionLanding.page}:undefined;
  return <>
    {p.configurationHost&&panelActive&&createPortal(<PesWorkspace controller={p.controller} groupId={group.id} activeNodeId={node.id} geometry={sourceGeometry}
      sourceReady={ready} captureActive={Boolean(capture.target)} additionalSources={p.additionalSources}
      onActivateNode={p.onActivateNode} selectionOwner={capture.selectionPort.owner} onRequestSelection={requestSelection}
      onSelectionHighlight={(target,ids)=>setHovered(current=>ids.length?{target,ids}:current?.target.contextKey===target.contextKey?null:current)} onElectronicStateChange={p.onElectronicStateChange} onConstraintsChange={p.onConstraintsChange} onError={p.onError}/>,p.configurationHost)}
    {p.resultHost&&createPortal(<section className="pes-result-workspace" hidden={!panelActive||ordinaryOptimizationRunning} aria-label="势能面结果" data-testid="pes-result-workspace">
      {!resultDocument&&controls}
      {!resultDocument&&run&&<PesResultDetails run={run} plots={false} frameId={node.selection?.frameId??run.preview?.id} seek={seekFrame}/>}
      {pathLoading&&<div className="pes-path-preparation" role="status">{pathPrepared?.error?<DismissibleNotice identity={pathPrepared.error}><p>{pathPrepared.error}</p><button type="button" onClick={()=>setPathRetry(value=>value+1)}>重新准备</button></DismissibleNotice>:'正在准备路径记录…'}</div>}
      {!resultDocument&&history}
      {resultDocument&&<PesSeriesPlayer key={resultDocument.id} document={resultDocument} modelDocument={model}
        active={p.active} selected={p.active} observationOnly allowedPages={tabs} initialPage={initialPage} requestedAnalysisPage={navigation} collectionFixed releasePreparedSource
        presentationOwnerId={`${p.entry.id}:${resultDocument.id}`} playbackContinuity={view?{ownerId:p.entry.id,collectionId:view.result.id,sourceGeneration:0,revision:view.revision,baseRevision:view.baseRevision,incremental:view.incremental}:undefined}
        onTrajectoryBrowseIntent={run&&(run.request.operation==='ts'||run.request.operation==='scan')?stopFollowing:undefined}
        trajectoryExtension={{controls:<>{controls}{history}{otherScan&&<p className="postprocess-note">此点单独保留，未计入收敛扫描曲线。</p>}</>,plot,details:run?<PesResultDetails run={run} plots={false} frameId={visibleFrame??node.selection?.frameId??run.preview?.id} seek={seekFrame}/>:undefined}}
        stageAdmission="defer-unattributed" geometryPreparation="empirical" initialSourceFrameIndex={typeof initialFrame==='number'&&initialFrame>=0?initialFrame:undefined}
        onCanvas={onPostprocess} display={p.display} onDisplay={p.onDisplay} onOpenPlot={p.onOpenPlot} onExtract={structure=>p.onEditFrame({...sourceGeometry,structure})} onError={p.onError}/>}
    </section>,p.resultHost)}
  </>;
}
function PesSeriesPlayer(props:Omit<PostprocessResultViewProps,'toolHost'>){
  // The keyed series owns its initial landing. Playback reports later cursor
  // changes to the controller, so feeding those back as a new landing would
  // replace the active lease and could cancel a seek in progress.
  const [landing]=useState(props.initialSourceFrameIndex);
  const [tools,setTools]=useState<HTMLDivElement|null>(null);
  return <><div ref={setTools} className="pes-series-tools"/><PostprocessResultView {...props} toolHost={tools} initialSourceFrameIndex={landing}/></>;
}
function usePublishPesCanvas(publish:Props['onCanvas'],id:string,value:PesWorkspaceProjection|null){
  useLayoutEffect(()=>{publish(id,value);},[publish,id,value]);
  useLayoutEffect(()=>()=>publish(id,null),[publish,id]);
}
function useObservedPesFrame(controller:PesController,group:string,node:string,run:string|undefined,series:string|undefined,frame:string|undefined,ready:boolean,recordId?:string){
  useLayoutEffect(()=>{if(ready&&run&&series&&frame)controller.selectFrame(group,node,run,series,frame,recordId);},[controller,group,node,run,series,frame,ready,recordId]);
}
