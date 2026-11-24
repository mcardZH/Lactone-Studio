/** Versioned stateful native protocol. No DOM, Electron or process imports. */
import type { Structure } from '../../core/types';
import type { AttachmentPort, DocumentStamp, ForcefieldChoice, ModelCoordinate } from '../contracts';
import type { XtbNativeMethod } from '../../core/xtb-capabilities';
import type { XtbConstraintResult, XtbSolvation, XtbSolvationEvidence } from '../xtb/contracts';

export type DynamicsOperation = 'md';
export type DynamicsMethod = XtbNativeMethod;
export type MDMethod = DynamicsMethod;
export type MDIntegrator = 'xtb' | 'ase';
export interface MDHydrogenSettings {
  shakeHydrogenBonds: boolean;
  hydrogenMassAmu: 1 | 4;
}
export interface DynamicsRequest {
  stamp: DocumentStamp;
  operation: DynamicsOperation;
  structure: Structure;
  movableAtomIds: string[];
  constraints?: ModelCoordinate[];
  forcefield?: ForcefieldChoice;
  method?: DynamicsMethod;
  /** An omitted integrator identifies a legacy native request. */
  integrator?: MDIntegrator;
  shakeHydrogenBonds?: boolean;
  hydrogenMassAmu?: 1 | 4;
  untilStopped?: true;
  /** Runtime soft protection; the editor's XYZ freezes remain unchanged. */
  protectedAtomIds?: string[];
  solvation?: XtbSolvation;
  maxSteps?: number;
  maxWallTimeSeconds?: number;
  temperatureK?: number;
  seed?: number;
  /** Inverse femtoseconds, converted to the integrator's native units. */
  frictionPerFs?: number;
  dtFs?: 1 | 2;
  reportEvery?: 10;
  attachmentPorts?: AttachmentPort[];
}
export interface AseMDEvidence extends MDHydrogenSettings {
  driver: 'ase-bussi';
  method: Exclude<MDMethod, 'gxtb'>;
  backend: string;
  aseVersion: string;
  dtFs: 2;
  thermostat: 'Bussi';
  thermostatTimeConstantFs: 500;
  periodic: boolean;
  frozenAtomIds: string[];
  internalConstraints?: (Pick<XtbConstraintResult,'id'|'type'|'atomIds'|'target'|'actual'|'residual'|'unit'> & {
    images?: ModelCoordinate['images']; action: 'freeze'; mode: 'ase-rattle'; velocityResidual: number;
  })[];
  degreesOfFreedom: number;
  fixedPositionResidualAngstrom?: number;
  fixedVelocityResidualAngstromPerFs?: number;
  shake?: {
    enabled: boolean; algorithm: 'ASE-RATTLE'; hydrogenBondCount: number;
    maxBondResidualAngstrom: number; maxBondVelocityResidualAngstromPerFs: number;
    observedBondLengthsAngstrom: number[];
  };
  effectiveSeed: number;
  seedTreatment: 'specified' | 'program-random';
  calculatorEvidence?: Record<string,unknown>;
  solvation?: XtbSolvation;
  nativeClosed: boolean;
  physicalEnergyEV?: number;
  sphereBiasEV?: number;
  sampledPotentialEV?: number;
  maxWallPenetrationAngstrom?: number;
}
export type DynamicsCommand = { command: 'pause' | 'resume' | 'stop' }
  | { command: 'set-temperature'; temperatureK: number };
export type DynamicsEventName = 'ready' | 'started' | 'heartbeat' | 'frame' | 'paused'
  | 'resumed' | 'temperature' | 'stopped' | 'completed' | 'error';
/** Optional native evidence only. Never inferred from a human-readable message. */
export interface DynamicsErrorDiagnostic {
  schema: 1;
  phase: 'sanitization' | 'parameterization';
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
  /** This receipt covers controller release; document retirement awaits host close separately. */
  workerExitVerified: false;
  error?: string;
}
export interface DynamicsEvent {
  schema: 1; sessionId: string; event: DynamicsEventName; seq: number;
  stamp?: DocumentStamp; operation?: DynamicsOperation; step?: number; timeFs?: number;
  structure?: Structure; forcefield?: string; engine?: string; engineVersion?: string; aseVersion?: string;
  /** Host-owned earlier presentation samples. The top-level event is the latest sample. */
  displayFrames?: DynamicsFrame[];
  /** UTF-8 length of the validated worker record, supplied by the host. */
  displayByteLength?: number;
  nativeMD?: { method: DynamicsMethod; dtFs: number; thermostat: 'Berendsen'; hydrogenMassAmu: 1 | 4 | null; shakeHydrogenBonds: boolean; protection: 'none' | 'pairwise-distance'; protectedAtomIds: string[]; forceConstantKJMolNm2: number; segment: number; velocityInitialization: 'fresh' | 'restart'; nativeClosed: boolean;
    periodic?:true; internalConstraints?:XtbConstraintResult[]; solvation?:Omit<XtbSolvationEvidence,'temperatureKelvin'> & {temperatureKelvin:number;dielectricConstant?:number};
    seedTreatment?:'verified'|'program-random'|'native-internal-initialization'; effectiveSeed?:number; engineIdentity?:Record<string,unknown>;
    degreesOfFreedom?:number; restartInputSha256?:string;
    /** Independently sourced raw observation; may precede a final restart geometry. */
    rawPotential?: { value:number; unit:'hartree'; definition:'native-total-including-protection'|'native-physical-potential'; includesProtection:boolean; sourceArtifact:'xtb.trj'; sourceStep:number; sourceTimeFs:number; segment:number };
    energyObservationWarning?: 'missing' | 'invalid';
  };
  aseMD?: AseMDEvidence;
  energyEV?: number; kineticEnergyEV?: number; temperatureK?: number; targetTemperatureK?: number;
  converged?: boolean;
  /** Native terminal reason; completed values are bounded by protocol validation. */
  reason?: string;
  error?: DynamicsError;
}
export interface DynamicsFrame extends DynamicsEvent {
  event: 'frame' | 'stopped' | 'completed'; stamp: DocumentStamp;
  operation: DynamicsOperation; step: number; timeFs: number; structure: Structure;
}
