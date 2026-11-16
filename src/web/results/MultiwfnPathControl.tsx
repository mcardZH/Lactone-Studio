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
  return <section className="analysis-environment-control" aria-label="Multiwfn 环境">
    <div className="analysis-environment-row analysis-environment-setting">
      <strong>Multiwfn程序</strong>
      <output className="analysis-environment-path" aria-label="Multiwfn程序">{info.path ?? '未配置'}{info.configured && <span className="sr-only">已配置</span>}</output>
      <button type="button" aria-label="选择 Multiwfn 路径" className="analysis-environment-button" onClick={() => void update(desktop?.chooseOrbitalBackend)} disabled={busy || !desktop?.chooseOrbitalBackend}>选择…</button>
    </div>
    <div className="analysis-environment-row analysis-environment-setting">
      <strong>临时运行目录</strong>
      <output className="analysis-environment-path" aria-label="临时运行目录">{info.workDirectory ?? '自动（程序内短目录）'}</output>
      <button type="button" className="analysis-environment-button" onClick={() => void update(desktop?.chooseMultiwfnWorkDirectory)} disabled={busy || !desktop?.chooseMultiwfnWorkDirectory}>选择文件夹</button>
      <button type="button" className="analysis-environment-button" onClick={() => void update(desktop?.resetMultiwfnWorkDirectory)} disabled={busy || !desktop?.resetMultiwfnWorkDirectory || !info.workDirectory}>恢复默认</button>
    </div>
    {failure && <MultiwfnErrorNotice message={failure} />}
  </section>;
}
