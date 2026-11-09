import { useEffect, useRef } from 'react';
import type { Vector3 } from '../../core/types';
import { sameSamplingSphereSource, samplingSphereRadiusFromDrag,
  type SamplingSphereRadiusChange, type SamplingSphereViewportDraft } from '../../modeling/advanced/sampling-sphere';
import './sampling-sphere-overlay.css';
import {createLatestMoveScheduler} from './viewport-move-scheduler';

export type { SamplingSphereViewportDraft, SamplingSphereRadiusChange } from '../../modeling/advanced/sampling-sphere';
type Point = { x: number; y: number };
export interface SamplingSphereOverlayProps {
  draft: SamplingSphereViewportDraft;
  /** Same client-coordinate projection as the existing viewport overlays. */
  project(position: Vector3): Point;
  projectSphere?(sphere:{centerAngstrom:Vector3;radiusAngstrom:number}):{center:Point;radius:number}|null;
  viewport: HTMLElement | null;
  projectionVersion?: unknown;
  onRadiusChange(change: SamplingSphereRadiusChange): void;
  onDragStart?(): void;
  onDragEnd?(cancel: boolean): void;
}

// Projection is owned by the viewport. The convex hull of uniformly sampled
// unit-sphere points provides one camera-correct silhouette, including oblique
// and perspective views, without creating a second 3D scene or scientific cell.
const directions: Vector3[] = Array.from({ length: 384 }, (_, index) => {
  const y = 1 - 2 * (index + 0.5) / 384, r = Math.sqrt(1 - y * y), angle = index * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(angle), y, r * Math.sin(angle)];
});
const turn = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function samplingSphereProjectedOutline(draft: SamplingSphereViewportDraft, project: (position: Vector3) => Point): Point[] {
  const points = directions.flatMap(direction => {
    try { return [project(direction.map((v, i) => draft.centerAngstrom[i] + v * draft.radiusAngstrom) as Vector3)]; }
    catch { return []; }
  })
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => a.x - b.x || a.y - b.y);
  if (points.length < 3) return points;
  const lower: Point[] = [], upper: Point[] = [];
  for (const point of points) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point); }
  for (let i = points.length - 1; i >= 0; i--) { const point = points[i]; while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export default function SamplingSphereOverlay(props: SamplingSphereOverlayProps) {
  const { draft, project, viewport } = props;
  const latest = useRef(props); latest.current = props;
  const gesture = useRef<{ pointerId: number; initial: SamplingSphereViewportDraft; pointer: Point; center: Point; pixelScale: number;target:SVGPathElement } | null>(null);
  const pendingRadius=useRef<ReturnType<typeof createLatestMoveScheduler<SamplingSphereRadiusChange>>|null>(null);
  const frameHost=viewport?.ownerDocument?.defaultView;
  const emit=(change:SamplingSphereRadiusChange)=>{const p=latest.current;if(p.draft.previewEnabled&&!p.draft.disabled&&sameSamplingSphereSource(change,p.draft))p.onRadiusChange(change);};
  if(!pendingRadius.current&&frameHost?.requestAnimationFrame)pendingRadius.current=createLatestMoveScheduler(callback=>frameHost.requestAnimationFrame(callback),id=>frameHost.cancelAnimationFrame(id),emit);
  const finish = (cancel: boolean) => {
    const current = gesture.current;
    pendingRadius.current?.cancel();
    if (!current) return;
    gesture.current = null;
    if(current.target.hasPointerCapture?.(current.pointerId))current.target.releasePointerCapture(current.pointerId);
    if (cancel && sameSamplingSphereSource(current.initial, latest.current.draft)) latest.current.onRadiusChange({
      sourceDocumentId: current.initial.sourceDocumentId, sourceRevision: current.initial.sourceRevision, radiusAngstrom: current.initial.radiusAngstrom });
    latest.current.onDragEnd?.(cancel);
  };
  useEffect(()=>{const blur=()=>finish(true);frameHost?.addEventListener('blur',blur);return()=>{frameHost?.removeEventListener('blur',blur);finish(true);};},[frameHost]);
  useEffect(() => { finish(true); }, [draft.sourceDocumentId, draft.sourceRevision, draft.previewEnabled, draft.disabled]);
  if (!viewport || !draft.previewEnabled || draft.disabled) return null;
  const bounds = viewport.getBoundingClientRect();
  let center: Point;
  let circle:{center:Point;radius:number}|null=null;
  try {circle=draft.radiusAngstrom>0?props.projectSphere?.(draft)??null:null;center=circle?.center??project(draft.centerAngstrom);} catch { return null; }
  const outline=circle?[]:samplingSphereProjectedOutline(draft, project);
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !circle&&outline.length < 1) return null;
  const cx = center.x - bounds.left, cy = center.y - bounds.top;
  const path = draft.radiusAngstrom === 0
    ? `M${cx - 3},${cy}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0`
    : circle?`M${cx-circle.radius},${cy}a${circle.radius},${circle.radius} 0 1,0 ${circle.radius*2},0a${circle.radius},${circle.radius} 0 1,0 ${-circle.radius*2},0`
    : outline.map((point, index) => `${index ? 'L' : 'M'}${point.x - bounds.left},${point.y - bounds.top}`).join(' ') + ' Z';
  return <svg className="sampling-sphere-overlay" data-testid="sampling-sphere-overlay" aria-label="球形约束半径编辑"
    viewBox={`0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`}>
    <path d={path} className="sampling-sphere-outline"/>
    <path d={path} className="sampling-sphere-handle" tabIndex={0} role="slider" aria-label="拖动球形约束半径"
      aria-valuemin={draft.minimumRadiusAngstrom} aria-valuenow={draft.radiusAngstrom} aria-valuetext={`${draft.radiusAngstrom} Å`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const referenceRadius=Math.max(1,draft.radiusAngstrom),projected=props.projectSphere?.({...draft,radiusAngstrom:referenceRadius});
        const reference=projected?[]:samplingSphereProjectedOutline({...draft,radiusAngstrom:referenceRadius},project);
        const pixelScale=(projected?.radius??Math.max(...reference.map(point=>Math.hypot(point.x-center.x,point.y-center.y))))/referenceRadius;
        if (!Number.isFinite(pixelScale) || pixelScale < 1e-6) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { pointerId: event.pointerId, initial: draft, center, pixelScale, pointer: { x: event.clientX, y: event.clientY },target:event.currentTarget };
        props.onDragStart?.();
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        if (!sameSamplingSphereSource(current.initial, latest.current.draft)) { finish(true); return; }
        const radiusAngstrom = samplingSphereRadiusFromDrag(current.initial.radiusAngstrom, current.initial.minimumRadiusAngstrom,
          current.center, current.pointer, { x: event.clientX, y: event.clientY }, current.pixelScale);
        const change={sourceDocumentId:current.initial.sourceDocumentId,sourceRevision:current.initial.sourceRevision,radiusAngstrom};
        if(pendingRadius.current)pendingRadius.current.schedule(change);else emit(change);
      }}
      onPointerUp={event => { const current=gesture.current;if(current?.pointerId===event.pointerId){event.preventDefault();event.stopPropagation();const radiusAngstrom=samplingSphereRadiusFromDrag(current.initial.radiusAngstrom,current.initial.minimumRadiusAngstrom,current.center,current.pointer,{x:event.clientX,y:event.clientY},current.pixelScale);const change={sourceDocumentId:current.initial.sourceDocumentId,sourceRevision:current.initial.sourceRevision,radiusAngstrom};if(pendingRadius.current)pendingRadius.current.flush(change);else emit(change);finish(false);} }}
      onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
      onKeyDown={event => {
        if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true); }
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault(); event.stopPropagation();
          const delta = (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 1 : 0.1);
          props.onRadiusChange({ sourceDocumentId: draft.sourceDocumentId, sourceRevision: draft.sourceRevision, radiusAngstrom: Math.max(draft.minimumRadiusAngstrom, draft.radiusAngstrom + delta) });
        }
      }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}/>
  </svg>;
}
