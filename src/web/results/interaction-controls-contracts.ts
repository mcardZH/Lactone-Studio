import type { CalculationRangeFeedback } from '../../results/calculation-range';
import type { ReactNode } from 'react';
import type { Structure } from '../../core/types';
import type { InteractionComponent, InteractionContributions, InteractionFieldPair, InteractionFragment, InteractionGeneratedFields, InteractionGridQuality, InteractionIntegrationQuality, InteractionMethod, InteractionSourceFragment } from '../../results/interaction-contracts';
import type { SurfaceContext, SurfaceScalarField } from '../../results/surface-contracts';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { MeshFinishSettings } from '../../results/mesh-appearance';
import type { ScientificScatterData } from '../../results/scatter-data';
import type { ScientificPlotViewport } from '../../results/scientific-plot';
import type { SurfaceColorMapping } from '../modeling/render/surface-layer';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';
import type { LocalAppearanceId } from './SurfaceAppearanceControls';

export interface InteractionGenerateInvocation { context: SurfaceContext; requestId: string; method: InteractionMethod; fragments: readonly InteractionSourceFragment[]; quality: InteractionGridQuality }
export interface InteractionContributionInvocation { context: SurfaceContext; requestId: string; method: 'igmh'|'migm'; fragments: readonly InteractionSourceFragment[]; pair: readonly [string,string]; integrationQuality: InteractionIntegrationQuality }
export interface InteractionFieldsRestoreInvocation { context: SurfaceContext; requestId: string; generationId: string }
export interface InteractionCubeRestoreInvocation { context: SurfaceContext; requestId: string; fieldId: string; sourceId: string; sourceRevision: string }
export interface InteractionCubeImportInvocation { context: SurfaceContext; requestId: string; file: File; method: InteractionMethod; role: InteractionComponent|'mapping'; valueUnit: string|null }
/** A real session and immutable artifact owner implements these bounded UI ports. */
export interface InteractionControlsBridge {
  generate?(request: InteractionGenerateInvocation,signal: AbortSignal): Promise<InteractionGeneratedFields>;
  contributions?(request: InteractionContributionInvocation,signal: AbortSignal): Promise<InteractionContributions>;
  restoreFields?(request: InteractionFieldsRestoreInvocation,signal: AbortSignal): Promise<InteractionGeneratedFields>;
  restoreCube?(request: InteractionCubeRestoreInvocation,signal: AbortSignal): Promise<SurfaceScalarField>;
  importCube?(request: InteractionCubeImportInvocation,signal: AbortSignal): Promise<SurfaceScalarField>;
  /** Resolves only after the host confirms actual atomic publication. Native
   * export progress keeps this exact UI requestId through the save dialog. */
  exportCube?(field: SurfaceScalarField,signal: AbortSignal,requestId:string): Promise<void>;
  cancel?(requestId: string): void|Promise<void>;
}
export interface InteractionDisplaySettings {
  component: InteractionComponent; isovalue: number|null; visible: boolean; opacity: number;
  color: SurfaceColorMapping|null; finish?: MeshFinishSettings;
  appearancePreset?: LocalAppearanceId;
  colorbarLayout?: AnalysisColorbarLayout;
  scatterPointSize: number; scatterOpacity: number; scatterViewport: ScientificPlotViewport|null;
}
export interface InteractionHighlights {
  atoms: readonly { atomId: string; label: string; value: number }[];
  pairs: readonly { atomIds: [string,string]; label: string; value: number }[];
}
export interface InteractionProjection extends CalculationRangeFeedback {
  context: SurfaceContext; method: InteractionMethod; fields: InteractionFieldPair|null;
  display: InteractionDisplaySettings; generated: InteractionGeneratedFields|null;
  contributions: InteractionContributions|null; highlights: InteractionHighlights; decimals: number;
}
export interface InteractionInteractionPort { hover(key: string|null): void; toggle(key: string): void; releaseFields?():void; setColorbarLayout?(layout:AnalysisColorbarLayout):void }
export interface InteractionFragmentSelectionProps {
  fragmentId: string; label: string; atomIds: readonly string[]; fragments: readonly InteractionFragment[]; disabled: boolean;
  renderHeader?(selectionActions: ReactNode): ReactNode;
  /** The shared picker owns draft, remaining atoms and overwrite confirmation.
   * Confirm supplies the complete immutable membership transaction. */
  onConfirm(fragments: readonly InteractionFragment[],assertCurrent: ()=>void): void;
}
export interface InteractionScatterSnapshot {
  context: SurfaceContext; method: InteractionMethod; component: InteractionComponent; data: ScientificScatterData;
  xLabel: string; yLabel: string; display: InteractionDisplaySettings; decimals: number;
}
export interface InteractionAnalysisControlsProps {
  /** Same-source owner memory only. No file/global settings or transport. */
  draftState?: { current?: import('./InteractionAnalysisControls').InteractionAnalysisSnapshot };
  context: SurfaceContext; structure: Structure; active: boolean; available?: boolean;
  resourceBudgetBytes?: number;
  wavefunctionAvailable: boolean; methods: readonly InteractionMethod[]; bridge: InteractionControlsBridge;
  sourceAtomOrder: readonly {atomId:string;sourceIndex:number}[];
  methodDefaults?: Partial<Record<InteractionMethod,Partial<Pick<InteractionDisplaySettings,'isovalue'|'color'|'opacity'|'finish'>>>>;
  /** References verified by the scientific owner; no frontend-invented citations. */
  methodReferences?:Partial<Record<InteractionMethod,readonly {label:string;href:string}[]>>;
  initialMethod?: InteractionMethod; progress?: MultiwfnProgressSnapshot|null;
  renderFragmentSelection?(props: InteractionFragmentSelectionProps): ReactNode;
  /** Exact source geometry admission, not a context-label-only test. */
  cubeGeometryError?(field: SurfaceScalarField): string|null;
  onProjection(value: InteractionProjection|null): void;
  onResultAccepted?(requestId:string,operation:'fields'|'contributions'|'export'):void;
  /** Read-only save Promise actually rejected; native settlement must still be
   * taken from the original host run, never inferred from this callback alone. */
  onResultRejected?(requestId:string,operation:'export',reason:'cancelled'|'failed',message?:string):void;
  onInteractionReady?(port: InteractionInteractionPort|null): void;
  onOpenScatter?(snapshot: InteractionScatterSnapshot): void;
  onExportImage?(): void|Promise<void>; onError?(message:string): void;
}
