import type { TwoDImageMetadata, TwoDImageMime } from './image-types';

const fail = (message = '图片内容损坏或读取不完整。'): never => { throw new Error(message); };
const text = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
export function twoDImageMime(bytes: Uint8Array): TwoDImageMime | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (text(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (['II*\0', 'MM\0*', 'II+\0', 'MM\0+'].includes(text(bytes, 0, 4))) return 'image/tiff';
  if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(text(bytes, 0, 6))) return 'image/gif';
  return null;
}

/** Bounded TIFF directory reader: no pixel allocation and no following cycles. */
export function tiffDirectories(bytes: Uint8Array, base = 0): Map<number, number[]>[] {
  if (base < 0 || base + 8 > bytes.length) return fail();
  const little = text(bytes, base, 2) === 'II';
  if (!little && text(bytes, base, 2) !== 'MM') return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => { if (offset < base || offset + 2 > bytes.length) return fail(); return view.getUint16(offset, little); };
  const u32 = (offset: number) => { if (offset < base || offset + 4 > bytes.length) return fail(); return view.getUint32(offset, little); };
  if (u16(base + 2) !== 42) return fail('暂不支持BigTIFF，请导出普通单页TIFF。');
  let offset = u32(base + 4), pages = 0;
  const seen = new Set<number>(), result: Map<number, number[]>[] = [];
  while (offset) {
    if (seen.has(offset) || ++pages > 2) return fail('本版仅支持静态单帧图片，请提供单页TIFF。');
    seen.add(offset);
    const start = base + offset, count = u16(start), tags = new Map<number, number[]>();
    if (start + 2 + count * 12 + 4 > bytes.length) return fail();
    for (let i = 0; i < count; i++) {
      const entry = start + 2 + i * 12, tag = u16(entry), type = u16(entry + 2), length = u32(entry + 4);
      // Only integer metadata needed for image admission/orientation is interpreted.
      if (![256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 284, 317, 322, 323, 324, 325, 330, 338, 339].includes(tag)) continue;
      if (![1, 3, 4].includes(type) || length > 1_000_000) return fail('TIFF元数据类型暂不支持。');
      const size = type === 3 ? 2 : type === 4 ? 4 : 1;
      const location = size * length <= 4 ? entry + 8 : base + u32(entry + 8);
      if (location < base || location + size * length > bytes.length) return fail();
      tags.set(tag, Array.from({ length }, (_, n) => size === 1 ? bytes[location + n] : size === 2 ? u16(location + n * size) : u32(location + n * size)));
    }
    result.push(tags); offset = u32(start + 2 + count * 12);
  }
  return result;
}

const singleFrame = (): never => fail('本版仅支持静态单帧图片，请先导出单帧图；不会自动取第一帧。');
export function inspectStaticImage(bytes: Uint8Array): TwoDImageMetadata {
  const mime = twoDImageMime(bytes); if (!mime) return fail('未识别到PNG、JPEG、BMP、TIFF、WebP或GIF图片内容。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (start: number, size: number) => { if (start < 0 || start + size > bytes.length) fail(); };
  const u16 = (start: number, little = false) => { need(start, 2); return view.getUint16(start, little); };
  const u32 = (start: number, little = false) => { need(start, 4); return view.getUint32(start, little); };
  let width = 0, height = 0, bitDepth = 8, orientation = 1, compression: number | undefined, photometric: number | undefined;
  const derivations = ['浏览器色彩管理转换为8位RGBA显示像素；原始文件保留'];
  if (mime === 'image/png') {
    let offset = 8, ended = false, data = false;
    while (offset + 12 <= bytes.length) {
      const length = u32(offset), name = text(bytes, offset + 4, 4); need(offset, length + 12);
      if (offset === 8 && (name !== 'IHDR' || length !== 13)) fail();
      if (name === 'IHDR') { width = u32(offset + 8); height = u32(offset + 12); bitDepth = bytes[offset + 16]; }
      if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') singleFrame();
      if (name === 'eXIf') orientation = tiffDirectories(bytes.subarray(offset + 8, offset + 8 + length))[0]?.get(274)?.[0] ?? 1;
      if (name === 'IDAT') data = true;
      if (name === 'IEND') { ended = true; break; }
      offset += length + 12;
    }
    if (!ended || !data) fail();
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      const length = u16(offset); if (length < 2) fail(); need(offset, length);
      if (marker === 0xe1 && text(bytes, offset + 2, 6) === 'Exif\0\0') orientation = tiffDirectories(bytes.subarray(offset + 8, offset + length))[0]?.get(274)?.[0] ?? 1;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        need(offset, 8); bitDepth = bytes[offset + 2]; height = u16(offset + 3); width = u16(offset + 5);
      }
      offset += length;
    }
  } else if (mime === 'image/bmp') {
    const header = u32(14, true);
    if (header === 12) { width = u16(18, true); height = u16(20, true); bitDepth = u16(24, true); }
    else if (header >= 40) { need(18, 22); width = view.getInt32(18, true); height = Math.abs(view.getInt32(22, true)); bitDepth = u16(28, true); compression = u32(30, true); }
    else fail('此BMP头类型暂不支持，请导出PNG。');
  } else if (mime === 'image/tiff') {
    const directories = tiffDirectories(bytes);
    if (directories.length !== 1 || directories[0].get(330)?.some(Boolean)) singleFrame();
    const tags = directories[0]; width = tags.get(256)?.[0] ?? 0; height = tags.get(257)?.[0] ?? 0;
    orientation = tags.get(274)?.[0] ?? 1; compression = tags.get(259)?.[0] ?? 1; photometric = tags.get(262)?.[0] ?? 0;
    const bits = tags.get(258) ?? [1]; bitDepth = Math.max(...bits);
    const channels = tags.get(277)?.[0] ?? 1;
    if (bits.length !== channels) fail('TIFF逐通道位深声明不完整。');
    if (![0, 1, 2, 3].includes(photometric) || ![1, 3, 4].includes(channels) || (tags.get(284)?.[0] ?? 1) !== 1 || (tags.get(339) ?? [1]).some(value => value !== 1)) fail('此TIFF色彩、平面或浮点类型暂不支持；请导出RGB/灰度PNG。');
    if ((photometric !== 2 && channels !== 1) || (photometric === 2 && ![3, 4].includes(channels)) || (channels === 4 && tags.get(338)?.[0] !== 2) || (photometric === 3 && bitDepth !== 8)) fail('此TIFF通道/透明度或调色板位深暂不支持，请导出普通RGB/灰度PNG。');
    if (tags.has(322) || tags.has(324) || (tags.get(266)?.[0] ?? 1) !== 1 || ![1, 2].includes(tags.get(317)?.[0] ?? 1)) fail('此TIFF分块、填充顺序或预测器暂不支持，请导出条带式单页TIFF或PNG。');
    const offsets = tags.get(273), counts = tags.get(279), rows = tags.get(278)?.[0] ?? height;
    if (!offsets?.length || !counts || counts.length !== offsets.length || rows <= 0 || offsets.length !== Math.ceil(height / rows) || offsets.some((value, index) => !counts[index] || value + counts[index] > bytes.length)) fail('TIFF像素条带缺失或读取不完整。');
    if (compression === 1 && counts!.some((value, index) => value !== Math.min(rows, height - index * rows) * Math.ceil(width * channels * bitDepth / 8))) fail('TIFF未压缩条带字节数不完整。');
    if (bits.some(value => ![1, 2, 4, 8, 16].includes(value)) || new Set(bits).size !== 1 || (photometric === 2 && ![8, 16].includes(bitDepth))) fail('此TIFF位深暂不支持；请导出8/16位RGB或灰度图片。');
    if (![1, 5, 8, 32946, 32773].includes(compression)) fail('此TIFF压缩暂不支持；请使用无压缩、LZW、Deflate或PackBits单页TIFF。');
    derivations[0] = `TIFF ${bitDepth}位整数样本线性映射为8位RGBA显示像素，未应用嵌入ICC；原始位深/色彩元数据和文件保留`;
  } else if (mime === 'image/gif') {
    need(0, 13); width = u16(6, true); height = u16(8, true);
    let offset = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0, ended = false;
    const skipBlocks = () => { while (true) { need(offset, 1); const count = bytes[offset++]; if (!count) break; need(offset, count); offset += count; } };
    while (offset < bytes.length) {
      const code = bytes[offset++];
      if (code === 0x3b) { ended = true; break; }
      if (code === 0x21) { need(offset++, 1); skipBlocks(); }
      else if (code === 0x2c) { if (++frames > 1) singleFrame(); need(offset, 9); const flags = bytes[offset + 8]; offset += 9 + ((flags & 128) ? 3 * 2 ** ((flags & 7) + 1) : 0); need(offset++, 1); skipBlocks(); }
      else fail();
    }
    if (!ended || frames !== 1) fail();
  } else {
    const total = u32(4, true) + 8; if (total > bytes.length || total < 20) fail();
    let offset = 12, frame = false;
    while (offset + 8 <= total) {
      const name = text(bytes, offset, 4), length = u32(offset + 4, true), start = offset + 8; need(start, length);
      if (start + length > total) fail();
      if (name === 'ANIM' || name === 'ANMF' || (name === 'VP8X' && (bytes[start] & 2))) singleFrame();
      if (name === 'VP8X') { if (length < 10) fail(); width = 1 + bytes[start + 4] + bytes[start + 5] * 256 + bytes[start + 6] * 65536; height = 1 + bytes[start + 7] + bytes[start + 8] * 256 + bytes[start + 9] * 65536; }
      if (name === 'VP8 ') { if (length < 10 || text(bytes, start + 3, 3) !== '\x9d\x01\x2a') fail(); width ||= u16(start + 6, true) & 16383; height ||= u16(start + 8, true) & 16383; frame = true; }
      if (name === 'VP8L') { if (length < 5 || bytes[start] !== 0x2f) fail(); const packed = u32(start + 1, true); width ||= (packed & 16383) + 1; height ||= ((packed >>> 14) & 16383) + 1; frame = true; }
      if (name === 'EXIF') orientation = tiffDirectories(bytes.subarray(start, start + length), text(bytes, start, 6) === 'Exif\0\0' ? 6 : 0)[0]?.get(274)?.[0] ?? 1;
      offset = start + length + (length % 2);
    }
    if (!frame) fail();
  }
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 64_000_000) fail('原图尺寸无效或超过6400万像素，请在外部裁切后导入。');
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) fail('图片方向元数据无效。');
  if (orientation !== 1) derivations.push(`按EXIF/TIFF方向${orientation}校正；裁切使用校正后的像素坐标`);
  return { mime, format: mime.slice(6) as TwoDImageMetadata['format'], sourceWidth: width, sourceHeight: height,
    width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height,
    frameCount: 1, orientation, bitDepth, derivations, compression, photometric };
}
