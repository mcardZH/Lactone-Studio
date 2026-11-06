// Generated from src/modeling/workbench-layout.ts; SHA256 b8eccf617b228a17b96469ba8a7d1c302049ec3ad25f7e58b18241cebfa6c617
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateWorkbenchPreferences = exports.WORKBENCH_PANE_LIMITS = exports.DEFAULT_WORKBENCH_PANE_SIZES = exports.WORKBENCH_SURFACE_IDS = exports.DEFAULT_WORKBENCH_ITEMS = exports.WORKBENCH_ACTION_IDS = exports.WORKBENCH_ACTIONS = void 0;
exports.clampWorkbenchPaneSize = clampWorkbenchPaneSize;
exports.isPreviousBuiltinWorkbenchItems = isPreviousBuiltinWorkbenchItems;
exports.normalizeWorkbenchItems = normalizeWorkbenchItems;
exports.normalizeWorkbenchLayout = normalizeWorkbenchLayout;
exports.createDefaultWorkbenchPreferences = createDefaultWorkbenchPreferences;
exports.normalizeWorkbenchPreferences = normalizeWorkbenchPreferences;
exports.getDefaultWorkbenchLayout = getDefaultWorkbenchLayout;
exports.fixedWorkbenchToolLayout = fixedWorkbenchToolLayout;
exports.moveWorkbenchTool = moveWorkbenchTool;
const workbench_actions_json_1 = __importDefault(require("./workbench-actions.json"));
exports.WORKBENCH_ACTIONS = workbench_actions_json_1.default.actions;
exports.WORKBENCH_ACTION_IDS = exports.WORKBENCH_ACTIONS.map(action => action.id);
/** Surface placements are deliberately separate from the retained command registry. */
exports.DEFAULT_WORKBENCH_ITEMS = workbench_actions_json_1.default.defaults.map(item => ({ ...item, group: exports.WORKBENCH_ACTIONS.find(action => action.id === item.actionId)?.group }));
exports.WORKBENCH_SURFACE_IDS = exports.DEFAULT_WORKBENCH_ITEMS.map(item => item.actionId);
exports.DEFAULT_WORKBENCH_PANE_SIZES = { leftWidth: 27, rightWidth: 340, canvasHeight: 0, previewHeight: 220 };
/** Percent for the left pane, CSS pixels for the other panes. Zero canvas height means automatic. */
exports.WORKBENCH_PANE_LIMITS = { leftWidth: { min: 1, max: 80 }, rightWidth: { min: 28, max: 1200 }, canvasHeight: { min: 28, max: 3200 }, previewHeight: { min: 28, max: 1600 }, activePreviewHeight: { min: 160, max: 520 } };
function clampWorkbenchPaneSize(key, value) {
    if (key === 'canvasHeight' && value === 0)
        return 0;
    const limit = exports.WORKBENCH_PANE_LIMITS[key];
    return Number.isFinite(value) ? Math.max(limit.min, Math.min(limit.max, Math.round(value))) : exports.DEFAULT_WORKBENCH_PANE_SIZES[key] ?? 220;
}
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, fallback, low, high) => typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
/** Only the untouched built-in profile adopts the new compact default order.
 * Named profiles, changed spans/groups/breaks and explicit holes stay custom. */
function isPreviousBuiltinWorkbenchItems(value) {
    return [workbench_actions_json_1.default.previousDefaults, workbench_actions_json_1.default.previousCompactDefaults, workbench_actions_json_1.default.previousSelectionDefaults, workbench_actions_json_1.default.previousRenderDefaults, workbench_actions_json_1.default.previousActionWidthDefaults].some(previous => Array.isArray(value) && value.length === previous.length && value.every((item, index) => {
        if (!record(item))
            return false;
        const old = previous[index];
        const group = exports.WORKBENCH_ACTIONS.find(action => action.id === old.actionId)?.group;
        return item.actionId === old.actionId && item.span === old.span && Boolean(item.breakAfter) === Boolean(old.breakAfter) && item.row === undefined && item.column === undefined && item.rowSpan === undefined && (item.group === undefined || item.group === group);
    }));
}
function normalizeWorkbenchItems(value, sourceVersion = 3) {
    const seen = new Set();
    const items = [];
    const append = (action, source = {}, migrated = false) => {
        if (seen.has(action.id))
            return;
        seen.add(action.id);
        const previousFullBlock = sourceVersion === 1 && source.span === 3 && action.kind === 'block';
        const span = (sourceVersion < 3 ? action.lockedSpan : undefined) ?? (previousFullBlock ? 4 : !migrated && [1, 2, 3, 4].includes(source.span) ? source.span : action.span);
        const grid = sourceVersion === 3 && !migrated && Number.isInteger(source.row) && Number.isInteger(source.column) ? { row: clamp(source.row, 1, 1, 2048), column: clamp(source.column, 1, 1, 5 - span) } : {};
        items.push({ actionId: action.id, span, group: safeId(source.group) ? source.group : action.group, ...(source.breakAfter === true ? { breakAfter: true } : {}), ...grid, ...(sourceVersion === 3 && Number.isInteger(source.rowSpan) ? { rowSpan: clamp(source.rowSpan, 1, 1, 16) } : {}) });
    };
    // Old v1 group layouts have no dotted button IDs. Preserve their group order,
    // expand each whole group in place, then append tools added after that profile.
    const legacyGroups = ['view', 'elements', 'selection', 'measurement', 'clean', 'dynamics', 'bonds', 'geometry', 'fragments', 'display'];
    const legacy = sourceVersion < 3 && Array.isArray(value) && value.length > 0 && value.every(item => record(item) && legacyGroups.includes(item.actionId));
    if (Array.isArray(value))
        for (const item of value.slice(0, 100)) {
            if (!record(item) || typeof item.actionId !== 'string')
                continue;
            const migration = Object.hasOwn(workbench_actions_json_1.default.migrations, item.actionId) ? workbench_actions_json_1.default.migrations[item.actionId] : undefined;
            if (migration) {
                const actions = migration.flatMap(id => { const action = exports.WORKBENCH_ACTIONS.find(entry => entry.id === id && exports.WORKBENCH_SURFACE_IDS.includes(entry.id)); return action ? [action] : []; });
                // A replaced tile's trailing empty-row intent belongs after the whole
                // replacement, not after every category button. Custom group survives.
                // A one-to-one v3 alias changes only its command ID. Keep the user's
                // legal width/height and explicit empty-cell coordinates exactly.
                actions.forEach((action, index) => append(action, { ...item, breakAfter: index === actions.length - 1 ? item.breakAfter : undefined }, !(sourceVersion === 3 && actions.length === 1)));
                continue;
            }
            const definition = exports.WORKBENCH_ACTIONS.find(action => action.id === item.actionId && exports.WORKBENCH_SURFACE_IDS.includes(action.id));
            if (legacy || !definition) {
                const expansion = exports.WORKBENCH_ACTIONS.filter(action => exports.WORKBENCH_SURFACE_IDS.includes(action.id) && action.legacyGroup === item.actionId);
                if (expansion.length) {
                    expansion.forEach((action, index) => append(action, { ...item, breakAfter: index === expansion.length - 1 ? item.breakAfter : undefined }, true));
                    continue;
                }
            }
            if (definition)
                append(definition, item);
        }
    for (const item of exports.DEFAULT_WORKBENCH_ITEMS)
        if (!seen.has(item.actionId))
            items.push({ ...item });
    return items;
}
function normalizeWorkbenchLayout(value, fallbackId = 'default', sourceVersion = 3) {
    const source = record(value) ? value : {};
    const sizes = record(source.paneSizes) ? source.paneSizes : {};
    const folds = { 'input.coordinates': true, 'input.preview': false };
    if (record(source.folds))
        for (const [key, val] of Object.entries(source.folds).slice(0, 64)) {
            if (/^[a-zA-Z0-9_.-]{1,64}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof val === 'boolean')
                folds[key] = val;
        }
    return {
        id: safeId(source.id) ? source.id : fallbackId,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 80) : '默认布局',
        items: normalizeWorkbenchItems(source.id === 'default' && (source.name === undefined || source.name === '默认布局') && isPreviousBuiltinWorkbenchItems(source.items) ? exports.DEFAULT_WORKBENCH_ITEMS : source.items, sourceVersion),
        paneSizes: { ...Object.fromEntries(Object.keys(exports.DEFAULT_WORKBENCH_PANE_SIZES).map(key => [key, clampWorkbenchPaneSize(key, typeof sizes[key] === 'number' ? sizes[key] : exports.DEFAULT_WORKBENCH_PANE_SIZES[key] ?? 220)])), ...(Object.hasOwn(sizes, 'activePreviewHeight') ? { activePreviewHeight: clampWorkbenchPaneSize('activePreviewHeight', typeof sizes.activePreviewHeight === 'number' ? sizes.activePreviewHeight : 220) } : {}) }, folds,
    };
}
function createDefaultWorkbenchPreferences() {
    return { schemaVersion: 3, defaultLayoutId: 'default', layouts: [normalizeWorkbenchLayout(null)] };
}
/** Unknown/future schemas fail closed to a usable layout; partial v1 records migrate by supplementation. */
function normalizeWorkbenchPreferences(value) {
    if (!record(value) || ![1, 2, 3].includes(value.schemaVersion) || !Array.isArray(value.layouts))
        return createDefaultWorkbenchPreferences();
    const seen = new Set();
    const layouts = [];
    for (const candidate of value.layouts.slice(0, 32)) {
        if (!record(candidate) || !safeId(candidate.id) || seen.has(candidate.id))
            continue;
        const layout = normalizeWorkbenchLayout(candidate, 'default', value.schemaVersion);
        seen.add(layout.id);
        layouts.push(layout);
    }
    if (!layouts.length)
        return createDefaultWorkbenchPreferences();
    return { schemaVersion: 3, defaultLayoutId: typeof value.defaultLayoutId === 'string' && seen.has(value.defaultLayoutId) ? value.defaultLayoutId : layouts[0].id, layouts };
}
exports.validateWorkbenchPreferences = normalizeWorkbenchPreferences;
function getDefaultWorkbenchLayout(preferences) {
    const safe = normalizeWorkbenchPreferences(preferences);
    return safe.layouts.find(item => item.id === safe.defaultLayoutId);
}
/** Runtime policy: retain legacy records, but never apply custom tool geometry. */
function fixedWorkbenchToolLayout(value) {
    const layout = normalizeWorkbenchLayout(value);
    return { ...layout, items: exports.DEFAULT_WORKBENCH_ITEMS.map(item => ({ ...item })) };
}
function moveWorkbenchTool(items, actionId, targetIndex) {
    const result = normalizeWorkbenchItems(items);
    const index = result.findIndex(item => item.actionId === actionId);
    if (index < 0 || !Number.isFinite(targetIndex))
        return result;
    const [entry] = result.splice(index, 1);
    result.splice(Math.max(0, Math.min(result.length, Math.trunc(targetIndex))), 0, entry);
    return result;
}
