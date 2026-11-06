import { normalizeMeshFinish, type MeshFinishSettings } from '../../results/mesh-appearance';
import {surfaceAppearanceFamily,type SurfaceAppearancePresetId,type VibrationVectorAppearance} from '../../results/surface-appearance-presets';
import type { OrbitalLayerSettings } from './orbital-display';
import type { ExcitationDensityDisplay } from './excitation-controls-contracts';
import type { SurfaceDisplaySettings } from './surface-controls-contracts';
import type { InteractionDisplaySettings } from './interaction-controls-contracts';
import { ANALYSIS_PALETTES } from './analysis-display';

/** Whitelisted appearance only. No source, range, threshold or current result. */
export interface SavedMeshAppearance { presetId: SurfaceAppearancePresetId | 'custom'; colors: string[]; finish: MeshFinishSettings; opacity?: number }
export interface SavedVectorAppearance { presetId: 'standard' | 'teal' | 'custom'; vector: VibrationVectorAppearance }
function compatiblePreset(id:SavedMeshAppearance['presetId'],family:string):SavedMeshAppearance['presetId']{return id.startsWith('gallery-')&&surfaceAppearanceFamily(id)===family?id:'custom';}
export function captureOrbitalAppearance(value: OrbitalLayerSettings): SavedMeshAppearance {
  return { presetId: value.appearancePreset ?? 'custom', colors: [value.positiveColor, value.negativeColor], finish: normalizeMeshFinish(value.finish), opacity: value.opacity };
}
export function restoreOrbitalAppearance(value: OrbitalLayerSettings, saved: SavedMeshAppearance): OrbitalLayerSettings {
  return { ...value, appearancePreset: compatiblePreset(saved.presetId,'orbital'), positiveColor: saved.colors[0], negativeColor: saved.colors[1], finish: { ...saved.finish }, ...(saved.opacity === undefined ? {} : { opacity: saved.opacity }) };
}
export function captureDensityAppearance(value: ExcitationDensityDisplay): SavedMeshAppearance {
  return { presetId: value.appearancePreset ?? 'custom', colors: [value.holeColor, value.electronColor], finish: normalizeMeshFinish(value.finish),opacity:value.opacity };
}
export function restoreDensityAppearance(value: ExcitationDensityDisplay, saved: SavedMeshAppearance): ExcitationDensityDisplay {
  return { ...value, appearancePreset: compatiblePreset(saved.presetId,'dual'), holeColor: saved.colors[0], electronColor: saved.colors[1], finish: { ...saved.finish },...(saved.opacity===undefined?{}:{opacity:saved.opacity}) };
}
export function captureMappedAppearance(value: SurfaceDisplaySettings): SavedMeshAppearance {
  if(value.coloring==='solid')return {presetId:value.appearancePreset??'custom',colors:[value.solidColor??'#66cc4d'],finish:normalizeMeshFinish(value.finish),opacity:value.opacity};
  const colors = [...(value.colors ?? ANALYSIS_PALETTES[value.palette])];
  return { presetId: value.appearancePreset ?? 'custom', colors: value.reverse ? colors.reverse() : colors, finish: normalizeMeshFinish(value.finish),opacity:value.opacity };
}
export function restoreMappedAppearance(value: SurfaceDisplaySettings, saved: SavedMeshAppearance): SurfaceDisplaySettings {
  if(saved.colors.length===1)return {...value,appearancePreset:compatiblePreset(saved.presetId,'density'),coloring:'solid',solidColor:saved.colors[0],finish:{...saved.finish},...(saved.opacity===undefined?{}:{opacity:saved.opacity})};
  return { ...value, appearancePreset: compatiblePreset(saved.presetId,'esp'), coloring:'mapped', colors: [...saved.colors], reverse: false, finish: { ...saved.finish },...(saved.opacity===undefined?{}:{opacity:saved.opacity}) };
}
export function captureInteractionAppearance(value: InteractionDisplaySettings): SavedMeshAppearance {
  const colors = [...(value.color?.colors ?? ['#0000ff', '#00ff00', '#ff0000'])];
  return { presetId: value.appearancePreset ?? 'custom', colors: value.color?.reverse ? colors.reverse() : colors, finish: normalizeMeshFinish(value.finish),opacity:value.opacity };
}
export function restoreInteractionAppearance(value: InteractionDisplaySettings, saved: SavedMeshAppearance): InteractionDisplaySettings {
  const compatible=value.component==='iri'||value.component==='rdg'?'iri':'igmh';
  return { ...value, appearancePreset: compatiblePreset(saved.presetId,compatible), color: value.color ? { ...value.color, colors: [...saved.colors], reverse: false } : null, finish: { ...saved.finish },...(saved.opacity===undefined?{}:{opacity:saved.opacity}) };
}
export function captureHirshfeldAppearance(value:{appearancePreset?:SavedMeshAppearance['presetId'];colors?:readonly string[];reverse:boolean;finish?:MeshFinishSettings;opacity:number}):SavedMeshAppearance{
  const colors=[...(value.colors??ANALYSIS_PALETTES['blue-red'])];return {presetId:value.appearancePreset??'custom',colors:value.reverse?colors.reverse():colors,finish:normalizeMeshFinish(value.finish),opacity:value.opacity};
}
export function restoreHirshfeldAppearance<T extends {reverse:boolean;finish?:MeshFinishSettings;opacity:number}>(value:T,saved:SavedMeshAppearance):T&{appearancePreset:SavedMeshAppearance['presetId'];colors:string[]}{return {...value,appearancePreset:compatiblePreset(saved.presetId,'hirshfeld'),colors:[...saved.colors],reverse:false,finish:{...saved.finish},...(saved.opacity===undefined?{}:{opacity:saved.opacity})};}
