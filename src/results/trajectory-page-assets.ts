import { assertResultNotAborted } from './contracts';

export interface TrajectoryBinaryAssetPort {
  beginBinaryAsset(expectedBytes?: number): Promise<{ id: string }>;
  appendBinaryAsset(id: string, bytes: ArrayBuffer | Uint8Array): Promise<{ size: number }>;
  sealBinaryAsset(id: string): Promise<{ size: number }>;
  readBinaryAsset(id: string, offset: number, length: number): Promise<ArrayBuffer>;
  releaseBinaryAsset(id: string): Promise<void>;
}

export function trajectoryBinaryAssetPort(): TrajectoryBinaryAssetPort | undefined {
  const host = (globalThis as { sciyueDesktop?: Partial<TrajectoryBinaryAssetPort> }).sciyueDesktop;
  if (!host?.beginBinaryAsset || !host.appendBinaryAsset || !host.sealBinaryAsset || !host.readBinaryAsset || !host.releaseBinaryAsset) return;
  return host as TrajectoryBinaryAssetPort;
}

/** Transfer granularity only. A scientific frame or complete asset can cross any number of pages. */
const pageBytes = 1024 * 1024;
export interface TrajectoryByteRange { offset: number; length: number }

/** One writer, exact acknowledged ranges, retryable release. Pending bytes
 * stay readable during preparation, before the final seal. */
export class TrajectoryPageAsset {
  private id?: string;
  private committed = 0;
  private pendingLength = 0;
  private buffer?: Uint8Array<ArrayBuffer>;
  private tail = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private failure?: unknown;
  private reads = new Set<Promise<unknown>>();

  constructor(private readonly port: TrajectoryBinaryAssetPort) {}
  get length() { return this.committed + this.pendingLength; }
  get committedLength() { return this.committed; }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      if (this.failure !== undefined) throw this.failure;
      return action();
    });
    this.tail = work.then(() => undefined, error => { this.failure = error; });
    return work;
  }

  private async flush() {
    if (!this.pendingLength) return;
    this.id ??= (await this.port.beginBinaryAsset()).id;
    const expected = this.committed + this.pendingLength;
    const receipt = await this.port.appendBinaryAsset(this.id, this.buffer!.subarray(0, this.pendingLength));
    if (receipt.size !== expected) throw Error('轨迹暂存页写入回执缺少已确认字节。');
    this.committed = expected;
    this.pendingLength = 0;
  }

  append(pieces: readonly Uint8Array[]): Promise<TrajectoryByteRange> {
    if (this.closed) return Promise.reject(Error('轨迹准备暂存已关闭。'));
    return this.serial(async () => {
      const offset = this.length;
      this.buffer ??= new Uint8Array(pageBytes);
      for (const bytes of pieces) {
        for (let read = 0; read < bytes.length;) {
          const size = Math.min(bytes.length - read, pageBytes - this.pendingLength);
          this.buffer.set(bytes.subarray(read, read + size), this.pendingLength);
          read += size; this.pendingLength += size;
          if (this.pendingLength === pageBytes) await this.flush();
        }
      }
      return { offset, length: this.length - offset };
    });
  }

  read(range: TrajectoryByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed) return Promise.reject(Error('轨迹准备暂存已关闭。'));
    // A canceled consumer must not poison the shared immutable asset.
    const work = this.tail.then(async () => {
      assertResultNotAborted(signal);
      const { offset, length } = range, committed = this.committed;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.length) throw Error('轨迹准备页范围无效。');
      const output = new Uint8Array(length);
      const diskLength = Math.max(0, Math.min(length, committed - offset));
      if (diskLength < length) output.set(this.buffer!.subarray(Math.max(0, offset - committed), offset + length - committed), diskLength);
      for (let at = 0; at < diskLength;) {
        const size = Math.min(pageBytes, diskLength - at);
        const bytes = await this.port.readBinaryAsset(this.id!, offset + at, size);
        assertResultNotAborted(signal);
        if (bytes.byteLength !== size) throw Error('轨迹准备页读取字节不完整。');
        output.set(new Uint8Array(bytes), at);
        at += size;
      }
      return output;
    });
    this.reads.add(work);
    void work.finally(() => { this.reads.delete(work); }).catch(() => undefined);
    return work;
  }

  commit(): Promise<void> { return this.serial(() => this.flush()); }

  seal(): Promise<void> {
    if (this.closed) return Promise.reject(Error('轨迹准备暂存已关闭。'));
    return this.serial(async () => {
      await this.flush();
      if (this.id && (await this.port.sealBinaryAsset(this.id)).size !== this.committed) throw Error('轨迹准备页终态字节不完整。');
      this.buffer = undefined;
    });
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const work = this.tail.then(async () => {
      await Promise.allSettled(this.reads);
      this.buffer = undefined;
      if (this.id) { await this.port.releaseBinaryAsset(this.id); this.id = undefined; }
    });
    this.closing = work.finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
