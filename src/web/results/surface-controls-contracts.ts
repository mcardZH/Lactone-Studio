import type { ReactNode } from 'react';
import type { Structure } from '../../core/types';
import type { SurfaceAnalysisResult, SurfaceAreaDistribution, SurfaceCapability, SurfaceContext, SurfaceCubeQuality, SurfaceFieldPair, SurfaceFunction, SurfaceGeneratedFields, SurfaceQuantitativeGrid, SurfaceRegionResult, SurfaceRegionSelection, SurfaceScalarField, SurfaceRegionResponse } from '../../results/surface-contracts';
import type { ViewportSurfaceExtrema, ViewportSurfaceLayer } from '../modeling/render/surface-layer';
import type { AnalysisColorbar, AnalysisPalette } from './analysis-display';
import type { MeshFinishSettings } from '../../results/mesh-appearance';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';
import type { LocalAppearanceId } from './SurfaceAppearanceControls';

/** UI invocation data only. The enclosing analysis owner supplies a real backend
 * session and implements these ports through the bounded desktop bridge. */
export interface SurfaceAnalysisInvocation {
  context: SurfaceContext; requestId: string; function: SurfaceFunction; isovalue: number; quantitativeGrid: SurfaceQuantitativeGrid;
  input: { kind: 'wavefunction' } | { kind: 'cubes'; pair: SurfaceFieldPair };
}
/** Backend preflight and a verified session may have different capabilities.
 * Only an exact current scientific input may reuse session-specific evidence. */
export interface SurfaceCapabilityRequest {
  context: SurfaceContext; function: SurfaceFunction; isovalue: number; quantitativeGrid: SurfaceQuantitativeGrid;
  input: { kind: 'wavefunction' } | { kind: 'cubes'; pair: SurfaceFieldPair | null };
}
export interface SurfaceRegionInvocation { analysis: SurfaceAnalysisResult; selection: SurfaceRegionSelection; requestId: string }
export interface SurfaceDistributionInvocation {
  analysis: SurfaceAnalysisResult; regionId: string; lower: number; upper: number; binCount: number; valueUnit: string; requestId: string;
}
export interface SurfaceGenerationInvocation { analysis: SurfaceAnalysisResult; quality: SurfaceCubeQuality; requestId: string }
export interface SurfaceFieldsRestoreInvocation { context: SurfaceContext; requestId: string; analysisId: string; generationId: string }
export interface SurfaceCubeRestoreInvocation { context: SurfaceContext; requestId: string; fieldId: string; sourceId: string; sourceRevision: string }
export interface SurfaceCubeImportInvocation {
  context: SurfaceContext; role: 'shape' | 'mapping'; function: 'electron-density' | SurfaceFunction;
  file: File; valueUnit: string | null;
}
export interface SurfaceControlsBridge {
  onProgress?(listener:(progress:import('../../results/multiwfn-progress').MultiwfnProgressSnapshot)=>void):()=>void;
  analyze?(request: SurfaceAnalysisInvocation, signal: AbortSignal): Promise<SurfaceAnalysisResult>;
  analyzeRegion?(request: SurfaceRegionInvocation, signal: AbortSignal): Promise<SurfaceRegionResponse>;
  distribution?(request: SurfaceDistributionInvocation, signal: AbortSignal): Promise<SurfaceAreaDistribution>;
  generate?(request: SurfaceGenerationInvocation, signal: AbortSignal): Promise<SurfaceGeneratedFields>;
  /** Read an existing immutable artifact; these ports must never generate or re-import a source File. */
  restoreFields?(request: SurfaceFieldsRestoreInvocation, signal: AbortSignal): Promise<SurfaceGeneratedFields>;
  restoreCube?(request: SurfaceCubeRestoreInvocation, signal: AbortSignal): Promise<SurfaceScalarField>;
  importCube?(request: SurfaceCubeImportInvocation, signal: AbortSignal): Promise<SurfaceScalarField>;
  /** Must export the actual field plus its bound domain metadata through the
   * protected existing exporter. Resolves after that exporter accepts the job. */
  exportCube?(field: SurfaceScalarField, signal: AbortSignal): Promise<void>;
  cancel?(requestId: string): void | Promise<void>;
}
export interface SurfaceDisplaySettings {
  visible: boolean; opacity: number; palette: AnalysisPalette;
  finish?: MeshFinishSettings;
  appearancePreset?: LocalAppearanceId;
  colors?: readonly string[];
  /** Local presentation only; the original mapping field remains attached. */
  coloring?: 'mapped' | 'solid';
  solidColor?: string;
  colorbarLayout?: AnalysisColorbarLayout;
  range?: { min: number; max: number }; rangeLocked: boolean; reverse: boolean;
  markersVisible: boolean; showAllExtremaValues: boolean; pinnedExtremumIds: readonly string[]; hoveredExtremumId: string | null;
  valuesVisible?: boolean; coordinatesVisible?: boolean; hiddenExtremumIds?: readonly string[];
  currentExtremumId?: string | null;
  /** Presentation state is scoped to accepted analysis and quantitative region. */
  extremaByRegion?: Readonly<Record<string, { pinnedExtremumIds: readonly string[]; hoveredExtremumId: string | null; hiddenExtremumIds: readonly string[]; currentExtremumId?: string | null }>>;
}
export interface SurfaceInteractionPort { hover(id: string | null): void; toggle(id: string): void; setColorbarLayout?(layout: AnalysisColorbarLayout): void }
export interface SurfaceProjection {
  context: SurfaceContext; function: SurfaceFunction; regionId: string; analysis: SurfaceAnalysisResult | null;
  fields: SurfaceFieldPair | null; display: SurfaceDisplaySettings;
  region: SurfaceRegionResult | null; surfaceLayer: ViewportSurfaceLayer | null; surfaceExtrema: ViewportSurfaceExtrema | null;
  colorbar: (AnalysisColorbar & { reverse: boolean }) | null;
  capabilityRequest?: SurfaceCapabilityRequest;
}
export interface SurfaceRegionSelectionProps {
  kind: 'atoms' | 'fragment'; atomIds: readonly string[]; disabled: boolean;
  onConfirm(ids: string[], assertCurrent: () => void): void;
}
export interface SurfaceAnalysisControlsProps {
  context: SurfaceContext; structure: Structure; active: boolean; available?: boolean;
  wavefunctionAvailable: boolean; capabilities: readonly SurfaceCapability[]; bridge: SurfaceControlsBridge;
  allowedWavefunctionMethods?: readonly SurfaceFunction[];
  resourceBudgetBytes?: number;
  /** Omitted by fixed test/standalone providers; dynamic providers bind to the request identity. */
  capabilitiesKey?: string;
  /** Explicit verified one-based source order; never infer it from an engine's native index base. */
  sourceAtomOrder?: readonly { atomId: string; sourceIndex: number }[];
  /** Actual source geometry/printing-precision admission, independent of a context label. Required for external slots. */
  cubeGeometryError?(field: SurfaceScalarField): string | null;
  renderRegionSelection?(props: SurfaceRegionSelectionProps): ReactNode;
  sourceToDocument?: ViewportSurfaceLayer['sourceToDocument'];
  onProjection(value: SurfaceProjection | null): void;
  onInteractionReady?(port: SurfaceInteractionPort | null): void;
  onExportImage?(): void | Promise<void>; onError?(message: string): void;
}
