import { VibronicSha256 } from '../core/gaussian-vibronic/sha256-stream';
import { readPesFloat64Rows } from '../modeling/pes/terminal-numeric';
import { projectAssetSha256 } from './desktop-bridge';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';

export interface NumericRowsAsset {
  encoding: 'float64-le';
  rows: number;
  columns: number;
  sha256: string;
  chunks: { assetId: string; bytes: number }[];
}

// Part of the persisted format. The native transfer may change independently.
const pageBytes = 256 * 1024;
const identity = /^[a-f0-9]{64}$/;
const invalid = () => new Error('项目数值资产维度、字节或来源身份无效，原有记录已保留。');

function byteLength(rows: number, columns: number): number {
  const bytes = rows * columns * 8;
  if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(columns) || columns < 0 || !Number.isSafeInteger(bytes)) throw invalid();
  return bytes;
}

export function numericRowAssetReferences(asset: NumericRowsAsset): string[] {
  if (asset?.encoding !== 'float64-le' || typeof asset.sha256 !== 'string' || !identity.test(asset.sha256) || !Array.isArray(asset.chunks)) throw invalid();
  const bytes = byteLength(asset.rows, asset.columns);
  if (asset.chunks.length !== Math.ceil(bytes / pageBytes)) throw invalid();
  return asset.chunks.map((part, index) => {
    if (!part || typeof part.assetId !== 'string' || !identity.test(part.assetId) || part.bytes !== Math.min(pageBytes, bytes - index * pageBytes)) throw invalid();
    return part.assetId;
  });
}

/** The scientific owner has captured fixed ordered rows. Write one reusable
 * page of doubles at a time without serializing or flattening the matrix. */
export async function writeNumericRows(writer: ProjectAssetWriter, name: string,
  rows: Iterable<readonly number[]>, rowCount: number, columns: number): Promise<NumericRowsAsset> {
  const size = byteLength(rowCount, columns), hash = new VibronicSha256();
  const chunks: NumericRowsAsset['chunks'] = [];
  let remaining = size, page = new Uint8Array(Math.min(pageBytes, size)), view = new DataView(page.buffer);
  let count = 0, offset = 0;
  const flush = async () => {
    const bytes = page;
    hash.update(bytes);
    const expected = await projectAssetSha256(bytes);
    const { assetId } = writer.writeRange
      ? await writer.writeRange('results', name, { bytes: bytes.byteLength, sha256: expected, async readRange(start, length) {
        return start === 0 && length === bytes.byteLength ? bytes : bytes.slice(start, start + length);
      } })
      : await writer.write('results', name, bytes);
    if (assetId !== expected) throw invalid();
    chunks.push({ assetId, bytes: bytes.byteLength });
    remaining -= bytes.byteLength;
    page = new Uint8Array(Math.min(pageBytes, remaining)); view = new DataView(page.buffer); offset = 0;
  };
  for (const row of rows) {
    if (++count > rowCount || row.length !== columns) throw invalid();
    for (let i = 0; i < columns; i++) {
      if (!Number.isFinite(row[i])) throw invalid();
      view.setFloat64(offset, row[i], true); offset += 8;
      if (offset === page.byteLength) await flush();
    }
  }
  if (remaining || offset || count !== rowCount) throw invalid();
  return { encoding: 'float64-le', rows: rowCount, columns, sha256: hash.digest(), chunks };
}

/** Reuse the native terminal's Float64 decoder and validate both each asset and
 * the ordered matrix. Only the final row arrays stay resident. */
export async function readNumericRows(reader: ProjectAssetReader, asset: NumericRowsAsset,
  expected: { rows: number; columns: number }): Promise<number[][]> {
  const ids = numericRowAssetReferences(asset);
  if (asset.rows !== expected.rows || asset.columns !== expected.columns) throw invalid();
  const bytes = byteLength(asset.rows, asset.columns), hash = new VibronicSha256();
  const values = await readPesFloat64Rows({ id: asset.sha256, sha256: asset.sha256, shape: [asset.rows, asset.columns], bytesLength: bytes },
    asset.rows, asset.columns, async (_id, start, length) => {
      const part = ids[start / pageBytes];
      if (!part || length !== asset.chunks[start / pageBytes].bytes) throw invalid();
      const page = await reader.read(part);
      if (page.byteLength !== length || await projectAssetSha256(page) !== part) throw invalid();
      hash.update(page);
      return page.byteOffset === 0 && page.buffer instanceof ArrayBuffer && page.buffer.byteLength === page.byteLength
        ? page.buffer : page.slice().buffer;
    }, () => {}, pageBytes);
  if (hash.digest() !== asset.sha256) throw invalid();
  return values;
}
