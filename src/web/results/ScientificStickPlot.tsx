import { useMemo, useState } from 'react';
import ScientificPlot from './ScientificPlot';

export interface StickPoint { x: number; rawX?: number; y: number; label: string; sourceLine: number }
export default function ScientificStickPlot({ title, xUnit, yUnit, points, onSelect }: {
  title: string; xUnit: string; yUnit: string; points: StickPoint[]; onSelect?(point: StickPoint): void;
}) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(0);
  const valid = useMemo(() => points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)), [points]);
  const pages = Math.max(1, Math.ceil(valid.length / 100)), currentPage = Math.min(page, pages - 1);
  const visible = valid.slice(currentPage * 100, (currentPage + 1) * 100);
  if (!points.length) return null;
  return <details className="scientific-stick-plot" onToggle={event => setOpen(event.currentTarget.open)}><summary>{title} · 原始线谱</summary>{open && <>
    <ScientificPlot title={`${title} · 原始线谱，未展宽`} xLabel={xUnit} yLabel={`强度 / ${yUnit}`} series={[{ id: 'raw-sticks', kind: 'stick', points: visible.map((point, index) => ({ x: point.x, y: point.y, index, label: point.label,
      tooltip: `${point.label} · ${point.x} ${xUnit}${point.rawX == null ? '' : `（原始 ${point.rawX} ${xUnit}）`} · ${point.y} ${yUnit}` })) }]}
      onSelectIndex={onSelect ? index => { const point = visible[index]; if (point) onSelect(point); } : undefined}
      resetKey={`${title}:${currentPage}`} exportFileName="Ester-Studio-spectrum" metadata={{ schema: 'sciyue-stick-spectrum.v1', broadening: null, points: visible, displayedPage: currentPage + 1, totalPoints: valid.length }}/>
    {pages > 1 && <p className="scientific-note"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页谱线</button> {currentPage + 1} / {pages} · 共 {valid.length} 根谱线；图件导出当前页 <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页谱线</button></p>}
  </>}</details>;
}
