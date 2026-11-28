import type { WorkspaceRegistry } from '../../modeling/workspace-registry';
import type { ProjectSessionDescription } from '../../projects/desktop-bridge';
import { mcpBridge } from './bridge';
import type { WorkspaceChanges } from './changes';
import { objectSchema, presentationFields, toolError, type McCall, type McTool } from './types';
import { batchCounts, makeBatchReceipt, finishBatchReceipt, type BatchReceipt } from './batch-receipts';
import { inlineStructureItem, structureSourceTool } from './structure-source-tools';
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
  structureSource?(args:Args,call:McCall):Promise<unknown>;
  exportFile(args:Args,call:McCall):Promise<unknown>;
  tools():McTool[];
  batchReceipts:Map<string, BatchReceipt>;
}
const string={type:'string',minLength:1};
const boolean={type:'boolean'};
const toolFamilies:ReadonlyArray<readonly [RegExp,string]> = [
  [/^(es_(connect|context|targets|tabs|show|project|import|export|capabilities)$|source_attach$|file_)/, '窗口、项目和文件'],
  [/^(structure_source$|sketch_|model_(fragment|library|personal_))/, '片段、结构库和二维'],
  [/^(model_|history_)/, '建模和选择'],
  [/^(analysis_|vibration_|plot_|view_export$)/, '分析、绘图和图像'],
  [/^(view_|frames?_|trajectory_|result_)/, '视图、轨迹和结果'],
  [/^(input_|job_)/, '输入和外部作业'],
  [/^es_(opt_|md_|xtb2_|conformer_|pes_|ci_neb_|run_)/, 'ES 内部计算'],
  [/^(settings_|compute_|multiwfn_|gxtb_|citation_|batch_)/, '设置、环境与组合'],
];
function toolTopic(name:string) {
  return toolFamilies.find(([family])=>family.test(name))?.[1]??'其他操作';
}

const capabilityIntents: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/原始.{0,8}跃迁|跃迁.{0,6}表|raw transitions|transition table/u, ['result_read', 'plot_export', 'analysis_view']],
  [/溶剂|气相|solvents?|solvation|\bsmd\b|\biefpcm\b|\bcpcm\b/u, ['input_solvents', 'input_draft', 'input_preview']],
  [/相机|机位|视角|裁剪.{0,6}(图|图像)|camera|cropp?ing/u, ['view_camera', 'view_export', 'view_style']],
  [/裁剪.{0,6}轨迹|截取.{0,6}轨迹|抽帧|subsample|crop trajectory/u, ['trajectory_derive', 'frames_select', 'trajectory_export']],
  [/目录|列文件|找文件|directory|folder/u, ['file_list', 'file_inspect', 'es_import']],
  [/取帧|第.+帧|轨迹|conformer frame|trajectory|frame selection/u, ['frames_select', 'frame_read', 'trajectory_view', 'trajectory_export']],
  [/构象|conformer|conformational/u, ['es_conformer_read', 'es_conformer_configure', 'es_conformer_run', 'frames_select']],
  [/虚频|反应模态|振动|hessian|imaginary|normal mode/u, ['es_pes_mode_read', 'vibration_view', 'es_run_read', 'input_assets']],
  [/扫描曲线|势能曲线|scan profile|scan energy/u, ['result_read', 'plot_open', 'plot_export']],
  [/内坐标扫描|松弛扫描|relaxed scan|ci neb|过渡态|\birc\b/u, ['es_pes_parameters', 'es_pes_configure', 'es_pes_run', 'es_run_read']],
  [/光谱|跃迁|吸收谱|spectrum|spectra|transitions/u, ['result_read', 'analysis_view', 'plot_configure', 'plot_export']],
  [/输入文件|配套文件|批量输入|input file|input bundle/u, ['input_draft', 'input_generate', 'input_batch', 'input_bind_endpoints', 'input_assets']],
];

function searchKey(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function discoverCapabilities(tools: McTool[], query: string) {
  if (!query) return tools;
  const key = searchKey(query);
  const words = key.split(' ').filter(Boolean);
  const suggested = new Map<string,number>();
  for (const [intent, [pattern, names]] of capabilityIntents.entries()) {
    if (!pattern.test(key)) continue;
    names.forEach((name, order) => {
      if (!suggested.has(name)) suggested.set(name, 80 - intent - order);
    });
  }
  return tools.map(tool => {
    const name = searchKey(tool.name);
    const corpus = searchKey([tool.name, tool.description, toolTopic(tool.name), JSON.stringify(tool.inputSchema)].join(' '));
    const score = tool.name === query || name === key ? 100
      : suggested.get(tool.name) ?? (name.includes(key) ? 40
        : corpus.includes(key) ? 20
        : words.length > 1 && words.every(word => corpus.includes(word)) ? 10 : 0);
    return { tool, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).map(row => row.tool);
}

function capabilityGuide(tools:McTool[]) {
  const groups=new Map<string,string[]>();
  for(const tool of tools){
    const topic=toolTopic(tool.name);
    const names=groups.get(topic)??[];
    names.push(tool.name);
    groups.set(topic,names);
  }
  const topics=Array.from(groups,([topic,names])=>({topic,tools:names}));
  const guide=[
    '# Ester Studio MCP',
    '连接后用 es_context 读取绑定窗口的项目、模型和当前帧。用 es_targets 定位其他对象。',
    '用 es_capabilities({"query":"建模"}) 搜索，或用 es_capabilities({"action":"model_read"}) 读参数和单位。取回执中的 modelRef、frameRef、runId 或已保存文件路径接续。',
    '可见操作默认跟随 ES 目标窗口。支持 presentation 的工具可按任务选择 background，显式 foreground 可恢复和置前窗口。',
    '长程任务沿原 runId 观察。遇到拒绝时按返回的原因、受影响对象和 recovery 选择下一步。',
    '便携包 harness/skills/ester-studio 提供可选的使用指导。MCP 连接页可另存完整 Skill ZIP。',
    ...topics.map(group=>'- '+group.topic+'：'+group.tools.join('、')),
  ].join('\n\n');
  return {format:'text/markdown',guide,topics};
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
    tool('es_capabilities','Find live ES operations by goal, e.g. 扫描曲线 (scan curve), 虚频 (imaginary mode), or list directory files. Use action for one exact tool schema, limit for a short search result, or guide=true for an overview.',
      {action:string,query:string,guide:boolean,limit:{type:'integer',minimum:1}},[],a=>{
        const tools=ctx.tools();
        if(a.guide)return capabilityGuide(tools);
        if(a.action){const item=tools.find(t=>t.name===a.action);if(!item)throw toolError('tool-unavailable','当前 ES 窗口没有这个工具。可按功能搜索已发布的操作。',{
          action:a.action,recovery:{tool:'es_capabilities',arguments:{query:a.action,limit:8}},
        });
          return {name:item.name,description:item.description,inputSchema:item.inputSchema};}
        const query=String(a.query??'').trim().toLowerCase();
        const matches=discoverCapabilities(tools,query);
        const selected=a.limit===undefined?matches:matches.slice(0,Number(a.limit));
        return {total:matches.length,tools:selected.map(t=>({name:t.name,description:t.description,topic:toolTopic(t.name)})),context:ctx.readContext()};
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
    tool('es_import','Load absolute paths or inline structure text into ES. For inline data pass {text, format, name?, source?} in items; its default is structure mode. Path-only auto mode uses native recognition; analysis loads scientific results from files. The receipt identifies the created objects.',
      {items:{type:'array',minItems:1,items:{oneOf:[string,objectSchema({path:string},['path']),inlineStructureItem]}},
        mode:{enum:['auto','structure','analysis']},show:boolean,...presentationFields},['items'],(a,c)=>ctx.importFiles(a,requireCall(c),false)),
    tool('file_list','List directory files from one user-authorized absolute directory. Returns regular files directly in that directory with names, absolute paths and byte sizes. Use extension or query to filter and nextCursor to continue. Pass a returned path to es_import or file_inspect.',
      {directory:string,extension:{...string,description:'Optional case-insensitive extension, e.g. out or .out.'},query:{type:'string',description:'Optional case-insensitive filename substring.'},
        cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,description:'Page size, defaults to 100.'}},['directory'],(_a,c)=>{
        const call=requireCall(c);
        return mcpBridge()!.file({requestId:call.requestId,batchIndex:call.batchIndex,action:'list-files'});
      }),
    tool('file_inspect','Read a specific user-authorized local file by absolute path. Returns its byte size and, when requested, bounded UTF-8 text from the beginning or end and the SHA-256 hash of the original bytes. Useful for checking Gaussian/ORCA termination and matching saved input dependencies without importing or changing the file.',
      {path:string,headBytes:{type:'integer',minimum:0,maximum:65536},tailBytes:{type:'integer',minimum:0,maximum:65536},sha256:boolean},['path'],(_a,c)=>{
        const call=requireCall(c);
        return mcpBridge()!.file({requestId:call.requestId,batchIndex:call.batchIndex,action:'inspect-file'});
      }),
    ...(ctx.structureSource ? [structureSourceTool((a,c)=>ctx.structureSource!(a,c))] : []),
    tool('source_attach','Attach an output, wavefunction or companion by owner, result, source or exact file-job reference. Returns native slots and verified file-job bindings.',
      {result:string,asset:string,role:string,replace:boolean},['result','asset'],(a,c)=>ctx.importFiles(a,requireCall(c),true)),
    tool('es_export','Export geometry from a specified model or immutable result frame. SDF and MOL have empty bond tables and omit bond-dependent stereo annotations. Preserve the editable ES model, including its bonds, with es_project. If destination is omitted, use the portable harness export directory. Pass allowLosses to accept reported format losses.',
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
