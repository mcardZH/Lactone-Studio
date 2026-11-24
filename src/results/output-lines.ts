import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from './contracts';
import { GaussianOutputSections, type GaussianOutputSection } from './gaussian-output-archive';
import type { ScientificLine } from './scientific-contracts';
import { CompleteByteLines, type DamagedText, type ResultTextEncoding } from './byte-text-lines';

/** Source offsets are raw byte offsets regardless of encoding or newline convention. */
export async function* outputLines(file: Pick<ResultInputFile, 'stream' | 'size'>, options: ResultReadOptions,
  onDamagedTail?: (sourceLine: number, reason: DamagedText) => void, encoding?: ResultTextEncoding,
  onEncoding?: (encoding: ResultTextEncoding) => void,
): AsyncGenerator<ScientificLine> {
  const reader = file.stream().getReader(), lines = new CompleteByteLines(encoding);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const ready: ScientificLine[] = [], receive = (line: ScientificLine) => ready.push(line);
  let bytes = 0, nextYield = performance.now() + 16;
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const { done, value } = await reader.read();
      assertResultNotAborted(options.signal);
      if (done) {
        if (bytes !== file.size) throw new Error('输出来源读取长度发生变化。');
        lines.final(receive);
      } else {
        bytes += value.length;
        lines.append(value, receive);
      }
      if (!encoding && lines.textEncoding) { encoding = lines.textEncoding; onEncoding?.(encoding); }
      for (const line of ready) {
        yield line;
        if (line.number % 1024 === 0 && performance.now() >= nextYield) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          assertResultNotAborted(options.signal);
          nextYield = performance.now() + 16;
        }
      }
      ready.length = 0;
      if (lines.damageReason) {
        if (!onDamagedTail) throw new Error(`源行${lines.damagedLine}含${lines.damageReason}损坏。`);
        onDamagedTail(lines.damagedLine!, lines.damageReason);
        return;
      }
      if (done) break;
      options.onProgress?.(bytes, file.size);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* The source may already be closed. */ }
    reader.releaseLock();
  }
}

/** Body and, when requested, the first physical row of a complete input route. */
export async function* gaussianOutputLines(file: ResultInputFile, options: ResultReadOptions, includeRoute = false,
  encoding?: ResultTextEncoding,
): AsyncGenerator<ScientificLine> {
  const sections = new GaussianOutputSections<ScientificLine>();
  const ready: ScientificLine[] = [];
  const collect = (section: GaussianOutputSection<ScientificLine>) => {
    if (section.kind === 'body' || (includeRoute && section.kind === 'route' && section.text !== null)) ready.push(section.line);
  };
  for await (const line of outputLines(file, options, () => undefined, encoding)) {
    sections.consume(line, collect);
    yield* ready;
    ready.length = 0;
  }
  sections.finish(collect);
  yield* ready;
}
