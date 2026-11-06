import { useMemo, useState } from 'react';
import type { CoordinateTrace } from '../../results/scientific-analysis';
import ScientificPlot from './ScientificPlot';
import { AnalysisTaskSection } from './AnalysisTaskLayout';

export default function CoordinatePlot({ trace, currentIndex, onSelectFrame, appearanceKey }: { appearanceKey?: string | number; trace: CoordinateTrace; currentIndex: number; onSelectFrame(index: number): void }) {
  const [collapsed, setCollapsed] = useState(false);
  const title = `${trace.kind}(${trace.atomIndices.map(index => index + 1).join(', ')})`;
  const series = useMemo(() => [{ id: 'coordinate', label: title, points: trace.points.map(point => ({ x: point.frameIndex + 1, y: point.value, index: point.frameIndex, label: `内坐标帧 ${point.frameIndex + 1}，${point.value ?? '缺失'} ${trace.unit}` })) }], [trace]);
  const text = [`帧\t${trace.kind} / ${trace.unit}`, ...trace.points.map(point => `${point.frameIndex + 1}\t${point.value ?? ''}`)].join('\n') + '\n';
  return <AnalysisTaskSection title="内坐标曲线" className="trajectory-coordinate-plot" controls={<button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开' : '收起'}</button>}>
    <p className="trajectory-current-energy">{title} · {trace.unit} · 帧 {currentIndex + 1}</p>
    {!collapsed && <ScientificPlot appearanceKey={appearanceKey} title={title} xLabel="结构帧序号" yLabel={`${trace.kind} / ${trace.unit}`} series={series} selectedIndex={currentIndex} onSelectIndex={onSelectFrame} resetKey={title}
      exportFileName="Ester-Studio-coordinate" exportText={{ fileName: 'Ester-Studio-coordinate.txt', text }} testId="coordinate-plot-svg" ariaLabel="从来源坐标计算的内坐标；点击曲线横向位置选择结构帧"/>}</AnalysisTaskSection>;
}
