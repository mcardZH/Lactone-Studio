import type { ModelViewportProps } from '../modeling/ModelViewport';
import type {ModelDocument} from '../../modeling/contracts';
import type {ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import type {ViewportImageExportOptions} from './export-image';
import type {Structure} from '../../core/types';
import type {TrajectoryPlaybackBridge} from './trajectory-playback-bridge';

/** Display-only projection into the existing model canvas, never a second owner. */
export interface AnalysisCanvas {
  /** Read-only frame projection; never committed into the model Store. */
  document?: ModelDocument;
  /** Static selected frame, excluding vibration/overlap display geometry. */
  staticDocument?: ModelDocument;
  /** Pauses observation and returns a source snapshot without writing Store. */
  prepareModelEdit?(): Structure;
  /** Observation animation must be paused explicitly before scientific edits. */
  modelEditingBlocked?: boolean;
  frameIndex?: number;
  result?: TrajectoryResult;
  controls?: ReactNode;
  trajectoryPlayback?:TrajectoryPlaybackBridge;
  toolbarActions?: ReactNode;
  /** View-only transient measurements cannot inherit the target Store's BADs. */
  measurementOwnerKey?: string;
  viewport: Pick<ModelViewportProps, 'displayAtoms' | 'displayFrozenAtomIds' | 'cameraView' | 'hiddenAtomIds' | 'viewTransform' | 'multiframeDisplay' | 'samplingSphere' | 'calculationRanges' | 'vibrationVectors' | 'atomScalarValues' | 'atomScalarColor' | 'atomScalarLabels' | 'orbitalLayer' | 'ntoLayer' | 'dipoleVector' | 'resultBondValues' | 'resultBondLabels' | 'resultBondColor' | 'resultHighlights' | 'resultColorbar' | 'resultColorbarOwnerKey' | 'onResultColorbarLayoutChange' | 'resultAtomLabels' | 'surfaceLayer' | 'surfaceLayers' | 'surfaceExtrema' | 'onSurfaceExtremumHover' | 'onSurfaceExtremumPick' | 'analysisAtomCapture' | 'renderIdentity' | 'onRenderComplete' | 'onSurfaceMeshState' | 'onSurfaceMeshStates' | 'onNtoMeshState'>;
  onViewReady(getter: (() => number[]) | null): void;
  onExport(): void;
  onExportImage?(options: ViewportImageExportOptions, ownerDocument: Document): void | Promise<void>;
  /** Raw structure observation uses the common workspace export implementation. */
  useWorkspaceImageExport?: boolean;
  exportAvailable?: boolean;
  exporting: boolean;
}
