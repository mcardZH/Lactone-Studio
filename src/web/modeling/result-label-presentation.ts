import { createElement, Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type RefObject } from 'react';
import type { ScreenPoint } from '../../modeling/contracts';
import { MODEL_HOVER_LABEL_COLOR } from './modeling-interaction-policy';
import {placeResultLabels,type ResultLabelPlacement} from './result-label-layout';

export type ResultLabelAnchor = 'top-left' | 'center';
export interface ResultLabelPresentation extends ScreenPoint {
  lines: readonly string[];
  anchor: ResultLabelAnchor;
  fontSize: number;
  lineHeight: number;
  color: string;
  background: string;
  border: string;
  borderWidth: number;
  radius: number;
  paddingX: number;
  paddingY: number;
}

/** One box/line description for DOM and exported Canvas labels. No scientific state. */
export function resultLabelPresentation(text: string, point: ScreenPoint, anchor: ResultLabelAnchor, fontSize: number): ResultLabelPresentation {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 13;
  return { ...point, lines: text.split(/\r?\n/), anchor, fontSize: size, lineHeight: size * 1.4,
    color: MODEL_HOVER_LABEL_COLOR, background: '#fffffff0', border: '#9fb6c1', borderWidth: 1, radius: 4, paddingX: 5, paddingY: 2 };
}

export function resultLabelStyle(label: ResultLabelPresentation,placement?:ResultLabelPlacement): CSSProperties {
  return { position: 'absolute', zIndex: 6, pointerEvents: 'none', display: 'block', margin: 0, minHeight: 0,
    width: 'max-content', maxWidth: 'none', boxShadow: 'none', textShadow: 'none', fontVariantNumeric: 'tabular-nums',
    left: label.x, top: label.y, color: label.color, background: label.background,
    border: `${label.borderWidth}px solid ${label.border}`, borderRadius: label.radius,
    padding: `${label.paddingY}px ${label.paddingX}px`, font: `600 ${label.fontSize}px/${label.lineHeight}px system-ui`,
    whiteSpace: 'pre', textAlign: 'left', transform: label.anchor === 'center' ? 'translate(-50%,-50%)' : 'none',
    ...(placement?{left:placement.rect.x,top:placement.rect.y,width:placement.rect.width,height:placement.rect.height,boxSizing:'border-box',transform:'none'}:{}) };
}

/** Every pointer, table-preview and fixed label uses this same DOM element.
 * In particular, global button rules cannot change the analysis label box. */
export function ResultLabel({presentation,placement,bond=false,...props}:HTMLAttributes<HTMLOutputElement>&{presentation:ResultLabelPresentation;placement?:ResultLabelPlacement;bond?:boolean}){
  return createElement('output',{...props,className:bond?'model-hover-atom model-hover-bond':'model-hover-atom',
    style:{...resultLabelStyle(presentation,placement),...props.style}},presentation.lines.join('\n'));
}

export interface ResultLabelItem {id:string;presentation:ResultLabelPresentation;bond?:boolean;target?:ScreenPoint;attributes?:HTMLAttributes<HTMLOutputElement>&Record<string,unknown>}
export function resultLabelTargetKey(kind:'atom'|'pair',ids:readonly string[]){return kind+':'+JSON.stringify(kind==='pair'?[...ids].sort():ids);}
/** Pointer replacement keeps the fixed slot, target and priority. */
export function mergeResultLabelItems(items:readonly ResultLabelItem[],pointer?:ResultLabelItem):ResultLabelItem[]{
 const unique=new Map<string,ResultLabelItem>();for(const item of items)if(!unique.has(item.id))unique.set(item.id,item);
 if(pointer){const fixed=unique.get(pointer.id);unique.set(pointer.id,fixed?{...fixed,attributes:pointer.attributes}:pointer);}
 return [...unique.values()];
}
/** Same output/font metrics for the screen and offscreen Canvas. Temporary
 * measurement nodes are always removed; they never become a viewport owner. */
export function measureResultLabelBox(label:ResultLabelPresentation,ownerDocument:Document,canvas?:CanvasRenderingContext2D){
 const node=ownerDocument.createElement('output');
 if(node.nodeType===1){
  node.textContent=label.lines.join('\n');node.style.cssText=`position:fixed;left:-10000px;top:0;visibility:hidden;display:block;width:max-content;max-width:none;min-height:0;margin:0;box-sizing:content-box;font:600 ${label.fontSize}px/${label.lineHeight}px system-ui;font-variant-numeric:tabular-nums;white-space:pre;border:${label.borderWidth}px solid transparent;padding:${label.paddingY}px ${label.paddingX}px;`;
  ownerDocument.body.append(node);
  try{const rect=node.getBoundingClientRect();if(rect.width>0&&rect.height>0)return{width:Math.ceil(rect.width),height:Math.ceil(rect.height)};}finally{node.remove();}
 }
 // Non-DOM render-test contexts can supply the Canvas metric port. Real
 // browser/export documents always take the actual output measurement above.
 if(!canvas)throw new Error('标注尺寸无法测量。');
 canvas.save();try{canvas.font=`600 ${label.fontSize}px system-ui`;return{width:Math.max(0,...label.lines.map(line=>canvas.measureText(line).width))+2*(label.paddingX+label.borderWidth),height:label.lines.length*label.lineHeight+2*(label.paddingY+label.borderWidth)};}finally{canvas.restore();}
}
export function layoutResultLabelItems(items:readonly ResultLabelItem[],bounds:{width:number;height:number},measure:(label:ResultLabelPresentation)=>{width:number;height:number}){
 return placeResultLabels(items.map(item=>({id:item.id,point:item.presentation,anchor:item.presentation.anchor,target:item.target,...measure(item.presentation)})),bounds);
}
export function ResultLabelLayer({items,surface}:{items:readonly ResultLabelItem[];surface:RefObject<HTMLDivElement|null>}){
 const signature=JSON.stringify(items),bounds=surface.current?.getBoundingClientRect(),width=bounds?.width??0,height=bounds?.height??0;
 const [state,setState]=useState<{signature:string;width:number;height:number;placements:Map<string,ResultLabelPlacement>}|null>(null);
 const metricCache=useRef<{document:Document;values:Map<string,{width:number;height:number}>}|null>(null);
 useLayoutEffect(()=>{if(!surface.current||width<=0||height<=0)return;
  const doc=surface.current.ownerDocument;
  if(metricCache.current?.document!==doc)metricCache.current={document:doc,values:new Map()};
  const cache=metricCache.current!.values;
  const placements=layoutResultLabelItems(items,{width,height},label=>{const key=JSON.stringify([label.lines,label.fontSize,label.lineHeight,label.paddingX,label.paddingY,label.borderWidth]);let size=cache.get(key);if(!size){size=measureResultLabelBox(label,doc);if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(key,size);}return size;});
  setState({signature,width,height,placements});
 },[signature,width,height,surface]);
 const placements=state?.signature===signature&&state.width===width&&state.height===height?state.placements:undefined;
 return createElement(Fragment,null,
  createElement('svg',{'aria-hidden':true,'data-testid':'result-label-leaders',style:{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:5}},items.map(item=>{const leader=placements?.get(item.id)?.leader;return leader?createElement('line',{key:item.id,x1:leader.from.x,y1:leader.from.y,x2:leader.to.x,y2:leader.to.y,stroke:item.presentation.border,strokeWidth:1}):null;})),
  ...items.map(item=>createElement(ResultLabel,{...item.attributes,key:item.id,presentation:item.presentation,placement:placements?.get(item.id),bond:item.bond,'data-result-label-key':item.id,'data-label-placement-crowded':placements?.get(item.id)?.unresolved||undefined,'data-anchor-x':item.target?.x??item.presentation.x,'data-anchor-y':item.target?.y??item.presentation.y} as Parameters<typeof ResultLabel>[0])));
}

/** Match the DOM layer: every leader is behind every opaque label box. */
export function drawResultLabelItems(context:CanvasRenderingContext2D,items:readonly ResultLabelItem[],placements:ReadonlyMap<string,ResultLabelPlacement>){
 context.save();try{for(const item of items){const leader=placements.get(item.id)?.leader;if(!leader)continue;context.strokeStyle=item.presentation.border;context.lineWidth=1;context.beginPath();context.moveTo(leader.from.x,leader.from.y);context.lineTo(leader.to.x,leader.to.y);context.stroke();}}finally{context.restore();}
 for(const item of items){const placement=placements.get(item.id);drawResultLabel(context,item.presentation,placement?{...placement,leader:undefined}:undefined);}
}

/** Canvas uses the same box metrics and explicit lines; fillText never receives a newline. */
export function drawResultLabel(context: CanvasRenderingContext2D, label: ResultLabelPresentation,placement?:ResultLabelPlacement): void {
  context.save();
  try {
    context.font = `600 ${label.fontSize}px system-ui`;
    context.textAlign = 'left'; context.textBaseline = 'top';
    const width = placement?.rect.width??Math.max(0, ...label.lines.map(line => context.measureText(line).width)) + 2 * (label.paddingX + label.borderWidth);
    const height = placement?.rect.height??label.lines.length * label.lineHeight + 2 * (label.paddingY + label.borderWidth);
    const left = placement?.rect.x??label.x - (label.anchor === 'center' ? width / 2 : 0), top = placement?.rect.y??label.y - (label.anchor === 'center' ? height / 2 : 0);
    if(placement?.leader){context.strokeStyle=label.border;context.lineWidth=1;context.beginPath();context.moveTo(placement.leader.from.x,placement.leader.from.y);context.lineTo(placement.leader.to.x,placement.leader.to.y);context.stroke();}
    context.fillStyle = label.background; context.strokeStyle = label.border; context.lineWidth = label.borderWidth;
    context.beginPath(); context.roundRect(left + label.borderWidth / 2, top + label.borderWidth / 2, width - label.borderWidth, height - label.borderWidth, label.radius);
    context.fill(); context.stroke(); context.fillStyle = label.color;
    label.lines.forEach((line, index) => context.fillText(line, left + label.paddingX + label.borderWidth, top + label.paddingY + label.borderWidth + index * label.lineHeight));
  } finally { context.restore(); }
}
