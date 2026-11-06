import NumericInput from '../NumericInput';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cellEditorEdges, cellLengthFromScreenDrag, type CellAxis } from '../../core/modeling/cell-editor';
import type { PeriodicCell, Vector3 } from '../../core/types';
import { norm3 } from '../../core/periodic';
import { cellPresentationEdges, type CellPresentationOptions, type CellPresentationRole } from '../../core/modeling/cell-presentation';
import type { CellEditorViewportDraft } from './CellEditorPanel';
import './cell-editor.css';
import {ResultLabelLayer,resultLabelPresentation} from './result-label-presentation';

type Point = { x: number; y: number };
export interface CellEditorOverlayProps {
  draft: CellEditorViewportDraft;
  /** Same client-coordinate projection as every existing viewport overlay. */
  project(position: Vector3): Point;
  viewport: HTMLElement | null;
  /** Increment/change when the owner refreshes its ordinary overlays. */
  projectionVersion?: unknown;
  cellGuides?: CellPresentationOptions;
  fontSize?: number;
}
export interface ReadOnlyCellOverlayProps extends Omit<CellEditorOverlayProps, 'draft'> {
  cell: PeriodicCell;
  documentId: string;
}
/** The same axis hit targets/labels without leaking hover state into the workspace. */
export function ReadOnlyCellOverlay({ cell, documentId, ...props }: ReadOnlyCellOverlayProps) {
  const [activeAxis, setActiveAxis] = useState<CellAxis | null>(null);
  useEffect(() => setActiveAxis(null), [documentId, cell]);
  return <CellEditorOverlay {...props} draft={{ documentId, expectedRevision: 0, cell,
    lengths: cell.vectors.map(norm3) as Vector3, activeAxis, readOnly: true,
    onAxisHover: setActiveAxis, onLengthChange() {}, onLengthCommit() {}, onDragStart() {}, onDragEnd() {} }}/>
}
export default function CellEditorOverlay({ draft, project, viewport, cellGuides, fontSize=13 }: CellEditorOverlayProps) {
  const observe=(event:ReactPointerEvent<SVGElement>)=>{
    const surface=viewport?.closest?.('.model-viewport-stage')?.querySelector<HTMLElement>('[data-testid="model-interaction-surface"]')??viewport?.querySelector<HTMLElement>('[data-testid="model-interaction-surface"]');
    const Pointer=viewport?.ownerDocument.defaultView?.PointerEvent;
    if(!surface||!Pointer)return;
    event.stopPropagation();
    surface.dispatchEvent(new Pointer('pointerdown',{bubbles:true,cancelable:true,pointerId:event.pointerId,pointerType:event.pointerType,button:event.button,buttons:event.buttons,clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey}));
  };
  const gesture = useRef<{ pointerId: number; axis: CellAxis; initial: number; start: Point; end: Point; pointer: Point; documentId: string; revision: number } | null>(null);
  const latest = useRef(draft); latest.current = draft;
  const labelSurface=useRef<HTMLDivElement|null>(null);labelSurface.current=viewport as HTMLDivElement|null;
  const [editing, setEditing] = useState<CellAxis | null>(null), [lengthText, setLengthText] = useState('');
  const [pointer, setPointer] = useState<Point | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const hoverExit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverAxis = (axis: CellAxis | null) => {
    if (hoverExit.current) clearTimeout(hoverExit.current);
    hoverExit.current = null;
    if (axis !== null) latest.current.onAxisHover(axis);
    else if (!editing) hoverExit.current = setTimeout(() => { latest.current.onAxisHover(null); setHoveredEdge(null); setPointer(null); hoverExit.current = null; }, 80);
  };
  useEffect(() => () => { if (hoverExit.current) clearTimeout(hoverExit.current); }, []);
  useEffect(()=>{const win=viewport?.ownerDocument.defaultView;if(!win)return;const clear=()=>{latest.current.onAxisHover(null);setHoveredEdge(null);setPointer(null);if(gesture.current)latest.current.onDragEnd(true);gesture.current=null;};win.addEventListener('blur',clear);win.addEventListener('pagehide',clear);return()=>{win.removeEventListener('blur',clear);win.removeEventListener('pagehide',clear);};},[viewport]);
  useEffect(() => () => { if (gesture.current) latest.current.onDragEnd(true); gesture.current = null; }, []);
  useEffect(() => { gesture.current = null; setEditing(null); setHoveredEdge(null); setPointer(null); }, [draft.documentId, draft.expectedRevision]);
  if (!viewport) return null;
  const bounds = viewport.getBoundingClientRect();
  let edges: { key: string; axis: CellAxis; role: CellPresentationRole; length:number; start: Point; end: Point }[];
  try { edges = (cellGuides ? cellPresentationEdges(cellGuides) : cellEditorEdges(draft.cell).map(edge=>({...edge,role:'current' as const}))).filter(edge=>edge.role!=='grid').map(edge => ({ ...edge, length:Math.hypot(...edge.end.map((value,index)=>value-edge.start[index])), start: project(edge.start), end: project(edge.end) })); }
  catch { return null; }
  const finish = (cancel = false) => { if (!gesture.current) return; gesture.current = null; latest.current.onDragEnd(cancel); };
  return <svg className={`cell-editor-overlay${draft.readOnly ? ' is-readonly' : ''}`} data-testid="cell-editor-overlay" aria-label={draft.readOnly ? '晶胞边线' : '晶胞边线编辑'} viewBox={`0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`}>
    {edges.map(edge => {
      const coords = { x1: edge.start.x - bounds.left, y1: edge.start.y - bounds.top, x2: edge.end.x - bounds.left, y2: edge.end.y - bounds.top };
      return <g key={edge.key}>
        <line {...coords} className={`cell-editor-edge-visible ${edge.role!=='current'?'is-reference ':''}${draft.activeAxis === edge.axis && (!hoveredEdge||hoveredEdge===edge.key) ? 'is-active' : ''}`}/>
        <line {...coords} className="cell-editor-edge" data-axis={'abc'[edge.axis]} data-edge={edge.key} data-cell-role={edge.role}
          onPointerEnter={event => { if (!gesture.current) { setHoveredEdge(edge.key);setPointer({x:event.clientX,y:event.clientY});hoverAxis(edge.axis); } }}
          onPointerLeave={() => { if (!gesture.current) hoverAxis(null); }}
          onPointerDown={event => {
            if (event.button !== 0 || draft.readOnly || edge.role!=='current') {observe(event);return;}
            event.preventDefault(); event.stopPropagation();
            if (Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y) < 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { pointerId: event.pointerId, axis: edge.axis, initial: draft.lengths[edge.axis],
              start: edge.start, end: edge.end, pointer: { x: event.clientX, y: event.clientY }, documentId: draft.documentId, revision: draft.expectedRevision };
            draft.onAxisHover(edge.axis); draft.onDragStart();
          }}
          onPointerMove={event => {
            setHoveredEdge(edge.key);setPointer({x:event.clientX,y:event.clientY});
            const current = gesture.current;
            if (!current || current.pointerId !== event.pointerId) return;
            event.preventDefault(); event.stopPropagation();
            if (latest.current.documentId !== current.documentId || latest.current.expectedRevision !== current.revision) { finish(true); return; }
            latest.current.onLengthChange(current.axis, cellLengthFromScreenDrag(current.initial, current.start, current.end, { x: event.clientX - current.pointer.x, y: event.clientY - current.pointer.y }));
          }}
          onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); finish(); } }}
          onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
          onDoubleClick={event=>{if(!draft.readOnly&&edge.role==='current'){event.preventDefault();event.stopPropagation();setLengthText(String(draft.lengths[edge.axis]));setEditing(edge.axis);}}}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}/>
      </g>;
    })}
    {draft.activeAxis !== null && (() => {
      const axis = draft.activeAxis, edge = edges.find(item => item.key === hoveredEdge)??edges.find(item => item.axis === axis);
      if(!edge)return null;
      const readonly=draft.readOnly||edge.role!=='current';
      const x = (pointer?.x??(edge.start.x+edge.end.x)/2)-bounds.left, y = (pointer?.y??(edge.start.y+edge.end.y)/2)-bounds.top-24;
      const commit = () => { const value = lengthText.trim() ? Number(lengthText) : NaN; if (Number.isFinite(value) && value > 0) { draft.onLengthCommit(axis, value); setEditing(null); } };
      return editing === axis && !readonly ? <foreignObject x={x - 56} y={y - 18} width="112" height="38" className="cell-editor-length-input" onPointerEnter={() => hoverAxis(axis)} onPointerDown={event => event.stopPropagation()}>
        <NumericInput autoFocus min="0" step="0.1" aria-label={`晶胞 ${'abc'[axis]} 长度 / Å`} value={lengthText} onChange={event => setLengthText(event.target.value)} onBlur={commit} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') setEditing(null); }}/>
      </foreignObject> : <foreignObject x="0" y="0" width={bounds.width} height={bounds.height} style={{pointerEvents:'none',overflow:'visible'}}><div style={{position:'relative',width:'100%',height:'100%'}}><ResultLabelLayer items={[{id:'cell-pointer',presentation:resultLabelPresentation(`${edge.length.toFixed(3)} Å`,{x,y},'center',fontSize),attributes:{'data-testid':'model-hover-cell',style:{textAlign:'center'}}}]} surface={labelSurface}/></div></foreignObject>;
    })()}
  </svg>;
}
