import { desktopBridge } from '../../modeling/platform/desktop';
import type { MeshFinishSettings } from '../mesh-appearance';
import {surfaceAppearancePreset,type SurfaceAppearancePresetId} from '../surface-appearance-presets';

export const SURFACE_DISPLAY_FAMILIES = ['orbital', 'electron-hole', 'surface:esp', 'surface:alie', 'surface:hirshfeld', 'interaction:iri', 'interaction:rdg', 'interaction:igmh', 'interaction:migm', 'interaction:igm', 'vibration'] as const;
export type SurfaceDisplayFamily = typeof SURFACE_DISPLAY_FAMILIES[number];
export interface MeshAppearanceSnapshot {
  presetId: SurfaceAppearancePresetId | 'custom';
  /** Orbital: positive, negative. Electron-hole: hole, electron. Maps: low to high; ESP/ALIE one color means a solid density surface. */
  colors: string[];
  finish: MeshFinishSettings;
  /** Optional in all mesh families; absence in legacy defaults preserves Local opacity. */
  opacity?: number;
}
export interface VibrationAppearanceSnapshot {
  presetId: 'standard' | 'teal' | 'custom';
  vector: { color: string; radius: number; radiusRatio: number; mid: number };
}
export type SurfaceAppearanceSnapshot = MeshAppearanceSnapshot | VibrationAppearanceSnapshot;
export interface NamedOrbitalAppearance { name: string; appearance: MeshAppearanceSnapshot & { opacity: number } }
export interface SurfaceDisplayPreferencesSnapshot {
  value: Partial<Record<SurfaceDisplayFamily, SurfaceAppearanceSnapshot>>;
  writable: boolean;
  error?: string;
  version: string;
  namedOrbitalPresets?: NamedOrbitalAppearance[];
}
export interface SurfaceDisplayPreferencesBridge {
  readSurfaceDisplayPreferences(): Promise<SurfaceDisplayPreferencesSnapshot>;
  writeSurfaceDisplayPreferences(request: { baseVersion: string; family: SurfaceDisplayFamily; appearance: SurfaceAppearanceSnapshot; name?: string }): Promise<SurfaceDisplayPreferencesSnapshot>;
  restoreSurfaceDisplayPreferences(request: { baseVersion: string; family: SurfaceDisplayFamily }): Promise<SurfaceDisplayPreferencesSnapshot>;
}
export const SURFACE_DISPLAY_PREFERENCES_KEY = 'sciyue.surface-display.preferences.v1';
export const SURFACE_DISPLAY_PREFERENCES_LIMIT = 64 * 1024;
type PreviewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('外观默认含未知字段。');
}
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const color = (value: unknown): value is string => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
function family(value: unknown): SurfaceDisplayFamily {
  if (typeof value !== 'string' || !(SURFACE_DISPLAY_FAMILIES as readonly string[]).includes(value)) throw new Error('未知外观默认分类。');
  return value as SurfaceDisplayFamily;
}
/** Fixed trusted mirror of the desktop validator; no ranges, iso or scientific state. */
export function validateSurfaceAppearance(id: SurfaceDisplayFamily, value: unknown): SurfaceAppearanceSnapshot {
  family(id);
  if (id === 'vibration') {
    exact(value, ['presetId', 'vector']);
    if (!['standard', 'teal', 'custom'].includes(value.presetId as string)) throw new Error('未知矢量外观预设。');
    exact(value.vector, ['color', 'radius', 'radiusRatio', 'mid']);
    const v = value.vector;
    if (!color(v.color) || !finite(v.radius, .001, .5) || !finite(v.radiusRatio, 1, 10) || !finite(v.mid, .05, .95)) throw new Error('矢量外观参数无效。');
  } else {
    exact(value, plain(value) && Object.hasOwn(value, 'opacity') ? ['presetId', 'colors', 'finish', 'opacity'] : ['presetId', 'colors', 'finish']);
    if (Object.hasOwn(value, 'opacity') && !finite(value.opacity, 0, 1)) throw new Error('表面不透明度无效。');
    if (value.presetId!=='custom'&&!surfaceAppearancePreset(value.presetId)) throw new Error('未知表面外观预设。');
    const minimumColors = id === 'surface:esp' || id === 'surface:alie' ? 1 : 2;
    if (!Array.isArray(value.colors) || value.colors.length < minimumColors || value.colors.length > 16 || Object.keys(value.colors).length !== value.colors.length || !Array.from(value.colors).every(color)
      || (id === 'orbital' || id === 'electron-hole') && value.colors.length !== 2) throw new Error('有序外观颜色无效。');
    const f = value.finish;
    if (!plain(f) || !['preset', 'specular', 'exponent'].every(key => Object.hasOwn(f, key)) || Object.keys(f).some(key => !['preset', 'specular', 'exponent', 'ambient', 'diffuse', 'outline', 'outlineWidth'].includes(key))
      || !['matte', 'soft', 'glossy', 'custom'].includes(f.preset as string) || !finite(f.specular, 0, 1) || !finite(f.exponent, 1, 128)
      || ['ambient', 'diffuse', 'outline', 'outlineWidth'].some(key => Object.hasOwn(f, key) && !finite(f[key], 0, 1))) throw new Error('表面材质参数无效。');
  }
  return structuredClone(value) as unknown as SurfaceAppearanceSnapshot;
}
function values(input: unknown): SurfaceDisplayPreferencesSnapshot['value'] {
  if (!plain(input) || Object.keys(input).length > SURFACE_DISPLAY_FAMILIES.length) throw new Error('无效外观默认分类表。');
  const result: SurfaceDisplayPreferencesSnapshot['value'] = {};
  for (const [id, selected] of Object.entries(input)) result[family(id)] = validateSurfaceAppearance(family(id), selected);
  return result;
}
export function validateNamedOrbitalPresets(input: unknown): NamedOrbitalAppearance[] {
  if (!Array.isArray(input) || input.length > 64 || Object.keys(input).length !== input.length) throw new Error('命名轨道预设列表无效。');
  const names = new Set<string>();
  return input.map(item => {
    exact(item, ['name', 'appearance']);
    const name = validateOrbitalPresetName(item.name);
    if (names.has(name)) throw new Error('预设名称重复，请另存新名称。');
    names.add(name);
    const appearance = validateSurfaceAppearance('orbital', item.appearance) as MeshAppearanceSnapshot;
    if (appearance.opacity === undefined) throw new Error('命名轨道预设缺少不透明度。');
    return { name, appearance: appearance as NamedOrbitalAppearance['appearance'] };
  });
}
export function validateOrbitalPresetName(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input !== input.trim() || input.length > 80 || /[\u0000-\u001f\u007f]/.test(input)) throw new Error('请输入1–80字的预设名称。');
  return input;
}
type PreferenceContent = Pick<SurfaceDisplayPreferencesSnapshot, 'value' | 'namedOrbitalPresets'>;
function file(raw: string): PreferenceContent {
  if (new TextEncoder().encode(raw).length > SURFACE_DISPLAY_PREFERENCES_LIMIT) throw new Error('外观默认超过64 KiB。');
  const parsed: unknown = JSON.parse(raw);
  if (!plain(parsed) || ![1, 2].includes(parsed.schemaVersion as number)) throw new Error('未知或未来版本的外观默认。');
  exact(parsed, parsed.schemaVersion === 1 ? ['schemaVersion', 'value'] : ['schemaVersion', 'value', 'namedOrbitalPresets']);
  const namedOrbitalPresets = parsed.schemaVersion === 2 ? validateNamedOrbitalPresets(parsed.namedOrbitalPresets) : [];
  return { value: values(parsed.value), ...(namedOrbitalPresets.length ? { namedOrbitalPresets } : {}) };
}
function snapshot(input: SurfaceDisplayPreferencesSnapshot): SurfaceDisplayPreferencesSnapshot {
  if (!plain(input) || Object.keys(input).some(key => !['value', 'version', 'writable', 'error', 'namedOrbitalPresets'].includes(key)) || typeof input.version !== 'string'
    || !/^(?:missing|unavailable|[a-f0-9]{64})$/.test(input.version) || typeof input.writable !== 'boolean' || input.error !== undefined && typeof input.error !== 'string') throw new Error('桌面外观默认响应无效。');
  return { value: values(input.value), version: input.version, writable: input.writable, ...(input.error ? { error: input.error } : {}), ...(input.namedOrbitalPresets ? { namedOrbitalPresets: validateNamedOrbitalPresets(input.namedOrbitalPresets) } : {}) };
}
function previewStorage(): PreviewStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }
async function version(raw: string | null): Promise<string> {
  if (raw === null) return 'missing';
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const bridge = () => desktopBridge() as unknown as SurfaceDisplayPreferencesBridge | null;
/** Reads never save defaults. Browser storage is preview-only, not desktop userData. */
export async function readSurfaceDisplayPreferences(native: SurfaceDisplayPreferencesBridge | null = bridge(), storage: PreviewStorage | null = previewStorage()): Promise<SurfaceDisplayPreferencesSnapshot> {
  let raw: string | null = null;
  try {
    if (native) return snapshot(await native.readSurfaceDisplayPreferences());
    if (!storage) throw new Error('本机外观默认存储不可用。');
    raw = storage.getItem(SURFACE_DISPLAY_PREFERENCES_KEY);
    return { ...(raw === null ? { value: {} } : file(raw)), version: await version(raw), writable: true };
  } catch (error) { return { value: {}, writable: false, version: raw === null ? 'unavailable' : await version(raw), error: '外观默认无法读取，原内容已保留：' + String(error) }; }
}
async function update(base: SurfaceDisplayPreferencesSnapshot, id: SurfaceDisplayFamily, desired: SurfaceAppearanceSnapshot | undefined, restore: boolean, native: SurfaceDisplayPreferencesBridge | null, storage: PreviewStorage | null, name?: string): Promise<SurfaceDisplayPreferencesSnapshot> {
  family(id); const baseline = snapshot(base);
  if (!baseline.writable) throw new Error('损坏、未来版本或不可用外观默认不能覆盖。');
  const canonical = restore ? undefined : validateSurfaceAppearance(id, desired);
  if (name !== undefined) {
    validateOrbitalPresetName(name);
    if (id !== 'orbital' || restore || !canonical || !('opacity' in canonical) || canonical.opacity === undefined) throw new Error('命名预设仅支持含不透明度的轨道外观。');
  }
  if (native) {
    const saved = snapshot(restore ? await native.restoreSurfaceDisplayPreferences({ baseVersion: baseline.version, family: id })
      : await native.writeSurfaceDisplayPreferences({ baseVersion: baseline.version, family: id, appearance: canonical!, ...(name === undefined ? {} : { name }) }));
    if (!saved.writable) throw new Error(saved.error || '外观默认写入未获确认。');
    return saved;
  }
  if (!storage) throw new Error('本机外观默认存储不可用。');
  const before = storage.getItem(SURFACE_DISPLAY_PREFERENCES_KEY);
  if (await version(before) !== baseline.version) throw new Error('另一窗口已修改外观默认，请重新读取。');
  const saved: PreferenceContent = before === null ? { value: {} } : file(before);
  if (name !== undefined) {
    if (saved.namedOrbitalPresets?.some(item => item.name === name)) throw new Error('该预设名称已存在，请另存新名称。');
    saved.namedOrbitalPresets = validateNamedOrbitalPresets([...(saved.namedOrbitalPresets ?? []), { name, appearance: canonical }]);
  } else if (restore) delete saved.value[id]; else saved.value[id] = canonical;
  const text = JSON.stringify(saved.namedOrbitalPresets?.length ? { schemaVersion: 2, value: saved.value, namedOrbitalPresets: saved.namedOrbitalPresets } : { schemaVersion: 1, value: saved.value });
  if (new TextEncoder().encode(text).length > SURFACE_DISPLAY_PREFERENCES_LIMIT) throw new Error('外观默认超过64 KiB。');
  if (storage.getItem(SURFACE_DISPLAY_PREFERENCES_KEY) !== before) throw new Error('外观默认已改变，请重新读取。');
  storage.setItem(SURFACE_DISPLAY_PREFERENCES_KEY, text);
  if (storage.getItem(SURFACE_DISPLAY_PREFERENCES_KEY) !== text) throw new Error('写入后的外观默认已改变，请重新读取。');
  return { ...saved, version: await version(text), writable: true };
}
export function writeSurfaceDisplayPreferences(base: SurfaceDisplayPreferencesSnapshot, id: SurfaceDisplayFamily, appearance: SurfaceAppearanceSnapshot, native: SurfaceDisplayPreferencesBridge | null = bridge(), storage: PreviewStorage | null = previewStorage()) {
  return update(base, id, appearance, false, native, storage);
}
export function restoreSurfaceDisplayPreferences(base: SurfaceDisplayPreferencesSnapshot, id: SurfaceDisplayFamily, native: SurfaceDisplayPreferencesBridge | null = bridge(), storage: PreviewStorage | null = previewStorage()) {
  return update(base, id, undefined, true, native, storage);
}
export function writeNamedOrbitalAppearance(base: SurfaceDisplayPreferencesSnapshot, name: string, appearance: MeshAppearanceSnapshot, native: SurfaceDisplayPreferencesBridge | null = bridge(), storage: PreviewStorage | null = previewStorage()) {
  return update(base, 'orbital', appearance, false, native, storage, name);
}
