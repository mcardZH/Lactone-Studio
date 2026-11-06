import { surfaceContextKey } from './surface-presentation';
import { useCallback, useState } from 'react';
import type { InteractionScatterSnapshot } from './interaction-controls-contracts';
import ScientificScatterPlot from './ScientificScatterPlot';
import { surfaceColor } from '../modeling/render/surface-layer';
import { interactionScatterInitialViewport } from './interaction-presentation';

/** Shared chart content; the enclosing deck supplies real source identity. */
export default function InteractionScatterWindow({ snapshot }: { snapshot: InteractionScatterSnapshot & { id: string; title: string } }) {
  const [display, setDisplay] = useState(snapshot.display);
  const colorForX = useCallback((value: number) => display.color ? surfaceColor(value, display.color) : '#64748b', [display.color]);
  return <ScientificScatterPlot appearanceKey={`interaction-scatter:${surfaceContextKey(snapshot.context)}:${snapshot.method}:${snapshot.component}`} title={snapshot.title} xLabel={snapshot.xLabel} yLabel={snapshot.yLabel} data={snapshot.data} decimals={snapshot.decimals}
    colorForX={colorForX} colorLegend={display.color ?? undefined}
    pointSize={display.scatterPointSize} onPointSizeChange={scatterPointSize => setDisplay(value => ({ ...value, scatterPointSize }))}
    opacity={display.scatterOpacity} onOpacityChange={scatterOpacity => setDisplay(value => ({ ...value, scatterOpacity }))}
    viewport={display.scatterViewport} initialViewport={interactionScatterInitialViewport(snapshot.method, snapshot.component)} onViewportChange={scatterViewport => setDisplay(value => ({ ...value, scatterViewport }))} resetKey={snapshot.id}/>;
}
