/** Opt-in observation only. A completed GPU command stream is a renderer proxy,
 * never proof of compositor presentation or physical monitor scan-out. */
export interface ViewportRenderIdentity {
  sourceId: string; sourceRevision: string; frameIndex: number;
  jobIndex?: number | null; generation?: number; requestId?: string;
}
export type ViewportRenderReason = 'draw' | 'camera-pan' | 'camera-rotate' | 'zoom' | 'set-view' | 'step' | 'orient' | 'resize' | 'orbital-layer' | 'nto-layer' | 'surface-layer' | 'surface-layers' | 'surface-extrema' | 'reset-view';
export interface ViewportRenderSubmission {
  renderReason: ViewportRenderReason;
  /** Actual renderer.render invocations, not pointer/RAF/API call counts. */
  rendererSubmissions: number;
  renderViewport?: { cssWidth: number; cssHeight: number; bufferWidth: number; bufferHeight: number; contextKind: 'webgl2' | 'webgl1' | 'unknown' };
}
export interface ViewportRenderCompletion {
  identity: ViewportRenderIdentity; documentId: string; geometryRevision: number; sequence: number;
  drawStartedAt: number; submittedAt: number; completedAt: number | null;
  status: 'completed' | 'unavailable'; method: 'webgl2-fence' | 'webgl-finish' | 'unavailable';
  /** DOM label layout and compositor presentation are outside this observation. */
  scope: 'molecular-renderer'; reason?: string;
  /** Missing means legacy full draw. Other reasons are presentation work and
   * must not be counted as additional prepared scientific-frame completions. */
  renderReason?: ViewportRenderReason;
  rendererSubmissions?: number;
  renderViewport?: ViewportRenderSubmission['renderViewport'];
}
export type ViewportRenderObserver = (event: ViewportRenderCompletion) => void;

export function createRenderCompletionObserver(getCanvas: () => HTMLCanvasElement | null | undefined, realm: Pick<Window, 'setTimeout' | 'clearTimeout' | 'performance'>,
  getActualContext?: () => WebGLRenderingContext | WebGL2RenderingContext | null | undefined) {
  type Result = Pick<ViewportRenderCompletion, 'status' | 'method' | 'reason'>;
  type Pending = { poll(): Result | null; release(): void; publish(result: Result): void };
  let disposed = false, sequence = 0, draining = false, timer: number | undefined;
  const pending: Pending[] = [];
  const now = () => realm.performance?.now?.() ?? globalThis.performance.now();
  const schedule = (callback: () => void) => (realm.setTimeout ? realm.setTimeout(callback, 0) : globalThis.setTimeout(callback, 0)) as unknown as number;
  const cancel = (timer: number) => { if (realm.clearTimeout) realm.clearTimeout(timer); else globalThis.clearTimeout(timer); };
  const clearTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const cancelPending = () => { clearTimer(); for (const lease of pending.splice(0)) { try { lease.release(); } catch { /* Diagnostic cleanup cannot interrupt product disposal. */ } } };
  const drain = () => {
    if (disposed || draining) return;
    draining = true;
    try {
      while (!disposed && pending.length) {
        const head = pending[0];
        const result = head.poll();
        if (!result) {
          if (timer === undefined) timer = schedule(() => { timer = undefined; drain(); });
          return;
        }
        pending.shift();
        try { head.release(); }
        catch (error) { head.publish({ status: 'unavailable', method: result.method, reason: String(error) }); continue; }
        head.publish(result);
      }
      if (!pending.length) clearTimer();
    } finally { draining = false; }
  };
  return {
    now,
    observe(identity: ViewportRenderIdentity, documentId: string, geometryRevision: number, drawStartedAt: number, observer: ViewportRenderObserver, submission?: ViewportRenderSubmission) {
      if (disposed) return;
      const base = { identity: { ...identity }, documentId, geometryRevision, sequence: ++sequence, drawStartedAt, submittedAt: now(), scope: 'molecular-renderer' as const,
        ...(submission ? { ...submission, ...(submission.renderViewport ? {renderViewport:{...submission.renderViewport}} : {}) } : {}) };
      const publish = (result: Result) => {
        if (disposed) return;
        // A diagnostic consumer is not allowed to fail the product draw path.
        try { observer({ ...base, ...result, completedAt: result.status === 'completed' ? now() : null }); } catch { /* Observer owns its reporting. */ }
      };
      const ready = (result: Result) => { pending.push({ poll: () => result, release() {}, publish }); drain(); };
      let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
      try {
        // 3Dmol can render through OffscreenCanvas while its public front canvas
        // owns only a bitmaprenderer context. Observe the renderer's public GL
        // context; never interpret the bitmap canvas as the rendering context.
        gl = getActualContext?.() ?? null;
        if (!gl) {
          const canvas = getCanvas();
          gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null
            ?? canvas?.getContext('webgl') as WebGLRenderingContext | null
            ?? canvas?.getContext('experimental-webgl') as WebGLRenderingContext | null;
        }
        if (!gl || gl.isContextLost?.()) { ready({ status: 'unavailable', method: 'unavailable', reason: 'WebGL context unavailable' }); return; }
        const webgl2 = gl as WebGL2RenderingContext;
        if (typeof webgl2.fenceSync !== 'function' || typeof webgl2.clientWaitSync !== 'function') {
          if (typeof gl.finish !== 'function') { ready({ status: 'unavailable', method: 'unavailable', reason: 'No GPU completion primitive' }); return; }
          // WebGL1 fallback is intentionally synchronous and only occurs when
          // the caller explicitly enables observation. Its cost is measurable.
          gl.finish();
          ready(gl.isContextLost?.() ? { status: 'unavailable', method: 'webgl-finish', reason: 'WebGL context lost' }
            : { status: 'completed', method: 'webgl-finish' });
          return;
        }
        const sync = webgl2.fenceSync(webgl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) { ready({ status: 'unavailable', method: 'webgl2-fence', reason: 'GPU fence allocation failed' }); return; }
        let released = false, submissionFailed = false, submissionError: unknown;
        const lease: Pending = { release() {
          if (released) return; released = true;
          if (!webgl2.isContextLost?.()) webgl2.deleteSync(sync);
        }, publish, poll() {
          try {
            if (submissionFailed) return { status: 'unavailable', method: 'webgl2-fence', reason: String(submissionError) };
            if (webgl2.isContextLost?.()) return { status: 'unavailable', method: 'webgl2-fence', reason: 'WebGL context lost' };
            const result = webgl2.clientWaitSync(sync, 0, 0);
            if (result === webgl2.ALREADY_SIGNALED || result === webgl2.CONDITION_SATISFIED) {
              return { status: 'completed', method: 'webgl2-fence' };
            } else if (result === webgl2.WAIT_FAILED || now() - base.submittedAt > 2000) {
              return { status: 'unavailable', method: 'webgl2-fence', reason: result === webgl2.WAIT_FAILED ? 'GPU fence wait failed' : 'GPU completion observation timed out' };
            }
            return null;
          } catch (error) { return { status: 'unavailable', method: 'webgl2-fence', reason: String(error) }; }
        } };
        pending.push(lease);
        try { webgl2.flush(); } catch (error) { submissionFailed = true; submissionError = error; }
        // Only the oldest fence is sampled. A new draw may drive this queue,
        // but cannot observe/publish its own completion ahead of an older one.
        drain();
      } catch (error) { ready({ status: 'unavailable', method: 'unavailable', reason: String(error) }); }
    },
    cancelPending,
    dispose() { if (disposed) return; disposed = true; cancelPending(); },
  };
}

export interface ViewportRenderTarget { identity: ViewportRenderIdentity; documentId: string; geometryRevision: number; observer: ViewportRenderObserver }
/** Optional per-viewer tap. Only actual successful renderer invocations inside
 * an adapter operation count; empty APIs never insert a fence. Nested actions
 * in a complete draw are folded into its one original identity completion.
 * No hook, clocks, counters or completion queue while observation is disabled.
 */
export function createRendererSubmissionObserver(viewer: any, completion: ReturnType<typeof createRenderCompletionObserver>,
  viewport?: () => ViewportRenderSubmission['renderViewport']) {
  let target: ViewportRenderTarget | null = null, disposed = false, depth = 0, submissions = 0;
  const hooks = new Map<any, () => void>();
  const unhook = () => { for(const release of hooks.values()){try{release();}catch{/* Diagnostics cannot interrupt disposal. */}}hooks.clear(); };
  function ensure() {
    if (!target || disposed) return;
    const renderer=viewer.getRenderer?.();
    if(!renderer||hooks.has(renderer)||typeof renderer.render!=='function')return;
    const original=renderer.render,descriptor=Object.getOwnPropertyDescriptor(renderer,'render');
    const render=function(this:any,...args:any[]) {
      const value=original.apply(this,args);
      if(this===renderer&&target&&depth>0){try{if(!renderer.getContext?.()?.isContextLost?.())submissions++;}catch{/* No reliable submission evidence. */}}
      return value;
    };
    renderer.render=render;
    hooks.set(renderer,()=>{if(renderer.render!==render)return;if(descriptor)Object.defineProperty(renderer,'render',descriptor);else delete renderer.render;});
  }
  return {
    configure(next: ViewportRenderTarget | null) {
      if(disposed)return;
      target=next?{...next,identity:{...next.identity}}:null;
      if(target){try{ensure();}catch{/* An unavailable hook is not a product failure. */}}else{unhook();completion.cancelPending();}
    },
    run<T>(reason: ViewportRenderReason, action: () => T): T {
      if(!target||disposed)return action();
      if(depth>0)return action();
      try{ensure();}catch{/* No event without a captured renderer call. */}
      const captured=target,started=completion.now();submissions=0;depth++;
      let failed=false;
      try{return action();}catch(error){failed=true;throw error;}
      finally {
        depth--;
        // Context recovery can replace the renderer in a native resize. Hook
        // its next operation; never invent an observation for an unseen call.
        try{ensure();}catch{/* Observe the next available renderer only. */}
        if(!failed&&target===captured&&submissions>0){
          let renderViewport: ViewportRenderSubmission['renderViewport'];
          try{renderViewport=viewport?.();}catch{/* Missing size metadata must not fail the draw. */}
          try{completion.observe(captured.identity,captured.documentId,captured.geometryRevision,started,captured.observer,
            {renderReason:reason,rendererSubmissions:submissions,...(renderViewport?{renderViewport}: {})});}catch{/* Diagnostic-only consumer. */}
        }
      }
    },
    dispose(){if(disposed)return;disposed=true;target=null;unhook();},
  };
}
