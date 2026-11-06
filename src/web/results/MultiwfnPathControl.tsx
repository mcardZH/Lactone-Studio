import {DismissibleNotice} from '../DismissibleNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { OrbitalBackendInfo } from '../../results/orbital-contracts';
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
      if (alive.current && serial === epoch.current && value) {setInfo(value);setError('');}
    } catch (cause) { if (alive.current && serial === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed);
    return () => { alive.current = false; epoch.current++; window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed); };
  }, [refresh]);
  async function choose() {
    const bridge = window.sciyueDesktop;
    if (!bridge?.chooseOrbitalBackend || busy) return;
    setBusy(true); setError(''); const serial = ++epoch.current;
    try {
      const value = await bridge.chooseOrbitalBackend();
      if (!alive.current || serial !== epoch.current) return;
      setInfo(value); window.dispatchEvent(new Event(MULTIWFN_CONFIGURATION_CHANGED));
    } catch (cause) { if (alive.current && serial === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  if(!showPath)return !info.configured?<section className="analysis-environment-control" aria-label="Multiwfn 环境"><button type="button" className="analysis-environment-button" onClick={openGlobalSettings}>前往全局设置</button>{error&&<DismissibleNotice role="alert" className="analysis-environment-error">{error}</DismissibleNotice>}</section>:null;
  return <section className="analysis-environment-control" aria-label="Multiwfn 环境">
    <div className="analysis-environment-row"><button type="button" className="analysis-environment-button" onClick={() => void choose()} disabled={busy || !desktop?.chooseOrbitalBackend}><FolderOpen size={16}/>{busy ? '正在选择…' : info.configured ? '修改 Multiwfn 路径' : '选择 Multiwfn 路径'}</button><span className={info.configured ? 'is-configured' : ''}>{info.configured ? '已配置' : '未配置'}</span></div>
    <p className="analysis-environment-path">{info.path ?? '选择本机 Multiwfn 所在文件夹。'}</p>
    {!desktop?.chooseOrbitalBackend && <p className="analysis-environment-path">请在桌面版中配置本机分析程序。</p>}
    {error && <DismissibleNotice role="alert" className="analysis-environment-error">{error}</DismissibleNotice>}
  </section>;
}
