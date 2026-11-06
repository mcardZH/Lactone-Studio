import {DismissibleNotice} from '../DismissibleNotice';
import type { SurfaceAppearanceSnapshot, SurfaceDisplayFamily } from '../../results/platform/surface-display-preferences';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';

export default function SaveSurfaceAppearanceDefault({ family, appearance }: { family: SurfaceDisplayFamily; appearance: SurfaceAppearanceSnapshot }) {
  const defaults = useSurfaceAppearanceDefaults(), own = defaults.actionFamily === family;
  return <>
    <button type="button" aria-label={`${family}保存为本类默认`} disabled={!defaults.ready || !defaults.snapshot?.writable || defaults.busy} onClick={() => { void defaults.save(family, appearance).catch(() => {}); }}>保存为本类默认</button>
    {defaults.snapshot?.value[family] && <button type="button" aria-label={`${family}恢复内置默认`} title="仅恢复后续实例的本类默认，当前显示保持不变" disabled={!defaults.ready || !defaults.snapshot.writable || defaults.busy} onClick={() => { void defaults.restore(family).catch(() => {}); }}>恢复内置默认</button>}
    {own && defaults.status && <span role="status">{defaults.status}</span>}
    {defaults.error && (own || !defaults.snapshot?.writable) && <><DismissibleNotice role="alert">{defaults.error}</DismissibleNotice><button type="button" disabled={defaults.busy} onClick={() => { void defaults.reload(); }}>重新读取</button></>}
  </>;
}
