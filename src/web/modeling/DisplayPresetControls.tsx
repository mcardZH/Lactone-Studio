import {DismissibleNotice} from '../DismissibleNotice';
import type {ModelDisplayPreferencesSnapshot} from '../../modeling/platform/display-preferences';

export interface DisplayPresetControlsProps {
  snapshot?: ModelDisplayPreferencesSnapshot | null;
  busy?: boolean;
  status?: string;
  error?: string;
  onSave?(): void;
  onRestore?(): void;
}

export default function DisplayPresetControls(props:DisplayPresetControlsProps){
  const {snapshot,busy=false,status,error,onSave,onRestore}=props;
  const failure = error || snapshot?.error;
  return <div className="model-display-default-controls" data-testid="model-display-default-controls" data-loaded={Boolean(snapshot)} data-writable={Boolean(snapshot?.writable)} aria-busy={busy}>
    <button type="button" data-testid="model-save-display-default" disabled={!snapshot?.writable || busy} onClick={onSave}>保存为预设</button>
    {onRestore && <button type="button" data-testid="model-restore-display-default" disabled={!snapshot?.writable || busy} onClick={onRestore}>恢复内置显示</button>}
    {!snapshot && !failure && <span role="status">正在读取显示预设…</span>}
    {status && <span role="status">{status}</span>}
    {failure && <DismissibleNotice role="alert">{failure}</DismissibleNotice>}
  </div>;
}
