import { assertResultNotAborted } from '../../results/contracts';
import { canvasPng } from './export-image';
import { plotFontCss } from './ScientificPlotSettings';

/** Export the actual visible vector figure, including its title/axes/reference metadata. */
export function serializeOptimizationSvg(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  copy.setAttribute('width', String(viewBox?.[2] || Number(svg.getAttribute('width')) || 900));
  copy.setAttribute('height', String(viewBox?.[3] || Number(svg.getAttribute('height')) || 330));
  copy.removeAttribute('class'); copy.removeAttribute('data-testid');
  if (!svg.getAttribute('font-family')) copy.setAttribute('font-family', 'Arial, Microsoft YaHei, sans-serif');
  if (/(?:SciYue|Ester Studio) DejaVu Sans/.test(svg.getAttribute('font-family') ?? '')) {
    copy.setAttribute('font-family', copy.getAttribute('font-family')!.replaceAll('SciYue DejaVu Sans', 'Ester Studio DejaVu Sans'));
    const style = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = plotFontCss; copy.insertBefore(style, copy.firstChild);
  }
  copy.querySelectorAll('[tabindex], [role], [aria-pressed]').forEach(node => {
    node.removeAttribute('tabindex'); node.removeAttribute('role'); node.removeAttribute('aria-pressed');
  });
  copy.querySelectorAll('[data-plot-interaction]').forEach(node => node.remove());
  const Serializer = svg.ownerDocument.defaultView?.XMLSerializer ?? XMLSerializer;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new Serializer().serializeToString(copy);
}

/** Rasterize a captured SVG at 2x resolution on an owned, detached canvas. */
export async function optimizationSvgPng(svgText: string, ownerDocument: Document, signal?: AbortSignal): Promise<Blob> {
  assertResultNotAborted(signal);
  const realm = ownerDocument.defaultView;
  if (!realm) throw new Error('图像导出窗口已关闭。');
  const image = ownerDocument.createElement('img');
  const urls = realm.URL;
  // Chromium keeps vector-effect strokes at device size when an SVG image is
  // rasterized above its intrinsic dimensions. Compensate only those strokes;
  // ordinary axes and text already scale with the PNG canvas.
  const parsed = new realm.DOMParser().parseFromString(svgText, 'image/svg+xml'), root = parsed.documentElement;
  const scaleHint = 2;
  root.querySelectorAll('[vector-effect="non-scaling-stroke"]').forEach(node => {
    const width = Number(node.getAttribute('stroke-width')); if (Number.isFinite(width) && width > 0) node.setAttribute('stroke-width', String(width * scaleHint));
  });
  const pngSvg = new realm.XMLSerializer().serializeToString(root);
  const url = urls.createObjectURL(new Blob([pngSvg], { type: 'image/svg+xml;charset=utf-8' }));
  const canvas = ownerDocument.createElement('canvas');
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); image.src = ''; reject(new DOMException('能量图导出已取消。', 'AbortError')); };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error('能量图SVG解码失败。')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      image.src = url;
    });
    assertResultNotAborted(signal);
    const scale = 2;
    canvas.width = Math.max(1, Math.round((image.naturalWidth || 900) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || 330) * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('能量图PNG画布不可用。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasPng(canvas, signal);
  } finally { urls.revokeObjectURL(url); image.src = ''; canvas.width = 0; canvas.height = 0; }
}
