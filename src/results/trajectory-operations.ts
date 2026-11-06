/** Opt-in observation only: no retained event history, scientific state or work scheduling. */
export type TrajectoryOperationKind = 'read' | 'parse' | 'empirical' | 'quantum' | 'orbital' | 'surface' | 'memory' | 'render';
export interface TrajectoryOperationContext {
  sourceId: string; resultId?: string; jobIndex?: number; sourceFrameIndex?: number; stageId?: string; localFrameIndex?: number; sourceRevision?:string; analysisId?:string;
  /** Work scope, separate from the event's started/settled lifecycle phase. */
  workPhase?: string;
}
export interface TrajectoryOperationEvent extends TrajectoryOperationContext {
  sequence: number; operationId: number; kind: TrajectoryOperationKind; phase: 'started' | 'settled'; atMs: number;
  durationMs?: number; outcome?: 'completed' | 'failed' | 'cancelled';
  /** Actual synchronous calls in a batch; never a trajectory-frame count. */
  samples?: number;
  /** Sum of timed synchronous segments, excluding gaps/I/O/await; not OS CPU time. */
  durationKind?: 'synchronous-segments';
}
const listeners = new Set<(event: Readonly<TrajectoryOperationEvent>) => void>();
let sequence = 0, serial = 0, listenerEpoch = 0;
const now = () => typeof performance === 'undefined' ? Date.now() : performance.now();
function emit(event: TrajectoryOperationEvent, audience?: readonly ((event: Readonly<TrajectoryOperationEvent>) => void)[]) {
  const snapshot = Object.freeze(event);
  for (const listener of audience ?? listeners) {
    if (audience && !listeners.has(listener)) continue;
    try { listener(snapshot); } catch { /* An observer never changes scientific execution. */ }
  }
}
export function observeTrajectoryOperations(listener: (event: Readonly<TrajectoryOperationEvent>) => void): () => void {
  if (!listeners.has(listener)) { listeners.add(listener); listenerEpoch++; }
  return () => { if (listeners.delete(listener)) listenerEpoch++; };
}
export function recordTrajectoryOperation(kind: TrajectoryOperationKind, context: TrajectoryOperationContext): void {
  if (!listeners.size) return;
  emit({ ...context, kind, phase: 'settled', sequence: ++sequence, operationId: ++serial, atMs: now(), durationMs: 0, outcome: 'completed' });
}
/** Preserve sync return values and the asynchronous result/error; off means no clock/events/history. */
export function traceTrajectoryOperation<T>(kind: TrajectoryOperationKind, context: TrajectoryOperationContext, operation: () => T): T {
  if (!listeners.size) return operation();
  const operationId = ++serial, started = now();
  emit({ ...context, kind, phase: 'started', sequence: ++sequence, operationId, atMs: started });
  const finish = (outcome: TrajectoryOperationEvent['outcome'] = 'completed') => {
    const ended = now();
    emit({ ...context, kind, phase: 'settled', sequence: ++sequence, operationId, atMs: ended, durationMs: ended - started,
      outcome });
  };
  const failed = (error: unknown) => finish(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed');
  try {
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === 'function')
      return Promise.resolve(result).then(value => { finish(); return value; }, error => { failed(error); throw error; }) as T;
    finish(); return result;
  } catch (error) { failed(error); throw error; }
}

/** Aggregate synchronous work at its real call sites without buffering inputs,
 * delaying execution or counting time spent awaiting the next source chunk.
 * run returns exactly the action's value; a returned promise is not awaited or
 * classified as asynchronous parse CPU. Its synchronous invocation alone is timed.
 * A subscription change closes the previous observed batch for its remaining
 * original listeners; new listeners never inherit earlier/unobserved samples. */
export function createTrajectoryOperationBatch(kind: TrajectoryOperationKind, context: TrajectoryOperationContext, batchSize = 256) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('观测批次大小须为正整数。');
  interface Batch {
    operationId: number; epoch: number; samples: number; durationMs: number; ended: number;
    audience: ((event: Readonly<TrajectoryOperationEvent>) => void)[];
  }
  let batch: Batch | undefined;
  const settle = (outcome: TrajectoryOperationEvent['outcome'] = 'completed') => {
    const current = batch; batch = undefined;
    if (!current?.samples || !listeners.size) return;
    emit({ ...context, kind, phase: 'settled', sequence: ++sequence, operationId: current.operationId,
      atMs: current.ended, durationMs: current.durationMs, durationKind: 'synchronous-segments', samples: current.samples, outcome }, current.audience);
  };
  return {
    run<T>(action: () => T): T {
      if (batch && batch.epoch !== listenerEpoch) settle();
      if (!listeners.size) return action();
      const started = now();
      if (!batch) {
        batch = { operationId: ++serial, epoch: listenerEpoch, samples: 0, durationMs: 0, ended: started, audience: [...listeners] };
        emit({ ...context, kind, phase: 'started', sequence: ++sequence, operationId: batch.operationId,
          atMs: started, durationKind: 'synchronous-segments' }, batch.audience);
      }
      const current = batch;
      const measured = () => { current.ended = now(); current.durationMs += current.ended - started; current.samples++; };
      try {
        const value = action(); measured();
        if (current.samples >= batchSize) settle();
        return value;
      } catch (error) {
        measured(); settle(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'); throw error;
      }
    },
    flush() { settle(); },
  };
}
