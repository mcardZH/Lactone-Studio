import type { CalculationRangeFeedback } from '../../results/calculation-range';
import type { Structure } from '../../core/types';
import { drawFreezeMarker } from '../modeling/freeze-marker-presentation';
import type { MultiframeDisplayPlan, SamplingSphereDisplay } from '../../modeling/view-multiframe';
import { assertResultNotAborted, trajectoryIndices, type TrajectoryRange, type TrajectoryResult } from '../../results/contracts';
import { StoredZipWriter, type ResultByteSink } from '../../results/export';
import { createGifEncoder } from '../../results/gif';
import {getPreparedTrajectoryFrame} from '../../results/prepared-trajectory';
import type { DisplaySettings, MeasurementState, ModelDocument } from '../../modeling/contracts';
import { createRenderAdapter } from '../modeling/render/adapter';
import type { RenderFeedbackOptions, ViewportAtomScalarValue, ViewportDipoleVector, ViewportVibrationVector } from '../modeling/render/adapter';
import type { ViewportOrbitalLayer } from '../../results/orbital-contracts';
import type { SurfaceProjection } from './surface-controls-contracts';
import { projectSurfaceExtremaLabels } from '../modeling/surface-overlays';
import { surfaceMeshKey, type ViewportSurfaceLayer } from '../modeling/render/surface-layer';
import { ntoMeshKey, type ViewportNtoLayer } from '../modeling/render/orbital-layer';
import { identityTransform } from '../modeling/render/alignment';
import type { RigidTransform } from '../modeling/render/alignment';
import type { AtomicProperty } from '../../results/scientific-contracts';
import { atomicScalars } from '../../results/scientific-analysis';
import { projectMeasurementLabels,projectStateMarkers } from '../modeling/viewport-overlays';
import { applyViewBondSnapshot, createViewBondSnapshot,prepareViewBondSnapshot, type ViewBondSnapshot } from '../../results/view-bonds';
import {projectResultAtomLabels,projectResultBondLabels,projectResultMeasurementLabels,resultSelectionPresentation,resultMeasurementValueLabel,resultTargetLabel,projectResultBondColors,type ViewportResultHighlights,type ViewportResultAtomLabel,type ViewportResultBondValue} from '../modeling/result-overlays';
import type {AnalysisColorbar} from './analysis-display';
import {drawAnalysisColorbar} from './analysis-colorbar-export';
import {axisOverlayMetrics} from '../modeling/render/display-settings';
import {drawResultLabelItems,resultLabelPresentation,resultLabelTargetKey,mergeResultLabelItems,measureResultLabelBox,layoutResultLabelItems,type ResultLabelItem} from '../modeling/result-label-presentation';

export interface FrameCapture {
  /** Must render into an owned canvas. Caller owns camera/display snapshot and restoration. */
  capture(structure: Structure, index: number, signal?: AbortSignal): Promise<HTMLCanvasElement>;
  dispose(): void | Promise<void>;
}
export interface FrameImageOptions {
  format: 'png' | 'gif' | 'png-sequence'; width: number; height: number;
  delayMs?: number; loop?: boolean; pingPong?: boolean; signal?: AbortSignal;
  sink?: ResultByteSink;
  onProgress?(completed: number, total: number): void;
}
export function validateImageBudget(options: FrameImageOptions, count: number): void {
  if (![options.width, options.height, count].every(Number.isSafeInteger) || options.width < 1 || options.height < 1 || count < 1 || !Number.isSafeInteger(options.width*options.height*4))
    throw new Error('图像尺寸或帧数无效，或超出可精确表示范围。');
  if(options.format==='gif'&&(options.width>65535||options.height>65535))throw new Error('GIF格式的宽和高不能超过65535像素。');
  if (options.format === 'png' && count !== 1) throw new Error('单张PNG需要选择一帧；多帧请使用PNG序列。');
  if (options.format === 'gif' && (!Number.isFinite(options.delayMs ?? 100) || (options.delayMs ?? 100) < 10 || (options.delayMs ?? 100) > 655350))
    throw new Error('GIF帧延时应为10–655350毫秒。');
}
/** Desktop writes only to a user-selected, token-owned temporary output. Browser fallback returns null. */
export async function openBinaryExportSink(name:string,extension:string,signal?:AbortSignal):Promise<ResultByteSink|'cancelled'|null>{
  assertResultNotAborted(signal);
  const bridge=typeof window==='undefined'?undefined:window.sciyueDesktop;
  if(!bridge?.beginBinaryExport||!bridge.appendBinaryExport||!bridge.commitBinaryExport||!bridge.abortBinaryExport)return null;
  const output=await bridge.beginBinaryExport({name,extension});if(!output)return 'cancelled';
  let ended=false;
  const abort=async()=>{if(!ended){ended=true;await bridge.abortBinaryExport!(output.token);}};
  if(signal?.aborted){await abort();assertResultNotAborted(signal);}
  return{
    async write(data){if(ended)throw Error('导出写入已结束。');assertResultNotAborted(signal);
      const blob=data instanceof Blob?data:new Blob([data as Uint8Array<ArrayBuffer>]);
      for(let offset=0;offset<blob.size;offset+=8*1024**2){assertResultNotAborted(signal);await bridge.appendBinaryExport!(output.token,new Uint8Array(await blob.slice(offset,offset+8*1024**2).arrayBuffer()));}
    },
    async close(){if(ended)throw Error('导出写入已结束。');assertResultNotAborted(signal);await bridge.commitBinaryExport!(output.token);ended=true;},abort,
  };
}
export async function writeExportParts(sink:ResultByteSink,parts:readonly BlobPart[]):Promise<void>{for(const part of parts)await sink.write(part instanceof Blob?part:new Blob([part]));}
export function canvasPng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  assertResultNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('图像导出已取消。', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      canvas.toBlob(blob => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { abort(); return; }
        if (blob) resolve(blob); else reject(new Error('画布PNG编码失败。'));
      }, 'image/png');
    } catch (error) { signal?.removeEventListener('abort', abort); reject(error); }
  });
}

/** Sequential capture, bounded pixels, finally-based disposal; never selects a model frame. */
export async function exportFrameImages(result: TrajectoryResult, range: TrajectoryRange, options: FrameImageOptions,
  createCapture: () => Promise<FrameCapture>): Promise<Blob> {
  const selected = trajectoryIndices(range, result.frames.length);
  // A full period visits each endpoint once: 0,1,2,3,2,1 then loops to 0.
  // Two frames are already a ping-pong period; a single frame stays single.
  const indices = options.pingPong && selected.length > 2 ? [...selected, ...selected.slice(1, -1).reverse()] : selected;
  validateImageBudget(options, indices.length); assertResultNotAborted(options.signal);
  const capture = await createCapture();
  const gif = options.format === 'gif' ? createGifEncoder(options.width, options.height, options.loop ?? true) : null;
  const zip=new StoredZipWriter(), names:string[]=[];
  try {
    for (const [ordinal, index] of indices.entries()) {
      assertResultNotAborted(options.signal);
      const structure = getPreparedTrajectoryFrame(result,index)?.structure ?? await result.getFrame(index, options.signal);
      assertResultNotAborted(options.signal);
      const source = await capture.capture(structure, index, options.signal);
      assertResultNotAborted(options.signal);
      // A detached 2D staging surface fixes pixel dimensions without resizing the viewer.
      const canvas = source.ownerDocument.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
      try {
        if(canvas.width!==options.width||canvas.height!==options.height)throw new Error('当前浏览器无法创建所选尺寸的完整画布。');
        const context = canvas.getContext('2d');
        if (!context || !source.width || !source.height) throw new Error('没有可导出的已渲染画布。');
        // Preserve aspect ratio and full viewport; do not distort or crop the molecular view.
        const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
        const width = source.width * scale, height = source.height * scale;
        context.fillStyle = '#f8fafb'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        if (options.format === 'gif') {
          gif!.addFrame({ rgba: context.getImageData(0, 0, canvas.width, canvas.height).data, delayMs: options.delayMs ?? 100 });
          if(options.sink)await writeExportParts(options.sink,gif!.takeChunks());
        } else {
          const png = await canvasPng(canvas, options.signal);
          if (options.format === 'png') { if(options.sink)await options.sink.write(png);options.onProgress?.(1, 1); return options.sink?new Blob():png; }
          const name=`frame-${String(ordinal + 1).padStart(6, '0')}-source-${index + 1}.png`;names.push(name);
          zip.add(name,new Uint8Array(await png.arrayBuffer()));
          if(options.sink)await writeExportParts(options.sink,zip.takeParts());
        }
        options.onProgress?.(ordinal + 1, indices.length);
      } finally { canvas.width = 0; canvas.height = 0; }
      // Yield between frames so browser cancellation and document-close events can run.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    assertResultNotAborted(options.signal);
    if (gif) {const parts=gif.finishChunks();if(options.sink){await writeExportParts(options.sink,parts);return new Blob();}return new Blob(parts,{type:'image/gif'});}
    const manifest = { schema: 'sciyue-png-sequence', version: 1, source: result.source, resultId: result.id,
      jobIndex: result.jobIndex, range, pingPong: options.pingPong ?? false, width: options.width, height: options.height,
      frames: indices.map((index, ordinal) => ({ file: names[ordinal], ...result.frames[index] })) };
    zip.add('manifest.json',new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'));
    const parts=zip.finishParts();if(options.sink){await writeExportParts(options.sink,parts);return new Blob();}return new Blob(parts,{type:'application/zip'});
  } finally { await capture.dispose(); }
}

export interface OffscreenCaptureSnapshot extends CalculationRangeFeedback {
  previewGuides?: RenderFeedbackOptions['previewGuides'];
  previewCell?: RenderFeedbackOptions['previewCell'];
  cellGuides?: RenderFeedbackOptions['cellGuides'];
  hiddenAtomIds?:readonly string[];
  /** Same protection IDs as the live viewport; never scientific freezes. */
  displayFrozenAtomIds?:readonly string[];
  multiframeDisplay?: MultiframeDisplayPlan;
  samplingSphere?: SamplingSphereDisplay;
  document: ModelDocument; cameraView: number[]; display: DisplaySettings; showAxes: boolean;
  width: number; height: number; viewportWidth?: number; viewportHeight?: number; measurement?: MeasurementState;
  /** Pixel dimensions are the rendering viewport, not an image stretch. */
  exactDimensions?:boolean; transparent?:boolean;
  viewBonds?: ViewBondSnapshot; resultKind?: TrajectoryResult['kind'];
  /** A mode phase is a display projection of one parent, not another source
   * frame. It retains that parent's confirmed graph and presentation identity. */
  displayGeometry?: 'vibration';
  /** Explicit parent when document already contains a displayed mode phase. */
  vibrationBaseStructure?: Structure;
  vibrationVectors?: readonly ViewportVibrationVector[];
  orbitalLayer?: ViewportOrbitalLayer;
  ntoLayer?: ViewportNtoLayer;
  /** Same immutable display projection consumed by the visible model canvas. */
  surfaceLayer?: SurfaceProjection['surfaceLayer'];
  surfaceLayers?: readonly ViewportSurfaceLayer[];
  surfaceExtrema?: SurfaceProjection['surfaceExtrema'];
  atomScalarValues?: readonly ViewportAtomScalarValue[];
  atomScalarColor?: boolean;
  atomScalarLabels?: boolean;
  dipoleVector?: ViewportDipoleVector;
  viewTransform?: RigidTransform;
  resultBondValues?:readonly ViewportResultBondValue[];
  resultBondLabels?:boolean;
  resultBondColor?:boolean;
  resultAtomLabels?:readonly ViewportResultAtomLabel[];
  resultHighlights?:ViewportResultHighlights;
  resultColorbar?:AnalysisColorbar;
  atomProperty?: AtomicProperty; atomicProperties?: readonly AtomicProperty[];
  /** Only derived display phases can share one confirmed parent geometry's property. */
  scalarSourceFrameIndex?: number;
  annotation?: string;
}
export interface ViewportImageExportOptions {
  format: 'png' | 'svg';
  includeAnnotations: boolean;
  width?:number; height?:number; transparent?:boolean;
  /** Actual visible viewport size supplied by the canvas owner, not menu dimensions. */
  viewportWidth?: number; viewportHeight?: number;
  /** A shared canvas may own measurements independently of its analysis controls. */
  measurement?: MeasurementState;
}
/** Only remove annotation projections. Molecular topology, fields, colors and
 * camera remain the same immutable capture inputs. */
export function viewportImageSnapshot(input: OffscreenCaptureSnapshot, includeAnnotations: boolean): OffscreenCaptureSnapshot {
  if (includeAnnotations) return input;
  return { ...input, display: { ...input.display, atomNumbers: false, elementNames: false, stereochemistry: false, regionLabels: false,
    frozenMarks: false, scanMarks: false, measurementMarks: false }, measurement: undefined, atomScalarLabels: false,
    surfaceExtrema: input.surfaceExtrema === undefined ? undefined : null, resultBondLabels: false, resultAtomLabels: [],
    resultHighlights: input.resultHighlights ? { atomIds: [], bondPairs: [] } : undefined, annotation: undefined };
}
/** SVG is an explicitly declared PNG image wrapper, not vector molecular geometry. */
export function canvasEmbeddedSvg(canvas: HTMLCanvasElement): Blob {
  if (!canvas.width || !canvas.height) throw new Error('没有可导出的已渲染画布。');
  const data = canvas.toDataURL('image/png');
  if (!data.startsWith('data:image/png;base64,')) throw new Error('画布 PNG 编码失败。');
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><title>Ester Studio 三维图片</title><desc>WebGL 快照；嵌入 PNG 位图，非矢量分子。</desc><image width="${canvas.width}" height="${canvas.height}" href="${data}"/></svg>`], { type: 'image/svg+xml;charset=utf-8' });
}
/** Shared public capture path for modeling, analysis and their own renderer windows. */
export async function exportViewportImage(input: OffscreenCaptureSnapshot, options: ViewportImageExportOptions, ownerDocument: Document, signal?: AbortSignal): Promise<Blob> {
  const snapshot = viewportImageSnapshot({ ...input, width:options.width??input.width,height:options.height??input.height,exactDimensions:options.width!==undefined||options.height!==undefined,transparent:options.transparent??false, viewportWidth: options.viewportWidth ?? input.viewportWidth, viewportHeight: options.viewportHeight ?? input.viewportHeight, measurement: options.measurement ?? input.measurement }, options.includeAnnotations);
  const capture = await createOffscreenCapture(snapshot, signal, ownerDocument);
  try {
    const canvas = await capture.capture(snapshot.document.draft.structure, snapshot.document.revision, signal);
    assertResultNotAborted(signal);
    return options.format === 'svg' ? canvasEmbeddedSvg(canvas) : await canvasPng(canvas, signal);
  } finally { await capture.dispose(); }
}
/** A dedicated renderer takes an immutable view snapshot. Visible frame, Undo,
 * input context, camera, and the user's canvas are never changed. */
export async function createOffscreenCapture(input: OffscreenCaptureSnapshot, signal?: AbortSignal, ownerDocument: Document = document): Promise<FrameCapture> {
  assertResultNotAborted(signal);
  // The workspace request also carries source readers/callbacks/AbortSignal.
  // Clone only the explicit render data, never the executable source handle.
  const snapshot: OffscreenCaptureSnapshot = structuredClone({ document: input.document, cameraView: input.cameraView,
    display: input.display, displayFrozenAtomIds:input.displayFrozenAtomIds, hiddenAtomIds:input.hiddenAtomIds, multiframeDisplay: input.multiframeDisplay, samplingSphere: input.samplingSphere, calculationRanges:input.calculationRanges, previewGuides:input.previewGuides,previewCell:input.previewCell,cellGuides:input.cellGuides, showAxes: input.showAxes, width: input.width, height: input.height,
    exactDimensions:input.exactDimensions,transparent:input.transparent,
    viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight, measurement: input.measurement,
    viewBonds: input.viewBonds, resultKind: input.resultKind, displayGeometry: input.displayGeometry,
    vibrationBaseStructure: input.vibrationBaseStructure, vibrationVectors: input.vibrationVectors,
    atomProperty: input.atomProperty, atomicProperties: input.atomicProperties, scalarSourceFrameIndex: input.scalarSourceFrameIndex, annotation: input.annotation,
    orbitalLayer: input.orbitalLayer, ntoLayer: input.ntoLayer, surfaceLayer: input.surfaceLayer, surfaceLayers: input.surfaceLayers, surfaceExtrema: input.surfaceExtrema,
    atomScalarValues: input.atomScalarValues, atomScalarColor: input.atomScalarColor, atomScalarLabels: input.atomScalarLabels, dipoleVector: input.dipoleVector, viewTransform: input.viewTransform,
    resultBondValues:input.resultBondValues,resultBondLabels:input.resultBondLabels,resultBondColor:input.resultBondColor,resultAtomLabels:input.resultAtomLabels,resultHighlights:input.resultHighlights,resultColorbar:input.resultColorbar });
  validateImageBudget({ format: 'png', width: snapshot.width, height: snapshot.height }, 1);
  const vibrationBase = snapshot.displayGeometry === 'vibration'
    ? snapshot.vibrationBaseStructure ?? snapshot.document.draft.structure : undefined;
  // Resolve the parent graph once. Display phases never infer reaction edges.
  const vibrationTopology = vibrationBase && applyViewBondSnapshot(
    await prepareViewBondSnapshot(vibrationBase, snapshot.scalarSourceFrameIndex ?? snapshot.document.revision,signal), vibrationBase).structure;
  const host = ownerDocument.createElement('div');
  const aspect = (snapshot.viewportWidth ?? snapshot.width) / (snapshot.viewportHeight ?? snapshot.height);
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('原视口尺寸无效。');
  const width = snapshot.exactDimensions?snapshot.width:Math.max(1, Math.round(Math.min(snapshot.width, snapshot.height * aspect)));
  const height = snapshot.exactDimensions?snapshot.height:Math.max(1, Math.round(width / aspect));
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none;overflow:hidden;`;
  host.setAttribute('aria-hidden', 'true'); ownerDocument.body.append(host);
  let adapter: Awaited<ReturnType<typeof createRenderAdapter>> | undefined;
  let disposed = false;
  const output = ownerDocument.createElement('canvas');
  const dispose = () => { if (disposed) return; disposed = true; try { adapter?.dispose(); } finally { host.remove(); output.width = 0; output.height = 0; } };
  try {
    adapter = await createRenderAdapter(host,{backgroundAlpha:snapshot.transparent?0:1}); assertResultNotAborted(signal);
    return {
      async capture(structure, index, frameSignal) {
        if (disposed) throw new Error('导出视图已释放。');
        assertResultNotAborted(signal); assertResultNotAborted(frameSignal);
        const matchesAtoms = (base: Structure) => {
          const ids = new Set(base.atoms.map(atom => atom.id));
          return ids.size === base.atoms.length && base.atoms.length === structure.atoms.length
            && base.atoms.every((atom, atomIndex) => Boolean(atom.id) && atom.id === structure.atoms[atomIndex].id && atom.element === structure.atoms[atomIndex].element);
        };
        if (vibrationBase && (!matchesAtoms(vibrationBase) || structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))))
          throw new Error('振动显示几何与原模式的原子对应不一致，无法导出。');
        const bondSnapshot = !vibrationBase && (structure.bonds===undefined?await prepareViewBondSnapshot(structure,index,signal??frameSignal):createViewBondSnapshot(structure,index));
        const renderedStructure = vibrationTopology
          ? { ...structure, bonds: structuredClone(vibrationTopology.bonds ?? []), bondSource: vibrationTopology.bondSource }
          : bondSnapshot ? applyViewBondSnapshot(bondSnapshot, structure).structure : structure;
        const frameDocument = { ...snapshot.document, revision: index, draft: { ...snapshot.document.draft, structure: renderedStructure } };
        const propertyFrame = snapshot.scalarSourceFrameIndex ?? index;
        const selection = snapshot.atomProperty;
        const property = selection && (snapshot.atomicProperties?.find(item => item.kind === selection.kind && item.scheme === selection.scheme && item.frameIndex === propertyFrame)
          ?? (selection.frameIndex === propertyFrame ? selection : undefined));
        const sameGeometry = Boolean(vibrationBase) || index === snapshot.document.revision && matchesAtoms(snapshot.document.draft.structure);
        const surfaceGeometry = sameGeometry && !vibrationBase && snapshot.document.draft.structure.atoms.every((atom, atomIndex) => {
          const current = structure.atoms[atomIndex]; return current && atom.x === current.x && atom.y === current.y && atom.z === current.z;
        });
        const hidden=new Set(snapshot.hiddenAtomIds),visible=(ids:readonly string[])=>ids.every(id=>!hidden.has(id));
        const rawPresentation=resultSelectionPresentation(renderedStructure,sameGeometry?snapshot.resultHighlights:undefined),resultPresentation={...rawPresentation,records:rawPresentation.records.filter(row=>visible(row.atomIds)),markers:rawPresentation.markers.filter(row=>visible(row.atomIds))};
        const values = sameGeometry && snapshot.atomScalarValues ? snapshot.atomScalarValues : property ? atomicScalars(property, renderedStructure, propertyFrame) : [];
        const draw=adapter!.drawAsync?.bind(adapter)??adapter!.draw.bind(adapter);await draw(frameDocument, snapshot.display, undefined, undefined, snapshot.viewTransform, snapshot.measurement, { displayFrozenAtomIds:snapshot.displayFrozenAtomIds,hiddenAtomIds:snapshot.hiddenAtomIds, multiframeDisplay: snapshot.multiframeDisplay, samplingSphere: snapshot.samplingSphere, calculationRanges:snapshot.calculationRanges, previewGuides:snapshot.previewGuides,previewCell:snapshot.previewCell,cellGuides:snapshot.cellGuides, vibrationVectors: sameGeometry ? snapshot.vibrationVectors : undefined, atomScalarValues: values.length ? values : undefined, atomScalarColor: snapshot.atomScalarColor, atomScalarLabels: snapshot.atomScalarLabels, dipoleVector: sameGeometry ? snapshot.dipoleVector : undefined,displaySelectionAtomIds:resultPresentation.atomIds,displayMeasurementRecords:resultPresentation.records },signal??frameSignal);
        // Parent wavefunction fields do not become valid for displaced atoms.
        if (snapshot.ntoLayer) adapter!.setNtoLayer(surfaceGeometry ? snapshot.ntoLayer : null);
        else if (snapshot.orbitalLayer && !vibrationBase) adapter!.setOrbitalLayer(snapshot.orbitalLayer);
        if (snapshot.surfaceLayers !== undefined) adapter!.setSurfaceLayers(surfaceGeometry ? snapshot.surfaceLayers : []);
        else if (snapshot.surfaceLayer !== undefined) adapter!.setSurfaceLayer(surfaceGeometry ? snapshot.surfaceLayer : null);
        if (surfaceGeometry && snapshot.ntoLayer?.visible) {
          const state = adapter!.ntoMeshState?.(), expected = ntoMeshKey(snapshot.ntoLayer, snapshot.viewTransform ?? identityTransform());
          if (state?.status !== 'committed' || !state.submitted || state.fieldId !== snapshot.ntoLayer.field.id || state.attemptKey !== expected || state.committedKey !== expected || !(state.vertexCount > 0 && state.triangleCount > 0))
            throw new Error(state?.error || '当前NTO没有实际提交的网格，不能导出请求态图片。');
        }
        if (surfaceGeometry && snapshot.surfaceLayers !== undefined) {
          const states = adapter!.surfaceMeshStates?.() ?? [];
          for (const layer of snapshot.surfaceLayers.filter(layer => layer.visible)) {
            const state = states.find(state => state.layerId === layer.id), expected = surfaceMeshKey(layer, snapshot.viewTransform ?? identityTransform());
            if (state?.status !== 'committed' || !state.submitted || state.shapeId !== layer.pair.shape.id || state.attemptKey !== expected || state.committedKey !== expected || !(state.vertexCount > 0 && state.triangleCount > 0))
              throw new Error(state?.error || '当前电子–空穴密度没有全部提交网格，不能导出请求态图片。');
          }
        } else if (surfaceGeometry && snapshot.surfaceLayer?.visible) {
          const state = adapter!.surfaceMeshState?.(), expected = surfaceMeshKey(snapshot.surfaceLayer, snapshot.viewTransform ?? identityTransform());
          if (state?.status !== 'committed' || !state.submitted || state.attemptKey !== expected || state.committedKey !== expected || !(state.vertexCount > 0 && state.triangleCount > 0))
            throw new Error(state?.error || '当前目标表面没有实际提交的分子网格，不能导出请求态图片。');
        }
        if (snapshot.surfaceExtrema !== undefined) adapter!.setSurfaceExtrema(surfaceGeometry ? snapshot.surfaceExtrema : null);
        // setView renders synchronously; copy immediately before WebGL buffer clear.
        adapter!.setView(snapshot.cameraView);
        const rendered = host.querySelector('canvas');
        if (!rendered?.width || !rendered.height) throw new Error('离屏场景没有已渲染画布。');
        const gl=rendered.getContext('webgl2')??rendered.getContext('webgl');
        if(gl&&'drawingBufferWidth' in gl&&(gl.isContextLost()||gl.drawingBufferWidth<rendered.width||gl.drawingBufferHeight<rendered.height))throw new Error('当前显卡无法完整渲染所选尺寸；未缩小或裁切导出图片。');
        output.width = width; output.height = height;
        if(output.width!==width||output.height!==height)throw new Error('当前浏览器无法创建所选尺寸的完整画布。');
        const context = output.getContext('2d'); if (!context) throw new Error('无法创建导出画布。');
        context.drawImage(rendered, 0, 0, width, height);
        const resultLabels:ResultLabelItem[]=[];
        if (surfaceGeometry && snapshot.surfaceExtrema) {
          const bounds=host.getBoundingClientRect();
          resultLabels.push(...projectSurfaceExtremaLabels(snapshot.surfaceExtrema,frameDocument,adapter!.project,{x:bounds.left,y:bounds.top},snapshot.display.fontSize));
        }
        if(sameGeometry&&(snapshot.resultBondLabels||snapshot.resultHighlights?.bondPairs.length||snapshot.resultAtomLabels?.length)){
          const bounds=host.getBoundingClientRect(),offset={x:bounds.left,y:bounds.top};
          for(const label of projectResultAtomLabels(renderedStructure,(snapshot.resultAtomLabels??[]).filter(row=>!hidden.has(row.atomId)),adapter!.project,offset))resultLabels.push({id:resultLabelTargetKey('atom',[label.atomId]),presentation:resultLabelPresentation(resultTargetLabel(renderedStructure,[label.atomId],label.label)??label.label,label,'top-left',snapshot.display.fontSize),target:{x:label.x-13,y:label.y-15}});
          for(const label of projectResultMeasurementLabels(renderedStructure,resultPresentation.records,adapter!.project,offset)){const body=resultMeasurementValueLabel(label.record,label.valueLabel,snapshot.resultBondValues);resultLabels.push({id:resultLabelTargetKey('pair',label.record.atomIds),presentation:resultLabelPresentation(resultTargetLabel(renderedStructure,label.record.atomIds,body)??body,label,'center',snapshot.display.fontSize),target:{x:label.x,y:label.y},bond:true});}
          for(const label of projectResultBondLabels(renderedStructure,(snapshot.resultBondValues??[]).filter(row=>snapshot.resultBondLabels&&visible(row.atomIds)&&!resultPresentation.records.some(record=>record.atomIds.every(id=>row.atomIds.includes(id)))),adapter!.project,offset))resultLabels.push({id:resultLabelTargetKey('pair',label.atomIds),presentation:resultLabelPresentation(resultTargetLabel(renderedStructure,label.atomIds,label.valueLabel)??label.valueLabel,label,'center',snapshot.display.fontSize),target:{x:label.x,y:label.y},bond:true});
        }
        if(sameGeometry&&snapshot.resultHighlights){
          const bounds=host.getBoundingClientRect(),offset={x:bounds.left,y:bounds.top};
          context.save();
          if(snapshot.resultBondColor)for(const row of projectResultBondColors(renderedStructure,(snapshot.resultBondValues??[]).filter(row=>visible(row.atomIds)),adapter!.project,offset)){context.strokeStyle=row.color;context.lineWidth=4;context.beginPath();context.moveTo(row.x1,row.y1);context.lineTo(row.x2,row.y2);context.stroke();}
          // Same marker anchors and glyph as ModelViewport, with no green
          // analysis-specific circles or invented graph lines in the capture.
          for(const marker of projectStateMarkers(renderedStructure.atoms,resultPresentation.markers,adapter!.project,offset,renderedStructure)){
            context.fillStyle='#ffe87ad9';context.strokeStyle='#946b00';context.lineWidth=1;context.beginPath();context.arc(marker.x,marker.y,8.5,0,Math.PI*2);context.fill();context.stroke();
            context.fillStyle='#946b00';context.font='bold 12px system-ui';context.textAlign='center';context.textBaseline='middle';context.fillText('✓',marker.x,marker.y);
          }
          context.restore();
        }
        if(sameGeometry&&(!(snapshot.surfaceLayer||snapshot.surfaceLayers?.length||snapshot.surfaceExtrema)||surfaceGeometry)&&snapshot.resultColorbar){
          drawAnalysisColorbar(context,snapshot.resultColorbar,{width,height},{width:snapshot.viewportWidth??width,height:snapshot.viewportHeight??height});
        }
        if(snapshot.display.frozenMarks&&snapshot.displayFrozenAtomIds){
          const bounds=host.getBoundingClientRect(),offset={x:bounds.left,y:bounds.top};
          const markers=[...new Set(snapshot.displayFrozenAtomIds)].filter(id=>!hidden.has(id)).map(atomId=>({id:`freeze:${atomId}`,kind:'freeze' as const,atomIds:[atomId]}));
          for(const marker of projectStateMarkers(renderedStructure.atoms,markers,adapter!.project,offset,renderedStructure))drawFreezeMarker(context,marker.x,marker.y);
        }
        if (snapshot.display.measurementMarks && snapshot.measurement || resultPresentation.records.length) {
          const state = snapshot.measurement, count = state?.atomIds.length ?? 0;
          const records = [...(snapshot.display.measurementMarks?(state?.records ?? []).filter(row=>visible(row.atomIds)):[])];
          if (snapshot.display.measurementMarks && state?.mode && count >= 2 && count <= 4 && visible(state.atomIds)) records.push({ id: 'transient-auto', mode: state.mode === 'auto' ? count === 2 ? 'distance' : count === 3 ? 'angle' : 'dihedral' : state.mode, atomIds: state.atomIds, color: '#277fdf' });
          const bounds = host.getBoundingClientRect();
          const offset={x:bounds.left,y:bounds.top};
          const labels = projectMeasurementLabels(renderedStructure.atoms, records, adapter!.project, offset, renderedStructure);
          context.font = `600 ${snapshot.display.fontSize}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle';
          for (const label of labels) {
            context.fillStyle=label.record.color;context.fillText(label.valueLabel,label.x,label.y);
          }
        }
        const visibleLabels=mergeResultLabelItems(resultLabels),placements=layoutResultLabelItems(visibleLabels,{width,height},label=>measureResultLabelBox(label,output.ownerDocument,context));
        drawResultLabelItems(context,visibleLabels,placements);
        if (snapshot.showAxes) {
          const {settings,size}=axisOverlayMetrics(snapshot.display);
          context.font = `600 ${settings.fontSize}px system-ui`; context.lineWidth = settings.lineWidth; context.textAlign = 'center'; context.textBaseline = 'alphabetic';
          context.fillStyle = '#ffffffe0'; context.fillRect(width - size-8, height-size-8, size, size);
          context.strokeStyle = '#dce7e1'; context.strokeRect(width-size-8, height-size-8, size, size);
          for (const axis of [...adapter!.axes()].sort((a, b) => a.depth - b.depth)) {
            const x = width-8-size/2, y = height-8-size/2;
            context.strokeStyle = context.fillStyle = settings.colors[axis.axis];
            context.beginPath(); context.moveTo(x, y); context.lineTo(x + axis.x * settings.length, y + axis.y * settings.length); context.stroke();
            context.beginPath(); context.arc(x + axis.x * settings.length, y + axis.y * settings.length, 2, 0, Math.PI * 2); context.fill();
            context.fillText(axis.axis, x + axis.x * (settings.length+7), y + 4 + axis.y * (settings.length+7));
          }
        }
        if (snapshot.annotation) {
          context.fillStyle = '#ffffffe8'; context.fillRect(0, height - 24, width, 24);
          context.fillStyle = '#36546a'; context.font = '11px system-ui'; context.textAlign = 'left'; context.textBaseline = 'middle';
          context.fillText(snapshot.annotation, 7, height - 12, width - 14);
        }
        return output;
      }, dispose,
    };
  } catch (error) { dispose(); throw error; }
}

/** Uses the same Blob download path supported by browser and Electron renderer.
 * Promise completion means download dispatched, never a claim of disk write completion. */
export function exportBlob(blob: Blob, filename: string, ownerDocument: Document = document): void {
  if (!filename || /[\\/\x00-\x1f]/.test(filename)) throw new Error('导出文件名无效。');
  const realm = ownerDocument.defaultView;
  if (!realm) throw new Error('导出窗口已关闭。');
  const urls = realm.URL, url = urls.createObjectURL(blob), anchor = ownerDocument.createElement('a');
  try { anchor.href = url; anchor.download = filename; anchor.hidden = true; ownerDocument.body.append(anchor); anchor.click(); }
  finally { anchor.remove(); realm.setTimeout(() => urls.revokeObjectURL(url), 1000); }
}
