import { surfaceContextKey } from './surface-presentation';
import { useCallback, useMemo, useState } from 'react';
import type { InteractionScatterSnapshot } from './interaction-controls-contracts';
import ScientificScatterPlot from './ScientificScatterPlot';
import { surfaceColor } from '../modeling/render/surface-layer';
import { interactionScatterInitialViewport } from './interaction-presentation';

/** Shared chart content; the enclosing deck supplies real source identity. */
export default function InteractionScatterWindow({ snapshot }: { snapshot: InteractionScatterSnapshot & { id: string; title: string } }) {
  const [display, setDisplay] = useState(snapshot.display);
  const mapping = useMemo(() => {
    const color = display.color;
    if (color && Number.isFinite(color.min) && Number.isFinite(color.max) && color.min < color.max) return { ...color, zeroCentered: true };
  }, [display.color]);
  const colorForX = useCallback((value: number) => mapping ? surfaceColor(value, mapping) : '#64748b', [mapping]);
  const colorLegend = useMemo(() => mapping ? { ...mapping,
    colors: mapping.reverse ? [...mapping.colors].reverse() : mapping.colors } : undefined, [mapping]);
  return <ScientificScatterPlot appearanceKey={`interaction-scatter:${surfaceContextKey(snapshot.context)}:${snapshot.method}:${snapshot.component}`} title={snapshot.title} xLabel={snapshot.xLabel} yLabel={snapshot.yLabel} data={snapshot.data} decimals={snapshot.decimals}
    colorForX={colorForX} colorLegend={colorLegend}
    pointSize={display.scatterPointSize} opacity={display.scatterOpacity}
    viewport={display.scatterViewport} initialViewport={interactionScatterInitialViewport(snapshot.method, snapshot.component)} onViewportChange={scatterViewport => setDisplay(value => ({ ...value, scatterViewport }))} resetKey={snapshot.id}/>;
}
