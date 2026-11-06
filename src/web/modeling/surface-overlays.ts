import type { ModelDocument, ScreenPoint } from '../../modeling/contracts';
import type { Vector3 } from '../../core/types';
import { resultLabelPresentation, type ResultLabelItem } from './result-label-presentation';
import { surfaceExtremaPoints, surfaceExtremumDocumentPosition, type ViewportSurfaceExtrema } from './render/surface-layer';

/** Same spatial anchors and label contract for screen and offscreen images. */
export function projectSurfaceExtremaLabels(layer: ViewportSurfaceExtrema | null | undefined, document: Pick<ModelDocument, 'id' | 'revision'>,
  project: (position: Vector3) => ScreenPoint, offset: ScreenPoint, fontSize: number): ResultLabelItem[] {
  if (!layer) return [];
  if (layer.valuesVisible === false && !layer.coordinatesVisible) return [];
  const pinned = new Set(layer.pinnedIds);
  return surfaceExtremaPoints(layer, document).filter(point => layer.showAllValues || pinned.has(point.id) || layer.hoveredId === point.id).flatMap(point => {
    const showValue = layer.valuesVisible !== false, showCoordinates = layer.coordinatesVisible && point.coordinateLabel;
    // Coordinate-only annotations still identify their scientific target. Pins
    // choose targets; they never override a disabled presentation channel.
    if (!showValue && !showCoordinates) return [];
    const identity = point.identityLabel ?? `${point.global ? '全局' : '局部'}${point.kind === 'maximum' ? '极大' : '极小'} ${point.id}`;
    const label = [showValue ? point.label : identity, showCoordinates ? point.coordinateLabel : null].filter(Boolean).join('\n');
    const projected = project(surfaceExtremumDocumentPosition(layer, point.position)), target = { x: projected.x - offset.x, y: projected.y - offset.y };
    return [{ id: `surface-extremum:${point.id}`, presentation: resultLabelPresentation(label, { x: target.x + 13, y: target.y + 15 }, 'top-left', fontSize), target,
      attributes: { 'data-testid': 'surface-extremum-label', 'data-surface-extremum-id': point.id } }];
  });
}
