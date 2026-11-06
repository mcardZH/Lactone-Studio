/** Numerical analyses belong to an immutable orbital source session, never a viewport frame. */
export type AtomicChargeMethod = 'mulliken' | 'lowdin' | 'adch' | 'hirshfeld' | 'hirshfeld-i' | 'cm5' | 'resp' | 'scpa' | 'bader';
export type BondOrderMethod = 'mayer' | 'wiberg-lowdin' | 'mulliken' | 'laplacian' | 'fuzzy';
export type OrbitalCompositionMethod = 'mulliken' | 'scpa';
export type WavefunctionAnalysisRequest =
  | { kind: 'charges'; method: Exclude<AtomicChargeMethod, 'bader'> }
  | { kind: 'charges'; method: 'bader'; bader?: { spacingBohr?: number; paddingBohr?: number; integration?: 'mixed-exact' } }
  | { kind: 'bond-orders'; method: BondOrderMethod }
  | { kind: 'composition'; method: OrbitalCompositionMethod; orbitalKey: string };
export interface AnalysisAtomValue { atomId: string; sourceIndex: number; element: string; value: number; spinPopulation?: number; electronPopulation?: number; referenceCharge?: number }
export interface BaderGridPlan { originBohr: number[]; spacingBohr: number[]; dimensions: number[]; pointCount: number; paddedPointCount: number; estimatedMemoryBytes: number; integration: 'mixed-exact'; paddingBohr: number; threads: number; threadStackBytes: number }
export interface BaderBasin { basinId: number; electronPopulation: number; volumeBohr3: number; vdWVolumeBohr3: number; attractorPositionBohr: number[]; role: 'atomic' | 'non-nuclear'; sourceIndex?: number; atomId?: string; referenceCharge: number; netCharge: number; mappingEvidence: 'native-atom-and-voxel' | 'native-nna-and-nonnuclear-position' }
export interface BaderRemainder { gridCount: number; electronPopulation: number; evidence: 'native-integral' | 'explicit-zero-grid-count' }
export interface BaderIntegralData {
  electronRepresentation: 'all-electron'; referenceConvention: 'nuclear-charge'; basins: BaderBasin[];
  unassigned: BaderRemainder; boundary: BaderRemainder; expectedElectronCount: number; integratedElectronCount: number;
  electronResidual: number; chargeIncludingNonAtomicBasins: number; normalizationFactor: number;
  nativeNormalizedCharges: {sourceIndex: number; value: number}[]; grid: BaderGridPlan; integrationMethod: 'mixed-exact'; scientificAcceptance: 'pending-native-calibration';
}
export interface AnalysisBondValue { atomId1: string; atomId2: string; sourceIndex1: number; sourceIndex2: number; value: number }
export interface AnalysisProvenance { sessionId: string; sourceRevision: string; structure?: import('../core/types').Structure; geometryIdentity?: string; coordinateUnit?: 'bohr'; resources?: import('./orbital-contracts').OrbitalResourceInfo; parameters?: Record<string, string | number | number[] | boolean>; backend: { name: string; version: string; threads: number }; warnings: string[] }
export type WavefunctionAnalysisResult = AnalysisProvenance & (
  | { kind: 'charges'; method: Exclude<AtomicChargeMethod, 'bader'>; unit: 'e'; quantity?: 'net-charge' | 'electron-population'; atoms: AnalysisAtomValue[]; sum: number; spinAvailable: boolean; chargeConvention?: string }
  | { kind: 'charges'; method: 'bader'; unit: 'e'; quantity: 'net-charge'; atoms: (AnalysisAtomValue & {electronPopulation: number; referenceCharge: number; basinIds: number[]})[]; sum: number; spinAvailable: false; chargeConvention: string; bader: BaderIntegralData }
  | { kind: 'bond-orders'; method: BondOrderMethod; unit: 'dimensionless'; bonds: AnalysisBondValue[] }
  | { kind: 'composition'; method: OrbitalCompositionMethod; orbitalKey: string; unit: 'percent'; atoms: AnalysisAtomValue[]; angular: { s: number; p: number; d: number; f: number; other: number }; sum: number }
);
