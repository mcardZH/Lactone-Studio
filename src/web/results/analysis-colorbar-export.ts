import {analysisColorbarStops,formatAnalysisValue,type AnalysisColorbar} from './analysis-display';
import {resolveAnalysisColorbarRect} from './analysis-colorbar-layout';
import { exportBlob } from './export-image';

const xml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
/** A tight, transparent standalone legend with the same values and palette as the view. */
export function analysisColorbarSvg(colorbar:AnalysisColorbar):string {
  const values=[formatAnalysisValue(colorbar.min,colorbar.decimals),formatAnalysisValue(colorbar.max,colorbar.decimals)] as const;
  const rect=resolveAnalysisColorbarRect({...colorbar.layout,x:.5,y:.5,length:.5},{width:640,height:240},colorbar.label,1,values);
  const width=rect.width,height=rect.height,p=rect.padding,stops=analysisColorbarStops(colorbar);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="legend">${stops.map(({color,offset})=>`<stop offset="${offset*100}%" stop-color="${xml(color)}"/>`).join('')}</linearGradient></defs><g fill="#153846" font-family="system-ui,sans-serif" font-size="${rect.fontSize}">${rect.labelLines.map((line,index)=>`<text x="${p}" y="${p+index*rect.lineHeight+rect.fontSize}">${xml(line)}</text>`).join('')}<rect x="${p}" y="${rect.barTop}" width="${width-2*p}" height="${rect.barHeight}" fill="url(#legend)"/><text x="${p}" y="${rect.valuesTop+rect.fontSize}">${xml(values[0])}</text><text x="${width-p}" y="${rect.valuesTop+(rect.valueRows-1)*rect.lineHeight+rect.fontSize}" text-anchor="end">${xml(values[1])}</text></g></svg>`;
}
export async function exportAnalysisColorbar(colorbar:AnalysisColorbar,format:'svg'|'png',doc:Document=document):Promise<void> {
  const svg=analysisColorbarSvg(colorbar),blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
  if(format==='svg'){exportBlob(blob,'Ester-Studio-colorbar.svg',doc);return;}
  const win=doc.defaultView;if(!win)throw new Error('当前窗口无法导出色标。');
  const url=win.URL.createObjectURL(blob);
  try {
    const image=new win.Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('色标图片生成失败。'));image.src=url;});
    const canvas=doc.createElement('canvas');canvas.width=image.width*2;canvas.height=image.height*2;
    const context=canvas.getContext('2d');if(!context)throw new Error('当前环境无法导出 PNG 色标。');context.drawImage(image,0,0,canvas.width,canvas.height);
    const png=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('PNG 色标生成失败。')),'image/png'));
    exportBlob(png,'Ester-Studio-colorbar.png',doc);
  } finally {win.URL.revokeObjectURL(url);}
}

/** Consumes exactly the screen card geometry and color stops; never edits the range. */
export function drawAnalysisColorbar(context:CanvasRenderingContext2D,colorbar:AnalysisColorbar,size:{width:number;height:number},sourceViewport?:{width:number;height:number}) {
  const scale=sourceViewport&&[sourceViewport.width,sourceViewport.height].every(value=>Number.isFinite(value)&&value>0)?Math.min(size.width/sourceViewport.width,size.height/sourceViewport.height):1;
  const values=[formatAnalysisValue(colorbar.min,colorbar.decimals),formatAnalysisValue(colorbar.max,colorbar.decimals)] as const;
  const rect=resolveAnalysisColorbarRect(colorbar.layout,size,colorbar.label,scale,values),x=rect.left+rect.padding,w=rect.width-2*rect.padding;
  context.save();
  context.fillStyle='#153846';context.font=`${rect.fontSize}px system-ui`;context.textAlign='left';context.textBaseline='top';
  rect.labelLines.forEach((line,index)=>context.fillText(line,x,rect.top+rect.padding+index*rect.lineHeight));
  const gradient=context.createLinearGradient(x,0,x+w,0),stops=analysisColorbarStops(colorbar);
  stops.forEach(({color,offset})=>gradient.addColorStop(offset,color));context.fillStyle=gradient;context.fillRect(x,rect.top+rect.barTop,w,rect.barHeight);
  context.fillStyle='#153846';context.fillText(values[0],x,rect.top+rect.valuesTop);context.textAlign='right';context.fillText(values[1],x+w,rect.top+rect.valuesTop+(rect.valueRows-1)*rect.lineHeight);context.restore();
  return rect;
}
