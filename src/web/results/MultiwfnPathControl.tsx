import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrbitalBackendInfo } from '../../results/orbital-contracts';
import MultiwfnErrorNotice, { multiwfnBackendFailure } from './MultiwfnErrorNotice';
import './analysis-environment.css';
import {MULTIWFN_CONFIGURATION_CHANGED,openGlobalSettings} from '../global-settings-events';

export {MULTIWFN_CONFIGURATION_CHANGED} from '../global-settings-events';

/** Both environment settings and analysis panels use the native persisted path. */
export default function MultiwfnPathControl({ showPath = false }: { showPath?: boolean }) {
  const desktop = typeof window === 'undefined' ? undefined : window.sciyueDesktop;
  const [info, setInfo] = useState<OrbitalBackendInfo>({ configured: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(false), epoch = useRef(0);
  const refresh = useCallback(async () => {
    const serial = ++epoch.current;
    try {
      const value = await window.sciyueDesktop?.orbitalBackendInfo?.();
      if (alive.current && serial === epoch.current && value) setInfo(value);
    } catch (cause) { if (alive.current && serial === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed);
    return () => { alive.current = false; epoch.current++; window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed); };
  }, [refresh]);
  async function update(action?: () => Promise<OrbitalBackendInfo>) {
    if (!action || busy) return;
    setBusy(true); setError('');
    const serial = ++epoch.current;
    try {
      const value = await action();
      if (!alive.current || serial !== epoch.current) return;
      setInfo(value); window.dispatchEvent(new Event(MULTIWFN_CONFIGURATION_CHANGED));
    } catch (cause) { if (alive.current && serial === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  if (!showPath) return !info.configured || info.status === 'work-directory-unavailable'
    ? <section className="analysis-environment-control" aria-label="Multiwfn 环境"><button type="button" className="analysis-environment-button" onClick={openGlobalSettings}>前往全局设置</button></section>
    : null;
  const failure = error || (info.status && info.status !== 'ready' && info.status !== 'unconfigured' ? multiwfnBackendFailure(info,'ORBITAL') : '');
  const states = {
    ready: '已配置',
    unconfigured: '未配置',
    'configuration-invalid': '配置无法读取',
    'program-unavailable': '已配置的程序不可用',
    'work-directory-unavailable': '临时运行目录不可用',
  };
  const state = busy ? '正在更新…' : error ? '配置读取或更新失败' : states[info.status ?? (info.configured ? 'ready' : 'unconfigured')];
  return <details className="analysis-environment-control settings-tool-disclosure">
    <summary className="settings-tool-row">
      <strong className="settings-tool-title">Multiwfn</strong>
      <output className="settings-tool-status" data-state={failure ? 'error' : info.configured && !busy ? 'ready' : undefined} aria-label="Multiwfn 程序状态">{state}</output>
      <span className="settings-tool-reveal" aria-hidden="true"><span>配置</span><span>收起</span></span>
    </summary>
    <section className="settings-tool-detail" aria-label="Multiwfn 环境">
      <div className="settings-tool-file">
        <strong>程序路径</strong>
        <output className="analysis-environment-path" aria-label="Multiwfn程序">{info.path ?? '未选择'}</output>
        <button type="button" aria-label="选择 Multiwfn 路径" className="analysis-environment-button" onClick={() => void update(desktop?.chooseOrbitalBackend)} disabled={busy || !desktop?.chooseOrbitalBackend}>浏览…</button>
      </div>
      <div className="settings-tool-file">
        <strong>临时运行目录</strong>
        <output className="analysis-environment-path" aria-label="临时运行目录">{info.workDirectory ?? '自动（程序内短目录）'}</output>
        <div className="settings-tool-actions">
          <button type="button" className="analysis-environment-button" onClick={() => void update(desktop?.chooseMultiwfnWorkDirectory)} disabled={busy || !desktop?.chooseMultiwfnWorkDirectory}>选择文件夹</button>
          <button type="button" className="analysis-environment-button" onClick={() => void update(desktop?.resetMultiwfnWorkDirectory)} disabled={busy || !desktop?.resetMultiwfnWorkDirectory || !info.workDirectory}>恢复默认</button>
        </div>
      </div>
      {failure && <MultiwfnErrorNotice message={failure} />}
    </section>
  </details>;
}
