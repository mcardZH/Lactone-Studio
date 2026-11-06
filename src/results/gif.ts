/** Streaming GIF89a encoder. A scene-adaptive palette is shared across frames;
 * neutral grays stay neutral and LZW uses its full 12-bit dictionary. */
export interface GifFrame { rgba: Uint8ClampedArray | Uint8Array; delayMs: number }
type RGB = [number, number, number];
interface ColorBin { rgb: RGB; count: number }

function scenePalette(rgba: GifFrame['rgba']): RGB[] {
  const histogram = new Map<number, ColorBin>(), stride = Math.max(1, Math.floor(rgba.length / 4 / 262144));
  for (let pixel = 0; pixel < rgba.length / 4; pixel += stride) {
    const offset = pixel * 4, alpha = rgba[offset + 3] / 255;
    const rgb = [0, 1, 2].map(axis => Math.round(rgba[offset + axis] * alpha + 255 * (1 - alpha))) as RGB;
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3), bin = histogram.get(key);
    if (bin) { const n = bin.count++; for (let axis = 0; axis < 3; axis++) bin.rgb[axis] = (bin.rgb[axis] * n + rgb[axis]) / bin.count; }
    else histogram.set(key, { rgb, count: 1 });
  }
  const boxes = [[...histogram.values()]];
  while (boxes.length < 186) {
    let chosen = -1, chosenAxis = 0, score = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]; if (box.length < 2) continue;
      const spans = [0, 1, 2].map(axis => Math.max(...box.map(b => b.rgb[axis])) - Math.min(...box.map(b => b.rgb[axis])));
      const axis = spans.indexOf(Math.max(...spans)), weight = box.reduce((sum, b) => sum + b.count, 0), next = spans[axis] * Math.sqrt(weight);
      if (next > score) { score = next; chosen = i; chosenAxis = axis; }
    }
    if (chosen < 0) break;
    const box = boxes[chosen].sort((a, b) => a.rgb[chosenAxis] - b.rgb[chosenAxis]), half = box.reduce((sum, b) => sum + b.count, 0) / 2;
    let sum = 0, cut = 1;
    while (cut < box.length - 1 && sum + box[cut - 1].count < half) sum += box[cut++ - 1].count;
    boxes.splice(chosen, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette: RGB[] = Array.from({ length: 64 }, (_, i) => { const value = Math.round(i * 255 / 63); return [value, value, value]; });
  palette.push([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]);
  for (const box of boxes) { const count = box.reduce((sum, b) => sum + b.count, 0); palette.push([0, 1, 2].map(axis => Math.round(box.reduce((sum, b) => sum + b.rgb[axis] * b.count, 0) / count)) as RGB); }
  while (palette.length < 256) palette.push([255, 255, 255]); return palette;
}

export function createGifEncoder(width: number, height: number, loop = true) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 65535)) throw new Error('GIF格式的宽和高须为1–65535像素。');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let buffer = new Uint8Array(65536), cursor = 0, count = 0, finished = false;
  let palette: RGB[] | null = null; const colors = new Map<number, number>();
  const write = (...values: number[]) => { for (const value of values) { if (cursor === buffer.length) { chunks.push(buffer); buffer = new Uint8Array(65536); cursor = 0; } buffer[cursor++] = value; } };
  const word = (value: number) => write(value, value >>> 8), text = (value: string) => { for (const char of value) write(char.charCodeAt(0)); };
  const nearest = (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b, cached = colors.get(key); if (cached !== undefined) return cached;
    let index = 0, error = Infinity;
    for (let i = 0; i < palette!.length; i++) { const p = palette![i], delta = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2; if (delta < error) { index = i; error = delta; if (!error) break; } }
    if (colors.size < 131072) colors.set(key, index); return index;
  };
  const addFrame = (frame: GifFrame) => {
    if (finished) throw new Error('GIF编码器已结束。');
    if (frame.rgba.length !== width * height * 4 || !Number.isFinite(frame.delayMs) || frame.delayMs < 10 || frame.delayMs > 655350) throw new Error('GIF帧像素或延时无效。');
    if (!palette) { palette = scenePalette(frame.rgba); text('GIF89a'); word(width); word(height); write(0xf7, 0, 0); for (const rgb of palette) write(...rgb); if (loop) { write(0x21, 0xff, 11); text('NETSCAPE2.0'); write(3, 1, 0, 0, 0); } }
    write(0x21, 0xf9, 4, 4); word(Math.max(1, Math.round(frame.delayMs / 10))); write(0, 0);
    write(0x2c); word(0); word(0); word(width); word(height); write(0, 8);
    const block = new Uint8Array(255); let blockLength = 0, bits = 0, bitCount = 0, codeSize = 9, nextCode = 258; let dictionary = new Map<number, number>();
    const packed = (value: number) => { block[blockLength++] = value; if (blockLength === 255) { write(255); for (const byte of block) write(byte); blockLength = 0; } };
    const emit = (value: number) => { bits |= value << bitCount; bitCount += codeSize; while (bitCount >= 8) { packed(bits & 255); bits >>>= 8; bitCount -= 8; } };
    const indexAt = (pixel: number) => { const offset = pixel * 4, alpha = frame.rgba[offset + 3] / 255; return nearest(...[0, 1, 2].map(axis => Math.round(frame.rgba[offset + axis] * alpha + 255 * (1 - alpha))) as RGB); };
    emit(256); let prefix = indexAt(0);
    for (let pixel = 1; pixel < width * height; pixel++) {
      const suffix = indexAt(pixel), key = prefix * 256 + suffix, joined = dictionary.get(key);
      if (joined !== undefined) { prefix = joined; continue; }
      emit(prefix);
      if (nextCode < 4096) { dictionary.set(key, nextCode++); if (nextCode > 1 << codeSize && codeSize < 12) codeSize++; }
      else { emit(256); dictionary = new Map(); nextCode = 258; codeSize = 9; }
      prefix = suffix;
    }
    emit(prefix); if (nextCode === 1 << codeSize && codeSize < 12) codeSize++; emit(257); if (bitCount) packed(bits & 255);
    if (blockLength) { write(blockLength); for (let i = 0; i < blockLength; i++) write(block[i]); } write(0); count++;
  };
  const takeChunks = (): Uint8Array<ArrayBuffer>[] => {
    const output = [...chunks]; if (cursor) output.push(buffer.slice(0, cursor));
    chunks.length = 0; buffer = new Uint8Array(65536); cursor = 0; return output;
  };
  const finishChunks = (): Uint8Array<ArrayBuffer>[] => {
    if (!count || finished) throw new Error('GIF没有帧或已结束。'); write(0x3b); finished = true;
    const output = takeChunks(); buffer = new Uint8Array(0); colors.clear(); palette = null; return output;
  };
  const finish = (): Uint8Array<ArrayBuffer> => { const parts = finishChunks(), result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0)); let offset=0; for(const part of parts){result.set(part,offset);offset+=part.byteLength;} return result; };
  return { addFrame, finish, takeChunks, finishChunks };
}
export function encodeGif(width: number, height: number, frames: readonly GifFrame[], loop = true): Uint8Array<ArrayBuffer> {
  const encoder = createGifEncoder(width, height, loop); frames.forEach(frame => encoder.addFrame(frame)); return encoder.finish();
}
