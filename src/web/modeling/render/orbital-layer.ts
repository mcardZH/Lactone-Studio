import type { ViewportOrbitalLayer } from '../../../results/orbital-contracts';
import type { NtoField } from '../../../results/excitation-contracts';
import { validateNtoField } from '../../../results/excitation-field';
import type { SurfaceMeshState } from './surface-layer';
import type { ModelDocument } from '../../../modeling/contracts';
import { composeTransforms, rotate, transformPoint, type RigidTransform } from './alignment';
import { cross, dot } from './geometry';
import { createShapeLayer } from './shape-layer';
import { retainNativeShapeRoot } from './shape-resource-lifecycle';
import { createSurfaceMeshJob } from './surface-mesh-job';
import type {PackedChunk} from './surface-mesh-transfer';
import {addPackedNativeMesh} from './native-packed-mesh';
import { updateCustomMeshAppearance } from './mesh-appearance';
import { attachLocalMeshFinish, updateLocalMeshFinish } from './mesh-finish';
import { meshFinishKey } from '../../../results/mesh-appearance';

export const BOHR_TO_ANGSTROM = .529177210903;
/** Included in the host's per-view renderer reserve, beyond active geometry. */
export const ORBITAL_MESH_CACHE_BYTES = 16 * 1024 ** 2;
/** Signed NTO amplitude retains its own scientific identity and no MO energy. */
export type ViewportNtoLayer = Omit<ViewportOrbitalLayer, 'field'> & { kind: 'nto'; field: NtoField };
export interface NtoMeshState extends SurfaceMeshState { fieldId: string | null }
type AmplitudeLayer = ViewportOrbitalLayer | ViewportNtoLayer;
const isNto = (layer: AmplitudeLayer): layer is ViewportNtoLayer => 'kind' in layer && layer.kind === 'nto';
const emptyNtoMesh = (): NtoMeshState => ({ fieldId: null, status: 'empty', attemptKey: null, committedKey: null, shapeCount: 0, vertexCount: 0, triangleCount: 0, colored: false, submitted: false });
export function ntoMeshKey(layer: ViewportNtoLayer, transform: RigidTransform): string {
  return JSON.stringify([layer.kind, layer.field.id, layer.field.context, layer.field.state, layer.field.pairIndex, layer.field.spin, layer.field.side,
    layer.documentId, layer.geometryRevision, layer.sourceToDocument, layer.isovalue, layer.opacity, layer.positiveColor, layer.negativeColor, layer.phase, transform.rotation, transform.translation, meshFinishKey(layer.finish)]);
}

function orbitalPose(layer: AmplitudeLayer, transform: RigidTransform): RigidTransform {
  const { grid, values } = layer.field, dims = grid.dimensions;
  if (grid.coordinateUnit !== 'bohr' || grid.ordering !== 'z-fastest' || dims.length !== 3 || dims.some(value => !Number.isSafeInteger(value) || value < 2) || dims.reduce((a, b) => a * b, 1) !== values.length) throw new Error('轨道网格维度或排列无效。');
  if (![...grid.origin, ...grid.axes.flat()].every(Number.isFinite) || Math.abs(dot(grid.axes[0], cross(grid.axes[1], grid.axes[2]))) < 1e-15 || values.some(value => !Number.isFinite(value))) throw new Error('轨道网格必须是有限、非退化的三维标量格点数据。');
  const pose = layer.sourceToDocument ? composeTransforms(transform, { ...layer.sourceToDocument, anchorIds: [] }) : transform;
  if (![...pose.rotation.flat(), ...pose.translation].every(Number.isFinite)) throw new Error('轨道显示姿态必须是有限刚性变换。');
  return pose;
}

/** Compatibility volume conversion, also used by isolated field/axis checks.
 * Actual orbital display uses source-double scalar intersections below. */
export function orbitalVolumeData(mol: any, layer: AmplitudeLayer, transform: RigidTransform) {
  const pose = orbitalPose(layer, transform), { grid, values } = layer.field, dims = grid.dimensions;
  const origin = transformPoint(pose, grid.origin.map(value => value * BOHR_TO_ANGSTROM) as [number, number, number]);
  const axes = grid.axes.map(axis => rotate(pose.rotation, axis.map(value => value * BOHR_TO_ANGSTROM) as [number, number, number]));
  const volume = new mol.VolumeData('', '');
  volume.size = { x: dims[0], y: dims[1], z: dims[2] };
  volume.data = values;
  volume.matrix = new mol.Matrix4(
    axes[0][0], axes[1][0], axes[2][0], origin[0],
    axes[0][1], axes[1][1], axes[2][1], origin[1],
    axes[0][2], axes[1][2], axes[2][2], origin[2],
    0, 0, 0, 1,
  );
  return volume;
}

/** Same-scene native GLShape custom meshes, never atom models or pick proxies.
 * No camera/zoom/render calls: the owning adapter presents one completed frame. */
export function createOrbitalLayer(viewer: any, mol: any, notify?: () => void) {
  const shapes = createShapeLayer(viewer);
  const preparation = createSurfaceMeshJob(mol.MarchingCube, notify);
  let field: AmplitudeLayer['field'] | null = null, signature = '', geometrySignature = '', finishSignature = '';
  let meshState = emptyNtoMesh();
  let materials: { handle: any; vertices: number; sign: number; color: string; opacity: number }[] = [];
  type PreparedMesh = { field: AmplitudeLayer['field']; values: Float64Array; chunks: PackedChunk[]; bytes:number };
  const recent = new Map<string,PreparedMesh>();
  let cacheOwner = '';
  let idleRelease:ReturnType<typeof setTimeout>|undefined;
  const cancelIdleRelease=()=>{if(idleRelease!==undefined){clearTimeout(idleRelease);idleRelease=undefined;}};
  function remember(key:string, value:PreparedMesh) {
    recent.delete(key);
    if(value.bytes>ORBITAL_MESH_CACHE_BYTES)return;
    recent.set(key,value);
    let bytes=[...recent.values()].reduce((sum,item)=>sum+item.bytes,0);
    while(recent.size>2||bytes>ORBITAL_MESH_CACHE_BYTES){const oldest=recent.keys().next().value!;bytes-=recent.get(oldest)!.bytes;recent.delete(oldest);}
  }
  return {
    pending:preparation.pending,
    bounds:shapes.bounds,
    sync(layer: AmplitudeLayer | null, document: ModelDocument | null, transform: RigidTransform): boolean {
      cancelIdleRelease();
      const owner=document?`${document.id}:${document.revision}`:'';
      if(owner!==cacheOwner){recent.clear();cacheOwner=owner;}
      if (!layer?.visible || !document || layer.documentId !== document.id || layer.geometryRevision !== document.revision) {
        preparation.cancel();
        // A null layer can be a same-turn selection handoff. Give that handoff
        // one short grace period, then release an inactive/closed analysis too.
        if(recent.size){idleRelease=setTimeout(()=>{recent.clear();idleRelease=undefined;},500);(idleRelease as unknown as {unref?:()=>void}).unref?.();}
        const changed = shapes.size > 0; shapes.clear(); materials = []; field = null; signature = geometrySignature = finishSignature = ''; meshState = emptyNtoMesh(); return changed;
      }
      try {
      const nextFinishSignature=meshFinishKey(layer.finish);
      const key = isNto(layer) ? ntoMeshKey(layer, transform) : JSON.stringify([layer.documentId, layer.geometryRevision, layer.sourceToDocument, layer.isovalue, layer.opacity, layer.positiveColor, layer.negativeColor, layer.phase, transform.rotation, transform.translation,nextFinishSignature]);
      if (field === layer.field && signature === key) return false;
      meshState = isNto(layer) ? { ...meshState, fieldId: layer.field.id, status: 'pending', attemptKey: key, committedKey: null, sourceId: layer.field.context.sourceId, sourceRevision: layer.field.context.sourceRevision, shapeId: layer.field.id, submitted: false, error: undefined } : emptyNtoMesh();
      if (!Number.isFinite(layer.isovalue) || layer.isovalue <= 0 || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw new Error('轨道等值面阈值及透明度无效。');
      if (isNto(layer) && (![layer.positiveColor, layer.negativeColor].every(color => /^#[0-9a-f]{6}$/i.test(color)) || layer.phase !== undefined && !['both', 'positive', 'negative'].includes(layer.phase))) throw new Error('NTO相位或配色无效。');
      const geometryKey = JSON.stringify([isNto(layer) ? [layer.kind, layer.field.id, layer.field.context, layer.field.state, layer.field.pairIndex, layer.field.side, layer.field.spin] : [layer.field.sessionId,layer.field.sourceRevision,layer.field.gridKey,layer.field.orbitalKey], layer.documentId, layer.geometryRevision, layer.sourceToDocument, layer.isovalue, layer.phase, transform.rotation, transform.translation]);
      if (field === layer.field && geometrySignature === geometryKey) {
        try {
          for (const entry of materials) {
            const color = entry.sign > 0 ? layer.positiveColor : layer.negativeColor;
            if (entry.opacity !== layer.opacity || entry.color !== color) updateCustomMeshAppearance(entry.handle, entry.vertices, layer.opacity, entry.color === color ? undefined : color);
            if (finishSignature!==nextFinishSignature) updateLocalMeshFinish(entry.handle,layer.finish);
            entry.color = color; entry.opacity = layer.opacity;
          }
          signature = key; finishSignature=nextFinishSignature;
          if (isNto(layer)) meshState = { ...meshState, status: 'committed', committedKey: key };
          return true;
        } catch (error) { shapes.clear(); materials = []; field = null; signature = geometrySignature = finishSignature = ''; throw error; }
      }
      // Validate before replacing the previously valid display. No source
      // mutation, sign-reversed field copy, or vertex-moving smoothing.
      const pose = orbitalPose(layer, transform);
      if (isNto(layer)) validateNtoField(layer.field);
      const removed = shapes.size > 0;
      shapes.clear(); materials = []; field = null; signature = geometrySignature = finishSignature = '';
      try {
        let prepared=recent.get(geometryKey);
        if(prepared&&(prepared.field!==layer.field||prepared.values!==layer.field.values)){recent.delete(geometryKey);prepared=undefined;}
        if(!prepared){
          const { grid, values } = layer.field;
          const chunks = preparation.read(geometryKey, { kind: 'amplitude', shape: { grid, values, ...(isNto(layer) ? {validDomain: layer.field.validDomain} : {}) },
            isovalue: layer.isovalue, phase: layer.phase, pose, factor: BOHR_TO_ANGSTROM });
          if (!chunks) return removed;
          const bytes = chunks.reduce((size,chunk) => size + chunk.vertices.byteLength+chunk.normals.byteLength+chunk.faces.byteLength, values.byteLength);
          prepared={field:layer.field,values:layer.field.values,chunks,bytes};remember(geometryKey,prepared);
        }else{preparation.cancel();recent.delete(geometryKey);recent.set(geometryKey,prepared);}
        let vertexCount = 0, triangleCount = 0;
        for (const chunk of prepared.chunks) {
            const {sign}=chunk;
            const handle = shapes.keep(addPackedNativeMesh(viewer,mol,chunk,{color:sign>0?layer.positiveColor:layer.negativeColor,opacity:layer.opacity,clickable:false,hoverable:false}));
            attachLocalMeshFinish(handle,layer.finish);
            retainNativeShapeRoot(handle);
            const groups = handle?.geo?.geometryGroups;
            if (isNto(layer) && !groups?.length) throw new Error('NTO没有实际提交的渲染几何。');
            for (const group of groups ?? []) { vertexCount += group.vertices; triangleCount += group.faceidx / 3; }
            materials.push({ handle, vertices: chunk.vertices.length/3, sign, color: sign > 0 ? layer.positiveColor : layer.negativeColor, opacity: layer.opacity });
        }
        if (isNto(layer)) {
          if (!(vertexCount > 0 && triangleCount > 0)) throw new Error('当前NTO等值没有可提交的表面三角形。');
          meshState = { ...meshState, status: 'committed', committedKey: key, shapeCount: shapes.size, vertexCount, triangleCount };
        }
      } catch (error) { shapes.clear(); materials = []; throw error; }
      field = layer.field; signature = key; geometrySignature = geometryKey; finishSignature=nextFinishSignature; return true;
      } catch (error) {
        preparation.cancel();
        shapes.clear(); materials = []; field = null; signature = geometrySignature = finishSignature = '';
        if (isNto(layer)) meshState = { ...meshState, fieldId: layer.field.id, status: 'failed', committedKey: null, submitted: false, shapeCount: 0, vertexCount: 0, triangleCount: 0, error: error instanceof Error ? error.message : String(error) };
        else meshState = emptyNtoMesh();
        throw error;
      }
    },
    meshState: (): Readonly<NtoMeshState> => ({ ...meshState }),
    markSubmitted() { if (meshState.status === 'committed') meshState = { ...meshState, submitted: true }; },
    failSubmission(error: unknown) {
      if (meshState.status !== 'committed') return;
      shapes.clear(); materials = []; field = null; signature = geometrySignature = finishSignature = '';
      meshState = { ...meshState, status: 'failed', committedKey: null, submitted: false, shapeCount: 0, vertexCount: 0, triangleCount: 0, error: error instanceof Error ? error.message : String(error) };
    },
    dispose() { preparation.cancel(); cancelIdleRelease(); shapes.clear(); materials = []; recent.clear(); cacheOwner=''; field = null; signature = geometrySignature = finishSignature = ''; meshState = emptyNtoMesh(); },
  };
}
