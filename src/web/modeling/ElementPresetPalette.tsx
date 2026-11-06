import { useEffect, useRef, useState } from 'react';
import { getElementPreset, getElementPresets, type ElementPreset } from '../../core/modeling/element-presets';
import './element-preset-palette.css';

export interface ElementPresetPaletteProps {
  selectionId: string;
  onChange(presetId: string): void;
  element?: string;
  disabled?: boolean;
  onClose?(): void;
}
/** Native SVG remains sharp at the user's UI scale; wedges/dashes are preview
 * depth cues, never an independent replacement for the model's actual XYZ. */
export function ElementPresetPreview({ preset }: { preset: ElementPreset }) {
  const cx = 58, cy = 44;
  return <svg className="element-preset-preview" viewBox="0 0 116 88" role="img" aria-label={`${preset.element} ${preset.label} 片段几何预览`}>
    {preset.slots.map(slot => {
      const [x, y, z] = slot.direction;
      const px = cx + (x + .48 * z) * 30, py = cy + (-y + .34 * z) * 28;
      const dx = px - cx, dy = py - cy, length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length, ny = dx / length;
      const multiple = slot.order === 3 ? [-3, 0, 3] : slot.order === 2 ? [-2, 2] : [0];
      return <g key={slot.id} data-slot-order={slot.order} data-slot-fill={slot.fill} aria-label={slot.fill === 'hydrogen' ? '真实 H' : '连接端（非原子）'}>
        {slot.order === 1 && slot.preview === 'wedge' ? <polygon points={`${cx},${cy} ${px + nx * 3.2},${py + ny * 3.2} ${px - nx * 3.2},${py - ny * 3.2}`} className="element-preset-wedge" />
          : multiple.map(offset => <line key={offset} x1={cx + nx * offset} y1={cy + ny * offset} x2={px + nx * offset} y2={py + ny * offset} strokeDasharray={slot.preview === 'dash' ? '2 3' : undefined} />)}
        {slot.order === 1.5 && <line x1={cx + nx * 3} y1={cy + ny * 3} x2={px + nx * 3} y2={py + ny * 3} strokeDasharray="3 2" />}
        <circle cx={px} cy={py} r={slot.fill === 'open' ? 4.2 : 7.2} className={slot.fill === 'open' ? 'element-preset-open' : 'element-preset-hydrogen'} />
        {slot.fill === 'hydrogen' && <text x={px} y={py + 3.1} className="element-preset-h-label">H</text>}
      </g>;
    })}
    <circle cx={cx} cy={cy} r={preset.element.length > 1 ? 12 : 10} className="element-preset-center" />
    <text x={cx} y={cy + 4} className="element-preset-element">{preset.element}</text>
  </svg>;
}

export default function ElementPresetPalette({ selectionId, onChange, element, disabled = false, onClose }: ElementPresetPaletteProps) {
  const selected = getElementPreset(selectionId), symbol = element ?? selected.element;
  const entries = getElementPresets(symbol);
  const atom = entries.find(entry => entry.family === 'atom')!;
  const common = entries.filter(entry => entry.family !== 'atom' && entry.category !== 'more');
  const more = entries.filter(entry => entry.family !== 'atom' && entry.category === 'more');
  const selectedMore = more.some(entry => entry.id === selectionId);
  const [group, setGroup] = useState({ symbol, expanded: selectedMore });
  const expanded = group.symbol === symbol ? group.expanded : selectedMore;
  useEffect(() => {
    setGroup(current => current.symbol !== symbol ? { symbol, expanded: selectedMore }
      : selectedMore && !current.expanded ? { symbol, expanded: true } : current);
  }, [symbol, selectionId, selectedMore]);
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => { const node = rail.current; if (node) setEdges({ left: node.scrollLeft > 2, right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2 }); };
  useEffect(() => {
    const node = rail.current; if (!node) return;
    const card = Array.from(node.querySelectorAll<HTMLButtonElement>('[data-preset-id]')).find(entry => entry.dataset.presetId === selectionId);
    // Change this rail's offset only: scrollIntoView would also move the model
    // panel/page and push the user's molecule out of view.
    if (card) {
      const outer = node.getBoundingClientRect(), inner = card.getBoundingClientRect();
      if (inner.left < outer.left + 2) node.scrollLeft += inner.left - outer.left - 2;
      else if (inner.right > outer.right - 2) node.scrollLeft += inner.right - outer.right + 2;
    }
    updateEdges();
    const observer = new ResizeObserver(updateEdges); observer.observe(node);
    return () => observer.disconnect();
  }, [selectionId, symbol, expanded]);
  const scroll = (direction: number) => { const node = rail.current; if (node) { node.scrollLeft += direction * Math.max(120, node.clientWidth * .65); updateEdges(); } };
  const shortLabel = (entry: ElementPreset) => {
    if (entry.family === 'atom') return 'Atom';
    const label = entry.label.replace(/^(\d+) 配位 · /, '$1 · ').replace('线性 sp · ', 'sp · ').replace('平面 sp² · ', 'sp² · ').replace('芳香 · 两芳香＋单', '芳香').replace('四面体 sp³', 'sp³ · 四面体');
    return entry.family === 'coordination' && entry.slots.some(slot => slot.fill === 'hydrogen')
      ? `历史 H · ${label.replace(/历史\s*H\s*封端[ ·]*/g, '').replace(/[ ·]+$/, '')}` : label;
  };
  const help = 'H 为真实氢原子；空心端点为连接端，不是 H 或配体原子。卡片提供初始几何。';
  const renderCard = (entry: ElementPreset) => {
    const hydrogens = entry.slots.filter(slot => slot.fill === 'hydrogen').length;
    const open = entry.slots.filter(slot => slot.fill === 'open').length;
    const detail = entry.family === 'atom' ? '裸原子 · 无自动 H'
      : `${hydrogens ? `${hydrogens} 个真实 H` : '无自动 H'}${open ? ` · ${open} 个连接端（非原子）` : ''}`;
    return <button type="button" key={entry.id} className="element-preset-card" data-preset-id={entry.id} data-preset-category={entry.category ?? 'common'} aria-label={entry.label} aria-pressed={selectionId === entry.id} disabled={disabled} title={`${entry.label} · ${detail}。${entry.description}`} onClick={() => onChange(entry.id)}>
      <ElementPresetPreview preset={entry} />
      <span className="element-preset-name">{shortLabel(entry)}</span>
    </button>;
  };
  return <section className="element-preset-palette" aria-label={`${symbol} 元素几何片段`}>
    <div className="element-preset-heading" title={help}><strong>{symbol}</strong><span>片段</span><span className="element-preset-legend">H 实氢<br />○ 连接端</span>{onClose && <button type="button" onClick={onClose} aria-label="关闭元素片段">×</button>}</div>
    <div className="element-preset-atom">{renderCard(atom)}</div>
    <button className="element-preset-scroll" type="button" aria-label="上一组元素几何" disabled={!edges.left} onClick={() => scroll(-1)}>‹</button>
    <div className="element-preset-grid" ref={rail} onScroll={updateEdges} aria-label="可横向滚动的几何片段">
      {common.map(renderCard)}
      {expanded && more.length > 0 && <span className="element-preset-group-divider" aria-label="更多几何分组">更多</span>}
      {expanded && more.map(renderCard)}
    </div>
    <button className="element-preset-scroll" type="button" aria-label="下一组元素几何" disabled={!edges.right} onClick={() => scroll(1)}>›</button>
    {more.length > 0 && <button className="element-preset-more" type="button" aria-label={expanded ? '收起更多元素几何' : '展开更多元素几何'} aria-expanded={expanded} onClick={() => setGroup({ symbol, expanded: !expanded })}><span>{expanded ? '收起' : '更多'}</span><span>{more.length}</span></button>}
  </section>;
}
