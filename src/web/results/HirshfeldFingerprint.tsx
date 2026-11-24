import { surfaceContextKey } from './surface-presentation';
import { useCallback, useMemo } from 'react';
import type { HirshfeldAnalysisResult } from '../../results/hirshfeld-contracts';
import { hirshfeldFingerprintDensity, hirshfeldSampleMatches, hirshfeldContactLabel, initialHirshfeldFingerprintDisplay, type HirshfeldContactFocus, type HirshfeldFingerprintDisplay } from '../../results/hirshfeld-presentation';
import ScientificScatterPlot from './ScientificScatterPlot';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox } from '../InputSettingsLayout';
import NumericInput from '../NumericInput';

export interface HirshfeldPlotExportHandle { snapshotSvg(): Promise<string>; ownerDocument: Document; focus: HirshfeldContactFocus | null }
/** Embedded, independent and batch exports all use this exact full-data plot. */
export default function HirshfeldFingerprint(p: { result: Pick<HirshfeldAnalysisResult, 'stamp' | 'source' | 'vertices' | 'contacts'>; focus: HirshfeldContactFocus | null; decimals: number;
  onContact?(value: HirshfeldContactFocus | null): void; merged: boolean; display?: HirshfeldFingerprintDisplay; onDisplay?(value: HirshfeldFingerprintDisplay): void;
  showDisplayControls?: boolean; exportEpoch?: unknown; exportHandle?(value: HirshfeldPlotExportHandle | null): void }) {
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
  const mutedForPoint=useCallback((index:number)=>!hirshfeldSampleMatches(p.result.vertices[index],p.result.source,p.focus),[p.result,p.focus]);
  const valueForPoint=useCallback((index:number)=>density[index],[density]);
  const colorForPoint = useCallback((index: number) => mutedForPoint(index)?'#bfbfbf':colorForX(density[index]),
    [density,colorForX,mutedForPoint]);
  const exportHandle = useCallback((handle: import('./ScientificScatterPlot').ScientificScatterExportHandle | null) => p.exportHandle?.(handle ? { ...handle, focus: p.focus } : null), [p.exportHandle, p.focus, p.exportEpoch]);
  const colorLegend = useMemo(() => ({min:settings.densityMin,max,label:'Local point count',
    colors:['#0000ff','#00ffff','#00b400'],direction:'vertical' as const,logarithmic:settings.logarithmic,valueForPoint,mutedForPoint}),
    [settings.densityMin,max,settings.logarithmic,valueForPoint,mutedForPoint]);
  const metadata = useMemo(() => ({ definition: 'hirshfeld-weight-0.5', color: 'complete-native-point-count-in-euclidean-radius', radiusAngstrom: settings.radiusAngstrom, includesSelf: true,
    display: settings, areaWeighted: false, scope: p.result.contacts ? 'whole-surface' : 'current-range', denominator: p.result.contacts?.denominator ?? null, contact: p.focus, source: p.result.stamp }), [settings, p.result, p.focus]);
  const title = `Hirshfeld Fingerprint${p.focus ? ' · ' + hirshfeldContactLabel(p.focus) : ''}${p.result.contacts ? '' : ' · Current Region'}`;
  return <ScientificScatterPlot appearanceKey={`hirshfeld-fingerprint:${surfaceContextKey(p.result.stamp)}:${p.result.stamp.requestId}:${p.focus ? `${p.focus.insideElement}:${p.focus.outsideElement}:${p.focus.merged}` : 'all'}`} title={title} xLabel="dᵢ / Å" yLabel="dₑ / Å" data={data} initialViewport={initialViewport} decimals={p.decimals}
    colorForX={colorForX} colorForPoint={colorForPoint} colorLegend={colorLegend} resetKey={p.result.stamp.requestId} exportFileName="Ester-Studio-hirshfeld-fingerprint"
    pointSize={settings.pointSize} exportHandle={exportHandle}
    colorScaleControls={p.showDisplayControls && p.onDisplay ? (scale, updateScale, manualRange) => {
      const [low, high] = scale.range;
      const automatic = !manualRange && settings.densityMax === null;
      const setDensityRange = (densityMin: number, densityMax: number | null) => {
        p.onDisplay?.({ ...settings, densityMin, densityMax });
        if (manualRange) updateScale({ range: undefined });
      };
      const useAutomaticRange = () => setDensityRange(settings.densityMin, null);
      return <details className="analysis-method-details"><summary>显示设置</summary><InputSettingsRow>
        <InputSettingsAction onClick={() => {
          p.onDisplay?.({ radiusAngstrom: .02, densityMin: 1, densityMax: 750, logarithmic: false, pointSize: .5 });
          if (manualRange || scale.logarithmic !== settings.logarithmic) updateScale({ range: undefined, logarithmic: undefined });
        }}>图库预设</InputSettingsAction>
        <InputSettingsAction onClick={useAutomaticRange}>自动色阶</InputSettingsAction>
        <InputSettingsField label="点密度半径 / Å"><NumericInput aria-label="指纹点密度半径" min={.001} step={.005} value={settings.radiusAngstrom}
          onChange={event => {
            const radiusAngstrom = event.currentTarget.valueAsNumber;
            if (Number.isFinite(radiusAngstrom) && radiusAngstrom > 0) p.onDisplay?.({ ...settings, radiusAngstrom });
          }}/></InputSettingsField>
        <InputSettingsField label="点数色标最小值"><NumericInput min={1} aria-label="指纹点数色标最小值" value={low}
          onChange={event => {
            const densityMin = event.currentTarget.valueAsNumber;
            if (!Number.isFinite(densityMin) || densityMin < 1) return;
            if (automatic || densityMin < high) setDensityRange(densityMin, automatic ? null : high);
          }}/></InputSettingsField>
        <InputSettingsField label="最大值"><NumericInput aria-label="指纹点数色标最大值" placeholder={`自动（${high}）`} value={automatic ? '' : high}
          onChange={event => {
            if (event.currentTarget.value === '') { useAutomaticRange(); return; }
            const densityMax = event.currentTarget.valueAsNumber;
            if (Number.isFinite(densityMax) && densityMax > low) setDensityRange(low, densityMax);
          }}/></InputSettingsField>
        <InputSettingsCheckbox label="对数色标" checked={scale.logarithmic === true} onChange={logarithmic => {
          p.onDisplay?.({ ...settings, logarithmic });
          if (scale.logarithmic !== settings.logarithmic) updateScale({ logarithmic: undefined });
        }}/>
      </InputSettingsRow></details>;
    } : undefined}
    metadata={metadata}
    onPointSelect={point => {
      if (!point) { p.onContact?.(null); return; }
      const sample = p.result.vertices[point.index], inside = new Set(sample.insideAtomIndices.map(i => p.result.source.atoms[i - 1].element)),
        outside = new Set(sample.outsideAtomIndices.map(i => p.result.source.atoms[i - 1].element));
      if (inside.size === 1 && outside.size === 1) p.onContact?.({ insideElement: [...inside][0], outsideElement: [...outside][0], merged: p.merged });
    }}/ >;
}
