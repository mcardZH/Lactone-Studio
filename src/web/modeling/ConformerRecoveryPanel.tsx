import { useCallback, useEffect, useRef, useState } from 'react';
import {
  openRecoveredConformerTrajectory, recoveryLabel, type ConformerRecoveryBridge, type ConformerRecoveryItem,
} from '../../modeling/advanced/conformer-recovery';
import type { TrajectoryResult } from '../../results/contracts';

export function ConformerRecoveryPanel({ bridge, publish, opened, captureGuard, disabled }: {
  bridge: ConformerRecoveryBridge;
  publish(result: TrajectoryResult): void;
  opened(item: ConformerRecoveryItem): boolean;
  captureGuard(): () => void;
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<ConformerRecoveryItem[]>([]);
  const [issues, setIssues] = useState(0), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<{done:number;total:number} | null>(null);
  const [expanded, setExpanded] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const describe = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

  const refresh = useCallback(async () => {
    const result = await bridge.listConformerRecovery();
    if (alive.current) { setCatalog(result.recoveries); setIssues(result.issues.length); }
  },[bridge]);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(cause => { if (alive.current) setError(describe(cause)); });
    return () => { alive.current = false; operation.current?.abort(); };
  }, [refresh]);

  async function open(item: ConformerRecoveryItem) {
    if (operation.current || disabled) return;
    const guard = captureGuard(), controller = new AbortController();
    operation.current = controller; setBusy(true); setError('');
    let result: TrajectoryResult | undefined;
    try {
      result = await openRecoveredConformerTrajectory(bridge, item, controller.signal, (done, total) => {
        if (alive.current && !controller.signal.aborted) setProgress({ done, total });
      });
      guard();
      if (controller.signal.aborted || !alive.current) return;
      publish(result); result = undefined;
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(describe(cause));
    } finally {
      if (result) await Promise.resolve(result.dispose()).catch(cause => { if (alive.current) setError(describe(cause)); });
      operation.current = null;
      if (alive.current) { setBusy(false); setProgress(null); }
    }
  }
  async function discard(item: ConformerRecoveryItem) {
    if (busy || disabled || opened(item)) return;
    setBusy(true); setError('');
    try { if ((await bridge.discardConformerRecovery(item.kind, item.id)).discarded) await refresh(); }
    catch (cause) { if (alive.current) setError(describe(cause)); }
    finally { if (alive.current) setBusy(false); }
  }

  return <section className="workspace-computation-recovery ui-control-surface" aria-label="恢复计算结果" data-testid="computation-recovery">
    <button type="button" aria-expanded={expanded} onClick={() => {
      setExpanded(!expanded);
      if(!expanded)void refresh().catch(cause=>{if(alive.current)setError(describe(cause));});
    }}>恢复计算结果{catalog.length ? ` (${catalog.length})` : ''}</button>
    {expanded && <div className="workspace-computation-recovery-details">
      {error && <div role="alert">{error} <button type="button" onClick={() => setError('')}>关闭提示</button></div>}
      {issues > 0 && <p role="status">有 {issues} 份恢复记录待核实，原文件已保留。</p>}
      {!catalog.length&&!issues&&!error&&<p role="status">暂无可恢复结果。</p>}
      {progress && <div role="status">读取恢复索引 {progress.done} / {progress.total} <progress value={progress.done} max={progress.total} aria-label="恢复索引读取进度" /> <button type="button" onClick={() => operation.current?.abort()}>取消读取</button></div>}
      {catalog.map(item => <div key={`${item.kind}:${item.id}`} className="workspace-computation-recovery-record">
        <span>{recoveryLabel(item)} · {item.recoverableCount} / {item.expectedCount} 条{item.verification==='manifest-only'?'已登记':'已核验'}记录</span>
        <button type="button" disabled={busy || disabled || opened(item)} onClick={() => void open(item)}>{opened(item) ? '已打开' : '打开结果'}</button>
        <button type="button" disabled={busy || disabled || opened(item)} onClick={() => void discard(item)}>清除恢复副本</button>
      </div>)}
    </div>}
  </section>;
}
