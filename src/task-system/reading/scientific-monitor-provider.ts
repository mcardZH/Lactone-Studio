import type { ResultInputFile } from '../../results/contracts';
import type { ScientificParserSnapshot } from '../../results/scientific-contracts';
import type { ConnectionTransport } from '../contracts';
import type { MonitorSourceIdentity, ScientificReadSnapshot, RefreshRequest } from './contracts';
import { IncrementalScientificReader } from './incremental-scientific-reader';
import { MonitorSourceOwner, type MonitorRefreshResult } from './monitor-source-owner';
import { prepareScientificMonitor, type PreparedScientificMonitor, type ScientificMonitorDelta } from './prepared-scientific-monitor';
import { ScientificMonitoringSession } from './scientific-parser-session';
import type { ClassifierPrimary } from './aux-classifier';
import type { ScientificReadProgress } from '../application-contracts';
import { preparedMonitorResultViews } from './monitor-results';

export interface ScientificMonitorPublication extends ScientificMonitorDelta {
  snapshotId: string;
  sourceRevision: number;
  sourceGeneration: number;
  jobs: ScientificParserSnapshot['jobs'];
  counts: PreparedScientificMonitor['counts'];
  sourceBoundary: PreparedScientificMonitor['sourceBoundary'];
}
/** A fixed prefix input source, independent of subsequent monitor updates. */
export function retainScientificMonitorSource(prepared: PreparedScientificMonitor): ResultInputFile {
  const lease = prepared.retain(), size = prepared.sourceBoundary.publishedByteRange.end;
  let closed = false;
  return {
    id: prepared.snapshotId,
    name: prepared.sourceIdentity.path.split(/[\\/]/).at(-1) || 'output', size,
    async readRange(start, end, signal) { if (closed) throw new Error('固定监控来源已关闭。'); return lease.readSourceRange(start, end, signal); },
    stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) { controller.error(new Error('固定监控来源已关闭。')); return; }
          if (offset >= size) { controller.close(); return; }
          const end = Math.min(size, offset + 256 * 1024); controller.enqueue(await lease.readSourceRange(offset, end)); offset = end;
        }
      });
    },
    close() { if (closed) return; closed = true; lease.release(); }
  };
}

/** Single-source facade. The host owns task/artifact selection, environment
 * queueing and the map of these providers; this module does not scan locations. */
export function createScientificMonitorProvider(options: {
  source: MonitorSourceIdentity;
  transport: Pick<ConnectionTransport, 'stat' | 'readRange' | 'hash' | 'readObservedRange'>;
  managerEpoch: number;
  onError?(error: unknown): void;
  onPublish?(snapshot: ScientificReadSnapshot<ScientificParserSnapshot>, value: PreparedScientificMonitor): void;
  onProgress?(progress: ScientificReadProgress): void;
  onIntermediatePublication?(snapshot: ScientificReadSnapshot<ScientificParserSnapshot>, value: PreparedScientificMonitor): void;
}) {
  let epoch = options.managerEpoch, readEpoch = epoch, sequence = 0, operation = 0, stage: ScientificReadProgress['stage'] | undefined, stageStarted = performance.now();
  let latest: ScientificReadProgress | undefined;
  const report = (update: Partial<ScientificReadProgress> & Pick<ScientificReadProgress, 'stage'>) => {
    if (readEpoch !== epoch) return;
    if (stage !== update.stage) { stage = update.stage; stageStarted = performance.now(); }
    latest = { taskId: options.source.taskId, runId: options.source.runId, sourceId: options.source.sourceId, artifactId: options.source.artifactId,
      managerEpoch: epoch, sourceGeneration: 0, sourceRevision: 0, operationId: `${options.source.sourceId}:read:${operation}`, sequence: ++sequence,
      observedAt: new Date().toISOString(), completedBytes: 0, totalBytes: null, completeFrames: 0, preparedFrames: 0, ...latest, ...update,
      elapsedMs: performance.now() - stageStarted };
    latest.managerEpoch = epoch; latest.sequence = sequence; latest.operationId = `${options.source.sourceId}:read:${operation}`; latest.observedAt = new Date().toISOString();
    try { options.onProgress?.(latest); } catch { /* A progress consumer never owns scientific publication. */ }
  };
  const reader = new IncrementalScientificReader({ source: options.source, transport: options.transport, createParser: () => new ScientificMonitoringSession(), onProgress: progress => report({ ...progress, completeFrames: progress.sourceGeneration === latest?.sourceGeneration ? latest?.completeFrames ?? 0 : 0 }),
    onIntermediateSnapshot: snapshot => owner.publishIntermediate(snapshot) });
  const owner: MonitorSourceOwner<ScientificParserSnapshot, PreparedScientificMonitor> = new MonitorSourceOwner({
    reader: { refresh(input) { readEpoch = epoch; operation++; stage = undefined; latest = undefined; return reader.refresh(input); }, retryPublication() { reader.retryPublication(); }, dispose() { return reader.dispose(); } }, managerEpoch: options.managerEpoch,
    async prepare(snapshot, signal) {
      const old = owner.retainCurrent();
      try {
        report({ stage: 'preparing', sourceGeneration: snapshot.sourceGeneration, sourceRevision: snapshot.sourceRevision, completeFrames: snapshot.value.jobs.reduce((sum, job) => sum + job.frames.length, 0), preparedFrames: 0 });
        const value = await prepareScientificMonitor(snapshot, old?.value, { signal, onProgress: completed => report({ stage: 'preparing', preparedFrames: completed }) });
        report({ stage: 'publishing' });
        return { value, dispose() { value.release(); } };
      } finally { await old?.release(); }
    }, onError: options.onError, onPublish: options.onPublish, onIntermediatePublication: options.onIntermediatePublication
  });
  return {
    async refresh(input: RefreshRequest): Promise<MonitorRefreshResult> { const requestEpoch = epoch; const result = await owner.refresh(input); if (requestEpoch === epoch && result.kind !== 'stale') report({ stage: result.kind === 'failed' ? 'failed' : 'ready' }); return result; },
    /** Read last reliable data without doing another IO poll. */
    async publication(knownRevision?: string | null): Promise<ScientificMonitorPublication | null> {
      const current = owner.retainCurrent(); if (!current) return null;
      try {
        const value = current.value;
        return { ...value.delta(knownRevision), snapshotId: value.snapshotId, sourceRevision: value.sourceRevision, sourceGeneration: value.sourceGeneration, jobs: value.jobs, counts: value.counts, sourceBoundary: value.sourceBoundary };
      } finally { await current.release(); }
    },
    async snapshotSources(): Promise<ResultInputFile[]> {
      const current = owner.retainCurrent(); if (!current) return [];
      try { return [retainScientificMonitorSource(current.value)]; }
      finally { await current.release(); }
    },
    async retainPrepared(): Promise<PreparedScientificMonitor | null> {
      const current = owner.retainCurrent(); if (!current) return null;
      try { return current.value.retain(); } finally { await current.release(); }
    },
    async resultViews() { const prepared = await this.retainPrepared(); if (!prepared) return []; try { return preparedMonitorResultViews(prepared); } finally { prepared.release(); } },
    async retainClassifierPrimary(): Promise<(ClassifierPrimary & { release(): Promise<void> }) | null> {
      let retained = owner.retainCurrent(); if (!retained) return null;
      const snapshotId = retained.snapshot.snapshotId, runId = retained.snapshot.identity.runId;
      if (runId === null) { await retained.release(); return null; }
      return Object.freeze({
        snapshotId, runId,
        get index() {
          if (!retained) throw new Error('固定classifier主来源已释放。');
          return retained.snapshot.value;
        },
        async openSource() {
          if (!retained) throw new Error('固定classifier主来源已释放。');
          return retainScientificMonitorSource(retained.value);
        },
        async release() { const active = retained; retained = null; await active?.release(); }
      });
    },
    setManagerEpoch(value: number) { epoch = value; owner.setManagerEpoch(value); },
    pause() { owner.pause(); }, resume() { owner.resume(); },
    get counts() { return owner.counts; },
    dispose() { return owner.dispose(); }
  };
}
