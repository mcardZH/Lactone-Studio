import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import { prepareAdvancedFrameInputs, type AdvancedInputTemplate } from '../../modeling/application/advanced-frame-output';
import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';
import { defaultFiles, defaultSettings, methodDefaults } from '../../core/gaussian';
import { defaultAdvanced } from '../../core/advanced';
import { defaultMixedBasis } from '../../core/mixed-basis';
import { defaultTaskOptions } from '../../core/tasks';
import { createOrcaCommonSettings, ORCA_VERSIONS, type OrcaSettings } from '../../core/orca';
import { transitionGaussianBasis } from '../../modeling/application/gaussian-basis-transition';
import { launchSourceFile, type LaunchImportBridge, type LaunchSourceDescriptor } from '../../modeling/platform/launch-import';
import { orcaAssetUploadKind, readOrcaAsset } from '../orca/OrcaAssets';
import type { GaussianSettings, TaskId } from '../../core/types';
import { liveInputFor, type InputDraftConfiguration, type InputDraftView, type InputEndpointBindings, type InputOrcaAssetEdit, type InputScanRow, type InputSettingsPatch, type LiveInputPort } from './input-drafts';
import { boolean, choice, expectedDraft, frameInputConfigurationSchema, inputConfigurationSchema, inputTool, integer, list, mergeInputPatch, modelRef, numeric, object, positive, readInputConfiguration, solvation, string, type Schema } from './input-arguments';
import { presentationFields, presentationMode, toolError, type McCall, type McpPresentationMode, type McTool } from './types';
import { mcpBridge } from './bridge';
import { jobTools } from './job-tools';
import { inputSettingsTools } from './input-settings-tools';
import { canSelectOrcaHessian, gaussianParameterDraftPatch, hessianSelectionError, orcaParameterDraftPatch } from './input-specialized';
import { inputSolventEdit, inputSolventIssue, inputSolventOptions, prepareInputSolventWrite, readInputSolvent } from './input-solvents';
import { applyGaussianField, changedGaussianConditions } from '../application/gaussian-input-fields';

export interface InputToolsContext {
  entry(modelRef?: string): WorkspaceDocumentEntry;
  presentInput?(id:string,mode:McpPresentationMode,call?:McCall):unknown|Promise<unknown>;
  frame(frameRef?: string, signal?:AbortSignal, electronic?:{charge:number;multiplicity:number}): Promise<AdvancedFrameSource>;
  currentFrame?(targetId:string):{frameRef:string;targetId:string;collectionId?:string|null}|null;
  projectId(): string | null;
  projectScope?(): string | number | null;
  openJobSnapshot?(taskId:string,snapshotId:string,leaseId:string,canNavigate:()=>boolean):Promise<{documentId:string;sourceId:string;taskId:string;runId:string|null}|undefined>;
}

const replacement = { ...boolean, description: 'Explicitly replace generated text with hand edits when the native editor would confirm.' };
const sourceFields = { modelRef, expectedDraft };
const inputPresentation = { ...string, ...presentationFields.presentation };
const deliveryFields={fileName:string,destination:string,directory:string,onExists:choice('error','overwrite')};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function assertDraftVersion(view:InputDraftView, expected:unknown){
  if(expected!==undefined&&view.draftVersion!==expected)throw toolError('DRAFT_CONFLICT','输入草稿有新变化，请重新读取后重试。',{
    modelRef:view.documentId,draftVersion:view.draftVersion,recovery:{tool:'input_draft',arguments:{modelRef:view.documentId}}
  });
}

type InputOutput={name:string;text:string}|{name:string;file:File};
type InputSaveReceipt={name:string;status:string;path?:string;bytes?:number;sha256?:string;reason?:string;code?:string;data?:unknown;receipt?:unknown};

function inputSaveFailure(name:string,error:unknown):InputSaveReceipt{
  const detail=error as {code?:string;data?:unknown}|null;
  return {name,status:'failed',reason:errorMessage(error),
    ...(detail?.code===undefined?{}:{code:detail.code}),...(detail?.data===undefined?{}:{data:detail.data})};
}

async function saveFiles(files:InputOutput[],args:Record<string,unknown>,context?:McCall,group?:string){
  const bridge=mcpBridge();
  const receipts:InputSaveReceipt[]=[];
  if(!files.length)return receipts;
  try{
    if(!context||!bridge)throw Error('当前 MCP 会话不能写入桌面文件。');
    context.signal.throwIfAborted();
    const scope={requestId:context.requestId,...(context.batchIndex===undefined?{}:{batchIndex:context.batchIndex}),...(group===undefined?{}:{group})};
    if(args.destination===undefined&&args.directory===undefined&&files.length>1)
      await bridge.file({...scope,action:'export-group',names:files.map(file=>file.name)});
    for(const file of files){
      try{
        context.signal.throwIfAborted();
        const bytes='text' in file?new TextEncoder().encode(file.text):new Uint8Array(await file.file.arrayBuffer());
        context.signal.throwIfAborted();
        const receipt=await bridge.file({...scope,action:'write',bytes,...(args.destination===undefined?{name:file.name}:{})});
        const identity=receipt as {status?:string;path?:string;bytes?:number;sha256?:string}|null;
        const status=identity?.status==='publication_unconfirmed'?'publication_unconfirmed':'saved';
        receipts.push({name:file.name,status,path:identity?.path,bytes:identity?.bytes,sha256:identity?.sha256,receipt});
      }catch(error){receipts.push(inputSaveFailure(file.name,error));}
    }
  }catch(error){return files.map(file=>inputSaveFailure(file.name,error));}
  return receipts;
}

async function saveGenerated(editor:LiveInputPort,view:InputDraftView,args:Record<string,unknown>,context?:McCall,includeCompanions=false){
  const binary=editor.binaryOutputs(view.draftVersion);
  const outputs=[...view.files,...binary];
  const selected=args.fileName===undefined?undefined:view.files.find(file=>file.name===args.fileName&&file.role==='input');
  const files=args.fileName===undefined?outputs:
    includeCompanions&&selected&&args.destination===undefined
      ?[selected,...view.files.filter(file=>file.role!=='input'),...binary]
      :outputs.filter(file=>file.name===args.fileName);
  if(!files.length||args.destination&&files.length!==1)throw Error('请指定当前编辑器中唯一的输出文件。');
  return saveFiles(files,args,context);
}

function sameDraftContents(before:InputDraftView,after:InputDraftView){
  if(before.documentId!==after.documentId||before.documentRevision!==after.documentRevision||before.engine!==after.engine||before.stale!==after.stale)return false;
  return JSON.stringify([before.configuration,before.parameters,before.files,before.editedFiles,before.issues])===
    JSON.stringify([after.configuration,after.parameters,after.files,after.editedFiles,after.issues]);
}

function settledDraft<T extends InputDraftView>(editor:LiveInputPort,draft:T):T{
  const current=editor.read();
  // Navigation can publish a new input task/version without editing its contents.
  // Keep the original token when a concurrent write actually changed the snapshot.
  if(current.draftVersion===draft.draftVersion||!sameDraftContents(draft,current))return draft;
  return {...draft,draftVersion:current.draftVersion,step:current.step};
}

function inputFrameRecovery(ctx:InputToolsContext,entry:WorkspaceDocumentEntry){
  let frame:ReturnType<NonNullable<InputToolsContext['currentFrame']>>=null;
  try{frame=ctx.currentFrame?.(entry.id)??null;}catch{ /* The source may have closed after the rejected operation. */ }
  return {frame,recovery:frame
    ?{tool:'frame_extract',arguments:{frameRef:frame.frameRef},message:'提取此帧为新的可编辑模型，再读取新模型的输入草稿并确认电子态。'}
    :{tool:'frames_select',arguments:{targetId:entry.id,limit:1},message:'从该来源读取确切帧身份，再用 frame_extract 提取所需帧。'}};
}

function inputCatalogFailure(view:InputDraftView,validation:unknown){
  const details=validation as {issues?:unknown[];errors?:unknown[]}|undefined;
  const issues=details?.issues??details?.errors;
  if(!Array.isArray(issues)||!issues.some(issue=>typeof issue==='string'
    ?issue.includes('未进入本版已核实目录')
    :typeof issue==='object'&&issue!==null&&'field' in issue&&issue.field==='basis'&&'message' in issue&&
      typeof issue.message==='string'&&issue.message.includes('已核对 def2 轨道基组')))return null;
  return {completion:'not_submitted',documentId:view.documentId,draftVersion:view.draftVersion,engine:view.engine,
    method:view.configuration.settings?.method,basis:view.configuration.settings?.basis,
    issues,recovery:{tool:'file_write_text',message:'沿用请求的方法、基组及确切坐标，提供完整原生输入正文；需要运行时用 job_preview 预检该正文或文件。'}};
}

const frameItem = object({frameRef:string, stem:string,
  electronicState:object({charge:integer,multiplicity:positive,confirmed:boolean},['charge','multiplicity','confirmed'])},['frameRef','stem']);
type FrameItem = {frameRef:string;stem:string;electronicState?:InputDraftConfiguration['electronicState']};
const endpointSource=object({modelRef,revision:integer},['modelRef','revision']);
const endpointBindings=object({reactant:endpointSource,product:endpointSource,tsGuess:endpointSource,confirm:boolean},['reactant','product']);
const scanRows=list({oneOf:[object({atomIds:list(string),increments:positive,increment:numeric},['atomIds','increments','increment']),
  object({atomIds:list(string),start:numeric,end:numeric,points:positive},['atomIds','start','end','points']),
  object({atomIds:list(string),values:list(numeric)},['atomIds','values'])]});
const assetKind=choice('hessian','gbw','restart');
const assetEvidence={hessian:object({fromCurrent:boolean,version:choice(...ORCA_VERSIONS),state:string,source:string,charge:integer,multiplicity:positive,
  referenceMultiplicity:positive,stateSource:choice('udft','td'),geometryUnits:choice('bohr'),minimumConfirmed:boolean,atomOrderConfirmed:boolean,
  method:string,basis:string,solvent:string,path:object({purpose:choice('ts-initial','irc'),levelRelation:choice('same-level','initial-approximation'),
    dispersion:choice('','none','d3','d3bj','d4','builtin'),solventModel:choice('','gas','cpcm','smd'),solvation,atomIds:list(string),
    compatibilityConfirmed:boolean,transitionStateConfirmed:boolean,approximationNote:string})}),
  orbital:object({source:string,version:choice(...ORCA_VERSIONS),method:string,basis:string,charge:integer,multiplicity:positive,atomIds:list(string),compatibilityConfirmed:boolean}),
  restart:object({taskIdentity:string,atomIds:list(string),conditionsConfirmed:boolean})};

async function importOrcaInputAsset(args:Record<string,unknown>,view:InputDraftView,call?:McCall):Promise<Extract<InputOrcaAssetEdit,{action:'import'}>>{
  const bridge=mcpBridge(),desktop=window.sciyueDesktop as unknown as LaunchImportBridge|undefined;
  if(!call||!bridge||!desktop?.readLaunchSource||!desktop.closeLaunchSource)throw Error('当前 MCP 会话不能读取本机输入依赖。');
  const descriptors=await bridge.file({requestId:call.requestId,action:'sources',...(call.batchIndex===undefined?{}:{batchIndex:call.batchIndex})}) as LaunchSourceDescriptor[];
  const sources=descriptors.map(descriptor=>launchSourceFile(descriptor,desktop));
  try{
    if(sources.length!==1)throw Error('请选择一份实际输入依赖。');
    const source=sources[0],task=(view.parameters.settings as OrcaSettings).task;
    const isHessian=/\.hess$/i.test(source.name);
    const kind=isHessian?'hessian':orcaAssetUploadKind(source.name,task);
    if(args.kind!==undefined&&kind!==args.kind)throw Error('输入依赖格式与指定角色不符。');
    if(isHessian&&args.select!==false&&!canSelectOrcaHessian(task))throw hessianSelectionError(task);
    call.signal.throwIfAborted();
    const cancel=()=>{void Promise.resolve().then(()=>source.close?.()).catch(()=>{});};
    call.signal.addEventListener('abort',cancel,{once:true});
    try{
      // Preserve the native File representation; IPC reads stay in bounded chunks.
      const file=new File([await new Response(source.stream()).blob()],source.name);
      const asset=await readOrcaAsset(file,kind);
      call.signal.throwIfAborted();
      return {action:'import',asset,file,select:args.select!==false,replace:args.replace===true};
    }finally{call.signal.removeEventListener('abort',cancel);}
  }finally{await Promise.allSettled(sources.map(source=>source.close?.()));}
}

function patchFrameTemplate(template:AdvancedInputTemplate,configuration:InputDraftConfiguration):AdvancedInputTemplate{
  if(template.engine!==configuration.engine)throw Error('逐帧参数须与所选模板使用同一引擎；请另选其他引擎的模板。');
  const {cores,memoryGB,resourcesConfirmed}=configuration;
  const resources=(changing:boolean,defaultValue:number)=>({...(changing?{cores:defaultValue,memoryGB:defaultValue}:{}),
    ...(cores===undefined?{}:{cores}),...(memoryGB===undefined?{}:{memoryGB}),
    ...(resourcesConfirmed!==undefined?{resourcesConfirmed}:changing||cores!==undefined||memoryGB!==undefined?{resourcesConfirmed:false}:{})});
  if(template.engine==='gaussian'){
    const request=template.request,patch=configuration.settings as InputSettingsPatch<GaussianSettings>|undefined;
    const task=(configuration.task??request.settings.task) as TaskId,changing=task!==request.settings.task;
    let base=changing?defaultSettings(task):request.settings;
    if(patch?.method&&patch.method!==base.method)base={...changedGaussianConditions(base,['method']),...methodDefaults(patch.method,task),
      inheritedRoute:{...base.inheritedRoute,sourceId:undefined,methodKeyword:undefined},inheritanceIssues:base.inheritanceIssues?.filter(issue=>issue.field!=='method')};
    if(patch?.basis!==undefined&&!patch.mixedBasis)base=transitionGaussianBasis(base,{type:'basis',basis:patch.basis});
    const retained=patch?.parameterDrafts?gaussianParameterDraftPatch(base,patch.parameterDrafts):{};
    const {parameterDrafts:_retained,taskOptions,solvation,...explicit}=patch??{};
    let settings=base;
    for(const key of Object.keys(retained) as (keyof GaussianSettings)[])settings=applyGaussianField(settings,key,retained[key]);
    for(const key of Object.keys(explicit) as (keyof typeof explicit)[]){
      const defaults={...settings,advanced:settings.advanced??defaultAdvanced(task),mixedBasis:settings.mixedBasis??defaultMixedBasis()};
      const value=mergeInputPatch(defaults,{[key]:explicit[key]})[key];
      settings=applyGaussianField(settings,key,value);
    }
    const solventEdit=inputSolventEdit('gaussian',base,{...explicit,solvation});
    if(solventEdit){
      if(solventEdit.solvent!==undefined)settings=applyGaussianField(settings,'solvent',solventEdit.solvent);
      settings=applyGaussianField(settings,'solvation',solventEdit.solvation);
    }
    if(taskOptions)settings=applyGaussianField(settings,'taskOptions',mergeInputPatch(settings.taskOptions??defaultTaskOptions(),taskOptions));
    const files=changing?{...defaultFiles(),hessian:task==='ts'||task==='irc'?'calcfc' as const:'none' as const}:request.files??defaultFiles();
    return {engine:template.engine,request:{...request,...resources(changing,0),settings,files:{...files,...configuration.files},
      frequencyConditionsConfirmed:configuration.frequencyConditionsConfirmed??(!changing&&request.frequencyConditionsConfirmed)}};
  }
  const request=template.request,task=(configuration.task??request.settings.task) as OrcaSettings['task'];
  const changing=task!==request.settings.task,base=changing?createOrcaCommonSettings(task,request.structure):request.settings;
  const patch=configuration.settings as InputSettingsPatch<OrcaSettings>|undefined,retained=patch?.parameterDrafts?orcaParameterDraftPatch(base,patch.parameterDrafts):{};
  const {parameterDrafts:_retained,solvation,...explicit}=patch??{},settings=mergeInputPatch({...base,...retained},explicit);
  Object.assign(settings,inputSolventEdit('orca',base,{...explicit,solvation}));
  return {engine:template.engine,request:{...request,...resources(changing,1),settings,...(changing?{assets:[]}:{})}};
}

export function inputTools(ctx: InputToolsContext): McTool[] & {dispose():void} {
  function port(args:Record<string,unknown>){
    const entry=ctx.entry(args.modelRef as string|undefined);
    try{return liveInputFor(entry.store);}
    catch(error){
      if((error as {code?:string}).code!=='INPUT_EDITOR_UNAVAILABLE')throw error;
      throw toolError('INPUT_EDITOR_UNAVAILABLE',errorMessage(error),{
        completion:'not_submitted',modelRef:entry.id,writable:false,...inputFrameRecovery(ctx,entry)
      });
    }
  }
  async function followDraft<T extends InputDraftView>(editor:LiveInputPort,draft:T,mode:McpPresentationMode,call?:McCall){
    if(mode==='background')return {...draft,presentation:{mode,status:'background'}};
    if(!ctx.presentInput)return draft;
    if(call?.signal.aborted)return {...draft,presentation:{mode,status:'cancelled'}};
    try{
      const presentation=await ctx.presentInput(draft.documentId,mode,call);
      return {...settledDraft(editor,draft),presentation};
    }catch(cause){return {...draft,presentation:{mode,status:'unavailable',message:errorMessage(cause)}};}
  }
  const jobs=jobTools(ctx);
  const settings=inputSettingsTools();
  const tools=[
    inputTool('input_draft', 'Read or update the native Gaussian / ORCA input draft. Writes follow the input page by default. To open it while reading, set presentation:follow; background keeps the workbench. Patch configuration with its engine and expectedDraft. Method and basis go in settings; Gaussian excited settings use settings.taskOptions.excited, ORCA uses settings.excited. Find solvent IDs with input_solvents; settings.solvation:null clears only solvation. Use configuration.electronicState to confirm q/M and model_constraints for shared freezes.',
      object({...sourceFields,configuration:inputConfigurationSchema,replaceEdited:replacement,presentation:inputPresentation}), (args,call)=>{
        const editor=port(args);
        if(args.configuration===undefined){
          const draft=editor.read();
          assertDraftVersion(draft,args.expectedDraft);
          const read={...draft,solvent:readInputSolvent(draft)};
          return args.presentation===undefined?read:followDraft(editor,read,presentationMode(args),call);
        }
        if(typeof args.expectedDraft!=='string')throw Error('修改草稿前请读取并传入 expectedDraft。');
        const mode=presentationMode(args);
        let configuration=readInputConfiguration(args.configuration);
        if(configuration.settings?.solvent!==undefined||configuration.settings?.solvation!==undefined){
          const current=editor.read();
          assertDraftVersion(current,args.expectedDraft);
          configuration=prepareInputSolventWrite(current,configuration);
        }
        call?.signal.throwIfAborted();
        let draft:InputDraftView;
        try{draft=editor.configure(configuration,args.expectedDraft,args.replaceEdited===true);}
        catch(error){
          if(!configuration.electronicState||(error as {code?:string}).code!=='scientific-edit-cancelled')throw error;
          const view=editor.read(),entry=ctx.entry(view.documentId);
          throw toolError('scientific-edit-cancelled',errorMessage(error),{
            completion:'not_submitted',modelRef:entry.id,draftVersion:view.draftVersion,
            electronicStateWritable:false,requestedElectronicState:configuration.electronicState,...inputFrameRecovery(ctx,entry)
          });
        }
        const updated={...draft,solvent:readInputSolvent(draft)};
        return draft.draftVersion!==args.expectedDraft||args.presentation!==undefined?followDraft(editor,updated,mode,call):updated;
      }),
    inputTool('input_solvents','Read the current draft solvation and search the native Gaussian or ORCA built-in solvent catalog by name, alias, or exact ID. Use entries[].id in settings.solvation:{mode:builtin,id}, or pass clearConfiguration to input_draft with this draftVersion. Omit query to list the catalog. ORCA defaults to the shared catalog of reviewed profiles.',
      object({modelRef,engine:choice('gaussian','orca'),solventModel:choice('iefpcm','cpcm','smd'),version:choice('common',...ORCA_VERSIONS),query:string}),
      args=>inputSolventOptions(port(args).read(),args)),
    inputTool('input_preview', 'Preview the native engine writer and validation without publishing or running. If the requested method/basis combination is outside this editor catalog, preserve the requested theory: write the exact Gaussian/ORCA text to an explicit destination via file_write_text, then use job_preview if execution is requested.',
      object(sourceFields),args=>{
        const editor=port(args),preview=editor.preview(args.expectedDraft as string|undefined);
        const view=editor.read(),restriction=inputCatalogFailure(view,preview),solventIssue=inputSolventIssue(view);
        return restriction||solventIssue?{...preview as object,...(restriction?{catalogRestriction:restriction}:{}),...(solventIssue?{solventIssue}:{})}:preview;
      }),
    inputTool('input_generate', 'Generate native input and return the current draftVersion. Use directory to save in one call. A selected main fileName in directory or save:true mode includes its native XYZ and retained dependencies; destination saves one exact file. Read delivery for each written path and SHA-256. This tool never submits a job.',
      object({...sourceFields,...deliveryFields,save:boolean,replaceEdited:replacement,presentation:inputPresentation},['expectedDraft']),
      async(args,context)=>{
        if(args.destination!==undefined&&args.directory!==undefined)throw Error('请选择单文件 destination 或 directory。');
        const mode=presentationMode(args);
        context?.signal.throwIfAborted();
        const editor=port(args);
        let draft:InputDraftView;
        try{draft=await editor.generate(args.expectedDraft as string,args.replaceEdited===true);}
        catch(error){
          const failure=error as {code?:string;data?:unknown};
          if(failure.code==='INPUT_VALIDATION'){
            const view=editor.read(),restriction=inputCatalogFailure(view,failure.data),solventIssue=inputSolventIssue(view);
            if(restriction)throw toolError('INPUT_CATALOG_RESTRICTION',errorMessage(error),{...restriction,...(solventIssue?{solventIssue}:{})});
            if(solventIssue)throw toolError(failure.code,errorMessage(error),{...failure.data as object,solventIssue});
          }
          throw error;
        }
        const followed=await followDraft(editor,draft,mode,context);
        if(args.save!==true&&args.destination===undefined&&args.directory===undefined)return followed;
        let delivery:InputSaveReceipt[];
        try{delivery=await saveGenerated(editor,followed,args,context,true);}
        catch(error){
          const recovery=(error as {code?:string}).code==='DRAFT_CONFLICT'
            ?{tool:'input_draft',arguments:{modelRef:draft.documentId}}
            :{tool:'input_save',arguments:{modelRef:draft.documentId,expectedDraft:followed.draftVersion,...(args.directory===undefined?{}:{directory:args.directory})}};
          return {...followed,deliveryIssue:{status:'failed',message:errorMessage(error),recovery}};
        }
        const delivered=delivery.filter(file=>file.status==='saved').length;
        const deliveryStatus=delivered===delivery.length?'saved':delivered||delivery.some(file=>file.status==='publication_unconfirmed')?'partial':'failed';
        return {...settledDraft(editor,followed),deliveryStatus,delivery};
      }),
    inputTool('input_inherit','Apply the native Gaussian or ORCA level inheritance from the selected document’s parsed source. Preserves task, freezes and resource choices.',
      object(sourceFields,['expectedDraft']),args=>port(args).inherit(args.expectedDraft as string)),
    inputTool('input_bind_endpoints','Bind versioned reactant and product model snapshots to an ORCA NEB input. Confirm q/M separately on each source and use their actual atom order. Follow the configured input page by default.',
      object({...sourceFields,endpoints:endpointBindings,presentation:inputPresentation},['expectedDraft','endpoints']),
      (args,call)=>{
        const editor=port(args);
        const draft=editor.bindEndpoints(args.expectedDraft as string,args.endpoints as InputEndpointBindings);
        return followDraft(editor,draft,presentationMode(args),call);
      }),
    inputTool('input_scan','Read or replace the input editor’s Scan rows by ordered stable atom IDs. Gaussian uses increments and increment in Å or degrees. ORCA uses start, end and total points, or an explicit values list. Existing shared freezes are retained.',
      object({...sourceFields,rows:scanRows}),args=>{
        const editor=port(args);
        if(args.rows===undefined)return editor.scan(args.expectedDraft as string|undefined);
        if(typeof args.expectedDraft!=='string')throw Error('修改扫描前请读取并传入 expectedDraft。');
        return editor.scan(args.expectedDraft,args.rows as InputScanRow[]);
      }),
    inputTool('input_assets','Inspect, import, reference, select, unselect, remove or edit evidence for ORCA input dependencies. Use select:false to retain an unselected HESS. For TS/IRC compatibility, use action:evidence with hessian.path.purpose, hessian.path.atomIds in source order and the actual level/solvent evidence.',
      object({...sourceFields,action:choice('read','import','reference','select','remove','clear','evidence'),path:string,kind:assetKind,name:string,
        assetId:string,select:boolean,replace:boolean,...assetEvidence},['action']),async(args,call)=>{
        const editor=port(args),expected=args.expectedDraft as string|undefined;
        if(args.action==='read')return editor.assets(expected);
        if(expected===undefined)throw Error('修改输入依赖前请读取并传入 expectedDraft。');
        if(args.action==='import'){
          if(typeof args.path!=='string'||!args.path)throw Error('导入依赖需提供实际文件路径。');
          const view=editor.read();
          if(view.engine!=='orca')throw Error('此处使用 ORCA 输入文件依赖。');
          assertDraftVersion(view,expected);
          let imported:Awaited<ReturnType<typeof importOrcaInputAsset>>|undefined;
          try{
            const edit=await importOrcaInputAsset(args,view,call);
            imported=edit;
            const result=editor.assets(expected,edit);
            return edit.asset.kind==='hessian'?{...result as object,imported:{
              assetId:edit.asset.id,name:edit.asset.name,sha256:edit.asset.sha256,retained:true,
              hasFileBytes:edit.file.size>0,selected:edit.select
            }}:result;
          }catch(error){
            const issue=error as {code?:string;data?:{canReplace?:boolean}};
            const option=issue.code==='HESSIAN_TASK_UNSUPPORTED'?{select:false}:issue.code==='INPUT_ASSET_NAME_CONFLICT'&&issue.data?.canReplace?{replace:true}:null;
            if(option)throw toolError(issue.code!,errorMessage(error),{...issue.data,
              ...(imported&&issue.code==='INPUT_ASSET_NAME_CONFLICT'?{requested:{path:args.path,name:imported.asset.name,sha256:imported.asset.sha256,bytes:imported.file.size}}:{}),recovery:{
              tool:'input_assets',arguments:{...args,modelRef:view.documentId,...option},
              ...(option.replace?{requiresConfirmation:true}:{})
            }});
            throw error;
          }
        }
        if(args.action==='reference'&&(!args.name||!['gbw','hessian'].includes(String(args.kind))))throw Error('请选择 GBW 或 HESS 并填写它的原始文件名。');
        if(args.action==='clear'&&!args.kind)throw Error('请明确要解除关联的依赖类型。');
        if(['select','remove','evidence'].includes(String(args.action))&&!args.assetId)throw Error('请指定实际存在的 assetId。');
        if(args.action==='evidence'&&[args.hessian,args.orbital,args.restart].filter(Boolean).length!==1)throw Error('每次只编辑一种依赖证据。');
        return editor.assets(expected,args as InputOrcaAssetEdit);
      }),
    inputTool('input_text', 'Read a selected generated input file or replace its exact text in the native editor. Companion files are read-only.',
      object({...sourceFields,fileName:string,text:string},['fileName']),
      args=>{
        const editor=port(args);
        if(typeof args.text==='string'){
          if(typeof args.expectedDraft!=='string')throw Error('修改正文前请读取并传入 expectedDraft。');
          return editor.edit(args.expectedDraft,args.fileName as string,args.text);
        }
        const view=editor.read(),file=view.files.find(candidate=>candidate.name===args.fileName);
        if(!file)throw Error('当前输入编辑器没有指定的文件。');
        assertDraftVersion(view,args.expectedDraft);
        return {documentId:view.documentId,draftVersion:view.draftVersion,engine:view.engine,stale:view.stale,edited:view.editedFiles.includes(file.name),file};
      }),
    inputTool('input_save', 'Save a generated input and its retained companions to the portable exports folder or the specified directory. For a single file provide fileName or an exact absolute destination.',
      object({...sourceFields,...deliveryFields},['expectedDraft']),
      async (args,context)=>{
        if(args.destination!==undefined&&args.directory!==undefined)throw Error('请选择单文件 destination 或 directory。');
        const editor=port(args),view=editor.read();
        assertDraftVersion(view,args.expectedDraft);
        return {engine:view.engine,draftVersion:view.draftVersion,stale:view.stale,files:await saveGenerated(editor,view,args,context)};
      }),
    inputTool('input_batch',
      'Generate independent Gaussian / ORCA inputs for ordered frame refs. Read input_draft on a named template once and use its documentId as modelRef and draftVersion as expectedDraft, or specify templateModelRef and templateDraft per row. Each row supplies frameRef, stem and its confirmed electronicState, directly or in configuration. Use configuration for matching-engine overrides without editing the template. Batch outputs are in items[].files, not the live editor. Use directory to save inputs and source manifests, or omit saving to receive their text.',
      object({...sourceFields,directory:string,save:boolean,onExists:choice('error','overwrite'),presentation:inputPresentation,frames:list(object({
        ...frameItem.properties as Record<string,Schema>,templateModelRef:modelRef,templateDraft:expectedDraft,configuration:frameInputConfigurationSchema
      },frameItem.required as string[]))},['frames']),
      async (args,context)=>{
        const items=args.frames as (FrameItem&{templateModelRef?:string;templateDraft?:string;configuration?:unknown})[];
        if(!items.length)throw Error('请选择需要准备输入的真实帧。');
        let engineTemplate:AdvancedInputTemplate|undefined,templateError:unknown;
        if(items.some(item=>item.templateModelRef===undefined)){
          try{
            if(typeof args.expectedDraft!=='string')throw Error('使用公共模板的成员需要 expectedDraft。');
            engineTemplate=port(args).template(args.expectedDraft);
          }catch(error){templateError=error;}
        }
        const usedNames=new Set<string>(),usedFrames=new Set<string>(),results=[];
        for(const [index,item] of items.entries()){
          let sourceRef:AdvancedFrameSource['ref']|undefined;
          try{
            context?.signal.throwIfAborted();
            if(Boolean(item.templateModelRef)!==Boolean(item.templateDraft))throw Error('独立模板需要同时指定 templateModelRef 和 templateDraft。');
            const selectedTemplate=item.templateModelRef?liveInputFor(ctx.entry(item.templateModelRef).store).template(item.templateDraft):engineTemplate;
            if(!selectedTemplate)throw templateError;
            const configuration=item.configuration===undefined?undefined:readInputConfiguration(item.configuration);
            const template=configuration===undefined?selectedTemplate:patchFrameTemplate(selectedTemplate,configuration);
            const configuredState=configuration?.electronicState,explicitState=item.electronicState;
            if(explicitState&&configuredState&&(['charge','multiplicity','confirmed'] as const).some(key=>explicitState[key]!==configuredState[key]))
              throw Error('此帧的两处电子态设置不一致，请保留一组一致的电荷与多重度。');
            const electronicState=explicitState??configuredState;
            if(!electronicState?.confirmed)throw Error('请逐结构确认电荷与多重度，模板确认不能代替本帧确认。');
            const {charge,multiplicity}=electronicState;
            const source=await ctx.frame(item.frameRef,context?.signal,{charge,multiplicity});
            sourceRef=source.ref;
            const identity=JSON.stringify(sourceRef);
            if(usedFrames.has(identity))throw Error('同一科学帧重复选择。');
            const plan=prepareAdvancedFrameInputs({template,frames:[{source,stem:item.stem,electronicState,
              outputCheckpointName:configuration?.files?.checkpointName}],manifestStem:item.stem,independentRuntimeNames:true});
            if(!plan.ready)throw Error(plan.errors.join('\n'));
            const evidence={...plan.manifest.frames[0],order:index+1};
            const generated=plan.files.map(file=>file.name===`${item.stem}.manifest.json`?
              {...file,text:JSON.stringify({...plan.manifest,frames:[evidence]},null,2)+'\n'}:file);
            const names=generated.map(file=>file.name.toLowerCase()).concat((evidence.runtimeOutputNames??[]).map(name=>name.toLowerCase()));
            const conflict=names.find(name=>usedNames.has(name));
            if(conflict)throw Error(`输出文件或运行文件名称重名：${conflict}`);
            usedFrames.add(identity);
            for(const name of names)usedNames.add(name);
            const files=[];
            if(args.save===true||args.directory!==undefined){
              files.push(...await saveFiles(generated,args,context,args.directory===undefined?String(index):undefined));
            }else{
              const manifestNames=new Set(evidence.fileNames);
              files.push(...generated.filter(file=>manifestNames.has(file.name)));
            }
            const failed=files.filter(file=>'status' in file&&file.status==='failed').length;
            const unconfirmed=files.filter(file=>'status' in file&&file.status==='publication_unconfirmed').length;
            const status=unconfirmed===files.length?'publication_unconfirmed':failed===files.length?'failed':
              failed||unconfirmed?'partial':'generated';
            results.push({order:index+1,sourceRef,engine:template.engine,status,warnings:plan.items[0]?.warnings,evidence,
              effective:plan.items[0]?.effective,files});
          }catch(error){
            const issue=error as {code?:string;data?:unknown};
            results.push({order:index+1,frameRef:item.frameRef,sourceRef,status:'failed',reason:errorMessage(error),code:issue.code,data:issue.data});
          }
        }
        const result={items:results};
        if(args.presentation===undefined)return result;
        const mode=presentationMode(args);
        if(mode==='background')return {...result,presentation:{mode,status:'background'}};
        if(!ctx.presentInput||!results.some(item=>item.status==='generated'||item.status==='partial'))return result;
        try{
          const model=ctx.entry((args.modelRef as string|undefined)??items[0]?.templateModelRef);
          return {...result,presentation:await ctx.presentInput(model.id,mode,context)};
        }catch(cause){return {...result,presentation:{mode,status:'unavailable',message:errorMessage(cause)}};}
      }),
    ...jobs,
    ...settings
  ];
  return Object.assign(tools,{dispose(){jobs.dispose();settings.dispose();}});
}
