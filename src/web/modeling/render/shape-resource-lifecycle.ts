/** Compatibility ownership for locked 3Dmol 2.5.5 owned presentation children.
 * GLShape/GLModel removegl remove roots, not their children's resources;
 * Renderer.unrollBufferMaterial also replaces depth/shaded clones each render.
 * Only explicitly registered shapes and this adapter's atom model participate.
 * Other scene resources only protect sharing; they are never adopted.
 */
const owners = new WeakMap<object, ShapeResourceOwner>();
const holders = new WeakMap<object, Set<ShapeResourceOwner>>();
const materialSlots = ['opaque', 'transparent', 'volumetric', 'opaqueDepth', 'transparentDepth', 'opaqueShaded'];
type ResourceRecord = { kind: 'geometry' | 'material'; renderer: any; context: any; generation: any; disposed: boolean; listener: () => void };
type ShapeResourceOwner = { keep(shape: any): void; retire(shape: any, remove: () => unknown): void; batchRetire(remove: () => void): void };

function visit(root: any, accept: (node: any) => void, seen = new Set<any>()) {
  if (!root || seen.has(root)) return;
  seen.add(root); accept(root);
  for (const child of root.children ?? []) visit(child, accept, seen);
}
function contextOf(renderer: any) { return renderer?.getContext?.() ?? renderer?._gl; }
function generationOf(resource: any, kind: 'geometry' | 'material') {
  if (kind === 'material') return resource.program;
  // Locked deallocateGeometry clears __webglInit but leaves stale group handle
  // properties behind. Those properties are not a live/new generation.
  if (resource.__webglInit !== true) return undefined;
  return resource.geometryGroups?.find((group: any) => group.__webglVertexBuffer)?.__webglVertexBuffer ?? resource.__webglInit;
}
function supplementalGeometryBuffers(geometry:any) {
  const targets=[geometry,...(geometry.geometryGroups??[])],native=new Set<any>();
  for(const target of targets)for(const key of ['__webglVertexBuffer','__webglNormalBuffer','__webglColorBuffer','__webglFaceBuffer','__webglLineBuffer'])if(target[key]!==undefined)native.add(target[key]);
  return targets.flatMap(target=>['__webglRadiusBuffer','__webglOffsetBuffer'].flatMap(key=>target[key]==null?[]:[{target,key,handle:target[key],nativeAlias:native.has(target[key])}]));
}
function restore(target: any, key: string, wrapper: any, descriptor: PropertyDescriptor | undefined) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
}

export function registerOwnedShape(viewer: object, shape: any) { owners.get(viewer)?.keep(shape); }
export function retireOwnedShape(viewer: object, shape: any, remove: () => unknown) {
  const owner = owners.get(viewer);
  if (owner) owner.retire(shape, remove); else remove();
}
/** One owner snapshot/flush for a whole layer, while native removals and
 * reference counts still retire independently (including failed removals). */
export function withOwnedShapeRetirementBatch(viewer: object, remove: () => void) {
  const owner = owners.get(viewer);
  if (owner) owner.batchRetire(remove); else remove();
}

export function retainViewerShapeResources(viewer: any) {
  if (owners.has(viewer)) throw new Error('Shape resource owner already installed.');
  const shapes = new Map<any, number>(), models = new Set<any>(), resources = new Map<any, ResourceRecord>();
  const knownNodes = new WeakSet<object>(), renderers = new Map<any, () => void>(), scenes = new Map<any, any>();
  let closed = false, renderDepth = 0, retirementDepth = 0;
  const owner: ShapeResourceOwner = { keep, retire, batchRetire };
  owners.set(viewer, owner);

  function track(resource: any, kind: 'geometry' | 'material', renderer: any) {
    if (!resource || typeof resource.dispose !== 'function') return;
    const previous = resources.get(resource);
    if (previous) {
      // A native disposal can precede a legitimate later initialization. Do
      // not treat an object identity as permanently disposed across generations.
      const generation = generationOf(resource, kind);
      if (generation !== undefined && (previous.disposed || generation !== previous.generation)) {
        previous.disposed = false; previous.generation = generation; previous.renderer = renderer; previous.context = contextOf(renderer);
      }
      return;
    }
    const record: ResourceRecord = { kind, renderer, context: contextOf(renderer), generation: generationOf(resource, kind), disposed: false, listener: () => { record.disposed = true; } };
    resource.addEventListener?.('dispose', record.listener);
    resources.set(resource, record);
    let set = holders.get(resource); if (!set) holders.set(resource, set = new Set()); set.add(owner);
  }
  function collectShape(shape: any, renderer: any) {
    track(shape.geo, 'geometry', renderer); track(shape.linegeo, 'geometry', renderer);
    for (const root of [shape.shapeObj, shape.renderedShapeObj]) visit(root, node => {
      knownNodes.add(node); track(node.geometry, 'geometry', renderer); track(node.material, 'material', renderer);
    });
  }
  function collectModel(model: any, renderer: any) {
    for (const root of [model.molObj,model.renderedMolObj]) visit(root,node=>{
      knownNodes.add(node);track(node.geometry,'geometry',renderer);track(node.material,'material',renderer);
    });
  }
  function collect(renderer: any, scene?: any) {
    for (const shape of shapes.keys()) collectShape(shape, renderer);
    for (const model of models) collectModel(model,renderer);
    if (scene) scenes.set(renderer, scene);
    const current = scenes.get(renderer);
    if (current) {
      const nodes = new Set<any>();
      for (const node of current.__objects ?? []) visit(node, item => nodes.add(item));
      for (const entry of current.__webglObjects ?? []) {
        // Removed entries can linger until initWebGLObjects drains its queue.
        // Their resources were already captured while live; do not re-adopt a
        // resource after our retirement/native disposal from a stale entry.
        if (!entry.object || !nodes.has(entry.object) || !knownNodes.has(entry.object)) continue;
        track(entry.object.geometry, 'geometry', renderer); track(entry.object.material, 'material', renderer);
        for (const slot of materialSlots) track(entry[slot], 'material', renderer);
      }
    }
  }
  function flush(final = false) {
    if (renderDepth || retirementDepth) return;
    const live = new Set<any>(), foreign = new Set<any>();
    const protect = (node: any) => {
      const target = knownNodes.has(node) ? live : foreign;
      if (node.geometry) target.add(node.geometry); if (node.material) target.add(node.material);
    };
    if (!final) for (const shape of shapes.keys()) {
      // Hidden/frame-filtered owned shapes retain their geometry for reappear.
      live.add(shape.geo); live.add(shape.linegeo);
      for (const root of [shape.shapeObj, shape.renderedShapeObj]) visit(root, protect);
    }
    if (!final) for (const model of models) for (const root of [model.molObj,model.renderedMolObj]) visit(root,protect);
    const currentScene = scenes.get(viewer.getRenderer?.());
    if (currentScene) {
      const scene = currentScene;
      const nodes = new Set<any>();
      // __objectsRemoved is deliberately excluded: those nodes are no longer
      // live but can remain in the renderer's removal queue until next frame.
      for (const node of scene.__objects ?? []) visit(node, item => nodes.add(item));
      for (const node of nodes) if (!final || !knownNodes.has(node)) protect(node);
      for (const entry of scene.__webglObjects ?? []) if (nodes.has(entry.object) && (!final || !knownNodes.has(entry.object))) {
        const target = knownNodes.has(entry.object) ? live : foreign;
        for (const slot of materialSlots) if (entry[slot]) target.add(entry[slot]);
      }
    }
    let failure: unknown;
    const resetAttributes = new Set<any>();
    for (const [resource, record] of resources) {
      if (live.has(resource) && !foreign.has(resource)) continue;
      const set = holders.get(resource); set?.delete(owner);
      // A foreign/model reference transfers cleanup back to its native owner.
      // The last explicit shape owner alone may dispose shared owned resources.
      const gl = contextOf(record.renderer);
      try {
        if (!foreign.has(resource) && !set?.size && gl === record.context && !gl?.isContextLost?.()) {
          // Locked deallocateGeometry omits these two instance/imposter VBOs.
          // Snapshot only on retirement, including after an external native
          // geometry.dispose (which leaves their properties intact).
          const supplemental = record.kind==='geometry' ? supplementalGeometryBuffers(resource) : [];
          if (record.kind === 'geometry' && (resource.__webglInit === true || supplemental.length>0) && !resetAttributes.has(record.renderer) && typeof record.renderer?.disableAttributes === 'function') {
            // Locked deletion leaves enabled vertex attributes referencing its
            // retired buffers. The fullscreen pass only rebinds position and
            // can then fail with INVALID_OPERATION. Use the renderer's own
            // reset to keep _enabledAttributes consistent with GL, and force
            // any subsequent live geometry (including a shared/model one) to
            // rebind. This changes bindings, never live buffers or materials.
            record.renderer.disableAttributes();
            record.renderer._currentGeometryGroupHash = -1;
            resetAttributes.add(record.renderer);
          }
          try { if (!record.disposed) resource.dispose(); }
          finally {
            // Native handles the ordinary VBOs and shared program leases. Only
            // its confirmed radius/offset omissions are explicitly completed;
            // no buffer deletion against another/lost context or live owner.
            const released=new Set<any>();
            for(const {target,key,handle,nativeAlias} of supplemental){
              if(!nativeAlias&&!released.has(handle)){gl.deleteBuffer(handle);released.add(handle);}
              if(target[key]===handle)target[key]=undefined;
            }
          }
        }
      } catch (error) { failure ??= error; }
      finally { resource.removeEventListener?.('dispose', record.listener); resources.delete(resource); }
    }
    if (failure) throw failure;
  }
  function install(renderer: any) {
    if (!renderer || renderers.has(renderer) || typeof renderer.render !== 'function') return;
    const original = renderer.render, descriptor = Object.getOwnPropertyDescriptor(renderer, 'render');
    const render = function(this: any, ...args: any[]) {
      if (this !== renderer) return original.apply(this, args);
      collect(renderer, args[0]); renderDepth++;
      let failed = false;
      try { return original.apply(this, args); }
      catch (error) { failed = true; throw error; }
      finally {
        // Locked Renderer calls unroll once/entry and assigns each clone slot
        // once. Before/after also captures assignments made before an exception;
        // no private unroll hook or global renderer prototype patch is needed.
        let cleanupError: unknown;
        try { collect(renderer, args[0]); } catch (error) { cleanupError = error; } finally { renderDepth--; }
        try { flush(); } catch (error) { cleanupError ??= error; }
        if (!failed && cleanupError) throw cleanupError;
      }
    };
    renderer.render = render;
    renderers.set(renderer, () => restore(renderer, 'render', render, descriptor));
  }
  function keep(shape: any) {
    if (closed) throw new Error('Shape resource owner closed.');
    const renderer = viewer.getRenderer?.();
    install(renderer); shapes.set(shape, (shapes.get(shape) ?? 0) + 1); collectShape(shape, renderer);
  }
  function keepModel<T>(model: T): T {
    if(closed)throw new Error('Shape resource owner closed.');
    if(model!=null){const renderer=viewer.getRenderer?.();install(renderer);models.add(model);collectModel(model,renderer);}
    return model;
  }
  function retireModel(model:any,remove:()=>unknown) {
    batchRetire(()=>{try{remove();}finally{models.delete(model);}});
  }
  function retire(shape: any, remove: () => unknown) {
    batchRetire(() => {
      try { remove(); }
      finally {
        const count = shapes.get(shape) ?? 0;
        if (count > 1) shapes.set(shape, count - 1); else shapes.delete(shape);
      }
    });
  }
  function batchRetire(remove: () => void) {
    const outermost = retirementDepth === 0;
    let failure: unknown;
    if (outermost) try { collect(viewer.getRenderer?.()); } catch (error) { failure = error; }
    retirementDepth++;
    try { remove(); } catch (error) { failure ??= error; }
    finally {
      retirementDepth--;
      if (outermost) try { flush(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  const originalResize = viewer.resize, resizeDescriptor = Object.getOwnPropertyDescriptor(viewer, 'resize');
  const resize = function(this: any, ...args: any[]) {
    install(viewer.getRenderer?.());
    try { return originalResize.apply(this, args); } finally { install(viewer.getRenderer?.()); }
  };
  install(viewer.getRenderer?.());
  if (typeof originalResize === 'function') viewer.resize = resize;
  return { keepModel,retireModel,stats:()=>({shapes:shapes.size,models:models.size,resources:resources.size}),dispose() {
    if (closed) return; closed = true;
    let failure: unknown;
    try {
      try { collect(viewer.getRenderer?.()); } catch (error) { failure = error; }
      shapes.clear(); models.clear(); try { flush(true); } catch (error) { failure ??= error; }
    }
    finally {
      owners.delete(viewer); scenes.clear();
      for (const release of renderers.values()) release(); renderers.clear();
      restore(viewer, 'resize', resize, resizeDescriptor);
    }
    if (failure) throw failure;
  } };
}
