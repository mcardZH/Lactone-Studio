/** Local presentation geometry. x/y locate the card centre within its viewport;
 * length is card width / viewport width. None of these fields changes values. */
export interface AnalysisColorbarLayout { x:number; y:number; length:number }
export const DEFAULT_ANALYSIS_COLORBAR_LAYOUT:Readonly<AnalysisColorbarLayout> = Object.freeze({x:.82,y:.9,length:.22});
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
export function normalizeAnalysisColorbarLayout(layout?:Partial<AnalysisColorbarLayout>|null):AnalysisColorbarLayout {
  const finite=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
  return {x:clamp(finite(layout?.x,DEFAULT_ANALYSIS_COLORBAR_LAYOUT.x),0,1),y:clamp(finite(layout?.y,DEFAULT_ANALYSIS_COLORBAR_LAYOUT.y),0,1),length:clamp(finite(layout?.length,DEFAULT_ANALYSIS_COLORBAR_LAYOUT.length),.12,.8)};
}
export interface AnalysisColorbarRect {left:number;top:number;width:number;height:number;padding:number;fontSize:number;lineHeight:number;barTop:number;barHeight:number;valuesTop:number;valueRows:1|2;labelLines:string[]}
function labelLines(label:string,available:number,fontSize:number):string[]{
  const lines:string[]=[];let line='',used=0;
  for(const char of Array.from(label)){
    if(char==='\n'){lines.push(line);line='';used=0;continue;}
    const size=fontSize*(char.charCodeAt(0)>255?1:.6);
    if(line&&used+size>available){lines.push(line);line='';used=0;}
    line+=char;used+=size;
  }
  lines.push(line);return lines;
}
/** One layout resolver for DOM and exported canvas. Export scale is derived
 * from the captured source viewport, preserving text and marker proportions. */
export function resolveAnalysisColorbarRect(layout:AnalysisColorbarLayout|undefined,size:{width:number;height:number},label:string,scale=1,values?:readonly [string,string]):AnalysisColorbarRect {
  if(![size.width,size.height,scale].every(value=>Number.isFinite(value)&&value>0))throw new Error('色标视口尺寸必须为正有限值。');
  const normalized=normalizeAnalysisColorbarLayout(layout),margin=Math.min(8*scale,size.width/8,size.height/8),padding=8*scale,fontSize=12*scale,lineHeight=16*scale;
  const minimum=Math.max(40*scale,values?Math.max(...values.map(value=>value.length))*fontSize*.6+2*padding:0);
  const minimumWidth=Math.min(Math.max(minimum,.12*size.width),Math.max(1,size.width-2*margin));
  // Resolve an off-screen saved centre once against the minimum usable width.
  // Width changes then share this fixed centre rather than pushing the legend.
  const centerX=clamp(normalized.x*size.width,margin+minimumWidth/2,size.width-margin-minimumWidth/2);
  const maximumWidth=Math.max(minimumWidth,2*Math.min(centerX-margin,size.width-margin-centerX));
  const width=clamp(normalized.length*size.width,minimumWidth,maximumWidth);
  const valueRows:1|2=values&&values.reduce((sum,value)=>sum+value.length*fontSize*.6,8*scale)>width-2*padding?2:1;
  const lines=labelLines(label,Math.max(fontSize,width-2*padding),fontSize),barHeight=10*scale,barTop=padding+lines.length*lineHeight+4*scale,valuesTop=barTop+barHeight+4*scale,height=valuesTop+valueRows*lineHeight+padding;
  return {left:centerX-width/2,top:clamp(normalized.y*size.height-height/2,margin,Math.max(margin,size.height-height-margin)),width,height,padding,fontSize,lineHeight,barTop,barHeight,valuesTop,valueRows,labelLines:lines};
}
export function moveAnalysisColorbarLayout(layout:AnalysisColorbarLayout,delta:{x:number;y:number},size:{width:number;height:number}):AnalysisColorbarLayout {
  if(![delta.x,delta.y,size.width,size.height].every(Number.isFinite)||size.width<=0||size.height<=0)throw new Error('色标拖动范围无效。');
  const normalized=normalizeAnalysisColorbarLayout(layout),margin=Math.min(8,size.width/8)/size.width,half=Math.min(.5,normalized.length/2+margin);
  return normalizeAnalysisColorbarLayout({...normalized,x:clamp(normalized.x+delta.x/size.width,half,1-half),y:normalized.y+delta.y/size.height});
}
export function resizeAnalysisColorbarLayout(layout:AnalysisColorbarLayout,deltaX:number,width:number):AnalysisColorbarLayout {
  if(!Number.isFinite(deltaX)||!Number.isFinite(width)||width<=0)throw new Error('色标长度范围无效。');
  const normalized=normalizeAnalysisColorbarLayout(layout),margin=Math.min(8,width/8)/width;
  const maximum=Math.max(.12,Math.min(.8,2*Math.min(normalized.x-margin,1-margin-normalized.x)));
  return {...normalized,length:clamp(normalized.length+2*deltaX/width,.12,maximum)};
}
