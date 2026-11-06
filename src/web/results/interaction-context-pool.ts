import type { SurfaceContext } from '../../results/surface-contracts';
import { createMultiwfnProgressTracker, multiwfnProgressTerminal, type MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import { createInteractionDesktopBridge, type InteractionDesktopBridgeOptions } from './interaction-desktop-bridge';
import { surfaceScientificContextKey, surfaceSourceLifetimeKey } from './surface-context-pool';

export type InteractionDesktopController = ReturnType<typeof createInteractionDesktopBridge>;
type Tracker = ReturnType<typeof createMultiwfnProgressTracker>;
interface ContextEntry { controller: InteractionDesktopController; trackers: Map<string, Tracker>; progress: MultiwfnProgressSnapshot | null; visibleRequestId:string|null; unsubscribe(): void }

/** Own sessions/artifact descriptors across frame changes, not model/camera state.
 * Activation may cancel old work but never generates fields or contributions. */
export function createInteractionContextPool(factory = createInteractionDesktopBridge) {
  const contexts = new Map<string, ContextEntry>(), listeners = new Set<() => void>();
  const accepted = new Map<string, { operation: 'fields' | 'contributions' | 'export'; renderRequired: boolean }>();
  const rejected = new Map<string,{reason:'cancelled'|'failed';message?:string}>();
  const meshes = new Map<string, string>();
  const meshFailures = new Map<string, { context: string; message: string }>();
  let lifetime: string | undefined, serial = 0, disposed = false, disposal: Promise<void> | undefined;
  const notify = () => listeners.forEach(listener => listener());
  const acceptTracker = (key: string, requestId: string, tracker: Tracker) => {
    const choice = accepted.get(requestId); if (!choice) return;
    if (!tracker.getSnapshot().committed && !tracker.getSnapshot().renderRequired) tracker.committed(choice.renderRequired
      ? { required: true, committed: meshes.get(requestId) === key } : undefined);
    const failure = meshFailures.get(requestId), state = tracker.getSnapshot();
    if (choice.renderRequired && failure?.context === key && state.settlement === 'native-settled' && !multiwfnProgressTerminal(state.phase)) tracker.failed('native-settled', failure.message);
  };
  const rejectTracker=(requestId:string,tracker:Tracker)=>{
    const rejection=rejected.get(requestId),state=tracker.getSnapshot();if(!rejection||multiwfnProgressTerminal(state.phase))return;
    if(state.phase==='parse'&&state.validated&&state.settlement==='native-settled'){
      if(rejection.reason==='cancelled')tracker.stopped('native-settled');else tracker.failed('native-settled',rejection.message);
    }else if(state.settlement==='cancelled-before-start'){
      if(rejection.reason==='cancelled')tracker.stopped('cancelled-before-start');else tracker.failed('cancelled-before-start',rejection.message);
    }else if(state.settlement==='not-started'&&rejection.reason==='failed')tracker.failed('not-started',rejection.message);
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    progress(context: SurfaceContext) { return contexts.get(surfaceScientificContextKey(context))?.progress ?? null; },
    get(context: SurfaceContext) { return disposed ? undefined : contexts.get(surfaceScientificContextKey(context))?.controller; },
    async activate(options: InteractionDesktopBridgeOptions): Promise<InteractionDesktopController | null> {
      if (disposed) throw new DOMException('相互作用来源已关闭。', 'AbortError');
      const source = surfaceSourceLifetimeKey(options.analysisId, options.context), key = surfaceScientificContextKey(options.context);
      if (lifetime !== undefined && lifetime !== source) throw new Error('相互作用来源已变化，需要新的来源生命周期。');
      lifetime = source;
      let entry = contexts.get(key);
      if (!entry) {
        const controller = factory({ ...options, active: false });
        entry = { controller, trackers: new Map(), progress: null, visibleRequestId:null, unsubscribe() {} };
        const own = entry;
        entry.unsubscribe = controller.onProgress(event => {
          if (disposed) return;
          let tracker = own.trackers.get(event.identity.runId);
          if (!tracker) {
            own.visibleRequestId=event.identity.runId;
            tracker = createMultiwfnProgressTracker(event.identity, snapshot => { if(own.visibleRequestId!==snapshot.identity.runId)return;own.progress = snapshot; notify(); });
            own.trackers.set(event.identity.runId, tracker);
          }
          tracker.receive(event);
          acceptTracker(key, event.identity.runId, tracker);
          rejectTracker(event.identity.runId,tracker);
        });
        contexts.set(key, entry);
      }
      const token = ++serial;
      await Promise.all([...contexts.values()].filter(value => value !== entry).map(value => value.controller.setActive(false)));
      if (disposed || token !== serial) return null;
      await entry.controller.setActive(options.active);
      return disposed || token !== serial ? null : entry.controller;
    },
    accepted(requestId: string, operation: 'fields' | 'contributions' | 'export', renderRequired = false) {
      if (disposed) return;
      // Controls can accept a background frame's state. Never substitute the
      // currently observed context for the request's original logical owner.
      accepted.set(requestId, { operation, renderRequired:operation==='export'?false:renderRequired });
      for (const [key, entry] of contexts) { const tracker = entry.trackers.get(requestId); if (tracker) acceptTracker(key, requestId, tracker); }
    },
    rejected(requestId:string,_operation:'export',reason:'cancelled'|'failed',message?:string){
      if(disposed)return;rejected.set(requestId,{reason,message});
      for(const entry of contexts.values()){const tracker=entry.trackers.get(requestId);if(tracker)rejectTracker(requestId,tracker);}
    },
    meshCommitted(context: SurfaceContext, requestId: string) {
      if (disposed) return;
      const key = surfaceScientificContextKey(context), entry = contexts.get(key);
      if (!entry) return;
      meshes.set(requestId, key); entry.trackers.get(requestId)?.renderCommitted();
    },
    meshFailed(context: SurfaceContext, requestId: string, message: string) {
      if (disposed) return;
      const key = surfaceScientificContextKey(context), entry = contexts.get(key); if (!entry) return;
      meshFailures.set(requestId, { context: key, message });
      const tracker = entry.trackers.get(requestId); if (tracker) acceptTracker(key, requestId, tracker);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true; serial++;
      disposal = (async () => {
        const results = await Promise.allSettled([...contexts.values()].map(async entry => { entry.unsubscribe(); await entry.controller.dispose(); }));
        contexts.clear(); accepted.clear(); rejected.clear(); meshes.clear(); meshFailures.clear(); listeners.clear();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, '部分相互作用来源未确认释放。');
      })(); return disposal;
    },
  };
}
export type InteractionContextPool = ReturnType<typeof createInteractionContextPool>;
