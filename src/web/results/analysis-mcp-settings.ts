import {objectSchema} from '../mcp/types';
import {ANALYSIS_COLORBAR_FONTS, ANALYSIS_COLORBAR_LIMITS, normalizeAnalysisColorbarLayout, type AnalysisColorbarLayout} from './analysis-colorbar-layout';
import {normalizeMeshFinish, type MeshFinishSettings} from '../../results/mesh-appearance';

export const settingText={type:'string'};
export const settingBool={type:'boolean'};
export const settingPositive={type:'number',exclusiveMinimum:0};
export const settingDecimals={type:'integer',minimum:0,maximum:12};
export const settingColor={type:'string',pattern:'^#[0-9a-fA-F]{6}$'};
export const settingNumber={type:'number'};
export const settingFraction={type:'number',minimum:0,maximum:1};
export const settingEnum=(values:readonly (string|number)[])=>({type:typeof values[0]==='number'?'number':'string',enum:[...values]});
export const settingArray=(items:Record<string,unknown>,minItems?:number,maxItems?:number)=>({type:'array',items,
  ...(minItems===undefined?{}:{minItems}),...(maxItems===undefined?{}:{maxItems})});
export const settingColorRange={anyOf:[objectSchema({min:settingNumber,max:settingNumber},['min','max']),{type:'null'}]};
export const settingNumberFormat={anyOf:[
  objectSchema({mode:settingEnum(['decimal']),digits:{type:'integer',minimum:0,maximum:8}},['mode','digits']),
  objectSchema({mode:settingEnum(['significant']),digits:{type:'integer',minimum:1,maximum:8}},['mode','digits']),
  {type:'null'},
]};
export const settingColorbarLayout=objectSchema({
  x:settingFraction,y:settingFraction,
  length:{type:'number',minimum:ANALYSIS_COLORBAR_LIMITS.length.min,maximum:ANALYSIS_COLORBAR_LIMITS.length.max},
  orientation:settingEnum(['horizontal','vertical']),
  thickness:{type:'number',minimum:ANALYSIS_COLORBAR_LIMITS.thickness.min,maximum:ANALYSIS_COLORBAR_LIMITS.thickness.max},
  fontFamily:settingEnum(Object.keys(ANALYSIS_COLORBAR_FONTS)),
  fontSize:{type:'number',minimum:ANALYSIS_COLORBAR_LIMITS.fontSize.min,maximum:ANALYSIS_COLORBAR_LIMITS.fontSize.max},
  ink:settingColor,numberFormat:settingNumberFormat,
});
export const settingMeshFinish=objectSchema({
  preset:settingEnum(['matte','soft','glossy','custom']),specular:settingFraction,
  exponent:{type:'number',minimum:1,maximum:128},ambient:settingFraction,diffuse:settingFraction,
  outline:settingFraction,outlineWidth:settingFraction,facingOpacity:settingBool,
});
export function patchColorbarLayout(current:AnalysisColorbarLayout|undefined,patch:unknown) {
  return normalizeAnalysisColorbarLayout({...normalizeAnalysisColorbarLayout(current),...patch as Partial<AnalysisColorbarLayout>});
}
export function patchMeshFinish(current:MeshFinishSettings|undefined,patch:unknown) {
  const update=patch as Partial<MeshFinishSettings>;
  return normalizeMeshFinish({...normalizeMeshFinish(current),preset:Object.keys(update).some(key=>key!=='preset')?'custom':current?.preset,...update});
}
export function validateColorRange(range:{min:number;max:number}|null|undefined) {
  if (range && !(range.min < range.max)) throw new Error('请输入递增的有限色标范围。');
}
export const quantitativeGridSetting={anyOf:[
  objectSchema({mode:settingEnum(['native-default'])},['mode']),
  objectSchema({mode:settingEnum(['spacing']),spacingBohr:settingPositive},['mode','spacingBohr']),
]};
export const spatialGridSetting={anyOf:[
  objectSchema({mode:settingEnum(['low','medium','high'])},['mode']),
  objectSchema({mode:settingEnum(['spacing']),spacingBohr:settingPositive},['mode','spacingBohr']),
  objectSchema({mode:settingEnum(['dimensions']),dimensions:settingArray({type:'integer',minimum:2},3,3)},['mode','dimensions']),
  objectSchema({mode:settingEnum(['target-points']),targetPoints:settingEnum([32768,4096000])},['mode','targetPoints']),
]};
