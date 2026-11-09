import NumericInput from '../NumericInput';
import { useCallback, useEffect, useLayoutEffect,useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';
import {createPortal} from 'react-dom';
import type { Structure } from '../../core/types';
import { DEFAULT_DISPLAY, type DisplaySettings, type InteractionState, type MeasurementState, type ModelDocument } from '../../modeling/contracts';
import type { TrajectoryRange, TrajectoryResult } from '../../results/contracts';
import type { EnergySeries } from '../../results/energy';
import type { AtomicProperty } from '../../results/scientific-contracts';
import { displacedVibrationStructure } from '../../results/vibrations';
import { atomicScalars, traceInternalCoordinate, type CoordinateTrace } from '../../results/scientific-analysis';
import { playbackRange, trajectoryViewDocument, type PlaybackDirection, type PlaybackMode } from '../../results/playback';
import {playbackOwners,playbackScopeIdentity} from '../../results/playback-owner';
import {createPlaybackCollection,playbackCollectionRestriction,type PlaybackCollection} from '../../results/playback-collection';
import type {CenterResourcePort} from '../../results/trajectory-center';
import { useProjectUiSnapshot,useProjectUiScope } from '../../projects/ui-state';
import {PlaybackOverlayControls} from '../MultiframeDisplayControls';
import {usePostprocessMultiframe} from './usePostprocessMultiframe';
import { ResultViewBonds,prepareViewBondSnapshot, type ViewBondSnapshot } from '../../results/view-bonds';
import ModelViewport from '../modeling/ModelViewport';
import {useCurrentCipUsage,type CipViewportUsage} from '../modeling/use-cip-usage';
import StructureDisplayControls from '../modeling/StructureDisplayControls';
import { emptyMeasurement, pickMeasurement, retainMeasurement } from '../modeling/measurement-state';
import { OptimizationPlot } from './OptimizationPlot';
import TrajectoryControls from './TrajectoryControls';
import ScientificResultPanels, { type VibrationDisplay } from './ScientificResultPanels';
import CoordinatePlot from './CoordinatePlot';
import { initialScientificFrame } from './scientific-presentation';
import {pauseVibrationProjection,type VibrationAnalysisProjection,type VibrationGifRequest} from './VibrationControls';
import type {AnalysisCanvas} from './analysis-canvas';
import { signedVibrationStructure } from '../../results/spectroscopy';
import './trajectory.css';
import {trajectoryControlCallbacks,trajectoryFrameOrder,trajectoryPlaybackExport,playbackOverlayPresentation,type TrajectoryPlaybackBridge,type TrajectoryPlaybackCommand} from './trajectory-playback-bridge';
import {usePreparedTrajectory} from './usePreparedTrajectory';
import type {PreparedTrajectoryView} from '../../results/prepared-trajectory';
import {DismissibleNotice} from '../DismissibleNotice';
import {conformerPlaybackDisplay,conformerVisualTrajectory,conformerDisplayRestorationRequiresFormat5} from '../../modeling/conformers/playback-display';
import type {ConformerTrajectoryResult} from '../../modeling/conformers/trajectory';

export type TrajectoryExportFormat = 'xyz' | 'extxyz' | 'txt' | 'txt-json' | 'png' | 'gif' | 'png-sequence';
export interface TrajectoryExportRequest {
  result: TrajectoryResult; range: TrajectoryRange; fps: number; currentIndex: number;
  direction: PlaybackDirection; mode: PlaybackMode;
  format: TrajectoryExportFormat; width: number; height: number; viewportWidth: number; viewportHeight: number; cameraView: number[];
  document: ModelDocument;
  viewBonds: ViewBondSnapshot; resultKind: TrajectoryResult['kind'];
  display: DisplaySettings; showAxes: boolean; measurement: MeasurementState;
  energySeries?: EnergySeries; signal: AbortSignal;
  displayedStructure?: Structure;
  vibration?: VibrationDisplay & { frameIndex: number; baseStructure: Structure };
  vibrationGif?: { periodMs: number; durationSeconds: number };
  vibrationVectors?: readonly { atomIndex: number; vector: [number, number, number]; appearance?: import('../../results/surface-appearance-presets').VibrationVectorAppearance }[];
  atomScalarValues?: readonly { atomIndex: number; value: number }[];
  atomProperty?: AtomicProperty;
}
export interface TrajectoryWorkspaceProps {
  playbackCollection?:PlaybackCollection;centerResources?:CenterResourcePort;
  result: TrajectoryResult; active: boolean; onExtract(structure: Structure): void;
  modelDocument?:ModelDocument;available?:boolean;toolHost?:HTMLElement|null;
  /** External result tables select a frame; playback stays owned here. */
  selectedFrameIndex?:number;
  /** Playback positions -> immutable source indices; never reorder the source. */
  frameOrder?:readonly number[];
  /** Conformer result cards supply their own tools; publish only the common canvas. */
  canvasOnly?:boolean;
  onCanvas?(canvas:AnalysisCanvas|null):void;
  onCipLabelsUsed?(receipt:CipViewportUsage):void;
  onError?(message: string): void; onExport?(request: TrajectoryExportRequest): void | Promise<void>;
  onPrepareIrc?(structure: Structure): void;
  /** Raw source ordinal only; never vibration or display-aligned coordinates. */
  onScientificFrame?(value:{resultId:string;frameIndex:number}):void;
  displaySettings?: DisplaySettings;
  onDisplaySettingsChange?(display: DisplaySettings): void;
}
const interaction: InteractionState = { element: null, box: false, alt: false, gesture: 'none' };
const noEdit = () => undefined;
const DISPLAY_IDENTITY:import('../../modeling/view-superposition').ViewRigidTransform={rotation:[[1,0,0],[0,1,0],[0,0,1]],translation:[0,0,0],anchorIds:[]};
const statusLabel = { completed: '已完成', incomplete: '未完成', failed: '异常结束', unknown: '状态未知' };
interface TrajectoryUiSnapshot {
  resultId:string;
  playback:NonNullable<import('../../results/opt-playback').OptPlaybackSessionOptions['restored']>;
  localDisplay:DisplaySettings;showAxes:boolean;measurement:MeasurementState;
  exportFormat:TrajectoryExportFormat;exportSize:{width:number;height:number};
}

/** Key result lifetimes without recreating the viewport when frames advance. */
export default function TrajectoryWorkspace(props: TrajectoryWorkspaceProps) {
  if (!props.result.frames.length) return <p role="alert">此结果没有可显示的完整帧。</p>;
  return <PreparedTrajectorySession key={props.result.id} {...props}/>;
}
function PreparedTrajectorySession(props:TrajectoryWorkspaceProps){
  const [retry,setRetry]=useState(0),admission=usePreparedTrajectory(props.result,retry);
  if(admission.error)return <div role="alert"><p>{admission.error.message}</p><button onClick={()=>setRetry(value=>value+1)}>重新准备</button></div>;
  return <TrajectorySession {...props} prepared={admission.prepared}/>;
}
function TrajectorySession(props: TrajectoryWorkspaceProps & {prepared:PreparedTrajectoryView}) {
  const { result } = props,active=props.active&&props.available!==false;
  const persisted=useRef<TrajectoryUiSnapshot|undefined>(undefined);
  const saved=useProjectUiSnapshot(`trajectory.${result.id}`,()=>persisted.current);
  const restored=saved?.resultId===result.id?saved:undefined;
  const orderKey=props.frameOrder?.join(',')??'';
  const frameOrder=useMemo(()=>trajectoryFrameOrder(result.frames.length,props.frameOrder),[result.frames.length,orderKey]);
  const uiScope=useProjectUiScope();
  const collection=useMemo(()=>props.playbackCollection??createPlaybackCollection(result,{ownerId:playbackScopeIdentity(uiScope?.store??result,props.modelDocument?.id??result.id),revision:JSON.stringify([result.id,result.source.sha256??result.source.size,orderKey]),frames:frameOrder.map(index=>({frameId:(result as Partial<ConformerTrajectoryResult>).frameIds?.[index]??JSON.stringify([result.source.id,result.jobIndex,result.frames[index].sourceFrameIndex??index]),sourceFrameIndex:index,sourceResultId:result.id}))}),[props.playbackCollection,result,uiScope?.store,props.modelDocument?.id,orderKey]);
  const lease=useMemo(()=>playbackOwners.acquire(collection,result,{prepared:props.prepared,autoPreview:false,notifyPreparation:false,initialFrameIndex:props.selectedFrameIndex??initialScientificFrame(result)??0,frameOrder,restored:restored?.playback}),[result,props.prepared,collection]);
  const session=lease.session;
  const snapshot=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const {frame,playing,busy,fps,direction,mode,range,endpointPauseMs}=snapshot;
  const [initialFrameResolved,setInitialFrameResolved]=useState(false);
  const currentFrame=useRef(frame);currentFrame.current=frame;
  const playbackIndex=frameOrder.indexOf(frame.index);
  const [localError,setError]=useState(''),error=localError||snapshot.error;
  const setDirection=session.setDirection,setFps=session.setFps,setMode=session.setMode,setRange=session.setRange,setEndpointPauseMs=session.setEndpointPause;
  const [vibration, setVibrationState] = useState<VibrationDisplay | null>(null);
  const [vibrationProjection, setVibrationProjection] = useState<VibrationAnalysisProjection | null>(null);
  const setVibration = useCallback((value: SetStateAction<VibrationDisplay | null>) => { setVibrationState(value); if (value === null) setVibrationProjection(null); }, []);
  const publishVibration = useCallback((value: VibrationAnalysisProjection | null) => {
    setVibrationProjection(value); session.pause();
    const manual = value?.phase === 0 && !value.playing;
    setVibrationState(value ? { mode: value.mode, displayIndex: value.displayIndex, frameIndex: value.frameIndex,
      amplitude: manual ? Math.abs(value.manualDisplacementAngstrom) : value.amplitude,
      phase: manual ? Math.sign(value.manualDisplacementAngstrom) : value.phase, playing: false, arrows: value.arrows } : null);
  }, [session]);
  const [atomProperty, setAtomProperty] = useState<AtomicProperty | null>(null);
  const [coordinateTrace, setCoordinateTrace] = useState<CoordinateTrace | null>(null), [tracing, setTracing] = useState(false);
  const traceController = useRef<AbortController | null>(null);
  const [localDisplay, setLocalDisplay] = useState<DisplaySettings>(() => restored?.localDisplay??({ ...DEFAULT_DISPLAY, alignment: 'off', legend: false, regionHighlights: false }));
  // The workspace owns Global appearance. Frame alignment is a trajectory
  // observation policy, not a change to the owner's saved display settings.
  const baseDisplay = props.displaySettings ?? localDisplay;
  const display = useMemo<DisplaySettings>(() => ({ ...baseDisplay, alignment: 'off' }), [baseDisplay]);
  const changeDisplay = <K extends keyof DisplaySettings>(key: K, value: DisplaySettings[K]) => {
    if (props.displaySettings) props.onDisplaySettingsChange?.({ ...props.displaySettings, [key]: value });
    else setLocalDisplay(previous => ({ ...previous, [key]: value }));
  };
  const [showAxes, setShowAxes] = useState(restored?.showAxes??false), [resetView, setResetView] = useState(0);
  const [measurement, setMeasurement] = useState<MeasurementState>(() => restored?.measurement??emptyMeasurement('auto'));
  const [exportFormat, setExportFormat] = useState<TrajectoryExportFormat>(restored?.exportFormat??'xyz'), [exporting, setExporting] = useState(false), [viewReady, setViewReady] = useState(false);
  const [energySeries, setEnergySeries] = useState<EnergySeries>();
  const [exportSize, setExportSize] = useState(restored?.exportSize??{ width: 1200, height: 900 });
  persisted.current={resultId:result.id,playback:{frameIndex:initialFrameResolved?frame.index:restored?.playback.frameIndex??frame.index,frameDelayMs:snapshot.frameDelayMs,fps,direction,mode,range,endpointPauseMs},localDisplay,showAxes,measurement,exportFormat,exportSize};
  const [bondCache] = useState(() => new ResultViewBonds(result));
  const [bondEpoch, setBondEpoch] = useState(0);
  const mounted = useRef(true), activeRef = useRef(active);
  const viewport = useRef<HTMLDivElement>(null), getView = useRef<(() => number[]) | null>(null), exportController = useRef<AbortController | null>(null),rebuildController=useRef<AbortController|null>(null);
  const onError = useRef(props.onError); onError.current = props.onError; activeRef.current = active;
  const playbackDisplay=useMemo(()=>conformerPlaybackDisplay(result,frame.index,frame.structure),[result,frame.index,frame.structure]);
  const finalDisplayFrame=useCallback((index:number,structure:Structure)=>conformerPlaybackDisplay(result,index,structure).structure,[result]);
  const fixedCoreDisplay=conformerDisplayRestorationRequiresFormat5(result);
  const displacement = useMemo(() => {
    if (vibrationProjection?.sourceId === result.source.id && vibrationProjection.frameIndex === frame.index) return {
      structure: vibrationProjection.structure, vectors: vibrationProjection.arrows ? vibrationProjection.vectors.map((vector, atomIndex) => ({ atomIndex, vector: vector.map(value => value * vibrationProjection.arrowAmplitude) as [number, number, number], appearance:vibrationProjection.arrowAppearance })) : undefined, error: '',
    };
    if (!vibration || vibration.frameIndex !== frame.index) return { structure: playbackDisplay.structure, vectors: undefined, error: '' };
    try {
      const structure = displacedVibrationStructure(frame.structure, vibration.mode, vibration.amplitude, vibration.phase);
      const positive = displacedVibrationStructure(frame.structure, vibration.mode, vibration.amplitude, 1);
      const vectors = vibration.arrows ? positive.atoms.map((atom, atomIndex) => ({ atomIndex, vector: [atom.x - frame.structure.atoms[atomIndex].x, atom.y - frame.structure.atoms[atomIndex].y, atom.z - frame.structure.atoms[atomIndex].z] as [number, number, number] })) : undefined;
      return { structure, vectors, error: '' };
    } catch (cause) { return { structure: frame.structure, vectors: undefined, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [frame, vibration, vibrationProjection, result,playbackDisplay]);
  const view = useMemo(() => frame.structure.bonds!==undefined||bondCache.has(frame.structure,frame.index)?bondCache.resolve(frame.structure, frame.index):{structure:{...frame.structure,bonds:[]},source:'unavailable' as const,message:'显示连接尚未准备；当前仅显示原子。'}, [bondCache, frame.structure, frame.index, bondEpoch]);
  const viewDocument = useMemo(() => {const document=trajectoryViewDocument(result, {...view.structure,atoms:playbackDisplay.structure.atoms}, frame.index);return props.modelDocument?{...document,id:props.modelDocument.id}:document;}, [result, view, frame.index,props.modelDocument?.id,playbackDisplay.structure]);
  const staticDocument=useMemo(()=>{const document=trajectoryViewDocument(result,{...frame.structure,bonds:frame.structure.bonds??[]},frame.index);return props.modelDocument?{...document,id:props.modelDocument.id}:document;},[result,frame,props.modelDocument?.id]);
  const frameListener=useRef(props.onScientificFrame);frameListener.current=props.onScientificFrame;
  const notifiedFrame=useRef<number|undefined>(undefined);
  useEffect(()=>{if(active&&initialFrameResolved&&notifiedFrame.current!==frame.index){notifiedFrame.current=frame.index;frameListener.current?.({resultId:result.id,frameIndex:frame.index});}},[active,initialFrameResolved,result.id,frame.index]);
  const atomScalarValues = useMemo(() => atomProperty ? atomicScalars(atomProperty, frame.structure, frame.index) : undefined, [atomProperty, frame]);
  const onViewReady = useCallback((getter: (() => number[]) | null) => { getView.current = getter; setViewReady(Boolean(getter)); }, []);
  useEffect(()=>{lease.reacquire();return()=>lease.release();},[lease]);
  useEffect(()=>{session.onError=message=>onError.current?.(message);lease.setEnvironment(active&&!playbackCollectionRestriction(collection),true);},[session,lease,active,collection]);
  useEffect(()=>session.setFrameOrder(frameOrder),[session,frameOrder]);
  const firstMeasurementFrame=useRef(true);
  useEffect(()=>{if(props.prepared.get(frame.index)?.structure===frame.structure){const keepRestored=firstMeasurementFrame.current&&Boolean(restored?.measurement);setInitialFrameResolved(true);setVibration(null);setMeasurement(value=>result.kind==='collection'&&!keepRestored?emptyMeasurement(value.mode):retainMeasurement(value,frame.structure.atoms.map(atom=>atom.id!)));firstMeasurementFrame.current=false;}},[frame,busy,result.kind]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lease.release(); exportController.current?.abort(); traceController.current?.abort();rebuildController.current?.abort(); }; }, [session,lease]);
  useEffect(()=>{
    const index=props.selectedFrameIndex;
    if(!active||!initialFrameResolved||index===undefined||index===currentFrame.current.index)return;
    session.seek(index);
  },[active,props.selectedFrameIndex,session]);
  useEffect(() => { if (!active) { setVibration(null); exportController.current?.abort(); traceController.current?.abort(); } }, [active]);
  function seek(index: number) { session.seek(index); }
  function pause() { session.pause(); }
  function play() {
    if (!active || exporting) return;
    setVibration(null);
    session.play();
  }
  function step(value: PlaybackDirection) {
    session.step(value);
  }
  async function rebuildDisplayConnections(){
    pause();const controller=new AbortController();rebuildController.current?.abort();rebuildController.current=controller;const own=frame;
    try{const snapshot=await prepareViewBondSnapshot(own.structure,own.index,controller.signal);if(!controller.signal.aborted&&mounted.current&&currentFrame.current===own){bondCache.accept(snapshot,own.structure,own.index);setBondEpoch(value=>value+1);}}
    catch(error){if(!controller.signal.aborted&&mounted.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(rebuildController.current===controller)rebuildController.current=null;}
  }
  async function traceMeasurement() {
    if (!active || tracing || measurement.atomIds.length < 2 || measurement.atomIds.length > 4) return;
    pause(); const controller = new AbortController(); traceController.current?.abort(); traceController.current = controller; setTracing(true);
    const indices = measurement.atomIds.map(id => frame.structure.atoms.findIndex(atom => atom.id === id));
    try {
      const trace = await traceInternalCoordinate(result, indices.length === 2 ? 'B' : indices.length === 3 ? 'A' : 'D', indices, controller.signal);
      if (!controller.signal.aborted && activeRef.current && mounted.current && traceController.current === controller) setCoordinateTrace(trace);
    } catch (cause) { if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (traceController.current === controller) { traceController.current = null; if (mounted.current) setTracing(false); } }
  }
  async function exportResult(vibrationRequest?: VibrationGifRequest) {
    if (!props.onExport || exporting || !active) { if (vibrationRequest) throw new Error('当前无法开始振动导出。'); return; }
    pause(); const controller = new AbortController(); exportController.current = controller; setExporting(true); setError('');
    const abort = () => controller.abort();
    vibrationRequest?.signal?.addEventListener('abort', abort, { once: true });
    if (vibrationRequest?.signal?.aborted) controller.abort();
    setVibration(value => value ? { ...value, playing: false } : null);
    try {
      const format = vibrationRequest ? 'gif' : exportFormat;
      const visual = format === 'png' || format === 'gif' || format === 'png-sequence';
      if (visual && !getView.current) throw new Error('三维视口尚未就绪。');
      const bounds = viewport.current?.querySelector('.model-viewport-canvas')?.getBoundingClientRect();
      const limits = playbackRange(range, result.frames.length);
      await props.onExport({ result:await trajectoryPlaybackExport(visual?conformerVisualTrajectory(result):result,frameOrder,controller.signal), range: direction === 1 ? { ...range } : { start: limits.last, end: limits.first, stride: range.stride }, fps, currentIndex: playbackIndex, direction, mode, format,
        width: exportSize.width, height: exportSize.height,
        viewportWidth: Math.max(1, Math.round(bounds?.width ?? 800)), viewportHeight: Math.max(1, Math.round(bounds?.height ?? 600)), document: structuredClone(viewDocument),
        viewBonds: structuredClone(bondCache.snapshot(view.structure, frame.index)), resultKind: result.kind,
        cameraView: getView.current ? [...getView.current()] : [], display: structuredClone(display), showAxes,
        measurement: structuredClone(measurement), energySeries, signal: controller.signal,
        displayedStructure: vibration || visual&&playbackDisplay.aligned ? structuredClone(displacement.structure) : undefined,
        vibration: vibrationRequest ? { mode: vibrationRequest.mode, displayIndex: vibrationRequest.displayIndex, frameIndex: vibrationRequest.frameIndex, amplitude: vibrationRequest.amplitude, phase: 0, playing: false, arrows: vibration?.arrows ?? true, baseStructure: structuredClone(vibrationRequest.baseStructure) }
          : vibration ? { ...structuredClone(vibration), amplitude: format === 'gif' && vibrationProjection ? vibrationProjection.amplitude : vibration.amplitude, playing: false, frameIndex: frame.index, baseStructure: structuredClone(frame.structure) } : undefined,
        vibrationGif: vibrationRequest ? { periodMs: vibrationRequest.periodMs, durationSeconds: vibrationRequest.durationSeconds }
          : format === 'gif' && vibrationProjection ? { periodMs: vibrationProjection.periodMs, durationSeconds: vibrationProjection.gifDurationSeconds } : undefined,
        vibrationVectors: displacement.vectors, atomScalarValues, atomProperty: atomProperty ?? undefined });
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); onError.current?.(message); }
      if (vibrationRequest) throw cause;
    } finally { vibrationRequest?.signal?.removeEventListener('abort', abort); if (exportController.current === controller) exportController.current = null; if (mounted.current) setExporting(false); }
  }
  const collectionRestriction=playbackCollectionRestriction(collection);
  const summary = result.frames[frame.index], disabled = !!collectionRestriction||!active || exporting || snapshot.loading || snapshot.loadCancelled;
  const multiframe=usePostprocessMultiframe({result,prepared:props.prepared,documentId:props.modelDocument?.id??result.id,sourceRevision:collection.identity.revision,stageId:collection.identity.stageId,currentIndex:frame.index,active:active&&!vibration&&!vibrationProjection,collection,centerResources:props.centerResources,...(fixedCoreDisplay?{projectDisplayFrame:finalDisplayFrame}: {})});
  const overlayKey=JSON.stringify(playbackOverlayPresentation(multiframe));
  const overlayControls=useMemo(()=><>{fixedCoreDisplay&&<small>运行快照核心固定；参考选择不改变显示坐标。</small>}<PlaybackOverlayControls {...multiframe} disabled={disabled||!!vibration||!!vibrationProjection}/></>,[overlayKey,fixedCoreDisplay,disabled,!!vibration,!!vibrationProjection,multiframe.onToggle,multiframe.onFitAtoms,multiframe.onReference,multiframe.onReferenceIndex,multiframe.onCurrentReference,multiframe.onCancelCenter]);
  const editObservation=useRef({frame:staticDocument.draft.structure,vibration:vibrationProjection,pause});editObservation.current={frame:staticDocument.draft.structure,vibration:vibrationProjection,pause};
  const prepareModelEdit=useCallback(()=>{const own=editObservation.current;own.pause();pauseVibrationProjection(own.vibration);setVibration(value=>value?{...value,playing:false,phase:0,amplitude:0}:null);return structuredClone(own.frame);},[]);
  const playbackCommand=useRef<(command:TrajectoryPlaybackCommand)=>void>(()=>undefined);
  playbackCommand.current=command=>{
    if(!active||exporting||collectionRestriction)return;
    if(command.action==='prepare')session.prepare();else if(command.action==='cancel-preparation')session.cancelPreparation();else if(command.action==='silent-loading')session.setSilentLoading(command.value);
    else if(command.action==='play')play();else if(command.action==='pause')pause();
    else if(command.action==='seek'){if(!Number.isSafeInteger(command.index)||command.index<0||command.index>=result.frames.length)throw new Error('帧号超出范围。');seek(frameOrder[command.index]);}
    else if(command.action==='step'||command.action==='direction'){if(command.direction!==1&&command.direction!==-1)throw new Error('播放方向无效。');if(command.action==='step')step(command.direction);else setDirection(command.direction);}
    else if(command.action==='fps'){if(!Number.isFinite(command.value)||command.value<=0||!Number.isFinite(1000/command.value))throw new Error('播放速度无效。');setFps(command.value);}
    else if(command.action==='endpoint-pause'){if(!Number.isInteger(command.value)||command.value<0||command.value>10000)throw new Error('端点停顿无效。');setEndpointPauseMs(command.value);}
    else if(command.action==='mode'){if(!['once','loop','bounce'].includes(command.mode))throw new Error('播放模式无效。');setMode(command.mode);}
    else if(command.action==='range'){playbackRange(command.range,result.frames.length);pause();setRange({...command.range});}
    else if(command.action==='seek-target'){const target=collection.targets[command.kind],entry=collection.frames.find(frame=>frame.frameId===target?.frameId);if(entry?.sourceFrameIndex!==undefined)seek(entry.sourceFrameIndex);}
    else if(command.action==='overlay-toggle')multiframe.onToggle();else if(command.action==='overlay-atoms')multiframe.onFitAtoms(command.value);else if(command.action==='overlay-reference')multiframe.onReference(command.kind);else if(command.action==='overlay-reference-index')multiframe.onReferenceIndex(command.index);else if(command.action==='overlay-current-reference')multiframe.onCurrentReference();else if(command.action==='center-cancel')multiframe.onCancelCenter();
  };
  const dispatchPlayback=useCallback((command:TrajectoryPlaybackCommand)=>playbackCommand.current(command),[]);
  const trajectoryPlayback=useMemo<TrajectoryPlaybackBridge>(()=>({state:{resultId:result.id,projectionKey:frameOrder.join(','),collectionIdentity:collection.identity,frameId:collection.frames.find(entry=>entry.sourceFrameIndex===frame.index)?.frameId,targets:collection.targets,overlay:playbackOverlayPresentation({...multiframe,disabled}),count:collection.frames.length,index:collection.frames.findIndex(entry=>entry.sourceFrameIndex===frame.index),playing,busy,disabled,fps,direction,mode,range,endpointPauseMs,preparation:snapshot.preparation,loading:snapshot.loading,loadCancelled:snapshot.loadCancelled,silentLoading:snapshot.silentLoading},dispatch:dispatchPlayback}),[result.id,collection,frame.index,overlayKey,frameOrder,playbackIndex,playing,busy,disabled,fps,direction,mode,range,endpointPauseMs,snapshot.preparation,snapshot.loading,snapshot.loadCancelled,snapshot.silentLoading,dispatchPlayback]);
  const playbackControls=useMemo(()=><div className="trajectory-player-row" data-testid="trajectory-top-playback"><TrajectoryControls {...trajectoryPlayback.state} {...trajectoryControlCallbacks(dispatchPlayback)} detailsContent={overlayControls}/>{playbackDisplay.restored&&<small role="status">显示已恢复运行快照核心；能量来自原始MD。</small>}{playbackDisplay.restriction&&<small role="status">{playbackDisplay.restriction}</small>}</div>,[trajectoryPlayback,dispatchPlayback,overlayControls,playbackDisplay.restored,playbackDisplay.restriction]);
  const exportOwner=useRef(exportResult);exportOwner.current=exportResult;
  const exportCanvas=useCallback(()=>void exportOwner.current(),[]);
  const modelEditingBlocked=playing||Boolean(vibration?.playing)||Boolean(vibrationProjection?.playing);
  const onCipLabelsUsed=useCurrentCipUsage(viewDocument,active&&initialFrameResolved,props.onCipLabelsUsed);
  const canvas=useMemo<AnalysisCanvas>(()=>({document:viewDocument,staticDocument,prepareModelEdit,modelEditingBlocked,result,frameIndex:frame.index,controls:playbackControls,...(props.canvasOnly?{trajectoryPlayback}:{}),measurementOwnerKey:`${result.id}:${frame.index}`,viewport:{...(playbackDisplay.aligned?{viewTransform:DISPLAY_IDENTITY}:{}),displayAtoms:displacement.structure.atoms,vibrationVectors:displacement.vectors,atomScalarValues,multiframeDisplay:multiframe.plan},onViewReady,onExport:exportCanvas,useWorkspaceImageExport:true,exportAvailable:active&&!busy,exporting}),[viewDocument,staticDocument,prepareModelEdit,modelEditingBlocked,result,frame.index,playbackControls,props.canvasOnly,trajectoryPlayback,displacement.structure.atoms,displacement.vectors,atomScalarValues,multiframe.plan,playbackDisplay.aligned,onViewReady,exportCanvas,active,busy,exporting]);
  useLayoutEffect(()=>{props.onCanvas?.(active&&initialFrameResolved?canvas:null);},[props.onCanvas,active,initialFrameResolved,canvas]);
  const canvasOwner=useRef(props.onCanvas);canvasOwner.current=props.onCanvas;
  useEffect(()=>()=>canvasOwner.current?.(null),[]);
  const content=<section className="trajectory-workspace" data-testid="trajectory-workspace" data-result-id={result.id} data-frame-index={frame.index} data-playing={playing} aria-label={result.kind === 'collection' ? '结构集合浏览' : '只读轨迹结果'}>
    {props.available===false&&<p role="status">结构已修改，此结果暂不可用；撤销相关修改可恢复</p>}
    <header className="trajectory-heading"><strong title={result.label}>{result.label}</strong><span>{result.kind === 'collection' ? '结构集合 · 无时间对应' : result.scientific ? '计算结果' : result.kind === 'optimization' ? 'OPT结果' : '轨迹'} · {statusLabel[result.status]}</span>
      <button disabled={disabled || busy} onClick={() => { pause(); setVibration(value => value ? { ...value, playing: false } : null); props.onExtract(vibrationProjection ? signedVibrationStructure(frame.structure, vibrationProjection.mode, vibrationProjection.manualDisplacementAngstrom) : structuredClone(vibration ? displacement.structure : frame.structure)); }}>{vibration ? '提取手动位移为新模型' : '提取当前帧为新模型'}</button>
      {!props.onCanvas&&<details className="trajectory-view-options"><summary>显示</summary><div>
        <label><input type="checkbox" checked={display.atomNumbers} onChange={e => changeDisplay('atomNumbers', e.target.checked)}/>编号</label>
        <label><input type="checkbox" checked={showAxes} onChange={e => setShowAxes(e.target.checked)}/>坐标轴</label>
        <label><input type="checkbox" checked={display.cell} onChange={e => changeDisplay('cell', e.target.checked)}/>晶胞</label>
        <label><input type="checkbox" checked={display.elementNames} onChange={e => changeDisplay('elementNames', e.target.checked)}/>元素</label>
        <StructureDisplayControls display={display} representationLabel="轨迹显示样式" onChange={next => { if (props.displaySettings) props.onDisplaySettingsChange?.(next); else setLocalDisplay(next); }}/>
        <select aria-label="轨迹只读测量" value={measurement.mode ?? ''} onChange={e => setMeasurement(emptyMeasurement((e.target.value || null) as MeasurementState['mode']))}><option value="">不测量</option><option value="auto">自动 B/A/D</option><option value="distance">距离</option><option value="angle">键角</option><option value="dihedral">二面角</option></select>
        <button onClick={() => setResetView(value => value + 1)}>适合视窗</button>
        <button disabled={disabled || busy || frame.structure.bonds !== undefined} onClick={() => void rebuildDisplayConnections()}>当前帧重新识别显示键</button>
        <small>{view.message}；显示推断不改变原始数据。</small>
      </div></details>}
      {props.onExport && <><select aria-label="轨迹导出格式" value={exportFormat} disabled={exporting} onChange={e => setExportFormat(e.target.value as TrajectoryExportFormat)}><option value="xyz">XYZ</option><option value="extxyz">扩展 XYZ（晶胞）</option><option value="txt">数据 TXT</option><option value="png">当前帧 PNG</option><option value="gif">GIF 动画</option><option value="png-sequence">PNG 帧序列</option></select>
        {(exportFormat === 'png' || exportFormat === 'gif' || exportFormat === 'png-sequence') && <details className="trajectory-view-options"><summary>尺寸</summary><div>{(['width', 'height'] as const).map(key => <label key={key}>{key === 'width' ? '宽' : '高'}<NumericInput  aria-label={key === 'width' ? '导出宽度' : '导出高度'} min={1} value={exportSize[key]} disabled={exporting} onChange={e => { const value = Number(e.target.value); if (Number.isSafeInteger(value) && value >= 1) setExportSize(size => ({ ...size, [key]: value })); }}/></label>)}</div></details>}
        <button disabled={disabled || busy || ((exportFormat === 'png' || exportFormat === 'gif' || exportFormat === 'png-sequence') && !viewReady)} onClick={() => void exportResult()}>{vibration ? (exportFormat === 'gif' || exportFormat === 'png-sequence' ? '导出振动显示周期' : '导出当前位移帧') : '导出'}</button>{exporting && <button onClick={() => exportController.current?.abort()}>取消导出</button>}</>}
    </header>
    {result.messages.length > 0 && <details className="trajectory-notices"><summary>来源说明 · {result.messages.length}</summary>{result.messages.map((message, i) => <p key={i}>{message}</p>)}</details>}
    {(error || displacement.error) && <DismissibleNotice identity={`${result.id}:${error || displacement.error}`} className="trajectory-error">{error || displacement.error}</DismissibleNotice>}
    <div className="trajectory-main">{!props.onCanvas&&<div className="trajectory-viewport-column" data-testid="trajectory-viewport-column" style={{display:'flex',flexDirection:'column',flex:'1 1 auto',minWidth:0,minHeight:0}}>
      {playbackControls}
      <div className="trajectory-viewport" ref={viewport}><ModelViewport onCipLabelsUsed={onCipLabelsUsed} document={viewDocument} display={display} interaction={interaction}
      readOnly structureLocked active={active&&initialFrameResolved} observationFixedFrame observationTool="rotate" showAxes={showAxes} resetViewRequest={resetView}
      viewTransform={playbackDisplay.aligned?DISPLAY_IDENTITY:undefined} displayAtoms={displacement.structure.atoms} vibrationVectors={displacement.vectors} atomScalarValues={atomScalarValues} multiframeDisplay={multiframe.plan}
      measurement={measurement} onMeasurementPick={id => setMeasurement(value => id ? pickMeasurement(value, id) : emptyMeasurement(value.mode))}
      onViewReady={onViewReady} onHover={noEdit} onGestureStart={noEdit} onGestureEnd={noEdit} onSelection={noEdit} onCommand={noEdit} onError={props.onError}/>{vibration && <div className="trajectory-vibration-badge">模式 {vibration.mode.index} · {vibration.mode.frequency} cm⁻¹ · 只读位移</div>}</div></div>}
      {result.scientific && <ScientificResultPanels result={result} structure={frame.structure} currentIndex={frame.index} disabled={disabled || busy} onSelectFrame={seek}
        vibration={vibration} onVibration={value => { pause(); setVibration(value); }} onAtomProperty={setAtomProperty} onVibrationProjection={publishVibration} onExtractStructure={props.onExtract} onExportVibrationGif={props.onExport ? request => exportResult(request) : undefined} onError={props.onError}
        onDisplacedModel={sign => { if (!vibration || disabled) return; pause(); setVibration(value => value ? { ...value, playing: false } : null); try { props.onExtract(displacedVibrationStructure(frame.structure, vibration.mode, vibration.amplitude, sign)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}
        onPrepareIrc={props.onPrepareIrc ? () => { pause(); setVibration(null); props.onPrepareIrc?.(structuredClone(frame.structure)); } : undefined}/>}</div>
    <footer className="trajectory-footer"><div className="trajectory-frame-info"><span>{summary?.label ?? `帧 ${frame.index + 1}`}</span>{summary?.sourceStep != null && <span>步骤 {summary.sourceStep}</span>}{summary?.time && <span>时间 {summary.time.value} {summary.time.unit}</span>}{summary?.energy && <span>{vibration ? '母几何能量' : playbackDisplay.restored ? '原始MD能量' : '能量'} {summary.energy.value} {summary.energy.unit}</span>}<span>{frame.structure.atoms.length} 原子</span><span title="显示键不写入源结构、取帧结果或原始XYZ导出">{view.message}</span></div>
      {result.kind !== 'collection' && <div className="trajectory-trace-controls"><button disabled={disabled || tracing || vibration != null || measurement.atomIds.length < 2 || measurement.atomIds.length > 4} onClick={() => void traceMeasurement()}>追踪所选 B/A/D 内坐标</button>{tracing && <><span>读取来源帧…</span><button onClick={() => traceController.current?.abort()}>取消追踪</button></>}{coordinateTrace && <button onClick={() => setCoordinateTrace(null)}>关闭内坐标曲线</button>}</div>}
    </footer>
    {coordinateTrace && <CoordinatePlot trace={coordinateTrace} currentIndex={frame.index} onSelectFrame={index => { if (!disabled) seek(index); }}/>}
    {(result.kind === 'optimization' || result.scientific?.tasks.some(task => ['opt', 'ts', 'irc', 'scan'].includes(task))) && <OptimizationPlot result={result} currentIndex={frame.index} onSelectFrame={index => { if (!disabled) seek(index); }} onSeriesChange={setEnergySeries}/>}
  </section>;
  if(props.canvasOnly)return null;
  return props.onCanvas&&props.toolHost?(props.active?createPortal(content,props.toolHost):null):content;
}
