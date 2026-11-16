interface Rect { x: number; y: number; width: number; height: number }
interface LegendText { text: string; x: number; y: number; color: string; font: string }
interface LegendMark {
  rect: Rect; color: string; kind: 'circle' | 'swatch' | 'path'; paths?: string[];
  border?: { color: string; width: number };
}
export interface ViewportLegendSnapshot {
  viewport: { width: number; height: number };
  panel: Rect; content: Rect;
  anchored: boolean;
  title: LegendText[];
  labels: LegendText[];
  marks: LegendMark[];
}

/** Read the public legend's projected labels and swatches in the exact
 * viewport host, including a legend portaled to that host. */
export function captureViewportLegend(stage: Element, documentId: string): ViewportLegendSnapshot | undefined {
  const host = stage.closest('[data-testid="model-viewport"]'), doc = stage.ownerDocument, win = doc.defaultView;
  if (!win || !host) return;
  const panel = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="model-region-legend"]'))
    .find(item => item.dataset.sourceDocumentId === documentId && item.dataset.expanded === 'true');
  const content = panel?.querySelector<HTMLElement>('.model-compact-legend-content');
  if (!panel || !content || win.getComputedStyle(panel).visibility !== 'visible') return;
  const view = stage.getBoundingClientRect(), box = panel.getBoundingClientRect(), clip = content.getBoundingClientRect();
  if (!view.width || !view.height || !box.width || !box.height) return;
  const relative = (bounds: DOMRect): Rect => ({ x: bounds.left - box.left, y: bounds.top - box.top, width: bounds.width, height: bounds.height });
  function labels(nodes: NodeListOf<Element>, visible: DOMRect): LegendText[] {
    const rows: LegendText[] = [];
    for (const node of nodes) {
      const bounds = node.getBoundingClientRect();
      if (bounds.bottom <= visible.top || bounds.top >= visible.bottom) continue;
      const style = win!.getComputedStyle(node), walker = doc.createTreeWalker(node, win!.NodeFilter.SHOW_TEXT);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const range = doc.createRange();
      for (let value = walker.nextNode(); value; value = walker.nextNode()) {
        const text = value.textContent ?? '';
        if (!text.trim()) continue;
        const push = (text: string, rect: DOMRect) => {
          if (rect.width && rect.height) rows.push({ text, x: rect.left - box.left, y: rect.top - box.top + rect.height / 2, color: style.color, font });
        };
        range.selectNodeContents(value);
        const pieces = range.getClientRects();
        if (pieces.length <= 1) { if (pieces[0]) push(text, pieces[0]); continue; }
        // Preserve the browser's line breaks for narrow or wrapped labels.
        let offset = 0, line = '', first: DOMRect | undefined;
        for (const character of text) {
          range.setStart(value, offset);
          offset += character.length;
          range.setEnd(value, offset);
          const rect = range.getBoundingClientRect();
          if (first && Math.abs(first.top - rect.top) > 1) { push(line, first); line = ''; first = undefined; }
          first ??= rect;
          line += character;
        }
        if (first) push(line, first);
      }
    }
    return rows;
  }
  const marks: LegendMark[] = [];
  for (const node of content.querySelectorAll('.model-compact-legend-sphere, .model-compact-legend-swatch, .model-compact-legend-scan, .model-compact-legend-row > svg')) {
    const bounds = node.getBoundingClientRect();
    if (bounds.bottom <= clip.top || bounds.top >= clip.bottom) continue;
    const style = win.getComputedStyle(node), rect = relative(bounds);
    if (node.localName === 'svg') {
      // The current snowflake/check icons are 24-unit line/path drawings.
      const paths = Array.from(node.querySelectorAll('path, line, polyline'), child => child.localName === 'path' ? child.getAttribute('d') ?? '' :
        child.localName === 'line' ? `M ${child.getAttribute('x1')} ${child.getAttribute('y1')} L ${child.getAttribute('x2')} ${child.getAttribute('y2')}` :
          `M ${child.getAttribute('points') ?? ''}`);
      marks.push({ rect, color: style.stroke, kind: 'path', paths });
    } else {
      const circle = node.classList.contains('model-compact-legend-sphere') || node.classList.contains('model-compact-legend-scan');
      const width = Number.parseFloat(style.borderTopWidth);
      const border = style.borderTopStyle === 'solid' && width > 0 ? { color: style.borderTopColor, width } : undefined;
      marks.push({ rect, color: style.backgroundColor, kind: circle ? 'circle' : 'swatch', border });
    }
  }
  return {
    viewport: { width: view.width, height: view.height },
    panel: { x: box.left - view.left, y: box.top - view.top, width: box.width, height: box.height },
    content: relative(clip), anchored: panel.dataset.position === 'anchored',
    title: labels(panel.querySelectorAll('.model-compact-legend-drag'), box),
    labels: labels(content.querySelectorAll('.model-compact-legend-group > strong, .model-compact-legend-row > span, .model-compact-legend-row > small, .model-compact-legend-scan, .model-compact-legend-scan-guide, .model-compact-legend-empty'), clip),
    marks
  };
}

/** Composite the scientific legend as text/vector marks on the owned output. */
export function drawViewportLegend(context: CanvasRenderingContext2D, legend: ViewportLegendSnapshot, width: number, height: number) {
  const { viewport, panel, content } = legend;
  const scale = Math.min(width / viewport.width, height / viewport.height);
  const x = legend.anchored ? width - (viewport.width - panel.x) * scale : panel.x * width / viewport.width;
  const y = legend.anchored ? panel.y * scale : panel.y * height / viewport.height;
  context.save();
  try {
    context.translate(Math.max(0, Math.min(width - panel.width * scale, x)), Math.max(0, Math.min(height - panel.height * scale, y)));
    context.scale(scale, scale);
    context.beginPath(); context.roundRect(0, 0, panel.width, panel.height, 6);
    context.fillStyle = '#fffffff0'; context.fill();
    context.strokeStyle = '#d2ded7'; context.lineWidth = 1; context.stroke();
    const text = (label: LegendText) => {
      context.font = label.font; context.textAlign = 'left'; context.textBaseline = 'middle';
      context.fillStyle = label.color; context.fillText(label.text, label.x, label.y);
    };
    legend.title.forEach(text);
    context.beginPath(); context.rect(content.x, content.y, content.width, content.height); context.clip();
    for (const { rect, color, kind, paths, border } of legend.marks) {
      if (kind === 'path') {
        context.save();
        try {
          context.translate(rect.x, rect.y); context.scale(rect.width / 24, rect.height / 24);
          context.strokeStyle = color; context.lineWidth = 2; context.lineCap = 'round'; context.lineJoin = 'round';
          const Path = context.canvas.ownerDocument.defaultView?.Path2D ?? Path2D;
          for (const path of paths ?? []) context.stroke(new Path(path));
        } finally { context.restore(); }
      } else {
        const radius = kind === 'circle' ? Math.min(rect.width, rect.height) / 2 : 3;
        context.beginPath();
        context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
        context.fillStyle = color; context.fill();
        if (border) {
          const inset = Math.min(border.width / 2, rect.width / 2, rect.height / 2);
          context.beginPath();
          context.roundRect(rect.x + inset, rect.y + inset, rect.width - 2 * inset, rect.height - 2 * inset, Math.max(0, radius - inset));
          context.strokeStyle = border.color; context.lineWidth = 2 * inset; context.stroke();
        }
      }
    }
    legend.labels.forEach(text);
  } finally { context.restore(); }
}
