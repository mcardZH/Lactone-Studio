import type {ResultFrameSummary} from './contracts';
import {convertEnergy,type EnergySeries} from './energy';
import {decimalEnergyValue} from './numeric-format';
import type {ScientificPlotSeries} from './scientific-plot';

/** Display-only curve members never become player frames or input geometry. */
export interface TrajectoryEnergyGap {beforeIndex:number;x:number|null;label?:string}
export interface TrajectoryEnergyOverlay {
  id:string;label:string;
  points:readonly {x:number|null;energy:ResultFrameSummary['energy'];frameId?:string;breakBefore?:boolean}[];
}

/** Every curve consumes the current shared plot's one unit and one reference. */
export function projectTrajectoryEnergyOverlays(overlays:readonly TrajectoryEnergyOverlay[],display:Pick<EnergySeries,'unit'|'relative'|'referenceValue'>,startIndex:number){
  const picks=new Map<number,{seriesId:string;frameId:string}>();
  const text=[`曲线\t帧 ID\t横坐标\tE / hartree\t${display.relative?'ΔE':'E'} / ${display.unit}`];
  let index=startIndex;
  const series:ScientificPlotSeries[]=overlays.map(overlay=>({id:overlay.id,label:overlay.label,points:overlay.points.flatMap(point=>{
    const raw=convertEnergy(point.energy,'hartree'),absolute=convertEnergy(point.energy,display.unit);
    const y=absolute===null||display.relative&&display.referenceValue===null?null:absolute-(display.relative?display.referenceValue!:0);
    const pick=point.frameId?index++:undefined;if(pick!==undefined)picks.set(pick,{seriesId:overlay.id,frameId:point.frameId!});
    text.push([overlay.label,point.frameId??'',point.x??'',raw===null?'':decimalEnergyValue(raw),y===null?'':decimalEnergyValue(y)].join('\t'));
    const value={x:point.x??NaN,y:point.x===null?null:y,index:pick,label:`${overlay.label} · ${point.frameId??''}`,tooltip:`${overlay.label} · ${point.frameId??''} · ${y===null?'能量缺失':decimalEnergyValue(y)+' '+display.unit}`};
    return point.breakBefore?[{x:point.x??NaN,y:null},value]:[value];
  })}));
  return{series,picks,text:text.join('\n')+'\n'};
}
