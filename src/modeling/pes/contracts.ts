import type { BaseElectronicStateValues } from '../../core/base-electronic-state';
import type { ModelCoordinateObject, SharedModelConstraints } from '../../core/modeling/contracts';
import type { Structure, Vector3 } from '../../core/types';
import type { BondOrderObservation } from '../../core/modeling/contracts';
import type { ComputeResourceEvidence, NetGpuBatchLimit, XtbResourceOverrides } from '../resource-preferences';

export const PES_SCHEMA = 'es-pes/v1' as const;
/** Execution semantics are versioned independently from the event envelope. */
export const PES_EXECUTION_PROFILE = 'pes-v222' as const;
export type PesConvergencePreset = 'loose' | 'medium' | 'tight' | 'custom';
export type PesSellaCoordinateSystem = 'xyz' | 'ric';
export const PES_NET_METHODS = ['aimnet2-auto', 'aimnet2-rxn', 'orbmol-v2'] as const;
export const PES_PERIODIC_NET_METHODS = ['orb-v3-omat', 'mace-polar-1-m', 'mace-mh1-omat-pbe', 'mace-mh1-oc20'] as const;
export type PesPeriodicNetMethod = typeof PES_PERIODIC_NET_METHODS[number];
export type PesNetMethod = typeof PES_NET_METHODS[number] | PesPeriodicNetMethod;
export const isPesNetMethod = (method: string): method is PesNetMethod =>
  PES_NET_METHODS.some(value => value === method) || PES_PERIODIC_NET_METHODS.some(value => value === method);
/** These fixed-cell weights use their trained state. User q/M describe the source structure. */
export function isPesTrainedStateNetMethod(method: string): boolean {
  return method === 'orb-v3-omat' || method === 'mace-mh1-omat-pbe' || method === 'mace-mh1-oc20';
}
export type PesMethod = 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff' | 'mcgfnff' | PesNetMethod;
export type PesOrdinaryOptimizer = 'lbfgs' | 'precon-exp' | 'fire2' | 'sella-xyz' | 'sella-ric';
export type PesGeometryLimits = Record<'energyDifferenceHartree' | 'gradientNormHartreePerBohr', number>;
/** Serializable reference only. Native calculators and node state never enter a project. */
export interface PesFfModel {
  schemaVersion: 1;
  modelId: string;
  method: 'gfnff';
  reference: { atoms: Pick<Structure['atoms'][number], 'id' | 'element' | 'x' | 'y' | 'z'>[]; charge: number; multiplicity: number };
  atomOrder: string[];
  solvation?: { model: 'alpb'; solvent: string };
  parameterIdentity?: Record<string, unknown>;
}
export type PesOperation = 'scan' | 'ts' | 'hessian' | 'irc' | 'path' | 'explore' | 'enhanced' | 'opt';
export const PES_CALC_PROFILE = 'es-calc/v1' as const;
export interface PesOptimizationInput {
  method: PesMethod | 'gxtb' | 'UFF' | 'MMFF94' | 'auto' | 'geometry';
  algorithm: string;
  charge: number;
  multiplicity: number;
  frozenAtomIds: string[];
  coordinates?: PesRequestBase['constraints']['coordinates'];
  parameters: Record<string, unknown>;
  resourceOverrides?: Pick<XtbResourceOverrides,'xtbSingleTaskThreads'>;
  retainTrajectory?: boolean;
  device?: 'gpu' | 'cpu';
  solvation?: { model: 'alpb'; solvent: string };
}
export type PesOptimizationUpdate =
  | { event: 'started' }
  | ({ event: 'evaluation-started' } & PesEvaluationStart)
  | ({ event: 'progress' } & PesProgress)
  | { event: 'frame'; frame: PesFrame }
  | { event: 'terminal'; workerSettled: true; status: 'completed' | 'stopped' | 'failed'; result?: PesResult; error?: PesRunError };
/** The shared result vocabulary recognizes enhanced sampling; this build creates only these three cards. */
export type PesCardKind = 'scan' | 'path' | 'explore';
export interface PesRunIdentity { groupId: string; taskId: string; runId: string }
export interface PesSourceIdentity {
  groupId?: string;
  nodeId?: string;
  runId?: string;
  seriesId?: string;
  frameId?: string;
  recordId?: string;
}
export interface PesGeometry {
  structure: Structure;
  documentId: string;
  revision: number;
  source?: PesSourceIdentity;
  label?: string;
  /** Card-owned immutable input, never a workspace document or persistent draft. */
  inputSnapshotId?: string;
  /** PES group whose tab picker supplied this immutable card input. */
  groupTabReference?: string;
  /** Imported/read-only scientific frame from which this editable geometry was created. */
  originFrame?: Readonly<import('../advanced/frame-source').AdvancedFrameRef>;
  /** The fixed force-field model of a selected scientific frame, independent of its coordinates. */
  ffModel?: PesFfModel;
}
type PesCoordinateDefinition = Pick<ModelCoordinateObject, 'id' | 'type' | 'atomIds' | 'images'>;
export type PesCoordinate = PesCoordinateDefinition & { name: string };
export type PesCoordinateConstraint = PesCoordinateDefinition & { value: number };

/** Each entry applies to an original anchor geometry in reactant/keyframe/product order. */
export interface PesPeriodicPath {
  endpointImages: (Vector3[] | null)[];
}

export type PesHessianSpace =
  | { kind: 'cartesian-full' }
  | { kind: 'cartesian-active'; activeDofs: number[] };

export interface PesHessianReference {
  frameId?: string;
  atomIds: string[];
  geometryAngstrom: Vector3[];
  matrixHartreePerBohr2: number[][];
  space?: PesHessianSpace;
  cell?: Structure['cell'];
}
export type PesParameter = string | number | boolean | null | PesParameter[] | { [key: string]: PesParameter };
export type PesParameters = Record<string, PesParameter>;
export interface PesRequestBase {
  schema: typeof PES_SCHEMA;
  id: string;
  sourceDocumentId: string;
  runIdentity: PesRunIdentity;
  algorithm: string;
  structure: Structure;
  charge: number;
  uhf: number;
  solvation?: { model: 'alpb'; solvent: string };
  constraints: { frozenAtomIds: string[]; coordinates: PesCoordinateConstraint[] };
  coordinates: PesCoordinate[];
  parameters: Record<string, unknown> & { periodicPath?: PesPeriodicPath };
  threads?: number;
  memoryBudgetBytes?: number;
  resourceOverrides?: XtbResourceOverrides;
  ffModel?: PesFfModel;
}
export type PesRequest = PesRequestBase & (
  | { operation: Exclude<PesOperation, 'opt'>; method: PesMethod }
  | { operation: 'opt'; method: PesOptimizationInput['method'] }
);
export interface PesFrame {
  id: string;
  positions: [number, number, number][];
  energyHartree?: number | null;
  step: number;
  phase: string;
  seriesId: string;
  status: string;
  converged?: boolean;
  cv?: number[];
  [field: string]: unknown;
}
export interface PesSeries { id: string; label?: string; kind?: string; [field: string]: unknown }
/** Curve metadata is sent independently from its immutable coordinate asset. */
export interface PesFrameIndex {
  id: string;
  energyHartree?: number | null;
  step: number;
  phase: string;
  seriesId: string;
  status: string;
  converged?: boolean;
  cv?: number[];
  bead?: number;
  [field: string]: unknown;
}
export interface PesPathRecord {
  id: string;
  /** Stable logical path inside this run; SE-GSM keeps each event separate. */
  pathId?: string;
  reactantFrameId?: string;
  seriesId: string;
  phase: string;
  step: number;
  kind: 'initial' | 'first-energy' | 'interval' | 'final';
  frames: readonly PesFrameIndex[];
  /** Only real adjacent nodes; a growing string can contain gaps. */
  connections?: readonly [string, string][];
}
export interface PesScanPoint {
  pointIndex: number;
  indices: number[];
  targets: number[];
  status: string;
  energyHartree: number | null;
  actual?: number[];
  frameId?: string;
  [field: string]: unknown;
}
export interface PesResult {
  frames: PesFrame[];
  series?: PesSeries[];
  hessian?: unknown;
  frequencies?: unknown;
  pathRecords?: readonly PesPathRecord[];
  lastPathRecordId?: string;
  scanPoints?: readonly PesScanPoint[];
  status: string;
  provenance: Record<string, unknown>;
  [field: string]: unknown;
}
export interface PesProgress {
  stage: string;
  completed?: number;
  total?: number;
  elapsedSeconds?: number;
}
export interface PesEvaluationStart {
  /** Wall-clock time sampled at the first actual engine call. */
  physicalEvaluationStartedAtMs: number;
  backend: string;
  clockSource: 'native-boundary';
}
/** Host timestamps record receipt or dispatch, and broker durations use its own monotonic clock. */
export type PesOptimizationTiming = ({
  phase: 'resource-resolution' | 'admission-wait' | 'runtime-resolution' | 'workspace-preparation' | 'worker-dispatched' | 'terminal-published';
} | {
  phase: 'worker-readiness'; workerMode: 'resident-new' | 'resident-preparing' | 'resident-ready' | 'process';
} | {
  phase: 'worker-context-ready'; contextMs: number;
} | {
  phase: 'initial-frame' | 'first-accepted-step'; step: number;
} | ({ evaluation: 1 | 2 } & (
  | { phase: 'net-dispatched' }
  | { phase: 'net-lane-entered'; brokerQueueMs: number; sessionQueueMs: number }
  | { phase: 'net-physical-started'; physicalEvaluationStartedAtMs: number; brokerSetupMs: number; modelCached?: boolean; modelLookupMs?: number }
  | { phase: 'net-returned'; roundTripMs: number; brokerMs: number; physicalMs?: number; ok: boolean }
))) & { hostElapsedMs: number };
export interface PesRunError { message: string; detail?: string; code?: string }
export type PesRunStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface PesTerminalNumericAsset { id: string; bytesLength: number; sha256: string; shape: number[] }
export interface PesTerminalNumericAssets { hessianMatrix?: PesTerminalNumericAsset; modeDisplacements?: PesTerminalNumericAsset }
export type PesEvent = { schema: typeof PES_SCHEMA; runIdentity: PesRunIdentity; seq: number } & (
  | { event: 'started'; resourceGrant?: ComputeResourceEvidence }
  | ({ event: 'evaluation-started' } & PesEvaluationStart)
  | { event: 'net-batch'; size: number }
  | { event: 'optimization-timing'; timing: PesOptimizationTiming }
  | ({ event: 'progress' } & PesProgress)
  | { event: 'frame'; frame: PesFrame }
  | { event: 'path-record'; record: PesPathRecord }
  | { event: 'scan-point'; point: PesScanPoint }
  | { event: 'terminal'; workerSettled: true; status: 'completed' | 'stopped' | 'failed'; result?: PesResult; resultFrameIds?: string[]; resultNumericAssets?: PesTerminalNumericAssets; error?: PesRunError }
);
export interface PesRecoveryItem {
  id: string;
  runIdentity: PesRunIdentity;
  operation: PesRequest['operation'];
  method: PesRequest['method'];
  status: 'completed';
  frameCount: number;
  pathRecordCount: number;
  finishedAt: number;
}
export interface PesRecoveryCatalog {
  recoveries: PesRecoveryItem[];
  issues: { id: string; message: string }[];
}
export interface PesRecoveryClaim {
  id: string;
  request: PesRequest;
  terminal: Extract<PesEvent, { event: 'terminal' }>;
}
export interface PesBridge {
  preparePes?(request: PesRequest): Promise<{ state: 'ready' | 'deferred'; provider?: string }>;
  startPes(request: PesRequest): Promise<void>;
  stopPes(runIdentity: PesRunIdentity): Promise<void>;
  onPesEvent(listener: (event: PesEvent) => void): () => void;
  readPesPathRecord?(request: { runIdentity: PesRunIdentity; recordId: string }): Promise<readonly PesFrame[]>;
  releasePesPathRecords?(runIdentity: PesRunIdentity): Promise<void>;
  readPesTerminalFrames?(request: { runIdentity: PesRunIdentity; offset: number; limit: number }): Promise<{ frames: PesFrame[]; offset: number; total: number; done: boolean }>;
  releasePesTerminalFrames?(runIdentity: PesRunIdentity): Promise<boolean>;
  listPesRecovery?(): Promise<PesRecoveryCatalog>;
  claimPesRecovery?(id: string): Promise<PesRecoveryClaim>;
  closePesRecovery?(id: string): Promise<void>;
  readBinaryAsset?(id: string, offset: number, length: number): Promise<ArrayBuffer>;
  releaseBinaryAsset?(id: string): Promise<void>;
}
export interface PesRun {
  request: PesRequest;
  source: PesGeometry;
  inputSources?: { slots: PesCard['slots']; mappings?: PesCard['mappings'] };
  nodeId: string;
  status: PesRunStatus;
  nativeStarted?: true;
  nativeBackend?: string;
  resourceGrant?: ComputeResourceEvidence;
  /** Width of the latest real GPU gradient batch observed by this run. */
  actualGpuBatchWidth?: number;
  workerSettled?: true;
  lastSeq: number;
  /** Preserve this ordinary optimization's native frame collection after adoption. */
  retainTrajectory?: true;
  progress?: PesProgress;
  /** Live view is a single accepted frame. Final frame collections belong to result. */
  preview?: PesFrame;
  acceptedFrames?: readonly PesFrame[];
  pathRecords?: readonly PesPathRecord[];
  scanPoints?: readonly PesScanPoint[];
  result?: PesResult;
  error?: PesRunError;
  /** A later successful calculation retired this result; input/provenance remain diagnostic. */
  supersededByRunId?: string;
}
export interface PesOptimizationGeometryCommit {
  groupId:string;
  nodeId:string;
  runId:string;
  source:PesGeometry;
  geometry:PesGeometry;
  bondOrderObservation?:BondOrderObservation;
}
export interface PesFrameSelection { runId: string; seriesId: string; frameId: string; recordId?: string }
export interface PesNode {
  id: string;
  name: string;
  kind: 'initial' | 'snapshot' | 'result' | 'workbench';
  geometry: PesGeometry;
  runIds: string[];
  selection?: PesFrameSelection;
  followRunId?: string;
  /** A source page initializes its independent TS method once, never on subsequent browsing. */
  tsMethodInitialized?: true;
  /** Explicit same-page OPT/TS/Freq semantics, protected from older writers. */
  calcProfile?: typeof PES_CALC_PROFILE;
}
export interface PesMethodDraft { method: PesMethod | 'gxtb'; solvationModel: 'none' | 'alpb' | 'gbsa'; solvent: string; device?: 'gpu' | 'cpu' }
export interface PesExpressionDraft { coordinates: (PesCoordinate & { nameDraft?: string })[]; expression: string }
export interface PesAxis {
  id: string;
  name: string;
  definition: PesExpressionDraft;
  lower: string;
  /** Missing on legacy cards: an empty lower value means the source value. */
  lowerMode?: 'automatic' | 'manual';
  upper: string;
  points: string;
  step?: string;
  rangeDriver?: 'points' | 'step';
  rangeTouched?: Partial<Record<'lower' | 'upper' | 'points' | 'step', boolean>>;
}
export interface PesDrive { id: string; type: 'ADD' | 'BREAK' | 'ANGLE' | 'TORSION'; atomIds: string[]; value?: number; valueText?: string }
export interface PesReactionEvent { id: string; selected: boolean; drives: PesDrive[] }
export interface PesEventDraft {
  mode: 'manual' | 'automatic';
  activityAtomIds: string[];
  maxFormed: string;
  maxBroken: string;
  manual: PesReactionEvent[];
  automatic: PesReactionEvent[];
}
export interface PesCard {
  id: string;
  kind: PesCardKind;
  name: string;
  algorithm: string;
  method: PesMethodDraft;
  /** Slot values are immutable selections, including the real geometry of a prior frame. */
  slots: Record<string, PesGeometry | undefined>;
  /** A released selection must be explicitly recorded/selected again. */
  requiredSlots?: string[];
  mappings?: Record<string, Record<string, string>>;
  keys: { id: string; position: string }[];
  dimension: 1 | 2;
  axes: [PesAxis, PesAxis];
  /** Scan axes share these definitions; legacy per-axis definitions remain readable. */
  scanCoordinates?: PesExpressionDraft['coordinates'];
  scanCoordinateDrafts?: { id: string; name: string; atomText: string; automaticName?: boolean }[];
  scanCoordinateOrder?: string[];
  scanConvergencePreset?: 'loose' | 'medium' | 'tight' | 'custom';
  resourceOverrides?: XtbResourceOverrides;
  netGpuBatchLimit?: NetGpuBatchLimit;
  parametersByAlgorithm: Record<string, PesParameters>;
  eventsByAlgorithm: Record<string, PesEventDraft>;
  runIds: string[];
  collapsed: boolean;
}
export interface PesTsDraft {
  algorithm: string;
  method: PesMethodDraft;
  reaction: PesExpressionDraft;
  parametersByAlgorithm: Record<string, PesParameters>;
  resourceOverrides?: Pick<XtbResourceOverrides,'xtbSingleTaskThreads'>;
  /** Shared only by Sella P-RFO/RFO/QN; other algorithms keep their own coordinates. */
  sellaCoordinateSystem?: PesSellaCoordinateSystem;
}
export interface PesGroup {
  sharedMethod?: PesMethodDraft;
  ircParameters?: PesParameters;
  hessianStepBohr?: number;
  /** Monotone CALC number; deleting a page never reuses its former name. */
  calcSequence?: number;
  lifecycleVersion?: 'v223';
  id: string;
  name: string;
  initialNodeId: string;
  /** Atom numbering at group creation, used for adding ordinary tab candidates. */
  initialElementSequence?: readonly string[];
  activeNodeId: string;
  nodes: PesNode[];
  cards: PesCard[];
  /** Inactive method parameter drafts; these never retain input geometries. */
  cardDrafts?: Record<string, PesCard>;
  runs: Record<string, PesRun>;
  electronic: { charge: string; multiplicity: string; confirmed?: BaseElectronicStateValues; sourceKey?: string;
    drafts?: Record<string, { charge: string; multiplicity: string }>;
    pendingUnscopedEdit?: boolean;
    confirmationHistory?: Record<string, BaseElectronicStateValues> };
  submittedComposition?: Record<string, number>;
  constraints: SharedModelConstraints;
  constraintTargets?: Record<string, string>;
  ts: PesTsDraft;
}
/** Explicit project asset. Restores immutable inputs and scientific results without process state. */
export interface PesProjectSnapshot { schema: typeof PES_SCHEMA; groups: PesGroup[] }

export function pesCardParameterDraft(card: PesCard): PesCard {
  return { ...card, slots: {}, mappings: {}, requiredSlots: [...new Set([
    ...(card.requiredSlots ?? []), ...Object.keys(card.slots).filter(key => card.slots[key] !== undefined),
  ])] };
}

/** Active cards can reopen their explicit group selections. Other transient
 * picks and inactive method drafts retain the existing recapture behavior. */
export function persistedPesCard(groupId: string, card: PesCard): PesCard {
  return { ...pesCardParameterDraft(card), slots: Object.fromEntries(
    Object.entries(card.slots).filter(([, source]) => source?.groupTabReference === groupId),
  ) };
}

/** Used by project persistence to protect drafts and immutable new-method runs. */
export function pesSnapshotUsesExecutionProfile(snapshot: PesProjectSnapshot | undefined): boolean {
  return !!snapshot?.groups.some(group =>
    Object.values(group.ts.parametersByAlgorithm).some(values => values.executionProfile === PES_EXECUTION_PROFILE) ||
    group.cards.some(card => Object.values(card.parametersByAlgorithm).some(values => values.executionProfile === PES_EXECUTION_PROFILE)) ||
    Object.values(group.runs).some(run => run.request.parameters.executionProfile === PES_EXECUTION_PROFILE));
}
