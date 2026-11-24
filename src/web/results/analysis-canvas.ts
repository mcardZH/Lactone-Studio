import type { ModelViewportProps } from '../modeling/ModelViewport';
import type {ModelDocument} from '../../modeling/contracts';
import type {ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import type {ViewportImageExportOptions} from './export-image';
import type {Structure} from '../../core/types';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import type {TrajectoryPlaybackBridge} from './trajectory-playback-bridge';
import type {PesRun} from '../../modeling/pes/contracts';
import type {PlaybackCollectionIdentity} from '../../results/playback-collection';
import type {ViewportRenderIdentity} from '../modeling/render/render-completion';

export interface SubmittedScientificFrame {
  readonly result: TrajectoryResult;
  readonly index: number;
  readonly structure: Structure;
  readonly scene: ViewportRenderIdentity;
  readonly collection: PlaybackCollectionIdentity;
  readonly frameId: string;
  readonly sourceResultId: string;
  readonly stageId: string;
  /** Native publication identity, independent of the playback collection revision. */
  readonly publicationRevision?: string;
}

export interface WorkspaceSpaceOptimizationRequest {
  source:ModelDocument;
  preferences:import('../modeling/tool-session').WorkspaceOptimizationPreferences;
  xtbOptions?:import('../modeling/XtbOptimizationPanel').XtbPanelOptions;
  empiricalBondParameters?:import('../../core/bond-perception-parameters').EmpiricalBondPerceptionParameters;
  spaceKeydownAtMs?:number;
  onRunStarted?:import('../mcp/science-runtime').ObservePesStart;
  onStandaloneRunStarted?(run:import('../mcp/science-runtime').ScienceRuntimeRun):void;
}

/** Display-only projection into the existing model canvas, never a second owner. */
export interface AnalysisCanvas {
  /** Select a verified record using the owning PES workspace's existing route. */
  selectPesRecord?(origin: import('../../results/contracts').PesResultFrameOrigin): { current(): boolean } | undefined;
  ordinaryOptimization?: {method:string;stop():Promise<void>};
  ordinaryOptimizationOutcome?: Pick<PesRun,'request'|'result'|'status'|'error'>;
  /** Runs the existing Space default from a sealed displayed frame in a CALC workbench. */
  onOptimize?(request:WorkspaceSpaceOptimizationRequest):Promise<PesRun|void>;
  /** Stable scientific source/run, stage and original frame identity, excluding append content revision. */
  frameBondIdentity?:import('../../core/modeling/frame-bond-overrides').FrameBondIdentity;
  /** Pure display-bond editing lock: playback/animation or an unprepared frame only.
   * Omission follows modelEditingBlocked for older read-only consumers. */
  bondEditingBlocked?:boolean;
  /** A view of a captured source, not a newly produced scientific result. */
  displayOnlySourcePreview?: true;
  /** Display this accepted result's frame even when its workspace model is editable. */
  observeResultGeometry?: true;
  /** Read-only frame projection; never committed into the model Store. */
  document?: ModelDocument;
  /** Static selected frame, excluding vibration/overlap display geometry. */
  staticDocument?: ModelDocument;
  /** Native selected frame for new scientific inputs. Display bond overrides never enter it. */
  scientificDocument?: ModelDocument;
  /** Molecular geometry visible at capture, including a vibration phase but no
   * camera or pure display superposition. Structural export seals this value. */
  exportStructure?:Structure;
  /** Exact source/collection revision at publication, not a later render key. */
  sourceRevision?: string;
  /** The proposed frame has prepared raw geometry and has been submitted by the viewport. */
  scientificFrameReady?: boolean;
  /** Reads the last submitted raw frame within the active source and collection revision.
   * A later proposed frame replaces it only after the viewport acknowledges that frame. */
  readSubmittedScientificFrame?(): SubmittedScientificFrame | undefined;
  /** Pauses observation and returns a source snapshot without writing Store. */
  prepareModelEdit?(): Structure;
  /** Observation animation must be paused explicitly before scientific edits. */
  modelEditingBlocked?: boolean;
  vibrationPlaying?: boolean;
  /** PES exact group constraints projected onto this scientific view only. */
  pesConstraints?: SharedModelConstraints;
  /** Display-only hard freezes from the frame's owning conformer initial page. */
  sharedFreezeDisplay?: SharedModelConstraints;
  frameIndex?: number;
  result?: TrajectoryResult;
  controls?: ReactNode;
  trajectoryPlayback?:TrajectoryPlaybackBridge;
  toolbarActions?: ReactNode;
  /** View-only transient measurements cannot inherit the target Store's BADs. */
  measurementOwnerKey?: string;
  /** Source-owned display annotations, never committed as editable model coordinates. */
  coordinateAnnotations?:readonly import('../../modeling/contracts').MeasurementRecord[];
  viewport: Pick<ModelViewportProps, 'cipStructure' | 'displayAtoms' | 'displayFrozenAtomIds' | 'cameraView' | 'hiddenAtomIds' | 'viewTransform' | 'fixedCellView' | 'multiframeDisplay' | 'samplingSphere' | 'calculationRanges' | 'vibrationVectors' | 'atomScalarValues' | 'atomScalarColor' | 'atomScalarLabels' | 'orbitalLayer' | 'ntoLayer' | 'dipoleVector' | 'resultBondValues' | 'resultBondLabels' | 'resultBondColor' | 'resultHighlights' | 'resultColorbar' | 'resultColorbarOwnerKey' | 'onResultColorbarLayoutChange' | 'resultAtomLabels' | 'surfaceLayer' | 'surfaceLayers' | 'surfaceExtrema' | 'onSurfaceExtremumHover' | 'onSurfaceExtremumPick' | 'analysisAtomCapture' | 'renderIdentity' | 'onRenderComplete' | 'onSceneSubmitted' | 'onSurfaceMeshState' | 'onSurfaceMeshStates' | 'onNtoMeshState'>;
  onViewReady(getter: (() => number[]) | null): void;
  onExport(): void;
  onExportImage?(options: ViewportImageExportOptions, ownerDocument: Document): void | Promise<void>;
  onCaptureImage?(options: ViewportImageExportOptions, ownerDocument: Document, signal: AbortSignal): Promise<Blob>;
  /** Raw structure observation uses the common workspace export implementation. */
  useWorkspaceImageExport?: boolean;
  exportAvailable?: boolean;
  exporting: boolean;
}
