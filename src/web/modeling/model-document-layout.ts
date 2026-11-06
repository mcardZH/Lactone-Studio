/** Presentation geometry only. Model documents, cameras and scientific state
 * never enter this module. Coordinates are in CSS pixels inside the deck. */
export interface DocumentPaneRect { x: number; y: number; width: number; height: number }
export type DocumentPaneResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export interface DocumentDeckSize { width: number; height: number }
export interface DocumentTileLayout {
  columns: number;
  rows: number;
  width: number;
  height: number;
  rects: DocumentPaneRect[];
  columnSizes: number[];
  rowSizes: number[];
  columnDividers: number[];
  rowDividers: number[];
}
export const DOCUMENT_PANE_GAP = 4;
export const DOCUMENT_PANE_MIN_WIDTH = 180;
export const DOCUMENT_PANE_MIN_HEIGHT = 160;
const PREFERRED_TILE_WIDTH = 240;
const PREFERRED_TILE_HEIGHT = 240;

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
export function documentDeckViewportSize(width:number,height:number):DocumentDeckSize{
 return{width:Math.max(1,Math.floor(finite(width,1))),height:Math.max(1,Math.floor(finite(height,1)))};
}
export function documentTileColumns(count: number, width: number): number {
  const preferred = count < 2 ? 1 : count === 2 || count === 4 ? 2 : 3;
  const fitting = Math.max(1, Math.floor((Math.max(0, finite(width, 0)) + DOCUMENT_PANE_GAP) / (PREFERRED_TILE_WIDTH + DOCUMENT_PANE_GAP)));
  return Math.min(preferred, fitting);
}

function distribute(total: number, count: number, weights?: readonly number[]): number[] {
  if (!count) return [];
  const usable = weights?.length === count && weights.every(value => Number.isFinite(value) && value > 0) ? weights : Array(count).fill(1) as number[];
  const sum = usable.reduce((value, weight) => value + weight, 0);
  const budget=Math.max(0,total);let allocated=0;
  return usable.map((weight,index)=>{const size=index===count-1?budget-allocated:budget*weight/sum;allocated+=size;return size;});
}
function offsets(sizes: readonly number[]): number[] {
  let position = 0;
  return sizes.map(size => { const result = position; position += size + DOCUMENT_PANE_GAP; return result; });
}

/** Up to six panes fill the available height. Further rows extend the scroll
 * surface rather than shrinking every viewport into a thumbnail. */
export function layoutDocumentTiles(count: number, size: DocumentDeckSize, columnWeights?: readonly number[], rowWeights?: readonly number[]): DocumentTileLayout {
  const total = Math.max(0, Math.floor(finite(count, 0)));
  const {width,height:availableHeight}=documentDeckViewportSize(size.width,size.height);
  const columns = documentTileColumns(total, width), rows = Math.ceil(total / columns);
  const visibleRows = Math.min(2, Math.max(1, rows));
  const rowHeight = Math.max(PREFERRED_TILE_HEIGHT, (availableHeight - DOCUMENT_PANE_GAP * (visibleRows - 1)) / visibleRows);
  const height = rows ? Math.max(availableHeight, rows * rowHeight + DOCUMENT_PANE_GAP * (rows - 1)) : availableHeight;
  const columnSizes = distribute(width - DOCUMENT_PANE_GAP * (columns - 1), columns, columnWeights);
  const rowSizes = distribute(height - DOCUMENT_PANE_GAP * Math.max(0, rows - 1), rows, rowWeights);
  const xs = offsets(columnSizes), ys = offsets(rowSizes);
  const rects = Array.from({ length: total }, (_, index) => ({
    x: xs[index % columns], y: ys[Math.floor(index / columns)],
    width: columnSizes[index % columns], height: rowSizes[Math.floor(index / columns)],
  }));
  return { columns, rows, width, height, rects, columnSizes, rowSizes,
    columnDividers: xs.slice(1).map(x => x - DOCUMENT_PANE_GAP), rowDividers: ys.slice(1).map(y => y - DOCUMENT_PANE_GAP) };
}

/** Resize exactly one adjacent pair while preserving every other track. */
export function resizeDocumentTracks(sizes: readonly number[], dividerIndex: number, delta: number, minimum: number): number[] {
  const result = [...sizes];
  if (!Number.isInteger(dividerIndex) || dividerIndex < 0 || dividerIndex + 1 >= sizes.length || !Number.isFinite(delta)) return result;
  const pair = sizes[dividerIndex] + sizes[dividerIndex + 1];
  const limit = Math.min(Math.max(0, minimum), pair / 2);
  const first = Math.max(limit, Math.min(pair - limit, sizes[dividerIndex] + delta));
  result[dividerIndex] = first; result[dividerIndex + 1] = pair - first;
  return result;
}

export function swapDocumentOrder(ids: readonly string[], source: string, target: string): string[] {
  const result = [...ids], from = ids.indexOf(source), to = ids.indexOf(target);
  if (from >= 0 && to >= 0) [result[from], result[to]] = [result[to], result[from]];
  return result;
}

export function documentPaneAtPoint(rects: readonly DocumentPaneRect[], point: { x: number; y: number }): number {
  return rects.findIndex(rect => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
}

/** Choose the top row's rightmost internal pane. Activation and stacking order
 * are intentionally absent: the shared legend belongs to presentation geometry. */
export function selectDocumentLegendHost(panes: readonly { id: string; rect: DocumentPaneRect }[]): string | null {
  let best: (typeof panes)[number] | undefined;
  for (const pane of panes) {
    const { x, y, width, height } = pane.rect;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    if (!best || y < best.rect.y || (y === best.rect.y && (
      x + width > best.rect.x + best.rect.width || (x + width === best.rect.x + best.rect.width && pane.id < best.id)
    ))) best = pane;
  }
  return best?.id ?? null;
}

export function moveDocumentPane(rect: DocumentPaneRect, dx: number, dy: number): DocumentPaneRect {
  return { ...rect, x: Math.max(0, rect.x + finite(dx, 0)), y: Math.max(0, rect.y + finite(dy, 0)) };
}
export function resizeDocumentPane(rect: DocumentPaneRect, dx: number, dy: number, direction: DocumentPaneResizeDirection = 'se'): DocumentPaneRect {
  const result = { ...rect }, moveX = finite(dx, 0), moveY = finite(dy, 0);
  if (direction.includes('e')) result.width = Math.max(DOCUMENT_PANE_MIN_WIDTH, rect.width + moveX);
  if (direction.includes('s')) result.height = Math.max(DOCUMENT_PANE_MIN_HEIGHT, rect.height + moveY);
  if (direction.includes('w')) {
    const change = Math.max(-rect.x, Math.min(rect.width - DOCUMENT_PANE_MIN_WIDTH, moveX));
    result.x = rect.x + change; result.width = rect.width - change;
  }
  if (direction.includes('n')) {
    const change = Math.max(-rect.y, Math.min(rect.height - DOCUMENT_PANE_MIN_HEIGHT, moveY));
    result.y = rect.y + change; result.height = rect.height - change;
  }
  return result;
}

/** Existing free positions survive mode changes, new documents and detachment. */
export function retainDocumentPaneRects(ids: readonly string[], current: Readonly<Record<string, DocumentPaneRect>>, fallback: readonly DocumentPaneRect[]): Record<string, DocumentPaneRect> {
  return Object.fromEntries(ids.map((id, index) => [id, current[id] ?? fallback[index] ?? { x: 0, y: 0, width: 480, height: 320 }]));
}
