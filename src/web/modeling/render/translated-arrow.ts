/** Locked native arrows keep their full mesh, normals and material when only
 * their origin moves. No geometry edits, tessellation changes or style rebuilds.
 * The adapter owns the shape and its lifetime through the ordinary scene layer.
 */
const translations = new WeakMap<object, { origin: number[]; center: number[]; root: any; globj: (group: any) => void }>();
export function translateNativeArrow(handle: any, previous: any, next: any): boolean {
  if (!handle?.renderedShapeObj?.position || !handle.boundingSphere?.center || typeof handle.globj !== 'function') return false;
  const keys=Object.keys(previous);
  if (keys.length!==Object.keys(next).length || keys.some(key=>key!=='start'&&key!=='end'&&!Object.is(previous[key],next[key]))) return false;
  const axes=['x','y','z'] as const;
  if (!axes.every(axis=>Number.isFinite(previous.start?.[axis])&&Number.isFinite(next.start?.[axis])&&Number.isFinite(previous.end?.[axis])&&Number.isFinite(next.end?.[axis]))) return false;
  // Coordinates are IEEE numbers; subtraction can differ by the last bit after
  // adding a common translation. Bound this at rounding noise, never a physical
  // direction/length change. Mode/appearance changes rebuild outside this path.
  if (!axes.every(axis=>Math.abs((previous.end[axis]-previous.start[axis])-(next.end[axis]-next.start[axis]))<=Number.EPSILON*16*Math.max(1,Math.abs(previous.end[axis]),Math.abs(next.end[axis])))) return false;
  let state=translations.get(handle);
  if (!state) {
    const root=handle.renderedShapeObj,globj=handle.globj;
    state={origin:axes.map(axis=>previous.start[axis]),center:axes.map(axis=>handle.boundingSphere.center[axis]),root,globj};
    translations.set(handle,state);
    handle.globj=function(group:any){
      // A foreign/native invalidation is allowed to rebuild rather than reuse a
      // detached node. Normal draw leaves this already attached tree untouched.
      if(this.renderedShapeObj!==root){globj.call(this,group);return;}
      if(root.parent!==group&&!(group.children??[]).includes(root))group.add(root);
    };
  }
  if (handle.renderedShapeObj!==state.root) return false;
  axes.forEach((axis,index)=>{
    const offset=next.start[axis]-state!.origin[index];
    state!.root.position[axis]=offset;
    handle.boundingSphere.center[axis]=state!.center[index]+offset;
  });
  return true;
}
