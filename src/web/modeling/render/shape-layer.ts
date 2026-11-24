import { registerOwnedShape, retireOwnedShape, withOwnedShapeRetirementBatch } from './shape-resource-lifecycle';
import {includeRenderPoint,type RenderBounds} from './depth-envelope';

/** Shape handles belong to one presentation layer, not to the whole viewer.
 * Clearing atom annotations must leave independent scientific surfaces intact. */
export function createShapeLayer(viewer: { removeShape(shape: any): unknown }) {
  const handles = new Set<any>();
  let bounds:RenderBounds|null=null;
  const includeBounds=(shape:any)=>{
    const sphere=shape.boundingSphere;
    if(sphere?.center&&Number.isFinite(sphere.radius)&&sphere.radius>0&&[sphere.center.x,sphere.center.y,sphere.center.z].every(Number.isFinite))
      bounds=includeRenderPoint(bounds,[sphere.center.x,sphere.center.y,sphere.center.z],sphere.radius);
    else for(const group of shape.geo?.geometryGroups??[]){
      const vertices=group.vertexArray,count=Math.min(group.vertices??0,Math.floor((vertices?.length??0)/3));
      for (let offset = 0; offset < count * 3; offset += 3) {
        const x = vertices[offset], y = vertices[offset + 1], z = vertices[offset + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (!bounds) bounds = { min: [x, y, z], max: [x, y, z] };
        else {
          bounds.min[0] = Math.min(bounds.min[0], x); bounds.max[0] = Math.max(bounds.max[0], x);
          bounds.min[1] = Math.min(bounds.min[1], y); bounds.max[1] = Math.max(bounds.max[1], y);
          bounds.min[2] = Math.min(bounds.min[2], z); bounds.max[2] = Math.max(bounds.max[2], z);
        }
      }
    }
  };
  return {
    keep<T>(shape: T): T { if (shape != null) {
      registerOwnedShape(viewer, shape); handles.add(shape);
      // Custom nonpickable meshes have no native bounding sphere; use their
      // actual submitted vertices on keep and on sequence reconciliation.
      includeBounds(shape);
    } return shape; },
    has:(shape:any)=>handles.has(shape),
    handles:()=>handles.values(),
    refreshBounds(){bounds=null;for(const shape of handles)includeBounds(shape);},
    remove(shapes:Iterable<any>){withOwnedShapeRetirementBatch(viewer,()=>{for(const shape of shapes)if(handles.delete(shape))retireOwnedShape(viewer,shape,()=>viewer.removeShape(shape));});},
    clear() {
      bounds=null;
      if (!handles.size) return;
      withOwnedShapeRetirementBatch(viewer, () => {
        let failure: unknown;
        for(const shape of handles){handles.delete(shape);try { retireOwnedShape(viewer, shape, () => viewer.removeShape(shape)); } catch (error) { failure ??= error; }}
        if (failure) throw failure;
      });
    },
    get size() { return handles.size; },
    bounds:()=>bounds,
  };
}
