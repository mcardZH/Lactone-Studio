import {DismissibleNotice} from './DismissibleNotice';
import { useRef } from 'react';
import type { FirstRunLicenseSnapshot } from '../modeling/first-run-license';
import DialogShell from './DialogShell';
import './first-run-license.css';

export interface FirstRunLicenseProps {
  snapshot: FirstRunLicenseSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string;
  onContinue(): void;
  onRetry(): void;
}
export default function FirstRunLicense({ snapshot, loading, saving, error, onContinue, onRetry }: FirstRunLicenseProps) {
  const text = useRef<HTMLPreElement>(null);
  return <DialogShell aria-label="阅读软件许可协议" className="first-run-license" initialFocus={() => text.current} onCancel={() => {}}>
    <header><h2>阅读软件许可协议</h2><p>Lactone Studio（基于 Ester Studio v2.0.3 的非官方修改版 · 修改者 mcardZH · https://github.com/mcardZH/Lactone-Studio） · LICENSE.txt</p></header>
    <pre ref={text} tabIndex={0} className="first-run-license-text" aria-label="许可协议全文">{snapshot?.text ?? (loading ? '正在读取许可协议…' : '')}</pre>
    {error && <DismissibleNotice className="first-run-license-error" role="alert">{error}</DismissibleNotice>}
    <footer>{error && <button type="button" disabled={loading || saving} onClick={onRetry}>重新读取</button>}<button type="button" className="button button-primary" disabled={loading || saving || !snapshot} onClick={onContinue}>{saving ? '正在保存…' : '已阅读，继续'}</button></footer>
  </DialogShell>;
}
