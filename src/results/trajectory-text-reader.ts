import { CompleteByteLines } from './byte-text-lines';
import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from './contracts';

export async function abortableResultRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertResultNotAborted(signal);
  if (!signal) return promise;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('读取已取消。', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export interface TrajectoryTextLine { text: string; start: number; end: number; number: number }

const retainedTextEncoder = new TextEncoder();
const retainedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** Keep a small source-derived field independent from the full decoded chunk. */
export function ownTrajectoryText(text: string): string {
  return retainedTextDecoder.decode(retainedTextEncoder.encode(text));
}

class Utf8TrajectoryLines {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private parts: Uint8Array[] = [];
  private length = 0;
  private position = 0;
  private line = 0;

  constructor(private readonly consume: (line: TrajectoryTextLine) => void) {}

  private emit(text: string, start: number, end: number) {
    if (text.includes('\0')) throw new Error(`来源第${this.line + 1}行包含NUL。`);
    if (!this.line && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    this.consume({ text, start: this.position + start, end: this.position + end, number: ++this.line });
  }

  private decodeBlock(bytes: Uint8Array): void {
    let text: string;
    try { text = this.decoder.decode(bytes); }
    catch {
      // A malformed suffix must not take complete, earlier rows out of this block.
      const prefix = new CompleteByteLines('utf-8');
      const consume = (line: TrajectoryTextLine) => this.emit(line.text, line.start, line.end);
      prefix.append(bytes, consume);
      prefix.final(consume);
      throw new Error(`来源第${this.line + 1}行包含${prefix.damageReason ?? '非法UTF-8'}。`);
    }
    const newline = /\r\n?|\n/g;
    let character = 0, byte = 0;
    for (let match = newline.exec(text); match; match = newline.exec(text)) {
      const end = bytes.indexOf(match[0].charCodeAt(0), byte) + match[0].length;
      this.emit(text.slice(character, match.index), byte, end);
      character = newline.lastIndex;
      byte = end;
    }
    if (character < text.length) this.emit(text.slice(character), byte, bytes.length);
    this.position += bytes.length;
  }

  append(input: Uint8Array, final = false): void {
    let end = input.length;
    if (!final) {
      const last = Math.max(input.lastIndexOf(10), input.lastIndexOf(13));
      // A CR at the end may be followed by LF in the next chunk.
      end = last >= 0 && last === input.length - 1 && input[last] === 13
        ? Math.max(input.lastIndexOf(10, last - 1), input.lastIndexOf(13, last - 1)) + 1 : last + 1;
      if (last === 0 && input.length === 1 && input[0] === 13) end = 0;
    }
    if (end || (final && this.length)) {
      let block = input.subarray(0, end);
      if (this.length) {
        block = new Uint8Array(this.length + end);
        let at = 0;
        for (const part of this.parts) { block.set(part, at); at += part.length; }
        block.set(input.subarray(0, end), at);
        this.parts = []; this.length = 0;
      }
      this.decodeBlock(block);
    }
    if (end < input.length) {
      const tail = input.slice(end);
      this.parts.push(tail);
      this.length += tail.length;
    }
  }
}

/** Read physical UTF-8 lines exactly once with bounded work per browser turn. */
export async function consumeTrajectoryText(file: ResultInputFile, options: ResultReadOptions, consume: (line: TrajectoryTextLine) => void,
  settleBlock?:()=>void|Promise<void>): Promise<void> {
  assertResultNotAborted(options.signal);
  const scanner = new Utf8TrajectoryLines(consume);
  const reader = file.stream().getReader();
  let total = 0, done = false, scheduledAt = performance.now();
  try {
    for (;;) {
      const next = await abortableResultRead(reader.read(), options.signal);
      assertResultNotAborted(options.signal);
      if (next.done) { done = true; break; }
      const bytes = next.value;
      for (let offset = 0; offset < bytes.length;) {
        const initialPreviewSlice = options.signal && total === 0 && offset === 0 && bytes.length > 1024;
        const end = Math.min(bytes.length, offset + (initialPreviewSlice ? 1024 : 256 * 1024));
        scanner.append(bytes.subarray(offset, end));
        await settleBlock?.();
        offset = end;
        if (initialPreviewSlice || (options.signal && performance.now() - scheduledAt >= 16)) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          assertResultNotAborted(options.signal);
          scheduledAt = performance.now();
        }
      }
      total += bytes.length;
      options.onProgress?.(total, file.size);
    }
    scanner.append(new Uint8Array(0), true);
    if (total !== file.size) throw new Error('来源读取长度发生变化。');
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
