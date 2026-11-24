import type { RetainedSourceBytes } from './contracts';

interface ByteChunk { start: number; end: number; bytes: Uint8Array }
/** A chunk is copied once at the transport boundary. Append shares older byte blocks. */
export class SourceByteBlocks {
  private chunks: ByteChunk[] = [];
  private length = 0;
  get size(): number { return this.length; }
  append(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.chunks.push({ start: this.length, end: this.length + bytes.length, bytes: bytes.slice() });
    this.length += bytes.length;
  }
  lease(): RetainedSourceBytes {
    const state = { chunks: this.chunks.slice(), size: this.length, refs: 0 };
    const handle = (): RetainedSourceBytes => {
      state.refs++;
      let released = false;
      return {
        size: state.size,
        retain() { if (released) throw new Error('来源字节租约已释放。'); return handle(); },
        async readRange(start, end, signal) {
          signal?.throwIfAborted();
          if (released) throw new Error('来源字节租约已释放。');
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > state.size) throw new Error('来源字节范围越界。');
          const result = new Uint8Array(end - start);
          for (const chunk of state.chunks) {
            if (chunk.end <= start) continue;
            if (chunk.start >= end) break;
            const a = Math.max(start, chunk.start), b = Math.min(end, chunk.end);
            result.set(chunk.bytes.subarray(a - chunk.start, b - chunk.start), a - start);
          }
          signal?.throwIfAborted();
          return result;
        },
        release() { if (released) return; released = true; if (--state.refs === 0) state.chunks = []; }
      };
    };
    return handle();
  }
  clear(): void { this.chunks = []; this.length = 0; }
}

export { CompleteByteLines } from '../../results/byte-text-lines';
