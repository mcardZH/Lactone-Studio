import type { Atom, Bond, Vector3, PeriodicCell, Structure } from '../../../core/types';
import type { DisplaySettings, MeasurementRecord, MeasurementState, ModelDocument, PickResult, ScreenPoint, SelectionCaptureRequest } from '../../../modeling/contracts';
import { FREEZE_COLOR, SCAN_COLOR, type ViewerHighlights } from '../../../core/display-highlights';
import { modelAtomLabel } from '../viewport-overlays';
import {modelCoordinateKey} from '../../../modeling/constraints';
import { MODEL_HOVER_COLOR } from '../modeling-interaction-policy';
import { builderExplicitGeometryFrame } from '../../../core/builder-geometry';
import {rotateAttachmentDirection} from '../../../core/modeling/attachment-ports';
import { membershipColor, regionMembership } from '../../../core/regions';
import { captureViewerListeners } from './compat';
import {retainViewerFramebuffers,captureNativeResizeListeners} from './framebuffer-lifecycle';
import {physicalViewportSize,samePhysicalViewportSize,createViewportResizeSettler,VIEWPORT_LAYOUT_RESIZE_EVENT} from './resize-lifecycle';
import { rotateObjectView, principalInertiaFrame, cellViewFrame, orientObjectView, rotateObjectViewStep, projectPhysicalAxes, type ViewFrame } from './camera';
import { colorRegions, modelHighlights } from './display';
import { elementColor } from './element-colors';
import { DEFAULT_BACKGROUND_COLOR, cellEdgeStrokesWork } from './display-settings';
import { viewportDefaultBackgroundColor, observeCanvasBackground } from './viewport-background';
import {finishRenderWork,runRenderWork,type RenderWork} from './render-work';
import {carbonCipSource,cipStructureForDisplay,createCarbonCipRequests,emptyCarbonCip,prepareCarbonCipLabels,preparedCarbonCipUsage,type CipDisplayUsage,type CipLabelWarning} from './stereochemistry';
import type {CarbonCipLabel} from '../../../core/stereochemistry-cip';
import {createSamplingSphereLayer} from './sampling-sphere-layer';
import { attachLocalMeshFinish, attachStructureModelFinish, attachStructureShapeFinish } from './mesh-finish';
import { applyResolvedAtomStyles } from './atom-style-batch';
import { createSceneSequence, type SceneShapeMethod } from './scene-sequence';
import { translateNativeArrow } from './translated-arrow';
import { structureShellFinish } from '../../../modeling/appearance-presets';
import { normalizeVibrationVectorAppearance } from '../../../results/surface-appearance-presets';
import { bondDisplayRadius, displayScale, structureAtomRadius, structureAtomStyle } from '../structure-display';
import { createPeriodicBondGlyphExporter, periodicGlyphRequired,periodicBondGlyphContext,periodicBondGlyphTopology } from './periodic-bond-glyph';
import { bindNativeCoordinateBuffers, updateNativePickCylinder } from './native-coordinate-buffers';
import { retainNativeCoordinateUpload } from './native-coordinate-upload';
import { createPickBroadPhase } from './pick-broad-phase';
import { poseNativeFlatCylinder } from './posed-cylinder';
export { atomDisplayScale } from '../structure-display';
import { identityTransform, inversePoint, inverseRotate, rotate, transformAtoms, transformPoint, composeTransforms, type RigidTransform } from './alignment';
import { createTrajectoryLayer, frameModelAtoms, isNativeFrameBond, createFrameBondPainter, displayHiddenAtomIds } from './trajectory-layer';
import { sha256Utf8 } from '../../../core/file-identity';
import { validateMultiframeDisplayPlan, validateSamplingSphereDisplay, type MultiframeDisplayPlan, type SamplingSphereDisplay } from '../../../modeling/view-multiframe';
import { add, attachmentPortEndpoint, bondConnectionOnly, bondRefKey, bondSegments, bondPathSectionsWork, dashedBondSectionsWork, cellSegments, centroid, coordinates, cross, dragPlane, measurementGeometryGuide, planePoint, point, scale, subtract, rotateVector, ViewportProjectionError, type DragPlane } from './geometry';
import { depthFadeAmount, depthFadeFog } from './depth-fade';
import { calculationRangeLines, CALCULATION_RANGE_STYLE, type CalculationRangeFeedback } from '../../../results/calculation-range';
import {includeRenderPoint,unionRenderBounds,retainViewerDepthEnvelope,type RenderBounds} from './depth-envelope';
import {cellRenderPlanes,clippedCellCylinder,needsObliqueCellCap} from './cell-cylinder';
import type { ViewportOrbitalLayer } from '../../../results/orbital-contracts';
import { createShapeLayer } from './shape-layer';
import { createLabelLayer } from './label-layer';
import { retainViewerShapeResources } from './shape-resource-lifecycle';
import { createNativePrimitiveBatch, nativePrimitiveBatchesAvailable, type NativeBatchArrow, type NativeBatchRod, type NativeBatchSphere } from './native-primitive-batch';
import { createOrbitalLayer, type ViewportNtoLayer, type NtoMeshState } from './orbital-layer';
import { createSurfaceLayers, type ViewportSurfaceLayer, type ViewportSurfaceExtrema, type SurfaceMeshState, type SurfaceLayerMeshState } from './surface-layer';
import { createRenderCompletionObserver, createRendererSubmissionObserver, type ViewportRenderIdentity, type ViewportRenderObserver } from './render-completion';
import { transformGuidePrimitives, type TransformPreviewGuides } from './transform-guides';
import { periodicDisplayInstancesWork, periodicDisplaySettings, preparePeriodicDisplayConnectionsWork, type PeriodicDisplayInstance, type PeriodicDisplayConnectionContext } from './periodic-display';
import { fractionalToCartesian } from '../../../core/periodic';
import { cellPresentationEdges, type CellPresentationOptions } from '../../../core/modeling/cell-presentation';

export const SELECTION_COLOR = '#f0c62e';
export const MEASUREMENT_COLOR = '#277fdf';
export const VIBRATION_ARROW_COLOR = '#277fdf';
export const ATOM_SCALAR_COLORS = { low: '#2166ac', middle: '#ffffff', high: '#b2182b' } as const;
export function sameNativeCoordinates(atoms:readonly Atom[],snapshot:readonly Vector3[]):boolean {
  return atoms.length===snapshot.length&&atoms.every((atom,index)=>Number.isFinite(atom.x)&&Number.isFinite(atom.y)&&Number.isFinite(atom.z)&&Object.is(atom.x,snapshot[index][0])&&Object.is(atom.y,snapshot[index][1])&&Object.is(atom.z,snapshot[index][2]));
}
/** Physical Cartesian Å displacements. Stable IDs take priority; a supplied
 * unknown ID must never fall back to an unrelated atom at the legacy index. */
export type ViewportVibrationVector = { vector: [number, number, number]; appearance?: import('../../../results/surface-appearance-presets').VibrationVectorAppearance } &
  ({ atomId: string; atomIndex?: number } | { atomId?: undefined; atomIndex: number });
export interface ViewportAtomScalarValue { atomIndex: number; value: number; label?: string; /** Validated presentation palette override only. */ color?:string }
/** Direction and length are explicit display Å from the result owner. */
export interface ViewportDipoleVector { origin: Vector3; vector: Vector3; color?: string }
/** Display-only feedback. The caller owns diagnostic identity/revision checks. */
export interface RenderFeedbackOptions extends CalculationRangeFeedback {
  /** Nonfatal label-only diagnostics, published only after the current scene. */
  onCipWarning?(warning:CipLabelWarning|null):void;
  onCipLabelsUsed?(usage:CipDisplayUsage):void;
  isCipCurrent?():boolean;
  liveCip?:boolean;
  cipGeometryPreview?:boolean;
  /** Exact frame science used only for labels. Null disables fallback. */
  cipStructure?: Structure | null;
  /** Trusted caller's live document/activation/revision guard; never serialized. */
  isCurrent?():boolean;
  /** Verified document lifetime, supplied only by its owning workspace. */
  sceneOwnerEpoch?: string;
  /** Temporary transform aids. Never topology, picks or model history. */
  previewGuides?: TransformPreviewGuides;
  previewCell?: PeriodicCell;
  cellGuides?: CellPresentationOptions;
  /** Defined, even empty, replaces the visible edit selection for this draw.
   * Undefined restores the untouched document selection. */
  displayCaptureAtomIds?: readonly string[];
  /** Authoritative blue protection display, independent of scientific freezes. */
  displayFrozenAtomIds?: readonly string[];
  hiddenAtomIds?:readonly string[];
  multiframeDisplay?: MultiframeDisplayPlan;
  fixedCellView?: boolean;
  initialFixedCellCamera?: readonly number[];
  samplingSphere?: SamplingSphereDisplay;
  /** Explicit preview purpose only; never persisted or inferred from PBC. */
  cellPresentation?: import('./geometry').CellFramePresentation;
  renderIdentity?: ViewportRenderIdentity;
  onRenderComplete?: ViewportRenderObserver;
  /** Disposable analysis presentation, never copied into ModelDocument. */
  /** Legacy display-only alias; never merged into document selection. */
  displaySelectionAtomIds?:readonly string[];
  displayHighlightAtomIds?:readonly string[];
  displayMeasurementRecords?:readonly MeasurementRecord[];
  linkedAtomsActive?:boolean;
  capturePurpose?: SelectionCaptureRequest['purpose'];
  vibrationVectors?: readonly ViewportVibrationVector[];
  atomScalarValues?: readonly ViewportAtomScalarValue[];
  atomScalarColor?: boolean;
  atomScalarLabels?: boolean;
  dipoleVector?: ViewportDipoleVector;
}
function validScalarValues(values: readonly ViewportAtomScalarValue[], atomCount: number): Map<number, number> {
  return new Map(values.filter(row => Number.isInteger(row.atomIndex) && row.atomIndex >= 0 && row.atomIndex < atomCount && Number.isFinite(row.value)).map(row => [row.atomIndex, row.value]));
}
/** The legend/export owner can use the same valid, current-atom display range. */
export function viewportAtomScalarRange(values: readonly ViewportAtomScalarValue[], atomCount: number): { min: number; max: number } | null {
  const valid = [...validScalarValues(values, atomCount).values()];
  if (!valid.length) return null;
  return valid.reduce((range, value) => ({ min: Math.min(range.min, value), max: Math.max(range.max, value) }), { min: valid[0], max: valid[0] });
}
function scalarColor(value: number, range: { min: number; max: number }): string {
  if (range.min === range.max) return ATOM_SCALAR_COLORS.middle;
  // Scale first so finite values across +/- Number.MAX_VALUE stay finite.
  const extent = Math.max(Math.abs(range.min), Math.abs(range.max));
  const fraction = (value / extent - range.min / extent) / (range.max / extent - range.min / extent);
  const endpoints = fraction <= .5 ? [ATOM_SCALAR_COLORS.low, ATOM_SCALAR_COLORS.middle] : [ATOM_SCALAR_COLORS.middle, ATOM_SCALAR_COLORS.high];
  const blend = Math.max(0, Math.min(1, fraction <= .5 ? fraction * 2 : fraction * 2 - 1));
  return '#' + [1, 3, 5].map(offset => {
    const low = parseInt(endpoints[0].slice(offset, offset + 2), 16), high = parseInt(endpoints[1].slice(offset, offset + 2), 16);
    return Math.round(low + (high - low) * blend).toString(16).padStart(2, '0');
  }).join('');
}
export const MODEL_BACKGROUND_COLOR = DEFAULT_BACKGROUND_COLOR;
export const LINKED_BACKGROUND_COLOR = '#fffdf1';
export const CAPTURE_BACKGROUND_COLOR = '#edf4fb';
/** Locked 3Dmol uses CAMERA_Z=150. A 25Å viewing distance gives a default
 * orthographic width near 18Å, suitable for a small molecule before any fit. */
export const EMPTY_MODEL_VIEW_Z = 125;
export function defaultEmptyModelView(view: readonly number[]): number[] {
  const next = [...view]; if (next.length === 8 && next.every(Number.isFinite)) next[3] = EMPTY_MODEL_VIEW_Z;
  return next;
}

/** Choose opaque black/white against the actual rendered material color.
 * This is label styling only; it never changes the sphere or its hit bounds. */
export function atomLabelFontColor(color: unknown): '#000000' | '#ffffff' {
  let channels: number[] | null = null;
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
  else if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color <= 0xffffff) channels = [color >>> 16, color >>> 8 & 255, color & 255].map(channel => channel / 255);
  else if (color && typeof color === 'object' && ['r', 'g', 'b'].every(key => typeof (color as Record<string, unknown>)[key] === 'number')) {
    const rgb = color as { r: number; g: number; b: number };
    if ([rgb.r, rgb.g, rgb.b].every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) channels = [rgb.r, rgb.g, rgb.b];
  }
  if (!channels) return '#000000'; // Empty/unsupported styles sit on the light viewport background.
  const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}

interface MolecularLayout {
  documentId: string;
  atoms: readonly Atom[];
  bonds: readonly Bond[] | undefined;
  periodic: boolean;
  sourceBonds: readonly Bond[] | undefined;
  indices: ReadonlyMap<string, number>;
}
interface MolecularMaterial {
  layout: MolecularLayout;
  appearance: string;
  styles: any[];
}

function sameBondImage(a: Bond['image'], b: Bond['image']): boolean {
  return a===b||Boolean(a&&b&&a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2]);
}
function sameModelBonds(a: readonly Bond[]|undefined, b: readonly Bond[]|undefined):boolean{
  return a===b||Boolean(a&&b&&a.length===b.length&&a.every((bond,index)=>{
    const other=b[index];
    return bond.a===other.a&&bond.b===other.b&&bond.order===other.order&&bond.aromatic===other.aromatic&&bond.stereo===other.stereo&&
      bond.kind===other.kind&&bond.orderKnown===other.orderKnown&&bond.fractional===other.fractional&&
      bond.perception===other.perception&&bond.mbo===other.mbo&&sameBondImage(bond.image,other.image);
  }));
}
function molecularLayout(previous:MolecularLayout|undefined,documentId:string,atoms:readonly Atom[],structure:Structure):MolecularLayout{
  const sourceBonds=structure.bonds,periodic=Boolean(structure.cell?.pbc.some(Boolean));
  const bonds=periodic
    ? previous?.periodic&&previous.sourceBonds===sourceBonds?previous.bonds:sourceBonds?.filter(bond=>isNativeFrameBond(structure,bond))
    : sourceBonds;
  if(previous?.documentId===documentId&&previous.periodic===periodic&&sameModelBonds(previous.bonds,bonds)&&
    (previous.atoms===atoms||previous.atoms.length===atoms.length&&atoms.every((atom,index)=>atom.id===previous.atoms[index].id&&atom.element===previous.atoms[index].element))){
    previous.sourceBonds=sourceBonds;
    return previous;
  }
  return {documentId,atoms,bonds,periodic,sourceBonds,indices:new Map(atoms.map((atom,index)=>[atom.id!,index]))};
}

export interface CameraZoomReceipt {
  requestedFactor:number;
  appliedFactor:number;
  limited:boolean;
  previousDistance:number;
  perceivedDistance:number;
  previousView:number[];
  view:number[];
}
export interface CameraZoomControls {
  getZoomDistance():number;
  zoomByFactor(factor:number):CameraZoomReceipt;
}
export interface RenderAdapter extends CameraZoomControls {
  drawAsync?(document: ModelDocument, display: DisplaySettings, highlights?: ViewerHighlights, preview?: Atom[], transform?: RigidTransform, measurement?: MeasurementState, feedback?: RenderFeedbackOptions,signal?:AbortSignal):Promise<void>;
  cancelDraw?():void;
  observeScene?(document:Pick<ModelDocument,'id'|'revision'>,identity:ViewportRenderIdentity|undefined,observer:ViewportRenderObserver|undefined):void;
  awaitMeshes?(signal?:AbortSignal):Promise<void>;
  cooperativeDisplay?():boolean;
  /** Published scene can accept pointer interaction; staging never exposes partial picks. */
  presentationReady?():boolean;
  cameraInputReady?(documentId: string): boolean;
  draw(document: ModelDocument, display: DisplaySettings, highlights?: ViewerHighlights, preview?: Atom[], transform?: RigidTransform, measurement?: MeasurementState, feedback?: RenderFeedbackOptions): void;
  setOrbitalLayer(layer: ViewportOrbitalLayer | null): void;
  setNtoLayer(layer: ViewportNtoLayer | null): void;
  ntoMeshState?(): Readonly<NtoMeshState>;
  setSurfaceLayer(layer: ViewportSurfaceLayer | null): void;
  setSurfaceLayers(layers: readonly ViewportSurfaceLayer[]): void;
  /** Actual CPU geometry commitment, not GPU/compositor completion. */
  surfaceMeshState?(): Readonly<SurfaceMeshState>;
  surfaceMeshStates?(): readonly SurfaceLayerMeshState[];
  setSurfaceExtrema(layer: ViewportSurfaceExtrema | null): void;
  /** Spatial result target, deliberately outside the model's PickResult. */
  surfaceExtremumAt(screen: ScreenPoint): string | null;
  project(position: Vector3): ScreenPoint;
  projectMany?(positions:readonly Vector3[]):ScreenPoint[];
  /** Analytic circle only for an actual orthographic camera; null uses the projection fallback. */
  projectSphere?(sphere:SamplingSphereDisplay):{center:ScreenPoint;radius:number}|null;
  /** Retry a temporary CIP failure for the current owned scene. */
  retryCip?(): void;
  /** Current-source overlay only, without rebuilding molecular or CIP content. */
  updateSamplingSphere?(sphere:SamplingSphereDisplay|undefined,owner?:Pick<ModelDocument,'id'|'revision'>):boolean;
  /** Exact display envelope from this renderer's radius table and style. */
  atomRadius(element: string, display: DisplaySettings): number;
  plane(origin: Vector3): DragPlane;
  /** Object identity only. Modeling can distinguish a visible, read-only image
   * from blank canvas. Other observers retain the existing selectable objects. */
  hitTest(screen: ScreenPoint, includeReadOnlyImages?:boolean): PickResult;
  /** Resolve a real blank placement only when an edit actually requires it. */
  worldPoint(screen: ScreenPoint): Vector3;
  /** Synchronize a positive viewport and inspect finite projected view axes. */
  projectionReady(): boolean;
  pick(screen: ScreenPoint): PickResult;
  nearestAtom(screen: ScreenPoint, maxPixels?: number): string | null;
  getView(): number[];
  setView(view: number[]): void;
  camera(view: number[], dx: number, dy: number, kind: 'rotate' | 'pan', commitWithFrame?: boolean): void;
  zoom(delta: number): void;
  resetView(): void;
  /** Only a successful empty-document pointer placement may retain its exact camera. */
  preserveEmptyPlacementView(documentId: string, baseRevision: number, nextRevision: number): void;
  orient(kind: 'standard' | 'cell', preset?: 'a' | 'a*' | 'b' | 'b*' | 'c' | 'c*'): void;
  step(direction: 'left' | 'right' | 'up' | 'down'): void;
  axes(): { axis: 'X' | 'Y' | 'Z'; x: number; y: number; depth: number }[];
  hover(pick: PickResult): void;
  resize(deferred?:boolean,onComplete?:(error?:unknown)=>void): void;
  setLayoutResizing(active:boolean):void;
  clearObservationLayers(): void;
  multiframeState(): { modelCount: number; shapeCount: number; atomInstances: number };
  /** Primitive counts only; O(1), with no retained viewer or event history. */
  diagnostics?(): Readonly<Record<string, number | null>>;
  /** Display-only absolute raw coordinates for one stable affected-ID set.
   * Null restores the last committed draw; never commits a model transaction. */
  previewFragment?(atoms:readonly Atom[]|null,context?:FragmentRenderPreviewContext):void;
  dispose(): void;
}
export function requiresCooperativeDisplay(document:ModelDocument,display:DisplaySettings,feedback?:RenderFeedbackOptions):boolean{
  const structure=document.draft.structure;
  const periodic=periodicDisplaySettings(display),showsBonds=display.showBonds!==false&&display.representation!=='vdw';
  const bonds=structure.bonds??[];
  let glyphWork=0;
  // Compact native glyph work can finish on the current frame. Queueing it on
  // a worker would stage the entire cell and delay camera presentation.
  const periodicPreparation=structure.cell?.pbc.some(Boolean)&&(periodic.images||showsBonds&&bonds.some(bond=>{
    if(periodicGlyphRequired(structure,bond))glyphWork+=structure.atoms.length+bonds.length;
    return glyphWork>1024;
  }));
  return !!(display.stereochemistry&&!feedback?.liveCip||periodicPreparation||showsBonds&&structure.bonds?.some(b=>b.order===.5)||document.auxiliaryRelations.length||display.cell&&display.cellStyle?.lineStyle==='dashed'||feedback?.multiframeDisplay);
}
export interface FragmentRenderPreviewContext {
  documentId:string;revision:number;
  gestureId?:number;sampleGeneration?:number;
  rotation?:{axis:Vector3;degrees:number;pivot:Vector3};
}

/** A window owns one persistent adapter. Model/style switches update that
 * instance. Electron windows must load their own renderer realm, not Portal a
 * canvas into a foreign document: locked 3Dmol uses ambient document/window. */
interface RenderAdapterOptions {orthographic?:boolean;backgroundAlpha?:0|1;asyncMeshes?:boolean;onAsyncMeshState?():void;onAsyncMeshError?(error:unknown):void}

export async function createRenderAdapter(container: HTMLDivElement, options: RenderAdapterOptions = {}): Promise<RenderAdapter> {
  if (container.ownerDocument !== globalThis.document) throw new Error('建模视口需要独立窗口自身的渲染环境。');
  const mol = await import('3dmol');
  return buildRenderAdapter(container, mol, options);
}

/** Exported for renderer-independent unit checks with a purpose-built fake. */
export function buildRenderAdapter(container: HTMLDivElement, mol: any, options: RenderAdapterOptions = {}): RenderAdapter {
  const realm = container.ownerDocument.defaultView!;
  const initialBackground=viewportDefaultBackgroundColor(container);
  const nativeSizing=captureNativeResizeListeners(realm,()=>captureViewerListeners(container.ownerDocument.body, () => mol.createViewer(container, { backgroundColor: initialBackground, backgroundAlpha:options.backgroundAlpha??1, disableFog:true, antialias: true, nomouse: true, orthographic: options.orthographic ?? true })));
  const captured=nativeSizing.value;nativeSizing.release();
  const viewer = captured.value;
  if (!viewer) { captured.release(); throw new Error('无法初始化WebGL结构视图。'); }
  const atomRadius = (element: string, display: DisplaySettings) => structureAtomRadius(display, element, mol.GLModel?.vdwRadii?.[element] ?? 1.5);
  const framebufferLifecycle=retainViewerFramebuffers(viewer);
  const nativeCoordinateUpload=retainNativeCoordinateUpload(viewer.getRenderer?.());
  const shapeResources=retainViewerShapeResources(viewer);
  let shapeSlotCompactions=0;
  const compactOwnedShapeSlots=()=>{
    if(typeof mol.GLViewer==='function'&&viewer instanceof mol.GLViewer&&typeof mol.GLShape==='function'&&shapeResources.compactSlots(shape=>shape instanceof mol.GLShape))shapeSlotCompactions++;
  };
  let labels=createLabelLayer(viewer);
  const periodicBondGlyphs=createPeriodicBondGlyphExporter(mol);
  const trajectoryLayer = createTrajectoryLayer(viewer, shapeResources, periodicBondGlyphs, atomRadius);
  const samplingSphereShapes = createSamplingSphereLayer(viewer);
  const calculationRangeShapes = createShapeLayer(viewer);
  const renderCompletion=createRenderCompletionObserver(()=>viewer.getCanvas?.(),realm,()=>viewer.getRenderer?.()?.getContext?.());
  const observedGraphs=new WeakMap<readonly Bond[],string>();
  let cameraPreparedAt:number|undefined;
  const renderSubmissions=createRendererSubmissionObserver(viewer,renderCompletion,()=>{
    const bounds=container.getBoundingClientRect(),gl=viewer.getRenderer?.()?.getContext?.(),canvas=viewer.getCanvas?.();
    return {cssWidth:bounds.width,cssHeight:bounds.height,bufferWidth:gl?.drawingBufferWidth??canvas?.width??0,bufferHeight:gl?.drawingBufferHeight??canvas?.height??0,
      contextKind:gl?(typeof gl.fenceSync==='function'?'webgl2' as const:'webgl1' as const):'unknown' as const};
  },()=>{
    const structure=currentDocument?.draft.structure,bonds=structure?.bonds,cell=structure?.cell;
    let bondGraphSha256=bonds&&observedGraphs.get(bonds);
    if(bonds&&!bondGraphSha256){
      bondGraphSha256=sha256Utf8(JSON.stringify(bonds));
      observedGraphs.set(bonds,bondGraphSha256);
    }
    return {atomCount:positions.length,atoms:positions.slice(0,2).map(({id,element,x,y,z})=>({id,element,x,y,z})),
      tailAtoms:positions.slice(-2).map(({id,element,x,y,z})=>({id,element,x,y,z})),
      ...(cameraPreparedAt===undefined?{}:{cameraPreparedAt}),
      molecularMeshBuilds,residentCoordinateFrames,...nativeCoordinateUpload.statistics(),
      ...(bonds?{bondCount:bonds.length,bondGraphSha256}:{}),
      ...(cell?{cell:{vectors:cell.vectors,pbc:cell.pbc,origin:cell.origin}}:{})};
  });
  let disposed = false, initialized = false, currentId: string | null = null;
  let drawController:AbortController|null=null,drawTail:Promise<void>=Promise.resolve(),lastDrawCooperative=false;
  let fragmentSamples=0,scenePreparations=0,sceneAborts=0,molecularMeshBuilds=0,fragmentRigidPresents=0,coordinateBufferUpdates=0;
  const nativeBufferBindings=new WeakMap<object,ReturnType<typeof bindNativeCoordinateBuffers>>();
  let fragmentRetirementBatches=0,fragmentPartialPresents=0,fragmentFullPresents=0,fragmentFallbackCode=0;
  let residentCoordinateFrames=0;
  let background = initialBackground;
  let fadeStrength=0;
  let currentDocument: ModelDocument | null = null, positions: Atom[] = [], proxies: any[] = [], imageProxies: any[] = [], mirrorInstances: PeriodicDisplayInstance[] = [];
  const basePicking = createPickBroadPhase<any>(), imagePicking = createPickBroadPhase<any>();
  let atomPickProxies = new Map<number,any>();
  let fixedViewCell: PeriodicCell | undefined;
  let centroidSource: Atom[] | undefined, positionCentroid: Vector3;
  const displayedCentroid = () => {
    if(centroidSource!==positions){centroidSource=positions;positionCentroid=centroid(positions);}
    return positionCentroid;
  };
  const viewPivot = (): Vector3 => fixedViewCell ? fixedViewCell.vectors.reduce((center,v)=>add(center,scale(v,.5)),fixedViewCell.origin??[0,0,0]) : displayedCentroid();
  let baseAtomStyles: any[] = [], hoverKey = '';
  const hoverShapes = createShapeLayer(viewer);
  const displayHoverKeys=new Set<string>();
  let renderedModel: any = null, modelMaterial: MolecularMaterial | undefined;
  type ResidentBond = { a:number; b:number; shape:any; visual:BondVisual };
  let residentScene: { signature:string; model:any; root:object; bonds:ResidentBond[]; radii:Float64Array; xyz:Vector3[]; pickSpheres:any[][] }|undefined;
  function createOwnedMolecularModel(settings:DisplaySettings){
    const model=attachStructureModelFinish(viewer.addModel('','xyz'),settings.structureFinish,settings.structureLighting,settings.representation==='stick');
    const globj=model.globj;
    if(typeof globj==='function')model.globj=function(this:any,...args:any[]){
      const before=this.renderedMolObj,result=globj.apply(this,args);
      if(this.renderedMolObj&&this.renderedMolObj!==before)molecularMeshBuilds++;
      return result;
    };
    return shapeResources.keepModel(model);
  }
  let nativeCoordinates: Vector3[] | null = null, nativeCoordinateEpoch: string | undefined;
  let atomicDraw:{commit():void;rollback():void;retire(model:any):void;publishedProxies:any[];publishedImageProxies:any[];
    cameraOwner:string|null;publishedView:number[];publishedPivot:Vector3;manualView?:number[]}|null=null;
  function rememberCamera(){if(atomicDraw?.cameraOwner)atomicDraw.manualView=[...viewer.getView()];}
  const clearNativeCoordinates=()=>{nativeCoordinates=null;nativeCoordinateEpoch=undefined;};
  function removeOwnedModel() {
    clearNativeCoordinates();
    if(!renderedModel)return;
    const model=renderedModel;renderedModel=null;modelMaterial=undefined;
    if(atomicDraw){atomicDraw.retire(model);return;}
    shapeResources.retireModel(model,()=>{
      // The adapter owns this one atom model, not arbitrary foreign models.
      // Locked GLViewer exposes removeModel; old unit doubles may only expose
      // removeAllModels, without changing the production ownership boundary.
      if(typeof viewer.removeModel==='function')viewer.removeModel(model);else viewer.removeAllModels();
    });
  }
  let displayTransform = identityTransform();
  const meshNotify=options.asyncMeshes?scheduleAsyncMeshes:undefined;
  const sceneShapes = createShapeLayer(viewer), orbitals = createOrbitalLayer(viewer, mol, meshNotify), surfaces = createSurfaceLayers(viewer, mol, meshNotify);
  const nativeBatches = nativePrimitiveBatchesAvailable(viewer, mol);
  const createPrimitiveLayers = () => ({
    rods: createNativePrimitiveBatch(viewer, mol, nativeCoordinateUpload),
    spheres: createNativePrimitiveBatch(viewer, mol),
    arrows: createNativePrimitiveBatch(viewer, mol),
  });
  const mainPrimitives = createPrimitiveLayers(), movingPrimitives = createPrimitiveLayers();
  const clearMovingPrimitives = () => { for (const layer of Object.values(movingPrimitives)) layer.clear(); };
  let orbitalLayer: ViewportOrbitalLayer | null = null;
  let ntoLayer: ViewportNtoLayer | null = null;
  let surfaceLayer: ViewportSurfaceLayer | null = null, surfaceExtrema: ViewportSurfaceExtrema | null = null;
  let surfaceLayers: readonly ViewportSurfaceLayer[] | undefined;
  let meshRefreshQueued=false;
  const meshWaiters=new Set<()=>void>();
  function wakeMeshes(){for(const wake of meshWaiters)wake();}
  async function awaitMeshes(signal?:AbortSignal):Promise<void>{
    while(!disposed&&(meshRefreshQueued||orbitals.pending()||surfaces.pending())){
      if(signal?.aborted)throw new DOMException('表面显示已取消。','AbortError');
      await new Promise<void>(resolve=>{
        const wake=()=>{meshWaiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};
        meshWaiters.add(wake);signal?.addEventListener('abort',wake,{once:true});
        if(signal?.aborted)wake();
      });
    }
    if(disposed||signal?.aborted)throw new DOMException('表面显示已取消。','AbortError');
  }
  function scheduleAsyncMeshes(){
    if(disposed||meshRefreshQueued)return;
    meshRefreshQueued=true;
    queueMicrotask(function refresh(){
      if(disposed)return;
      if(drawController){void drawTail.then(refresh);return;}
      meshRefreshQueued=false;
      try {
        renderSubmissions.run('surface-layer',()=>{
          let orbitalChanged=false;
          try{orbitalChanged=orbitals.sync(ntoLayer??orbitalLayer,currentDocument,displayTransform);}
          catch(error){if(orbitalLayer&&!ntoLayer)options.onAsyncMeshError?.(error);else orbitals.failSubmission(error);}
          const surfaceChanged=surfaceLayers===undefined?surfaces.sync(surfaceLayer,currentDocument,displayTransform):surfaces.syncLayers(surfaceLayers,currentDocument,displayTransform);
          if(orbitalChanged||surfaceChanged)viewer.render();
          surfaces.markSubmitted();orbitals.markSubmitted();
        });
      }catch(error){surfaces.failSubmission(error);orbitals.failSubmission(error);}
      try{options.onAsyncMeshState?.();}finally{wakeMeshes();}
    });
  }
  type ShapeTask={indices:readonly number[];paint:(raw:Atom[],preview:boolean)=>void;handles:Set<any>};
  type OwnedPrimitive<T> = { primitive: T; task: ShapeTask };
  type PrimitiveRows = { rods: OwnedPrimitive<NativeBatchRod>[]; spheres: OwnedPrimitive<NativeBatchSphere>[]; arrows: OwnedPrimitive<NativeBatchArrow>[] };
  function emptyPrimitiveRows(): PrimitiveRows { return { rods: [], spheres: [], arrows: [] }; }
  let publishedPrimitives = emptyPrimitiveRows();
  let collectingMovingPrimitives: PrimitiveRows | null = null;
  function* preparePrimitiveRows(rows: PrimitiveRows, settings: DisplaySettings, layers = mainPrimitives) {
    const key = JSON.stringify([settings.structureFinish, settings.structureLighting]);
    const rods = yield* layers.rods.prepareRods(rows.rods.map(row => row.primitive), key,
      shape => attachStructureShapeFinish(shape, settings.structureFinish, settings.structureLighting));
    const spheres = yield* layers.spheres.prepareSpheres(rows.spheres.map(row => row.primitive), key,
      shape => attachLocalMeshFinish(shape, settings.structureFinish, settings.structureLighting));
    const arrows = layers.arrows.prepareArrows(rows.arrows.map(row => row.primitive));
    return () => { rods(); spheres(); arrows(); };
  }
  let shapeTasks:ShapeTask[]=[],activeShapeTask:ShapeTask|null=null;
  let atomLabelHandles=new Map<number,any[]>(),regionLabelMoves:{indices:readonly number[];label:any;center:Vector3}[]=[];
  let lastDraw:{document:ModelDocument;settings:DisplaySettings;incoming:ViewerHighlights;preview?:Atom[];transform:RigidTransform;measurement?:MeasurementState;feedback:RenderFeedbackOptions}|null=null;
  let cipLease:object|undefined,cipRequestKey:object|undefined;
  let paintedCip=emptyCarbonCip.labels;
  let paintAtomLabels:(index:number,cip?:CarbonCipLabel)=>void=()=>{};
  const cipRequests=createCarbonCipRequests();
  let fragmentPreview:{documentId:string;revision:number;gestureId?:number;sampleGeneration:number;indices:number[];ids:Set<string>;raw:Atom[];tasks:ShapeTask[];staticProxyCount:number;model:any;cpu:any;baseModelSynced:boolean;periodic:Map<unknown,ReturnType<typeof periodicBondGlyphContext>>;instances:PeriodicDisplayInstance[];connections?:PeriodicDisplayConnectionContext;rotation?:FragmentRenderPreviewContext['rotation'];meshReference?:{coordinates:Vector3[];orientation:any;root:any}}|null=null;
  let atomBounds:RenderBounds|null=null;
  const primitiveLayers = [...Object.values(mainPrimitives), ...Object.values(movingPrimitives)];
  const depthEnvelope=retainViewerDepthEnvelope(viewer,() => unionRenderBounds(atomBounds,sceneShapes.bounds(),hoverShapes.bounds(),orbitals.bounds(),surfaces.bounds(),trajectoryLayer.bounds(),samplingSphereShapes.bounds(),calculationRangeShapes.bounds(),...primitiveLayers.map(layer => layer.bounds())));
  const keepScene=(shape:any)=>{if(!sceneShapes.has(shape))sceneShapes.keep(shape);if(shape)activeShapeTask?.handles.add(shape);return shape;};
  const sceneSequence=createSceneSequence({create:(method,spec)=>viewer[method](spec),translateArrow:translateNativeArrow,poseCylinder:poseNativeFlatCylinder,clear:()=>sceneShapes.clear(),remove:handles=>sceneShapes.remove(handles),handles:()=>sceneShapes.handles(),size:()=>sceneShapes.size,inventory:()=>Array.isArray(viewer.shapes)?viewer.shapes:undefined,refreshBounds:()=>sceneShapes.refreshBounds(),
    separateOpaqueBatch: shape => primitiveLayers.some(layer => layer.owns(shape)) });
  const constructScene=(method:SceneShapeMethod,spec:any,poseCylinder=false)=>sceneSequence.create(method,spec,false,poseCylinder);
  const sceneShape = (method: SceneShapeMethod, spec: any) => keepScene(constructScene(method,spec));
  type BondVisual={start:Vector3;end:Vector3;colors:[any,any];radius:number;cellClip?:{start:Vector3;end:Vector3;cell:PeriodicCell}};
  const bondVisuals = new Map<string,BondVisual[]>();
  const cellMeshSpec=(start:Vector3,end:Vector3,radius:number,cell:PeriodicCell)=>{const mesh=clippedCellCylinder(start,end,radius,cellRenderPlanes(cell));return{vertexArr:mesh.vertices.map(point),normalArr:mesh.normals.map(point),faceArr:mesh.faces};};
  const cachedViews = new Map<string, number[]>();
  const framedDocuments = new Set<string>();
  let hiddenAtoms=new Set<string>();
  let emptyPlacement: { documentId: string; baseRevision: number; nextRevision: number; view: number[] } | null = null;
  // A camera drag retains its initial pivot while dynamic frames keep arriving.
  const viewPivots = new WeakMap<number[], Vector3>();
  // Set the scale before the empty canvas can be picked. A first placement
  // inherits this same view rather than changing scale after the physical pick.
  viewer.setView(defaultEmptyModelView(viewer.getView()));
  const emptyView = [...viewer.getView()];
  const assertLive = () => { if (disposed) throw new Error('结构视图已关闭。'); };
  const initialBounds = container.getBoundingClientRect();
  // createViewer has already sized a visible host. Do not add a second first
  // render to the normal draw/pick path; hidden/stale projections still repair.
  const pixelRatio=()=>Math.max(2,realm.devicePixelRatio??1); // locked antialias/upscale policy
  let projectionSize=physicalViewportSize(initialBounds.width,initialBounds.height,pixelRatio());
  let layoutResizing=false;
  function synchronizeSize(force = false): boolean {
    assertLive(); const bounds = container.getBoundingClientRect();
    if (![bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) { projectionSize = null; return false; }
    if((layoutResizing||resizeSettler.pending())&&!force)return true;
    const canvas = viewer.getCanvas?.();
    const nativeSizeLost = canvas && (canvas.width <= 0 || canvas.height <= 0);
    const next=physicalViewportSize(bounds.width,bounds.height,pixelRatio());
    if (force || nativeSizeLost || !samePhysicalViewportSize(projectionSize,next)) {
      // Locked GLViewer.resize already shows a healthy context, or performs
      // its own full render on recovery. Do not submit the same resize twice.
      renderSubmissions.run('resize',()=>viewer.resize()); projectionSize=next;
    }
    return true;
  }
  let deferredResizeError:unknown;
  const resizeSettler=createViewportResizeSettler(callback=>(realm.setTimeout?realm.setTimeout(callback,100):globalThis.setTimeout(callback,100)) as unknown as number,id=>{if(realm.clearTimeout)realm.clearTimeout(id);else globalThis.clearTimeout(id);},()=>{deferredResizeError=undefined;try{synchronizeSize();}catch(error){deferredResizeError=error;}});
  function setLayoutResizing(active:boolean){
    if(disposed||layoutResizing===active)return;layoutResizing=active;
    if(active){const canvas=viewer.getCanvas?.();if(canvas?.style){canvas.style.width='100%';canvas.style.height='100%';}}
    else if(!resizeSettler.flush())synchronizeSize();
  }
  // Every owned renderer participates, including the tool/fragment preview
  // whose width can change with the same public sidebar divider.
  const resizeOwners=[container.closest?.<HTMLElement>('[data-testid="model-document-deck"]'),container.closest?.<HTMLElement>('[data-testid="workspace-v18"]')].filter((value):value is HTMLElement=>Boolean(value));
  const acceptLayoutResize=()=>setLayoutResizing(resizeOwners.some(owner=>owner.dataset.layoutResizing==='true'));
  for(const owner of resizeOwners)owner.addEventListener(VIEWPORT_LAYOUT_RESIZE_EVENT,acceptLayoutResize);acceptLayoutResize();
  const screenProject = (position: Vector3): ScreenPoint => {
    if (!position.every(Number.isFinite)) throw new ViewportProjectionError('invalid-projection', '投影坐标必须是有限数值。');
    if (!synchronizeSize()) throw new ViewportProjectionError('viewport-unavailable', '视口尚未具备可用尺寸，请在视口显示后重试。');
    let result = viewer.modelToScreen(point(position));
    if (![result.x, result.y].every(Number.isFinite)) { synchronizeSize(true); result = viewer.modelToScreen(point(position)); }
    if (![result.x, result.y].every(Number.isFinite)) throw new ViewportProjectionError('invalid-projection', '当前视角的屏幕投影无效。');
    return { x: result.x - realm.scrollX, y: result.y - realm.scrollY };
  };
  const project = (position: Vector3) => screenProject(transformPoint(displayTransform, position));
  const projectMany = (points:readonly Vector3[]):ScreenPoint[] => {
    if(!points.length)return [];
    if(points.some(value=>!value.every(Number.isFinite)))throw new ViewportProjectionError('invalid-projection','投影坐标必须是有限数值。');
    if(!synchronizeSize())throw new ViewportProjectionError('viewport-unavailable','视口尚未具备可用尺寸，请在视口显示后重试。');
    const coordinates=points.map(value=>point(transformPoint(displayTransform,value)));
    let results=viewer.modelToScreen(coordinates);
    if(!Array.isArray(results))return points.map(project);
    const complete=(rows:ScreenPoint[])=>rows.length===points.length&&rows.every(value=>Number.isFinite(value.x)&&Number.isFinite(value.y));
    if(!complete(results)){synchronizeSize(true);results=viewer.modelToScreen(coordinates);}
    if(!Array.isArray(results)||!complete(results))throw new ViewportProjectionError('invalid-projection','当前视角的屏幕投影无效。');
    return results.map(value=>({x:value.x-realm.scrollX,y:value.y-realm.scrollY}));
  };
  const plane = (origin: Vector3): DragPlane => {
    let displayed: DragPlane;
    try { displayed = dragPlane(screenProject, transformPoint(displayTransform, origin), viewer.getView().slice(4, 8)); }
    catch (error) {
      if (!(error instanceof ViewportProjectionError) || error.code !== 'invalid-projection' || !synchronizeSize(true)) throw error;
      // One refresh repairs a stale native projection after show/resize. A
      // still-singular plane remains an error; no camera reset or fallback XYZ.
      displayed = dragPlane(screenProject, transformPoint(displayTransform, origin), viewer.getView().slice(4, 8));
    }
    return { ...displayed, origin: [...origin], right: inverseRotate(displayTransform.rotation, displayed.right), up: inverseRotate(displayTransform.rotation, displayed.up) };
  };
  const origin = () => {
    const ids=currentDocument?.selection.atomIds;
    if(!ids?.length)return displayedCentroid();
    const selected=new Set(ids),atoms=positions.filter(atom=>selected.has(atom.id!));
    return atoms.length?centroid(atoms):displayedCentroid();
  };
  const inside = (screen: ScreenPoint) => {
    const bounds = container.getBoundingClientRect();
    return [screen.x, screen.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0 && screen.x >= bounds.left && screen.x <= bounds.right && screen.y >= bounds.top && screen.y <= bounds.bottom;
  };
  const hitTest = (screen: ScreenPoint, includeReadOnlyImages=false): PickResult => {
    assertLive();
    resizeSettler.flush();
    if(layoutResizing)synchronizeSize(true);
    if (!inside(screen) || !synchronizeSize()) return { kind: 'none' };
    const bounds = container.getBoundingClientRect();
    const targets=atomicDraw?.publishedProxies??proxies, images=atomicDraw?.publishedImageProxies??imageProxies;
    const x=(screen.x - bounds.left) * 2 / bounds.width - 1, y=1 - (screen.y - bounds.top) * 2 / bounds.height;
    const candidates=basePicking.candidates(targets,viewer,x,y);
    const hits = viewer.targetedObjects(x,y,includeReadOnlyImages&&images.length?candidates.concat(imagePicking.candidates(images,viewer,x,y)):candidates);
    const hit = hits.find((entry: any) => Number.isFinite(entry.distance) && entry.distance >= 0 && entry.clickable?.ref);
    return hit ? hit.clickable.ref : { kind: 'none' };
  };
  const worldPoint = (screen: ScreenPoint): Vector3 => {
    resizeSettler.flush();
    if(layoutResizing)synchronizeSize(true);
    if (!inside(screen)) throw new ViewportProjectionError('viewport-unavailable', '落点必须位于当前可见视口内。');
    const result = planePoint(plane(inversePoint(displayTransform, origin())), screen);
    if (!result.every(Number.isFinite)) throw new ViewportProjectionError('invalid-projection', '当前视角无法建立有效的放置坐标。');
    return result;
  };
  function projectionReady(): boolean {
    if (!synchronizeSize()) return false;
    const q = viewer.getView().slice(4, 8), norm = Math.hypot(...q);
    if (q.length !== 4 || !q.every(Number.isFinite) || !Number.isFinite(norm) || norm < 1e-12) return false;
    const inverse = q.map((value: number, index: number) => (index < 3 ? -value : value) / norm), center = origin();
    try {
      const base = screenProject(center), right = screenProject(add(center, rotateVector([1, 0, 0], inverse))), up = screenProject(add(center, rotateVector([0, 1, 0], inverse)));
      return Math.abs((right.x - base.x) * (up.y - base.y) - (up.x - base.x) * (right.y - base.y)) >= 1e-10;
    } catch (error) { if (error instanceof ViewportProjectionError) return false; throw error; }
  }
  const sphere = (center: Vector3, radius: number) => new mol.Sphere(new mol.Vector3(...center), radius);
  const cylinder = (start: Vector3, end: Vector3, radius: number) => new mol.Cylinder(new mol.Vector3(...start), new mol.Vector3(...end), radius);
  const proxy = (ref: PickResult, shapes: { sphere?: any[]; cylinder?: any[]; line?: any[]; triangle?:any[] }) => ({ ref, intersectionShape: { sphere: [], cylinder: [], line: [], triangle: [], ...shapes } });
  function renderTask(indices:readonly number[],paint:ShapeTask['paint'],raw:Atom[]){if(indices.some(i=>hiddenAtoms.has(raw[i]?.id!)))return;const task={indices,paint,handles:new Set<any>()};shapeTasks.push(task);activeShapeTask=task;try{paint(raw,false);}finally{activeShapeTask=null;}}
  function* renderTaskWork(indices:readonly number[],paint:(raw:Atom[],preview:boolean)=>RenderWork<void>,raw:Atom[]):RenderWork<void>{if(indices.some(i=>hiddenAtoms.has(raw[i]?.id!)))return;const task={indices,paint:(value:Atom[],preview:boolean)=>finishRenderWork(paint(value,preview)),handles:new Set<any>()};shapeTasks.push(task);activeShapeTask=task;try{yield* paint(raw,false);}finally{activeShapeTask=null;}}
  function clearHover() {
    // Hover owns only independent shapes. Reapplying an unchanged atom style
    // would invalidate the native model mesh and regenerate its pick bounds.
    hoverShapes.clear(); hoverKey = '';
  }
  function atomOutline(index:number) {
    const radii=(atomPickProxies.get(index)?.intersectionShape.sphere??[]).map((sphere:any)=>sphere.radius);
    const radius=radii.length?Math.max(...radii):.17;
    return {center:point(coordinates(positions[index])),radius:radius+.045,color:MODEL_HOVER_COLOR,opacity:.8,wireframe:true,linewidth:2.6};
  }
  function bondOutlines(key:string){
    return (bondVisuals.get(key)??[]).map(visual=>{const radius=visual.radius+.045,appearance={color:MODEL_HOVER_COLOR,opacity:.8,wireframe:true,linewidth:2.6},clip=visual.cellClip;
      return clip&&needsObliqueCellCap(visual.start,visual.end,clip.start,clip.end,cellRenderPlanes(clip.cell))?{method:'addCustom' as const,spec:{...cellMeshSpec(clip.start,clip.end,radius,clip.cell),...appearance}}:{method:'addCylinder' as const,spec:{start:point(visual.start),end:point(visual.end),radius,...appearance,fromCap:1,toCap:1}};
    });
  }
  function hover(pick: PickResult) {
    assertLive();
    const key = pick.kind === 'atom' ? 'atom:' + pick.atomId : pick.kind === 'bond' ? 'bond:' + bondRefKey(pick) : pick.kind === 'port' ? 'port:' + pick.portId : pick.kind==='auxiliary'?'auxiliary:'+pick.relationId:'';
    if (key === hoverKey) return;
    clearHover(); hoverKey = key;
    // A displayed analysis target already owns this exact outline. Hover adds
    // only another target, never a second shell over the same atom/bond.
    if(displayHoverKeys.has(key)){viewer.render();return;}
    if (pick.kind === 'atom') {
      const index = modelMaterial?.layout.indices.get(pick.atomId);
      if (index !== undefined && baseAtomStyles[index]) {
        // A translucent shell supplies a visible silhouette without changing
        // the native model style, rendered sphere bounds or ray-pick proxies.
        hoverShapes.keep(viewer.addSphere(atomOutline(index)));
        for(const instance of mirrorInstances)if(instance.sourceIndex===index)hoverShapes.keep(viewer.addSphere({...atomOutline(index),center:point(transformPoint(displayTransform,instance.position))}));
      }
    } else if (pick.kind === 'bond' || pick.kind === 'port'||pick.kind==='auxiliary') {
      for (const outline of bondOutlines(pick.kind === 'port' ? 'port:' + pick.portId : pick.kind==='auxiliary'?'auxiliary:'+pick.relationId:bondRefKey(pick))) hoverShapes.keep(viewer[outline.method](outline.spec));
    }
    // No model/proxy rebuild, framing, selection or document transaction.
    viewer.render();
  }
  function resetViewContent() {
    assertLive();
    emptyPlacement = null;
    if (fixedViewCell) {
      const center=viewPivot(), bounds=container.getBoundingClientRect();
      const radius=Math.max(...cellSegments(fixedViewCell).flatMap(edge=>edge.map(corner=>Math.hypot(...subtract(corner,center)))));
      // Locked 3Dmol orthographic half-width is viewing distance × tan(FOV).
      // Fit the fixed cell once, using room for the complete cell at any angle.
      const aspect=bounds.height>0?bounds.width/bounds.height:1;
      const halfWidth=1.1*radius*Math.max(1,aspect);
      const fov=(viewer.camera?.fov??20)*Math.PI/180;
      const z=(viewer.camera?.position?.z??150)-Math.max(1,halfWidth/Math.tan(fov));
      const view=rotateObjectView([...scale(center,-1),z,...emptyView.slice(4)],-30,37.5,center);
      viewer.setView(view);
    } else {
      viewer.setView([...emptyView]);
      // Fit the current owned atom model. Analysis layers do not set its scale.
      if (positions.length) { viewer.zoomTo({ model: renderedModel }); viewer.rotate(15, 'x'); viewer.rotate(-12, 'y'); viewer.zoom(positions.length < 20 ? 1.45 : 1.05); }
    }
    if (currentId && positions.length) { framedDocuments.add(currentId); cachedViews.set(currentId, [...viewer.getView()]); }
    viewer.render();
  }
  const resetView=()=>renderSubmissions.run('reset-view',resetViewContent);
  function* drawContent(document: ModelDocument, settings: DisplaySettings, incoming: ViewerHighlights = {}, preview?: Atom[], transform = identityTransform(), measurement?: MeasurementState, feedback: RenderFeedbackOptions = {},cooperative=false):RenderWork<void> {
    assertLive();
    const cipSource=settings.stereochemistry?cipStructureForDisplay(document.draft.structure,feedback.cipStructure):undefined;
    if(cipSource&&cooperative&&!feedback.liveCip)yield signal=>prepareCarbonCipLabels(cipSource,signal);
    const preparedCip=carbonCipSource(cipSource);
    const cipLabels=settings.stereochemistry&&!feedback.cipGeometryPreview?(preparedCip?.result??preparedCip?.failure)?.labels??emptyCarbonCip.labels:emptyCarbonCip.labels;
    hiddenAtoms=displayHiddenAtomIds(feedback.hiddenAtomIds,document.draft.structure);
    const nextBackground = feedback.capturePurpose ? CAPTURE_BACKGROUND_COLOR : feedback.linkedAtomsActive ? LINKED_BACKGROUND_COLOR : settings.backgroundColor??viewportDefaultBackgroundColor(container);
    if (background !== nextBackground) {
      if (typeof viewer.setBackgroundColor !== 'function') throw new Error('渲染器缺少交互式选择背景接口。');
      viewer.setBackgroundColor(nextBackground, options.backgroundAlpha??1); background = nextBackground;
      if(fadeStrength>0)viewer.enableFog?.(depthFadeFog(fadeStrength));
    }
    const nextFade=depthFadeAmount(settings.depthFade);
    if(nextFade!==fadeStrength){viewer.enableFog?.(depthFadeFog(nextFade));fadeStrength=nextFade;}
    clearHover(); displayHoverKeys.clear(); bondVisuals.clear();
    const priorView = initialized ? viewer.getView() : null;
    if (currentId && initialized) cachedViews.set(currentId, priorView!);
    const switched = currentId !== document.id;
    if(switched){basePicking.dispose();imagePicking.dispose();}
    else {basePicking.invalidate();imagePicking.invalidate();}
    const retainPlacement = !switched && positions.length === 0 && emptyPlacement?.documentId === document.id && currentDocument?.revision === emptyPlacement.baseRevision && document.revision === emptyPlacement.nextRevision;
    const placementView = retainPlacement ? emptyPlacement!.view : null;
    emptyPlacement = null;
    currentId = document.id; currentDocument = document;
    const sourceCell=document.draft.structure.cell;
    fixedViewCell=feedback.fixedCellView&&sourceCell?.pbc.some(Boolean)?sourceCell:undefined;
    if(fixedViewCell)transform=identityTransform();
    let activeTransform = identityTransform();
    if (feedback.multiframeDisplay) {
      try {
        validateMultiframeDisplayPlan(feedback.multiframeDisplay);
        const active = feedback.multiframeDisplay.frames.find(frame => frame.key === feedback.multiframeDisplay!.activeFrameKey)!;
        const activeAtoms=active.structure.atoms, shownAtoms=document.draft.structure.atoms;
        if(activeAtoms!==shownAtoms){
          const byId = new Map(activeAtoms.map(atom => [atom.id, atom]));
          if (activeAtoms.length !== shownAtoms.length || shownAtoms.some(atom => {
            const source = byId.get(atom.id); return !source || atom.element !== source.element || atom.x !== source.x || atom.y !== source.y || atom.z !== source.z;
          })) throw new Error('当前帧与叠合计划不一致，请更新当前显示帧；未改用其他帧。');
        }
        if(!fixedViewCell)activeTransform = active.transform;
      } catch (error) { trajectoryLayer.clear(); samplingSphereShapes.clear(); throw error; }
    }
    displayTransform = composeTransforms(transform, activeTransform);
    const rawPositions = preview ?? document.draft.structure.atoms;
    positions = transformAtoms(rawPositions, displayTransform);
    atomBounds=null;for(const atom of positions)atomBounds=includeRenderPoint(atomBounds,coordinates(atom),atomRadius(atom.element,settings));
    const highlights = modelHighlights(document, incoming, feedback.displayFrozenAtomIds), regions = colorRegions(settings, highlights), colored = settings.regionHighlights ? regions : [];
    // A vibration is an explicit display-only projection of this document.
    // Standalone analysis windows do not carry the modeling registry epoch.
    const sceneOwner=feedback.sceneOwnerEpoch??(feedback.vibrationVectors?.length?'vibration-display':null);
    sceneSequence.begin(sceneOwner?JSON.stringify([document.id,sceneOwner]):null,settings,Boolean(atomicDraw)); labels.clear(); proxies = [];imageProxies=[];atomPickProxies=new Map();
    shapeTasks=[];atomLabelHandles=new Map();regionLabelMoves=[];
    const structure = document.draft.structure;
    const primitiveRows = emptyPrimitiveRows();
    // A compact unit cell can have hundreds of opaque boundary rods. Use the
    // same native batch regardless of atom count, retaining the matching picks.
    const batchPeriodic = nativeBatches && structure.cell?.pbc.some(Boolean);
    const batchVibration = nativeBatches && (feedback.vibrationVectors?.length ?? 0) >= 128;
    const periodicSettings=periodicDisplaySettings(settings);
    const periodicLayout=structure.cell?.pbc.some(Boolean)&&(periodicSettings.images||periodicSettings.showCrossBoxBonds&&settings.showBonds!==false&&settings.representation!=='vdw'&&structure.bonds?.some(bond=>bond.image?.some(Boolean)));
    const periodicInstances=periodicLayout?yield* periodicDisplayInstancesWork(structure,rawPositions,settings,hiddenAtoms):[];
    const periodicConnections=periodicLayout?yield* preparePeriodicDisplayConnectionsWork(structure,rawPositions,periodicInstances,settings):undefined;
    mirrorInstances = periodicInstances.filter(instance=>!instance.base);
    const layout=molecularLayout(modelMaterial?.layout,document.id,rawPositions,structure);
    const atomIndices=layout.indices, captureActive=feedback.displayCaptureAtomIds!==undefined;
    const selectedIds=feedback.displayCaptureAtomIds??document.selection.atomIds;
    const selectedBonds = new Set(captureActive?[]:document.selection.bonds.map(bondRefKey));
    const userMeasurementRecords=settings.measurementMarks?measurement?.records??[]:[];
    const frozenIndices=settings.frozenMarks?highlights.frozenAtoms:undefined;
    const scalarValues = validScalarValues(feedback.atomScalarValues ?? [], positions.length);
    const scalarLabels = new Map(feedback.atomScalarLabels ? (feedback.atomScalarValues ?? []).filter(row=>scalarValues.has(row.atomIndex) && row.label?.trim()).map(row=>[row.atomIndex,row.label!.trim()]) : []);
    // Styles and native adjacency belong to the topology and appearance.
    // Coordinate-only frames reuse them even with new immutable atom objects.
    const appearance=JSON.stringify([settings.representation,settings.atomScale,settings.elementScales,settings.elementColors,
      settings.bondScale,settings.bondStyle,settings.structureSizing,settings.structureFinish,settings.structureLighting,settings.showBonds!==false,
      colored,frozenIndices,selectedIds,[...hiddenAtoms],feedback.previewGuides?.dimAtomIds,feedback.atomScalarColor,feedback.atomScalarValues,
      userMeasurementRecords.map(row=>[row.atomIds,row.color]),settings.measurementMarks&&measurement?.mode?measurement.atomIds:undefined]);
    let nextMaterial=modelMaterial;
    if(nextMaterial?.layout!==layout||nextMaterial.appearance!==appearance){
      const memberships=colored.length?regionMembership(positions.length,colored).memberships:undefined;
      const scalarRange=feedback.atomScalarColor===false?null:viewportAtomScalarRange(feedback.atomScalarValues??[],positions.length);
      const scalarColors=new Map((feedback.atomScalarValues??[]).filter(row=>scalarValues.has(row.atomIndex)&&/^#[0-9a-f]{6}$/i.test(row.color??'')).map(row=>[row.atomIndex,row.color!]));
      const measurementColors=new Map<string,string>();
      for(const record of userMeasurementRecords)for(const id of record.atomIds)if(!measurementColors.has(id))measurementColors.set(id,record.color??MEASUREMENT_COLOR);
      if(settings.measurementMarks&&measurement?.mode)for(const id of measurement.atomIds)if(!measurementColors.has(id))measurementColors.set(id,MEASUREMENT_COLOR);
      const selected=new Set(selectedIds),frozen=new Set(frozenIndices),dimmed=new Set(feedback.previewGuides?.dimAtomIds);
      const styles=positions.map((atom,index)=>{
        if(hiddenAtoms.has(atom.id!))return {};
        const members=memberships?.[index];
        const color=scalarRange&&scalarValues.has(index)?scalarColors.get(index)??scalarColor(scalarValues.get(index)!,scalarRange)
          :(feedback.atomScalarValues===undefined||feedback.atomScalarColor===false)&&members?.length?membershipColor(members):elementColor(atom.element,settings.elementColors);
        const mark=selected.has(atom.id!)?SELECTION_COLOR:frozen.has(index)?FREEZE_COLOR:measurementColors.get(atom.id!);
        const style=structureAtomStyle(settings,atom.element,color,mark);
        if(dimmed.has(atom.id!))for(const value of Object.values(style))Object.assign(value,{opacity:.22});
        return style;
      });
      nextMaterial={layout,appearance,styles};
    }
    const atomStyles=nextMaterial.styles;
    const reuseCoordinates=positions.length>0&&renderedModel&&nextMaterial===modelMaterial&&typeof renderedModel.setCoordinates==='function'&&typeof renderedModel.setFrame==='function';
    let coordinatesUnchanged=false;
    let updateNativeBuffers:(()=>boolean)|undefined;
    let nextNativeCoordinates:Vector3[]|undefined;
    if (reuseCoordinates) {
      coordinatesUnchanged=Boolean(feedback.sceneOwnerEpoch)&&nativeCoordinateEpoch===feedback.sceneOwnerEpoch&&nativeCoordinates!==null&&sameNativeCoordinates(positions,nativeCoordinates);
      if(!coordinatesUnchanged){
        const coords=nextNativeCoordinates=positions.map(coordinates),mesh=renderedModel.renderedMolObj;
        if(mesh&&typeof mesh==='object'){
          if(!nativeBufferBindings.has(mesh))nativeBufferBindings.set(mesh,bindNativeCoordinateBuffers(renderedModel,nativeCoordinateUpload));
          const update=nativeBufferBindings.get(mesh);
          if(update)updateNativeBuffers=()=>update(coords);
        }
        if(!updateNativeBuffers){renderedModel.setCoordinates([coords], 'array');void renderedModel.setFrame(0);}
      }
    } else {
      // Connectivity is material metadata. A coordinate-only frame does not
      // consume or change it, so build native adjacency only with the model.
      removeOwnedModel(); renderedModel = createOwnedMolecularModel(settings);
      renderedModel.addAtoms(frameModelAtoms(structure, positions,hiddenAtoms,settings.showBonds!==false,settings));
      applyResolvedAtomStyles(renderedModel, atomStyles, (index, style) => {
        if(typeof renderedModel.setStyle==='function')renderedModel.setStyle({index},style);
        else viewer.setStyle({index,model:renderedModel},style);
      });
    }
    if(feedback.sceneOwnerEpoch){if(!coordinatesUnchanged)nativeCoordinates=nextNativeCoordinates??positions.map(coordinates);nativeCoordinateEpoch=feedback.sceneOwnerEpoch;}else clearNativeCoordinates();
    modelMaterial = nextMaterial;
    // Explicit clickability rebuilds the locked backend's actual sphere bounds.
    const setNativeClickable=()=>{
      if(typeof renderedModel.setClickable==='function')renderedModel.setClickable({},true,()=>{});
      else viewer.setClickable({model:renderedModel},true,()=>{});
      for(let i=0;i<positions.length;i++)if(hiddenAtoms.has(positions[i].id!)){if(typeof renderedModel.setClickable==='function')renderedModel.setClickable({index:i},false,()=>{});else viewer.setClickable({model:renderedModel,index:i},false,()=>{});}
    };
    if(!coordinatesUnchanged&&!updateNativeBuffers)setNativeClickable();
    const model = renderedModel;
    const mirrorGroups=new Map<number,PeriodicDisplayInstance[]>();for(const instance of mirrorInstances){const group=mirrorGroups.get(instance.sourceIndex)??[];group.push(instance);mirrorGroups.set(instance.sourceIndex,group);}
    for(const index of periodicSettings.images&&structure.cell?.pbc.some(Boolean)?rawPositions.map((_,index)=>index):mirrorGroups.keys()){yield;
      renderTask([index],(raw,preview)=>{
        const movedImages=preview?fragmentPreview?.connections?.bySource.get(index):undefined;
        const instances=preview?movedImages?.map(entry=>entry.instance)??[]:mirrorGroups.get(index)??[];
        for(const instance of instances){
        if(instance.base)continue;
        const position=transformPoint(displayTransform,add(coordinates(raw[index]),fractionalToCartesian(structure.cell!,instance.image,false)));
        const style=atomStyles[index].sphere??atomStyles[index].stick;
        const spec = {center:point(position),radius:atomRadius(raw[index].element,settings),color:style.color,opacity:style.opacity??1,clickable:false,hoverable:false};
         if(!preview&&spec.opacity>0)imageProxies.push(proxy({kind:'atom',atomId:raw[index].id!,image:instance.image},{sphere:[sphere(position,spec.radius)]}));
        const target = preview ? collectingMovingPrimitives : batchPeriodic ? primitiveRows : null;
        if (target && spec.opacity === 1 && activeShapeTask) {
          target.spheres.push({ primitive: spec, task: activeShapeTask });
        } else attachLocalMeshFinish(sceneShape('addSphere', spec), settings.structureFinish, settings.structureLighting);
        if(settings.vdwShell)attachLocalMeshFinish(sceneShape('addSphere',{center:point(position),radius:mol.GLModel?.vdwRadii?.[raw[index].element]??1.5,color:settings.vdwShell.color,opacity:settings.vdwShell.opacity,clickable:false,hoverable:false}),structureShellFinish(settings));
        }
      },rawPositions);
    }
    // Independent display layer; these are renderer VDW spheres, never density
    // or a second selectable model. The core retains its chosen representation.
    if(settings.vdwShell) for(let i=0;i<positions.length;i++)if(!hiddenAtoms.has(positions[i].id!)){
      yield;
      renderTask([i],()=>attachLocalMeshFinish(sceneShape('addSphere',{center:point(coordinates(positions[i])),radius:mol.GLModel?.vdwRadii?.[positions[i].element]??1.5,color:settings.vdwShell!.color,opacity:settings.vdwShell!.opacity,clickable:false,hoverable:false}),structureShellFinish(settings)),rawPositions);
    }
    let rendered = Array.isArray(model.atoms)&&model.atoms.length===positions.length?model.atoms:model.selectedAtoms({});
    if (!reuseCoordinates) baseAtomStyles = rendered.map((atom: any) => structuredClone(atom.style));
    paintedCip=cipLabels;
    paintAtomLabels=(i,cip)=>{
      const atom=positions[i];if(!atom||hiddenAtoms.has(atom.id!))return;
      if (settings.atomNumbers || settings.elementNames || cip) {
        const materialColor = baseAtomStyles[i]?.sphere?.color ?? baseAtomStyles[i]?.stick?.color ?? elementColor(atom.element, settings.elementColors);
        const atomText=modelAtomLabel(atom,i,settings),text=cip?`${atomText}${atomText?' ':''}(${cip})`:atomText;
        const handle=labels.add(text, { position: point(coordinates(atom)), alignment: 'center', bold: true, fontSize: settings.fontSize, fontColor: atomLabelFontColor(materialColor), fontOpacity: 1, backgroundOpacity: 0, showBackground: false, borderThickness: 0, inFront: true }, undefined, true);if(handle)atomLabelHandles.set(i,[handle]);
      }
      if (scalarLabels.has(i)){const handle=labels.add(scalarLabels.get(i), { position: point(coordinates(atom)), alignment: 'center', screenOffset: { x: 0, y: settings.atomNumbers || settings.elementNames || cip ? -19 : 0 }, bold: true, fontSize: settings.fontSize, fontColor: '#153846', backgroundOpacity: .8, backgroundColor: 'white', showBackground: true, borderThickness: 0, inFront: true }, undefined, true);if(handle)atomLabelHandles.set(i,[...(atomLabelHandles.get(i)??[]),handle]);}
    };
    for(const [i,atom] of positions.entries()) {
      yield;if(hiddenAtoms.has(atom.id!))continue;
      const target=proxy({ kind: 'atom', atomId: atom.id! }, { sphere: [sphere(coordinates(atom), atomRadius(atom.element, settings))] });proxies.push(target);atomPickProxies.set(i,target);
      paintAtomLabels(i,cipLabels.get(i));
    }
    // Native scene shapes rotate/project/capture with the molecule. They have
    // no editable atom, pick proxy or playback phase of their own.
    const vibrationAtoms = new Set<number>();
    for (const row of feedback.vibrationVectors ?? []) {
      const atomIndex = row.atomId !== undefined ? atomIndices.get(row.atomId) : row.atomIndex;
      if (atomIndex === undefined || !Number.isInteger(atomIndex) || atomIndex < 0 || atomIndex >= positions.length || vibrationAtoms.has(atomIndex) || !Array.isArray(row.vector) || row.vector.length !== 3 || !row.vector.every(Number.isFinite)) continue;
      renderTask([atomIndex],(_raw, preview)=>{
      const start = coordinates(positions[atomIndex]), displacement = rotate(displayTransform.rotation, row.vector), end = add(start, displacement);
      if (![...start, ...end].every(Number.isFinite) || Math.hypot(...displacement) < 1e-10) return;
      vibrationAtoms.add(atomIndex);
      const look=normalizeVibrationVectorAppearance(row.appearance);
      const target = preview ? collectingMovingPrimitives : batchVibration ? primitiveRows : null;
      if (target && activeShapeTask) {
        target.arrows.push({ primitive: { start: point(start), displacement, ...look }, task: activeShapeTask });
      } else keepScene(sceneSequence.create('addArrow', { start: point(start), end: point(end), ...look, clickable: false, hoverable: false },true));
      },rawPositions);
    }
    const dipole = feedback.dipoleVector;
    if (dipole && [...dipole.origin, ...dipole.vector].every(Number.isFinite) && Math.hypot(...dipole.vector) > 1e-10) {
      const start = transformPoint(displayTransform, dipole.origin), end = add(start, rotate(displayTransform.rotation, dipole.vector));
      sceneShape('addArrow', { start: point(start), end: point(end), radius: .045, radiusRatio: 2.5, mid: .78, color: dipole.color ?? '#bd4f96', clickable: false, hoverable: false });
    }
    const displayCell=(cell:PeriodicCell):PeriodicCell=>({...cell,vectors:cell.vectors.map(v=>rotate(displayTransform.rotation,v)) as [Vector3,Vector3,Vector3],origin:transformPoint(displayTransform,cell.origin??[0,0,0])});
    const { drawCappedRod, drawColoredRod, paintSpecialBondWork } = createFrameBondPainter(viewer, keepScene, periodicBondGlyphs,()=>settings.structureFinish,constructScene,()=>settings.structureLighting,
      spec => {
        const target = fragmentPreview ? collectingMovingPrimitives : batchPeriodic ? primitiveRows : null;
        if (!target || !activeShapeTask || spec.opacity !== 1) return false;
        target.rods.push({ primitive: spec, task: activeShapeTask });
        return true;
      });
    if(cooperative&&!preview&&settings.representation!=='vdw'&&settings.showBonds!==false)yield signal=>periodicBondGlyphs.prepareBatchAsync(structure,rawPositions,atomStyles,periodicDisplaySettings(settings).images,signal);
    for (const bond of structure.bonds ?? [])yield* renderTaskWork([bond.a,bond.b],function*(rawPositions,preview){
      // Space filling hides bond presentation only, never scientific graph or
      // selection. Invisible rods have no independent pick/hover geometry.
      if (settings.representation === 'vdw'||settings.showBonds===false||bond.image?.some(Boolean)&&!periodicDisplaySettings(settings).showCrossBoxBonds) return;
      const a = positions[bond.a], b = positions[bond.b]; if (!a || !b) return;
      const ref = { kind: 'bond' as const, atomIds: [a.id!, b.id!] as [string, string], ...(bond.image ? { image: bond.image } : {}) };
      const visuals:BondVisual[] = [];
      const atomColor = (index: number) => baseAtomStyles[index]?.stick?.color ?? elementColor(positions[index].element, settings.elementColors);
      const nativeGlyph=periodicGlyphRequired(structure,bond);
      const finiteGlyph=preview&&!nativeGlyph&&!bond.image?.some(Boolean)&&!bondConnectionOnly(bond)&&bond.order!==.5&&(bond.order>1||bond.aromatic);
      yield* paintSpecialBondWork({ structure, bond, rawPositions, transform: displayTransform, settings, atomStyles, atomColor,cooperative:cooperative&&!preview,
        preview, finiteGlyph, prepared: preview ? fragmentPreview?.periodic.get(bond) : undefined, instances: preview ? fragmentPreview?.instances : periodicInstances, connectionContext: preview ? fragmentPreview?.connections : periodicConnections,
        onGeometry:geometry=>{const {base,...visual}=geometry;visuals.push(visual);if(base)proxies.push(proxy(ref,{cylinder:[cylinder(visual.start,visual.end,visual.radius)]}));} });
      if(structure.cell?.pbc.some(Boolean)&&(bond.image?.some(Boolean)||periodicDisplaySettings(settings).images)){
        if(selectedBonds.has(bondRefKey(ref)))for(const visual of visuals)drawCappedRod(visual.start,visual.end,Math.max(visual.radius,.19*displayScale(settings.bondScale)),'#d29c38',1,1,undefined,.72);
        bondVisuals.set(bondRefKey(ref),visuals);return;
      }
      if(finiteGlyph){const result=fragmentPreview!.cpu.exportBondPrimitives(bond.a,bond.b,'stick');for(const primitive of result.primitives){if(primitive.kind==='line')sceneShape('addLine',{start:primitive.start,end:primitive.end,color:primitive.color,linewidth:2});else drawCappedRod([primitive.start.x,primitive.start.y,primitive.start.z],[primitive.end.x,primitive.end.y,primitive.end.z],primitive.radius,primitive.color,primitive.fromCap,primitive.toCap);}}
      const physicalSections=yield* bondPathSectionsWork(rawPositions,bond,structure.cell);
      const physicalLength=physicalSections.reduce((sum,section)=>sum+Math.hypot(...section.end.map((v,i)=>v-section.start[i])),0);
      const clipCell=structure.cell&&bond.image?.some(Boolean)?displayCell({...structure.cell,pbc:structure.cell.pbc.map((enabled,axis)=>enabled&&!!bond.image?.[axis]) as [boolean,boolean,boolean]}):undefined;
      for (const section of physicalSections) {
        yield;
        const first=transformPoint(displayTransform,section.start),last=transformPoint(displayTransform,section.end);
        const radius=(bond.order > 1 ? .24 : settings.representation === 'stick' ? .125 : .145) * displayScale(settings.bondScale);
        if(clipCell){
          const at=(t:number)=>first.map((value,axis)=>value+(last[axis]-value)*(t-section.t0)/(section.t1-section.t0)) as Vector3,mesh=clippedCellCylinder(at(0),at(1),radius,cellRenderPlanes(clipCell));
          if(typeof mol.Triangle!=='function')throw new Error('周期实心截端拾取需要锁定渲染器的Triangle接口。');
          const triangles=[];for(let face=0;face<mesh.faces.length;face+=3)triangles.push(new mol.Triangle(...mesh.faces.slice(face,face+3).map(index=>new mol.Vector3(...mesh.vertices[index]))));
          let bounds:RenderBounds|null=null;for(const vertex of mesh.vertices)bounds=includeRenderPoint(bounds,vertex);
          const center=bounds?bounds.min.map((value,axis)=>(value+bounds!.max[axis])/2) as Vector3:first;
          proxies.push({...proxy(ref,{triangle:triangles}),...(bounds?{boundingSphere:sphere(center,Math.hypot(...bounds.max.map((value,axis)=>value-center[axis])))}:{})});
        }else proxies.push(proxy(ref, { cylinder: [cylinder(first,last,radius)] }));
      }
      const visibleSections=[];for(const section of physicalSections)if(bond.order===.5)for(const dash of yield* dashedBondSectionsWork(section,physicalLength,displayScale(settings.bondScale)))visibleSections.push(dash);else visibleSections.push(section);
      for (const section of visibleSections) {
        yield;
        const [start,end]=[section.start,section.end].map(position=>transformPoint(displayTransform,position));
        const afterMiddle=section.t0>=.5-1e-10,beforeMiddle=section.t1<=.5+1e-10;
        const colors: [string, string] = [atomColor(afterMiddle?bond.b:bond.a),atomColor(beforeMiddle?bond.a:bond.b)];
        const radius = bondDisplayRadius(settings), selectedRadius = .19 * displayScale(settings.bondScale);
        const at=(t:number)=>start.map((value,axis)=>value+(end[axis]-value)*(t-section.t0)/(section.t1-section.t0)) as Vector3;
        visuals.push({ start, end, colors, radius: selectedBonds.has(bondRefKey(ref)) ? selectedRadius : radius,...(clipCell?{cellClip:{start:at(section.sourceT0??0),end:at(section.sourceT1??1),cell:clipCell}}:{}) });
        if (selectedBonds.has(bondRefKey(ref)))drawColoredRod(start,end,section.t0,section.t1,['#d29c38','#d29c38'],selectedRadius,1,clipCell,section.sourceT0,section.sourceT1,.72);
      }
      bondVisuals.set(bondRefKey(ref), visuals);
    },rawPositions);
    let existingIssueBondKeys: Set<string> | undefined;
    for (const issue of settings.showBonds===false?[]:structure.bondPerceptionIssues ?? []) {
      if(issue.kind==='weak-contact')continue;
      const a = positions[atomIndices.get(issue.atomIds[0])??-1], b = positions[atomIndices.get(issue.atomIds[1])??-1];
      if (!a || !b) continue;
      existingIssueBondKeys ??= new Set((structure.bonds ?? []).map(bond => bondRefKey({atomIds:[structure.atoms[bond.a]?.id!,structure.atoms[bond.b]?.id!],image:bond.image})));
      const existing = existingIssueBondKeys.has(bondRefKey({atomIds:issue.atomIds,image:issue.image}));
      if (!existing){const edge={a:atomIndices.get(issue.atomIds[0])!,b:atomIndices.get(issue.atomIds[1])!,order:1,image:issue.image};renderTask([edge.a,edge.b],raw=>{for(const [first,last] of bondSegments(raw,edge,structure.cell))sceneShape('addLine',{start:point(transformPoint(displayTransform,first)),end:point(transformPoint(displayTransform,last)),color:'#c88728',dashed:true,dashLength:.12,gapLength:.1,linewidth:2});},rawPositions);}
    }
    const rawAtomMap = new Map(rawPositions.map(a => [a.id!, a]));
    for (const port of settings.showBonds===false?[]:document.attachmentPorts ?? []) {
      const index=atomIndices.get(port.hostAtomId);if(index===undefined)continue;
      renderTask([index],(raw,preview)=>{
      const host = raw[index];
      const livePort=preview&&fragmentPreview?.rotation?{...port,direction:rotateAttachmentDirection(port.direction,fragmentPreview.rotation.axis,fragmentPreview.rotation.degrees)}:port;
      const rawStart = coordinates(host), rawEnd = attachmentPortEndpoint(rawStart, livePort); if (!rawEnd) return;
      const start = transformPoint(displayTransform, rawStart), end = transformPoint(displayTransform, rawEnd);
      const selectedPort = !captureActive&&document.selection.portIds?.includes(port.id);
      const color = selectedPort ? SELECTION_COLOR : elementColor(host.element, settings.elementColors);
      const direction = scale(livePort.direction, 1 / Math.hypot(...livePort.direction));
      const side = cross(direction, Math.abs(direction[2]) < .8 ? [0, 0, 1] : [0, 1, 0]);
      const unitSide = scale(side, .1 / Math.hypot(...side));
      const offsets = port.order === 3 ? [-1, 0, 1] : port.order === 2 || port.order === 1.5 ? [-.65, .65] : [0];
      const visuals = offsets.map((offset, i) => {
        const a = transformPoint(displayTransform, add(rawStart, scale(unitSide, offset))), b = transformPoint(displayTransform, add(rawEnd, scale(unitSide, offset)));
        if (port.order === 1.5 && i === 1) sceneShape('addLine', { start: point(a), end: point(b), color, dashed: true, dashLength: .08, gapLength: .07, linewidth: 2 });
        else sceneShape('addCylinder', { start: point(a), end: point(b), radius: .045, color, opacity: .85, fromCap: 0, toCap: 0 });
        return { start: a, end: b, colors: [color, color] as [string, string], radius: .045 };
      });
      sceneShape('addSphere', { center: point(end), radius: .12, color: selectedPort ? SELECTION_COLOR : '#7897b0', opacity: .9 });
      // Snapshot the actual endpoint and short multiple-bond geometry, never a
      // fake atom, inferred half-order auxiliary, or hover-regenerated bound.
      proxies.push(proxy({ kind: 'port', portId: port.id }, { sphere: [sphere(end, .16)], cylinder: [cylinder(start, end, .18)] }));
      bondVisuals.set('port:' + port.id, visuals);
      },rawPositions);
    }
    for (const relation of document.auxiliaryRelations) {
      if(settings.representation==='vdw'||settings.showBonds===false)continue;
      const ia=atomIndices.get(relation.a),ib=atomIndices.get(relation.b);if(ia===undefined||ib===undefined)continue;
      yield* renderTaskWork([ia,ib],function*(){
      const a = positions[ia], b = positions[ib];
      const start=coordinates(a),end=coordinates(b),length=Math.hypot(...end.map((value,axis)=>value-start[axis])),selected=!captureActive&&document.selection.auxiliaryIds.includes(relation.id);
      const radius=bondDisplayRadius(settings),selectedRadius=.19*displayScale(settings.bondScale),indices=[ia,ib];
      const atomColor=(index:number)=>baseAtomStyles[index]?.stick?.color??elementColor(positions[index].element,settings.elementColors);
      const visuals: {start:Vector3;end:Vector3;colors:[any,any];radius:number}[]=[];
      for(const section of yield* dashedBondSectionsWork({start,end,t0:0,t1:1,shift:[0,0,0]},length,displayScale(settings.bondScale))){
        yield;
        const colors:[string,string]=[atomColor(indices[section.t0>=.5-1e-10?1:0]),atomColor(indices[section.t1<=.5+1e-10?0:1])];
        drawColoredRod(section.start,section.end,section.t0,section.t1,colors,radius,1);
        if(selected)sceneShape('addCylinder',{start:point(section.start),end:point(section.end),radius:selectedRadius,color:'#d29c38',opacity:.72,fromCap:1,toCap:1});
        visuals.push({start:section.start,end:section.end,colors,radius:selected?selectedRadius:radius});
      }
      bondVisuals.set('auxiliary:'+relation.id,visuals);
      proxies.push(proxy({ kind: 'auxiliary', relationId: relation.id }, { cylinder: [cylinder(start,end,(settings.representation==='stick'?.125:.145)*displayScale(settings.bondScale))] }));
      },rawPositions);
    }
    const referenceCell=feedback.previewCell??structure.cell;
    const paintCurrentCellEdge=function*(rawStart:Vector3,rawEnd:Vector3):RenderWork<void>{
      const start=transformPoint(displayTransform,rawStart),end=transformPoint(displayTransform,rawEnd),middle=start.map((value,axis)=>(value+end[axis])/2) as Vector3,a=screenProject(middle);
      const pixelsPerUnit=Math.max(...[0,1,2].map(axis=>{const b=screenProject(middle.map((value,index)=>value+Number(index===axis)) as Vector3);return Math.hypot(b.x-a.x,b.y-a.y);}));
      // WebGL line width is capped to one pixel on common Windows drivers.
      // A small physical cylinder gives the cell a stable pixel stroke
      // in both the interactive scene and its image export.
      for(const stroke of yield* cellEdgeStrokesWork(start,end,pixelsPerUnit,settings,!!feedback.cellGuides)){
        yield;
        sceneShape('addCylinder',{start:point(stroke.start),end:point(stroke.end),radius:stroke.radius,color:stroke.color,fromCap:1,toCap:1,clickable:false,hoverable:false});
      }
    };
    if (feedback.cellGuides) {
      for (const edge of cellPresentationEdges(feedback.cellGuides)) if(edge.role==='current')yield* paintCurrentCellEdge(edge.start,edge.end);else sceneShape('addLine', {
        start: point(transformPoint(displayTransform,edge.start)), end: point(transformPoint(displayTransform,edge.end)),
        color: edge.role==='checkpoint'?'#87a89a':'#57a879',
        linewidth:1.6, dashed: edge.dashed, dashLength:.22, gapLength:.12, clickable:false, hoverable:false
      });
    } else if (settings.cell && referenceCell) for (const [start, end] of cellSegments(referenceCell,feedback.cellPresentation)) yield* paintCurrentCellEdge(start,end);
    for(const guide of transformGuidePrimitives(feedback.previewGuides,referenceCell)){
      if(guide.kind==='point')sceneShape('addSphere',{center:point(transformPoint(displayTransform,guide.position)),radius:.12,color:'#277fdf',opacity:.8,clickable:false,hoverable:false});
      else {
        const start=transformPoint(displayTransform,guide.start),end=transformPoint(displayTransform,guide.end);
        const screenStart=screenProject(start),screenEnd=screenProject(end),pixels=Math.hypot(screenEnd.x-screenStart.x,screenEnd.y-screenStart.y),length=Math.hypot(...end.map((value,axis)=>value-start[axis]));
        const radius=Math.max(.085,Math.min(length*.12,length*2/Math.max(1,pixels)));
        sceneShape(guide.kind==='vector'?'addArrow':'addLine',{start:point(start),end:point(end),color:'#277fdf',...(guide.kind==='vector'?{radius,radiusRatio:2.8,mid:.72}:{linewidth:2}),clickable:false,hoverable:false});
      }
    }
    // Keep the source in its real coordinate frame: both it and the candidate
    // use this one display transform and camera. No fit or independent center.
    const reference=feedback.previewGuides?.referenceStructure;
    if(reference){
      for(const atom of reference.atoms)sceneShape('addSphere',{center:point(transformPoint(displayTransform,coordinates(atom))),radius:atomRadius(atom.element,settings),color:'#82999b',wireframe:true,linewidth:1.2,opacity:.42,clickable:false,hoverable:false});
      for(const bond of settings.showBonds===false?[]:reference.bonds??[])for(const [start,end] of bondSegments(reference.atoms,bond,reference.cell))sceneShape('addLine',{start:point(transformPoint(displayTransform,start)),end:point(transformPoint(displayTransform,end)),color:'#82999b',linewidth:1.3,opacity:.55,clickable:false,hoverable:false});
    }
    const guides = [...(settings.scanMarks ? (highlights.scan ?? []).map(guide => ({ guide, color: SCAN_COLOR })) : []), ...(settings.frozenMarks ? (highlights.frozenCoordinates ?? []).map(guide => ({ guide, color: FREEZE_COLOR })) : [])];
    // Projected annotations own their guide even while hidden. State icons keep
    // their own switches; toggling measurements must not resurrect a second line.
    const measuredPaths=new Set([...(measurement?.records??[]).filter(record=>record.readOnly),...userMeasurementRecords].map(record=>modelCoordinateKey({type:record.mode==='distance'?'B':record.mode==='angle'?'A':'D',atomIds:record.atomIds,images:record.images})));
    const statePaths=new Set<string>();
    for (const { guide, color } of guides){
      const key=modelCoordinateKey({type:guide.type,atomIds:guide.atoms.map(index=>rawPositions[index]?.id!),images:guide.images});
      if(measuredPaths.has(key)||statePaths.has(key))continue;
      statePaths.add(key);
      renderTask(guide.atoms,rawPositions=>{
      let paths;try{paths=measurementGeometryGuide({...structure,atoms:rawPositions},guide.type,guide.atoms.map(index=>rawPositions[index]?.id!),guide.images).paths;}catch{return;}
      for(const path of paths)for(let i=1;i<path.length;i++)sceneShape('addLine',{start:point(transformPoint(displayTransform,coordinates(path[i-1]))),end:point(transformPoint(displayTransform,coordinates(path[i]))),color,dashed:true,dashLength:.08,gapLength:.07,linewidth:1.4});
      },rawPositions);
    }
    if (settings.measurementMarks && measurement?.mode) {
      const measuredIndices = measurement.atomIds.map(id => rawPositions.findIndex(a => a.id === id));
      const type = measurement.mode === 'distance' ? 'B' : measurement.mode === 'angle' ? 'A' : measurement.mode === 'dihedral' ? 'D' : measuredIndices.length === 2 ? 'B' : measuredIndices.length === 3 ? 'A' : 'D';
      renderTask(measuredIndices,rawPositions=>{
      let measured;try{measured=measurementGeometryGuide({...structure,atoms:rawPositions},type,measurement.atomIds,measurement.images);}catch{measured={paths:[]};}
      for (const path of measured.paths) for (let i = 1; i < path.length; i++) sceneShape('addLine', { start: point(transformPoint(displayTransform, coordinates(path[i - 1]))), end: point(transformPoint(displayTransform, coordinates(path[i]))), color: MEASUREMENT_COLOR, dashed: true, dashLength: .08, gapLength: .07, linewidth: 1.6 });
      // The HTML scalar annotation owns text/hit interaction; native drawing
      // owns only the dashed guide, avoiding duplicate boxed full labels.
      },rawPositions);
    }
    for (const record of userMeasurementRecords) {
      renderTask(record.atomIds.map(id=>atomIndices.get(id)??-1),rawPositions=>{
      const type=record.mode === 'distance' ? 'B' : record.mode === 'angle' ? 'A' : 'D';
      let guide;
      try {guide=measurementGeometryGuide({...structure,atoms:rawPositions},type,record.atomIds,record.images);}
      catch {return; /* HTML annotation reports the unresolved image; never draw a guessed raw path. */}
      for (const path of guide.paths) for (let i = 1; i < path.length; i++) sceneShape('addLine', { start: point(transformPoint(displayTransform, coordinates(path[i - 1]))), end: point(transformPoint(displayTransform, coordinates(path[i]))), color: record.color, dashed: true, dashLength: .08, gapLength: .07, linewidth: record.id === measurement?.activeRecordId ? 2.4 : 1.7 });
      },rawPositions);
    }
    if (settings.regionLabels) for (const region of colored) { const atoms = region.atomIndices.flatMap(i => positions[i]&&!hiddenAtoms.has(positions[i].id!) ? [positions[i]] : []); if (atoms.length){const center=centroid(atoms),label=labels.add(region.label, { position: point(center), fontSize: settings.fontSize, fontColor: region.color, backgroundOpacity: .82, backgroundColor: 'white', inFront: true }, undefined, true);if(label)regionLabelMoves.push({indices:region.atomIndices,label,center});} }
    const restored = framedDocuments.has(document.id) ? (switched ? cachedViews.get(document.id) : priorView) : positions.length === 0 && switched ? cachedViews.get(document.id) : null;
    if (placementView && positions.length) { viewer.setView(placementView); framedDocuments.add(document.id); cachedViews.set(document.id, [...placementView]); }
    else if (restored) { if (switched) viewer.setView(restored); }
    else if (positions.length) {
      const view=fixedViewCell?feedback.initialFixedCellCamera:undefined;
      if(view?.length===8&&view.every(Number.isFinite)&&Math.hypot(...view.slice(4))>=1e-10){
        viewer.setView([...view]);framedDocuments.add(document.id);cachedViews.set(document.id,[...view]);
      } else resetView();
    }
    else if (switched) viewer.setView([...emptyView]);
    orbitals.sync(ntoLayer ?? orbitalLayer, currentDocument, displayTransform);
    if (surfaceLayers !== undefined) surfaces.syncLayers(surfaceLayers, currentDocument, displayTransform);
    else surfaces.sync(surfaceLayer, currentDocument, displayTransform);
    surfaces.syncExtrema(surfaceExtrema, currentDocument, displayTransform);
    yield* trajectoryLayer.syncWork(feedback.multiframeDisplay, settings, transform,feedback.hiddenAtomIds,cooperative,!!fixedViewCell);
    calculationRangeShapes.clear();
    for (const range of feedback.calculationRanges ?? []) {
      for (const [start, end] of calculationRangeLines(range)) calculationRangeShapes.keep(viewer.addLine({
        start: point(transformPoint(displayTransform, start)), end: point(transformPoint(displayTransform, end)),
        ...CALCULATION_RANGE_STYLE, clickable: false, hoverable: false,
      }));
    }
    samplingSphereShapes.sync(feedback.samplingSphere,displayTransform,JSON.stringify([document.id,feedback.sceneOwnerEpoch??null]));
    const publishPrimitives = yield* preparePrimitiveRows(primitiveRows, settings);
    initialized = true;
    // No asynchronous yield remains after this boundary. Published geometry,
    // labels and native models transfer together before the first submission.
    sceneSequence.beforeFirstRender();
    publishPrimitives();
    publishedPrimitives = primitiveRows;
    atomicDraw?.commit();
    compactOwnedShapeSlots();
    if(updateNativeBuffers){
      if(updateNativeBuffers())coordinateBufferUpdates++;
      else {renderedModel.setCoordinates([positions.map(coordinates)],'array');void renderedModel.setFrame(0);setNativeClickable();rendered=renderedModel.selectedAtoms({});}
    }
    try { renderSubmissions.run('draw',()=>viewer.render()); surfaces.markSubmitted(); orbitals.markSubmitted(); } catch (error) { surfaces.failSubmission(error); orbitals.failSubmission(error); throw error; }
    // One material build/present supplies exact native bounds after every
    // coordinate update. Snapshot them so hover never changes pick geometry.
    for (let i = 0; i < positions.length; i++) {
      const actual = rendered[i]?.intersectionShape?.sphere ?? [];
      const target=atomPickProxies.get(i);if (target&&actual.length) target.intersectionShape.sphere = actual.map((s: any) => sphere([s.center.x, s.center.y, s.center.z], s.radius));
    }
    const displayHighlights=new Set(feedback.displayHighlightAtomIds??feedback.displaySelectionAtomIds??[]);
    for(let i=0;i<positions.length;i++)if(displayHighlights.has(positions[i].id!)){renderTask([i],()=>{sceneShape('addSphere',atomOutline(i));for(const instance of mirrorInstances)if(instance.sourceIndex===i)sceneShape('addSphere',{...atomOutline(i),center:point(transformPoint(displayTransform,instance.position))});},rawPositions);displayHoverKeys.add('atom:'+positions[i].id);}
    for(const record of feedback.displayMeasurementRecords??[]){
      if(record.atomIds.some(id=>hiddenAtoms.has(id)))continue;
      if(record.mode!=='distance'||record.atomIds.length!==2)continue;
      const atomIds=record.atomIds as [string,string],image=record.images?.length===2?record.images[1].map((value,axis)=>value-record.images![0][axis]) as Vector3:undefined,key=bondRefKey({atomIds,image}),hoverKey='bond:'+key;
      if(displayHoverKeys.has(hoverKey))continue;
      const outlines=bondOutlines(key);
      if(outlines.length){for(const outline of outlines)sceneShape(outline.method as SceneShapeMethod,outline.spec);displayHoverKeys.add(hoverKey);}
      else {
        // A non-edge stays a disposable display line. It has no pick proxy or
        // chemical bond, and does not borrow the user's measurement guide.
        try {const frame=builderExplicitGeometryFrame({...structure,atoms:rawPositions},'B',atomIds,record.images);
          sceneShape('addLine',{start:point(transformPoint(displayTransform,frame.positions[0])),end:point(transformPoint(displayTransform,frame.positions[1])),color:MODEL_HOVER_COLOR,dashed:true,dashLength:.08,gapLength:.07,linewidth:2.6});
        }catch{continue;}
      }
    }
    if(displayHighlights.size||(feedback.displayMeasurementRecords?.length??0)>0)viewer.render();
    sceneSequence.end();
  }
  function replaceCipLabels(next:typeof paintedCip):boolean{
    const changed=[...new Set([...paintedCip.keys(),...next.keys()])].filter(index=>paintedCip.get(index)!==next.get(index));
    labels.remove(changed.flatMap(index=>atomLabelHandles.get(index)??[]));
    for(const index of changed){atomLabelHandles.delete(index);paintAtomLabels(index,next.get(index));}
    paintedCip=next;return changed.length>0;
  }
  function cancelCip(){cipLease=undefined;cipRequestKey=undefined;cipRequests.cancel();}
  function cancelObsoleteCip(document:ModelDocument,settings:DisplaySettings,feedback:RenderFeedbackOptions){
    if(cipRequestKey&&(!settings.stereochemistry||feedback.cipGeometryPreview||
      cipRequestKey!==carbonCipSource(cipStructureForDisplay(document.draft.structure,feedback.cipStructure))))cancelCip();
  }
  function syncCip(scene:NonNullable<typeof lastDraw>,scientificPreview?:()=>Structure){
    const {document,settings,feedback}=scene;
    const structure=settings.stereochemistry?cipStructureForDisplay(document.draft.structure,feedback.cipStructure):undefined;
    const source=carbonCipSource(structure);
    const preview=structure&&feedback.cipStructure===undefined?
      scientificPreview??(feedback.cipGeometryPreview&&scene.preview?()=>({...structure,atoms:[...scene.preview!]}):undefined):undefined;
    const token={},key=source&&(preview?token:source);cipLease=token;cipRequestKey=key;
    const current=()=>!disposed&&cipLease===token&&(feedback.isCipCurrent??feedback.isCurrent)?.()!==false;
    const announce=(result:typeof emptyCarbonCip)=>{
      if(!current())return;
      feedback.onCipWarning?.(result.warning??null);
      if(!preview&&structure&&result.labels.size){const usage=preparedCarbonCipUsage(structure,feedback.hiddenAtomIds);if(usage)feedback.onCipLabelsUsed?.(usage);}
    };
    const retained=source?.result??source?.failure;
    if(!key||(!preview&&retained)){
      cipRequests.cancel();
      const result=retained??emptyCarbonCip;
      if(current()&&replaceCipLabels(result.labels))viewer.setView(viewer.getView(),true);
      announce(result);return;
    }
    // Preview snapshots are only materialized for the sample that can start
    // work. Clear prior descriptors before the moving geometry is presented.
    if(preview)replaceCipLabels(emptyCarbonCip.labels);
    announce(emptyCarbonCip);
    cipRequests.request({key,structure:preview??(()=>structure!),source:preview?undefined:source,publish:async result=>{
      while(drawController)await drawTail;
      if(!current())return;
      if(replaceCipLabels(result.labels))viewer.setView(viewer.getView(),true);
      announce(result);
    },onError:error=>{
      if(!current())return;
      const reason=error instanceof Error?error.message:String(error);
      feedback.onCipWarning?.({identity:'cip-render:'+reason,reason});
    }});
  }
  // Reuse native imposters when all other presentation layers either stay
  // static or are absent. Specialized layers use the full existing draw.
  function residentSignature(document:ModelDocument,settings:DisplaySettings,incoming:ViewerHighlights,transform:RigidTransform,measurement:MeasurementState|undefined,feedback:RenderFeedbackOptions):string|undefined{
    const {structure,assignments}=document.draft;
    if(!feedback.sceneOwnerEpoch||!structure.atoms.length||settings.atomNumbers||settings.elementNames||settings.stereochemistry||settings.regionLabels||settings.vdwShell||
      (structure.cell&&settings.cell)||periodicDisplaySettings(settings).images||
      document.selection.atomIds.length||document.selection.bonds.length||document.attachmentPorts?.length||document.auxiliaryRelations.length||
      settings.showBonds!==false&&structure.bondPerceptionIssues?.length||assignments.layers.length||assignments.basis.length||assignments.fragments.length||
      document.sharedConstraints?.coordinates.length||document.internalCoordinates?.length||document.coordinateObjects?.length||document.gaussianBoundCoordinates?.length||
      measurement?.atomIds.length||measurement?.records?.length||
      orbitalLayer||ntoLayer||surfaceLayer||surfaceLayers?.length||surfaceExtrema||
      feedback.previewGuides||feedback.previewCell||feedback.cellGuides||feedback.displayCaptureAtomIds||feedback.hiddenAtomIds?.length||
      feedback.multiframeDisplay||feedback.samplingSphere||feedback.cellPresentation||feedback.calculationRanges?.length||feedback.displaySelectionAtomIds?.length||
      feedback.displayHighlightAtomIds?.length||feedback.displayMeasurementRecords?.length||feedback.linkedAtomsActive||feedback.capturePurpose||
      feedback.vibrationVectors?.length||feedback.atomScalarValues?.length||feedback.dipoleVector||Object.values(incoming).some(value=>value?.length))return undefined;
    return JSON.stringify([document.id,feedback.sceneOwnerEpoch,structure.cell??null,settings,transform,
      feedback.fixedCellView,assignments.frozenAtomIds,document.sharedConstraints,feedback.displayFrozenAtomIds]);
  }

  function rememberResidentScene(signature:string|undefined,document:ModelDocument,settings:DisplaySettings) {
    const root=renderedModel?.renderedMolObj;
    if(!signature||!root||sceneShapes.size||imageProxies.length||atomPickProxies.size!==positions.length){residentScene=undefined;return;}
    const graph=settings.showBonds===false||settings.representation==='vdw'?[]:document.draft.structure.bonds??[];
    if(proxies.length!==positions.length+graph.length){residentScene=undefined;return;}
    const bonds:ResidentBond[]=[];
    for(const [index,bond] of graph.entries()){
      if(bond.order!==1||bond.aromatic||bond.image?.some(Boolean)||bondConnectionOnly(bond)){residentScene=undefined;return;}
      const target=proxies[positions.length+index],a=positions[bond.a],b=positions[bond.b];
      if(target.ref.kind!=='bond'||target.ref.atomIds[0]!==a.id||target.ref.atomIds[1]!==b.id){residentScene=undefined;return;}
      const shape=target.intersectionShape.cylinder[0],visual=bondVisuals.get(bondRefKey(target.ref))?.[0];
      if(!shape||!visual){residentScene=undefined;return;}
      bonds.push({a:bond.a,b:bond.b,shape,visual});
    }
    residentScene={signature,model:renderedModel,root,bonds,radii:Float64Array.from(positions,atom=>atomRadius(atom.element,settings)),
      xyz:positions.map(coordinates),pickSpheres:positions.map((_,index)=>atomPickProxies.get(index).intersectionShape.sphere)};
  }

  function advanceResidentScene(signature:string|undefined,document:ModelDocument,preview:Atom[]|undefined,feedback:RenderFeedbackOptions):boolean{
    const scene=residentScene,layout=modelMaterial?.layout,structure=document.draft.structure;
    if(!scene||scene.signature!==signature||scene.model!==renderedModel||scene.root!==renderedModel.renderedMolObj||!layout||
      viewer.getRenderer?.()?.supportedExtensions?.()?.regen||
      !sameModelBonds(layout.bonds,structure.bonds))return false;
    const raw=preview??structure.atoms;
    if(raw.length!==positions.length)return false;
    for(const bond of scene.bonds){const a=raw[bond.a],b=raw[bond.b];if(Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)<1e-12)return false;}
    if(!nativeBufferBindings.has(scene.root))nativeBufferBindings.set(scene.root,bindNativeCoordinateBuffers(renderedModel,nativeCoordinateUpload));
    const update=nativeBufferBindings.get(scene.root);
    if(!update)return false;
    const coords=scene.xyz,{rotation:[r0,r1,r2],translation}=displayTransform;
    const transformComponent=(row:Vector3,x:number,y:number,z:number)=>((0+row[0]*x)+row[1]*y)+row[2]*z;
    for(let i=0;i<raw.length;i++){
      const atom=raw[i];
      if(atom.id!==positions[i].id||atom.element!==positions[i].element){clearNativeCoordinates();return false;}
      const {x,y,z}=atom,position=coords[i];
      position[0]=transformComponent(r0,x,y,z)+translation[0];
      position[1]=transformComponent(r1,x,y,z)+translation[1];
      position[2]=transformComponent(r2,x,y,z)+translation[2];
    }
    if(!update(coords)){clearNativeCoordinates();return false;}

    clearHover();basePicking.invalidate();centroidSource=undefined;
    currentDocument=document;nativeCoordinates=coords;nativeCoordinateEpoch=feedback.sceneOwnerEpoch;
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
    const native=renderedModel.atoms;
    for(let i=0;i<raw.length;i++){
      const [x,y,z]=coords[i],r=scene.radii[i],target=scene.pickSpheres[i],atom=positions[i];
      atom.x=x;atom.y=y;atom.z=z;
      const actual=native[i].intersectionShape?.sphere;
      if(actual?.length)for(let j=0;j<actual.length;j++){
        const center=target[j].center,source=actual[j].center;
        center.x=source.x;center.y=source.y;center.z=source.z;
      }
      else {const center=target[0].center;center.x=x;center.y=y;center.z=z;}
      minX=Math.min(minX,x-r);minY=Math.min(minY,y-r);minZ=Math.min(minZ,z-r);
      maxX=Math.max(maxX,x+r);maxY=Math.max(maxY,y+r);maxZ=Math.max(maxZ,z+r);
    }
    atomBounds={min:[minX,minY,minZ],max:[maxX,maxY,maxZ]};
    for(const {a,b,shape,visual} of scene.bonds){
      const start=coords[a],end=coords[b];
      shape.c1.set(start[0],start[1],start[2]);shape.c2.set(end[0],end[1],end[2]);updateNativePickCylinder(shape);
      visual.start=start;visual.end=end;
    }
    coordinateBufferUpdates++;residentCoordinateFrames++;
    // All owned objects are already attached and clickability/material did
    // not change. The locked present seam still applies slab, fog and view.
    if(typeof viewer.show==='function'&&!viewer.stateChangeCallback)viewer.show();else viewer.render();
    return true;
  }

  function draw(document: ModelDocument, settings: DisplaySettings, incoming: ViewerHighlights = {}, preview?: Atom[], transform = identityTransform(), measurement?: MeasurementState, feedback: RenderFeedbackOptions = {}) {
    assertLive();
    scenePreparations++;
    if(drawController)throw new Error('异步显示准备尚未结束，请通过受管绘制入口更新。');lastDrawCooperative=false;
    cancelObsoleteCip(document,settings,feedback);
    if(fragmentPreview)clearFragmentPreview(false);
    renderSubmissions.configure(feedback.renderIdentity&&feedback.onRenderComplete?{identity:feedback.renderIdentity,documentId:document.id,geometryRevision:document.revision,observer:feedback.onRenderComplete}:null);
    try{
      const signature=residentSignature(document,settings,incoming,transform,measurement,feedback);
      renderSubmissions.run('draw',()=>{
        if(advanceResidentScene(signature,document,preview,feedback))return;
        finishRenderWork(drawContent(document,settings,incoming,preview,transform,measurement,feedback));
        rememberResidentScene(signature,document,settings);
      });
      lastDraw={document,settings,incoming,preview,transform,measurement,feedback};syncCip(lastDraw);
    }
    catch(error){residentScene=undefined;clearNativeCoordinates();renderSubmissions.configure(null);try{sceneSequence.abort();}catch{/* Preserve the original draw failure. */}throw error;}
    finally{cameraPreparedAt=undefined;}
  }
  function beginAtomicDraw(documentId: string){
    const previous={labels,renderedModel,modelMaterial,nativeCoordinates,nativeCoordinateEpoch,currentDocument,currentId,fixedViewCell,positions,proxies,imageProxies,atomPickProxies,mirrorInstances,baseAtomStyles,displayTransform,atomBounds,shapeTasks,atomLabelHandles,regionLabelMoves,hiddenAtoms,initialized,fragmentPreview,paintAtomLabels,paintedCip,
      bondVisuals:new Map(bondVisuals),displayHoverKeys:new Set(displayHoverKeys),view:viewer.getView(),background,fadeStrength};
    const deferred=new Set<any>(),renderer=viewer.getRenderer?.(),nativeRender=renderer?.render,viewerRender=viewer.render;
    const suppressed=()=>viewer,suppressNative=()=>{};
    // GLViewer camera/label helpers can submit through their own show path.
    // Keep the last complete framebuffer while CPU staging yields to the UI.
    viewer.render=suppressed;if(typeof nativeRender==='function')renderer.render=suppressNative;
    labels=createLabelLayer(viewer);fragmentPreview=null;
    let finished=false;
    const restoreRendering=()=>{if(viewer.render===suppressed)viewer.render=viewerRender;if(renderer?.render===suppressNative)renderer.render=nativeRender;};
    const retireModel=(model:any)=>shapeResources.retireModel(model,()=>{if(typeof viewer.removeModel==='function')viewer.removeModel(model);else viewer.removeAllModels();});
    const releasePreview=()=>{const preview=previous.fragmentPreview;if(preview){clearMovingPrimitives();retireModel(preview.model);preview.cpu?.removeAtoms(preview.cpu.selectedAtoms({}));}};
    const transaction={
      publishedProxies:previous.proxies,publishedImageProxies:previous.imageProxies,
      cameraOwner:previous.initialized&&previous.currentId===documentId?documentId:null,
      publishedView:[...previous.view],publishedPivot:viewPivot(),manualView:undefined as number[]|undefined,
      retire(model:any){deferred.add(model);},
      commit(){if(finished)return;finished=true;try{previous.labels.clear();for(const model of deferred)if(model!==renderedModel)retireModel(model);releasePreview();if(transaction.manualView)viewer.setView(transaction.manualView,true);}finally{restoreRendering();atomicDraw=null;}},
      rollback(){if(finished)return;finished=true;try{
        const view=transaction.manualView??previous.view;
        try{sceneSequence.abort(true);}finally{labels.clear();}
        if(renderedModel&&renderedModel!==previous.renderedModel)retireModel(renderedModel);
        labels=previous.labels;renderedModel=previous.renderedModel;modelMaterial=previous.modelMaterial;
        nativeCoordinates=previous.nativeCoordinates;nativeCoordinateEpoch=previous.nativeCoordinateEpoch;
        currentDocument=previous.currentDocument;currentId=previous.currentId;fixedViewCell=previous.fixedViewCell;positions=previous.positions;proxies=previous.proxies;imageProxies=previous.imageProxies;atomPickProxies=previous.atomPickProxies;mirrorInstances=previous.mirrorInstances;baseAtomStyles=previous.baseAtomStyles;displayTransform=previous.displayTransform;atomBounds=previous.atomBounds;
        shapeTasks=previous.shapeTasks;atomLabelHandles=previous.atomLabelHandles;regionLabelMoves=previous.regionLabelMoves;hiddenAtoms=previous.hiddenAtoms;initialized=previous.initialized;fragmentPreview=previous.fragmentPreview;
        paintAtomLabels=previous.paintAtomLabels;paintedCip=previous.paintedCip;
        bondVisuals.clear();for(const [key,value]of previous.bondVisuals)bondVisuals.set(key,value);displayHoverKeys.clear();for(const key of previous.displayHoverKeys)displayHoverKeys.add(key);
        if(!disposed){if(renderedModel?.setCoordinates){renderedModel.setCoordinates([positions.map(atom=>[atom.x,atom.y,atom.z])],'array');void renderedModel.setFrame(0);}viewer.setView(view);if(background!==previous.background)viewer.setBackgroundColor(previous.background,options.backgroundAlpha??1);if(fadeStrength!==previous.fadeStrength)viewer.enableFog?.(depthFadeFog(previous.fadeStrength));}
        background=previous.background;fadeStrength=previous.fadeStrength;
      }finally{restoreRendering();atomicDraw=null;}
      if(!disposed&&transaction.manualView){renderSubmissions.configure(null);viewer.setView(transaction.manualView);}},
    };
    return transaction;
  }
  async function drawAsync(document:ModelDocument,settings:DisplaySettings,incoming:ViewerHighlights={},preview?:Atom[],transform=identityTransform(),measurement?:MeasurementState,feedback:RenderFeedbackOptions={},signal?:AbortSignal){
    if(signal?.aborted)throw new DOMException('显示准备已取消。','AbortError');
    residentScene=undefined;
    if(preview&&!Object.isFrozen(preview))preview=preview.map(atom=>({...atom}));
    const requestedFragment = fragmentPreview;
    const requestedSample = requestedFragment?.sampleGeneration;
    assertLive();cancelObsoleteCip(document,settings,feedback);drawController?.abort();const controller=new AbortController();drawController=controller;const previous=drawTail;
    let release!:()=>void;drawTail=new Promise(resolve=>{release=resolve;});const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      await previous;
      const held = fragmentPreview;
      const superseded = held?.documentId === document.id && held.revision === document.revision
        && (held !== requestedFragment || held.sampleGeneration !== requestedSample);
      if (controller.signal.aborted || disposed || superseded) throw new DOMException('显示准备已取消。','AbortError');
      lastDrawCooperative=true;
      scenePreparations++;
      renderSubmissions.configure(feedback.renderIdentity&&feedback.onRenderComplete?{identity:feedback.renderIdentity,documentId:document.id,geometryRevision:document.revision,observer:feedback.onRenderComplete}:null);
      atomicDraw=beginAtomicDraw(document.id);const transaction=atomicDraw;
      try{await runRenderWork(drawContent(document,settings,incoming,preview,transform,measurement,feedback,true),controller.signal,feedback.isCurrent);lastDraw={document,settings,incoming,preview,transform,measurement,feedback};syncCip(lastDraw);}
      catch(error){sceneAborts++;try{transaction.rollback();}catch{/* Preserve original preparation error; adapter still owns final release. */}renderSubmissions.configure(null);throw error;}
    }finally{signal?.removeEventListener('abort',abort);if(drawController===controller)drawController=null;release();if(backgroundRefreshPending)refreshInterfaceBackground();}
  }
  function clearFragmentPreview(restore:boolean){
    const state=fragmentPreview;if(!state)return;fragmentPreview=null;
    clearMovingPrimitives();
    shapeResources.retireModel(state.model,()=>viewer.removeModel(state.model));state.cpu?.removeAtoms(state.cpu.selectedAtoms({}));
    if(restore&&lastDraw){const value=lastDraw;draw(value.document,value.settings,value.incoming,value.preview,value.transform,value.measurement,value.feedback);}
  }
  function previewFragment(atoms:readonly Atom[]|null,context?:FragmentRenderPreviewContext){
    residentScene=undefined;
    assertLive();clearNativeCoordinates();if(atoms===null){clearFragmentPreview(true);return;}
    const source=lastDraw;if(!source||!currentDocument||!renderedModel)throw new Error('片段显示预览需要已完成的当前模型。');
    try{
      let repartitioned = false;
      if(context&&(context.documentId!==source.document.id||context.revision!==source.document.revision))throw new Error('片段显示预览的文档版本已过期。');
      if(!atoms.length||new Set(atoms.map(atom=>atom.id)).size!==atoms.length||atoms.some(atom=>!atom.id||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('片段显示预览的稳定原子或坐标无效。');
      if(!fragmentPreview){
        const raw=(source.preview??source.document.draft.structure.atoms).map(atom=>({...atom})),indexById=new Map(raw.map((atom,index)=>[atom.id,index]));
        const indices=atoms.map(atom=>{const index=indexById.get(atom.id)??-1;return raw[index]?.element===atom.element?index:-1;});
        if(indices.some(index=>index<0))throw new Error('片段显示预览与当前原子身份不一致。');
        sceneSequence.invalidateMetadata();
        const moving=new Set(indices),ids=new Set(atoms.map(atom=>atom.id!)),tasks=shapeTasks.filter(task=>task.indices.some(index=>moving.has(index)));
        const affected = new Set(tasks);
        const staticPrimitives = {
          rods: publishedPrimitives.rods.filter(row => !affected.has(row.task)),
          spheres: publishedPrimitives.spheres.filter(row => !affected.has(row.task)),
          arrows: publishedPrimitives.arrows.filter(row => !affected.has(row.task)),
        };
        const publishStaticPrimitives = (staticPrimitives.rods.length !== publishedPrimitives.rods.length ||
          staticPrimitives.spheres.length !== publishedPrimitives.spheres.length ||
          staticPrimitives.arrows.length !== publishedPrimitives.arrows.length)
          ? finishRenderWork(preparePrimitiveRows(staticPrimitives, source.settings)) : undefined;
        const native=renderedModel.selectedAtoms({}).map((atom:any)=>({elem:atom.elem,x:atom.x,y:atom.y,z:atom.z,index:atom.index,serial:atom.serial,bonds:[...(atom.bonds??[])],bondOrder:[...(atom.bondOrder??[])],bondStyles:atom.bondStyles,style:atom.style}));
        let cpu:any=null;if(tasks.some(task=>task.indices.length===2)&&typeof mol.GLModel==='function'){cpu=new mol.GLModel(-1);cpu.addAtoms(native);}
        removeOwnedModel();renderedModel=createOwnedMolecularModel(source.settings);
        renderedModel.addAtoms(native.map((atom:any,index:number)=>{const kept=atom.bonds.flatMap((other:number,at:number)=>moving.has(index)||moving.has(other)?[]:[at]);return{...atom,bonds:kept.map((at:number)=>atom.bonds[at]),bondOrder:kept.map((at:number)=>atom.bondOrder[at]),bondStyles:atom.bondStyles&&kept.map((at:number)=>atom.bondStyles[at])};}));
        applyResolvedAtomStyles(renderedModel,native.map((atom:any,index:number)=>moving.has(index)?{}:atom.style),(index,style)=>renderedModel.setStyle({index},style));
        const model=createOwnedMolecularModel(source.settings);model.addAtoms(indices.map(index=>({...native[index],bonds:[],bondOrder:[],bondStyles:undefined})));
        applyResolvedAtomStyles(model,indices.map(index=>native[index].style),(index,style)=>model.setStyle({index},style));
        proxies=proxies.filter(item=>item.ref.kind==='atom'?!ids.has(item.ref.atomId):item.ref.kind==='bond'?!item.ref.atomIds.some((id:string)=>ids.has(id)):item.ref.kind==='auxiliary'?!source.document.auxiliaryRelations.some(relation=>relation.id===item.ref.relationId&&(ids.has(relation.a)||ids.has(relation.b))):item.ref.kind==='port'?!source.document.attachmentPorts?.some(port=>port.id===item.ref.portId&&ids.has(port.hostAtomId)):true);
        const periodic=new Map<unknown,ReturnType<typeof periodicBondGlyphContext>>(),topology=periodicBondGlyphTopology(source.document.draft.structure);for(const bond of source.document.draft.structure.bonds??[])if((moving.has(bond.a)||moving.has(bond.b))&&periodicGlyphRequired(source.document.draft.structure,bond))periodic.set(bond,periodicBondGlyphContext(source.document.draft.structure,bond,raw,topology));
        fragmentPreview={documentId:source.document.id,revision:source.document.revision,gestureId:context?.gestureId,sampleGeneration:-1,indices,ids,raw,tasks,staticProxyCount:proxies.length,model,cpu,baseModelSynced:false,periodic,instances:[]};
        if (publishStaticPrimitives) {
          publishStaticPrimitives();
          publishedPrimitives = staticPrimitives;
          repartitioned = true;
        }
        clearHover();
      }
      const state=fragmentPreview;
      if(context?.gestureId!==undefined&&state.gestureId!==context.gestureId)throw new Error('片段显示预览的手势已过期。');
      if(context?.sampleGeneration!==undefined&&context.sampleGeneration<=state.sampleGeneration)return;
      if(state.documentId!==currentDocument.id||state.revision!==currentDocument.revision||atoms.length!==state.ids.size||atoms.some(atom=>!state.ids.has(atom.id!)))throw new Error('片段显示预览已过期或受影响原子集发生变化。');
      const current=new Map(atoms.map(atom=>[atom.id!,atom]));
      state.rotation=context?.rotation;
      for(const index of state.indices){const atom=current.get(state.raw[index].id!)!;if(atom.element!==state.raw[index].element)throw new Error('片段显示预览不能改变元素。');state.raw[index]={...state.raw[index],x:atom.x,y:atom.y,z:atom.z};const displayed=transformPoint(displayTransform,[atom.x,atom.y,atom.z]);positions[index]={...state.raw[index],x:displayed[0],y:displayed[1],z:displayed[2]};atomBounds=includeRenderPoint(atomBounds,displayed,atomRadius(atom.element,source.settings));for(const label of atomLabelHandles.get(index)??[])labels.move(label,point(displayed));}
      state.sampleGeneration=context?.sampleGeneration??state.sampleGeneration+1;
      if(source.settings.stereochemistry)syncCip(source,()=>{
        const structure=source.document.draft.structure,atoms=[...structure.atoms];
        for(const index of state.indices)atoms[index]=state.raw[index];
        return {...structure,atoms};
      });
      fragmentSamples++;
      const structure=source.document.draft.structure;
      if(structure.cell?.pbc.some(Boolean)&&(periodicDisplaySettings(source.settings).images||state.periodic.size||structure.bonds?.some(bond=>bond.image?.some(Boolean)))){
        state.instances=finishRenderWork(periodicDisplayInstancesWork(structure,state.raw,source.settings,hiddenAtoms));
        state.connections=finishRenderWork(preparePeriodicDisplayConnectionsWork(structure,state.raw,state.instances,source.settings));
        mirrorInstances=state.instances.filter(instance=>!instance.base);
      }
      const coords=state.indices.map(index=>coordinates(positions[index]));
      if(state.cpu){const native=state.cpu.selectedAtoms({});for(const index of state.indices){native[index].x=positions[index].x;native[index].y=positions[index].y;native[index].z=positions[index].z;}}
      proxies.length=state.staticProxyCount;
      basePicking.invalidate(); imagePicking.invalidate(); centroidSource=undefined;
      for(const index of state.indices){const target=proxy({kind:'atom',atomId:positions[index].id!},{sphere:[sphere(coordinates(positions[index]),atomRadius(positions[index].element,source.settings))]});proxies.push(target);atomPickProxies.set(index,target);}
      // Remove the complete affected tail before appending replacements. One
      // owner collect/flush per sample, never once per bond. Native removeShape
      // already reclaims the affected tail in the usual gesture path.
      const retired=new Set<any>();for(const task of state.tasks)for(const handle of task.handles)retired.add(handle);
      if(retired.size){sceneShapes.remove(retired);fragmentRetirementBatches++;}
      const dynamicPrimitives = nativeBatches && (state.indices.length >= 128 || state.tasks.length >= 128) ? emptyPrimitiveRows() : null;
      collectingMovingPrimitives = dynamicPrimitives;
      try {
        for (const task of state.tasks) {
          task.handles.clear();
          activeShapeTask = task;
          task.paint(state.raw, true);
        }
      } finally {
        activeShapeTask = null;
        collectingMovingPrimitives = null;
      }
      if (dynamicPrimitives) finishRenderWork(preparePrimitiveRows(dynamicPrimitives, source.settings, movingPrimitives))();
      for(const marker of regionLabelMoves){const center=[...marker.center] as Vector3;for(const index of state.indices)if(marker.indices.includes(index)){const before=transformPoint(displayTransform,coordinates((source.preview??source.document.draft.structure.atoms)[index]));for(let axis=0;axis<3;axis++)center[axis]+=(coordinates(positions[index])[axis]-before[axis])/marker.indices.length;}labels.move(marker.label,point(center));}
      const changed=new Set<any>();for(const task of state.tasks)for(const handle of task.handles)changed.add(handle);
      const availableBatches = [...(repartitioned ? Object.values(mainPrimitives) : []), ...(dynamicPrimitives ? Object.values(movingPrimitives) : [])];
      for (const batch of availableBatches) {
        const handle = batch.handle();
        if (handle) changed.add(handle);
      }
      const renderer=viewer.getRenderer?.(),group=viewer.modelGroup;
      // These are the same owned globj methods and extension values used by
      // GLViewer.render. Static shape/model objects and all other layer owners
      // remain attached. Public setView presents that scene without remeshing it.
      fragmentFallbackCode=!group||typeof group.add!=='function'||typeof group.remove!=='function'?1
        :typeof state.model?.globj!=='function'||typeof renderedModel?.globj!=='function'?2
        :typeof renderer?.supportedExtensions!=='function'||typeof viewer.setView!=='function'?3
        :[...changed].some(handle=>typeof handle.globj!=='function')?4:0;
      const extensions=fragmentFallbackCode?undefined:renderer.supportedExtensions();
      if(extensions?.regen)fragmentFallbackCode=5;
      const orientation=!fragmentFallbackCode&&typeof mol.Quaternion==='function'?fragmentMeshOrientation(state.rotation):undefined;
      const reference=state.meshReference,root=state.model.renderedMolObj;
      let rigid=false;
      if(reference&&orientation&&root===reference.root&&root.matrixAutoUpdate===true&&typeof root.position?.set==='function'&&typeof root.quaternion?.set==='function'){
        const relative=new mol.Quaternion().multiplyQuaternions(orientation,reference.orientation.clone().inverse());
        const quaternion=[relative.x,relative.y,relative.z,relative.w];
        const translation=subtract(coords[0],rotateVector(reference.coordinates[0],quaternion));
        // A source image change or non-rigid update takes the coordinate path.
        rigid=coords.every((position,index)=>add(rotateVector(reference.coordinates[index],quaternion),translation).every((value,axis)=>
          Number.isFinite(value)&&Math.abs(position[axis]-value)<=Number.EPSILON*64*Math.max(1,Math.abs(position[axis]),Math.abs(value))));
        if(rigid){root.position.set(...translation);root.useQuaternion=true;root.quaternion.set(...quaternion);fragmentRigidPresents++;}
      }
      if(!rigid){state.model.setCoordinates([coords],'array');void state.model.setFrame(0);state.meshReference=undefined;}
      const feedback=source.feedback;
      renderSubmissions.configure(feedback.renderIdentity&&feedback.onRenderComplete?{identity:feedback.renderIdentity,documentId:source.document.id,geometryRevision:source.document.revision,observer:feedback.onRenderComplete}:null);
      renderSubmissions.run('set-view',()=>{
        if(fragmentFallbackCode){fragmentFullPresents++;viewer.render();}
        else{
          if(!state.baseModelSynced)renderedModel.globj(group,extensions);
          state.model.globj(group,extensions);
          for(const handle of changed)handle.globj(group,extensions);
          viewer.setView(viewer.getView());fragmentPartialPresents++;
        }
      });
      if(!rigid&&orientation&&state.model.renderedMolObj)state.meshReference={coordinates:coords,orientation,root:state.model.renderedMolObj};
      state.baseModelSynced=true;
    }catch(error){clearFragmentPreview(true);throw error;}
  }
  function fragmentMeshOrientation(rotation:FragmentRenderPreviewContext['rotation']){
    const axis=rotation&&rotate(displayTransform.rotation,rotation.axis);
    const length=axis?Math.hypot(...axis):0;
    if(!axis||length===0)return new mol.Quaternion();
    const angle=rotation!.degrees*Math.PI/360;
    return new mol.Quaternion(...scale(axis,Math.sin(angle)/length),Math.cos(angle));
  }
  let backgroundRefreshPending=false;
  function refreshInterfaceBackground(){
    if(disposed)return;
    if(drawController||atomicDraw){backgroundRefreshPending=true;return;}
    backgroundRefreshPending=false;
    const display=lastDraw?.settings,feedback=lastDraw?.feedback;
    const next=feedback?.capturePurpose?CAPTURE_BACKGROUND_COLOR:feedback?.linkedAtomsActive?LINKED_BACKGROUND_COLOR:display?.backgroundColor??viewportDefaultBackgroundColor(container);
    if(next===background)return;
    renderSubmissions.run('interface-background',()=>{
      viewer.setBackgroundColor(next,options.backgroundAlpha??1);background=next;
      if(fadeStrength>0)viewer.enableFog?.(depthFadeFog(fadeStrength));
      viewer.render();
    });
  }
  const releaseBackgroundObserver=container.closest?.('.model-viewport')?observeCanvasBackground(container.ownerDocument,refreshInterfaceBackground):()=>{};
  return {
    draw,drawAsync,awaitMeshes,cancelDraw:()=>{drawController?.abort();cancelCip();},
    observeScene(document,identity,observer){renderSubmissions.configure(identity&&observer?{identity,observer,documentId:document.id,geometryRevision:document.revision}:null);},
    retryCip(){
      if(!lastDraw||!lastDraw.settings.stereochemistry||drawController||fragmentPreview)return;
      const {document,feedback}=lastDraw;
      const source=carbonCipSource(cipStructureForDisplay(document.draft.structure,feedback.cipStructure));
      if(source)source.failure=undefined;
      syncCip(lastDraw);
    },
    cooperativeDisplay:()=>lastDrawCooperative,presentationReady:()=>!atomicDraw, cameraInputReady:documentId=>!atomicDraw||atomicDraw.cameraOwner===documentId, project, projectMany, atomRadius, plane, hitTest, worldPoint, projectionReady,previewFragment,
    projectSphere(sphere){
      const orthographic=typeof viewer.camera?.ortho==='boolean'?viewer.camera.ortho:(options.orthographic??true);
      if(!orthographic)return null;
      validateSamplingSphereDisplay(sphere);
      const center=transformPoint(displayTransform,sphere.centerAngstrom),view=viewer.getView(),q=view.slice(4,8),norm=Math.hypot(...q);
      if(!Number.isFinite(norm)||norm<1e-12)return null;
      const inverse=q.map((v:number,index:number)=>(index<3?-v:v)/norm),right=rotateVector([1,0,0],inverse),up=rotateVector([0,1,0],inverse),a=screenProject(center),b=screenProject(add(center,scale(right,sphere.radiusAngstrom))),c=screenProject(add(center,scale(up,sphere.radiusAngstrom))),rx=Math.hypot(b.x-a.x,b.y-a.y),ry=Math.hypot(c.x-a.x,c.y-a.y);
      if(!Number.isFinite(rx)||!Number.isFinite(ry)||Math.abs(rx-ry)>1e-6*Math.max(1,rx,ry))return null;
      return {center:a,radius:(rx+ry)/2};
    },
    updateSamplingSphere(sphere,owner){
      assertLive();if(!lastDraw||!currentDocument||drawController||atomicDraw||owner&&(owner.id!==currentDocument.id||owner.revision!==currentDocument.revision))return false;
      const feedback={...lastDraw.feedback,samplingSphere:sphere};
      const changed=samplingSphereShapes.sync(sphere,displayTransform,JSON.stringify([currentDocument.id,feedback.sceneOwnerEpoch??null]));
      lastDraw={...lastDraw,feedback};
      if(changed)renderSubmissions.run('set-view',()=>{if(samplingSphereShapes.prepare()&&typeof viewer.setView==='function')viewer.setView(viewer.getView());else viewer.render();});
      return true;
    },
    setOrbitalLayer(layer) { assertLive(); return renderSubmissions.run('orbital-layer',()=>{orbitalLayer = layer; ntoLayer = null; try { if (orbitals.sync(layer, currentDocument, displayTransform)) viewer.render(); orbitals.markSubmitted(); } catch(error) { orbitals.failSubmission(error); throw error; }}); },
    setNtoLayer(layer) { assertLive(); return renderSubmissions.run('nto-layer',()=>{ntoLayer = layer; orbitalLayer = null; try {
      let changed = false;
      if (layer) { surfaceLayer = null; surfaceLayers = undefined; changed = surfaces.sync(null, currentDocument, displayTransform); }
      if (orbitals.sync(layer, currentDocument, displayTransform) || changed) viewer.render(); orbitals.markSubmitted();
    } catch(error) { orbitals.failSubmission(error); throw error; }}); },
    ntoMeshState: () => orbitals.meshState(),
    setSurfaceLayer(layer) { assertLive(); return renderSubmissions.run('surface-layer',()=>{surfaceLayers = undefined; surfaceLayer = layer; try { if (surfaces.sync(layer, currentDocument, displayTransform)) viewer.render(); surfaces.markSubmitted(); } catch (error) { surfaces.failSubmission(error); throw error; }}); },
    setSurfaceLayers(layers) { assertLive(); return renderSubmissions.run('surface-layers',()=>{surfaceLayer = null; surfaceLayers = layers; try {
      let changed = false;
      if (layers.length) { ntoLayer = null; orbitalLayer = null; changed = orbitals.sync(null, currentDocument, displayTransform); }
      if (surfaces.syncLayers(layers, currentDocument, displayTransform) || changed) viewer.render(); surfaces.markSubmitted();
    } catch (error) { surfaces.failSubmission(error); throw error; }}); },
    surfaceMeshState: () => surfaces.meshState(),
    surfaceMeshStates: () => surfaces.meshStates(),
    setSurfaceExtrema(layer) { assertLive(); return renderSubmissions.run('surface-extrema',()=>{surfaceExtrema = layer; if (surfaces.syncExtrema(layer, currentDocument, displayTransform)) viewer.render();}); },
    surfaceExtremumAt(screen) {
      assertLive();
      if (!surfaces.points().length || !inside(screen) || !synchronizeSize()) return null;
      const bounds = container.getBoundingClientRect();
      const targets = surfaces.points().map(row => ({ surfaceExtremumId: row.id, intersectionShape: { sphere: [sphere(row.position, .12)], cylinder: [], line: [], triangle: [] } }));
      const hits = viewer.targetedObjects((screen.x - bounds.left) * 2 / bounds.width - 1, 1 - (screen.y - bounds.top) * 2 / bounds.height, [...proxies, ...targets]);
      const hit = hits.find((entry: any) => Number.isFinite(entry.distance) && entry.distance >= 0);
      return hit?.clickable?.surfaceExtremumId ?? null;
    },
    pick(screen) {
      const hit = hitTest(screen);
      return hit.kind !== 'none' || !inside(screen) ? hit : { kind: 'none', worldPoint: worldPoint(screen) };
    },
    nearestAtom(screen, maxPixels = 30) { let best = maxPixels, chosen: string | null = null; for (const atom of positions) { if(hiddenAtoms.has(atom.id!))continue;const p = screenProject(coordinates(atom)), distance = Math.hypot(screen.x - p.x, screen.y - p.y); if (distance < best) { best = distance; chosen = atom.id!; } } return chosen; },
    getView: () => {
      const pending=atomicDraw?.cameraOwner?atomicDraw:null;
      const view=[...(pending?.manualView??pending?.publishedView??viewer.getView())];
      viewPivots.set(view,pending?.publishedPivot??viewPivot());return view;
    },
    setView(view) { assertLive(); if (view.length !== 8 || !view.every(Number.isFinite) || Math.hypot(...view.slice(4)) < 1e-10) throw new Error('观察姿态需要8个有限数值和有效四元数。'); renderSubmissions.run('set-view',()=>{viewer.setView([...view]);rememberCamera();}); },
    camera(view, dx, dy, kind, commitWithFrame=false) {
      assertLive();
      if(atomicDraw&&!atomicDraw.cameraOwner)return;
      const apply=()=>{
      if(atomicDraw?.cameraOwner)viewer.setView(atomicDraw.manualView??atomicDraw.publishedView,true);
      if(kind==='pan'){
        const current=viewer.getView();
        // screenOffsetToModel uses the current projection/zoom and quaternion.
        // Continuous pan retains those exact base fields; use its unchanged
        // public math, but commit only the final base+delta view. Arbitrary old
        // zoom/rotation inputs retain the original two-step endpoint fallback.
        if(typeof viewer.screenOffsetToModel==='function'&&view.length>=8&&view.every(Number.isFinite)&&view.slice(3,8).every((value,index)=>value===current[index+3])){
          const offset=viewer.screenOffsetToModel(dx,dy),delta=[offset.x,offset.y,offset.z];
          if(delta.every(Number.isFinite)){const next=[...view];for(let i=0;i<3;i++)next[i]+=delta[i];viewer.setView(next);rememberCamera();return;}
        }
        viewer.setView([...view]);viewer.translateScene(dx,dy);
      }else viewer.setView(rotateObjectView(view,dx,dy,viewPivots.get(view)??viewPivot()));
      rememberCamera();
      };
      const renderer=commitWithFrame&&!atomicDraw?viewer.getRenderer?.():undefined;
      if(renderer&&typeof renderer.render==='function'){
        // Apply the camera matrices now. The matching structure draw presents
        // them in the same submission instead of repainting the old frame.
        const original=renderer.render;
        renderer.render=()=>{};
        try{apply();cameraPreparedAt=renderCompletion.now();}
        finally{renderer.render=original;}
      }else renderSubmissions.run(kind==='pan'?'camera-pan':'camera-rotate',apply);
    },
    zoom(delta) { assertLive(); if(atomicDraw&&!atomicDraw.cameraOwner)return; renderSubmissions.run('zoom',()=>{
      if(atomicDraw?.cameraOwner)viewer.setView(atomicDraw.manualView??atomicDraw.publishedView,true);
      viewer.zoom(Math.exp(-Math.max(-300, Math.min(300, delta)) * .0015));rememberCamera();
    }); },
    getZoomDistance(){
      assertLive();
      if(typeof viewer.getPerceivedDistance!=='function')throw Object.assign(new Error('当前原生视口没有缩放距离读取接口。'),{code:'CAMERA_ZOOM_UNAVAILABLE'});
      return viewer.getPerceivedDistance();
    },
    zoomByFactor(factor){
      assertLive();
      if(!Number.isFinite(factor)||factor<=0)throw Object.assign(new Error('缩放 factor 需要有限正数；1.2 表示相对当前画面放大 20%。'),{code:'INVALID_ZOOM_FACTOR'});
      if(atomicDraw&&!atomicDraw.cameraOwner)throw Object.assign(new Error('视口正在提交新场景，请等待该场景就绪后缩放。'),{code:'CAMERA_BUSY'});
      if(typeof viewer.getPerceivedDistance!=='function')throw Object.assign(new Error('当前原生视口没有缩放距离读取接口。'),{code:'CAMERA_ZOOM_UNAVAILABLE'});
      return renderSubmissions.run('zoom',()=>{
        if(atomicDraw?.cameraOwner)viewer.setView(atomicDraw.manualView??atomicDraw.publishedView,true);
        const previousView=[...viewer.getView()],previousDistance=viewer.getPerceivedDistance();
        if(!Number.isFinite(previousDistance)||previousDistance<=0)throw Object.assign(new Error('当前相机距离无效，请先恢复有效视角再缩放。'),{code:'CAMERA_ZOOM_UNAVAILABLE'});
        // Validate the native arithmetic, rather than imposing a UI-sized cap.
        if(!Number.isFinite(previousDistance/factor)||!Number.isFinite(previousView[3]+previousDistance-previousDistance/factor))throw Object.assign(new Error('缩放倍率使原生相机距离超出有限数值范围，原视角已保留。'),{code:'INVALID_ZOOM_FACTOR'});
        viewer.zoom(factor);rememberCamera();
        const perceivedDistance=viewer.getPerceivedDistance(),view=[...viewer.getView()];
        const appliedFactor=previousDistance/perceivedDistance;
        return {requestedFactor:factor,appliedFactor,limited:Math.abs(appliedFactor-factor)>1e-10*Math.max(1,Math.abs(factor)),previousDistance,perceivedDistance,previousView,view};
      });
    },
    resetView,
    preserveEmptyPlacementView(documentId, baseRevision, nextRevision) {
      assertLive();
      if (currentId !== documentId || currentDocument?.revision !== baseRevision || positions.length || !Number.isSafeInteger(nextRevision) || nextRevision <= baseRevision) return;
      emptyPlacement = { documentId, baseRevision, nextRevision, view: [...viewer.getView()] };
    },
    orient(kind, preset) {
      assertLive(); if (!currentDocument) throw new Error('请先建立结构。');
      const frame:ViewFrame|null = kind === 'standard' ? (fixedViewCell?{right:[1,0,0],up:[0,1,0],toward:[0,0,1]}:principalInertiaFrame(currentDocument.draft.structure.atoms)) : currentDocument.draft.structure.cell && preset ? cellViewFrame(currentDocument.draft.structure.cell, preset) : null;
      if (!frame) throw new Error('当前结构没有有效晶胞。');
      const displayed = { right: rotate(displayTransform.rotation, frame.right), up: rotate(displayTransform.rotation, frame.up), toward: rotate(displayTransform.rotation, frame.toward) };
      renderSubmissions.run('orient',()=>viewer.setView(orientObjectView([...viewer.getView()], displayed, viewPivot())));
    },
    step(direction) { assertLive(); renderSubmissions.run('step',()=>viewer.setView(rotateObjectViewStep([...viewer.getView()], direction, viewPivot()))); },
    axes() { assertLive(); return projectPhysicalAxes([...viewer.getView()], displayTransform.rotation); },
    hover,
    resize(deferred=false,onComplete) {
      if(disposed)return;
      // Structural reflow (for example adding a slab's second viewport) must
      // synchronize its native buffer/aspect in the already-coalesced RAF.
      // Only a live divider drag may stretch the old buffer until settlement.
      if(deferred&&layoutResizing){const canvas=viewer.getCanvas?.();if(canvas?.style){canvas.style.width='100%';canvas.style.height='100%';}resizeSettler.request(()=>{if(onComplete)onComplete(deferredResizeError);else if(deferredResizeError)throw deferredResizeError;});}
      else {if(!resizeSettler.flush())synchronizeSize();onComplete?.();}
    },
    setLayoutResizing,
    clearObservationLayers() { assertLive(); clearNativeCoordinates(); trajectoryLayer.clear(); samplingSphereShapes.clear(); calculationRangeShapes.clear(); },
    multiframeState: () => trajectoryLayer.state(),
    diagnostics() {
      const sequence=sceneSequence.state(),owned=shapeResources.stats(),memory=disposed?undefined:viewer.getRenderer?.()?.info?.memory;
      const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
      const glyph=periodicBondGlyphs.diagnostics();
      return {...samplingSphereShapes.diagnostics(),...nativeCoordinateUpload.statistics(),residentCoordinateFrames,fragmentSamples,fragmentRetirementBatches,fragmentPartialPresents,fragmentFullPresents,fragmentRigidPresents,molecularMeshBuilds,coordinateBufferUpdates,shapeSlotCompactions,fragmentFallbackCode,scenePreparations,sceneAborts,glyphRegistrations:glyph.registrations,glyphBatches:glyph.batches,glyphBonds:glyph.bonds,glyphWorkerStarts:glyph.workerStarts,glyphWorkerStops:glyph.workerStops,glyphCancellations:glyph.cancellations,glyphAdjacencyBuilds:glyph.adjacencyBuilds,glyphPending:glyph.pending,
        sceneCreated:sequence.created,sceneReused:sequence.reused,sceneRetired:sequence.retired,sceneCommands:sequence.retainedCommands,sceneMetadataBytes:sequence.metadataBytes,
        ownedShapes:owned.shapes,ownedModels:owned.models,ownedResources:owned.resources,shapeSlots:Array.isArray(viewer.shapes)?viewer.shapes.length:null,modelSlots:Array.isArray(viewer.models)?viewer.models.length:null,
        gpuGeometries:count(memory?.geometries),gpuTextures:count(memory?.textures),gpuPrograms:count(memory?.programs)};
    },
    dispose() {
      if (disposed) return; disposed = true;
      wakeMeshes();
      releaseBackgroundObserver();
      drawController?.abort();cancelCip();
      let failure: unknown;
      const release = (action: () => unknown) => { try { action(); } catch (error) { failure ??= error; } };
      release(()=>atomicDraw?.rollback());
      release(()=>clearFragmentPreview(false));
      release(() => trajectoryLayer.dispose()); release(() => samplingSphereShapes.clear()); release(() => calculationRangeShapes.clear());
      release(() => renderCompletion.dispose()); release(() => renderSubmissions.dispose()); release(() => resizeSettler.dispose());
      release(()=>depthEnvelope.dispose());
      for(const owner of resizeOwners)release(() => owner.removeEventListener(VIEWPORT_LAYOUT_RESIZE_EVENT,acceptLayoutResize));
      release(() => captured.release()); release(() => orbitals.dispose()); release(() => surfaces.dispose());
      release(() => sceneSequence.dispose()); release(() => hoverShapes.clear());
      for (const layer of primitiveLayers) release(() => layer.clear());
      release(()=>periodicBondGlyphs.dispose()); release(removeOwnedModel); release(() => viewer.removeAllShapes()); release(() => labels.clear());
      release(() => shapeResources.dispose()); release(() => framebufferLifecycle.dispose()); release(() => nativeCoordinateUpload.dispose());
      basePicking.dispose(); imagePicking.dispose(); centroidSource=undefined; atomPickProxies.clear(); residentScene=undefined;
      // Locked WebGL2 shares a module-level OffscreenCanvas/context between
      // viewers. Only a context owned by this front canvas may be force-lost;
      // a shared Offscreen context outlives this viewer's explicit resources.
      const canvas = viewer.getCanvas();
      release(() => {
        const context = viewer.getRenderer?.()?.getContext?.() ?? canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? canvas?.getContext('experimental-webgl');
        if (context?.canvas === canvas) context.getExtension('WEBGL_lose_context')?.loseContext();
      });
      release(() => canvas?.remove()); proxies = []; imageProxies=[]; positions = []; currentDocument = null; renderedModel = null; modelMaterial = undefined; cachedViews.clear(); framedDocuments.clear();
      if (failure) throw failure;
    },
  };
}
