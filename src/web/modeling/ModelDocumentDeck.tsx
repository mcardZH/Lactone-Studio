import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  DOCUMENT_PANE_GAP, DOCUMENT_PANE_MIN_HEIGHT, DOCUMENT_PANE_MIN_WIDTH,
  documentPaneAtPoint, layoutDocumentTiles, moveDocumentPane, resizeDocumentPane,
  documentDeckViewportSize,
  resizeDocumentTracks, retainDocumentPaneRects, selectDocumentLegendHost, swapDocumentOrder,
  type DocumentDeckSize, type DocumentPaneRect, type DocumentPaneResizeDirection,
} from './model-document-layout';
import './model-document-deck.css';
import { createViewportActivationPointerGate, viewportActivationTarget } from './viewport-activation-pointer';
import {publishViewportLayoutResize} from './render/resize-lifecycle';
import {useProjectState} from '../../projects/ui-state';

export type ModelDocumentDeckMode = 'single' | 'tiled' | 'free';
export interface ModelDocumentDeckDocument {
  id: string; label: string; content: ReactNode; docked: boolean;
  /** Optional presentation chrome; drag/resize still belong to this deck. */
  handleContent?: ReactNode;
  headerActions?: ReactNode;
}
export interface ModelDocumentDeckProps {
  documents: readonly ModelDocumentDeckDocument[];
  activeId: string;
  mode: ModelDocumentDeckMode;
  onActivate(id: string): void;
  /** Read the actual owner synchronously before capture activates this pane. */
  isDocumentInteractionOwner?(id: string): boolean;
  onReorder(ids: string[]): void;
  /** One internal, visible pane selected by geometry, independent of activation. */
  onLegendHostChange?(id: string | null): void;
  arrangeRequest?: number;
  /** Independent presentation contexts retain their splitter proportions. */
  layoutKey?: string;
  className?: string;
}
type PaneGesture = { kind: 'move' | 'resize' | 'reorder'; id: string; pointerId: number; startX: number; startY: number; scrollX: number; scrollY: number; rect: DocumentPaneRect; moved: boolean; direction: DocumentPaneResizeDirection; extent: DocumentDeckSize };
type TrackGesture = { kind: 'track'; axis: 'column' | 'row'; index: number; pointerId: number; start: number; sizes: number[]; key: string };
type Gesture = PaneGesture | TrackGesture;
type TrackWeights = Record<string, number[]>;
const RESIZE_DIRECTIONS: readonly { direction: DocumentPaneResizeDirection; label: string }[] = [
  { direction: 'n', label: '上边缘' }, { direction: 'ne', label: '右上角' }, { direction: 'e', label: '右边缘' }, { direction: 'se', label: '右下角' },
  { direction: 's', label: '下边缘' }, { direction: 'sw', label: '左下角' }, { direction: 'w', label: '左边缘' }, { direction: 'nw', label: '左上角' },
];

export function ModelDocumentDeck({ documents, activeId, mode, onActivate, isDocumentInteractionOwner, onReorder, onLegendHostChange, arrangeRequest = 0, layoutKey = '', className = '' }: ModelDocumentDeckProps) {
  const root = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null);
  const resizeRelease=useRef<number|null>(null);
  const activationPointer = useRef(createViewportActivationPointerGate());
  const [size, setSize] = useState<DocumentDeckSize>({ width: 960, height: 640 });
  const [freeRects, setFreeRects] = useProjectState<Record<string, DocumentPaneRect>>('document-deck.freeRects',{},layoutKey||'workspace-models');
  const [tracks, setTracks] = useProjectState<TrackWeights>('document-deck.tracks',{},layoutKey||'workspace-models');
  const [raised, setRaised] = useProjectState<string[]>('document-deck.raised',[],layoutKey||'workspace-models');
  const [scroll,setScroll]=useProjectState('document-deck.scroll',{left:0,top:0},layoutKey||'workspace-models');
  useLayoutEffect(()=>{const node=root.current;if(node){node.scrollLeft=scroll.left;node.scrollTop=scroll.top;}},[layoutKey]);
  const [dragging, setDragging] = useState<string | null>(null), [dropTarget, setDropTarget] = useState<string | null>(null);
  const previousArrange = useRef(arrangeRequest);
  const docked = documents.filter(document => document.docked);
  const dockedKey = JSON.stringify(docked.map(document => document.id));
  const basic = layoutDocumentTiles(docked.length, size);
  const columnKey = `${layoutKey}:columns:${basic.columns}`, rowKey = `${layoutKey}:rows:${basic.rows}`;
  const tiled = layoutDocumentTiles(docked.length, size, tracks[columnKey], tracks[rowKey]);
  const legendHostId = selectDocumentLegendHost(docked.flatMap((document, index) => {
    if (mode === 'single' && document.id !== activeId) return [];
    return [{ id: document.id, rect: mode === 'single' ? { x: 0, y: 0, width: size.width, height: size.height }
      : mode === 'free' ? freeRects[document.id] ?? tiled.rects[index] : tiled.rects[index] }];
  }));
  const latest = useRef({ documents, docked, tiled, mode, onActivate, onReorder, freeRects });
  latest.current = { documents, docked, tiled, mode, onActivate, onReorder, freeRects };
  function layoutSizing(active:boolean,afterCommit=false){
    const node=root.current;if(!node)return;const win=node.ownerDocument.defaultView!;
    if(resizeRelease.current!==null)win.cancelAnimationFrame(resizeRelease.current);resizeRelease.current=null;
    if(afterCommit){resizeRelease.current=win.requestAnimationFrame(()=>{resizeRelease.current=null;publishViewportLayoutResize(node,active);});}
    else publishViewportLayoutResize(node,active);
  }

  useLayoutEffect(() => { onLegendHostChange?.(legendHostId); }, [legendHostId, onLegendHostChange]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const win=node.ownerDocument.defaultView!;let frame:number|null=null;
    const measure = () => {
      frame=null;const next = documentDeckViewportSize(node.clientWidth,node.clientHeight);
      setSize(before => before.width === next.width && before.height === next.height ? before : next);
    };
    measure();
    const observer = new ResizeObserver(()=>{if(frame===null)frame=win.requestAnimationFrame(measure);}); observer.observe(node);
    return () => {observer.disconnect();if(frame!==null)win.cancelAnimationFrame(frame);layoutSizing(false);};
  }, []);

  useLayoutEffect(() => {
    if (mode !== 'free') return;
    if (root.current && (root.current.clientWidth !== size.width || root.current.clientHeight !== size.height)) return;
    // Seed from the current tiled geometry only once per document. Leaving for
    // single mode, reordering tabs, or detaching never rewrites existing boxes.
    const current = latest.current;
    setFreeRects(before => {
      if (current.docked.every(document => before[document.id])) return before;
      const additions = retainDocumentPaneRects(current.docked.map(document => document.id), before, current.tiled.rects);
      return { ...before, ...additions };
    });
  }, [mode, dockedKey, size]);

  useLayoutEffect(() => {
    if (previousArrange.current === arrangeRequest) return;
    previousArrange.current = arrangeRequest;
    layoutSizing(false);
    gesture.current = null; setDragging(null); setDropTarget(null);
    setTracks(before => Object.fromEntries(Object.entries(before).filter(([key]) => !key.startsWith(`${layoutKey}:columns:`) && !key.startsWith(`${layoutKey}:rows:`))));
    const current = latest.current, arranged = layoutDocumentTiles(current.docked.length, size);
    setFreeRects(before => ({ ...before, ...Object.fromEntries(current.docked.map((document, index) => [document.id, arranged.rects[index]])) }));
    root.current?.scrollTo({ left: 0, top: 0 });
  }, [arrangeRequest, size]);

  useLayoutEffect(() => {
    layoutSizing(false);
    gesture.current = null; setDragging(null); setDropTarget(null);
  }, [mode, dockedKey]);

  useLayoutEffect(() => {
    raise(activeId);
  }, [activeId,mode,dockedKey]);

  function raise(id:string) {
    const current=latest.current;
    if(current.mode!=='free'||!id||!current.docked.some(document=>document.id===id))return;
    setRaised(before => before[before.length - 1] === id ? before : [...before.filter(value => value !== id), id]);
  }
  function activate(id: string) {
    const current=latest.current;
    if(!id||!current.docked.some(document=>document.id===id))return;
    raise(id);
    current.onActivate(id);
  }
  function startPane(event: ReactPointerEvent<HTMLButtonElement>, id: string, kind: PaneGesture['kind'], direction: DocumentPaneResizeDirection = 'se') {
    if (event.button !== 0) return;
    const current = latest.current, index = current.docked.findIndex(document => document.id === id);
    if (index < 0 || current.mode === 'single') return;
    event.preventDefault(); event.stopPropagation();
    if(kind==='resize')layoutSizing(true);
    const rect = current.mode === 'free' ? current.freeRects[id] ?? current.tiled.rects[index] : current.tiled.rects[index];
    gesture.current = { kind, id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      scrollX: root.current?.scrollLeft ?? 0, scrollY: root.current?.scrollTop ?? 0, rect, moved: false, direction,
      extent: { width: root.current?.scrollWidth ?? size.width, height: root.current?.scrollHeight ?? size.height } };
    setDragging(id); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function startTrack(event: ReactPointerEvent<HTMLDivElement>, axis: TrackGesture['axis'], index: number) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    layoutSizing(true);
    gesture.current = { kind: 'track', axis, index, pointerId: event.pointerId, start: axis === 'column' ? event.clientX : event.clientY,
      sizes: [...(axis === 'column' ? tiled.columnSizes : tiled.rowSizes)], key: axis === 'column' ? columnKey : rowKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function continueGesture(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current, node = root.current;
    if (!current || event.pointerId !== current.pointerId || !node) return;
    event.preventDefault(); event.stopPropagation();
    if (current.kind === 'track') {
      const delta = (current.axis === 'column' ? event.clientX : event.clientY) - current.start;
      const updated = resizeDocumentTracks(current.sizes, current.index, delta, current.axis === 'column' ? DOCUMENT_PANE_MIN_WIDTH : DOCUMENT_PANE_MIN_HEIGHT);
      setTracks(before => ({ ...before, [current.key]: updated })); return;
    }
    const dx = event.clientX - current.startX + node.scrollLeft - current.scrollX;
    const dy = event.clientY - current.startY + node.scrollTop - current.scrollY;
    if (Math.hypot(dx, dy) > 3) current.moved = true;
    if (current.kind === 'reorder') {
      const bounds = node.getBoundingClientRect();
      const index = documentPaneAtPoint(latest.current.tiled.rects, { x: event.clientX - bounds.left + node.scrollLeft, y: event.clientY - bounds.top + node.scrollTop });
      const target = latest.current.docked[index]?.id;
      setDropTarget(target && target !== current.id ? target : null);
    } else {
      const next = current.kind === 'move' ? moveDocumentPane(current.rect, dx, dy) : resizeDocumentPane(current.rect, dx, dy, current.direction);
      setFreeRects(before => ({ ...before, [current.id]: next }));
    }
  }
  function endGesture(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (cancelled) {
      if (current.kind === 'track') setTracks(before => ({ ...before, [current.key]: current.sizes }));
      else if (current.kind !== 'reorder') setFreeRects(before => ({ ...before, [current.id]: current.rect }));
    }
    if (!cancelled) continueGesture(event);
    if (!cancelled && current.kind === 'reorder' && current.moved && root.current) {
      const node = root.current, bounds = node.getBoundingClientRect();
      const index = documentPaneAtPoint(latest.current.tiled.rects, { x: event.clientX - bounds.left + node.scrollLeft, y: event.clientY - bounds.top + node.scrollTop });
      const target = latest.current.docked[index]?.id;
      if (target && target !== current.id) latest.current.onReorder(swapDocumentOrder(latest.current.documents.map(document => document.id), current.id, target));
    }
    gesture.current = null; setDragging(null); setDropTarget(null);
    if(current.kind==='track'||current.kind==='resize')layoutSizing(false,true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const pointerHandlers = { onPointerMove: continueGesture, onPointerUp: (event: ReactPointerEvent<HTMLElement>) => endGesture(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => endGesture(event, true),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => endGesture(event, true) };

  let stageWidth = size.width, stageHeight = mode === 'tiled' ? tiled.height : size.height;
  if (mode === 'free') for (const [index, document] of docked.entries()) {
    const rect = freeRects[document.id] ?? tiled.rects[index];
    stageWidth = Math.max(stageWidth, rect.x + rect.width); stageHeight = Math.max(stageHeight, rect.y + rect.height);
  }
  // A shrinking pane must not shrink the scroll range during its own drag:
  // automatic scrollTop clamping would otherwise feed back into the pointer
  // delta and resize it twice. Actual user scrolling remains compensated.
  const activeGesture = gesture.current;
  if (mode === 'free' && activeGesture && activeGesture.kind !== 'track') {
    stageWidth = Math.max(stageWidth, activeGesture.extent.width); stageHeight = Math.max(stageHeight, activeGesture.extent.height);
  }
  return <div ref={root} className={`model-document-deck ${className}`} data-testid="model-document-deck" data-mode={mode} onScroll={event=>setScroll({left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop})}>
    <div className="model-document-deck-stage" style={{ width: stageWidth, height: stageHeight }}>
      {documents.map(document => {
        const index = docked.findIndex(value => value.id === document.id);
        const visible = document.docked && (mode !== 'single' || activeId === document.id);
        const rect = mode === 'single' ? { x: 0, y: 0, width: size.width, height: size.height } : mode === 'free' ? freeRects[document.id] ?? tiled.rects[index] : tiled.rects[index];
        const style: CSSProperties = { display: visible ? undefined : 'none', left: rect?.x ?? 0, top: rect?.y ?? 0,
          width: rect?.width ?? size.width, height: rect?.height ?? size.height,
          zIndex: mode === 'free' ? raised.indexOf(document.id) + 2 : 1 };
        const handle = <button type="button" className="model-document-handle" data-testid="model-document-handle"
          hidden={mode === 'single' || !document.docked} aria-label={`移动视口 ${document.label}`} title={mode === 'tiled' ? '拖动交换视口位置' : '拖动移动视口'}
          onPointerDown={event => startPane(event, document.id, mode === 'tiled' ? 'reorder' : 'move')} {...pointerHandlers}>
          {document.handleContent ?? <span aria-hidden="true" />}
        </button>;
        // This section and the content slot have the same identity in all
        // modes. No portal, duplicate owner, or mode-specific parent exists.
        return <section key={document.id} className="model-document-pane" data-testid="model-document-pane"
          data-document-id={document.id} data-active={activeId === document.id} data-dragging={dragging === document.id}
          data-legend-host={legendHostId === document.id}
          data-drop-target={dropTarget === document.id} data-docked={document.docked} hidden={!visible} style={style}
          onPointerDownCapture={event => {
            // Input forms and dialogs can be React portals owned by this App,
            // but only a pointer inside the physical pane activates its model.
            if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
            if ((event.target as HTMLElement).closest?.('.model-compact-legend')) return;
            const activationOnly = viewportActivationTarget(event.target) && activationPointer.current.begin(event.pointerId, { active: isDocumentInteractionOwner?.(document.id) ?? activeId === document.id });
            activate(document.id);
            if (activationOnly) { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }
          }}
          onPointerMoveCapture={event => { if (activationPointer.current.consumes(event.pointerId)) { event.preventDefault(); event.stopPropagation(); } }}
          onPointerUpCapture={event => { if (activationPointer.current.end(event.pointerId)) { event.preventDefault(); event.stopPropagation(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
          onPointerCancelCapture={event => { if (activationPointer.current.cancel(event.pointerId)) { event.preventDefault(); event.stopPropagation(); } }}
          onLostPointerCaptureCapture={event => activationPointer.current.lostCapture(event.pointerId)}
          onClickCapture={event => { if (activationPointer.current.click((event.nativeEvent as PointerEvent).pointerId, event.detail)) { event.preventDefault(); event.stopPropagation(); } }}
          onFocusCapture={event => { if (event.target instanceof Node && event.currentTarget.contains(event.target) && !(event.target as HTMLElement).closest?.('.model-compact-legend')) activate(document.id); }}>
          {document.handleContent !== undefined || document.headerActions ? <div className="model-document-titlebar" style={{display:mode==='single'||!document.docked?'none':'flex',flex:'0 0 auto'}}>{handle}{document.headerActions}</div> : handle}
          <div className="model-document-content">{document.content}</div>
          {RESIZE_DIRECTIONS.map(({ direction, label }) => <button key={direction} type="button" className="model-document-resize" data-testid="model-document-resize"
            data-direction={direction} hidden={mode !== 'free' || !document.docked} aria-label={`调整视口大小 ${document.label} ${label}`} title={`拖动${label}调整视口大小`}
            onPointerDown={event => startPane(event, document.id, 'resize', direction)} {...pointerHandlers} />)}
        </section>;
      })}
      {mode === 'tiled' && <>
        {tiled.columnDividers.map((left, index) => <div key={`column:${index}`} role="separator" aria-orientation="vertical" aria-label={`调整第 ${index + 1}、${index + 2} 列比例`}
          tabIndex={0} className="model-document-splitter model-document-splitter-column" data-testid="model-document-splitter" data-axis="column" data-index={index}
          style={{ left, top: 0, width: DOCUMENT_PANE_GAP, height: tiled.height }}
          onPointerDown={event => startTrack(event, 'column', index)} {...pointerHandlers}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setTracks(before => ({ ...before, [columnKey]: resizeDocumentTracks(tiled.columnSizes, index, event.key === 'ArrowRight' ? 20 : -20, DOCUMENT_PANE_MIN_WIDTH) })); } }} />)}
        {tiled.rowDividers.map((top, index) => <div key={`row:${index}`} role="separator" aria-orientation="horizontal" aria-label={`调整第 ${index + 1}、${index + 2} 行比例`}
          tabIndex={0} className="model-document-splitter model-document-splitter-row" data-testid="model-document-splitter" data-axis="row" data-index={index}
          style={{ top, left: 0, height: DOCUMENT_PANE_GAP, width: tiled.width }}
          onPointerDown={event => startTrack(event, 'row', index)} {...pointerHandlers}
          onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setTracks(before => ({ ...before, [rowKey]: resizeDocumentTracks(tiled.rowSizes, index, event.key === 'ArrowDown' ? 20 : -20, DOCUMENT_PANE_MIN_HEIGHT) })); } }} />)}
      </>}
    </div>
  </div>;
}
export default ModelDocumentDeck;
