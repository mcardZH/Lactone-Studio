import type { PreviewSourceIdentity, TaskSystemBridge, TaskSystemCommands } from '../../task-system/application-contracts';
import { boolean, choice, inputTool, list, nullable, object, string } from './input-arguments';
import type { InputToolsContext } from './input-tools';
import { withTaskCenter } from './input-settings-tools';
import { mcpBridge } from './bridge';
import { toolError, type McCall, type McTool } from './types';

const offset={type:'integer',minimum:0};
const sourceIdentity=object({taskId:nullable(string),artifactId:string,environmentId:string,path:string,fileId:nullable(string),sourceGeneration:nullable(string)},
  ['taskId','artifactId','environmentId','path','fileId']);
const previewSourceFields={artifactId:string,expectedSourceIdentity:sourceIdentity};
const frameCursor=object({offset,collectionId:string,revision:string},['offset']);
const monitorSettings=object({localIntervalSeconds:{type:'number'},remoteIntervalSeconds:{type:'number'},backgroundIntervalSeconds:{type:'number'},automatic:boolean},
  ['localIntervalSeconds','remoteIntervalSeconds','backgroundIntervalSeconds','automatic']);

function waitForTaskUpdate(ms:number,signal?:AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

export function jobMonitorTools(ctx:InputToolsContext,bridge:TaskSystemBridge):McTool[]{
  const signal=(call?:McCall)=>({signal:call?.signal});
  async function filePreview<T extends 'preview.read'|'preview.find'>(command:T,args:Record<string,unknown>,call?:McCall){
    const ownerId=`mcp-preview-${crypto.randomUUID()}`;
    try{return await bridge.request(command,{...args,ownerId} as TaskSystemCommands[T]['input'],signal(call));}
    catch(cause){
      if(cause instanceof Error&&/\bPREVIEW_SOURCE_CHANGED\b/.test(cause.message))
        throw toolError('PREVIEW_SOURCE_CHANGED','作业文件的位置或来源已变化。通过 job_read 取最新 artifactId，必要时再从该文件的实际读回使用 sourceIdentity。',{artifactId:args.artifactId});
      throw cause;
    }
    finally{await bridge.request('preview.release',{ownerId}).catch(()=>{});}
  }
  return [
    inputTool('job_read','Read the current committed task state. refresh=true schedules a native observation and returns the current state immediately. To await the submitted run use job_wait with its taskId and runId. To page real frames use frames.offset and the returned frameCursor.',
      object({taskId:string,refresh:boolean,frames:frameCursor},['taskId']),async(args,call)=>{
        const taskId=args.taskId as string,requested=args.frames as {offset:number;collectionId?:string;revision?:string}|undefined;
        if(requested?.offset&&(!requested.collectionId||!requested.revision))throw Error('继续读帧需要上一页的 collectionId 和 revision。');
        if(!args.refresh&&!requested)return bridge.request('task.details',{taskId},signal(call));
        return withTaskCenter(bridge,call,async()=>{
          const pageOwner=crypto.randomUUID();
          try{
            const {framePage,...view}=await bridge.request('monitor.read',{taskId,refresh:args.refresh===true,knownRevision:null,pagedFrames:true,pageOwner},signal(call));
            if(requested?.collectionId&&requested.collectionId!==view.collectionId||requested?.revision&&requested.revision!==view.revision)
              throw toolError('JOB_SOURCE_CHANGED','任务结果集合已有新版本，请重新读取当前页。',{collectionId:view.collectionId,revision:view.revision});
            if(!framePage||!view.collectionId||!view.revision)return {...view,frameCursor:null};
            const cursor={collectionId:view.collectionId,revision:view.revision,offset:0};
            if(!requested)return {...view,frameCursor:cursor};
            if(requested.offset>=framePage.count)throw Error('请求的页起点超出当前任务结果。');
            const page=await bridge.request('monitor.frames',{taskId,...cursor,token:framePage.token,offset:requested.offset,pageOwner},signal(call));
            if(page.taskId!==taskId||page.collectionId!==cursor.collectionId||page.revision!==cursor.revision||page.token!==framePage.token||
              page.count!==framePage.count||page.offset!==requested.offset||page.nextOffset<=page.offset||page.nextOffset>page.count||
              page.framesDelta.length!==page.nextOffset-page.offset)throw Error('任务监控分页回执身份不一致。');
            return {...view,framesDelta:page.framesDelta,frameCursor:page.nextOffset===page.count?null:{...cursor,offset:page.nextOffset}};
          }finally{await bridge.request('monitor.release',{taskId,pageOwner}).catch(()=>{});}
        },false);
      }),
    inputTool('job_wait','Wait up to waitMs for the exact submitted task and run to reach native terminal execution and settle result preparation. Read the returned waitDisposition and actual exit, verification and result-source fields. Waiting or cancelling this observation never stops the job.',
      object({taskId:string,runId:string,waitMs:{type:'integer',minimum:0}},['taskId','runId','waitMs']),async(args,call)=>{
        const taskId=args.taskId as string,runId=args.runId as string,waitMs=args.waitMs as number;
        if(!Number.isSafeInteger(waitMs)||waitMs<0)throw toolError('invalid_arguments','waitMs 需要非负整数。');
        const started=performance.now();
        while(true){
          call?.signal.throwIfAborted();
          const state=await bridge.request('task.details',{taskId},signal(call)),task=state.task;
          if(task.runId!==runId)return {...state,waitDisposition:'run-changed',requestedRunId:runId};
          const preparing=task.stopControl?.targets.includes('result-preparation');
          if(task.executionState==='ended'&&!preparing&&task.verificationState!=='unknown')return {...state,waitDisposition:'observed-terminal'};
          const left=waitMs-(performance.now()-started);
          if(left<=0)return {...state,waitDisposition:'observation-timeout'};
          await waitForTaskUpdate(Math.min(left,500),call?.signal);
        }
      }),
    inputTool('job_open_snapshot','Open the actual task’s managed scientific result in the current ES project. Pass the submitted runId to pin that run even if the task has since been resubmitted. show explicitly selects the imported result. Read documentId and sourceId from the receipt for subsequent result_read calls.',
      object({taskId:string,runId:string,show:boolean},['taskId']),async(args,call)=>{
        if(!ctx.openJobSnapshot)throw Error('当前窗口不能接管任务结果。');
        const taskId=args.taskId as string,bound=ctx.projectScope?.()??ctx.projectId();
        const current=()=>bound===(ctx.projectScope?.()??ctx.projectId())&&!call?.signal.aborted;
        return withTaskCenter(bridge,call,async()=>{
          const runId=args.runId as string|undefined;
          const lease=await bridge.request('snapshot.open',{taskId,...(runId?{target:{runId}}:{})},signal(call));
          try{
            if(!current())throw Error('任务快照准备期间目标项目已变化。');
            const received=await ctx.openJobSnapshot!(taskId,lease.snapshotId,lease.leaseId,()=>args.show===true&&current());
            if(!received||received.taskId!==taskId||runId&&received.runId!==runId)throw Error('任务快照未返回本次指定运行已接管的结果对象。');
            return {...received,snapshotId:lease.snapshotId,status:'opened'};
          }catch(error){await bridge.request('snapshot.release',lease).catch(()=>{});throw error;}
        },false);
      }),
    inputTool('job_file_read','Read bounded text from a registered task artifact. Use job_read files[].artifactId. expectedSourceIdentity is optional; for pinned follow-up reads, copy sourceIdentity from an actual file read.',
      object({...previewSourceFields,anchor:{anyOf:[offset,choice('tail')]},maxBytes:{type:'integer',minimum:1}},['artifactId','anchor','maxBytes']),
      (args,call)=>filePreview('preview.read',args,call)),
    inputTool('job_file_find','Search a registered task artifact by artifactId. Continue a native search with the returned searchEndByte and nextByte as fromByte. If pinning the source, reuse the actual sourceIdentity from job_file_read.',
      object({...previewSourceFields,query:string,fromByte:offset,searchEndByte:offset,direction:choice('next','previous')},['artifactId','query','fromByte','direction']),
      (args,call)=>filePreview('preview.find',args,call)),
    inputTool('job_file_export','Save the exact registered job artifact to a new local absolute destination. The native copier verifies source identity and bytes without changing the original.',
      object({...previewSourceFields,destination:string},['artifactId','destination']),async(_args,call)=>{
        const desktop=mcpBridge();
        if(!desktop||!call)throw Error('当前会话不可保存任务文件。');
        return desktop.file({requestId:call.requestId,action:'task-file-copy',...(call.batchIndex===undefined?{}:{batchIndex:call.batchIndex})});
      }),
    inputTool('job_task_rename','Rename the existing task card, preserving input, execution and run identity.',
      object({taskId:string,displayName:string},['taskId','displayName']),
      (args,call)=>withTaskCenter(bridge,call,async()=>{
        const input=args as TaskSystemCommands['task.rename']['input'];
        await bridge.request('task.rename',input,signal(call));
        return bridge.request('task.details',{taskId:input.taskId},signal(call));
      })),
    inputTool('job_group','Create, rename, move, delete, or change membership of an actual native task group.',
      object({action:choice('save','move','delete','membership'),groupId:string,parentGroupId:nullable(string),beforeGroupId:nullable(string),
        displayName:string,order:offset,taskIds:list(string),mode:choice('add','remove')},['action']),
      (args,call)=>withTaskCenter(bridge,call,async state=>{
        const action=args.action,groupId=args.groupId as string;
        if(action==='save'){
          if(typeof args.displayName!=='string')throw Error('保存组需要名称。');
          const current=state.groups.find(group=>group.groupId===groupId);
          if(groupId&&!current)throw Error('当前任务库没有指定组。');
          const parentGroupId=args.parentGroupId===undefined?current?.parentGroupId??null:args.parentGroupId as string|null;
          await bridge.request('group.save',{groupId,parentGroupId,displayName:args.displayName,order:args.order as number|undefined},signal(call));
        }else{
          if(!groupId)throw Error('请指定任务组。');
          if(action==='move'){
            if(args.parentGroupId===undefined)throw Error('移动组时请指定 parentGroupId，可用 null 表示根组。');
            await bridge.request('group.move',{groupId,parentGroupId:args.parentGroupId as string|null,beforeGroupId:args.beforeGroupId as string|null|undefined},signal(call));
          }else if(action==='delete')await bridge.request('group.delete',{groupId},signal(call));
          else{
            if(!Array.isArray(args.taskIds)||!args.taskIds.length||args.mode===undefined)throw Error('请明确指定任务名单与加入或移出。');
            await bridge.request('group.membership',{groupId,taskIds:args.taskIds as string[],mode:args.mode as 'add'|'remove'},signal(call));
          }
        }
        return {action,groups:(await bridge.request('center.read',{},signal(call))).groups};
      })),
    inputTool('job_monitor_settings','Read or save the native task-library monitor intervals and automatic refresh preference.',
      object({settings:monitorSettings}),async(args,call)=>{
        if(args.settings===undefined)return (await bridge.request('center.read',{},signal(call))).monitoring;
        return withTaskCenter(bridge,call,()=>bridge.request('monitor.settings',args.settings as TaskSystemCommands['monitor.settings']['input'],signal(call)));
      }),
  ];
}
