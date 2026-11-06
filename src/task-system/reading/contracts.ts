import type { ConnectionTransport, FileIdentity, SourceBoundary } from '../contracts';

/** Half-open byte offsets. Scientific adapters must never substitute character counts. */
export interface MonitorLine { text: string; start: number; end: number; number: number }
export interface ParserProjection<T> {
  /** Immutable data, with closed jobs/frames shared between projections where possible. */
  value: T;
  /** Exclusive end of the last scientifically complete source block. */
  publishedByteEnd: number;
  /** Changes only when publishable facts change, including diagnostics without geometry. */
  version: number;
}
/** Temporary EOF uses snapshot; final is reserved for a fixed, explicitly ended read. */
export interface IncrementalParserSession<T> {
  consume(line: MonitorLine): void;
  snapshot(): ParserProjection<T> | null;
  final(): ParserProjection<T> | null;
  dispose(): void | Promise<void>;
}
export interface MonitorSourceIdentity {
  sourceId: string;
  taskId: string;
  runId: string | null;
  artifactId: string;
  path: string;
}
export interface RetainedSourceBytes {
  readonly size: number;
  /** A lease holds immutable original bytes, never a live filesystem path. */
  retain(): RetainedSourceBytes;
  readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  release(): void;
}
export interface ScientificReadSnapshot<T> {
  readonly snapshotId: string;
  readonly identity: Readonly<MonitorSourceIdentity>;
  readonly sourceRevision: number;
  /** Parser/source lineage; append keeps it, rewrite/replacement starts another. */
  readonly sourceGeneration: number;
  readonly parserVersion: number;
  readonly fileIdentity: Readonly<FileIdentity>;
  readonly sourceBoundary: SourceBoundary;
  /** SHA of retained readByteRange, including its withheld tail; observedEnd
   * may be farther ahead while a large cold source is still being transferred. */
  readonly observedSha256: string;
  readonly final: boolean;
  readonly integrity: 'observed-prefix' | 'damaged-tail';
  readonly damagedAtByte?: number;
  readonly value: T;
  readonly bytes: RetainedSourceBytes;
  /** Transfers may retain bytes first. Releasing this snapshot is idempotent. */
  dispose(): void;
}
export type IncrementalReadOutcome<T> =
  | { kind: 'unchanged'; sourceRevision: number }
  | { kind: 'pending'; sourceRevision: number; reason?: 'source-in-flight-change'; observationState?: 'pending'; observationEvidence?: SourceObservationEvidence }
  | { kind: 'candidate'; snapshot: ScientificReadSnapshot<T>; change: 'initial' | 'append' | 'rewrite' | 'final' | 'retry' };
export interface IncrementalReaderOptions<T> {
  source: MonitorSourceIdentity;
  transport: Pick<ConnectionTransport, 'stat' | 'readRange' | 'hash' | 'readObservedRange'>;
  createParser(): IncrementalParserSession<T>;
  chunkBytes?: number;
  /** Observability only; no ownership of the shared connection transport. */
  onDispose?: () => void;
  onProgress?(progress: { stage: 'connecting' | 'transferring' | 'parsing'; completedBytes: number; totalBytes: number | null; completeFrames: number; sourceGeneration: number; sourceRevision: number }): void;
  /** Transfers ownership of one complete bounded checkpoint to the same owner. */
  onIntermediateSnapshot?(snapshot: ScientificReadSnapshot<T>): Promise<void>;
}
export interface SourceObservationEvidence { phase: string; before: FileIdentity; after: FileIdentity }
export interface SourceReadOptions { final?: boolean; signal?: AbortSignal; observationMode?: 'live-primary-output' | 'fixed-source'; observedIdentity?: FileIdentity }
export interface RefreshRequest extends SourceReadOptions { managerEpoch: number }
export interface PreparedMonitorValue<T> { value: T; dispose(): void | Promise<void> }
export interface PublishedMonitorLease<T, P> {
  readonly snapshot: ScientificReadSnapshot<T>;
  readonly value: P;
  /** Each independent consumer releases its own lease. */
  release(): Promise<void>;
}
export interface MonitorOwnerOptions<T, P> {
  reader: {
    refresh(options?: SourceReadOptions): Promise<IncrementalReadOutcome<T>>;
    retryPublication?(): void;
    dispose(): Promise<void>;
  };
  managerEpoch: number;
  /** Must prepare only existing scientific data; no chemistry or bond perception. */
  prepare(snapshot: ScientificReadSnapshot<T>, signal: AbortSignal): Promise<PreparedMonitorValue<P>>;
  onPublish?(snapshot: ScientificReadSnapshot<T>, value: P): void;
  onIntermediatePublication?(snapshot: ScientificReadSnapshot<T>, value: P): void;
  onError?(error: unknown): void;
}
