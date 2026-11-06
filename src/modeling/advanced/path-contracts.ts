import type { Structure } from '../../core/types';
import type { DocumentStamp, ModelCoordinate } from '../../core/modeling/contracts';

/** Native path operations use one explicit electronic state for both endpoints.
 * Scientific acceptance tolerances belong to acceptance evidence, not this request. */
export type AdvancedPathMethod = 'gfn1' | 'gfn2';
export type AdvancedPathOperation = 'scan' | 'ts' | 'ci-neb-ts';
export interface AdvancedPathRunIdentity { taskId: string; runId: string }
export type AdvancedPathStamp = DocumentStamp & { activationEpoch?: number };
export type AdvancedPathCoordinate = Pick<Structure['atoms'][number], 'id' | 'element' | 'x' | 'y' | 'z'>;
export type AdvancedPathInternalCoordinate = Pick<ModelCoordinate, 'id' | 'objectId' | 'type' | 'atomIds'>;
export type AdvancedPathFreeze = AdvancedPathInternalCoordinate & {
  action: 'freeze'; value?: number; source?: 'orca'; steps?: 0 | 1; increment?: null;
};
export interface AdvancedPathCalculatorSettings {
  accuracy?: number; maxIterations?: number; electronicTemperatureK?: number;
}
export type AdvancedPathInitialMode =
  | { kind: 'vector'; vectors: { atomId: string; x: number; y: number; z: number }[] }
  | { kind: 'estimated'; seed: number };
export type AdvancedPathModeSource =
  | Extract<AdvancedPathInitialMode, { kind: 'vector' }>
  | { kind: 'estimated'; algorithm: 'seeded-gaussian-direction'; seed: number }
  | { kind: 'neb-tangent'; stageId: 'climbing-neb'; imageIndex: number };
export interface AdvancedPathScanAxis {
  coordinate: AdvancedPathInternalCoordinate;
  /** Directed inclusive endpoints: no implicit shortest dihedral arc. */
  start: number; stop: number;
}
export type AdvancedPathScanSettings =
  | (AdvancedPathScanAxis & { pointCount: number })
  | { combination?: 'synchronous'; coordinates: AdvancedPathScanAxis[]; pointCount: number }
  | { combination: 'grid'; coordinates: (AdvancedPathScanAxis & { pointCount: number })[] };
export type AdvancedPathInitialPath = 'linear' | 'idpp' | 'sidpp' | 'xtb-bpp';
export interface AdvancedPathScanTarget extends AdvancedPathInternalCoordinate {
  target: number; unit: 'angstrom' | 'degree';
}
export interface AdvancedPathFeasibilityProjection {
  role: 'feasibility-only'; optimizerSuccess: boolean; status: number; message: string;
}
/** Internal optimizer controls; not a new physical method or user freeze. */
export interface AdvancedPathScanLocalBox {
  maxAtomDisplacementAngstrom: 0.10; cartesianHalfWidthAngstrom: number;
  recenterPolicy: 'successful-feasible-boundary-progress-only';
}
export interface AdvancedPathScanSolverSegment {
  segmentIndex: number; optimizerSuccess: boolean; status: number; message: string;
  iterations: number; chargedMajorIterations: number; cumulativeMajorIterations: number;
  feasible: boolean; boundaryReached: boolean; maximumCartesianProgressAngstrom: number | null;
  maxTrialAtomDisplacementAngstrom: number; evaluations: number;
  projectedForceMaxEVPerAngstrom?: number; reason?: 'physical-force-converged' | 'local-bound-limited';
}
export type AdvancedPathDiagnosticResidual = Omit<AdvancedPathConstraintResidual, 'actual' | 'residual'> & {
  actual: number | null; residual: number | null; measurementError?: string;
};
/** Failed trials are diagnostic data, never accepted geometry/result frames. */
export type AdvancedPathDiagnosticCoordinate = Omit<AdvancedPathCoordinate, 'x' | 'y' | 'z'> & {
  x: number | null; y: number | null; z: number | null;
};
export interface AdvancedPathProjectionDiagnostic {
  solver: 'scipy-slsqp'; phase: 'feasibility-projection'; pointIndex: number; gridIndices: number[];
  status: number | null; message: string; optimizerSuccess: boolean; iterations: number | null;
  initialResiduals: AdvancedPathConstraintResidual[];
  finalResiduals: AdvancedPathDiagnosticResidual[];
  constraintTolerances: { B: number; A: number; D: number };
}
export interface AdvancedPathTrialDiagnostic {
  dataRole: 'unaccepted-evaluation-trial'; acceptedResult: false;
  solver: 'scipy-slsqp'; phase: 'physical-evaluation'; stageId: AdvancedPathStageId;
  pointIndex: number; gridIndices: number[]; targets: AdvancedPathScanTarget[];
  coordinateUnit: 'angstrom'; coordinates: AdvancedPathDiagnosticCoordinate[];
  allCoordinatesFinite: boolean; coordinatesCapturedBeforeEvaluation: true;
  requestSite: 'objective-trial' | 'projected-force-check'; failedPropertyPhase: 'energy' | 'forces';
  valueFunctionCallOrdinal: number; objectiveCallOrdinal: number;
  callbackEnteredCount: number; completedCallbackCount: number;
  localBox: AdvancedPathScanLocalBox; segmentIndex: number; completedMajorIterations: number; segmentCallbackCount: number;
  segmentAnchorCoordinates: AdvancedPathDiagnosticCoordinate[]; completedSolverSegments: AdvancedPathScanSolverSegment[];
  evaluationsAtPointStart: number; evaluationsBeforeCall: number; evaluationsAfterFailure: number;
  /** Invocation attempts include the failed E/F call, not just successful SCF calls. */
  pointEvaluationAttempts: number; physicalInvocationObserved: boolean; physicalEvaluationOrdinal: number | null;
  trialConstraintResiduals: AdvancedPathDiagnosticResidual[]; constraintTolerances: { B: number; A: number; D: number };
  seedProjection: AdvancedPathFeasibilityProjection & { iterations: number; coordinates: AdvancedPathDiagnosticCoordinate[];
    constraintResiduals: AdvancedPathDiagnosticResidual[] };
  lastCompletedCallbackCoordinates: AdvancedPathDiagnosticCoordinate[] | null;
  maxAtomDisplacementFromSeedAngstrom: number | null; maxAtomDisplacementFromLastCallbackAngstrom: number | null;
  pairDistances: { scope: 'all-pairs-small-system' | 'first12-related-plus-global-minimum'; relatedAtomCount: number;
    pairAtomIdsIncluded: string[]; relatedAtomsTruncated: boolean;
    pairs: { atomIds: [string, string]; distanceAngstrom: number | null }[];
    minimumFinitePairDistanceAngstrom: number | null; closestFinitePairAtomIds: [string, string] | null };
  sourceError: { type: string; message: string }; upstreamDiagnostic?: unknown;
}
export interface AdvancedPathDiagnosticCaptureFailure {
  dataRole: 'unaccepted-evaluation-trial'; acceptedResult: false; stageId: AdvancedPathStageId;
  pointIndex: number; evaluationsAfterFailure: number; diagnosticCaptureError: string;
}
export interface AdvancedPathScanSolverDiagnostic {
  solver: 'scipy-slsqp'; phase: 'local-box-solve'; pointIndex: number; gridIndices: number[];
  targets: AdvancedPathScanTarget[]; target?: number; feasibilityProjection: AdvancedPathFeasibilityProjection;
  localBox: AdvancedPathScanLocalBox; segmentIndex: number; solverSegments: AdvancedPathScanSolverSegment[]; cumulativeMajorIterations: number;
}
export type AdvancedPathErrorDiagnostic = AdvancedPathProjectionDiagnostic | AdvancedPathTrialDiagnostic | AdvancedPathDiagnosticCaptureFailure | AdvancedPathScanSolverDiagnostic;
export interface AdvancedPathNebSettings {
  product: Structure;
  mapping: { reactantAtomId: string; productAtomId: string }[];
  imageCount?: number; initialPath?: AdvancedPathInitialPath;
  /** Physical RMSD-BPP, not NEB. Native E/F count is unobservable (null).
   * maxEvaluations caps only the subsequent TBLite NEB/TS stages. */
  bpp?: { npoint?: number; anopt?: number; kpush?: number; kpull?: number; ppull?: number; alp?: number };
  springConstantEVPerAngstrom2?: number;
  preoptimizeEndpoints?: boolean;
  warmupForceToleranceEVPerAngstrom?: number;
  /** IDPP is geometric optimization; this mode creates no physical calculator. */
  previewOnly?: boolean;
}
interface AdvancedPathRequestBase {
  schema: 1; stamp: AdvancedPathStamp; runIdentity: AdvancedPathRunIdentity;
  structure: Structure; method: AdvancedPathMethod; charge: number; uhf: number;
  frozenAtomIds?: string[]; constraints?: AdvancedPathFreeze[];
  threads?: number; maxSteps?: number; maxEvaluations?: number; maxWallTimeSeconds?: number;
  /** Actual search stopping criterion in eV/angstrom, not an acceptance tolerance. */
  forceToleranceEVPerAngstrom?: number;
  calculator?: AdvancedPathCalculatorSettings;
}
export type AdvancedPathRequest = AdvancedPathRequestBase & (
  | { operation: 'scan'; scan: AdvancedPathScanSettings; ts?: never; neb?: never }
  | { operation: 'ts'; ts: { initialMode: AdvancedPathInitialMode }; scan?: never; neb?: never }
  | { operation: 'ci-neb-ts'; neb: AdvancedPathNebSettings; scan?: never; ts?: never }
);
export type AdvancedPathStageId =
  | 'configuration' | 'initial-path' | 'reactant-opt' | 'product-opt'
  | 'neb' | 'climbing-neb' | 'ts-dimer' | 'neb-ts-dimer' | `scan-point-${number}`;
export interface AdvancedPathConstraintResidual {
  id: string; type: 'B' | 'A' | 'D'; atomIds: string[];
  target: number; actual: number; residual: number; unit: 'angstrom' | 'degree';
}
export interface AdvancedPathUnits {
  coordinates: 'angstrom'; energy: 'eV'; forces: 'eV/angstrom'; curvature: 'eV/angstrom^2';
}
interface AdvancedPathFrameBase {
  stageId: AdvancedPathStageId; collectionId: string;
  /** Source ordinals are zero based; presentation applies its own one-based labels. */
  frameIndex: number; iteration: number; imageIndex?: number; pointIndex?: number; target?: number;
  targets?: AdvancedPathScanTarget[]; gridIndices?: number[];
  segmentIndex?: number; completedMajorIterations?: number; segmentCallbackCount?: number; cumulativeMajorIterations?: number;
  feasibilityProjection?: AdvancedPathFeasibilityProjection;
  coordinates: AdvancedPathCoordinate[]; constraintResiduals: AdvancedPathConstraintResidual[];
  units: AdvancedPathUnits;
}
export type AdvancedPathFrameData = AdvancedPathFrameBase & (
  | { role: 'initial-path'; imageIndex: number; energyEV?: never; rawForcesEVPerAngstrom?: never;
      projectedForceMaxEVPerAngstrom?: never; curvatureEVPerAngstrom2?: never; initialModeSource?: never }
  | { role: 'optimizer' | 'point-result' | 'candidate'; energyEV: number;
      rawForcesEVPerAngstrom: [number, number, number][]; projectedForceMaxEVPerAngstrom: number;
      curvatureEVPerAngstrom2?: number; initialModeSource?: AdvancedPathModeSource; searchConverged?: boolean }
);
/** Terminal snapshots retain the raw worker frame, without a second source owner. */
export type AdvancedPathFrameSnapshot = AdvancedPathFrameData & { kind: 'frame' };
export interface AdvancedPathStageSummary {
  stageId: AdvancedPathStageId; searchConverged: boolean;
  pointIndex?: number; target?: number; targets?: AdvancedPathScanTarget[]; gridIndices?: number[]; energyEV?: number; reason?: string;
  feasibilityProjection?: AdvancedPathFeasibilityProjection;
  curvatureEVPerAngstrom2?: number; initialModeSource?: AdvancedPathModeSource;
  highestEnergyImageIndex?: number; climbingImageIndex?: number | null;
  evaluationsAtPointStart?: number; evaluations?: number; cumulativeEvaluations?: number;
  localBox?: AdvancedPathScanLocalBox; segmentIndex?: number; cumulativeMajorIterations?: number; solverSegments?: AdvancedPathScanSolverSegment[];
}
export type AdvancedPathStageConfiguration =
  | AdvancedPathRequest
  | { solver: 'scipy-slsqp'; constraintTolerances: { B: number; A: number; D: number }; localBox?: AdvancedPathScanLocalBox }
  | { algorithm: 'ase-dimer'; aseVersion: string; dimerSeparationAngstrom: number; maximumTranslationAngstrom: number }
  | AdvancedPathNebSettings
  | { climb: boolean; forceToleranceEVPerAngstrom: number; method: 'improvedtangent' };
interface AdvancedPathEventBase {
  schema: 1; sessionId: string; stamp: AdvancedPathStamp; runIdentity: AdvancedPathRunIdentity;
  operation: AdvancedPathOperation; method: AdvancedPathMethod;
  /** Host sequence includes started and only increases within this owned session. */
  seq: number;
}
interface AdvancedPathTerminalBase {
  workerSettled: true;
  /** Host publishes this event only after its exact owned ChildProcess closes. */
  exit: { code: number | null; signal: string | null };
}
interface AdvancedPathCompletedBase extends AdvancedPathTerminalBase {
  stationaryPointValidation: 'not-run'; stages: AdvancedPathStageSummary[];
  lastFrame: AdvancedPathFrameSnapshot; evaluations: number; elapsedSeconds: number;
  backend: { driver: 'ASE'; aseVersion: string; calculator: 'tblite' | 'none'; method: AdvancedPathMethod;
    physicalCalculatorCreated: boolean };
  nativeInitialPath?: AdvancedPathBppEvidence;
}
export interface AdvancedPathBppEvidence {
  driver: 'xtb-rmsd-bpp'; source: string; defaultsReference: string; version: string; diagnosticDirectory: string;
  physicalEvaluationCount: null; evaluationBudgetScope: 'subsequent-tblite-neb-ts-only';
  maximumBiasTrials: 24; refinementRuns: 1;
  nativeControls: AdvancedPathNebSettings['bpp'] & { trialOptimizationMaxCycles: null; requestedMaxSteps: number; requestMaxStepsAppliedToSearch: false };
  searchTrialCycleControl: { source: 'locked-get_optthr-with-zero-maxcycle-input'; minimum: 200; maximum: 10000;
    optLevelDependent: true; observed: false };
  actualTrialCount: number | null; selectedTrial: number | null; selectedFrameCount: number | null;
  actualPathFrameCount: number | null; actualRefinementRuns: number | null;
  sourceFixedControls: { singlepointAccuracy: 2; maximumDisplacementBohr: 0.5; hlow: 0.03 };
  rawFrames: [number, number, number][][]; rawComments: string[]; physicalEnergiesReused: false;
  derivation: 'proper-fit-source-reactant-pin-exact-endpoints-cartesian-arclength-resample';
  sourceReactantFitRMSDAngstrom: number;
}
export type AdvancedPathEvent = AdvancedPathEventBase & (
  | { event: 'started'; status: 'running' }
  | ({ event: 'frame' } & AdvancedPathFrameData)
  | { event: 'stage'; stageId: AdvancedPathStageId; phase: 'started' | 'completed';
      configuration?: AdvancedPathStageConfiguration; constraintTolerances?: { B: number; A: number; D: number };
      pointIndex?: number; target?: number; targets?: AdvancedPathScanTarget[]; gridIndices?: number[]; feasibilityProjection?: AdvancedPathFeasibilityProjection; initialModeSource?: AdvancedPathModeSource;
      sourceRole?: 'endpoint-copy'; searchConverged?: boolean; energyEV?: number; reason?: string;
      curvatureEVPerAngstrom2?: number; highestEnergyImageIndex?: number; climbingImageIndex?: number | null;
      evaluationsAtPointStart?: number; evaluations?: number; cumulativeEvaluations?: number;
      solver?: 'scipy-slsqp'; localBox?: AdvancedPathScanLocalBox; segmentIndex?: number; cumulativeMajorIterations?: number; solverSegments?: AdvancedPathScanSolverSegment[];
      initialPathMethod?: AdvancedPathInitialPath; physicalEvaluations?: 0 | null; previewOnly?: boolean; nativeInitialPath?: AdvancedPathBppEvidence;
      sidpp?: { driver: 'sequential-idpp'; reference: string; objectiveUnit: 'angstrom^-2';
        objectiveGradientUnit: 'angstrom^-3'; geometrySteps: number; [key: string]: unknown } }
  | (AdvancedPathCompletedBase & { event: 'completed'; resultKind: 'scan'; searchConverged: true;
      points: AdvancedPathStageSummary[] })
  | (AdvancedPathCompletedBase & { event: 'completed'; resultKind: 'ts-candidate'; searchConverged: true;
      curvatureEVPerAngstrom2: number })
  | (AdvancedPathCompletedBase & { event: 'completed'; resultKind: 'initial-path'; searchConverged: false })
  | (AdvancedPathTerminalBase & { event: 'stopped'; reason: 'cancelled';
      lastFrame?: AdvancedPathFrameSnapshot | null; stages?: AdvancedPathStageSummary[]; evaluations?: number; elapsedSeconds?: number })
  | (AdvancedPathTerminalBase & { event: 'error'; error: { code: string; message: string; diagnostic?: AdvancedPathErrorDiagnostic };
      lastFrame?: AdvancedPathFrameSnapshot | null; stages?: AdvancedPathStageSummary[]; evaluations?: number; elapsedSeconds?: number })
);
export interface AdvancedPathBridge {
  startAdvancedPath(request: AdvancedPathRequest, sessionId: string): Promise<{
    sessionId: string; status: 'starting' | 'stopped' | 'error';
  }>;
  /** Resolves after real owned close, not after a kill request or timer expires. */
  commandAdvancedPath(sessionId: string, command: { command: 'stop' }): Promise<{
    sessionId: string; status: 'stopped';
  }>;
  onAdvancedPathEvent(listener: (event: AdvancedPathEvent) => void): () => void;
}
