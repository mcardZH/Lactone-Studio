import { importStructureFiles, type StructureImportFile } from '../../core/file-import';
import type { DesktopBridge, FragmentSnapshot, OpenedModelFile } from '../contracts';
import { modelFragmentsFromStructures, parseModelFiles } from './files';
import type { ScientificSourceFile } from '../../results/input-file';

const streamed = (name: string) => /\.(out|log|fch|fchk)$/i.test(name);
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('模型导入已取消。'); };

/** A token is a bounded byte source, never a renderer-side whole-output string. */
export function desktopFile(file: OpenedModelFile, bridge: DesktopBridge, signal?: AbortSignal): StructureImportFile {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('模型文件字节数无效。');
  if (file.text !== undefined) return { name: file.name, size: file.bytes, text: async () => { aborted(signal); return file.text!; },
    stream: () => new Blob([file.text!]).stream() };
  if (!file.streamToken || !streamed(file.name) || !bridge.readFileChunk || !bridge.closeFileStream) throw new Error('桌面流式文件接口缺失或格式不匹配。');
  return { name: file.name, size: file.bytes, text: async () => { throw new Error('输出流不能完整载入文本。'); }, stream: () => {
    let offset = 0, closed = false;
    const close = async () => { if (!closed) { closed = true; signal?.removeEventListener('abort', onAbort); await bridge.closeFileStream!(file.streamToken!); } };
    let streamController: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const onAbort = () => { streamController.error(new Error('模型导入已取消。')); void close().catch(() => {}); };
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { streamController = controller; signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort(); },
      async pull(controller) {
        try {
          aborted(signal); const chunk = await bridge.readFileChunk!(file.streamToken!, offset); aborted(signal);
          if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > 256 * 1024 || chunk.offset !== offset || chunk.nextOffset !== offset + chunk.bytes.byteLength
            || chunk.nextOffset > file.bytes || chunk.done !== (chunk.nextOffset === file.bytes) || !chunk.done && !chunk.bytes.byteLength) throw new Error('桌面文件流字节范围或身份不匹配。');
          offset = chunk.nextOffset; if (chunk.bytes.length) controller.enqueue(new Uint8Array(chunk.bytes));
          if (chunk.done) { controller.close(); await close(); }
        } catch (cause) { if (!closed) controller.error(cause); await close(); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
  } };
}

export function browserFile(file: ScientificSourceFile, signal?: AbortSignal): StructureImportFile {
  if (!signal || !streamed(file.name)) return file;
  return { name: file.name, size: file.size, text: () => { aborted(signal); return file.text(); }, stream: () => {
    const reader = file.stream().getReader(); let released = false;
    const release = () => { if (!released) { released = true; signal.removeEventListener('abort', onAbort); reader.releaseLock(); } };
    let streamController: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const onAbort = () => { streamController.error(new Error('模型导入已取消。')); void reader.cancel().finally(release); };
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { streamController = controller; signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); },
      async pull(controller) {
        try { aborted(signal); const next = await reader.read(); aborted(signal); if (next.done) { controller.close(); release(); } else controller.enqueue(next.value); }
        catch (cause) { if (!released) { controller.error(cause); await reader.cancel(); release(); } }
      },
      async cancel() { await reader.cancel(); release(); },
    }, { highWaterMark: 0 });
  } };
}

export async function importModelSources(sources: File[] | OpenedModelFile[], bridge?: DesktopBridge, signal?: AbortSignal): Promise<FragmentSnapshot[]> {
  const opened = bridge ? sources as OpenedModelFile[] : null;
  try {
    aborted(signal);
    const files = opened ? opened.map(file => desktopFile(file, bridge!, signal)) : (sources as File[]).map(file => browserFile(file, signal));
    const streams = files.filter(file => streamed(file.name)), ordinary = files.filter(file => !streamed(file.name));
    const structures = streams.length ? await importStructureFiles(streams) : [];
    aborted(signal);
    const texts = await Promise.all(ordinary.map(async file => {
      aborted(signal);
      const text = await file.text(); aborted(signal); return { name: file.name, bytes: file.size, text };
    }));
    return [...modelFragmentsFromStructures(structures), ...parseModelFiles(texts)];
  } finally {
    if (opened && bridge?.closeFileStream) await Promise.all(opened.flatMap(file => file.streamToken ? [bridge.closeFileStream!(file.streamToken).catch(() => ({ closed: false }))] : []));
  }
}
