'use strict';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function pngBuffer(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('剪贴板图像必须是 PNG 字节。');
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (png.length < 57 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR' || !png.subarray(-12).equals(PNG_END))
    throw new Error('剪贴板 PNG 内容不完整。');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || !Number.isSafeInteger(width * height * 4)) throw new Error('剪贴板 PNG 尺寸无效。');
  return { png, width, height };
}

/** Main owns the latest image intent across all renderers. The actual write is
 * synchronous, so a newer intent cannot interleave between validation and commit. */
function createImageClipboard({ writePng, onSuperseded }) {
  let counter = 0;
  let latest = null;
  return {
    begin(owner) {
      const previous = latest;
      latest = { owner, token: ++counter };
      if (previous) onSuperseded?.(previous.owner, previous.token);
      return latest.token;
    },
    write(owner, token, bytes) {
      if (!latest || latest.owner !== owner || latest.token !== token) return false;
      latest = null;
      const { png, width, height } = pngBuffer(bytes);
      writePng(png, { width, height });
      return true;
    },
    cancel(owner, token) {
      if (latest?.owner === owner && (token === undefined || latest.token === token)) latest = null;
    }
  };
}

module.exports = { createImageClipboard };
