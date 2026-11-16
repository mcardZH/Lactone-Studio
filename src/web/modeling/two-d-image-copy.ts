import { optimizationSvgPng } from '../results/optimization-export';

/** Snapshot the owned Ketcher drawing plane at its current pan and zoom.
 * Controls and gesture overlays live outside this SVG. */
export function captureTwoDBoardPng(svg: SVGSVGElement | undefined, owner: Document, signal: AbortSignal): Promise<Blob> {
  if (!svg?.isConnected || svg.ownerDocument !== owner || !owner.defaultView)
    throw new Error('当前二维画板不可用或已切换窗口。');
  const { width, height } = svg.getBoundingClientRect();
  if (!(width > 0 && height > 0)) throw new Error('当前二维画板不可见。');
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(Math.max(1, Math.round(width))));
  copy.setAttribute('height', String(Math.max(1, Math.round(height))));
  copy.style.removeProperty('width');
  copy.style.removeProperty('height');
  return optimizationSvgPng(new owner.defaultView.XMLSerializer().serializeToString(copy), owner, signal);
}
