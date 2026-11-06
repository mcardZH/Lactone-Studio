import { inspectStaticImage } from './static-image';
import { TWO_D_OCR_LIMITS, type DecodedTwoDImage, type TwoDImageCrop, type TwoDImageMetadata, type TwoDImageSelection } from './image-types';

/** Validate bounded strip expansion before UTIF, whose low-level routines pad truncation. */
async function validateTiffStrips(bytes: Uint8Array, image: Record<string, unknown>, metadata: TwoDImageMetadata) {
  const offsets = image.t273 as number[], counts = image.t279 as number[], rows = (image.t278 as number[] | undefined)?.[0] ?? metadata.sourceHeight;
  const channels = (image.t277 as number[] | undefined)?.[0] ?? 1;
  for (let strip = 0; strip < offsets.length; strip++) {
    const source = bytes.subarray(offsets[strip], offsets[strip] + counts[strip]);
    const expected = Math.min(rows, metadata.sourceHeight - strip * rows) * Math.ceil(metadata.sourceWidth * channels * metadata.bitDepth / 8);
    let produced = 0;
    if ([8, 32946].includes(metadata.compression ?? 1)) {
      const reader = new Blob([new Uint8Array(source)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      try {
        while (true) { const result = await reader.read(); if (result.done) break; produced += result.value.length; if (produced > expected) throw new Error('TIFF压缩条带展开超出声明尺寸。'); }
      } finally { await reader.cancel().catch(() => {}); }
    } else if (metadata.compression === 32773) {
      for (let i = 0; i < source.length;) {
        const code = source[i++];
        if (code <= 127) { if (i + code + 1 > source.length) throw new Error('TIFF PackBits条带不完整。'); produced += code + 1; i += code + 1; }
        else if (code !== 128) { if (i++ >= source.length) throw new Error('TIFF PackBits条带不完整。'); produced += 257 - code; }
        if (produced > expected) throw new Error('TIFF条带展开超出声明尺寸。');
      }
    } else if (metadata.compression === 5) {
      const lengths = new Uint32Array(4096); for (let i = 0; i < 256; i++) lengths[i] = 1;
      let bit = 0, width = 9, next = 258, previous = -1, ended = false;
      while (bit + width <= source.length * 8) {
        let code = 0; for (let i = 0; i < width; i++, bit++) code = code * 2 + (source[bit >>> 3] >>> (7 - (bit & 7)) & 1);
        if (code === 256) { width = 9; next = 258; previous = -1; continue; }
        if (code === 257) { ended = true; break; }
        if (code > next || (previous < 0 && code > 255) || code >= 4096) throw new Error('TIFF LZW条带编码无效。');
        const size = code === next ? lengths[previous] + 1 : lengths[code];
        produced += size;
        if (produced > expected || !size) throw new Error('TIFF LZW条带展开超出声明尺寸。');
        if (previous >= 0 && next < 4096) { lengths[next++] = lengths[previous] + 1; if (next === (1 << width) - 1 && width < 12) width++; }
        previous = code;
      }
      if (!ended) throw new Error('TIFF LZW条带缺少结束标记。');
    } else produced = source.length;
    if (produced !== expected) throw new Error('TIFF条带解码字节数不完整。');
  }
}

export function orientImagePixels(rgba: Uint8Array, width: number, height: number, orientation: number): Uint8ClampedArray {
  if (rgba.length !== width * height * 4) throw new Error('TIFF解码像素不完整。');
  const output = new Uint8ClampedArray(rgba.length), outWidth = orientation >= 5 ? height : width;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [ox, oy] = orientation === 2 ? [width - 1 - x, y] : orientation === 3 ? [width - 1 - x, height - 1 - y]
      : orientation === 4 ? [x, height - 1 - y] : orientation === 5 ? [y, x] : orientation === 6 ? [height - 1 - y, x]
      : orientation === 7 ? [height - 1 - y, width - 1 - x] : orientation === 8 ? [y, width - 1 - x] : [x, y];
    output.set(rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4), (oy * outWidth + ox) * 4);
  }
  return output;
}

/** Separately testable genuine TIFF pixel decoder; no scientific backend involved. */
export async function decodeTiffPixels(bytes: Uint8Array, metadata = inspectStaticImage(bytes)): Promise<Uint8ClampedArray> {
  const { default: UTIF } = await import('utif');
  const buffer = new Uint8Array(bytes).buffer;
  const directories = UTIF.decode(buffer);
  if (directories.length !== 1) throw new Error('本版仅支持静态单帧TIFF。');
  const image = directories[0];
  await validateTiffStrips(bytes, image, metadata);
  // TIFF's legacy Deflate tag has the same zlib payload. UTIF handles tag 8.
  if (metadata.compression === 32946) image.t259 = [8];
  UTIF.decodeImage(buffer, image);
  if (image.width !== metadata.sourceWidth || image.height !== metadata.sourceHeight) throw new Error('TIFF解码尺寸与来源不一致。');
  const data = image.data; if (!data) throw new Error('TIFF未生成有效像素。');
  const channels = (image.t277 as number[] | undefined)?.[0] ?? 1;
  const depth = metadata.bitDepth, rowBytes = Math.ceil(metadata.sourceWidth * channels * depth / 8);
  if (data.length !== rowBytes * metadata.sourceHeight) throw new Error('TIFF像素字节数不完整。');
  const pixels = new Uint8Array(metadata.sourceWidth * metadata.sourceHeight * 4);
  const palette = image.t320 as number[] | undefined;
  if (metadata.photometric === 3 && (!palette || palette.length !== 768)) throw new Error('TIFF调色板不完整。');
  // UTIF normalizes 16-bit samples to little endian after decompression/prediction.
  const sample = (row: number, index: number) => {
    const bit = index * depth, offset = row * rowBytes + Math.floor(bit / 8);
    const value = depth === 16 ? data[offset] + 256 * data[offset + 1]
      : depth === 8 ? data[offset] : (data[offset] >>> (8 - depth - bit % 8)) & ((1 << depth) - 1);
    return Math.round(value * 255 / (2 ** depth - 1));
  };
  for (let y = 0; y < metadata.sourceHeight; y++) for (let x = 0; x < metadata.sourceWidth; x++) {
    const out = (y * metadata.sourceWidth + x) * 4;
    if (metadata.photometric === 2) {
      for (let channel = 0; channel < 3; channel++) pixels[out + channel] = sample(y, x * channels + channel);
      pixels[out + 3] = channels === 4 ? sample(y, x * channels + 3) : 255;
    } else if (metadata.photometric === 3) {
      const index = data[y * rowBytes + x];
      for (let channel = 0; channel < 3; channel++) pixels[out + channel] = Math.round(palette![index + channel * 256] / 257);
      pixels[out + 3] = 255;
    } else {
      const gray = sample(y, x), value = metadata.photometric === 0 ? 255 - gray : gray;
      pixels[out] = pixels[out + 1] = pixels[out + 2] = value; pixels[out + 3] = 255;
    }
  }
  return orientImagePixels(pixels, metadata.sourceWidth, metadata.sourceHeight, metadata.orientation);
}

/** Read/validate/decode before the caller replaces its existing session draft. */
export async function decodeStaticImage(bytes: Uint8Array, signal?: AbortSignal): Promise<DecodedTwoDImage> {
  const metadata = inspectStaticImage(bytes);
  const guard = () => { if (signal?.aborted) throw new Error('图片解码已取消。'); };
  guard();
  if (typeof document === 'undefined') throw new Error('图片解码需要应用图形环境。');
  const canvas = document.createElement('canvas'); canvas.width = metadata.width; canvas.height = metadata.height;
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('图片像素画布不可用。');
    if (metadata.mime === 'image/tiff') {
      const pixels = await decodeTiffPixels(bytes, metadata); guard();
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels), metadata.width, metadata.height), 0, 0);
    } else {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: metadata.mime }), {
        imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default',
      });
      try {
        guard();
        if (bitmap.width !== metadata.width || bitmap.height !== metadata.height) throw new Error('图片方向或解码尺寸与来源不一致，请导出方向已确定的PNG后重试。');
        context.drawImage(bitmap, 0, 0);
      } finally { bitmap.close(); }
    }
    guard(); return { canvas, metadata };
  } catch (error) {
    canvas.width = 0; canvas.height = 0;
    if (signal?.aborted) throw new Error('图片解码已取消。');
    throw error instanceof Error ? error : new Error('图片内容无法解码，请检查原文件。');
  }
}

export function fullImageCrop(metadata: Pick<TwoDImageMetadata, 'width' | 'height'>): TwoDImageCrop {
  return { x: 0, y: 0, width: metadata.width, height: metadata.height, imageWidth: metadata.width, imageHeight: metadata.height };
}
export function imageCropLimitReason(crop: TwoDImageCrop, limits: { maxImagePixels: number; maxImageBytes: number } = TWO_D_OCR_LIMITS): string | undefined {
  if (crop.width > TWO_D_OCR_LIMITS.maxDimension || crop.height > TWO_D_OCR_LIMITS.maxDimension || crop.width * crop.height > limits.maxImagePixels)
    return '选区超过识别尺寸上限（单边16000像素、2400万像素），请框选一个完整分子后点击“识别选区”。';
}
export async function imageSelectionPng(decoded: DecodedTwoDImage, crop: TwoDImageCrop,
  limits: { maxImagePixels: number; maxImageBytes: number } = TWO_D_OCR_LIMITS): Promise<TwoDImageSelection> {
  const { width, height } = decoded.metadata;
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height || crop.imageWidth !== width || crop.imageHeight !== height) throw new Error('图片选区坐标无效。');
  const reason = imageCropLimitReason(crop, limits); if (reason) throw new Error(reason);
  const canvas = document.createElement('canvas'); canvas.width = crop.width; canvas.height = crop.height;
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('图像裁切不可用。');
    // White is applied only to this OCR derivative, never to the original/display allocation.
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, crop.width, crop.height);
    context.drawImage(decoded.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图像裁切失败。')), 'image/png'));
    if (blob.size > limits.maxImageBytes) throw new Error('裁切PNG超过识别字节上限，请缩小选区后重试。');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), crop: { ...crop }, derivation: {
      coordinateSpace: 'oriented-display-pixels', mime: 'image/png', alphaBackground: 'white', bitDepth: 8, source: structuredClone(decoded.metadata),
    } };
  } finally { canvas.width = 0; canvas.height = 0; }
}
