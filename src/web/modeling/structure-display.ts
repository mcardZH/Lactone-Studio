import type { DisplaySettings } from '../../modeling/contracts';

export const DISPLAY_SCALE_LIMITS = { min: .25, max: 3 } as const;
export function displayScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(DISPLAY_SCALE_LIMITS.min, Math.min(DISPLAY_SCALE_LIMITS.max, value)) : 1;
}
/** Appearance only; never chemical radii, bond inference or forcefield input. */
export function atomDisplayScale(settings: Pick<DisplaySettings, 'atomScale' | 'elementScales'>, element: string): number {
  return displayScale(settings.atomScale) * displayScale(settings.elementScales?.[element]);
}
export function bondDisplayRadius(settings: Pick<DisplaySettings, 'representation' | 'bondScale' | 'structureSizing'>): number {
  return (settings.structureSizing?.bondRadiusAngstrom ?? (settings.representation === 'stick' ? .12 : .115)) * displayScale(settings.bondScale);
}
/** PyMOL's small-H endpoints remain spherical; avoid a wider rod hiding them. */
export function structureBondRadius(settings:DisplaySettings,a:string,b:string):number{
  const radius=bondDisplayRadius(settings);
  return settings.structureLighting?.startsWith('pymol-')&&(a==='H'||b==='H')?radius*.4:radius;
}
/** Keep the current element hue while softening a solid ball-stick connection. */
export function structureBondColor(color:string,lightening=.12):string {
  if(!/^#[0-9a-f]{6}$/i.test(color))return color;
  return '#'+[1,3,5].map(offset=>Math.round(parseInt(color.slice(offset,offset+2),16)*(1-lightening)+255*lightening).toString(16).padStart(2,'0')).join('');
}
export function structureBallScale(settings:Pick<DisplaySettings,'structureSizing'>,element:string):number{return settings.structureSizing?(element==='H'?settings.structureSizing.hydrogenBallScale:settings.structureSizing.ballScale):.27;}
/** vdwRadius comes from the locked renderer, not another scientific table. */
export function structureAtomRadius(settings: DisplaySettings, element: string, vdwRadius: number): number {
  return settings.representation === 'stick' ? bondDisplayRadius(settings)
    : vdwRadius * (settings.representation === 'vdw' ? 1 : structureBallScale(settings,element)) * atomDisplayScale(settings, element);
}
export function structureAtomStyle(settings: DisplaySettings, element: string, color: string, markColor = color) {
  if (settings.representation === 'vdw') return { sphere: { scale: atomDisplayScale(settings, element), color: markColor } };
  // In Licorice the rod also represents the atom; preserve its explicit
  // selection/freeze/measurement material while changing ordinary bond color.
  const uniform=settings.bondStyle?.colorMode==='uniform' && !(settings.representation==='stick' && markColor!==color);
  const stick = { radius: bondDisplayRadius(settings), color: uniform ? settings.bondStyle!.color : settings.representation === 'stick' ? markColor : structureBondColor(color,settings.structureSizing?.bondColorLightening),
    ...(settings.representation === 'stick' ? { showNonBonded: true } : {}) };
  return settings.representation === 'stick' ? { stick } : { stick, sphere: { scale: structureBallScale(settings,element) * atomDisplayScale(settings, element), color: markColor } };
}
