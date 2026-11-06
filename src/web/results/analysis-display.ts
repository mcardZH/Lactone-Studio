/** Presentation-only shared by result tables, viewport overlays and image export. */
import { formatResultValue, resultDecimals } from '../../results/numeric-format';
import type {AnalysisColorbarLayout} from './analysis-colorbar-layout';
import {zeroCenteredColorStops} from '../../results/zero-centered-color';
export type AnalysisPalette = 'blue-red' | 'purple-green' | 'viridis';
export interface AnalysisDisplaySettings {
  color:boolean; labels:boolean; spin:boolean;
  palette?:AnalysisPalette; decimals?:number;
  colorbarLayout?:AnalysisColorbarLayout;
  range?:{min:number;max:number};
}
export interface AnalysisColorbar {min:number;max:number;palette:AnalysisPalette;label:string;decimals:number;reverse?:boolean;colors?:readonly string[];zeroCentered?:boolean;layout?:AnalysisColorbarLayout}
export const ANALYSIS_PALETTES:Record<AnalysisPalette,readonly [string,string,string]>={
  'blue-red':['#2166ac','#ffffff','#b2182b'],
  'purple-green':['#762a83','#f7f7f7','#1b7837'],
  viridis:['#440154','#21918c','#fde725'],
};
export const analysisDecimals = resultDecimals;
export function formatAnalysisValue(value:number|null|undefined,decimals=2){return formatResultValue(value,decimals);}
export function analysisRange(values:readonly number[],settings:AnalysisDisplaySettings,zeroCentered:boolean):{min:number;max:number}|null{
  if(settings.range&&Number.isFinite(settings.range.min)&&Number.isFinite(settings.range.max)&&settings.range.min<settings.range.max)return {...settings.range};
  const finite=values.filter(Number.isFinite);if(!finite.length)return null;
  let min=Math.min(...finite),max=Math.max(...finite);
  if(zeroCentered){const extent=Math.max(Math.abs(min),Math.abs(max))||1;return{min:-extent,max:extent};}
  if(min===max){min-=Math.abs(min)*.01||.01;max+=Math.abs(max)*.01||.01;}return{min,max};
}
export function analysisColor(value:number,range:{min:number;max:number},palette:AnalysisPalette='blue-red'){
  const stops=ANALYSIS_PALETTES[palette],extent=Math.max(Math.abs(range.min),Math.abs(range.max),1);
  const fraction=Math.max(0,Math.min(1,(value/extent-range.min/extent)/(range.max/extent-range.min/extent)));
  const pair=fraction<=.5?[stops[0],stops[1]]:[stops[1],stops[2]],t=fraction<=.5?fraction*2:fraction*2-1;
  return '#'+[1,3,5].map(offset=>Math.round(parseInt(pair[0].slice(offset,offset+2),16)*(1-t)+parseInt(pair[1].slice(offset,offset+2),16)*t).toString(16).padStart(2,'0')).join('');
}
export function analysisGradient(palette:AnalysisPalette='blue-red',reverse=false,colors?:readonly string[]){const stops=colors??ANALYSIS_PALETTES[palette];return `linear-gradient(to right, ${(reverse?[...stops].reverse():stops).join(', ')})`;}
export function analysisColorbarStops(colorbar:AnalysisColorbar):{offset:number;color:string}[]{
  const colors=colorbar.colors??ANALYSIS_PALETTES[colorbar.palette];
  if(colorbar.zeroCentered)return zeroCenteredColorStops(colorbar.min,colorbar.max,colors,!!colorbar.reverse);
  const stops=colorbar.reverse?[...colors].reverse():colors;
  return stops.map((color,index)=>({offset:index/Math.max(1,stops.length-1),color}));
}
export function analysisColorbarGradient(colorbar:AnalysisColorbar):string{
  if(!colorbar.zeroCentered)return analysisGradient(colorbar.palette,!!colorbar.reverse,colorbar.colors);
  return `linear-gradient(to right, ${analysisColorbarStops(colorbar).map(stop=>`${stop.color} ${stop.offset*100}%`).join(', ')})`;
}
/** Pins remain visible; hover adds at most one temporary target. */
export function activeAnalysisRows(pinned:readonly string[],hover:string|null){return [...new Set(hover?[...pinned,hover]:pinned)];}
export function toggleAnalysisRow(pinned:readonly string[],key:string){return pinned.includes(key)?pinned.filter(value=>value!==key):[...pinned,key];}
/** Display-row binding only: keyboard activates pins, focus never previews. */
export function analysisRowBindings(key:string,pinned:readonly string[],onHover:(key:string|null)=>void,onToggle:(key:string)=>void){
 return {tabIndex:0,'aria-selected':pinned.includes(key),onPointerEnter:()=>onHover(key),onPointerLeave:()=>onHover(null),onClick:()=>onToggle(key),
  onKeyDown:(event:{key:string;preventDefault():void})=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onToggle(key);}}};
}
export function analysisLayerVisibility(page:string){return{charges:page==='charges',bonds:page==='bonds',orbitals:page==='orbitals',dipole:page==='energy'};}
