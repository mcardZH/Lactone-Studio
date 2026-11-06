import type { DisplaySettings } from './contracts';
import { MESH_FINISH_LIMITS, normalizeMeshFinish, type MeshFinishSettings } from '../results/mesh-appearance';
import { PYMOL_ELEMENT_COLORS, VMD_NAME_COLORS } from './gallery-element-colors';

export type StructureAppearancePresetId = 'original' | 'pastel' | 'muted' | 'cpk' | 'vmd-glossy' | 'flat' | 'macaron' | 'outlined' | 'vdw-shell' | 'gallery-line-art' | 'gallery-cpk-glossy' | 'gallery-pastel' | 'gallery-vmd-glossy';
/** Explicit structural lighting only. Absence preserves all legacy shaders. */
export type StructureLighting = 'pymol-soft' | 'pymol-cpk' | 'vmd';
export interface VdwShellAppearance { color: string; opacity: number; /** Preserve an older mixed core/shell material without adding another editor. */ finish?: MeshFinishSettings }
/** Display geometry, never chemical radii or a change of representation. The
 * existing global/element multipliers remain independent and are not rewritten. */
export interface StructureSizingAppearance { ballScale:number; hydrogenBallScale:number; bondRadiusAngstrom:number; bondColorLightening:number }
export const STRUCTURE_SIZING_LIMITS=Object.freeze({ballScale:[.05,1] as const,hydrogenBallScale:[.05,1] as const,bondRadiusAngstrom:[.02,.5] as const,bondColorLightening:[0,1] as const});
export function validStructureSizing(value:unknown):value is StructureSizingAppearance {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
  const fields=Object.keys(STRUCTURE_SIZING_LIMITS) as (keyof StructureSizingAppearance)[],input=value as Record<string,unknown>;
  return Object.keys(input).length===fields.length&&fields.every(key=>{const v=input[key],[min,max]=STRUCTURE_SIZING_LIMITS[key];return typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;});
}
export function effectiveStructureSizing(display:Pick<DisplaySettings,'structureSizing'|'representation'>):StructureSizingAppearance{return display.structureSizing?{...display.structureSizing}:{ballScale:.27,hydrogenBallScale:.27,bondRadiusAngstrom:display.representation==='stick'?.12:.115,bondColorLightening:.12};}
export function updateStructureSizing(display:DisplaySettings,key:keyof StructureSizingAppearance,value:number):DisplaySettings {
  const [min,max]=STRUCTURE_SIZING_LIMITS[key];if(!Number.isFinite(value)||value<min||value>max)throw new Error('无效结构外观尺寸。');
  return {...display,structurePreset:'custom',structureSizing:{...effectiveStructureSizing(display),[key]:value}};
}
export type StructureLightingKey=keyof typeof MESH_FINISH_LIMITS;
export interface StructureAppearancePreset {
  id: StructureAppearancePresetId; label: string; source: string;
  colors: Readonly<Record<string, string>>; finish: Readonly<MeshFinishSettings>; shell?: Readonly<VdwShellAppearance>; sizing?:Readonly<StructureSizingAppearance>; lighting?:StructureLighting;
}
const cpk = { C:'#909090', H:'#fafafa', N:'#1f3dcc', O:'#d91414', S:'#f2c20d', P:'#ff8000', F:'#26bf33', Cl:'#26a626', Br:'#8c1a0d', I:'#731aa6' };
const finish = (specular: number, exponent: number, ambient: number, diffuse: number, outline = 0): MeshFinishSettings => ({preset:'custom',specular,exponent,ambient,diffuse,outline});
/** The pre-gallery STRUCTURE renderer, distinct from scientific-mesh defaults. */
export const ORIGINAL_STRUCTURE_FINISH:Readonly<MeshFinishSettings>=Object.freeze(finish(0,48,0,1));
export function effectiveStructureFinish(display:Pick<DisplaySettings,'structureFinish'>):MeshFinishSettings{return display.structureFinish?normalizeMeshFinish(display.structureFinish):{...ORIGINAL_STRUCTURE_FINISH};}
export function isNativeStructureFinish(value?:MeshFinishSettings):boolean{if(!value)return true;const finish=normalizeMeshFinish(value);return finish.specular===0&&finish.ambient===0&&finish.diffuse===1&&(finish.outline??0)===0;}
export function structureShellFinish(display:Pick<DisplaySettings,'structureFinish'|'vdwShell'>):MeshFinishSettings{return normalizeMeshFinish(display.vdwShell?.finish??display.structureFinish);}
export function mixedStructureLighting(display:DisplaySettings):StructureLightingKey[]{if(!display.vdwShell)return [];const core=effectiveStructureFinish(display),shell=structureShellFinish(display);return (Object.keys(MESH_FINISH_LIMITS) as StructureLightingKey[]).filter(key=>(core[key]??(key==='ambient'?.1:.9))!==(shell[key]??(key==='ambient'?.1:.9)));}
/** Numeric edits carry their key even when the entered value equals the core. */
export function updateStructureLighting(display:DisplaySettings,key:StructureLightingKey|'outline'|'outlineWidth',value:number):DisplaySettings{
  const core=effectiveStructureFinish(display),shell=display.vdwShell;
  return {...display,structureFinish:{...core,preset:'custom',[key]:value},...(shell?{vdwShell:{...shell,finish:{...structureShellFinish(display),preset:'custom',[key]:value}}}:{})};
}
/** A material selection intentionally takes over both inner core and shell. */
export function replaceStructureFinish(display:DisplaySettings,value:MeshFinishSettings):DisplaySettings{const next={...display,structureFinish:value};if(display.vdwShell){const {finish:_previous,...shell}=display.vdwShell;next.vdwShell=shell;}return next;}
/** Legacy presets remain byte-for-byte compatible. New target versions may
 * own explicit display sizing without taking over representation or science. */
const LEGACY_STRUCTURE_APPEARANCE_PRESETS: readonly StructureAppearancePreset[] = Object.freeze<StructureAppearancePreset[]>([
  {id:'original',label:'原始 Ester Studio',source:'Ester Studio pre-gallery native Jmol / Lambert',colors:{},finish:ORIGINAL_STRUCTURE_FINISH},
  {id:'pastel',label:'粉彩元素',source:'fig-062 / PyMOL 10',colors:{C:'#b4bed2',H:'#f5f5f5',N:'#8ca0e6',O:'#f07878',S:'#f5c350',P:'#ff8c26',F:'#51bc65',Cl:'#51bc65',Br:'#a62e29',I:'#8033a6'},finish:finish(.25,60,.45,.7)},
  {id:'muted',label:'低饱和',source:'fig-152 / PyMOL 11',colors:{...cpk,C:'#ffc6b2',O:'#cee0e0',N:'#4b5faa',S:'#ffe0ac',P:'#ffa500',H:'#ededed'},finish:finish(0,48,.4,.6)},
  {id:'cpk',label:'常规元素',source:'fig-153 / PyMOL 13',colors:cpk,finish:finish(.3,35,.55,.7)},
  {id:'vmd-glossy',label:'高光青碳',source:'fig-013 / VMD molecule',colors:{...cpk,C:'#00caca',N:'#3050f8',O:'#ed2020',H:'#ffffff'},finish:finish(.65,80,.22,.7)},
  {id:'flat',label:'平面元素',source:'fig-154 / PyMOL 14',colors:cpk,finish:finish(0,48,.9,.1,.12)},
  {id:'macaron',label:'马卡龙柔光',source:'PyMOL 18 adaptation',colors:{...cpk,C:'#ffb38c',H:'#ffe1ce',N:'#bba1cb',O:'#b1d5c8',Cu:'#bba1cb',Sr:'#b1d5c8'},finish:finish(.08,12,.55,.45)},
  {id:'outlined',label:'彩色描边',source:'PyMOL 19 adaptation',colors:{...cpk,C:'#7989bf',N:'#e11d8b',O:'#f79c2d',H:'#51bc65',Cu:'#51bc65',Sr:'#51bc65'},finish:finish(0,48,1,0,.45)},
  {id:'vdw-shell',label:'透明范德华外壳',source:'PyMOL 12',colors:cpk,finish:finish(0,48,.75,.6),shell:{color:'#abd9e6',opacity:.5}},
  {id:'gallery-line-art',label:'图库·元素线稿',source:'plot-mol PyMOL template 14 / explicit multi-element palette',colors:cpk,finish:{...finish(0,48,.92,.08,.98),outlineWidth:.46},sizing:{ballScale:.24,hydrogenBallScale:.14,bondRadiusAngstrom:.14,bondColorLightening:0}},
  {id:'gallery-cpk-glossy',label:'图库·CPK高光',source:'plot-mol fig-153 / PyMOL template 13',colors:{...cpk,F:'#00ff00',Cl:'#00ff00',Br:'#b22121',I:'#ff80ff'},finish:{...finish(.26,35,.48,.52,.98),outlineWidth:.42},sizing:{ballScale:.25,hydrogenBallScale:.16,bondRadiusAngstrom:.15,bondColorLightening:0}},
]);
/** Public choices are deliberately smaller than the compatible saved ID set. */
export const STRUCTURE_APPEARANCE_PRESETS:readonly StructureAppearancePreset[]=Object.freeze([
  {...LEGACY_STRUCTURE_APPEARANCE_PRESETS[0],label:'Ester Studio内置'},
  {id:'gallery-pastel',label:'图库·粉彩球棍',source:'plot-mol fig-062 / PyMOL template 10; user-approved natural shading without added black contour',colors:{...PYMOL_ELEMENT_COLORS,...LEGACY_STRUCTURE_APPEARANCE_PRESETS[1].colors},finish:finish(.25,60,.45,.70),lighting:'pymol-soft',sizing:{ballScale:.30,hydrogenBallScale:.18,bondRadiusAngstrom:.22,bondColorLightening:0}},
  {id:'gallery-cpk-glossy',label:'图库·CPK球棍',source:'plot-mol fig-153 / PyMOL template 13; user-approved natural shading without added black contour',colors:{...PYMOL_ELEMENT_COLORS,...cpk,F:'#00ff00',Cl:'#00ff00',Br:'#b22121',I:'#ff80ff'},finish:finish(.30,35,.55,.70),lighting:'pymol-cpk',sizing:{ballScale:.25,hydrogenBallScale:.16,bondRadiusAngstrom:.15,bondColorLightening:0}},
  {id:'gallery-vmd-glossy',label:'图库·青碳高光',source:'plot-mol fig-013 / VMD CPK Name Opaque',colors:VMD_NAME_COLORS,finish:finish(.50,40,0,.65),lighting:'vmd',sizing:{ballScale:.25,hydrogenBallScale:.25,bondRadiusAngstrom:.10,bondColorLightening:0}},
] satisfies StructureAppearancePreset[]);
export function isSelectableStructureAppearancePreset(id:unknown):id is StructureAppearancePresetId{return STRUCTURE_APPEARANCE_PRESETS.some(row=>row.id===id);}
export function structureAppearancePreset(id: unknown): StructureAppearancePreset | undefined { return STRUCTURE_APPEARANCE_PRESETS.find(row=>row.id===id)??LEGACY_STRUCTURE_APPEARANCE_PRESETS.find(row=>row.id===id); }
export function applyStructureAppearancePreset(display: DisplaySettings, id: StructureAppearancePresetId): DisplaySettings {
  const preset=structureAppearancePreset(id); if(!preset) throw new Error('未知结构风格。');
  const next:DisplaySettings={...display,structurePreset:id,elementColors:{...preset.colors},structureFinish:{...preset.finish}};
  if(preset.lighting)next.structureLighting=preset.lighting;else delete next.structureLighting;
  // Absence preserves the exact native palette/material route, including the
  // renderer's imposters. The gallery's CPK adaptation is a different style.
  if(id==='original'){delete next.elementColors;delete next.structureFinish;}
  if(preset.sizing)next.structureSizing={...preset.sizing};else delete next.structureSizing;
  if(preset.shell) next.vdwShell={...preset.shell,opacity:display.vdwShell?.opacity??preset.shell.opacity}; else delete next.vdwShell;
  return next;
}
/** Custom starts from the actual current parameters, including a visible shell. */
export function customizeStructureAppearance(display: DisplaySettings): DisplaySettings { const actual=effectiveStructureFinish(display);return {...display,structurePreset:'custom',...(display.elementColors?{elementColors:{...display.elementColors}}:{}),structureFinish:{...actual,preset:'custom',ambient:actual.ambient??.1,diffuse:actual.diffuse??.9},...(display.vdwShell?{vdwShell:{...display.vdwShell,...(!display.structureFinish&&!display.vdwShell.finish?{finish:structureShellFinish(display)}:{})}}:{})}; }
