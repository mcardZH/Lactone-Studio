import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdvancedInputTemplate, AdvancedFrameOutputPlan } from '../../modeling/application/advanced-frame-output';
import { headerLines } from '../../core/gaussian';
import type { AdvancedOutputBridge, AdvancedOutputSelection } from '../../modeling/advanced/output-contracts';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout, InputSettingsSection } from '../InputSettingsLayout';
import { ScientificDataTable } from '../results/ScientificDataTable';
import type { ScientificTableProjection } from '../results/scientific-table';
import DialogShell from '../DialogShell';
import { advancedOutputDraftKey, advancedOutputPartialLines, assertAdvancedOutputManifest, editAdvancedOutputFrame,
  initialAdvancedFrameOutputDraft, moveAdvancedOutputFrame, prepareAdvancedOutputDraft, reconcileAdvancedFrameOutput, selectAdvancedOutputFrame,
  createAdvancedOutputTokenOwner,
  advancedOutputCandidateLabel,
  type AdvancedFrameOutputCandidate, type AdvancedFrameOutputDraft } from './AdvancedFrameOutputControls-state';

export type { AdvancedFrameOutputCandidate } from './AdvancedFrameOutputControls-state';
export interface AdvancedFrameOutputControlsProps {
  candidates: readonly AdvancedFrameOutputCandidate[];
  /** Read-only snapshot supplied by the existing input owner, never a new scientific default. */
  template?: AdvancedInputTemplate | null;
  bridge: AdvancedOutputBridge | null;
  disabled?: boolean;
  onError(message: string): void;
  compact?: boolean;
}
type SelectedDestination = Extract<AdvancedOutputSelection, { status: 'selected' }>;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
export const templateDescription = (template?: AdvancedInputTemplate | null) => {
  if (!template) return '尚未提供当前 Gaussian / ORCA 输入模板。';
  const request = template.request, settings = request.settings;
  const method = 'customMethod' in settings && settings.method === 'custom' ? settings.customMethod : settings.method;
  const resources = template.engine === 'gaussian' ? headerLines(template.request).flatMap(line => {
    const cores = /^%nprocshared=(\d+)$/.exec(line), memory = /^%mem=(\d+)GB$/.exec(line);
    return cores && Number(cores[1]) > 0 ? [`${cores[1]} 核`] : memory && Number(memory[1]) > 0 ? [`${memory[1]} GB`] : [];
  }) : [Number.isInteger(request.cores) && request.cores >= 1 && request.cores <= 1024 ? `${request.cores} 核` : '',
    Number.isFinite(request.memoryGB) && request.memoryGB > 0 && request.memoryGB <= 1048576 ? `${request.memoryGB} GB` : ''].filter(Boolean);
  return [`${template.engine === 'gaussian' ? 'Gaussian' : 'ORCA'} · ${settings.task} · ${method} / ${settings.basis}`, ...resources].join(' · ');
};

/** Explicit batch preparation only. Frame sources, input drafts, model state and
 * display transforms are never written through this component. */
export default function AdvancedFrameOutputControls(p: AdvancedFrameOutputControlsProps) {
  const [open,setOpen]=useState(false);
  const [draft, setDraft] = useState(initialAdvancedFrameOutputDraft);
  const normalized = reconcileAdvancedFrameOutput(p.candidates, draft);
  const key = advancedOutputDraftKey(p.candidates, normalized), [busy, setBusy] = useState<'choose' | 'write' | null>(null);
  const [prepared, setPrepared] = useState<{ key: string; template: AdvancedInputTemplate | null | undefined; plan: AdvancedFrameOutputPlan | null; errors: readonly string[] } | null>(null);
  const [selected, setSelected] = useState<{ key: string; template: AdvancedInputTemplate | null | undefined; destination: SelectedDestination } | null>(null);
  const [messages, setMessages] = useState<readonly string[]>([]);
  const latest = useRef({ key, template: p.template, props: p }); latest.current = { key, template: p.template, props: p };
  const alive = useRef(true), epoch = useRef(0), pendingWrite = useRef(false), operation = useRef<'choose' | 'write' | null>(null);
  const selectedRef = useRef<typeof selected>(null), tokenOwnerRef = useRef<ReturnType<typeof createAdvancedOutputTokenOwner> | null>(null);
  if (!tokenOwnerRef.current) tokenOwnerRef.current = createAdvancedOutputTokenOwner(message => {
    if (alive.current) setMessages(previous => [...previous, message]); latest.current.props.onError(message);
  });
  const tokenOwner = tokenOwnerRef.current;
  function discardSelection() {
    const previous = selectedRef.current; selectedRef.current = null; if (alive.current) setSelected(null);
    if (previous) void tokenOwner.release(previous.destination.token);
  }
  useEffect(() => { alive.current = true; setSelected(null); return () => {
    alive.current = false; epoch.current++; discardSelection(); void tokenOwner.releaseAll();
  }; }, []);
  useEffect(() => { if (normalized !== draft) setDraft(normalized); }, [normalized, draft]);
  useEffect(() => { discardSelection(); if (!pendingWrite.current) { epoch.current++; operation.current = null; setBusy(null); } }, [key, p.template, p.bridge]);
  const plan = prepared?.key === key && prepared.template === p.template ? prepared.plan : null;
  const errors = prepared?.key === key && prepared.template === p.template ? prepared.errors : [];
  const destination = selected?.key === key && selected.template === p.template ? selected.destination : null;
  useEffect(() => { if (!destination) return; const timer = setTimeout(() => { discardSelection(); setMessages(['目录确认已过期，请重新选择。']); }, Math.max(0, destination.expiresAt - Date.now()));
    return () => clearTimeout(timer); }, [destination]);
  const locked = p.disabled || busy !== null;
  const change = (value: AdvancedFrameOutputDraft) => { discardSelection(); setDraft(value); setMessages([]); };
  const ordered = [...normalized.selectedIds.flatMap(id => p.candidates.find(candidate => candidate.id === id) ?? []),
    ...p.candidates.filter(candidate => !normalized.selectedIds.includes(candidate.id))];
  const preflightTable = useMemo<ScientificTableProjection>(() => ({ columns: [
    { key: 'order', label: '输出顺序' }, { key: 'source', label: '来源帧' }, { key: 'files', label: '文件清单' }, { key: 'status', label: '预检结果' },
  ], rows: (plan?.items ?? []).map((item, index) => ({ key: `preflight-${item.order}`, cells: [String(item.order),
    (() => { const sourceIndex = p.candidates.findIndex(candidate => candidate.id === normalized.selectedIds[index]); return sourceIndex < 0 ? '' : advancedOutputCandidateLabel(p.candidates[sourceIndex], sourceIndex); })(), item.fileNames.join('；'),
    item.errors.length ? item.errors.join('；') : item.warnings.length ? item.warnings.join('；') : '通过'] })) }), [plan, p.candidates, normalized.selectedIds]);
  const destinationTable: ScientificTableProjection = { columns: [{ key: 'file', label: '待写入文件' }, { key: 'bytes', label: 'UTF-8字节数 / B' }],
    rows: (destination?.manifest.files ?? []).map(file => ({ key: file.name, cells: [file.name, String(file.bytes)] })) };
  function preflight() {
    discardSelection(); const result = prepareAdvancedOutputDraft(p.candidates, normalized, p.template); setPrepared({ key, template: p.template, ...result }); setMessages([]);
  }
  const current = (token: number, snapshotKey: string, template: typeof p.template) => alive.current && epoch.current === token
    && latest.current.key === snapshotKey && latest.current.template === template;
  async function choose() {
    if (!plan?.ready || !p.bridge || locked || operation.current) return;
    const token = ++epoch.current, snapshotKey = key, template = p.template, bridge = p.bridge; operation.current = 'choose'; setBusy('choose'); discardSelection(); setMessages([]);
    try {
      if (!await tokenOwner.releaseAll()) throw new Error('此前的目录确认尚未释放，请先重试释放。');
      if (!current(token, snapshotKey, template)) return;
      const result = await bridge.chooseAdvancedOutput({ directoryName: normalized.directoryName, files: plan.files });
      if (result.status === 'selected') tokenOwner.retain(result.token, bridge);
      if (!current(token, snapshotKey, template)) { if (result.status === 'selected') await tokenOwner.release(result.token); return; }
      if (result.status === 'cancelled') { setMessages(['已取消目录选择，未写入文件。']); return; }
      if (result.expiresAt <= Date.now()) { await tokenOwner.release(result.token); if (current(token, snapshotKey, template)) setMessages(previous => [...previous, '目录确认已过期，请重新选择。']); return; }
      try { assertAdvancedOutputManifest(plan, result.manifest); } catch (error) { await tokenOwner.release(result.token); throw error; }
      const accepted = { key: snapshotKey, template, destination: result }; selectedRef.current = accepted; setSelected(accepted);
    } catch (error) { if (current(token, snapshotKey, template)) { const message = reason(error); setMessages(previous => [...previous, message]); p.onError(message); } }
    finally { if (alive.current && epoch.current === token) { operation.current = null; setBusy(null); } }
  }
  async function write() {
    if (!destination || !plan?.ready || !p.bridge || locked || operation.current || pendingWrite.current) return;
    if (!tokenOwner.consume(destination.token)) { discardSelection(); setMessages(['此目录确认已失效或正在释放，请重新选择。']); return; }
    selectedRef.current = null;
    const request = destination, token = ++epoch.current; operation.current = 'write'; pendingWrite.current = true; setSelected(null); setBusy('write'); setMessages([]);
    try {
      const result = await p.bridge.writeAdvancedOutput(request.token);
      if (!alive.current || epoch.current !== token) return;
      if (result.status === 'saved') { const report = [`已写入：${result.directory}`, ...result.manifest.files.map(file => `${file.name} · ${file.bytes} B`), `总计 ${result.manifest.totalBytes} B`];
        try { assertAdvancedOutputManifest(plan, result.manifest); } catch (error) { const message = reason(error); setMessages([message, ...report]); p.onError(message); return; } setMessages(report); }
      else { const message = `${result.error.code}：${result.error.message}`; setMessages([message, ...advancedOutputPartialLines(result.error.advancedOutput)]); p.onError(message); }
    } catch (error) { if (alive.current && epoch.current === token) { const message = reason(error), partial = error && typeof error === 'object' && 'advancedOutput' in error
      ? error.advancedOutput as Parameters<typeof advancedOutputPartialLines>[0] : undefined; setMessages([message, ...advancedOutputPartialLines(partial)]); p.onError(message); } }
    finally { pendingWrite.current = false; if (alive.current && epoch.current === token) { operation.current = null; setBusy(null); } }
  }
  const content=<section aria-label="选帧批量输出" data-testid="advanced-frame-output-controls"><InputSettingsLayout>
    <InputSettingsSection level="subcard" title="输出内容"><InputSettingsRow><InputSettingsField label="类型"><select aria-label="高级帧输出类型" value={normalized.mode} disabled={locked} onChange={event => change({ ...normalized, mode: event.currentTarget.value as AdvancedFrameOutputDraft['mode'] })}>
      <option value="trajectory">科学轨迹</option><option value="inputs">批量输入</option></select></InputSettingsField>
      {normalized.mode === 'trajectory' && <><InputSettingsField label="格式"><select aria-label="科学轨迹格式" value={normalized.format} disabled={locked} onChange={event => change({ ...normalized, format: event.currentTarget.value as 'xyz' | 'extxyz' })}><option value="xyz">XYZ</option><option value="extxyz">extXYZ</option></select></InputSettingsField>
      <InputSettingsField label="轨迹名称"><input aria-label="科学轨迹名称" value={normalized.stem} disabled={locked} onChange={event => change({ ...normalized, stem: event.currentTarget.value })}/></InputSettingsField></>}
      <InputSettingsField label="新目录名称"><input aria-label="批量输出新目录名称" value={normalized.directoryName} disabled={locked} onChange={event => change({ ...normalized, directoryName: event.currentTarget.value })}/></InputSettingsField></InputSettingsRow>
      {normalized.mode === 'inputs' && <output role={p.template ? undefined : 'status'}>{templateDescription(p.template)}</output>}
    </InputSettingsSection>
    <InputSettingsSection level="subcard" title="选帧与顺序"><output>已选 {normalized.selectedIds.length} 项</output>
      {!ordered.length && <p role="status">没有可用的完整帧。</p>}
      {ordered.map(candidate => { const row = normalized.rows[candidate.id], index = normalized.selectedIds.indexOf(candidate.id), checked = index >= 0,
        label = advancedOutputCandidateLabel(candidate, p.candidates.findIndex(value => value.id === candidate.id));
        return <div key={candidate.id}><InputSettingsRow><InputSettingsCheckbox label={`${checked ? `输出 ${index + 1} · ` : ''}${label}`} checked={checked} disabled={locked}
          ariaLabel={`输出${label}`} onChange={value => change(selectAdvancedOutputFrame(normalized, candidate.id, value))}/>
          {checked && <><InputSettingsAction disabled={locked || index === 0} ariaLabel={`上移 ${label}`} onClick={() => change(moveAdvancedOutputFrame(normalized, candidate.id, -1))}>上移</InputSettingsAction>
          <InputSettingsAction disabled={locked || index === normalized.selectedIds.length - 1} ariaLabel={`下移 ${label}`} onClick={() => change(moveAdvancedOutputFrame(normalized, candidate.id, 1))}>下移</InputSettingsAction></>}</InputSettingsRow>
          {checked && normalized.mode === 'inputs' && <InputSettingsRow><InputSettingsField label="文件名称"><input aria-label={`${label} 文件名称`} value={row.stem} disabled={locked} onChange={event => change(editAdvancedOutputFrame(normalized, candidate.id, { stem: event.currentTarget.value }))}/></InputSettingsField>
            <InputSettingsField label="电荷"><NumericInput aria-label={`${label} 电荷`} stepper step={1} value={row.charge} disabled={locked} onChange={event => change(editAdvancedOutputFrame(normalized, candidate.id, { charge: event.currentTarget.value }))}/></InputSettingsField>
            <InputSettingsField label="多重度"><NumericInput aria-label={`${label} 多重度`} stepper min={1} step={1} value={row.multiplicity} disabled={locked} onChange={event => change(editAdvancedOutputFrame(normalized, candidate.id, { multiplicity: event.currentTarget.value }))}/></InputSettingsField>
            <InputSettingsCheckbox label="确认本帧名称、电荷与多重度" ariaLabel={`${label} 确认本帧名称、电荷与多重度`} checked={row.confirmed} disabled={locked} onChange={confirmed => change(editAdvancedOutputFrame(normalized, candidate.id, { confirmed }))}/></InputSettingsRow>}
        </div>; })}
    </InputSettingsSection>
    <InputSettingsSection level="subcard" title="整批预检"><InputSettingsRow><InputSettingsAction disabled={locked || !normalized.selectedIds.length} onClick={preflight}>预检全部已选帧</InputSettingsAction>
      <InputSettingsAction disabled={locked || !plan?.ready || !p.bridge} onClick={() => { void choose(); }}>选择新目录</InputSettingsAction></InputSettingsRow>
      {prepared && !plan && !errors.length && <p role="status">输出条件已变化，请重新预检。</p>}
      {preflightTable.rows.length > 0 && <ScientificDataTable projection={preflightTable} selectionScope={prepared?.key}/>}
      {errors.map((message, index) => <DismissibleNotice role="alert" key={index}>{message}</DismissibleNotice>)}
      {plan?.ready && <output>预检通过 · {plan.files.length} 个文件（含来源清单）</output>}
    </InputSettingsSection>
    {destination && <InputSettingsSection level="subcard" title="确认写入"><p>新目录：{destination.directory}</p><ScientificDataTable projection={destinationTable} selectionScope={destination.token}/>
      <output>总计 {destination.manifest.totalBytes} B</output><InputSettingsRow><InputSettingsAction variant="primary" disabled={locked} onClick={() => { void write(); }}>确认写入新目录</InputSettingsAction>
        <InputSettingsAction disabled={locked} onClick={() => { epoch.current++; discardSelection(); setMessages(['已取消确认，未写入文件。']); }}>取消</InputSettingsAction></InputSettingsRow>
    </InputSettingsSection>}
    {busy && <output role="status">{busy === 'choose' ? '正在选择新目录…' : '正在写入新目录…'}</output>}
    {tokenOwner.hasFailures() && <InputSettingsAction disabled={locked} onClick={() => { void tokenOwner.retryFailed().then(released => { if (released && alive.current) setMessages(['已释放此前目录确认，可重新选择。']); }); }}>重试释放目录确认</InputSettingsAction>}
    {messages.length > 0 && <InputSettingsSection level="subcard" title="输出结果">{messages.map((line, index) => <p role="status" key={index}>{line}</p>)}</InputSettingsSection>}
  </InputSettingsLayout></section>;
  if(!p.compact)return content;
  const close=()=>{if(busy)return;discardSelection();setOpen(false);};
  return <><InputSettingsAction disabled={p.disabled||!p.candidates.length} onClick={()=>setOpen(true)}>批量输出</InputSettingsAction>{open&&<DialogShell aria-label="批量输出" className="advanced-output-dialog" onCancel={close}><header className="shared-input-card-header"><h3>批量输出</h3><InputSettingsAction disabled={!!busy} onClick={close}>关闭</InputSettingsAction></header>{content}</DialogShell>}</>;
}
