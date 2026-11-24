import usageGuide from '../../../docs/es-mcp.md?raw';
import type { WorkspaceRegistry } from '../../modeling/workspace-registry';
import type { ProjectSessionDescription } from '../../projects/desktop-bridge';
import { mcpBridge } from './bridge';
import type { WorkspaceChanges } from './changes';
import { objectSchema, presentationFields, toolError, type McCall, type McTool } from './types';
import { batchCounts, makeBatchReceipt, finishBatchReceipt, type BatchReceipt } from './batch-receipts';
export type { BatchReceipt } from './batch-receipts';

type Args = Record<string,unknown>;
export interface CoreToolContext {
  registry:WorkspaceRegistry;
  changes:WorkspaceChanges;
  readContext():Args;
  objects(kind?:string):Promise<Array<{kind:string;ref:string;label:string;[key:string]:unknown}>>;
  show(args:Args,call?:McCall):Promise<unknown>;
  project():ProjectSessionDescription|null;
  save(asNew:boolean,target?:{name:string;locationToken:string}):Promise<boolean>;
  reopen?(options:{unsaved?:'error'|'save'|'discard';signal?:AbortSignal}):Promise<ProjectSessionDescription>;
  importFiles(args:Args,call:McCall,attach:boolean):Promise<unknown>;
  exportFile(args:Args,call:McCall):Promise<unknown>;
  tools():McTool[];
  batchReceipts:Map<string, BatchReceipt>;
}
const string={type:'string',minLength:1};
const boolean={type:'boolean'};
const guideTopics = new Map<string,string>();
for (const row of usageGuide.split(/\r?\n/)) {
  if (!row.startsWith('|')) continue;
  const topic = row.split('|')[1].trim().toLowerCase();
  for (const match of row.matchAll(/`([a-z][a-z0-9_]+)`/g)) guideTopics.set(match[1], topic);
}
function requireCall(call?:McCall) {
  if(!call)throw Error('需要连接到当前窗口的 Agent。');
  return call;
}

function memberStatus(value:unknown): 'returned'|'pending'|'partial'|'failed' {
  if (!value || typeof value !== 'object') return 'returned';
  const detail = value as Args;
  if (detail.ready === false || detail.accepted === false || detail.written === false ||
      ['failed','error','rejected','cancelled','interrupted'].includes(String(detail.status))) return 'failed';
  if (detail.status === 'partial' || detail.status === 'publication_unconfirmed' || detail.deliveryIssue) return 'partial';
  if (detail.status === 'analysis_view_preparing' || detail.status === 'preparing') return 'pending';
  for (const children of [detail.items, detail.files, detail.delivery]) {
    if (Array.isArray(children) && children.some(child => memberStatus(child) !== 'returned')) return 'partial';
  }
  return 'returned';
}

export function workspaceTools(ctx:CoreToolContext):McTool[] {
  const tool=(name:string,description:string,props:Args,required:string[],call:McTool['call']):McTool=>
    ({name,description,inputSchema:objectSchema(props,required),call});
  return [
    tool('es_context','Read the bound live window, project, model, actual and requested frames, selections and changes since cursor. waitMs waits for a committed change.',
      {since:{type:'integer',minimum:0},waitMs:{type:'integer',minimum:0},targetRef:string,kinds:{type:'array',items:string}},[],async (a,call)=>{
        const since=a.since as number|undefined, wait=a.waitMs as number|undefined;
        if(since!==undefined&&!(Number.isSafeInteger(since)&&since>=0))throw Error('变更游标无效。');
        if(wait!==undefined&&!(Number.isSafeInteger(wait)&&wait>=0&&wait<=2147483647))throw Error('等待时长无效。');
        const filter={target:a.targetRef as string|undefined,kinds:a.kinds as string[]|undefined};
        if(since!==undefined&&wait)await ctx.changes.wait(since,wait,call?.signal,filter);
        return {...ctx.readContext(),window:call&&{instanceId:call.session.instanceId,windowId:call.session.windowId},...ctx.changes.read(since,filter)};
      }),
    tool('es_capabilities','Discover live ES operations. Specify action for its full input schema, query for names, topics, descriptions and schema terms, or guide=true for usage examples.',
      {action:string,query:string,guide:boolean},[],a=>{
        if(a.guide)return {format:'text/markdown',guide:usageGuide};
        const tools=ctx.tools();
        if(a.action){const item=tools.find(t=>t.name===a.action);if(!item)throw Error('未找到指定工具。');
          return {name:item.name,description:item.description,inputSchema:item.inputSchema};}
        const query=String(a.query??'').trim().toLowerCase();
        const matches=query?tools.filter(t=>[t.name,t.description,guideTopics.get(t.name)??'',JSON.stringify(t.inputSchema)]
          .some(value=>value.toLowerCase().includes(query))):tools;
        return {tools:matches.map(t=>({name:t.name,description:t.description})),context:ctx.readContext()};
      }),
    tool('es_targets','Find models, projects, tasks, plots, sources and results in this workspace. For ordered frames use frames_select.',
      {kind:string,query:string,cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},[],async a=>{
        const query=String(a.query??'').toLowerCase();
        const list=(await ctx.objects(a.kind as string|undefined)).filter(item=>(!a.kind||item.kind===a.kind)&&[item.ref,item.label,item.collectionId,item.taskId,item.runId,item.stageId,item.ownerId].some(s=>typeof s==='string'&&s.toLowerCase().includes(query)));
        const start=Number(a.cursor??0),limit=Number(a.limit??100);
        if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<1)throw Error('分页参数无效。');
        return {total:list.length,items:list.slice(start,start+limit),nextCursor:start+limit<list.length?start+limit:null};
      }),
    tool('es_show','Present a model, result, task, plot or frame in its native ES workspace. Pass the ref returned by es_targets/frames_select. foreground requests window focus.',
      {target:{oneOf:[string,{type:'object',properties:{kind:string,ref:string},required:['kind','ref']}]},...presentationFields,foreground:boolean,module:{enum:['modeling','input','analysis','advanced','advanced-modeling']},waitFor:{enum:['scene','selected']}},['target'],(a,c)=>ctx.show(a,c)),
    tool('es_project','Read, create, open, recover, save, save-as, reopen or close an ES project. Use open-status with the same path to see a queued open settle; retry only a failed or cancelled open. reopen re-reads the current project’s manual .es save in the same window and keeps the Agent connection. For unsaved edits choose unsaved=save or discard explicitly. close closes the bound window and can end its Agent connection. Paths are absolute .es index paths. Opening returns the actual owner window.',
      {action:{enum:['read','new','open','open-status','recover','save','save-as','reopen','close']},path:string,retry:boolean,projectRef:string,interactive:boolean,recovery:{enum:['inspect','auto','previous']},unsaved:{enum:['error','save','discard']}},['action'],async(a,c)=>{
        const current=ctx.project();
        if(a.projectRef&&a.projectRef!==current?.projectId)throw Error('项目身份已变化。');
        if(a.action==='read')return ctx.readContext().project;
        const bridge=mcpBridge()!,call=requireCall(c);
        if(a.action==='reopen'){
          if(!ctx.reopen)throw toolError('UNAVAILABLE','当前窗口没有项目重开入口。');
          if(a.path&&a.path!==current?.indexPath)throw toolError('PROJECT_CHANGED','reopen 只重开当前项目，请使用 open 打开其他 .es 入口。',{project:ctx.readContext().project});
          const reopened=await ctx.reopen({unsaved:a.unsaved as 'error'|'save'|'discard'|undefined,signal:call.signal});
          const {projectId,indexPath,manifest,issues,writeProtection}=reopened;
          const generation=manifest?.generation;
          return {status:'reopened',project:{projectId,path:indexPath,generation,writeProtection:writeProtection??null},projectId,path:indexPath,
            generation,issues,window:{instanceId:call.session.instanceId,windowId:call.session.windowId}};
        }
        if(a.action==='save'||a.action==='save-as'){
          let target;
          if(a.path&&(a.action==='save-as'||!current))target=await bridge.file({requestId:call.requestId,batchIndex:call.batchIndex,action:'save-location'}) as {name:string;locationToken:string};
          if(a.action==='save'&&current&&a.path&&a.path!==current.indexPath)throw Error('请选择 save-as 保存到其他位置。');
          if(!target&&(!current||a.action==='save-as')&&!a.interactive)throw toolError('destination_required','请指定 .es 路径，或传 interactive=true 让客户在本窗口选择保存位置。');
          if(!await ctx.save(a.action==='save-as',target))throw toolError('PROJECT_SAVE_CANCELLED','项目保存已取消。',{project:ctx.readContext().project});
          return {saved:true,project:ctx.readContext().project};
        }
        return bridge.file({requestId:call.requestId,batchIndex:call.batchIndex,action:a.action});
      }),
    tool('es_import','Load files into ES. mode=structure takes a geometry, analysis loads scientific results, auto uses ES format recognition. The receipt identifies the created objects.',
      {items:{type:'array',minItems:1,items:{oneOf:[string,{type:'object',properties:{path:string},required:['path'],additionalProperties:false}]}},
        mode:{enum:['auto','structure','analysis']},show:boolean},['items'],(a,c)=>ctx.importFiles(a,requireCall(c),false)),
    tool('source_attach','Attach an output, wavefunction or companion by owner, result, source or exact file-job reference. Returns native slots and verified file-job bindings.',
      {result:string,asset:string,role:string,replace:boolean},['result','asset'],(a,c)=>ctx.importFiles(a,requireCall(c),true)),
    tool('es_export','Capture a specified model or immutable result frame and export its structure to a file. If destination is omitted, use the portable harness export directory. Pass allowLosses to accept reported format losses.',
      {target:string,format:string,destination:string,directory:string,onExists:{enum:['error','overwrite']},allowLosses:boolean},['format'],(a,c)=>ctx.exportFile(a,requireCall(c))),
    tool('file_write_text','Save exact UTF-8 text to an absolute destination, or provide fileName to create it in the portable harness work directory. Returns the verified path and byte count. Import the file into the workbench separately with es_import, or preflight a job with job_preview.',
      {destination:string,fileName:string,text:{type:'string'},onExists:{enum:['error','overwrite']}},['text'],(_args,c)=>{
        const call=requireCall(c);
        return mcpBridge()!.file({requestId:call.requestId,batchIndex:call.batchIndex,action:'write-text'});
      }),
    tool('batch_apply','Apply one ES operation to ordered per-item arguments. Independent items continue by default. Returns individual results/run IDs or errors. Use id to read a known batch.',
      {action:string,id:string,items:{type:'array',items:{type:'object'}},commonOptions:{type:'object'},onError:{enum:['continue','stop']}},[],async(a,call)=>{
        if(a.id){const existing=ctx.batchReceipts.get(String(a.id));if(!existing)throw Error('本工作台没有此批次。');return {...existing,counts:batchCounts(existing.requested,existing.items)};}
        const op=ctx.tools().find(t=>t.name===a.action);
        if(!op||op.name==='batch_apply'||!Array.isArray(a.items)||!a.items.length)throw Error('请选择可批量操作及非空对象列表。');
        const receipt=makeBatchReceipt(op.name,a.items.length);
        ctx.batchReceipts.set(receipt.id,receipt);
        for(const [index,item] of a.items.entries()){
          if(call?.signal.aborted){receipt.status='interrupted';break;}
          try{
            if(!item||typeof item!=='object'||Array.isArray(item))throw Error('批次成员需要具名参数。');
            const args={...(a.commonOptions as Args??{}),...item};
            const result=await op.call(args,call&&{...call,batchIndex:index});
            const status=memberStatus(result);
            receipt.items.push({index,status,result});
            if((status==='failed'||status==='partial')&&a.onError==='stop')break;
          }catch(error){
            const detail=error as {code?:string;data?:unknown}|null;
            receipt.items.push({index,status:'failed',error:error instanceof Error?error.message:String(error),code:detail?.code,data:detail?.data});
            if(a.onError==='stop')break;
          }
        }
        return finishBatchReceipt(receipt);
      }),
  ];
}
