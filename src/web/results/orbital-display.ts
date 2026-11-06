import type { ViewportOrbitalLayer } from '../../results/orbital-contracts';
import { DEFAULT_MESH_FINISH } from '../../results/mesh-appearance';

import type { SurfaceAppearancePresetId } from '../../results/surface-appearance-presets';
import { applySurfaceAppearancePreset } from '../../results/surface-appearance-presets';
export type OrbitalLayerSettings = Pick<ViewportOrbitalLayer,'visible'|'phase'|'isovalue'|'positiveColor'|'negativeColor'|'opacity'|'finish'> & { appearancePreset?: SurfaceAppearancePresetId | 'custom' };
export const ORBITAL_COLOR_PRESETS = Object.freeze([
  { id:'red-blue', label:'红 / 蓝', positiveColor:'#d04b4b', negativeColor:'#3976d2' },
  { id:'teal-purple', label:'青 / 紫', positiveColor:'#16a6a0', negativeColor:'#8b63c7' },
  { id:'orange-blue', label:'橙 / 蓝', positiveColor:'#df8c2c', negativeColor:'#3976d2' },
] as const);
export const DEFAULT_ORBITAL_LAYER: Readonly<OrbitalLayerSettings> = Object.freeze(applySurfaceAppearancePreset({ visible:true,phase:'both' as const,isovalue:.03,
  positiveColor:ORBITAL_COLOR_PRESETS[0].positiveColor,negativeColor:ORBITAL_COLOR_PRESETS[0].negativeColor,opacity:.8,finish:DEFAULT_MESH_FINISH }, 'gallery-orbital'));
export function orbitalColorPreset(value: Pick<OrbitalLayerSettings,'positiveColor'|'negativeColor'>): string {
  return ORBITAL_COLOR_PRESETS.find(row=>row.positiveColor.toLowerCase()===value.positiveColor.toLowerCase()&&row.negativeColor.toLowerCase()===value.negativeColor.toLowerCase())?.id??'custom';
}
