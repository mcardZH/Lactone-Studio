import {createWorkspaceFileActions,type WorkspaceFileContext} from '../mcp/workspace-file-actions';
import {captureStructureExportDocument} from '../../modeling/application/structure-export-snapshot';
import {presentedVibrationStructure} from '../results/vibration-animation';
import {conformerRunCollectionId,conformerRunCollectionRef,createFrameShell,parseConformerRunCollectionRef,parseOptimizationCollectionRef,pesRecordRef,retainedOptimizationCollection,type FrameShellPorts} from '../mcp/frame-shell';
import {pesPathRecords} from '../../modeling/pes/path-records';
import {confirmFrameElectronicState,createFrameAccess,isFrameReference,viewTrajectoryCanvas} from '../mcp/frame-tools';
import type {BaseElectronicStateValues} from '../../core/base-electronic-state';
import type {ModelToolContext} from '../mcp/model-tools';
import {followInputChanges} from '../mcp/input-drafts';
import type {InputToolsContext} from '../mcp/input-tools';
import type {ScienceToolsContext} from '../mcp/science-tools';
import {checkGxtb} from '../mcp/science-tools';
import {pesRequestEvidence,scienceModelRuntime,type RetainedOrdinaryOptimizationRequest,type ScienceOptOptions,type ScienceOptSubmission} from '../mcp/science-runtime';
import {WorkspaceChanges} from '../mcp/changes';
import {useWorkspaceTools} from '../mcp/use-workspace-tools';
import {AgentPanel} from '../mcp/AgentPanel';
import {useWorkbenchFloat} from '../useWorkbenchFloat';
import {ResultsMcpProvider,useResultsMcp} from '../results/results-mcp-context';
import {showNativeResultPlot,type ResultToolsContext} from '../mcp/result-tools';
import {mcpBridge,presentWorkspaceWindow} from '../mcp/bridge';
import {presentationMode,toolError,type McCall,type McpPresentationMode} from '../mcp/types';
import type {CoreToolContext,BatchReceipt} from '../mcp/workspace-tools';
import {WorkspaceColumns,WorkspaceColumnDivider,fitWorkspaceColumns,readWorkspaceColumnGeometry,useWorkspaceColumns} from "./WorkspaceColumns";
import type {WorkspaceLayoutPort,WorkspaceLayoutSnapshot} from '../mcp/auxiliary-tools';
import {beginWorkspaceDividerDrag,moveWorkspaceDividerDrag,endWorkspaceDividerDrag} from './workspace-divider-drag';
import {Fragment,Suspense,lazy,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode,type CSSProperties} from 'react';
import {createImportResourceClosures} from './workspace-import-resources';
import {ProjectUiStore,ProjectUiScope,ProjectNativeDetailsBoundary,ProjectUiRestoreBoundary} from '../../projects/ui-state';
import {registerImportedModelSources,forgetImportedModelSources,commitImportedModelSourceBundle} from '../../projects/import-sources';
import {isTwoDImportFile,readTwoDImportFile,type TwoDImportFile} from '../../modeling/application/two-d-import';
import type {FragmentSnapshot,ModelSelection} from '../../modeling/contracts';
import type {TwoDImportRuntime,TwoDCommitGuard} from './TwoDImportWorkspace';
import type {SubmitExternalInput} from '../../task-system/integration/input-draft';
import {openSnapshotProjectSources,snapshotBridgeCompanions} from '../../task-system/integration/snapshot-project';
import {assertSnapshotMonitorTarget,resolveSnapshotMonitorFrame,snapshotPostprocessSources} from '../../task-system/integration/snapshot-selection';
import {bindSnapshotCompanionCandidates} from '../../task-system/integration/snapshot-companions';
import {readSnapshotGeneratedXtbPackage} from '../../task-system/integration/postprocess-xtb-source';
import {retainSnapshotPostprocessSources} from '../../task-system/integration/postprocess-source-extras';
import type {ManagedSourceOrigin,MonitorSnapshotTarget} from '../../task-system/application-contracts';
import {useTaskWorkspace} from '../task-system/useTaskWorkspace';
import {confirmSynchronousOperation} from '../confirmation';
import {useProjectWorkspace} from '../../projects/use-project-workspace';
import {captureWorkspaceProject,captureWorkspaceModelSnapshots,markCapturedWorkspaceModelsApplied,decodeWorkspaceProject,type WorkspaceModelSnapshot} from '../../projects/workspace-snapshot';
import {encodeDiagnostic,decodeDiagnostic,type DiagnosticProjectSnapshot} from '../../projects/diagnostic-snapshot';
import {forgetAnalysisProjectDocument,describeAnalysisProjectDocument,subscribeAnalysisProjectState,getAnalysisProjectRevision,captureAnalysisCitationSnapshots} from '../../projects/analysis-state';
import CitationDialog from '../citations/CitationDialog';
import {appendCipUsage,appendPreparedInput,emptyCitationState,restoreCitationState,retainedCitationState,type PreparedCitationInput} from '../citations/state';
import {cipReceiptSourceMatches,collectPesCitationFacts,collectWorkspaceCitationFacts,readCommittedTwoDCitationFacts,retainedCitationAnalysisInstances,retainedCitationOwnerIds,scientificFileCitationIdentity,type CitationFact,type CitationRegistry} from '../../citations';
import citationRegistryData from '../../citations/data/registry.json';
import type {AdvancedProjectSnapshot} from '../../projects/advanced-snapshot';
import {ConformerRecoveryPanel} from './ConformerRecoveryPanel';
import type {ConformerRecoveryBridge,ConformerRecoveryItem} from '../../modeling/advanced/conformer-recovery';
import {bindAdvancedPathDesktopBridge,bindConformerSamplingDesktopBridge,bindAissDesktopBridge} from '../../modeling/advanced/desktop-bridge';
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
import {prepareTrajectoryView} from '../results/usePreparedTrajectory';
import {existingPreparedTrajectoryView} from '../../results/prepared-trajectory';
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
import {scientificCanvasKey,scientificCanvasStructure,scientificFrameForModel,scientificSourceCanvas} from './scientific-frame-source';
import type {StructureExportPort} from '../results/structure-export-source';
import {captureAdvancedFrame,assertAdvancedIsolated} from '../../modeling/advanced/frame-source';
import {makeDocumentStamp} from '../../core/modeling/model-store';
import {createDesktopConformerBatchBridge} from '../../modeling/platform/conformer-batch';
import {captureWorkspaceAdvancedSource,captureWorkspaceElectronicSourceContext,electronicSourceEditingFragment,captureWorkspaceAdvancedCollection,retainedAdvancedSource,boundAdvancedResult,boundAdvancedCanvasResult,matchesAdvancedSourceCollection} from '../advanced/capture-source';
import {advancedFrameFragment,prepareAdvancedFrameInput} from '../advanced/advanced-frame-entry';
import {sameDisplaySource,advancedDisplayDocument,createAdvancedPlaybackCollection,type AdvancedCanvasLayers} from '../advanced/advanced-display';
import {identityTransform} from './render/alignment';
import type {AdvancedInputTemplate} from '../../modeling/application/advanced-frame-output';
import {createBatchInputSession,batchInputRepresentative,batchInputInitialConstraints,writeBorrowedBatchInput,restoreBorrowedBatchInput,type BatchInputSession,type BorrowedBatchInput} from '../../modeling/application/batch-input-session';
import {createDocumentRuntimeOwner,type DocumentRuntimeOwner} from '../../modeling/application/document-runtime-owner';
import {createDynamicsPort} from '../../modeling/dynamics/port';
import {desktopBridge} from '../../modeling/platform/desktop';
import {createWorkspaceRegistry,protectedPesDocument,workspaceTrajectoryKey,type WorkspaceDocumentEntry,type WorkspaceLabelOrigin} from '../../modeling/workspace-registry';
import {editableImportedStructureElectronicState} from '../../core/base-electronic-state';
import type {PesGeometry,PesNode,PesRun} from '../../modeling/pes/contracts';
import {pesConstraintReference,resolvePesConstraintDefinitions} from '../../modeling/pes/request';
import type {WorkspaceSpaceOptimizationRequest} from '../results/analysis-canvas';
import {ordinaryOptimizationInput,prepareOrdinaryOptimization,runPesOrdinaryOptimization} from './pes-ordinary-optimization';
import {OPTIMIZATION_SOLVATION_EVENT,OPTIMIZATION_PREFERENCE_KEY,readWorkspaceOptimizationPreferences,workspaceOptimizationAlpb,writeWorkspaceOptimizationPreferences} from './tool-session';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import PesWorkspaceDock,{type PesWorkspaceProjection} from './PesWorkspaceDock';
import {pesFileSnapshotSources,pesTabSnapshotSources,publishPesFileObservation,type PesFileObservation} from './pes-tab-snapshot';
import {pesTabResultCursor,selectedPesTabResultCursor,type RetainedPesTabResultCursor} from './pes-tab-result-cursor';
import {createPlaybackCollection,initialPlaybackFrame} from '../../results/playback-collection';
import {initialScientificFrame} from '../results/scientific-presentation';
import {assertPesWorkspaceCommandAllowed,matchesPesDocumentRemoval,pesReaderVisible,pesRunActive,pesWorkspaceBindings,settlePesWorkspaceRuns,usePesWorkspaceIntegration} from './usePesWorkspaceIntegration';
import {currentPesCanvas,pesNodeObserving,retainPesCanvases,updatePesCanvas,type PesCanvasCache} from './pes-canvas-publication';

import {automaticStem} from '../../core/naming';
import {periodicWorkingStructure} from '../../core/modeling/periodic-working-structure';
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
import type {AnalysisCanvas,SubmittedScientificFrame} from '../results/analysis-canvas';
import {type TrajectoryResult,type ResultDiagnostic} from '../../results/contracts';
import SourceDiagnostics from '../results/SourceDiagnostics';
import type {PostprocessDocument,PostprocessScientificFileDocument} from '../../results/postprocess-document';
import type {AnalysisAtomCapture} from './ModelViewport';
import {WorkflowSessionBar} from '../WorkflowPresentation';
import PostprocessResultView,{type ObservedPostprocessFrame,type RequestedTrajectoryCursor} from '../results/PostprocessResultView';
import PostprocessPlotDeck from '../results/PostprocessPlotDeck';
import {fileDisplayDocument,usePostprocessWorkspace} from '../results/usePostprocessWorkspace';
import {assertOrbitalSourcesIdle} from '../results/useOrbitalField';
import DialogShell from '../DialogShell';
import {workspaceTabDragMoved,workspaceTabTargetContains,resolveWorkspaceTabDropIntent} from './workspace-tab-drag';
import WorkspaceTab,{WorkspaceTabCloseIcon} from './WorkspaceTab';
import {useWorkspacePageValue} from './workspace-page-context';
import {workspaceSourceGeometryKey,workspaceRetainedSourceGeometryMatches,workspaceXtbScientificFrameIdentity} from './workspace-source-validity';
import {workspaceCurrentSharedFrozenAtomIds} from './workspace-live-preview';
import {conformerInitialDocument,assertConformerInitialElectronicOwner} from './workspace-conformer-initial-owner';
import WorkspacePublicationNotice from './WorkspacePublicationNotice';
import {createConformerPlaybackResolver,projectConformerPlaybackCollection} from '../advanced/conformer-playback';
import {captureConformerFrameOrder,conformerPlaybackOrder,type ConformerFrameOrder} from './workspace-conformer-order';
import {workspaceFreezeEditingAllowed,isConformerWorkspaceResult,commitConformerInitialFreezes,commitConformerInitialCoordinateFreeze,conformerFrameFreezeDisplay,type ConformerFreezeCoordinate} from './workspace-freeze-policy';
import {createConformerDisplayRestoration} from '../../modeling/conformers/playback-display';
import {createConformerCollectionPublisher,conformerCollectionSourcesCurrent,conformerCollectionMatchesCurrent,conformerCollectionMatchesPublished,createAdvancedHydrationProjectionBaseline,conformerPlaybackFrameIndex,conformerTrajectoryObservedSource,prepareConformerPublication,restoredConformerPublicationResult,retirePreparedConformerPublication} from './workspace-conformer-publication';
import {previewImportDescription,postprocessDocumentEngine,postprocessDocumentTask} from '../results/postprocess-import-policy';
import {postprocessDifferences,disposePostprocessFileDocument} from '../../results/postprocess-document';
import type {PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import {filePathPlotScope,retainedFilePathPlots,type FilePathPlotSnapshot} from '../results/file-path-plot';
import {resultFile,type ScientificSourceFile} from '../../results/input-file';
import {consumeLaunchImports,type LaunchImportBridge} from '../../modeling/platform/launch-import';
import {identifyPostprocessSource,readPostprocessFileOutput,isScientificFileSource,readPostprocessAuxiliary,readPostprocessWavefunctionStructure} from '../../results/postprocess-sources';
import {modelFragmentsFromStructures} from '../../modeling/platform/files';
import {exportWorkspaceResult} from '../results/export-workspace';
import {prepareIrcIntent} from '../../results/continuation';
import type {InputStructureSource,Structure} from '../../core/types';
import {importStructureFiles} from '../../core/file-import';
import {withAtomIds} from '../../core/structures';
import type {MultiStructureSourceActions,StructureSourcePickRequest} from '../MultiStructureSourcePicker';
import {createSharedSurface,SharedSurface,createOwnedSharedSurface,OwnedSharedSurface,sharedSurfaceOwnerKey,type SharedSurfaceOwner} from './shared-surface';
import {useLinkedWorkspace} from './linked-workspace';
import {DEFAULT_DISPLAY,type DisplaySettings,type ChemistryPort,type PortableToolsRequest,type PortableToolsResponse,type ScientificEditRequest} from '../../modeling/contracts';
import {readModelDisplayPreferences} from '../../modeling/platform/display-preferences';
import {useRuntimeModelDisplay} from './useRuntimeModelDisplay';
import {createDefaultWorkspaceToolIntent,type WorkspaceToolIntent,type WorkspaceViewportImageCapture} from './ModelWorkspace';
import {createChemistryPort} from '../../modeling/chemistry';
import {EmpiricalFrameBonds,empiricalFrameBondDisplayStructure} from '../../results/empirical-frame-bonds';
import {createWorkspaceOwnerAdapter,isCurrentDocumentSaveIntent} from '../../modeling/platform/workspace-bridge';
import {applyWorkspaceOwnerCommand} from '../../modeling/application/workspace-owner-command';
import {bindWorkspaceAdvancedConsumers} from '../../modeling/application/workspace-advanced-consumers';
import {conformerDiscardSelection,planWorkspaceDiscard,prepareWorkspaceDiscard,type WorkspaceDiscardImpact,type WorkspaceDiscardExecution} from '../../modeling/application/conformer-lifecycle';
import type {TabCloseAdmission,TabCloseReceipt,TabToolContext,WorkspaceTabRecord} from '../mcp/tab-tools';
import {ANALYSIS_TITLES} from '../results/analysis-workspace';
import {describeAnalysisDocumentClose,assertAnalysisDocumentIdle,prepareAnalysisDocumentClose} from '../../modeling/application/analysis-runtime-owners';
import type {AdvancedDiscardConformerPlan} from '../../modeling/advanced/contracts';
import {observeTrajectoryOperations,type TrajectoryOperationEvent} from '../../results/trajectory-operations';
import {multiwfnProgressTerminal,type MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import {useWorkbenchLayout} from './WorkbenchLayout';
import {clampWorkbenchPaneSize,DEFAULT_WORKBENCH_PANE_SIZES} from '../../modeling/workbench-layout';
import ModelDocumentDeck,{type ModelDocumentDeckMode} from './ModelDocumentDeck';
import {createLayoutResizeBoundary} from './render/resize-lifecycle';
import {assertDetachedFrameTarget,isDetachedFrameAction,isFrameBondViewportEdit,type WorkspaceViewportState,type WorkspaceViewportController,type WorkspaceViewportEvent} from './workspace-viewport';
import {blockingModelDialog,workspaceSpacePressAllowed} from './workspace-actions';
import {createViewportDisplayOwner,openViewportDisplayPort,projectedCipStructure,viewportDisplaySignature,type ViewportDisplayProjection,type ViewportDisplayDescriptor,type ViewportDisplayOwner} from './viewport-display-channel';
import type {ModelViewportProps} from './ModelViewport';
import RuntimeDataPanel from '../portable/RuntimeDataPanel';
import EnvironmentSettings from '../EnvironmentSettings';
import type {SettingsNavigation,SettingsPage,SettingsTarget} from './SettingsPanel';
import WorkspaceRenderBoundary from './WorkspaceRenderBoundary';
import {DismissibleNotice} from '../DismissibleNotice';
import RuntimeRecoveryActions from './RuntimeRecoveryActions';
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
 onRetainedOptimization?(request:RetainedOrdinaryOptimizationRequest):Promise<PesRun|void>;
 onCipLabelsUsed?:ModelViewportProps['onCipLabelsUsed'];
 onViewportImageCapture?(capture:WorkspaceViewportImageCapture|null):void;
 entry:WorkspaceDocumentEntry;active:boolean;module:WorkspaceModule;
 inputActive:boolean;inputTaskId?:string;
 documentRuntime?:DocumentRuntimeOwner;onReturnToModel?():void;
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
 onDraftState(engine:'gaussian'|'orca',value:JsonValue,dirty:boolean,agentWrite?:boolean):void;
 sharedLayout:boolean;toolHost:HTMLElement|null;toolbarHost:HTMLElement|null;inputHost:HTMLElement|null;
 onToolSurfaceChange(surface:ReactNode):void;onModelToolsChange?(surface:ReactNode):void;onToolbarSurfaceChange(surface:ReactNode):void;onLegendSurfaceChange(surface:ReactNode):void;presentationActive?:boolean;
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
 pesObservation?:boolean;
 samplingSphereDraft?:SamplingSphereViewportDraft|null;
 onSamplingSphereRadiusChange?(change:SamplingSphereRadiusChange):void;
 structureAnalysisActive?:boolean;
 freezeEditingAllowed?:boolean;
 advancedModelingRoute?:AdvancedModelingRoute;
 onAdvancedModelingRouteChange?(route:AdvancedModelingRoute):void;
 onAdvancedModelingBack?():void;
 onDeriveStructure?(candidate:StructureTransformCandidate,source?:import('../../modeling/contracts').ModelDocument):void;
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
  const source=periodicWorkingStructure(item.fragment.structure);
  // Saved rich model fragments retain their edited graph and history.
  if(item.restoredModel){prepared.push(source===item.fragment.structure?item:{...item,fragment:{...item.fragment,structure:source}});continue;}
  const provider=new EmpiricalFrameBonds({port:options.port,sourceId:`import:${source.id}`});
  let result:Awaited<ReturnType<EmpiricalFrameBonds['resolve']>>;
  try{result=await provider.resolve(source,0,{signal:options.signal,guard});}finally{provider.dispose();}
  guard();
  if(result.status==='stale'||result.status==='cancelled')throw new Error('模型导入已取消或活动文档已变化，未提交新文档。');
  if(result.warnings.length&&(result.status!=='inferred'||source.cell||source.periodicSource))warnings.push(source.name+'：'+result.warnings.join('；'));
  prepared.push({kind:'model',fragment:{...item.fragment,structure:editableImportedStructureElectronicState(empiricalFrameBondDisplayStructure(result))}});
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
  if(!object(raw)||!['gfn2','gfn1','gfn0','gfnff','gxtb','MMFF94','MMFF94s','UFF'].includes(String(raw.method))
   ||!['none','alpb','gbsa'].includes(String(raw.solvationModel))||typeof raw.solvent!=='string'||typeof raw.internalConstraintsConfirmed!=='boolean'
   ||raw.sccIterationLimitText!==undefined&&typeof raw.sccIterationLimitText!=='string'
   ||![raw.threads,raw.maxSteps,raw.sccIterationLimit].every(v=>typeof v==='number'&&Number.isFinite(v)))throw Error('项目XTB方法草稿格式无效。');
  methodDrafts[id]={method:raw.method as AdvancedMethodDraft['method'],threads:raw.threads as number,maxSteps:raw.maxSteps as number,sccIterationLimit:raw.sccIterationLimit as number,...(typeof raw.sccIterationLimitText==='string'?{sccIterationLimitText:raw.sccIterationLimitText}:{}),
   solvationModel:raw.solvationModel as AdvancedMethodDraft['solvationModel'],solvent:raw.solvent,internalConstraintsConfirmed:raw.internalConstraintsConfirmed};
 }
 return {electronicDrafts,taskSelections,methodDrafts};
}
/** Generated wavefunctions are output attachments on an ordinary model. Their
 * automatic canvas/binding never becomes a newly selected singlepoint input.
 * Real result/trajectory roles and explicitly observed source frames retain
 * their protected source/copy workflow. */
export function workspaceXtbUsesWorkingModelInput(entry:Pick<WorkspaceDocumentEntry,'result'|'legacyResult'|'analysisBinding'|'trajectory'|'conformerGroup'|'pesGroup'>,observed?:AdvancedFrameSource):boolean{
 return !protectedPesDocument(entry)&&!entry.result&&!entry.legacyResult&&!entry.analysisBinding&&!entry.trajectory&&!entry.conformerGroup
  &&!observed?.ref.sourceId&&!observed?.ref.taskId;
}
export function workspaceInputFrameSource(entry:WorkspaceDocumentEntry,canvas:AnalysisCanvas|undefined,
 retained?:SubmittedScientificFrame):WorkspaceTaskSource|undefined{
 const submitted=canvas?.readSubmittedScientificFrame?.()??retained;
 if(entry.trajectory&&(!submitted||entry.legacyResult!==submitted.result))return;
 const structure=submitted?.structure??scientificCanvasStructure(canvas,true);
 if(!structure?.atoms.length||!Number.isSafeInteger(structure.charge)||!Number.isSafeInteger(structure.multiplicity)||structure.multiplicity!<1)return;
 const {id:documentId,epoch:documentEpoch,sourceEpoch,label}=entry,revision=entry.store.getSnapshot().revision;
 return {documentId,documentEpoch,sourceEpoch,revision,structure,charge:structure.charge!,multiplicity:structure.multiplicity!,
  label:submitted?`${label} · 帧 ${submitted.index+1}`:label,confirmed:true,geometryUnits:'angstrom'};
}
/** The active xTB analysis can display a result over its originating PES page. */
export function workspaceActiveXtbCanvas(context:{xtbAnalysis:boolean; documentId:string; activeId?:string|null},
  resolve:()=>AnalysisCanvas|undefined):AnalysisCanvas|undefined {
  return context.xtbAnalysis&&context.documentId===context.activeId?resolve():undefined;
}

export default function WorkspaceShell(props:{renderDocument(surface:DocumentWorkspaceSurface):ReactNode}) {
 const [projectUi]=useState(()=>new ProjectUiStore());
 return <ProjectUiScope store={projectUi} scope={['workspace']}><ResultsMcpProvider><ProjectWorkspaceShell {...props} projectUi={projectUi}/></ResultsMcpProvider></ProjectUiScope>;
}
function ProjectWorkspaceShell({renderDocument,projectUi}:{renderDocument(surface:DocumentWorkspaceSurface):ReactNode;projectUi:ProjectUiStore}) {
 const desktop=window.sciyueDesktop;
 const workbench=useWorkbenchLayout();
 const [registry]=useState(()=>{const value=createWorkspaceRegistry();value.addDocument();return value;});
 const state=useSyncExternalStore(registry.subscribe,registry.getSnapshot,registry.getSnapshot);
 const recoveryBridge=desktop?.listConformerRecovery&&desktop.openConformerRecovery&&desktop.readConformerRecovery&&desktop.closeConformerRecovery&&desktop.discardConformerRecovery?desktop as ConformerRecoveryBridge:undefined;
 const activePageId=state.views.find(view=>view.id===state.activeViewId)?.documentId;
 const activeConformerGroup=state.documents.find(entry=>entry.id===activePageId)?.conformerGroup;
 const [error,setError]=useState(''),[reading,setReading]=useState(false),[readProgress,setReadProgress]=useState<number|null>(null),[readCancelPending,setReadCancelPending]=useState(false),[importCloseFailed,setImportCloseFailed]=useState(false);
 const pes=usePesWorkspaceIntegration(registry,setError,()=>pesFollowAllowed.current&&advancedSectionRef.current==='path');
 useEffect(()=>{
  const controller=pes.controller;if(!controller)return;
  let previous=workspaceOptimizationAlpb(readWorkspaceOptimizationPreferences())?.solvent;
  const apply=(value:ReturnType<typeof workspaceOptimizationAlpb>)=>{
   if(value?.solvent===previous)return;
   previous=value?.solvent;
   controller.syncXtbSolvation(value);
  };
  const sync=(event:Event)=>apply((event as CustomEvent<ReturnType<typeof workspaceOptimizationAlpb>|null>).detail??undefined);
  const storage=(event:StorageEvent)=>{
   if(event.key===OPTIMIZATION_PREFERENCE_KEY)apply(workspaceOptimizationAlpb(readWorkspaceOptimizationPreferences()));
  };
  window.addEventListener(OPTIMIZATION_SOLVATION_EVENT,sync);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(OPTIMIZATION_SOLVATION_EVENT,sync);window.removeEventListener('storage',storage);};
 },[pes.controller]);
 const [pesCanvases,setPesCanvases]=useState<PesCanvasCache>(()=>new Map());
 const pesCanvasesRef=useRef(pesCanvases);pesCanvasesRef.current=pesCanvases;
 const pesSubmittedFrames=useRef(new WeakMap<WorkspaceDocumentEntry['store'],{sourceEpoch:number;revision:number;frame:PesGeometry|null}>());
 const pesCanvasPublishers=useRef(new Map<string,{epoch:string;publish:(id:string,value:PesWorkspaceProjection|null)=>void}>());
 const [collapsedPesGroups,setCollapsedPesGroups]=useState<Record<string,boolean>>({});
 const restoredPesNames=useRef<Record<string,string>>({});
 const [pesClosing,setPesClosing]=useState<{groupId:string;nodeId?:string;label:string;requesterDocumentId?:string}|null>(null),[pesDeleting,setPesDeleting]=useState(false);

 const pesEntering=useRef(false);
 const pesFollowAllowed=useRef(false);
 function pesCanvasPublisher(entry:WorkspaceDocumentEntry){
  const prior=pesCanvasPublishers.current.get(entry.id);if(prior?.epoch===entry.epoch)return prior.publish;
  const owner={id:entry.id,epoch:entry.epoch};
  const publish=(id:string,value:PesWorkspaceProjection|null)=>{
   const current=registry.getSnapshot().documents.find(row=>row.id===owner.id);
   if(id!==owner.id||current?.epoch!==owner.epoch||!current.pesGroup)return;
   if(value?.readSubmittedFrame){
    const revision=current.store.getSnapshot().revision;
    pesSubmittedFrames.current.set(current.store,{sourceEpoch:current.sourceEpoch,revision,frame:value.readSubmittedFrame()??null});
   }
   setPesCanvases(previous=>updatePesCanvas(previous,owner,value));
  };
  pesCanvasPublishers.current.set(entry.id,{epoch:entry.epoch,publish});return publish;
 }
 const importResourceClosures=useRef(createImportResourceClosures()),importReadScope=useRef<{epoch:number;settled:boolean}|null>(null);
 const [twoDFile,setTwoDFile]=useState<TwoDImportFile|null>(null),[twoDVisible,setTwoDVisible]=useState(false),[twoDBusy,setTwoDBusy]=useState(false);
 const twoDFileRef=useRef(twoDFile);twoDFileRef.current=twoDFile;
 const twoDVisibleRef=useRef(twoDVisible);twoDVisibleRef.current=twoDVisible;
 const twoDOrigin=useRef<'manual'|'imported'>('manual');
 const [mcpChanges]=useState(()=>new WorkspaceChanges());
 const selectionObservers=useRef(new Map<string,()=>void>());
 const sketchObserver=useRef<(()=>void)|undefined>(undefined);
 const observedFrameKeys=useRef(new Map<string,string>());
 function publishFrameChange(id:string,canvas:AnalysisCanvas|null){
  const navigation=canvas?.trajectoryPlayback?.readNavigation?.();
  const key=JSON.stringify([canvas?.result?.id,canvas?.frameIndex,canvas?.scientificFrameReady,navigation?.id,navigation?.status]);
  if(observedFrameKeys.current.get(id)===key)return;
  observedFrameKeys.current.set(id,key);mcpChanges.record({kind:'frame',target:id,fields:['frame','viewport']});
 }
 const twoDRuntime=useRef<TwoDImportRuntime|null>(null),twoDLoadEpoch=useRef(0),twoDCommitting=useRef(false);
 const setTwoDRuntime=useCallback((value:TwoDImportRuntime|null)=>{
  sketchObserver.current?.();twoDRuntime.current=value;
  sketchObserver.current=value?.sketch.subscribeChanges(change=>mcpChanges.record({kind:'sketch',target:change.draftId,revision:change.revision,fields:[change.status,change.dirty?'dirty':'clean',change.busy?'busy':'idle']}));
 },[mcpChanges]);
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
 const [requestedTaskCursors,setRequestedTaskCursors]=useState<Record<string,RequestedTrajectoryCursor>>({});
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
 const [environmentPage,setEnvironmentPage]=useState<SettingsPage>('resources');
 const [settingsNavigation,setSettingsNavigation]=useState<SettingsNavigation>();
 const settingsNavigationRef=useRef<SettingsNavigation|undefined>(undefined);
 const cancelSettingsNavigation=useCallback(()=>settingsNavigationRef.current?.complete({status:'superseded'}),[]);
 const closeEnvironmentSettings=useCallback(()=>{cancelSettingsNavigation();setEnvironmentOpen(false);},[cancelSettingsNavigation]);
 const openDisplaySettings=useCallback(()=>{cancelSettingsNavigation();setEnvironmentPage('display');setEnvironmentOpen(true);},[cancelSettingsNavigation]);
 useEffect(()=>cancelSettingsNavigation,[cancelSettingsNavigation]);
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
 const [fileObservedStructure,setFileObservedStructure]=useState<{owner:PostprocessScientificFileDocument;structure:Structure}|null>(null);
 const [fileDisplayedResult,setFileDisplayedResult]=useState<{owner:PostprocessScientificFileDocument;result:TrajectoryResult}|null>(null);
 const modelImageCaptures=useRef(new Map<string,{epoch:string;capture:WorkspaceViewportImageCapture}>());
 const fileObservations=useRef(new WeakMap<PostprocessScientificFileDocument,{projectEpoch:number;observation:PesFileObservation;publishStructure:(structure:Structure|null)=>void;publishCursor:(frame:ObservedPostprocessFrame|null,kind?:'default')=>void;publishResult:(result:TrajectoryResult|null)=>void}>());
 const fileStructureExports=useRef(new Map<string,{source:PostprocessScientificFileDocument;port:StructureExportPort}>());
 const fileStructureExportPort=useCallback((source:PostprocessScientificFileDocument,port:StructureExportPort|null)=>{
  if(port)fileStructureExports.current.set(source.id,{source,port});
  else if(fileStructureExports.current.get(source.id)?.source===source)fileStructureExports.current.delete(source.id);
 },[]);
 const [activeAnalysisResults,setActiveAnalysisResults]=useState<Record<string,{source:PostprocessDocument;result:TrajectoryResult|null}>>({});
 const activeResultCallbacks=useRef(new Map<string,{source:PostprocessDocument;callback:(result:TrajectoryResult|null)=>void}>());
 const analysisCanvasesRef=useRef(analysisCanvases);analysisCanvasesRef.current=analysisCanvases;
 type PendingEdit={request:Readonly<ScientificEditRequest>;stamp:WorkspaceActivationStamp;frameKey:string};
 const [pendingEdit,setPendingEdit]=useState<PendingEdit|null>(null),[editChoiceBusy,setEditChoiceBusy]=useState(false),[pendingEditError,setPendingEditError]=useState('');
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
 const [advancedSection,setAdvancedSection]=useWorkspacePageValue<AdvancedSection|null>(activePageId,state.documents.find(entry=>entry.id===activePageId)?.pesGroup?'path':activeConformerGroup?'conformer':activePageId?inheritedNavigation.current.get(activePageId)?.section??null:null,'advancedSection');
 const [conformerGroups,setConformerGroups]=useState<Record<string,{label:string;labelOrigin?:WorkspaceLabelOrigin;collapsed:boolean;samplingOperation?:ConformerSamplingChoice|null}>>({});
 const [conformerSamplingChoice,setConformerSamplingChoice]=useWorkspacePageValue<ConformerSamplingChoice|null>(activePageId,activeConformerGroup?conformerGroups[activeConformerGroup.taskId]?.samplingOperation??null:activePageId?inheritedNavigation.current.get(activePageId)?.sampling??null:null,'conformerSamplingChoice');
 const [renamingGroup,setRenamingGroup]=useState<string|null>(null);
 const [conformerFrameOrders,setConformerFrameOrders]=useState<Record<string,ConformerFrameOrder>>({});
 const [conformerViewControls,setConformerViewControls]=useState<Record<string,ReactNode>>({});
 const conformerCollectionCache=useRef(new WeakMap<AdvancedTaskRecord,ConformerResultCollection[]>());
 const conformerPlayerCollections=useRef(new Map<string,{result:TrajectoryResult;collection:ConformerResultCollection;ownerId:string;value:ReturnType<typeof createAdvancedPlaybackCollection>}>());
 const conformerCollectionPublisher=useRef(createConformerCollectionPublisher());
 const conformerPrepared=useRef(new Map<string,{frames:ReadonlyArray<{id:string;coordinates:string;energy:number|undefined}>;includeEnergies:boolean|undefined;result:TrajectoryResult;abort:AbortController;ready:Promise<void>}>());
 const restoredConformerReaders=useRef(new WeakSet<TrajectoryResult>());
 const advancedIntegration=useRef<{controller?:AdvancedController;prepare(task:AdvancedTaskRecord,onProgress:(completed:number,total:number)=>void):Promise<void>}>({prepare:async()=>{throw Error('构象结果准备入口尚未连接。');}});
 const [samplingSphereDraft,setSamplingSphereDraft]=useState<SamplingSphereDraft|undefined>();
 const [samplingSphereRadiusChange,setSamplingSphereRadiusChange]=useState<SamplingSphereRadiusChange|null>(null);
 const derivedModelingRoutes=useRef(new Map<string,AdvancedModelingRoute>());
 const [advancedModelingRoute,setAdvancedModelingRoute]=useWorkspacePageValue<AdvancedModelingRoute>(activePageId,activePageId?derivedModelingRoutes.current.get(activePageId)??null:null,'advancedModelingRoute');
 const advancedSectionRef=useRef(advancedSection);advancedSectionRef.current=advancedSection;
 const [xtbAnalysisCanvases,setXtbAnalysisCanvases]=useState<Record<string,AnalysisCanvas|null>>({});
 const [xtbAnalysisSelections,setXtbAnalysisSelections]=useState<Record<string,string|undefined>>({});
 const [xtbElectronicDrafts,setXtbElectronicDrafts]=useState<Record<string,ElectronicStateDraft>>({});
 const xtbElectronicDraftsRef=useRef(xtbElectronicDrafts);xtbElectronicDraftsRef.current=xtbElectronicDrafts;
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
 const submittedConformerInputs=useRef(new WeakMap<WorkspaceDocumentEntry['store'],SubmittedScientificFrame>());
 const submittedPesTabResults=useRef(new WeakMap<WorkspaceDocumentEntry['store'],RetainedPesTabResultCursor>());
 function ownsPesTabResult(entry:WorkspaceDocumentEntry,result:TrajectoryResult){
  if(entry.result===result)return true;
  if(!registry.analysisAvailable(entry.id))return false;
  const binding=advancedPorts.current.postprocess.getDocument(entry.id);
  return entry.legacyResult===result||Boolean(boundAdvancedResult(binding,result));
 }
 function canvasFor(id:string){
  let callback=canvasCallbacks.current.get(id);
  if(!callback){
   callback=value=>{
    publishFrameChange(id,value);
    if(value?.result){
     lastScientificCanvases.current.set(id,value);
     const submitted=value.readSubmittedScientificFrame?.();
     const entry=registry.getSnapshot().documents.find(document=>document.id===id);
     if(entry&&!entry.trajectory&&value.readSubmittedScientificFrame){
      const cursor=pesTabResultCursor(value,result=>ownsPesTabResult(entry,result));
      if(cursor)submittedPesTabResults.current.set(entry.store,{...cursor,sourceEpoch:entry.sourceEpoch});
     }
     if(submitted){
      if(entry?.trajectory&&entry.legacyResult===submitted.result)submittedConformerInputs.current.set(entry.store,submitted);
     }
     if(value.scientificFrameReady&&value.frameIndex!==undefined){
      if(entry?.trajectory&&entry.legacyResult===value.result){
       const frameId=entry.trajectory.frameIds[value.frameIndex],previous=trajectoryFrames.current.get(id);
       if(frameId&&(previous?.resultId!==value.result.id||previous.frameIndex!==value.frameIndex)){
        trajectoryFrames.current.set(id,{resultId:value.result.id,frameIndex:value.frameIndex});
        // A repeated canvas update must not overwrite an explicit pending seek.
        // A newly prepared frame publishes its cursor in the same layout pass.
        if(entry.trajectory.currentFrameId!==frameId)registry.selectTrajectoryFrame(id,frameId);
       }
      }
     }
    }
    setAnalysisCanvases(previous=>previous[id]===value?previous:{...previous,[id]:value});
   };
   canvasCallbacks.current.set(id,callback);
  }
  return callback;
 }
 const analysisHostCallbacks=useRef(new Map<string,(node:HTMLDivElement|null)=>void>());
 function analysisHostRef(id:string){let callback=analysisHostCallbacks.current.get(id);if(!callback){callback=node=>setAnalysisToolHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});analysisHostCallbacks.current.set(id,callback);}return callback;}
 const [plots,setPlots]=useState<(PostprocessPlotSnapshot|FilePathPlotSnapshot)[]>([]),[resultImportRequest,setResultImportRequest]=useState<ScientificSourceFile[]|null>(null),[resultImportDescriptions,setResultImportDescriptions]=useState<string[]>([]);
 const resultImportChoice=useRef<((value:'analysis'|'structure'|'cancel')=>void)|null>(null);
 const resolveResultImport=(value:'analysis'|'structure'|'cancel')=>{const resolve=resultImportChoice.current;resultImportChoice.current=null;setResultImportRequest(null);resolve?.(value);};
 const openPlot=useCallback((snapshot:PostprocessPlotSnapshot|FilePathPlotSnapshot)=>{
  const id=`plot-${crypto.randomUUID()}`;
  setPlots(previous=>[...previous,{...structuredClone(snapshot),id}]);
  return id;
 },[]);
 const [inputHosts,setInputHosts]=useState<Record<string,HTMLDivElement|null>>({});
 const inputHostCallbacks=useRef(new Map<string,(node:HTMLDivElement|null)=>void>());
 function inputHostRef(id:string){let callback=inputHostCallbacks.current.get(id);if(!callback){callback=node=>setInputHosts(previous=>previous[id]===node?previous:{...previous,[id]:node});inputHostCallbacks.current.set(id,callback);}return callback;}
 const [toolSurface]=useState(createSharedSurface),[modelToolsSurface]=useState(createOwnedSharedSurface),[toolbarSurface]=useState(createSharedSurface),[legendSurface]=useState(createSharedSurface);
 const [leftToolSurface]=useState(createOwnedSharedSurface),[leftToolPublishedOwner,setLeftToolPublishedOwner]=useState<string|null>(null);
 const leftToolOwner:SharedSurfaceOwner|null=activePageId&&(['modeling','advanced-modeling'].includes(state.module)||state.module==='advanced'&&advancedSection==='path')?{documentId:activePageId,module:state.module,route:JSON.stringify(state.module==='advanced-modeling'?advancedModelingRoute:state.module==='advanced'?advancedSection:null)}:null;
 const leftToolOwnerRef=useRef(leftToolOwner);leftToolOwnerRef.current=leftToolOwner;
 const leftToolOpen=Boolean(leftToolOwner&&leftToolPublishedOwner===sharedSurfaceOwnerKey(leftToolOwner));
 const [legendHostId,setLegendHostId]=useState<string|null>(null),[legendTarget,setLegendTarget]=useState<HTMLElement|null>(null),[legendExpanded,setLegendExpanded]=useState(true);
 const [sourcePick,setSourcePick]=useState<{ownerId:string;stamp:import('../../modeling/workspace-contracts').WorkspaceInputTaskStamp;request:StructureSourcePickRequest}|null>(null);
 const sourcePickLive=useRef(sourcePick);sourcePickLive.current=sourcePick;
 const [sourceRoles,setSourceRoles]=useState<Record<string,{documentId:string;label:string}[]>>({});
 const inputControllers=useRef(new Map<string,{history?(kind:'undo'|'redo'):boolean;canUndo?():boolean;canRedo?():boolean;reset():void;cancel():void;isBusy():boolean;getAdvancedInputTemplate?():AdvancedInputTemplate|undefined}>());
 const [,setInputHistoryRevision]=useState(0);
 const notifyInputHistoryChange=useCallback(()=>setInputHistoryRevision(value=>value+1),[]);
 const [newInputTarget,setNewInputTarget]=useState<string|null>(null);
 const [advancedInputTarget,setAdvancedInputTarget]=useState<{source:AdvancedFrameSource;previousTaskId?:string}|null>(null);
 type BorrowedBatch=BorrowedBatchInput;
 const [borrowedBatch,setBorrowedBatch]=useState<BorrowedBatch|null>(null),[cancelBatchConfirm,setCancelBatchConfirm]=useState(false);
 const borrowedBatchRef=useRef(borrowedBatch);borrowedBatchRef.current=borrowedBatch;
 const retainedUnreadableBatchAsset=useRef<string|undefined>(undefined);
 const [batchInputRecoveryNotice,setBatchInputRecoveryNotice]=useState<string>();
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
 const mcpCloseStaging=useRef(new Map<string,()=>void>());
 const closeConfirmations=useRef(new Set<string>());
 const closingTransactions=useRef(new Set<string>());
 const runtimeOwners=useRef(new Map<string,{controller:DynamicsController;unsubscribe:()=>void}>());
 const documentRuntimeOwners=useRef(new Map<string,{epoch:string;owner:DocumentRuntimeOwner}>());
 function documentRuntime(entry:WorkspaceDocumentEntry):DocumentRuntimeOwner{
  const retained=documentRuntimeOwners.current.get(entry.id);if(retained){if(retained.epoch!==entry.epoch)throw Error('运行文档身份发生冲突。');return retained.owner;}
  const owner=createDocumentRuntimeOwner(entry.store,{xtbBridge:desktopBridge(),chemistry:createChemistryPort(),dynamicsPort:createDynamicsPort(),assertCurrent(){const current=registry.document(entry.id);if(current.epoch!==entry.epoch||current.store!==entry.store)throw Error('运行所属模型已关闭或替换。');}});
  documentRuntimeOwners.current.set(entry.id,{epoch:entry.epoch,owner});
  const update=()=>{const current=registry.getSnapshot().documents.find(value=>value.id===entry.id&&value.epoch===entry.epoch);if(!current)return;const xtb=owner.xtb.getSnapshot(),dynamic=owner.dynamics.getSnapshot(),phase=xtb.running?(xtb.phase==='stopping'?'stopping':'running'):dynamic.status;
   const operationId=xtb.running?xtb.sourceChain?.at(-1):['starting','running','pausing','paused','stopping'].includes(dynamic.status)?dynamic.sessionId:undefined;
   if(operationId)ownerAdapters.current.get(entry.id)?.setPublicationOperation(`native:${operationId}`);
   if(!current.runtime.ownerId&&['starting','running','pausing','paused','stopping'].includes(phase))registry.claimRuntime(entry.id,entry.epoch);
   if(current.runtime.ownerId&&current.runtime.phase!==phase){registry.runtimePhase(entry.id,entry.epoch,phase);publishMetadata(entry.id);}
  };
  const releaseXtb=owner.xtb.subscribe(update),releaseDynamics=owner.dynamics.subscribe(update);
  runtimeOwners.current.set(entry.id,{controller:owner.dynamics,unsubscribe:()=>{releaseXtb();releaseDynamics();}});
  return owner;
 }
 async function prepareDocumentRuntimeClose(id:string){
  const retained=documentRuntimeOwners.current.get(id);if(!retained)return {documentId:id,documentEpoch:null,commit(){},cancel(){}};
  const prepared=await retained.owner.prepareClose();let settled=false;
  return {documentId:id,documentEpoch:retained.epoch,commit(){if(settled)return;settled=true;if(documentRuntimeOwners.current.get(id)===retained){runtimeOwners.current.get(id)?.unsubscribe();runtimeOwners.current.delete(id);documentRuntimeOwners.current.delete(id);}prepared.commit();},cancel(){if(settled)return;settled=true;prepared.cancel();}};
 }
 function runtimeRecovery(id:string){const runtime=documentRuntimeOwners.current.get(id)?.owner;return runtime?<RuntimeRecoveryActions key={id} owner={runtime} label={registry.getSnapshot().documents.find(entry=>entry.id===id)?.label} waitForClosed={async sessionId=>{if(!desktop?.waitForDynamicsClose)throw Error('当前环境无法确认运行已经关闭。');await desktop.waitForDynamicsClose(id,sessionId);}}/>:null;}
 function returnToAvailableModel(failedId?:string){
  taskWorkspace.leave();closeEnvironmentSettings();setCitationOpen(null);closeTwoD();postprocess.selectFile(null);
  const entry=registry.getSnapshot().documents.find(value=>value.id!==failedId&&!value.result)??registry.addDocument();
  activateDocument(entry.id);registry.setModule('modeling');setMainDocumentId(entry.id);
 }
 const ownerAdapters=useRef(new Map<string,ReturnType<typeof createWorkspaceOwnerAdapter>>());
 const [,refreshOwnerAdapters]=useState(0);
 const viewportStates=useRef(new Map<string,WorkspaceViewportState>()),viewportControllers=useRef(new Map<string,WorkspaceViewportController>());
 const pendingCameraRestores=useRef(new Map<string,{stamp:WorkspaceActivationStamp;view:number[]}>());
 const displaySources=useRef(new Map<string,{projection:ViewportDisplayProjection;descriptor:ViewportDisplayDescriptor;signature?:string;observer:ModelViewportProps['onSurfaceMeshState']}>()),displaySerials=useRef(new Map<string,number>()),displayOwners=useRef(new Map<string,ViewportDisplayOwner>());
 const callbacks=useRef(new Map<string,DocumentWorkspaceSurface>());
 const pagePresentations=useRef(new Map<string,Pick<DocumentWorkspaceSurface,'analysisCanvas'|'advancedModelingRoute'|'samplingSphereDraft'>>());
 const observedOptimizationCanvases=useRef(new WeakMap<AnalysisCanvas,{id:string;canvas:AnalysisCanvas}>());
 const optimizeObservedFrameRef=useRef(startObservedOptimization);optimizeObservedFrameRef.current=startObservedOptimization;
 const pageScroll=useRef(new Map<string,{top:number;left:number}>());
 useEffect(()=>subscribeGlobalSettings(desktop,()=>{cancelSettingsNavigation();setEnvironmentPage('resources');setEnvironmentOpen(true);}),[cancelSettingsNavigation,desktop]);
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
 useEffect(()=>{
  let alive=true,scheduled:number|undefined,latest=0,last=-1;
  const unsubscribe=subscribePreparedTrajectoryMemory(bytes=>{
   latest=bytes;
   scheduled??=window.setTimeout(()=>{scheduled=undefined;if(last===latest)return;last=latest;
    void desktop?.reportPreparedTrajectoryMemory?.(latest).catch(cause=>{if(alive)setError('轨迹内存状态同步失败：'+String(cause));});},50);
  });
  return()=>{alive=false;unsubscribe();if(scheduled!==undefined)window.clearTimeout(scheduled);};
 },[desktop]);
 const advancedOutputBridge=useMemo(()=>desktop?.chooseAdvancedOutput&&desktop.writeAdvancedOutput&&desktop.abandonAdvancedOutput?{
  chooseAdvancedOutput:desktop.chooseAdvancedOutput.bind(desktop),writeAdvancedOutput:desktop.writeAdvancedOutput.bind(desktop),abandonAdvancedOutput:desktop.abandonAdvancedOutput.bind(desktop),
  beginBinaryAsset:desktop.beginBinaryAsset?.bind(desktop),appendBinaryAsset:desktop.appendBinaryAsset?.bind(desktop),sealBinaryAsset:desktop.sealBinaryAsset?.bind(desktop),releaseBinaryAsset:desktop.releaseBinaryAsset?.bind(desktop),
 }:null,[desktop]);
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
 const pesCanvas=currentPesCanvas(pesCanvases,active);
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
 function protectedConformerSource(id:string,source=advancedObservationsRef.current[id]){const entry=registry.getSnapshot().documents.find(row=>row.id===id);if(entry?.conformerGroup)return entry.conformerGroup.role!=='initial';if(entry&&isConformerWorkspaceResult(entry))return true;const task=source?.ref.taskId?advancedController?.getSnapshot().tasks.find(row=>row.id===source.ref.taskId):undefined;return !!task&&(task.spec.kind==='conformer-search'||!!task.mixedSampling);}
 function currentSourceCanvas(entry:WorkspaceDocumentEntry){
  const presented=currentPesCanvas(pesCanvasesRef.current,entry)?.canvas??pagePresentations.current.get(entry.id)?.analysisCanvas;
  const trajectory=entry.trajectory&&registry.analysisAvailable(entry.id)?analysisCanvasesRef.current[entry.id]:undefined;
  return scientificSourceCanvas(activeXtbCanvasFor(entry),scientificSourceCanvas(presented,trajectory));
 }
 function scientificFrameKey(id:string){
  const entry=registry.getSnapshot().documents.find(row=>row.id===id);
  return JSON.stringify([scientificCanvasKey(entry?currentSourceCanvas(entry):undefined),advancedObservationsRef.current[id]?.ref??null]);
 }
 const installAnalysisGuard=(entry:WorkspaceDocumentEntry)=>{if(!guardedStores.current.has(entry.store)){entry.store.setScientificEditGuard?.(createWorkspaceScientificEditGuard(entry,{
  currentEntry:()=>registry.getSnapshot().documents.find(row=>row.id===entry.id),
  currentTask:taskId=>advancedIntegration.current.controller?.getSnapshot().tasks.find(row=>row.id===taskId),
  confirm:(request,current)=>{
   const stamp=registry.stamp();if(stamp.documentId!==current.id||stamp.revision!==request.revision)return false;
   if(!editChoiceInFlight.current){const intent={request,stamp,frameKey:scientificFrameKey(current.id)};pendingEditRef.current=intent;setPendingEdit(intent);}
   return false;
  }
 }));guardedStores.current.add(entry.store);}return entry;};
 const postprocess=usePostprocessWorkspace({add:(result,document,options)=>{if(!document)return registry.addResultDocument(result).id;if(!options?.structure)throw Error('后处理来源尚未完成公共成键预备。');return installAnalysisGuard(registry.addAnalysisDocument(result,options.structure,document.id,options.activate!==false,options.initialModule,options.frameBondIdentity)).id;},
  replace:(id,result,document,structure,frameBondIdentity)=>{if(protectedConformerSource(id))throw Error('构象来源保持不变；请先在普通结构标签中替换外部文件。');if(document){if(!structure)throw Error('后处理来源尚未完成公共成键预备。');registry.replaceAnalysisDocument(id,result,structure,document.id,frameBondIdentity);}else registry.replaceResultDocument(id,result);},
  attach:(id,_result,bindingId,frameBondIdentity)=>{const entry=registry.document(id);if(entry.conformerGroup)throw Error('构象来源须先复制到普通结构标签。');installAnalysisGuard(entry);const token=registry.bindExistingAnalysis(id,bindingId);if(frameBondIdentity)entry.store.bindAnalysisFrameBondOrigin?.(token,frameBondIdentity);return token;},available:registry.analysisAvailable,
  bindFrameBondOrigin:(id,bindingId,identity)=>{const entry=registry.getSnapshot().documents.find(value=>value.id===id);if(entry?.store.getSnapshot().analysisBindingId===bindingId)entry.store.bindAnalysisFrameBondOrigin?.(bindingId,identity);},
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
 async function openExternalSnapshot(taskId:string,snapshotId:string,leaseId:string,canNavigate:()=>boolean,target?:MonitorSnapshotTarget){
  const projectEpoch=projectIdentityEpoch.current,bridge=taskWorkspace.bridge;
  const stillNavigating=()=>projectEpoch===projectIdentityEpoch.current&&canNavigate();
  async function showSnapshot(id:string){
   if(!stillNavigating())return;
   const file=postprocess.captureFileDocuments()[id],frame=target?.frame;
   if(frame){
    if(file){
     const matches=file.output.source.jobs.filter(job=>'frames' in job&&resolveSnapshotMonitorFrame(job,frame)!==undefined);
     if(matches.length!==1)throw Error('固定快照里未找到监控页所选的作业和帧。');
     const jobId=matches[0].id;
     if(file.output.source.selectedJobId!==jobId){
      await postprocess.selectFileJob(id,jobId);
      if(!stillNavigating())return;
      if(postprocess.captureFileDocuments()[id]?.output.source.selectedJobId!==jobId)throw Error('固定快照的目标作业未能打开。');
     }
    }else{
     const source=postprocess.getDocument(id);
     const results=source?.output?.source.results??(source?[source.result]:[]);
     if(!results.some(result=>resolveSnapshotMonitorFrame(result,frame)!==undefined))
      throw Error('固定快照里未找到监控页所选的作业和帧。');
    }
   }
   if(!stillNavigating())return;
   taskWorkspace.leave();
   if(frame)setRequestedTaskCursors(previous=>({...previous,[id]:{id:crypto.randomUUID(),...frame}}));
   if(file){postprocess.selectFile(id);registry.invalidateActivation();}
   else {setMainDocumentId(id);activateDocument(id);}
   registry.setModule('analysis');
  }
  const prior=taskSnapshotPagesRef.current[snapshotId];
  const usable=prior?.taskId===taskId&&(!target||prior.runId===target.runId&&
   (target.runId!==null||prior.sourceSetId===target.sourceSetId&&prior.sourceVersion===target.sourceVersion));
  const priorDocument=usable?postprocess.getDocument(prior.documentId):undefined;
  const priorFile=usable?postprocess.captureFileDocuments()[prior.documentId]:undefined;
  if(prior&&(priorFile?.output.source.identity.id===prior.sourceId||
   priorDocument?.result.source.id===prior.sourceId&&registry.analysisAvailable(prior.documentId))){
   await bridge.request('snapshot.release',{snapshotId,leaseId});
   await showSnapshot(prior.documentId);
   return;
  }
  if(postprocess.isBusy()){await bridge.request('snapshot.release',{snapshotId,leaseId});throw Error('后处理正在读取来源，请完成后再打开快照。');}
  const bundle=await openSnapshotProjectSources(bridge,{snapshotId,leaseId},{consumeInitialLease:true,companions:snapshotBridgeCompanions(bridge)});
  let created:string|undefined;
  try{
   if(bundle.description.taskId!==taskId)throw Error('任务与固定快照身份不匹配。');
   if(target)assertSnapshotMonitorTarget(bundle,target);
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
     created=id;
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
    canNavigate:()=>false,
   });
   if(created)await showSnapshot(created);
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
 function fileFrameOwner(source:PostprocessScientificFileDocument){
  const projectEpoch=projectIdentityEpoch.current,known=fileObservations.current.get(source);
  if(known?.projectEpoch===projectEpoch)return known;
  const observation:PesFileObservation={epoch:crypto.randomUUID(),frame:undefined};
  const current=()=>projectIdentityEpoch.current===projectEpoch&&advancedPorts.current.postprocess.captureFileDocuments()[source.id]===source;
  const publishCursor=(frame:ObservedPostprocessFrame|null,kind?:'default')=>{if(current())publishPesFileObservation(observation,frame,kind);};
  const publishStructure=(structure:Structure|null)=>{
   if(projectIdentityEpoch.current!==projectEpoch)return;
   setFileObservedStructure(previous=>{
    if(!structure)return previous?.owner===source?null:previous;
    if(!current())return previous;
    return previous?.owner===source&&previous.structure===structure?previous:{owner:source,structure};
   });
  };
  const publishResult=(result:TrajectoryResult|null)=>{
   if(!current())return;
   setFileDisplayedResult(previous=>result&&readMcpActiveFrameTarget()===source.id
    ?previous?.owner===source&&previous.result===result?previous:{owner:source,result}
    :previous?.owner===source?null:previous);
  };
  const owner={projectEpoch,observation,publishStructure,publishCursor,publishResult};
  fileObservations.current.set(source,owner);
  return owner;
 }
 const [advancedController,setAdvancedController]=useState<AdvancedController|null>(null);
 const subscribeAdvanced=useCallback((listener:()=>void)=>advancedController?.subscribe(()=>{advancedHydrationProjection.current.observe(JSON.stringify(advancedController.getSnapshot().tasks.map(task=>[task.id,task.runs.at(-1)?.status??'',task.revision??0])));listener();})??(()=>{}),[advancedController]);
 const readAdvanced=useCallback(()=>JSON.stringify(advancedController?.getSnapshot().tasks.map(task=>[task.id,task.runs.at(-1)?.status??'',task.revision??0])??[]),[advancedController]);
 const advancedStatusProjection=useSyncExternalStore(subscribeAdvanced,readAdvanced,readAdvanced);
 const advancedGroupStatuses=useMemo(()=>new Map<string,string>(JSON.parse(advancedStatusProjection)),[advancedStatusProjection]);
 useEffect(()=>advancedController?bindWorkspaceAdvancedConsumers(registry,advancedController):undefined,[registry,advancedController]);
 useEffect(()=>{const desktop=desktopBridge(),bridge=desktop?.startXtb&&desktop.commandXtb&&desktop.onXtbEvent?{startXtb:desktop.startXtb.bind(desktop),commandXtb:desktop.commandXtb.bind(desktop),onXtbEvent:desktop.onXtbEvent.bind(desktop),readXtbElectronicArtifacts:desktop.readXtbElectronicArtifacts?.bind(desktop),releaseXtbElectronicArtifacts:desktop.releaseXtbElectronicArtifacts?.bind(desktop),releaseXtbOptimizationCaches:desktop.releaseXtbOptimizationCaches?.bind(desktop)}:null;
 const pathBridge=desktop?.startAdvancedPath&&desktop.commandAdvancedPath&&desktop.onAdvancedPathEvent?bindAdvancedPathDesktopBridge({startAdvancedPath:desktop.startAdvancedPath.bind(desktop),commandAdvancedPath:desktop.commandAdvancedPath.bind(desktop),onAdvancedPathEvent:desktop.onAdvancedPathEvent.bind(desktop)}):null;
 const samplingBridge=desktop?.startConformerSampling&&desktop.commandConformerSampling&&desktop.onConformerSamplingEvent?bindConformerSamplingDesktopBridge({startConformerSampling:desktop.startConformerSampling.bind(desktop),commandConformerSampling:desktop.commandConformerSampling.bind(desktop),onConformerSamplingEvent:desktop.onConformerSamplingEvent.bind(desktop),readConformerSamplingResult:desktop.readConformerSamplingResult?.bind(desktop),releaseConformerSamplingResult:desktop.releaseConformerSamplingResult?.bind(desktop)}):null;
 const aissBridge=desktop?.startAiss&&desktop.commandAiss&&desktop.onAissEvent?bindAissDesktopBridge({startAiss:desktop.startAiss.bind(desktop),commandAiss:desktop.commandAiss.bind(desktop),onAissEvent:desktop.onAissEvent.bind(desktop)}):null;
 const controller=new AdvancedController({bridge,pathBridge,samplingBridge,aissBridge,conformerBatchBridge:createDesktopConformerBatchBridge(desktop?.conformerBatchCommand&&desktop.onConformerBatchProgress?{conformerBatchCommand:desktop.conformerBatchCommand.bind(desktop),onConformerBatchProgress:desktop.onConformerBatchProgress.bind(desktop)}:null),resolveInitialSource:taskId=>captureConformerInitial(taskId),onConformerResultsReady:(task,onProgress)=>advancedIntegration.current.prepare(task,onProgress),resolveResources:()=>{const value=computeSnapshotRef.current;if(!value||!value.writable||value.error)throw Error('当前计算资源尚未就绪，请确认全局资源设置。');return value;},
  workerResourceBridge:desktop?.acquireWorkerResources&&desktop.cancelWorkerResources&&desktop.releaseWorkerResources?{acquireWorkerResources:desktop.acquireWorkerResources.bind(desktop),cancelWorkerResources:desktop.cancelWorkerResources.bind(desktop),releaseWorkerResources:desktop.releaseWorkerResources.bind(desktop)}:undefined,
  currentSourceGuard:source=>{if(source.ref.taskId){if(retainedAdvancedGeometrySource(controller,source))return;throw Error('该高级结果帧的任务身份或内容不匹配。');}const entry=registry.document(source.ref.documentId);if(!advancedSourceGeometryCurrent(source))throw Error('高级任务来源结构已修改或关闭，请重新取用。');if(source.ref.sourceId&&entry.analysisBinding&&!registry.analysisAvailable(entry.id))throw Error('来源分析已失效，请重新取用有效结构帧。');},
  onElectronicResult:async(bundle,context)=>{
   const source=controller.getSnapshot().tasks.find(task=>task.id===context.taskId)?.spec.source;if(!source)throw Error('单点任务来源已关闭。');
   const owner=capturedSourceOwners.current.get(JSON.stringify(source.ref)),targetId=owner?.documentId??source.ref.documentId,target=registry.document(targetId),targetEpoch=target.epoch;
   const guard=()=>{const current=registry.document(targetId);if(current.epoch!==targetEpoch||current.conformerGroup||!advancedSourceGeometryCurrent(source))throw Error('单点来源已修改或关闭，原生产物保留但未关联迟到结果。');};guard();
   const id=await advancedPorts.current.postprocess.attachGeneratedToExisting(bundle,context,targetId,guard);if(!id)throw Error('GFN2受管结果暂未接入后处理，原生产物仍保留。');
   const key=`${context.taskId}:${context.deliveryRunId??context.runId}`;advancedAnalysisDocuments.current.set(key,id);setAdvancedAnalysisBindings(previous=>({...previous,[key]:id}));
  },
 });advancedIntegration.current.controller=controller;setAdvancedController(controller);return()=>{for(const value of conformerPrepared.current.values())retirePreparationRecord(value);conformerPrepared.current.clear();void controller.dispose();};},[registry]);
 const fileCurrent=state.module==='analysis'?postprocess.currentFile:null;
 const [fileSidebarCollapsed,setFileSidebarCollapsed]=useState<Record<string,boolean>>({});
 const currentFileSidebarCollapsed=Boolean(fileCurrent&&fileSidebarCollapsed[fileCurrent.id]);
 const analysisLayout=state.module==='analysis'&&(Boolean(fileCurrent)||!active?.result||Boolean(activeId&&postprocess.documents[activeId]));
 const advancedLayout=state.module==='advanced';
 const pesLayout=advancedLayout&&advancedSection==='path';
 const activePesLink=active?.pesGroup;
 const activePesGroup=activePesLink?pes.controller?.getSnapshot().groups.find(group=>group.id===activePesLink.groupId):undefined;
 // A hidden PES tab still owns its prepared trajectory. Track actual Store
 // identities so closing a tab or restoring a project drops the previous owner.
 const openedPesStores=useRef(new WeakSet<WorkspaceDocumentEntry['store']>());
 if(active?.pesGroup&&activePesGroup&&!fileCurrent)openedPesStores.current.add(active.store);
 if(state.module==='modeling')for(const entry of state.documents)if(entry.pesGroup&&!detached[entry.id]&&(deckMode!=='single'||entry.id===activeId))openedPesStores.current.add(entry.store);
 for(const entry of state.documents)if(entry.pesGroup&&detached[entry.id])openedPesStores.current.add(entry.store);
 const retainedPesEntries=state.documents.filter(entry=>entry.pesGroup&&openedPesStores.current.has(entry.store));
 const additionalPesSources=useMemo(()=>pesLayout?[...pesTabSnapshotSources(state.documents,{
  lookup:id=>registry.getSnapshot().documents.find(entry=>entry.id===id),
  closing:id=>closingTransactions.current.has(id),
  controller:pes.controller,
  pesFrame:entry=>{
   const projected=currentPesCanvas(pesCanvasesRef.current,entry);
   if(projected?.readSubmittedFrame)return projected.readSubmittedFrame()??null;
   const prior=pesSubmittedFrames.current.get(entry.store);
   if(!prior)return undefined;
   return prior.sourceEpoch===entry.sourceEpoch&&prior.revision===entry.store.getSnapshot().revision?prior.frame:null;
  },
  conformer:entry=>{
   const trajectory=entry.trajectory!, task=advancedController?.getSnapshot().tasks.find(row=>row.id===trajectory.identity.taskId);
   if(!registry.analysisAvailable(entry.id))return;
   const canvas=analysisCanvasesRef.current[entry.id];
   const reader=canvas?.result===entry.legacyResult?canvas?.readSubmittedScientificFrame:undefined;
   const frame=reader?reader():submittedConformerInputs.current.get(entry.store);
   if(frame&&frame.result===entry.legacyResult){
    const currentFrameId=trajectory.frameIds[frame.index];
    return currentFrameId?conformerTrajectoryObservedSource({...trajectory,currentFrameId},task):undefined;
   }
   if(reader)return;
   return conformerTrajectoryObservedSource(trajectory,task);
  },
  result:entry=>{
   const selected=selectedPesTabResultCursor(analysisCanvasesRef.current[entry.id],submittedPesTabResults.current.get(entry.store),
    entry.sourceEpoch,result=>ownsPesTabResult(entry,result));
   if(selected)return selected;
   const binding=advancedPorts.current.postprocess.getDocument(entry.id);
   const result=entry.result??(registry.analysisAvailable(entry.id)?entry.legacyResult??binding?.result:undefined);
   if(!result)return;
   const retained=trajectoryFrames.current.get(entry.id);
   return {result,index:retained?.resultId===result.id?retained.frameIndex:initialScientificFrame(result)
    ??initialPlaybackFrame(result,createPlaybackCollection(result,{ownerId:entry.id}))??0};
  },
 }),...pesFileSnapshotSources(Object.values(postprocess.fileDocuments),id=>advancedPorts.current.postprocess.captureFileDocuments()[id],
  document=>fileFrameOwner(document).observation)]:[],[pesLayout,state.documents,postprocess.fileDocuments,registry,pes.controller,advancedController]);
 pesFollowAllowed.current=pesLayout&&!ownerHidden&&!taskWorkspace.opened&&!closingPending;
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
 function xtbCanvasFor(entry:WorkspaceDocumentEntry,includeSourceFallback=true){const binding=xtbWorkingBindings.current.get(entry.id);if(binding&&entry.store.getSnapshot().analysisBindingId!==binding.bindingId)return undefined;return (xtbAnalysisSelections[entry.id]&&xtbWorkingAnalysisAvailable(entry.id,xtbAnalysisSelections[entry.id]!)?analysisCanvases[xtbAnalysisSelections[entry.id]!]:undefined)??xtbAnalysisCanvases[entry.id]??(includeSourceFallback?advancedCanvases[entry.id]:undefined);}
 function activeXtbCanvasFor(entry:WorkspaceDocumentEntry){
  return workspaceActiveXtbCanvas({xtbAnalysis:xtbAnalysisLayout,documentId:entry.id,activeId},()=>xtbCanvasFor(entry,false));
 }
 function xtbUsesWorkingModel(entry:WorkspaceDocumentEntry){
  return workspaceXtbUsesWorkingModelInput(entry,advancedObservationsRef.current[entry.id])&&
   !currentPesCanvas(pesCanvasesRef.current,entry)?.observation;
 }
 function xtbSourceCanvas(entry:WorkspaceDocumentEntry){
  if(xtbUsesWorkingModel(entry))return;
  const pesSource=currentPesCanvas(pesCanvasesRef.current,entry);
  if(pesSource?.observation)return pesSource.canvas;
  return scientificSourceCanvas(entry.trajectory?analysisCanvasesRef.current[entry.id]:xtbCanvasFor(entry),
   registry.analysisAvailable(entry.id)?analysisCanvasesRef.current[entry.id]??lastScientificCanvases.current.get(entry.id):undefined);
 }
 const assertXtbTargetCurrent=useCallback((targetId:string)=>{const current=registry.getSnapshot(),view=current.views.find(value=>value.id===current.activeViewId);if(current.module!=='advanced'||advancedSectionRef.current!=='xtb2'||view?.documentId!==targetId)throw Error('当前XTB2显示对象已变化，请重新选择任务。');},[registry]);
 const publishTaskHighlights=useMemo(()=>{const targetId=activeId,ownedSource=targetId?advancedObservations[targetId]:undefined;return(value:{source:AdvancedFrameSource;atomIds:readonly string[]}|undefined)=>{
  if(!targetId||!advancedObservationPublicationCurrent(targetId,advancedDisplayOwner.current,ownedSource,advancedObservationsRef.current[targetId]))return;
  if(value&&!sameDisplaySource(value.source,advancedObservationsRef.current[targetId]))return;
  setAdvancedTaskHighlights(previous=>previous[targetId]===value?previous:{...previous,[targetId]:value});
 };},[activeId,advancedObservations]);
 const sharedLayout=((state.module==='modeling'||state.module==='input')&&!active?.result)||analysisLayout||advancedLayout||advancedModelingLayout;
 const advancedCanvases=useMemo<Record<string,AnalysisCanvas>>(()=>{
  if(!advancedLayout||pesLayout)return{};
  const canvases:Record<string,AnalysisCanvas>={};
  for(const entry of state.documents){if(entry.trajectory)continue;
   if(entry.conformerGroup?.role==='initial'&&!xtbAnalysisLayout){const task=advancedController?.getSnapshot().tasks.find(row=>row.id===entry.conformerGroup!.taskId),document=entry.store.getSnapshot(),candidate=advancedLayers[entry.id],layers=candidate?.targetId===entry.id&&advancedSourceGeometryCurrent(candidate.source)?candidate:undefined;
    if(!document.draft.structure.atoms.length)continue;
    canvases[entry.id]={document:layers?.previewStructure?{...document,draft:{...document.draft,structure:layers.previewStructure}}:document,staticDocument:document,modelEditingBlocked:Boolean(layers?.previewStructure),viewport:{displayFrozenAtomIds:workspaceCurrentSharedFrozenAtomIds(document),multiframeDisplay:layers?.multiframeDisplay,samplingSphere:layers?.samplingSphere,analysisAtomCapture:entry.id===activeId?advancedCapture:undefined},onViewReady:()=>{},onExport:()=>{},useWorkspaceImageExport:true,exportAvailable:true,exporting:false};continue;}
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
 },[advancedLayout,pesLayout,xtbAnalysisLayout,activeId,advancedObservations,registry,advancedCapture,advancedLayers,advancedTaskHighlights,state.version,advancedStatusProjection]);
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
   const freezes=task&&owned?conformerFrameProtection(task,owned,state.documents):undefined;
   values[entry.id]={...base,document,sharedFreezeDisplay:freezes?.sharedFreezeDisplay,modelEditingBlocked:base.modelEditingBlocked||Boolean(layers?.previewStructure),controls:controls?<>{base.controls}{controls}</>:base.controls,viewport:{...base.viewport,displayFrozenAtomIds:freezes?.displayFrozenAtomIds??[],analysisAtomCapture:advancedLayout&&advancedSection==='conformer'&&entry.id===activeId?advancedCapture:undefined,...layers?{samplingSphere:layers.samplingSphere}:{}}};
  }return values;
 },[state.version,analysisCanvases,advancedLayout,advancedSection,advancedLayers,conformerViewControls,activeId,advancedCapture,advancedStatusProjection]);
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
 useEffect(()=>{if(!advancedLayout||pesLayout||xtbAnalysisLayout||!activeId)return;const previous=advancedObservations[activeId],entry=registry.document(activeId);if(entry.trajectory||!entry.store.getSnapshot().draft.structure.atoms.length)return;if(entry.store.hasTransaction?.())return;if(previous&&(entry.conformerGroup?.role!=='initial'&&retainedAdvancedSource(advancedController?.getSnapshot()??{tasks:[],activeNative:null,queue:[],ignoredEvents:0,disposed:false},previous)||previous.ref.documentId===entry.id&&previous.ref.documentEpoch===entry.epoch&&previous.ref.revision===entry.store.getSnapshot().revision&&(entry.conformerGroup?.role!=='initial'||workspaceSourceGeometryKey(previous.structure)===workspaceSourceGeometryKey(entry.store.getSnapshot().draft.structure))))return;let alive=true;const serial=advancedObservationSerial.current;void captureCurrentAdvancedSource(false).then(source=>{if(alive&&serial===advancedObservationSerial.current)setAdvancedObservations(values=>({...values,[activeId]:source}));}).catch(cause=>{if(alive&&serial===advancedObservationSerial.current)setError(cause instanceof Error?cause.message:String(cause));});return()=>{alive=false;};},[advancedLayout,pesLayout,xtbAnalysisLayout,activeId,state.version]);
 const inputTask=state.inputTask,inputOwnerId=inputTask?.documentId;
 const documents=[...state.documents].sort((a,b)=>{const ai=order.indexOf(a.id),bi=order.indexOf(b.id);return(ai<0?1e9:ai)-(bi<0?1e9:bi);});
 const pendingConformerInitialEdit=Boolean(pendingEdit&&documents.find(entry=>entry.id===pendingEdit.request.documentId)?.conformerGroup?.role==='initial');
 const tabGroup=(entry:WorkspaceDocumentEntry|undefined)=>entry?.pesGroup?.groupId??entry?.conformerGroup?.taskId;
 const tabDocuments:WorkspaceDocumentEntry[]=[],tabGroupsSeen=new Set<string>();
 for(const entry of documents){if(detached[entry.id]||retiredConformerReader(entry))continue;const group=tabGroup(entry);
  if(!group){tabDocuments.push(entry);continue;}if(tabGroupsSeen.has(group))continue;tabGroupsSeen.add(group);
  tabDocuments.push(...documents.filter(value=>tabGroup(value)===group&&!detached[value.id]&&!retiredConformerReader(value)).sort((a,b)=>Number(b.conformerGroup?.role==='initial'||b.pesGroup?.kind==='initial')-Number(a.conformerGroup?.role==='initial'||a.pesGroup?.kind==='initial')||(a.conformerGroup?.role==='initial'?a.conformerGroup.initialIndex??0:0)-(b.conformerGroup?.role==='initial'?b.conformerGroup.initialIndex??0:0)));
 }
 const internalModels=documents.filter(entry=>(!entry.result||analysisLayout&&Boolean(postprocess.documents[entry.id])||advancedLayout&&entry.id===activeId)&&!detached[entry.id]);
 const displayedDocumentId=sharedLayout?(internalModels.some(entry=>entry.id===activeId)?activeId:internalModels.some(entry=>entry.id===mainDocumentId)?mainDocumentId:internalModels[0]?.id):activeId;
 const presentationOwner=useRef(displayedDocumentId);presentationOwner.current=displayedDocumentId;
 const presentationCallbacks=useRef(new Map<string,{onToolbarSurfaceChange(surface:ReactNode):void;onLegendSurfaceChange(surface:ReactNode):void}>());
 function presentationFor(id:string){let value=presentationCallbacks.current.get(id);if(!value){value={onToolbarSurfaceChange:node=>{if(presentationOwner.current===id)toolbarSurface.publish(node);},onLegendSurfaceChange:node=>{if(presentationOwner.current===id)legendSurface.publish(node);}};presentationCallbacks.current.set(id,value);}return value;}
 const documentSignature=state.documents.map(entry=>entry.id).join('|');
 useEffect(()=>{
  const entries=registry.getSnapshot().documents.filter(entry=>entry.pesGroup);
  setPesCanvases(previous=>retainPesCanvases(previous,entries));
  for(const [id,publisher] of pesCanvasPublishers.current)if(!entries.some(entry=>entry.id===id&&entry.epoch===publisher.epoch))pesCanvasPublishers.current.delete(id);
 },[registry,state.version]);
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
 function activatePesNode(groupId:string,node:PesNode){
  const owningGroup=pes.controller?.getSnapshot().groups.find(row=>row.nodes.some(item=>item.id===node.id));
  if(owningGroup)groupId=owningGroup.id;
  const entry=pes.register(groupId,node);
  inheritedNavigation.current.set(entry.id,{section:'path',sampling:null});
  const key=JSON.stringify(['workspace','workspace-page.advancedSection']);
  projectUi.set(key,{...projectUi.get<Record<string,AdvancedSection|null>>(key,{}),[entry.id]:'path'});
  pes.controller?.setActiveNode(groupId,node.id);
  activateDocument(entry.id);registry.setModule('advanced');
 }
 async function changeAdvancedSection(section:AdvancedSection|null){
  if(section!=='path'){
   advancedSectionRef.current=section;setAdvancedSection(section);setAdvancedCapture(undefined);setError('');return;
  }
  if(pesEntering.current)return;pesEntering.current=true;
  try{
   const stamp=registry.stamp(),projectEpoch=projectIdentityEpoch.current;
   await pes.ensure();
   const entry=registry.assertCurrent(stamp),controller=pes.controller;
   if(!controller||projectEpoch!==projectIdentityEpoch.current||registry.getSnapshot().module!=='advanced')throw Error('当前势能面入口已变化，请重新选择。');
   if(entry.pesGroup){advancedSectionRef.current='path';setAdvancedSection('path');controller.setActiveNode(entry.pesGroup.groupId,entry.pesGroup.nodeId);setError('');return;}
   if(entry.store.hasTransaction?.()||['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase))throw Error('请先结束当前结构运行或几何预览。');
   const model=entry.store.getSnapshot();
   const derived=Boolean(entry.result||entry.legacyResult||entry.trajectory||entry.conformerGroup||protectedConformerSource(entry.id)||
     registry.analysisAvailable(entry.id)&&(entry.analysisBinding||advancedPorts.current.postprocess.documents[entry.id])||advancedObservationsRef.current[entry.id]?.ref.taskId);
   const displayed=derived?await readCurrentWorkspaceSource(true,true):undefined;
   registry.assertCurrent(stamp);
   if(projectEpoch!==projectIdentityEpoch.current||registry.getSnapshot().module!=='advanced')throw Error('当前势能面入口已切换。');
   const geometry:PesGeometry=displayed?{documentId:entry.id,revision:displayed.ref.revision,structure:scientificFrameForModel(displayed.structure),originFrame:displayed.ref,label:entry.label}
     :{documentId:entry.id,revision:model.revision,structure:model.draft.structure,label:entry.label};
   if(geometry.structure.atoms.length&&(geometry.structure.dimension===2||geometry.structure.periodicSource?.completeness==='partial'))throw Error('势能面探索需要真实三维几何和完整的周期晶胞。');
   const group=pes.createInitialGroup(geometry,displayed?.constraints??model.sharedConstraints,derived?undefined:entry);
   const initial=group.nodes[0];
  const target=pes.register(group.id,initial);pes.projectConstraints(target,group,true);
   activatePesNode(group.id,initial);setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{pesEntering.current=false;}
 }
 function currentPesTarget(allowModeling=false){
  const stamp=registry.stamp(),entry=registry.assertCurrent(stamp),link=entry.pesGroup,controller=pes.controller;
  const module=registry.getSnapshot().module;
  const inContext=module==='advanced'&&advancedSectionRef.current==='path'||allowModeling&&
   Boolean(currentPesCanvas(pesCanvasesRef.current,entry))&&module!=='plot'&&!(module==='analysis'&&advancedPorts.current.postprocess.fileOwnerId);
  if(!link||!controller||!inContext||taskWorkspace.isOpen())throw Error('当前势能面文档已切换，请重新操作。');
  const group=controller.getSnapshot().groups.find(row=>row.id===link.groupId);
  if(!group)throw Error('当前势能面组尚未恢复。');
  return {entry,link,controller,group};
 }
 function editPesFrame(geometry:PesGeometry){
  try{
   const {entry,link,controller,group}=currentPesTarget();
   if(geometry.documentId!==entry.id||geometry.revision!==entry.store.getSnapshot().revision)throw Error('科学结构帧已变化，请重新选择。');
   const source={...geometry,structure:scientificFrameForModel(geometry.structure)};
   const target=protectedPesDocument(entry)||link.kind==='initial'&&geometry.source?.frameId
    ?pes.register(group.id,controller.createWorkbench(group.id,source)):entry;
  if(target!==entry){pes.projectConstraints(target,group,true);const node=controller.getSnapshot().groups.find(row=>row.id===group.id)!.nodes.find(row=>row.id===target.pesGroup!.nodeId)!;activatePesNode(group.id,node);}
   else if(link.kind==='workbench'){
    if(geometry.source?.frameId)entry.store.execute({type:'replace-structure',structure:structuredClone(source.structure)});
    controller.clearFrameSelection(group.id,link.nodeId);
   }

  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 async function startPesOptimization(geometry:PesGeometry,request:WorkspaceSpaceOptimizationRequest){
  const {entry,link,controller,group}=currentPesTarget(true),stamp=registry.stamp();
  if(geometry.documentId!==entry.id||request.source.id!==entry.id||request.source.revision!==entry.store.getSnapshot().revision)throw Error('优化来源帧已变化，请重新选择。');
  const source:PesGeometry=structuredClone({...geometry,structure:geometry.source?.frameId?
   scientificFrameForModel(geometry.structure):request.source.draft.structure});
  const selected=structuredClone(request.source.selection),preferences=structuredClone(request.preferences),xtbOptions=request.xtbOptions?structuredClone(request.xtbOptions):undefined;
  registry.assertCurrent(stamp);
  const node=controller.prepareOptimization(group.id,link.nodeId,source),target=pes.register(group.id,node);
  if(target!==entry){pes.projectConstraints(target,group,true);target.store.select(selected);activatePesNode(group.id,node);await new Promise<void>(resolve=>window.requestAnimationFrame(()=>resolve()));}
  const current=currentPesTarget(true);
  if(current.entry.id!==target.id||current.link.nodeId!==node.id)throw Error('优化目标已切换，本次尚未启动。');
  const snapshot=target.store.getSnapshot(),document={...request.source,id:snapshot.id,revision:snapshot.revision,selection:selected,
   sharedConstraints:resolvePesConstraintDefinitions(current.group,source.structure,source.documentId),draft:{...request.source.draft,structure:structuredClone(source.structure)}};
  return runPesOrdinaryOptimization({controller,groupId:group.id,nodeId:node.id,source:{...source,documentId:target.id,revision:snapshot.revision},document,preferences,xtbOptions,
   onRunStarted:request.onRunStarted,empiricalBondParameters:request.empiricalBondParameters,spaceKeydownAtMs:request.spaceKeydownAtMs});
 }
 async function retainWorkspaceOptimization(request:RetainedOrdinaryOptimizationRequest){
  const original=registry.document(request.source.id);
  const project=projectIdentityEpoch.current;
  const revision=request.source.revision,documentEpoch=original.epoch;
  await pes.ensure();
  const current=registry.document(original.id),controller=pes.getController();
  if(!controller||project!==projectIdentityEpoch.current||current.epoch!==documentEpoch||current.store.getSnapshot().revision!==revision)
   throw Error('优化轨迹所属项目或模型已变化，本次尚未启动。');
  const source:PesGeometry={documentId:original.id,revision,label:original.label,structure:structuredClone(request.source.draft.structure),
   originFrame:request.sourceRef??{documentId:original.id,documentEpoch,revision}};
  const group=pes.createInitialGroup(source,request.source.sharedConstraints);
  const node=group.nodes[0],owner=pes.register(group.id,node);
  const snapshot=owner.store.getSnapshot();
  const document={...request.source,id:snapshot.id,revision:snapshot.revision};
  return runPesOrdinaryOptimization({controller,groupId:group.id,nodeId:node.id,
   source:{...source,documentId:owner.id,revision:snapshot.revision},document,preferences:request.preferences,xtbOptions:request.xtbOptions,retainTrajectory:true,
   onRunStarted:request.onRunStarted,empiricalBondParameters:request.empiricalBondParameters,spaceKeydownAtMs:request.spaceKeydownAtMs});
 }
 function changePesElectronicState(values:{charge:number;multiplicity:number}){
  const {entry}=currentPesTarget();
  if(!protectedPesDocument(entry)&&!(pesCanvas?.documentId===entry.id&&pesCanvas.observation))entry.store.setElectronicState(values.charge,values.multiplicity,true);
 }
 function changePesConstraints(constraints:SharedModelConstraints){
  const {entry,group,link}=currentPesTarget();
  if(pesRunActive(group,link.nodeId)&&!protectedPesDocument(entry))throw Error('请先停止当前优化并等待结束，再修改此页的冻结定义。');
  const observed=protectedPesDocument(entry)||Boolean(pesCanvas?.documentId===entry.id&&pesCanvas.observation);
  const owner=observed?registry.getSnapshot().documents.find(row=>row.pesGroup?.groupId===group.id&&row.pesGroup.nodeId===group.initialNodeId&&!protectedPesDocument(row)):entry;
  if(!owner)return;
  if(pesRunActive(group,owner.pesGroup!.nodeId))throw Error('请先停止初始页的优化并等待结束，再修改冻结定义。');
  const result=pes.projectConstraints(owner,{...group,constraints});
  const structure=owner.store.getSnapshot().draft.structure,reference=pesConstraintReference(group,structure);
  return structure.atoms.every((atom,index)=>atom.id===reference.atoms[index]?.id)?result:constraints;
 }

 useEffect(()=>{if(pesLayout&&activePesLink&&activePesGroup?.activeNodeId!==activePesLink.nodeId&&activePesGroup)pes.controller?.setActiveNode(activePesLink.groupId,activePesLink.nodeId);},[pesLayout,activePesLink,activePesGroup?.activeNodeId,pes.controller]);
 useEffect(()=>{if(pesLayout&&!activePesLink&&!restoringProject.current&&!pesEntering.current)setAdvancedSection(null);},[pesLayout,activePesLink,setAdvancedSection]);
 function retiredConformerReader(entry:WorkspaceDocumentEntry){return entry.conformerGroup?.role==='collection'&&entry.trajectory?.identity.collectionId.endsWith(':interrupted')===true;}
 // Older projects may contain an automatically generated interrupted reader.
 // Preserve its saved data and task provenance, but retire this removed view.
 useEffect(()=>{const snapshot=registry.getSnapshot(),id=snapshot.views.find(view=>view.id===snapshot.activeViewId)?.documentId,entry=snapshot.documents.find(row=>row.id===id);if(!entry||!retiredConformerReader(entry))return;const initial=snapshot.documents.find(row=>row.conformerGroup?.taskId===entry.conformerGroup?.taskId&&row.conformerGroup?.role==='initial');if(initial)activateDocument(initial.id);},[registry,state.version,activateDocument]);
 function openConformerCollection(collection:ConformerResultCollection,frameId?:string,options?:{activate?:boolean}){
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===collection.identity.taskId);
  collection=projectConformerPlaybackCollection(collection,task);
  if(collection.playbackAvailable===false)return;
  const published=registry.getSnapshot().documents.find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===workspaceTrajectoryKey(collection.identity));
  // Hydrating a task graph must not silently reinterpret an intact saved
  // all-results reader as a different representative subset. Explicit result
  // selection still prepares and publishes the requested current collection.
  if(options?.activate===false&&published?.legacyResult&&restoredConformerReaders.current.has(published.legacyResult)&&!conformerCollectionMatchesPublished(collection,published))return;
  conformerCollectionPublisher.current.publish(collection,frameId,options,conformerPublicationPorts());
 }
 function conformerCollectionsFor(task:AdvancedTaskRecord){
  const cached=conformerCollectionCache.current.get(task);if(cached)return cached;
  const spec=task.spec,stages=restoreConformerStages(spec.kind==='conformer-search'?spec.search.stages:spec.kind==='sampling'||spec.kind==='docking'?spec.optimizationStages:[]);
  const collections=buildConformerResultCollections(task,stages).map(collection=>projectConformerPlaybackCollection(collection,task));
  conformerCollectionCache.current.set(task,collections);return collections;
 }
 function conformerFrameProtection(task:AdvancedTaskRecord,frame:AdvancedResultFrame,documents:readonly WorkspaceDocumentEntry[]){
  let current=frame;const frames=conformerPlaybackFrameIndex(task),seen=new Set<string>();
  while(!current.samplingOrigin&&!seen.has(current.id)){seen.add(current.id);const parent=current.parentRef.frameId?frames.get(current.parentRef.frameId):undefined;if(!parent)break;current=parent;}
  return conformerFrameFreezeDisplay(task,frame,current,documents);
 }
 function retirePreparationRecord(record:{result:TrajectoryResult;abort:AbortController},reserved:readonly (TrajectoryResult|undefined)[]=[]){
  const retained=[...reserved,...registry.getSnapshot().documents.flatMap(entry=>[entry.result,entry.legacyResult,entry.analysisBinding?.result])];
  void Promise.resolve(retirePreparedConformerPublication(record,retained)).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
 }
 function preparedConformerCollection(collection:ConformerResultCollection,task:AdvancedTaskRecord){
  collection=projectConformerPlaybackCollection(collection,task);
  if(collection.playbackAvailable===false)throw Error('当前归簇包含不可用代表，不能发布为完整播放集合。');
  const key=workspaceTrajectoryKey(collection.identity),old=conformerPrepared.current.get(key);
  if(old&&old.includeEnergies===collection.includeEnergies&&old.frames.length===collection.frames.length&&collection.frames.every((frame,index)=>{
   const prior=old.frames[index];return prior.id===frame.id&&prior.coordinates===frame.source.stamp.coordinatesFingerprint&&Object.is(prior.energy,frame.energyHartree);
  }))return old;
  if(old)retirePreparationRecord(old);
  const resolver=createConformerPlaybackResolver(task),reference=resolver(collection.frames[0]).referenceSource;
  const candidate=createConformerTrajectory({...collection,referenceStructure:reference?.structure??collection.frames[0].source.structure,protectedAtomIds:reference?.constraints.frozenAtomIds??[],displayRestoration:createConformerDisplayRestoration(collection.frames,collection.frames.map(frame=>resolver(frame).displayPolicy??null))});
  const existing=registry.getSnapshot().documents.find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===key);
  const result=restoredConformerPublicationResult(candidate,existing),abort=new AbortController();
  const record={frames:collection.frames.map(frame=>({id:frame.id,coordinates:frame.source.stamp.coordinatesFingerprint,energy:frame.energyHartree})),includeEnergies:collection.includeEnergies,result,abort,ready:Promise.resolve()};
  record.ready=prepareConformerPublication(result,{signal:abort.signal}).then(()=>{}).catch(cause=>{if(conformerPrepared.current.get(key)===record){conformerPrepared.current.delete(key);retirePreparationRecord(record);}throw cause;});
  conformerPrepared.current.set(key,record);return record;
 }
 async function prepareConformerTask(task:AdvancedTaskRecord,onProgress:(completed:number,total:number)=>void){
  const collections=conformerCollectionsFor(task);
  const playable=collections.filter(collection=>collection.frames.length&&collection.playbackAvailable!==false);
  const total=playable.reduce((sum,collection)=>sum+collection.frames.length,0);
  let settled=0;
  onProgress(settled,total);
  for(const collection of playable){
   const prepared=preparedConformerCollection(collection,task);
   const view=existingPreparedTrajectoryView(prepared.result)??prepareTrajectoryView(prepared.result);
   const publish=()=>onProgress(settled+view.snapshot().completed,total);
   const unsubscribe=view.subscribe(publish);
   try{publish();await prepared.ready;}
   finally{unsubscribe();view.release();}
   settled+=collection.frames.length;
   onProgress(settled,total);
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
   const record=conformerPrepared.current.get(key);if(record)retirePreparationRecord(record);conformerPrepared.current.delete(key);
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
 async function prepareRetainedConformerCollection(ref:string,signal?:AbortSignal){
  const identity=parseConformerRunCollectionRef(ref);
  if(!identity)return;
  signal?.throwIfAborted();
  const project=projectIdentityEpoch.current;
  if(pendingAdvancedProject.current)await ensurePendingAdvancedProject();
  signal?.throwIfAborted();
  if(project!==projectIdentityEpoch.current)throw Error('构象所属项目已变化。');
  const controller=advancedIntegration.current.controller;
  const task=controller?.getSnapshot().tasks.find(value=>value.id===identity.taskId),run=task?.runs.find(value=>value.id===identity.runId);
  if(!task||!run?.frames.length)throw Error('本项目中没有该次运行的可用构象帧。');
  if(['queued','running','stopping'].includes(run.status))throw Error('该运行还在生成帧，请根据运行状态选择已保留的集合。');
  const collectionId=conformerRunCollectionId(run.id);
  const collection:ConformerResultCollection={id:collectionId,identity:{taskId:task.id,runId:run.id,stageId:'retained',collectionId},
   frames:run.frames,label:`构象保留帧 · ${run.id.slice(-8)}`,includeEnergies:true};
  const prepared=preparedConformerCollection(collection,task);
  await prepared.ready;
  signal?.throwIfAborted();
  const kept=controller?.getSnapshot().tasks.find(value=>value.id===task.id)?.runs.find(value=>value.id===run.id);
  if(project!==projectIdentityEpoch.current||controller!==advancedIntegration.current.controller||kept!==run)
   throw Error('构象来源已变化，请重读所属运行。');
  const owner=installAnalysisGuard(registry.openTrajectoryDocument(prepared.result,collection.identity,run.frames.map(frame=>frame.id),false));
  return {targetId:owner.id,collectionId};
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
 function changeConformerInitialFreeze(taskId:string,source:AdvancedFrameSource,atomIds:readonly string[]):boolean{
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===taskId),current=registry.getSnapshot(),activeDocumentId=current.views.find(view=>view.id===current.activeViewId)?.documentId??null;
  return commitConformerInitialFreezes({task,documents:current.documents,activeDocumentId,source,atomIds,blocked:taskWorkspace.isOpen()||current.module!=='advanced'||advancedSectionRef.current!=='conformer'||closingTransactions.current.has(source.ref.documentId)});
 }
 function changeConformerInitialCoordinateFreeze(taskId:string,source:AdvancedFrameSource,coordinate:ConformerFreezeCoordinate,frozen:boolean,previousCoordinate?:ConformerFreezeCoordinate):boolean{
  const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===taskId),current=registry.getSnapshot(),activeDocumentId=current.views.find(view=>view.id===current.activeViewId)?.documentId??null;
  return commitConformerInitialCoordinateFreeze({task,documents:current.documents,activeDocumentId,source,coordinate,frozen,previousCoordinate,
   blocked:taskWorkspace.isOpen()||current.module!=='advanced'||advancedSectionRef.current!=='conformer'||closingTransactions.current.has(source.ref.documentId)});
 }
 function bindConformerTask(taskId:string,source:AdvancedFrameSource,sourceDocumentId?:string,activate=true){
  const task=advancedController?.getSnapshot().tasks.find(value=>value.id===taskId);
  const bound=conformerInitialDocument(task,registry.getSnapshot().documents);
  if(bound)return;
  const current=sourceDocumentId??registry.stamp().documentId;
  let entry=registry.document(current);
  // A second task gets its own initial page; the first task's page stays put.
  if(entry.conformerGroup&&entry.conformerGroup.taskId!==taskId||sourceDocumentId&&(source.ref.frameId||entry.result||entry.analysisBinding)){
   entry=registry.addFragmentDocument(advancedFrameFragment(source),'initial',activate);
   if(activate){registry.setModule('advanced');setMainDocumentId(entry.id);}
  }
  const initial=task?.mixedSampling?.initialGuesses.find(value=>value.id===task.mixedSampling?.selectedInitialGuessId);
  registry.bindConformerGroup(entry.id,taskId,'initial',initial?.id??`${taskId}-initial-1`,1);
  installAnalysisGuard(entry);
  // The bound initial page, including a copied new-search page, is the owner
  // of subsequent previews and captures. Do not retain the parent's document ref.
  const currentSource=captureConformerInitial(taskId);
  advancedController?.updateInitialSource(taskId,currentSource);
  observeAdvancedSource(entry.id,currentSource);
  setConformerGroups(previous=>previous[taskId]?previous:{...previous,[taskId]:{label:automaticStem(`sampling-${automaticStem(entry.label)}`,{occupied:Object.values(previous).map(group=>group.label)}),labelOrigin:'automatic',collapsed:false,samplingOperation:conformerSamplingChoice}});
 }
 function openConformerInitialFrame(taskId:string,initialId:string,source:AdvancedFrameSource){
  const task=advancedController?.getSnapshot().tasks.find(value=>value.id===taskId),initials=task?.mixedSampling?.initialGuesses;
  const initialIndex=(initials?.findIndex(value=>value.id===initialId)??-1)+1,initial=initials?.[initialIndex-1];
  if(!initial)return;
  source=initial.source;
  let entry=conformerInitialDocument(task,registry.getSnapshot().documents,initialId);
  if(!entry){entry=registry.addFragmentDocument(advancedFrameFragment(source),'initial');registry.bindConformerGroup(entry.id,taskId,'initial',initialId,initialIndex||undefined);}
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
  if(collection&&task&&conformerCollectionMatchesPublished(collection,entry)){
   const ownerId=JSON.stringify([entry.id,entry.epoch,projectIdentityEpoch.current]),cached=conformerPlayerCollections.current.get(entry.id);
   if(cached?.result===entry.legacyResult&&cached.collection===collection&&cached.ownerId===ownerId)playbackCollection=cached.value;
   else{
    const reference=collection.frames[0]?createConformerPlaybackResolver(task)(collection.frames[0]).referenceSource:undefined;
    playbackCollection=createAdvancedPlaybackCollection(entry.legacyResult,collection,reference,ownerId);
    conformerPlayerCollections.current.set(entry.id,{result:entry.legacyResult,collection,ownerId,value:playbackCollection});
   }
  }
  else{const cached=conformerPlayerCollections.current.get(entry.id);if(cached?.result===entry.legacyResult)playbackCollection=cached.value;}
  const order=conformerPlaybackOrder(entry,conformerFrameOrders[entry.id]);
  const visible=entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId;
  const activeHere=(analysisLayout||Boolean(trajectory&&(advancedLayout||advancedModelingLayout||state.module==='modeling'||state.module==='input')))&&visible&&
   (!ownerHidden||Boolean(detached[entry.id]))&&!taskWorkspace.opened&&!closingPending;
  return <div hidden><TrajectoryWorkspace onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} result={entry.legacyResult} modelDocument={entry.store.getSnapshot()} available={registry.analysisAvailable(entry.id)} onCanvas={canvasFor(entry.id)} toolHost={analysisToolHosts[entry.id]??null}
    canvasOnly={Boolean(trajectory)} playbackCollection={playbackCollection} selectedFrameIndex={trajectory?trajectory.frameIds.indexOf(trajectory.currentFrameId):undefined} frameOrder={order}
    onScientificFrame={trajectory?undefined:value=>trajectoryFrames.current.set(entry.id,value)}
    active={activeHere} displaySettings={displaySettings} onDisplaySettingsChange={changeDisplaySettings} onExtract={extractFrame} onPrepareIrc={entry.legacyResult.engine==='gaussian'||entry.legacyResult.engine==='orca'?structure=>prepareIrc(structure,entry.legacyResult!.engine as 'gaussian'|'orca'):undefined} onExport={exportWorkspaceResult} onError={setError}/></div>;
 }
 function inputSourceFor(entry:WorkspaceDocumentEntry){
  if(!entry.trajectory&&!protectedPesDocument(entry)&&!currentPesCanvas(pesCanvasesRef.current,entry)?.observation)
   return entry.result?undefined:registry.source(entry.id);
  const retained=submittedConformerInputs.current.get(entry.store);
  const sameFrame=retained&&entry.trajectory?.frameIds[retained.index]===entry.trajectory?.currentFrameId&&
   registry.analysisAvailable(entry.id);
  return workspaceInputFrameSource(entry,currentSourceCanvas(entry),sameFrame?retained:undefined);
 }
 function selectTaskSource(id:string){
  const pending=sourcePickLive.current;if(!pending)return;
  try{
   registry.assertInputCurrent(pending.stamp);
   const selected=inputSourceFor(registry.document(id));
   if(!selected?.structure.atoms.length)throw Error('请先显示来源标签中的完整结构帧并确认电子态。');
   pending.request.onPick(structuredClone(selected));sourcePickLive.current=null;setSourcePick(null);setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function requestTaskSource(ownerId:string,request:StructureSourcePickRequest){
  if(selectingMembers.current)throw new Error('请先确认或取消关联成员选择。');
  if(registry.getSnapshot().inputTask?.documentId!==ownerId)throw new Error('输入任务已切换，请重新选择来源。');
  const pending={ownerId,stamp:registry.inputStamp(),request};sourcePickLive.current=pending;setSourcePick(pending);setDeckMode(value=>value==='single'?'tiled':value);setError('');
 }
 async function importTaskSources(ownerId:string,files:File[]):Promise<InputStructureSource[]>{
  const stamp=registry.inputStamp();if(stamp.documentId!==ownerId)throw new Error('输入任务所属文档已切换。');
  const parsed=(await importStructureFiles(files)).map(source=>withAtomIds(editableImportedStructureElectronicState(source)));registry.assertInputCurrent(stamp);
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
  if(!id||registry.document(id).result||protectedPesDocument(registry.document(id))){setError('请先激活一个可编辑模型。');return;}
  const previous=registry.document(id);
  if(previous&&(previous.inputDirty.gaussian||previous.inputDirty.orca))setNewInputTarget(id);else startNewInputTask(id);
 }
 function navigateModule(module:WorkspaceModule){
  taskWorkspace.leave();
  if(module==='input'&&borrowedBatchRef.current){activateDocument(borrowedBatchRef.current.documentId);registry.setModule('input');return;}
  if(module==='input'&&activeId&&(active?.trajectory||active&&protectedPesDocument(active)||state.module==='advanced'&&advancedObservationsRef.current[activeId]?.ref.taskId)){
   void captureCurrentAdvancedSource().then(source=>prepareAdvancedInput(source)).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));return;
  }
  try{registry.setModule(module);setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 async function readCurrentWorkspaceSource(preferObserved=true,editingContext=false):Promise<ElectronicStateSourceContext>{
  const stamp=registry.stamp(),entry=registry.assertCurrent(stamp),snapshot=entry.store.getSnapshot();
  const xtbCurrent=editingContext&&xtbAnalysisLayout;
  const canvas=xtbCurrent?xtbSourceCanvas(entry):preferObserved||protectedPesDocument(entry)?currentSourceCanvas(entry):undefined;
  const submitted=canvas?.readSubmittedScientificFrame?.();
  const currentFrameKey=()=>xtbCurrent?xtbScientificFrameKey(entry.id):scientificFrameKey(entry.id);
  const frameKey=currentFrameKey(),sourceEpoch=entry.sourceEpoch;
  const guard=()=>{
   registry.assertCurrent(stamp);
   if(entry.sourceEpoch!==sourceEpoch||currentFrameKey()!==frameKey)throw Error('读取期间来源、阶段或当前帧已变化，请重新取用。');
  };
  function remember(source:ElectronicStateSourceContext){
   guard();
   const key=JSON.stringify(source.ref);
   capturedSourceOwners.current.set(key,{documentId:entry.id,epoch:entry.epoch});
   capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(snapshot.draft.structure));
   return source;
  }
  if(canvas?.readSubmittedScientificFrame&&!submitted)throw Error('请先显示所需的完整科学帧。');
  if(submitted&&entry.trajectory&&entry.legacyResult===submitted.result&&registry.analysisAvailable(entry.id)){
   const trajectory=entry.trajectory;
   const task=advancedIntegration.current.controller?.getSnapshot().tasks.find(row=>row.id===trajectory.identity.taskId);
   const frame=task?conformerPlaybackFrameIndex(task).get(trajectory.frameIds[submitted.index]):undefined;
   if(frame)return remember(frame.source);
  }
  const observed=advancedObservationsRef.current[entry.id];
  if(!submitted&&preferObserved&&registry.getSnapshot().module==='advanced'&&observed?.ref.taskId&&advancedController&&
   retainedAdvancedSource(advancedController.getSnapshot(),observed)&&(!advancedObservationBindings.current.get(entry.id)||
   snapshot.analysisBindingId===advancedObservationBindings.current.get(entry.id)?.bindingId))return remember(observed);

  const binding=advancedPorts.current.postprocess.documents[entry.id];
  const observingAnalysis=entry.trajectory||registry.getSnapshot().module==='analysis';
  const result=submitted?.result??canvas?.result??(xtbCurrent?undefined:entry.result??(preferObserved&&observingAnalysis&&registry.analysisAvailable(entry.id)?
   entry.legacyResult??boundAdvancedCanvasResult(binding,canvas)??binding?.result:undefined));
  const latestFrame=trajectoryFrames.current.get(entry.id);
  const frameIndex=submitted?.index??(result&&canvas?.result===result?canvas.frameIndex:
   result&&latestFrame?.resultId===result.id?latestFrame.frameIndex:result?.frames.length===1?0:undefined);
  if(result&&canvas?.scientificFrameReady===false&&!submitted)throw Error('请先显示所需的完整科学帧。');
  if(protectedPesDocument(entry)&&!canvas)throw Error('请先显示势能面来源的完整科学结构。');
  if(!submitted&&(['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase)||entry.store.hasTransaction?.()))
   throw Error('请先结束当前结构运行或几何预览，再取用完整帧。');
  const displayDocument=!result?canvas?.scientificDocument??canvas?.staticDocument:undefined;
  const document={...snapshot,
   ...(canvas?.pesConstraints?{sharedConstraints:canvas.pesConstraints}:{}),
   ...(displayDocument?{draft:{...snapshot.draft,structure:displayDocument.draft.structure}}:{})};
  const capture=editingContext?captureWorkspaceElectronicSourceContext:captureWorkspaceAdvancedSource;
  const source=await capture({document,documentEpoch:entry.epoch,label:entry.label,result,frameIndex,submitted,guard});
  return remember(source);
 }
 function captureCurrentAdvancedSource(preferObserved=true):Promise<AdvancedFrameSource>{return readCurrentWorkspaceSource(preferObserved,false);}
 function sameElectronicContext(a:ElectronicStateSourceContext,b:ElectronicStateSourceContext){return electronicDraftSourceKey(a)===electronicDraftSourceKey(b)&&JSON.stringify(a.structure)===JSON.stringify(b.structure)&&JSON.stringify(a.stamp)===JSON.stringify(b.stamp);}
 function xtbScientificFrameKey(targetId:string){
  const entry=registry.document(targetId);
  if(xtbUsesWorkingModel(entry))return JSON.stringify(['working-model-input',targetId]);
  return entry.trajectory?scientificFrameKey(targetId):JSON.stringify([scientificCanvasKey(xtbSourceCanvas(entry)),advancedObservationsRef.current[targetId]?.ref??null]);
 }
 function currentXtbScientificFrameIdentity(targetId:string){
  const entry=registry.document(targetId),document=entry.store.getSnapshot();
  return workspaceXtbScientificFrameIdentity({projectEpoch:projectIdentityEpoch.current,documentId:entry.id,documentEpoch:entry.epoch,
   sourceEpoch:entry.sourceEpoch,structure:document.draft.structure,frameKey:xtbScientificFrameKey(entry.id)});
 }
 function rememberXtbContext(context:ElectronicStateSourceContext,owner:WorkspaceActivationStamp,historical?:XtbAnalysisTaskSelection){
  const entry=registry.assertCurrent(owner);xtbElectronicLeases.current.set(electronicDraftSourceKey(context),{owner,sourceEpoch:entry.sourceEpoch,frameKey:xtbScientificFrameKey(entry.id),context:structuredClone(context),historical});
 }
 async function captureCurrentElectronicSource():Promise<ElectronicStateSourceContext>{
  if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未取用旧页面的帧。');
  const owner=registry.stamp();assertXtbTargetCurrent(owner.documentId);
  const source=await readCurrentWorkspaceSource(true,true);if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未发布旧帧。');registry.assertCurrent(owner);assertXtbTargetCurrent(owner.documentId);
  rememberXtbContext(source,owner);setXtbElectronicContexts(previous=>({...previous,[owner.documentId]:source}));return source;
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
  flushSync(()=>{child=registry.addFragmentDocument(advancedFrameFragment(actual),`${automaticStem(actual.label)}-model`);inheritedViews.current.set(child.id,pose);inheritedNavigation.current.set(child.id,{section,sampling});setMainDocumentId(child.id);registry.setModule(module);});
  return await captureCurrentAdvancedSource(false);
  }finally{sourceCopyBusy.current=false;}
 }
 const electronicOwnerStamp=registry.stamp(),xtbRenderedOwner=electronicOwnerStamp.documentId===activeId?electronicOwnerStamp:null,xtbRenderedProjectEpoch=projectIdentityEpoch.current;
 const activeXtbCanvas=active&&xtbAnalysisLayout?xtbSourceCanvas(active):undefined;
 const xtbVisibleScientificFrameReady=!active||xtbUsesWorkingModel(active)||
  (activeXtbCanvas?Boolean(scientificCanvasStructure(activeXtbCanvas,true)):
   !active.trajectory&&!active.result&&!protectedPesDocument(active));
 const xtbVisibleScientificIdentity=activeId&&xtbAnalysisLayout?currentXtbScientificFrameIdentity(activeId):undefined;
 const xtbLiveElectronicContext=useMemo<ElectronicStateSourceContext|undefined>(()=>{
  if(!active||!xtbAnalysisLayout)return;
  const document=active.store.getSnapshot();
  if(!xtbUsesWorkingModel(active)){
   const context=xtbElectronicContexts[active.id],lease=context&&xtbElectronicLeases.current.get(electronicDraftSourceKey(context));
   return lease?.sourceEpoch===active.sourceEpoch&&lease.frameKey===xtbScientificFrameKey(active.id)?context:undefined;
  }
  return {ref:{documentId:document.id,documentEpoch:active.epoch,revision:document.revision},stamp:makeDocumentStamp(document),structure:structuredClone(document.draft.structure),
   constraints:structuredClone(document.sharedConstraints??{frozenAtomIds:[],coordinates:[]}),coordinateUnit:'angstrom',label:active.label};
 },[activeId,state.version,xtbAnalysisLayout,xtbVisibleScientificIdentity,xtbElectronicContexts]);
 if(xtbLiveElectronicContext&&xtbRenderedOwner&&!xtbLiveElectronicContext.ref.sourceId&&!xtbLiveElectronicContext.ref.taskId)rememberXtbContext(xtbLiveElectronicContext,xtbRenderedOwner);
 async function prepareXtbElectronicSource(context:ElectronicStateSourceContext,draft:ElectronicStateDraft):Promise<ConfirmedElectronicSnapshot|null>{
  if(!xtbRenderedOwner)throw Error('当前没有电子态所属文档。');
  const lifetime=()=>{if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧电子态操作。');const latestDraft=xtbElectronicDraftsRef.current[draft.sourceKey];if(latestDraft&&(latestDraft.chargeText!==draft.chargeText||latestDraft.multiplicityText!==draft.multiplicityText))throw Error('电子态草稿已继续编辑，未应用较早的确认。');};lifetime();registry.assertCurrent(xtbRenderedOwner);assertXtbTargetCurrent(xtbRenderedOwner.documentId);
  const parent=registry.document(xtbRenderedOwner.documentId);
  const lease=xtbElectronicLeases.current.get(electronicDraftSourceKey(context));
  if(!lease||lease.owner.documentId!==parent.id||!sameElectronicContext(lease.context,context))throw Error('当前模型或电子态尚未核对，请重新确定。');
  const sourceCurrent=()=>{
   assertXtbTargetCurrent(parent.id);registry.assertCurrent(lease.owner);
   if(xtbScientificFrameKey(parent.id)!==lease.frameKey)throw Error('当前显示帧已变化，请重新取用电子态。');
   if(lease.historical){const task=advancedController?.getSnapshot().tasks.find(task=>task.id===lease.historical!.taskId),run=task?.runs.find(run=>run.id===lease.historical!.runId);
    if(!task||task.spec.kind!=='singlepoint'||!run||!sameElectronicContext(task.spec.source,context))throw Error('历史单点来源已关闭或更换。');
   }else if(context.ref.taskId){if(!advancedController||!retainedAdvancedSource(advancedController.getSnapshot(),context))throw Error('结果帧的任务来源已变化。');}
   else if(!context.ref.sourceId&&JSON.stringify(parent.store.getSnapshot().draft.structure)!==JSON.stringify(context.structure))throw Error('当前结构或电子态已变化，请重新取用。');
  };
  const snapshot=parent.store.getSnapshot(),copyRequired=!!lease.historical||!!context.ref.taskId||!!context.ref.sourceId||!!parent.result||!!parent.legacyResult||!!parent.analysisBinding||!!parent.trajectory||!!parent.conformerGroup||protectedPesDocument(parent)||
   Boolean(currentPesCanvas(pesCanvasesRef.current,parent)?.observation)||!!snapshot.analysisBindingId;
  if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;
  try{
   const pose=currentViewPose(parent.id),module=registry.getSnapshot().module;
   const prepared=await prepareWorkspaceElectronicSource({registry,context,draft,owner:lease.owner,sourceEpoch:lease.sourceEpoch,assertSourceCurrent:sourceCurrent,assertLifetimeCurrent:lifetime,copyRequired,
    confirmCopy:()=>confirmConformerCopy(lease.owner,'xtb-electronic-state'),
    createCopy:source=>registry.addFragmentDocument(electronicSourceEditingFragment(source),`${automaticStem(source.label)}-sp`),
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
 function assertConfirmedXtbSourceCurrent(source:AdvancedFrameSource){
  const lease=xtbElectronicLeases.current.get(electronicDraftSourceKey(source));
  if(!lease||!sameElectronicContext(lease.context,source))throw Error('当前模型尚未确定，请重新确定。');
  assertXtbTargetCurrent(lease.owner.documentId);
  const entry=registry.document(lease.owner.documentId),document=entry.store.getSnapshot();
  if(entry.epoch!==lease.owner.documentEpoch||entry.sourceEpoch!==lease.sourceEpoch||xtbScientificFrameKey(entry.id)!==lease.frameKey
   ||document.revision!==source.ref.revision||workspaceSourceGeometryKey(document.draft.structure)!==workspaceSourceGeometryKey(source.structure)
   ||document.draft.structure.charge!==source.structure.charge||document.draft.structure.multiplicity!==source.structure.multiplicity)
   throw Error('模型、来源帧或电子态已变化，请重新确定。');
 }
 function changeXtbElectronicDraft(draft:ElectronicStateDraft){
  if(!xtbRenderedOwner)return;if(projectIdentityEpoch.current!==xtbRenderedProjectEpoch)throw Error('项目来源已变化，未应用旧草稿。');registry.assertCurrent(xtbRenderedOwner);assertXtbTargetCurrent(xtbRenderedOwner.documentId);
  xtbElectronicDraftsRef.current={...xtbElectronicDraftsRef.current,[draft.sourceKey]:structuredClone(draft)};
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
 function publishMetadata(id:string){
  const adapter=ownerAdapters.current.get(id),entry=registry.getSnapshot().documents.find(value=>value.id===id);
  // The adapter owns automatic and explicit publication errors alike. Consuming
  // this promise must not also replace an unrelated workspace/task error.
  if(adapter&&entry)void adapter.publish().catch(()=>{});
 }
 function ensureOwnerAdapter(entry:WorkspaceDocumentEntry){
   const existing=ownerAdapters.current.get(entry.id);if(existing)return existing;
   if(!hostBridge||entry.result)return undefined;
   const adapter=createWorkspaceOwnerAdapter({
    bridge:hostBridge,documentId:entry.id,documentEpoch:entry.epoch,
    nextSnapshot:()=>{const snapshot=registry.nextPublication(entry.id),viewport=viewportStates.current.get(entry.id),display=displaySources.current.get(entry.id)?.descriptor;return viewport?{...snapshot,viewport:{...viewport,...display?{displayProjection:display}:{}}}:snapshot;},
    currentRevision:()=>entry.store.getSnapshot().revision,
    subscribe:entry.store.subscribe,
    onCommand:async(command,revision,requesterWindowId)=>{
     if(closingTransactions.current.has(entry.id))throw new Error('文档正在关闭。');
     const currentViewport=viewportStates.current.get(entry.id),projectionSerial=displaySources.current.get(entry.id)?.descriptor.projectionSerial;
     assertPesWorkspaceCommandAllowed(entry,command,{frameBondEditing:currentViewport?.frameBondEditing,projectionSerial,selection:currentViewport?.editingDocument?.selection??entry.store.getSnapshot().selection});
     if(command.type==='workspace.viewport-event'){
      if(entry.store.getSnapshot().revision!==revision&&!isCurrentDocumentSaveIntent(command))throw new Error('模型已变化，外部操作未重放。');
      const event=command.event as unknown as WorkspaceViewportEvent;
      const target=event.frameBondTarget,frameEditing=currentViewport?.frameBondEditing;
      if(target&&(!frameEditing||target.frameKey!==frameEditing.frameKey||target.projectionSerial!==projectionSerial))throw Error('显示帧已变化，本次操作未应用，请在当前帧重新操作。');
      if(frameEditing&&isFrameBondViewportEdit(event)&&(!target||frameEditing.blocked))throw Error('当前帧尚未就绪或仍在播放，本次显示键编辑未应用。');
      if(event.type==='cip-used'){
       const currentEntry=()=>registry.getSnapshot().documents.find(row=>row.id===entry.id);
       const source=displaySources.current.get(entry.id),sourceEpoch=entry.sourceEpoch,projectEpoch=projectIdentityEpoch.current;
       const current=()=>currentEntry()?.epoch===entry.epoch&&event.documentEpoch===entry.epoch&&entry.sourceEpoch===sourceEpoch&&projectIdentityEpoch.current===projectEpoch
        &&requesterWindowId===detachedPlacement.current[entry.id]&&!closingTransactions.current.has(entry.id)
        &&entry.store.getSnapshot().revision===revision&&(displaySources.current.get(entry.id)?.descriptor.projectionSerial??null)===event.projectionSerial
        &&displaySources.current.get(entry.id)===source;
       if(!current())throw Error('CIP引用回执的独立窗口、来源或帧已变化。');
       const observed=source?.projection.displayDocument?.document??entry.store.getSnapshot();
       const cip=projectedCipStructure(observed,source?.projection.cipGraph);
       const scientific=cip?{...observed,draft:{...observed.draft,structure:cip}}:observed;
       if(cip===null||!await cipReceiptSourceMatches(event.receipt,scientific)||!current())throw Error('CIP引用回执与当前完整几何不一致。');
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
      const detachedFrameAction=isDetachedFrameAction(event);
      const assertDetached=()=>{
       if(!detachedFrameAction)return;
       if(!requesterWindowId||requesterWindowId!==detachedPlacement.current[entry.id]||
        registry.getSnapshot().documents.find(row=>row.id===entry.id)?.epoch!==entry.epoch)
        throw Error('独立窗口已与当前模型解除关联。');
       const descriptor=displaySources.current.get(entry.id)?.descriptor;
       assertDetachedFrameTarget({documentId:entry.id,documentEpoch:entry.epoch,revision:entry.store.getSnapshot().revision,
        projectionSerial:descriptor?.projectionSerial??null,exportSourceIdentity:descriptor?.exportSourceIdentity,
        renderIdentity:descriptor?.renderIdentity},event);
      };
      assertDetached();
      if(detachedFrameAction){
       if(registry.stamp().documentId!==entry.id)activateDocument(entry.id,true);
      }else activateDocument(entry.id,true);
      assertDetached();
      const controller=viewportControllers.current.get(entry.id);if(!controller)throw new Error('模型工具尚未连接。');
      await controller.dispatch(event,detachedFrameAction?{detached:true}:undefined);return;
     }
     adapter.setPublicationOperation(`command:${crypto.randomUUID()}`);
     await applyWorkspaceOwnerCommand(entry.store,command,revision,runtimeOwners.current.get(entry.id)?.controller,registry);
    }
   });
   ownerAdapters.current.set(entry.id,adapter);refreshOwnerAdapters(value=>value+1);void adapter.ready.catch(()=>{});return adapter;
 }
 useEffect(()=>{
  if(!hostBridge)return;
  for(const value of registry.getSnapshot().documents)ensureOwnerAdapter(registry.document(value.id));
 },[registry,documentSignature,hostBridge,activateDocument]);
 function authFor(id:string){const membership=ownerAdapters.current.get(id)?.getState().membership;if(!membership)throw new Error('文档尚未连接，请稍后重试。');return {documentId:id,membershipNonce:membership.membershipNonce};}
 async function resolveScientificEdit(choice:'current'|'copy'|'cancel'){
  const intent=pendingEditRef.current;if(!intent||editChoiceInFlight.current)return;
  const entry=registry.getSnapshot().documents.find(value=>value.id===intent.request.documentId);
  if(choice==='cancel'||!entry){entry?.store.resolvePendingScientificEdit?.('cancel');pendingEditRef.current=null;setPendingEdit(null);setPendingEditError('');return;}
  editChoiceInFlight.current=true;setEditChoiceBusy(true);setPendingEditError('');
  let child:WorkspaceDocumentEntry|undefined,opened=false,keepPending=false;
  try{
   registry.assertCurrent(intent.stamp);
   if(!intent.request.resultSource&&scientificFrameKey(entry.id)!==intent.frameKey)throw Error('当前观察帧已切换，未执行旧的编辑。');
   if(!entry.store.getPendingScientificEdit?.())throw Error('本次编辑尚未形成有效操作，请重新操作。');
   if(choice==='current'){if(protectedConformerSource(entry.id))throw Error('构象来源只允许在新标签页继续；原始帧未修改。');entry.store.resolvePendingScientificEdit?.('current');}
   else{
    const pose=currentViewPose(entry.id);
    flushSync(()=>{child=registry.copyForModeling(intent.stamp,{acceptPendingEdit:true});inheritedViews.current.set(child.id,pose);});
    activateDocument(child!.id);registry.setModule('modeling');opened=true;
    const adapter=ensureOwnerAdapter(child!);if(adapter){await adapter.ready;await adapter.flush();}
   }
   setError('');
  }catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   keepPending=!opened&&Boolean(entry.store.getPendingScientificEdit?.());
   if(keepPending){setPendingEditError(message);const next={...intent};pendingEditRef.current=next;setPendingEdit(next);}else setError(message);
  }finally{editChoiceInFlight.current=false;setEditChoiceBusy(false);if(!keepPending){pendingEditRef.current=null;setPendingEdit(null);}}
 }
 useEffect(()=>{
  if(pendingEdit?.request.resultSource&&pendingEdit.request.documentId===activeId&&!editChoiceInFlight.current){
   const stamp=registry.stamp();if(stamp.documentId===activeId&&stamp.revision===pendingEdit.request.revision&&stamp.activationEpoch!==pendingEdit.stamp.activationEpoch){const intent={...pendingEdit,stamp};pendingEditRef.current=intent;setPendingEdit(intent);}return;
  }
  if(pendingEdit||editChoiceInFlight.current||!activeId)return;
  const entry=registry.document(activeId),request=entry.store.getPendingScientificEdit?.();
  if(!request?.resultSource||request.documentId!==activeId||request.revision!==entry.store.getSnapshot().revision)return;
  const intent={request,stamp:registry.stamp(),frameKey:scientificFrameKey(activeId)};pendingEditRef.current=intent;setPendingEdit(intent);
 },[activeId,state.version,pendingEdit,registry]);
 useEffect(()=>{
  if(!pendingEdit||pendingEdit.request.documentId!==activeId||!detachedPlacement.current[pendingEdit.request.documentId]||!hostBridge?.confirmWorkspaceScientificEdit||nativeEditPrompt.current===pendingEdit)return;
  nativeEditPrompt.current=pendingEdit;
  void hostBridge.confirmWorkspaceScientificEdit({...authFor(pendingEdit.request.documentId),expectedRevision:pendingEdit.request.revision,copyOnly:protectedConformerSource(pendingEdit.request.documentId),...(pendingEditError?{problem:pendingEditError.slice(0,2048)}:{})})
   .then(answer=>{if(pendingEditRef.current===pendingEdit)void resolveScientificEdit(answer.decision);})
   .catch(cause=>{setError(cause instanceof Error?cause.message:String(cause));if(pendingEditRef.current===pendingEdit)void resolveScientificEdit('cancel');});
 },[pendingEdit,hostBridge,activeId,pendingEditError]);
 function retireConformerPreparation(entry:WorkspaceDocumentEntry,discardCollection=false){
  if(!entry.trajectory)return;
  const key=workspaceTrajectoryKey(entry.trajectory.identity),record=conformerPrepared.current.get(key);
  if(!record||!discardCollection&&record.result!==entry.legacyResult&&record.result!==entry.result)return;
  // A replacement may already own a new reader for this collection. Ordinary
  // retirement only removes this exact reader; explicit discard retires both.
  retirePreparationRecord(record,[entry.legacyResult,entry.result]);conformerPrepared.current.delete(key);
 }
 function retireDocumentPresentation(entry:WorkspaceDocumentEntry){
  const id=entry.id;
  retireConformerPreparation(entry);
  if(linkedControls.linked?.documentIds.includes(id))linkedControls.clear();
  setAdvancedObservations(previous=>{const next={...previous};delete next[id];return next;});lastScientificCanvases.current.delete(id);trajectoryFrames.current.delete(id);
  setAdvancedLayers(previous=>{const next={...previous};delete next[id];return next;});
  setAnalysisCanvases(previous=>{const next={...previous};delete next[id];return next;});
  activeResultCallbacks.current.delete(id);setActiveAnalysisResults(previous=>{const next={...previous};delete next[id];return next;});
  setConformerViewControls(previous=>{const next={...previous};delete next[id];return next;});
  setConformerFrameOrders(previous=>{const next={...previous};delete next[id];return next;});
  conformerPlayerCollections.current.delete(id);advancedObservationBindings.current.delete(id);
  setAdvancedTaskHighlights(previous=>{const next={...previous};delete next[id];return next;});
  pagePresentations.current.delete(id);
  setRequestedTaskCursors(previous=>{if(!previous[id])return previous;const next={...previous};delete next[id];return next;});
  pageScroll.current.forEach((_value,key)=>{if(key.startsWith('['+JSON.stringify(id)+','))pageScroll.current.delete(key);});
  setStructureAnalysisSelected(previous=>{const next={...previous};delete next[id];return next;});
  runtimeOwners.current.get(id)?.unsubscribe();runtimeOwners.current.delete(id);
  ownerAdapters.current.get(id)?.dispose();ownerAdapters.current.delete(id);viewportStates.current.delete(id);viewportControllers.current.delete(id);modelImageCaptures.current.delete(id);inputControllers.current.delete(id);
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
  const additionalDocumentIds=wholeTask?registry.getSnapshot().documents.filter(document=>entry.pesGroup?document.pesGroup?.groupId===entry.pesGroup.groupId:taskId&&(document.conformerGroup?.taskId===taskId||document.trajectory?.identity.taskId===taskId)).map(document=>document.id):[];
  const impact=planWorkspaceDiscard(registry,id,{conformerPlan,dataOwners,additionalDocumentIds});
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
 async function executeDiscard(impact:WorkspaceDiscardImpact):Promise<TabCloseReceipt>{
  if(impact.documents.some(row=>closingTransactions.current.has(row.id)))return {status:'blocked',removed:[],error:'工作区已经在关闭指定模型。'};
  for(const row of impact.documents)closingTransactions.current.add(row.id);
  setClosingPendingIds(previous=>[...new Set([...previous,...impact.registryPlan.documentIds])]);
  let execution:WorkspaceDiscardExecution|undefined;const runtimeCloses:Awaited<ReturnType<typeof prepareDocumentRuntimeClose>>[]=[];
  const key=JSON.stringify(impact.documents.map(row=>[row.id,row.epoch]));
  try{
   execution=await prepareWorkspaceDiscard(impact,{registry,assertOwners:assertDiscardOwners,
    assertConformer:plan=>advancedController!.assertDiscardConformer(plan as AdvancedDiscardConformerPlan),
    prepareConformer:plan=>advancedController!.prepareDiscardConformer(plan as AdvancedDiscardConformerPlan),
    prepareOwners:async value=>{
     const entries=value.documents.map(row=>registry.document(row.id));
     await Promise.all(entries.map(entry=>ownerAdapters.current.get(entry.id)?.flush()));
     assertDiscardOwners(value);
     for(const entry of entries)runtimeCloses.push(await prepareDocumentRuntimeClose(entry.id));
     // Native authorizations belong to the still-live adapters. Capture them
     // now; release must never query a registry entry removed by commit.
     const native=entries.map(entry=>({id:entry.id,requestId:closeRequests.current.get(entry.id)?.requestId,auth:hostBridge&&ownerAdapters.current.has(entry.id)?authFor(entry.id):undefined,done:false,importDone:false,sourceIds:[...discardSourceIds(entry.id)]}));
     const pp=advancedPorts.current.postprocess;
     const retainedSources=[...new Set(registry.getSnapshot().documents.filter(entry=>!value.registryPlan.documentIds.includes(entry.id)).flatMap(entry=>[...discardSourceIds(entry.id)]))];
     const analysis=prepareAnalysisDocumentClose(entries.map(entry=>entry.id),[...new Set(native.flatMap(row=>row.sourceIds))],retainedSources),sources=entries.map(entry=>pp.prepareClose(entry.id));
     return [{ownerId:'document-runtime-owners',commit(){},release:async()=>{for(const prepared of runtimeCloses)prepared.commit();}},{ownerId:'workspace-analysis-and-sources',
      assertCurrent:()=>{analysis.assertCurrent?.();for(const source of sources)source.assertCurrent?.();},
      commit:()=>{analysis.commit();for(const source of sources)source.commit();},
      release:async()=>{await analysis.release();const settled=await Promise.allSettled(sources.map(source=>source.release())),failures=settled.filter((row):row is PromiseRejectedResult=>row.status==='rejected');if(failures.length)throw new AggregateError(failures.map(row=>row.reason),'部分分析来源仍待释放。');},
     },{ownerId:'workspace-presentations',
      assertCurrent:()=>{for(const row of native)if(closeRequests.current.get(row.id)?.requestId!==row.requestId)throw Error('文档关闭请求已变化，请重新确认。');},
      commit:()=>{
       for(const entry of entries){if(entry.trajectory){conformerCollectionPublisher.current.discard(entry.trajectory.identity,conformerPublicationPorts());retireConformerPreparation(entry,true);}retireDocumentPresentation(entry);closeRequests.current.delete(entry.id);}
       const taskId=value.conformerPlan?.taskId;
       if(taskId&&!advancedController!.getSnapshot().tasks.some(task=>task.id===taskId)){releaseMixedConformerPageCache(advancedController!,taskId);for(const [key,value]of conformerPrepared.current)if((value.result as ReturnType<typeof createConformerTrajectory>).identity.taskId===taskId){retirePreparationRecord(value);conformerPrepared.current.delete(key);}setConformerGroups(previous=>{const next={...previous};delete next[taskId];return next;});}
      },
      release:async()=>{
       const liveSources=[...new Set(registry.getSnapshot().documents.flatMap(entry=>[...discardSourceIds(entry.id)]))];
       for(const row of native){if(!row.done){if(row.auth&&hostBridge){if(row.requestId&&hostBridge.replyWorkspaceDocumentClose)await hostBridge.replyWorkspaceDocumentClose({...row.auth,requestId:row.requestId,status:'closed'});else await hostBridge.closeWorkspaceDocument(row.auth);}row.done=true;}if(!row.importDone){await forgetImportedModelSources(row.id);forgetAnalysisProjectDocument(row.id,row.sourceIds,liveSources);row.importDone=true;}}
      },
     }];
    },
   });
   execution.commit();
   pendingDiscards.current.set(key,{execution,label:impact.documents.map(row=>row.label).join('、')});setDiscardCleanupRevision(value=>value+1);
   if(discardImpactRef.current===impact){discardImpactRef.current=null;setDiscardImpact(null);setClosing(null);}
   if(!registry.getSnapshot().documents.length)registry.addDocument();
   await releaseDiscard(key);setError('');
   return {status:'released',removed:[...impact.registryPlan.documentIds]};
  }catch(cause){
   const error=cause instanceof Error?cause.message:String(cause),phase=execution?.status().phase;
   setError(error);
   if(!execution||phase==='prepared'){for(const prepared of runtimeCloses)prepared.cancel();for(const row of impact.documents)await cancelClose(row.id);}
   else if(phase==='commit-failed'){for(const prepared of runtimeCloses){if(registry.getSnapshot().documents.some(entry=>entry.id===prepared.documentId&&entry.epoch===prepared.documentEpoch))prepared.cancel();else prepared.commit();}pendingDiscards.current.set(key,{execution,label:impact.documents.map(row=>row.label).join('、')});setDiscardCleanupRevision(value=>value+1);}
   const live=registry.getSnapshot().documents;
   return {status:phase==='cleanup-pending'?'cleanup-pending':phase==='commit-failed'?'failed':'blocked',
    removed:impact.documents.filter(row=>!live.some(entry=>entry.id===row.id&&entry.epoch===row.epoch)).map(row=>row.id),error,
    ...(phase==='cleanup-pending'?{cleanupKey:key}:{})};
  }
  finally{for(const row of impact.documents)closingTransactions.current.delete(row.id);setClosingPendingIds(previous=>previous.filter(id=>!impact.registryPlan.documentIds.includes(id)));}
 }
 async function executeMcpDiscard(impact:WorkspaceDiscardImpact):Promise<TabCloseReceipt>{
  if(impact.documents.some(row=>closeRequests.current.has(row.id)||mcpCloseStaging.current.has(row.id)))throw Error('关闭范围内已有尚未完成的原生关闭请求。');
  const stage=impact.documents.filter(row=>detachedPlacement.current[row.id]);
  if(!stage.length)return executeDiscard(impact);
  if(!hostBridge?.requestWorkspaceDocumentClose)throw Error('当前窗口没有独立模型关闭回执。');
  const requests:Promise<{status:'closed'|'cancelled'}>[]=[];
  const own=new Map<string,()=>void>();
  try{
   for(const row of stage){
    if(closeRequests.current.has(row.id)||mcpCloseStaging.current.has(row.id))throw Error('独立模型已经有关闭请求。');
    let accept!:()=>void;const pending=new Promise<void>(resolve=>{accept=resolve;});
    own.set(row.id,accept);mcpCloseStaging.current.set(row.id,accept);
    const request=hostBridge.requestWorkspaceDocumentClose(authFor(row.id));requests.push(request);void request.catch(()=>{});
    await Promise.race([pending,request.then(()=>{throw Error('独立模型的关闭请求已提前结束。');})]);
   }
   const receipt=await executeDiscard(impact);
   if(receipt.status==='released'){
    const results=await Promise.allSettled(requests);
    const failed=results.find(row=>row.status==='rejected'||row.value.status!=='closed');
    if(failed)return {...receipt,status:'failed',error:failed.status==='rejected'?String(failed.reason):'独立窗口关闭未收到完成回执。'};
   }
   return receipt;
  }catch(error){
   for(const [id]of own)if(closeRequests.current.has(id))await cancelClose(id);
   throw error;
  }finally{
   for(const [id,handler]of own)if(mcpCloseStaging.current.get(id)===handler)mcpCloseStaging.current.delete(id);
  }
 }
 function guardClose(id:string,discard=false){
  const entry=registry.document(id);
  if(documentRuntimeOwners.current.get(id)?.owner.isBusy()||viewportControllers.current.get(id)?.isBusy()||inputControllers.current.get(id)?.isBusy())throw new Error('文档仍有运行中的计算或文件任务，请先停止并取得结束回执。');
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
 async function close(id:string,discard=false,commitClose?:()=>Promise<void>){
  if(closingTransactions.current.has(id))return;closingTransactions.current.add(id);setClosingPendingIds(previous=>[...previous,id]);registry.invalidateActivation();
  let closingOwner:Pick<WorkspaceDocumentEntry,'id'|'epoch'>|undefined,runtimeClose:Awaited<ReturnType<typeof prepareDocumentRuntimeClose>>|undefined;
  try{
   const entry=registry.document(id);
   closingOwner={id:entry.id,epoch:entry.epoch};
   guardClose(id,discard);const adapter=ownerAdapters.current.get(id);if(adapter)await adapter.flush();guardClose(id,discard);
   runtimeClose=await prepareDocumentRuntimeClose(id);
   const requestId=closeRequests.current.get(id)?.requestId;
   if(requestId&&hostBridge?.replyWorkspaceDocumentClose)await hostBridge.replyWorkspaceDocumentClose({...authFor(id),requestId,status:'closed'});
   else if(adapter&&hostBridge)await hostBridge.closeWorkspaceDocument(authFor(id));
   const closeWarnings=await postprocess.close(id);if(commitClose)await commitClose();else await registry.closeDocument(id,discard);runtimeClose.commit();
   retireDocumentPresentation(entry);closeRequests.current.delete(id);await forgetImportedModelSources(id);forgetAnalysisProjectDocument(id);
   if(!registry.getSnapshot().documents.length)registry.addDocument();setCloseConfirmIds(previous=>previous.filter(value=>value!==id));setError(closeWarnings.length?`分析已关闭；释放提示：${closeWarnings.join('；')}`:'');
  }catch(cause){if(registry.getSnapshot().documents.some(entry=>entry.id===id))runtimeClose?.cancel();else runtimeClose?.commit();setError(String(cause instanceof Error?cause.message:cause));await cancelClose(id);}
  finally{
   closingTransactions.current.delete(id);setClosingPendingIds(previous=>previous.filter(value=>value!==id));
   if(closingOwner){
    if(registry.getSnapshot().documents.some(entry=>entry.id===closingOwner!.id&&entry.epoch===closingOwner!.epoch))conformerCollectionPublisher.current.aborted(closingOwner);
    else conformerCollectionPublisher.current.released(closingOwner,conformerPublicationPorts());
   }
  }
 }
 async function askClose(id:string){
  if(registry.document(id).pesGroup){requestClose(id);return;}
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
  const entry=registry.document(id);
  if(entry.pesGroup){setPesClosing({groupId:entry.pesGroup.groupId,nodeId:entry.pesGroup.kind==='initial'?undefined:entry.pesGroup.nodeId,label:entry.label,requesterDocumentId:closeRequests.current.has(id)?id:undefined});return;}
  if(borrowedBatchRef.current?.documentId===id){setCancelBatchConfirm(true);return;}
  if(hostBridge?.requestWorkspaceDocumentClose&&!registry.document(id).result){void hostBridge.requestWorkspaceDocumentClose(authFor(id)).catch(cause=>setError(String(cause instanceof Error?cause.message:cause)));}
  else askClose(id);
 }
 async function retirePesTabs(target:NonNullable<typeof pesClosing>,commit=executeDiscard,check?:()=>void):Promise<TabCloseReceipt>{
  const controller=pes.controller;if(!controller)throw Error('势能面任务所有者尚未就绪。');
  await pes.ensure();check?.();
  const entries=registry.getSnapshot().documents.filter(entry=>matchesPesDocumentRemoval(entry.pesGroup,target));
  if(!entries.length)throw Error('势能面标签已变化，请重新选择。');
  for(const entry of entries)guardClose(entry.id,true);
  await settlePesWorkspaceRuns(controller,target.groupId,target.nodeId);
  const impact=await buildDiscardImpact(entries[0].id,!target.nodeId);
  let receipt:TabCloseReceipt|undefined;
  try{
   await pes.removeDocuments(target,async()=>{
    receipt=await commit(impact);
    if(registry.getSnapshot().documents.some(entry=>matchesPesDocumentRemoval(entry.pesGroup,target)))throw Error(receipt.error??'势能面标签仍在工作区，任务记录已保留。');
    if(target.nodeId)await controller.removeNode(target.groupId,target.nodeId);else await controller.removeGroup(target.groupId);
   });
  }catch(cause){if(!receipt)throw cause;return {...receipt,status:'failed',error:cause instanceof Error?cause.message:String(cause)};}
  if(!target.nodeId)setCollapsedPesGroups(previous=>{const next={...previous};delete next[target.groupId];return next;});
  return receipt??{status:'blocked',removed:[],error:'没有取得势能面关闭回执。'};
 }
 async function confirmPesClose(){
  const target=pesClosing;
  if(!target||pesDeleting)return;
  setPesDeleting(true);
  try{const receipt=await retirePesTabs(target);if(receipt.error)setError(receipt.error);if(receipt.removed.length)setPesClosing(null);}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setPesDeleting(false);}
 }
 function cancelPesClose(){
  if(pesDeleting)return;
  const id=pesClosing?.requesterDocumentId;setPesClosing(null);
  if(id)void cancelClose(id);
 }
 useEffect(()=>hostBridge?.onWorkspaceDocumentEvent(event=>{
  if(event.kind==='placement'){const placement={...detachedPlacement.current};if(event.detachedWindowId)placement[event.documentId]=event.detachedWindowId;else delete placement[event.documentId];detachedPlacement.current=placement;if(event.detachedWindowId===null){displayOwners.current.get(event.documentId)?.close();displayOwners.current.delete(event.documentId);}setDetached(previous=>{const next={...previous};if(event.detachedWindowId)next[event.documentId]=event.detachedWindowId;else delete next[event.documentId];return next;});if(event.detachedWindowId===null)activateDocument(event.documentId);}
  else if(event.kind==='activate-document')activateDocument(event.documentId,true);
  else if(event.kind==='close-request'){
   closeRequests.current.set(event.documentId,{requestId:event.requestId,requesterWindowId:event.requesterWindowId});
   const staged=mcpCloseStaging.current.get(event.documentId);
   if(staged)staged();else askClose(event.documentId);
  }
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
     const meaningful=registry.getSnapshot().documents.some(entry=>entry.store.getSnapshot().draft.dirty||entry.inputDirty.gaussian||entry.inputDirty.orca||Boolean(entry.conformerGroup)||Boolean(entry.pesGroup)||Boolean(entry.legacyResult))||Object.keys(advancedPorts.current.postprocess.documents).length>0||Object.keys(advancedPorts.current.postprocess.fileDocuments).length>0||projectInfo.current.dirty;
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
 const sourceSignature=JSON.stringify(state.documents.map(entry=>[entry.id,entry.epoch,entry.sourceEpoch,entry.label,entry.electronicStateConfirmed,entry.pesGroup?.kind]));
 const ordinaryInputSources=useMemo(()=>{
  return state.documents.filter(entry=>!entry.result&&!entry.trajectory&&!protectedPesDocument(entry)&&
   entry.store.getSnapshot().draft.structure.atoms.length>0).map(entry=>registry.source(entry.id));
 },[registry,sourceSignature]);
 const sources=useMemo(()=>{
  if(state.module!=='input')return ordinaryInputSources;
  const observationIds=new Set<string>(),observed:WorkspaceTaskSource[]=[];
  for(const entry of state.documents){
   if(!entry.trajectory&&!protectedPesDocument(entry)&&!currentPesCanvas(pesCanvases,entry)?.observation)continue;
   observationIds.add(entry.id);
   const source=inputSourceFor(entry);
   if(source)observed.push(source);
  }
  return [...ordinaryInputSources.filter(source=>!observationIds.has(source.documentId)),...observed];
 },[ordinaryInputSources,state.module,sourceSignature,analysisCanvases,pesCanvases]);
 const createDocument=useCallback(()=>{
  advancedPorts.current.postprocess.selectFile(null);registry.addDocument();setError('');
 },[registry]);
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
   setError(prepared.warnings.join('；'));
  }finally{if(libraryLoadController.current===controller)libraryLoadController.current=null;if(epoch===importEpoch.current){setReading(false);importController.current=null;}}
 }
 async function openTwoDFiles(files:ScientificSourceFile[],signal?:AbortSignal):Promise<boolean>{
  try{
   signal?.throwIfAborted();
   if(files.length!==1)throw Error('请每次导入一个二维文件或一张图片；同一图纸内的多个片段会共同导入。');
   if(twoDRuntime.current?.isBusy())throw Error('二维操作仍在运行，请先停止或等待结束。');
   const serial=++twoDLoadEpoch.current;
   const loaded=await readTwoDImportFile(files[0],signal);
   if(loaded.source){const [{parseTwoDDraft},{twoDIndigoConverter,assertTwoDEditorKet}]=await Promise.all([import('../../modeling/two-d'),import('./two-d-editor-service')]);const draft=await parseTwoDDraft(loaded.source.data,{sourceId:loaded.source.id,filename:loaded.name,indigo:twoDIndigoConverter});assertTwoDEditorKet(draft.ket);}
   signal?.throwIfAborted();if(serial!==twoDLoadEpoch.current)return false;
   if(twoDRuntime.current?.hasContent()){setTwoDVisible(true);if(!await twoDRuntime.current.confirmReplacement())return false;}
   signal?.throwIfAborted();if(serial!==twoDLoadEpoch.current||twoDRuntime.current?.isBusy())throw Error('二维载入已取消或当前操作尚未结束，旧草稿已保留。');
   twoDOrigin.current='imported';twoDFileRef.current=loaded;setTwoDFile(loaded);setTwoDVisible(true);setError('');return true;
  }catch(cause){const message=cause instanceof Error?cause.message:String(cause);if(twoDVisibleRef.current&&twoDRuntime.current)twoDRuntime.current.reportError(message,{kind:'import',sourceName:files.map(file=>file.name).join('、')||undefined});else setError(message);return false;}
 }
 async function openAssistantImage(file:File,signal:AbortSignal){
  const projectEpoch=projectIdentityEpoch.current;
  if(!await openTwoDFiles([file],signal)){signal.throwIfAborted();throw Error('二维图片载入未完成。');}
  const target=twoDFileRef.current,serial=twoDLoadEpoch.current;
  if(target?.kind!=='image')throw Error('输入文件未识别为二维结构图片。');
  for(;;){
   signal.throwIfAborted();
   if(projectIdentityEpoch.current!==projectEpoch||twoDFileRef.current!==target||serial!==twoDLoadEpoch.current)throw Error('二维来源已变化，未返回旧草稿。');
   const owner=twoDRuntime.current,state=await owner?.sketch.read();
   if(state?.status==='ready'&&state.snapshot.documentKey===target.id)return {documentId:target.id,recognition:owner?.sketch.image()};
   await new Promise<void>(resolve=>setTimeout(resolve,30));
  }
 }
 function captureTwoDGuard(request?:{modelRef?:string;revision?:number}):TwoDCommitGuard{
  const file=twoDFileRef.current,projectEpoch=projectIdentityEpoch.current,activationEpoch=registry.getSnapshot().activationEpoch;
  if(!file)throw Error('二维会话已结束。');
  const targetId=registry.stamp().documentId;
  if(request?.modelRef&&request.modelRef!==targetId)throw Error('目标模型与当前二维编辑窗口不匹配。');
  const target=(request?request.modelRef:twoDOrigin.current==='manual')?registry.document(targetId):undefined;
  if(request?.modelRef&&request.revision!==target?.store.getSnapshot().revision)throw Error('目标模型已修改，请读取最新版本。');
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
    const before=target.store.getSnapshot();target.store.execute({type:'replace-document',fragment,electronicState:'new-source'});if(target.store.getSnapshot().revision===before.revision)throw Error('三维替换未提交，二维草稿已保留。');
    commitImportedModelSourceBundle(bundle,preparedOwner,target.id);setError('');return target.id;
   }catch(cause){await forgetImportedModelSources(preparedOwner);throw cause;}finally{twoDCommitting.current=false;}
  }
  const pending=registry.prepareFragmentDocument(fragment);twoDCommitting.current=true;
  try{
   const bundle=await registerImportedModelSources([pending.id],files);
   if(!bundle)throw Error('模型的二维原始来源尚未登记。');
   guard();const created=pending.commit();
   setMainDocumentId(created.id);setError('');return created.id;
  }catch(cause){
   const cleanup:unknown[]=[];
   if(pending.state()==='prepared')pending.cancel();
   if(registry.getSnapshot().documents.some(entry=>entry.id===pending.id))try{await registry.closeDocument(pending.id,true);}catch(error){cleanup.push(error);}
   try{await forgetImportedModelSources(pending.id);}catch(error){cleanup.push(error);}
   if(cleanup.length)throw new AggregateError([cause,...cleanup],'二维提交失败，部分新建资源仍待收尾。');throw cause;
  }finally{twoDCommitting.current=false;}
 }
 const importFiles=useCallback(async(files:ScientificSourceFile[],resultChoice:'ask'|'analysis'|'structure'|'auto'='ask',
   agent?:{show:boolean;signal:AbortSignal;created(id:string):void;issues(messages:string[]):void}):Promise<void>=>{
  if(agent&&(importController.current||advancedPorts.current.postprocess.isBusy()))throw Error('当前导入尚在进行。');
  if(importResourceClosures.current.failedCount){const message='结构来源的读取资源仍待关闭，请先重试取消读取。';setError(message);if(agent)throw Error(message);return;}
  try{const candidates=await Promise.allSettled(files.map(isTwoDImportFile));if(candidates.some(value=>value.status==='fulfilled'&&value.value)){if(files.length!==1)throw Error('二维图纸或图片请单独导入，其他文件尚未处理。');const opened=await openTwoDFiles(files);if(agent){if(!opened)throw Error('二维导入取消或失败。');if(twoDFileRef.current)agent.created(twoDFileRef.current.id);if(!agent.show)setTwoDVisible(false);}return;}}catch(cause){setError(cause instanceof Error?cause.message:String(cause));if(agent)throw cause;return;}
  if(resultChoice==='analysis'||resultChoice==='ask'&&registry.getSnapshot().module==='analysis'){await postprocess.read(files,agent?null:postprocess.fileOwnerId??postprocess.ownerId,undefined,'smart',agent?{onCreated:agent.created,canNavigate:()=>agent.show,throwOnFailure:true,signal:agent.signal}:undefined);return;}
  if(resultChoice==='ask'){
   try{const descriptions:string[]=[];for(const file of files){const source=resultFile(file);try{const identity=await identifyPostprocessSource(source);if(identity.kind!=='unsupported')descriptions.push(previewImportDescription(identity.kind,new TextDecoder().decode(await source.readRange(0,Math.min(source.size,1024*1024)))));}catch{/* The selected operation reports this file's read failure without hiding independent files from the choice. */}finally{await source.close?.();}}
    if(descriptions.length){resultImportChoice.current?.('cancel');setResultImportDescriptions(descriptions);setResultImportRequest(files);const choice=await new Promise<'analysis'|'structure'|'cancel'>(resolve=>{resultImportChoice.current=resolve;});if(choice!=='cancel')await importFiles(files,choice);return;}
   }catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
  }
  importController.current?.abort();const controller=new AbortController();importController.current=controller;
  const epoch=++importEpoch.current,initial=registry.getSnapshot(),lease=initial.activeViewId?registry.stamp():null;
  const readScope={epoch,settled:false};importReadScope.current=readScope;
  const cancelAgentImport=()=>controller.abort();
  agent?.signal.addEventListener('abort',cancelAgentImport,{once:true});
  if(agent?.signal.aborted)controller.abort();
  setReading(true);setReadProgress(null);setError('');
  const guard=()=>{if(epoch!==importEpoch.current||controller.signal.aborted)throw new Error('模型导入已取消。');if(lease)registry.assertIdentityCurrent(lease);else if(registry.getSnapshot().activationEpoch!==initial.activationEpoch)throw new Error('活动上下文已变化，请重新导入。');};
  let parsed:WorkspaceImportItem[]=[],committed=false;
  const fileOnlyImports:ScientificSourceFile[]=[],fileImportProjectEpoch=projectIdentityEpoch.current;
   const sourceIssues:string[]=[];
   const sourceIssue=(file:ScientificSourceFile,cause:unknown)=>{guard();sourceIssues.push(`${file.name}：${cause instanceof Error?cause.message:String(cause)}`);};
  try{
   guard();
   if(resultChoice==='structure'){
    const ordinary:ScientificSourceFile[]=[];
    for(const file of files){const input=resultFile(file,desktop?.registerSelectedOutputSource&&desktop.closeLaunchSource?{register:desktop.registerSelectedOutputSource.bind(desktop),close:desktop.closeLaunchSource.bind(desktop),describe:desktop.describeLaunchSource?.bind(desktop)}:undefined);
     importResourceClosures.current.register(input.id,async()=>{await input.close?.();});
     try{const identity=await identifyPostprocessSource(input,{signal:controller.signal});guard();
      if(identity.kind==='unsupported'){ordinary.push(file);continue;}
      if(identity.kind==='gbw')throw new Error(identity.message??'GBW须先转换为Molden。');
      if(identity.kind==='fchk'||identity.kind==='molden'){
       const structure=await readPostprocessWavefunctionStructure(input,identity.kind,{signal:controller.signal});guard();
       parsed.push(...modelFragmentsFromStructures([structure]).map(fragment=>({kind:'model' as const,fragment})));continue;
      }
      let source;
      if(identity.kind==='gaussian-output'||identity.kind==='orca-output'){
       const scientific=await readPostprocessFileOutput(input,{signal:controller.signal});
       if(isScientificFileSource(scientific)){await scientific.dispose();guard();fileOnlyImports.push(file);continue;}
       source=scientific;
      }
      else if(identity.kind==='xyz'||identity.kind==='hess')source=await readPostprocessAuxiliary(input,{signal:controller.signal});
      else throw new Error('该辅助来源没有可独立读取的完整几何，请使用对应的主结果。');
      try{guard();const result=source.results.at(-1)!;const structure=await result.getFrame(result.frames.length-1,controller.signal);structure.notes.push(`仅载入最后完整结构；来源 ${file.name}，整体状态 ${result.status}。`);parsed.push(...modelFragmentsFromStructures([structure]).map(fragment=>({kind:'model' as const,fragment})));}
      finally{await Promise.all([...new Set(source.results)].map(result=>Promise.resolve(result.dispose())));}
      }catch(cause){sourceIssue(file,cause);}finally{try{await importResourceClosures.current.close(input.id);}catch(cause){setImportCloseFailed(true);throw cause;}}
    }
     if(ordinary.length)parsed.push(...await importWorkspaceItems(ordinary,{signal:controller.signal,onSourceError:sourceIssue}));
    }else parsed=await importWorkspaceItems(files,{signal:controller.signal,onSourceError:sourceIssue,onProgress:(done,total)=>{if(epoch===importEpoch.current)setReadProgress(total?Math.round(100*done/total):null);}});guard();
   const prepared=await prepareWorkspaceImportModels(parsed,{port:createChemistryPort(),signal:controller.signal,guard});guard();parsed=prepared.items;
   const resultWorkingStructures=new Map<import('../../results/contracts').TrajectoryResult,Structure>();
   for(const item of parsed)if(item.kind==='result'){
    const source=modelFragmentsFromStructures([item.result.initialStructure])[0];
    const working=editableImportedStructureElectronicState(periodicWorkingStructure(source.structure));
    resultWorkingStructures.set(item.result,scientificFrameForModel(working));
   }
   const importedModelIds:string[]=[];
   for(const item of parsed){
    if(item.kind==='model'){
     const entry=registry.addDocument(item.fragment.structure,undefined,item.fragment,undefined,undefined,agent?.show??true);
     importedModelIds.push(entry.id);agent?.created(entry.id);
    }else if(item.kind==='result'){
     const entry=registry.addEditableResultDocument(item.result,resultWorkingStructures.get(item.result)!,agent?.show??true);
     installAnalysisGuard(entry);agent?.created(entry.id);
    }else agent?.created(item.diagnostic.id);
   }
   if(importedModelIds.length)await registerImportedModelSources(importedModelIds,files);
   addSourceDiagnostics(parsed.flatMap(item=>item.kind==='diagnostic'?[item.diagnostic]:[]));
    committed=true;if((agent?.show??true)&&parsed.filter(item=>item.kind!=='diagnostic').at(-1)?.kind==='result')registry.setModule('analysis');
    for(const file of fileOnlyImports){
     try{await postprocess.read([file],null,undefined,'smart',{onCreated:agent?.created,canNavigate:()=>agent?.show??true,guard:()=>{if(epoch!==importEpoch.current||controller.signal.aborted||projectIdentityEpoch.current!==fileImportProjectEpoch)throw Error('来源导入上下文已变化，未接入旧文件。');},signal:controller.signal,throwOnFailure:true});}
     catch(cause){if(epoch!==importEpoch.current||controller.signal.aborted||projectIdentityEpoch.current!==fileImportProjectEpoch)throw cause;sourceIssues.push(`${file.name}：${cause instanceof Error?cause.message:String(cause)}`);}
    }
    const issues=[...sourceIssues,...prepared.warnings];agent?.issues(issues);setError(issues.join('；'));
  }catch(cause){if(epoch===importEpoch.current&&(!controller.signal.aborted||importResourceClosures.current.failedCount))setError(cause instanceof Error?cause.message:String(cause));if(agent)throw cause;}
  finally{agent?.signal.removeEventListener('abort',cancelAgentImport);if(!committed)await Promise.all(parsed.flatMap(item=>item.kind==='result'?[Promise.resolve(item.result.dispose())]:item.kind==='diagnostic'?[Promise.resolve(item.diagnostic.dispose())]:[]));readScope.settled=true;if(epoch===importEpoch.current){setReadProgress(null);if(!importResourceClosures.current.pendingCount){setReading(false);setImportCloseFailed(false);importController.current=null;}else{setReading(true);setImportCloseFailed(true);}}}
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
 async function launchOptimizationModel(source:ElectronicStateSourceContext,settings?:Omit<WorkspaceSpaceOptimizationRequest,'source'>,selection?:ModelSelection){
  if(!Number.isSafeInteger(source.structure.charge)||!Number.isSafeInteger(source.structure.multiplicity)||source.structure.multiplicity!<1)
   throw Error('请先确认所选帧的电荷与自旋多重度。');
  const fragment=electronicSourceEditingFragment(source),pose=currentViewPose();
  let created!:WorkspaceDocumentEntry;
  flushSync(()=>{
   advancedPorts.current.postprocess.selectFile(null);
   created=registry.addFragmentDocument(fragment,`${automaticStem(source.label)}-opt`);
   if(selection)created.store.select(selection);
   inheritedViews.current.set(created.id,pose);
   setMainDocumentId(created.id);registry.setModule('modeling');setError('');
  });
  const owner=registry.stamp();
  await new Promise<void>(resolve=>window.requestAnimationFrame(()=>resolve()));
  const current=registry.assertCurrent(owner);
  const controller=viewportControllers.current.get(created.id);
  if(current!==created||!controller?.preoptimize)throw Error('派生模型尚未连接优化器。');
  await controller.preoptimize(settings);
 }
 async function startObservedOptimization(id:string,request:WorkspaceSpaceOptimizationRequest){
  const owner=registry.stamp();
  if(owner.documentId!==id||request.source.id!==id||request.source.revision!==owner.revision)
   throw Error('优化来源已变化，请重新选择。');
  const {source:document,...settings}=request;
  const frame=await readCurrentWorkspaceSource(true,true);
  registry.assertCurrent(owner);
  const geometry=scientificFrameForModel(frame.structure),selected=document.draft.structure;
  if(workspaceSourceGeometryKey(geometry)!==workspaceSourceGeometryKey(selected)||
   frame.structure.charge!==selected.charge||frame.structure.multiplicity!==selected.multiplicity)
   throw Error('当前画面已切换，未启动旧帧的优化。');
  return retainWorkspaceOptimization({...settings,source:document,sourceRef:frame.ref,derivedFrame:true,presentation:'follow',
   onRunStarted:(identity,actualRequest)=>{
    if(settings.onRunStarted){settings.onRunStarted(identity,actualRequest);return;}
    if(registry.stamp().documentId!==id)return;
    const group=pes.getController()?.getSnapshot().groups.find(group=>group.id===identity.groupId);
    const node=group?.nodes.find(node=>node.id===group.runs[identity.runId]?.nodeId);
    if(node)activatePesNode(identity.groupId,node);
   }});
 }
 function withObservedOptimization(id:string,canvas:AnalysisCanvas|undefined):AnalysisCanvas|undefined{
  if(!canvas?.result||!canvas.readSubmittedScientificFrame||canvas.displayOnlySourcePreview||canvas.onOptimize)return canvas;
  const cached=observedOptimizationCanvases.current.get(canvas);
  if(cached?.id===id)return cached.canvas;
  const projected:AnalysisCanvas={...canvas,onOptimize:request=>optimizeObservedFrameRef.current(id,request)};
  observedOptimizationCanvases.current.set(canvas,{id,canvas:projected});
  return projected;
 }
 function extractFrame(structure:Structure){
  advancedPorts.current.postprocess.selectFile(null);
  const view=currentViewPose(),entry=registry.addDocument(scientificFrameForModel(structure),`${automaticStem(structure.name)}-frame`);
  inheritedViews.current.set(entry.id,view);registry.setModule('modeling');setError('');
 }
 function extractAdvancedFrame(source:AdvancedFrameSource){
  const view=currentViewPose(),fragment=advancedFrameFragment(source);
  fragment.structure=scientificFrameForModel(fragment.structure);
  const entry=registry.addFragmentDocument(fragment,`${automaticStem(source.label)}-model`);
  inheritedViews.current.set(entry.id,view);registry.setModule('modeling');setError('');
 }
 function prepareBatchInput(sources:readonly AdvancedFrameSource[],coreIds:readonly string[],activeFrameId?:string){
  try{
   if(borrowedBatchRef.current)throw Error('已有批量输入会话，请先完成或明确取消。');
   registry.assertCurrentInputTaskIdle();
   const previous=registry.getSnapshot();
   if(previous.inputTask&&inputControllers.current.get(previous.inputTask.documentId)?.isBusy())throw Error('输入正在处理，请先完成或取消当前操作。');
   const session=createBatchInputSession({sources,coreIds,activeFrameId}),source=batchInputRepresentative(session),pose=currentViewPose();
   const previousDocument=previous.documents.find(entry=>previous.views.find(view=>view.id===previous.activeViewId)?.documentId===entry.id);
   const fragment=advancedFrameFragment(source);fragment.structure=scientificFrameForModel(fragment.structure);fragment.sharedConstraints=batchInputInitialConstraints(session);fragment.coordinateObjects=[];fragment.internalCoordinates=[];
   const {entry,input}=registry.addBorrowedInputDocument(fragment,'frame');inheritedViews.current.set(entry.id,pose);
   const value:BorrowedBatch={session,documentId:entry.id,documentEpoch:entry.epoch,previousViewId:previous.activeViewId,previousModule:previous.module,previousDocumentId:previousDocument?.id,previousDocumentEpoch:previousDocument?.epoch,previousFrameId:previousDocument?.trajectory?.currentFrameId,input,camera:pose.camera};
   borrowedBatchRef.current=value;setBorrowedBatch(value);setMainDocumentId(entry.id);registry.setModule('input');setError('');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 async function finishBatchInput(sessionId:string){
  const borrowed=borrowedBatchRef.current;if(!borrowed||borrowed.session.id!==sessionId)return;
  const representative=registry.document(borrowed.documentId);
  if(representative.epoch!==borrowed.documentEpoch)throw Error('批量输入代表帧已变化，未关闭其他模型。');
  await close(borrowed.documentId,true,async()=>{
   if(borrowedBatchRef.current!==borrowed)throw Error('批量输入会话已变化，未应用旧关闭操作。');
   await registry.closeBorrowedInputDocument(borrowed.input,borrowed.documentEpoch,{viewId:borrowed.previousViewId,documentId:borrowed.previousDocumentId,documentEpoch:borrowed.previousDocumentEpoch,module:borrowed.previousModule,frameId:borrowed.previousFrameId});
  });
  if(borrowedBatchRef.current!==borrowed||registry.getSnapshot().documents.some(entry=>entry.id===borrowed.documentId&&entry.epoch===borrowed.documentEpoch))return;
  borrowedBatchRef.current=null;setBorrowedBatch(null);setCancelBatchConfirm(false);retainedUnreadableBatchAsset.current=undefined;setBatchInputRecoveryNotice(undefined);
  const snapshot=registry.getSnapshot(),view=snapshot.views.find(value=>value.id===snapshot.activeViewId),parent=snapshot.documents.find(entry=>entry.id===borrowed.previousDocumentId&&entry.epoch===borrowed.previousDocumentEpoch);
  setMainDocumentId(view?.documentId??null);
  if(parent&&view?.documentId===parent.id&&borrowed.camera)pendingCameraRestores.current.set(parent.id,{stamp:registry.stamp(),view:[...borrowed.camera]});
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
   const result=prepareAdvancedFrameInput(source,{hasDirtyInput:Boolean(old&&(old.inputDirty.gaussian||old.inputDirty.orca)),busy:Boolean(previous&&inputControllers.current.get(previous.documentId)?.isBusy()),create:fragment=>{const entry=registry.addFragmentDocument({...fragment,structure:scientificFrameForModel(fragment.structure)});inheritedViews.current.set(entry.id,pose);return entry.id;},start:startNewInputTask},confirmed);
   if(result==='confirmation-required')setAdvancedInputTarget({source,previousTaskId:previous?.id});else setAdvancedInputTarget(null);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function prepareIrc(structure:Structure,engine:'gaussian'|'orca',confirmed=false){
  try{const previous=registry.getSnapshot().inputTask,old=previous?registry.document(previous.documentId):null;
   if(borrowedBatchRef.current)throw Error('请先完成或取消当前批量输入会话。');
   if(old&&!confirmed&&(old.inputDirty.gaussian||old.inputDirty.orca)){setPreparedInputTarget({structure:structuredClone(structure),engine});return;}
   registry.assertCurrentInputTaskIdle();
   if(old&&inputControllers.current.get(old.id)?.isBusy())throw new Error('当前输入所属模型仍在处理，请先停止或完成后再从结果新建。');
   const intent=prepareIrcIntent(structure,engine),copy=structuredClone(scientificFrameForModel(structure));copy.notes.push(...intent.notices);const entry=registry.addPreparedInput(copy,intent,`${automaticStem(copy.name)}-irc`);registry.beginInputTask(entry.id);inputControllers.current.get(old?.id??'')?.cancel();setSourceRoles({});setPreparedInputTarget(null);registry.setModule('input');setError(intent.notices.join(' '));}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 function surface(entry:WorkspaceDocumentEntry):DocumentWorkspaceSurface {
  let bound=callbacks.current.get(entry.id);
  if(!bound){
   bound={entry,active:false,inputActive:false,module:'modeling',sources:[],getCurrentSources:()=>registry.getSnapshot().documents.filter(item=>!item.result&&!protectedPesDocument(item)).map(item=>registry.source(item.id)),stamp:registry.stamp,assertCurrent:registry.assertCurrent,assertIdentityCurrent:registry.assertIdentityCurrent,assertRuntimeCurrent:registry.assertRuntimeCurrent,
    inputStamp:registry.inputStamp,assertInputIdentityCurrent:registry.assertInputIdentityCurrent,
    onInputController:controller=>{if(controller)inputControllers.current.set(entry.id,controller);else inputControllers.current.delete(entry.id);},onInputHistoryChange:notifyInputHistoryChange,onNewInputTask:requestNewInputTask,
    onSubmitExternalInput:draft=>{if(registry.stamp().documentId!==entry.id)throw Error('输入所属文档已切换，请重新提交。');return taskWorkspace.submit(draft);},
    onPreparedInput:input=>{if(!registry.getSnapshot().documents.some(row=>row.id===entry.id&&row.epoch===entry.epoch))throw new Error('输入所属文档已关闭，未追加引用。');const batch=borrowedBatchRef.current,target=batch?.documentId===entry.id?batch.previousDocumentId:entry.id;if(!target||!registry.getSnapshot().documents.some(row=>row.id===target)){setBatchInputRecoveryNotice('输入文件已生成；原所属文档已关闭，本次引用未追加到其他模型。');return;}setCitationState(previous=>appendPreparedInput(previous,target,input));},
    onImportFiles:importFiles,onImportTwoDFiles:openTwoDFiles,onOpenTwoD:openTwoDManual,twoDActive:twoDVisible,onNewDocument:createDocument,onOpenStructureLibrary:()=>setStructureLibraryOpen(true),sharedLayout:false,toolHost:null,toolbarHost:null,inputHost:null,
    onToolSurfaceChange:surface=>{if(registry.stamp().documentId===entry.id)toolSurface.publish(surface);},
    onModelToolsChange:surface=>{
     if(!surface||registry.stamp().documentId===entry.id&&registry.getSnapshot().documents.some(current=>current.id===entry.id&&current.epoch===entry.epoch))modelToolsSurface.publish(modelToolsOwnerFor(entry),surface);
    },
    onLeftToolSurfaceChange:()=>{},
    onAdvancedModelingBack:()=>setAdvancedModelingRoute(route=>route?{...route,task:null}:null),
    onAdvancedModelingRouteChange:setAdvancedModelingRoute,
    onDeriveStructure:async(candidate,source)=>{const stamp=registry.stamp();if(stamp.documentId!==entry.id)throw Error('当前结构已切换，未创建派生文档。');const route=pagePresentations.current.get(entry.id)?.advancedModelingRoute,frameKey=scientificFrameKey(entry.id),sourceEpoch=entry.sourceEpoch;
     if(protectedConformerSource(entry.id)){if(sourceCopyBusy.current)throw Error('请先完成当前来源选择。');sourceCopyBusy.current=true;try{if(!await confirmConformerCopy(stamp))return;registry.assertCurrent(stamp);if(registry.document(entry.id).sourceEpoch!==sourceEpoch||scientificFrameKey(entry.id)!==frameKey)throw Error('来源帧已变化，未应用过期变换。');}finally{sourceCopyBusy.current=false;}}
     const child=registry.deriveDocument(stamp,candidate,undefined,source);if(route)derivedModelingRoutes.current.set(child.id,{category:route.category,task:null});setMainDocumentId(child.id);setError('');},
    onWorkspaceHistory:kind=>{if(viewportControllers.current.get(entry.id)?.isBusy()&&!entry.store.isRuntimeEditingAllowed?.())throw Error('当前文档仍在计算或保存，请结束后再撤销。');if(registry.getSnapshot().module==='input'&&inputControllers.current.get(entry.id)?.history?.(kind))return true;return registry[kind](entry.id);},
    ...presentationFor(entry.id),
    onRequestSourcePick:request=>requestTaskSource(entry.id,request),onImportSources:files=>importTaskSources(entry.id,files),
    onCancelSourcePick:()=>setSourcePick(previous=>previous?.ownerId===entry.id?null:previous),
    onSourceRolesChange:roles=>setSourceRoles(previous=>JSON.stringify(previous[entry.id])===JSON.stringify(roles)?previous:{...previous,[entry.id]:roles}),
   displaySettings,onDisplaySettingsChange:changeDisplaySettings,onOpenSettings:openDisplaySettings,sharedShowAxes,onSharedShowAxesChange:setSharedShowAxes,toolIntent,onToolIntentChange:setToolIntent,viewportActive:false,legendVisible:false,layoutActions:null,legendExpanded,onLegendExpandedChange:setLegendExpanded,
    onActivate:()=>activateDocument(entry.id),
    onSavedName:name=>{registry.rename(entry.id,name);publishMetadata(entry.id);},
    onViewportState:value=>{
     restoreCommittedCamera(entry.id,value);
     const shared=Boolean(detachedPlacement.current[entry.id]);
     const previous=viewportStates.current.get(entry.id);
     if(shared&&JSON.stringify(previous)===JSON.stringify(value))return;
     viewportStates.current.set(entry.id,value);
     if(shared)publishMetadata(entry.id);
    },
    onDisplayProjection:(projection,observer)=>{
     const previous=displaySources.current.get(entry.id),owner=displayOwners.current.get(entry.id);
     const shared=Boolean(owner||detachedPlacement.current[entry.id]);
     if(!previous&&!projection)return;
     if(previous&&previous.projection===projection&&(!shared||previous.signature!==undefined)){
      previous.observer=observer;owner?.publish(projection,previous.descriptor.projectionSerial);return;
     }
     // Keep the current view for a future detach. Large scientific display
     // signatures and wire publications belong to an actual shared window.
     const signature=projection&&shared?viewportDisplaySignature(projection):undefined;
     if(previous&&projection&&shared&&previous.signature===signature){
      previous.observer=observer;previous.projection=projection;owner?.publish(projection,previous.descriptor.projectionSerial);return;
     }
     const serial=(displaySerials.current.get(entry.id)??0)+1;
     displaySerials.current.set(entry.id,serial);
     if(projection){
      const {documentId,revision,sourceId,sourceRevision,sourceKey,exportSourceIdentity,frameBondEditing}=projection;
      const descriptor={documentId,revision,sourceId,sourceRevision,sourceKey,projectionSerial:serial,exportSourceIdentity,frameBondEditing,
       renderIdentity:projection.viewport.renderIdentity};
      displaySources.current.set(entry.id,{projection,descriptor,signature,observer});
     }else displaySources.current.delete(entry.id);
     if(shared){owner?.publish(projection,serial);publishMetadata(entry.id);}
    },
    onViewportImageCapture:capture=>{
     if(capture)modelImageCaptures.current.set(entry.id,{epoch:entry.epoch,capture});
     else if(modelImageCaptures.current.get(entry.id)?.epoch===entry.epoch)modelImageCaptures.current.delete(entry.id);
    },
    onViewportController:controller=>{
     if(viewportControllers.current.get(entry.id)===controller)return;
     selectionObservers.current.get(entry.id)?.();selectionObservers.current.delete(entry.id);
     if(controller){viewportControllers.current.set(entry.id,controller);const off=controller.model?.subscribeObservedSelection(({revision})=>mcpChanges.record({kind:'model',target:entry.id,revision,fields:['selection']}));if(off)selectionObservers.current.set(entry.id,off);}
     else viewportControllers.current.delete(entry.id);
    },
    onElectronicConfirmation:confirmed=>{registry.confirmElectronicState(entry.id,confirmed);publishMetadata(entry.id);},
    onDraftState:(engine,value,dirty,agentWrite)=>{if(agentWrite||registry.getSnapshot().inputTask?.documentId===entry.id){registry.setDraft(entry.id,engine,value,dirty);publishMetadata(entry.id);}},
    onRuntime:controller=>{if(documentRuntimeOwners.current.has(entry.id))return;if(!registry.getSnapshot().documents.some(value=>value.id===entry.id))return;const current=registry.document(entry.id),previous=runtimeOwners.current.get(entry.id);if(previous?.controller===controller)return;
     previous?.unsubscribe();if(!controller){runtimeOwners.current.delete(entry.id);if(current.runtime.ownerId&&!['starting','running','pausing','paused','stopping'].includes(current.runtime.phase))registry.releaseRuntime(entry.id,entry.epoch);return;}
     registry.claimRuntime(entry.id,entry.epoch);const update=()=>{const phase=controller.getSnapshot().status;if(current.runtime.phase!==phase){registry.runtimePhase(entry.id,entry.epoch,phase);publishMetadata(entry.id);}};runtimeOwners.current.set(entry.id,{controller,unsubscribe:controller.subscribe(update)});
    }
   };callbacks.current.set(entry.id,bound);
  }
  const viewportActive=!fileCurrent&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!detached[entry.id]&&(state.module==='modeling'||state.module==='input'||analysisLayout||advancedLayout||advancedModelingLayout)&&((analysisLayout||advancedLayout||advancedModelingLayout)?entry.id===displayedDocumentId:sharedLayout?deckMode!=='single'||entry.id===displayedDocumentId:entry.id===activeId);
  const ownedPesCanvas=state.module!=='plot'&&!fileCurrent?currentPesCanvas(pesCanvases,entry):undefined;
  const ownedPesGroup=entry.pesGroup?pes.controller?.getSnapshot().groups.find(group=>group.id===entry.pesGroup!.groupId):undefined;
  const ownedPesNode=ownedPesGroup?.nodes.find(node=>node.id===entry.pesGroup?.nodeId);
  const pesObservation=entry.pesGroup?protectedPesDocument(entry)||!ownedPesGroup&&entry.pesGroup.kind==='workbench'||pesNodeObserving(ownedPesGroup,ownedPesNode)||Boolean(ownedPesCanvas?.observation):undefined;
  const publicationOwner=leftToolOwner&&leftToolOwner.documentId===entry.id?leftToolOwner:null;
  if(entry.id===activeId||entry.pesGroup&&(state.module==='modeling'||detached[entry.id]))pagePresentations.current.set(entry.id,{
   advancedModelingRoute:advancedModelingLayout?advancedModelingRoute:undefined,
   analysisCanvas:withObservedOptimization(entry.id,activeXtbCanvasFor(entry))??ownedPesCanvas?.canvas??withObservedOptimization(entry.id,
    entry.trajectory&&registry.analysisAvailable(entry.id)?trajectoryCanvases[entry.id]??undefined:
    advancedLayout?(xtbAnalysisLayout?xtbCanvasFor(entry):advancedCanvases[entry.id]):
    analysisLayout&&registry.analysisAvailable(entry.id)?analysisCanvases[entry.id]??undefined:undefined),
   samplingSphereDraft:advancedLayout&&advancedSection==='conformer'&&samplingSphereDraft?.sourceDocumentId===entry.id?samplingSphereDraft:undefined,
  });
  return {...bound,entry,documentRuntime:documentRuntime(entry),onLeftToolSurfaceChange:surface=>{
    if(!publicationOwner)return;
    const key=sharedSurfaceOwnerKey(publicationOwner),current=leftToolOwnerRef.current;
    if(surface&&(!current||sharedSurfaceOwnerKey(current)!==key||registry.stamp().documentId!==entry.id||registry.getSnapshot().module!==publicationOwner.module))return;
    leftToolSurface.publish(publicationOwner,surface);
    setLeftToolPublishedOwner(previous=>surface?key:previous===key?null:previous);
  },onReturnToModel:()=>{activateDocument(entry.id);registry.setModule('modeling');},onCipLabelsUsed:cipUsageFor(entry.id,entry.epoch),twoDActive:twoDVisible,active:!fileCurrent&&entry.id===activeId&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!ownerHidden&&!taskWorkspace.opened&&(state.module==='modeling'||state.module==='input'||analysisLayout||advancedLayout||advancedModelingLayout),inputActive:entry.id===inputOwnerId&&state.module==='input'&&!closingPending&&!closeConfirmIds.includes(entry.id)&&!ownerHidden&&!taskWorkspace.opened,inputTaskId:entry.id===inputOwnerId?inputTask?.id:undefined,module:state.views.find(view=>view.documentId===entry.id)?.module??state.module,sources,sharedLayout,toolHost,toolbarHost,inputHost:inputHosts[entry.id]??null,viewportDockTarget:dockTarget,
   batchInputSession:borrowedBatch?.documentId===entry.id?borrowedBatch.session:undefined,onFinishBatchInput:id=>{void finishBatchInput(id).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},initialCameraView:inheritedViews.current.get(entry.id)?.camera,initialViewTransform:inheritedViews.current.get(entry.id)?.transform,
   workspaceCanUndo:(state.module==='input'&&Boolean(inputControllers.current.get(entry.id)?.canUndo?.()))||registry.canUndo(entry.id),workspaceCanRedo:(state.module==='input'&&Boolean(inputControllers.current.get(entry.id)?.canRedo?.()))||registry.canRedo(entry.id),
   displaySettings,onDisplaySettingsChange:changeDisplaySettings,onOpenSettings:openDisplaySettings,sharedShowAxes,onSharedShowAxesChange:setSharedShowAxes,toolIntent,onToolIntentChange:setToolIntent,viewportActive,presentationActive:entry.id===displayedDocumentId,legendVisible:entry.id===displayedDocumentId,layoutActions,legendExpanded,onLegendExpandedChange:setLegendExpanded,
   ...pagePresentations.current.get(entry.id),pesObservation,onRetainedOptimization:retainWorkspaceOptimization,onSamplingSphereRadiusChange:setSamplingSphereRadiusChange,freezeEditingAllowed:workspaceFreezeEditingAllowed(entry)&&!protectedConformerSource(entry.id)&&!pesObservation,
   onAdvancedModelingRouteChange:setAdvancedModelingRoute,onAdvancedModelingBack:()=>setAdvancedModelingRoute(route=>route?{...route,task:null}:null),
   structureAnalysisActive:currentStructureAnalysisActive({documentId:entry.id,activeDocumentId:activeId,displayedDocumentId,module:state.module,selected:structureAnalysisSelected[entry.id]===true,hasResult:Boolean(entry.result||entry.legacyResult),hasPostprocessDocument:Boolean(postprocess.documents[entry.id]),blocked:taskWorkspace.opened||ownerHidden||closingPending||closeConfirmIds.includes(entry.id)||Boolean(detached[entry.id])}),
   linkedAtomActions:linkedControls.actions,linkedAtomsActive:linkedControls.linked?.documentIds.includes(entry.id),onAtomNumberPick:linkedControls.swapping&&linkedControls.linked?.documentIds.includes(entry.id)?atomId=>linkedControls.pickAtom(entry.id,atomId):undefined,
   workspaceDocumentPickMode:sourcePick?'source':linkedControls.selecting?'link':undefined,workspaceDocumentPickSelected:linkedControls.selected.includes(entry.id),workspaceInputRoles:state.module==='input'&&inputTask?(sourceRoles[inputOwnerId??'']??[]).filter(role=>role.documentId===entry.id).map(role=>({taskId:inputTask.id,role:role.label.includes('反应物')?'reactant':role.label.includes('产物')?'product':'tsGuess',label:role.label})):[]};
 }
 function detachBlocker(id:string){
  if(borrowedBatchRef.current?.documentId===id)return '批量输入代表帧保留在当前工作区，完成或取消后自动释放。';
  if(!hostBridge?.detachWorkspaceDocument)return '独立系统窗口需要桌面版本。';
  if(registry.document(id).result)return '结果视图请先取帧为模型，再拖出编辑。';
  if(!ownerAdapters.current.has(id))return '模型还未连接。';
 }
 async function detachDocumentNow(id:string,x:number,y:number){
  const blocked=detachBlocker(id);if(blocked)throw Error(blocked);
  const entry=registry.document(id),adapter=ownerAdapters.current.get(id)!;
  await adapter.publish();await adapter.flush();
  if(registry.document(id)!==entry||closingTransactions.current.has(id))throw Error('待分离模型已变化。');
  return hostBridge!.detachWorkspaceDocument!({...authFor(id),placement:{x:Math.round(x-80),y:Math.round(y-30),width:900,height:680}});
 }
 async function detachDocument(id:string,x:number,y:number){
  try{await detachDocumentNow(id,x,y);setError('');}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 const modelToolsOwnerFor=(entry:WorkspaceDocumentEntry)=>({documentId:entry.id,module:'modeling',route:entry.epoch});
 const modelToolsAvailable=Boolean(sharedLayout&&active&&!active.result&&!fileCurrent&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&!closeConfirmIds.includes(active.id));
 const [modelToolsChoices,setModelToolsChoices]=useState<Partial<Record<WorkspaceModule,boolean>>>({});
 const activeModelInFlight=Boolean(active&&['starting','running','pausing','paused','stopping'].includes(active.runtime.phase));
 const modelToolsOpen=modelToolsChoices[state.module]??(state.module==='modeling'||activeModelInFlight);
 const setModelToolsOpen=(value:boolean)=>setModelToolsChoices(prior=>({...prior,[state.module]:value}));
 const modelToolsFloat=useWorkbenchFloat({kind:'model-tools',title:'建模工具',onDock:()=>setModelToolsOpen(true),canDock:point=>{
  const bounds=mcpWorkspaceColumns.current?.getBoundingClientRect();
  return Boolean(bounds&&point.x>=bounds.right-72&&point.x<=bounds.right&&point.y>=bounds.top&&point.y<=bounds.bottom);
 }});
 const modelToolsDocked=modelToolsAvailable&&modelToolsOpen&&!modelToolsFloat.floating;
 const toolsDrag=useRef<{pointerId:number;x:number;y:number}|null>(null);
 async function dockDetachedDocument(id:string){
  try{await hostBridge?.dockWorkspaceDocument?.(authFor(id));}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }
 const modules:Array<[WorkspaceModule,string,typeof Atom]>=[['modeling','建模',Atom],['advanced-modeling','高级建模',Boxes],['input','输入文件',FileCode2],['advanced','高级任务',Workflow],['analysis','后处理',ChartNoAxesCombined]];
 const analysisColumns=useWorkspaceColumns("postprocess");
 const mcpWorkspaceColumns=useRef<HTMLDivElement>(null);
 const mcpLayout:WorkspaceLayoutPort={
  read:()=>{
   const host=mcpWorkspaceColumns.current,geometry=readWorkspaceColumnGeometry(host);
   const hostRect=host?.getBoundingClientRect();
   const {id,folds,paneSizes:configured}=workbench.layout;
   const paneSizes=analysisLayout?{...configured,leftWidth:analysisColumns.sizes.left,rightWidth:analysisColumns.sizes.right??(geometry.visible?geometry.rightWidth:configured.rightWidth)}:configured;
   const snapshot:WorkspaceLayoutSnapshot={owner:analysisLayout?'postprocess':'workbench',id,paneSizes,folds,visiblePaneSizes:[],visibleFolds:[],actualPaneSizes:{},actualFolds:{},containerWidth:hostRect?.width};
   if(!host||!hostRect?.width||!hostRect.height)return snapshot;
   if(analysisLayout){
    snapshot.visiblePaneSizes.push('leftWidth');
    if(rightPaneVisible)snapshot.visiblePaneSizes.push('rightWidth');
    if(geometry.visible){
     snapshot.actualPaneSizes.leftWidth=geometry.leftPercent;
     if(rightPaneVisible)snapshot.actualPaneSizes.rightWidth=geometry.rightWidth;
     const fitted=fitWorkspaceColumns(hostRect.width,analysisColumns.sizes,rightPaneVisible);
     snapshot.expectedPaneSizes={leftWidth:fitted.left/hostRect.width*100,...(rightPaneVisible?{rightWidth:fitted.right}:{})};
    }
   }else{
    const left=host.querySelector('.workspace-input-divider:not([hidden])')?.getBoundingClientRect();
    const right=host.querySelector('.workspace-common-tools:not([hidden])')?.getBoundingClientRect();
    if(left?.height&&hostRect.width){snapshot.visiblePaneSizes.push('leftWidth');snapshot.actualPaneSizes.leftWidth=(left.left-hostRect.left)/hostRect.width*100;}
    if(right?.width){snapshot.visiblePaneSizes.push('rightWidth');snapshot.actualPaneSizes.rightWidth=right.width;}
   }
   const preview=[...host.querySelectorAll<HTMLElement>('[data-testid="engine-input-preview"]')].find(element=>element.getBoundingClientRect().width>0);
   if(preview&&state.module==='input'){
    snapshot.visibleFolds.push('input.preview');
    snapshot.actualFolds['input.preview']=preview.dataset.open!=='true';
    if(preview.dataset.open==='true'){
     snapshot.visiblePaneSizes.push('previewHeight');
     snapshot.actualPaneSizes.previewHeight=preview.getBoundingClientRect().height;
    }
   }
   return snapshot;
  },
  write:({paneSizes,folds})=>{
   if(analysisLayout){
    const {leftWidth,rightWidth,...other}=paneSizes;
    if(leftWidth!==undefined||rightWidth!==undefined)analysisColumns.update({...(leftWidth!==undefined?{left:leftWidth}:{}),...(rightWidth!==undefined?{right:rightWidth}:{})});
    if(Object.keys(other).length||Object.keys(folds).length)workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,...other},folds:{...current.folds,...folds}}));
   }else workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,...paneSizes},folds:{...current.folds,...folds}}));
  },
  restore:()=>analysisLayout?analysisColumns.update({left:27,right:null}):workbench.restoreBuiltin(),
 };
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
 const sidebarStructure=fileCurrent?fileObservedStructure?.owner===fileCurrent?fileObservedStructure.structure:undefined:scientificCanvasStructure(sidebarCanvas);
 const sidebarActiveResult=postprocess.ownerId&&activeAnalysisResults[postprocess.ownerId]?.source===sidebarDocument?activeAnalysisResults[postprocess.ownerId]?.result:null;
 const sidebarResult=fileCurrent?(fileDisplayedResult?.owner===fileCurrent?fileDisplayedResult.result:fileCurrent.displayResult):sidebarActiveResult??sidebarCanvas?.result??sidebarDocument?.result??active?.legacyResult;
 const sidebarFrameReady=fileCurrent?Boolean(fileCurrent.displayResult&&sidebarStructure):Boolean(sidebarDocument&&postprocess.ownerId&&registry.analysisAvailable(postprocess.ownerId)&&sidebarStructure&&sidebarCanvas?.scientificFrameReady!==false);
 const currentStructureEntry=analysisLayout&&!fileCurrent&&!analysisCurrent&&active&&!active.result&&!active.legacyResult&&!postprocess.documents[active.id]&&activeId===displayedDocumentId&&!detached[active.id]?active:null;
 const currentStructureSelected=Boolean(currentStructureEntry&&surface(currentStructureEntry).structureAnalysisActive);
 const pesRightNode=activePesGroup?.nodes.find(node=>node.id===activePesLink?.nodeId);
 const pesResultsAvailable=Boolean(pesRightNode?.runIds.some(id=>{
  const run=activePesGroup?.runs[id];return run&&(run.request.operation!=='opt'||run.retainTrajectory&&run.result);
 }));
 const advancedResultsVisible=Boolean(advancedLayout&&advancedSection&&(pesLayout?pesResultsAvailable&&!pesCanvas?.canvas.ordinaryOptimization:
  xtbAnalysisLayout?xtbAnalysisOwnerId:advancedController?.getSnapshot().tasks.some(task=>['sampling','conformer-search','docking'].includes(task.spec.kind))));
 const analysisResultsVisible=Boolean(analysisLayout&&(fileCurrent||analysisCurrent||currentStructureSelected||active?.legacyResult));
 const rightPaneVisible=modelToolsDocked||advancedResultsVisible||analysisResultsVisible;
 const extractCurrentAnalysis=()=>{const structure=sidebarStructure;return structure&&sidebarFrameReady?structuredClone(structure):null;};
 const uiVersion=useSyncExternalStore(projectUi.subscribe,projectUi.getVersion,projectUi.getVersion);
 const analysisVersion=useSyncExternalStore(subscribeAnalysisProjectState,getAnalysisProjectRevision,getAnalysisProjectRevision);
 const pendingAdvancedProject=useRef<(()=>Promise<AdvancedProjectSnapshot|undefined>)|null>(null);
 const pendingAdvancedRestore=useRef<{read:()=>Promise<AdvancedProjectSnapshot|undefined>;promise:Promise<void>}|null>(null);
 const [advancedRestoreRevision,setAdvancedRestoreRevision]=useState(0);
 const pendingAdvancedProjectChanged=useRef(false);
 const unavailableAdvancedTasks=useRef<()=>readonly string[]>(()=>[]);
 const activeAdvancedTaskUnavailable=advancedSection==='conformer'&&Boolean(activeConformerGroup&&unavailableAdvancedTasks.current().includes(activeConformerGroup.taskId));
 async function ensurePendingAdvancedProject(){
  const read=pendingAdvancedProject.current;if(!read)return;
  if(!advancedController)throw Error('构象任务owner尚未就绪，请稍后重试。');
  if(pendingAdvancedRestore.current?.read===read)return pendingAdvancedRestore.current.promise;
  const projectEpoch=projectIdentityEpoch.current,oldProjection=advancedHydrationProjection.current.project(readAdvanced());
  const promise=(async()=>{const snapshot=await read();if(pendingAdvancedProject.current!==read||projectIdentityEpoch.current!==projectEpoch)throw Error('项目来源已更换，未恢复旧构象内容。');if(snapshot)advancedController.restoreProjectSnapshot(snapshot,{adoptDecodedScience:true});if(unavailableAdvancedTasks.current().length)setError(`${unavailableAdvancedTasks.current().length} 个高级任务的结构资产无法读取，原引用已保留；其他完整任务已恢复。`);advancedHydrationProjection.current.record(readAdvanced(),oldProjection);pendingAdvancedProject.current=null;setAdvancedRestoreRevision(value=>value+1);})();
  pendingAdvancedRestore.current={read,promise};
  try{await promise;}finally{if(pendingAdvancedRestore.current?.promise===promise)pendingAdvancedRestore.current=null;}
 }
 const pendingProjectDetaches=useRef<Record<string,{x:number;y:number;width:number;height:number}>>({});
 const restoringProjectDetaches=useRef(new Set<string>());
 const [projectDetachRevision,setProjectDetachRevision]=useState(0);
 const restoringProject=useRef(false);
 const [restoringDocumentViews,setRestoringDocumentViews]=useState(false);
 const [detachedProjectSaveEpoch,setDetachedProjectSaveEpoch]=useState(0);
 const projectRevision=JSON.stringify([state.documents.map(entry=>[entry.id,entry.label,entry.labelOrigin,entry.store.getSnapshot().revision,entry.drafts,entry.retiredInputDrafts,entry.inputDraftCopyIssues,entry.trajectory?.currentFrameId]),state.module,borrowedBatch?.session.id,borrowedBatch?.input.taskId,order,conformerGroups,displaySettings,workbench.layout,uiVersion,analysisVersion,advancedHydrationProjection.current.project(advancedStatusProjection),Object.keys(postprocess.documents),Object.values(postprocess.fileDocuments).map(value=>[value.id,postprocessFileDocumentVersion(value)]),postprocess.fileOwnerId,fileSidebarCollapsed,sourceDiagnostics.map(item=>item.id),citationState,plots.map(plot=>[plot.id,plot.kind]),taskSnapshotPages,detachedProjectSaveEpoch,xtbElectronicDrafts,xtbTaskSelections,xtbMethodDrafts,pes.revision,collapsedPesGroups]);
 const capturedProjectRevisions=useRef(new Map<string,number>());
 const capturedProjectModels=useRef(new Map<string,WorkspaceModelSnapshot>());
 const projectMDSnapshotSources=useRef<unknown>(undefined),capturedProjectMDSnapshotSources=useRef<unknown>(undefined);
 const retainedProjectShell=useRef<Record<string,unknown>>({});
 const preservedProjectFileSources=useRef<Record<string,string>>({});
 const project=useProjectWorkspace({revision:projectRevision,onError:setError,restoring:restoringProject.current||(state.module==='advanced'&&!pesLayout&&pendingAdvancedProject.current!==null)||Object.keys(pendingProjectDetaches.current).length>0,
  onSaved:(_description,detail)=>{projectMDSnapshotSources.current=capturedProjectMDSnapshotSources.current;if(!detail.automatic){markCapturedWorkspaceModelsApplied(registry,capturedProjectRevisions.current,capturedProjectModels.current);if(capturedProjectModels.current.size)setDetachedProjectSaveEpoch(value=>value+1);}},
  capture:async(writer,_reader,options)=>{
   if(twoDCommitting.current)throw Error('二维模型正在提交，请稍后保存。');
   if(pesDeleting)throw Error('势能面标签正在收尾，请稍后保存。');
   projectActivity.current.capturing=true;try{
   const modelSnapshots=await captureWorkspaceModelSnapshots({registry,runtimeOwner:id=>runtimeOwners.current.get(id)?.controller,generation:()=>projectIdentityEpoch.current});
   await Promise.all([...ownerAdapters.current.values()].map(adapter=>adapter.flush()));
   capturedProjectRevisions.current=new Map(registry.getSnapshot().documents.map(entry=>[entry.id,entry.store.getSnapshot().revision]));
   capturedProjectModels.current=modelSnapshots;
   const cameras=Object.fromEntries(state.documents.map(entry=>[entry.id,viewportControllers.current.get(entry.id)?.getCameraView?.()??viewportStates.current.get(entry.id)?.cameraView??null]));
   const windowPlacements=await desktop?.readProjectWindowPlacements?.();
   const advanced=pendingAdvancedProject.current?(options.reuse&&!pendingAdvancedProjectChanged.current?undefined:await pendingAdvancedProject.current()):advancedController?.exportProjectSnapshot({shareImmutableScience:true});
   const sourceDiagnosticSnapshots=await Promise.all(sourceDiagnosticsRef.current.map(item=>encodeDiagnostic(item,writer)));
   const capturedBatch=borrowedBatchRef.current;
   const borrowedBatchAsset=capturedBatch?await writeBorrowedBatchInput(capturedBatch,writer):retainedUnreadableBatchAsset.current;
   if(borrowedBatchRef.current!==capturedBatch||capturedBatch&&(registry.getSnapshot().inputTask?.id!==capturedBatch.input.taskId||registry.document(capturedBatch.documentId).epoch!==capturedBatch.documentEpoch))throw Error('保存期间批量输入会话已变化，未提交旧快照。');
   const retainedFileDocuments=postprocess.captureFileDocuments();
   const captured=await captureWorkspaceProject({registry,documents:postprocess.documents,fileDocuments:retainedFileDocuments,preservedFileSources:preservedProjectFileSources.current,generated:postprocess.generated,advanced,...pes.capture(),ui:projectUi.capture(),writer,reader:_reader,reuse:options.reuse,modelSnapshots,
    shell:{...retainedProjectShell.current,borrowedBatchAsset,pesDocuments:pesWorkspaceBindings(registry.getSnapshot().documents),pesGroupNames:{...restoredPesNames.current,...Object.fromEntries((pes.controller?.getSnapshot().groups??[]).map(group=>[group.id,group.name]))},collapsedPesGroups,postprocessFileOwnerId:postprocess.fileOwnerId,postprocessFileSidebarCollapsed:Object.fromEntries(Object.entries(fileSidebarCollapsed).filter(([id])=>Boolean(postprocess.fileDocuments[id]))),deckMode,multiMode,order,mainDocumentId,displaySettings,sharedShowAxes,conformerGroups,conformerFrameOrders,plots:retainedFilePathPlots(plots,retainedFileDocuments),workbench:workbench.layout,cameras,windowPlacements,advancedObservations,advancedAnalysisBindings,xtbAnalysisSelections,...(()=>{const value=restoreWorkspaceXtbSettings({electronicDrafts:xtbElectronicDrafts,taskSelections:xtbTaskSelections,methodDrafts:xtbMethodDrafts});return {xtbElectronicDrafts:value.electronicDrafts,xtbTaskSelections:value.taskSelections,xtbMethodDrafts:value.methodDrafts};})(),structureAnalysisSelected,legendExpanded,taskSnapshotPages:Object.fromEntries(Object.entries(taskSnapshotPagesRef.current).filter(([,row])=>registry.getSnapshot().documents.some(entry=>entry.id===row.documentId)||Boolean(postprocess.fileDocuments[row.documentId]))),sourceDiagnostics:sourceDiagnosticSnapshots,citationState:retainedCitationState(citationStateRef.current,new Set(retainedCitationOwnerIds(registry.getSnapshot().documents,postprocess.captureFileDocuments()))),...(projectMDSnapshotSources.current===undefined?{}:{mdSnapshotSources:projectMDSnapshotSources.current})}});
   capturedProjectMDSnapshotSources.current=captured.shell.mdSnapshotSources;return captured;
   }finally{projectActivity.current.capturing=false;}
  },
  restore:async(value,reader)=>{
   if(pesDeleting)throw Error('势能面标签正在收尾，请稍后载入项目。');
   if(pes.controller?.getSnapshot().groups.some(group=>pesRunActive(group)))throw Error('请等待势能面计算结束后再载入项目。');
   if(postprocess.isBusy())throw Error('来源仍在读取或切换，请完成或取消后再载入另一项目。');
   if(pendingDiscards.current.size)throw Error('已有内容仍待释放，请先重试释放后再载入另一项目。');
   let preparedRegistry:ReturnType<typeof registry.prepareProjectRestore>|undefined,registryInstalled=false;const runtimeCloses:Awaited<ReturnType<typeof prepareDocumentRuntimeClose>>[]=[];
   let decodedFileSources:Record<string,PostprocessScientificFileDocument>={},fileSourcesInstalled=false;
   try{
   // Prepare every incoming identity and field before retiring the current view.
   const restored=await decodeWorkspaceProject(value,reader,{deferPublication:true,transientAdvancedReads:true}),shell=restored.shell as Record<string,any>;
   const restoredBatch=await restoreBorrowedBatchInput(shell.borrowedBatchAsset,restored.registry,reader);
   decodedFileSources=restored.fileSources;
   preparedRegistry=registry.prepareProjectRestore(restoredBatch.registry,{results:restored.results});
   const xtbSettings=restoreWorkspaceXtbSettings({electronicDrafts:shell.xtbElectronicDrafts,taskSelections:shell.xtbTaskSelections,methodDrafts:shell.xtbMethodDrafts});
   const restoredCitationState=restoreCitationState(shell.citationState);
   // The unsubmitted 2D board is owned by this window, not by the project being restored.
   twoDRuntime.current?.cancelGesture();
   // Layout capture cleanup must finish against the old UI generation. Keep
   // every rendered document/portal unmounted across asynchronous graph restore.
   restoringProject.current=true;
   projectIdentityEpoch.current++;advancedHydrationProjection.current.reset();conformerPlayerCollections.current.clear();conformerCollectionCache.current=new WeakMap();
   taskWorkspace.leave();
   conformerCollectionPublisher.current.reset();for(const value of conformerPrepared.current.values())retirePreparationRecord(value);conformerPrepared.current.clear();discardConfirmSerial.current++;discardImpactRef.current=null;setDiscardImpact(null);setClosing(null);setCloseConfirmIds([]);
   // Claim can enter here from a React effect. Leave that lifecycle before
   // requesting a synchronous unmount, which React otherwise cannot perform.
   await Promise.resolve();
   flushSync(()=>setRestoringDocumentViews(true));
    decodedFileSources=restored.fileSources;
    const restoredDiagnostics=restored.diagnostics;
    for(const id of [...documentRuntimeOwners.current.keys()])runtimeCloses.push(await prepareDocumentRuntimeClose(id));
    // Retire the new window's initial blank owner before replacing its IDs.
    // Its queued publisher must never query a document removed by hydration.
    for(const [id,adapter]of ownerAdapters.current){await adapter.flush();if(hostBridge&&adapter.getState().membership)await hostBridge.closeWorkspaceDocument(authFor(id));adapter.dispose();}
    ownerAdapters.current.clear();viewportStates.current.clear();viewportControllers.current.clear();callbacks.current.clear();
    for(const id of [...Object.keys(postprocess.captureFileDocuments()),...postprocess.pendingFileCloses()]){const issues=await postprocess.closeFile(id);if(issues.length)throw Error(`旧文件来源尚未释放：${issues.join('；')}`);}
    await preparedRegistry.commit();registryInstalled=true;
    restoredConformerReaders.current=new WeakSet(registry.getSnapshot().documents.flatMap(entry=>entry.trajectory&&entry.legacyResult?[entry.legacyResult]:[]));
    for(const prepared of runtimeCloses)prepared.commit();await restored.publish(registry);setCitationOpen(null);setCitationState(restoredCitationState);
    borrowedBatchRef.current=restoredBatch.batch;setBorrowedBatch(restoredBatch.batch);setCancelBatchConfirm(false);retainedUnreadableBatchAsset.current=restoredBatch.unreadableAsset;setBatchInputRecoveryNotice(restoredBatch.notice);
    retainedProjectShell.current=structuredClone(restored.retainedShell);projectMDSnapshotSources.current=shell.mdSnapshotSources;capturedProjectMDSnapshotSources.current=undefined;capturedProjectModels.current=new Map();
    postprocess.restoreProjectDocuments(restored.sources,restored.generated);
    preservedProjectFileSources.current={...restored.fileSourceIssues};
    postprocess.restoreFileDocuments(restored.fileSources,typeof shell.postprocessFileOwnerId==='string'?shell.postprocessFileOwnerId:null);setFileSidebarCollapsed(Object.fromEntries(Object.entries(shell.postprocessFileSidebarCollapsed??{}).filter(([id,value])=>Boolean(restored.fileSources[id])&&typeof value==='boolean')) as Record<string,boolean>);fileSourcesInstalled=true;
    const taskPages=Object.fromEntries(Object.entries(shell.taskSnapshotPages??{}).filter((entry):entry is [string,{documentId:string;sourceId:string;taskId:string;runId:string|null;libraryId:string;sourceSetId?:string;sourceVersion?:string}]=>{const row=entry[1] as Record<string,unknown>|null;return Boolean(row&&['documentId','sourceId','taskId','libraryId'].every(key=>typeof row[key]==='string')&&(typeof row.runId==='string'||row.runId===null&&typeof row.sourceSetId==='string'&&!!row.sourceSetId&&typeof row.sourceVersion==='string'&&!!row.sourceVersion)&&(restored.sources[row.documentId as string]?.result.source.id===row.sourceId||restored.fileSources[row.documentId as string]?.output.source.identity.id===row.sourceId));}));taskSnapshotPagesRef.current=taskPages;setTaskSnapshotPages(taskPages);setRequestedTaskCursors({});
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
    inheritedViews.current.clear();pendingCameraRestores.current.clear();
    for(const [id,camera]of Object.entries(shell.cameras??{}))if(Array.isArray(camera)){if(registry.stamp().documentId===id)pendingCameraRestores.current.set(id,{stamp:registry.stamp(),view:camera as number[]});inheritedViews.current.set(id,{camera:camera as number[]});}
    restoredPesNames.current=Object.fromEntries(Object.entries(shell.pesGroupNames??{}).filter((row):row is [string,string]=>typeof row[1]==='string'));setCollapsedPesGroups(Object.fromEntries(Object.entries(shell.collapsedPesGroups??{}).filter((row):row is [string,boolean]=>typeof row[1]==='boolean')));
    pes.restore(restored.pesAsset,restored.readPes,shell.pesDocuments);setPesCanvases(new Map());
    unavailableAdvancedTasks.current=restored.unavailableAdvancedTaskIds;pendingAdvancedProject.current=restored.readAdvanced;pendingAdvancedProjectChanged.current=false;setAdvancedRestoreRevision(value=>value+1);
    if(restored.issues.length)setError(`项目已载入；${restored.issues.length}项数据暂不可用，原引用保留。`);
   }catch(error){for(const prepared of runtimeCloses){if(registryInstalled)prepared.commit();else prepared.cancel();}preparedRegistry?.cancel();if(!fileSourcesInstalled)await Promise.allSettled(Object.values(decodedFileSources).map(document=>disposePostprocessFileDocument(document,async id=>{await desktop?.commandOrbitals?.(id,{operation:'close'});})));throw error;}
   finally{if(restoringProject.current)flushSync(()=>{restoringProject.current=false;setRestoringDocumentViews(false);});}
  }});
 const projectClose=useRef(project.prepareClose);projectClose.current=project.prepareClose;
 projectActivity.current.busy=project.busy;
 const projectInfo=useRef(project);projectInfo.current=project;
 const projectRunning=useRef(false);projectRunning.current=twoDBusy||state.documents.some(entry=>['starting','running','pausing','paused','stopping'].includes(entry.runtime.phase))||Boolean(advancedController?.getSnapshot().activeNative)||Boolean(advancedController?.getSnapshot().queue.length)||Boolean(pes.controller?.getSnapshot().groups.some(group=>pesRunActive(group)));
 useEffect(()=>{
  if(!hostBridge)return;
  for(const [id,placement]of Object.entries(pendingProjectDetaches.current)){
   if(restoringProjectDetaches.current.has(id))continue;
   const entry=registry.getSnapshot().documents.find(value=>value.id===id);
   if(!entry){delete pendingProjectDetaches.current[id];setProjectDetachRevision(value=>value+1);continue;}
   const adapter=ensureOwnerAdapter(registry.document(id));if(!adapter)continue;
   restoringProjectDetaches.current.add(id);
   void adapter.ready.then(()=>adapter.publish()).then(()=>adapter.flush()).then(()=>hostBridge.detachWorkspaceDocument!({...authFor(id),placement,restorePlacement:true}))
    .catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))
    .finally(()=>{restoringProjectDetaches.current.delete(id);delete pendingProjectDetaches.current[id];setProjectDetachRevision(value=>value+1);});
  }
 },[hostBridge,registry,documentSignature,state.version,projectDetachRevision]);
 useEffect(()=>{if(restoringDocumentViews||state.module!=='advanced'||pesLayout||!advancedController||!pendingAdvancedProject.current)return;void ensurePendingAdvancedProject().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},[state.module,pesLayout,advancedController,restoringDocumentViews,advancedRestoreRevision]);
 useEffect(()=>{if(restoringDocumentViews||!(pesLayout||state.module==='modeling'&&retainedPesEntries.length>0)||!pes.controller||!pes.pending.current)return;void pes.ensure().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));},[pesLayout,state.module,retainedPesEntries.length,pes.controller,pes.loaded,restoringDocumentViews]);
 const [deleteGroup,setDeleteGroup]=useState<string|null>(null),[deletingGroup,setDeletingGroup]=useState(false);
 async function confirmDeleteGroup(){
  if(!deleteGroup||deletingGroup)return;setDeletingGroup(true);
  try{const root=registry.getSnapshot().documents.find(entry=>entry.conformerGroup?.taskId===deleteGroup||entry.trajectory?.identity.taskId===deleteGroup);
   if(!root)throw Error('构象组文档已变化，请重新选择。');
   const impact=await buildDiscardImpact(root.id,true);await executeDiscard(impact);
   if(!registry.getSnapshot().documents.some(entry=>impact.registryPlan.documentIds.includes(entry.id)))setDeleteGroup(null);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setDeletingGroup(false);}
 }
 const mcpPlaybackCanvases=useRef(new Map<string,AnalysisCanvas>());
 const mcpPlaybackCallbacks=useRef(new Map<string,(canvas:AnalysisCanvas|null)=>void>());
 function mcpPlaybackCanvasFor(id:string){
  let callback=mcpPlaybackCallbacks.current.get(id);
  if(!callback){
   callback=canvas=>{publishFrameChange(id,canvas);if(canvas)mcpPlaybackCanvases.current.set(id,canvas);else mcpPlaybackCanvases.current.delete(id);};
   mcpPlaybackCallbacks.current.set(id,callback);
  }
  return callback;
 }
 const readMcpActiveFrameTarget=()=>{
  if(taskWorkspace.isOpen())return undefined;
  const current=registry.getSnapshot();
  if(current.module==='analysis'&&advancedPorts.current.postprocess.fileOwnerId)return advancedPorts.current.postprocess.fileOwnerId;
  return current.views.find(view=>view.id===current.activeViewId)?.documentId;
 };
 const mcpFramePorts=useRef<FrameShellPorts|null>(null);
 mcpFramePorts.current={
  registry,projectEpoch:()=>projectIdentityEpoch.current,activeTarget:readMcpActiveFrameTarget,
  file:id=>advancedPorts.current.postprocess.captureFileDocuments()[id],
  binding:id=>advancedPorts.current.postprocess.documents[id],
  canvas:id=>{
   if(id!==readMcpActiveFrameTarget()||ownerHidden||taskWorkspace.opened||closingPending)return undefined;
   const entry=registry.getSnapshot().documents.find(row=>row.id===id);
   const pesView=entry?.pesGroup?currentPesCanvas(pesCanvases,entry)?.canvas:undefined;
   return pesView??mcpPlaybackCanvases.current.get(id)??trajectoryCanvases[id]
    ??analysisCanvasesRef.current[id]??xtbAnalysisCanvases[id]??undefined;
  },
  retainedCanvas:id=>lastScientificCanvases.current.get(id),
  cursor:id=>trajectoryFrames.current.get(id),
  conformerTask:id=>advancedIntegration.current.controller?.getSnapshot().tasks.find(task=>task.id===id),
  resolveTarget(ref){
   const optimization=parseOptimizationCollectionRef(ref);
   if(optimization){
    const group=pes.getController()?.getSnapshot().groups.find(row=>row.id===optimization.groupId),run=group?.runs[optimization.runId];
    const collection=run&&retainedOptimizationCollection(run);
    const target=run&&registry.getSnapshot().documents.find(entry=>entry.pesGroup?.groupId===optimization.groupId&&entry.pesGroup?.nodeId===run.nodeId);
    if(!collection||!target)throw Error('保留优化运行已关闭或轨迹尚不可用。');
    return {targetId:target.id,collectionId:collection.collectionId};
   }
   const files=Object.values(advancedPorts.current.postprocess.captureFileDocuments());
   const matches=files.flatMap<{targetId:string;collectionId?:string}>(file=>{
    if(file.displayResult?.id===ref)return [{targetId:file.id,collectionId:file.displayResult.id}];
    return file.output.source.identity.id===ref?[{targetId:file.id,collectionId:undefined}]:[];
   });
   const pp=advancedPorts.current.postprocess;
   for(const entry of registry.getSnapshot().documents){
    const result=[entry.result,entry.legacyResult,pp.documents[entry.id]?.result].find(row=>row?.id===ref);
    if(result)matches.push({targetId:entry.id,collectionId:result.id});
   }
   if(matches.length>1)throw Error('多个工作台对象共享来源引用，请使用确切的模型或文件来源 ID。');
   return matches[0];
  },
  retainedOptimization(targetId,collectionId){
   if(!collectionId.endsWith(':opt'))return;
   const entry=registry.getSnapshot().documents.find(row=>row.id===targetId),link=entry?.pesGroup;
   const group=link&&pes.getController()?.getSnapshot().groups.find(row=>row.id===link.groupId);
   const run=group?.runs[collectionId.slice(0,-4)];
   if(run&&run.nodeId===link?.nodeId&&retainedOptimizationCollection(run)?.collectionId===collectionId)return run;
  },
  pesRecord(targetId,recordId){
   const entry=registry.getSnapshot().documents.find(row=>row.id===targetId),owner=entry?.pesGroup,controller=pes.getController();
   const group=owner&&controller?.getSnapshot().groups.find(row=>row.id===owner.groupId),node=group?.nodes.find(row=>row.id===owner?.nodeId);
   if(!group||!node||!controller)return;
   for(const id of node.runIds){const run=group.runs[id];if(!run)continue;const record=pesPathRecords(run).find(row=>row.id===recordId);if(record)return {run,record,
    readFrame:(frameId,seriesId,signal)=>controller.readFrame(group.id,run.request.runIdentity.runId,seriesId,frameId,signal,record.id)};}
  },
  isClosing:id=>closingTransactions.current.has(id),
  prepareRetainedCollection:prepareRetainedConformerCollection,
  captureCurrent:()=>{
   const id=readMcpActiveFrameTarget();if(!id)throw Error('当前窗口没有显示科学对象，请指定来源。');
   if(advancedPorts.current.postprocess.captureFileDocuments()[id]){
    const current=frameAccess.current(mcpFrameContext.owner(id));if(!current)throw Error('文件当前帧正在准备，请选择明确的来源帧。');
    return frameAccess.readAdvancedFrame(current.frameRef);
   }
   return captureCurrentAdvancedSource(true);
  },
  async activate(owner){
   if(sourcePickLive.current||selectingMembers.current)throw Error('请先完成当前来源或关联成员选择。');
   taskWorkspace.leave();
   const pp=advancedPorts.current.postprocess;
   if(pp.captureFileDocuments()[owner.targetId]){
    flushSync(()=>{pp.selectFile(owner.targetId);registry.setModule('analysis');registry.invalidateActivation();});
    const job=owner.outputJob?.id;if(job&&pp.captureFileDocuments()[owner.targetId]?.output.source.selectedJobId!==job){
     await pp.selectFileJob(owner.targetId,job);
     if(pp.captureFileDocuments()[owner.targetId]?.output.source.selectedJobId!==job)throw Error('当前文件未切换到指定作业。');
    }
    return;
   }
   const entry=registry.document(owner.targetId);
   activateDocument(entry.id);
   flushSync(()=>{
    if(entry.pesGroup){
     const key=JSON.stringify(['workspace','workspace-page.advancedSection']);
     projectUi.set(key,{...projectUi.get<Record<string,AdvancedSection|null>>(key,{}),[entry.id]:'path'});
     registry.setModule('advanced');
    }else registry.setModule(entry.trajectory?'modeling':'analysis');
   });
  },
  extract(source,label){
   const view=currentViewPose(source.ref.documentId);
   const fragment=electronicSourceEditingFragment(source);
   let entry!:WorkspaceDocumentEntry;
   flushSync(()=>{
    taskWorkspace.leave();advancedPorts.current.postprocess.selectFile(null);
    entry=registry.addFragmentDocument(fragment,label??automaticStem(source.label));
    inheritedViews.current.set(entry.id,view);setMainDocumentId(entry.id);
    registry.setModule('modeling');setError('');
   });
   return {documentId:entry.id,documentEpoch:entry.epoch,revision:entry.store.getSnapshot().revision};
  },
  derive(result){
   let entry!:WorkspaceDocumentEntry;
   flushSync(()=>{
    taskWorkspace.leave();advancedPorts.current.postprocess.selectFile(null);
    entry=registry.addResultDocument(result);setMainDocumentId(entry.id);
    registry.setModule('analysis');setError('');
   });
   return {documentId:entry.id,documentEpoch:entry.epoch,revision:entry.store.getSnapshot().revision};
  },
 };
 const mcpFrameContext=useMemo(()=>createFrameShell(()=>mcpFramePorts.current!),[]);
 const frameAccess=useMemo(()=>createFrameAccess(()=>mcpFrameContext),[mcpFrameContext]);
 const standaloneResultId=fileCurrent?.id??(!advancedLayout&&state.module!=='input'&&active?.result?active.id:undefined);
 const standaloneOptimization=useRef(false);
 useEffect(()=>{
  const root=rootElement.current,win=root?.ownerDocument.defaultView;
  if(!root||!win||!standaloneResultId||ownerHidden||taskWorkspace.opened||closingPending||twoDVisible)return;
  function onSpace(event:KeyboardEvent){
   if(event.defaultPrevented||standaloneOptimization.current||blockingModelDialog(root)||
    !workspaceSpacePressAllowed(event,false,event.target,root!.ownerDocument.activeElement))return;
   if(event.target!==root!.ownerDocument.body&&!(event.target instanceof Node&&root!.contains(event.target)))return;
   if(readMcpActiveFrameTarget()!==standaloneResultId)return;
   event.preventDefault();
   standaloneOptimization.current=true;
   const projectEpoch=projectIdentityEpoch.current;
   void (async()=>{
    const owner=mcpFrameContext.owner(standaloneResultId);
    const current=frameAccess.current(owner);
    if(!current)throw Error('请先显示所需的完整科学帧。');
    const source=await frameAccess.readAdvancedFrame(current.frameRef);
    if(projectIdentityEpoch.current!==projectEpoch||readMcpActiveFrameTarget()!==standaloneResultId||
     frameAccess.current(mcpFrameContext.owner(standaloneResultId))?.frameRef!==current.frameRef)
     throw Error('当前画面已切换，未启动旧帧的优化。');
    await launchOptimizationModel(source);
   })().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))
    .finally(()=>{standaloneOptimization.current=false;});
  }
  win.addEventListener('keydown',onSpace);
  return ()=>win.removeEventListener('keydown',onSpace);
 },[standaloneResultId,ownerHidden,taskWorkspace.opened,closingPending,twoDVisible,frameAccess,mcpFrameContext]);
 function mcpTabContext():TabToolContext{
  const epoch=()=>JSON.stringify([projectIdentityEpoch.current,projectInfo.current.currentProject()?.projectId??null]);
  const groupRef=(kind:'pes-group'|'conformer-group',id:string)=>JSON.stringify([kind,id]);
  const groupFor=(entry:WorkspaceDocumentEntry)=>entry.pesGroup?groupRef('pes-group',entry.pesGroup.groupId):entry.conformerGroup?groupRef('conformer-group',entry.conformerGroup.taskId):undefined;
  const collapsed=(entry:WorkspaceDocumentEntry)=>entry.pesGroup?collapsedPesGroups[entry.pesGroup.groupId]===true:entry.conformerGroup?conformerGroups[entry.conformerGroup.taskId]?.collapsed===true:false;
  function projectModelTab(entry:WorkspaceDocumentEntry):WorkspaceTabRecord{
   const doc=entry.store.getSnapshot(),detached=Boolean(detachedPlacement.current[entry.id]);
   const visible=!ownerHidden&&!taskWorkspace.isOpen()&&!detached&&tabDocuments.some(row=>row.id===entry.id)&&!collapsed(entry);
   const label=entry.conformerGroup?.role==='initial'&&entry.labelOrigin==='automatic'?(entry.conformerGroup.initialIndex??1)===1?'initial':`initial_${String(entry.conformerGroup.initialIndex).padStart(3,'0')}`:entry.label;
   const closing=closingTransactions.current.has(entry.id);
   const actions=closing?[]:['close','rename',...(detached?(hostBridge?.dockWorkspaceDocument?['dock']:[]):detachBlocker(entry.id)?[]:['detach'])];
   return {ref:entry.id,kind:'model-tab',ownerId:entry.id,label,revision:JSON.stringify([entry.epoch,doc.revision,entry.sourceEpoch,entry.label,entry.inputDirty,entry.runtime.phase,groupFor(entry),detached]),visible,active:readMcpActiveFrameTarget()===entry.id,detached,
    groupRef:groupFor(entry),status:closing?'closing':entry.runtime.phase,actions};
  }
  function read(){
   const current=registry.getSnapshot(),byId=new Map(current.documents.map(entry=>[entry.id,entry]));
   const knownOrder=[...new Set([...tabDocuments.map(entry=>entry.id),...byId.keys()])];
   const rows=knownOrder.flatMap(id=>{const entry=byId.get(id);return entry?[projectModelTab(entry)]:[];});
   const groups=new Map<string,WorkspaceTabRecord>();
   for(const entry of current.documents){
    const ref=groupFor(entry);if(!ref||groups.has(ref))continue;
    const id=entry.pesGroup?.groupId??entry.conformerGroup?.taskId;if(!id)continue;
    const members=rows.filter(row=>row.groupRef===ref),name=entry.pesGroup?pes.getController()?.getSnapshot().groups.find(group=>group.id===id)?.name??restoredPesNames.current[id]:conformerGroups[id]?.label;
    groups.set(ref,{ref,kind:entry.pesGroup?'pes-group':'conformer-group',ownerId:id,label:name??entry.label,
     revision:JSON.stringify([collapsed(entry),name,members.map(row=>[row.ref,row.revision])]),visible:!ownerHidden&&!taskWorkspace.isOpen()&&tabDocuments.some(row=>groupFor(row)===ref),active:members.some(row=>row.active),actions:['close','rename','group-collapse']});
   }
   rows.push(...groups.values());
   for(const file of Object.values(advancedPorts.current.postprocess.captureFileDocuments())){
    const source=file.output.source.identity,active=readMcpActiveFrameTarget()===file.id;
    rows.push({ref:file.id,kind:'file-source',ownerId:file.id,label:source.name,revision:JSON.stringify([source,file.output.source.selectedJobId,file.displayResult?.id,file.wavefunction?.source.result.source,file.companions?.map(value=>value.source.result.source)]),visible:active&&!ownerHidden,active,actions:['close']});
   }
   for(const [ownerId,port]of resultRegistry?.analysisViews??[]){
    const view=port.read();
    for(const panel of view.state.instances)rows.push({ref:JSON.stringify(['analysis-panel',ownerId,panel.id]),kind:'analysis-panel',ownerId,label:ANALYSIS_TITLES[panel.kind],
     revision:JSON.stringify([panel,port.stageFor?.(panel.kind)]),visible:view.active&&(view.state.mode!=='tabs'||panel.detached||view.state.groupActive[panel.group]===panel.id),active:view.active&&view.state.activeId===panel.id,detached:panel.detached,actions:port.control?['close']:[]});
   }
   for(const [id,plot]of resultRegistry?.plots??[])if(plot.display?.close){
    rows.push({ref:JSON.stringify(['plot-window',id]),kind:'plot-window',ownerId:plot.ownerId??plot.resultId??id,label:plot.port.read().title,revision:String(plot.revision),visible:plot.display.visible,active:plot.display.active,actions:['close']});
   }
   return {tabs:rows,layout:deckMode,workspaceRevision:JSON.stringify([epoch(),deckMode,rows.filter(row=>row.kind==='model-tab'||row.kind==='pes-group'||row.kind==='conformer-group').map(row=>[row.ref,row.revision,row.visible,row.actions])])};
  }
  function assertAvailable(){
   if(projectActivity.current.busy||projectActivity.current.capturing||restoringProject.current||closingTransactions.current.size||discardImpactRef.current||pesClosing||deleteGroup)throw Error('工作台正在保存、恢复或处理关闭确认。');
   if(sourcePickLive.current||selectingMembers.current)throw Error('当前工作台正在选择任务来源或关联成员。');
  }
  function retainedTab(target:WorkspaceTabRecord){
   const live=read().tabs.find(row=>row.ref===target.ref&&row.kind===target.kind&&row.ownerId===target.ownerId);
   if(!live||live.revision!==target.revision)throw Error('标签或其数据所有权已变化。');
   return live;
  }
  async function prepareClose(target:WorkspaceTabRecord):Promise<TabCloseAdmission>{
   assertAvailable();retainedTab(target);
   const ownEpoch=epoch(),guard=()=>{if(epoch()!==ownEpoch)throw Error('工作台项目已变化。');retainedTab(target);};
   if(target.kind==='file-source')return {effects:['关闭后处理文件来源并释放读取资源'],affected:[target],confirmation:false,async execute(){
    guard();const issues=await advancedPorts.current.postprocess.closeFile(target.ref);
    return {status:issues.length?'cleanup-pending':'released',removed:[target.ref],...(issues.length?{error:issues.join('；'),cleanupKey:JSON.stringify(['file-source',target.ref])}:{})};
   }};
   if(target.kind==='analysis-panel'||target.kind==='plot-window')return {effects:['关闭指定显示面板'],affected:[target],confirmation:false,async execute(){
    guard();const ids=JSON.parse(target.ref) as string[];
    if(target.kind==='analysis-panel'){
     const panel=resultRegistry?.analysisViews.get(ids[1]);if(!panel?.control)throw Error('分析面板关闭入口未就绪。');
     await panel.control({action:'close',panelId:ids[2]});
    }else{
     const closePlot=resultRegistry?.plots.get(ids[1])?.display?.close;if(!closePlot)throw Error('图窗关闭入口未就绪。');
     flushSync(closePlot);
    }
    if(read().tabs.some(row=>row.ref===target.ref))return {status:'blocked',removed:[],error:'显示面板尚未从所有者退场。'};
    return {status:'released',removed:[target.ref]};
   }};
   const whole=target.kind!=='model-tab';
   const entry=whole?registry.getSnapshot().documents.find(row=>groupFor(row)===target.ref):registry.document(target.ref);
   if(!entry)throw Error('目标组没有仍在工作区的模型。');
   if(closeRequests.current.has(entry.id))throw Error('模型已有尚未结束的关闭请求。');
   if(borrowedBatchRef.current?.documentId===entry.id)return {effects:['结束批量输入并恢复原来的输入所有者'],affected:[target],confirmation:true,async execute(){
    guard();const borrowed=borrowedBatchRef.current;if(borrowed?.documentId!==entry.id)throw Error('批量输入代表帧已变化。');
    await finishBatchInput(borrowed.session.id);
    return registry.getSnapshot().documents.some(row=>row.id===entry.id)?{status:'blocked',removed:[],error:'批量代表页仍有运行或关闭未结束。'}:{status:'released',removed:[entry.id]};
   }};
   const pesTarget=entry.pesGroup&&{groupId:entry.pesGroup.groupId,nodeId:whole||entry.pesGroup.kind==='initial'?undefined:entry.pesGroup.nodeId,label:target.label};
   const impactRoot=pesTarget?registry.getSnapshot().documents.find(row=>matchesPesDocumentRemoval(row.pesGroup,pesTarget))??entry:entry;
   const impact=await buildDiscardImpact(impactRoot.id,whole||Boolean(pesTarget&&!pesTarget.nodeId));guard();
   const affected=impact.documents.map(row=>projectModelTab(registry.document(row.id)));
   return {effects:[...impact.impactLabels,...(pesTarget?['按原生流程结束该范围的势能面运行并移除结果记录']:[])],affected,
    confirmation:whole||Boolean(pesTarget)||impact.requiresConfirmation,ownerVersion:impact.conformerPlan?.revision,async execute(){
     guard();const receipt=pesTarget?await retirePesTabs(pesTarget,executeMcpDiscard,guard):await executeMcpDiscard(impact);
     if(whole&&!read().tabs.some(row=>row.ref===target.ref))return {...receipt,removed:[...receipt.removed,target.ref]};
     return receipt;
    }};
  }
  return {epoch,read,prepareClose,async retryRelease(key){
   const ref=JSON.parse(key) as unknown[];
   if(ref[0]==='file-source'&&typeof ref[1]==='string'){
    const pp=advancedPorts.current.postprocess;if(pp.captureFileDocuments()[ref[1]])throw Error('同名文件来源已重新载入，不能用旧回执关闭。');
    const issues=await pp.closeFile(ref[1]);if(issues.length)throw Error(issues.join('；'));return;
   }
   await releaseDiscard(key);
  },async manage(command){
   assertAvailable();
   if(command.action==='layout'){
    if(command.mode!=='single'&&internalModels.length<2)throw Error('平铺或自由布局需要两个在主窗口中的模型。');
    flushSync(()=>{if(command.mode!=='single')setMultiMode(command.mode);setDeckMode(command.mode);if(command.arrange)setArrangeRequest(value=>value+1);});
    return {status:'configured',layout:command.mode,arrange:command.arrange};
   }
   if(command.action==='reorder'){
    const shown=read().tabs.filter(row=>row.kind==='model-tab'&&row.visible).map(row=>row.ref);
    const wanted=new Set(command.refs);if(wanted.size!==shown.length||command.refs.length!==shown.length||shown.some(id=>!wanted.has(id)))throw Error('排序范围须为当下可见模型标签的完整 ID 列表。');
    let index=0;const next=documents.map(entry=>wanted.has(entry.id)?command.refs[index++]:entry.id);
    flushSync(()=>setOrder(next));return {status:'configured',order:next};
   }
   if(!('ref'in command))throw Error('缺少标签。');
   const row=read().tabs.find(entry=>entry.ref===command.ref);if(!row)throw Error('标签已变化。');
   if(command.action==='detach'||command.action==='dock'){
    if(row.kind!=='model-tab')throw Error('此对象由自己的分析或图窗入口管理。');
    if(command.action==='dock'){
     if(!row.detached||!hostBridge?.dockWorkspaceDocument)throw Error('当前没有可停靠的独立模型。');
     return {...await hostBridge.dockWorkspaceDocument(authFor(row.ref)),ref:row.ref};
    }
    if(row.detached)throw Error('模型已经位于独立窗口。');
    const rect=tabs.current?.getBoundingClientRect();
    const target=await detachDocumentNow(row.ref,command.x??window.screenX+(rect?.right??120)+120,command.y??window.screenY+(rect?.bottom??100)+60);
    return {status:'detached',ref:row.ref,...target};
   }
   const name=command.name?.trim();
   if(command.action==='rename'&&row.kind==='model-tab'){
    if(!name)throw Error('请输入模型名。');registry.rename(row.ref,name);publishMetadata(row.ref);return {status:'configured',ref:row.ref,label:registry.document(row.ref).label};
   }
   if(row.kind!=='pes-group'&&row.kind!=='conformer-group')throw Error('待操作对象不是模型任务组。');
   if(command.action==='group-collapse'){
    if(typeof command.collapsed!=='boolean')throw Error('请指定折叠或展开。');
    if(row.kind==='pes-group')setCollapsedPesGroups(previous=>({...previous,[row.ownerId]:command.collapsed!}));
    else setConformerGroups(previous=>({...previous,[row.ownerId]:{...previous[row.ownerId],label:previous[row.ownerId]?.label??row.label,collapsed:command.collapsed!}}));
    return {status:'configured',ref:row.ref,collapsed:command.collapsed};
   }
   if(!name)throw Error('请输入任务组名称。');
   if(row.kind==='pes-group'){await pes.ensure();await pes.controller!.renameGroup(row.ownerId,name);}
   else setConformerGroups(previous=>({...previous,[row.ownerId]:{...previous[row.ownerId],collapsed:previous[row.ownerId]?.collapsed??false,label:name,labelOrigin:'manual'}}));
   return {status:'configured',ref:row.ref,label:name};
  }};
 }
 function readMcpScientificFrame(id:string){
  try{return frameAccess.current(mcpFrameContext.owner(id));}catch{return null;}
 }
 function modelContext():ModelToolContext {
  return {
   registry,tabs:mcpTabContext(),isDetached:id=>Boolean(detachedPlacement.current[id]),currentModel:()=>{const id=readMcpActiveFrameTarget();return id&&registry.getSnapshot().documents.some(row=>row.id===id)?id:undefined;},
   assertTarget(id,kind){
    if(id)mcpEntry(id);
    if(kind==='read')return;
    if(ownerHidden||closingPending||projectActivity.current.busy||projectActivity.current.capturing||restoringProject.current)throw Error('当前工作台正在关闭、恢复或保存，请完成后再操作。');
    if(importController.current||libraryLoadController.current||sourceCopyBusy.current||editChoiceInFlight.current)throw Error('当前工作台已有正在处理的来源操作。');
    if(sourcePickLive.current||selectingMembers.current)throw Error('当前工作台正在选择任务来源或关联成员。');
    if(kind==='view'&&taskWorkspace.opened)throw Error('请先切回模型工作台以显示目标。');
    if(id){
     if(closingTransactions.current.has(id))throw Error('目标模型正在关闭。');
     if(detachedPlacement.current[id]&&kind!=='data-edit')throw Error('该操作使用独立视口的现场状态。可在独立窗口完成或将模型停靠后操作。');
     if(kind==='view'&&registry.stamp().documentId!==id)throw Error('请先用 es_show 激活目标模型。');
    }
   },
   viewport:id=>viewportControllers.current.get(id),currentFrame:readMcpScientificFrame,
   display:()=>displaySettings,
   changeDisplay:changeDisplaySettings,
   createModel(label,presentation='follow'){
    let entry!:WorkspaceDocumentEntry;
    flushSync(()=>{
     const follow=presentation!=='background';
     if(follow){taskWorkspace.leave();advancedPorts.current.postprocess.selectFile(null);}
     entry=registry.addDocument(null,label,undefined,undefined,undefined,follow);
     if(follow){setMainDocumentId(entry.id);registry.setModule('modeling');setError('');}
    });
    return entry;
   },
   presentModel:(id,mode,call)=>presentConfiguredModel(id,'modeling',mode,call),
   openSketch:openTwoDManual,
   sketch:()=>twoDRuntime.current,
   captureSketchGuard:(modelRef,revision)=>captureTwoDGuard({modelRef,revision}),
   loadLibrary:loadLibraryStructure,
  };
 }

 function inputContext():InputToolsContext {
  return {entry:mcpEntry,frame:(ref,signal,electronic)=>frameAccess.readAdvancedFrame(ref,signal,electronic),
   currentFrame:readMcpScientificFrame,
   presentInput:(id,mode,call)=>presentConfiguredModel(id,'input',mode,call),
   openJobSnapshot:async(...args)=>{await openExternalSnapshot(...args);return taskSnapshotPagesRef.current[args[1]];},
   projectId:()=>projectInfo.current.project?.projectId??null,
   projectScope:()=>JSON.stringify([projectIdentityEpoch.current,projectInfo.current.project?.projectId??null])};
 }

 function scienceContext():ScienceToolsContext{
  const epoch=projectIdentityEpoch.current;
  const assertCurrent=()=>{if(projectIdentityEpoch.current!==epoch||restoringProject.current)throw Error('项目来源已变化，请从当前窗口重新定位。');};
  function targetValue(target:unknown){
   if(typeof target==='string'&&target.trimStart().startsWith('{'))
    throw toolError('invalid_arguments','计算目标对象请直接传入 JSON 对象。也可原样传 modelRef 或 frameRef 字符串。',{path:'arguments.target',forms:['modelRef','frameRef','{modelRef, revision}','{frameRef}']});
   if(target===undefined||typeof target==='string')return {ref:target as string|undefined,revision:undefined};
   if(typeof target!=='object'||target===null)throw Error('计算目标需要模型引用或帧引用。');
   const row=target as {frameRef?:unknown;modelRef?:unknown;revision?:unknown};
   if(typeof row.frameRef==='string'&&row.modelRef===undefined)return {ref:row.frameRef,revision:undefined};
   if(typeof row.modelRef==='string'&&row.frameRef===undefined&&(row.revision===undefined||typeof row.revision==='number'&&Number.isSafeInteger(row.revision)&&row.revision>=0))
    return {ref:row.modelRef,revision:row.revision as number|undefined};
   throw Error('计算目标需要模型引用或帧引用。');
  }
  async function resolveSource(target:unknown,signal?:AbortSignal,electronic?:BaseElectronicStateValues){
   assertCurrent();signal?.throwIfAborted();
   const {ref,revision}=targetValue(target),source=await mcpLiveSource(ref,signal,electronic);
   assertCurrent();signal?.throwIfAborted();
   if(revision!==undefined&&source.ref.revision!==revision)throw toolError('model-conflict','目标模型修订已变化，请重新读取。',{
    modelRef:source.ref.documentId,documentEpoch:source.ref.documentEpoch,revision:source.ref.revision,
   });
   return source;
  }
  function prepareCalculationSource(source:AdvancedFrameSource,kind:'wavefunction'|'conformer'){
   assertCurrent();
   const entry=registry.getSnapshot().documents.find(row=>row.id===source.ref.documentId&&row.epoch===source.ref.documentEpoch);
   if(entry&&(entry.store.hasTransaction?.()||closingTransactions.current.has(entry.id)))throw Error('来源模型正在编辑或关闭。');
   if(entry&&!source.ref.frameId&&!entry.result&&!entry.trajectory&&!entry.pesGroup&&!entry.analysisBinding&&
      (kind==='conformer'||!entry.conformerGroup)){
    const document=entry.store.getSnapshot();
    if(document.revision!==source.ref.revision||workspaceSourceGeometryKey(document.draft.structure)!==workspaceSourceGeometryKey(source.structure))
     throw Error('来源模型内容已变化，请重新取用。');
    if(document.electronicStateConfirmed&&document.draft.structure.charge===source.structure.charge&&document.draft.structure.multiplicity===source.structure.multiplicity)return source;
   }
   const fragment=advancedFrameFragment(source);
   const target=registry.addFragmentDocument(fragment,automaticStem(source.label)+'-model',false);
   const document=target.store.getSnapshot();
   const prepared=captureAdvancedFrame(document.draft.structure,{documentId:target.id,documentEpoch:target.epoch,revision:document.revision},
    makeDocumentStamp(document),target.label,document.sharedConstraints);
   const key=JSON.stringify(prepared.ref);
   capturedSourceGeometry.current.set(key,workspaceSourceGeometryKey(document.draft.structure));
   capturedSourceOwners.current.set(key,{documentId:target.id,epoch:target.epoch});
   return source.sourceElectronicState?{...prepared,sourceElectronicState:source.sourceElectronicState}:prepared;
  }
  return {
   resolveSource,
   async advanced(){assertCurrent();if(pendingAdvancedProject.current)await ensurePendingAdvancedProject();assertCurrent();return advancedIntegration.current.controller??undefined;},
   async pes(){assertCurrent();await pes.ensure();assertCurrent();return pes.getController()??undefined;},
   resources(){assertCurrent();const value=computeSnapshotRef.current;
    if(!value||!value.writable||value.error)throw Error('当前计算资源尚未就绪，请确认全局资源设置。');return value;},
   async startFrameOptimization(source:AdvancedFrameSource,options:ScienceOptOptions):Promise<ScienceOptSubmission>{
    assertCurrent();
    const owner=mcpFrameContext.owner(source.ref.documentId);
    const original=owner.document;
    const structure=scientificFrameForModel(source.structure);
    const document={...original,sharedConstraints:source.constraints??original.sharedConstraints,draft:{...original.draft,structure}};
    const prepared=prepareOrdinaryOptimization(readWorkspaceOptimizationPreferences(),structure,options);
    const input=ordinaryOptimizationInput(document,prepared.preferences,prepared.xtbOptions);
    await checkGxtb(prepared.method);
    await pes.ensure();
    assertCurrent();
    const retained=mcpFrameContext.owner(source.ref.documentId);
    if(retained.documentEpoch!==owner.documentEpoch||retained.sourceEpoch!==owner.sourceEpoch||retained.document.revision!==original.revision)
     throw Error('目标科学帧的来源已变化，本次尚未提交。');
    const controller=pes.getController();
    if(!controller)throw Error('势能面工作台尚未就绪。');
    const geometry:PesGeometry={documentId:owner.targetId,revision:original.revision,label:source.label,
     structure,originFrame:source.ref};
    if(prepared.sharedMethodPreferences)writeWorkspaceOptimizationPreferences(prepared.sharedMethodPreferences);
    const group=pes.createInitialGroup(geometry,document.sharedConstraints);
    const result=controller.startOrdinaryOptimization(group.id,group.initialNodeId,geometry,{...input,retainTrajectory:true});
    const runId=result.runIds.at(-1)!;
    const request=controller.getSnapshot().groups.find(row=>row.id===group.id)!.runs[runId].request;
    return {kind:'pes',...request.runIdentity,request:pesRequestEvidence(request)};
   },
   modelRuntime(target,options?:{allowInactive?:boolean}){
    assertCurrent();const {ref,revision}=targetValue(target);
    if(ref&&closingTransactions.current.has(ref))throw Error('目标模型正在关闭，本次尚未提交。');
    const entry=mcpEntry(ref),runtime=scienceModelRuntime(entry.store),currentRevision=entry.store.getSnapshot().revision;
    if(revision!==undefined&&currentRevision!==revision)throw toolError('SCIENCE_SOURCE_CHANGED','目标模型修订已变化，请重新读取。',{
     submitted:false,source:{documentId:entry.id,documentEpoch:entry.epoch,revision:currentRevision},changedFields:['revision'],
     recovery:{tool:'model_read',arguments:{modelRef:entry.id}},
    });
    if(!runtime||!options?.allowInactive&&!runtime.active())throw toolError('SCIENCE_VIEW_INACTIVE','请先定位到可运行计算的模型视图。',{
     submitted:false,targetRef:entry.id,recovery:{tool:'es_show',arguments:{target:{kind:'model',ref:entry.id}}},
    });
    return runtime;
   },
   runtimes(){assertCurrent();return registry.getSnapshot().documents.flatMap(entry=>{const runtime=scienceModelRuntime(entry.store);return runtime?[runtime]:[];});},
   bindConformerTask(taskId,source){assertCurrent();bindConformerTask(taskId,source,source.ref.documentId,false);},
   readConformerSource(taskId){assertCurrent();return captureConformerInitial(taskId);},
   registerPesNode(groupId,node){assertCurrent();return pes.register(groupId,node);},
   readPesScanGeometry(groupId:string){
    assertCurrent();
    const active=registry.getSnapshot().documents.find(entry=>entry.id===readMcpActiveFrameTarget());
    if(!active||active.pesGroup?.groupId!==groupId||registry.getSnapshot().module!=='advanced'||advancedSectionRef.current!=='path')return undefined;
    return currentPesCanvas(pesCanvasesRef.current,active)?.readScanGeometry?.();
   },
   presentPesConfiguration,
   async presentConformerConfiguration(taskId:string,mode:McpPresentationMode,call?:McCall){
    const gated=configurationPresentationGate(mode,call);
    if(gated)return gated;
    return coreContext.show({target:{kind:'task',ref:taskId},presentation:mode},call);
   },
   pesTarget(groupId,nodeId){assertCurrent();return registry.getSnapshot().documents.find(entry=>entry.pesGroup?.groupId===groupId&&entry.pesGroup?.nodeId===nodeId)?.id;},
   presentFollow(run,mode,call){
    assertCurrent();const live=mcpPresentationOrigin(),original=call?.presentationOrigin;
    if(mode==='background')return {mode,status:'background',...live};
    if(original&&!sameMcpPresentation(original,live))
     return {mode,status:'superseded',...live};
    return coreContext.show({target:{kind:'run',ref:run.runId},presentation:mode},call);
   },
   prepareWavefunctionSource:async source=>prepareCalculationSource(source,'wavefunction'),
   prepareConformerSource:async source=>prepareCalculationSource(source,'conformer'),
   wavefunctionSettings:ownerId=>xtbMethodDrafts[ownerId],
   onWavefunctionTask(ownerId,selection){assertCurrent();setXtbTaskSelections(previous=>({...previous,[ownerId]:selection}));},
  };
 }

 const settingsEntry=state.documents.find(entry=>entry.id===displayedDocumentId);
 const settingsModel=settingsEntry?(analysisCanvases[settingsEntry.id]?.document??settingsEntry.store.getSnapshot()):null;
 const citationIdentity=()=>{const pp=advancedPorts.current.postprocess,files=pp.captureFileDocuments();return JSON.stringify([projectIdentityEpoch.current,registry.getSnapshot().documents.map(entry=>[entry.id,entry.epoch,entry.sourceEpoch,entry.store.getSnapshot().revision,entry.store.getSnapshot().analysisBindingId,entry.store.getSnapshot().draft.structure.preparation?.xtb,entry.store.getSnapshot().draft.structure.preparation?.xtb?entry.store.getSnapshot().draft.structure.preparation?.after:undefined,entry.store.getSnapshot().draft.structure.preparation?.xtb?entry.store.getSnapshot().draft.structure.preparation?.unit:undefined]),pp.fileOwnerId,Object.values(files).map(value=>postprocessFileDocumentVersion(value)),scientificFileCitationIdentity(files),getAnalysisProjectRevision(),retainedCitationAnalysisInstances(projectUi.capture()),readAdvanced(),pes.readRevision(),citationStateRef.current.inputReceipts.map(f=>[f.id,f.purpose])]);};
 async function captureWorkspaceCitations(documentId?:string){
  const documents=registry.getSnapshot().documents,pp=advancedPorts.current.postprocess,fileDocuments=pp.captureFileDocuments(),ownerIds=retainedCitationOwnerIds(documents,fileDocuments);
  const identity=citationIdentity();
  if(documentId&&!ownerIds.includes(documentId))throw new Error('独立文档的owner已关闭，未打开文献导出。');
  const analysis=await captureAnalysisCitationSnapshots();
  if(documents.some(entry=>!registry.getSnapshot().documents.some(current=>current.id===entry.id&&current.epoch===entry.epoch)))throw new Error('项目文档已变化，请重新打开文献导出。');
  const advanced=pendingAdvancedProject.current?await pendingAdvancedProject.current():advancedController?.getSnapshot();
  const generated=Object.entries(postprocess.generated).flatMap(([analysisId,row])=>
   documents.some(doc=>doc.id===row.ownerId)&&xtbWorkingAnalysisAvailable(row.ownerId,analysisId)?[row]:[]);
  const facts=collectWorkspaceCitationFacts({documents,fileDocuments,postprocessDocuments:postprocess.documents,additionalPostprocessDocuments:generated.map(row=>({documentId:row.ownerId,document:row.document})),inputReceipts:citationStateRef.current.inputReceipts,analysis,analysisInstances:retainedCitationAnalysisInstances(projectUi.capture(),Object.fromEntries(generated.map(row=>[row.document.id,row.ownerId]))),advanced});
  const pesWarnings:string[]=[];
  if(pes.pending.current){
   const pesSnapshot=await pes.citationSnapshot().catch(cause=>{pesWarnings.push('势能面引用暂不可用：'+(cause instanceof Error?cause.message:String(cause)));return undefined;});
   facts.push(...collectPesCitationFacts(pesSnapshot));
  }else if(pes.controller?.getSnapshot().groups.length)facts.push(...collectPesCitationFacts(pes.controller.getSnapshot()));
  const twoDFacts=await readCommittedTwoDCitationFacts(documents.map(entry=>entry.id));facts.push(...twoDFacts.facts);
  if(identity!==citationIdentity())throw new Error('项目文档已变化，请重新打开文献导出。');
  return {documentId:documentId??(registry.getSnapshot().module==='analysis'?pp.fileOwnerId:null)??displayedDocumentId??undefined,facts,warnings:[...analysis.flatMap(entry=>entry.warning?[entry.warning]:[]),...twoDFacts.warnings,...pesWarnings],identity,retainedDocumentIds:ownerIds,decisions:citationStateRef.current.decisions,assertCurrent:()=>{if(identity!==citationIdentity())throw Error('引用来源已变化，请重新取用。');}};
 }
 citationOpenAction.current=async documentId=>{
  setCitationOpen({...await captureWorkspaceCitations(documentId),fixed:Boolean(documentId)});
 };
 const resultRegistry=useResultsMcp();

 const [batchReceipts]=useState(()=>new Map<string,BatchReceipt>());
 useEffect(()=>mcpChanges.follow(registry),[mcpChanges,registry]);
 useEffect(()=>mcpChanges.followRuns(()=>{
  const ordinary=registry.getSnapshot().documents.flatMap(entry=>(scienceModelRuntime(entry.store)?.runs()??[]).map(run=>({
   runId:run.runId,status:run.status,phase:run.scientificStatus,version:JSON.stringify([run.nativeStarted,run.workerSettled,run.progress,run.resultAdoption]),
  })));
  const advanced=(advancedController?.getSnapshot().tasks??[]).flatMap(task=>task.runs.map(run=>({runId:run.id,status:run.status,
   phase:run.backgroundProgress?.phase??run.intent,version:JSON.stringify([run.subjobCount,run.backgroundProgress,run.sampling?.progress,run.stages.filter(stage=>stage.status==='running').map(stage=>[stage.id,stage.progress])]),
  })));
  const paths=(pes.getController()?.getSnapshot().groups??[]).flatMap(group=>Object.values(group.runs).map(run=>({runId:run.request.runIdentity.runId,status:run.status,
   phase:run.progress?.stage??run.preview?.phase,version:String(run.lastSeq),
  })));
  return [...ordinary,...advanced,...paths];
 },notify=>{
  const subscriptions=new Map<WorkspaceDocumentEntry['store'],()=>void>();
  const sync=()=>{
   const live=new Set(registry.getSnapshot().documents.map(entry=>entry.store));
   for(const [store,release]of subscriptions)if(!live.has(store)){release();subscriptions.delete(store);}
   for(const store of live)if(!subscriptions.has(store)){const release=scienceModelRuntime(store)?.subscribe?.(notify);if(release)subscriptions.set(store,release);}
   notify();
  };
  const release=registry.subscribe(sync),releaseAdvanced=advancedController?.subscribe(notify),releasePaths=pes.getController()?.subscribe(notify);sync();
  return ()=>{release();releaseAdvanced?.();releasePaths?.();for(const dispose of subscriptions.values())dispose();};
 }),[mcpChanges,registry,advancedController,pes.controller]);
 useEffect(()=>followInputChanges(registry,(id,version)=>mcpChanges.record({kind:'input',target:id,version,fields:['draft']})),[mcpChanges,registry]);
 useEffect(()=>resultRegistry?.watchPlots((id,revision)=>mcpChanges.record({kind:revision===undefined?'plot-closed':'plot',target:id,revision,fields:['figure']})),[resultRegistry,mcpChanges]);
 const mcpProjectEpoch=projectIdentityEpoch.current;
 useLayoutEffect(()=>{batchReceipts.clear();mcpChanges.record({kind:'project',target:projectInfo.current.project?.projectId??'unsaved'});},[mcpProjectEpoch,batchReceipts,mcpChanges]);
 function mcpEntry(ref?:string){
  const id=ref??readMcpActiveFrameTarget();
  if(!id||closingTransactions.current.has(id))throw Error('当前没有可用的模型文档。');
  return registry.document(id);
 }
 async function mcpLiveSource(ref?:string,signal?:AbortSignal,electronic?:BaseElectronicStateValues){
  signal?.throwIfAborted();
  if(ref&&isFrameReference(ref))return frameAccess.readAdvancedFrame(ref,signal,electronic);
  if(ref){
   const entry=mcpEntry(ref),snapshot=entry.store.getSnapshot(),epoch=projectIdentityEpoch.current;
   if(entry.result||entry.trajectory)throw Error('该对象是只读轨迹，请通过 frames_select 指定帧。');
   const stale=()=>{const actual=mcpEntry(ref);if(epoch!==projectIdentityEpoch.current||actual.epoch!==entry.epoch||actual.store.getSnapshot().revision!==snapshot.revision||actual.store.hasTransaction?.())throw Error('目标模型在读取期间变化。');};
   stale();const params={document:snapshot,documentEpoch:entry.epoch,label:entry.label,guard:stale,signal};
   return electronic?confirmFrameElectronicState(await captureWorkspaceElectronicSourceContext(params),electronic):captureWorkspaceAdvancedSource(params);
  }
  const owner=mcpFrameContext.owner();
  const frame=frameAccess.current(owner);
  if(!frame)throw Error('该轨迹尚未确定当前帧，请从 frames_select 选择。');
  return frameAccess.readAdvancedFrame(frame.frameRef,signal,electronic);
 }
 function mcpFileJob(ref:string){
  if(!ref.startsWith('["es-file-job",'))return;
  const tuple=JSON.parse(ref) as unknown;
  if(!Array.isArray(tuple)||tuple.length!==3||typeof tuple[1]!=='string'||typeof tuple[2]!=='string')throw Error('文件作业引用无效。');
  const file=advancedPorts.current.postprocess.captureFileDocuments()[tuple[1]],job=file?.output.source.jobs.find(row=>row.id===tuple[2]);
  if(!file||!job)throw Error('文件作业来源已关闭或替换。');
  return {file,job};
 }
 function mcpResult(ref?:string):ReturnType<ResultToolsContext['getResult']>{
  const pp=advancedPorts.current.postprocess,files=pp.captureFileDocuments(),id=ref??readMcpActiveFrameTarget();
  if(!id)throw Error('没有活动结果。');
  const fileJob=mcpFileJob(id);
  if(fileJob){const {file,job}=fileJob,selected=file.output.source.selectedJobId===job.id;return {ownerId:file.id,navigationRef:id,file,result:job,postprocess:selected?fileDisplayDocument(file)??undefined:undefined};}
  const file=files[id]??Object.values(files).find(x=>x.displayResult?.id===id||x.output.source.identity.id===id);
  if(file)return {ownerId:file.id,file,postprocess:fileDisplayDocument(file)??undefined,result:file.displayResult??undefined};
  const generated=pp.generated[id]??Object.values(pp.generated).find(row=>row.document.result?.id===id);
  if(generated){
   if(!xtbWorkingAnalysisAvailable(generated.ownerId,generated.document.id))throw Error('该波函数分析来源已变更。');
   return {ownerId:generated.ownerId,navigationRef:generated.document.id,result:generated.document.result,postprocess:generated.document};
  }
  const diagnostic=sourceDiagnostics.find(row=>row.id===id);
  if(diagnostic)return {ownerId:diagnostic.id,result:diagnostic};
  const docs=registry.getSnapshot().documents,pesGroups=pes.getController()?.getSnapshot().groups??[];
  const exactRunOwner=pesGroups.find(group=>group.runs[id]?.workerSettled===true&&group.runs[id].result?.hessian);
  const exactRun=exactRunOwner?.runs[id];
  const exactNodeOwner=!exactRun&&pesGroups.find(group=>group.nodes.some(node=>node.id===id));
  const exactGroupId=exactRunOwner?.id||(exactNodeOwner?exactNodeOwner.id:undefined);
  const exactNodeId=exactRun?.nodeId??(exactNodeOwner?id:undefined);
  const entry=docs.find(row=>row.id===id||[row.result,row.legacyResult,pp.getDocument(row.id)?.result].some(result=>result&&(result.id===id||result.source.id===id)))??
   docs.find(row=>exactGroupId&&row.pesGroup?.groupId===exactGroupId&&row.pesGroup.nodeId===exactNodeId);
  if(!entry)throw Error('当前项目没有此结果。');
  const binding=registry.analysisAvailable(entry.id)?pp.getDocument(entry.id):undefined;
  if(id===entry.id&&(!entry.result&&!entry.legacyResult&&!binding||state.module==='advanced'&&advancedSection==='xtb2')){
   const selection=xtbTaskSelections[entry.id],selected=selection?.runId?advancedAnalysisBindings[`${selection.taskId}:${selection.runId}`]:xtbAnalysisSelections[entry.id];
   const available=Object.values(pp.generated).filter(row=>row.ownerId===entry.id&&xtbWorkingAnalysisAvailable(entry.id,row.document.id));
   const analysis=available.find(row=>row.document.id===selected)??(available.length===1?available[0]:undefined);
   if(analysis)return {ownerId:entry.id,navigationRef:analysis.document.id,result:analysis.document.result,postprocess:analysis.document};
  }
  const result=entry.result??(registry.analysisAvailable(entry.id)?entry.legacyResult??binding?.result:undefined);
  const link=entry.pesGroup,group=link&&pesGroups.find(row=>row.id===link.groupId);
  const node=group?.nodes.find(row=>row.id===link?.nodeId);
  const displayed=mcpFramePorts.current?.canvas(entry.id);
  const origin=displayed?.result?.frames[displayed.frameIndex??0]?.pesOrigin;
  const selectedRunId=origin?.nodeId===node?.id?origin?.runId:node?.selection?.runId;
  const relatedRuns=group&&node?[...new Set(node.runIds)].map(runId=>group.runs[runId]).filter(run=>run?.workerSettled===true&&run.result?.hessian&&!run.supersededByRunId):[];
  const hessianRun=exactRun&&exactGroupId===link?.groupId&&exactNodeId===link?.nodeId?exactRun:
   relatedRuns.find(run=>run.request.runIdentity.runId===selectedRunId)??(relatedRuns.length===1&&(!selectedRunId||id===node?.id)?relatedRuns[0]:undefined);
  return {ownerId:entry.id,result,postprocess:binding,hessianRunId:hessianRun?.request.runIdentity.runId};
 }
 async function mcpOpenAnalysis(ref:string){
  if(sourcePickLive.current||selectingMembers.current)throw Error('请先结束当前的来源选择。');
  const pp=advancedPorts.current.postprocess;
  if(sourceDiagnostics.some(row=>row.id===ref)){setDiagnosticsOpen(true);return;}
  taskWorkspace.leave();
  const target=mcpFileJob(ref);
  if(target){
   const {file,job}=target;
   flushSync(()=>{pp.selectFile(file.id);registry.setModule('analysis');registry.invalidateActivation();});
   if(file.output.source.selectedJobId!==job.id)await pp.selectFileJob(file.id,job.id);
   if(pp.captureFileDocuments()[file.id]?.output.source.selectedJobId!==job.id)throw Error('作业仍由原来源持有，当前窗口尚未切换。');
   return;
  }
  if(pp.captureFileDocuments()[ref]){
   flushSync(()=>{pp.selectFile(ref);registry.setModule('analysis');registry.invalidateActivation();});return;
  }
  const generated=pp.generated[ref];
  const id=generated?.ownerId??ref;mcpEntry(id);
  if(generated&&!xtbWorkingAnalysisAvailable(id,ref))throw Error('该波函数分析来源已变更。');
  activateDocument(id);
  if(generated){
   const run=generated.document.wavefunction?.source.generatedXtb?.runIdentity;
   flushSync(()=>{
    if(run&&advancedAnalysisBindings[`${run.taskId}:${run.runId}`]===ref)
     setXtbTaskSelections(previous=>({...previous,[id]:{taskId:run.taskId,runId:run.runId}}));
    registry.setModule('advanced');setAdvancedSection('xtb2');
   });
  }
  else flushSync(()=>{if(!mcpEntry(id).result&&!mcpEntry(id).legacyResult&&!pp.getDocument(id))setStructureAnalysisSelected(previous=>({...previous,[id]:true}));registry.setModule('analysis');});
 }
 function fileContext():WorkspaceFileContext{
  return {importFiles,postprocess:()=>advancedPorts.current.postprocess,
   attachmentEpoch:()=>projectIdentityEpoch.current,
   modelAttachmentOwners:()=>registry.getSnapshot().documents.flatMap(entry=>{
    const pp=advancedPorts.current.postprocess,document=pp.getDocument(entry.id);
    if(!document||!registry.analysisAvailable(entry.id)||closingTransactions.current.has(entry.id))return [];
    return [{ownerId:entry.id,document,aliases:[entry.result?.id,entry.result?.source.id,entry.legacyResult?.id,entry.legacyResult?.source.id],
     assertCurrent(){
      const current=mcpEntry(entry.id);
      if(current.epoch!==entry.epoch||current.sourceEpoch!==entry.sourceEpoch||!registry.analysisAvailable(entry.id)||advancedPorts.current.postprocess.getDocument(entry.id)!==document)throw Error('目标模型的分析来源已关闭、失效或替换，附件未接入。');
     }}];
   }),
   async captureStructure(target,signal){
    signal.throwIfAborted();
    const epoch=projectIdentityEpoch.current;
    const assertProject=()=>{if(projectIdentityEpoch.current!==epoch)throw Error('导出所属项目已变化。');};
    async function exactFrame(ref:string){
     const identity=JSON.parse(ref) as unknown;
     if(!Array.isArray(identity)||identity[0]!=='es-frame-v1'||typeof identity[1]!=='string')throw Error('帧引用无效，请重新选择。');
     const targetId=identity[1],collectionId=typeof identity[2]==='string'?identity[2]:undefined;
     const before=frameAccess.context().owner(targetId,collectionId);
     const snapshot=await frameAccess.readScientificFrame(ref,signal);
     const assertCurrent=()=>{
      assertProject();
      const current=frameAccess.context().owner(targetId,collectionId);
      if(current.documentEpoch!==before.documentEpoch||current.sourceEpoch!==before.sourceEpoch||current.document.revision!==before.document.revision||current.collection?.revision!==before.collection?.revision)throw Error('所选帧的来源或文档已变化。');
     };
     assertCurrent();
     return {document:captureStructureExportDocument(before.document,snapshot.structure),source:{...snapshot.ref,frameRef:ref},assertCurrent};
    }
    if(target?.startsWith('['))return exactFrame(target);
    const id=target??readMcpActiveFrameTarget();
    if(!id)throw Error('当前窗口没有结构或科学来源。');
    const selectedFile=advancedPorts.current.postprocess.captureFileDocuments()[id];
    if(selectedFile){
     const port=fileStructureExports.current.get(id);
     if(port?.source===selectedFile&&port.port.capture){
      const captured=port.port.capture();
      return {document:captured.document,source:{targetId:id,name:captured.name,source:selectedFile.output.source.identity,jobId:selectedFile.output.source.selectedJobId},assertCurrent:()=>{assertProject();captured.assertCurrent();}};
     }
     const owner=frameAccess.context().owner(id),current=frameAccess.current(owner);
     if(!current)throw Error('指定科学文件没有可导出的完整结构或已选帧。');
     return exactFrame(current.frameRef);
    }
    const entry=mcpEntry(id),model=entry.store.getSnapshot(),projection=displaySources.current.get(id)?.projection;
    const assertCurrent=()=>{
     assertProject();
     const current=mcpEntry(id);
     if(current.epoch!==entry.epoch||current.sourceEpoch!==entry.sourceEpoch||current.store.getSnapshot().revision!==model.revision)throw Error('导出所属模型或来源已变化。');
    };
    if(projection?.documentId===id&&projection.revision===model.revision&&projection.exportDocument){
     const shown=projection.exportDocument;
     return {document:captureStructureExportDocument(shown,presentedVibrationStructure(shown.draft.structure)),source:{
      targetId:id,documentEpoch:entry.epoch,revision:model.revision,sourceId:projection.sourceId,sourceRevision:projection.sourceRevision,displayedSource:projection.exportSourceIdentity,
     },assertCurrent};
    }
    const owner=frameAccess.context().owner(id),current=frameAccess.current(owner);
    if(owner.result){if(!current)throw Error('指定科学帧尚未准备完整。');return exactFrame(current.frameRef);}
    return {document:captureStructureExportDocument(model),source:{targetId:id,documentEpoch:entry.epoch,revision:model.revision},assertCurrent};
   }};
 }
 const mcpFiles=createWorkspaceFileActions(fileContext());
 const coreContext:CoreToolContext={
  registry,changes:mcpChanges,batchReceipts,project:()=>projectInfo.current.currentProject(),save:(asNew,target)=>projectInfo.current.save(asNew,false,target,true),
  reopen:options=>{
   if(projectRunning.current)throw toolError('project_running','项目仍有运行中的计算，请在结算后重开。');
   return projectInfo.current.reopen(options);
  },
  tools:()=>mcpCatalog,
  readContext(){
   const snapshot=registry.getSnapshot(),id=readMcpActiveFrameTarget(),entry=snapshot.documents.find(doc=>doc.id===id),model=entry?.store.getSnapshot();
   let frame=null,frameIssue:string|undefined;
   try{frame=frameAccess.current(mcpFrameContext.owner(id));}catch(error){frameIssue=error instanceof Error?error.message:String(error);}
   const canvas=id?mcpFramePorts.current?.canvas(id):undefined;
   const current=projectInfo.current;
   const saved=current.currentProject();
   const task=taskWorkspace.isOpen()?taskWorkspace.currentSelection():snapshot.module==='input'?snapshot.inputTask??null:
    snapshot.module==='advanced'?(entry?.conformerGroup??entry?.pesGroup??(id?xtbTaskSelections[id]:null)??null):entry?.runtime??null;
   return {project:{projectId:saved?.projectId??null,path:saved?.indexPath??null,dirty:current.dirty,saving:current.busy,recovered:saved?.recovered??false,writeProtection:saved?.writeProtection??null},task,
    module:taskWorkspace.isOpen()?'tasks':snapshot.module,viewId:snapshot.activeViewId,activeTarget:id??null,
    activeDocumentId:entry?.id??null,displayedDocumentId:postprocess.currentFile&&snapshot.module==='analysis'?postprocess.currentFile.id:displayedDocumentId,
    model:entry&&model?{modelRef:entry.id,label:entry.label,revision:model.revision,epoch:entry.epoch,selection:model.selection,
     charge:model.draft.structure.charge,multiplicity:model.draft.structure.multiplicity,atomCount:model.draft.structure.atoms.length}:null,
    frame,frameIssue,playback:canvas?.trajectoryPlayback?viewTrajectoryCanvas(canvas):null,sketch:twoDFileRef.current?.id??null};
  },
  async objects(kind){
   const rows:Array<{kind:string;ref:string;label:string;[key:string]:unknown}>=[];
   const pp=advancedPorts.current.postprocess,project=projectInfo.current.project;
   if(project)rows.push({kind:'project',ref:project.projectId,label:project.indexPath});
   for(const entry of registry.getSnapshot().documents){
    const model=entry.store.getSnapshot();
    rows.push({kind:'model',ref:entry.id,label:entry.label,revision:model.revision,epoch:entry.epoch});
    for(const run of scienceModelRuntime(entry.store)?.runs()??[])rows.push({kind:'run',ref:run.runId,label:run.kind,modelRef:entry.id,status:run.status});
    const result=entry.result??(registry.analysisAvailable(entry.id)?entry.legacyResult??pp.documents[entry.id]?.result:undefined);
    if(result){
     rows.push({kind:'result',ref:result.id,label:result.label,ownerId:entry.id,frameCount:result.frames.length});
     rows.push({kind:'collection',ref:entry.id,targetId:entry.id,label:result.label,collectionId:result.id,...entry.trajectory?.identity,frameCount:result.frames.length});
    }
   }
   for(const file of Object.values(pp.captureFileDocuments())){
    rows.push({kind:'source',ref:file.id,label:file.output.source.identity.name,sourceId:file.output.source.identity.id});
    if(file.displayResult)rows.push({kind:'collection',ref:file.id,targetId:file.id,collectionId:file.displayResult.id,label:file.displayResult.label,frameCount:file.displayResult.frames.length});
    for(const job of file.output.source.jobs)rows.push({kind:'file-job',ref:JSON.stringify(['es-file-job',file.id,job.id]),label:job.label,jobId:job.id,ownerId:file.id,sourceId:file.output.source.identity.id,jobIndex:job.jobIndex});
   }
   for(const row of Object.values(pp.generated))rows.push({kind:'result',ref:row.document.id,label:row.document.result.label,ownerId:row.ownerId});
   for(const row of sourceDiagnostics)rows.push({kind:'diagnostic',ref:row.id,label:row.source.name});
   for(const [id,row] of resultRegistry?.plots??[])rows.push({kind:'plot',ref:id,label:row.port.read().title,revision:row.revision});
   for(const [id,row] of batchReceipts)rows.push({kind:'batch',ref:id,label:row.action,status:row.status});
   for(const task of advancedIntegration.current.controller?.getSnapshot().tasks??[]){
    rows.push({kind:'task',ref:task.id,label:task.spec.kind});
    for(const run of task.runs){
     rows.push({kind:'run',ref:run.id,label:task.spec.kind,taskId:task.id,status:run.status});
     if(task.mixedSampling&&run.frames.length&&!['queued','running','stopping'].includes(run.status))rows.push({kind:'collection',
      ref:conformerRunCollectionRef(task.id,run.id),label:`构象保留帧 · ${run.id.slice(-8)}`,taskId:task.id,runId:run.id,collectionId:conformerRunCollectionId(run.id),frameCount:run.frames.length});
    }
   }
   for(const group of pes.getController()?.getSnapshot().groups??[]){
    for(const node of group.nodes)rows.push({kind:'pes-node',ref:node.id,label:node.name,groupId:group.id});
    for(const card of group.cards)rows.push({kind:'pes-card',ref:card.id,label:card.name,groupId:group.id});
    for(const run of Object.values(group.runs)){
     const runId=run.request.runIdentity.runId;
     const target=registry.getSnapshot().documents.find(entry=>entry.pesGroup?.groupId===group.id&&entry.pesGroup?.nodeId===run.nodeId);
     rows.push({kind:'run',ref:runId,label:run.request.operation,nodeId:run.nodeId,groupId:group.id,status:run.status,targetId:target?.id});
     if(target)for(const record of pesPathRecords(run))if(record.frames.length)rows.push({kind:'collection',ref:pesRecordRef(target.id,record.id),targetId:target.id,collectionId:record.id,
      ownerId:target.id,groupId:group.id,runId,label:`${run.request.operation} · ${record.phase} · ${record.step}`,frameCount:record.frames.length});
     const retainedOpt=target&&retainedOptimizationCollection(run);
     if(target&&retainedOpt)rows.push({kind:'collection',ref:retainedOpt.collectionRef,targetId:target.id,collectionId:retainedOpt.collectionId,
      label:'优化保留轨迹',ownerId:target.id,groupId:group.id,runId,frameCount:run.result?.frames.length??0});
     else if(target&&run.request.operation==='opt'&&run.result){
      const port=mcpFramePorts.current,trajectory=(port?.canvas(target.id)??port?.retainedCanvas?.(target.id))?.result;
      if(trajectory?.frames.length&&trajectory.frames[0].pesOrigin?.runId===runId)rows.push({kind:'collection',ref:target.id,targetId:target.id,
       collectionId:trajectory.id,label:trajectory.label,ownerId:target.id,groupId:group.id,runId,frameCount:trajectory.frames.length});
     }
    }
   }
   if(kind==='job'){const {tasks}=await taskWorkspace.bridge.request('center.read',{});
    for(const task of tasks)rows.push({kind:'job',ref:task.taskId,label:task.displayName,runId:task.runId,executionState:task.executionState,verificationState:task.verificationState});}
   return rows;
  },
  async show(args,call){
   const target=typeof args.target==='string'?{ref:args.target}:args.target as {ref?:string;kind?:string};
   if(!target?.ref)throw Error('请选择目标对象。');
   const ref=target.ref,mode=presentationMode(args);
   const origin=mcpPresentationOrigin();
   const superseded=()=>{const live=mcpPresentationOrigin();return {target:ref,status:'superseded',...live};};
   const current=()=>{call?.signal.throwIfAborted();return sameMcpPresentation(origin,mcpPresentationOrigin());};
   const reveal=(id?:string)=>presentWorkspaceWindow(mode,id&&ownerAdapters.current.get(id)?.getState().membership?id:undefined);
   const background=()=>({target:ref,status:'background',activeTarget:readMcpActiveFrameTarget(),module:registry.getSnapshot().module});
   const unavailable=()=>toolError('target_unavailable','当前窗口没有指定类型和身份的目标。',{
    ref,kind:target.kind,committed:false,recovery:{tool:'es_targets',arguments:{query:ref,...(target.kind?{kind:target.kind}:{})}},
   });
   const assertShowAllowed=()=>{if(sourcePickLive.current||selectingMembers.current)throw Error('请先结束当前的来源选择。');};
   const waitFor=args.waitFor==='scene'?'scene':'selected';
   async function showTrajectory(owner:ReturnType<typeof mcpFrameContext.owner>,index:number){
    const outcome=await mcpFrameContext.view(owner,{action:'seek',index},undefined,call?.signal,waitFor) as Record<string,unknown>;
    const nativeView=outcome.status==='superseded'?undefined:await reveal(owner.targetId);
    return {target:ref,...outcome,requestedFrame:frameAccess.describe(owner,index),nativeView};
   }
   if(target.kind==='frame'||isFrameReference(ref)){
    if(target.kind&&target.kind!=='frame')throw unavailable();
    const {owner,index,guard}=await frameAccess.reference(ref,call?.signal);
    if(mode==='background')return {...background(),frame:frameAccess.describe(owner,index)};
    if(!current())return superseded();
    assertShowAllowed();guard();
    if(index!==undefined)return showTrajectory(owner,index);
    taskWorkspace.leave();activateDocument(owner.targetId);flushSync(()=>registry.setModule('modeling'));
    const nativeView=await reveal(owner.targetId);
    return {target:ref,targetId:owner.targetId,frame:frameAccess.describe(owner),status:nativeView?.view==='detached'?'located':
     readMcpActiveFrameTarget()===owner.targetId?'selected':'view-unavailable',activeTarget:readMcpActiveFrameTarget(),module:registry.getSnapshot().module,nativeView};
   }
   const matches=(await coreContext.objects(target.kind)).filter(item=>item.ref===ref&&(!target.kind||item.kind===target.kind));
   const collectionMatches=matches.filter(item=>item.kind==='collection');
   if(target.kind==='collection'&&collectionMatches.length>1)throw toolError('ambiguous_target','此引用对应多个轨迹集合，请使用确切的集合引用。',{
    ref,kind:target.kind,collections:collectionMatches,committed:false,
   });
   const row=matches[0]??(!target.kind?(await coreContext.objects('job')).find(item=>item.ref===ref):undefined);
   if(!row)throw unavailable();
   if(mode==='background')return {...background(),kind:row.kind};
   if(!current())return superseded();
   assertShowAllowed();
   if(row.kind==='pes-card'){
    const group=pes.getController()?.getSnapshot().groups.find(item=>item.id===row.groupId);
    const node=group?.nodes.find(item=>item.id===group.activeNodeId)??group?.nodes.find(item=>item.id===group.initialNodeId);
    if(!group||!node)throw unavailable();
    return presentPesConfiguration(group.id,node,ref,mode,call);
   }
   if(row.kind==='plot'&&resultRegistry?.plots.has(ref)){
    const plot=resultRegistry.plots.get(ref)!;
    return {...await showNativeResultPlot({resultRegistry,getResult:mcpResult,openAnalysis:mcpOpenAnalysis},ref,call?.signal),nativeView:await reveal(plot.ownerId)};
   }
   if(row.kind==='job'){taskWorkspace.openTask(ref);return {target:ref,status:'requested',nativeView:await reveal()};}
   if(row.kind==='collection'){
    const collectionId=String(row.collectionId),targetId=parseConformerRunCollectionRef(ref)||parseOptimizationCollectionRef(ref)||ref.startsWith('["es-pes-record-v1",')?ref:String(row.targetId??ref);
    const prepared=await mcpFrameContext.prepareOwner?.(targetId,collectionId,call?.signal);
    const owner=mcpFrameContext.owner(prepared?.targetId??targetId,prepared?.collectionId??collectionId);
    if(!current())return superseded();
    if(!owner.result?.frames.length)throw unavailable();
    return showTrajectory(owner,owner.currentIndex??0);
   }
   taskWorkspace.leave();
   if(row.kind==='model'){mcpEntry(ref);activateDocument(ref);navigateModule((args.module??'modeling') as typeof state.module);}
   else if(['result','source','diagnostic'].includes(row.kind)){const resolved=mcpResult(ref);await mcpOpenAnalysis(resolved.navigationRef??resolved.ownerId);}
   else if(row.kind==='file-job')await mcpOpenAnalysis(ref);
   else if(row.kind==='run'&&row.modelRef){activateDocument(String(row.modelRef));flushSync(()=>registry.setModule('modeling'));}
   else if(row.kind==='pes-node'||row.kind==='run'&&row.nodeId){const group=pes.getController()?.getSnapshot().groups.find(g=>g.id===row.groupId),node=group?.nodes.find(n=>n.id===(row.nodeId??ref));if(!group||!node)throw Error('势能面节点已关闭。');activatePesNode(group.id,node);}
   else if(row.kind==='task'||row.kind==='run'){const taskId=row.taskId??ref,entry=registry.getSnapshot().documents.find(e=>e.conformerGroup?.taskId===taskId&&e.conformerGroup.role==='initial')??registry.getSnapshot().documents.find(e=>xtbTaskSelections[e.id]?.taskId===taskId);if(!entry)throw Error('此任务目前没有绑定可显示的文档。');activateDocument(entry.id);flushSync(()=>{registry.setModule('advanced');setAdvancedSection(entry.conformerGroup?'conformer':'xtb2');});}
   else if(row.kind!=='project')throw Error('该对象没有独立视图。');
   const nativeView=await reveal(row.kind==='model'?ref:undefined);
   return {target:ref,status:nativeView?.view==='detached'?'located':'selected',activeTarget:readMcpActiveFrameTarget(),module:registry.getSnapshot().module,activeViewId:registry.getSnapshot().activeViewId,nativeView};
  },
  importFiles:(a,c,attach)=>mcpFiles.importFiles(a,c,attach),
  exportFile:(a,c)=>mcpFiles.exportFile(a,c)
 };
 function mcpPresentationOrigin(){
  const snapshot=registry.getSnapshot(),tasksOpen=taskWorkspace.isOpen();
  return {projectEpoch:String(projectIdentityEpoch.current),activationEpoch:snapshot.activationEpoch,
   module:tasksOpen?'tasks':snapshot.module==='advanced'?['advanced',advancedSectionRef.current].filter(Boolean).join(':'):snapshot.module,
   activeTarget:(tasksOpen?taskWorkspace.currentSelection().taskId:readMcpActiveFrameTarget())??null};
 }
 function sameMcpPresentation(a:ReturnType<typeof mcpPresentationOrigin>,b:ReturnType<typeof mcpPresentationOrigin>){
  return a.projectEpoch===b.projectEpoch&&a.activationEpoch===b.activationEpoch&&a.module===b.module&&a.activeTarget===b.activeTarget;
 }
 function configurationPresentationGate(mode:McpPresentationMode,call?:McCall){
  const live=mcpPresentationOrigin();
  if(mode==='background')return {mode,status:'background',...live};
  if(call?.signal.aborted||call?.presentationOrigin&&!sameMcpPresentation(call.presentationOrigin,live))
   return {mode,status:'superseded',...live};
 }
 async function presentConfiguredModel(id:string,module:'modeling'|'input',mode:McpPresentationMode,call?:McCall){
  const gated=configurationPresentationGate(mode,call);
  if(gated)return gated;
  if(module!=='input')return coreContext.show({target:{kind:'model',ref:id},module,presentation:mode},call);
  mcpEntry(id);
  flushSync(()=>{
   taskWorkspace.leave();
   activateDocument(id);
   registry.setModule('input');
  });
  const live=registry.getSnapshot();
  const actual=readMcpActiveFrameTarget();
  if(live.module!=='input'||actual!==id)
   return {mode,status:'view-unavailable',target:id,activeTarget:actual,module:live.module};
  return {mode,status:'selected',target:id,activeTarget:actual,module:live.module,
   nativeView:mode==='foreground'?await presentWorkspaceWindow(mode):undefined};
 }
 async function presentPesConfiguration(groupId:string,node:PesNode,cardId:string|undefined,mode:McpPresentationMode,call?:McCall){
  const gated=configurationPresentationGate(mode,call);
  if(gated)return {...gated,groupId,cardId};
  const controller=pes.getController();
  const group=controller?.getSnapshot().groups.find(row=>row.id===groupId);
  if(!controller||!group)return {mode,status:'view-unavailable',groupId,cardId};
  const active=registry.getSnapshot().documents.find(entry=>entry.id===readMcpActiveFrameTarget());
  if(!active||active.pesGroup?.groupId!==groupId||registry.getSnapshot().module!=='advanced'||advancedSectionRef.current!=='path'){
   flushSync(()=>{
    taskWorkspace.leave();
    activatePesNode(groupId,node);
   });
  }
  if(cardId&&group.cards.find(card=>card.id===cardId)?.collapsed)
   flushSync(()=>controller.updateCard(groupId,cardId,card=>({...card,collapsed:false})));
  const intended=mcpPresentationOrigin();
  // React can commit the card in a minimized window even when it cannot paint a frame.
  await Promise.resolve();
  const current=registry.getSnapshot().documents.find(entry=>entry.id===readMcpActiveFrameTarget());
  if(call?.signal.aborted||current?.pesGroup?.groupId!==groupId||!sameMcpPresentation(intended,mcpPresentationOrigin()))
   return {mode,status:'superseded',groupId,cardId,...mcpPresentationOrigin()};
  const panel=cardId?rootElement.current?.querySelector<HTMLElement>('[data-pes-card-id="'+CSS.escape(cardId)+'"] > .pes-calculation'):undefined;
  const cardVisible=panel?panel.getClientRects().length>0:false;
  if(cardVisible)(panel?.querySelector('.shared-input-card-toggle')??panel)?.scrollIntoView({block:'nearest',inline:'nearest'});
  const nativeView=mode==='foreground'?await presentWorkspaceWindow(mode):undefined;
  return {mode,status:cardId&&!cardVisible?'view-preparing':'selected',groupId,cardId,cardVisible,
   activeTarget:current.id,module:registry.getSnapshot().module,section:'path',nativeView};
 }
 const settingsBlocked=Boolean(project.dialog||taskWorkspace.dialog||twoDVisible||citationOpen||!firstRunLicense.ready||restoringDocumentViews);
 useEffect(()=>{if(settingsBlocked)cancelSettingsNavigation();},[cancelSettingsNavigation,settingsBlocked]);
 function showSettings(target:SettingsTarget,call?:McCall){
  const origin=mcpPresentationOrigin(),signal=call?.signal;
  if(signal?.aborted||call?.presentationOrigin&&!sameMcpPresentation(origin,call.presentationOrigin))
   return {...target,status:'superseded' as const};
  if(settingsBlocked||!rootElement.current?.isConnected)
   return {...target,status:'view-unavailable' as const,message:'当前窗口有其他待处理界面，请处理后再打开全局设置。'};
  cancelSettingsNavigation();
  return new Promise<SettingsTarget&Parameters<SettingsNavigation['complete']>[0]>(resolve=>{
   const abort=()=>navigation.complete({status:'superseded'});
   const navigation:SettingsNavigation={
    target,
    isCurrent:()=>settingsNavigationRef.current===navigation&&!signal?.aborted&&sameMcpPresentation(origin,mcpPresentationOrigin()),
    complete(result){
     if(settingsNavigationRef.current!==navigation)return;
     const receipt=navigation.isCurrent()?result:{status:'superseded' as const};
     settingsNavigationRef.current=undefined;
     signal?.removeEventListener('abort',abort);
     setSettingsNavigation(undefined);
     resolve({...target,...receipt});
    },
   };
   settingsNavigationRef.current=navigation;
   signal?.addEventListener('abort',abort,{once:true});
   setEnvironmentOpen(true);
   setSettingsNavigation(navigation);
  });
 }
 const mcpCatalog=useWorkspaceTools({ready:firstRunLicense.ready,presentationOrigin:mcpPresentationOrigin,core:coreContext,model:modelContext(),input:inputContext(),science:scienceContext(),frames:frameAccess,
  results:{getResult:mcpResult,resultRegistry,openPlot,openAnalysis:mcpOpenAnalysis,readFrame:frameAccess.readFrame,captureViewport:async(ref,options,signal)=>{
   const activeTarget=readMcpActiveFrameTarget(),target=ref!==undefined?mcpResult(ref):undefined;
   const id=target?.ownerId??activeTarget,targetRef=target?.navigationRef??ref??id;
   const recovery=targetRef?{tool:'es_show',arguments:{target:targetRef,waitFor:'scene'}}:undefined;
   const fail=(code:string,message:string,reason:string)=>toolError(code,message,{ownerId:id,activeTarget,targetRef,reason,committed:false,recovery});
   if(!id)throw fail('viewport_unavailable','当前窗口没有可捕获的视口。','no-owner');
   if(activeTarget!==id)throw fail('viewport_inactive','请先显示指定目标的实际视口。','inactive-owner');
   const current=registry.getSnapshot().documents.find(row=>row.id===id);
   if(!current)throw fail('viewport_unavailable','该目标还没有接入此窗口的捕获入口。','no-capture-port');
   signal.throwIfAborted();
   const canvas=mcpFramePorts.current?.canvas(id);
   if(canvas?.scientificFrameReady===false)throw fail('viewport_preparing','当前科学帧正在准备，请等待当前场景。','scientific-frame-preparing');
   if(detachedPlacement.current[id]){
    const owner=displayOwners.current.get(id);if(!owner)throw fail('viewport_preparing','独立视口尚未连接。','detached-port-preparing');
    return owner.captureImage(options,signal,{documentRevision:current.store.getSnapshot().revision});
   }
   const binding=modelImageCaptures.current.get(id);
   if(!binding||binding.epoch!==current.epoch)throw fail('viewport_preparing','当前模型视口尚未完成准备。','model-port-preparing');
   return binding.capture(options,signal);
  }},auxiliary:{workbench,layout:mcpLayout,captureCitations:captureWorkspaceCitations,showSettings}});
 nativeFileAction.current=async request=>{
  if(fileCurrent&&!request.documentId&&request.action==='export-structure'){
   const current=fileStructureExports.current.get(fileCurrent.id);
   if(current?.source!==fileCurrent||!current.port.available)throw Error('当前文件尚没有可导出的完整结构，请等待当前来源就绪。');
   await current.port.save();return;
  }
  if(fileCurrent&&!request.documentId&&request.action==='export-image'){
   const current=fileStructureExports.current.get(fileCurrent.id);
   if(current?.source!==fileCurrent||!current.port.exportImage)throw Error('当前文件尚没有可导出的就绪视口。');
   current.port.exportImage();return;
  }
  const id=request.documentId??displayedDocumentId;
  if(!id||!registry.getSnapshot().documents.some(entry=>entry.id===id))throw new Error('当前没有可用的文件操作目标。');
  activateDocument(id);
  const controller=viewportControllers.current.get(id);
  if(!controller)throw new Error('当前模型尚未就绪，请稍后重试。');
  await controller.dispatch({type:'file-action',action:request.action});
 };
 const modelTabs=(
   <div className="workspace-tabs-row">
    <div ref={tabs} className="workspace-document-tabs" role="tablist" aria-label="模型文档">{tabDocuments.map((entry,index)=>{const snapshot=entry.store.getSnapshot(),groupId=tabGroup(entry),pesGroup=entry.pesGroup&&pes.controller?.getSnapshot().groups.find(group=>group.id===entry.pesGroup!.groupId),group=groupId?(entry.pesGroup?{label:pesGroup?.name??restoredPesNames.current[groupId]??'势能面探索',collapsed:collapsedPesGroups[groupId]===true}:conformerGroups[groupId]??{label:`sampling-${automaticStem(entry.label)}`,collapsed:false}):undefined;
     let tabLabel=entry.label;
     if(entry.conformerGroup?.role==='initial'&&entry.labelOrigin==='automatic'){
      const initialIndex=entry.conformerGroup.initialIndex??1;
      tabLabel=initialIndex===1?'initial':`initial_${String(initialIndex).padStart(3,'0')}`;
     }
     const first=Boolean(groupId&&tabGroup(tabDocuments[index-1])!==groupId),count=groupId?tabDocuments.filter(value=>tabGroup(value)===groupId).length:0;
     const latestStatus=pesGroup&&pesRunActive(pesGroup)?'running':groupId?advancedGroupStatuses.get(groupId):undefined;
     const groupStatus=latestStatus==='running'?'运行中':latestStatus==='queued'?'排队中':latestStatus==='stopping'?'正在停止':latestStatus==='failed'?'失败':latestStatus==='checkpoint'?'待继续':'';
     const groupIndex=groupId?Math.max(0,Object.keys(conformerGroups).indexOf(groupId)):0,groupStyle=groupId?{'--task-group-hue':String([158,207,40,278,338][groupIndex%5])} as CSSProperties:undefined;
     const last=Boolean(groupId&&tabGroup(tabDocuments[index+1])!==groupId);
     return <Fragment key={entry.id}>{first&&groupId&&group&&<span className="workspace-tab-group" data-task-id={groupId} data-collapsed={group.collapsed} data-active={tabDocuments.some(value=>tabGroup(value)===groupId&&value.id===displayedDocumentId)} style={groupStyle}>
      {renamingGroup===groupId?<input autoFocus aria-label="任务组名称" defaultValue={group.label} onBlur={event=>{const label=event.currentTarget.value.trim();if(label&&entry.pesGroup){void pes.ensure().then(()=>pes.controller?.renameGroup(groupId,label)).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));}else if(label)setConformerGroups(previous=>({...previous,[groupId]:{...group,label,labelOrigin:'manual'}}));setRenamingGroup(null);}} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape')setRenamingGroup(null);}}/>:<button type="button" aria-expanded={!group.collapsed} aria-label={`${group.collapsed?'展开':'收起'} ${group.label}`} title={`${group.label} · ${count} 个页面${groupStatus?' · '+groupStatus:''}；双击重命名任务组`} onDoubleClick={()=>setRenamingGroup(groupId)} onClick={()=>entry.pesGroup?setCollapsedPesGroups(previous=>({...previous,[groupId]:!group.collapsed})):setConformerGroups(previous=>({...previous,[groupId]:{...group,collapsed:!group.collapsed}}))}>{group.collapsed?'▸':'▾'} {group.label}</button>}
      <button type="button" className="workspace-tab-close" aria-label={(entry.pesGroup?'删除势能面组 ':'删除构象搜索组 ')+group.label} title={!entry.pesGroup&&groupStatus?'请先停止任务后删除组':'删除整个组'} disabled={!entry.pesGroup&&Boolean(groupStatus&&['运行中','排队中','正在停止'].includes(groupStatus))} onClick={event=>{event.stopPropagation();if(entry.pesGroup)setPesClosing({groupId,label:group.label});else setDeleteGroup(groupId);}}><WorkspaceTabCloseIcon/></button>
     </span>}<WorkspaceTab className={groupId?'workspace-tab-group-member':''} containerProps={{'data-tab-document-id':entry.id,...groupId?{'data-task-id':groupId,'data-group-last':last}:{},style:{...groupStyle,...(group?.collapsed?{display:'none'}:{})}}} active={entry.id===displayedDocumentId} label={tabLabel} dirty={snapshot.draft.dirty} onActivate={()=>sourcePick?selectTaskSource(entry.id):linkedControls.selecting?linkedControls.toggleMember(entry.id):activateDocument(entry.id)}
     actions={<button className="workspace-tab-close" aria-label={'关闭文档 '+entry.label} title="关闭当前文档" onClick={()=>requestClose(entry.id)}><WorkspaceTabCloseIcon/></button>}
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
      }}}/></Fragment>;})}
     {documents.filter(entry=>detached[entry.id]).map(entry=><div className="workspace-detached-tab" key={entry.id}><button type="button" aria-label={'停靠模型 '+entry.label} title="将独立三维视口贴回主窗口" disabled={closeConfirmIds.includes(entry.id)} onClick={()=>void dockDetachedDocument(entry.id)}>{entry.label} · 贴回</button></div>)}
     <button type="button" className="workspace-tab-new" aria-label="新建模型文档" title="新建模型" onClick={createDocument}>＋</button></div>
    <div className="workspace-layout-actions">
     {activeId&&activeId===displayedDocumentId&&!active?.result&&hostBridge?.detachWorkspaceDocument&&!detached[activeId]&&
      <button type="button" aria-label="浮出三维视口" title="浮出当前模型的三维视口" onClick={event=>{const box=event.currentTarget.getBoundingClientRect(),view=event.currentTarget.ownerDocument.defaultView!;void detachDocument(activeId,view.screenX+box.left,view.screenY+box.bottom);}}>浮出视口</button>}
     {modelToolsFloat.floating?<button type="button" onClick={()=>modelToolsFloat.dock()}>贴回建模工具</button>:modelToolsAvailable&&
      <button type="button" aria-pressed={modelToolsOpen} onClick={()=>setModelToolsOpen(!modelToolsOpen)}>建模工具</button>}
     <button type="button" className="button-primary" onClick={()=>void citationOpenAction.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}>导出文献</button>{sourceDiagnostics.length>0&&<button aria-label="来源诊断" title="查看文件级来源诊断" onClick={()=>setDiagnosticsOpen(true)}>来源诊断 ({sourceDiagnostics.length})</button>}{portableToolsAvailable&&<button aria-label="运行数据" title="运行数据" onClick={()=>setRuntimeDataOpen(true)}>⋯</button>}
    </div>
   </div>
 );
 return <><Suspense fallback={twoDVisible?<div role="status" className="workspace-global-error">正在载入二维编辑器…</div>:null}>{twoDFile&&<TwoDImportWorkspace key={twoDFile.id} file={twoDFile} visible={twoDVisible} captureGuard={captureTwoDGuard} onCommit={commitTwoD} onClose={closeTwoD} onImportFiles={openTwoDFiles} onRuntime={setTwoDRuntime} onBusyChange={setTwoDBusy}/>}</Suspense><ProjectUiRestoreBoundary restoring={restoringDocumentViews}>{()=> <>{citationOpen&&<ProjectUiScope store={citationUiStore} scope={['citations']}><CitationDialog assertCurrent={()=>{if(citationOpen.identity!==citationIdentity())throw new Error("项目文档已变化，请关闭后重新打开文献导出。");}} facts={citationOpen.facts} retainedDocumentIds={retainedCitationOwnerIds(state.documents,postprocess.fileDocuments)} warnings={citationOpen.warnings} registry={citationRegistryData as CitationRegistry} version={applicationVersion.displayVersion} documentId={citationOpen.documentId} documentLabel={registry.getSnapshot().documents.find(entry=>entry.id===citationOpen.documentId)?.label??postprocess.fileDocuments[citationOpen.documentId??'']?.output.source.identity.name} fixedDocument={citationOpen.fixed} decisions={citationState.decisions} onDecisions={decisions=>setCitationState(previous=>({...previous,decisions}))} ownerDocument={tabs.current?.ownerDocument} onClose={()=>setCitationOpen(null)}/></ProjectUiScope>}<WorkspaceRenderBoundary onSave={asNew=>project.save(asNew)} status={project.status} projectName={project.project?.indexPath} resetKey={project.project?.indexPath} onReturn={()=>returnToAvailableModel(displayedDocumentId??undefined)} recoveryControls={<>{registry.getSnapshot().documents.map(entry=>runtimeRecovery(entry.id))}</>}><div ref={rootElement} className="sciyue-workspace-v18" data-testid="workspace-v18" data-project-path={project.project?.indexPath??''} data-project-busy={project.busy} data-module={taskWorkspace.opened?'tasks':state.module} data-model-left-panel={state.module==='modeling'&&leftToolOpen} data-shared-models={sharedLayout} data-source-picking={Boolean(sourcePick)} data-link-selecting={linkedControls.selecting}
  onScrollCapture={event=>{const node=event.target as HTMLElement;if(node.dataset.pageScroll)pageScroll.current.set(scrollPageKey+':'+node.dataset.pageScroll,{top:node.scrollTop,left:node.scrollLeft});}}
  onDragOverCapture={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}}
  onDropCapture={event=>{if(event.target instanceof Element&&event.target.closest('[data-agent-compose],[data-es-assistant-composer],[data-testid="model-2d-window"]'))return;if(taskWorkspace.opened){event.preventDefault();return;}if(event.dataTransfer.files.length){event.preventDefault();event.stopPropagation();void importFiles(Array.from(event.dataTransfer.files));}}}>
  <nav className="workspace-module-rail" aria-label="功能模块"><button type="button" className="workspace-symbol workspace-global-settings" aria-label="全局设置" title="全局设置 · Lactone Studio（非官方修改版）" onClick={()=>setEnvironmentOpen(true)}>LS</button>{modules.map(([id,label,Icon])=><button key={id} title={label} aria-label={label} aria-pressed={!taskWorkspace.opened&&state.module===id} onClick={()=>navigateModule(id)}><Icon size={20}/><span>{label}</span></button>)}<button type="button" title="任务中心" aria-label="任务中心" aria-pressed={taskWorkspace.opened} onClick={()=>{closeTwoD();taskWorkspace.open();}}><ListChecks size={20}/><span>任务中心</span></button><small>{applicationVersion.label}</small></nav>
  <AgentPanel onOpenImage={openAssistantImage}><div className="es-agent-workspace-content">{taskWorkspace.opened&&<div className="workspace-document-area" data-testid="external-task-workspace"><div className="workspace-tabs-row"><div className="workspace-layout-actions" style={{marginLeft:'auto'}}><button type="button" className="button-primary" onClick={()=>void citationOpenAction.current().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)))}>导出文献</button></div></div>{taskWorkspace.center}</div>}
  <div className="workspace-document-area" style={{'--shared-input-width':workbench.layout.paneSizes.leftWidth+'%',...(taskWorkspace.opened?{display:'none'}:{})} as CSSProperties}>
   {!analysisLayout&&modelTabs}
   {recoveryBridge&&<ConformerRecoveryPanel bridge={recoveryBridge} disabled={project.busy||reading||postprocess.busy||closingPending}
    opened={(item:ConformerRecoveryItem)=>state.documents.some(entry=>(entry.analysisBinding?.result??entry.legacyResult??entry.result)?.id===`recovered-${item.kind}-${item.id}`)}
    captureGuard={()=>{const epoch=projectIdentityEpoch.current,view=registry.getSnapshot().activeViewId;return ()=>{if(projectIdentityEpoch.current!==epoch||registry.getSnapshot().activeViewId!==view)throw Error('工作区已切换，请在目标工作区打开恢复结果。');};}}
    publish={result=>{installAnalysisGuard(registry.addEditableResultDocument(result,scientificFrameForModel(result.initialStructure)));registry.setModule('analysis');}}/>}
   {active?.result&&!analysisLayout&&<div className="workspace-result-actions"><button onClick={createDocument}>新建</button><button disabled={reading} onClick={()=>fileInput.current?.click()}>导入</button></div>}
   {(reading||importCloseFailed||postprocess.readState!=='idle')&&<div role="status" className="workspace-reading" data-testid="workspace-source-reading" data-read-state={importCloseFailed?'cancelling':postprocess.readState==='idle'?'reading':postprocess.readState}>
    {importCloseFailed?'读取资源仍待关闭':postprocess.readState==='cancelling'?'正在取消读取':postprocess.readState==='reading'?'读取后处理来源中':'读取中'}
    <progress aria-label="来源读取进度" max={100} value={postprocess.readState!=='idle'||readProgress===null?undefined:readProgress}/>
    {postprocess.readState==='idle'&&readProgress!==null?`${readProgress}%`:'预计剩余：估算中'}
    <button disabled={readCancelPending} onClick={()=>{importController.current?.abort();setReadCancelPending(true);void Promise.allSettled([postprocess.readState!=='idle'?postprocess.cancelRead():Promise.resolve(),importResourceClosures.current.retry()]).then(outcomes=>{const failed=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected');if(failed.length){setImportCloseFailed(importResourceClosures.current.failedCount>0);setError(failed.map(value=>value.reason instanceof Error?value.reason.message:String(value.reason)).join('；'));return;}setImportCloseFailed(false);if(importReadScope.current?.settled&&!importResourceClosures.current.pendingCount){setReading(false);setReadProgress(null);importController.current=null;}}).finally(()=>setReadCancelPending(false));}}>取消读取</button>
   </div>}
   {sourcePick&&<div role="status" className="workspace-source-pick-banner">点击模型框或标签，选择：{sourcePick.request.label}<button onClick={()=>setSourcePick(null)}>取消选择</button></div>}
   {error&&<div className="workspace-global-error" role="alert">{error}<button aria-label="关闭工作空间提示" onClick={()=>setError('')}><X size={13}/></button></div>}
   {!taskWorkspace.opened&&!fileCurrent&&state.documents.filter(entry=>entry.id===displayedDocumentId).map(entry=>{const adapter=ownerAdapters.current.get(entry.id);return adapter?<WorkspacePublicationNotice key={entry.epoch} adapter={adapter} documentId={entry.id} documentEpoch={entry.epoch} label={entry.label}/>:null;})}
   {Boolean(pendingDiscards.current.size)&&!closingPending&&<div className="workspace-global-error" role="status" data-revision={discardCleanupRevision}><span>{[...pendingDiscards.current.values()].some(row=>row.execution.status().phase==='commit-failed')?'丢弃提交未全部完成，已保留实际资源归属。':'内容已撤下，部分资源仍待收尾。'} {[...pendingDiscards.current.values()].map(row=>row.label).join('、')}</span><button disabled={retryingDiscard} onClick={()=>void retryDiscardCleanup()}>{retryingDiscard?'正在重试释放…':'重试释放'}</button></div>}
   <WorkspaceColumns ref={mcpWorkspaceColumns} sizes={analysisLayout?analysisColumns.sizes:undefined} rightVisible={rightPaneVisible} className={analysisLayout?'workspace-main-content workspace-analysis-columns':'workspace-main-content'} style={{'--shared-tool-width':rightWidth+'px','--shared-input-width':workbench.layout.paneSizes.leftWidth+'%'} as CSSProperties}>
    {modelToolsFloat.dragPoint&&<div className="workspace-model-tools-drop-target" aria-hidden="true"/>}
    {analysisLayout&&modelTabs}
    <aside data-page-scroll={advancedSection==='conformer'||xtbAnalysisLayout?undefined:'advanced-configuration'} className="workspace-advanced-panel workspace-workflow-panel desktop-mode" data-pes={pesLayout||undefined} hidden={!advancedLayout} aria-label="高级任务配置"><AdvancedWorkflowNavigation activeSection={advancedSection} samplingOperation={conformerSamplingChoice} onSamplingOperation={setConformerSamplingChoice} onSectionChange={section=>void changeAdvancedSection(section)}/>{activeAdvancedTaskUnavailable&&<DismissibleNotice identity={activeConformerGroup!.taskId}>当前构象任务的结构资产无法读取，原任务引用已保留。</DismissibleNotice>}<div data-page-scroll={xtbAnalysisLayout?'advanced-configuration':undefined} className={xtbAnalysisLayout?'workflow-panel-content postprocess-source-panel-host':'workflow-panel-content'} hidden={!advancedSection} ref={setAdvancedConfigurationHost}/>{pesLayout&&leftToolOpen&&<OwnedSharedSurface channel={leftToolSurface} owner={leftToolOwner}/>}</aside>
    <aside className="workspace-model-left-panel" hidden={state.module!=='modeling'||!leftToolOpen} aria-label="建模参数">{state.module==='modeling'&&<OwnedSharedSurface channel={leftToolSurface} owner={leftToolOwner}/>}</aside>
    <aside className="workspace-advanced-modeling-panel workspace-workflow-panel desktop-mode" hidden={!advancedModelingLayout} aria-label="高级建模设置">
     {active?.result?<p className="postprocess-note">请先从结果中取帧建模，再进行结构变换。</p>:<OwnedSharedSurface channel={leftToolSurface} owner={leftToolOwner}/>}
    </aside>
    {analysisLayout&&<div className="workspace-analysis-panel workspace-workflow-panel desktop-mode"><WorkflowSessionBar label="后处理" actions={Object.keys(postprocess.fileDocuments).length?<label className="trajectory-stage-choice">来源<select aria-label="后处理文件来源" value={postprocess.fileOwnerId??''} onChange={event=>{postprocess.selectFile(event.target.value||null);registry.invalidateActivation();}}><option value="">当前模型 / 已有分析</option>{Object.values(postprocess.fileDocuments).map(value=><option key={value.id} value={value.id}>{value.output.source.identity.name}</option>)}</select></label>:undefined}/>{fileCurrent&&<div className="postprocess-actions workflow-session-actions ui-control-surface">{currentFileSidebarCollapsed&&<button type="button" onClick={()=>setFileSidebarCollapsed(previous=>({...previous,[fileCurrent.id]:false}))}>展开后处理侧栏</button>}<button type="button" aria-label="关闭后处理文件来源" onClick={()=>{void postprocess.closeFile(fileCurrent.id).then(issues=>{if(issues.length)setError(issues.join('；'));});}}>关闭来源</button></div>}<div key={postprocess.stage} className="workflow-panel-content postprocess-source-panel-host" data-testid="postprocess-sidebar-presentation" hidden={currentFileSidebarCollapsed}><PostprocessSidebar showTitle={false} engine={postprocess.engine} task={postprocess.task} stage={postprocess.stage} onStage={postprocess.setStage} onEngine={postprocess.selectEngine} onTask={postprocess.selectTask}
       slots={postprocessDocumentFileSlots(fileCurrent??sidebarDocument)} fileDocument={fileCurrent} onFileJob={fileCurrent?jobId=>void postprocess.selectFileJob(fileCurrent.id,jobId):undefined}
      result={sidebarFrameReady?sidebarResult??null:null} currentIndex={sidebarCanvas?.frameIndex??0} busy={postprocess.busy} sourceDifferences={sidebarDocument?postprocessDifferences(sidebarDocument):[]}
      message={fileCurrent?postprocess.notice:sidebarResult?.scientific?.readLimits?.observations?.omitted?`部分科学数据达到读取预算；已保留 ${sidebarResult.frames.length} 个完整帧。`:sidebarResult?.kind==='optimization'&&sidebarResult.status!=='completed'?`优化${sidebarResult.status==='incomplete'?'未完成':sidebarResult.status==='failed'?'异常结束':'状态未知'} · 已读取 ${sidebarResult.frames.length} 帧`:postprocess.notice}
      onFiles={(_role,files,replace,slotKey,sourceId)=>{if(isExcitationSlot(slotKey))void postprocess.readExcitationFiles(files,slotKey,postprocess.ownerId);else void postprocess.read(files,fileCurrent?postprocess.fileOwnerId:sidebarDocument?postprocess.ownerId:undefined,postprocess.engine,replace?'replace':'smart',undefined,{slotKey,sourceId});}} onRemove={(role,slotKey,sourceId)=>void postprocess.remove(role,slotKey,sourceId)}
      onClose={fileCurrent?()=>setFileSidebarCollapsed(previous=>({...previous,[fileCurrent.id]:true})):undefined}
      onExtract={sidebarFrameReady?()=>{const structure=extractCurrentAnalysis();if(structure)extractFrame(structure);}:undefined}
      onPrepareInput={sidebarFrameReady?()=>{const structure=extractCurrentAnalysis();if(structure){extractFrame(structure);requestNewInputTask();}}:undefined}
       onOpenLegacy={()=>fileInput.current?.click()}/></div>{currentStructureEntry&&<CurrentStructureAnalysisEntry document={currentStructureEntry.store.getSnapshot()} selected={currentStructureSelected} onOpen={id=>{if(registry.stamp().documentId===id&&!ownerHidden&&!taskWorkspace.opened&&!closingPending)setStructureAnalysisSelected(previous=>({...previous,[id]:true}));}}/>}{sidebarDocument&&postprocess.ownerId&&managedTaskControls(postprocess.ownerId,sidebarDocument)}</div>}
    <aside className="workspace-input-panel workspace-workflow-panel desktop-mode" hidden={!sharedLayout||state.module!=='input'} aria-label="输入文件任务与设置"><WorkflowSessionBar label="输入文件生成器" actions={borrowedBatch?<button type="button" onClick={()=>setCancelBatchConfirm(true)}>取消批量输入</button>:<button type="button" onClick={requestNewInputTask}>新建输入任务</button>}/>{batchInputRecoveryNotice&&<DismissibleNotice identity={batchInputRecoveryNotice}>{batchInputRecoveryNotice}</DismissibleNotice>}{documents.filter(entry=>!entry.result).map(entry=><div key={entry.id} ref={inputHostRef(entry.id)} className="workflow-panel-content" hidden={entry.id!==inputOwnerId} data-testid="workspace-input-host" data-document-id={entry.id} data-input-task-id={entry.id===inputOwnerId?inputTask?.id:undefined}/>)}</aside>
    {analysisLayout&&<WorkspaceColumnDivider side="left" sizes={analysisColumns.sizes} gridRow="1 / 4" onChange={analysisColumns.update}/>}
    <div className="workspace-input-divider" hidden={analysisLayout||!sharedLayout||(state.module!=='input'&&!analysisLayout&&!advancedLayout&&!advancedModelingLayout&&!(state.module==='modeling'&&leftToolOpen))} role="separator" aria-label="调整参数区宽度" aria-orientation="vertical" tabIndex={0}
      onPointerDown={event=>{event.preventDefault();beginWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))return;moveWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);const bounds=event.currentTarget.parentElement!.getBoundingClientRect(),minimum=advancedModelingLayout?parseFloat(getComputedStyle(rootElement.current!).getPropertyValue('--advanced-panel-min'))||250:250;workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,leftWidth:clampWorkbenchPaneSize('leftWidth',Math.max(minimum,event.clientX-bounds.left)/bounds.width*100)}}));}}
      onPointerUp={event=>{endWorkspaceDividerDrag(event.currentTarget,event.pointerId);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={event=>{endWorkspaceDividerDrag(event.currentTarget,event.pointerId);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onLostPointerCapture={event=>endWorkspaceDividerDrag(event.currentTarget,event.pointerId)}
      onDoubleClick={()=>workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,leftWidth:27}}))}/>
    <div ref={setToolbarHost} className="workspace-common-toolbar" data-testid="workspace-common-toolbar" hidden={!sharedLayout||!fileCurrent&&!displayedDocumentId}>{!fileCurrent&&<SharedSurface channel={toolbarSurface}/>}</div>
    <div className="workspace-document-surfaces" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();void importFiles(Array.from(event.dataTransfer.files));}}>
     {!displayedDocumentId&&!fileCurrent&&Object.keys(detached).length>0&&<p className="workspace-detached-placeholder" role="status">模型正在独立视口中显示</p>}
     <div style={{display:fileCurrent?'none':'contents'}}>
     <ModelDocumentDeck activeId={displayedDocumentId??''} isDocumentInteractionOwner={id=>Boolean(sourcePickLive.current||selectingMembers.current)||id===displayedDocumentId} mode={analysisLayout||advancedLayout||advancedModelingLayout?'single':sharedLayout?deckMode:'single'} onActivate={activateDocument} onReorder={setOrder} arrangeRequest={arrangeRequest} onLegendHostChange={setLegendHostId}
      documents={documents.map(entry=>({id:entry.id,label:entry.label,docked:!retiredConformerReader(entry)&&!detached[entry.id]&&(sharedLayout?(!entry.result||analysisLayout&&Boolean(postprocess.documents[entry.id])||advancedLayout&&entry.id===activeId):entry.id===activeId),content:<ProjectUiScope store={projectUi} scope={['document',entry.id]}><ProjectNativeDetailsBoundary><WorkspaceRenderBoundary scope="document" label={entry.label} resetKey={entry.id+':'+entry.epoch+':'+state.module} onReturn={()=>returnToAvailableModel(entry.id)} onSave={asNew=>project.save(asNew)} recoveryControls={runtimeRecovery(entry.id)}><div id={'doc-'+entry.id} className="workspace-document-surface" data-document-id={entry.id} data-linked-atoms={linkedControls.linked?.documentIds.includes(entry.id)??false} data-link-status={linkedControls.linked?.documentIds.includes(entry.id)?linkedControls.linked.status:undefined} data-link-selected={linkedControls.selected.includes(entry.id)}
       onPointerDownCapture={event=>{if(!(event.target instanceof Node)||!event.currentTarget.contains(event.target))return;if(sourcePick||linkedControls.selecting){event.preventDefault();event.stopPropagation();if(sourcePick)selectTaskSource(entry.id);else linkedControls.toggleMember(entry.id);}}}>
       {borrowedBatch?.documentId===entry.id&&<span className="workspace-batch-input-notice" data-testid="workspace-batch-input-notice" style={{position:'absolute',left:'50%',top:56,transform:'translateX(-50%)',zIndex:3,pointerEvents:'none',color:'#617168',fontSize:13,whiteSpace:'nowrap'}}>正在批量产生输入文件</span>}
       {state.module==='input'&&(sourceRoles[inputOwnerId??'']??[]).filter(role=>role.documentId===entry.id).map(role=><span key={role.label} className="workspace-task-role" data-testid="workspace-task-role" data-input-task-id={inputTask?.id} data-source-document-id={entry.id} data-source-role={role.label.includes('反应物')?'reactant':role.label.includes('产物')?'product':'tsGuess'}>{role.label}</span>)}
       {entry.result?<><div className="workspace-legacy-trajectory" hidden={advancedLayout}><TrajectoryWorkspace onPlaybackCanvas={mcpPlaybackCanvasFor(entry.id)} onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} result={entry.result} onScientificFrame={value=>trajectoryFrames.current.set(entry.id,value)} active={!fileCurrent&&entry.id===activeId&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&state.module!=='input'&&!advancedLayout} displaySettings={displaySettings} onDisplaySettingsChange={changeDisplaySettings} onExtract={extractFrame} onPrepareIrc={entry.result.engine==='gaussian'||entry.result.engine==='orca'?structure=>prepareIrc(structure,entry.result!.engine as 'gaussian'|'orca'):undefined} onExport={exportWorkspaceResult} onError={setError}/></div>{advancedLayout&&renderDocument(surface(entry))}</>:<>{renderDocument(surface(entry))}{postprocess.documents[entry.id]&&<div hidden><PostprocessResultView onCipLabelsUsed={cipUsageFor(entry.id,entry.epoch)} onActiveResult={activeResultFor(entry.id,postprocess.documents[entry.id])} requestedTrajectoryCursor={requestedTaskCursors[entry.id]} document={postprocess.documents[entry.id]} modelDocument={entry.store.getSnapshot()} available={registry.analysisAvailable(entry.id)} onCanvas={canvasFor(entry.id)} active={!fileCurrent&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&(analysisLayout&&(entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId)||entry.id===xtbAnalysisOwnerId)} selected={!fileCurrent&&analysisLayout&&(entry.id===displayedDocumentId||Boolean(detached[entry.id])&&entry.id===activeId)||entry.id===xtbAnalysisOwnerId}
        toolHost={analysisToolHosts[entry.id]??null} onNewDocument={createDocument} onImportFiles={importFiles} display={displaySettings} onDisplay={changeDisplaySettings} onOpenPlot={openPlot} onExtract={extractFrame} onError={setError} onActivate={()=>{if(entry.id!==xtbAnalysisOwnerId){activateDocument(entry.id);registry.setModule('analysis');}}}/></div>}{entry.legacyResult&&ownedTrajectory(entry)}</>}
      </div></WorkspaceRenderBoundary></ProjectNativeDetailsBoundary></ProjectUiScope>}))}/></div>
     {Object.values(postprocess.fileDocuments).map(value=><div key={value.id} className="workspace-document-surface" hidden={!analysisLayout||fileCurrent?.id!==value.id} data-testid="scientific-file-workspace" data-file-document-id={value.id}><ProjectUiScope store={projectUi} scope={['scientific-file',value.id]}><ProjectNativeDetailsBoundary><WorkspaceRenderBoundary scope="document" resetKey={value.id} onReturn={()=>returnToAvailableModel()} onSave={asNew=>project.save(asNew)}><ScientificFileResultView onActiveResult={fileFrameOwner(value).publishResult} requestedTrajectoryCursor={requestedTaskCursors[value.id]} onPlaybackCanvas={mcpPlaybackCanvasFor(value.id)} onStructureExportPort={fileStructureExportPort} onCipLabelsUsed={cipUsageFor(value.id)} document={value} active={!ownerHidden&&!taskWorkspace.opened&&!closingPending&&analysisLayout&&fileCurrent?.id===value.id} selected={analysisLayout&&fileCurrent?.id===value.id} toolHost={analysisToolHosts[value.id]??null} toolbarHost={toolbarHost} display={displaySettings} onDisplay={changeDisplaySettings} onObservedFrame={fileFrameOwner(value).publishStructure} onScientificCursor={fileFrameOwner(value).publishCursor} onFileJob={jobId=>void postprocess.selectFileJob(value.id,jobId)} onNewDocument={createDocument} onImportFiles={importFiles} onOpenPlot={openPlot} onExtract={extractFrame} onError={setError} sharedShowAxes={sharedShowAxes} onSharedShowAxesChange={setSharedShowAxes} legendVisible legendExpanded={legendExpanded} onLegendExpandedChange={setLegendExpanded}/></WorkspaceRenderBoundary></ProjectNativeDetailsBoundary></ProjectUiScope></div>)}
     {state.module==='input'&&active?.result&&<div className="workspace-module-placeholder"><h2>从结果帧创建输入</h2><p>选定结果帧并“取帧建模”，即可使用该结构准备Gaussian或ORCA输入。</p><button onClick={()=>registry.setModule('modeling')}>返回轨迹</button></div>}
     <PostprocessPlotDeck snapshots={plots} active={analysisLayout||xtbAnalysisLayout||pesLayout} visibleFilePlotScope={analysisLayout&&fileCurrent?filePathPlotScope(fileCurrent):null} visibleResultId={pesLayout?pesCanvas?.canvas.result?.id??null:xtbAnalysisLayout?(xtbAnalysisOwnerId?analysisCanvases[xtbAnalysisOwnerId]?.result?.id??null:activeId?xtbAnalysisCanvases[activeId]?.result?.id??null:null):sidebarResult?.id??null} onClose={id=>setPlots(previous=>previous.filter(value=>value.id!==id))}/>
    </div>
    {analysisLayout&&rightPaneVisible&&<WorkspaceColumnDivider side="right" sizes={analysisColumns.sizes} gridRow="2 / 4" onChange={analysisColumns.update}/>}
    <div className="workspace-common-tool-divider" hidden={analysisLayout||!rightPaneVisible} role="separator" aria-label="调整公共工具区宽度" aria-orientation="vertical" tabIndex={0}
     onPointerDown={event=>{event.preventDefault();beginWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);event.currentTarget.setPointerCapture(event.pointerId);}}
     onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId)){moveWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);resizeTools(event.currentTarget.parentElement!.getBoundingClientRect().right-event.clientX);}}}
     onPointerUp={event=>{endWorkspaceDividerDrag(event.currentTarget,event.pointerId);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
     onPointerCancel={event=>{endWorkspaceDividerDrag(event.currentTarget,event.pointerId);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
     onLostPointerCapture={event=>endWorkspaceDividerDrag(event.currentTarget,event.pointerId)}
     onDoubleClick={()=>resizeTools(DEFAULT_WORKBENCH_PANE_SIZES.rightWidth)}
     onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();resizeTools(event.key==='Home'?DEFAULT_WORKBENCH_PANE_SIZES.rightWidth:rightWidth+(event.key==='ArrowLeft'?10:-10));}}}/>
    <aside data-page-scroll="results" className="workspace-common-tools" data-pes={pesLayout||undefined} hidden={!rightPaneVisible} aria-label={advancedResultsVisible?(xtbAnalysisLayout?'XTB2后处理分析':'高级任务进度与结果'):analysisResultsVisible?'后处理显示工具区':'公共建模工具区'}>
     <div className="workspace-model-tools" hidden={!modelToolsDocked}>
      {modelToolsFloat.available&&<div className="workspace-model-tools-heading" data-workspace-tool-grip
       onPointerDown={event=>{if(event.button!==0||event.target!==event.currentTarget)return;toolsDrag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId);}}
       onPointerCancel={()=>{toolsDrag.current=null;}} onLostPointerCapture={()=>{toolsDrag.current=null;}}
       onPointerUp={event=>{const drag=toolsDrag.current;toolsDrag.current=null;const workbench=rootElement.current?.getBoundingClientRect();if(drag?.pointerId===event.pointerId&&workbench&&workspaceTabDragMoved(drag.x,drag.y,event.clientX,event.clientY)&&!workspaceTabTargetContains({x:workbench.x,y:workbench.y,width:workbench.width,height:workbench.height},event.clientX,event.clientY))void modelToolsFloat.detach({x:event.screenX,y:event.screenY});}}>
       建模工具 <button type="button" onClick={()=>void modelToolsFloat.detach()} aria-label="浮出建模工具">浮出</button>
      </div>}
      {modelToolsFloat.error&&<DismissibleNotice identity={modelToolsFloat.error}>{modelToolsFloat.error}</DismissibleNotice>}
      <div ref={modelToolsFloat.slotRef}/>
     </div>
     <div ref={setAdvancedResultHost} className="workspace-fill-host" data-testid="workspace-advanced-result-host" hidden={!advancedResultsVisible}/>
     <div className="analysis-workspace-host" data-testid="workspace-current-structure-tool-host" hidden={!currentStructureSelected}><SharedSurface channel={toolSurface}/></div>
     {Object.entries(postprocess.documents).map(([id,value])=><div key={id} ref={analysisHostRef(id)} hidden={(Boolean(fileCurrent)||!analysisLayout||id!==postprocess.ownerId)&&id!==xtbAnalysisOwnerId} data-testid="postprocess-tool-host" data-document-id={id}><p className="postprocess-note">分析来源：{(activeAnalysisResults[id]?.source===value?activeAnalysisResults[id]?.result:null)?.label??value.result.label}</p></div>)}
     {Object.values(postprocess.fileDocuments).map(value=><div key={value.id} ref={analysisHostRef(value.id)} hidden={!analysisLayout||fileCurrent?.id!==value.id} data-testid="scientific-file-tool-host" data-file-document-id={value.id}/>)}
     {documents.filter(entry=>entry.legacyResult).map(entry=><div key={'legacy-'+entry.id} ref={analysisHostRef(entry.id)} hidden={!analysisLayout||entry.id!==activeId} data-testid="postprocess-tool-host" data-document-id={entry.id}/>)}
    </aside>
   </WorkspaceColumns>
  </div></div></AgentPanel>
  {modelToolsFloat.render(<div ref={setToolHost} className="workspace-model-tools-content" data-testid="workspace-common-tool-host">{modelToolsAvailable&&active?<OwnedSharedSurface channel={modelToolsSurface} owner={modelToolsOwnerFor(active)}/>:modelToolsFloat.floating&&<p role="status">当前活动页面没有可用的建模工具。</p>}</div>)}
  <input hidden ref={fileInput} type="file" multiple aria-label="导入为新模型文档" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(files.length)void importFiles(files);}}/>

  {legendTarget&&sharedLayout&&createPortal(<SharedSurface channel={legendSurface}/>,legendTarget)}
  {linkedControls.dialog}
  {advancedController&&!pendingAdvancedProject.current&&!activeAdvancedTaskUnavailable&&<AdvancedWorkspace controller={advancedController} contextKey={activeConformerGroup?.taskId??activeId} contextTaskId={activeConformerGroup?.taskId} onTaskCreated={bindConformerTask} onPrepareNewTaskSource={writableConformerSource} onElectronicStateChange={changeSourceElectronicState} onConformerElectronicStateChange={changeConformerElectronicState} sourceElectronicState={active?{documentId:active.id,charge:active.store.getSnapshot().draft.structure.charge??0,multiplicity:active.store.getSnapshot().draft.structure.multiplicity??1}:undefined} onProtectionChange={changeSourceProtection} onCommitConformerCoreChange={commitConformerCoreChange} onConformerFreezeChange={changeConformerInitialFreeze} onConformerCoordinateFreezeChange={changeConformerInitialCoordinateFreeze} conformerFreezeEditable={Boolean(active&&activeConformerGroup?.role==='initial'&&!active.trajectory&&!closingTransactions.current.has(active.id)&&!ownerHidden&&!taskWorkspace.opened&&!closingPending)} onReadConformerInitialSource={captureConformerInitial} currentSourceFreezeAtomIds={workspaceCurrentSharedFrozenAtomIds(activeConformerGroup?conformerInitialDocument(advancedController.getSnapshot().tasks.find(task=>task.id===activeConformerGroup.taskId),state.documents)?.store.getSnapshot():active?.store.getSnapshot())} sourceProtectionAtomIds={activeConformerGroup?advancedController.getSnapshot().tasks.find(task=>task.id===activeConformerGroup.taskId)?.mixedSampling?.draft.protectedAtomIds:active?.store.getSnapshot().sharedConstraints?.frozenAtomIds??[]} active={advancedLayout&&!pesLayout&&!!advancedSection&&advancedSection!=='xtb2'&&!ownerHidden&&!taskWorkspace.opened&&!closingPending} activeSection={advancedSection} onSectionChange={setAdvancedSection} navigationInShell samplingOperation={conformerSamplingChoice} onSamplingOperationChange={setConformerSamplingChoice} onOpenConformerCollection={openConformerCollection} onConformerFrameOrder={conformerFrameOrder} onConformerViewControls={publishConformerViewControls} activeConformerFrame={active?.trajectory?{taskId:active.trajectory.identity.taskId,collectionId:active.trajectory.identity.collectionId,frameId:active.trajectory.currentFrameId}:undefined} onSphereDraft={setSamplingSphereDraft} sphereRadiusChange={samplingSphereRadiusChange} computeResources={computeResources} displayTargetId={activeId} displayedSource={advancedDisplayedSource} onTaskHighlights={publishTaskHighlights} onCaptureProjection={setAdvancedCapture} onDisplayLayers={publishAdvancedLayers} sourceCollectionInfo={source=>{const current=advancedSourceResult(source);return current?{id:current.result.id,count:current.result.frames.length,label:current.result.label}:undefined;}} onReadSourceCollection={readAdvancedSourceCollection} onCaptureInputTemplate={()=>{const task=registry.getSnapshot().inputTask;return task?inputControllers.current.get(task.documentId)?.getAdvancedInputTemplate?.():undefined;}} outputBridge={advancedOutputBridge} configurationHost={advancedLayout&&!pesLayout&&advancedSection&&advancedSection!=='xtb2'?advancedConfigurationHost:null} resultHost={advancedLayout&&!pesLayout&&advancedSection&&advancedSection!=='xtb2'?advancedResultHost:null} onCaptureSource={captureCurrentAdvancedSource} onCaptureInitialSource={()=>captureCurrentAdvancedSource(false)}
   onConformerInitialFrame={openConformerInitialFrame} activeConformerInitial={activeConformerGroup?.role==='initial'&&activeConformerGroup.initialId?{taskId:activeConformerGroup.taskId,initialId:activeConformerGroup.initialId}:undefined}
   onObserve={source=>observeAdvancedSource(registry.stamp().documentId,source)}
   onExtract={extractAdvancedFrame} onPrepareInput={prepareAdvancedInput} onPrepareBatchInput={prepareBatchInput}
   onOpenAnalysis={(taskId,runId)=>{const id=advancedAnalysisDocuments.current.get(`${taskId}:${runId}`),generated=id?postprocess.generated[id]:undefined;if(generated){activateDocument(generated.ownerId);registry.setModule('advanced');setAdvancedSection('xtb2');}else if(id){activateDocument(id);registry.setModule('analysis');}else setError('该运行尚未接入可用后处理来源。');}} onError={setError}/>}
  {pes.controller&&!pes.pending.current&&retainedPesEntries.map(entry=>{
    const binding=entry.pesGroup!;
    const panelActive=pesLayout&&entry.id===active?.id&&!ownerHidden&&!taskWorkspace.opened&&!closingPending&&!pesDeleting;
    const visible=pesReaderVisible({module:state.module,section:advancedSection,documentId:entry.id,activeDocumentId:activeId,displayedDocumentId,deckMode,detached:Boolean(detached[entry.id]),projected:sharedLayout&&!fileCurrent,
      blocked:!detached[entry.id]&&(ownerHidden||taskWorkspace.opened||Boolean(fileCurrent))||Boolean(closingPending)||pesDeleting||closeConfirmIds.includes(entry.id)});
    return <ProjectUiScope key={entry.epoch} store={projectUi} scope={['document',entry.id,'pes']}>
      <PesWorkspaceDock controller={pes.controller!} entry={entry} configurationHost={panelActive?advancedConfigurationHost:null} resultHost={advancedResultHost}
        activationEpoch={state.activationEpoch} active={visible} panelActive={panelActive} display={displaySettings} onDisplay={changeDisplaySettings} onCanvas={pesCanvasPublisher(entry)}
        onActivateNode={node=>activatePesNode(binding.groupId,node)} onEditFrame={editPesFrame} onOptimize={visible&&entry.id===activeId?startPesOptimization:undefined} onElectronicStateChange={changePesElectronicState}
        onConstraintsChange={changePesConstraints} onOpenPlot={openPlot} additionalSources={panelActive?additionalPesSources:undefined} onError={setError}/>
    </ProjectUiScope>;
  })}
  {advancedController&&<XtbAnalysisWorkspace controller={advancedController} active={xtbAnalysisLayout&&!ownerHidden&&!taskWorkspace.opened&&!closingPending} displayTargetId={activeId} configurationHost={xtbAnalysisLayout?advancedConfigurationHost:null} resultHost={xtbAnalysisLayout?advancedResultHost:null} computeResources={computeResources} resourceError={computeResourceState.error} analysisBindings={advancedAnalysisBindings} documents={Object.fromEntries(Object.entries(postprocess.generated).map(([key,row])=>[key,row.document]))} modelDocumentFor={id=>registry.getSnapshot().documents.find(entry=>entry.id===id)?.store.getSnapshot()} isAnalysisAvailable={xtbAnalysisSourceAvailable} display={displaySettings} onDisplay={changeDisplaySettings} onCaptureSource={()=>captureCurrentAdvancedSource(true)} onCaptureElectronicSource={captureCurrentElectronicSource} electronicSourceContext={xtbLiveElectronicContext} scientificFrameReady={xtbVisibleScientificFrameReady} scientificFrameIdentity={xtbVisibleScientificIdentity} currentScientificFrameIdentity={currentXtbScientificFrameIdentity} assertConfirmedSourceCurrent={assertConfirmedXtbSourceCurrent} electronicDrafts={xtbElectronicDrafts} onElectronicDraftChange={changeXtbElectronicDraft} prepareElectronicSource={prepareXtbElectronicSource} taskSelections={xtbTaskSelections} onTaskSelectionChange={changeXtbTaskSelection} methodDrafts={xtbMethodDrafts} onMethodDraftChange={changeXtbMethodDraft} assertTargetCurrent={assertXtbTargetCurrent} onObserve={source=>{if(!activeId)return;assertXtbTargetCurrent(activeId);observeAdvancedSource(activeId,source);}} onCanvas={publishXtbCanvas} onAnalysisSelection={publishXtbAnalysisSelection} renderManagedTaskControls={({documentId,document,running})=>managedTaskControls(documentId,document,running)} onOpenPlot={openPlot} onExtract={extractFrame} onPrepareInput={structure=>{extractFrame(structure);requestNewInputTask();}} onError={setError}/>}
  {pesClosing&&<DialogShell aria-label="关闭势能面内容" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={cancelPesClose}><h2>{pesClosing.nodeId?'关闭势能面标签':'删除势能面任务组'}</h2><p>{pesClosing.label}的相关计算结束后，将关闭对应页面和其中的结果记录。</p><div className="modal-buttons"><button disabled={pesDeleting} onClick={cancelPesClose}>取消</button><button className="button-primary" disabled={pesDeleting} onClick={()=>void confirmPesClose()}>{pesDeleting?'正在收尾':'确认'}</button></div></DialogShell>}
  {postprocess.dialog}
  {diagnosticsOpen&&sourceDiagnostics.length>0&&<SourceDiagnostics items={sourceDiagnostics} onClose={()=>setDiagnosticsOpen(false)} onRemove={removeSourceDiagnostic}/>}
  {pendingSourceCopy&&<DialogShell aria-label="在新标签页继续" className="modal workspace-scientific-edit-choice" backdropClassName="modal-backdrop" onCancel={()=>pendingSourceCopy.resolve(false)}><h2>在新标签页继续</h2><p>{pendingSourceCopy.purpose==='file-import'?'在新标签页载入文件，原构象帧保留。':pendingSourceCopy.purpose==='xtb-electronic-state'?'当前计算来源和旧波函数将保留原始电子态。复制当前完整帧，在新标签页设置本次单点。':<>当前帧属于构象搜索，原始帧将保留。<br/>将复制当前帧，在新标签页继续本次操作。</>}</p><div className="modal-buttons"><button onClick={()=>pendingSourceCopy.resolve(false)}>取消</button><button className="button-primary" onClick={()=>pendingSourceCopy.resolve(true)}>{pendingSourceCopy.purpose==='file-import'?'在新标签页载入文件':'在新标签页继续'}</button></div></DialogShell>}
  {pendingEdit&&pendingEdit.request.documentId===activeId&&!detachedPlacement.current[pendingEdit.request.documentId]&&<DialogShell aria-label={protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':pendingConformerInitialEdit?'修改构象初始结构':'修改来源结构'} className="modal workspace-scientific-edit-choice" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} initialFocus={()=>tabs.current?.ownerDocument.querySelector<HTMLElement>('[data-scientific-edit-copy]')??null} onCancel={()=>{if(!editChoiceBusy)void resolveScientificEdit('cancel');}}><h2>{protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':pendingConformerInitialEdit?'修改构象初始结构':'修改来源结构'}</h2><p>{protectedConformerSource(pendingEdit.request.documentId)?'当前帧属于构象搜索，原始帧将保留。将复制当前帧，在新标签页继续本次操作。':pendingConformerInitialEdit?'已有采样或优化设置及结果将保留原来源；修改后须重新确认电荷与自旋多重度，确认时采用当前帧。增删原子或改变元素后须建立新搜索。确认后继续本次修改？':'此修改会使当前结构的后处理结果暂不可用。撤销相关修改后可恢复。'}</p>{pendingEditError&&<DismissibleNotice identity={pendingEdit}>{pendingEditError}</DismissibleNotice>}<div className="modal-buttons"><button data-scientific-edit-copy className="button-primary" disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('copy')}>{protectedConformerSource(pendingEdit.request.documentId)?'在新标签页继续':'在新标签页建模'}</button>{!protectedConformerSource(pendingEdit.request.documentId)&&<button disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('current')}>{pendingConformerInitialEdit?'确认修改':'在当前标签页建模'}</button>}<button disabled={editChoiceBusy} onClick={()=>void resolveScientificEdit('cancel')}>取消</button></div></DialogShell>}
  {structureLibraryOpen&&<StructureLibrary display={displaySettings} onClose={()=>{libraryLoadController.current?.abort();setStructureLibraryOpen(false);}} onLoad={loadLibraryStructure}/>}
  {resultImportRequest&&<DialogShell aria-label="识别到计算结果" className="modal workspace-import-choice" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>resolveResultImport('cancel')}><h2>{resultImportDescriptions.map(value=>`识别为 ${value}`).join('；')}</h2><p>查看计算结果与波函数，或载入最后完整结构继续建模。</p><div className="modal-buttons"><button onClick={()=>resolveResultImport('analysis')}>进入后处理</button><button onClick={()=>resolveResultImport('structure')}>只载入结构</button><button onClick={()=>resolveResultImport('cancel')}>取消导入</button></div></DialogShell>}
  {(newInputTarget||preparedInputTarget||advancedInputTarget)&&<DialogShell aria-label="新建输入任务确认" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>{setNewInputTarget(null);setPreparedInputTarget(null);setAdvancedInputTarget(null);}}><h2>新建输入任务？</h2><p>当前输入草稿将被替换，请先导出需要保留的输入。模型结构与冻结不会删除。</p><div className="modal-buttons"><button onClick={()=>{setNewInputTarget(null);setPreparedInputTarget(null);setAdvancedInputTarget(null);}}>取消</button><button onClick={()=>{if(advancedInputTarget)prepareAdvancedInput(advancedInputTarget.source,true);else if(preparedInputTarget)prepareIrc(preparedInputTarget.structure,preparedInputTarget.engine,true);else if(newInputTarget)startNewInputTask(newInputTarget);}}>放弃当前草稿并新建</button></div></DialogShell>}
  {cancelBatchConfirm&&borrowedBatch&&<DialogShell aria-label="取消批量输入" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>setCancelBatchConfirm(false)}><h2>取消批量输入？</h2><p>关闭临时代表帧并恢复原文档；原轨迹与已保存文件保留。</p><div className="modal-buttons"><button onClick={()=>setCancelBatchConfirm(false)}>继续配置</button><button onClick={()=>void finishBatchInput(borrowedBatch.session.id)}>取消批量输入</button></div></DialogShell>}
  <output hidden data-testid="workspace-input-session-state">{JSON.stringify({taskId:inputTask?.id??null,ownerDocumentId:inputOwnerId??null,activationEpoch:inputTask?.activationEpoch??null,activeDocumentId:activeId,module:state.module})}</output>
  {runtimeDataOpen&&portableToolsAvailable&&<RuntimeDataPanel request={requestPortableTools} onClose={()=>setRuntimeDataOpen(false)} disabled={maintenanceDisabled} capabilities={{runtimeCheck:true,diagnosticsExport:true}}/>}
  {!project.dialog&&!firstRunLicense.ready&&<FirstRunLicense snapshot={firstRunLicense.snapshot} loading={firstRunLicense.loading} saving={firstRunLicense.saving} error={firstRunLicense.error} onContinue={()=>void firstRunLicense.acknowledge()} onRetry={firstRunLicense.retry}/>}
  {!project.dialog&&firstRunLicense.ready&&environmentOpen&&<EnvironmentSettings onClose={closeEnvironmentSettings} initialPage={environmentPage} navigation={settingsNavigation} display={settingsModel?displaySettings:undefined} onDisplayChange={settingsModel?changeDisplaySettings:undefined} atoms={settingsModel?.draft.structure.atoms} hasCell={!!settingsModel?.draft.structure.cell} targetLabel={settingsEntry?.label} showAxes={sharedShowAxes} onShowAxesChange={setSharedShowAxes}/>}
  {project.busy&&<span className="workspace-project-status" role="status">{project.status}</span>}
  {deleteGroup&&<DialogShell aria-label="删除整个构象搜索组" className="modal" backdropClassName="modal-backdrop" onCancel={()=>{if(!deletingGroup)setDeleteGroup(null);}}><h2>删除整个构象搜索组？</h2><p>将移除“{conformerGroups[deleteGroup]?.label??'构象搜索'}”的初猜、采样/优化页面和本次任务结果。</p><p>项目目录外的原始文件和导出文件保留。</p><div className="modal-buttons"><button disabled={deletingGroup} onClick={()=>setDeleteGroup(null)}>取消</button><button disabled={deletingGroup} className="button button-primary" onClick={()=>void confirmDeleteGroup()}>{deletingGroup?'正在删除…':'删除整个组'}</button></div></DialogShell>}
  {closingPending?<DialogShell aria-label="正在丢弃内容" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>{}}><span role="status">正在丢弃内容并释放关联资源…</span></DialogShell>:closing&&discardImpact&&<DialogShell aria-label="丢弃内容确认" className="modal" backdropClassName="modal-backdrop" ownerDocument={tabs.current?.ownerDocument} onCancel={()=>void cancelClose(closing)}><h2>丢弃这些内容？</h2><p>将从当前工作区永久移除以下内容及列出的下游结果，不能撤销。</p><ul>{discardImpact.impactLabels.map(label=><li key={label}>{label}</li>)}</ul><p>外部原始文件、已导出文件和此前手动保存的项目保留。</p><div className="modal-buttons"><button onClick={()=>void cancelClose(closing)}>取消</button><button className="button button-primary" onClick={()=>void executeDiscard(discardImpact)}>丢弃</button></div></DialogShell>}
  <output hidden data-testid="workspace-document-state">{JSON.stringify({activeDocumentId:activeId,displayedDocumentId,toolTargetDocumentId:activeId,activeViewId:state.activeViewId,activationEpoch:state.activationEpoch,module:state.module,deckMode,detached,documents:state.documents.map(entry=>({id:entry.id,epoch:entry.epoch,revision:entry.store.getSnapshot().revision,sourceEpoch:entry.sourceEpoch,label:entry.label,runtime:entry.runtime,analysisAvailable:registry.analysisAvailable(entry.id),analysisBindingId:entry.store.getSnapshot().analysisBindingId??null}))})}</output>
 </div></WorkspaceRenderBoundary>{taskWorkspace.dialog}{project.dialog}</>}</ProjectUiRestoreBoundary></>;
}
