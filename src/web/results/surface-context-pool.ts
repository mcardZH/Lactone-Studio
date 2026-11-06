import type { SurfaceContext } from '../../results/surface-contracts';
import { createSurfaceDesktopBridge, type SurfaceDesktopBridgeOptions, type SurfaceDesktopController } from './surface-desktop-bridge';

/** Scientific identity excludes the actual capture/activation epoch. */
export const surfaceScientificContextKey = (context: SurfaceContext) => JSON.stringify([context.sourceId, context.sourceRevision,
  context.jobIndex, context.sourceFrameIndex, context.generation, context.documentId, context.documentRevision]);
export const surfaceSourceLifetimeKey = (analysisId: string, context: SurfaceContext) => JSON.stringify([analysisId,
  context.sourceId, context.sourceRevision, context.generation]);

/** Holds real session/artifact owners, not scalar buffers. Browsing away only
 * deactivates a context; the source owner closes the entire pool on disposal. */
export function createSurfaceContextPool() {
  const contexts = new Map<string, SurfaceDesktopController>();
  let sourceKey: string | undefined, serial = 0, disposed = false, disposal: Promise<void> | undefined;
  return {
    async activate(options: SurfaceDesktopBridgeOptions): Promise<SurfaceDesktopController | null> {
      if (disposed) throw new DOMException('表面来源已关闭。', 'AbortError');
      const source = surfaceSourceLifetimeKey(options.analysisId, options.context), key = surfaceScientificContextKey(options.context);
      if (sourceKey !== undefined && sourceKey !== source) throw new Error('表面来源已改变，需要新的来源生命周期。');
      sourceKey = source;
      let controller = contexts.get(key);
      if (!controller) { controller = createSurfaceDesktopBridge({ ...options, active: false }); contexts.set(key, controller); }
      const ownSerial = ++serial;
      await Promise.all([...contexts.values()].filter(value => value !== controller).map(value => value.setActive(false)));
      if (disposed || serial !== ownSerial) return null;
      await controller.setActive(options.active);
      return !disposed && serial === ownSerial ? controller : null;
    },
    get(context: SurfaceContext): SurfaceDesktopController | undefined { return disposed ? undefined : contexts.get(surfaceScientificContextKey(context)); },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; serial++;
      disposal = (async () => {
        const results = await Promise.allSettled([...contexts.values()].map(value => value.dispose())); contexts.clear();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, '部分分子表面来源未确认释放。');
      })(); return disposal;
    },
  };
}
export type SurfaceContextPool = ReturnType<typeof createSurfaceContextPool>;
