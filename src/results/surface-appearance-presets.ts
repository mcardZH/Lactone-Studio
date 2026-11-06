import type { MeshFinishSettings } from './mesh-appearance';
export type SurfaceAppearanceFamily='esp'|'orbital'|'dual'|'iri'|'igmh'|'density'|'hirshfeld';
export type SurfaceAppearancePresetId=SurfaceAppearanceFamily|`gallery-${SurfaceAppearanceFamily}`;
export interface SurfaceAppearancePreset {id:SurfaceAppearancePresetId;family?:SurfaceAppearanceFamily;label:string;source:string;positiveColor:string;negativeColor:string;lowColor:string;middleColor:string;highColor:string;finish:MeshFinishSettings;opacity?:number}
/** Appearance references only: no threshold, range, unit or field identity.
 * Legacy rows remain readable for saved appearances, but are not new choices. */
export const SURFACE_APPEARANCE_PRESETS:readonly SurfaceAppearancePreset[]=Object.freeze([
  {id:'esp',label:'静电势色带',source:'fig-155',positiveColor:'#e52b32',negativeColor:'#195ce6',lowColor:'#195ce6',middleColor:'#ffffff',highColor:'#e52b32',finish:{preset:'custom',specular:.25,exponent:48,ambient:.25,diffuse:.7}},
  {id:'orbital',label:'双相位轨道',source:'fig-061',positiveColor:'#66cc4d',negativeColor:'#00b0d4',lowColor:'#00b0d4',middleColor:'#ffffff',highColor:'#66cc4d',finish:{preset:'custom',specular:.55,exponent:80,ambient:.2,diffuse:.65}},
  {id:'dual',label:'双色独立场',source:'fig-158 / leading NTO squared appearance only',positiveColor:'#66cc4d',negativeColor:'#00b0d4',lowColor:'#00b0d4',middleColor:'#ffffff',highColor:'#66cc4d',finish:{preset:'custom',specular:.45,exponent:64,ambient:.2,diffuse:.65}},
  {id:'iri',label:'IRI色带',source:'fig-064',positiveColor:'#2fbc57',negativeColor:'#275ce6',lowColor:'#275ce6',middleColor:'#2fbc57',highColor:'#e53131',finish:{preset:'custom',specular:.2,exponent:40,ambient:.25,diffuse:.7}},
  {id:'igmh',label:'IGMH色带',source:'fig-156',positiveColor:'#2cbb54',negativeColor:'#2459df',lowColor:'#2459df',middleColor:'#2cbb54',highColor:'#e52b32',finish:{preset:'custom',specular:.3,exponent:48,ambient:.25,diffuse:.7}},
  {id:'density',label:'单色密度',source:'fig-065',positiveColor:'#66cc4d',negativeColor:'#66cc4d',lowColor:'#66cc4d',middleColor:'#66cc4d',highColor:'#66cc4d',finish:{preset:'custom',specular:.45,exponent:64,ambient:.2,diffuse:.65}},
  {id:'hirshfeld',label:'Hirshfeld标准',source:'existing native dnorm RWB appearance',positiveColor:'#275ce6',negativeColor:'#e53131',lowColor:'#e53131',middleColor:'#ffffff',highColor:'#275ce6',finish:{preset:'soft',specular:.3,exponent:48}},
  {id:'gallery-esp',family:'esp',label:'图库·ESP柔光',source:'fig-155',positiveColor:'#ff0000',negativeColor:'#0000ff',lowColor:'#0000ff',middleColor:'#ffffff',highColor:'#ff0000',finish:{preset:'custom',specular:.3,exponent:42,ambient:.42,diffuse:.58},opacity:.9},
  {id:'gallery-orbital',family:'orbital',label:'图库·轨道高光',source:'fig-061',positiveColor:'#66cc4d',negativeColor:'#00b0d4',lowColor:'#00b0d4',middleColor:'#ffffff',highColor:'#66cc4d',finish:{preset:'custom',specular:.5,exponent:86,ambient:.16,diffuse:.78},opacity:.96},
  {id:'gallery-dual',family:'dual',label:'图库·双色场',source:'fig-158; appearance only, scientific density identity retained',positiveColor:'#00b0d4',negativeColor:'#66cc4d',lowColor:'#66cc4d',middleColor:'#ffffff',highColor:'#00b0d4',finish:{preset:'custom',specular:.45,exponent:80,ambient:.16,diffuse:.72},opacity:.94},
  {id:'gallery-iri',family:'iri',label:'图库·IRI柔光',source:'fig-064',positiveColor:'#00ff00',negativeColor:'#0000ff',lowColor:'#0000ff',middleColor:'#00ff00',highColor:'#ff0000',finish:{preset:'custom',specular:.2,exponent:40,ambient:.4,diffuse:.6},opacity:1},
  {id:'gallery-igmh',family:'igmh',label:'图库·IGMH高光',source:'fig-156',positiveColor:'#00ff00',negativeColor:'#0000ff',lowColor:'#0000ff',middleColor:'#00ff00',highColor:'#ff0000',finish:{preset:'custom',specular:.3,exponent:48,ambient:.35,diffuse:.65},opacity:1},
  {id:'gallery-density',family:'density',label:'图库·单色密度',source:'fig-065',positiveColor:'#66cc4d',negativeColor:'#66cc4d',lowColor:'#66cc4d',middleColor:'#66cc4d',highColor:'#66cc4d',finish:{preset:'custom',specular:.48,exponent:80,ambient:.18,diffuse:.72},opacity:.94},
  {id:'gallery-hirshfeld',family:'hirshfeld',label:'图库·Hirshfeld',source:'fig-388 / fig-389; standard dnorm, zero stays white',positiveColor:'#0000ff',negativeColor:'#ff0000',lowColor:'#ff0000',middleColor:'#ffffff',highColor:'#0000ff',finish:{preset:'custom',specular:.3,exponent:72,ambient:.2,diffuse:.75},opacity:.9},
]);
export function surfaceAppearancePreset(id:unknown){return SURFACE_APPEARANCE_PRESETS.find(row=>row.id===id);}
export function surfaceAppearanceFamily(id:unknown):SurfaceAppearanceFamily|undefined{const row=surfaceAppearancePreset(id);return row?(row.family??row.id as SurfaceAppearanceFamily):undefined;}
export function surfaceAppearanceChoices(families?:readonly SurfaceAppearancePresetId[]):readonly SurfaceAppearancePreset[]{return SURFACE_APPEARANCE_PRESETS.filter(row=>row.id.startsWith('gallery-')&&(!families||families.some(id=>row.id===id||surfaceAppearanceFamily(row.id)===id)));}
export function applySurfaceAppearancePreset<T extends {positiveColor?:string;negativeColor?:string;color?:string;lowColor?:string;middleColor?:string;highColor?:string;finish?:MeshFinishSettings;opacity?:number}>(display:T,id:SurfaceAppearancePresetId):T&{appearancePreset:SurfaceAppearancePresetId}{
  const row=surfaceAppearancePreset(id);if(!row)throw new Error('未知表面风格。');
  const next={...display,appearancePreset:id,finish:{...row.finish}};
  for(const key of ['positiveColor','negativeColor','lowColor','middleColor','highColor'] as const)if(key in display)(next as Record<string,unknown>)[key]=row[key];
  if('color' in display)(next as Record<string,unknown>).color=row.positiveColor;
  if(row.opacity!==undefined&&'opacity' in display)(next as Record<string,unknown>).opacity=row.opacity;
  return next;
}
export function customizeSurfaceAppearance<T extends object>(display:T):T&{appearancePreset:'custom'}{return {...display,appearancePreset:'custom'};}

export interface VibrationVectorAppearance {color:string;radius:number;radiusRatio:number;mid:number}
export const VIBRATION_VECTOR_LIMITS=Object.freeze({radius:[.001,.5] as const,radiusRatio:[1,10] as const,mid:[.05,.95] as const});
export const VIBRATION_VECTOR_PRESETS=Object.freeze([
  {id:'standard',label:'标准蓝色',appearance:{color:'#277fdf',radius:.035,radiusRatio:2.5,mid:.72}},
  {id:'teal',label:'青色振动向量',source:'fig-060',appearance:{color:'#1c9b91',radius:.045,radiusRatio:2.8,mid:.74}},
] as const);
export function vibrationVectorAppearance(id:unknown):VibrationVectorAppearance{return {...(VIBRATION_VECTOR_PRESETS.find(row=>row.id===id)??VIBRATION_VECTOR_PRESETS[0]).appearance};}
export function normalizeVibrationVectorAppearance(value?:Partial<VibrationVectorAppearance>):VibrationVectorAppearance{
  const fallback=vibrationVectorAppearance('standard'),number=(key:keyof typeof VIBRATION_VECTOR_LIMITS)=>{const [min,max]=VIBRATION_VECTOR_LIMITS[key];return typeof value?.[key]==='number'&&Number.isFinite(value[key])&&value[key]!>=min&&value[key]!<=max?value[key]!:fallback[key];};
  return {color:typeof value?.color==='string'&&/^#[\da-f]{6}$/i.test(value.color)?value.color:fallback.color,radius:number('radius'),radiusRatio:number('radiusRatio'),mid:number('mid')};
}
