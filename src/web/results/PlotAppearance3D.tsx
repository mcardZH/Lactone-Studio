import { useEffect, useState } from 'react';
import type { Atom } from '../../core/types';
import type { DisplaySettings } from '../../modeling/contracts';
import { createDefaultModelDisplay } from '../../modeling/platform/display-preferences';
import type { MeshAppearanceSnapshot, SurfaceDisplayFamily } from '../../results/platform/surface-display-preferences';
import { surfaceAppearancePreset, type SurfaceAppearancePresetId } from '../../results/surface-appearance-presets';
import { appearancePreview } from '../appearance-preview-assets';
import WorkspaceDisplay from '../modeling/WorkspaceDisplay';
import { observeCanvasBackground, workspaceDefaultBackgroundColor } from '../modeling/render/viewport-background';
import MeshFinishControls from './MeshFinishControls';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import SurfaceAppearanceControls, { type LocalAppearanceId } from './SurfaceAppearanceControls';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import './plot-appearance-3d.css';

export interface PlotAppearance3DTarget {
  display: DisplaySettings;
  onChange(display: DisplaySettings): void;
  atoms?: readonly Atom[];
  showAxes?: boolean;
  onShowAxesChange?(show: boolean): void;
}

type AppearanceKind = 'molecule' | 'surface';
type MeshFamily = Exclude<SurfaceDisplayFamily, 'vibration'>;
const surfaceFamilies = {
  orbital: { label: '轨道相位', choices: ['orbital'], start: 'gallery-orbital' },
  'electron-hole': { label: '电子与空穴', choices: ['dual'], start: 'gallery-dual' },
  'surface:esp': { label: '静电势', choices: ['esp', 'density'], start: 'gallery-esp' },
  'surface:alie': { label: '平均局部电离能', choices: ['esp', 'density'], start: 'gallery-esp' },
  'surface:hirshfeld': { label: 'Hirshfeld', choices: ['hirshfeld'], start: 'gallery-hirshfeld' },
  'interaction:iri': { label: 'IRI', choices: ['iri'], start: 'gallery-iri' },
  'interaction:rdg': { label: 'RDG', choices: ['iri'], start: 'gallery-iri' },
  'interaction:igmh': { label: 'IGMH', choices: ['igmh'], start: 'gallery-igmh' },
  'interaction:igm': { label: 'IGM', choices: ['igmh'], start: 'gallery-igmh' },
  'interaction:migm': { label: 'mIGM', choices: ['igmh'], start: 'gallery-igmh' },
} as const satisfies Record<MeshFamily, { label: string; choices: readonly SurfaceAppearancePresetId[]; start: SurfaceAppearancePresetId }>;
const familyKeys = Object.keys(surfaceFamilies) as MeshFamily[];

function presetAppearance(family: MeshFamily, id: SurfaceAppearancePresetId): MeshAppearanceSnapshot {
  const preset = surfaceAppearancePreset(id)!;
  const colors = family === 'orbital' || family === 'electron-hole'
    ? [preset.positiveColor, preset.negativeColor]
    : id === 'gallery-density' ? [preset.lowColor] : [preset.lowColor, preset.middleColor, preset.highColor];
  return { presetId: id, colors, finish: { ...preset.finish }, opacity: preset.opacity ?? 1 };
}

function SurfacePresets() {
  const [family, setFamily] = useState<MeshFamily>('orbital');
  const [drafts, setDrafts] = useState<Partial<Record<MeshFamily, { appearance: MeshAppearanceSnapshot; reference: SurfaceAppearancePresetId }>>>({});
  const [name, setName] = useState<string>();
  const defaults = useSurfaceAppearanceDefaults();
  const descriptor = surfaceFamilies[family];
  const defaultAppearance = defaults.snapshot?.value[family] as MeshAppearanceSnapshot | undefined;
  const appearance = drafts[family]?.appearance ?? defaultAppearance ?? presetAppearance(family, descriptor.start);
  const savedId = appearance.presetId !== 'custom' && appearance.presetId.startsWith('gallery-') ? appearance.presetId : descriptor.start;
  const reference = drafts[family]?.reference ?? savedId;
  const preview = surfaceAppearancePreset(reference);
  const useAppearance = (value: MeshAppearanceSnapshot) => setDrafts(previous => ({
    ...previous, [family]: { appearance: value, reference: value.presetId === 'custom' ? reference : value.presetId },
  }));
  const edit = (value: Partial<MeshAppearanceSnapshot>) => useAppearance({ ...appearance, ...value, presetId: 'custom' });
  const choose = (id: LocalAppearanceId) => id === 'custom' ? edit({}) : useAppearance(presetAppearance(family, id));
  const personal = defaults.snapshot?.namedOrbitalPresets ?? [];
  const personalChoices = family === 'orbital'
    ? personal.map((entry, index) => ({ id: `personal-${index}`, label: entry.name })) : [];
  const colorLabels = family === 'orbital' ? ['正相位', '负相位'] : family === 'electron-hole' ? ['空穴', '电子']
    : appearance.colors.length === 1 ? ['单色'] : appearance.colors.length === 3 ? ['低值', '中值', '高值']
    : appearance.colors.map((_, index) => `色阶 ${index + 1}`);
  return <div className="plot-surface-presets">
    <section className="sy-settings-card plot-surface-preview" aria-label="等值面参考预览">
      <img src={appearancePreview('surface', reference)} alt={preview?.label ?? descriptor.label}/>
      <div className="plot-surface-colors" aria-label="当前配色">
        {appearance.colors.map((color, index) => <span key={index} title={colorLabels[index]} style={{ backgroundColor: color }}/>)}
      </div>
    </section>
    <section className="sy-settings-card plot-surface-controls">
      <label>等值面类别<select aria-label="等值面类别" value={family} onChange={event => {
        setName(undefined);
        setFamily(event.currentTarget.value as MeshFamily);
      }}>
        {familyKeys.map(key => <option key={key} value={key}>{surfaceFamilies[key].label}</option>)}
      </select></label>
      <SurfaceAppearanceControls label="等值面预设" presets={descriptor.choices} value={appearance.presetId} onChange={choose}
        namedPresets={personalChoices} onNamedPreset={id => {
          const entry = personal[Number(id.slice('personal-'.length))];
          if (entry) useAppearance(structuredClone(entry.appearance));
        }}
        actions={<SaveSurfaceAppearanceDefault family={family} appearance={appearance}/>}
      >
        <div className="sy-settings-fields">
          {appearance.colors.map((color, index) => <label key={index}>{colorLabels[index]}<input type="color" aria-label={`${colorLabels[index]}颜色`}
            value={color} onChange={event => {
              const colors = [...appearance.colors];
              colors[index] = event.currentTarget.value;
              edit({ colors });
            }}/></label>)}
          <label>不透明度<input aria-label="等值面不透明度" type="range" min={0} max={1} step={.01} value={appearance.opacity ?? 1}
            onChange={event => edit({ opacity: event.currentTarget.valueAsNumber })}/></label>
        </div>
        <MeshFinishControls inline labelPrefix="等值面" value={appearance.finish} onChange={finish => edit({ finish })}/>
      </SurfaceAppearanceControls>
      <div className="sy-settings-fields">
        <button type="button" onClick={() => setDrafts(previous => ({ ...previous, [family]: undefined }))}>应用此类默认</button>
        {family === 'orbital' && <button type="button" disabled={!defaults.snapshot?.writable || defaults.busy}
          onClick={() => setName('')}>保存为预设…</button>}
      </div>
      {name !== undefined && <form className="settings-preset-name" onSubmit={event => {
        event.preventDefault();
        void defaults.saveNamed(name.trim(), { ...appearance, opacity: appearance.opacity ?? 1 }).then(() => setName(undefined)).catch(() => {});
      }}>
        <label>预设名称<input aria-label="轨道预设名称" value={name} maxLength={80} onChange={event => setName(event.currentTarget.value)}/></label>
        <button type="submit" disabled={defaults.busy || !name.trim()}>保存</button>
        <button type="button" onClick={() => setName(undefined)}>取消</button>
      </form>}
    </section>
  </div>;
}

export function PlotAppearance3D({ target, ownerDocument, initialKind = 'molecule' }: {
  target?: PlotAppearance3DTarget; ownerDocument?: Document; initialKind?: AppearanceKind;
}) {
  const [kind, setKind] = useState<AppearanceKind>(initialKind);
  const [display, setDisplay] = useState(createDefaultModelDisplay);
  const [showAxes, setShowAxes] = useState(false);
  const [background, setBackground] = useState(() => ownerDocument && workspaceDefaultBackgroundColor(ownerDocument));
  useEffect(() => {
    const owner = ownerDocument ?? document;
    const refresh = () => setBackground(workspaceDefaultBackgroundColor(owner));
    refresh();
    return observeCanvasBackground(owner, refresh);
  }, [ownerDocument]);
  return <div className="plot-appearance-3d">
    <nav className="plot-edit-tabs" aria-label="三维预设类别">
      <button type="button" aria-selected={kind === 'molecule'} onClick={() => setKind('molecule')}>分子与晶胞</button>
      <button type="button" aria-selected={kind === 'surface'} onClick={() => setKind('surface')}>等值面</button>
    </nav>
    <div className="plot-appearance-model" hidden={kind !== 'molecule'}>
      <WorkspaceDisplay active={kind === 'molecule'} display={target?.display ?? display} onChange={target?.onChange ?? setDisplay}
        atoms={target?.atoms} showAxes={target?.showAxes ?? showAxes} onShowAxesChange={target?.onShowAxesChange ?? setShowAxes}
        defaultBackgroundColor={background}/>
    </div>
    <div hidden={kind !== 'surface'}><SurfacePresets/></div>
  </div>;
}
