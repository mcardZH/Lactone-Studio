import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { WORKBENCH_ACTIONS, type WorkbenchToolPlacement } from '../../modeling/workbench-layout';
import { conciseToolTooltip, createToolbarPointerIntent, packToolbarCells, placeToolbarTile, compactModelActionColumns, fitCompactModelActions, TOOLBAR_LONG_PRESS_MS, type ToolbarPlacementShape } from './toolbar-layout-ui';
import './workbench-tools.css';

export interface WorkbenchToolAction {
  id: string; label: string; content?: ReactNode; onActivate?(): void; disabled?: boolean;
  criticalContent?: ReactNode; essential?: boolean; kind?: 'action' | 'block';
  lockedSpan?: 1 | 2 | 3 | 4; tooltip?: string; reorderable?: boolean;
}
export interface ToolbarGridProps<T extends ToolbarPlacementShape = WorkbenchToolPlacement> {
  items: T[]; actions: WorkbenchToolAction[]; editMode: boolean; onChange(items: T[]): void;
  onExitEdit?(): void; onRequestEdit?(): void; columns?: 3 | 4;
}
/** Surface placements are supplied by the shell; command availability stays with its owner. */
export default function ToolbarGrid<T extends ToolbarPlacementShape = WorkbenchToolPlacement>({ items, actions, editMode:_editMode, onChange, onExitEdit, onRequestEdit:_onRequestEdit, columns = 4 }: ToolbarGridProps<T>) {
  // Old callers may still pass edit callbacks; no gesture may enter that mode.
  const editMode=false, onRequestEdit=undefined as ToolbarGridProps<T>['onRequestEdit'];
  const [message, setMessage] = useState(''), [dragging, setDragging] = useState<string | null>(null);
  const [paneCollapsed, setPaneCollapsed] = useState(false);
  const [actionColumns, setActionColumns] = useState<1 | 2 | 4>(4);
  const grid = useRef<HTMLElement>(null), cleanupPointer = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false), nativeDrag = useRef(false), dragId = useRef<string | null>(null), nativeOwner = useRef<string | null>(null);
  const latest = useRef({ items, actions, onChange, onRequestEdit, editMode }); latest.current = { items, actions, onChange, onRequestEdit, editMode };
  const placements = items.filter(item => actions.some(action => action.id === item.actionId));
  const positions = packToolbarCells(!editMode && columns === 4 ? fitCompactModelActions(placements, actionColumns) : placements, columns);
  const [dropPreview, setDropPreview] = useState<{ row: number; column: number; span: number; rowSpan: number } | null>(null);
  const cellAtPoint = (x: number, y: number) => {
    const node = grid.current; if (!node) return null;
    const bounds = node.getBoundingClientRect(); if (x < bounds.left || x > bounds.right || y < bounds.top) return null;
    const css = getComputedStyle(node), gap = parseFloat(css.columnGap) || 7, rowGap = parseFloat(css.rowGap) || 7;
    const column = Math.max(1, Math.min(columns, Math.floor((x - bounds.left) / ((bounds.width + gap) / columns)) + 1));
    const tracks = css.gridTemplateRows.split(' ').map(Number.parseFloat).filter(Number.isFinite);
    let row = 1, offset = bounds.top;
    for (const height of tracks) { if (y < offset + height + rowGap / 2) break; offset += height + rowGap; row++; }
    if (row > tracks.length) row += Math.max(0, Math.floor((y - offset) / (48 + rowGap)));
    return { row: Math.max(1, row - (latest.current.editMode ? 1 : 0)), column };
  };
  const dropAt = (id: string, x: number, y: number) => {
    const point = cellAtPoint(x, y); if (!point) return;
    latest.current.onChange(placeToolbarTile(latest.current.items, id, point, columns));
    setMessage(`${latest.current.actions.find(action => action.id === id)?.label ?? id} 已移动到第 ${point.row} 行、第 ${point.column} 列`);
  };
  useEffect(() => () => cleanupPointer.current?.(), []);
  useEffect(() => {
    const node = grid.current, pane = node?.closest('.workbench-tool-pane'), win = node?.ownerDocument.defaultView;
    if (!node || !win) return;
    const measure = () => {
      setPaneCollapsed((pane ?? node).clientWidth <= 48);
      const button = node.querySelector('.model-freeze-tools button');
      const font = parseFloat(win.getComputedStyle(button ?? node).fontSize) || 12;
      if (node.clientWidth > 0) setActionColumns(compactModelActionColumns(node.clientWidth, font));
    };
    const observer = win.ResizeObserver ? new win.ResizeObserver(measure) : null;
    observer?.observe(node); if (pane) observer?.observe(pane);
    const fonts = new win.MutationObserver(measure);
    fonts.observe(node.ownerDocument.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    measure(); return () => { observer?.disconnect(); fonts.disconnect(); };
  }, []);
  const previouslyEditing = useRef(editMode);
  useEffect(() => {
    if (previouslyEditing.current && !editMode) { cleanupPointer.current?.(); dragId.current = null; setDragging(null); }
    previouslyEditing.current = editMode;
  }, [editMode]);

  const beginPointerDrag = (event: ReactPointerEvent<HTMLElement>, id: string, immediate = false) => {
    if (event.button !== 0 || !event.isPrimary || (!immediate && !onRequestEdit)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!immediate && target?.closest('input,select,textarea,summary,a,[data-no-reorder],.workbench-critical-controls')) return;
    if (!immediate && target?.closest('button')?.hasAttribute('disabled')) return;
    cleanupPointer.current?.(); suppressClick.current = false; nativeDrag.current = false; nativeOwner.current = immediate ? id : null;
    const node = event.currentTarget, win = node.ownerDocument.defaultView!, intent = createToolbarPointerIntent();
    const pointerId = event.pointerId;
    let x = event.clientX, y = event.clientY, frame = 0, active = immediate, moved = false;
    const startX = x, startY = y;
    const startedAt = performance.now(); intent.start(pointerId, x, y, startedAt, immediate);
    const activate = () => {
      active = true; suppressClick.current = true; dragId.current = id; setDragging(id);
      latest.current.onRequestEdit?.();
      try { node.setPointerCapture(pointerId); } catch { /* Release can race the hold timer. */ }
      setMessage(`正在移动 ${latest.current.actions.find(action => action.id === id)?.label ?? id}`);
    };
    const timer = immediate ? undefined : win.setTimeout(() => { if (intent.activate(Math.max(performance.now(), startedAt + TOOLBAR_LONG_PRESS_MS))) activate(); }, TOOLBAR_LONG_PRESS_MS);
    const autoScroll = () => {
      if (active && moved && !nativeDrag.current) {
        let parent = grid.current?.parentElement;
        while (parent && parent.scrollHeight <= parent.clientHeight + 2) parent = parent.parentElement;
        if (parent) { const bounds = parent.getBoundingClientRect(); const delta = y < bounds.top + 28 ? -10 : y > bounds.bottom - 28 ? 10 : 0; if (delta) parent.scrollTop += delta; }
      }
      frame = win.requestAnimationFrame(autoScroll);
    };
    const pointerMove = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      x = next.clientX; y = next.clientY; moved ||= Math.hypot(x - startX, y - startY) >= 5; const result = intent.move(pointerId, x, y);
      if (result.cancelled && timer !== undefined) win.clearTimeout(timer);
      if (result.active) { next.preventDefault(); suppressClick.current = true; }
      if (result.active) { const point = cellAtPoint(x, y), placement = latest.current.items.find(item => item.actionId === id); setDropPreview(point && placement ? { ...point, span: placement.span, rowSpan: placement.rowSpan ?? 1 } : null); }
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const result = intent.finish(pointerId, next.type !== 'pointerup');
      suppressClick.current ||= result.consumeClick;
      if (result.consumeClick) { next.preventDefault(); next.stopPropagation(); }
      if (result.reorder && !nativeDrag.current) {
        dropAt(id, next.clientX, next.clientY);
      }
      cleanupPointer.current?.();
      // The generated release click is synchronous; a later independent click is not consumed.
      win.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const cancel = () => { suppressClick.current ||= intent.cancel(); cleanupPointer.current?.(); win.setTimeout(() => { suppressClick.current = false; }, 0); };
    const key = (next: KeyboardEvent) => {
      if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); cancel(); }
      else if (active) { next.preventDefault(); next.stopPropagation(); }
    };
    cleanupPointer.current = () => {
      if (timer !== undefined) win.clearTimeout(timer); win.cancelAnimationFrame(frame);
      win.removeEventListener('pointermove', pointerMove, true); win.removeEventListener('pointerup', finish, true); win.removeEventListener('pointercancel', finish, true);
      win.removeEventListener('blur', cancel); win.removeEventListener('keydown', key, true);
      try { if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId); } catch { /* Detached editor handle. */ }
      if (!nativeDrag.current) dragId.current = null; setDragging(null); setDropPreview(null); cleanupPointer.current = null;
    };
    win.addEventListener('pointermove', pointerMove, { capture: true, passive: false });
    win.addEventListener('pointerup', finish, true); win.addEventListener('pointercancel', finish, true);
    win.addEventListener('blur', cancel); win.addEventListener('keydown', key, true); frame = win.requestAnimationFrame(autoScroll);
    if (immediate) { active = true; setDragging(id); }
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>, id: string, edge: string) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation(); cleanupPointer.current?.(); suppressClick.current = true;
    const node = event.currentTarget, win = node.ownerDocument.defaultView!, pointerId = event.pointerId;
    const initialItems = latest.current.items, original = packToolbarCells(initialItems, columns).find(cell => cell.actionId === id)!;
    const x = event.clientX, y = event.clientY, bounds = grid.current!.getBoundingClientRect(), unit = (bounds.width + 7) / columns;
    let candidate = initialItems;
    const update = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return; next.preventDefault();
      const dx = Math.round((next.clientX - x) / unit), dy = Math.round((next.clientY - y) / 55);
      const left = edge.includes('w') ? Math.max(1, Math.min(original.column + original.span - 1, original.column + dx)) : original.column;
      const top = edge.includes('n') ? Math.max(1, Math.min(original.row + (original.rowSpan ?? 1) - 1, original.row + dy)) : original.row;
      const span = edge.includes('w') ? original.span + original.column - left : edge.includes('e') ? original.span + dx : original.span;
      const rowSpan = edge.includes('n') ? (original.rowSpan ?? 1) + original.row - top : edge.includes('s') ? (original.rowSpan ?? 1) + dy : original.rowSpan ?? 1;
      candidate = placeToolbarTile(initialItems, id, { column: left, row: top, span, rowSpan }, columns);
      latest.current.onChange(candidate);
    };
    const finish = (next: PointerEvent) => { if (next.pointerId !== pointerId) return; if (next.type === 'pointercancel') latest.current.onChange(initialItems); cleanupPointer.current?.(); win.setTimeout(() => { suppressClick.current = false; }, 0); };
    const cancel = () => { latest.current.onChange(initialItems); cleanupPointer.current?.(); };
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); cancel(); } };
    cleanupPointer.current = () => { win.removeEventListener('pointermove', update, true); win.removeEventListener('pointerup', finish, true); win.removeEventListener('pointercancel', finish, true); win.removeEventListener('keydown', key, true); win.removeEventListener('blur', cancel); if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId); cleanupPointer.current = null; };
    node.setPointerCapture(pointerId); win.addEventListener('pointermove', update, { capture: true, passive: false }); win.addEventListener('pointerup', finish, true); win.addEventListener('pointercancel', finish, true); win.addEventListener('keydown', key, true); win.addEventListener('blur', cancel);
  };

  return <>{paneCollapsed && <div className="workbench-pane-critical" aria-label="收拢工具区关键控制">{actions.filter(action => action.essential && action.criticalContent).map(action => <div key={action.id}>{action.criticalContent}</div>)}</div>}<section ref={grid} className={`workbench-tool-grid${editMode ? ' is-editing' : ''}`} style={{ '--tool-columns': columns, '--model-action-columns': editMode ? 4 : actionColumns } as CSSProperties}
    aria-label="工作台工具网格" data-layout-editing={editMode} data-grid-columns={columns} onPointerDownCapture={() => { suppressClick.current = false; }}
    onDragOver={event => { if (editMode && dragId.current) { event.preventDefault(); const point = cellAtPoint(event.clientX, event.clientY), item = items.find(item => item.actionId === dragId.current); if (point && item) setDropPreview({ ...point, span: item.span, rowSpan: item.rowSpan ?? 1 }); } }}
    onDrop={event => { if (editMode && dragId.current) { event.preventDefault(); dropAt(dragId.current, event.clientX, event.clientY); dragId.current = null; setDropPreview(null); } }}
    onKeyDown={event => { if (editMode) event.stopPropagation(); }} onKeyUp={event => { if (editMode) event.stopPropagation(); }}
    onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
    {editMode && <div className="workbench-grid-edit-banner">布局编辑中{onExitEdit && <button type="button" onClick={onExitEdit}>退出布局编辑</button>}</div>}
    {dropPreview && <div aria-hidden="true" className="workbench-drop-preview" style={{ gridColumn: `${Math.min(columns - dropPreview.span + 1, dropPreview.column)} / span ${dropPreview.span}`, gridRow: `${dropPreview.row + (editMode ? 1 : 0)} / span ${dropPreview.rowSpan}` }} />}
    {placements.map((item, index) => {
      const action = actions.find(entry => entry.id === item.actionId)!;
      const definition = WORKBENCH_ACTIONS.find(entry => entry.id === item.actionId);
      const kind = action.kind ?? definition?.kind ?? 'action';
      const position = positions[index];
      const update = (patch: Partial<ToolbarPlacementShape>) => onChange('span' in patch || 'rowSpan' in patch ? placeToolbarTile(items, item.actionId, patch, columns) : items.map(entry => entry.actionId === item.actionId ? { ...entry, ...patch } : entry));
      return <section key={item.actionId} className={`workbench-tool-cell workbench-tool-${kind}${dragging === item.actionId ? ' is-dragging' : ''}`}
        style={{ gridColumn: `${position.column} / span ${position.span}`, gridRow: `${position.row + (editMode ? 1 : 0)} / span ${position.rowSpan ?? 1}`, minHeight: (position.rowSpan ?? 1) * (editMode ? 48 : 30) }}
        data-action-id={item.actionId} data-tool-kind={kind} data-break-after={Boolean(item.breakAfter)} data-grid-row={position.row} data-grid-column={position.column} data-grid-row-span={position.rowSpan ?? 1}
        title={editMode ? undefined : conciseToolTooltip(action.label, action.tooltip)}
        onDragOver={event => { if (editMode && dragId.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
        >
        {editMode ? <>
          <button type="button" className="workbench-tool-handle" draggable={action.reorderable !== false} disabled={action.reorderable === false}
            aria-label={`移动${kind === 'block' ? '工具组' : '工具'} ${action.label}`} onPointerDown={event => beginPointerDrag(event, item.actionId, true)}
            onDragStart={event => {
              // Only a fresh down on an explicit layout-edit handle starts native drag.
              if (nativeOwner.current !== item.actionId) { event.preventDefault(); event.stopPropagation(); return; }
              nativeDrag.current = true; suppressClick.current = true; dragId.current = item.actionId; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.actionId);
            }}
            onDragEnd={() => { dragId.current = null; cleanupPointer.current?.(); }}
            onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0, vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0; onChange(placeToolbarTile(items, item.actionId, { column: position.column + horizontal, row: position.row + vertical }, columns)); }
            }}><span aria-hidden="true">⠿</span> {action.label}</button>
          <label className="workbench-tool-span">跨度<select aria-label={`${action.label} 网格跨度`} value={item.span} onChange={event => update({ span: Number(event.target.value) })}>
            {Array.from({ length: columns }, (_, i) => i + 1).map(span => <option key={span} value={span}>{span === columns ? '整行' : `${span}格`}</option>)}
          </select></label>
          <label className="workbench-tool-span">高度<select aria-label={`${action.label} 网格高度`} value={item.rowSpan ?? 1} onChange={event => update({ rowSpan: Number(event.target.value) })}>{Array.from({ length: 16 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}格</option>)}</select></label>
          <label className="workbench-tool-break"><input type="checkbox" aria-label={`${action.label} 后换行`} checked={Boolean(item.breakAfter)} onChange={event => update({ breakAfter: event.target.checked })} />后换行</label>
          {action.criticalContent && <div className="workbench-critical-controls" data-no-reorder>{action.criticalContent}</div>}
          {['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'].map(edge => <button key={edge} type="button" className={`workbench-tile-resize workbench-tile-resize-${edge}`} aria-label={`${action.label} 调整${edge}边缘`} onPointerDown={event => beginResize(event, item.actionId, edge)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); update({ span: position.span + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0), rowSpan: (position.rowSpan ?? 1) + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0) }); }} />)}
        </> : action.content ?? <button type="button" disabled={action.disabled} onClick={action.onActivate}>{action.label}</button>}
      </section>;
    })}
    <span className="workbench-sr-only" aria-live="polite">{message}</span>
  </section></>;
}
export { ToolbarGrid };
