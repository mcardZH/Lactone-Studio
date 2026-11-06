import type { AnalysisPage } from './PostprocessDisplayPanel';
import {layoutDocumentTiles,type DocumentDeckSize} from '../modeling/model-document-layout';
import type {AnalysisWindowBounds} from '../../modeling/contracts';
export interface AnalysisInstance { id:string; kind:AnalysisPage; group:string; detached:boolean }
export interface AnalysisWorkspaceState { instances:AnalysisInstance[]; activeId:string|null; groupActive:Record<string,string>; mode:'tabs'|'tiled'|'free'; windowBounds?:Record<string,AnalysisWindowBounds> }
export type AnalysisWorkspaceAction={type:'add';instance:AnalysisInstance}|{type:'activate';id:string}|{type:'close';id:string}|{type:'place';id:string;group:string;detached:boolean;before?:string}|{type:'layout';mode:AnalysisWorkspaceState['mode']}|{type:'reorder';ids:string[]}|{type:'window-bounds';id:string;bounds:AnalysisWindowBounds};
export const ANALYSIS_TITLES:Record<AnalysisPage,string>={energy:'能量',charges:'电荷',bonds:'键级',orbitals:'轨道',surface:'分子表面',interaction:'相互作用',trajectory:'轨迹',excited:'激发',vibrations:'振动',reactivity:'反应性'};
export function initialAnalysisWorkspace(id:string,kind:AnalysisPage='energy'):AnalysisWorkspaceState{return{instances:[{id,kind,group:'main',detached:false}],activeId:id,groupActive:{main:id},mode:'tabs'};}
/** Reject malformed owner graphs instead of silently inventing replacement ids. */
export function validateAnalysisWorkspace(state:AnalysisWorkspaceState):AnalysisWorkspaceState{
 if(!state||!Array.isArray(state.instances)||!['tabs','tiled','free'].includes(state.mode)||!state.groupActive||typeof state.groupActive!=='object')throw new Error('分析工作区状态无效。');
 const ids=new Set<string>(),kinds=new Set<string>();
 for(const item of state.instances){if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||!Object.hasOwn(ANALYSIS_TITLES,item.kind)||kinds.has(item.kind)||typeof item.group!=='string'||typeof item.detached!=='boolean')throw new Error('分析面板身份或分组无效。');ids.add(item.id);kinds.add(item.kind);}
 if(state.activeId!==null&&!ids.has(state.activeId))throw new Error('分析工作区激活身份无效。');
 for(const [group,id] of Object.entries(state.groupActive))if(!state.instances.some(item=>item.id===id&&item.group===group&&!item.detached))throw new Error('分析工作区分组激活身份无效。');
 return state;
}
/** Current display bounds are the authority for reachability after migration. */
export function reachableAnalysisWindowBounds(saved:AnalysisWindowBounds|undefined,screen:{x:number;y:number;width:number;height:number}):Required<AnalysisWindowBounds>{
 const positive=(value:number|undefined,fallback:number)=>value!==undefined&&Number.isFinite(value)&&value>0?value:fallback;
 const width=Math.round(Math.min(4000,Math.max(320,Math.min(positive(saved?.width,540),positive(screen.width,1920))))),height=Math.round(Math.min(4000,Math.max(240,Math.min(positive(saved?.height,780),positive(screen.height,1080)))));
 const x=Number.isFinite(saved?.x)?saved!.x!:screen.x,y=Number.isFinite(saved?.y)?saved!.y!:screen.y;
 return{x:Math.round(Math.max(screen.x,Math.min(x,screen.x+screen.width-width))),y:Math.round(Math.max(screen.y,Math.min(y,screen.y+screen.height-height))),width,height};
}
/** Use the same adaptive 1/2/3/4-pane geometry as the model document deck. */
export function analysisWorkspaceLayout(state:AnalysisWorkspaceState,size:DocumentDeckSize){
 const docked=state.instances.filter(item=>!item.detached);
 return layoutDocumentTiles(state.mode!=='tabs'?docked.length:1,size);
}
/** A detached canvas owner never becomes a tab in the main window. */
export function activeDockedAnalysis(state:AnalysisWorkspaceState){
 const docked=state.instances.filter(item=>!item.detached);
 return docked.find(item=>item.id===state.activeId)??docked.find(item=>item.id===state.groupActive.main)??docked.at(-1);
}
export function analysisWorkspaceReducer(state:AnalysisWorkspaceState,action:AnalysisWorkspaceAction):AnalysisWorkspaceState{
 if(action.type==='layout')return state.mode===action.mode?state:{...state,mode:action.mode};
 if(action.type==='reorder'){
  const docked=state.instances.filter(item=>!item.detached),ids=new Set(action.ids);
  if(ids.size!==docked.length||action.ids.length!==docked.length||docked.some(item=>!ids.has(item.id)))return state;
  const ordered=action.ids.map(id=>docked.find(item=>item.id===id)!);let index=0;
  return{...state,instances:state.instances.map(item=>item.detached?item:ordered[index++])};
 }
 if(action.type==='add'){
  const existing=state.instances.find(item=>item.kind===action.instance.kind);
  if(existing)return analysisWorkspaceReducer(state,{type:'activate',id:existing.id});
  return{...state,instances:[...state.instances,action.instance],activeId:action.instance.id,groupActive:{...state.groupActive,[action.instance.group]:action.instance.id}};
 }
 const item=state.instances.find(row=>row.id===action.id);if(!item)return state;
 if(action.type==='window-bounds')return JSON.stringify(state.windowBounds?.[item.id])===JSON.stringify(action.bounds)?state:{...state,windowBounds:{...state.windowBounds,[item.id]:action.bounds}};
 if(action.type==='activate')return{...state,activeId:item.id,groupActive:item.detached?state.groupActive:{...state.groupActive,[item.group]:item.id}};
 const instances=action.type==='close'?state.instances.filter(row=>row.id!==item.id):state.instances.filter(row=>row.id!==item.id);
 if(action.type==='place'){const at=action.before?instances.findIndex(row=>row.id===action.before):-1;instances.splice(at<0?instances.length:at,0,{...item,group:action.group,detached:action.detached});}
 const groupActive={...state.groupActive};
 for(const group of Object.keys(groupActive))if(!instances.some(row=>row.group===group&&!row.detached&&row.id===groupActive[group])){const fallback=instances.filter(row=>row.group===group&&!row.detached).at(-1);if(fallback)groupActive[group]=fallback.id;else delete groupActive[group];}
 if(action.type==='place'&&!action.detached)groupActive[action.group]=item.id;
 const activeId=action.type==='close'&&state.activeId===item.id?(instances.at(-1)?.id??null):state.activeId;
 const windowBounds=state.windowBounds?Object.fromEntries(Object.entries(state.windowBounds).filter(([id])=>instances.some(item=>item.id===id))):undefined;
 return{...state,instances,activeId,groupActive,...(windowBounds?{windowBounds}:{})};
}
