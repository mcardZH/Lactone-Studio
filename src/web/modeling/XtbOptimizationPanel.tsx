import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useRef, useState } from 'react';
import type { XtbMetadata, XtbOptimizationScope } from '../../modeling/xtb/contracts';
import { XTB_INTERNAL_CONSTRAINT_POLICY } from '../../modeling/xtb/accept-result';
import './xtb-optimization.css';

export type XtbPanelMethod = 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff';
export interface XtbPanelOptions {
  method: XtbPanelMethod;
  charge: number;
  /** GFN-FF retains this form value but does not consume spin. */
  multiplicity: number;
  rebuildBonds: boolean;
  threads?: number;
  maxSteps?: number;
  maxSccIterations?:number;
  scope?:XtbOptimizationScope;
}
export interface XtbOptimizationPanelProps {
  documentKey: string;
  initialCharge: number | null;
  initialMultiplicity: number | null;
  electronicState?: { charge: number; multiplicity: number };
  onElectronicStateChange?(value: { charge: number; multiplicity: number }): void;
  physicalCoreCount?:number|null;
  gfn2Threads?:number;
  onGfn2ThreadsChange?(threads:number):void;
  optimizationOptions?: Pick<XtbPanelOptions, 'method' | 'rebuildBonds'|'scope'|'maxSteps'|'maxSccIterations'>;
  onOptimizationOptionsChange?(value: Pick<XtbPanelOptions, 'method' | 'rebuildBonds'> & {scope:XtbOptimizationScope;maxSteps?:number;maxSccIterations?:number}): void;
  selectionCount?:number;
  atomCount?:number;
  spaceDefault?: boolean;
  onSetSpaceDefault?(): void;
  /** A GFN2 bond-assistance action shares the fields even when the optimizer is GFN-FF. */
  requireMultiplicity?: boolean;
  /** Periodic image-resolved bond-order analysis is a separate capability. */
  bondRebuildAvailable?: boolean;
  /** The owner also disables this panel when its document/page is inactive. */
  disabled?: boolean;
  running?: boolean;
  status?: string;
  error?: string;
  metadata?: XtbMetadata | null;
  /** Current atom numbers/labels; retained stable IDs are the fallback. */
  atomLabels?: Readonly<Record<string, string | number>>;
  onOptimize(options: XtbPanelOptions): void | Promise<void>;
  onStop(): void | Promise<void>;
}
interface Draft { documentKey: string; method: XtbPanelMethod; charge: number; multiplicity: number; rebuildBonds: boolean;scope:XtbOptimizationScope;threads?:number;maxSteps?:number;maxSccIterations?:number }
const METHODS: { value: XtbPanelMethod; label: string }[] = [
  { value: 'gfn0', label: 'GFN0-xTB' }, { value: 'gfn1', label: 'GFN1-xTB' },
  { value: 'gfn2', label: 'GFN2-xTB' }, { value: 'gfnff', label: 'GFN-FF' },
];

/** Same-document input edits remain local; a new document resets every option. */
export function xtbPanelDocumentDraft(previous: Draft | null, documentKey: string, initialCharge: number | null, initialMultiplicity: number | null): Draft {
  return previous?.documentKey === documentKey ? previous : {
    documentKey, method: 'gfn2', charge: initialCharge ?? Number.NaN,
    multiplicity: initialMultiplicity ?? Number.NaN, rebuildBonds: true,scope:'all',maxSteps:500,maxSccIterations:250,
  };
}
export function xtbPanelSubmission(draft: Pick<Draft, 'method' | 'charge' | 'multiplicity' | 'rebuildBonds'> & {scope?:XtbOptimizationScope;threads?:number;maxSteps?:number;maxSccIterations?:number}): XtbPanelOptions | null {
  if (!Number.isSafeInteger(draft.charge) || draft.method !== 'gfnff' && (!Number.isSafeInteger(draft.multiplicity) || draft.multiplicity < 1)) return null;
  const maxSccIterations=draft.maxSccIterations??250;if(!Number.isSafeInteger(maxSccIterations)||maxSccIterations<1)return null;
  const maxSteps=draft.maxSteps??500;if(!Number.isSafeInteger(maxSteps)||maxSteps<1)return null;
  const scope=draft.scope??'all';if(!['all','selection','unselected'].includes(scope))return null;
  return { method:draft.method, charge:draft.charge, multiplicity:draft.multiplicity, rebuildBonds:draft.method !== 'gfnff' && draft.rebuildBonds,scope,maxSteps,maxSccIterations };
}

export default function XtbOptimizationPanel({ documentKey, initialCharge, initialMultiplicity, electronicState, onElectronicStateChange, optimizationOptions, onOptimizationOptionsChange, selectionCount,atomCount,spaceDefault=false, onSetSpaceDefault, requireMultiplicity=false, bondRebuildAvailable=true, disabled=false, running=false, status='', error='', metadata, atomLabels, onOptimize, onStop }: XtbOptimizationPanelProps) {
  const [saved, setSaved] = useState<Draft>(() => xtbPanelDocumentDraft(null, documentKey, initialCharge, initialMultiplicity));
  const documentDraft=xtbPanelDocumentDraft(saved, documentKey, initialCharge, initialMultiplicity);
  const draft = { ...documentDraft, ...optimizationOptions, ...electronicState,scope:optimizationOptions?.scope??documentDraft.scope,
    maxSteps:Number.isNaN(documentDraft.maxSteps)?documentDraft.maxSteps:optimizationOptions?.maxSteps??documentDraft.maxSteps,
    maxSccIterations:Number.isNaN(documentDraft.maxSccIterations)?documentDraft.maxSccIterations:optimizationOptions?.maxSccIterations??documentDraft.maxSccIterations };
  // Adjust during render, so no old-document frame can submit before an effect.
  if (saved.documentKey !== documentKey) setSaved(draft);
  const root = useRef<HTMLElement>(null);
  const inactive = () => disabled || Boolean(root.current?.closest('[hidden], [aria-hidden="true"]'));
  const update = (patch: Partial<Draft>) => { if (!inactive() && !running) { const next={ ...draft, ...patch };setSaved(next);if('charge' in patch||'multiplicity' in patch)onElectronicStateChange?.({charge:next.charge,multiplicity:next.multiplicity});if((next.maxSteps===undefined||Number.isSafeInteger(next.maxSteps)&&next.maxSteps>0)&&(next.maxSccIterations===undefined||Number.isSafeInteger(next.maxSccIterations)&&next.maxSccIterations>0)&&('method' in patch||'rebuildBonds' in patch||'scope' in patch||'maxSteps' in patch||'maxSccIterations' in patch))onOptimizationOptionsChange?.({method:next.method,rebuildBonds:next.rebuildBonds,scope:next.scope,maxSteps:next.maxSteps,maxSccIterations:next.maxSccIterations}); } };
  const options = xtbPanelSubmission({...draft,rebuildBonds:bondRebuildAvailable&&draft.rebuildBonds});
  const emptyRange=draft.scope==='selection'&&selectionCount===0||draft.scope==='unselected'&&atomCount!==undefined&&selectionCount===atomCount;
  const shown = (value: number) => Number.isFinite(value) ? value : '';
  const edited = (value: string) => value.trim() ? Number(value) : Number.NaN;
  const constraintNumber = (value: number) => Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '未知';
  return <section ref={root} className="xtb-optimization-panel" aria-label="xTB预优化" data-testid="xtb-optimization-panel" data-running={running}>
    <header className="optimization-panel-header"><strong>xTB预优化</strong>{onSetSpaceDefault&&<button type="button" className="model-space-default" aria-label="xTB设为空格默认" aria-pressed={spaceDefault} disabled={disabled||running} onClick={()=>{if(!inactive()&&!running)onSetSpaceDefault();}}>{spaceDefault?'空格默认':'设为空格默认'}</button>}</header>
    <div className="optimization-primary-row">
      <label className="xtb-optimization-method"><span>方法</span><select aria-label="xTB预优化方法" value={draft.method} disabled={disabled || running} onChange={event => {
        const method = event.target.value as XtbPanelMethod;
        if (METHODS.some(entry => entry.value === method)) update({ method });
      }}>{METHODS.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}</select></label>
      <label><span>范围</span><select aria-label="xTB优化范围" value={draft.scope} disabled={disabled||running} onChange={event=>{const scope=event.target.value as XtbOptimizationScope;if(['all','selection','unselected'].includes(scope))update({scope});}}><option value="all">全体</option><option value="selection" disabled={selectionCount===0}>选区</option><option value="unselected" disabled={atomCount!==undefined&&selectionCount===atomCount}>非选区</option></select></label>
      <button type="button" disabled={disabled || running || !options || emptyRange} onClick={() => { if (!inactive() && !running && options&&!emptyRange) void onOptimize(options); }}>优化</button>
      <button type="button" className="optimization-stop" disabled={disabled || !running} onClick={() => { if (!inactive() && running) void onStop(); }}>停止</button>
    </div>
    <div className="xtb-electronic-fields">
      <label><span>电荷</span><NumericInput aria-label="xTB预优化电荷" stepper step="1" value={shown(draft.charge)} disabled={disabled || running} onChange={event => update({ charge: edited(event.target.value) })} /></label>
      <label title={requireMultiplicity ? 'GFN2辅助成键也使用此多重度' : draft.method === 'gfnff' ? 'GFN-FF不使用自旋多重度；保留输入值' : undefined}><span>多重度</span><NumericInput aria-label="xTB预优化多重度" stepper step="1" min="1" value={shown(draft.multiplicity)} disabled={disabled || running || draft.method === 'gfnff'&&!requireMultiplicity} onChange={event => update({ multiplicity: edited(event.target.value) })} /></label>
    </div>
    <div className="xtb-optimization-actions">
      {draft.method !== 'gfnff' && <label className="xtb-rebuild-bonds" title={!bondRebuildAvailable?'周期优化后成键更新本轮暂不提供；保留现有连接':draft.method==='gfn2'?'使用本次GFN2-xTB输出的MBO更新成键':'使用本次优化坐标按经验参数更新成键'}><input type="checkbox" aria-label={draft.method==='gfn2'?'优化后按 MBO 更新成键':'优化后按经验更新成键'} checked={bondRebuildAvailable&&draft.rebuildBonds} disabled={disabled || running || !bondRebuildAvailable} onChange={event => {if(bondRebuildAvailable)update({ rebuildBonds: event.target.checked });}} /><span>{draft.method==='gfn2'?'优化后按 MBO 更新成键':'优化后按经验更新成键'}</span></label>}
      {error ? <DismissibleNotice className="xtb-optimization-error" identity={documentKey}>{error}</DismissibleNotice> : status && <p className="xtb-optimization-status" role="status">{status}</p>}
    </div>
    {!!metadata?.internalConstraints.length && <details className="xtb-constraint-results" data-testid="xtb-constraint-results">
      <summary>内坐标强约束（{metadata.internalConstraints.length}）</summary>
      <p>约束力常数 {XTB_INTERNAL_CONSTRAINT_POLICY.forceConstant} Hartree/Bohr²；接受上限：键长 {XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom} Å，键角/二面角 {XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree}°。</p>
      <div className="xtb-constraint-table-scroll"><table aria-label="xTB内坐标强约束目标与残差"><thead><tr><th scope="col">类型</th><th scope="col">原子</th><th scope="col">目标</th><th scope="col">实际</th><th scope="col">残差</th></tr></thead><tbody>
        {metadata.internalConstraints.map((constraint, index) => {
          const unit = constraint.unit === 'angstrom' ? 'Å' : '°';
          return <tr key={`${constraint.type}:${constraint.atomIds.join(':')}:${index}`}><th scope="row">{constraint.type}</th><td title={constraint.atomIds.join(' – ')}>{constraint.atomIds.map(id => atomLabels?.[id] ?? id).join(' – ')}</td><td>{constraintNumber(constraint.target)} {unit}</td><td>{constraintNumber(constraint.actual)} {unit}</td><td>{constraintNumber(constraint.residual)} {unit}</td></tr>;
        })}
      </tbody></table></div>
    </details>}
  </section>;
}
