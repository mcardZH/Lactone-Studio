import { scatterPointValid, scatterScreenPoint, type ScientificScatterData, type ScatterPlotBounds } from '../../results/scatter-data';
import type { ScientificPlotViewport } from '../../results/scientific-plot';
import type { PlotPointStyle } from '../../results/scientific-plot-editing';

type InkSource = (index: number) => PlotPointStyle;
type CanvasInk = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'rect' | 'clip' | 'arc' | 'fill' | 'fillStyle' | 'globalAlpha'> &
  Partial<Pick<CanvasRenderingContext2D,'moveTo'|'lineTo'|'closePath'|'stroke'|'strokeStyle'|'lineWidth'>>;

function vertices(shape: PlotPointStyle['marker'], x: number, y: number, r: number): [number,number][] {
  if (shape === 'triangle') return [[x,y-r],[x+r,y+r],[x-r,y+r]];
  if (shape === 'diamond') return [[x,y-r],[x+r,y],[x,y+r],[x-r,y]];
  return [[x-r,y-r],[x+r,y-r],[x+r,y+r],[x-r,y+r]];
}
function ink(context: CanvasInk, x:number, y:number, size:number, color:string, mark?:PlotPointStyle) {
  const r=(mark ? mark.size*4/3 : size)/2, kind=mark?.marker??'circle';
  context.beginPath();
  if(kind==='circle') context.arc(x,y,r,0,Math.PI*2);
  else if(kind==='cross') {
    context.moveTo?.(x-r,y);context.lineTo?.(x+r,y);
    context.moveTo?.(x,y-r);context.lineTo?.(x,y+r);
  } else {
    const [a,...rest]=vertices(kind,x,y,r);
    context.moveTo?.(...a);rest.forEach(p=>context.lineTo?.(...p));context.closePath?.();
  }
  if(!mark?.hollow && kind!=='cross') {context.fillStyle=mark?.fillOverride?mark.fillColor:color;context.fill();}
  if(mark && (mark.hollow||kind==='cross'||mark.edgeWidth>0)) {
    context.lineWidth=Math.max(.45,mark.edgeWidth*4/3);
    context.strokeStyle=mark.edgeOverride?mark.edgeColor:color;
    context.stroke?.();
  }
}

/** Every valid in-view point is painted in source order. Batching changes scheduling, not data. */
export function paintScatterBatch(context: CanvasInk,
  data: ScientificScatterData, viewport: ScientificPlotViewport, bounds: ScatterPlotBounds, colorForX: (x: number) => string,
  pointSize: number, opacity: number, start = 0, end = data.x.length, colorForPoint?: (index: number, x: number, y: number) => string,
  appearance?: InkSource): number {
  let count = 0;
  context.save(); context.beginPath(); context.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top); context.clip();
  context.globalAlpha = opacity;
  try {
    for (let i = start; i < Math.min(end, data.x.length); i++) {
      if (!scatterPointValid(data, i)) continue;
      const x = data.x[i], y = data.y[i];
      if (x < viewport.x[0] || x > viewport.x[1] || y < viewport.y[0] || y > viewport.y[1]) continue;
      const p = scatterScreenPoint(x, y, viewport, bounds);
      ink(context,p.x,p.y,pointSize,colorForPoint?.(i,x,y)??colorForX(x),appearance?.(i)); count++;
    }
  } finally { context.restore(); }
  return count;
}

/** Bounded vector export only; nodes are created in the exporting document, never on screen. */
export function appendScatterVectorPoints(parent: SVGElement, data: ScientificScatterData, viewport: ScientificPlotViewport,
  bounds: ScatterPlotBounds, colorForX: (x: number) => string, pointSize: number, opacity: number,
  colorForPoint?: (index: number, x: number, y: number) => string, appearance?: InkSource): number {
  let count = 0;
  for (let i = 0; i < data.x.length; i++) {
    if (!scatterPointValid(data, i) || data.x[i] < viewport.x[0] || data.x[i] > viewport.x[1] || data.y[i] < viewport.y[0] || data.y[i] > viewport.y[1]) continue;
    const p = scatterScreenPoint(data.x[i], data.y[i], viewport, bounds), mark=appearance?.(i), kind=mark?.marker??'circle';
    const point=parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg',kind==='circle'?'circle':kind==='cross'?'path':'polygon');
    const r=(mark ? mark.size*4/3 : pointSize)/2, color=colorForPoint?.(i,data.x[i],data.y[i])??colorForX(data.x[i]);
    const geometry=kind==='circle'?{cx:p.x,cy:p.y,r}:kind==='cross'?{d:'M'+(p.x-r)+' '+p.y+'h'+2*r+' M'+p.x+' '+(p.y-r)+'v'+2*r}
      :{points:vertices(kind,p.x,p.y,r).map(pair=>pair.join(',')).join(' ')};
    const stroked=mark&&(mark.hollow||kind==='cross'||mark.edgeWidth>0);
    for(const [name,value] of Object.entries({...geometry,opacity,fill:mark?.hollow||kind==='cross'?'none':mark?.fillOverride?mark.fillColor:color,
      ...(stroked?{stroke:mark.edgeOverride?mark.edgeColor:color,'stroke-width':Math.max(.45,mark.edgeWidth*4/3)}:{})})) point.setAttribute(name,String(value));
    parent.appendChild(point); count++;
  }
  return count;
}
