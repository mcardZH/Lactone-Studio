import type { SubmitTaskInput, SubmitTaskRequest, TaskSystemBridge, TaskSystemCommands } from '../../task-system/application-contracts';
import { createTaskSystemBridge } from '../../task-system/integration/desktop-bridge';
import { gaussianExternalInputDraft, type ExternalInputDraft, type ExternalInputDependency } from '../../task-system/integration/input-draft';
import { stageExternalInput } from '../../task-system/integration/stage-input';
import { launchSourceFile, type LaunchImportBridge, type LaunchSourceDescriptor } from '../../modeling/platform/launch-import';
import type { ScientificSourceFile } from '../../results/input-file';
import { liveInputFor } from './input-drafts';
import { boolean, choice, expectedDraft, inputTool, integer, list, modelRef, object, positive, string } from './input-arguments';
import type { InputToolsContext } from './input-tools';
import { withTaskCenter } from './input-settings-tools';
import { toolError, type McCall, type McTool } from './types';
import { mcpBridge } from './bridge';
import { jobMonitorTools } from './job-monitor-tools';

type SubmissionReceipt = TaskSystemCommands['submission.submit']['result'];
type ProjectScope = string | number | null;
type PreviewEnvironment=NonNullable<TaskSystemCommands['submission.preview']['result']['executionEnvironment']>;
type RegisteredSubmission=SubmissionReceipt&{status:'registered';libraryId:string;projectId?:string|null;environmentId:string;
  engineId:SubmitTaskInput['engineId'];executionEnvironment?:PreviewEnvironment;submissionIntentId?:string};
type SubmittedPlan = { libraryId:string; session:string; project:ProjectScope; request:SubmitTaskRequest; dependencies:string[];
  executionEnvironment?:PreviewEnvironment; receipt?:RegisteredSubmission; flight?:Promise<RegisteredSubmission>; dispatchUnresolved?:boolean };
type OperationOwnership = { libraryId:string; session:string; execution?:TaskSystemCommands['operation.execute']['result']; flight?:Promise<TaskSystemCommands['operation.execute']['result']> };
type Dependency = { name?:string;role:'structure'|'dependency';text?:string;path?:string };

const owner = (call?:McCall) => call?.session.id??'local';
const dependencySchema=object({name:string,role:choice('structure','dependency'),text:string,path:string},['role']);
const sourceFields={modelRef,expectedDraft,fileName:string,input:object({engine:choice('gaussian','orca'),name:string,text:string,path:string},['engine']),
  dependencies:list(dependencySchema),environmentId:string,displayName:string,groupIds:list(string),workingRootOverride:string,archiveRootOverride:string,
  calculationScript:object({kind:choice('bash','powershell'),text:string},['kind','text']),
  slurm:object({partition:string,account:string,qos:string,timeLimit:string},['partition','account','qos','timeLimit'])};

function ownPlan<T extends {session:string}>(plans:Map<string,T>, id:string, call?:McCall):T{
  const plan=plans.get(id);
  if(!plan||plan.session!==owner(call))throw toolError('PLAN_UNAVAILABLE','当前会话没有这份计划，请重新预检。');
  return plan;
}

function assertLibrary(actual:string|null,expected:string,unresolved=false){
  if(actual!==expected)throw toolError('TASK_LIBRARY_CHANGED','任务库已变化，请回到原任务库。',{
    completion:unresolved?'unknown':'not_submitted',libraryId:expected,currentLibraryId:actual,recovery:{tool:'job_library',arguments:{action:'read'}}
  });
}

function previewRecovery(code:string,stage:string|undefined,environmentId:string){
  if(code==='ENVIRONMENT_NOT_FOUND'||code==='ENGINE_ENVIRONMENT_MISMATCH')
    return {tool:'job_environments',arguments:{},message:'选择当前任务库中与最终输入引擎匹配的执行环境。'};
  if(code==='ABSOLUTE_WORKING_ROOT_REQUIRED'||code==='ABSOLUTE_ARCHIVE_ROOT_REQUIRED')
    return {message:code==='ABSOLUTE_WORKING_ROOT_REQUIRED'?'核对所选执行环境的工作根，或在预检中指定 workingRootOverride 的绝对路径。':'请为当前系统指定 archiveRootOverride 的绝对路径。'};
  if(stage==='environment'||stage==='software'||stage==='launch'||stage==='scheduler')
    return {tool:'job_environment_check',arguments:{environmentId},message:'读取原生环境检查。核对主机指纹或授权后，再按实际提示继续。'};
  if(stage==='calculation-script')
    return {message:'保留原稿，核对本次路径、平台和启动映射后重新预检。'};
  if(stage==='input'||stage==='dependencies')
    return {message:'核对最终原生输入和同目录依赖，修正对应字段后再预检。'};
  return undefined;
}

// These native errors are raised before any registration or overwrite actions.
const preRegistrationStages:Record<string,string>={
  SUBMISSION_PLAN_EXPIRED:'plan',FINAL_INPUT_RESTRICTED:'input',
  ENVIRONMENT_NOT_FOUND:'environment',ENGINE_ENVIRONMENT_MISMATCH:'environment',
  ABSOLUTE_WORKING_ROOT_REQUIRED:'paths',ABSOLUTE_ARCHIVE_ROOT_REQUIRED:'paths',
  DEPENDENCY_SELECTION_EXPIRED:'dependencies',DEPENDENCY_SOURCE_CHANGED:'dependencies'
};

function knownSubmissionRefusal(error:unknown):string|undefined{
  const native=error as {code?:unknown;message?:unknown}|null;
  const code=typeof native?.code==='string'?native.code:
    typeof native?.message==='string'?native.message.match(/^(?:(?:Error invoking remote method 'sciyue:task-system-request': )?Error: )?([A-Z0-9_]+)$/)?.[1]:undefined;
  return code&&Object.hasOwn(preRegistrationStages,code)?code:undefined;
}

/** Attach optional explicit files with the same streamed handoff used by the native submission dialog. */
async function extraDependencies(rows:Dependency[],readInput:boolean,call?:McCall):Promise<{source?:ScientificSourceFile;dependencies:ExternalInputDependency[];release():Promise<void>}> {
  const files:ScientificSourceFile[]=[],dependencies:ExternalInputDependency[]=[];
  const release=async()=>{await Promise.allSettled(files.map(file=>file.close?.()));};
  try{
    for(const row of rows){
      if((typeof row.text==='string')===(typeof row.path==='string'))throw Error('每个依赖请选择一种内容来源 text 或 path。');
      if(row.text!==undefined&&!row.name)throw Error('内联依赖需要文件名。');
    }
    const paths=rows.filter(row=>typeof row.path==='string');
    const required=paths.length+Number(readInput);
    if(required){
      const desktop=window.sciyueDesktop as unknown as LaunchImportBridge|undefined,bridge=mcpBridge();
      if(!call||!bridge||!desktop?.readLaunchSource||!desktop.closeLaunchSource)throw Error('当前 MCP 会话不能读取本机依赖。');
      const batchIndex=call.batchIndex;
      const reply=await bridge.file({requestId:call.requestId,action:'sources',...(batchIndex===undefined?{}:{batchIndex})}) as {sources?:LaunchSourceDescriptor[]}|LaunchSourceDescriptor[];
      const sources=Array.isArray(reply)?reply:reply.sources??[];
      for(const source of sources)files.push(launchSourceFile(source,desktop));
      if(files.length!==required)throw Error('实际读取的输入与依赖数量与请求不一致。');
    }
    let fileIndex=Number(readInput);
    for(const row of rows){
      if(row.text!==undefined)dependencies.push({name:row.name!,role:row.role,source:{kind:'generated-text',text:row.text}});
      else{const file=files[fileIndex++];dependencies.push({name:row.name??file.name,role:row.role,source:{kind:'scientific-source',file}});}
    }
    return {source:readInput?files[0]:undefined,dependencies,release};
  }catch(error){await release();throw error;}
}

function externalText(input:{engine:'gaussian'|'orca';name:string;text:string}):ExternalInputDraft{
  if(input.engine==='gaussian')return gaussianExternalInputDraft(input.text,input.name);
  if(!input.text.trim())throw Error('ORCA 主输入文本为空。');
  const name=/\.inp$/i.test(input.name)?input.name:`${input.name}.inp`;
  return {engineId:'orca',inputName:name,finalInputText:input.text,suggestedName:name.replace(/\.inp$/i,''),dependencies:[]};
}

export function jobTools(ctx:InputToolsContext,bridge:TaskSystemBridge=createTaskSystemBridge()):McTool[] & {dispose():void}{
  const submissions=new Map<string,SubmittedPlan>(),operations=new Map<string,OperationOwnership>();
  const projectScope=()=>ctx.projectScope?.()??ctx.projectId();
  const release=(sourceRefs:string[])=>sourceRefs.length?bridge.request('submission.release-dependencies',{sourceRefs}):Promise.resolve();
  let generation=0;
  function dispose(){
    generation++;
    for(const plan of submissions.values()){
      const releasePlan=()=>release(plan.dependencies).catch(()=>{});
      if(plan.flight)void plan.flight.then(releasePlan,releasePlan);else void releasePlan();
    }
    submissions.clear();operations.clear();
  }

  async function preview(request:SubmitTaskRequest,libraryId:string,project:ProjectScope,started:number,call?:McCall,dependencies:string[]=[]){
    const receipt=await bridge.request('submission.preview',{...request,includeDiagnostics:true},{signal:call?.signal});
    if(generation!==started||projectScope()!==project)throw toolError('PROJECT_CHANGED','输入准备期间项目已变化，请重新预检。',{completion:'not_submitted'});
    const planId=receipt.submissionPlanId;
    const scope={libraryId,projectId:request.input.projectId,environmentId:request.environmentId,engineId:request.input.engineId};
    if(!planId||receipt.restrictions.length){
      await release(dependencies).catch(()=>{});
      const restrictionDetails=receipt.restrictionDetails?.map(detail=>({...detail,recovery:previewRecovery(detail.code,detail.stage,request.environmentId)}));
      return {...receipt,...scope,submissionPlanId:null,restrictionDetails,planId:null,ready:false,completion:'not_submitted'};
    }
    const overwrite=request.resubmitTaskId?await bridge.request('submission.overwrite-preview',{resubmitTaskId:request.resubmitTaskId,submissionPlanId:planId},{signal:call?.signal}):undefined;
    if(generation!==started||projectScope()!==project)throw toolError('PROJECT_CHANGED','输入准备期间项目已变化，请重新预检。',{completion:'not_submitted'});
    submissions.set(planId,{libraryId,session:owner(call),project,dependencies,executionEnvironment:receipt.executionEnvironment,request:{...request,submissionPlanId:planId,
      displayName:request.displayName||receipt.suggestedDisplayName||request.input.suggestedName,...(overwrite?{overwritePlanId:overwrite.overwritePlanId}:{})}});
    return {...receipt,...scope,planId,ready:true,completion:'not_submitted',submissionIntentId:request.submissionIntentId,...(overwrite?{overwrite}:{})};
  }

  async function registered(plan:SubmittedPlan, receipt:SubmissionReceipt):Promise<RegisteredSubmission>{
    if(plan.receipt)return plan.receipt;
    const {request}=plan;
    const executionEnvironment=receipt.executionEnvironment??plan.executionEnvironment;
    const record:RegisteredSubmission={...receipt,status:'registered',libraryId:plan.libraryId,
      projectId:receipt.projectId===undefined?request.input.projectId:receipt.projectId,
      environmentId:executionEnvironment?.environmentId??request.environmentId,engineId:executionEnvironment?.engineId??request.input.engineId,executionEnvironment,
      submissionIntentId:request.submissionIntentId};
    plan.receipt=record;plan.dispatchUnresolved=false;
    await release(plan.dependencies).catch(()=>{});plan.dependencies=[];
    return record;
  }

  async function previewInput(args:Record<string,unknown>,call?:McCall){
        const taskId=args.taskId as string|undefined;
        if(args.input!==undefined&&(args.modelRef!==undefined||args.expectedDraft!==undefined||args.fileName!==undefined))throw Error('请选择编辑器草稿或外部输入正文。');
        const useEditor=args.input===undefined&&(!taskId||args.modelRef!==undefined||args.expectedDraft!==undefined||args.fileName!==undefined);
        if(useEditor&&typeof args.expectedDraft!=='string')throw Error('使用编辑器正文时需要 expectedDraft。');
        const external=args.input as {engine:'gaussian'|'orca';name?:string;text?:string;path?:string}|undefined;
        if(external&&((typeof external.path==='string')===(typeof external.text==='string')||external.text!==undefined&&!external.name))
          throw Error('请选择一个外部输入 path 或提供 name 与 text。');
        const editor=useEditor?liveInputFor(ctx.entry(args.modelRef as string|undefined).store):undefined;
        const draft=editor?.external(args.expectedDraft as string,args.fileName as string|undefined);
        const projectId=ctx.projectId(),project=projectScope(),started=generation;
        return withTaskCenter(bridge,call,async state=>{
          const extra=await extraDependencies((args.dependencies??[]) as Dependency[],external?.path!==undefined,call);
          let input:SubmitTaskInput|undefined;
          const held=new Set<string>();
          try{
            const previous=taskId?await bridge.request('submission.resubmit-draft',{taskId},{signal:call?.signal}):undefined;
            for(const dependency of previous?.input.dependencies??[])held.add(dependency.sourceRef);
            const selected=draft??(external?externalText({engine:external.engine,name:external.name??extra.source!.name,
              text:external.text??await extra.source!.text()}):undefined);
            if(previous&&selected&&selected.engineId!==previous.input.engineId)throw Error('覆盖重提须沿原任务引擎。');
            const original=previous?.input;
            const source=selected??(original?{engineId:original.engineId,inputName:original.inputName,suggestedName:original.suggestedName,
              finalInputText:original.finalInputText,dependencies:[]}:undefined);
            if(!source)throw Error('缺少可预检的实际输入。');
            input=await stageExternalInput({...source,dependencies:[...source.dependencies,...extra.dependencies]},bridge,original?original.projectId:projectId,call?.signal);
            for(const dependency of input.dependencies)held.add(dependency.sourceRef);
            if(original&&!args.replaceDependencies)input={...input,dependencies:[...original.dependencies,...input.dependencies]};
            if(original&&args.replaceDependencies){const superseded=original.dependencies.map(row=>row.sourceRef);await release(superseded);for(const ref of superseded)held.delete(ref);}
            const environmentId=(args.environmentId as string|undefined)??previous?.environmentId;
            if(!environmentId)throw Error('请选择预检环境。');
            const request:SubmitTaskRequest={...previous,input,environmentId,displayName:(args.displayName as string|undefined)??previous?.displayName??'',
              groupIds:(args.groupIds as string[]|undefined)??previous?.groupIds,
              workingRootOverride:(args.workingRootOverride as string|undefined)??previous?.workingRootOverride,
              archiveRootOverride:(args.archiveRootOverride as string|undefined)??previous?.archiveRootOverride,
              slurm:(args.slurm as SubmitTaskRequest['slurm'])??previous?.slurm,
              calculationScript:(args.calculationScript as SubmitTaskRequest['calculationScript'])??previous?.calculationScript,
              submissionIntentId:`intent-${crypto.randomUUID()}`};
            const result=await preview(request,state.library.libraryId!,project,started,call,[...held]);
            return {...result,...(editor?{inputDraftVersion:args.expectedDraft}:{})};
          }catch(error){await release([...held]).catch(()=>{});throw error;}
          finally{await extra.release();}
        });
  }

  const tools=[
    inputTool('job_preview','Preflight the final edited Gaussian / ORCA input, an exact input file path, or agent-supplied text. Preflight includes the explicit per-job calculationScript when supplied.',object(sourceFields,['environmentId']),previewInput),
    inputTool('job_resubmit_plan','Preflight replacement of an ended task. Omitted inputs reuse the frozen original. An explicit new input, calculation script, environment or resource-bearing input text updates the replacement preview. Submit only after reviewing the returned overwrite scope.',
      object({...sourceFields,taskId:string,replaceDependencies:boolean},['taskId']),previewInput),
    inputTool('job_submit','Submit an exact ready job_preview plan. A durable receipt identifies the task, run, operation and frozen execution environment. If the outcome is unresolved, check the original submission intent with job_submission_lookup.',
      object({planId:string,confirmOverwrite:boolean},['planId']),async(args,call)=>{
        const plan=ownPlan(submissions,args.planId as string,call);
        if(plan.receipt)return plan.receipt;
        if(plan.request.resubmitTaskId&&args.confirmOverwrite!==true)throw Error('请核对覆盖重提范围并传入 confirmOverwrite。');
        if(plan.flight)return plan.flight;
        plan.flight=withTaskCenter(bridge,call,async state=>{
          assertLibrary(state.library.libraryId,plan.libraryId,plan.dispatchUnresolved);
          const submissionIntentId=plan.request.submissionIntentId!;
          const lookup=()=>bridge.request('task.submission-receipt',{submissionIntentId,includeOwnership:true});
          const unresolved=()=>toolError('SUBMISSION_OUTCOME_UNKNOWN','未取得本次提交意图的登记回执，请继续查原意图。',{
            completion:'unknown',planId:plan.request.submissionPlanId,submissionIntentId,libraryId:plan.libraryId,
            environmentId:plan.request.environmentId,recovery:{tool:'job_submission_lookup',arguments:{submissionIntentId}}
          });
          if(plan.dispatchUnresolved){
            const prior=await lookup().catch(()=>null);
            if(prior)return registered(plan,prior);
            throw unresolved();
          }
          if(projectScope()!==plan.project)throw toolError('PROJECT_CHANGED','任务准备后项目已变化，请重新预检。',{completion:'not_submitted'});
          if(plan.executionEnvironment&&state.environments&&state.environments.find(env=>env.environmentId===plan.request.environmentId)?.revision!==plan.executionEnvironment.revision)
            throw toolError('ENVIRONMENT_CONFLICT','预检后执行环境已更改。请核对环境版本并重新预检。',{
              completion:'not_submitted',environmentId:plan.request.environmentId,expectedRevision:plan.executionEnvironment.revision,
              recovery:{tool:'job_environments',arguments:{}}
            });
          call?.signal.throwIfAborted();
          try{return await registered(plan,await bridge.request('submission.submit',{...plan.request,includeOwnership:true}));}
          catch(error){
            const prior=await lookup().catch(()=>null);
            if(prior)return registered(plan,prior);
            const refusal=knownSubmissionRefusal(error);
            if(refusal)throw toolError(refusal,'原生作业拒绝了登记前的准备，请核对后重新预检。',{
              completion:'not_submitted',planId:plan.request.submissionPlanId,submissionIntentId,
              environmentId:plan.request.environmentId,engineId:plan.request.input.engineId,stage:preRegistrationStages[refusal],
              recovery:previewRecovery(refusal,preRegistrationStages[refusal],plan.request.environmentId)??{message:'请重新预检原输入和执行环境。'}
            });
            plan.dispatchUnresolved=true;
            throw unresolved();
          }
        });
        try{return await plan.flight;}finally{plan.flight=undefined;}
      }),
    inputTool('job_discard_plan','Discard an unused submission preview and release its staged dependency bytes.',
      object({planId:string},['planId']),async(args,call)=>{
        const plan=ownPlan(submissions,args.planId as string,call);
        if(plan.flight||plan.receipt||plan.dispatchUnresolved)throw Error('当前计划已有提交尝试，须保留原计划与提交身份。');
        await release(plan.dependencies);
        submissions.delete(args.planId as string);
        return {discarded:true};
      }),
    inputTool('job_list','List actual external tasks, execution and result states, and groups from the current task library.',
      object({}),async(_args,call)=>{const state=await bridge.request('center.read',{}, {signal:call?.signal});return {library:state.library,manager:state.manager,tasks:state.tasks,groups:state.groups,operations:state.operations};}),
    ...jobMonitorTools(ctx,bridge),
    inputTool('job_submission_lookup','Find the original durable registration receipt by exact submission intent ID after a disconnect. An unknown receipt leaves the original submission outcome unresolved.',
      object({submissionIntentId:string},['submissionIntentId']),async(args,call)=>{
        const submissionIntentId=args.submissionIntentId as string;
        const plan=[...submissions.values()].find(plan=>plan.session===owner(call)&&plan.request.submissionIntentId===submissionIntentId);
        if(plan?.receipt)return plan.receipt;
        return withTaskCenter(bridge,call,async state=>{
          if(plan)assertLibrary(state.library.libraryId,plan.libraryId,plan.dispatchUnresolved);
          const receipt=await bridge.request('task.submission-receipt',{submissionIntentId,includeOwnership:true},{signal:call?.signal});
          if(receipt&&plan)return registered(plan,receipt);
          return {submissionIntentId,libraryId:state.library.libraryId,status:receipt?'registered':'unknown',...(receipt??{})};
        },false);
      }),
    inputTool('job_diagnostics','Read native submission, execution, resource and result-preparation evidence for a specific task/run.',
      object({taskId:string,runId:string,operationOffset:integer,operationLimit:positive,receiptOffset:integer,receiptLimit:positive},['taskId']),
      (args,call)=>bridge.request('task.execution-evidence',args as TaskSystemCommands['task.execution-evidence']['input'],{signal:call?.signal})),
    inputTool('job_operation_plan','Plan a native stop, archive, cleanup, restore, recycle, deletion or group operation on explicit task IDs. Review the returned per-task effects.',
      object({action:choice('group','stop','archive','cleanup','cleanup-archive','delete-task','recycle','restore'),taskIds:list(string),groupId:string,
        deleteLocal:boolean,deleteRemote:boolean,remindRemote:boolean,archiveMode:choice('default','selected'),selectedArtifactIds:list(string)},['action','taskIds']),
      (args,call)=>withTaskCenter(bridge,call,async state=>{
        const plan=await bridge.request('operation.plan',args as TaskSystemCommands['operation.plan']['input'],{signal:call?.signal});
        operations.set(plan.planId,{libraryId:state.library.libraryId!,session:owner(call)});
        return plan;
      })),
    inputTool('job_operation_execute','Execute a reviewed native job operation plan. Read its operation ID until the requested stop, archive or restore has actually finished.',
      object({planId:string},['planId']),async(args,call)=>{
        const planId=args.planId as string,planned=ownPlan(operations,planId,call);
        if(planned.execution)return planned.execution;
        if(planned.flight)return planned.flight;
        planned.flight=withTaskCenter(bridge,call,async state=>{
          assertLibrary(state.library.libraryId,planned.libraryId);
          call?.signal.throwIfAborted();
          const receipt=await bridge.request('operation.execute',{planId});
          planned.execution=receipt;
          return receipt;
        });
        try{return await planned.flight;}finally{planned.flight=undefined;}
      }),
    inputTool('job_operation_read','Read the native state and per-task result of a submitted management operation.',
      object({operationId:string},['operationId']),(args,call)=>bridge.request('operation.read',{operationId:args.operationId as string},{signal:call?.signal})),
    inputTool('job_operation_retry','Retry explicitly selected failed task members of a native management operation.',
      object({operationId:string,taskIds:list(string)},['operationId','taskIds']),
      (args,call)=>withTaskCenter(bridge,call,()=>bridge.request('operation.retry',args as TaskSystemCommands['operation.retry']['input']))),
  ];
  return Object.assign(tools,{dispose});
}
