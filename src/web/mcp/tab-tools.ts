import {objectSchema,toolError,type McTool} from './types';

export type TabKind='model-tab'|'conformer-group'|'pes-group'|'file-source'|'analysis-panel'|'plot-window';
export interface WorkspaceTabRecord {
  ref:string;kind:TabKind;ownerId:string;label:string;revision:string;visible:boolean;active:boolean;
  detached?:boolean;groupRef?:string;status?:string;actions?:string[];
}
export interface TabCloseReceipt {
  status:'released'|'cancelled'|'blocked'|'cleanup-pending'|'failed';
  removed:string[];error?:string;cleanupKey?:string;
}
export interface TabCloseAdmission {
  effects:string[];affected:WorkspaceTabRecord[];confirmation:boolean;ownerVersion?:string;
  execute():Promise<TabCloseReceipt>;
}
export type TabManagement=
  |{action:'reorder';refs:string[]}
  |{action:'layout';mode:'single'|'tiled'|'free';arrange:boolean}
  |{action:'detach'|'dock'|'rename'|'group-collapse';ref:string;name?:string;collapsed?:boolean;x?:number;y?:number};
export interface TabToolContext {
  epoch():string;
  read():{tabs:WorkspaceTabRecord[];layout:'single'|'tiled'|'free';workspaceRevision:string};
  prepareClose(target:WorkspaceTabRecord):Promise<TabCloseAdmission>;
  retryRelease(key:string):Promise<void>;
  manage(command:TabManagement):unknown|Promise<unknown>;
}
type PlanRow={ref:string;target?:WorkspaceTabRecord;admission?:TabCloseAdmission;error?:string};
type Plan={id:string;epoch:string;rows:PlanRow[];execution?:string};
type Operation={id:string;phase:'running'|'finished';items:Array<{ref:string;target?:WorkspaceTabRecord}&TabCloseReceipt>};
const string={type:'string',minLength:1};
const bool={type:'boolean'};
const numerical={type:'number'};
const enumOf=(...values:string[])=>({type:'string',enum:values});
const description='List current model tabs and related owner pages, plan and close exact targets, observe release receipts, reorder, arrange, detach/dock, or manage groups. By default plan-close selects only the model tabs currently shown. Closing a model follows ES native workspace discard and preserves external source files.';

function sameTab(a:WorkspaceTabRecord,b:WorkspaceTabRecord){return a.ref===b.ref&&a.kind===b.kind&&a.ownerId===b.ownerId&&a.revision===b.revision;}
function sameImpact(a:TabCloseAdmission,b:TabCloseAdmission){
  return a.confirmation===b.confirmation&&a.ownerVersion===b.ownerVersion&&JSON.stringify(a.effects)===JSON.stringify(b.effects)&&a.affected.length===b.affected.length&&
    a.affected.every(target=>b.affected.some(row=>sameTab(row,target)));
}
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export function tabTools(readContext:()=>TabToolContext|undefined):McTool[] {
  const plans=new Map<string,Plan>(),operations=new Map<string,Operation>();
  let currentEpoch:string|undefined;
  return [{name:'es_tabs',description,inputSchema:objectSchema({
    action:enumOf('list','plan-close','close','status','retry-release','reorder','layout','detach','dock','rename','group-collapse'),
    refs:{type:'array',items:string,minItems:1,uniqueItems:true},ref:string,planId:string,operationId:string,confirmed:bool,expectedRevision:string,
    mode:enumOf('single','tiled','free'),arrange:bool,name:string,collapsed:bool,x:numerical,y:numerical,
  },['action']),async call(args,call){
    const ctx=readContext();if(!ctx)throw Error('当前窗口不拥有可管理的工作台标签。');
    const epoch=ctx.epoch();
    if(currentEpoch!==epoch){plans.clear();operations.clear();currentEpoch=epoch;}
    const current=()=>readContext()?.epoch()===epoch;
    const snapshot=ctx.read();
    if(args.action==='list')return snapshot;
    if(args.action==='status'||args.action==='retry-release'){
      const job=operations.get(String(args.operationId??''));if(!job)throw Error('当前工作台没有该关闭操作。');
      if(args.action==='retry-release')for(const row of job.items){
        if(row.status!=='cleanup-pending'||!row.cleanupKey||args.ref&&args.ref!==row.ref)continue;
        const key=row.cleanupKey;
        try{
          call?.signal.throwIfAborted();if(!current())throw Error('工作台项目已变化。');
          await ctx.retryRelease(key);
          for(const related of job.items)if(related.cleanupKey===key){related.status='released';delete related.cleanupKey;delete related.error;}
        }
        catch(error){row.error=errorText(error);}
      }
      return structuredClone(job);
    }
    if(args.action==='plan-close'){
      const refs=Array.isArray(args.refs)?args.refs:args.ref?[args.ref]:snapshot.tabs.filter(tab=>tab.visible&&tab.kind==='model-tab').map(tab=>tab.ref);
      if(!refs.length)return {status:'empty',tabs:[]};
      const plan:Plan={id:crypto.randomUUID(),epoch,rows:[]};
      for(const ref of refs){
        call?.signal.throwIfAborted();
        const target=snapshot.tabs.find(row=>row.ref===ref);
        if(!target){plan.rows.push({ref,error:'当前工作台没有指定标签或页面。'});continue;}
        try{plan.rows.push({ref,target,admission:await ctx.prepareClose(target)});}catch(error){plan.rows.push({ref,target,error:errorText(error)});}
      }
      if(!current())throw Error('工作台项目在规划期间已更换。');
      plans.set(plan.id,plan);
      return {planId:plan.id,requiresConfirmation:plan.rows.some(row=>row.admission?.confirmation),items:plan.rows.map(({ref,target,admission,error})=>({ref,target,
        status:admission?'ready':target?'blocked':'unavailable',affected:admission?.affected,effects:admission?.effects,error}))};
    }
    if(args.action==='close'){
      call?.signal.throwIfAborted();
      const plan=plans.get(String(args.planId??''));if(!plan||plan.epoch!==epoch)throw Error('请从当前工作台取得关闭计划。');
      if(plan.execution)return structuredClone(operations.get(plan.execution));
      if(plan.rows.some(row=>row.admission?.confirmation)&&args.confirmed!==true)return {planId:plan.id,status:'confirmation-required'};
      const job:Operation={id:crypto.randomUUID(),phase:'running',items:[]};operations.set(job.id,job);plan.execution=job.id;
      void Promise.resolve().then(async()=>{
        const accounted=new Map<string,TabCloseReceipt>();
        for(const {ref,target,admission,error}of plan.rows){
          let receipt:TabCloseReceipt;
          try{
            const covered=target&&accounted.get(ref);
            if(covered)receipt={...covered,removed:[ref]};
            else if(!current())receipt={status:'cancelled',removed:[],error:'工作台项目已变化。'};
            else if(!target||!admission)receipt={status:'blocked',removed:[],error};
            else{
              const owner=readContext()!;
              const live=owner.read().tabs.find(row=>row.ref===target.ref);
              if(!live||!sameTab(live,target))throw Error('标签或其模型已变化，请重新规划。');
              const next=await owner.prepareClose(live);
              if(!current()||!sameImpact(admission,next))throw Error('关闭影响已变化，请重新规划。');
              receipt=await next.execute();
              for(const ref of receipt.removed)accounted.set(ref,receipt);
            }
          }catch(error){receipt={status:'blocked',removed:[],error:errorText(error)};}
          job.items.push({ref,target,...receipt});
        }
        job.phase='finished';
      });
      return {operationId:job.id,status:'closing'};
    }
    call?.signal.throwIfAborted();
    if(args.expectedRevision!==snapshot.workspaceRevision)throw toolError('revision_conflict','工作台标签布局或所有权已变化，请重新列出标签。',snapshot);
    async function manage(action:TabManagement){
      const result=await ctx!.manage(action);
      if(!current())throw Error('工作台项目在操作期间已更换。');
      const live=readContext()!.read();
      return {...(result&&typeof result==='object'?result:{}),workspaceRevision:live.workspaceRevision,
        ...(action.action==='reorder'?{actualOrder:live.tabs.filter(tab=>tab.kind==='model-tab'&&tab.visible).map(tab=>tab.ref)}:{})};
    }
    switch(args.action){
      case 'reorder':if(!Array.isArray(args.refs))throw Error('请指定现有模型标签的完整顺序。');return manage({action:args.action,refs:args.refs as string[]});
      case 'layout':if(!['single','tiled','free'].includes(String(args.mode)))throw Error('请选择布局。');return manage({action:args.action,mode:args.mode as 'single'|'tiled'|'free',arrange:args.arrange===true});
      case 'detach':case 'dock':case 'rename':case 'group-collapse':
        if(typeof args.ref!=='string')throw Error('需要指定标签或任务组。');
        return manage({action:args.action,ref:args.ref,name:args.name as string|undefined,collapsed:args.collapsed as boolean|undefined,x:args.x as number|undefined,y:args.y as number|undefined});
      default:throw Error('未知标签操作。');
    }
  }}];
}
