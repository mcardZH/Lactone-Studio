import {useEffect, useMemo, useRef, useState, type RefObject} from 'react';
import type {PlotPointStyle} from '../../results/scientific-plot-editing';
import type {ScientificScatterData, ScatterPlotBounds} from '../../results/scatter-data';
import type {ScientificPlotViewport} from '../../results/scientific-plot';
import {paintScatterBatch} from './scientific-scatter-canvas';

type Layout = ScatterPlotBounds & {width:number;height:number};
export type ScatterPointColor = (index:number,x:number,y:number)=>string;
export interface ScatterPointLayerOptions {
  data:ScientificScatterData; range:ScientificPlotViewport|null; layout:Layout; size:number; alpha:number;
  colorForX(x:number):string; colorForPoint?:ScatterPointColor;
  appearance?(index:number):PlotPointStyle;
  displayScale:number;
  epoch:number;
  active:boolean;
}

/** Preserve the complete previous point layer while a new geometry is being painted. */
export function useScatterPointLayer(canvas:RefObject<HTMLCanvasElement|null>, host:RefObject<HTMLDivElement|null>, options:ScatterPointLayerOptions) {
  const {data,range,layout,size,alpha,colorForX,colorForPoint,appearance,displayScale,epoch,active}=options;
  const {width,height,left,right,top,bottom}=layout;
  const [status,setStatus]=useState<'drawing'|'ready'|'error'>('drawing');
  const [message,setMessage]=useState('');
  const identity=useMemo(()=>({}),[data,range?.x[0],range?.x[1],range?.y[0],range?.y[1],width,height,left,right,top,bottom,
    size,alpha,colorForX,colorForPoint,appearance,displayScale,epoch,active]);
  const painted=useRef<object|null>(null), failure=useRef<{identity:object;error:unknown}|null>(null);
  const counters=useRef({generations:0,commits:0});
  useEffect(()=>{
    const target=canvas.current, win=target?.ownerDocument.defaultView;
    if(!range||!active||!target||!win) return;
    const buffer=target.ownerDocument.createElement('canvas'), context=buffer.getContext('2d');
    painted.current=null;failure.current=null;setStatus('drawing');setMessage('');
    function report(error:unknown) {
      buffer.width=0;buffer.height=0;
      failure.current={identity,error};setStatus('error');
      setMessage(error instanceof Error?error.message:'散点绘制失败。');
    }
    if(!context){report(new Error('散点画布不可用。'));return;}
    const ratio=Math.max(1,displayScale*(win.devicePixelRatio||1));
    buffer.width=Math.ceil(width*ratio);buffer.height=Math.ceil(height*ratio);
    context.setTransform(buffer.width/width,0,0,buffer.height/height,0,0);
    counters.current.generations++;
    if(host.current?.dataset) host.current.dataset.scatterPaintGenerations=String(counters.current.generations);
    let frame=0, offset=0, cancelled=false;
    function paint() {
      if(cancelled||!win||!range||!context||!target) return;
      try {
        const started=performance.now();
        do {
          const end=Math.min(data.x.length,offset+1024);
          paintScatterBatch(context,data,range,layout,colorForX,size,alpha,offset,end,colorForPoint,appearance);
          offset=end;
        } while(offset<data.x.length && performance.now()-started<8);
        if(offset<data.x.length) {frame=win.requestAnimationFrame(paint);return;}
        const visible=target.getContext('2d');
        if(!visible) throw new Error('散点画布不可用。');
        if(target.width!==buffer.width) target.width=buffer.width;
        if(target.height!==buffer.height) target.height=buffer.height;
        visible.setTransform(1,0,0,1,0,0);visible.clearRect(0,0,target.width,target.height);visible.drawImage(buffer,0,0);
        counters.current.commits++;
        if(host.current?.dataset) host.current.dataset.scatterPaintCommits=String(counters.current.commits);
        painted.current=identity;buffer.width=0;buffer.height=0;setStatus('ready');
      } catch(error){report(error);}
    }
    frame=win.requestAnimationFrame(paint);
    return ()=>{cancelled=true;if(painted.current===identity)painted.current=null;win.cancelAnimationFrame(frame);buffer.width=0;buffer.height=0;};
  },[identity]);
  return {identity,painted,failure,status,message};
}
