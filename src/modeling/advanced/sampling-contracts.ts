import type { Structure, Atom, Vector3 } from '../../core/types';
import type { DocumentStamp } from '../../core/modeling/contracts';
import {minimumEnclosingSphere} from './sampling-sphere';

export type ConformerSamplingOperation = 'md' | 'anneal' | 'metadynamics' | 'spherical-md';
export type ConformerSamplingMethod = 'MMFF94' | 'MMFF94s' | 'UFF' | 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff';
export type ConformerSamplingDriver = 'ase-langevin' | 'native-xtb-md';
export type ConformerSamplingDriverReason = 'native-ordinary-md' | 'native-rmsd-metadynamics' | 'ase-forcefield-or-temperature-bias-route';
/** Supported native relative-distance restraint routes, not a claim that all
 * routes were remeasured for the dev4 default. The dev4 representative checks
 * select 500,000 at 2 fs; saved explicit 5,000,000 remains a legacy profile.
 * Historical v052 route evidence is kept in its original benchmark records. */
export const NATIVE_CONFORMER_CORE_PROTECTION = Object.freeze({
  forceConstantKJMolNm2: 500_000, legacyForceConstantKJMolNm2: 5_000_000, maxRmsdAngstrom: .2, dtFs: 2,
  supportedRoutes: ['gfnff:md','gfnff:metadynamics','gfn0:md','gfn0:metadynamics',
    'gfn1:md','gfn1:metadynamics','gfn2:md','gfn2:metadynamics'] as readonly string[],
});
/** Ordinary xTB MD never silently switches integrator to provide a protection. */
export function getConformerSamplingCapability(request: { operation: ConformerSamplingOperation; method: ConformerSamplingMethod }) {
  const native = ['md', 'metadynamics'].includes(request.operation) && ['gfnff', 'gfn0', 'gfn1', 'gfn2'].includes(request.method);
  const shake = !(native && request.method === 'gfnff');
  return { driver: native ? 'native-xtb-md' as const : 'ase-langevin' as const,
    shakeSupported: shake, shakeDefaultEnabled: shake,
    coreProtectionSupported: !native || NATIVE_CONFORMER_CORE_PROTECTION.supportedRoutes.includes(`${request.method}:${request.operation}`), sphereSupported: true, xyzFreezeSupported: !native };
}
export function selectConformerSamplingDriver(request: { operation: ConformerSamplingOperation; method: ConformerSamplingMethod; coreProtection?: unknown; sphere?: unknown; frozenAtomIds?: readonly string[] }): { driver: ConformerSamplingDriver; reason: ConformerSamplingDriverReason } {
  if (getConformerSamplingCapability(request).driver === 'native-xtb-md') return { driver: 'native-xtb-md', reason: request.operation === 'metadynamics' ? 'native-rmsd-metadynamics' : 'native-ordinary-md' };
  return { driver: 'ase-langevin', reason: 'ase-forcefield-or-temperature-bias-route' };
}
export interface ConformerSamplingRunIdentity { taskId: string; runId: string }
export interface ConformerSamplingSegment {id:string;previousSegmentId?:string;completedStepsBefore:number}
export interface ConformerSamplingSegmentProgress {
  segment?:ConformerSamplingSegment;localStep?:number;localTimeFs?:number;cumulativeStep?:number;cumulativeTimeFs?:number;
  velocityInitialization?:'fresh';biasInitialization?:'fresh'|'not-applicable';
}
export interface ConformerSamplingCalculatorSettings {
  accuracy?: number; maxIterations?: number; electronicTemperatureK?: number;
}
export interface ConformerAnnealingSettings {
  lowTemperatureK?: number; highTemperatureK?: number;
  /** Canonical three-phase cycle: 10% heating, 70% high hold, 20% cooling. */
  cycleDurationFs?: number;
  /** Explicit legacy four-phase requests remain readable; never combine with cycleDurationFs. */
  heatingFs?: number; highHoldFs?: number; coolingFs?: number; lowHoldFs?: number; cycles?: number;
}
export interface ConformerMetadynamicsSettings {
  temperatureK?: number; durationFs?: number; sampleEveryFs?: number; depositEveryFs?: number;
  /** Peak Gaussian amplitude/width. Native xTB ramps the newest history term;
   * ASE applies its complete amplitude immediately. Both fit stable IDs. */
  heightEV?: number; sigmaAngstrom?: number; atomIds?: string[]; maxHistory?: number;
}
export interface ConformerSphericalMDSettings { temperatureK?: number; durationFs?: number; sampleEveryFs?: number }
/** Continuous constant-temperature MD; ordinary xTB native protections require an explicitly supported physical definition. */
export interface ConformerMolecularMDSettings { temperatureK?: number; durationFs?: number; sampleEveryFs?: number }
export interface ConformerSamplingSphere {
  /** Explicit source coordinates, shared unchanged by preview and calculation. */
  centerAngstrom: Vector3; radiusAngstrom: number; forceConstantEVPerAngstrom2?: number;
}
export interface ConformerCoreProtection {
  atomIds: string[]; forceConstantEVPerAngstrom2?: number;
}
/** Native ordinary MD definitions, never aliases for the ASE RMSD/C1 potentials. */
export interface ConformerNativeProtection {
  core?: { kind: 'pairwise-distance'; atomIds: string[]; forceConstantEVPerAngstrom2: number };
  sphere?: { kind: 'polynomial'; centerAngstrom: Vector3; radiusAngstrom: number; exponent: 30 };
}
export interface ConformerNativeProtectionEvidence {
  core: null | { kind: 'pairwise-distance'; atomIds: string[]; nativeAtomIndices: number[];
    forceConstantEVPerAngstrom2: number; inputForceConstantHartreePerBohr2: number; actualPairForceConstantEVPerAngstrom2: number;
    pairs: { atomIds: [string, string]; nativeAtomIndices: [number, number]; referenceDistanceAngstrom: number }[] };
  sphere: null | { kind: 'polynomial'; centerAngstrom: Vector3; radiusAngstrom: number; exponent: 30;
    nativeCenterBohr: [0, 0, 0]; nativeRadiusBohr: number; energyScaleHartree: 1; appliesTo: 'all-atoms' };
  /** Source to native offset; inverse is applied to every public frame. */
  coordinateTransform: { kind: 'identity' | 'translation'; offsetAngstrom: Vector3 };
}
interface ConformerSamplingRequestBase {
  schema: 1; stamp: DocumentStamp & { activationEpoch?: number }; runIdentity: ConformerSamplingRunIdentity;
  structure: Structure; method: ConformerSamplingMethod; charge: number; uhf: number;
  /** A fresh integration segment from the explicitly supplied source geometry. */
  segment?:ConformerSamplingSegment;
  frozenAtomIds?: string[];
  /** Momentum constraints on internal coordinates have not been validated; admission accepts only an empty list. */
  constraints?: [];
  threads?: number; maxSteps?: number; maxEvaluations?: number; maxWallTimeSeconds?: number;
  maxFrames?: number; seed?: number; dtFs?: number; frictionPerFs?: number; reportEvery?: number;
  /** SHAKE/RATTLE constrains X-H distances, not hydrogen Cartesian coordinates. */
  shakeHydrogenBonds?: boolean;
  /** Absolute mass in amu, only for ordinary native GFN-FF MD. Omitted means natural masses, including legacy requests. */
  hydrogenMassAmu?: 4;
  /** Host-granted soft budget, not a claim that a kernel hard limit is active. */
  memoryBudgetBytes?: number;
  /** Derived capability route, validated again by the host and worker. */
  driver?: ConformerSamplingDriver; driverReason?: ConformerSamplingDriverReason;
  calculator?: ConformerSamplingCalculatorSettings;
  solvation?: { model: 'alpb' | 'gbsa'; solvent: string };
  coreProtection?: ConformerCoreProtection;
  sphere?: ConformerSamplingSphere;
  nativeProtection?: ConformerNativeProtection;
}
export type ConformerSamplingRequest = ConformerSamplingRequestBase & (
  | { operation: 'md'; molecularMD?: ConformerMolecularMDSettings; annealing?: never; metadynamics?: never; sphericalMD?: never }
  | { operation: 'anneal'; annealing?: ConformerAnnealingSettings; molecularMD?: never; metadynamics?: never; sphericalMD?: never }
  | { operation: 'metadynamics'; metadynamics?: ConformerMetadynamicsSettings; molecularMD?: never; annealing?: never; sphericalMD?: never }
  | { operation: 'spherical-md'; sphericalMD?: ConformerSphericalMDSettings; sphere: ConformerSamplingSphere; molecularMD?: never; annealing?: never; metadynamics?: never }
);
export interface ConformerCoreDiagnostics {
  rmsdAngstrom: number; maxResidualAngstrom: number; rank: 0 | 1 | 2 | 3;
  orientationUnique: boolean; degeneracy: 'none' | 'single-atom' | 'collinear-or-coincident';
}
export interface ConformerNativeMDFrameEvidence {
  method: 'gfnff' | 'gfn0' | 'gfn1' | 'gfn2'; version: string; inputSha256: string;
  shakeHydrogenBonds: boolean;
  /** Legacy natural-mass evidence; never emitted for fixed-mass runs. */
  hydrogenMassScaling?: 1;
  hydrogenMassAmu?: 4 | null; hydrogenMassMode?: 'natural' | 'fixed-amu';
  sourceArtifact: 'xtb.trj' | 'mdrestart'; rawIndex: number;
  frameTiming: 'pre-step' | 'restart-final'; velocityPhase: 'half-step' | 'restart' | 'unavailable';
  nativeClosed: boolean;
  energyDefinition?: 'native-total-including-sampling-potentials' | 'native-physical-potential';
  temperatureObservation?: ConformerNativeTemperatureObservation | { status: 'unavailable'; reason: string; sourceCommit: string; [key: string]: unknown };
  nativeProtection?: ConformerNativeProtectionEvidence;
  metadynamics?: { atomIds:string[]; nativeAtomIndices:number[]; heightEV:number; sigmaAngstrom:number;
    factorHartree:number; alphaInverseBohr2:number; depositSteps:number; depositEveryFs:number; maxHistory:number;
    scoordFs:number; rampPerStep:number; definition:string; initialReference:string; historyPolicy:string;
    depositTiming:string; instantaneousBiasEnergy:string };
}
/** Native stdout records a centred velocity observation from the preceding coordinate step. */
export interface ConformerNativeTemperatureObservation {
  step: number; timeFs: number; printedAtStep: number;
  temperatureK: number; kineticEnergyEV: number;
  sourceArtifact: 'stdout.txt'; sourceCommit: string;
  velocityPhase: 'centred-before-SHAKE-and-rmrottr';
  temperatureResolutionK: 1; kineticEnergyResolutionHartree: 0.0001;
}
export interface ConformerSamplingEffectiveResources {
  threads: number; memoryBudgetBytes?: number; version?: string | number; source?: string; memoryEnforced: false;
  configured?: { threads: number; memoryBudgetBytes?: number; version?: string | number; source?: string };
  requested?: { threads?: number; memoryBudgetBytes?: number };
  actual?: { threads: number; memoryBudgetBytes?: number };
  reservedBytes?: number; threadLimitReason?: string;
}
export interface ConformerSamplingFramePayload extends ConformerSamplingSegmentProgress {
  stageId: string; collectionId: 'sampled-candidates' | 'sampling-trajectory';
  frameIndex: number; role: 'sampled-candidate' | 'trajectory'; step: number; timeFs: number;
  driver?: ConformerSamplingDriver;
  coordinates: (Atom & { id: string })[]; velocitiesAngstromPerFs: Vector3[] | null;
  physicalEnergyEV: number | null; coreBiasEV: number | null; metaBiasEV: number | null; sphereBiasEV: number | null;
  sampledPotentialEV: number | null; kineticEnergyEV: number | null; temperatureK: number | null; targetTemperatureK: number;
  biasHistoryCount: number; diagnostics: { maxWallPenetrationAngstrom: number; core?: ConformerCoreDiagnostics;
    nativeCoreMaxPairResidualAngstrom?: number;
    shake?: { enabled: boolean; hydrogenBondCount: number | null; maxBondResidualAngstrom: number | null;
      algorithm: 'ASE-RATTLE' | 'native-X-H' | 'native-xTB-SHAKE'; actualConstraintCount?: number;
      reference?: 'input-geometry'; observedBondLengthsAngstrom?: number[] } };
  nativeMD?: ConformerNativeMDFrameEvidence;
  requiresUnbiasedOptimization: boolean; optimizationPerformed: false; cycleIndex?: number;
  calculatorEvidence?: { engine: 'native-xtb'; method: 'gfnff' | 'gfn0'; version: string; forceFieldTopologySha256?: string;
    evaluations: number; spinTreatment: 'not-supported' | 'native-uhf'; coordinateTransform: { kind: 'identity'; offsetAngstrom: [0, 0, 0] };
    lastEvaluation: { evaluation: number; inputSha256: string; engradSha256: string; energyHartree: number;
      forceFieldTopologySha256?: string; topologyReadFromOwnedSeed: boolean; nativeClosed: true } };
  units: { coordinates: 'angstrom'; velocity: 'angstrom/fs'; energy: 'eV'; time: 'fs'; temperature: 'K' };
}
export interface ConformerBiasHistoryEntry {
  index: number; step: number; timeFs: number; atomIds: string[]; coordinatesAngstrom: Vector3[];
  heightEV: number; sigmaAngstrom: number;
}
interface ConformerSamplingEventBase extends ConformerSamplingSegmentProgress {
  schema: 1; sessionId: string; stamp: DocumentStamp & { activationEpoch?: number };
  runIdentity: ConformerSamplingRunIdentity; operation: ConformerSamplingOperation;
  method: ConformerSamplingMethod; seq: number;
  effectiveResources?: ConformerSamplingEffectiveResources;
}
export interface ConformerSamplingFrameEvent extends ConformerSamplingEventBase, ConformerSamplingFramePayload { event: 'frame' }
export interface ConformerSamplingStageEvent extends ConformerSamplingEventBase {
  event: 'stage'; stageId: string; status: 'started' | 'completed'; step: number;
  configuration?: ConformerSamplingRequest; seed?: number; cycleIndex?: number;
  steps?: number; startTemperatureK?: number; endTemperatureK?: number; skipped?: boolean; candidates?: number;
  integration?: { driver: 'ASE-Langevin' | 'native-xtb-md'; aseVersion?: string; fixcm?: false; dtFs: number; frictionPerFs?: number;
    shakeHydrogenBonds?: boolean; constraintAlgorithm?: 'ASE-RATTLE' | 'native-X-H'; thermostat?: 'Berendsen';
    hydrogenMassAmu?: 4 | null; hydrogenMassMode?: 'natural' | 'fixed-amu';
    seedTreatment?: 'native-internal-initialization'; requestedSeed?: number; effectiveSeed?: null;
    frictionTreatment?: 'not-applicable-native-Berendsen' };
  coordinateTransform?: { kind: 'identity' | 'translation'; offsetAngstrom: Vector3 };
  nativeProtection?: ConformerNativeProtectionEvidence;
}
export interface ConformerSamplingBiasEvent extends ConformerSamplingEventBase {
  event: 'bias'; stageId: 'metadynamics'; historyEntry: ConformerBiasHistoryEntry;
}
/** The native run completed, but its observed mean temperature missed the target by more than 2%. */
export interface ConformerNativeMDTemperatureWarning {
  kind:'average-temperature-deviation'; message:'thermostating problem';
  targetTemperatureK:number; averageTemperatureK:number; relativeDeviation:number;
}
export interface ConformerSamplingCompletionEvent extends ConformerSamplingEventBase {
  resultHandle?:{id:string;frameCount:number};
  event: 'completed'; workerSettled: true; samplingCompleted: true; optimizationPerformed: false;
  requiresUnbiasedOptimization: true; candidateCount: number; frameCount: number; step: number;
  evaluations: number | null; driver?: ConformerSamplingDriver;
  evaluationCountSource?: 'observed-physical-calculator' | 'not-reported-native-md'; budgetEvaluationUpperBound?: number;
  seed: number; lastFrame: ConformerSamplingFramePayload;
  biasHistory: ConformerBiasHistoryEntry[]; postSamplingPotentials: { core: false; metadynamics: false; sphere: false };
  exit?: { code: number | null; signal: string | null };
  diagnosticDirectory?: string; nativeClosed?: boolean;
  thermostatWarning?:ConformerNativeMDTemperatureWarning;
  nativeTemperatureObservations?: ConformerNativeTemperatureObservation[];
}
export interface ConformerSamplingStopEvent extends ConformerSamplingEventBase {
  biasHistory?:ConformerBiasHistoryEntry[];
  resultHandle?:{id:string;frameCount:number};
  event: 'stopped'; workerSettled: true; reason: string; lastFrame?: ConformerSamplingFramePayload | null;
  exit?: { code: number | null; signal: string | null };
  diagnosticDirectory?: string; nativeClosed?: boolean;
  nativeTemperatureObservations?: ConformerNativeTemperatureObservation[];
}
export interface ConformerSamplingErrorEvent extends ConformerSamplingEventBase {
  biasHistory?:ConformerBiasHistoryEntry[];
  resultHandle?:{id:string;frameCount:number};
  event: 'error'; workerSettled: true; error: { code: string; message: string }; lastFrame?: ConformerSamplingFramePayload | null;
  exit?: { code: number | null; signal: string | null };
  diagnosticDirectory?: string; nativeClosed?: boolean;
  nativeTemperatureObservations?: ConformerNativeTemperatureObservation[];
}
export type ConformerSamplingEvent = ConformerSamplingFrameEvent | ConformerSamplingStageEvent
  | ConformerSamplingBiasEvent | ConformerSamplingCompletionEvent | ConformerSamplingStopEvent
  | ConformerSamplingErrorEvent | (ConformerSamplingEventBase & { event: 'started'; status: 'running' })
  | (ConformerSamplingEventBase & { event: 'progress'; phase: 'native-md'; step: number; frameCount: number; candidateCount?: number });
export interface ConformerSamplingBridge {
  readConformerSamplingResult?(handleId:string,offset:number,limit:number):Promise<{frames:ConformerSamplingFrameEvent[];offset:number;total:number;done:boolean}>;
  releaseConformerSamplingResult?(handleId:string):Promise<unknown>;
  startConformerSampling(request: ConformerSamplingRequest, sessionId: string): Promise<{ sessionId: string; status: 'starting' | 'stopped' | 'error' }>;
  commandConformerSampling(sessionId: string, command: { command: 'stop' }): Promise<{ sessionId: string; status: 'stopped' }>;
  onConformerSamplingEvent(listener: (event: ConformerSamplingEvent) => void): () => void;
}

/** Default sphere uses nuclear-coordinate extent; no atomic radius or source translation. */
export function suggestConformerSamplingSphere(structure: Pick<Structure, 'atoms'>, marginAngstrom = 3): ConformerSamplingSphere {
  const atoms = structure.atoms;
  if (!atoms.length || !Number.isFinite(marginAngstrom) || marginAngstrom < 0 || marginAngstrom > 1000
    || atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('球预览需要有限坐标和有效余量。');
  const sphere=minimumEnclosingSphere(atoms.map(atom=>[atom.x,atom.y,atom.z] as Vector3));
  return { centerAngstrom: sphere.centerAngstrom, radiusAngstrom: sphere.radiusAngstrom+marginAngstrom, forceConstantEVPerAngstrom2: 1 };
}

/** These are candidate capabilities until each route/method's native fixture gate passes. */
export const CONFORMER_SAMPLING_CAPABILITIES = Object.freeze({
  implementedMethods: ['MMFF94', 'MMFF94s', 'UFF', 'gfn0', 'gfn1', 'gfn2', 'gfnff'] as readonly ConformerSamplingMethod[],
  nativeRouteValidation: 'not-run' as const,
  gfnff: { status: 'implemented-unverified' as const, solvation: 'not-enabled' as const,
    reason: 'Isolated native gradient adapter retains its fixed initial topology. Native validation is pending; implicit solvation is not enabled.' },
  gfn0: { status: 'implemented-unverified' as const, solvation: 'not-enabled' as const,
    reason: 'Isolated native GFN0 gradient adapter; no dedicated implicit-solvent parameterization is exposed.' },
});
