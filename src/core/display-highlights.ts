import type { CoordinateGuide } from './geometry-guides';
import type { MoleculeRegion } from './regions';
import {fragmentColor} from './regions';
import type {GaussianSettings,Structure} from './types';

/** Display-only, zero-based indices. Turning these layers off never edits job settings. */
export interface DisplayCoordinate extends CoordinateGuide { id: string; label?: string }
export interface ViewerHighlights {
  fragments?: MoleculeRegion[];
  basis?: MoleculeRegion[];
  layers?: MoleculeRegion[];
  scan?: DisplayCoordinate[];
  frozenCoordinates?: DisplayCoordinate[];
  frozenAtoms?: number[];
}
export type BaseColorMode = 'elements' | 'fragments' | 'basis' | 'layers';
export const SCAN_COLOR = '#226fc0';
export const FREEZE_COLOR = '#236dcc';
export function availableColorModes(highlights: ViewerHighlights): BaseColorMode[] {
  return ['elements', ...(['fragments', 'basis', 'layers'] as const).filter(mode => !!highlights[mode]?.length)] as BaseColorMode[];
}
export function displayedRegions(highlights: ViewerHighlights, mode: BaseColorMode): MoleculeRegion[] {
  return mode === 'elements' ? [] : highlights[mode] ?? [];
}
export function validDisplayAtoms(indices: number[], count: number): number[] {
  return [...new Set(indices)].filter(index => Number.isSafeInteger(index) && index >= 0 && index < count);
}
export function defaultColorMode(highlights: ViewerHighlights): BaseColorMode {
  return (['fragments', 'basis', 'layers'] as const).find(mode => highlights[mode]?.length) ?? 'elements';
}
/** The global basis owns every center not explicitly overridden, not an unassigned fragment. */
export function basisDisplayRegions(structure:Structure|null,settings:GaussianSettings):MoleculeRegion[]{
  if(!structure||!settings.mixedBasis?.enabled)return [];
  const assigned=new Set(settings.mixedBasis.regions.flatMap(region=>region.atoms));
  const regions=settings.mixedBasis.regions.map((region,index)=>({id:region.id,label:region.name+' · '+region.basis,color:fragmentColor(index+5),atomIndices:region.atoms.map(i=>i-1)}));
  const remaining=structure.atoms.flatMap((_,index)=>assigned.has(index+1)?[]:[index]);
  return [...regions,...(remaining.length?[{id:'basis-global-remainder',label:'全局基组 · '+settings.basis,color:'#578aa7',atomIndices:remaining}]:[])];
}
