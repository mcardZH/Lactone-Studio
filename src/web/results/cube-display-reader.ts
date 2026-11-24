import { assertResultNotAborted } from '../../results/contracts';
import { CubeReadError, readMolecularCube, type CubeReadOptions, type DisplayCubeData, type DisplayCubeRead, type ParsedMolecularCube } from '../../results/cube-reader';

export const CUBE_PAGE_BYTES = 64 * 1024;

export function cubeByteStream(size: number, read: (offset: number, length: number) => Promise<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let offset = 0, cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      assertResultNotAborted(signal);
      if (offset === size) { controller.close(); return; }
      const length = Math.min(size - offset, CUBE_PAGE_BYTES), bytes = await read(offset, length);
      if (cancelled) return;
      assertResultNotAborted(signal);
      if (bytes.byteLength !== length) throw new Error('Cube 来源分页长度与声明不符。');
      offset += bytes.byteLength;
      controller.enqueue(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
}

export function readDisplayCubeStream(source: { size: number; stream: () => ReadableStream<Uint8Array> }, options: CubeReadOptions = {}, signal?: AbortSignal): Promise<ParsedMolecularCube> {
  options = { ...options, sharedValues: Boolean(globalThis.crossOriginIsolated) };
  const fallback = () => readMolecularCube(source, { ...options, signal, yieldToHost: true });
  return new Promise((resolve, reject) => {
    assertResultNotAborted(signal);
    let worker: Worker | undefined;
    const clean = () => { worker?.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('已取消读取 Cube。', 'AbortError')); };
    if (typeof Worker !== 'function') { fallback().then(resolve, reject); return; }
    try {
      worker = new Worker(new URL('./cube-display-worker.ts', import.meta.url), { type: 'module' });
    } catch { fallback().then(resolve, reject); return; }
    worker.onmessage = (event: MessageEvent<{ parsed?: ParsedMolecularCube; error?: string; code?: CubeReadError['code'] }>) => {
      clean();
      const { parsed, error, code } = event.data;
      if (!parsed) { reject(code ? new CubeReadError(code, error ?? '') : new Error(error ?? 'Cube读取回执为空。')); return; }
      resolve(parsed);
    };
    worker.onerror = event => { event.preventDefault(); clean(); reject(new Error(event.message || 'Cube 解析进程异常结束，来源保留。')); };
    worker.onmessageerror = () => { clean(); reject(new Error('Cube 解析回执无法读取，来源保留。')); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const stream = source.stream();
      worker.postMessage({ stream, size: source.size, options }, [stream]);
    } catch (error) {
      clean();
      if (error instanceof DOMException && error.name === 'DataCloneError') fallback().then(resolve, reject);
      else reject(error);
    }
  });
}

/** Compatibility path for the old text transport. The current restore path
 * supplies byte ranges directly and has no full-source UTF-8 string. */
export async function readDisplayCube(request: DisplayCubeRead, signal?: AbortSignal, options: CubeReadOptions={}): Promise<DisplayCubeData> {
  assertResultNotAborted(signal);
  const originalBytes = new TextEncoder().encode(request.text);
  if (originalBytes.byteLength !== request.bytes) throw new CubeReadError('invalid', 'Cube快照字节数与可信来源不符。');
  const parsed = await readDisplayCubeStream({ size: request.bytes, stream: () => cubeByteStream(request.bytes,
    async (offset, length) => originalBytes.subarray(offset, offset + length), signal) }, options, signal);
  return { parsed, ...(request.keepOriginal ? { originalBytes } : {}) };
}
