import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {DisplaySettings} from '../../modeling/contracts';
import type {TrajectoryResult} from '../../results/contracts';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import {projectPesConstraintDefinitions} from '../../modeling/pes/request';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {currentWorkbenchPartialTs,currentWorkbenchResult,editableNodeActiveRun,editableNodeDisplayRun,workbenchPartialTsFrame,type PesController} from '../../modeling/pes/controller';
import {projectOrdinaryOptimizationStructure} from '../../modeling/pes/ordinary-optimization-geometry';
import type {PesFrame,PesGeometry,PesNode,PesRun} from '../../modeling/pes/contracts';
import {pesSourceFfModel} from '../../modeling/pes/ff-model';
import {pesPathRecords} from '../../modeling/pes/path-records';
import {pesFramesForPlot,pesPathTrajectory,pesResultSeries,pesSeriesForFrame,pesTrajectory,pesScanPlotGaps} from '../../modeling/pes/result-adapter';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import PostprocessResultView,{type PostprocessResultViewProps} from '../results/PostprocessResultView';
import type {AnalysisCanvas,WorkspaceSpaceOptimizationRequest} from '../results/analysis-canvas';
import {useAnalysisAtomCapture,type AnalysisCaptureTarget} from '../results/useAnalysisAtomCapture';
import PesWorkspace from '../advanced/PesWorkspace';
import {PesResultDetails} from '../advanced/PesResultDetails';
import {PesPathHistory,pesPathEnergyOverlays} from '../advanced/PesPathHistory';
import {PesPathEnergyPlot} from '../advanced/PesPathEnergyPlot';
import type {OptimizationPlotExtension} from '../results/OptimizationPlot';
import {useProjectState,useProjectUiScope} from '../../projects/ui-state';
import {PesSelect} from '../advanced/pes-fields';
import {InputSettingsCheckbox,InputSettingsLayout} from '../InputSettingsLayout';
import {DismissibleNotice} from '../DismissibleNotice';
import type {AnalysisSelectionIntent} from '../analysis-selection-intent';
import {pickerStructureIdentity} from '../../core/geometry-guides';
import {currentPesRegistryGeometry} from './usePesWorkspaceIntegration';
import {readEditablePesSource,type PesTabSnapshotSource} from './pes-tab-snapshot';
import {mergeCoordinateAnnotations,pesCoordinateAnnotations} from './coordinate-annotations';
import {pesNodeObserving,type PesCanvasProjection} from './pes-canvas-publication';
import {initialPesPathEnergyDisplay,offerPesPathEnergyMilestones,pesPathEnergyMilestones,usesPathEnergyMilestones} from './pes-path-energy-display';
import './pes-workspace-shell.css';

const trajectoryPages=['trajectory'] as const;
const vibrationPages=['vibrations'] as const;
const trajectoryAndVibrationPages=['trajectory','vibrations'] as const;
const emptyControls=()=>{};
export type PesWorkspaceProjection = PesCanvasProjection;
interface Props {
  controller:PesController;entry:WorkspaceDocumentEntry;configurationHost:HTMLElement|null;resultHost:HTMLElement|null;
  activationEpoch:number;active:boolean;panelActive?:boolean;display:DisplaySettings;onDisplay(value:DisplaySettings):void;
  additionalSources?:readonly PesTabSnapshotSource[];
  onCanvas(documentId:string,value:PesWorkspaceProjection|null):void;
  onActivateNode(node:PesNode):void;onEditFrame(geometry:PesGeometry):void;
  onOptimize?(geometry:PesGeometry,request:WorkspaceSpaceOptimizationRequest):Promise<PesRun|void>;
  onConstraintsChange(value:SharedModelConstraints):SharedModelConstraints|void;
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
  const model=p.entry.store.getSnapshot(),link=p.entry.pesGroup!;
  const readGroup=useCallback(()=>p.controller.getSnapshot().groups.find(row=>row.id===link.groupId),[p.controller,link.groupId]);
  const group=useSyncExternalStore(p.controller.subscribe,readGroup,readGroup);
  const node=group?.nodes.find(row=>row.id===link.nodeId);
  const activeOptimization=group&&node?editableNodeActiveRun(group,node.id):undefined;
  const ordinaryOptimizationRunning=activeOptimization?.request.operation==='opt';
  const latestOptimization=group&&node&&(node.kind==='initial'||node.kind==='workbench')
    ? [...node.runIds].reverse().map(id=>group.runs[id]).find(run=>run?.request.operation==='opt')
    : undefined;
  const optFrame = ordinaryOptimizationRunning ? activeOptimization.preview : undefined;
  const selectedRunId=node?.selection?.runId??node?.followRunId;
  const [requestedPathRun,setRequestedPathRun]=useState<{runId:string;baseRunId?:string;epoch:number}|null>(null);
  const pathIntent=useRef(0);
  const recordSelector=useRef<AnalysisCanvas['selectPesRecord']>(undefined);
  const selectPesRecord=useCallback<NonNullable<AnalysisCanvas['selectPesRecord']>>(origin=>recordSelector.current?.(origin),[]);
  const workbenchSuccess=group&&node?currentWorkbenchResult(group,node.id):undefined;
  const workbenchPartial=group&&node?currentWorkbenchPartialTs(group,node.id):undefined;
  const selectedRun=group&&node&&(node.kind==='initial'||node.kind==='workbench')
    ?editableNodeDisplayRun(group,node.id)
    :selectedRunId?group?.runs[selectedRunId]:undefined;
  // Explicitly retained OPT runs use the same player as other PES results.
  const requestedRun=p.active&&requestedPathRun?.epoch===p.activationEpoch&&requestedPathRun.baseRunId===selectedRunId
    ?group?.runs[requestedPathRun.runId]:undefined;
  useLayoutEffect(()=>{
    if(requestedPathRun&&(!p.active||requestedPathRun.epoch!==p.activationEpoch||requestedPathRun.baseRunId!==selectedRunId))
      setRequestedPathRun(null);
  },[requestedPathRun,p.active,p.activationEpoch,selectedRunId]);
  const visibleRun=requestedRun??selectedRun;
  const run=visibleRun?.request.operation==='opt'&&(!visibleRun.retainTrajectory||!visibleRun.result)?undefined:visibleRun;
  const runId=run?.request.id;
  const [overlays,setOverlays]=useProjectState<readonly string[]>('pes.path.overlays',[],runId);
  const [followChoice,setFollowChoice]=useState<{runId:string;enabled:boolean}|null>(null);
  const following=followChoice&&followChoice.runId===runId?followChoice.enabled:true;
  const [seriesChoice,setSeriesChoice]=useState<{runId:string;seriesId:string}|null>(null);
  const terminal=run?.result;
  const records=useMemo(()=>run?pesPathRecords(run):[],[run?.pathRecords,terminal?.pathRecords]);
  const dedicatedPathEnergy=usesPathEnergyMilestones(run?.request);
  const projectUi=useProjectUiScope();
  const [pathEnergy,setPathEnergy]=useProjectState('pes.path.energy-display',initialPesPathEnergyDisplay,runId);
  const milestoneIds=useMemo(()=>pesPathEnergyMilestones(run,records),[run,records]);
  useEffect(()=>{
    if(p.active&&panelActive&&milestoneIds.length)setPathEnergy(current=>offerPesPathEnergyMilestones(current,milestoneIds));
  },[p.active,panelActive,milestoneIds,pathEnergy.drawn,setPathEnergy]);
  const notePathEnergyDrawn=useCallback((recordId:string)=>{
    setPathEnergy(current=>current.drawn.includes(recordId)?current:{...current,drawn:[...current.drawn,recordId]});
  },[setPathEnergy]);
  const [pathChoice,setPathChoice]=useState<{runId:string;recordId:string;frameId?:string;epoch?:number}|null>(null);
  const explicitPathChoice=pathChoice&&pathChoice.runId===runId?pathChoice:undefined;
  const defaultRecord=useRef<{runId:string;recordId:string}|null>(null);
  if(runId&&records.length&&defaultRecord.current?.runId!==runId){const retained=records.find(record=>node?.selection?.recordId?record.id===node.selection.recordId:record.frames.some(frame=>frame.id===node?.selection?.frameId));defaultRecord.current={runId,recordId:(retained??records[0]).id};}
  const selectedRecord=records.find(record=>record.id===(explicitPathChoice?.recordId??(defaultRecord.current?.runId===runId?defaultRecord.current?.recordId:undefined)))??records[0];
  const recordRevision=useMemo(()=>selectedRecord?JSON.stringify([selectedRecord.frames,selectedRecord.connections??null]):'',[selectedRecord?.frames,selectedRecord?.connections]);
  const pathKey=runId&&selectedRecord?`${runId}:${selectedRecord.id}`:'';
  const [pathAxis,setPathAxis]=useProjectState<'bead'|'arc'>('pes.path.axis','bead',runId);
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
  const selectedFrameId=node?.selection?.frameId;
  const desired=useMemo(()=>selectedFrameId&&run?pesSeriesForFrame(run,selectedFrameId):undefined,[run,selectedFrameId]);
  const seriesId=seriesChoice?.runId===runId?seriesChoice?.seriesId:desired;
  const view=useMemo(()=>run?selectedRecord?pathFrames?pesPathTrajectory(run,selectedRecord,pathFrames):undefined:pesTrajectory(run,seriesId):undefined,[terminal,run?.acceptedFrames,run?.request.id,run?.status,seriesId,selectedRecord,pathFrames]);
  const resultDocument=useMemo(()=>view?{id:view.result.id,result:view.result}:null,[view]);
  const observed=pesNodeObserving(group,node);
  const preview=run?.preview;
  const raw=useMemo(()=>node?p.controller.nodeGeometry(link.groupId,node.id):undefined,[node?.geometry,node?.name,node?.selection,runId,run?.status,terminal,preview,pathFrames,p.controller,link.groupId]);
  const geometry=useMemo(()=>node?currentPesRegistryGeometry(p.entry,raw??{...node.geometry,label:node.name,source:{groupId:link.groupId,nodeId:node.id}},observed):undefined,
    [node?.geometry,node?.name,node?.id,link.groupId,p.entry,model,raw,observed]);
  const [postprocess,setPostprocess]=useState<{key:string;canvas:AnalysisCanvas}|null>(null);
  const sourceKey=view?.result.id??'';
  const [completionLanding,setCompletionLanding]=useState<{runId:string;epoch:number;frameId:string;page:'trajectory'|'vibrations';seekPending?:boolean}|null>(null);
  const previousRun=useRef<{runId:string;live:boolean;active:boolean;epoch:number}|null>(null);
  useEffect(()=>{
    if(!run){previousRun.current=null;return;}
    const before=previousRun.current,live=['starting','running','stopping'].includes(run.status);
    previousRun.current={runId:run.request.id,live,active:p.active,epoch:p.activationEpoch};
    if(!p.active||completionLanding&&completionLanding.epoch!==p.activationEpoch){setCompletionLanding(null);return;}
    if(!before||before.runId!==run.request.id||!before.live||live||!before.active||before.epoch!==p.activationEpoch||!run.result)return;
    if(run.request.operation==='path'&&!dedicatedPathEnergy||run.request.operation==='explore'&&run.request.algorithm==='se-gsm'){
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
  const latestCanvas=useRef(activeCanvas);latestCanvas.current=activeCanvas;
  const [pendingSurfaceSeek,setPendingSurfaceSeek]=useState<{sourceKey:string;frameId:string;activationEpoch:number}|null>(null);
  const seekSurfaceFrame=useCallback((frameId:string)=>{
    const activeCanvas=latestCanvas.current;
    const player=activeCanvas?.trajectoryPlayback;
    if(!p.active||!run||!player||(player.state.seekDisabled??player.state.disabled))return false;
    const index=activeCanvas.result?.frames.findIndex(row=>{
      const origin=row.pesOrigin;
      return origin?.runId===run.request.runIdentity.runId&&origin.recordId===selectedRecord?.id&&origin.frameId===frameId;
    })??-1;
    if(index<0)return false;
    player.dispatch({action:'seek',index},'workflow');
    return true;
  },[p.active,run?.request.runIdentity.runId,selectedRecord?.id]);
  // The shared player's environment (active/ready) is installed by its
  // passive effect. Flush a queued pick after that child effect.
  useEffect(()=>{
    if(!pendingSurfaceSeek)return;
    const current=p.active&&pendingSurfaceSeek.sourceKey===sourceKey&&pendingSurfaceSeek.activationEpoch===p.activationEpoch;
    if(!current||seekSurfaceFrame(pendingSurfaceSeek.frameId))setPendingSurfaceSeek(null);
  },[p.active,p.activationEpoch,sourceKey,activeCanvas?.result,activeCanvas?.scientificFrameReady,activeCanvas?.trajectoryPlayback?.state.disabled,activeCanvas?.trajectoryPlayback?.state.seekDisabled,seekSurfaceFrame,pendingSurfaceSeek]);
  const playbackFrameSource=useCallback((result:TrajectoryResult,index:number)=>{
    if(!view||!run||result.source.id!==view.result.source.id)return;
    const summary=result.frames[index],origin=summary?.pesOrigin;
    const nativeFrame=view.result.frames[summary?.sourceFrameIndex??index]?.pesOrigin;
    if(!origin||origin.groupId!==link.groupId||origin.nodeId!==link.nodeId||origin.runId!==run.request.runIdentity.runId
      ||origin.taskId!==run.request.runIdentity.taskId||origin.recordId!==selectedRecord?.id
      ||nativeFrame?.frameId!==origin.frameId||nativeFrame.seriesId!==origin.seriesId)return;
    return {groupId:link.groupId,nodeId:link.nodeId,runId:run.request.id,seriesId:origin.seriesId,frameId:origin.frameId,recordId:origin.recordId};
  },[view,run,link.groupId,link.nodeId,selectedRecord?.id]);
  const readSubmittedFrame=useCallback((includeDisplayPosition=false)=>{
    if(!p.active||ordinaryOptimizationRunning||!geometry||!group||!view||!run)return;
    const submitted=activeCanvas?.readSubmittedScientificFrame?.();
    if(!submitted)return;
    // Playback owns collection readiness and the submitted scene. PES owns
    // publication compatibility, the run and the native frame identity.
    const revision=submitted.publicationRevision;
    if(revision!==view.revision&&(!view.incremental||revision!==view.baseRevision))return;
    const source=playbackFrameSource(submitted.result,submitted.index);
    if(!source)return;
    return {...geometry,structure:submitted.structure,source,ffModel:pesSourceFfModel(group,{...run.source,source}),
      ...(includeDisplayPosition?{label:`${geometry.label??geometry.structure.name} · 第 ${submitted.index+1} 帧`}:{})};
  },[p.active,ordinaryOptimizationRunning,geometry,group,view,run,activeCanvas,playbackFrameSource]);
  const submittedGeometry=readSubmittedFrame();
  const visibleFrame=submittedGeometry?.source.frameId;
  const submittedIndex=visibleFrame===undefined?undefined:activeCanvas?.readSubmittedScientificFrame?.()?.index;
  const latestVisibleFrame=useRef(visibleFrame);latestVisibleFrame.current=visibleFrame;
  const newest=run&&(run.request.operation==='ts'||run.request.operation==='scan')?pesFramesForPlot(run).at(-1):undefined;
  const livePreviewSourceFrameIndex=p.active&&following&&newest&&view&&!selectedRecord&&run&&['starting','running','stopping'].includes(run.status)
    ?view.frameIds.indexOf(newest.id):-1;
  useEffect(()=>{
    if(!p.active||!following||!run||!newest||!['starting','running','stopping'].includes(run.status)||selectedRecord)return;
    const series=pesSeriesForFrame(run,newest.id);if(series&&series!==view?.seriesId){setSeriesChoice({runId:run.request.id,seriesId:series});return;}
  },[p.active,following,newest?.id,run?.status,view,selectedRecord]);
  useEffect(()=>{
    const choice=explicitPathChoice,target=choice?.frameId;if(!choice||!target)return;
    const consume=()=>setPathChoice(current=>current===choice?{runId:choice.runId,recordId:choice.recordId}:current);
    if(!p.active||choice.epoch!==p.activationEpoch){consume();return;}
    if(!run||!selectedRecord||!pathFrames||!view)return;
    const frame=pathFrames.find(frame=>frame.id===target);if(!frame)return;
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
  const optRequest=p.active&&ordinaryOptimizationRunning?activeOptimization.request:undefined;
  const optPreview=useMemo(()=>optRequest?projectOrdinaryOptimizationStructure(optRequest,optFrame):undefined,[optRequest,optFrame]);
  const baseStructure=ordinaryOptimizationRunning ? optPreview??model.draft.structure :
    activeCanvas?.staticDocument?.draft.structure??geometry?.structure??model.draft.structure;
  // The selection host owns the page. Each target validates its own source;
  // an independent card slot remains usable while a result round prepares.
  const capture=useAnalysisAtomCapture({ownerId:link.nodeId,purpose:'advanced-region',structure:model.draft.structure,documentId:model.id,revision:model.revision,
    sourceId:link.nodeId,frameIndex:0,activationEpoch:p.activationEpoch,active:panelActive&&!!node,onError:p.onError});
  const [hovered,setHovered]=useState<{target:AnalysisCaptureTarget;ids:readonly string[]}|null>(null);
  const projectionStructure=capture.target?.structure??baseStructure;
  function requestSelection(intent:AnalysisSelectionIntent,target:AnalysisCaptureTarget){
    const handle=capture.requestSelection(intent,target);
    if(intent.origin==='interactive')activeCanvas?.trajectoryPlayback?.dispatch({action:'pause'});
    return handle;
  }
  // A result awaiting presentation cannot fall back to a controller preview.
  const requiresResultFrame=Boolean(view||selectedRecord||run&&observed||node?.kind==='result');
  const readSourceGeometry=useCallback(()=>requiresResultFrame?readSubmittedFrame():geometry,[requiresResultFrame,readSubmittedFrame,geometry]);
  const readCurrentSnapshot=useCallback(()=>{
    if(requiresResultFrame)return readSubmittedFrame();
    if(!node)return;
    const source={...node.geometry,label:p.entry.label};
    return node.kind==='snapshot'?{...source,documentId:p.entry.id,revision:p.entry.store.getSnapshot().revision}:readEditablePesSource(p.entry,source);
  },[node,p.entry,readSubmittedFrame,requiresResultFrame]);
  const readScanGeometry=useCallback(()=>{
    if(!p.active||!geometry||p.entry.store.hasTransaction?.())return;
    if(ordinaryOptimizationRunning&&optPreview){
      return {...geometry,structure:optPreview,source:{groupId:link.groupId,nodeId:link.nodeId,runId:activeOptimization.request.id,
        ...(optFrame?{seriesId:optFrame.seriesId,frameId:optFrame.id}:{})}};
    }
    if(!requiresResultFrame)return currentPesRegistryGeometry(p.entry,geometry,observed);
    return readSubmittedFrame(true);
  },[p.active,p.entry,geometry,ordinaryOptimizationRunning,activeOptimization?.request.id,optPreview,optFrame,link.groupId,link.nodeId,
    requiresResultFrame,readSubmittedFrame,observed]);
  // The current display already has the exact proposed geometry and origin.
  // Prepare its guides together with its molecules so acknowledgement does not
  // produce a second draw. Scientific actions still read the submitted frame.
  const proposedIndex=activeCanvas?.frameIndex;
  const proposedSource=p.active&&!ordinaryOptimizationRunning&&activeCanvas?.result&&proposedIndex!==undefined
    ?playbackFrameSource(activeCanvas.result,proposedIndex):undefined;
  const sourceGeometry=submittedGeometry??geometry;
  const annotationSourceGeometry=requiresResultFrame
    ?geometry&&proposedSource?{...geometry,source:proposedSource}:undefined
    :geometry;
  const annotationGeometry=capture.target?.displayGeometry??(annotationSourceGeometry&&raw?{...annotationSourceGeometry,structure:projectionStructure}:undefined);
  const annotationSourceKey=JSON.stringify([link.groupId,link.nodeId,capture.target?.contextKey,annotationGeometry?.source,activeCanvas?.frameIndex]);
  const published=useMemo(()=>{
    if(!p.active||!geometry||!group)return null;
    // Empty editable initial/workbench pages stay with their real ModelStore.
    // They are not scientific observation frames and must permit the first atom.
    if(!observed&&!capture.target&&model.draft.structure.atoms.length===0)return null;
    const observation=observed||!!capture.target;
    const ids=new Set(projectionStructure.atoms.map(atom=>atom.id));
    const pesConstraints=projectPesConstraintDefinitions(group,projectionStructure).constraints;
    const document=observation||optPreview?{...model,draft:{...model.draft,structure:projectionStructure},coordinateObjects:model.coordinateObjects?.filter(row=>row.atomIds.every(id=>ids.has(id)))}:undefined;
    const sourceCanvas=capture.target||ordinaryOptimizationRunning?undefined:activeCanvas;
    let resultHighlights=sourceCanvas?.viewport.resultHighlights;
    if(hovered){try{
      hovered.target.assertCurrent();
      if(pickerStructureIdentity(hovered.target.structure)===pickerStructureIdentity(projectionStructure))resultHighlights={atomIds:hovered.ids.filter(id=>ids.has(id)),bondPairs:[]};
    }catch{/* A replaced source owns no highlights. */}}
    const canvas:AnalysisCanvas={...(sourceCanvas??{document,staticDocument:document??model,scientificFrameReady:ordinaryOptimizationRunning?undefined:requiresResultFrame?false:undefined,
      onViewReady:activeCanvas?.onViewReady??emptyControls,onExport:emptyControls,viewport:{},useWorkspaceImageExport:true,exportAvailable:!capture.target,exporting:false}),
      ...(capture.target?{displayOnlySourcePreview:true,controls:<output data-testid="pes-capture-source">选择来源 {capture.target.label??projectionStructure.name}</output>}:{}),
      selectPesRecord,pesConstraints,modelEditingBlocked:observation||ordinaryOptimizationRunning,
      ...(ordinaryOptimizationRunning && activeOptimization ? { ordinaryOptimization: { method: activeOptimization.request.method,
        stop: () => p.controller.stop(group.id,activeOptimization.request.runIdentity.runId) } } : {}),
      ...(latestOptimization&&!ordinaryOptimizationRunning?{ordinaryOptimizationOutcome:latestOptimization}:{}),
      ...(canOptimize&&!ordinaryOptimizationRunning&&!capture.target&&(!requiresResultFrame||submittedGeometry)?{onOptimize:(request:WorkspaceSpaceOptimizationRequest)=>{
        const source=readSourceGeometry();
        if(!source)return Promise.reject(Error('当前科学帧尚未显示。'));
        if(pickerStructureIdentity(source.structure)!==pickerStructureIdentity(request.source.draft.structure))
          return Promise.reject(Error('当前科学帧已切换，请重新启动优化。'));
        return dispatchOptimize(source,request);
      }}:{}),
      coordinateAnnotations:mergeCoordinateAnnotations(sourceCanvas?.coordinateAnnotations??[],
        annotationGeometry?pesCoordinateAnnotations(group,annotationGeometry,annotationSourceKey):[]),
      // The result remains a protected geometry source, while a paused ready
      // frame may own display-only bond edits even during a background run.
      bondEditingBlocked:!!capture.target || (sourceCanvas?.bondEditingBlocked ?? sourceCanvas?.modelEditingBlocked ?? observation),
      viewport:{...sourceCanvas?.viewport,fixedCellView:projectionStructure.cell?.pbc.some(Boolean)||undefined,resultHighlights,analysisAtomCapture:capture.viewportCapture}};
    return {documentId:p.entry.id,canvas,observation,readScanGeometry:capture.target?undefined:readScanGeometry,
      ...(requiresResultFrame&&!ordinaryOptimizationRunning?{readSubmittedFrame}: {})};
  },[p.active,geometry,group,raw,annotationSourceKey,model,activeCanvas,submittedGeometry?.structure,projectionStructure,capture.viewportCapture,capture.target,hovered,p.entry.id,canOptimize,dispatchOptimize,observed,requiresResultFrame,readSourceGeometry,readSubmittedFrame,readScanGeometry,ordinaryOptimizationRunning,optPreview,activeOptimization,latestOptimization,p.controller,selectPesRecord]);
  const onCanvas=p.onCanvas;
  // Use effects through the JSX owner so progress-only publications stay local.
  usePublishPesCanvas(onCanvas,p.entry.id,published);
  const fixedReplay=Boolean(run?.result&&!['starting','running','stopping'].includes(run.status)&&activeCanvas?.trajectoryPlayback?.state.playing);
  useObservedPesFrame(p.controller,link.groupId,link.nodeId,runId,submittedGeometry?.source.seriesId,visibleFrame,p.active,Boolean(submittedGeometry),fixedReplay,selectedRecord?.id,livePreviewSourceFrameIndex>=0);
  const stopFollowing=useCallback(()=>{
    if(runId&&(run?.request.operation==='ts'||run?.request.operation==='scan'))
      setFollowChoice(current=>current?.runId===runId&&!current.enabled?current:{runId,enabled:false});
    setCompletionLanding(null);setPendingSurfaceSeek(null);
  },[runId,run?.request.operation]);
  const seekFrame=useCallback((frame:PesFrame)=>{
    if(!run||!p.active)return;stopFollowing();
    const selectedSeries=pesSeriesForFrame(run,frame.id);
    if(view&&selectedSeries===view.seriesId){setPendingSurfaceSeek(seekSurfaceFrame(frame.id)?null:{sourceKey,frameId:frame.id,activationEpoch:p.activationEpoch});return;}
    latestCanvas.current?.trajectoryPlayback?.dispatch({action:'pause'});if(selectedSeries)setSeriesChoice({runId:run.request.id,seriesId:selectedSeries});
    p.controller.selectFrame(link.groupId,link.nodeId,run.request.id,frame.seriesId,frame.id);
  },[run,p.active,p.activationEpoch,p.controller,stopFollowing,view,seekSurfaceFrame,sourceKey,link.groupId,link.nodeId]);
  const viewPathRecord=useCallback((recordId:string,frameId?:string)=>{
    if(!runId||!p.active)return;const record=records.find(row=>row.id===recordId);if(!record)return;
    pathIntent.current++;
    if(dedicatedPathEnergy)setPathEnergy(current=>current.recordId===recordId?current:{...current,recordId});
    setCompletionLanding(null);setPendingSurfaceSeek(null);latestCanvas.current?.trajectoryPlayback?.dispatch({action:'pause'});
    const target=frameId??(selectedRecord?.id===recordId?latestVisibleFrame.current:undefined)??record.frames[0]?.id;
    setPathChoice({runId,recordId,frameId:target,epoch:p.activationEpoch});
  },[runId,p.active,p.activationEpoch,records,selectedRecord?.id,dedicatedPathEnergy,setPathEnergy]);
  const pathOwner=useRef({active:p.active,epoch:p.activationEpoch,runId});
  pathOwner.current={active:p.active,epoch:p.activationEpoch,runId};
  recordSelector.current=origin=>{
    if(!p.active||!node||origin.groupId!==link.groupId||origin.nodeId!==link.nodeId||!origin.recordId)return;
    const targetRun=node.runIds.map(id=>group?.runs[id]).find(value=>value?.request.runIdentity.runId===origin.runId);
    const targetRecord=targetRun&&pesPathRecords(targetRun).find(record=>record.id===origin.recordId);
    if(!targetRun||!targetRecord?.frames.some(frame=>frame.id===origin.frameId&&frame.seriesId===origin.seriesId))return;
    const targetRunId=targetRun.request.id;
    if(targetRunId===runId)viewPathRecord(targetRecord.id,origin.frameId);
    else {
      pathIntent.current++;
      latestCanvas.current?.trajectoryPlayback?.dispatch({action:'pause'});
      setCompletionLanding(null);setPendingSurfaceSeek(null);
      setRequestedPathRun({runId:targetRunId,baseRunId:selectedRunId,epoch:p.activationEpoch});
      setPathChoice({runId:targetRunId,recordId:targetRecord.id,frameId:origin.frameId,epoch:p.activationEpoch});
    }
    const sequence=pathIntent.current,epoch=p.activationEpoch,previousRunId=runId;
    return{current:()=>pathOwner.current.active&&pathOwner.current.epoch===epoch&&pathIntent.current===sequence&&
      (pathOwner.current.runId===targetRunId||pathOwner.current.runId===previousRunId)};
  };
  const otherScan=!!view?.seriesId.startsWith('scan-other:');
  const history=useMemo(()=>panelActive&&run&&records.length>0?<PesPathHistory run={run} recordId={selectedRecord?.id} onView={viewPathRecord} overlays={overlays} onOverlaysChange={setOverlays}/>:undefined,[panelActive,run,records.length,selectedRecord?.id,viewPathRecord,overlays,setOverlays]);
  const energyRecord=dedicatedPathEnergy?(records.find(record=>record.id===pathEnergy.recordId)??selectedRecord):undefined;
  const energyPlot=panelActive&&run&&energyRecord
    ? <PesPathEnergyPlot request={run.request} record={energyRecord} records={records} overlays={overlays}
      axis={pathAxis} onAxisChange={setPathAxis} currentFrameId={visibleFrame}
      currentConvergence={submittedIndex===undefined?undefined:activeCanvas?.readSubmittedScientificFrame?.()?.result.frames[submittedIndex]?.convergence}
      projectUi={projectUi} onView={viewPathRecord} onDraw={p.active?notePathEnergyDrawn:undefined}/>
    : undefined;
  const plot=useMemo<OptimizationPlotExtension|undefined>(()=>{
    if(!panelActive||energyRecord)return;
    const pathProjection=selectedRecord?pesPathEnergyOverlays([selectedRecord],[selectedRecord.id],pathAxis)[0]:undefined;
    const ircData = run?.request.operation === 'irc' && view ? pesFramesForPlot(run) : undefined;
    const ircResult = run?.result?.irc as {kind?:string}|undefined;
    const tsIndex = run?.request.operation === 'ts' && run.result?.stationaryPoint === 'first-order-saddle' && run.result.converged === true
      ? view?.result.scientific?.vibrations?.frameIndex : undefined;
    const pathMethod = run?.request.operation === 'path' || pathProjection ? run?.request.algorithm : undefined;
    const legacyCiIds = pathMethod && !pathProjection && run
      ? new Set(pesFramesForPlot(run).filter(frame => frame.climbingImage === true).map(frame => frame.id)) : undefined;
    const markers = pathProjection?.points.flatMap((point, sourceIndex) => point.markerLabel ? [{ sourceIndex, label: point.markerLabel }] : [])
      ?? (legacyCiIds ? view?.frameIds.flatMap((id, sourceIndex) => legacyCiIds.has(id) ? [{ sourceIndex, label: 'CI' as const }] : []) : undefined)
      ?? (typeof tsIndex === 'number' ? [{ sourceIndex: tsIndex, label: 'TS' as const }] : undefined);
    return {frameIds:view?.frameIds,markers,pathMethod,
      scanPointNumbers:run?.request.operation==='scan',
      gaps:selectedRecord?pathProjection?.points.flatMap((point,index)=>point.breakBefore?[{beforeIndex:index,x:point.x}]:[]):run&&!otherScan?pesScanPlotGaps(run):undefined,
      ...(pathProjection?{axis:{label:pathAxis==='arc'?'Path Length (Å)':'Image Index',unit:pathAxis==='arc'?'Å':undefined,coordinates:pathProjection.points.map(point=>point.x)},
        controls:<PesSelect label="路径横轴" value={pathAxis} options={{bead:'珠子序号',arc:'累计路径长度 / Å'}} onChange={value=>setPathAxis(value as 'bead'|'arc')}/>,
        overlays:pesPathEnergyOverlays(records,overlays.filter(id=>id!==selectedRecord?.id),pathAxis),onSelectOverlay:viewPathRecord}:{}),
      ...(ircData && view ? {
        axis: {label: 'IRC Coordinate (Å·√amu)', unit: 'Å·√amu', coordinates: view.result.frames.map(frame=>frame.coordinate?.value??null)},
        irc: {downhill: ircResult?.kind==='downhill'||ircData.some(frame=>frame.ircDirection==='downhill'),
          exploration: ircResult?.kind==='exploration', originIsTs:ircResult?.kind==='bidirectional'},
      } : {}),
    };
  },[panelActive,energyRecord,run,view,selectedRecord,pathAxis,otherScan,setPathAxis,records,overlays,viewPathRecord]);
  if(!group||!node||!geometry||!sourceGeometry)return null;
  const selectSeries=(id:string)=>{setCompletionLanding(null);if(runId)setSeriesChoice({runId,seriesId:id});};
  // The IRC starting Hessian supplies vibration modes without replacing the path.
  const pathWithVibrations=run?.request.operation==='ts'||run?.request.operation==='irc';
  const tabs=view?.result.scientific?.vibrations?.modes.length
    ?(pathWithVibrations?trajectoryAndVibrationPages:vibrationPages)
    :trajectoryPages;
  const landingFrame=explicitPathChoice?.frameId??(node.selection?.runId===runId?node.selection?.frameId:undefined)??workbenchPartialTsFrame(run)?.id;
  const initialFrame=landingFrame&&view?view.frameIds.indexOf(landingFrame):undefined;
  const initialPage=tabs!==trajectoryPages&&(run?.request.operation==='hessian'||run?.request.operation==='ts'&&!!run.result&&following)?'vibrations':'trajectory';
  const ready=requiresResultFrame?Boolean(submittedGeometry):!!geometry;
  const resultChoice=workbenchSuccess&&workbenchPartial&&run&&<InputSettingsLayout variant="standard" className="pes-result-controls">
      <PesSelect label="计算结果" value={run.request.id}
        options={{[workbenchSuccess.request.id]:workbenchSuccess.request.operation==='hessian'?'已完成的频率分析':'已完成的 TS',
          [workbenchPartial.request.id]:'TS 几何已收敛 · 频率未完成'}}
        onChange={id=>{
          const target=id===workbenchPartial.request.id?workbenchPartial:workbenchSuccess;
          const finalId=(target.result?.hessian as {frameId?:string}|undefined)?.frameId;
          const frame=workbenchPartialTsFrame(target)??target.result?.frames.find(item=>item.id===finalId);
          if(!frame)return;
          activeCanvas?.trajectoryPlayback?.dispatch({action:'pause'});
          setCompletionLanding(null);setPendingSurfaceSeek(null);
          p.controller.selectFrame(group.id,node.id,id,frame.seriesId,frame.id);
        }}/>
    </InputSettingsLayout>;
  const controls=<InputSettingsLayout variant="standard" className="pes-result-controls">
      {workbenchPartial&&run===workbenchPartial&&<p className="postprocess-note">TS 几何已收敛，频率分析未完成。可选中所需帧，再点「计算 Hessian」。</p>}
      {run&&(run.request.operation==='ts'||run.request.operation==='scan')&&<InputSettingsCheckbox label="跟随最新" ariaLabel="跟随最新" checked={following} onChange={enabled=>{
        setFollowChoice({runId:run.request.id,enabled});setCompletionLanding(null);setPendingSurfaceSeek(null);
        if(enabled&&newest){const target=pesSeriesForFrame(run,newest.id);if(target)setSeriesChoice({runId:run.request.id,seriesId:target});}
      }}/>}
      {!selectedRecord&&run?.request.operation!=='irc'&&series.length>1&&<PesSelect label="结果集合" value={view?.seriesId??''} options={Object.fromEntries(series.map(row=>[row.id,row.label]))} onChange={selectSeries}/>}
    </InputSettingsLayout>;
  const navigation=completionLanding&&p.active&&completionLanding.runId===runId&&completionLanding.epoch===p.activationEpoch&&ready&&visibleFrame===completionLanding.frameId&&(completionLanding.page==='trajectory'||tabs!==trajectoryPages)
    ?{id:`${completionLanding.runId}:terminal:${completionLanding.page}`,kind:completionLanding.page}:undefined;
  return <>
    {p.configurationHost&&panelActive&&createPortal(<PesWorkspace controller={p.controller} groupId={group.id} activeNodeId={node.id} geometry={sourceGeometry}
      sourceReady={ready} readCurrentGeometry={readSourceGeometry} readCurrentSnapshot={readCurrentSnapshot} readCurrentScanGeometry={readScanGeometry} captureActive={Boolean(capture.target)} additionalSources={p.additionalSources}
      onActivateNode={p.onActivateNode} selectionOwner={capture.selectionPort.owner} onRequestSelection={requestSelection}
      onSelectionHighlight={(target,ids)=>setHovered(current=>ids.length?{target,ids}:current?.target.contextKey===target.contextKey?null:current)} onConstraintsChange={p.onConstraintsChange}/>,p.configurationHost)}
    {p.resultHost&&createPortal(<section className="pes-result-workspace" hidden={!panelActive||ordinaryOptimizationRunning} aria-label="势能面结果" data-testid="pes-result-workspace">
      {panelActive&&resultChoice}
      {!resultDocument&&controls}
      {!resultDocument&&panelActive&&run&&<PesResultDetails run={run} plots={false} frameId={node.selection?.frameId??run.preview?.id} seek={seekFrame}/>}
      {pathLoading&&<div className="pes-path-preparation" role="status">{pathPrepared?.error?<DismissibleNotice identity={pathPrepared.error}><p>{pathPrepared.error}</p><button type="button" onClick={()=>setPathRetry(value=>value+1)}>重新准备</button></DismissibleNotice>:'正在准备路径记录…'}</div>}
      {!resultDocument&&history}
      {!resultDocument&&energyPlot}
      {resultDocument&&<PesSeriesPlayer key={resultDocument.id} document={resultDocument} modelDocument={model}
        active={p.active} selected={p.active} observationOnly allowedPages={tabs} initialPage={initialPage} requestedAnalysisPage={navigation} collectionFixed releasePreparedSource={!run?.retainTrajectory}
        presentationOwnerId={`${p.entry.id}:${resultDocument.id}`} playbackContinuity={view?{ownerId:p.entry.id,collectionId:view.result.id,sourceGeneration:0,revision:view.revision,baseRevision:view.baseRevision,incremental:view.incremental}:undefined}
        onTrajectoryBrowseIntent={run&&(run.request.operation==='ts'||run.request.operation==='scan')?stopFollowing:undefined}
        livePreviewSourceFrameIndex={livePreviewSourceFrameIndex<0?undefined:livePreviewSourceFrameIndex}
        trajectoryExtension={panelActive?{controls:<>{controls}{history}{otherScan&&<p className="postprocess-note">此点单独保留，未计入收敛扫描曲线。</p>}</>,plot,energyPlot,details:run?<PesResultDetails run={run} plots={false} frameId={visibleFrame??node.selection?.frameId??run.preview?.id} seek={seekFrame}/>:undefined}:{energyPlot:<></>}}
        fixedCellView={run?.request.structure.cell?.pbc.some(Boolean)} stageAdmission="defer-unattributed" geometryPreparation="empirical" initialSourceFrameIndex={typeof initialFrame==='number'&&initialFrame>=0?initialFrame:undefined}
        onCanvas={onPostprocess} display={p.display} onDisplay={p.onDisplay} onOpenPlot={p.onOpenPlot} onExtract={()=>{const source=readSubmittedFrame();if(source)p.onEditFrame(source);else p.onError('当前科学帧尚未显示。');}} onError={p.onError}/>}
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
function useObservedPesFrame(controller:PesController,group:string,node:string,run:string|undefined,series:string|undefined,frame:string|undefined,active:boolean,ready:boolean,playing:boolean,recordId?:string,following=false){
  useLayoutEffect(()=>{
    if(!active||!ready||!run||!series||!frame)return;
    if(playing)controller.observePlaybackFrame(group,node,run,series,frame,recordId);
    else controller.selectFrame(group,node,run,series,frame,recordId,following);
  },[controller,group,node,run,series,frame,active,ready,playing,recordId,following]);
  useLayoutEffect(()=>{
    if(active&&run&&series)return()=>controller.settlePlaybackFrame(group,node,run,series,recordId);
  },[controller,group,node,run,series,active,recordId]);
}
