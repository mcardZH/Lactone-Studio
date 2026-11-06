/** Versioned stateful native protocol. No DOM, Electron or process imports. */
import type { Structure, Vector3 } from '../../core/types';
import type { AttachmentPort, DocumentStamp, ForcefieldChoice, ModelCoordinate } from '../contracts';

export type DynamicsOperation = 'md' | 'optimize' | 'geometry';
export type DynamicsMethod = 'gfnff' | 'gfn0' | 'gfn1' | 'gfn2';
export type MDMethod = ForcefieldChoice | DynamicsMethod;
export interface GeometryDistanceTarget {
  atomIds: [string, string]; image?: Vector3; distanceAngstrom: number;
}
export interface GeometryTargetStatus {
  status: 'targeted' | 'partial-targets' | 'no-targets' | 'collision-only';
  targetedConnectionCount: number; movableConnectionTargetCount: number;
  untargetedCoordinationCount: number; weakConnectionCount: number;
  unresolvedImmovableConnectionCount: number;
  angleTargetCount: number; planeTargetCount: number; activeCollisionCount: number;
  connectionTargets: {
    atomIds: [string, string]; image: Vector3; targetAngstrom: number | null;
    source: 'user-distance' | 'typical-covalent' | 'covalent-radii' | 'unavailable-coordination' | 'weak-relation';
    orderKnown: boolean;
  }[];
}
export interface DynamicsRequest {
  stamp: DocumentStamp;
  operation: DynamicsOperation;
  structure: Structure;
  movableAtomIds: string[];
  constraints?: ModelCoordinate[];
  forcefield?: ForcefieldChoice;
  method?: DynamicsMethod;
  untilStopped?: true;
  /** Runtime soft protection; the editor's XYZ freezes remain unchanged. */
  protectedAtomIds?: string[];
  maxSteps?: number;
  maxWallTimeSeconds?: number;
  temperatureK?: number;
  seed?: number;
  /** Inverse femtoseconds, converted to the integrator's native units. */
  frictionPerFs?: number;
  dtFs?: 1 | 2;
  reportEvery?: 10;
  /** Geometry-clean construction hints, not virtual force-field particles. */
  attachmentPorts?: AttachmentPort[];
  /** Explicit distances for existing connections in pure mechanical mode only.
   * Never populated from current coordinates or frozen-coordinate values. */
  geometryDistanceTargets?: GeometryDistanceTarget[];
  geometryMode?: 'hybrid-local';
  hybridScalePolicy?: 'uff-bond-stiffness-v1';
  /** Explicit AUTO permission; never a fallback for numerical/identity failures. */
  allowPureGeometryFallback?: true;
}
export type DynamicsCommand = { command: 'pause' | 'resume' | 'stop' }
  | { command: 'set-temperature'; temperatureK: number };
export type DynamicsEventName = 'ready' | 'started' | 'heartbeat' | 'frame' | 'paused'
  | 'resumed' | 'temperature' | 'stopped' | 'completed' | 'error';
/** Optional native evidence only. Never inferred from a human-readable message. */
export interface DynamicsErrorDiagnostic {
  schema: 1;
  phase: 'sanitization' | 'parameterization' | 'hybrid-partition';
  /** Exact stable IDs in the request graph, not native indices or element names. */
  atomIds?: string[];
}
export interface DynamicsError {
  code: string;
  message: string;
  diagnostic?: DynamicsErrorDiagnostic;
}
export interface DynamicsTerminalFailure {
  origin: 'native' | 'host' | 'controller' | 'transport';
  code: string;
  message: string;
  /** Only populated when supplied by validated native structured diagnostics. */
  phase?: DynamicsErrorDiagnostic['phase'];
  /** Tracks actual accepted coordinate writes, not unchanged started snapshots. */
  stage: 'before-first-frame' | 'after-frame';
  coordinatesAccepted: boolean;
  identityVerified: boolean;
  sessionId: string;
  stamp: DocumentStamp;
  operation: DynamicsOperation;
  forcefield?: ForcefieldChoice;
  movableAtomIds: string[];
  constraints: ModelCoordinate[];
  /** Absent when the native protocol has no atom-level attribution. */
  atomIds?: string[];
}
export interface DynamicsTermination {
  sessionId: string;
  status: 'pending' | 'settled' | 'failed';
  scope: 'controller-session-release';
  via: 'host-terminal-observed' | 'stop-request';
  /** The current host API does not expose worker-close acknowledgement. */
  workerExitVerified: false;
  error?: string;
}
export interface DynamicsEvent {
  schema: 1; sessionId: string; event: DynamicsEventName; seq: number;
  stamp?: DocumentStamp; operation?: DynamicsOperation; step?: number; timeFs?: number;
  structure?: Structure; forcefield?: string; engine?: string; engineVersion?: string; aseVersion?: string;
  /** Host-owned bounded presentation batch. Removed before scientific writes. */
  displayFrames?: DynamicsFrame[];
  nativeMD?: { method: DynamicsMethod; dtFs: number; thermostat: 'Berendsen'; hydrogenMassAmu: 4 | null; shakeHydrogenBonds: boolean; protection: 'none' | 'pairwise-distance'; protectedAtomIds: string[]; forceConstantKJMolNm2: number; segment: number; velocityInitialization: 'fresh' | 'restart'; nativeClosed: boolean;
    /** Independently sourced raw observation; may precede a final restart geometry. */
    rawPotential?: { value:number; unit:'hartree'; definition:'native-total-including-protection'|'native-physical-potential'; includesProtection:boolean; sourceArtifact:'xtb.trj'; sourceStep:number; sourceTimeFs:number; segment:number };
  };
  energyEV?: number; kineticEnergyEV?: number; temperatureK?: number; targetTemperatureK?: number;
  /** Mechanical geometry objective, explicitly not physical molecular energy. */
  geometryObjective?: number;
  geometryTargetStatus?: GeometryTargetStatus;
  hybridGeometry?: HybridGeometryMetadata;
  converged?: boolean;
  /** Native terminal reason; completed values are bounded by protocol validation. */
  reason?: string;
  constraintResiduals?: { type: 'B' | 'A' | 'D'; id?: string; target: number; actual: number; residual: number; unit: 'angstrom' | 'radian' | 'degree' }[];
  error?: DynamicsError;
}
export interface HybridGeometryMetadata {
  schema: 1; mode: 'partial-uff-local' | 'geometry-only'; triggerCode: string;
  problemAtomIds: string[]; mechanicalAtomIds: string[]; uffAtomIds: string[]; boundaryAtomIds: string[];
  uffEnergyKcalMol: number; localMechanicalObjective: number; energyScaleKcalMol: number;
  scalePolicy: 'uff-bond-stiffness-v1' | 'pure-geometry-v1'; termCounts: Record<string, number>;
  objective: 'partialUFF(kcal/mol)/energyScale(kcal/mol)+localMechanical' | 'mechanicalGeometry';
  regionsOverlap: boolean; physicalPotential: false;
  fallbackReason?: 'no-uff-region';
  typingProof?: 'bounded-neutral-saturated-CH-chain-v1' | 'bounded-neutral-saturated-CHF-chain-v2' | 'native-null-typing-mask-v3'; typingIsolationAtomIds?: string[];
}
export interface DynamicsFrame extends DynamicsEvent {
  event: 'frame' | 'stopped' | 'completed'; stamp: DocumentStamp;
  operation: DynamicsOperation; step: number; timeFs: number; structure: Structure;
}
