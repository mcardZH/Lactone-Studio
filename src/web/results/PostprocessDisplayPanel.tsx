import { useCallback,useMemo,useState, type ReactNode, type DragEvent } from 'react';
import { Atom, Link2, Orbit, Waves, Zap, Layers, Magnet, Ruler, FlaskConical, ChartNoAxesCombined } from 'lucide-react';
import type { TrajectoryResult } from '../../results/contracts';
import type {Structure} from '../../core/types';
import type {GeneratedXtbProvenance} from '../../results/xtb-generated-source';
import {generatedXtbMethodAllowed} from '../../results/generated-xtb-policy';
import type { AtomicProperty } from '../../results/scientific-contracts';
import { InputTaskChoice, InputSettingsLayout, InputSettingsCheckbox } from '../InputSettingsLayout';
import { InputSettingsCard } from '../InputSettingsFields';
import PostprocessPlot, { type PostprocessOrbitalSelection } from './PostprocessPlot';
import { PostprocessEnergyPanel } from './PostprocessNumericBook';
import OrbitalControls from './OrbitalControls';
import type {ProfessionalSourceContext,ProfessionalChargeDisplay} from './analysis-comparison';
import AnalysisControls, { type AnalysisControlsContext, type AnalysisHighlightProps, type ChargeAnalysis, type BondAnalysis, type AnalysisDisplaySettings } from './AnalysisControls';
import type {AnalysisColorbarLayout} from './analysis-colorbar-layout';
import {useAnalysisFeedback} from './AnalysisFeedback';
import { createPostprocessPlotSnapshot, postprocessScfState, type PostprocessPlotSnapshot } from './PostprocessPresentation';
import TDDFTControls from './TDDFTControls';
import VibrationControls, { type VibrationControlsProps } from './VibrationControls';
import { AnalysisTaskLayout, AnalysisMethodDetails } from './AnalysisTaskLayout';
import './Postprocess.css';

export interface PostprocessAtomicDisplay { property: AtomicProperty | null; color: boolean; labels: boolean }
export type AnalysisPage = 'energy' | 'charges' | 'bonds' | 'orbitals' | 'trajectory' | 'excited' | 'vibrations'|'surface'|'interaction'|'reactivity';
/** Trusted generation establishes only the individually accepted capabilities. */
export function generatedXtbAnalysisReason(source:GeneratedXtbProvenance|undefined,page:AnalysisPage):string|undefined {
  if(!source)return undefined;
  if((page==='energy'||page==='charges')&&source.capabilities.includes('native-properties'))return undefined;
  if(page==='orbitals'&&source.capabilities.includes('orbitals'))return undefined;
  if(page==='surface')return undefined;
  const revision=source.files.find(file=>file.role==='molden')?.sha256??'';
  if(page==='bonds'&&['mayer','laplacian'].some(method=>generatedXtbMethodAllowed(source.analysisPolicy,revision,'bond-orders',method)))return undefined;
  if(page==='interaction'&&['iri','rdg','igmh'].some(method=>generatedXtbMethodAllowed(source.analysisPolicy,revision,'interaction',method)))return undefined;
  if(page==='excited')return '基态 Molden 不含激发态、跃迁或 NTO 数据。';
  if(page==='vibrations')return '当前来源不含 Hessian 或振动模式。';
  if(page==='reactivity')return '现有反应性方法要求已确认的闭壳层 canonical SCF 来源；GFN2 Molden 不满足此来源前提。';
  return '当前来源缺少此分析所需的数据。';
}
export interface AnalysisCardDeckProps {
  allowedPages?: readonly AnalysisPage[];
  activeId?: string; disabled?: boolean;
  onSelect(page: AnalysisPage): void;
  onAdd?(page: AnalysisPage): void;
  onCardDrag?(page: AnalysisPage, event: DragEvent<HTMLDivElement>): void;
  unavailableReason?(page: AnalysisPage): string | undefined;
}
export interface PostprocessDisplayPanelProps extends AnalysisHighlightProps {
  unavailableReason?(page:AnalysisPage):string|undefined;
  result: TrajectoryResult | null; currentIndex: number; disabled?: boolean;
  structure?:Structure;
  onPrintedAtomHighlight?:AnalysisHighlightProps['onAtomHighlight'];
  analysisPage?:string; onAnalysisPageChange?(page:string):void;
  active?: boolean; hideEntries?: boolean; cancelOnInactive?: boolean;
  onAdd?(page: AnalysisPage): void;
  onCardDrag?(page: AnalysisPage, event: DragEvent<HTMLDivElement>): void;
  atomicDisplay: PostprocessAtomicDisplay; onAtomicDisplay(value: PostprocessAtomicDisplay): void;
  dipoleVisible: boolean; dipoleAvailable: boolean; onDipoleVisible(value: boolean): void;
  orbitalControls?: ReactNode; wavefunctionMissingLabel?: string;
  /** Hide capability controls without changing their native owner lifetime. */
  wavefunctionAvailable?: boolean; trajectoryControls?: ReactNode;
  vibrationControls?: Pick<VibrationControlsProps, 'onProjection' | 'onExtractStructure' | 'onExportGif' | 'onError'>;
  onOpenPlot(snapshot: PostprocessPlotSnapshot): void;
  onSelectOrbital?(selection: PostprocessOrbitalSelection): void;
  analysis?: AnalysisControlsContext;
  sourceContext?:ProfessionalSourceContext;onProfessionalCharges?(projection:ProfessionalChargeDisplay|null):void;
  onColorbarLayoutReady?(setter:((layout:AnalysisColorbarLayout)=>void)|null):void;
  analysisOwnerId?:string;
  /** Legacy compatibility only; table formats are not injected across cards. */
  decimals?:number;onDecimalsChange?(value:number):void;
  surfaceControls?:ReactNode;
  interactionControls?:ReactNode;
  excitationControls?:ReactNode;
  reactivityControls?:ReactNode;
  onChargeAnalysis?(result: ChargeAnalysis | null, display: AnalysisDisplaySettings, comparisons?: readonly ChargeAnalysis[]): void;
  onBondAnalysis?(result: BondAnalysis | null, display: AnalysisDisplaySettings, comparisons?: readonly BondAnalysis[]): void;
}
export const ANALYSIS_ENTRIES = [
  { id: 'energy', label: '能量', icon: Zap }, { id: 'charges', label: '电荷', icon: Atom }, { id: 'bonds', label: '键级', icon: Link2 }, { id: 'orbitals', label: '轨道', icon: Orbit },
  { id: 'trajectory', label: '轨迹', icon: ChartNoAxesCombined },
  { id: 'vibrations', label: '振动', icon: Waves }, { id: 'excited', label: '激发', icon: Zap }, { id: 'surface', label: '分子表面', icon: Layers },
  { id: 'interaction', label: '相互作用', icon: Link2 }, { id: 'geometry', label: '几何', icon: Ruler, pending: true }, { id: 'reactivity', label: '反应性', icon: FlaskConical }, { id: 'magnetic', label: '磁性响应', icon: Magnet, pending: true },
] as const;
export function AnalysisCardDeck(p: AnalysisCardDeckProps) {
  const {notify,feedback}=useAnalysisFeedback();
  const request=(page:AnalysisPage,add=false)=>{const reason=p.unavailableReason?.(page);if(reason){notify(reason);return;}if(p.disabled){notify('请先载入计算来源。');return;}(add?p.onAdd??p.onSelect:p.onSelect)(page);};
  return <InputSettingsLayout>{feedback}<div className="analysis-entry-grid analysis-entry-grid-compact" role="group" aria-label="分析功能">{ANALYSIS_ENTRIES.filter(item=>!p.allowedPages||p.allowedPages.includes(item.id as AnalysisPage)).map(item => {
    const pending = 'pending' in item && item.pending,reason=!pending?p.unavailableReason?.(item.id as AnalysisPage):undefined, enabled = !pending && !p.disabled&&!reason;
    return <div key={item.id} className="analysis-entry-card" draggable={enabled && Boolean(p.onCardDrag)} onDragStart={event => {const reason=!pending?p.unavailableReason?.(item.id as AnalysisPage):undefined;if(reason){event.preventDefault();notify(reason);return;} if (enabled) p.onCardDrag?.(item.id as AnalysisPage, event); }}>
      <InputTaskChoice label={item.label} code={pending ? '待开发' : ''} icon={<item.icon size={16}/>} selected={p.activeId === item.id} disabled={pending||Boolean(reason)} title={pending ? '待开发' : reason} onSelect={() => pending?notify(`${item.label}暂未开放。`):request(item.id as AnalysisPage)}/>
      {p.onAdd && !pending && <button type="button" className="shared-input-action analysis-card-add" disabled={Boolean(reason)} aria-label={`打开${item.label}分析`} title={reason??'打开或激活唯一分析面板'} onClick={event => { event.stopPropagation();request(item.id as AnalysisPage,true); }}>+</button>}
    </div>;
  })}</div></InputSettingsLayout>;
}
function PlotFold({ kind, result, currentIndex, onOpenPlot, onSelectOrbital,decimals=2 }: { kind: 'scf' | 'levels'; result: TrajectoryResult | null; currentIndex: number; onOpenPlot(snapshot: PostprocessPlotSnapshot): void; onSelectOrbital?: PostprocessDisplayPanelProps['onSelectOrbital'];decimals?:number }) {
  const [open, setOpen] = useState(kind === 'scf');
  const available = kind === 'scf' ? postprocessScfState(result, currentIndex).available : Boolean(result?.scientific?.orbitals.some(channel => channel.frameIndex === currentIndex && channel.orbitals.some(orbital => Number.isFinite(orbital.energy))));
  const snapshot = available && result ? {...createPostprocessPlotSnapshot(result, currentIndex, kind),decimals} : null;
  if (kind === 'scf') return <AnalysisTaskLayout title="SCF 收敛过程" variant="card">
    {snapshot ? <><button type="button" className="shared-input-action" onClick={() => onOpenPlot(snapshot)}>在内部图窗打开 ↗</button><PostprocessPlot key={snapshot.id + ':inline'} snapshot={snapshot} compact/></>
      : <p className="postprocess-empty">{postprocessScfState(result,currentIndex).label}；需要来源打印的逐轮能量。</p>}
    <AnalysisMethodDetails/>
  </AnalysisTaskLayout>;
  return <details open={open} className="postprocess-display-fold" onToggle={event => setOpen(event.currentTarget.open)}><summary><span>二维轨道能级</span><span className={available ? 'postprocess-available' : 'postprocess-note'}>{available ? '可绘图' : '缺轨道能量'}</span></summary>
    {open && <div className="postprocess-fold-body">{snapshot ? <><PostprocessPlot key={snapshot.id + ':inline'} snapshot={snapshot} compact onSelectOrbital={onSelectOrbital}/><button type="button" onClick={() => onOpenPlot(snapshot)}>在内部图窗打开 ↗</button></> : <p className="postprocess-empty">补入含轨道能量和占据数的输出或波函数文件后启用。</p>}</div>}
  </details>;
}
function MissingWavefunction({kind}:{kind:'charges'|'bonds'|'orbitals'}){
 return <div className="postprocess-missing-capability"><button type="button" className="shared-input-action" disabled>{kind==='charges'?'计算电荷':kind==='bonds'?'计算键级':'计算轨道格点'}</button><p className="postprocess-note">当前帧缺少匹配波函数。</p></div>;
}
export default function PostprocessDisplayPanel(p: PostprocessDisplayPanelProps) {
  const [localPage, setLocalPage] = useState('energy');
  const active=p.analysisPage==='scf'?'energy':p.analysisPage??localPage;
  const [pageDecimals,setPageDecimals]=useState<Record<string,number>>({});
  const setPagePrecision=useCallback((page:string,value:number)=>setPageDecimals(previous=>previous[page]===value?previous:{...previous,[page]:value}),[]);
  const setVibrationPrecision=useCallback((value:number)=>setPagePrecision('vibrations',value),[setPagePrecision]);
  const setActive=(page:string)=>{setLocalPage(page);p.onAnalysisPageChange?.(page);};
  const source=useMemo(()=>p.sourceContext??(p.result&&p.structure?{result:p.result,structure:p.structure,frameIndex:p.currentIndex,wavefunctionAvailable:p.wavefunctionAvailable!==false}:undefined),[p.sourceContext,p.result,p.structure,p.currentIndex,p.wavefunctionAvailable]);
  const unavailable=p.unavailableReason?.(active as AnalysisPage);
  const pageLabel=ANALYSIS_ENTRIES.find(item=>item.id===active)?.label??'分析';
  const empty=(message:string)=><p role="status" className="postprocess-note">{message}</p>;
  if(unavailable&&p.hideEntries)return <aside className="postprocess-display postprocess-analysis-instance" aria-label="后处理显示与绘图" data-testid="postprocess-display" data-active-analysis={active} data-analysis-page={active}><button disabled title={unavailable}>{pageLabel}暂不可用</button>{empty(unavailable)}</aside>;
  return <aside className={`postprocess-display${p.hideEntries?' postprocess-analysis-instance':''}`} aria-label="后处理显示与绘图" data-testid="postprocess-display" data-active-analysis={active} data-source-id={p.result?.source.id} data-frame-index={p.currentIndex}>
    {!p.hideEntries && <AnalysisCardDeck activeId={active} disabled={p.disabled} unavailableReason={page=>p.unavailableReason?.(page)??(!p.result?'请先载入当前分子的计算来源。':page==='bonds'&&!p.analysis?'请补入与当前结构匹配的 FCHK / Molden 波函数。':undefined)} onSelect={setActive} onAdd={p.onAdd} onCardDrag={p.onCardDrag}/>}
    {(!p.hideEntries || active==='energy') && <div hidden={active !== 'energy'} data-analysis-page="energy"><InputSettingsLayout><InputSettingsCard title="能量与偶极矩">{p.result ? <PostprocessEnergyPanel result={p.result} currentIndex={p.currentIndex} dipoleControl={<InputSettingsCheckbox label="显示偶极方向箭头" disabled={!p.dipoleAvailable || p.disabled} checked={p.dipoleAvailable && p.dipoleVisible} onChange={p.onDipoleVisible}/>}/> : <p className="postprocess-note">请先补入计算来源。</p>}</InputSettingsCard><PlotFold kind="scf" result={p.result} currentIndex={p.currentIndex} onOpenPlot={p.onOpenPlot}/></InputSettingsLayout></div>}
    {(!p.hideEntries || active==='charges') && <div hidden={active !== 'charges'} data-analysis-page="charges"><AnalysisControls kind="charges" ownerId={p.analysisOwnerId} active={p.active!==false&&active==='charges'} cancelOnInactive={p.cancelOnInactive} context={p.analysis} sourceContext={source} onColorbarLayoutReady={active==='charges'?p.onColorbarLayoutReady:undefined} onProfessionalCharges={p.onProfessionalCharges} onSourceAtomHighlight={p.onPrintedAtomHighlight} onChargeAnalysis={p.onChargeAnalysis} onAtomHighlight={p.onAtomHighlight}/></div>}
    {(!p.hideEntries || active==='orbitals') && <div hidden={active !== 'orbitals'} data-analysis-page="orbitals">{p.orbitalControls??<OrbitalControls metadata={null} nativeSessionId={null} sourceResult={p.result} sourceFrameIndex={p.currentIndex} wavefunctionAvailable={false} active={p.active!==false&&active==='orbitals'} onField={()=>{}} onError={()=>{}} onLayerSettings={()=>{}}/>}</div>}
    {(!p.hideEntries || active==='bonds') && <div hidden={active !== 'bonds'} data-analysis-page="bonds"><div hidden={p.wavefunctionAvailable===false}><AnalysisControls kind="bond-orders" ownerId={p.analysisOwnerId} active={p.active!==false&&active==='bonds'&&p.wavefunctionAvailable!==false} cancelOnInactive={p.cancelOnInactive} context={p.analysis} onColorbarLayoutReady={active==='bonds'?p.onColorbarLayoutReady:undefined} onBondAnalysis={p.onBondAnalysis} onBondHighlight={p.onBondHighlight} onBondsHighlight={p.onBondsHighlight} getBondLength={p.getBondLength}/></div>{p.wavefunctionAvailable===false&&<MissingWavefunction kind="bonds"/>}</div>}
    {active==='trajectory'&&<div data-analysis-page="trajectory">{p.trajectoryControls??<p className="postprocess-note">当前来源没有优化轨迹。</p>}</div>}
    {active==='excited'&&<div data-analysis-page="excited">{p.excitationControls??(p.result?<TDDFTControls result={p.result} currentIndex={p.currentIndex} decimals={pageDecimals.excited??2} onDecimalsChange={value=>setPagePrecision('excited',value)}/>:empty('当前来源没有激发态数据。'))}</div>}
    {active==='reactivity'&&<div data-analysis-page="reactivity">{p.reactivityControls??empty('当前来源没有可用的反应性分析数据。')}</div>}
    {active==='vibrations'&&<div data-analysis-page="vibrations">{p.result&&p.structure?<VibrationControls result={p.result} structure={p.structure} currentIndex={p.currentIndex} decimals={pageDecimals.vibrations??2} onDecimalsChange={setVibrationPrecision} active={p.active!==false} {...p.vibrationControls}/>:empty('当前来源没有振动模式。')}</div>}
    {active==='surface'&&<div data-analysis-page="surface">{p.surfaceControls??empty('当前来源没有可用的分子表面数据。')}</div>}
    {active==='interaction'&&<div data-analysis-page="interaction">{p.interactionControls??empty('当前来源没有可用的相互作用分析数据。')}</div>}
  </aside>;
}
