import { useMemo } from 'react';
import type { Structure } from '../../core/types';
import type { CoordinateTrace } from '../../results/scientific-analysis';
import { internalCoordinateName, plotCoordinateUnit } from '../../results/optimization-plot-axis';
import ScientificPlot from './ScientificPlot';

export default function CoordinatePlot({ trace, currentIndex, onSelectFrame, appearanceKey, atoms, sourceFrames }: {
  appearanceKey?: string | number; trace: CoordinateTrace; currentIndex: number; onSelectFrame(index: number): void;
  atoms?: readonly Pick<Structure['atoms'][number], 'element'>[]; sourceFrames?: readonly { sourceFrameIndex?: number }[];
}) {
  const name = internalCoordinateName[trace.kind], unit = plotCoordinateUnit(trace.unit);
  const title = `${name}: ${trace.atomIndices.map(index => `${atoms?.[index]?.element ?? ''}${index + 1}`).join('–')}`;
  const series = useMemo(() => [{ id: 'coordinate', label: name, points: trace.points.map(point => ({
    x: point.frameIndex + 1, y: point.value, index: point.frameIndex,
    readoutId: (sourceFrames?.[point.frameIndex]?.sourceFrameIndex ?? point.frameIndex) + 1,
  })) }], [name, sourceFrames, trace]);
  const text = () => [`Frame\t${name} / ${unit}`, ...trace.points.map(point => `${point.frameIndex + 1}\t${point.value ?? ''}`)].join('\n') + '\n';
  return <ScientificPlot appearanceKey={appearanceKey} title={title} xLabel="Frame Index" yLabel={`${name} (${unit})`} series={series} selectedIndex={currentIndex} onSelectIndex={onSelectFrame} resetKey={title}
      pointReadout={{ kind: 'Frame', yUnit: unit }}
      exportFileName="Ester-Studio-coordinate" exportText={{ fileName: 'Ester-Studio-coordinate.txt', text }} testId="coordinate-plot-svg" ariaLabel="从来源坐标计算的内坐标；点击曲线横向位置选择结构帧"/>;
}
