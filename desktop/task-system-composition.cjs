'use strict';
/** Desktop composition only. Task domain never imports the application window/project hosts. */
const path=require('node:path');
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');

function createTaskSystemComposition(options){
  let starting=null,host=null,closing=false;
  const requests=new Map(),companions=new Map(),releasedOwners=new Set();
  const ownerKey=id=>String(id);
  function checkOwner(owner){if(closing||releasedOwners.has(ownerKey(owner)))throw Error('TASK_WINDOW_CLOSED');options.assertOwner(owner);}
  async function getHost(){
    if(host)return host;
    if(!starting)starting=(async()=>{
      const os=require('./task-system/platform/process-identity.cjs');
      const processIdentity=await os.currentIdentity('es-task-host:'+randomUUID());
      if(!processIdentity)throw Error('TASK_HOST_IDENTITY_UNAVAILABLE');
      const adapters=require('./task-system/engines/application-config.cjs').createTaskEnvironmentConfiguration({platform:process.platform});
      host=require('./task-system/host.cjs').createTaskSystemHost({
        globalDirectory:options.globalDirectory,processIdentity,probeProcessIdentity:os.probe,stopVerifiedProcessTree:os.stop,
        protocol:require('./task-system/protocol.cjs'),readingRuntime:require('./task-system/reading-runtime.cjs'),safeStorage:options.safeStorage,
        snapshotDirectory:ownerId=>path.join(options.snapshotRoot,processIdentity.instanceId.replace(/[^a-zA-Z0-9_.-]/g,'-'),ownerId),
        runtimeAssets:{executable:process.execPath,runnerPath:path.join(__dirname,'task-system/execution/runner.cjs'),identityModulePath:path.join(__dirname,'task-system/platform/process-identity.cjs')},
        spawnDetached:spec=>new Promise((resolve,reject)=>{const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:{...process.env,...spec.env},stdio:'ignore',shell:false,detached:true,windowsHide:true});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve({pid:child.pid});});}),
        chooseDirectory:options.chooseDirectory,chooseOpenFile:options.chooseOpenFile,chooseDependencyFiles:options.chooseDependencyFiles,chooseSaveFile:options.chooseSaveFile,
        readImportFile:async scope=>{const selected=await options.chooseImportFile(scope);if(!selected)return null;const stat=await fs.stat(selected);if(!stat.isFile()||stat.size>4*1024*1024)throw Error('ENVIRONMENT_IMPORT_TOO_LARGE');return fs.readFile(selected,'utf8');},
        writeClipboard:options.writeClipboard,openPath:options.openPath,confirmImpact:options.confirmImpact,...adapters,
        onChanged:()=>options.onChanged?.(),onError:value=>options.onError?.(value),
      });
      return host;
    })().catch(error=>{starting=null;throw error;});
    return starting;
  }
  async function closeCompanion(owner,token){
    const value=companions.get(token);if(!value)return;
    if(value.owner!==ownerKey(owner))throw Error('SNAPSHOT_COMPANION_OWNER_MISMATCH');
    if(!value.closed){await options.launchSources.close(owner,token);value.closed=true;}
    await value.host.request(value.owner,'snapshot.release',value.lease);companions.delete(token);
  }
  async function companion(owner,input,signal){
    const taskHost=await getHost(),key=ownerKey(owner),lease=await taskHost.request(key,'snapshot.retain',input);
    let token;
    try{
      const source=await taskHost.describeSnapshotSource(key,{...lease,sourceRef:input.sourceRef});checkOwner(owner);
      if(signal.aborted)throw Error('TASK_REQUEST_CANCELLED');
      const snapshot=await taskHost.request(key,'snapshot.describe',lease),selected=snapshot.files.find(row=>row.sourceRef===input.sourceRef),fixed=[];
      if(selected?.roles.includes('primary-output')){
        for(const file of snapshot.files){
          const candidate=file.companionCandidate;
          if(!candidate||!candidate.rawReadable||!candidate.originVerified||candidate.unambiguous!==true||candidate.scientificState!=='unknown'||!['cis','orca-json'].includes(candidate.kind))continue;
          const kind=candidate.kind==='cis'?'cis':'json';if(fixed.some(row=>row.kind===kind))throw Error('SNAPSHOT_COMPANION_AMBIGUOUS');
          const physical=await taskHost.describeSnapshotSource(key,{...lease,sourceRef:file.sourceRef});
          fixed.push({kind,path:physical.path,name:physical.name,sha256:physical.sha256});
        }
      }
      const [opened]=await options.launchSources.open(owner,[source.path],{names:[source.name],companions:[fixed]});token=opened.token;
      const descriptor=await options.launchSources.describe(owner,token);
      if(descriptor.revision!==source.sha256||descriptor.size!==source.byteSize||descriptor.name!==source.name)throw Error('SNAPSHOT_COMPANION_SOURCE_CHANGED');
      checkOwner(owner);if(signal.aborted)throw Error('TASK_REQUEST_CANCELLED');
      companions.set(token,{owner:key,lease,host:taskHost,closed:false});return {token,...descriptor};
    }catch(error){if(token)await options.launchSources.close(owner,token);await taskHost.request(key,'snapshot.release',lease);throw error;}
  }
  async function request(owner,envelope){
    checkOwner(owner);
    if(!envelope||typeof envelope.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(envelope.requestId)||typeof envelope.command!=='string')throw Error('TASK_REQUEST_INVALID');
    const key=ownerKey(owner)+':'+envelope.requestId;if(requests.has(key))throw Error('TASK_REQUEST_DUPLICATE');
    const controller=new AbortController();requests.set(key,controller);
    try{
      if(envelope.command==='snapshot.companion-source')return await companion(owner,envelope.input,controller.signal);
      if(envelope.command==='snapshot.close-companion')return await closeCompanion(owner,envelope.input?.token);
      const taskHost=await getHost();checkOwner(owner);
      return await taskHost.request(ownerKey(owner),envelope.command,envelope.input,{signal:controller.signal});
    }finally{requests.delete(key);}
  }
  function cancel(owner,requestId){requests.get(ownerKey(owner)+':'+requestId)?.abort();}
  async function releaseOwner(owner){
    releasedOwners.add(ownerKey(owner));
    for(const[key,controller]of requests)if(key.startsWith(ownerKey(owner)+':'))controller.abort();
    for(const[token,value]of [...companions])if(value.owner===ownerKey(owner))await closeCompanion(owner,token);
    if(starting)await starting.catch(()=>null);await host?.releaseOwner(ownerKey(owner));
  }
  async function prepareExit(choice){if(!starting)return{ready:true};const taskHost=await starting;let result=await taskHost.prepareExit(choice);if(!result.ready&&choice!=='cancel'&&taskHost.exitSummary().activeOperations){await taskHost.settle();result=await taskHost.prepareExit(choice);}return result;}
  async function dispose(){closing=true;for(const controller of requests.values())controller.abort();if(starting)await starting.catch(()=>null);for(const[token,value]of [...companions])await closeCompanion(Number(value.owner),token);await host?.suspendResultAdoptionForDispose();await host?.settle();await host?.disposeUI();}
  return{request,cancel,releaseOwner,exitSummary:()=>host?.exitSummary()??{runs:[],operations:[],activeOperations:0,requiresChoice:false},prepareExit,resumeAfterCancelledExit:()=>host?.resumeAfterCancelledExit(),dispose};
}
module.exports={createTaskSystemComposition};
