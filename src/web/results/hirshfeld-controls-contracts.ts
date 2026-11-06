import type { Structure } from '../../core/types';
import type { HirshfeldAnalysisResult, HirshfeldSessionInfo } from '../../results/hirshfeld-contracts';
import type { OrbitalResourceInfo } from '../../results/orbital-contracts';
import type { CalculationRangeDisplay } from '../../results/calculation-range';
import type { SurfaceAppearancePresetId } from '../../results/surface-appearance-presets';
import type { HirshfeldFingerprintDisplay } from '../../results/hirshfeld-presentation';
import { initialHirshfeldFingerprintDisplay } from '../../results/hirshfeld-presentation';
import { hirshfeldAppearance } from './surface-appearance';
import type { HirshfeldContactFocus } from '../../results/hirshfeld-presentation';
import type { SurfaceContext } from '../../results/surface-contracts';
import type { MeshFinishSettings } from '../../results/mesh-appearance';
import type { ViewportSurfaceLayer } from '../modeling/render/surface-layer';
import type { AnalysisSelectionPort } from '../analysis-selection-intent';
import type { AnalysisColorbar } from './analysis-display';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';

export interface HirshfeldDisplay { appearancePreset?: SurfaceAppearancePresetId | 'custom'; colors?: readonly string[]; visible: boolean; showEnvironment: boolean; opacity: number; finish?: MeshFinishSettings; range: { min: number; max: number } | null; reverse: boolean; colorbarLayout?: AnalysisColorbarLayout }
export interface HirshfeldProjection { context: SurfaceContext; result: HirshfeldAnalysisResult | null; calculationRanges?: readonly CalculationRangeDisplay[]; display: HirshfeldDisplay; surfaceLayer: ViewportSurfaceLayer | null;
  colorbar: AnalysisColorbar | null; hiddenAtomIds: readonly string[]; selectedContact: HirshfeldContactFocus | null }
/** A fixed plot snapshot retains point/area identities, never duplicate Cube buffers or a native session. */
export interface HirshfeldFingerprintSnapshot { result: Pick<HirshfeldAnalysisResult, 'stamp' | 'source' | 'vertices' | 'contacts'>;
  focus: HirshfeldContactFocus | null; decimals: number; merged: boolean; plotDisplay?: HirshfeldFingerprintDisplay }
export interface HirshfeldControlsState { mode: 'closed' | 'open-preview'; showRange: boolean; rangeExtensionBohr: number | null; rangeError: string;
  plotDisplay: HirshfeldFingerprintDisplay; areaView: 'table' | 'chart' | 'both'; areaSort: 'contact' | 'area' | 'percent'; areaSortDirection: 'asc' | 'desc';
  targetIds: readonly string[]; spacingBohr: number; result: HirshfeldAnalysisResult | null;
  resourceDraft: { custom: boolean; threads: number | null; memoryGiB: number | null };
  grantPresentation: 'current' | 'previous';
  display: HirshfeldDisplay; selectedContact: HirshfeldContactFocus | null; merged: boolean; decimals: number; error: string }
export const initialHirshfeldState = (): HirshfeldControlsState => ({ mode: 'closed', showRange: false, rangeExtensionBohr: null, rangeError: '', plotDisplay: initialHirshfeldFingerprintDisplay(), areaView: 'table', areaSort: 'area', areaSortDirection: 'desc', targetIds: [], spacingBohr: .2, result: null,
  resourceDraft: { custom: false, threads: null, memoryGiB: null },
  grantPresentation: 'previous',
  display: hirshfeldAppearance({ visible: true, showEnvironment: true, opacity: .85, range: null, reverse: true },'gallery-hirshfeld'), selectedContact: null, merged: false, decimals: 2, error: '' });
export interface HirshfeldAnalysisControlsProps { structure: Structure; context: SurfaceContext; state: HirshfeldControlsState; disabled: boolean; running: boolean;
  sourceError?: string; capturePort?: AnalysisSelectionPort; progress?: MultiwfnProgressSnapshot | null;
  resourceDefaults?: OrbitalResourceInfo | null; sessionInfo?: HirshfeldSessionInfo | null; resourceError?: string;
  onChange(patch: Partial<HirshfeldControlsState>): void; onCalculate(): void; onStop(): void; onExportCube(role: 'shape' | 'mapping'): void;
  onExportImage?(): void | Promise<void>; onOpenFingerprint?(snapshot: HirshfeldFingerprintSnapshot): void }
