import type { AdvancedFrameSource, AdvancedFrameRef } from '../../modeling/advanced/frame-source';
import type { BaseElectronicStateValues } from '../../core/base-electronic-state';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import type { ModelDocument, ModelSelection, ModelStore } from '../../modeling/contracts';
import type { DynamicsConfig } from '../../modeling/dynamics/controller';
import type { XtbSolvation } from '../../modeling/xtb/contracts';
import type { GeometryLimits, OptimizationScope, OrdinaryOptimizer } from '../modeling/tool-session';
import { isPesNetMethod, type PesConvergencePreset, type PesFrame, type PesRequest, type PesRun, type PesRunIdentity } from '../../modeling/pes/contracts';
import { OPT_CONVERGENCE_PRESETS } from '../../modeling/pes/defaults';
import type { AnalysisCanvas } from '../results/analysis-canvas';
import type { WorkspaceSpaceOptimizationRequest } from '../results/analysis-canvas';
import { captureScientificModelDocument } from '../modeling/scientific-frame-source';
import { presentationMode, toolError, type McCall, type McpPresentationMode } from './types';

export interface ScienceOptOptions {
  method?: string;
  electronic?: BaseElectronicStateValues;
  scope?: OptimizationScope;
  optimizer?: OrdinaryOptimizer;
  convergencePreset?: PesConvergencePreset;
  convergenceLimits?: GeometryLimits;
  maxSteps?: number;
  maxSccIterations?: number;
  rebuildBonds?: boolean;
  solvation?: XtbSolvation | null;
  /** Explicit MCP request; ordinary interactive optimization keeps its fast default. */
  retainTrajectory?: boolean;
  presentation?: McpPresentationMode;
}

/** The Shell creates a real PES owner and starts the same ordinary optimizer once.
 * onRunStarted establishes its sole authoritative identity before settlement. */
export type RetainedOrdinaryOptimizationRequest = WorkspaceSpaceOptimizationRequest & {
  presentation: McpPresentationMode;
  sourceRef?: Readonly<AdvancedFrameRef>;
  sourceElectronicState?: AdvancedFrameSource['sourceElectronicState'];
  derivedFrame?: boolean;
};
export type RetainedOrdinaryOptimization = (request: RetainedOrdinaryOptimizationRequest) => Promise<PesRun | void>;

export type ScienceMdOptions = Omit<DynamicsConfig, 'solvation'> & { solvation?: XtbSolvation | null };

export interface ScienceRuntimeRun {
  kind: 'md' | 'opt';
  runId: string;
  documentId: string;
  revision: number;
  status: string;
  registered?: boolean;
  accepted?: boolean;
  launchDisposition?: 'start-acknowledged'|'start-rejected';
  source?: Readonly<AdvancedFrameRef>;
  request?: unknown;
  nativeStarted?: boolean;
  nativeBackend?: string;
  workerSettled?: boolean;
  scientificStatus?: string;
  resultAdoption?: string;
  frame?: Record<string, unknown>;
  progress?: unknown;
  diagnostics?: unknown;
}

export type ScienceOptSubmission = ScienceRuntimeRun | ({kind:'pes';request?:ReturnType<typeof pesRequestEvidence>} & PesRunIdentity);

export interface ScienceModelRuntime {
  /** Stable Store owner behind a presentation wrapper rebuilt on each read. */
  identity?: object;
  active(): boolean;
  runs(): readonly ScienceRuntimeRun[];
  startOptimization(source: AdvancedFrameSource, options: ScienceOptOptions): Promise<ScienceOptSubmission>;
  startMd(source: AdvancedFrameSource, options: ScienceMdOptions): Promise<ScienceRuntimeRun>;
  ownsActiveRun(runId: string): boolean;
  stop(runId: string): Promise<void>;
  subscribe?(notify:()=>void):()=>void;
}

export type ObservePesStart = (identity: PesRunIdentity, request: PesRequest) => void;

export interface SciencePresentationTarget {
  kind:'opt'|'md'|'advanced'|'pes';runId:string;documentId?:string;groupId?:string;taskId?:string;
  nodeId?:string;stageId?:string;operation?:string;intent?:string;
}
export interface SciencePresentation {
  presentFollow?(run:SciencePresentationTarget,mode:McpPresentationMode,call?:McCall):unknown|Promise<unknown>;
}
export async function presentScienceRun<T extends SciencePresentationTarget>(ctx:SciencePresentation,run:T,args:Record<string,unknown>,call?:McCall){
  if(!ctx.presentFollow)return run;
  const mode=presentationMode(args);
  if(mode==='background')return {...run,presentation:{mode,status:'background'}};
  if(call?.signal.aborted)return {...run,presentation:{mode,status:'cancelled'}};
  try{return {...run,presentation:await ctx.presentFollow(run,mode,call)};}
  catch(cause){return {...run,presentation:{mode,status:'unavailable',message:cause instanceof Error?cause.message:String(cause)}};}
}

export function isScienceFrameReference(ref:AdvancedFrameRef){
  return ref.sourceId!==undefined||ref.sourceRevision!==undefined||ref.outputJob!==undefined||
    ref.taskId!==undefined||ref.runId!==undefined||ref.stageId!==undefined||ref.collectionId!==undefined||
    ref.frameId!==undefined||ref.sourceFrameIndex!==undefined;
}

/** A verified working-model reference belongs to its Store even if the
 * window also has an analysis canvas. Result references still need the
 * complete scientific view and its normal calculation admission. */
export function captureScienceRuntimeSource(owner:ModelDocument,source:AdvancedFrameSource,view:{
  canvas?:AnalysisCanvas|null;
  selection:ModelSelection;
  workingModelEditable:boolean;
},explicitElectronic=false):ModelDocument {
  const {ref}=source;
  const scientific=isScienceFrameReference(ref),canvas=view.canvas;
  if(scientific&&!canvas)throw toolError('SCIENCE_FRAME_UNAVAILABLE','当前视图没有可用的科学帧。',
    {reason:'scientific-viewport-missing',source:ref,submitted:false});
  let document:ModelDocument;
  try{
    document=!scientific&&view.workingModelEditable?owner:
      captureScientificModelDocument(owner,canvas,{purpose:'calculation-source',selection:view.selection});
  }catch(cause){
    const reason=canvas?.displayOnlySourcePreview?'source-preview':(!canvas?.onOptimize&&(canvas?.result||canvas?.modelEditingBlocked))?
      'derived-calculation-unavailable':canvas?.scientificFrameReady===false?'frame-preparing':canvas?.bondEditingBlocked?
      'playback-or-vibration':'scientific-frame-unavailable';
    throw toolError('SCIENCE_FRAME_UNAVAILABLE',cause instanceof Error?cause.message:String(cause),{reason,source:ref,submitted:false});
  }
  const current=document.draft.structure,expected=source.structure;
  const original=explicitElectronic&&source.sourceElectronicState?source.sourceElectronicState:expected;
  const changedFields=[
    ...(document.id!==ref.documentId?['documentId']:[]),
    ...(document.revision!==ref.revision?['revision']:[]),
    ...(graphFingerprint({...current,charge:expected.charge,multiplicity:expected.multiplicity})!==graphFingerprint(expected)?['topology']:[]),
    ...(coordinatesFingerprint(current)!==coordinatesFingerprint(expected)?['coordinates']:[]),
    ...((current.charge??null)!==(original.charge??null)?['charge']:[]),
    ...((current.multiplicity??null)!==(original.multiplicity??null)?['multiplicity']:[]),
  ];
  if(changedFields.length)throw toolError('SCIENCE_SOURCE_CHANGED',`目标模型或显示帧已变化（${changedFields.join('、')}），本次计算没有提交。`,
    {changedFields,source:ref,actual:{documentId:document.id,revision:document.revision,charge:current.charge,multiplicity:current.multiplicity},submitted:false});
  return document;
}

export function pesRequestEvidence({ structure, parameters, ...request }: PesRequest) {
  const { product, keyframes, ...numericalParameters } = parameters;
  const net=isPesNetMethod(request.method),preset=numericalParameters.convergencePreset;
  const convergence=request.operation==='opt'?(preset==='custom'?{
    energyDifferenceHartree:numericalParameters.energyDifferenceHartree,gradientNormHartreePerBohr:numericalParameters.gradientNormHartreePerBohr,
  }:OPT_CONVERGENCE_PRESETS[preset==='medium'||preset==='tight'?preset:'loose']):undefined;
  return { ...request, atomCount: structure.atoms.length, cell: structure.cell,
    ...(request.operation==='opt'?{electronic:{charge:request.charge,multiplicity:request.uhf+1}}:{}),
    effective:{device:net?parameters.device??'gpu':'cpu',convergence,
      ...(!net&&parameters.policyVersion==='v212'?{accuracy:request.operation==='ts'||request.operation==='hessian'||request.operation==='irc'?.1:1}:{}),
      ...(net?{notApplicable:['accuracy','maxSccIterations','electronicTemperatureK']}:{} )},
    parameters: { ...numericalParameters, ...(product ? { includesProduct: true } : {}),
      ...(Array.isArray(keyframes) ? { keyframeCount: keyframes.length } : {}) } };
}

export function pesFrameEvidence({ positions, bondOrders, ...frame }: PesFrame) {
  return { ...frame, atomCount: positions.length, coordinateUnit: 'angstrom', energyUnit: 'hartree' };
}

const presentations = new WeakMap<ModelStore, Set<ScienceModelRuntime>>();
const receipts = new WeakMap<ModelStore, Map<string, ScienceRuntimeRun>>();
const listeners = new WeakMap<ModelStore, Set<()=>void>>();

export function scienceModelReceipts(store:ModelStore) {
  const runs=receipts.get(store)??new Map();
  receipts.set(store,runs);
  return runs;
}

export function subscribeScienceRuns(store:ModelStore,notify:()=>void){
  const set=listeners.get(store)??new Set();set.add(notify);listeners.set(store,set);
  return ()=>{set.delete(notify);if(!set.size)listeners.delete(store);};
}

export function notifyScienceRuns(store:ModelStore){
  for(const notify of listeners.get(store)??[])notify();
}

export function registerScienceModelRuntime(store: ModelStore, runtime: ScienceModelRuntime) {
  const ports = presentations.get(store) ?? new Set();
  ports.add(runtime);
  presentations.set(store, ports);
  return () => {
    ports.delete(runtime);
    if (!ports.size) presentations.delete(store);
  };
}

export function scienceModelRuntime(store: ModelStore): ScienceModelRuntime | undefined {
  const ports = [...(presentations.get(store) ?? [])].reverse();
  const current=ports.find(runtime => runtime.active()) ?? ports[0];
  if(!current)return;
  const owner=(runId:string)=>ports.find(runtime=>runtime.ownsActiveRun(runId))??current;
  return {...current,identity:store,runs:()=>[...scienceModelReceipts(store).values()],stop:runId=>owner(runId).stop(runId),subscribe:notify=>subscribeScienceRuns(store,notify)};
}
