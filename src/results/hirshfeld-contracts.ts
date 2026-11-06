import type { Vector3 } from '../core/types';
import type { SurfaceContext, SurfaceStamp, SurfaceScalarField, SurfaceProvenance } from './surface-contracts';
import type { OrbitalResourceInfo } from './orbital-contracts';

export interface HirshfeldClusterAtom {
  sourceIndex: number; stableId: string; element: string; position: Vector3;
  coordinatePrecisionAngstrom?: number;
  imageRef?: { sourceAtomId: string; translation: [number, number, number] };
}
/** A prepared scientific snapshot. Hidden atoms remain in this complete set. */
export interface HirshfeldCluster {
  kind: 'finite-cluster'; sourceId: string; sourceRevision: string;
  coordinateUnit: 'angstrom'; completeFiniteCluster: true; atoms: readonly HirshfeldClusterAtom[];
}
export interface HirshfeldSelection {
  targetAtomIndices: readonly number[]; environmentAtomIndices: readonly number[];
}
export interface HirshfeldSelectedCluster extends HirshfeldCluster, HirshfeldSelection {}
export interface HirshfeldOpenRequest {
  sessionId: string; source: { kind: 'hirshfeld-cluster'; context: SurfaceContext; cluster: HirshfeldCluster };
  /** Instance-only overrides. Omitted inherits the current Multiwfn configuration. */
  resources?: { threads: number; memoryBudgetBytes: number };
}
export interface HirshfeldSessionInfo {
  sessionId: string; family: 'hirshfeld'; context: SurfaceContext; atomCount: number;
  capabilities: readonly { function: 'hirshfeld'; finiteCluster: true; cifNeighbourhood: false; mapping: 'dnorm'; nativeArea: true }[];
  /** memoryBudgetBytes is lease-available; configuredMemoryBudgetBytes is its pre-reservation ceiling. */
  resources: OrbitalResourceInfo & { configuredMemoryBudgetBytes: number; sharedReservedBytes: number };
  /** Snapshot of the last granted event, never a live remaining-memory meter. */
  resourceSnapshot: 'open-grant' | 'analysis-grant';
  planning?: { extensionBohr: number; estimated: true };
}
export type HirshfeldMode = 'closed' | 'open-preview';
export interface HirshfeldAnalyzeRequest extends HirshfeldSelection {
  /** Explicit open preview never publishes a complete surface denominator. */
  mode?: HirshfeldMode;
  stamp: SurfaceStamp; quantitativeGrid: { mode: 'spacing'; spacingBohr: number }; mapping: 'dnorm';
}
export interface HirshfeldScalarField extends SurfaceScalarField {
  function: 'hirshfeld-weight' | 'dnorm'; valueUnit: 'dimensionless';
}
/** Distinct from electron-density surface pairs and from IGMH fields. */
export interface HirshfeldFieldPair {
  kind: 'hirshfeld'; definition: 'hirshfeld-weight'; isovalue: 0.5; inside: 'above';
  shape: HirshfeldScalarField; mapping: HirshfeldScalarField;
  topology?: 'closed' | 'open'; boundaryFaces?: readonly string[];
}
export interface HirshfeldVertexSample {
  /** Zero-based sample index; nativeSerial is a separate non-contiguous ID. */
  index: number; nativeSerial: number; position: Vector3; coordinatePrecisionAngstrom: Vector3;
  dnorm: number; dnormRaw: string; dnormUnit: 'dimensionless'; di: number; de: number; distanceUnit: 'angstrom';
  distancePrecisionAngstrom: [number, number];
  /** All nearest nuclei compatible with original coordinate printing precision. */
  insideAtomIndices: readonly number[]; outsideAtomIndices: readonly number[];
  insideAtomIds: readonly string[]; outsideAtomIds: readonly string[];
}
export interface HirshfeldContactRow {
  insideElement: string; outsideElement: string; area: number; nativePercent: number;
  areaRaw: string; percentRaw: string; areaPrecision: number; percentPrecision: number;
}
export interface HirshfeldContacts {
  method: 'native-area'; areaUnit: 'angstrom^2';
  directedRows: readonly HirshfeldContactRow[]; mergedRows: readonly HirshfeldContactRow[];
  denominator: { area: number; rawValue: string; scope: 'whole-hirshfeld-surface' }; mergedRule: string;
}
export interface HirshfeldNativeSummary {
  vertexCount: number; edgeCount: number; triangleCount: number; totalArea: number; totalAreaRaw: string; totalAreaPrecision: number;
}
export interface HirshfeldAnalysisResult {
  /** Trusted host snapshot; restores report the last grant without acquiring a new one. */
  sessionInfo: HirshfeldSessionInfo;
  schema: 'sciyue-hirshfeld-native/v1'; kind: 'hirshfeld'; stamp: SurfaceStamp; source: HirshfeldSelectedCluster;
  definition: { function: 'hirshfeld-weight'; isovalue: 0.5; mapping: 'dnorm'; mappingUnit: 'dimensionless'; atomicDensity: string; vdwRadii: string };
  mode?: HirshfeldMode;
  quantitativeGrid: HirshfeldAnalyzeRequest['quantitativeGrid']; quantitativeSummary: HirshfeldNativeSummary | null;
  vertices: readonly HirshfeldVertexSample[]; contacts: HirshfeldContacts | null;
  fingerprint: { samplesAvailable?: boolean; sampleDiagnostic?: string | null; scope?: 'whole-surface' | 'current-range'; method: 'native-surface-vertex-samples'; areaWeighted: false; coordinateUnit: 'angstrom'; correspondence: string };
  surface: { available: true; representation: 'native-weight-grid'; sampleRelationship: string };
  pair: HirshfeldFieldPair; provenance: SurfaceProvenance; estimatedRetainedBytes: number;
  plan: { estimatedDimensions: readonly number[]; estimatedPoints: number; estimatedBytes: number };
}
export interface HirshfeldRestoreRequest { stamp: SurfaceStamp; generationId: string }
export interface HirshfeldCubeExportRequest { stamp: SurfaceStamp; fieldId: string }
