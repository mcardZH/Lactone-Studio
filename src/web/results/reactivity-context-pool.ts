import type { SurfaceContext } from '../../results/surface-contracts';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import { createReactivityDesktopBridge, type ReactivityDesktopBridgeOptions } from './reactivity-desktop-bridge';
import { reactivityContextKey } from './reactivity-presentation';

export type ReactivityDesktopController = ReturnType<typeof createReactivityDesktopBridge>;
/** Keeps one independent native/field owner per scientific frame. Activation
 * and cache restoration do not request FMO integration or orbital generation. */
export function createReactivityContextPool(factory = createReactivityDesktopBridge) {
  const entries = new Map<string, { controller: ReactivityDesktopController; progress: MultiwfnProgressSnapshot | null; unsubscribe(): void }>();
  const listeners = new Set<() => void>();
  let lifetime: string | undefined, serial = 0, disposed = false, disposal: Promise<void> | undefined;
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    progress(context: SurfaceContext) { return entries.get(reactivityContextKey(context))?.progress ?? null; },
    async activate(options: ReactivityDesktopBridgeOptions): Promise<ReactivityDesktopController | null> {
      if (disposed) throw new DOMException('反应性来源已关闭。', 'AbortError');
      const source = JSON.stringify([options.analysisId, options.context.sourceId, options.context.sourceRevision, options.context.generation]);
      if (lifetime !== undefined && source !== lifetime) throw Error('反应性来源已变化，需要新的来源生命周期。');
      lifetime = source;
      const key = reactivityContextKey(options.context);
      let entry = entries.get(key);
      if (!entry) {
        const controller = factory({ ...options, active: false });
        entry = { controller, progress: null, unsubscribe() {} };
        const own = entry;
        own.unsubscribe = controller.onProgress(value => { if (disposed) return; own.progress = value; listeners.forEach(listener => listener()); });
        entries.set(key, own);
      }
      const token = ++serial;
      await Promise.all([...entries.values()].filter(value => value !== entry).map(value => value.controller.setActive(false)));
      if (disposed || token !== serial) return null;
      await entry.controller.setActive(options.active);
      return disposed || token !== serial ? null : entry.controller;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; serial++;
      disposal = (async () => {
        const results = await Promise.allSettled([...entries.values()].map(async entry => { entry.unsubscribe(); await entry.controller.dispose(); }));
        entries.clear(); listeners.clear();
        const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
        if (errors.length) throw new AggregateError(errors, '部分反应性来源未确认释放。');
      })();
      return disposal;
    },
  };
}
export type ReactivityContextPool = ReturnType<typeof createReactivityContextPool>;
