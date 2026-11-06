import type { Structure } from '../core/types';
import type { SurfaceContext, SurfaceStamp, SurfaceScalarField, SurfaceFieldPair, SurfaceProvenance } from './surface-contracts';

/** Native main-20 methods; mIGM is never a silent fallback for IGMH. */
export type InteractionMethod = 'iri' | 'rdg' | 'igmh' | 'migm' | 'igm';
export type InteractionComponent = 'iri' | 'rdg' | 'inter' | 'intra' | 'total';
export type InteractionGridQuality = { mode: 'low' | 'medium' | 'high' } | { mode: 'spacing'; spacingBohr: number }
  | { mode: 'dimensions'; dimensions: [number, number, number] }
  | { mode: 'target-points'; targetPoints: 32768 | 4096000 };
export interface InteractionFragment { id: string; label: string; atomIds: readonly string[] }
/** Native source ordinals are one based and independent of model stable IDs. */
export interface InteractionSourceFragment { id: string; label: string; atomIndices: readonly number[] }
export type InteractionSource =
  | { kind: 'wavefunction'; text?: string; sourceToken?: string; name: string; sourceId: string; sourceRevision: string; context: SurfaceContext }
  | { kind: 'structure'; structure: Structure; context: SurfaceContext };
export interface InteractionOpenRequest { sessionId: string; source: InteractionSource }
export interface InteractionSessionInfo {
  sessionId: string; context: SurfaceContext; methods: readonly InteractionMethod[];
  backend: { name: string; version: string }; atomCount: number;
}
export interface InteractionGenerateRequest {
  stamp: SurfaceStamp; method: InteractionMethod; fragments: readonly InteractionSourceFragment[];
  quality: InteractionGridQuality;
}
export interface InteractionIntegral { component: 'inter' | 'intra' | 'total'; value: number; unit: string; rawValue?: string }
export interface InteractionGeneratedFields {
  stamp: SurfaceStamp; method: InteractionMethod; fragments: readonly InteractionSourceFragment[];
  quality: InteractionGridQuality; fields: Partial<Record<InteractionComponent, SurfaceScalarField>>;
  mapping: SurfaceScalarField; integrals: readonly InteractionIntegral[]; provenance: SurfaceProvenance;
}
/** Explicit discriminator for renderer admission. Main-12 density pair validation remains strict. */
export interface InteractionFieldPair extends SurfaceFieldPair {
  kind: 'interaction'; method: InteractionMethod; component: InteractionComponent;
  mapping: SurfaceScalarField; inside: 'above' | 'below';
}
/** Native grids 2/3/4: the deprecated coarse IGMH/mIGM grid is not a default. */
export type InteractionIntegrationQuality = 2 | 3 | 4;
export interface InteractionContributionRequest {
  stamp: SurfaceStamp; method: 'igmh' | 'migm'; fragments: readonly InteractionSourceFragment[];
  pair: readonly [string, string]; integrationQuality: InteractionIntegrationQuality;
}
export interface InteractionAtomContribution {
  sourceIndex: number; element: string; fragmentId: string; value: number; percent: number | null;
}
export interface InteractionPairContribution {
  sourceIndex1: number; sourceIndex2: number; value: number; percent: number | null;
}
export interface InteractionContributions {
  stamp: SurfaceStamp; method: 'igmh' | 'migm'; fragments: readonly InteractionSourceFragment[];
  pair: readonly [string, string]; integrationQuality: InteractionIntegrationQuality;
  atoms: readonly InteractionAtomContribution[]; pairs: readonly InteractionPairContribution[];
  pairSum: number; unit: string; percentageDefinition: 'atoms-within-each-fragment;pairs-within-selected-pair';
  provenance: SurfaceProvenance;
}
export interface InteractionRestoreRequest { stamp: SurfaceStamp; generationId: string }
export interface InteractionCubeExportRequest { stamp: SurfaceStamp; fieldId: string }
