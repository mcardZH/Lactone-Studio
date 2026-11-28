import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import NumericInput from '../NumericInput';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SPECTRUM_MAX_SAMPLES, type SpectrumPeakShape, type SpectrumProjection, type SpectrumStick } from '../../results/spectroscopy';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import { ScientificPlot } from './ScientificPlot';
import { ScientificDataTable, type ScientificTableRowAction } from './ScientificDataTable';
import { type ScientificTableFormat, type ScientificTableProjection } from './scientific-table';
import { spectrumAxisRange, spectrumDataText, spectrumFigureTitles, spectrumPlotData, spectrumText, spectrumXLabel, type SpectrumDisplay, type SpectrumKind } from './spectroscopy-presentation';
import { formatResultValue } from '../../results/numeric-format';
import type {PlotSpectrumSampling,PlotSpectrumViewEdits} from '../../results/scientific-plot-editing';
import {usePlotFigure} from './scientific-plot-figure';
import {settingArray,settingBool,settingEnum,settingPositive} from './analysis-mcp-settings';
import {ResultsMcpInlinePlotSource,type NativeMcpSettings} from './results-mcp-context';
import {objectSchema} from '../mcp/types';
import './SpectroscopyControls.css';

export function SpectroscopyTable({ projection, fileName, selectedKey, onSelect, selectionScope, format, revealRow, onPreview, onClearActive, rowAction, variant, hideTitle, initialColumnMinWidths }: { projection: ScientificTableProjection; fileName: string; selectedKey?: string; onSelect?(key: string): void; selectionLabel?: string; selectionScope?:string; format?:ScientificTableFormat; revealRow?:{key:string;requestId:number};onPreview?(key:string|null):void;onClearActive?():void;rowAction?:ScientificTableRowAction;variant?:'numeric'|'legacy';hideTitle?:boolean;initialColumnMinWidths?:readonly number[] }) {
  const root=useRef<HTMLDivElement>(null);
  return <div ref={root} className="analysis-result"><ScientificDataTable variant={variant} projection={projection} title={format?.ariaLabel} hideTitle={hideTitle} revealRow={revealRow} selectionScope={selectionScope} activeRowKey={selectedKey} format={format} exportFileName={fileName} onRowActivate={onSelect ? row => onSelect(row.key) : undefined} onRowPreview={onPreview?row=>onPreview(row?.key??null):undefined} onClearActive={onClearActive} rowAction={rowAction} initialColumnMinWidths={initialColumnMinWidths}/></div>;
}
export interface SpectrumBuildOptions {
  range?: [number, number]; fwhm: number; normalize: boolean; peakShape?: SpectrumPeakShape; samples?:number;
  axis?: string; intensityUnit?: string;
}

const defaultSampling: PlotSpectrumSampling = { kind: 'count', value: 2001 };
function gridSamples(sampling: PlotSpectrumSampling, range?: [number, number]) {
  if (sampling.kind === 'count') return sampling.value;
  const intervals = range ? (range[1] - range[0]) / sampling.value : 0;
  if (intervals >= SPECTRUM_MAX_SAMPLES - 1) return SPECTRUM_MAX_SAMPLES;
  const roundingAllowance = 8 * Number.EPSILON * Math.max(1, intervals);
  return Math.max(2, Math.ceil(intervals - roundingAllowance) + 1);
}
const gridStep = (spectrum: SpectrumProjection) =>
  (spectrum.range[1] - spectrum.range[0]) / (spectrum.points.length - 1);

function SpectroscopyControlsInner(p: { kind: SpectrumKind; title: string; identity: string; appearanceKey?: string; axis: string; fwhmUnit: string; defaultFwhm: number;
  fwhm?: number; hideFwhmControl?: boolean; peakShape?: SpectrumPeakShape; hidePeakShapeControl?: boolean;
  wavelengthAxis?: boolean;
  intensityUnits?: readonly string[]; initialIntensityUnit?: string;
  ramanBroadening?: {width: string; peakShape: '' | SpectrumPeakShape};
  decimals?:number;
  presentation?: 'card' | 'section';
  broadening?: boolean;
  rawSticks?: { points: SpectrumStick[]; intensityUnit: string };
  exportRawText?: {fileName:string;text:()=>string};
  build(options: SpectrumBuildOptions): SpectrumProjection;
  selectedIndex?: number; onSelectIndex?(index: number): void; sourceIndex?(line: number, sourceIndex: number): number | undefined;
  sourceLabel?(index: number): string }) {
  const appearanceKey = `spectrum:${p.appearanceKey ?? p.identity}:${p.title}`;
  const record = usePlotFigure(appearanceKey), edits = record.figure.spectrum;
  const change = (patch: PlotSpectrumViewEdits, group?: string) => record.replace(previous => ({...previous,
    spectrum: {...previous.spectrum, ...patch},
    ...('range' in patch ? {zoom: undefined} : {}),
  }), group);
  const [localFwhm] = useProjectState('SpectroscopyControls.localFwhm', p.defaultFwhm);
  const [savedNormalize] = useProjectState('SpectroscopyControls.normalize', false);
  const [legacySticks] = useProjectState('SpectroscopyControls.sticks', false);
  const [preferredDisplay] = useProjectState<SpectrumDisplay>('SpectroscopyControls.display');
  const [localPeakShape] = useProjectState<SpectrumPeakShape>('SpectroscopyControls.peakShape', p.kind === 'uv-vis' ? 'gaussian' : 'lorentzian');
  const [savedWidthDraft] = useProjectState<string>('SpectroscopyControls.widthDraft');
  const [widthDraft, setWidthDraft] = useState<string | undefined>(() => {
    const draft = p.ramanBroadening?.width || savedWidthDraft;
    return draft !== undefined && !(Number(draft) > 0) ? draft : undefined;
  });
  const [savedReverseX] = useProjectState('SpectroscopyControls.reverseX', p.kind === 'ir');
  const [savedReverseY] = useProjectState('SpectroscopyControls.reverseY', p.kind === 'ir');
  const [savedRange] = useProjectState<{ axis: string; value: [number, number] }>('SpectroscopyControls.rangeSetting');
  const [draft, setDraft] = useProjectState<[string, string]>('SpectroscopyControls.draft', ['', '']);
  const [samplingDraft,setSamplingDraft]=useState<{kind:PlotSpectrumSampling['kind'];value:string}>();
  const sampling=edits?.sampling??defaultSampling;
  const axis = p.wavelengthAxis ? edits?.axis ?? p.axis : p.axis;
  const intensityUnit = edits?.intensityUnit && p.intensityUnits?.includes(edits.intensityUnit) ? edits.intensityUnit : p.initialIntensityUnit;
  const initialRamanWidth = Number(p.ramanBroadening?.width);
  const width = edits?.fwhm !== undefined ? edits.fwhm : p.ramanBroadening
    ? Number.isFinite(initialRamanWidth) && initialRamanWidth > 0 ? initialRamanWidth : null
    : p.fwhm ?? localFwhm;
  const shape = edits?.peakShape ?? p.ramanBroadening?.peakShape ?? p.peakShape ?? localPeakShape;
  const broadening = p.broadening !== false && !!shape && width !== null;
  const fwhm = width ?? p.defaultFwhm, peakShape = shape || localPeakShape;
  const normalize = edits?.normalize ?? savedNormalize;
  const display = broadening ? edits?.display ?? preferredDisplay ?? (legacySticks ? 'both' : 'envelope') : 'sticks';
  const reverseX = edits?.reverseX ?? savedReverseX, reverseY = edits?.reverseY ?? savedReverseY;
  const rangeSetting = edits?.range === undefined ? savedRange : edits.range;
  const convertRange = useCallback((range: [number, number], fromUnit: string) => spectrumAxisRange(range, fromUnit, axis), [axis]);
  const range = useMemo(() => rangeSetting ? convertRange(rangeSetting.value, rangeSetting.axis) : undefined, [rangeSetting, convertRange]);
  const previousRange = useRef({axis, rangeSetting});
  useEffect(() => {
    if (previousRange.current.axis === axis && previousRange.current.rangeSetting === rangeSetting) return;
    previousRange.current = {axis, rangeSetting};
    setDraft(range ? [String(range[0]), String(range[1])] : ['', '']);
  }, [axis, rangeSetting, range, setDraft]);
  const built = useMemo(() => {
    if (!broadening) return { spectrum: null, error: '' };
    try {
      const options={range,fwhm,normalize,peakShape,axis,intensityUnit};
      const sampleRange=range??(sampling.kind==='step'?p.build({...options,samples:2}).range:undefined);
      return { spectrum: p.build({...options,range:sampleRange,samples:gridSamples(sampling,sampleRange)}), error: '' };
    } catch (error) {
      return { spectrum: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [p.build, range, fwhm, normalize, peakShape, broadening, axis, intensityUnit,sampling]);
  const spectrum = built.spectrum, lo = Number(draft[0]), hi = Number(draft[1]);
  const validRange = draft.every(value => value.trim() !== '') && [lo, hi].every(Number.isFinite) && lo < hi && (axis !== 'eV' && axis !== 'nm' || lo > 0);
  const rawPoints = spectrum?.sticks ?? p.rawSticks?.points ?? [];
  const rawUnit = spectrum?.stickIntensityUnit ?? p.rawSticks?.intensityUnit ?? '';
  const decimals = p.decimals ?? 2;
  const linkSticks = useCallback((points: readonly SpectrumStick[], unit: string) => points.map(point => {
    const index = p.sourceIndex?.(point.sourceLine, point.sourceIndex);
    const label = index === undefined ? undefined : p.sourceLabel?.(index) ?? `Mode ${index}`;
    const coordinates = `${formatResultValue(point.x, decimals)} ${axis} · ${formatResultValue(point.y, decimals)} ${unit}`;
    const readoutId = p.kind === 'uv-vis' ? point.sourceIndex : index;
    return { ...point, index, readoutId, label, tooltip: label ? `${label} · ${coordinates}` : coordinates };
  }), [p.sourceIndex, p.sourceLabel, p.kind, axis, decimals]);
  const main = useMemo(() => spectrumPlotData(p.kind, display, spectrum, linkSticks(rawPoints, rawUnit), rawUnit),
    [p.kind, display, spectrum, linkSticks, rawPoints, rawUnit]);
  const spectrumInset = useMemo(() => {
    if (!spectrum) return undefined;
    return {
      axisUnit: axis, convertRange, fwhmUnit: p.fwhmUnit, settings: { fwhm, peakShape, normalize },
      build(settings: { fwhm: number; peakShape: SpectrumPeakShape; normalize: boolean }, window?: [number, number]) {
        const followsMain = settings.fwhm === fwhm && settings.peakShape === peakShape && settings.normalize === normalize;
        const localRange=settings.normalize?range:window??range;
        const step={kind:'step',value:gridStep(spectrum)} as const;
        let profile = followsMain ? spectrum : p.build({ ...settings, axis, intensityUnit, range:localRange,
          samples:localRange?gridSamples(step,localRange):spectrum.points.length });
        if (window && (profile.range[0] !== window[0] || profile.range[1] !== window[1])) {
          // Sample the zoom window at full density but keep the normalization
          // reference of the full generated interval for the selected shape.
          const windowProfile = p.build({ ...settings, normalize: false, range: window, axis, intensityUnit,
            samples:gridSamples(step,window) });
          const divisor = profile.normalizationDivisor;
          profile = { ...profile, range: windowProfile.range, points: divisor === 1 ? windowProfile.points
            : windowProfile.points.map(({ x, y }) => ({ x, y: y / divisor })) };
        }
        return spectrumPlotData(p.kind, 'envelope', profile, linkSticks(profile.sticks, profile.stickIntensityUnit), profile.stickIntensityUnit);
      },
    };
  }, [spectrum, axis, intensityUnit, p.build, p.kind, p.fwhmUnit, convertRange, range, fwhm, peakShape, normalize, linkSticks]);
  const widthValue = widthDraft ?? width ?? '', validWidth = Number.isFinite(Number(widthValue)) && Number(widthValue) > 0;
  const widthControl = (label: string, disabled: boolean) => <label>FWHM / {p.fwhmUnit}<NumericInput aria-label={label}
    aria-invalid={p.ramanBroadening ? !!shape && widthValue !== '' && !validWidth : !validWidth}
    step={p.fwhmUnit === 'eV' ? .01 : 1} value={widthValue} disabled={disabled}
    onChange={event => {
      const draft = event.target.value, value = Number(draft);
      setWidthDraft(draft);
      if (Number.isFinite(value) && value > 0 && value !== width) change({fwhm: value}, 'spectrum-width');
      else if (p.ramanBroadening && draft === '' && width !== null) change({fwhm: null}, 'spectrum-width');
    }} onBlur={() => {if (validWidth || p.ramanBroadening && widthValue === '') setWidthDraft(undefined); record.endGroup();}}/></label>;
  const samplingControl=(kind:PlotSpectrumSampling['kind'])=>{
    const label=kind==='count'?'X 采样点数':`X 步进 / ${axis}`;
    const current=kind==='count'?spectrum?.points.length: spectrum && Number(gridStep(spectrum).toPrecision(7));
    const value=samplingDraft?.kind===kind?samplingDraft.value:current??'';
    const valid=(n:number)=>Number.isFinite(n)&&(kind==='count'?Number.isSafeInteger(n)&&n>=2&&n<=SPECTRUM_MAX_SAMPLES:n>0);
    return <label>{label}<NumericInput aria-label={label} min={kind==='count'?2:undefined} max={kind==='count'?SPECTRUM_MAX_SAMPLES:undefined}
      step={kind==='count'?1:'any'} value={value} aria-invalid={samplingDraft?.kind===kind&&!valid(Number(value))}
      disabled={!spectrum||display==='sticks'}
      onChange={event=>setSamplingDraft({kind,value:event.target.value})}
      onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}
      onBlur={()=>{
        if(samplingDraft?.kind===kind){
          const next=Number(samplingDraft.value);
          if(valid(next))change({sampling:{kind,value:next}});
          setSamplingDraft(undefined);
        }
      }}/></label>;
  };
  const toolbar = <div className="spectroscopy-control-row spectroscopy-plot-settings">
    {p.wavelengthAxis && <label>横轴<select aria-label={`${p.title}横轴`} value={axis} onChange={event => change({axis: event.target.value as 'eV' | 'nm',
      ...(sampling.kind==='step'&&spectrum?{sampling:{kind:'count' as const,value:spectrum.points.length}}:{})})}><option value="eV">eV</option><option value="nm">nm</option></select></label>}
    {p.intensityUnits && p.intensityUnits.length > 1 && <label>IR 强度单位<select aria-label="IR强度单位" value={intensityUnit} onChange={event => change({intensityUnit: event.target.value})}>{p.intensityUnits.map(value => <option key={value}>{value}</option>)}</select></label>}
    {p.ramanBroadening ? <><label>峰型<select aria-label="Raman展宽峰型" value={shape} onChange={event => change({peakShape: event.target.value as '' | SpectrumPeakShape})}>
      <option value="">不展宽</option><option value="gaussian">Gaussian</option><option value="lorentzian">Lorentzian</option>
    </select></label>{widthControl('Raman展宽FWHM', !shape)}</> : !p.hideFwhmControl && broadening && widthControl(`${p.title} FWHM`, display === 'sticks')}
    {broadening && <label>显示<select aria-label={`${p.title}显示方式`} value={display} onChange={event => change({display: event.target.value as SpectrumDisplay})}>
      <option value="envelope">包络</option><option value="sticks">棒谱</option><option value="both">包络＋棒谱</option>
    </select></label>}
    {broadening && !p.ramanBroadening && !p.hidePeakShapeControl && <label>峰型<select aria-label={`${p.title}展宽峰型`} value={peakShape} disabled={display === 'sticks'}
      onChange={event => change({peakShape: event.target.value as SpectrumPeakShape})}><option value="gaussian">Gaussian</option><option value="lorentzian">Lorentzian</option></select></label>}
    {broadening && <label><input aria-label={`${p.title}归一化`} type="checkbox" checked={normalize} disabled={display === 'sticks'} onChange={event => change({normalize: event.target.checked})}/>归一化</label>}
    <label><input type="checkbox" checked={reverseX} onChange={event => change({reverseX: event.target.checked})}/>反转 X</label>
    {p.kind === 'ir' ? <label>峰方向<select aria-label="红外谱峰方向" value={reverseY ? 'down' : 'up'} onChange={event => change({reverseY: event.target.value === 'down'})}>
      <option value="down">向下</option><option value="up">向上</option>
    </select></label> : <label><input type="checkbox" checked={reverseY} onChange={event => change({reverseY: event.target.checked})}/>反转 Y</label>}
  </div>;
  const xSamplingControls=broadening&&<div className="plot-edit-section">
    <strong>光谱采样</strong>
    <div className="plot-edit-fields">{samplingControl('count')}{samplingControl('step')}</div>
    <div className="plot-edit-fields" role="group" aria-label={`生成范围 / ${axis}`}>
      {([0,1] as const).map(index=><label key={index}>{index?'生成上限':'生成下限'} / {axis}
        <NumericInput step="any" aria-label={`${p.title}范围${index?'终点':'起点'}`}
          placeholder={spectrum?String(Number(spectrum.range[index].toPrecision(10))):''} value={draft[index]}
          onChange={event=>setDraft(previous=>index?[previous[0],event.target.value]:[event.target.value,previous[1]])}/></label>)}
      <button type="button" disabled={!validRange} onClick={()=>change({range:{axis,value:[lo,hi]}})}>应用生成范围</button>
      <button type="button" onClick={()=>{if(rangeSetting)change({range:null});setDraft(['','']);}}>自动生成范围</button>
    </div>
  </div>;
  const exportText = useMemo(() => {
    const sticksText = spectrumDataText(axis, rawUnit, rawPoints);
    return spectrum ? `${spectrumText(spectrum, false, null)}\n原始棒谱\n${sticksText}` : sticksText;
  }, [spectrum, axis, rawUnit, rawPoints]);
  const rangeSchema={anyOf:[settingArray({type:'number'},2,2),{type:'null'}]},configuredBroadening=p.broadening!==false;
  const mcpConfiguration:NativeMcpSettings={
    schema:objectSchema({reverseX:settingBool,reverseY:settingBool,
      ...(p.wavelengthAxis?{axis:settingEnum(['eV','nm'])}:{}),...(p.intensityUnits?.length?{intensityUnit:settingEnum(p.intensityUnits)}:{}),
      ...(configuredBroadening?{
        ...(!p.hideFwhmControl||p.ramanBroadening?{fwhm:p.ramanBroadening?{anyOf:[settingPositive,{type:'null'}]}:settingPositive}:{}),
        ...(!p.hidePeakShapeControl||p.ramanBroadening?{peakShape:settingEnum(p.ramanBroadening?['','gaussian','lorentzian']:['gaussian','lorentzian'])}:{}),
        display:settingEnum(['envelope','sticks','both']),normalize:settingBool,generationRange:rangeSchema,
        sampling:{anyOf:[objectSchema({kind:settingEnum(['count']),value:{type:'integer',minimum:2,maximum:SPECTRUM_MAX_SAMPLES}},['kind','value']),
          objectSchema({kind:settingEnum(['step']),value:settingPositive},['kind','value'])]},
      }:{})}),
    read:()=>({kind:p.kind,axis,intensityUnit,fwhm:width,fwhmUnit:p.fwhmUnit,peakShape:shape,normalize,display,reverseX,reverseY,
      generationRange:range??null,sampling,actual:spectrum?{range:spectrum.range,count:spectrum.points.length,step:gridStep(spectrum)}:null,error:built.error||undefined}),
    apply(values){
      const {generationRange,...patch}=values as PlotSpectrumViewEdits&{generationRange?:[number,number]|null};
      const nextAxis=patch.axis??axis,nextShape=patch.peakShape??shape,nextWidth=patch.fwhm===undefined?width:patch.fwhm;
      if((patch.fwhm!==undefined||patch.peakShape!==undefined)&&widthDraft!==undefined||
        (patch.sampling!==undefined||patch.axis!==undefined)&&samplingDraft!==undefined)throw new Error('请先提交或结束图形输入框中的当前编辑。');
      if(generationRange&&(generationRange[0]>=generationRange[1]||(nextAxis==='eV'||nextAxis==='nm')&&generationRange[0]<=0))
        throw new Error('光谱生成范围无效。');
      if(patch.display&&patch.display!=='sticks'&&(!nextShape||nextWidth===null))throw new Error('当前棒谱未启用有效的展宽。');
      if(patch.axis&&patch.axis!==axis&&patch.sampling===undefined&&sampling.kind==='step'&&spectrum)
        patch.sampling={kind:'count',value:spectrum.points.length};
      if(generationRange!==undefined)patch.range=generationRange===null?null:{axis:nextAxis,value:generationRange};
      change(patch);
    },
  };
  const contents = <>{built.error && <DismissibleNotice role="alert">{built.error}</DismissibleNotice>}{(spectrum || rawPoints.length > 0) ? <ResultsMcpInlinePlotSource kind={p.kind}><ScientificPlot
      title={spectrumFigureTitles[p.kind]} ariaLabel={p.title} xLabel={spectrumXLabel(p.kind, axis)} yLabel={main.yLabel}
      toolbar={toolbar} xSamplingControls={xSamplingControls} hasSpectrumSticks={rawPoints.length>0} plotPresetScope={p.kind}
      plotStyle="spectrum" appearanceKey={appearanceKey} figureRecord={record} mcpConfiguration={mcpConfiguration}
      series={main.series} secondaryYAxis={main.secondaryYAxis} spectrumPeaks={main.peaks} spectrumInset={spectrumInset}
      pointReadout={{ kind: p.kind === 'uv-vis' ? 'State' : 'Mode', xUnit: axis }}
      selectedIndex={p.selectedIndex} onSelectIndex={p.onSelectIndex} reverseX={reverseX} reverseY={reverseY}
      xDomain={spectrum?.range ?? range} resetKey={`${p.appearanceKey ?? p.identity}:${rangeSetting?.axis ?? ''}:${rangeSetting?.value ?? ''}`}
      metadata={spectrum && { spectrum: { display, peakShape: spectrum.peakShape, fwhm: spectrum.fwhm, fwhmUnit: spectrum.fwhmUnit,
        normalized: spectrum.normalized, samples:spectrum.points.length, step:gridStep(spectrum) } }}
      decimals={decimals} exportFileName={`Ester-Studio-${p.title}`} exportText={{ fileName: `Ester-Studio-${p.title}.txt`, text: exportText }}
      exportRawText={p.exportRawText} testId="spectroscopy-plot"/></ResultsMcpInlinePlotSource> : toolbar}</>;
  return p.presentation === 'section' ? <AnalysisTaskSection title={p.title} className="spectroscopy-card">{contents}</AnalysisTaskSection> : <AnalysisTaskLayout variant="card" methodDetails title={p.title} className="spectroscopy-card">{contents}</AnalysisTaskLayout>;
}

export default function SpectroscopyControls(p: Parameters<typeof SpectroscopyControlsInner>[0]) {
  const project=useProjectUiScope();
  const plotIdentity = p.appearanceKey ?? p.identity;
  // Preserve the existing storage scope as the display treatment changes.
  const [stateIdentity] = useProjectState('SpectroscopyControls.scopeIdentity', p.identity, `${p.kind}:${plotIdentity}`);
  const contents = <SpectroscopyControlsInner key={plotIdentity} {...p}/>;
  return project ? <ProjectUiScope scope={['SpectroscopyControls',projectUiSourceIdentity({ identity: stateIdentity })]}>
    <ProjectNativeDetailsBoundary>{contents}</ProjectNativeDetailsBoundary>
  </ProjectUiScope> : contents;
}
