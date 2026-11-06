import registry from '../../desktop/workbench-actions.json';
/** One static JSON registry is consumed by renderer TS and host CJS alike. */
export interface WorkbenchActionDefinition { id: string; label: string; kind: 'action' | 'block'; span: 1 | 2 | 3 | 4; lockedSpan?: 1 | 2 | 3 | 4; group: string; legacyGroup: string; critical?: boolean }
export const WORKBENCH_ACTIONS = registry.actions as WorkbenchActionDefinition[];
export const WORKBENCH_ACTION_IDS = WORKBENCH_ACTIONS.map(action => action.id);
export type WorkbenchActionId = string;
export interface WorkbenchToolPlacement { actionId: WorkbenchActionId; span: 1 | 2 | 3 | 4; group?: string; breakAfter?: boolean; row?: number; column?: number; rowSpan?: number }
export interface WorkbenchPaneSizes { leftWidth: number; rightWidth: number; canvasHeight: number; previewHeight: number; activePreviewHeight?: number }
export interface WorkbenchLayout { id: string; name: string; items: WorkbenchToolPlacement[]; paneSizes: WorkbenchPaneSizes; folds: Record<string, boolean> }
export interface WorkbenchPreferences { schemaVersion: 1 | 2 | 3; defaultLayoutId: string; layouts: WorkbenchLayout[] }
export interface WorkbenchPreferenceSnapshot { preferences: WorkbenchPreferences; version: string; writable: boolean; error?: string }
export interface WorkbenchPreferenceUpdate { baseVersion: string; preferences: WorkbenchPreferences }
/** Surface placements are deliberately separate from the retained command registry. */
export const DEFAULT_WORKBENCH_ITEMS: WorkbenchToolPlacement[] = registry.defaults.map(item => ({ ...item, group: WORKBENCH_ACTIONS.find(action => action.id === item.actionId)?.group })) as WorkbenchToolPlacement[];
export const WORKBENCH_SURFACE_IDS = DEFAULT_WORKBENCH_ITEMS.map(item => item.actionId);
export const DEFAULT_WORKBENCH_PANE_SIZES: WorkbenchPaneSizes = { leftWidth: 27, rightWidth: 340, canvasHeight: 0, previewHeight: 220 };
/** Percent for the left pane, CSS pixels for the other panes. Zero canvas height means automatic. */
export const WORKBENCH_PANE_LIMITS = { leftWidth: { min: 1, max: 80 }, rightWidth: { min: 28, max: 1200 }, canvasHeight: { min: 28, max: 3200 }, previewHeight: { min: 28, max: 1600 }, activePreviewHeight: { min: 160, max: 520 } } as const;
export function clampWorkbenchPaneSize(key: keyof WorkbenchPaneSizes, value: number): number {
  if (key === 'canvasHeight' && value === 0) return 0;
  const limit = WORKBENCH_PANE_LIMITS[key];
  return Number.isFinite(value) ? Math.max(limit.min, Math.min(limit.max, Math.round(value))) : DEFAULT_WORKBENCH_PANE_SIZES[key] ?? 220;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value: unknown, fallback: number, low: number, high: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
/** Only the untouched built-in profile adopts the new compact default order.
 * Named profiles, changed spans/groups/breaks and explicit holes stay custom. */
export function isPreviousBuiltinWorkbenchItems(value: unknown): boolean {
  return [registry.previousDefaults,registry.previousCompactDefaults,registry.previousSelectionDefaults,registry.previousRenderDefaults,registry.previousActionWidthDefaults].some(previous=>Array.isArray(value) && value.length === previous.length && value.every((item, index) => {
    if (!record(item)) return false;
    const old = previous[index] as { actionId: string; span: number; breakAfter?: boolean };
    const group = WORKBENCH_ACTIONS.find(action => action.id === old.actionId)?.group;
    return item.actionId === old.actionId && item.span === old.span && Boolean(item.breakAfter) === Boolean(old.breakAfter) && item.row === undefined && item.column === undefined && item.rowSpan === undefined && (item.group === undefined || item.group === group);
  }));
}
export function normalizeWorkbenchItems(value: unknown, sourceVersion: 1 | 2 | 3 = 3): WorkbenchToolPlacement[] {
  const seen = new Set<string>(); const items: WorkbenchToolPlacement[] = [];
  const append = (action: WorkbenchActionDefinition, source: Record<string, unknown> = {}, migrated = false) => {
    if (seen.has(action.id)) return; seen.add(action.id);
    const previousFullBlock = sourceVersion === 1 && source.span === 3 && action.kind === 'block';
    const span = (sourceVersion < 3 ? action.lockedSpan : undefined) ?? (previousFullBlock ? 4 : !migrated && [1, 2, 3, 4].includes(source.span as number) ? source.span as WorkbenchToolPlacement['span'] : action.span);
    const grid = sourceVersion === 3 && !migrated && Number.isInteger(source.row) && Number.isInteger(source.column) ? { row: clamp(source.row, 1, 1, 2048), column: clamp(source.column, 1, 1, 5 - span) } : {};
    items.push({ actionId: action.id, span, group: safeId(source.group) ? source.group as string : action.group, ...(source.breakAfter === true ? { breakAfter: true } : {}), ...grid, ...(sourceVersion === 3 && Number.isInteger(source.rowSpan) ? { rowSpan: clamp(source.rowSpan, 1, 1, 16) } : {}) });
  };
  // Old v1 group layouts have no dotted button IDs. Preserve their group order,
  // expand each whole group in place, then append tools added after that profile.
  const legacyGroups = ['view', 'elements', 'selection', 'measurement', 'clean', 'dynamics', 'bonds', 'geometry', 'fragments', 'display'];
  const legacy = sourceVersion < 3 && Array.isArray(value) && value.length > 0 && value.every(item => record(item) && legacyGroups.includes(item.actionId as string));
  if (Array.isArray(value)) for (const item of value.slice(0, 100)) {
    if (!record(item) || typeof item.actionId !== 'string') continue;
    const migration = Object.hasOwn(registry.migrations, item.actionId) ? (registry.migrations as Record<string, string[]>)[item.actionId] : undefined;
    if (migration) {
      const actions = migration.flatMap(id => { const action = WORKBENCH_ACTIONS.find(entry => entry.id === id && WORKBENCH_SURFACE_IDS.includes(entry.id)); return action ? [action] : []; });
      // A replaced tile's trailing empty-row intent belongs after the whole
      // replacement, not after every category button. Custom group survives.
      // A one-to-one v3 alias changes only its command ID. Keep the user's
      // legal width/height and explicit empty-cell coordinates exactly.
      actions.forEach((action,index)=>append(action,{...item,breakAfter:index===actions.length-1?item.breakAfter:undefined},!(sourceVersion===3&&actions.length===1)));
      continue;
    }
    const definition = WORKBENCH_ACTIONS.find(action => action.id === item.actionId && WORKBENCH_SURFACE_IDS.includes(action.id));
    if (legacy || !definition) {
      const expansion = WORKBENCH_ACTIONS.filter(action => WORKBENCH_SURFACE_IDS.includes(action.id) && action.legacyGroup === item.actionId);
      if (expansion.length) { expansion.forEach((action,index)=>append(action,{...item,breakAfter:index===expansion.length-1?item.breakAfter:undefined},true)); continue; }
    }
    if (definition) append(definition, item);
  }
  for (const item of DEFAULT_WORKBENCH_ITEMS) if (!seen.has(item.actionId)) items.push({ ...item });
  return items;
}
export function normalizeWorkbenchLayout(value: unknown, fallbackId = 'default', sourceVersion: 1 | 2 | 3 = 3): WorkbenchLayout {
  const source = record(value) ? value : {}; const sizes = record(source.paneSizes) ? source.paneSizes : {};
  const folds: Record<string, boolean> = { 'input.coordinates': true, 'input.preview': false };
  if (record(source.folds)) for (const [key, val] of Object.entries(source.folds).slice(0, 64)) {
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof val === 'boolean') folds[key] = val;
  }
  return {
    id: safeId(source.id) ? source.id as string : fallbackId,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 80) : '默认布局',
    items: normalizeWorkbenchItems(source.id === 'default' && (source.name === undefined || source.name === '默认布局') && isPreviousBuiltinWorkbenchItems(source.items) ? DEFAULT_WORKBENCH_ITEMS : source.items, sourceVersion),
    paneSizes: { ...Object.fromEntries(Object.keys(DEFAULT_WORKBENCH_PANE_SIZES).map(key => [key, clampWorkbenchPaneSize(key as keyof WorkbenchPaneSizes, typeof sizes[key] === 'number' ? sizes[key] as number : DEFAULT_WORKBENCH_PANE_SIZES[key as keyof WorkbenchPaneSizes]??220)])), ...(Object.hasOwn(sizes,'activePreviewHeight')?{activePreviewHeight:clampWorkbenchPaneSize('activePreviewHeight',typeof sizes.activePreviewHeight==='number'?sizes.activePreviewHeight:220)}:{}) } as unknown as WorkbenchPaneSizes, folds,
  };
}
export function createDefaultWorkbenchPreferences(): WorkbenchPreferences {
  return { schemaVersion: 3, defaultLayoutId: 'default', layouts: [normalizeWorkbenchLayout(null)] };
}
/** Unknown/future schemas fail closed to a usable layout; partial v1 records migrate by supplementation. */
export function normalizeWorkbenchPreferences(value: unknown): WorkbenchPreferences {
  if (!record(value) || ![1, 2, 3].includes(value.schemaVersion as number) || !Array.isArray(value.layouts)) return createDefaultWorkbenchPreferences();
  const seen = new Set<string>(); const layouts: WorkbenchLayout[] = [];
  for (const candidate of value.layouts.slice(0, 32)) {
    if (!record(candidate) || !safeId(candidate.id) || seen.has(candidate.id as string)) continue;
    const layout = normalizeWorkbenchLayout(candidate, 'default', value.schemaVersion as 1 | 2 | 3); seen.add(layout.id); layouts.push(layout);
  }
  if (!layouts.length) return createDefaultWorkbenchPreferences();
  return { schemaVersion: 3, defaultLayoutId: typeof value.defaultLayoutId === 'string' && seen.has(value.defaultLayoutId) ? value.defaultLayoutId : layouts[0].id, layouts };
}
export const validateWorkbenchPreferences = normalizeWorkbenchPreferences;
export function getDefaultWorkbenchLayout(preferences: WorkbenchPreferences): WorkbenchLayout {
  const safe = normalizeWorkbenchPreferences(preferences); return safe.layouts.find(item => item.id === safe.defaultLayoutId)!;
}
/** Runtime policy: retain legacy records, but never apply custom tool geometry. */
export function fixedWorkbenchToolLayout(value: unknown): WorkbenchLayout {
  const layout=normalizeWorkbenchLayout(value);
  return {...layout,items:DEFAULT_WORKBENCH_ITEMS.map(item=>({...item}))};
}
export function moveWorkbenchTool(items: WorkbenchToolPlacement[], actionId: string, targetIndex: number): WorkbenchToolPlacement[] {
  const result = normalizeWorkbenchItems(items); const index = result.findIndex(item => item.actionId === actionId);
  if (index < 0 || !Number.isFinite(targetIndex)) return result;
  const [entry] = result.splice(index, 1); result.splice(Math.max(0, Math.min(result.length, Math.trunc(targetIndex))), 0, entry); return result;
}
