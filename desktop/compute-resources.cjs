'use strict';
const os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {assert,plain}=require('./security.cjs');
const {directoryIdentity,checkDirectory,currentFile,atomicWrite}=require('./portable-storage.cjs');
const {outputBudget}=require('./output-budget.cjs');
const FACTORY_RESOURCES=Object.freeze({threads:4,memoryBudgetBytes:8*1024**3,multiwfnThreads:4,
  xtbSingleTaskMode:'auto',xtbSingleTaskThreads:4,xtbBatchParallelism:4,netCpuThreads:4}),LIMIT=4096;
const threadFields=['multiwfnThreads','xtbSingleTaskThreads','xtbBatchParallelism','netCpuThreads'];
const policyFields=[...threadFields,'xtbSingleTaskMode'];
const lanes=['multiwfn','xtb-single','xtb-batch'];
const validThreadCount=value=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;
function exact(value,keys){assert(plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'COMPUTE_RESOURCE_FIELDS: Invalid resource fields');}
function validateComputeResources(value,capabilities){
  exact(value,['threads','memoryBudgetBytes',...(Object.hasOwn(value,'outputBudgetBytes')?['outputBudgetBytes']:[])]);assert(Number.isSafeInteger(value.threads)&&value.threads>0&&value.threads<=2147483647,'COMPUTE_RESOURCE_THREADS: 线程须为正整数。');assert(Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>0,'COMPUTE_RESOURCE_MEMORY: 内存预算须为正整数字节。');if(value.outputBudgetBytes!==undefined)outputBudget(value);
  if(capabilities){assert(value.threads<=capabilities.logicalCpuCount,'COMPUTE_RESOURCE_THREADS: 线程超过本机可用逻辑处理器。');assert(value.memoryBudgetBytes<=capabilities.totalPhysicalMemoryBytes,'COMPUTE_RESOURCE_MEMORY: 内存预算超过本机物理内存。');}return{...value};
}
function executionValues(value,threads=value.threads){
  return {threads,memoryBudgetBytes:value.memoryBudgetBytes,...(value.outputBudgetBytes===undefined?{}:{outputBudgetBytes:value.outputBudgetBytes})};
}
function validatePolicy(value,capabilities){
  assert(plain(value),'COMPUTE_RESOURCE_FIELDS: Invalid resource fields');
  const base=executionValues(value);
  exact(value,[...Object.keys(base),...policyFields]);
  validateComputeResources(base,capabilities);
  assert(['auto','fixed'].includes(value.xtbSingleTaskMode),'COMPUTE_RESOURCE_FIELDS: xTB 单任务线程模式无效。');
  assert(threadFields.every(key=>validThreadCount(value[key])&&
    (key==='netCpuThreads'||!capabilities||value[key]<=capabilities.logicalCpuCount)),'COMPUTE_RESOURCE_THREADS: 计算线程或并行数超出本机可用范围。');
  return {...value};
}
function migratePolicy(legacy,defaults){
  const base=validateComputeResources(legacy);
  const {threads}=base;
  return {...base,multiwfnThreads:threads,xtbSingleTaskMode:'auto',xtbSingleTaskThreads:threads,
    xtbBatchParallelism:threads,netCpuThreads:defaults.netCpuThreads};
}
function factoryPolicy(capabilities){
  const result={...FACTORY_RESOURCES,memoryBudgetBytes:Math.min(FACTORY_RESOURCES.memoryBudgetBytes,capabilities.totalPhysicalMemoryBytes)};
  for(const key of ['threads',...threadFields])result[key]=Math.min(FACTORY_RESOURCES[key],capabilities.logicalCpuCount);
  return result;
}
function threadPolicy(value,request,lane,capability){
  if(lane==='xtb-batch')return {ceiling:1,threads:1};
  if(lane!=='xtb-single'){
    const threads=lane==='multiwfn'?value.multiwfnThreads:value.threads;
    return {ceiling:threads,threads};
  }
  const override=request.resourceOverrides?.xtbSingleTaskThreads;
  const ceiling=override??value.xtbSingleTaskThreads;
  const threshold=capability?.automaticAtomThreshold??(request.method==='gfn2'&&!request.structure?.cell?.pbc?.some(Boolean)?40:undefined);
  if(override===undefined&&value.xtbSingleTaskMode==='auto'&&threshold!==undefined&&Array.isArray(request.structure?.atoms)&&request.structure.atoms.length<threshold)
    return {ceiling,threads:1,reason:`xTB 自动：少于 ${threshold} 个原子使用 1 线程`};
  return {ceiling,threads:ceiling};
}
function resourceOverrides(value,logicalCpuCount){
  if(value===undefined)return {};
  assert(plain(value)&&Object.entries(value).every(([key,count])=>['xtbSingleTaskThreads','xtbBatchParallelism'].includes(key)&&
    validThreadCount(count)&&count<=logicalCpuCount),'COMPUTE_RESOURCE_THREADS: 任务覆盖值须在本机逻辑处理器范围内。');
  return value;
}
/** Capture policy before queueing, never a lease or a native resource read.
 * Canceling this wait cannot publish a late policy into a closed operation. */
function captureComputeResources(capture,owner,signal){
  if(!capture)return Promise.resolve(undefined);
  return new Promise((resolve,reject)=>{const abort=()=>reject(Error('COMPUTE_RESOURCE_CANCELLED: 资源快照已取消'));if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>capture(owner)).then(value=>{if(signal?.aborted){abort();return;}const actual=validateComputeResources({threads:value.threads,memoryBudgetBytes:value.memoryBudgetBytes,...(value.outputBudgetBytes!==undefined?{outputBudgetBytes:value.outputBudgetBytes}:{})});assert(typeof value.version==='string'&&/^[a-f0-9]{64}$/.test(value.version)&&typeof value.source==='string','COMPUTE_RESOURCE_IDENTITY: Invalid captured policy');resolve(Object.freeze({...value,...actual,...(value.configured?{configured:Object.freeze(validateComputeResources(value.configured))}:{}),...(value.requested?{requested:Object.freeze(validateComputeResources(value.requested))}:{})}));},reject).catch(reject).finally(()=>signal?.removeEventListener('abort',abort));});
}
function attachComputeResourceGrant(release,lease,resources,requested={}){
  assert(typeof release==='function'&&lease&&typeof lease.budget==='function','COMPUTE_RESOURCE_LEASE: Trusted active lease required');const configured=validateComputeResources(resources.configured??executionValues(resources));assert(Number.isSafeInteger(resources.threads)&&resources.threads>0&&resources.threads<=configured.threads&&(resources.threads===configured.threads||typeof resources.threadLimitReason==='string'&&resources.threadLimitReason.length>0),'COMPUTE_RESOURCE_CAPABILITY: Actual threads require an explicit capability reason');assert(typeof resources.version==='string'&&/^[a-f0-9]{64}$/.test(resources.version)&&typeof resources.source==='string','COMPUTE_RESOURCE_IDENTITY: Invalid trusted resource snapshot');const wanted=validateComputeResources(resources.requested??{threads:requested.threads??configured.threads,memoryBudgetBytes:requested.memoryBudgetBytes??configured.memoryBudgetBytes}),budget=lease.budget(configured.memoryBudgetBytes);assert(Number.isSafeInteger(budget.availableBytes)&&budget.availableBytes>0&&Number.isSafeInteger(budget.reservedBytes)&&budget.reservedBytes>=0&&budget.availableBytes+budget.reservedBytes===configured.memoryBudgetBytes,'COMPUTE_RESOURCE_BUDGET: 保留缓存后可用预算不足或回执不符');
  const {threadLane,xtbBatchParallelism,netCpuThreads}=resources;
  if(threadLane!==undefined)assert(lanes.includes(threadLane)&&validThreadCount(xtbBatchParallelism)&&validThreadCount(netCpuThreads),'COMPUTE_RESOURCE_CAPABILITY: Invalid scoped resource evidence');
  const grant=Object.freeze({...configured,...(Number.isFinite(outputBudget(resources))?{outputBudgetBytes:outputBudget(resources)}:{}),threads:resources.threads,...(resources.threadLimitReason?{threadLimitReason:resources.threadLimitReason}:{}),memoryBudgetBytes:budget.availableBytes,version:resources.version,source:resources.source,configured:Object.freeze(configured),requested:Object.freeze(wanted),reservedBytes:budget.reservedBytes,memoryEnforced:false,...(resources.retainedMemoryEstimateBytes?{retainedMemoryEstimateBytes:resources.retainedMemoryEstimateBytes}:{}),...(threadLane!==undefined?{threadLane,xtbBatchParallelism,netCpuThreads}:{})});Object.defineProperty(release,'resources',{value:grant,enumerable:true,writable:false,configurable:false});return release;
}
/** Independent owned preferences. No external settings, worker, or scheduler is
 * read/created here. A grant is a soft budget, never an RSS-hard-limit claim. */
function createComputeResources({profileRoot,retainedMemoryEstimate=()=>0,capabilities=()=>({logicalCpuCount:os.cpus().length,totalPhysicalMemoryBytes:os.totalmem()})}){
  assert(typeof profileRoot==='string'&&path.isAbsolute(profileRoot),'Invalid compute-resource profile root');const root=path.resolve(profileRoot),file=path.join(root,'compute-resource-preferences-v1.json'),pinned=directoryIdentity(root);pinned.catch(()=>{});const baselines=new Map(),epochs=new Map();let queue=Promise.resolve(),closed=false;
  const epoch=owner=>epochs.get(owner)||0,active=(owner,generation)=>assert(Number.isSafeInteger(owner)&&owner>=0&&!closed&&epoch(owner)===generation,'COMPUTE_RESOURCE_CLOSED: 资源窗口或运行owner已关闭。'),serialize=operation=>{const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;};
  async function load(){
    const parent=await pinned;await checkDirectory(root,parent);const caps=await capabilities();assert(plain(caps)&&Number.isSafeInteger(caps.logicalCpuCount)&&caps.logicalCpuCount>0&&Number.isSafeInteger(caps.totalPhysicalMemoryBytes)&&caps.totalPhysicalMemoryBytes>0,'COMPUTE_RESOURCE_CAPABILITY: 本机资源信息不可用。');let record,value=null,error;
    const defaults=factoryPolicy(caps);let storedSchema;
    try{record=await currentFile(file,undefined,LIMIT);if(record){const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.bytes));exact(parsed,['schemaVersion','value']);assert([1,2].includes(parsed.schemaVersion),'Unknown compute-resource preference schema');storedSchema=parsed.schemaVersion;value=storedSchema===1?migratePolicy(parsed.value,defaults):validatePolicy(parsed.value);}}
    catch(cause){if(!record&&cause.code!=='PORTABLE_INVALID_FILE')throw cause;error='计算资源偏好无法读取，原文件已保留：'+cause.message;}
    const effective=value??defaults;try{validatePolicy(effective,caps);}catch(cause){error=error??cause.message;}
    // Read v1 without replacing its bytes. A successful explicit save writes v2.
    const confirmed=value!==null;
    const version=record?.sha256??(error?'invalid':'missing'),source=value?'saved-preferences':'factory-default',revision=createHash('sha256').update(JSON.stringify({version,effective,source,logicalCpuCount:caps.logicalCpuCount,totalPhysicalMemoryBytes:caps.totalPhysicalMemoryBytes})).digest('hex');return{version,revision,value,effective,defaults,confirmed,source,logicalCpuCount:caps.logicalCpuCount,totalPhysicalMemoryBytes:caps.totalPhysicalMemoryBytes,writable:!error,...(error?{error}:{}),parent,record,storedSchema};
  }
  const snapshot=state=>structuredClone(Object.fromEntries(Object.entries(state).filter(([key])=>!['parent','record','storedSchema'].includes(key))));
  async function write(owner,generation,request){
    active(owner,generation);exact(request,['baseVersion','value']);assert(request.baseVersion==='missing'||typeof request.baseVersion==='string'&&/^[a-f0-9]{64}$/.test(request.baseVersion),'COMPUTE_RESOURCE_VERSION: Invalid resource base version');const baseline=baselines.get(owner);assert(baseline&&baseline.version===request.baseVersion,'COMPUTE_RESOURCE_BASE: 请先读取资源设置。');const current=await load();active(owner,generation);assert(current.writable&&baseline.writable,'COMPUTE_RESOURCE_SCHEMA: 损坏或未来版本偏好须保留。');assert(current.version===baseline.version&&current.parent===baseline.parent,'COMPUTE_RESOURCE_CONFLICT: 另一窗口已修改资源，请重新读取。');
    const next=request.value;
    const full=plain(next)&&policyFields.some(key=>Object.hasOwn(next,key));
    const policy=full?{...next,netCpuThreads:current.effective.netCpuThreads}:current.storedSchema===2
      ? {...Object.fromEntries(policyFields.map(key=>[key,current.effective[key]])),...validateComputeResources(next)}
      : migratePolicy(next,current.defaults);
    const value=validatePolicy(policy,current);
    const bytes=Buffer.from(JSON.stringify({schemaVersion:2,value},null,2)+'\n');await atomicWrite(file,bytes,current.record,current.parent,undefined,LIMIT);let saved;try{saved=await load();active(owner,generation);assert(saved.writable&&saved.version===createHash('sha256').update(bytes).digest('hex'),'COMPUTE_RESOURCE_READBACK: 写入后资源身份不符。');}catch(error){error.publicationPerformed=true;throw error;}baselines.set(owner,saved);return snapshot(saved);
  }
  return{
    read(owner){const generation=epoch(owner);return serialize(async()=>{active(owner,generation);const state=await load();active(owner,generation);baselines.set(owner,state);return snapshot(state);});},
    write(owner,request){const generation=epoch(owner);return serialize(()=>write(owner,generation,request));},
    resolveForRun(owner,request={},capability,lane){
      const generation=epoch(owner);
      return serialize(async()=>{
        active(owner,generation);const state=await load();active(owner,generation);assert(state.writable&&!state.error,'COMPUTE_RESOURCE_UNAVAILABLE: '+(state.error??'资源不可用'));
        if(capability)assert(plain(capability)&&validThreadCount(capability.maxThreads)&&typeof capability.reason==='string'&&capability.reason.length>0&&
          (capability.automaticAtomThreshold===undefined||validThreadCount(capability.automaticAtomThreshold)),'COMPUTE_RESOURCE_CAPABILITY: Invalid trusted thread capability');
        if(lane!==undefined)assert(lanes.includes(lane),'COMPUTE_RESOURCE_CAPABILITY: Invalid trusted resource lane');
        const overrides=resourceOverrides(request.resourceOverrides,state.logicalCpuCount);
        const value=state.effective,policy=threadPolicy(value,request,lane,capability);
        const threads=capability?Math.min(policy.threads,capability.maxThreads):policy.threads;
        const threadLimitReason=threads<policy.threads?capability.reason:policy.reason;
        const estimated=retainedMemoryEstimate(owner);assert(Number.isSafeInteger(estimated)&&estimated>=0,'Invalid retained memory estimate');
        return Object.freeze({...executionValues(value,threads),...(estimated?{retainedMemoryEstimateBytes:estimated}:{}),
          version:state.revision,source:state.source,configured:Object.freeze(executionValues(value,policy.ceiling)),
          requested:Object.freeze(validateComputeResources({threads:(lane==='xtb-single'?overrides.xtbSingleTaskThreads:undefined)??request.threads??policy.ceiling,memoryBudgetBytes:request.memoryBudgetBytes??value.memoryBudgetBytes})),
          ...(threads<policy.ceiling?{threadLimitReason}:{}),
          ...(lane!==undefined?{threadLane:lane,xtbBatchParallelism:(lane==='xtb-single'||lane==='xtb-batch'?overrides.xtbBatchParallelism:undefined)??value.xtbBatchParallelism,netCpuThreads:value.netCpuThreads}:{})});
      });
    },
    disposeOwner(owner){epochs.set(owner,epoch(owner)+1);baselines.delete(owner);},dispose(){closed=true;baselines.clear();},settle:()=>queue,
  };
}
module.exports={FACTORY_RESOURCES,LIMIT,validateComputeResources,captureComputeResources,attachComputeResourceGrant,createComputeResources};
