import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import './canvas-clear-toolbar.css';

export type CanvasToolbarDock = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface CanvasClearToolbarProps {
  onClearSelection(): void;
  onClearFrozen(): void;
  onClearCoordinates(): void;
  disabled?: boolean;
  frozenDisabled?: boolean;
  /** Optional controlled UI preference. Omit to keep position local to this view. */
  dock?: CanvasToolbarDock;
  onDockChange?(dock: CanvasToolbarDock): void;
  containerRef?: RefObject<HTMLElement | null>;
}
export const CANVAS_TOOLBAR_DRAG_THRESHOLD = 6;
export function canvasToolbarDockAt(x: number, y: number, width: number, height: number): CanvasToolbarDock {
  return `${y < height / 2 ? 'top' : 'bottom'}-${x < width / 2 ? 'left' : 'right'}`;
}
export function canvasToolbarDockByKey(dock: CanvasToolbarDock, key: string): CanvasToolbarDock {
  const [vertical, horizontal] = dock.split('-');
  if (key === 'Home') return 'top-left';
  if (key === 'End') return 'bottom-right';
  if (key === 'ArrowLeft' || key === 'ArrowRight') return `${vertical}-${key === 'ArrowLeft' ? 'left' : 'right'}` as CanvasToolbarDock;
  if (key === 'ArrowUp' || key === 'ArrowDown') return `${key === 'ArrowUp' ? 'top' : 'bottom'}-${horizontal}` as CanvasToolbarDock;
  return dock;
}
export function clampCanvasToolbarPosition(x: number, y: number, width: number, height: number, toolbarWidth: number, toolbarHeight: number, margin = 8) {
  const safeWidth = Math.max(0, width - toolbarWidth), safeHeight = Math.max(0, height - toolbarHeight);
  return { x: Math.max(Math.min(margin, safeWidth), Math.min(Math.max(0, safeWidth - margin), x)), y: Math.max(Math.min(margin, safeHeight), Math.min(Math.max(0, safeHeight - margin), y)) };
}
/** This gesture owns no scientific/model state, and a released drag cannot become a clear action. */
export function createCanvasToolbarDragIntent() {
  let start: { pointerId: number; x: number; y: number; dragging: boolean } | null = null;
  return {
    start(pointerId: number, x: number, y: number) { start = { pointerId, x, y, dragging: false }; },
    move(pointerId: number, x: number, y: number) {
      if (!start || start.pointerId !== pointerId) return { dragging: false, dx: 0, dy: 0 };
      const dx = x - start.x, dy = y - start.y;
      start.dragging ||= Math.hypot(dx, dy) >= CANVAS_TOOLBAR_DRAG_THRESHOLD;
      return { dragging: start.dragging, dx, dy };
    },
    finish(pointerId: number, cancel = false) {
      if (!start || start.pointerId !== pointerId) return { dock: false, consumeClick: false };
      const result = { dock: start.dragging && !cancel, consumeClick: start.dragging };
      start = null; return result;
    },
  };
}

export default function CanvasClearToolbar({ onClearSelection, onClearFrozen, onClearCoordinates, disabled = false, frozenDisabled = false, dock, onDockChange, containerRef }: CanvasClearToolbarProps) {
  const [localDock, setLocalDock] = useState<CanvasToolbarDock>('top-left'), [freePosition, setFreePosition] = useState<{ x: number; y: number } | null>(null);
  const currentDock = dock ?? localDock, toolbar = useRef<HTMLDivElement>(null), suppressClick = useRef(false);
  const gesture = useRef(createCanvasToolbarDragIntent()), drag = useRef<{ pointerId: number; startX: number; startY: number; width: number; height: number; toolbarWidth: number; toolbarHeight: number; x: number; y: number } | null>(null);
  const setDock = (value: CanvasToolbarDock) => { setLocalDock(value); onDockChange?.(value); setFreePosition(null); };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    const node = toolbar.current, container = containerRef?.current ?? node?.parentElement;
    if (!node || !container) return;
    const outer = container.getBoundingClientRect(), own = node.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, startX: own.left - outer.left, startY: own.top - outer.top, width: outer.width, height: outer.height, toolbarWidth: own.width, toolbarHeight: own.height, x: own.left - outer.left, y: own.top - outer.top };
    suppressClick.current = false; gesture.current.start(event.pointerId, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const outcome = gesture.current.finish(event.pointerId, cancel), own = drag.current;
    if (!own) return;
    event.preventDefault(); event.stopPropagation(); suppressClick.current = outcome.consumeClick;
    if (outcome.dock) setDock(canvasToolbarDockAt(own.x + own.toolbarWidth / 2, own.y + own.toolbarHeight / 2, own.width, own.height));
    else setFreePosition(null);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={toolbar} className="canvas-clear-toolbar" role="toolbar" aria-label="建模清空工具" data-dock={currentDock} data-dragging={Boolean(freePosition)} style={freePosition ? { left: freePosition.x, top: freePosition.y, right: 'auto', bottom: 'auto' } as CSSProperties : undefined}
    onPointerDownCapture={() => { suppressClick.current = false; }} onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
    onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }} onClick={event => event.stopPropagation()}>
    <button type="button" className="canvas-clear-toolbar-handle" aria-label="移动清空工具条" title="拖到四角停靠；方向键选停靠角" onPointerDown={beginDrag}
      onPointerMove={event => {
        const own = drag.current; if (!own) return;
        const result = gesture.current.move(event.pointerId, event.clientX, event.clientY); if (!result.dragging) return;
        event.preventDefault(); event.stopPropagation(); suppressClick.current = true;
        const next = clampCanvasToolbarPosition(own.startX + result.dx, own.startY + result.dy, own.width, own.height, own.toolbarWidth, own.toolbarHeight);
        own.x = next.x; own.y = next.y; setFreePosition(next);
      }} onPointerUp={event => finishDrag(event)} onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={() => { if (drag.current) gesture.current.finish(drag.current.pointerId, true); drag.current = null; setFreePosition(null); }}
      onKeyDown={event => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); const pointerId = drag.current.pointerId; suppressClick.current = gesture.current.finish(pointerId, true).consumeClick; drag.current = null; setFreePosition(null); if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId); return; } if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setDock(canvasToolbarDockByKey(currentDock, event.key)); } }}><span aria-hidden="true">⠿</span></button>
    <button type="button" aria-label="清空选择" title="清空选择" disabled={disabled} onClick={onClearSelection}>清选</button>
    <button type="button" aria-label="清空冻结" title="清空冻结" disabled={disabled || frozenDisabled} onClick={onClearFrozen}>解冻</button>
    <button type="button" aria-label="清空内坐标" title="清空内坐标" disabled={disabled} onClick={onClearCoordinates}>清内坐标</button>
  </div>;
}
