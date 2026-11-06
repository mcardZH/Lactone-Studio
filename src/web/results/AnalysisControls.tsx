import {DismissibleNotice} from '../DismissibleNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {useAnalysisProjectSnapshot,notifyAnalysisProjectStateChanged} from '../../projects/analysis-state';
import NumericInput from '../NumericInput';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisAtomValue, WavefunctionAnalysisRequest, WavefunctionAnalysisResult, AtomicChargeMethod, BondOrderMethod, OrbitalCompositionMethod } from '../../results/wavefunction-analysis';
import { InputSettingsField } from '../InputSettingsFields';
import { InputSettingsLayout, InputSettingsAction, InputSettingsCheckbox } from '../InputSettingsLayout';
import { scientificDisplayValue as number } from './scientific-presentation';
import { exportBlob } from './export-image';
import {activeAnalysisRows,toggleAnalysisRow,analysisRange,formatAnalysisValue, type AnalysisDisplaySettings, type AnalysisPalette} from './analysis-display';
import { createAnalysisComparisonQueue, comparisonAtomRows, comparisonBondRows, comparisonTableProjection, printedChargeColumns,professionalChargeColumns,professionalChargeProjection,professionalChargeDisplay,professionalSourceIdentity,type ProfessionalSourceContext,type ProfessionalChargeDisplay,type ComparisonSnapshot, type ComparisonResult } from './analysis-comparison';
import { ScientificDataTable } from './ScientificDataTable';
import { scientificTableText, type ScientificTableColumn, type ScientificTableProjection } from './scientific-table';
import {useAnalysisFeedback} from './AnalysisFeedback';
import {traceTrajectoryOperation,type TrajectoryOperationContext} from '../../results/trajectory-operations';
import {createMultiwfnProgressTracker,multiwfnProgressTerminal,type MultiwfnProgressIdentity,type MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import MultiwfnProgress from './MultiwfnProgress';
import NumericPrecisionControl from './NumericPrecisionControl';
import { AnalysisPlotSettings, AnalysisTaskLayout, AnalysisTaskSection } from './AnalysisTaskLayout';
import AnalysisColorbarLayoutControls from './AnalysisColorbarLayoutControls';
import { normalizeAnalysisColorbarLayout, type AnalysisColorbarLayout } from './analysis-colorbar-layout';
import {generatedXtbMethodAllowed,type GeneratedXtbAnalysisPolicy} from '../../results/generated-xtb-policy';
import type {WavefunctionMetadata} from '../../results/orbital-contracts';
import { sortAnalysisTable, type AnalysisTableSort } from './analysis-table-sort';
export type {AnalysisDisplaySettings} from './analysis-display';

export interface AnalysisBridge {
  analyzeWavefunction?(sessionId: string, request: WavefunctionAnalysisRequest,progressIdentity?:MultiwfnProgressIdentity): Promise<WavefunctionAnalysisResult>;
  onMultiwfnProgress?(listener:(progress:MultiwfnProgressSnapshot)=>void):()=>void;
  cancelWavefunctionAnalysis?(sessionId: string): Promise<void>;
  chooseOrbitalBackend?(): Promise<{ configured: boolean; path?: string; message?: string }>;
}
export interface AnalysisControlsContext { sessionId: string; sourceRevision: string; sourceName: string; sourceId?:string;format?:WavefunctionMetadata['format']; bridge?: AnalysisBridge;generatedXtb?:boolean;analysisPolicy?:GeneratedXtbAnalysisPolicy }
export type ChargeAnalysis = Extract<WavefunctionAnalysisResult, { kind: 'charges' }>;
export type BondAnalysis = Extract<WavefunctionAnalysisResult, { kind: 'bond-orders' }>;
export type CompositionAnalysis = Extract<WavefunctionAnalysisResult, { kind: 'composition' }>;
export interface AnalysisHighlightProps {
  /** Display-only preview/pins. These callbacks must not modify ModelStore selection. */
  onAtomHighlight?(atomIds: string[], values?: { atomId: string; value: number; label?:string }[]): void;
  onBondHighlight?(atomIds: [string, string] | null): void;
  onBondsHighlight?(atomIds: [string,string][]): void;
  getBondLength?(atomIds:[string,string]):number|undefined;
}
export interface AnalysisControlsProps extends AnalysisHighlightProps {
  ownerId?:string;
  context?: AnalysisControlsContext; kind: WavefunctionAnalysisRequest['kind']; orbitalKey?: string | null;
  active?:boolean; cancelOnInactive?:boolean; defaultMethod?:OrbitalCompositionMethod; autoCalculate?:boolean;
  decimals?:number;onDecimalsChange?(value:number):void;hidePrecisionControl?:boolean;
  onChargeAnalysis?(result: ChargeAnalysis | null, display: AnalysisDisplaySettings, comparisons?: readonly ChargeAnalysis[]): void;
  onBondAnalysis?(result: BondAnalysis | null, display: AnalysisDisplaySettings, comparisons?: readonly BondAnalysis[]): void;
  sourceContext?:ProfessionalSourceContext;
  onProfessionalCharges?(projection:ProfessionalChargeDisplay|null):void;
  onSourceAtomHighlight?:AnalysisHighlightProps['onAtomHighlight'];
  onColorbarLayoutReady?(setter:((layout:AnalysisColorbarLayout)=>void)|null):void;
}
function analysisOperationContext(p:AnalysisControlsProps,context:AnalysisControlsContext):TrajectoryOperationContext{
 const source=p.context?.sessionId===context.sessionId&&p.context.sourceRevision===context.sourceRevision?p.sourceContext:undefined;
 return source?{sourceId:source.result.source.id,resultId:source.result.id,jobIndex:source.result.jobIndex,localFrameIndex:source.frameIndex,sourceFrameIndex:source.result.frames[source.frameIndex]?.sourceFrameIndex??source.frameIndex,sourceRevision:context.sourceRevision}:{sourceId:context.sourceId??'',sourceRevision:context.sourceRevision};
}
function beginNumericalProgress(p:AnalysisControlsProps,context:AnalysisControlsContext,bridge:AnalysisBridge,request:WavefunctionAnalysisRequest,publish:(snapshot:MultiwfnProgressSnapshot)=>void){
 const source=context.sourceId;if(!source||!bridge.onMultiwfnProgress)return null;
 let off=()=>{};const provenance=analysisOperationContext(p,context),tracker=createMultiwfnProgressTracker({ownerId:context.sessionId,analysisId:context.sessionId,sessionId:context.sessionId,runId:crypto.randomUUID(),sourceId:source,sourceRevision:context.sourceRevision,operation:`${request.kind}:${request.method}`,...(provenance.jobIndex===undefined?{}:{jobIndex:provenance.jobIndex}),...(provenance.sourceFrameIndex===undefined?{}:{sourceFrameIndex:provenance.sourceFrameIndex})},snapshot=>{publish(snapshot);if(multiwfnProgressTerminal(snapshot.phase))off();});
 off=bridge.onMultiwfnProgress(snapshot=>tracker.receive(snapshot));return{tracker,off};
}
export const CHARGE_METHODS: { value: AtomicChargeMethod; label: string; disabled?: boolean }[] = [{ value: 'mulliken', label: 'Mulliken' }, { value: 'lowdin', label: 'Löwdin' }, { value: 'adch', label: 'ADCH' }, { value: 'hirshfeld', label: 'Hirshfeld' }, { value: 'hirshfeld-i', label: 'Hirshfeld-I' }, { value: 'cm5', label: 'CM5' }, { value: 'resp', label: 'RESP' }, { value: 'scpa', label: 'SCPA' }, { value: 'bader', label: 'Bader' }];
export const analysisMethodAvailable = (kind: WavefunctionAnalysisRequest['kind'], method: string,context?:AnalysisControlsContext) =>
  (context?.generatedXtb||context?.analysisPolicy!==undefined?generatedXtbMethodAllowed(context.analysisPolicy,context.sourceRevision,kind,method):true)
  &&(method!=='bader'||kind==='charges'&&context?.format==='fchk'&&!context.generatedXtb&&context.analysisPolicy===undefined)
  &&(kind === 'charges' ? CHARGE_METHODS.some(option => option.value === method && !option.disabled) : kind === 'bond-orders' ? BOND_METHODS.some(option => option.value === method) : method === 'mulliken' || method === 'scpa');
const policyIdentity=(context?:AnalysisControlsContext)=>JSON.stringify([context?.generatedXtb,context?.analysisPolicy,context?.format]);
const withoutGeneratedSpin=(value:WavefunctionAnalysisResult,context?:AnalysisControlsContext):WavefunctionAnalysisResult=>{
  if(value.kind!=='charges'||!context?.generatedXtb&&context?.analysisPolicy===undefined)return value;
  // Keep the basin population branch's required fields and discriminant intact.
  if(value.method==='bader')return{...value,spinAvailable:false,atoms:value.atoms.map(row=>{const copy={...row};delete copy.spinPopulation;return copy;})};
  return{...value,spinAvailable:false,atoms:value.atoms.map(row=>{const copy={...row};delete copy.spinPopulation;return copy;})};
};
export const BOND_METHODS: { value: BondOrderMethod; label: string }[] = [{ value: 'mayer', label: 'Mayer' }, { value: 'wiberg-lowdin', label: 'Wiberg–Löwdin' }, { value: 'mulliken', label: 'Mulliken' }, { value: 'laplacian', label: 'Laplacian' }, { value: 'fuzzy', label: 'FBO' }];
type ChargeStyleResult=Pick<ChargeAnalysis,'kind'|'quantity'|'atoms'|'spinAvailable'>;
export const analysisIsPopulation = (result: WavefunctionAnalysisResult|ChargeStyleResult) => result.kind === 'charges' && result.quantity === 'electron-population';
export const effectiveAnalysisSpin = (result: WavefunctionAnalysisResult |ChargeStyleResult| null, spin: boolean) => result?.kind === 'charges' && result.spinAvailable && spin;
export const analysisAtomDisplayValue = (result: WavefunctionAnalysisResult|ChargeStyleResult, row: AnalysisAtomValue, spin: boolean) => effectiveAnalysisSpin(result, spin) ? row.spinPopulation : row.value;
export const analysisValueLabel = (result: WavefunctionAnalysisResult, spin = false) => result.kind === 'composition' ? '贡献 / %' : result.kind === 'bond-orders' ? '连续键级' : effectiveAnalysisSpin(result, spin) ? 'Spin' : analysisIsPopulation(result) ? '盆内电子数 / e' : 'Q / e';
export const analysisSumLabel = (result: ChargeAnalysis) => analysisIsPopulation(result) ? '盆内电子数总和' : '电荷和';
export function analysisFilename(result: WavefunctionAnalysisResult): string {
  const key = result.kind === 'composition' ? `-${result.orbitalKey.replace(/[^a-zA-Z0-9_.-]/g, '-')}` : '';
  return `Ester-Studio-${result.kind}-${result.method}${key}.txt`;
}
export function compositionRows(result: CompositionAnalysis, mode: 'threshold' | 'top10') {
  return result.atoms.filter(row => Number.isFinite(row.value) && (mode === 'top10' || row.value > 5)).sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.sourceIndex - b.sourceIndex).slice(0, 10);
}
export function compositionDisplayText(result:CompositionAnalysis,mode:'threshold'|'top10',decimals=2,projection?:ScientificTableProjection):string{
  const atoms={columns:[{key:'atom',label:'原子'},{key:'contribution',label:'贡献 / %'}],rows:compositionRows(result,mode).map(row=>({key:row.atomId,cells:[`${row.sourceIndex} ${row.element}`,formatAnalysisValue(row.value,decimals)]}))};
  const angular={columns:[{key:'angular',label:'角向分量'},{key:'contribution',label:'贡献 / %'}],rows:Object.entries(result.angular).map(([key,value])=>({key,cells:[key.toUpperCase(),formatAnalysisValue(value,decimals)]}))};
  return scientificTableText(projection??atoms)+'\n'+scientificTableText(angular)+`完整和 / %\t${formatAnalysisValue(result.sum,decimals)}\n`;
}
/** Display-only positive bond-order threshold. Full source results stay intact for export. */
export function visibleBondRows(result: BondAnalysis) { return result.bonds.filter(row=>Number.isFinite(row.value)&&row.value>0.05); }
export function visibleBondHighlights(result:BondAnalysis,keys:readonly string[]):[string,string][] {
 return visibleBondRows(result).filter(row=>keys.includes(JSON.stringify([row.atomId1,row.atomId2]))).map(row=>[row.atomId1,row.atomId2] as [string,string]);
}
const textCell = (value: unknown) => String(value ?? '').replace(/[\t\r\n]/g, ' ');
const missingAnalysisBackend = (message:string) => /(?:ANALYSIS|ORBITAL)_BACKEND_MISSING/.test(message);
/** Full results, not the filtered visual subset. Printed columns are Origin friendly. */
export function analysisText(result: WavefunctionAnalysisResult, sourceName: string): string {
  const rows = [`# source=${textCell(sourceName)}; session=${result.sessionId}; revision=${result.sourceRevision}; method=${result.method}; backend=${result.backend.name} ${result.backend.version}`];
  if (result.kind === 'bond-orders') { rows.push('source_index_1\tsource_index_2\tatom_id_1\tatom_id_2\tbond_order'); for (const row of result.bonds) rows.push([row.sourceIndex1, row.sourceIndex2, row.atomId1, row.atomId2, row.value].map(textCell).join('\t')); }
  else { rows.push('source_index\tatom_id\telement\tvalue\tunit\tspin_population\telectron_population\treference_charge'); for (const row of result.atoms) rows.push([row.sourceIndex, row.atomId, row.element, row.value, result.unit, row.spinPopulation, row.electronPopulation, row.referenceCharge].map(textCell).join('\t')); }
  if (result.kind === 'composition') { rows.splice(1, 0, `# orbital_key=${textCell(result.orbitalKey)}`); rows.push('# angular_component\tpercent'); for (const [key, value] of Object.entries(result.angular)) rows.push(`${key}\t${value}`); }
  if (result.kind === 'charges' && result.chargeConvention) rows.push(`# charge_convention=${textCell(result.chargeConvention)}`);
  if (result.kind === 'charges') rows.push(`# quantity=${result.quantity ?? 'net-charge'}`);
  rows.push(`# geometry_identity=${textCell(result.geometryIdentity)}`);
  if (result.kind !== 'charges') rows.push(`# quantity=${result.kind === 'composition' ? 'orbital-composition-percent' : 'bond-order'}`);
  if (result.parameters) for (const [key, value] of Object.entries(result.parameters)) rows.push(`# parameter.${key}=${textCell(Array.isArray(value) ? value.join(',') : value)}`);
  for (const warning of result.warnings) rows.push(`# warning=${textCell(warning)}`);
  return rows.join('\n') + '\n';
}
/** Source session and request serial jointly revoke late UI results. */
export function createAnalysisRequestGuard() {
  let serial = 0, identity = '';
  return { begin(value: string) { identity = value; return ++serial; }, invalidate() { serial++; }, accepts(value: string, request: number) { return value === identity && request === serial; } };
}
export function AngularShape({ kind }: { kind: string }) {
  const normalized=kind.toLowerCase();if(!['s','p','d','f'].includes(normalized))return null;
  return <svg className="analysis-angular-shape" viewBox="0 0 40 32" role="img" aria-label={`${normalized.toUpperCase()}轨道形状示意`}><title>典型角向形状示意</title>
    {normalized==='s'?<circle cx="20" cy="16" r="10"/>:normalized==='p'?<><ellipse cx="12" cy="16" rx="8" ry="6"/><ellipse cx="28" cy="16" rx="8" ry="6"/></>:Array.from({length:normalized==='d'?4:6},(_,index)=><ellipse key={index} cx="20" cy="7" rx="4.5" ry="7" transform={`rotate(${index*360/(normalized==='d'?4:6)} 20 16)`}/>)}
  </svg>;
}
export function AnalysisStyleControls({result,display,onChange,hidePrecisionControl=false,methodControl}:{result:WavefunctionAnalysisResult|ChargeStyleResult;display:AnalysisDisplaySettings;onChange(value:AnalysisDisplaySettings):void;hidePrecisionControl?:boolean;methodControl?:ReactNode}) {
 const patch=(value:Partial<AnalysisDisplaySettings>)=>onChange({...display,...value});
 const scalar=result.kind!=='composition'&&!analysisIsPopulation(result),effectiveSpin=effectiveAnalysisSpin(result,display.spin);
 return <AnalysisPlotSettings className="analysis-style">{methodControl}
  <div className="analysis-style-options">{scalar&&<><InputSettingsCheckbox label="按数值着色" checked={display.color} onChange={color=>patch({color})}/><InputSettingsCheckbox label="显示数值标签" checked={display.labels} onChange={labels=>patch({labels})}/></>}
   {result.kind==='charges'&&(result.spinAvailable||display.spin)&&<InputSettingsCheckbox label="显示自旋布居 Spin" checked={display.spin} onChange={spin=>patch({spin})}/>}
   {scalar&&<InputSettingsCheckbox label="锁定色阶范围" checked={Boolean(display.range)} onChange={locked=>patch({range:locked?analysisRange(result.kind==='bond-orders'?result.bonds.map(row=>row.value):result.kind==='charges'?result.atoms.flatMap(row=>{const value=analysisAtomDisplayValue(result,row,effectiveSpin);return value!==undefined&&Number.isFinite(value)?[value]:[];}):[],{...display,range:undefined},result.kind==='charges')??undefined:undefined})}/>}
  </div>
  <div className="analysis-style-values">{!hidePrecisionControl&&<NumericPrecisionControl value={display.decimals??2} onChange={decimals=>patch({decimals})} ariaLabel={result.kind==='charges'?'电荷显示小数位':result.kind==='bond-orders'?'键级显示小数位':'轨道显示小数位'}/>}
   {scalar&&<InputSettingsField label="色板"><select aria-label="分析色板" value={display.palette??'blue-red'} onChange={event=>patch({palette:event.target.value as AnalysisPalette})}><option value="blue-red">蓝–白–红</option><option value="purple-green">紫–白–绿</option><option value="viridis">Viridis</option></select></InputSettingsField>}
   {scalar&&display.range&&<div className="analysis-range"><label>下限<NumericInput aria-label="色阶下限"  step="any" value={display.range.min} onChange={event=>{const min=Number(event.target.value);if(Number.isFinite(min))patch({range:{min,max:display.range!.max}});}}/></label><label>上限<NumericInput aria-label="色阶上限"  step="any" value={display.range.max} onChange={event=>{const max=Number(event.target.value);if(Number.isFinite(max))patch({range:{min:display.range!.min,max}});}}/></label></div>}
  </div>
  {scalar&&<AnalysisColorbarLayoutControls layout={display.colorbarLayout} onChange={colorbarLayout=>patch({colorbarLayout})}/>}
 </AnalysisPlotSettings>;
}
function SingleAnalysisControls(p: AnalysisControlsProps) {
  const {notify,feedback}=useAnalysisFeedback();
  const showNotice=notify;
  const [method, setMethod] = useProjectState<string>('AnalysisControls.method', p.kind === 'charges' ? 'mulliken' : p.kind === 'bond-orders' ? 'mayer' : p.defaultMethod ?? 'mulliken');
  const [result, setResult] = useState<WavefunctionAnalysisResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [taskProgress,setTaskProgress]=useState<MultiwfnProgressSnapshot|null>(null),progressRun=useRef<ReturnType<typeof beginNumericalProgress>>(null);
  const [localDisplay, setLocalDisplay] = useProjectState<AnalysisDisplaySettings>('AnalysisControls.localDisplay', { color: false, labels: false, spin: false }), [filter, setFilter] = useProjectState<'threshold' | 'top10'>('AnalysisControls.filter', 'threshold');
  const display=useMemo(()=>({...localDisplay,...(p.context?.generatedXtb?{spin:false}:{}),decimals:p.decimals??localDisplay.decimals??2}),[localDisplay,p.decimals,p.context?.generatedXtb]);
  const setDisplay=(value:AnalysisDisplaySettings)=>{setLocalDisplay(value);if(value.decimals!==undefined)p.onDecimalsChange?.(value.decimals);};
  const [pinned,setPinned]=useProjectState<string[]>('AnalysisControls.pinned', []),[hover,setHover]=useState<string|null>(null),[current,setCurrent]=useProjectState<string|null>('AnalysisControls.current', null);
  const callbacks = useRef(p); callbacks.current = p;
  const guard = useRef(createAnalysisRequestGuard()), mounted = useRef(true);
  const cache = useRef(new Map<string, WavefunctionAnalysisResult>());
  const [sort, setSort] = useProjectState<AnalysisTableSort>('AnalysisControls.sort', {column:"",direction:"asc"});
  const computeActive=p.active!==false||p.cancelOnInactive===false;
  const sourceIdentity = JSON.stringify([p.context?.sourceId, p.context?.sourceRevision,policyIdentity(p.context)]);
  const previousSource = useRef(sourceIdentity);
  const identity = JSON.stringify([p.context?.sourceId, p.context?.sourceRevision, p.kind, p.kind === 'composition' ? p.orbitalKey : null,policyIdentity(p.context)]);
  const liveIdentity = useRef(identity); liveIdentity.current = identity;
  const bridge = p.context?.bridge ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop);
  const effectiveSpin = effectiveAnalysisSpin(result, display.spin);
  const clearOverlay = () => { if (p.kind === 'charges') callbacks.current.onChargeAnalysis?.(null, display); if (p.kind === 'bond-orders') callbacks.current.onBondAnalysis?.(null, display); callbacks.current.onAtomHighlight?.([]); callbacks.current.onBondHighlight?.(null); callbacks.current.onBondsHighlight?.([]); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false;progressRun.current?.off(); guard.current.invalidate(); clearOverlay();const context=callbacks.current.context;if(context)void (context.bridge??bridge)?.cancelWavefunctionAnalysis?.(context.sessionId).catch(()=>{}); }; }, []);
  useEffect(() => { guard.current.invalidate();progressRun.current?.off();progressRun.current=null; setResult(null); setBusy(false); setError('');setTaskProgress(null); clearOverlay(); if (previousSource.current !== sourceIdentity) { setPinned([]); setHover(null); setCurrent(null); cache.current.clear(); previousSource.current = sourceIdentity; } }, [identity]);
  // Browsing or changing orbitals may restore a result, but only a method click
  // authorizes a new composition calculation for this orbital.
  useEffect(() => { setResult(cache.current.get(`${identity}:${method}`) ?? null); }, [identity, method]);
  useAnalysisProjectSnapshot(`controls:single-analysis:${projectUiSourceIdentity(p)}`,()=>({cache:new Map(cache.current),result}),saved=>{
    const rebind=(value:WavefunctionAnalysisResult)=>({...value,...(p.context?{sessionId:p.context.sessionId,sourceRevision:p.context.sourceRevision}:{})});
    cache.current=new Map([...saved.cache].map(([key,value])=>[key,rebind(value)]));setResult(saved.result?rebind(saved.result):null);setBusy(false);setHover(null);
  },undefined,()=>({cache:cache.current,result}));
  useEffect(()=>{if(p.active===false){setHover(null);if(busy&&p.cancelOnInactive!==false){guard.current.invalidate();setBusy(false);void bridge?.cancelWavefunctionAnalysis?.(p.context!.sessionId).catch(()=>{});}}},[p.active,p.cancelOnInactive]);
  useEffect(()=>{
    const rows=p.active===false?[]:activeAnalysisRows([...new Set([...pinned,...(current?[current]:[])])],hover);
    if(result?.kind==='bond-orders'){const available=new Map(visibleBondHighlights(result,rows).map(pair=>[JSON.stringify(pair),pair]));const pairs=rows.flatMap(key=>{const pair=available.get(key);return pair?[pair]:[];});callbacks.current.onBondsHighlight?.(pairs);callbacks.current.onBondHighlight?.(pairs[0]??null);}
    else {const available=new Map(result?.atoms.map(row=>[row.atomId,row])??[]),atoms=rows.flatMap(key=>{const row=available.get(key);return row?[row]:[];});callbacks.current.onAtomHighlight?.(atoms.map(row=>row.atomId),result?.kind==='composition'?atoms.map(row=>({atomId:row.atomId,value:row.value,label:`贡献 ${formatAnalysisValue(row.value,display.decimals)} %`})):undefined);}
  },[result,pinned,hover,current,p.active,display.decimals]);
  useEffect(() => {
    if (result?.kind === 'charges') callbacks.current.onChargeAnalysis?.(result.quantity === 'electron-population' ? null : result, { ...display, spin: effectiveSpin });
    if (result?.kind === 'bond-orders') callbacks.current.onBondAnalysis?.(result, display);
  }, [result, display, effectiveSpin]);
  async function cancel() {
    if(!busy){showNotice('当前没有运行中的分析。');return;}
    guard.current.invalidate();setResult(null);clearOverlay();const progress=progressRun.current;progress?.tracker.stopping();
    try { if (p.context) await bridge?.cancelWavefunctionAnalysis?.(p.context.sessionId);progress?.tracker.stopped(progress.tracker.getSnapshot().settlement==='cancelled-before-start'?'cancelled-before-start':'native-settled'); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }finally{if(mounted.current)setBusy(false);}
  }
  async function calculate(force = true, cancelPrevious = false, selectedMethod=method) {
    const issue=!p.context?'请先载入已核对的波函数来源。':!bridge?.analyzeWavefunction?'当前环境尚未连接分析后端。':!computeActive?'请先激活此分析页。':p.kind==='composition'&&!p.orbitalKey?'请先选择可用轨道。':busy&&!cancelPrevious?'分析正在计算中。':!analysisMethodAvailable(p.kind,selectedMethod,p.context)?'此来源尚未开放该分析方法。':'';
    if(issue){if(force)showNotice(issue);return;}
    if(!p.context||!bridge?.analyzeWavefunction)return;

    const request: WavefunctionAnalysisRequest = p.kind === 'charges' ? { kind: 'charges', method: selectedMethod as AtomicChargeMethod } : p.kind === 'bond-orders' ? { kind: 'bond-orders', method: selectedMethod as BondOrderMethod } : { kind: 'composition', method: selectedMethod as OrbitalCompositionMethod, orbitalKey: p.orbitalKey! };
    const ownIdentity = identity, cacheKey = `${identity}:${selectedMethod}`, own = guard.current.begin(identity); setBusy(true); setError(''); setResult(null); clearOverlay();
    let progress:ReturnType<typeof beginNumericalProgress>=null;
    try {
      if (cancelPrevious) {
        await bridge.cancelWavefunctionAnalysis?.(p.context.sessionId);
        if (!mounted.current || liveIdentity.current !== ownIdentity || !guard.current.accepts(ownIdentity, own)) return;
      }
      const cached = cache.current.get(cacheKey);
      if (!force && cached) {progressRun.current?.off();progressRun.current=null;setTaskProgress(null); setResult(cached); return; }
      if(!analysisMethodAvailable(request.kind,request.method,callbacks.current.context))throw new Error('此来源尚未开放该分析方法。');
      progressRun.current?.off();progress=beginNumericalProgress(p,p.context,bridge,request,snapshot=>{if(mounted.current&&liveIdentity.current===ownIdentity)setTaskProgress(snapshot);});progressRun.current=progress;
      const value = await traceTrajectoryOperation('quantum',analysisOperationContext(p,p.context),()=>progress?bridge.analyzeWavefunction!(p.context!.sessionId, request,progress.tracker.identity):bridge.analyzeWavefunction!(p.context!.sessionId, request));
      if (!mounted.current || liveIdentity.current !== ownIdentity || !guard.current.accepts(ownIdentity, own)) return;
      if(!analysisMethodAvailable(request.kind,request.method,callbacks.current.context))return;
      if (value.sessionId !== p.context.sessionId || value.sourceRevision !== p.context.sourceRevision || value.kind !== request.kind || value.method !== request.method || value.kind === 'composition' && value.orbitalKey !== p.orbitalKey) throw new Error('分析回执与当前来源或方法不匹配。');
      const accepted=withoutGeneratedSpin(value,callbacks.current.context);cache.current.set(cacheKey, accepted);notifyAnalysisProjectStateChanged(); setResult(accepted);progress?.tracker.committed();
    } catch (cause) { if (mounted.current && guard.current.accepts(ownIdentity, own)){const message=cause instanceof Error?cause.message:String(cause);progress?.tracker.failed(progress.tracker.getSnapshot().settlement??'native-settled',message);if(missingAnalysisBackend(message))showNotice('请先选择本机 Multiwfn。');else setError(message);} }
    finally {if(progress&&multiwfnProgressTerminal(progress.tracker.getSnapshot().phase)){progress.off();if(progressRun.current===progress)progressRun.current=null;} if (mounted.current && guard.current.accepts(ownIdentity, own)) setBusy(false); }
  }
  function chooseMethod(value:string){
    if(!p.context||!bridge?.analyzeWavefunction){notify('请先载入波函数并配置本机 Multiwfn。');return;}
    if(p.kind==='composition'&&!p.orbitalKey){notify('请先选择一个轨道。');return;}
    if(busy||!analysisMethodAvailable(p.kind,value,p.context)){showNotice(busy?'分析正在计算中。':'此来源尚未开放该分析方法。');return;}
    guard.current.invalidate();setMethod(value);setPinned([]);setHover(null);setCurrent(null);setResult(null);clearOverlay();void calculate(false,false,value);
  }
  const options: { value: string; label: string; disabled?: boolean }[] = p.kind === 'charges' ? CHARGE_METHODS : p.kind === 'bond-orders' ? BOND_METHODS : [{ value: 'mulliken', label: 'Mulliken' }, { value: 'scpa', label: 'SCPA' }];
  const values = result?.kind === 'composition' ? compositionRows(result, filter) : result && result.kind !== 'bond-orders' ? result.atoms : [];
  const interaction=(key:string)=>({'aria-selected':current===key,onPointerEnter:()=>setHover(key),onPointerLeave:()=>setHover(null)});
  const rawSingleTable:ScientificTableProjection=result?.kind==='bond-orders'?{columns:[{key:'pair',label:'原子对'},{key:'length',label:'键长 / Å'},{key:'value',label:'连续键级 > 0.05'}],rows:visibleBondRows(result).map(row=>({key:JSON.stringify([row.atomId1,row.atomId2]),cells:[`${row.sourceIndex1}–${row.sourceIndex2}`,formatAnalysisValue(p.getBondLength?.([row.atomId1,row.atomId2]),display.decimals),formatAnalysisValue(row.value,display.decimals)]}))}:{columns:[{key:'atom',label:'原子'},{key:'value',label:result?analysisValueLabel(result,effectiveSpin):'数值'}],rows:values.map(row=>({key:row.atomId,cells:[`${row.sourceIndex} ${row.element}`,formatAnalysisValue(result?analysisAtomDisplayValue(result,row,effectiveSpin):null,display.decimals)]}))};
  const singleTable=sortAnalysisTable(rawSingleTable,sort,(key,column)=>{const row=values.find(row=>row.atomId===key);return column==='identity'?row?.sourceIndex:row?.value;});
  const progress=taskProgress?<MultiwfnProgress progress={taskProgress} operationLabel={`Multiwfn · ${method}`} onStop={()=>void cancel()}/>:busy?<div role="status">正在分析当前来源… <InputSettingsAction onClick={()=>void cancel()}>停止</InputSettingsAction></div>:null;
  return <InputSettingsLayout className="analysis-controls">{feedback}<AnalysisTaskLayout variant="card" title={p.kind === 'charges' ? '原子电荷' : p.kind === 'bond-orders' ? '连续键级' : '空间轨道组成'} progress={progress} setup={<>
    <div className="analysis-method-chips" role="group" aria-label={`${p.kind}分析方法`}>{options.map(option=><button type="button" key={option.value} className="shared-input-action analysis-method-chip" aria-pressed={method===option.value} disabled={!analysisMethodAvailable(p.kind,option.value,p.context)||undefined} onClick={()=>chooseMethod(option.value)}>{option.label}</button>)}</div>
    </>}>{error && <DismissibleNotice role="alert" className="postprocess-warning">{error}</DismissibleNotice>}
    {result ? <AnalysisTaskSection title="组成结果"><p className="postprocess-note">{result.kind==='composition'?`当前轨道 ${result.orbitalKey} · `:''}{result.method} · {p.context?.sourceName ?? '已载入的波函数'}</p>
      {result.kind === 'composition' && <><InputSettingsField label="贡献筛选"><select aria-label="轨道贡献筛选" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="threshold">&gt;5% · 最多10项</option><option value="top10">Top10 · 按绝对贡献</option></select></InputSettingsField><dl className="analysis-angular">{Object.entries(result.angular).map(([key, value]) => <div key={key}><dt><AngularShape kind={key}/>{key.toUpperCase()}</dt><dd>{formatAnalysisValue(value,display.decimals)}%</dd></div>)}</dl><p className="postprocess-note">显示原始有符号百分比，不对筛选子集重新归一化。完整和 {formatAnalysisValue(result.sum,display.decimals)}%。</p></>}
      <ScientificDataTable hideTitle onExport={()=>exportBlob(new Blob([result.kind==='composition'?compositionDisplayText(result,filter,display.decimals,singleTable):scientificTableText(singleTable)],{type:'text/plain;charset=utf-8'}),analysisFilename(result))} title={p.kind==='composition'?'轨道组成':p.kind==='charges'?'原子电荷':'连续键级'} projection={singleTable} sorting={{value:sort.column,direction:sort.direction,options:[{value:"",label:"默认顺序"},{value:"identity",label:"原子编号"},{value:"value",label:"贡献"}],onChange:(column,direction)=>setSort({column,direction})}} selectionScope={identity} onRowActivate={row=>setCurrent(row.key)} onClearActive={()=>{setCurrent(null);setHover(null);}} activeRowKey={current??undefined} format={{decimals:display.decimals??2,onDecimalsChange:decimals=>setDisplay({...display,decimals}),ariaLabel:p.kind==='composition'?'轨道组成':p.kind==='charges'?'原子电荷':'连续键级'}} rowBindings={row=>interaction(row.key)} rowAction={{kind:'pin',label:row=>`${pinned.includes(row.key)?'取消固定':'固定'} ${row.cells[0]}`,active:row=>pinned.includes(row.key),onActivate:row=>setPinned(value=>toggleAnalysisRow(value,row.key))}}/>
      {result.kind === 'charges' && <p>{analysisSumLabel(result)}：{number(result.sum)} e{result.chargeConvention ? ` · ${result.chargeConvention}` : ''}</p>}
      {result.warnings.map((warning, index) => <p className="postprocess-warning" key={index}>{warning}</p>)}
    </AnalysisTaskSection>:<p className="postprocess-note">尚未计算轨道组成。</p>}
    {result&&!p.hidePrecisionControl&&<AnalysisStyleControls hidePrecisionControl result={result} display={display} onChange={setDisplay}/>}
    {p.kind === 'bond-orders' && <button type="button" disabled title="连续键级到离散拓扑的阈值尚未批准">按键级判断成键 · 待定</button>}
  </AnalysisTaskLayout></InputSettingsLayout>;
}

const emptyComparison = (): ComparisonSnapshot => ({ selected: [], results: new Map(), states: new Map(), errors: new Map(), running: null });
function MultiAnalysisControls(p: AnalysisControlsProps) {
  const {notify:showNotice,clear:clearNotice,feedback}=useAnalysisFeedback();
  const originals=useMemo(()=>p.kind==='charges'&&p.sourceContext?printedChargeColumns(p.sourceContext):[],[p.kind,p.sourceContext]);
  const [state, setState] = useState<ComparisonSnapshot>(()=>({...emptyComparison(),selected:originals.map(column=>column.key)}));
  const [activeMethod, setActiveMethod] = useProjectState<string | null>('AnalysisControls.activeMethod', null);
  const [localDisplay, setLocalDisplay] = useProjectState<AnalysisDisplaySettings>('AnalysisControls.localDisplay', { color: false, labels: false, spin: false });
  const display=useMemo(()=>({...localDisplay,...(p.context?.generatedXtb||p.sourceContext?.generatedXtb?{spin:false}:{}),decimals:p.decimals??localDisplay.decimals??2}),[localDisplay,p.decimals,p.context?.generatedXtb,p.sourceContext?.generatedXtb]);
  const setDisplay=(value:AnalysisDisplaySettings)=>{setLocalDisplay(value);if(value.decimals!==undefined)p.onDecimalsChange?.(value.decimals);};
  const [pinned, setPinned] = useProjectState<string[]>('AnalysisControls.pinned', []), [hover, setHover] = useState<string | null>(null), [current, setCurrent] = useProjectState<string | null>('AnalysisControls.current', null);
  const missingBackendNotice = useRef('');
  const sourceSelections=useRef(new Map<string,{manual:boolean;methods:string[]}>());
  const [reviewPrinted,setReviewPrinted]=useState(false);
  const [sort,setSort]=useProjectState<AnalysisTableSort>('AnalysisControls.sort', {column:'identity',direction:'asc'});
  const [stopping,setStopping]=useState(false);
  const [taskProgress,setTaskProgress]=useState<MultiwfnProgressSnapshot|null>(null);
  const progressRun=useRef<{handle:NonNullable<ReturnType<typeof beginNumericalProgress>>;value?:WavefunctionAnalysisResult}|null>(null);
  const callbacks = useRef(p); callbacks.current = p;
  const queue = useRef<ReturnType<typeof createAnalysisComparisonQueue> | null>(null);
  if (!queue.current) queue.current = createAnalysisComparisonQueue(setState);
  const bridge = p.context?.bridge ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop);
  const identity = JSON.stringify([p.context?.sessionId, p.context?.sourceRevision, p.kind,policyIdentity(p.context)]);
  const sourceIdentity=p.sourceContext?professionalSourceIdentity(p.sourceContext):'';
  const displayOwner=JSON.stringify([p.ownerId,identity,sourceIdentity]),liveDisplayOwner=useRef(displayOwner);liveDisplayOwner.current=displayOwner;
  useEffect(()=>{
    let alive=true;
    const publish=p.onColorbarLayoutReady;
    if(p.active===false){publish?.(null);return;}
    publish?.(layout=>{
      if(!alive||liveDisplayOwner.current!==displayOwner||callbacks.current.active===false)return;
      const colorbarLayout=normalizeAnalysisColorbarLayout(layout);
      setLocalDisplay(previous=>({...previous,colorbarLayout}));
    });
    return()=>{alive=false;publish?.(null);};
  },[displayOwner,p.active,p.onColorbarLayoutReady]);
  const sourceOwnerIdentity=JSON.stringify([p.sourceContext?.result.id,p.sourceContext?.result.source.id,p.sourceContext?.result.jobIndex]);
  const options = p.kind === 'charges' ? CHARGE_METHODS : BOND_METHODS;
  const order = [...options.map(option => option.value),...originals.map(column=>column.key).filter(key=>!options.some(option=>option.value===key))];
  const available = state.selected.flatMap(method => { const result = state.results.get(method); return result&&analysisMethodAvailable(p.kind,method,p.context) ? [result] : []; });
  const result = available.find(value => value.method === activeMethod) ?? available[0] ?? null;
  const professionalColumns=useMemo(()=>p.kind==='charges'&&p.sourceContext?professionalChargeColumns({...p.sourceContext,nativeSessionId:p.context?.sessionId,nativeSourceRevision:p.context?.sourceRevision},available,state.selected,reviewPrinted,state.states):null,[p.kind,p.sourceContext,state,reviewPrinted,p.context?.sessionId,p.context?.sourceRevision]);
  const professional=useMemo(()=>p.sourceContext&&professionalColumns?professionalChargeDisplay(p.sourceContext,professionalColumns,activeMethod,display):null,[p.sourceContext,professionalColumns,activeMethod,display]);
  const activeColumn=professionalColumns?.find(column=>column.key===professional?.activeMethod);
  const atoms = comparisonAtomRows(available), bonds = comparisonBondRows(available);
  const clearHighlights = () => { callbacks.current.onAtomHighlight?.([], undefined); callbacks.current.onBondHighlight?.(null); callbacks.current.onBondsHighlight?.([]); };
  useEffect(() => {
    queue.current!.setSource(p.context && bridge?.analyzeWavefunction ? {
      identity, sessionId: p.context.sessionId, sourceRevision: p.context.sourceRevision,
      kind: p.kind as ComparisonResult['kind'], analyze: ((context:AnalysisControlsContext)=>async(sessionId:string,request:WavefunctionAnalysisRequest)=>{
        const live=callbacks.current.context;
        if(!live||live.sessionId!==sessionId||live.sourceRevision!==context.sourceRevision||policyIdentity(live)!==policyIdentity(context)||!analysisMethodAvailable(request.kind,request.method,live))throw new Error('此来源尚未开放该分析方法，或分析许可已变化。');
        const captured=callbacks.current.sourceContext?professionalSourceIdentity(callbacks.current.sourceContext):'';progressRun.current?.handle.off();const progress=beginNumericalProgress(callbacks.current,context,bridge,request,snapshot=>{const current=callbacks.current;if(current.context?.sessionId===context.sessionId&&current.context.sourceRevision===context.sourceRevision&&(current.sourceContext?professionalSourceIdentity(current.sourceContext):'')===captured)setTaskProgress(snapshot);});const own=progress?{handle:progress,value:undefined as WavefunctionAnalysisResult|undefined}:null;progressRun.current=own;
        try{const value=withoutGeneratedSpin(await traceTrajectoryOperation('quantum',analysisOperationContext(callbacks.current,context),()=>progress?bridge.analyzeWavefunction!(sessionId,request,progress.tracker.identity):bridge.analyzeWavefunction!(sessionId,request)),context);
          const current=callbacks.current.context;if(!current||current.sessionId!==sessionId||current.sourceRevision!==context.sourceRevision||policyIdentity(current)!==policyIdentity(context)||!analysisMethodAvailable(request.kind,request.method,current))throw new Error('分析回执到达时来源许可已变化。');
          if(own)own.value=value;notifyAnalysisProjectStateChanged();return value;}catch(error){if(progress?.tracker.getSnapshot().phase!=='stopping')progress?.tracker.failed(progress.tracker.getSnapshot().settlement??'native-settled',error instanceof Error?error.message:String(error));throw error;}
      })(p.context), cancel:bridge.cancelWavefunctionAnalysis?async sessionId=>{const progress=progressRun.current?.handle;setStopping(true);progress?.tracker.stopping();try{await bridge.cancelWavefunctionAnalysis!(sessionId);progress?.tracker.stopped(progress.tracker.getSnapshot().settlement==='cancelled-before-start'?'cancelled-before-start':'native-settled');}finally{if(callbacks.current.context?.sessionId===sessionId)setStopping(false);}}:undefined,
    } : undefined);
    setTaskProgress(null);setStopping(false);if(!p.sourceContext){setPinned([]); setHover(null); setCurrent(null); setActiveMethod(null);} clearNotice();
  }, [identity, bridge?.analyzeWavefunction, bridge?.cancelWavefunctionAnalysis]);
  useEffect(()=>{if(!p.sourceContext)return;setTaskProgress(null);const previous=sourceSelections.current.get(sourceOwnerIdentity),methods=previous?.manual?previous.methods:originals.map(column=>column.key);sourceSelections.current.set(sourceOwnerIdentity,{manual:previous?.manual??false,methods});for(const key of queue.current!.snapshot().selected)if(!methods.includes(key))queue.current!.select(key,false,order,{calculate:false});for(const key of methods)queue.current!.select(key,true,order,{calculate:false});setHover(null);setReviewPrinted(false);},[identity,sourceIdentity]);
  const highlightOwner=p.sourceContext?sourceOwnerIdentity:identity;
  useEffect(()=>{setPinned([]);setHover(null);setCurrent(null);setActiveMethod(null);},[highlightOwner]);
  useAnalysisProjectSnapshot(`controls:comparison-analysis:${projectUiSourceIdentity(p)}`,()=>({state:queue.current!.snapshot(),sourceSelections:new Map(sourceSelections.current),pinned,current,activeMethod}),saved=>{
    const results=new Map([...saved.state.results].map(([key,value])=>[key,{...value,...(p.context?{sessionId:p.context.sessionId,sourceRevision:p.context.sourceRevision}:{})}]));
    queue.current!.restore({...saved.state,results,running:null});sourceSelections.current=saved.sourceSelections;setPinned(saved.pinned);setCurrent(saved.current);setActiveMethod(saved.activeMethod);setHover(null);setStopping(false);
  },undefined,()=>({results:queue.current!.snapshot().results}));
  useEffect(() => {if(p.sourceContext?.wavefunctionAvailable===false)queue.current!.cancel();queue.current!.setEnabled((p.active !== false || p.cancelOnInactive === false)&&p.sourceContext?.wavefunctionAvailable!==false); if (p.active === false) setHover(null); }, [p.active, p.cancelOnInactive,p.sourceContext?.wavefunctionAvailable]);
  useEffect(()=>{
    const message=state.selected.map(method=>state.errors.get(method)).find(value=>value&&missingAnalysisBackend(value))??'';
    if(message&&message!==missingBackendNotice.current)showNotice('请先选择本机 Multiwfn。');
    missingBackendNotice.current=message;
  },[state]);
  useEffect(() => () => {
    progressRun.current?.handle.off();
    queue.current!.dispose(); clearHighlights();
    callbacks.current.onChargeAnalysis?.(null, display, []); callbacks.current.onBondAnalysis?.(null, display, []);
    callbacks.current.onProfessionalCharges?.(null);callbacks.current.onSourceAtomHighlight?.([],[]);
  }, []);
  useEffect(() => {
    const own=progressRun.current;if(own?.value&&state.results.get(own.value.method)===own.value)own.handle.tracker.committed();
    if (p.kind === 'charges') {callbacks.current.onChargeAnalysis?.(!p.sourceContext&&result?.kind === 'charges' && !analysisIsPopulation(result) ? result : null, display, p.sourceContext?[]:available.filter((value): value is ChargeAnalysis => value.kind === 'charges'));callbacks.current.onProfessionalCharges?.(professional);}
    else callbacks.current.onBondAnalysis?.(result?.kind === 'bond-orders' ? result : null, display, available.filter((value): value is BondAnalysis => value.kind === 'bond-orders'));
  }, [state, result, display,professional]);
  useEffect(() => {
    const keys = p.active === false ? [] : activeAnalysisRows([...new Set([...pinned,...(current?[current]:[])])], hover);
    if (p.kind === 'charges'&&professional) {const rows=new Map(professional.atoms.map(row=>[row.atomId,row]));const values=keys.flatMap(key=>rows.has(key)?[rows.get(key)!]:[]);callbacks.current.onSourceAtomHighlight?.(values.map(row=>row.atomId),values);callbacks.current.onAtomHighlight?.([],[]);}
    else if (p.kind === 'charges') {const available=new Map(atoms.map(row=>[row.atomId,row]));callbacks.current.onAtomHighlight?.(keys.flatMap(key=>{const row=available.get(key);return row?[row.atomId]:[];}), undefined);}
    else {const available=new Map(bonds.map(row=>[row.key,[row.atomId1,row.atomId2] as [string,string]]));const pairs=keys.flatMap(key=>{const pair=available.get(key);return pair?[pair]:[];});callbacks.current.onBondsHighlight?.(pairs);callbacks.current.onBondHighlight?.(pairs[0] ?? null);}
  }, [state, pinned, hover, current, p.active,professional]);
  const contextIssue = () => !p.context||p.sourceContext?.wavefunctionAvailable===false ? '当前帧缺少已核对的波函数来源；已有来源值仍可查看。' : !bridge?.analyzeWavefunction ? '当前环境尚未连接分析后端。' : p.active === false && p.cancelOnInactive !== false ? '请先激活此分析页。' : '';
  function chooseMethod(method: string) {
    if(originals.some(column=>column.key===method)){queue.current!.select(method,!queue.current!.snapshot().selected.includes(method),order,{calculate:false});sourceSelections.current.set(sourceOwnerIdentity,{manual:true,methods:queue.current!.snapshot().selected});return;}
    if (!analysisMethodAvailable(p.kind, method,p.context)) { showNotice(method==='bader'?'Bader 需要 FCHK 来源；核参考、ECP、周期性及电子数由后端核对。':'此来源尚未开放该分析方法。'); return; }
    const issue = contextIssue(); if (issue) { showNotice(issue); return; }
    queue.current!.select(method, !queue.current!.snapshot().selected.includes(method), order);
    if(p.sourceContext)sourceSelections.current.set(sourceOwnerIdentity,{manual:true,methods:queue.current!.snapshot().selected});
  }
  function retryMethod(method: string) {
    const issue = contextIssue();
    if (issue) showNotice(issue);
    else if (state.selected.includes(method) && state.errors.has(method) && analysisMethodAvailable(p.kind,method,p.context)) queue.current!.retry(true,[method]);
  }
  const methodLabel = (method: string) => options.find(option => option.value === method)?.label ?? originals.find(column=>column.key===method)?.label??method;
  const statusLabel = (method: string) => state.states.has(method)?({ queued: '排队中', running: '计算中', ready: '', error: '失败', cancelled: '已取消' }[state.states.get(method)!]):'未输出';
  const interaction=(key:string)=>({'aria-selected':current===key,onPointerEnter:()=>setHover(key),onPointerLeave:()=>setHover(null)});
  const rawTable = professionalColumns?professionalChargeProjection(professionalColumns,state.selected.map(key=>({key,label:methodLabel(key)})),display):comparisonTableProjection(available, { kind: p.kind as ComparisonResult['kind'], methods: state.selected.map(key => ({ key, label: methodLabel(key) })), spin: display.spin, decimals: display.decimals, getBondLength: p.getBondLength });
  const unsortedTable:ScientificTableProjection={...rawTable,columns:rawTable.columns.map(column=>column.unit?{...column,heading:column.heading??(column.key==='length'?'键长':column.label),headerUnit:column.unit==='dimensionless'?undefined:column.unit,label:column.quantityLabel?`${column.heading??column.label} · ${column.quantityLabel}`:column.label}:column)};
  const effectiveSort=sort.column==='identity'||unsortedTable.columns.some(column=>column.key===sort.column)?sort:{...sort,column:'identity'};
  const table=sortAnalysisTable(unsortedTable,effectiveSort,(key,column)=>{
    if(column==='identity')return p.kind==='bond-orders'?bonds.findIndex(row=>row.key===key):professionalColumns?.flatMap(column=>column.atoms).find(row=>row.atomId===key)?.sourceIndex??atoms.find(row=>row.atomId===key)?.sourceIndex;
    if(column==='length'){const row=bonds.find(row=>row.key===key);return row?p.getBondLength?.([row.atomId1,row.atomId2]):undefined;}
    if(professionalColumns){const source=professionalColumns.find(row=>row.key===column),atom=source?.atoms.find(row=>row.atomId===key);return (display.spin||!source?.hasCharge&&source?.hasSpin)?atom?.spinPopulation:atom?.value;}
    const row=p.kind==='charges'?atoms.find(row=>row.atomId===key):bonds.find(row=>row.key===key),cell=row?.values.get(column);
    const source=available.find(result=>result.method===column);
    return p.kind==='charges'&&display.spin&&source?.kind==='charges'&&source.spinAvailable&&cell&&'spinPopulation' in cell?cell.spinPopulation:cell?.value;
  });
  const displayMethods=table.columns.filter(column=>state.selected.includes(column.key)&&(professionalColumns?professionalColumns.some(value=>value.key===column.key):state.results.has(column.key)));
  const renderHeader = (column: ScientificTableColumn) => {
    if (!state.selected.includes(column.key)) return column.label;
    const method = column.key, methodResult = professionalColumns?professionalColumns.find(column=>column.key===method):state.results.get(method);
    const pending = ['error','cancelled','running','queued'].includes(state.states.get(method)??'');
    const status = pending && methodResult ? `${statusLabel(method)}；保留已有值` : !methodResult ? statusLabel(method) : '';
    return <><span className="scientific-table-heading">{column.heading ?? column.label}</span>{p.kind!=='charges'&&<span className="scientific-table-unit">{column.quantityLabel??column.headerUnit}</span>}{status&&<span className="analysis-method-status">{status}</span>}</>;
  };
  const progress=taskProgress?<MultiwfnProgress progress={taskProgress} operationLabel={`Multiwfn · ${methodLabel(taskProgress.identity.operation.split(':')[1])}`} onStop={()=>queue.current!.cancel()}/>:stopping?<p role="status">正在停止…</p>:state.running?<div role="status">正在计算 {methodLabel(state.running)}… <InputSettingsAction onClick={()=>queue.current!.cancel()}>停止</InputSettingsAction></div>:null;
  return <InputSettingsLayout className="analysis-controls analysis-comparison">{feedback}<AnalysisTaskLayout variant="card" methodDetails title={p.kind === 'charges' ? '原子电荷' : '连续键级'} progress={progress} setup={<>
    <div className="analysis-method-chips" role="group" aria-label={`${p.kind}分析方法`}>{[...options,...originals.filter(column=>!/gfn.*xtb|xtb/i.test(column.label)&&!options.some(option=>option.value===column.key)).map(column=>({value:column.key,label:column.label}))].map(option => <button type="button" key={option.value} className="shared-input-action analysis-method-chip" role="checkbox" aria-checked={state.selected.includes(option.value)} disabled={!originals.some(column=>column.key===option.value)&&!analysisMethodAvailable(p.kind,option.value,p.context)||undefined} data-unavailable={!analysisMethodAvailable(p.kind,option.value,p.context)||undefined} onClick={() => chooseMethod(option.value)}><span className="analysis-method-check" aria-hidden="true">{state.selected.includes(option.value) ? '✓' : ''}</span>{option.label}</button>)}</div>
    </>}>
    {state.selected.filter(method => state.errors.has(method)&&!missingAnalysisBackend(state.errors.get(method)!)).map(method => <DismissibleNotice role="alert" className="postprocess-warning" key={method}>{methodLabel(method)}：{state.errors.get(method)} <InputSettingsAction disabled={!!state.running} onClick={()=>retryMethod(method)}>重试</InputSettingsAction></DismissibleNotice>)}
    {p.kind==='charges'&&p.sourceContext&&!state.selected.length&&<p className="postprocess-note">当前帧未输出电荷或自旋值。</p>}
    {originals.some(column=>state.results.has(column.key))&&<InputSettingsCheckbox label="核对来源打印值" checked={reviewPrinted} onChange={setReviewPrinted}/>}
    {state.selected.length > 0 && <>
      <AnalysisTaskSection title="数值结果">
      {table.rows.length>0?<ScientificDataTable hideTitle exportFileName={`Ester-Studio-${p.kind}-comparison.txt`} title={p.kind==='charges'?'原子电荷':'连续键级'} projection={table} sorting={{value:effectiveSort.column,direction:sort.direction,options:[{value:'identity',label:p.kind==='charges'?'原子编号':'原子对编号'},...table.columns.filter(column=>column.key!=='target').map(column=>({value:column.key,label:column.heading??column.label}))],onChange:(column,direction)=>setSort({column,direction})}} selectionScope={JSON.stringify([projectUiSourceIdentity(p),sourceIdentity])} onRowActivate={row=>setCurrent(row.key)} onClearActive={()=>{setCurrent(null);setHover(null);}} activeRowKey={current??undefined} format={{decimals:display.decimals??2,onDecimalsChange:decimals=>setDisplay({...display,decimals}),ariaLabel:p.kind==='charges'?'原子电荷':'连续键级'}} rowBindings={row => interaction(row.key)} renderHeader={renderHeader} rowAction={{kind:'pin',label:row=>`${pinned.includes(row.key)?'取消固定':'固定'} ${row.cells[0]}`,active:row=>pinned.includes(row.key),onActivate:row=>setPinned(value=>toggleAnalysisRow(value,row.key))}}/>:<p className="postprocess-note">{state.running?'正在准备分析结果。':p.sourceContext?'当前帧未输出所选物理量。':'尚无已完成结果。'}</p>}
      </AnalysisTaskSection>
      {(result||activeColumn) && <><p className="postprocess-note">{p.kind === 'charges' ? table.columns.find(column => column.key === (professional?.activeMethod??result?.method))?.quantityLabel : '连续键级 · 任一方法 > 0.05'}</p>
        {result?.kind==='charges'&&result.method==='bader'&&<details><summary>Bader 计算参数</summary><p>格距 {result.bader.grid.spacingBohr.join(' × ')} bohr · 外扩 {result.bader.grid.paddingBohr} bohr · {result.bader.integrationMethod} · 线程 {result.bader.grid.threads}{result.resources&&` · 内存预算 ${formatAnalysisValue(result.resources.memoryBudgetBytes/1024**3,2)} GiB`}</p></details>}
        {available.flatMap(value => value.warnings.map((warning, index) => <p className="postprocess-warning" key={`${value.method}-${index}`}>{methodLabel(value.method)}：{warning}</p>))}
        <AnalysisStyleControls hidePrecisionControl methodControl={displayMethods.length>1?<InputSettingsField label="着色依据"><select aria-label="着色依据" value={professional?.activeMethod??result?.method??''} onChange={event=>setActiveMethod(event.target.value)}>{displayMethods.map(column=><option key={column.key} value={column.key}>{methodLabel(column.key)}</option>)}</select></InputSettingsField>:undefined} result={professionalColumns?{kind:'charges',spinAvailable:professionalColumns.some(column=>column.hasCharge&&column.hasSpin),atoms:(activeColumn?.atoms??[]).map(row=>({...row,value:row.value??Number.NaN}))}:result!} display={display} onChange={setDisplay}/></>}
    </>}
    {p.kind === 'bond-orders' && <button type="button" className="shared-input-action" data-unavailable="true" title="连续键级到离散拓扑的阈值尚未批准" onClick={() => showNotice('离散成键阈值尚未确定。')}>按键级判断成键 · 待定</button>}
  </AnalysisTaskLayout></InputSettingsLayout>;
}

function AnalysisControlsInner(p: AnalysisControlsProps) {
  return p.kind === 'composition' ? SingleAnalysisControls(p) : MultiAnalysisControls(p);
}

export default function AnalysisControls(p: Parameters<typeof AnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['AnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><AnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:AnalysisControlsInner(p);
}
