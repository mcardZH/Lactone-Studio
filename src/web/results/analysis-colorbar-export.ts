import { analysisColorbarStops, analysisColorbarValues, type AnalysisColorbar } from './analysis-display';
import { displayedColorbarViewport, FALLBACK_COLORBAR_VIEWPORT, resolveAnalysisColorbarRect, type AnalysisColorbarSize } from './analysis-colorbar-layout';
import { exportBlob } from './export-image';

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));

/** A tightly cropped, transparent legend with the same physical scale and styling. */
export function analysisColorbarSvg(colorbar: AnalysisColorbar, sourceViewport = FALLBACK_COLORBAR_VIEWPORT): string {
  const rect = resolveAnalysisColorbarRect(colorbar.layout, sourceViewport, colorbar.label, 1, analysisColorbarValues(colorbar));
  const { width, height, gradient, text } = rect;
  const direction = rect.orientation === 'vertical' ? 'x1="0%" y1="100%" x2="0%" y2="0%"' : 'x1="0%" y1="0%" x2="100%" y2="0%"';
  const stops = analysisColorbarStops(colorbar).map(({ color, offset }) => `<stop offset="${offset * 100}%" stop-color="${xml(color)}"/>`).join('');
  const labels = text.map(({ text, x, baseline, anchor }) => `<text x="${x}" y="${baseline}" text-anchor="${anchor}">${xml(text)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}"><defs><linearGradient id="legend" ${direction}>${stops}</linearGradient></defs><rect x="${gradient.x}" y="${gradient.y}" width="${gradient.width}" height="${gradient.height}" fill="url(#legend)"/><g fill="${rect.ink}" font-family="${xml(rect.fontFamily)}" font-size="${rect.fontSize}">${labels}</g></svg>`;
}

export async function exportAnalysisColorbar(colorbar: AnalysisColorbar, format: 'svg' | 'png', doc: Document = document): Promise<void> {
  const svg = analysisColorbarSvg(colorbar, displayedColorbarViewport(colorbar.sourceKey, doc));
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  if (format === 'svg') { exportBlob(blob, 'Ester-Studio-colorbar.svg', doc); return; }
  const win = doc.defaultView;
  if (!win) throw new Error('当前窗口无法导出色标。');
  const url = win.URL.createObjectURL(blob);
  try {
    const image = new win.Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('色标图片生成失败。'));
      image.src = url;
    });
    const canvas = doc.createElement('canvas');
    canvas.width = image.width * 2;
    canvas.height = image.height * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法导出 PNG 色标。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG 色标生成失败。')), 'image/png'));
    exportBlob(png, 'Ester-Studio-colorbar.png', doc);
  } finally { win.URL.revokeObjectURL(url); }
}

export function drawAnalysisColorbar(context: CanvasRenderingContext2D, colorbar: AnalysisColorbar,
  size: AnalysisColorbarSize, sourceViewport?: AnalysisColorbarSize) {
  const scale = sourceViewport && [sourceViewport.width, sourceViewport.height].every(value => Number.isFinite(value) && value > 0)
    ? Math.min(size.width / sourceViewport.width, size.height / sourceViewport.height) : 1;
  const rect = resolveAnalysisColorbarRect(colorbar.layout, size, colorbar.label, scale, analysisColorbarValues(colorbar));
  const { width, height } = rect.gradient;
  const x = rect.left + rect.gradient.x, y = rect.top + rect.gradient.y;
  context.save();
  const gradient = rect.orientation === 'vertical'
    ? context.createLinearGradient(x, y + height, x, y)
    : context.createLinearGradient(x, y, x + width, y);
  analysisColorbarStops(colorbar).forEach(({ color, offset }) => gradient.addColorStop(offset, color));
  context.fillStyle = gradient;
  context.fillRect(x, y, width, height);
  context.fillStyle = rect.ink;
  context.font = `${rect.fontSize}px ${rect.fontFamily}`;
  context.textBaseline = 'alphabetic';
  for (const { text, x, baseline, anchor } of rect.text) {
    context.textAlign = anchor === 'end' ? 'right' : 'left';
    context.fillText(text, rect.left + x, rect.top + baseline);
  }
  context.restore();
  return rect;
}
