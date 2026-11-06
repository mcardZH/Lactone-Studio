import { FREEZE_COLOR } from '../../core/display-highlights';

/** Existing Lucide Snowflake geometry, shared by the SVG and image canvas. */
export const FREEZE_ICON_PATHS = [
  'm10 20-1.25-2.5L6 18', 'M10 4 8.75 6.5 6 6',
  'm14 20 1.25-2.5L18 18', 'm14 4 1.25 2.5L18 6',
  'm17 21-3-6h-4', 'm17 3-3 6 1.5 3', 'M2 12h6.5L10 9',
  'm20 10-1.5 2 1.5 2', 'M22 12h-6.5L14 15',
  'm4 10 1.5 2L4 14', 'm7 21 3-6-1.5-3', 'm7 3 3 6h4',
] as const;

export function drawFreezeMarker(context:CanvasRenderingContext2D,x:number,y:number):void {
  context.save();context.translate(x,y);
  context.fillStyle='#ecf5ffeb';context.strokeStyle=FREEZE_COLOR;context.lineWidth=1;
  context.beginPath();context.arc(0,0,8.5,0,Math.PI*2);context.fill();context.stroke();
  context.translate(-6.5,-6.5);context.scale(13/24,13/24);
  context.lineWidth=2;context.lineCap='round';context.lineJoin='round';
  const Path=context.canvas.ownerDocument.defaultView?.Path2D??Path2D;
  for(const path of FREEZE_ICON_PATHS)context.stroke(new Path(path));
  context.restore();
}
