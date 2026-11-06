import {useEffect,useMemo,useRef,useState} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import type {Structure} from '../../core/types';
import type {AnalysisHighlightProps} from './AnalysisControls';
import {ScientificDataTable} from './ScientificDataTable';
import type {ScientificTableProjection} from './scientific-table';
import {formatResultValue} from '../../results/numeric-format';
import {activeAnalysisRows,toggleAnalysisRow} from './analysis-display';
import type {WavefunctionOrbital} from '../../results/orbital-contracts';
import type {OrbitalListProps} from './OrbitalList';
import {convertEnergy} from '../../results/energy';

/** List values only. This grants no basis/coefficients/native session capability. */
export function printedOrbitalList(result:TrajectoryResult|null,frameIndex:number):OrbitalListProps['metadata']|null{
 if(!result)return null;
 const latest=new Map<string,NonNullable<TrajectoryResult['scientific']>['orbitals'][number]>();for(const channel of result.scientific?.orbitals??[])if(channel.frameIndex===frameIndex)latest.set(channel.spin,channel);
 const channels=[...latest.values()];
 if(!channels.length)return null;
 // Only the presentation index changes: OUT keys/source indices remain native.
 const orbitals:WavefunctionOrbital[]=channels.flatMap(channel=>channel.orbitals.map((row,index)=>({key:`printed:${channel.spin}:${row.index}`,spin:channel.spin,ordinal:index+1,sourceIndex:row.sourceIndex??row.index,displayIndex:row.index+(result.engine==='orca'?1:0),energy:Number.isFinite(row.energy)?convertEnergy({value:row.energy,unit:channel.unit},'hartree'):null,energyUnit:'hartree' as const,occupation:Number.isFinite(row.occupation)?row.occupation:null,sourceLine:row.sourceLine??channel.sourceLine,sourceField:channel.sourceName??result.source.name})));
 return{sourceId:result.source.id,sourceRevision:JSON.stringify([result.id,result.jobIndex,frameIndex,result.frames[frameIndex]?.sourceFrameIndex??frameIndex]),orbitals};
}

/** Existing printed rows map by source atom order, never by a guessed aN id. */
export function printedChargeHighlights(result:TrajectoryResult|null,structure:Structure|undefined,currentIndex:number,keys:readonly string[],decimals=2){
 const selected=new Set(keys),rows=new Map<string,{atomId:string;value:number;labels:string[]}>();
 for(const property of result?.scientific?.atomicProperties??[]){
  if(property.frameIndex!==currentIndex||property.kind!=='charge'&&property.kind!=='spin')continue;
  for(const row of property.values){
   const atom=structure?.atoms[row.atomIndex];
   if(!Number.isSafeInteger(row.atomIndex)||row.atomIndex<0||!atom?.id||!selected.has(atom.id)||row.element&&row.element!==atom.element||!Number.isFinite(row.value))continue;
   let target=rows.get(atom.id);if(!target){target={atomId:atom.id,value:row.value,labels:[]};rows.set(atom.id,target);}
   target.labels.push(`${property.scheme}: ${property.kind==='spin'?'Spin':'Q'}=${formatResultValue(row.value,decimals)}${property.unit?` ${property.unit}`:''}`);
  }
 }
 const values=[...rows.values()].map(row=>({atomId:row.atomId,value:row.value,label:[...new Set(row.labels)].join('\n')}));
 return {ids:values.map(row=>row.atomId),values};
}
export interface PrintedChargeHighlightSnapshot {sourceId:string;frameIndex:number;ids:string[];values?:{atomId:string;value:number;label?:string}[]}
/** Late publications from a different source/frame never reach the canvas. */
export function currentPrintedChargeHighlights(snapshot:PrintedChargeHighlightSnapshot|undefined,result:TrajectoryResult,structure:Structure,currentIndex:number){
 const empty={ids:[] as string[],values:[] as NonNullable<PrintedChargeHighlightSnapshot['values']>};
 if(!snapshot||snapshot.sourceId!==result.source.id||snapshot.frameIndex!==currentIndex)return empty;
 const stable=new Set(structure.atoms.map(atom=>atom.id)),ids=new Set(snapshot.ids),values=snapshot.values??[];
 if(ids.size!==snapshot.ids.length||snapshot.ids.some(id=>!stable.has(id))||values.some(row=>!ids.has(row.atomId)||!Number.isFinite(row.value))||snapshot.ids.some(id=>!values.some(row=>row.atomId===id)))return empty;
 return {ids:snapshot.ids,values};
}

/** Read-only source data is independent of optional wavefunction computation. */
export function PrintedFrameProperties(p:{result:TrajectoryResult|null;structure?:Structure;currentIndex:number;kind:'charges'|'orbitals';active?:boolean;decimals?:number;onAtomHighlight?:AnalysisHighlightProps['onAtomHighlight']}){
 const {result,currentIndex,kind}=p;
 const decimals=p.decimals??2,number=(value:number|null|undefined)=>formatResultValue(value,decimals);
 const data=result?.scientific;
 const structure=p.structure??(result?.frames.length===1?result.initialStructure:undefined);
 const identity=JSON.stringify([result?.id,result?.source.id,currentIndex]);
 const visit=useRef({identity,active:p.active!==false,epoch:0});
 if(visit.current.identity!==identity||visit.current.active!==(p.active!==false))visit.current={identity,active:p.active!==false,epoch:visit.current.epoch+1};
 const epoch=visit.current.epoch;
 const [pins,setPins]=useState<Record<string,string[]>>({}),[hover,setHover]=useState<{epoch:number;key:string|null}>({epoch,key:null}),[current,setCurrent]=useState<{epoch:number;key:string|null}>({epoch,key:null});
 const pinned=pins[identity]??[],hovered=hover.epoch===epoch?hover.key:null;
 const highlights=useMemo(()=>printedChargeHighlights(result,structure,currentIndex,p.active===false||kind!=='charges'?[]:activeAnalysisRows([...new Set([...pinned,...(current.epoch===epoch&&current.key?[current.key]:[])])],hovered),decimals),[result,structure,currentIndex,p.active,kind,pins,hovered,current,epoch,decimals]);
 const callbacks=useRef(p.onAtomHighlight);callbacks.current=p.onAtomHighlight;
 useEffect(()=>{callbacks.current?.(highlights.ids,highlights.values);},[highlights]);
 useEffect(()=>()=>callbacks.current?.([],[]),[]);
 const interaction=(key:string)=>({'aria-selected':current.epoch===epoch&&current.key===key,onPointerEnter:()=>setHover({epoch,key}),onPointerLeave:()=>setHover({epoch,key:null})});
 if(kind==='charges'){
  const properties=data?.atomicProperties.filter(row=>row.frameIndex===currentIndex&&(row.kind==='charge'||row.kind==='spin'))??[];
  return <>{properties.map((property,index)=>{
   const projection:ScientificTableProjection={columns:[{key:'atom',label:'原子'},{key:property.scheme,label:`${property.scheme} / ${property.unit}`}],rows:property.values.map(row=>({key:structure?.atoms[row.atomIndex]?.id??`unmapped:${row.atomIndex}`,cells:[`${row.atomIndex+1}${row.element??structure?.atoms[row.atomIndex]?.element??''}`,number(row.value)]}))};
   return <details key={`${currentIndex}:${index}`} className="postprocess-display-fold" open={properties.length===1}><summary>来源打印 · {property.scheme} · {property.kind==='spin'?'自旋':'电荷'}</summary><ScientificDataTable title={`来源打印 · ${property.scheme}`} renderHeader={column=>column.key==='atom'?'原子':property.scheme} projection={projection} format={{decimals,onDecimalsChange:()=>{},locked:true,ariaLabel:'来源电荷'}} onRowActivate={row=>{if(!row.key.startsWith('unmapped:'))setCurrent({epoch,key:row.key});}} onClearActive={()=>{setCurrent({epoch,key:null});setHover({epoch,key:null});}} selectionScope={JSON.stringify([identity,'charges',index])} rowBindings={row=>row.key.startsWith('unmapped:')?{}:interaction(row.key)} rowAction={{kind:'pin',label:row=>`${pinned.includes(row.key)?'取消固定':'固定'} ${row.cells[0]}`,available:row=>!row.key.startsWith('unmapped:'),active:row=>pinned.includes(row.key),onActivate:row=>setPins(previous=>({...previous,[identity]:toggleAnalysisRow(previous[identity]??[],row.key)}))}}/></details>;
  })}</>;
 }
 const channels=data?.orbitals.filter(row=>row.frameIndex===currentIndex)??[];
 return <>{channels.map((channel,index)=>{
  const projection:ScientificTableProjection={columns:[{key:'orbital',label:'轨道'},{key:'energy',label:`能量 / ${channel.unit}`},{key:'occupation',label:'占据数'}],rows:channel.orbitals.map(row=>({key:String(row.index),cells:[String(row.index+(p.result?.engine==='orca'?1:0)),number(row.energy),Number.isInteger(row.occupation)?String(row.occupation):number(row.occupation)]}))};
  return <details key={`${currentIndex}:${index}`} className="postprocess-display-fold" open><summary>来源轨道 · {channel.spin}</summary><ScientificDataTable variant="legacy" projection={projection} selectionScope={JSON.stringify([identity,'orbitals',channel.spin,index])}/></details>;
 })}</>;
}
