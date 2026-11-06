/** Renderer-only packing and pointer intent. No command registry or model writes. */
export interface ToolbarPlacementShape { actionId: string; span: number; breakAfter?: boolean; row?: number; column?: number; rowSpan?: number }
export interface ToolbarCellPosition { actionId: string; row: number; column: number; span: number; rowSpan?: number }
const compactModelActions = new Set(['edit.add-h', 'edit.delete', 'bond.perceive', 'bond.display']);
export function compactModelActionColumns(width: number, fontSize: number): 1 | 2 | 4 {
  const minimum = Math.ceil(Math.max(12, fontSize) * 5.5 + 14);
  return width >= minimum * 4 + 12 ? 4 : width >= minimum * 2 + 4 ? 2 : 1;
}
/** Presentation-only expansion; explicit custom placements and saved widths remain intact. */
export function fitCompactModelActions<T extends ToolbarPlacementShape>(items: readonly T[], columns: 1 | 2 | 4): T[] {
  const minimumSpan = 4 / columns;
  return items.map(item => compactModelActions.has(item.actionId) && item.row === undefined && item.column === undefined && item.span < minimumSpan
    ? { ...item, span: minimumSpan } : item);
}
export function packToolbarCells(items: readonly ToolbarPlacementShape[], columns = 4): ToolbarCellPosition[] {
  const width = Number.isInteger(columns) && columns >= 1 && columns <= 4 ? columns : 4;
  let row = 1, column = 1;
  const occupied: ToolbarCellPosition[] = [];
  return items.map(item => {
    const span = Number.isInteger(item.span) ? Math.max(1, Math.min(width, item.span)) : 1;
    if (column + span - 1 > width) { row++; column = 1; }
    const explicit = Number.isInteger(item.row) && Number.isInteger(item.column);
    const height = Number.isInteger(item.rowSpan) ? Math.max(1, Math.min(16, item.rowSpan!)) : 1;
    const cell: ToolbarCellPosition = { actionId: item.actionId, row: explicit ? Math.max(1, Math.min(2048, item.row!)) : row, column: explicit ? Math.max(1, Math.min(width - span + 1, item.column!)) : column, span, ...(item.rowSpan ? { rowSpan: height } : {}) };
    while (occupied.some(other => toolbarCellsOverlap(cell, other))) cell.row++;
    occupied.push(cell);
    row = Math.max(row, cell.row); column = cell.column + span;
    if (column > width || item.breakAfter === true) { row = cell.row + height; column = 1; }
    return cell;
  });
}
export function toolbarCellsOverlap(a: ToolbarCellPosition, b: ToolbarCellPosition): boolean {
  return a.column < b.column + b.span && b.column < a.column + a.span && a.row < b.row + (b.rowSpan ?? 1) && b.row < a.row + (a.rowSpan ?? 1);
}
/** Keep every unaffected cell in place; a pinned move/resize pushes collisions downward in original order. */
export function placeToolbarTile<T extends ToolbarPlacementShape>(items: readonly T[], id: string, patch: Partial<Pick<ToolbarPlacementShape, 'row' | 'column' | 'span' | 'rowSpan'>>, columns = 4): T[] {
  if (!items.some(item => item.actionId === id) || Object.values(patch).some(value => !Number.isFinite(value))) return [...items];
  const width = Math.max(1, Math.min(4, Math.trunc(columns))), positions = packToolbarCells(items, width);
  const current = positions.find(cell => cell.actionId === id)!;
  const span = Math.max(1, Math.min(width, Math.round(patch.span ?? current.span)));
  const pinned: ToolbarCellPosition = { actionId: id, span, column: Math.max(1, Math.min(width - span + 1, Math.round(patch.column ?? current.column))), row: Math.max(1, Math.min(256, Math.round(patch.row ?? current.row))), rowSpan: Math.max(1, Math.min(16, Math.round(patch.rowSpan ?? current.rowSpan ?? 1))) };
  const occupied = [pinned], resolved = new Map<string, ToolbarCellPosition>([[id, pinned]]);
  for (const original of positions) {
    if (original.actionId === id) continue;
    const next = { ...original, rowSpan: original.rowSpan ?? 1 };
    while (occupied.some(other => toolbarCellsOverlap(next, other))) next.row++;
    occupied.push(next); resolved.set(next.actionId, next);
  }
  return items.map(item => { const cell = resolved.get(item.actionId)!; return { ...item, row: cell.row, column: cell.column, span: cell.span, rowSpan: cell.rowSpan }; });
}
export function moveToolbarPlacement<T extends ToolbarPlacementShape>(items: readonly T[], id: string, targetIndex: number): T[] {
  const next = [...items], index = next.findIndex(item => item.actionId === id);
  if (index < 0 || !Number.isFinite(targetIndex)) return next;
  const [entry] = next.splice(index, 1);
  next.splice(Math.max(0, Math.min(next.length, Math.trunc(targetIndex))), 0, entry);
  return next;
}
export const TOOLBAR_LONG_PRESS_MS = 500;
export const TOOLBAR_DRAG_THRESHOLD = 5;
/** A held button must consume its release click, including hold-without-motion. */
export function createToolbarPointerIntent() {
  let own: { pointerId: number; startX: number; startY: number; startedAt: number; active: boolean; moved: boolean; cancelled: boolean } | null = null;
  return {
    start(pointerId: number, x: number, y: number, now: number, immediate = false) {
      own = { pointerId, startX: x, startY: y, startedAt: now, active: immediate, moved: false, cancelled: false };
    },
    activate(now: number) {
      if (!own || own.cancelled || now - own.startedAt < TOOLBAR_LONG_PRESS_MS) return false;
      own.active = true; return true;
    },
    move(pointerId: number, x: number, y: number) {
      if (!own || own.pointerId !== pointerId) return { active: false, cancelled: false };
      own.moved ||= Math.hypot(x - own.startX, y - own.startY) >= TOOLBAR_DRAG_THRESHOLD;
      if (own.moved && !own.active) own.cancelled = true;
      return { active: own.active && !own.cancelled, cancelled: own.cancelled };
    },
    finish(pointerId: number, cancelled = false) {
      if (!own || own.pointerId !== pointerId) return { consumeClick: false, reorder: false };
      const result = { consumeClick: own.active || own.moved, reorder: !cancelled && !own.cancelled && own.active && own.moved };
      own = null; return result;
    },
    cancel() { const consumeClick = Boolean(own && (own.active || own.moved)); own = null; return consumeClick; },
  };
}
export function conciseToolTooltip(label: string, description?: string): string | undefined {
  const text = description?.trim();
  if (!text || text === label.trim()) return undefined;
  return text.replace(/\s+/g, ' ');
}
