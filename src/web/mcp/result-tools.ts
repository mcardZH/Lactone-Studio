import {flushSync} from 'react-dom';
import type {Structure} from '../../core/types';
import type {ResultDiagnostic,TrajectoryResult} from '../../results/contracts';
import type {PostprocessDocument,PostprocessScientificFileDocument} from '../../results/postprocess-document';
import {projectPostprocessFrame} from '../../results/postprocess-document';
import {postprocessFileJob} from '../../results/postprocess-sources';
import {plotFonts,type PlotFontStyle,type PlotPointStyle,type PlotSeriesStyle,type PlotStyle} from '../../results/scientific-plot-editing';
import {ANALYSIS_TITLES} from '../results/analysis-workspace';
import type {AnalysisPage} from '../results/PostprocessDisplayPanel';
import {createPostprocessPlotSnapshot,postprocessScfState,type PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import type {createResultsMcpRegistry,PlotEdit,PlotExportFormat,ResultStageIdentity,ResultViewPort} from '../results/results-mcp-context';
import type {ViewportImageExportOptions} from '../results/export-image';
import {createFilePathPlotSnapshot,type FilePathPlotSnapshot} from '../results/file-path-plot';
import {objectSchema,toolError,type McCall,type McTool} from './types';
import {mcpBridge} from './bridge';
import {stageSavedCube,stageScientificText} from '../results/export-saved-cube';
import {isMultiwfnBackendFailure} from '../results/multiwfn-errors';

export interface McpResultTarget {
  ownerId:string;
  navigationRef?:string;
  hessianRunId?:string;
  result?:TrajectoryResult|ResultDiagnostic;
  postprocess?:PostprocessDocument;
  file?:PostprocessScientificFileDocument;
}

export interface ResultToolsContext {
  resultRegistry:ReturnType<typeof createResultsMcpRegistry>|null;
  getResult(targetRef?:string):McpResultTarget;
  openAnalysis(ownerId:string):void|Promise<void>;
  openPlot(snapshot:PostprocessPlotSnapshot|FilePathPlotSnapshot):string;
  readFrame?(ref:string,signal?:AbortSignal):Promise<{frame:unknown;structure:Structure}>;
  captureViewport?(targetRef:string|undefined,options:ViewportImageExportOptions,signal:AbortSignal):Promise<{blob:Blob;provenance:Record<string,unknown>}>;
}

function observesResult(view:{result:TrajectoryResult;sourceResultId:string;rootResultId?:string},result?:TrajectoryResult|ResultDiagnostic) {
  return !result||view.result.id===result.id||view.sourceResultId===result.id||view.rootResultId===result.id;
}

function isStage(view:ResultViewPort|undefined,expected:ResultStageIdentity|undefined) {
  if(!expected)return true;
  const observed=view?.stage;
  return observed?.sourceId===expected.sourceId&&observed.jobIndex===expected.jobIndex&&observed.sourceResultId===expected.sourceResultId&&observed.stageId===expected.stageId;
}

function viewReceipt(view:ResultViewPort|undefined) {
  const scene=view?.scene?.();
  return {resultId:view?.result.id,stage:view?.stage,frameIndex:view?.frameIndex,frameReady:view?.frameReady??false,
    scene:scene?{status:'submitted',identity:scene}:{status:view?.scene?'preparing':'unavailable'}};
}

async function waitForView<T>(registry:ResultToolsContext['resultRegistry'],read:()=>T|undefined,waitMs:number,signal?:AbortSignal):Promise<T|undefined> {
  signal?.throwIfAborted();
  const current=read();
  if(current||!registry||!waitMs)return current;
  return new Promise((resolve,reject)=>{
    const expire=setTimeout(()=>cleanup(),waitMs);
    let checking=false;
    const off=registry.watchViews(()=>{
      if(checking)return;
      checking=true;queueMicrotask(()=>{checking=false;const value=read();if(value)cleanup(value);});
    });
    const abort=()=>{clearTimeout(expire);off();reject(signal?.reason);};
    const cleanup=(value?:T)=>{clearTimeout(expire);off();signal?.removeEventListener('abort',abort);resolve(value);};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
  });
}

export function showResultPlot(registry:ResultToolsContext['resultRegistry'],plotId:string,
  navigate?:(owner:{ownerId?:string;resultId?:string;sourceId?:string;jobId?:string;jobIndex?:number|null})=>void) {
  const stored=registry?.plots.get(plotId);
  if(!stored)throw toolError('plot_unavailable','No such figure in this project window.',{plotId});
  if(!stored.display)throw toolError('plot_open_unavailable','This figure is part of a native analysis panel. Select that panel to show the chart.',{plotId,resultId:stored.resultId});
  if(!stored.display.eligible&&navigate)flushSync(()=>navigate({ownerId:stored.ownerId,resultId:stored.resultId,sourceId:stored.source?.id,jobId:stored.jobId,jobIndex:stored.jobIndex}));
  const display=registry?.plots.get(plotId)?.display;
  if(!display?.eligible)return {plotId,status:'owner_not_visible',active:false,visible:false,source:stored.source,resultId:stored.resultId};
  flushSync(display.activate);
  const current=registry?.plots.get(plotId),active=current?.display?.active??false;
  const visible=Boolean(current?.display?.visible&&(current.port.isVisible?.()??true));
  return {plotId,status:active?(visible?'shown':'selected'):'superseded',active,visible,source:stored.source,resultId:stored.resultId};
}

export async function showNativeResultPlot(ctx:Pick<ResultToolsContext,'resultRegistry'|'getResult'|'openAnalysis'>,plotId:string,signal?:AbortSignal) {
  const registry=ctx.resultRegistry,plot=registry?.plots.get(plotId);
  if(!plot?.display||plot.display.eligible)return showResultPlot(registry,plotId);
  const views=()=>[...registry?.resultViews.values()??[]];
  const exact=views().filter(item=>item.result.id===plot.resultId&&(!plot.source||plot.source.id===item.result.source.id&&plot.source.sha256===item.result.source.sha256));
  const ownerId=plot.ownerId??(exact.length===1?exact[0].ownerId:undefined);
  if(!ownerId)return showResultPlot(registry,plotId);
  const ownerTarget=ctx.getResult(ownerId);
  const jobId=plot.jobId??(ownerTarget.file?.output.source.jobs.find(job=>job.id===plot.rootResultId)?.id);
  const target=jobId?ctx.getResult(JSON.stringify(['es-file-job',ownerId,jobId])):ownerTarget;
  await flushSync(()=>ctx.openAnalysis(target.navigationRef??target.ownerId));
  signal?.throwIfAborted();
  if(!registry?.plots.get(plotId)?.display?.eligible&&plot.resultId){
    const owner=await waitForView(registry,()=>views().find(item=>item.ownerId===ownerId&&item.active&&item.available),2000,signal);
    const resultId=plot.resultId;
    if(owner?.revealPlotStage&&flushSync(()=>owner.revealPlotStage!({resultId,source:plot.source,jobIndex:plot.jobIndex})))
      await waitForView(registry,()=>registry?.plots.get(plotId)?.display?.eligible?true:undefined,2000,signal);
  }
  return showResultPlot(registry,plotId);
}

const identifier={type:'string',minLength:1};
const index={type:'integer',minimum:0};
const bool={type:'boolean'};
const pages=Object.keys(ANALYSIS_TITLES) as AnalysisPage[];
const formats=['svg','png','txt','raw'] as const;
const plotEdits=['text','font','axis-range','axis-step','axes-style','series-style','point-style','legend','add-guide','remove-guide','undo','redo'] as const;
const oneOf=(values:readonly string[])=>({type:'string',enum:[...values]});
const color={type:'string',pattern:'^#[0-9a-fA-F]{6}$'};
const numberFrom=(minimum:number,maximum?:number)=>({type:'number',minimum,
  ...(maximum!==undefined&&Number.isFinite(maximum)?{maximum}:{})});
const directions=oneOf(['off','in','out','both']);
const side=objectSchema({direction:directions,labels:bool},['direction','labels']);
const plotPatches={
  font:objectSchema({font:oneOf(plotFonts),size:numberFrom(1),bold:bool,italic:bool}),
  'axes-style':objectSchema({color,width:numberFrom(.1),frame:oneOf(['full','axes']),density:oneOf(['sparse','standard','dense']),
    xMinor:{type:'integer',minimum:0,maximum:12},yMinor:{type:'integer',minimum:0,maximum:12},
    tickNumbers:objectSchema({x:oneOf(['auto','integer']),y:oneOf(['auto','integer'])}),
    tickSides:objectSchema({left:side,bottom:side,right:side,top:side})}),
  'series-style':objectSchema({color,width:numberFrom(0),dash:oneOf(['solid','dash','dot','dash-dot']),hidden:bool,points:bool,
    fill:oneOf(['none','solid','gradient']),opacity:numberFrom(0,1),barFillColor:color,barGradient:objectSchema({base:color},['base'])}),
  'point-style':objectSchema({marker:oneOf(['circle','square','triangle','diamond','cross']),size:numberFrom(.1),
    hollow:bool,edgeColor:color,fillColor:color,edgeWidth:numberFrom(0)}),
};

function field(args:Record<string,unknown>,name:string) {
  const value=args[name];
  if(typeof value==='string'&&value.length)return value;
  throw toolError('invalid_arguments',`${name} must be a non-empty string.`);
}

function integer(args:Record<string,unknown>,name:string,fallback?:number,minimum=0) {
  const value=args[name]??fallback;
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum)return value;
  throw toolError('invalid_arguments',`${name} must be an integer >= ${minimum}.`);
}

function choice<T extends string>(value:unknown,values:readonly T[],name:string):T {
  if(values.includes(value as T))return value as T;
  throw toolError('invalid_arguments',`${name} must be one of ${values.join(', ')}.`);
}

function validateValue(value:unknown,rule:Record<string,unknown>,path:string):void {
  const potential=rule.anyOf as Record<string,unknown>[]|undefined;
  if(potential?.some(option=>{try{validateValue(value,option,path);return true;}catch{return false;}}))return;
  if(rule.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
    const properties=rule.properties as Record<string,Record<string,unknown>>;
    if((rule.required as string[]|undefined)?.some(name=>!Object.hasOwn(value,name)))throw toolError('invalid_arguments',`${path} lacks required properties.`);
    for(const [name,item] of Object.entries(value)){
      if(!Object.hasOwn(properties,name))throw toolError('invalid_arguments',`${path}.${name} is unsupported.`);
      validateValue(item,properties[name],`${path}.${name}`);
    }
    return;
  }
  if(rule.type==='array'&&Array.isArray(value)&&(rule.minItems===undefined||value.length>=Number(rule.minItems))&&(rule.maxItems===undefined||value.length<=Number(rule.maxItems))){
    value.forEach((item,index)=>validateValue(item,rule.items as Record<string,unknown>,`${path}[${index}]`));return;
  }
  if(rule.type==='number'||rule.type==='integer'){
    if(typeof value==='number'&&Number.isFinite(value)&&(rule.type!=='integer'||Number.isSafeInteger(value))&&
      (rule.minimum===undefined||value>=Number(rule.minimum))&&(rule.maximum===undefined||value<=Number(rule.maximum))&&
      (rule.exclusiveMinimum===undefined||value>Number(rule.exclusiveMinimum))&&(!rule.enum||(rule.enum as number[]).includes(value)))return;
  }else if(rule.type==='null'?value===null:typeof value===rule.type&&(!rule.enum||(rule.enum as string[]).includes(value as string))&&
    (!rule.pattern||new RegExp(String(rule.pattern)).test(value as string)))return;
  throw toolError('invalid_arguments',`${path} has an invalid value.`);
}

function validatedPatch<T>(value:unknown,schema:Record<string,unknown>):T {
  validateValue(value,schema,'patch');
  if(!Object.keys(value as object).length)throw toolError('invalid_arguments','patch is empty.');
  return value as T;
}

function plotEdit(args:Record<string,unknown>):PlotEdit {
  const operation=choice(args.operation,plotEdits,'operation');
  switch(operation){
    case 'undo':case 'redo':return {operation};
    case 'text':{
      if(typeof args.text!=='string')throw toolError('invalid_arguments','text must be a string.');
      return {operation,text:args.text,role:choice(args.role,['title','x','y'] as const,'role')};
    }
    case 'axis-range':{
      const {bounds}=args,axis=choice(args.axis,['x','y'] as const,'axis');
      if(bounds===null)return {operation,axis,bounds};
      if(!Array.isArray(bounds)||bounds.length!==2||!bounds.every(Number.isFinite)||bounds[0]>=bounds[1])
        throw toolError('invalid_arguments','bounds must be two ascending finite values in displayed units, or null for automatic range.');
      return {operation,axis,bounds:[bounds[0],bounds[1]]};
    }
    case 'axis-step':{
      const {step}=args;
      if(step!==null&&(typeof step!=='number'||!Number.isFinite(step)||step<=0))throw toolError('invalid_arguments','step must be positive and finite in displayed units, or null for automatic ticks.');
      return {operation,axis:choice(args.axis,['x','y'] as const,'axis'),step};
    }
    case 'font':return {operation,textId:field(args,'textId'),patch:validatedPatch<Partial<PlotFontStyle>>(args.patch,plotPatches.font)};
    case 'axes-style':return {operation,patch:validatedPatch<Partial<PlotStyle['axis']>>(args.patch,plotPatches[operation])};
    case 'series-style':return {operation,seriesId:field(args,'seriesId'),patch:validatedPatch<Partial<Omit<PlotSeriesStyle,'point'>>>(args.patch,plotPatches[operation])};
    case 'point-style':return {operation,seriesId:field(args,'seriesId'),pointIndex:args.pointIndex===undefined?undefined:integer(args,'pointIndex'),patch:validatedPatch<Partial<PlotPointStyle>>(args.patch,plotPatches[operation])};
    case 'legend':{
      if(typeof args.visible!=='boolean')throw toolError('invalid_arguments','visible must be a boolean.');
      return {operation,visible:args.visible};
    }
    case 'add-guide':{
      if(typeof args.value!=='number'||!Number.isFinite(args.value)||args.label!==undefined&&typeof args.label!=='string')
        throw toolError('invalid_arguments','The guide needs a finite value in displayed units and an optional string label.');
      return {operation,axis:choice(args.axis,['x','y'] as const,'axis'),value:args.value,label:args.label as string|undefined};
    }
    case 'remove-guide':return {operation,guideId:field(args,'guideId')};
  }
}

function resultSummary(result:TrajectoryResult|ResultDiagnostic) {
  const common={id:result.id,kind:result.kind,source:result.source,label:result.label,engine:result.engine,
    jobIndex:result.jobIndex,status:result.status,messages:result.messages};
  return result.kind==='diagnostic'
    ?{...common,segmentIndex:result.segmentIndex,jobAssociation:result.jobAssociation,sourceRole:result.sourceRole,charge:result.charge,multiplicity:result.multiplicity,frameCount:0}
    :{...common,role:result.role,frameCount:result.frames.length,stages:result.stages,recoveredComputation:result.recoveredComputation};
}

function resultRead(ctx:ResultToolsContext,args:Record<string,unknown>,call?:McCall) {
  if(args.frameRef!==undefined){
    const frameRef=field(args,'frameRef');
    if(args.targetRef!==undefined||args.frameIndex!==undefined||args.start!==undefined||args.count!==undefined||args.part!==undefined&&args.part!=='structure')
      throw toolError('invalid_arguments','frameRef selects one exact structure and cannot be combined with other result or frame selectors.');
    if(!ctx.readFrame)throw toolError('frame_unavailable','The current window does not expose exact frame reading.');
    return ctx.readFrame(frameRef,call?.signal);
  }
  const target=ctx.getResult(args.targetRef===undefined?undefined:field(args,'targetRef'));
  const result=target.result??(target.file?postprocessFileJob(target.file.output.source):undefined);
  const view=result&&[...ctx.resultRegistry?.resultViews.values()??[]].find(row=>row.active&&row.ownerId===target.ownerId&&observesResult(row,result));
  const source=target.file?.output.source;
  const part=choice(args.part??'summary',['summary','jobs','frames','scientific','structure','diagnostics'] as const,'part');
  if(part==='jobs')return {ownerId:target.ownerId,source:source?.identity,jobs:source?.jobs.map(resultSummary)??(result?[resultSummary(result)]:[]),selectedJobId:source?.selectedJobId??result?.id??null};
  if(!result){
    if(source&&part==='summary')return {ownerId:target.ownerId,source:source.identity,selectedJobId:source.selectedJobId??null,jobCount:source.jobs.length};
    throw toolError('result_unavailable','No selected result job is available for the requested data.');
  }
  const summary={ownerId:target.ownerId,...resultSummary(result),
    displayedFrame:view?{index:view.frameIndex,resultId:view.result.id,sourceFrameIndex:view.result.frames[view.frameIndex]?.sourceFrameIndex??view.frameIndex,ready:view.frameReady}:null,
    wavefunction:target.postprocess?.wavefunction?.source.metadata?{
      sourceId:target.postprocess.wavefunction.source.metadata.sourceId,sourceRevision:target.postprocess.wavefunction.source.metadata.sourceRevision,
      format:target.postprocess.wavefunction.source.metadata.format,
    }:undefined};
  if(part==='summary')return summary;
  if(part==='diagnostics')return {...summary,diagnostics:result.kind==='diagnostic'?[resultSummary(result)]:result.fileDiagnostics??[]};
  if(part==='scientific'){
    if(args.frameIndex===undefined)return {...summary,scientific:result.scientific??null};
    const frameIndex=integer(args,'frameIndex');
    if(result.kind==='diagnostic'||frameIndex>=result.frames.length)throw toolError('frame_unavailable','The result does not contain the requested frame.');
    const attribution=target.postprocess?.result===result?target.postprocess:{id:target.ownerId,result,wavefunctionFrameIndex:null};
    const projection=projectPostprocessFrame(attribution,frameIndex);
    return {...summary,frameIndex,scientific:projection.scientific??null,scope:'frame-projection',wavefunctionAvailable:projection.wavefunctionAvailable};
  }
  if(result.kind==='diagnostic')throw toolError('frame_unavailable','This diagnostic has no attributed geometry frames.',summary);
  if(part==='frames'){
    const start=integer(args,'start',0),count=integer(args,'count',50,1);
    return {...summary,start,frames:result.frames.slice(start,start+count)};
  }
  const frameIndex=integer(args,'frameIndex',view?.frameReady&&view.result.id===result.id?view.frameIndex:undefined);
  if(frameIndex>=result.frames.length)throw toolError('frame_unavailable','The result does not contain the requested frame.');
  return result.getFrame(frameIndex,call?.signal).then(structure=>({...summary,frameIndex,frame:result.frames[frameIndex],structure}));
}

function encodedAsset(bytes:Uint8Array,mimeType:string,filename:string) {
  const block=3*4096,parts:string[]=[];
  for(let offset=0;offset<bytes.length;offset+=block)parts.push(btoa(String.fromCharCode(...bytes.subarray(offset,offset+block))));
  return {filename,mimeType,byteLength:bytes.length,encoding:'base64',data:parts.join('')};
}

const saveSchema={...bool,description:'With no explicit file or directory, save to the running portable package’s harness/exports directory.'};
const exportDestination={destination:{...identifier,description:'Write to this exact absolute file path.'},
  directory:{...identifier,description:'Write the native filename in this existing absolute directory.'},save:saveSchema};
const delivery={...exportDestination,onExists:oneOf(['conflict','overwrite']),preview:{...bool,description:'Return a real PNG preview. Preview alone does not write a file.'}};

function savesAsset(args:Record<string,unknown>) {
  if(args.save!==undefined&&typeof args.save!=='boolean')throw toolError('invalid_arguments','save must be a boolean.');
  if(args.destination!==undefined&&args.directory!==undefined)throw toolError('invalid_arguments','Specify either destination or directory.');
  if(args.destination!==undefined)field(args,'destination');
  if(args.directory!==undefined)field(args,'directory');
  return args.destination!==undefined||args.directory!==undefined||args.save===true;
}

function checkImagePreview(args:Record<string,unknown>,format:string) {
  savesAsset(args);
  if(args.preview!==undefined&&typeof args.preview!=='boolean')throw toolError('invalid_arguments','preview must be a boolean.');
  if(args.preview===true&&format!=='png')throw toolError('preview_format_required','Set format to png to receive a directly viewable image preview.');
}

async function deliverAsset(blob:Blob,filename:string,args:Record<string,unknown>,call?:McCall) {
  call?.signal.throwIfAborted();
  const mimeType=blob.type.split(';')[0];
  if(args.preview===true&&mimeType!=='image/png')throw toolError('preview_unavailable','The native export did not return a PNG image.',{mimeType});
  const bytes=new Uint8Array(await blob.arrayBuffer());
  call?.signal.throwIfAborted();
  const save=savesAsset(args);
  if(!save&&args.preview!==true)return encodedAsset(bytes,mimeType,filename);
  const imagePreview=args.preview===true?encodedAsset(bytes,mimeType,filename):undefined;
  const meta={filename,mimeType,byteLength:bytes.length,...(imagePreview?{imagePreview}:{})};
  if(!save)return meta;
  if(args.onExists!==undefined)choice(args.onExists,['conflict','overwrite'] as const,'onExists');
  const bridge=typeof window==='undefined'?undefined:mcpBridge();
  if(!bridge||!call)throw toolError('file_port_unavailable','This session has no native destination writer. Omit destination, directory and save to receive asset bytes.');
  const receipt=await bridge.file({action:'write',requestId:call.requestId,batchIndex:call.batchIndex,bytes,fileName:filename});
  return {...meta,delivery:receipt};
}

export function hessianReadRecovery(target:McpResultTarget) {
  return target.hessianRunId?{tool:'es_run_read',arguments:{runId:target.hessianRunId},resultPath:'hessian.modes'}:undefined;
}

export function resultTools(ctx:ResultToolsContext):McTool[] {
  const targetView=(args:Record<string,unknown>)=>{
    const target=ctx.getResult(args.targetRef===undefined?undefined:field(args,'targetRef'));
    return {target,view:viewFor(target)};
  };
  const viewFor=(target:McpResultTarget)=>{
    const registered=[...ctx.resultRegistry?.resultViews.values()??[]];
    const matches=registered.filter(view=>view.ownerId===target.ownerId&&observesResult(view,target.result));
    return matches.find(view=>view.active)??matches[0];
  };
  const reveal=(target:McpResultTarget)=>flushSync(()=>ctx.openAnalysis(target.navigationRef??target.ownerId));
  const analysisViewRecovery=(targetRef:string,page?:AnalysisPage)=>({tool:'analysis_view',arguments:{targetRef,...(page?{page}:{}),waitMs:2000}});
  const activeAnalysis=(target:McpResultTarget,active:boolean)=>{
    const view=viewFor(target),owner=ctx.resultRegistry?.analysisViews.get(view?.analysisKey??target.ownerId);
    return owner&&(!view||view.available&&(!active||view.active))&&(!active||owner.read().active)?{view,owner}:undefined;
  };
  const plotReceipt=(id:string,asset?:Record<string,unknown>)=>{
    const entry=ctx.resultRegistry?.plots.get(id),display=entry?.display;
    const visible=Boolean(display?.visible&&(entry?.port.isVisible?.()??true));
    return {plotId:id,revision:entry?.revision,ownerId:entry?.ownerId,resultId:entry?.resultId,source:entry?.source,
      collectionId:entry?.collectionId,runId:entry?.runId,stageId:entry?.stageId,
      ...asset,status:visible?'shown':display&&!display.eligible?'hidden':display&&!display.visible?'minimized':'opening',visible,active:display?.active??false};
  };
  const plot=(id:string)=>{
    const entry=ctx.resultRegistry?.plots.get(id);
    if(!entry)throw toolError('plot_unavailable','The figure has no mounted, editable chart in this project window.',{plotId:id});
    return entry;
  };
  const plotSources=()=>[...ctx.resultRegistry?.plotSources.values()??[]].map(({open,...entry})=>({
    ...entry,available:!!open,recovery:open?{tool:'plot_open',arguments:{kind:entry.kind,targetRef:entry.targetRef}}:undefined,
  }));
  const plotSummary=(id:string,metadata=false)=>{
    const {port,display,figureIdentity:_identity,configurationIdentity:_configuration,...entry}=plot(id),{metadata:sourceMetadata,...read}=port.read();
    const configuration=port.configuration&&Object.fromEntries(Object.entries(port.configuration).map(([scope,settings])=>[scope,{schema:settings.schema,settings:settings.read()}]));
    const windowActions=display?['show',...(display.minimize?['minimize']:[]),...(display.close?['close']:[]),...(display.setLayout?['layout']:[])]:[];
    return {plotId:id,...entry,...read,configuration,visible:display?.visible&&(port.isVisible?.()??true),active:display?.active,layout:display?.layout,
      windowActions,capabilities:{editOperations:read.edits??[],parts:read.parts??['main'],byPart:read.partCapabilities,
        configurationScopes:Object.keys(configuration??{}),formats:read.formats,windowActions},...(metadata?{metadata:sourceMetadata}:{})};
  };
  const assertPlotRevision=(id:string,args:Record<string,unknown>)=>{
    const entry=plot(id),supplied=integer(args,'revision');
    if(supplied!==entry.revision)throw toolError('revision_conflict','The plotted figure changed. Read the current figure before editing it.',{plotId:id,revision:entry.revision});
    return entry.port;
  };
  const analysisVersions=new Map<string,{native:string;token:string}>();
  const analysisRevision=(analysisId:string,native:string)=>{
    const previous=analysisVersions.get(analysisId);
    if(previous?.native===native)return previous.token;
    for(const id of analysisVersions.keys())if(!ctx.resultRegistry?.runs.has(id))analysisVersions.delete(id);
    const token=crypto.randomUUID();
    analysisVersions.set(analysisId,{native,token});
    return token;
  };
  const assertAnalysisRevision=(analysisId:string,native:string,supplied:string,message:string)=>{
    const sourceRevision=analysisRevision(analysisId,native);
    if(supplied!==sourceRevision&&supplied!==native)throw toolError('revision_conflict',message,{analysisId,sourceRevision,recovery:panelRecovery(analysisId)});
    return sourceRevision;
  };
  const knownPanels=new Map<string,{targetRef:string;page:AnalysisPage}>();
  const panelRecovery=(analysisId:string)=>{
    const location=knownPanels.get(analysisId);
    return location?analysisViewRecovery(location.targetRef,location.page):undefined;
  };
  const missingAnalysis=(analysisId:string)=>toolError('analysis_unavailable','The named analysis is not mounted on the current owner. Read its native panel before continuing.',
    {analysisId,recovery:panelRecovery(analysisId)});
  return [
    {name:'result_read',description:'Read admitted results, file jobs, printed data or source-attributed geometry. All frame indexes are zero-based.',
      inputSchema:objectSchema({targetRef:identifier,frameRef:identifier,part:oneOf(['summary','jobs','frames','scientific','structure','diagnostics']),frameIndex:index,start:index,count:{...index,minimum:1}}),
      call:(args,call)=>resultRead(ctx,args,call)},
    {name:'analysis_view',description:'Read the native analysis workspace and select a page on the exact owner. Read panelStatus and methodStatus before submitting. For PES Hessian frequencies use the original runId with es_run_read, then inspect hessian.modes. For XTB2 charges use page="charges". Copy analysisId and sourceRevision to analysis actions.',
      inputSchema:objectSchema({targetRef:identifier,page:oneOf(pages),waitMs:{...index,maximum:60000}}),call:async(args,call)=>{
        const page=args.page===undefined?undefined:choice(args.page,pages,'page');
        const waitMs=integer(args,'waitMs',page?2000:0);
        if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
        const {target}=targetView(args);
        const targetRef=target.navigationRef??target.ownerId,identity={ownerId:target.ownerId,targetRef};
        const recovery=page==='vibrations'?hessianReadRecovery(target):undefined;
        const unavailable={...identity,requestedPage:page,status:'analysis_view_unavailable',panelStatus:'unavailable',source:target.result?.source,recovery};
        if(page==='vibrations'&&target.hessianRunId&&!target.result)return {...unavailable,reason:'The frequency data belongs to the original PES Hessian run.'};
        if(target.result?.kind==='diagnostic'||target.file&&!target.result&&!target.file.displayResult)
          return unavailable;
        const started=performance.now();
        if(page)await reveal(target);
        let ready=await waitForView(ctx.resultRegistry,()=>activeAnalysis(target,page!==undefined),waitMs,call?.signal);
        if(viewFor(target)?.available===false)return {...unavailable,reason:'The native owner has withdrawn access to the current result view.'};
        if(!ready)return {...identity,status:'analysis_view_preparing',panelStatus:'preparing',...viewReceipt(viewFor(target)),source:target.result?.source,
          recovery:recovery??analysisViewRecovery(targetRef,page)};
        const availablePages=ready.owner.read().availablePages;
        if(page&&!availablePages.includes(page))return {...unavailable,availablePages,reason:ready.owner.unavailableReason?.(page)};
        const wantedStage=page?ready.owner.stageFor?.(page):undefined;
        const panelId=page?flushSync(()=>ready!.owner.open(page)):ready.owner.read().state.activeId;
        if(page){
          ready=await waitForView(ctx.resultRegistry,()=>{
            const current=activeAnalysis(target,true);
            return current&&isStage(current.view,wantedStage)&&current.owner.read().state.activeId===panelId?current:undefined;
          },Math.max(0,waitMs-(performance.now()-started)),call?.signal);
          if(!ready)return {...identity,panelId,requestedPage:page,requestedStage:wantedStage,status:'analysis_view_preparing',panelStatus:'preparing',frameReady:false,
            recovery:recovery??analysisViewRecovery(targetRef,page)};
        }
        const {view,owner}=ready;
        const updated=owner.read(),selectedPage=page??updated.state.instances.find(item=>item.id===panelId)?.kind;
        const analysisId=panelId?updated.runId??panelId:null;
        if(analysisId&&selectedPage)knownPanels.set(analysisId,{targetRef,page:selectedPage});
        const readRunner=()=>analysisId?ctx.resultRegistry?.runs.get(analysisId):undefined;
        const runnerNow=readRunner();
        const runner=runnerNow?.methodStatus==='preparing'&&updated.active?await waitForView(ctx.resultRegistry,()=>{
          const current=readRunner();return current?.methodStatus!=='preparing'?current:undefined;
        },Math.max(0,waitMs-(performance.now()-started)),call?.signal)??readRunner():runnerNow;
        if(updated.active&&runnerNow?.methodStatus==='preparing'){
          const current=activeAnalysis(target,true);
          if(!current||current.owner.read().state.activeId!==panelId||!isStage(current.view,wantedStage))
            return {...identity,panelId,analysisId,status:'analysis_view_inactive',panelStatus:'inactive',recovery:analysisViewRecovery(targetRef,selectedPage)};
        }
        const methodStatus=runner?.methodStatus??(runner?.methods.length?'ready':'unavailable');
        const analysis=runner?.read();
        const nativeError=(analysis as {error?:string} | undefined)?.error;
        const diagnostic=typeof nativeError==='string'&&isMultiwfnBackendFailure(nativeError)?{tool:'multiwfn_configure',arguments:{}}:undefined;
        const plots=analysisId?[...ctx.resultRegistry?.plots.values()??[]].filter(row=>row.analysisId===analysisId&&row.kind).map(row=>({plotId:row.id,kind:row.kind,revision:row.revision})):[];
        return {...identity,...viewReceipt(view),
          panelId,analysisId,...updated,panelStatus:updated.active?'ready':'inactive',methodStatus,plots,
          recovery:diagnostic??(methodStatus==='preparing'||!updated.active?analysisViewRecovery(targetRef,selectedPage):undefined),
          ...(runner?{sourceRevision:analysisRevision(analysisId!,runner.sourceRevision),methods:runner.methods,analysis,execution:runner.execution?.(),
            plotKinds:[...new Set([...Object.keys(runner.plots?.()??{}),...plots.map(row=>row.kind)])],assets:runner.assets?.().map(asset=>asset.info)??[],
            configuration:runner.configuration?{settings:runner.configuration.read(),schema:runner.configuration.schema}:undefined,
            presentation:runner.presentation?{settings:runner.presentation.read(),schema:runner.presentation.schema}:undefined}:{})};
      }},
    {name:'analysis_panel',description:'Activate, close, detach or dock an existing native analysis panel, or change the active analysis workspace layout.',
      inputSchema:objectSchema({targetRef:identifier,action:oneOf(['activate','close','detach','dock','layout']),panelId:identifier,mode:oneOf(['tabs','tiled','free']),waitMs:{...index,maximum:60000}},['action']),call:async(args,call)=>{
        const {target}=targetView(args),before=activeAnalysis(target,true),action=choice(args.action,['activate','close','detach','dock','layout'] as const,'action');
        if(!before?.owner.control)throw toolError('analysis_view_unavailable','Locate the native analysis workspace before controlling its layout.',
          {ownerId:target.ownerId,recovery:panelRecovery(String(args.panelId))??{tool:'es_show',arguments:{target:target.navigationRef??target.ownerId,module:'analysis'}}});
        const panelId=action==='layout'?undefined:field(args,'panelId'),mode=action==='layout'?choice(args.mode,['tabs','tiled','free'] as const,'mode'):undefined;
        const kind=before.owner.read().state.instances.find(item=>item.id===panelId)?.kind;
        if(panelId&&!kind)throw toolError('analysis_panel_unavailable','This panel is not part of the current analysis workspace.',{panelId,recovery:panelRecovery(panelId)});
        const wanted=action==='activate'&&kind?before.owner.stageFor?.(kind):undefined;
        const waitMs=integer(args,'waitMs',2000);
        if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
        await flushSync(()=>before.owner.control!(action==='layout'?{action,mode:mode!}:{action,panelId:panelId!}));
        if(action==='activate'){
          const ready=await waitForView(ctx.resultRegistry,()=>{const current=activeAnalysis(target,true);
            return current&&isStage(current.view,wanted)&&current.owner.read().state.activeId===panelId?current:undefined;
          },waitMs,call?.signal);
          if(!ready)return {ownerId:target.ownerId,action,panelId,status:'analysis_view_preparing',requestedStage:wanted,frameReady:false};
        }
        const current=activeAnalysis(target,true);
        const workspace=current?.owner.read(),item=workspace?.state.instances.find(row=>row.id===panelId);
        const applied=action==='close'?!!workspace&&!item:action==='dock'?item?.detached===false:action==='detach'?item?.detached===true:
          action==='layout'?workspace?.state.mode===mode:workspace?.state.activeId===panelId;
        if(action==='close'&&applied&&panelId)knownPanels.delete(panelId);
        return {ownerId:target.ownerId,action,panelId,status:applied?'applied':'not_applied',workspace,...viewReceipt(current?.view)};
      }},
    {name:'analysis_configure',description:'Apply a typed patch to the current analysis owner using the configuration schema from analysis_view.',
      inputSchema:objectSchema({analysisId:identifier,sourceRevision:identifier,scope:oneOf(['setup','presentation']),patch:{type:'object'}},['analysisId','sourceRevision','patch']),call:args=>{
        const analysisId=field(args,'analysisId'),runner=ctx.resultRegistry?.runs.get(analysisId);
        const scope=choice(args.scope??'setup',['setup','presentation'] as const,'scope'),settings=scope==='presentation'?runner?.presentation:runner?.configuration;
        if(!runner)throw missingAnalysis(analysisId);
        if(!settings)throw toolError('analysis_configuration_unavailable','This analysis does not provide the requested settings.',{analysisId,scope,recovery:panelRecovery(analysisId)});
        assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),'The analysis source or settings changed. Read the current panel before editing.');
        const patch=validatedPatch<Record<string,unknown>>(args.patch,settings.schema);
        flushSync(()=>settings.apply(patch));
        const current=ctx.resultRegistry?.runs.get(analysisId);
        return {analysisId,scope,sourceRevision:current&&analysisRevision(analysisId,current.sourceRevision),methods:current?.methods,settings:(scope==='presentation'?current?.presentation:current?.configuration)?.read()};
      }},
    {name:'analysis_run',description:'Submit a supported method through the active analysis panel. Pass the analysisId and sourceRevision from analysis_view. A cached surface result can have no active native session. If the receipt offers surface-restore-session, explicitly invoke it to rebuild that session on the same source before generating new grids.',
      inputSchema:objectSchema({analysisId:identifier,method:identifier,sourceRevision:identifier,retry:bool,parameters:{type:'object',description:'Method-specific settings advertised by the analysis panel.'}},['analysisId','method','sourceRevision']),call:args=>{
        const analysisId=field(args,'analysisId'),method=field(args,'method'),runner=ctx.resultRegistry?.runs.get(analysisId);
        if(!runner)throw missingAnalysis(analysisId);
        const revision=assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),'The analysis source or frame changed. Read the current panel before submitting.');
        if(args.parameters!==undefined&&(!args.parameters||typeof args.parameters!=='object'||Array.isArray(args.parameters)))throw toolError('invalid_arguments','parameters must be an object.');
        const recovery=(port:typeof runner,sourceRevision:string)=>{
          const restore=port.recoverMethod?.(method);
          return restore?{tool:'analysis_run',arguments:{analysisId,sourceRevision,method:restore}}:undefined;
        };
        let receipt;
        try{receipt=flushSync(()=>runner.run(method,args.retry===true,args.parameters as Record<string,unknown>??{}));}
        catch(cause){
          const error=cause as {code?:string;message?:string;data?:Record<string,unknown>};
          const next=error?.code==='analysis_busy'?{tool:'analysis_control',arguments:{analysisId,action:'status'}}:
            error?.message&&isMultiwfnBackendFailure(error.message)?{tool:'multiwfn_configure',arguments:{}}:
            recovery(runner,revision)??panelRecovery(analysisId);
          if(!next)throw cause;
          throw toolError(error?.code??'analysis_method_unavailable',error?.message??String(cause),{...error?.data,analysisId,method,methods:runner.methods,recovery:next});
        }
        const current=ctx.resultRegistry?.runs.get(analysisId);
        const sourceRevision=analysisRevision(analysisId,current?.sourceRevision??runner.sourceRevision);
        return {analysisId,sourceRevision,method,receipt,execution:current?.execution?.(),recovery:recovery(current??runner,sourceRevision)};
      }},
    {name:'analysis_control',description:'Observe or request stop of a current native analysis owner. A stop request is distinct from native settlement.',
      inputSchema:objectSchema({analysisId:identifier,action:oneOf(['status','stop']),sourceRevision:identifier,requestId:identifier},['analysisId','action']),call:args=>{
        const analysisId=field(args,'analysisId'),runner=ctx.resultRegistry?.runs.get(analysisId),action=choice(args.action,['status','stop'] as const,'action');
        if(!runner)throw missingAnalysis(analysisId);
        if(!runner.execution)throw toolError('analysis_execution_unavailable','This analysis has no observable native execution.',{analysisId,recovery:panelRecovery(analysisId)});
        const scope=runner.execution();
        const sourceRevision=analysisRevision(analysisId,runner.sourceRevision);
        if(action==='status')return {analysisId,sourceRevision,execution:scope};
        const message='The analysis source or run changed. Read its current execution before stopping.';
        assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),message);
        if(args.requestId!==undefined&&field(args,'requestId')!==scope.requestId)throw toolError('revision_conflict',message,{analysisId,sourceRevision});
        if(!scope.stoppable||!runner.stop)return {analysisId,sourceRevision,status:'not_stoppable',execution:scope};
        flushSync(()=>{void runner.stop!();});
        const execution=ctx.resultRegistry?.runs.get(analysisId)?.execution?.();
        return {analysisId,sourceRevision,requestId:scope.requestId,status:'stop_requested',execution};
      }},
    {name:'analysis_export',description:'Save an admitted asset to a destination or directory, or set save=true for harness/exports. Use analysisId and sourceRevision from analysis_view and assetId from assets[].id. Cube grids include a SHA-bound valid-domain companion file.',
      inputSchema:objectSchema({analysisId:identifier,sourceRevision:identifier,assetId:identifier,...exportDestination,onExists:oneOf(['error','overwrite'])},
        ['analysisId','sourceRevision','assetId']),call:async(args,call)=>{
        const analysisId=field(args,'analysisId'),assetId=field(args,'assetId');
        if(!savesAsset(args))throw toolError('invalid_arguments','Specify destination, directory, or save=true to save this analysis asset.');
        const destination=args.destination===undefined?undefined:field(args,'destination');
        const runner=ctx.resultRegistry?.runs.get(analysisId);
        if(!runner)throw missingAnalysis(analysisId);
        const sourceRevision=assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),'The analysis source or asset changed. Read the current panel.');
        const asset=runner.assets?.().find(row=>row.info.id===assetId);
        if(!asset)throw toolError('analysis_asset_unavailable','The current analysis has no such admitted asset.');
        const suffix=destination?.split('.').at(-1)?.toLowerCase();
        if(destination&&(asset.kind==='cube'?suffix!=='cube'&&suffix!=='cub':suffix!==asset.info.filename.split('.').at(-1)))
          throw toolError('invalid_export_extension','The destination extension must match the selected scientific asset.');
        if(args.onExists!==undefined)choice(args.onExists,['error','overwrite'] as const,'onExists');
        const bridge=typeof window==='undefined'?undefined:mcpBridge(),desktop=typeof window==='undefined'?undefined:window.sciyueDesktop;
        if(!bridge||!desktop||!call)throw toolError('file_port_unavailable','The current session has no native analysis artifact writer.');
        const write=(id:string,domainAssetId?:string)=>bridge.file({action:'write-analysis',requestId:call.requestId,batchIndex:call.batchIndex,assetId:id,fileName:asset.info.filename,
          ...(domainAssetId?{domainAssetId}:{})});
        const publish=async(file:{id:string;sha256:string;size:number},dispose:Awaited<ReturnType<typeof stageScientificText>>['dispose'],domainAssetId?:string)=>{
          let delivery,cleanupWarnings;
          try{call.signal.throwIfAborted();delivery=await write(file.id,domainAssetId);}
          finally{cleanupWarnings=await dispose();}
          return {analysisId,sourceRevision,asset:asset.info,sha256:file.sha256,bytes:file.size,delivery,...(cleanupWarnings.length?{cleanupWarnings}:{})};
        };
        if(asset.kind==='text'){
          const staged=await stageScientificText(asset.text(),desktop,call.signal);
          return publish(staged.file,staged.dispose);
        }
        const original=await asset.original?.();
        const staged=await stageSavedCube(asset.field,desktop,{title:asset.info.filename,signal:call.signal,original});
        return {...await publish(staged.cube,staged.dispose,staged.domain.id),representation:original?'retained-original':'serialized-admitted-field',
          domainSha256:staged.domain.sha256,domainBytes:staged.domain.size};
      }},
    {name:'plot_open',description:'Show an existing native plot by plotId, or open a correctly attributed native result figure.',
      inputSchema:objectSchema({targetRef:{...identifier,description:'Scientific source reference. For conformer-energy, use the stage collection plotTargetRef or targetRef from plot_read.availableSources.'},kind:oneOf(['scf','levels','file-path','interaction-scatter','hirshfeld-fingerprint','surface-distribution','conformer-energy']),
        plotId:identifier,reuse:bool,frameIndex:index,reference:oneOf(['absolute','relative-to-ts']),analysisId:identifier,sourceRevision:identifier}),call:async(args,call)=>{
        if(args.plotId!==undefined){
          const id=field(args,'plotId'),entry=plot(id);
          if(args.kind!==undefined||args.targetRef!==undefined||args.frameIndex!==undefined||args.analysisId!==undefined||args.reference!==undefined)
            throw toolError('invalid_arguments','Select an existing plotId or a scientific source for a plot.');
          return showNativeResultPlot(ctx,id,call?.signal);
        }
        const kind=choice(args.kind,['scf','levels','file-path','interaction-scatter','hirshfeld-fingerprint','surface-distribution','conformer-energy'] as const,'kind');
        if(kind==='conformer-energy'){
          if(args.frameIndex!==undefined||args.analysisId!==undefined||args.sourceRevision!==undefined||args.reference!==undefined)
            throw toolError('invalid_arguments','A conformer-energy figure uses one exact stage collection targetRef.');
          const targetRef=field(args,'targetRef'),source=ctx.resultRegistry?.plotSources.get(targetRef);
          if(!source?.open||source.kind!==kind){
            const sources=plotSources();
            throw toolError('plot_data_unavailable',source?.unavailableReason??'This stage collection has no comparable native conformer-energy figure.',
              {targetRef,stage:sources.find(entry=>entry.targetRef===targetRef),availableSources:sources.filter(entry=>entry.available)});
          }
          if(args.reuse===false)throw toolError('plot_copy_unavailable','This native collection owns one editable energy figure. Open it without reuse=false.',{targetRef,plotId:source.plotId});
          const reused=Boolean(ctx.resultRegistry?.plots.has(source.plotId));
          flushSync(source.open);
          const entry=await waitForView(ctx.resultRegistry,()=>ctx.resultRegistry?.plots.get(source.plotId),2000,call?.signal);
          return plotReceipt(source.plotId,{targetRef,collectionId:source.collectionId,runId:source.runId,stageId:source.stageId,reused,
            ...(entry?{}:{status:'preparing'})});
        }
        if(kind==='interaction-scatter'||kind==='hirshfeld-fingerprint'||kind==='surface-distribution'){
          const analysisId=field(args,'analysisId'),runner=ctx.resultRegistry?.runs.get(analysisId);
          if(!runner)throw missingAnalysis(analysisId);
          assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),'The analysis source or plotted selection changed. Read the current panel.');
          if(kind==='surface-distribution'){
            const existing=[...ctx.resultRegistry?.plots.values()??[]].find(row=>row.analysisId===analysisId&&row.kind===kind&&row.display?.eligible);
            if(!existing)throw toolError('plot_data_unavailable','The selected native surface panel does not have an area-distribution chart ready.');
            return {...await showNativeResultPlot(ctx,existing.id,call?.signal),analysisId,reused:true};
          }
          const factory=runner.plots?.()[kind];
          if(!factory)throw toolError('plot_data_unavailable','The analysis does not have this attributed figure ready.');
          const existing=args.reuse===false?undefined:[...ctx.resultRegistry?.plots.values()??[]].find(row=>row.kind===kind&&row.analysisSourceKey===factory.sourceKey);
          const plotId=existing?existing.id:flushSync(factory.open);
          if(!plotId)throw toolError('plot_source_changed','The analysis changed before the figure could open.');
          if(existing?.display?.eligible)flushSync(existing.display.activate);
          return plotReceipt(plotId,{analysisId,reused:Boolean(existing)});
        }
        const {target,view:prior}=targetView(args);
        if(kind==='file-path'){
          const reference=choice(args.reference??'absolute',['absolute','relative-to-ts'] as const,'reference');
          if(!target.file)throw toolError('plot_data_unavailable','The selected source is not a file job with printed path energy.');
          await reveal(target);
          const current=ctx.getResult(target.navigationRef??target.ownerId);
          const snapshot=current.file&&createFilePathPlotSnapshot(current.file,reference);
          if(!snapshot)throw toolError('plot_data_unavailable','The selected file job has no attributed printed path energy for this reference.');
          const existing=args.reuse===false?undefined:[...ctx.resultRegistry?.plots.values()??[]].find(row=>row.kind===kind&&row.reference===reference&&row.ownerId===snapshot.fileOwnerId&&row.jobId===snapshot.jobId
            &&row.source?.id===snapshot.source.id&&row.source.sha256===snapshot.source.sha256);
          const plotId=existing?existing.id:flushSync(()=>ctx.openPlot(snapshot));
          if(existing?.display?.eligible)flushSync(existing.display.activate);
          return plotReceipt(plotId,{source:snapshot.source,jobId:snapshot.jobId,jobIndex:snapshot.jobIndex,reference,reused:Boolean(existing)});
        }
        if(!prior?.active||!prior.available)await reveal(target);
        const view=await waitForView(ctx.resultRegistry,()=>{const current=viewFor(target);
          return current?.active&&current.available&&(args.frameIndex!==undefined||current.frameReady)?current:undefined;
        },2000,call?.signal);
        if(!view)return {status:'analysis_view_preparing',ownerId:target.ownerId};
        const result=view.result;
        if(!result)throw toolError('plot_source_unavailable','The result has no attributed geometry frames for this plot.');
        const frameIndex=integer(args,'frameIndex',view?.active&&view.frameReady?view.frameIndex:undefined);
        if(frameIndex>=result.frames.length)throw toolError('frame_unavailable','The result does not contain the requested frame.');
        const snapshot={...createPostprocessPlotSnapshot(result,frameIndex,kind),ownerId:target.ownerId,rootResultId:view.rootResultId??view.sourceResultId};
        if(kind==='scf'&&!postprocessScfState(result,frameIndex).available||kind==='levels'&&!snapshot.orbitals.some(channel=>channel.orbitals.some(orbital=>Number.isFinite(orbital.energy))))
          throw toolError('plot_data_unavailable','The attributed frame has no printable data for this plot.',{resultId:result.id,frameIndex,kind});
        const existing=args.reuse===false?undefined:[...ctx.resultRegistry?.plots.values()??[]].find(row=>row.kind===kind&&(!row.ownerId||row.ownerId===target.ownerId)&&row.resultId===result.id&&row.frameIndex===frameIndex
          &&row.source?.id===result.source.id&&row.source.size===result.source.size&&row.source.sha256===result.source.sha256);
        const plotId=existing?existing.id:flushSync(()=>ctx.openPlot(snapshot));
        if(existing?.display?.eligible)flushSync(existing.display.activate);
        return plotReceipt(plotId,{ownerId:target.ownerId,resultId:result.id,source:result.source,jobIndex:result.jobIndex,frameIndex,reused:Boolean(existing)});
      }},
    {name:'plot_read',description:'List native figures and scientific plot source availability by stage, or read a named figure, its actual capabilities, settings, revision and formats. Use the advertised editOperations and objects for the requested chart part.',
      inputSchema:objectSchema({plotId:identifier,includeMetadata:bool}),call:args=>{
        if(args.plotId!==undefined)return plotSummary(field(args,'plotId'),args.includeMetadata===true);
        const sources=plotSources();
        const plots=[...ctx.resultRegistry?.plots.values()??[]].map(({port,id,kind,source,ownerId,resultId,jobId,jobIndex,frameIndex,revision,display,collectionId,runId,stageId})=>{
          const {title,family}=port.read();
          return {id,kind,source,ownerId,resultId,jobId,jobIndex,frameIndex,revision,collectionId,runId,stageId,visible:display?.visible&&(port.isVisible?.()??true),active:display?.active,title,family};
        });
        return {plots,sources,availableSources:sources.filter(source=>source.available)};
      }},
    {name:'plot_window',description:'Restore, minimize or close an existing native plot window, or change its native deck layout. minimize retains the figure for later show and project saving. close removes that figure from the current layout, so subsequent saves record it as closed. To verify saved editable state, use es_project action=reopen without closing the plot first.',
      inputSchema:objectSchema({plotId:identifier,action:oneOf(['show','minimize','close','layout']),mode:oneOf(['free','tiled']),arrange:bool},['plotId','action']),call:async(args,call)=>{
        const id=field(args,'plotId'),action=choice(args.action,['show','minimize','close','layout'] as const,'action'),entry=plot(id);
        if(action==='show')return showNativeResultPlot(ctx,id,call?.signal);
        if(action==='layout'){
          const mode=choice(args.mode,['free','tiled'] as const,'mode');
          if(!entry.display?.eligible||!entry.display.setLayout)throw toolError('plot_lifecycle_unavailable','Show a plot in its native deck before changing the layout.');
          const arrange=args.arrange===true;
          flushSync(()=>entry.display!.setLayout!(mode,arrange));
          return plotReceipt(id,{layout:plot(id).display?.layout});
        }
        const invoke=entry.display?.[action];
        if(!invoke)throw toolError('plot_lifecycle_unavailable','This figure is owned by a panel without an independent plot window.');
        flushSync(invoke);
        if(action==='close'&&!ctx.resultRegistry?.plots.has(id))return {plotId:id,status:'closed'};
        return plotReceipt(id);
      }},
    {name:'plot_edit',description:'Edit the native figure using its current revision and capabilities.byPart from plot_read. For plot text, use operation=text and role=title, x, or y. For font edits, pass operation=font, a listed textId and patch such as {size:14}. For scatter markers, use operation=point-style and the listed seriesId. Use plot_configure scope=inset to create an inset from data ranges before positioning its box.',
      inputSchema:objectSchema({plotId:identifier,revision:index,operation:oneOf(plotEdits),part:oneOf(['main','inset']),role:{...oneOf(['title','x','y']),description:'Text role: title, x-axis label or y-axis label.'},text:{type:'string',description:'Literal displayed text. For operation=text, include the user’s exact capitalization and symbols.'},
        axis:oneOf(['x','y']),bounds:{anyOf:[{type:'array',items:{type:'number'},minItems:2,maxItems:2},{type:'null'}]},
        visible:bool,value:{type:'number'},label:{type:'string'},guideId:identifier,textId:{...identifier,description:'A font target in plot_read textIds for the selected part, such as title, x, y or ticks.'},seriesId:{...identifier,description:'An existing series ID from the selected part.'},pointIndex:index,
        step:{anyOf:[{type:'number',exclusiveMinimum:0},{type:'null'}]},patch:{anyOf:Object.values(plotPatches)}},['plotId','revision','operation']),call:args=>{
        const id=field(args,'plotId'),port=assertPlotRevision(id,args),change=plotEdit(args);
        const state=port.read();
        const part=args.part===undefined?undefined:choice(args.part,['main','inset'] as const,'part');
        if(part==='inset'&&!state.parts?.includes('inset'))throw toolError('plot_part_unavailable','Create an inset using plot_configure before editing that part.',{plotId:id,parts:state.parts??['main'],configurationScopes:Object.keys(port.configuration??{})});
        const capabilities=state.partCapabilities?.[part??'main'],edits=capabilities?.editOperations??state.edits??[];
        if(!edits.includes(change.operation))throw toolError('plot_edit_unavailable','The current chart does not support that edit.',{plotId:id,operation:change.operation,editOperations:edits,recovery:{tool:'plot_read',arguments:{plotId:id}}});
        if(change.operation==='font'&&capabilities&&!capabilities.textIds.includes(change.textId))
          throw toolError('plot_text_unavailable','Choose a textId from the selected part.',{plotId:id,part:part??'main',textIds:capabilities.textIds});
        if((change.operation==='series-style'||change.operation==='point-style')&&capabilities){
          const supported=capabilities.series.filter(series=>change.operation==='series-style'?series.lineStyle:series.pointStyle);
          if(!supported.some(series=>series.id===change.seriesId))throw toolError('plot_series_unavailable','The selected series does not support that style edit.',{plotId:id,part:part??'main',series:supported});
        }
        flushSync(()=>part?port.edit(change,part):port.edit(change));
        return plotSummary(id);
      }},
    {name:'plot_configure',description:'Change the same figure’s canvas, inset or specialized presentation controls. Use the live schema from plot_read.',
      inputSchema:objectSchema({plotId:identifier,revision:index,scope:identifier,patch:{type:'object'}},['plotId','revision','scope','patch']),call:args=>{
        const id=field(args,'plotId'),port=assertPlotRevision(id,args),scope=field(args,'scope');
        const settings=port.configuration&&Object.hasOwn(port.configuration,scope)?port.configuration[scope]:undefined;
        if(!settings)throw toolError('plot_configuration_unavailable','This chart does not provide the requested settings.',{plotId:id,scope,configurationScopes:Object.keys(port.configuration??{})});
        const patch=validatedPatch<Record<string,unknown>>(args.patch,settings.schema);
        flushSync(()=>settings.apply(patch));
        return plotSummary(id);
      }},
    {name:'plot_preset',description:'Apply, save or set the family default of a native plot preset, using the current figure revision.',
      inputSchema:objectSchema({plotId:identifier,revision:index,action:oneOf(['apply','save','make-default','restore-default']),presetId:identifier,label:identifier},['plotId','revision']),call:args=>{
        const id=field(args,'plotId'),port=assertPlotRevision(id,args),action=choice(args.action??'apply',['apply','save','make-default','restore-default'] as const,'action');
        if(action==='save'){
          const label=field(args,'label');
          if(!port.savePreset)throw toolError('preset_unavailable','The figure does not save named presets.');
          const presetId=flushSync(()=>port.savePreset!(label));
          return {presetId,...plotSummary(id)};
        }
        const presetId=action==='restore-default'?port.read().defaultPresetId:field(args,'presetId');
        if(!presetId)throw toolError('preset_unavailable','The figure does not have a default preset.');
        if(!port.read().presets.some(row=>row.id===presetId))throw toolError('preset_unavailable','The preset is unavailable for this figure.');
        if(action==='make-default'&&!port.defaultPreset)throw toolError('preset_unavailable','The figure has no editable default preset.');
        flushSync(()=>action==='make-default'?port.defaultPreset!(presetId):port.preset(presetId));
        return plotSummary(id);
      }},
    {name:'plot_export',description:'Export the named native figure as image or scientific text. Set destination, directory or save=true to write it. Use format=png and preview=true to inspect the rendered image.',
      inputSchema:objectSchema({plotId:identifier,format:oneOf(formats),...delivery},['plotId','format']),call:async(args,call)=>{
        const plotId=field(args,'plotId'),format:PlotExportFormat=choice(args.format,formats,'format'),entry=plot(plotId);
        checkImagePreview(args,format);
        if(!entry.port.read().formats.includes(format))throw toolError('format_unavailable','The figure does not export this format.');
        const {blob,filename}=await entry.port.export(format,call?.signal??new AbortController().signal);
        const current=ctx.resultRegistry?.plots.get(plotId);
        if(!current||current.revision!==entry.revision)throw toolError('revision_conflict','The figure changed during capture. Read its current revision before exporting again.',{plotId,revision:current?.revision,capturedRevision:entry.revision});
        return {plotId,revision:entry.revision,source:entry.source,ownerId:entry.ownerId,resultId:entry.resultId,
          collectionId:entry.collectionId,runId:entry.runId,stageId:entry.stageId,...await deliverAsset(blob,filename,args,call)};
      }},
    {name:'view_export',description:'Capture the actual ready scientific viewport as PNG or SVG. Set destination, directory or save=true to write it. Use format=png and preview=true to inspect the rendering. Follow the returned recovery if the requested viewport is inactive or still preparing.',
      inputSchema:objectSchema({targetRef:identifier,format:oneOf(['png','svg']),includeAnnotations:bool,transparent:bool,width:{...index,minimum:1},height:{...index,minimum:1},...delivery}),call:async(args,call)=>{
        const {target,view}=targetView(args),format=choice(args.format??'png',['png','svg'] as const,'format');
        checkImagePreview(args,format);
        for(const key of ['transparent','includeAnnotations'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw toolError('invalid_arguments',`${key} must be a boolean.`);
        const signal=call?.signal??new AbortController().signal,options:ViewportImageExportOptions={format,includeAnnotations:args.includeAnnotations!==false,transparent:args.transparent===true,
          width:args.width===undefined?undefined:integer(args,'width',undefined,1),height:args.height===undefined?undefined:integer(args,'height',undefined,1)};
        const targetRef=target.navigationRef??target.ownerId;
        const receipt=viewReceipt(view);
        const locate=view&&target.result&&!target.navigationRef&&!target.file?{kind:'result',ref:target.result.id}:targetRef;
        const recovery={tool:'es_show',arguments:{target:locate,waitFor:'scene'}};
        const context={ownerId:target.ownerId,targetRef,...receipt,source:view?.result.source??target.result?.source,committed:false};
        if(view&&!view.active)throw toolError('viewport_inactive','The requested result viewport is inactive. Locate its native owner before capturing.',{...context,reason:'inactive-owner',recovery});
        if(view&&!view.available)throw toolError('viewport_unavailable','The native owner has withdrawn access to the current result view.',{...context,reason:'result-view-unavailable'});
        if(view&&(!view.frameReady||receipt.scene.status==='preparing'))
          throw toolError('viewport_preparing','The requested scientific frame has not reached the native viewport.',{...context,
            reason:view.frameReady?'scene-not-submitted':'scientific-frame-preparing',
            recovery:analysisViewRecovery(targetRef)});
        if(view?.active&&view.available&&view.frameReady&&view.capture&&!view.workspaceCapture){
          const blob=await view.capture(options,signal);
          return {ownerId:target.ownerId,resultId:view.result.id,source:view.result.source,jobIndex:view.result.jobIndex,frameIndex:view.frameIndex,scene:receipt.scene,options,
            ...await deliverAsset(blob,`Ester-Studio-viewport.${format}`,args,call)};
        }
        if(!ctx.captureViewport||view&&!view.capture&&!view.workspaceCapture)throw toolError('viewport_unavailable','This source exposes no native viewport capture.',{...context,reason:'no-capture-port'});
        const {blob,provenance}=await ctx.captureViewport(args.targetRef===undefined?undefined:field(args,'targetRef'),options,signal);
        return {ownerId:target.ownerId,...provenance,options,...await deliverAsset(blob,`Ester-Studio-viewport.${format}`,args,call)};
      }},
  ];
}
