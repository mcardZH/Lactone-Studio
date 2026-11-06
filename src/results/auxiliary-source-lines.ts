import { outputLines } from './optimization-reader';
import type { ResultInputFile, ResultReadOptions } from './contracts';
import { VibronicSha256 } from '../core/gaussian-vibronic/sha256-stream';

/** Retain complete decoded lines only. The original lease owns byte access;
 * scientific rows never require a second whole-file byte array or a text JSON. */
export async function readAuxiliarySourceLines(file: ResultInputFile, options: ResultReadOptions, expectedPrefix?: Uint8Array): Promise<{ lines: string[]; sha256?: string; interruption?: string }> {
  const lines: string[] = [];
  let damaged: number | undefined;
  let bytes = 0; const hash = new VibronicSha256();
  const input = { ...file, stream: () => file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    if (expectedPrefix) for (let index = 0; index < Math.min(chunk.length, expectedPrefix.length - bytes); index++) if (chunk[index] !== expectedPrefix[bytes + index]) throw new Error('辅助来源识别后内容发生变化。');
    bytes += chunk.length; hash.update(chunk); controller.enqueue(chunk);
  } })) };
  try {
    for await (const line of outputLines(input, options, sourceLine => { damaged = sourceLine; })) {
      lines.push(line.text);
    }
  } catch (error) {
    if (!lines.length) throw error;
    return { lines, interruption: options.signal?.aborted ? `读取已取消；保留此前${lines.length}个完整文本行。` : `源行${lines.length + 1}读取失败；保留此前完整文本行：${error instanceof Error ? error.message : String(error)}` };
  }
  if (damaged === undefined && bytes !== file.size) throw new Error('辅助来源读取长度发生变化。');
  return { lines, ...(bytes === file.size ? { sha256: hash.digest() } : {}), ...(damaged === undefined ? {} : { interruption: `源行${damaged}含NUL损坏；仅保留此前完整文本行。` }) };
}
