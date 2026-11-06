import type { Vector3 } from '../core/types';

export const DEFAULT_SURFACE_ISOVALUE = 0.001;
export const SURFACE_DENSITY_VALUE_UNIT = 'e/bohr^3';
export const SURFACE_SCHEMA_VERSION = 1;
export type SurfaceFunction = 'esp' | 'alie';
export type ScalarFieldFunction = 'electron-density' | SurfaceFunction | 'iri' | 'rdg' | 'delta-g' | 'delta-g-inter' | 'delta-g-intra' | 'sign-lambda2-rho' | 'hirshfeld-weight' | 'dnorm' | 'external' | 'unknown';
export type SurfaceLengthUnit = 'bohr' | 'angstrom';
/** Source frame identity, independent of the active card, viewport or model selection. */
export interface SurfaceContext {
  sourceId: string; sourceRevision: string; jobIndex: number | null; sourceFrameIndex: number | null; generation: number;
  documentId?: string; documentRevision?: number; activationEpoch?: number;
}
export interface SurfaceStamp extends SurfaceContext { requestId: string; analysisId: string }
export interface SurfaceGrid {
  coordinateUnit: SurfaceLengthUnit; origin: Vector3; axes: [Vector3, Vector3, Vector3];
  dimensions: [number, number, number]; ordering: 'z-fastest';
}
export interface CubeAtom {
  /** One-based source ordinal, not a model atom id or a nuclear charge. */
  sourceIndex: number; atomicNumber: number; nuclearCharge: number; position: Vector3;
}
export interface SurfaceFieldSource {
  id: string; name: string; revision: string; kind: 'external-cube' | 'generated-cube';
  producer: 'gaussian' | 'orca' | 'multiwfn' | 'unknown';
  datasetId?: number; comments?: readonly [string, string];
  /** Explicit metadata only; neither geometry nor nuclear charges establish it. */
  electronicState?: { charge?: number; multiplicity?: number; method?: string; basis?: string; stateLabel?: string };
}
export interface SurfaceDefinitionEvidence {
  kind: 'native-output' | 'user-provided' | 'unknown'; description: string;
  sourceLine?: number;
}
export type SurfaceValidDomain =
  | { kind: 'full-grid'; evidence: string }
  | { kind: 'node-mask'; mask: Uint8Array; evidence: string;
      restrictedTo?: { shapeFieldId: string; shapeSourceRevision?: string; isovalue: number } }
  | { kind: 'unknown'; reason: string };
export interface SurfaceFieldPrecision {
  /** Absolute half-last-digit intervals of the original source numbers. */
  origin: Vector3; axes: [Vector3, Vector3, Vector3]; atomCoordinates: readonly Vector3[];
  nuclearCharges?: readonly number[];
}
/** A physical scalar field. Never repurpose OrbitalField's orbital-amplitude unit. */
export interface SurfaceScalarField {
  id: string; context: SurfaceContext; source: SurfaceFieldSource;
  function: ScalarFieldFunction; functionLabel: string; valueUnit: string | null;
  definitionEvidence: SurfaceDefinitionEvidence;
  grid: SurfaceGrid; atoms: readonly CubeAtom[]; values: Float64Array;
  precision: SurfaceFieldPrecision; validDomain: SurfaceValidDomain;
}
/** isovalue is always atomic electron density; a different density value unit
 * may be retained in a slot but cannot enter this pair without a new contract. */
export interface SurfaceFieldPair { shape: SurfaceScalarField; mapping: SurfaceScalarField | null; isovalue: number }
/** Quantitative main-12 precision is independent of the display Cube quality. */
export interface SurfaceQuantitativeGrid {
  mode: 'native-default' | 'spacing'; spacingBohr?: number; actualSpacingBohr?: number;
}
export type SurfaceCubeQuality =
  | { mode: 'low' | 'medium' | 'high' }
  | { mode: 'spacing'; spacingBohr: number }
  | { mode: 'dimensions'; dimensions: [number, number, number] }
  | { mode: 'target-points'; targetPoints: 32768 | 4096000 };
export interface SurfaceRegionSelection {
  id: string; kind: 'molecule' | 'atoms' | 'fragment'; label: string;
  /** Explicit one-based source atom indices; empty only for whole molecule. */
  atomIndices: readonly number[];
}
export type SurfaceMetricDimension = 'area' | 'volume' | 'mapping-value' | 'mapping-variance' | 'dimensionless';
export interface SurfaceMetric {
  key: string; label: string; value: number | null; unit: string | null; dimension: SurfaceMetricDimension;
  sourceLine?: number;
  rawValue?: string;
}
export interface SurfaceExtremum {
  id: string; sourceIndex: number; type: 'minimum' | 'maximum';
  /** Local/global status is independent of the sign of the mapped value. */
  scope: 'local' | 'global'; regionId: string; function: SurfaceFunction | 'external';
  position: Vector3; coordinateUnit: SurfaceLengthUnit; value: number; valueUnit: string;
  sourceLine?: number;
}
export interface SurfaceRegionResult {
  selection: SurfaceRegionSelection; nativeDefinition: string;
  area: number | null; areaUnit: string | null; metrics: readonly SurfaceMetric[];
  extrema: readonly SurfaceExtremum[];
  /** Prepared from the same native surface during the explicit analysis/region
   * task. Optional only for reading previously persisted results. */
  distribution?: SurfaceAreaDistribution;
}
export interface SurfaceProvenance {
  backend: { name: string; version: string }; sourceIds: readonly string[];
  parameters: Readonly<Record<string, string | number | boolean | readonly number[]>>;
  rawArtifacts: readonly { role: string; name: string; revision?: string }[];
  notices: readonly string[];
}
export interface SurfaceAnalysisResult {
  stamp: SurfaceStamp; route: 'wavefunction-direct' | 'cube-interpolation'; function: SurfaceFunction | 'external';
  isovalue: number; quantitativeGrid: SurfaceQuantitativeGrid;
  regions: readonly SurfaceRegionResult[]; extrema: readonly SurfaceExtremum[]; provenance: SurfaceProvenance;
}
export interface SurfaceDistributionRequest {
  stamp: SurfaceStamp; regionId: string; lower: number; upper: number; binCount: number; binWidth?: number; valueUnit: string;
}
export interface SurfaceDistributionBin {
  lower: number; upper: number; lowerInclusive: boolean; upperInclusive: boolean;
  area: number; fraction: number | null;
  nativePercent?: number;
}
export interface SurfaceAreaDistribution {
  stamp: SurfaceStamp; regionId: string; valueUnit: string; areaUnit: string;
  bins: readonly SurfaceDistributionBin[];
  denominator: { area: number; definition: string; scope: 'molecule' | 'selected-region' | 'native-other' }; coveredArea: number;
  /** Native area statistics, never a vertex-count histogram. */
  method: 'native-area'; sourceLine?: number;
}
export type SurfaceOperation = 'analyze' | 'region' | 'distribution' | 'generate-fields';
export interface SurfaceRunState {
  stamp: SurfaceStamp; operation: SurfaceOperation;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  completed?: number; total?: number; message?: string;
}
export interface SurfaceGeneratedFields {
  stamp: SurfaceStamp; quality: SurfaceCubeQuality; pair: SurfaceFieldPair; provenance: SurfaceProvenance;
}
export interface SurfaceCapability {
  function: SurfaceFunction; wavefunctionDirect: boolean; cubeInterpolation: boolean;
  atomRegions: boolean; fragmentRegions: boolean; extrema: boolean; distribution: boolean; generation: boolean;
  valueUnit: string; reason?: string;
}
/** Host-owned immutable snapshot, never a renderer-supplied filesystem path. */
export interface SurfaceImportedCube { token: string; name: string; text: string; bytes: number; sourceRevision: string; knownDomain?: { sourceRevision: string; validDomain: SurfaceValidDomain } }
export interface SurfaceCubeSourceRef { token: string; fieldMetadata: Omit<SurfaceScalarField, 'values'> }
export type SurfaceSourceRequest =
  | { kind: 'wavefunction'; text?: string; sourceToken?: string; name: string; sourceId: string; sourceRevision?: string; context: SurfaceContext }
  | { kind: 'cubes'; shape: SurfaceCubeSourceRef; mapping: SurfaceCubeSourceRef | null; context: SurfaceContext };
export interface SurfaceOpenRequest { sessionId: string; source: SurfaceSourceRequest }
export interface SurfaceSessionInfo { sessionId: string; context: SurfaceContext; capabilities: readonly SurfaceCapability[] }
export interface SurfaceAnalyzeRequest {
  stamp: SurfaceStamp; function: SurfaceFunction; isovalue: number;
  quantitativeGrid: SurfaceQuantitativeGrid; regions: readonly SurfaceRegionSelection[];
}
export interface SurfaceGenerateRequest { stamp: SurfaceStamp; function: SurfaceFunction; isovalue: number; quality: SurfaceCubeQuality }
/** Read completed session artifacts only; generationId is the original generation requestId. */
export interface SurfaceRestoreFieldsRequest { stamp: SurfaceStamp; generationId: string }
export interface SurfaceRegionRequest { stamp: SurfaceStamp; selection: SurfaceRegionSelection }
export interface SurfaceRegionResponse { stamp: SurfaceStamp; region: SurfaceRegionResult }
export interface SurfaceCubeRegisterRequest { name: string; text: string }
export interface SurfaceCubeExportRequest { fieldId: string; stamp: SurfaceStamp }
