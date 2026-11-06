import type { Vector3 } from '../../../core/types';
import type { ModelDocument } from '../../../modeling/contracts';
import type { SurfaceFieldPair, SurfaceScalarField } from '../../../results/surface-contracts';
import type { InteractionFieldPair } from '../../../results/interaction-contracts';
import type { ExcitationDensityFieldPair } from '../../../results/excitation-contracts';
import type { HirshfeldFieldPair, HirshfeldSelectedCluster } from '../../../results/hirshfeld-contracts';
import { validateHirshfeldFieldPair } from '../../../results/hirshfeld-field';
import { hirshfeldPositionMatches, type HirshfeldContactFocus } from '../../../results/hirshfeld-presentation';
import { validateExcitationDensityFieldPair } from '../../../results/excitation-field';
import { validateInteractionFieldPair } from '../../../results/interaction-field';
import { createSurfaceFieldSampler, sameSurfaceContext, validateSurfaceScalarField, validateSurfaceFieldPair } from '../../../results/surface-field';
import { composeTransforms, identityTransform, inversePoint, rotate, transformPoint, type RigidTransform } from './alignment';
import { point } from './geometry';
import { createShapeLayer } from './shape-layer';
import { MODEL_HOVER_COLOR } from '../modeling-interaction-policy';
import { createSurfaceMesh, type SurfaceMesh } from './surface-mesh';
import { meshGeometryChunks } from './mesh-geometry';
import { updateCustomMeshAppearance } from './mesh-appearance';
import { createScalarGradientNormals } from './field-gradient-normals';
import { attachLocalMeshFinish, updateLocalMeshFinish } from './mesh-finish';
import { meshFinishKey, type MeshFinishSettings } from '../../../results/mesh-appearance';
import {unionRenderBounds} from './depth-envelope';
import { interpolateColor, zeroCenteredFraction } from '../../../results/zero-centered-color';

const BOHR_TO_ANGSTROM = .529177210903;
export interface SurfaceColorMapping { min: number; max: number; colors: readonly string[]; reverse?: boolean; zeroCentered?: boolean }
/** CPU mesh commitment only; never GPU/compositor completion. */
export interface SurfaceMeshState {
  status: 'empty' | 'pending' | 'committed' | 'failed'; attemptKey: string | null; committedKey: string | null;
  sourceId?: string; sourceRevision?: string; shapeId?: string; mappingId?: string | null;
  shapeCount: number; vertexCount: number; triangleCount: number; colored: boolean; submitted: boolean; error?: string;
}
export interface ViewportSurfaceLayer {
  /** Required and stable within the owning analysis for multi-field display. */
  id?: string;
  pair: SurfaceFieldPair | InteractionFieldPair | ExcitationDensityFieldPair | HirshfeldFieldPair;
  documentId: string; geometryRevision: number; visible: boolean; opacity: number;
  finish?: MeshFinishSettings;
  /** Data remain untransformed. This accepted display fit precedes the camera pose. */
  sourceToDocument?: { rotation: [Vector3, Vector3, Vector3]; translation: Vector3 };
  /** The owner supplies the effective SURFACE range, never a whole-box range. */
  color?: SurfaceColorMapping;
  /** Uniform physical-density material; no mapped scalar or orbital phase. */
  solidColor?: string;
  /** Presentation classification only; quantitative native areas stay immutable. */
  contactFocus?: { source: HirshfeldSelectedCluster; contact: HirshfeldContactFocus | null };
}
export interface SurfaceLayerMeshState extends SurfaceMeshState { layerId: string }
export interface ViewportSurfaceExtremum {
  id: string; position: Vector3; label: string; kind: 'maximum' | 'minimum'; global?: boolean;
  identityLabel?: string; coordinateLabel?: string;
}
export interface ViewportSurfaceExtrema {
  documentId: string; geometryRevision: number; visible: boolean;
  /** Independent presentation channels; omission preserves existing consumers. */
  markersVisible?: boolean; valuesVisible?: boolean; coordinatesVisible?: boolean; hiddenIds?: readonly string[];
  /** True spatial Å targets from quantitative analysis, never model atoms. */
  points: readonly ViewportSurfaceExtremum[];
  pinnedIds: readonly string[]; hoveredId?: string | null; showAllValues?: boolean;
  sourceToDocument?: ViewportSurfaceLayer['sourceToDocument'];
}
export function surfaceLayerCurrent(layer: { visible: boolean; documentId: string; geometryRevision: number } | null | undefined, document: Pick<ModelDocument, 'id' | 'revision'> | null | undefined): boolean {
  return Boolean(layer?.visible && document && layer.documentId === document.id && layer.geometryRevision === document.revision);
}
export function surfaceDisplayTransform(layer: Pick<ViewportSurfaceLayer, 'sourceToDocument'>, transform: RigidTransform): RigidTransform {
  const pose = layer.sourceToDocument ? composeTransforms(transform, { ...layer.sourceToDocument, anchorIds: [] }) : transform;
  if (![...pose.rotation.flat(), ...pose.translation].every(Number.isFinite)) throw new Error('表面显示姿态必须是有限刚性变换。');
  return pose;
}
export function surfaceExtremaPoints(layer: ViewportSurfaceExtrema | null | undefined, document: Pick<ModelDocument, 'id' | 'revision'> | null | undefined): readonly ViewportSurfaceExtremum[] {
  if (!surfaceLayerCurrent(layer, document)) return [];
  const ids = new Set<string>(), hidden = new Set(layer!.hiddenIds);
  return layer!.points.filter(row => {
    if (!row.id || ids.has(row.id) || hidden.has(row.id) || !row.label || row.position.length !== 3 || !row.position.every(Number.isFinite)) return false;
    ids.add(row.id); return true;
  });
}
export function surfaceExtremumDocumentPosition(layer: ViewportSurfaceExtrema, position: Vector3): Vector3 {
  return transformPoint(surfaceDisplayTransform(layer, identityTransform()), position);
}

/** Independent physical-field volume; orbital psi units/semantics stay untouched. */
export function surfaceVolumeData(mol: any, field: SurfaceScalarField, pose: RigidTransform) {
  validateSurfaceScalarField(field);
  if (field.validDomain.kind === 'unknown') throw new Error('表面定义格点有效域未知，无法可靠显示。');
  if (field.validDomain.kind === 'node-mask' && field.validDomain.mask.some(value => value !== 1))
    throw new Error('表面定义格点包含未计算节点，不能生成虚假的域边界表面。');
  const factor = field.grid.coordinateUnit === 'bohr' ? BOHR_TO_ANGSTROM : 1;
  const origin = transformPoint(pose, field.grid.origin.map(value => value * factor) as Vector3);
  const axes = field.grid.axes.map(axis => rotate(pose.rotation, axis.map(value => value * factor) as Vector3));
  const volume = new mol.VolumeData('', '');
  volume.size = { x: field.grid.dimensions[0], y: field.grid.dimensions[1], z: field.grid.dimensions[2] };
  volume.data = field.values;
  volume.matrix = new mol.Matrix4(axes[0][0], axes[1][0], axes[2][0], origin[0], axes[0][1], axes[1][1], axes[2][1], origin[1], axes[0][2], axes[1][2], axes[2][2], origin[2], 0, 0, 0, 1);
  return volume;
}
/** Trilinear physical sampling. All eight interpolation nodes must be valid,
 * including zero-weight boundary neighbours; real scalar zero remains zero. */
export function surfaceColorSampler(field: SurfaceScalarField, pose: RigidTransform = identityTransform()): (x: number, y: number, z: number) => number {
  const sample = createSurfaceFieldSampler(field), factor = field.grid.coordinateUnit === 'bohr' ? BOHR_TO_ANGSTROM : 1;
  return (x, y, z) => {
    const raw = inversePoint(pose, [x, y, z]);
    const result = sample(raw.map(value => value / factor) as Vector3);
    if (result === null) throw new Error('表面着色采样或插值邻点超出有效域，不能将域外填充值当作物理值。');
    return result;
  };
}
export function surfaceColor(value: number, mapping: SurfaceColorMapping): string {
  if (![value, mapping.min, mapping.max].every(Number.isFinite) || mapping.min > mapping.max || mapping.colors.length < 2 || mapping.colors.some(color => !/^#[0-9a-f]{6}$/i.test(color)))
    throw new Error('表面连续色标范围或配色无效。');
  if (mapping.zeroCentered) {
    const fraction = zeroCenteredFraction(value, mapping.min, mapping.max);
    return interpolateColor(mapping.reverse ? 1 - fraction : fraction, mapping.colors);
  }
  const extent = Math.max(Math.abs(mapping.min), Math.abs(mapping.max));
  let fraction = mapping.min === mapping.max ? .5 : Math.max(0, Math.min(1, (value / extent - mapping.min / extent) / (mapping.max / extent - mapping.min / extent)));
  if (mapping.reverse) fraction = 1 - fraction;
  const position = fraction * (mapping.colors.length - 1), lower = Math.min(mapping.colors.length - 2, Math.floor(position)), blend = position - lower;
  return '#' + [1, 3, 5].map(offset => {
    const a = parseInt(mapping.colors[lower].slice(offset, offset + 2), 16), b = parseInt(mapping.colors[lower + 1].slice(offset, offset + 2), 16);
    return Math.round(a * (1 - blend) + b * blend).toString(16).padStart(2, '0');
  }).join('');
}

export function sameSurfaceGrid(a: SurfaceScalarField, b: SurfaceScalarField): boolean {
  return a.grid.coordinateUnit === b.grid.coordinateUnit && a.grid.ordering === b.grid.ordering
    && a.grid.dimensions.every((v, i) => v === b.grid.dimensions[i]) && a.grid.origin.every((v, i) => v === b.grid.origin[i])
    && a.grid.axes.every((axis, i) => axis.every((v, j) => v === b.grid.axes[i][j]));
}
const arrayIdentities=new WeakMap<object,number>();let nextArrayIdentity=0;
function arrayIdentity(array:object){let id=arrayIdentities.get(array);if(id===undefined){id=++nextArrayIdentity;arrayIdentities.set(array,id);}return id;}
function fieldGeometryKey(field:SurfaceScalarField|null){
  if(!field)return null;
  const domain=field.validDomain;
  // Fields/arrays are immutable scientific snapshots. Replacing a mask/value
  // array must invalidate geometry even if the outer field object is reused;
  // pure appearance never scans/hashes a whole scalar volume.
  return [arrayIdentity(field.values),field.grid,field.function,field.valueUnit,field.definitionEvidence,
    domain.kind,domain.kind==='node-mask'?[arrayIdentity(domain.mask),domain.evidence,domain.restrictedTo]:domain];
}
function interactionPair(pair:ViewportSurfaceLayer['pair']):pair is InteractionFieldPair{return 'kind' in pair&&pair.kind==='interaction';}
function excitationPair(pair:ViewportSurfaceLayer['pair']):pair is ExcitationDensityFieldPair{return 'kind' in pair&&pair.kind==='excitation-density';}
function hirshfeldPair(pair:ViewportSurfaceLayer['pair']):pair is HirshfeldFieldPair{return 'kind' in pair&&pair.kind==='hirshfeld';}
function pairGeometryKey(pair:ViewportSurfaceLayer['pair']){return [interactionPair(pair)?[pair.kind,pair.method,pair.component,pair.inside]:excitationPair(pair)?[pair.kind,pair.shape.excitationRole,pair.shape.state]:null,fieldGeometryKey(pair.shape),fieldGeometryKey(pair.mapping)];}
function validCell(field:SurfaceScalarField,cell:Vector3){
  const domain=field.validDomain;if(domain.kind==='unknown')return false;if(domain.kind==='full-grid')return true;
  const [,ny,nz]=field.grid.dimensions;
  for(let x=0;x<2;x++)for(let y=0;y<2;y++)for(let z=0;z<2;z++)if(domain.mask[((cell[0]+x)*ny+cell[1]+y)*nz+cell[2]+z]!==1)return false;
  return true;
}
export function surfaceMeshKey(layer: ViewportSurfaceLayer, transform: RigidTransform): string {
  return JSON.stringify([layer.documentId, layer.geometryRevision, layer.pair.shape.context, layer.pair.shape.id, layer.pair.shape.source.revision,
    layer.pair.mapping?.id, layer.pair.mapping?.source.revision, pairGeometryKey(layer.pair), layer.sourceToDocument, layer.pair.isovalue, layer.opacity, layer.color, layer.solidColor, layer.contactFocus?.contact, transform.rotation, transform.translation,meshFinishKey(layer.finish)]);
}
const emptyMeshState = (): SurfaceMeshState => ({ status: 'empty', attemptKey: null, committedKey: null, shapeCount: 0, vertexCount: 0, triangleCount: 0, colored: false, submitted: false });

/** Pre-sampled colors survive 3Dmol's Float32 upload. Chunk below its splitMesh
 * threshold (whose colorArr propagation is not reliable in the locked version). */
function customSurfaceChunks(mesh: SurfaceMesh, pose: RigidTransform, factor: number, color?: SurfaceColorMapping, normalAt?: (position: Vector3) => Vector3 | null, focus?: ViewportSurfaceLayer['contactFocus']) {
  const colors = color && mesh.values ? mesh.values.map((value, index) => {
    const hex = focusedColor(value, color, mesh.vertices[index].map(value => value * factor) as Vector3, focus); return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
  }) : undefined;
  return meshGeometryChunks(mesh, pose, factor, colors, mesh.values !== null, normalAt);
}
function focusedColor(value: number, color: SurfaceColorMapping, position?: Vector3, focus?: ViewportSurfaceLayer['contactFocus']) {
  return focus?.contact && position && !hirshfeldPositionMatches(position, focus.source, focus.contact) ? '#dbe2e8' : surfaceColor(value, color);
}

/** Owned native GLShapes, shared by visible and offscreen adapters. */
export function createSurfaceLayer(viewer: any, mol: any) {
  let surfaceShapes = createShapeLayer(viewer);
  const extremaShapes = createShapeLayer(viewer);
  let shapeField: SurfaceScalarField | null = null, mappingField: SurfaceScalarField | null = null, surfaceSignature = '', extremaSignature = '';
  let geometrySignature = '', colorSignature = '', finishSignature = '', materialOpacity = 0;
  // Only current native handles and their one necessary scalar sample array.
  // No full source mesh or source-index array survives a completed build.
  let materials: { handle: any; vertices: number; samples: number[] | null; sourcePositions?: Vector3[] }[] = [];
  let meshState = emptyMeshState();
  let points: { id: string; position: Vector3 }[] = [];
  return {
    bounds:()=>unionRenderBounds(surfaceShapes.bounds(),extremaShapes.bounds()),
    sync(layer: ViewportSurfaceLayer | null, document: ModelDocument | null, transform: RigidTransform): boolean {
      if (!surfaceLayerCurrent(layer, document)) {
        const changed = surfaceShapes.size > 0; surfaceShapes.clear(); materials = []; shapeField = mappingField = null; surfaceSignature = geometrySignature = colorSignature = finishSignature = ''; meshState = emptyMeshState(); return changed;
      }
      const current = layer!, { pair } = current;
      const key = surfaceMeshKey(current, transform);
      if (shapeField === pair.shape && mappingField === pair.mapping && surfaceSignature === key) return false;
      const color = pair.mapping ? current.color : undefined, solidColor = current.solidColor ?? '#d5dfdf', nextColorSignature = JSON.stringify([color, solidColor, current.contactFocus?.contact]);
      const nextFinishSignature=meshFinishKey(current.finish);
      const geometryKey = JSON.stringify([current.documentId, current.geometryRevision, pair.shape.context, pair.shape.id, pair.shape.source.revision,
        pair.mapping?.id, pair.mapping?.source.revision, pairGeometryKey(pair), current.sourceToDocument, pair.isovalue, Boolean(color), transform.rotation, transform.translation]);
      meshState = { ...meshState, status: 'pending', attemptKey: key, sourceId: pair.shape.context.sourceId, sourceRevision: pair.shape.context.sourceRevision, shapeId: pair.shape.id, mappingId: pair.mapping?.id ?? null, submitted: false, error: undefined };
      const next = createShapeLayer(viewer);
      try {
        if (!Number.isFinite(pair.isovalue) || !Number.isFinite(current.opacity) || current.opacity < 0 || current.opacity > 1) throw new Error('表面等值或透明度无效。');
        if (!/^#[0-9a-f]{6}$/i.test(solidColor)) throw new Error('表面单色配色无效。');
        if (color) surfaceColor(color.min, color);
        if (shapeField === pair.shape && mappingField === pair.mapping && geometrySignature === geometryKey) {
          const recolor = colorSignature !== nextColorSignature;
          for (const entry of materials) {
            const colors = recolor ? color && entry.samples ? entry.samples.map((value, index) => focusedColor(value, color, entry.sourcePositions?.[index], current.contactFocus)) : solidColor : undefined;
            if (colors || materialOpacity !== current.opacity) updateCustomMeshAppearance(entry.handle, entry.vertices, current.opacity, colors);
            if (finishSignature!==nextFinishSignature) updateLocalMeshFinish(entry.handle,current.finish);
          }
          surfaceSignature = key; colorSignature = nextColorSignature; finishSignature=nextFinishSignature; materialOpacity = current.opacity;
          meshState = { ...meshState, status: 'committed', committedKey: key, error: undefined };
          return true;
        }
        const interaction=interactionPair(pair),inside=interaction?pair.inside:'above';
        const validation = interaction ? validateInteractionFieldPair(pair) : excitationPair(pair) ? validateExcitationDensityFieldPair(pair) : hirshfeldPair(pair) ? validateHirshfeldFieldPair(pair) : validateSurfaceFieldPair(pair); if (!validation.compatible) throw new Error(validation.reasons.join('；'));
        const pose = surfaceDisplayTransform(current, transform);
        const sampler = pair.mapping && color ? createSurfaceFieldSampler(pair.mapping) : undefined, sameGrid = pair.mapping && sameSurfaceGrid(pair.shape, pair.mapping);
        const mesh = createSurfaceMesh(pair.shape, pair.isovalue, mol.MarchingCube, sampler ? (position, cell) => {
          const value = sampler(position, sameGrid ? cell : undefined);
          if (value === null&&!interaction) throw new Error('表面着色采样或插值邻点超出有效域，不能将域外填充值当作物理值。');
          return value;
        } : undefined,inside,interaction?{cell:cell=>validCell(pair.shape,cell)&&(!sampler||!sameGrid||validCell(pair.mapping!,cell)),invalidSample:'skip-cell'}:undefined);
        if (!mesh.faces.length) throw new Error('当前标量等值及有效域没有可提交的表面三角形。');
        const gradientNormal=createScalarGradientNormals(pair.shape);
        const factor = pair.shape.grid.coordinateUnit === 'bohr' ? BOHR_TO_ANGSTROM : 1;
        const chunks = customSurfaceChunks(mesh, pose, factor, color, position=>gradientNormal(position,inside==='below'?1:-1), current.contactFocus);
        let vertexCount = 0, triangleCount = 0;
        const nextMaterials: typeof materials = [];
        for (const chunk of chunks) {
          const { sourceIndices, ...geometry } = chunk;
          if (mesh.values && !sourceIndices) throw new Error('映射网格缺少原始采样值对应。');
          const handle: any = viewer.addCustom({ ...geometry, color: solidColor, opacity: current.opacity, clickable: false, hoverable: false });
          next.keep(handle);
          attachLocalMeshFinish(handle,current.finish);
          nextMaterials.push({ handle, vertices: chunk.vertexArr.length, samples: mesh.values ? sourceIndices!.map(index => mesh.values![index]) : null,
            ...(current.contactFocus && sourceIndices ? { sourcePositions: sourceIndices.map(index => mesh.vertices[index].map(value => value * factor) as Vector3) } : {}) });
          // Locked GLShape.globj reapplies handle.color on every render. Its
          // own volumetric-color path deletes it too; retain our uploaded RGB.
          if (color) delete handle.color;
          const groups = handle?.geo?.geometryGroups;
          if (!groups?.length) throw new Error('分子表面没有实际提交的渲染几何。');
          for (const group of groups) { vertexCount += group.vertices; triangleCount += group.faceidx / 3; }
        }
        if (!(vertexCount > 0 && triangleCount > 0)) throw new Error('分子表面实际渲染几何为空。');
        surfaceShapes.clear(); surfaceShapes = next; materials = nextMaterials; shapeField = pair.shape; mappingField = pair.mapping; surfaceSignature = key;
        geometrySignature = geometryKey; colorSignature = nextColorSignature; finishSignature=nextFinishSignature; materialOpacity = current.opacity;
        meshState = { ...meshState, status: 'committed', committedKey: key, shapeCount: next.size, vertexCount, triangleCount, colored: Boolean(color && sampler), error: undefined };
        return true;
      } catch (error) {
        next.clear(); surfaceShapes.clear(); materials = []; shapeField = mappingField = null; surfaceSignature = geometrySignature = colorSignature = finishSignature = '';
        meshState = { ...meshState, status: 'failed', committedKey: null, shapeCount: 0, vertexCount: 0, triangleCount: 0, colored: false, submitted: false, error: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    },
    syncExtrema(layer: ViewportSurfaceExtrema | null, document: ModelDocument | null, transform: RigidTransform): boolean {
      const currentPoints = layer?.markersVisible === false ? [] : surfaceExtremaPoints(layer, document);
      const key = JSON.stringify([layer?.documentId, layer?.geometryRevision, currentPoints, layer?.sourceToDocument, layer?.pinnedIds, layer?.hoveredId, transform.rotation, transform.translation]);
      if (key === extremaSignature) return false;
      extremaShapes.clear(); points = []; extremaSignature = '';
      if (!layer || !currentPoints.length) { extremaSignature = key; return true; }
      const pose = surfaceDisplayTransform(layer, transform), pinned = new Set(layer.pinnedIds);
      try {
        for (const row of currentPoints) {
          const position = transformPoint(pose, row.position);
          extremaShapes.keep(viewer.addSphere({ center: point(position), radius: .055, color: row.kind === 'maximum' ? '#c54b4b' : '#3c70c5', clickable: false, hoverable: false }));
          if (pinned.has(row.id) || row.id === layer.hoveredId)
            extremaShapes.keep(viewer.addSphere({ center: point(position), radius: .09, color: MODEL_HOVER_COLOR, wireframe: true, linewidth: 2.6, clickable: false, hoverable: false }));
          points.push({ id: row.id, position });
        }
      } catch (error) { extremaShapes.clear(); points = []; throw error; }
      extremaSignature = key; return true;
    },
    points: () => points,
    meshState: (): Readonly<SurfaceMeshState> => ({ ...meshState }),
    markSubmitted() { if (meshState.status === 'committed') meshState = { ...meshState, submitted: true }; },
    failSubmission(error: unknown) {
      if (meshState.status !== 'committed') return;
      surfaceShapes.clear(); materials = []; shapeField = mappingField = null; surfaceSignature = geometrySignature = colorSignature = finishSignature = '';
      meshState = { ...meshState, status: 'failed', committedKey: null, submitted: false, shapeCount: 0, vertexCount: 0, triangleCount: 0, colored: false, error: error instanceof Error ? error.message : String(error) };
    },
    dispose() { surfaceShapes.clear(); extremaShapes.clear(); materials = []; shapeField = mappingField = null; surfaceSignature = geometrySignature = colorSignature = finishSignature = extremaSignature = ''; points = []; meshState = emptyMeshState(); },
  };
}

/** One active analysis owns at most the two true e/h density meshes. Each uses
 * the same single-field builder as Main-12; no retained historical managers. */
export function createSurfaceLayers(viewer: any, mol: any) {
  const legacy = createSurfaceLayer(viewer, mol);
  const layers = new Map<string, ReturnType<typeof createSurfaceLayer>>();
  const clearLayers = () => { for (const layer of layers.values()) layer.dispose(); layers.clear(); };
  return {
    bounds:()=>unionRenderBounds(legacy.bounds(),...[...layers.values()].map(layer=>layer.bounds())),
    sync(layer: ViewportSurfaceLayer | null, document: ModelDocument | null, transform: RigidTransform) {
      const removed = layers.size > 0; clearLayers(); return legacy.sync(layer, document, transform) || removed;
    },
    syncLayers(current: readonly ViewportSurfaceLayer[], document: ModelDocument | null, transform: RigidTransform) {
      let changed = legacy.sync(null, document, transform);
      try {
        if (current.length > 2 || current.some(layer => !layer.id?.trim() || !excitationPair(layer.pair)) || new Set(current.map(layer => layer.id)).size !== current.length)
          throw new Error('电子–空穴覆盖层须为至多两个具有独立稳定身份的密度格点。');
        if (current.length === 2) {
          const [a, b] = current, first = a.pair as ExcitationDensityFieldPair, second = b.pair as ExcitationDensityFieldPair;
          if (first.shape.excitationRole === second.shape.excitationRole || !sameSurfaceContext(first.shape.context, second.shape.context)
            || JSON.stringify(first.shape.state) !== JSON.stringify(second.shape.state) || !sameSurfaceGrid(first.shape, second.shape)
            || JSON.stringify(first.shape.atoms) !== JSON.stringify(second.shape.atoms) || a.documentId !== b.documentId || a.geometryRevision !== b.geometryRevision
            || first.isovalue !== second.isovalue || a.opacity !== b.opacity || meshFinishKey(a.finish) !== meshFinishKey(b.finish)
            || JSON.stringify(a.sourceToDocument) !== JSON.stringify(b.sourceToDocument)) throw new Error('电子–空穴双密度须来自同一态和网格，并共享等值、透明度、材质与显示姿态。');
        }
        const ids = new Set(current.map(layer => layer.id!));
        for (const [id, layer] of layers) if (!ids.has(id)) { layer.dispose(); layers.delete(id); changed = true; }
        for (const layer of current) {
          let manager = layers.get(layer.id!);
          if (!manager) { manager = createSurfaceLayer(viewer, mol); layers.set(layer.id!, manager); }
          changed = manager.sync(layer, document, transform) || changed;
        }
        return changed;
      } catch (error) {
        // A failed partner must never leave a plausible half-complete overlay.
        for (const layer of layers.values()) layer.failSubmission(error);
        throw error;
      }
    },
    syncExtrema: legacy.syncExtrema,
    points: legacy.points,
    meshState: legacy.meshState,
    meshStates: (): readonly SurfaceLayerMeshState[] => [...layers].map(([layerId, layer]) => ({ ...layer.meshState(), layerId })),
    markSubmitted() { legacy.markSubmitted(); for (const layer of layers.values()) layer.markSubmitted(); },
    failSubmission(error: unknown) { legacy.failSubmission(error); for (const layer of layers.values()) layer.failSubmission(error); },
    dispose() { legacy.dispose(); clearLayers(); },
  };
}
