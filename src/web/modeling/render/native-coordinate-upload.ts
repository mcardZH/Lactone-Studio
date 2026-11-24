type NativeBufferGroup = {
  vertexArray: Float32Array;
  normalArray?: Float32Array;
  __webglVertexBuffer?: WebGLBuffer;
  __webglOffsetBuffer?: WebGLBuffer;
  __webglNormalBuffer?: WebGLBuffer;
};

type NativeGeometry = {
  verticesNeedUpdate?: boolean;
  elementsNeedUpdate?: boolean;
  colorsNeedUpdate?: boolean;
  normalsNeedUpdate?: boolean;
};

type NativeRenderer = {
  getContext(): WebGLRenderingContext | WebGL2RenderingContext;
  setBuffers(group: NativeBufferGroup, hint: number): unknown;
};

export type NativeCoordinateRange = { start: number; end: number };

type CoordinateUpload = {
  geometry: NativeGeometry;
  vertices: Float32Array;
  vertexBuffer: WebGLBuffer;
  normals?: Float32Array;
  normalBuffer?: WebGLBuffer;
  range?: NativeCoordinateRange;
};

/** Locked 3Dmol 2.5.5 routes all four geometry dirty flags through setBuffers.
 * Scope its shortcut to the already resident arrays that the coordinate binder
 * just updated and leave every other mesh on the renderer's own upload path. */
export function retainNativeCoordinateUpload(renderer: NativeRenderer | null | undefined) {
  const original = renderer?.setBuffers;
  const context = renderer?.getContext?.();
  let updates = 0, bytes = 0;
  const statistics = () => ({ coordinateGpuUpdates: updates, coordinateGpuBytes: bytes });
  if (!renderer || !context || typeof original !== 'function' || typeof context.bufferSubData !== 'function') {
    return { mark() { return false; }, statistics, dispose() {} };
  }

  const prior = Object.getOwnPropertyDescriptor(renderer, 'setBuffers');
  const pending = new WeakMap<NativeBufferGroup, CoordinateUpload>();
  let active = true;
  const staticDirty = (geometry: NativeGeometry) => geometry.elementsNeedUpdate || geometry.colorsNeedUpdate || geometry.normalsNeedUpdate;
  const vertexHandle = (group: NativeBufferGroup) => group.__webglOffsetBuffer ?? group.__webglVertexBuffer;

  function upload(this: NativeRenderer, group: NativeBufferGroup, hint: number) {
    const change = pending.get(group);
    if (!change) return original!.call(this, group, hint);
    pending.delete(group);
    const { geometry, vertices, vertexBuffer, normals, normalBuffer, range } = change;
    if (!active || this !== renderer || this.getContext() !== context || context!.isContextLost?.()
      || staticDirty(geometry) || !geometry.verticesNeedUpdate || group.vertexArray !== vertices || vertexHandle(group) !== vertexBuffer
      || normals && (group.normalArray !== normals || group.__webglNormalBuffer !== normalBuffer)) {
      return original!.call(this, group, hint);
    }
    if (range && range.start === range.end) return;
    const offset = (range?.start ?? 0) * Float32Array.BYTES_PER_ELEMENT;
    const vertexData = range ? vertices.subarray(range.start, range.end) : vertices;
    const normalData = normals && range ? normals.subarray(range.start, range.end) : normals;
    context!.bindBuffer(context!.ARRAY_BUFFER, vertexBuffer);
    context!.bufferSubData(context!.ARRAY_BUFFER, offset, vertexData);
    if (normalData && normalBuffer) {
      context!.bindBuffer(context!.ARRAY_BUFFER, normalBuffer);
      context!.bufferSubData(context!.ARRAY_BUFFER, offset, normalData);
    }
    updates++;
    bytes += vertexData.byteLength + (normalData?.byteLength ?? 0);
  }

  try {
    Object.defineProperty(renderer, 'setBuffers', { value: upload, configurable: true, writable: true });
  } catch {
    return { mark() { return false; }, statistics, dispose() {} };
  }

  return {
    mark(geometry: NativeGeometry, group: NativeBufferGroup, updateNormals: boolean, range?: NativeCoordinateRange) {
      if (!active || geometry.verticesNeedUpdate || staticDirty(geometry)) return false;
      const vertexBuffer = vertexHandle(group), normalBuffer = updateNormals ? group.__webglNormalBuffer : undefined;
      if (!vertexBuffer || updateNormals && (!normalBuffer || !group.normalArray)) return false;
      pending.set(group, { geometry, vertices: group.vertexArray, vertexBuffer, normals: updateNormals ? group.normalArray : undefined, normalBuffer, range });
      return true;
    },
    statistics,
    dispose() {
      active = false;
      if (renderer.setBuffers !== upload) return;
      if (prior) Object.defineProperty(renderer, 'setBuffers', prior);
      else Reflect.deleteProperty(renderer, 'setBuffers');
    },
  };
}
