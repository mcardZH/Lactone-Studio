import type { BaseElectronicStateValues } from '../../core/base-electronic-state';
import type { ModelCoordinateObject, SharedModelConstraints } from '../../core/modeling/contracts';
import type { Structure } from '../../core/types';

export const PES_SCHEMA = 'es-pes/v1' as const;
/** Execution semantics are versioned independently from the event envelope. */
export const PES_EXECUTION_PROFILE = 'pes-v222' as const;
export type PesConvergencePreset = 'loose' | 'medium' | 'tight' | 'custom';
export type PesSellaCoordinateSystem = 'xyz' | 'ric';
export type PesMethod = 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff';
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
export type PesOperation = 'scan' | 'ts' | 'hessian' | 'path' | 'explore' | 'enhanced' | 'opt';
export const PES_CALC_PROFILE = 'es-calc/v1' as const;
export interface PesOptimizationInput {
  method: PesMethod | 'gxtb' | 'UFF' | 'MMFF94' | 'auto' | 'geometry';
  algorithm: string;
  charge: number;
  multiplicity: number;
  frozenAtomIds: string[];
  coordinates?: PesRequestBase['constraints']['coordinates'];
  parameters: Record<string, unknown>;
}
export type PesOptimizationUpdate =
  | { event: 'started' }
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
  /** Imported/read-only scientific frame from which this editable geometry was created. */
  originFrame?: Readonly<import('../advanced/frame-source').AdvancedFrameRef>;
  /** The fixed force-field model of a selected scientific frame, independent of its coordinates. */
  ffModel?: PesFfModel;
}
export type PesCoordinate = Pick<ModelCoordinateObject, 'id' | 'type' | 'atomIds'> & { name: string };
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
  constraints: { frozenAtomIds: string[]; coordinates: { id: string; type: PesCoordinate['type']; atomIds: string[]; value: number }[] };
  coordinates: PesCoordinate[];
  parameters: Record<string, unknown>;
  threads?: number;
  memoryBudgetBytes?: number;
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
export interface PesProgress { stage: string; completed?: number; total?: number; elapsedSeconds?: number }
export interface PesRunError { message: string; detail?: string }
export type PesRunStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export type PesEvent = { schema: typeof PES_SCHEMA; runIdentity: PesRunIdentity; seq: number } & (
  | { event: 'started' }
  | ({ event: 'progress' } & PesProgress)
  | { event: 'frame'; frame: PesFrame }
  | { event: 'path-record'; record: PesPathRecord }
  | { event: 'scan-point'; point: PesScanPoint }
  | { event: 'terminal'; workerSettled: true; status: 'completed' | 'stopped' | 'failed'; result?: PesResult; error?: PesRunError }
);
export interface PesBridge {
  startPes(request: PesRequest): Promise<void>;
  stopPes(runIdentity: PesRunIdentity): Promise<void>;
  onPesEvent(listener: (event: PesEvent) => void): () => void;
  readPesPathRecord?(request: { runIdentity: PesRunIdentity; recordId: string }): Promise<readonly PesFrame[]>;
  releasePesPathRecords?(runIdentity: PesRunIdentity): Promise<void>;
}
export interface PesRun {
  request: PesRequest;
  source: PesGeometry;
  inputSources?: { slots: PesCard['slots']; mappings?: PesCard['mappings'] };
  nodeId: string;
  status: PesRunStatus;
  lastSeq: number;
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
export interface PesMethodDraft { method: PesMethod; solvationModel: 'none' | 'alpb' | 'gbsa'; solvent: string }
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
  /** Shared only by Sella P-RFO/RFO/QN; other algorithms keep their own coordinates. */
  sellaCoordinateSystem?: PesSellaCoordinateSystem;
}
export interface PesGroup {
  /** Monotone CALC number; deleting a page never reuses its former name. */
  calcSequence?: number;
  lifecycleVersion?: 'v223';
  id: string;
  name: string;
  initialNodeId: string;
  activeNodeId: string;
  nodes: PesNode[];
  cards: PesCard[];
  /** Inactive method parameter drafts; these never retain input geometries. */
  cardDrafts?: Record<string, PesCard>;
  runs: Record<string, PesRun>;
  electronic: { charge: string; multiplicity: string; confirmed?: BaseElectronicStateValues; sourceKey?: string;
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

/** Used by project persistence to protect drafts and immutable new-method runs. */
export function pesSnapshotUsesExecutionProfile(snapshot: PesProjectSnapshot | undefined): boolean {
  return !!snapshot?.groups.some(group =>
    Object.values(group.ts.parametersByAlgorithm).some(values => values.executionProfile === PES_EXECUTION_PROFILE) ||
    group.cards.some(card => Object.values(card.parametersByAlgorithm).some(values => values.executionProfile === PES_EXECUTION_PROFILE)) ||
    Object.values(group.runs).some(run => run.request.parameters.executionProfile === PES_EXECUTION_PROFILE));
}
