import { assertResultNotAborted, type ResultDiagnostic, type ResultDiagnosticSnapshot } from '../results/contracts';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';

export const DIAGNOSTIC_CHUNK_BYTES = 8 * 1024 ** 2;
export interface DiagnosticProjectSnapshot {
  schema: 1; data: ResultDiagnosticSnapshot;
  raw: { size: number; chunks: { assetId: string; bytes: number }[] };
}
export function diagnosticMetadata(value: ResultDiagnostic): ResultDiagnosticSnapshot {
  const { dispose: _dispose, readSourceRange: _read, ...data } = value;
  return structuredClone(data);
}
function validRange(start: number, end: number, size: number) {
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > size || end - start > 64 * 1024 ** 2) throw new Error('诊断来源读取范围无效。');
}
/** The legacy geometry reader releases its source after this callback. Copy
 * original bytes once per source, without decoding BOM, CRLF or numeric text. */
export async function retainDiagnosticSources(items: readonly ResultDiagnostic[], signal?: AbortSignal, guard: () => void = () => {}): Promise<ResultDiagnostic[]> {
  const sources = new Map<string, { size: number; name: string; chunks: Uint8Array[]; users: number }>();
  for (const item of items) {
    assertResultNotAborted(signal); guard();
    const previous = sources.get(item.source.id);
    if (previous) { if (previous.size !== item.source.size || previous.name !== item.source.name) throw new Error('诊断来源身份冲突。'); previous.users++; continue; }
    const source = { size: item.source.size, name: item.source.name, chunks: [] as Uint8Array[], users: 1 };
    sources.set(item.source.id, source);
    for (let start = 0; start < source.size; start += DIAGNOSTIC_CHUNK_BYTES) {
      const end = Math.min(source.size, start + DIAGNOSTIC_CHUNK_BYTES), bytes = await item.readSourceRange(start, end, signal);
      assertResultNotAborted(signal); guard();
      if (bytes.byteLength !== end - start) throw new Error('诊断原始来源长度发生变化。');
      source.chunks.push(bytes.slice());
    }
  }
  return items.map(item => {
    const source = sources.get(item.source.id)!; let closed = false;
    return { ...diagnosticMetadata(item), async readSourceRange(start, end, readSignal) {
      assertResultNotAborted(readSignal); if (closed) throw new Error('诊断来源已关闭。'); validRange(start, end, source.size);
      const bytes = new Uint8Array(end - start);
      for (let offset = start; offset < end;) { const index = Math.floor(offset / DIAGNOSTIC_CHUNK_BYTES), part = source.chunks[index], local = offset % DIAGNOSTIC_CHUNK_BYTES, count = Math.min(end - offset, part.length - local); bytes.set(part.subarray(local, local + count), offset - start); offset += count; }
      return bytes;
    }, dispose() { if (closed) return; closed = true; if (--source.users === 0) source.chunks.length = 0; } };
  });
}
export async function encodeDiagnostic(value: ResultDiagnostic, writer: ProjectAssetWriter): Promise<DiagnosticProjectSnapshot> {
  const data = diagnosticMetadata(value), chunks: DiagnosticProjectSnapshot['raw']['chunks'] = [];
  for (let start = 0; start < data.source.size; start += DIAGNOSTIC_CHUNK_BYTES) {
    const end = Math.min(data.source.size, start + DIAGNOSTIC_CHUNK_BYTES), bytes = await value.readSourceRange(start, end);
    if (bytes.byteLength !== end - start) throw new Error('诊断原始来源长度发生变化。');
    chunks.push({ ...(await writer.write('sources', data.source.name, bytes)), bytes: bytes.byteLength });
  }
  if (JSON.stringify(value.source) !== JSON.stringify(data.source)) throw new Error('保存期间诊断来源身份已变化。');
  return { schema: 1, data, raw: { size: data.source.size, chunks } };
}
/** Restoring metadata never re-parses the source or starts scientific work. */
export function decodeDiagnostic(snapshot: DiagnosticProjectSnapshot, reader: ProjectAssetReader): ResultDiagnostic {
  if (snapshot.schema !== 1 || snapshot.data.kind !== 'diagnostic' || !Number.isSafeInteger(snapshot.raw.size) || snapshot.raw.size < 0 || snapshot.raw.size !== snapshot.data.source.size || !snapshot.raw.chunks.every(part => typeof part.assetId === 'string' && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= DIAGNOSTIC_CHUNK_BYTES) || snapshot.raw.chunks.reduce((sum, part) => sum + part.bytes, 0) !== snapshot.raw.size) throw new Error('项目诊断来源索引无效。');
  const data = structuredClone(snapshot.data), raw = structuredClone(snapshot.raw); let closed = false;
  return { ...data, async readSourceRange(start, end, signal) {
    assertResultNotAborted(signal); if (closed) throw new Error('诊断来源已关闭。'); validRange(start, end, raw.size);
    const output = new Uint8Array(end - start); let offset = 0;
    for (const part of raw.chunks) {
      const next = offset + part.bytes;
      if (next > start && offset < end) {
        const bytes = await reader.read(part.assetId); assertResultNotAborted(signal);
        if (closed || bytes.byteLength !== part.bytes) throw new Error('项目诊断来源分块损坏或已关闭。');
        const first = Math.max(start, offset), last = Math.min(end, next); output.set(bytes.subarray(first - offset, last - offset), first - start);
      }
      offset = next;
    }
    return output;
  }, dispose() { closed = true; } };
}
