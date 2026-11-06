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

/** Decode only LF-complete lines. CRLF and UTF-8 may cross arbitrary byte chunks. */
export class CompleteByteLines {
  private tail = new Uint8Array(0);
  private offset = 0;
  private line = 0;
  private ended = false;
  private damaged: number | undefined;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  get consumedByteEnd(): number { return this.offset; }
  get damagedAtByte(): number | undefined { return this.damaged; }
  append(bytes: Uint8Array, consume: (line: import('./contracts').MonitorLine) => void): void {
    if (this.ended) throw new Error('来源行读取已结束。');
    if (this.damaged !== undefined) return;
    const chunk = new Uint8Array(this.tail.length + bytes.length);
    chunk.set(this.tail); chunk.set(bytes, this.tail.length);
    let start = 0;
    for (let at = 0; at < chunk.length; at++) {
      if (chunk[at] === 0) { this.damaged = this.offset + at - start; this.tail = new Uint8Array(0); return; }
      if (chunk[at] !== 10) continue;
      const contentEnd = at > start && chunk[at - 1] === 13 ? at - 1 : at;
      let text: string;
      try { text = this.decoder.decode(chunk.subarray(start, contentEnd)); }
      catch { this.damaged = this.offset; this.tail = new Uint8Array(0); return; }
      if (this.line === 0) text = text.replace(/^\uFEFF/, '');
      const end = this.offset + at + 1 - start;
      consume({ text, start: this.offset, end, number: ++this.line });
      this.offset = end; start = at + 1;
    }
    this.tail = chunk.slice(start);
  }
  final(consume: (line: import('./contracts').MonitorLine) => void): void {
    if (this.ended) return;
    this.ended = true;
    if (this.damaged !== undefined || !this.tail.length) return;
    let text: string;
    try { text = this.decoder.decode(this.tail).replace(/\r$/, ''); }
    catch { this.damaged = this.offset; this.tail = new Uint8Array(0); return; }
    if (this.line === 0) text = text.replace(/^\uFEFF/, '');
    const end = this.offset + this.tail.length;
    consume({ text, start: this.offset, end, number: ++this.line });
    this.offset = end; this.tail = new Uint8Array(0);
  }
}
