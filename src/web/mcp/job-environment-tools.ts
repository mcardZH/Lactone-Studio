import type { EnvironmentImportPreview, EnvironmentView, SiteProfileView, TaskSystemBridge, TaskSystemCommands } from '../../task-system/application-contracts';
import { launchSourceFile, type LaunchImportBridge, type LaunchSourceDescriptor } from '../../modeling/platform/launch-import';
import { boolean, choice, inputTool, object, positive, string } from './input-arguments';
import { withTaskCenter } from './input-settings-tools';
import { mcpBridge } from './bridge';
import { toolError, type McCall, type McTool } from './types';

const sitePatch=object({displayName:string,connectionKind:choice('local','wsl','ssh'),host:string,port:positive,user:string,distribution:string,
  workingRoot:string,schedulerKind:choice('none','slurm'),partition:string,account:string,qos:string,timeLimit:string,
  authentication:choice('agent','password','private-key'),privateKeyPath:string});
const defaultSite:SiteProfileView={siteId:'',revision:0,displayName:'',connectionKind:'local',host:'',port:22,user:'',distribution:'',
  workingRoot:'',schedulerKind:'none',partition:'',account:'',qos:'',timeLimit:'',authentication:'agent',privateKeyPath:'',deleted:false};
const transfer={type:'object',oneOf:[
  object({action:choice('export'),environmentId:string,save:boolean,destination:string,onExists:choice('error','overwrite')},['action','environmentId']),
  object({action:choice('import'),previewId:string},['action','previewId']),
  object({action:choice('preview-import','import'),text:string},['action','text']),
  object({action:choice('preview-import','import'),path:string},['action','path'])
]};

async function readNativeEnvironmentText(args:Record<string,unknown>,call:McCall|undefined){
  if(typeof args.text==='string')return args.text;
  const desktop=window.sciyueDesktop as unknown as LaunchImportBridge|undefined,bridge=mcpBridge();
  if(!call||!bridge||!desktop?.readLaunchSource||!desktop.closeLaunchSource)throw Error('当前连接无法读取指定环境文件。');
  const reply=await bridge.file({requestId:call.requestId,action:'sources',...(call.batchIndex===undefined?{}:{batchIndex:call.batchIndex})}) as LaunchSourceDescriptor[];
  const sources=reply.map(item=>launchSourceFile(item,desktop));
  try{
    if(sources.length!==1)throw Error('环境导入需要一个 JSON 文件。');
    call.signal.throwIfAborted();
    return await sources[0].text();
  }finally{await Promise.allSettled(sources.map(source=>source.close?.()));}
}

type ReviewedEnvironmentImport={preview:EnvironmentImportPreview;libraryId:string|null;sessionId?:string;flight?:Promise<EnvironmentView>;receipt?:EnvironmentView};

export function jobEnvironmentTools(bridge:TaskSystemBridge):McTool[] & {dispose():void}{
  const opts=(call?:McCall)=>({signal:call?.signal});
  const reviewed=new Map<string,ReviewedEnvironmentImport>();
  async function importedEnvironment(args:Record<string,unknown>,call?:McCall):Promise<EnvironmentImportPreview>{
    const text=await readNativeEnvironmentText(args,call);
    const value=await bridge.request('environment.import-preview',{text},opts(call));
    if(!value)throw Error('没有读取到环境预检。');
    return value;
  }
  function saveImport(preview:EnvironmentImportPreview,call?:McCall){
    return bridge.request('environment.save',{environment:{...preview.environment,environmentId:'',revision:0},
      documentPreservation:preview.preserved,requiredCapabilities:preview.requiredCapabilities},opts(call));
  }
  const tools=[
    inputTool('job_environment_transfer','Preview an environment JSON file or text using the native codec. Import with the returned previewId to use that exact reviewed configuration. Direct import accepts explicit text or path. Export previews JSON, or writes it with save:true or destination.',
      transfer,async(args,call)=>{
        if(args.action==='preview-import')return withTaskCenter(bridge,call,async state=>{
          const preview=await importedEnvironment(args,call);
          const previewId=`environment-import-${crypto.randomUUID()}`;
          reviewed.set(previewId,{preview,libraryId:state.library.libraryId,sessionId:call?.session.id});
          return {...preview,previewId,libraryId:state.library.libraryId,status:'previewed',
            recovery:{tool:'job_environment_transfer',arguments:{action:'import',previewId}}};
        },false);
        if(args.action==='import')return withTaskCenter(bridge,call,async state=>{
          if(typeof args.previewId!=='string')return saveImport(await importedEnvironment(args,call),call);
          const entry=reviewed.get(args.previewId);
          if(!entry||entry.sessionId!==call?.session.id||entry.libraryId!==state.library.libraryId)
            throw toolError('ENVIRONMENT_IMPORT_PREVIEW_UNAVAILABLE','当前会话和任务库没有该环境导入预检。请重新预览原文件或正文。',{
              completion:'not_submitted',previewId:args.previewId
            });
          if(!entry.receipt&&!entry.flight){
            call?.signal.throwIfAborted();
            entry.flight=saveImport(entry.preview).then(receipt=>entry.receipt=receipt).finally(()=>{entry.flight=undefined;});
          }
          return {...(entry.receipt??await entry.flight!),previewId:args.previewId,libraryId:entry.libraryId,status:'imported'};
        });
        const environmentId=args.environmentId as string;
        const raw=await bridge.request('environment.export-text',{environmentId},opts(call));
        if(args.destination===undefined&&args.save!==true)return {environmentId,...raw};
        const desktop=mcpBridge();
        if(!desktop||!call)throw Error('当前会话不能保存环境文档。');
        const receipt=await desktop.file({requestId:call.requestId,action:'write',bytes:new TextEncoder().encode(raw.text),
          ...(args.destination===undefined?{fileName:'environment.json'}:{}),
          ...(call.batchIndex===undefined?{}:{batchIndex:call.batchIndex})});
        return {environmentId,receipt};
      }),
    inputTool('job_environment_delete','Remove an existing environment configuration at its expected revision. Task and run records retain their frozen execution environment.',
      object({environmentId:string,expectedRevision:positive},['environmentId','expectedRevision']),
      (args,call)=>withTaskCenter(bridge,call,async()=>{
        const input=args as TaskSystemCommands['environment.delete']['input'];
        await bridge.request('environment.delete',input,opts(call));return {environmentId:input.environmentId,deleted:true};
      })),
    inputTool('job_site','Create, update or delete a native execution site profile. Use the revision from job_environments for an existing site.',
      object({action:choice('save','delete'),siteId:string,expectedRevision:positive,patch:sitePatch},['action']),
      (args,call)=>withTaskCenter(bridge,call,async state=>{
        const siteId=args.siteId as string|undefined,current=siteId?state.siteProfiles?.find(item=>item.siteId===siteId):undefined;
        if(siteId&&!current)throw Error('当前任务库没有该站点配置。');
        if(siteId&&args.expectedRevision===undefined)throw Error('修改已保存的站点需要 expectedRevision。');
        if(current&&current.revision!==args.expectedRevision)throw toolError('SITE_CONFLICT','站点配置已变化。',{revision:current.revision});
        if(args.action==='delete'){
          if(!current)throw Error('删除需要一个已保存站点。');
          await bridge.request('environment.site-delete',{siteId:current.siteId,expectedRevision:current.revision},opts(call));
          return {siteId:current.siteId,deleted:true};
        }
        if(args.patch===undefined)throw Error('保存站点需要具体配置。');
        return bridge.request('environment.site-save',{site:{...(current??defaultSite),...args.patch as Partial<SiteProfileView>}},opts(call));
      })),
    inputTool('job_library','Read, associate, discover, check, repair, rebuild or migrate the native task library. Repair and rebuild use the IDs returned by discovery/check. Migration and recycle clearing retain native impact confirmation.',
      object({action:choice('read','associate','discover','check','repair','rebuild','migrate','empty-recycle'),root:string,mode:choice('create','open'),
        checkId:string,candidateId:string,choices:{type:'object',properties:{},required:[],additionalProperties:string}},[]),
      async(args,call)=>{
        const action=args.action??(args.root!==undefined?'associate':'read');
        if(action==='read')return (await bridge.request('center.read',{},opts(call))).library;
        if(action==='associate'){
          if(typeof args.root!=='string'||args.mode===undefined)throw Error('请指定任务库绝对路径及 open 或 create。');
          return withTaskCenter(bridge,call,()=>bridge.request('library.associate',{root:args.root as string,mode:args.mode as 'create'|'open'},opts(call)),false);
        }
        if(action==='discover'){
          if(typeof args.root!=='string')throw Error('请选择需发现任务的目录。');
          return withTaskCenter(bridge,call,()=>bridge.request('library.discover',{root:args.root as string},opts(call)),false);
        }
        if(action==='check')return withTaskCenter(bridge,call,()=>bridge.request('library.self-check',{repair:false},opts(call)),false);
        if(action==='rebuild'){
          if(typeof args.candidateId!=='string'||args.choices===undefined)throw Error('重建需要候选发现 ID 和明确的分叉选择表。');
          return withTaskCenter(bridge,call,()=>bridge.request('library.rebuild',{candidateId:args.candidateId as string,choices:args.choices as Record<string,string>},opts(call)),false);
        }
        if(action==='repair'){
          if(typeof args.checkId!=='string')throw Error('修复需要现有自检 ID。');
          return withTaskCenter(bridge,call,()=>bridge.request('library.self-check',{repair:true,checkId:args.checkId as string},opts(call)));
        }
        if(action==='migrate'){
          if(typeof args.root!=='string')throw Error('迁移需要明确目标目录。');
          return withTaskCenter(bridge,call,()=>bridge.request('library.migrate',{target:args.root as string},opts(call)));
        }
        return withTaskCenter(bridge,call,()=>bridge.request('library.empty-recycle',{},opts(call)));
      }),
  ];
  return Object.assign(tools,{dispose:()=>reviewed.clear()});
}
