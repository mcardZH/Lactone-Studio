import { retainAnalysisOriginalCube, retainAnalysisProjectSnapshot, type AnalysisOriginalCubeSource } from '../../projects/analysis-state';
import { assertResultNotAborted } from '../../results/contracts';
import type { CubeReadOptions, ParsedMolecularCube } from '../../results/cube-reader';
import type { SurfaceCubeAssetRegisterRequest, SurfaceCubeReceipt, SurfaceCubeRegisterRequest, SurfaceImportedCube, SurfaceScalarField } from '../../results/surface-contracts';
import { CUBE_PAGE_BYTES, cubeByteStream, readDisplayCube, readDisplayCubeStream } from './cube-display-reader';

export interface CubeAssetDesktop {
  beginBinaryAsset?(expectedBytes?: number): Promise<{ id: string }>;
  appendBinaryAsset?(id: string, bytes: Uint8Array): Promise<{ size: number }>;
  sealBinaryAsset?(id: string): Promise<{ size: number; sha256?: string }>;
  readBinaryAsset?(id: string, offset: number, length: number): Promise<ArrayBuffer>;
  releaseBinaryAsset?(id: string): Promise<void>;
  registerSurfaceCubeAsset?(request: SurfaceCubeAssetRegisterRequest): Promise<SurfaceCubeReceipt>;
  describeRegisteredSurfaceCube?(token: string): Promise<SurfaceCubeReceipt>;
  readRegisteredSurfaceCubePage?(token: string, offset: number, length: number): Promise<ArrayBuffer>;
  registerSurfaceCube?(request: SurfaceCubeRegisterRequest): Promise<SurfaceImportedCube>;
  readRegisteredSurfaceCube?(token: string): Promise<SurfaceImportedCube>;
  releaseSurfaceCube?(token: string): Promise<{ released: boolean }>;
}

/** Upload each archived byte once, in parser order. The sealed native source
 * and the typed output both attest the same source, without a full text blob. */
export async function restoreOriginalCubeAsset(desktop: CubeAssetDesktop, source: AnalysisOriginalCubeSource, signal: AbortSignal): Promise<{ receipt: SurfaceCubeReceipt; parsed: ParsedMolecularCube }> {
  const options = cubeOptions(source.fieldMetadata.grid.coordinateUnit);
  let receipt: SurfaceCubeReceipt | undefined;
  try {
    if (desktop.beginBinaryAsset && desktop.appendBinaryAsset && desktop.sealBinaryAsset && desktop.releaseBinaryAsset && desktop.registerSurfaceCubeAsset) {
      const { id } = await desktop.beginBinaryAsset(source.bytes);
      let adopted = false;
      try {
        // The upload is a single deterministic read. Complete it before
        // launching the parser so a worker can never restart an append stream.
        for (let offset = 0; offset < source.bytes; offset += CUBE_PAGE_BYTES) {
          assertResultNotAborted(signal);
          const length = Math.min(CUBE_PAGE_BYTES, source.bytes - offset), range = await source.readRange(offset, length);
          assertResultNotAborted(signal);
          const page=range.byteOffset===0&&range.byteLength===range.buffer.byteLength?range:range.slice();
          if (page.byteLength !== length || (await desktop.appendBinaryAsset(id, page)).size !== offset + length) throw new Error('项目 Cube 原件分段写入未完整确认。');
        }
        assertResultNotAborted(signal);
        if ((await desktop.sealBinaryAsset(id)).size !== source.bytes) throw new Error('项目 Cube 原件写入长度与来源不符。');
        receipt = await desktop.registerSurfaceCubeAsset({ name: source.name, assetId: id, sourceRevision: source.sourceRevision });
        adopted = true;
      } finally { if (!adopted) await desktop.releaseBinaryAsset(id).catch(() => {}); }
      verifyRestoredSource(receipt, source, signal);
      if (!desktop.readRegisteredSurfaceCubePage) throw new Error('当前环境缺少已注册 Cube 来源页读取入口。');
      const parsed = await readRegisteredCubeAsset(desktop, receipt, options, signal);
      return { receipt, parsed };
    }
    // Compatibility for hosts which only implement the previous Cube API.
    if (!desktop.registerSurfaceCube) throw new Error('当前环境缺少项目 Cube 原始素材注册入口。');
    const raw = await source.readRange(0, source.bytes), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const parsed = await readDisplayCubeStream({ size: source.bytes, stream: () => cubeByteStream(source.bytes, async (offset, length) => raw.subarray(offset, offset + length), signal) }, options, signal);
    receipt = await desktop.registerSurfaceCube({ name: source.name, text });
    verifyRestoredSource(receipt, source, signal);
    return { receipt, parsed };
  } catch (error) {
    if (receipt) await desktop.releaseSurfaceCube?.(receipt.token).catch(() => {});
    throw error;
  }
}

function verifyRestoredSource(receipt: SurfaceCubeReceipt, source: AnalysisOriginalCubeSource, signal: AbortSignal) {
  assertResultNotAborted(signal);
  if (!receipt.token || receipt.sourceRevision !== source.sourceRevision || receipt.bytes !== source.bytes) throw new Error('项目 Cube 原始素材内容身份或长度不一致。');
}

export function cubeOptions(coordinateUnit: 'bohr' | 'angstrom'): CubeReadOptions {
  return { coordinateUnit, coordinateUnitEvidence: 'Spatial unit bound to this previously identified Cube source.' };
}

export async function readRegisteredCubeAsset(desktop: CubeAssetDesktop, source: SurfaceCubeReceipt, options: CubeReadOptions, signal: AbortSignal): Promise<ParsedMolecularCube> {
  const read = desktop.readRegisteredSurfaceCubePage;
  if ('text' in source && typeof source.text === 'string') {
    if (!options.coordinateUnit) return (await readDisplayCube({ text: source.text, bytes: source.bytes, keepOriginal: false }, signal)).parsed;
    const raw = new TextEncoder().encode(source.text);
    return readDisplayCubeStream({ size: source.bytes, stream: () => cubeByteStream(source.bytes, async (offset, length) => raw.subarray(offset, offset + length), signal) }, options, signal);
  }
  if (!read) throw new Error('当前环境缺少 Cube 来源页读取入口。');
  return readDisplayCubeStream({ size: source.bytes, stream: () => cubeByteStream(source.bytes,
    async (offset, length) => new Uint8Array(await read(source.token, offset, length)), signal) }, options, signal);
}

export async function readImportedCubeAsset(desktop: CubeAssetDesktop, receipt: SurfaceCubeReceipt, signal: AbortSignal) {
  const options = receipt.knownDomain?.coordinateUnit ? cubeOptions(receipt.knownDomain.coordinateUnit) : {};
  if ('text' in receipt && typeof receipt.text === 'string') {
    return readDisplayCube({ text: receipt.text, bytes: receipt.bytes, keepOriginal: true }, signal, options);
  }
  return { parsed: await readRegisteredCubeAsset(desktop, receipt, options, signal), originalBytes: undefined };
}

/** The view and its project record hold independent references to the same
 * private original. Neither release evicts bytes that the other still uses. */
export function retainImportedCubeAsset(
  desktop: CubeAssetDesktop, key: string, receipt: SurfaceCubeReceipt, fieldMetadata: Omit<SurfaceScalarField, 'values'>,
  originalBytes: Uint8Array | undefined, onError: (error: unknown) => void,
): (() => Promise<void>) | undefined {
  const { token, name, sourceRevision, bytes } = receipt;
  if (originalBytes) {
    retainAnalysisProjectSnapshot(key, { name, sourceRevision, fieldMetadata, originalBytes });
    return undefined;
  }
  const read = desktop.readRegisteredSurfaceCubePage, close = desktop.releaseSurfaceCube;
  if (!read || !close) throw new Error('当前环境缺少 Cube 原始来源入口。');
  let viewOwns = true, projectOwns = true, pending: Promise<void> | undefined;
  const release = async () => {
    if (viewOwns || projectOwns) return;
    pending ??= close(token).then(result => { if (!result.released) throw new Error('Cube 原始来源尚未释放。'); });
    try { await pending; } catch (error) { pending = undefined; throw error; }
  };
  retainAnalysisOriginalCube(key, { name, sourceRevision, fieldMetadata, bytes, async readRange(offset, length) {
    if (!projectOwns || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > bytes - offset)
      throw new Error('Cube 原始来源已关闭或读取范围无效。');
    const readPage = async (position: number, pageSize: number) => {
      const page = await read(token, position, pageSize);
      if (page.byteLength !== pageSize) throw new Error('Cube 原始来源分页不完整。');
      return new Uint8Array(page);
    };
    if (length > 0 && length <= CUBE_PAGE_BYTES) return readPage(offset, length);
    const combined = new Uint8Array(length);
    for (let position = 0; position < length; position += CUBE_PAGE_BYTES) {
      const pageSize = Math.min(CUBE_PAGE_BYTES, length - position);
      combined.set(await readPage(offset + position, pageSize), position);
    }
    return combined;
  } }, () => { projectOwns = false; void release().catch(onError); });
  return () => { viewOwns = false; return release(); };
}

interface PackedCubeField {
  binaryAsset: { id: string; bytesLength: number };
  encoding: 'float64-le' | 'uint8';
}

const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/** Each exact typed destination is allocated once, with bounded transfer
 * pages and no intermediate full ArrayBuffer. */
export async function materializeCubeFields<T>(result: T, desktop: CubeAssetDesktop, signal?: AbortSignal): Promise<T> {
  const pending: { key: string; field: PackedCubeField }[] = [];
  const seen = new Set<object>(), stack: unknown[] = [result];
  while (stack.length) {
    const object = stack.pop();
    if (!object || typeof object !== 'object' || ArrayBuffer.isView(object) || object instanceof ArrayBuffer || seen.has(object)) continue;
    seen.add(object);
    for (const [key, value] of Object.entries(object)) {
      if ((key === 'values' || key === 'mask') && value && typeof value === 'object' && 'binaryAsset' in value) pending.push({ key, field: value as PackedCubeField });
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  if (!pending.length) return result;
  const release = desktop.releaseBinaryAsset, read = desktop.readBinaryAsset;
  if (!read || !release) throw new Error('当前环境缺少完整精度格点传输入口。');
  const remaining = new Set(pending.map(({ field }) => field.binaryAsset.id)), mapped = new Map<object,Float64Array|Uint8Array>();
  const loaded = new Map<string,{encoding:PackedCubeField['encoding'];values:Float64Array|Uint8Array}>();
  try {
    for (const { key, field } of pending) {
      const { id, bytesLength } = field.binaryAsset, float = field.encoding === 'float64-le';
      if (!id || (key === 'values' ? !float : field.encoding !== 'uint8') || !Number.isSafeInteger(bytesLength) || bytesLength <= 0 || (float && bytesLength % 8)) throw new Error('格点分页类型或长度无效。');
      const previous=loaded.get(id);
      if(previous){
        if(previous.encoding!==field.encoding||previous.values.byteLength!==bytesLength)throw new Error('同一格点文件的类型或长度冲突。');
        mapped.set(field,previous.values);continue;
      }
      assertResultNotAborted(signal);
      let buffer: ArrayBufferLike;
      try { buffer = globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(bytesLength) : new ArrayBuffer(bytesLength); }
      catch (error) { if (!(error instanceof RangeError)) throw error; throw new Error('无法分配完整精度的科学格点，原始来源仍保留。'); }
      const output = new Uint8Array(buffer), numbers = float ? new Float64Array(buffer) : null;
      for (let offset = 0; offset < bytesLength; offset += CUBE_PAGE_BYTES) {
        assertResultNotAborted(signal);
        const length = Math.min(CUBE_PAGE_BYTES, bytesLength - offset), page = await read(id, offset, length);
        assertResultNotAborted(signal);
        if (page.byteLength !== length) throw new Error('完整精度格点分页回执长度不符。');
        if (numbers && !littleEndian) {
          const source = new DataView(page);
          for (let index = 0; index < length; index += 8) numbers[(offset + index) / 8] = source.getFloat64(index, true);
        } else output.set(new Uint8Array(page), offset);
      }
      const values=numbers??output;
      mapped.set(field,values);loaded.set(id,{encoding:field.encoding,values});
      await release(id);
      remaining.delete(id);
    }
    // contextBridge may freeze returned containers. Only replace paths with
    // packed descriptors and keep already resident typed arrays by reference.
    const visited=new Map<object,unknown>();
    const replace=(value:unknown):unknown=>{
      if(!value||typeof value!=='object'||ArrayBuffer.isView(value)||value instanceof ArrayBuffer)return value;
      if(mapped.has(value))return mapped.get(value);
      if(visited.has(value))return visited.get(value);
      const copy:Record<string,unknown>=Array.isArray(value)?[] as unknown as Record<string,unknown>:{};
      visited.set(value,copy);
      let changed=false;
      for(const [key,entry] of Object.entries(value)){ const filled=replace(entry);copy[key]=filled;changed||=filled!==entry; }
      const filled=changed?copy:value;visited.set(value,filled);return filled;
    };
    return replace(result) as T;
  } finally { await Promise.allSettled([...remaining].map(id => release(id))); }
}
