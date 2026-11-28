import NumericInput from '../NumericInput';
import {useProjectState} from '../../projects/ui-state';
import { DismissibleNotice } from '../DismissibleNotice';
import { dispatchWorkspaceUndoPress } from './workspace-undo';
import { isWorkspaceFreezeCommand,readOnlyFreezeHold } from './workspace-freeze-policy';
import { createPortal } from 'react-dom';
import { confirmSynchronousOperation, ANALYSIS_INVALIDATION_CONFIRMATION } from '../confirmation';
import { DialogSurface } from '../DialogShell';
import { Snowflake, Library } from 'lucide-react';
import AtomSelectionControls, { BondSelectionControls, useAtomSelectionTools } from './AtomSelectionControls';
import type { InputFreezeDisplay } from '../../core/input-freezes';
import {viewportSamplingSphere} from './render/sampling-sphere-preview';
import { ToolbarGrid, type WorkbenchToolAction } from './ToolbarGrid';
import FragmentLibrary from './FragmentLibrary';
import { WorkbenchLayoutEditor, useWorkbenchLayout } from './WorkbenchLayout';
import GeometrySmartSlide from './GeometrySmartSlide';
import { editBuilderGeometryBalanced, editBuilderGeometryBalanced as editBuilderGeometry, builderEditableGeometryFrame, type BalancedGeometryEdit } from '../../core/builder-geometry';
import { getBuilderTemplate } from '../../core/builder-templates';
import { geometryGuide, coordinateSize } from '../../core/geometry-guides';
import { emptyMeasurementSession, transientMeasurement, pickSessionMeasurement, pickSessionBondMeasurement, clearPendingMeasurement, clearSessionMeasurements, retainMeasurementSession, activateMeasurementRecord } from './measurement-state';
import { applyToolSessionMeasurement, planToolSessionTransition, readWorkspaceOptimizationPreferences, writeWorkspaceOptimizationPreferences, parseWorkspaceOptimizationPreferences, OPTIMIZATION_PREFERENCE_EVENT, OPTIMIZATION_PREFERENCE_KEY, type WorkspaceOptimizationPreferences, type ToolSessionIntent, type ToolSessionState } from './tool-session';
import { Suspense, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ProjectOptimizationContext } from './project-calculation-level';
import type { ModelWorkspaceBaseProps } from './ModelWorkspaceProps';
import { builderApplyResult, type BuilderCommand } from '../../core/builder-draft';
import { createModelStore, getFrozenAtomIds, getMovableAtomIds, ModelConflictError } from '../../core/modeling';
import {applyFrameBondOverride,defaultFrameBondIdentity,frameBondHistoryState,frameBondIdentityKey,frameBondScientificFingerprint,isFrameBondCommand} from '../../core/modeling/frame-bond-overrides';
import {EmpiricalFrameBonds,empiricalFrameBondDisplayWarnings} from '../../results/empirical-frame-bonds';
import { effectiveModelCoordinates, modelConstraintSources, modelCoordinateKey } from '../../modeling/constraints';
import { clampWorkbenchPaneSize } from '../../modeling/workbench-layout';
import { coordinateAssociations, displayedCoordinateObjects, recordObject, sessionFromCoordinateObjects, isObservationCoordinateRecord, removeObservationCoordinate, type ObservationCoordinateOwnership } from './coordinate-objects';
import { selectionWithAtomState, type AtomStateAction, type ViewportStateMarker } from './viewport-overlays';
import { formatAtomSelection, parseAtomSelection } from '../../core/structures';
import { isPeriodic, canonicalPeriodicBond } from '../../core/periodic';
import {electronicStateParameterError,electronicStateWarning} from '../../core/elements';
import {pairEditedElectronicState,type ElectronicStateEditField} from '../../core/base-electronic-state';
import {useModelElectronicDraft} from '../useModelElectronicDraft';
import {electronicStateIntegerInput} from '../BaseElectronicStateFields';
import ElectronicStateWarning from '../ElectronicStateWarning';
import {StructureSourceNotice} from './StructureSourceNotice';
import type { JobRequest, Structure, Vector3 } from '../../core/types';
import type { OrcaJobRequest, OrcaSettings } from '../../core/orca/types';
import type { BondAggression, BondOrder, ChemistryJob, ClipboardPayload, DisplaySettings, FragmentSnapshot, InteractionAction, ModelCommand, ModelDocument, MeasurementState, MeasurementRecord, SelectionCaptureRequest, SelectionCaptureResult, ModelFormat, ModelSelection, ModelStore, PastePolicy, PickResult } from '../../modeling/contracts';
import { DEFAULT_DISPLAY } from '../../modeling/contracts';
import { createChemistryPort } from '../../modeling/chemistry';
import { exportModel, getFormatDescriptors } from '../../modeling/platform/files';
import { importModelSources } from '../../modeling/platform/import-model';
import { readModelDisplayPreferences, restoreModelDisplayPreferences, writeModelDisplayPreferences } from '../../modeling/platform/display-preferences';
import { captureGaussianCoordinates } from '../../modeling/application/gaussian-bridge';
import { defaultPlacementCommand } from '../../modeling/application/default-placement';
import { captureOrcaAssignments, captureOrcaCoordinates, getOrcaMovableAtomIds } from '../../modeling/application/orca-bridge';
import { createModelInteraction, elementForHoldTap } from './interaction';
import ModelViewport from './ModelViewport';
import type {ViewportCameraControls} from './render/adapter';
import ViewportErrorBoundary from './ViewportErrorBoundary';
import { type CellPresentationOptions } from '../../core/modeling/cell-presentation';
import {workspaceCurrentProtectionDocument} from './workspace-source-validity';
import type {TwoDImportFile} from '../../modeling/application/two-d-import';
import type {TwoDCommitGuard} from './TwoDSessionWorkspace';
import {registerImportedModelSources,forgetImportedModelSources,commitImportedModelSourceBundle} from '../../projects/import-sources';
import {runtimePreviewSourceCurrent} from '../../core/modeling/runtime-source-lineage';
import {workspaceLiveViewportDocument,workspaceDisplayFrozenAtomIds} from './workspace-live-preview';
import type { CellEditorViewportDraft, CellEditorPanelState } from './CellEditorPanel';
import type {SamplingSphereViewportDraft,SamplingSphereRadiusChange} from '../../modeling/advanced/sampling-sphere';
import ModelWorkspaceToolbar from './ModelWorkspaceToolbar';
import { startImportBondPerception } from '../../modeling/application/import-bond-perception';
import ElementColorControls from './ElementColorControls';
import DisplayPresetControls from './DisplayPresetControls';
import {ScientificEditCancelledError} from '../../core/modeling/analysis-binding';
import ElementPresetPalette from './ElementPresetPalette';
import { defaultElementPresetId, getElementPreset } from '../../core/modeling/element-presets';
import DynamicsPanel, { displayedDynamicsFrame, useModelMdDraft } from './DynamicsPanel';
import { emptyObservationView, updateObservationView } from './render/alignment';
import { preparationPortNotice } from './preparation-status';
import {captureScientificModelDocument,captureDisplayedStructureDocument,scientificCanvasKey,scientificCanvasStructure} from './scientific-frame-source';
import {projectStructureExportDocument} from '../../modeling/application/structure-export-snapshot';
import { DynamicsController, createStoreDynamicsDependencies } from '../../modeling/dynamics/controller';
import { createDynamicsPort } from '../../modeling/dynamics/port';
import ElementTable from './ElementTable';
import SaveStateDialog, { type SaveElectronicState } from './SaveStateDialog';
import { blockingModelDialog, editableTarget, hoverCommand, viewportCommand, workspaceSpacePressAllowed,workspaceSpaceOptimizationAction } from './workspace-actions';
import './workspace.css';
import type {WorkspaceActivationStamp} from '../../modeling/workspace-contracts';
import {createCopiedFragmentSeed} from '../../core/modeling/copied-fragment';
import PersonalFragmentLibrary from './PersonalFragmentLibrary';
import type {PersonalFragmentStoreAPI} from '../../modeling/personal-fragments';
import CanvasClearToolbar from './CanvasClearToolbar';
import { createDocumentOperations, type DocumentOperationResult } from '../../modeling/application/document-operations';
import { createWorkspaceAsyncGuard, createPersonalFragmentContextGuard } from '../../modeling/application/workspace-async-guards';
export { createWorkspaceAsyncGuard, createPersonalFragmentContextGuard };
export type { WorkspaceAsyncIdentity } from '../../modeling/application/workspace-async-guards';
import type {DocumentRuntimeOwner} from '../../modeling/application/document-runtime-owner';
import ActiveStructurePreview from './ActiveStructurePreview';
import { createActiveStructurePreview, type ActiveStructurePreviewSource } from './active-structure-preview';
import { createClipboardPreviewGuard } from './clipboard-preview-guard';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import { captureRebaseResult, createCaptureRebasePublisher, pointerModeAtPress, type CaptureRebaseResult } from './modeling-interaction-policy';
import { HoldKeyCorner, useModelShortcuts } from './use-model-shortcuts';
import { bindModelWorkspaceKeys, useModelWorkspaceKeyboardLifecycle } from './model-workspace-keyboard';
import { createModelWorkspaceViewportDispatcher } from './model-workspace-viewport';
import { assertModelWorkspaceRuntimeOwner, deactivateModelWorkspaceRuntime, modelWorkspaceRuntimeBusy, type WorkspaceRuntimeOwner } from './model-workspace-runtime';
export { assertModelWorkspaceRuntimeOwner, deactivateModelWorkspaceRuntime, modelWorkspaceRuntimeBusy } from './model-workspace-runtime';
import XtbOptimizationPanel, { OrdinaryConstraintDetails,ordinaryRunSettingsValid,xtbPanelSubmission,type OrdinaryRunSettings,type XtbPanelOptions } from './XtbOptimizationPanel';
import {useGxtbBackend,gxtbRunBlocked,GxtbAvailability} from '../results/GxtbPathControl';
import BondPerceptionControls, { type BondPerceptionMethod } from './BondPerceptionControls';
import PeriodicModelingPanel, { initialPeriodicModelingDraft, type PeriodicModelingDraft, type PeriodicModelingRequest, type PeriodicInspectRequest, type PeriodicModelingTask } from './PeriodicModelingPanel';
import GeometryTransformPanel, { newGeometryDraft, type GeometryTransformDraft, type GeometryTransformTask } from './GeometryTransformPanel';
import AdvancedModelingNavigation, {type AdvancedModelingRoute} from './AdvancedModelingNavigation';
import type {TransformPreviewPresentation} from './structure-transform-panel';
import {useAnalysisAtomCapture} from '../results/useAnalysisAtomCapture';
import { prepareStructureTransform, type StructureTransformEdit } from '../../core/modeling/structure-transform';
import { prepareCellEditorCandidate, type CellEditorRequest } from '../../core/modeling/cell-editor';
import {mergeCoordinateAnnotations} from './coordinate-annotations';
import { mapStructureTransformDocument } from '../../core/modeling/structure-transform-document';
import type { StructureTransformCandidate } from '../../core/modeling/contracts';
import type { CrystalResult } from '../../modeling/crystal-contracts';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import ViewportImageExportMenu from './ViewportImageExportMenu';
import {captureViewportLegend} from '../results/viewport-legend-export';
import { exportViewportImage, exportBlob, viewportImageDisplay, type OffscreenCaptureSnapshot, type ViewportImageExportOptions } from '../results/export-image';
import { presentedVibrationAtoms, presentedVibrationStructure } from '../results/vibration-animation';
import { useStructureInteractionAnalysis } from '../results/useStructureInteractionAnalysis';
import {createTrustedViewportDisplayProjection,type ViewportDisplayProjection} from './viewport-display-channel';
import {createLatestMoveScheduler} from './viewport-move-scheduler';
import type {ModelViewportProps} from './ModelViewport';
import {useCurrentCipUsage} from './use-cip-usage';
import { transferSlabCameraView } from './slab-preview-presentation';
import { XtbController, type XtbOptions, type XtbState } from '../../modeling/xtb/controller';
import { bondOrderStructureKey } from '../../modeling/bond-orders';
import { nextXtbDisplayObservation, projectXtbPreview, xtbOptimizationDisplayStatus, type XtbDisplayObservation } from './xtb-preview';
import { getMDProtectionInfo, supportsMDIntegrator } from '../../modeling/dynamics/md-methods';
import type { DynamicsConfig } from '../../modeling/dynamics/controller';
import type { DynamicsOperation } from '../../modeling/dynamics/contracts';
import { desktopBridge } from '../../modeling/platform/desktop';
import {adoptOrdinaryOptimizationGeometry,finalizeStandaloneOrdinaryOptimization,observeOrdinaryOptimizationTiming,ordinaryOptimizationInput,ordinaryOptimizationStartupText,prepareOrdinaryOptimization,standaloneOptimizationRequest} from './pes-ordinary-optimization';
import {selectWorkspaceOptimizationMethod,workspaceOptimizationMethodAvailable,workspaceNetSettings,workspaceOptimizationKind,workspaceXtbSettings} from './tool-session';

import {PES_SCHEMA,isPesNetMethod,type PesFrame,type PesRequest,type PesResult} from '../../modeling/pes/contracts';
import {ordinaryOptimizationError,ordinaryOptimizationStatus,projectOrdinaryOptimizationStructure} from '../../modeling/pes/ordinary-optimization-geometry';
import {validPesFrame} from '../../modeling/pes/frames';
import {trajectoryPlaybackEventCurrent,type WorkspaceViewportState,type WorkspaceViewportEvent,type WorkspaceViewportController,type WorkspaceModelCommandPort,type ModelBondPerceptionRequest} from './workspace-viewport';
import {bondPerceptionElectronicState,bondElectronicDraftCurrent,captureBondElectronicDraft,type BondElectronicDraft} from './bond-perception-electronic-state';
import {captureScienceRuntimeSource,isScienceFrameReference,notifyScienceRuns,pesFrameEvidence,pesRequestEvidence,registerScienceModelRuntime,scienceModelReceipts,type ScienceModelRuntime,type ScienceRuntimeRun,type RetainedOrdinaryOptimization,type RetainedOrdinaryOptimizationRequest} from '../mcp/science-runtime';
import {toolError} from '../mcp/types';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {isXtbMethod} from '../../core/xtb-capabilities';
const TwoDSessionWorkspace=lazy(()=>import('./TwoDSessionWorkspace'));

export interface WorkspaceToolIntent extends Omit<ToolSessionState,'geometryOpen'> {personalFragmentsOpen:boolean;personalLibraryFilter:string;personalLibrarySelectedId:string|null;periodicTableOpen:boolean;bondOrder:BondOrder}
export type WorkspaceViewportImageCapture = (options: ViewportImageExportOptions, signal: AbortSignal) =>
  Promise<{blob: Blob; provenance: Record<string, unknown>}>;

export interface ModelWorkspaceProps extends ModelWorkspaceBaseProps {
  derivedSupercellSource?: Structure;
  samplingSphereDraft?:SamplingSphereViewportDraft|null;
  onSamplingSphereRadiusChange?(change:SamplingSphereRadiusChange):void;
  inputFreezeDisplay?: InputFreezeDisplay;
  jobRequest?: JobRequest;
  orcaJobRequest?: OrcaJobRequest;
  store?: ModelStore;
  documentRuntime?:DocumentRuntimeOwner;
  realtime?: boolean;
  onDynamicsController?: (controller: DynamicsController | null) => void;
  toolHost?: HTMLElement | null;
  toolbarHost?: HTMLElement | null;
  captureRequest?: SelectionCaptureRequest;
  onCaptureConfirm?(result: SelectionCaptureResult): void;
  onCapturePreview?(result: SelectionCaptureResult): void;
  onCaptureRebase?(result: CaptureRebaseResult): void;
  onCaptureCancel?(): void;
  active?: boolean;
  activationStamp?(): WorkspaceActivationStamp;
  assertActivation?(stamp: WorkspaceActivationStamp): void;
  assertActivationIdentity?(stamp: WorkspaceActivationStamp): void;
  assertRuntimeCurrent?(stamp: WorkspaceActivationStamp): void;
  onNewDocument?(): void;
  onImportFiles?(files: File[]): Promise<void>;
  onImportTwoDFiles?(files: File[]): Promise<boolean>;
  onOpenTwoD?():void;
  twoDActive?:boolean;
  onOpenStructureLibrary?():void;
  onOpenSettings?():void;
  sharedLayout?: boolean;
  documentName?: string;
  documentNameOrigin?:'automatic'|'manual';
  onSavedName?(name: string): void;
  onViewportState?(state: WorkspaceViewportState): void;
  onViewportController?(controller: WorkspaceViewportController | null): void;
  onViewportImageCapture?(capture: WorkspaceViewportImageCapture | null): void;
  /** Complete view-local pose for a newly borrowed/extracted frame. */
  initialCameraView?:readonly number[];
  initialViewTransform?:ModelViewportProps['viewTransform'];
  onDisplayProjection?(projection:ViewportDisplayProjection|null,observer:ModelViewportProps['onSurfaceMeshState']):void;
  onCipLabelsUsed?:ModelViewportProps['onCipLabelsUsed'];
  viewportDockTarget?: { x: number; y: number; width: number; height: number };
  onActivate?(): void;
  displaySettings?: DisplaySettings;
  onDisplaySettingsChange?(next: DisplaySettings): void;
  sharedShowAxes?: boolean;
  onSharedShowAxesChange?(value: boolean): void;
  viewportActive?: boolean;
  detachedViewportActive?: boolean;
  legendVisible?: boolean;
  layoutActions?: ReactNode;
  onLegendSurfaceChange?(surface: ReactNode): void;
  legendExpanded?: boolean;
  onLegendExpandedChange?(expanded: boolean): void;
  linkedAtomsActive?: boolean;
  workspaceInputRoles?: WorkspaceViewportState['workspaceInputRoles'];
  observationOnly?: boolean;
  /** Observation controls/annotations do not disable the common editor. */
  allowModelEditing?: boolean;
  /** False for every conformer result page, including trajectory frame zero. */
  freezeEditingAllowed?:boolean;
  /** Explicit current-model postprocessing route; does not activate editing/runtime. */
  structureAnalysisActive?: boolean;
  structureAnalysisRequestedPage?:{id:string;kind:'surface'};
  analysisCanvas?: import('../results/analysis-canvas').AnalysisCanvas;
  presentationActive?: boolean;
  workspaceDocumentPickMode?: 'source' | 'link';
  workspaceDocumentPickSelected?: boolean;
  toolIntent?: WorkspaceToolIntent;
  /** Module entry selects the pointer default without changing model state. */
  workspaceModule?: string;
  onToolIntentChange?(next: WorkspaceToolIntent): void;
  /** The shell subscribes in one stable render root; the document retains its
   * actions/runtime. Inactive owners never clear a newer owner's surfaces. */
  onToolSurfaceChange?(surface:ReactNode):void;
  onModelToolsChange?(surface:ReactNode):void;
  onLeftToolSurfaceChange?(surface:ReactNode):void;
  onToolbarSurfaceChange?(surface:ReactNode):void;
  linkedAtomActions?:ReactNode;
  onAtomNumberPick?(atomId:string):void;
  advancedModelingRoute?:AdvancedModelingRoute;
  onAdvancedModelingRouteChange?(route:AdvancedModelingRoute):void;
  onAdvancedModelingBack?():void;
  onDeriveStructure?(candidate:StructureTransformCandidate,source?:ModelDocument,signal?:AbortSignal):string|void|Promise<string|void>;
  onRetainedOptimization?:RetainedOrdinaryOptimization;
  onWorkspaceHistory?(kind:'undo'|'redo'):boolean;
  workspaceCanUndo?:boolean;workspaceCanRedo?:boolean;
}
/** One shared next-operation/preview intent. This is neither model state nor
 * native ownership: annotations, selection, actual freezes and q/m stay local. */
export function createDefaultWorkspaceToolIntent():WorkspaceToolIntent{return{element:'C',persistentTool:null,copiedTool:false,freezeTool:null,observationTool:'rotate',presetId:'c-sp3',template:'methyl',activeFragmentIndex:0,copiedPayload:null,copyActiveIndex:0,previewSource:{kind:'element',presetId:'c-sp3'},previewActiveIndex:undefined,personalFragmentsOpen:false,personalLibraryFilter:'',personalLibrarySelectedId:null,periodicTableOpen:false,bondOrder:1};}
function mergeWorkspaceToolIntent(previous:WorkspaceToolIntent,patch:Partial<WorkspaceToolIntent>):WorkspaceToolIntent{
  const next={...previous,...patch};
  if('previewSource' in patch&&patch.previewSource)next.previewSource=structuredClone(patch.previewSource);
  if('copiedPayload' in patch&&patch.copiedPayload)next.copiedPayload=next.previewSource.kind==='copy'&&'payload' in next.previewSource&&patch.previewSource?.kind==='copy'&&'payload' in patch.previewSource&&patch.previewSource.payload===patch.copiedPayload?next.previewSource.payload:structuredClone(patch.copiedPayload);
  return next;
}
/** Automatic document/capture/clipboard activity must never overwrite the
 * user's shared choice when another document mounts, changes or loses focus. */
export function reduceWorkspaceToolIntent(previous:WorkspaceToolIntent,intent:ToolSessionIntent):WorkspaceToolIntent{
  if(['runtime-status','capture-start','capture-end','document-reset','clipboard-cache'].includes(intent.type))return previous;
  const {geometryOpen:_local,...patch}=planToolSessionTransition(intent).patch;
  return mergeWorkspaceToolIntent(previous,{...patch,...(intent.type==='escape'?{element:null}:{})});
}
export function resetModelWorkspaceTransientInteraction(keyboard:ReturnType<typeof createModelInteraction>){
  const gesture=keyboard.getSnapshot().gesture;keyboard.reset('blur');if(gesture!=='none')keyboard.beginGesture(gesture);return keyboard.getSnapshot();
}
const EMPTY_SELECTION: ModelSelection = { atomIds: [], bonds: [], auxiliaryIds: [] };
export function observationModelSelection(selection:ModelSelection,structure:Structure,display?:Pick<ModelDocument,'auxiliaryRelations'|'attachmentPorts'>):ModelSelection{
  const ids=new Set(structure.atoms.map(atom=>atom.id)),auxiliaryIds=new Set(display?.auxiliaryRelations.map(row=>row.id)),portIds=new Set(display?.attachmentPorts?.map(row=>row.id));
  return{...selection,atomIds:selection.atomIds.filter(id=>ids.has(id)),bonds:selection.bonds.filter(bond=>bond.atomIds.every(id=>ids.has(id))),auxiliaryIds:selection.auxiliaryIds.filter(id=>auxiliaryIds.has(id)),portIds:selection.portIds?.filter(id=>portIds.has(id))??[],coordinateIds:[]};
}
export interface CellExportChoice { documentId:string; withCell:boolean }
/** Box export is a document choice, independent of the cell's visibility. */
export function modelCellExportDefault(document:Pick<ModelDocument,'id'|'draft'>,choice:CellExportChoice|null):boolean {
  return choice?.documentId===document.id?choice.withCell:Boolean(document.draft.structure.cell);
}
/** PES protection forbids edits; a presented geometry remains exportable
 * while another frame loads or the prepared collection keeps playing. */
export function readonlyPesStructureExportReady(canvas:ModelWorkspaceProps['analysisCanvas'],active=true):boolean{
  return Boolean(active&&canvas?.pesConstraints&&!canvas.displayOnlySourcePreview&&canvas.document?.draft.structure.atoms.length&&
    (canvas.exportStructure||canvas.scientificFrameReady!==false&&(!canvas.result||canvas.scientificFrameReady===true)));
}
export type PreoptimizationScope = 'all' | 'selection' | 'unselected';
/** Range changes only the variable ID set. The complete molecular graph,
 * current engine activity/freeze context and constraints stay authoritative. */
export function preoptimizationMovableAtomIds(document: ModelDocument, scope: PreoptimizationScope, settings?: OrcaSettings): string[] {
  const movable = settings ? getOrcaMovableAtomIds(document, settings, 'all') : getMovableAtomIds(document, 'all');
  const selected = new Set(document.selection.atomIds);
  return movable.filter(id => scope === 'all' || (scope === 'selection' ? selected.has(id) : !selected.has(id)));
}
const message = (cause: unknown) => cause instanceof ScientificEditCancelledError ? '' : cause instanceof Error ? cause.message : String(cause);
// Apply normalizes provenance and task charge outside this private workspace.
// Its acknowledgement is identified by actual model identity and geometry.
const structureKey = (value: Structure | null) => JSON.stringify(value && {
  atoms: value.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.x, atom.y, atom.z]),
  bonds: value.bonds ?? [], cell: value.cell ?? null, dimension: value.dimension ?? 3,
});
let browserClipboard: ClipboardPayload | null = null;
// A shared immutable tool source has one preview snapshot across document
// owners. Keeping its identity also keeps the preview's current camera.
const toolPreviewSnapshots=new WeakMap<ActiveStructurePreviewSource,ReturnType<typeof createActiveStructurePreview>>();
interface TransformPanelSession {
  expanded: Record<'periodic'|'geometry', string[]>;
  drafts: Record<string, PeriodicModelingDraft | GeometryTransformDraft>;
  live: Record<string, boolean>;
  cell?: CellEditorPanelState;
}
const transformPanelSessions = new WeakMap<ModelStore, TransformPanelSession>();
const newTransformPanelSession = (): TransformPanelSession => ({ expanded: { periodic: [], geometry: [] }, drafts: {}, live: {} });
function workspaceToolPreview(source:ActiveStructurePreviewSource){let preview=toolPreviewSnapshots.get(source);if(!preview){preview=createActiveStructurePreview(source);toolPreviewSnapshots.set(source,preview);}return preview;}

function initialStore(props: ModelWorkspaceProps) {
  const coordinates = props.orcaJobRequest ? captureOrcaCoordinates(props.structure, props.orcaJobRequest.settings) : props.jobRequest ? captureGaussianCoordinates(props.structure, props.jobRequest.settings) : undefined;
  const assignments = props.assignments ?? (props.orcaJobRequest ? captureOrcaAssignments(props.structure, props.orcaJobRequest.settings) : undefined);
  return createModelStore(props.structure, assignments, coordinates);
}

export function runtimeViewportConsumesPreview(props:Pick<ModelWorkspaceProps,'viewportActive'|'detachedViewportActive'|'active'>):boolean {
  return Boolean(props.detachedViewportActive)||(props.viewportActive??props.active)!==false;
}

export function sameViewportAtomIds(previous:readonly string[]|undefined,next:readonly string[]|undefined):boolean {
  return previous===next||Boolean(previous&&next&&previous.length===next.length&&previous.every((id,index)=>id===next[index]));
}

export default function ModelWorkspace(props: ModelWorkspaceProps) {
  const gxtbBackend=useGxtbBackend();
  const presentationActive=(props.presentationActive??props.active)!==false;
  const { structure, selected, onSelect, onSelectIds, onDraftChange, onApply, onCancel, onExtract, onCopied, openRequest = 0, highlights, jobRequest, orcaJobRequest } = props;
  const assignments = props.assignments ?? (orcaJobRequest ? captureOrcaAssignments(structure, orcaJobRequest.settings) : undefined);
  const workbenchLayout=useWorkbenchLayout();
  const stageRef=useRef<HTMLDivElement>(null);
  const sizeGesture=useRef<{pointerId:number;startY:number;height:number}|null>(null);
  const [privateStore, setStore] = useState(() => initialStore(props));
  const store = props.store ?? privateStore;
  const [transformSession,setTransformSession] = useState(() => transformPanelSessions.get(store) ?? newTransformPanelSession());
  const updateTransformSession = (change:(value:TransformPanelSession)=>TransformPanelSession) => setTransformSession(previous => {
    const next=change(previous);transformPanelSessions.set(store,next);return next;
  });
  useEffect(()=>{setTransformSession(transformPanelSessions.get(store)??newTransformPanelSession());},[store]);
  const dynamics = useMemo(()=>props.documentRuntime?.dynamics??new DynamicsController(createDynamicsPort(),createStoreDynamicsDependencies(store,{isolated:true,captureSource:()=>captureOperationSource()})),[store,props.documentRuntime]);
  const dynamicState=useSyncExternalStore(dynamics.subscribe,dynamics.getSnapshot,dynamics.getSnapshot);
  useEffect(()=>{props.onDynamicsController?.(dynamics);return()=>{props.onDynamicsController?.(null);};},[dynamics,props.onDynamicsController]);
  useEffect(()=>{dynamics.connect();return()=>{if(!props.documentRuntime)dynamics.disconnect();};},[dynamics,props.documentRuntime]);
  useLayoutEffect(()=>props.documentRuntime?.attachPresentation(()=>captureOperationSource(),()=>latest.current.props.active!==false),[store,props.documentRuntime]);
  const model = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const defaultBondIdentity=useMemo(()=>defaultFrameBondIdentity(model),[model]);
  const frameBondIdentity=props.analysisCanvas?.frameBondIdentity??(!props.analysisCanvas?defaultBondIdentity:undefined);
  const rawBondDocument=props.analysisCanvas?.staticDocument??model;
  const bondDocument=useMemo(()=>frameBondIdentity?applyFrameBondOverride(model,rawBondDocument,frameBondIdentity):rawBondDocument,[model,rawBondDocument,JSON.stringify(frameBondIdentity)]);
  const frameBondHistory=useMemo(()=>frameBondIdentity?frameBondHistoryState(model,rawBondDocument,frameBondIdentity):null,[model,rawBondDocument,frameBondIdentity]);
  const bondCanvasDocument=useMemo(()=>props.analysisCanvas?.document&&frameBondIdentity?applyFrameBondOverride(model,props.analysisCanvas.document,frameBondIdentity):props.analysisCanvas?.document,[model,props.analysisCanvas?.document,JSON.stringify(frameBondIdentity)]);
  const sharedElectronicDraft=useModelElectronicDraft(store);
  // Preserve the diagnostic format without serializing base coordinates on every preview.
  const draftDiagnostic=useMemo(()=>JSON.stringify({...model.draft,past:model.draft.past.length,future:model.draft.future.length}).slice(0,-1)+',',[model.draft]);
  // Tool parameters belong to the document. Each panel validates and rebuilds
  // its preview against the current geometry and revision when opened.
  const observationKey=frameBondIdentity?frameBondIdentityKey(frameBondIdentity):props.analysisCanvas?.document&&(props.observationOnly===true||Boolean(props.analysisCanvas.prepareModelEdit))?`${props.analysisCanvas.result?.id??model.id}:${props.analysisCanvas.frameIndex??0}`:null;
  const [observationSelection,setObservationSelection]=useState<{key:string;selection:ModelSelection}|null>(null);
  const observationSelectionRef=useRef(observationSelection);
  const observedSelectionListeners=useRef(new Set<Parameters<WorkspaceModelCommandPort['subscribeObservedSelection']>[0]>());
  const editingStructure=bondDocument.draft.structure;
  const workingSelection=useMemo(()=>observationKey?observationModelSelection(observationSelection?.key===observationKey?observationSelection.selection:model.selection,editingStructure,bondDocument):model.selection,[observationKey,observationSelection,model.selection,editingStructure,bondDocument]);
  const latest = useRef({ store, props, workingSelection }); latest.current = { store, props, workingSelection };
  const shortcuts = useModelShortcuts(), holdBindings = useRef(shortcuts.bindings); holdBindings.current = shortcuts.bindings;
  const [keyboard] = useState(() => { const value=createModelInteraction({ getSelectKey: () => holdBindings.current.select }); value.setElement('C');return value; });
  const [keyboardInteraction, setInteraction] = useState(keyboard.getSnapshot);
  const [localToolIntent,setLocalToolIntent]=useState(createDefaultWorkspaceToolIntent);
  const toolIntent=props.toolIntent??localToolIntent,toolIntentMirror=useRef(toolIntent);toolIntentMirror.current=toolIntent;
  const interaction={...keyboardInteraction,element:toolIntent.element};
  const {persistentTool,activeFragmentIndex,copiedTool,copyActiveIndex,personalFragmentsOpen,previewSource,previewActiveIndex,freezeTool,observationTool,presetId,template,bondOrder}=toolIntent;
  const periodicTable=toolIntent.periodicTableOpen;
  function publishToolIntent(next:WorkspaceToolIntent){const target=latest.current.props;if(target.toolIntent!==undefined){if(!target.onToolIntentChange)return;toolIntentMirror.current=next;target.onToolIntentChange(next);}else{toolIntentMirror.current=next;setLocalToolIntent(next);}}
  function patchToolIntent(patch:Partial<WorkspaceToolIntent>){publishToolIntent(mergeWorkspaceToolIntent(toolIntentMirror.current,patch));}
  const setPersonalFragmentsOpen=(value:boolean|((previous:boolean)=>boolean))=>patchToolIntent({personalFragmentsOpen:typeof value==='function'?value(toolIntentMirror.current.personalFragmentsOpen):value});
  const setPeriodicTable=(value:boolean|((previous:boolean)=>boolean))=>patchToolIntent({periodicTableOpen:typeof value==='function'?value(toolIntentMirror.current.periodicTableOpen):value});
  const setBondOrder=(value:BondOrder)=>patchToolIntent({bondOrder:value});
  useEffect(()=>{if(keyboard.getSnapshot().gesture==='none'&&keyboard.getSnapshot().element!==toolIntent.element){keyboard.setElement(toolIntent.element);setInteraction(keyboard.getSnapshot());}},[keyboard,toolIntent.element]);
  const advancedObservation=Boolean(props.observationOnly&&props.analysisCanvas?.useWorkspaceImageExport);
  const measurementOwnerKey=advancedObservation?props.analysisCanvas?.measurementOwnerKey:undefined;
  const [modelMeasurementState,setModelMeasurementState]=useState(()=>emptyMeasurementSession());
  const [readonlyMeasurementState,setReadonlyMeasurementState]=useState<{key:string;session:ReturnType<typeof emptyMeasurementSession>}|null>(null);
  const measurementSession=measurementOwnerKey?(readonlyMeasurementState?.key===measurementOwnerKey?readonlyMeasurementState.session:emptyMeasurementSession()):modelMeasurementState;
  const setMeasurementSession:(typeof setModelMeasurementState)=update=>{if(measurementOwnerKey)setReadonlyMeasurementState(previous=>{const current=previous?.key===measurementOwnerKey?previous.session:emptyMeasurementSession();return{key:measurementOwnerKey,session:typeof update==='function'?update(current):update};});else setModelMeasurementState(update);};
  const modelObservationOwnership=useRef<ObservationCoordinateOwnership>({documentId:model.id,recordIds:new Set()});
  const readonlyObservationOwnership=useRef<{key?:string;current:ObservationCoordinateOwnership}>({current:{documentId:model.id,recordIds:new Set()}});
  if(readonlyObservationOwnership.current.key!==measurementOwnerKey)readonlyObservationOwnership.current={key:measurementOwnerKey,current:{documentId:model.id,recordIds:new Set()}};
  const observationOwnership=measurementOwnerKey?readonlyObservationOwnership.current:modelObservationOwnership;
  function modelMeasurementSession(previous:Parameters<typeof sessionFromCoordinateObjects>[0],document=store.getSnapshot()){return sessionFromCoordinateObjects(previous,advancedObservation&&props.analysisCanvas?.document?props.analysisCanvas.document:document,observationOwnership.current);}
  const visibleMeasurementSession=modelMeasurementSession(measurementSession,model);
  const measurement:MeasurementState={...transientMeasurement(visibleMeasurementSession),records:mergeCoordinateAnnotations(visibleMeasurementSession.records,props.analysisCanvas?.coordinateAnnotations??[]),activeRecordId:visibleMeasurementSession.activeRecordId};
  const [personalFragmentSaveRequest,setPersonalFragmentSaveRequest]=useState(0);
  const previewIntentEpoch=useRef(0);
  const activePreview=useMemo(()=>{try{return{model:workspaceToolPreview(previewSource),error:''};}catch(cause){return{model:null,error:message(cause)};}},[previewSource]);
  const copiedForPersonal=useRef<{payload:ClipboardPayload|null;activeIndex:number}>({payload:null,activeIndex:0});copiedForPersonal.current={payload:activePreview.model?.payload??null,activeIndex:previewActiveIndex??activePreview.model?.defaultActiveAtomIndex??0};
  const clipboardEpoch=useRef(0),clipboardChannel=useRef<BroadcastChannel|null>(null);
  const [geometryOpen,setGeometryOpen]=useState(false),[captureAtomIds,setCaptureAtomIds]=useState<string[]>([]),[localShowAxes,setLocalShowAxes]=useState(false);
  const geometryEditorOwner=useRef<{store:typeof store;documentId:string;recordId:string}|null>(null);
  const showAxes=props.sharedShowAxes??localShowAxes;
  function toggleAxes(){if(latest.current.props.sharedShowAxes!==undefined)latest.current.props.onSharedShowAxesChange?.(!latest.current.props.sharedShowAxes);else setLocalShowAxes(value=>!value);}
  const captureMirror = useRef<{requestId:string;atomIds:string[];images?:Vector3[]}|null>(null);
  const [cameraRequest,setCameraRequest]=useState<{serial:number;kind:'standard'|'cell'|'step';preset?:'a'|'a*'|'b'|'b*'|'c'|'c*';direction?:'left'|'right'|'up'|'down'}>();
  const [cameraView,setCameraView]=useState<number[]|undefined>(()=>props.initialCameraView?[...props.initialCameraView]:undefined);
  const initialCameraPending=useRef(Boolean(props.initialCameraView));
  const viewportGetter=useRef<(()=>number[])|null>(null);
  const viewportZoom=useRef<ViewportCameraControls|null>(null);
  const analysisCameraControls=props.analysisCanvas?.onCameraControls;
  useLayoutEffect(()=>{analysisCameraControls?.(viewportZoom.current);return()=>analysisCameraControls?.(null);},[analysisCameraControls]);
  const sourceViewportGetter=useRef<(()=>number[])|null>(null);
  const [sourceCameraView,setSourceCameraView]=useState<number[]>();
  const [linkedSlabView,setLinkedSlabView]=useState(true);
  const linkedSlabBasis=useRef('');
  const [imageExporting,setImageExporting]=useState(false),[imageExportOpenRequest,setImageExportOpenRequest]=useState(0);
  const imageExportAbort=useRef<AbortController|null>(null);
  useEffect(()=>()=>{imageExportAbort.current?.abort();imageExportAbort.current=null;},[model.id]);
  useLayoutEffect(()=>{props.analysisCanvas?.onViewReady(viewportGetter.current);},[props.analysisCanvas?.onViewReady]);
  const acceptCameraView=(view:number[])=>{if(!Array.isArray(view)||view.length!==8||view.some(value=>!Number.isFinite(value)))throw new Error('视角数据无效。');setCameraView(previous=>JSON.stringify(previous)===JSON.stringify(view)?previous:[...view]);};
  const activeMeasurement=visibleMeasurementSession.records.find(record=>record.id===visibleMeasurementSession.activeRecordId);
  const geometryEditorLease=geometryEditorOwner.current;
  const wheelGeometry=useRef<{recordId:string;baseline:Structure;value:number;timer:ReturnType<typeof setTimeout>|null}|null>(null);
  const geometryMoving=useRef<BalancedGeometryEdit['moving']>('branch');
  const geometryScope=useRef<Pick<BalancedGeometryEdit,'moving'|'sideModes'|'sideAtomIds'>>({moving:'branch',sideModes:{first:'branch',last:'branch'}});
  const [temporaryPointerMode,setTemporaryPointerMode]=useState<'select'|'freeze'|null>(null);
  const heldPointerKey=useRef<{key:string;mode:'select'|'freeze';used:boolean}|null>(null),heldLetters=useRef(new Set<string>());
  const keyEventRef=useRef<(event:KeyboardEvent,release:boolean,remote?:boolean,detachedFrame?:boolean)=>void>(()=>{});
  const viewportDispatch=useRef<WorkspaceViewportController['dispatch']>(()=>{});
  const viewportBusy=useRef<()=>boolean>(()=>false);
  const cancelInteractionRef=useRef<()=>void>(()=>{});
  useLayoutEffect(()=>{cancelInteractionRef.current();},[JSON.stringify(frameBondIdentity)]);
  const viewportPreoptimization=useRef<NonNullable<WorkspaceViewportController['preoptimize']>>(async()=>{});
  const modelCommands=useRef<WorkspaceModelCommandPort>(null!);
  const viewportController=useMemo<WorkspaceViewportController>(()=>({dispatch:(event,context)=>viewportDispatch.current(event,context),isBusy:()=>viewportBusy.current(),cancelInteraction:()=>cancelInteractionRef.current(),getCameraView:()=>viewportGetter.current?.(),getCameraZoomDistance:()=>viewportGetter.current?viewportZoom.current?.getZoomDistance():undefined,preoptimize:settings=>viewportPreoptimization.current(settings),get model(){return modelCommands.current;}}),[]);
  useEffect(()=>{heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);},[model.id,props.active,shortcuts.bindings.select,shortcuts.bindings.freeze]);
  const [resetViewRequest,setResetViewRequest]=useState(0);
  const [localDisplay, setLocalDisplay] = useState<DisplaySettings>(() => ({ ...DEFAULT_DISPLAY }));
  const display=props.displaySettings??localDisplay;
  const displayEditEpoch = useRef(0), displayDefaultsAlive = useRef(true), displayDefaultsPending = useRef(false);
  const [displayDefaults, setDisplayDefaults] = useState<Awaited<ReturnType<typeof readModelDisplayPreferences>> | null>(null);
  const [displayDefaultsBusy, setDisplayDefaultsBusy] = useState(false), [displayDefaultsError, setDisplayDefaultsError] = useState(''), [displayDefaultsStatus, setDisplayDefaultsStatus] = useState('');
  function changeDisplay(next: DisplaySettings) { displayEditEpoch.current++;if(latest.current.props.displaySettings!==undefined)latest.current.props.onDisplaySettingsChange?.(next);else setLocalDisplay(next);setDisplayDefaultsStatus(''); }
  useEffect(() => {
    displayDefaultsAlive.current = true;
    let alive = true;
    void readModelDisplayPreferences().then(snapshot => {
      if (!alive) return;
      setDisplayDefaults(snapshot); setDisplayDefaultsError(snapshot.error ?? '');
      if (displayEditEpoch.current === 0&&latest.current.props.displaySettings===undefined) setLocalDisplay(structuredClone(snapshot.display));
    }).catch(cause => { if (alive) setDisplayDefaultsError(`读取显示默认值失败：${message(cause)}`); });
    return () => { alive = false; displayDefaultsAlive.current = false; };
  }, []);
  async function persistDisplayDefaults(restore = false) {
    if (!displayDefaults?.writable || displayDefaultsPending.current) return;
    const selectedDisplay = structuredClone(display), editEpoch = displayEditEpoch.current;
    displayDefaultsPending.current = true; setDisplayDefaultsBusy(true); setDisplayDefaultsError(''); setDisplayDefaultsStatus('');
    try {
      const snapshot = await readModelDisplayPreferences();
      if(!displayDefaultsAlive.current)return;
      setDisplayDefaults(snapshot);
      if(!snapshot.writable)throw new Error(snapshot.error??'显示偏好当前不可写，原内容已保留。');
      const saved = restore ? await restoreModelDisplayPreferences(snapshot) : await writeModelDisplayPreferences(snapshot, selectedDisplay);
      if (!displayDefaultsAlive.current) return;
      setDisplayDefaults(saved); setDisplayDefaultsError(saved.error ?? '');
      if (restore && displayEditEpoch.current === editEpoch&&JSON.stringify(latest.current.props.displaySettings??display)===JSON.stringify(selectedDisplay)) changeDisplay(structuredClone(saved.display));
      setDisplayDefaultsStatus(restore ? '已恢复内置显示默认值' : '已保存显示默认值，新窗口读取');
    } catch (cause) { if (displayDefaultsAlive.current) setDisplayDefaultsError(message(cause)); }
    finally { displayDefaultsPending.current = false; if (displayDefaultsAlive.current) setDisplayDefaultsBusy(false); }
  }
  const [errorNotice,setErrorNotice]=useState({text:'',revision:0});
  const error=errorNotice.text;
  const setError=useCallback((text:string)=>setErrorNotice(previous=>({text,revision:previous.revision+1})),[]);
  const [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [plane, setPlane] = useState(false),[planeRetained,setPlaneRetained]=useState(false);
  const [localPlaneFile]=useState<TwoDImportFile>(()=>({id:`two-d-local-${crypto.randomUUID()}`,name:'drawing',kind:'structure',bytes:new Uint8Array()}));
  const periodicToolsOpen=props.advancedModelingRoute?.category==='periodic'&&Boolean(props.advancedModelingRoute.task);
  const transformToolsOpen=props.advancedModelingRoute?.category==='geometry'&&Boolean(props.advancedModelingRoute.task);
  const structureAnalysisOpen=props.structureAnalysisActive===true&&!props.analysisCanvas;
  const [structurePreview,setStructurePreview]=useState<StructureTransformCandidate|null>(null);
  const [transformPresentation,setTransformPresentation]=useState<TransformPreviewPresentation|null>(null);
  const [transformHighlightIds,setTransformHighlightIds]=useState<string[]>([]);
  const [cellEditorDraft,setCellEditorDraft]=useState<CellEditorViewportDraft|null>(null);
  useEffect(()=>{if(props.active!==false&&props.advancedModelingRoute?.task==='cell-editor')store.execute({type:'ensure-cell-checkpoint'});},[store,model.id,props.active,props.advancedModelingRoute?.task]);
  const referenceCapture=useAnalysisAtomCapture({ownerId:`advanced-modeling:${model.id}`,structure:model.draft.structure,documentId:model.id,revision:model.revision,sourceId:model.id,frameIndex:0,activationEpoch:JSON.stringify([props.activationStamp?.().activationEpoch??0,props.advancedModelingRoute]),active:props.active!==false&&(periodicToolsOpen||transformToolsOpen),purpose:'advanced-region',onError:setError});
  const [crystalPreviewResult,setCrystalPreviewResult]=useState<CrystalResult|null>(null);
  const [periodicGfn2Available,setPeriodicGfn2Available]=useState(false);
  // Per-document form state, deliberately excluded from shared/persisted presets.
  const [bondElectronicPrompt,setBondElectronicPrompt]=useState<{documentId:string;revision:number;context:BondElectronicDraft;charge:string;multiplicity:string;lastEditedField?:ElectronicStateEditField;pairingIssue?:string|null}|null>(null);
  function pairBondPrompt(pending:NonNullable<typeof bondElectronicPrompt>,field=pending.lastEditedField){
    if(!field||pending.lastEditedField!==field||!/^[+-]?\d+$/.test(pending.charge)||!/^\+?\d+$/.test(pending.multiplicity))return pending;
    const values={charge:Number(pending.charge),multiplicity:Number(pending.multiplicity)},result=pairEditedElectronicState(atoms,values,field,values[field]);
    return result.error?{...pending,pairingIssue:result.error}:{...pending,charge:String(result.values.charge),multiplicity:String(result.values.multiplicity),lastEditedField:undefined,pairingIssue:null};
  }
  const [selectionInput, setSelectionInput] = useState('');
  const [saveFormat, setSaveFormat] = useState<ModelFormat>('xyz'), [saveModal, setSaveModal] = useState(false),[saveModalWithCell,setSaveModalWithCell]=useState(false),[saveBusy,setSaveBusy]=useState(false);
  const [saveState, setSaveState] = useState<{ format: ModelFormat; token?: string; snapshot: ModelDocument; request?: JobRequest | OrcaJobRequest; withCell:boolean; assertCurrent():void } | null>(null);
  const saveModalSource=useRef<ModelDocument|undefined>(undefined);
  const preparedTransformSources=useRef(new WeakMap<StructureTransformCandidate,{source:ModelDocument;key:string;crystal?:CrystalResult}>());
  const saveModalGuard = useRef<(()=>void)|null>(null), saveBusyRef=useRef(false), asyncAlive = useRef(true);
  const xtbContext = useRef<{ store: ModelStore; documentId: string; generation: number; lease?: WorkspaceActivationStamp; referenceStructure?: Structure } | null>(null);
  const xtb = useMemo(() => props.documentRuntime?.xtb??new XtbController({ store, bridge: desktopBridge(), chemistry: createChemistryPort(),allowWorkingEdits:true,captureSource:()=>captureOperationSource(),
    confirmConstraints: () => true, // The selected constraints own admission; the native residual checks remain mandatory.
    assertCurrent() {
      const context = xtbContext.current;
      if(!context)throw new Error('xTB运行缺少所属文档身份。');
      assertModelWorkspaceRuntimeOwner(context,{alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,assertRuntimeCurrent:latest.current.props.assertRuntimeCurrent,assertActivationIdentity:latest.current.props.assertActivationIdentity});
    },
  }), [store,props.documentRuntime]);
  const xtbState = useSyncExternalStore(xtb.subscribe, xtb.getSnapshot, xtb.getSnapshot);
  const continuationBackendBlocked=gxtbRunBlocked(gxtbBackend,xtbState.continuationMethod??'');
  useEffect(()=>{let alive=true;void desktopBridge()?.info().then(info=>{if(alive)setPeriodicGfn2Available(info.periodicGfn2BondOrders===true);}).catch(()=>{if(alive)setPeriodicGfn2Available(false);});return()=>{alive=false;};},[]);
  const xtbDisplayObservation=useRef<XtbDisplayObservation|undefined>(undefined);
  const previewVisible=runtimeViewportConsumesPreview(props);
  const xtbSourceDocument=xtb.getWorkingSourceDocument(),dynamicsSourceDocument=dynamics.getWorkingSourceDocument();
  const xtbFrameCurrent=previewVisible&&xtbState.workingSource?.documentId===model.id&&(xtbState.workingSource.revision===model.revision||xtbState.running&&runtimePreviewSourceCurrent(xtb.getWorkingOwnerDocument(),model));
  const dynamicsFrameCurrent=previewVisible&&!['pending','retained'].includes(dynamicState.resultAdoption??'')&&dynamicState.workingSource?.documentId===model.id&&(dynamicState.workingSource.revision===model.revision||['starting','running','pausing','paused','stopping'].includes(dynamicState.status)&&runtimePreviewSourceCurrent(dynamics.getWorkingOwnerDocument(),model));
  const shownDynamicsFrame=previewVisible?displayedDynamicsFrame(dynamicState):undefined;
  // Final adoption advances the Store revision. Refit that confirmed last
  // geometry once without allowing an old run to display over a later edit.
  const dynamicsDisplayFrameCurrent=dynamicsFrameCurrent||dynamicState.mode==='md'&&['stopped','completed','error'].includes(dynamicState.status)
    &&dynamicState.workingSource?.documentId===model.id&&!!shownDynamicsFrame
    &&graphFingerprint(model.draft.structure)===graphFingerprint(shownDynamicsFrame.structure)
    &&coordinatesFingerprint(model.draft.structure)===coordinatesFingerprint(shownDynamicsFrame.structure);
  const shownXtbFrame=xtbFrameCurrent?xtbState.previewFrame:undefined;
  const sharedOptimization=useRef<{documentId:string;method:string;runId:string;stop():Promise<void>}|null>(null);
  const sharedOptimizationPending=useRef(false);
  const retainedOptimizationAdoptions=useRef(new Set<AbortController>());
  const scienceRuns=scienceModelReceipts(store);
  const [sharedOptimizationFrame,setSharedOptimizationFrame]=useState<{id:string;revision:number;structure:Structure;markCommitted?:()=>void}>();
  const resumeSharedOptimizationPreview=useRef<(()=>void)|null>(null);
  useLayoutEffect(()=>{
    if(previewVisible)resumeSharedOptimizationPreview.current?.();
    else setSharedOptimizationFrame(undefined);
  },[previewVisible]);
  useLayoutEffect(()=>{
    if(previewVisible&&sharedOptimizationFrame?.id===model.id&&sharedOptimizationFrame.revision===model.revision)
      sharedOptimizationFrame.markCommitted?.();
  },[previewVisible,model.id,model.revision,sharedOptimizationFrame]);
  const [optimizationStatus,setSharedOptimizationStatus]=useState<{documentId:string;method:string;device?:unknown;identity?:string;text:string;error?:string;errorCode?:string}>();
  const sharedOptimizationStatus=optimizationStatus?.documentId===model.id?optimizationStatus:undefined;
  const [sharedOptimizationEvidence,setSharedOptimizationEvidence]=useState<{request:PesRequest;result:PesResult}>();

  useEffect(()=>{setSharedOptimizationStatus(undefined);setSharedOptimizationEvidence(undefined);},[model.id]);
  const ordinaryRun=currentOrdinaryOptimization();
  function currentOrdinaryOptimization(){
    const current=latest.current,run=sharedOptimization.current;
    return current.props.analysisCanvas?.ordinaryOptimization??(run?.documentId===current.store.getSnapshot().id?run:undefined);
  }
  const validTransformPresentation=transformPresentation&&structurePreview===transformPresentation.candidate&&structurePreview.documentId===model.id&&structurePreview.expectedRevision===model.revision?transformPresentation:null;
  const tiledTransform=props.advancedModelingRoute?.category==='periodic'&&props.advancedModelingRoute.task==='slab'&&(transformSession.live['periodic:slab']??true)&&!referenceCapture.viewportCapture;
  const wasTiled=useRef(false);
  useLayoutEffect(()=>{if(tiledTransform===wasTiled.current)return;wasTiled.current=tiledTransform;if(tiledTransform){const view=viewportGetter.current?.()??cameraView;if(view)setSourceCameraView([...view]);}else{const view=sourceCameraView;if(view)acceptCameraView(view);}},[tiledTransform]);
  const viewportModel=useMemo(()=>{
    const xtbPreview=projectXtbPreview(model,shownXtbFrame,xtb.getWorkingOwnerDocument());
    return workspaceLiveViewportDocument({model:!props.analysisCanvas?bondDocument:model,observationOnly:props.observationOnly,canvasDocument:bondCanvasDocument?{...model,...bondCanvasDocument,selection:workingSelection}:undefined,useWorkspaceImageExport:props.analysisCanvas?.useWorkspaceImageExport,
      structurePreview:!referenceCapture.viewportCapture&&structurePreview&&structurePreview.documentId===model.id&&structurePreview.expectedRevision===model.revision?{...model,draft:{...model.draft,structure:validTransformPresentation?.displaySource?validTransformPresentation.source:structurePreview.structure}}:undefined,
      runtimePreview:previewVisible&&sharedOptimizationFrame?.id===model.id&&sharedOptimizationFrame.revision===model.revision?{...model,draft:{...model.draft,structure:sharedOptimizationFrame.structure}}:dynamicsFrameCurrent&&shownDynamicsFrame?{...model,draft:{...model.draft,structure:shownDynamicsFrame.structure}}:xtbPreview!==model?xtbPreview:undefined});
  },[model,bondDocument,bondCanvasDocument,shownXtbFrame,xtbSourceDocument,props.observationOnly,props.analysisCanvas?.document,props.analysisCanvas?.useWorkspaceImageExport,structurePreview,validTransformPresentation,referenceCapture.viewportCapture,dynamicsFrameCurrent,shownDynamicsFrame,workingSelection,sharedOptimizationFrame,previewVisible]);
  const bondOrderEntries=useMemo(()=>{
    if(advancedObservation||!model.bondOrderObservation)return undefined;
    const original=model.draft.structure,visible=viewportModel.draft.structure;
    return original===visible||bondOrderStructureKey(original)===bondOrderStructureKey(visible)?model.bondOrderObservation.entries:undefined;
  },[advancedObservation,model.bondOrderObservation,model.draft.structure,viewportModel.draft.structure]);
  const viewportDisplay=props.advancedModelingRoute?.task==='cell-editor'&&structurePreview?{...display,cell:true}:display;
  const mdObservation=useRef(emptyObservationView());
  const effectiveFrozenAtomIds=useMemo(()=>getFrozenAtomIds(model),[model.draft.assignments,model.draft.structure.atoms,model.sharedConstraints]);
  const viewportCipStructure=props.analysisCanvas?.viewport.cipStructure;
  const cipDocument=useMemo(()=>viewportCipStructure===undefined?viewportModel:viewportCipStructure?{
    ...viewportModel,draft:{...viewportModel.draft,structure:viewportCipStructure},
  }:undefined,[viewportModel,viewportCipStructure]);
  const onCipLabelsUsed=useCurrentCipUsage(cipDocument,(props.viewportActive??props.active)!==false,props.onCipLabelsUsed);
  const mdObservationEnabled=previewVisible&&dynamicState.mode==='md'&&!props.observationOnly&&!structurePreview&&!shownXtbFrame&&!props.initialViewTransform&&!props.analysisCanvas?.viewport.viewTransform;
  const mdAlignmentEnabled=mdObservationEnabled&&!viewportModel.draft.structure.cell;
  const mdDisplayFrame=mdObservationEnabled&&dynamicsDisplayFrameCurrent?shownDynamicsFrame:undefined;
  if(mdAlignmentEnabled)mdObservation.current=updateObservationView(mdObservation.current,{documentId:model.id,structure:viewportModel.draft.structure,
    reference:mdDisplayFrame?dynamicState.referenceStructure:undefined,epoch:mdDisplayFrame?dynamicState.sessionId:undefined,frame:mdDisplayFrame?.seq,
    mode:viewportDisplay.alignment,frozenAtomIds:effectiveFrozenAtomIds,softAnchorAtomIds:mdDisplayFrame?.nativeMD?.protectedAtomIds});
  const mdObservationTransform=mdAlignmentEnabled?mdObservation.current.transform:undefined;
  const observeDynamics=(dynamicState.mode==='md'?mdObservationEnabled&&dynamicsDisplayFrameCurrent:dynamicsFrameCurrent);
  const slabViewState=useRef({presentation:validTransformPresentation,linked:linkedSlabView,source:model.draft.structure,candidate:viewportModel.draft.structure});
  slabViewState.current={presentation:validTransformPresentation,linked:linkedSlabView,source:model.draft.structure,candidate:viewportModel.draft.structure};
  function syncSlabView(view:number[],from:'source'|'candidate'){
    const current=slabViewState.current,rotation=current.presentation?.rotation;
    if(!current.linked||!rotation)return;
    const target=from==='source'?viewportGetter.current?.():sourceViewportGetter.current?.();if(!target)return;
    const atoms=(from==='source'?current.candidate:current.source).atoms;
    const pivot=[0,1,2].map(axis=>atoms.reduce((sum,atom)=>sum+[atom.x,atom.y,atom.z][axis],0)/Math.max(1,atoms.length)) as Vector3;
    const next=transferSlabCameraView(view,target,rotation,from,pivot);
    if(from==='source')acceptCameraView(next);else setSourceCameraView(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  }
  const acceptSourceCameraView=(view:number[])=>{setSourceCameraView(previous=>JSON.stringify(previous)===JSON.stringify(view)?previous:view);syncSlabView(view,'source');};
  const acceptCandidateCameraView=(view:number[])=>{acceptCameraView(view);if(tiledTransform)syncSlabView(view,'candidate');};
  useEffect(()=>{
    if(!tiledTransform||!linkedSlabView){linkedSlabBasis.current='';return;}
    const rotation=validTransformPresentation?.rotation;if(!rotation||!sourceViewportGetter.current||!viewportGetter.current)return;
    const signature=JSON.stringify([model.id,rotation]);if(linkedSlabBasis.current===signature)return;
    linkedSlabBasis.current=signature;
    try{syncSlabView(sourceViewportGetter.current(),'source');}catch(cause){setError(message(cause));}
  },[tiledTransform,linkedSlabView,validTransformPresentation?.rotation,sourceCameraView,model.id]);
  useLayoutEffect(()=>{setStructurePreview(null);setTransformPresentation(null);setTransformHighlightIds([]);setCellEditorDraft(null);setBondElectronicPrompt(null);},[model.id,model.revision,props.active,props.advancedModelingRoute?.category,props.advancedModelingRoute?.task]);
  if(previewVisible)xtbDisplayObservation.current=nextXtbDisplayObservation(xtbDisplayObservation.current,model,shownXtbFrame,props.documentRuntime?xtbSourceDocument?.draft.structure:xtbContext.current?.referenceStructure,dynamicState.sessionId,xtb.getWorkingOwnerDocument());
  const viewportObservation=xtbDisplayObservation.current;
  useEffect(() => { xtb.connect(); return () => {if(!props.documentRuntime)xtb.disconnect();}; }, [xtb,props.documentRuntime]);
  const structureRuntimeLocked = Boolean(ordinaryRun) || xtbState.running || ['starting','running','pausing','paused','stopping'].includes(dynamicState.status);
  const baseStructureLocked = props.observationOnly===true&&props.allowModelEditing!==true || structureRuntimeLocked&&store.isRuntimeEditingAllowed?.()!==true;
  const previewEditingBlocked=Boolean(props.active!==false&&structurePreview?.documentId===model.id&&structurePreview.expectedRevision===model.revision&&(periodicToolsOpen||transformToolsOpen)&&!referenceCapture.viewportCapture);
  const structureLocked=baseStructureLocked||previewEditingBlocked||props.analysisCanvas?.modelEditingBlocked===true;
  const bondLocked=frameBondIdentity?previewEditingBlocked||props.analysisCanvas?.scientificFrameReady===false||(props.analysisCanvas?.bondEditingBlocked??props.analysisCanvas?.modelEditingBlocked??false):structureLocked;
  const freezeLocked=structureLocked||props.freezeEditingAllowed===false;
  const effectivePointerMode=props.freezeEditingAllowed===false?(temporaryPointerMode==='select'?'select':null):temporaryPointerMode??(freezeTool?'freeze':null);
  const historyLocked=frameBondIdentity?bondLocked:baseStructureLocked||props.analysisCanvas?.modelEditingBlocked===true;
  const frameBondEditing=useMemo(()=>frameBondIdentity?{frameKey:frameBondIdentityKey(frameBondIdentity),blocked:bondLocked,canUndo:frameBondHistory!.canUndo,canRedo:frameBondHistory!.canRedo}:undefined,[JSON.stringify(frameBondIdentity),bondLocked,frameBondHistory?.canUndo,frameBondHistory?.canRedo]);
  const validCellEditorDraft=props.active!==false&&props.advancedModelingRoute?.category==='periodic'&&props.advancedModelingRoute.task==='cell-editor'&&cellEditorDraft?.documentId===model.id&&cellEditorDraft.expectedRevision===model.revision?cellEditorDraft:null;
  const [cellExportChoice,setCellExportChoice]=useState<CellExportChoice|null>(null);
  const withCell=modelCellExportDefault(model,cellExportChoice);
  const setWithCell=(value:boolean)=>setCellExportChoice({documentId:store.getSnapshot().id,withCell:value});
  const [staleAssignments, setStaleAssignments] = useState(false);
  const [pasteConflict, setPasteConflict] = useState<ClipboardPayload | null>(null);
  const [importChoices, setImportChoices] = useState<FragmentSnapshot[]>([]);
  const [aggression, setAggression] = useState<BondAggression>('standard');
  const projectOptimization=useContext(ProjectOptimizationContext);
  const [standalonePreferences,setOptimizationPreferences]=useState(readWorkspaceOptimizationPreferences);
  const optimizationPreferences=projectOptimization?.preferences??standalonePreferences;
  const [scienceMdDraft]=useModelMdDraft(model.id);
  const periodicModel=isPeriodic(model.draft.structure),partialPeriodicBox=model.draft.structure.periodicSource?.completeness==='partial';
  const optimizationKind=workspaceOptimizationKind(optimizationPreferences,periodicModel);
  const optimizationNetKey=periodicModel?'periodicNet':'net';
  const optimizationKey=optimizationKind==='net'?optimizationNetKey:'xtb';
  const xtbSettings=workspaceXtbSettings(optimizationPreferences,periodicModel);
  const netSettings=workspaceNetSettings(optimizationPreferences,periodicModel);
  const optimizationMethod=optimizationKind==='net'?netSettings.method:xtbSettings.method;
  const savedRuntimeSettings=optimizationKind==='net'?netSettings:xtbSettings;
  const [runtimeEdits,setRuntimeEdits]=useState<{documentId:string;drafts:Partial<Record<'xtb'|'net'|'periodicNet',OrdinaryRunSettings>>}>();
  const [resourceOverride,setResourceOverride]=useState<{documentId:string;xtbSingleTaskThreads:number}>();
  const xtbSingleTaskThreads=resourceOverride?.documentId===model.id?resourceOverride.xtbSingleTaskThreads:undefined;
  const optimizationResourceOverrides=xtbSingleTaskThreads===undefined?undefined:{xtbSingleTaskThreads};
  const drafts=runtimeEdits?.documentId===model.id?runtimeEdits.drafts:undefined;
  const runtimeSettings={...savedRuntimeSettings,...drafts?.[optimizationKey]};
  const runtimeSettingsValid=ordinaryRunSettingsValid(optimizationMethod,runtimeSettings);
  function updateOptimizationPreferences(next:WorkspaceOptimizationPreferences,explicitSolvent=false){
    try{
      if(projectOptimization){
        const level=next.calculationLevel??projectOptimization.read().calculationLevel;
        const solvation=next.xtb.solvation;
        projectOptimization.write({...next,calculationLevel:explicitSolvent
          ? {...level,solvationModel:solvation?.model??'none',solvent:solvation?.solvent??''}:level});
      }else setOptimizationPreferences(writeWorkspaceOptimizationPreferences(next,explicitSolvent));
      setError('');
    }
    catch(cause){setError(`优化偏好未保存：${message(cause)}`);}
  }
  function updateRunSettings(patch:OrdinaryRunSettings){
    const edits={...drafts?.[optimizationKey],...patch};
    const settings={...savedRuntimeSettings,...edits};
    let pending:OrdinaryRunSettings|undefined=edits;
    if(ordinaryRunSettingsValid(optimizationMethod,settings)){
      const {maxSccIterations,...geometryEdits}=edits;
      const validScc=maxSccIterations===undefined||Number.isSafeInteger(maxSccIterations)&&maxSccIterations>0;
      updateOptimizationPreferences({...optimizationPreferences,xtb:{...optimizationPreferences.xtb,...geometryEdits,
        ...(validScc&&maxSccIterations!==undefined?{maxSccIterations}:{})}});
      pending=validScc?undefined:{maxSccIterations};
    }
    setRuntimeEdits({documentId:model.id,drafts:{...drafts,[optimizationKey]:pending}});
  }

  useEffect(()=>{
    if(projectOptimization)return;
    const receive=(event:Event)=>setOptimizationPreferences(parseWorkspaceOptimizationPreferences((event as CustomEvent).detail));
    const storage=(event:StorageEvent)=>{if(event.key===OPTIMIZATION_PREFERENCE_KEY)setOptimizationPreferences(readWorkspaceOptimizationPreferences());};
    window.addEventListener(OPTIMIZATION_PREFERENCE_EVENT,receive);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(OPTIMIZATION_PREFERENCE_EVENT,receive);window.removeEventListener('storage',storage);};
  },[Boolean(projectOptimization)]);
  const [optimizationBusy,setOptimizationBusy]=useState(false);
  const [charge, setCharge] = useState(0);
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('z'), [degrees, setDegrees] = useState('15'), [translation, setTranslation] = useState<Vector3>([.1, 0, 0]);
  const hover = useRef<PickResult>({ kind: 'none', worldPoint: [0, 0, 0] });
  const hoveredRecord=useRef<MeasurementRecord|null>(null);
  const hoveredMarker=useRef<ViewportStateMarker|null>(null);
  const hoverStamp = useRef({ id: model.id, revision: model.revision });
  const pointerInCanvas = useRef(false);
  const task = useRef<ChemistryJob | null>(null), generation = useRef(0);
  const pendingNativeJobs=useRef(new Set<ChemistryJob>()),pendingImports=useRef(0);
  function ownNativeJob(job:ChemistryJob){pendingNativeJobs.current.add(job);void job.promise.then(()=>pendingNativeJobs.current.delete(job),()=>pendingNativeJobs.current.delete(job));return job;}
  const localPlanePort=useMemo(()=>{const native=createChemistryPort();return{capabilities:()=>native.capabilities(),start:(request:Parameters<typeof native.start>[0])=>ownNativeJob(native.start(request))};},[]);
  const manualGeometry=useRef<{store:ModelStore;documentId:string;revision:number;pendingRecord?:MeasurementRecord}|null>(null);
  const [geometryEditing,setGeometryEditing]=useState(false);
  const importing = useRef<AbortController | null>(null);
  const incoming = useRef({ structure, openRequest, assignments: JSON.stringify(assignments ?? null) });
  const currentCoordinates = orcaJobRequest ? captureOrcaCoordinates(structure, orcaJobRequest.settings) : jobRequest ? captureGaussianCoordinates(structure, jobRequest.settings) : undefined;
  const coordinateSignature = JSON.stringify(currentCoordinates ?? null);
  const incomingCoordinates = useRef(coordinateSignature);
  const engineScope = orcaJobRequest ? 'orca' : 'gaussian';
  const runPreviewSource:ModelDocument|undefined=props.observationOnly?undefined:shownXtbFrame&&xtbFrameCurrent?xtbSourceDocument:dynamicsFrameCurrent&&shownDynamicsFrame?dynamicsSourceDocument:undefined;
  const markerBase=runPreviewSource??(advancedObservation?workspaceCurrentProtectionDocument(viewportModel,model,props.analysisCanvas?.staticDocument?.draft.structure):model);
  const pesConstraints=props.analysisCanvas?.pesConstraints;
  const displayConstraints=pesConstraints??props.analysisCanvas?.sharedFreezeDisplay;
  const markerModel=useMemo(()=>displayConstraints?{...markerBase,sharedConstraints:displayConstraints,internalCoordinates:[],
    draft:{...markerBase.draft,assignments:{...markerBase.draft.assignments,frozenAtomIds:[],layers:markerBase.draft.assignments.layers.map(layer=>({...layer,frozen:false}))}}}:markerBase,[markerBase,displayConstraints]);
  const explicitDisplayFrozenAtomIds=props.analysisCanvas?.viewport.displayFrozenAtomIds;
  const previousDisplayFrozenIds=useRef<string[]|undefined>(undefined);
  const displayFrozenAtomIds=useMemo(()=>{
    const frozenSource=(!pesConstraints&&runPreviewSource)||markerModel;
    const frozenIds=frozenSource===model?effectiveFrozenAtomIds:getFrozenAtomIds(frozenSource);
    const next=pesConstraints||runPreviewSource?frozenIds:workspaceDisplayFrozenAtomIds(viewportModel,frozenIds,explicitDisplayFrozenAtomIds,advancedObservation&&!displayConstraints);
    if(!sameViewportAtomIds(previousDisplayFrozenIds.current,next))previousDisplayFrozenIds.current=next;
    return previousDisplayFrozenIds.current;
  },[markerModel,model,effectiveFrozenAtomIds,pesConstraints,runPreviewSource,viewportModel.draft.structure.atoms,explicitDisplayFrozenAtomIds,advancedObservation,displayConstraints]);
  const stateMarkers=useMemo(()=>{
  const constraintSources=modelConstraintSources(markerModel,engineScope);
  const coordinateObjects=constraintSources.some(source=>source.kind==='coordinate')?displayedCoordinateObjects(markerModel):[];
  const stateMarkers=constraintSources.flatMap<ViewportStateMarker>(source=>source.kind==='atom'?source.atomIds.map(atomId=>({id:JSON.stringify([source.scope,source.kind,source.id])+(source.atomIds.length>1?`:${atomId}`:''),kind:'freeze' as const,atomIds:[atomId],label:source.label,removable:!advancedObservation&&props.freezeEditingAllowed!==false&&source.removable})):[{id:JSON.stringify([source.scope,source.kind,source.id]),kind:source.action==='scan'?'scan':'freeze',atomIds:source.atomIds,images:source.images,label:source.label,removable:!advancedObservation&&props.freezeEditingAllowed!==false&&source.removable,coordinateId:coordinateObjects.find(object=>source.objectId===object.id||modelCoordinateKey(object)===modelCoordinateKey({type:source.atomIds.length===2?'B':source.atomIds.length===3?'A':'D',atomIds:source.atomIds,images:source.images}))?.id}]);
  if(!advancedObservation&&props.inputFreezeDisplay && !model.sharedConstraints?.canonical){
    const inactive=props.inputFreezeDisplay.inactive;
    const tuple=(ids:readonly string[])=>[ids.join('|'),[...ids].reverse().join('|')].sort()[0];
    const inactiveTuple=new Set((inactive.coordinates??[]).map(row=>tuple(row.atomIds)));
    for(const marker of stateMarkers)if(marker.kind==='freeze'){
      marker.inactive=marker.coordinateId?inactive.coordinateObjectIds.includes(marker.coordinateId)||inactiveTuple.has(tuple(marker.atomIds)):marker.atomIds.length>1?inactiveTuple.has(tuple(marker.atomIds)):marker.atomIds.some(id=>inactive.atomIds.includes(id));
      if(marker.inactive)marker.label='当前输入未采用 · '+(marker.label??'冻结');
    }
    for(const id of inactive.atomIds)if(!stateMarkers.some(marker=>marker.kind==='freeze'&&!marker.coordinateId&&marker.atomIds.length===1&&marker.atomIds[0]===id))stateMarkers.push({id:'inactive-input-atom:'+id,kind:'freeze',atomIds:[id],inactive:true,removable:false,label:'当前输入未采用原子冻结；记录保留'});
    for(const row of inactive.coordinates??[])if(!stateMarkers.some(marker=>marker.kind==='freeze'&&tuple(marker.atomIds)===tuple(row.atomIds)))stateMarkers.push({id:'inactive-input-coordinate:'+row.key,kind:'freeze',atomIds:row.atomIds,coordinateId:row.objectId,inactive:true,removable:false,label:'当前输入未采用'+row.type+'冻结；记录保留'});
  }
  if(explicitDisplayFrozenAtomIds!==undefined&&!runPreviewSource&&!pesConstraints){
    // Read-only result protection owns its frame markers. Editable initial
    // pages retain hard-freeze marker ownership alongside soft protection.
    if(advancedObservation&&!displayConstraints)for(let index=stateMarkers.length-1;index>=0;index--){const marker=stateMarkers[index];if(marker.kind==='freeze'&&!marker.coordinateId&&marker.atomIds.length===1)stateMarkers.splice(index,1);}
    for(const atomId of explicitDisplayFrozenAtomIds)if(displayFrozenAtomIds?.includes(atomId)&&!stateMarkers.some(marker=>marker.kind==='freeze'&&!marker.coordinateId&&marker.atomIds.includes(atomId)))stateMarkers.push({id:`display-protection:${atomId}`,kind:'freeze',atomIds:[atomId],removable:false,label:'保护核心'});
  }
  return stateMarkers;
  },[markerModel.draft.assignments,markerModel.sharedConstraints,markerModel.internalCoordinates,markerModel.coordinateObjects,engineScope,
    props.freezeEditingAllowed,props.inputFreezeDisplay,model.sharedConstraints?.canonical,
    advancedObservation,runPreviewSource,pesConstraints,displayConstraints,explicitDisplayFrozenAtomIds,displayFrozenAtomIds]);
  const incomingScope = useRef<string>('');
  const applied = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scope = useRef<HTMLElement>(null);
  useEffect(()=>{if(props.store)return;store.setScientificEditGuard?.(()=>confirmSynchronousOperation(ANALYSIS_INVALIDATION_CONFIRMATION,scope.current?.ownerDocument));return()=>store.setScientificEditGuard?.(null);},[store,props.store]);
  const structureAnalysis=useStructureInteractionAnalysis({store,document:model,active:structureAnalysisOpen&&!structurePreview&&!structureRuntimeLocked,requestedPage:props.structureAnalysisRequestedPage,onError:setError,onExportImage:()=>{const owner=scope.current?.ownerDocument;if(owner)return exportCurrentViewport({format:'png',includeAnnotations:true},owner);}});
  const projectedViewport=props.observationOnly&&props.analysisCanvas?props.analysisCanvas.viewport:structureAnalysis.viewport;
  // Export observes the committed canvas inputs, never the latest native
  // callback (which may still be queued for display). The copy is sealed only
  // when the user clicks Save, before any file or q/M dialog can yield.
  const exportStructure=props.observationOnly?props.analysisCanvas?.exportStructure:undefined;
  const exportSourceIdentity=JSON.stringify([model.id,props.analysisCanvas?.result?.id,props.analysisCanvas?.result?.source.id,props.analysisCanvas?.result?.source.sha256,props.analysisCanvas?.result?.jobIndex,props.analysisCanvas?.sourceRevision,props.analysisCanvas?.trajectoryPlayback?.state.collectionIdentity]);
  const displayedExportSource=useRef({owner:model,document:viewportModel,structure:exportStructure,displayAtoms:exportStructure?undefined:projectedViewport.displayAtoms,sourceIdentity:exportSourceIdentity});
  useLayoutEffect(()=>{displayedExportSource.current={owner:model,document:viewportModel,structure:exportStructure,displayAtoms:exportStructure?undefined:projectedViewport.displayAtoms,sourceIdentity:exportSourceIdentity};},[model,viewportModel,exportStructure,projectedViewport.displayAtoms,exportSourceIdentity]);
  useEffect(()=>{
    if(!saveModal&&!saveState)return;
    try{(saveState?.assertCurrent??saveModalGuard.current)?.();}
    catch{setSaveState(null);setSaveModal(false);saveModalGuard.current=null;saveModalSource.current=undefined;}
  },[saveModal,saveState,store,props.active,exportSourceIdentity]);
  const observedViewportModel=useMemo(()=>projectedViewport.displayAtoms?{...viewportModel,draft:{...viewportModel.draft,structure:{...viewportModel.draft.structure,atoms:projectedViewport.displayAtoms}}}:viewportModel,[viewportModel,projectedViewport.displayAtoms]);
  const canvasExportReady=!props.analysisCanvas||Boolean(exportStructure)||props.analysisCanvas.scientificFrameReady!==false&&(!props.analysisCanvas.result||props.analysisCanvas.scientificFrameReady===true);
  const structureExportDocument=useMemo(()=>props.onDisplayProjection&&canvasExportReady&&viewportModel.draft.structure.atoms.length?projectStructureExportDocument(model,exportStructure??observedViewportModel.draft.structure):undefined,[props.onDisplayProjection,canvasExportReady,model,viewportModel,exportStructure,observedViewportModel]);
  const renderIdentity=props.analysisCanvas?.viewport.renderIdentity,onSceneSubmitted=props.analysisCanvas?.viewport.onSceneSubmitted;
  const displayProjection=useMemo(()=>props.onDisplayProjection?createTrustedViewportDisplayProjection(model,{...projectedViewport,renderIdentity,onSceneSubmitted,viewTransform:projectedViewport.viewTransform??props.initialViewTransform??mdObservationTransform},observedViewportModel!==model?observedViewportModel:undefined,structureExportDocument,exportSourceIdentity,frameBondEditing):null,
    [model,projectedViewport,renderIdentity,onSceneSubmitted,props.initialViewTransform,mdObservationTransform,observedViewportModel,structureExportDocument,exportSourceIdentity,props.onDisplayProjection,frameBondEditing]);
  useLayoutEffect(()=>{props.onDisplayProjection?.(displayProjection,projectedViewport.onSurfaceMeshState);},[props.onDisplayProjection,displayProjection,projectedViewport.onSurfaceMeshState]);
  useEffect(()=>()=>latest.current.props.onDisplayProjection?.(null,undefined),[]);
  const periodic = isPeriodic(editingStructure), atoms = editingStructure.atoms;
  const electronicRequest=orcaJobRequest??jobRequest;
  const [bondPerceptionMethod,setBondPerceptionMethod]=useProjectState<BondPerceptionMethod>('bond-perception-method','empirical',model.id);
  const [bondPerceptionSolvent,setBondPerceptionSolvent]=useProjectState<string>('bond-perception-solvent','none',model.id);


  useEffect(()=>setBondElectronicPrompt(null),[bondPerceptionMethod]);
  const [empiricalParameters,setEmpiricalParameters]=useState<EmpiricalBondPerceptionParameters>(DEFAULT_EMPIRICAL_BOND_PARAMETERS);
  const [savedXtbElectronic,setSavedXtbElectronic]=useState<BondElectronicDraft|null>(null);
  const [bondElectronicConsent,setBondElectronicConsent]=useState<BondElectronicDraft|null>(null);
  const localXtbDraft=savedXtbElectronic?.documentId===model.id?savedXtbElectronic:null;
  const invalidXtbDraft=localXtbDraft&&(!Number.isSafeInteger(localXtbDraft.charge)||!Number.isSafeInteger(localXtbDraft.multiplicity)||localXtbDraft.multiplicity<1);
  const xtbElectronic=sharedElectronicDraft.present?{charge:/^[+-]?\d+$/.test(sharedElectronicDraft.draft.chargeText)?Number(sharedElectronicDraft.draft.chargeText):NaN,multiplicity:/^\+?\d+$/.test(sharedElectronicDraft.draft.multiplicityText)?Number(sharedElectronicDraft.draft.multiplicityText):NaN}:localXtbDraft&&invalidXtbDraft?{charge:localXtbDraft.charge,multiplicity:localXtbDraft.multiplicity}:{charge:model.draft.structure.charge??Number.NaN,multiplicity:model.draft.structure.multiplicity??Number.NaN};
  useEffect(()=>{setSavedXtbElectronic(null);},[model.id,model.draft.structure.charge,model.draft.structure.multiplicity]);
  function changeXtbElectronic(value:{charge:number;multiplicity:number}){
    if(props.active===false||latest.current.store.getSnapshot().id!==model.id)return;
    if(store.isRuntimeSessionActive?.()||xtb.getSnapshot().running){sharedElectronicDraft.change('charge',Number.isFinite(value.charge)?String(value.charge):'');sharedElectronicDraft.change('multiplicity',Number.isFinite(value.multiplicity)?String(value.multiplicity):'');return;}
    if(Number.isSafeInteger(value.charge)&&Number.isSafeInteger(value.multiplicity)&&value.multiplicity>=1){try{const old=store.getSnapshot().draft.structure;if(old.charge!==value.charge||old.multiplicity!==value.multiplicity)store.execute({type:'set-electronic-state',...value,confirmed:false});setSavedXtbElectronic(null);setError('');}catch(cause){setError(message(cause));}return;}
    if(!Object.is(value.charge,xtbElectronic.charge)||!Object.is(value.multiplicity,xtbElectronic.multiplicity))store.clearBondOrders();
    setSavedXtbElectronic(captureBondElectronicDraft(latest.current.store.getSnapshot(),value));
  }
  const runtimeElectronicInvalid=Boolean(electronicStateParameterError(xtbElectronic.charge,xtbElectronic.multiplicity));
  const electronicFieldProps={electronicRawText:sharedElectronicDraft.present?{charge:sharedElectronicDraft.draft.chargeText,multiplicity:sharedElectronicDraft.draft.multiplicityText}:{charge:Number.isFinite(xtbElectronic.charge)?String(xtbElectronic.charge):'',multiplicity:Number.isFinite(xtbElectronic.multiplicity)?String(xtbElectronic.multiplicity):''},
    onElectronicRawTextChange:(field:'charge'|'multiplicity',text:string)=>{try{sharedElectronicDraft.change(field,text);}catch(cause){setError(message(cause));}},
    onElectronicRawTextCommit:(field:'charge'|'multiplicity',text:string)=>{try{sharedElectronicDraft.commit(field,text);}catch(cause){setError(message(cause));}},electronicDisabled:props.active===false||!atoms.length,electronicWarning:sharedElectronicDraft.draft.pairingError||electronicStateWarning(atoms,xtbElectronic.charge,xtbElectronic.multiplicity)};
  const indices = workingSelection.atomIds.map(id => atoms.findIndex(atom => atom.id === id)).filter(index => index >= 0);
  const selectionNumberSignature=indices.join(',');
  const selectionTools=useAtomSelectionTools({documentId:model.id,structure:editingStructure,atomIds:workingSelection.atomIds,disabled:props.active===false,onSelect:(ids,origin)=>select({...EMPTY_SELECTION,atomIds:ids},origin),onGestureBegin:()=>{if(!observationKey)store.beginSelectionTransaction?.();},onGestureEnd:()=>{if(!observationKey)store.endSelectionTransaction?.();}});

  viewportBusy.current=()=>modelWorkspaceRuntimeBusy({xtb,dynamics,optimization:{busy:optimizationBusy},task:task.current,pendingJobs:pendingNativeJobs.current.size,pendingImports:pendingImports.current,savePending:saveBusyRef.current,store:latest.current.store});
  function assertRuntimeOwner(owner:WorkspaceRuntimeOwner){if(props.documentRuntime){if(owner.store!==store||owner.documentId!==store.getSnapshot().id)throw Error('运行所属模型已变化。');if(owner.lease)props.assertRuntimeCurrent?.(owner.lease);return;}assertModelWorkspaceRuntimeOwner(owner,{alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,assertRuntimeCurrent:latest.current.props.assertRuntimeCurrent,assertActivationIdentity:latest.current.props.assertActivationIdentity});}
  function cancelTask() { void xtb.stop().catch(cause=>setError(message(cause)));generation.current++; importing.current?.abort(); importing.current = null; task.current?.cancel(); task.current = null; setBusy(false);  setStatus(''); }
  function cancelWorkingEditTasks() {
    if(!store.isRuntimeSessionActive?.()||store.isRuntimeEditingAllowed?.()!==true){cancelTask();return;}
    importing.current?.abort();importing.current=null;task.current?.cancel();task.current=null;setBusy(false);setStatus('');
  }
  function resetInteraction() { observationOwnership.current={documentId:store.getSnapshot().id,recordIds:new Set()};heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);applyToolIntent({type:'document-reset'});hover.current = { kind: 'none', worldPoint: [0, 0, 0] }; }
  function currentHover(): PickResult {
    const current = latest.current.store.getSnapshot();
    return hoverStamp.current.id === current.id && hoverStamp.current.revision === current.revision
      ? hover.current : { kind: 'none', worldPoint: [0, 0, 0] };
  }
  function leaveCanvas() {
    pointerInCanvas.current = false; hover.current = { kind: 'none', worldPoint: [0, 0, 0] };
    // A held one-shot H cannot survive leaving and re-entering the canvas.
    // Active captured R/Alt gestures retain their own pointer lifecycle.
    if (keyboard.getSnapshot().gesture === 'none') { keyboard.reset('blur'); setInteraction(keyboard.getSnapshot()); }
  }
  cancelInteractionRef.current=()=>{
    heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);pointerInCanvas.current=false;hover.current={kind:'none',worldPoint:[0,0,0]};hoveredRecord.current=null;hoveredMarker.current=null;
    // Preserve any open gesture's transaction owner. The normal viewport end
    // path still commits/cancels it; clearing transient keys must not orphan it.
    setInteraction(resetModelWorkspaceTransientInteraction(keyboard));
  };
  function captureOperationSource(purpose?:'calculation-source'){
    const current=latest.current,canvas=current.props.analysisCanvas;
    const workingCalculation=purpose==='calculation-source'&&current.props.observationOnly!==true&&
      !canvas?.result&&!canvas?.displayOnlySourcePreview&&!canvas?.modelEditingBlocked;
    return captureScientificModelDocument(current.store.getSnapshot(),workingCalculation?undefined:canvas,
      {purpose,selection:current.workingSelection});
  }
  function captureRequestedScienceSource(source:AdvancedFrameSource,explicitElectronic=false){
    const current=latest.current;
    if(current.store.hasTransaction?.())throw Error('请先确认或取消当前模型编辑。');
    return captureScienceRuntimeSource(current.store.getSnapshot(),source,{canvas:current.props.analysisCanvas,
      selection:current.workingSelection,workingModelEditable:current.props.observationOnly!==true||current.props.allowModelEditing===true},explicitElectronic);
  }
  function prepareBondEdit(){
    if(!frameBondIdentity)return false;
    try{
      if(latest.current.props.active===false)throw Error('请先激活目标模型视图。');
      if(bondLocked)throw Error('请先暂停播放并等待当前帧准备完成，再编辑显示键。');
      const document={...bondDocument,selection:workingSelection};
      latest.current.store.setScientificEditBase?.(document.draft.structure,workingSelection,{identity:frameBondIdentity,document:rawBondDocument});
      return true;
    }catch(cause){setError(message(cause));return false;}
  }
  function modelBlock(reason:string,description:string,recovery?:{tool:string;arguments:Record<string,unknown>;message?:string},requiresUser=false){
    throw toolError('MODEL_EDIT_BLOCKED',description,{modelRef:model.id,revision:latest.current.store.getSnapshot().revision,reason,recovery,requiresUser,committed:false});
  }
  function assertStructureEditAllowed(prepareEdit=false,previewOperation=false,allowInactive=false,workingModel=false) {
    const current=latest.current,canvas=workingModel?undefined:current.props.analysisCanvas;
    if(current.props.active===false&&!allowInactive)modelBlock('view-inactive','请先激活目标模型视图。',{tool:'es_show',arguments:{target:{kind:'model',ref:model.id}}});
    if(current.props.observationOnly&&current.props.allowModelEditing!==true)modelBlock('read-only-observation','当前科学来源使用只读观察页，请提取所需帧作为可编辑模型。');
    if(canvas?.scientificFrameReady===false)modelBlock('frame-preparing','当前科学帧正在准备，待画面提交后可继续。',{tool:'trajectory_view',arguments:{targetId:model.id}});
    if(canvas?.trajectoryPlayback?.state.playing)modelBlock('trajectory-playing','请先暂停当前轨迹播放，再编辑结构。',{tool:'trajectory_view',arguments:{targetId:model.id,action:'pause'}});
    if(canvas?.vibrationPlaying)modelBlock('vibration-playing','请先暂停当前振动动画，再编辑结构。',{
      tool:'vibration_view',arguments:{targetRef:model.id},message:'读取 viewRef 与 revision，再提交 patch.playing=false。',
    });
    if(canvas?.modelEditingBlocked===true)modelBlock('observation-locked','当前观察或实时显示占用源结构，请结束当前观察操作或提取科学帧。',undefined,true);
    if(!previewOperation&&previewEditingBlocked)modelBlock('geometry-preview','请先关闭实时预览，再编辑源结构。',undefined,true);
    dynamics.assertCanEditStructure();
    if(prepareEdit){
      const source=captureOperationSource();
      current.store.setScientificEditBase?.(canvas?source.draft.structure:null,workingSelection);
    }
  }
  function structureEditAllowed(prepareEdit=false,previewOperation=false) { try { assertStructureEditAllowed(prepareEdit,previewOperation);return true; } catch(cause) { setError(message(cause)); return false; } }
  function assertTransformAllowed() {
    assertStructureEditAllowed(false,true);
    if(busy)throw new Error('当前模型操作尚未完成，请完成或取消后再变换结构。');
    if(optimizationBusy)throw new Error('当前优化尚未结束，请停止优化后再变换结构。');
    if(geometryEditing)throw new Error('请先确认或取消当前几何编辑，再变换结构。');
  }
  useEffect(()=>{if(!structureAnalysisOpen)return;closeGeometryEditor();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);setStructurePreview(null);setTransformPresentation(null);setPersonalFragmentsOpen(false);},[structureAnalysisOpen]);
  function prepareDynamicsStart(mode?: DynamicsOperation, config?: DynamicsConfig) {
    if(sharedElectronicDraft.present)sharedElectronicDraft.commit();
    if(sharedElectronicDraft.present&&!sharedElectronicDraft.flush())return false;
    if(!structureEditAllowed())return false;
    if(mode==='md'){
      const current=store.getSnapshot(),info=getMDProtectionInfo(current.draft.structure,config?.method??'gfn2',getMovableAtomIds(current,'all'),config?.integrator);
      if(!info.allowed)throw new Error(info.reason);
      // Protection semantics are available beside the controls; method admission remains enforced above.
    }
    cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    cancelTask();return true;
  }
  function continueLegacyOptimization(){
    const sourceStore=latest.current.store,source=sourceStore.getSnapshot();
    const lease=latest.current.props.activationStamp?.();
    xtbContext.current={store:sourceStore,documentId:source.id,generation:generation.current,lease,referenceStructure:structuredClone(source.draft.structure)};
    void xtb.continueOptimization(optimizationPreferences.xtb.maxSteps,optimizationPreferences.xtb.maxSccIterations).catch(cause=>setError(message(cause)));
  }

  async function runSharedOptimization(preferences:WorkspaceOptimizationPreferences,xtbOptions?:XtbPanelOptions,spaceKeydownAtMs?:number,
    options?: {source?:ModelDocument;detachedFrame?:boolean;empiricalBondParameters?:EmpiricalBondPerceptionParameters;
      onStandaloneRunStarted?(run:ScienceRuntimeRun):void;
      mcp?:{source:AdvancedFrameSource;retainTrajectory?:boolean;presentation?:RetainedOrdinaryOptimizationRequest['presentation'];
        accepted(value:Awaited<ReturnType<ScienceModelRuntime['startOptimization']>>):void}}){
    const {mcp}=options??{};
    const bondParameters=options?.empiricalBondParameters??empiricalParameters;
    const workingModel=Boolean(mcp&&!isScienceFrameReference(mcp.source.ref));
    const sourceStructure=options?.source?.draft.structure??model.draft.structure;
    if(busy||optimizationBusy||geometryEditing||sourceStructure.periodicSource?.completeness==='partial'||!sourceStructure.atoms.length||ordinaryRun||sharedOptimizationPending.current){
      if(mcp)throw Error('当前模型操作尚未结束，优化没有提交。');
      return;
    }
    const sourceStore=latest.current.store;
    const periodic=isPeriodic(sourceStructure);
    const net=workspaceOptimizationKind(preferences,periodic)==='net'?workspaceNetSettings(preferences,periodic):undefined;
    const method=net?.method??xtbOptions?.method??'xTB';
    const device=net?.device;
    const owner={documentId:sourceStore.getSnapshot().id,method,device,identity:`opt-${crypto.randomUUID()}`};
    sharedOptimizationPending.current=true;
    try{
      const canvasOptimizer=workingModel?undefined:props.analysisCanvas?.onOptimize;
      if(!canvasOptimizer){
        if(mcp||options?.detachedFrame)assertStructureEditAllowed(false,false,true,workingModel);
        else if(!structureEditAllowed())return;
      }
      const source=options?.source??(mcp?captureRequestedScienceSource(mcp.source):captureOperationSource('calculation-source'));
      const current=sourceStore.getSnapshot();
      if(source.id!==current.id||source.revision!==current.revision)throw Error('优化来源已变化，请重新选择。');
      cancelTask();setOptimizationBusy(true);setError('');setSharedOptimizationStatus({...owner,text:'正在启动…'});setSharedOptimizationEvidence(undefined);
      const retained=!!mcp?.retainTrajectory&&!canvasOptimizer;
      const optimize=canvasOptimizer??(retained?props.onRetainedOptimization:undefined);
      if(retained&&!optimize)throw Error('当前窗口尚未接入可保留轨迹的原生优化入口，本次没有提交。');
      if(optimize){
        let outcome=await optimize({source,preferences,xtbOptions,empiricalBondParameters:bondParameters,spaceKeydownAtMs,
          presentation:mcp?.presentation??'follow',sourceRef:mcp?.source.ref,
          ...(mcp?{onRunStarted:(identity,request)=>mcp.accepted({kind:'pes',...identity,request:pesRequestEvidence(request)}),onStandaloneRunStarted:mcp.accepted}:{})});
        if(retained){
          if(!outcome)throw Error('保留轨迹的优化没有返回所属运行；请核对原运行状态，本次不重复提交。');
          if(!outcome.workerSettled||!['completed','failed','stopped'].includes(outcome.status))throw Error('原生优化尚未实际结算，最终结构没有接管；请继续观察原运行。');
          const finalize=new AbortController();retainedOptimizationAdoptions.current.add(finalize);
          const assertCurrent=()=>{if(!asyncAlive.current||latest.current.store!==sourceStore)throw Error('原模型已关闭或替换，完整优化结果保留在所属PES运行，未回写其他模型。');};
          let result:PesResult|undefined;
          try{result=await adoptOrdinaryOptimizationGeometry({status:outcome.status as 'completed'|'failed'|'stopped',result:outcome.result,error:outcome.error,
            request:outcome.request,source,store:sourceStore,signal:finalize.signal,releaseRuntime:()=>{},chemistry:createChemistryPort,
            spaceKeydownAtMs,retainFrames:true,assertCurrent});}
          finally{retainedOptimizationAdoptions.current.delete(finalize);}
          if(result)outcome={...outcome,result};
          if(result?.provenance.geometryAdoptionError)setError(String(result.provenance.geometryAdoptionError));
        }
        if(outcome&&(retained||outcome.request.sourceDocumentId===source.id)){
          if(outcome.result)setSharedOptimizationEvidence({request:outcome.request,result:outcome.result});
          const error=ordinaryOptimizationError(outcome.error,outcome.result);
          const text=ordinaryOptimizationStatus(outcome.status,outcome.result)??'';
          setSharedOptimizationStatus({...owner,identity:outcome.request.id,text,error,errorCode:outcome.error?.code});
        }else setSharedOptimizationStatus(current=>current?.documentId===source.id?undefined:current);
        return;
      }
      const bridge=desktopBridge();
      if(!bridge?.startPes||!bridge.stopPes||!bridge.onPesEvent)throw Error('当前环境未连接共用优化器。');
      const input=ordinaryOptimizationInput(source,preferences,xtbOptions,bondParameters);
      const request=standaloneOptimizationRequest(source,input,owner.identity);
      const timing=observeOrdinaryOptimizationTiming(request,spaceKeydownAtMs);
      await new Promise<void>((resolve,reject)=>{
        const release=props.documentRuntime?.registerActivity(()=>sharedOptimization.current!==null);
        try{sourceStore.beginRuntimeSession();}catch(error){release?.();reject(error);return;}
        const receipt:ScienceRuntimeRun={kind:'opt',runId:request.id,documentId:source.id,revision:source.revision,status:'starting',nativeStarted:false,
          source:mcp?.source.ref,request:pesRequestEvidence(request)};
        scienceRuns.set(request.id,receipt);
        let terminal=false,closed=false,runtimeActive=true,stopPending=false;
        let lastFrame:PesFrame|undefined,lastSeq=-1;
        let statusText='正在启动…';
        const reportProgress=(text:string)=>{
          statusText=text;
          if(!closed&&!terminal&&!stopPending&&asyncAlive.current&&latest.current.store===sourceStore)
            setSharedOptimizationStatus({...owner,text});
        };
        const committedPreviewPhases=new Set<string>();
        const finalize=new AbortController();
        const view=scope.current?.ownerDocument.defaultView??window;
        const canPublishPreview=()=>!closed&&asyncAlive.current&&latest.current.store===sourceStore&&runtimeViewportConsumesPreview(latest.current.props);
        const preview=createLatestMoveScheduler<PesFrame>(
          callback=>view.requestAnimationFrame(callback),id=>view.cancelAnimationFrame(id),frame=>{
            if(!canPublishPreview())return;
            const phase=frame.step===0?'initial-preview-committed':'first-step-preview-committed';
            const markCommitted=committedPreviewPhases.has(phase)?undefined:()=>{
              if(committedPreviewPhases.has(phase))return;
              committedPreviewPhases.add(phase);
              timing.mark({phase,step:frame.step});
              if(frame.step===0&&lastFrame?.step===0)reportProgress('首帧已显示，正在寻找第 1 个接受步…');
            };
            setSharedOptimizationFrame({id:source.id,revision:source.revision,structure:projectOrdinaryOptimizationStructure(request,frame),markCommitted});
            if(frame.step>0)reportProgress(`优化中 · 第 ${frame.step} 步`);
          });
        const refreshPreview=()=>{
          if(!canPublishPreview())return;
          reportProgress(statusText);
          if(lastFrame)preview.flush(lastFrame);
          else setSharedOptimizationFrame({id:source.id,revision:source.revision,structure:projectOrdinaryOptimizationStructure(request)});
        };
        resumeSharedOptimizationPreview.current=refreshPreview;
        refreshPreview();
        let unsubscribe=()=>{};
        function releaseRuntime(){if(runtimeActive){runtimeActive=false;sourceStore.finishRuntimeSession();}}
        function clean(){
          if(closed)return;
          closed=true;
          preview.cancel();
          if(resumeSharedOptimizationPreview.current===refreshPreview)resumeSharedOptimizationPreview.current=null;
          sharedOptimization.current=null;unsubscribe();releaseRuntime();release?.();setSharedOptimizationFrame(undefined);
        }
        unsubscribe=bridge.onPesEvent!(event=>{
          if(terminal||event.schema!==PES_SCHEMA||event.runIdentity.runId!==request.runIdentity.runId||event.runIdentity.taskId!==request.runIdentity.taskId||
            event.runIdentity.groupId!==request.runIdentity.groupId||!Number.isSafeInteger(event.seq)||event.seq<=lastSeq)return;
          lastSeq=event.seq;
          timing.observe(event);
          if(!lastFrame||event.event==='optimization-timing'&&event.timing.phase==='initial-frame'&&
            lastFrame.step===0&&!committedPreviewPhases.has('initial-preview-committed')){
            const startup=ordinaryOptimizationStartupText(event,isPesNetMethod(request.method));
            if(startup)reportProgress(startup);
          }
          if(event.event==='started'||event.event==='evaluation-started'){
            receipt.nativeStarted=true;
            if(!stopPending)receipt.status='running';
          }
          if(event.event==='started'&&event.resourceGrant)receipt.resourceGrant=event.resourceGrant;
          if(event.event==='net-batch')receipt.actualGpuBatchWidth=event.size;
          if(event.event==='evaluation-started')receipt.nativeBackend=event.backend;
          if(event.event==='progress')receipt.progress={stage:event.stage,completed:event.completed,total:event.total,elapsedSeconds:event.elapsedSeconds};
          if(event.event==='frame'&&validPesFrame(event.frame,source.draft.structure.atoms.length)){
            lastFrame=event.frame;
            if(canPublishPreview())preview.schedule(lastFrame);
            else if(lastFrame.step>0)reportProgress(`优化中 · 第 ${lastFrame.step} 步`);
            receipt.frame=pesFrameEvidence(lastFrame);
          }
          if(event.event!=='terminal'||event.workerSettled!==true){notifyScienceRuns(sourceStore);return;}
          terminal=true;
          receipt.workerSettled=true;
          receipt.status='finalizing';
          notifyScienceRuns(sourceStore);
          preview.flush();
          if(stopPending)finalize.abort();
          void finalizeStandaloneOrdinaryOptimization({event,source,store:sourceStore,request,preview:lastFrame,signal:finalize.signal,releaseRuntime,chemistry:createChemistryPort,spaceKeydownAtMs})
            .then(result=>{
              receipt.status=event.status;
              receipt.scientificStatus=result?.status;
              receipt.diagnostics={error:event.error,provenance:result?.provenance};
              if(result?.frames.length){
                receipt.frame=pesFrameEvidence(result.frames[result.frames.length-1]);
                receipt.resultAdoption=result.provenance.geometryAdoptionError?'retained':'applied';
              }
              if(result)setSharedOptimizationEvidence({request,result});
              setSharedOptimizationStatus({...owner,text:ordinaryOptimizationStatus(event.status,result)??'',error:ordinaryOptimizationError(event.error,result),errorCode:event.error?.code});
            }).finally(()=>{clean();notifyScienceRuns(sourceStore);}).then(resolve,reject);
        });
        const startFailed=(error:unknown)=>{if(!terminal){terminal=true;receipt.status='failed';receipt.diagnostics={error:message(error)};clean();notifyScienceRuns(sourceStore);reject(error);}};
        // Startup can wait for a native grant. Allow an owned stop as soon as
        // the start request is dispatched, while the host can cancel admission.
        const startDispatched=Promise.resolve().then(()=>{void bridge.startPes!(request).catch(startFailed);});
        void startDispatched.catch(startFailed);
        sharedOptimization.current={documentId:source.id,method,runId:request.id,stop:async()=>{
          if(terminal){finalize.abort();return;}
          if(stopPending)return;
          stopPending=true;setSharedOptimizationStatus({...owner,text:'正在停止…'});
          receipt.status='stopping';
          notifyScienceRuns(sourceStore);
          try{await startDispatched;if(!terminal)await bridge.stopPes!(request.runIdentity);}
          catch(error){stopPending=false;if(!terminal){receipt.status=receipt.nativeStarted?'running':'starting';reportProgress(statusText);notifyScienceRuns(sourceStore);}throw error;}
        }};
        mcp?.accepted({...receipt});
        options?.onStandaloneRunStarted?.({...receipt});
        notifyScienceRuns(sourceStore);
      });
    }catch(cause){
      const error=message(cause);

      setSharedOptimizationStatus({...owner,text:'',error});
      if(mcp)throw cause;
    }
    finally{sharedOptimizationPending.current=false;sourceStore.clearScientificEditApproval?.();setOptimizationBusy(false);}
  }
  async function perceiveBonds(parameters?:EmpiricalBondPerceptionParameters,electronicOverride?:BondElectronicDraft){
    if(!structureEditAllowed()||busy||optimizationBusy||geometryEditing)return;
    const current=latest.current.props.analysisCanvas?captureOperationSource():latest.current.store.getSnapshot();
    if(current.id!==model.id){setError('模型文档已变化，请重新判断成键。');return;}
    if(electronicOverride&&!bondElectronicDraftCurrent(current,electronicOverride)){setError('电子态确认所属的模型或组成已变化，请重新判断成键。');return;}
    const {electronic,valid}=bondPerceptionElectronicState(current,{local:localXtbDraft,consent:bondElectronicConsent,override:electronicOverride});
    if(periodicModel&&bondPerceptionMethod==='gfn2'&&!periodicGfn2Available){setError('当前运行环境尚未提供周期GFN2辅助。');return;}
    if(bondPerceptionMethod==='gfn2'&&!valid){setBondElectronicPrompt({documentId:current.id,revision:current.revision,context:captureBondElectronicDraft(current,electronic),charge:Number.isSafeInteger(electronic.charge)?String(electronic.charge):'0',multiplicity:Number.isSafeInteger(electronic.multiplicity)?String(electronic.multiplicity):'1'});return;}
    try{await runBondPerception(current,{method:bondPerceptionMethod,mode:'rebuild',parameters},valid?electronic:undefined);if(parameters)setEmpiricalParameters(structuredClone(parameters));}
    catch(cause){setError(message(cause));}
  }
  async function runBondPerception(current:ModelDocument,request:ModelBondPerceptionRequest,electronic?:{charge:number;multiplicity:number},signal?:AbortSignal){
    const method=request.method??bondPerceptionMethod,params=validateEmpiricalBondParameters({...empiricalParameters,...request.parameters});
    const periodic=isPeriodic(current.draft.structure),solvent=request.solvent??bondPerceptionSolvent;
    const maxSccIterations=request.maxSccIterations??optimizationPreferences.xtb.maxSccIterations??250;
    if(method==='gfn2'&&!electronic)throw Error('请先确认此模型的电荷和多重度。');
    if(method==='gfn2'&&periodic&&!periodicGfn2Available)throw Error('当前运行环境尚未提供周期GFN2辅助。');
    if(request.solvent!==undefined&&method!=='gfn2')throw Error('当前经验成键方法没有溶剂选项。');
    if(request.solvent!==undefined&&periodic&&solvent!=='none')throw Error('周期GFN2成键暂不采用此溶剂设置。');
    signal?.throwIfAborted();cancelTask();const sourceStore=latest.current.store;
    xtbContext.current={store:sourceStore,documentId:sourceStore.getSnapshot().id,generation:generation.current,lease:latest.current.props.activationStamp?.()};
    const run=xtbContext.current,abort=()=>{if(xtbContext.current===run)void xtb.stop().catch(cause=>setError(message(cause)));};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      if(method==='gfn2'&&electronic)await xtb.run({method:'gfn2',...electronic,rebuildBonds:true,maxSccIterations,empiricalBondParameters:params,
        ...(!periodic&&solvent!=='none'?{solvation:{model:'alpb' as const,solvent}}:{})},'singlepoint',request.mode);
      else await xtb.perceiveEmpirical(electronic,request.mode,params,current);
      const state=xtb.getSnapshot(),after=sourceStore.getSnapshot();
      return {sourceRevision:current.revision,revision:after.revision,method,mode:request.mode,parameters:params,electronic,
        ...(method==='gfn2'?{solvent:periodic?'none':solvent,maxSccIterations}:{}),nativeStatus:state.status,nativeError:state.error||undefined,
        phase:state.phase,metadata:state.metadata,retainedBondResult:state.retainedBondResult,stopped:signal?.aborted===true};
    }finally{signal?.removeEventListener('abort',abort);sourceStore.clearScientificEditApproval?.();}
  }
  async function inspectCrystal(request:PeriodicInspectRequest){
    const bridge=desktopBridge(),current=captureOperationSource(),lease=latest.current.props.activationStamp?.(),key=scientificCanvasKey(latest.current.props.analysisCanvas);
    if(!bridge?.runCrystalModeling)throw new Error('当前运行环境未提供晶体建模后端。');
    const result=await bridge.runCrystalModeling({...request,documentId:current.id,expectedRevision:current.revision,structure:structuredClone(current.draft.structure)});
    if(lease)latest.current.props.assertActivation?.(lease);
    const active=latest.current.store.getSnapshot();
    if(!asyncAlive.current||latest.current.props.active===false||active.id!==current.id||active.revision!==current.revision||result.documentId!==current.id||result.expectedRevision!==current.revision||result.operation!==request.operation)throw new Error('模型上下文已变化，请重新预览。');
    if(scientificCanvasKey(latest.current.props.analysisCanvas)!==key)throw Error('来源帧已变化，未采用旧的晶体检查。');
    return result;
  }
  async function prepareTransform(request:PeriodicModelingRequest|StructureTransformEdit,publishPreview=true){
    assertTransformAllowed();
    const source=captureOperationSource(),key=scientificCanvasKey(latest.current.props.analysisCanvas);
    if(request.type!=='crystal'){if(publishPreview)setCrystalPreviewResult(null);const candidate=prepareStructureTransform(source,request);preparedTransformSources.current.set(candidate,{source,key});return candidate;}
    const bridge=desktopBridge(),current=source,lease=latest.current.props.activationStamp?.();
    if(!bridge?.runCrystalModeling)throw new Error('当前运行环境未提供晶体建模后端。');
    const result=await bridge.runCrystalModeling({operation:request.operation,parameters:request.parameters,documentId:current.id,expectedRevision:current.revision,structure:structuredClone(current.draft.structure)});
    if(lease)latest.current.props.assertActivation?.(lease);
    const active=latest.current.store.getSnapshot();
    if(!asyncAlive.current||latest.current.props.active===false||active.id!==current.id||active.revision!==current.revision||result.documentId!==current.id||result.expectedRevision!==current.revision||result.operation!==request.operation||!result.candidate)throw new Error('模型上下文已变化或未生成有效预览。');
    // Normalize all source-owned atom/image metadata before the renderer can
    // observe the candidate. A failed mapping is caught by the tool itself.
    const mapped=mapStructureTransformDocument(current,result.candidate);
    const candidate={...result.candidate,structure:mapped.draft.structure};
    if(scientificCanvasKey(latest.current.props.analysisCanvas)!==key)throw Error('来源帧已变化，未采用旧变换。');
    const crystal={...result,candidate};
    preparedTransformSources.current.set(candidate,{source,key,crystal});
    if(publishPreview)setCrystalPreviewResult(crystal);
    return candidate;
  }
  function prepareCell(request:CellEditorRequest){
    assertTransformAllowed();
    const source=captureOperationSource(),key=scientificCanvasKey(latest.current.props.analysisCanvas);
    const candidate=prepareCellEditorCandidate(source,request);
    preparedTransformSources.current.set(candidate,{source,key});
    return candidate;
  }
  async function applyTransform(candidate:StructureTransformCandidate,signal?:AbortSignal){
    assertTransformAllowed();
    const current=latest.current.store.getSnapshot();
    if(current.id!==candidate.documentId||current.revision!==candidate.expectedRevision)throw new Error('模型已变化，请重新预览。');
    if(!props.onDeriveStructure)throw new Error('当前工作区未接入新结构派生，原结构未改变。');
    const prepared=preparedTransformSources.current.get(candidate);if(!prepared||prepared.key!==scientificCanvasKey(latest.current.props.analysisCanvas))throw Error('变换预览来源已变化，请重新预览。');
    signal?.throwIfAborted();
    const modelRef=await props.onDeriveStructure(candidate,prepared.source,signal);
    setStructurePreview(null);setTransformPresentation(null);
    return modelRef;
  }
  async function commitCellEdit(candidate:StructureTransformCandidate){
    if(latest.current.props.advancedModelingRoute?.category!=='periodic'||latest.current.props.advancedModelingRoute.task!=='cell-editor')throw new Error('请先打开当前模型的晶胞编辑工具。');
    return applyCellCandidate(candidate);
  }
  function applyCellCandidate(candidate:StructureTransformCandidate,allowInactive=false){
    assertStructureEditAllowed(true,true,allowInactive);
    const target=latest.current.store,before=target.getSnapshot();
    if(candidate.documentId!==before.id||candidate.expectedRevision!==before.revision)throw new Error('晶胞编辑已过期，请重试。');
    // Native cell edits commit all mapped contexts in one Store command.
    const after=target.execute({type:'apply-structure-transform',candidate});
    if(after.revision!==before.revision){dynamics.beforeExternalEdit('晶胞已编辑');cancelWorkingEditTasks();}
    setError('');
  }
  async function stopActiveOptimization() { const run=currentOrdinaryOptimization();if(run)await run.stop();else if (xtb.getSnapshot().running) await xtb.stop(); else await dynamics.stop(); }
  function cancelManualGeometry() { if(wheelGeometry.current?.timer)clearTimeout(wheelGeometry.current.timer);wheelGeometry.current=null; const own=manualGeometry.current;if(!own)return;manualGeometry.current=null;own.store.cancelTransaction();setGeometryEditing(false); }
  function closeGeometryEditor(expected=geometryEditorOwner.current) {
    if(expected!==geometryEditorOwner.current)return;
    cancelManualGeometry();geometryEditorOwner.current=null;setGeometryOpen(false);
    if(!expected)return;
    setMeasurementSession(previous=>previous.activeRecordId===expected.recordId?{...previous,activeRecordId:null}:previous);
  }
  /** One view adapter for tool policy. Model commands, selection/capture
   * validation, runtime and async guards stay at their existing call sites. */
  function applyToolIntent(intent:ToolSessionIntent, focus = true) {
    const transition=planToolSessionTransition(intent),patch=transition.patch;
    if(transition.advancePreviewIntent)previewIntentEpoch.current++;
    if(transition.cancelManualGeometry)cancelManualGeometry();
    if(latest.current.props.toolIntent!==undefined){const next=reduceWorkspaceToolIntent(toolIntentMirror.current,intent);if(next!==toolIntentMirror.current)publishToolIntent(next);}
    else{const {geometryOpen:_local,...toolPatch}=patch;if(Object.keys(toolPatch).length)publishToolIntent(mergeWorkspaceToolIntent(toolIntentMirror.current,{...toolPatch,...(intent.type==='escape'?{element:null}:{})}));else if(intent.type==='escape')patchToolIntent({element:null});}
    if('geometryOpen' in patch){if(patch.geometryOpen) setGeometryOpen(true);else closeGeometryEditor();}
    if(transition.measurement.type!=='preserve')setMeasurementSession(previous=>applyToolSessionMeasurement(previous,transition.measurement));
    if(transition.captureAtomIds!==undefined)setCaptureAtomIds(transition.captureAtomIds);
    if(transition.keyboard==='set-element')keyboard.setElement(patch.element??null);
    else if(transition.keyboard==='document-reset')keyboard.reset('document-change');
    else if(transition.keyboard==='suspend')keyboard.suspend();
    if(transition.keyboard!=='preserve'||'element' in patch)setInteraction(keyboard.getSnapshot());
    if(focus&&transition.focusCanvas)scope.current?.focus({preventScroll:true});
  }
  const defaultMeasurementEntry=useRef<string|null>(null);
  useLayoutEffect(()=>{
    if(props.active===false){defaultMeasurementEntry.current=null;return;}
    const module=props.workspaceModule??'modeling',key=`${model.id}:${module}`;
    if(defaultMeasurementEntry.current===key||props.captureRequest)return;
    defaultMeasurementEntry.current=key;
    if(module!=='modeling')applyToolIntent({type:'measure',mode:'auto'},false);
  },[model.id,props.workspaceModule,props.active,props.captureRequest?.requestId]);
  function beginManualGeometry(record:MeasurementRecord|undefined=activeMeasurement??undefined) {
    if(record?.readOnly)throw new Error('当前内坐标仅用于结果显示。');
    if(record?.mode!=='distance'&&record?.images?.some(image=>image.some(Boolean)))throw new Error('该跨胞内坐标可测量与保存；当前手动A/D编辑未支持此镜像路径。');
    if(!structureEditAllowed(true))throw new ScientificEditCancelledError();store.beginTransaction('manual-geometry');
    try{
      const pendingRecord=record&&isObservationCoordinateRecord(store,measurementSession,observationOwnership.current,record.id)?record:undefined;
      const current=store.getSnapshot();manualGeometry.current={store,documentId:current.id,revision:current.revision,pendingRecord};setGeometryEditing(true);
    }catch(cause){store.cancelTransaction();throw cause;}
  }
  function previewManualGeometry(edit:BalancedGeometryEdit,baseline:Structure) {
    try {
      if(!structureEditAllowed())throw new ScientificEditCancelledError();
      dynamics.assertCanEditStructure();const own=manualGeometry.current,current=store.getSnapshot();
      if(!own||own.store!==store||own.documentId!==current.id||own.revision!==current.revision)throw new Error('模型已在几何编辑之外变化，请取消并重新选择。');
      const result=editBuilderGeometryBalanced(baseline,edit);geometryMoving.current=edit.moving??'branch';if(!result.touchedIds.length)return;
      const accepted=store.execute({type:'manual-coordinates',documentId:current.id,expectedRevision:own.revision,atoms:result.structure.atoms.filter(atom=>result.touchedIds.includes(atom.id!)).map(atom=>({id:atom.id!,position:[atom.x,atom.y,atom.z]}))});
      if(own.pendingRecord&&accepted.revision!==current.revision){store.execute({type:'upsert-coordinate-object',object:recordObject(own.pendingRecord)});own.pendingRecord=undefined;}
      own.revision=store.getSnapshot().revision;setError('');
    } catch(cause) {cancelManualGeometry();throw cause;}
  }
  function commitManualGeometry() {const own=manualGeometry.current;if(!own)throw new Error('几何操作已失效。');manualGeometry.current=null;own.store.endTransaction();setGeometryEditing(false);}
  function selectMeasurementRecord(record:MeasurementRecord) {
    if(record.readOnly)return;
    if(props.captureRequest){const kind=recordObject(record).type;if(props.captureRequest.kind!=='atoms'&&props.captureRequest.kind!==kind&&props.captureRequest.kind!=='coordinate'){setError('请选择与当前任务相同类型的内坐标。');return;}updateCapture([...record.atomIds]);return;}
    const previous=geometryEditorOwner.current,document=store.getSnapshot();
    if(previous&&(previous.store!==store||previous.documentId!==document.id||previous.recordId!==record.id))closeGeometryEditor(previous);
    else cancelManualGeometry();
    geometryEditorOwner.current=previous?.store===store&&previous.documentId===document.id&&previous.recordId===record.id?previous:{store,documentId:document.id,recordId:record.id};
    setMeasurementSession(previous=>activateMeasurementRecord(modelMeasurementSession(previous,store.getSnapshot()),record.id));setGeometryOpen(true);scope.current?.focus({preventScroll:true});
  }
  function wheelMeasurementRecord(record:MeasurementRecord,deltaY:number) {
    if(record.readOnly)return;
    if(!Number.isFinite(deltaY)||deltaY===0||!structureEditAllowed())return;
    if(record.mode!=='distance'&&record.images?.some(image=>image.some(Boolean))){setError('跨胞A/D测量当前不支持滚轮几何编辑，未改变结构。');return;}
    try { let own=wheelGeometry.current;
      if(!own||own.recordId!==record.id) {cancelManualGeometry();const baseline=structuredClone(editingStructure);const frame=builderEditableGeometryFrame(baseline,record.mode==='distance'?'B':record.mode==='angle'?'A':'D',record.atomIds,record.images);beginManualGeometry(record);own={recordId:record.id,baseline,value:frame.value,timer:null};wheelGeometry.current=own;}
      if(own.timer)clearTimeout(own.timer);own.value+=(deltaY<0?1:-1)*(record.mode==='distance'?.02:1);if(record.mode==='distance')own.value=Math.max(.02,own.value);if(record.mode==='angle')own.value=Math.max(.01,Math.min(179.99,own.value));
      previewManualGeometry({coordinate:record.mode==='distance'?'B':record.mode==='angle'?'A':'D',atomIds:record.atomIds,images:record.images,value:own.value,...geometryScope.current,fixedAtomIds:getFrozenAtomIds(store.getSnapshot()),selectedAtomIds:workingSelection.atomIds},own.baseline);
      const captured=own;own.timer=setTimeout(()=>{if(wheelGeometry.current!==captured)return;wheelGeometry.current=null;try{commitManualGeometry();}catch(cause){cancelManualGeometry();setError(message(cause));}},250);
    } catch(cause){cancelManualGeometry();setError(message(cause));}
  }
  function execute(command: ModelCommand, gestureFrame=false) {
    if(isWorkspaceFreezeCommand(command)&&latest.current.props.freezeEditingAllowed===false)return latest.current.store.getSnapshot();
    const displayBondEdit=Boolean(frameBondIdentity&&isFrameBondCommand(command,workingSelection));
    if(displayBondEdit?!prepareBondEdit():!structureEditAllowed(true,command.type==='restore-cell-checkpoint')) return latest.current.store.getSnapshot();
    cancelManualGeometry();
    if(!gestureFrame && keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    try { const before=latest.current.store.getSnapshot(),next=latest.current.store.execute(command.type==='place-element'?{...command,presetId:getElementPreset(presetId)?.element===command.element?presetId:defaultElementPresetId(command.element)}:command); if(next.revision!==before.revision&&!runtimePreviewSourceCurrent(before,next)){dynamics.beforeExternalEdit('模型已手工编辑');cancelWorkingEditTasks();}setError(''); setStatus('');return next; } catch (cause) { setError(message(cause));return latest.current.store.getSnapshot(); }
  }
  function legacy(command: BuilderCommand) { execute({ type: 'legacy', command }); }
  function measurementBondControls(record?:MeasurementRecord){
    const ids=record?.mode==='distance'?record.atomIds:measurement.atomIds;
    if(ids.length!==2)return{};
    const structure=editingStructure,a=structure.atoms.findIndex(atom=>atom.id===ids[0]),b=structure.atoms.findIndex(atom=>atom.id===ids[1]);
    const images=record?.images,image=images?images[1].map((value,index)=>value-images[0][index]) as Vector3:[0,0,0] as Vector3;
    const key=canonicalPeriodicBond(a,b,image).key;
    const bond=structure.bonds?.find(value=>canonicalPeriodicBond(value.a,value.b,value.image).key===key)??(!image.some(Boolean)?bondDocument.auxiliaryRelations.find(value=>value.a===ids[0]&&value.b===ids[1]||value.a===ids[1]&&value.b===ids[0]):undefined);
    if(!bond)return{bondOrder:null};
    return{bondOrder:bond.order,onBondOrderChange:(order:BondOrder)=>execute({type:'set-bond-order',atomIds:ids as [string,string],image,order})};
  }
  function commitSelection(selection: ModelSelection, origin?:'numbers'|'bond') {
    if(origin!=='bond')selectionTools.resetSeeds(selection.atomIds);
    if(observationKey){
      const selected=observationModelSelection(selection,editingStructure,bondDocument),value={key:observationKey,selection:selected};
      const previous=observationSelectionRef.current?.key===observationKey?observationSelectionRef.current.selection:workingSelection;
      observationSelectionRef.current=value;setObservationSelection(value);setError('');
      if(JSON.stringify(previous)!==JSON.stringify(selected)){
        const current=latest.current;
        const change={revision:current.store.getSnapshot().revision,frameKey:current.props.analysisCanvas?scientificCanvasKey(current.props.analysisCanvas):undefined};
        for(const listener of observedSelectionListeners.current)listener(change);
      }
      return selected;
    }
    const next = latest.current.store.select(selection);
    const nextIndices = next.selection.atomIds.map(id => next.draft.structure.atoms.findIndex(atom => atom.id === id));
    latest.current.props.onSelect?.(nextIndices); latest.current.props.onSelectIds?.([...next.selection.atomIds]);
    setError('');return next.selection;
  }
  function select(selection: ModelSelection, origin?:'numbers'|'bond') {
    try {
      if(latest.current.props.captureRequest){updateCapture(selection.atomIds);return;}
      commitSelection(selection,origin);
    } catch (cause) { setError(message(cause)); }
  }
  function selectNumbers() {
    try { select({ ...EMPTY_SELECTION, atomIds: parseAtomSelection(selectionInput, editingStructure.atoms.length).map(index => editingStructure.atoms[index].id!) }); } catch (cause) { setError(message(cause)); }
  }
  function transactCommands(label:string,commands:ModelCommand[]):boolean {
    if(latest.current.props.freezeEditingAllowed===false&&commands.some(isWorkspaceFreezeCommand))return false;
    if(!structureEditAllowed(true)||!commands.length)return false;
    cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    try{commitCommands(label,commands);return true;}
    catch(cause){setError(message(cause));return false;}
  }
  function commitCommands(label:string,commands:ModelCommand[]):ModelDocument {
    const target=latest.current.store,before=target.getSnapshot();
    if(target.executeBatch)target.executeBatch(commands,label);
    else{
      target.beginTransaction(label);
      try{for(const command of commands)target.execute(command);target.endTransaction();}
      catch(cause){target.cancelTransaction();throw cause;}
    }
    const after=target.getSnapshot();
    if(!runtimePreviewSourceCurrent(before,after)){dynamics.beforeExternalEdit(label);cancelWorkingEditTasks();}
    setError('');return after;
  }
  function objectStateChange(objects:{atomIds:string[];coordinateIds:string[]},stateAction:AtomStateAction){
    if(heldPointerKey.current)heldPointerKey.current.used=true;
    const current=store.getSnapshot(),available=displayedCoordinateObjects(current);
    const atoms=objects.atomIds.filter(id=>current.draft.structure.atoms.some(atom=>atom.id===id));
    const coordinates=available.filter(object=>objects.coordinateIds.includes(object.id));
    if(stateAction==='select-add'||stateAction==='select-remove'){
      const selectedIds=new Set(current.selection.coordinateIds??[]);
      for(const object of coordinates){if(stateAction==='select-add')selectedIds.add(object.id);else selectedIds.delete(object.id);}
      select({...selectionWithAtomState(current.selection,atoms,stateAction),coordinateIds:[...selectedIds]});return;
    }
    const frozen=stateAction==='freeze',commands:ModelCommand[]=[];
    if(atoms.length)commands.push({type:'set-shared-atom-freeze',atomIds:atoms,frozen});
    for(const object of coordinates)commands.push({type:'set-shared-coordinate-freeze',object,frozen});
    if(!commands.length)return;
    transactCommands(frozen?'冻结所选对象':'解除所选对象共有冻结',commands);
    if(!frozen&&atoms.some(id=>getFrozenAtomIds(store.getSnapshot()).includes(id)))setStatus('已解除建模共有冻结；部分原子仍受任务或层活动范围约束。');
  }
  function deleteSelectedObjects(){
    if(!(frameBondIdentity&&isFrameBondCommand({type:'delete-objects'},workingSelection))&&!structureEditAllowed())return;
    const owner=geometryEditorOwner.current;
    if(owner?.store===store&&owner.documentId===store.getSnapshot().id){deleteMeasurement(owner.recordId);return;}
    execute({type:'delete-objects'});
  }
  function atomStateChange(ids:string[],stateAction:AtomStateAction){
    if(heldPointerKey.current)heldPointerKey.current.used=true;
    if(stateAction==='select-add'||stateAction==='select-remove'){select(selectionWithAtomState(workingSelection,ids,stateAction));return;}
    const frozen=stateAction==='freeze';
    execute({type:'set-shared-atom-freeze',atomIds:ids,frozen});
    if(!frozen&&ids.some(id=>getFrozenAtomIds(store.getSnapshot()).includes(id)))setStatus('已解除建模共有冻结；部分原子仍受任务或层活动范围约束。');
  }
  function deleteStateMarker(marker:ViewportStateMarker){
    if(marker.removable===false){setStatus(marker.label??'此状态由计算区域决定，请在任务中调整。');return;}
    if(marker.kind==='selection'){
      if(marker.coordinateId){const current=store.getSnapshot();select({...current.selection,coordinateIds:current.selection.coordinateIds?.filter(id=>id!==marker.coordinateId)});}
      else select(selectionWithAtomState(store.getSnapshot().selection,marker.atomIds,'select-remove'));
      return;
    }
    const sources=modelConstraintSources(store.getSnapshot(),engineScope);
    const source=sources.find(item=>JSON.stringify([item.scope,item.kind,item.id])===marker.id)??
      (pesConstraints&&marker.kind==='freeze'&&marker.atomIds.length>1?sources.find(item=>item.scope==='shared'&&item.kind==='coordinate'&&
        modelCoordinateKey({type:item.atomIds.length===2?'B':item.atomIds.length===3?'A':'D',atomIds:item.atomIds,images:item.images})===
        modelCoordinateKey({type:marker.atomIds.length===2?'B':marker.atomIds.length===3?'A':'D',atomIds:[...marker.atomIds],images:marker.images?.slice()})):undefined);
    if(!source||!source.removable||source.scope==='layer'){setStatus('状态来源已变化，请重新选择。');return;}
    const commands:ModelCommand[]=[];
    if(source.kind==='coordinate'){
      const current=store.getSnapshot(),object=displayedCoordinateObjects(current).find(item=>item.id===marker.coordinateId);
      if(object&&!current.coordinateObjects?.some(item=>item.id===object.id))commands.push({type:'upsert-coordinate-object',object});
    }
    commands.push({type:'delete-source-constraint',scope:source.scope,kind:source.kind,id:source.id});
    transactCommands('解除对象状态',commands);hoveredMarker.current=null;
  }
  function deletePickedObject(pick:Exclude<PickResult,{kind:'none'}>){
    const current=store.getSnapshot();
    if(pick.kind==='coordinate'){deleteMeasurement(pick.coordinateId);return;}
    const command=hoverCommand({type:'delete'},pick,current);if(command)execute(command);
  }
  function pickCoordinateAtom(id:string|null,image?:Vector3){
    const currentSession=modelMeasurementSession(measurementSession,store.getSnapshot());
    if(!id){setMeasurementSession(clearPendingMeasurement(currentSession));return;}
    acceptMeasurementPick(currentSession,pickSessionMeasurement(currentSession,id,image));
  }
  function pickCoordinateBond(pick:Extract<PickResult,{kind:'bond'}>){
    const currentSession=modelMeasurementSession(measurementSession,store.getSnapshot());
    acceptMeasurementPick(currentSession,pickSessionBondMeasurement(currentSession,pick));
  }
  function acceptMeasurementPick(currentSession:typeof measurementSession,next:typeof measurementSession){
    if(next.records.length<currentSession.records.length){
      const removed=currentSession.records.find(record=>!next.records.some(item=>item.id===record.id));
      if(removed&&isObservationCoordinateRecord(store,currentSession,observationOwnership.current,removed.id)){observationOwnership.current.recordIds.delete(removed.id);setMeasurementSession(next);return;}
      setMeasurementSession({...currentSession,pendingAtomIds:[],pendingImages:undefined});
      if(structureLocked){setStatus('运行或暂停期间只可调整观察标注；正式内坐标保持不变。');return;}
      if(removed)deleteMeasurement(removed.id);return;
    }
    const added=next.records.find(record=>!currentSession.records.some(item=>item.id===record.id));
    if(added){
      const stable={...added,id:`${structureLocked?'observation-coordinate':'coordinate'}-${crypto.randomUUID()}`};
      next.records=next.records.map(record=>record===added?stable:record);next.activeRecordId=stable.id;
      if(structureLocked){
        if(observationOwnership.current.documentId!==store.getSnapshot().id)observationOwnership.current={documentId:store.getSnapshot().id,recordIds:new Set()};
        observationOwnership.current.recordIds.add(stable.id);
      }else if(!transactCommands('添加内坐标',[{type:'upsert-coordinate-object',object:recordObject(stable)}]))return;
    }
    setMeasurementSession(next);
  }
  function clearCoordinates(){
    const current=store.getSnapshot(),removable=(current.coordinateObjects??[]).filter(object=>!coordinateAssociations(store,object).length);
    if(removable.length&&!transactCommands('清空未绑定内坐标',removable.map(object=>({type:'delete-coordinate-object',objectId:object.id}))))return;
    observationOwnership.current.recordIds.clear();closeGeometryEditor();setMeasurementSession(previous=>({...modelMeasurementSession(previous,store.getSnapshot()),pendingAtomIds:[],autoAtomIds:[],pendingImages:undefined,autoImages:undefined,activeRecordId:null}));
  }
  function freezeCoordinate(record:MeasurementRecord){if(record.readOnly)return;transactCommands('冻结内坐标',[{type:'set-shared-coordinate-freeze',object:recordObject(record),frozen:true}]);}
  function history(kind: 'undo' | 'redo') {
    if(frameBondIdentity){
      if(bondLocked)return;
      try{latest.current.store.replayFrameBondHistory?.(frameBondIdentity,rawBondDocument,kind);setError('');}catch(cause){setError(message(cause));}
      return;
    }
    if(latest.current.store.getHistoryKind?.(kind)==='selection'){try{latest.current.store[kind]();setError('');}catch(cause){setError(message(cause));}return;}
    if(!structureEditAllowed(false,true))return;cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    try {if(latest.current.props.onWorkspaceHistory)latest.current.props.onWorkspaceHistory(kind);else latest.current.store[kind]();dynamics.beforeExternalEdit('撤销或重做模型');cancelWorkingEditTasks();setError('');}catch(cause){setError(message(cause));}
  }
  function setElement(element: string | null) { if(element&&!structureEditAllowed())return;applyToolIntent(element?{type:'select-element',element,presetId:defaultElementPresetId(element)}:{type:'clear-element'}); }
  function chooseElementPreset(id:string) { if(!structureEditAllowed())return;const preset=getElementPreset(id);if(!preset)return;applyToolIntent({type:'select-element',element:preset.element,presetId:id}); }
  function choosePersistentTool(tool:'hydrogen'|'delete'|'fragment') {if(!structureEditAllowed())return;applyToolIntent({type:'select-persistent',tool});}
  function clipboardPreviewGuard(){return createClipboardPreviewGuard(()=>{const currentStore=latest.current.store,current=currentStore.getSnapshot();return{alive:asyncAlive.current,active:latest.current.props.active,store:currentStore,generation:generation.current,intentEpoch:previewIntentEpoch.current,contextIdentity:JSON.stringify([latest.current.props.jobRequest,latest.current.props.orcaJobRequest,latest.current.props.captureRequest,current.draft.assignments,current.internalCoordinates,current.sharedConstraints]),activationStamp:latest.current.props.activationStamp,assertActivation:latest.current.props.assertActivation};});}
  async function chooseCopiedFragment(){
    if(!structureEditAllowed())return;
    previewIntentEpoch.current++;clipboardEpoch.current++;
    try{
      const guard=clipboardPreviewGuard();
      const received=window.sciyueDesktop?await window.sciyueDesktop.readClipboard():browserClipboard;
      guard();if(!received)throw new Error('剪贴板没有模型副本。');
      const payload=structuredClone(received);createCopiedFragmentSeed(payload);guard();
      applyToolIntent({type:'select-copy',payload,activeIndex:0});setError('');setStatus('已读取复制片段；当前模型未改变。');
    }catch(cause){if(asyncAlive.current)setError(message(cause));}
  }
  function chooseFragment(id:string) {const entry=getBuilderTemplate(id);if(!entry)throw new Error('未知片段或碳链长度超出1–20。');applyToolIntent({type:'select-template',templateId:id,activeIndex:entry.connectionAnchor,activate:structureEditAllowed()});}
  function requestCamera(request:Omit<NonNullable<typeof cameraRequest>,'serial'>) {setCameraRequest(previous=>({...request,serial:(previous?.serial??0)+1}));}
  function updateCapture(ids:readonly string[],images?:Vector3[]) {const request=latest.current.props.captureRequest;if(!request)return;const known=new Set(latest.current.store.getSnapshot().draft.structure.atoms.map(atom=>atom.id));const next=[...new Set(ids)].filter(id=>known.has(id));if(images&&(ids.length!==next.length||images.length!==next.length||images.some(image=>image.length!==3||image.some(value=>!Number.isSafeInteger(value)))))throw new Error('内坐标周期端点身份无效。');captureMirror.current={requestId:request.requestId,atomIds:next,...(images?{images:structuredClone(images)}:{})};setCaptureAtomIds(next);}
  function capturePick(id:string|null) {if(!props.captureRequest)return;const ids=captureMirror.current?.requestId===props.captureRequest.requestId?captureMirror.current.atomIds:[];updateCapture(id?(ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]):[]);}
  function confirmCapture() {const request=props.captureRequest,current=store.getSnapshot();if(!request)return;try{if(request.documentId!==current.id||request.revision!==current.revision)throw new Error('模型已变化，请重新选择。');const ids=captureMirror.current?.requestId===request.requestId?captureMirror.current.atomIds:[],allowed=new Set(current.draft.structure.atoms.map(atom=>atom.id));if(!ids.length||ids.some(id=>!allowed.has(id))||new Set(ids).size!==ids.length)throw new Error('请选择有效原子。');if(request.kind==='coordinate'&&(ids.length<2||ids.length>4))throw new Error('请依次选择2、3或4个不同原子。');if(request.kind!=='atoms'&&request.kind!=='coordinate'&&ids.length!==coordinateSize(request.kind))throw new Error('请完成所需有序原子选择。');props.onCaptureConfirm?.({requestId:request.requestId,documentId:current.id,revision:current.revision,atomIds:[...ids],...(captureMirror.current?.images?{images:structuredClone(captureMirror.current.images)}:{})});setError('');}catch(cause){setError(message(cause));}}
  useEffect(()=>{if(!props.captureRequest){captureMirror.current=null;applyToolIntent({type:'capture-end'});return;}if(wheelGeometry.current?.timer)clearTimeout(wheelGeometry.current.timer);wheelGeometry.current=null;if(manualGeometry.current){try{commitManualGeometry();}catch(cause){cancelManualGeometry();setError(message(cause));}}const ids=[...props.captureRequest.initialAtomIds];captureMirror.current={requestId:props.captureRequest.requestId,atomIds:ids};applyToolIntent({type:'capture-start',atomIds:ids});},[props.captureRequest?.requestId]);
  useEffect(()=>{const request=props.captureRequest,mirror=captureMirror.current;if(!request||mirror?.requestId!==request.requestId)return;const current=store.getSnapshot();props.onCapturePreview?.({requestId:request.requestId,documentId:current.id,revision:current.revision,atomIds:[...mirror.atomIds],...(mirror.images?{images:structuredClone(mirror.images)}:{})});},[props.captureRequest?.requestId,captureAtomIds,store,props.onCapturePreview]);
  const fragmentGesture=useRef<{store:ModelStore;documentId:string;revision:number}|null>(null);
  const [fragmentCancelEpoch,setFragmentCancelEpoch]=useState(0);
  function startGesture(kind:'box'|'camera'|'fragment'){
    if(heldPointerKey.current)heldPointerKey.current.used=true;
    if(kind==='fragment'){
      if(!structureEditAllowed(true))throw new ScientificEditCancelledError();
      if(store.hasTransaction?.())throw new Error('请先完成当前几何编辑，再拖动模型。');
      const current=store.getSnapshot();fragmentGesture.current={store,documentId:current.id,revision:current.revision};
    }
    keyboard.beginGesture(kind);setInteraction(keyboard.getSnapshot());
  }
  /** The first and only scientific write for a completed pointer gesture. */
  function commitFragmentGesture(command:Extract<ModelCommand,{type:'transform-fragment'}>):ModelDocument{
    const own=fragmentGesture.current,currentStore=latest.current.store,current=currentStore.getSnapshot();
    if(!own||own.store!==currentStore||own.documentId!==current.id||own.revision!==current.revision||latest.current.props.active===false)throw new Error('拖动预览已失效，未改变模型。');
    if(!structureEditAllowed(true))throw new ScientificEditCancelledError();
    try{const accepted=currentStore.execute(command);
      if(accepted.revision!==current.revision){dynamics.beforeExternalEdit('模型已手工编辑');cancelWorkingEditTasks();setError('');setStatus('');}
      return accepted;
    }catch(cause){endGesture(false);throw cause;}
  }
  function endGesture(commit=true){
    if(fragmentGesture.current||keyboard.getSnapshot().gesture==='fragment'){
      fragmentGesture.current=null;
      if(!commit)setFragmentCancelEpoch(value=>value+1);
    }
    keyboard.endGesture();setInteraction(keyboard.getSnapshot());
  }
  function newModel(){if(props.onNewDocument){props.onNewDocument();return;}execute({type:'replace-structure',structure:createModelStore().getSnapshot().draft.structure});setPlane(false);resetInteraction();setElement('C');}

  useEffect(() => {
    if (props.store) return;
    const previous = incoming.current;
    incoming.current = { structure, openRequest, assignments: JSON.stringify(assignments ?? null) };
    if (previous.structure === structure && previous.openRequest === openRequest) return;
    if (previous.openRequest === openRequest && applied.current === structureKey(structure)) { applied.current = null; return; }
    cancelTask(); setPlane(false); setPasteConflict(null); setImportChoices([]); resetInteraction();
    const next = initialStore(latest.current.props); setStore(next); setCellExportChoice(null); incomingCoordinates.current = coordinateSignature;
    setStaleAssignments(false); setError(''); setStatus('');
  }, [structure, openRequest]);
  const assignmentSignature = JSON.stringify(assignments ?? null);
  useEffect(() => {
    // An observation canvas consumes its owner's projected constraints. It
    // never applies an input-task context back into the underlying model.
    // Keep the incoming receipt unchanged so an explicit editable owner can
    // synchronize its own current context when it is actually activated.
    if(props.realtime&&props.observationOnly===true&&props.allowModelEditing!==true)return;
    const assignmentsChanged = assignmentSignature !== incoming.current.assignments;
    const coordinatesChanged = coordinateSignature !== incomingCoordinates.current;
    const runtimeConstraintIssue='计算会话运行或暂停期间不能修改任务约束；请先停止并等待确认。';
    const clearRuntimeConstraintIssue=()=>setErrorNotice(previous=>previous.text===runtimeConstraintIssue?{text:'',revision:previous.revision+1}:previous);
    if (!assignmentsChanged && !coordinatesChanged && (!props.realtime || incomingScope.current===engineScope)) {
      if(!structureLocked)clearRuntimeConstraintIssue();
      return;
    }
    if (props.realtime) {
      const current=store.getSnapshot(),canonical=current.sharedConstraints?.canonical;
      const incomingAssignments=assignments??{layers:[],basis:[],fragments:[],frozenAtomIds:[]};
      const effectiveAssignments=canonical?{...incomingAssignments,frozenAtomIds:[]}:incomingAssignments;
      const effectiveCoordinates=(currentCoordinates??[]).filter(row=>!canonical||row.action!=='freeze');
      const assignmentsKey=({layers,basis,fragments,frozenAtomIds}:typeof incomingAssignments)=>JSON.stringify([layers,basis,fragments,frozenAtomIds]);
      // The input UI also projects the same confirmed freezes to G/O's form.
      // A change to that ignored copy never needs permission to change context.
      const effectiveContextUnchanged=assignmentsKey(current.draft.assignments)===assignmentsKey(effectiveAssignments)&&JSON.stringify(current.internalCoordinates??[])===JSON.stringify(effectiveCoordinates);
      if(effectiveContextUnchanged){
        if(incomingScope.current===engineScope){incoming.current.assignments=assignmentSignature;incomingCoordinates.current=coordinateSignature;clearRuntimeConstraintIssue();return;}
        if(incomingScope.current&&structureLocked){clearRuntimeConstraintIssue();return;}
      }
      if(incomingScope.current && structureLocked){
        setError(structureRuntimeLocked?runtimeConstraintIssue
          :previewEditingBlocked?'请先确认或关闭结构预览，再应用任务约束。'
          :props.analysisCanvas?.modelEditingBlocked?'当前帧正在播放或准备；请先暂停，再应用任务约束。':'当前来源不允许写入任务约束。');
        return;
      }
      try{cancelManualGeometry();cancelWorkingEditTasks();if(incomingScope.current===engineScope && (assignmentsChanged||coordinatesChanged))dynamics.beforeExternalEdit('当前任务约束已变化');store.synchronizeContext(incomingAssignments,currentCoordinates??[],engineScope);incoming.current.assignments=assignmentSignature;incomingCoordinates.current=coordinateSignature;incomingScope.current=engineScope;setStaleAssignments(false);clearRuntimeConstraintIssue();}catch(cause){setError(message(cause));}return;
    }
    if (model.draft.dirty) { cancelTask(); setStaleAssignments(true); return; }
    cancelTask();
    if (assignmentsChanged && assignments) store.execute({ type: 'set-assignments', assignments });
    if (coordinatesChanged && currentCoordinates !== undefined) store.execute({ type: 'set-internal-coordinates', coordinates: currentCoordinates });
    store.markApplied(); incoming.current.assignments = assignmentSignature; incomingCoordinates.current = coordinateSignature; setStaleAssignments(false);
  }, [assignmentSignature, coordinateSignature, model.draft.dirty, store,engineScope,structureLocked,structureRuntimeLocked,previewEditingBlocked,props.realtime,props.observationOnly,props.allowModelEditing]);
  useEffect(() => { onDraftChange?.(!props.realtime && model.draft.dirty); }, [model.draft.dirty, onDraftChange, props.realtime]);
  useEffect(() => {
    let previous = store.getSnapshot();
    const publication=createCaptureRebasePublisher(()=>({active:asyncAlive.current&&latest.current.store===store&&latest.current.props.active!==false,request:latest.current.props.captureRequest,document:latest.current.store.getSnapshot()}),result=>latest.current.props.onCaptureRebase?.(result));
    const unsubscribe=store.subscribe(() => {
      publication.invalidate();
      if(latest.current.store!==store)return;
      const next = store.getSnapshot();
      const request=latest.current.props.captureRequest;
      if(request){
        if(request.documentId!==next.id){latest.current.props.onCaptureCancel?.();}
        else {
          const prior=captureMirror.current?.requestId===request.requestId?captureMirror.current.atomIds:[];
          const known=new Set(next.draft.structure.atoms.map(atom=>atom.id)),retained=prior.filter(id=>known.has(id));
          const rebased=captureRebaseResult(request,{...next,selection:{...next.selection,atomIds:retained}},prior)!;
          if(rebased.invalidatedAtomIds.length)setStatus(`已移除 ${rebased.invalidatedAtomIds.length} 个失效选择成员，请重新确认当前选择。`);
          captureMirror.current={requestId:request.requestId,atomIds:retained};
          setCaptureAtomIds(retained);
          if(next.revision!==request.revision){const activation=latest.current.props.activationStamp?.();publication.schedule(rebased,()=>{if(activation)latest.current.props.assertActivationIdentity?.(activation);});}
        }
      }
      if (next.id !== previous.id || next.revision !== previous.revision) {
        hover.current = { kind: 'none', worldPoint: [0, 0, 0] };
        if(keyboard.getSnapshot().gesture==='none'){keyboard.reset('blur');setInteraction(keyboard.getSnapshot());}
      }
      previous = next;
    });
    return()=>{publication.dispose();unsubscribe();};
  }, [store, keyboard]);
  useEffect(()=>{setMeasurementSession(previous=>retainMeasurementSession(previous,atoms.map(atom=>atom.id!)));},[model.id,model.revision]);
  useEffect(()=>{if(geometryEditorLease&&(geometryEditorLease.store!==store||geometryEditorLease.documentId!==model.id||geometryEditorLease.recordId!==activeMeasurement?.id))closeGeometryEditor(geometryEditorLease);},[store,model.id,activeMeasurement?.id,geometryEditorLease]);
  useEffect(()=>{if(structureLocked){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);}applyToolIntent({type:'runtime-status',locked:structureLocked});},[structureLocked]);
  useEffect(() => { setSelectionInput(formatAtomSelection(indices)); }, [selectionNumberSignature]);
  useEffect(() => {
    if (observationKey||!selected || (!props.realtime && model.draft.dirty)) return;
    const atomIds = selected.flatMap(index => atoms[index]?.id ? [atoms[index].id!] : []);
    if (JSON.stringify(atomIds) !== JSON.stringify(workingSelection.atomIds)) store.select({ ...EMPTY_SELECTION, atomIds });
  }, [selected, store]);
  useEffect(() => {asyncAlive.current=true;return()=>{asyncAlive.current=false;generation.current++;importing.current?.abort();task.current?.cancel();
    for(const adoption of retainedOptimizationAdoptions.current)adoption.abort();retainedOptimizationAdoptions.current.clear();};}, []);
  useEffect(()=>()=>{generation.current++;if(geometryEditorOwner.current?.store===store)closeGeometryEditor();else cancelManualGeometry();},[store]);

  async function copy(copyScope?:'selection'|'all') {
    try {
      previewIntentEpoch.current++;clipboardEpoch.current++;
      const guard=clipboardPreviewGuard();
      const sourceStore = latest.current.store, source = sourceStore.getSnapshot(), lease = latest.current.props.activationStamp?.();
      const copyStore=observationKey?createModelStore(editingStructure):sourceStore;
      if(observationKey)copyStore.select(workingSelection);
      const payload = copyStore.copy(copyScope);
      createCopiedFragmentSeed(payload);
      if (window.sciyueDesktop) await window.sciyueDesktop.writeClipboard(payload); else {browserClipboard=structuredClone(payload);window.dispatchEvent(new CustomEvent('sciyue-model-copy'));clipboardChannel.current?.postMessage(payload);}
      guard();
      if(lease)latest.current.props.assertActivation?.(lease);
      const current = latest.current.store.getSnapshot();
      if (sourceStore !== latest.current.store || source.id !== current.id || source.revision !== current.revision || latest.current.props.active === false) throw new Error('复制期间活动模型已变化；剪贴板保留当时副本，未切换当前片段工具。');
      applyToolIntent({type:'select-copy',payload:structuredClone(payload),activeIndex:0});
      setStatus('已复制模型副本。'); onCopied?.('已复制模型副本。'); setError('');
    } catch (cause) { if(asyncAlive.current)setError(message(cause)); }
  }
  useEffect(()=>{
    let alive=true;
    const accept=(payload:ClipboardPayload|null)=>{if(!alive||!payload)return;try{createCopiedFragmentSeed(payload);applyToolIntent({type:'clipboard-cache',payload:structuredClone(payload)});}catch{/* Invalid external messages never become a graft tool. */}};
    const refresh=()=>{const epoch=++clipboardEpoch.current;if(window.sciyueDesktop)void window.sciyueDesktop.readClipboard().then(payload=>{if(epoch===clipboardEpoch.current)accept(payload);}).catch(()=>{});else accept(browserClipboard);};
    const unsubscribe=window.sciyueDesktop?.onModelClipboardChanged?.(()=>refresh());
    if(!window.sciyueDesktop&&typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel('sciyue-model-clipboard-v1');clipboardChannel.current=channel;channel.onmessage=event=>{try{createCopiedFragmentSeed(event.data);browserClipboard=structuredClone(event.data);window.dispatchEvent(new CustomEvent('sciyue-model-copy'));}catch{}};}
    window.addEventListener('focus',refresh);window.addEventListener('sciyue-model-copy',refresh);refresh();
    return()=>{alive=false;clipboardEpoch.current++;unsubscribe?.();window.removeEventListener('focus',refresh);window.removeEventListener('sciyue-model-copy',refresh);clipboardChannel.current?.close();clipboardChannel.current=null;};
  },[]);
  function pastePayload(payload: ClipboardPayload, policy?: PastePolicy) {
    if(!structureEditAllowed(true))return;
    cancelManualGeometry();
    if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    try {const target=captureOperationSource().draft.structure,source=payload.fragment.structure;let offset=policy?.offset;
      if(!offset&&target.atoms.length&&!isPeriodic(target)&&!isPeriodic(source)){const maxX=Math.max(...target.atoms.map(atom=>atom.x)),minX=Math.min(...source.atoms.map(atom=>atom.x));offset=[maxX-minX+2.5,0,0];}
      latest.current.store.paste(payload,{...policy,...(offset?{offset}:{})});dynamics.beforeExternalEdit('已粘贴模型');cancelWorkingEditTasks();setPasteConflict(null); setError(''); setStatus('已追加独立副本。'); }
    catch (cause) { if (cause instanceof ModelConflictError && cause.conflicts.some(conflict => conflict.kind === 'cell')) setPasteConflict(payload); else setError(message(cause)); }
  }
  async function paste(fromClipboard=false) {
    if(!structureEditAllowed())return;
    if(!fromClipboard&&activePreview.model){pastePayload(structuredClone(activePreview.model.payload));return;}
    const currentStore = latest.current.store, {id:documentId,revision} = currentStore.getSnapshot(), epoch=generation.current;
    const lease=latest.current.props.activationStamp?.();
    const contextIdentity=JSON.stringify([Boolean(latest.current.props.orcaJobRequest),(latest.current.props.orcaJobRequest??latest.current.props.jobRequest)?.settings.task,currentStore.getSnapshot().draft.assignments,currentStore.getSnapshot().internalCoordinates]);
    try {
      const payload = window.sciyueDesktop ? await window.sciyueDesktop.readClipboard() : browserClipboard;
      if(lease)latest.current.props.assertActivation?.(lease);
      if (currentStore !== latest.current.store || documentId !== currentStore.getSnapshot().id || revision !== currentStore.getSnapshot().revision || epoch!==generation.current || contextIdentity!==JSON.stringify([Boolean(latest.current.props.orcaJobRequest),(latest.current.props.orcaJobRequest??latest.current.props.jobRequest)?.settings.task,currentStore.getSnapshot().draft.assignments,currentStore.getSnapshot().internalCoordinates])) throw new Error('模型或任务上下文已变化，请重新粘贴。');
      if (!payload) throw new Error('剪贴板没有模型副本。');
      pastePayload(payload);
    } catch (cause) { setError(message(cause)); }
  }
  function copiedPlacement(command:ModelCommand){
    const structure=latest.current.store.getSnapshot().draft.structure;
    command=defaultPlacementCommand(structure,command);
    if(command.type!=='place-element'&&command.type!=='place-fragment')return execute(viewportCommand(command));
    const preview=activePreview.model,index=previewActiveIndex??preview?.defaultActiveAtomIndex??0;
    if(!preview||preview.kind!=='copy'&&index===preview.defaultActiveAtomIndex)return execute(viewportCommand(command));
    const graft=Boolean(command.targetAtomId||command.targetPortId);
    return execute({type:'place-copied-fragment',payload:preview.payload,activeIndex:index,mode:graft?'graft':'independent',
      position:command.position,targetAtomId:command.targetAtomId,targetPortId:command.targetPortId,
      ...(graft&&command.type==='place-element'&&preview.kind==='element'&&isPeriodic(structure)?{cell:'keep-target'}:{})});
  }
  function choosePreviewAtom(index:number){const preview=activePreview.model;if(!preview||!Number.isSafeInteger(index)||index<0||index>=preview.structure.atoms.length||!structureEditAllowed())return;if(preview.kind==='element'){const preset=getElementPreset((previewSource as Extract<ActiveStructurePreviewSource,{kind:'element'}>).presetId);applyToolIntent({type:'preview-atom',kind:'element',element:preset.element,index});}else applyToolIntent({type:'preview-atom',kind:preview.kind,index});}
  function deleteMeasurement(id:string){
    if(measurement.records?.find(record=>record.id===id)?.readOnly)return;
    if(isObservationCoordinateRecord(store,measurementSession,observationOwnership.current,id)){
      observationOwnership.current.recordIds.delete(id);
      setMeasurementSession(previous=>({...previous,records:previous.records.filter(record=>record.id!==id),activeRecordId:previous.activeRecordId===id?null:previous.activeRecordId}));
      hoveredRecord.current=null;if(geometryEditorOwner.current?.recordId===id)closeGeometryEditor();return;
    }
    if(!structureEditAllowed())return;
    const before=store.getSnapshot(),object=displayedCoordinateObjects(before).find(item=>item.id===id);if(!object)return;
    const commands:ModelCommand[]=[];if(!before.coordinateObjects?.some(item=>item.id===object.id))commands.push({type:'upsert-coordinate-object',object});commands.push({type:'delete-coordinate-object',objectId:object.id});
    if(!transactCommands('删除内坐标及关联定义',commands))return;
    const retired=removeObservationCoordinate(measurementSession,observationOwnership.current,object);observationOwnership.current=retired.ownership;
    setMeasurementSession(previous=>modelMeasurementSession(removeObservationCoordinate(previous,observationOwnership.current,object).session,store.getSnapshot()));hoveredRecord.current=null;if(geometryEditorOwner.current?.recordId===id)closeGeometryEditor();
  }
  useEffect(()=>{if(props.active!==false)return;deactivateModelWorkspaceRuntime(Boolean(props.assertRuntimeCurrent),()=>{generation.current++;void xtb.stop().catch(cause=>setError(message(cause)));task.current?.cancel();task.current=null;setBusy(false);});importing.current?.abort();importing.current=null;leaveCanvas();hoveredRecord.current=null;closeGeometryEditor();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);for(const root of [scope.current,props.onToolSurfaceChange?null:props.toolHost,props.onToolbarSurfaceChange?null:props.toolbarHost])root?.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach(element=>element.hidePopover());},[props.active,props.assertRuntimeCurrent,xtb]);
  function personalFragmentGuard(){
    return createPersonalFragmentContextGuard(()=>({alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,activationStamp:latest.current.props.activationStamp,assertActivation:latest.current.props.assertActivation}),()=>{dynamics.assertCanEditStructure();if(manualGeometry.current||keyboard.getSnapshot().gesture==='fragment'||latest.current.store.hasTransaction?.())throw new Error('请先完成当前模型手势，再操作个人片段。');});
  }
  const personalBridge=typeof window==='undefined'?undefined:window.sciyueDesktop;
  const personalFragmentsAPI=useMemo<PersonalFragmentStoreAPI|null>(()=>personalBridge?.readPersonalFragments&&personalBridge?.updatePersonalFragments?{
    // Catalog reads do not capture or change a model. The library component
    // guards its own lifetime; capture/update keep the strict model guard below.
    read:()=>personalBridge.readPersonalFragments!(),
    update:async request=>{const guard=personalFragmentGuard();guard();const value=await personalBridge.updatePersonalFragments!(request);guard();return value;},
  }:null,[personalBridge,store,dynamics]);
  async function capturePersonalFragment(){
    const guard=personalFragmentGuard(),source=copiedForPersonal.current;
    if(!source.payload)throw new Error('请先在结构预览中选择真实3D片段。');
    createCopiedFragmentSeed(source.payload,source.activeIndex);guard();
    const captured=await Promise.resolve({payload:structuredClone(source.payload),activeIndex:source.activeIndex});
    guard();if(copiedForPersonal.current.payload!==source.payload||copiedForPersonal.current.activeIndex!==source.activeIndex)throw new Error('预览片段或接入位已变化，请重新保存。');return captured;
  }
  async function choosePersonalFragment(payload:ClipboardPayload,activeIndex:number){
    const guard=personalFragmentGuard();createCopiedFragmentSeed(payload,activeIndex);guard();
    // Only arm the existing copied-fragment UI. Placement later goes through
    // the unchanged target/lock/graph/freeze/Undo transaction path.
    applyToolIntent({type:'select-copy',payload:structuredClone(payload),activeIndex});setPersonalFragmentsOpen(false);setStatus('已选择个人片段，点击原子或待接端接入；当前模型未改变。');
  }
  function documentOperations() {
    return createDocumentOperations({
      // These operations export only a sealed geometry. Task cancellation/new
      // edits advance generation; document/store/activation lifetime owns I/O.
      read:()=>({alive:asyncAlive.current,generation:0,store:latest.current.store,active:latest.current.props.active,activationStamp:latest.current.props.activationStamp,assertActivation:latest.current.props.assertActivation,assertActivationIdentity:latest.current.props.assertActivationIdentity,jobRequest:latest.current.props.jobRequest,orcaJobRequest:latest.current.props.orcaJobRequest,documentName:latest.current.props.documentName,documentNameOrigin:latest.current.props.documentNameOrigin,runtimeOwner:dynamics,runtimeSessionId:dynamics.getSnapshot().sessionId,runtimeConditions:JSON.stringify([dynamics.getSnapshot().mode,dynamics.getSnapshot().sessionId,dynamics.getSnapshot().seed]),scientificSourceIdentity:displayedExportSource.current.sourceIdentity}),
      captureScientificSource:()=>{
        const current=latest.current,shown=displayedExportSource.current,owner=current.store.getSnapshot();
        const canvas=current.props.analysisCanvas;
        if(canvas&&!canvas.exportStructure&&(canvas.scientificFrameReady===false||canvas.result&&canvas.scientificFrameReady!==true))throw new Error('当前科学帧尚未准备完整，请等待载入完成。');
        if(shown.owner.id!==owner.id||shown.owner.revision!==owner.revision)throw new Error('当前画布正在切换，请等待显示完成后导出。');
        return captureDisplayedStructureDocument(owner,{document:shown.document,structure:shown.structure&&presentedVibrationStructure(shown.structure),displayAtoms:presentedVibrationAtoms(shown.displayAtoms)});
      },
      pauseAndSnapshot:()=>dynamics.getSnapshot().mode==='md'?dynamics.captureSnapshot():dynamics.pauseAndSnapshot(),
      getFilePort:()=>window.sciyueDesktop??null,
      formats:context=>getFormatDescriptors(context).filter(format=>format.id!=='sciyue'),
      exportModel:(snapshot,format,context)=>exportModel(snapshot,format,context,createChemistryPort()),
      confirmLosses:losses=>confirmSynchronousOperation(losses.join('\n')+'\n继续保存？',scope.current?.ownerDocument),
      download:({filename,text,assertCurrent})=>{
        const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
        const link=document.createElement('a');link.href=url;link.download=filename;assertCurrent();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      },
    });
  }
  function presentDocumentOperation(result:DocumentOperationResult,exportWithCell:boolean) {
    if(result.status==='cancelled'||result.status==='written-without-current-view')return;
    // Caller await adds a settlement gap. Validate this branch's guard next
    // to UI publication; suppress stale UI without relabeling completed I/O.
    try{result.assertPublishCurrent();}catch{return;}
    if(result.status==='format-required'){saveModalSource.current=result.snapshot;saveModalGuard.current=result.assertCurrent;setSaveModalWithCell(exportWithCell);setSaveModal(true);return;}
    if(result.status==='state-required'){setSaveState({format:result.format,token:result.token,snapshot:result.snapshot,request:result.request,withCell:exportWithCell,assertCurrent:result.assertCurrent});setError('');return;}
    if(result.status==='saved'){setStatus('已保存 '+result.path);if(result.purpose!=='structure')latest.current.props.onSavedName?.(result.name);}
    else if(result.status==='downloaded'){setStatus('已导出模型。');if(result.purpose!=='structure')latest.current.props.onSavedName?.(result.name);}
    else return;
    setSaveModal(false);saveModalGuard.current=null;saveModalSource.current=undefined;setError('');
  }
  async function save() {
    if(saveBusyRef.current||saveModal||saveState)return;
    const current=latest.current;
    if(current.props.observationOnly&&current.props.analysisCanvas?.pesConstraints&&!readonlyPesStructureExportReady(current.props.analysisCanvas,current.props.active!==false)){setError('当前画布尚无可导出的结构。');return;}
    saveBusyRef.current=true;setSaveBusy(true);
    try{presentDocumentOperation(await documentOperations().save({withCell,staleAssignments,purpose:'structure'}),withCell);}
    catch(cause){if(asyncAlive.current)setError(message(cause));}
    finally{saveBusyRef.current=false;if(asyncAlive.current)setSaveBusy(false);}
  }
  async function writeExport(format:ModelFormat,token?:string,state?:SaveElectronicState,inheritedGuard?:()=>void,capturedDocument?:ModelDocument,exportWithCell=saveModal?saveModalWithCell:withCell) {
    if(saveBusyRef.current)return;saveBusyRef.current=true;setSaveBusy(true);
    try{presentDocumentOperation(await documentOperations().writeExport({format,token,state,inheritedGuard,withCell:exportWithCell,staleAssignments,purpose:'structure',capturedDocument:capturedDocument??saveModalSource.current}),exportWithCell);}
    catch(cause){if(asyncAlive.current)setError(message(cause));}
    finally{saveBusyRef.current=false;if(asyncAlive.current)setSaveBusy(false);}
  }
  async function importFiles(files?: FileList | null) {
    if(props.onImportFiles){if(files?.length)await props.onImportFiles(Array.from(files));else fileInput.current?.click();return;}
    if(!structureEditAllowed())return;
    cancelManualGeometry();
    const currentStore = latest.current.store; cancelTask(); const epoch = generation.current;
    const controller = new AbortController(); importing.current = controller;
    pendingImports.current++;
    const snapshot=currentStore.getSnapshot(),lease=latest.current.props.activationStamp?.();
    const guard=()=>{if(!asyncAlive.current||controller.signal.aborted||epoch!==generation.current||currentStore!==latest.current.store||snapshot.id!==currentStore.getSnapshot().id||snapshot.revision!==currentStore.getSnapshot().revision||latest.current.props.active===false)throw new Error('导入期间活动模型已变化。');if(lease)latest.current.props.assertActivationIdentity?.(lease);};
    try {
      const bridge = files ? undefined : window.sciyueDesktop!;
      const opened = files ? Array.from(files) : await bridge!.openFiles();
      if (!opened.length) return;
      const parsed = await importModelSources(opened, bridge, controller.signal);
      if (epoch !== generation.current || currentStore !== latest.current.store) return;
      if (!parsed.length) throw new Error('没有可识别的结构。');
      for(const item of parsed){
        guard();
        if(/\.(out|log|fch|fchk)$/i.test(item.structure.gaussianSource?.fileName??item.structure.name))continue;
        const result=await startImportBondPerception(item.structure,{port:createChemistryPort(),guard,signal:controller.signal}).promise;
        guard();if(result.status==='cancelled'||result.status==='stale')throw new Error('导入已取消或来源已失效。');
        item.structure={...result.structure,notes:[...result.structure.notes,...result.warnings]};
      }
      guard();
      if (parsed.length > 1) { setImportChoices(parsed); return; }
      importModel(parsed[0]);
    } catch (cause) { if (epoch === generation.current) setError(message(cause)); }
    finally { pendingImports.current--;if (importing.current === controller) importing.current = null; }
  }
  function importModel(item: FragmentSnapshot) {
    execute({ type: 'replace-document', fragment: item }); setPlane(false); setImportChoices([]); resetInteraction(); setCellExportChoice(null);setStatus(item.structure.notes.join('；'));
  }
  async function chemistry(rebuild = false) {
    if(frameBondIdentity){
      if(!prepareBondEdit())return;
      store.setScientificEditBase?.(null);
      const owner=store.getSnapshot(),identity=frameBondIdentityKey(frameBondIdentity),overrides=JSON.stringify(owner.frameBondOverrides),epoch=generation.current,scientificFingerprint=frameBondScientificFingerprint(rawBondDocument.draft.structure);
      const guard=()=>{const current=latest.current,canvas=current.props.analysisCanvas,target=canvas?.frameBondIdentity??(!canvas?defaultFrameBondIdentity(current.store.getSnapshot()):undefined);
        const structure=canvas?.staticDocument?.draft.structure??current.store.getSnapshot().draft.structure;
        if(!asyncAlive.current||generation.current!==epoch||current.store!==store||current.props.active===false||!target||frameBondIdentityKey(target)!==identity||frameBondScientificFingerprint(structure)!==scientificFingerprint||JSON.stringify(store.getSnapshot().frameBondOverrides)!==overrides)throw Error('当前帧或手工显示键已变化，旧成键回执未应用。');};
      const native=createChemistryPort();let ownJob:ChemistryJob|undefined;
      const provider=new EmpiricalFrameBonds({port:{capabilities:()=>native.capabilities(),start:request=>{ownJob=ownNativeJob(native.start(request));task.current=ownJob;return ownJob;}},sourceId:identity,retainCache:false});
      setBusy(true);setError('');
      try{
        const value=await provider.resolve(rawBondDocument.draft.structure,props.analysisCanvas?.frameIndex??0,{guard});guard();
        if(value.status!=='inferred')throw Error(empiricalFrameBondDisplayWarnings(value).join('\n')||'当前帧经验连接未准备完成。');
        execute({type:'infer-bonds',mode:rebuild?'rebuild':'supplement',aggression,perceivedBonds:value.structure.bonds,perceivedIssues:value.structure.bondPerceptionIssues});
      }catch(cause){if(generation.current===epoch)setError(message(cause));}finally{provider.dispose();if(task.current===ownJob)task.current=null;if(asyncAlive.current&&generation.current===epoch)setBusy(false);}
      return;
    }
    if(!structureEditAllowed())return;
    cancelManualGeometry();
    dynamics.beforeExternalEdit('启动成键识别');
    cancelTask(); const epoch = generation.current, currentStore = latest.current.store, snapshot = currentStore.getSnapshot(),owner:WorkspaceRuntimeOwner={store:currentStore,documentId:snapshot.id,generation:epoch,lease:latest.current.props.activationStamp?.()};
    try {
      assertRuntimeOwner(owner);
      if(staleAssignments)throw new Error('任务分区已变化，请取消草稿后重新编辑。');
      if (isPeriodic(snapshot.draft.structure)||snapshot.draft.structure.periodicSource) throw new Error('周期模型请使用判断成键。');
      if (!snapshot.draft.structure.atoms.length) throw new Error('请先建立结构。');
      const request = latest.current.props.orcaJobRequest;
      const movableAtomIds = preoptimizationMovableAtomIds(snapshot, 'all', request?.settings);
      const stamp = currentStore.stamp(movableAtomIds);
      setBusy(true); setError(''); setStatus('正在识别成键…');
      const job = ownNativeJob(createChemistryPort().start({ stamp, operation: 'perceive-bonds', structure: snapshot.draft.structure, movableAtomIds, aggression })); task.current = job;
      const result = await job.promise;
      if (epoch !== generation.current || currentStore !== latest.current.store) return;
      assertRuntimeOwner(owner);
      if(!structureEditAllowed())throw new ScientificEditCancelledError();
      currentStore.execute({ type: 'infer-bonds', mode: rebuild ? 'rebuild' : 'supplement', aggression, perceivedBonds: result.structure.bonds, stamp: result.stamp });
      setStatus(`${result.engine} ${result.engineVersion} · 成键识别完成${result.warnings.length ? ' · ' + result.warnings.join('；') : ''}`); setError('');
    } catch (cause) { if (epoch === generation.current) setError(message(cause)); }
    finally { currentStore.clearScientificEditApproval?.();if (epoch === generation.current) { task.current = null; setBusy(false); } }
  }
  function capturePlaneGuard():TwoDCommitGuard {
    if(!structureEditAllowed())throw new ScientificEditCancelledError();
    dynamics.beforeExternalEdit('二维生成新的正式模型');
    cancelTask(); const epoch = generation.current, currentStore = latest.current.store, revision = currentStore.getSnapshot().revision,owner:WorkspaceRuntimeOwner={store:currentStore,documentId:currentStore.getSnapshot().id,generation:epoch,lease:latest.current.props.activationStamp?.()};
    const guard:TwoDCommitGuard=()=>{if(epoch!==generation.current||currentStore!==latest.current.store||revision!==currentStore.getSnapshot().revision)throw new Error('二维生成的目标已变化，草稿已保留。');assertRuntimeOwner(owner);};
    guard.target={kind:'replace',documentId:owner.documentId,revision};guard();return guard;
  }
  async function commitPlane(fragment:FragmentSnapshot,files:File[],guard:TwoDCommitGuard) {
    guard();const currentStore=latest.current.store,preparedOwner=`two-d-source-stage-${crypto.randomUUID()}`;
    try{
      const bundle=await registerImportedModelSources([preparedOwner],files);if(!bundle)throw new Error('二维来源尚未准备。');guard();
      dynamics.assertCanEditStructure();if(xtb.getSnapshot().running)throw new Error('请先停止xTB预优化。');
      const before=currentStore.getSnapshot();currentStore.execute({type:'replace-document',fragment,electronicState:'new-source'});
      if(currentStore.getSnapshot().revision===before.revision)throw new Error('三维替换未提交，二维草稿已保留。');
      commitImportedModelSourceBundle(bundle,preparedOwner,currentStore.getSnapshot().id);resetInteraction();setStatus('三维结构已生成。');setError('');
    }catch(cause){await forgetImportedModelSources(preparedOwner);throw cause;}
    finally{currentStore.clearScientificEditApproval?.();}
  }
  function apply() {
    try {
      const currentStore = latest.current.store, current = currentStore.getSnapshot();
      if (staleAssignments) throw new Error('任务分区已变化，请取消草稿后重新编辑。');
      const result = Object.assign(builderApplyResult(current.draft), { internalCoordinates: current.internalCoordinates ?? [] });
      applied.current = structureKey(result.structure);
      if (onApply(result) === false) { applied.current = null; return; }
      currentStore.markApplied(); setStatus('已应用到当前任务。'); setError('');
    } catch (cause) { applied.current = null; setError(message(cause)); }
  }
  function cancel() {
    cancelTask(); setStore(initialStore(latest.current.props)); setPlane(false); setPasteConflict(null); setImportChoices([]); resetInteraction(); incoming.current.assignments = assignmentSignature; incomingCoordinates.current = coordinateSignature; setStaleAssignments(false); setError(''); setStatus('草稿已取消。'); onCancel?.();
  }
  function action(action: InteractionAction) {
    if(action.type==='select-all'){select({...EMPTY_SELECTION,atomIds:atoms.map(atom=>atom.id!)});return;}
    if(action.type==='clear-measurement-pending'){applyToolIntent({type:'clear-measurement-pending'});return;}
    if(action.type==='measurement-mode'){applyToolIntent({type:'measure',mode:action.mode});return;}
    if(action.type==='carbon-chain'){try{chooseFragment(`alkyl${action.count}`);}catch(cause){setError(message(cause));}return;}
    const snapshot=latest.current.store.getSnapshot(),current=observationKey?{...snapshot,selection:workingSelection,draft:{...snapshot.draft,structure:editingStructure}}:snapshot, pick=currentHover();
    if(action.type==='delete'){if(pick.kind!=='none')deletePickedObject(pick);else deleteSelectedObjects();return;}
    const command = hoverCommand(action, pick, current, keyboard.getSnapshot().element);
    if (command) { if(command.type==='place-element')copiedPlacement(command);else execute(command);return; }
    if (action.type === 'undo' || action.type === 'redo') history(action.type);
    if (action.type === 'copy') void copy();
    if (action.type === 'paste') void paste(true);
    if (action.type === 'save') void save();
    if (action.type === 'escape') {applyToolIntent({type:'escape',captureActive:Boolean(props.captureRequest)});if(props.captureRequest){props.onCaptureCancel?.();return;} select(EMPTY_SELECTION); if(!structureLocked)cancelWorkingEditTasks(); setPlane(false); setPasteConflict(null); }
  }
  const modalActive = Boolean(props.twoDActive || plane || saveModal || saveState || pasteConflict || importChoices.length);
  function assertModelCommand(expectedRevision:number,requiresIdle=false,background=false){
    const {store:target,props:owner}=latest.current,current=target.getSnapshot();
    if(!asyncAlive.current||owner.active===false&&!background||current.id!==model.id)
      modelBlock('view-inactive','目标模型视图已切换或尚未就绪。',{tool:'es_show',arguments:{target:{kind:'model',ref:model.id}}});
    if(current.revision!==expectedRevision)throw Error('模型修订已变化，请重新读取。');
    if(owner.twoDActive)modelBlock('sketch-open','二维画板正在使用，回到模型窗口后可继续。',undefined,true);
    if(plane)modelBlock('plane-edit','请先结束平面定义。',undefined,true);
    if(saveModal||saveState)modelBlock('save-dialog','请先完成或关闭保存操作。',undefined,true);
    if(pasteConflict||importChoices.length)modelBlock('import-choice','请先完成粘贴或导入选择。',undefined,true);
    if(workbenchLayout.editMode)modelBlock('layout-edit','请先退出工作台布局编辑。',undefined,true);
    if(blockingModelDialog(scope.current))modelBlock('model-dialog','请先结束当前原生对话框。',undefined,true);
    if(owner.captureRequest)modelBlock('input-capture','请先结束当前输入对象选取。',undefined,true);
    if(referenceCapture.viewportCapture)modelBlock('reference-capture','请先结束当前结构参考选取。',undefined,true);
    if(target.hasTransaction?.()||keyboard.getSnapshot().gesture!=='none'||geometryEditing)
      modelBlock('geometry-edit','请先结束当前手势或几何编辑。',undefined,true);
    if(requiresIdle&&viewportBusy.current()&&!target.isRuntimeEditingAllowed?.())
      modelBlock('runtime-busy','请等待当前计算或文件操作结束。',{tool:'es_run_list',arguments:{}});
    return current;
  }
  modelCommands.current={
    frameKey(){
      const canvas=latest.current.props.analysisCanvas;
      if(!canvas||canvas.scientificFrameReady===false||canvas.readSubmittedScientificFrame&&!canvas.readSubmittedScientificFrame())return;
      return scientificCanvasKey(canvas);
    },
    selection(){
      if(!observationKey)return latest.current.store.getSnapshot().selection;
      const issued=observationSelectionRef.current;
      return issued?.key===observationKey?observationModelSelection(issued.selection,editingStructure,bondDocument):latest.current.workingSelection;
    },
    subscribeObservedSelection(listener){
      observedSelectionListeners.current.add(listener);
      return ()=>{observedSelectionListeners.current.delete(listener);};
    },
    edit(expected,commands,background=false){
      const before=assertModelCommand(expected,true,background),target=latest.current.store;
      if(background&&(before.analysisBindingId||latest.current.props.analysisCanvas||latest.current.props.observationOnly))throw Error('请先激活科学帧或任务观察页，再提交模型编辑。');
      if(latest.current.props.freezeEditingAllowed===false&&commands.some(isWorkspaceFreezeCommand))throw Error('冻结定义由当前扫描或任务来源管理。');
      const prepared=commands.map(command=>command.type==='place-element'?viewportCommand({...command,presetId:command.presetId??defaultElementPresetId(command.element)}):command);
      if(frameBondIdentity&&prepared.every(command=>isFrameBondCommand(command,workingSelection))){
        if(prepared.length!==1)throw Error('请逐项编辑结果帧的显示键。');
        if(!prepareBondEdit())throw Error('当前科学帧的显示键尚不可编辑。');
        return target.execute(prepared[0]);
      }
      if(before.analysisBindingId||latest.current.props.analysisCanvas){
        // The native owner checks source invalidation and offers its own confirmation.
        // Its pending-intent protocol stores one complete command.
        if(prepared.length!==1)throw Error('请以独立可编辑模型提交成组修改。');
        assertStructureEditAllowed(true);
        const after=target.execute(prepared[0]);
        if(after.revision!==before.revision&&!runtimePreviewSourceCurrent(before,after)){dynamics.beforeExternalEdit('模型已手工编辑');cancelWorkingEditTasks();}
        return after;
      }
      assertStructureEditAllowed(true,false,background);
      return commitCommands('修改模型',prepared);
    },
    select(expected,selection){assertModelCommand(expected);return commitSelection(selection);},
    history(expected,direction){
      const before=assertModelCommand(expected),target=latest.current.store;
      if(frameBondIdentity){
        if(bondLocked)throw Error('请先暂停播放并等待当前帧准备完成。');
        const after=target.replayFrameBondHistory?.(frameBondIdentity,rawBondDocument,direction);
        return Boolean(after&&after.revision!==before.revision);
      }
      if(target.getHistoryKind?.(direction)==='selection')return target[direction]()!==before;
      assertModelCommand(expected,true);assertStructureEditAllowed(false,true);
      const changed=latest.current.props.onWorkspaceHistory?latest.current.props.onWorkspaceHistory(direction):target[direction]().revision!==before.revision;
      if(changed){dynamics.beforeExternalEdit('撤销或重做模型');cancelWorkingEditTasks();}return changed;
    },
    source(expected){assertModelCommand(expected);return captureOperationSource();},
    camera(expected,command){
      assertModelCommand(expected);
      if(!viewportGetter.current){
        if(command.kind==='zoom')throw Object.assign(new Error('目标视口尚未准备就绪。'),{code:'CAMERA_ZOOM_UNAVAILABLE'});
        throw Error('目标视口尚未准备就绪。');
      }
      if(command.kind==='zoom'){
        if(!viewportZoom.current)throw Object.assign(new Error('目标视口的原生缩放接口尚未就绪。'),{code:'CAMERA_ZOOM_UNAVAILABLE'});
        return viewportZoom.current.zoomByFactor(command.factor);
      }
      if(command.kind==='reset')setResetViewRequest(value=>value+1);
      else if(command.kind==='view')acceptCandidateCameraView(command.view);
      else requestCamera(command);
    },
    cameraGesture(expected,command){
      assertModelCommand(expected);
      if(!viewportGetter.current||!viewportZoom.current?.gesture)throw toolError('CAMERA_UNAVAILABLE','目标视口的相机操作尚未就绪。');
      return viewportZoom.current.gesture(command);
    },
    inspectCrystal(expected,request){assertModelCommand(expected);return inspectCrystal(request);},
    async prepareTransform(expected,request){
      assertModelCommand(expected,true);
      const candidate=request.type==='assign-cell'||request.type==='edit-cell'?prepareCell(request):await prepareTransform(request,false);
      const {source,crystal}=preparedTransformSources.current.get(candidate)!;
      return {candidate,source,crystal};
    },
    async commitTransform(expected,prepared,{derive,signal,dataCell=false,allowInactive=false}){
      const current=assertModelCommand(expected,true,allowInactive);
      signal?.throwIfAborted();
      const {candidate}=prepared,owner=preparedTransformSources.current.get(candidate);
      const {analysisCanvas,observationOnly}=latest.current.props;
      if(dataCell){
        if(derive||current.analysisBindingId||analysisCanvas||observationOnly||
          !['assign-cell','edit-cell'].includes(candidate.operation))throw Error('后台晶胞提交需要普通工作模型。');
      }else if(owner?.source!==prepared.source||owner.key!==scientificCanvasKey(analysisCanvas))throw Error('变换预览来源已变化，请重新预览。');
      if(derive)return (await applyTransform(candidate,signal))??undefined;
      applyCellCandidate(candidate,allowInactive);
      return latest.current.store.getSnapshot().id;
    },
    async perceiveBonds(expected,request,signal){
      assertModelCommand(expected,true);assertStructureEditAllowed();
      const current=latest.current.props.analysisCanvas?captureOperationSource():latest.current.store.getSnapshot();
      const override=request.electronic?captureBondElectronicDraft(current,request.electronic):undefined;
      const {valid,electronic}=bondPerceptionElectronicState(current,{local:localXtbDraft,consent:bondElectronicConsent,override});
      return runBondPerception(current,request,valid?electronic:undefined,signal);
    },
  };
  const {heldUndo,heldUndoContext}=useModelWorkspaceKeyboardLifecycle({keyboard,heldPointerKey,heldLetters,pointerInCanvas,hover,setTemporaryPointerMode,setInteraction,
    modalActive,documentId:model.id,active:props.active,structureLocked,editingLayout:workbenchLayout.editMode,undo:()=>history('undo'),
    undoAllowed:()=>latest.current.props.active!==false&&!historyLocked&&!modalActive&&!workbenchLayout.editMode&&!blockingModelDialog(scope.current)&&!editableTarget(document.activeElement)});
  useEffect(() => {
    const keyEvent = (event: KeyboardEvent, release: boolean, remote=false,detachedFrame=false) => {
      const space=event.code==='Space'||event.key===' ';
      let spaceKeydownAtMs:number|undefined;
      if(!remote&&!release&&!event.repeat&&space){
        try{if(window.sessionStorage.getItem('sciyue.space-optimization-timing')==='1')spaceKeydownAtMs=performance.timeOrigin+performance.now();}
        catch{/* Observation is optional. */}
      }
      if(release&&['z','control','meta'].includes(event.key.toLowerCase()))heldUndo.stop();
      if(latest.current.props.active===false&&!(detachedFrame&&space)){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);keyboard.reset('blur');return;}
      if(!release&&event.defaultPrevented)return;
      const intended=toolIntentMirror.current.element;
      if(keyboard.getSnapshot().gesture==='none'&&keyboard.getSnapshot().element!==intended)keyboard.setElement(intended);
      // Suspend only this 3D interaction port. Do not cancel/bubble-stop keys
      // belonging to a dialog, another model window, or the private 2D editor.
      if (modalActive || workbenchLayout.editMode || blockingModelDialog(scope.current)) {
        heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);
        pointerInCanvas.current = false; hover.current = { kind: 'none', worldPoint: [0, 0, 0] };
        keyboard.reset('blur'); setInteraction(keyboard.getSnapshot()); return;
      }
      const editable = !remote&&(editableTarget(event.target) || editableTarget(document.activeElement));
      const inScope = remote||pointerInCanvas.current || Boolean(scope.current?.contains(document.activeElement)) || Boolean(props.toolHost?.contains(document.activeElement))||Boolean(props.toolbarHost?.contains(document.activeElement));
      // Release bookkeeping runs even outside the canvas; no pending edit may
      // survive a focus or pointer boundary and become a later chord.
      const workbenchRoot=scope.current?.closest('.sciyue-workspace-v18');
      const workspaceSpace=space&&Boolean(workbenchRoot)&&(event.target===document.body||
        event.target instanceof Node&&workbenchRoot!.contains(event.target));
      if(!release&&!inScope&&!workspaceSpace){keyboard.reset('blur');setInteraction(keyboard.getSnapshot());return;}
      const key=event.key.toLowerCase();
      const inputCapture=latest.current.props.captureRequest,reference=referenceCapture.viewportCapture;
      if((inputCapture||reference)&&!editable&&!event.isComposing){
        // Reference/input drafts reuse selection gestures but never dispatch
        // editing, freezing or scientific shortcuts against the model selection.
        if(release){if(heldPointerKey.current?.key===key){heldPointerKey.current=null;heldLetters.current.delete(key);setTemporaryPointerMode(null);}return;}
        if(key===holdBindings.current.select&&!event.ctrlKey&&!event.metaKey&&!event.altKey){heldPointerKey.current={key,mode:'select',used:false};heldLetters.current.add(key);setTemporaryPointerMode('select');event.preventDefault();return;}
        if(key==='escape'){event.preventDefault();heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);if(inputCapture)props.onCaptureCancel?.();referenceCapture.cancel();return;}
        if((event.ctrlKey||event.metaKey)&&key==='a'){event.preventDefault();const ids=store.getSnapshot().draft.structure.atoms.map(atom=>atom.id!);if(inputCapture?.kind==='atoms')updateCapture(ids);else if(reference?.kind==='atoms')reference.onBox(ids);return;}
        if(['Delete','Backspace'].includes(event.key)){event.preventDefault();if(inputCapture)updateCapture([]);else reference?.onPick(null);return;}
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();requestCamera({kind:'step',direction:({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'} as const)[event.key as 'ArrowLeft']});return;}
        if(!event.ctrlKey&&!event.metaKey||['z','y','v'].includes(key))event.preventDefault();
        return;
      }
      if(editable||event.isComposing){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);}
      if(release){
        heldLetters.current.delete(key);
        if(heldPointerKey.current?.key===key){const held=heldPointerKey.current;heldPointerKey.current=null;setTemporaryPointerMode(null);if(!editable&&!event.isComposing&&inScope&&!held.used&&!structureLocked&&!event.ctrlKey&&!event.altKey&&!event.metaKey){const element=elementForHoldTap(key);if(element)setElement(element);}event.preventDefault();return;}
      }else if(!editable&&!event.isComposing){
        if(key==='escape'){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);}
        const deniedFreeze=readOnlyFreezeHold(key,holdBindings.current.freeze,latest.current.props.freezeEditingAllowed);
        if(deniedFreeze){heldLetters.current.add(key);heldPointerKey.current=deniedFreeze;setTemporaryPointerMode('select');event.preventDefault();return;}
        const holdMode=key===holdBindings.current.select?'select':key===holdBindings.current.freeze?'freeze':null;
        if(!event.repeat&&holdMode&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!heldLetters.current.size&&(!structureLocked||holdMode==='select')){heldLetters.current.add(key);heldPointerKey.current={key,mode:holdMode,used:false};setTemporaryPointerMode(holdMode);event.preventDefault();return;}
        if(heldPointerKey.current&&key!==heldPointerKey.current.key&&/^[a-z]$/.test(key)){
          const held=heldPointerKey.current;heldPointerKey.current=null;setTemporaryPointerMode(null);
          if(!held.used)keyboard.keyDown({key:held.key,editable:false,hoverKind:currentHover().kind});
        }
        if(/^[a-z]$/.test(key))heldLetters.current.add(key);
      }
      if(!release&&!editable&&!event.isComposing&&['Delete','Backspace'].includes(event.key)&&heldPointerKey.current){event.preventDefault();return;}
      if(!release&&!editable&&!event.isComposing&&['Delete','Backspace'].includes(event.key)&&hoveredMarker.current){event.preventDefault();deleteStateMarker(hoveredMarker.current);return;}
      if(!release&&!editable&&['Delete','Backspace'].includes(event.key)&&hoveredRecord.current){event.preventDefault();deleteMeasurement(hoveredRecord.current.id);return;}
      if (event.code==='Space' || event.key===' ') {
        if(workspaceSpacePressAllowed(event,release,remote?null:event.target,remote?null:document.activeElement)){
          event.preventDefault();const runtime=xtb.getSnapshot(),dynamic=dynamics.getSnapshot(),action=currentOrdinaryOptimization()?'stop':workspaceSpaceOptimizationAction({xtbRunning:runtime.running,xtbPhase:runtime.phase,xtbOperation:runtime.operation,dynamicsStatus:dynamic.status,canStart:(!structureLocked||Boolean(props.analysisCanvas?.onOptimize))&&!busy&&!optimizationBusy&&!geometryEditing&&!partialPeriodicBox&&!!atoms.length});
          if(action==='stop')void stopActiveOptimization().catch(cause=>setError(message(cause)));
          else if(action==='start')void spaceOptimize(spaceKeydownAtMs,detachedFrame).catch(cause=>setError(message(cause)));
        }
        return;
      }
      if(!release&&!editable&&!event.isComposing&&(event.ctrlKey||event.metaKey)&&key==='z'&&!event.shiftKey&&!event.altKey){
        event.preventDefault();
        dispatchWorkspaceUndoPress({remote,repeat:event.repeat,structureLocked:historyLocked,selectionUndo:store.getHistoryKind?.('undo')==='selection'}, {undo:()=>history('undo'),startLocalRepeat:()=>heldUndo.start(()=>heldUndoContext.current.undo(),()=>heldUndoContext.current.allowed())});
        return;
      }
      if (!release&&!editable&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {event.preventDefault();requestCamera({kind:'step',direction:({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'} as const)[event.key as 'ArrowLeft']});return;}
      const readonlyShortcut=(event.ctrlKey||event.metaKey)&&['a','c','s'].includes(event.key.toLowerCase())||['2','3','4'].includes(event.key)&&currentHover().kind==='none';
      const selectionHistoryShortcut=(event.ctrlKey||event.metaKey)&&((key==='z'&&(!historyLocked||store.getHistoryKind?.('undo')==='selection'))||(key==='y'&&(!historyLocked||store.getHistoryKind?.('redo')==='selection')));
      if(structureLocked&&frameBondIdentity&&!bondLocked&&!release&&!editable&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
        const pick=currentHover();
        if(['Delete','Backspace'].includes(event.key)&&(pick.kind==='bond'||pick.kind==='auxiliary'||pick.kind==='port'||pick.kind==='none'&&isFrameBondCommand({type:'delete-objects'},workingSelection))){event.preventDefault();action({type:'delete'});return;}
        const orders:Record<string,BondOrder>={'1':1,'2':2,'3':3,'4':1.5,'5':.5};
        if(orders[key]!==undefined&&(pick.kind==='bond'||workingSelection.atomIds.length===2)){event.preventDefault();action({type:'bond-order',order:orders[key]});return;}
      }
      if (structureLocked && !editable && event.key!=='Escape'&&!readonlyShortcut&&!selectionHistoryShortcut) { heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);keyboard.suspend();setInteraction(keyboard.getSnapshot());return; }
      const pick = currentHover();
      const input = { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
        repeat: event.repeat, isComposing: event.isComposing, editable: editable || !inScope, hoverKind:pick.kind, hoverAtomId: pick.kind === 'atom' ? pick.atomId : undefined };
      const previousElement=keyboard.getSnapshot().element;
      const actions = release ? keyboard.keyUp(input) : keyboard.keyDown(input);
      if(!release&&!input.editable&&!input.isComposing&&keyboard.getSnapshot().element&&keyboard.getSnapshot().element!==previousElement){const element=keyboard.getSnapshot().element!;applyToolIntent({type:'select-element',element,presetId:defaultElementPresetId(element),origin:'keyboard'});}
      if (!input.editable && !input.isComposing && (actions.length || (!event.ctrlKey && !event.metaKey && !event.altKey && /^[a-z1-5]$/i.test(event.key)))) event.preventDefault();
      actions.forEach(action); setInteraction(keyboard.getSnapshot());
    };
    keyEventRef.current=keyEvent;
    return bindModelWorkspaceKeys(window,keyEvent);
  });
  viewportDispatch.current=createModelWorkspaceViewportDispatcher({documentId:model.id,revision:model.revision,frameBondKey:()=>frameBondEditing?.frameKey,
    read:()=>({document:latest.current.store.getSnapshot(),alive:asyncAlive.current,active:latest.current.props.active}),
    blocked:()=>modalActive||workbenchLayout.editMode||blockingModelDialog(scope.current),markers:stateMarkers,onError:cause=>setError(message(cause)),
    handlers:{
        'sampling-sphere':event=>{
          const draft=latest.current.props.samplingSphereDraft,current=latest.current.store.getSnapshot();
          if(!draft||draft.disabled||!draft.previewEnabled||!latest.current.props.onSamplingSphereRadiusChange||event.sourceDocumentId!==draft.sourceDocumentId||event.sourceRevision!==draft.sourceRevision||current.id!==draft.sourceDocumentId||current.revision!==draft.sourceRevision)throw new Error('球形约束来源已变化，请重新操作。');
          if(!Number.isFinite(event.radiusAngstrom)||event.radiusAngstrom<draft.minimumRadiusAngstrom)throw new Error('球半径不能小于最小包围半径。');
          latest.current.props.onSamplingSphereRadiusChange(event);
        },
        'trajectory-playback':event=>{
          const playback=latest.current.props.analysisCanvas?.trajectoryPlayback;
          if(!playback||!trajectoryPlaybackEventCurrent(playback.state,event))throw new Error('轨迹播放对象、集合版本或顺序已变化。');
          playback.dispatch(event.command);
        },
        'cell-editor':event=>{
          const draft=validCellEditorDraft,current=latest.current.store.getSnapshot();
          if(baseStructureLocked||!draft||!structureEditAllowed(false,true)||event.documentId!==draft.documentId||event.expectedRevision!==draft.expectedRevision||current.id!==draft.documentId||current.revision!==draft.expectedRevision)throw new Error('晶胞编辑来源已变化，请重新操作。');
          if(event.action==='hover'){if(event.axis!==null&&event.axis!==0&&event.axis!==1&&event.axis!==2)throw new Error('晶胞轴无效。');draft.onAxisHover(event.axis);}
          else if(event.action==='start')draft.onDragStart();
          else if(event.action==='length'){if((event.axis!==0&&event.axis!==1&&event.axis!==2)||!Number.isFinite(event.length)||event.length!<=0)throw new Error('晶胞长度必须为正数。');draft.onLengthChange(event.axis,event.length!);}
          else if(event.action==='commit'){if((event.axis!==0&&event.axis!==1&&event.axis!==2)||!Number.isFinite(event.length)||event.length!<=0)throw new Error('晶胞长度必须为正数。');draft.onLengthCommit(event.axis,event.length!);}
          else if(event.action==='end')draft.onDragEnd(event.cancel===true);
          else throw new Error('未知晶胞编辑事件。');
        },
        'atom-number-pick':(event,{current})=>{
          if(!latest.current.props.onAtomNumberPick||!current.draft.structure.atoms.some(atom=>atom.id===event.atomId))throw new Error('当前没有有效的原子编号选择。');
          latest.current.props.onAtomNumberPick(event.atomId);},
        command:event=>{
          if(!['place-element','place-fragment','transform-fragment','set-bond-order','delete-objects','add-single-hydrogen'].includes(event.command.type))throw new Error('此命令不属于视口交互范围。');
          copiedPlacement(event.command);},
        selection:event=>select(event.selection),
        'atom-state':event=>{if(!['select-add','select-remove','freeze','unfreeze'].includes(event.action))throw new Error('未知原子状态操作。');atomStateChange(event.atomIds,event.action);},
        'object-state':event=>{if(!['select-add','select-remove','freeze','unfreeze'].includes(event.action))throw new Error('未知对象状态操作。');objectStateChange(event.objects,event.action);},
        'marker-delete':(event,{resolveMarker})=>deleteStateMarker(resolveMarker(event.marker)),
        'object-delete':event=>deletePickedObject(event.pick),
        'measurement-pick':event=>pickCoordinateAtom(event.atomId),
        'measurement-select':event=>{const record=measurement.records?.find(row=>row.id===event.recordId);if(!record)throw new Error('测量记录已变化。');selectMeasurementRecord(record);},
        'measurement-delete':event=>deleteMeasurement(event.recordId),
        'measurement-wheel':event=>{const record=measurement.records?.find(row=>row.id===event.recordId);if(!record)throw new Error('测量记录已变化。');wheelMeasurementRecord(record,event.deltaY);},
        'capture-pick':event=>capturePick(event.atomId),
        'capture-box':(event,{current})=>{if(!props.captureRequest)throw new Error('当前没有输入选择请求。');if(event.atomIds.some(id=>!current.draft.structure.atoms.some(atom=>atom.id===id)))throw new Error('输入选择包含已失效原子。');updateCapture(event.atomIds,event.images);},
        camera:event=>acceptCameraView(event.view),
        key:(event,{current,releasing,resolveMarker,detached})=>{
          hover.current=event.hover;hoverStamp.current={id:current.id,revision:current.revision};
          const remoteRecord=event.measurementRecordId?measurement.records?.find(row=>row.id===event.measurementRecordId)??null:null;
          if(event.measurementRecordId&&!remoteRecord&&!releasing)throw new Error('悬停测量记录已变化，请重新选择。');
          hoveredMarker.current=event.marker&&!releasing?resolveMarker(event.marker):null;hoveredRecord.current=remoteRecord;
          if((event.heldUsed||current.revision!==model.revision)&&heldPointerKey.current)heldPointerKey.current.used=true;
          keyEventRef.current(new KeyboardEvent(event.release?'keyup':'keydown',{key:event.key,code:event.key===' '?'Space':event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,repeat:event.repeat,cancelable:true}),event.release,true,detached);
        },
        clear:(event,{detached})=>{
          if(event.kind==='selection'){
            if(detached&&structureLocked&&!observationKey)throw Error('当前视图没有可清除的观察选区。');
            select(EMPTY_SELECTION);
          }else if(event.kind==='frozen')execute({type:'clear-shared-freezes'});
          else if(event.kind==='coordinates')clearCoordinates();
          else throw new Error('未知清空操作。');
        },
        save:()=>save(),
        'file-action':event=>{if(event.action==='import')return importFiles();if(event.action==='export-structure')return save();setImageExportOpenRequest(value=>value+1);},
        'display-settings':event=>changeDisplay(event.display),
        'axes-visible':event=>{if(latest.current.props.onSharedShowAxesChange)latest.current.props.onSharedShowAxesChange(event.visible);else setLocalShowAxes(event.visible);},
    },
  });
  useEffect(()=>{props.onViewportController?.(viewportController);return()=>props.onViewportController?.(null);},[props.onViewportController,viewportController]);
  const cellGuides = useMemo<CellPresentationOptions|undefined>(() => {
    if (props.advancedModelingRoute?.category !== 'periodic') return;
    if (tiledTransform) return { preview: structurePreview?.structure.cell };
    return { current:model.draft.structure.cell, checkpoint:model.cellCheckpoint?.structure.cell, preview:structurePreview?.structure.cell };
  }, [props.advancedModelingRoute, props.derivedSupercellSource, model.draft.structure.cell, model.cellCheckpoint, structurePreview, tiledTransform]);
  const previewGuides = !referenceCapture.viewportCapture ? (tiledTransform ? validTransformPresentation?.candidateGuides : validTransformPresentation?.guides) : undefined;
  const previewCell = !referenceCapture.viewportCapture ? validTransformPresentation?.sourceCell : undefined;
  const viewportState:WorkspaceViewportState={documentId:model.id,revision:model.revision,display:viewportDisplay,interaction,frameBondEditing,readonlyDrawing:Boolean(frameBondEditing&&!bondLocked),observationSelection:Boolean(frameBondEditing&&!bondLocked),highlights:advancedObservation?undefined:highlights,bondOrderEntries,workspaceInputRoles:props.workspaceInputRoles,workspaceDocumentPickMode:props.workspaceDocumentPickMode,workspaceDocumentPickSelected:props.workspaceDocumentPickSelected,
    cellGuides, previewGuides, previewCell, cellHover:true,
    temporaryPointerMode:effectivePointerMode,freezeRemovalMode:props.freezeEditingAllowed!==false&&!temporaryPointerMode&&freezeTool==='remove',effectiveFrozenAtomIds,displayFrozenAtomIds,stateMarkers,
    selectionShortcut:shortcuts.bindings.select.toUpperCase(),selectShortcut:shortcuts.bindings.select,freezeShortcut:shortcuts.bindings.freeze,measurement,persistentTool,fragmentTool:{templateId:copiedTool?'复制片段':template,activeAtomIndex:copiedTool?copyActiveIndex:activeFragmentIndex},captureRequest:props.captureRequest,captureAtomIds,numberingPickActive:Boolean(props.onAtomNumberPick),linkedAtomsActive:props.linkedAtomsActive??false,
    interactionOwnerActive:props.active!==false,interactionActivationEpoch:props.activationStamp?.().activationEpoch,cameraRequest,cameraView,showAxes,legendVisible:presentationActive&&!props.onLegendSurfaceChange,structureLocked,readOnly:props.observationOnly||structureAnalysisOpen,allowModelEditing:!structureLocked,freezeEditingAllowed:props.freezeEditingAllowed,editingDocument:props.analysisCanvas?.staticDocument?{...bondDocument,revision:model.revision,selection:workingSelection}:viewportModel===model?undefined:model,observationTool:freezeTool==='box'?'box':observationTool,resetViewRequest,
    viewTransform:props.analysisCanvas?.viewport.viewTransform??props.initialViewTransform,observationTransform:mdObservationTransform,observationAnchorAtomIds:mdDisplayFrame?.nativeMD?.protectedAtomIds,
    observationReference:xtbFrameCurrent?viewportObservation?.reference:observeDynamics?dynamicState.referenceStructure:undefined,observationEpoch:xtbFrameCurrent?viewportObservation?.epoch:observeDynamics?dynamicState.sessionId:undefined,observationFrame:xtbFrameCurrent?viewportObservation?.frame:observeDynamics?shownDynamicsFrame?.seq:undefined,
    cellEditor:validCellEditorDraft?{documentId:validCellEditorDraft.documentId,expectedRevision:validCellEditorDraft.expectedRevision,cell:validCellEditorDraft.cell,lengths:validCellEditorDraft.lengths,activeAxis:validCellEditorDraft.activeAxis}:undefined,
    samplingSphereEditor:props.samplingSphereDraft?.sourceDocumentId===model.id&&props.samplingSphereDraft.sourceRevision===model.revision?props.samplingSphereDraft:undefined,
    trajectoryPlayback:props.analysisCanvas?.trajectoryPlayback?.state,
    readonlyClearSelection:Boolean(observationKey),
    error,dockTarget:props.viewportDockTarget};
  // This callback stays inside the owner renderer and carries immutable Store
  // snapshots. Wire admission belongs to the actual shared-window publication.
  useEffect(()=>{props.onViewportState?.(viewportState);});
  const optimizationRunning=Boolean(ordinaryRun)||xtbState.running;
  const optimizationDevice=optimizationKind==='net'?netSettings.device:undefined;
  const ordinaryBlocked=partialPeriodicBox||!atoms.length||busy||geometryEditing||optimizationBusy&&!ordinaryRun||
    ['starting','running','pausing','paused','stopping'].includes(dynamicState.status);
  const ordinaryDisabled=props.active===false||ordinaryBlocked;
  const optimizationEditable=!structureLocked||Boolean(props.analysisCanvas?.onOptimize);
  const emptyOptimizationRange=optimizationPreferences.scope==='selection'&&!indices.length||
    optimizationPreferences.scope==='unselected'&&indices.length===atoms.length;
  const selectedGxtbBlocked=gxtbRunBlocked(gxtbBackend,optimizationMethod);
  const optionsFor=(electronic:{charge:number;multiplicity:number})=>optimizationKind==='xtb'?
    xtbPanelSubmission({...xtbSettings,...electronic,resourceOverrides:optimizationResourceOverrides},periodicModel):undefined;
  const derivedOptimization=Boolean(props.analysisCanvas?.onOptimize&&
    (props.analysisCanvas.result||props.observationOnly&&props.allowModelEditing!==true));
  const derivedStructure=derivedOptimization?scientificCanvasStructure(props.analysisCanvas,true):undefined;
  const preoptimizationElectronic=derivedOptimization?
    {charge:derivedStructure?.charge??NaN,multiplicity:derivedStructure?.multiplicity??NaN}:xtbElectronic;
  const electronicOptionsValid=optimizationKind==='xtb'?Boolean(optionsFor(preoptimizationElectronic)):
    !electronicStateParameterError(preoptimizationElectronic.charge,preoptimizationElectronic.multiplicity);
  const canOptimize=workspaceOptimizationMethodAvailable(optimizationMethod,periodicModel)&&optimizationEditable&&!emptyOptimizationRange&&!selectedGxtbBlocked&&runtimeSettingsValid&&electronicOptionsValid;
  const activeSciencePort=useRef<ScienceModelRuntime>(null!);
  activeSciencePort.current={
    active:()=>latest.current.props.active!==false,
    runs:()=>[...scienceRuns.values()],
    async startOptimization(source,options){
      const frame=isScienceFrameReference(source.ref);
      if(ordinaryBlocked||xtb.getSnapshot().running||currentOrdinaryOptimization()||sharedOptimizationPending.current)
        throw Error('当前不能启动优化，请先结束正在进行的模型操作。');
      if(!frame)assertStructureEditAllowed(false,false,true,true);
      let actual=captureRequestedScienceSource(source,Boolean(options.electronic));
      if(!frame&&!options.electronic&&sharedElectronicDraft.has()){
        sharedElectronicDraft.commit();
        if(!sharedElectronicDraft.flush(store.getSnapshot().electronicStateConfirmed===true))throw Error('请先填写完整整数电荷与正整数多重度。');
        actual=store.getSnapshot();
      }
      await projectOptimization?.prepare();
      const {preferences,sharedMethodPreferences,method,xtbOptions}=prepareOrdinaryOptimization(
        projectOptimization?.read()??readWorkspaceOptimizationPreferences(),actual.draft.structure,options);
      if(gxtbRunBlocked(gxtbBackend,method))throw Error('请先在全局设置中配置可用的 g-xTB 程序。');
      const electronic=options.electronic;
      const requested=electronic?{...actual,draft:{...actual.draft,structure:{...actual.draft.structure,...electronic}}}:actual;
      ordinaryOptimizationInput(requested,preferences,xtbOptions,empiricalParameters);
      if(sharedMethodPreferences)updateOptimizationPreferences(sharedMethodPreferences);
      if(electronic&&!frame){
        sharedElectronicDraft.replace(electronic,true);
        actual=store.getSnapshot();
        if(actual.draft.structure.charge!==electronic.charge||actual.draft.structure.multiplicity!==electronic.multiplicity||
          !actual.electronicStateConfirmed)throw Error('电子态所属模型已变化，本次优化没有提交。');
        setSavedXtbElectronic(null);
      }else{
        actual=requested;
      }
      const runSource=frame?source:{...source,ref:{...source.ref,revision:actual.revision}};
      return new Promise((resolve,reject)=>{
        void runSharedOptimization(preferences,xtbOptions,undefined,{source:actual,
          mcp:{source:runSource,retainTrajectory:options.retainTrajectory,presentation:options.presentation,accepted:resolve}})
          .then(()=>reject(Error('本次优化没有返回运行身份。')),reject);
      });
    },
    async startMd(source,options){
      if(props.observationOnly&&props.allowModelEditing!==true&&isScienceFrameReference(source.ref))
        throw toolError('SCIENCE_MD_EDITABLE_SOURCE_REQUIRED','当前结果帧可以提取为独立模型，再从该模型启动实时 MD。',
          {reason:'readonly-result-frame',source:source.ref,submitted:false});
      const activeOptimization=currentOrdinaryOptimization();
      const obstruction=props.active===false?'view-inactive':!props.realtime?'realtime-unavailable':busy?'workspace-busy':
        geometryEditing?'geometry-editing':xtb.getSnapshot().running||activeOptimization?'optimization-running':undefined;
      if(obstruction)throw toolError('SCIENCE_MD_START_BLOCKED','当前模型无法启动实时 MD。',{reason:obstruction,source:source.ref,submitted:false});
      const actual=captureRequestedScienceSource(source),structure=actual.draft.structure,periodic=isPeriodic(structure);
      if(structure.periodicSource?.completeness==='partial'||!structure.atoms.length||
        electronicStateParameterError(structure.charge??NaN,structure.multiplicity??NaN))throw Error('请核对本次 MD 的完整结构与电子态。');
      const method=options.method??(isXtbMethod(scienceMdDraft.method)?scienceMdDraft.method:'gfn2');
      const integrator=options.integrator??(periodic?'ase':method==='gxtb'?'xtb':scienceMdDraft.integrator??'xtb');
      const temperatureK=options.temperatureK??Number(scienceMdDraft.temperature);
      const solvation=options.solvation===undefined?(periodic?undefined:scienceMdDraft.solvation):options.solvation??undefined;
      if(method==='gxtb'&&options.seed!==undefined)throw toolError('INVALID_ARGUMENT','g-xTB 由程序初始化随机数，请省略 seed。',
        {field:'seed',method,integrator,seedTreatment:'native-program-random',submitted:false});
      if(method==='gfnff'&&options.shakeHydrogenBonds===true)throw Error('GFN-FF 不支持 X–H SHAKE。');
      const config:DynamicsConfig={...options,method,integrator,temperatureK,solvation,
        shakeHydrogenBonds:method==='gfnff'?false:options.shakeHydrogenBonds??scienceMdDraft.shakeHydrogenBonds};
      if(!Number.isFinite(temperatureK)||temperatureK<.01||temperatureK>5000)throw Error('MD 目标温度须为 0.01–5000 K。');
      if(!supportsMDIntegrator(method,periodic,integrator))throw Error('所选方法与积分器不支持当前模型。');
      if(gxtbRunBlocked(gxtbBackend,method))throw Error('请先在全局设置中配置可用的 g-xTB 程序。');
      if(!prepareDynamicsStart('md',config))throw Error('当前模型无法启动实时 MD。');
      const before=dynamics.getSnapshot().sessionId;
      try{
        await dynamics.start('md',config,captureRequestedScienceSource(source));
      }catch(cause){
        store.clearScientificEditApproval?.();
        const sessionId=dynamics.getSnapshot().sessionId;
        const registered=sessionId&&sessionId!==before?scienceRuns.get(sessionId):undefined;
        if(!registered)throw cause;
        registered.source=source.ref;
        registered.accepted=false;
        registered.launchDisposition='start-rejected';
        notifyScienceRuns(store);
        return {...registered};
      }
      const runId=dynamics.getSnapshot().sessionId,receipt=runId&&scienceRuns.get(runId);
      if(!receipt||runId===before)throw toolError('SCIENCE_MD_START_UNCONFIRMED','本次 MD 启动没有返回新的运行凭据。',
        {source:source.ref,submissionState:'unconfirmed',recovery:{tool:'es_run_list',arguments:{}}});
      receipt.source=source.ref;
      receipt.accepted=true;
      receipt.launchDisposition='start-acknowledged';
      notifyScienceRuns(store);
      return {...receipt};
    },
    ownsActiveRun(runId){
      const dynamic=dynamics.getSnapshot();
      return sharedOptimization.current?.runId===runId||
        dynamic.sessionId===runId&&['starting','running','pausing','paused','stopping'].includes(dynamic.status);
    },
    async stop(runId){
      const ordinary=sharedOptimization.current;
      if(ordinary?.runId===runId)return ordinary.stop();
      const dynamic=dynamics.getSnapshot();
      if(dynamic.sessionId===runId&&['starting','running','pausing','paused','stopping'].includes(dynamic.status))return dynamics.stop();
      throw Error('该运行的活动会话已结束或已替换。');
    },
  };
  useLayoutEffect(()=>registerScienceModelRuntime(store,{
    active:()=>activeSciencePort.current.active(),runs:()=>activeSciencePort.current.runs(),
    startOptimization:(source,options)=>activeSciencePort.current.startOptimization(source,options),
    startMd:(source,options)=>activeSciencePort.current.startMd(source,options),ownsActiveRun:runId=>activeSciencePort.current.ownsActiveRun(runId),
    stop:runId=>activeSciencePort.current.stop(runId),
  }),[store]);
  useLayoutEffect(()=>{
    const checkingClose=new Set<string>();
    const publish=()=>{
      const snapshot=dynamics.getSnapshot(),{sessionId,workingSource}=snapshot;
      if(!sessionId||!workingSource||workingSource.documentId!==store.getSnapshot().id)return;
      let receipt=scienceRuns.get(sessionId);
      if(!receipt){
        const request=dynamics.getRequestSnapshot();
        if(!request)return;
        const {structure,...parameters}=request;
        receipt={kind:'md',runId:sessionId,documentId:workingSource.documentId,revision:workingSource.revision,status:snapshot.status,
          registered:true,nativeStarted:false,workerSettled:desktopBridge()?.waitForDynamicsClose?false:undefined,
          request:{...parameters,atomCount:structure.atoms.length,charge:structure.charge,multiplicity:structure.multiplicity,cell:structure.cell}};
        scienceRuns.set(sessionId,receipt);
      }
      receipt.nativeStarted=receipt.nativeStarted||snapshot.status==='running';
      receipt.status=snapshot.status;
      receipt.resultAdoption=snapshot.resultAdoption;
      receipt.diagnostics={error:snapshot.error,terminalFailure:snapshot.terminalFailure,termination:snapshot.termination};
      const bridge=desktopBridge();
      if(bridge?.waitForDynamicsClose&&!checkingClose.has(sessionId)&&['stopped','completed','error'].includes(snapshot.status)){
        checkingClose.add(sessionId);
        const owned=receipt;
        void bridge.waitForDynamicsClose(workingSource.documentId,sessionId).then(()=>{owned.workerSettled=true;},cause=>{
          owned.diagnostics={...(owned.diagnostics as object),workerCloseError:message(cause)};
        }).finally(()=>notifyScienceRuns(store));
      }
      if(snapshot.lastFrame){
        const {structure:geometry,displayFrames,displayByteLength,...frame}=snapshot.lastFrame;
        receipt.frame={...frame,atomCount:geometry.atoms.length,coordinateUnit:'angstrom',energyUnit:'eV',timeUnit:'fs'};
      }
      notifyScienceRuns(store);
    };
    publish();
    return dynamics.subscribe(publish);
  },[dynamics,store]);
  async function spaceOptimize(spaceKeydownAtMs?:number,detachedFrame=false){
    if(currentOrdinaryOptimization()){await stopActiveOptimization();return;}
    if(ordinaryBlocked||props.active===false&&!detachedFrame||!optimizationEditable||xtbState.running)return;
    if(!workspaceOptimizationMethodAvailable(optimizationMethod,periodicModel)){setError('此版本提供 xTB 计算，请先选择可用的预优化方法。');return;}
    if(emptyOptimizationRange){setError('本次范围没有可动原子。');return;}
    if(selectedGxtbBlocked){setError('请先在全局设置中配置可用的 g-xTB 程序。');return;}
    if(!runtimeSettingsValid){setError('请先修正预优化运行设置中的无效数值。');return;}
    if(!derivedOptimization&&sharedElectronicDraft.present){
      sharedElectronicDraft.commit();
      if(!sharedElectronicDraft.flush(store.getSnapshot().electronicStateConfirmed===true)){setError('请先填写完整整数电荷与正整数多重度。');return;}
    }
    let source:ModelDocument|undefined;
    if(derivedOptimization){
      try{source=captureOperationSource('calculation-source');}
      catch(cause){setError(message(cause));return;}
    }
    const confirmed=source?.draft.structure??latest.current.store.getSnapshot().draft.structure;
    const electronic=source||sharedElectronicDraft.present?
      {charge:confirmed.charge??NaN,multiplicity:confirmed.multiplicity??NaN}:xtbElectronic;
    try{await projectOptimization?.prepare();}
    catch(cause){setError(message(cause));return;}
    const runPreferences=projectOptimization?.read()??optimizationPreferences;
    const runPeriodic=isPeriodic(confirmed);
    const runKind=workspaceOptimizationKind(runPreferences,runPeriodic);
    const options=runKind==='xtb'?xtbPanelSubmission({...workspaceXtbSettings(runPreferences,runPeriodic),...electronic,resourceOverrides:optimizationResourceOverrides},runPeriodic):undefined;
    if(runKind==='xtb'&&!options||runKind==='net'&&electronicStateParameterError(electronic.charge,electronic.multiplicity)){
      setError('请先核对当前模型的电荷、多重度和优化参数。');return;
    }
    await runSharedOptimization(runPreferences,options??undefined,spaceKeydownAtMs,{source,detachedFrame});
  }
  viewportPreoptimization.current=settings=>settings?
    runSharedOptimization(settings.preferences,settings.xtbOptions,settings.spaceKeydownAtMs,{
      empiricalBondParameters:settings.empiricalBondParameters,onStandaloneRunStarted:settings.onStandaloneRunStarted}):spaceOptimize();
  const measurementOptions=[['auto','自动测量'],['distance','B 键长'],['angle','A 键角'],['dihedral','D 二面角']] as const;
  const warmSpaceBackend=useRef<()=>void>(()=>{});
  warmSpaceBackend.current=()=>{
    const bridge=desktopBridge();
    if(!bridge?.preparePes)return;
    try{
      const source=captureOperationSource('calculation-source');
      const input=ordinaryOptimizationInput(source,optimizationPreferences,optionsFor(xtbElectronic)??undefined);
      const request=standaloneOptimizationRequest(source,input,`warm-${crypto.randomUUID()}`);
      void bridge.preparePes(request).catch(()=>{});
    }catch{/* An incomplete draft can still be edited before an actual submission. */}
  };
  // Merely opening a model or finishing an optimization does not load NET
  // weights into memory. An actual task or explicit preparation owns that load.
  const warmEligible=optimizationKind!=='net'&&!ordinaryDisabled&&!optimizationRunning&&canOptimize&&!!desktopBridge()?.preparePes;
  useEffect(()=>{
    if(!warmEligible)return;
    const timer=window.setTimeout(()=>warmSpaceBackend.current(),140);
    return()=>window.clearTimeout(timer);
  },[warmEligible,model.id,periodicModel,atoms.length,indices.length,xtbElectronic.charge,xtbElectronic.multiplicity,
    optimizationMethod,optimizationDevice,optimizationPreferences.scope,xtbSettings.solvation?.solvent]);
  const shownOptimizationMethod=ordinaryRun?.method??optimizationMethod;
  const linkedOptimization=props.analysisCanvas?.ordinaryOptimizationOutcome;
  const linked=linkedOptimization?.request.method===shownOptimizationMethod&&
    (optimizationRunning||!optimizationDevice||(linkedOptimization.request.parameters.device??'gpu')===optimizationDevice)?linkedOptimization:undefined;
  const local=sharedOptimizationStatus?.method===shownOptimizationMethod&&
    (optimizationRunning||sharedOptimizationStatus.device===optimizationDevice)?sharedOptimizationStatus:undefined;
  const linkedError=ordinaryOptimizationError(linked?.error,linked?.result);
  const linkedStatus=linked?ordinaryOptimizationStatus(linked.status,linked.result):undefined;
  const legacyOptimization=xtbState.running||optimizationKind==='xtb'&&Boolean(xtbState.metadata||xtbState.error);
  const preoptimizationError=ordinaryRun?undefined:local?.error??linkedError??(legacyOptimization?xtbState.error:undefined);
  const preoptimizationStatus=ordinaryRun?local?.text??'优化中…':local?.text??linkedStatus??
    (legacyOptimization?xtbOptimizationDisplayStatus(xtbState,shownXtbFrame):undefined);
  const evidence=(sharedOptimizationEvidence?.request.sourceDocumentId===model.id&&sharedOptimizationEvidence.request.method===shownOptimizationMethod&&
    (optimizationRunning||!optimizationDevice||(sharedOptimizationEvidence.request.parameters.device??'gpu')===optimizationDevice)?sharedOptimizationEvidence:undefined)
    ??(linked?.result?{request:linked.request,result:linked.result}:undefined);

  const ordinaryProvenance=evidence?.result.provenance;
  const ordinaryResiduals=(ordinaryProvenance?.convergence as {constraintResiduals?:Record<string,number>}|undefined)?.constraintResiduals;
  const ordinaryConstraintRows=(evidence?.request.constraints.coordinates??[]).flatMap(row=>{
    const residual=ordinaryResiduals?.[row.id];
    if(typeof residual!=='number'||!Number.isFinite(residual))return [];
    const labels=row.atomIds.map(id=>{const index=atoms.findIndex(atom=>atom.id===id);return index<0?id:String(index+1);});
    return [{id:row.id,type:row.type,target:row.value,residual,atoms:labels.join('、')}];
  });
  const ordinaryConstraints=<OrdinaryConstraintDetails rows={ordinaryConstraintRows}/>;
  const toolActions:WorkbenchToolAction[]=[
    {id:'view.rotate',label:'视图',content:<button aria-pressed={!interaction.element&&observationTool==='rotate'&&!measurement.mode} onClick={()=>setElement(null)}>视图</button>},
    {id:'view.pan',label:'平移观察',content:<button aria-pressed={observationTool==='pan'} onClick={()=>applyToolIntent({type:'observe',tool:'pan'})}>平移观察</button>},
    {id:'view.reset',label:'居中',content:<button data-testid="model-reset-view" onClick={()=>setResetViewRequest(value=>value+1)}>居中</button>,criticalContent:<button onClick={()=>setResetViewRequest(value=>value+1)}>居中</button>,essential:true},
    {id:'select.point',label:'点选',content:<button aria-pressed={observationTool==='select'} onClick={()=>applyToolIntent({type:'observe',tool:'select'})}>点选</button>},
    {id:'select.box',label:'框选',content:<span className="model-shortcut-button"><button disabled={structureLocked} aria-pressed={observationTool==='box'} onClick={()=>applyToolIntent({type:'observe',tool:'box'})}>框选</button><HoldKeyCorner kind="select" value={shortcuts.bindings.select} writable={shortcuts.writable} save={shortcuts.save}/></span>},
    {id:'select.clear',label:'清选择',content:<button onClick={()=>select(EMPTY_SELECTION)}>清选择</button>},
    {id:'select.all',label:'全选',content:<button onClick={()=>select({...EMPTY_SELECTION,atomIds:atoms.map(atom=>atom.id!)})}>全选</button>},
    ...measurementOptions.map(([mode,label])=>({id:'measure.'+mode,label,content:<button data-testid={'model-measure-'+mode} aria-pressed={measurement.mode===mode} onClick={()=>applyToolIntent({type:'measure',mode})}>{label}</button>})),
    {id:'measure.clear',label:'清内坐标',content:<button data-testid="model-clear-measurement" title="清临时测量和未绑定内坐标，保留任务冻结与扫描" onClick={clearCoordinates}>清内坐标</button>},
    {id:'model.perceive',label:'判断成键',content:<button disabled={bondLocked||periodic||busy||!atoms.length} onClick={()=>void chemistry()}>判断成键</button>},
    {id:'model.rebuild',label:'重新识别',content:<button disabled={bondLocked||periodic||busy||!atoms.length} onClick={()=>{void chemistry(true);}}>重新识别</button>},
    {id:'model.cancel',label:'取消整理',content:<button disabled={!busy} onClick={()=>{cancelTask();setStatus('已取消，保留原几何。');}}>取消整理</button>,criticalContent:<button disabled={!busy} onClick={()=>{cancelTask();setStatus('已取消，保留原几何。');}}>取消整理</button>},
    {id:'model.delete',label:'删除',content:<button disabled={(frameBondIdentity&&isFrameBondCommand({type:'delete-objects'},workingSelection)?bondLocked:structureLocked)||(!indices.length&&!workingSelection.bonds.length&&!workingSelection.auxiliaryIds.length&&!workingSelection.portIds?.length&&!workingSelection.coordinateIds?.length&&!geometryOpen)} onClick={deleteSelectedObjects}>删除</button>},
    {id:'model.copy',label:'复制',content:<button onClick={()=>void copy()}>复制</button>},
    {id:'model.paste',label:'粘贴',content:<button disabled={structureLocked} onClick={()=>void paste()}>粘贴</button>},
    {id:'model.extract',label:'提取',content:<button disabled={structureLocked||!onExtract||!indices.length||model.draft.dirty||busy} onClick={onExtract}>提取</button>},
    {id:'atom.setCharge',label:'设电荷',content:<button disabled={structureLocked||!indices.length} onClick={()=>legacy({type:'change-charge',atomIds:workingSelection.atomIds,charge})}>设电荷</button>},
    {id:'bond.set',label:'成键',content:<button disabled={bondLocked||indices.length!==2} onClick={()=>execute({type:'set-bond-order',atomIds:workingSelection.atomIds as [string,string],order:bondOrder})}>成键</button>},
    {id:'bond.break',label:'断键留端',content:<button data-testid="model-break-bond" disabled={bondLocked||workingSelection.bonds.length!==1} onClick={()=>{const bond=workingSelection.bonds[0];if(bond)execute({type:'break-bond',atomIds:bond.atomIds,image:bond.image});}}>断键留端</button>},
    {id:'atom.addH',label:'加一个H',content:<button disabled={structureLocked||indices.length!==1} onClick={()=>execute({type:'add-single-hydrogen',atomId:workingSelection.atomIds[0]})}>加一个H</button>},
    {id:'select.freeze',label:'冻结选择',content:<button disabled={freezeLocked||!indices.length} onClick={()=>execute({type:'set-shared-atom-freeze',atomIds:workingSelection.atomIds,frozen:true})}>冻结选择</button>},
    {id:'select.unfreeze',label:'解冻选择',content:<button disabled={freezeLocked||!indices.length} onClick={()=>execute({type:'set-shared-atom-freeze',atomIds:workingSelection.atomIds,frozen:false})}>解冻选择</button>},
    {id:'elements',label:'元素与几何',content:<><fieldset disabled={structureLocked}><div className="model-tools model-element-tools">{['H','C','N','O','F','P','S','Cl','Br','I'].map(element=><button key={element} data-element={element} aria-pressed={interaction.element===element} onClick={()=>setElement(element)}>{element}</button>)}<button aria-expanded={periodicTable} onClick={()=>setPeriodicTable(value=>!value)}>周期表</button><output aria-label="当前元素" data-testid="model-current-element">{interaction.element??'—'}</output></div>{periodicTable&&<ElementTable onSelect={element=>{setElement(element);setPeriodicTable(false);}}/>}<ElementPresetPalette selectionId={presetId} element={interaction.element??undefined} onChange={chooseElementPreset}/></fieldset></>},
    {id:'selection',label:'原子编号',content:<div className="model-tools model-number-tools"><label>编号<input aria-label="已选原子编号" data-testid="builder-selection-input" value={selectionInput} onChange={event=>setSelectionInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();selectNumbers();}}} placeholder="1-5,8"/></label><button onClick={selectNumbers}>选择编号</button><span>{indices.length}/{atoms.length}</span></div>},
    {id:'measurement',label:'测量顺序',content:<output data-testid="model-measurement-ids" className="model-blue-measurement-ids">{measurement.atomIds.map(id=>atoms.findIndex(atom=>atom.id===id)+1).join(' → ')||'按顺序点选原子；空白清测量'}</output>},
    {id:'dynamics',label:'动态',essential:true,content:props.realtime?<DynamicsPanel {...electronicFieldProps} controller={dynamics} documentKey={model.id} periodic={periodicModel} electronicState={xtbElectronic} onElectronicStateChange={changeXtbElectronic} beforeStart={prepareDynamicsStart} onStartFailure={()=>store.clearScientificEditApproval?.()} disabled={partialPeriodicBox||!atoms.length||busy||geometryEditing||runtimeElectronicInvalid||xtbState.running}/>:<span>实时工作台可使用动态观察</span>,criticalContent:<button data-testid="model-critical-stop" disabled={!structureLocked} onClick={()=>void stopActiveOptimization()}>Stop / 停止</button>},
    {id:'bonds',label:'原子与键参数',content:<fieldset disabled={bondLocked}><div className="model-tools"><label>电荷<NumericInput disabled={structureLocked} aria-label="原子形式电荷" stepper value={charge} onChange={event=>setCharge(Number(event.target.value))}/></label><label>键<select aria-label="建模键级" value={bondOrder} onChange={event=>setBondOrder(Number(event.target.value) as BondOrder)}>{[1,2,3,1.5,.5].map(value=><option value={value} key={value}>{value}</option>)}</select></label><label>识别<select aria-label="成键识别强度" value={aggression} onChange={event=>setAggression(event.target.value as BondAggression)}><option value="conservative">保守</option><option value="standard">标准</option><option value="aggressive">积极</option></select></label></div></fieldset>},
    {id:'geometry',label:'几何与变换',content:<div><GeometrySmartSlide bondEditingDisabled={bondLocked} {...measurementBondControls()} measurementImages={activeMeasurement?.mode==='distance'?activeMeasurement.images:undefined} structure={editingStructure} measurementAtomIds={measurement.atomIds} selectedAtomIds={workingSelection.atomIds} fixedAtomIds={getFrozenAtomIds(model)} onScopeChange={value=>{geometryScope.current=value;}} disabled={structureLocked||busy} onBegin={()=>beginManualGeometry(undefined)} onPreview={previewManualGeometry} onCommit={commitManualGeometry} onCancel={cancelManualGeometry} onError={setError}/><fieldset disabled={structureLocked}><details className="model-secondary"><summary>选择变换</summary><div className="model-tools"><select aria-label="变换轴" value={axis} onChange={event=>setAxis(event.target.value as typeof axis)}>{['x','y','z'].map(value=><option key={value}>{value}</option>)}</select><NumericInput aria-label="旋转角度" value={degrees} onChange={event=>setDegrees(event.target.value)}/><button disabled={!indices.length} onClick={()=>legacy({type:'rotate',atomIds:workingSelection.atomIds,axis,degrees:Number(degrees)})}>旋转选择</button><button disabled={!indices.length} onClick={()=>legacy({type:'reflect',atomIds:workingSelection.atomIds,axis})}>镜像</button><button disabled={indices.length!==1} onClick={()=>legacy({type:'invert-center',atomId:workingSelection.atomIds[0]})}>反转中心</button>{['x','y','z'].map((name,index)=><label key={name}>{name}<NumericInput aria-label={'平移 '+name} step=".1" value={translation[index]} onChange={event=>setTranslation(translation.map((value,i)=>index===i?Number(event.target.value):value) as Vector3)}/></label>)}<button data-testid="builder-translate" disabled={!indices.length} onClick={()=>execute({type:'transform-fragment',atomIds:workingSelection.atomIds,delta:translation})}>平移选择</button></div></details></fieldset></div>},
  ];
  const oldTool=(id:string)=>toolActions.find(item=>item.id===id)?.content;

  const surfaceActions:WorkbenchToolAction[]=[...toolActions,
    ...([['functional','官能团'],['ring','环'],['chain','链段']] as const).map(([category,label])=>({id:`fragment.${category}`,label,kind:'action' as const,content:<FragmentLibrary category={category} selectedId={template} onSelect={chooseFragment} pointerMode disabled={structureLocked} canAttach={!periodic||indices.length>0} canReplace={indices.length>0} canIndependent={!periodic} onAction={id=>chooseFragment(id)}/>})),
    {id:'select.bond',label:'键选',content:<BondSelectionControls controls={selectionTools} showRange={false}/>},
    {id:'selection.numbers',label:'被选择的原子',lockedSpan:4,content:<><AtomSelectionControls controls={selectionTools}/><BondSelectionControls controls={selectionTools} showButton={false}/></>},
    {id:'fragment.copied',label:'个人片段库',tooltip:'浏览个人片段并复用结构预览',content:<button data-testid="model-personal-fragments" disabled={structureLocked} aria-pressed={personalFragmentsOpen} onClick={()=>setPersonalFragmentsOpen(value=>!value)}><Library size={17} aria-hidden="true"/>个人片段库</button>},
    {id:'structure.preview',label:'结构预览',lockedSpan:4,content:<ActiveStructurePreview display={display} height={workbenchLayout.layout.paneSizes.activePreviewHeight??220} onHeightChange={height=>workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,activePreviewHeight:height}})} preview={activePreview.model} activeAtomIndex={previewActiveIndex} onActiveAtomChange={choosePreviewAtom} disabled={structureLocked} error={activePreview.error}><button disabled={structureLocked||!activePreview.model} onClick={()=>{if(!personalFragmentsAPI){setError('个人片段持久化仅桌面版可用。');return;}setPersonalFragmentSaveRequest(value=>value+1);}}>保存为个人片段</button></ActiveStructurePreview>},
    {id:'freeze.tools',label:'冻结',lockedSpan:4,content:<div className="model-freeze-tools" role="group" aria-label="冻结工具">{([['box','框选'],['point','点选']] as const).map(([tool,label])=><span key={tool} className="model-shortcut-button"><button disabled={freezeLocked} aria-pressed={freezeTool===tool} title={tool==='box'?'框选冻结；右键框选解冻':'点选冻结；右键解冻'} onClick={()=>applyToolIntent({type:'freeze',tool:freezeTool===tool?null:tool})}><Snowflake size={13} aria-hidden="true"/>{label}</button>{tool==='box'&&<HoldKeyCorner kind="freeze" value={shortcuts.bindings.freeze} writable={shortcuts.writable} save={shortcuts.save}/>}</span>)}<button disabled={freezeLocked} title="仅清空建模共有冻结，保留输入任务冻结" onClick={()=>execute({type:'clear-shared-freezes'})}><Snowflake size={13} aria-hidden="true"/>清冻结</button></div>},
    {id:'edit.add-h',label:'加H',tooltip:'切换鼠标工具，点击一个原子加一个H',content:<button data-testid="model-tool-add-h" disabled={structureLocked} aria-pressed={persistentTool==='hydrogen'} onClick={()=>choosePersistentTool('hydrogen')}>加H</button>},
    {id:'edit.delete',label:'删除',tooltip:'切换鼠标工具，点击删除单个对象；空白不删除',content:<button data-testid="model-tool-delete" disabled={structureLocked} aria-pressed={persistentTool==='delete'} onClick={()=>choosePersistentTool('delete')}>删除</button>},
    {id:'bond.perceive',label:'判断成键',tooltip:'按所选方法重新判断全部化学键，可增删连接和修正键级',content:<BondPerceptionControls method={bondPerceptionMethod} solvent={bondPerceptionSolvent} onSolventChange={setBondPerceptionSolvent} periodic={periodicModel} periodicGfn2Available={periodicGfn2Available} parameters={empiricalParameters} elements={atoms.map(atom=>atom.element)} disabled={structureLocked||partialPeriodicBox||busy||optimizationBusy||geometryEditing||!atoms.length||props.active===false} onMethodChange={setBondPerceptionMethod} onPerceive={parameters=>void perceiveBonds(parameters)}/>},
    {id:'bond.display',label:'显示成键',content:<button type="button" data-testid="model-show-bonds" onClick={()=>changeDisplay({...display,showBonds:display.showBonds===false})}>{display.showBonds===false?'显示成键':'不显示成键'}</button>},

    {id:'preopt',label:'预优化 / Space',lockedSpan:4,content:
      <XtbOptimizationPanel {...(derivedOptimization?{electronicDisabled:true}:electronicFieldProps)}
        {...preoptimizationElectronic} onElectronicStateChange={changeXtbElectronic}
        documentKey={model.id} periodic={periodicModel} method={optimizationMethod} scope={optimizationPreferences.scope}
        onMethodChange={method=>updateOptimizationPreferences(selectWorkspaceOptimizationMethod(optimizationPreferences,periodicModel,method))}
        onScopeChange={scope=>updateOptimizationPreferences({...optimizationPreferences,scope})}
        solvation={xtbSettings.solvation} onSolvationChange={solvation=>updateOptimizationPreferences({...optimizationPreferences,xtb:{...optimizationPreferences.xtb,solvation}},true)}
        rebuildBonds={savedRuntimeSettings.rebuildBonds===true} onRebuildBondsChange={rebuildBonds=>{
          updateOptimizationPreferences({...optimizationPreferences,xtb:{...optimizationPreferences.xtb,rebuildBonds}});
        }}
        runtimeSettings={runtimeSettings} onRuntimeSettingsChange={updateRunSettings} canOptimize={canOptimize}
        xtbSingleTaskThreads={xtbSingleTaskThreads} onXtbSingleTaskThreadsChange={value=>
          setResourceOverride(value===undefined?undefined:{documentId:model.id,xtbSingleTaskThreads:value})}
        requireMultiplicity={!periodicModel&&bondPerceptionMethod==='gfn2'} selectionCount={indices.length} atomCount={atoms.length}
        disabled={ordinaryDisabled} running={optimizationRunning} status={preoptimizationStatus} error={preoptimizationError}
        outcomeIdentity={local?.identity??linked?.request.id}
        metadata={legacyOptimization?xtbState.metadata:undefined} atomLabels={Object.fromEntries(atoms.map((atom,index)=>[atom.id,index+1]))}
        ordinaryEvidence={ordinaryConstraints} onOptimize={()=>spaceOptimize()} onStop={stopActiveOptimization}
        footer={xtbState.canContinue&&!optimizationRunning&&<>{continuationBackendBlocked&&<GxtbAvailability method={xtbState.continuationMethod??''}/>}
          <button type="button" className="shared-input-action" disabled={ordinaryDisabled||continuationBackendBlocked} onClick={continueLegacyOptimization}>继续优化</button></>}
      />},

  ];
  const modelSettings=<>
        <ElementColorControls atoms={atoms} display={display} onChange={changeDisplay}/>
        <DisplayPresetControls snapshot={displayDefaults} busy={displayDefaultsBusy} status={displayDefaultsStatus} error={displayDefaultsError} onSave={()=>void persistDisplayDefaults()} onRestore={()=>void persistDisplayDefaults(true)}/>
        {model.draft.structure.cell&&<label><input type="checkbox" aria-label="保存包含晶胞" checked={withCell} onChange={event=>setWithCell(event.target.checked)}/>保存包含晶胞</label>}
      </>;
  async function captureCurrentViewport(options:ViewportImageExportOptions,ownerDocument:Document,signal:AbortSignal):Promise<Blob>{
    const canvas=props.analysisCanvas,node=stageRef.current?.querySelector('.model-transform-candidate .model-viewport-stage'),box=node?.getBoundingClientRect();
    if(!node||!box||box.width<=0||box.height<=0)throw Error('当前视口不可见，未复制其他对象的画布。');
    const actual={...options,legend:captureViewportLegend(node,viewportModel.id),viewportWidth:box.width,viewportHeight:box.height,measurement:structuredClone(measurement)};
    if(canvas&&!canvas.useWorkspaceImageExport){if(!canvas.onCaptureImage)throw Error('当前分析尚未提供完整图像捕获。');return canvas.onCaptureImage(actual,ownerDocument,signal);}
    const view=viewportGetter.current?.()??cameraView;if(!view)throw Error('当前视角尚未就绪。');
    const v=canvas?.viewport??structureAnalysis.viewport;
    const snapshot:OffscreenCaptureSnapshot={document:viewportModel,displayAtoms:presentedVibrationAtoms(v.displayAtoms),cipStructure:v.cipStructure,displayFrozenAtomIds,
      cameraView:[...view],display:viewportImageDisplay(viewportDisplay,node as HTMLElement),showAxes,width:1600,height:1200,viewportWidth:box.width,viewportHeight:box.height,measurement,
      cellGuides,previewGuides,previewCell,highlights:advancedObservation?undefined:highlights,linkedAtomsActive:props.linkedAtomsActive,stateMarkers,
      multiframeDisplay:v.multiframeDisplay,fixedCellView:v.fixedCellView,samplingSphere:viewportSamplingSphere(viewportModel,props.samplingSphereDraft,v.samplingSphere),calculationRanges:v.calculationRanges,
      viewTransform:v.viewTransform??props.initialViewTransform??mdObservationTransform,hiddenAtomIds:v.hiddenAtomIds,
      vibrationVectors:v.vibrationVectors,atomScalarValues:v.atomScalarValues,atomScalarColor:v.atomScalarColor,atomScalarLabels:v.atomScalarLabels,
      orbitalLayer:v.orbitalLayer,ntoLayer:v.ntoLayer,dipoleVector:v.dipoleVector,surfaceLayer:v.surfaceLayer,surfaceLayers:v.surfaceLayers,surfaceExtrema:v.surfaceExtrema,
      resultAtomLabels:v.resultAtomLabels,resultBondValues:v.resultBondValues,resultBondLabels:v.resultBondLabels,resultBondColor:v.resultBondColor,
      resultHighlights:v.resultHighlights,resultColorbar:v.resultColorbar};
    return exportViewportImage(snapshot,actual,ownerDocument,signal);
  }
  async function exportCurrentViewport(options:ViewportImageExportOptions,ownerDocument:Document){
    if(imageExportAbort.current)return;
    const controller=new AbortController(),name=viewportModel.draft.structure.name||'Ester-Studio';imageExportAbort.current=controller;setImageExporting(true);
    try{const blob=await captureCurrentViewport(options,ownerDocument,controller.signal);if(!controller.signal.aborted)exportBlob(blob,name+'.'+options.format,ownerDocument);}
    catch(cause){if(!controller.signal.aborted)setError(message(cause));}
    finally{if(imageExportAbort.current===controller)imageExportAbort.current=null;setImageExporting(false);}
  }
  const viewportImageCapture = useRef<WorkspaceViewportImageCapture | null>(null);
  useLayoutEffect(() => {
    viewportImageCapture.current = async (options, signal) => {
      const node = stageRef.current;
      const canvas = props.analysisCanvas;
      if (!node?.isConnected || props.active === false || canvas?.scientificFrameReady === false) {
        throw new Error('当前窗口的视口尚未准备好。');
      }
      const result = canvas?.result;
      const provenance = { modelId: model.id, modelRevision: model.revision, ...(result && {
        resultId: result.id, sourceId: result.source.id, sourceSha256: result.source.sha256,
        jobIndex: result.jobIndex, frameIndex: canvas?.frameIndex, sourceRevision: canvas?.sourceRevision,
      }) };
      return { blob: await captureCurrentViewport(options, node.ownerDocument, signal), provenance };
    };
  });
  useLayoutEffect(() => {
    if (!props.onViewportImageCapture || props.active === false) return;
    const capture: WorkspaceViewportImageCapture = (options, signal) => {
      if (!viewportImageCapture.current) throw new Error('当前窗口的视口尚未准备好。');
      return viewportImageCapture.current(options, signal);
    };
    props.onViewportImageCapture(capture);
    return () => props.onViewportImageCapture?.(null);
  }, [props.onViewportImageCapture, props.active]);
  const readonlyStructureExport=readonlyPesStructureExportReady(props.analysisCanvas,props.active!==false);
  const structureExportAvailable=atoms.length>0&&(!props.observationOnly||!props.analysisCanvas?.pesConstraints||readonlyStructureExport);
  const structureExportPending=saveBusy||saveModal||Boolean(saveState);
  const header=<ModelWorkspaceToolbar display={display} onDisplayChange={changeDisplay} onActivate={props.onActivate} readOnly={structureLocked} historyReadOnly={historyLocked} readOnlySaveAllowed={readonlyStructureExport}
    onOpenSettings={props.onOpenSettings} atoms={atoms} targetLabel={props.documentName??model.draft.structure.name} hasCell={!!model.draft.structure.cell} showAxes={showAxes} onShowAxesChange={value=>{if(props.onSharedShowAxesChange)props.onSharedShowAxesChange(value);else setLocalShowAxes(value);}}
    onNew={props.onNewDocument?undefined:newModel} onImport={()=>window.sciyueDesktop?void importFiles():fileInput.current?.click()} onOpenStructureLibrary={props.onOpenStructureLibrary} onSave={()=>void save()} onOpen2D={()=>{if(props.onOpenTwoD){if(structureEditAllowed())props.onOpenTwoD();}else{setPlaneRetained(true);setPlane(true);}}} onUndo={()=>history('undo')} onRedo={()=>history('redo')}
    disabled={{new:structureLocked&&!props.onNewDocument,import:structureLocked&&!props.onImportFiles,save:!structureExportAvailable||structureExportPending,open2D:structureLocked||periodic,undo:!(frameBondHistory?.canUndo??props.workspaceCanUndo??model.canUndo)||historyLocked&&store.getHistoryKind?.('undo')!=='selection',redo:!(frameBondHistory?.canRedo??props.workspaceCanRedo??model.canRedo)||historyLocked&&store.getHistoryKind?.('redo')!=='selection'}}
    layoutActions={props.layoutActions} settingsContent={modelSettings}
    imageExport={<ViewportImageExportMenu openRequest={imageExportOpenRequest} getViewportSize={()=>{const box=stageRef.current?.querySelector('.model-transform-candidate .model-viewport-stage')?.getBoundingClientRect();return box?{width:box.width,height:box.height}:undefined;}} disabled={!viewportModel.draft.structure.atoms.length||props.analysisCanvas?.exportAvailable===false} exporting={imageExporting||props.analysisCanvas?.exporting} onExport={exportCurrentViewport} onCapture={captureCurrentViewport} captureKey={props.active===false?null:JSON.stringify([model.id,props.analysisCanvas?.sourceRevision])}/>}
    actions={props.analysisCanvas?.toolbarActions}
    view={{showAxes,hasAtoms:!!atoms.length,hasCell:Boolean(model.draft.structure.cell),showCell:display.cell,onCamera:requestCamera,onReset:()=>setResetViewRequest(value=>value+1),onToggleAxes:toggleAxes,onToggleCell:()=>changeDisplay({...display,cell:!display.cell})}}/>;
  useEffect(()=>{
    if(props.active===false)return;
    const bridge=window.sciyueDesktop;
    void bridge?.updateWorkbenchFileState?.({canImport:!structureLocked||!!props.onImportFiles,canExportStructure:structureExportAvailable&&!structureExportPending,canExportImage:viewportModel.draft.structure.atoms.length>0&&props.analysisCanvas?.exportAvailable!==false&&!imageExporting}).catch(()=>{});
  },[props.active,props.onImportFiles,structureLocked,structureExportAvailable,structureExportPending,viewportModel.draft.structure.atoms.length,props.analysisCanvas?.exportAvailable,imageExporting]);
  const personalLibrary=personalFragmentsAPI?<PersonalFragmentLibrary api={personalFragmentsAPI} catalogIdentity={personalBridge} popup active={props.active!==false} open={personalFragmentsOpen} viewState={{filter:toolIntent.personalLibraryFilter,selectedId:toolIntent.personalLibrarySelectedId}} onViewStateChange={view=>{if(latest.current.props.active!==false)patchToolIntent({personalLibraryFilter:view.filter,personalLibrarySelectedId:view.selectedId});}} onClose={()=>setPersonalFragmentsOpen(false)} saveRequest={personalFragmentSaveRequest} saveRequestOwner={model.id} capture={activePreview.model?capturePersonalFragment:undefined} onChoose={choosePersonalFragment} disabled={structureLocked||busy||props.active===false}
    importLibrary={personalBridge?.importPersonalFragments?async()=>{const guard=personalFragmentGuard();guard();const value=await personalBridge.importPersonalFragments!();guard();return value;}:undefined}
    exportLibrary={personalBridge?.exportPersonalFragments?async library=>{const guard=personalFragmentGuard();guard();const value=await personalBridge.exportPersonalFragments!(library);guard();return value;}:undefined}/>:personalFragmentsOpen?<p role="status">个人片段持久化仅桌面版可用。</p>:null;
  const tools=<aside className="model-tool-rail" data-testid="model-tool-rail">
    {personalLibrary}
    <ToolbarGrid actions={surfaceActions} items={workbenchLayout.layout.items} editMode={workbenchLayout.editMode} onRequestEdit={()=>workbenchLayout.setEditMode(true)} onChange={items=>workbenchLayout.updateLayout({...workbenchLayout.layout,items})}/>
  </aside>;
  const changeTransformRoute=(route:AdvancedModelingRoute)=>{referenceCapture.cancel();props.onAdvancedModelingRouteChange?.(route);};
  const closeTransformTask=(task:string)=>{
    const route=props.advancedModelingRoute;if(!route)return;
    const remaining=transformSession.expanded[route.category].filter(id=>id!==task);
    updateTransformSession(value=>({...value,expanded:{...value.expanded,[route.category]:remaining}}));
    changeTransformRoute({...route,task:(remaining.at(-1)??null) as never});
  };
  const transformDisabled=baseStructureLocked||props.analysisCanvas?.modelEditingBlocked===true||busy||optimizationBusy||props.active===false;
  const ownsTransform=(category:string,task:string)=>latest.current.props.active!==false&&latest.current.props.advancedModelingRoute?.category===category&&latest.current.props.advancedModelingRoute.task===task;
  const renderTransformTask=(task:PeriodicModelingTask|GeometryTransformTask,active:boolean)=>{
    const category=props.advancedModelingRoute?.category;if(!category)return null;
    const key=`${category}:${task}`;
    const transformDocument=props.analysisCanvas?.staticDocument&&scientificCanvasStructure(props.analysisCanvas)?captureScientificModelDocument(model,props.analysisCanvas,{allowAnimation:true,selection:workingSelection}):model;
    const common={document:transformDocument,open:true,embedded:true,previewActive:active,previewLive:transformSession.live[key]??true,
      onPreviewLiveChange:(enabled:boolean)=>updateTransformSession(value=>({...value,live:{...value.live,[key]:enabled}})),
      disabled:transformDisabled,onPrepare:prepareTransform,onApply:async(candidate:StructureTransformCandidate)=>{await applyTransform(candidate);},
      onPreviewChange:(candidate:StructureTransformCandidate|null)=>{if(ownsTransform(category,task)&&candidate===null)setStructurePreview(null);},
      onPreviewPresentationChange:(presentation:TransformPreviewPresentation|null)=>{if(ownsTransform(category,task)){setTransformPresentation(presentation);setStructurePreview(presentation?.candidate??null);}},
      onClose:()=>closeTransformTask(task)};
    if(category==='periodic')return <PeriodicModelingPanel key={key} {...common} operation={task as PeriodicModelingTask}
      draft={(transformSession.drafts[key] as PeriodicModelingDraft|undefined)??initialPeriodicModelingDraft(transformDocument.draft.structure)}
      onDraftChange={draft=>updateTransformSession(value=>({...value,drafts:{...value.drafts,[key]:draft}}))}
      cellEditorDraft={transformSession.cell} onCellEditorDraftChange={cell=>updateTransformSession(value=>({...value,cell}))}
      previewResult={active?crystalPreviewResult:null} onInspect={inspectCrystal} onPrepareCell={prepareCell} onCommitEdit={commitCellEdit}
      onSaveCheckpoint={()=>{try{store.execute({type:'save-cell-checkpoint'});setError('');}catch(cause){setError(message(cause));}}}
      onRestoreCheckpoint={()=>{execute({type:'restore-cell-checkpoint'});}}
      onAtomHighlightChange={ids=>{if(ownsTransform(category,task))setTransformHighlightIds(ids);}}
      onCellEditorChange={draft=>{if(draft===null){setCellEditorDraft(current=>current?.documentId===model.id&&current.expectedRevision===model.revision?null:current);}else if(task==='cell-editor'&&ownsTransform(category,task))setCellEditorDraft(draft);}}/>;
    return <GeometryTransformPanel key={key} {...common} operation={task as GeometryTransformTask} selectionPort={referenceCapture.selectionPort}
      draft={(transformSession.drafts[key] as GeometryTransformDraft|undefined)??newGeometryDraft(task as GeometryTransformTask)}
      onDraftChange={draft=>updateTransformSession(value=>({...value,drafts:{...value.drafts,[key]:draft}}))}/>;
  };
  const structureToolPanel=props.advancedModelingRoute!==undefined?<AdvancedModelingNavigation route={props.advancedModelingRoute}
    onChange={changeTransformRoute} disabled={transformDisabled} hasCell={Boolean(model.draft.structure.cell)}
    expandedTasks={props.advancedModelingRoute?transformSession.expanded[props.advancedModelingRoute.category]:[]}
    onExpandedTasksChange={tasks=>{const category=props.advancedModelingRoute?.category;if(category)updateTransformSession(value=>({...value,expanded:{...value.expanded,[category]:tasks}}));}}
    onWrap={()=>{void prepareTransform({type:'wrap'}).then(applyTransform).catch(cause=>setError(message(cause)));}}
    onDeleteCell={()=>{execute({type:'remove-cell'});}} renderTask={renderTransformTask}/>:null;
  const sharedTools=structureAnalysisOpen?structureAnalysis.controls:tools;
  useLayoutEffect(()=>()=>props.onModelToolsChange?.(null),[props.onModelToolsChange,model.id,props.active]);
  useLayoutEffect(()=>{const publish=props.onLeftToolSurfaceChange;return()=>publish?.(null);},[model.id,props.active,props.workspaceModule,props.advancedModelingRoute?.category,props.advancedModelingRoute?.task]);
  useLayoutEffect(()=>{
    if(props.active!==false){
      props.onModelToolsChange?.(tools);
      props.onToolSurfaceChange?.(props.onModelToolsChange&&!structureAnalysisOpen?null:sharedTools);
      props.onLeftToolSurfaceChange?.(structureToolPanel);
    }
    if(presentationActive)props.onToolbarSurfaceChange?.(header);
  });
  function workspaceOverlay(content:ReactNode){
    if(props.sharedLayout&&props.active===false)return null;
    const body=scope.current?.ownerDocument.body??(typeof document==='undefined'?null:document.body);
    return props.sharedLayout&&body?createPortal(<div className="model-workspace-floating-content" data-document-id={model.id}>{content}</div>,body):content;
  }
  return <section ref={scope} tabIndex={0} className="model-workspace builder-workspace" data-testid="builder-workspace" data-tool-portal={Boolean(props.toolHost)} data-shared-layout={Boolean(props.sharedLayout)} data-structure-locked={structureLocked} data-periodic={periodic} data-capture-kind={props.captureRequest?.kind??''} data-capture-purpose={props.captureRequest?.purpose??''} aria-label="桌面建模工作区" onPointerDownCapture={event=>{props.onActivate?.();if(!editableTarget(event.target))event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();if(scope.current?.contains(event.target as Node)&&!editableTarget(event.target)&&!(event.target instanceof Element&&event.target.closest('button,[data-layout-editing="true"],[data-workbench-layout-control]')))scope.current.focus({preventScroll:true});}}>
    {!props.onToolbarSurfaceChange&&(props.sharedLayout?(presentationActive&&props.toolbarHost?createPortal(header,props.toolbarHost):null):header)}
    <StructureSourceNotice structure={viewportModel.draft.structure}/>
    <input hidden ref={fileInput} type="file" multiple onChange={event=>{void importFiles(event.target.files);event.target.value='';}}/>
    {!props.onLeftToolSurfaceChange&&structureToolPanel&&workspaceOverlay(structureToolPanel)}
    {bondElectronicPrompt&&workspaceOverlay(<DialogSurface aria-label="GFN2电子态确认" className="model-inline-dialog model-bond-electronic-dialog" onCancel={()=>setBondElectronicPrompt(null)}><strong>GFN2 成键判断</strong><label>电荷{electronicStateIntegerInput({text:bondElectronicPrompt.charge,field:"charge",label:"GFN2电荷",onChange:charge=>setBondElectronicPrompt({...bondElectronicPrompt,charge,lastEditedField:'charge',pairingIssue:null}),onCommit:charge=>setBondElectronicPrompt(current=>current?pairBondPrompt({...current,charge},'charge'):null)})}</label><label>多重度{electronicStateIntegerInput({text:bondElectronicPrompt.multiplicity,field:"multiplicity",label:"GFN2多重度",onChange:multiplicity=>setBondElectronicPrompt({...bondElectronicPrompt,multiplicity,lastEditedField:'multiplicity',pairingIssue:null}),onCommit:multiplicity=>setBondElectronicPrompt(current=>current?pairBondPrompt({...current,multiplicity},'multiplicity'):null)})}</label><ElectronicStateWarning message={bondElectronicPrompt.pairingIssue||(bondElectronicPrompt.charge.trim()&&bondElectronicPrompt.multiplicity.trim()?electronicStateWarning(atoms,Number(bondElectronicPrompt.charge),Number(bondElectronicPrompt.multiplicity)):null)}/><button onClick={()=>setBondElectronicPrompt(null)}>取消</button><button onClick={()=>{const pending=pairBondPrompt(bondElectronicPrompt),current=store.getSnapshot(),electronic={charge:Number(pending.charge),multiplicity:Number(pending.multiplicity)};if(current.id!==pending.documentId||current.revision!==pending.revision||!bondElectronicDraftCurrent(current,pending.context)){setBondElectronicPrompt(null);return;}const issue=!pending.charge.trim()||!pending.multiplicity.trim()?'请填写电荷和多重度。':electronicStateParameterError(electronic.charge,electronic.multiplicity);if(issue){setError(issue);return;}changeXtbElectronic(electronic);const confirmed=captureBondElectronicDraft(store.getSnapshot(),electronic);setBondElectronicConsent(confirmed);setBondElectronicPrompt(null);void perceiveBonds(undefined,confirmed);}}>确认并运行</button></DialogSurface>)}
    {(props.observationOnly||props.analysisCanvas?.trajectoryPlayback)&&props.analysisCanvas?.controls}
    {props.captureRequest&&<div className="model-capture-controls" data-testid="model-capture-controls"><strong>{props.captureRequest.kind==='atoms'?'选择原子':props.captureRequest.kind==='coordinate'?'选择内坐标 · 有序点选2–4个原子或已有B/A/D':`选择${props.captureRequest.kind==='B'?'键长':props.captureRequest.kind==='A'?'键角':'二面角'}`}</strong><output>{captureAtomIds.map(id=>atoms.findIndex(atom=>atom.id===id)+1).join(' → ')||`点选原子 · ${shortcuts.bindings.select.toUpperCase()}框选`}</output><button onClick={confirmCapture}>确定</button><button onClick={props.onCaptureCancel}>取消</button><button onClick={()=>updateCapture([])}>清空本次</button></div>}
    <div ref={stageRef} className="model-stage" data-testid="builder-3d-view" style={workbenchLayout.layout.paneSizes.canvasHeight?{height:workbenchLayout.layout.paneSizes.canvasHeight,flex:'0 0 auto'}:undefined} onPointerDownCapture={event=>{if(heldPointerKey.current&&event.target instanceof Element&&event.target.closest('[data-testid="model-interaction-surface"]'))heldPointerKey.current.used=true;}} onPointerMoveCapture={event=>{pointerInCanvas.current=event.target instanceof Element&&Boolean(event.target.closest('[data-testid="model-interaction-surface"]'));}} onPointerLeave={leaveCanvas}>
     <ViewportErrorBoundary resetKey={`${model.id}:${model.revision}:${props.advancedModelingRoute?.task ?? ''}`} onError={setError}><div className="model-transform-viewports" data-tiled={tiledTransform||undefined}>
{tiledTransform&&<section className="model-transform-source" aria-label="原晶体与切面预览"><span className="model-transform-view-label">原晶体 · 切割范围</span><button className="model-transform-link" type="button" aria-pressed={linkedSlabView} onClick={()=>setLinkedSlabView(value=>!value)}>联动视角</button><ModelViewport document={model} display={display} interaction={interaction} previewGuides={validTransformPresentation?.guides} cellGuides={{current:model.draft.structure.cell,checkpoint:model.cellCheckpoint?.structure.cell}} cellHover readOnly structureLocked active={props.viewportActive??props.active} observationTool="rotate" cameraView={sourceCameraView??cameraView} broadcastCameraDuringGesture onCameraViewChange={acceptSourceCameraView} onViewReady={getView=>{sourceViewportGetter.current=getView;if(getView)acceptSourceCameraView(sourceCameraView??cameraView??getView());}} onSelection={()=>{}} onCommand={()=>{}} onHover={()=>{}} onGestureStart={()=>{}} onGestureEnd={()=>{}} onError={setError} showAxes={showAxes} legendVisible={false}/></section>}
      <section className="model-transform-candidate" aria-label={tiledTransform?'切面与真空候选':'当前结构'}>
      {tiledTransform&&<span className="model-transform-view-label">切面与真空</span>}
      <ModelViewport onCipLabelsUsed={onCipLabelsUsed} sceneOwnerEpoch={(()=>{const lease=props.activationStamp?.();return lease?.documentId===model.id?lease.documentEpoch:undefined;})()} linkedAtomsActive={props.linkedAtomsActive} active={props.viewportActive??props.active} legendVisible={props.legendVisible} legendExpanded={props.legendExpanded} onLegendExpandedChange={props.onLegendExpandedChange} onLegendSurfaceChange={props.onLegendSurfaceChange?surface=>{if(presentationActive)props.onLegendSurfaceChange?.(surface);}:undefined} document={viewportModel} display={viewportDisplay} interaction={interaction} highlights={advancedObservation?undefined:highlights} bondOrderEntries={bondOrderEntries}
        previewGuides={previewGuides} previewCell={previewCell} cellGuides={cellGuides}
        cellHover broadcastCameraDuringGesture={tiledTransform}
        onAtomNumberPick={props.onAtomNumberPick}
        temporaryPointerMode={effectivePointerMode} freezeRemovalMode={props.freezeEditingAllowed!==false&&!temporaryPointerMode&&freezeTool==='remove'} effectiveFrozenAtomIds={effectiveFrozenAtomIds} stateMarkers={stateMarkers} onAtomStateChange={atomStateChange} onObjectStateChange={objectStateChange} onStateMarkerDelete={deleteStateMarker} onStateMarkerHover={marker=>{hoveredMarker.current=marker;}} onObjectDelete={deletePickedObject}
        getPointerMode={()=>pointerModeAtPress(heldPointerKey.current,freezeTool)}
        getDocument={()=>latest.current.props.observationOnly&&latest.current.props.analysisCanvas?.document?latest.current.props.analysisCanvas.document:latest.current.store.getSnapshot()}
        selectionShortcut={shortcuts.bindings.select.toUpperCase()}
        measurement={measurement} measurementEditorRecordId={geometryOpen&&geometryEditorLease?.store===store&&geometryEditorLease.documentId===model.id?geometryEditorLease.recordId:undefined} persistentTool={persistentTool} fragmentTool={{templateId:copiedTool?'复制片段':template,activeAtomIndex:copiedTool?copyActiveIndex:activeFragmentIndex}} captureRequest={props.captureRequest} captureAtomIds={captureAtomIds} onCapturePick={capturePick} onCaptureBox={updateCapture}
        viewTransform={props.initialViewTransform} {...props.analysisCanvas?.viewport} cipStructure={viewportCipStructure}
        samplingSphereDraft={viewportState.samplingSphereEditor} onSamplingSphereRadiusChange={props.onSamplingSphereRadiusChange}
        cameraRequest={cameraRequest} cameraView={cameraView} onCameraViewChange={acceptCandidateCameraView} onCameraZoomReady={controls=>{viewportZoom.current=controls;analysisCameraControls?.(controls);}} onViewReady={getView=>{viewportGetter.current=getView;props.analysisCanvas?.onViewReady(getView);if(getView)try{const inherited=initialCameraPending.current?props.initialCameraView:cameraView;initialCameraPending.current=false;acceptCameraView(inherited?[...inherited]:getView());}catch(cause){setError(message(cause));}}} showAxes={showAxes} onMeasurementRecordSelect={selectMeasurementRecord} onMeasurementRecordWheel={wheelMeasurementRecord} onMeasurementRecordHover={record=>{hoveredRecord.current=record;}} onMeasurementRecordDelete={deleteMeasurement}
        readOnly={props.observationOnly} readonlyDrawing={Boolean(frameBondEditing&&!bondLocked)} observationSelection={Boolean(frameBondEditing&&!bondLocked)} allowModelEditing={!structureLocked} freezeEditingAllowed={props.freezeEditingAllowed} editingDocument={props.analysisCanvas?.staticDocument?{...bondDocument,selection:workingSelection}:model} onBeginModelInteraction={()=>{if(!structureEditAllowed(true))throw new ScientificEditCancelledError();return props.analysisCanvas?.staticDocument?{...bondDocument,selection:workingSelection}:model;}} structureLocked={structureLocked} cellEditorDraft={validCellEditorDraft} observationTool={freezeTool==='box'?'box':observationTool} resetViewRequest={resetViewRequest} onMeasurementPick={pickCoordinateAtom} onMeasurementBondPick={pickCoordinateBond}
        observationReference={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationReference} observationEpoch={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationEpoch} observationFrame={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationFrame}
        observationTransform={mdObservationTransform} observationAnchorAtomIds={mdDisplayFrame?.nativeMD?.protectedAtomIds}
        onHover={pick=>{hover.current=pick;const current=latest.current.store.getSnapshot();hoverStamp.current={id:current.id,revision:current.revision};}}
        {...structureAnalysis.viewport} {...referenceCapture.viewportCapture?{analysisAtomCapture:referenceCapture.viewportCapture}: {}} {...periodicToolsOpen?{resultHighlights:{atomIds:transformHighlightIds.filter(id=>viewportModel.draft.structure.atoms.some(atom=>atom.id===id)),bondPairs:[]}}:{}} onGestureStart={startGesture} onGestureEnd={endGesture} onGestureCommand={commitFragmentGesture} fragmentCancelEpoch={fragmentCancelEpoch}
        displayFrozenAtomIds={displayFrozenAtomIds} onSelection={select} onCommand={copiedPlacement} onError={setError}/>
      </section>
     </div></ViewportErrorBoundary>
      {!structurePreview&&!props.captureRequest&&!referenceCapture.viewportCapture&&<CanvasClearToolbar containerRef={stageRef} disabled={structureLocked} selectionDisabled={structureLocked&&!observationKey} frozenDisabled={freezeLocked} onClearSelection={()=>{closeGeometryEditor();select(EMPTY_SELECTION);}} onClearFrozen={()=>execute({type:'clear-shared-freezes'})} onClearCoordinates={clearCoordinates}/>}
      {!props.onOpenTwoD&&planeRetained&&workspaceOverlay(<Suspense fallback={<div className="model-plane-window" role="status">正在载入二维编辑器…</div>}><TwoDSessionWorkspace file={localPlaneFile} visible={plane} captureGuard={capturePlaneGuard} onCommit={commitPlane} onClose={()=>setPlane(false)} onBusyChange={setBusy} onRuntime={()=>{}} chemistryPort={localPlanePort}
        onImportFiles={props.onImportTwoDFiles?async files=>{const opened=await props.onImportTwoDFiles!(files);if(opened)setPlane(false);return opened;}:undefined}/></Suspense>)}
      {geometryOpen&&activeMeasurement&&workspaceOverlay(<><GeometrySmartSlide bondEditingDisabled={bondLocked} {...measurementBondControls(activeMeasurement)} measurementImages={activeMeasurement.images} open recordId={activeMeasurement.id} initialPosition={{x:(stageRef.current?.getBoundingClientRect().left??0)+20,y:(stageRef.current?.getBoundingClientRect().top??0)+30}} structure={editingStructure} measurementAtomIds={activeMeasurement.atomIds} selectedAtomIds={workingSelection.atomIds} fixedAtomIds={getFrozenAtomIds(model)} onScopeChange={value=>{geometryScope.current=value;}} disabled={structureLocked||busy} onBegin={beginManualGeometry} onPreview={previewManualGeometry} onCommit={commitManualGeometry} onCancel={cancelManualGeometry} onClose={()=>closeGeometryEditor(geometryEditorLease)} onError={setError}/><div className="model-coordinate-actions"><button disabled={freezeLocked||busy} onClick={()=>freezeCoordinate(activeMeasurement)}>❄ 冻结此内坐标</button></div></>)}
    </div>
    <div role="separator" aria-label="建模画布高度" aria-orientation="horizontal" tabIndex={0} className="model-canvas-resize" data-testid="model-canvas-resize" onPointerDown={event=>{event.preventDefault();sizeGesture.current={pointerId:event.pointerId,startY:event.clientY,height:stageRef.current?.getBoundingClientRect().height??300};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const own=sizeGesture.current;if(!own||own.pointerId!==event.pointerId)return;const height=clampWorkbenchPaneSize('canvasHeight',own.height+event.clientY-own.startY);workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:height}});}} onPointerUp={event=>{if(sizeGesture.current?.pointerId===event.pointerId){sizeGesture.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}}} onPointerCancel={()=>{sizeGesture.current=null;}} onDoubleClick={()=>workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:0}})} onKeyDown={event=>{if(['ArrowUp','ArrowDown','Home'].includes(event.key)){event.preventDefault();const height=event.key==='Home'?0:clampWorkbenchPaneSize('canvasHeight',(stageRef.current?.getBoundingClientRect().height??300)+(event.key==='ArrowUp'?-20:20));workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:height}});}}}><span>⋯</span></div>
    {!props.onToolSurfaceChange&&(!props.sharedLayout||props.active!==false||structureAnalysisOpen)&&(props.toolHost?createPortal(sharedTools,props.toolHost):sharedTools)}
    <DismissibleNotice identity={`${model.id}:${errorNotice.revision}`} className="model-error">{error}</DismissibleNotice><DismissibleNotice identity={`${model.id}:${staleAssignments}`} className="model-error">{staleAssignments?'任务分区已变化，请取消草稿后重新编辑。':null}</DismissibleNotice>{model.draft.assignmentIssues.length>0&&<details><summary>分区需复核 · {model.draft.assignmentIssues.length}</summary>{model.draft.assignmentIssues.map((issue,index)=><p key={index}>{issue}</p>)}</details>}
    <DismissibleNotice identity={`${model.id}:${shortcuts.errorRevision}`} className="model-error">{shortcuts.error}</DismissibleNotice>
    {pasteConflict && workspaceOverlay(<DialogSurface aria-label="粘贴晶胞选择" className="model-inline-dialog" onCancel={()=>setPasteConflict(null)}><p>源与目标晶胞不同，选择本次粘贴的晶胞。</p>{([['keep-target', '保留目标晶胞'], ['use-source', '使用源晶胞'], ['omit', '移除晶胞']] as const).map(([cell, label]) => <button key={cell} onClick={() => pastePayload(pasteConflict, { cell })}>{label}</button>)}<button onClick={() => setPasteConflict(null)}>取消</button></DialogSurface>)}
    {importChoices.length > 0 && workspaceOverlay(<DialogSurface aria-label="选择导入结构" className="model-inline-dialog" onCancel={()=>setImportChoices([])}>{importChoices.map((item, index) => <button key={index} onClick={() => importModel(item)}>{item.structure.name}</button>)}<button onClick={() => setImportChoices([])}>取消</button></DialogSurface>)}
    {saveModal && workspaceOverlay(<DialogSurface aria-label="保存模型" className="model-inline-dialog" onCancel={()=>{saveModalGuard.current=null;saveModalSource.current=undefined;setSaveModal(false);}}><select aria-label="保存格式" value={saveFormat} onChange={event => setSaveFormat(event.target.value as ModelFormat)}>{getFormatDescriptors({...props,purpose:'structure'}).map(format => <option key={format.id} value={format.id}>{format.label}</option>)}</select><label><input type="checkbox" disabled={!saveModalSource.current?.draft.structure.cell} checked={saveModalWithCell} onChange={event => setSaveModalWithCell(event.target.checked)} />包含晶胞</label><button disabled={saveBusy} onClick={() => void writeExport(saveFormat,undefined,undefined,saveModalGuard.current??undefined)}>保存</button><button disabled={saveBusy} onClick={() => {saveModalGuard.current=null;saveModalSource.current=undefined;setSaveModal(false);}}>取消</button></DialogSurface>)}
    {saveState && workspaceOverlay(<SaveStateDialog key={`${saveState.snapshot.id}:${saveState.snapshot.revision}`} structure={saveState.snapshot.draft.structure} request={saveState.request} onCancel={() => setSaveState(null)} onConfirm={state => {
      try{saveState.assertCurrent();}catch(cause){setSaveState(null);setError(message(cause));return;}
      const current = latest.current.store.getSnapshot();
      if (current.id !== saveState.snapshot.id) { setSaveState(null); setError('结构导出所属文档已变化，请重新保存。'); return; }
      const pending = saveState; setSaveState(null); void writeExport(pending.format, pending.token, state,pending.assertCurrent,pending.snapshot,pending.withCell);
    }} />)}
    <footer className="model-workspace-actions"><span role="status">{status || (props.realtime?'模型已实时同步':'')}</span>{preparationPortNotice(model.draft.structure) && <span data-testid="model-port-preparation-status" role="status">{preparationPortNotice(model.draft.structure)}</span>}{!props.realtime&&<><button data-testid="builder-cancel" onClick={cancel}>取消草稿</button><button data-testid="builder-apply" className="model-primary" disabled={!model.draft.dirty || busy || staleAssignments || !atoms.length} onClick={apply}>应用结构</button></>}</footer>
    <output data-testid="builder-draft-state" className="model-test-state" aria-hidden="true">{draftDiagnostic+JSON.stringify({xtbPreview:shownXtbFrame??null,xtbPhase:xtbState.phase,xtbRunning:xtbState.running,xtbPreviewSkippedFrames:xtbState.previewSkippedFrames??0, bondOrderObservation:model.bondOrderObservation??null, documentId: model.id, electronicStateConfirmed:model.electronicStateConfirmed===true, selection: workingSelection, auxiliaryRelations: model.auxiliaryRelations, attachmentPorts:model.attachmentPorts??[],deletedBonds: model.deletedBonds, canUndo: model.canUndo, canRedo: model.canRedo, undoKind:store.getHistoryKind?.('undo'),redoKind:store.getHistoryKind?.('redo'),sharedConstraints:model.sharedConstraints, coordinateObjects:model.coordinateObjects, gaussianBoundCoordinates:model.gaussianBoundCoordinates, temporaryPointerMode, freezeTool, copiedTool, busy, display, measurement, measurementSession, persistentTool, captureAtomIds, structureLocked, element:interaction.element,presetId,optimizationBusy,previewKind:activePreview.model?.kind,previewKey:activePreview.model?.key,previewActiveAtomIndex:previewActiveIndex??activePreview.model?.defaultActiveAtomIndex }).slice(1)}</output>

  </section>;
}
