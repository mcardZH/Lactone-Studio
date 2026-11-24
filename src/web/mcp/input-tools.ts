import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import { prepareAdvancedFrameInputs, type AdvancedInputTemplate } from '../../modeling/application/advanced-frame-output';
import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';
import { defaultFiles, defaultSettings, methodDefaults } from '../../core/gaussian';
import { defaultAdvanced } from '../../core/advanced';
import { defaultMixedBasis } from '../../core/mixed-basis';
import { defaultTaskOptions } from '../../core/tasks';
import { createOrcaCommonSettings, ORCA_VERSIONS, type OrcaSettings } from '../../core/orca';
import { solventSelectionForModelChange } from '../../core/solvents';
import { transitionGaussianBasis } from '../../modeling/application/gaussian-basis-transition';
import { launchSourceFile, type LaunchImportBridge, type LaunchSourceDescriptor } from '../../modeling/platform/launch-import';
import { orcaAssetUploadKind, readOrcaAsset } from '../orca/OrcaAssets';
import type { GaussianSettings, TaskId } from '../../core/types';
import { liveInputFor, type InputDraftConfiguration, type InputDraftView, type InputEndpointBindings, type InputOrcaAssetEdit, type InputScanRow, type LiveInputPort } from './input-drafts';
import { boolean, choice, expectedDraft, frameInputConfigurationSchema, inputConfigurationSchema, inputTool, integer, list, mergeInputPatch, modelRef, numeric, object, positive, readInputConfiguration, solvation, string, type Schema } from './input-arguments';
import { presentationFields, presentationMode, toolError, type McCall, type McpPresentationMode, type McTool } from './types';
import { mcpBridge } from './bridge';
import { jobTools } from './job-tools';
import { inputSettingsTools } from './input-settings-tools';
import { canSelectOrcaHessian, gaussianParameterDraftPatch, hessianSelectionError, orcaParameterDraftPatch } from './input-specialized';
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

type InputOutput={name:string;text:string}|{name:string;file:File};
type InputSaveReceipt={name:string;status:string;reason?:string;code?:string;data?:unknown;receipt?:unknown};

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
        const status=(receipt as {status?:string}|null)?.status==='publication_unconfirmed'
          ?'publication_unconfirmed':'saved';
        receipts.push({name:file.name,status,receipt});
      }catch(error){receipts.push(inputSaveFailure(file.name,error));}
    }
  }catch(error){return files.map(file=>inputSaveFailure(file.name,error));}
  return receipts;
}

async function saveGenerated(editor:LiveInputPort,view:InputDraftView,args:Record<string,unknown>,context?:McCall){
  const outputs=[...view.files,...editor.binaryOutputs(view.draftVersion)];
  const files=args.fileName===undefined?outputs:outputs.filter(file=>file.name===args.fileName);
  if(!files.length||args.destination&&files.length!==1)throw Error('请指定当前编辑器中唯一的输出文件。');
  return saveFiles(files,args,context);
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
  electronicState:object({charge:integer,multiplicity:positive,confirmed:boolean},['charge','multiplicity','confirmed'])},['frameRef','stem','electronicState']);
type FrameItem = {frameRef:string;stem:string;electronicState:{charge:number;multiplicity:number;confirmed:boolean}};
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
    const request=template.request,patch=configuration.settings as Partial<GaussianSettings>|undefined;
    const task=(configuration.task??request.settings.task) as TaskId,changing=task!==request.settings.task;
    let base=changing?defaultSettings(task):request.settings;
    if(patch?.method&&patch.method!==base.method)base={...changedGaussianConditions(base,['method']),...methodDefaults(patch.method,task),
      inheritedRoute:{...base.inheritedRoute,sourceId:undefined,methodKeyword:undefined},inheritanceIssues:base.inheritanceIssues?.filter(issue=>issue.field!=='method')};
    if(patch?.basis!==undefined&&!patch.mixedBasis)base=transitionGaussianBasis(base,{type:'basis',basis:patch.basis});
    const retained=patch?.parameterDrafts?gaussianParameterDraftPatch(base,patch.parameterDrafts):{};
    const {parameterDrafts:_retained,taskOptions,...explicit}=patch??{};
    let settings=base;
    for(const key of Object.keys(retained) as (keyof GaussianSettings)[])settings=applyGaussianField(settings,key,retained[key]);
    for(const key of Object.keys(explicit) as (keyof typeof explicit)[]){
      if(key==='solvation')continue;
      const defaults={...settings,advanced:settings.advanced??defaultAdvanced(task),mixedBasis:settings.mixedBasis??defaultMixedBasis()};
      const value=mergeInputPatch(defaults,{[key]:explicit[key]})[key];
      settings=applyGaussianField(settings,key,value);
    }
    if(patch?.solvent!==undefined||patch?.solvation!==undefined||patch?.solventModel!==undefined){
      const solvation=patch.solvation??(patch.solvent!==undefined?undefined:solventSelectionForModelChange({engine:'gaussian',selection:base.solvation,currentModel:base.solventModel,nextModel:settings.solventModel}));
      settings=applyGaussianField(settings,'solvation',solvation);
    }
    if(taskOptions)settings=applyGaussianField(settings,'taskOptions',mergeInputPatch(settings.taskOptions??defaultTaskOptions(),taskOptions));
    const files=changing?{...defaultFiles(),hessian:task==='ts'||task==='irc'?'calcfc' as const:'none' as const}:request.files??defaultFiles();
    return {engine:template.engine,request:{...request,...resources(changing,0),settings,files:{...files,...configuration.files},
      frequencyConditionsConfirmed:configuration.frequencyConditionsConfirmed??(!changing&&request.frequencyConditionsConfirmed)}};
  }
  const request=template.request,task=(configuration.task??request.settings.task) as OrcaSettings['task'];
  const changing=task!==request.settings.task,base=changing?createOrcaCommonSettings(task,request.structure):request.settings;
  const patch=configuration.settings as Partial<OrcaSettings>|undefined,retained=patch?.parameterDrafts?orcaParameterDraftPatch(base,patch.parameterDrafts):{};
  const {parameterDrafts:_retained,...explicit}=patch??{},settings=mergeInputPatch({...base,...retained},explicit);
  if(patch?.solvent!==undefined||patch?.solvation!==undefined||patch?.solventModel!==undefined)
    settings.solvation=patch.solvation??(patch.solvent!==undefined?undefined:solventSelectionForModelChange({engine:'orca',version:'common',selection:base.solvation,currentModel:base.solventModel,nextModel:settings.solventModel}));
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
  async function followDraft<T extends InputDraftView>(draft:T,mode:McpPresentationMode,call?:McCall){
    if(mode==='background')return {...draft,presentation:{mode,status:'background'}};
    if(!ctx.presentInput)return draft;
    if(call?.signal.aborted)return {...draft,presentation:{mode,status:'cancelled'}};
    try{return {...draft,presentation:await ctx.presentInput(draft.documentId,mode,call)};}
    catch(cause){return {...draft,presentation:{mode,status:'unavailable',message:errorMessage(cause)}};}
  }
  const jobs=jobTools(ctx);
  const settings=inputSettingsTools();
  const tools=[
    inputTool('input_draft', 'Read or update the real Gaussian / ORCA input editor. Changes follow the configured input page by default; presentation:background keeps the visible workbench. The returned configuration is an admitted write template; parameters retain the full native facts and are not a write payload (Gaussian cores=0 means unspecified). Send a partial configuration and expectedDraft to change fields; omitted and unchanged fields retain their settings. Confirm q/M together with electronicState.confirmed. Shared freezes use model_constraints. The generator writes its standard title; edit generated titles with input_text.',
      object({...sourceFields,configuration:inputConfigurationSchema,replaceEdited:replacement,presentation:inputPresentation}), (args,call)=>{
        const editor=port(args);
        if(args.configuration===undefined)return editor.read();
        if(typeof args.expectedDraft!=='string')throw Error('修改草稿前请读取并传入 expectedDraft。');
        const mode=presentationMode(args);
        const configuration=readInputConfiguration(args.configuration);
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
        return draft.draftVersion!==args.expectedDraft&&(ctx.presentInput||mode==='background')?followDraft(draft,mode,call):draft;
      }),
    inputTool('input_preview', 'Preview the native engine writer and validation without publishing or running. If the requested method/basis combination is outside this editor catalog, preserve the requested theory: write the exact Gaussian/ORCA text to an explicit destination via file_write_text, then use job_preview if execution is requested.',
      object(sourceFields),args=>{
        const editor=port(args),preview=editor.preview(args.expectedDraft as string|undefined);
        const restriction=inputCatalogFailure(editor.read(),preview);
        return restriction?{...preview as object,catalogRestriction:restriction}:preview;
      }),
    inputTool('input_generate', 'Generate native validated input in the document editor and follow its generated page by default. Set presentation to background to keep the visible workbench. Pass save:true to save to the portable exports folder, or specify an exact destination or directory. Use file_write_text for an exact input outside the editor catalog.',
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
          const restriction=failure.code==='INPUT_VALIDATION'?inputCatalogFailure(editor.read(),failure.data):null;
          if(restriction)throw toolError('INPUT_CATALOG_RESTRICTION',errorMessage(error),restriction);
          throw error;
        }
        if(args.save!==true&&args.destination===undefined&&args.directory===undefined)return followDraft(draft,mode,context);
        let delivery:InputSaveReceipt[];
        try{delivery=await saveGenerated(editor,draft,args,context);}
        catch(error){
          return followDraft({...draft,deliveryIssue:{status:'failed',message:errorMessage(error),
            recovery:{tool:'input_save',arguments:{modelRef:draft.documentId,expectedDraft:draft.draftVersion}}}},mode,context);
        }
        return followDraft({...draft,delivery},mode,context);
      }),
    inputTool('input_inherit','Apply the native Gaussian or ORCA level inheritance from the selected document’s parsed source. Preserves task, freezes and resource choices.',
      object(sourceFields,['expectedDraft']),args=>port(args).inherit(args.expectedDraft as string)),
    inputTool('input_bind_endpoints','Bind versioned model snapshots to an ORCA NEB input. Confirm the actual atom order and electronic state using source models in the intended order.',
      object({...sourceFields,endpoints:endpointBindings},['expectedDraft','endpoints']),
      args=>port(args).bindEndpoints(args.expectedDraft as string,args.endpoints as InputEndpointBindings)),
    inputTool('input_scan','Read or replace the input editor’s Scan rows by ordered stable atom IDs. Gaussian uses increments and increment in Å or degrees. ORCA uses start, end and total points, or an explicit values list. Existing shared freezes are retained.',
      object({...sourceFields,rows:scanRows}),args=>{
        const editor=port(args);
        if(args.rows===undefined)return editor.scan(args.expectedDraft as string|undefined);
        if(typeof args.expectedDraft!=='string')throw Error('修改扫描前请读取并传入 expectedDraft。');
        return editor.scan(args.expectedDraft,args.rows as InputScanRow[]);
      }),
    inputTool('input_assets','Inspect, import, reference, select, unselect, remove or edit evidence for ORCA input dependencies. Use select:false to retain a HESS without selecting it. TS and IRC can select a HESS and explicitly confirm its compatibility against the file.',
      object({...sourceFields,action:choice('read','import','reference','select','remove','clear','evidence'),path:string,kind:assetKind,name:string,
        assetId:string,select:boolean,replace:boolean,...assetEvidence},['action']),async(args,call)=>{
        const editor=port(args),expected=args.expectedDraft as string|undefined;
        if(args.action==='read')return editor.assets(expected);
        if(expected===undefined)throw Error('修改输入依赖前请读取并传入 expectedDraft。');
        if(args.action==='import'){
          if(typeof args.path!=='string'||!args.path)throw Error('导入依赖需提供实际文件路径。');
          const view=editor.read();
          if(view.engine!=='orca')throw Error('此处使用 ORCA 输入文件依赖。');
          if(view.draftVersion!==expected)throw toolError('DRAFT_CONFLICT','输入草稿有新变化，请重新读取后重试。',{draftVersion:view.draftVersion});
          try{
            const edit=await importOrcaInputAsset(args,view,call),result=editor.assets(expected,edit);
            return edit.asset.kind==='hessian'?{...result as object,imported:{
              assetId:edit.asset.id,name:edit.asset.name,sha256:edit.asset.sha256,retained:true,
              hasFileBytes:edit.file.size>0,selected:edit.select
            }}:result;
          }catch(error){
            const issue=error as {code?:string;data?:{canReplace?:boolean}};
            const option=issue.code==='HESSIAN_TASK_UNSUPPORTED'?{select:false}:issue.code==='INPUT_ASSET_NAME_CONFLICT'&&issue.data?.canReplace?{replace:true}:null;
            if(option)throw toolError(issue.code!,errorMessage(error),{...issue.data,recovery:{
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
        if(args.expectedDraft!==undefined&&args.expectedDraft!==view.draftVersion)throw toolError('DRAFT_CONFLICT','输入草稿有新变化，请重新读取后重试。',{draftVersion:view.draftVersion});
        return {documentId:view.documentId,draftVersion:view.draftVersion,engine:view.engine,stale:view.stale,edited:view.editedFiles.includes(file.name),file};
      }),
    inputTool('input_save', 'Save a generated input and its retained companions to the portable exports folder or the specified directory. For a single file provide fileName or an exact absolute destination.',
      object({...sourceFields,...deliveryFields},['expectedDraft']),
      async (args,context)=>{
        if(args.destination!==undefined&&args.directory!==undefined)throw Error('请选择单文件 destination 或 directory。');
        const editor=port(args),view=editor.read();
        if(view.draftVersion!==args.expectedDraft)throw toolError('DRAFT_CONFLICT','输入草稿有新变化，请重新读取后重试。',{draftVersion:view.draftVersion});
        return {engine:view.engine,draftVersion:view.draftVersion,stale:view.stale,files:await saveGenerated(editor,view,args,context)};
      }),
    inputTool('input_batch',
      'Generate independent Gaussian / ORCA inputs for ordered frame refs. Read input_draft once and supply its draftVersion as expectedDraft, or use templateModelRef plus templateDraft per row. Each row supplies stem and confirmed q/M; configuration overrides fields on the matching-engine template without editing it. Pass save:true or directory to save each input and its source manifest.',
      object({...sourceFields,directory:string,save:boolean,onExists:choice('error','overwrite'),frames:list(object({
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
            const {charge,multiplicity,confirmed}=item.electronicState;
            if(!confirmed)throw Error('请逐结构确认电荷与多重度，模板确认不能代替本帧确认。');
            const source=await ctx.frame(item.frameRef,context?.signal,{charge,multiplicity});
            sourceRef=source.ref;
            const identity=JSON.stringify(sourceRef);
            if(usedFrames.has(identity))throw Error('同一科学帧重复选择。');
            const plan=prepareAdvancedFrameInputs({template,frames:[{source,stem:item.stem,electronicState:item.electronicState,
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
          }catch(error){results.push({order:index+1,frameRef:item.frameRef,sourceRef,status:'failed',reason:errorMessage(error)});}
        }
        return {items:results};
      }),
    ...jobs,
    ...settings
  ];
  return Object.assign(tools,{dispose(){jobs.dispose();settings.dispose();}});
}
