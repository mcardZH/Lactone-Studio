import { applySurfaceAppearancePreset, customizeSurfaceAppearance, surfaceAppearancePreset, surfaceAppearanceFamily, type SurfaceAppearancePresetId } from '../../results/surface-appearance-presets';
import type {MeshFinishSettings} from '../../results/mesh-appearance';
import type { OrbitalLayerSettings } from './orbital-display';
import type { ExcitationDensityDisplay } from './excitation-controls-contracts';
import type { SurfaceDisplaySettings } from './surface-controls-contracts';
import type { InteractionDisplaySettings } from './interaction-controls-contracts';
import type { LocalAppearanceId } from './SurfaceAppearanceControls';

export function orbitalAppearance(value: OrbitalLayerSettings, id: LocalAppearanceId): OrbitalLayerSettings {
  return id === 'custom' ? customizeSurfaceAppearance(value) : applySurfaceAppearancePreset(value, id);
}
export function excitationDensityAppearance(value: ExcitationDensityDisplay, id: LocalAppearanceId): ExcitationDensityDisplay {
  if (id === 'custom') return customizeSurfaceAppearance(value);
  const row = surfaceAppearancePreset(id)!;
  return { ...value, appearancePreset: id, holeColor: row.negativeColor, electronColor: row.positiveColor, finish: { ...row.finish },...(row.opacity===undefined?{}:{opacity:row.opacity}) };
}
export function mappedSurfaceAppearance(value: SurfaceDisplaySettings, id: LocalAppearanceId): SurfaceDisplaySettings {
  if (id === 'custom') return customizeSurfaceAppearance(value);
  const row = surfaceAppearancePreset(id)!;
  if (surfaceAppearanceFamily(id) === 'density') return { ...value, appearancePreset: id, coloring:'solid', solidColor:row.positiveColor, finish:{...row.finish},...(row.opacity===undefined?{}:{opacity:row.opacity}) };
  return { ...value, appearancePreset: id, coloring:'mapped', colors: [row.lowColor, row.middleColor, row.highColor], reverse:false, finish: { ...row.finish },...(row.opacity===undefined?{}:{opacity:row.opacity}) };
}
export function interactionAppearance(value: InteractionDisplaySettings, id: LocalAppearanceId): InteractionDisplaySettings {
  if (id === 'custom') return customizeSurfaceAppearance(value);
  const row = surfaceAppearancePreset(id)!;
  return { ...value, appearancePreset: id, color: value.color ? { ...value.color, colors: [row.lowColor, row.middleColor, row.highColor], reverse:false } : null, finish: { ...row.finish },...(row.opacity===undefined?{}:{opacity:row.opacity}) };
}
export function hirshfeldAppearance<T extends {opacity:number;finish?:MeshFinishSettings;reverse:boolean;colors?:readonly string[]}>(value:T,id:LocalAppearanceId):T&{appearancePreset:LocalAppearanceId}{
  if(id==='custom')return customizeSurfaceAppearance(value);
  const row=surfaceAppearancePreset(id);if(!row||surfaceAppearanceFamily(id)!=='hirshfeld')throw new Error('未知Hirshfeld表面外观。');
  return {...value,appearancePreset:id,colors:[row.lowColor,row.middleColor,row.highColor],reverse:false,finish:{...row.finish},...(row.opacity===undefined?{}:{opacity:row.opacity})};
}
export const defaultSurfaceAppearanceFor = (family: 'orbital' | 'electron-hole' | 'surface' | 'iri' | 'igmh'): SurfaceAppearancePresetId => family === 'electron-hole' ? 'gallery-dual' : family === 'surface' ? 'gallery-esp' : `gallery-${family}`;
