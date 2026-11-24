import {useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {useProjectState, useProjectUiScope, type ProjectUiStore} from '../../projects/ui-state';
import {builtinPlotPresets, plotStyleForPreset, type PlotFamily, type PlotFigureEdits, type PlotPaneEdits, type PlotStyle} from '../../results/scientific-plot-editing';
import type {PlotAppearance} from './ScientificPlotSettings';
import type {ScientificPlotViewport} from '../../results/scientific-plot';

const empty: PlotFigureEdits = Object.freeze({});

interface PlotHistory {past: PlotFigureEdits[]; future: PlotFigureEdits[]; group?: string}
const projectHistories = new WeakMap<ProjectUiStore, {generation: number; figures: Map<string, PlotHistory>}>();
const figureField = 'plot.figure-v1';
const newHistory = (): PlotHistory => ({past: [], future: []});

/** Preset defaults are applied once per figure. Views of the same saved figure share its undo history. */
export function usePlotFigure(key: string | number, initial: PlotFigureEdits = empty) {
  const context = useProjectUiScope();
  const storageKey = JSON.stringify([...(context?.scope ?? []), figureField, key]);
  const seed = useMemo(() => initial, [storageKey, context?.store, context?.generation]);
  const [saved, setFigure] = useProjectState(figureField, seed, key);
  const figure = saved.style || !seed.style ? saved : {...seed, ...saved};
  useEffect(() => {
    if (seed.style && !saved.style) setFigure(previous => previous.style ? previous : {...seed, ...previous});
  }, [saved.style, seed, setFigure]);
  const current = useRef(figure);
  current.current = figure;
  const stack = useMemo(() => {
    if (!context) return newHistory();
    const {store, generation} = context;
    let project = projectHistories.get(store);
    if (!project || project.generation !== generation) {
      project = {generation, figures: new Map()};
      projectHistories.set(store, project);
    }
    let history = project.figures.get(storageKey);
    if (!history) {
      history = newHistory();
      project.figures.set(storageKey, history);
    }
    return history;
  }, [storageKey, context?.store, context?.generation]);
  const readCurrent = () => context?.store.get(storageKey, current.current) ?? current.current;
  function write(next: PlotFigureEdits) {
    current.current = next;
    setFigure(next);
  }
  return {
    figure,
    canUndo: stack.past.length > 0,
    canRedo: stack.future.length > 0,
    initializeStyle(style: PlotStyle, presetId?: string) {
      const previous = readCurrent();
      if (!previous.style) write({...previous, style, presetId:previous.presetId ?? presetId});
    },
    endGroup() { stack.group = undefined; },
    replace(change: PlotFigureEdits | ((previous: PlotFigureEdits) => PlotFigureEdits), group?: string) {
      const old = readCurrent(), next = typeof change === 'function' ? change(old) : change;
      if (old === next) return;
      if (!group || stack.group !== group) stack.past.push(old);
      stack.group = group;
      stack.future.length = 0;
      write(next);
    },
    undo() {
      const previous = stack.past.pop();
      if (!previous) return;
      stack.group = undefined;
      stack.future.push(readCurrent());
      write(previous);
    },
    redo() {
      const next = stack.future.pop();
      if (!next) return;
      stack.group = undefined;
      stack.past.push(readCurrent());
      write(next);
    },
  };
}

export type PlotFigureRecord = ReturnType<typeof usePlotFigure>;

export const plotTextInput = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.(
  'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type=checkbox], [type=radio], [type=color], [type=range], [type=button])'));

/** Box zoom shares the figure undo stack. View Back only follows the viewport trail. */
export function figureViewport(record:ReturnType<typeof usePlotFigure>, base:ScientificPlotViewport|null,
  restored?:ScientificPlotViewport|null,scope?:string|number) {
  const state=record.figure.zoom?.scope===scope && record.figure.zoom || {range:restored??null,back:[]};
  const set=(range:ScientificPlotViewport|null,back:(ScientificPlotViewport|null)[]) =>
    record.replace(previous=>({...previous,zoom:{scope,range,back}}));
  return {
    viewport:state.range??base, zoomed:!!state.range, canGoBack:state.back.length>0,
    zoom(range:ScientificPlotViewport) {set(range,[...state.back,state.range]);},
    back() {if(state.back.length) set(state.back.at(-1)??null,state.back.slice(0,-1));},
    reset(change?: Pick<PlotFigureEdits, 'scatterShowAll'>) {
      if (!state.range && !change) return;
      record.replace(previous => ({...previous, ...change,
        ...(state.range ? {zoom: {scope, range: null, back: [...state.back, state.range]}} : {})}));
    },
  };
}

interface NamedPlotPreset {id: string; label: string; style: PlotStyle}
interface PlotPresetPreferences {presets: NamedPlotPreset[]; defaultId?: string; defaults?: Record<string, string>}
const preferenceKey = (family: PlotFamily) => `sciyue.plot-presets.${family}.v1`;
const presetListeners = new Set<() => void>();
const notifyPresets = () => presetListeners.forEach(listener => listener());
function subscribePresets(listener: () => void) {
  presetListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {presetListeners.delete(listener); window.removeEventListener('storage', listener);};
}

function readPresetText(family: PlotFamily) {
  try {return window.localStorage.getItem(preferenceKey(family));} catch {return null;}
}

function read(raw: string | null): PlotPresetPreferences {
  try {
    if (!raw) return {presets: []};
    const value = JSON.parse(raw) as PlotPresetPreferences;
    return Array.isArray(value.presets) ? value : {presets: []};
  } catch { return {presets: []}; }
}

export function usePlotPresetLibrary(family: PlotFamily, defaultScope?: string) {
  const raw = useSyncExternalStore(subscribePresets, () => readPresetText(family), () => null);
  const preferences = useMemo(() => read(raw), [raw]);
  const builtins = builtinPlotPresets(family);
  const wanted = defaultScope ? preferences.defaults?.[defaultScope] ?? preferences.defaultId : preferences.defaultId;
  const defaultId = [...builtins, ...preferences.presets].find(preset => preset.id === wanted)?.id ?? builtins[0].id;
  function store(value: PlotPresetPreferences) {
    window.localStorage.setItem(preferenceKey(family), JSON.stringify(value));
    notifyPresets();
  }
  return {
    family, builtins, personal: preferences.presets, defaultId,
    reload: notifyPresets,
    style(id = defaultId): PlotStyle {
      return preferences.presets.find(preset => preset.id === id)?.style ?? plotStyleForPreset(family, id);
    },
    save(name: string, style: PlotStyle) {
      const label = name.trim(), existing = read(readPresetText(family));
      if (!label) throw new Error('请输入预设名称。');
      if ([...builtins, ...existing.presets].some(preset => preset.label === label)) throw new Error('此预设名称已存在。');
      const entry = {id: `user-${crypto.randomUUID()}`, label, style};
      store({...existing, presets: [...existing.presets, entry]});
      return entry.id;
    },
    makeDefault(id: string) {
      const existing = read(readPresetText(family));
      store(defaultScope ? {...existing, defaults: {...existing.defaults, [defaultScope]: id}} : {...existing, defaultId:id});
    },
  };
}

export type PlotPresetLibrary = ReturnType<typeof usePlotPresetLibrary>;

export function plotPresetSnapshot(style: PlotStyle, pane: PlotPaneEdits): PlotStyle {
  const fonts = {...style.fonts};
  for (const role of Object.keys(fonts) as (keyof typeof fonts)[]) fonts[role] = {...fonts[role], ...pane.text?.[role]?.font};
  return {...style, fonts, showLegend:pane.showLegend??style.showLegend, showZero:pane.showZero??style.showZero};
}

export function applyPlotPreset(pane: PlotPaneEdits, presetId: string, style: PlotStyle): Partial<PlotPaneEdits> {
  const text = {...pane.text};
  for (const role of Object.keys(style.fonts)) if (text[role]?.font) text[role] = {...text[role], font: undefined};
  return {presetId, style, text, series: {}, showLegend:undefined, showZero:undefined};
}

/** Old project settings still provide font overrides until a chart has an edit style. */
export function fallbackPlotStyle(library: PlotPresetLibrary, legacy: Partial<PlotAppearance>) {
  const style = structuredClone(library.style(legacy.linePreset ?? library.defaultId));
  const font = legacy.font;
  if (font) for (const role of Object.keys(style.fonts) as (keyof PlotStyle['fonts'])[]) style.fonts[role].font = font;
  if (legacy.titleSize !== undefined) style.fonts.title.size = legacy.titleSize;
  if (legacy.axisSize !== undefined) {
    style.fonts.x.size = legacy.axisSize;
    style.fonts.y.size = legacy.yAxisSize ?? legacy.axisSize;
  }
  if (legacy.tickSize !== undefined) style.fonts.ticks.size = legacy.tickSize;
  if (legacy.legendSize !== undefined) style.fonts.legend.size = legacy.legendSize;
  if (legacy.annotationSize !== undefined) style.fonts.annotation.size = legacy.annotationSize;
  return style;
}
