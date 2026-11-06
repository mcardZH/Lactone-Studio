import { useEffect, useId, useState } from 'react';
import {useProjectState,useProjectUiScope} from '../../projects/ui-state';
import NumericInput from '../NumericInput';
import fontData from './fonts/DejaVuSans.woff2.txt?raw';
import './ScientificPlotSettings.css';

export const plotFontCss = `@font-face{font-family:'Ester Studio DejaVu Sans';src:url(${fontData.trim()}) format('woff2');font-weight:400;font-style:normal;font-display:block;}`;
export const plotFontFamily = (font: string) => font === 'Arial' ? 'Arial, "Microsoft YaHei", sans-serif' : '"Ester Studio DejaVu Sans", "Microsoft YaHei", sans-serif';
export const plotPt = (value: number) => value * 4 / 3;
export interface PlotAppearance {
  title?: string; xLabel?: string; yLabel?: string; font: string; baseSize: number;
  titleSize: number; axisSize: number; tickSize: number; legendSize: number; names: Record<string, string>;
}
const defaults = (): PlotAppearance => ({ font: 'DejaVu Sans', baseSize: 10, titleSize: 11, axisSize: 10, tickSize: 9, legendSize: 9, names: {} });
// Display state only. Bounded retention permits a figure to move to its own window.
const appearances = new Map<string, PlotAppearance>();
const listeners = new Map<string, Set<() => void>>();
export function usePlotAppearance(ownerKey?: string | number) {
  const instance = useId(), key = ownerKey === undefined ? instance : String(ownerKey);
  const [local, setLocal] = useState<{ key: string; value: PlotAppearance }>(() => ({ key, value: appearances.get(key) ?? defaults() }));
  const project=useProjectUiScope(),[projectValue,setProjectValue]=useProjectState<PlotAppearance>('plot.appearance',defaults,key);
  const value = project?projectValue:local.key === key ? local.value : appearances.get(key) ?? defaults();
  useEffect(() => {
    const subscriptions = listeners.get(key) ?? new Set<() => void>(); listeners.set(key, subscriptions);
    const refresh = () => setLocal({ key, value: appearances.get(key) ?? defaults() }); subscriptions.add(refresh); refresh();
    return () => { subscriptions.delete(refresh); if (!subscriptions.size) listeners.delete(key); };
  }, [key]);
  const update = (patch: Partial<PlotAppearance>) => {
    if(project){setProjectValue({...value,...patch});return;}
    const next = { ...value, ...patch }; appearances.delete(key); appearances.set(key, next);
    while (appearances.size > 128) appearances.delete(appearances.keys().next().value!);
    setLocal({ key, value: next });
    listeners.get(key)?.forEach(refresh => refresh());
  };
  const reset = () => { const next = defaults();if(project){setProjectValue(next);return;} appearances.set(key, next); setLocal({ key, value: next }); listeners.get(key)?.forEach(refresh => refresh()); };
  return { key,value, update, reset, name: (id: string, fallback: string) => value.names[id] ?? fallback };
}
/** Load the shared font once per actual document (including portal windows). */
export function usePlotFont(ownerDocument?: Document) {
  useEffect(() => {
    const doc = ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
    if (!doc || doc.querySelector('[data-scientific-plot-font]')) return;
    const style = doc.createElement('style'); style.dataset.scientificPlotFont = 'true'; style.textContent = plotFontCss; doc.head.append(style);
  }, [ownerDocument]);
}
export type PlotAppearanceControl = ReturnType<typeof usePlotAppearance>;
export function ScientificPlotSettings({ appearance, title, xLabel, yLabel, names = [] }: {
  appearance: PlotAppearanceControl; title: string; xLabel?: string; yLabel?: string; names?: readonly { id: string; label: string }[];
}) {
  const a = appearance.value;
  const [open,setOpen]=useProjectState('plot-settings.open',false,appearance.key),[fontsOpen,setFontsOpen]=useProjectState('plot-settings.fontsOpen',false,appearance.key),[namesOpen,setNamesOpen]=useProjectState('plot-settings.namesOpen',false,appearance.key);
  const size = (key: 'titleSize' | 'axisSize' | 'tickSize' | 'legendSize', label: string) => <label>{label}<NumericInput aria-label={`绘图${label}`} min={5} max={36} step={1} value={a[key]} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 5 && n <= 36) appearance.update({ [key]: n }); }}/><span>pt</span></label>;
  return <details className="scientific-plot-settings" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary><span>绘图设置</span><button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); appearance.reset(); }}>恢复默认</button></summary><div className="scientific-plot-settings-body">
    <label className="scientific-plot-title-field">标题<input aria-label="绘图标题" value={a.title ?? title} onChange={e => appearance.update({ title: e.target.value })}/></label>
    {(xLabel !== undefined || yLabel !== undefined) && <div className="scientific-plot-setting-row">{xLabel !== undefined && <label>X轴名称<input aria-label="绘图X轴名称" value={a.xLabel ?? xLabel} onChange={e => appearance.update({ xLabel: e.target.value })}/></label>}{yLabel !== undefined && <label>Y轴名称<input aria-label="绘图Y轴名称" value={a.yLabel ?? yLabel} onChange={e => appearance.update({ yLabel: e.target.value })}/></label>}</div>}
    <div className="scientific-plot-setting-row"><label>字体<select aria-label="绘图字体" value={a.font} onChange={e => appearance.update({ font: e.target.value })}><option>DejaVu Sans</option><option>Arial</option></select></label><label>基础字号<NumericInput aria-label="绘图基础字号" min={5} max={36} step={1} value={a.baseSize} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 5 && n <= 36) { const ratio = n / a.baseSize; appearance.update({ baseSize: n, titleSize: a.titleSize * ratio, axisSize: a.axisSize * ratio, tickSize: a.tickSize * ratio, legendSize: a.legendSize * ratio }); } }}/><span>pt</span></label></div>
    <details open={fontsOpen} onToggle={event=>setFontsOpen(event.currentTarget.open)}><summary>文字字号</summary><div className="scientific-plot-setting-row">{size('titleSize', '标题字号')}{size('axisSize', '坐标轴字号')}{size('tickSize', '刻度字号')}{size('legendSize', '图例/数值标签字号')}</div></details>
    {names.length > 0 && <details open={namesOpen} onToggle={event=>setNamesOpen(event.currentTarget.open)}><summary>系列与分类名称</summary>{names.map(item => <label className="scientific-plot-name-field" key={item.id}><span>{item.label} →</span><input aria-label={`${item.label}显示名`} value={appearance.name(item.id, item.label)} onChange={e => appearance.update({ names: { ...a.names, [item.id]: e.target.value } })}/></label>)}</details>}
  </div></details>;
}
