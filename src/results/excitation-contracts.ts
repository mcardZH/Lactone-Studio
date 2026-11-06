import type { OrbitalResourceInfo } from './orbital-contracts';
import type { CubeAtom, SurfaceContext, SurfaceCubeQuality, SurfaceFieldPrecision, SurfaceGrid, SurfaceScalarField, SurfaceStamp } from './surface-contracts';

export interface ExcitationStateRef {
  /** Original one-based printed state and line, never a table row offset. */
  index: number; sourceLine: number; frameIndex: number; energyEv: number; label: string;
  /** Printed spin multiplicity, independent of repeated ORCA root numbers. */
  multiplicity?: number;
}
export interface ExcitationOutputSource { name: string; text?: string; sourceToken?: string; sourceId: string; revision?: string; /** Host-issued OUT file token for exact same-basename companions. */ companionSourceToken?: string }
export interface ExcitationOpenRequest {
  sessionId: string;
  source: { kind: 'wavefunction'; name: string; text?: string; sourceToken?: string; sourceId: string; sourceRevision: string; context: SurfaceContext };
  output: ExcitationOutputSource;
}
export interface ExcitationSessionInfo {
  sessionId: string; context: SurfaceContext; states: readonly ExcitationStateRef[];
  capabilities: { nto: boolean; holeElectron: boolean; reasons: readonly string[] };
  notices: readonly string[]; resources?: OrbitalResourceInfo;
}
export interface ExcitationRunRequest {
  stamp: SurfaceStamp; operation: 'nto' | 'nto-field' | 'hole-electron'; state: ExcitationStateRef;
  quality?: SurfaceCubeQuality;
  /** An explicit optional extra calculation on exactly the current density grid. */
  includeCoulomb?: boolean;
  /** Required for nto-field; ordinal is the result pair ordinal, not a MO index. */
  pairIndex?: number; spin?: 'restricted' | 'alpha' | 'beta'; side?: 'hole' | 'electron';
  generationId?: string;
}
export interface ExcitationCoefficientEvidence {
  sourceLine: number; blockRevision: string; coefficientCount: number;
  excitationSquared: number; deexcitationSquared: number; netSquared: number;
  expectedNormalization: number; normalizationDeviation: number;
  nativeExcitationSquared?: number; nativeDeexcitationSquared?: number;
  nativeNetSquared?: number; nativeNormalizationDeviation?: number;
  nativeCoefficientCount?: number;
}
export interface NtoMoContribution { sourceIndex: number; spin: 'restricted' | 'alpha' | 'beta'; amplitude: number; percent: number }
export interface NtoOrbital {
  key: string; side: 'hole' | 'electron'; nativeIndex: number; sourceIndex: number;
  /** Complete signed expansion, including zero coefficients; not AO populations. */
  moContributions: readonly NtoMoContribution[];
}
export interface NtoPair {
  index: number; spin: 'restricted' | 'alpha' | 'beta'; eigenvalue: number;
  /** Exactly 100*eigenvalue; no clipping or renormalization. */
  weightPercent: number; hole: NtoOrbital; electron: NtoOrbital;
}
export interface ExcitationProvenance {
  backend: { name: 'Multiwfn'; version: string; threads: number };
  wavefunctionRevision: string; outputRevision: string; orcaJsonRevision?: string;
  parameters: Record<string, string | number | boolean | readonly number[]>;
  rawArtifacts: readonly { role: string; name: string; revision: string; bytes: number }[];
  notices: readonly string[];
  orcaAmplitudes?: {
    route: 'out-tda' | 'json-rpa' | 'cis-rpa' | 'cis-verified-json-recovery';
    sourceStateIndex: number; multiplicity: number; sourceLine: number;
    /** Source MO ordinals are zero-based in ORCA; adapter conversion is explicit. */
    orbitalWindow?: readonly number[]; jsonRoot?: number;
    jsonRevision?: string; cisRevision?: string; adapterRevision?: string; nativeAdapterStateIndex?: number;
    rpaNorm: number; xSquared: number; ySquared: number;
    convention: 'orca-norm-1; closed-shell-amplitudes/sqrt(2); source-MO+1';
    printedWeightsChecked: number; maximumPrintedWeightDifference: number;
    jsonAction?: string;
    nativeCoefficientThreshold?: number; fullCoefficientCount?: number; effectiveCoefficientCount?: number;
    effectiveXSquared?: number; effectiveYSquared?: number;
  };
}
export interface NtoAnalysisResult {
  stamp: SurfaceStamp; operation: 'nto'; state: ExcitationStateRef;
  pairs: readonly NtoPair[]; eigenvalueSum: number; coefficients: ExcitationCoefficientEvidence;
  expansion: { available: boolean; relativeResidual: number | null; unitarityMaxError: number | null; rank: number | null; reason?: string };
  provenance: ExcitationProvenance;
}
/** Distinct from OrbitalField: this is an NTO amplitude with no MO-energy fields. */
export interface NtoField {
  id: string; context: SurfaceContext; state: ExcitationStateRef; pairIndex: number;
  spin: NtoPair['spin']; side: 'hole' | 'electron'; eigenvalue: number;
  valueUnit: 'bohr^-3/2'; grid: SurfaceGrid; atoms: readonly CubeAtom[];
  precision: SurfaceFieldPrecision; validDomain: { kind: 'full-grid'; evidence: string }; values: Float64Array;
}
export interface ExcitationDensityField extends SurfaceScalarField {
  function: 'electron-density'; valueUnit: 'bohr^-3';
  excitationRole: 'hole-density' | 'electron-density'; state: ExcitationStateRef;
}
export interface ExcitationDensityFieldPair { kind: 'excitation-density'; shape: ExcitationDensityField; mapping: null; isovalue: number }
export interface ExcitationMetric {
  key: string; label: string; value: number | null; unit: string | null;
  sourceLine: number; rawValue: string; reason?: string;
}
export interface HoleElectronResult {
  stamp: SurfaceStamp; operation: 'hole-electron'; state: ExcitationStateRef;
  coefficients: ExcitationCoefficientEvidence; metrics: readonly ExcitationMetric[];
  hole: ExcitationDensityField; electron: ExcitationDensityField;
  coulomb: { requested: boolean; valueHartree: number | null; valueEV: number | null; definition: 'hole-electron-coulomb-model'; sourceLine?: number };
  provenance: ExcitationProvenance;
}
export interface NtoFieldResult { stamp: SurfaceStamp; operation: 'nto-field'; state: ExcitationStateRef; field: NtoField; provenance: ExcitationProvenance }
export type ExcitationResult = NtoAnalysisResult | HoleElectronResult | NtoFieldResult;
export interface ExcitationRestoreRequest { stamp: SurfaceStamp; generationId: string }
export interface ExcitationExportRequest { stamp: SurfaceStamp; fieldId: string }
/** All native buffers are IEEE float64 little-endian in Cube z-fastest order. */
export type ExcitationFieldWire<T extends NtoField | ExcitationDensityField = NtoField | ExcitationDensityField> = Omit<T, 'values'> & { valuesBase64: string; valueEncoding: 'float64-le' };
