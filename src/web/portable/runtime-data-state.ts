import type { PortableToolsRequest, PortableToolsResponse } from '../../modeling/contracts';

export type PortablePanelRequest = (request: PortableToolsRequest) => Promise<PortableToolsResponse>;
export interface RuntimePanelState {
  phase: 'idle' | 'loading' | 'preview' | 'applying';
  action: string;
  info: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  previewKind: 'preferences' | 'cache' | null;
  diagnostics: Record<string, unknown> | null;
  result: string;
  error: { code: string; message: string; guidance: string; retryable: boolean; preserved?: boolean; recoveryRequired?: boolean; backup?: string; partial?: boolean; removedFiles?: number; removedBytes?: number } | null;
}
export const portableRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function formatStorageBytes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未测';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let amount = value / 1024, index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}
export function portableErrorGuidance(code: string): string {
  if (/ENOSPC|DISK_FULL|NO_SPACE|STORAGE_FULL/i.test(code)) return '磁盘空间不足。释放空间后重新预览，再尝试保存。';
  if (/EACCES|EPERM|READ_ONLY|PERMISSION|NOT_WRITABLE/i.test(code)) return '目录不可写或权限受限。检查便携目录的写入权限，再刷新状态后重试。';
  if (/STORAGE_UNAVAILABLE|ENODEV|EIO/i.test(code)) return '存储位置不可用或介质已断开。恢复原磁盘与便携目录后刷新状态，再重新预览。';
  if (/PATH_CHANGED|PATH_REPLACED|LINK|DRIVE|IDENTITY/i.test(code)) return '目录、盘符或链接身份已变化。停止本次维护，恢复原便携目录后重新打开软件。';
  if (/FILESYSTEM|ATOMIC|ENOTSUP/i.test(code)) return '当前文件系统不支持安全保存。请在支持原子保存的可写目录使用便携包。';
  if (/BUSY|RUNNING|NOT_IDLE/i.test(code)) return '存在正在运行的任务。等待任务结束后重新预览，再进行维护。';
  if (/TOKEN|EXPIRED|STALE|CONFLICT/i.test(code)) return '预览已过期或偏好已变化。重新预览并核对后再确认。';
  if (/SCHEMA|INVALID|CORRUPT|FORMAT|SOURCE/i.test(code)) return '来源或格式校验未通过。选择软件导出的有效偏好文件后重新预览。';
  return '操作未完成。保留当前工作，刷新状态并查看轻诊断后重试。';
}
export function previewExpired(preview: Record<string, unknown> | null, now = Date.now()): boolean {
  if (!preview) return true;
  const value = preview.expiresAt, expires = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return !Number.isFinite(expires) || expires <= now;
}
export function previewSummary(preview: Record<string, unknown>, kind: 'preferences' | 'cache'): string {
  if (kind === 'cache') return `${typeof preview.files === 'number' ? preview.files : '未核'} 个自有文件 · ${formatStorageBytes(preview.bytes)}`;
  const source = portableRecord(preview.source) ? preview.source : {}, changes = portableRecord(preview.changes) ? preview.changes : {};
  return `${typeof source.label === 'string' ? source.label : '偏好文件'}${typeof source.version === 'string' ? ` · ${source.version}` : ''}；布局 ${String(changes.layouts ?? '待核')}，显示 ${String(changes.display ?? '待核')}`;
}
/** A UI-only request controller. No bridge, filesystem path, or scientific state is accessed. */
export class RuntimeDataModel {
  private state: RuntimePanelState = { phase: 'idle', action: '', info: null, preview: null, previewKind: null, diagnostics: null, result: '', error: null };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private maintenanceDisabled = false;
  constructor(private request: PortablePanelRequest) {}
  activate() { if (this.disposed) this.state = { ...this.state, phase: 'idle', preview: null, previewKind: null }; this.disposed = false; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setDisabled(value: boolean) { this.maintenanceDisabled = value; }
  private publish(patch: Partial<RuntimePanelState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  dispose() { this.disposed = true; this.epoch++; }
  cancelPreview() { if (this.state.phase === 'applying') return; this.epoch++; this.publish({ phase: 'idle', preview: null, previewKind: null, result: '已取消，未提交维护操作。', error: null }); }
  cancelRead() { if (this.state.phase !== 'loading' || !['info', 'diagnostics', 'runtime-check'].includes(this.state.action)) return; this.epoch++; this.publish({ phase: 'idle', result: '已停止等待；迟到回执不会改变当前面板。' }); }
  async confirmPreview() {
    const { preview, previewKind } = this.state;
    if (!preview || !previewKind || this.maintenanceDisabled || this.state.info?.writable === false || this.state.phase !== 'preview') return;
    if (previewExpired(preview)) { this.publish({ error: { code: 'PREVIEW_EXPIRED', message: '预览已过期，未提交维护操作。', guidance: portableErrorGuidance('PREVIEW_EXPIRED'), retryable: true } }); return; }
    await this.run({ action: previewKind === 'preferences' ? 'import-apply' : 'cache-apply', token: preview.token as string, confirmed: true } as PortableToolsRequest);
  }
  async run(request: PortableToolsRequest): Promise<void> {
    if (this.disposed || ['loading', 'applying'].includes(this.state.phase)) return;
    const action = request.action;
    const maintenance = ['import-preview', 'import-apply', 'cache-preview', 'cache-apply'].includes(action);
    if ((maintenance || action === 'runtime-check') && this.maintenanceDisabled) { this.publish({ error: { code: 'RUNTIME_BUSY', message: '任务运行期间不能启动维护或原生检查。', guidance: portableErrorGuidance('RUNTIME_BUSY'), retryable: true } }); return; }
    if (maintenance && this.state.info?.writable === false) { this.publish({ error: { code: 'STORAGE_READ_ONLY', message: '目录不可写，未提交维护操作。', guidance: portableErrorGuidance('STORAGE_READ_ONLY'), retryable: true } }); return; }
    const current = ++this.epoch, applying = ['import-apply', 'cache-apply'].includes(action);
    this.publish({ phase: applying ? 'applying' : 'loading', action, preview: null, previewKind: null, error: null, result: '' });
    try {
      const response = await this.request(request) as unknown;
      if (this.disposed || current !== this.epoch) return;
      if (!portableRecord(response) || response.action !== action || typeof response.ok !== 'boolean') throw new Error('服务回执与当前操作不匹配。');
      if (!response.ok) {
        const error = portableRecord(response.error) ? response.error : {}, code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
        const prefix = action === 'import-apply' ? error.preserved === false ? '偏好未完整保存。' : '偏好未保存。' : action === 'preferences-export' ? '偏好未导出。' : action === 'cache-apply' ? '缓存清理未完成。' : '';
        const recoveryRequired = error.recoveryRequired === true || action === 'import-apply' && error.preserved === false;
        const partial = action === 'cache-apply' && error.partial === true;
        this.publish({ phase: 'idle', error: { code, message: prefix + (typeof error.message === 'string' ? error.message : '操作失败。'), guidance: recoveryRequired ? '保存与回滚未完整恢复，暂勿重复导入。请保留备份并按恢复回执处理。' : partial ? '清理仅部分完成。先核对实际删除结果；任务空闲后重新预览剩余缓存。' : portableErrorGuidance(code), retryable: !recoveryRequired && error.retryable === true, preserved: error.preserved === true, recoveryRequired, partial, ...(typeof error.backup === 'string' ? { backup: error.backup } : {}), ...(partial && typeof error.removedFiles === 'number' ? { removedFiles: error.removedFiles } : {}), ...(partial && typeof error.removedBytes === 'number' ? { removedBytes: error.removedBytes } : {}) } }); return;
      }
      if (response.cancelled === true) { this.publish({ phase: 'idle', result: '已取消，未提交维护操作。' }); return; }
      if (action === 'info') { if (!portableRecord(response.info)) throw new Error('运行数据回执缺少info。'); this.publish({ phase: 'idle', info: response.info }); return; }
      if (action === 'import-preview' || action === 'cache-preview') {
        const preview = response.preview;
        if (!portableRecord(preview) || typeof preview.token !== 'string' || !preview.token || previewExpired(preview)) throw new Error('服务未返回有效的维护预览；未提交操作。');
        this.publish({ phase: 'preview', preview, previewKind: action === 'cache-preview' ? 'cache' : 'preferences' }); return;
      }
      if (action === 'diagnostics' || action === 'runtime-check') { const diagnostic = action === 'diagnostics' ? response.diagnostic : response.runtimeCheck; if (!portableRecord(diagnostic)) throw new Error('诊断回执缺少结果。'); this.publish({ phase: 'idle', diagnostics: diagnostic, result: '轻诊断已完成。' }); return; }
      const backup = typeof response.backup === 'string' ? response.backup : portableRecord(response.backup) && typeof response.backup.path === 'string' ? response.backup.path : '';
      if (action === 'import-apply' && (response.imported !== true || !backup)) throw new Error('导入回执未确认已保存及目标备份。');
      if (action === 'cache-apply' && (!Number.isSafeInteger(response.removedFiles) || (response.removedFiles as number) < 0 || typeof response.removedBytes !== 'number' || !Number.isFinite(response.removedBytes) || response.removedBytes < 0)) throw new Error('清理回执未返回实际删除数量与逻辑字节。');
      if (['preferences-export', 'diagnostics-export'].includes(action) && response.exported !== true) throw new Error('导出回执未确认完成。');
      if (action === 'open-location' && response.opened !== true) throw new Error('打开目录回执未确认完成。');
      const result = action === 'import-apply' ? `偏好已保存${backup ? `；目标原偏好备份：${backup}` : '；备份回执见保存结果'}。` : action === 'cache-apply' ? `已移除 ${String(response.removedFiles ?? '已核')} 个自有缓存文件，${formatStorageBytes(response.removedBytes)}。` : action === 'preferences-export' ? '偏好已导出。' : action === 'diagnostics-export' ? '脱敏诊断报告已导出。' : action === 'open-location' ? '已打开所选运行目录。' : '操作已完成。';
      this.publish({ phase: 'idle', result });
    } catch (cause) {
      if (this.disposed || current !== this.epoch) return;
      this.publish({ phase: 'idle', error: { code: 'RECEIPT_UNCONFIRMED', message: `操作回执未确认，未重复提交：${cause instanceof Error ? cause.message : String(cause)}`, guidance: '先刷新状态并核对结果。确认原操作状态后，再重新预览；不要连续重复确认。', retryable: false } });
    }
  }
}
