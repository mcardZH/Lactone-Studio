import type { PesTerminalNumericAsset } from './contracts';

/** Hydrate one exact array a row at a time over the trusted binary asset lease. */
export async function readPesFloat64Rows(asset: PesTerminalNumericAsset, rows: number, columns: number,
  read: (assetId: string, offset: number, length: number) => Promise<ArrayBuffer>, current: () => void): Promise<number[][]> {
  const bytes = rows * columns * 8;
  if (!Number.isSafeInteger(rows) || rows < 0 || !Number.isSafeInteger(columns) || columns < 0
      || !Number.isSafeInteger(bytes) || bytes !== asset.bytesLength
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.id !== 'string' || !asset.id)
    throw Error('优化数值资产的形状或身份不符。');
  const result: number[][] = [];
  if (columns === 0) return Array.from({ length: rows }, () => []);
  let row: number[] = [];
  for (let offset = 0; offset < bytes;) {
    current();
    const take = Math.min(256 * 1024, bytes - offset);
    const block = await read(asset.id, offset, take);
    current();
    if (!(block instanceof ArrayBuffer) || block.byteLength !== take) throw Error('优化数值资产读取长度变化。');
    const view = new DataView(block);
    for (let position = 0; position < take; position += 8) {
      const value = view.getFloat64(position, true);
      if (!Number.isFinite(value)) throw Error('优化数值资产包含非有限值。');
      row.push(value);
      if (row.length === columns) { result.push(row); row = []; }
    }
    offset += take;
  }
  if (row.length || result.length !== rows) throw Error('优化数值资产不能建立完整行。');
  return result;
}
