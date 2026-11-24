import {createContext,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import type {PlotFigureEdits,PlotFontStyle,PlotPointStyle,PlotSeriesStyle,PlotStyle} from '../../results/scientific-plot-editing';
import type {ScientificPlotViewport} from '../../results/scientific-plot';
import type {AnalysisPage} from './PostprocessDisplayPanel';
import type {AnalysisWorkspaceState} from './analysis-workspace';
import type {ViewportImageExportOptions} from './export-image';
import type {AnalysisAsset} from './analysis-mcp-assets';
import type {ViewportRenderIdentity} from '../modeling/render/render-completion';

export interface ResultStageIdentity {sourceId:string;jobIndex:number;stageId:string;sourceResultId:string}

export interface ResultViewPort {
  ownerId:string;
  result:TrajectoryResult;
  sourceResultId:string;
  rootResultId?:string;
  active:boolean;
  available:boolean;
  frameIndex:number;
  frameReady:boolean;
  analysisKey:string;
  stage?:ResultStageIdentity;
  revealPlotStage?(plot:{resultId:string;source?:TrajectoryResult['source'];jobIndex?:number|null}):boolean;
  scene?():ViewportRenderIdentity|undefined;
  workspaceCapture?:boolean;
  capture?(options:ViewportImageExportOptions,signal:AbortSignal):Promise<Blob>;
}

export interface AnalysisViewPort {
  read():{state:AnalysisWorkspaceState;active:boolean;availablePages:AnalysisPage[];runId?:string};
  open(page:AnalysisPage):string;
  stageFor?(page:AnalysisPage):ResultStageIdentity|undefined;
  unavailableReason?(page:AnalysisPage):string|undefined;
  control?(action:AnalysisPanelAction):void|Promise<void>;
}

export type AnalysisPanelAction = {action:'close'|'detach'|'dock'|'activate';panelId:string} | {action:'layout';mode:AnalysisWorkspaceState['mode']};

export interface NativeMcpSettings {
  schema:Record<string,unknown>;
  read():unknown;
  apply(patch:Record<string,unknown>):void;
}

export interface AnalysisRunPort {
  sourceRevision:string;
  methods:string[];
  methodStatus?:'preparing';
  recoverMethod?(method:string):string|undefined;
  read():unknown;
  run(method:string,retry:boolean,parameters:Record<string,unknown>):unknown;
  configuration?:NativeMcpSettings;
  presentation?:NativeMcpSettings;
  plots?():Record<string,{sourceKey:string;open():string|void}>;
  assets?():AnalysisAsset[];
  execution?():{status:string;requestId?:string;stoppable:boolean;progress?:unknown};
  stop?():void|Promise<unknown>;
}

export type PlotExportFormat='svg'|'png'|'txt'|'raw';
export type PlotEdit = {operation:'undo'|'redo'} | {operation:'text';role:'title'|'x'|'y';text:string}
  | {operation:'axis-range';axis:'x'|'y';bounds:[number,number]|null}
  | {operation:'axis-step';axis:'x'|'y';step:number|null}
  | {operation:'axes-style';patch:Partial<PlotStyle['axis']>}
  | {operation:'series-style';seriesId:string;patch:Partial<Omit<PlotSeriesStyle,'point'>>}
  | {operation:'point-style';seriesId:string;pointIndex?:number;patch:Partial<PlotPointStyle>}
  | {operation:'font';textId:string;patch:Partial<PlotFontStyle>}
  | {operation:'legend';visible:boolean}
  | {operation:'add-guide';axis:'x'|'y';value:number;label?:string}
  | {operation:'remove-guide';guideId:string};
export interface PlotPartCapabilities {
  editOperations:PlotEdit['operation'][];
  textIds:string[];
  series:{id:string;label?:string;pointCount:number;lineStyle:boolean;pointStyle:boolean}[];
  guideIds?:string[];
}
export interface PlotPort {
  read():{
    title:string; xLabel:string; yLabel:string; family:string; figure:PlotFigureEdits;
    range:ScientificPlotViewport|null; formats:PlotExportFormat[]; presets:{id:string;label:string}[];
    series?:{id:string;label?:string;pointCount:number}[];
    textIds?:string[];
    edits?:PlotEdit['operation'][];
    parts?:('main'|'inset')[];
    partCapabilities?:Partial<Record<'main'|'inset',PlotPartCapabilities>>;
    defaultPresetId?:string;
    metadata?:unknown; canUndo:boolean; canRedo:boolean;
  };
  edit(change:PlotEdit,part?:'main'|'inset'):void;
  preset(id:string):void;
  savePreset?(label:string):string;
  defaultPreset?(id:string):void;
  configuration?:Record<string,NativeMcpSettings>;
  export(format:PlotExportFormat,signal:AbortSignal):Promise<{blob:Blob;filename:string}>;
  isVisible?():boolean;
}

interface PlotScope {
  id:string;source?:TrajectoryResult['source'];ownerId?:string;resultId?:string;rootResultId?:string;jobId?:string;jobIndex?:number|null;frameIndex?:number;inline?:boolean;
  kind?:string; reference?:string; analysisSourceKey?:string; analysisId?:string;
  collectionId?:string;runId?:string;stageId?:string;
  display?:{eligible:boolean;visible:boolean;active:boolean;activate():void;minimize?():void;close?():void;
    layout?:'free'|'tiled';setLayout?(mode:'free'|'tiled',arrange:boolean):void};
}
const PlotScopeContext=createContext<PlotScope|null>(null);
interface AnalysisFamily {current:string;available:string[];choose(value:string):void}
const AnalysisFamilyContext=createContext<AnalysisFamily|null>(null);

export function ResultsMcpAnalysisFamily({family,children}:{family:AnalysisFamily;children:ReactNode}) {
  return <AnalysisFamilyContext.Provider value={family}>{children}</AnalysisFamilyContext.Provider>;
}

function withAnalysisFamily(port:AnalysisRunPort,family:AnalysisFamily):AnalysisRunPort {
  const previous=port.configuration;
  return {...port,sourceRevision:JSON.stringify([family.current,port.sourceRevision]),configuration:{
    schema:{type:'object',additionalProperties:false,properties:{...previous?.schema.properties as Record<string,unknown>,family:{type:'string',enum:family.available}}},
    read:()=>({...previous?.read() as Record<string,unknown>,family:family.current}),
    apply(values){
      const {family:selected,...patch}=values;
      if(typeof selected==='string'&&selected!==family.current){
        if(Object.keys(patch).length)throw new Error('切换分析类型后请读取新类型的参数，再修改该类型的设置。');
        family.choose(selected);
      }else if(Object.keys(patch).length)previous?.apply(patch);
    },
  }};
}

export function ResultsMcpPlotScope({scope,children}:{scope:PlotScope;children:ReactNode}) {
  return <PlotScopeContext.Provider value={scope}>{children}</PlotScopeContext.Provider>;
}

export function ResultsMcpInlinePlotDisplay({display,children}:{display:NonNullable<PlotScope['display']>;children:ReactNode}) {
  const scope=useContext(PlotScopeContext);
  return scope?.inline?<PlotScopeContext.Provider value={{...scope,display}}>{children}</PlotScopeContext.Provider>:children;
}

export function ResultsMcpInlinePlotSource({kind,analysisId,children}:{kind:string;analysisId?:string;children:ReactNode}) {
  const scope=useContext(PlotScopeContext);
  return scope?.inline?<PlotScopeContext.Provider value={{...scope,kind,analysisId}}>{children}</PlotScopeContext.Provider>:children;
}

export interface NativePlotSource {
  kind:string;targetRef:string;plotId:string;collectionId?:string;runId?:string;stageId?:string;label:string;
  active?:boolean;
  unavailableReason?:string;
  open?():void;
}
interface PlotEntry extends PlotScope {port:PlotPort;revision:number;figureIdentity?:string|number;configurationIdentity?:string}
export function createResultsMcpRegistry() {
  const resultViews=new Map<string,ResultViewPort>();
  const analysisViews=new Map<string,AnalysisViewPort>();
  const runs=new Map<string,AnalysisRunPort>();
  const plots=new Map<string,PlotEntry>();
  const plotSources=new Map<string,NativePlotSource>();
  const listeners=new Set<(id:string,revision?:number)=>void>();
  const viewListeners=new Set<()=>void>();
  let revision=0;
  return {
    resultViews,analysisViews,runs,plots,plotSources,
    watchViews(listener:()=>void){viewListeners.add(listener);return ()=>{viewListeners.delete(listener);};},
    updateViews(){for(const listener of viewListeners)listener();},
    watchPlots(listener:(id:string,revision?:number)=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    publishPlot(scope:PlotScope,port:PlotPort,figureIdentity?:string|number) {
      const existing=plots.get(scope.id),previous=existing?.port.read(),next=port.read();
      const configurationIdentity=JSON.stringify(Object.entries(port.configuration??{}).map(([name,settings])=>[name,settings.read()]));
      const changed=!previous||existing?.figureIdentity!==figureIdentity||previous.figure!==next.figure||previous.title!==next.title||previous.xLabel!==next.xLabel||previous.yLabel!==next.yLabel
        ||existing?.source?.id!==scope.source?.id||existing?.source?.sha256!==scope.source?.sha256||existing?.resultId!==scope.resultId||existing?.jobIndex!==scope.jobIndex||existing?.frameIndex!==scope.frameIndex
        ||existing?.kind!==scope.kind||existing?.reference!==scope.reference||existing?.analysisSourceKey!==scope.analysisSourceKey
        ||existing?.configurationIdentity!==configurationIdentity
        ||previous.range?.x[0]!==next.range?.x[0]||previous.range?.x[1]!==next.range?.x[1]||previous.range?.y[0]!==next.range?.y[0]||previous.range?.y[1]!==next.range?.y[1];
      const entry={...scope,port,figureIdentity,configurationIdentity,revision:changed?++revision:existing!.revision};
      plots.set(scope.id,entry);
      if(changed)for(const listener of listeners)listener(scope.id,entry.revision);
      if(changed||existing?.display?.eligible!==scope.display?.eligible||existing?.display?.visible!==scope.display?.visible||existing?.display?.active!==scope.display?.active)for(const listener of viewListeners)listener();
      return entry;
    },
    removePlot(id:string,port:PlotPort){
      if(plots.get(id)?.port!==port)return;
      plots.delete(id);
      for(const listener of listeners)listener(id);
      for(const listener of viewListeners)listener();
    },
  };
}

const ResultsMcpContext=createContext<ReturnType<typeof createResultsMcpRegistry>|null>(null);

export function ResultsMcpProvider({children}:{children:ReactNode}) {
  const [registry]=useState(createResultsMcpRegistry);
  return <ResultsMcpContext.Provider value={registry}>{children}</ResultsMcpContext.Provider>;
}

export const useResultsMcp=()=>useContext(ResultsMcpContext);

export function ResultsMcpPlotSourceRegistration({source}:{source:NativePlotSource}) {
  const registry=useResultsMcp(),published=useRef(source);
  useLayoutEffect(()=>{
    const previous=published.current;
    published.current=source;
    const current=registry?.plotSources.get(source.targetRef);
    if(current===previous||!current?.active||source.active)registry?.plotSources.set(source.targetRef,source);
  });
  useLayoutEffect(()=>()=>{if(registry?.plotSources.get(source.targetRef)===published.current)registry.plotSources.delete(source.targetRef);},[registry,source.targetRef]);
  return null;
}

export function ResultsMcpPortRegistration<K extends 'resultViews'|'analysisViews'|'runs'>({kind,id,port}:{
  kind:K;id:string|null;port:ReturnType<typeof createResultsMcpRegistry>[K] extends Map<string,infer P>?P:never;
}) {
  const registry=useResultsMcp(), map=registry?.[kind] as Map<string,typeof port>|undefined;
  const family=useContext(AnalysisFamilyContext);
  const published=useRef(port);
  useLayoutEffect(()=>{published.current=kind==='runs'&&family?withAnalysisFamily(port as AnalysisRunPort,family) as typeof port:port;
    if(id&&map){map.set(id,published.current);registry?.updateViews();}});
  useLayoutEffect(()=>()=>{if(id&&map?.get(id)===published.current){map.delete(id);registry?.updateViews();}},[map,id,registry]);
  return null;
}

export function ResultsMcpPlotRegistration({port,chartId,figureIdentity}:{port:PlotPort;chartId:string;figureIdentity?:string|number}) {
  const registry=useResultsMcp(),scope=useContext(PlotScopeContext),id=scope?.inline?`${scope.id}:${chartId}`:scope?.id;
  const published=useRef(port);
  useLayoutEffect(()=>{published.current=port;if(id&&scope)registry?.publishPlot({...scope,id},port,figureIdentity);});
  useLayoutEffect(()=>()=>{if(id)registry?.removePlot(id,published.current);},[registry,id]);
  return null;
}
