import type { FileIdentity } from '../contracts';
import type { IncrementalParserSession, IncrementalReaderOptions, IncrementalReadOutcome, ParserProjection, ScientificReadSnapshot, SourceReadOptions } from './contracts';
import { CompleteByteLines, SourceByteBlocks } from './source-bytes';
import { changedObservation, liveGrowthObservation } from './source-observation';
import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.environmentId === b.environmentId && a.path === b.path && a.fileId === b.fileId;
}
function sameObservation(a: FileIdentity, b: FileIdentity): boolean {
  return a.verification === 'verified' && b.verification === 'verified' && sameFile(a, b) && a.byteSize === b.byteSize && a.modifiedAt === b.modifiedAt && a.changeToken === b.changeToken;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function verified(identity: FileIdentity): void {
  if (identity.verification !== 'verified' || !Number.isSafeInteger(identity.byteSize) || identity.byteSize < 0) throw new Error('来源身份或真实字节长度尚未可靠核实。');
}
/** IO and byte revisions only. Engine semantics stay in the existing scientific parsers. */
export class IncrementalScientificReader<T> {
  private parser: IncrementalParserSession<T> | null = null;
  private blocks = new SourceByteBlocks();
  private lines = new CompleteByteLines();
  private observed: FileIdentity | null = null;
  private digest: string | null = null;
  private observedDigest = new VibronicSha256();
  private revision = 0;
  private final = false;
  private disposed = false;
  private busy = false;
  private readonly lifetime = new AbortController();
  private inFlight: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private lastProjection: { generation: number; version: number; end: number; final: boolean; damagedAtByte?: number } | null = null;
  private retryRequested = false;
  private generation = 0;
  private readonly chunkBytes: number;
  private readonly source: Readonly<IncrementalReaderOptions<T>['source']>;
  constructor(private readonly options: IncrementalReaderOptions<T>) {
    this.source = Object.freeze({ ...options.source });
    this.chunkBytes = options.chunkBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1) throw new Error('读取分块必须为正整数字节数。');
  }
  async refresh(options: SourceReadOptions = {}): Promise<IncrementalReadOutcome<T>> {
    if (this.options.transport.readObservedRange) return this.refreshObserved(options);
    if (this.disposed) throw new Error('持续读取来源已关闭。');
    if (this.busy) throw new Error('同一来源的刷新须由单一owner合并。');
    options = { ...options, signal: AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]) };
    this.busy = true;
    let settled!: () => void;
    this.inFlight = new Promise<void>(resolve => { settled = resolve; });
    let parserTouched = false;
    try {
      options.signal?.throwIfAborted();
      const previousConsumedEnd = this.lines.consumedByteEnd, previousDamage = this.lines.damagedAtByte;
      const identity = await this.options.transport.stat(this.source.path, options);
      verified(identity);
      if (identity.path !== this.source.path) throw new Error('来源路径与读取owner身份不一致。');
      const hash = await this.options.transport.hash({ path: identity.path, identity, algorithm: 'sha256' }, options);
      options.signal?.throwIfAborted();
      if (!sameObservation(identity, hash.identity)) throw changedObservation('来源在内容核实期间发生变化。', 'initial-hash', identity, hash.identity);
      const identical = this.observed !== null && sameFile(this.observed, identity) && this.observed.byteSize === identity.byteSize && this.digest === hash.hash;
      if (identical && !this.retryRequested && (!options.final || this.final)) { this.observed = identity; return { kind: 'unchanged', sourceRevision: this.revision }; }
      let change: 'initial' | 'append' | 'rewrite' | 'final' | 'retry' = identical ? options.final && !this.final ? 'final' : 'retry' : this.observed ? 'rewrite' : 'initial';
      let offset = 0;
      if (!identical && this.observed && sameFile(this.observed, identity) && identity.byteSize > this.observed.byteSize && !this.final) {
        const prefix = await this.options.transport.hash({ path: identity.path, identity, algorithm: 'sha256', range: { offset: 0, length: this.observed.byteSize } }, options);
        options.signal?.throwIfAborted();
        if (!sameObservation(identity, prefix.identity)) throw changedObservation('来源在前缀核实期间发生变化。', 'prefix-hash', identity, prefix.identity);
        if (prefix.hash === this.digest) { change = 'append'; offset = this.observed.byteSize; }
      }
      if (change === 'initial' || change === 'rewrite') {
        parserTouched = true;
        await this.parser?.dispose();
        this.parser = this.options.createParser(); this.blocks = new SourceByteBlocks(); this.lines = new CompleteByteLines();
        this.final = false; this.generation++;
      }
      if (!this.parser) throw new Error('持续科学parser未准备好。');
      if (!identical) {
        while (offset < identity.byteSize) {
          options.signal?.throwIfAborted();
          const length = Math.min(this.chunkBytes, identity.byteSize - offset);
          const receipt = await this.options.transport.readRange({ path: identity.path, identity, offset, length }, options);
          options.signal?.throwIfAborted();
          if (receipt.offset !== offset || receipt.length !== length || receipt.bytes.length !== length) throw new Error('来源范围或文件身份与读取回执不一致。');
          if (!sameObservation(identity, receipt.before)) throw changedObservation('来源范围或文件身份与读取回执不一致。', 'read-range', identity, receipt.before);
          if (!sameObservation(receipt.before, receipt.after)) throw changedObservation('来源范围或文件身份与读取回执不一致。', 'read-range', receipt.before, receipt.after);
          if (await sha256(receipt.bytes) !== receipt.sha256) throw new Error('来源字节与范围SHA回执不一致。');
          options.signal?.throwIfAborted();
          this.blocks.append(receipt.bytes);
          parserTouched = true;
          this.lines.append(receipt.bytes, line => this.parser!.consume(line));
          offset += length;
        }
        // Recheck after the last range. A rewrite between chunks is never published.
        const after = await this.options.transport.hash({ path: identity.path, identity, algorithm: 'sha256' }, options);
        options.signal?.throwIfAborted();
        if (!sameObservation(identity, after.identity)) throw changedObservation('来源读取期间发生变化；保留最后有效发布版。', 'post-hash', identity, after.identity);
        if (after.hash !== hash.hash) throw new Error('来源读取期间发生变化；保留最后有效发布版。');
        this.observed = identity; this.digest = hash.hash; this.revision++;
      }
      let projection: ParserProjection<T> | null;
      if (change === 'append' && !options.final && !this.retryRequested && previousConsumedEnd === this.lines.consumedByteEnd && previousDamage === this.lines.damagedAtByte) return { kind: 'pending', sourceRevision: this.revision };
      parserTouched = true;
      if (options.final && !this.final) {
        this.lines.final(line => this.parser!.consume(line));
        projection = this.parser.final(); this.final = true;
      } else projection = this.parser.snapshot();
      options.signal?.throwIfAborted();
      this.retryRequested = false;
      if (!projection) return { kind: 'pending', sourceRevision: this.revision };
      if (!Number.isSafeInteger(projection.version) || !Number.isSafeInteger(projection.publishedByteEnd) || projection.publishedByteEnd < 0 || projection.publishedByteEnd > this.lines.consumedByteEnd) throw new Error('科学投影发布范围超出完整来源行。');
      const old = this.lastProjection;
      if (old?.generation === this.generation && old.version === projection.version && old.end === projection.publishedByteEnd && old.final === this.final && old.damagedAtByte === this.lines.damagedAtByte) return { kind: 'pending', sourceRevision: this.revision };
      const bytes = this.blocks.lease();
      let released = false;
      const source = this.source;
      const snapshot: ScientificReadSnapshot<T> = Object.freeze({
        snapshotId: JSON.stringify([source.sourceId, source.taskId, source.runId, source.artifactId, identity.environmentId, identity.fileId, hash.hash, projection.publishedByteEnd, projection.version, this.final]),
        identity: Object.freeze({ ...source }), sourceRevision: this.revision, sourceGeneration: this.generation, parserVersion: projection.version,
        fileIdentity: Object.freeze({ ...identity }),
        sourceBoundary: Object.freeze({ fileIdentity: Object.freeze({ ...identity }), readByteRange: Object.freeze({ start: 0, end: this.blocks.size }), publishedByteRange: Object.freeze({ start: 0, end: projection.publishedByteEnd }) }),
        observedSha256: hash.hash, final: this.final,
        integrity: this.lines.damagedAtByte === undefined ? 'observed-prefix' : 'damaged-tail',
        ...(this.lines.damagedAtByte === undefined ? {} : { damagedAtByte: this.lines.damagedAtByte }),
        value: projection.value, bytes,
        dispose() { if (released) return; released = true; bytes.release(); }
      });
      this.lastProjection = { generation: this.generation, version: projection.version, end: projection.publishedByteEnd, final: this.final, damagedAtByte: this.lines.damagedAtByte };
      return { kind: 'candidate', snapshot, change };
    } catch (error) {
      const growth = liveGrowthObservation(error, this.source.path, options);
      if (parserTouched) {
        // In-place parser mutation cannot be rolled back. Rebuild on the next
        // refresh while the owner and external leases keep the old publication.
        await this.parser?.dispose(); this.parser = null;
        this.observed = null; this.digest = null; this.blocks.clear(); this.lines = new CompleteByteLines(); this.final = false;
      }
      if (growth) return { kind: 'pending', reason: 'source-in-flight-change', observationState: 'pending', observationEvidence: growth, sourceRevision: this.revision };
      throw error;
    } finally { this.busy = false; settled(); this.inFlight = null; }
  }
  /** Observe one finite prefix. Appending after the frozen EOF never invalidates
   * complete blocks, and prefix proof is shared by all transfer chunks. */
  private async refreshObserved(input: SourceReadOptions): Promise<IncrementalReadOutcome<T>> {
    if (this.disposed || this.busy) throw new Error('持续读取来源已关闭或已有刷新。');
    const signal = AbortSignal.any([this.lifetime.signal, ...(input.signal ? [input.signal] : [])]);
    this.busy = true; let settled!: () => void;
    this.inFlight = new Promise<void>(resolve => { settled = resolve; });
    let touched = false;
    const progress = (stage: 'connecting' | 'transferring' | 'parsing', completedBytes: number, totalBytes: number | null) => this.options.onProgress?.({ stage, completedBytes, totalBytes, completeFrames: 0, sourceGeneration: this.generation, sourceRevision: this.revision });
    try {
      signal.throwIfAborted(); progress('connecting', 0, null);
      const identity = input.observedIdentity ?? await this.options.transport.stat(this.source.path, { signal }); verified(identity);
      if (identity.path !== this.source.path) throw new Error('来源路径与读取owner身份不一致。');
      const identical = this.observed !== null && sameObservation(this.observed, identity);
      if (identical && !this.retryRequested && (!input.final || this.final)) return { kind: 'unchanged', sourceRevision: this.revision };
      let change: 'initial' | 'append' | 'rewrite' | 'retry' = identical ? 'retry' : this.observed ? 'rewrite' : 'initial';
      let offset = 0;
      const append = !identical && this.observed && sameFile(this.observed, identity) && identity.byteSize > this.observed.byteSize && !this.final;
      let first = true;
      if (append) offset = this.observed!.byteSize;
      const frozenEnd = identity.byteSize;
      let initialized = identical || !!append;
      progress('transferring', offset, frozenEnd);
      // A continuation block; the frozen EOF determines total completion.
      while (!identical && (offset < frozenEnd || first)) {
        signal.throwIfAborted();
        const length = Math.min(4 * 1024 * 1024, frozenEnd - offset);
        const receipt = await this.options.transport.readObservedRange!({ path: identity.path, identity, offset, length,
          ...(first && append ? { previousPrefix: { end: this.observed!.byteSize, sha256: this.digest! } } : {}) }, { signal });
        signal.throwIfAborted();
        if (!sameFile(identity, receipt.before) || !sameFile(receipt.before, receipt.after) || receipt.before.byteSize < frozenEnd || receipt.after.byteSize < frozenEnd
          || receipt.offset !== offset || receipt.length !== length || receipt.bytes.length !== length || receipt.observedEnd < offset + length || await sha256(receipt.bytes) !== receipt.sha256) throw new Error('有界来源范围与读取回执不一致。');
        if ((input.final || input.observationMode !== 'live-primary-output') && (!sameObservation(identity, receipt.before) || !sameObservation(receipt.before, receipt.after))) throw new Error('固定来源在读取期间发生变化。');
        if (first && append) {
          if (receipt.previousPrefix?.end !== this.observed!.byteSize) throw new Error('缺少已消费前缀的完整证明。');
          if (receipt.previousPrefix.sha256 !== this.digest) {
            // Retain the old publication externally; restart this bounded read
            // from zero instead of appending changed earlier bytes.
            change = 'rewrite'; offset = 0; first = false; continue;
          }
          change = 'append';
        }
        if (!initialized || change === 'rewrite' && this.blocks.size !== offset) {
          touched = true; await this.parser?.dispose(); this.parser = this.options.createParser();
          this.blocks = new SourceByteBlocks(); this.lines = new CompleteByteLines(); this.observedDigest = new VibronicSha256(); this.final = false; this.generation++; initialized = true;
        }
        if (!this.parser) throw new Error('持续科学parser未准备好。');
        this.blocks.append(receipt.bytes); touched = true;
        progress('parsing', this.lines.consumedByteEnd, frozenEnd);
        for (let at = 0; at < receipt.bytes.length; at += this.chunkBytes) {
          signal.throwIfAborted(); this.lines.append(receipt.bytes.subarray(at, at + this.chunkBytes), line => this.parser!.consume(line));
          progress('parsing', Math.min(this.blocks.size, this.lines.consumedByteEnd), frozenEnd);
        }
        this.observedDigest.update(receipt.bytes);
        this.digest = this.observedDigest.clone().digest();
        this.revision++;
        offset += length; first = false;
        if (offset < frozenEnd && this.options.onIntermediateSnapshot) {
          const snapshot = this.observedSnapshot(identity, frozenEnd);
          if (snapshot) await this.options.onIntermediateSnapshot(snapshot);
          signal.throwIfAborted();
        }
        progress('transferring', offset, frozenEnd);
        if (!length) break;
      }
      if (!this.parser) throw new Error('持续科学parser未准备好。');
      if (!identical) this.observed = identity;
      if (input.final && !this.final) { touched = true; this.lines.final(line => this.parser!.consume(line)); this.final = true; }
      const snapshot = this.observedSnapshot(identity, frozenEnd); this.retryRequested = false;
      return snapshot ? { kind: 'candidate', snapshot, change } : { kind: 'pending', sourceRevision: this.revision };
    } catch (error) {
      if (touched) { await this.parser?.dispose(); this.parser = null; this.blocks.clear(); this.lines = new CompleteByteLines(); this.observedDigest = new VibronicSha256(); this.observed = null; this.digest = null; this.final = false; }
      throw error;
    } finally { this.busy = false; settled(); this.inFlight = null; }
  }
  private observedSnapshot(identity: FileIdentity, frozenEnd: number): ScientificReadSnapshot<T> | null {
      const projection = this.final ? this.parser!.final() : this.parser!.snapshot();
      if (!projection) return null;
      if (!Number.isSafeInteger(projection.publishedByteEnd) || projection.publishedByteEnd < 0 || projection.publishedByteEnd > this.lines.consumedByteEnd) throw new Error('科学投影超出完整来源行。');
      const old = this.lastProjection;
      if (old?.generation === this.generation && old.version === projection.version && old.end === projection.publishedByteEnd && old.final === this.final && old.damagedAtByte === this.lines.damagedAtByte) return null;
      const bytes = this.blocks.lease(); let released = false;
      const snapshot: ScientificReadSnapshot<T> = Object.freeze({
        snapshotId: JSON.stringify([this.source.sourceId, this.source.runId, this.generation, this.revision, this.digest, projection.publishedByteEnd, projection.version, this.final]),
        identity: this.source, sourceRevision: this.revision, sourceGeneration: this.generation, parserVersion: projection.version, fileIdentity: Object.freeze({ ...identity }),
        sourceBoundary: Object.freeze({ fileIdentity: Object.freeze({ ...identity }), observedEnd: frozenEnd, consumedByteRange: Object.freeze({ start: 0, end: this.lines.consumedByteEnd }), sourceGeneration: this.generation,
          readByteRange: Object.freeze({ start: 0, end: this.blocks.size }), publishedByteRange: Object.freeze({ start: 0, end: projection.publishedByteEnd }) }),
        observedSha256: this.digest!, final: this.final, integrity: this.lines.damagedAtByte === undefined ? 'observed-prefix' : 'damaged-tail',
        ...(this.lines.damagedAtByte === undefined ? {} : { damagedAtByte: this.lines.damagedAtByte }), value: projection.value, bytes,
        dispose() { if (released) return; released = true; bytes.release(); }
      });
      this.lastProjection = { generation: this.generation, version: projection.version, end: projection.publishedByteEnd, final: this.final, damagedAtByte: this.lines.damagedAtByte };
      return snapshot;
  }
  /** Preparation failure permits a new projection attempt without consuming old lines. */
  retryPublication(): void { this.lastProjection = null; this.retryRequested = true; }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.lifetime.abort();
    this.disposal = (async () => {
      await this.inFlight;
      await this.parser?.dispose(); this.parser = null; this.blocks.clear(); this.observed = null; this.digest = null;
      this.options.onDispose?.();
    })();
    return this.disposal;
  }
}
