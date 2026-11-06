import type { DisplaySettings } from '../../../modeling/contracts';
import type { Vector3 } from '../../../core/types';
import {finishRenderWork,type RenderWork} from './render-work';

// These values are the pre-v0.67 actual renderer/SVG values. Resolve on read:
// opening Settings must not materialize fields into a legacy project.
export const DEFAULT_BACKGROUND_COLOR = '#f8fafb';
export const DEFAULT_BOND_STYLE: Readonly<NonNullable<DisplaySettings['bondStyle']>> = Object.freeze({ colorMode:'elements', color:'#909090' });
export const DEFAULT_CELL_STYLE: Readonly<NonNullable<DisplaySettings['cellStyle']>> = Object.freeze({ lineStyle:'solid', color:'#168647', width:1.1 });
export const DEFAULT_AXIS_DISPLAY: Readonly<NonNullable<DisplaySettings['axisDisplay']>> = Object.freeze({ colors:Object.freeze({ X:'#c54b4b',Y:'#37945a',Z:'#3c70c5' }),lineWidth:2,length:31,fontSize:13 });
export const DISPLAY_APPEARANCE_LIMITS = Object.freeze({ cellWidth:[.5,8] as const, axisLineWidth:[.5,8] as const, axisLength:[10,120] as const, axisFontSize:[8,32] as const });
export const effectiveBackgroundColor = (display: Pick<DisplaySettings,'backgroundColor'>): string => display.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;
export function effectiveRotationSpeedPercent(display: Pick<DisplaySettings,'rotationSpeedPercent'>): number {
  const value=display.rotationSpeedPercent;return typeof value==='number'&&Number.isFinite(value)&&value>0?value:100;
}
/** Only camera drag rotation consumes this; wheel, pan and molecular edits do not. */
export function cameraRotationDrag(display:Pick<DisplaySettings,'rotationSpeedPercent'>,dx:number,dy:number):[number,number]{
  const scale=effectiveRotationSpeedPercent(display)/100;
  const length=Math.hypot(dx,dy),scaledLength=length*scale;
  // 900 pixels is exactly one full turn in rotateScreenView. Reduce enormous
  // legal percentages modulo a turn, avoiding overflow without capping speed.
  if(length>0&&(!Number.isFinite(scaledLength)||scaledLength>1e14)){
    const turns=900/length,remainder=(scale%turns)*length;
    return [dx/length*remainder,dy/length*remainder];
  }
  return [dx*scale,dy*scale];
}
export const effectiveBondStyle = (display: Pick<DisplaySettings,'bondStyle'>): NonNullable<DisplaySettings['bondStyle']> => ({ ...DEFAULT_BOND_STYLE,...display.bondStyle });
export const effectiveCellStyle = (display: Pick<DisplaySettings,'cellStyle'>): NonNullable<DisplaySettings['cellStyle']> => ({ ...DEFAULT_CELL_STYLE,...display.cellStyle });
export const effectiveAxisDisplay = (display: Pick<DisplaySettings,'axisDisplay'>): NonNullable<DisplaySettings['axisDisplay']> => ({ ...DEFAULT_AXIS_DISPLAY,...display.axisDisplay,colors:{ ...DEFAULT_AXIS_DISPLAY.colors,...display.axisDisplay?.colors } });
export function axisOverlayMetrics(display:Pick<DisplaySettings,'axisDisplay'>){
  const settings=effectiveAxisDisplay(display);
  const size=settings.length<=31&&settings.fontSize<=13?96:Math.max(96,Math.ceil(2*(settings.length+7+settings.fontSize/2+5)));
  return {settings,size,center:size/2};
}

/** Cylinder strokes work on Windows where WebGL line widths are capped at 1.
 * Input points already use the display transform. The returned segments never
 * change the cell, graph, atom coordinates, camera or scientific units. */
export function cellEdgeStrokes(start:Vector3,end:Vector3,pixelsPerUnit:number,display:Pick<DisplaySettings,'cellStyle'>,guide=false) {
  return finishRenderWork(cellEdgeStrokesWork(start,end,pixelsPerUnit,display,guide));
}
export function* cellEdgeStrokesWork(start:Vector3,end:Vector3,pixelsPerUnit:number,display:Pick<DisplaySettings,'cellStyle'>,guide=false):RenderWork<{start:Vector3;end:Vector3;radius:number;color:string}[]> {
  const style=effectiveCellStyle(display),density=Math.max(1,pixelsPerUnit);
  const radius=Math.max(.001,(guide?1:.55)*(style.width/DEFAULT_CELL_STYLE.width)/density);
  const stroke=(a:Vector3,b:Vector3)=>({ start:a,end:b,radius,color:style.color });
  if(style.lineStyle==='solid')return [stroke(start,end)];
  const length=Math.hypot(...end.map((value,axis)=>value-start[axis]));
  if(length<1e-12)return [];
  const dash=6/density,period=10/density,result:ReturnType<typeof stroke>[]=[];
  if(!Number.isFinite(length)||!Number.isFinite(density)||!Number.isSafeInteger(Math.ceil(length/period)))
    throw new Error('晶胞虚线段数超出可精确表示范围。');
  for(let index=0,count=Math.ceil(length/period);index<count;index++){
    yield;const offset=index*period;if(offset+period===offset)throw new Error('晶胞虚线步长超出坐标精度范围。');
    const at=(distance:number)=>start.map((value,axis)=>value+(end[axis]-value)*distance/length) as Vector3;
    result.push(stroke(at(offset),at(Math.min(length,offset+dash))));
  }
  return result;
}
