import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Structure, Vector3 } from '../../core/types';
import type { TrajectoryResult } from '../../results/contracts';
import type { VibrationMode } from '../../results/scientific-contracts';
import { buildInfraredSpectrum, frequencyTargetLabel, prepareVibrationPlayback, signedVibrationStructure, vibrationModesForFrame, vibrationSetsForFrame } from '../../results/spectroscopy';
import { MAX_VIBRATION_AMPLITUDE_ANGSTROM } from '../../results/vibrations';
import { InputSettingsCard } from '../InputSettingsFields';
import { InputSettingsLayout } from '../InputSettingsLayout';
import SpectroscopyControls, { SpectroscopyTable } from './SpectroscopyControls';
import { vibrationModeTable } from './spectroscopy-presentation';
import RamanControls, { type RamanDefaults } from './RamanControls';
import AppearancePresetPicker from '../AppearancePresetPicker';
import { appearancePreview } from '../appearance-preview-assets';
import { VIBRATION_VECTOR_PRESETS, VIBRATION_VECTOR_LIMITS, vibrationVectorAppearance, type VibrationVectorAppearance } from '../../results/surface-appearance-presets';
import { AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import type { SavedVectorAppearance } from './surface-appearance-defaults';
import { formatResultValue } from '../../results/numeric-format';
import { useProjectState, useProjectUiRestored, useProjectUiScope, useProjectUiSnapshot } from '../../projects/ui-state';

/** Confirmed editable initial parameters; applying them remains an explicit action. */
export const DEFAULT_RAMAN_STOKES_PARAMETERS = { laserWavelengthNm: 532, temperatureK: 298.15 } as const;

export interface VibrationAnalysisProjection {
  sourceId: string; jobIndex: number; frameIndex: number; mode: VibrationMode; displayIndex: number;
  structure: Structure; vectors: Vector3[]; amplitude: number; arrowAmplitude: number; phase: number; playing: boolean; arrows: boolean;
  periodMs: number; manualDisplacementAngstrom: number; gifDurationSeconds: number;
  arrowAppearance?: VibrationVectorAppearance;
}
const vibrationPauseOwners=new WeakMap<VibrationAnalysisProjection,()=>void>();
/** Keep executable ownership outside the serializable scientific projection. */
export function pauseVibrationProjection(projection:VibrationAnalysisProjection|null|undefined):void{if(projection)vibrationPauseOwners.get(projection)?.();}
export interface VibrationGifRequest {
  sourceId: string; jobIndex: number; frameIndex: number; baseStructure: Structure; mode: VibrationMode; displayIndex: number;
  amplitude: number; periodMs: number; durationSeconds: number;
  signal?: AbortSignal; onProgress?(completed: number, total: number): void;
}
export interface VibrationControlsProps {
  result: TrajectoryResult; currentIndex: number; structure: Structure; active: boolean;
  onProjection?(value: VibrationAnalysisProjection | null): void;
  onExtractStructure?(structure: Structure): void;
  onExportGif?(request: VibrationGifRequest): void | Promise<void>;
  onError?(message: string): void;
  ramanDefaults?: RamanDefaults;
  decimals?:number;onDecimalsChange?(value:number):void;
}
export default function VibrationControls(p: VibrationControlsProps) {
  const restored=useProjectUiRestored(),projectScope=useProjectUiScope(),identity = `${p.result.source.id}:${p.result.jobIndex}:${p.currentIndex}`;
  const clockSnapshot=useMemo(()=>({current:{angle:0,phase:0}}),[identity]);
  const savedClock=useProjectUiSnapshot(`vibration.clock:${identity}`,()=>clockSnapshot.current);
  const savedAngle=Number.isFinite(savedClock?.angle)?savedClock!.angle:0,savedPhase=Number.isFinite(savedClock?.phase)&&Math.abs(savedClock!.phase)<=1?savedClock!.phase:0;
  const appearanceDefaults=useSurfaceAppearanceDefaults(),appearanceInitialized=useRef(restored);
  const [localDecimals,setLocalDecimals]=useProjectState('vibration.decimals',2,identity),decimals=p.decimals??localDecimals;
  const setDecimals=useCallback((value:number)=>{setLocalDecimals(value);p.onDecimalsChange?.(value);},[p.onDecimalsChange,setLocalDecimals]);
  const [setIndex, setSetIndex] = useProjectState('vibration.set',0,identity), [selected, setSelected] = useProjectState('vibration.mode',1,identity), [,setPreview]=useState<number|null>(null), [scaled, setScaled] = useProjectState('vibration.scaled',false,identity), [factor, setFactor] = useProjectState('vibration.factor',1,identity);
  const [amplitude, setAmplitude] = useProjectState('vibration.amplitude',.3,identity), [arrowAmplitude, setArrowAmplitude] = useProjectState('vibration.arrowAmplitude',.3,identity), [manual, setManual] = useProjectState('vibration.manual',0,identity), [periodMs, setPeriodMs] = useProjectState('vibration.period',1000,identity), [duration, setDuration] = useProjectState('vibration.gifDuration',2,identity);
  const [playing, setPlaying] = useState(!restored), [arrows, setArrows] = useProjectState('vibration.arrows',true,identity), [phase, setPhase] = useState(savedPhase), [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController|null>(null);
  const [exportProgress, setExportProgress] = useState<{completed:number;total:number}|null>(null);
  const [exportStopping, setExportStopping] = useState(false);
  const [arrowPreset, setArrowPreset] = useProjectState<SavedVectorAppearance['presetId']>('vibration.arrowPreset','teal',identity), [arrowAppearance, setArrowAppearance] = useProjectState<VibrationVectorAppearance>('vibration.arrowAppearance',() => vibrationVectorAppearance('teal'),identity);
  useEffect(()=>{if(!appearanceDefaults.ready||appearanceInitialized.current)return;appearanceInitialized.current=true;const saved=appearanceDefaults.snapshot?.value.vibration;if(saved&&'vector' in saved){setArrowPreset(saved.presetId);setArrowAppearance({...saved.vector});}},[appearanceDefaults.ready,appearanceDefaults.snapshot]);
  const [revealMode, setRevealMode] = useState<{identity:string;key:string;requestId:number}>();
  const [playIdentity, setPlayIdentity] = useState(identity),priorIdentity=useRef(identity);
  useEffect(() => () => { exportController.current?.abort(); }, [identity]);
  const sets = useMemo(() => vibrationSetsForFrame(p.result.scientific, p.currentIndex), [p.result, p.currentIndex]);
  const matchingSet = Math.min(playIdentity === identity ? setIndex : 0, Math.max(0, sets.length - 1));
  const modes = useMemo(() => vibrationModesForFrame(p.result.scientific, p.currentIndex, { setIndex: matchingSet, scaleFactor: scaled ? factor : 1 }), [p.result, p.currentIndex, matchingSet, scaled, factor]);
  // Hover is information only; it must never replace the animated mode.
  const activeMode=playIdentity===identity?selected:1;
  const mode=modes.find(item=>item.displayIndex===activeMode);
  const prepared = useMemo(() => { if (!mode) return null; try { return prepareVibrationPlayback(p.structure, mode); } catch { return null; } }, [p.structure, mode]);
  const valid = prepared?.vectors ?? null;
  const isPlaying = playing && p.active && playIdentity === identity && !!valid;
  const currentPhase = playIdentity === identity ? phase : 0;
  const playbackAngle = useRef(savedAngle),lastPaintAngle=useRef(savedAngle);
  clockSnapshot.current={angle:playIdentity===identity?lastPaintAngle.current:savedAngle,phase:playIdentity===identity?phase:savedPhase};
  const playbackButton = useRef<HTMLButtonElement>(null);
  const pauseForModelEdit=useCallback(()=>{setPlaying(false);playbackAngle.current=lastPaintAngle.current=0;setPhase(0);setManual(0);},[setManual]);
  const callbacks = useRef(p); callbacks.current = p;
  // A new scientific context starts at its own first mode. Explicit mode
  // activation starts playback; pointer preview never changes the projection.
  useEffect(() => { if(priorIdentity.current===identity)return;priorIdentity.current=identity;playbackAngle.current=lastPaintAngle.current=savedAngle; setPlaying(!restored);setPreview(null);setPhase(savedPhase);if(!projectScope){setSelected(1);setSetIndex(0);setManual(0);}setPlayIdentity(identity); }, [identity,restored,projectScope,setSelected,setSetIndex,setManual,savedAngle,savedPhase]);
  const modeIdentity=`${identity}:${matchingSet}:${mode?.displayIndex}`,priorModeIdentity=useRef(modeIdentity),priorModeSource=useRef(identity);
  useEffect(() => { if(priorModeIdentity.current===modeIdentity)return;priorModeIdentity.current=modeIdentity;if(priorModeSource.current!==identity){priorModeSource.current=identity;return;}playbackAngle.current=lastPaintAngle.current=0;setPhase(0); }, [modeIdentity,identity]);
  useEffect(() => { if (!p.active) setPreview(null); }, [p.active]);
  useEffect(() => {
    if (!isPlaying) return;
    const owner = playbackButton.current?.ownerDocument.defaultView ?? window;
    const interval = 1000 / 60;
    let last = owner.performance?.now() ?? performance.now(), nextPaint = last + interval, frame = 0;
    const paint = (now: number) => {
      // Integrate wall time even when a faster display refresh is skipped.
      // Deadlines advance in 60 Hz slots, with no catch-up render burst.
      playbackAngle.current += (now - last) * 2 * Math.PI / periodMs; last = now;
      if (now >= nextPaint) { lastPaintAngle.current=playbackAngle.current;setPhase(Math.sin(playbackAngle.current)); nextPaint += (Math.floor((now - nextPaint) / interval) + 1) * interval; }
      frame = owner.requestAnimationFrame(paint);
    };
    frame = owner.requestAnimationFrame(paint);
    return () => owner.cancelAnimationFrame(frame);
  }, [isPlaying, periodMs, identity, mode?.displayIndex]);
  const projection = useMemo<VibrationAnalysisProjection | null>(() => {
    if (!mode || !valid || playIdentity!==identity) return null;
    try {
      const structure = currentPhase === 0 && !isPlaying ? prepared!.sample(Math.abs(playIdentity === identity ? manual : 0), Math.sign(playIdentity === identity ? manual : 0)) : prepared!.sample(amplitude, currentPhase);
      const value={ sourceId: p.result.source.id, jobIndex: p.result.jobIndex, frameIndex: p.currentIndex, mode, displayIndex: mode.displayIndex,
        structure, vectors: valid, amplitude, arrowAmplitude, phase: currentPhase, playing: isPlaying, arrows, periodMs, manualDisplacementAngstrom: playIdentity === identity ? manual : 0, gifDurationSeconds: duration, arrowAppearance };
      vibrationPauseOwners.set(value,pauseForModelEdit);return value;
    } catch { return null; }
  }, [mode, valid, prepared, p.structure, p.result.source.id, p.result.jobIndex, p.currentIndex, amplitude, arrowAmplitude, currentPhase, isPlaying, manual, arrows, periodMs, playIdentity, identity, duration, arrowAppearance]);
  useEffect(() => { callbacks.current.onProjection?.(projection); }, [projection]);
  useEffect(() => () => callbacks.current.onProjection?.(null), []);
  const units = useMemo(()=>[...new Set(modes.filter(item => item.irIntensity != null).map(item => item.irIntensityUnit ?? '单位未确认'))],[modes]);
  const [unit, setUnit] = useProjectState('vibration.irUnit','',identity), intensityUnit = units.includes(unit) ? unit : units[0];
  const build = useCallback((options: { range?: [number, number]; fwhm: number; normalize: boolean }) => buildInfraredSpectrum(modes, { ...options, scaleFactor: scaled ? factor : 1, intensityUnit }), [modes, scaled, factor, intensityUnit]);
  const changeMode = useCallback((displayIndex: number) => { playbackAngle.current=lastPaintAngle.current=0; setSelected(displayIndex); setPreview(null); setPhase(0); setManual(0); setPlaying(true); },[setSelected,setManual]);
  const selectSpectrumMode = useCallback((displayIndex: number) => {
    if (!modes.some(item => item.displayIndex === displayIndex)) return;
    changeMode(displayIndex);
    setRevealMode(previous => ({identity:`${identity}:${matchingSet}`,key:String(displayIndex),requestId:(previous?.requestId??0)+1}));
  },[modes,changeMode,identity,matchingSet]);
  // Animation phase belongs to the viewport projection, not the static mode
  // table. Keep both its projection and React subtree stable during playback.
  const modeTable=useMemo(()=>vibrationModeTable(modes,scaled,decimals),[modes,scaled,decimals]);
  const modeTableView=useMemo(()=><SpectroscopyTable hideTitle projection={modeTable} fileName="Ester-Studio-vibration-modes.txt" selectionScope={`${identity}:${matchingSet}:vibration-modes`} selectedKey={String(selected)} selectionLabel="模式" onSelect={key=>changeMode(Number(key))} onPreview={key=>setPreview(key===null?null:Number(key))} format={{decimals,onDecimalsChange:setDecimals,ariaLabel:'振动模式表'}} revealRow={revealMode?.identity===`${identity}:${matchingSet}`?revealMode:undefined}/>,[modeTable,identity,matchingSet,selected,changeMode,decimals,setDecimals,revealMode]);
  const infraredView=useMemo(()=>units.length?<SpectroscopyControls appearanceKey={`${identity}:${matchingSet}`} presentation="section" title="红外谱" decimals={decimals} identity={`${identity}:${matchingSet}:${scaled}:${factor}:${intensityUnit}`} axis="cm⁻¹" fwhmUnit="cm⁻¹" defaultFwhm={16} build={build} selectedIndex={selected} onSelectIndex={selectSpectrumMode} sourceIndex={(line,sourceIndex)=>modes.find(item=>item.sourceLine===line&&item.sourceIndex===sourceIndex)?.displayIndex}
    settings={units.length>1?<label>IR 强度单位<select aria-label="IR强度单位" value={intensityUnit} onChange={event=>setUnit(event.target.value)}>{units.map(value=><option key={value}>{value}</option>)}</select></label>:undefined}/>:<AnalysisTaskSection title="红外谱"><p className="postprocess-note">当前模式未输出红外强度。</p></AnalysisTaskSection>,[units,decimals,identity,matchingSet,scaled,factor,intensityUnit,build,selected,selectSpectrumMode,modes]);
  const ramanView=useMemo(()=><RamanControls modes={modes} decimals={decimals} identity={`${identity}:${matchingSet}`} selectedIndex={selected} onSelectIndex={selectSpectrumMode} onPreviewIndex={setPreview} defaults={{...DEFAULT_RAMAN_STOKES_PARAMETERS,...p.ramanDefaults}} scaleFactor={scaled?factor:1}/>,[modes,decimals,identity,matchingSet,selected,selectSpectrumMode,p.ramanDefaults,scaled,factor]);
  const report = (error: unknown) => callbacks.current.onError?.(error instanceof Error ? error.message : String(error));
  if (!modes.length) return <InputSettingsCard title="振动"><p className="postprocess-note">当前帧未输出振动模式。</p></InputSettingsCard>;
  const targetLabel=frequencyTargetLabel(sets[matchingSet]?.electronicTarget);
  return <InputSettingsLayout><AnalysisTaskLayout variant="card" methodDetails title={`振动模式${targetLabel?' · '+targetLabel:''}`} className="spectroscopy-card"
    setup={<div className="spectroscopy-control-row">{sets.length > 1 && <label>频率组<select aria-label="当前帧频率组" value={matchingSet} onChange={event => {setSetIndex(Number(event.target.value));setSelected(1);setManual(0);setPreview(null);}}>{sets.map((_, index) => <option key={index} value={index}>频率组 {index + 1}</option>)}</select></label>}
      <label><input type="checkbox" checked={scaled} onChange={event => setScaled(event.target.checked)}/>频率校正</label><label>因子<NumericInput aria-label="频率校正因子"  min={0.000001} step={.01} value={factor} disabled={!scaled} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0 && modes.every(item => Number.isFinite(item.frequency * value))) setFactor(value); }}/></label></div>}>
    <AnalysisTaskSection title="模式表">{modeTableView}</AnalysisTaskSection>
    {mode&&<AnalysisTaskSection title="振动显示" onRestore={()=>{setAmplitude(.3);setArrowAmplitude(.3);setPeriodMs(1000);setDuration(2);setManual(0);setArrows(true);playbackAngle.current=lastPaintAngle.current=0;setPhase(0);setPlaying(true);const saved=appearanceDefaults.snapshot?.value.vibration;if(saved&&'vector' in saved){setArrowPreset(saved.presetId);setArrowAppearance({...saved.vector});}else{setArrowPreset('teal');setArrowAppearance(vibrationVectorAppearance('teal'));}}}><div className="spectroscopy-vibration-playback" role="group" aria-label="模式播放与GIF"><p className="spectroscopy-current-mode">模式 {mode.displayIndex} · {formatResultValue(mode.frequency,decimals)} cm⁻¹{scaled&&` · 校正 ${formatResultValue(mode.correctedFrequency,decimals)} cm⁻¹`}</p>
    <div className="spectroscopy-control-row"><button ref={playbackButton} type="button" className="button button-primary" aria-label={isPlaying ? '暂停振动' : '播放振动'} disabled={!valid} onClick={() => { setPlayIdentity(identity); setPlaying(!isPlaying); }}>{isPlaying ? '暂停振动' : '播放振动'}</button><button type="button" disabled={!valid} onClick={() => { playbackAngle.current=lastPaintAngle.current=0; setPlaying(false); setPhase(0); setManual(0); }}>恢复原结构</button>
      <label><input type="checkbox" checked={arrows} disabled={!valid} onChange={event => setArrows(event.target.checked)}/>位移箭头</label></div>
    {!valid && <p className="postprocess-note">当前模式缺少与结构对应的笛卡尔位移向量。</p>}
    <div className="spectroscopy-control-row"><label className="spectroscopy-range-field">播放幅度 / Å<span className="spectroscopy-range-inputs"><input aria-label="振动播放幅度" type="range" {...matchingSliderRange(amplitude,0,2,.01)} value={amplitude} disabled={!valid} onChange={event => setAmplitude(Number(event.target.value))}/><NumericInput aria-label="振动播放幅度数值" stepper adaptiveStep={.1} min={0} max={MAX_VIBRATION_AMPLITUDE_ANGSTROM} step={.1} value={amplitude} disabled={!valid} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0 && value <= MAX_VIBRATION_AMPLITUDE_ANGSTROM) setAmplitude(value); }}/></span></label>
      <label>动画周期 / ms<NumericInput aria-label="振动周期"  min={40} step={40} value={periodMs} disabled={!valid} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 40) setPeriodMs(value); }}/></label></div>
    <div className="spectroscopy-control-row"><label className="spectroscopy-range-field">箭头幅度 / Å<span className="spectroscopy-range-inputs"><input aria-label="振动箭头幅度滑杆" type="range" {...matchingSliderRange(arrowAmplitude,0,2,.01)} value={arrowAmplitude} disabled={!valid} onChange={event=>setArrowAmplitude(Number(event.target.value))}/><NumericInput aria-label="振动箭头幅度" min={0} max={MAX_VIBRATION_AMPLITUDE_ANGSTROM} step={.01} value={arrowAmplitude} disabled={!valid} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&value>=0&&value<=MAX_VIBRATION_AMPLITUDE_ANGSTROM)setArrowAmplitude(value);}}/></span></label>
      <label className="spectroscopy-range-field">手动位移 / Å<span className="spectroscopy-range-inputs"><input aria-label="振动手动位移滑杆" type="range" {...matchingSliderRange(manual,-MAX_VIBRATION_AMPLITUDE_ANGSTROM,MAX_VIBRATION_AMPLITUDE_ANGSTROM,.01)} value={manual} disabled={!valid} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value)&&Math.abs(value)<=MAX_VIBRATION_AMPLITUDE_ANGSTROM){playbackAngle.current=lastPaintAngle.current=0;setPlaying(false);setPhase(0);setManual(value);}}}/><NumericInput aria-label="振动手动位移" title="最大原子位移；正负值对应模式两侧，0恢复原结构" stepper adaptiveStep={.1} min={-MAX_VIBRATION_AMPLITUDE_ANGSTROM} max={MAX_VIBRATION_AMPLITUDE_ANGSTROM} step={.1} value={manual} disabled={!valid} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= MAX_VIBRATION_AMPLITUDE_ANGSTROM) { playbackAngle.current=lastPaintAngle.current=0; setPlaying(false); setPhase(0); setManual(value); } }}/></span></label>
      <button type="button" disabled={!valid || !p.onExtractStructure} onClick={() => { try { const derived = signedVibrationStructure(p.structure, mode, manual); derived.name = `${p.structure.name} · mode ${mode.displayIndex} · ${manual} Å`; p.onExtractStructure?.(derived); } catch (error) { report(error); } }}>发送到建模</button></div>
    <details className="spectroscopy-export-panel"><summary>导出 GIF</summary><div className="spectroscopy-control-row"><label>GIF 时长 / s<NumericInput aria-label="振动GIF总时长"  min={.01} step={.1} value={duration} disabled={!valid} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) setDuration(value); }}/></label>
      <button type="button" disabled={!valid || !p.onExportGif || exporting} onClick={async () => {
        const controller = new AbortController(); exportController.current = controller;
        setExporting(true); setExportStopping(false); setExportProgress(null);
        try { await p.onExportGif?.({ sourceId: p.result.source.id, jobIndex: p.result.jobIndex, frameIndex: p.currentIndex, baseStructure: p.structure, mode, displayIndex: mode.displayIndex, amplitude, periodMs, durationSeconds: duration, signal:controller.signal, onProgress:(completed,total)=>{if(exportController.current===controller&&!controller.signal.aborted)setExportProgress({completed,total});} }); }
        catch (error) { if (!controller.signal.aborted) report(error); }
        finally { if(exportController.current===controller){exportController.current=null;setExporting(false);setExportStopping(false);setExportProgress(null);} }
      }}>导出 GIF</button>{exporting&&<><span role="status">{exportStopping?'正在取消导出…':exportProgress?`正在导出 ${exportProgress.completed}/${exportProgress.total} 帧`:'正在准备导出…'}</span><button type="button" disabled={exportStopping} onClick={()=>{setExportStopping(true);exportController.current?.abort();}}>取消导出</button></>}</div>
    </details></div><AppearancePresetPicker label="振动向量" value={arrowPreset} presets={VIBRATION_VECTOR_PRESETS.map(row=>({...row,preview:appearancePreview('vector',row.id)}))} onChange={id=>{appearanceInitialized.current=true;setArrowPreset(id as SavedVectorAppearance['presetId']);if(id!=='custom')setArrowAppearance(vibrationVectorAppearance(id));}} actions={<SaveSurfaceAppearanceDefault family="vibration" appearance={{presetId:arrowPreset,vector:arrowAppearance}}/>}/>
      {arrowPreset==='custom'&&<div className="spectroscopy-control-row"><label>箭头颜色<input type="color" aria-label="振动箭头颜色" value={arrowAppearance.color} onChange={event=>{appearanceInitialized.current=true;setArrowAppearance({...arrowAppearance,color:event.currentTarget.value});}}/></label><label>箭头粗细<NumericInput aria-label="振动箭头粗细"  min={VIBRATION_VECTOR_LIMITS.radius[0]} max={VIBRATION_VECTOR_LIMITS.radius[1]} step={.001} value={arrowAppearance.radius} onChange={event=>{const radius=event.currentTarget.valueAsNumber;if(Number.isFinite(radius)&&radius>=VIBRATION_VECTOR_LIMITS.radius[0]&&radius<=VIBRATION_VECTOR_LIMITS.radius[1]){appearanceInitialized.current=true;setArrowAppearance({...arrowAppearance,radius});}}}/></label></div>}
    </AnalysisTaskSection>}
    {infraredView}
    </AnalysisTaskLayout>
    {ramanView}
  </InputSettingsLayout>;
}
