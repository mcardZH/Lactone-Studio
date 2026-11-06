import type { Structure } from '../../core/types';
import type { ChemistryPort, ForcefieldChoice } from '../contracts';
import type { XtbBridge, XtbMethod, XtbMetadata, XtbRequest, XtbElectronicArtifactBundle, XtbSolvation } from '../xtb/contracts';
import type { AdvancedFrameRef, AdvancedFrameSource } from './frame-source';
import type { ConformerClusteringPolicy, ConformerClusterSet, ConformerGuessSet, ConformerQuantityPolicy,
  ConformerTorsionSampling, ConformerSamplingLimits, ConformerClashPolicy, ConformerCalculationIdentity } from '../conformers';
import type { AdvancedPathBridge, AdvancedPathRequest, AdvancedPathEvent, AdvancedPathFrameData } from './path-contracts';
import type { ConformerSamplingBridge, ConformerSamplingRequest, ConformerSamplingEvent, ConformerSamplingFramePayload } from './sampling-contracts';
import type { AissBridge, AissRequest, AissEvent, AissScreenedPose, AissRefinedCandidate, AissAtomMapping } from './docking-contracts';
import type { ComputeResourceEvidence, ComputeResourceSnapshot } from '../resource-preferences';
type WithoutOwner<T> = T extends unknown ? Omit<T, 'schema' | 'stamp' | 'runIdentity' | 'structure' | 'charge' | 'uhf' | 'frozenAtomIds' | 'constraints'> : never;
export type AdvancedPathTaskOptions = WithoutOwner<AdvancedPathRequest> & { threads: number; maxSteps: number; maxEvaluations: number };
export type AdvancedSamplingTaskOptions = WithoutOwner<ConformerSamplingRequest> & { threads: number; maxSteps: number; maxEvaluations: number };
export type AdvancedDockingTaskOptions = Omit<AissRequest, 'schema' | 'operation' | 'stamp' | 'runIdentity' | 'sources'> & { threads: number };

export interface AdvancedRunBudget {
  /** Legacy record fields only. Advanced runs no longer enforce wall-clock deadlines. */
  maxTaskSeconds?: number; maxSubjobSeconds?: number; maxCandidates: number; maxStages: number;
  maxNativeJobs: number; maxRetainedFrames: number; maxRetainedCoordinates: number;
  /** Native process stages (scan points, NEB phases, annealing segments) are not optimization levels. */
  maxProcessStages: number; maxBiasHistoryEntries: number;
}
export const DEFAULT_ADVANCED_RUN_BUDGET: Readonly<AdvancedRunBudget> = Object.freeze({
  maxCandidates: 2000, maxStages: 8,
  maxNativeJobs: 2001, maxRetainedFrames: 10000, maxRetainedCoordinates: 5000000,
  maxProcessStages: 512, maxBiasHistoryEntries: 4096,
});
export interface AdvancedXtbOptions {
  method: XtbMethod; threads: number; maxSteps: number; solvent: string;
  maxSccIterations?: number;
  internalConstraintsConfirmed: boolean;
  solvation?: XtbSolvation;
  memoryBudgetBytes?: number;
}
export type AdvancedOptimizationMethod =
  | { backend: 'xtb'; options: AdvancedXtbOptions }
  | { backend: 'forcefield'; forcefield: ForcefieldChoice; threads: number; maxSteps: number; solvent: string };
export interface AdvancedOptimizationStageConfig {
  id: string; method: AdvancedOptimizationMethod; clustering?: Partial<ConformerClusteringPolicy>;
  /** Legacy producer-side selection, retained only for historical/non-conformer runs. */
  advanceCount?: number;
  /** Receiving conformer stage only. The first stage has no upstream count. */
  inputClusterCount?: number;
  /** Stable source order, starting with the first input; positive integer. */
  inputStride?: number; checkpointAfter: boolean;
}
interface AdvancedTaskBase {
  source: AdvancedFrameSource; label?: string; budget?: Partial<AdvancedRunBudget>;
}
export interface AdvancedSameFrameFragments {
  aAtomIds: string[]; bAtomIds: string[];
  /** Explicit per-fragment confirmation, never guessed from the full frame. */
  electronicStates: [{ charge: 0; multiplicity: 1 }, { charge: 0; multiplicity: 1 }];
}
export interface AdvancedFlexibleSamplingDefinition {
  torsions: ConformerTorsionSampling[]; quantity: ConformerQuantityPolicy;
  samplingLimits?: Partial<ConformerSamplingLimits>; clashPolicy?: Partial<ConformerClashPolicy>;
}
export type AdvancedMixedSamplingCard =
  | { id: string; kind: 'sampling'; sampling: AdvancedSamplingTaskOptions }
  | { id: string; kind: 'conformer-search'; search: AdvancedFlexibleSamplingDefinition };
/** Draft only. Each run captures its own selected initial geometry and settings. */
export interface AdvancedMixedSamplingDefinition {
  cards: AdvancedMixedSamplingCard[]; dedupRmsdAngstrom?: number;
  /** One optional final collection pass; generation itself counts received frames. */
  deduplicationEnabled?: boolean;
  /** Omitted inherits the selected initial; [] explicitly removes all atom protection. */
  protectedAtomIds?: string[];
  coreProtection?: ConformerSamplingRequest['coreProtection'];
  nativeProtection?: ConformerSamplingRequest['nativeProtection'];
  sphere?: ConformerSamplingRequest['sphere'];
}
export interface AdvancedMixedInitialGuess {
  id: string; label: string; source: AdvancedFrameSource;
  revision?: number;
  atomMapping: { sourceAtomId: string; taskAtomId: string }[];
}
export interface AdvancedMixedSamplingRun {
  batchId?: string;
  currentSegmentId?:string;
  deduplicationCompleted?: boolean;
  /** Actual classified count; unclassified complete frames remain candidates. */
  deduplicationProcessed?:number;deduplicationTotal?:number;
  mode: 'replace' | 'append' | 'continue'; initialGuessId: string; source: AdvancedFrameSource;
  definition: AdvancedMixedSamplingDefinition; currentCardIndex: number;
  generated: number; duplicates: number; coreRejected: number; accepted: number;
  cards: { id: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped'; error?: string;
    generated: number; duplicates: number; coreRejected: number; accepted: number; frameIds: string[];
    sampling?: AdvancedTaskRun['sampling'] }[];
}
export interface AdvancedSamplingSegment {
  id:string;runId:string;source:AdvancedFrameSource;targetTimeFs:number;completedTimeFs:number;completedTimeBeforeFs?:number;
  frameIds:string[];candidateFrameIds:string[];status:'running'|'completed'|'stopped'|'failed';
}
export interface AdvancedSamplingCardState {
  receivedFrameCount?:number;
  id:string;configurationRevision:number;configuration:AdvancedMixedSamplingCard;scienceKey:string;
  status:'pending'|'running'|'completed'|'failed'|'stopped';error?:string;
  frameIds:string[];mergedFrameIds:string[];completedTimeFs:number;segments:AdvancedSamplingSegment[];
  generated:number;duplicates:number;coreRejected:number;accepted:number;
  guesses?:ConformerGuessSet;torsionContinuation?:unknown;exhausted?:boolean;
  sampling?:AdvancedTaskRun['sampling'];
}
export interface AdvancedSamplingBatch {
  id:string;initialGuessId:string;source:AdvancedFrameSource;definition:AdvancedMixedSamplingDefinition;
  createdAt:number;sealed:boolean;sealedReason?:'append'|'optimization'|'legacy';cards:AdvancedSamplingCardState[];mergedFrameIds:string[];
}
export interface AdvancedCandidateInput {candidateId:string;source:AdvancedFrameSource}
export interface AdvancedStageInputSelection {
  schema:1;mode:'sampling-all'|'previous-clusters';collectionId:string;collectionRevision:number;
  collectionSignature:string;requestedCount?:number;actualCount:number;inputStride?:number;
  clusterIds:string[];representativeFrameIds:string[];
}
export interface AdvancedClusterCollection {
  schema:1;id:string;revision:number;taskId:string;configurationId:string;producerRunId:string;stageRunId:string;
  configKey:string;settlement:'complete'|'partial'|'needs-clustering'|'historical-incomplete';current:boolean;
  comparison:{groupId:string;comparisonKey:string;identity:ConformerCalculationIdentity}|null;
  clusters:readonly {
    clusterId:string;representativeCandidateId:string;representativeFrameId:string|null;
    memberCandidateIds:readonly string[];memberCount:number|null;energyHartree:number|null;sourceOrdinal:number;
    unavailableReason?:string;
  }[];
}
export interface AdvancedStageProgress {total:number;completed:number;interrupted:number;failed:number;pending:number;
  succeeded?:number;discarded?:number;running?:number;elapsedMs?:number;etaMs?:number|null;
  baselineSucceeded?:number;baselineDiscarded?:number;startedAt?:number}
export interface AdvancedDiscardConformerPlan {
  taskId:string;revision:string;scope:'task'|'initial'|'sampling'|'stage';initialIds:string[];collectionIds:string[];stageIds:string[];frameIds:string[];
}
export type AdvancedTaskSpec =
  | (AdvancedTaskBase & { kind: 'singlepoint'; options: AdvancedXtbOptions })
  | (AdvancedTaskBase & { kind: 'optimization'; method: AdvancedOptimizationMethod })
  | (AdvancedTaskBase & { kind: 'path'; path: AdvancedPathTaskOptions; productSource?: AdvancedFrameSource })
  | (AdvancedTaskBase & { kind: 'sampling'; sampling: AdvancedSamplingTaskOptions;
    mixedSampling?: AdvancedMixedSamplingDefinition;
    optimizationStages: AdvancedOptimizationStageConfig[]; checkpointAfterSampling: boolean })
  | (AdvancedTaskBase & { kind: 'docking'; partnerSource?: AdvancedFrameSource; fragments?: AdvancedSameFrameFragments; docking: AdvancedDockingTaskOptions;
    optimizationStages: AdvancedOptimizationStageConfig[]; checkpointAfterDocking: boolean })
  | (AdvancedTaskBase & { kind: 'conformer-search'; search: {
    torsions: ConformerTorsionSampling[]; quantity: ConformerQuantityPolicy;
    samplingLimits?: Partial<ConformerSamplingLimits>; clashPolicy?: Partial<ConformerClashPolicy>;
    stages: AdvancedOptimizationStageConfig[]; checkpointAfterGuesses: boolean;
  } });
export type AdvancedRunStatus = 'queued' | 'running' | 'stopping' | 'checkpoint' | 'completed' | 'failed' | 'stopped';
export type AdvancedSamplingConfiguration =
  | { kind: 'sampling'; sampling: AdvancedSamplingTaskOptions }
  | { kind: 'conformer-search'; search: Pick<Extract<AdvancedTaskSpec, { kind: 'conformer-search' }>['search'], 'torsions' | 'quantity' | 'samplingLimits' | 'clashPolicy'> }
  | { kind: 'docking'; fragments: AdvancedSameFrameFragments; docking: AdvancedDockingTaskOptions };
export interface AdvancedResultFrame {
  id: string; taskId: string; runId?: string; stageId: string; candidateId: string;
  kind: 'guess' | 'intermediate' | 'optimized' | 'singlepoint' | 'path-preview' | 'path-optimizer' | 'path-point' | 'ts-candidate' | 'sampling-trajectory' | 'sampled-candidate' | 'docking-screened' | 'docking-refined'; source: AdvancedFrameSource;
  parentRef: AdvancedFrameRef; sessionId?: string; step?: number; energyHartree?: number;
  /** Raw process hierarchy, velocities and bias energies never become optimization energy. */
  process?: { kind: 'path'; data: AdvancedPathFrameData } | { kind: 'sampling'; data: ConformerSamplingFramePayload }
    | { kind: 'docking-screened'; data: AissScreenedPose } | { kind: 'docking-refined'; data: AissRefinedCandidate };
  /** Two complete input sources, not a guessed screened/refined pose bijection. */
  parentRefs?: [AdvancedFrameRef, AdvancedFrameRef];
  samplingOrigin?: { initialGuessId: string; cardId: string; cardRevision?:number;batchId?:string;segmentId?:string;source: AdvancedFrameSource; protectedAtomIds: string[];
    discreteTorsions?:{atomIds:[string,string,string,string];pointIndex:number;pointCount:number;targetDegrees:number}[] };
}
export interface AdvancedCalculationResult {
  originalInput?:AdvancedFrameSource;
  candidateId: string; stageId: string; status: 'completed' | 'failed' | 'stopped';
  input: AdvancedFrameSource; frameId?: string; energyHartree?: number;
  identity?: ConformerCalculationIdentity; metadata?: XtbMetadata; error?: string;
  sessionId?: string; electronic?: { artifactId: string; status: 'retained' | 'transferred' | 'release-failed'; error?: string };
  reusedFromRunId?: string;
  /** Original native input, stdout and optimization trajectory remain on disk. */
  diagnosticDirectory?: string;
}
export interface AdvancedStageRun {
  inputSelection?: AdvancedStageInputSelection;
  adoptionError?:{code:'BATCH_RESULT_ADOPTION_FAILED';batchId:string;message:string};
  progress?:AdvancedStageProgress; resultRevision?:number; batchId?:string;
  inputs?:AdvancedCandidateInput[];inputCollectionRevision?:number;
  id: string; index: number; status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  /** Configuration identity is distinct from this run's unique stage id. */
  configurationId?: string; inputCollectionId?: string; collectionId?: string;
  outcome?: { processed: number; valid: number; failed: number; target: number; actual: number; reason?: string };
  configuration?: AdvancedOptimizationStageConfig;
  inputCandidateIds: string[]; results: AdvancedCalculationResult[]; clustering?: ConformerClusterSet;
  promotedCandidateIds: string[];
}
export interface AdvancedSamplingGenerationProgress {
  taskId:string;runId:string;cardId:string;batchId:string;segmentId:string;
  /** Current card total including the trusted prefix; attempts are diagnostic only. */
  received:number;target:number;baselineReceived:number;attempts:number;baselineAttempts:number;
  startedAt:number;elapsedMs:number;etaMs:number|null;
}
export interface AdvancedTaskRun {
  backgroundProgress?: { phase: 'generate' | 'deduplicate' | 'cluster' | 'prepare-results'; completed: number; total: number | null; valid?: number;elapsedMs?:number;etaMs?:number|null;generation?:AdvancedSamplingGenerationProgress };
  id: string; taskId: string; mode: 'start' | 'resume' | 'retry'; fromRunId?: string;
  status: AdvancedRunStatus; createdAt: number; startedAt?: number; finishedAt?: number;
  intent?: 'sampling' | 'stage' | 'batch'; workflowRevision?: number;
  sourceConfiguration?: AdvancedSamplingConfiguration;
  resourceRequests?: { stageId: string; candidateId: string; sessionId?: string; configured: ComputeResourceSnapshot;
    requested: { threads: number; memoryBudgetBytes: number }; actualThreads?: number; actualGrant?: ComputeResourceEvidence }[];
  stages: AdvancedStageRun[]; frames: AdvancedResultFrame[]; results: AdvancedCalculationResult[];
  checkpoint?: { kind: 'guesses' | 'stage' | 'sampling' | 'docking'; nextStageIndex: number };
  error?: string; stopReason?: string; subjobCount: number; elapsedMs: number;
  intermediateCache?: { policy: 'latest-per-candidate'; observedFrameCount: number; cachedFrameCount: number };
  mixedSampling?: AdvancedMixedSamplingRun;
  path?: { stageEvents: Extract<AdvancedPathEvent, { event: 'stage' }>[]; acceptedCompletion: boolean;
    terminal?: Extract<AdvancedPathEvent, { event: 'completed' | 'stopped' | 'error' }> };
  sampling?: { stageEvents: Extract<ConformerSamplingEvent, { event: 'stage' }>[]; acceptedCompletion: boolean;
    optionalDiagnostics?: string[];
    wallBudgetSeconds?: number; startedAt?: number;
    progress?: Extract<ConformerSamplingEvent, {event:'progress'}>;
    biasEvents: Extract<ConformerSamplingEvent, { event: 'bias' }>[]; candidateFrameIds: string[];
    terminal?: Extract<ConformerSamplingEvent, { event: 'completed' | 'stopped' | 'error' }>; reusedFromRunId?: string };
  docking?: { phaseEvents: Extract<AissEvent, { event: 'progress' }>[]; acceptedCompletion: boolean; acceptedSearchCheckpoint?: boolean;
    nativeRefinement?: Extract<AissEvent, { event: 'search-checkpoint' }>['nativeRefinement'];
    sourceRefs: [AdvancedFrameRef, AdvancedFrameRef]; sourceAtomMapping: AissAtomMapping[];
    screenedFrameIds: string[]; refinedFrameIds: string[];
    rejectedCompletion?: { reason: string; diagnosticDirectory: string; artifacts: AissCompletionArtifacts };
    terminal?: Extract<AissEvent, { event: 'completed' | 'search-checkpoint' | 'stopped' | 'error' }>; reusedFromRunId?: string };
}
type AissCompletionArtifacts = Extract<AissEvent, { event: 'completed' }>['artifacts'];
export interface AdvancedCandidateSet {
  id: string; revision: number; frameIds: string[]; producerRunId?: string; valid: boolean;
}
export interface AdvancedConformerStageState {
  revision?:number;
  resultFrameIds?:string[];completed?:boolean;inputFrameIds?:string[];inputCollectionRevision?:number;progress?:AdvancedStageProgress;
  stageId: string; configKey: string; inputCollectionId: string; collectionId: string;
  producerRunId: string; stageRunId: string; valid: boolean;
  representativeFrameIds: string[]; promotedFrameIds: string[];
}
export interface AdvancedConformerWorkflow {
  inputSemantics?: 2;
  legacyLastAdvanceCount?: number;
  revision: number; candidateSet?: AdvancedCandidateSet; stages: AdvancedConformerStageState[];history?:AdvancedConformerStageState[];
}
export interface AdvancedTaskRecord {
  revision?:number;
  id: string; createdAt: number; spec: AdvancedTaskSpec; budget: AdvancedRunBudget;
  guesses?: ConformerGuessSet; guessFrames: AdvancedResultFrame[]; runs: AdvancedTaskRun[];
  conformerWorkflow?: AdvancedConformerWorkflow;
  mixedSampling?: { initialGuesses: AdvancedMixedInitialGuess[]; selectedInitialGuessId: string;
    lastDeduplicationKey?:string;
    batches?:AdvancedSamplingBatch[];currentBatchId?:string;batchSerial?:number;
    electronicConfirmation?: string;
    draft: AdvancedMixedSamplingDefinition };
  usage: { elapsedMs: number; nativeJobs: number; retainedFrames: number; retainedCoordinates: number;
    processStages: number; biasHistoryEntries: number };
}
export interface AdvancedControllerState {
  tasks: AdvancedTaskRecord[];
  activeNative: { taskId: string; runId: string; sessionId: string; stageId: string; candidateId: string } | null;
  queue: { taskId: string; runId: string }[];
  ignoredEvents: number; disposed: boolean;
}
export interface AdvancedElectronicContext {
  sessionId: string; request: XtbRequest; taskId: string; runId: string; activate: false;
  /** Retry can deliver an earlier run's retained source without rebinding its native identity. */
  deliveryRunId?: string;
}
export interface AdvancedControllerDependencies {
  /** Terminal assets are complete and production leases released. Preparation
   * must settle before a dependent stage can acquire a new science lease. */
  onConformerResultsReady?(task:AdvancedTaskRecord):Promise<void>;
  conformerBatchBridge?: import('./batch-contracts').ConformerBatchBridge|null;
  /** Reads this task's editable initial document, never the currently selected result page. */
  resolveInitialSource?(taskId:string,currentSource:AdvancedFrameSource):AdvancedFrameSource|undefined;
  workerResourceBridge?: {
    acquireWorkerResources(request:{id:string;stamp:import('../../core/modeling/contracts').DocumentStamp}):Promise<ComputeResourceEvidence>;
    cancelWorkerResources(id:string):Promise<void>;
    releaseWorkerResources(id:string):Promise<void>;
  };
  /** Bounded A/B switch; scientific settings and cache identity are unchanged. */
  optimizationScheduling?: 'serial' | 'parallel';
  bridge: XtbBridge | null; chemistry?: ChemistryPort | null;
  pathBridge?: AdvancedPathBridge | null; samplingBridge?: ConformerSamplingBridge | null;
  aissBridge?: AissBridge | null;
  forcefieldAdapter?: AdvancedForcefieldAdapter;
  /** Getter of the current cached global snapshot at NEW subjob submission.
   * Never mutates a running request or a task's retained scientific settings. */
  resolveResources?(): ComputeResourceSnapshot;
  /** New task capture only. Existing task start/resume/retry and background
   * results do not depend on an open/current original document. */
  currentSourceGuard?(source: AdvancedFrameSource): void;
  onElectronicResult?(bundle: XtbElectronicArtifactBundle, context: AdvancedElectronicContext): void | Promise<void>;
  onFrameResult?(frame: AdvancedResultFrame, context: { taskId: string; runId: string; activate: false }): void | Promise<void>;
  now?(): number; createId?(kind: 'task' | 'run' | 'session'): string;
}
/** A future resource-aware ChemistryPort adapter must use this explicit contract;
 * a plain ChemistryPort cannot attest per-job threads, wall budget or native close. */
export interface AdvancedForcefieldAdapter {
  optimize(input: { source: AdvancedFrameSource; method: Extract<AdvancedOptimizationMethod, { backend: 'forcefield' }>;
    taskId: string; runId: string; maxWallTimeSeconds?: number; memoryBudgetBytes?: number;
    optimizationPool?: { stageId: string; candidateId: string } }): {
    promise: Promise<{ structure: Structure; energyHartree: number; converged: boolean; engine: string; version: string; forcefield: string;
      energyKind: 'forcefield-potential'; resourceGrant?: ComputeResourceEvidence;
      effectiveResources: { threads: number; maxWallTimeSeconds?: number; memoryBudgetBytes?: number } }>;
    stop(): Promise<void>;
  };
}
