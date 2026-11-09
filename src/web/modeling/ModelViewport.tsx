import { type CalculationRangeFeedback } from '../../results/calculation-range';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { claimTransientCanvasDismiss } from '../TransientLayer';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { DisplaySettings, InteractionState, MeasurementRecord, MeasurementState, ModelCommand, ModelDocument, ModelSelection, PickResult, ScreenPoint, SelectionCaptureRequest } from '../../modeling/contracts';
import type { Atom, Structure, Vector3, PeriodicCell } from '../../core/types';
import type { TransformPreviewGuides } from './render/transform-guides';
import { captureSelectionPresentation, captureVisibleStateMarkers } from './viewport-overlays';
import type { BondOrderEntry } from '../../modeling/xtb/contracts';
import type { ViewportOrbitalLayer } from '../../results/orbital-contracts';
import { getFrozenAtomIds } from '../../core/modeling';
import {ScientificEditCancelledError} from '../../core/modeling/analysis-binding';
import type { ViewerHighlights } from '../../core/display-highlights';
import { createRenderAdapter,requiresCooperativeDisplay, type RenderAdapter, type RenderFeedbackOptions, type ViewportVibrationVector, type ViewportAtomScalarValue, type ViewportDipoleVector } from './render/adapter';
import {cameraRotationDrag} from './render/display-settings';
import {viewportSamplingSphere} from './render/sampling-sphere-preview';
import {preparedCarbonCipUsage,type CipDisplayUsage,type CipLabelWarning} from './render/stereochemistry';
import './stereochemistry-warning.css';
import { modelHighlights } from './render/display';
import { atomHoverLabel, captureViewportDisplay, dispatchMeasurementPick, measurementConnectionPair, createFragmentPreviewSource, fragmentFramePresentation, fragmentPointerStep, gestureLeaseCurrent, hoverBondLength, hoverBondLabel, indexHoverBondOrders, useBoxGesture, type FragmentPreviewSource, type PointerMode } from './modeling-interaction-policy';
import { createLatestMoveScheduler } from './viewport-move-scheduler';
import {createProjectionPlanCache,useProjectedState,type ProjectionCounters} from './viewport-projection-cache';
import { viewportProjectionSignature } from './viewport-projection-signature';
import type { SurfaceMeshState, SurfaceLayerMeshState } from './render/surface-layer';
import type { ViewportNtoLayer, NtoMeshState } from './render/orbital-layer';
import {createViewportResizeQueue,VIEWPORT_LAYOUT_RESIZE_EVENT} from './render/resize-lifecycle';
import { presentElementColors } from './render/element-colors';
import { emptyObservationView, updateObservationView, identityTransform, type RigidTransform } from './render/alignment';
import { multiframeDisplayDiagnostics, type MultiframeDisplayPlan, type SamplingSphereDisplay } from '../../modeling/view-multiframe';
import { add, centroid, coordinates, planeDelta, scale, selectionAfterPick, unionBox, ViewportProjectionError, type DragPlane } from './render/geometry';
import { resolveFinitePeriodicFragment } from '../../core/modeling/periodic-modeling';
import './modeling-viewport.css';
import { molecularFormula } from '../../core/elements';
import { molecularMass } from '../../core/molecular-mass';
import { persistentToolCommand } from './workspace-actions';
import { captureBoxAtomIds, captureBoxCoordinateIds, captureRenderDocument, resolveKnownCoordinateMarkerAction, projectCaptureMarkers, projectMeasurementLabels, controlDragBondCommand, pointerStateAction, overlayClickAllowed, selectionWithAtomState, selectionWithCoordinateState, sameViewportPick, projectStateMarkers, stateMarkerObjects, type AtomStateAction, type ViewportObjectState, type ViewportStateMarker, type MeasurementLabel } from './viewport-overlays';
import { coordinateSelectionObjects } from '../../core/modeling/coordinate-selection';
import type { PhysicalAxisProjection } from './render/camera';
import PhysicalAxesOverlay from './PhysicalAxesOverlay';
import { DismissibleNotice } from '../DismissibleNotice';
import { FREEZE_COLOR } from '../../core/display-highlights';
import { FREEZE_ICON_PATHS } from './freeze-marker-presentation';
import { assignmentDisplayKey, projectAssignmentBadges, projectAssignmentDisplay, type AssignmentDisplayRegion } from '../../modeling/application/assignment-display';
import AssignmentBadges from './AssignmentBadges';
import CompactModelLegend from './CompactModelLegend';
import {projectResultAtomLabels,projectResultBondLabels,projectResultMeasurementLabels,resultSelectionPresentation,resultMeasurementValueLabel,resultTargetLabel,projectResultBondColors,resultBondHover,resultBondHoverText,sameResultProjectionInputs,type ResultProjectionInputs,type ViewportResultHighlights,type ViewportResultBondValue,type ViewportResultAtomLabel} from './result-overlays';
import {ResultLabelLayer,mergeResultLabelItems,resultLabelTargetKey,resultLabelPresentation,type ResultLabelItem} from './result-label-presentation';

import type {AnalysisColorbar} from '../results/analysis-display';
import type {AnalysisColorbarLayout} from '../results/analysis-colorbar-layout';
import AnalysisColorbarOverlay from '../results/AnalysisColorbarOverlay';
import type { ViewportSurfaceLayer, ViewportSurfaceExtrema } from './render/surface-layer';
import { projectSurfaceExtremaLabels } from './surface-overlays';
import type { ViewportRenderIdentity, ViewportRenderObserver } from './render/render-completion';
import CellEditorOverlay, { ReadOnlyCellOverlay } from './CellEditorOverlay';
import type { CellPresentationOptions } from '../../core/modeling/cell-presentation';
import type { CellEditorViewportDraft } from './CellEditorPanel';
import SamplingSphereOverlay from './SamplingSphereOverlay';
import type {SamplingSphereViewportDraft,SamplingSphereRadiusChange} from '../../modeling/advanced/sampling-sphere';

/** Temporary box/rope overlays share the exact client-space hit surface. */
export function viewportBondRopeBounds(drawing: boolean, surface: Pick<Element, 'getBoundingClientRect'> | null | undefined): DOMRect | undefined {
  return drawing ? surface?.getBoundingClientRect() : undefined;
}
const RENDER_DIAGNOSTIC_KEYS=['sceneCreated','sceneReused','sceneRetired','sceneCommands','sceneMetadataBytes','ownedShapes','ownedModels','ownedResources','shapeSlots','modelSlots','gpuGeometries','gpuTextures','gpuPrograms','fragmentSamples','fragmentRetirementBatches','fragmentPartialPresents','fragmentFullPresents','fragmentFallbackCode','scenePreparations','sceneAborts','sphereGeometryBuilds','sphereNativeCompilations','sphereTransformUpdates','sphereFallbacks','sphereOwnedHandles','glyphRegistrations','glyphBatches','glyphBonds','glyphWorkerStarts','glyphWorkerStops','glyphCancellations','glyphAdjacencyBuilds','glyphPending'] as const;

/** Independent, display-only analysis draft; never an input or model selection. */
export interface AnalysisAtomCapture {
  requestId: string; ownerId: string; contextKey: string; atomIds: readonly string[]; kind?:'atoms'|'coordinate';
  assertCurrent(): void;
  onPick(atomId: string | null): void;
  onBox(atomIds: string[]): void;
  onCoordinate?(atomIds: string[]): void;
  onCancel(): void;
}
export function analysisCaptureCurrent(captured: Pick<AnalysisAtomCapture, 'requestId' | 'ownerId' | 'contextKey'>, current?: AnalysisAtomCapture): boolean {
  if (!current || captured.requestId !== current.requestId || captured.ownerId !== current.ownerId || captured.contextKey !== current.contextKey) return false;
  try { current.assertCurrent(); return true; } catch { return false; }
}
/** Input capture has its own draft callbacks and never falls into Store edits. */
export function finishInputCaptureGesture(document:ModelDocument,request:SelectionCaptureRequest|undefined,atomIds:readonly string[],gesture:{documentId:string;revision:number;captureRequestId?:string;kind:'box'|'camera'|'fragment';button:number;moved:boolean;start:ScreenPoint;end:ScreenPoint;pick:PickResult},project:(position:Vector3)=>ScreenPoint,callbacks:{onCapturePick?:(id:string|null)=>void;onCaptureBox?:(ids:string[],images?:Vector3[])=>void},releasePick:PickResult,hiddenAtomIds:readonly string[]=[]){
  if(!request||request.requestId!==gesture.captureRequestId||request.documentId!==document.id||request.revision!==document.revision||gesture.documentId!==document.id||gesture.revision!==document.revision)return;
  if(gesture.kind==='box'&&gesture.moved&&request.kind==='atoms'){
    const {start,end}=gesture,ids=captureBoxAtomIds(document.draft.structure.atoms.filter(atom=>!hiddenAtomIds.includes(atom.id!)),project,{left:Math.min(start.x,end.x),right:Math.max(start.x,end.x),top:Math.min(start.y,end.y),bottom:Math.max(start.y,end.y)});
    callbacks.onCaptureBox?.(gesture.button===2?atomIds.filter(id=>!ids.includes(id)):[...new Set([...atomIds,...ids])]);
  }else if(!gesture.moved&&(sameViewportPick(gesture.pick,releasePick)||gesture.pick.kind==='none'&&releasePick.kind==='none')){
    if(gesture.pick.kind==='atom'){
      const atomId=gesture.pick.atomId;
      if(gesture.button===0)callbacks.onCapturePick?.(atomId);
      else if(gesture.button===2)callbacks.onCaptureBox?.(atomIds.filter(id=>id!==atomId));
    }else if(gesture.button===0&&gesture.pick.kind==='none')callbacks.onCapturePick?.(null);
    else if(gesture.button===0&&gesture.pick.kind==='bond'&&(request.kind==='B'||request.kind==='coordinate'))callbacks.onCaptureBox?.([...gesture.pick.atomIds],gesture.pick.image?.some(Boolean)?[[0,0,0],[...gesture.pick.image]]:undefined);
    else if(gesture.button===0&&gesture.pick.kind==='coordinate'&&request.kind!=='atoms'){
      const coordinateId=gesture.pick.coordinateId,object=coordinateSelectionObjects(document).find(row=>row.id===coordinateId);
      if(object&&(request.kind==='coordinate'||request.kind===object.type))callbacks.onCaptureBox?.([...object.atomIds],object.images?structuredClone(object.images):undefined);
    }
  }
}
/** Consumes analysis gestures before the read-only/measurement/model routes. */
export function finishAnalysisAtomCapture(
  captured: Pick<AnalysisAtomCapture, 'requestId' | 'ownerId' | 'contextKey'>,
  current: AnalysisAtomCapture | undefined,
  gesture: { kind: 'box' | 'camera' | 'fragment'; button: number; moved: boolean; start: ScreenPoint; end: ScreenPoint; pick: PickResult },
  atoms: Atom[], project: (position: Vector3) => ScreenPoint, releasePick: PickResult,
  coordinateAtoms?: (id:string) => readonly string[] | undefined,
): void {
  if (!analysisCaptureCurrent(captured, current) || gesture.button !== 0) return;
  if (gesture.kind === 'box' && gesture.moved) {
    if(current!.kind==='coordinate')return;
    const { start, end } = gesture;
    current!.onBox(captureBoxAtomIds(atoms, project, { left: Math.min(start.x, end.x), right: Math.max(start.x, end.x), top: Math.min(start.y, end.y), bottom: Math.max(start.y, end.y) }));
  } else if (!gesture.moved && (sameViewportPick(gesture.pick, releasePick) || (gesture.pick.kind === 'none' && releasePick.kind === 'none'))) {
    if (gesture.pick.kind === 'atom') current!.onPick(gesture.pick.atomId);
    else if (gesture.pick.kind === 'none') current!.onPick(null);
    else if (current!.kind === 'coordinate' && gesture.pick.kind === 'bond') current!.onCoordinate?.([...gesture.pick.atomIds]);
    else if (current!.kind === 'coordinate' && gesture.pick.kind === 'coordinate') { const ids=coordinateAtoms?.(gesture.pick.coordinateId);if(ids)current!.onCoordinate?.([...ids]); }
  }
}

export interface ModelViewportProps extends CalculationRangeFeedback {
  previewGuides?: TransformPreviewGuides;
  previewCell?: PeriodicCell;
  hiddenAtomIds?:readonly string[];
  multiframeDisplay?: MultiframeDisplayPlan;
  samplingSphere?: SamplingSphereDisplay;
  document: ModelDocument;
  display: DisplaySettings;
  interaction: InteractionState;
  temporaryPointerMode?: 'select' | 'freeze' | null;
  /** Immediate held-key lease; does not wait for a React state render. */
  getPointerMode?(): PointerMode;
  getDocument?(): ModelDocument;
  selectionShortcut?: string;
  /** Persistent thaw tool only; captured at press time, held F takes priority. */
  freezeRemovalMode?: boolean;
  effectiveFrozenAtomIds?: readonly string[];
  /** Blue material and snowflake IDs only. Never used by drag/edit guards. */
  displayFrozenAtomIds?: readonly string[];
  /** Only validated current-document atom IDs; never inferred from error text. */
  problemAtomIds?: readonly string[];
  problemDiagnostic?: string;
  /** Display only; stable atom IDs (or legacy zero-based indices), Cartesian Å
   * mode directions independent of playback phase. */
  vibrationVectors?: readonly ViewportVibrationVector[];
  /** Transient animation coordinates, with the same atom identities/topology as document. */
  displayAtoms?: Atom[];
  /** Display only; values use the current valid atom range for blue/white/red. */
  atomScalarValues?: readonly ViewportAtomScalarValue[];
  atomScalarColor?: boolean;
  atomScalarLabels?: boolean;
  orbitalLayer?: ViewportOrbitalLayer;
  ntoLayer?: ViewportNtoLayer;
  surfaceLayer?: ViewportSurfaceLayer;
  /** Explicit e/h array takes precedence over the legacy single layer. */
  surfaceLayers?: readonly ViewportSurfaceLayer[];
  surfaceExtrema?: ViewportSurfaceExtrema;
  onSurfaceExtremumHover?(id: string | null): void;
  onSurfaceExtremumPick?(id: string): void;
  /** Read-only opt-in GPU completion proxy; not compositor/monitor timing. */
  renderIdentity?: ViewportRenderIdentity;
  onRenderComplete?: ViewportRenderObserver;
  /** Called only after a current, successful draw actually consumed CIP labels. */
  onCipLabelsUsed?(receipt:CipDisplayUsage&{documentId:string;sourceRevision:string}):void;
  /** Actual adapter CPU mesh/submission state, not compositor completion. */
  onSurfaceMeshState?(state: Readonly<SurfaceMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>): void;
  onSurfaceMeshStates?(states: readonly SurfaceLayerMeshState[], document: Pick<ModelDocument, 'id' | 'revision'>): void;
  onNtoMeshState?(state: Readonly<NtoMeshState>, document: Pick<ModelDocument, 'id' | 'revision'>): void;
  /** Explicit display-only Å arrow, absent/off by default. */
  dipoleVector?: ViewportDipoleVector;
  /** Valid current-geometry GFN2 results supplied by the owning workspace. */
  bondOrderEntries?: readonly BondOrderEntry[];
  /** Read-only continuous numerical results; never converted into topology. */
  resultBondValues?:readonly ViewportResultBondValue[];
  resultBondLabels?:boolean;
  resultBondColor?:boolean;
  resultAtomLabels?:readonly ViewportResultAtomLabel[];
  resultHighlights?:ViewportResultHighlights;
  resultColorbar?:AnalysisColorbar;
  /** Stable Local analysis identity for display-only cross-window changes. */
  resultColorbarOwnerKey?:string;
  onResultColorbarLayoutChange?(layout:AnalysisColorbarLayout):void;
  onResultBondHighlight?(atomIds:[string,string]|null):void;
  stateMarkers?: readonly ViewportStateMarker[];
  onAtomStateChange?: (atomIds: string[], action: AtomStateAction) => void;
  /** One handler/transaction for a mixed F box. Coordinate IDs never expand to
   * atom IDs. If absent, legacy atom-only actions retain their previous route. */
  onObjectStateChange?: (objects:ViewportObjectState,action:AtomStateAction)=>void;
  onStateMarkerDelete?: (marker: ViewportStateMarker) => void;
  onStateMarkerHover?: (marker: ViewportStateMarker | null) => void;
  onObjectDelete?: (pick: Exclude<PickResult, { kind: 'none' }>) => void;
  highlights?: ViewerHighlights;
  /** Last validated dynamics observation; may remain after Stop or an edit. */
  observationReference?: Structure;
  observationEpoch?: string;
  observationFrame?: number;
  observationFixedFrame?: boolean;
  /** Soft display anchors never change editor freezes or edit permissions. */
  observationAnchorAtomIds?: readonly string[];
  /** Owner-computed observation pose, shared with images and detached views. */
  observationTransform?: RigidTransform;
  measurement?: MeasurementState;
  onMeasurementPick?: (atomId: string | null,image?:Vector3) => void;
  onMeasurementBondPick?: (pick:Extract<PickResult,{kind:'bond'}>) => void;
  structureLocked?: boolean;
  observationTool?: 'rotate' | 'pan' | 'select' | 'box';
  /** Only observation selection callbacks are enabled; source editing stays blocked. */
  observationSelection?: boolean;
  resetViewRequest?: number;
  persistentTool?: 'hydrogen' | 'delete' | 'fragment' | null;
  fragmentTool?: { templateId: string; activeAtomIndex?: number };
  captureRequest?: SelectionCaptureRequest;
  analysisAtomCapture?: AnalysisAtomCapture;
  captureAtomIds?: string[];
  onCapturePick?: (atomId: string | null) => void;
  onCaptureBox?: (atomIds: string[], images?:Vector3[]) => void;
  onAtomNumberPick?: (atomId:string) => void;
  numberingPickActive?:boolean;
  linkedAtomsActive?:boolean;
  onMeasurementRecordSelect?: (record: MeasurementRecord) => void;
  onMeasurementRecordWheel?: (record: MeasurementRecord, deltaY: number) => void;
  onMeasurementRecordHover?: (record: MeasurementRecord | null) => void;
  onMeasurementRecordDelete?: (recordId: string) => void;
  cameraRequest?: { serial: number; kind: 'standard' | 'cell' | 'step'; preset?: 'a' | 'a*' | 'b' | 'b*' | 'c' | 'c*'; direction?: 'left' | 'right' | 'up' | 'down' };
  showAxes?: boolean;
  readOnly?: boolean;
  /** Result annotations remain visible while the shared editor owns commands. */
  allowModelEditing?: boolean;
  freezeEditingAllowed?:boolean;
  /** Scientific frame used by gestures; animation geometry is display only. */
  editingDocument?: ModelDocument;
  /** Local verified document lifetime; absent shared/standalone callers rebuild. */
  sceneOwnerEpoch?: string;
  /** Pause transient displays and expose the actual static editing geometry. */
  onBeginModelInteraction?(): ModelDocument | void;
  cellEditorDraft?: CellEditorViewportDraft | null;
  cellGuides?: CellPresentationOptions;
  cellHover?: boolean;
  broadcastCameraDuringGesture?: boolean;
  samplingSphereDraft?:SamplingSphereViewportDraft|null;
  onSamplingSphereRadiusChange?(change:SamplingSphereRadiusChange):void;
  viewTransform?: RigidTransform;
  cameraView?: number[];
  onCameraViewChange?: (view: number[]) => void;
  /** Read-only camera access for isolated image export, never a model command. */
  onViewReady?: (getView: (() => number[]) | null) => void;
  active?: boolean;
  /** Workspace presentation gate, independent of the user's display.legend. */
  legendVisible?: boolean;
  legendExpanded?:boolean;
  onLegendExpandedChange?:(expanded:boolean)=>void;
  onLegendSurfaceChange?:(surface:ReactNode)=>void;
  onHover: (pick: PickResult) => void;
  onGestureStart: (kind: 'box' | 'camera' | 'fragment') => void;
  onGestureEnd: (commit?: boolean) => void;
  onSelection: (selection: ModelSelection) => void;
  onCommand: (command: ModelCommand) => ModelDocument | void;
  onGestureCommand?: (command: Extract<ModelCommand, { type: 'transform-fragment' }>) => ModelDocument;
  /** Workspace-owned cancellation without changing scientific revision/history. */
  fragmentCancelEpoch?: number;
  onError?: (message: string) => void;
}
interface Gesture {
  gestureId?:number;sampleGeneration?:number;
  analysisCapture?: Pick<AnalysisAtomCapture, 'requestId' | 'ownerId' | 'contextKey'>;
  surfaceExtremumId?: string;
  numberingPick?:boolean;
  pointerId: number; kind: 'box' | 'camera' | 'fragment'; button: number;
  start: ScreenPoint; end: ScreenPoint; moved: boolean; view: number[];
  documentId: string; revision: number; pick: PickResult; element: string | null;
  source: Atom[]; atomIds: string[]; plane?: DragPlane; pivot?: Vector3;
  unwrapPeriodic?:boolean;
  previewSource?: FragmentPreviewSource;
  previewAtoms?: Atom[];
  previewIndices?: ReadonlyMap<string,number>;
  overlayBaseline?: {
    markers: ReturnType<typeof projectStateMarkers>;
    captures: ReturnType<typeof projectCaptureMarkers>;
    badges: ReturnType<typeof projectAssignmentBadges>;
    problems: ReturnType<typeof projectProblemAtomMarkers>;
  };
  command?: Extract<ModelCommand, { type: 'transform-fragment' }>;
  cameraMode?: 'rotate' | 'pan';
  captureRequestId?: string;
  persistentTool?: ModelViewportProps['persistentTool'];
  fragmentTool?: ModelViewportProps['fragmentTool'];
  stateAction?: AtomStateAction;
  contextDelete?: boolean;
}
const DRAG_THRESHOLD = 4;
const EMPTY: ViewerHighlights = {};
export interface ViewportFailure { kind: 'projection' | 'interaction' | 'fatal'; message: string }
export function viewportEmptyHint(readOnly?:boolean):string {
  return readOnly?'导入结构或计算结果以查看三维模型':'选择元素后点击空白添加原子，或导入结构';
}
export function viewportEditingBlocked(props: Pick<ModelViewportProps,'readOnly'|'allowModelEditing'|'viewTransform'|'multiframeDisplay'>): boolean {
  return !props.allowModelEditing&&Boolean(props.readOnly || props.viewTransform || props.multiframeDisplay);
}
export function observationSelectionGesture(props:Pick<ModelViewportProps,'readOnly'|'observationSelection'|'interaction'>,mode:'select'|'freeze'|null,button:number):boolean {
  return Boolean(props.readOnly&&props.observationSelection&&(mode==='select'||props.interaction.box)&&[0,2].includes(button));
}
export function recoverViewportProjectionFailure(failure: ViewportFailure | null, projectionHealthy: boolean): ViewportFailure | null {
  return projectionHealthy && failure?.kind === 'projection' ? null : failure;
}
interface BondRope { pointerId: number; documentId: string; revision: number; atomId: string; start: ScreenPoint; pointerStart: ScreenPoint; end: ScreenPoint; targetAtomId: string | null; moved: boolean }
type PointerMoveSample = Pick<ReactPointerEvent<HTMLDivElement>, 'pointerId' | 'clientX' | 'clientY'> & { currentTarget: HTMLDivElement };

/** Per-view lifetime latch: undefined keeps the existing enabled-view default. */
export function viewportInitializationRequested(requested: boolean, active?: boolean): boolean {
  return requested || active !== false;
}
export function successfulFirstPointerPlacement(before: ModelDocument, after: ModelDocument | void, command: ModelCommand): after is ModelDocument {
  return ['place-element', 'place-fragment'].includes(command.type) && before.draft.structure.atoms.length === 0 && Boolean(after && after.id === before.id && after.revision > before.revision && after.draft.structure.atoms.length > 0);
}
export function FreezeStateIcon({inactive=false}:{inactive?:boolean}={}) { return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={inactive?'#d59e1f':FREEZE_COLOR} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{FREEZE_ICON_PATHS.map(path=><path key={path} d={path}/>)}</svg>; }

export function visibleViewportAssignmentRegions(document: ModelDocument, display: DisplaySettings): AssignmentDisplayRegion[] {
  return projectAssignmentDisplay(document.draft.assignments, document.draft.structure.atoms).filter(region => region.atomIds.length && (display.regionLabels || display.colorMode === region.category));
}
/** Selection resolves a real assignment in the current document. A stale or
 * partially invalid membership cannot quietly select a different atom set. */
export function viewportAssignmentSelection(document: ModelDocument, region: AssignmentDisplayRegion): ModelSelection | null {
  const rows = document.draft.assignments[region.category].filter(row => row.id === region.id);
  if (rows.length !== 1) return null;
  const atomIds = rows[0].atomIds, known = new Set(document.draft.structure.atoms.map(atom => atom.id));
  if (!atomIds.length || new Set(atomIds).size !== atomIds.length || atomIds.some(id => !known.has(id)) || atomIds.length !== region.atomIds.length || atomIds.some(id => !region.atomIds.includes(id))) return null;
  return { atomIds: [...atomIds], bonds: [], auxiliaryIds: [], portIds: [], coordinateIds: [] };
}
export function viewportCaptureFeedback(document: ModelDocument, request?: SelectionCaptureRequest, problemAtomIds?: readonly string[], resultDisplay?: Pick<RenderFeedbackOptions, 'vibrationVectors' | 'atomScalarValues' | 'atomScalarColor' | 'atomScalarLabels' | 'linkedAtomsActive' | 'dipoleVector'>): RenderFeedbackOptions {
  return { problemAtomIds, ...(request?.documentId === document.id ? { capturePurpose: request.purpose } : {}), ...(resultDisplay?.vibrationVectors ? { vibrationVectors: resultDisplay.vibrationVectors } : {}), ...(resultDisplay?.atomScalarValues ? { atomScalarValues: resultDisplay.atomScalarValues } : {}), ...(resultDisplay?.atomScalarColor !== undefined ? { atomScalarColor: resultDisplay.atomScalarColor } : {}), ...(resultDisplay?.atomScalarLabels !== undefined ? { atomScalarLabels: resultDisplay.atomScalarLabels } : {}), ...(resultDisplay?.dipoleVector ? { dipoleVector: resultDisplay.dipoleVector } : {}),...(resultDisplay?.linkedAtomsActive?{linkedAtomsActive:true}:{}) };
}
/** Only atoms producing a visible assignment badge need screen projection.
 * Empty/default regions therefore perform zero native/DOM projections. */
export function projectViewportAssignmentBadges(regions: readonly AssignmentDisplayRegion[], atoms: readonly Atom[], project: (position: Vector3) => ScreenPoint, offset: ScreenPoint) {
  const ids = new Set(regions.flatMap(region => [...region.atomIds]));
  return projectAssignmentBadges(regions, atoms.flatMap(atom => {
    if (!atom.id || !ids.has(atom.id)) return [];
    const screen = project(coordinates(atom));
    return [{ atomId: atom.id, x: screen.x - offset.x, y: screen.y - offset.y }];
  }));
}
/** Native centroid labels are replaced by interactive atom-attached badges;
 * the user's saved display preference itself is never rewritten. */
export function viewportRenderDisplay(display: DisplaySettings): DisplaySettings { return display.regionLabels ? { ...display, regionLabels: false } : display; }

/** Prepared frames share their raw atom array. Connectivity can still arrive
 * later at the same revision, so it needs its own constant-time identity. */
export function viewportConnectivityStamp(structure:Pick<Structure,'bonds'|'bondPerceptionIssues'>,stamps:WeakMap<object,number>,next:()=>number):readonly [number,number] {
  const stamp=(value:object|undefined)=>{if(!value)return 0;let id=stamps.get(value);if(id===undefined){id=next();stamps.set(value,id);}return id;};
  return [stamp(structure.bonds),stamp(structure.bondPerceptionIssues)];
}

export function projectProblemAtomMarkers(atoms: readonly Atom[], atomIds: readonly string[], project: (position: Vector3) => ScreenPoint, offset: ScreenPoint): { atomId: string; x: number; y: number }[] {
  const known = new Map(atoms.filter(atom => atom.id).map(atom => [atom.id!, atom]));
  return [...new Set(atomIds)].flatMap(atomId => {
    const atom = known.get(atomId); if (!atom) return [];
    const screen = project(coordinates(atom));
    if (![screen.x, screen.y].every(Number.isFinite)) return [];
    // Lower-right lane stays separate from the blue snowflake above the atom.
    return [{ atomId, x: screen.x - offset.x + 15, y: screen.y - offset.y + 15 }];
  });
}

export default function ModelViewport(props: ModelViewportProps) {
  // Multi-frame geometry is a read-only observation, not a modeling selection.
  if (props.multiframeDisplay && !props.readOnly) props = { ...props, readOnly: true };
  const latest = useRef(props); latest.current = props;
  const container = useRef<HTMLDivElement>(null), hitSurface = useRef<HTMLDivElement>(null), adapter = useRef<RenderAdapter | null>(null);
  const viewportElement = useRef<HTMLElement>(null);
  const [narrowLegend, setNarrowLegend] = useState(false);
  const gesture = useRef<Gesture | null>(null), preview = useRef<Atom[] | undefined>(undefined);
  const analysisBoxHeld = useRef(false);
  const [moveScheduler] = useState(() => createLatestMoveScheduler<PointerMoveSample>(callback => window.requestAnimationFrame(callback), id => window.cancelAnimationFrame(id), sample => applyMove(sample)));
  const lastDraw = useRef<string | null>(null), lastProjectionView = useRef<string | null>(null);
  const asynchronousDraw=useRef<{signature:string;controller:AbortController}|null>(null);
  const renderSerial=useRef(0);
  const lastResultProjectionInputs=useRef<ResultProjectionInputs|null>(null);
  const resultProjectionOwner=useRef<{documentId:string;revision:number;highlights:ModelViewportProps['resultHighlights']}|null>(null);
  const previewStamps = useRef(new WeakMap<object, number>()), previewSerial = useRef(0);
  const multiframeStamps = useRef(new WeakMap<MultiframeDisplayPlan, number>());
  const bondRope = useRef<BondRope | null>(null);
  const overlayPress = useRef<{ id: string; pointerId: number; button: number; start: ScreenPoint; documentId: string; revision: number; moved: boolean; pointerMode: 'select' | 'freeze' | null; freezeRemoval?: boolean; marker?: ViewportStateMarker; modeGestureStarted?: boolean } | null>(null);
  const overlayClick = useRef<{ id: string; allowed: boolean } | null>(null);
  const [ropeDrawing, setRopeDrawing] = useState<BondRope | null>(null);
  const alignment = useRef(emptyObservationView());
  const hoverScreen = useRef<ScreenPoint | null>(null);
  const [ready, setReady] = useState(false), [failure, setFailure] = useState<ViewportFailure | null>(null);
  const [cipWarning,setCipWarning]=useState<(CipLabelWarning&{documentId:string;atoms:Atom[]})|null>(null),dismissedCipWarnings=useRef(new Set<string>());
  const [overlayTick,setOverlayTick]=useState(0);
  const failureRef = useRef<ViewportFailure | null>(null);
  const [initializationRequested, setInitializationRequested] = useState(() => viewportInitializationRequested(false, props.active));
  const projectionCounters=useRef<ProjectionCounters>({attempts:0,commits:0,plans:0});
  const projectionPlans=useRef(createProjectionPlanCache(projectionCounters.current));
  const [cursor, setCursor] = useProjectedState<ScreenPoint | null>(null,projectionCounters.current), [box, setBox] = useState<{ start: ScreenPoint; end: ScreenPoint } | null>(null);
  const [moving, setMoving] = useState<'camera' | 'fragment' | 'box' | null>(null);
  const [recordLabels, setRecordLabels] = useProjectedState<(MeasurementLabel&{analysis?:boolean})[]>([],projectionCounters.current);
  const [transientLabel, setTransientLabel] = useProjectedState<MeasurementLabel | null>(null,projectionCounters.current);
  const [captureMarkers, setCaptureMarkers] = useProjectedState<ReturnType<typeof projectCaptureMarkers>>([],projectionCounters.current);
  const [axes, setAxes] = useProjectedState<PhysicalAxisProjection[]>([],projectionCounters.current);
  const [stateMarkerLabels, setStateMarkerLabels] = useProjectedState<ReturnType<typeof projectStateMarkers>>([],projectionCounters.current);
  const [problemMarkers, setProblemMarkers] = useProjectedState<ReturnType<typeof projectProblemAtomMarkers>>([],projectionCounters.current);
  const [assignmentBadges, setAssignmentBadges] = useProjectedState<ReturnType<typeof projectAssignmentBadges>>([],projectionCounters.current);
  const [resultBondLabels,setResultBondLabels]=useProjectedState<{documentId:string;revision:number;values:ModelViewportProps['resultBondValues'];rows:ReturnType<typeof projectResultBondLabels>}>({documentId:'',revision:-1,values:undefined,rows:[]},projectionCounters.current);
  const [resultAtomLabels,setResultAtomLabels]=useProjectedState<{documentId:string;revision:number;values:ModelViewportProps['resultAtomLabels'];rows:ReturnType<typeof projectResultAtomLabels>}>({documentId:'',revision:-1,values:undefined,rows:[]},projectionCounters.current);
  const [resultBondColors,setResultBondColors]=useProjectedState<ReturnType<typeof projectResultBondColors>>([],projectionCounters.current);
  const [surfaceLabels,setSurfaceLabels]=useProjectedState<{layer:ModelViewportProps['surfaceExtrema'];items:ResultLabelItem[]}>({layer:undefined,items:[]},projectionCounters.current);
  const hoveredSurfacePoint=useRef<string|null>(null);
  const [hoverAtomLabel, setHoverAtomLabel] = useProjectedState<{ label: string; atomId?: string; x: number; y: number; bond?: boolean; bondPick?: Extract<PickResult,{kind:'bond'}>;auxiliaryId?:string } | null>(null,projectionCounters.current);
  const handledCameraRequest = useRef<number | null>(null);
  const { document: model, display, interaction, highlights = EMPTY } = props;
  const resultPresentation=useMemo(()=>resultSelectionPresentation(model.draft.structure,props.resultHighlights),[model.draft.structure,props.resultHighlights]);
  const captureDisplay = captureViewportDisplay(display, props.captureRequest);
  const pointerMode = (p: ModelViewportProps) => {const mode=p.getPointerMode ? p.getPointerMode() : p.temporaryPointerMode ?? null;return mode==='freeze'&&p.freezeEditingAllowed===false?null:mode;};
  const assignmentActivation = useRef({ documentId: model.id, active: props.active !== false, epoch: 0 });
  if (assignmentActivation.current.documentId !== model.id || assignmentActivation.current.active !== (props.active !== false)) assignmentActivation.current = { documentId: model.id, active: props.active !== false, epoch: assignmentActivation.current.epoch + 1 };
  const assignmentRegions = useMemo(() => projectAssignmentDisplay(model.draft.assignments, model.draft.structure.atoms), [model.draft.assignments, model.draft.structure.atoms]);
  const bondOrders = useMemo(() => indexHoverBondOrders(props.bondOrderEntries), [props.bondOrderEntries]);
  useEffect(() => {
    const node = viewportElement.current; if (!node) return;
    const update = () => { const width = node.getBoundingClientRect().width; if (width > 0) setNarrowLegend(width < 300); };
    update(); const Observer = node.ownerDocument.defaultView?.ResizeObserver; if (!Observer) return;
    const observer = new Observer(update); observer.observe(node); return () => observer.disconnect();
  }, []);
  function replaceFailure(value: ViewportFailure | null) { failureRef.current = value; setFailure(value); }
  function observeRenderCounters(submitted=false) {
    const node = container.current;if(!node)return;
    const counters=adapter.current?.diagnostics?.(),target=viewportElement.current??node;
    if(submitted)renderSerial.current++;target.dataset.renderSerial=String(renderSerial.current);target.dataset.renderRevision=String(latest.current.document.revision);
    for(const key of RENDER_DIAGNOSTIC_KEYS)target.dataset['renderer'+key[0].toUpperCase()+key.slice(1)]=counters?String(counters[key]??''):key.startsWith('gpu')?'':'0';
  }
  function observeSurfaceMesh(submitted=false) {
    const node = container.current, state = adapter.current?.surfaceMeshState?.(); if (!node) return;
    observeRenderCounters(submitted);
    const states = adapter.current?.surfaceMeshStates?.() ?? [];
    node.dataset.surfaceMeshLayers = JSON.stringify(states);
    latest.current.onSurfaceMeshStates?.(states, latest.current.document);
    const ntoState = adapter.current?.ntoMeshState?.();
    node.dataset.ntoMeshState = ntoState?.status ?? 'empty';
    node.dataset.ntoMesh = JSON.stringify(ntoState ?? null);
    if (ntoState) latest.current.onNtoMeshState?.(ntoState, latest.current.document);
    if (!state) {
      for (const key of Object.keys(node.dataset)) if (key.startsWith('surfaceMesh')) delete node.dataset[key];
      node.dataset.surfaceMeshState = 'empty'; return;
    }
    node.dataset.surfaceMeshState = state.status; node.dataset.surfaceMeshKey = state.attemptKey ?? '';
    node.dataset.surfaceMeshCommittedKey = state.committedKey ?? ''; node.dataset.surfaceMeshSourceId = state.sourceId ?? '';
    node.dataset.surfaceMeshSourceRevision = state.sourceRevision ?? ''; node.dataset.surfaceMeshShapeId = state.shapeId ?? '';
    node.dataset.surfaceMeshMappingId = state.mappingId ?? ''; node.dataset.surfaceMeshShapes = String(state.shapeCount);
    node.dataset.surfaceMeshVertices = String(state.vertexCount); node.dataset.surfaceMeshTriangles = String(state.triangleCount);
    node.dataset.surfaceMeshColored = String(state.colored); node.dataset.surfaceMeshError = state.error ?? '';
    node.dataset.surfaceMeshSubmitted = String(state.submitted);
    latest.current.onSurfaceMeshState?.(state, latest.current.document);
  }
  function report(error: unknown, fatal = false) {
    observeSurfaceMesh();
    const message = error instanceof Error ? error.message : String(error);
    if (fatal) { replaceFailure({ kind: 'fatal', message }); return; }
    if (error instanceof ViewportProjectionError) {
      // Hidden owners are intentionally retained. Their missing presentation
      // size is not a user operation or an invented scientific coordinate.
      const bounds = container.current?.getBoundingClientRect();
      if (error.code === 'viewport-unavailable' && (!bounds || bounds.width <= 0 || bounds.height <= 0)) return;
      if (failureRef.current?.kind !== 'fatal') replaceFailure({ kind: 'projection', message });
    } else if (latest.current.onError) latest.current.onError(message);
    else if (failureRef.current?.kind !== 'fatal') replaceFailure({ kind: 'interaction', message });
  }
  function recoverProjection(knownHealthy = false) {
    if (failureRef.current?.kind !== 'projection') return;
    const recovered = recoverViewportProjectionFailure(failureRef.current, knownHealthy || Boolean(adapter.current?.projectionReady()));
    if (recovered !== failureRef.current) replaceFailure(recovered);
  }
  function updateHover(screen: ScreenPoint | null) {
    if (latest.current.active === false) screen=null;
    hoverScreen.current = screen;
    const surfacePoint=screen&&!latest.current.analysisAtomCapture?adapter.current?.surfaceExtremumAt?.(screen)??null:null;
    if(surfacePoint!==hoveredSurfacePoint.current){hoveredSurfacePoint.current=surfacePoint;latest.current.onSurfaceExtremumHover?.(surfacePoint);}
    if(surfacePoint){adapter.current?.hover({kind:'none'});latest.current.onHover({kind:'none'});setHoverAtomLabel(null);return;}
    const pick = screen && adapter.current ? adapter.current.hitTest(screen) : { kind: 'none' as const };
    adapter.current?.hover(pick); latest.current.onHover(pick);
    const atomIndex = pick.kind === 'atom' ? latest.current.document.draft.structure.atoms.findIndex(atom => atom.id === pick.atomId) : -1;
    const bounds = hitSurface.current?.getBoundingClientRect();
    const pairPick=measurementConnectionPair(latest.current.document,pick),bondLength = pairPick?hoverBondLength(latest.current.document.draft.structure,pairPick):null;
    setHoverAtomLabel(screen && bounds && (atomIndex >= 0 || bondLength) ? { label: bondLength ?? `${latest.current.document.draft.structure.atoms[atomIndex].element}${atomIndex + 1}`, ...(pick.kind === 'atom' ? { atomId: pick.atomId } : {}), x: screen.x - bounds.left, y: screen.y - bounds.top - 24, ...(bondLength&&pairPick?{bond:true,bondPick:pairPick,...pick.kind==='auxiliary'?{auxiliaryId:pick.relationId}:{}}:{}) } : null);
    if (screen) recoverProjection();
  }
  function refreshProjection(previewAtoms?: Atom[], documentOverride?: ModelDocument) {
    if(adapter.current?.presentationReady?.()===false)return;
    if(latest.current.cellEditorDraft||latest.current.samplingSphereDraft)setOverlayTick(value=>value+1);
    const instance = adapter.current, surface = hitSurface.current;
    if (!instance || !surface || latest.current.active === false) return;
    const viewportBounds = container.current?.getBoundingClientRect();
    if (!viewportBounds || viewportBounds.width <= 0 || viewportBounds.height <= 0) return;
    const p = { ...latest.current, document: documentOverride ?? latest.current.document }, bounds = surface.getBoundingClientRect(), offset = { x: bounds.left, y: bounds.top };
    const atoms = previewAtoms ?? p.document.draft.structure.atoms;
    const plan=projectionPlans.current.read([p.document,p.display,p.measurement,p.resultHighlights,p.captureRequest,p.captureAtomIds,p.analysisAtomCapture,p.hiddenAtomIds,p.stateMarkers,p.effectiveFrozenAtomIds,p.displayFrozenAtomIds,p.problemAtomIds,p.resultBondValues,p.resultAtomLabels,p.readOnly,p.resultBondLabels,p.resultBondColor,p.highlights],()=>{
      const hidden=new Set(p.hiddenAtomIds),visible=(ids:readonly string[])=>ids.every(id=>!hidden.has(id));
      const rawAnalysis=resultSelectionPresentation(p.document.draft.structure,p.resultHighlights),analysis={...rawAnalysis,records:rawAnalysis.records.filter(row=>visible(row.atomIds)),markers:rawAnalysis.markers.filter(row=>visible(row.atomIds))};
      const state=p.measurement,count=state?.atomIds.length??0;
      const pending=state&&state.mode&&count>=2&&count<=4?{id:'transient-auto',mode:state.mode==='auto'?count===2?'distance' as const:count===3?'angle' as const:'dihedral' as const:state.mode,atomIds:state.atomIds,...(state.images?{images:state.images}:{}),color:'#277fdf'}:null;
      const capture=captureSelectionPresentation(p.document,p.analysisAtomCapture?analysisCaptureCurrent(p.analysisAtomCapture,p.analysisAtomCapture)?p.analysisAtomCapture.atomIds:[]:p.captureRequest?p.captureRequest.documentId===p.document.id&&p.captureRequest.revision===p.document.revision?p.captureAtomIds??[]:[]:undefined);
      const h=modelHighlights(p.document,p.highlights,p.displayFrozenAtomIds);
      const markers:ViewportStateMarker[]=[
      ...analysis.markers,
      ...p.document.selection.atomIds.filter(atomId => !capture.atomIds.includes(atomId)&&!p.stateMarkers?.some(marker => marker.kind === 'selection' && marker.atomIds.includes(atomId))).map(atomId => ({ id: `selection:${atomId}`, kind: 'selection' as const, atomIds: [atomId], label: '取消选区' })),
      ...coordinateSelectionObjects(p.document).filter(object=>p.document.selection.coordinateIds?.includes(object.id)).map(object=>({id:`selection-coordinate:${object.id}`,kind:'selection' as const,coordinateId:object.id,atomIds:object.atomIds,label:'取消内坐标选区'})),
      ...(p.stateMarkers ?? [
        ...(p.displayFrozenAtomIds ?? p.effectiveFrozenAtomIds ?? getFrozenAtomIds(p.document)).map(atomId => ({ id: `freeze:${atomId}`, kind: 'freeze' as const, atomIds: [atomId], removable:p.displayFrozenAtomIds===undefined, label: p.displayFrozenAtomIds===undefined?'解除原子冻结':'保护核心' })),
        ...(h.frozenCoordinates ?? []).map(coordinate => ({ id: `freeze-coordinate:${coordinate.id}`, coordinateId: coordinate.id, kind: 'freeze' as const, atomIds: coordinate.atoms.map(i => atoms[i]?.id ?? ''), label: `解除${coordinate.type}冻结` })),
        ...(h.scan ?? []).map(coordinate => ({ id: `scan:${coordinate.id}`, coordinateId: coordinate.id, kind: 'scan' as const, atomIds: coordinate.atoms.map(i => atoms[i]?.id ?? ''), label: `移除${coordinate.type}扫描` })),
      ]),
      ].filter(marker=>marker.kind==='selection'||(marker.kind==='freeze'?p.display.frozenMarks:p.display.scanMarks));
      return {hidden,analysis,records:p.display.measurementMarks?(state?.records??[]).filter(row=>visible(row.atomIds)):[],transient:p.display.measurementMarks&&pending&&visible(pending.atomIds)?pending:null,
        orderedIds:p.analysisAtomCapture?.kind==='coordinate'?capture.atomIds:p.captureRequest&&p.captureRequest.kind!=='atoms'?capture.atomIds:[],
        regions:visibleViewportAssignmentRegions(p.document,captureViewportDisplay(p.display,p.captureRequest)).filter(region=>region.atomIds.some(id=>!hidden.has(id))),
        markers:captureVisibleStateMarkers(markers,capture).filter(row=>visible(row.atomIds)),problemIds:(p.problemAtomIds??[]).filter(id=>!hidden.has(id)),
        bondLabels:p.readOnly&&p.resultBondLabels?(p.resultBondValues??[]).filter(row=>visible(row.atomIds)&&!analysis.records.some(record=>record.atomIds.every(id=>row.atomIds.includes(id)))):[],
        bondColors:p.readOnly&&p.resultBondColor?(p.resultBondValues??[]).filter(row=>visible(row.atomIds)):[],atomLabels:p.readOnly?(p.resultAtomLabels??[]).filter(row=>!hidden.has(row.atomId)):[]};
    });
    resultProjectionOwner.current={documentId:p.document.id,revision:p.document.revision,highlights:p.resultHighlights};
    setRecordLabels([...(plan.records.length?projectMeasurementLabels(atoms,plan.records,instance.project,offset,p.document.draft.structure):[]),...(plan.analysis.records.length?projectResultMeasurementLabels({...p.document.draft.structure,atoms},plan.analysis.records,instance.project,offset):[])]);
    setTransientLabel(plan.transient?projectMeasurementLabels(atoms,[plan.transient],instance.project,offset,p.document.draft.structure)[0]??null:null);
    setCaptureMarkers(plan.orderedIds.length?projectCaptureMarkers(atoms.filter(atom=>!plan.hidden.has(atom.id!)),plan.orderedIds,instance.project,offset):[]);
    setAssignmentBadges(plan.regions.length?projectViewportAssignmentBadges(plan.regions,atoms,instance.project,offset).filter(row=>!plan.hidden.has(row.atomId)):[]);
    setStateMarkerLabels(plan.markers.length?projectStateMarkers(atoms,plan.markers,instance.project,offset,p.document.draft.structure):[]);
    setProblemMarkers(plan.problemIds.length?projectProblemAtomMarkers(atoms,plan.problemIds,instance.project,offset):[]);
    setAxes(p.showAxes ? instance.axes() : []);
    setResultBondLabels({documentId:p.document.id,revision:p.document.revision,values:p.resultBondValues,rows:plan.bondLabels.length?projectResultBondLabels(p.document.draft.structure,plan.bondLabels,instance.project,offset):[]});
    setResultBondColors(plan.bondColors.length?projectResultBondColors(p.document.draft.structure,plan.bondColors,instance.project,offset):[]);
    setResultAtomLabels({documentId:p.document.id,revision:p.document.revision,values:p.resultAtomLabels,rows:plan.atomLabels.length?projectResultAtomLabels(p.document.draft.structure,plan.atomLabels,instance.project,offset):[]});
    setSurfaceLabels({layer:p.surfaceExtrema,items:p.surfaceExtrema?.visible?projectSurfaceExtremaLabels(p.surfaceExtrema,p.document,instance.project,offset,p.display.fontSize):[]});
    const stats=projectionCounters.current,node=viewportElement.current;if(node){node.dataset.overlayProjectionPlans=String(stats.plans);node.dataset.overlayStateAttempts=String(stats.attempts);node.dataset.overlayStateCommits=String(stats.commits);}
  }
  /** Reproject only the moving overlay members; their static rows retain identity. */
  function refreshFragmentProjection(current:Gesture, atoms:Atom[]) {
    const instance=adapter.current,surface=hitSurface.current,baseline=current.overlayBaseline;
    if(!instance||!surface||!baseline||!current.previewAtoms||!current.previewIndices)return;
    const bounds=surface.getBoundingClientRect(),offset={x:bounds.left,y:bounds.top},ids=new Set(current.atomIds);
    const affected=baseline.markers.filter(marker=>marker.atomIds.some(id=>ids.has(id)));
    const simple=affected.filter(marker=>!marker.coordinateId);
    const coordinateMarkers=affected.filter(marker=>Boolean(marker.coordinateId));
    const markerRows=[...projectStateMarkers(atoms,simple,instance.project,offset),...(coordinateMarkers.length?projectStateMarkers(current.previewAtoms,coordinateMarkers,instance.project,offset,latest.current.document.draft.structure):[])];
    const markers=new Map(markerRows.map(marker=>[marker.id,marker]));
    if(affected.length)setStateMarkerLabels(baseline.markers.map(marker=>markers.get(marker.id)??marker));
    const moved=new Map(atoms.map(atom=>[atom.id!,atom]));
    const displacement=new Map<string,ScreenPoint>();
    for(const atom of atoms){const index=current.previewIndices.get(atom.id!)!,before=instance.project(coordinates(current.source[index])),after=instance.project(coordinates(atom));displacement.set(atom.id!,{x:after.x-before.x,y:after.y-before.y});}
    function attached<T extends {atomId:string;x:number;y:number}>(rows:T[]):T[]{return rows.map(row=>{const delta=displacement.get(row.atomId);return delta?{...row,x:row.x+delta.x,y:row.y+delta.y}:row;});}
    if(baseline.captures.some(row=>moved.has(row.atomId)))setCaptureMarkers(attached(baseline.captures));
    if(baseline.badges.some(row=>moved.has(row.atomId)))setAssignmentBadges(attached(baseline.badges));
    if(baseline.problems.some(row=>moved.has(row.atomId)))setProblemMarkers(attached(baseline.problems));
    const p=latest.current,records=p.display.measurementMarks?(p.measurement?.records??[]).filter(record=>record.atomIds.some(id=>ids.has(id))):[];
    if(records.length){const next=new Map(projectMeasurementLabels(current.previewAtoms,records,instance.project,offset,p.document.draft.structure).map(row=>[row.record.id,row]));setRecordLabels(previous=>previous.map(row=>next.get(row.record.id)??row));}
    const state=p.measurement,count=state?.atomIds.length??0;
    if(p.display.measurementMarks&&state?.mode&&count>=2&&count<=4&&state.atomIds.some(id=>ids.has(id))){
      const record:MeasurementRecord={id:'transient-auto',mode:state.mode==='auto'?count===2?'distance':count===3?'angle':'dihedral':state.mode,atomIds:state.atomIds,images:state.images,color:'#277fdf'};
      setTransientLabel(projectMeasurementLabels(current.previewAtoms,[record],instance.project,offset,p.document.draft.structure)[0]??null);
    }
  }
  function finishRope(commit: boolean, event?: ReactPointerEvent<HTMLDivElement>) {
    const current = bondRope.current; if (!current) return;
    bondRope.current = null; setRopeDrawing(null);
    const surface = hitSurface.current;
    if (surface?.hasPointerCapture(current.pointerId)) surface.releasePointerCapture(current.pointerId);
    const p = latest.current;
    if (commit && !viewportEditingBlocked(p) && !pointerMode(p) && p.active !== false && adapter.current) {
      const pick = event ? adapter.current.hitTest({ x: event.clientX, y: event.clientY }) : null;
      const moved = current.moved || Boolean(event && Math.hypot(event.clientX - current.pointerStart.x, event.clientY - current.pointerStart.y) >= DRAG_THRESHOLD);
      const command = moved ? controlDragBondCommand(p.document, current, pick?.kind === 'atom' ? pick.atomId : null, Boolean(p.structureLocked)) : null;
      if (command) try { p.onCommand(command); } catch (error) { report(error); }
    }
    updateHover(null);
    p.onGestureEnd(commit && current.moved && current.documentId === p.document.id && current.revision === p.document.revision);
  }
  function applyAtomState(atomIds: string[], action: AtomStateAction) {
    const p = latest.current;
    if(p.freezeEditingAllowed===false&&(action==='freeze'||action==='unfreeze'))return;
    if (p.onAtomStateChange) p.onAtomStateChange(atomIds, action);
    else if (action === 'select-add' || action === 'select-remove') p.onSelection(selectionWithAtomState(p.document.selection, atomIds, action));
  }
  function selectAssignmentRegion(region: AssignmentDisplayRegion) {
    const p = latest.current;
    if (p.active === false || viewportEditingBlocked(p) || p.captureRequest || p.analysisAtomCapture || p.structureLocked || p.temporaryPointerMode || p.interaction.box || gesture.current || bondRope.current) return;
    const selection = viewportAssignmentSelection(p.document, region);
    if (!selection) return;
    try { updateHover(null); p.onSelection(selection); } catch (error) { report(error); }
  }
  function applyObjectState(objects:ViewportObjectState,action:AtomStateAction){
    const p=latest.current;
    if(p.freezeEditingAllowed===false&&(action==='freeze'||action==='unfreeze'))return;
    if(!objects.atomIds.length&&!objects.coordinateIds.length)return;
    if(action==='select-add'||action==='select-remove'){
      p.onSelection(selectionWithCoordinateState(selectionWithAtomState(p.document.selection,objects.atomIds,action),objects.coordinateIds,action));return;
    }
    if(p.onObjectStateChange)p.onObjectStateChange(objects,action);
    else if(!objects.coordinateIds.length)applyAtomState(objects.atomIds,action);
    else throw new Error('内坐标对象冻结操作未连接；未改变原子或内坐标状态。');
  }
  /** Absolute screen anchors; rendering below uses the same projection minus
   * surface offset. Only persistent/task objects may participate, never auto. */
  function selectableCoordinateLabels():MeasurementLabel[]{
    const p=latest.current;if(!adapter.current||!p.display.measurementMarks)return [];
    const known=new Set(coordinateSelectionObjects(p.document).map(object=>object.id));
    return projectMeasurementLabels(p.document.draft.structure.atoms,(p.measurement?.records??[]).filter(record=>known.has(record.id)),adapter.current.project,{x:0,y:0},p.document.draft.structure);
  }
  function removeStateMarker(marker:ViewportStateMarker){
    const p=latest.current;if(p.captureRequest||p.analysisAtomCapture||marker.removable===false)return;
    if(p.freezeEditingAllowed===false&&marker.kind!=='selection')return;
    if(marker.kind==='selection'&&marker.coordinateId!==undefined)applyObjectState(stateMarkerObjects(marker),'select-remove');
    else if(p.onStateMarkerDelete)p.onStateMarkerDelete(marker);
    else if(marker.kind==='selection')applyAtomState([...marker.atomIds],'select-remove');
    else if(marker.kind==='freeze'&&!marker.coordinateId)applyAtomState([...marker.atomIds],'unfreeze');
  }
  function beginOverlayPress(event: ReactPointerEvent<HTMLButtonElement>, id: string, marker?: ViewportStateMarker) {
    // Middle gestures belong to the viewport even when started on a selected marker.
    if (event.button === 1) return;
    if(latest.current.analysisAtomCapture){event.stopPropagation();return;}
    event.stopPropagation();
    overlayClick.current = null;
    if (event.button !== 0 && event.button !== 2) return;
    const p = latest.current;
    overlayPress.current = { id, pointerId: event.pointerId, button: event.button, start: { x: event.clientX, y: event.clientY }, documentId: p.document.id, revision: p.document.revision, moved: false, pointerMode: p.captureRequest?null:pointerMode(p) ?? (p.interaction.box ? 'select' : null), freezeRemoval: p.freezeRemovalMode, marker: marker && { ...marker, atomIds: [...marker.atomIds] } };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (overlayPress.current.pointerMode && !viewportEditingBlocked(p) && !p.structureLocked && p.active !== false) { overlayPress.current.modeGestureStarted = true; p.onGestureStart('box'); }
  }
  function cancelOverlayPress() { const press = overlayPress.current; overlayPress.current = null; if (press) overlayClick.current = { id: press.id, allowed: false }; if (press?.modeGestureStarted) latest.current.onGestureEnd(false); }
  function consumeOverlayClick(id: string, detail: number) {
    const own = overlayClick.current; overlayClick.current = null;
    return detail === 0 || !own || own.id !== id || own.allowed;
  }
  function moveOverlayPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if(latest.current.analysisAtomCapture)return;
    event.stopPropagation(); const press = overlayPress.current;
    if (press?.pointerId === event.pointerId) press.moved ||= Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) >= DRAG_THRESHOLD;
  }
  function endOverlayPress(event: ReactPointerEvent<HTMLButtonElement>, id: string, remove: () => void) {
    if(latest.current.analysisAtomCapture)return;
    event.stopPropagation(); const press = overlayPress.current; overlayPress.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const p = latest.current;
    if (press?.modeGestureStarted) p.onGestureEnd(false);
    const valid = Boolean(press && press.id === id && press.pointerId === event.pointerId && press.documentId === p.document.id && press.revision === p.document.revision && p.active !== false && !viewportEditingBlocked(p) && !p.analysisAtomCapture && !p.structureLocked && !bondRope.current && !gesture.current);
    const moved = Boolean(press && (press.moved || Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y) >= DRAG_THRESHOLD));
    overlayClick.current = { id, allowed: overlayClickAllowed(press ? { pointerMode: press.pointerMode, moved, valid } : { pointerMode: null, moved: false, valid: false }, 1) && !p.temporaryPointerMode && !p.interaction.box };
    if (!press || !valid || moved) return;
    const state = resolveKnownCoordinateMarkerAction(p.document, press.marker, press.pointerMode, press.button, press.freezeRemoval);
    if (state.consumed) {
      if (state.action) try {
        if (state.objects.coordinateIds.length) applyObjectState(state.objects, state.action);
        else if (state.objects.atomIds.length) applyAtomState(state.objects.atomIds, state.action);
      } catch (error) { report(error); }
      else if (press.pointerMode === 'freeze' && press.marker && 'coordinateId' in press.marker && (press.button === 0 || press.button === 2)) report('该内坐标标记没有当前模型中的有效对象身份；请先建立或重新选择 B/A/D 对象。');
      return;
    }
    if (p.temporaryPointerMode || p.interaction.box) return;
    if (press.button === 2 || (press.button === 0 && p.persistentTool === 'delete')) try { remove(); } catch (error) { report(error); }
  }
  function redraw(atoms?: Atom[], documentOverride?: ModelDocument) {
    const p = latest.current;
    const document = documentOverride ?? p.document;
    const samplingSphere=viewportSamplingSphere(document,p.samplingSphereDraft,p.samplingSphere);
    atoms ??= p.displayAtoms;
    if (p.active === false) return;
    const viewportBounds = container.current?.getBoundingClientRect();
    if (!viewportBounds || viewportBounds.width <= 0 || viewportBounds.height <= 0) return;
    if (!p.multiframeDisplay && p.viewTransform && (p.observationReference || p.observationEpoch || p.observationFrame !== undefined || p.observationTransform)) { report('显式视图叠合与动态观察叠合不能同时启用。'); return; }
    const frozen = modelHighlights(document, p.highlights).frozenAtoms ?? [];
    if (!p.multiframeDisplay) alignment.current = p.observationTransform
      ? {...emptyObservationView(),documentId:document.id,modelKey:document.draft.structure.id,epoch:p.observationEpoch,frame:p.observationFrame,mode:p.display.alignment,base:p.observationTransform,transform:p.observationTransform}
      : updateObservationView(alignment.current, { documentId: document.id, structure: document.draft.structure, reference: p.observationReference, epoch: p.observationEpoch, frame: p.observationFrame, mode: p.display.alignment, frozenAtomIds: frozen.map(i => document.draft.structure.atoms[i]?.id ?? ''), softAnchorAtomIds:p.observationAnchorAtomIds, fixedFrame: p.observationFixedFrame });
    const drawTransform = p.viewTransform ?? (p.multiframeDisplay ? identityTransform() : alignment.current.transform);
    let multiframeStamp = 0;
    if (p.multiframeDisplay) { if (!multiframeStamps.current.has(p.multiframeDisplay)) multiframeStamps.current.set(p.multiframeDisplay, ++previewSerial.current); multiframeStamp = multiframeStamps.current.get(p.multiframeDisplay)!; }
    let previewStamp=0;if(atoms){if(!previewStamps.current.has(atoms))previewStamps.current.set(atoms,++previewSerial.current);previewStamp=previewStamps.current.get(atoms)!;}
    // Display-only vibration phases keep the parent scientific revision. Their
    // immutable atom projection still needs a redraw when arrows are disabled.
    const documentAtoms=document.draft.structure.atoms;
    if(!previewStamps.current.has(documentAtoms))previewStamps.current.set(documentAtoms,++previewSerial.current);
    const geometryStamp=previewStamps.current.get(documentAtoms)!;
    const connectivityStamp=viewportConnectivityStamp(document.draft.structure,previewStamps.current,()=>++previewSerial.current);
    const analysis=resultSelectionPresentation(document.draft.structure,p.resultHighlights);
    const capture=captureSelectionPresentation(document,p.analysisAtomCapture?analysisCaptureCurrent(p.analysisAtomCapture,p.analysisAtomCapture)?p.analysisAtomCapture.atomIds:[]:p.captureRequest?p.captureRequest.documentId===document.id&&p.captureRequest.revision===document.revision?p.captureAtomIds??[]:[]:undefined);
    const signature=JSON.stringify([capture.active,analysis.atomIds,analysis.records,document.id,document.revision,document.selection,document.draft.assignments,document.sharedConstraints,document.coordinateObjects,document.gaussianBoundCoordinates,captureViewportDisplay(p.display,p.captureRequest),p.highlights,p.measurement,drawTransform,multiframeStamp,p.calculationRanges,p.hiddenAtomIds,
       p.captureRequest&&[p.captureRequest.requestId,p.captureRequest.purpose],capture.atomIds,p.previewGuides,p.previewCell,p.cellGuides,p.linkedAtomsActive,p.stateMarkers,p.effectiveFrozenAtomIds,p.displayFrozenAtomIds,p.problemAtomIds,p.vibrationVectors,p.atomScalarValues,p.atomScalarColor,p.atomScalarLabels,p.dipoleVector,p.observationFrame,p.observationEpoch,previewStamp,geometryStamp,connectivityStamp,p.renderIdentity,Boolean(p.onRenderComplete),p.sceneOwnerEpoch]);
    const view=viewportProjectionSignature(adapter.current?.getView(),p);
    const resultInputs={bondValues:p.resultBondValues,atomLabels:p.resultAtomLabels,highlights:p.resultHighlights};
    if(lastDraw.current===signature&&lastProjectionView.current===view&&sameResultProjectionInputs(lastResultProjectionInputs.current,resultInputs))return;
    if(lastDraw.current!==signature){
      const feedback:RenderFeedbackOptions={...viewportCaptureFeedback(document,p.captureRequest,p.problemAtomIds,p),sceneOwnerEpoch:p.sceneOwnerEpoch?JSON.stringify([p.sceneOwnerEpoch,p.observationEpoch??null,p.renderIdentity?.sourceId??null,p.renderIdentity?.sourceRevision??null,p.renderIdentity?.generation??null]):undefined,displayFrozenAtomIds:p.displayFrozenAtomIds,hiddenAtomIds:p.hiddenAtomIds,multiframeDisplay:p.multiframeDisplay,samplingSphere,calculationRanges:p.calculationRanges,displayCaptureAtomIds:capture.active?capture.atomIds:undefined,previewGuides:p.previewGuides,previewCell:p.previewCell,cellGuides:p.cellGuides,displayHighlightAtomIds:analysis.atomIds,displayMeasurementRecords:analysis.records,renderIdentity:p.renderIdentity,onRenderComplete:p.onRenderComplete};
      feedback.onCipWarning=warning=>{
        if(latest.current.active===false||latest.current.document.id!==p.document.id||latest.current.document.draft.structure.atoms!==p.document.draft.structure.atoms)return;
        const identity=warning?JSON.stringify([p.document.id,warning.identity]):'';
        setCipWarning(old=>!warning||dismissedCipWarnings.current.has(identity)?null:old?.identity===identity&&old.atoms===p.document.draft.structure.atoms?old:{...warning,identity,documentId:p.document.id,atoms:p.document.draft.structure.atoms});
      };
      const instance=adapter.current,renderDocument=captureRenderDocument(document,p.captureRequest,p.captureAtomIds),renderDisplay=viewportRenderDisplay(captureViewportDisplay(p.display,p.captureRequest));
      if(instance?.drawAsync&&(asynchronousDraw.current||instance.cooperativeDisplay?.()||requiresCooperativeDisplay(renderDocument,renderDisplay,feedback))){
        if(asynchronousDraw.current?.signature===signature)return;asynchronousDraw.current?.controller.abort();
        const own={signature,controller:new AbortController()};asynchronousDraw.current=own;container.current?.setAttribute('data-render-preparing','true');
        const activation=assignmentActivation.current.epoch;
        feedback.isCurrent=()=>!own.controller.signal.aborted&&asynchronousDraw.current===own&&adapter.current===instance&&assignmentActivation.current.epoch===activation&&latest.current.active!==false&&latest.current.document.id===p.document.id&&latest.current.document.revision===p.document.revision&&latest.current.document.draft.structure.atoms===p.document.draft.structure.atoms&&latest.current.displayAtoms===p.displayAtoms&&latest.current.sceneOwnerEpoch===p.sceneOwnerEpoch&&latest.current.observationEpoch===p.observationEpoch;
        void instance.drawAsync(renderDocument,renderDisplay,p.highlights,atoms,drawTransform,p.measurement,feedback,own.controller.signal).then(()=>{
          if(!feedback.isCurrent?.())return;
          instance.updateSamplingSphere?.(viewportSamplingSphere(latest.current.document,latest.current.samplingSphereDraft,latest.current.samplingSphere),latest.current.document);
          if(renderDisplay.stereochemistry){const usage=preparedCarbonCipUsage(renderDocument.draft.structure,p.hiddenAtomIds);if(usage)p.onCipLabelsUsed?.({...usage,documentId:p.document.id,sourceRevision:String(p.document.revision)});}
          lastDraw.current=signature;observeSurfaceMesh(true);refreshProjection(atoms,atoms?{...document,draft:{...document.draft,structure:{...document.draft.structure,atoms}}}:document);
          lastResultProjectionInputs.current=resultInputs;lastProjectionView.current=viewportProjectionSignature(instance.getView(),latest.current);
        }).catch(error=>{if(!own.controller.signal.aborted&&asynchronousDraw.current===own&&error?.name!=='AbortError')report(error);}).finally(()=>{if(asynchronousDraw.current===own){asynchronousDraw.current=null;container.current?.removeAttribute('data-render-preparing');}});return;
      }
      instance?.draw(renderDocument,renderDisplay,p.highlights,atoms,drawTransform,p.measurement,feedback);observeSurfaceMesh(true);lastDraw.current=signature;
    }
    refreshProjection(atoms,atoms?{...document,draft:{...document.draft,structure:{...document.draft.structure,atoms}}}:document);
    lastResultProjectionInputs.current=resultInputs;
    lastProjectionView.current=viewportProjectionSignature(adapter.current?.getView(),p);
    if (!gesture.current && hoverScreen.current) updateHover(hoverScreen.current);
  }
  function pointerPlacement(command: Extract<ModelCommand, { type: 'place-element' | 'place-fragment' }>) {
    const p = latest.current;
    if(p.structureLocked||viewportEditingBlocked(p))return;
    p.onBeginModelInteraction?.();
    const before = p.document, after = p.onCommand(command);
    if (successfulFirstPointerPlacement(before, after, command)) adapter.current?.preserveEmptyPlacementView(before.id, before.revision, after.revision);
  }
  function finish(commit: boolean, event?: ReactPointerEvent<HTMLDivElement>) {
    cancelPendingMove();
    const current = gesture.current; if (!current) return;
    gesture.current = null; preview.current = undefined; setBox(null); setMoving(null);
    const target = hitSurface.current;
    if (target?.hasPointerCapture(current.pointerId)) target.releasePointerCapture(current.pointerId);
    const p = latest.current, live = p.getDocument?.()??p.document;
    const valid = gestureLeaseCurrent(current.contextDelete?{...current,kind:'edit'}:current,live,p.captureRequest) && (current.kind !== 'fragment' || !p.structureLocked && !viewportEditingBlocked(p)) && (!current.analysisCapture || (live.id === current.documentId && live.revision === current.revision && analysisCaptureCurrent(current.analysisCapture,p.analysisAtomCapture)));
    try {
      const fragmentCommit=current.kind==='fragment'&&commit&&valid&&p.active!==false&&current.moved&&Boolean(current.command);
      if(current.kind==='fragment'&&!fragmentCommit){adapter.current?.previewFragment?.(null);lastProjectionView.current=null;}
      // Keep the last complete preview visible until the accepted Store revision
      // is ready. Do not restore the old scene and then submit the new one.
      if(!fragmentCommit)redraw();
      if (commit && valid && p.active !== false) {
        if (current.analysisCapture) {
          if (adapter.current) finishAnalysisAtomCapture(current.analysisCapture, p.analysisAtomCapture,
            { ...current, end: event ? { x: event.clientX, y: event.clientY } : current.end },
            p.document.draft.structure.atoms.filter(a=>!p.hiddenAtomIds?.includes(a.id!)), adapter.current.project,
            event ? adapter.current.hitTest({ x: event.clientX, y: event.clientY }) : { kind: 'none' },
            id => coordinateSelectionObjects(p.document).find(object=>object.id===id)?.atomIds);
          return;
        }
        if(current.captureRequestId){
          if(adapter.current)finishInputCaptureGesture(live,p.captureRequest,p.captureAtomIds??[],{...current,end:event?{x:event.clientX,y:event.clientY}:current.end},adapter.current.project,p,event?adapter.current.hitTest({x:event.clientX,y:event.clientY}):{kind:'none'},p.hiddenAtomIds);
          return;
        }
        if(current.surfaceExtremumId){
          if(!current.moved&&current.button===0&&event&&adapter.current?.surfaceExtremumAt?.({x:event.clientX,y:event.clientY})===current.surfaceExtremumId)p.onSurfaceExtremumPick?.(current.surfaceExtremumId);
          return;
        }
        if(current.numberingPick){
          if(p.onAtomNumberPick&&!p.structureLocked&&!viewportEditingBlocked(p)&&!current.moved&&current.button===0&&current.pick.kind==='atom')p.onAtomNumberPick(current.pick.atomId);
          return;
        }
        if (viewportEditingBlocked(p) && !(p.observationSelection && current.stateAction && ['select-add','select-remove'].includes(current.stateAction))) {
          if (p.readOnly && !p.viewTransform && !current.moved && current.button === 0 && p.measurement?.mode) {
            dispatchMeasurementPick(current.pick,p.measurement.mode,p,{periodic:!!live.draft.structure.cell?.pbc.some(Boolean),document:live});
          }
          return;
        }
        if (current.stateAction && adapter.current) {
          if (p.structureLocked && !p.observationSelection) return;
          const end = event ? { x: event.clientX, y: event.clientY } : current.end;
          const rect={left:Math.min(current.start.x,end.x),right:Math.max(current.start.x,end.x),top:Math.min(current.start.y,end.y),bottom:Math.max(current.start.y,end.y)};
          const ids = current.moved ? captureBoxAtomIds(p.document.draft.structure.atoms.filter(a=>!p.hiddenAtomIds?.includes(a.id!)), adapter.current.project, rect) : current.pick.kind === 'atom' ? [current.pick.atomId] : [];
          const coordinateIds=current.moved?captureBoxCoordinateIds(selectableCoordinateLabels(),rect):current.pick.kind==='coordinate'?[current.pick.coordinateId]:[];
          if(coordinateIds.length)applyObjectState({atomIds:ids,coordinateIds},current.stateAction);else if(ids.length)applyAtomState(ids,current.stateAction);
        } else if (current.contextDelete) {
          if (!p.structureLocked && !current.moved && adapter.current && event && sameViewportPick(current.pick, adapter.current.hitTest({ x: event.clientX, y: event.clientY })) && current.pick.kind !== 'none') {
            p.onBeginModelInteraction?.();
            if (p.onObjectDelete) p.onObjectDelete(current.pick);
            else { const command = persistentToolCommand('delete', current.pick, p.document); if (command) p.onCommand(command); }
          }
        } else if (current.kind === 'box' && adapter.current) {
          const end = event ? { x: event.clientX, y: event.clientY } : current.end;
          const rect = { left: Math.min(current.start.x, end.x), right: Math.max(current.start.x, end.x), top: Math.min(current.start.y, end.y), bottom: Math.max(current.start.y, end.y) };
          p.onSelection(selectionWithCoordinateState(unionBox(p.document.selection, p.document.draft.structure.atoms.filter(a=>!p.hiddenAtomIds?.includes(a.id!)), adapter.current.project, rect),captureBoxCoordinateIds(selectableCoordinateLabels(),rect),'select-add'));
        } else if (current.kind === 'fragment') {
          if (current.moved && current.command) {
            const accepted = p.onGestureCommand ? p.onGestureCommand(current.command) : p.onCommand(current.command);
            if (accepted) redraw(undefined,accepted);
          }
        }
        else if (!current.moved && current.button === 0) {
          if (!p.structureLocked && current.persistentTool) {
            if (current.persistentTool === 'fragment' && current.fragmentTool && (current.pick.kind === 'atom' || current.pick.kind === 'port' || current.pick.kind === 'none')) {
              const targetAtomId = current.pick.kind === 'atom' ? current.pick.atomId : undefined;
              const atom = targetAtomId ? current.source.find(a => a.id === targetAtomId) : undefined;
              pointerPlacement({ type: 'place-fragment', ...current.fragmentTool,
                position: atom ? coordinates(atom) : current.pick.kind === 'none' ? placementPoint(current.start) : [0, 0, 0],
                ...(current.pick.kind === 'atom' ? { targetAtomId: current.pick.atomId } : {}),
                ...(current.pick.kind === 'port' ? { targetPortId: current.pick.portId } : {}),
              });
            } else if (current.persistentTool !== 'fragment') {
              const command = persistentToolCommand(current.persistentTool, current.pick, p.document);
              if (command) {p.onBeginModelInteraction?.();p.onCommand(command);}
            }
          } else if (p.measurement?.mode) {
            dispatchMeasurementPick(current.pick,p.measurement.mode,p,{periodic:!!live.draft.structure.cell?.pbc.some(Boolean),document:live});
          } else if (!p.structureLocked && current.element && (current.pick.kind === 'atom' || current.pick.kind === 'none' || current.pick.kind === 'port')) {
            const targetAtomId = current.pick.kind === 'atom' ? current.pick.atomId : undefined;
            const atom = targetAtomId ? current.source.find(a => a.id === targetAtomId) : undefined;
            const position = atom ? coordinates(atom) : current.pick.kind === 'none' ? placementPoint(current.start) : [0, 0, 0] as Vector3;
            pointerPlacement({ type: 'place-element', element: current.element, position, ...(targetAtomId ? { targetAtomId } : {}), ...(current.pick.kind === 'port' ? { targetPortId: current.pick.portId } : {}) });
          } else if (!p.structureLocked && current.pick.kind !== 'none') {
            if (current.pick.kind === 'port') p.onSelection({ atomIds: [], bonds: [], auxiliaryIds: [], portIds: [current.pick.portId] });
            else p.onSelection(selectionAfterPick(p.document.selection, current.pick));
          } else if (current.pick.kind === 'none') p.onMeasurementPick?.(null);
        }
      }
    } catch (error) { report(error); }
    finally { if (commit && valid && p.active !== false && current.kind === 'camera' && current.moved && adapter.current) p.onCameraViewChange?.(adapter.current.getView()); p.onGestureEnd(commit && valid); }
  }
  function placementPoint(screen: ScreenPoint): Vector3 {
    if (!adapter.current) throw new ViewportProjectionError('viewport-unavailable', '视口尚未就绪。');
    const position = adapter.current.worldPoint(screen); recoverProjection(true); return position;
  }
  useEffect(() => {
    if (props.active !== false) setInitializationRequested(requested => viewportInitializationRequested(requested, props.active));
  }, [props.active]);
  useEffect(() => {
    // Cold hidden owners keep their model/controller mounted without a GPU view.
    // Once requested, this effect's lifetime no longer follows active: returning
    // to a visited tab retains its adapter, camera and observation state.
    if (!initializationRequested) return;
    let cancelled = false, resize: ResizeObserver | undefined, resizeQueue:ReturnType<typeof createViewportResizeQueue>|undefined;
    let resizeRoots:HTMLElement[]=[],layoutResize:(()=>void)|undefined;
    const node = container.current!;
    const win = node.ownerDocument.defaultView!;
    const cancel = () => { analysisBoxHeld.current=false; latest.current.analysisAtomCapture?.onCancel(); cancelOverlayPress(); finishRope(false); finish(false); updateHover(null); latest.current.onStateMarkerHover?.(null); };
    const contextLost = (event: Event) => { if (!cancelled) { event.preventDefault(); cancel(); report('WebGL上下文已失活，请重新打开此建模窗口。', true); } };
    void createRenderAdapter(node).then(instance => {
      if (cancelled) { instance.dispose(); return; }
      adapter.current = instance;
      resizeRoots=[node.closest<HTMLElement>('[data-testid="model-document-deck"]'),node.closest<HTMLElement>('[data-testid="workspace-v18"]')].filter((value):value is HTMLElement=>Boolean(value));
      layoutResize=()=>{try{const active=resizeRoots.some(root=>root.dataset.layoutResizing==='true');instance.setLayoutResizing(active);if(!active&&latest.current.active!==false){refreshProjection();recoverProjection();}}catch(error){report(error);}};
      for(const root of resizeRoots)root.addEventListener(VIEWPORT_LAYOUT_RESIZE_EVENT,layoutResize);if(resizeRoots.length)layoutResize();
      redraw(); setReady(true);
      latest.current.onViewReady?.(() => instance.getView());
      const Observer = (win as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver;
      resizeQueue=createViewportResizeQueue(callback=>win.requestAnimationFrame(callback),id=>win.cancelAnimationFrame(id),()=>{try { instance.resize(true,error=>{try{if(error)throw error;if (latest.current.active === false) return; if (gesture.current) finish(false); finishRope(false); updateHover(null); refreshProjection(); recoverProjection();}catch(error){report(error);}}); } catch (error) { report(error); }});
      resize = new Observer(() => resizeQueue?.request()); resize.observe(node);
      node.querySelector('canvas')?.addEventListener('webglcontextlost', contextLost);
    }).catch(error => { if (!cancelled) { adapter.current?.dispose(); adapter.current = null; report(error, true); } });
    win.addEventListener('blur', cancel); win.addEventListener('pagehide', cancel);
    return () => {
      asynchronousDraw.current?.controller.abort();asynchronousDraw.current=null;container.current?.removeAttribute('data-render-preparing');
      cancelled = true; cancel(); resize?.disconnect();resizeQueue?.dispose();
      if(layoutResize)for(const root of resizeRoots)root.removeEventListener(VIEWPORT_LAYOUT_RESIZE_EVENT,layoutResize);
      win.removeEventListener('blur', cancel); win.removeEventListener('pagehide', cancel);
      node.querySelector('canvas')?.removeEventListener('webglcontextlost', contextLost);
      latest.current.onViewReady?.(null);
      adapter.current?.dispose(); adapter.current = null; observeSurfaceMesh();
    };
  }, [initializationRequested]);
    useEffect(() => { if (!ready) return; const rope = bondRope.current; if (rope && (rope.documentId !== model.id || rope.revision !== model.revision || props.structureLocked || viewportEditingBlocked(props))) finishRope(false); const own = gesture.current; if (own && (own.documentId !== model.id || ((own.kind !== 'camera' || own.analysisCapture) && own.revision !== model.revision) || (own.analysisCapture ? !analysisCaptureCurrent(own.analysisCapture,props.analysisAtomCapture) : (viewportEditingBlocked(props) && own.kind !== 'camera')))) finish(false); hoverScreen.current = null; redraw(preview.current); updateHover(null); }, [ready, model.id, model.revision, model.draft.structure, props.structureLocked, props.captureRequest, props.readOnly, props.allowModelEditing, props.viewTransform, props.multiframeDisplay, props.analysisAtomCapture?.requestId, props.analysisAtomCapture?.contextKey]);
  useEffect(() => { if (ready) redraw(preview.current); }, [ready, display, highlights, model.selection, model.draft.assignments, props.observationReference, props.observationEpoch, props.observationFrame, props.observationFixedFrame, props.observationAnchorAtomIds, props.observationTransform, props.measurement, props.captureRequest, props.captureAtomIds, props.analysisAtomCapture, props.showAxes, props.viewTransform, props.stateMarkers, props.effectiveFrozenAtomIds, props.displayFrozenAtomIds, props.linkedAtomsActive, props.problemAtomIds, props.vibrationVectors, props.atomScalarValues, props.atomScalarColor, props.atomScalarLabels, props.dipoleVector,props.multiframeDisplay,props.calculationRanges,props.hiddenAtomIds]);
  useEffect(()=>{if(!ready||props.active===false)return;try{const p=latest.current,instance=adapter.current;if(!instance?.updateSamplingSphere){lastDraw.current=null;redraw(preview.current);}else if(!instance.updateSamplingSphere(viewportSamplingSphere(p.document,p.samplingSphereDraft,p.samplingSphere),p.document))redraw(preview.current);observeRenderCounters();}catch(error){report(error);}},[ready,props.active,props.samplingSphere,props.samplingSphereDraft]);
  useEffect(() => { if (ready) redraw(preview.current); }, [ready, props.renderIdentity, props.onRenderComplete, props.sceneOwnerEpoch, props.displayAtoms]);
  useEffect(() => { if (ready) redraw(preview.current); }, [ready, props.previewGuides, props.previewCell, props.cellGuides, props.resultHighlights]);
  useEffect(() => { if (gesture.current?.kind === 'fragment') finish(false); }, [props.fragmentCancelEpoch]);
  useEffect(() => { if (ready) try {
    if (props.ntoLayer !== undefined) adapter.current?.setNtoLayer(props.active === false ? null : props.ntoLayer);
    else adapter.current?.setOrbitalLayer(props.active === false ? null : props.orbitalLayer ?? null);
  } catch (error) { report(error); } finally { observeSurfaceMesh(); } }, [ready, props.active, props.orbitalLayer, props.ntoLayer]);
  useEffect(() => { if (ready) try {
    if (props.surfaceLayers !== undefined) adapter.current?.setSurfaceLayers?.(props.active === false ? [] : props.surfaceLayers);
    else adapter.current?.setSurfaceLayer?.(props.active === false ? null : props.surfaceLayer ?? null);
  } catch (error) { report(error); } finally { observeSurfaceMesh(); } }, [ready, props.active, props.surfaceLayer, props.surfaceLayers]);
  useEffect(() => { if (ready) try { adapter.current?.setSurfaceExtrema?.(props.active===false?null:props.surfaceExtrema??null); refreshProjection(); } catch (error) { report(error); } }, [ready, props.active, props.surfaceExtrema, display.fontSize]);
  useEffect(()=>{if(ready)redraw(preview.current);},[ready,props.resultBondValues,props.resultBondLabels,props.resultAtomLabels,props.resultHighlights,props.resultBondColor]);
  useEffect(()=>{if(ready)redraw(preview.current);},[ready,props.previewGuides,props.previewCell]);
  useEffect(() => { if (!ready) return; if (props.active === false) { analysisBoxHeld.current=false;cancelOverlayPress();setCursor(null);updateHover(null); latest.current.onStateMarkerHover?.(null); finishRope(false); finish(false); } else { try { adapter.current?.resize(); redraw(); recoverProjection(); } catch (error) { report(error); } } }, [ready, props.active]);
  useEffect(() => { if (!ready || props.active === false || !props.cameraView || !adapter.current) return; try { if (JSON.stringify(adapter.current.getView()) !== JSON.stringify(props.cameraView)) { finishRope(false); finish(false); adapter.current.setView(props.cameraView); refreshProjection(); recoverProjection(); } } catch (error) { report(error); } }, [ready, props.active, props.cameraView]);
  useEffect(() => { if (ready && props.active === false) { asynchronousDraw.current?.controller.abort();asynchronousDraw.current=null;container.current?.removeAttribute('data-render-preparing');adapter.current?.cancelDraw?.();adapter.current?.clearObservationLayers(); lastDraw.current = ''; } }, [ready, props.active]);
  useEffect(() => { if (ready && props.active !== false && props.resetViewRequest) { try { finishRope(false); finish(false); adapter.current?.resetView(); updateHover(null); refreshProjection(); recoverProjection(); if (adapter.current) props.onCameraViewChange?.(adapter.current.getView()); } catch (error) { report(error); } } }, [ready, props.active, props.resetViewRequest]);
  useEffect(() => {
    const request = props.cameraRequest, instance = adapter.current;
    if (!ready || props.active === false || !instance || !request || handledCameraRequest.current === request.serial) return;
    handledCameraRequest.current = request.serial; finishRope(false); finish(false);
    try {
      if (request.kind === 'step') { if (request.direction) instance.step(request.direction); }
      else instance.orient(request.kind, request.preset);
      updateHover(null); refreshProjection();
      recoverProjection();
      latest.current.onCameraViewChange?.(instance.getView());
    } catch (error) { report(error); }
  }, [ready, props.active, props.cameraRequest]);
  // Escape is scoped to this Window; held-key management stays in the shared
  // interaction port. Blur/pointercancel never dispatch a document command.
  useEffect(() => {
    const win = container.current!.ownerDocument.defaultView!;
    const key = (event: KeyboardEvent) => {
      const p=latest.current; if(p.active===false)return;
      if(event.key==='Escape'){analysisBoxHeld.current=false;p.analysisAtomCapture?.onCancel();cancelOverlayPress();finishRope(false);finish(false);}
      const target=event.target as Element|null;
      if(p.analysisAtomCapture&&event.key.toLowerCase()==='r'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!target?.closest?.('input,textarea,select,[contenteditable="true"]')){
        analysisBoxHeld.current=true;event.preventDefault();
      }
    };
    const release=(event:KeyboardEvent)=>{if(event.key.toLowerCase()==='r')analysisBoxHeld.current=false;};
    win.addEventListener('keydown',key);win.addEventListener('keyup',release);
    return()=>{win.removeEventListener('keydown',key);win.removeEventListener('keyup',release);};
  }, []);
  useEffect(() => {
    const surface = hitSurface.current!;
    const wheel = (event: WheelEvent) => {
      if (latest.current.active === false) return;
      // React delegates wheel passively in supported browsers. Own a native,
      // nonpassive surface listener so even a clamped zoom consumes scrolling.
      event.preventDefault(); event.stopPropagation();
      if(adapter.current?.presentationReady?.()===false)return;
      const target = event.target instanceof Element ? event.target.closest('[data-measurement-record-id]') : null;
      if (target) {
        const record = latest.current.measurement?.records?.find(item => item.id === target.getAttribute('data-measurement-record-id'));
        if (record && !gesture.current && !bondRope.current && !viewportEditingBlocked(latest.current) && !latest.current.analysisAtomCapture && !latest.current.structureLocked && !pointerMode(latest.current) && !latest.current.interaction.box) {
          try { latest.current.onMeasurementRecordWheel?.(record, event.deltaY); } catch (error) { report(error); }
        }
        return;
      }
      if (!gesture.current && !bondRope.current) { try { adapter.current?.zoom(event.deltaY); refreshProjection(); recoverProjection(); if (hoverScreen.current) updateHover(hoverScreen.current); if (adapter.current) latest.current.onCameraViewChange?.(adapter.current.getView()); } catch (error) { report(error); } }
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    const win = surface.ownerDocument.defaultView!, scroll = () => { try { updateHover(null); refreshProjection(); } catch (error) { report(error); } };
    // Scrolling changes client-space projections even while the mouse is still.
    win.addEventListener('scroll', scroll, true);
    return () => { surface.removeEventListener('wheel', wheel); win.removeEventListener('scroll', scroll, true); };
  }, []);
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if(adapter.current?.presentationReady?.()===false)return;
    if (!adapter.current || latest.current.active === false || gesture.current || bondRope.current) return;
    try {
    if (!latest.current.captureRequest && !latest.current.analysisAtomCapture && !latest.current.onAtomNumberPick && event.button === 0 && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      const p = latest.current, pick = adapter.current.hitTest({ x: event.clientX, y: event.clientY });
      if (viewportEditingBlocked(p) || p.structureLocked || pointerMode(p) || pick.kind !== 'atom') return;
      p.onBeginModelInteraction?.();
      const atom = p.document.draft.structure.atoms.find(atom => atom.id === pick.atomId); if (!atom) return;
      const rope: BondRope = { pointerId: event.pointerId, documentId: p.document.id, revision: p.document.revision, atomId: pick.atomId, start: adapter.current.project(coordinates(atom)), pointerStart: { x: event.clientX, y: event.clientY }, end: { x: event.clientX, y: event.clientY }, targetAtomId: null, moved: false };
      bondRope.current = rope; setRopeDrawing(rope); updateHover(null); event.currentTarget.setPointerCapture(event.pointerId); p.onGestureStart('box'); return;
    }
    if (![0, 1, 2].includes(event.button)) return;
    if (event.button === 2 && viewportEditingBlocked(latest.current)) { event.preventDefault(); return; }
    if (event.button !== 1 && latest.current.structureLocked && !latest.current.readOnly && !latest.current.viewTransform && (event.shiftKey || event.altKey || latest.current.interaction.alt)) { event.preventDefault(); return; }
    event.preventDefault();
    const shown = latest.current,p=shown.allowModelEditing&&shown.editingDocument?{...shown,document:shown.editingDocument}:shown, screen = { x: event.clientX, y: event.clientY }, hit = adapter.current.hitTest(screen);
    if(claimTransientCanvasDismiss(event.nativeEvent,hit.kind==='none')){event.preventDefault();event.stopPropagation();return;}
    const current: Gesture = { pointerId: event.pointerId, kind: 'camera', button: event.button, start: screen, end: screen, moved: false, view: adapter.current.getView(), documentId: p.document.id, revision: p.document.revision, pick: hit, element: p.interaction.element, source: p.document.draft.structure.atoms, atomIds: [], cameraMode: event.button === 1 || p.observationTool === 'pan' ? 'pan' : 'rotate', captureRequestId: p.captureRequest?.requestId, persistentTool: p.persistentTool, fragmentTool: p.fragmentTool && { ...p.fragmentTool } };
      if(p.analysisAtomCapture){
        p.analysisAtomCapture.assertCurrent();
        current.analysisCapture={requestId:p.analysisAtomCapture.requestId,ownerId:p.analysisAtomCapture.ownerId,contextKey:p.analysisAtomCapture.contextKey};
        if(event.button===0&&(analysisBoxHeld.current||event.shiftKey)){current.kind='box';setBox({start:screen,end:screen});}
      }
      else if(p.readOnly&&event.button===0)current.surfaceExtremumId=adapter.current.surfaceExtremumAt?.(screen)??undefined;
      if(p.captureRequest&&!current.analysisCapture){
        if(p.captureRequest.documentId!==p.document.id||p.captureRequest.revision!==p.document.revision)return;
        if(p.captureRequest.kind==='atoms'&&useBoxGesture(pointerMode(p),p.interaction.box,p.observationTool,event.button)){current.kind='box';setBox({start:screen,end:screen});}
      }
      if(current.analysisCapture||p.captureRequest){ /* Capture gestures only affect their own draft. */ }
      else if(p.onAtomNumberPick){current.numberingPick=true;}
      else if (observationSelectionGesture(p,pointerMode(p),event.button)) {
        current.kind='box';current.stateAction=event.button===2?'select-remove':'select-add';setBox({start:screen,end:screen});
      }
      else if (viewportEditingBlocked(p)) { /* Display-only observations do not own model commands. */ }
      else if (event.button === 1 && (p.structureLocked || !(event.altKey || event.shiftKey || p.interaction.alt))) { /* Unmodified/read-only middle drag pans the camera. */ }
      else if (useBoxGesture(pointerMode(p), p.interaction.box, p.observationTool, event.button)) {
        if (p.structureLocked) return;
        current.kind = 'box'; current.stateAction = pointerStateAction(pointerMode(p) ?? 'select', event.button, p.freezeRemovalMode) ?? undefined;
        setBox({ start: screen, end: screen });
      }
      else if (event.button === 2) {
        // Capture, modifiers and edit locks own this pointer; measurement owns only left picks.
        if (p.structureLocked || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || p.interaction.alt || hit.kind === 'none') return;
        current.contextDelete = true;
      }
      else if (event.shiftKey && !(event.altKey || p.interaction.alt)) {
        const selected = new Set(p.document.selection.atomIds);
        current.atomIds = current.source.flatMap(atom => selected.has(atom.id!) ? [atom.id!] : []);
        if (!current.atomIds.length) return;
        const frozen = new Set(p.effectiveFrozenAtomIds ?? getFrozenAtomIds(p.document));
        if (current.atomIds.some(id => frozen.has(id))) throw new Error('选区含冻结原子，不能拖动；请先调整选区或明确解除冻结。');
        current.kind = 'fragment';
        current.previewSource = createFragmentPreviewSource(current.source,current.atomIds);
        current.pivot = centroid(current.previewSource.atoms);
        current.plane = adapter.current.plane(current.pivot);
        recoverProjection(true);
      }
      else if (event.button === 0 && (p.interaction.box || p.observationTool==='box') && !p.structureLocked && !p.measurement?.mode) { current.kind = 'box'; setBox({ start: screen, end: screen }); }
      else if (event.altKey || p.interaction.alt) {
        const id = hit.kind === 'atom' ? hit.atomId : hit.kind === 'bond' ? hit.atomIds[0] : undefined;
        if (!id) return;
        const fragment=resolveFinitePeriodicFragment(p.document.draft.structure,id);
        current.kind = 'fragment'; current.atomIds = [id,...fragment.atomIds.filter(atomId=>atomId!==id)];
        current.unwrapPeriodic=Boolean(p.document.draft.structure.cell?.pbc.some(Boolean));
        if (!current.atomIds.length) return;
        const frozen = new Set(p.effectiveFrozenAtomIds ?? getFrozenAtomIds(p.document));
        if (current.atomIds.some(atomId => frozen.has(atomId))) throw new Error('片段含冻结原子，不能拖动；请先明确解除冻结。');
        current.previewSource = createFragmentPreviewSource(current.source,current.atomIds,fragment.positions);
        current.pivot = centroid(current.previewSource.atoms);
        current.plane = adapter.current.plane(current.pivot);
        recoverProjection(true);
      }
      if(current.kind==='fragment'){
        current.gestureId=++previewSerial.current;current.sampleGeneration=0;
        p.onBeginModelInteraction?.();
        // One full projection shell at press time; RAF only replaces selected slots.
        current.previewAtoms = current.source.slice();
        current.previewIndices = new Map(current.source.map((atom,index)=>[atom.id!,index] as const));
        current.overlayBaseline = {markers:stateMarkerLabels,captures:captureMarkers,badges:assignmentBadges,problems:problemMarkers};
      }
      p.onGestureStart(current.kind);
      updateHover(null); gesture.current = current; setMoving(current.kind); event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) { if (!(error instanceof ScientificEditCancelledError)) report(error); }
  }
  function cancelPendingMove(){moveScheduler.cancel();}
  function flushMove(event?: ReactPointerEvent<HTMLDivElement>){
    moveScheduler.flush(event?{pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,currentTarget:event.currentTarget}:undefined);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>){
    const own=gesture.current;
    if(!own||own.kind==='box'||bondRope.current){applyMove(event);return;}
    moveScheduler.schedule({pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,currentTarget:event.currentTarget});
  }
  function applyMove(event: PointerMoveSample) {
    if (latest.current.active === false) return;
    const p=latest.current;
    const cursorVisible=!viewportEditingBlocked(p)&&!p.structureLocked&&!p.measurement?.mode&&!p.temporaryPointerMode&&!p.interaction.box&&(p.interaction.element||p.persistentTool);
    if(cursorVisible){const bounds=event.currentTarget.getBoundingClientRect();setCursor({x:event.clientX-bounds.left,y:event.clientY-bounds.top});}else setCursor(null);
    const instance = adapter.current; if (!instance) return;
    const current = gesture.current, screen = { x: event.clientX, y: event.clientY };
    const rope = bondRope.current;
    if (rope) {
      if (rope.pointerId !== event.pointerId) return;
      const p = latest.current;
      if (p.structureLocked || p.document.id !== rope.documentId || p.document.revision !== rope.revision) { finishRope(false); return; }
      const hit = instance.hitTest(screen), targetAtomId = hit.kind === 'atom' && hit.atomId !== rope.atomId ? hit.atomId : null;
      const target = targetAtomId ? p.document.draft.structure.atoms.find(atom => atom.id === targetAtomId) : undefined;
      const next = { ...rope, end: target ? instance.project(coordinates(target)) : screen, targetAtomId, moved: rope.moved || Math.hypot(screen.x - rope.pointerStart.x, screen.y - rope.pointerStart.y) >= DRAG_THRESHOLD };
      bondRope.current = next; setRopeDrawing(next); instance.hover(hit); return;
    }
    if (!current) { try { updateHover(screen); } catch (error) { report(error); } return; }
    if (current.pointerId !== event.pointerId) return;
    const live=latest.current.getDocument?.()??latest.current.document;
    if(!gestureLeaseCurrent(current,live,latest.current.captureRequest)||(current.analysisCapture&&(live.id!==current.documentId||live.revision!==current.revision||!analysisCaptureCurrent(current.analysisCapture,latest.current.analysisAtomCapture)))){finish(false);return;}
    current.end = screen; const dx = screen.x - current.start.x, dy = screen.y - current.start.y;
    current.moved ||= Math.hypot(dx, dy) >= DRAG_THRESHOLD;
    if (current.kind === 'box') { setBox({ start: current.start, end: screen }); return; }
    if (current.contextDelete) return;
    if (!current.moved) return;
    try {
      if (current.kind === 'camera') {
        if (current.cameraMode === 'pan') instance.camera(current.view, dx, dy, 'pan');
        else {const [rotationX,rotationY]=cameraRotationDrag(p.display,dx,dy);instance.camera(current.view, rotationX, rotationY, 'rotate');}
        refreshProjection();
        recoverProjection();
        if(latest.current.broadcastCameraDuringGesture)latest.current.onCameraViewChange?.(instance.getView());
      }
      else if (current.plane && current.pivot) {
        const step = fragmentPointerStep(current.start, screen);
        if (!step) {
          current.command=undefined;preview.current=undefined;instance.previewFragment?.(null);lastDraw.current=null;redraw();return;
        }
        const { stepX, stepY } = step;
        if (current.button === 1) {
          const delta = planeDelta(current.plane, stepX, stepY);
          current.command = { type: 'transform-fragment', atomIds: current.atomIds, delta, unwrapPeriodic:current.unwrapPeriodic };
        } else {
          const axis = add(scale(current.plane.right, stepY), scale(current.plane.up, stepX)), rotation = { axis, degrees: Math.hypot(stepX, stepY) * .55, pivot: current.pivot };
          current.command = { type: 'transform-fragment', atomIds: current.atomIds, rotation, unwrapPeriodic:current.unwrapPeriodic };
        }
        const frame = fragmentFramePresentation(current.previewSource!,current.command);
        for(const atom of frame.preview)current.previewAtoms![current.previewIndices!.get(atom.id!)!]=atom;
        preview.current = current.previewAtoms;
        if(instance.previewFragment){current.sampleGeneration=(current.sampleGeneration??0)+1;instance.previewFragment(frame.preview,{documentId:current.documentId,revision:current.revision,gestureId:current.gestureId,sampleGeneration:current.sampleGeneration,rotation:current.command.rotation});observeRenderCounters(true);refreshFragmentProjection(current,frame.preview);}
        else { lastDraw.current=null;redraw(preview.current); }
      }
    } catch (error) { finish(false); report(error); }
  }
  const elementLegend = useMemo(()=>presentElementColors(model.draft.structure.atoms, display.elementColors),[model.draft.structure.atoms,display.elementColors]);
  const hasLegend = display.legend && props.legendVisible !== false;
  const assignmentInteractionDisabled = Boolean(props.active === false || viewportEditingBlocked(props) || props.captureRequest || props.analysisAtomCapture || props.onAtomNumberPick || props.structureLocked || props.temporaryPointerMode || interaction.box);
  const currentAssignmentBadges = assignmentBadges.flatMap(badge => {
    const region = assignmentRegions.find(region => assignmentDisplayKey(region) === assignmentDisplayKey(badge.region) && region.atomIds.length === badge.region.atomIds.length && region.atomIds.every(id => badge.region.atomIds.includes(id)));
    return region && (captureDisplay.regionLabels || captureDisplay.colorMode === region.category) ? [{ ...badge, region }] : [];
  });
  const selectedAssignment = assignmentRegions.find(region => region.atomIds.length > 0 && region.atomIds.length === model.selection.atomIds.length && region.atomIds.every(id => model.selection.atomIds.includes(id)));
  const resultProjectionCurrent=resultProjectionOwner.current?.documentId===model.id&&resultProjectionOwner.current?.revision===model.revision&&resultProjectionOwner.current?.highlights===props.resultHighlights;
  const helpText = props.analysisAtomCapture ? props.analysisAtomCapture.kind === 'coordinate' ? '有序内坐标选择：依次点选原子 · 拖动旋转 · Esc取消' : '原子区域选择：点选原子 · R / Shift框选 · 拖动旋转 · Esc取消' : viewportEditingBlocked(props) ? '观察：拖动旋转 · 滚轮缩放' : props.structureLocked ? '观察：左拖旋转 · 平移工具 · 滚轮缩放' : `左拖旋转 · 平移工具 · 滚轮缩放 · ${props.selectionShortcut??'R'}框选 · Shift选区 · Alt片段`;
  const bounds = viewportBondRopeBounds(Boolean(ropeDrawing||box), hitSurface.current);
  const summaryFormula=molecularFormula(model.draft.structure.atoms),summaryMass=molecularMass(model.draft.structure.atoms);
  // Clearing current results updates an existing label without another move.
  const resultBond=props.readOnly&&hoverAtomLabel?.bondPick?resultBondHover(hoverAtomLabel.bondPick,props.resultBondValues??[]):null;
  const hoveredAnalysisAtom=props.readOnly&&hoverAtomLabel?.atomId?(props.resultAtomLabels?.find(row=>row.atomId===hoverAtomLabel.atomId)?.label??props.atomScalarValues?.find(row=>model.draft.structure.atoms[row.atomIndex]?.id===hoverAtomLabel.atomId)?.label):undefined;
  const hoverLabel = hoverAtomLabel?.auxiliaryId&&hoverAtomLabel.bondPick ? [hoverBondLength(model.draft.structure,hoverAtomLabel.bondPick),'辅助关系 0.5'].filter(Boolean).join('\n') : hoverAtomLabel?.bondPick ? props.readOnly&&props.resultBondValues!==undefined ? resultBondHoverText(hoverAtomLabel.bondPick,props.resultBondValues??[])??[hoverBondLength(model.draft.structure,hoverAtomLabel.bondPick),resultBond].filter(Boolean).join(' · ') : hoverBondLabel(model.draft.structure, hoverAtomLabel.bondPick, bondOrders) : hoverAtomLabel?.atomId ? hoveredAnalysisAtom??atomHoverLabel(model.draft.structure.atoms, hoverAtomLabel.atomId, props.atomScalarValues) : hoverAtomLabel?.label;
  // atomHoverLabel's first line is its existing C1 identity. Keep its scientific
  // body and let the common formatter supply the same 1C header as fixed/PNG.
  const completeHoverLabel=hoverAtomLabel?.atomId?resultTargetLabel(model.draft.structure,[hoverAtomLabel.atomId],hoveredAnalysisAtom??(hoverLabel?.split('\n').slice(1).join('\n')??'')):hoverLabel?.split('\n').filter(line=>/\d/.test(line)&&!/(未知|配位|辅助关系)/.test(line)).map(line=>line.replace(/（来源）|（聚合）|^原子对键级\s*/g,'')).join('\n');
  const hoverPresentation=hoverAtomLabel&&completeHoverLabel?resultLabelPresentation(completeHoverLabel,hoverAtomLabel,'center',display.fontSize):null;
  const visibleResultLabels:ResultLabelItem[]=[];
  if(props.active!==false&&surfaceLabels.layer===props.surfaceExtrema&&props.surfaceExtrema?.documentId===model.id&&props.surfaceExtrema.geometryRevision===model.revision)visibleResultLabels.push(...surfaceLabels.items);
  if(props.readOnly&&resultAtomLabels.documentId===model.id&&resultAtomLabels.revision===model.revision&&resultAtomLabels.values===props.resultAtomLabels)
    for(const row of resultAtomLabels.rows)visibleResultLabels.push({id:resultLabelTargetKey('atom',[row.atomId]),presentation:resultLabelPresentation(resultTargetLabel(model.draft.structure,[row.atomId],row.label)??row.label,row,'top-left',display.fontSize),target:{x:row.x-13,y:row.y-15},attributes:{'data-testid':'result-atom-contribution','data-atom-id':row.atomId}});
  if(resultProjectionCurrent)for(const row of recordLabels.filter(row=>row.analysis&&resultPresentation.records.some(record=>record.id===row.record.id))){
    const body=resultMeasurementValueLabel(row.record,row.valueLabel,props.resultBondValues),text=resultTargetLabel(model.draft.structure,row.record.atomIds,body)??body;
    visibleResultLabels.push({id:resultLabelTargetKey('pair',row.record.atomIds),presentation:resultLabelPresentation(text,row,'center',display.fontSize),bond:true,target:{x:row.x,y:row.y},attributes:{'data-testid':'model-measurement-record','data-measurement-record-id':row.record.id,'data-analysis-record':'true','data-mode':row.record.mode,'aria-label':row.detail+' · '+text}});
  }
  if(props.readOnly&&(props.resultBondLabels||!!props.resultHighlights?.bondPairs.length)&&resultBondLabels.documentId===model.id&&resultBondLabels.revision===model.revision&&resultBondLabels.values===props.resultBondValues)
    for(const row of resultBondLabels.rows)visibleResultLabels.push({id:resultLabelTargetKey('pair',row.atomIds),presentation:resultLabelPresentation(resultTargetLabel(model.draft.structure,row.atomIds,row.valueLabel)??row.valueLabel,row,'center',display.fontSize),bond:true,target:{x:row.x,y:row.y},attributes:{'data-testid':'result-bond-label','data-atom-ids':JSON.stringify(row.atomIds),'aria-label':row.valueLabel,title:row.label}});
  const visibleLabels=mergeResultLabelItems(visibleResultLabels);
  const pointerTargetKey=hoverAtomLabel?.atomId?resultLabelTargetKey('atom',[hoverAtomLabel.atomId]):hoverAtomLabel?.bondPick&&!hoverAtomLabel.bondPick.image?.some(Boolean)?resultLabelTargetKey('pair',hoverAtomLabel.bondPick.atomIds):'pointer';
  // Keep fixed scientific labels in place. A temporary pointer label uses the
  // same measured box and edge avoidance without displacing those fixed slots.
  const pointerLabels:ResultLabelItem[]=props.active!==false&&hoverPresentation&&!visibleLabels.some(item=>item.id===pointerTargetKey)?[{id:pointerTargetKey,presentation:hoverPresentation,bond:hoverAtomLabel?.bond,attributes:{'data-testid':hoverAtomLabel?.bond?'model-hover-bond':'model-hover-atom',style:{textAlign:'center'}}}]:[];
  const legendNode=<CompactModelLegend sourceDocumentId={model.id} hasInactiveFreeze={Boolean(props.stateMarkers?.some(marker=>marker.kind==='freeze'&&marker.inactive))} visible={hasLegend} compact={narrowLegend} elements={elementLegend} regions={assignmentRegions} onRegionSelect={assignmentInteractionDisabled ? undefined : selectAssignmentRegion} fontSize={display.fontSize} expanded={props.legendExpanded} onExpandedChange={props.onLegendExpandedChange} />;
  useLayoutEffect(()=>{props.onLegendSurfaceChange?.(legendNode);});
  return <section ref={viewportElement} className="model-viewport" data-testid="model-viewport" data-document-id={model.id} data-capture-kind={props.captureRequest?.kind??''} data-capture-purpose={props.captureRequest?.purpose??''} data-color-mode={display.colorMode} data-region-highlights={display.regionHighlights} data-has-legend={hasLegend} data-legend-layout="attached" data-viewport-narrow={narrowLegend} data-ready={ready} data-active={props.active !== false} data-read-only={Boolean(props.readOnly || props.viewTransform)} data-multiframe-count={props.multiframeDisplay?.frameCount??0} data-multiframe-atom-instances={props.multiframeDisplay?.atomInstances??0} data-multiframe-fit={props.multiframeDisplay?.fitKind??''} data-sampling-sphere-radius={props.samplingSphere?.radiusAngstrom??''} aria-label="桌面三维建模视口">
    <div className="model-viewport-stage">
      <div className="model-viewport-canvas" ref={container} data-testid="model-render-canvas" />
      {ready&&props.active!==false&&props.cellEditorDraft&&adapter.current&&<CellEditorOverlay draft={props.cellEditorDraft} cellGuides={props.cellGuides} fontSize={display.fontSize} project={adapter.current.project} viewport={container.current} projectionVersion={overlayTick}/>}
      {ready&&props.active!==false&&!props.cellEditorDraft&&(props.cellGuides||display.cell)&&model.draft.structure.cell&&adapter.current&&<ReadOnlyCellOverlay cell={model.draft.structure.cell} cellGuides={props.cellGuides} documentId={model.id} fontSize={display.fontSize} project={adapter.current.project} viewport={container.current} projectionVersion={overlayTick}/>}
      {ready&&props.active!==false&&props.samplingSphereDraft&&props.onSamplingSphereRadiusChange&&adapter.current&&<SamplingSphereOverlay draft={props.samplingSphereDraft} project={adapter.current.project} projectSphere={adapter.current.projectSphere} viewport={container.current} projectionVersion={overlayTick} onRadiusChange={props.onSamplingSphereRadiusChange}/>}
      <div ref={hitSurface} className="model-viewport-interaction" data-testid="model-interaction-surface" data-gesture={bondRope.current ? 'bond-rope' : moving ?? 'none'} data-element={interaction.element ?? ''} onPointerDown={down} onPointerMove={move} onPointerUp={event => { if (bondRope.current?.pointerId === event.pointerId) finishRope(true, event); else if (gesture.current?.pointerId === event.pointerId) { flushMove(event); finish(true, event); } }} onPointerCancel={() => { finishRope(false); finish(false); }} onLostPointerCapture={() => { finishRope(false); finish(false); }} onPointerLeave={() => { if (!gesture.current && !bondRope.current) { setCursor(null); updateHover(null); } }} onContextMenu={event => event.preventDefault()}>
        {ropeDrawing && bounds && <svg className="model-bond-rope" data-testid="model-bond-rope" data-source-atom-id={ropeDrawing.atomId} data-target-atom-id={ropeDrawing.targetAtomId ?? ''}><line x1={ropeDrawing.start.x - bounds.left} y1={ropeDrawing.start.y - bounds.top} x2={ropeDrawing.end.x - bounds.left} y2={ropeDrawing.end.y - bounds.top}/></svg>}
        {box && bounds && <div className="model-selection-box" data-testid="model-selection-box" style={{ left: Math.min(box.start.x, box.end.x) - bounds.left, top: Math.min(box.start.y, box.end.y) - bounds.top, width: Math.abs(box.end.x - box.start.x), height: Math.abs(box.end.y - box.start.y) }} />}
        {!viewportEditingBlocked(props) && props.active !== false && !props.structureLocked && !props.measurement?.mode && !props.temporaryPointerMode && !interaction.box && !hoverAtomLabel && !ropeDrawing && cursor && (interaction.element || props.persistentTool) && <span className="model-element-cursor" data-testid="model-element-cursor" style={{ left: cursor.x + 15, top: cursor.y + 15 }}>{props.persistentTool === 'hydrogen' ? '加H' : props.persistentTool === 'delete' ? '删除' : props.persistentTool === 'fragment' ? props.fragmentTool?.templateId ?? '片段' : interaction.element}</span>}
        <ResultLabelLayer items={[...visibleLabels,...pointerLabels]} surface={hitSurface}/>
        {props.readOnly&&props.resultBondColor&&<svg className="result-analysis-colors" aria-hidden="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}>{resultBondColors.map(row=><line key={JSON.stringify(row.atomIds)} x1={row.x1} y1={row.y1} x2={row.x2} y2={row.y2} stroke={row.color} strokeWidth={4} opacity=".85"/>)}</svg>}
        {props.readOnly&&props.resultColorbar&&<AnalysisColorbarOverlay colorbar={props.resultColorbar} onLayoutChange={props.onResultColorbarLayoutChange} contextKey={`${model.id}:${model.revision}:${props.resultColorbarOwnerKey??''}`}/>}
        <AssignmentBadges badges={currentAssignmentBadges} onRegionSelect={selectAssignmentRegion} contextKey={`${model.id}:${assignmentActivation.current.epoch}:${model.revision}`} selectedRegionKey={selectedAssignment && assignmentDisplayKey(selectedAssignment)} disabled={assignmentInteractionDisabled} fontSize={display.fontSize} />
        {problemMarkers.filter(marker => props.problemAtomIds?.includes(marker.atomId) && model.draft.structure.atoms.some(atom => atom.id === marker.atomId)).map(marker => <span key={marker.atomId} className="model-problem-atom-marker" data-testid="model-problem-atom-marker" data-atom-id={marker.atomId} role="img" aria-label={props.problemDiagnostic ? `问题原子：${props.problemDiagnostic}` : '问题原子'} style={{ left: marker.x, top: marker.y }}>?</span>)}
        {stateMarkerLabels.filter(marker=>!marker.id.startsWith('result-')||resultProjectionCurrent&&resultPresentation.markers.some(current=>current.id===marker.id)).map(marker => <button key={marker.id} type="button" className="model-state-marker" data-testid={marker.id.startsWith('result-atom:')?'result-highlight-atom':marker.id.startsWith('result-coordinate:')?'result-highlight-bond':'model-state-marker'} data-analysis-marker={marker.id.startsWith('result-')?true:undefined} data-state-marker-id={marker.id} data-state-kind={marker.kind} data-freeze-state={marker.kind==='freeze'?marker.inactive?'inactive':'applied':undefined} data-coordinate-id={marker.coordinateId} data-removable={marker.removable !== false} aria-disabled={marker.removable === false} aria-label={marker.label ?? marker.kind} title={marker.label} style={{ left: marker.x, top: marker.y }} onPointerDown={event => beginOverlayPress(event, marker.id, marker)} onPointerMove={moveOverlayPress} onPointerUp={event => endOverlayPress(event, marker.id, () => removeStateMarker(marker))} onPointerCancel={cancelOverlayPress} onLostPointerCapture={cancelOverlayPress} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()} onPointerEnter={() => { updateHover(null); latest.current.onStateMarkerHover?.(marker); }} onPointerLeave={() => latest.current.onStateMarkerHover?.(null)} onFocus={() => latest.current.onStateMarkerHover?.(marker)} onBlur={() => latest.current.onStateMarkerHover?.(null)}>{marker.kind === 'freeze' ? <FreezeStateIcon inactive={marker.inactive}/> : <span aria-hidden="true">{marker.kind === 'selection' ? '✓' : 'S'}</span>}<span className="model-state-marker-detail">{marker.label ?? (marker.kind === 'selection' ? '选区' : marker.kind === 'freeze' ? '冻结' : '扫描')}</span></button>)}
        {recordLabels.filter(row=>!row.analysis).map(({ record, valueLabel:renderedValueLabel, detail, x, y }) => {
          const selected=!props.captureRequest&&!props.analysisAtomCapture&&model.selection.coordinateIds?.includes(record.id);
          return <button key={record.id} type="button"
          className={`model-measurement-record${selected?' model-coordinate-selected':''}`}
          data-testid="model-measurement-record" data-measurement-record-id={record.id} data-coordinate-id={record.id}
          data-coordinate-selected={selected?'true':'false'} data-mode={record.mode}
          aria-label={detail} aria-pressed={props.measurement?.activeRecordId === record.id}
          title={detail + (props.captureRequest ? ' · 点击用于当前输入选择' : props.readOnly || props.viewTransform ? '' : ' · 点击选择和编辑；F冻结；滚轮调整实际几何')}
          style={{left:x,top:y,color:record.color,fontSize:display.fontSize,pointerEvents:props.analysisAtomCapture&&props.analysisAtomCapture.kind!=='coordinate'?'none':undefined}}
          onPointerDown={event => beginOverlayPress(event, `measurement:${record.id}`,{id:record.id,kind:'selection',coordinateId:record.id,atomIds:record.atomIds})}
          onPointerMove={moveOverlayPress} onPointerUp={event => endOverlayPress(event, `measurement:${record.id}`, () => latest.current.onMeasurementRecordDelete?.(record.id))}
          onPointerCancel={cancelOverlayPress} onLostPointerCapture={cancelOverlayPress} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
          onPointerEnter={() => { const p=latest.current;if(p.active!==false){updateHover(null);if(coordinateSelectionObjects(p.document).some(object=>object.id===record.id))p.onHover({kind:'coordinate',coordinateId:record.id});p.onMeasurementRecordHover?.(record);} }}
          onPointerLeave={() => {updateHover(null);latest.current.onMeasurementRecordHover?.(null);}}
          onFocus={() => {const p=latest.current;if(p.active!==false){if(coordinateSelectionObjects(p.document).some(object=>object.id===record.id))p.onHover({kind:'coordinate',coordinateId:record.id});p.onMeasurementRecordHover?.(record);}}}
          onBlur={() => {updateHover(null);latest.current.onMeasurementRecordHover?.(null);}}
          onClick={event => {
            event.stopPropagation();const p=latest.current;
            if(p.analysisAtomCapture){if(p.active!==false&&p.analysisAtomCapture.kind==='coordinate')try{p.analysisAtomCapture.assertCurrent();p.analysisAtomCapture.onCoordinate?.([...record.atomIds]);}catch(error){report(error);}return;}
            if(!consumeOverlayClick(`measurement:${record.id}`,event.detail))return;
            if(p.active===false||viewportEditingBlocked(p)||p.analysisAtomCapture||p.structureLocked||p.temporaryPointerMode||p.interaction.box||bondRope.current||p.persistentTool==='delete')return;
            try{
              if(p.captureRequest&&p.captureRequest.kind!=='atoms'&&(p.captureRequest.kind==='coordinate'||p.captureRequest.kind===(record.mode==='distance'?'B':record.mode==='angle'?'A':'D'))){p.onCaptureBox?.([...record.atomIds],record.images?structuredClone(record.images):undefined);return;}
              if(!p.captureRequest&&coordinateSelectionObjects(p.document).some(object=>object.id===record.id))p.onSelection(selectionWithCoordinateState(p.document.selection,[record.id],p.document.selection.coordinateIds?.includes(record.id)?'select-remove':'select-add'));
              p.onMeasurementRecordSelect?.(record);
            }catch(error){report(error);}
          }}>{renderedValueLabel}</button>;})}
        {transientLabel && <output className="model-measurement model-measurement-scalar" data-testid="model-measurement" title={transientLabel.detail} aria-label={transientLabel.detail} style={{ left: transientLabel.x, top: transientLabel.y, fontSize:display.fontSize }}><span className="model-visually-hidden">{transientLabel.label}</span>{transientLabel.valueLabel}</output>}
        {captureMarkers.map(marker => <span key={marker.atomId} data-testid="model-capture-marker" data-atom-id={marker.atomId} aria-label={`选取顺序 ${marker.ordinal}`} style={{position:'absolute',pointerEvents:'none',zIndex:5,left:marker.x+12,top:marker.y+8,color:'#946b00',font:`600 ${display.fontSize}px system-ui`}}>{marker.ordinal}</span>)}
      </div>
      {!model.draft.structure.atoms.length && ready && <div className="model-empty-hint">{viewportEmptyHint(props.readOnly)}</div>}
      {!ready && !failure && <div className="model-empty-hint">正在载入三维视口…</div>}
      <DismissibleNotice identity={failure} className="model-viewport-error" data-error-kind={failure?.kind}>{failure?.message}</DismissibleNotice>
      {display.stereochemistry&&cipWarning&&cipWarning.documentId===model.id&&cipWarning.atoms===model.draft.structure.atoms&&<div className="model-stereochemistry-warning" data-testid="model-stereochemistry-warning"><details><summary aria-label="立体化学标注不可用" title="立体化学标注不可用">⚠</summary><div><strong>立体化学标注不可用</strong><pre>{cipWarning.reason}</pre></div></details><button type="button" aria-label="关闭立体化学标注警告" onClick={()=>{dismissedCipWarnings.current.add(cipWarning.identity);setCipWarning(null);}}>×</button></div>}
      {props.captureRequest && <output className="model-capture-status" data-testid="model-capture-status">输入选择 · {props.captureRequest.kind} · {(props.captureAtomIds ?? []).length} 个原子</output>}
      {props.analysisAtomCapture && <output className="model-capture-status" data-testid="analysis-atom-capture-status">{props.analysisAtomCapture.kind === 'coordinate' ? '有序内坐标选择' : '原子区域选择'} · {props.analysisAtomCapture.atomIds.length} 个原子</output>}
      {props.multiframeDisplay && !props.analysisAtomCapture && <output className="model-capture-status" data-testid="multiframe-display-status">叠合 {props.multiframeDisplay.frameCount} 帧 · {props.multiframeDisplay.atomInstances} 原子实例{multiframeDisplayDiagnostics(props.multiframeDisplay).map(text => ' · '+text)}</output>}
      {props.showAxes && axes.length > 0 && <PhysicalAxesOverlay axes={axes} display={display}/>}
      <div className="model-metadata-overlay model-metadata-inline" data-testid="model-metadata-overlay" aria-label="分子结构信息"><span aria-label={'化学式 '+summaryFormula}>{summaryFormula.split(/(\d+)/).map((part,index)=>/^\d+$/.test(part)?<sub key={index}>{part}</sub>:part)}</span><span data-testid="structure-atom-count">N={model.draft.structure.atoms.length}</span><span data-testid="structure-molecular-mass" title={summaryMass.unknownElements.length?'无标准原子量：'+summaryMass.unknownElements.join('、'):'分子量，单位 g/mol'}>M={summaryMass.value===null?'未知':summaryMass.value.toFixed(3)}</span></div>
      {!props.onLegendSurfaceChange&&legendNode}
    </div>
    <footer className="model-viewport-help" aria-label={helpText} title={narrowLegend ? helpText : undefined} tabIndex={narrowLegend ? 0 : undefined}><span className="model-viewport-help-text">{helpText}</span><span className="model-viewport-unit">Å</span></footer>
  </section>;
}
