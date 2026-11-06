import { ELEMENTS } from '../../core/elements';
import { DEFAULT_DISPLAY, type DisplaySettings } from '../contracts';
import { structureAppearancePreset, validStructureSizing } from '../appearance-presets';
import { desktopBridge } from './desktop';

export const MODEL_DISPLAY_PREFERENCES_KEY = 'sciyue.model-display.preferences.v1';
export const MODEL_DISPLAY_PREFERENCES_LIMIT = 128 * 1024;
export const STRUCTURE_SNAPSHOT_FIELDS = ['representation','structurePreset','structureFinish','structureLighting','structureSizing','vdwShell','elementColors','elementScales','atomScale','bondScale','depthFade','showBonds','backgroundColor','bondStyle'] as const;
export type StructureAppearanceSnapshot = Partial<DisplaySettings>;
export interface NamedStructurePreset { name: string; appearance: StructureAppearanceSnapshot }
export interface ModelDisplayPreferencesSnapshot { version: string; display: DisplaySettings; namedPresets?: NamedStructurePreset[]; writable: boolean; error?: string }
export interface ModelDisplayPreferencesBridge {
  readModelDisplayPreferences(): Promise<ModelDisplayPreferencesSnapshot>;
  writeModelDisplayPreferences(request: { baseVersion: string; display: DisplaySettings; namedPresets?: NamedStructurePreset[] }): Promise<ModelDisplayPreferencesSnapshot>;
  restoreModelDisplayPreferences?(baseVersion: string): Promise<ModelDisplayPreferencesSnapshot>;
}
const FLAGS = ['atomNumbers', 'elementNames', 'legend', 'regionHighlights', 'regionLabels', 'frozenMarks', 'scanMarks', 'measurementMarks', 'cell'] as const;
const REQUIRED = ['representation', 'colorMode', ...FLAGS, 'fontSize'];
const OPTIONAL = ['alignment', 'elementColors', 'atomScale', 'bondScale', 'elementScales', 'depthFade', 'structurePreset', 'structureFinish', 'structureLighting', 'structureSizing', 'vdwShell', 'periodicDisplay','showBonds','backgroundColor','bondStyle','cellStyle','axisDisplay','stereochemistry','rotationSpeedPercent'];
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function validFinish(f:unknown):boolean{return plain(f)&&!Object.keys(f).some(key=>!['preset','specular','exponent','ambient','diffuse','outline','outlineWidth'].includes(key))&&['matte','soft','glossy','custom'].includes(String(f.preset))&&typeof f.specular==='number'&&Number.isFinite(f.specular)&&f.specular>=0&&f.specular<=1&&typeof f.exponent==='number'&&Number.isFinite(f.exponent)&&f.exponent>=1&&f.exponent<=128&&!['ambient','diffuse','outline','outlineWidth'].some(key=>Object.hasOwn(f,key)&&(typeof f[key]!=='number'||!Number.isFinite(f[key])||f[key]<0||f[key]>1));}
export function createDefaultModelDisplay(): DisplaySettings { return structuredClone(DEFAULT_DISPLAY); }
/** Display only: never a model snapshot, camera, scientific setting, source or atom identity. */
export function validateModelDisplay(value: unknown): DisplaySettings {
  if (!plain(value) || REQUIRED.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !REQUIRED.includes(key) && !OPTIONAL.includes(key))) throw new Error('只能保存显示设置，禁止模型、来源、路径和原子身份。');
  if (new TextEncoder().encode(JSON.stringify(value)).length > MODEL_DISPLAY_PREFERENCES_LIMIT) throw new Error('显示偏好超过 128 KiB。');
  if (typeof value.representation !== 'string' || !['vdw', 'ball-stick', 'stick'].includes(value.representation) || typeof value.colorMode !== 'string' || !['elements', 'frozen', 'basis', 'layers', 'fragments'].includes(value.colorMode)) throw new Error('无效模型样式或着色方式。');
  if (FLAGS.some(key => typeof value[key] !== 'boolean')) throw new Error('显示开关须为布尔值。');
  if (Object.hasOwn(value,'stereochemistry') && typeof value.stereochemistry !== 'boolean') throw new Error('立体化学显示开关须为布尔值。');
  if (Object.hasOwn(value,'rotationSpeedPercent') && (typeof value.rotationSpeedPercent !== 'number' || !Number.isFinite(value.rotationSpeedPercent) || value.rotationSpeedPercent <= 0)) throw new Error('旋转速度须为正的有限数值。');
  if (Object.hasOwn(value,'showBonds')&&typeof value.showBonds!=='boolean') throw new Error('成键显示开关须为布尔值。');
  const hex=(v:unknown)=>typeof v==='string'&&/^#[\da-f]{6}$/i.test(v);
  const range=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(Object.hasOwn(value,'backgroundColor')&&!hex(value.backgroundColor))throw Error('无效背景颜色。');
  if(Object.hasOwn(value,'bondStyle')){const b=value.bondStyle;if(!plain(b)||Object.keys(b).length!==2||!['elements','uniform'].includes(String(b.colorMode))||!hex(b.color))throw Error('无效化学键配色。');}
  if(Object.hasOwn(value,'cellStyle')){const c=value.cellStyle;if(!plain(c)||Object.keys(c).length!==3||!['solid','dashed'].includes(String(c.lineStyle))||!hex(c.color)||!range(c.width,.5,8))throw Error('无效晶胞外观。');}
  if(Object.hasOwn(value,'axisDisplay')){const a=value.axisDisplay;if(!plain(a)||Object.keys(a).length!==4||!plain(a.colors)||Object.keys(a.colors).length!==3||!['X','Y','Z'].every(key=>hex((a.colors as Record<string,unknown>)[key]))||!range(a.lineWidth,.5,8)||!range(a.length,10,120)||!range(a.fontSize,8,32))throw Error('无效坐标轴外观。');}
  if (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize < 8 || value.fontSize > 24) throw new Error('模型字号须在 8–24 范围。');
  if (Object.hasOwn(value, 'alignment') && (typeof value.alignment !== 'string' || !['auto', 'heavy', 'off'].includes(value.alignment))) throw new Error('无效观察叠合方式。');
  if (Object.hasOwn(value, 'depthFade') && (typeof value.depthFade !== 'number' || !Number.isFinite(value.depthFade) || value.depthFade < 0 || value.depthFade > 1)) throw new Error('深度渐淡须在 0–1 范围。');
  if (Object.hasOwn(value,'structurePreset') && value.structurePreset!=='custom' && !structureAppearancePreset(value.structurePreset)) throw new Error('无效结构风格。');
  if (Object.hasOwn(value,'structureLighting') && (typeof value.structureLighting!=='string'||!['pymol-soft','pymol-cpk','vmd'].includes(value.structureLighting))) throw new Error('无效结构光照。');
  if (Object.hasOwn(value,'structureFinish')) {
    const f=value.structureFinish;
    if(!validFinish(f)) throw new Error('无效结构材质。');
  }
  if(Object.hasOwn(value,'structureSizing')&&!validStructureSizing(value.structureSizing))throw new Error('无效结构外观尺寸。');
  if(Object.hasOwn(value,'vdwShell')){const s=value.vdwShell;if(!plain(s)||Object.keys(s).some(key=>!['color','opacity','finish'].includes(key))||typeof s.color!=='string'||!/^#[\da-f]{6}$/i.test(s.color)||typeof s.opacity!=='number'||!Number.isFinite(s.opacity)||s.opacity<0||s.opacity>1||(Object.hasOwn(s,'finish')&&!validFinish(s.finish)))throw new Error('无效范德华显示外壳。');}
  if(Object.hasOwn(value,'periodicDisplay')){const p=value.periodicDisplay;if(!plain(p)||!['boundaryStyle','outerColor','images','rangeAngstrom'].every(key=>Object.hasOwn(p,key))||Object.keys(p).some(key=>!['boundaryStyle','outerColor','images','rangeAngstrom','showCrossBoxBonds'].includes(key))||Object.hasOwn(p,'showCrossBoxBonds')&&typeof p.showCrossBoxBonds!=='boolean'||!['thin','stubs'].includes(String(p.boundaryStyle))||typeof p.outerColor!=='string'||!/^#[\da-f]{6}$/i.test(p.outerColor)||typeof p.images!=='boolean'||typeof p.rangeAngstrom!=='number'||!Number.isFinite(p.rangeAngstrom)||p.rangeAngstrom<0)throw new Error('无效周期显示设置。');}
  if (Object.hasOwn(value, 'elementColors')) { if (!plain(value.elementColors) || Object.keys(value.elementColors).length > ELEMENTS.length) throw new Error('无效元素颜色表。'); for (const [element, color] of Object.entries(value.elementColors)) if (!ELEMENTS.includes(element) || typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new Error('元素颜色须使用正规元素符号和六位 RGB 色值。'); }
  const validScale = (scale: unknown) => typeof scale==='number' && Number.isFinite(scale) && scale>=.25 && scale<=3;
  if (Object.hasOwn(value, 'atomScale') && !validScale(value.atomScale)) throw new Error('全局球倍率须在 0.25–3 范围。');
  if (Object.hasOwn(value, 'bondScale') && !validScale(value.bondScale)) throw new Error('全局键倍率须在 0.25–3 范围。');
  if (Object.hasOwn(value, 'elementScales')) { if (!plain(value.elementScales) || Object.keys(value.elementScales).length>ELEMENTS.length) throw new Error('无效元素球倍率表。'); for (const [element, scale] of Object.entries(value.elementScales)) if (!ELEMENTS.includes(element)||!validScale(scale)) throw new Error('元素球倍率须使用正规元素符号和 0.25–3 倍率。'); }
  return structuredClone(value) as unknown as DisplaySettings;
}
export function captureStructureAppearance(display: DisplaySettings): StructureAppearanceSnapshot {
  const source=display as unknown as Record<string,unknown>;
  return structuredClone(Object.fromEntries(STRUCTURE_SNAPSHOT_FIELDS.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]))) as StructureAppearanceSnapshot;
}
export function applyStructureAppearanceSnapshot(display: DisplaySettings, appearance: StructureAppearanceSnapshot): DisplaySettings {
  const next={...display} as unknown as Record<string,unknown>;
  for(const key of STRUCTURE_SNAPSHOT_FIELDS)delete next[key];
  return validateModelDisplay({...next,...validateStructureAppearance(appearance)});
}
export function validateStructureAppearance(value: unknown): StructureAppearanceSnapshot {
  if(!plain(value)||!Object.hasOwn(value,'representation')||Object.keys(value).some(key=>!STRUCTURE_SNAPSHOT_FIELDS.includes(key as typeof STRUCTURE_SNAPSHOT_FIELDS[number])))throw Error('预设只能包含结构外观。');
  validateModelDisplay({...createDefaultModelDisplay(),...value});return structuredClone(value) as StructureAppearanceSnapshot;
}
export function validateNamedStructurePresets(value: unknown): NamedStructurePreset[] {
  if(!Array.isArray(value)||value.length>64)throw Error('命名结构预设最多保存64项。');
  const names=new Set<string>();return value.map(item=>{
    if(!plain(item)||Object.keys(item).length!==2||typeof item.name!=='string'||!item.name.trim()||item.name!==item.name.trim()||item.name.length>80||names.has(item.name))throw Error('预设名称须为1–80字符且不能重复。');
    names.add(item.name);return {name:item.name,appearance:validateStructureAppearance(item.appearance)};
  });
}
function validateFile(value: unknown): {display:DisplaySettings;namedPresets?:NamedStructurePreset[]} { if (!plain(value) || Object.keys(value).some(key=>!['schemaVersion','display','namedPresets'].includes(key)) || !Object.hasOwn(value, 'display') || value.schemaVersion !== 1) throw new Error('未知显示偏好格式。'); return {display:validateModelDisplay(value.display),...(Object.hasOwn(value,'namedPresets')?{namedPresets:validateNamedStructurePresets(value.namedPresets)}:{})}; }
const bridge = (): ModelDisplayPreferencesBridge | null => desktopBridge() as unknown as ModelDisplayPreferencesBridge | null;
function previewStorage(): Storage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }
async function version(raw: string | null): Promise<string> { if (raw === null) return 'missing'; const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
/** localStorage is only the browser preview adapter, not proof of native userData persistence. */
export async function readModelDisplayPreferences(native: ModelDisplayPreferencesBridge | null = bridge(), storage: Pick<Storage, 'getItem'> | null = previewStorage()): Promise<ModelDisplayPreferencesSnapshot> {
  if (native) { if (!native.readModelDisplayPreferences) throw new Error('桌面显示偏好接口不可用。'); const snapshot = await native.readModelDisplayPreferences(); return { ...snapshot, display: validateModelDisplay(snapshot.display),...(snapshot.namedPresets?{namedPresets:validateNamedStructurePresets(snapshot.namedPresets)}:{}) }; }
  const raw = storage?.getItem(MODEL_DISPLAY_PREFERENCES_KEY) ?? null;
  try { if (raw !== null && new TextEncoder().encode(raw).length > MODEL_DISPLAY_PREFERENCES_LIMIT) throw new Error('显示偏好超过 128 KiB。'); return { version: await version(raw), writable: storage !== null, ...(raw === null ? {display:createDefaultModelDisplay()} : validateFile(JSON.parse(raw))) }; }
  catch { return { version: await version(raw), writable: false, display: createDefaultModelDisplay(), error: '显示偏好无法读取，原内容已保留。' }; }
}
export async function writeModelDisplayPreferences(snapshot: ModelDisplayPreferencesSnapshot, desired: DisplaySettings, native: ModelDisplayPreferencesBridge | null = bridge(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = previewStorage(), desiredPresets?:NamedStructurePreset[]): Promise<ModelDisplayPreferencesSnapshot> {
  if (!snapshot.writable) throw new Error('损坏、未来版本或不可用显示偏好不能覆盖。'); const display = validateModelDisplay(desired);
  const presets=desiredPresets??snapshot.namedPresets,namedPresets=presets?validateNamedStructurePresets(presets):undefined;
  if (native) { if (!native.writeModelDisplayPreferences) throw new Error('桌面显示偏好接口不可用。'); const saved = await native.writeModelDisplayPreferences({ baseVersion: snapshot.version, display,...(namedPresets?{namedPresets}:{}) }); return { ...saved, display: validateModelDisplay(saved.display),...(saved.namedPresets?{namedPresets:validateNamedStructurePresets(saved.namedPresets)}:{}) }; }
  if (!storage) throw new Error('本机显示偏好存储不可用。');
  const raw = storage.getItem(MODEL_DISPLAY_PREFERENCES_KEY); if (await version(raw) !== snapshot.version) throw new Error('另一窗口已修改显示默认，请重新读取。'); if (raw !== null) validateFile(JSON.parse(raw));
  const text = JSON.stringify({ schemaVersion: 1, display,...(namedPresets?{namedPresets}:{}) }); if(new TextEncoder().encode(text).length>MODEL_DISPLAY_PREFERENCES_LIMIT)throw Error('显示偏好超过128 KiB。');if (storage.getItem(MODEL_DISPLAY_PREFERENCES_KEY) !== raw) throw new Error('显示默认已改变，请重新读取。'); storage.setItem(MODEL_DISPLAY_PREFERENCES_KEY, text);
  return { version: await version(text), display,...(namedPresets?{namedPresets}:{}), writable: true };
}
/** Explicit action: only this display default is reset; no model/analysis state or other window changes. */
export async function restoreModelDisplayPreferences(snapshot: ModelDisplayPreferencesSnapshot, native: ModelDisplayPreferencesBridge | null = bridge(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = previewStorage()): Promise<ModelDisplayPreferencesSnapshot> {
  if (!snapshot.writable) throw new Error('损坏、未来版本或不可用显示偏好须保留。');
  if (native?.restoreModelDisplayPreferences) { const saved = await native.restoreModelDisplayPreferences(snapshot.version); return { ...saved, display: validateModelDisplay(saved.display) }; }
  return writeModelDisplayPreferences(snapshot, createDefaultModelDisplay(), native, storage);
}
