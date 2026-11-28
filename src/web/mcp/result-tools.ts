import {flushSync} from 'react-dom';
import type {Structure} from '../../core/types';
import type {ResultDiagnostic,TrajectoryResult} from '../../results/contracts';
import type {PostprocessDocument,PostprocessScientificFileDocument} from '../../results/postprocess-document';
import {projectPostprocessFrame} from '../../results/postprocess-document';
import {postprocessFileJob} from '../../results/postprocess-sources';
import {attachTrajectoryStages} from '../../results/trajectory-stages';
import {plotFonts,type PlotFontStyle,type PlotPointStyle,type PlotPosition,type PlotSeriesStyle,type PlotStroke,type PlotStyle} from '../../results/scientific-plot-editing';
import {ANALYSIS_TITLES} from '../results/analysis-workspace';
import type {AnalysisPage} from '../results/PostprocessDisplayPanel';
import {createPostprocessPlotSnapshot,postprocessScfState,type PostprocessPlotSnapshot} from '../results/PostprocessPresentation';
import type {createResultsMcpRegistry,PlotEdit,PlotExportFormat,ResultStageIdentity,ResultViewPort} from '../results/results-mcp-context';
import type {ViewportImageExportOptions} from '../results/export-image';
import {createFilePathPlotSnapshot,type FilePathPlotSnapshot} from '../results/file-path-plot';
import {objectSchema,toolError,type McCall,type McTool} from './types';
import {mcpBridge} from './bridge';
import {stageOriginalAnalysisFile,stageSavedCube,stageScientificText} from '../results/export-saved-cube';
import {isMultiwfnBackendFailure} from '../results/multiwfn-errors';
import {originalMolden,originalMoldenId,printedTransitionAsset,printedTransitionGroups,printedTransitionsId} from './result-source-assets';
import {completedScan,fileTermination,jobEvidence,pngImageSize,scanReceipt} from './result-receipts';

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

function analysisFrameIdentity(view:ResultViewPort|undefined) {
  if(!view)return undefined;
  const {analysisKey,result,frameIndex,stage}=view;
  return JSON.stringify([analysisKey,result.id,result.source.id,result.source.sha256,result.jobIndex,stage,
    frameIndex,result.frames[frameIndex]?.sourceFrameIndex]);
}

function scanAxisState(port:{configuration?:Record<string,{read():unknown}>}) {
  return port.configuration?.['scan-axis']?.read() as {requestedAxis:string;effectiveAxis:string;
    sourceState:'ready'|'preparing'|'unavailable';axisLabel:string;axisUnit?:string;availableAxes:string[]}|undefined;
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
  const target=ownerTarget.file&&jobId?ctx.getResult(JSON.stringify(['es-file-job',ownerId,jobId])):ownerTarget;
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
const plotEdits=['text','font','insert-text','edit-text','remove-text','move-figure','axis-range','axis-step','axes-style',
  'series-style','point-style','legend','add-guide','edit-guide','remove-guide','undo','redo'] as const;
const plotKinds=['scf','levels','file-path','scan-energy','uv-vis','pes-path-energy','interaction-scatter','hirshfeld-fingerprint','surface-distribution','conformer-energy'] as const;
const oneOf=(values:readonly string[])=>({type:'string',enum:[...values]});
const color={type:'string',pattern:'^#[0-9a-fA-F]{6}$'};
const numberFrom=(minimum:number,maximum?:number)=>({type:'number',minimum,
  ...(maximum!==undefined&&Number.isFinite(maximum)?{maximum}:{})});
const directions=oneOf(['off','in','out','both']);
const side=objectSchema({direction:directions,labels:bool},['direction','labels']);
const finiteNumber={type:'number'};
const nullable=(value:Record<string,unknown>)=>({anyOf:[value,{type:'null'}]});
const position=objectSchema({x:finiteNumber,y:finiteNumber},['x','y']);
const viewportCrop=objectSchema({
  x:numberFrom(0,1),y:numberFrom(0,1),
  width:{type:'number',exclusiveMinimum:0,maximum:1},height:{type:'number',exclusiveMinimum:0,maximum:1},
},['x','y','width','height']);
const dash=oneOf(['solid','dash','dot','dash-dot']);
const guideStroke={color,width:numberFrom(.1),dash};
const plotReadRecovery=(plotId?:string)=>({tool:'plot_read',arguments:plotId?{plotId}:{}});
function insetLimits(value:unknown):[number,number]|undefined{
  if(!Array.isArray(value)||value.length!==2||!value.every(Number.isFinite)||value[0]===value[1])return undefined;
  return [Math.min(value[0],value[1]),Math.max(value[0],value[1])];
}
function plotSettingsSchema(scope:string,schema:Record<string,unknown>){
  if(scope!=='inset')return schema;
  const properties=schema.properties as {action?:{enum?:string[]};range?:Record<string,unknown>}|undefined;
  if(!properties?.action?.enum?.includes('create')||!properties.range)return schema;
  return objectSchema({action:properties.action,range:{...properties.range,
    description:'Two ascending limits per axis in displayed units, including on reversed axes.'}},['action','range']);
}
const plotDeliveries=(plotId:string,formats:readonly PlotExportFormat[])=>formats.map(format=>({
  format,export:{tool:'plot_export',arguments:{plotId,format,save:true}},
}));
const plotPatches={
  font:objectSchema({font:oneOf(plotFonts),size:numberFrom(1),bold:bool,italic:bool}),
  'axes-style':objectSchema({color,width:numberFrom(.1),frame:oneOf(['full','axes']),density:oneOf(['sparse','standard','dense']),
    xMinor:{type:'integer',minimum:0,maximum:12},yMinor:{type:'integer',minimum:0,maximum:12},
    tickNumbers:objectSchema({x:oneOf(['auto','integer']),y:oneOf(['auto','integer'])}),
    tickSides:objectSchema({left:side,bottom:side,right:side,top:side})}),
  'series-style':objectSchema({color,width:numberFrom(0),dash,hidden:bool,points:bool,
    fill:oneOf(['none','solid','gradient']),opacity:numberFrom(0,1),barFillColor:color,barGradient:objectSchema({base:color},['base'])}),
  'point-style':objectSchema({marker:oneOf(['circle','square','triangle','diamond','cross']),size:numberFrom(.1),
    hollow:bool,edgeColor:color,fillColor:color,edgeWidth:numberFrom(0)}),
  'edit-guide':objectSchema({...guideStroke,value:finiteNumber,label:nullable({type:'string'})}),
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
  const readPosition=():PlotPosition|null=>{
    validateValue(args.position,nullable(position),'position');
    return args.position as PlotPosition|null;
  };
  switch(operation){
    case 'undo':case 'redo':return {operation};
    case 'text':{
      if(typeof args.text!=='string')throw toolError('invalid_arguments','text must be a string.');
      return {operation,text:args.text,role:choice(args.role,['title','x','y'] as const,'role')};
    }
    case 'insert-text':{
      if(typeof args.text!=='string'||!args.text.length)throw toolError('invalid_arguments','Provide the text to insert.');
      return {operation,text:args.text,position:args.position===undefined?undefined:readPosition()??undefined};
    }
    case 'edit-text':{
      if(args.text!==undefined&&typeof args.text!=='string'||args.text===undefined&&args.position===undefined)
        throw toolError('invalid_arguments','Provide text or a position change.');
      return {operation,textId:field(args,'textId'),text:args.text as string|undefined,
        position:args.position===undefined?undefined:readPosition()};
    }
    case 'remove-text':return {operation,textId:field(args,'textId')};
    case 'move-figure':return {operation,position:readPosition()};
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
      const stroke=Object.fromEntries(Object.keys(guideStroke).flatMap(key=>args[key]===undefined?[]:[[key,args[key]]]));
      return {operation,axis:choice(args.axis,['x','y'] as const,'axis'),value:args.value,label:args.label as string|undefined,
        ...(Object.keys(stroke).length?{stroke:validatedPatch<Partial<PlotStroke>>(stroke,objectSchema(guideStroke))}:{})};
    }
    case 'remove-guide':return {operation,guideId:field(args,'guideId')};
    case 'edit-guide':return {operation,guideId:field(args,'guideId'),
      patch:validatedPatch<Partial<PlotStroke>&{value?:number;label?:string|null}>(args.patch,plotPatches[operation])};
  }
}

function resultSummary(result:TrajectoryResult|ResultDiagnostic) {
  const common={id:result.id,kind:result.kind,source:result.source,label:result.label,engine:result.engine,
    jobIndex:result.jobIndex,status:result.status,messages:result.messages};
  return result.kind==='diagnostic'
    ?{...common,segmentIndex:result.segmentIndex,jobAssociation:result.jobAssociation,sourceRole:result.sourceRole,charge:result.charge,multiplicity:result.multiplicity,frameCount:0}
    :{...common,role:result.role,frameCount:result.frames.length,stages:result.stages,recoveredComputation:result.recoveredComputation};
}

function retainedJobs(target:McpResultTarget) {
  const selected=target.result??(target.file?postprocessFileJob(target.file.output.source):undefined);
  return {selected,jobs:target.file?.output.source.jobs??target.postprocess?.output?.source.results??(selected?[selected]:[])};
}

function transitionSelector(args:Record<string,unknown>) {
  return {stageId:args.stageId===undefined?undefined:field(args,'stageId'),
    frameIndex:args.frameIndex===undefined?undefined:integer(args,'frameIndex')};
}

function resultRead(ctx:ResultToolsContext,args:Record<string,unknown>,call?:McCall) {
  if(args.frameRef!==undefined){
    const frameRef=field(args,'frameRef');
    if(args.targetRef!==undefined||args.jobId!==undefined||args.stageId!==undefined||args.frameIndex!==undefined||args.start!==undefined||args.count!==undefined||
      args.includeCoordinates!==undefined||args.part!==undefined&&args.part!=='structure')
      throw toolError('invalid_arguments','frameRef selects one exact structure and cannot be combined with other result or frame selectors.');
    if(!ctx.readFrame)throw toolError('frame_unavailable','The current window does not expose exact frame reading.');
    return ctx.readFrame(frameRef,call?.signal);
  }
  const requestedRef=args.targetRef===undefined?undefined:field(args,'targetRef');
  const target=ctx.getResult(requestedRef);
  const {selected,jobs}=retainedJobs(target);
  const jobId=args.jobId===undefined?undefined:field(args,'jobId');
  const result=jobId===undefined?selected:jobs.find(job=>job.id===jobId);
  if(jobId!==undefined&&!result)throw toolError('result_job_unavailable','The retained output has no job with that id.',
    {jobId,recovery:{tool:'result_read',arguments:{targetRef:requestedRef??target.ownerId,part:'jobs'}}});
  const view=result&&[...ctx.resultRegistry?.resultViews.values()??[]].find(row=>row.active&&row.ownerId===target.ownerId&&observesResult(row,result));
  const source=target.file?.output.source;
  const part=choice(args.part??'summary',['summary','jobs','frames','scientific','structure','diagnostics','assets','scan','transitions'] as const,'part');
  if(args.stageId!==undefined&&part!=='transitions')
    throw toolError('invalid_arguments','Use stageId with part=transitions for a stage-local frame index.');
  const nativeSelectedJobId=source?.selectedJobId??target.postprocess?.output?.source.result.id??selected?.id??null;
  if(part==='jobs')return {ownerId:target.ownerId,source:source?.identity??selected?.source,
    jobs:jobs.map(job=>({...resultSummary(job),evidence:jobEvidence(job)})),selectedJobId:nativeSelectedJobId,fileTermination:fileTermination(jobs)};
  if(part==='assets'){
    const molden=originalMolden(target,requestedRef);
    const frameIndex=args.frameIndex===undefined?undefined:integer(args,'frameIndex');
    const available=molden&&(frameIndex===undefined||molden.asset.provenance.frameIndex===frameIndex);
    const readTransitions=result?.scientific?.excitedStates.length
      ?{tool:'result_read',arguments:{targetRef:requestedRef??target.navigationRef??target.ownerId,part:'transitions',...(jobId?{jobId}:{})}}:undefined;
    return {ownerId:target.ownerId,resultId:result?.id,frameIndex,assets:available?[{...molden.asset,
      export:{tool:'analysis_export',arguments:molden.exportArguments}}]:[],
      ...(!available?{reason:molden?'wavefunction-bound-to-another-frame':'no-attributed-original-molden',
        boundFrameIndex:molden?.asset.provenance.frameIndex}:{}),...(readTransitions?{readTransitions}:{}),
    };
  }
  if(!result){
    if(source&&part==='summary')return {ownerId:target.ownerId,source:source.identity,selectedJobId:source.selectedJobId??null,
      jobCount:source.jobs.length,fileTermination:fileTermination(jobs)};
    throw toolError('result_unavailable','No selected result job is available for the requested data.');
  }
  const targetRef=target.navigationRef??requestedRef??target.ownerId;
  if(part==='transitions'){
    const groups=printedTransitionGroups(result,transitionSelector(args));
    return {ownerId:target.ownerId,targetRef,resultId:result.id,source:result.source,jobIndex:result.jobIndex,
      groups:groups.map(group=>{
        const asset=printedTransitionAsset(result,targetRef,group,jobId);
        const openPlot=group.frameIndex!==null&&group.states.some(state=>Number.isFinite(state.oscillatorStrength))?
          {tool:'plot_open',arguments:{kind:'uv-vis',targetRef,...(jobId?{jobId}:{}),...transitionSelector(args),frameIndex:group.frameIndex,sourceId:result.source.id}}:undefined;
        return {frameIndex:group.frameIndex,jobFrameIndex:group.jobFrameIndex,sourceFrameIndex:group.sourceFrameIndex,stageId:group.stageId,
          stateCount:group.states.length,states:group.states.map(({transitions,...state})=>({...state,transitionCount:transitions.length})),
          asset:{...asset.asset,export:{tool:'analysis_export',arguments:asset.exportArguments}},...(openPlot?{openPlot}:{})};
      })};
  }
  const scan=result.kind==='diagnostic'?undefined:completedScan(result);
  const scanTarget={targetRef,...(jobId?{jobId}:{})};
  const summary={ownerId:target.ownerId,...resultSummary(result),fileTermination:fileTermination(jobs),termination:jobEvidence(result).termination,
    ...(result.scientific?.excitedStates.length?{readTransitions:{tool:'result_read',arguments:{targetRef,...(jobId?{jobId}:{}),part:'transitions'}}}:{}),
    ...(scan?{scan:{stageId:scan.stage.id,completedPointCount:scan.frames.length,
      next:{read:{tool:'result_read',arguments:{...scanTarget,part:'scan'}},plot:{tool:'plot_open',arguments:{...scanTarget,kind:'scan-energy'}}}}}:{}),
    displayedFrame:view?{index:view.frameIndex,resultId:view.result.id,sourceFrameIndex:view.result.frames[view.frameIndex]?.sourceFrameIndex??view.frameIndex,ready:view.frameReady}:null,
    wavefunction:target.postprocess?.wavefunction?.source.metadata?{
      sourceId:target.postprocess.wavefunction.source.metadata.sourceId,sourceRevision:target.postprocess.wavefunction.source.metadata.sourceRevision,
      format:target.postprocess.wavefunction.source.metadata.format,
    }:undefined};
  if(part==='summary')return summary;
  if(part==='diagnostics')return {...summary,evidence:jobEvidence(result),jobs:jobs.map(jobEvidence),
    diagnostics:result.kind==='diagnostic'?[resultSummary(result)]:result.fileDiagnostics??[]};
  if(part==='scan'){
    if(result.kind==='diagnostic'||!scan&&!result.scientific?.tasks.includes('scan'))
      throw toolError('scan_unavailable','The selected source job has no native scan.',{targetRef,jobId,source:result.source});
    if(args.includeCoordinates!==undefined&&typeof args.includeCoordinates!=='boolean')
      throw toolError('invalid_arguments','includeCoordinates must be a boolean.');
    return scanReceipt(result,{start:integer(args,'start',0),count:integer(args,'count',50,1),coordinates:args.includeCoordinates===true,signal:call?.signal})
      .then(receipt=>({ownerId:target.ownerId,source:result.source,fileTermination:fileTermination(jobs),...receipt,
        ...(scan?{next:{tool:'plot_open',arguments:{...scanTarget,kind:'scan-energy'}}}:{})}));
  }
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
  const imageSize=mimeType==='image/png'?pngImageSize(bytes):undefined;
  const imageMetadata=imageSize?{imageSize}:{};
  const save=savesAsset(args);
  if(!save&&args.preview!==true)return {...encodedAsset(bytes,mimeType,filename),...imageMetadata};
  const imagePreview=args.preview===true?encodedAsset(bytes,mimeType,filename):undefined;
  const meta={filename,mimeType,byteLength:bytes.length,...imageMetadata,...(imagePreview?{imagePreview}:{})};
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

export function resultTools(ctx:ResultToolsContext,showCollection?:(ref:string,call?:McCall)=>Promise<unknown>):McTool[] {
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
  const retainedPlotRecipe=(id:string)=>{
    const retired=ctx.resultRegistry?.retiredPlots.get(id)??ctx.resultRegistry?.plots.get(id);
    if(!retired?.inline||!retired.ownerId||!retired.source)return;
    const {ownerId,kind,collectionId,stageId,frameIndex,jobId}=retired;
    if(kind==='pes-path-energy'&&collectionId)
      return {tool:'plot_open',arguments:{kind,targetRef:JSON.stringify(['es-pes-record-v1',ownerId,collectionId])}};
    if(kind!=='scan-energy'&&kind!=='uv-vis')return;
    const targetRef=(retired.analysisId?knownPanels.get(retired.analysisId)?.targetRef:undefined)??ownerId;
    return {tool:'plot_open',arguments:{kind,targetRef,...(jobId?{jobId}:{}),sourceId:retired.source.id,
      ...(kind==='uv-vis'?{stageId,frameIndex}:{})}};
  };
  const plot=(id:string)=>{
    const entry=ctx.resultRegistry?.plots.get(id);
    if(!entry)throw toolError('plot_unavailable','The figure has no mounted, editable chart in this project window.',
      {plotId:id,recovery:retainedPlotRecipe(id)??plotReadRecovery()});
    return entry;
  };
  const plotSources=()=>[...ctx.resultRegistry?.plotSources.values()??[]].map(({open,...entry})=>({
    ...entry,available:!!open,recovery:open?{tool:'plot_open',arguments:{kind:entry.kind,targetRef:entry.targetRef}}:undefined,
  }));
  const plotSummary=(id:string,metadata=false)=>{
    const {port,display,figureIdentity:_identity,configurationIdentity:_configuration,...entry}=plot(id),{metadata:sourceMetadata,...read}=port.read();
    const configuration=port.configuration&&Object.fromEntries(Object.entries(port.configuration).map(([scope,settings])=>
      [scope,{schema:plotSettingsSchema(scope,settings.schema),settings:settings.read()}]));
    const windowActions=display?['show',...(display.minimize?['minimize']:[]),...(display.close?['close']:[]),...(display.setLayout?['layout']:[])]:[];
    return {plotId:id,...entry,...read,configuration,exports:plotDeliveries(id,read.formats),reopen:retainedPlotRecipe(id),
      visible:display?.visible&&(port.isVisible?.()??true),active:display?.active,layout:display?.layout,
      windowActions,capabilities:{editOperations:read.edits??[],parts:read.parts??['main'],byPart:read.partCapabilities,
        configurationScopes:Object.keys(configuration??{}),formats:read.formats,windowActions,
        pointActions:port.point?['read',...(port.canSelectPoint?['select']:[])]:[]},...(metadata?{metadata:sourceMetadata}:{})};
  };
  const assertPlotRevision=(id:string,args:Record<string,unknown>)=>{
    const entry=plot(id),supplied=integer(args,'revision');
    if(supplied!==entry.revision)throw toolError('revision_conflict','The plotted figure changed. Read the current figure before editing it.',{plotId:id,revision:entry.revision,recovery:plotReadRecovery(id)});
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
  const panelAssets=(analysisId:string,runner:NonNullable<ReturnType<NonNullable<ResultToolsContext['resultRegistry']>['runs']['get']>>)=>{
    const sourceRevision=analysisRevision(analysisId,runner.sourceRevision);
    return runner.assets?.().map(({info})=>({...info,export:{tool:'analysis_export',arguments:{analysisId,sourceRevision,assetId:info.id}}}))??[];
  };
  const openUvVis=async(args:Record<string,unknown>,call?:McCall)=>{
    if(args.reference!==undefined||args.analysisId!==undefined||args.sourceRevision!==undefined||args.reuse===false)
      throw toolError('invalid_arguments','Open the native UV-vis chart using its exact result job and geometry.');
    const requestedRef=field(args,'targetRef'),{target}=targetView(args);
    const jobId=args.jobId===undefined?undefined:field(args,'jobId');
    const selector=transitionSelector(args);
    const {jobs,selected}=retainedJobs(target);
    const result=jobId===undefined?selected:jobs.find(job=>job.id===jobId)??(selected?.id===jobId?selected:undefined);
    const readTransitions={tool:'result_read',arguments:{targetRef:requestedRef,...(jobId?{jobId}:{}),...selector,part:'transitions'}};
    if(!result||result.kind==='diagnostic'||args.sourceId!==undefined&&field(args,'sourceId')!==result.source.id)
      throw toolError('plot_source_unavailable','The requested native job has no attributed UV-vis geometry.',{targetRef:requestedRef,jobId,recovery:readTransitions});
    const groups=printedTransitionGroups(result,selector).filter(group=>group.jobFrameIndex!==null&&group.states.some(state=>Number.isFinite(state.oscillatorStrength)));
    if(groups.length!==1)throw toolError('plot_data_unavailable',groups.length?'Select one printed transition frame from the result data.':
      'This job and frame have no printed oscillator strengths for a native UV-vis chart.',{targetRef:requestedRef,jobId,recovery:readTransitions});
    const group=groups[0],expectedFrame=result.frames[group.jobFrameIndex!];
    const referenceForFile=target.file&&jobId?JSON.stringify(['es-file-job',target.ownerId,jobId]):undefined;
    const targetRef=referenceForFile??target.navigationRef??requestedRef;
    const waitMs=integer(args,'waitMs',4000);
    if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
    const started=performance.now(),remaining=()=>Math.max(0,waitMs-(performance.now()-started));
    const sameOwner=(view:ResultViewPort)=>view.ownerId===target.ownerId&&view.active&&view.available&&
      view.result.source.id===result.source.id&&view.result.source.sha256===result.source.sha256;
    const activeView=()=>[...ctx.resultRegistry?.resultViews.values()??[]].find(sameOwner);
    if(!activeView()||referenceForFile&&activeView()?.result.jobIndex!==result.jobIndex)
      await reveal({...target,navigationRef:targetRef});
    const resolved=ctx.getResult(targetRef);
    if(resolved.ownerId!==target.ownerId)throw toolError('plot_source_changed','The retained scientific owner changed.',{targetRef,recovery:readTransitions});
    const root=resolved.postprocess?.result??resolved.result;
    const projectedBase=root?.source.id===result.source.id&&root.jobIndex===result.jobIndex?root.id:result.id;
    const openArguments={kind:'uv-vis',targetRef,...(jobId?{jobId}:{}),...selector,frameIndex:group.frameIndex,sourceId:result.source.id};
    const pending={kind:'uv-vis',status:'plot_preparing',targetRef,source:result.source,sourceFrameIndex:group.sourceFrameIndex,
      recovery:{tool:'plot_open',arguments:openArguments}};
    const opened=await waitForView(ctx.resultRegistry,activeView,remaining(),call?.signal);
    if(!opened)return pending;
    const nativeIndex=(view:ResultViewPort)=>view.result.frames.findIndex(frame=>(frame.sourceFrameIndex??frame.index)===group.sourceFrameIndex&&
      (!expectedFrame||frame.sourceLine===expectedFrame.sourceLine));
    const stages=attachTrajectoryStages(result).stages?.filter(stage=>stage.frameIndices.includes(group.jobFrameIndex!))??[];
    const stageId=selector.stageId??(opened.result.jobIndex===result.jobIndex&&nativeIndex(opened)>=0?opened.stage?.stageId:undefined)
      ??(stages.length===1?stages[0].id:undefined);
    const exactView=()=>[...ctx.resultRegistry?.resultViews.values()??[]].find(view=>sameOwner(view)&&view.result.jobIndex===result.jobIndex&&
      (!stageId||view.stage?.stageId===stageId||view.result.id===`${projectedBase}:stage:${stageId}`)&&nativeIndex(view)>=0);
    if(!exactView()){
      if(!stageId||!flushSync(()=>opened.revealPlotStage?.({resultId:`${projectedBase}:stage:${stageId}`,source:result.source,jobIndex:result.jobIndex})))
        throw toolError('plot_source_unavailable','The native workbench has no confirmed route to this printed transition stage.',
          {targetRef,stageId,stages,recovery:readTransitions});
    }
    const view=await waitForView(ctx.resultRegistry,exactView,remaining(),call?.signal);
    if(!view)return {...pending,stageId};
    const index=nativeIndex(view);
    if(index!==view.frameIndex){
      if(!view.seekFrame)throw toolError('plot_frame_unavailable','Select the exact scientific frame in its native trajectory.',
        {targetRef,stageId,sourceFrameIndex:group.sourceFrameIndex,recovery:readTransitions});
      flushSync(()=>view.seekFrame!(index));
    }
    const frameView=()=>{const current=exactView();return current&&current.frameIndex===nativeIndex(current)?current:undefined;};
    const panel=await waitForView(ctx.resultRegistry,()=>{const current=frameView();const owner=current&&ctx.resultRegistry?.analysisViews.get(current.analysisKey);
      return owner?.read().active?owner:undefined;},remaining(),call?.signal);
    if(!panel)return {...pending,stageId};
    if(!panel.read().availablePages.includes('excited'))
      throw toolError('plot_data_unavailable','The exact retained geometry does not expose a native excited-state panel.',{targetRef,stageId,recovery:readTransitions});
    const panelId=flushSync(()=>panel.open('excited'));
    if(panelId)knownPanels.set(panelId,{targetRef,page:'excited'});
    const entry=await waitForView(ctx.resultRegistry,()=>{
      const current=frameView();
      if(!current)return;
      return [...ctx.resultRegistry?.plots.values()??[]].find(plot=>plot.kind==='uv-vis'&&plot.analysisId===panelId&&plot.display?.active&&
        plot.resultId===current.result.id&&plot.frameIndex===current.frameIndex&&plot.ownerId===target.ownerId&&plot.source?.id===result.source.id);
    },remaining(),call?.signal);
    return entry?plotReceipt(entry.id,{kind:'uv-vis',targetRef,stageId,panelId,frameIndex:entry.frameIndex,sourceFrameIndex:group.sourceFrameIndex,
      exports:plotDeliveries(entry.id,entry.port.read().formats),readTransitions}):{...pending,stageId,panelId};
  };
  const catalog:McTool[]=[
    {name:'result_read',description:'Read admitted results and native job evidence. part=transitions reads printed excited states grouped by their exact geometry and gives an independent original transition table export. Select a zero-based frameIndex within the job or named stageId. part=scan reads completed scan points; includeCoordinates=true measures a declared single coordinate. part=assets discovers original Molden. jobId from part=jobs selects a retained native segment.',
      inputSchema:objectSchema({targetRef:identifier,jobId:identifier,stageId:identifier,frameRef:identifier,
        part:oneOf(['summary','jobs','frames','scientific','structure','diagnostics','assets','scan','transitions']),
        includeCoordinates:bool,frameIndex:index,start:index,count:{...index,minimum:1}}),
      call:(args,call)=>resultRead(ctx,args,call)},
    {name:'analysis_view',description:'Read the native analysis workspace and select a page on the exact owner. Read panelStatus and methodStatus before submitting. For PES Hessian frequencies use the original runId with es_run_read, then inspect hessian.modes. For XTB2 charges use page="charges". Copy analysisId and sourceRevision to analysis actions. For a Raman Stokes plot, open vibrations and follow the vibration_view recipe to apply laser and temperature.',
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
        let runner=runnerNow;
        if(updated.active&&runnerNow?.methodStatus==='preparing'){
          const capturedFrame=analysisFrameIdentity(view);
          const stillCurrent=()=>{
            const current=activeAnalysis(target,true);
            return current&&current.owner.read().state.activeId===panelId&&analysisFrameIdentity(current.view)===capturedFrame?current:undefined;
          };
          await waitForView(ctx.resultRegistry,()=>!stillCurrent()||readRunner()?.methodStatus!=='preparing'?true:undefined,
            Math.max(0,waitMs-(performance.now()-started)),call?.signal);
          const current=stillCurrent();
          if(!current)return {...identity,panelId,analysisId,status:'analysis_view_inactive',panelStatus:'inactive',
            ...viewReceipt(viewFor(target)),recovery:analysisViewRecovery(targetRef,selectedPage)};
          ready=current;
          runner=readRunner();
        }
        const methodStatus=runner?.methodStatus??(runner?.methods.length?'ready':'unavailable');
        const analysis=runner?.read();
        const nativeError=(analysis as {error?:string} | undefined)?.error;
        const diagnostic=typeof nativeError==='string'&&isMultiwfnBackendFailure(nativeError)?{tool:'multiwfn_configure',arguments:{}}:undefined;
        const plots=analysisId?[...ctx.resultRegistry?.plots.values()??[]].filter(row=>row.analysisId===analysisId&&row.kind).map(row=>({
          plotId:row.id,kind:row.kind,revision:row.revision,exports:plotDeliveries(row.id,row.port.read().formats),
        })):[];
        const original=originalMolden(target,targetRef);
        const transitionsTarget=ready.view?.result??target.result;
        const result=target.result;
        const sourceFrame=ready.view?.result.frames[ready.view.frameIndex];
        const transitionsFrame=result&&sourceFrame&&transitionsTarget?.source.id===result.source.id&&
          transitionsTarget.jobIndex===result.jobIndex
          ?result.frames.findIndex(frame=>(frame.sourceFrameIndex??frame.index)===(sourceFrame.sourceFrameIndex??sourceFrame.index))
          :undefined;
        const readTransitions=selectedPage==='excited'&&result?.scientific?.excitedStates.length?
          {tool:'result_read',arguments:{targetRef,part:'transitions',...(transitionsFrame!==undefined&&transitionsFrame>=0?{frameIndex:transitionsFrame}:{})}}:undefined;
        return {...identity,...viewReceipt(ready.view),
          panelId,analysisId,...updated,panelStatus:updated.active?'ready':'inactive',methodStatus,plots,
          sourceAssets:original?[{...original.asset,export:{tool:'analysis_export',arguments:original.exportArguments}}]:[],
          ...(readTransitions?{readTransitions}:{}),
          ...(selectedPage==='vibrations'?{vibration:{tool:'vibration_view',arguments:{targetRef}}}:{}),
          recovery:diagnostic??(methodStatus==='preparing'||!updated.active?analysisViewRecovery(targetRef,selectedPage):undefined),
          ...(runner?{sourceRevision:analysisRevision(analysisId!,runner.sourceRevision),methods:runner.methods,analysis,execution:runner.execution?.(),
            plotKinds:[...new Set([...Object.keys(runner.plots?.()??{}),...plots.map(row=>row.kind)])],assets:panelAssets(analysisId!,runner),
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
        if(action==='status')return {analysisId,sourceRevision,execution:scope,assets:panelAssets(analysisId,runner)};
        const message='The analysis source or run changed. Read its current execution before stopping.';
        assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),message);
        if(args.requestId!==undefined&&field(args,'requestId')!==scope.requestId)throw toolError('revision_conflict',message,{analysisId,sourceRevision});
        if(!scope.stoppable||!runner.stop)return {analysisId,sourceRevision,status:'not_stoppable',execution:scope};
        flushSync(()=>{void runner.stop!();});
        const execution=ctx.resultRegistry?.runs.get(analysisId)?.execution?.();
        return {analysisId,sourceRevision,requestId:scope.requestId,status:'stop_requested',execution};
      }},
    {name:'analysis_export',description:'Save a native analysis asset, the original Molden on a result, or a printed transition table for a specific job/frame. Copy an asset.export.arguments from analysis_view, analysis_control, or result_read(part=transitions or assets). Add destination, directory or save=true. Panel sourceRevision belongs to the native panel; result assetRevision identifies the exact source asset.',
      inputSchema:objectSchema({analysisId:identifier,targetRef:identifier,jobId:identifier,stageId:identifier,frameIndex:index,
        sourceRevision:identifier,assetRevision:identifier,assetId:identifier,...exportDestination,onExists:oneOf(['error','overwrite'])},
        ['assetId']),call:async(args,call)=>{
        const assetId=field(args,'assetId');
        if(!savesAsset(args))throw toolError('invalid_arguments','Specify destination, directory, or save=true to save this analysis asset.');
        const destination=args.destination===undefined?undefined:field(args,'destination');
        if(args.onExists!==undefined)choice(args.onExists,['error','overwrite'] as const,'onExists');
        const bridge=typeof window==='undefined'?undefined:mcpBridge(),desktop=typeof window==='undefined'?undefined:window.sciyueDesktop;
        if(assetId===printedTransitionsId){
          if(args.analysisId!==undefined||args.sourceRevision!==undefined)
            throw toolError('invalid_arguments','Use the result targetRef and export arguments from result_read(part=transitions).');
          const targetRef=field(args,'targetRef'),jobId=args.jobId===undefined?undefined:field(args,'jobId'),selector=transitionSelector(args);
          const requestedRevision=args.assetRevision===undefined?undefined:field(args,'assetRevision');
          const recovery={tool:'result_read',arguments:{targetRef,...(jobId?{jobId}:{}),...selector,part:'transitions'}};
          const selectAsset=()=>{
            const target=ctx.getResult(targetRef),{jobs,selected}=retainedJobs(target);
            const result=jobId===undefined?selected:jobs.find(row=>row.id===jobId);
            if(!result)throw toolError('result_job_unavailable','Locate the exact retained job before exporting.',{targetRef,jobId,recovery});
            const groups=printedTransitionGroups(result,selector);
            const choices=groups.map(group=>printedTransitionAsset(result,targetRef,group,jobId));
            const source=requestedRevision?choices.find(choice=>choice.asset.assetRevision===requestedRevision):choices.length===1?choices[0]:undefined;
            if(!source)throw toolError(requestedRevision?'revision_conflict':'analysis_asset_unavailable',
              choices.length>1?'Select one exact printed transition group from result_read.':'No matching printed transition asset for this result selector.',
              {targetRef,jobId,assets:choices.map(choice=>choice.exportArguments),recovery});
            return source;
          };
          const source=selectAsset();
          if(destination&&!/\.txt$/i.test(destination))throw toolError('invalid_export_extension','Choose a .txt destination.');
          if(!bridge||!desktop||!call)throw toolError('file_port_unavailable','This session has no native analysis artifact writer.');
          const staged=await stageScientificText(source.text(),desktop,call.signal);
          let delivery,cleanupWarnings;
          try{
            call.signal.throwIfAborted();
            if(selectAsset().asset.assetRevision!==source.asset.assetRevision)
              throw toolError('revision_conflict','The transition source changed during export.',{targetRef,jobId,recovery});
            delivery=await bridge.file({action:'write-analysis',requestId:call.requestId,batchIndex:call.batchIndex,
              assetId:staged.file.id,fileName:source.asset.filename});
          }finally{cleanupWarnings=await staged.dispose();}
          return {asset:source.asset,representation:'printed-source-transitions',sha256:staged.file.sha256,bytes:staged.file.size,
            delivery,...(cleanupWarnings.length?{cleanupWarnings}:{})};
        }
        if(assetId===originalMoldenId){
          if(args.analysisId!==undefined||args.jobId!==undefined||args.stageId!==undefined)
            throw toolError('invalid_arguments','Use the exact result targetRef from the source asset for original Molden export.');
          const targetRef=field(args,'targetRef'),frameIndex=transitionSelector(args).frameIndex;
          const sourceRevision=args.sourceRevision===undefined?undefined:field(args,'sourceRevision');
          const assetRevision=args.assetRevision===undefined?undefined:field(args,'assetRevision');
          const recovery={tool:'result_read',arguments:{targetRef,part:'assets',frameIndex}};
          const assertCurrent=()=>{
            const source=originalMolden(ctx.getResult(targetRef),targetRef);
            if(!source||frameIndex!==undefined&&source.asset.provenance.frameIndex!==frameIndex)
              throw toolError('analysis_asset_unavailable','There is no attributed original Molden on the requested frame.',{targetRef,frameIndex,boundFrameIndex:source?.asset.provenance.frameIndex,recovery});
            if(sourceRevision!==undefined&&sourceRevision!==source.legacySourceRevision||assetRevision!==undefined&&assetRevision!==source.asset.assetRevision)
              throw toolError('revision_conflict','Use the original Molden assetRevision from the result asset, or omit it to export the currently bound original.',
                {targetRef,frameIndex,export:{tool:'analysis_export',arguments:source.exportArguments},recovery});
            return source;
          };
          const source=assertCurrent();
          if(destination&&!/\.molden(?:\.input)?$/i.test(destination))
            throw toolError('invalid_export_extension','Choose a .molden or .molden.input destination.');
          if(!bridge||!desktop||!call)throw toolError('file_port_unavailable','The current session has no native analysis artifact writer.');
          const staged=await stageOriginalAnalysisFile({...source.original,readRange:(offset,length)=>source.original.readRange(offset,length,call.signal)},desktop,call.signal)
            .catch(cause=>{
              call.signal.throwIfAborted();
              throw toolError('original_source_unreadable',cause instanceof Error?cause.message:String(cause),{targetRef,frameIndex,asset:source.asset,recovery});
            });
          let published,cleanupWarnings;
          try{
            call.signal.throwIfAborted();
            if(assertCurrent().asset.assetRevision!==source.asset.assetRevision)
              throw toolError('revision_conflict','The original Molden result binding changed during export.',{targetRef,frameIndex,recovery});
            published=await bridge.file({action:'write-analysis',requestId:call.requestId,batchIndex:call.batchIndex,assetId:staged.file.id,fileName:source.asset.filename});
          }finally{cleanupWarnings=await staged.dispose();}
          return {asset:source.asset,sourceRevision:source.legacySourceRevision,assetRevision:source.asset.assetRevision,representation:'retained-original',sha256:staged.file.sha256,bytes:staged.file.size,
            delivery:published,...(cleanupWarnings.length?{cleanupWarnings}:{})};
        }
        if(args.targetRef!==undefined||args.frameIndex!==undefined||args.jobId!==undefined||args.stageId!==undefined||args.assetRevision!==undefined)
          throw toolError('invalid_arguments','Use the panel asset’s analysisId and sourceRevision, or a result source asset.');
        const analysisId=field(args,'analysisId');
        const runner=ctx.resultRegistry?.runs.get(analysisId);
        if(!runner)throw missingAnalysis(analysisId);
        const sourceRevision=assertAnalysisRevision(analysisId,runner.sourceRevision,field(args,'sourceRevision'),'The analysis source or asset changed. Read the current panel.');
        const asset=runner.assets?.().find(row=>row.info.id===assetId);
        if(!asset)throw toolError('analysis_asset_unavailable','The current analysis has no such admitted asset.',{analysisId,assetId,assets:panelAssets(analysisId,runner),recovery:panelRecovery(analysisId)});
        const suffix=destination?.split('.').at(-1)?.toLowerCase();
        if(destination&&(asset.kind==='cube'?suffix!=='cube'&&suffix!=='cub':suffix!==asset.info.filename.split('.').at(-1)))
          throw toolError('invalid_export_extension','The destination extension must match the selected scientific asset.');
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
    {name:'plot_open',description:'Show an existing native plot by plotId or use its exact scientific owner. uv-vis takes the exact geometry recipe returned by result_read(part=transitions). scan-energy opens the completed scan points and can select source or ordinal x axis. pes-path-energy uses a retained PES record reference.',
      inputSchema:objectSchema({targetRef:{...identifier,description:'Scientific source reference. For conformer-energy, use the stage collection plotTargetRef or targetRef from plot_read.availableSources.'},kind:oneOf(plotKinds),
        plotId:identifier,reuse:bool,jobId:identifier,stageId:identifier,sourceId:identifier,
        axis:oneOf(['source','ordinal']),waitMs:{...index,maximum:60000},frameIndex:index,
        reference:oneOf(['absolute','relative-to-ts']),analysisId:identifier,sourceRevision:identifier}),call:async(args,call)=>{
        if(args.plotId!==undefined){
          const id=field(args,'plotId');
          if(args.kind!==undefined||args.targetRef!==undefined||args.jobId!==undefined||args.stageId!==undefined||args.sourceId!==undefined||args.axis!==undefined||args.frameIndex!==undefined||args.analysisId!==undefined||args.reference!==undefined)
            throw toolError('invalid_arguments','Select an existing plotId or a scientific source for a plot.');
          return reopenPlot(id,call,args.waitMs);
        }
        const kind=choice(args.kind,plotKinds,'kind');
        if(args.axis!==undefined&&kind!=='scan-energy')throw toolError('invalid_arguments','axis selects the horizontal axis of a scan-energy figure.');
        if(kind==='uv-vis')return openUvVis(args,call);
        if(args.stageId!==undefined)throw toolError('invalid_arguments','stageId selects the exact geometry for a UV-vis figure.');
        if((args.jobId!==undefined||args.sourceId!==undefined)&&kind!=='scan-energy')
          throw toolError('invalid_arguments','Use targetRef for this plot kind. Native jobId and sourceId are for scan-energy or uv-vis.');
        if(kind==='pes-path-energy'){
          if(args.frameIndex!==undefined||args.analysisId!==undefined||args.sourceRevision!==undefined||args.reference!==undefined||args.reuse===false)
            throw toolError('invalid_arguments','Use one exact retained PES record targetRef to open its existing native chart.');
          const targetRef=field(args,'targetRef');
          let target:unknown;
          try{target=JSON.parse(targetRef);}catch{/* A native record reference is required below. */}
          if(!Array.isArray(target)||target.length!==3||target[0]!=='es-pes-record-v1'||
            typeof target[1]!=='string'||typeof target[2]!=='string'||!target[1]||!target[2])
            throw toolError('invalid_arguments','Use the PES record frameSelection.targetRef from es_run_frame_read.',{targetRef});
          const [,ownerId,recordId]=target;
          const matchingPlot=()=>[...ctx.resultRegistry?.plots.values()??[]].find(row=>row.kind===kind&&row.ownerId===ownerId&&
            row.collectionId===recordId&&row.display?.active&&(row.port.isVisible?.()??true));
          const selected=matchingPlot();
          const waitMs=integer(args,'waitMs',4000);
          if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
          const recovery={tool:'es_show',arguments:{target:{kind:'collection',ref:targetRef},waitFor:'selected'}};
          if(!selected&&!showCollection)throw toolError('plot_source_unavailable','This session has no native PES record navigation.',{targetRef,recordId,recovery});
          const nativeSelection=selected?undefined:await showCollection!(targetRef,call);
          const entry=selected??await waitForView(ctx.resultRegistry,matchingPlot,waitMs,call?.signal);
          return entry?plotReceipt(entry.id,{kind,targetRef,recordId,reused:Boolean(selected),exports:plotDeliveries(entry.id,entry.port.read().formats)}):
            {status:'plot_preparing',kind,targetRef,recordId,nativeSelection,recovery};
        }
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
        if(kind==='scan-energy'){
          if(args.frameIndex!==undefined||args.analysisId!==undefined||args.reference!==undefined||args.sourceRevision!==undefined)
            throw toolError('invalid_arguments','A scan-energy figure uses the completed-points stage of a source job, with no individual frame selector.');
          const jobId=args.jobId===undefined?undefined:field(args,'jobId');
          const axis=args.axis===undefined?undefined:choice(args.axis,['source','ordinal'] as const,'axis');
          const jobs=target.file?.output.source.jobs??target.postprocess?.output?.source.results;
          const result=jobId===undefined?target.result??(target.file?postprocessFileJob(target.file.output.source):undefined):jobs?.find(job=>job.id===jobId);
          const scan=result&&result.kind!=='diagnostic'?completedScan(result):undefined;
          const targetRef=target.file&&jobId?JSON.stringify(['es-file-job',target.ownerId,jobId]):
            target.navigationRef??(args.targetRef===undefined?target.ownerId:field(args,'targetRef'));
          const selectedSourceId=args.sourceId===undefined?undefined:field(args,'sourceId');
          const recovery={tool:'plot_open',arguments:{kind,targetRef,...(jobId?{jobId}:{}),...(axis?{axis}:{}),...(selectedSourceId?{sourceId:selectedSourceId}:{})}};
          if(selectedSourceId&&result?.source.id!==selectedSourceId)
            throw toolError('plot_source_changed','The retained scan source differs from the requested source id.',{targetRef,sourceId:selectedSourceId});
          if(!scan||!result||!scan.frames.some(frame=>frame.energy&&Number.isFinite(frame.energy.value)))
            throw toolError('plot_data_unavailable','The specified source job has no completed scan points with an available energy.',
              {targetRef,jobId,recovery:{tool:'result_read',arguments:{targetRef,part:'jobs'}}});
          if(args.reuse===false)throw toolError('plot_copy_unavailable','The native completed-points stage owns one editable energy figure.',{targetRef,jobId,recovery});
          const waitMs=integer(args,'waitMs',4000);
          if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
          const started=performance.now(),remaining=()=>Math.max(0,waitMs-(performance.now()-started));
          const originalOwner=target.ownerId;
          if(!prior?.active||!prior.available||targetRef!==target.navigationRef&&Boolean(target.file&&jobId))
            await reveal({...target,navigationRef:targetRef});
          const selected=ctx.getResult(targetRef);
          const matchesSource=(candidate:TrajectoryResult|ResultDiagnostic|undefined)=>candidate!==undefined&&candidate.jobIndex===result.jobIndex
            &&candidate.source.id===result.source.id&&candidate.source.sha256===result.source.sha256;
          const readonlySource=selected.postprocess?.result??selected.result;
          if(selected.ownerId!==originalOwner||!matchesSource(readonlySource))
            throw toolError('plot_source_changed','The native workbench did not select the requested scan job.',{targetRef,jobId,recovery});
          const stageResultId=`${readonlySource!.id}:stage:${scan.stage.id}`;
          const pending={status:'plot_preparing',kind,targetRef,jobId:jobId??result.id,stageId:scan.stage.id,stageResultId,
            completedPointCount:scan.frames.length,source:result.source,recovery};
          const activeView=()=>[...ctx.resultRegistry?.resultViews.values()??[]]
            .find(view=>view.ownerId===originalOwner&&view.active&&view.available&&matchesSource(view.result));
          const opened=await waitForView(ctx.resultRegistry,activeView,remaining(),call?.signal);
          if(!opened)return pending;
          if(opened.result.id!==stageResultId&&opened.stage?.stageId!==scan.stage.id&&
            !flushSync(()=>opened.revealPlotStage?.({resultId:stageResultId,source:result.source,jobIndex:result.jobIndex})))
            throw toolError('plot_source_unavailable','The owning native workbench exposes no route to the completed scan stage.',{targetRef,stageResultId,recovery});
          const stageOwner=await waitForView(ctx.resultRegistry,()=>{
            const view=activeView();
            return view&&(view.result.id===stageResultId||view.stage?.stageId===scan.stage.id)?ctx.resultRegistry?.analysisViews.get(view.analysisKey):undefined;
          },remaining(),call?.signal);
          if(!stageOwner?.read().active)return pending;
          if(!stageOwner.read().availablePages.includes('trajectory'))
            throw toolError('plot_data_unavailable','The completed scan stage has no native trajectory chart.',{targetRef,stageResultId,completedPointCount:scan.frames.length});
          const panelId=flushSync(()=>stageOwner.open('trajectory'));
          if(panelId)knownPanels.set(panelId,{targetRef,page:'trajectory'});
          const matchingPlot=()=>{
            const view=activeView();
            if(!view||view.result.id!==stageResultId&&view.stage?.stageId!==scan.stage.id)return;
            return [...ctx.resultRegistry?.plots.values()??[]].find(row=>row.ownerId===originalOwner&&row.resultId===view.result.id&&
              row.analysisId===panelId&&row.kind===kind&&row.display?.active&&row.source?.id===result.source.id&&
              row.source.sha256===result.source.sha256&&row.jobIndex===result.jobIndex);
          };
          let entry=await waitForView(ctx.resultRegistry,matchingPlot,remaining(),call?.signal);
          if(!entry)return {...pending,panelId};
          const unavailableAxis=(scanAxis:ReturnType<typeof scanAxisState>)=>toolError('plot_axis_unavailable',
            'The native scan cannot provide the requested horizontal axis.',
            {targetRef,axis,scanAxis,recovery:{tool:'plot_open',arguments:{kind,targetRef,...(jobId?{jobId}:{}),axis:'ordinal'}}});
          const currentAxis=scanAxisState(entry.port);
          if(axis){
            if(!currentAxis?.availableAxes.includes(axis))throw unavailableAxis(currentAxis);
            if(currentAxis.requestedAxis!==axis){
              const settings=entry.port.configuration!['scan-axis'];
              flushSync(()=>settings.apply({axis}));
            }
          }
          entry=await waitForView(ctx.resultRegistry,()=>{
            const live=matchingPlot();
            if(!live)return;
            const info=scanAxisState(live.port);
            return info&&(axis&&info.requestedAxis!==axis||info.requestedAxis==='source'&&info.sourceState==='preparing')?undefined:live;
          },remaining(),call?.signal);
          if(!entry)return {...pending,panelId,reason:'scan-axis-preparing'};
          const scanAxis=scanAxisState(entry.port);
          if(axis==='source'&&scanAxis?.effectiveAxis!=='source')throw unavailableAxis(scanAxis);
          return plotReceipt(entry.id,{kind,targetRef,jobId:jobId??result.id,stageId:scan.stage.id,panelId,completedPointCount:scan.frames.length,
            scanAxis,next:{tool:'plot_export',arguments:{plotId:entry.id,format:'txt',save:true}}});
        }
        if(kind==='file-path'){
          const reference=choice(args.reference??'absolute',['absolute','relative-to-ts'] as const,'reference');
          if(!target.file)throw toolError('plot_data_unavailable','The selected source is not a file job with printed IRC or NEB path energy.',
            target.result&&target.result.kind!=='diagnostic'&&completedScan(target.result)?{recovery:{tool:'plot_open',arguments:{
              kind:'scan-energy',targetRef:target.navigationRef??args.targetRef??target.ownerId}}}:undefined);
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
        const plots=[...ctx.resultRegistry?.plots.values()??[]].map(({port,id,kind,source,ownerId,resultId,jobId,jobIndex,frameIndex,revision,display,collectionId,runId,stageId,analysisId})=>{
          const {title,family,formats}=port.read();
          return {id,kind,source,ownerId,resultId,jobId,jobIndex,frameIndex,revision,collectionId,runId,stageId,analysisId,formats,
            visible:display?.visible&&(port.isVisible?.()??true),active:display?.active,title,family};
        });
        return {plots,sources,availableSources:sources.filter(source=>source.available),supportedOpenKinds:plotKinds};
      }},
    {name:'plot_point',description:'Read an exact native plotted sample or select its linked native object if plot_read advertises select. pointIndex is a zero-based index in the selected series.',
      inputSchema:objectSchema({plotId:identifier,revision:index,seriesId:identifier,pointIndex:index,action:oneOf(['read','select'])},
        ['plotId','revision','seriesId','pointIndex']),call:args=>{
        const plotId=field(args,'plotId'),port=assertPlotRevision(plotId,args);
        const seriesId=field(args,'seriesId'),pointIndex=integer(args,'pointIndex'),action=choice(args.action??'read',['read','select'] as const,'action');
        const details={plotId,seriesId,pointIndex,recovery:plotReadRecovery(plotId)};
        if(!port.point||action==='select'&&!port.canSelectPoint)
          throw toolError('plot_point_unavailable','This figure does not support that native point action.',details);
        if(action==='select'&&port.isVisible?.()===false)
          throw toolError('plot_inactive','Show the source figure before selecting a linked object.',{...details,recovery:{tool:'plot_open',arguments:{plotId}}});
        const point=flushSync(()=>port.point!(seriesId,pointIndex,action));
        if(point===undefined)throw toolError('plot_point_unavailable','The series has no eligible sample for this action at that index.',details);
        const entry=plot(plotId);
        return {plotId,seriesId,pointIndex,action,point,revision:entry.revision,source:entry.source,ownerId:entry.ownerId,
          resultId:entry.resultId,jobIndex:entry.jobIndex,frameIndex:entry.frameIndex,runId:entry.runId,collectionId:entry.collectionId,stageId:entry.stageId};
      }},
    {name:'plot_window',description:'Restore, minimize or close an existing native plot window, or change its native deck layout. minimize retains the figure for later show and project saving. close removes that figure from the current layout, so subsequent saves record it as closed. To verify saved editable state, use es_project action=reopen without closing the plot first.',
      inputSchema:objectSchema({plotId:identifier,action:oneOf(['show','minimize','close','layout']),mode:oneOf(['free','tiled']),arrange:bool},['plotId','action']),call:async(args,call)=>{
        const id=field(args,'plotId'),action=choice(args.action,['show','minimize','close','layout'] as const,'action');
        if(action==='show')return reopenPlot(id,call);
        const entry=plot(id);
        if(action==='layout'){
          const mode=choice(args.mode,['free','tiled'] as const,'mode');
          if(!entry.display?.setLayout)throw toolError('plot_lifecycle_unavailable','This figure has no independent native deck layout.',
            {plotId:id,recovery:plotReadRecovery(id)});
          if(!entry.display.eligible)throw toolError('plot_lifecycle_unavailable','Show a plot in its native deck before changing the layout.',
            {plotId:id,recovery:{tool:'plot_window',arguments:{plotId:id,action:'show'}}});
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
    {name:'plot_edit',description:'Edit the native figure using the current revision and capabilities.byPart from plot_read. Insert, move or edit free text, adjust existing guides, and move the plotted figure in paper coordinates where supported. Use plot_configure scope=inset to create an inset before positioning its box.',
      inputSchema:objectSchema({plotId:identifier,revision:index,operation:oneOf(plotEdits),part:oneOf(['main','inset']),role:{...oneOf(['title','x','y']),description:'Text role: title, x-axis label or y-axis label.'},text:{type:'string',description:'Literal displayed text. For operation=text, include the user’s exact capitalization and symbols.'},
        axis:oneOf(['x','y']),bounds:{anyOf:[{type:'array',items:{type:'number'},minItems:2,maxItems:2},{type:'null'}]},
        visible:bool,value:{type:'number'},label:{type:'string'},...guideStroke,guideId:identifier,
        textId:{...identifier,description:'An existing textId from plot_read for the selected part.'},seriesId:{...identifier,description:'An existing series ID from the selected part.'},pointIndex:index,
        position:{...nullable(position),description:'Fractional X and Y offsets relative to the plot paper, or null to restore the default position.'},
        step:{anyOf:[{type:'number',exclusiveMinimum:0},{type:'null'}]},patch:{anyOf:Object.values(plotPatches)}},['plotId','revision','operation']),call:args=>{
        const id=field(args,'plotId'),port=assertPlotRevision(id,args),change=plotEdit(args);
        const state=port.read();
        const part=args.part===undefined?undefined:choice(args.part,['main','inset'] as const,'part');
        const recovery=plotReadRecovery(id),configurationScopes=Object.keys(port.configuration??{});
        if(part==='inset'&&!state.parts?.includes('inset'))throw toolError('plot_part_unavailable',
          configurationScopes.includes('inset')?'Create an inset using plot_configure before editing that part.':'The current figure has no inset capability.',
          {plotId:id,parts:state.parts??['main'],configurationScopes,recovery});
        const capabilities=state.partCapabilities?.[part??'main'],edits=capabilities?.editOperations??state.edits??[];
        if(!edits.includes(change.operation))throw toolError('plot_edit_unavailable','The current chart does not support that edit.',{plotId:id,operation:change.operation,editOperations:edits,recovery:{tool:'plot_read',arguments:{plotId:id}}});
        if('textId' in change&&capabilities&&!capabilities.textIds.includes(change.textId))
          throw toolError('plot_text_unavailable','Choose a textId from the selected part.',{plotId:id,part:part??'main',textIds:capabilities.textIds,recovery});
        if(change.operation==='remove-text'&&capabilities?.removableTextIds&&!capabilities.removableTextIds.includes(change.textId))
          throw toolError('plot_text_unavailable','Choose a removableTextId from the selected part.',
            {plotId:id,part:part??'main',removableTextIds:capabilities.removableTextIds,recovery});
        if('guideId' in change&&capabilities?.guideIds&&!capabilities.guideIds.includes(change.guideId))
          throw toolError('plot_guide_unavailable','Choose a guideId from the selected part.',{plotId:id,part:part??'main',guideIds:capabilities.guideIds,recovery});
        if((change.operation==='series-style'||change.operation==='point-style')&&capabilities){
          const supported=capabilities.series.filter(series=>change.operation==='series-style'?series.lineStyle:series.pointStyle);
          if(!supported.some(series=>series.id===change.seriesId))throw toolError('plot_series_unavailable','The selected series does not support that style edit.',{plotId:id,part:part??'main',series:supported,recovery});
        }
        flushSync(()=>part?port.edit(change,part):port.edit(change));
        return plotSummary(id);
      }},
    {name:'plot_configure',description:'Change the same figure’s canvas, inset or specialized presentation controls using the live plot_read schema. For inset creation, first send only {action:"create",range:{x:[low,high],y:[low,high]}}; limits are ascending even on reversed axes. Use the returned revision to update the box or independent broadening after creation.',
      inputSchema:objectSchema({plotId:identifier,revision:index,scope:identifier,patch:{type:'object'}},['plotId','revision','scope','patch']),call:args=>{
        const id=field(args,'plotId'),port=assertPlotRevision(id,args),scope=field(args,'scope');
        const settings=port.configuration&&Object.hasOwn(port.configuration,scope)?port.configuration[scope]:undefined;
        if(!settings)throw toolError('plot_configuration_unavailable','This chart does not provide the requested settings.',{plotId:id,scope,configurationScopes:Object.keys(port.configuration??{}),recovery:plotReadRecovery(id)});
        const schema=plotSettingsSchema(scope,settings.schema);
        const requested=args.patch as {action?:unknown;range?:{x?:unknown;y?:unknown}}|undefined;
        if(requested?.action==='create'&&schema!==settings.schema){
          const x=insetLimits(requested.range?.x),y=insetLimits(requested.range?.y);
          const revision=integer(args,'revision');
          const axis=(settings.read() as {mainSettings?:{axis?:string}}|undefined)?.mainSettings?.axis;
          if(!x||!y||axis==='nm'&&x[0]<=0)
            throw toolError('invalid_arguments','Provide two distinct finite limits for each inset axis in the displayed units.',
              {plotId:id,scope,recovery:plotReadRecovery(id)});
          const recovery={tool:'plot_configure',arguments:{plotId:id,revision,scope,patch:{action:'create',range:{x,y}}}};
          if(Object.keys(requested).some(key=>key!=='action'&&key!=='range')||
            (requested.range?.x as number[])[0]!==x[0]||(requested.range?.y as number[])[0]!==y[0]){
            throw toolError('invalid_arguments','Create the inset with its ascending range alone. Update the box or broadening after it exists.',
              {plotId:id,scope,recovery});
          }
        }
        const patch=validatedPatch<Record<string,unknown>>(args.patch,schema);
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
    {name:'plot_export',description:'Export a named native figure as an image or scientific text. If a scan requests its native coordinate, wait for that coordinate before capture. Set destination, directory or save=true to write. For independent UV-vis transition tables, use result_read(part=transitions) then the returned analysis_export recipe.',
      inputSchema:objectSchema({plotId:identifier,format:oneOf(formats),waitMs:{...index,maximum:60000},...delivery},['plotId','format']),call:async(args,call)=>{
        const plotId=field(args,'plotId'),format:PlotExportFormat=choice(args.format,formats,'format');
        let entry=plot(plotId);
        checkImagePreview(args,format);
        if(!entry.port.read().formats.includes(format))throw toolError('format_unavailable','The figure does not export this format.');
        const waitMs=integer(args,'waitMs',4000);
        if(waitMs>60000)throw toolError('invalid_arguments','waitMs must be at most 60000.');
        const axis=scanAxisState(entry.port);
        if(entry.kind==='scan-energy'&&axis?.requestedAxis==='source'&&axis.sourceState==='preparing'){
          const prepared=await waitForView(ctx.resultRegistry,()=>{
            const current=ctx.resultRegistry?.plots.get(plotId);
            const state=current&&scanAxisState(current.port);
            return current&&state&&state.requestedAxis==='source'&&state.sourceState!=='preparing'?current:undefined;
          },waitMs,call?.signal);
          if(!prepared)throw toolError('plot_axis_preparing','The requested scan coordinate is not ready to export.',
            {plotId,scanAxis:axis,recovery:retainedPlotRecipe(plotId)??plotReadRecovery(plotId)});
          if(scanAxisState(prepared.port)?.effectiveAxis!=='source')
            throw toolError('plot_axis_unavailable','The native result could not provide the requested scan coordinate.',
              {plotId,scanAxis:scanAxisState(prepared.port),recovery:plotReadRecovery(plotId)});
          entry=prepared;
        }
        const {blob,filename}=await entry.port.export(format,call?.signal??new AbortController().signal);
        const current=ctx.resultRegistry?.plots.get(plotId);
        if(!current||current.revision!==entry.revision)throw toolError('revision_conflict','The figure changed during capture. Read its current revision before exporting again.',{plotId,revision:current?.revision,capturedRevision:entry.revision});
        return {plotId,revision:entry.revision,source:entry.source,ownerId:entry.ownerId,resultId:entry.resultId,
          collectionId:entry.collectionId,runId:entry.runId,stageId:entry.stageId,scanAxis:scanAxisState(entry.port),
          ...await deliverAsset(blob,filename,args,call)};
      }},
    {name:'view_export',description:'Capture the ready scientific viewport (default, PNG or SVG), the currently visible connected workbench (scope=workbench, PNG), or a visible docked native analysis panel (scope=analysis-panel, PNG, targetRef and panelId from analysis_view). Set destination, directory or save=true to write it. PNG preview returns the rendered image.',
      inputSchema:objectSchema({scope:oneOf(['viewport','workbench','analysis-panel']),targetRef:identifier,panelId:identifier,
        resultId:{...identifier,description:'Optional exact displayed result/stage from result_read.displayedFrame.'},
        frameIndex:{...index,description:'Optional zero-based frame from the named displayed result/stage.'},
        format:oneOf(['png','svg']),includeAnnotations:bool,transparent:bool,width:{...index,minimum:1},height:{...index,minimum:1},
        crop:{...viewportCrop,description:'Scientific viewport only. Fractional x/y/width/height from the top-left. Must remain within the viewport. width/height outside crop specify output dimensions.'},...delivery}),call:async(args,call)=>{
        const scope=choice(args.scope??'viewport',['viewport','workbench','analysis-panel'] as const,'scope');
        const format=choice(args.format??'png',['png','svg'] as const,'format');
        checkImagePreview(args,format);
        if(scope!=='viewport'){
          if(format!=='png'||['includeAnnotations','transparent','width','height','crop','resultId','frameIndex'].some(key=>args[key]!==undefined))
            throw toolError('invalid_arguments','Workbench and docked-panel captures use native PNG size and presentation.');
          if(scope==='workbench'&&(args.targetRef!==undefined||args.panelId!==undefined))
            throw toolError('invalid_arguments','Workbench capture selects the already bound window. Use analysis-panel to select a panel.');
          const targetRef=scope==='analysis-panel'?field(args,'targetRef'):undefined;
          const panelId=scope==='analysis-panel'?field(args,'panelId'):undefined;
          const capturePanel=()=>{
            const {target}=targetView({targetRef});
            const current=activeAnalysis(target,true),state=current?.owner.read().state;
            const panel=state?.instances.find(item=>item.id===panelId);
            const recovery=panel&&panel.detached?undefined:panel
              ?{tool:'analysis_panel',arguments:{targetRef,panelId,action:'activate'}}
              :analysisViewRecovery(targetRef!);
            const rect=panelId&&panel&&!panel.detached?current?.owner.captureBounds?.(panelId):undefined;
            if(!rect)throw toolError('analysis_panel_capture_unavailable',panel?.detached
              ?'The requested analysis is in a detached window. The connected workbench has no visible docked panel to capture.'
              :'The requested docked analysis panel is not visible in the connected workbench.',
            {targetRef,panelId,ownerId:target.ownerId,recovery});
            return {rect,ownerId:target.ownerId,resultId:current?.view?.result.id,stage:current?.view?.stage,frameIndex:current?.view?.frameIndex,
              source:current?.view?.result.source??target.result?.source,page:panel?.kind};
          };
          const panel=scope==='analysis-panel'?capturePanel():undefined;
          const bridge=typeof window==='undefined'?undefined:mcpBridge();
          if(!bridge||!call)throw toolError('workbench_capture_unavailable','This session has no native workbench capture.');
          const receipt=await bridge.file({action:'capture-workbench',requestId:call.requestId,batchIndex:call.batchIndex,
            ...(panel?{rect:panel.rect}:{})}) as {bytes?:Uint8Array;width:number;height:number};
          if(panel&&JSON.stringify(capturePanel())!==JSON.stringify(panel))
            throw toolError('revision_conflict','The analysis panel changed during native capture.',{targetRef,panelId,recovery:analysisViewRecovery(targetRef!,panel.page)});
          if(!(receipt.bytes instanceof Uint8Array)||!receipt.bytes.length)throw toolError('workbench_capture_unavailable','The native workbench returned no PNG.');
          const blob=new Blob([new Uint8Array(receipt.bytes)],{type:'image/png'});
          return {scope,targetRef,panelId,...panel,imageSize:{width:receipt.width,height:receipt.height},
            ...await deliverAsset(blob,`Ester-Studio-${scope}.png`,args,call)};
        }
        if(args.panelId!==undefined)throw toolError('invalid_arguments','Use scope=analysis-panel to select a panel.');
        const {target,view}=targetView(args);
        const requestedResult=args.resultId===undefined?undefined:field(args,'resultId');
        const requestedFrame=args.frameIndex===undefined?undefined:integer(args,'frameIndex');
        for(const key of ['transparent','includeAnnotations'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw toolError('invalid_arguments',`${key} must be a boolean.`);
        const crop=args.crop===undefined?undefined:validatedPatch<{x:number;y:number;width:number;height:number}>(args.crop,viewportCrop);
        if(crop&&(crop.x+crop.width>1||crop.y+crop.height>1))
          throw toolError('invalid_capture_region','The crop must fit the current scientific viewport.');
        const signal=call?.signal??new AbortController().signal,options:ViewportImageExportOptions={format,includeAnnotations:args.includeAnnotations!==false,transparent:args.transparent===true,
          width:args.width===undefined?undefined:integer(args,'width',undefined,1),height:args.height===undefined?undefined:integer(args,'height',undefined,1),...(crop?{crop}:{})};
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
            recovery});
        if(requestedResult!==undefined&&view?.result.id!==requestedResult||requestedFrame!==undefined&&view?.frameIndex!==requestedFrame)
          throw toolError('viewport_source_mismatch','The requested result stage or frame is not the one submitted to the visible viewport.',
            {...context,requestedResult,requestedFrame,recovery:{tool:'result_read',arguments:{targetRef}}});
        const assertStillDisplayed=()=>{
          if(!view)return;
          const current=viewFor(target);
          if(!current?.active||!current.available||JSON.stringify(viewReceipt(current))!==JSON.stringify(receipt))
            throw toolError('revision_conflict','The submitted viewport changed during capture.',{...context,recovery});
        };
        if(view?.active&&view.available&&view.frameReady&&view.capture&&!view.workspaceCapture){
          const blob=await view.capture(options,signal);
          assertStillDisplayed();
          return {ownerId:target.ownerId,resultId:view.result.id,source:view.result.source,jobIndex:view.result.jobIndex,frameIndex:view.frameIndex,scene:receipt.scene,options,
            ...await deliverAsset(blob,`Ester-Studio-viewport.${format}`,args,call)};
        }
        if(!ctx.captureViewport||view&&!view.capture&&!view.workspaceCapture)throw toolError('viewport_unavailable','This source exposes no native viewport capture.',{...context,reason:'no-capture-port'});
        const {blob,provenance}=await ctx.captureViewport(args.targetRef===undefined?undefined:field(args,'targetRef'),options,signal);
        assertStillDisplayed();
        return {ownerId:target.ownerId,...provenance,options,...await deliverAsset(blob,`Ester-Studio-viewport.${format}`,args,call)};
      }},
  ];
  function reopenPlot(id:string,call?:McCall,waitMs?:unknown){
    if(ctx.resultRegistry?.plots.has(id))return showNativeResultPlot(ctx,id,call?.signal);
    const recovery=retainedPlotRecipe(id);
    if(!recovery)return plot(id);
    return catalog.find(tool=>tool.name==='plot_open')!.call({...recovery.arguments,...(waitMs===undefined?{}:{waitMs})},call);
  }
  return catalog;
}
