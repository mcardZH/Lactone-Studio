import { STRUCTURE_APPEARANCE_PRESETS, STRUCTURE_LIGHTING, STRUCTURE_SIZING_LIMITS } from '../../modeling/appearance-presets';
import { MESH_FINISH_LIMITS } from '../../results/mesh-appearance';
import type { DisplaySettings } from '../../modeling/contracts';
import { objectSchema } from './types';

const values = (...members: string[]) => ({type:'string',enum:members});
const range = (minimum:number,maximum:number) => ({type:'number',minimum,maximum});
const rgb = {type:'string',pattern:'^#[0-9a-fA-F]{6}$',description:'Six-digit RGB color such as #abcdef.'};
const boolean = {type:'boolean'};
const fraction = range(0,1);
const scale = range(.25,3);
const finish = objectSchema({
  preset:values('matte','soft','glossy','custom'),
  specular:range(...MESH_FINISH_LIMITS.specular),
  exponent:range(...MESH_FINISH_LIMITS.exponent),
  ambient:range(...MESH_FINISH_LIMITS.ambient),
  diffuse:range(...MESH_FINISH_LIMITS.diffuse),
  outline:fraction,outlineWidth:fraction,
},['preset','specular','exponent']);
const sizingFields = Object.fromEntries(Object.entries(STRUCTURE_SIZING_LIMITS).map(([key,[min,max]])=>[key,{
  ...range(min,max),...(key==='bondRadiusAngstrom'?{description:'Displayed bond radius in Å.'}:{}),
}]));
const pixels = (min:number,max:number) => ({...range(min,max),description:'CSS pixels.'});

/** Public discovery for the existing native validator. Structured fields
 * take complete objects, while omitted top-level fields retain their value. */
export const modelDisplayPatchSchema = objectSchema({
  representation:values('vdw','ball-stick','stick'),
  colorMode:values('elements','frozen','basis','layers','fragments'),
  atomNumbers:boolean,elementNames:boolean,legend:boolean,regionHighlights:boolean,
  regionLabels:boolean,frozenMarks:boolean,scanMarks:boolean,measurementMarks:boolean,
  stereochemistry:boolean,cell:boolean,showBonds:boolean,
  fontSize:pixels(8,24),
  rotationSpeedPercent:{type:'number',exclusiveMinimum:0,description:'Mouse rotation speed relative to 100 percent.'},
  alignment:values('auto','heavy','off'),
  elementColors:{type:'object',additionalProperties:rgb,description:'Mapping from element symbol to six-digit RGB color.'},
  elementScales:{type:'object',additionalProperties:scale,description:'Mapping from element symbol to display radius multiplier.'},
  atomScale:scale,bondScale:scale,depthFade:fraction,
  structurePreset:{type:'string',description:'An existing appearance identity. To apply its full appearance use the top-level preset field.'},
  structureLighting:values(...STRUCTURE_LIGHTING),
  structureFinish:finish,
  structureSizing:objectSchema(sizingFields,Object.keys(sizingFields)),
  vdwShell:objectSchema({color:rgb,opacity:fraction,finish},['color','opacity']),
  backgroundColor:rgb,
  bondStyle:objectSchema({colorMode:values('elements','uniform'),color:rgb},['colorMode','color']),
  cellStyle:objectSchema({lineStyle:values('solid','dashed'),color:rgb,width:pixels(.5,8)},['lineStyle','color','width']),
  axisDisplay:objectSchema({colors:objectSchema({X:rgb,Y:rgb,Z:rgb},['X','Y','Z']),
    lineWidth:pixels(.5,8),length:pixels(10,120),fontSize:pixels(8,32)},['colors','lineWidth','length','fontSize']),
  periodicDisplay:objectSchema({boundaryStyle:values('thin','stubs'),outerColor:rgb,images:boolean,
    showCrossBoxBonds:boolean,rangeAngstrom:{type:'number',minimum:0,description:'Image range in Å.'}},['boundaryStyle','outerColor','images','rangeAngstrom']),
} satisfies Record<keyof DisplaySettings,unknown>);

export const selectableStylePresets = STRUCTURE_APPEARANCE_PRESETS.map(({id,label})=>({id,label}));
