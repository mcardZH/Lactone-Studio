/** Shared ports for the desktop modeler. No runtime, DOM or framework imports. */
import type { BuilderAssignments, BuilderCommand } from '../core/builder-draft';
import type { AtomId, AtomRef, BondRef, ObjectRef, AttachmentPort, MeasurementRecord, MeasurementState, MeasurementSession, AuxiliaryRelation, DeletedBond, ModelCoordinate, ModelCoordinateObject, SharedModelConstraints, GaussianBoundCoordinateDefinition, ModelSelection, ModelDocument, DocumentStamp, NativeMDPolicy, FragmentSnapshot, ClipboardPayload, PastePolicy, PasteConflict, ScientificEditRequest, ScientificEditGuard, GaussianBasisState, XtbBondOrders, BondOrderObservation } from '../core/modeling/contracts';
export type { AtomId, AtomRef, BondRef, ObjectRef, AttachmentPort, MeasurementRecord, MeasurementState, MeasurementSession, AuxiliaryRelation, DeletedBond, ModelCoordinate, ModelCoordinateObject, SharedModelConstraints, GaussianBoundCoordinateDefinition, ModelSelection, ModelDocument, DocumentStamp, NativeMDPolicy, FragmentSnapshot, ClipboardPayload, PastePolicy, PasteConflict, ScientificEditRequest, ScientificEditGuard, GaussianBasisState, BondOrderEntry, XtbBondOrders, BondOrderObservation } from '../core/modeling/contracts';
import type { Bond, JobRequest, Structure, Vector3 } from '../core/types';
import type { OrcaJobRequest } from '../core/orca/types';
import type { DynamicsCommand, DynamicsEvent, DynamicsFrame, DynamicsRequest } from './dynamics/contracts';
import type { XtbRequest, XtbEvent, XtbCoordinateResult, XtbStoppedCoordinateResult, XtbElectronicArtifactBundle } from './xtb/contracts';
import type { AdvancedPathBridge } from './advanced/path-contracts';
import type { ConformerSamplingBridge } from './advanced/sampling-contracts';
import type { AissBridge } from './advanced/docking-contracts';
import type { OcrBridge } from './ocr/contracts';
import type { AdvancedOutputBridge } from './advanced/output-contracts';
import type { SurfaceDisplayPreferencesBridge } from '../results/platform/surface-display-preferences';
import type { ComputeResourceEvidence, ComputeResourcePreferencesBridge } from './resource-preferences';
import type { FirstRunLicenseBridge } from './first-run-license';
import type { WorkbenchPreferences, WorkbenchPreferenceSnapshot, WorkbenchPreferenceUpdate } from './workbench-layout';
import type { CopiedFragmentPlacement, WorkspaceDesktopBridge, WorkspaceMemberAuth } from './workspace-contracts';
import type { PortableDesktopBridge } from './portable-contracts';
import type { EmpiricalBondPerceptionParameters } from '../core/bond-perception-parameters';
import type { StructureTransformCandidate } from '../core/modeling/contracts';
import type { CrystalRequest, CrystalResult } from './crystal-contracts';
import type { PersonalFragmentLibraryData, PersonalFragmentSnapshot } from './personal-fragments';
import type { OrbitalBackendInfo, OrbitalResourceInfo, OrbitalOpenRequest, OrbitalPlanRequest, OrbitalPlan, OrbitalCommand, OrbitalBackendEvent, OrbitalField, WavefunctionMetadata } from '../results/orbital-contracts';
import type { WavefunctionAnalysisRequest, WavefunctionAnalysisResult } from '../results/wavefunction-analysis';
import type { MultiwfnProgressIdentity, MultiwfnProgressSnapshot } from '../results/multiwfn-progress';
import type { InteractionOpenRequest, InteractionSessionInfo, InteractionGenerateRequest, InteractionGeneratedFields, InteractionContributionRequest, InteractionContributions, InteractionRestoreRequest, InteractionCubeExportRequest } from '../results/interaction-contracts';
import type { ExcitationOpenRequest, ExcitationSessionInfo, ExcitationRunRequest, ExcitationResult, ExcitationRestoreRequest, ExcitationExportRequest } from '../results/excitation-contracts';
import type { ReactivityOpenRequest, ReactivitySessionInfo, ReactivityAnalyzeRequest, ReactivityAnalysisResult } from '../results/reactivity-contracts';
import type { HirshfeldOpenRequest, HirshfeldSessionInfo, HirshfeldAnalyzeRequest, HirshfeldAnalysisResult, HirshfeldRestoreRequest, HirshfeldCubeExportRequest } from '../results/hirshfeld-contracts';
import type { SurfaceCapability, SurfaceOpenRequest, SurfaceSessionInfo, SurfaceAnalyzeRequest, SurfaceAnalysisResult, SurfaceGenerateRequest, SurfaceRestoreFieldsRequest, SurfaceGeneratedFields, SurfaceDistributionRequest, SurfaceAreaDistribution, SurfaceImportedCube, SurfaceCubeRegisterRequest, SurfaceCubeExportRequest, SurfaceCubeSourceRef, SurfaceRunState, SurfaceRegionRequest, SurfaceRegionResponse } from '../results/surface-contracts';
export type { PortableToolsRequest, PortableToolsResponse, PortableRuntimeInfo, PortableRuntimeCheck } from './portable-contracts';

/** UI selection intent. The shell binds it to a document/task before capture. */
export interface TaskSelectionIntent {
  engine: 'gaussian' | 'orca'; purpose: 'coordinate' | 'frozen-atoms' | 'active-atoms' | 'layer' | 'fragment' | 'basis';
  rowId: string; taskId?: string; kind: 'B' | 'A' | 'D' | 'atoms' | 'coordinate'; initialAtomIds?: AtomId[];
  /** Text confirmation uses the same identity guard without clearing the modeling selection. */
  origin?: 'interactive' | 'text';
  /** Ephemeral preview only: never mutate the bound scientific row until confirm. */
  onDraftChange?(atomIds: AtomId[], images?: Vector3[]): void;
  onEnd?(result: 'confirmed' | 'cancelled'): void;
  /** false keeps the capture open for a required conflict confirmation. */
  onConfirm(atomIds: AtomId[], images?: Vector3[]): boolean | void;
}
export interface TaskSelectionHandle { confirm(): void; cancel(): void; assertCurrent(): void }
export interface SelectionCaptureRequest {
  requestId: string; documentId: string; revision: number; engineScope: 'gaussian' | 'orca';
  taskId: string; rowId: string; kind: TaskSelectionIntent['kind'];
  purpose: TaskSelectionIntent['purpose']; initialAtomIds: AtomId[];
}
export interface SelectionCaptureResult {
  requestId: string; documentId: string; revision: number; atomIds: AtomId[];
  /** Exact displayed periodic endpoint images; omitted for ordinary molecular picks. */
  images?: Vector3[];
}
export type BondOrder = 1 | 1.5 | 2 | 3 | 0.5;
export type BondPerceptionMode = 'supplement' | 'rebuild';
export type BondAggression = 'conservative' | 'standard' | 'aggressive';
export type ModelCommand =
  | { type: 'ensure-cell-checkpoint' | 'save-cell-checkpoint' | 'restore-cell-checkpoint' | 'remove-cell' }
  | { type: 'apply-structure-transform'; candidate: StructureTransformCandidate }
  | { type: 'reorder-atoms'; atomIds: AtomId[]; documentId: string; expectedRevision: number }
  | { type: 'set-electronic-state'; charge: number; multiplicity: number; confirmed: boolean }
  | { type: 'set-periodic-axes'; pbc: [boolean, boolean, boolean]; evidence?: string }
  | { type: 'place-element'; element: string; position: Vector3; targetAtomId?: AtomId; targetPortId?: string; presetId?: string }
  | { type: 'add-single-hydrogen'; atomId: AtomId }
  | { type: 'place-fragment'; templateId: string; activeAtomIndex?: number; targetAtomId?: AtomId; targetPortId?: string; position: Vector3 }
  | ({type:'place-copied-fragment'} & CopiedFragmentPlacement)
  | { type: 'prepare-2d-hydrogens' }
  | { type: 'delete-objects'; selection?: ModelSelection }
  | { type: 'set-bond-order'; atomIds: [AtomId, AtomId]; order: BondOrder; image?: Vector3 }
  | { type: 'break-bond'; atomIds: [AtomId, AtomId]; image?: Vector3 }
  | { type: 'transform-fragment'; atomIds: AtomId[]; delta?: Vector3; rotation?: { axis: Vector3; degrees: number; pivot: Vector3 }; unwrapPeriodic?: boolean }
  | { type: 'manual-coordinates'; atoms: { id: AtomId; position: Vector3 }[]; documentId: string; expectedRevision: number }
  | { type: 'infer-bonds'; mode: BondPerceptionMode; aggression: BondAggression; perceivedBonds?: Bond[]; perceivedIssues?: Structure['bondPerceptionIssues']; stamp?: DocumentStamp }
  | { type: 'replace-structure'; structure: Structure; assignments?: Partial<BuilderAssignments> }
  | { type: 'replace-document'; fragment: FragmentSnapshot }
  | { type: 'set-assignments'; assignments: BuilderAssignments }
  | { type: 'set-gaussian-basis-state'; state: GaussianBasisState; assignments: BuilderAssignments['basis'] }
  | { type: 'set-internal-coordinates'; coordinates: ModelCoordinate[] }
  | { type:'set-shared-atom-freeze'; atomIds:AtomId[]; frozen:boolean }
  | { type:'set-shared-freezes-enabled'; enabled:boolean }
  | { type:'replace-shared-atom-freezes'; atomIds:AtomId[] }
  | { type:'replace-shared-coordinate-freezes'; coordinates:ModelCoordinate[] }
  | { type:'set-shared-coordinate-freeze'; object:ModelCoordinateObject; frozen:boolean }
  | { type:'clear-shared-freezes' }
  | { type:'upsert-coordinate-object'; object:ModelCoordinateObject }
  | { type:'delete-coordinate-object'; objectId:string }
  | { type:'delete-source-constraint'; scope:'shared'|'gaussian'|'orca'; kind:'atom'|'coordinate'; id:string }
  | { type: 'legacy'; command: BuilderCommand };
export interface ModelStore {
  /** Owner-side guard; replicas cannot begin a canonical edit transaction. */
  hasTransaction?():boolean;
  getSnapshot(): ModelDocument;
  exportProjectState?(options?:{saved?:boolean}): import('../core/modeling/contracts').ModelStoreProjectState;
  restoreProjectState?(state: import('../core/modeling/contracts').ModelStoreProjectState, options?:{deferLinkedHistory?:boolean}): void;
  /** Synchronous owner confirmation, before a bound source is invalidated.
   * Missing/declining guards reject the edit without publishing a mutation. */
  setScientificEditGuard?(guard: ScientificEditGuard | null): void;
  /** Attach a completed structure-analysis context without replacing geometry,
   * resetting history, or superseding an existing imported-source binding. */
  bindAnalysisContext?(bindingId: string, documentId: string, expectedRevision: number): boolean;
  /** One-shot preflight for a gesture/native start. Approval changes no model
   * state and is valid only for this document, binding and exact revision. */
  requestScientificEditApproval?(): boolean;
  clearScientificEditApproval?(): void;
  /** One-shot static observed-frame basis; never changes the document by itself. */
  setScientificEditBase?(structure: Structure | null, selection?: ModelSelection): void;
  /** A rejected synchronous edit retains its immutable method arguments for the application dialog. */
  getPendingScientificEdit?(): Readonly<ScientificEditRequest> | null;
  /** Static observed source for an independent copy's initial Undo baseline. */
  getPendingScientificEditBase?(): Structure | null;
  /** Copy requires an already opened, independent Store; stale intents never replay. */
  resolvePendingScientificEdit?(choice: 'current' | 'copy' | 'cancel', targetStore?: ModelStore): ModelDocument;
  /** Explicit source replacement: same Store/document identity, new clean
   * baseline and empty history. Not a user geometry-edit command. */
  replaceAnalysisSource?(structure: Structure, bindingId: string): void;
  subscribe(listener: () => void): () => void;
  execute(command: ModelCommand): ModelDocument;
  /** One atomic owner transaction, including linked metadata propagation. */
  executeBatch?(commands: readonly ModelCommand[], label?: string): ModelDocument;
  select(selection: ModelSelection): ModelDocument;
  /** Clear ephemeral capture checkmarks without a new Undo step or model revision. */
  clearCaptureSelection?():void;
  beginSelectionTransaction?(): void;
  endSelectionTransaction?(): void;
  /** Local owner history intent; selection-only replay preserves runtime and request identity. */
  getHistoryKind?(direction: 'undo' | 'redo'): 'selection' | 'structure' | null;
  /** Opaque current history boundary. Stable across Undo/Redo; no writable history is exposed. */
  getHistoryCursor?():symbol;
  undo(): ModelDocument; redo(): ModelDocument;
  stamp(movableAtomIds?: AtomId[]): DocumentStamp;
  /** Register an MD-only snapshot permission without changing editor freezes. */
  stampNativeMD(policy: NativeMDPolicy): DocumentStamp;
  acceptCoordinates(result: ChemistryResult): ModelDocument;
  acceptXtbCoordinates(result:XtbCoordinateResult,sourceDocument?:ModelDocument):ModelDocument;
  acceptXtbStoppedCoordinates(result:XtbStoppedCoordinateResult,sourceDocument?:ModelDocument):ModelDocument;
  publishBondOrders(result:XtbCoordinateResult,stamp:DocumentStamp,runId:string):ModelDocument;
  clearBondOrders():void;
  beginTransaction(label?: string): void;
  endTransaction(): void;
  cancelTransaction(): void;
  synchronizeContext(assignments: BuilderAssignments, coordinates: ModelCoordinate[], scope?: 'gaussian' | 'orca'): void;
  synchronizeGaussianBasisState?(state: GaussianBasisState, assignments?: BuilderAssignments['basis']): void;
  getContext(scope: 'gaussian' | 'orca'): { assignments: BuilderAssignments; coordinates: ModelCoordinate[] } | undefined;
  /** Mirrors complete object-bound task rows without enabling them or adding a form-edit Undo step. */
  synchronizeGaussianBoundCoordinates?(definitions:GaussianBoundCoordinateDefinition[]):void;
  setElectronicState(charge: number, multiplicity: number, confirmed?: boolean): void;
  acceptRuntimeFrame(frame: DynamicsFrame,sourceDocument?:ModelDocument): ModelDocument;
  /** Lock structural edits before the first native frame and across Pause. */
  beginRuntimeSession(options?: { isolated: true }): void;
  isRuntimeSessionActive?(): boolean;
  isRuntimeEditingAllowed?(): boolean;
  /** End only runtime frame identity after a terminal event; pause preserves it. */
  finishRuntimeSession(): void;
  copy(scope?:'selection'|'all'): ClipboardPayload;
  paste(payload: ClipboardPayload, policy?: PastePolicy): ModelDocument;
  markApplied(): void;
  /** Record only the snapshot that actually reached persistent storage. */
  markSaved(snapshot: ModelDocument): void;
}

export interface DisplaySettings {
  /** Presentation only; absent in older preferences means visible. */
  showBonds?: boolean;
  /** Missing appearance fields retain the renderer's existing defaults. */
  backgroundColor?: string;
  bondStyle?: { colorMode: 'elements' | 'uniform'; color: string };
  periodicDisplay?: { boundaryStyle: 'thin' | 'stubs'; outerColor: string; images: boolean; rangeAngstrom: number; showCrossBoxBonds?: boolean };
  /** Width is the current-cell stroke diameter in CSS pixels, never Å. */
  cellStyle?: { lineStyle: 'solid' | 'dashed'; color: string; width: number };
  /** Screen-space XYZ widget appearance; lengths do not alter physical axes. */
  axisDisplay?: { colors: { X: string; Y: string; Z: string }; lineWidth: number; length: number; fontSize: number };
  /** Absent in saved v1 preferences preserves the pre-gallery appearance. */
  structurePreset?: import('./appearance-presets').StructureAppearancePresetId | 'custom';
  structureFinish?: import('../results/mesh-appearance').MeshFinishSettings;
  /** Structural meshes only; absent legacy state retains its original renderer. */
  structureLighting?: import('./appearance-presets').StructureLighting;
  /** Optional appearance-only geometry of an explicitly selected gallery style. */
  structureSizing?: import('./appearance-presets').StructureSizingAppearance;
  /** Display-only VDW spheres, independent of the inner representation. */
  vdwShell?: import('./appearance-presets').VdwShellAppearance;
  /** Persisted legacy keys: ball-stick = CPK, stick = Licorice. */
  representation: 'vdw' | 'ball-stick' | 'stick';
  colorMode: 'elements' | 'frozen' | 'basis' | 'layers' | 'fragments';
  atomNumbers: boolean; elementNames: boolean; legend: boolean;
  /** Current-geometry carbon CIP labels only; missing in legacy settings means off. */
  stereochemistry?: boolean;
  /** Camera drag rotation percentage; missing in legacy settings means 100. */
  rotationSpeedPercent?: number;
  regionHighlights: boolean; regionLabels: boolean;
  frozenMarks: boolean; scanMarks: boolean; measurementMarks: boolean;
  fontSize: number; cell: boolean;
  elementColors?: Record<string, string>;
  atomScale?: number;
  /** Bond radius multiplier; absent in older preferences means 1. */
  bondScale?: number;
  /** Global depth fading; 0 disables fog, 1 is strongest. Does not blur labels. */
  depthFade?: number;
  elementScales?: Record<string, number>;
  alignment?: 'auto' | 'heavy' | 'off';
}
export const DEFAULT_DISPLAY: DisplaySettings = {
  structurePreset: 'original',
  representation: 'ball-stick', colorMode: 'elements', atomNumbers: false, elementNames: false, stereochemistry: false, rotationSpeedPercent: 100,
  legend: true, regionHighlights: true, regionLabels: false, frozenMarks: true,
  scanMarks: true, measurementMarks: true, fontSize: 12, cell: true, alignment: 'auto', bondScale: 1, depthFade: 0,
};
export interface ScreenPoint { x: number; y: number }
export interface ScreenRect { left: number; top: number; right: number; bottom: number }
/** A miss need not project onto a drag plane; placement requests compute a real world point separately. */
export type PickResult = ObjectRef | { kind: 'none'; worldPoint?: Vector3 };
export interface ModelKeyEvent {
  key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
  shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; editable?: boolean;
  /** Ephemeral hover identity, never a selection or persisted document field. */
  hoverAtomId?: AtomId;
  hoverKind?: PickResult['kind'];
}
export interface InteractionState {
  element: string | null; box: boolean; alt: boolean;
  gesture: 'none' | 'box' | 'camera' | 'fragment';
}
export type InteractionAction =
  | { type: 'delete' | 'undo' | 'redo' | 'copy' | 'paste' | 'save' | 'escape' }
  | { type: 'add-hydrogen'; atomId?: AtomId }
  | { type: 'measurement-mode'; mode: 'distance' | 'angle' | 'dihedral' }
  | { type: 'carbon-chain'; count: number }
  | { type: 'clear-measurement-pending' | 'select-all' }
  | { type: 'bond-order'; order: BondOrder };
export interface ModelInteractionPort {
  getSnapshot(): InteractionState;
  keyDown(event: ModelKeyEvent): InteractionAction[];
  keyUp(event: ModelKeyEvent): InteractionAction[];
  setElement(element: string | null): void;
  beginGesture(gesture: Exclude<InteractionState['gesture'], 'none'>): void;
  endGesture(): void;
  reset(reason: 'blur' | 'cancel' | 'document-change'): void;
}

export type ForcefieldChoice = 'auto' | 'MMFF94' | 'MMFF94s' | 'UFF';
export type ChemistryOperation = 'generate3d' | 'optimize' | 'perceive-bonds' | 'convert';
export interface ChemistryRequest {
  optimizationPool?: { stageId: string; candidateId: string };
  stamp: DocumentStamp; operation: ChemistryOperation; structure: Structure;
  runIdentity?: { taskId: string; runId: string };
  movableAtomIds: AtomId[]; forcefield?: ForcefieldChoice; steps?: number;
  /** Optional narrower deadline; the native desktop hard cap remains 60 seconds. */
  maxWallTimeSeconds?: number;
  /** Requested runtime budget; the trusted host returns the actual grant. */
  threads?: number;
  memoryBudgetBytes?: number;
  aggression?: BondAggression; format?: ModelFormat;
  /** First import of coordinate-only data; explicit source bonds are never replaced. */
  bondPerceptionPolicy?: 'coordinate-import' | 'composite-v1';
  bondOrderEvidence?: XtbBondOrders;
  empiricalBondParameters?: EmpiricalBondPerceptionParameters;
  constraints?: ModelCoordinate[];
}
export interface ChemistryResult {
  stamp: DocumentStamp; operation: ChemistryOperation; structure: Structure;
  movableAtomIds: AtomId[]; engine: string; engineVersion: string;
  forcefield?: string; before?: number; after?: number; unit?: string;
  converged?: boolean; warnings: string[]; text?: string; format?: ModelFormat;
  resourceGrant?: ComputeResourceEvidence;
  /** Explicit acknowledgement: old native implementations cannot silently satisfy import inference. */
  bondPerceptionPolicy?: 'coordinate-import' | 'composite-v1';
  bondPerceptionSummary?: { method: 'empirical' | 'gfn2-assisted'; bondCount: number; coordinationCount: number; evidenceCount: number; conflictCount: number; rdkitComponentCount: number; fallbackComponentCount: number };
  constraintResiduals?: { type: 'B' | 'A' | 'D'; id?: string; target: number; actual: number; residual: number; unit: 'angstrom' | 'radian' | 'degree' }[];
}
export interface ChemistryJob { promise: Promise<ChemistryResult>; cancel(): void }
export interface ChemistryPort {
  capabilities(): Promise<{ engine: string; native: boolean; operations: ChemistryOperation[] }>;
  start(request: ChemistryRequest): ChemistryJob;
}

export type ModelFormat = 'sciyue' | 'gjf' | 'com' | 'inp' | 'xyz' | 'extxyz' | 'mol' | 'sdf' | 'pdb' | 'cif' | 'poscar';
export interface FormatDescriptor { id: ModelFormat; label: string; extensions: string[] }
export interface OpenedModelFile { name: string; text?: string; path?: string; bytes: number; streamToken?: string }
export interface SaveSelection { status: 'cancelled' | 'selected'; token?: string; format?: ModelFormat; name?: string; path?: string }
export interface ModelHoldKeyPreferences {
  version: string;
  bindings: { select: string; freeze: string };
  writable: boolean;
  error?: string;
}
export interface AnalysisWindowBounds { x?: number; y?: number; width?: number; height?: number }
export interface AnalysisWindowLease { leaseId: string; target: string; instanceId: string; expiresAt: number }
export interface AnalysisWindowEvent {
  leaseId: string; instanceId: string; seq: number;
  kind: 'opened' | 'closed' | 'focus' | 'blur' | 'geometry';
  bounds?: AnalysisWindowBounds;
  reason?: 'user' | 'released' | 'expired' | 'owner-closed' | 'renderer-gone' | 'unsafe-child';
}
export interface RuntimeModelDisplaySnapshot { revision: number; display: DisplaySettings | null }
export interface RuntimeModelDisplayUpdate extends RuntimeModelDisplaySnapshot { accepted: boolean }
export interface RuntimeDisplayBridge {
  readRuntimeModelDisplay(): Promise<RuntimeModelDisplaySnapshot>;
  updateRuntimeModelDisplay(request: { baseRevision: number; display: DisplaySettings }): Promise<RuntimeModelDisplayUpdate>;
  onRuntimeModelDisplay(listener: (snapshot: RuntimeModelDisplaySnapshot) => void): () => void;
}
export interface DesktopBridge extends Partial<WorkspaceDesktopBridge>, Partial<PortableDesktopBridge>, Partial<RuntimeDisplayBridge>, Partial<AdvancedPathBridge>, Partial<ConformerSamplingBridge>, Partial<AissBridge>, Partial<OcrBridge>, Partial<AdvancedOutputBridge>, Partial<SurfaceDisplayPreferencesBridge>, Partial<ComputeResourcePreferencesBridge>, Partial<FirstRunLicenseBridge>, ProjectCompanionBridge {
  taskSystemRequest?(request:{requestId:string;command:string;input:unknown}):Promise<unknown>;
  cancelTaskSystemRequest?(requestId:string):Promise<void>;
  conformerBatchCommand?(command:string,payload:unknown):Promise<unknown>;
  onConformerBatchProgress?(listener:(event:import('./advanced/batch-contracts').ConformerBatchProgress)=>void):()=>void;
  onCitationsOpen?(listener:(request:{documentId?:string})=>void):()=>void;
  exportCitations?(request:{format:'csv'|'bib'|'ris';text:string}):Promise<{cancelled:boolean;path?:string}>;
  syProject?: import('../projects/desktop-bridge').SyProjectInvoke;
  citationRuntimeInfo?():Promise<{electronVersion?:string;nodeVersion?:string;chromiumVersion?:string}>;
  requestProjectAction?(action:'save'|'save-as'|'open'):Promise<{accepted:boolean}>;
  onWorkbenchFileAction?(listener:(request:{action:'import'|'export-structure'|'export-image';documentId?:string})=>void):()=>void;
  updateWorkbenchFileState?(state:{canImport:boolean;canExportStructure:boolean;canExportImage:boolean}):Promise<{accepted:boolean}>;
  onProjectAction?(listener:(action:'save'|'save-as'|'open')=>void):()=>void;
  readProjectWindowPlacements?():Promise<{main:{x:number;y:number;width:number;height:number;maximized:boolean};detached:Record<string,{x:number;y:number;width:number;height:number}>}>;
  restoreProjectWindowPlacement?(bounds:{x:number;y:number;width:number;height:number;maximized?:boolean}):Promise<{restored:boolean}>;
  runCrystalModeling?(request: CrystalRequest): Promise<CrystalResult>;
  info(): Promise<{ version: string; platform: string; nativeChemistry: boolean; periodicGfn2BondOrders?: boolean; physicalCoreCount?: number | null; logicalCpuCount?: number | null; cpuIdentificationStatus?: 'identified' | 'unavailable' | 'unsupported'; cpuIdentificationError?: string | null }>;
  openModelWindow(request?:WorkspaceMemberAuth): Promise<string>;
  prepareAnalysisWindow?(request: { instanceId: string; title: string; bounds?: AnalysisWindowBounds }): Promise<AnalysisWindowLease>;
  releaseAnalysisWindow?(request: { leaseId: string }): Promise<{ closed: boolean }>;
  onAnalysisWindowEvent?(listener: (event: AnalysisWindowEvent) => void): () => void;
  readClipboard(): Promise<ClipboardPayload | null>;
  writeClipboard(payload: ClipboardPayload): Promise<void>;
  writeClipboardText?(text: string): Promise<void>;
  acquireWorkerResources?(request:{id:string;stamp:DocumentStamp}):Promise<import('./resource-preferences').ComputeResourceEvidence>;
  cancelWorkerResources?(id:string):Promise<void>;
  releaseWorkerResources?(id:string):Promise<void>;
  reportPreparedTrajectoryMemory?(bytes:number):Promise<void>;
  beginBinaryExport?(request: {name:string;extension:string}): Promise<{token:string}|null>;
  appendBinaryExport?(token:string, bytes:Uint8Array): Promise<void>;
  commitBinaryExport?(token:string): Promise<{written:true;bytes:number}>;
  abortBinaryExport?(token:string): Promise<void>;
  onModelClipboardChanged?(listener: (event: { version: number }) => void): () => void;
  onWorkbenchLayoutOpen?(listener: () => void): () => void;
  onGlobalSettingsOpen?(listener: () => void): () => void;
  onMultiwfnConfigurationChanged?(listener: (value: import('../results/orbital-contracts').OrbitalBackendInfo) => void): () => void;
  readModelHoldKeyPreferences?(): Promise<ModelHoldKeyPreferences>;
  writeModelHoldKeyPreferences?(request: { baseVersion: string; bindings: ModelHoldKeyPreferences['bindings'] }): Promise<ModelHoldKeyPreferences>;
  restoreModelHoldKeyPreferences?(baseVersion: string): Promise<ModelHoldKeyPreferences>;
  onApplicationClosePreparation?(listener: (request: { requestId: string }) => void): () => void;
  completeApplicationClosePreparation?(response: { requestId: string; status: 'waiting' | 'ready' | 'cancelled' | 'failed'; error?: string; projectHandled?:boolean }): Promise<{ accepted: boolean }>;
  openFiles(): Promise<OpenedModelFile[]>;
  /** Capabilities are issued only from a real user-selected File; no path API. */
  registerSelectedOutputSource?(file: File): Promise<{ token: string; name: string; size: number }>;
  describeLaunchSource?(token:string):Promise<{name:string;size:number;revision:string}>;
  closeLaunchSource?(token: string): Promise<{ closed: boolean }>;
  /** Metadata only: source bytes are not parsed, uploaded or converted. */
  pickReferenceFile?(request: { title: string; extensions: ('chk' | 'xyz' | 'gbw' | 'hess')[] }): Promise<{ name: string; path: string } | null>;
  getReferenceFilePath?(file: File): string;
  readFileChunk?(token: string, offset: number): Promise<{ bytes: Uint8Array; offset: number; nextOffset: number; done: boolean }>;
  closeFileStream?(token: string): Promise<{ closed: boolean }>;
  chooseSavePath(request: { name: string; formats: FormatDescriptor[]; defaultFormat?:ModelFormat }): Promise<SaveSelection>;
  writeChosenFile(request: { token: string; text: string }): Promise<{ status: 'saved'; path: string }>;
  runChemistry(request: ChemistryRequest, jobId: string): Promise<ChemistryResult>;
  cancelChemistry(jobId: string): Promise<void>;
  startDynamics?(request: DynamicsRequest, sessionId: string): Promise<void>;
  commandDynamics?(sessionId: string, command: DynamicsCommand): Promise<void>;
  onDynamicsEvent?(listener: (event: DynamicsEvent) => void): () => void;
  startXtb?(request:XtbRequest,sessionId:string):Promise<unknown>;
  releaseXtbOptimizationCaches?(sessionIds:string[]):Promise<{released:string[]}>;
  readXtbElectronicArtifacts?(artifactId:string):Promise<XtbElectronicArtifactBundle>;
  releaseXtbElectronicArtifacts?(artifactId:string):Promise<{released:boolean}>;
  commandXtb?(sessionId:string,request:{command:'stop'}):Promise<unknown>;
  onXtbEvent?(listener:(event:XtbEvent)=>void):()=>void;
  orbitalBackendInfo?():Promise<OrbitalBackendInfo>;
  chooseOrbitalBackend?():Promise<OrbitalBackendInfo>;
  analyzeWavefunction?(sessionId:string,request:WavefunctionAnalysisRequest,progressIdentity?:MultiwfnProgressIdentity):Promise<WavefunctionAnalysisResult>;
  cancelWavefunctionAnalysis?(sessionId:string):Promise<void>;
  openOrbitalSession?(request:OrbitalOpenRequest):Promise<WavefunctionMetadata>;
  openXtbOrbitalSession?(artifactId:string,sessionId:string):Promise<WavefunctionMetadata>;
  forkOrbitalSession?(parentSessionId:string,instanceId:string):Promise<{sessionId:string;metadata:WavefunctionMetadata}>;
  closeOrbitalSession?(sessionId:string):Promise<unknown>;
  orbitalResourceInfo?():Promise<OrbitalResourceInfo>;
  planOrbitalSession?(sessionId:string,request:OrbitalPlanRequest):Promise<OrbitalPlan>;
  reserveOrbitalViews?(sessionId:string,viewCount:number):Promise<{viewCount:number;totalBytes:number;withinBudget:boolean}>;
  commandOrbitals?(sessionId:string,command:OrbitalCommand,progressIdentity?:MultiwfnProgressIdentity):Promise<unknown>;
  readOrbitalField?(sessionId:string,orbitalKey:string):Promise<OrbitalField>;
  exportOrbitalCube?(sessionId:string,orbitalKey:string):Promise<string>;
  onOrbitalEvent?(listener:(event:OrbitalBackendEvent)=>void):()=>void;
  surfaceCapabilities?(sessionId?: string): Promise<readonly SurfaceCapability[]>;
  openSurfaceSession?(request: SurfaceOpenRequest): Promise<SurfaceSessionInfo>;
  openHirshfeldSession?(request: HirshfeldOpenRequest): Promise<HirshfeldSessionInfo>;
  analyzeHirshfeld?(sessionId: string, request: HirshfeldAnalyzeRequest): Promise<HirshfeldAnalysisResult>;
  restoreHirshfeldFields?(sessionId: string, request: HirshfeldRestoreRequest): Promise<HirshfeldAnalysisResult>;
  exportHirshfeldCube?(sessionId: string, request: HirshfeldCubeExportRequest): Promise<{ saved: boolean; cancelled?: boolean }>;
  analyzeSurface?(sessionId: string, request: SurfaceAnalyzeRequest): Promise<SurfaceAnalysisResult>;
  surfaceRegion?(sessionId: string, request: SurfaceRegionRequest): Promise<SurfaceRegionResponse>;
  generateSurface?(sessionId: string, request: SurfaceGenerateRequest): Promise<SurfaceGeneratedFields>;
  surfaceRestoreFields?(sessionId: string, request: SurfaceRestoreFieldsRequest): Promise<SurfaceGeneratedFields>;
  surfaceDistribution?(sessionId: string, request: SurfaceDistributionRequest): Promise<SurfaceAreaDistribution>;
  cancelSurface?(sessionId: string): Promise<{ cancelled: boolean }>;
  closeSurfaceSession?(sessionId: string): Promise<{ closed: boolean }>;
  importSurfaceCube?(file?: File): Promise<SurfaceImportedCube | null>;
  registerSurfaceCube?(request: SurfaceCubeRegisterRequest): Promise<SurfaceImportedCube>;
  readRegisteredSurfaceCube?(token: string): Promise<SurfaceImportedCube>;
  releaseSurfaceCube?(token: string): Promise<{ released: boolean }>;
  exportSurfaceCube?(sessionId: string, request: SurfaceCubeExportRequest): Promise<{ cancelled: boolean; path?: string; domainPath?: string }>;
  exportRegisteredSurfaceCube?(request: SurfaceCubeSourceRef): Promise<{ cancelled: boolean; path?: string; domainPath?: string }>;
  onSurfaceEvent?(listener: (event: SurfaceRunState) => void): () => void;
  onMultiwfnProgress?(listener: (event: MultiwfnProgressSnapshot) => void): () => void;
  openInteractionSession?(request: InteractionOpenRequest): Promise<InteractionSessionInfo>;
  generateInteraction?(sessionId: string, request: InteractionGenerateRequest): Promise<InteractionGeneratedFields>;
  interactionContributions?(sessionId: string, request: InteractionContributionRequest): Promise<InteractionContributions>;
  restoreInteractionFields?(sessionId: string, request: InteractionRestoreRequest): Promise<InteractionGeneratedFields>;
  exportInteractionCube?(sessionId: string, request: InteractionCubeExportRequest): Promise<{ saved: boolean; cancelled?: boolean }>;
  cancelInteraction?(sessionId: string): Promise<{ cancelled: boolean; nativeSettled: boolean; activeOperationPending: false }>;
  closeInteractionSession?(sessionId: string): Promise<{ sessionId: string; status: 'closed' }>;
  openExcitationSession?(request: ExcitationOpenRequest): Promise<ExcitationSessionInfo>;
  runExcitation?(sessionId: string, request: ExcitationRunRequest): Promise<ExcitationResult>;
  restoreExcitationFields?(sessionId: string, request: ExcitationRestoreRequest): Promise<ExcitationResult>;
  exportExcitationCube?(sessionId: string, request: ExcitationExportRequest): Promise<{ saved: boolean; cancelled?: boolean; path?: string }>;
  cancelExcitation?(sessionId: string): Promise<{ cancelled: boolean; nativeSettled: boolean; activeOperationPending: false; settlement: 'not-started' | 'cancelled-before-start' | 'native-settled' }>;
  closeExcitationSession?(sessionId: string): Promise<{ sessionId: string; status: 'closed' }>;
  openReactivitySession?(request: ReactivityOpenRequest): Promise<ReactivitySessionInfo>;
  analyzeReactivity?(sessionId: string, request: ReactivityAnalyzeRequest): Promise<ReactivityAnalysisResult>;
  cancelReactivity?(sessionId: string): Promise<{ cancelled: boolean; nativeSettled: boolean; activeOperationPending: false; settlement: 'not-started' | 'cancelled-before-start' | 'native-settled' }>;
  closeReactivitySession?(sessionId: string): Promise<{ sessionId: string; status: 'closed' }>;
  readWorkbenchPreferences?(): Promise<WorkbenchPreferences>;
  writeWorkbenchPreferences?(preferences: WorkbenchPreferences): Promise<void>;
  readWorkbenchPreferenceSnapshot?(): Promise<WorkbenchPreferenceSnapshot>;
  writeWorkbenchPreferenceSnapshot?(request: WorkbenchPreferenceUpdate): Promise<WorkbenchPreferenceSnapshot>;
  readPersonalFragments?(): Promise<PersonalFragmentSnapshot>;
  updatePersonalFragments?(request: { baseVersion: string; library: PersonalFragmentLibraryData }): Promise<PersonalFragmentSnapshot>;
  importPersonalFragments?(): Promise<{ cancelled: true } | { cancelled: false; library: PersonalFragmentLibraryData }>;
  exportPersonalFragments?(library: PersonalFragmentLibraryData): Promise<{ cancelled: boolean; path?: string }>;
}
export interface SaveContext { jobRequest?: JobRequest; orcaJobRequest?: OrcaJobRequest; withCell?: boolean; purpose?:'structure'|'task' }
declare global { interface Window { sciyueDesktop?: DesktopBridge } }
import type { ProjectCompanionBridge } from '../projects/companion-sources';
