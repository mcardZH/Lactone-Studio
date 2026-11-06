import type { Structure } from '../../core/types';
import type { DocumentStamp, ModelCoordinate } from '../contracts';
import type { XtbBondOrders } from '../../core/modeling/contracts';
import type { EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import type { ComputeResourceEvidence } from '../resource-preferences';
export type { BondOrderEntry, XtbBondOrders, BondOrderObservation } from '../../core/modeling/contracts';

export type XtbMethod = 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff';
export type XtbOptimizationScope = 'all' | 'selection' | 'unselected';
export interface XtbSolvation { model: 'alpb' | 'gbsa'; solvent: string }
export interface XtbSolvationEvidence extends XtbSolvation {
  kernel: 'p16' | 'still'; referenceState: 'gsolv'; temperatureKelvin: 298.15;
  parameterSet: string; sourceField: 'stdout:solvation-model';
}
/** GFN2 has no fabricated fallback when physical CPU identification failed. */
export function resolveGfn2Threads(manual: number | undefined, physicalCoreCount?: number | null): number {
  return manual !== undefined ? manual : Number.isSafeInteger(physicalCoreCount) && physicalCoreCount! > 0 ? physicalCoreCount! : Number.NaN;
}
export const XTB_METHOD_LABELS: Record<XtbMethod, string> = { gfn0: 'GFN0-xTB', gfn1: 'GFN1-xTB', gfn2: 'GFN2-xTB', gfnff: 'GFN-FF' };
export interface XtbRequest {
  optimizationPool?: { stageId: string; candidateId: string };
  stamp: DocumentStamp;
  structure: Structure;
  method: XtbMethod;
  calculation?: 'optimize' | 'singlepoint';
  /** Host-validated task identity; does not grant a renderer a native owner. */
  runIdentity?: { taskId: string; runId: string };
  /** Isolated GFN2 singlepoint only. Preserve actual Molden and native outputs. */
  electronicProperties?: boolean;
  solvation?: XtbSolvation;
  memoryBudgetBytes?: number;
  charge: number;
  uhf?: number;
  /** Complete request-only fixed set: permanent freezes plus the complement
   * of the captured optimization range. It is never written into the model. */
  frozenAtomIds: string[];
  constraints: ModelCoordinate[];
  internalConstraintsConfirmed: boolean;
  threads?: number;
  maxSteps?: number;
  maxSccIterations?: number;
  maxWallTimeSeconds?: number;
  empiricalBondParameters?: EmpiricalBondPerceptionParameters;
}
export interface XtbCoordinate { id: string; element: string; x: number; y: number; z: number }
export interface XtbPeriodicOptimizationEvidence {
  sourceCell: NonNullable<Structure['cell']>; sourcePbc: [boolean,boolean,boolean]; effectivePbc: [true,true,true];
  fixedCell: true; optimizer: 'scipy-lbfgsb'; optimizerVersion: string; backend: 'native'|'tblite';
  gradientUnit: 'hartree/bohr';
  forceFieldTopologySha256?: string;
}
export interface XtbPeriodicSinglepointEvidence {
  sourceCell: NonNullable<Structure['cell']>; sourcePbc: [boolean,boolean,boolean]; effectivePbc: [true,true,true]; fixedCell: true;
  backend: 'tblite-api'; bondOrderScope: 'atom-pair-periodic-aggregate'; imageResolved: false;
  version: string; libraryVersion: string;
  parameters: {method:'GFN2-xTB';accuracy:1;maxIterations:number;electronicTemperatureHartree:.00095};
}
export type XtbPeriodicEvidence = XtbPeriodicOptimizationEvidence | XtbPeriodicSinglepointEvidence;
/** A sampled real native log frame; step is an ordinal, not physical time or a solver cycle. */
export interface XtbPreviewFrame {
  sessionId: string; stamp: DocumentStamp; seq: number; step: number;
  stepKind: 'native-log-frame'|'outer-optimizer-iteration'; coordinates: XtbCoordinate[]; periodic?: XtbPeriodicEvidence;
}
export interface XtbConstraintResult extends ModelCoordinate {
  target: number; actual: number; residual: number;
  unit: 'angstrom' | 'degree'; mode: 'native-harmonic';
}
/** Trusted host admission evidence, never a renderer-supplied authority. */
export type XtbResourceGrant = ComputeResourceEvidence;
export type XtbEffectiveResources = XtbResourceGrant;
export interface XtbMetadata {
  converged: true; iterations?: number; sccIterations?: number; sccIterationLimit?: number; energyHartree: number;
  energyUnit: 'hartree'; coordinateUnit: 'angstrom';
  engine: 'xtb' | 'tblite'; version: string; method: XtbMethod;
  charge: number; uhf: number | null; spinTreatment: string;
  /** Omitted for advanced runs with no wall-clock deadline. */
  threads: number; maxSteps: number; maxWallTimeSeconds?: number;
  resourceGrant?: XtbResourceGrant;
  frozenAtomIds: string[]; internalConstraintMode: 'native-harmonic' | 'none';
  internalConstraints: XtbConstraintResult[];
  calculation?: 'optimize' | 'singlepoint';
  periodic?: XtbPeriodicEvidence;
  solvation?: XtbSolvationEvidence;
  bondOrders?: XtbBondOrders;
  bondOrdersWarning?: { code: string; message: string };
  trajectory?: { sourceField: 'xtbopt.log'; frameCount: number; lastFrameStep: number };
  trajectoryWarning?: { code: string; message: string };
}
export interface XtbEvent {
  schema: 1; sessionId: string; stamp: DocumentStamp; operation: 'xtb-optimize' | 'xtb-singlepoint';
  seq: number; method: XtbMethod;
  event: 'started' | 'progress' | 'frame' | 'completed' | 'stopped' | 'error';
  runIdentity?: { taskId: string; runId: string };
  /** A stopped event may retain raw sources; this alone is not scientific success. */
  electronicArtifacts?: XtbElectronicArtifactReceipt;
  step?: number; logTail?: string; status?: string;
  stepKind?: 'native-log-frame'|'outer-optimizer-iteration'; periodic?: XtbPeriodicEvidence;
  coordinates?: XtbCoordinate[]; metadata?: XtbMetadata;
  effectiveResources?: XtbResourceGrant;
  exit?: { code: number | null; signal: string | null };
  error?: { code: string; message: string };
  reason?: string; diagnosticDirectory?: string;
}
export type XtbElectronicArtifactRole = 'molden' | 'stdout' | 'stderr' | 'wbo';
export interface XtbElectronicArtifactFile {
  role: XtbElectronicArtifactRole; name: string; bytes: number; sha256: string;
}
export interface XtbElectronicArtifactReceipt {
  artifactId: string; files: XtbElectronicArtifactFile[];
}
export interface XtbElectronicArtifactBundle {
  artifactId: string; sessionId: string; stamp: DocumentStamp;
  runIdentity?: { taskId: string; runId: string };
  metadata: XtbMetadata & { orderedAtoms: XtbCoordinate[] };
  files: (XtbElectronicArtifactFile & { text: string })[];
}
export interface XtbCoordinateResult {
  request: XtbRequest; coordinates: XtbCoordinate[]; metadata: XtbMetadata;
}
/** A real sampled frame retained after native termination, not a converged result. */
export interface XtbStoppedCoordinateResult { request:XtbRequest; frame:XtbPreviewFrame }
export interface XtbBridge {
  releaseXtbOptimizationCaches?(sessionIds: string[]): Promise<{ released: string[] }>;
  startXtb(request: XtbRequest, sessionId: string): Promise<unknown>;
  commandXtb(sessionId: string, command: { command: 'stop' }): Promise<unknown>;
  onXtbEvent(listener: (event: XtbEvent) => void): () => void;
  readXtbElectronicArtifacts?(artifactId: string): Promise<XtbElectronicArtifactBundle>;
  releaseXtbElectronicArtifacts?(artifactId: string): Promise<{ released: boolean }>;
}
