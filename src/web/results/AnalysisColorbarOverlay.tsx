import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { analysisColorbarGradient, analysisColorbarValues, type AnalysisColorbar } from './analysis-display';
import { FALLBACK_COLORBAR_VIEWPORT, moveAnalysisColorbarLayout, normalizeAnalysisColorbarLayout, registerAnalysisColorbarViewport, resizeAnalysisColorbarLayout, resolveAnalysisColorbarRect,
  type AnalysisColorbarLayout } from './analysis-colorbar-layout';
import './analysis-colorbar.css';

export interface AnalysisColorbarOverlayProps {
  colorbar: AnalysisColorbar;
  onLayoutChange?(layout: AnalysisColorbarLayout): void;
  contextKey?: string;
}
type DragKind = 'move' | 'start' | 'end';

export default function AnalysisColorbarOverlay({ colorbar, onLayoutChange, contextKey = '' }: AnalysisColorbarOverlayProps) {
  const root = useRef<HTMLElement>(null);
  const [size, setSize] = useState(FALLBACK_COLORBAR_VIEWPORT), [draft, setDraft] = useState<AnalysisColorbarLayout | null>(null);
  const identity = JSON.stringify([contextKey, colorbar.sourceKey, colorbar.label, colorbar.min, colorbar.max, colorbar.decimals,
    colorbar.palette, colorbar.reverse, colorbar.colors, colorbar.zeroCentered, normalizeAnalysisColorbarLayout(colorbar.layout)]);
  const latest = useRef({ identity, onLayoutChange });
  latest.current = { identity, onLayoutChange };
  const drag = useRef<{ pointerId: number; kind: DragKind; x: number; y: number; layout: AnalysisColorbarLayout; identity: string } | null>(null);
  const currentDraft = drag.current?.identity === identity ? draft : null;
  const layout = normalizeAnalysisColorbarLayout(currentDraft ?? colorbar.layout);
  const rect = resolveAnalysisColorbarRect(layout, size, colorbar.label, 1, analysisColorbarValues(colorbar));
  const { gradient, padding } = rect;
  const vertical = rect.orientation === 'vertical';
  const span = vertical ? size.height : size.width;
  const extra = vertical ? rect.height - gradient.height : 0;

  function cancel() { drag.current = null; setDraft(null); }
  useEffect(() => { cancel(); }, [identity]);
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (parent && colorbar.sourceKey) return registerAnalysisColorbarViewport(colorbar.sourceKey, parent);
  }, [colorbar.sourceKey]);
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const { width, height } = parent.getBoundingClientRect();
      if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const win = parent.ownerDocument.defaultView, Observer = win?.ResizeObserver;
    const observer = Observer ? new Observer(() => { cancel(); measure(); }) : null;
    observer?.observe(parent);
    win?.addEventListener('blur', cancel);
    return () => { observer?.disconnect(); win?.removeEventListener('blur', cancel); };
  }, []);

  function effective(kind: DragKind) {
    return { ...layout, x: (rect.left + rect.width / 2) / size.width, y: (rect.top + rect.height / 2) / size.height,
      length: kind === 'move' ? layout.length : (vertical ? gradient.height : rect.width) / span };
  }

  function begin(event: ReactPointerEvent<HTMLElement>, kind: DragKind) {
    if (!onLayoutChange || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId, kind, x: event.clientX, y: event.clientY, layout: effective(kind), identity };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function next(event: ReactPointerEvent<HTMLElement>) {
    const own = drag.current;
    if (!own || own.pointerId !== event.pointerId || own.identity !== latest.current.identity) return null;
    const x = event.clientX - own.x, y = event.clientY - own.y;
    if (!x && !y) return null;
    if (own.kind === 'move') return moveAnalysisColorbarLayout(own.layout, { x, y }, size, rect);
    const delta = (vertical ? y : x) * (own.kind === 'start' ? -1 : 1);
    return delta ? resizeAnalysisColorbarLayout(own.layout, delta, span, extra) : null;
  }

  function move(event: ReactPointerEvent<HTMLElement>) { event.stopPropagation(); setDraft(next(event)); }
  function end(event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
    const value = next(event);
    cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (value) latest.current.onLayoutChange?.(value);
  }

  function key(event: KeyboardEvent<HTMLElement>, kind: DragKind) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (!onLayoutChange || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? .05 : .01;
    const x = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const y = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (kind === 'move') { onLayoutChange(moveAnalysisColorbarLayout(effective(kind), { x: x * size.width, y: y * size.height }, size, rect)); return; }
    const delta = (vertical ? y : x) * (kind === 'start' ? -1 : 1);
    if (delta) onLayoutChange(resizeAnalysisColorbarLayout(effective(kind), delta * span / 2, span, extra));
  }

  const stop = (event: ReactPointerEvent<HTMLElement>) => { event.stopPropagation(); cancel(); };
  const gesture = (kind: DragKind) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, kind),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => key(event, kind),
    onPointerMove: move, onPointerUp: end, onPointerCancel: stop, onLostPointerCapture: stop,
  });
  return <section ref={root} className="result-analysis-colorbar" data-testid="result-analysis-colorbar"
    data-orientation={rect.orientation} data-editing={Boolean(currentDraft)} aria-label={colorbar.label + '色标'}
    style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: onLayoutChange ? 'auto' : 'none' }}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <span className="analysis-colorbar-gradient" style={{ left: gradient.x, top: gradient.y, width: gradient.width, height: gradient.height,
      background: analysisColorbarGradient({ ...colorbar, layout }) }}/>
    <svg className="analysis-colorbar-text" width={rect.width} height={rect.height} fill={rect.ink} fontFamily={rect.fontFamily} fontSize={rect.fontSize}>
      {rect.text.map(({ text, x, baseline, anchor }, index) => <text key={index} x={x} y={baseline} textAnchor={anchor}>{text}</text>)}
    </svg>
    {onLayoutChange && <>
      <button type="button" className="analysis-colorbar-move" aria-label="移动色标" title="拖动位置，方向键微调"
        style={{ left: padding, right: padding, top: padding, height: rect.labelHeight }} {...gesture('move')}/>
      {(['start', 'end'] as const).map(side => {
        const start = side === 'start';
        const edge = vertical ? (start ? '上端' : '下端') : (start ? '左端' : '右端');
        const centreX = vertical ? gradient.x + gradient.width / 2 : gradient.x + (start ? 0 : gradient.width);
        const centreY = vertical ? gradient.y + (start ? 0 : gradient.height) : gradient.y + gradient.height / 2;
        return <button key={side} type="button" className="analysis-colorbar-resize" data-export-exclude="true"
          aria-label={`调整色标长度（${edge}）`} title="对称调整长度，方向键微调" style={{ left: centreX, top: centreY }}
          {...gesture(side)}><span aria-hidden="true">{vertical ? '↕' : '↔'}</span></button>;
      })}
    </>}
  </section>;
}
