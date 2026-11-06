import type { AdvancedPathBridge, AdvancedPathEvent, AdvancedPathRequest } from './path-contracts';
import type { ConformerSamplingBridge, ConformerSamplingEvent, ConformerSamplingRequest } from './sampling-contracts';
import type { AissBridge, AissEvent, AissRequest } from './docking-contracts';

type Request = AdvancedPathRequest | ConformerSamplingRequest | AissRequest;
type Event = AdvancedPathEvent | ConformerSamplingEvent | AissEvent;
type Terminal<T> = Extract<T, { event: 'completed' | 'search-checkpoint' | 'stopped' | 'error' }>;
interface RouteCallbacks<E> {
  onEvent(event: E): void; onIgnored(): void; onProtocolError(error: Error): void;
}
export interface OwnedRouteSession<E> {
  terminal: Promise<{ event: Terminal<E>; protocolError?: string }>;
  /** Resolves only on this bridge's actual close receipt. */
  stop(): Promise<void>;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** One owned subjob protocol waiter. It has no queue, scheduler, task mutation
 * or new route controller; AdvancedController remains the sole run owner. */
function awaitOwnedRoute<R extends Request, E extends Event>(request: R, sessionId: string,
  subscribe: (listener: (event: E) => void) => () => void,
  start: () => Promise<unknown>, command: () => Promise<{ sessionId: string; status: 'stopped' }>,
  callbacks: RouteCallbacks<E>): OwnedRouteSession<E> {
  let sequence = -1, settled = false, protocolError: string | undefined, stopPending: Promise<void> | undefined;
  let resolve!: (result: { event: Terminal<E>; protocolError?: string }) => void, reject!: (error: Error) => void;
  const terminal = new Promise<{ event: Terminal<E>; protocolError?: string }>((yes, no) => { resolve = yes; reject = no; });
  let unsubscribe: (() => void) | undefined;
  const finish = (event: Terminal<E>) => { if (settled) return; settled = true; unsubscribe?.(); resolve({ event: structuredClone(event), protocolError }); };
  const stop = () => {
    if (settled) return Promise.resolve();
    return stopPending ??= command().then(receipt => {
      if (!settled && receipt.sessionId === sessionId && receipt.status === 'stopped') finish({
        schema: 1, sessionId, stamp: request.stamp, runIdentity: request.runIdentity, operation: request.operation, method: request.method,
        seq: sequence + 1, event: 'stopped', reason: 'cancelled', ...(request.operation === 'aiss-docking' ? { nativeClosed: true } : { workerSettled: true }), exit: { code: null, signal: null },
      } as Terminal<E>);
    }).catch(error => { stopPending = undefined; throw error; });
  };
  const invalid = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error)); protocolError ??= failure.message;
    callbacks.onProtocolError(failure); void stop().catch(stopError => callbacks.onProtocolError(stopError instanceof Error ? stopError : new Error(String(stopError))));
  };
  unsubscribe = subscribe(event => {
    if (settled || event.sessionId !== sessionId) return;
    if (event.schema !== 1 || !same(event.stamp, request.stamp) || !same(event.runIdentity, request.runIdentity)
      || event.method !== request.method || event.operation !== request.operation || !Number.isSafeInteger(event.seq) || event.seq <= sequence) { callbacks.onIgnored(); return; }
    sequence = event.seq;
    if (['completed', 'search-checkpoint', 'stopped', 'error'].includes(event.event)) {
      const end = event as Terminal<E>, exit = end.exit;
      const closed = request.operation === 'aiss-docking' ? 'nativeClosed' in end && end.nativeClosed === true : 'workerSettled' in end && end.workerSettled === true;
      if (!closed || !exit || !(exit.code === null || Number.isSafeInteger(exit.code))
        || !(exit.signal === null || typeof exit.signal === 'string')) { invalid(new Error('路径/采样终态缺少实际worker关闭回执。')); return; }
      finish(end); return;
    }
    try { callbacks.onEvent(structuredClone(event)); } catch (error) { invalid(error); }
  });
  void Promise.resolve().then(start).catch(error => {
    if (settled) return;
    if (sequence < 0) { settled = true; unsubscribe?.(); reject(error instanceof Error ? error : new Error(String(error))); }
    else invalid(error);
  });
  return { terminal, stop };
}
export function startOwnedDocking(bridge: AissBridge, request: AissRequest, sessionId: string,
  callbacks: RouteCallbacks<AissEvent>): OwnedRouteSession<AissEvent> {
  return awaitOwnedRoute(request, sessionId, listener => bridge.onAissEvent(listener),
    () => bridge.startAiss(request, sessionId), () => bridge.commandAiss(sessionId, { command: 'stop' }), callbacks);
}
export function startOwnedPath(bridge: AdvancedPathBridge, request: AdvancedPathRequest, sessionId: string,
  callbacks: RouteCallbacks<AdvancedPathEvent>): OwnedRouteSession<AdvancedPathEvent> {
  return awaitOwnedRoute(request, sessionId, listener => bridge.onAdvancedPathEvent(listener),
    () => bridge.startAdvancedPath(request, sessionId), () => bridge.commandAdvancedPath(sessionId, { command: 'stop' }), callbacks);
}
export function startOwnedSampling(bridge: ConformerSamplingBridge, request: ConformerSamplingRequest, sessionId: string,
  callbacks: RouteCallbacks<ConformerSamplingEvent>): OwnedRouteSession<ConformerSamplingEvent> {
  return awaitOwnedRoute(request, sessionId, listener => bridge.onConformerSamplingEvent(listener),
    () => bridge.startConformerSampling(request, sessionId), () => bridge.commandConformerSampling(sessionId, { command: 'stop' }), callbacks);
}
