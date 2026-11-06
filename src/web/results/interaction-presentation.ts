import type { Structure } from '../../core/types';
import type { InteractionComponent, InteractionContributions, InteractionFragment, InteractionGeneratedFields, InteractionGridQuality, InteractionMethod, InteractionSourceFragment } from '../../results/interaction-contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import { formatResultValue } from '../../results/numeric-format';
import { normalizeMeshFinish } from '../../results/mesh-appearance';
import { interactionComponents } from '../../results/interaction-field';
export { interactionComponents } from '../../results/interaction-field';
import { surfaceContextKey } from './surface-presentation';
import type { ScientificTableProjection } from './scientific-table';
import type { InteractionAnalysisControlsProps, InteractionDisplaySettings, InteractionHighlights } from './interaction-controls-contracts';
import type { ScientificPlotViewport } from '../../results/scientific-plot';
import { interactionAppearance } from './surface-appearance';

export const INTERACTION_METHOD_LABELS:Record<InteractionMethod,string>={iri:'IRI',rdg:'RDG',igmh:'IGMH',migm:'mIGM',igm:'IGM'};
export const INTERACTION_COMPONENT_LABELS:Record<InteractionComponent,string>={iri:'IRI',rdg:'RDG',inter:'δg_inter',intra:'δg_intra',total:'δg'};
export const interactionHasFragments=(method:InteractionMethod)=>method==='igmh'||method==='migm'||method==='igm';
export const interactionHasContributions=(method:InteractionMethod):method is 'igmh'|'migm'=>method==='igmh'||method==='migm';
/** Familiar initial viewing windows; these never filter source data or define the color scale. */
export function interactionScatterInitialViewport(method:InteractionMethod,component:InteractionComponent):ScientificPlotViewport|null{
  if(method==='iri')return{x:[-.05,.05],y:[0,5]};
  if(method==='rdg')return{x:[-.05,.05],y:[0,2]};
  return component==='inter'?{x:[-.05,.05],y:[0,.08]}:null;
}
export function interactionFragmentLabel(index:number):string{
  let value=index+1,label='';do{value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}while(value>0);return label;
}
export function nextInteractionFragment(rows:readonly InteractionFragment[]):InteractionFragment{
  let index=0;while(rows.some(row=>row.label===interactionFragmentLabel(index)||row.id===`fragment-user-${index}`))index++;
  return{id:`fragment-user-${index}`,label:interactionFragmentLabel(index),atomIds:[]};
}
export function initialInteractionDisplay(method:InteractionMethod,defaults:InteractionAnalysisControlsProps['methodDefaults']):InteractionDisplaySettings{
  const configured=defaults?.[method];
  const isovalue=method==='iri'?1:method==='rdg'?.5:.005;
  const min=method==='iri'?-.04:method==='rdg'?-.035:-.05;
  const value:InteractionDisplaySettings={component:interactionComponents(method)[0],isovalue:configured?.isovalue===undefined?isovalue:configured.isovalue,visible:true,opacity:configured?.opacity??1,color:configured?.color===undefined?{min,max:interactionHasFragments(method)?.05:.02,colors:['#0000ff','#00ff00','#ff0000']}:configured.color,finish:normalizeMeshFinish(configured?.finish),scatterPointSize:2,scatterOpacity:.65,scatterViewport:null};
  if(configured?.color!==undefined||configured?.finish!==undefined)return {...value,appearancePreset:'custom'};
  const gallery=interactionAppearance(value,interactionHasFragments(method)?'gallery-igmh':'gallery-iri');
  return configured?.opacity===undefined?gallery:{...gallery,opacity:configured.opacity};
}
export function interactionSourceFragments(fragments:readonly InteractionFragment[],order:InteractionAnalysisControlsProps['sourceAtomOrder']):InteractionSourceFragment[]{
  const index=new Map(order.map(row=>[row.atomId,row.sourceIndex]));
  if(index.size!==order.length||new Set(order.map(row=>row.sourceIndex)).size!==order.length||order.some(row=>!Number.isSafeInteger(row.sourceIndex)||row.sourceIndex<1))throw Error('来源原子对应无效。');
  return fragments.map(fragment=>({id:fragment.id,label:fragment.label,atomIndices:fragment.atomIds.map(id=>{const source=index.get(id);if(source===undefined)throw Error('片段含不属于当前来源的原子。');return source;}).sort((a,b)=>a-b)}));
}
export function interactionDefinitionKey(context:SurfaceContext,method:InteractionMethod,fragments:readonly InteractionSourceFragment[],quality:InteractionGridQuality):string{
  return JSON.stringify([surfaceContextKey(context),method,interactionHasFragments(method)?fragments.map(row=>[row.id,[...row.atomIndices].sort((a,b)=>a-b)]):[],quality]);
}
export function interactionContributionKey(context:SurfaceContext,method:InteractionMethod,fragments:readonly InteractionSourceFragment[],pair:readonly [string,string],quality:number):string{
  return JSON.stringify([surfaceContextKey(context),method,fragments.map(row=>[row.id,[...row.atomIndices].sort((a,b)=>a-b)]),pair,quality]);
}
export type InteractionContributionSort={column:'identity'|'value'|'percent';direction:'asc'|'desc'};
const sorted=<T>(rows:readonly T[],sort:InteractionContributionSort,identity:(a:T,b:T)=>number,value:(row:T)=>number,percent:(row:T)=>number|null)=>[...rows].sort((a,b)=>{
  if(sort.column==='identity')return identity(a,b)*(sort.direction==='asc'?1:-1);
  const extract=sort.column==='value'?value:percent,av=extract(a),bv=extract(b);
  if(av===null||bv===null)return av===bv?identity(a,b):av===null?1:-1;
  return (av-bv)*(sort.direction==='asc'?1:-1)||identity(a,b);
});
export function interactionContributionTables(result:InteractionContributions,decimals=2,sort:InteractionContributionSort={column:'identity',direction:'asc'}):{atoms:ScientificTableProjection;pairs:ScientificTableProjection}{
  const number=(value:number|null)=>formatResultValue(value,decimals),labels=new Map(result.fragments.map(row=>[row.id,row.label])),elements=new Map(result.atoms.map(row=>[row.sourceIndex,row.element]));
  return{
    atoms:{columns:[{key:'identity',label:'原子'},{key:'fragment',label:'片段'},{key:'value',label:`δG / ${result.unit}`},{key:'percent',label:'占比 / %'}],rows:sorted(result.atoms,sort,(a,b)=>a.sourceIndex-b.sourceIndex,row=>row.value,row=>row.percent).map(row=>({key:`atom:${row.sourceIndex}`,cells:[`${row.sourceIndex}${row.element}`,labels.get(row.fragmentId)??'未确认',number(row.value),number(row.percent)]}))},
    pairs:{columns:[{key:'identity',label:'原子对'},{key:'value',label:`δG / ${result.unit}`},{key:'percent',label:'占比 / %'}],rows:sorted(result.pairs,sort,(a,b)=>a.sourceIndex1-b.sourceIndex1||a.sourceIndex2-b.sourceIndex2,row=>row.value,row=>row.percent).map(row=>({key:`pair:${row.sourceIndex1}:${row.sourceIndex2}`,cells:[`${row.sourceIndex1}${elements.get(row.sourceIndex1)??''}–${row.sourceIndex2}${elements.get(row.sourceIndex2)??''}`,number(row.value),number(row.percent)]}))},
  };
}
export function interactionIntegralTable(result:InteractionGeneratedFields,decimals=2):ScientificTableProjection{
  return{columns:[{key:'component',label:'分量'},{key:'value',label:'积分'},{key:'unit',label:'单位'}],rows:result.integrals.map(row=>({key:row.component,cells:[INTERACTION_COMPONENT_LABELS[row.component],formatResultValue(row.value,decimals),row.unit]}))};
}
export function interactionContributionHighlights(result:InteractionContributions|null,keys:readonly string[],order:InteractionAnalysisControlsProps['sourceAtomOrder'],structure:Structure,decimals=2):InteractionHighlights{
  if(!result)return{atoms:[],pairs:[]};
  const bySource=new Map(order.map(row=>[row.sourceIndex,row.atomId])),labels=interactionContributionTables(result,decimals),atomLabels=new Map(labels.atoms.rows.map(row=>[row.key,row.cells])),pairLabels=new Map(labels.pairs.rows.map(row=>[row.key,row.cells]));
  const admitted=new Set(structure.atoms.map(atom=>atom.id));
  const pairName=result.pair.map(id=>result.fragments.find(row=>row.id===id)?.label??'未确认').join('–');
  return{
    atoms:result.atoms.flatMap(row=>{const key=`atom:${row.sourceIndex}`,atomId=bySource.get(row.sourceIndex),cells=atomLabels.get(key);return keys.includes(key)&&atomId&&admitted.has(atomId)&&cells?[{atomId,value:row.value,label:`${INTERACTION_METHOD_LABELS[result.method]} ${pairName} · ${cells[0]} · δG=${cells[2]} ${result.unit} · ${row.percent===null?'占比未输出':cells[3]+'%'}`}]:[];}),
    pairs:result.pairs.flatMap(row=>{const key=`pair:${row.sourceIndex1}:${row.sourceIndex2}`,a=bySource.get(row.sourceIndex1),b=bySource.get(row.sourceIndex2),cells=pairLabels.get(key);return keys.includes(key)&&a&&b&&admitted.has(a)&&admitted.has(b)&&cells?[{atomIds:[a,b] as [string,string],value:row.value,label:`${INTERACTION_METHOD_LABELS[result.method]} ${pairName} · ${cells[0]} · δG=${cells[1]} ${result.unit} · ${row.percent===null?'占比未输出':cells[2]+'%'}`}]:[];}),
  };
}
