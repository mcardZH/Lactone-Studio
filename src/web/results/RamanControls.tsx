import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import NumericInput from '../NumericInput';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildRamanSpectrum, correctedFrequency, projectRamanStokesModes, type ProjectedVibrationMode, type RamanStokesMode, type RamanStokesParameters } from '../../results/spectroscopy';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import SpectroscopyControls, { SpectroscopyTable } from './SpectroscopyControls';
import { formatResultValue } from '../../results/numeric-format';
import type { ScientificTableProjection } from './scientific-table';

export interface RamanDefaults {
  laserWavelengthNm?: number; temperatureK?: number; fwhm?: number; peakShape?: 'gaussian' | 'lorentzian';
}
export interface RamanControlsProps {
  modes: readonly ProjectedVibrationMode[]; identity: string; selectedIndex?: number; onSelectIndex(index: number): void;
  onPreviewIndex?(index:number|null):void;
  defaults?: RamanDefaults; scaleFactor?: number;
  decimals?:number;
}
export function ramanActivityTable(modes: readonly ProjectedVibrationMode[], scaleFactor = 1,decimals=2): ScientificTableProjection {
  const number=(value:number|null|undefined)=>formatResultValue(value,decimals);
  const units = [...new Set(modes.filter(mode => mode.ramanActivity != null).map(mode => mode.ramanActivityUnit ?? '单位未确认'))];
  const unit = units.length === 1 && units[0] !== '单位未确认' ? units[0] : null;
  const dynamic = modes.some(mode => mode.ramanActivityConvention === 'dynamic');
  return { columns: [{ key: 'mode', label: '模式' }, { key: 'frequency', label: '原频率 / cm⁻¹',heading:'原频率',headerUnit:'cm⁻¹' }, ...(scaleFactor !== 1 ? [{ key: 'corrected-frequency', label: '校正频率 / cm⁻¹',heading:'校正频率',headerUnit:'cm⁻¹' }] : []), { key: 'activity', label: unit ? `拉曼活性 / ${unit}` : '拉曼活性 / 来源单位',heading:'拉曼活性',...(unit?{headerUnit:unit}:{}) },...(!unit?[{key:'activity-unit',label:'拉曼活性单位'}]:[]),
    ...(dynamic ? [{ key: 'convention', label: '活性约定' }, { key: 'laser', label: '来源激光 / nm',heading:'来源激光',headerUnit:'nm' }] : [])],
    rows: modes.map(mode => ({ key: String(mode.displayIndex), cells: [String(mode.displayIndex), number(mode.frequency), ...(scaleFactor !== 1 ? [number(correctedFrequency(mode.frequency, scaleFactor))] : []), number(mode.ramanActivity),...(!unit?[mode.ramanActivity==null?'未输出':mode.ramanActivityUnit??'单位未确认']:[]),
      ...(dynamic ? [mode.ramanActivityConvention === 'dynamic' ? '动态' : mode.ramanActivityConvention === 'static' ? '静态' : '未确认', mode.ramanActivityConvention === 'dynamic' ? number(mode.ramanExcitationWavelengthNm) : mode.ramanActivityConvention === 'static' ? '不限定' : '未输出'] : [])] })) };
}
const unavailableLabels: Record<NonNullable<RamanStokesMode['unavailableReason']>, string> = {
  'missing-activity': '缺拉曼活性', 'unconfirmed-activity-unit': '活性单位未确认', 'missing-source': '来源未确认',
  'non-vibrational-mode': '平移或转动', 'outside-stokes-range': '不在 Stokes 范围', 'numeric-range': '超出数值范围',
  'unconfirmed-activity-convention': '活性静态/动态约定未确认', 'dynamic-excitation-mismatch': '与动态活性来源激光不匹配',
};
export function ramanStokesTable(rows: readonly RamanStokesMode[], modes: readonly ProjectedVibrationMode[], scaleFactor = 1,decimals=2): ScientificTableProjection {
  const number=(value:number|null|undefined)=>formatResultValue(value,decimals);
  return { columns: [{ key: 'mode', label: '模式' }, { key: 'frequency', label: '原频率 / cm⁻¹',heading:'原频率',headerUnit:'cm⁻¹' }, ...(scaleFactor !== 1 ? [{ key: 'corrected-frequency', label: '校正频率 / cm⁻¹',heading:'校正频率',headerUnit:'cm⁻¹' }] : []), { key: 'intensity', label: 'Stokes 相对强度 / a.u.',heading:'Stokes 相对强度',headerUnit:'a.u.' }, { key: 'status', label: '状态' }],
    rows: rows.map((row, index) => ({ key: String(modes[index].displayIndex), cells: [String(modes[index].displayIndex), number(row.mode.frequency), ...(scaleFactor !== 1 ? [number(correctedFrequency(row.mode.frequency, scaleFactor))] : []), number(row.intensity), row.unavailableReason ? unavailableLabels[row.unavailableReason] : '可用'] })) };
}
function RamanControlsInner(p: RamanControlsProps) {
  const [decimals,setDecimals]=useProjectState('RamanControls.decimals', 2),number=(value:number|null|undefined)=>formatResultValue(value,decimals);
  const [laser, setLaser] = useProjectState('RamanControls.laser', p.defaults?.laserWavelengthNm == null ? '' : String(p.defaults.laserWavelengthNm));
  const [temperature, setTemperature] = useProjectState('RamanControls.temperature', p.defaults?.temperatureK == null ? '' : String(p.defaults.temperatureK));
  const [width, setWidth] = useProjectState('RamanControls.width', p.defaults?.fwhm == null ? '' : String(p.defaults.fwhm));
  const [peakShape, setPeakShape] = useProjectState<'' | 'gaussian' | 'lorentzian'>('RamanControls.peakShape', p.defaults?.peakShape ?? '');
  const [applied, setApplied] = useProjectState<{ identity: string; parameters: RamanStokesParameters }>('RamanControls.applied');
  const [error, setError] = useState('');
  const dataIdentity = `${p.identity}:${JSON.stringify(p.modes.map(mode => [mode.index, mode.sourceIndex, mode.sourceLine, mode.kind, mode.frequency, mode.frequencyRounding, mode.ramanActivity, mode.ramanActivityUnit, mode.ramanActivityConvention, mode.ramanExcitationWavelengthNm, mode.ramanActivitySourceLine]))}`;
  useEffect(() => { setError(''); }, [dataIdentity]);
  const parameters = applied?.identity === dataIdentity ? applied.parameters : null;
  const laserValue = Number(laser), temperatureValue = Number(temperature), widthValue = Number(width);
  const validParameters = laser.trim() !== '' && temperature.trim() !== '' && [laserValue, temperatureValue].every(value => Number.isFinite(value) && value > 0);
  const projected = useMemo(() => {
    if (!parameters) return null;
    try { return projectRamanStokesModes(p.modes, parameters); } catch { return null; }
  }, [p.modes, parameters]);
  const available = projected?.some(row => row.intensity !== null) ?? false;
  const scaleFactor = p.scaleFactor ?? 1;
  const points = projected?.flatMap(row => row.intensity === null ? [] : [{ x: correctedFrequency(row.mode.frequency, scaleFactor), y: row.intensity, sourceIndex:row.sourceIndex, sourceLine:row.mode.sourceLine }]) ?? [];
  const build = useCallback((options: { range?: [number, number]; fwhm: number; normalize: boolean }) => {
    if (!parameters || !peakShape) throw new Error('请先应用激光和温度参数，并选择展宽峰型。');
    return buildRamanSpectrum(p.modes, { ...parameters, ...options, peakShape, scaleFactor });
  }, [p.modes, parameters, peakShape, scaleFactor]);
  const activityModes = p.modes.filter(mode => mode.ramanActivity != null && Number.isFinite(mode.ramanActivity));
  if (!activityModes.length) return <AnalysisTaskLayout variant="card" title="拉曼谱" className="spectroscopy-card"><p className="postprocess-note">当前频率结果未输出拉曼活性。</p></AnalysisTaskLayout>;
  const unitMissing = activityModes.some(mode => !mode.ramanActivityUnit), conventionMissing = activityModes.some(mode => !mode.ramanActivityConvention || mode.ramanActivityConvention === 'unknown');
  return <AnalysisTaskLayout variant="card" methodDetails title="拉曼谱" className="spectroscopy-card" setup={<div className="spectroscopy-control-row">
      <label>激光 / nm<NumericInput aria-label="Raman激光波长"  min={0} step={1} value={laser} onChange={event => setLaser(event.target.value)}/></label>
      <label>温度 / K<NumericInput aria-label="Raman温度"  min={0} step={1} value={temperature} onChange={event => setTemperature(event.target.value)}/></label>
      <button type="button" disabled={!validParameters} onClick={() => { try { const next = { laserWavelengthNm: laserValue, temperatureK: temperatureValue }; projectRamanStokesModes(p.modes, next); setApplied({ identity: dataIdentity, parameters: next }); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}>应用参数</button></div>}>
    {(unitMissing || conventionMissing) && <p className="postprocess-note">{activityModes.every(mode => unitMissing ? !mode.ramanActivityUnit : !mode.ramanActivityConvention || mode.ramanActivityConvention === 'unknown') ? '来源' : '部分模式'}未确认拉曼活性{unitMissing && conventionMissing ? '单位及静态/动态约定' : unitMissing ? '单位' : '静态/动态约定'}，暂不能换算。</p>}
    {error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
    <AnalysisTaskSection title="Stokes 相对强度">
      {projected && parameters ? <><p className="postprocess-note">普通非共振 Stokes · {number(parameters.laserWavelengthNm)} nm · {number(parameters.temperatureK)} K · 按原频率换算</p>
        <SpectroscopyTable hideTitle projection={ramanStokesTable(projected, p.modes, scaleFactor,decimals)} fileName="Ester-Studio-raman-stokes-intensity.txt" selectionScope={`${p.identity}:raman-stokes`} selectedKey={p.selectedIndex===undefined?undefined:String(p.selectedIndex)} selectionLabel="模式" onSelect={key => p.onSelectIndex(Number(key))} onPreview={p.onPreviewIndex?key=>p.onPreviewIndex?.(key===null?null:Number(key)):undefined} format={{decimals,onDecimalsChange:setDecimals,ariaLabel:'拉曼强度表'}}/>
      </> : <p className="postprocess-note">输入激光波长和温度后应用参数。</p>}
    </AnalysisTaskSection>
    {parameters && available ? <SpectroscopyControls appearanceKey={p.identity} presentation="section" title="拉曼 Stokes 谱" decimals={decimals} identity={`${dataIdentity}:${parameters.laserWavelengthNm}:${parameters.temperatureK}:${peakShape}:${scaleFactor}`} axis="cm⁻¹" fwhmUnit="cm⁻¹" defaultFwhm={16} fwhm={Number.isFinite(widthValue)&&widthValue>0?widthValue:16} hideFwhmControl peakShape={peakShape||undefined} broadening={!!peakShape&&width.trim()!==''&&Number.isFinite(widthValue)&&widthValue>0} rawSticks={{points,intensityUnit:'a.u.'}} build={build} selectedIndex={p.selectedIndex} onSelectIndex={p.onSelectIndex} sourceIndex={(line, sourceIndex) => p.modes.find(mode => mode.sourceLine === line && mode.sourceIndex === sourceIndex)?.displayIndex}
      settings={<><label>峰型<select aria-label="Raman展宽峰型" value={peakShape} onChange={event => setPeakShape(event.target.value as typeof peakShape)}><option value="">不展宽</option><option value="gaussian">高斯</option><option value="lorentzian">洛伦兹</option></select></label><label>FWHM / cm⁻¹<NumericInput aria-label="Raman展宽FWHM"  min={0} step={1} value={width} disabled={!peakShape} onChange={event => setWidth(event.target.value)}/></label></>}/>
      : parameters && <AnalysisTaskSection title="拉曼 Stokes 谱"><p className="postprocess-note">缺少可用于 Stokes 换算的拉曼活性。</p></AnalysisTaskSection>}
  </AnalysisTaskLayout>;
}

export default function RamanControls(p: Parameters<typeof RamanControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['RamanControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><RamanControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:RamanControlsInner(p);
}
