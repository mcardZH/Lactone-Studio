export interface ScatterLegendLayout { x: number; y: number; width: number }
export type ScatterLegendGesture = 'move' | 'left' | 'right';

/** Coordinates belong to the SVG, independent of its CSS size and data range. */
export function scatterLegendLayout(bounds: { width: number; height: number; bottom: number }, saved: ScatterLegendLayout | null): ScatterLegendLayout {
  const x=Math.max(48,Math.min(saved?.x??bounds.width/2,bounds.width-48));
  const width = Math.max(48, Math.min(saved?.width ?? Math.min(140, bounds.width * .4), 2*Math.min(x-24,bounds.width-24-x)));
  return { width, x,
    y: Math.max(22, Math.min(saved?.y ?? bounds.bottom + 73, bounds.height - 30)) };
}

export function dragScatterLegend(start: ScatterLegendLayout, mode: ScatterLegendGesture, dx: number, dy: number, bounds: { width: number; height: number; bottom: number }): ScatterLegendLayout {
  const current=scatterLegendLayout(bounds,start),maximum=Math.max(48,2*Math.min(current.x-24,bounds.width-24-current.x));
  if (mode === 'move') return {...current,x:Math.max(24+current.width/2,Math.min(current.x+dx,bounds.width-24-current.width/2)),y:Math.max(22,Math.min(current.y+dy,bounds.height-30))};
  const width=Math.max(48,Math.min(current.width+2*(mode==='left'?-dx:dx),maximum));
  return {...current,width};
}
