import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Snowflake } from 'lucide-react';
import { FREEZE_COLOR, SCAN_COLOR } from '../../core/display-highlights';
import { assignmentDisplayKey, type AssignmentDisplayRegion } from '../../modeling/application/assignment-display';
import './assignment-badges.css';

export interface ModelLegendElement { element: string; color: string; count: number }
export interface CompactModelLegendProps {
  /** Pass display.legend here. False must preserve the saved user choice. */
  visible?: boolean;
  elements: readonly ModelLegendElement[];
  /** Same projection as the currently rendered assignment badges/colours. */
  regions: readonly AssignmentDisplayRegion[];
  onRegionSelect?: (region: AssignmentDisplayRegion) => void;
  expanded?: boolean;
  /** Default only: a user toggle remains authoritative after later resizes. */
  compact?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  fontSize?: number;
  hasInactiveFreeze?: boolean;
  sourceDocumentId?: string;
}
const categoryLabels = { basis: '基组区域', fragments: '片段区域', layers: 'QM/MM空间分组' } as const;
type LegendPosition = { x: number; y: number };
type LegendSize = { width: number; height: number };
export function clampLegendPosition(position: null, stage: LegendSize, panel: LegendSize): null;
export function clampLegendPosition(position: LegendPosition, stage: LegendSize, panel: LegendSize): LegendPosition;
export function clampLegendPosition(position: LegendPosition | null, stage: LegendSize, panel: LegendSize): LegendPosition | null;
export function clampLegendPosition(position: LegendPosition | null, stage: LegendSize, panel: LegendSize): LegendPosition | null {
  // Null means CSS top/right anchoring. Measuring or resizing must never turn
  // that default into a saved left offset before the user actually drags it.
  if (position === null) return null;
  const maxX = Math.max(0, stage.width - panel.width - 6), maxY = Math.max(0, stage.height - panel.height - 6);
  return { x: Math.max(Math.min(6, maxX), Math.min(maxX, Number.isFinite(position.x) ? position.x : maxX)),
    y: Math.max(Math.min(6, maxY), Math.min(maxY, Number.isFinite(position.y) ? position.y : 6)) };
}

/** An absolute overlay inside the viewport stage. Toggling only changes this
 * overlay's contents; no grid lane, resize request, or camera action exists. */
export default function CompactModelLegend({ visible = true, elements, regions, onRegionSelect, expanded: controlledExpanded, compact = false, onExpandedChange, fontSize,hasInactiveFreeze=false,sourceDocumentId }: CompactModelLegendProps) {
  const [localExpanded, setLocalExpanded] = useState<boolean | undefined>(undefined);
  const panel = useRef<HTMLElement>(null), drag = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number; moved: boolean } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panelId = useId();
  const expanded = controlledExpanded ?? localExpanded ?? !compact;
  useLayoutEffect(() => {
    const node = panel.current, stage = node?.parentElement;
    if (!visible || !node || !stage) return;
    const clamp = () => {
      const bounds = stage.getBoundingClientRect(), own = node.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      setPosition(before => {
        const next = clampLegendPosition(before, bounds, own);
        if (!next) return before;
        return before?.x === next.x && before?.y === next.y ? before : next;
      });
    };
    clamp();
    const Observer = node.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(clamp); observer.observe(stage); observer.observe(node);
    return () => observer.disconnect();
  }, [visible, expanded, fontSize]);
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const own = drag.current, node = panel.current, stage = node?.parentElement;
    if (!own || own.pointerId !== event.pointerId || !node || !stage) return;
    event.preventDefault(); event.stopPropagation();
    if (!own.moved && Math.hypot(event.clientX - own.clientX, event.clientY - own.clientY) <= 3) return;
    own.moved = true;
    setPosition(clampLegendPosition({ x: own.x + event.clientX - own.clientX, y: own.y + event.clientY - own.clientY }, stage.getBoundingClientRect(), node.getBoundingClientRect()));
  }
  function end(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null; event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (!visible) return null;
  return <aside ref={panel} className="model-compact-legend" data-testid="model-region-legend" data-source-document-id={sourceDocumentId} data-expanded={expanded} data-position={position ? 'manual' : 'anchored'} aria-label="模型图例"
    style={{ ...(fontSize ? { fontSize: `max(${fontSize}px, var(--ui-secondary-size, 14px))` } : {}), ...(position ? { left: position.x, top: position.y, right: 'auto' } : {}) }}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <div className="model-compact-legend-heading">
      <button type="button" className="model-compact-legend-drag" data-testid="model-legend-drag" aria-label="移动图例" title="拖动标题移动图例"
        onPointerDown={event => { const node = panel.current, stage = node?.parentElement; if (event.button !== 0 || !node || !stage) return; event.preventDefault(); event.stopPropagation(); const own = node.getBoundingClientRect(), bounds = stage.getBoundingClientRect(); drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: own.left - bounds.left, y: own.top - bounds.top, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>图例</button>
      <button type="button" className="model-compact-legend-toggle" data-testid="model-legend-toggle" aria-expanded={expanded} aria-controls={panelId} title={expanded ? '收起图例' : '展开图例'} aria-label={expanded ? '收起图例' : '展开图例'} onClick={() => { const next = !expanded; if (controlledExpanded === undefined) setLocalExpanded(next); onExpandedChange?.(next); }}>{expanded ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronLeft size={14} aria-hidden="true" />}</button>
    </div>
    {expanded && <div id={panelId} className="model-compact-legend-content">
      <div className="model-compact-legend-group"><strong>元素色</strong>{elements.length ? elements.map(entry => <span className="model-compact-legend-row" key={entry.element} data-element={entry.element}><i className="model-compact-legend-sphere" style={{ backgroundColor: entry.color }} /><span>{entry.element}</span><small>{entry.count}</small></span>) : <span className="model-compact-legend-empty">暂无图例条目</span>}</div>
      <div className="model-compact-legend-group"><strong>对象标记</strong>{hasInactiveFreeze&&<span className="model-compact-legend-row"><Snowflake size={14} color="#d59e1f" aria-hidden="true"/><span>黄雪花 · 当前输入未采用</span></span>}<span className="model-compact-legend-row"><Snowflake size={14} color={FREEZE_COLOR} aria-hidden="true" /><span>雪花 · 冻结</span></span><span className="model-compact-legend-row"><Check size={14} color="#946b00" aria-hidden="true" /><span>勾选 · 当前选区</span></span><span className="model-compact-legend-row"><i className="model-compact-legend-scan" aria-hidden="true">S</i><span>扫描</span></span><span className="model-compact-legend-scan-guide" style={{ color: SCAN_COLOR }}>蓝线 · 扫描内坐标</span></div>
      {(['basis', 'fragments', 'layers'] as const).map(category => {
        const entries = regions.filter(region => region.category === category && region.atomIds.length);
        return entries.length > 0 && <div className="model-compact-legend-group" key={category} data-region-category={category}><strong>{categoryLabels[category]}</strong>{entries.map(region => {
          const content = <><i className="model-compact-legend-swatch" style={{ backgroundColor: region.color }} /><span>{region.shortLabel}</span><small>{region.atomIds.length}</small></>;
          return onRegionSelect ? <button type="button" className="model-compact-legend-row model-compact-legend-region" key={assignmentDisplayKey(region)} data-region-id={region.id} aria-label={`选择${region.description}`} title={region.description} style={{ '--assignment-color': region.color } as CSSProperties} onClick={() => onRegionSelect(region)}>{content}</button> : <span className="model-compact-legend-row" key={assignmentDisplayKey(region)} data-region-id={region.id} title={region.description}>{content}</span>;
        })}</div>;
      })}
    </div>}
  </aside>;
}
