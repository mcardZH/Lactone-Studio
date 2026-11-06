import {WorkspaceColumns,WorkspaceColumnDivider,useWorkspaceColumns} from "./WorkspaceColumns";
import {Fragment,Suspense,lazy,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode,type CSSProperties} from 'react';
import {createImportResourceClosures} from './workspace-import-resources';
import {ProjectUiStore,ProjectUiScope,ProjectNativeDetailsBoundary,ProjectUiRestoreBoundary} from '../../projects/ui-state';
import {registerImportedModelSources,forgetImportedModelSources,commitImportedModelSourceBundle} from '../../projects/import-sources';
import {isTwoDImportFile,readTwoDImportFile,type TwoDImportFile} from '../../modeling/application/two-d-import';
import type {FragmentSnapshot} from '../../modeling/contracts';
import type {TwoDImportRuntime,TwoDCommitGuard} from './TwoDImportWorkspace';
import type {SubmitExternalInput} from '../../task-system/integration/input-draft';
import {openSnapshotProjectSources,snapshotBridgeCompanions} from '../../task-system/integration/snapshot-project';
import {snapshotPostprocessSources} from '../../task-system/integration/snapshot-selection';
import {bindSnapshotCompanionCandidates} from '../../task-system/integration/snapshot-companions';
import {readSnapshotGeneratedXtbPackage} from '../../task-system/integration/postprocess-xtb-source';
import {retainSnapshotPostprocessSources} from '../../task-system/integration/postprocess-source-extras';
import type {ManagedSourceOrigin} from '../../task-system/application-contracts';
import {useTaskWorkspace} from '../task-system/useTaskWorkspace';
import {confirmSynchronousOperation} from '../confirmation';
import {useProjectWorkspace} from '../../projects/use-project-workspace';
import {captureWorkspaceProject,captureWorkspaceModelSnapshots,markCapturedWorkspaceModelsApplied,decodeWorkspaceProject,type WorkspaceModelSnapshot} from '../../projects/workspace-snapshot';
import {encodeDiagnostic,decodeDiagnostic,type DiagnosticProjectSnapshot} from '../../projects/diagnostic-snapshot';
import {forgetAnalysisProjectDocument,describeAnalysisProjectDocument,subscribeAnalysisProjectState,getAnalysisProjectRevision,captureAnalysisCitationSnapshots} from '../../projects/analysis-state';
import CitationDialog from '../citations/CitationDialog';
import {appendCipUsage,appendPreparedInput,emptyCitationState,restoreCitationState,retainedCitationState,type PreparedCitationInput} from '../citations/state';
import {cipReceiptSourceMatches,collectWorkspaceCitationFacts,readCommittedTwoDCitationFacts,retainedCitationAnalysisInstances,retainedCitationOwnerIds,scientificFileCitationIdentity,type CitationFact,type CitationRegistry} from '../../citations';
import citationRegistryData from '../../citations/data/registry.json';
import type {AdvancedProjectSnapshot} from '../../projects/advanced-snapshot';
import {createPortal,flushSync} from 'react-dom';
import {Atom,FileCode2,ChartNoAxesCombined,X,Workflow,Boxes,ListChecks} from 'lucide-react';
import AdvancedModelingNavigation,{type AdvancedModelingRoute} from './AdvancedModelingNavigation';
import type {StructureTransformCandidate} from '../../core/modeling/contracts';
import AdvancedWorkspace,{buildConformerResultCollections,conformerCollectionRevision} from '../advanced/AdvancedWorkspace';
import {restoreConformerStages} from '../advanced/conformer-draft-hydration';
import {releaseMixedConformerPageCache} from '../advanced/MixedConformerWorkspace';
import {conformerInitialHasInformation} from '../advanced/conformer-initial-state';
import {advancedElectronicOwnerCurrent,validAdvancedElectronicDraft,type AdvancedElectronicState} from '../advanced/electronic-state-sync';
import AdvancedWorkflowNavigation,{type AdvancedSection,type ConformerSamplingChoice} from '../advanced/AdvancedWorkflowNavigation';
import {createConformerTrajectory,type ConformerResultCollection} from '../../modeling/conformers/trajectory';
import type {AdvancedResultFrame,AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {SamplingSphereDraft,SamplingSphereRadiusChange,SamplingSphereViewportDraft} from '../../modeling/advanced/sampling-sphere';
import XtbAnalysisWorkspace,{type XtbAnalysisTaskSelection} from '../advanced/XtbAnalysisWorkspace';
import type {AdvancedMethodDraft} from '../advanced/AdvancedMethodControls';
import {createElectronicStateDraft,electronicDraftSourceKey,electronicDraftValues,validateElectronicStateDraft,
 type ElectronicStateDraft,type ElectronicStateSourceContext,type ConfirmedElectronicSnapshot} from '../../modeling/application/electronic-state-draft';
import {advancedElectronicSourceConfirmationKey} from '../../modeling/advanced/electronic-confirmation';
import {useComputeResources} from '../useComputeResources';
import {shouldOpenInitialResourceSetup} from '../../modeling/first-run-license';
import FirstRunLicense from '../FirstRunLicense';
import {useFirstRunLicense} from '../useFirstRunLicense';
import {setPreparedTrajectoryResources,subscribePreparedTrajectoryMemory} from '../../results/prepared-trajectory';
import {AdvancedController} from '../../modeling/advanced/controller';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {captureAdvancedFrame,assertAdvancedIsolated} from '../../modeling/advanced/frame-source';
import {makeDocumentStamp} from '../../core/modeling/model-store';
import {createDesktopConformerBatchBridge} from '../../modeling/platform/conformer-batch';
import {captureWorkspaceAdvancedSource,captureWorkspaceElectronicSourceContext,electronicSourceEditingFragment,captureWorkspaceAdvancedCollection,retainedAdvancedSource,boundAdvancedCanvasResult,matchesAdvancedSourceCollection} from '../advanced/capture-source';
import {advancedFrameFragment,prepareAdvancedFrameInput} from '../advanced/advanced-frame-entry';
import {sameDisplaySource,advancedDisplayDocument,createAdvancedPlaybackCollection,type AdvancedCanvasLayers} from '../advanced/advanced-display';
import {identityTransform} from './render/alignment';
import type {AdvancedInputTemplate} from '../../modeling/application/advanced-frame-output';
import {createBatchInputSession,batchInputRepresentative,batchInputInitialConstraints,type BatchInputSession} from '../../modeling/application/batch-input-session';
import {desktopBridge} from '../../modeling/platform/desktop';
import {createAdvancedForcefieldAdapter} from '../../modeling/advanced/forcefield-adapter';
import {createWorkspaceRegistry,workspaceTrajectoryKey,type WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import type {JsonValue,WorkspaceActivationStamp,WorkspaceDesktopBridge,WorkspaceModule,WorkspaceTaskSource} from '../../modeling/workspace-contracts';
import type {DynamicsController} from '../../modeling/dynamics/controller';
import {importWorkspaceItems,type WorkspaceImportItem} from '../../results/import-workspace';
import TrajectoryWorkspace from '../results/TrajectoryWorkspace';
import PostprocessSidebar,{postprocessDocumentFileSlots} from '../results/PostprocessSidebar';
import ScientificFileResultView from '../results/ScientificFileResultView';
import {isExcitationSlot} from '../results/postprocess-excitation-slots';
import {postprocessFileDocumentVersion} from '../../projects/companion-sources';
import PostprocessManagedTaskControls from '../results/PostprocessManagedTaskControls';
import CurrentStructureAnalysisEntry, {currentStructureAnalysisActive} from '../results/CurrentStructureAnalysisEntry';
import PostprocessDisplayPanel from '../results/PostprocessDisplayPanel';
import type {AnalysisCanvas} from '../results/analysis-canvas';
import {type TrajectoryResult,type ResultDiagnostic} from '../../results/contracts';
import SourceDiagnostics from '../results/SourceDiagnostics';
import type {PostprocessDocument,PostprocessScientificFileDocument} from '../../results/postprocess-document';
import type {AnalysisAtomCapture} from './ModelViewport';
import {WorkflowSessionBar} from '../WorkflowPresentation';
import PostprocessResultView from '../results/PostprocessResultView';
import PostprocessPlotDeck from '../results/PostprocessPlotDeck';
import {usePostprocessWorkspace} from '../results/usePostprocessWorkspace';
import {assertOrbitalSourcesIdle} from '../results/useOrbitalField';
import DialogShell from '../DialogShell';
import {workspaceTabDragMoved,workspaceTabTargetContains,resolveWorkspaceTabDropIntent} from './workspace-tab-drag';
import WorkspaceTab from './WorkspaceTab';
import {useWorkspacePageValue} from './workspace-page-context';
import {workspaceSourceGeometryKey,workspaceRetainedSourceGeometryMatches} from './workspace-source-validity';
import {conformerInitialDocument,assertConformerInitialElectronicOwner} from './workspace-conformer-initial-owner';
import {workspaceOwnerCallbackCurrent} from './workspace-owner-lifetime';
import {createConformerPlaybackResolver,projectConformerPlaybackCollection} from '../advanced/conformer-playback';
import {captureConformerFrameOrder,conformerPlaybackOrder,type ConformerFrameOrder} from './workspace-conformer-order';
import {createConformerCollectionPublisher,conformerCollectionSourcesCurrent,conformerCollectionMatchesCurrent,createAdvancedHydrationProjectionBaseline,conformerPlaybackFrameIndex,conformerTrajectoryObservedSource,prepareConformerPublication,restoredConformerPublicationResult} from './workspace-conformer-publication';
import {previewImportDescription,postprocessDocumentEngine,postprocessDocumentTask} from '../results/postprocess-import-policy';
import {postprocessDifferences,disposePostprocessFileDocument} from '../../results/postprocess-document';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import {filePathPlotScope,retainedFilePathPlots,type FilePathPlotSnapshot} from '../results/file-path-plot';
import {resultFile,type ScientificSourceFile} from '../../results/input-file';
import {consumeLaunchImports,type LaunchImportBridge} from '../../modeling/platform/launch-import';
import {identifyPostprocessSource,readPostprocessFileOutput,isScientificFileSource,readPostprocessAuxiliary,readPostprocessWavefunction,extractPostprocessModel} from '../../results/postprocess-sources';
import {modelFragmentsFromStructures} from '../../modeling/platform/files';
import {exportWorkspaceResult} from '../results/export-workspace';
import {prepareIrcIntent} from '../../results/continuation';
import type {InputStructureSource,Structure} from '../../core/types';
import {importStructureFiles} from '../../core/file-import';
import {withAtomIds} from '../../core/structures';
import type {MultiStructureSourceActions,StructureSourcePickRequest} from '../MultiStructureSourcePicker';
import {createSharedSurface,SharedSurface} from './shared-surface';
import {useLinkedWorkspace} from './linked-workspace';
import {DEFAULT_DISPLAY,type DisplaySettings,type ChemistryPort,type PortableToolsRequest,type PortableToolsResponse,type ScientificEditRequest} from '../../modeling/contracts';
import {readModelDisplayPreferences} from '../../modeling/platform/display-preferences';
import {useRuntimeModelDisplay} from './useRuntimeModelDisplay';
import {createDefaultWorkspaceToolIntent,type WorkspaceToolIntent} from './ModelWorkspace';
import {createChemistryPort} from '../../modeling/chemistry';
import {EmpiricalFrameBonds,empiricalFrameBondDisplayStructure} from '../../results/empirical-frame-bonds';
import {createWorkspaceOwnerAdapter,isCurrentDocumentSaveIntent} from '../../modeling/platform/workspace-bridge';
import {applyWorkspaceOwnerCommand} from '../../modeling/application/workspace-owner-command';
import {bindWorkspaceAdvancedConsumers} from '../../modeling/application/workspace-advanced-consumers';
import {conformerDiscardSelection,planWorkspaceDiscard,prepareWorkspaceDiscard,type WorkspaceDiscardImpact,type WorkspaceDiscardExecution} from '../../modeling/application/conformer-lifecycle';
import {describeAnalysisDocumentClose,assertAnalysisDocumentIdle,prepareAnalysisDocumentClose} from '../../modeling/application/analysis-runtime-owners';
import type {AdvancedDiscardConformerPlan} from '../../modeling/advanced/contracts';
import {observeTrajectoryOperations,type TrajectoryOperationEvent} from '../../results/trajectory-operations';
import {multiwfnProgressTerminal,type MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import {useWorkbenchLayout} from './WorkbenchLayout';
import {clampWorkbenchPaneSize,DEFAULT_WORKBENCH_PANE_SIZES} from '../../modeling/workbench-layout';
import ModelDocumentDeck,{type ModelDocumentDeckMode} from './ModelDocumentDeck';
import {createLayoutResizeBoundary} from './render/resize-lifecycle';
import type {WorkspaceViewportState,WorkspaceViewportController,WorkspaceViewportEvent} from './workspace-viewport';
import {viewportSnapshotJSON} from './workspace-viewport';
import {createViewportDisplayOwner,openViewportDisplayPort,viewportDisplaySignature,type ViewportDisplayProjection,type ViewportDisplayDescriptor,type ViewportDisplayOwner} from './viewport-display-channel';
import type {ModelViewportProps} from './ModelViewport';
import RuntimeDataPanel from '../portable/RuntimeDataPanel';
import EnvironmentSettings from '../EnvironmentSettings';
import WorkspaceRenderBoundary from './WorkspaceRenderBoundary';
import {useTransientLayerScope} from '../TransientLayer';
import {subscribeGlobalSettings} from '../global-settings-events';
import StructureLibrary from './StructureLibrary';
import type { StructureLibraryEntry } from '../../modeling/structure-library';
import {applicationVersion} from '../../application-version';
import './workspace-shell.css';
const TwoDImportWorkspace=lazy(()=>import('./TwoDImportWorkspace'));

/** The document may be bound to a conformer task after its Store guard was
 * installed. Resolve current ownership on every scientific edit; a registry
 * snapshot captured at installation is only an identity anchor, never policy. */
export function createWorkspaceScientificEditGuard(entry:Pick<WorkspaceDocumentEntry,'id'|'epoch'|'store'>,ports:{
 currentEntry():WorkspaceDocumentEntry|undefined;
 currentTask(taskId:string):AdvancedTaskRecord|undefined;
 confirm(request:Readonly<import('../../modeling/contracts').ScientificEditRequest>,current:WorkspaceDocumentEntry):boolean;
}):import('../../modeling/contracts').ScientificEditGuard {
 return request=>{
  // Undo/Redo restore validity in their existing Store history transaction.
  if(request.operation!=='edit')return true;
  const current=ports.currentEntry();
  if(!current||current.id!==entry.id||current.epoch!==entry.epoch||current.store!==entry.store||request.documentId!==current.id||request.revision!==current.store.getSnapshot().revision)return false;
  if(current.conformerGroup?.role==='initial'){
   const task=ports.currentTask(current.conformerGroup.taskId);
   if(task?.runs.some(run=>['queued','running','stopping'].includes(run.status)))throw Error('当前构象任务仍在运行，请结束后编辑初始结构。');
   // Only a known empty task can bypass the impact choice. Missing/recovering
   // task ownership keeps the existing confirmation boundary.
   if(task&&!conformerInitialHasInformation(task))return true;
  }
  return ports.confirm(request,current);
 };
}

export interface DocumentWorkspaceSurface extends MultiStructureSourceActions {
 onCipLabelsUsed?:ModelViewportProps['onCipLabelsUsed'];
 entry:WorkspaceDocumentEntry;active:boolean;module:WorkspaceModule;
 inputActive:boolean;inputTaskId?:string;
 batchInputSession?:BatchInputSession;onFinishBatchInput?(id:string):void;
 initialCameraView?:readonly number[];
 initialViewTransform?:ModelViewportProps['viewTransform'];
 inputStamp():import('../../modeling/workspace-contracts').WorkspaceInputTaskStamp;
 assertInputIdentityCurrent(stamp:import('../../modeling/workspace-contracts').WorkspaceInputTaskStamp):void;
 onInputController(controller:{history?(kind:'undo'|'redo'):boolean;canUndo?():boolean;canRedo?():boolean;reset():void;cancel():void;isBusy():boolean;getAdvancedInputTemplate?():AdvancedInputTemplate|undefined}|null):void;
 onInputHistoryChange?():void;
 onNewInputTask():void;
 onPreparedInput(input:PreparedCitationInput):void;
 onSubmitExternalInput?:SubmitExternalInput;
 sources:WorkspaceTaskSource[];getCurrentSources():WorkspaceTaskSource[];stamp():WorkspaceActivationStamp;assertCurrent(stamp:WorkspaceActivationStamp):void;
 assertIdentityCurrent(stamp:WorkspaceActivationStamp):void;
 assertRuntimeCurrent(stamp:WorkspaceActivationStamp):void;
 onImportFiles(files:File[]):Promise<void>;onImportTwoDFiles(files:File[]):Promise<boolean>;onOpenTwoD():void;twoDActive:boolean;onNewDocument():void;
 onOpenStructureLibrary?():void;
 onOpenSettings?():void;
 onRuntime(controller:DynamicsController|null):void;onElectronicConfirmation(confirmed:boolean):void;
 onDraftState(engine:'gaussian'|'orca',value:JsonValue,dirty:boolean):void;
 sharedLayout:boolean;toolHost:HTMLElement|null;toolbarHost:HTMLElement|null;inputHost:HTMLElement|null;
 onToolSurfaceChange(surface:ReactNode):void;onToolbarSurfaceChange(surface:ReactNode):void;onLegendSurfaceChange(surface:ReactNode):void;presentationActive?:boolean;
 onLeftToolSurfaceChange(surface:ReactNode):void;
 onSourceRolesChange(roles:{documentId:string;label:string}[]):void;onCancelSourcePick():void;
 onSavedName(name:string):void;onActivate():void;
 onViewportState(state:WorkspaceViewportState):void;onViewportController(controller:WorkspaceViewportController|null):void;
 onDisplayProjection?(projection:ViewportDisplayProjection|null,observer:ModelViewportProps['onSurfaceMeshState']):void;
 viewportDockTarget?:{x:number;y:number;width:number;height:number};
 displaySettings:DisplaySettings;onDisplaySettingsChange(next:DisplaySettings):void;
 sharedShowAxes:boolean;onSharedShowAxesChange(value:boolean):void;
 toolIntent:WorkspaceToolIntent;onToolIntentChange(next:WorkspaceToolIntent):void;
 viewportActive:boolean;legendVisible:boolean;layoutActions:ReactNode;legendExpanded:boolean;onLegendExpandedChange(expanded:boolean):void;
 linkedAtomActions?:ReactNode;onAtomNumberPick?:(atomId:string)=>void;linkedAtomsActive?:boolean;
 workspaceDocumentPickMode?:'source'|'link';workspaceDocumentPickSelected?:boolean;
 workspaceInputRoles?:WorkspaceViewportState['workspaceInputRoles'];
 analysisCanvas?:AnalysisCanvas;
 samplingSphereDraft?:SamplingSphereViewportDraft|null;
 onSamplingSphereRadiusChange?(change:SamplingSphereRadiusChange):void;
 structureAnalysisActive?:boolean;
 advancedModelingRoute?:AdvancedModelingRoute;
 onAdvancedModelingRouteChange?(route:AdvancedModelingRoute):void;
 onAdvancedModelingBack?():void;
 onDeriveStructure?(candidate:StructureTransformCandidate):void;
 onWorkspaceHistory?(kind:'undo'|'redo'):boolean;
 workspaceCanUndo?:boolean;workspaceCanRedo?:boolean;
}

/** Stage imported geometry with the same empirical connection/type policy as modeling. */
export async function prepareWorkspaceImportModels(items:WorkspaceImportItem[],options:{port:ChemistryPort;signal:AbortSignal;guard():void}):Promise<{items:WorkspaceImportItem[];warnings:string[]}> {
 const prepared:WorkspaceImportItem[]=[],warnings:string[]=[];
 const guard=()=>{if(options.signal.aborted)throw new Error('模型导入已取消。');options.guard();};
 guard();
 for(const item of items){
  guard();
  if(item.kind!=='model'){prepared.push(item);continue;}
  const source=item.fragment.structure;
  // Saved rich model fragments already own edited graph/history; do not rewrite them.
  if(item.restoredModel){prepared.push(item);continue;}
  const provider=new EmpiricalFrameBonds({port:options.port,sourceId:`import:${source.id}`});
  let result:Awaited<ReturnType<EmpiricalFrameBonds['resolve']>>;
  try{result=await provider.resolve(source,0,{signal:options.signal,guard});}finally{provider.dispose();}
  guard();
  if(result.status==='stale'||result.status==='cancelled')throw new Error('模型导入已取消或活动文档已变化，未提交新文档。');
  if(result.warnings.length&&(result.status!=='inferred'||source.cell||source.periodicSource))warnings.push(source.name+'：'+result.warnings.join('；'));
  prepared.push({kind:'model',fragment:{...item.fragment,structure:empiricalFrameBondDisplayStructure(result)}});
 }
 guard();return {items:prepared,warnings};
}

/** Presentation containers never create a second document, Undo or runtime owner. */
export function advancedObservationPublicationCurrent(ownerId:string|undefined,currentOwnerId:string|undefined,ownedSource:AdvancedFrameSource|undefined,currentSource:AdvancedFrameSource|undefined):boolean{
 return Boolean(ownerId&&ownerId===currentOwnerId&&sameDisplaySource(ownedSource,currentSource));
}

/** A retained wavefunction belongs to its native task/run, not whichever
 * analysis token happens to be attached to the mutable model today. */
export function workspaceRetainedXtbAnalysisAvailable(p:{targetId:string|undefined;analysisId:string;ownerExists:boolean;
 generated:{ownerId:string;document:PostprocessDocument};tasks:readonly AdvancedTaskRecord[];bindings:Readonly<Record<string,string>>}):boolean{
 const provenance=p.generated.document.wavefunction?.source.generatedXtb,identity=provenance?.runIdentity;
 if(!p.ownerExists||!p.targetId||p.generated.ownerId!==p.targetId||!provenance||!identity
  ||p.bindings[`${identity.taskId}:${identity.runId}`]!==p.analysisId)return false;
 const task=p.tasks.find(row=>row.id===identity.taskId),run=task?.runs.find(row=>row.id===identity.runId);
 if(!task||task.spec.kind!=='singlepoint'||!run||task.spec.source.ref.documentId!==p.targetId)return false;
 const source=task.spec.source,result=p.generated.document.result.initialStructure;
 if(['documentId','revision','graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].some(key=>provenance.stamp[key as keyof typeof provenance.stamp]!==source.stamp[key as keyof typeof source.stamp])
  ||result.charge!==source.structure.charge||result.multiplicity!==source.structure.multiplicity
  ||result.atoms.length!==source.structure.atoms.length)return false;
 return result.atoms.every((atom,index)=>{const expected=source.structure.atoms[index];return atom.id===expected.id&&atom.element===expected.element&&atom.x===expected.x&&atom.y===expected.y&&atom.z===expected.z;});
}

/** The Shell supplies its real Registry owner and copy choice. No draft writes
 * occur until the choice and the complete source lease have both succeeded. */
export async function prepareWorkspaceElectronicSource(p:{registry:ReturnType<typeof createWorkspaceRegistry>;
 context:ElectronicStateSourceContext;draft:ElectronicStateDraft;owner:WorkspaceActivationStamp;sourceEpoch:number;
 assertLifetimeCurrent?():void;
 assertSourceCurrent():void;copyRequired:boolean;confirmCopy():Promise<boolean>;
 createCopy(source:ElectronicStateSourceContext):WorkspaceDocumentEntry;onCommitted?(entry:WorkspaceDocumentEntry):void}):Promise<ConfirmedElectronicSnapshot|null>{
 const error=validateElectronicStateDraft(p.context,p.draft);if(error)throw Error(error);assertAdvancedIsolated(p.context);
 const values=electronicDraftValues(p.draft)!;
 const guard=()=>{p.assertLifetimeCurrent?.();const entry=p.registry.assertCurrent(p.owner);if(entry.sourceEpoch!==p.sourceEpoch)throw Error('电子态来源已更换，请重新取用。');p.assertSourceCurrent();return entry;};
 const original=guard();
 if(p.copyRequired){const approved=await p.confirmCopy();if(!approved)return null;guard();}
 const target=p.copyRequired?p.createCopy(p.context):original;
 target.store.execute({type:'set-electronic-state',charge:values.charge,multiplicity:values.multiplicity,confirmed:true});
 p.onCommitted?.(target);
 const stamp=p.registry.stamp();if(stamp.documentId!==target.id)throw Error('电子态提交目标已切换，未生成单点。');
 const source=await captureWorkspaceAdvancedSource({document:target.store.getSnapshot(),documentEpoch:target.epoch,label:target.label,guard:()=>{p.assertLifetimeCurrent?.();p.registry.assertCurrent(stamp);}});
 p.assertLifetimeCurrent?.();p.registry.assertCurrent(stamp);
 return {source,...values,uhf:values.multiplicity-1,confirmationKey:advancedElectronicSourceConfirmationKey(source,values)};
}

export function restoreWorkspaceXtbSettings(value:{electronicDrafts?:unknown;taskSelections?:unknown;methodDrafts?:unknown}):{
 electronicDrafts:Record<string,ElectronicStateDraft>;taskSelections:Record<string,XtbAnalysisTaskSelection>;methodDrafts:Record<string,AdvancedMethodDraft>}{
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const entries=(v:unknown)=>{if(v===undefined)return [];if(!object(v))throw Error('项目XTB2设置格式无效，原数据保留。');return Object.entries(v);};
 const electronicDrafts:Record<string,ElectronicStateDraft>={},taskSelections:Record<string,XtbAnalysisTaskSelection>={},methodDrafts:Record<string,AdvancedMethodDraft>={};
 for(const [key,raw]of entries(value.electronicDrafts)){
  if(!object(raw)||raw.sourceKey!==key||typeof raw.chargeText!=='string'||typeof raw.multiplicityText!=='string'
   ||!['explicit','missing','suggested'].includes(String(raw.origin))||!object(raw.touched)||typeof raw.touched.charge!=='boolean'||typeof raw.touched.multiplicity!=='boolean'
   ||![raw.sourceCharge,raw.sourceMultiplicity].every(v=>v===null||typeof v==='number'&&Number.isFinite(v)))throw Error('项目电子态草稿格式无效，未补造电荷或自旋。');
  electronicDrafts[key]={sourceKey:key,chargeText:raw.chargeText,multiplicityText:raw.multiplicityText,
   sourceCharge:raw.sourceCharge as number|null,sourceMultiplicity:raw.sourceMultiplicity as number|null,origin:raw.origin as ElectronicStateDraft['origin'],
   touched:{charge:raw.touched.charge,multiplicity:raw.touched.multiplicity}};
 }
 for(const [id,raw]of entries(value.taskSelections)){
  if(!object(raw)||typeof raw.taskId!=='string'||!raw.taskId||raw.runId!==undefined&&typeof raw.runId!=='string')throw Error('项目XTB2任务选择格式无效。');
  taskSelections[id]={taskId:raw.taskId,...raw.runId===undefined?{}:{runId:raw.runId as string}};
 }
 for(const [id,raw]of entries(value.methodDrafts)){
  if(!object(raw)||!['gfn2','gfn1','gfn0','gfnff','MMFF94','MMFF94s','UFF'].includes(String(raw.method))
   ||!['none','alpb','gbsa'].includes(String(raw.solvationModel))||typeof raw.solvent!=='string'||typeof raw.internalConstraintsConfirmed!=='boolean'
   ||![raw.threads,raw.maxSteps,raw.sccIterationLimit].every(v=>typeof v==='number'&&Number.isFinite(v)))throw Error('项目XTB2方法草稿格式无效。');
  methodDrafts[id]={method:raw.method as AdvancedMethodDraft['method'],threads:raw.threads as number,maxSteps:raw.maxSteps as number,sccIterationLimit:raw.sccIterationLimit as number,
   solvationModel:raw.solvationModel as AdvancedMethodDraft['solvationModel'],solvent:raw.solvent,internalConstraintsConfirmed:raw.internalConstraintsConfirmed};
 }
 return {electronicDrafts,taskSelections,methodDrafts};
}
export default function WorkspaceShell(props:{renderDocument(surface:DocumentWorkspaceSurface):ReactNode}) {
 const [projectUi]=useState(()=>new ProjectUiStore());
 return <ProjectUiScope store={projectUi} scope={['workspace']}><ProjectWorkspaceShell {...props} projectUi={projectUi}/></ProjectUiScope>;
}
function ProjectWorkspaceShell({renderDocument,projectUi}:{renderDocument(surface:DocumentWorkspaceSurface):ReactNode;projectUi:ProjectUiStore}) {
 const desktop=window.sciyueDesktop;
 const workbench=useWorkbenchLayout();
 const [registry]=useState(()=>{const value=createWorkspaceRegistry();value.addDocument();return value;});
 const state=useSyncExternalStore(registry.subscribe,registry.getSnapshot,registry.getSnapshot);
 const activePageId=state.views.find(view=>view.id===state.activeViewId)?.documentId;
 const activeConformerGroup=state.documents.find(entry=>entry.id===activePageId)?.conformerGroup;
 const [error,setError]=useState(''),[reading,setReading]=useState(false),[readProgress,setReadProgress]=useState<number|null>(null),[readCancelPending,setReadCancelPending]=useState(false),[importCloseFailed,setImportCloseFailed]=useState(false);
 const importResourceClosures=useRef(createImportResourceClosures()),importReadScope=useRef<{epoch:number;settled:boolean}|null>(null);
 const [twoDFile,setTwoDFile]=useState<TwoDImportFile|null>(null),[twoDVisible,setTwoDVisible]=useState(false),[twoDBusy,setTwoDBusy]=useState(false);
 const twoDFileRef=useRef(twoDFile);twoDFileRef.current=twoDFile;
 const twoDVisibleRef=useRef(twoDVisible);twoDVisibleRef.current=twoDVisible;
 const twoDOrigin=useRef<'manual'|'imported'>('manual');
 const twoDRuntime=useRef<TwoDImportRuntime|null>(null),twoDLoadEpoch=useRef(0),twoDCommitting=useRef(false);
 const setTwoDRuntime=useCallback((value:TwoDImportRuntime|null)=>{twoDRuntime.current=value;},[]);
 const closeTwoD=useCallback(()=>{twoDRuntime.current?.cancelGesture();setTwoDVisible(false);twoDLoadEpoch.current++;},[]);
 const openTwoDManual=useCallback(()=>{if(!twoDFileRef.current){const file:TwoDImportFile={id:`two-d-manual-${crypto.randomUUID()}`,name:'手动绘制',bytes:new Uint8Array(),kind:'structure'};twoDOrigin.current='manual';twoDFileRef.current=file;setTwoDFile(file);}setTwoDVisible(true);},[]);
 const [sourceDiagnostics,setSourceDiagnostics]=useState<ResultDiagnostic[]>([]),[diagnosticsOpen,setDiagnosticsOpen]=useState(false);
 const sourceDiagnosticsRef=useRef(sourceDiagnostics);sourceDiagnosticsRef.current=sourceDiagnostics;
 const addSourceDiagnostics=useCallback((items:readonly ResultDiagnostic[])=>{if(!items.length)return;const next=[...sourceDiagnosticsRef.current,...items];sourceDiagnosticsRef.current=next;setSourceDiagnostics(next);setDiagnosticsOpen(true);},[]);
 const removeSourceDiagnostic=useCallback((id:string)=>{const items=sourceDiagnosticsRef.current.filter(item=>item.id===id);const next=sourceDiagnosticsRef.current.filter(item=>item.id!==id);sourceDiagnosticsRef.current=next;setSourceDiagnostics(next);void Promise.all(items.map(item=>Promise.resolve(item.dispose()))).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));if(!next.length)setDiagnosticsOpen(false);},[]);
 useEffect(()=>()=>{for(const item of sourceDiagnosticsRef.current)void Promise.resolve(item.dispose()).catch(()=>{});sourceDiagnosticsRef.current=[];},[]);
 const [closing,setClosing]=useState<string|null>(null),[closingPendingIds,setClosingPendingIds]=useState<string[]>([]);
 const [discardImpact,setDiscardImpact]=useState<WorkspaceDiscardImpact|null>(null);
 const discardImpactRef=useRef(discardImpact);discardImpactRef.current=discardImpact;
 const discardConfirmSerial=useRef(0);
 const pendingDiscards=useRef(new Map<string,{execution:WorkspaceDiscardExecution;label:string}>());
 const [discardCleanupRevision,setDiscardCleanupRevision]=useState(0),[retryingDiscard,setRetryingDiscard]=useState(false);
 const activeSourceOperations=useRef(new Map<number,Readonly<TrajectoryOperationEvent>>());
 const activeNativeAnalyses=useRef(new Map<string,MultiwfnProgressSnapshot>());
 const projectActivity=useRef({busy:false,capturing:false});
 const projectIdentityEpoch=useRef(0),advancedHydrationProjection=useRef(createAdvancedHydrationProjectionBaseline());
 const [taskSnapshotPages,setTaskSnapshotPages]=useState<Record<string,{documentId:string;sourceId:string;taskId:string;runId:string|null;libraryId:string;sourceSetId?:string;sourceVersion?:string}>>({});
 const taskSnapshotPagesRef=useRef(taskSnapshotPages);taskSnapshotPagesRef.current=taskSnapshotPages;
 const taskWorkspace=useTaskWorkspace({identity:()=>JSON.stringify([projectIdentityEpoch.current,registry.getSnapshot().activeViewId,registry.getSnapshot().module]),projectId:()=>projectInfo.current.project?.projectId??null,openSnapshot:openExternalSnapshot,extractStructure:extractFrame,onError:setError});
 // Subscribe before child passive effects can start scientific/file work.
 // No elapsed-time or quiet-period heuristic is used for ownership.
 useLayoutEffect(()=>{
  const off=observeTrajectoryOperations(event=>{if(!['read','parse','quantum','orbital','surface'].includes(event.kind))return;if(event.phase==='started')activeSourceOperations.current.set(event.operationId,event);else activeSourceOperations.current.delete(event.operationId);});
  const offNative=desktop?.onMultiwfnProgress?.(snapshot=>{const key=JSON.stringify([snapshot.identity.sessionId,snapshot.identity.runId]);if(multiwfnProgressTerminal(snapshot.phase)||snapshot.settlement==='native-settled'&&snapshot.validated===true)activeNativeAnalyses.current.delete(key);else activeNativeAnalyses.current.set(key,snapshot);});
  return()=>{off();offNative?.();activeSourceOperations.current.clear();activeNativeAnalyses.current.clear();};
 },[desktop]);
 const closingPending=closingPendingIds.length>0;
 const [ownerHidden,setOwnerHidden]=useState(false),[runtimeDataOpen,setRuntimeDataOpen]=useState(false),[environmentOpen,setEnvironmentOpen]=useState(false);
 const [environmentPage,setEnvironmentPage]=useState<'display'|'resources'>('resources');
 const openDisplaySettings=useCallback(()=>{setEnvironmentPage('display');setEnvironmentOpen(true);},[]);
 const nativeFileAction=useRef<((request:{action:'import'|'export-structure'|'export-image';documentId?:string})=>Promise<void>)|null>(null);
 const [citationState,setCitationState]=useState(emptyCitationState),[citationOpen,setCitationOpen]=useState<{documentId?:string;fixed:boolean;facts:CitationFact[];warnings:string[];identity:string}|null>(null);
 const citationStateRef=useRef(citationState);citationStateRef.current=citationState;
 function cipUsageFor(ownerId:string,ownerEpoch?:string):NonNullable<ModelViewportProps['onCipLabelsUsed']>{
  const projectEpoch=projectIdentityEpoch.current;
  return receipt=>{
   const current=()=>{if(projectEpoch!==projectIdentityEpoch.current)return false;const entry=registry.getSnapshot().documents.find(row=>row.id===ownerId);return ownerEpoch!==undefined?entry?.epoch===ownerEpoch&&!closingTransactions.current.has(ownerId):Boolean(advancedPorts.current.postprocess.captureFileDocuments()[ownerId]);};
   if(!current())return;
   // The view validated its exact currently prepared geometry before calling;
   // this owner only retains use history and never activates a model or page.
   const owned={...receipt,documentId:ownerId};
   setCitationState(previous=>current()?appendCipUsage(previous,owned):previous);
  };
 }
 const [citationUiStore]=useState(()=>new ProjectUiStore());
 const citationOpenAction=useRef<(documentId?:string)=>Promise<void>>(async()=>{});
 const [structureLibraryOpen,setStructureLibraryOpen]=useState(false);
 const libraryLoadController=useRef<AbortController|null>(null);
 const [deckMode,setDeckMode]=useState<ModelDocumentDeckMode>('single'),[multiMode,setMultiMode]=useState<'tiled'|'free'>('tiled'),[arrangeRequest,setArrangeRequest]=useState(0);
 const [order,setOrder]=useState<string[]>([]),[detached,setDetached]=useState<Record<string,string>>({});
 const detachedPlacement=useRef(detached);detachedPlacement.current=detached;
 const [mainDocumentId,setMainDocumentId]=useState<string|null>(null),[closeConfirmIds,setCloseConfirmIds]=useState<string[]>([]);
 const {display:displaySettings,changeDisplay:changeDisplaySettings}=useRuntimeModelDisplay({initialDisplay:DEFAULT_DISPLAY,loadDefault:async()=>(await readModelDisplayPreferences()).display,onError:cause=>setError(cause instanceof Error?cause.message:String(cause))});
 const [sharedShowAxes,setSharedShowAxes]=useState(false),[toolIntent,setToolIntent]=useState(createDefaultWorkspaceToolIntent);
 const [toolHost,setToolHost]=useState<HTMLDivElement|null>(null),[toolbarHost,setToolbarHost]=useState<HTMLDivElement|null>(null);
 const [analysisToolHosts,setAnalysisToolHosts]=useState<Record<string,HTMLDivElement|null>>({});
 const [analysisCanvases,setAnalysisCanvases]=useState<Record<string,AnalysisCanvas|null>>({});
 const [fileObservedStructures,setFileObservedStructures]=useState<Record<string,Structure|null>>({});
 const fileObservedCallbacks=useRef(new Map<string,{source:PostprocessScientificFileDocument;callback:(structure:Structure|null)=>void}>());
 const [activeAnalysisResults,setActiveAnalysisResults]=useState<Record<string,{source:PostprocessDocument;result:TrajectoryResult|null}>>({});
 const activeResultCallbacks=useRef(new Map<string,{source:PostprocessDocument;callback:(result:TrajectoryResult|null)=>void}>());
 const analysisCanvasesRef=useRef(analysisCanvases);analysisCanvasesRef.current=analysisCanvases;
 type PendingEdit={request:Readonly<ScientificEditRequest>;stamp:WorkspaceActivationStamp;frameKey:string};
 const [pendingEdit,setPendingEdit]=useState<PendingEdit|null>(null),[editChoiceBusy,setEditChoiceBusy]=useState(false);
 const [pendingSourceCopy,setPendingSourceCopy]=useState<{resolve(copy:boolean):void;purpose?:'file-import'|'xtb-electronic-state'}|null>(null);
 const pendingSourceCopyRef=useRef(pendingSourceCopy);pendingSourceCopyRef.current=pendingSourceCopy;
 const sourceCopyBusy=useRef(false);
 useEffect(()=>()=>pendingSourceCopyRef.current?.resolve(false),[]);
 const pendingEditRef=useRef(pendingEdit);pendingEditRef.current=pendingEdit;
 const editChoiceInFlight=useRef(false),nativeEditPrompt=useRef<PendingEdit|null>(null);
 const lastScientificCanvases=useRef(new Map<string,AnalysisCanvas>());
 const trajectoryFrames=useRef(new Map<string,{resultId:string;frameIndex:number}>());
 const [advancedObservations,setAdvancedObservations]=useState<Record<string,AdvancedFrameSource>>({});
 const advancedObservationsRef=useRef(advancedObservations);advancedObservationsRef.current=advancedObservations;
 const advancedObservationBindings=useRef(new Map<string,{source:AdvancedFrameSource;bindingId:string}>());
 const capturedSourceGeometry=useRef(new Map<string,string>());
 const capturedSourceOwners=useRef(new Map<string,{documentId:string;epoch:string}>());
 const [advancedCapture,setAdvancedCapture]=useState<AnalysisAtomCapture|undefined>();
 const [advancedLayers,setAdvancedLayers]=useState<Record<string,AdvancedCanvasLayers|undefined>>({});
 const advancedObservationSerial=useRef(0);
 const [advancedConfigurationHost,setAdvancedConfigurationHost]=useState<HTMLDivElement|null>(null),[advancedResultHost,setAdvancedResultHost]=useState<HTMLDivElement|null>(null);
 const inheritedNavigation=useRef(new Map<string,{section:AdvancedSection|null;sampling:ConformerSamplingChoice|null}>());
 const [advancedSection,setAdvancedSection]=useWorkspacePageValue<AdvancedSection|null>(activePageId,activeConformerGroup?'conformer':activePageId?inheritedNavigation.current.get(activePageId)?.section??null:null,'advancedSection');
 const [conformerGroups,setConformerGroups]=useState<Record<string,{label:string;collapsed:boolean;samplingOperation?:ConformerSamplingChoice|null}>>({});
 const [conformerSamplingChoice,setConformerSamplingChoice]=useWorkspacePageValue<ConformerSamplingChoice|null>(activePageId,activeConformerGroup?conformerGroups[activeConformerGroup.taskId]?.samplingOperation??null:activePageId?inheritedNavigation.current.get(activePageId)?.sampling??null:null,'conformerSamplingChoice');
 const [renamingGroup,setRenamingGroup]=useState<string|null>(null);
 const [conformerFrameOrders,setConformerFrameOrders]=useState<Record<string,ConformerFrameOrder>>({});
 const [conformerViewControls,setConformerViewControls]=useState<Record<string,ReactNode>>({});
 const conformerCollectionCache=useRef(new WeakMap<AdvancedTaskRecord,ConformerResultCollection[]>());
 const conformerPlayerCollections=useRef(new Map<string,{result:TrajectoryResult;collection:ConformerResultCollection;ownerId:string;value:ReturnType<typeof createAdvancedPlaybackCollection>}>());
 const conformerCollectionPublisher=useRef(createConformerCollectionPublisher());
 const conformerPrepared=useRef(new Map<string,{signature:string;result:TrajectoryResult;abort:AbortController;ready:Promise<void>}>());
 const advancedIntegration=useRef<{controller?:AdvancedController;prepare(task:AdvancedTaskRecord):Promise<void>}>({prepare:async()=>{throw Error('构象结果准备入口尚未连接。');}});
 const [samplingSphereDraft,setSamplingSphereDraft]=useState<SamplingSphereDraft|undefined>();
 const [samplingSphereRadiusChange,setSamplingSphereRadiusChange]=useState<SamplingSphereRadiusChange|null>(null);
 const derivedModelingRoutes=useRef(new Map<string,AdvancedModelingRoute>());
 const [advancedModelingRoute,setAdvancedModelingRoute]=useWorkspacePageValue<AdvancedModelingRoute>(activePageId,activePageId?derivedModelingRoutes.current.get(activePageId)??null:null,'advancedModelingRoute');
 const advancedSectionRef=useRef(advancedSection);advancedSectionRef.current=advancedSection;
 const [xtbAnalysisCanvases,setXtbAnalysisCanvases]=useState<Record<string,AnalysisCanvas|null>>({});
 const [xtbAnalysisSelections,setXtbAnalysisSelections]=useState<Record<string,string|undefined>>({});
 const [xtbElectronicDrafts,setXtbElectronicDrafts]=useState<Record<string,ElectronicStateDraft>>({});
 const [xtbTaskSelections,setXtbTaskSelections]=useState<Record<string,XtbAnalysisTaskSelection>>({});
 const [xtbMethodDrafts,setXtbMethodDrafts]=useState<Record<string,AdvancedMethodDraft>>({});
 const [xtbElectronicContexts,setXtbElectronicContexts]=useState<Record<string,ElectronicStateSourceContext>>({});
 const xtbElectronicContextsRef=useRef(xtbElectronicContexts);xtbElectronicContextsRef.current=xtbElectronicContexts;
 const xtbElectronicLeases=useRef(new Map<string,{owner:WorkspaceActivationStamp;sourceEpoch:number;frameKey:string;context:ElectronicStateSourceContext;historical?:XtbAnalysisTaskSelection}>());
 const xtbWorkingBindings=useRef(new Map<string,{analysisId:string;bindingId:string}>());
 const [advancedTaskHighlights,setAdvancedTaskHighlights]=useState<Record<string,{source:AdvancedFrameSource;atomIds:readonly string[]}|undefined>>({});
 const advancedAnalysisDocuments=useRef(new Map<string,string>());
 const [advancedAnalysisBindings,setAdvancedAnalysisBindings]=useState<Record<string,string>>({});
 const [structureAnalysisSelected,setStructureAnalysisSelected]=useState<Record<string,boolean>>({});
 const canvasCallbacks=useRef(new Map<string,(value:AnalysisCanvas|null)=>void>());
 function canvasFor(id:string){let callback=canvasCallbacks.current.get(id);if(!callback){callback=value=>{if(value?.result)lastScientificCanvases.current.set(id,value);setAnalysisCanvases(previous=>previous[id]===value?previous:{...previous,[id]:value});};canvasCallbacks.current.set(id,callback);}return callback;}
 const analysisHostCallbacks=useRef(new Map<string,(node:HTMLDivElement|null)=>void>());
 function analysisHostRef(id:string){let callback=analysisHostCallbacks.current.get(id);if(!callback){callback=node=>setAnalysisToolHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});analysisHostCallbacks.current.set(id,callback);}return callback;}
 const [plots,setPlots]=useState<(PostprocessPlotSnapshot|FilePathPlotSnapshot)[]>([]),[resultImportRequest,setResultImportRequest]=useState<ScientificSourceFile[]|null>(null),[resultImportDescriptions,setResultImportDescriptions]=useState<string[]>([]);
 const resultImportChoice=useRef<((value:'analysis'|'structure'|'cancel')=>void)|null>(null);
 const resolveResultImport=(value:'analysis'|'structure'|'cancel')=>{const resolve=resultImportChoice.current;resultImportChoice.current=null;setResultImportRequest(null);resolve?.(value);};
 const openPlot=useCallback((snapshot:PostprocessPlotSnapshot|FilePathPlotSnapshot)=>setPlots(previous=>[...previous,{...structuredClone(snapshot),id:`plot-${crypto.randomUUID()}`}]),[]);
 const [inputHosts,setInputHosts]=useState<Record<string,HTMLDivElement|null>>({});
 const inputHostCallbacks=useRef(new Map<string,(node:HTMLDivElement|null)=>void>());
 function inputHostRef(id:string){let callback=inputHostCallbacks.current.get(id);if(!callback){callback=node=>setInputHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});inputHostCallbacks.current.set(id,callback);}return callback;}
 const [toolSurface]=useState(createSharedSurface),[toolbarSurface]=useState(createSharedSurface),[legendSurface]=useState(createSharedSurface);
 const [leftToolSurface]=useState(createSharedSurface),[leftToolOpen,setLeftToolOpen]=useState(false);
 const [legendHostId,setLegendHostId]=useState<string|null>(null),[legendTarget,setLegendTarget]=useState<HTMLElement|null>(null),[legendExpanded,setLegendExpanded]=useState(true);
 const [sourcePick,setSourcePick]=useState<{ownerId:string;stamp:import('../../modeling/workspace-contracts').WorkspaceInputTaskStamp;request:StructureSourcePickRequest}|null>(null);
 const sourcePickLive=useRef(sourcePick);sourcePickLive.current=sourcePick;
 const [sourceRoles,setSourceRoles]=useState<Record<string,{documentId:string;label:string}[]>>({});
 const inputControllers=useRef(new Map<string,{history?(kind:'undo'|'redo'):boolean;canUndo?():boolean;canRedo?():boolean;reset():void;cancel():void;isBusy():boolean;getAdvancedInputTemplate?():AdvancedInputTemplate|undefined}>());
 const [,setInputHistoryRevision]=useState(0);
 const notifyInputHistoryChange=useCallback(()=>setInputHistoryRevision(value=>value+1),[]);
 const [newInputTarget,setNewInputTarget]=useState<string|null>(null);
 const [advancedInputTarget,setAdvancedInputTarget]=useState<{source:AdvancedFrameSource;previousTaskId?:string}|null>(null);
 type BorrowedBatch={session:BatchInputSession;documentId:string;previousViewId:string|null;previousModule:WorkspaceModule;previousFrameId?:string;previousDocumentId?:string;input:ReturnType<typeof registry.borrowInputTask>;camera?:number[]};
 const [borrowedBatch,setBorrowedBatch]=useState<BorrowedBatch|null>(null),[cancelBatchConfirm,setCancelBatchConfirm]=useState(false);
 const borrowedBatchRef=useRef(borrowedBatch);borrowedBatchRef.current=borrowedBatch;
 const inheritedViews=useRef(new Map<string,{camera?:number[];transform?:ModelViewportProps['viewTransform']}>());
 const [preparedInputTarget,setPreparedInputTarget]=useState<{structure:Structure;engine:'gaussian'|'orca'}|null>(null);
 const rootElement=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const root=rootElement.current;if(!root)return;
  const panel=root.querySelector<HTMLElement>('.workspace-advanced-modeling-panel');if(!panel)return;
  const win=root.ownerDocument.defaultView!;
  const update=()=>{
   let minimum=250;
   for(const row of panel.querySelectorAll<HTMLElement>('.slab-miller-row .structure-transform-vector')){
    if(!row.getClientRects().length)continue;
    const style=win.getComputedStyle(row),gap=parseFloat(style.columnGap)||0;
    const children=[...row.children] as HTMLElement[];
    minimum=Math.max(minimum,Math.ceil(children.reduce((sum,node)=>sum+node.getBoundingClientRect().width,0)+Math.max(0,children.length-1)*gap+54));
   }
   const value=minimum+'px';if(root.style.getPropertyValue('--advanced-panel-min')!==value)root.style.setProperty('--advanced-panel-min',value);
  };
  update();const observer=new win.MutationObserver(update);observer.observe(panel,{childList:true,subtree:true});
  const resized=new win.ResizeObserver(update);resized.observe(panel);
  return()=>{observer.disconnect();resized.disconnect();};
 },[]);
 useLayoutEffect(()=>{
  const node=rootElement.current;if(!node)return;const win=node.ownerDocument.defaultView!;
  const boundary=createLayoutResizeBoundary(node,callback=>win.requestAnimationFrame(callback),id=>win.cancelAnimationFrame(id));
  const begin=(event:PointerEvent)=>boundary.begin(event),end=(event:PointerEvent)=>boundary.end(event),cancel=()=>boundary.cancel();
  node.addEventListener('pointerdown',begin,true);for(const type of ['pointerup','pointercancel','lostpointercapture'])node.addEventListener(type,end as EventListener,true);win.addEventListener('blur',cancel);
  return()=>{node.removeEventListener('pointerdown',begin,true);for(const type of ['pointerup','pointercancel','lostpointercapture'])node.removeEventListener(type,end as EventListener,true);win.removeEventListener('blur',cancel);boundary.dispose();};
 },[]);
 const [dockTarget,setDockTarget]=useState<WorkspaceViewportState['dockTarget']>();
 const tabs=useRef<HTMLDivElement>(null),fileInput=useRef<HTMLInputElement>(null),importEpoch=useRef(0),importController=useRef<AbortController|null>(null);
 const tabDrag=useRef<{id:string;pointerId:number;x:number;y:number;moved:boolean}|null>(null);
 const closeRequests=useRef(new Map<string,{requestId:string;requesterWindowId:string}>());
 const closeConfirmations=useRef(new Set<string>());
 const closingTransactions=useRef(new Set<string>());
 const runtimeOwners=useRef(new Map<string,{controller:DynamicsController;unsubscribe:()=>void}>());
 const ownerAdapters=useRef(new Map<string,ReturnType<typeof createWorkspaceOwnerAdapter>>());
 const viewportStates=useRef(new Map<string,WorkspaceViewportState>()),viewportControllers=useRef(new Map<string,WorkspaceViewportController>());
 const pendingCameraRestores=useRef(new Map<string,{stamp:WorkspaceActivationStamp;view:number[]}>());
 const displaySources=useRef(new Map<string,{projection:ViewportDisplayProjection;descriptor:ViewportDisplayDescriptor;signature:string;observer:ModelViewportProps['onSurfaceMeshState']}>()),displaySerials=useRef(new Map<string,number>()),displayOwners=useRef(new Map<string,ViewportDisplayOwner>());
 const callbacks=useRef(new Map<string,DocumentWorkspaceSurface>());
 const pagePresentations=useRef(new Map<string,Pick<DocumentWorkspaceSurface,'analysisCanvas'|'advancedModelingRoute'|'samplingSphereDraft'>>());
 const pageScroll=useRef(new Map<string,{top:number;left:number}>());
 useEffect(()=>subscribeGlobalSettings(desktop,()=>{setEnvironmentPage('resources');setEnvironmentOpen(true);}),[desktop]);
 useEffect(()=>desktop?.onWorkbenchFileAction?.(request=>{void nativeFileAction.current?.(request).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));}),[desktop]);
 useEffect(()=>desktop?.onCitationsOpen?.(request=>{void citationOpenAction.current(request.documentId).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));}),[desktop]);
 const computeResourceState=useComputeResources(desktop);
 const firstRunLicense=useFirstRunLicense(desktop);
 const resourceSetupChecked=useRef(false);
 useEffect(()=>{
  const snapshot=computeResourceState.snapshot;
  if(!firstRunLicense.ready||!firstRunLicense.setupOwner||resourceSetupChecked.current||computeResourceState.loading||!snapshot)return;
  resourceSetupChecked.current=true;
  if(shouldOpenInitialResourceSetup(firstRunLicense,snapshot)){setEnvironmentPage('resources');setEnvironmentOpen(true);}
 },[firstRunLicense.ready,firstRunLicense.setupOwner,computeResourceState.loading,computeResourceState.snapshot]);
 const computeResources=!computeResourceState.loading&&!computeResourceState.error?computeResourceState.snapshot?.effective??null:null;
 const computeSnapshotRef=useRef(computeResourceState.snapshot);computeSnapshotRef.current=computeResourceState.snapshot;
 useEffect(()=>setPreparedTrajectoryResources(computeResources),[computeResources]);
 useEffect(()=>{let alive=true;const unsubscribe=subscribePreparedTrajectoryMemory(bytes=>{void desktop?.reportPreparedTrajectoryMemory?.(bytes).catch(cause=>{if(alive)setError('轨迹内存状态同步失败：'+String(cause));});});return()=>{alive=false;unsubscribe();};},[desktop]);
 const advancedOutputBridge=useMemo(()=>desktop?.chooseAdvancedOutput&&desktop.writeAdvancedOutput&&desktop.abandonAdvancedOutput?{chooseAdvancedOutput:desktop.chooseAdvancedOutput.bind(desktop),writeAdvancedOutput:desktop.writeAdvancedOutput.bind(desktop),abandonAdvancedOutput:desktop.abandonAdvancedOutput.bind(desktop)}:null,[desktop]);
 const hostBridge=desktop?.registerWorkspaceDocument?desktop as typeof desktop&WorkspaceDesktopBridge:null;
 const activeView=state.views.find(view=>view.id===state.activeViewId),activeId=activeView?.documentId;
 const advancedDisplayOwner=useRef<string|undefined>(undefined);advancedDisplayOwner.current=state.module==='advanced'?activeId:undefined;
 const publishAdvancedLayers=useMemo(()=>{const ownerId=activeId;return(value:AdvancedCanvasLayers|undefined)=>{
  // An old panel's passive-effect cleanup must not clear another owner's
  // observation after the active/internal presentation target changes.
  if(!ownerId||advancedDisplayOwner.current!==ownerId||value&&value.targetId!==ownerId)return;
  setAdvancedLayers(previous=>previous[ownerId]===value?previous:{...previous,[ownerId]:value});
 };},[activeId]);
 const publishConformerViewControls=useMemo(()=>{const ownerId=activeId;return(value:ReactNode|undefined)=>{
  if(!ownerId||advancedDisplayOwner.current!==ownerId)return;
  setConformerViewControls(previous=>previous[ownerId]===value?previous:{...previous,[ownerId]:value});
 };},[activeId]);
 const active=state.documents.find(entry=>entry.id===activeId);
 useTransientLayerScope(rootElement.current?.ownerDocument??(typeof document==='undefined'?null:document),JSON.stringify([taskWorkspace.opened?'tasks':state.module,activeId,advancedSection,activeId?activeAnalysisResults[activeId]?.result?.id:undefined]));
 const scrollPageKey=JSON.stringify([activeId,state.module,advancedSection,advancedModelingRoute]);
 useLayoutEffect(()=>{const root=rootElement.current;if(!root)return;for(const node of root.querySelectorAll<HTMLElement>('[data-page-scroll]')){const saved=pageScroll.current.get(scrollPageKey+':'+node.dataset.pageScroll);node.scrollTop=saved?.top??0;node.scrollLeft=saved?.left??0;}},[scrollPageKey]);
 function advancedSourceGeometryCurrent(source:AdvancedFrameSource){
  const key=JSON.stringify(source.ref),owner=capturedSourceOwners.current.get(key);
  const entry=registry.getSnapshot().documents.find(value=>value.id===(owner?.documentId??source.ref.documentId));
  if(!entry||entry.epoch!==(owner?.epoch??source.ref.documentEpoch))return false;
  const baseline=capturedSourceGeometry.current.get(key);
  return baseline!==undefined?baseline===workspaceSourceGeometryKey(entry.store.getSnapshot().draft.structure):entry.store.getSnapshot().revision===source.ref.revision;
 }
 function retainedAdvancedGeometrySource(controller:AdvancedController,source:AdvancedFrameSource){
  const task=controller.getSnapshot().tasks.find(task=>task.id===source.ref.taskId);
  const original=source.ref.runId?task?.runs.find(run=>run.id===source.ref.runId)?.frames.find(frame=>frame.id===source.ref.frameId)?.source:task?.guessFrames.find(frame=>frame.id===source.ref.frameId)?.source;
  return workspaceRetainedSourceGeometryMatches(original,source)&&(!capturedSourceGeometry.current.has(JSON.stringify(source.ref))||advancedSourceGeometryCurrent(source));
 }
 const guardedStores=useRef(new WeakSet<WorkspaceDocumentEntry['store']>());
 function protectedConformerSource(id:string,source=advancedObservationsRef.current[id]){const entry=registry.getSnapshot().documents.find(row=>row.id===id);if(entry?.conformerGroup)return entry.conformerGroup.role!=='initial';const task=source?.ref.taskId?advancedController?.getSnapshot().tasks.find(row=>row.id===source.ref.taskId):undefined;return !!task&&(task.spec.kind==='conformer-search'||!!task.mixedSampling);}
 function scientificFrameKey(id:string){const canvas=analysisCanvasesRef.current[id]??lastScientificCanvases.current.get(id);return JSON.stringify([canvas?.result?.id??null,canvas?.frameIndex??null,advancedObservationsRef.current[id]?.ref??null]);}
 const installAnalysisGuard=(entry:WorkspaceDocumentEntry)=>{if(!guardedStores.current.has(entry.store)){entry.store.setScientificEditGuard?.(createWorkspaceScientificEditGuard(entry,{
  currentEntry:()=>registry.getSnapshot().documents.find(row=>row.id===entry.id),
  currentTask:taskId=>advancedIntegration.current.controller?.getSnapshot().tasks.find(row=>row.id===taskId),
  confirm:(request,current)=>{
   const stamp=registry.stamp();if(stamp.documentId!==current.id||stamp.revision!==request.revision)return false;
   if(!editChoiceInFlight.current){const intent={request,stamp,frameKey:scientificFrameKey(current.id)};pendingEditRef.current=intent;setPendingEdit(intent);}
   return false;
  }
 }));guardedStores.current.add(entry.store);}return entry;};
 const postprocess=usePostprocessWorkspace({add:(result,document,options)=>{if(!document)return registry.addResultDocument(result).id;if(!options?.structure)throw Error('后处理来源尚未完成公共成键预备。');return installAnalysisGuard(registry.addAnalysisDocument(result,options.structure,document.id,options.activate!==false,options.initialModule)).id;},
  replace:(id,result,document,structure)=>{if(protectedConformerSource(id))throw Error('构象来源保持不变；请先在普通结构标签中替换外部文件。');if(document){if(!structure)throw Error('后处理来源尚未完成公共成键预备。');registry.replaceAnalysisDocument(id,result,structure,document.id);}else registry.replaceResultDocument(id,result);},
  attach:(id,_result,bindingId)=>{const entry=registry.document(id);if(entry.conformerGroup)throw Error('构象来源须先复制到普通结构标签。');installAnalysisGuard(entry);return registry.bindExistingAnalysis(id,bindingId);},available:registry.analysisAvailable,
  prepareRead:async id=>{
   if(!id||!protectedConformerSource(id))return;
   const stamp=registry.stamp();if(stamp.documentId!==id)throw Error('当前来源已切换，未载入外部文件。');
   const entry=registry.document(id),sourceEpoch=entry.sourceEpoch,frameKey=scientificFrameKey(id),pose=currentViewPose(id);
   if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;
   try{if(!await confirmConformerCopy(stamp,'file-import'))return null;registry.assertCurrent(stamp);if(entry.sourceEpoch!==sourceEpoch||scientificFrameKey(id)!==frameKey)throw Error('来源帧已变化，未载入外部文件。');}
   finally{sourceCopyBusy.current=false;}
   return{forceNew:true as const,onCreated:(created:string)=>{inheritedViews.current.set(created,pose);try{registry.assertCurrent(stamp);}catch{return;}setMainDocumentId(created);activateDocument(created);registry.setModule('analysis');}};
  },
  guardRemove:id=>{if(protectedConformerSource(id))throw Error('构象来源页面只读；不能移除原任务的输出或波函数。');},
  activate:id=>activateDocument(id),exists:id=>registry.getSnapshot().documents.some(entry=>entry.id===id),analyze:()=>registry.setModule('analysis'),onError:setError,onDiagnostics:addSourceDiagnostics,
  onFileDocument:()=>{registry.invalidateActivation();taskWorkspace.leave();},
 },activeId);
 const advancedPorts=useRef({postprocess});advancedPorts.current={postprocess};
 async function openExternalSnapshot(taskId:string,snapshotId:string,leaseId:string,canNavigate:()=>boolean){
  const projectEpoch=projectIdentityEpoch.current,bridge=taskWorkspace.bridge;
  const prior=taskSnapshotPagesRef.current[snapshotId],priorDocument=prior?postprocess.documents[prior.documentId]:undefined;
  const priorFile=prior?postprocess.captureFileDocuments()[prior.documentId]:undefined;
  if(prior&&priorFile?.output.source.identity.id===prior.sourceId){await bridge.request('snapshot.release',{snapshotId,leaseId});if(canNavigate()&&projectEpoch===projectIdentityEpoch.current){postprocess.selectFile(prior.documentId);registry.invalidateActivation();taskWorkspace.leave();registry.setModule('analysis');}return;}
  if(prior&&priorDocument?.result.source.id===prior.sourceId&&registry.getSnapshot().documents.some(row=>row.id===prior.documentId)&&registry.analysisAvailable(prior.documentId)){
   await bridge.request('snapshot.release',{snapshotId,leaseId});
   if(canNavigate()&&projectEpoch===projectIdentityEpoch.current){taskWorkspace.leave();setMainDocumentId(prior.documentId);activateDocument(prior.documentId);registry.setModule('analysis');}return;
  }
  if(postprocess.isBusy()){await bridge.request('snapshot.release',{snapshotId,leaseId});throw Error('后处理正在读取来源，请完成后再打开快照。');}
  const bundle=await openSnapshotProjectSources(bridge,{snapshotId,leaseId},{consumeInitialLease:true,companions:snapshotBridgeCompanions(bridge)});
  let created:string|undefined,navigate=false;
  try{
   if(bundle.description.taskId!==taskId)throw Error('任务与固定快照身份不匹配。');
   const guard=()=>{if(projectIdentityEpoch.current!==projectEpoch)throw Error('项目已切换，本次快照未写入新项目。');};
   const beforeCommit=async(document:PostprocessDocument)=>{guard();await bindSnapshotCompanionCandidates(document,bundle);guard();retainSnapshotPostprocessSources(document,bundle);};
   const beforeFileCommit=async(document:PostprocessScientificFileDocument)=>{
    guard();const selected=new Set(snapshotPostprocessSources(bundle).map(file=>file.snapshotIdentity.sourceRef));
    const extras:NonNullable<PostprocessScientificFileDocument['extraSources']>[number][]=[];
    try{
     for(const metadata of bundle.description.files.filter(file=>!selected.has(file.sourceRef))){
      const file=bundle.files.find(file=>file.snapshotIdentity.sourceRef===metadata.sourceRef);
      if(!file||file.name!==metadata.name||file.size!==metadata.byteSize||file.snapshotIdentity.sha256!==metadata.sha256||file.snapshotIdentity.snapshotId!==snapshotId||file.snapshotIdentity.taskId!==taskId||file.snapshotIdentity.libraryId!==bundle.description.libraryId)throw Error('附加原始资产不属于已授权固定快照。');
      const input=resultFile(file);extras.push({name:metadata.name,sourceId:metadata.sourceRef,revision:metadata.sha256,byteSize:metadata.byteSize,format:metadata.format??'unknown',role:metadata.roles.join(','),readRange:(start,end,signal)=>input.readRange(start,end,signal),dispose:()=>input.close?.()});
     }
     document.extraSources=extras;
    }catch(error){await Promise.allSettled(extras.map(extra=>extra.dispose()));throw error;}
   };
   const onCreated=(id:string)=>{
     created=id;navigate=canNavigate();
     const entry=registry.getSnapshot().documents.find(entry=>entry.id===id),file=postprocess.captureFileDocuments()[id],sourceId=file?.output.source.identity.id??entry?.analysisBinding?.result.source.id??entry?.result?.source.id??'';
     if(!sourceId)throw Error('后处理快照已接管，但来源身份未就绪。');
      const row={documentId:id,sourceId,taskId,runId:bundle.description.runId,libraryId:bundle.description.libraryId,sourceSetId:bundle.description.sourceSetId,sourceVersion:bundle.description.sourceVersion};
     const next={...taskSnapshotPagesRef.current,[snapshotId]:row};taskSnapshotPagesRef.current=next;setTaskSnapshotPages(next);
   };
   const generated=await readSnapshotGeneratedXtbPackage(bundle);guard();
   if(generated){
    await postprocess.addArchivedGeneratedXtb(generated,{guard,throwOnFailure:true,beforeCommit,onCreated});
   }else await postprocess.read(snapshotPostprocessSources(bundle),null,undefined,'smart',{
    guard,beforeCommit,beforeFileCommit,onCreated,throwOnFailure:true,
    reuseParsedOutput:file=>taskWorkspace.retainSnapshotResults(bundle,file),
    canNavigate:()=>projectIdentityEpoch.current===projectEpoch&&canNavigate(),
   });
   if(created&&navigate&&projectIdentityEpoch.current===projectEpoch&&canNavigate()){setMainDocumentId(created);taskWorkspace.leave();if(generated){activateDocument(created);registry.setModule('analysis');}}
  }finally{await bundle.close();}
 }
 function managedTaskControls(documentId:string,document:PostprocessDocument,running=false){
  const projectEpoch=projectIdentityEpoch.current,generated=postprocess.generated[documentId],ownerId=generated?.ownerId??documentId;
  const entry=registry.getSnapshot().documents.find(row=>row.id===ownerId),epoch=entry?.epoch;
  const source=Object.values(taskSnapshotPagesRef.current).find(row=>row.documentId===documentId&&row.sourceId===document.result.source.id);
  const origin:ManagedSourceOrigin|undefined=source?{kind:'task-snapshot',linkedTaskId:source.taskId,linkedRunId:source.runId,libraryId:source.libraryId,sourceSetId:source.sourceSetId,sourceVersion:source.sourceVersion}:generated?{kind:'xtb-generated'}:undefined;
  const association=source?.runId===null&&source.sourceSetId&&source.sourceVersion?{taskId:source.taskId,sourceSetId:source.sourceSetId,sourceVersion:source.sourceVersion}:undefined;
  const assertCurrent=()=>{
   const current=registry.getSnapshot().documents.find(row=>row.id===ownerId);
   if(projectIdentityEpoch.current!==projectEpoch||!current||current.epoch!==epoch||advancedPorts.current.postprocess.getDocument(documentId)!==document||!(generated?xtbWorkingAnalysisAvailable(ownerId,documentId):registry.analysisAvailable(ownerId)))throw Error('后处理来源已关闭或替换，未保存到另一任务。');
   const identity=document.wavefunction?.source.generatedXtb?.runIdentity;
   if(identity){const run=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===identity.taskId)?.runs.find(run=>run.id===identity.runId);if(run&&['queued','running','stopping'].includes(run.status))throw Error('关联GFN2运行尚未结束，不能保存为受管理任务。');}
  };
  return <PostprocessManagedTaskControls key={document.id} documentId={documentId} document={document} bridge={taskWorkspace.bridge} origin={origin} association={association} uiStore={projectUi} available={!running&&Boolean(entry)&&(generated?xtbWorkingAnalysisAvailable(ownerId,documentId):registry.analysisAvailable(ownerId))} assertCurrent={assertCurrent} onOpenTask={taskWorkspace.openTask}/>;
 }
 function activeResultFor(id:string,source:PostprocessDocument){
  const known=activeResultCallbacks.current.get(id);if(known?.source===source)return known.callback;
  const callback=(result:TrajectoryResult|null)=>{
   if(advancedPorts.current.postprocess.documents[id]!==source||!registry.getSnapshot().documents.some(entry=>entry.id===id)||result&&!registry.analysisAvailable(id))return;
   setActiveAnalysisResults(previous=>previous[id]?.source===source&&previous[id]?.result===result?previous:{...previous,[id]:{source,result}});
  };
  activeResultCallbacks.current.set(id,{source,callback});return callback;
 }
 function fileFrameFor(source:PostprocessScientificFileDocument){
  const known=fileObservedCallbacks.current.get(source.id);if(known?.source===source)return known.callback;
  const callback=(structure:Structure|null)=>{if(advancedPorts.current.postprocess.captureFileDocuments()[source.id]!==source)return;setFileObservedStructures(previous=>previous[source.id]===structure?previous:{...previous,[source.id]:structure});};
  fileObservedCallbacks.current.set(source.id,{source,callback});return callback;
 }
 const [advancedController,setAdvancedController]=useState<AdvancedController|null>(null);
 const subscribeAdvanced=useCallback((listener:()=>void)=>advancedController?.subscribe(()=>{advancedHydrationProjection.current.observe(JSON.stringify(advancedController.getSnapshot().tasks.map(task=>[task.id,task.runs.at(-1)?.status??'',task.revision??0])));listener();})??(()=>{}),[advancedController]);
 const readAdvanced=useCallback(()=>JSON.stringify(advancedController?.getSnapshot().tasks.map(task=>[task.id,task.runs.at(-1)?.status??'',task.revision??0])??[]),[advancedController]);
 const advancedStatusProjection=useSyncExternalStore(subscribeAdvanced,readAdvanced,readAdvanced);
 const advancedGroupStatuses=useMemo(()=>new Map<string,string>(JSON.parse(advancedStatusProjection)),[advancedStatusProjection]);
 useEffect(()=>advancedController?bindWorkspaceAdvancedConsumers(registry,advancedController):undefined,[registry,advancedController]);
 useEffect(()=>{const desktop=desktopBridge(),bridge=desktop?.startXtb&&desktop.commandXtb&&desktop.onXtbEvent?{startXtb:desktop.startXtb.bind(desktop),commandXtb:desktop.commandXtb.bind(desktop),onXtbEvent:desktop.onXtbEvent.bind(desktop),readXtbElectronicArtifacts:desktop.readXtbElectronicArtifacts?.bind(desktop),releaseXtbElectronicArtifacts:desktop.releaseXtbElectronicArtifacts?.bind(desktop),releaseXtbOptimizationCaches:desktop.releaseXtbOptimizationCaches?.bind(desktop)}:null;
 const pathBridge=desktop?.startAdvancedPath&&desktop.commandAdvancedPath&&desktop.onAdvancedPathEvent?{startAdvancedPath:desktop.startAdvancedPath.bind(desktop),commandAdvancedPath:desktop.commandAdvancedPath.bind(desktop),onAdvancedPathEvent:desktop.onAdvancedPathEvent.bind(desktop)}:null;
 const samplingBridge=desktop?.startConformerSampling&&desktop.commandConformerSampling&&desktop.onConformerSamplingEvent?{startConformerSampling:desktop.startConformerSampling.bind(desktop),commandConformerSampling:desktop.commandConformerSampling.bind(desktop),onConformerSamplingEvent:desktop.onConformerSamplingEvent.bind(desktop),readConformerSamplingResult:desktop.readConformerSamplingResult?.bind(desktop),releaseConformerSamplingResult:desktop.releaseConformerSamplingResult?.bind(desktop)}:null;
 const aissBridge=desktop?.startAiss&&desktop.commandAiss&&desktop.onAissEvent?{startAiss:desktop.startAiss.bind(desktop),commandAiss:desktop.commandAiss.bind(desktop),onAissEvent:desktop.onAissEvent.bind(desktop)}:null;
 const controller=new AdvancedController({bridge,pathBridge,samplingBridge,aissBridge,conformerBatchBridge:createDesktopConformerBatchBridge(desktop?.conformerBatchCommand&&desktop.onConformerBatchProgress?{conformerBatchCommand:desktop.conformerBatchCommand.bind(desktop),onConformerBatchProgress:desktop.onConformerBatchProgress.bind(desktop)}:null),resolveInitialSource:taskId=>captureConformerInitial(taskId),onConformerResultsReady:task=>advancedIntegration.current.prepare(task),resolveResources:()=>{const value=computeSnapshotRef.current;if(!value||!value.writable||value.error)throw Error('当前计算资源尚未就绪，请确认全局资源设置。');return value;},forcefieldAdapter:createAdvancedForcefieldAdapter(createChemistryPort()),
  workerResourceBridge:desktop?.acquireWorkerResources&&desktop.cancelWorkerResources&&desktop.releaseWorkerResources?{acquireWorkerResources:desktop.acquireWorkerResources.bind(desktop),cancelWorkerResources:desktop.cancelWorkerResources.bind(desktop),releaseWorkerResources:desktop.releaseWorkerResources.bind(desktop)}:undefined,
  currentSourceGuard:source=>{if(source.ref.taskId){if(retainedAdvancedGeometrySource(controller,source))return;throw Error('该高级结果帧的任务身份或内容不匹配。');}const entry=registry.document(source.ref.documentId);if(!advancedSourceGeometryCurrent(source))throw Error('高级任务来源结构已修改或关闭，请重新取用。');if(source.ref.sourceId&&entry.analysisBinding&&!registry.analysisAvailable(entry.id))throw Error('来源分析已失效，请重新取用有效结构帧。');},
  onElectronicResult:async(bundle,context)=>{
   const source=controller.getSnapshot().tasks.find(task=>task.id===context.taskId)?.spec.source;if(!source)throw Error('单点任务来源已关闭。');
   const owner=capturedSourceOwners.current.get(JSON.stringify(source.ref)),targetId=owner?.documentId??source.ref.documentId,target=registry.document(targetId),targetEpoch=target.epoch;
   const guard=()=>{const current=registry.document(targetId);if(current.epoch!==targetEpoch||current.conformerGroup||!advancedSourceGeometryCurrent(source))throw Error('单点来源已修改或关闭，原生产物保留但未关联迟到结果。');};guard();
   const id=await advancedPorts.current.postprocess.attachGeneratedToExisting(bundle,context,targetId,guard);if(!id)throw Error('GFN2受管结果暂未接入后处理，原生产物仍保留。');
   const key=`${context.taskId}:${context.deliveryRunId??context.runId}`;advancedAnalysisDocuments.current.set(key,id);setAdvancedAnalysisBindings(previous=>({...previous,[key]:id}));
  },
 });advancedIntegration.current.controller=controller;setAdvancedController(controller);return()=>{for(const value of conformerPrepared.current.values())value.abort.abort();conformerPrepared.current.clear();void controller.dispose();};},[registry]);
 const fileCurrent=state.module==='analysis'?postprocess.currentFile:null;
 const [fileSidebarCollapsed,setFileSidebarCollapsed]=useState<Record<string,boolean>>({});
 const currentFileSidebarCollapsed=Boolean(fileCurrent&&fileSidebarCollapsed[fileCurrent.id]);
 const analysisLayout=state.module==='analysis'&&(Boolean(fileCurrent)||!active?.result||Boolean(activeId&&postprocess.documents[activeId]));
 const advancedLayout=state.module==='advanced';
 const advancedModelingLayout=state.module==='advanced-modeling';
 const xtbAnalysisLayout=advancedLayout&&advancedSection==='xtb2';
 const selectedXtbAnalysisId=xtbAnalysisLayout&&activeId?xtbAnalysisSelections[activeId]:undefined;
 function xtbWorkingAnalysisAvailable(targetId:string|undefined,analysisId:string){
  const generated=postprocess.generated[analysisId];if(generated){const owner=registry.getSnapshot().documents.find(row=>row.id===generated.ownerId);
   return generated.ownerId===targetId&&!!owner&&(owner.store.getSnapshot().analysisBindingId===generated.bindingId
    ||workspaceRetainedXtbAnalysisAvailable({targetId,analysisId,ownerExists:true,generated,tasks:advancedController?.getSnapshot().tasks??[],bindings:advancedAnalysisBindings}));
  }
  const binding=targetId?xtbWorkingBindings.current.get(targetId):undefined;return registry.analysisAvailable(analysisId)&&(!binding||binding.analysisId!==analysisId||registry.document(targetId!).store.getSnapshot().analysisBindingId===binding.bindingId);
 }
 function xtbAnalysisSourceAvailable(analysisId:string,targetId?:string,taskId?:string,runId?:string){
  const generated=postprocess.generated[analysisId],identity=generated?.document.wavefunction?.source.generatedXtb?.runIdentity;
  if(taskId!==undefined||runId!==undefined){if(!identity||identity.taskId!==taskId||identity.runId!==runId||advancedAnalysisBindings[`${taskId}:${runId}`]!==analysisId)return false;}
  return xtbWorkingAnalysisAvailable(targetId??generated?.ownerId??activeId,analysisId);
 }
 const xtbAnalysisOwnerId=selectedXtbAnalysisId&&xtbWorkingAnalysisAvailable(activeId,selectedXtbAnalysisId)?selectedXtbAnalysisId:undefined;
 const publishXtbCanvas=useCallback((targetId:string,value:AnalysisCanvas|null)=>setXtbAnalysisCanvases(previous=>previous[targetId]===value?previous:{...previous,[targetId]:value}),[]);
 const publishXtbAnalysisSelection=useCallback((targetId:string,documentId:string|undefined)=>{
  if(documentId&&!advancedPorts.current.postprocess.generated[documentId]&&xtbWorkingBindings.current.get(targetId)?.analysisId!==documentId){const target=registry.document(targetId),snapshot=target.store.getSnapshot(),bindingId=snapshot.analysisBindingId??`xtb-observation:${crypto.randomUUID()}`;target.store.bindAnalysisContext?.(bindingId,snapshot.id,snapshot.revision);xtbWorkingBindings.current.set(targetId,{analysisId:documentId,bindingId});}
  setXtbAnalysisSelections(previous=>previous[targetId]===documentId?previous:{...previous,[targetId]:documentId});
 },[registry]);
 function xtbCanvasFor(entry:WorkspaceDocumentEntry){const binding=xtbWorkingBindings.current.get(entry.id);if(binding&&entry.store.getSnapshot().analysisBindingId!==binding.bindingId)return undefined;return (xtbAnalysisSelections[entry.id]&&xtbWorkingAnalysisAvailable(entry.id,xtbAnalysisSelections[entry.id]!)?analysisCanvases[xtbAnalysisSelections[entry.id]!]:undefined)??xtbAnalysisCanvases[entry.id]??advancedCanvases[entry.id];}
 const assertXtbTargetCurrent=useCallback((targetId:string)=>{const current=registry.getSnapshot(),view=current.views.find(value=>value.id===current.activeViewId);if(current.module!=='advanced'||advancedSectionRef.current!=='xtb2'||view?.documentId!==targetId)throw Error('当前XTB2显示对象已变化，请重新选择任务。');},[registry]);
 const publishTaskHighlights=useMemo(()=>{const targetId=activeId,ownedSource=targetId?advancedObservations[targetId]:undefined;return(value:{source:AdvancedFrameSource;atomIds:readonly string[]}|undefined)=>{
  if(!targetId||!advancedObservationPublicationCurrent(targetId,advancedDisplayOwner.current,ownedSource,advancedObservationsRef.current[targetId]))return;
  if(value&&!sameDisplaySource(value.source,advancedObservationsRef.current[targetId]))return;
  setAdvancedTaskHighlights(previous=>previous[targetId]===value?previous:{...previous,[targetId]:value});
 };},[activeId,advancedObservations]);
 const sharedLayout=((state.module==='modeling'||state.module==='input')&&!active?.result)||analysisLayout||advancedLayout||advancedModelingLayout;
 const advancedCanvases=useMemo<Record<string,AnalysisCanvas>>(()=>{
  if(!advancedLayout)return{};
  const canvases:Record<string,AnalysisCanvas>={};
  for(const entry of state.documents){if(entry.trajectory)continue;
   if(entry.conformerGroup?.role==='initial'&&!xtbAnalysisLayout){const task=advancedController?.getSnapshot().tasks.find(row=>row.id===entry.conformerGroup!.taskId),document=entry.store.getSnapshot(),candidate=advancedLayers[entry.id],layers=candidate?.targetId===entry.id&&advancedSourceGeometryCurrent(candidate.source)?candidate:undefined;
    if(!document.draft.structure.atoms.length)continue;
    canvases[entry.id]={document:layers?.previewStructure?{...document,draft:{...document.draft,structure:layers.previewStructure}}:document,staticDocument:document,modelEditingBlocked:Boolean(layers?.previewStructure),viewport:{displayFrozenAtomIds:task?.mixedSampling?.draft.protectedAtomIds??document.sharedConstraints?.frozenAtomIds??[],multiframeDisplay:layers?.multiframeDisplay,samplingSphere:layers?.samplingSphere,analysisAtomCapture:entry.id===activeId?advancedCapture:undefined},onViewReady:()=>{},onExport:()=>{},useWorkspaceImageExport:true,exportAvailable:true,exporting:false};continue;}
   const source=advancedObservations[entry.id];if(!source)continue;
   const retained=retainedAdvancedSource(advancedController?.getSnapshot()??{tasks:[],activeNative:null,queue:[],ignoredEvents:0,disposed:false},source);
   if(!source.ref.taskId&&!advancedSourceGeometryCurrent(source)||source.ref.taskId&&!retained)continue;
   const snapshot=entry.store.getSnapshot(),binding=advancedObservationBindings.current.get(entry.id);
   if(retained&&source.ref.taskId&&(!binding||!sameDisplaySource(binding.source,source)||snapshot.analysisBindingId!==binding.bindingId))continue;
   const candidate=advancedLayers[entry.id],layers=!xtbAnalysisLayout&&candidate?.targetId===entry.id&&sameDisplaySource(candidate.source,source)?candidate:undefined;
   const highlights=advancedTaskHighlights[entry.id],atomIds=!xtbAnalysisLayout&&highlights&&sameDisplaySource(highlights.source,source)?highlights.atomIds:undefined;
   const staticDocument=advancedDisplayDocument(snapshot,source);
   const displayDocument=layers?.previewStructure?{...staticDocument,draft:{...staticDocument.draft,structure:layers.previewStructure}}:staticDocument;
   canvases[entry.id]={document:displayDocument,staticDocument,modelEditingBlocked:Boolean(layers?.previewStructure),prepareModelEdit:()=>structuredClone(source.structure),measurementOwnerKey:JSON.stringify(source.ref),viewport:{analysisAtomCapture:!xtbAnalysisLayout&&entry.id===activeId?advancedCapture:undefined,multiframeDisplay:layers?.multiframeDisplay,samplingSphere:layers?.samplingSphere,resultHighlights:atomIds?{atomIds:[...atomIds],bondPairs:[]}:undefined,viewTransform:identityTransform()},onViewReady:()=>{},onExport:()=>{},useWorkspaceImageExport:true,exportAvailable:true,exporting:false};
  }return canvases;
 },[advancedLayout,xtbAnalysisLayout,activeId,advancedObservations,registry,advancedCapture,advancedLayers,advancedTaskHighlights,state.version,advancedStatusProjection]);
 const trajectoryCanvases=useMemo<Record<string,AnalysisCanvas>>(()=>{
  const values:Record<string,AnalysisCanvas>={};
  for(const entry of state.documents){const base=analysisCanvases[entry.id],binding=entry.trajectory;if(!base||!binding)continue;
   const task=advancedController?.getSnapshot().tasks.find(task=>task.id===binding.identity.taskId),observed=conformerTrajectoryObservedSource(binding,task);
   const candidate=advancedLayout&&advancedSection==='conformer'?advancedLayers[entry.id]:undefined;
   const layers=candidate?.targetId===entry.id&&sameDisplaySource(candidate.source,observed)?candidate:undefined;
   const controls=advancedLayout&&advancedSection==='conformer'?conformerViewControls[entry.id]:null;
   const owned=task?conformerPlaybackFrameIndex(task).get(binding.currentFrameId):undefined;
   // The common player owns the full collection fit and applies each transform
   // once. Scientific protection and temporary capture remain Shell-owned.
   const document=layers?.previewStructure&&base.document?{...base.document,draft:{...base.document.draft,structure:layers.previewStructure}}:base.document;
   values[entry.id]={...base,document,modelEditingBlocked:base.modelEditingBlocked||Boolean(layers?.previewStructure),controls:controls?<>{base.controls}{controls}</>:base.controls,viewport:{...base.viewport,displayFrozenAtomIds:task&&owned?conformerFrameProtection(task,owned):[],analysisAtomCapture:advancedLayout&&advancedSection==='conformer'&&entry.id===activeId?advancedCapture:undefined,...layers?{samplingSphere:layers.samplingSphere}:{}}};
  }return values;
 },[state.version,analysisCanvases,advancedLayout,advancedSection,advancedLayers,conformerViewControls,activeId,advancedCapture]);
 const observedAdvancedSource=activeId?advancedObservations[activeId]:undefined;
 const advancedDisplayedSource=active?.trajectory?conformerTrajectoryObservedSource(active.trajectory,advancedController?.getSnapshot().tasks.find(task=>task.id===active.trajectory!.identity.taskId)):active?.conformerGroup?.role==='initial'&&observedAdvancedSource&&(!advancedSourceGeometryCurrent(observedAdvancedSource)||workspaceSourceGeometryKey(observedAdvancedSource.structure)!==workspaceSourceGeometryKey(active.store.getSnapshot().draft.structure))?undefined:observedAdvancedSource;
 function observeAdvancedSource(target:string,source:AdvancedFrameSource){
  const targetEntry=registry.document(target);
  if(targetEntry.trajectory){
   const frameId=source.ref.frameId;
   if(frameId&&targetEntry.trajectory.frameIds.includes(frameId))registry.selectTrajectoryFrame(target,frameId);
   else if(source.ref.documentId!==target&&registry.getSnapshot().documents.some(entry=>entry.id===source.ref.documentId)){
    const parentView=registry.getSnapshot().views.find(view=>view.documentId===source.ref.documentId);
    if(parentView)registry.activate(parentView.id);
    setMainDocumentId(source.ref.documentId);observeAdvancedSource(source.ref.documentId,source);return;
   }
  }
  const entry=registry.document(target),snapshot=entry.store.getSnapshot();
  if(source.ref.taskId){const bindingId=snapshot.analysisBindingId??`advanced-observation:${crypto.randomUUID()}`;entry.store.bindAnalysisContext?.(bindingId,snapshot.id,snapshot.revision);advancedObservationBindings.current.set(target,{source,bindingId});installAnalysisGuard(entry);}
  advancedObservationSerial.current++;setAdvancedObservations(previous=>({...previous,[target]:source}));
 }
 useEffect(()=>{if(!advancedLayout||xtbAnalysisLayout||!activeId)return;const previous=advancedObservations[activeId],entry=registry.document(activeId);if(entry.trajectory||!entry.store.getSnapshot().draft.structure.atoms.length)return;if(entry.store.hasTransaction?.())return;if(previous&&(entry.conformerGroup?.role!=='initial'&&retainedAdvancedSource(advancedController?.getSnapshot()??{tasks:[],activeNative:null,queue:[],ignoredEvents:0,disposed:false},previous)||previous.ref.documentId===entry.id&&previous.ref.documentEpoch===entry.epoch&&previous.ref.revision===entry.store.getSnapshot().revision&&(entry.conformerGroup?.role!=='initial'||workspaceSourceGeometryKey(previous.structure)===workspaceSourceGeometryKey(entry.store.getSnapshot().draft.structure))))return;let alive=true;const serial=advancedObservationSerial.current;void captureCurrentAdvancedSource(false).then(source=>{if(alive&&serial===advancedObservationSerial.current)setAdvancedObservations(values=>({...values,[activeId]:source}));}).catch(cause=>{if(alive&&serial===advancedObservationSerial.current)setError(cause instanceof Error?cause.message:String(cause));});return()=>{alive=false;};},[advancedLayout,xtbAnalysisLayout,activeId,state.version]);
 const inputTask=state.inputTask,inputOwnerId=inputTask?.documentId;
 const documents=[...state.documents].sort((a,b)=>{const ai=order.indexOf(a.id),bi=order.indexOf(b.id);return(ai<0?1e9:ai)-(bi<0?1e9:bi);});
 const pendingConformerInitialEdit=Boolean(pendingEdit&&documents.find(entry=>entry.id===pendingEdit.request.documentId)?.conformerGroup?.role==='initial');
 const tabDocuments:WorkspaceDocumentEntry[]=[],tabGroupsSeen=new Set<string>();
 for(const entry of documents){if(detached[entry.id]||retiredConformerReader(entry))continue;const group=entry.conformerGroup?.taskId;
  if(!group){tabDocuments.push(entry);continue;}if(tabGroupsSeen.has(group))continue;tabGroupsSeen.add(group);
  tabDocuments.push(...documents.filter(value=>value.conformerGroup?.taskId===group&&!detached[value.id]&&!retiredConformerReader(value)).sort((a,b)=>Number(b.conformerGroup?.role==='initial')-Number(a.conformerGroup?.role==='initial')||(a.conformerGroup?.role==='initial'?a.conformerGroup.initialIndex??0:0)-(b.conformerGroup?.role==='initial'?b.conformerGroup.initialIndex??0:0)));
 }
 const internalModels=documents.filter(entry=>(!entry.result||analysisLayout&&Boolean(postprocess.documents[entry.id])||advancedLayout&&entry.id===activeId)&&!detached[entry.id]);
 const displayedDocumentId=sharedLayout?(internalModels.some(entry=>entry.id===activeId)?activeId:internalModels.some(entry=>entry.id===mainDocumentId)?mainDocumentId:internalModels[0]?.id):activeId;
 const presentationOwner=useRef(displayedDocumentId);presentationOwner.current=displayedDocumentId;
 const presentationCallbacks=useRef(new Map<string,{onToolbarSurfaceChange(surface:ReactNode):void;onLegendSurfaceChange(surface:ReactNode):void}>());
 function presentationFor(id:string){let value=presentationCallbacks.current.get(id);if(!value){value={onToolbarSurfaceChange:node=>{if(presentationOwner.current===id)toolbarSurface.publish(node);},onLegendSurfaceChange:node=>{if(presentationOwner.current===id)legendSurface.publish(node);}};presentationCallbacks.current.set(id,value);}return value;}
 const documentSignature=state.documents.map(entry=>entry.id).join('|');
 useEffect(()=>{for(const entry of registry.getSnapshot().documents)installAnalysisGuard(entry);},[documentSignature,registry]);
 useEffect(()=>{for(const entry of registry.getSnapshot().documents)if(!entry.result)installAnalysisGuard(entry);},[registry,documentSignature]);
 const portableToolsAvailable=Boolean(desktop?.portableTools);
 const linkedControls=useLinkedWorkspace(registry,activeId,id=>{
  const entry=registry.getSnapshot().documents.find(item=>item.id===id);
  return Boolean(entry&&!entry.result&&!reading&&!closingTransactions.current.has(id)&&!['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase)&&!viewportControllers.current.get(id)?.isBusy());
 },()=>{setSourcePick(null);setDeckMode(value=>value==='single'?'tiled':value);changeDisplaySettings({...displaySettings,atomNumbers:true,elementNames:true});},setError);
 const selectingMembers=useRef(false);selectingMembers.current=linkedControls.selecting;
 const linkedControlsLive=useRef(linkedControls);linkedControlsLive.current=linkedControls;
 const [availableWidth,setAvailableWidth]=useState(()=>Math.max(800,window.innerWidth-66));
 useLayoutEffect(()=>{const node=rootElement.current?.querySelector('.workspace-document-area');if(!node)return;const resize=()=>setAvailableWidth(node.getBoundingClientRect().width);resize();const observer=new ResizeObserver(resize);observer.observe(node);return()=>observer.disconnect();},[]);
 useLayoutEffect(()=>{const target=legendHostId?rootElement.current?.querySelector<HTMLElement>(`.model-document-pane[data-document-id="${legendHostId}"] .model-transform-candidate [data-testid="model-viewport"]`)??rootElement.current?.querySelector<HTMLElement>(`.model-document-pane[data-document-id="${legendHostId}"] [data-testid="model-viewport"]`):null;setLegendTarget(target??null);},[legendHostId,sharedLayout,documentSignature,deckMode,state.module]);
 useEffect(()=>{if(sourcePick&&(inputOwnerId!==sourcePick.ownerId||state.module!=='input'))setSourcePick(null);},[inputOwnerId,state.module,sourcePick]);
 const maintenanceDisabled=reading||Boolean(closingPending)||state.documents.some(entry=>['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase));
 useEffect(()=>{if(displayedDocumentId&&sharedLayout)setMainDocumentId(displayedDocumentId);},[displayedDocumentId,sharedLayout]);
 const requestPortableTools=useCallback((request:PortableToolsRequest):Promise<PortableToolsResponse>=>{
  if(!desktop?.portableTools)return Promise.reject(new Error('便携运行数据接口不可用。'));return desktop.portableTools(request);
 },[desktop]);
 const activateDocument=useCallback((id:string,fromExternal=false)=>{
  if(sourcePickLive.current||selectingMembers.current)return;
  const documentId=id;
  const view=registry.getSnapshot().views.find(value=>value.documentId===documentId);
  if(!view)return;flushSync(()=>{
   advancedPorts.current.postprocess.selectFile(null);
   registry.activate(view.id);
   if(!detachedPlacement.current[documentId])setMainDocumentId(documentId);
  });
 },[registry]);
 function retiredConformerReader(entry:WorkspaceDocumentEntry){return entry.conformerGroup?.role==='collection'&&entry.trajectory?.identity.collectionId.endsWith(':interrupted')===true;}
 // Older projects may contain an automatically generated interrupted reader.
 // Preserve its saved data and task provenance, but retire this removed view.
 useEffect(()=>{const snapshot=registry.getSnapshot(),id=snapshot.views.find(view=>view.id===snapshot.activeViewId)?.documentId,entry=snapshot.documents.find(row=>row.id===id);if(!entry||!retiredConformerReader(entry))return;const initial=snapshot.documents.find(row=>row.conformerGroup?.taskId===entry.conformerGroup?.taskId&&row.conformerGroup?.role==='initial');if(initial)activateDocument(initial.id);},[registry,state.version,activateDocument]);
 function openConformerCollection(collection:ConformerResultCollection,frameId?:string,options?:{activate?:boolean}){
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===collection.identity.taskId);
  collection=projectConformerPlaybackCollection(collection,task);
  if(collection.playbackAvailable===false)return;
  conformerCollectionPublisher.current.publish(collection,frameId,options,conformerPublicationPorts());
 }
 function conformerCollectionsFor(task:AdvancedTaskRecord){
  const cached=conformerCollectionCache.current.get(task);if(cached)return cached;
  const spec=task.spec,stages=restoreConformerStages(spec.kind==='conformer-search'?spec.search.stages:spec.kind==='sampling'||spec.kind==='docking'?spec.optimizationStages:[]);
  const collections=buildConformerResultCollections(task,stages).map(collection=>projectConformerPlaybackCollection(collection,task));
  conformerCollectionCache.current.set(task,collections);return collections;
 }
 function conformerFrameProtection(task:AdvancedTaskRecord,frame:AdvancedResultFrame):readonly string[]{
  let current=frame;const frames=conformerPlaybackFrameIndex(task),seen=new Set<string>();
  while(!current.samplingOrigin&&!seen.has(current.id)){seen.add(current.id);const parent=current.parentRef.frameId?frames.get(current.parentRef.frameId):undefined;if(!parent)break;current=parent;}
  return current.samplingOrigin?.protectedAtomIds??frame.source.constraints.frozenAtomIds;
 }
 function preparedConformerCollection(collection:ConformerResultCollection,task:AdvancedTaskRecord){
  collection=projectConformerPlaybackCollection(collection,task);
  if(collection.playbackAvailable===false)throw Error('当前归簇包含不可用代表，不能发布为完整播放集合。');
  const key=workspaceTrajectoryKey(collection.identity),signature=JSON.stringify([collection.identity,collection.includeEnergies,collection.frames.map(frame=>[frame.id,frame.source.stamp.coordinatesFingerprint,frame.energyHartree])]);
  const old=conformerPrepared.current.get(key);if(old?.signature===signature)return old;
  old?.abort.abort();
  const reference=createConformerPlaybackResolver(task)(collection.frames[0]).referenceSource;
  const candidate=createConformerTrajectory({...collection,referenceStructure:reference?.structure??collection.frames[0].source.structure,protectedAtomIds:reference?.constraints.frozenAtomIds??[]});
  const existing=registry.getSnapshot().documents.find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===key);
  const result=restoredConformerPublicationResult(candidate,existing),abort=new AbortController();
  const record={signature,result,abort,ready:Promise.resolve()};
  record.ready=prepareConformerPublication(result,{signal:abort.signal}).then(()=>{}).catch(cause=>{if(conformerPrepared.current.get(key)===record)conformerPrepared.current.delete(key);throw cause;});
  conformerPrepared.current.set(key,record);return record;
 }
 async function prepareConformerTask(task:AdvancedTaskRecord){
  const collections=conformerCollectionsFor(task);
  for(const collection of collections){
   if(!collection.frames.length||collection.playbackAvailable===false)continue;
   const prepared=preparedConformerCollection(collection,task);await prepared.ready;
   const current=advancedIntegration.current.controller?.getSnapshot().tasks.find(row=>row.id===task.id);
   if(!current||!conformerCollectionMatchesCurrent(collection,conformerCollectionsFor(current)))throw Error('构象结果在准备期间已改变，未发布过期集合。');
  }
  // This callback is awaited by the task owner before a successor can claim
  // native resources. A mounted player cannot cancel this preparation.
  for(const collection of collections)openConformerCollection(collection,undefined,{activate:false});
 }
 advancedIntegration.current.prepare=prepareConformerTask;
 function conformerPublicationPorts(){return {
  owner:(collection:ConformerResultCollection)=>registry.getSnapshot().documents.find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===workspaceTrajectoryKey(collection.identity)),
  closing:(id:string)=>closingTransactions.current.has(id),
  current:(collection:ConformerResultCollection)=>{
   const tasks=advancedController?.getSnapshot().tasks??[],task=tasks.find(task=>task.id===collection.identity.taskId);if(!task)return false;
   return conformerCollectionMatchesCurrent(collection,conformerCollectionsFor(task))&&(!collection.frames.length||conformerCollectionSourcesCurrent(collection,tasks));
  },
  revision:(identity:import('../../modeling/workspace-contracts').WorkspaceTrajectoryIdentity)=>conformerCollectionRevision(advancedController?.getSnapshot().tasks.find(task=>task.id===identity.taskId)),
  open:(collection:ConformerResultCollection,frameId?:string,options?:{activate?:boolean})=>{const epoch=projectIdentityEpoch.current;void openConformerCollectionNow(collection,frameId,options).catch(cause=>{if(epoch===projectIdentityEpoch.current&&!(cause instanceof Error&&cause.name==='AbortError'))setError(cause instanceof Error?cause.message:String(cause));});},
 };}
 async function openConformerCollectionNow(collection:ConformerResultCollection,frameId?:string,options?:{activate?:boolean}){
  const identity=collection.identity,key=workspaceTrajectoryKey(identity);
  const existing=registry.getSnapshot().documents.find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===key);
  const current=registry.getSnapshot(),currentId=current.views.find(view=>view.id===current.activeViewId)?.documentId;
  const inContext=!taskWorkspace.isOpen()&&current.module==='advanced'&&advancedSectionRef.current==='conformer'&&current.documents.find(entry=>entry.id===currentId)?.conformerGroup?.taskId===identity.taskId;
  const activate=inContext&&options?.activate!==false;
  if(!inContext&&!existing||!collection.frames.length&&!existing)return;
  if(!collection.frames.length){
   conformerPrepared.current.get(key)?.abort.abort();conformerPrepared.current.delete(key);
   if(existing&&!closingTransactions.current.has(existing.id))void close(existing.id,true);
   return;
  }
  const task=advancedController?.getSnapshot().tasks.find(value=>value.id===identity.taskId);
  if(!task)return;
  collection=projectConformerPlaybackCollection(collection,task);
  if(collection.playbackAvailable===false)return;
  const prepared=preparedConformerCollection(collection,task);await prepared.ready;
  if(conformerPrepared.current.get(key)!==prepared||!conformerPublicationPorts().current(collection))return;
  const now=registry.getSnapshot(),nowId=now.views.find(view=>view.id===now.activeViewId)?.documentId;
  const stillInContext=!taskWorkspace.isOpen()&&now.module==='advanced'&&advancedSectionRef.current==='conformer'&&now.documents.find(entry=>entry.id===nowId)?.conformerGroup?.taskId===identity.taskId;
  if(existing&&(!now.documents.some(entry=>entry.id===existing.id&&entry.epoch===existing.epoch)||closingTransactions.current.has(existing.id)))return;
  const entry=installAnalysisGuard(registry.openTrajectoryDocument(prepared.result,identity,collection.frames.map(frame=>frame.id),activate&&stillInContext));
  if(frameId)registry.selectTrajectoryFrame(entry.id,frameId);
  if(activate&&stillInContext){setMainDocumentId(entry.id);setError('');}
 }
 function captureConformerInitial(taskId:string):AdvancedFrameSource{
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===taskId);
  const entry=conformerInitialDocument(task,registry.getSnapshot().documents);
  if(!entry||closingTransactions.current.has(entry.id))throw Error('本任务初始结构页已关闭，不能取用其他页面作为初始来源。');
  if(entry.store.hasTransaction?.())throw Error('请先确认或取消初始结构的几何预览。');
  const document=entry.store.getSnapshot();
  entry.store.bindAnalysisContext?.(document.analysisBindingId??`conformer:${taskId}:${entry.id}`,document.id,document.revision);
  const source=captureAdvancedFrame(document.draft.structure,{documentId:entry.id,documentEpoch:entry.epoch,revision:document.revision},makeDocumentStamp(document),entry.label,document.sharedConstraints);
  const key=JSON.stringify(source.ref);capturedSourceOwners.current.set(key,{documentId:entry.id,epoch:entry.epoch});capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(document.draft.structure));return source;
 }
 async function commitConformerCoreChange(taskId:string,atomIds:readonly string[]):Promise<boolean>{
  const controller=advancedIntegration.current.controller;if(!controller)throw Error('构象任务尚未连接。');
  const plan=controller.prepareProtectionChange(taskId,[...atomIds]);plan.assertCurrent();plan.commit();await plan.release();return true;
 }
 function bindConformerTask(taskId:string,source:AdvancedFrameSource){
  const task=advancedController?.getSnapshot().tasks.find(value=>value.id===taskId);
  const bound=conformerInitialDocument(task,registry.getSnapshot().documents);
  if(bound)return;
  const current=registry.stamp().documentId;
  let entry=registry.document(current);
  // A second task gets its own initial page; the first task's page stays put.
  if(entry.conformerGroup&&entry.conformerGroup.taskId!==taskId){
   entry=registry.addFragmentDocument(advancedFrameFragment(source),source.label);
   registry.setModule('advanced');setMainDocumentId(entry.id);
  }
  const initial=task?.mixedSampling?.initialGuesses.find(value=>value.id===task.mixedSampling?.selectedInitialGuessId);
  registry.bindConformerGroup(entry.id,taskId,'initial',initial?.id??`${taskId}-initial-1`,1);
  installAnalysisGuard(entry);
  // The bound initial page, including a copied new-search page, is the owner
  // of subsequent previews and captures. Do not retain the parent's document ref.
  const currentSource=captureConformerInitial(taskId);
  advancedController?.updateInitialSource(taskId,currentSource);
  observeAdvancedSource(entry.id,currentSource);
  setConformerGroups(previous=>previous[taskId]?previous:{...previous,[taskId]:{label:'搜索-'+entry.label.replace(/ · 帧 \d+$/,''),collapsed:false,samplingOperation:conformerSamplingChoice}});
 }
 function openConformerInitialFrame(taskId:string,initialId:string,source:AdvancedFrameSource){
  const task=advancedController?.getSnapshot().tasks.find(value=>value.id===taskId),initials=task?.mixedSampling?.initialGuesses;
  const initialIndex=(initials?.findIndex(value=>value.id===initialId)??-1)+1,initial=initials?.[initialIndex-1];
  if(!initial)return;
  source=initial.source;
  let entry=conformerInitialDocument(task,registry.getSnapshot().documents,initialId);
  if(!entry){entry=registry.addFragmentDocument(advancedFrameFragment(source),source.label);registry.bindConformerGroup(entry.id,taskId,'initial',initialId,initialIndex||undefined);}
  installAnalysisGuard(entry);
  const view=registry.getSnapshot().views.find(value=>value.documentId===entry.id);if(view)registry.activate(view.id);
  registry.setModule('advanced');setMainDocumentId(entry.id);
 }
 function changeConformerElectronicState(taskId:string,initialId:string,source:AdvancedFrameSource,electronic:AdvancedElectronicState){
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===taskId);
  const entry=assertConformerInitialElectronicOwner(task,registry.getSnapshot().documents,initialId,source);
  if(closingTransactions.current.has(entry.id))throw Error('本任务初始结构页正在关闭，请重新操作。');
  if(!validAdvancedElectronicDraft(electronic))throw Error('搜索电荷或多重度无效。');
  const model=entry.store.getSnapshot().draft.structure;
  if(model.charge!==electronic.charge||model.multiplicity!==electronic.multiplicity)entry.store.setElectronicState(electronic.charge,electronic.multiplicity,false);
 }
 const changeSourceElectronicState=useMemo(()=>{
  const owner=activeId?registry.stamp():null,displayed=activeId?advancedObservations[activeId]:undefined;
  return(source:AdvancedFrameSource,electronic:AdvancedElectronicState)=>{
   if(!owner||!advancedElectronicOwnerCurrent(owner,registry.stamp(),source,displayed)
    ||!sameDisplaySource(displayed,advancedObservationsRef.current[owner.documentId])
    ||advancedDisplayOwner.current!==owner.documentId)throw Error('电子态所属结构或显示帧已变化，请重新操作。');
   const entry=registry.assertCurrent(owner),model=entry.store.getSnapshot().draft.structure;
   if(source.ref.taskId?!advancedController||!retainedAdvancedGeometrySource(advancedController,source):!advancedSourceGeometryCurrent(source))throw Error('电子态来源已变化，请重新取用。');
   if(!validAdvancedElectronicDraft(electronic)||source.structure.atoms.length!==model.atoms.length||source.structure.atoms.some((atom,index)=>atom.id!==model.atoms[index]?.id||atom.element!==model.atoms[index]?.element))throw Error('电子态与当前结构身份不一致。');
   // Confirmation belongs to each entry point, while shared numeric edits revoke
   // the modeling confirmation. Retained task/run sources are never rewritten.
   if(model.charge!==electronic.charge||model.multiplicity!==electronic.multiplicity)entry.store.setElectronicState(electronic.charge,electronic.multiplicity,false);
  };
 },[activeId,state.activeViewId,state.activationEpoch,state.version,advancedObservations,registry,advancedController]);
 function changeSourceProtection(source:AdvancedFrameSource,atomIds:readonly string[]){
  const entry=registry.document(registry.stamp().documentId),ids=new Set(entry.store.getSnapshot().draft.structure.atoms.map(atom=>atom.id));
  if(source.ref.taskId?!advancedController||!retainedAdvancedGeometrySource(advancedController,source):!advancedSourceGeometryCurrent(source))throw Error('保护来源已变化，请重新取用。');
  if(source.structure.atoms.length!==ids.size||source.structure.atoms.some(atom=>!ids.has(atom.id))||atomIds.some(id=>!ids.has(id)))throw Error('保护原子与当前结构身份不一致。');
  entry.store.execute({type:'replace-shared-atom-freezes',atomIds:[...atomIds]});
 }
 function conformerFrameOrder(collectionId:string,frames:readonly AdvancedResultFrame[]){
  const publish=()=>{
   const entry=registry.getSnapshot().documents.find(entry=>entry.trajectory?.identity.collectionId===collectionId&&frames.every(frame=>frame.taskId===entry.trajectory!.identity.taskId));
   if(!entry||closingTransactions.current.has(entry.id))return false;
   const next=captureConformerFrameOrder(entry,collectionId,frames);if(!next)return false;
   setConformerFrameOrders(previous=>JSON.stringify(previous[entry.id])===JSON.stringify(next)?previous:{...previous,[entry.id]:next});return true;
  };
  // A child sorting effect can precede its parent's synchronous reader update.
  // Rebind once after that commit; removed frames still cannot pass membership.
  if(!publish())queueMicrotask(()=>publish());
 }
 function ownedTrajectory(entry:WorkspaceDocumentEntry){
  if(!entry.legacyResult?.frames.length)return null;
  const trajectory=entry.trajectory;
  const task=trajectory?advancedController?.getSnapshot().tasks.find(task=>task.id===trajectory.identity.taskId):undefined;
  const collection=task&&trajectory?conformerCollectionsFor(task).find(value=>workspaceTrajectoryKey(value.identity)===workspaceTrajectoryKey(trajectory.identity)):undefined;
  let playbackCollection:ReturnType<typeof createAdvancedPlaybackCollection>|undefined;
  if(collection&&task){
   const ownerId=JSON.stringify([entry.id,entry.epoch,projectIdentityEpoch.current]),cached=conformerPlayerCollections.current.get(entry.id);
   if(cached?.result===entry.legacyResult&&cached.collection===collection&&cached.ownerId===ownerId)playbackCollection=cached.value;
   else{
    const reference=collection.frames[0]?createConformerPlaybackResolver(task)(collection.frames[0]).referenceSource:undefined;
    playbackCollection=createAdvancedPlaybackCollection(entry.legacyResult,collection,reference,ownerId);
    conformerPlayerCollections.current.set(entry.id,{result:entry.legacyResult,collection,ownerId,value:playbackCollection});
   }
  }
  const order=conformerPlaybackOrder(entry,conformerFrameOrders[entry.id]);
  const visible=entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId;
  const activeHere=(analysisLayout||Boolean(trajectory&&(advancedLayout&&advancedSection==='conformer'||state.module==='modeling'||state.module==='input')))&&visible&&!ownerHidden&&!taskWorkspace.opened&&!closingPending;
  return <div hidden><TrajectoryWorkspace onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} result={entry.legacyResult} modelDocument={entry.store.getSnapshot()} available={registry.analysisAvailable(entry.id)} onCanvas={canvasFor(entry.id)} toolHost={analysisToolHosts[entry.id]??null}
    canvasOnly={Boolean(trajectory)} playbackCollection={playbackCollection} selectedFrameIndex={trajectory?trajectory.frameIds.indexOf(trajectory.currentFrameId):undefined} frameOrder={order}
    onScientificFrame={value=>{trajectoryFrames.current.set(entry.id,value);if(trajectory&&value.resultId===entry.legacyResult?.id){const id=trajectory.frameIds[value.frameIndex];if(id)registry.selectTrajectoryFrame(entry.id,id);}}}
    active={activeHere} displaySettings={displaySettings} onDisplaySettingsChange={changeDisplaySettings} onExtract={extractFrame} onPrepareIrc={entry.legacyResult.engine==='gaussian'||entry.legacyResult.engine==='orca'?structure=>prepareIrc(structure,entry.legacyResult!.engine as 'gaussian'|'orca'):undefined} onExport={exportWorkspaceResult} onError={setError}/></div>;
 }
 function selectTaskSource(id:string){
  const pending=sourcePickLive.current;if(!pending)return;
  try{registry.assertInputCurrent(pending.stamp);const selected=registry.source(id);if(!selected.structure.atoms.length)throw new Error('该模型没有原子，不能作为结构来源。');pending.request.onPick(selected);sourcePickLive.current=null;setSourcePick(null);setError('');}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function requestTaskSource(ownerId:string,request:StructureSourcePickRequest){
  if(selectingMembers.current)throw new Error('请先确认或取消关联成员选择。');
  if(registry.getSnapshot().inputTask?.documentId!==ownerId)throw new Error('输入任务已切换，请重新选择来源。');
  const pending={ownerId,stamp:registry.inputStamp(),request};sourcePickLive.current=pending;setSourcePick(pending);setDeckMode(value=>value==='single'?'tiled':value);setError('');
 }
 async function importTaskSources(ownerId:string,files:File[]):Promise<InputStructureSource[]>{
  const stamp=registry.inputStamp();if(stamp.documentId!==ownerId)throw new Error('输入任务所属文档已切换。');
  const parsed=(await importStructureFiles(files)).map(withAtomIds);registry.assertInputCurrent(stamp);
  if(!parsed.length)throw new Error('文件中没有可用的完整结构。');
  const ids=parsed.map(structure=>registry.addSourceDocument(structure).id);
  setDeckMode(value=>value==='single'?'tiled':value);
  return ids.map(registry.source);
 }
 function startNewInputTask(id:string){
  try{const previous=registry.getSnapshot().inputTask;
   if(borrowedBatchRef.current)throw Error('请先完成或取消当前批量输入会话。');
   if(inputControllers.current.get(id)?.isBusy()||previous&&inputControllers.current.get(previous.documentId)?.isBusy())throw new Error('输入正在处理，请完成或取消后再新建。');
   registry.beginInputTask(id);inputControllers.current.get(id)?.cancel();inputControllers.current.get(id)?.reset();
   setSourceRoles({});setSourcePick(null);sourcePickLive.current=null;registry.setModule('input');setNewInputTarget(null);setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function requestNewInputTask(){
  const snapshot=registry.getSnapshot(),id=snapshot.views.find(view=>view.id===snapshot.activeViewId)?.documentId;
  if(!id||registry.document(id).result){setError('请先激活一个可编辑模型。');return;}
  const previous=registry.document(id);
  if(previous&&(previous.inputDirty.gaussian||previous.inputDirty.orca))setNewInputTarget(id);else startNewInputTask(id);
 }
 function navigateModule(module:WorkspaceModule){
  taskWorkspace.leave();
  if(module==='input'&&borrowedBatchRef.current){activateDocument(borrowedBatchRef.current.documentId);registry.setModule('input');return;}
  if(module==='input'&&activeId&&(active?.trajectory||state.module==='advanced'&&advancedObservationsRef.current[activeId]?.ref.taskId)){
   void captureCurrentAdvancedSource().then(source=>prepareAdvancedInput(source)).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));return;
  }
  try{registry.setModule(module);setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 async function readCurrentWorkspaceSource(preferObserved=true,editingContext=false):Promise<ElectronicStateSourceContext>{
  const stamp=registry.stamp(),entry=registry.document(stamp.documentId),snapshot=entry.store.getSnapshot();
  if(preferObserved&&entry.trajectory&&registry.analysisAvailable(entry.id)&&advancedController){
   const owned=advancedController.getSnapshot().tasks.find(task=>task.id===entry.trajectory!.identity.taskId);
   const original=[...owned?.guessFrames??[],...owned?.runs.flatMap(run=>run.frames)??[]].find(frame=>frame.id===entry.trajectory!.currentFrameId);
   if(original){registry.assertCurrent(stamp);const key=JSON.stringify(original.source.ref);capturedSourceOwners.current.set(key,{documentId:entry.id,epoch:entry.epoch});capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(snapshot.draft.structure));return original.source;}
  }
  // A produced result may be the visible scientific frame. Ordinary source
  // snapshots must be reread, even while their earlier observation is cached.
  const observed=advancedObservationsRef.current[entry.id];
  if(preferObserved&&registry.getSnapshot().module==='advanced'&&observed?.ref.taskId&&retainedAdvancedSource(advancedController!.getSnapshot(),observed)&&(!advancedObservationBindings.current.get(entry.id)||snapshot.analysisBindingId===advancedObservationBindings.current.get(entry.id)?.bindingId)){
   registry.assertCurrent(stamp);const key=JSON.stringify(observed.ref);capturedSourceOwners.current.set(key,{documentId:entry.id,epoch:entry.epoch});capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(snapshot.draft.structure));return observed;
  }
  if(['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase)||entry.store.hasTransaction?.())throw Error('请先结束当前结构运行或几何预览，再取用完整帧。');
  const canvas=lastScientificCanvases.current.get(entry.id),binding=advancedPorts.current.postprocess.documents[entry.id];
  const result=entry.result??(registry.analysisAvailable(entry.id)?entry.legacyResult??boundAdvancedCanvasResult(binding,canvas)??binding?.result:undefined);
  let frameIndex:number|undefined;
  if(result){
   const trajectory=trajectoryFrames.current.get(entry.id);
   frameIndex=entry.trajectory?entry.trajectory.frameIds.indexOf(entry.trajectory.currentFrameId):canvas?.result?.id===result.id?canvas.frameIndex:trajectory?.resultId===result.id?trajectory.frameIndex:result.frames.length===1?0:undefined;
  }
  const capture=editingContext?captureWorkspaceElectronicSourceContext:captureWorkspaceAdvancedSource;
  const source=await capture({document:snapshot,documentEpoch:entry.epoch,label:entry.label,result,frameIndex,guard:()=>{registry.assertCurrent(stamp);}});registry.assertCurrent(stamp);
  capturedSourceGeometry.current.set(JSON.stringify(source.ref),workspaceSourceGeometryKey(snapshot.draft.structure));
  capturedSourceOwners.current.set(JSON.stringify(source.ref),{documentId:entry.id,epoch:entry.epoch});
  return source;
 }
 function captureCurrentAdvancedSource(preferObserved=true):Promise<AdvancedFrameSource>{return readCurrentWorkspaceSource(preferObserved,false);}
 function sameElectronicContext(a:ElectronicStateSourceContext,b:ElectronicStateSourceContext){return electronicDraftSourceKey(a)===electronicDraftSourceKey(b)&&JSON.stringify(a.structure)===JSON.stringify(b.structure)&&JSON.stringify(a.stamp)===JSON.stringify(b.stamp);}
 function selectedXtbSource(targetId:string){
  const selected=xtbTaskSelections[targetId];if(!selected)return;
  const task=advancedController?.getSnapshot().tasks.find(task=>task.id===selected.taskId&&task.spec.kind==='singlepoint'&&task.spec.source.ref.documentId===targetId);
  if(!task||selected.runId&&!task.runs.some(run=>run.id===selected.runId))return;
  return {source:task.spec.source,selection:{taskId:task.id,runId:selected.runId??task.runs.at(-1)?.id}};
 }
 function rememberXtbContext(context:ElectronicStateSourceContext,owner:WorkspaceActivationStamp,historical?:XtbAnalysisTaskSelection){
  const entry=registry.assertCurrent(owner);xtbElectronicLeases.current.set(electronicDraftSourceKey(context),{owner,sourceEpoch:entry.sourceEpoch,frameKey:scientificFrameKey(entry.id),context:structuredClone(context),historical});
 }
 async function captureCurrentElectronicSource():Promise<ElectronicStateSourceContext>{
  if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未取用旧页面的帧。');
  const owner=registry.stamp();assertXtbTargetCurrent(owner.documentId);
  const historical=selectedXtbSource(owner.documentId),source=historical?.source??await readCurrentWorkspaceSource(true,true);if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未发布旧帧。');registry.assertCurrent(owner);
  rememberXtbContext(source,owner,historical?.selection);setXtbElectronicContexts(previous=>({...previous,[owner.documentId]:source}));return source;
 }
 async function confirmConformerCopy(stamp:WorkspaceActivationStamp,purpose?:'file-import'|'xtb-electronic-state'){
  const copy=detachedPlacement.current[stamp.documentId]&&hostBridge?.confirmWorkspaceScientificEdit
   ?(await hostBridge.confirmWorkspaceScientificEdit({...authFor(stamp.documentId),expectedRevision:stamp.revision,copyOnly:true,...(purpose==='file-import'?{purpose}:{})})).decision==='copy'
   :await new Promise<boolean>(resolve=>setPendingSourceCopy({resolve,purpose}));setPendingSourceCopy(null);return copy;
 }
 async function writableConformerSource(source:AdvancedFrameSource):Promise<AdvancedFrameSource|null>{
  const stamp=registry.stamp(),parent=registry.document(stamp.documentId);
  if(!protectedConformerSource(parent.id,source))return source;
  if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;
  try{
  const actual=await captureCurrentAdvancedSource(true);registry.assertCurrent(stamp);
  const frameKey=scientificFrameKey(parent.id),pose=currentViewPose(parent.id),module=registry.getSnapshot().module,sourceEpoch=parent.sourceEpoch;
  const section=advancedSectionRef.current,sampling=conformerSamplingChoice;
  const copy=await confirmConformerCopy(stamp);
  if(!copy)return null;
  registry.assertCurrent(stamp);if(parent.sourceEpoch!==sourceEpoch||scientificFrameKey(parent.id)!==frameKey)throw Error('当前帧已切换，未复制过期的构象帧。');
  let child!:WorkspaceDocumentEntry;
  flushSync(()=>{child=registry.addFragmentDocument(advancedFrameFragment(actual),actual.label+'-建模');inheritedViews.current.set(child.id,pose);inheritedNavigation.current.set(child.id,{section,sampling});setMainDocumentId(child.id);registry.setModule(module);});
  return await captureCurrentAdvancedSource(false);
  }finally{sourceCopyBusy.current=false;}
 }
 const electronicOwnerStamp=registry.stamp(),xtbRenderedOwner=electronicOwnerStamp.documentId===activeId?electronicOwnerStamp:null,xtbRenderedProjectEpoch=projectIdentityEpoch.current;
 const xtbLiveElectronicContext=useMemo<ElectronicStateSourceContext|undefined>(()=>{
  if(!active||!xtbAnalysisLayout||xtbTaskSelections[active.id])return;
  const document=active.store.getSnapshot();
  if(active.result||active.legacyResult||active.analysisBinding||active.trajectory||active.conformerGroup||document.analysisBindingId)return xtbElectronicContexts[active.id];
  return {ref:{documentId:document.id,documentEpoch:active.epoch,revision:document.revision},stamp:makeDocumentStamp(document),structure:structuredClone(document.draft.structure),
   constraints:structuredClone(document.sharedConstraints??{frozenAtomIds:[],coordinates:[]}),coordinateUnit:'angstrom',label:active.label};
 },[activeId,state.version,xtbAnalysisLayout,xtbTaskSelections,xtbElectronicContexts]);
 if(xtbLiveElectronicContext&&xtbRenderedOwner)rememberXtbContext(xtbLiveElectronicContext,xtbRenderedOwner);
 async function prepareXtbElectronicSource(context:ElectronicStateSourceContext,draft:ElectronicStateDraft):Promise<ConfirmedElectronicSnapshot|null>{
  if(!xtbRenderedOwner)throw Error('当前没有电子态所属文档。');
  const lifetime=()=>{if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧电子态操作。');};lifetime();registry.assertCurrent(xtbRenderedOwner);assertXtbTargetCurrent(xtbRenderedOwner.documentId);
  const parent=registry.document(xtbRenderedOwner.documentId),historical=selectedXtbSource(parent.id);
  if(historical&&sameElectronicContext(historical.source,context))rememberXtbContext(context,xtbRenderedOwner,historical.selection);
  const lease=xtbElectronicLeases.current.get(electronicDraftSourceKey(context));
  if(!lease||lease.owner.documentId!==parent.id||!sameElectronicContext(lease.context,context))throw Error('电子态来源尚未核对，请更换为当前帧。');
  const sourceCurrent=()=>{
   assertXtbTargetCurrent(parent.id);registry.assertCurrent(lease.owner);
   if(scientificFrameKey(parent.id)!==lease.frameKey)throw Error('当前显示帧已变化，请重新取用电子态。');
   if(lease.historical){const task=advancedController?.getSnapshot().tasks.find(task=>task.id===lease.historical!.taskId),run=task?.runs.find(run=>run.id===lease.historical!.runId);
    if(!task||task.spec.kind!=='singlepoint'||!run||!sameElectronicContext(task.spec.source,context))throw Error('历史单点来源已关闭或更换。');
   }else if(context.ref.taskId){if(!advancedController||!retainedAdvancedSource(advancedController.getSnapshot(),context))throw Error('结果帧的任务来源已变化。');}
   else if(!context.ref.sourceId&&JSON.stringify(parent.store.getSnapshot().draft.structure)!==JSON.stringify(context.structure))throw Error('当前结构或电子态已变化，请重新取用。');
  };
  const snapshot=parent.store.getSnapshot(),copyRequired=!!lease.historical||!!context.ref.taskId||!!context.ref.sourceId||!!parent.result||!!parent.legacyResult||!!parent.analysisBinding||!!parent.trajectory||!!parent.conformerGroup||!!snapshot.analysisBindingId;
  if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;
  try{
   const pose=currentViewPose(parent.id),module=registry.getSnapshot().module;
   const prepared=await prepareWorkspaceElectronicSource({registry,context,draft,owner:lease.owner,sourceEpoch:lease.sourceEpoch,assertSourceCurrent:sourceCurrent,assertLifetimeCurrent:lifetime,copyRequired,
    confirmCopy:()=>confirmConformerCopy(lease.owner,'xtb-electronic-state'),
    createCopy:source=>registry.addFragmentDocument(electronicSourceEditingFragment(source),source.label+'-单点'),
    onCommitted:entry=>{flushSync(()=>{if(entry.id!==parent.id){
     inheritedViews.current.set(entry.id,pose);inheritedNavigation.current.set(entry.id,{section:'xtb2',sampling:conformerSamplingChoice});
     // The child must enter the same analysis workflow before the confirmed
     // source returns to Generate, and keep that route after project restore.
     const navigationKey=JSON.stringify(['workspace','workspace-page.advancedSection']);
     projectUi.set(navigationKey,{...projectUi.get<Record<string,AdvancedSection|null>>(navigationKey,{}),[entry.id]:'xtb2'});
     setMainDocumentId(entry.id);registry.setModule(module);
    }publishMetadata(entry.id);});}
   });
   if(prepared){const entry=registry.document(prepared.source.ref.documentId),key=JSON.stringify(prepared.source.ref);capturedSourceOwners.current.set(key,{documentId:entry.id,epoch:entry.epoch});capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(entry.store.getSnapshot().draft.structure));
    rememberXtbContext(prepared.source,registry.stamp());setXtbElectronicContexts(previous=>({...previous,[entry.id]:prepared.source}));
   }
   return prepared;
  }finally{sourceCopyBusy.current=false;}
 }
 function changeXtbElectronicDraft(draft:ElectronicStateDraft){
  if(!xtbRenderedOwner)return;if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧草稿。');registry.assertCurrent(xtbRenderedOwner);assertXtbTargetCurrent(xtbRenderedOwner.documentId);
  setXtbElectronicDrafts(previous=>({...previous,[draft.sourceKey]:structuredClone(draft)}));
 }
 function changeXtbTaskSelection(id:string,selection:XtbAnalysisTaskSelection|undefined){
  if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧任务选择。');
  assertXtbTargetCurrent(id);setXtbTaskSelections(previous=>{if(JSON.stringify(previous[id])===JSON.stringify(selection))return previous;const next={...previous};if(selection)next[id]={...selection};else delete next[id];return next;});
 }
 function changeXtbMethodDraft(id:string,draft:AdvancedMethodDraft){
  if(!xtbRenderedOwner||id!==xtbRenderedOwner.documentId)return;if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧方法设置。');registry.assertCurrent(xtbRenderedOwner);assertXtbTargetCurrent(id);
  setXtbMethodDrafts(previous=>({...previous,[id]:structuredClone(draft)}));
 }
 function advancedSourceResult(source:AdvancedFrameSource){
  const entry=registry.getSnapshot().documents.some(row=>row.id===source.ref.documentId)?registry.document(source.ref.documentId):null;
  if(!entry||source.ref.taskId||entry.epoch!==source.ref.documentEpoch||entry.store.getSnapshot().revision!==source.ref.revision)return;
  const canvas=lastScientificCanvases.current.get(entry.id),binding=advancedPorts.current.postprocess.documents[entry.id];
  if(binding&&!registry.analysisAvailable(entry.id))return;
  const result=entry.result??boundAdvancedCanvasResult(binding,canvas)??binding?.result;
  return matchesAdvancedSourceCollection(source,result)?{entry,result}:undefined;
 }
 async function readAdvancedSourceCollection(source:AdvancedFrameSource,indices:number[],signal?:AbortSignal){
  const current=advancedSourceResult(source);if(!current)throw Error('当前完整轨迹来源已关闭、修改或切换阶段，请重新取用。');
  const {entry,result}=current,stamp=registry.stamp(),snapshot=entry.store.getSnapshot();
  return captureWorkspaceAdvancedCollection({document:snapshot,documentEpoch:entry.epoch,label:entry.label,result,indices,stageId:source.ref.stageId,signal,guard:()=>{registry.assertCurrent(stamp);const next=advancedSourceResult(source);if(!next||next.result!==result)throw Error('读取期间轨迹来源已变化，未显示迟到帧。');}});
 }
 function reportOwnerError(entry:Pick<WorkspaceDocumentEntry,'id'|'epoch'>,adapter:ReturnType<typeof createWorkspaceOwnerAdapter>,cause:unknown){
  const current=registry.getSnapshot().documents.find(value=>value.id===entry.id);
  if(workspaceOwnerCallbackCurrent(entry,adapter,current,ownerAdapters.current.get(entry.id),adapter.getState().status))setError(String(cause instanceof Error?cause.message:cause));
 }
 function publishMetadata(id:string){
  const adapter=ownerAdapters.current.get(id),entry=registry.getSnapshot().documents.find(value=>value.id===id);
  if(adapter&&entry)void adapter.publish().catch(cause=>reportOwnerError(entry,adapter,cause));
 }
 function ensureOwnerAdapter(entry:WorkspaceDocumentEntry){
   const existing=ownerAdapters.current.get(entry.id);if(existing)return existing;
   if(!hostBridge||entry.result)return undefined;
   const adapter=createWorkspaceOwnerAdapter({
    bridge:hostBridge,documentId:entry.id,
    nextSnapshot:()=>{const snapshot=registry.nextPublication(entry.id),viewport=viewportStates.current.get(entry.id),display=displaySources.current.get(entry.id)?.descriptor;return viewport?{...snapshot,viewport:viewportSnapshotJSON({...viewport,...display?{displayProjection:display}:{}})}:snapshot;},
    subscribe:entry.store.subscribe,
    onCommand:async(command,revision,requesterWindowId)=>{
     if(closingTransactions.current.has(entry.id))throw new Error('文档正在关闭。');
     if(command.type==='workspace.viewport-event'){
      if(entry.store.getSnapshot().revision!==revision&&!isCurrentDocumentSaveIntent(command))throw new Error('模型已变化，外部操作未重放。');
      const event=command.event as unknown as WorkspaceViewportEvent;
      if(event.type==='cip-used'){
       const currentEntry=()=>registry.getSnapshot().documents.find(row=>row.id===entry.id);
       const source=displaySources.current.get(entry.id),sourceEpoch=entry.sourceEpoch,projectEpoch=projectIdentityEpoch.current;
       const current=()=>currentEntry()?.epoch===entry.epoch&&event.documentEpoch===entry.epoch&&entry.sourceEpoch===sourceEpoch&&projectIdentityEpoch.current===projectEpoch
        &&requesterWindowId===detachedPlacement.current[entry.id]&&!closingTransactions.current.has(entry.id)
        &&entry.store.getSnapshot().revision===revision&&(displaySources.current.get(entry.id)?.descriptor.projectionSerial??null)===event.projectionSerial
        &&displaySources.current.get(entry.id)===source;
       if(!current())throw Error('CIP引用回执的独立窗口、来源或帧已变化。');
       const observed=source?.projection.displayDocument?.document??entry.store.getSnapshot();
       if(!await cipReceiptSourceMatches(event.receipt,observed)||!current())throw Error('CIP引用回执与当前完整几何不一致。');
       cipUsageFor(entry.id,entry.epoch)(event.receipt);return;
      }
      if(event.type==='display-subscribe'){
       if(requesterWindowId!==detachedPlacement.current[entry.id]||typeof event.channelToken!=='string'||event.channelToken.length<32||event.channelToken.length>400||!/^[A-Za-z0-9:_-]+$/.test(event.channelToken))throw new Error('独立显示订阅未获当前模型成员授权。');
       displayOwners.current.get(entry.id)?.close();
       const owner=createViewportDisplayOwner({documentId:entry.id,token:event.channelToken,port:openViewportDisplayPort(entry.id,event.channelToken),onError:setError,onMesh:(mesh,document)=>displaySources.current.get(entry.id)?.observer?.(mesh,document)});
       displayOwners.current.set(entry.id,owner);const source=displaySources.current.get(entry.id);owner.publish(source?.projection??null,source?.descriptor.projectionSerial??displaySerials.current.get(entry.id)??0);return;
      }
      if(event.type==='document-pick'){
       if(sourcePickLive.current)selectTaskSource(entry.id);else if(selectingMembers.current)linkedControlsLive.current.toggleMember(entry.id);else throw new Error('窗口选择已经结束，请重新开始。');return;
      }
      if(event.type==='cancel-document-pick'){if(sourcePickLive.current){sourcePickLive.current=null;setSourcePick(null);}if(selectingMembers.current)linkedControlsLive.current.clear();return;}
      if(sourcePickLive.current||selectingMembers.current)throw new Error('正在选择结构窗口，本次只绑定来源或关联成员。');
      activateDocument(entry.id,true);
      const controller=viewportControllers.current.get(entry.id);if(!controller)throw new Error('模型工具尚未连接。');
      await controller.dispatch(command.event as unknown as WorkspaceViewportEvent);return;
     }
     await applyWorkspaceOwnerCommand(entry.store,command,revision,runtimeOwners.current.get(entry.id)?.controller,registry);
    }
   });
   ownerAdapters.current.set(entry.id,adapter);void adapter.ready.catch(cause=>reportOwnerError(entry,adapter,cause));return adapter;
 }
 useEffect(()=>{
  if(!hostBridge)return;
  for(const value of registry.getSnapshot().documents)ensureOwnerAdapter(registry.document(value.id));
 },[registry,documentSignature,hostBridge,activateDocument]);
 function authFor(id:string){const membership=ownerAdapters.current.get(id)?.getState().membership;if(!membership)throw new Error('文档尚未连接，请稍后重试。');return {documentId:id,membershipNonce:membership.membershipNonce};}
 async function resolveScientificEdit(choice:'current'|'copy'|'cancel'){
  const intent=pendingEditRef.current;if(!intent||editChoiceInFlight.current)return;
  const entry=registry.getSnapshot().documents.find(value=>value.id===intent.request.documentId);
  if(choice==='cancel'||!entry){entry?.store.resolvePendingScientificEdit?.('cancel');pendingEditRef.current=null;setPendingEdit(null);return;}
  editChoiceInFlight.current=true;setEditChoiceBusy(true);
  let child:WorkspaceDocumentEntry|undefined,opened=false;
  try{
   registry.assertCurrent(intent.stamp);
   if(scientificFrameKey(entry.id)!==intent.frameKey)throw Error('当前观察帧已切换，未执行旧的编辑。');
   if(!entry.store.getPendingScientificEdit?.())throw Error('本次编辑尚未形成有效操作，请重新操作。');
   if(choice==='current'){if(protectedConformerSource(entry.id))throw Error('构象来源只允许在新标签页继续；原始帧未修改。');entry.store.resolvePendingScientificEdit?.('current');}
   else{
    const pose=currentViewPose(entry.id);
    flushSync(()=>{child=registry.copyForModeling(intent.stamp);inheritedViews.current.set(child.id,pose);});
    registry.assertCurrent(intent.stamp);
    if(scientificFrameKey(entry.id)!==intent.frameKey)throw Error('当前观察帧已切换，未打开旧的编辑副本。');
    entry.store.resolvePendingScientificEdit?.('copy',child!.store);
    activateDocument(child!.id);registry.setModule('modeling');opened=true;
    const adapter=ensureOwnerAdapter(child!);if(adapter){await adapter.ready;await adapter.flush();}
   }
   setError('');
  }catch(cause){
   entry.store.resolvePendingScientificEdit?.('cancel');
   if(child&&!opened){const adapter=ownerAdapters.current.get(child.id);try{if(adapter&&hostBridge)await hostBridge.closeWorkspaceDocument(authFor(child.id));}catch{/* Keep source untouched even if native registration cleanup fails. */}adapter?.dispose();ownerAdapters.current.delete(child.id);registry.closeDocument(child.id,true);}
   setError(cause instanceof Error?cause.message:String(cause));
  }finally{editChoiceInFlight.current=false;setEditChoiceBusy(false);pendingEditRef.current=null;setPendingEdit(null);}
 }
 useEffect(()=>{
  if(!pendingEdit||!detachedPlacement.current[pendingEdit.request.documentId]||!hostBridge?.confirmWorkspaceScientificEdit||nativeEditPrompt.current===pendingEdit)return;
  nativeEditPrompt.current=pendingEdit;
  void hostBridge.confirmWorkspaceScientificEdit({...authFor(pendingEdit.request.documentId),expectedRevision:pendingEdit.request.revision,copyOnly:protectedConformerSource(pendingEdit.request.documentId)})
   .then(answer=>{if(pendingEditRef.current===pendingEdit)void resolveScientificEdit(answer.decision);})
   .catch(cause=>{setError(cause instanceof Error?cause.message:String(cause));if(pendingEditRef.current===pendingEdit)void resolveScientificEdit('cancel');});
 },[pendingEdit,hostBridge]);
 function retireDocumentPresentation(entry:WorkspaceDocumentEntry){
  const id=entry.id;
  if(linkedControls.linked?.documentIds.includes(id))linkedControls.clear();
  setAdvancedObservations(previous=>{const next={...previous};delete next[id];return next;});lastScientificCanvases.current.delete(id);trajectoryFrames.current.delete(id);
  setAdvancedLayers(previous=>{const next={...previous};delete next[id];return next;});
  setAnalysisCanvases(previous=>{const next={...previous};delete next[id];return next;});
  activeResultCallbacks.current.delete(id);setActiveAnalysisResults(previous=>{const next={...previous};delete next[id];return next;});
  setConformerViewControls(previous=>{const next={...previous};delete next[id];return next;});
  setConformerFrameOrders(previous=>{const next={...previous};delete next[id];return next;});
  conformerPlayerCollections.current.delete(id);advancedObservationBindings.current.delete(id);
  setAdvancedTaskHighlights(previous=>{const next={...previous};delete next[id];return next;});
  pagePresentations.current.delete(id);pageScroll.current.forEach((_value,key)=>{if(key.startsWith('['+JSON.stringify(id)+','))pageScroll.current.delete(key);});
  setStructureAnalysisSelected(previous=>{const next={...previous};delete next[id];return next;});
  runtimeOwners.current.get(id)?.unsubscribe();runtimeOwners.current.delete(id);
  ownerAdapters.current.get(id)?.dispose();ownerAdapters.current.delete(id);viewportStates.current.delete(id);viewportControllers.current.delete(id);inputControllers.current.delete(id);
  pendingCameraRestores.current.delete(id);callbacks.current.delete(id);displayOwners.current.get(id)?.close();displayOwners.current.delete(id);displaySources.current.delete(id);displaySerials.current.delete(id);inheritedViews.current.delete(id);inheritedNavigation.current.delete(id);
  projectUi.removeScope(['document',id]);
  setDetached(previous=>{const next={...previous};delete next[id];return next;});setClosing(current=>current===id?null:current);
  setCloseConfirmIds(previous=>previous.filter(value=>value!==id));
 }
 function discardSourceIds(id:string){
  const entry=registry.getSnapshot().documents.find(entry=>entry.id===id),pp=advancedPorts.current.postprocess;
  const documents=[pp.documents[id],...Object.entries(pp.generated).filter(([key,row])=>key===id||row.ownerId===id).map(([,row])=>row.document)];
  const ids=new Set<string>([id]);
  for(const result of [entry?.result,entry?.legacyResult,analysisCanvasesRef.current[id]?.result])if(result){ids.add(result.id);ids.add(result.source.id);}
  for(const document of documents)if(document){ids.add(document.id);ids.add(document.result.id);ids.add(document.result.source.id);for(const attachment of [document.output,document.wavefunction,...document.companions??[]])if(attachment){ids.add(attachment.source.result.id);ids.add(attachment.source.result.source.id);if(attachment.source.metadata?.sourceId)ids.add(attachment.source.metadata.sourceId);if(attachment.nativeSessionId)ids.add(attachment.nativeSessionId);}}
  const observed=advancedObservationsRef.current[id];if(observed){ids.add(observed.ref.documentId);if(observed.ref.sourceId)ids.add(observed.ref.sourceId);}
  return ids;
 }
 function assertDiscardOwners(impact:WorkspaceDiscardImpact){
  if(importController.current||libraryLoadController.current||projectActivity.current.busy||projectActivity.current.capturing||restoringProject.current||sourceCopyBusy.current||pendingSourceCopyRef.current||editChoiceInFlight.current)throw Error('来源、项目或科学修改仍在处理，请完成当前操作后再丢弃。');
  const pp=advancedPorts.current.postprocess;if(pp.isBusy())throw Error('分析来源仍在读取或接入，请完成后再丢弃。');
  for(const row of impact.documents){
   guardClose(row.id,true);
   if(pendingEditRef.current?.request.documentId===row.id)throw Error('文档仍有待处理的科学修改，请先完成或取消。');
   if(analysisCanvasesRef.current[row.id]?.exporting)throw Error('文档仍在导出，请等待完成后再丢弃。');
   const sourceIds=discardSourceIds(row.id);
   assertAnalysisDocumentIdle(row.id,[...sourceIds]);
   if(desktop)assertOrbitalSourcesIdle(desktop,[...sourceIds],[...sourceIds]);
   if(describeAnalysisProjectDocument(row.id,[...sourceIds]).busy)throw Error('关联分析内容仍在读写，请完成后再丢弃。');
   if([...activeSourceOperations.current.values()].some(operation=>sourceIds.has(operation.sourceId)||Boolean(operation.resultId&&sourceIds.has(operation.resultId)))||[...activeNativeAnalyses.current.values()].some(operation=>[operation.identity.sourceId,operation.identity.sessionId,operation.identity.analysisId,operation.identity.ownerId].some(id=>sourceIds.has(id))))throw Error('关联来源仍有分析、读取或原生任务，请先停止并取得结束回执。');
  }
  for(const owner of impact.dataOwners)if(owner.kind==='postprocess'&&pp.describeClose(owner.documentId).revision!==owner.revision)throw Error('待丢弃分析来源已变化，请重新确认。');
  for(const owner of impact.dataOwners)if(owner.kind==='analysis-runtime'&&describeAnalysisDocumentClose(owner.documentId,[...discardSourceIds(owner.documentId)]).revision!==owner.revision)throw Error('关联分析owner已变化，请重新确认。');
  for(const owner of impact.dataOwners)if(owner.kind==='analysis-project'&&describeAnalysisProjectDocument(owner.documentId,[...discardSourceIds(owner.documentId)]).revision!==owner.revision)throw Error('关联分析内容已变化，请重新确认。');
 }
 async function buildDiscardImpact(id:string,wholeTask=false){
  const entry=registry.document(id),epoch=entry.epoch;
  if(entry.conformerGroup||entry.trajectory)await ensurePendingAdvancedProject();
  if(registry.document(id).epoch!==epoch)throw Error('待丢弃文档已更换，未执行。');
  const taskId=entry.trajectory?.identity.taskId??entry.conformerGroup?.taskId,task=advancedController?.getSnapshot().tasks.find(task=>task.id===taskId);
  const conformerPlan=task?advancedController!.planDiscardConformer(wholeTask?{taskId:task.id}:conformerDiscardSelection(entry)):undefined;
  const pp=advancedPorts.current.postprocess;
  const dataOwners=registry.getSnapshot().documents.flatMap(document=>{const sourceIds=[...discardSourceIds(document.id)],summary=pp.describeClose(document.id),analysis=describeAnalysisDocumentClose(document.id,sourceIds),saved=describeAnalysisProjectDocument(document.id,sourceIds);return[{documentId:document.id,label:`${document.label}的分析来源与结果`,kind:'postprocess',revision:summary.revision,hasData:summary.hasData},{documentId:document.id,label:`${document.label}的分析内容`,kind:'analysis-runtime',revision:analysis.revision,hasData:analysis.hasData},{documentId:document.id,label:`${document.label}的已保存分析内容`,kind:'analysis-project',revision:saved.revision,hasData:saved.hasData}];});
  const impact=planWorkspaceDiscard(registry,id,{conformerPlan,dataOwners,additionalDocumentIds:wholeTask?registry.getSnapshot().documents.filter(document=>document.conformerGroup?.taskId===taskId||document.trajectory?.identity.taskId===taskId).map(document=>document.id):[]});
  assertDiscardOwners(impact);return impact;
 }
 async function releaseDiscard(key:string){
  const pending=pendingDiscards.current.get(key);if(!pending)return;
  await pending.execution.release();pendingDiscards.current.delete(key);setDiscardCleanupRevision(value=>value+1);
 }
 async function retryDiscardCleanup(){
  if(retryingDiscard)return;setRetryingDiscard(true);
  try{for(const key of pendingDiscards.current.keys())await releaseDiscard(key);setError('');}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setRetryingDiscard(false);setDiscardCleanupRevision(value=>value+1);}
 }
 async function executeDiscard(impact:WorkspaceDiscardImpact){
  if(impact.documents.some(row=>closingTransactions.current.has(row.id)))return;
  for(const row of impact.documents)closingTransactions.current.add(row.id);
  setClosingPendingIds(previous=>[...new Set([...previous,...impact.registryPlan.documentIds])]);
  let execution:WorkspaceDiscardExecution|undefined;
  try{
   execution=await prepareWorkspaceDiscard(impact,{registry,assertOwners:assertDiscardOwners,
    assertConformer:plan=>advancedController!.assertDiscardConformer(plan as AdvancedDiscardConformerPlan),
    prepareConformer:plan=>advancedController!.prepareDiscardConformer(plan as AdvancedDiscardConformerPlan),
    prepareOwners:async value=>{
     const entries=value.documents.map(row=>registry.document(row.id));
     await Promise.all(entries.map(entry=>ownerAdapters.current.get(entry.id)?.flush()));
     assertDiscardOwners(value);
     // Native authorizations belong to the still-live adapters. Capture them
     // now; release must never query a registry entry removed by commit.
     const native=entries.map(entry=>({id:entry.id,requestId:closeRequests.current.get(entry.id)?.requestId,auth:hostBridge&&ownerAdapters.current.has(entry.id)?authFor(entry.id):undefined,done:false,importDone:false,sourceIds:[...discardSourceIds(entry.id)]}));
     const pp=advancedPorts.current.postprocess;
     const retainedSources=[...new Set(registry.getSnapshot().documents.filter(entry=>!value.registryPlan.documentIds.includes(entry.id)).flatMap(entry=>[...discardSourceIds(entry.id)]))];
     const analysis=prepareAnalysisDocumentClose(entries.map(entry=>entry.id),[...new Set(native.flatMap(row=>row.sourceIds))],retainedSources),sources=entries.map(entry=>pp.prepareClose(entry.id));
     return [{ownerId:'workspace-analysis-and-sources',
      assertCurrent:()=>{analysis.assertCurrent?.();for(const source of sources)source.assertCurrent?.();},
      commit:()=>{analysis.commit();for(const source of sources)source.commit();},
      release:async()=>{await analysis.release();const settled=await Promise.allSettled(sources.map(source=>source.release())),failures=settled.filter((row):row is PromiseRejectedResult=>row.status==='rejected');if(failures.length)throw new AggregateError(failures.map(row=>row.reason),'部分分析来源仍待释放。');},
     },{ownerId:'workspace-presentations',
      assertCurrent:()=>{for(const row of native)if(closeRequests.current.get(row.id)?.requestId!==row.requestId)throw Error('文档关闭请求已变化，请重新确认。');},
      commit:()=>{
       for(const entry of entries){if(entry.trajectory)conformerCollectionPublisher.current.discard(entry.trajectory.identity,conformerPublicationPorts());retireDocumentPresentation(entry);closeRequests.current.delete(entry.id);}
       const taskId=value.conformerPlan?.taskId;
       if(taskId&&!advancedController!.getSnapshot().tasks.some(task=>task.id===taskId)){releaseMixedConformerPageCache(advancedController!,taskId);for(const [key,value]of conformerPrepared.current)if((value.result as ReturnType<typeof createConformerTrajectory>).identity.taskId===taskId){value.abort.abort();conformerPrepared.current.delete(key);}setConformerGroups(previous=>{const next={...previous};delete next[taskId];return next;});}
      },
      release:async()=>{
       const liveSources=[...new Set(registry.getSnapshot().documents.flatMap(entry=>[...discardSourceIds(entry.id)]))];
       for(const row of native){if(!row.done){if(row.auth&&hostBridge){if(row.requestId&&hostBridge.replyWorkspaceDocumentClose)await hostBridge.replyWorkspaceDocumentClose({...row.auth,requestId:row.requestId,status:'closed'});else await hostBridge.closeWorkspaceDocument(row.auth);}row.done=true;}if(!row.importDone){await forgetImportedModelSources(row.id);forgetAnalysisProjectDocument(row.id,row.sourceIds,liveSources);row.importDone=true;}}
      },
     }];
    },
   });
   execution.commit();
   const key=JSON.stringify(impact.documents.map(row=>[row.id,row.epoch]));pendingDiscards.current.set(key,{execution,label:impact.documents.map(row=>row.label).join('、')});setDiscardCleanupRevision(value=>value+1);
   discardImpactRef.current=null;setDiscardImpact(null);setClosing(null);if(!registry.getSnapshot().documents.length)registry.addDocument();
   await releaseDiscard(key);setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));if(!execution||execution.status().phase==='prepared')for(const row of impact.documents)await cancelClose(row.id);else if(execution.status().phase==='commit-failed'){const key=JSON.stringify(impact.documents.map(row=>[row.id,row.epoch]));pendingDiscards.current.set(key,{execution,label:impact.documents.map(row=>row.label).join('、')});setDiscardCleanupRevision(value=>value+1);}}
  finally{for(const row of impact.documents)closingTransactions.current.delete(row.id);setClosingPendingIds(previous=>previous.filter(id=>!impact.registryPlan.documentIds.includes(id)));}
 }
 function guardClose(id:string,discard=false){
  const entry=registry.document(id);
  if(viewportControllers.current.get(id)?.isBusy()||inputControllers.current.get(id)?.isBusy())throw new Error('文档仍有运行中的计算或文件任务，请先停止并取得结束回执。');
  if(['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase))throw new Error('文档仍在运行或暂停，请先停止并取得结束回执。');
  if(!discard&&(entry.store.getSnapshot().draft.dirty||entry.inputDirty.gaussian||entry.inputDirty.orca))throw new Error('模型或输入草稿有未保存修改。');
 }
 async function cancelClose(id:string){
  const currentImpact=discardImpactRef.current,affected=currentImpact?.documents.some(row=>row.id===id)?currentImpact.registryPlan.documentIds:[id];
  discardConfirmSerial.current++;if(currentImpact?.documents.some(row=>row.id===id)){discardImpactRef.current=null;setDiscardImpact(null);}
  const requestId=closeRequests.current.get(id)?.requestId;
  try{if(requestId&&hostBridge?.replyWorkspaceDocumentClose)await hostBridge.replyWorkspaceDocumentClose({...authFor(id),requestId,status:'cancelled'});}
  catch(cause){setError(String(cause instanceof Error?cause.message:cause));}
  finally{closeRequests.current.delete(id);setCloseConfirmIds(previous=>previous.filter(value=>!affected.includes(value)));setClosing(current=>current===id?null:current);}
 }
 async function close(id:string,discard=false){
  if(closingTransactions.current.has(id))return;closingTransactions.current.add(id);setClosingPendingIds(previous=>[...previous,id]);registry.invalidateActivation();
  let closingOwner:Pick<WorkspaceDocumentEntry,'id'|'epoch'>|undefined;
  try{
   const entry=registry.document(id);
   closingOwner={id:entry.id,epoch:entry.epoch};
   guardClose(id,discard);const adapter=ownerAdapters.current.get(id);if(adapter)await adapter.flush();guardClose(id,discard);
   const requestId=closeRequests.current.get(id)?.requestId;
   if(requestId&&hostBridge?.replyWorkspaceDocumentClose)await hostBridge.replyWorkspaceDocumentClose({...authFor(id),requestId,status:'closed'});
   else if(adapter&&hostBridge)await hostBridge.closeWorkspaceDocument(authFor(id));
   const closeWarnings=await postprocess.close(id);await registry.closeDocument(id,discard);
   retireDocumentPresentation(entry);closeRequests.current.delete(id);await forgetImportedModelSources(id);forgetAnalysisProjectDocument(id);
   if(!registry.getSnapshot().documents.length)registry.addDocument();setCloseConfirmIds(previous=>previous.filter(value=>value!==id));setError(closeWarnings.length?`分析已关闭；释放提示：${closeWarnings.join('；')}`:'');
  }catch(cause){setError(String(cause instanceof Error?cause.message:cause));await cancelClose(id);}
  finally{
   closingTransactions.current.delete(id);setClosingPendingIds(previous=>previous.filter(value=>value!==id));
   if(closingOwner){
    if(registry.getSnapshot().documents.some(entry=>entry.id===closingOwner!.id&&entry.epoch===closingOwner!.epoch))conformerCollectionPublisher.current.aborted(closingOwner);
    else conformerCollectionPublisher.current.released(closingOwner,conformerPublicationPorts());
   }
  }
 }
 async function askClose(id:string){
  if(closingTransactions.current.has(id))return;const serial=++discardConfirmSerial.current;
  try{const impact=await buildDiscardImpact(id);if(serial!==discardConfirmSerial.current)return;
   if(impact.requiresConfirmation){discardImpactRef.current=impact;setDiscardImpact(impact);setClosing(id);setCloseConfirmIds([...impact.registryPlan.documentIds]);}
   else await executeDiscard(impact);
  }catch(cause){if(serial!==discardConfirmSerial.current)return;setError(cause instanceof Error?cause.message:String(cause));await cancelClose(id);}
 }
 useEffect(()=>{
  if(!advancedController)return;
  // Resampling/reoptimizing retires controller-owned frames. Close their stale
  // reader tabs so renderer/reader caches do not keep those trajectories alive.
  return advancedController.subscribe(()=>{
   const tasks=advancedController.getSnapshot().tasks;
   for(const entry of registry.getSnapshot().documents){
    if(!entry.trajectory?.frameIds.length||closingTransactions.current.has(entry.id)||!registry.analysisAvailable(entry.id))continue;
    const task=tasks.find(task=>task.id===entry.trajectory!.identity.taskId);
    if(!task)continue;
    const retained=new Set([...task.guessFrames,...task.runs.flatMap(run=>run.frames)].map(frame=>frame.id));
    if(entry.trajectory.frameIds.some(id=>retained.has(id)))continue;
    const snapshot=registry.getSnapshot(),current=snapshot.views.find(view=>view.id===snapshot.activeViewId);
    if(current?.documentId===entry.id){const parent=snapshot.documents.find(value=>value.conformerGroup?.taskId===task.id&&value.conformerGroup.role==='initial');if(parent)activateDocument(parent.id);}
    void close(entry.id,true);
   }
  });
 },[advancedController,registry,activateDocument]);
 function requestClose(id:string){
  if(borrowedBatchRef.current?.documentId===id){setCancelBatchConfirm(true);return;}
  if(hostBridge?.requestWorkspaceDocumentClose&&!registry.document(id).result){void hostBridge.requestWorkspaceDocumentClose(authFor(id)).catch(cause=>setError(String(cause instanceof Error?cause.message:cause)));}
  else askClose(id);
 }
 useEffect(()=>hostBridge?.onWorkspaceDocumentEvent(event=>{
  if(event.kind==='placement'){const placement={...detachedPlacement.current};if(event.detachedWindowId)placement[event.documentId]=event.detachedWindowId;else delete placement[event.documentId];detachedPlacement.current=placement;if(event.detachedWindowId===null){displayOwners.current.get(event.documentId)?.close();displayOwners.current.delete(event.documentId);}setDetached(previous=>{const next={...previous};if(event.detachedWindowId)next[event.documentId]=event.detachedWindowId;else delete next[event.documentId];return next;});if(event.detachedWindowId===null)activateDocument(event.documentId);}
  else if(event.kind==='activate-document')activateDocument(event.documentId,true);
  else if(event.kind==='close-request'){closeRequests.current.set(event.documentId,{requestId:event.requestId,requesterWindowId:event.requesterWindowId});askClose(event.documentId);}
  else if(event.kind==='close-state'){
   viewportControllers.current.get(event.documentId)?.cancelInteraction?.();
   setCloseConfirmIds(previous=>event.phase==='pending'?[...new Set([...previous,event.documentId])]:previous.filter(id=>id!==event.documentId));
   if(event.phase==='failed'&&closeRequests.current.get(event.documentId)?.requestId===event.requestId){closeRequests.current.delete(event.documentId);const impact=discardImpactRef.current;if(impact?.documents.some(row=>row.id===event.documentId)){discardConfirmSerial.current++;discardImpactRef.current=null;setDiscardImpact(null);setCloseConfirmIds(previous=>previous.filter(id=>!impact.registryPlan.documentIds.includes(id)));}setClosing(current=>current===event.documentId?null:current);}
  }
  else if(event.kind==='owner-view-hidden'){registry.invalidateActivation();setOwnerHidden(true);}
  else if(event.kind==='owner-view-restored'){registry.invalidateActivation();setOwnerHidden(false);}
  else if(event.kind==='activate-owner'){activateDocument(event.documentId,true);setOwnerHidden(false);}
 }),[hostBridge,registry,activateDocument,closingPending,documentSignature]);
 // The OS content rectangle avoids guessing title-bar/border or DPI offsets.
 useEffect(()=>{
  if(!hostBridge?.workspaceWindowGeometry||!Object.keys(detached).length){setDockTarget(undefined);return;}
  let alive=true,busy=false;
  const update=async()=>{if(busy)return;busy=true;try{const bounds=await hostBridge.workspaceWindowGeometry!(),rect=tabs.current?.getBoundingClientRect();if(!alive||!rect)return;const next={x:bounds.x+rect.left,y:bounds.y+rect.top,width:rect.width,height:rect.height};setDockTarget(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);}catch{}finally{busy=false;}};
  void update();const timer=setInterval(()=>void update(),350);return()=>{alive=false;clearInterval(timer);};
 },[hostBridge,JSON.stringify(detached)]);
 useEffect(()=>{
  if(!desktop?.onApplicationClosePreparation||!desktop.completeApplicationClosePreparation)return;
  let alive=true;
  const unsubscribe=desktop.onApplicationClosePreparation(request=>{
   void (async()=>{
    try {
     await Promise.all([...ownerAdapters.current.values()].map(adapter=>adapter.flush()));
     const meaningful=registry.getSnapshot().documents.some(entry=>entry.store.getSnapshot().draft.dirty||entry.inputDirty.gaussian||entry.inputDirty.orca||Boolean(entry.conformerGroup)||Boolean(entry.legacyResult))||Object.keys(advancedPorts.current.postprocess.documents).length>0||Object.keys(advancedPorts.current.postprocess.fileDocuments).length>0||projectInfo.current.dirty;
     await desktop.completeApplicationClosePreparation!({requestId:request.requestId,status:'waiting'});
     const twoDNotice=twoDRuntime.current?.hasContent()?'关闭窗口会清除本次二维会话草稿和编辑历史；保存.es只保存正式项目，不保存此临时画板。已生成的三维和正式来源按项目保存。':undefined;
     if((meaningful||projectRunning.current||twoDNotice)&&!await projectClose.current(projectRunning.current,twoDNotice)){await desktop.completeApplicationClosePreparation!({requestId:request.requestId,status:'cancelled'});return;}
     await twoDRuntime.current?.stop();
     for(const entry of registry.getSnapshot().documents){entry.store.markApplied();for(const engine of ['gaussian','orca'] as const)if(entry.drafts[engine]!==undefined)registry.setDraft(entry.id,engine,entry.drafts[engine]!,false);}
     await Promise.all([...ownerAdapters.current.values()].map(adapter=>adapter.flush()));
     if(!alive)return;
     await desktop.completeApplicationClosePreparation!({requestId:request.requestId,status:'ready',projectHandled:true});
    } catch(cause) {
     if(!alive)return;
     const error=cause instanceof Error?cause.message:String(cause);
     setError(error);
     await desktop.completeApplicationClosePreparation!({requestId:request.requestId,status:'failed',error}).catch(()=>{});
    }
   })();
  });
  return()=>{alive=false;unsubscribe();};
 },[desktop]);
 const sourceSignature=JSON.stringify(state.documents.map(entry=>[entry.id,entry.epoch,entry.sourceEpoch,entry.label,entry.electronicStateConfirmed]));
 const sources=useMemo(()=>state.documents.filter(entry=>!entry.result&&entry.store.getSnapshot().draft.structure.atoms.length>0).map(entry=>registry.source(entry.id)),[registry,sourceSignature]);
 const createDocument=useCallback(()=>{advancedPorts.current.postprocess.selectFile(null);const module=registry.getSnapshot().module,entry=registry.addDocument();
  if(module==='advanced'){inheritedNavigation.current.set(entry.id,{section:advancedSection,sampling:conformerSamplingChoice});registry.setModule(module);}
  else if(module==='advanced-modeling'){derivedModelingRoutes.current.set(entry.id,advancedModelingRoute);registry.setModule(module);}
  else registry.setModule(module);setError('');},[registry,advancedSection,conformerSamplingChoice,advancedModelingRoute]);
 async function loadLibraryStructure(entry:StructureLibraryEntry,snapshot:Structure){
  importController.current?.abort();const controller=new AbortController();importController.current=controller;libraryLoadController.current=controller;
  const epoch=++importEpoch.current,lease=registry.stamp(),copy=structuredClone(snapshot);
  copy.libraryProvenance={entryId:entry.id,category:entry.category,name:entry.name,formula:entry.formula,phase:entry.phase,source:structuredClone(entry.source),normalization:structuredClone(entry.normalization)};
  const guard=()=>{if(controller.signal.aborted||epoch!==importEpoch.current)throw new Error('结构库载入已取消。');registry.assertCurrent(lease);};
  setReading(true);setReadProgress(null);
  try{
   const items=modelFragmentsFromStructures([copy]).map(fragment=>({kind:'model' as const,fragment}));
   const prepared=await prepareWorkspaceImportModels(items,{port:createChemistryPort(),signal:controller.signal,guard});guard();
   for(const item of prepared.items)if(item.kind==='model')registry.addFragmentDocument(item.fragment);
   registry.setModule('modeling');setError(prepared.warnings.join('；'));
  }finally{if(libraryLoadController.current===controller)libraryLoadController.current=null;if(epoch===importEpoch.current){setReading(false);importController.current=null;}}
 }
 async function openTwoDFiles(files:ScientificSourceFile[]):Promise<boolean>{
  try{
   if(files.length!==1)throw Error('请每次导入一个二维文件或一张图片；同一图纸内可选择多个结构中的目标。');
   if(twoDRuntime.current?.isBusy())throw Error('二维操作仍在运行，请先停止或等待结束。');
   const serial=++twoDLoadEpoch.current;
   const loaded=await readTwoDImportFile(files[0]);
   if(loaded.source){const [{parseTwoDDraft},{twoDIndigoConverter,assertTwoDEditorKet}]=await Promise.all([import('../../modeling/two-d'),import('./two-d-editor-service')]);const draft=await parseTwoDDraft(loaded.source.data,{sourceId:loaded.source.id,filename:loaded.name,indigo:twoDIndigoConverter});assertTwoDEditorKet(draft.ket);}
   if(serial!==twoDLoadEpoch.current)return false;
   if(twoDRuntime.current?.hasContent()){setTwoDVisible(true);if(!await twoDRuntime.current.confirmReplacement())return false;}
   if(serial!==twoDLoadEpoch.current||twoDRuntime.current?.isBusy())throw Error('二维载入已取消或当前操作尚未结束，旧草稿已保留。');
   twoDOrigin.current='imported';twoDFileRef.current=loaded;setTwoDFile(loaded);setTwoDVisible(true);setError('');return true;
  }catch(cause){const message=cause instanceof Error?cause.message:String(cause);if(twoDVisibleRef.current&&twoDRuntime.current)twoDRuntime.current.reportError(message);else setError(message);return false;}
 }
 function captureTwoDGuard():TwoDCommitGuard{
  const file=twoDFileRef.current,projectEpoch=projectIdentityEpoch.current,activationEpoch=registry.getSnapshot().activationEpoch;
  if(!file)throw Error('二维会话已结束。');
  const targetId=registry.stamp().documentId,target=twoDOrigin.current==='manual'?registry.document(targetId):undefined;
  if(target&&(target.result||['starting','running','pausing','paused','stopping'].includes(target.runtime.phase)))throw Error('请先选择可编辑且没有运行任务的模型，再生成三维。');
  const targetRevision=target?.store.getSnapshot().revision;
  const guard:TwoDCommitGuard=()=>{if(twoDFileRef.current!==file||projectIdentityEpoch.current!==projectEpoch||registry.getSnapshot().activationEpoch!==activationEpoch||target&&target.store.getSnapshot().revision!==targetRevision)throw Error('三维生成所属草稿、项目或活动文档已变化，未提交迟到结果。');};
  guard.target=target?{kind:'replace',documentId:target.id,revision:targetRevision!}:{kind:'new'};return guard;
 }
 async function commitTwoD(fragment:FragmentSnapshot,files:File[],guard:TwoDCommitGuard){
  guard();if(twoDCommitting.current||projectActivity.current.busy||projectActivity.current.capturing)throw Error('项目正在提交或保存，请完成后再生成。');
  if(guard.target?.kind==='replace'){
   const target=registry.document(guard.target.documentId),preparedOwner=`two-d-source-stage-${crypto.randomUUID()}`;twoDCommitting.current=true;
   try{const bundle=await registerImportedModelSources([preparedOwner],files);if(!bundle)throw Error('二维来源尚未准备。');guard();
    const before=target.store.getSnapshot();target.store.execute({type:'replace-document',fragment});if(target.store.getSnapshot().revision===before.revision)throw Error('三维替换未提交，二维草稿已保留。');
    commitImportedModelSourceBundle(bundle,preparedOwner,target.id);setError('');
   }catch(cause){await forgetImportedModelSources(preparedOwner);throw cause;}finally{twoDCommitting.current=false;}return;
  }
  const pending=registry.prepareFragmentDocument(fragment);twoDCommitting.current=true;
  try{
   const bundle=await registerImportedModelSources([pending.id],files);
   if(!bundle)throw Error('模型的二维原始来源尚未登记。');
   guard();const created=pending.commit();
   registry.setModule('modeling');setMainDocumentId(created.id);setError('');
  }catch(cause){
   const cleanup:unknown[]=[];
   if(pending.state()==='prepared')pending.cancel();
   if(registry.getSnapshot().documents.some(entry=>entry.id===pending.id))try{await registry.closeDocument(pending.id,true);}catch(error){cleanup.push(error);}
   try{await forgetImportedModelSources(pending.id);}catch(error){cleanup.push(error);}
   if(cleanup.length)throw new AggregateError([cause,...cleanup],'二维提交失败，部分新建资源仍待收尾。');throw cause;
  }finally{twoDCommitting.current=false;}
 }
 const importFiles=useCallback(async(files:ScientificSourceFile[],resultChoice:'ask'|'analysis'|'structure'='ask'):Promise<void>=>{
  if(importResourceClosures.current.failedCount){setError('结构来源的读取资源仍待关闭，请先重试取消读取。');return;}
  try{const candidates=await Promise.all(files.map(isTwoDImportFile));if(candidates.some(Boolean)){if(files.length!==1)throw Error('二维图纸或图片请单独导入，其他文件尚未处理。');await openTwoDFiles(files);return;}}catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
  if(resultChoice==='analysis'||resultChoice==='ask'&&registry.getSnapshot().module==='analysis'){await postprocess.read(files,postprocess.fileOwnerId??postprocess.ownerId);return;}
  if(resultChoice==='ask'){
   try{const descriptions:string[]=[];for(const file of files){const source=resultFile(file);try{const identity=await identifyPostprocessSource(source);if(identity.kind!=='unsupported')descriptions.push(previewImportDescription(identity.kind,new TextDecoder().decode(await source.readRange(0,Math.min(source.size,1024*1024)))));}finally{await source.close?.();}}
    if(descriptions.length){resultImportChoice.current?.('cancel');setResultImportDescriptions(descriptions);setResultImportRequest(files);const choice=await new Promise<'analysis'|'structure'|'cancel'>(resolve=>{resultImportChoice.current=resolve;});if(choice!=='cancel')await importFiles(files,choice);return;}
   }catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
  }
  importController.current?.abort();const controller=new AbortController();importController.current=controller;
  const epoch=++importEpoch.current,initial=registry.getSnapshot(),lease=initial.activeViewId?registry.stamp():null;
  const readScope={epoch,settled:false};importReadScope.current=readScope;
  setReading(true);setReadProgress(null);setError('');
  const guard=()=>{if(epoch!==importEpoch.current||controller.signal.aborted)throw new Error('模型导入已取消。');if(lease)registry.assertIdentityCurrent(lease);else if(registry.getSnapshot().activationEpoch!==initial.activationEpoch)throw new Error('活动上下文已变化，请重新导入。');};
  let parsed:WorkspaceImportItem[]=[],committed=false;
  const fileOnlyImports:ScientificSourceFile[]=[],fileImportProjectEpoch=projectIdentityEpoch.current;
  try{
   guard();
   if(resultChoice==='structure'){
    const ordinary:ScientificSourceFile[]=[];
    for(const file of files){const input=resultFile(file,desktop?.registerSelectedOutputSource&&desktop.closeLaunchSource?{register:desktop.registerSelectedOutputSource.bind(desktop),close:desktop.closeLaunchSource.bind(desktop),describe:desktop.describeLaunchSource?.bind(desktop)}:undefined);let nativeSessionId:string|undefined,nativeClose:Promise<unknown>|undefined;
     const closeExtraction=()=>{if(!nativeSessionId)return Promise.resolve();if(!nativeClose)nativeClose=Promise.resolve(desktop?.commandOrbitals?.(nativeSessionId,{operation:'close'})).catch(cause=>{nativeClose=undefined;throw cause;});return nativeClose;};
     const cancelExtraction=()=>{void closeExtraction().catch(()=>{});};
     controller.signal.addEventListener('abort',cancelExtraction,{once:true});
     importResourceClosures.current.register(input.id,async()=>{const closed=await Promise.allSettled([closeExtraction(),input.close?.()]);const failed=closed.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failed.length)throw new AggregateError(failed.map(value=>value.reason),'结构来源的读取资源仍待实际关闭。');});
     try{const identity=await identifyPostprocessSource(input,{signal:controller.signal});guard();
      if(identity.kind==='unsupported'){ordinary.push(file);continue;}
      if(identity.kind==='gbw')throw new Error(identity.message??'GBW须先转换为Molden。');
      let source;
      if(identity.kind==='gaussian-output'||identity.kind==='orca-output'){
       const scientific=await readPostprocessFileOutput(input,{signal:controller.signal});
       if(isScientificFileSource(scientific)){await scientific.dispose();guard();fileOnlyImports.push(file);continue;}
       source=scientific;
      }
      else if(identity.kind==='xyz'||identity.kind==='hess')source=await readPostprocessAuxiliary(input,{signal:controller.signal});
      else{if(!desktop?.openOrbitalSession||!desktop.commandOrbitals)throw new Error('波函数结构读取需要完整桌面后端。');nativeSessionId=`extract-${crypto.randomUUID()}`;controller.signal.throwIfAborted();const metadata=await desktop.openOrbitalSession({sessionId:nativeSessionId,sourceId:input.id,name:file.name,...(await input.readCompanionSourceDescriptor?.(controller.signal)?{sourceToken:await input.readCompanionSourceToken?.(controller.signal)}:{text:await file.text()})});guard();source=await readPostprocessWavefunction(input,metadata,{signal:controller.signal});}
      try{guard();const result=source.results.at(-1)!;const structure=await result.getFrame(result.frames.length-1,controller.signal);structure.notes.push(`仅载入最后完整结构；来源 ${file.name}，整体状态 ${result.status}。`);parsed.push(...modelFragmentsFromStructures([structure]).map(fragment=>({kind:'model' as const,fragment})));}
      finally{await Promise.all([...new Set(source.results)].map(result=>Promise.resolve(result.dispose())));}
     }finally{controller.signal.removeEventListener('abort',cancelExtraction);try{await importResourceClosures.current.close(input.id);}catch(cause){setImportCloseFailed(true);throw cause;}}
    }
    if(ordinary.length)parsed.push(...await importWorkspaceItems(ordinary,{signal:controller.signal}));
   }else parsed=await importWorkspaceItems(files,{signal:controller.signal,onProgress:(done,total)=>{if(epoch===importEpoch.current)setReadProgress(total?Math.round(100*done/total):null);}});guard();
   const prepared=await prepareWorkspaceImportModels(parsed,{port:createChemistryPort(),signal:controller.signal,guard});guard();parsed=prepared.items;
   const resultWorkingStructures=new Map<import('../../results/contracts').TrajectoryResult,Structure>();
   for(const item of parsed)if(item.kind==='result'){
    const source=modelFragmentsFromStructures([item.result.initialStructure])[0];
    const preparedSource=await prepareWorkspaceImportModels([{kind:'model',fragment:source}],{port:createChemistryPort(),signal:controller.signal,guard});guard();
    const model=preparedSource.items[0];if(model.kind!=='model')throw Error('轨迹初始工作结构尚未准备完成。');
    resultWorkingStructures.set(item.result,model.fragment.structure);
   }
   const importedModelIds:string[]=[];
   for(const item of parsed){if(item.kind==='model')importedModelIds.push(registry.addFragmentDocument(item.fragment).id);else if(item.kind==='result')installAnalysisGuard(registry.addEditableResultDocument(item.result,resultWorkingStructures.get(item.result)!));}
   if(importedModelIds.length)await registerImportedModelSources(importedModelIds,files);
   addSourceDiagnostics(parsed.flatMap(item=>item.kind==='diagnostic'?[item.diagnostic]:[]));
   committed=true;if(parsed.some(item=>item.kind!=='diagnostic'))registry.setModule(parsed.filter(item=>item.kind!=='diagnostic').at(-1)?.kind==='result'?'analysis':'modeling');setError(prepared.warnings.join('；'));
   for(const file of fileOnlyImports)await postprocess.read([file],null,undefined,'smart',{guard:()=>{if(epoch!==importEpoch.current||controller.signal.aborted||projectIdentityEpoch.current!==fileImportProjectEpoch)throw Error('来源导入上下文已变化，未接入旧文件。');},signal:controller.signal,throwOnFailure:true});
  }catch(cause){if(epoch===importEpoch.current&&(!controller.signal.aborted||importResourceClosures.current.failedCount))setError(cause instanceof Error?cause.message:String(cause));}
  finally{if(!committed)await Promise.all(parsed.flatMap(item=>item.kind==='result'?[Promise.resolve(item.result.dispose())]:item.kind==='diagnostic'?[Promise.resolve(item.diagnostic.dispose())]:[]));readScope.settled=true;if(epoch===importEpoch.current){setReadProgress(null);if(!importResourceClosures.current.pendingCount){setReading(false);setImportCloseFailed(false);importController.current=null;}else{setReading(true);setImportCloseFailed(true);}}}
 },[registry,desktop,postprocess.read,addSourceDiagnostics]);
 const launchImportState=useRef({importFiles,canConsume:!reading&&!importCloseFailed&&!postprocess.busy&&!resultImportRequest});
 launchImportState.current={importFiles,canConsume:!reading&&!importCloseFailed&&!postprocess.busy&&!resultImportRequest};
 const launchConsumer=useRef<ReturnType<typeof consumeLaunchImports>|null>(null);
 useEffect(()=>{
  const bridge=desktop as typeof desktop&Partial<LaunchImportBridge>;
  if(!bridge?.claimLaunchImport||!bridge.finishLaunchImport||!bridge.readLaunchSource||!bridge.closeLaunchSource||!bridge.onLaunchImportAvailable)return;
  const consumer=consumeLaunchImports(bridge as LaunchImportBridge,files=>launchImportState.current.importFiles(files),setError,()=>launchImportState.current.canConsume);
  launchConsumer.current=consumer;
  return()=>{consumer.dispose();launchConsumer.current=null;resultImportChoice.current?.('cancel');resultImportChoice.current=null;};
 },[desktop]);
 useEffect(()=>{launchConsumer.current?.retry();},[reading,importCloseFailed,postprocess.busy,resultImportRequest]);
 useEffect(()=>()=>{importEpoch.current++;importController.current?.abort();void importResourceClosures.current.retry().catch(()=>{});for(const owner of displayOwners.current.values())owner.close();displayOwners.current.clear();displaySources.current.clear();for(const entry of registry.getSnapshot().documents)if(entry.result)void Promise.resolve(entry.result.dispose()).catch(()=>{});},[registry]);
 function currentViewPose(id=registry.getSnapshot().views.find(view=>view.id===registry.getSnapshot().activeViewId)?.documentId){
  const viewport=id?viewportStates.current.get(id):undefined;
  const camera=id?viewportControllers.current.get(id)?.getCameraView?.()??viewport?.cameraView:undefined;
  const transform=pagePresentations.current.get(id??'')?.analysisCanvas?.viewport.viewTransform??viewport?.viewTransform;
  return {camera:camera?[...camera]:undefined,transform:transform?structuredClone(transform):undefined};
 }
 function extractFrame(structure:Structure){advancedPorts.current.postprocess.selectFile(null);const view=currentViewPose(),entry=registry.addDocument(structuredClone(structure));inheritedViews.current.set(entry.id,view);registry.setModule('modeling');setError('');}
 function extractAdvancedFrame(source:AdvancedFrameSource){const view=currentViewPose(),entry=registry.addFragmentDocument(advancedFrameFragment(source));inheritedViews.current.set(entry.id,view);registry.setModule('modeling');setError('');}
 function prepareBatchInput(sources:readonly AdvancedFrameSource[],coreIds:readonly string[],activeFrameId?:string){
  try{
   if(borrowedBatchRef.current)throw Error('已有批量输入会话，请先完成或明确取消。');
   registry.assertCurrentInputTaskIdle();
   const previous=registry.getSnapshot();
   if(previous.inputTask&&inputControllers.current.get(previous.inputTask.documentId)?.isBusy())throw Error('输入正在处理，请先完成或取消当前操作。');
   const session=createBatchInputSession({sources,coreIds,activeFrameId}),source=batchInputRepresentative(session),pose=currentViewPose();
   const previousDocument=previous.documents.find(entry=>previous.views.find(view=>view.id===previous.activeViewId)?.documentId===entry.id);
   const fragment=advancedFrameFragment(source);fragment.sharedConstraints=batchInputInitialConstraints(session);fragment.coordinateObjects=[];fragment.internalCoordinates=[];
   const {entry,input}=registry.addBorrowedInputDocument(fragment,'代表帧');inheritedViews.current.set(entry.id,pose);
   const value:BorrowedBatch={session,documentId:entry.id,previousViewId:previous.activeViewId,previousModule:previous.module,previousDocumentId:previousDocument?.id,previousFrameId:previousDocument?.trajectory?.currentFrameId,input,camera:pose.camera};
   borrowedBatchRef.current=value;setBorrowedBatch(value);setMainDocumentId(entry.id);registry.setModule('input');setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 async function finishBatchInput(sessionId:string){
  const borrowed=borrowedBatchRef.current;if(!borrowed||borrowed.session.id!==sessionId)return;
  await close(borrowed.documentId,true);
  if(registry.getSnapshot().documents.some(entry=>entry.id===borrowed.documentId))return;
  // Clear identity before restoring any view; duplicate/late callbacks are inert.
  borrowedBatchRef.current=null;setBorrowedBatch(null);setCancelBatchConfirm(false);registry.releaseBorrowedInputTask(borrowed.input);
  const snapshot=registry.getSnapshot(),parent=snapshot.documents.find(entry=>entry.id===borrowed.previousDocumentId);
  if(parent?.trajectory&&borrowed.previousFrameId&&parent.trajectory.frameIds.includes(borrowed.previousFrameId))registry.selectTrajectoryFrame(parent.id,borrowed.previousFrameId);
  if(borrowed.previousViewId&&snapshot.views.some(view=>view.id===borrowed.previousViewId)){
   flushSync(()=>{
    registry.activate(borrowed.previousViewId!);setMainDocumentId(borrowed.previousDocumentId??null);registry.setModule(borrowed.previousModule);
    // The parent controller is stable, but its dispatcher still belongs to its
    // previous render until React commits the restored document/activation.
    if(borrowed.previousDocumentId&&borrowed.camera)pendingCameraRestores.current.set(borrowed.previousDocumentId,{stamp:registry.stamp(),view:[...borrowed.camera]});
   });
  }
 }
 function restoreCommittedCamera(id:string,viewport:WorkspaceViewportState){
  const pending=pendingCameraRestores.current.get(id);if(!pending)return;
  const current=registry.getSnapshot(),entry=current.documents.find(value=>value.id===id),view=current.views.find(value=>value.id===current.activeViewId);
  if(!entry||entry.epoch!==pending.stamp.documentEpoch||entry.store.getSnapshot().revision!==pending.stamp.revision||view?.id!==pending.stamp.viewId||current.activationEpoch!==pending.stamp.activationEpoch){pendingCameraRestores.current.delete(id);return;}
  if(viewport.documentId!==id||viewport.revision!==pending.stamp.revision||!viewport.interactionOwnerActive||viewport.interactionActivationEpoch!==pending.stamp.activationEpoch)return;
  const controller=viewportControllers.current.get(id);if(!controller)return;
  pendingCameraRestores.current.delete(id);
  void Promise.resolve(controller.dispatch({type:'camera',view:pending.view})).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
 }
 function prepareAdvancedInput(source:AdvancedFrameSource,confirmed=false){
  try{const previous=registry.getSnapshot().inputTask,old=previous?registry.document(previous.documentId):null;
   if(borrowedBatchRef.current)throw Error('请先完成或取消当前批量输入会话。');
   if(confirmed&&advancedInputTarget?.previousTaskId!==previous?.id)throw Error('输入任务已变化，请重新准备输入。');
   registry.assertCurrentInputTaskIdle();
   const pose=currentViewPose();
   const result=prepareAdvancedFrameInput(source,{hasDirtyInput:Boolean(old&&(old.inputDirty.gaussian||old.inputDirty.orca)),busy:Boolean(previous&&inputControllers.current.get(previous.documentId)?.isBusy()),create:fragment=>{const entry=registry.addFragmentDocument(fragment);inheritedViews.current.set(entry.id,pose);return entry.id;},start:startNewInputTask},confirmed);
   if(result==='confirmation-required')setAdvancedInputTarget({source,previousTaskId:previous?.id});else setAdvancedInputTarget(null);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function prepareIrc(structure:Structure,engine:'gaussian'|'orca',confirmed=false){
  try{const previous=registry.getSnapshot().inputTask,old=previous?registry.document(previous.documentId):null;
   if(borrowedBatchRef.current)throw Error('请先完成或取消当前批量输入会话。');
   if(old&&!confirmed&&(old.inputDirty.gaussian||old.inputDirty.orca)){setPreparedInputTarget({structure:structuredClone(structure),engine});return;}
   registry.assertCurrentInputTaskIdle();
   if(old&&inputControllers.current.get(old.id)?.isBusy())throw new Error('当前输入所属模型仍在处理，请先停止或完成后再从结果新建。');
   const intent=prepareIrcIntent(structure,engine),copy=structuredClone(structure);copy.name+=' - IRC';copy.notes.push(...intent.notices);const entry=registry.addPreparedInput(copy,intent);registry.beginInputTask(entry.id);inputControllers.current.get(old?.id??'')?.cancel();setSourceRoles({});setPreparedInputTarget(null);registry.setModule('input');setError(intent.notices.join(' '));}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function surface(entry:WorkspaceDocumentEntry):DocumentWorkspaceSurface {
  let bound=callbacks.current.get(entry.id);
  if(!bound){
   bound={entry,active:false,inputActive:false,module:'modeling',sources:[],getCurrentSources:()=>registry.getSnapshot().documents.filter(item=>!item.result).map(item=>registry.source(item.id)),stamp:registry.stamp,assertCurrent:registry.assertCurrent,assertIdentityCurrent:registry.assertIdentityCurrent,assertRuntimeCurrent:registry.assertRuntimeCurrent,
    inputStamp:registry.inputStamp,assertInputIdentityCurrent:registry.assertInputIdentityCurrent,
    onInputController:controller=>{if(controller)inputControllers.current.set(entry.id,controller);else inputControllers.current.delete(entry.id);},onInputHistoryChange:notifyInputHistoryChange,onNewInputTask:requestNewInputTask,
    onSubmitExternalInput:draft=>{if(registry.stamp().documentId!==entry.id)throw Error('输入所属文档已切换，请重新提交。');return taskWorkspace.submit(draft);},
    onPreparedInput:input=>{if(!registry.getSnapshot().documents.some(row=>row.id===entry.id&&row.epoch===entry.epoch))throw new Error('输入所属文档已关闭，未追加引用。');const batch=borrowedBatchRef.current,target=batch?.documentId===entry.id?batch.previousDocumentId:entry.id;if(!target||!registry.getSnapshot().documents.some(row=>row.id===target))throw new Error('输入原属文档已关闭，未追加引用。');setCitationState(previous=>appendPreparedInput(previous,target,input));},
    onImportFiles:importFiles,onImportTwoDFiles:openTwoDFiles,onOpenTwoD:openTwoDManual,twoDActive:twoDVisible,onNewDocument:createDocument,onOpenStructureLibrary:()=>setStructureLibraryOpen(true),sharedLayout:false,toolHost:null,toolbarHost:null,inputHost:null,
    onToolSurfaceChange:surface=>{if(registry.stamp().documentId===entry.id)toolSurface.publish(surface);},
    onLeftToolSurfaceChange:surface=>{if(['modeling','advanced-modeling'].includes(registry.getSnapshot().module)&&registry.stamp().documentId===entry.id){leftToolSurface.publish(surface);setLeftToolOpen(Boolean(surface));}},
    onAdvancedModelingBack:()=>setAdvancedModelingRoute(route=>route?{...route,task:null}:null),
    onAdvancedModelingRouteChange:setAdvancedModelingRoute,
    onDeriveStructure:candidate=>{void(async()=>{const stamp=registry.stamp();if(stamp.documentId!==entry.id)throw Error('当前结构已切换，未创建派生文档。');const route=pagePresentations.current.get(entry.id)?.advancedModelingRoute,frameKey=scientificFrameKey(entry.id),sourceEpoch=entry.sourceEpoch;
     if(protectedConformerSource(entry.id)){if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;try{if(!await confirmConformerCopy(stamp))return;registry.assertCurrent(stamp);if(registry.document(entry.id).sourceEpoch!==sourceEpoch||scientificFrameKey(entry.id)!==frameKey)throw Error('来源帧已变化，未应用过期变换。');}finally{sourceCopyBusy.current=false;}}
     const child=registry.deriveDocument(stamp,candidate);if(route)derivedModelingRoutes.current.set(child.id,{category:route.category,task:null});setMainDocumentId(child.id);setError('');})().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},
    onWorkspaceHistory:kind=>{if(viewportControllers.current.get(entry.id)?.isBusy()&&!entry.store.isRuntimeEditingAllowed?.())throw Error('当前文档仍在计算或保存，请结束后再撤销。');if(registry.getSnapshot().module==='input'&&inputControllers.current.get(entry.id)?.history?.(kind))return true;return registry[kind](entry.id);},
    ...presentationFor(entry.id),
    onRequestSourcePick:request=>requestTaskSource(entry.id,request),onImportSources:files=>importTaskSources(entry.id,files),
    onCancelSourcePick:()=>setSourcePick(previous=>previous?.ownerId===entry.id?null:previous),
    onSourceRolesChange:roles=>setSourceRoles(previous=>JSON.stringify(previous[entry.id])===JSON.stringify(roles)?previous:{...previous,[entry.id]:roles}),
   displaySettings,onDisplaySettingsChange:changeDisplaySettings,onOpenSettings:openDisplaySettings,sharedShowAxes,onSharedShowAxesChange:setSharedShowAxes,toolIntent,onToolIntentChange:setToolIntent,viewportActive:false,legendVisible:false,layoutActions:null,legendExpanded,onLegendExpandedChange:setLegendExpanded,
    onActivate:()=>activateDocument(entry.id),
    onSavedName:name=>{registry.rename(entry.id,name);publishMetadata(entry.id);},
    onViewportState:value=>{restoreCommittedCamera(entry.id,value);if(JSON.stringify(viewportStates.current.get(entry.id))===JSON.stringify(value))return;viewportStates.current.set(entry.id,value);publishMetadata(entry.id);},
    onDisplayProjection:(projection,observer)=>{const previous=displaySources.current.get(entry.id),signature=projection?viewportDisplaySignature(projection):'';if(previous?.signature===signature){previous.observer=observer;if(projection){previous.projection=projection;displayOwners.current.get(entry.id)?.publish(projection,previous.descriptor.projectionSerial);}return;}if(!previous&&!projection)return;const serial=(displaySerials.current.get(entry.id)??0)+1;displaySerials.current.set(entry.id,serial);if(projection){const {viewport:_viewport,...identity}=projection;displaySources.current.set(entry.id,{projection,descriptor:{...identity,projectionSerial:serial},signature,observer});}else displaySources.current.delete(entry.id);displayOwners.current.get(entry.id)?.publish(projection,serial);publishMetadata(entry.id);},
    onViewportController:controller=>{if(controller)viewportControllers.current.set(entry.id,controller);else viewportControllers.current.delete(entry.id);},
    onElectronicConfirmation:confirmed=>{registry.confirmElectronicState(entry.id,confirmed);publishMetadata(entry.id);},
    onDraftState:(engine,value,dirty)=>{if(registry.getSnapshot().inputTask?.documentId===entry.id){registry.setDraft(entry.id,engine,value,dirty);publishMetadata(entry.id);}},
    onRuntime:controller=>{if(!registry.getSnapshot().documents.some(value=>value.id===entry.id))return;const current=registry.document(entry.id),previous=runtimeOwners.current.get(entry.id);if(previous?.controller===controller)return;
     previous?.unsubscribe();if(!controller){runtimeOwners.current.delete(entry.id);if(current.runtime.ownerId&&!['starting','running','pausing','paused','stopping'].includes(current.runtime.phase))registry.releaseRuntime(entry.id,entry.epoch);return;}
     registry.claimRuntime(entry.id,entry.epoch);const update=()=>{const phase=controller.getSnapshot().status;if(current.runtime.phase!==phase){registry.runtimePhase(entry.id,entry.epoch,phase);publishMetadata(entry.id);}};runtimeOwners.current.set(entry.id,{controller,unsubscribe:controller.subscribe(update)});
    }
   };callbacks.current.set(entry.id,bound);
  }
  const viewportActive=!fileCurrent&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!detached[entry.id]&&(state.module==='modeling'||state.module==='input'||analysisLayout||advancedLayout||advancedModelingLayout)&&((analysisLayout||advancedLayout||advancedModelingLayout)?entry.id===displayedDocumentId:sharedLayout?deckMode!=='single'||entry.id===displayedDocumentId:entry.id===activeId);
  if(entry.id===activeId)pagePresentations.current.set(entry.id,{
   advancedModelingRoute:advancedModelingLayout?advancedModelingRoute:undefined,
   analysisCanvas:entry.trajectory&&registry.analysisAvailable(entry.id)?trajectoryCanvases[entry.id]??undefined:advancedLayout?(xtbAnalysisLayout?xtbCanvasFor(entry):advancedCanvases[entry.id]):analysisLayout&&registry.analysisAvailable(entry.id)?analysisCanvases[entry.id]??undefined:undefined,
   samplingSphereDraft:advancedLayout&&advancedSection==='conformer'&&samplingSphereDraft?.sourceDocumentId===entry.id?samplingSphereDraft:undefined,
  });
  return {...bound,entry,onCipLabelsUsed:cipUsageFor(entry.id,entry.epoch),twoDActive:twoDVisible,active:!fileCurrent&&entry.id===activeId&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!ownerHidden&&!taskWorkspace.opened&&(state.module==='modeling'||state.module==='input'||analysisLayout||advancedLayout||advancedModelingLayout),inputActive:entry.id===inputOwnerId&&state.module==='input'&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!ownerHidden&&!taskWorkspace.opened,inputTaskId:entry.id===inputOwnerId?inputTask?.id:undefined,module:state.views.find(view=>view.documentId===entry.id)?.module??state.module,sources,sharedLayout,toolHost,toolbarHost,inputHost:inputHosts[entry.id]??null,viewportDockTarget:dockTarget,
   batchInputSession:borrowedBatch?.documentId===entry.id?borrowedBatch.session:undefined,onFinishBatchInput:id=>{void finishBatchInput(id).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},initialCameraView:inheritedViews.current.get(entry.id)?.camera,initialViewTransform:inheritedViews.current.get(entry.id)?.transform,
   workspaceCanUndo:(state.module==='input'&&Boolean(inputControllers.current.get(entry.id)?.canUndo?.()))||registry.canUndo(entry.id),workspaceCanRedo:(state.module==='input'&&Boolean(inputControllers.current.get(entry.id)?.canRedo?.()))||registry.canRedo(entry.id),
   displaySettings,onDisplaySettingsChange:changeDisplaySettings,onOpenSettings:openDisplaySettings,sharedShowAxes,onSharedShowAxesChange:setSharedShowAxes,toolIntent,onToolIntentChange:setToolIntent,viewportActive,presentationActive:entry.id===displayedDocumentId,legendVisible:entry.id===displayedDocumentId,layoutActions,legendExpanded,onLegendExpandedChange:setLegendExpanded,
   ...pagePresentations.current.get(entry.id),onSamplingSphereRadiusChange:setSamplingSphereRadiusChange,
   onAdvancedModelingRouteChange:setAdvancedModelingRoute,onAdvancedModelingBack:()=>setAdvancedModelingRoute(route=>route?{...route,task:null}:null),
   structureAnalysisActive:currentStructureAnalysisActive({documentId:entry.id,activeDocumentId:activeId,displayedDocumentId,module:state.module,selected:structureAnalysisSelected[entry.id]===true,hasResult:Boolean(entry.result||entry.legacyResult),hasPostprocessDocument:Boolean(postprocess.documents[entry.id]),blocked:taskWorkspace.opened||ownerHidden||closingPending||closeConfirmIds.includes(entry.id)||Boolean(detached[entry.id])}),
   linkedAtomActions:linkedControls.actions,linkedAtomsActive:linkedControls.linked?.documentIds.includes(entry.id),onAtomNumberPick:linkedControls.swapping&&linkedControls.linked?.documentIds.includes(entry.id)?atomId=>linkedControls.pickAtom(entry.id,atomId):undefined,
   workspaceDocumentPickMode:sourcePick?'source':linkedControls.selecting?'link':undefined,workspaceDocumentPickSelected:linkedControls.selected.includes(entry.id),workspaceInputRoles:state.module==='input'&&inputTask?(sourceRoles[inputOwnerId??'']??[]).filter(role=>role.documentId===entry.id).map(role=>({taskId:inputTask.id,role:role.label.includes('反应物')?'reactant':role.label.includes('产物')?'product':'tsGuess',label:role.label})):[]};
 }
 async function detachDocument(id:string,x:number,y:number){
  if(borrowedBatchRef.current?.documentId===id){setError('批量输入代表帧保留在当前工作区，完成或取消后自动释放。');return;}
  if(!hostBridge?.detachWorkspaceDocument){setError('独立系统窗口需要桌面版本。');return;}
  if(registry.document(id).result){setError('结果视图请先取帧为模型，再拖出编辑。');return;}
  if(!internalModels.some(entry=>entry.id!==id&&!closeConfirmIds.includes(entry.id))){setError('主窗口至少需要保留一个内部建模页，当前模型不能拖出。');return;}
  try{const adapter=ownerAdapters.current.get(id);if(!adapter)throw new Error('模型还未连接。');await adapter.flush();await hostBridge.detachWorkspaceDocument({...authFor(id),placement:{x:Math.round(x-80),y:Math.round(y-30),width:900,height:680}});setError('');}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 const modules:Array<[WorkspaceModule,string,typeof Atom]>=[['modeling','建模',Atom],['advanced-modeling','高级建模',Boxes],['input','输入文件',FileCode2],['advanced','高级任务',Workflow],['analysis','后处理',ChartNoAxesCombined]];
 const analysisColumns=useWorkspaceColumns("postprocess");
 const rightWidth=workbench.layout.id==='default'&&workbench.layout.paneSizes.rightWidth===DEFAULT_WORKBENCH_PANE_SIZES.rightWidth?Math.max(220,Math.round(availableWidth*.2)):workbench.layout.paneSizes.rightWidth;
 const resizeTools=(width:number)=>workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,rightWidth:clampWorkbenchPaneSize('rightWidth',width)}}));
 const layoutActions=sharedLayout&&!analysisLayout&&!advancedLayout?<span className="workspace-layout-actions">
  <button type="button" aria-label="展开模型视口" aria-pressed={deckMode!=='single'} disabled={internalModels.length<2} onClick={()=>setDeckMode(value=>value==='single'?multiMode:'single')}>平铺</button>
  <select aria-label="模型排列方式" value={multiMode} onChange={event=>{const value=event.target.value as 'tiled'|'free';setMultiMode(value);setDeckMode(value);}}><option value="tiled">规整平铺</option><option value="free">自由排布</option></select>
  {linkedControls.actions}
  {deckMode!=='single'&&<button onClick={()=>setArrangeRequest(value=>value+1)}>重新整理</button>}
 </span>:null;
 const analysisCurrent=fileCurrent?null:postprocess.current;
 const analysisSelectionMatches=analysisCurrent&&postprocessDocumentEngine(analysisCurrent)===postprocess.engine&&postprocess.task===postprocessDocumentTask(analysisCurrent);
 const sidebarDocument=analysisSelectionMatches?analysisCurrent:null;
 const sidebarCanvas=sidebarDocument&&postprocess.ownerId?analysisCanvases[postprocess.ownerId]:null;
 const sidebarStructure=fileCurrent?fileObservedStructures[fileCurrent.id]??undefined:sidebarCanvas?.document?.draft.structure;
 const sidebarActiveResult=postprocess.ownerId&&activeAnalysisResults[postprocess.ownerId]?.source===sidebarDocument?activeAnalysisResults[postprocess.ownerId]?.result:null;
 const sidebarResult=fileCurrent?fileCurrent.displayResult:sidebarActiveResult??sidebarCanvas?.result??sidebarDocument?.result??active?.legacyResult;
 const sidebarFrameReady=fileCurrent?Boolean(fileCurrent.displayResult&&sidebarStructure):Boolean(sidebarDocument&&postprocess.ownerId&&registry.analysisAvailable(postprocess.ownerId)&&(sidebarDocument.result.kind!=='optimization'||sidebarStructure));
 const currentStructureEntry=analysisLayout&&!fileCurrent&&!analysisCurrent&&active&&!active.result&&!active.legacyResult&&!postprocess.documents[active.id]&&activeId===displayedDocumentId&&!detached[active.id]?active:null;
 const currentStructureSelected=Boolean(currentStructureEntry&&surface(currentStructureEntry).structureAnalysisActive);
 const extractCurrentAnalysis=()=>{const structure=sidebarStructure??(sidebarDocument?.result.kind!=='optimization'?sidebarDocument?.result.initialStructure:undefined);return structure?structuredClone(structure):null;};
 const uiVersion=useSyncExternalStore(projectUi.subscribe,projectUi.getVersion,projectUi.getVersion);
 const analysisVersion=useSyncExternalStore(subscribeAnalysisProjectState,getAnalysisProjectRevision,getAnalysisProjectRevision);
 const pendingAdvancedProject=useRef<(()=>Promise<AdvancedProjectSnapshot|undefined>)|null>(null);
 const pendingAdvancedRestore=useRef<{read:()=>Promise<AdvancedProjectSnapshot|undefined>;promise:Promise<void>}|null>(null);
 const [advancedRestoreRevision,setAdvancedRestoreRevision]=useState(0);
 const pendingAdvancedProjectChanged=useRef(false);
 async function ensurePendingAdvancedProject(){
  const read=pendingAdvancedProject.current;if(!read)return;
  if(!advancedController)throw Error('构象任务owner尚未就绪，请稍后重试。');
  if(pendingAdvancedRestore.current?.read===read)return pendingAdvancedRestore.current.promise;
  const projectEpoch=projectIdentityEpoch.current,oldProjection=advancedHydrationProjection.current.project(readAdvanced());
  const promise=(async()=>{const snapshot=await read();if(pendingAdvancedProject.current!==read||projectIdentityEpoch.current!==projectEpoch)throw Error('项目来源已更换，未恢复旧构象内容。');if(snapshot)advancedController.restoreProjectSnapshot(snapshot);advancedHydrationProjection.current.record(readAdvanced(),oldProjection);pendingAdvancedProject.current=null;setAdvancedRestoreRevision(value=>value+1);})();
  pendingAdvancedRestore.current={read,promise};
  try{await promise;}finally{if(pendingAdvancedRestore.current?.promise===promise)pendingAdvancedRestore.current=null;}
 }
 const pendingProjectDetaches=useRef<Record<string,{x:number;y:number;width:number;height:number}>>({});
 const restoringProjectDetaches=useRef(new Set<string>());
 const [projectDetachRevision,setProjectDetachRevision]=useState(0);
 const restoringProject=useRef(false);
 const [restoringDocumentViews,setRestoringDocumentViews]=useState(false);
 const [detachedProjectSaveEpoch,setDetachedProjectSaveEpoch]=useState(0);
 const projectRevision=JSON.stringify([state.documents.map(entry=>[entry.id,entry.label,entry.store.getSnapshot().revision,entry.drafts,entry.trajectory?.currentFrameId]),state.module,order,conformerGroups,displaySettings,workbench.layout,uiVersion,analysisVersion,advancedHydrationProjection.current.project(advancedStatusProjection),Object.keys(postprocess.documents),Object.values(postprocess.fileDocuments).map(value=>[value.id,postprocessFileDocumentVersion(value)]),postprocess.fileOwnerId,fileSidebarCollapsed,sourceDiagnostics.map(item=>item.id),citationState,plots.map(plot=>[plot.id,plot.kind]),taskSnapshotPages,detachedProjectSaveEpoch,xtbElectronicDrafts,xtbTaskSelections,xtbMethodDrafts]);
 const capturedProjectRevisions=useRef(new Map<string,number>());
 const capturedProjectModels=useRef(new Map<string,WorkspaceModelSnapshot>());
 const projectMDSnapshotSources=useRef<unknown>(undefined),capturedProjectMDSnapshotSources=useRef<unknown>(undefined);
 const retainedProjectShell=useRef<Record<string,unknown>>({});
 const preservedProjectFileSources=useRef<Record<string,string>>({});
 const project=useProjectWorkspace({revision:projectRevision,onError:setError,restoring:restoringProject.current||(state.module==='advanced'&&pendingAdvancedProject.current!==null)||Object.keys(pendingProjectDetaches.current).length>0,
  onSaved:(_description,detail)=>{projectMDSnapshotSources.current=capturedProjectMDSnapshotSources.current;if(!detail.automatic){markCapturedWorkspaceModelsApplied(registry,capturedProjectRevisions.current,capturedProjectModels.current);if(capturedProjectModels.current.size)setDetachedProjectSaveEpoch(value=>value+1);}},
  capture:async(writer,_reader,options)=>{
   if(twoDCommitting.current)throw Error('二维模型正在提交，请稍后保存。');
   projectActivity.current.capturing=true;try{
   const modelSnapshots=await captureWorkspaceModelSnapshots({registry,runtimeOwner:id=>runtimeOwners.current.get(id)?.controller,generation:()=>projectIdentityEpoch.current});
   await Promise.all([...ownerAdapters.current.values()].map(adapter=>adapter.flush()));
   capturedProjectRevisions.current=new Map(registry.getSnapshot().documents.map(entry=>[entry.id,entry.store.getSnapshot().revision]));
   capturedProjectModels.current=modelSnapshots;
   const cameras=Object.fromEntries(state.documents.map(entry=>[entry.id,viewportControllers.current.get(entry.id)?.getCameraView?.()??viewportStates.current.get(entry.id)?.cameraView??null]));
   const windowPlacements=await desktop?.readProjectWindowPlacements?.();
   const advanced=pendingAdvancedProject.current?(options.reuse&&!pendingAdvancedProjectChanged.current?undefined:await pendingAdvancedProject.current()):advancedController?.exportProjectSnapshot();
   const sourceDiagnosticSnapshots=await Promise.all(sourceDiagnosticsRef.current.map(item=>encodeDiagnostic(item,writer)));
   const retainedFileDocuments=postprocess.captureFileDocuments();
   const captured=await captureWorkspaceProject({registry,documents:postprocess.documents,fileDocuments:retainedFileDocuments,preservedFileSources:preservedProjectFileSources.current,generated:postprocess.generated,advanced,ui:projectUi.capture(),writer,reuse:options.reuse,modelSnapshots,
    shell:{...retainedProjectShell.current,postprocessFileOwnerId:postprocess.fileOwnerId,postprocessFileSidebarCollapsed:Object.fromEntries(Object.entries(fileSidebarCollapsed).filter(([id])=>Boolean(postprocess.fileDocuments[id]))),deckMode,multiMode,order,mainDocumentId,displaySettings,sharedShowAxes,conformerGroups,conformerFrameOrders,plots:retainedFilePathPlots(plots,retainedFileDocuments),workbench:workbench.layout,cameras,windowPlacements,advancedObservations,advancedAnalysisBindings,xtbAnalysisSelections,...(()=>{const value=restoreWorkspaceXtbSettings({electronicDrafts:xtbElectronicDrafts,taskSelections:xtbTaskSelections,methodDrafts:xtbMethodDrafts});return {xtbElectronicDrafts:value.electronicDrafts,xtbTaskSelections:value.taskSelections,xtbMethodDrafts:value.methodDrafts};})(),structureAnalysisSelected,legendExpanded,taskSnapshotPages:Object.fromEntries(Object.entries(taskSnapshotPagesRef.current).filter(([,row])=>registry.getSnapshot().documents.some(entry=>entry.id===row.documentId)||Boolean(postprocess.fileDocuments[row.documentId]))),sourceDiagnostics:sourceDiagnosticSnapshots,citationState:retainedCitationState(citationStateRef.current,new Set(retainedCitationOwnerIds(registry.getSnapshot().documents,postprocess.captureFileDocuments()))),...(projectMDSnapshotSources.current===undefined?{}:{mdSnapshotSources:projectMDSnapshotSources.current})}});
   capturedProjectMDSnapshotSources.current=captured.shell.mdSnapshotSources;return captured;
   }finally{projectActivity.current.capturing=false;}
  },
  restore:async(value,reader)=>{
   if(postprocess.isBusy())throw Error('来源仍在读取或切换，请完成或取消后再载入另一项目。');
   // The unsubmitted 2D board is owned by this window, not by the project being restored.
   twoDRuntime.current?.cancelGesture();
   if(pendingDiscards.current.size)throw Error('已有内容仍待释放，请先重试释放后再载入另一项目。');
   // Layout capture cleanup must finish against the old UI generation. Keep
   // every rendered document/portal unmounted across asynchronous graph restore.
   restoringProject.current=true;
   projectIdentityEpoch.current++;advancedHydrationProjection.current.reset();conformerPlayerCollections.current.clear();conformerCollectionCache.current=new WeakMap();
   taskWorkspace.leave();
   conformerCollectionPublisher.current.reset();for(const value of conformerPrepared.current.values())value.abort.abort();conformerPrepared.current.clear();discardConfirmSerial.current++;discardImpactRef.current=null;setDiscardImpact(null);setClosing(null);setCloseConfirmIds([]);
   // Claim can enter here from a React effect. Leave that lifecycle before
   // requesting a synchronous unmount, which React otherwise cannot perform.
   await Promise.resolve();
   flushSync(()=>setRestoringDocumentViews(true));
   let decodedFileSources:Record<string,PostprocessScientificFileDocument>={},fileSourcesInstalled=false;
   try{
    const restored=await decodeWorkspaceProject(value,reader),shell=restored.data.shell as Record<string,any>;
    decodedFileSources=restored.fileSources;
    const xtbSettings=restoreWorkspaceXtbSettings({electronicDrafts:shell.xtbElectronicDrafts,taskSelections:shell.xtbTaskSelections,methodDrafts:shell.xtbMethodDrafts});
    setCitationOpen(null);setCitationState(restoreCitationState(shell.citationState));
    const restoredDiagnostics=(shell.sourceDiagnostics??[]).map((snapshot:DiagnosticProjectSnapshot)=>decodeDiagnostic(snapshot,reader));
    // Retire the new window's initial blank owner before replacing its IDs.
    // Its queued publisher must never query a document removed by hydration.
    for(const [id,adapter]of ownerAdapters.current){await adapter.flush();if(hostBridge&&adapter.getState().membership)await hostBridge.closeWorkspaceDocument(authFor(id));adapter.dispose();}
    ownerAdapters.current.clear();viewportStates.current.clear();viewportControllers.current.clear();callbacks.current.clear();
    for(const id of [...Object.keys(postprocess.captureFileDocuments()),...postprocess.pendingFileCloses()]){const issues=await postprocess.closeFile(id);if(issues.length)throw Error(`旧文件来源尚未释放：${issues.join('；')}`);}
    await registry.restoreProjectState(restored.registry,{results:restored.results});
    retainedProjectShell.current=structuredClone(shell);projectMDSnapshotSources.current=shell.mdSnapshotSources;capturedProjectMDSnapshotSources.current=undefined;capturedProjectModels.current=new Map();
    postprocess.restoreProjectDocuments(restored.sources,restored.generated);
    preservedProjectFileSources.current={...restored.fileSourceIssues};
    postprocess.restoreFileDocuments(restored.fileSources,typeof shell.postprocessFileOwnerId==='string'?shell.postprocessFileOwnerId:null);setFileSidebarCollapsed(Object.fromEntries(Object.entries(shell.postprocessFileSidebarCollapsed??{}).filter(([id,value])=>Boolean(restored.fileSources[id])&&typeof value==='boolean')) as Record<string,boolean>);fileSourcesInstalled=true;
    const taskPages=Object.fromEntries(Object.entries(shell.taskSnapshotPages??{}).filter((entry):entry is [string,{documentId:string;sourceId:string;taskId:string;runId:string|null;libraryId:string;sourceSetId?:string;sourceVersion?:string}]=>{const row=entry[1] as Record<string,unknown>|null;return Boolean(row&&['documentId','sourceId','taskId','libraryId'].every(key=>typeof row[key]==='string')&&(typeof row.runId==='string'||row.runId===null&&typeof row.sourceSetId==='string'&&!!row.sourceSetId&&typeof row.sourceVersion==='string'&&!!row.sourceVersion)&&(restored.sources[row.documentId as string]?.result.source.id===row.sourceId||restored.fileSources[row.documentId as string]?.output.source.identity.id===row.sourceId));}));taskSnapshotPagesRef.current=taskPages;setTaskSnapshotPages(taskPages);
    // No one-shot snapshot consumer may mount before these saved values exist.
    // Late cleanup callbacks still carry the prior generation and are rejected.
    projectUi.hydrate(restored.data.ui);
    await Promise.all(sourceDiagnosticsRef.current.map(item=>Promise.resolve(item.dispose())));sourceDiagnosticsRef.current=restoredDiagnostics;setSourceDiagnostics(restoredDiagnostics);setDiagnosticsOpen(false);
    setDeckMode(shell.deckMode??'single');setMultiMode(shell.multiMode??'tiled');setOrder(shell.order??[]);setMainDocumentId(shell.mainDocumentId??null);
    if(shell.displaySettings)changeDisplaySettings(shell.displaySettings);setSharedShowAxes(shell.sharedShowAxes===true);
    setConformerGroups(shell.conformerGroups??{});setConformerFrameOrders(shell.conformerFrameOrders??{});setPlots(retainedFilePathPlots(shell.plots??[],restored.fileSources));
    setAdvancedObservations(shell.advancedObservations??{});setAdvancedAnalysisBindings(shell.advancedAnalysisBindings??{});setXtbAnalysisSelections(shell.xtbAnalysisSelections??{});setStructureAnalysisSelected(shell.structureAnalysisSelected??{});setLegendExpanded(shell.legendExpanded!==false);
    xtbElectronicLeases.current.clear();xtbWorkingBindings.current.clear();setXtbElectronicContexts({});setXtbElectronicDrafts(xtbSettings.electronicDrafts);setXtbTaskSelections(xtbSettings.taskSelections);setXtbMethodDrafts(xtbSettings.methodDrafts);
    if(shell.workbench)workbench.updateLayout(shell.workbench);
    pendingProjectDetaches.current=shell.windowPlacements?.detached??{};setProjectDetachRevision(value=>value+1);
    if(shell.windowPlacements?.main)await desktop?.restoreProjectWindowPlacement?.(shell.windowPlacements.main);
    for(const [id,camera]of Object.entries(shell.cameras??{}))if(Array.isArray(camera)){if(registry.stamp().documentId===id)pendingCameraRestores.current.set(id,{stamp:registry.stamp(),view:camera as number[]});inheritedViews.current.set(id,{camera:camera as number[]});}
    pendingAdvancedProject.current=restored.readAdvanced;pendingAdvancedProjectChanged.current=false;setAdvancedRestoreRevision(value=>value+1);
    if(restored.issues.length)setError(`项目已载入；${restored.issues.length}项数据暂不可用，原引用保留。`);
   }catch(error){if(!fileSourcesInstalled)await Promise.allSettled(Object.values(decodedFileSources).map(document=>disposePostprocessFileDocument(document,async id=>{await desktop?.commandOrbitals?.(id,{operation:'close'});})));throw error;}
   finally{flushSync(()=>{restoringProject.current=false;setRestoringDocumentViews(false);});}
  }});
 const projectClose=useRef(project.prepareClose);projectClose.current=project.prepareClose;
 projectActivity.current.busy=project.busy;
 const projectInfo=useRef(project);projectInfo.current=project;
 const projectRunning=useRef(false);projectRunning.current=twoDBusy||state.documents.some(entry=>['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase))||Boolean(advancedController?.getSnapshot().activeNative)||Boolean(advancedController?.getSnapshot().queue.length);
 useEffect(()=>{
  if(!hostBridge)return;
  for(const [id,placement]of Object.entries(pendingProjectDetaches.current)){
   if(restoringProjectDetaches.current.has(id))continue;
   const entry=registry.getSnapshot().documents.find(value=>value.id===id);
   if(!entry){delete pendingProjectDetaches.current[id];setProjectDetachRevision(value=>value+1);continue;}
   const adapter=ensureOwnerAdapter(registry.document(id));if(!adapter)continue;
   restoringProjectDetaches.current.add(id);
   void adapter.ready.then(()=>adapter.flush()).then(()=>hostBridge.detachWorkspaceDocument!({...authFor(id),placement}))
    .catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))
    .finally(()=>{restoringProjectDetaches.current.delete(id);delete pendingProjectDetaches.current[id];setProjectDetachRevision(value=>value+1);});
  }
 },[hostBridge,registry,documentSignature,state.version,projectDetachRevision]);
 useEffect(()=>{if(restoringDocumentViews||state.module!=='advanced'||!advancedController||!pendingAdvancedProject.current)return;void ensurePendingAdvancedProject().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},[state.module,advancedController,restoringDocumentViews,advancedRestoreRevision]);
 const [deleteGroup,setDeleteGroup]=useState<string|null>(null),[deletingGroup,setDeletingGroup]=useState(false);
 async function confirmDeleteGroup(){
  if(!deleteGroup||deletingGroup)return;setDeletingGroup(true);
  try{const root=registry.getSnapshot().documents.find(entry=>entry.conformerGroup?.taskId===deleteGroup||entry.trajectory?.identity.taskId===deleteGroup);
   if(!root)throw Error('构象组文档已变化，请重新选择。');
   const impact=await buildDiscardImpact(root.id,true);await executeDiscard(impact);
   if(!registry.getSnapshot().documents.some(entry=>impact.registryPlan.documentIds.includes(entry.id)))setDeleteGroup(null);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setDeletingGroup(false);}
 }
 const settingsEntry=state.documents.find(entry=>entry.id===displayedDocumentId);
 const settingsModel=settingsEntry?(analysisCanvases[settingsEntry.id]?.document??settingsEntry.store.getSnapshot()):null;
 const citationIdentity=()=>{const pp=advancedPorts.current.postprocess,files=pp.captureFileDocuments();return JSON.stringify([projectIdentityEpoch.current,registry.getSnapshot().documents.map(entry=>[entry.id,entry.epoch,entry.sourceEpoch,entry.store.getSnapshot().revision,entry.store.getSnapshot().analysisBindingId]),pp.fileOwnerId,Object.values(files).map(value=>postprocessFileDocumentVersion(value)),scientificFileCitationIdentity(files),getAnalysisProjectRevision(),retainedCitationAnalysisInstances(projectUi.capture()),readAdvanced(),citationStateRef.current.inputReceipts.map(f=>[f.id,f.purpose])]);};
 citationOpenAction.current=async documentId=>{
  const documents=registry.getSnapshot().documents,pp=advancedPorts.current.postprocess,fileDocuments=pp.captureFileDocuments(),ownerIds=retainedCitationOwnerIds(documents,fileDocuments);
  const identity=citationIdentity();
  if(documentId&&!ownerIds.includes(documentId))throw new Error('独立文档的owner已关闭，未打开文献导出。');
  const analysis=await captureAnalysisCitationSnapshots();
  if(documents.some(entry=>!registry.getSnapshot().documents.some(current=>current.id===entry.id&&current.epoch===entry.epoch)))throw new Error('项目文档已变化，请重新打开文献导出。');
  const advanced=pendingAdvancedProject.current?await pendingAdvancedProject.current():advancedController?.getSnapshot();
  const generated=Object.values(postprocess.generated).filter(row=>documents.some(doc=>doc.id===row.ownerId&&doc.store.getSnapshot().analysisBindingId===row.bindingId));
  const facts=collectWorkspaceCitationFacts({documents,fileDocuments,postprocessDocuments:postprocess.documents,additionalPostprocessDocuments:generated.map(row=>({documentId:row.ownerId,document:row.document})),inputReceipts:citationStateRef.current.inputReceipts,analysis,analysisInstances:retainedCitationAnalysisInstances(projectUi.capture(),Object.fromEntries(generated.map(row=>[row.document.id,row.ownerId]))),advanced});
  const twoDFacts=await readCommittedTwoDCitationFacts(documents.map(entry=>entry.id));facts.push(...twoDFacts.facts);
  if(identity!==citationIdentity())throw new Error('项目文档已变化，请重新打开文献导出。');
  setCitationOpen({documentId:documentId??(registry.getSnapshot().module==='analysis'?pp.fileOwnerId:null)??displayedDocumentId??undefined,fixed:Boolean(documentId),facts,warnings:[...analysis.flatMap(entry=>entry.warning?[entry.warning]:[]),...twoDFacts.warnings],identity});
 };
 nativeFileAction.current=async request=>{
  const id=request.documentId??displayedDocumentId;
  if(!id||!registry.getSnapshot().documents.some(entry=>entry.id===id))throw new Error('当前没有可用的文件操作目标。');
  activateDocument(id);
  const controller=viewportControllers.current.get(id);
  if(!controller)throw new Error('当前模型尚未就绪，请稍后重试。');
  await controller.dispatch({type:'file-action',action:request.action});
 };
 return <><Suspense fallback={twoDVisible?<div role="status" className="workspace-global-error">正在载入二维编辑器…</div>:null}>{twoDFile&&<TwoDImportWorkspace key={twoDFile.id} file={twoDFile} visible={twoDVisible} captureGuard={captureTwoDGuard} onCommit={commitTwoD} onClose={closeTwoD} onImportFiles={openTwoDFiles} onRuntime={setTwoDRuntime} onBusyChange={setTwoDBusy}/>}</Suspense><ProjectUiRestoreBoundary restoring={restoringDocumentViews}>{()=> <>{citationOpen&&<ProjectUiScope store={citationUiStore} scope={['citations']}><CitationDialog assertCurrent={()=>{if(citationOpen.identity!==citationIdentity())throw new Error("项目文档已变化，请关闭后重新打开文献导出。");}} facts={citationOpen.facts} retainedDocumentIds={retainedCitationOwnerIds(state.documents,postprocess.fileDocuments)} warnings={citationOpen.warnings} registry={citationRegistryData as CitationRegistry} version={applicationVersion.displayVersion} documentId={citationOpen.documentId} documentLabel={registry.getSnapshot().documents.find(entry=>entry.id===citationOpen.documentId)?.label??postprocess.fileDocuments[citationOpen.documentId??'']?.output.source.identity.name} fixedDocument={citationOpen.fixed} decisions={citationState.decisions} onDecisions={decisions=>setCitationState(previous=>({...previous,decisions}))} ownerDocument={tabs.current?.ownerDocument} onClose={()=>setCitationOpen(null)}/></ProjectUiScope>}<WorkspaceRenderBoundary onSave={asNew=>project.save(asNew)} status={project.status} projectName={project.project?.indexPath}><div ref={rootElement} className="sciyue-workspace-v18" data-testid="workspace-v18" data-project-path={project.project?.indexPath??''} data-project-busy={project.busy} data-module={taskWorkspace.opened?'tasks':state.module} data-model-left-panel={state.module==='modeling'&&leftToolOpen} data-shared-models={sharedLayout} data-source-picking={Boolean(sourcePick)} data-link-selecting={linkedControls.selecting}
  onScrollCapture={event=>{const node=event.target as HTMLElement;if(node.dataset.pageScroll)pageScroll.current.set(scrollPageKey+':'+node.dataset.pageScroll,{top:node.scrollTop,left:node.scrollLeft});}}
  onDragOverCapture={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}}
  onDropCapture={event=>{if(taskWorkspace.opened){event.preventDefault();return;}if(event.target instanceof Element&&event.target.closest('[data-testid="model-2d-window"]'))return;if(event.dataTransfer.files.length){event.preventDefault();event.stopPropagation();void importFiles(Array.from(event.dataTransfer.files));}}}>
  <nav className="workspace-module-rail" aria-label="功能模块"><button type="button" className="workspace-symbol workspace-global-settings" aria-label="全局设置" title="全局设置" onClick={()=>setEnvironmentOpen(true)}>ES</button>{modules.map(([id,label,Icon])=><button key={id} title={label} aria-label={label} aria-pressed={!taskWorkspace.opened&&state.module===id} onClick={()=>navigateModule(id)}><Icon size={20}/><span>{label}</span></button>)}<button type="button" title="任务中心" aria-label="任务中心" aria-pressed={taskWorkspace.opened} onClick={()=>{closeTwoD();taskWorkspace.open();}}><ListChecks size={20}/><span>任务中心</span></button><small>{applicationVersion.label}</small></nav>
  {taskWorkspace.opened&&<div className="workspace-document-area" data-testid="external-task-workspace"><div className="workspace-tabs-row"><div className="workspace-layout-actions" style={{marginLeft:'auto'}}><button type="button" className="button-primary" onClick={()=>void citationOpenAction.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}>导出文献</button></div></div>{taskWorkspace.center}</div>}
  <div className="workspace-document-area" style={{'--shared-input-width':workbench.layout.paneSizes.leftWidth+'%',...(taskWorkspace.opened?{display:'none'}:{})} as CSSProperties}>
   <div className="workspace-tabs-row">
    <div ref={tabs} className="workspace-document-tabs" role="tablist" aria-label="模型文档">{tabDocuments.map((entry,index)=>{const snapshot=entry.store.getSnapshot(),groupId=entry.conformerGroup?.taskId,group=groupId?conformerGroups[groupId]??{label:'搜索-'+entry.label,collapsed:false}:undefined;
     const first=Boolean(groupId&&tabDocuments[index-1]?.conformerGroup?.taskId!==groupId),count=groupId?tabDocuments.filter(value=>value.conformerGroup?.taskId===groupId).length:0;
     const latestStatus=groupId?advancedGroupStatuses.get(groupId):undefined;
     const groupStatus=latestStatus==='running'?'运行中':latestStatus==='queued'?'排队中':latestStatus==='stopping'?'正在停止':latestStatus==='failed'?'失败':latestStatus==='checkpoint'?'待继续':'';
     const groupIndex=groupId?Math.max(0,Object.keys(conformerGroups).indexOf(groupId)):0,groupStyle=groupId?{'--task-group-hue':String([158,207,40,278,338][groupIndex%5])} as CSSProperties:undefined;
     const last=Boolean(groupId&&tabDocuments[index+1]?.conformerGroup?.taskId!==groupId);
     return <Fragment key={entry.id}>{first&&groupId&&group&&<span className="workspace-tab-group" data-task-id={groupId} data-collapsed={group.collapsed} data-active={tabDocuments.some(value=>value.conformerGroup?.taskId===groupId&&value.id===displayedDocumentId)} style={groupStyle}>
      {renamingGroup===groupId?<input autoFocus aria-label="任务组名称" defaultValue={group.label} onBlur={event=>{const label=event.currentTarget.value.trim();if(label)setConformerGroups(previous=>({...previous,[groupId]:{...group,label}}));setRenamingGroup(null);}} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape')setRenamingGroup(null);}}/>:<button type="button" aria-expanded={!group.collapsed} aria-label={`${group.collapsed?'展开':'收起'} ${group.label}`} title={`${group.label} · ${count} 个页面${groupStatus?' · '+groupStatus:''}；双击重命名任务组`} onDoubleClick={()=>setRenamingGroup(groupId)} onClick={()=>setConformerGroups(previous=>({...previous,[groupId]:{...group,collapsed:!group.collapsed}}))}>{group.collapsed?'▸':'▾'} {group.label}</button>}
      <button type="button" aria-label={'删除构象搜索组 '+group.label} title={groupStatus?'请先停止任务后删除组':'删除整个组'} disabled={Boolean(groupStatus&&['运行中','排队中','正在停止'].includes(groupStatus))} onClick={event=>{event.stopPropagation();setDeleteGroup(groupId);}}>×</button>
     </span>}<WorkspaceTab className={groupId?'workspace-tab-group-member':''} containerProps={{'data-tab-document-id':entry.id,...groupId?{'data-task-id':groupId,'data-group-last':last}:{},style:{...groupStyle,...(group?.collapsed?{display:'none'}:{})}}} active={entry.id===displayedDocumentId} label={entry.conformerGroup?.role==='initial'?'初始结构':entry.label} dirty={snapshot.draft.dirty} onActivate={()=>sourcePick?selectTaskSource(entry.id):linkedControls.selecting?linkedControls.toggleMember(entry.id):activateDocument(entry.id)}
     actions={<button aria-label={'关闭文档 '+entry.label} title="关闭当前文档" onClick={()=>requestClose(entry.id)}><X size={12}/></button>}
     buttonProps={{'aria-controls':'doc-'+entry.id,...{'data-link-selected':linkedControls.selected.includes(entry.id)},
      onPointerDown:event=>{if(event.button!==0||sourcePick||linkedControls.selecting)return;tabDrag.current={id:entry.id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,moved:false};event.currentTarget.setPointerCapture(event.pointerId);},
      onPointerMove:event=>{const drag=tabDrag.current;if(drag?.pointerId===event.pointerId&&workspaceTabDragMoved(drag.x,drag.y,event.clientX,event.clientY))drag.moved=true;},
      onPointerCancel:()=>{tabDrag.current=null;},
      onLostPointerCapture:()=>{tabDrag.current=null;},
      onKeyDown:event=>{const drag=tabDrag.current;if(event.key==='Escape'&&drag){tabDrag.current=null;if(event.currentTarget.hasPointerCapture(drag.pointerId))event.currentTarget.releasePointerCapture(drag.pointerId);event.preventDefault();event.stopPropagation();}},
      onPointerUp:event=>{const drag=tabDrag.current;tabDrag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(!drag?.moved)return;const bounds=tabs.current?.getBoundingClientRect();if(!bounds)return;
       const insideTarget=workspaceTabTargetContains({x:bounds.left-10,y:bounds.top-10,width:bounds.width+20,height:bounds.height+20},event.clientX,event.clientY);
       const intent=resolveWorkspaceTabDropIntent({moved:drag.moved,source:drag.id,expectedSource:entry.id,detached:false,insideTarget});
       if(intent==='detach'){void detachDocument(drag.id,event.screenX,event.screenY);return;}if(intent!=='reorder')return;
       const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-tab-document-id]')?.dataset.tabDocumentId;
       if(target&&target!==drag.id){const ids=documents.map(value=>value.id),from=ids.indexOf(drag.id),to=ids.indexOf(target);ids.splice(from,1);ids.splice(to,0,drag.id);setOrder(ids);}
      }}}/></Fragment>;})}<button type="button" className="workspace-tab-new" aria-label="新建模型文档" title="新建模型" onClick={createDocument}>＋</button></div>
    <div className="workspace-layout-actions"><button type="button" className="button-primary" onClick={()=>void citationOpenAction.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}>导出文献</button>{sourceDiagnostics.length>0&&<button aria-label="来源诊断" title="查看文件级来源诊断" onClick={()=>setDiagnosticsOpen(true)}>来源诊断 ({sourceDiagnostics.length})</button>}{portableToolsAvailable&&<button aria-label="运行数据" title="运行数据" onClick={()=>setRuntimeDataOpen(true)}>⋯</button>}</div>
   </div>
   {active?.result&&!analysisLayout&&<div className="workspace-result-actions"><button onClick={createDocument}>新建</button><button disabled={reading} onClick={()=>fileInput.current?.click()}>导入</button></div>}
   {(reading||importCloseFailed||postprocess.readState!=='idle')&&<div role="status" className="workspace-reading" data-testid="workspace-source-reading" data-read-state={importCloseFailed?'cancelling':postprocess.readState==='idle'?'reading':postprocess.readState}>
    {importCloseFailed?'读取资源仍待关闭':postprocess.readState==='cancelling'?'正在取消读取':postprocess.readState==='reading'?'读取后处理来源中':'读取中'}
    <progress aria-label="来源读取进度" max={100} value={postprocess.readState!=='idle'||readProgress===null?undefined:readProgress}/>
    {postprocess.readState==='idle'&&readProgress!==null?`${readProgress}%`:'预计剩余：估算中'}
    <button disabled={readCancelPending} onClick={()=>{importController.current?.abort();setReadCancelPending(true);void Promise.allSettled([postprocess.readState!=='idle'?postprocess.cancelRead():Promise.resolve(),importResourceClosures.current.retry()]).then(outcomes=>{const failed=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failed.length){setImportCloseFailed(importResourceClosures.current.failedCount>0);setError(failed.map(value=>value.reason instanceof Error?value.reason.message:String(value.reason)).join('；'));return;}setImportCloseFailed(false);if(importReadScope.current?.settled&&!importResourceClosures.current.pendingCount){setReading(false);setReadProgress(null);importController.current=null;}}).finally(()=>setReadCancelPending(false));}}>取消读取</button>
   </div>}
   {sourcePick&&<div role="status" className="workspace-source-pick-banner">点击模型框或标签，选择：{sourcePick.request.label}<button onClick={()=>setSourcePick(null)}>取消选择</button></div>}
   {error&&<div className="workspace-global-error" role="alert">{error}<button aria-label="关闭工作空间提示" onClick={()=>setError('')}><X size={13}/></button></div>}
   {Boolean(pendingDiscards.current.size)&&!closingPending&&<div className="workspace-global-error" role="status" data-revision={discardCleanupRevision}><span>{[...pendingDiscards.current.values()].some(row=>row.execution.status().phase==='commit-failed')?'丢弃提交未全部完成，已保留实际资源归属。':'内容已撤下，部分资源仍待收尾。'} {[...pendingDiscards.current.values()].map(row=>row.label).join('、')}</span><button disabled={retryingDiscard} onClick={()=>void retryDiscardCleanup()}>{retryingDiscard?'正在重试释放…':'重试释放'}</button></div>}
   <WorkspaceColumns sizes={analysisLayout?analysisColumns.sizes:undefined} className="workspace-main-content" style={{'--shared-tool-width':rightWidth+'px','--shared-input-width':workbench.layout.paneSizes.leftWidth+'%',gridTemplateColumns:advancedLayout&&!advancedSection?'minmax(250px,var(--shared-input-width,27%)) 6px minmax(0,1fr)':undefined} as CSSProperties}>
    <aside data-page-scroll={advancedSection==='conformer'?undefined:'advanced-configuration'} className="workspace-advanced-panel workspace-workflow-panel desktop-mode" hidden={!advancedLayout} aria-label="高级任务配置"><AdvancedWorkflowNavigation activeSection={advancedSection} samplingOperation={conformerSamplingChoice} onSamplingOperation={setConformerSamplingChoice} onSectionChange={section=>{advancedSectionRef.current=section;setAdvancedSection(section);setAdvancedCapture(undefined);setError('');}}/><div className={xtbAnalysisLayout?'workflow-panel-content postprocess-source-panel-host':'workflow-panel-content'} hidden={!advancedSection} ref={setAdvancedConfigurationHost}/></aside>
    <aside className="workspace-model-left-panel" hidden={state.module!=='modeling'||!leftToolOpen} aria-label="建模参数">{state.module==='modeling'&&<SharedSurface channel={leftToolSurface}/>}</aside>
    <aside className="workspace-advanced-modeling-panel workspace-workflow-panel desktop-mode" hidden={!advancedModelingLayout} aria-label="高级建模设置">
     {active?.result?<p className="postprocess-note">请先从结果中取帧建模，再进行结构变换。</p>:<SharedSurface channel={leftToolSurface}/>}
    </aside>
    {analysisLayout&&<div className="workspace-analysis-panel workspace-workflow-panel desktop-mode"><WorkflowSessionBar label={`当前分析 · ${fileCurrent?.output.source.identity.name??sidebarResult?.label??currentStructureEntry?.label??'未加载'}`} actions={Object.keys(postprocess.fileDocuments).length?<label className="trajectory-stage-choice">来源<select aria-label="后处理文件来源" value={postprocess.fileOwnerId??''} onChange={event=>{postprocess.selectFile(event.target.value||null);registry.invalidateActivation();}}><option value="">当前模型 / 已有分析</option>{Object.values(postprocess.fileDocuments).map(value=><option key={value.id} value={value.id}>{value.output.source.identity.name}</option>)}</select></label>:undefined}/>{fileCurrent&&<div className="postprocess-actions workflow-session-actions ui-control-surface">{currentFileSidebarCollapsed&&<button type="button" onClick={()=>setFileSidebarCollapsed(previous=>({...previous,[fileCurrent.id]:false}))}>展开后处理侧栏</button>}<button type="button" aria-label="关闭后处理文件来源" onClick={()=>{void postprocess.closeFile(fileCurrent.id).then(issues=>{if(issues.length)setError(issues.join('；'));});}}>关闭来源</button></div>}<div data-testid="postprocess-sidebar-presentation" hidden={currentFileSidebarCollapsed}><PostprocessSidebar engine={postprocess.engine} task={postprocess.task} stage={postprocess.stage} onStage={postprocess.setStage} onEngine={postprocess.selectEngine} onTask={postprocess.selectTask}
      slots={postprocessDocumentFileSlots(fileCurrent??sidebarDocument)} fileDocument={fileCurrent} onFileJob={fileCurrent?jobId=>void postprocess.selectFileJob(fileCurrent.id,jobId):undefined}
      result={sidebarFrameReady?sidebarResult??null:null} currentIndex={sidebarCanvas?.frameIndex??0} busy={postprocess.busy} sourceDifferences={sidebarDocument?postprocessDifferences(sidebarDocument):[]}
      message={fileCurrent?postprocess.notice:sidebarResult?.scientific?.readLimits?.observations?.omitted?`部分科学数据达到读取预算；已保留 ${sidebarResult.frames.length} 个完整帧。`:sidebarResult?.kind==='optimization'&&sidebarResult.status!=='completed'?`优化${sidebarResult.status==='incomplete'?'未完成':sidebarResult.status==='failed'?'异常结束':'状态未知'} · 已读取 ${sidebarResult.frames.length} 帧`:postprocess.notice|| (sidebarDocument?`当前分析：${sidebarResult?.label??sidebarDocument.result.label}`:undefined)}
      onFiles={(_role,files,replace,slotKey,sourceId)=>{if(isExcitationSlot(slotKey))void postprocess.readExcitationFiles(files,slotKey,postprocess.ownerId);else void postprocess.read(files,fileCurrent?postprocess.fileOwnerId:sidebarDocument?postprocess.ownerId:undefined,postprocess.engine,replace?'replace':'smart',undefined,{slotKey,sourceId});}} onRemove={(role,slotKey,sourceId)=>void postprocess.remove(role,slotKey,sourceId)}
      onClose={fileCurrent?()=>setFileSidebarCollapsed(previous=>({...previous,[fileCurrent.id]:true})):undefined}
      onExtract={sidebarFrameReady?()=>{const structure=extractCurrentAnalysis();if(structure)extractFrame(structure);}:undefined}
      onPrepareInput={sidebarFrameReady?()=>{const structure=extractCurrentAnalysis();if(structure){extractFrame(structure);requestNewInputTask();}}:undefined}
      onOpenLegacy={()=>fileInput.current?.click()}/></div>{sidebarDocument&&postprocess.ownerId&&managedTaskControls(postprocess.ownerId,sidebarDocument)}</div>}
    <aside className="workspace-input-panel workspace-workflow-panel desktop-mode" hidden={!sharedLayout||state.module!=='input'} aria-label="输入文件任务与设置"><WorkflowSessionBar label={`当前任务 · ${documents.find(entry=>entry.id===inputOwnerId)?.label??'未创建'}`} actions={borrowedBatch?<button type="button" onClick={()=>setCancelBatchConfirm(true)}>取消批量输入</button>:<button type="button" onClick={requestNewInputTask}>新建输入任务</button>}/>{documents.filter(entry=>!entry.result).map(entry=><div key={entry.id} ref={inputHostRef(entry.id)} className="workflow-panel-content" hidden={entry.id!==inputOwnerId} data-testid="workspace-input-host" data-document-id={entry.id} data-input-task-id={entry.id===inputOwnerId?inputTask?.id:undefined}/>)}</aside>
    {analysisLayout&&<WorkspaceColumnDivider side="left" sizes={analysisColumns.sizes} onChange={analysisColumns.update}/>}
    <div className="workspace-input-divider" hidden={analysisLayout||!sharedLayout||(state.module!=='input'&&!analysisLayout&&!advancedLayout&&!advancedModelingLayout&&!(state.module==='modeling'&&leftToolOpen))} role="separator" aria-label="调整参数区宽度" aria-orientation="vertical" tabIndex={0}
      onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))return;const bounds=event.currentTarget.parentElement!.getBoundingClientRect(),minimum=advancedModelingLayout?parseFloat(getComputedStyle(rootElement.current!).getPropertyValue('--advanced-panel-min'))||250:250;workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,leftWidth:clampWorkbenchPaneSize('leftWidth',Math.max(minimum,event.clientX-bounds.left)/bounds.width*100)}}));}}
      onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onDoubleClick={()=>workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,leftWidth:27}}))}/>
    <div ref={setToolbarHost} className="workspace-common-toolbar" data-testid="workspace-common-toolbar" hidden={!sharedLayout}>{!fileCurrent&&<SharedSurface channel={toolbarSurface}/>}</div>
    <div className="workspace-document-surfaces" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();void importFiles(Array.from(event.dataTransfer.files));}}>
     <div style={{display:fileCurrent?'none':'contents'}}>
     <ModelDocumentDeck activeId={displayedDocumentId??''} isDocumentInteractionOwner={id=>Boolean(sourcePickLive.current||selectingMembers.current)||id===displayedDocumentId} mode={analysisLayout||advancedLayout||advancedModelingLayout?'single':sharedLayout?deckMode:'single'} onActivate={activateDocument} onReorder={setOrder} arrangeRequest={arrangeRequest} onLegendHostChange={setLegendHostId}
      documents={documents.map(entry=>({id:entry.id,label:entry.label,docked:!retiredConformerReader(entry)&&!detached[entry.id]&&(sharedLayout?(!entry.result||analysisLayout&&Boolean(postprocess.documents[entry.id])||advancedLayout&&entry.id===activeId):entry.id===activeId),content:<ProjectUiScope store={projectUi} scope={['document',entry.id]}><ProjectNativeDetailsBoundary><div id={'doc-'+entry.id} className="workspace-document-surface" data-document-id={entry.id} data-linked-atoms={linkedControls.linked?.documentIds.includes(entry.id)??false} data-link-status={linkedControls.linked?.documentIds.includes(entry.id)?linkedControls.linked.status:undefined} data-link-selected={linkedControls.selected.includes(entry.id)}
       onPointerDownCapture={event=>{if(!(event.target instanceof Node)||!event.currentTarget.contains(event.target))return;if(sourcePick||linkedControls.selecting){event.preventDefault();event.stopPropagation();if(sourcePick)selectTaskSource(entry.id);else linkedControls.toggleMember(entry.id);}}}>
       {borrowedBatch?.documentId===entry.id&&<span className="workspace-batch-input-notice" data-testid="workspace-batch-input-notice" style={{position:'absolute',left:'50%',top:56,transform:'translateX(-50%)',zIndex:3,pointerEvents:'none',color:'#617168',fontSize:13,whiteSpace:'nowrap'}}>正在批量产生输入文件</span>}
       {state.module==='input'&&(sourceRoles[inputOwnerId??'']??[]).filter(role=>role.documentId===entry.id).map(role=><span key={role.label} className="workspace-task-role" data-testid="workspace-task-role" data-input-task-id={inputTask?.id} data-source-document-id={entry.id} data-source-role={role.label.includes('反应物')?'reactant':role.label.includes('产物')?'product':'tsGuess'}>{role.label}</span>)}
       {entry.result?<><div className="workspace-legacy-trajectory" hidden={advancedLayout}><TrajectoryWorkspace onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} result={entry.result} onScientificFrame={value=>trajectoryFrames.current.set(entry.id,value)} active={!fileCurrent&&entry.id===activeId&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&state.module!=='input'&&!advancedLayout} displaySettings={displaySettings} onDisplaySettingsChange={changeDisplaySettings} onExtract={extractFrame} onPrepareIrc={entry.result.engine==='gaussian'||entry.result.engine==='orca'?structure=>prepareIrc(structure,entry.result!.engine as 'gaussian'|'orca'):undefined} onExport={exportWorkspaceResult} onError={setError}/></div>{advancedLayout&&renderDocument(surface(entry))}</>:<>{renderDocument(surface(entry))}{postprocess.documents[entry.id]&&<div hidden><PostprocessResultView onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} onActiveResult={activeResultFor(entry.id,postprocess.documents[entry.id])} document={postprocess.documents[entry.id]} modelDocument={entry.store.getSnapshot()} available={registry.analysisAvailable(entry.id)} onCanvas={canvasFor(entry.id)} active={!fileCurrent&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&(analysisLayout&&(entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId)||entry.id===xtbAnalysisOwnerId)} selected={!fileCurrent&&analysisLayout&&(entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId)||entry.id===xtbAnalysisOwnerId}
        toolHost={analysisToolHosts[entry.id]??null} onNewDocument={createDocument} onImportFiles={importFiles} display={displaySettings} onDisplay={changeDisplaySettings} onOpenPlot={openPlot} onExtract={extractFrame} onError={setError} onActivate={()=>{if(entry.id!==xtbAnalysisOwnerId){activateDocument(entry.id);registry.setModule('analysis');}}}/></div>}{entry.legacyResult&&ownedTrajectory(entry)}</>}
      </div></ProjectNativeDetailsBoundary></ProjectUiScope>}))}/></div>
     {Object.values(postprocess.fileDocuments).map(value=><div key={value.id} className="workspace-document-surface" hidden={!analysisLayout||fileCurrent?.id!==value.id} data-testid="scientific-file-workspace" data-file-document-id={value.id}><ProjectUiScope store={projectUi} scope={['scientific-file',value.id]}><ProjectNativeDetailsBoundary><ScientificFileResultView onCipLabelsUsed={cipUsageFor(value.id)} document={value} active={!ownerHidden&&!taskWorkspace.opened&&!closingPending&&analysisLayout&&fileCurrent?.id===value.id} selected={analysisLayout&&fileCurrent?.id===value.id} toolHost={analysisToolHosts[value.id]??null} toolbarHost={toolbarHost} display={displaySettings} onDisplay={changeDisplaySettings} onObservedFrame={fileFrameFor(value)} onFileJob={jobId=>void postprocess.selectFileJob(value.id,jobId)} onOpenFilePathPlot={openPlot} onNewDocument={createDocument} onImportFiles={importFiles} onOpenPlot={openPlot} onExtract={extractFrame} onError={setError} sharedShowAxes={sharedShowAxes} onSharedShowAxesChange={setSharedShowAxes} legendVisible legendExpanded={legendExpanded} onLegendExpandedChange={setLegendExpanded}/></ProjectNativeDetailsBoundary></ProjectUiScope></div>)}
     {state.module==='input'&&active?.result&&<div className="workspace-module-placeholder"><h2>从结果帧创建输入</h2><p>选定结果帧并“取帧建模”，即可使用该结构准备Gaussian或ORCA输入。</p><button onClick={()=>registry.setModule('modeling')}>返回轨迹</button></div>}
     <PostprocessPlotDeck snapshots={plots} active={analysisLayout||xtbAnalysisLayout} visibleFilePlotScope={analysisLayout&&fileCurrent?filePathPlotScope(fileCurrent):null} visibleResultId={xtbAnalysisLayout?(xtbAnalysisOwnerId?analysisCanvases[xtbAnalysisOwnerId]?.result?.id??null:activeId?xtbAnalysisCanvases[activeId]?.result?.id??null:null):sidebarResult?.id??null} onClose={id=>setPlots(previous=>previous.filter(value=>value.id!==id))}/>
    </div>
    {analysisLayout&&<WorkspaceColumnDivider side="right" sizes={analysisColumns.sizes} onChange={analysisColumns.update}/>}
    <div className="workspace-common-tool-divider" hidden={analysisLayout||!sharedLayout||advancedLayout&&!advancedSection} role="separator" aria-label="调整公共工具区宽度" aria-orientation="vertical" tabIndex={0}
     onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);}}
     onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))resizeTools(event.currentTarget.parentElement!.getBoundingClientRect().right-event.clientX);}}
     onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
     onDoubleClick={()=>resizeTools(DEFAULT_WORKBENCH_PANE_SIZES.rightWidth)}
     onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();resizeTools(event.key==='Home'?DEFAULT_WORKBENCH_PANE_SIZES.rightWidth:rightWidth+(event.key==='ArrowLeft'?10:-10));}}}/>
    <aside data-page-scroll="results" className="workspace-common-tools" hidden={!sharedLayout||advancedLayout&&!advancedSection} aria-label={xtbAnalysisLayout?'XTB2后处理分析':advancedLayout?'高级任务进度与结果':analysisLayout?'后处理显示工具区':'公共建模工具区'}>
     <div ref={setAdvancedResultHost} className="workspace-fill-host" data-testid="workspace-advanced-result-host" hidden={!advancedLayout||!advancedSection}/>
     {currentStructureEntry&&<CurrentStructureAnalysisEntry document={currentStructureEntry.store.getSnapshot()} selected={currentStructureSelected} onOpen={id=>{if(registry.stamp().documentId===id&&!ownerHidden&&!taskWorkspace.opened&&!closingPending)setStructureAnalysisSelected(previous=>({...previous,[id]:true}));}}/>}
     <div ref={setToolHost} className={currentStructureSelected?'analysis-workspace-host':undefined} data-testid="workspace-common-tool-host" hidden={advancedLayout||analysisLayout&&!currentStructureSelected}><SharedSurface channel={toolSurface}/></div>
     {Object.entries(postprocess.documents).map(([id,value])=><div key={id} ref={analysisHostRef(id)} hidden={(Boolean(fileCurrent)||!analysisLayout||id!==postprocess.ownerId)&&id!==xtbAnalysisOwnerId} data-testid="postprocess-tool-host" data-document-id={id}><p className="postprocess-note">分析来源：{(activeAnalysisResults[id]?.source===value?activeAnalysisResults[id]?.result:null)?.label??value.result.label}</p></div>)}
     {Object.values(postprocess.fileDocuments).map(value=><div key={value.id} ref={analysisHostRef(value.id)} hidden={!analysisLayout||fileCurrent?.id!==value.id} data-testid="scientific-file-tool-host" data-file-document-id={value.id}/>)}
     {documents.filter(entry=>entry.legacyResult).map(entry=><div key={'legacy-'+entry.id} ref={analysisHostRef(entry.id)} hidden={!analysisLayout||entry.id!==activeId} data-testid="postprocess-tool-host" data-document-id={entry.id}/>)}
     {analysisLayout&&!fileCurrent&&!postprocess.current&&!currentStructureEntry&&!active?.legacyResult&&<PostprocessDisplayPanel key={activeId??'empty'} result={null} currentIndex={0} atomicDisplay={{property:null,color:false,labels:false}} onAtomicDisplay={()=>{}} dipoleVisible={false} dipoleAvailable={false} onDipoleVisible={()=>{}} onOpenPlot={openPlot}/>}
    </aside>
   </WorkspaceColumns>
  </div><input hidden ref={fileInput} type="file" multiple aria-label="导入为新模型文档" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(files.length)void importFiles(files);}}/>

  {legendTarget&&sharedLayout&&createPortal(<SharedSurface channel={legendSurface}/>,legendTarget)}
  {linkedControls.dialog}
  {advancedController&&!pendingAdvancedProject.current&&<AdvancedWorkspace controller={advancedController} contextKey={activeConformerGroup?.taskId??activeId} contextTaskId={activeConformerGroup?.taskId} onTaskCreated={bindConformerTask} onPrepareNewTaskSource={writableConformerSource} onElectronicStateChange={changeSourceElectronicState} onConformerElectronicStateChange={changeConformerElectronicState} sourceElectronicState={active?{documentId:active.id,charge:active.store.getSnapshot().draft.structure.charge??0,multiplicity:active.store.getSnapshot().draft.structure.multiplicity??1}:undefined} onProtectionChange={changeSourceProtection} onCommitConformerCoreChange={commitConformerCoreChange} onReadConformerInitialSource={captureConformerInitial} sourceProtectionAtomIds={activeConformerGroup?advancedController.getSnapshot().tasks.find(task=>task.id===activeConformerGroup.taskId)?.mixedSampling?.draft.protectedAtomIds:active?.store.getSnapshot().sharedConstraints?.frozenAtomIds??[]} active={advancedLayout&&!!advancedSection&&advancedSection!=='xtb2'&&!ownerHidden&&!taskWorkspace.opened&&!closingPending} activeSection={advancedSection} onSectionChange={setAdvancedSection} navigationInShell samplingOperation={conformerSamplingChoice} onSamplingOperationChange={setConformerSamplingChoice} onOpenConformerCollection={openConformerCollection} onConformerFrameOrder={conformerFrameOrder} onConformerViewControls={publishConformerViewControls} activeConformerFrame={active?.trajectory?{taskId:active.trajectory.identity.taskId,collectionId:active.trajectory.identity.collectionId,frameId:active.trajectory.currentFrameId}:undefined} onSphereDraft={setSamplingSphereDraft} sphereRadiusChange={samplingSphereRadiusChange} computeResources={computeResources} displayTargetId={activeId} displayedSource={advancedDisplayedSource} onTaskHighlights={publishTaskHighlights} onCaptureProjection={setAdvancedCapture} onDisplayLayers={publishAdvancedLayers} sourceCollectionInfo={source=>{const current=advancedSourceResult(source);return current?{id:current.result.id,count:current.result.frames.length,label:current.result.label}:undefined;}} onReadSourceCollection={readAdvancedSourceCollection} onCaptureInputTemplate={()=>{const task=registry.getSnapshot().inputTask;return task?inputControllers.current.get(task.documentId)?.getAdvancedInputTemplate?.():undefined;}} outputBridge={advancedOutputBridge} configurationHost={advancedLayout&&advancedSection&&advancedSection!=='xtb2'?advancedConfigurationHost:null} resultHost={advancedLayout&&advancedSection&&advancedSection!=='xtb2'?advancedResultHost:null} onCaptureSource={captureCurrentAdvancedSource} onCaptureInitialSource={()=>captureCurrentAdvancedSource(false)}
   onConformerInitialFrame={openConformerInitialFrame} activeConformerInitial={activeConformerGroup?.role==='initial'&&activeConformerGroup.initialId?{taskId:activeConformerGroup.taskId,initialId:activeConformerGroup.initialId}:undefined}
   onObserve={source=>observeAdvancedSource(registry.stamp().documentId,source)}
   onExtract={extractAdvancedFrame} onPrepareInput={prepareAdvancedInput} onPrepareBatchInput={prepareBatchInput}
   onOpenAnalysis={(taskId,runId)=>{const id=advancedAnalysisDocuments.current.get(`${taskId}:${runId}`),generated=id?postprocess.generated[id]:undefined;if(generated){activateDocument(generated.ownerId);registry.setModule('advanced');setAdvancedSection('xtb2');}else if(id){activateDocument(id);registry.setModule('analysis');}else setError('该运行尚未接入可用后处理来源。');}} onError={setError}/>}
  {advancedController&&<XtbAnalysisWorkspace controller={advancedController} active={xtbAnalysisLayout&&!ownerHidden&&!taskWorkspace.opened&&!closingPending} displayTargetId={activeId} configurationHost={xtbAnalysisLayout?advancedConfigurationHost:null} resultHost={xtbAnalysisLayout?advancedResultHost:null} computeResources={computeResources} resourceError={computeResourceState.error} analysisBindings={advancedAnalysisBindings} documents={Object.fromEntries(Object.entries(postprocess.generated).map(([key,row])=>[key,row.document]))} modelDocumentFor={id=>registry.getSnapshot().documents.find(entry=>entry.id===id)?.store.getSnapshot()} isAnalysisAvailable={xtbAnalysisSourceAvailable} display={displaySettings} onDisplay={changeDisplaySettings} onCaptureSource={()=>captureCurrentAdvancedSource(true)} onCaptureElectronicSource={captureCurrentElectronicSource} electronicSourceContext={xtbLiveElectronicContext} electronicDrafts={xtbElectronicDrafts} onElectronicDraftChange={changeXtbElectronicDraft} prepareElectronicSource={prepareXtbElectronicSource} taskSelections={xtbTaskSelections} onTaskSelectionChange={changeXtbTaskSelection} methodDrafts={xtbMethodDrafts} onMethodDraftChange={changeXtbMethodDraft} assertTargetCurrent={assertXtbTargetCurrent} onObserve={source=>{if(!activeId)return;assertXtbTargetCurrent(activeId);observeAdvancedSource(activeId,source);}} onCanvas={publishXtbCanvas} onAnalysisSelection={publishXtbAnalysisSelection} renderManagedTaskControls={({documentId,document,running})=>managedTaskControls(documentId,document,running)} onOpenPlot={openPlot} onExtract={extractFrame} onPrepareInput={structure=>{extractFrame(structure);requestNewInputTask();}} onError={setError}/>}
  {postprocess.dialog}
  {diagnosticsOpen&&sourceDiagnostics.length>0&&<SourceDiagnostics items={sourceDiagnostics} onClose={()=>setDiagnosticsOpen(false)} onRemove={removeSourceDiagnostic}/>}
  {pendingSourceCopy&&<DialogShell aria-label="在新标签页继续" className="modal workspace-scientific-edit-choice" backdropClassName="modal-backdrop" onCancel={()=>pendingSourceCopy.resolve(false)}><h2>在新标签页继续</h2><p>{pendingSourceCopy.purpose==='file-import'?'在新标签页载入文件，原构象帧保留。':pendingSourceCopy.purpose==='xtb-electronic-state'?'当前计算来源和旧波函数将保留原始电子态。复制当前完整帧，在新标签页设置本次单点。':<>当前帧属于构象搜索，原始帧将保留。<br/>将复制当前帧，在新标签页继续本次操作。</>}</p><div className="modal-buttons"><button onClick={()=>pendingSourceCopy.resolve(false)}>取消</button><button className="button-primary" onClick={()=>pendingSourceCopy.resolve(true)}>{pendingSourceCopy.purpose==='file-import'?'在新标签页载入文件':'在新标签页继续'}</button></div></DialogShell>}
  {pendingEdit&&!detachedPlacement.current[pendingEdit.request.documentId]&&<DialogShell aria-label={protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':pendingConformerInitialEdit?'修改构象初始结构':'修改来源结构'} className="modal workspace-scientific-edit-choice" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} initialFocus={()=>tabs.current?.ownerDocument.querySelector<HTMLElement>('[data-scientific-edit-copy]')??null} onCancel={()=>{if(!editChoiceBusy)void resolveScientificEdit('cancel');}}><h2>{protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':pendingConformerInitialEdit?'修改构象初始结构':'修改来源结构'}</h2><p>{protectedConformerSource(pendingEdit.request.documentId)?'当前帧属于构象搜索，原始帧将保留。将复制当前帧，在新标签页继续本次操作。':pendingConformerInitialEdit?'已有采样或优化设置及结果将保留原来源；修改后须重新确认电荷与自旋多重度，确认时采用当前帧。增删原子或改变元素后须建立新搜索。确认后继续本次修改？':'此修改会使当前结构的后处理结果暂不可用。撤销相关修改后可恢复。'}</p><div className="modal-buttons"><button data-scientific-edit-copy className="button-primary" disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('copy')}>{protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':'在新标签页建模'}</button>{!protectedConformerSource(pendingEdit.request.documentId)&&<button disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('current')}>{pendingConformerInitialEdit?'确认修改':'在当前标签页建模'}</button>}<button disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('cancel')}>取消</button></div></DialogShell>}
  {structureLibraryOpen&&<StructureLibrary display={displaySettings} onClose={()=>{libraryLoadController.current?.abort();setStructureLibraryOpen(false);}} onLoad={loadLibraryStructure}/>}
  {resultImportRequest&&<DialogShell aria-label="识别到计算结果" className="modal workspace-import-choice" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>resolveResultImport('cancel')}><h2>{resultImportDescriptions.map(value=>`识别为 ${value}`).join('；')}</h2><p>查看计算结果与波函数，或载入最后完整结构继续建模。</p><div className="modal-buttons"><button onClick={()=>resolveResultImport('analysis')}>进入后处理</button><button onClick={()=>resolveResultImport('structure')}>只载入结构</button><button onClick={()=>resolveResultImport('cancel')}>取消导入</button></div></DialogShell>}
  {(newInputTarget||preparedInputTarget||advancedInputTarget)&&<DialogShell aria-label="新建输入任务确认" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>{setNewInputTarget(null);setPreparedInputTarget(null);setAdvancedInputTarget(null);}}><h2>新建输入任务？</h2><p>当前输入草稿将被替换，请先导出需要保留的输入。模型结构与冻结不会删除。</p><div className="modal-buttons"><button onClick={()=>{setNewInputTarget(null);setPreparedInputTarget(null);setAdvancedInputTarget(null);}}>取消</button><button onClick={()=>{if(advancedInputTarget)prepareAdvancedInput(advancedInputTarget.source,true);else if(preparedInputTarget)prepareIrc(preparedInputTarget.structure,preparedInputTarget.engine,true);else if(newInputTarget)startNewInputTask(newInputTarget);}}>放弃当前草稿并新建</button></div></DialogShell>}
  {cancelBatchConfirm&&borrowedBatch&&<DialogShell aria-label="取消批量输入" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>setCancelBatchConfirm(false)}><h2>取消批量输入？</h2><p>关闭临时代表帧并恢复原文档；原轨迹与已保存文件保留。</p><div className="modal-buttons"><button onClick={()=>setCancelBatchConfirm(false)}>继续配置</button><button onClick={()=>void finishBatchInput(borrowedBatch.session.id)}>取消批量输入</button></div></DialogShell>}
  <output hidden data-testid="workspace-input-session-state">{JSON.stringify({taskId:inputTask?.id??null,ownerDocumentId:inputOwnerId??null,activationEpoch:inputTask?.activationEpoch??null,activeDocumentId:activeId,module:state.module})}</output>
  {runtimeDataOpen&&portableToolsAvailable&&<RuntimeDataPanel request={requestPortableTools} onClose={()=>setRuntimeDataOpen(false)} disabled={maintenanceDisabled} capabilities={{runtimeCheck:true,diagnosticsExport:true}}/>}
  {!project.dialog&&!firstRunLicense.ready&&<FirstRunLicense snapshot={firstRunLicense.snapshot} loading={firstRunLicense.loading} saving={firstRunLicense.saving} error={firstRunLicense.error} onContinue={()=>void firstRunLicense.acknowledge()} onRetry={firstRunLicense.retry}/>}
  {!project.dialog&&firstRunLicense.ready&&environmentOpen&&<EnvironmentSettings onClose={()=>setEnvironmentOpen(false)} initialPage={environmentPage} display={settingsModel?displaySettings:undefined} onDisplayChange={settingsModel?changeDisplaySettings:undefined} atoms={settingsModel?.draft.structure.atoms} hasCell={!!settingsModel?.draft.structure.cell} targetLabel={settingsEntry?.label} showAxes={sharedShowAxes} onShowAxesChange={setSharedShowAxes}/>}
  {project.busy&&<span className="workspace-project-status" role="status">{project.status}</span>}
  {deleteGroup&&<DialogShell aria-label="删除整个构象搜索组" className="modal" backdropClassName="modal-backdrop" onCancel={()=>{if(!deletingGroup)setDeleteGroup(null);}}><h2>删除整个构象搜索组？</h2><p>将移除“{conformerGroups[deleteGroup]?.label??'构象搜索'}”的初猜、采样/优化页面和本次任务结果。</p><p>项目目录外的原始文件和导出文件保留。</p><div className="modal-buttons"><button disabled={deletingGroup} onClick={()=>setDeleteGroup(null)}>取消</button><button disabled={deletingGroup} className="button button-primary" onClick={()=>void confirmDeleteGroup()}>{deletingGroup?'正在删除…':'删除整个组'}</button></div></DialogShell>}
  {closingPending?<DialogShell aria-label="正在丢弃内容" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>{}}><span role="status">正在丢弃内容并释放关联资源…</span></DialogShell>:closing&&discardImpact&&<DialogShell aria-label="丢弃内容确认" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>void cancelClose(closing)}><h2>丢弃这些内容？</h2><p>将从当前工作区永久移除以下内容及列出的下游结果，不能撤销。</p><ul>{discardImpact.impactLabels.map(label=><li key={label}>{label}</li>)}</ul><p>外部原始文件、已导出文件和此前手动保存的项目保留。</p><div className="modal-buttons"><button onClick={()=>void cancelClose(closing)}>取消</button><button className="button button-primary" onClick={()=>void executeDiscard(discardImpact)}>丢弃</button></div></DialogShell>}
  <output hidden data-testid="workspace-document-state">{JSON.stringify({activeDocumentId:activeId,displayedDocumentId,toolTargetDocumentId:activeId,activeViewId:state.activeViewId,activationEpoch:state.activationEpoch,module:state.module,deckMode,detached,documents:state.documents.map(entry=>({id:entry.id,epoch:entry.epoch,revision:entry.store.getSnapshot().revision,sourceEpoch:entry.sourceEpoch,label:entry.label,runtime:entry.runtime,analysisAvailable:registry.analysisAvailable(entry.id),analysisBindingId:entry.store.getSnapshot().analysisBindingId??null}))})}</output>
 </div></WorkspaceRenderBoundary>{taskWorkspace.dialog}{project.dialog}</>}</ProjectUiRestoreBoundary></>;
}
