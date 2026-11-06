import type { Structure } from '../../core/types';
import type { ReactivityAnalysisResult, ReactivityAnalyzeRequest, ReactivitySessionInfo } from '../../results/reactivity-contracts';
import type { OrbitalField, WavefunctionMetadata } from '../../results/orbital-contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { AnalysisColorbar } from './analysis-display';
import type { OrbitalLayerSettings } from './orbital-display';
import type { OrbitalBridge } from './useOrbitalField';
import type { AnalysisColorbarLayout } from './analysis-colorbar-layout';

export interface ReactivityControlsBridge {
  analyze?(request: ReactivityAnalyzeRequest, signal: AbortSignal): Promise<ReactivityAnalysisResult>;
  cancel?(requestId: string): void | Promise<void>;
}
export type ReactivityAtomMetric = 'fPlus' | 'fMinus' | 'fZero' | 'dual' | 'omega' | 'NNu' | 'sPlus' | 'sMinus' | 'sZero';
export interface ReactivityInteractionPort { hover(key: string | null): void; toggle(key: string): void; setColorbarLayout?(layout:AnalysisColorbarLayout):void }
export interface ReactivityAtomDisplay { atomId: string; value: number; label: string; color?: string }
export interface ReactivityProjection {
  context: SurfaceContext; result: ReactivityAnalysisResult | null; decimals: number;
  metric: ReactivityAtomMetric; scalarValues: readonly ReactivityAtomDisplay[]; color: boolean;
  highlights: readonly ReactivityAtomDisplay[]; colorbar: AnalysisColorbar | null;
  orbitalField: OrbitalField | null; orbitalSettings: OrbitalLayerSettings;
}
export interface ReactivityAnalysisControlsProps {
  analysisId: string; context: SurfaceContext; structure: Structure; active: boolean; available?: boolean;
  wavefunctionAvailable: boolean; bridge: ReactivityControlsBridge;
  sessionInfo?: ReactivitySessionInfo | null;
  metadata?: WavefunctionMetadata | null; orbitalSessionId?: string | null; orbitalBridge?: OrbitalBridge | null;
  sourceAtomOrder: readonly { atomId: string; sourceIndex: number }[];
  progress?: MultiwfnProgressSnapshot | null;
  onProjection(value: ReactivityProjection | null): void;
  onInteractionReady?(port: ReactivityInteractionPort | null): void;
  onResultAccepted?(requestId: string): void;
  onExportImage?(): void | Promise<void>;
  onError?(message: string): void;
}
