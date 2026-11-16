import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from './contracts';
import { GaussianOutputSections, type GaussianOutputSection } from './gaussian-output-archive';
import type { ScientificLine } from './scientific-contracts';

/** Streaming line splitter retaining byte offsets, including UTF-8 and CRLF across chunks. */
export async function* outputLines(file: Pick<ResultInputFile, 'stream' | 'size'>, options: ResultReadOptions, onDamagedTail?: (sourceLine: number, reason: 'NUL' | '非法UTF-8') => void): AsyncGenerator<ScientificLine> {
  const reader = file.stream().getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  let parts: Uint8Array[] = [], pendingLength = 0;
  let offset = 0, lineNumber = 0, bytes = 0, nextYield = performance.now() + 16;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (last: Uint8Array): string | null => {
    let row = last;
    if (parts.length) {
      row = new Uint8Array(pendingLength + last.length);
      let copied = 0;
      for (const part of parts) { row.set(part, copied); copied += part.length; }
      row.set(last, copied);
      parts = []; pendingLength = 0;
    }
    try {
      const text = decoder.decode(row).replace(/\r$/, '');
      return lineNumber === 0 ? text.replace(/^\uFEFF/, '') : text;
    } catch (error) {
      if (!onDamagedTail) throw error;
      onDamagedTail(lineNumber + 1, '非法UTF-8');
      return null;
    }
  };
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const { done, value } = await reader.read();
      assertResultNotAborted(options.signal);
      if (done) break;
      const chunkOffset = bytes;
      bytes += value.length;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        if (onDamagedTail && value[index] === 0) { onDamagedTail(lineNumber + 1, 'NUL'); return; }
        if (value[index] !== 10) continue;
        const text = decode(value.subarray(start, index));
        if (text === null) return;
        const end = chunkOffset + index + 1;
        yield { text, start: offset, end, number: ++lineNumber };
        offset = end; start = index + 1;
        if (lineNumber % 1024 === 0 && performance.now() >= nextYield) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          assertResultNotAborted(options.signal);
          nextYield = performance.now() + 16;
        }
      }
      if (start < value.length) {
        parts.push(value.subarray(start));
        pendingLength += value.length - start;
      }
      options.onProgress?.(bytes, file.size);
    }
    if (bytes !== file.size) throw new Error('输出来源读取长度发生变化。');
    if (pendingLength) {
      const text = decode(new Uint8Array(0));
      if (text === null) return;
      yield { text, start: offset, end: bytes, number: ++lineNumber };
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* The source may already be closed. */ }
    reader.releaseLock();
  }
}

/** Body and, when requested, the first physical row of a complete input route.
 * Auxiliary scientific readers retain original source line and byte anchors. */
export async function* gaussianOutputLines(file: ResultInputFile, options: ResultReadOptions, includeRoute = false): AsyncGenerator<ScientificLine> {
  const sections = new GaussianOutputSections<ScientificLine>();
  const ready: ScientificLine[] = [];
  const collect = (section: GaussianOutputSection<ScientificLine>) => {
    if (section.kind === 'body' || (includeRoute && section.kind === 'route' && section.text !== null)) ready.push(section.line);
  };
  for await (const line of outputLines(file, options, () => undefined)) {
    sections.consume(line, collect);
    yield* ready;
    ready.length = 0;
  }
  sections.finish(collect);
  yield* ready;
}
