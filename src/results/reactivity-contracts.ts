import type { SurfaceContext, SurfaceStamp } from './surface-contracts';
import type { OrbitalResourceInfo } from './orbital-contracts';

/** All descriptors here are single-wavefunction frozen-orbital estimates. */
export type ReactivityMetricKey = 'homo' | 'lumo' | 'gap' | 'ip' | 'ea' | 'chi' | 'mu' | 'eta' | 'softness' | 'omega' | 'NNu';
export interface ReactivityMetric { value: number | null; unit: 'eV' | 'eV^-1'; reason?: string }
export type ReactivityGlobalMetrics = Record<ReactivityMetricKey, ReactivityMetric>;
export interface ReactivitySource {
  kind: 'wavefunction'; text?: string; sourceToken?: string; name: string; sourceId: string; sourceRevision: string; context: SurfaceContext;
  /** A noncanonical declaration can disable interpretation. A caller's canonical
   * string alone never proves canonical identity or enables descriptors. */
  orbitalRepresentation?: 'canonical' | 'natural' | 'localized' | 'nto' | 'unknown';
  orbitalRepresentationEvidence?: string;
}
export interface ReactivityOpenRequest { sessionId: string; source: ReactivitySource }
export interface ReactivityFrontierOrbital {
  key: string; spin: 'restricted' | 'alpha' | 'beta'; ordinal: number; sourceIndex: number;
  /** Native global index can differ from a FCHK beta channel's source index. */
  nativeIndex: number;
  energyHartree: number; energyEV: number; occupation: number;
}
export interface ReactivityFrontierChannel {
  spin: ReactivityFrontierOrbital['spin']; homo: ReactivityFrontierOrbital | null; lumo: ReactivityFrontierOrbital | null;
  homoDegeneracy: number; lumoDegeneracy: number;
}
export interface ReactivityCapabilities {
  orbitalDisplay: boolean; global: boolean; condensed: boolean; reasons: readonly string[];
}
export interface ReactivitySessionInfo {
  sessionId: string; context: SurfaceContext; atomCount: number; frontier: readonly ReactivityFrontierChannel[];
  capabilities: ReactivityCapabilities; notices: readonly string[]; resources?: OrbitalResourceInfo;
}
export interface ReactivityAnalyzeRequest { stamp: SurfaceStamp }
/** Normalized response per unit electron-number change; f columns are dimensionless. */
export interface ReactivityAtom {
  /** Attached only by a bridge with verified source-to-model stable-ID mapping. */
  atomId?: string; sourceIndex: number; element: string;
  fPlus: number; fMinus: number; fZero: number; dual: number;
  omega: number | null; NNu: number | null;
  sPlus: number | null; sMinus: number | null; sZero: number | null;
}
export interface ReactivityOrbitalIntegral {
  orbitalKey: string; sourceIndex: number; rawSum: number; normalizedPrintedSum: number;
  rawSumUnit: 'fraction'; nativeNormalization: true; printedFractionPrecision: number;
}
export interface ReactivityAnalysisResult {
  stamp: SurfaceStamp; approximation: 'frozen-orbital'; partition: 'hirshfeld';
  globalMetrics: ReactivityGlobalMetrics; frontier: readonly ReactivityFrontierChannel[];
  atoms: readonly ReactivityAtom[]; capabilities: ReactivityCapabilities; notices: readonly string[];
  integrals: readonly ReactivityOrbitalIntegral[];
  provenance: {
    /** Actual wavefunction ID; stamp.sourceId may be the paired OUT logical source. */
    sourceId: string; sourceRevision: string; sourceName: string;
    backend: { name: 'Multiwfn'; version: string; threads: number } | null;
    parameters: {
      hardnessConvention: 'eta=IP-EA;S=1/eta;omega=mu^2/(2eta)';
      tceHomoHartree: number; tceReferenceLevel: 'B3LYP/6-31G*'; tceLevelMatch: 'matched' | 'unmatched' | 'unknown';
      degeneracyScreenEV: number; orbitalRepresentation: string; orbitalRepresentationEvidence: string;
      nativeMenu?: string; rawIntegralTolerance?: number; quadraturePointsPerAtom?: number;
    };
    resources?: OrbitalResourceInfo;
    rawArtifacts: readonly { role: 'native-output'; name: string; revision: string; bytes: number }[];
    settlement: 'not-started' | 'native-settled';
  };
}
