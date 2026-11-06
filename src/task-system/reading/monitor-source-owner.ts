import type { MonitorOwnerOptions, PreparedMonitorValue, PublishedMonitorLease, RefreshRequest, ScientificReadSnapshot, SourceObservationEvidence } from './contracts';

interface Publication<T, P> {
  snapshot: ScientificReadSnapshot<T>;
  prepared: PreparedMonitorValue<P>;
  refs: number;
  disposed: boolean;
}
export interface MonitorRefreshResult {
  kind: 'published' | 'unchanged' | 'pending' | 'stale' | 'failed';
  snapshotId?: string;
  error?: unknown;
  reason?: 'source-in-flight-change';
  observationState?: 'pending';
  observationEvidence?: SourceObservationEvidence;
}
/** Owns only monitoring reads. Disposing this owner never stops an external run. */
export class MonitorSourceOwner<T, P> {
  private epoch: number;
  private generation = 0;
  private closed = false;
  private paused = false;
  private current: Publication<T, P> | null = null;
  private candidate: ScientificReadSnapshot<T> | null = null;
  private pending: RefreshRequest | null = null;
  private active: AbortController | null = null;
  private flight: Promise<MonitorRefreshResult> | null = null;
  private disposal: Promise<void> | null = null;
  private intermediate: { signal: AbortSignal; valid(): boolean } | null = null;
  constructor(private readonly options: MonitorOwnerOptions<T, P>) { this.epoch = options.managerEpoch; }
  get publishedSnapshotId(): string | null { return this.current?.snapshot.snapshotId ?? null; }
  /** Scalar evidence for bounded queues and consumer accounting. */
  get counts(): Readonly<{ active: number; queued: number; candidates: number; monitoringPublications: number; currentReferences: number }> {
    return { active: this.active ? 1 : 0, queued: this.pending ? 1 : 0, candidates: this.candidate ? 1 : 0, monitoringPublications: this.current ? 1 : 0, currentReferences: this.current?.refs ?? 0 };
  }
  setManagerEpoch(epoch: number): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch; this.generation++; this.pending = null; this.active?.abort();
  }
  pause(): void { this.paused = true; this.generation++; this.pending = null; this.active?.abort(); }
  resume(): void { if (!this.closed) this.paused = false; }
  refresh(request: RefreshRequest): Promise<MonitorRefreshResult> {
    if (this.closed || this.paused || request.managerEpoch !== this.epoch) return Promise.resolve({ kind: 'stale' });
    this.pending = { ...request, final: request.final || this.pending?.final };
    if (!this.flight) {
      // Enter asynchronously so all same-turn requests share this single flight.
      this.flight = Promise.resolve().then(() => this.drain()).finally(() => {
        this.flight = null;
        // A subscriber may enqueue in the microtask between drain's return and
        // this completion. Keep that last coalesced trigger from being stranded.
        if (this.pending && !this.closed && !this.paused) void this.refresh(this.pending);
      });
    }
    return this.flight;
  }
  retainCurrent(): PublishedMonitorLease<T, P> | null {
    const publication = this.current;
    if (!publication || this.closed) return null;
    publication.refs++;
    let released = false;
    return {
      snapshot: publication.snapshot,
      value: publication.prepared.value,
      release: async () => { if (released) return; released = true; await this.release(publication); }
    };
  }
  private async release(publication: Publication<T, P>): Promise<void> {
    if (--publication.refs !== 0 || publication.disposed) return;
    publication.disposed = true;
    try { await publication.prepared.dispose(); }
    finally { publication.snapshot.dispose(); }
  }
  private notifyError(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* Observers cannot own a request or undo publication. */ }
  }
  /** Called only by the active reader, between bounded chunks. The candidate
   * shares this owner's single slot and publication/lease lifecycle. */
  async publishIntermediate(snapshot: ScientificReadSnapshot<T>): Promise<void> {
    const context = this.intermediate;
    if (!context?.valid()) { snapshot.dispose(); return; }
    this.candidate = snapshot;
    let prepared: PreparedMonitorValue<P> | null = null;
    try {
      prepared = await this.options.prepare(snapshot, context.signal);
      if (!context.valid()) return;
      const publication: Publication<T, P> = { snapshot, prepared, refs: 1, disposed: false }, old = this.current;
      this.current = publication; this.candidate = null; prepared = null;
      if (old) { try { await this.release(old); } catch (error) { this.notifyError(error); } }
      try { this.options.onIntermediatePublication?.(snapshot, publication.prepared.value); }
      catch (error) { this.notifyError(error); }
      try { this.options.onPublish?.(snapshot, publication.prepared.value); }
      catch (error) { this.notifyError(error); }
    } finally {
      try { await prepared?.dispose(); }
      finally { this.candidate?.dispose(); this.candidate = null; }
    }
  }
  private async drain(): Promise<MonitorRefreshResult> {
    let result: MonitorRefreshResult = { kind: 'stale' };
    while (this.pending && !this.closed && !this.paused) {
      const request = this.pending; this.pending = null;
      if (request.managerEpoch !== this.epoch) continue;
      const generation = this.generation, controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
      this.active = controller;
      let prepared: PreparedMonitorValue<P> | null = null;
      const valid = () => !signal.aborted && !this.closed && !this.paused && generation === this.generation && request.managerEpoch === this.epoch;
      this.intermediate = { signal, valid };
      try {
        const read = await this.options.reader.refresh({ final: request.final, signal, observationMode: request.observationMode, observedIdentity: request.observedIdentity });
        if (read.kind !== 'candidate') { result = valid() ? { kind: read.kind, ...(read.kind === 'pending' && read.reason ? { reason: read.reason, observationState: read.observationState, observationEvidence: read.observationEvidence } : {}) } : { kind: 'stale' }; continue; }
        this.candidate = read.snapshot;
        if (!valid()) { this.options.reader.retryPublication?.(); result = { kind: 'stale' }; continue; }
        prepared = await this.options.prepare(read.snapshot, signal);
        if (!valid()) { this.options.reader.retryPublication?.(); result = { kind: 'stale' }; continue; }
        const publication: Publication<T, P> = { snapshot: read.snapshot, prepared, refs: 1, disposed: false };
        const old = this.current;
        // New data is ready before the sole monitoring reference changes owner.
        this.current = publication; this.candidate = null; prepared = null;
        result = { kind: 'published', snapshotId: publication.snapshot.snapshotId };
        if (old) { try { await this.release(old); } catch (error) { this.notifyError(error); } }
        // Subscriber errors do not undo an already successful atomic publication.
        try { this.options.onPublish?.(publication.snapshot, publication.prepared.value); }
        catch (error) { this.notifyError(error); }
      } catch (error) {
        if (this.candidate) this.options.reader.retryPublication?.();
        result = valid() ? { kind: 'failed', error } : { kind: 'stale' };
        if (valid()) this.notifyError(error);
      } finally {
        try { await prepared?.dispose(); } catch (error) { this.notifyError(error); }
        finally { this.candidate?.dispose(); this.candidate = null; this.active = null; this.intermediate = null; }
      }
    }
    return result;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true; this.generation++; this.pending = null; this.active?.abort();
    this.disposal = (async () => {
      await this.flight;
      const current = this.current; this.current = null;
      try { if (current) await this.release(current); }
      finally { await this.options.reader.dispose(); }
    })();
    return this.disposal;
  }
}
