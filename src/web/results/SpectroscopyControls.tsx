import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import NumericInput from '../NumericInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SpectrumProjection, SpectrumStick } from '../../results/spectroscopy';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import { ScientificPlot } from './ScientificPlot';
import { ScientificDataTable, type ScientificTableRowAction } from './ScientificDataTable';
import { type ScientificTableFormat, type ScientificTableProjection } from './scientific-table';
import { spectrumAxisRange, spectrumText } from './spectroscopy-presentation';
import { formatResultValue } from '../../results/numeric-format';
import './SpectroscopyControls.css';

export function SpectroscopyTable({ projection, fileName, selectedKey, onSelect, selectionScope, format, revealRow, onPreview, onClearActive, rowAction, variant, hideTitle, initialColumnMinWidths }: { projection: ScientificTableProjection; fileName: string; selectedKey?: string; onSelect?(key: string): void; selectionLabel?: string; selectionScope?:string; format?:ScientificTableFormat; revealRow?:{key:string;requestId:number};onPreview?(key:string|null):void;onClearActive?():void;rowAction?:ScientificTableRowAction;variant?:'numeric'|'legacy';hideTitle?:boolean;initialColumnMinWidths?:readonly number[] }) {
  const root=useRef<HTMLDivElement>(null);
  return <div ref={root} className="analysis-result"><ScientificDataTable variant={variant} projection={projection} title={format?.ariaLabel} hideTitle={hideTitle} revealRow={revealRow} selectionScope={selectionScope} activeRowKey={selectedKey} format={format} exportFileName={fileName} onRowActivate={onSelect ? row => onSelect(row.key) : undefined} onRowPreview={onPreview?row=>onPreview(row?.key??null):undefined} onClearActive={onClearActive} rowAction={rowAction} initialColumnMinWidths={initialColumnMinWidths}/></div>;
}
function SpectroscopyControlsInner(p: { title: string; identity: string; appearanceKey?: string; axis: string; fwhmUnit: string; defaultFwhm: number;
  fwhm?: number; onFwhmChange?(value: number): void; hideFwhmControl?: boolean; peakShape?: 'gaussian' | 'lorentzian';
  decimals?:number;
  presentation?: 'card' | 'section';
  broadening?: boolean;
  rawSticks?: { points: SpectrumStick[]; intensityUnit: string };
  settings?: ReactNode;
  build(options: { range?: [number, number]; fwhm: number; normalize: boolean }): SpectrumProjection;
  selectedIndex?: number; onSelectIndex?(index: number): void; sourceIndex?(line: number, sourceIndex?: number): number | undefined }) {
  const [localFwhm, setFwhm] = useProjectState('SpectroscopyControls.localFwhm', p.defaultFwhm), [normalize, setNormalize] = useProjectState('SpectroscopyControls.normalize', false), [sticks, setSticks] = useProjectState('SpectroscopyControls.sticks', !!p.rawSticks);
  const broadening = p.broadening !== false;
  const fwhm = p.fwhm ?? localFwhm;
  const [reverseX, setReverseX] = useProjectState('SpectroscopyControls.reverseX', false), [reverseY, setReverseY] = useProjectState('SpectroscopyControls.reverseY', false);
  const [rangeSetting, setRangeSetting] = useProjectState<{ axis: string; value: [number, number] }>('SpectroscopyControls.rangeSetting'), [draft, setDraft] = useProjectState<[string, string]>('SpectroscopyControls.draft', ['', '']);
  const range = useMemo(() => spectrumAxisRange(rangeSetting?.value, rangeSetting?.axis ?? p.axis, p.axis), [rangeSetting, p.axis]);
  useEffect(() => { setDraft(range ? [String(range[0]), String(range[1])] : ['', '']); }, [p.axis]);
  const built = useMemo(() => { if (!broadening) return { spectrum: null, error: '' }; try { return { spectrum: p.build({ range, fwhm, normalize }), error: '' }; } catch (error) { return { spectrum: null, error: error instanceof Error ? error.message : String(error) }; } }, [p.build, range, fwhm, normalize, broadening]);
  const spectrum = built.spectrum, lo = Number(draft[0]), hi = Number(draft[1]);
  const validRange = draft.every(value => value.trim() !== '') && [lo, hi].every(Number.isFinite) && lo < hi && (p.axis !== 'eV' && p.axis !== 'nm' || lo > 0);
  const rawPoints = spectrum?.sticks ?? p.rawSticks?.points ?? [];
  const rawUnit = spectrum?.stickIntensityUnit ?? p.rawSticks?.intensityUnit ?? '';
  const stickPoints = rawPoints.map(point => { const index = p.sourceIndex?.(point.sourceLine, point.sourceIndex); return { ...point, index, label: `${p.title}棒谱`, tooltip: `${p.title}棒谱 · ${formatResultValue(point.x,p.decimals??2)} ${p.axis} · ${formatResultValue(point.y,p.decimals??2)} ${rawUnit}` }; });
  const visibleSticks = stickPoints.filter(point => !range || point.x >= range[0] && point.x <= range[1]);
  const toolbar = <><div className="spectroscopy-control-row">
    {p.settings}
    {broadening && !p.rawSticks && <span>{(p.peakShape ?? (p.fwhmUnit === 'eV' ? 'gaussian' : 'lorentzian')) === 'gaussian' ? '高斯展宽' : '洛伦兹展宽'}</span>}
    {broadening && <label><input aria-label={`${p.title}叠加棒谱`} type="checkbox" checked={sticks} onChange={event => setSticks(event.target.checked)}/>叠加棒谱</label>}
    {!p.hideFwhmControl && <label>FWHM / {p.fwhmUnit}<NumericInput aria-label={`${p.title} FWHM`}  min={0.000001} step={p.fwhmUnit === 'eV' ? .01 : 1} value={fwhm} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) { setFwhm(value); p.onFwhmChange?.(value); } }}/></label>}
    {broadening && <label><input aria-label={`${p.title}归一化`} type="checkbox" checked={normalize} onChange={event => setNormalize(event.target.checked)}/>归一化</label>}
    <label><input type="checkbox" checked={reverseX} onChange={event => setReverseX(event.target.checked)}/>反转 X</label>
    <label><input type="checkbox" checked={reverseY} onChange={event => setReverseY(event.target.checked)}/>反转 Y</label>
  </div><div className="spectroscopy-control-row"><span>生成范围 / {p.axis}</span>{([0, 1] as const).map(index => <NumericInput key={index}  aria-label={`${p.title}范围${index ? '终点' : '起点'}`} placeholder={spectrum ? String(spectrum.range[index]) : ''} value={draft[index]} onChange={event => setDraft(previous => index ? [previous[0], event.target.value] : [event.target.value, previous[1]])}/>)}
    <button type="button" disabled={!validRange} onClick={() => setRangeSetting({ axis: p.axis, value: [lo, hi] })}>应用范围</button><button type="button" onClick={() => { setRangeSetting(undefined); setDraft(['', '']); }}>自动范围</button></div></>;
  const contents = <>{built.error && <DismissibleNotice role="alert">{built.error}</DismissibleNotice>}{(spectrum || rawPoints.length > 0) && <ScientificPlot title={p.title} xLabel={p.axis} yLabel={spectrum?.intensityUnit ?? rawUnit}
      toolbar={toolbar} plotStyle="spectrum" appearanceKey={`spectrum:${p.appearanceKey ?? p.identity}:${p.title}`}
      series={spectrum ? [{ id: 'spectrum', label: p.title, kind: 'line', points: spectrum.points }] : [{ id: 'spectrum-sticks', label: '原始棒谱', kind: 'stick', points: stickPoints }]}
      secondaryYAxis={spectrum && sticks ? { label: `棒谱 / ${rawUnit}`, series: [{ id: 'spectrum-sticks', label: '原始棒谱', kind: 'stick', points: stickPoints }] } : undefined}
      selectedIndex={p.selectedIndex} onSelectIndex={p.onSelectIndex} reverseX={reverseX} reverseY={reverseY} xDomain={spectrum?undefined:range} resetKey={`${p.identity}:${p.axis}:${range}:${fwhm}:${normalize}:${sticks}`}
      decimals={p.decimals??2} exportFileName={`Ester-Studio-${p.title}`} exportText={{ fileName: `Ester-Studio-${p.title}.txt`, text: spectrum ? spectrumText(spectrum, false,p.decimals??2) + (sticks ? `\n原始棒谱\n${spectrumText(spectrum, true,p.decimals??2)}` : '') : [`${p.axis}\t${rawUnit}`, ...visibleSticks.map(point => `${formatResultValue(point.x,p.decimals??2)}\t${formatResultValue(point.y,p.decimals??2)}`)].join('\n') + '\n' }} testId="spectroscopy-plot"/>}</>;
  return p.presentation === 'section' ? <AnalysisTaskSection title={p.title} className="spectroscopy-card">{contents}</AnalysisTaskSection> : <AnalysisTaskLayout variant="card" methodDetails title={p.title} className="spectroscopy-card">{contents}</AnalysisTaskLayout>;
}

export default function SpectroscopyControls(p: Parameters<typeof SpectroscopyControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['SpectroscopyControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><SpectroscopyControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:SpectroscopyControlsInner(p);
}
