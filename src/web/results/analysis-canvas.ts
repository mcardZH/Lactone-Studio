import type { ModelViewportProps } from '../modeling/ModelViewport';
import type {ModelDocument} from '../../modeling/contracts';
import type {ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import type {ViewportImageExportOptions} from './export-image';
import type {Structure} from '../../core/types';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import type {TrajectoryPlaybackBridge} from './trajectory-playback-bridge';

export interface WorkspaceSpaceOptimizationRequest {
  source:ModelDocument;
  preferences:import('../modeling/tool-session').WorkspaceOptimizationPreferences;
  xtbOptions?:import('../modeling/XtbOptimizationPanel').XtbPanelOptions;
}

/** Display-only projection into the existing model canvas, never a second owner. */
export interface AnalysisCanvas {
  /** Runs the existing Space default from a sealed displayed frame in a CALC workbench. */
  onOptimize?(request:WorkspaceSpaceOptimizationRequest):Promise<void>;
  /** Stable scientific source/run, stage and original frame identity, excluding append content revision. */
  frameBondIdentity?:import('../../core/modeling/frame-bond-overrides').FrameBondIdentity;
  /** Pure display-bond editing lock: playback/animation or an unprepared frame only.
   * Omission follows modelEditingBlocked for older read-only consumers. */
  bondEditingBlocked?:boolean;
  /** A view of a captured source, not a newly produced scientific result. */
  displayOnlySourcePreview?: true;
  /** Read-only frame projection; never committed into the model Store. */
  document?: ModelDocument;
  /** Static selected frame, excluding vibration/overlap display geometry. */
  staticDocument?: ModelDocument;
  /** Molecular geometry visible at capture, including a vibration phase but no
   * camera or pure display superposition. Structural export seals this value. */
  exportStructure?:Structure;
  /** Exact source/collection revision at publication, not a later render key. */
  sourceRevision?: string;
  scientificFrameReady?: boolean;
  /** Pauses observation and returns a source snapshot without writing Store. */
  prepareModelEdit?(): Structure;
  /** Observation animation must be paused explicitly before scientific edits. */
  modelEditingBlocked?: boolean;
  /** PES exact group constraints projected onto this scientific view only. */
  pesConstraints?: SharedModelConstraints;
  frameIndex?: number;
  result?: TrajectoryResult;
  controls?: ReactNode;
  trajectoryPlayback?:TrajectoryPlaybackBridge;
  toolbarActions?: ReactNode;
  /** View-only transient measurements cannot inherit the target Store's BADs. */
  measurementOwnerKey?: string;
  /** Source-owned display annotations, never committed as editable model coordinates. */
  coordinateAnnotations?:readonly import('../../modeling/contracts').MeasurementRecord[];
  viewport: Pick<ModelViewportProps, 'displayAtoms' | 'displayFrozenAtomIds' | 'cameraView' | 'hiddenAtomIds' | 'viewTransform' | 'multiframeDisplay' | 'samplingSphere' | 'calculationRanges' | 'vibrationVectors' | 'atomScalarValues' | 'atomScalarColor' | 'atomScalarLabels' | 'orbitalLayer' | 'ntoLayer' | 'dipoleVector' | 'resultBondValues' | 'resultBondLabels' | 'resultBondColor' | 'resultHighlights' | 'resultColorbar' | 'resultColorbarOwnerKey' | 'onResultColorbarLayoutChange' | 'resultAtomLabels' | 'surfaceLayer' | 'surfaceLayers' | 'surfaceExtrema' | 'onSurfaceExtremumHover' | 'onSurfaceExtremumPick' | 'analysisAtomCapture' | 'renderIdentity' | 'onRenderComplete' | 'onSurfaceMeshState' | 'onSurfaceMeshStates' | 'onNtoMeshState'>;
  onViewReady(getter: (() => number[]) | null): void;
  onExport(): void;
  onExportImage?(options: ViewportImageExportOptions, ownerDocument: Document): void | Promise<void>;
  onCaptureImage?(options: ViewportImageExportOptions, ownerDocument: Document, signal: AbortSignal): Promise<Blob>;
  /** Raw structure observation uses the common workspace export implementation. */
  useWorkspaceImageExport?: boolean;
  exportAvailable?: boolean;
  exporting: boolean;
}
