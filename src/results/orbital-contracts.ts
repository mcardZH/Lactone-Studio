import type { Structure, Vector3 } from '../core/types';
import type { MeshFinishSettings } from './mesh-appearance';
import type { GeneratedXtbAnalysisPolicy } from './generated-xtb-policy';

/** Wavefunction analysis is opt-in and separate from ordinary structure import. */
export type OrbitalSpin = 'restricted' | 'alpha' | 'beta';
export interface WavefunctionOrbital {
  /** Stable within one immutable source, including the spin channel. */
  key: string;
  spin: OrbitalSpin;
  /** One-based ordinal in the source channel; not an OUT table's display index. */
  ordinal: number;
  sourceIndex: number;
  displayIndex: number;
  energy: number | null;
  energyUnit: 'hartree';
  occupation: number | null;
  sourceLine: number;
  sourceField: string;
}
export interface WavefunctionMetadata {
  sourceId: string;
  sourceRevision: string;
  name: string;
  format: 'fchk' | 'molden';
  /** Canonical structure coordinates are Å, as in every other model document. */
  structure: Structure;
  basisCount: number;
  orbitals: readonly WavefunctionOrbital[];
  messages: readonly string[];
  /** Trusted host applicability metadata, not a property measured in the file. */
  analysisPolicy?: GeneratedXtbAnalysisPolicy;
}
export interface OrbitalGridSpec {
  coordinateUnit: 'bohr';
  origin: Vector3;
  /** Step vectors, not full box lengths. Values follow Cube z-fastest order. */
  axes: [Vector3, Vector3, Vector3];
  dimensions: [number, number, number];
  ordering: 'z-fastest';
}
export interface OrbitalField {
  sessionId: string;
  sourceRevision: string;
  gridKey: string;
  orbitalKey: string;
  grid: OrbitalGridSpec;
  valueUnit: 'bohr^-3/2';
  /** Immutable cache data. Float64 preserves source precision, not extra accuracy. */
  values: Float64Array;
}
/** One display-only field per viewport. Never part of ModelStore or its Undo. */
export interface ViewportOrbitalLayer {
  field: OrbitalField;
  documentId: string;
  geometryRevision: number;
  /** Proper rigid fit from wavefunction coordinates to the paired OUT frame.
   * Translation is Å; camera/display alignment composes after this transform. */
  sourceToDocument?: { rotation: [Vector3, Vector3, Vector3]; translation: Vector3 };
  visible: boolean;
  /** Positive magnitude; the two phases are +isovalue and -isovalue. */
  isovalue: number;
  positiveColor: string;
  negativeColor: string;
  opacity: number;
  /** Local analysis material; absent preserves the default soft highlight. */
  finish?: MeshFinishSettings;
  phase?: 'both' | 'positive' | 'negative';
}
export type OrbitalGenerationStatus = 'idle' | 'queued' | 'running' | 'stopped' | 'completed' | 'failed';
export interface OrbitalGenerationProgress {
  sessionId: string;
  sourceRevision: string;
  gridKey: string;
  status: OrbitalGenerationStatus;
  completedKeys: readonly string[];
  total: number;
  currentKey: string | null;
  cacheBytes: number;
  resources?: OrbitalResourceInfo;
  message?: string;
  /** Explicit selected mode never starts other source orbitals. */
  mode?: 'all' | 'selected';
  requestedKeys?: readonly string[];
}
export interface OrbitalBackendInfo { configured: boolean; path?: string; message?: string }
/** Effective per-job resource settings; the memory figure is a budget, not a reservation. */
export interface OrbitalResourceInfo {
  threads: number;
  memoryBudgetBytes: number;
  nativeMemoryBudgetBytes?: number;
  computeResourceVersion?: string;
  computeResourceSource?: string;
  totalPhysicalMemoryBytes: number;
  logicalCpuCount: number;
  threadSource: 'settings' | 'logical-cpus' | 'request';
  memorySource: 'physical-ram' | 'request';
  settingsPath: string | null;
  settingsPresent: boolean;
  settingsRevision: string;
  temporaryOverrides: readonly { key: string; value: number; reason: string; changed: boolean }[];
  retainedOtherSettings: true;
  memoryIsBudget: true;
  configured: boolean;
}
export interface OrbitalOpenRequest { sessionId: string; sourceId: string; name: string; text?: string; sourceToken?: string }
export interface OrbitalPlanRequest { grid: OrbitalGridSpec; threads: number; memoryBudgetBytes: number; /** Omitted preserves legacy all-orbital semantics. */ mode?: 'all' | 'selected' }
export interface OrbitalPlan {
  gridKey: string; pointCount: number; orbitalCount: number;
  cacheBytes: number; workingBytes: number; totalBytes: number; withinBudget: boolean;
  mode?: 'all' | 'selected';
  resources?: OrbitalResourceInfo;
}
export interface OrbitalCommand {
  operation: 'generate' | 'continue' | 'prioritize' | 'generate-one' | 'stop' | 'status' | 'close';
  priorityKeys?: string[];
  /** Required only by generate-one; atomically supersedes unfinished selection. */
  orbitalKey?: string;
}
export interface OrbitalBackendEvent extends OrbitalGenerationProgress {
  event: 'progress' | 'state' | 'error'; seq: number;
}
