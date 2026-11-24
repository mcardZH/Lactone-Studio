import type { EnvironmentView, EnvironmentSecretPayload, TaskSystemBridge, TaskCenterView } from '../../task-system/application-contracts';
import { createTaskSystemBridge } from '../../task-system/integration/desktop-bridge';
import { newEnvironment } from '../task-system/EnvironmentSettings';
import { checkComputeResourceSnapshot } from '../useComputeResources';
import { MULTIWFN_CONFIGURATION_CHANGED } from '../global-settings-events';
import { boolean, choice, inputTool, list, object, positive, string } from './input-arguments';
import { toolError, type McCall, type McTool } from './types';
import { jobEnvironmentTools } from './job-environment-tools';

export async function withTaskCenter<T>(bridge:TaskSystemBridge, request:McCall|undefined, action:(state:TaskCenterView)=>Promise<T>, manage=true):Promise<T>{
  const entryId=`mcp-task-${crypto.randomUUID()}`;
  try{
    const state=await bridge.request('center.enter',{entryId},{signal:request?.signal});
    if(manage&&!state.library.libraryId)throw toolError('TASK_LIBRARY_UNAVAILABLE','请先关联可用的任务库。',state.library);
    if(manage&&state.manager.access!=='manager')throw toolError('TASK_MANAGER_UNAVAILABLE','当前任务库由其他窗口管理。',state.manager);
    return await action(state);
  }finally{await bridge.request('center.leave',{entryId}).catch(()=>{});}
}

const environmentPatch=object({
  displayName:string,engineId:choice('gaussian','orca'),connectionKind:choice('local','wsl','ssh'),schedulerKind:choice('none','slurm'),
  host:string,port:positive,user:string,distribution:string,executable:string,workingRoot:string,
  partition:string,account:string,qos:string,timeLimit:string,initialization:string,scriptTemplate:string,calculationTemplate:string,
  submitCommandTemplate:string,slurmMemoryPolicy:choice('input-request','site-managed'),authentication:choice('agent','password','private-key'),
  privateKeyPath:string,siteId:string,siteRevision:positive
});
const secret=object({password:string,privateKeyPassphrase:string,remember:boolean},['remember']);
const envFields={environmentId:string,expectedRevision:positive,patch:environmentPatch,secret};

function environmentFor(args:Record<string,unknown>, state:TaskCenterView):EnvironmentView{
  if(args.environmentId===undefined)return {...newEnvironment(),...args.patch as Partial<EnvironmentView>};
  const current=state.environments.find(value=>value.environmentId===args.environmentId);
  if(!current)throw Error('没有找到指定的执行环境。');
  if(args.expectedRevision!==undefined&&current.revision!==args.expectedRevision)throw toolError('ENVIRONMENT_CONFLICT','执行环境已有新版本。',{revision:current.revision});
  return {...current,...args.patch as Partial<EnvironmentView>};
}

export function inputSettingsTools():McTool[] & {dispose():void}{
  const bridge=createTaskSystemBridge();
  const environmentTools=jobEnvironmentTools(bridge);
  const tools=[
    inputTool('job_environments','Read the task library’s execution environments and site profiles.',
      object({}),async()=>{const state=await bridge.request('center.read',{});return {environments:state.environments,siteProfiles:state.siteProfiles,library:state.library};}),
    inputTool('job_environment_check','Run the native environment check for a saved or candidate Gaussian / ORCA environment. Uses the specified connection.',
      object(envFields), (args,call)=>withTaskCenter(bridge,call,state=>bridge.request('environment.check',
        {environment:environmentFor(args,state),secret:args.secret as EnvironmentSecretPayload|undefined},{signal:call?.signal}))),
    inputTool('job_environment_save','Create an execution environment or update its validated configuration with the expected saved revision.',
      object({...envFields,requiredCapabilities:list(string)},['patch']),
      (args,call)=>withTaskCenter(bridge,call,state=>{
        if(args.environmentId!==undefined&&args.expectedRevision===undefined)throw Error('更新执行环境时请传入 expectedRevision。');
        return bridge.request('environment.save',{environment:environmentFor(args,state),secret:args.secret as EnvironmentSecretPayload|undefined,
          requiredCapabilities:args.requiredCapabilities as string[]|undefined},{signal:call?.signal});
      })),
    inputTool('job_trust_host_key','Trust the exact remote host fingerprint presented by job_environment_check.',
      object({challengeId:string,fingerprint:string},['challengeId','fingerprint']),
      (args,call)=>withTaskCenter(bridge,call,()=>bridge.request('environment.trust-host-key',
        {challengeId:args.challengeId as string,fingerprint:args.fingerprint as string},{signal:call?.signal}))),
    ...environmentTools,
    inputTool('compute_resources','Read the current local compute-resource preference or write all intended values at the previous baseVersion. An omitted outputBudgetBytes leaves output unrestricted.',
      object({baseVersion:string,values:object({threads:positive,memoryBudgetBytes:positive,outputBudgetBytes:positive},['threads','memoryBudgetBytes'])}),
      async args=>{
        const desktop=window.sciyueDesktop;
        if(!desktop?.readComputeResources)throw Error('当前实例不能读取统一计算资源。');
        if(args.values===undefined)return checkComputeResourceSnapshot(await desktop.readComputeResources());
        if(!desktop.writeComputeResources||typeof args.baseVersion!=='string')throw Error('设置运行资源需要 baseVersion。');
        return checkComputeResourceSnapshot(await desktop.writeComputeResources({baseVersion:args.baseVersion,value:args.values as Parameters<NonNullable<typeof desktop.writeComputeResources>>[0]['value']}));
      }),
    inputTool('multiwfn_configure','Read the Multiwfn runtime configuration, select its program or work directory, or restore the default work directory.',
      object({programDirectory:string,workDirectory:string,resetWorkDirectory:boolean}),async(args,call)=>{
        const desktop=window.sciyueDesktop;
        if(!desktop?.orbitalBackendInfo)throw Error('当前实例不能读取 Multiwfn 设置。');
        if([args.programDirectory!==undefined,args.workDirectory!==undefined,args.resetWorkDirectory===true].filter(Boolean).length>1)throw Error('请选择一个 Multiwfn 设置操作。');
        if(args.programDirectory===''||args.workDirectory==='')throw Error('请提供一个实际目录。');
        let value;
        if(typeof args.programDirectory==='string'){
          if(!desktop.chooseOrbitalBackend||!call)throw Error('当前窗口不能配置 Multiwfn 程序目录。');
          value=await desktop.chooseOrbitalBackend({directory:args.programDirectory,mcpRequestId:call.requestId});
        }else if(typeof args.workDirectory==='string'){
          if(!desktop.chooseMultiwfnWorkDirectory||!call)throw Error('当前窗口不能配置 Multiwfn 工作目录。');
          value=await desktop.chooseMultiwfnWorkDirectory({directory:args.workDirectory,mcpRequestId:call.requestId});
        }else if(args.resetWorkDirectory===true){
          if(!desktop.resetMultiwfnWorkDirectory)throw Error('当前窗口不能恢复 Multiwfn 工作目录。');
          value=await desktop.resetMultiwfnWorkDirectory();
        }else return desktop.orbitalBackendInfo();
        window.dispatchEvent(new Event(MULTIWFN_CONFIGURATION_CHANGED));
        return value;
      }),
    inputTool('gxtb_configure','Read or set the g-xTB executable path and the latest native capability inspection. Use detect to run an explicit version/capability probe.',
      object({path:string,detect:boolean}),async args=>{
        const desktop=window.sciyueDesktop;
        if(args.path!==undefined&&args.detect===true)throw Error('请选择路径或自动检测。');
        if(typeof args.path==='string'&&desktop?.setGxtbBackendPath)return desktop.setGxtbBackendPath(args.path);
        if(args.detect===true&&desktop?.detectGxtbBackend)return desktop.detectGxtbBackend();
        if(args.path===undefined&&!args.detect&&desktop?.gxtbBackendInfo)return desktop.gxtbBackendInfo();
        throw Error('当前实例未开放所需的 g-xTB 设置操作。');
      }),
  ];
  return Object.assign(tools,{dispose:environmentTools.dispose});
}
