export type ResultTextEncoding = 'utf-8' | 'utf-16le';
export type DamagedText = 'NUL' | '非法UTF-8' | '非法UTF-16LE';

export function resultTextEncoding(prefix: Uint8Array): ResultTextEncoding {
  return prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le' : 'utf-8';
}
export function decodeResultText(bytes: Uint8Array, encoding: ResultTextEncoding = 'utf-8'): string {
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
}
export async function readFileTextEncoding(
  file: {size: number; readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>}, signal?: AbortSignal,
): Promise<ResultTextEncoding> {
  const end = Math.min(file.size, 2), bytes = await file.readRange(0, end, signal);
  signal?.throwIfAborted();
  if (bytes.length !== end) throw new Error('读取来源编码时文件长度发生变化。');
  return resultTextEncoding(bytes);
}

type ByteLine = { text: string; start: number; end: number; number: number };
type Consume = (line: ByteLine) => void;

/** Delimit physical source bytes before decoding. Carry only a partial code
 * unit, a possible CRLF boundary and the current line across reads. */
export class CompleteByteLines {
  private decoder?: TextDecoder;
  private encoding?: ResultTextEncoding;
  private remainder = new Uint8Array(0);
  private parts: Uint8Array[] = [];
  private length = 0;
  private scanned = 0;
  private offset = 0;
  private line = 0;
  private cr = false;
  private ended = false;
  private damaged?: { offset: number; reason: DamagedText };

  constructor(encoding?: ResultTextEncoding) { this.encoding = encoding; }
  get textEncoding(): ResultTextEncoding | undefined { return this.encoding; }
  get consumedByteEnd(): number { return this.offset; }
  get damagedAtByte(): number | undefined { return this.damaged?.offset; }
  get damageReason(): DamagedText | undefined { return this.damaged?.reason; }
  get damagedLine(): number | undefined { return this.damaged ? this.line + 1 : undefined; }

  private fail(offset: number, reason: DamagedText): void {
    this.damaged = { offset, reason };
    this.parts = []; this.length = 0; this.remainder = new Uint8Array(0);
  }
  private add(bytes: Uint8Array): void {
    if (bytes.length) { this.parts.push(bytes); this.length += bytes.length; }
  }
  private emit(end: number, last: Uint8Array, consume: Consume): boolean {
    let row = last;
    if (this.parts.length) {
      row = new Uint8Array(this.length + last.length);
      let written = 0;
      for (const part of this.parts) { row.set(part, written); written += part.length; }
      row.set(last, written);
      this.parts = []; this.length = 0;
    }
    let text: string;
    try { text = this.decoder!.decode(row); }
    catch {
      this.fail(this.offset, this.encoding === 'utf-16le' ? '非法UTF-16LE' : '非法UTF-8');
      return false;
    }
    if (this.line === 0) text = text.replace(/^\uFEFF/, '');
    consume({ text, start: this.offset, end, number: ++this.line });
    this.offset = end;
    return true;
  }
  append(bytes: Uint8Array, consume: Consume): void {
    if (this.ended) throw new Error('来源行读取已结束。');
    if (this.damaged || !bytes.length) return;
    if (this.remainder.length) {
      const joined = new Uint8Array(this.remainder.length + bytes.length);
      joined.set(this.remainder); joined.set(bytes, this.remainder.length);
      bytes = joined;
      this.remainder = new Uint8Array(0);
    }
    if (!this.encoding && bytes.length < 2) { this.remainder = Uint8Array.from(bytes); return; }
    this.encoding ??= resultTextEncoding(bytes);
    this.decoder ??= new TextDecoder(this.encoding, { fatal: true, ignoreBOM: true });
    const width = this.encoding === 'utf-16le' ? 2 : 1;
    const end = bytes.length - bytes.length % width;
    if (!end) { this.remainder = Uint8Array.from(bytes); return; }
    const base = this.scanned, empty = bytes.subarray(0, 0);
    const codeAt = width === 2 ? (at: number) => bytes[at] | bytes[at + 1] << 8 : (at: number) => bytes[at];
    let begin = 0;
    if (this.cr) {
      if (codeAt(0) === 10) begin = width;
      this.cr = false;
      if (!this.emit(base + begin, empty, consume)) return;
    }
    for (let at = begin; at < end; at += width) {
      const code = codeAt(at);
      if (code === 0) { this.fail(base + at, 'NUL'); return; }
      if (code !== 10 && code !== 13) continue;
      let after = at + width;
      if (code === 13 && after === end) {
        this.add(Uint8Array.from(bytes.subarray(begin, at)));
        begin = after;
        this.cr = true;
        break;
      }
      if (code === 13 && codeAt(after) === 10) after += width;
      if (!this.emit(base + after, bytes.subarray(begin, at), consume)) return;
      begin = after;
      at = after - width;
    }
    this.add(Uint8Array.from(bytes.subarray(begin, end)));
    this.scanned += end;
    if (end !== bytes.length) this.remainder = Uint8Array.from(bytes.subarray(end));
  }
  final(consume: Consume): void {
    if (this.ended) return;
    if (!this.encoding && this.remainder.length) {
      const first = this.remainder;
      this.remainder = new Uint8Array(0);
      this.encoding = 'utf-8';
      this.append(first, consume);
    }
    this.ended = true;
    if (this.damaged) return;
    if (this.cr && !this.emit(this.scanned, new Uint8Array(0), consume)) return;
    if (this.remainder.length) { this.fail(this.scanned, '非法UTF-16LE'); return; }
    if (this.length) this.emit(this.scanned, new Uint8Array(0), consume);
  }
}
