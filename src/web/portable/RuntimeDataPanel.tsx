import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PortableToolsRequest } from '../../modeling/contracts';
import { RuntimeDataModel, formatStorageBytes, portableRecord, previewExpired, previewSummary, type PortablePanelRequest } from './runtime-data-state';
import './runtime-data-panel.css';
import DialogShell from '../DialogShell';

export interface RuntimeDataPanelProps {
  request: PortablePanelRequest;
  onClose(): void;
  /** An active native session prevents importing preferences and deleting caches. */
  disabled?: boolean;
  capabilities?: { runtimeCheck?: boolean; diagnosticsExport?: boolean };
}
const locations = [['profile', '偏好目录'], ['cache', '缓存目录'], ['temp', '本次临时目录'], ['logs', '日志目录']] as const;
function scalar(value: unknown, fallback = '未确认'): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback; }
function backendLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!portableRecord(value)) return '未确认';
  const name = ['name', 'version', 'blas', 'provider'].flatMap(key => typeof value[key] === 'string' ? [String(value[key])] : []).join(' · ');
  return name ? `${name}${value.verified === false ? '（来源未核）' : ''}` : '尚未返回后端名称';
}
function DiagnosticDetails({ value }: { value: Record<string, unknown> }) {
  const fields = [['version', '版本'], ['mode', '运行模式'], ['writable', '目录可写'], ['directoryIdentityVerified', '目录身份已核对'], ['nativeSmokePerformed', '本次报告启动原生检查'], ['customerContentIncluded', '包含模型或客户内容'], ['checkedAt', '手动检查时间'], ['passed', '原生检查通过'], ['operation', '检查内容'], ['engine', '引擎'], ['engineVersion', '引擎版本'], ['protocolValidated', '回执校验'], ['directChildClosed', '自有检查进程已关闭'], ['elapsedMs', '耗时（毫秒）'], ['completeScientificValidation', '完整科学验收']] as const;
  return <div className="runtime-data-diagnostic"><dl>{fields.filter(([key]) => key in value).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{typeof value[key] === 'boolean' ? value[key] ? '是' : '否' : scalar(value[key])}</dd></div>)}</dl>
    {Array.isArray(value.limitations) && <ul>{value.limitations.filter((item): item is string => typeof item === 'string').map((item, index) => <li key={index}>{item}</li>)}</ul>}
    {Array.isArray(value.checks) && <ul>{value.checks.filter(portableRecord).map((check, index) => <li key={index}>{scalar(check.name, '诊断项')}：{scalar(check.status)}{typeof check.message === 'string' ? ` · ${check.message}` : ''}</li>)}</ul>}
    {portableRecord(value.error) && <DismissibleNotice role="alert">{scalar(value.error.code, '原生检查失败')}：{scalar(value.error.message, '请查看轻诊断')}</DismissibleNotice>}
    {portableRecord(value.lastNativeCheck) && <section aria-label="最近手动原生检查"><h4>最近一次手动原生检查</h4><DiagnosticDetails value={value.lastNativeCheck} /></section>}
  </div>;
}
export default function RuntimeDataPanel({ request, onClose, disabled = false, capabilities = {} }: RuntimeDataPanelProps) {
  const latestRequest = useRef(request); latestRequest.current = request;
  const [model] = useState(() => new RuntimeDataModel(value => latestRequest.current(value)));
  model.setDisabled(disabled);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { model.activate(); void model.run({ action: 'info' }); return () => model.dispose(); }, [model]);
  useEffect(() => { if (!state.preview) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [state.preview]);
  const busy = state.phase === 'loading' || state.phase === 'applying', applying = state.phase === 'applying';
  const maintenanceDisabled = disabled || state.info?.writable === false;
  const run = (value: PortableToolsRequest) => { void model.run(value); };
  const info = state.info, paths = portableRecord(info?.paths) ? info.paths : {}, writable = portableRecord(info?.writableLocations) ? info.writableLocations : {}, usage = portableRecord(info?.usage) ? info.usage : {};
  const close = () => { if (applying) return; model.dispose(); onClose(); };
  return <DialogShell className="runtime-data-panel" backdropClassName="runtime-data-backdrop" aria-label="运行数据管理" aria-busy={busy} onCancel={()=>{if(state.phase==='preview')model.cancelPreview();else if(!applying)close();}}>
    <header><h2>运行数据</h2><button type="button" aria-label="关闭运行数据面板" disabled={applying} onClick={close}>×</button></header>
    <div className="runtime-data-scroll">
      <section aria-label="便携运行状态"><div className="runtime-data-heading"><h3>本次运行</h3><button type="button" disabled={busy} onClick={() => run({ action: 'info' })}>刷新状态</button></div>
        <dl className="runtime-data-facts"><div><dt>版本</dt><dd>{scalar(info?.version)}</dd></div><div><dt>模式</dt><dd>{info?.mode === 'portable' ? '完整便携' : scalar(info?.mode)}</dd></div><div><dt>包记录后端</dt><dd>{backendLabel(info?.backend)}</dd></div><div><dt>保存状态</dt><dd>{info ? info.writable === true ? '可写' : '不可写' : '正在读取'}</dd></div></dl>
        <p className="runtime-data-caption">{scalar(paths.root, '运行目录待读取')}</p>
        <table><thead><tr><th>目录</th><th>位置与状态</th><th>自有占用</th><th>操作</th></tr></thead><tbody>{locations.map(([location, label]) => {
          const measured = portableRecord(usage[location]) ? usage[location] : {}, canWrite = typeof writable[location] === 'boolean' ? writable[location] : info?.writable;
          return <tr key={location}><th scope="row">{label}</th><td><code>{scalar(paths[location], '待读取')}</code><span>{canWrite === true ? '可写' : canWrite === false ? '不可写' : '待确认'}</span></td><td>{formatStorageBytes(measured.bytes)}{typeof measured.files === 'number' && <small>{measured.files} 文件</small>}{measured.complete === false && <small>部分统计</small>}</td><td><button type="button" aria-label={`打开${label}`} disabled={busy || typeof paths[location] !== 'string'} onClick={() => run({ action: 'open-location', location })}>打开</button></td></tr>;
        })}</tbody></table>
        <p className="runtime-data-caption">占用为自有文件逻辑量；临时目录属于本次运行。{portableRecord(usage.data) && <> 数据目录总量 {formatStorageBytes(usage.data.bytes)}{typeof usage.data.files === 'number' ? ` · ${usage.data.files} 文件` : ''}{usage.data.complete === false ? '（部分统计）' : ''}。</>}</p>
      </section>
      <section aria-label="布局与显示偏好"><h3>布局与显示偏好</h3><p>导入前先核对来源和变化，确认后备份目标原偏好并保存。导入更新已保存的默认偏好，已打开模型与未保存工作继续保留。</p><div className="runtime-data-actions"><button type="button" disabled={busy} onClick={() => run({ action: 'preferences-export' })}>导出偏好</button><button type="button" disabled={busy || maintenanceDisabled} onClick={() => run({ action: 'import-preview' })}>选择文件并预览导入</button></div></section>
      <section aria-label="轻诊断"><h3>轻诊断</h3><p>检查便携目录和运行信息，报告不包含模型或客户内容。</p><div className="runtime-data-actions"><button type="button" disabled={busy} onClick={() => run({ action: 'diagnostics' })}>运行轻诊断</button>{capabilities.runtimeCheck && <button type="button" disabled={busy || disabled} onClick={() => run({ action: 'runtime-check' })}>检查原生运行时</button>}{capabilities.diagnosticsExport && <button type="button" disabled={busy} onClick={() => run({ action: 'diagnostics-export' })}>导出脱敏报告</button>}</div>{state.diagnostics && <DiagnosticDetails value={state.diagnostics} />}</section>
      <section aria-label="自有缓存维护"><h3>自有缓存</h3><p>仅处理服务确认无运行依赖的自有缓存。先预览清单总量，再确认。</p><button type="button" disabled={busy || maintenanceDisabled} onClick={() => run({ action: 'cache-preview' })}>预览可清理缓存</button></section>
      {disabled && <p className="runtime-data-notice" role="status">任务运行中：偏好导入、缓存清理与原生检查暂不可用。</p>}
      {info?.writable === false && <p className="runtime-data-notice" role="status">运行目录不可写。本次调整不会自动保存；检查目录权限后刷新状态。</p>}
      {state.preview && state.previewKind && <section className="runtime-data-confirmation" aria-label={state.previewKind === 'cache' ? '缓存清理确认' : '偏好导入确认'}><h3>{state.previewKind === 'cache' ? '确认清理自有缓存' : '确认导入偏好'}</h3><p>{previewSummary(state.preview, state.previewKind)}</p>
        {state.previewKind === 'cache' && <><p>预览文件字节为逻辑量，不代表实际磁盘空闲增量。</p>{state.preview.clearsBrowserCache === true && <p>还将清理当前软件浏览器缓存（估算 {formatStorageBytes(state.preview.browserCacheBytes)}）。</p>}</>}
        {state.previewKind === 'preferences' && <p>目标原偏好将先备份；来源文件保持原样。</p>}
        {previewExpired(state.preview, now) && <p role="status">预览已过期，请取消后重新预览。</p>}
        <div className="runtime-data-actions"><button type="button" disabled={maintenanceDisabled || busy || previewExpired(state.preview, now)} onClick={() => void model.confirmPreview()}>{state.previewKind === 'cache' ? '确认清理' : '确认导入并备份'}</button><button type="button" disabled={applying} onClick={() => model.cancelPreview()}>取消</button></div></section>}
      {busy && <p role="status">{applying ? '正在保存维护结果，请等待回执…' : '正在处理…'}{state.phase === 'loading' && ['info', 'diagnostics', 'runtime-check'].includes(state.action) && <button type="button" onClick={() => model.cancelRead()}>停止等待</button>}</p>}
      {state.error && <DismissibleNotice className="runtime-data-error" identity={state.error}><strong>{state.error.message}</strong><p>{state.error.guidance}</p><small>{state.error.code}</small>{state.error.preserved === true && <p>当前数据已保留。</p>}{state.error.backup && <p>恢复备份：<code>{state.error.backup}</code></p>}{state.error.partial && <p>已确认删除 {scalar(state.error.removedFiles, '未核')} 个文件，逻辑量 {formatStorageBytes(state.error.removedBytes)}。</p>}<div className="runtime-data-actions"><button type="button" disabled={busy} onClick={() => run({ action: 'info' })}>刷新状态再核对</button>{state.error.retryable && <button type="button" disabled={busy || maintenanceDisabled} onClick={() => run({ action: state.action.startsWith('import') ? 'import-preview' : state.action.startsWith('cache') ? 'cache-preview' : state.action === 'preferences-export' ? 'preferences-export' : 'diagnostics' })}>重新预览或重试</button>}</div></DismissibleNotice>}
      {state.result && <p className="runtime-data-result" role="status">{state.result}</p>}
    </div>
  </DialogShell>;
}
