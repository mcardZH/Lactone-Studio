import {useEffect, useId, useMemo, useRef, useState, type ReactNode, type KeyboardEvent} from 'react';
import {assertResultNotAborted} from '../../results/contracts';
import {nearestScatterPoint, scatterDataSummary, scatterDataText, scatterXIndex, type ScientificScatterData, type ScientificScatterPoint} from '../../results/scatter-data';
import {plotFonts,plotPointKey, type PlotNote, type PlotPaneEdits} from '../../results/scientific-plot-editing';
import {formatResultValue} from '../../results/numeric-format';
import {validPlotViewport, type ScientificPlotSeries, type ScientificPlotViewport} from '../../results/scientific-plot';
import type {ScatterColorScaleValue, ScatterScaleSource} from '../../results/scientific-scatter-scale';
import {interpolateColor} from '../../results/zero-centered-color';
import {useProjectState} from '../../projects/ui-state';
import {plotClientPoint} from '../../results/optimization-plot-axis';
import {plotFontFamily, usePlotAppearance, usePlotFont} from './ScientificPlotSettings';
import {useScientificPlotSize} from './ScientificPlotSize';
import {ScientificPlotDrawing, plotGeometry} from './ScientificPlotDrawing';
import {ScientificScatterColorScale, ScatterColorScaleFields, scatterScaleFraction, scatterScaleTicks, type ScatterScaleChange} from './ScientificScatterColorScale';
import {applyPlotPreset, fallbackPlotStyle, figureViewport, plotPresetSnapshot, plotTextInput, usePlotFigure, usePlotPresetLibrary} from './scientific-plot-figure';
import {canRemovePlotTarget, hasPlotSettingsTarget, matchesRemovedPlotTarget, PlotEditorToolbar, PlotInspector, PlotPresetControls, PlotQuickControls, PlotQuickPopover, plotPanels, type PlotPanel, type PlotTarget} from './ScientificPlotEditor';
import {insidePlot, targetFromPlotHit, usePlotGestures, clampPlot, type PlotSelection} from './use-plot-gestures';
import {editCurrentPlot,plotCanvasConfiguration,plotEditorPane,plotPartCapabilities, plotMapping} from './plot-editor-pane';
import {PlotSettingsWindow} from './VisualizationPresetDialog';
import {captureScientificSvgPng} from './optimization-export';
import {scatterSvgSnapshot, waitForScatterFrame} from './scientific-scatter-export';
import {useScatterPointLayer} from './useScatterPointLayer';
import {exportBlob} from './export-image';
import {ScientificPlotExportMenu} from './ScientificPlotExportMenu';
import {ResultsMcpPlotRegistration,type PlotExportFormat} from './results-mcp-context';
import {ScientificImageCopyButton} from '../ScientificImageCopyButton';
import {objectSchema} from '../mcp/types';
import {settingArray,settingBool,settingColor,settingEnum,settingNumber,settingNumberFormat,settingText} from './analysis-mcp-settings';
import {ANALYSIS_COLORBAR_LIMITS} from './analysis-colorbar-layout';
import './OptimizationPlot.css';
import './ScientificScatterPlot.css';
import './scientific-plot-editing.css';

export type {ScientificScatterData, ScientificScatterPoint, ScientificPlotViewport};

export interface ScientificScatterExportHandle {
  /** Waits for this scene's complete point layer; stale or cancelled scenes reject. */
  snapshotSvg(signal?: AbortSignal): Promise<string>;
  ownerDocument: Document;
}
export interface ScientificScatterPlotProps {
  title: string; xLabel: string; yLabel: string; appearanceKey?: string | number; data: ScientificScatterData;
  /** Source mapping remains authoritative until the figure receives a custom palette. */
  colorForX(value: number): string;
  colorForPoint?(index: number, x: number, y: number): string;
  colorLegend?: ScatterScaleSource;
  colorScaleControls?(value: ScatterColorScaleValue, onChange: ScatterScaleChange, manualRange: boolean): ReactNode;
  pointSize?: number;
  opacity?: number;
  viewport?: ScientificPlotViewport | null; onViewportChange?(value: ScientificPlotViewport | null): void;
  initialViewport?: ScientificPlotViewport | null;
  resetKey?: string | number; height?: number; decimals?: number;
  exportFileName?: string; metadata?: unknown; ariaLabel?: string; testId?: string;
  exportHandle?(api: ScientificScatterExportHandle | null): void;
  onPointSelect?(point: ScientificScatterPoint | null): void; children?: ReactNode;
  embeddedPresetEditor?: boolean;
}
export const SCATTER_VECTOR_EXPORT_LIMIT = 20000;
const series:readonly ScientificPlotSeries[]=[{id:'scatter',label:'Scatter',points:[]}];
const emptyRange:ScientificPlotViewport={x:[0,1],y:[0,1]};
const editableCopyTarget = (target: EventTarget | null) => Boolean((target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
const sameRange=(a:ScientificPlotViewport|null|undefined,b:ScientificPlotViewport|null|undefined)=>
  a===b||!!a&&!!b&&a.x[0]===b.x[0]&&a.x[1]===b.x[1]&&a.y[0]===b.y[0]&&a.y[1]===b.y[1];

function hexColor(color:string) {
  if(/^#[0-9a-f]{6}$/i.test(color)) return color;
  const rgb=color.match(/\d+/g);
  return rgb?.length===3?'#'+rgb.map(value=>Number(value).toString(16).padStart(2,'0')).join(''):'#64748b';
}

export function ScientificScatterPlot({title,xLabel,yLabel,data,colorForX,colorForPoint,colorLegend,pointSize,opacity,
  viewport,onViewportChange,initialViewport,resetKey,height,decimals=2,exportFileName='Ester-Studio-scatter',metadata,ariaLabel=title,
  testId='scientific-scatter-plot',exportHandle,onPointSelect,children,appearanceKey,embeddedPresetEditor=false,colorScaleControls}:ScientificScatterPlotProps) {
  const id=useId().replace(/:/g,''), owner=appearanceKey??exportFileName;
  const appearance=usePlotAppearance(owner), legacy=appearance.value;
  const host=useRef<HTMLDivElement>(null), stage=useRef<HTMLDivElement>(null), canvas=useRef<HTMLCanvasElement>(null),svg=useRef<SVGSVGElement>(null);
  const family=colorLegend?.valueForPoint?'fingerprint':'scatter';
  const library=usePlotPresetLibrary(family);
  const record=usePlotFigure(owner,{presetId:library.defaultId}), [draft,preview]=useState<PlotPaneEdits>();
  const sizing=useScientificPlotSize(owner,record);
  usePlotFont(host.current?.ownerDocument);
  const [localSize]=useProjectState('scatter.pointSize',2,owner);
  const [localOpacity]=useProjectState('scatter.opacity',.65,owner);
  const [advanced,setAdvanced]=useState(false), [panel,setPanel]=useState<PlotPanel>('series');
  const [selected,setSelected]=useState<PlotSelection>(),[picked,setPicked]=useState<ScientificScatterPoint|null>(null);
  const [hover,setHover]=useState<{point:ScientificScatterPoint;x:number;y:number}>();
  const [scalePopup,setScalePopup]=useState<{x:number;y:number}>();
  const [savedShowAll]=useProjectState('scatter.showAll',false,owner);
  const showAll=record.figure.scatterShowAll??savedShowAll;
  const [copyAll,setCopyAll]=useState(false),[message,setMessage]=useState(''),[exporting,setExporting]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const closeSettings=()=>{
    setSelected(undefined);setScalePopup(undefined);
    svg.current?.focus({preventScroll:true});
  };
  function dismissRemovedObject(target:PlotTarget){
    if(selected&&matchesRemovedPlotTarget(selected.target,target))closeSettings();
  }
  const figure=draft??record.figure;
  const presetId=figure.presetId??library.defaultId;
  const baseline=useMemo(()=>{
    const style=fallbackPlotStyle({...library,defaultId:presetId},appearance.stored);
    if(presetId===library.builtins[0]?.id) style.line.point={...style.line.point,size:(pointSize??localSize)*.75};
    return style;
  },[family,presetId,appearance.stored,pointSize,localSize]);
  const style=figure.style??baseline, size=style.line.point.size*4/3, alpha=style.scatterOpacity??opacity??localOpacity;
  const summary=useMemo(()=>{
    try{return {...scatterDataSummary(data),error:''};}
    catch(error){return {count:0,excluded:0,nonfinite:0,viewport:null,error:error instanceof Error?error.message:'散点数据无效。'};}
  },[data]);
  const hitIndex=useMemo(()=>summary.count?scatterXIndex(data):undefined,[data,summary.count]);
  const sourceRange=!showAll&&validPlotViewport(initialViewport)?initialViewport:summary.viewport;
  const axes=figure.coordinates?.main??{};
  const base=sourceRange&&{x:axes.x?.bounds??sourceRange.x,y:axes.y?.bounds??sourceRange.y};
  // The source callback is an observer; it cannot reapply a range that the figure just undid.
  const restored=useRef({owner,key:resetKey,range:viewport});
  if(restored.current.owner!==owner||restored.current.key!==resetKey) restored.current={owner,key:resetKey,range:viewport};
  const view=figureViewport(record,base,restored.current.range,resetKey);
  const range=view.viewport;
  const reported=useRef(restored.current), viewportCallback=useRef(onViewportChange);
  viewportCallback.current=onViewportChange;
  const reportedRange=record.figure.zoom?.scope===resetKey ? record.figure.zoom?.range : restored.current.range;
  useEffect(()=>{
    if(reported.current.owner!==owner||reported.current.key!==resetKey) reported.current=restored.current;
    if(!sameRange(reported.current.range,reportedRange)) {
      reported.current={owner,key:resetKey,range:reportedRange};
      viewportCallback.current?.(reportedRange??null);
    }
  },[owner,resetKey,reportedRange]);
  const titles={title:legacy.title??title,x:legacy.xLabel??xLabel,y:legacy.yLabel??yLabel};
  const palette=useMemo(()=>colorLegend?.colors?.length&&colorLegend.colors.length>=2?[...colorLegend.colors]:colorLegend
    ?Array.from({length:17},(_,i)=>hexColor(colorForX(colorLegend.min+(colorLegend.max-colorLegend.min)*i/16)))
    :['#617482','#253b50'],[colorLegend?.colors,colorLegend?.min,colorLegend?.max,colorForX]);
  const note=figure.text?.['color-legend'];
  const {range:customScaleRange,logarithmic:customLogarithmic,...scaleEdits}=figure.scatterScale??{};
  const scale:ScatterColorScaleValue|undefined=colorLegend&&Number.isFinite(colorLegend.min)&&colorLegend.min<colorLegend.max?{
    range:customScaleRange??[colorLegend.min,colorLegend.max],colors:style.scatterColors??palette,zeroCentered:colorLegend.zeroCentered,
    logarithmic:customLogarithmic??colorLegend.logarithmic,direction:colorLegend.direction??'vertical',
    length:88,thickness:8.5,dx:0,dy:0,font:'Arial',numberPt:8.5,
    ink:'#000000',decimals:family==='fingerprint'?0:decimals,tickMode:family==='fingerprint'?'automatic':'ends',tickCount:4,tickValues:[],
    ...style.scatterScaleStyle,...scaleEdits,title:{content:note?.content??colorLegend.label??xLabel,visible:note?.hidden===false,
      ...note?.font,dx:note?.position?.x,dy:note?.position?.y},
  }:undefined;
  const mainPoint=style.line.point;
  const rulerVisible=figure.showLegend??style.showLegend;
  const showScale=!!scale&&rulerVisible&&!(mainPoint.hollow||mainPoint.marker==='cross'?mainPoint.edgeOverride:mainPoint.fillOverride);
  const plotWidth=style.canvas.width*96/25.4, plotHeight=style.canvas.height*96/25.4;
  const logicalScale=Math.max(1,220/plotWidth,220/plotHeight);
  const layout=plotGeometry({
    width:plotWidth*logicalScale,height:height??plotHeight*logicalScale,title:titles.title,yLabel:titles.y,range:range??emptyRange,
    style,edits:figure,reverseX:false,reverseY:false,editable:true,xStep:axes.x?.step,yStep:axes.y?.step,
    reserveRight:showScale&&scale?.direction==='vertical'?62:0,footer:showScale&&scale?.direction==='horizontal'?74:0,
    wideFrame:scale?.direction!=='horizontal'||!showScale,
    squareFrame:family==='scatter'&&style.canvas.width===style.canvas.height,
    equalAspect:family==='fingerprint',
  });
  const mapColors=Boolean(colorLegend?.zeroCentered||colorLegend?.valueForPoint||scaleEdits.colors||customScaleRange||style.scatterColors);
  const pointColor=useMemo(()=>(index:number,x:number,y:number)=>{
    if(!scale||!mapColors||colorLegend?.mutedForPoint?.(index)||colorForPoint&&!colorLegend?.valueForPoint)
      return colorForPoint?.(index,x,y)??colorForX(x);
    const value=colorLegend?.valueForPoint?.(index)??x;
    return interpolateColor(scatterScaleFraction(value,scale),scale.colors);
  },[colorForX,colorForPoint,mapColors,scale?.range[0],scale?.range[1],scale?.colors,scale?.zeroCentered,scale?.logarithmic,
    colorLegend?.valueForPoint,colorLegend?.mutedForPoint]);
  const pointAppearance=useMemo(()=>(index:number)=>figure.points?.[plotPointKey('scatter',index)]??mainPoint,[figure.points,mainPoint]);
  const raster=summary.count>SCATTER_VECTOR_EXPORT_LIMIT;
  const stageHeight=sizing.height??sizing.width*layout.height/layout.width;
  const displayScale=Math.min(sizing.width/layout.width,stageHeight/layout.height);
  const paintOptions={data,range,layout,size,alpha,colorForX,colorForPoint:pointColor,appearance:pointAppearance};
  const paint=useScatterPointLayer(canvas,host,{...paintOptions,displayScale,active:!!summary.count,epoch:advanced?1:0});
  const sceneIdentity=useMemo(()=>({}),[paint.identity,figure,titles.title,titles.x,titles.y,ariaLabel,metadata,picked,resetKey]);
  const scene=useRef(sceneIdentity);scene.current=sceneIdentity;

  useEffect(()=>{setPicked(null);setHover(undefined);setCopyAll(false);},[data,resetKey]);
  useEffect(()=>{setSelected(undefined);setScalePopup(undefined);},[resetKey]);
  useEffect(()=>{setExporting(false);return()=>controller.current?.abort();},[data,resetKey]);
  useEffect(()=>{
    if(!exportHandle)return;
    const source=svg.current,pixels=canvas.current,win=source?.ownerDocument.defaultView;
    if(!source||!pixels||!range||!win||!summary.count){exportHandle(null);return;}
    const lifetime=new AbortController();
    const assertCurrent=(signal?:AbortSignal)=>{
      assertResultNotAborted(signal);
      if(lifetime.signal.aborted||scene.current!==sceneIdentity||svg.current!==source||canvas.current!==pixels)
        throw new Error('散点图已切换或关闭，请重新导出当前图。');
    };
    exportHandle({ownerDocument:source.ownerDocument,snapshotSvg:async signal=>{
      assertCurrent(signal);
      while(paint.painted.current!==paint.identity){
        assertCurrent(signal);
        if(paint.failure.current?.identity===paint.identity)throw paint.failure.current.error;
        await waitForScatterFrame(win,[signal,lifetime.signal]);
      }
      const result=scatterSvgSnapshot(source,pixels,{...paintOptions,range,raster});
      await Promise.resolve();assertCurrent(signal);return result;
    }});
    return()=>{lifetime.abort();exportHandle(null);};
  },[exportHandle,sceneIdentity]);

  const capturePng=(doc:Document,signal:AbortSignal)=>{
    const source=svg.current,pixels=canvas.current;
    if(!source?.isConnected||!pixels?.isConnected||source.ownerDocument!==doc||pixels.ownerDocument!==doc)
      throw new Error('当前散点图不可用或已切换窗口。');
    if(!range||paint.painted.current!==paint.identity)throw new Error('散点绘制尚未完成。');
    return captureScientificSvgPng(source,doc,signal,pixels);
  };
  async function captureExport(kind:PlotExportFormat,signal:AbortSignal) {
    const source=svg.current,pixels=canvas.current;
    if(!source||!pixels||!range)throw new Error('散点图尚未准备好。');
    let blob:Blob;
    if(kind==='txt'||kind==='raw')blob=new Blob([scatterDataText(data,{x:xLabel,y:yLabel},kind==='raw'?'raw':decimals)],{type:'text/plain;charset=utf-8'});
    else if(kind==='png')blob=await capturePng(source.ownerDocument,signal);
    else {
      if(paint.painted.current!==paint.identity)throw new Error('散点绘制尚未完成。');
      blob=new Blob([scatterSvgSnapshot(source,pixels,{...paintOptions,range,raster})],{type:'image/svg+xml;charset=utf-8'});
    }
    assertResultNotAborted(signal);
    if(kind!=='txt'&&kind!=='raw'&&scene.current!==sceneIdentity)throw new Error('散点图已切换，请重新导出当前图。');
    return {blob,filename:exportFileName+(kind==='raw'?'-raw.txt':'.'+kind)};
  }
  const exportFigure=async(kind:'svg'|'png'|'txt'|'raw')=>{
    const source=svg.current,pixels=canvas.current;
    if(!source||!pixels||!range||exporting)return;
    const job=new AbortController();controller.current=job;setExporting(true);setMessage('');
    try {
      const {blob,filename}=await captureExport(kind,job.signal);
      exportBlob(blob,filename,source.ownerDocument);
      setMessage('已发起 '+(kind==='raw'?'原始数据 TXT':kind.toUpperCase())+' 下载。');
    } catch(error){if(!job.signal.aborted)setMessage(error instanceof Error?error.message:'散点导出失败。');}
    finally{if(controller.current===job)controller.current=null;if(!job.signal.aborted)setExporting(false);}
  };
  function edit(change:Partial<PlotPaneEdits>,group?:string){
    record.replace(previous=>{
      const next={...previous,...change}, proposed=change.coordinates?.main,before=previous.coordinates?.main;
      return view.zoomed && proposed && (proposed.x?.bounds!==before?.x?.bounds||proposed.y?.bounds!==before?.y?.bounds)
        ?{...next,zoom:{scope:resetKey,range:null,back:[]}}:next;
    },group);
  }
  const updateScale:ScatterScaleChange=(delta,group)=>{
    const {title,...patch}=delta;
    record.replace(previous=>{
      const next={...previous,scatterScale:{...previous.scatterScale,...patch}};
      if(title){
        const change:PlotNote={content:title.content,hidden:!title.visible,
          position:{x:title.dx??0,y:title.dy??0},
          font:{...(title.font!==undefined?{font:title.font}:{}),...(title.size!==undefined?{size:title.size}:{}),
            ...(title.bold!==undefined?{bold:title.bold}:{}),...(title.italic!==undefined?{italic:title.italic}:{})}};
        next.text={...previous.text,'color-legend':change};
      }
      return next;
    },group);
  };
  function selectTarget(target:PlotTarget,loc={x:16,y:16},editText=false){
    setScalePopup(undefined);setSelected({part:'main',target,location:loc,editText});
    setPanel(target.kind==='axis'?'axes':target.kind==='text'?'text':target.kind==='guide'?'guides':'series');
  }
  const context=plotEditorPane({pane:figure,style,range:range??emptyRange,axisKey:'main',mapping:plotMapping(),titles,series,
    edit,endEdit:record.endGroup,onTarget:t=>selectTarget(t,undefined,true),onDismiss:dismissRemovedObject,canAnnotate:false});
  context.scatterOpacity=alpha;
  context.textDefaults={...context.textDefaults,'color-legend':{content:colorLegend?.label??xLabel,role:'legend',label:'色尺标题'}};
  // Text popup starts from the effective ruler font; preserving the base point style prevents a view-only edit.
  if(scale&&selected?.target.kind==='text'&&selected.target.id==='color-legend') context.style={...context.style,
    fonts:{...context.style.fonts,legend:{font:scale.font,size:scale.numberPt,bold:false,italic:false}}};
  const canInspect = !!selected && hasPlotSettingsTarget(selected.target, context);
  useEffect(()=>{if(selected&&!canInspect)setSelected(undefined);},[selected,canInspect]);
  const nearest=(at:{x:number;y:number})=>range&&insidePlot(at,layout)?nearestScatterPoint(data,at,range,layout,7,hitIndex):null;
  function location(point:{clientX:number;clientY:number}){
    const rect=stage.current?.getBoundingClientRect();
    return {x:point.clientX-(rect?.left??0),y:point.clientY-(rect?.top??0)};
  }
  function scaleAt(point:{x:number;y:number}){
    const matrix=svg.current?.getScreenCTM(), at=svg.current?.createSVGPoint();
    if(!matrix||!at)return point;
    at.x=point.x;at.y=point.y;
    const pixel=at.matrixTransform(matrix);
    return location({clientX:pixel.x,clientY:pixel.y});
  }
  function hasPlotPointAt(clientX:number,clientY:number){
    const at = svg.current && plotClientPoint(svg.current,clientX,clientY);
    return !!at && !!nearest(at);
  }
  const gesture=usePlotGestures({figure:record.figure,stage,main:{context,geometry:layout,axisKey:'main',offset:{x:0,y:0},nearest},
    makeInset:false,location,preview,commit:next=>record.replace(next),zoom:next=>view.zoom(next),
    hover(hit,at,local){
      const point=hit.kind==='paper'&&local?nearest(local):null;
      setHover(previous=>point?(previous?.point.index===point.index?previous:{point,...at}):undefined);
    },
    select(hit,local){
      if(hit.kind!=='paper')return;
      const point=nearest(local);
      if(point || picked){setPicked(point);onPointSelect?.(point);}
    },
    inspect(hit,at,local){
      const target=targetFromPlotHit(hit);
      if(target){selectTarget(target,at);return;}
      const point=hit.kind==='paper'&&nearest(local);
      if(point)selectTarget({kind:'point',id:'scatter',index:point.index},at);
    },
  });
  function removeTarget(){
    if(selected?.target.kind==='text')context.removeText(selected.target.id);
    if(selected?.target.kind==='guide')context.removeGuide(selected.target.id);
  }
  function keyboard(event:KeyboardEvent){
    if(plotTextInput(event.target))return;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(mod&&key==='a'&&!editableCopyTarget(event.target)){event.preventDefault();event.stopPropagation();setCopyAll(true);}
    else if(mod&&(key==='y'||key==='z')){
      event.preventDefault();event.stopPropagation();if(key==='y'||event.shiftKey)record.redo();else record.undo();
    }else if(key==='escape'&&(copyAll||gesture.resizePart)){
      event.preventDefault();event.stopPropagation();setCopyAll(false);gesture.hideResizeHandles();
    }
  }
  function resetLayout(){
    record.replace(previous=>({...previous,frame:undefined,position:undefined,
      text:Object.fromEntries(Object.entries(previous.text??{}).map(([k,v])=>[k,{...v,position:undefined}])),
      ...(previous.scatterScale?{scatterScale:{...previous.scatterScale,dx:0,dy:0}}:{})}));
  }
  const snapshotStyle=plotPresetSnapshot({...style,...(scale?{scatterColors:scale.colors,
    scatterScaleStyle:{direction:scale.direction,length:scale.length,thickness:scale.thickness,font:scale.font,
      numberPt:scale.numberPt,ink:scale.ink,decimals:scale.decimals,numberFormat:scale.numberFormat,tickCount:scale.tickCount,
      tickMode:scale.tickMode==='custom'?'ends':scale.tickMode}}:{}),scatterOpacity:alpha},figure);
  function choose(id:string,custom?:typeof style){
    if(custom){edit({presetId:id});return;}
    const next=library.style(id);
    const ruler=figure.scatterScale;
    edit({...applyPlotPreset(figure,id,next),
      ...(ruler?{scatterScale:{range:ruler.range,dx:ruler.dx,dy:ruler.dy,logarithmic:ruler.logarithmic,
        tickValues:ruler.tickValues,...(ruler.tickMode==='custom'?{tickMode:ruler.tickMode}:{})}}:{})});
  }
  const assertFigureIdle=()=>{if(draft||gesture.inProgress())throw new Error('图形手势正在进行。');};
  const scaleConfiguration=scale&&colorLegend?{
    schema:objectSchema({
      range:{anyOf:[settingArray(settingNumber,2,2),{type:'null'}]},colors:settingArray(settingColor,2),
      ...(colorLegend.logarithmic!==undefined&&{logarithmic:settingBool}),direction:settingEnum(['horizontal','vertical']),
      length:{type:'number',minimum:12,maximum:100},thickness:{type:'number',minimum:ANALYSIS_COLORBAR_LIMITS.thickness.min,maximum:ANALYSIS_COLORBAR_LIMITS.thickness.max},
      dx:settingNumber,dy:settingNumber,font:settingEnum(plotFonts),numberPt:{type:'number',minimum:5,maximum:24},ink:settingColor,
      decimals:{type:'integer',minimum:0,maximum:8},numberFormat:settingNumberFormat,
      tickMode:settingEnum(['ends','automatic','custom']),tickCount:{type:'integer',minimum:2,maximum:10},tickValues:settingArray(settingNumber),
      title:objectSchema({content:settingText,visible:settingBool,font:settingEnum(plotFonts),size:{type:'number',minimum:5,maximum:72},
        bold:settingBool,italic:settingBool,dx:settingNumber,dy:settingNumber}),
    }),
    read:()=>({...scale,manualRange:customScaleRange!==undefined,visible:showScale}),
    apply(values:Record<string,unknown>){
      assertFigureIdle();
      const {title,range:requested,...patch}=values as Omit<Partial<ScatterColorScaleValue>,'title'|'range'> &
        {title?:Partial<ScatterColorScaleValue['title']>;range?:ScatterColorScaleValue['range']|null};
      const limits=requested===null?[colorLegend.min,colorLegend.max] as const:requested??scale.range;
      if(!(limits[0]<limits[1])||((patch.logarithmic??scale.logarithmic)&&limits[0]<1))throw new Error('色尺范围必须递增，对数计数下限至少为 1。');
      const ticks=patch.tickValues;
      if(ticks)patch.tickValues=[...new Set(ticks)].sort((a,b)=>a-b);
      else if(patch.tickMode==='custom'&&!scale.tickValues.length)patch.tickValues=scatterScaleTicks({...scale,...patch,range:limits});
      updateScale({...patch,...(requested!==undefined&&{range:requested??undefined}),...(title&&{title:{...scale.title,...title}})});
    },
  }:undefined;
  const mcpPort=range&&!summary.error&&summary.count?<ResultsMcpPlotRegistration chartId={id} figureIdentity={`${owner}:${String(resetKey)}`} port={{
    read:()=>{
      const main=plotPartCapabilities(context,data.x.length);
      return {title:figure.text?.title?.content??titles.title,xLabel:figure.text?.x?.content??titles.x,yLabel:figure.text?.y?.content??titles.y,
        family,figure,range,metadata,formats:['svg','png','txt','raw'],
        series:main.series,textIds:main.textIds,edits:main.editOperations,partCapabilities:{main},
        presets:[...library.builtins,...library.personal].map(({id,label})=>({id,label})),defaultPresetId:library.defaultId,canUndo:record.canUndo,canRedo:record.canRedo};
    },
    edit:(change,part='main')=>{assertFigureIdle();if(part==='inset')throw new Error('当前散点图没有副图。');editCurrentPlot(change,context,record,data.x.length);},
    configuration:{canvas:plotCanvasConfiguration(context,assertFigureIdle),...(scaleConfiguration&&{'color-scale':scaleConfiguration})},
    preset:presetId=>{assertFigureIdle();choose(presetId);},
    savePreset:label=>{
      assertFigureIdle();
      const snapshot=plotPresetSnapshot(style,figure),id=library.save(label,snapshot);choose(id,snapshot);return id;
    },
    defaultPreset:library.makeDefault,
    export:captureExport,
    isVisible:()=>!!svg.current?.getClientRects().length,
  }}/>:null;
  function assignStage(node:HTMLDivElement|null){stage.current=node;sizing.stageRef(node);}
  // Ref identity must survive point hovers and edits.
  const setStage=useRef(assignStage);setStage.current=assignStage;
  const connectStage=useMemo(()=>(node:HTMLDivElement|null)=>setStage.current(node),[]);
  if(!range||summary.error||!summary.count)return <div ref={host} className="scientific-plot scientific-scatter-plot"
    data-testid={testId} data-point-count="0" data-sampled="false" data-paint-state={summary.error?'error':'empty'}>
    <p className="optimization-plot-empty" role="status">{summary.error||'没有可绘制的有效散点。'}</p></div>;

  const renderedHeight=stage.current?.clientHeight??stageHeight, width=stage.current?.clientWidth??sizing.width;
  const box=gesture.box;
  const actions=<div className="optimization-plot-options scientific-plot-tools scientific-plot-actions" aria-label="图像操作">
    <button type="button" disabled={!view.canGoBack} onClick={view.back}>返回上一级</button>
    <button type="button" onClick={()=>view.reset(showAll?{scatterShowAll:false}:undefined)}>恢复视图</button>
    <button type="button" onClick={resetLayout}>恢复布局</button>
    <button type="button" onClick={context.insertText}>插入文字</button>
    {scale&&<label className="plot-edit-check"><input type="checkbox" checked={rulerVisible} onChange={e=>edit({showLegend:e.target.checked})}/>显示色尺</label>}
    {validPlotViewport(initialViewport)&&!sameRange(initialViewport,summary.viewport)&&
      <button type="button" disabled={showAll&&!view.zoomed} onClick={()=>view.reset(!showAll?{scatterShowAll:true}:undefined)}>全图</button>}
    <button type="button" disabled={!record.canUndo} onClick={record.undo}>撤销</button>
    <button type="button" disabled={!record.canRedo} onClick={record.redo}>重做</button>
    <ScientificImageCopyButton resetKey={data} disabled={paint.status!=='ready'||paint.painted.current!==paint.identity} capture={capturePng}/>
    <ScientificPlotExportMenu disabled={exporting} options={[
      {key:'svg',label:raster?'SVG（嵌入点图）':'SVG',disabled:paint.status!=='ready',run:()=>void exportFigure('svg')},
      {key:'png',label:'PNG',disabled:paint.status!=='ready',run:()=>void exportFigure('png')},
      {key:'txt',label:'所见格式 TXT',run:()=>void exportFigure('txt')},{key:'raw',label:'原始数据 TXT',run:()=>void exportFigure('raw')},
    ]}/>
    <button type="button" aria-pressed={copyAll} onClick={()=>{setCopyAll(true);host.current?.focus({preventScroll:true});}}>选择全部数据</button>
  </div>;
  const graphics=<div className="scientific-plot-viewport"><div ref={connectStage}
    className="scientific-scatter-stage scientific-plot-stage" style={sizing.style(stageHeight)}>
    <canvas ref={canvas} aria-hidden="true"/>
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" width={layout.width} height={layout.height}
      viewBox={'0 0 '+layout.width+' '+layout.height} role="group" tabIndex={0} aria-label={ariaLabel}
      className="scientific-plot-svg is-editable" fontFamily={plotFontFamily(style.fonts.ticks.font)}
      data-x-min={range.x[0]} data-x-max={range.x[1]} data-y-min={range.y[0]} data-y-max={range.y[1]}
      data-plot-left={layout.left} data-plot-right={layout.right} data-plot-top={layout.top} data-plot-bottom={layout.bottom}
      onPointerDown={gesture.start} onPointerMove={gesture.move} onPointerUp={event=>gesture.finish(event)}
      onPointerCancel={event=>gesture.finish(event,true)} onLostPointerCapture={event=>gesture.finish(event,true)}
      onPointerLeave={()=>setHover(undefined)} onAuxClick={e=>{if(e.button===1)e.preventDefault();}}
      onContextMenu={gesture.contextMenu}>
      <title>{figure.text?.title?.content??titles.title}</title>
      <desc>{titles.x+'；'+titles.y+'；全量有效点。'}</desc>
      <metadata>{JSON.stringify({metadata,appearance:style,viewport:range,pointSize:size,opacity:alpha,colorLegend:scale,
        pointCount:summary.count,sampled:false,svgPointLayer:raster?'raster':'vector'})}</metadata>
      <ScientificPlotDrawing id={'scatter-'+id} part="main" geometry={layout} range={range} edits={figure} style={style}
        title={titles.title} xLabel={titles.x} yLabel={titles.y} series={series} showLegend={false}
        editable showResizeHandles={gesture.resizePart === 'main'} gripScale={displayScale} transparentPaper selectionMode="x" spectrum={false} decimals={decimals}
        guides={context.guides.map(guide=>({...guide,displayValue:guide.value}))}
        activeText={selected?.target.kind==='text'?selected.target.id:undefined}/>
      {picked&&insidePlot({x:layout.x(picked.x),y:layout.y(picked.y)},layout)&&
        <circle cx={layout.x(picked.x)} cy={layout.y(picked.y)} r={Math.max(4,size)} fill="none" stroke="#1e293b" pointerEvents="none" data-export-exclude="true"/>}
      {showScale&&scale&&<ScientificScatterColorScale value={scale} frame={layout} onChange={updateScale}
        titleSelected={selected?.target.kind==='text'&&selected.target.id==='color-legend'}
        onOpenSettings={pos=>{setSelected(undefined);setPanel('series');setScalePopup(scaleAt(pos));}}
        onOpenTitle={(pos,editText)=>selectTarget({kind:'text',id:'color-legend'},scaleAt(pos),editText)}
        onDeleteTitle={()=>context.removeText('color-legend')}/>}
      {box&&<rect data-plot-interaction="zoom" x={Math.min(box.start.x,box.end.x)} y={Math.min(box.start.y,box.end.y)}
        width={Math.abs(box.start.x-box.end.x)} height={Math.abs(box.start.y-box.end.y)} fill="#227e681c" stroke="#227e68" pointerEvents="none"/>}
    </svg>
    {hover&&<div className="plot-point-readout" style={{left:clampPlot(hover.x+8,4,width-148),top:clampPlot(hover.y-27,4,renderedHeight-52)}}>
      <span>Point {hover.point.index+1}</span><span>X {formatResultValue(hover.point.x,decimals)}</span><span>Y {formatResultValue(hover.point.y,decimals)}</span>
    </div>}
    {scalePopup&&scale?<PlotQuickPopover title="色尺" anchor={scalePopup} onClose={closeSettings} hasPlotPointAt={hasPlotPointAt}
      remove={()=>{edit({showLegend:false});closeSettings();}}>
      <ScatterColorScaleFields value={scale} onChange={updateScale} endEdit={record.endGroup}/>
    </PlotQuickPopover>
      :canInspect&&selected&&<PlotQuickControls key={JSON.stringify([selected.target,selected.editText])} target={selected.target}
        context={context} anchor={selected.location} onClose={closeSettings} editText={selected.editText} hasPlotPointAt={hasPlotPointAt}
        remove={canRemovePlotTarget(selected.target)?removeTarget:undefined}/>}
  </div></div>;
  const content=<>{graphics}{actions}<p className="optimization-plot-note" role="status">{summary.count} 点 · 全量
    {!!summary.excluded&&' · 有效域外 '+summary.excluded+' 点'}{paint.status==='drawing'?' · 绘制中':''}</p>
    {(message||paint.message)&&<p className="optimization-plot-note" role="status">{message||paint.message}</p>}</>;
  const label=figure.presetId??library.defaultId??library.builtins[0]?.id;
  const sidebar=<>
    <PlotPresetControls library={library} active={label} style={snapshotStyle} onChoose={choose}/>
    <nav className="plot-edit-tabs" aria-label="绘图参数">{plotPanels.map(([key,text])=>
      <button type="button" key={key} aria-selected={panel===key} onClick={()=>setPanel(key)}>{key==='series'?'点与色尺':text}</button>)}</nav>
    <PlotInspector context={context} panel={panel} target={canInspect?selected?.target:undefined}/>
    {panel==='series'&&scale&&<div className="plot-edit-section"><strong>色尺</strong>
      <ScatterColorScaleFields value={scale} onChange={updateScale} endEdit={record.endGroup}/></div>}
  </>;
  return <div ref={host} className="scientific-plot scientific-scatter-plot interactive-scientific-plot postprocess-plot" tabIndex={0}
    aria-label="可复制散点数据" data-testid={testId} data-copy-all={copyAll||undefined}
    data-point-count={summary.count} data-source-point-count={data.x.length} data-sampled="false" data-paint-state={paint.status}
    onKeyDown={keyboard} onCopy={e=>{
      if(!copyAll||editableCopyTarget(e.target))return;
      e.clipboardData.setData('text/plain',scatterDataText(data,{x:xLabel,y:yLabel},decimals));e.preventDefault();e.stopPropagation();
    }} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setCopyAll(false);}}>
    {mcpPort}{scale&&colorScaleControls?.(scale,updateScale,!!customScaleRange)}
    {embeddedPresetEditor?<div className="plot-preset-dialog-body">
      <div className="plot-preset-art">{content}</div><aside className="plot-preset-fields">{sidebar}</aside>
    </div>:<>
      <PlotEditorToolbar data={children} library={library} active={label} style={snapshotStyle} onChoose={choose}
        onAdvanced={()=>{gesture.hideResizeHandles();setAdvanced(true);}}/>
      {advanced?<PlotSettingsWindow category={family==='fingerprint'?'fingerprint':'iri'} ownerDocument={host.current?.ownerDocument}
        onKeyDown={keyboard} onClose={()=>{gesture.hideResizeHandles();setAdvanced(false);}} figure={content} sidebar={sidebar}/>:content}
    </>}
  </div>;
}
export default ScientificScatterPlot;
