import { assertResultNotAborted, type ResultInputFile } from './contracts';

/** The range transport bounds one message, never a whole structure or source. */
export async function readResultSourceRange(file: ResultInputFile, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  assertResultNotAborted(signal);
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > file.size) throw new Error('来源字节范围无效。');
  const chunkBytes = 256 * 1024;
  if (end - start <= chunkBytes) return file.readRange(start, end, signal);
  const bytes = new Uint8Array(end - start);
  for (let offset = start; offset < end; offset += chunkBytes) {
    assertResultNotAborted(signal);
    const next = Math.min(end, offset + chunkBytes), chunk = await file.readRange(offset, next, signal);
    assertResultNotAborted(signal);
    if (chunk.length !== next - offset) throw new Error('来源字节读取不完整。');
    bytes.set(chunk, offset - start);
  }
  return bytes;
}
