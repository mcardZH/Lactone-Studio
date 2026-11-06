import { surfaceContextKey } from './surface-presentation';
import { useCallback, useMemo } from 'react';
import type { HirshfeldAnalysisResult } from '../../results/hirshfeld-contracts';
import { hirshfeldFingerprintDensity, hirshfeldSampleMatches, hirshfeldContactLabel, initialHirshfeldFingerprintDisplay, type HirshfeldContactFocus, type HirshfeldFingerprintDisplay } from '../../results/hirshfeld-presentation';
import ScientificScatterPlot from './ScientificScatterPlot';

export interface HirshfeldPlotExportHandle { snapshotSvg(): Promise<string>; ownerDocument: Document; focus: HirshfeldContactFocus | null }
/** Embedded, independent and batch exports all use this exact full-data plot. */
export default function HirshfeldFingerprint(p: { result: Pick<HirshfeldAnalysisResult, 'stamp' | 'source' | 'vertices' | 'contacts'>; focus: HirshfeldContactFocus | null; decimals: number;
  onContact?(value: HirshfeldContactFocus | null): void; merged: boolean; display?: HirshfeldFingerprintDisplay; onDisplay?(value: HirshfeldFingerprintDisplay): void;
  exportEpoch?: unknown; exportHandle?(value: HirshfeldPlotExportHandle | null): void }) {
  const settings = useMemo(() => p.display ?? initialHirshfeldFingerprintDisplay(), [p.display]);
  const data = useMemo(() => ({ x: Float64Array.from(p.result.vertices, row => row.di), y: Float64Array.from(p.result.vertices, row => row.de) }), [p.result]);
  const initialViewport = useMemo(() => { let min = Infinity, max = -Infinity; for (const row of p.result.vertices) { min = Math.min(min, row.di, row.de); max = Math.max(max, row.di, row.de); } const pad = (max - min || 1) * .04; return { x: [min - pad, max + pad] as [number, number], y: [min - pad, max + pad] as [number, number] }; }, [p.result]);
  const density = useMemo(() => hirshfeldFingerprintDensity(p.result.vertices, settings.radiusAngstrom), [p.result, settings.radiusAngstrom]);
  const max = useMemo(() => { let value = settings.densityMin + 1; for (const number of density) value = Math.max(value, number); return settings.densityMax ?? value; }, [density, settings.densityMax, settings.densityMin]);
  const colorForX = useCallback((value: number) => {
    const normalize = (n: number) => settings.logarithmic ? Math.log(Math.max(Number.MIN_VALUE, n)) : n;
    const min = normalize(settings.densityMin), upper = normalize(max), t = Math.max(0, Math.min(1, (normalize(value) - min) / (upper - min || 1)));
    // The gallery density scale is blue → cyan → green, not a per-contact scale.
    const a = t <= .5 ? [0, 0, 255] : [0, 255, 255], b = t <= .5 ? [0, 255, 255] : [0, 180, 0], local = t <= .5 ? t * 2 : t * 2 - 1;
    return `rgb(${a.map((n, i) => Math.round(n + (b[i] - n) * local)).join(',')})`;
  }, [max, settings.densityMin, settings.logarithmic]);
  const colorForPoint = useCallback((index: number) => hirshfeldSampleMatches(p.result.vertices[index], p.result.source, p.focus)
    ? colorForX(density[index]) : '#bfbfbf', [density, colorForX, p.focus, p.result]);
  const exportHandle = useCallback((handle: import('./ScientificScatterPlot').ScientificScatterExportHandle | null) => p.exportHandle?.(handle ? { ...handle, focus: p.focus } : null), [p.exportHandle, p.focus, p.exportEpoch]);
  const colorLegend = useMemo(() => ({ min: settings.densityMin, max, label: settings.logarithmic ? '邻域点数（对数）' : '邻域点数' }), [settings.densityMin, max, settings.logarithmic]);
  const metadata = useMemo(() => ({ definition: 'hirshfeld-weight-0.5', color: 'complete-native-point-count-in-euclidean-radius', radiusAngstrom: settings.radiusAngstrom, includesSelf: true,
    display: settings, areaWeighted: false, scope: p.result.contacts ? 'whole-surface' : 'current-range', denominator: p.result.contacts?.denominator ?? null, contact: p.focus, source: p.result.stamp }), [settings, p.result, p.focus]);
  return <ScientificScatterPlot appearanceKey={`hirshfeld-fingerprint:${surfaceContextKey(p.result.stamp)}:${p.result.stamp.requestId}:${p.focus ? `${p.focus.insideElement}:${p.focus.outsideElement}:${p.focus.merged}` : 'all'}`} title={`Hirshfeld指纹 · ${hirshfeldContactLabel(p.focus)}${p.result.contacts ? '' : ' · 当前范围'}`} xLabel="di / Å" yLabel="de / Å" data={data} initialViewport={initialViewport} decimals={p.decimals}
    colorForX={colorForX} colorForPoint={colorForPoint} colorLegend={colorLegend} resetKey={p.result.stamp.requestId} exportFileName="Ester-Studio-hirshfeld-fingerprint"
    pointSize={settings.pointSize} onPointSizeChange={pointSize => p.onDisplay?.({ ...settings, pointSize })} exportHandle={exportHandle}
    metadata={metadata}
    onPointSelect={point => {
      if (!point) { p.onContact?.(null); return; }
      const sample = p.result.vertices[point.index], inside = new Set(sample.insideAtomIndices.map(i => p.result.source.atoms[i - 1].element)),
        outside = new Set(sample.outsideAtomIndices.map(i => p.result.source.atoms[i - 1].element));
      if (inside.size === 1 && outside.size === 1) p.onContact?.({ insideElement: [...inside][0], outsideElement: [...outside][0], merged: p.merged });
    }}/ >;
}
