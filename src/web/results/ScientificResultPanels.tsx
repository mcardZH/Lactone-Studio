import { useEffect, useState } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import type { AtomicProperty, ScientificField, VibrationMode } from '../../results/scientific-contracts';
import { frontierOrbitals } from '../../results/scientific-analysis';
import type { Structure } from '../../core/types';
import { atomicScalars } from '../../results/scientific-analysis';
import { frameBindingLabel, preferredScientificPanel, scientificDisplayValue as number, scientificPanels, type ResultPanelId } from './scientific-presentation';
import TDDFTControls from './TDDFTControls';
import VibrationControls, { type VibrationAnalysisProjection, type VibrationGifRequest } from './VibrationControls';
import { PagedScientificRows, PagedScientificList } from './PagedScientificRows';
import ScientificScfCycle from './ScientificScfCycle';
import NumericPrecisionControl from './NumericPrecisionControl';
import { formatResultValue, fullPrecisionValue as formatResultValueFull } from '../../results/numeric-format';
import './ScientificResultPanels.css';
import NmrCouplingTable from './NmrCouplingTable';

export interface VibrationDisplay { mode: VibrationMode; displayIndex?: number; frameIndex: number | null; amplitude: number; phase: number; playing: boolean; arrows: boolean }
export interface ScientificResultPanelsProps {
  result: TrajectoryResult; currentIndex: number; disabled?: boolean;
  structure: Structure;
  onSelectFrame(index: number): void;
  vibration: VibrationDisplay | null; onVibration(value: VibrationDisplay | null): void;
  onDisplacedModel(sign: 1 | -1): void; onPrepareIrc?(): void;
  onAtomProperty(value: AtomicProperty | null): void;
  onVibrationProjection?(value: VibrationAnalysisProjection | null): void;
  onExtractStructure?(structure: Structure): void;
  onExportVibrationGif?(request: VibrationGifRequest): void | Promise<void>;
  onError?(message: string): void;
}
function Binding({ index, current, onSelect }: { index: number | null | undefined; current: number; onSelect(index: number): void }) {
  return index == null ? <span className="scientific-unbound">{frameBindingLabel(index)}</span>
    : <button type="button" className="scientific-frame-link" onClick={() => onSelect(index)} aria-current={index === current ? 'true' : undefined}>{frameBindingLabel(index)}{index === current ? ' · 当前' : ' ↗'}</button>;
}
function Fields({ fields, current, onSelect }: { fields: ScientificField[]; current: number; onSelect(index: number): void }) {
  return fields.length ? <table className="scientific-table"><thead><tr><th>性质</th><th>值 / 单位</th><th>来源</th></tr></thead><tbody>{fields.map((field, i) => <tr key={`${field.key}-${i}`}><td>{field.label}</td><td>{number(field.value)} {field.unit}</td><td><Binding index={field.frameIndex} current={current} onSelect={onSelect}/></td></tr>)}</tbody></table> : <p className="scientific-empty">本作业未输出此项。</p>;
}
export default function ScientificResultPanels(p: ScientificResultPanelsProps) {
  const data = p.result.scientific, tabs = scientificPanels(p.result);
  const [tab, setTab] = useState<ResultPanelId>(() => preferredScientificPanel(data));
  const [atomicIndex, setAtomicIndex] = useState(0), [colorAtoms, setColorAtoms] = useState(false);
  const [orbitalIndex, setOrbitalIndex] = useState(0);
  const available = tabs.some(item => item.id === tab) ? tab : 'summary';
  const [cardDecimals,setCardDecimals]=useState<Partial<Record<ResultPanelId,number>>>({});
  const decimals=cardDecimals[available]??2;
  const setDecimals=(value:number)=>setCardDecimals(previous=>({...previous,[available]:value}));
  const adjustable=(value:number|string|null|undefined)=>formatResultValue(value,decimals);
  const number=(value:number|string|null|undefined)=>available==='orbitals'||available==='atoms'?adjustable(value):formatResultValueFull(value);
  const select = (index: number) => { if (!p.disabled && index >= 0 && index < p.result.frames.length) p.onSelectFrame(index); };
  const atomic = data?.atomicProperties[atomicIndex];
  useEffect(() => {
    if (!data) return;
    setAtomicIndex(index => {
      const previous = data.atomicProperties[index];
      const same = data.atomicProperties.findIndex(item => item.frameIndex === p.currentIndex && item.kind === previous?.kind && item.scheme === previous?.scheme);
      const any = data.atomicProperties.findIndex(item => item.frameIndex === p.currentIndex);
      return same >= 0 ? same : any >= 0 ? any : index;
    });
    setOrbitalIndex(index => {
      const previous = data.orbitals[index];
      const same = data.orbitals.findIndex(item => item.frameIndex === p.currentIndex && item.spin === previous?.spin);
      const any = data.orbitals.findIndex(item => item.frameIndex === p.currentIndex);
      return same >= 0 ? same : any >= 0 ? any : index;
    });
  }, [data, p.currentIndex]);
  useEffect(() => { p.onAtomProperty(available === 'atoms' && colorAtoms && atomic?.frameIndex === p.currentIndex ? atomic : null); }, [available, colorAtoms, atomic, p.currentIndex, p.onAtomProperty]);
  function changeTab(next: ResultPanelId) { if (next !== 'vibrations') p.onVibration(null); setTab(next); }
  const frame = p.result.frames[p.currentIndex];
  const mode = p.vibration?.mode;
  const channels = data?.orbitals ?? [], channel = channels[orbitalIndex];
  const frontier = channel ? frontierOrbitals(channel, channel.unit) : null;
  const homo = frontier?.homo, lumo = frontier?.lumo;
  const scalars = atomic ? atomicScalars(atomic, p.structure, p.currentIndex) : [];
  const range = scalars.length ? scalars.reduce((range, item) => ({ min: Math.min(range.min, item.value), max: Math.max(range.max, item.value) }), { min: scalars[0].value, max: scalars[0].value }) : null;
  return <aside className="scientific-results" aria-label="统一科学结果" data-testid="scientific-results">
    <div className="scientific-tabs" role="tablist" aria-label="结果能力">{tabs.map(item => <button key={item.id} id={`result-tab-${item.id}`} role="tab" aria-selected={available === item.id} aria-controls={`result-panel-${item.id}`} onClick={() => changeTab(item.id)}>{item.label}</button>)}</div>
    <div className="scientific-panel" role="tabpanel" id={`result-panel-${available}`} aria-labelledby={`result-tab-${available}`}>
      {(available==='orbitals'||available==='atoms')&&<NumericPrecisionControl value={decimals} onChange={setDecimals} ariaLabel={available==='orbitals'?'轨道显示小数位':'电荷显示小数位'}/>}
      {available === 'atoms' && colorAtoms && range && <p className="scientific-note">显示色标：蓝 {number(range.min)} → 白 {number((range.min + range.max) / 2)} → 红 {number(range.max)} {atomic?.unit}。白色代表当前范围中点；同值数据全部白色。</p>}
      {available === 'vibrations' && <><VibrationControls result={p.result} currentIndex={p.currentIndex} structure={p.structure} active={!p.disabled} decimals={decimals} onDecimalsChange={setDecimals} onProjection={p.onVibrationProjection ?? (value => p.onVibration(value ? { mode: value.mode, frameIndex: value.frameIndex, amplitude: value.phase === 0 && !value.playing ? Math.abs(value.manualDisplacementAngstrom) : value.amplitude, phase: value.phase === 0 && !value.playing ? Math.sign(value.manualDisplacementAngstrom) : value.phase, playing: false, arrows: value.arrows } : null))} onExtractStructure={p.onExtractStructure} onExportGif={p.onExportVibrationGif} onError={p.onError}/>{p.onPrepareIrc && <button disabled={!mode || mode.frequency >= 0 || p.vibration?.frameIndex !== p.currentIndex || p.disabled} onClick={p.onPrepareIrc}>以此 TS 几何准备 IRC 输入</button>}</>}
      {available === 'td' && <TDDFTControls result={p.result} currentIndex={p.currentIndex} decimals={decimals} onDecimalsChange={setDecimals}/>}
      {available === 'summary' && <><p className="scientific-source">{p.result.source.name} · 作业 {p.result.jobIndex + 1}{data?.version ? ` · ${data.version}` : ''}</p><p className="scientific-task-list">{data?.tasks.length ? data.tasks.map(task => task.toUpperCase()).join(' + ') : '结构浏览'}</p>{data?.route && <details><summary>来源方法与任务</summary><pre>{data.route}</pre></details>}<Fields fields={data?.summary ?? []} current={p.currentIndex} onSelect={select}/><Fields fields={data?.properties ?? []} current={p.currentIndex} onSelect={select}/><NmrCouplingTable result={p.result} currentIndex={p.currentIndex}/>{data?.notices.map((notice, i) => <p className="scientific-note" key={i}>{notice}</p>)}</>}
      {available === 'geometry' && <><h3>当前结构 · 帧 {p.currentIndex + 1}</h3>{(frame.coordinate||frame.pathDirection)&&<p>{[frame.coordinate?`${frame.coordinate.label} ${number(frame.coordinate.value)} ${frame.coordinate.unit}`:'',frame.pathDirection?.toUpperCase()].filter(Boolean).join(' · ')}</p>}<table className="scientific-table"><thead><tr><th>收敛指标</th><th>值</th><th>阈值</th><th>满足</th></tr></thead><tbody>{frame.convergence.map(item => <tr key={item.label}><td>{item.label}</td><td>{number(item.value)} {item.unit}</td><td>{number(item.threshold)}</td><td>{item.converged == null ? '未输出' : item.converged ? 'YES' : 'NO'}</td></tr>)}</tbody></table>{!frame.convergence.length && <p className="scientific-empty">此帧未输出收敛判据。</p>}<h3>当前几何的 SCF 周期</h3><PagedScientificList rows={data?.scfCycles.filter(cycle => cycle.frameIndex === p.currentIndex) ?? []} renderRow={(cycle, ordinal) => <ScientificScfCycle key={`${cycle.sourceLine}-${ordinal}`} cycle={cycle} ordinal={ordinal}/>}/>{!data?.scfCycles.some(cycle => cycle.frameIndex === p.currentIndex) && <p className="scientific-empty">此帧没有已确认归属的 SCF 迭代记录。</p>}{data?.scfCycles.some(cycle => cycle.frameIndex == null) && <details><summary>归属未确认的 SCF 记录</summary>{data.scfCycles.filter(cycle => cycle.frameIndex == null).map(cycle => <p key={cycle.sourceLine}>{cycle.points.length} 次记录 · 不套用到当前帧</p>)}</details>}</>}
      {available === 'orbitals' && <><p className="scientific-note">按来源占据数显示轨道数值。</p><select aria-label="轨道数据通道" value={orbitalIndex} onChange={event => setOrbitalIndex(Number(event.target.value))}>{channels.map((item, i) => <option key={i} value={i}>{item.spin} · {frameBindingLabel(item.frameIndex)}</option>)}</select>{channel && <><p><Binding index={channel.frameIndex} current={p.currentIndex} onSelect={select}/></p><dl className="scientific-quick-values"><dt>HOMO</dt><dd>{number(homo?.energy)} {channel.unit}</dd><dt>LUMO</dt><dd>{number(lumo?.energy)} {channel.unit}</dd><dt>GAP</dt><dd>{number(homo && lumo ? lumo.energy - homo.energy : null)} {channel.unit}</dd></dl><details><summary>占据数与完整轨道表 · {channel.orbitals.length}</summary><table className="scientific-table"><thead><tr><th>轨道</th><th>能量 / {channel.unit}</th><th>占据数</th></tr></thead><PagedScientificRows key={orbitalIndex} rows={channel.orbitals} renderRow={orbital => <tr key={orbital.index}><td>{orbital.index}</td><td>{number(orbital.energy)}</td><td>{number(orbital.occupation)}</td></tr>}/></table></details></>}</>}
      {available === 'atoms' && <><select aria-label="原子性质方案" value={atomicIndex} onChange={event => setAtomicIndex(Number(event.target.value))}>{data?.atomicProperties.map((item, i) => <option key={i} value={i}>{item.kind} · {item.scheme} · {frameBindingLabel(item.frameIndex)}</option>)}</select>{atomic && <><p><Binding index={atomic.frameIndex} current={p.currentIndex} onSelect={select}/></p><label className="scientific-checkbox"><input type="checkbox" checked={colorAtoms} disabled={p.disabled || atomic.frameIndex !== p.currentIndex} onChange={event => setColorAtoms(event.target.checked)}/>在当前模型上着色</label><table className="scientific-table"><thead><tr><th>来源原子</th><th>元素</th><th>{atomic.scheme} / {atomic.unit}</th></tr></thead><PagedScientificRows key={atomicIndex} rows={atomic.values} renderRow={item => <tr key={item.atomIndex}><td>{item.atomIndex + 1}</td><td>{item.element ?? '未输出'}</td><td>{number(item.value)}</td></tr>}/></table></>}</>}
      {available === 'thermo' && <Fields fields={data?.thermochemistry ?? []} current={p.currentIndex} onSelect={select}/>}
      {available === 'stability' && <Fields fields={data?.stability ?? []} current={p.currentIndex} onSelect={select}/>}
      {available === 'bsse' && <Fields fields={data?.bsse ?? []} current={p.currentIndex} onSelect={select}/>}
    </div>
  </aside>;
}
