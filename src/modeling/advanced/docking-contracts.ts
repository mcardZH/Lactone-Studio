import type { Structure } from '../../core/types';
import type { DocumentStamp } from '../../core/modeling/contracts';

export type AissStamp = DocumentStamp & { activationEpoch?: number };
export interface AissRunIdentity { taskId: string; runId: string }
export interface AissSource { stamp: AissStamp; structure: Structure; charge: 0; uhf: 0 }
/** The first adapter has two complete neutral closed-shell isolated sources.
 * Native refinement is an intermediate stage, never an accepted W07 result. */
export interface AissRequest {
  schema: 1; operation: 'aiss-docking'; stamp: AissStamp; runIdentity: AissRunIdentity;
  sources: [AissSource, AissSource]; method: 'gfn2';
  threads?: number; maxWallTimeSeconds?: number; memoryBudgetBytes?: number;
  search?: { maxGenerations?: number; maxParents?: number; stackPoints?: number;
    angularStepDegrees?: 45 | 60 | 90 | 120 | 180; radialStepBohr?: number };
  refinement?: { candidateCount?: number; maxSteps?: number };
  calculator?: { accuracy?: 1; maxIterations?: number; electronicTemperatureK?: 300 };
}
export interface AissAtomMapping {
  combinedAtomId: string; sourceIndex: 0 | 1; sourceAtomId: string; sourceAtomIndex: number; element: string;
}
export interface AissCoordinate { id: string; element: string; x: number; y: number; z: number }
export interface AissScreenedPose {
  poseIndex: number; coordinates: AissCoordinate[];
  screening: { method: 'xTB-IFF'; value: number; unit: 'kcal/mol'; sourceField: 'structures_after_gen.xyz:comment' };
}
export interface AissRefinedCandidate {
  candidateIndex: number; coordinates: AissCoordinate[]; refinementEnergyHartree: number;
  /** The backend sorts the two collections independently and emits no bijection. */
  screenedPoseId: null; searchConverged: null; requiresUnbiasedOptimization: true;
}
export interface AissBackendEvidence {
  engine: 'xtb-aiss'; version: string; precomputeMethod: 'gfn2'; scoreMethod: 'xTB-IFF'; solvation: 'gas';
  internalRefinement: { method: 'gfn2'; candidateCount: number; maxSteps: number; optLevel: 'normal';
    convergencePerPose: 'not-reported' };
  calculator: { accuracy: 1; maxIterations: number; electronicTemperatureK: 300 };
  search: Required<NonNullable<AissRequest['search']>>;
  monomerEnergiesHartree: [number, number];
  sourceElectronicStates: [{ charge: 0; uhf: 0 }, { charge: 0; uhf: 0 }];
  combinedElectronicState: { charge: 0; uhf: 0; coupling: 'sum-of-unpaired-electrons' };
  counts: { radialProbePoints: number; stackGridPoints: number; angularGridPoints: number;
    geneticGenerations: number; refinedCandidates: number; evaluations: null };
}
interface AissEventBase {
  schema: 1; sessionId: string; stamp: AissStamp; runIdentity: AissRunIdentity;
  operation: 'aiss-docking'; method: 'gfn2'; seq: number;
}
export type AissPhase = 'monomer-precomputation' | 'screening' | 'stack-search' | 'angular-search' | 'genetic-search' | 'native-refinement';
export interface AissCompletionEvent extends AissEventBase {
  event: 'completed'; nativeClosed: true; resultKind: 'refined-pose-candidates';
  optimizationAcceptance: 'not-individually-verified'; requiresUnbiasedOptimization: true;
  sourceStamps: [AissStamp, AissStamp];
  sourceAtomMapping: AissAtomMapping[]; screenedPoses: AissScreenedPose[]; refinedCandidates: AissRefinedCandidate[];
  backend: AissBackendEvidence; evaluations: null;
  exit: { code: number | null; signal: string | null }; diagnosticDirectory: string;
  artifacts: { name: string; bytes: number; sha256: string }[];
}
/** A complete search checkpoint is not a successful native docking/refinement.
 * Only the naturally closed process may supply these unoptimized candidates. */
export interface AissSearchCheckpointEvent extends AissEventBase {
  event: 'search-checkpoint'; nativeClosed: true; resultKind: 'screened-pose-candidates';
  disposition: 'candidates-ready'; requiresUnbiasedOptimization: true;
  searchCheckpoint: { complete: true; completedGenerations: number; artifact: 'structures_after_gen.xyz' };
  nativeRefinement: { status: 'failed'; exit: { code: number; signal: null }; error: { code: 'AISS_NATIVE_REFINEMENT_FAILED'; message: string } };
  sourceStamps: [AissStamp, AissStamp]; sourceAtomMapping: AissAtomMapping[]; screenedPoses: AissScreenedPose[];
  backend: AissBackendEvidence; evaluations: null;
  exit: { code: number; signal: null }; diagnosticDirectory: string;
  artifacts: { name: string; bytes: number; sha256: string }[];
}
export type AissEvent = AissCompletionEvent
  | AissSearchCheckpointEvent
  | (AissEventBase & { event: 'started'; status: 'running' })
  | (AissEventBase & { event: 'progress'; phase: AissPhase; evaluations: null })
  | (AissEventBase & { event: 'stopped'; reason: string; nativeClosed: true;
      exit: { code: number | null; signal: string | null }; diagnosticDirectory?: string })
  | (AissEventBase & { event: 'error'; error: { code: string; message: string }; nativeClosed: true;
      exit: { code: number | null; signal: string | null }; diagnosticDirectory?: string });
export interface AissBridge {
  startAiss(request: AissRequest, sessionId: string): Promise<{ sessionId: string; status: 'starting' | 'stopped' | 'error' }>;
  commandAiss(sessionId: string, command: { command: 'stop' }): Promise<{ sessionId: string; status: 'stopped' }>;
  onAissEvent(listener: (event: AissEvent) => void): () => void;
}
