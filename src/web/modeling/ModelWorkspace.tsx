import NumericInput from '../NumericInput';
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
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ModelWorkspaceBaseProps } from './ModelWorkspaceProps';
import { builderApplyResult, type BuilderCommand } from '../../core/builder-draft';
import { createModelStore, getFrozenAtomIds, getMovableAtomIds, ModelConflictError } from '../../core/modeling';
import { effectiveModelCoordinates, modelConstraintSources, modelCoordinateKey } from '../../modeling/constraints';
import { clampWorkbenchPaneSize } from '../../modeling/workbench-layout';
import { coordinateAssociations, displayedCoordinateObjects, recordObject, sessionFromCoordinateObjects, isObservationCoordinateRecord, removeObservationCoordinate, type ObservationCoordinateOwnership } from './coordinate-objects';
import { selectionWithAtomState, type AtomStateAction, type ViewportStateMarker } from './viewport-overlays';
import { formatAtomSelection, parseAtomSelection } from '../../core/structures';
import { isPeriodic, canonicalPeriodicBond } from '../../core/periodic';
import { electronicStateError } from '../../core/elements';
import type { JobRequest, Structure, Vector3 } from '../../core/types';
import type { OrcaJobRequest, OrcaSettings } from '../../core/orca/types';
import type { BondAggression, BondOrder, ChemistryJob, ClipboardPayload, DisplaySettings, ForcefieldChoice, FragmentSnapshot, InteractionAction, ModelCommand, ModelDocument, MeasurementState, MeasurementRecord, SelectionCaptureRequest, SelectionCaptureResult, ModelFormat, ModelSelection, ModelStore, PastePolicy, PickResult } from '../../modeling/contracts';
import { DEFAULT_DISPLAY } from '../../modeling/contracts';
import { createChemistryPort } from '../../modeling/chemistry';
import { exportModel, getFormatDescriptors } from '../../modeling/platform/files';
import { importModelSources } from '../../modeling/platform/import-model';
import { readModelDisplayPreferences, restoreModelDisplayPreferences, writeModelDisplayPreferences } from '../../modeling/platform/display-preferences';
import { captureGaussianCoordinates } from '../../modeling/application/gaussian-bridge';
import { defaultPlacementCommand } from '../../modeling/application/default-placement';
import { assertOrcaForcefieldTargets, captureOrcaAssignments, captureOrcaCoordinates, getOrcaMovableAtomIds } from '../../modeling/application/orca-bridge';
import { createModelInteraction, elementForHoldTap } from './interaction';
import ModelViewport from './ModelViewport';
import ViewportErrorBoundary from './ViewportErrorBoundary';
import { type CellPresentationOptions } from '../../core/modeling/cell-presentation';
import {workspaceCurrentProtectionDocument} from './workspace-source-validity';
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
import DynamicsPanel, { displayedDynamicsFrame } from './DynamicsPanel';
import { emptyObservationView, updateObservationView } from './render/alignment';
import { preparationPortNotice } from './preparation-status';
import { DynamicsController, createStoreDynamicsDependencies } from '../../modeling/dynamics/controller';
import { createDynamicsPort } from '../../modeling/dynamics/port';
import ElementTable from './ElementTable';
import ChemistrySummary, { chemistryReceipt, type ChemistryReceipt } from './ChemistrySummary';
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
import { createOptimizationCoordinator, type OptimizationChoice, type OptimizationScope } from './optimization-coordinator';
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
import XtbOptimizationPanel, { xtbPanelSubmission, type XtbPanelOptions } from './XtbOptimizationPanel';
import BondPerceptionControls, { type BondPerceptionMethod } from './BondPerceptionControls';
import PeriodicModelingPanel, { initialPeriodicModelingDraft, type PeriodicModelingDraft, type PeriodicModelingRequest, type PeriodicInspectRequest, type PeriodicModelingTask } from './PeriodicModelingPanel';
import GeometryTransformPanel, { newGeometryDraft, type GeometryTransformDraft, type GeometryTransformTask } from './GeometryTransformPanel';
import AdvancedModelingNavigation, {type AdvancedModelingRoute} from './AdvancedModelingNavigation';
import type {TransformPreviewPresentation} from './structure-transform-panel';
import {useAnalysisAtomCapture} from '../results/useAnalysisAtomCapture';
import { prepareStructureTransform, type StructureTransformEdit } from '../../core/modeling/structure-transform';
import { mapStructureTransformDocument } from '../../core/modeling/structure-transform-document';
import type { StructureTransformCandidate } from '../../core/modeling/contracts';
import type { CrystalResult } from '../../modeling/crystal-contracts';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import ViewportImageExportMenu from './ViewportImageExportMenu';
import { exportViewportImage, exportBlob, type ViewportImageExportOptions } from '../results/export-image';
import { useStructureInteractionAnalysis } from '../results/useStructureInteractionAnalysis';
import {createTrustedViewportDisplayProjection,type ViewportDisplayProjection} from './viewport-display-channel';
import type {ModelViewportProps} from './ModelViewport';
import {useCurrentCipUsage} from './use-cip-usage';
import { transferSlabCameraView } from './slab-preview-presentation';
import { XtbController, type XtbOptions, type XtbState } from '../../modeling/xtb/controller';
import { nextXtbDisplayObservation, projectXtbPreview, xtbOptimizationDisplayStatus, type XtbDisplayObservation } from './xtb-preview';
import { getMDProtectionInfo } from '../../modeling/dynamics/md-methods';
import type { DynamicsConfig } from '../../modeling/dynamics/controller';
import type { DynamicsOperation } from '../../modeling/dynamics/contracts';
import { desktopBridge } from '../../modeling/platform/desktop';
import {trajectoryPlaybackEventCurrent,type WorkspaceViewportState,type WorkspaceViewportEvent,type WorkspaceViewportController} from './workspace-viewport';
import {bondPerceptionElectronicState,bondElectronicDraftCurrent,captureBondElectronicDraft,type BondElectronicDraft} from './bond-perception-electronic-state';
const TwoDEditorBridge=lazy(()=>import('./TwoDEditorBridge'));

export interface WorkspaceToolIntent extends Omit<ToolSessionState,'geometryOpen'> {personalFragmentsOpen:boolean;personalLibraryFilter:string;personalLibrarySelectedId:string|null;periodicTableOpen:boolean;bondOrder:BondOrder}
export interface ModelWorkspaceProps extends ModelWorkspaceBaseProps {
  derivedSupercellSource?: Structure;
  samplingSphereDraft?:SamplingSphereViewportDraft|null;
  onSamplingSphereRadiusChange?(change:SamplingSphereRadiusChange):void;
  inputFreezeDisplay?: InputFreezeDisplay;
  jobRequest?: JobRequest;
  orcaJobRequest?: OrcaJobRequest;
  store?: ModelStore;
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
  onSavedName?(name: string): void;
  onViewportState?(state: WorkspaceViewportState): void;
  onViewportController?(controller: WorkspaceViewportController | null): void;
  onXtbController?(controller: { runMcpXtb(calculation: 'singlepoint' | 'optimize', options: XtbOptions, timeoutSeconds?: number): Promise<XtbState> } | null): void;
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
  onLeftToolSurfaceChange?(surface:ReactNode):void;
  onToolbarSurfaceChange?(surface:ReactNode):void;
  linkedAtomActions?:ReactNode;
  onAtomNumberPick?(atomId:string):void;
  advancedModelingRoute?:AdvancedModelingRoute;
  onAdvancedModelingRouteChange?(route:AdvancedModelingRoute):void;
  onAdvancedModelingBack?():void;
  onDeriveStructure?(candidate:StructureTransformCandidate):void|Promise<void>;
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
export function observationModelSelection(selection:ModelSelection,structure:Structure):ModelSelection{
  const ids=new Set(structure.atoms.map(atom=>atom.id));return{...selection,atomIds:selection.atomIds.filter(id=>ids.has(id)),bonds:selection.bonds.filter(bond=>bond.atomIds.every(id=>ids.has(id))),auxiliaryIds:[],portIds:[],coordinateIds:[]};
}
export interface CellExportChoice { documentId:string; withCell:boolean }
/** Box export is a document choice, independent of the cell's visibility. */
export function modelCellExportDefault(document:Pick<ModelDocument,'id'|'draft'>,choice:CellExportChoice|null):boolean {
  return choice?.documentId===document.id?choice.withCell:Boolean(document.draft.structure.cell);
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

export default function ModelWorkspace(props: ModelWorkspaceProps) {
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
  const dynamics = useMemo(()=>new DynamicsController(createDynamicsPort(),createStoreDynamicsDependencies(store,{isolated:true})),[store]);
  const dynamicState=useSyncExternalStore(dynamics.subscribe,dynamics.getSnapshot,dynamics.getSnapshot);
  useEffect(()=>{props.onDynamicsController?.(dynamics);return()=>{props.onDynamicsController?.(null);};},[dynamics,props.onDynamicsController]);
  useEffect(()=>{dynamics.connect();return()=>dynamics.disconnect();},[dynamics]);
  const model = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const transformSourceSignature=JSON.stringify([model.id,model.draft.structure.atoms.map(atom=>[atom.id,atom.element,atom.x,atom.y,atom.z]),model.draft.structure.cell]);
  const priorTransformSource=useRef({id:model.id,signature:transformSourceSignature});
  useEffect(()=>{const previous=priorTransformSource.current;if(previous.signature===transformSourceSignature)return;priorTransformSource.current={id:model.id,signature:transformSourceSignature};const route=props.advancedModelingRoute,key=previous.id===model.id&&route?.task?`${route.category}:${route.task}`:undefined;updateTransformSession(value=>({...value,drafts:key&&value.drafts[key]?{[key]:value.drafts[key]}:{},cell:key==='periodic:cell-editor'?value.cell:undefined}));},[transformSourceSignature]);
  const observationKey=props.analysisCanvas?.document&&(props.observationOnly===true||Boolean(props.analysisCanvas.prepareModelEdit))?`${props.analysisCanvas.result?.id??model.id}:${props.analysisCanvas.frameIndex??0}`:null;
  const [observationSelection,setObservationSelection]=useState<{key:string;selection:ModelSelection}|null>(null);
  const editingStructure=props.analysisCanvas?.staticDocument?.draft.structure??model.draft.structure;
  const workingSelection=useMemo(()=>observationKey?(observationSelection?.key===observationKey?observationSelection.selection:observationModelSelection(model.selection,editingStructure)):model.selection,[observationKey,observationSelection,model.selection,editingStructure]);
  const latest = useRef({ store, props }); latest.current = { store, props };
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
  const measurement:MeasurementState={...transientMeasurement(visibleMeasurementSession),records:visibleMeasurementSession.records,activeRecordId:visibleMeasurementSession.activeRecordId};
  const [personalFragmentSaveRequest,setPersonalFragmentSaveRequest]=useState(0);
  const previewIntentEpoch=useRef(0);
  const activePreview=useMemo(()=>{try{return{model:workspaceToolPreview(previewSource),error:''};}catch(cause){return{model:null,error:message(cause)};}},[previewSource]);
  const copiedForPersonal=useRef<{payload:ClipboardPayload|null;activeIndex:number}>({payload:null,activeIndex:0});copiedForPersonal.current={payload:activePreview.model?.payload??null,activeIndex:previewActiveIndex??activePreview.model?.defaultActiveAtomIndex??0};
  const clipboardEpoch=useRef(0),clipboardChannel=useRef<BroadcastChannel|null>(null);
  const [geometryOpen,setGeometryOpen]=useState(false),[captureAtomIds,setCaptureAtomIds]=useState<string[]>([]),[localShowAxes,setLocalShowAxes]=useState(false);
  const showAxes=props.sharedShowAxes??localShowAxes;
  function toggleAxes(){if(latest.current.props.sharedShowAxes!==undefined)latest.current.props.onSharedShowAxesChange?.(!latest.current.props.sharedShowAxes);else setLocalShowAxes(value=>!value);}
  const captureMirror = useRef<{requestId:string;atomIds:string[];images?:Vector3[]}|null>(null);
  const [cameraRequest,setCameraRequest]=useState<{serial:number;kind:'standard'|'cell'|'step';preset?:'a'|'a*'|'b'|'b*'|'c'|'c*';direction?:'left'|'right'|'up'|'down'}>();
  const [cameraView,setCameraView]=useState<number[]|undefined>(()=>props.initialCameraView?[...props.initialCameraView]:undefined);
  const initialCameraPending=useRef(Boolean(props.initialCameraView));
  const viewportGetter=useRef<(()=>number[])|null>(null);
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
  const wheelGeometry=useRef<{recordId:string;baseline:Structure;value:number;timer:ReturnType<typeof setTimeout>|null}|null>(null);
  const geometryMoving=useRef<BalancedGeometryEdit['moving']>('branch');
  const geometryScope=useRef<Pick<BalancedGeometryEdit,'moving'|'sideModes'|'sideAtomIds'>>({moving:'branch',sideModes:{first:'branch',last:'branch'}});
  const [temporaryPointerMode,setTemporaryPointerMode]=useState<'select'|'freeze'|null>(null);
  const heldPointerKey=useRef<{key:string;mode:'select'|'freeze';used:boolean}|null>(null),heldLetters=useRef(new Set<string>());
  const keyEventRef=useRef<(event:KeyboardEvent,release:boolean,remote?:boolean)=>void>(()=>{});
  const viewportDispatch=useRef<(event:WorkspaceViewportEvent)=>void|Promise<void>>(()=>{});
  const viewportBusy=useRef<()=>boolean>(()=>false);
  const cancelInteractionRef=useRef<()=>void>(()=>{});
  const viewportController=useMemo<WorkspaceViewportController>(()=>({dispatch:event=>viewportDispatch.current(event),isBusy:()=>viewportBusy.current(),cancelInteraction:()=>cancelInteractionRef.current(),getCameraView:()=>viewportGetter.current?.()}),[]);
  const lastViewportState=useRef<{listener:ModelWorkspaceProps['onViewportState'];signature:string}|null>(null);
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
  const [bondElectronicPrompt,setBondElectronicPrompt]=useState<{documentId:string;revision:number;context:BondElectronicDraft;charge:string;multiplicity:string}|null>(null);
  const [selectionInput, setSelectionInput] = useState('');
  const [saveFormat, setSaveFormat] = useState<ModelFormat>('xyz'), [saveModal, setSaveModal] = useState(false);
  const [saveState, setSaveState] = useState<{ format: ModelFormat; token?: string; snapshot: ModelDocument; request: JobRequest | OrcaJobRequest; assertCurrent():void } | null>(null);
  const saveModalGuard = useRef<(()=>void)|null>(null), saveBusyRef=useRef(false), asyncAlive = useRef(true);
  const xtbContext = useRef<{ store: ModelStore; documentId: string; generation: number; lease?: WorkspaceActivationStamp; referenceStructure?: Structure } | null>(null);
  const mcpAutoConfirmConstraints = useRef(false);
  const xtb = useMemo(() => new XtbController({ store, bridge: desktopBridge(), chemistry: createChemistryPort(),allowWorkingEdits:true,
    confirmConstraints: () => mcpAutoConfirmConstraints.current || confirmSynchronousOperation('xTB原子冻结保持坐标不变；内坐标使用强约束势。仅接受键长偏差≤0.001 Å、键角/二面角偏差≤0.1°且收敛的结果，未达标保留原模型。是否继续？',scope.current?.ownerDocument),
    assertCurrent() {
      const context = xtbContext.current;
      if(!context)throw new Error('xTB运行缺少所属文档身份。');
      assertModelWorkspaceRuntimeOwner(context,{alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,assertRuntimeCurrent:latest.current.props.assertRuntimeCurrent,assertActivationIdentity:latest.current.props.assertActivationIdentity});
    },
  }), [store]);
  const xtbState = useSyncExternalStore(xtb.subscribe, xtb.getSnapshot, xtb.getSnapshot);
  useEffect(()=>{let alive=true;void desktopBridge()?.info().then(info=>{if(alive)setPeriodicGfn2Available(info.periodicGfn2BondOrders===true);}).catch(()=>{if(alive)setPeriodicGfn2Available(false);});return()=>{alive=false;};},[]);
  const xtbDisplayObservation=useRef<XtbDisplayObservation|undefined>(undefined);
  const xtbSourceDocument=xtb.getWorkingSourceDocument(),dynamicsSourceDocument=dynamics.getWorkingSourceDocument();
  const xtbFrameCurrent=xtbState.workingSource?.documentId===model.id&&(xtbState.workingSource.revision===model.revision||xtbState.running&&runtimePreviewSourceCurrent(xtbSourceDocument,model));
  const dynamicsFrameCurrent=dynamicState.workingSource?.documentId===model.id&&(dynamicState.workingSource.revision===model.revision||['starting','running','pausing','paused','stopping'].includes(dynamicState.status)&&runtimePreviewSourceCurrent(dynamicsSourceDocument,model));
  const shownDynamicsFrame=displayedDynamicsFrame(dynamicState);
  // Final adoption advances the Store revision. Refit that confirmed last
  // geometry once without allowing an old run to display over a later edit.
  const dynamicsDisplayFrameCurrent=dynamicsFrameCurrent||dynamicState.mode==='md'&&['stopped','completed','error'].includes(dynamicState.status)
    &&dynamicState.workingSource?.documentId===model.id&&!!shownDynamicsFrame
    &&graphFingerprint(model.draft.structure)===graphFingerprint(shownDynamicsFrame.structure)
    &&coordinatesFingerprint(model.draft.structure)===coordinatesFingerprint(shownDynamicsFrame.structure);
  const shownXtbFrame=(props.viewportActive??props.active)===false||!xtbFrameCurrent?undefined:xtbState.previewFrame;
  const validTransformPresentation=transformPresentation&&structurePreview===transformPresentation.candidate&&structurePreview.documentId===model.id&&structurePreview.expectedRevision===model.revision?transformPresentation:null;
  const tiledTransform=props.advancedModelingRoute?.category==='periodic'&&props.advancedModelingRoute.task==='slab'&&(transformSession.live['periodic:slab']??true)&&!referenceCapture.viewportCapture;
  const wasTiled=useRef(false);
  useLayoutEffect(()=>{if(tiledTransform===wasTiled.current)return;wasTiled.current=tiledTransform;if(tiledTransform){const view=viewportGetter.current?.()??cameraView;if(view)setSourceCameraView([...view]);}else{const view=sourceCameraView;if(view)acceptCameraView(view);}},[tiledTransform]);
  const viewportModel=useMemo(()=>{
    const xtbPreview=projectXtbPreview(model,shownXtbFrame,xtbSourceDocument);
    return workspaceLiveViewportDocument({model,observationOnly:props.observationOnly,canvasDocument:props.analysisCanvas?.document?{...model,...props.analysisCanvas.document,selection:workingSelection}:undefined,useWorkspaceImageExport:props.analysisCanvas?.useWorkspaceImageExport,
      structurePreview:!referenceCapture.viewportCapture&&structurePreview&&structurePreview.documentId===model.id&&structurePreview.expectedRevision===model.revision?{...model,draft:{...model.draft,structure:validTransformPresentation?.displaySource?validTransformPresentation.source:structurePreview.structure}}:undefined,
      runtimePreview:dynamicsFrameCurrent&&shownDynamicsFrame?{...model,draft:{...model.draft,structure:shownDynamicsFrame.structure}}:xtbPreview!==model?xtbPreview:undefined});
  },[model,shownXtbFrame,xtbSourceDocument,props.observationOnly,props.analysisCanvas?.document,props.analysisCanvas?.useWorkspaceImageExport,structurePreview,validTransformPresentation,referenceCapture.viewportCapture,dynamicsFrameCurrent,shownDynamicsFrame,workingSelection]);
  const viewportDisplay=props.advancedModelingRoute?.task==='cell-editor'&&structurePreview?{...display,cell:true}:display;
  const mdObservation=useRef(emptyObservationView());
  const onCipLabelsUsed=useCurrentCipUsage(viewportModel,(props.viewportActive??props.active)!==false,props.onCipLabelsUsed);
  const mdObservationEnabled=dynamicState.mode==='md'&&!props.observationOnly&&!structurePreview&&!shownXtbFrame&&!props.initialViewTransform&&!props.analysisCanvas?.viewport.viewTransform;
  const mdDisplayFrame=mdObservationEnabled&&dynamicsDisplayFrameCurrent?shownDynamicsFrame:undefined;
  if(mdObservationEnabled)mdObservation.current=updateObservationView(mdObservation.current,{documentId:model.id,structure:viewportModel.draft.structure,
    reference:mdDisplayFrame?dynamicState.referenceStructure:undefined,epoch:mdDisplayFrame?dynamicState.sessionId:undefined,frame:mdDisplayFrame?.seq,
    mode:viewportDisplay.alignment,frozenAtomIds:getFrozenAtomIds(model),softAnchorAtomIds:mdDisplayFrame?.nativeMD?.protectedAtomIds});
  const mdObservationTransform=mdObservationEnabled?mdObservation.current.transform:undefined;
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
  xtbDisplayObservation.current=nextXtbDisplayObservation(xtbDisplayObservation.current,model,shownXtbFrame,xtbContext.current?.referenceStructure,dynamicState.sessionId,xtbSourceDocument);
  const viewportObservation=xtbDisplayObservation.current;
  useEffect(() => { xtb.connect(); return () => xtb.disconnect(); }, [xtb]);
  const structureRuntimeLocked = xtbState.running || ['starting','running','pausing','paused','stopping'].includes(dynamicState.status);
  const baseStructureLocked = props.observationOnly===true&&props.allowModelEditing!==true || structureRuntimeLocked&&store.isRuntimeEditingAllowed?.()!==true;
  const previewEditingBlocked=Boolean(props.active!==false&&structurePreview?.documentId===model.id&&structurePreview.expectedRevision===model.revision&&(periodicToolsOpen||transformToolsOpen)&&!referenceCapture.viewportCapture);
  const observationEditPolicy=useRef({preview:false,playing:false});
  observationEditPolicy.current={preview:previewEditingBlocked,playing:props.analysisCanvas?.modelEditingBlocked===true};
  const structureLocked=baseStructureLocked||previewEditingBlocked||props.analysisCanvas?.modelEditingBlocked===true;
  const freezeLocked=structureLocked||props.freezeEditingAllowed===false;
  const effectivePointerMode=props.freezeEditingAllowed===false?(temporaryPointerMode==='select'?'select':null):temporaryPointerMode??(freezeTool?'freeze':null);
  const historyLocked=baseStructureLocked||props.analysisCanvas?.modelEditingBlocked===true;
  const validCellEditorDraft=props.active!==false&&props.advancedModelingRoute?.category==='periodic'&&props.advancedModelingRoute.task==='cell-editor'&&cellEditorDraft?.documentId===model.id&&cellEditorDraft.expectedRevision===model.revision?cellEditorDraft:null;
  const [lastChemistryReceipt, setLastChemistryReceipt] = useState<ChemistryReceipt | null>(null);
  const [cellExportChoice,setCellExportChoice]=useState<CellExportChoice|null>(null);
  const withCell=modelCellExportDefault(model,cellExportChoice);
  const setWithCell=(value:boolean)=>setCellExportChoice({documentId:store.getSnapshot().id,withCell:value});
  const [staleAssignments, setStaleAssignments] = useState(false);
  const [pasteConflict, setPasteConflict] = useState<ClipboardPayload | null>(null);
  const [importChoices, setImportChoices] = useState<FragmentSnapshot[]>([]);
  const [aggression, setAggression] = useState<BondAggression>('standard');
  const [optimizationPreferences,setOptimizationPreferences]=useState(readWorkspaceOptimizationPreferences);
  const hasPeriodicBox=Boolean(model.draft.structure.cell),partialPeriodicBox=model.draft.structure.periodicSource?.completeness==='partial';
  const optimizationChoice=hasPeriodicBox?'geometry':optimizationPreferences.forcefield.method,optimizationScope=optimizationPreferences.forcefield.scope;
  function updateOptimizationPreferences(next:WorkspaceOptimizationPreferences){try{const accepted=writeWorkspaceOptimizationPreferences(next);setOptimizationPreferences(accepted);setError('');}catch(cause){setError(`优化偏好未保存：${message(cause)}`);}}
  const setOptimizationChoice=(method:OptimizationChoice)=>updateOptimizationPreferences({...optimizationPreferences,forcefield:{...optimizationPreferences.forcefield,method}});
  const setOptimizationScope=(range:OptimizationScope)=>updateOptimizationPreferences({...optimizationPreferences,forcefield:{...optimizationPreferences.forcefield,scope:range}});
  useEffect(()=>{
    const receive=(event:Event)=>setOptimizationPreferences(parseWorkspaceOptimizationPreferences((event as CustomEvent).detail));
    const storage=(event:StorageEvent)=>{if(event.key===OPTIMIZATION_PREFERENCE_KEY)setOptimizationPreferences(readWorkspaceOptimizationPreferences());};
    window.addEventListener(OPTIMIZATION_PREFERENCE_EVENT,receive);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(OPTIMIZATION_PREFERENCE_EVENT,receive);window.removeEventListener('storage',storage);};
  },[]);
  const optimizationMaxSteps=500;
  const [optimizationBusy,setOptimizationBusy]=useState(false),[optimizationNotice,setOptimizationNotice]=useState(''),[problemAtomIds,setProblemAtomIds]=useState<string[]>([]);
  const forcefield:ForcefieldChoice=optimizationChoice==='geometry'?'auto':optimizationChoice;
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
  const manualGeometry=useRef<{store:ModelStore;documentId:string;revision:number;pendingRecord?:MeasurementRecord}|null>(null);
  const [geometryEditing,setGeometryEditing]=useState(false);
  const importing = useRef<AbortController | null>(null);
  const incoming = useRef({ structure, openRequest, assignments: JSON.stringify(assignments ?? null) });
  const currentCoordinates = orcaJobRequest ? captureOrcaCoordinates(structure, orcaJobRequest.settings) : jobRequest ? captureGaussianCoordinates(structure, jobRequest.settings) : undefined;
  const coordinateSignature = JSON.stringify(currentCoordinates ?? null);
  const incomingCoordinates = useRef(coordinateSignature);
  const engineScope = orcaJobRequest ? 'orca' : 'gaussian';
  const runPreviewSource:ModelDocument|undefined=props.observationOnly?undefined:shownXtbFrame&&xtbFrameCurrent?xtbSourceDocument:dynamicsFrameCurrent&&shownDynamicsFrame?dynamicsSourceDocument:undefined;
  const markerModel=runPreviewSource??(advancedObservation?workspaceCurrentProtectionDocument(viewportModel,model,props.analysisCanvas?.staticDocument?.draft.structure):model);
  const explicitDisplayFrozenAtomIds=props.analysisCanvas?.viewport.displayFrozenAtomIds;
  const displayFrozenAtomIds=runPreviewSource?getFrozenAtomIds(runPreviewSource):workspaceDisplayFrozenAtomIds(viewportModel,getFrozenAtomIds(markerModel),explicitDisplayFrozenAtomIds,advancedObservation);
  const constraintSources=modelConstraintSources(markerModel,engineScope);
  const stateMarkers:ViewportStateMarker[]=constraintSources.flatMap<ViewportStateMarker>(source=>source.kind==='atom'?source.atomIds.map(atomId=>({id:JSON.stringify([source.scope,source.kind,source.id])+(source.atomIds.length>1?`:${atomId}`:''),kind:'freeze' as const,atomIds:[atomId],label:source.label,removable:!advancedObservation&&props.freezeEditingAllowed!==false&&source.removable})):[{id:JSON.stringify([source.scope,source.kind,source.id]),kind:source.action==='scan'?'scan':'freeze',atomIds:source.atomIds,images:source.images,label:source.label,removable:!advancedObservation&&props.freezeEditingAllowed!==false&&source.removable,coordinateId:displayedCoordinateObjects(markerModel).find(object=>source.objectId===object.id||modelCoordinateKey(object)===modelCoordinateKey({type:source.atomIds.length===2?'B':source.atomIds.length===3?'A':'D',atomIds:source.atomIds,images:source.images}))?.id}]);
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
  if(explicitDisplayFrozenAtomIds!==undefined&&!runPreviewSource){
    // Read-only result protection owns its frame markers. Editable initial
    // pages retain hard-freeze marker ownership alongside soft protection.
    if(advancedObservation)for(let index=stateMarkers.length-1;index>=0;index--){const marker=stateMarkers[index];if(marker.kind==='freeze'&&!marker.coordinateId&&marker.atomIds.length===1)stateMarkers.splice(index,1);}
    for(const atomId of explicitDisplayFrozenAtomIds)if(displayFrozenAtomIds?.includes(atomId)&&!stateMarkers.some(marker=>marker.kind==='freeze'&&!marker.coordinateId&&marker.atomIds.includes(atomId)))stateMarkers.push({id:`display-protection:${atomId}`,kind:'freeze',atomIds:[atomId],removable:false,label:'保护核心'});
  }
  const incomingScope = useRef<string>('');
  const applied = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scope = useRef<HTMLElement>(null);
  useEffect(()=>{if(props.store)return;store.setScientificEditGuard?.(()=>confirmSynchronousOperation(ANALYSIS_INVALIDATION_CONFIRMATION,scope.current?.ownerDocument));return()=>store.setScientificEditGuard?.(null);},[store,props.store]);
  const structureAnalysis=useStructureInteractionAnalysis({store,document:model,active:structureAnalysisOpen&&!structurePreview&&!structureRuntimeLocked,onError:setError,onExportImage:()=>{const owner=scope.current?.ownerDocument;if(owner)return exportCurrentViewport({format:'png',includeAnnotations:true},owner);}});
  const projectedViewport=props.observationOnly&&props.analysisCanvas?props.analysisCanvas.viewport:structureAnalysis.viewport;
  const observedViewportModel=useMemo(()=>projectedViewport.displayAtoms?{...viewportModel,draft:{...viewportModel.draft,structure:{...viewportModel.draft.structure,atoms:projectedViewport.displayAtoms}}}:viewportModel,[viewportModel,projectedViewport.displayAtoms]);
  const displayProjection=useMemo(()=>props.onDisplayProjection?createTrustedViewportDisplayProjection(model,{...projectedViewport,viewTransform:projectedViewport.viewTransform??props.initialViewTransform??mdObservationTransform},observedViewportModel!==model?observedViewportModel:undefined):null,
    [model,projectedViewport,props.initialViewTransform,mdObservationTransform,observedViewportModel,props.onDisplayProjection]);
  useLayoutEffect(()=>{props.onDisplayProjection?.(displayProjection,projectedViewport.onSurfaceMeshState);},[props.onDisplayProjection,displayProjection,projectedViewport.onSurfaceMeshState]);
  useEffect(()=>()=>latest.current.props.onDisplayProjection?.(null,undefined),[]);
  const periodic = isPeriodic(editingStructure), atoms = editingStructure.atoms;
  const electronicRequest=orcaJobRequest??jobRequest;
  const [bondPerceptionMethod,setBondPerceptionMethod]=useState<BondPerceptionMethod>('empirical');
  useEffect(()=>setBondElectronicPrompt(null),[bondPerceptionMethod]);
  const [empiricalParameters,setEmpiricalParameters]=useState<EmpiricalBondPerceptionParameters>(DEFAULT_EMPIRICAL_BOND_PARAMETERS);
  const [savedXtbElectronic,setSavedXtbElectronic]=useState<BondElectronicDraft|null>(null);
  const [bondElectronicConsent,setBondElectronicConsent]=useState<BondElectronicDraft|null>(null);
  const localXtbDraft=savedXtbElectronic?.documentId===model.id?savedXtbElectronic:null;
  const invalidXtbDraft=localXtbDraft&&(!Number.isSafeInteger(localXtbDraft.charge)||!Number.isSafeInteger(localXtbDraft.multiplicity)||localXtbDraft.multiplicity<1);
  const xtbElectronic=localXtbDraft&&invalidXtbDraft?{charge:localXtbDraft.charge,multiplicity:localXtbDraft.multiplicity}:{charge:model.draft.structure.charge??Number.NaN,multiplicity:model.draft.structure.multiplicity??Number.NaN};
  useEffect(()=>{setSavedXtbElectronic(null);},[model.id,model.draft.structure.charge,model.draft.structure.multiplicity]);
  function changeXtbElectronic(value:{charge:number;multiplicity:number}){
    if(props.active===false||xtb.getSnapshot().running||latest.current.store.getSnapshot().id!==model.id)return;
    if(Number.isSafeInteger(value.charge)&&Number.isSafeInteger(value.multiplicity)&&value.multiplicity>=1){try{store.setElectronicState(value.charge,value.multiplicity,false);setSavedXtbElectronic(null);setError('');}catch(cause){setError(message(cause));}return;}
    if(!Object.is(value.charge,xtbElectronic.charge)||!Object.is(value.multiplicity,xtbElectronic.multiplicity))store.clearBondOrders();
    setSavedXtbElectronic(captureBondElectronicDraft(latest.current.store.getSnapshot(),value));
  }
  const runtimeElectronicInvalid=Boolean(electronicRequest&&electronicStateError(atoms,electronicRequest.charge,electronicRequest.multiplicity));
  const indices = workingSelection.atomIds.map(id => atoms.findIndex(atom => atom.id === id)).filter(index => index >= 0);
  const selectionNumberSignature=indices.join(',');
  const selectionTools=useAtomSelectionTools({documentId:model.id,structure:editingStructure,atomIds:workingSelection.atomIds,disabled:props.active===false,onSelect:(ids,origin)=>select({...EMPTY_SELECTION,atomIds:ids},origin),onGestureBegin:()=>{if(!observationKey)store.beginSelectionTransaction?.();},onGestureEnd:()=>{if(!observationKey)store.endSelectionTransaction?.();}});

  const optimization=useMemo(()=>createOptimizationCoordinator({runtime:dynamics,capture:range=>{
    dynamics.assertCanEditStructure();const sourceStore=latest.current.store,document=sourceStore.getSnapshot(),lease=latest.current.props.activationStamp?.(),epoch=generation.current;
    const owner:WorkspaceRuntimeOwner={store:sourceStore,documentId:document.id,generation:epoch,lease};
    const movableAtomIds=preoptimizationMovableAtomIds(document,range,latest.current.props.orcaJobRequest?.settings),stamp=sourceStore.stamp(movableAtomIds),constraints=structuredClone(effectiveModelCoordinates(document));
    if(!movableAtomIds.length)throw new Error('本次范围没有可动原子。');
    const context=JSON.stringify([latest.current.props.jobRequest,latest.current.props.orcaJobRequest]);
    return{stamp,movableAtomIds,constraints,assertCurrent(){
      assertRuntimeOwner(owner);
      if(context!==JSON.stringify([latest.current.props.jobRequest,latest.current.props.orcaJobRequest])||JSON.stringify(stamp)!==JSON.stringify(sourceStore.stamp(movableAtomIds)))throw new Error('优化文档、坐标、可动范围或约束已变化，未继续运行。');
      if(lease&&!latest.current.props.assertRuntimeCurrent)latest.current.props.assertActivation?.(lease);
    }};
  },notice:setOptimizationNotice,failure:value=>{const current=latest.current.store.getSnapshot(),ids=new Set(current.draft.structure.atoms.map(atom=>atom.id));const same=value&&JSON.stringify(value.stamp)===JSON.stringify(latest.current.store.stamp(value.movableAtomIds));const endpoints=value?.origin==='native'&&value.identityVerified&&value.code==='fractional-parameterization'?(current.draft.structure.bonds??[]).filter(bond=>bond.fractional===true).flatMap(bond=>[current.draft.structure.atoms[bond.a]?.id,current.draft.structure.atoms[bond.b]?.id]).filter((id):id is string=>!!id):[];setProblemAtomIds(same?[...new Set((value.atomIds??endpoints).filter(id=>ids.has(id)))]:[]);}}),[store,dynamics]);
  viewportBusy.current=()=>modelWorkspaceRuntimeBusy({xtb,dynamics,optimization,task:task.current,pendingJobs:pendingNativeJobs.current.size,pendingImports:pendingImports.current,savePending:saveBusyRef.current,store:latest.current.store});
  function assertRuntimeOwner(owner:WorkspaceRuntimeOwner){assertModelWorkspaceRuntimeOwner(owner,{alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,assertRuntimeCurrent:latest.current.props.assertRuntimeCurrent,assertActivationIdentity:latest.current.props.assertActivationIdentity});}
  useEffect(()=>()=>optimization.cancel(),[optimization]);
  const problemGraph=graphFingerprint(model.draft.structure);
  useEffect(()=>{setProblemAtomIds([]);},[model.id,problemGraph]);
  useEffect(()=>{
    const frame=dynamicState.lastFrame,current=store.getSnapshot();
    if(frame?.operation==='geometry'&&frame.hybridGeometry&&frame.stamp.documentId===current.id&&graphFingerprint(frame.structure)===graphFingerprint(current.draft.structure))setProblemAtomIds([...frame.hybridGeometry.problemAtomIds]);
  },[dynamicState.lastFrame,store]);
  useEffect(()=>{if(!problemAtomIds.length||props.active===false)return;const document=scope.current?.ownerDocument;if(!document)return;const clear=()=>setProblemAtomIds([]);document.addEventListener('pointerdown',clear,{capture:true,once:true});return()=>document.removeEventListener('pointerdown',clear,true);},[problemAtomIds.length,props.active]);
  function cancelTask() { optimization.cancel();void xtb.stop().catch(cause=>setError(message(cause)));generation.current++; importing.current?.abort(); importing.current = null; task.current?.cancel(); task.current = null; setBusy(false); setLastChemistryReceipt(null); setStatus(''); setSaveState(null); }
  function cancelWorkingEditTasks() {
    if(!store.isRuntimeSessionActive?.()||store.isRuntimeEditingAllowed?.()!==true){cancelTask();return;}
    importing.current?.abort();importing.current=null;task.current?.cancel();task.current=null;setBusy(false);setLastChemistryReceipt(null);setStatus('');setSaveState(null);
  }
  function resetInteraction() { observationOwnership.current={documentId:store.getSnapshot().id,recordIds:new Set()};heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);applyToolIntent({type:'document-reset'});setOptimizationNotice('');setProblemAtomIds([]);hover.current = { kind: 'none', worldPoint: [0, 0, 0] }; }
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
  function structureEditAllowed(prepareEdit=false,previewOperation=false) { try { const current=latest.current;if(current.props.active===false)throw new Error('请先激活目标模型视图。');if(current.props.observationOnly&&current.props.allowModelEditing!==true)throw new Error('当前观察对象尚未接入结构编辑。');if(observationEditPolicy.current.playing)throw new Error('请先暂停播放，再编辑结构。');if(!previewOperation&&observationEditPolicy.current.preview)throw new Error('请先关闭实时预览，再编辑源结构。');dynamics.assertCanEditStructure();if(prepareEdit)current.store.setScientificEditBase?.(current.props.analysisCanvas?.prepareModelEdit?.()??null,workingSelection);return true; } catch(cause) { setError(message(cause)); return false; } }
  useEffect(()=>{if(!structureAnalysisOpen)return;cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);setGeometryOpen(false);setStructurePreview(null);setTransformPresentation(null);setPersonalFragmentsOpen(false);},[structureAnalysisOpen]);
  function prepareDynamicsStart(mode?: DynamicsOperation, config?: DynamicsConfig) {
    if(!structureEditAllowed())return false;
    if(mode==='md'){
      const current=store.getSnapshot(),info=getMDProtectionInfo(current.draft.structure,config?.method??'auto',getMovableAtomIds(current,'all'));
      if(!info.allowed)throw new Error(info.reason);
      if(info.requiresConfirmation&&!confirmSynchronousOperation(`${info.message}\n保护不是XYZ硬冻结；动态帧叠合仅改变显示，不改变计算坐标。继续？`,scope.current?.ownerDocument))return false;
    }
    cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    cancelTask();return true;
  }
  async function runXtb(options: XtbPanelOptions) {
    if (!structureEditAllowed() || busy || optimizationBusy || geometryEditing) return;
    cancelTask();
    const sourceStore = latest.current.store;
    xtbContext.current = { store: sourceStore, documentId: sourceStore.getSnapshot().id, generation: generation.current, lease: latest.current.props.activationStamp?.(), referenceStructure:structuredClone(sourceStore.getSnapshot().draft.structure) };
    try { await xtb.run(hasPeriodicBox?{...options,rebuildBonds:false}:options); } catch (cause) { setError(message(cause)); } finally { sourceStore.clearScientificEditApproval?.(); }
  }
  const runMcpXtbRef = useRef<(calculation: 'singlepoint' | 'optimize', options: XtbOptions, timeoutSeconds?: number) => Promise<XtbState>>(null!);
  runMcpXtbRef.current = async (calculation: 'singlepoint' | 'optimize', options: XtbOptions, timeoutSeconds?: number): Promise<XtbState> => {
    if (!structureEditAllowed() || busy || optimizationBusy || geometryEditing) {
      throw new Error('当前建模窗口正在执行其他操作或处于只读模式，请先结束当前操作。');
    }
    if (hasPeriodicBox && calculation === 'singlepoint' && !periodicGfn2Available) {
      throw new Error('当前运行环境尚未提供周期 GFN2 辅助单点能力。');
    }
    cancelTask();
    const sourceStore = latest.current.store;
    xtbContext.current = {
      store: sourceStore,
      documentId: sourceStore.getSnapshot().id,
      generation: generation.current,
      lease: latest.current.props.activationStamp?.(),
      ...(calculation === 'optimize' ? { referenceStructure: structuredClone(sourceStore.getSnapshot().draft.structure) } : {})
    };
    mcpAutoConfirmConstraints.current = true;
    let timedOut = false;
    const deadlineTimer = timeoutSeconds && timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          void xtb.stop().catch(() => {});
        }, timeoutSeconds * 1000)
      : undefined;
    try {
      const effectiveOptions: XtbOptions = {
        ...options,
        ...(timeoutSeconds !== undefined ? { maxWallTimeSeconds: timeoutSeconds } : {}),
        maxSccIterations: options.maxSccIterations ?? optimizationPreferences.xtb.maxSccIterations ?? 250,
        empiricalBondParameters: options.empiricalBondParameters ?? empiricalParameters,
        ...(hasPeriodicBox && calculation === 'optimize' ? { rebuildBonds: false } : {})
      };
      await xtb.run(effectiveOptions, calculation, 'rebuild');
      if (timedOut) {
        await xtb.stop().catch(() => {});
        throw Object.assign(
          new Error(`本机 xTB 计算超过超时限制（${timeoutSeconds} 秒），已自动终止子进程。`),
          { code: 'MCP_XTB_TIMEOUT' }
        );
      }
      const snap = xtb.getSnapshot();
      if (snap.error && !snap.metadata) setError(snap.error);
      return snap;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      mcpAutoConfirmConstraints.current = false;
      sourceStore.clearScientificEditApproval?.();
    }
  };
  async function perceiveBonds(parameters?:EmpiricalBondPerceptionParameters,electronicOverride?:BondElectronicDraft){
    if(!structureEditAllowed()||busy||optimizationBusy||geometryEditing)return;
    const current=latest.current.store.getSnapshot();if(current.id!==model.id){setError('模型文档已变化，请重新判断成键。');return;}
    if(electronicOverride&&!bondElectronicDraftCurrent(current,electronicOverride)){setError('电子态确认所属的模型或组成已变化，请重新判断成键。');return;}
    const {electronic,valid}=bondPerceptionElectronicState(current,{local:localXtbDraft,consent:bondElectronicConsent,override:electronicOverride});
    if(hasPeriodicBox&&bondPerceptionMethod==='gfn2'&&!periodicGfn2Available){setError('当前运行环境尚未提供周期GFN2辅助。');return;}
    if(bondPerceptionMethod==='gfn2'&&!valid){setBondElectronicPrompt({documentId:current.id,revision:current.revision,context:captureBondElectronicDraft(current,electronic),charge:Number.isSafeInteger(electronic.charge)?String(electronic.charge):'0',multiplicity:Number.isSafeInteger(electronic.multiplicity)?String(electronic.multiplicity):'1'});return;}
    cancelTask();const sourceStore=latest.current.store;
    xtbContext.current={store:sourceStore,documentId:sourceStore.getSnapshot().id,generation:generation.current,lease:latest.current.props.activationStamp?.()};
    try{
      if(bondPerceptionMethod==='gfn2'){
        await xtb.run({method:'gfn2',...electronic,rebuildBonds:true,maxSccIterations:optimizationPreferences.xtb.maxSccIterations??250,empiricalBondParameters:empiricalParameters},'singlepoint','rebuild');
      }else{await xtb.perceiveEmpirical(valid?electronic:undefined,'rebuild',parameters??empiricalParameters);if(parameters)setEmpiricalParameters(structuredClone(parameters));}
    }catch(cause){setError(message(cause));}finally{sourceStore.clearScientificEditApproval?.();}
  }
  async function inspectCrystal(request:PeriodicInspectRequest){
    const bridge=desktopBridge(),current=latest.current.store.getSnapshot(),lease=latest.current.props.activationStamp?.();
    if(!bridge?.runCrystalModeling)throw new Error('当前运行环境未提供晶体建模后端。');
    const result=await bridge.runCrystalModeling({...request,documentId:current.id,expectedRevision:current.revision,structure:structuredClone(current.draft.structure)});
    if(lease)latest.current.props.assertActivation?.(lease);
    const active=latest.current.store.getSnapshot();
    if(!asyncAlive.current||latest.current.props.active===false||active.id!==current.id||active.revision!==current.revision||result.documentId!==current.id||result.expectedRevision!==current.revision||result.operation!==request.operation)throw new Error('模型上下文已变化，请重新预览。');
    return result;
  }
  async function prepareTransform(request:PeriodicModelingRequest|StructureTransformEdit){
    if(!structureEditAllowed(false,true)||busy||optimizationBusy||geometryEditing)throw new Error('请先结束当前操作。');
    if(request.type!=='crystal'){setCrystalPreviewResult(null);return prepareStructureTransform(latest.current.store.getSnapshot(),request);}
    const bridge=desktopBridge(),current=latest.current.store.getSnapshot(),lease=latest.current.props.activationStamp?.();
    if(!bridge?.runCrystalModeling)throw new Error('当前运行环境未提供晶体建模后端。');
    const result=await bridge.runCrystalModeling({operation:request.operation,parameters:request.parameters,documentId:current.id,expectedRevision:current.revision,structure:structuredClone(current.draft.structure)});
    if(lease)latest.current.props.assertActivation?.(lease);
    const active=latest.current.store.getSnapshot();
    if(!asyncAlive.current||latest.current.props.active===false||active.id!==current.id||active.revision!==current.revision||result.documentId!==current.id||result.expectedRevision!==current.revision||result.operation!==request.operation||!result.candidate)throw new Error('模型上下文已变化或未生成有效预览。');
    // Normalize all source-owned atom/image metadata before the renderer can
    // observe the candidate. A failed mapping is caught by the tool itself.
    const mapped=mapStructureTransformDocument(current,result.candidate);
    const candidate={...result.candidate,structure:mapped.draft.structure};
    setCrystalPreviewResult({...result,candidate});
    return candidate;
  }
  async function applyTransform(candidate:StructureTransformCandidate){
    if(!structureEditAllowed(false,true)||busy||optimizationBusy||geometryEditing)throw new Error('请先结束当前操作。');
    const current=latest.current.store.getSnapshot();
    if(current.id!==candidate.documentId||current.revision!==candidate.expectedRevision)throw new Error('模型已变化，请重新预览。');
    if(!props.onDeriveStructure)throw new Error('当前工作区未接入新结构派生，原结构未改变。');
    await props.onDeriveStructure(candidate);
    setStructurePreview(null);setTransformPresentation(null);
  }
  async function commitCellEdit(candidate:StructureTransformCandidate){
    if(latest.current.props.advancedModelingRoute?.category!=='periodic'||latest.current.props.advancedModelingRoute.task!=='cell-editor'||!structureEditAllowed(true,true))throw new Error('当前结构不能编辑晶胞。');
    const before=store.getSnapshot();
    if(candidate.documentId!==before.id||candidate.expectedRevision!==before.revision)throw new Error('晶胞编辑已过期，请重试。');
    const after=store.execute({type:'apply-structure-transform',candidate});
    if(after.revision!==before.revision){dynamics.beforeExternalEdit('晶胞已编辑');cancelWorkingEditTasks();}
    setError('');
  }
  async function stopActiveOptimization() { if (xtb.getSnapshot().running) await xtb.stop(); else await dynamics.stop(); }
  function cancelManualGeometry() { if(wheelGeometry.current?.timer)clearTimeout(wheelGeometry.current.timer);wheelGeometry.current=null; const own=manualGeometry.current;if(!own)return;manualGeometry.current=null;own.store.cancelTransaction();setGeometryEditing(false); }
  /** One view adapter for tool policy. Model commands, selection/capture
   * validation, runtime and async guards stay at their existing call sites. */
  function applyToolIntent(intent:ToolSessionIntent, focus = true) {
    const transition=planToolSessionTransition(intent),patch=transition.patch;
    if(transition.advancePreviewIntent)previewIntentEpoch.current++;
    if(transition.cancelManualGeometry)cancelManualGeometry();
    if(latest.current.props.toolIntent!==undefined){const next=reduceWorkspaceToolIntent(toolIntentMirror.current,intent);if(next!==toolIntentMirror.current)publishToolIntent(next);}
    else{const {geometryOpen:_local,...toolPatch}=patch;if(Object.keys(toolPatch).length)publishToolIntent(mergeWorkspaceToolIntent(toolIntentMirror.current,{...toolPatch,...(intent.type==='escape'?{element:null}:{})}));else if(intent.type==='escape')patchToolIntent({element:null});}
    if('geometryOpen' in patch)setGeometryOpen(patch.geometryOpen!);
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
  function selectMeasurementRecord(record:MeasurementRecord) {if(props.captureRequest){const kind=recordObject(record).type;if(props.captureRequest.kind!=='atoms'&&props.captureRequest.kind!==kind&&props.captureRequest.kind!=='coordinate'){setError('请选择与当前任务相同类型的内坐标。');return;}updateCapture([...record.atomIds]);return;}cancelManualGeometry();setMeasurementSession(previous=>activateMeasurementRecord(modelMeasurementSession(previous,store.getSnapshot()),record.id));setGeometryOpen(true);scope.current?.focus({preventScroll:true});}
  function wheelMeasurementRecord(record:MeasurementRecord,deltaY:number) {
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
    if(!structureEditAllowed(true,command.type==='restore-cell-checkpoint')) return latest.current.store.getSnapshot();
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
    const bond=structure.bonds?.find(value=>canonicalPeriodicBond(value.a,value.b,value.image).key===key)??(!image.some(Boolean)?model.auxiliaryRelations.find(value=>value.a===ids[0]&&value.b===ids[1]||value.a===ids[1]&&value.b===ids[0]):undefined);
    if(!bond)return{bondOrder:null};
    return{bondOrder:bond.order,onBondOrderChange:(order:BondOrder)=>execute({type:'set-bond-order',atomIds:ids as [string,string],image,order})};
  }
  function select(selection: ModelSelection, origin?:'numbers'|'bond') {
    try {
      if(latest.current.props.captureRequest){updateCapture(selection.atomIds);return;}
      if(origin!=='bond')selectionTools.resetSeeds(selection.atomIds);
      if(observationKey){setObservationSelection({key:observationKey,selection:observationModelSelection(selection,editingStructure)});setError('');return;}
      const next = latest.current.store.select(selection);
      const nextIndices = next.selection.atomIds.map(id => next.draft.structure.atoms.findIndex(atom => atom.id === id));
      latest.current.props.onSelect?.(nextIndices); latest.current.props.onSelectIds?.([...next.selection.atomIds]);
      setError('');
    } catch (cause) { setError(message(cause)); }
  }
  function selectNumbers() {
    try { select({ ...EMPTY_SELECTION, atomIds: parseAtomSelection(selectionInput, editingStructure.atoms.length).map(index => editingStructure.atoms[index].id!) }); } catch (cause) { setError(message(cause)); }
  }
  function transactCommands(label:string,commands:ModelCommand[]):boolean {
    if(latest.current.props.freezeEditingAllowed===false&&commands.some(isWorkspaceFreezeCommand))return false;
    if(!structureEditAllowed(true)||!commands.length)return false;
    cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    const target=latest.current.store;
    try{const before=target.getSnapshot();if(target.executeBatch)target.executeBatch(commands,label);else{target.beginTransaction(label);for(const command of commands)target.execute(command);target.endTransaction();}if(!runtimePreviewSourceCurrent(before,target.getSnapshot())){dynamics.beforeExternalEdit(label);cancelWorkingEditTasks();}setError('');return true;}
    catch(cause){if(!target.executeBatch)target.cancelTransaction();setError(message(cause));return false;}
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
    if(!structureEditAllowed())return;
    const before=store.getSnapshot(),selectedAtoms=new Set(workingSelection.atomIds),coordinateIds=new Set(workingSelection.coordinateIds??[]);
    const affected=displayedCoordinateObjects(before).filter(object=>coordinateIds.has(object.id)||object.atomIds.some(id=>selectedAtoms.has(id)));
    const linked=affected.filter(object=>coordinateAssociations(store,object).length);
    if(linked.length&&!confirmSynchronousOperation(`将同时删除 ${linked.length} 个关联内坐标及其冻结/扫描定义，一次撤销可恢复。继续？`,scope.current?.ownerDocument))return;
    if(store.getSnapshot().id!==before.id||store.getSnapshot().revision!==before.revision){setError('确认期间模型已变化，请重新删除。');return;}
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
    const source=modelConstraintSources(store.getSnapshot(),engineScope).find(item=>JSON.stringify([item.scope,item.kind,item.id])===marker.id);
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
    if(pick.kind==='atom'){
      const objects=displayedCoordinateObjects(current).filter(object=>object.atomIds.includes(pick.atomId));
      if(objects.length&&!confirmSynchronousOperation(`删除该原子将使 ${objects.length} 个内坐标及其关联定义失效，一次撤销可恢复。继续？`,scope.current?.ownerDocument))return;
    }
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
    observationOwnership.current.recordIds.clear();cancelManualGeometry();setGeometryOpen(false);setMeasurementSession(previous=>({...modelMeasurementSession(previous,store.getSnapshot()),pendingAtomIds:[],autoAtomIds:[],pendingImages:undefined,autoImages:undefined,activeRecordId:null}));
  }
  function freezeCoordinate(record:MeasurementRecord){transactCommands('冻结内坐标',[{type:'set-shared-coordinate-freeze',object:recordObject(record),frozen:true}]);}
  function history(kind: 'undo' | 'redo') {
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
    const assignmentsChanged = assignmentSignature !== incoming.current.assignments;
    const coordinatesChanged = coordinateSignature !== incomingCoordinates.current;
    if (!assignmentsChanged && !coordinatesChanged && (!props.realtime || incomingScope.current===engineScope)) return;
    if (props.realtime) {
      if(incomingScope.current && structureLocked){setError('动态会话中不修改任务约束；请先Stop，再应用当前任务。');return;}
      try{cancelManualGeometry();cancelWorkingEditTasks();if(incomingScope.current===engineScope && (assignmentsChanged||coordinatesChanged))dynamics.beforeExternalEdit('当前任务约束已变化');store.synchronizeContext(assignments ?? { layers: [], basis: [], fragments: [], frozenAtomIds: [] },currentCoordinates??[],engineScope);incoming.current.assignments=assignmentSignature;incomingCoordinates.current=coordinateSignature;incomingScope.current=engineScope;setStaleAssignments(false);}catch(cause){setError(message(cause));}return;
    }
    if (model.draft.dirty) { cancelTask(); setStaleAssignments(true); return; }
    cancelTask();
    if (assignmentsChanged && assignments) store.execute({ type: 'set-assignments', assignments });
    if (coordinatesChanged && currentCoordinates !== undefined) store.execute({ type: 'set-internal-coordinates', coordinates: currentCoordinates });
    store.markApplied(); incoming.current.assignments = assignmentSignature; incomingCoordinates.current = coordinateSignature; setStaleAssignments(false);
  }, [assignmentSignature, coordinateSignature, model.draft.dirty, store,engineScope,structureLocked]);
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
  useEffect(()=>{if(structureLocked){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);}applyToolIntent({type:'runtime-status',locked:structureLocked});},[structureLocked]);
  useEffect(() => { setSelectionInput(formatAtomSelection(indices)); }, [selectionNumberSignature]);
  useEffect(() => {
    if (observationKey||!selected || (!props.realtime && model.draft.dirty)) return;
    const atomIds = selected.flatMap(index => atoms[index]?.id ? [atoms[index].id!] : []);
    if (JSON.stringify(atomIds) !== JSON.stringify(workingSelection.atomIds)) store.select({ ...EMPTY_SELECTION, atomIds });
  }, [selected, store]);
  useEffect(() => {asyncAlive.current=true;return()=>{asyncAlive.current=false;generation.current++;importing.current?.abort();task.current?.cancel();};}, []);
  useEffect(()=>()=>{generation.current++;cancelManualGeometry();},[store]);

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
    try {const target=latest.current.store.getSnapshot().draft.structure,source=payload.fragment.structure;let offset=policy?.offset;
      if(!offset&&target.atoms.length&&!isPeriodic(target)&&!isPeriodic(source)){const maxX=Math.max(...target.atoms.map(atom=>atom.x)),minX=Math.min(...source.atoms.map(atom=>atom.x));offset=[maxX-minX+2.5,0,0];}
      latest.current.store.paste(payload,{...policy,...(offset?{offset}:{})});dynamics.beforeExternalEdit('已粘贴模型');cancelWorkingEditTasks();setPasteConflict(null); setError(''); setStatus('已追加独立副本。'); }
    catch (cause) { if (cause instanceof ModelConflictError && cause.conflicts.some(conflict => conflict.kind === 'cell')) setPasteConflict(payload); else setError(message(cause)); }
  }
  async function paste() {
    if(!structureEditAllowed())return;
    if(activePreview.model){pastePayload(structuredClone(activePreview.model.payload));return;}
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
  function copiedPlacement(command:ModelCommand){command=defaultPlacementCommand(latest.current.store.getSnapshot().draft.structure,command);if(command.type!=='place-element'&&command.type!=='place-fragment')return execute(viewportCommand(command));const preview=activePreview.model,index=previewActiveIndex??preview?.defaultActiveAtomIndex??0;const usePreview=preview&&(preview.kind==='copy'||index!==preview.defaultActiveAtomIndex);if(!usePreview)return execute(viewportCommand(command));return execute({type:'place-copied-fragment',payload:preview.payload,activeIndex:index,mode:command.targetAtomId||command.targetPortId?'graft':'independent',position:command.position,targetAtomId:command.targetAtomId,targetPortId:command.targetPortId});}
  function choosePreviewAtom(index:number){const preview=activePreview.model;if(!preview||!Number.isSafeInteger(index)||index<0||index>=preview.structure.atoms.length||!structureEditAllowed())return;if(preview.kind==='element'){const preset=getElementPreset((previewSource as Extract<ActiveStructurePreviewSource,{kind:'element'}>).presetId);applyToolIntent({type:'preview-atom',kind:'element',element:preset.element,index});}else applyToolIntent({type:'preview-atom',kind:preview.kind,index});}
  function deleteMeasurement(id:string){
    if(isObservationCoordinateRecord(store,measurementSession,observationOwnership.current,id)){
      observationOwnership.current.recordIds.delete(id);
      setMeasurementSession(previous=>({...previous,records:previous.records.filter(record=>record.id!==id),activeRecordId:previous.activeRecordId===id?null:previous.activeRecordId}));
      hoveredRecord.current=null;setGeometryOpen(false);return;
    }
    if(!structureEditAllowed())return;
    const before=store.getSnapshot(),object=displayedCoordinateObjects(before).find(item=>item.id===id);if(!object)return;
    const associations=coordinateAssociations(store,object);
    if(associations.length&&!confirmSynchronousOperation(`该内坐标关联以下定义：\n${associations.map(item=>`${item.scope==='shared'?'建模共有':item.scope==='gaussian'?'Gaussian':'ORCA'} ${item.action==='freeze'?'冻结':'扫描'}（${item.inactive?'已保存但未启用':'当前生效'}）`).join('\n')}\n确认同时删除？一次撤销会完整恢复。`,scope.current?.ownerDocument))return;
    if(store.getSnapshot().id!==before.id||store.getSnapshot().revision!==before.revision){setError('确认期间模型已变化，请重新删除。');return;}
    const commands:ModelCommand[]=[];if(!before.coordinateObjects?.some(item=>item.id===object.id))commands.push({type:'upsert-coordinate-object',object});commands.push({type:'delete-coordinate-object',objectId:object.id});
    if(!transactCommands('删除内坐标及关联定义',commands))return;
    const retired=removeObservationCoordinate(measurementSession,observationOwnership.current,object);observationOwnership.current=retired.ownership;
    setMeasurementSession(previous=>modelMeasurementSession(removeObservationCoordinate(previous,observationOwnership.current,object).session,store.getSnapshot()));hoveredRecord.current=null;setGeometryOpen(false);
  }
  useEffect(()=>{if(props.active!==false)return;deactivateModelWorkspaceRuntime(Boolean(props.assertRuntimeCurrent),()=>{generation.current++;void xtb.stop().catch(cause=>setError(message(cause)));task.current?.cancel();task.current=null;setBusy(false);});importing.current?.abort();importing.current=null;leaveCanvas();hoveredRecord.current=null;cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);setGeometryOpen(false);for(const root of [scope.current,props.onToolSurfaceChange?null:props.toolHost,props.onToolbarSurfaceChange?null:props.toolbarHost])root?.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach(element=>element.hidePopover());},[props.active,props.assertRuntimeCurrent,xtb]);
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
      read:()=>({alive:asyncAlive.current,generation:generation.current,store:latest.current.store,active:latest.current.props.active,activationStamp:latest.current.props.activationStamp,assertActivation:latest.current.props.assertActivation,assertActivationIdentity:latest.current.props.assertActivationIdentity,jobRequest:latest.current.props.jobRequest,orcaJobRequest:latest.current.props.orcaJobRequest,documentName:latest.current.props.documentName,runtimeOwner:dynamics,runtimeSessionId:dynamics.getSnapshot().sessionId,runtimeConditions:JSON.stringify([dynamics.getSnapshot().mode,dynamics.getSnapshot().sessionId,dynamics.getSnapshot().seed])}),
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
  function presentDocumentOperation(result:DocumentOperationResult) {
    if(result.status==='cancelled'||result.status==='written-without-current-view')return;
    // Caller await adds a settlement gap. Validate this branch's guard next
    // to UI publication; suppress stale UI without relabeling completed I/O.
    try{result.assertPublishCurrent();}catch{return;}
    if(result.status==='format-required'){saveModalGuard.current=result.assertCurrent;setSaveModal(true);return;}
    if(result.status==='state-required'){setSaveState({format:result.format,token:result.token,snapshot:result.snapshot,request:result.request,assertCurrent:result.assertCurrent});setError('');return;}
    if(result.status==='saved'){setStatus('已保存 '+result.path);latest.current.props.onSavedName?.(result.name);}
    else if(result.status==='downloaded'){setStatus('已导出模型。');latest.current.props.onSavedName?.(result.name);}
    else return;
    setSaveModal(false);saveModalGuard.current=null;setError('');
  }
  async function save() {
    if(saveBusyRef.current||saveModal||saveState)return;
    saveBusyRef.current=true;
    try{presentDocumentOperation(await documentOperations().save({withCell,staleAssignments,purpose:'structure'}));}
    catch(cause){if(asyncAlive.current)setError(message(cause));}
    finally{saveBusyRef.current=false;}
  }
  async function writeExport(format:ModelFormat,token?:string,state?:SaveElectronicState,inheritedGuard?:()=>void) {
    if(saveBusyRef.current)return;saveBusyRef.current=true;
    try{presentDocumentOperation(await documentOperations().writeExport({format,token,state,inheritedGuard,withCell,staleAssignments,purpose:'structure'}));}
    catch(cause){if(asyncAlive.current)setError(message(cause));}
    finally{saveBusyRef.current=false;}
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
  async function chemistry(operation: 'optimize' | 'perceive-bonds', range: PreoptimizationScope | boolean = 'all', rebuild = false) {
    const scope: PreoptimizationScope = typeof range === 'boolean' ? range ? 'selection' : 'all' : range;
    if(!structureEditAllowed())return;
    cancelManualGeometry();
    if(operation==='optimize' && props.realtime){
      try{if(runtimeElectronicInvalid)throw new Error('请先核对有效电荷和多重度，再启动动态整理。');const document=store.getSnapshot();const request=latest.current.props.orcaJobRequest;const movableAtomIds=preoptimizationMovableAtomIds(document,scope,request?.settings);assertOrcaForcefieldTargets(document.draft.structure,effectiveModelCoordinates(document));await dynamics.start('optimize',{movableAtomIds,forcefield,maxSteps:optimizationMaxSteps});setError('');}catch(cause){store.clearScientificEditApproval?.();setError(message(cause));}return;
    }
    dynamics.beforeExternalEdit('启动新的化学整理');
    cancelTask(); const epoch = generation.current, currentStore = latest.current.store, snapshot = currentStore.getSnapshot(),owner:WorkspaceRuntimeOwner={store:currentStore,documentId:snapshot.id,generation:epoch,lease:latest.current.props.activationStamp?.()};
    try {
      assertRuntimeOwner(owner);
      if(staleAssignments)throw new Error('任务分区已变化，请取消草稿后重新编辑。');
      if (snapshot.draft.structure.cell||snapshot.draft.structure.periodicSource) throw new Error('周期模型请使用机械调整或xTB入口；经验连接使用判断成键。');
      if (!snapshot.draft.structure.atoms.length) throw new Error('请先建立结构。');
      const request = latest.current.props.orcaJobRequest;
      const movableAtomIds = preoptimizationMovableAtomIds(snapshot, scope, request?.settings);
      if (operation === 'optimize') assertOrcaForcefieldTargets(snapshot.draft.structure, effectiveModelCoordinates(snapshot));
      if (operation === 'optimize' && !movableAtomIds.length) throw new Error(scope === 'selection' ? '选区没有可动原子。' : scope === 'unselected' ? '非选区没有可动原子。' : '所有原子均已冻结或不可动。');
      const stamp = currentStore.stamp(movableAtomIds);
      setBusy(true); setError(''); setStatus(operation === 'optimize' ? scope === 'selection' ? '正在整理选区…' : scope === 'unselected' ? '正在整理非选区…' : '正在整理全分子…' : '正在识别成键…');
      const job = ownNativeJob(createChemistryPort().start({ stamp, operation, structure: snapshot.draft.structure, movableAtomIds, forcefield, steps: optimizationMaxSteps, aggression, constraints: effectiveModelCoordinates(snapshot).filter(item => item.action === 'freeze') })); task.current = job;
      const result = await job.promise;
      if (epoch !== generation.current || currentStore !== latest.current.store) return;
      assertRuntimeOwner(owner);
      if(!structureEditAllowed())throw new ScientificEditCancelledError();
      if (operation === 'optimize') currentStore.acceptCoordinates(result);
      else currentStore.execute({ type: 'infer-bonds', mode: rebuild ? 'rebuild' : 'supplement', aggression, perceivedBonds: result.structure.bonds, stamp: result.stamp });
      if (operation === 'optimize') setLastChemistryReceipt(chemistryReceipt(result, currentStore.getSnapshot().id, currentStore.getSnapshot().revision));
      setStatus(operation === 'optimize' ? '' : `${result.engine} ${result.engineVersion} · 成键识别完成${result.warnings.length ? ' · ' + result.warnings.join('；') : ''}`); setError('');
    } catch (cause) { if (epoch === generation.current) setError(message(cause)); }
    finally { currentStore.clearScientificEditApproval?.();if (epoch === generation.current) { task.current = null; setBusy(false); } }
  }
  async function generatePlane(planeStructure: Structure) {
    if(!structureEditAllowed())return;
    dynamics.beforeExternalEdit('二维生成新的正式模型');
    cancelTask(); const epoch = generation.current, currentStore = latest.current.store, revision = currentStore.getSnapshot().revision,owner:WorkspaceRuntimeOwner={store:currentStore,documentId:currentStore.getSnapshot().id,generation:epoch,lease:latest.current.props.activationStamp?.()};
    try {
      assertRuntimeOwner(owner);
      const temporary = createModelStore(planeStructure);
      temporary.execute({ type: 'prepare-2d-hydrogens' });
      const prepared = temporary.getSnapshot(), movableAtomIds = getMovableAtomIds(prepared, 'all');
      const stamp = temporary.stamp(movableAtomIds);
      setBusy(true); setError(''); setStatus('正在生成三维…');
      const job = ownNativeJob(createChemistryPort().start({ stamp, operation: 'generate3d', structure: prepared.draft.structure, movableAtomIds, forcefield: 'auto', steps: optimizationMaxSteps })); task.current = job;
      const result = await job.promise;
      if (epoch !== generation.current || currentStore !== latest.current.store || revision !== currentStore.getSnapshot().revision) return;
      assertRuntimeOwner(owner);if(!structureEditAllowed())throw new ScientificEditCancelledError();dynamics.assertCanEditStructure();if(xtb.getSnapshot().running)throw new Error('请先停止xTB预优化。');
      temporary.acceptCoordinates(result);
      const completed = temporary.getSnapshot();
      currentStore.execute({ type: 'replace-document', fragment: { structure: completed.draft.structure, assignments: completed.draft.assignments, auxiliaryRelations: [], deletedBonds: [] } });
      setLastChemistryReceipt(chemistryReceipt(result, currentStore.getSnapshot().id, currentStore.getSnapshot().revision));
      setPlane(false); resetInteraction(); setStatus('三维结构已生成。');
    } catch (cause) { if (epoch === generation.current) setError(message(cause)); }
    finally { currentStore.clearScientificEditApproval?.();if (epoch === generation.current) { task.current = null; setBusy(false); } }
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
    if (command) { execute(command); return; }
    if (action.type === 'undo' || action.type === 'redo') history(action.type);
    if (action.type === 'copy') void copy();
    if (action.type === 'paste') void paste();
    if (action.type === 'save') void save();
    if (action.type === 'escape') {applyToolIntent({type:'escape',captureActive:Boolean(props.captureRequest)});if(props.captureRequest){props.onCaptureCancel?.();return;} select(EMPTY_SELECTION); if(!structureLocked)cancelWorkingEditTasks(); setPlane(false); setPasteConflict(null); }
  }
  const modalActive = Boolean(props.twoDActive || plane || saveModal || saveState || pasteConflict || importChoices.length);
  const {heldUndo,heldUndoContext}=useModelWorkspaceKeyboardLifecycle({keyboard,heldPointerKey,heldLetters,pointerInCanvas,hover,setTemporaryPointerMode,setInteraction,
    modalActive,documentId:model.id,active:props.active,structureLocked,editingLayout:workbenchLayout.editMode,undo:()=>history('undo'),
    undoAllowed:()=>latest.current.props.active!==false&&!historyLocked&&!modalActive&&!workbenchLayout.editMode&&!blockingModelDialog(scope.current)&&!editableTarget(document.activeElement)});
  useEffect(() => {
    const keyEvent = (event: KeyboardEvent, release: boolean, remote=false) => {
      if(release&&['z','control','meta'].includes(event.key.toLowerCase()))heldUndo.stop();
      if(latest.current.props.active===false){heldPointerKey.current=null;heldLetters.current.clear();setTemporaryPointerMode(null);keyboard.reset('blur');return;}
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
      if (!release && !inScope) { keyboard.reset('blur'); setInteraction(keyboard.getSnapshot()); return; }
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
          event.preventDefault();const runtime=xtb.getSnapshot(),dynamic=dynamics.getSnapshot(),action=workspaceSpaceOptimizationAction({xtbRunning:runtime.running,xtbPhase:runtime.phase,xtbOperation:runtime.operation,dynamicsStatus:dynamic.status,dynamicsMode:dynamic.mode,canStart:!structureLocked&&!busy&&!optimizationBusy&&!geometryEditing&&!partialPeriodicBox&&!!atoms.length});
          if(action==='stop')void stopActiveOptimization().catch(cause=>setError(message(cause)));else if(action==='start')void spaceOptimize();
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
  viewportDispatch.current=createModelWorkspaceViewportDispatcher({documentId:model.id,revision:model.revision,
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
        key:(event,{current,releasing,resolveMarker})=>{
          hover.current=event.hover;hoverStamp.current={id:current.id,revision:current.revision};
          const remoteRecord=event.measurementRecordId?measurement.records?.find(row=>row.id===event.measurementRecordId)??null:null;
          if(event.measurementRecordId&&!remoteRecord&&!releasing)throw new Error('悬停测量记录已变化，请重新选择。');
          hoveredMarker.current=event.marker&&!releasing?resolveMarker(event.marker):null;hoveredRecord.current=remoteRecord;
          if((event.heldUsed||current.revision!==model.revision)&&heldPointerKey.current)heldPointerKey.current.used=true;
          keyEventRef.current(new KeyboardEvent(event.release?'keyup':'keydown',{key:event.key,code:event.key===' '?'Space':event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,repeat:event.repeat,cancelable:true}),event.release,true);
        },
        clear:event=>{if(event.kind==='selection')select(EMPTY_SELECTION);else if(event.kind==='frozen')execute({type:'clear-shared-freezes'});else if(event.kind==='coordinates')clearCoordinates();else throw new Error('未知清空操作。');},
        save:()=>save(),
        'file-action':event=>{if(event.action==='import')return importFiles();if(event.action==='export-structure')return save();setImageExportOpenRequest(value=>value+1);},
        'display-settings':event=>changeDisplay(event.display),
        'axes-visible':event=>{if(latest.current.props.onSharedShowAxesChange)latest.current.props.onSharedShowAxesChange(event.visible);else setLocalShowAxes(event.visible);},
    },
  });
  useEffect(()=>{props.onViewportController?.(viewportController);return()=>props.onViewportController?.(null);},[props.onViewportController,viewportController]);
  useEffect(()=>{if(!props.onXtbController)return;props.onXtbController({runMcpXtb:(calculation,options,timeoutSeconds)=>runMcpXtbRef.current(calculation,options,timeoutSeconds)});return()=>props.onXtbController?.(null);},[props.onXtbController,xtb]);
  const cellGuides = useMemo<CellPresentationOptions|undefined>(() => {
    if (props.advancedModelingRoute?.category !== 'periodic') return;
    if (tiledTransform) return { preview: structurePreview?.structure.cell };
    return { current:model.draft.structure.cell, checkpoint:model.cellCheckpoint?.structure.cell, preview:structurePreview?.structure.cell };
  }, [props.advancedModelingRoute, props.derivedSupercellSource, model.draft.structure.cell, model.cellCheckpoint, structurePreview, tiledTransform]);
  const previewGuides = !referenceCapture.viewportCapture ? (tiledTransform ? validTransformPresentation?.candidateGuides : validTransformPresentation?.guides) : undefined;
  const previewCell = !referenceCapture.viewportCapture ? validTransformPresentation?.sourceCell : undefined;
  const viewportState:WorkspaceViewportState={documentId:model.id,revision:model.revision,display:viewportDisplay,interaction,highlights:advancedObservation?undefined:highlights,bondOrderEntries:advancedObservation?undefined:model.bondOrderObservation?.entries,workspaceInputRoles:props.workspaceInputRoles,workspaceDocumentPickMode:props.workspaceDocumentPickMode,workspaceDocumentPickSelected:props.workspaceDocumentPickSelected,
    cellGuides, previewGuides, previewCell, cellHover:true,
    problemAtomIds:advancedObservation?undefined:problemAtomIds,problemDiagnostic:advancedObservation?undefined:optimizationNotice||error,temporaryPointerMode:effectivePointerMode,freezeRemovalMode:props.freezeEditingAllowed!==false&&!temporaryPointerMode&&freezeTool==='remove',effectiveFrozenAtomIds:getFrozenAtomIds(model),displayFrozenAtomIds,stateMarkers,
    selectionShortcut:shortcuts.bindings.select.toUpperCase(),selectShortcut:shortcuts.bindings.select,freezeShortcut:shortcuts.bindings.freeze,measurement,persistentTool,fragmentTool:{templateId:copiedTool?'复制片段':template,activeAtomIndex:copiedTool?copyActiveIndex:activeFragmentIndex},captureRequest:props.captureRequest,captureAtomIds,numberingPickActive:Boolean(props.onAtomNumberPick),linkedAtomsActive:props.linkedAtomsActive??false,
    interactionOwnerActive:props.active!==false,interactionActivationEpoch:props.activationStamp?.().activationEpoch,cameraRequest,cameraView,showAxes,legendVisible:presentationActive&&!props.onLegendSurfaceChange,structureLocked,readOnly:props.observationOnly||structureAnalysisOpen,allowModelEditing:!structureLocked,freezeEditingAllowed:props.freezeEditingAllowed,editingDocument:props.analysisCanvas?.staticDocument?{...props.analysisCanvas.staticDocument,revision:model.revision,selection:workingSelection}:viewportModel===model?undefined:model,observationTool:freezeTool==='box'?'box':observationTool,resetViewRequest,
    viewTransform:props.analysisCanvas?.viewport.viewTransform??props.initialViewTransform,observationTransform:mdObservationTransform,observationAnchorAtomIds:mdDisplayFrame?.nativeMD?.protectedAtomIds,
    observationReference:xtbFrameCurrent?viewportObservation?.reference:observeDynamics?dynamicState.referenceStructure:undefined,observationEpoch:xtbFrameCurrent?viewportObservation?.epoch:observeDynamics?dynamicState.sessionId:undefined,observationFrame:xtbFrameCurrent?viewportObservation?.frame:observeDynamics?shownDynamicsFrame?.seq:undefined,
    cellEditor:validCellEditorDraft?{documentId:validCellEditorDraft.documentId,expectedRevision:validCellEditorDraft.expectedRevision,cell:validCellEditorDraft.cell,lengths:validCellEditorDraft.lengths,activeAxis:validCellEditorDraft.activeAxis}:undefined,
    samplingSphereEditor:props.samplingSphereDraft?.sourceDocumentId===model.id&&props.samplingSphereDraft.sourceRevision===model.revision?props.samplingSphereDraft:undefined,
    trajectoryPlayback:props.analysisCanvas?.trajectoryPlayback?.state,
    error,dockTarget:props.viewportDockTarget};
  // This callback stays inside the owner renderer and carries immutable Store
  // snapshots. Wire admission belongs to the actual shared-window publication.
  useEffect(()=>{const listener=props.onViewportState;if(!listener)return;const signature=JSON.stringify(viewportState);if(lastViewportState.current?.listener===listener&&lastViewportState.current.signature===signature)return;lastViewportState.current={listener,signature};listener(viewportState);});
  async function geometryClean(scope: PreoptimizationScope = 'all') {
    await unifiedOptimize(scope,'geometry');
  }
  async function unifiedOptimize(range:OptimizationScope=optimizationScope,choice:OptimizationChoice=optimizationChoice){
    if(!structureEditAllowed()||optimization.busy)return;
    cancelManualGeometry();if(keyboard.getSnapshot().gesture==='fragment')endGesture(false);
    cancelTask();
    try{if(staleAssignments)throw new Error('任务分区已变化，请重新确认当前模型上下文。');if(partialPeriodicBox)throw new Error('周期矢量不完整，不能运行整理。');if(hasPeriodicBox&&choice!=='geometry')throw new Error('周期模型的此入口仅支持机械调整；GFN方法请使用xTB。');if(choice!=='geometry'){if(runtimeElectronicInvalid)throw new Error('请先核对有效电荷和多重度，再运行力场优化。');const current=store.getSnapshot();assertOrcaForcefieldTargets(current.draft.structure,effectiveModelCoordinates(current));}setError('');setOptimizationBusy(true);await optimization.run(choice,range,optimizationMaxSteps);}catch(cause){setError(message(cause));}finally{store.clearScientificEditApproval?.();setOptimizationBusy(false);}
  }
  async function spaceOptimize(){
    if(optimizationPreferences.defaultKind==='forcefield'){await unifiedOptimize();return;}
    const options=xtbPanelSubmission({...optimizationPreferences.xtb,...xtbElectronic});
    if(!options){setError('请先核对当前模型的xTB电荷和多重度。');return;}
    await runXtb(options);
  }
  const measurementOptions=[['auto','自动测量'],['distance','B 键长'],['angle','A 键角'],['dihedral','D 二面角']] as const;
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
    {id:'model.clean',label:'全分子',content:<button data-testid="builder-optimize-all" disabled={structureLocked||periodic||busy||!atoms.length} onClick={()=>void chemistry('optimize')}>🧹 全分子</button>},
    {id:'model.cleanSelection',label:'仅选区',content:<button data-testid="builder-optimize-local" disabled={structureLocked||periodic||busy||!indices.length} onClick={()=>void chemistry('optimize',true)}>仅选区</button>},
    {id:'model.geometry',label:'机械几何整理',content:<button data-testid="model-geometry-clean" disabled={structureLocked||partialPeriodicBox||busy||!atoms.length} title="机械目标成本不表示物理势能" onClick={()=>void geometryClean()}>机械几何整理</button>},
    {id:'model.perceive',label:'判断成键',content:<button disabled={structureLocked||periodic||busy||!atoms.length} onClick={()=>void chemistry('perceive-bonds')}>判断成键</button>},
    {id:'model.rebuild',label:'重新识别',content:<button disabled={structureLocked||periodic||busy||!atoms.length} onClick={()=>{if(confirmSynchronousOperation('重新识别将替换全部化学键并清除删键记录，继续？',scope.current?.ownerDocument))void chemistry('perceive-bonds',false,true);}}>重新识别</button>},
    {id:'model.cancel',label:'取消整理',content:<button disabled={!busy} onClick={()=>{cancelTask();setStatus('已取消，保留原几何。');}}>取消整理</button>,criticalContent:<button disabled={!busy} onClick={()=>{cancelTask();setStatus('已取消，保留原几何。');}}>取消整理</button>},
    {id:'model.delete',label:'删除',content:<button disabled={structureLocked||(!indices.length&&!workingSelection.bonds.length&&!workingSelection.auxiliaryIds.length&&!workingSelection.portIds?.length&&!workingSelection.coordinateIds?.length)} onClick={deleteSelectedObjects}>删除</button>},
    {id:'model.copy',label:'复制',content:<button onClick={()=>void copy()}>复制</button>},
    {id:'model.paste',label:'粘贴',content:<button disabled={structureLocked} onClick={()=>void paste()}>粘贴</button>},
    {id:'model.extract',label:'提取',content:<button disabled={structureLocked||!onExtract||!indices.length||model.draft.dirty||busy} onClick={onExtract}>提取</button>},
    {id:'atom.setCharge',label:'设电荷',content:<button disabled={structureLocked||!indices.length} onClick={()=>legacy({type:'change-charge',atomIds:workingSelection.atomIds,charge})}>设电荷</button>},
    {id:'bond.set',label:'成键',content:<button disabled={structureLocked||indices.length!==2} onClick={()=>execute({type:'set-bond-order',atomIds:workingSelection.atomIds as [string,string],order:bondOrder})}>成键</button>},
    {id:'bond.break',label:'断键留端',content:<button data-testid="model-break-bond" disabled={structureLocked||workingSelection.bonds.length!==1} onClick={()=>{const bond=workingSelection.bonds[0];if(bond)execute({type:'break-bond',atomIds:bond.atomIds,image:bond.image});}}>断键留端</button>},
    {id:'atom.addH',label:'加一个H',content:<button disabled={structureLocked||indices.length!==1} onClick={()=>execute({type:'add-single-hydrogen',atomId:workingSelection.atomIds[0]})}>加一个H</button>},
    {id:'select.freeze',label:'冻结选择',content:<button disabled={freezeLocked||!indices.length} onClick={()=>execute({type:'set-shared-atom-freeze',atomIds:workingSelection.atomIds,frozen:true})}>冻结选择</button>},
    {id:'select.unfreeze',label:'解冻选择',content:<button disabled={freezeLocked||!indices.length} onClick={()=>execute({type:'set-shared-atom-freeze',atomIds:workingSelection.atomIds,frozen:false})}>解冻选择</button>},
    {id:'elements',label:'元素与几何',content:<><fieldset disabled={structureLocked}><div className="model-tools model-element-tools">{['H','C','N','O','F','P','S','Cl','Br','I'].map(element=><button key={element} aria-pressed={interaction.element===element} onClick={()=>setElement(element)}>{element}</button>)}<button aria-expanded={periodicTable} onClick={()=>setPeriodicTable(value=>!value)}>周期表</button><output aria-label="当前元素" data-testid="model-current-element">{interaction.element??'—'}</output></div>{periodicTable&&<ElementTable onSelect={element=>{setElement(element);setPeriodicTable(false);}}/>}<ElementPresetPalette selectionId={presetId} element={interaction.element??undefined} onChange={chooseElementPreset}/></fieldset></>},
    {id:'selection',label:'原子编号',content:<div className="model-tools model-number-tools"><label>编号<input aria-label="已选原子编号" data-testid="builder-selection-input" value={selectionInput} onChange={event=>setSelectionInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();selectNumbers();}}} placeholder="1-5,8"/></label><button onClick={selectNumbers}>选择编号</button><span>{indices.length}/{atoms.length}</span></div>},
    {id:'measurement',label:'测量顺序',content:<output data-testid="model-measurement-ids" className="model-blue-measurement-ids">{measurement.atomIds.map(id=>atoms.findIndex(atom=>atom.id===id)+1).join(' → ')||'按顺序点选原子；空白清测量'}</output>},
    {id:'dynamics',label:'动态',essential:true,content:props.realtime?<DynamicsPanel controller={dynamics} beforeStart={prepareDynamicsStart} onStartFailure={()=>store.clearScientificEditApproval?.()} disabled={periodic||!atoms.length||busy||geometryEditing||runtimeElectronicInvalid||xtbState.running} geometryDisabled={periodic||!atoms.length||busy||geometryEditing||xtbState.running}/>:<span>实时工作台可使用动态观察</span>,criticalContent:<button data-testid="model-critical-stop" disabled={!structureLocked} onClick={()=>void stopActiveOptimization()}>Stop / 停止</button>},
    {id:'bonds',label:'原子与键参数',content:<fieldset disabled={structureLocked}><div className="model-tools"><label>电荷<NumericInput aria-label="原子形式电荷" stepper value={charge} onChange={event=>setCharge(Number(event.target.value))}/></label><label>键<select aria-label="建模键级" value={bondOrder} onChange={event=>setBondOrder(Number(event.target.value) as BondOrder)}>{[1,2,3,1.5,.5].map(value=><option value={value} key={value}>{value}</option>)}</select></label><label>识别<select aria-label="成键识别强度" value={aggression} onChange={event=>setAggression(event.target.value as BondAggression)}><option value="conservative">保守</option><option value="standard">标准</option><option value="aggressive">积极</option></select></label></div></fieldset>},
    {id:'geometry',label:'几何与变换',content:<fieldset disabled={structureLocked}><GeometrySmartSlide {...measurementBondControls()} measurementImages={activeMeasurement?.mode==='distance'?activeMeasurement.images:undefined} structure={editingStructure} measurementAtomIds={measurement.atomIds} selectedAtomIds={workingSelection.atomIds} fixedAtomIds={getFrozenAtomIds(model)} onScopeChange={value=>{geometryScope.current=value;}} disabled={structureLocked||busy} onBegin={()=>beginManualGeometry(undefined)} onPreview={previewManualGeometry} onCommit={commitManualGeometry} onCancel={cancelManualGeometry} onError={setError}/><details className="model-secondary"><summary>选择变换</summary><div className="model-tools"><select aria-label="变换轴" value={axis} onChange={event=>setAxis(event.target.value as typeof axis)}>{['x','y','z'].map(value=><option key={value}>{value}</option>)}</select><NumericInput aria-label="旋转角度" value={degrees} onChange={event=>setDegrees(event.target.value)}/><button disabled={!indices.length} onClick={()=>legacy({type:'rotate',atomIds:workingSelection.atomIds,axis,degrees:Number(degrees)})}>旋转选择</button><button disabled={!indices.length} onClick={()=>legacy({type:'reflect',atomIds:workingSelection.atomIds,axis})}>镜像</button><button disabled={indices.length!==1} onClick={()=>legacy({type:'invert-center',atomId:workingSelection.atomIds[0]})}>反转中心</button>{['x','y','z'].map((name,index)=><label key={name}>{name}<NumericInput aria-label={'平移 '+name} step=".1" value={translation[index]} onChange={event=>setTranslation(translation.map((value,i)=>index===i?Number(event.target.value):value) as Vector3)}/></label>)}<button data-testid="builder-translate" disabled={!indices.length} onClick={()=>execute({type:'transform-fragment',atomIds:workingSelection.atomIds,delta:translation})}>平移选择</button></div></details></fieldset>},
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
    {id:'bond.perceive',label:'判断成键',tooltip:'按所选方法重新判断全部化学键，可增删连接和修正键级',content:<BondPerceptionControls method={bondPerceptionMethod} periodic={hasPeriodicBox} periodicGfn2Available={periodicGfn2Available} parameters={empiricalParameters} elements={atoms.map(atom=>atom.element)} disabled={structureLocked||partialPeriodicBox||busy||optimizationBusy||geometryEditing||!atoms.length||props.active===false} onMethodChange={setBondPerceptionMethod} onPerceive={parameters=>void perceiveBonds(parameters)}/>},
    {id:'bond.display',label:'显示成键',content:<button type="button" data-testid="model-show-bonds" onClick={()=>changeDisplay({...display,showBonds:display.showBonds===false})}>{display.showBonds===false?'显示成键':'不显示成键'}</button>},

    {id:'preopt',label:'优化 / Space',lockedSpan:4,content:<>
      <section className="model-preopt-unified xtb-optimization-panel" role="group" aria-label="统一优化" data-testid="forcefield-optimization-panel">
        <header className="optimization-panel-header"><strong>{hasPeriodicBox?'周期机械调整':'力场预优化'}</strong><button type="button" className="model-space-default" aria-label="力场设为空格默认" aria-pressed={optimizationPreferences.defaultKind==='forcefield'} disabled={structureLocked||busy||optimizationBusy} onClick={()=>updateOptimizationPreferences({...optimizationPreferences,defaultKind:'forcefield'})}>{optimizationPreferences.defaultKind==='forcefield'?'空格默认':'设为空格默认'}</button></header>
        <div className="optimization-primary-row">
          <label className="xtb-optimization-method"><span>方法</span><select aria-label="优化方法" value={optimizationChoice} disabled={structureLocked||optimizationBusy||busy||geometryEditing} onChange={event=>setOptimizationChoice(event.target.value as OptimizationChoice)}>{!hasPeriodicBox&&<><option value="auto">AUTO</option><option value="UFF">UFF</option><option value="MMFF94">MMFF94</option></>}<option value="geometry">机械调整</option></select></label>
          <label><span>范围</span><select aria-label="优化范围" value={optimizationScope} disabled={structureLocked||optimizationBusy||busy||geometryEditing} onChange={event=>setOptimizationScope(event.target.value as OptimizationScope)}><option value="all">全体</option><option value="selection" disabled={!indices.length}>选区</option><option value="unselected" disabled={indices.length===atoms.length}>非选区</option></select></label>
          <button data-testid="builder-optimize-all" disabled={structureLocked||optimizationBusy||partialPeriodicBox||busy||geometryEditing||!atoms.length||optimizationChoice!=='geometry'&&runtimeElectronicInvalid||optimizationScope==='selection'&&!indices.length||optimizationScope==='unselected'&&indices.length===atoms.length} onClick={()=>void unifiedOptimize()}>优化</button><button className="optimization-stop" data-testid="model-critical-stop" disabled={!structureLocked} onClick={()=>void stopActiveOptimization().catch(cause=>setError(message(cause)))}>停止</button>
        </div>
        {optimizationNotice&&<p className="xtb-optimization-status" data-testid="model-optimization-notice" role="status">{optimizationNotice}</p>}
      </section>
      <XtbOptimizationPanel bondRebuildAvailable={!hasPeriodicBox} selectionCount={indices.length} atomCount={atoms.length} electronicState={xtbElectronic} onElectronicStateChange={changeXtbElectronic} optimizationOptions={optimizationPreferences.xtb} onOptimizationOptionsChange={xtb=>updateOptimizationPreferences({...optimizationPreferences,xtb})} spaceDefault={optimizationPreferences.defaultKind==='xtb'} onSetSpaceDefault={()=>updateOptimizationPreferences({...optimizationPreferences,defaultKind:'xtb'})} requireMultiplicity={!hasPeriodicBox&&bondPerceptionMethod==='gfn2'} documentKey={model.id} initialCharge={electronicRequest?.charge ?? model.draft.structure.charge ?? null} initialMultiplicity={electronicRequest?.multiplicity ?? model.draft.structure.multiplicity ?? null} disabled={props.active === false || partialPeriodicBox || !atoms.length || busy || geometryEditing || optimizationBusy || ['starting','running','pausing','paused','stopping'].includes(dynamicState.status)} running={xtbState.running} status={xtbOptimizationDisplayStatus(xtbState,shownXtbFrame)} error={xtbState.error} metadata={xtbState.metadata} atomLabels={Object.fromEntries(atoms.map((atom,index)=>[atom.id,index+1]))} onOptimize={runXtb} onStop={() => xtb.stop()} />
      {xtbState.canContinue&&!xtbState.running&&<button type="button" className="shared-input-action" disabled={busy||optimizationBusy||props.active===false} onClick={()=>void xtb.continueOptimization(optimizationPreferences.xtb.maxSteps,optimizationPreferences.xtb.maxSccIterations).catch(cause=>setError(message(cause)))}>继续优化</button>}
    </>},




  ];
  const modelSettings=<>
        <ElementColorControls atoms={atoms} display={display} onChange={changeDisplay}/>
        <DisplayPresetControls snapshot={displayDefaults} busy={displayDefaultsBusy} status={displayDefaultsStatus} error={displayDefaultsError} onSave={()=>void persistDisplayDefaults()} onRestore={()=>void persistDisplayDefaults(true)}/>
        {model.draft.structure.cell&&<label><input type="checkbox" aria-label="保存包含晶胞" checked={withCell} onChange={event=>setWithCell(event.target.checked)}/>保存包含晶胞</label>}
      </>;
  async function exportCurrentViewport(options:ViewportImageExportOptions,ownerDocument:Document){
    const canvas=props.analysisCanvas,box=stageRef.current?.querySelector('.model-transform-candidate .model-viewport-stage')?.getBoundingClientRect();
    if(!box||box.width<=0||box.height<=0){setError('当前视口不可见，未导出其他对象的画布。');return;}
    const actual={...options,viewportWidth:box.width,viewportHeight:box.height,measurement:structuredClone(measurement)};
    if(canvas&&!canvas.useWorkspaceImageExport){if(!canvas.onExportImage){setError('当前分析尚未提供统一导出入口。');return;}await canvas.onExportImage(actual,ownerDocument);return;}
    if(imageExportAbort.current)return;
    const controller=new AbortController();imageExportAbort.current=controller;setImageExporting(true);
    try{
      const view=viewportGetter.current?.()??cameraView;
      if(!view)throw new Error('当前视角尚未就绪。');
      const exportViewport=canvas?.viewport??structureAnalysis.viewport;
      const snapshot={document:structuredClone(viewportModel),displayFrozenAtomIds:displayFrozenAtomIds?[...displayFrozenAtomIds]:undefined,cameraView:[...view],display:structuredClone(viewportDisplay),showAxes,width:1600,height:1200,viewportWidth:box.width,viewportHeight:box.height,measurement:structuredClone(measurement),cellGuides,previewGuides,previewCell,multiframeDisplay:exportViewport.multiframeDisplay,samplingSphere:viewportSamplingSphere(viewportModel,props.samplingSphereDraft,exportViewport.samplingSphere),calculationRanges:exportViewport.calculationRanges,viewTransform:exportViewport.viewTransform??props.initialViewTransform??mdObservationTransform,surfaceLayer:exportViewport.surfaceLayer,resultAtomLabels:exportViewport.resultAtomLabels,resultBondValues:exportViewport.resultBondValues,resultBondLabels:exportViewport.resultBondLabels,resultHighlights:exportViewport.resultHighlights,resultColorbar:exportViewport.resultColorbar};
      const blob=await exportViewportImage(snapshot,actual,ownerDocument,controller.signal);
      if(!controller.signal.aborted)exportBlob(blob,`${viewportModel.draft.structure.name||'Ester-Studio'}.${options.format}`,ownerDocument);
    }catch(cause){if(!controller.signal.aborted)setError(message(cause));}
    finally{if(imageExportAbort.current===controller)imageExportAbort.current=null;setImageExporting(false);}
  }
  const header=<ModelWorkspaceToolbar display={display} onDisplayChange={changeDisplay} onActivate={props.onActivate} readOnly={structureLocked} historyReadOnly={historyLocked}
    onOpenSettings={props.onOpenSettings} atoms={atoms} targetLabel={props.documentName??model.draft.structure.name} hasCell={!!model.draft.structure.cell} showAxes={showAxes} onShowAxesChange={value=>{if(props.onSharedShowAxesChange)props.onSharedShowAxesChange(value);else setLocalShowAxes(value);}}
    onNew={props.onNewDocument?undefined:newModel} onImport={()=>window.sciyueDesktop?void importFiles():fileInput.current?.click()} onOpenStructureLibrary={props.onOpenStructureLibrary} onSave={()=>void save()} onOpen2D={()=>{if(props.onOpenTwoD){if(structureEditAllowed())props.onOpenTwoD();}else{setPlaneRetained(true);setPlane(true);}}} onUndo={()=>history('undo')} onRedo={()=>history('redo')}
    disabled={{new:structureLocked&&!props.onNewDocument,import:structureLocked&&!props.onImportFiles,save:!atoms.length,open2D:structureLocked||periodic,undo:!(props.workspaceCanUndo??model.canUndo)||historyLocked&&store.getHistoryKind?.('undo')!=='selection',redo:!(props.workspaceCanRedo??model.canRedo)||historyLocked&&store.getHistoryKind?.('redo')!=='selection'}}
    layoutActions={props.layoutActions} settingsContent={modelSettings}
    imageExport={<ViewportImageExportMenu openRequest={imageExportOpenRequest} getViewportSize={()=>{const box=stageRef.current?.querySelector('.model-transform-candidate .model-viewport-stage')?.getBoundingClientRect();return box?{width:box.width,height:box.height}:undefined;}} disabled={!viewportModel.draft.structure.atoms.length||props.analysisCanvas?.exportAvailable===false} exporting={imageExporting||props.analysisCanvas?.exporting} onExport={exportCurrentViewport}/>}
    actions={props.analysisCanvas?.toolbarActions}
    view={{showAxes,hasAtoms:!!atoms.length,hasCell:Boolean(model.draft.structure.cell),showCell:display.cell,onCamera:requestCamera,onReset:()=>setResetViewRequest(value=>value+1),onToggleAxes:toggleAxes,onToggleCell:()=>changeDisplay({...display,cell:!display.cell})}}/>;
  useEffect(()=>{
    if(props.active===false)return;
    const bridge=window.sciyueDesktop;
    void bridge?.updateWorkbenchFileState?.({canImport:!structureLocked||!!props.onImportFiles,canExportStructure:atoms.length>0&&!saveBusyRef.current,canExportImage:viewportModel.draft.structure.atoms.length>0&&props.analysisCanvas?.exportAvailable!==false&&!imageExporting}).catch(()=>{});
  },[props.active,props.onImportFiles,structureLocked,atoms.length,viewportModel.draft.structure.atoms.length,props.analysisCanvas?.exportAvailable,imageExporting]);
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
    const common={document:model,open:true,embedded:true,previewActive:active,previewLive:transformSession.live[key]??true,
      onPreviewLiveChange:(enabled:boolean)=>updateTransformSession(value=>({...value,live:{...value.live,[key]:enabled}})),
      disabled:transformDisabled,onPrepare:prepareTransform,onApply:applyTransform,
      onPreviewChange:(candidate:StructureTransformCandidate|null)=>{if(ownsTransform(category,task)&&candidate===null)setStructurePreview(null);},
      onPreviewPresentationChange:(presentation:TransformPreviewPresentation|null)=>{if(ownsTransform(category,task)){setTransformPresentation(presentation);setStructurePreview(presentation?.candidate??null);}},
      onClose:()=>closeTransformTask(task)};
    if(category==='periodic')return <PeriodicModelingPanel key={key} {...common} operation={task as PeriodicModelingTask}
      draft={(transformSession.drafts[key] as PeriodicModelingDraft|undefined)??initialPeriodicModelingDraft(model.draft.structure)}
      onDraftChange={draft=>updateTransformSession(value=>({...value,drafts:{...value.drafts,[key]:draft}}))}
      cellEditorDraft={transformSession.cell} onCellEditorDraftChange={cell=>updateTransformSession(value=>({...value,cell}))}
      previewResult={active?crystalPreviewResult:null} onInspect={inspectCrystal} onCommitEdit={commitCellEdit}
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
  useLayoutEffect(()=>{if(props.active!==false)props.onToolSurfaceChange?.(sharedTools);if(props.active!==false)props.onLeftToolSurfaceChange?.(structureToolPanel);if(presentationActive)props.onToolbarSurfaceChange?.(header);});
  function workspaceOverlay(content:ReactNode){
    if(props.sharedLayout&&props.active===false)return null;
    const body=scope.current?.ownerDocument.body??(typeof document==='undefined'?null:document.body);
    return props.sharedLayout&&body?createPortal(<div className="model-workspace-floating-content" data-document-id={model.id}>{content}</div>,body):content;
  }
  return <section ref={scope} tabIndex={0} className="model-workspace builder-workspace" data-testid="builder-workspace" data-tool-portal={Boolean(props.toolHost)} data-shared-layout={Boolean(props.sharedLayout)} data-structure-locked={structureLocked} data-periodic={periodic} data-capture-kind={props.captureRequest?.kind??''} data-capture-purpose={props.captureRequest?.purpose??''} aria-label="桌面建模工作区" onPointerDownCapture={event=>{props.onActivate?.();setProblemAtomIds([]);if(!editableTarget(event.target))event.currentTarget.ownerDocument.getSelection()?.removeAllRanges();if(scope.current?.contains(event.target as Node)&&!editableTarget(event.target)&&!(event.target instanceof Element&&event.target.closest('button,[data-layout-editing="true"],[data-workbench-layout-control]')))scope.current.focus({preventScroll:true});}}>
    {!props.onToolbarSurfaceChange&&(props.sharedLayout?(presentationActive&&props.toolbarHost?createPortal(header,props.toolbarHost):null):header)}
    <input hidden ref={fileInput} type="file" multiple onChange={event=>{void importFiles(event.target.files);event.target.value='';}}/>
    {!props.onLeftToolSurfaceChange&&structureToolPanel&&workspaceOverlay(structureToolPanel)}
    {bondElectronicPrompt&&workspaceOverlay(<DialogSurface aria-label="GFN2电子态确认" className="model-inline-dialog model-bond-electronic-dialog" onCancel={()=>setBondElectronicPrompt(null)}><strong>GFN2 成键判断</strong><label>电荷<NumericInput aria-label="GFN2电荷" stepper step="1" value={bondElectronicPrompt.charge} onChange={event=>setBondElectronicPrompt({...bondElectronicPrompt,charge:event.target.value})}/></label><label>多重度<NumericInput aria-label="GFN2多重度" stepper min="1" step="1" value={bondElectronicPrompt.multiplicity} onChange={event=>setBondElectronicPrompt({...bondElectronicPrompt,multiplicity:event.target.value})}/></label><button onClick={()=>setBondElectronicPrompt(null)}>取消</button><button onClick={()=>{const pending=bondElectronicPrompt,current=store.getSnapshot(),electronic={charge:Number(pending.charge),multiplicity:Number(pending.multiplicity)};if(current.id!==pending.documentId||current.revision!==pending.revision||!bondElectronicDraftCurrent(current,pending.context)){setBondElectronicPrompt(null);return;}const issue=!pending.charge.trim()||!pending.multiplicity.trim()?'请填写电荷和多重度。':electronicStateError(current.draft.structure.atoms,electronic.charge,electronic.multiplicity);if(issue){setError(issue);return;}changeXtbElectronic(electronic);const confirmed=captureBondElectronicDraft(store.getSnapshot(),electronic);setBondElectronicConsent(confirmed);setBondElectronicPrompt(null);void perceiveBonds(undefined,confirmed);}}>确认并运行</button></DialogSurface>)}
    {(props.observationOnly||props.analysisCanvas?.trajectoryPlayback)&&props.analysisCanvas?.controls}
    {props.captureRequest&&<div className="model-capture-controls" data-testid="model-capture-controls"><strong>{props.captureRequest.kind==='atoms'?'选择原子':props.captureRequest.kind==='coordinate'?'选择内坐标 · 有序点选2–4个原子或已有B/A/D':`选择${props.captureRequest.kind==='B'?'键长':props.captureRequest.kind==='A'?'键角':'二面角'}`}</strong><output>{captureAtomIds.map(id=>atoms.findIndex(atom=>atom.id===id)+1).join(' → ')||`点选原子 · ${shortcuts.bindings.select.toUpperCase()}框选`}</output><button onClick={confirmCapture}>确定</button><button onClick={props.onCaptureCancel}>取消</button><button onClick={()=>updateCapture([])}>清空本次</button></div>}
    <div ref={stageRef} className="model-stage" data-testid="builder-3d-view" style={workbenchLayout.layout.paneSizes.canvasHeight?{height:workbenchLayout.layout.paneSizes.canvasHeight,flex:'0 0 auto'}:undefined} onPointerDownCapture={event=>{if(heldPointerKey.current&&event.target instanceof Element&&event.target.closest('[data-testid="model-interaction-surface"]'))heldPointerKey.current.used=true;}} onPointerMoveCapture={event=>{pointerInCanvas.current=event.target instanceof Element&&Boolean(event.target.closest('[data-testid="model-interaction-surface"]'));}} onPointerLeave={leaveCanvas}>
     <ViewportErrorBoundary resetKey={`${model.id}:${model.revision}:${props.advancedModelingRoute?.task ?? ''}`} onError={setError}><div className="model-transform-viewports" data-tiled={tiledTransform||undefined}>
{tiledTransform&&<section className="model-transform-source" aria-label="原晶体与切面预览"><span className="model-transform-view-label">原晶体 · 切割范围</span><button className="model-transform-link" type="button" aria-pressed={linkedSlabView} onClick={()=>setLinkedSlabView(value=>!value)}>联动视角</button><ModelViewport document={model} display={display} interaction={interaction} previewGuides={validTransformPresentation?.guides} cellGuides={{current:model.draft.structure.cell,checkpoint:model.cellCheckpoint?.structure.cell}} cellHover readOnly structureLocked active={props.viewportActive??props.active} observationTool="rotate" cameraView={sourceCameraView??cameraView} broadcastCameraDuringGesture onCameraViewChange={acceptSourceCameraView} onViewReady={getView=>{sourceViewportGetter.current=getView;if(getView)acceptSourceCameraView(sourceCameraView??cameraView??getView());}} onSelection={()=>{}} onCommand={()=>{}} onHover={()=>{}} onGestureStart={()=>{}} onGestureEnd={()=>{}} onError={setError} showAxes={showAxes} legendVisible={false}/></section>}
      <section className="model-transform-candidate" aria-label={tiledTransform?'切面与真空候选':'当前结构'}>
      {tiledTransform&&<span className="model-transform-view-label">切面与真空</span>}
      <ModelViewport onCipLabelsUsed={onCipLabelsUsed} sceneOwnerEpoch={(()=>{const lease=props.activationStamp?.();return lease?.documentId===model.id?lease.documentEpoch:undefined;})()} linkedAtomsActive={props.linkedAtomsActive} active={props.viewportActive??props.active} legendVisible={props.legendVisible} legendExpanded={props.legendExpanded} onLegendExpandedChange={props.onLegendExpandedChange} onLegendSurfaceChange={props.onLegendSurfaceChange?surface=>{if(presentationActive)props.onLegendSurfaceChange?.(surface);}:undefined} document={viewportModel} display={viewportDisplay} interaction={interaction} highlights={advancedObservation?undefined:highlights} bondOrderEntries={advancedObservation?undefined:model.bondOrderObservation?.entries}
        previewGuides={previewGuides} previewCell={previewCell} cellGuides={cellGuides}
        cellHover broadcastCameraDuringGesture={tiledTransform}
        onAtomNumberPick={props.onAtomNumberPick}
        problemAtomIds={advancedObservation?undefined:problemAtomIds} problemDiagnostic={advancedObservation?undefined:optimizationNotice||error}
        temporaryPointerMode={effectivePointerMode} freezeRemovalMode={props.freezeEditingAllowed!==false&&!temporaryPointerMode&&freezeTool==='remove'} effectiveFrozenAtomIds={getFrozenAtomIds(model)} stateMarkers={stateMarkers} onAtomStateChange={atomStateChange} onObjectStateChange={objectStateChange} onStateMarkerDelete={deleteStateMarker} onStateMarkerHover={marker=>{hoveredMarker.current=marker;}} onObjectDelete={deletePickedObject}
        getPointerMode={()=>pointerModeAtPress(heldPointerKey.current,freezeTool)}
        getDocument={()=>latest.current.props.observationOnly&&latest.current.props.analysisCanvas?.document?latest.current.props.analysisCanvas.document:latest.current.store.getSnapshot()}
        selectionShortcut={shortcuts.bindings.select.toUpperCase()}
        measurement={measurement} persistentTool={persistentTool} fragmentTool={{templateId:copiedTool?'复制片段':template,activeAtomIndex:copiedTool?copyActiveIndex:activeFragmentIndex}} captureRequest={props.captureRequest} captureAtomIds={captureAtomIds} onCapturePick={capturePick} onCaptureBox={updateCapture}
        viewTransform={props.initialViewTransform} {...props.analysisCanvas?.viewport}
        samplingSphereDraft={viewportState.samplingSphereEditor} onSamplingSphereRadiusChange={props.onSamplingSphereRadiusChange}
        cameraRequest={cameraRequest} cameraView={cameraView} onCameraViewChange={acceptCandidateCameraView} onViewReady={getView=>{viewportGetter.current=getView;props.analysisCanvas?.onViewReady(getView);if(getView)try{const inherited=initialCameraPending.current?props.initialCameraView:cameraView;initialCameraPending.current=false;acceptCameraView(inherited?[...inherited]:getView());}catch(cause){setError(message(cause));}}} showAxes={showAxes} onMeasurementRecordSelect={selectMeasurementRecord} onMeasurementRecordWheel={wheelMeasurementRecord} onMeasurementRecordHover={record=>{hoveredRecord.current=record;}} onMeasurementRecordDelete={deleteMeasurement}
        readOnly={props.observationOnly} allowModelEditing={!structureLocked} freezeEditingAllowed={props.freezeEditingAllowed} editingDocument={props.analysisCanvas?.staticDocument?{...props.analysisCanvas.staticDocument,selection:workingSelection}:model} onBeginModelInteraction={()=>{if(!structureEditAllowed(true))throw new ScientificEditCancelledError();return props.analysisCanvas?.staticDocument?{...props.analysisCanvas.staticDocument,selection:workingSelection}:model;}} structureLocked={structureLocked} cellEditorDraft={validCellEditorDraft} observationTool={freezeTool==='box'?'box':observationTool} resetViewRequest={resetViewRequest} onMeasurementPick={pickCoordinateAtom} onMeasurementBondPick={pickCoordinateBond}
        observationReference={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationReference} observationEpoch={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationEpoch} observationFrame={props.analysisCanvas?.viewport.viewTransform?undefined:viewportState.observationFrame}
        observationTransform={mdObservationTransform} observationAnchorAtomIds={mdDisplayFrame?.nativeMD?.protectedAtomIds}
        onHover={pick=>{hover.current=pick;const current=latest.current.store.getSnapshot();hoverStamp.current={id:current.id,revision:current.revision};}}
        {...structureAnalysis.viewport} {...referenceCapture.viewportCapture?{analysisAtomCapture:referenceCapture.viewportCapture}: {}} {...periodicToolsOpen?{resultHighlights:{atomIds:transformHighlightIds.filter(id=>viewportModel.draft.structure.atoms.some(atom=>atom.id===id)),bondPairs:[]}}:{}} onGestureStart={startGesture} onGestureEnd={endGesture} onGestureCommand={commitFragmentGesture} fragmentCancelEpoch={fragmentCancelEpoch}
        displayFrozenAtomIds={displayFrozenAtomIds} onSelection={select} onCommand={copiedPlacement} onError={setError}/>
      </section>
     </div></ViewportErrorBoundary>
      {!structurePreview&&!props.captureRequest&&!referenceCapture.viewportCapture&&<CanvasClearToolbar containerRef={stageRef} disabled={structureLocked} frozenDisabled={freezeLocked} onClearSelection={()=>select(EMPTY_SELECTION)} onClearFrozen={()=>execute({type:'clear-shared-freezes'})} onClearCoordinates={clearCoordinates}/>}
      {!props.onOpenTwoD&&planeRetained&&workspaceOverlay(<div hidden={!plane} style={plane?undefined:{display:'none'}}><Suspense fallback={<div className="model-plane-window" role="status">正在载入二维编辑器…</div>}><TwoDEditorBridge busy={busy} visible={plane} onGenerate={value=>void generatePlane(value)} onClose={()=>setPlane(false)} onError={setError}
        onImportFiles={props.onImportTwoDFiles?files=>{void props.onImportTwoDFiles!(files).then(opened=>{if(opened)setPlane(false);}).catch(cause=>setError(message(cause)));}:undefined}
        onRecognizeImage={props.onImportTwoDFiles?file=>{void props.onImportTwoDFiles!([file]).then(opened=>{if(opened)setPlane(false);}).catch(cause=>setError(message(cause)));}:undefined}/></Suspense></div>)}
      {geometryOpen&&activeMeasurement&&workspaceOverlay(<><GeometrySmartSlide {...measurementBondControls(activeMeasurement)} measurementImages={activeMeasurement.images} open recordId={activeMeasurement.id} initialPosition={{x:(stageRef.current?.getBoundingClientRect().left??0)+20,y:(stageRef.current?.getBoundingClientRect().top??0)+30}} structure={editingStructure} measurementAtomIds={activeMeasurement.atomIds} selectedAtomIds={workingSelection.atomIds} fixedAtomIds={getFrozenAtomIds(model)} onScopeChange={value=>{geometryScope.current=value;}} disabled={structureLocked||busy} onBegin={beginManualGeometry} onPreview={previewManualGeometry} onCommit={commitManualGeometry} onCancel={cancelManualGeometry} onClose={()=>{cancelManualGeometry();setGeometryOpen(false);}} onError={setError}/><div className="model-coordinate-actions"><button disabled={freezeLocked||busy} onClick={()=>freezeCoordinate(activeMeasurement)}>❄ 冻结此内坐标</button></div></>)}
    </div>
    <div role="separator" aria-label="建模画布高度" aria-orientation="horizontal" tabIndex={0} className="model-canvas-resize" data-testid="model-canvas-resize" onPointerDown={event=>{event.preventDefault();sizeGesture.current={pointerId:event.pointerId,startY:event.clientY,height:stageRef.current?.getBoundingClientRect().height??300};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const own=sizeGesture.current;if(!own||own.pointerId!==event.pointerId)return;const height=clampWorkbenchPaneSize('canvasHeight',own.height+event.clientY-own.startY);workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:height}});}} onPointerUp={event=>{if(sizeGesture.current?.pointerId===event.pointerId){sizeGesture.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}}} onPointerCancel={()=>{sizeGesture.current=null;}} onDoubleClick={()=>workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:0}})} onKeyDown={event=>{if(['ArrowUp','ArrowDown','Home'].includes(event.key)){event.preventDefault();const height=event.key==='Home'?0:clampWorkbenchPaneSize('canvasHeight',(stageRef.current?.getBoundingClientRect().height??300)+(event.key==='ArrowUp'?-20:20));workbenchLayout.updateLayout({...workbenchLayout.layout,paneSizes:{...workbenchLayout.layout.paneSizes,canvasHeight:height}});}}}><span>⋯</span></div>
    {!props.onToolSurfaceChange&&(!props.sharedLayout||props.active!==false||structureAnalysisOpen)&&(props.toolHost?createPortal(sharedTools,props.toolHost):sharedTools)}
    <DismissibleNotice identity={`${model.id}:${errorNotice.revision}`} className="model-error">{error}</DismissibleNotice><DismissibleNotice identity={`${model.id}:${staleAssignments}`} className="model-error">{staleAssignments?'任务分区已变化，请取消草稿后重新编辑。':null}</DismissibleNotice>{model.draft.assignmentIssues.length>0&&<details><summary>分区需复核 · {model.draft.assignmentIssues.length}</summary>{model.draft.assignmentIssues.map((issue,index)=><p key={index}>{issue}</p>)}</details>}
    <DismissibleNotice identity={`${model.id}:${shortcuts.errorRevision}`} className="model-error">{shortcuts.error}</DismissibleNotice>
    {pasteConflict && workspaceOverlay(<DialogSurface aria-label="粘贴晶胞选择" className="model-inline-dialog" onCancel={()=>setPasteConflict(null)}><p>源与目标晶胞不同，选择本次粘贴的晶胞。</p>{([['keep-target', '保留目标晶胞'], ['use-source', '使用源晶胞'], ['omit', '移除晶胞']] as const).map(([cell, label]) => <button key={cell} onClick={() => pastePayload(pasteConflict, { cell })}>{label}</button>)}<button onClick={() => setPasteConflict(null)}>取消</button></DialogSurface>)}
    {importChoices.length > 0 && workspaceOverlay(<DialogSurface aria-label="选择导入结构" className="model-inline-dialog" onCancel={()=>setImportChoices([])}>{importChoices.map((item, index) => <button key={index} onClick={() => importModel(item)}>{item.structure.name}</button>)}<button onClick={() => setImportChoices([])}>取消</button></DialogSurface>)}
    {saveModal && workspaceOverlay(<DialogSurface aria-label="保存模型" className="model-inline-dialog" onCancel={()=>{saveModalGuard.current=null;setSaveModal(false);}}><select aria-label="保存格式" value={saveFormat} onChange={event => setSaveFormat(event.target.value as ModelFormat)}>{getFormatDescriptors({...props,purpose:'structure'}).map(format => <option key={format.id} value={format.id}>{format.label}</option>)}</select><label><input type="checkbox" disabled={!model.draft.structure.cell} checked={withCell} onChange={event => setWithCell(event.target.checked)} />包含晶胞</label><button onClick={() => void writeExport(saveFormat,undefined,undefined,saveModalGuard.current??undefined)}>保存</button><button onClick={() => {saveModalGuard.current=null;setSaveModal(false);}}>取消</button></DialogSurface>)}
    {saveState && workspaceOverlay(<SaveStateDialog key={`${saveState.snapshot.id}:${saveState.snapshot.revision}`} structure={saveState.snapshot.draft.structure} request={saveState.request} onCancel={() => setSaveState(null)} onConfirm={state => {
      try{saveState.assertCurrent();}catch(cause){setSaveState(null);setError(message(cause));return;}
      const current = latest.current.store.getSnapshot();
      const currentRequest = saveState.format === 'inp' ? latest.current.props.orcaJobRequest : latest.current.props.jobRequest;
      if (current.id !== saveState.snapshot.id || current.revision !== saveState.snapshot.revision || JSON.stringify(currentRequest) !== JSON.stringify(saveState.request)) { setSaveState(null); setError('模型或任务设置已变化，请重新保存。'); return; }
      const pending = saveState; setSaveState(null); void writeExport(pending.format, pending.token, state,pending.assertCurrent);
    }} />)}
    {lastChemistryReceipt && <ChemistrySummary receipt={lastChemistryReceipt} />}
    <footer className="model-workspace-actions"><span role="status">{status || (props.realtime?'模型已实时同步':'')}</span>{preparationPortNotice(model.draft.structure) && <span data-testid="model-port-preparation-status" role="status">{preparationPortNotice(model.draft.structure)}</span>}{!props.realtime&&<><button data-testid="builder-cancel" onClick={cancel}>取消草稿</button><button data-testid="builder-apply" className="model-primary" disabled={!model.draft.dirty || busy || staleAssignments || !atoms.length} onClick={apply}>应用结构</button></>}</footer>
    <output data-testid="builder-draft-state" className="model-test-state" aria-hidden="true">{JSON.stringify({ ...model.draft, xtbPreview:shownXtbFrame??null,xtbPhase:xtbState.phase,xtbRunning:xtbState.running,xtbPreviewSkippedFrames:xtbState.previewSkippedFrames??0, bondOrderObservation:model.bondOrderObservation??null, documentId: model.id, electronicStateConfirmed:model.electronicStateConfirmed===true, selection: workingSelection, auxiliaryRelations: model.auxiliaryRelations, attachmentPorts:model.attachmentPorts??[],deletedBonds: model.deletedBonds, canUndo: model.canUndo, canRedo: model.canRedo, undoKind:store.getHistoryKind?.('undo'),redoKind:store.getHistoryKind?.('redo'),sharedConstraints:model.sharedConstraints, coordinateObjects:model.coordinateObjects, gaussianBoundCoordinates:model.gaussianBoundCoordinates, temporaryPointerMode, freezeTool, copiedTool, past: model.draft.past.length, future: model.draft.future.length, busy, display, measurement, measurementSession, persistentTool, captureAtomIds, structureLocked, lastChemistryReceipt,element:interaction.element,presetId,optimizationChoice,optimizationScope,optimizationBusy,optimizationNotice,problemAtomIds,previewKind:activePreview.model?.kind,previewKey:activePreview.model?.key,previewActiveAtomIndex:previewActiveIndex??activePreview.model?.defaultActiveAtomIndex })}</output>

  </section>;
}
