import type { DesktopBridge } from '../contracts';
import { createDefaultWorkbenchPreferences, normalizeWorkbenchPreferences, type WorkbenchPreferences, type WorkbenchPreferenceSnapshot, type WorkbenchPreferenceUpdate } from '../workbench-layout';
import { desktopBridge } from './desktop';
export const WORKBENCH_STORAGE_KEY = 'sciyue.workbench.preferences.v3';
export const PREVIOUS_WORKBENCH_STORAGE_KEY = 'sciyue.workbench.preferences.v2';
export const LEGACY_WORKBENCH_STORAGE_KEY = 'sciyue.workbench.preferences.v1';
type Reader = Pick<Storage, 'getItem'>;
type StorageAdapter = Pick<Storage, 'getItem' | 'setItem'>;
const LIMIT = 1024 * 1024;
const browserStorage = (): Storage | null => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };
const legacyReads = new WeakMap<object, WorkbenchPreferenceSnapshot>();
const queues = new WeakMap<object, Promise<unknown>>();
function canonical(value: unknown): WorkbenchPreferences {
  const source = value as Partial<WorkbenchPreferences> | null, text = JSON.stringify(value);
  if (!source || Array.isArray(source) || ![1, 2, 3].includes(source.schemaVersion as number) || !Array.isArray(source.layouts) || !source.layouts.length || source.layouts.length > 32 || typeof text !== 'string' || new TextEncoder().encode(text).byteLength > LIMIT) throw new Error('Invalid workbench preference schema or size');
  if (source.layouts.some(layout => !layout || Array.isArray(layout) || typeof layout.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(layout.id) || typeof layout.name !== 'string' || !layout.name.trim() || layout.name.trim().length > 80) || !source.layouts.some(layout => layout.id === source.defaultLayoutId)) throw new Error('Invalid layout identity/name or default pointer');
  const safe = normalizeWorkbenchPreferences(source);
  if (safe.layouts.length !== source.layouts.length || new Set(safe.layouts.map(layout => layout.name)).size !== safe.layouts.length) throw new Error('Invalid or duplicate layout identity/name');
  return safe;
}
async function load(storage: Reader | null): Promise<WorkbenchPreferenceSnapshot & { key: string; raw: string | null }> {
  if (!storage) return { preferences: createDefaultWorkbenchPreferences(), version: 'unavailable', writable: false, error: '本机布局存储不可用。', key: WORKBENCH_STORAGE_KEY, raw: null };
  let key = WORKBENCH_STORAGE_KEY, raw: string | null = null;
  for (const candidate of [WORKBENCH_STORAGE_KEY, PREVIOUS_WORKBENCH_STORAGE_KEY, LEGACY_WORKBENCH_STORAGE_KEY]) {
    const value = storage.getItem(candidate); if (value !== null) { key = candidate; raw = value; break; }
  }
  if (raw === null) return { preferences: createDefaultWorkbenchPreferences(), version: 'missing', writable: true, key, raw };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key + '\0' + raw));
  const version = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  try { return { preferences: canonical(JSON.parse(raw)), version, writable: true, key, raw }; }
  catch (error) { return { preferences: createDefaultWorkbenchPreferences(), version, writable: false, error: '布局格式无法读取，已保留原数据：' + String(error), key, raw }; }
}
const publicSnapshot = (value: WorkbenchPreferenceSnapshot): WorkbenchPreferenceSnapshot => ({ preferences: structuredClone(value.preferences), version: value.version, writable: value.writable, ...(value.error ? { error: value.error } : {}) });

/** Browser storage is a preview adapter: strict whole-document CAS, not the
 * desktop host's identity-aware independent-layout merge or disk persistence. */
export async function readWorkbenchPreferenceSnapshot(bridge: DesktopBridge | null = desktopBridge(), storage: Reader | null = browserStorage()): Promise<WorkbenchPreferenceSnapshot> {
  let result: WorkbenchPreferenceSnapshot;
  if (bridge?.readWorkbenchPreferenceSnapshot) result = await bridge.readWorkbenchPreferenceSnapshot();
  else if (bridge?.readWorkbenchPreferences) result = { preferences: normalizeWorkbenchPreferences(await bridge.readWorkbenchPreferences()), version: 'legacy-bridge', writable: false, error: '桌面布局版本接口不可用，请使用新版本宿主。' };
  else if (bridge) throw new Error('桌面布局存储接口不可用。');
  else result = publicSnapshot(await load(storage));
  if (bridge ?? storage) legacyReads.set((bridge ?? storage)!, result);
  return publicSnapshot(result);
}
export async function writeWorkbenchPreferenceSnapshot(update: WorkbenchPreferenceUpdate, bridge: DesktopBridge | null = desktopBridge(), storage: StorageAdapter | null = browserStorage()): Promise<WorkbenchPreferenceSnapshot> {
  if (bridge?.writeWorkbenchPreferenceSnapshot) return publicSnapshot(await bridge.writeWorkbenchPreferenceSnapshot(update));
  if (bridge) throw new Error('桌面布局版本存储接口不可用。');
  if (!storage) throw new Error('本机布局存储不可用。');
  const operation = async () => {
    if (!update || Object.keys(update).length !== 2 || typeof update.baseVersion !== 'string') throw new Error('Invalid workbench snapshot update');
    const desired = canonical(update.preferences), current = await load(storage);
    if (!current.writable) throw new Error('损坏或未来格式已保留，禁止覆写。');
    if (current.version !== update.baseVersion) throw new Error('WORKBENCH_CONFLICT: 另一窗口已修改布局，请重新读取。');
    // No await between final exact comparison and setItem; Web Locks serializes
    // independent browser contexts where available. Never claim cross-process host locking.
    if (storage.getItem(current.key) !== current.raw || current.key !== WORKBENCH_STORAGE_KEY && storage.getItem(WORKBENCH_STORAGE_KEY) !== null || current.key === LEGACY_WORKBENCH_STORAGE_KEY && storage.getItem(PREVIOUS_WORKBENCH_STORAGE_KEY) !== null) throw new Error('WORKBENCH_CONFLICT: 保存期间布局已变化。');
    storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(desired));
    const saved = publicSnapshot(await load(storage)); legacyReads.set(storage, saved); return saved;
  };
  const pending = (queues.get(storage) ?? Promise.resolve()).catch(() => {}).then(() => typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('sciyue-workbench-preferences-v3', operation) : operation());
  queues.set(storage, pending); return pending;
}
/** Legacy helpers retain their Promise signatures without bypassing safety. */
export async function readWorkbenchPreferences(bridge: DesktopBridge | null = desktopBridge(), storage: Reader | null = browserStorage()): Promise<WorkbenchPreferences> {
  if (bridge?.readWorkbenchPreferences) return normalizeWorkbenchPreferences(await bridge.readWorkbenchPreferences());
  return (await readWorkbenchPreferenceSnapshot(bridge, storage)).preferences;
}
export async function writeWorkbenchPreferences(preferences: WorkbenchPreferences, bridge: DesktopBridge | null = desktopBridge(), storage: Pick<Storage, 'setItem'> & Partial<Reader> | null = browserStorage()): Promise<void> {
  if (bridge?.writeWorkbenchPreferences) { await bridge.writeWorkbenchPreferences(preferences); return; }
  if (bridge && !bridge.writeWorkbenchPreferenceSnapshot) throw new Error('桌面布局存储接口不可用。');
  const owner = bridge ?? storage, baseline = owner && legacyReads.get(owner);
  if (!baseline) throw new Error('请先读取布局，再保存方案。');
  if (!baseline.writable) throw new Error('损坏或未来格式已保留，禁止覆写。');
  if (!bridge && typeof storage?.getItem !== 'function') throw new Error('本机布局读取接口不可用。');
  await writeWorkbenchPreferenceSnapshot({ baseVersion: baseline.version, preferences }, bridge, storage as StorageAdapter | null);
}
