'use strict';
const { readManagedResult } = require('./analysis-result-wire.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, plain, string } = require('./security.cjs');
const { createMultiwfnScheduler } = require('./multiwfn-scheduler.cjs');
const SCIENTIFIC = new Set(['analyze','region','distribution','generate','hirshfeld-analyze']);
const EXPORTS = new Set(['export-cube','hirshfeld-export']);

function hirshfeldCluster(raw, expected) {
  const allowed=['kind','sourceId','sourceRevision','coordinateUnit','completeFiniteCluster','atoms'];
  assert(plain(raw)&&Object.keys(raw).every(key=>allowed.includes(key))&&raw.kind==='finite-cluster'&&raw.coordinateUnit==='angstrom'&&raw.completeFiniteCluster===true,'Invalid complete finite HS cluster');
  assert(raw.sourceId===expected.sourceId&&raw.sourceRevision===expected.sourceRevision,'HS cluster and context identity differ');
  assert(Array.isArray(raw.atoms)&&raw.atoms.length>=2,'HS requires at least two explicit cluster atoms');
  const ids=new Set();
  for(let i=0;i<raw.atoms.length;i++){
    const atom=raw.atoms[i];assert(plain(atom)&&Object.keys(atom).every(key=>['sourceIndex','stableId','element','position','coordinatePrecisionAngstrom','imageRef'].includes(key)),'Invalid HS source atom');
    assert(atom.sourceIndex===i+1&&string(atom.stableId,512)&&!ids.has(atom.stableId)&&typeof atom.element==='string'&&/^[A-Z][a-z]?$/.test(atom.element),'Invalid HS atom identity');ids.add(atom.stableId);
    assert(Array.isArray(atom.position)&&atom.position.length===3&&atom.position.every(Number.isFinite),'Invalid HS scientific coordinates');
    assert(atom.coordinatePrecisionAngstrom===undefined||Number.isFinite(atom.coordinatePrecisionAngstrom)&&atom.coordinatePrecisionAngstrom>=0,'Invalid HS coordinate precision');
    if(atom.imageRef!==undefined){const image=atom.imageRef;assert(plain(image)&&Object.keys(image).every(key=>['sourceAtomId','translation'].includes(key))&&string(image.sourceAtomId,512)&&Array.isArray(image.translation)&&image.translation.length===3&&image.translation.every(Number.isSafeInteger),'Invalid HS image identity');}
  }
  return structuredClone(raw);
}
function hirshfeldRequest(operation, raw, atomCount) {
  const expected=operation==='hirshfeld-analyze'?['stamp','targetAtomIndices','environmentAtomIndices','quantitativeGrid','mapping']:operation==='hirshfeld-restore'?['stamp','generationId']:['stamp','fieldId'];
  const optional=operation==='hirshfeld-analyze'?['mode']:[];
  assert(Object.keys(raw).length>=expected.length&&expected.every(key=>Object.hasOwn(raw,key))&&Object.keys(raw).every(key=>expected.includes(key)||optional.includes(key)),'Invalid HS operation fields');
  if(operation==='hirshfeld-analyze'){
    assert(raw.mode===undefined||raw.mode==='closed'||raw.mode==='open-preview','Invalid HS analysis mode');
    const target=raw.targetAtomIndices,environment=raw.environmentAtomIndices;
    assert([target,environment].every(values=>Array.isArray(values)&&values.length&&values.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=atomCount)&&new Set(values).size===values.length),'Invalid HS target/environment selection');
    assert(target.length+environment.length===atomCount&&new Set([...target,...environment]).size===atomCount,'HS target/environment must partition the complete cluster');
    assert(raw.mapping==='dnorm'&&plain(raw.quantitativeGrid)&&Object.keys(raw.quantitativeGrid).length===2&&raw.quantitativeGrid.mode==='spacing'&&Number.isFinite(raw.quantitativeGrid.spacingBohr)&&raw.quantitativeGrid.spacingBohr>0,'HS requires explicit spacing and dnorm mapping');
  }else assert(string(raw[operation==='hirshfeld-restore'?'generationId':'fieldId'],256),'Invalid completed HS artifact identity');
}

const CONTEXT_KEYS = ['sourceId','sourceRevision','jobIndex','sourceFrameIndex','generation','documentId','documentRevision','activationEpoch'];
function context(value) {
  assert(plain(value) && Object.keys(value).every(key => CONTEXT_KEYS.includes(key)), 'Invalid surface context');
  assert(string(value.sourceId,512) && string(value.sourceRevision,512), 'Surface source identity is missing');
  for (const key of ['jobIndex','sourceFrameIndex']) assert(value[key] === null || Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid surface source index');
  assert(Number.isSafeInteger(value.generation) && value.generation >= 0, 'Invalid surface source generation');
  for (const key of ['documentRevision','activationEpoch']) assert(value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid surface document generation');
  assert(value.documentId === undefined || string(value.documentId,512), 'Invalid surface document identity');
  return Object.fromEntries(Object.entries(value).filter(([,entry]) => entry !== undefined));
}
function sameContext(a,b) { return CONTEXT_KEYS.every(key => a[key] === b[key]); }
function stamp(value, expected) {
  assert(plain(value) && Object.keys(value).every(key => CONTEXT_KEYS.includes(key) || ['requestId','analysisId'].includes(key)), 'Invalid surface stamp');
  assert(string(value.requestId,256) && string(value.analysisId,256), 'Surface request/analysis identity is missing');
  const actual=context(Object.fromEntries(Object.entries(value).filter(([key]) => CONTEXT_KEYS.includes(key))));
  assert(sameContext(actual,expected), 'Surface request belongs to another source/frame/document');
  return {...actual,requestId:value.requestId,analysisId:value.analysisId};
}
function wireValue(value) {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(wireValue);
  if (plain(value)&&value.kind==='node-mask'&&value.mask instanceof Uint8Array) return {...wireValue(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='mask'))),maskBase64:Buffer.from(value.mask).toString('base64')};
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key,entry]) => [key,wireValue(entry)]));
  return value;
}
function retainedJsBytes(value,seen=new Set()) {
  if(typeof value==='string')return value.length*2;
  if(!value||typeof value!=='object'||seen.has(value))return 0;seen.add(value);
  if(ArrayBuffer.isView(value))return value.byteLength+128;
  return 64+Object.entries(value).reduce((bytes,[key,entry])=>bytes+key.length*2+24+retainedJsBytes(entry,seen),0);
}
function hydrate(value) {
  if (Array.isArray(value)) return value.map(hydrate);
  if (!plain(value)) return value;
  const result=Object.fromEntries(Object.entries(value).filter(([key]) => !['valuesBase64','maskBase64'].includes(key)).map(([key,entry]) => [key,hydrate(entry)]));
  if (value.valuesBase64 !== undefined) {
    assert((typeof value.valuesBase64 === 'string'||value.valuesBase64 instanceof Uint8Array) && plain(value.grid) && Array.isArray(value.grid.dimensions) && value.grid.dimensions.length === 3, 'Invalid surface field wire payload');
    const count=value.grid.dimensions.reduce((total,n) => {assert(Number.isSafeInteger(n)&&n>0,'Invalid surface grid count');return total*n;},1);
    const buffer=typeof value.valuesBase64==='string'?Buffer.from(value.valuesBase64,'base64'):value.valuesBase64;assert(Number.isSafeInteger(count)&&buffer.length===count*8,'Incomplete surface field values');
    result.values=buffer.byteOffset%8===0?new Float64Array(buffer.buffer,buffer.byteOffset,buffer.length/8):new Float64Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length));
    assert(result.values.every(Number.isFinite),'Surface field has nonfinite values');
  }
  if (value.maskBase64 !== undefined) {
    assert(typeof value.maskBase64 === 'string'||value.maskBase64 instanceof Uint8Array,'Invalid surface domain mask');
    result.mask=typeof value.maskBase64==='string'?new Uint8Array(Buffer.from(value.maskBase64,'base64')):value.maskBase64;
    assert(result.mask.every(entry => entry === 0 || entry === 1),'Invalid surface domain node membership');
  }
  if (result.values && result.validDomain?.kind === 'node-mask') assert(result.validDomain.mask?.length===result.values.length,'Surface mask/value count differs');
  return result;
}
/** One owned worker and serialized native science across trusted surface sources. */
function createSurfaceAnalysisHost({spawn,resolveRuntime,resolveBackend,resolveResources,captureResources,scheduler=createMultiwfnScheduler(),jobRoot,sendToWindow=()=>{},sendProgress=()=>{},limits={}}) {
  const policy={requestMs:0,stopMs:6000,...limits};
  const sessions=new Map(),pending=new Map(),tasks=new Set(),closedOwners=new Set();
  let worker=null,disposed=false,sequence=0,active=0;
  function track(task) {tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;}
  function owned(owner,id,expected) {const s=sessions.get(id);assert(s&&s.owner===owner&&!s.closed&&(!expected||s===expected),'Surface session is not owned or is closed');return s;}
  function emit(s,status,operation,request) {if(s.closed||closedOwners.has(s.owner))return;try{sendToWindow(s.owner,{sessionId:s.sessionId,stamp:request?.stamp,operation,status});}catch{void closeOwner(s.owner);}}
  function failWorker(error,w=worker) {
    if(!w||worker!==w)return;
    const failed=[...pending.values()];for(const entry of failed)clearTimeout(entry.timer);pending.clear();
    if(!w.terminating){w.terminating=true;try{w.child.stdin.end();}catch{}w.timer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.timer.unref?.();}
    // A rejected science command must not release its shared lease while the
    // failed worker could still own a native child/job.
    void w.finished.then(()=>{for(const entry of failed)entry.reject(error);});
  }
  function ensureWorker() {
    assert(!disposed,'Surface host is disposed');
    if(worker){assert(!worker.terminating,'Surface worker is closing');return worker;}
    const runtime=resolveRuntime();
    const child=spawn(runtime.executable,runtime.args,{cwd:runtime.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
    const w=worker={child,parts:[],bytes:0,closed:false,terminating:false,stderr:''};
    w.finished=new Promise(resolve=>{w.finish=resolve;});
    function message(packet) {
      if(plain(packet)&&packet.event==='task-progress'){
        const entry=pending.get(packet.id);if(entry&&packet.sessionId===entry.sessionId&&plain(packet.progress))entry.taskProgress?.report(packet.progress.phase,packet.progress);return;
      }
      assert(plain(packet)&&string(packet.id,128)&&typeof packet.ok==='boolean','Invalid surface worker packet');
      const entry=pending.get(packet.id);assert(entry&&entry.sessionId===packet.sessionId,'Unknown surface worker reply identity');
      if(SCIENTIFIC.has(entry.operation)&&packet.nativeSettled!==true){failWorker(new Error('SURFACE_NATIVE_UNSETTLED: 原生进程尚未确认结束'),w);return;}
      if(packet.retainedMemoryBytes!==undefined)assert(Number.isSafeInteger(packet.retainedMemoryBytes)&&packet.retainedMemoryBytes>=0,'Invalid surface retained-memory count');
      if(!packet.ok)assert(plain(packet.error)&&string(packet.error.code,128)&&string(packet.error.message,16384),'Invalid surface worker error');
      pending.delete(packet.id);clearTimeout(entry.timer);
      const s=sessions.get(packet.sessionId);if(s&&packet.retainedMemoryBytes!==undefined)s.retainedBytes=packet.retainedMemoryBytes;
      if(!packet.ok){entry.reject(new Error(`${packet.error.code}: ${packet.error.message}`));}
      else entry.resolve(packet.result);
    }
    child.stdout.on('data',chunk=>{if(w.terminating)return;try{let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);while(bytes.length){const index=bytes.indexOf(10),part=index<0?bytes:bytes.subarray(0,index);w.parts.push(part);w.bytes+=part.length;if(index<0)break;const line=Buffer.concat(w.parts,w.bytes).toString('utf8');w.parts=[];w.bytes=0;message(JSON.parse(line));bytes=bytes.subarray(index+1);}}catch(error){failWorker(error,w);}});
    child.stderr.on('data',chunk=>{w.stderr=(w.stderr+chunk.toString('utf8')).slice(-8192);});
    child.stdin.on('error',error=>failWorker(error,w));child.on('error',error=>failWorker(error,w));
    child.on('close',(code,signal)=>{w.closed=true;clearTimeout(w.timer);if(worker===w){if(!w.terminating)failWorker(new Error(`Surface worker exited (code=${code}, signal=${signal??'none'}): ${w.stderr}`),w);worker=null;}w.finish(code);});
    return w;
  }
  function request(operation,s,extra={}) {
    const w=ensureWorker();const id=`surface-${++sequence}`;
    return new Promise((resolve,reject)=>{
      const timer=policy.requestMs>0?setTimeout(()=>{failWorker(new Error('SURFACE_TIMEOUT: Surface worker response exceeded its explicit deadline'),w);},policy.requestMs):undefined;timer?.unref?.();
      pending.set(id,{resolve,reject,timer,sessionId:s.sessionId,operation,taskProgress:s.taskProgress});
      try{w.child.stdin.write(JSON.stringify(wireValue({id,operation,sessionId:s.sessionId,...extra}))+'\n');}catch(error){failWorker(error,w);}
    }).then(value=>readManagedResult(value,s.directory));
  }
  async function currentResources(owner,s,captured) {
    const resources=resolveResources?await resolveResources(owner,s.resourceOverrides,captured):await request('resources',s,{executable:s.backendPath,...s.resourceOverrides});
    assert(plain(resources)&&Number.isSafeInteger(resources.threads)&&resources.threads>0&&Number.isSafeInteger(resources.memoryBudgetBytes)&&resources.memoryBudgetBytes>0,'Current Multiwfn resources are unavailable');
    if(s.resourceOverrides)assert(Number.isSafeInteger(resources.logicalCpuCount)&&resources.logicalCpuCount>0&&Number.isSafeInteger(resources.totalPhysicalMemoryBytes)&&resources.totalPhysicalMemoryBytes>0&&s.resourceOverrides.threads<=resources.logicalCpuCount&&s.resourceOverrides.memoryBudgetBytes<=resources.totalPhysicalMemoryBytes,'Explicit HS resource overrides exceed available logical CPUs or physical RAM');
    return resources;
  }
  async function checkedPath(value) {assert(string(value,4096)&&path.isAbsolute(value),'Surface path must be host-resolved');const stat=await fs.lstat(value);assert(stat.isFile()&&!stat.isSymbolicLink(),'Surface sources must be regular immutable files');return fs.realpath(value);}
  async function open(owner,source,overrides) {
    assert(Number.isSafeInteger(owner)&&owner>=0&&!disposed&&!closedOwners.has(owner),'Surface owner is closed');
    assert(plain(source)&&string(source.sessionId,200)&&!sessions.has(source.sessionId),'Invalid/duplicate surface session');
    assert(overrides===undefined||(source.kind==='hirshfeld-cluster'&&plain(overrides)&&Object.keys(overrides).length===2&&Object.keys(overrides).every(k=>['threads','memoryBudgetBytes'].includes(k))&&Number.isSafeInteger(overrides.threads)&&overrides.threads>0&&overrides.threads<=2147483647&&Number.isSafeInteger(overrides.memoryBudgetBytes)&&overrides.memoryBudgetBytes>0),'Explicit resource overrides require an HS source and exactly two positive resource budgets');
    const resourceOverrides=overrides===undefined?undefined:Object.freeze({...overrides});
    const sourceContext=context(source.context);
    if(source.kind==='hirshfeld-cluster'){
      assert(Object.keys(source).every(key=>['sessionId','kind','cluster','context'].includes(key)),'Invalid HS source snapshot');
      source={sessionId:source.sessionId,kind:source.kind,context:sourceContext,cluster:hirshfeldCluster(source.cluster,sourceContext)};
    }
    const s={owner,sessionId:source.sessionId,context:sourceContext,family:source.kind==='hirshfeld-cluster'?'hirshfeld':'surface',resourceOverrides,closed:false,inflight:new Set(),source,openAbort:new AbortController(),retainedBytes:0};sessions.set(s.sessionId,s);
    let lease;
    try{
      const trusted={...source,context:s.context};delete trusted.sessionId;
      if(source.kind==='wavefunction'){trusted.sourcePath=await checkedPath(source.sourcePath);}
      else if(source.kind!=='hirshfeld-cluster'){assert(source.kind==='cube-pair'&&plain(source.shape)&&plain(source.shape.fieldMetadata),'Invalid surface Cube source');trusted.shape={...source.shape,path:await checkedPath(source.shape.path)};trusted.mapping=source.mapping?{...source.mapping,path:await checkedPath(source.mapping.path)}:null;}
      lease=await scheduler.acquire({owner,key:'surface:open:'+s.sessionId,signal:s.openAbort.signal});
      const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,s.openAbort.signal):undefined;owned(owner,s.sessionId,s);assert(!s.openAbort.signal.aborted,'SURFACE_CANCELLED');
      const backend=await resolveBackend();assert(backend.configured&&string(backend.path,4096),'SURFACE_BACKEND_MISSING: 请先选择本机 Multiwfn');
      s.backendPath=backend.path;
      const configured=await currentResources(owner,s,captured),budget=lease.budget(configured.memoryBudgetBytes,{domain:'surface',sessionId:s.sessionId});
      const resources={...configured,memoryBudgetBytes:budget.availableBytes,sharedReservedBytes:budget.reservedBytes,configuredMemoryBudgetBytes:budget.memoryBudgetBytes};
      owned(owner,s.sessionId,s);await fs.mkdir(jobRoot,{recursive:true});s.directory=await fs.mkdtemp(path.join(jobRoot,'surface-'));
      const result=await request('open',s,{source:trusted,workspacePath:s.directory,executable:backend.path,...(resources?{resources}:{})});
      owned(owner,s.sessionId,s);assert(result.sessionId===s.sessionId&&sameContext(result.context,s.context)&&Array.isArray(result.capabilities),'Surface open identity changed');
      if(s.family==='hirshfeld')assert(result.family==='hirshfeld'&&result.atomCount===s.source.cluster.atoms.length&&result.capabilities.length===1&&result.capabilities[0]?.function==='hirshfeld','HS open returned another scientific family');
      assert(Number.isSafeInteger(result.retainedMemoryBytes)&&result.retainedMemoryBytes>=0,'Invalid surface source reservation');s.retainedBytes=result.retainedMemoryBytes;
      s.info=s.family==='hirshfeld'?{...result,resources:{...resources,...result.resources,configured:true,configuredMemoryBudgetBytes:budget.memoryBudgetBytes,sharedReservedBytes:budget.reservedBytes},resourceSnapshot:'open-grant'}:result;return s.family==='hirshfeld'?structuredClone(s.info):s.info;
    }catch(error){
      s.closed=true;
      // An open reply can arrive after its owner closes. Settle the worker's
      // actual session before deleting files or releasing source references.
      if(worker&&!worker.closed&&!worker.terminating)await request('close',s).catch(()=>{});
      if(worker?.terminating)await worker.finished;
      sessions.delete(s.sessionId);await clean(s.directory);
      if(!sessions.size&&worker&&!worker.closed&&!worker.terminating){const w=worker;w.terminating=true;w.child.stdin.end();w.timer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.timer.unref?.();await w.finished;}
      throw error;
    }finally{lease?.release();}
  }
  async function operate(owner,id,operation,raw) {
    const s=owned(owner,id);assert(plain(raw),'Invalid surface operation request');const identity=stamp(raw.stamp,s.context);
    assert(operation.startsWith('hirshfeld-')===(s.family==='hirshfeld'),'Surface operation belongs to another scientific family');
    if(s.family==='hirshfeld'){hirshfeldRequest(operation,raw,s.source.cluster.atoms.length);raw=structuredClone(raw);}
    assert(!s.busy,'SURFACE_BUSY: 此表面实例已有任务');
    const {progressIdentity,createMultiwfnProgress}=require('./multiwfn-progress.cjs');
    const taskProgress=SCIENTIFIC.has(operation)?createMultiwfnProgress(progressIdentity({ownerId:identity.analysisId,analysisId:identity.analysisId,runId:identity.requestId,sessionId:s.sessionId,sourceId:s.context.sourceId,sourceRevision:s.context.sourceRevision,jobIndex:s.context.jobIndex,sourceFrameIndex:s.context.sourceFrameIndex,generation:s.context.generation,operation},{sessionId:s.sessionId,sourceId:s.context.sourceId,sourceRevision:s.context.sourceRevision}),snapshot=>sendProgress(owner,snapshot)):null;
    s.taskProgress=taskProgress;s.busy=true;active++;emit(s,'queued',operation,raw);taskProgress?.report('queued');
    const controller=new AbortController();s.operationAbort=controller;let lease,submitted=false,successful=false;
    try{
      let resources;
      if(SCIENTIFIC.has(operation)){
        lease=await scheduler.acquire({owner,key:'surface:'+operation+':'+id+':'+identity.requestId,signal:controller.signal});
        const captured=captureResources?await require('./compute-resources.cjs').captureComputeResources(captureResources,owner,controller.signal):undefined;owned(owner,id,s);
        owned(owner,id,s);assert(!controller.signal.aborted,'SURFACE_CANCELLED: 已取消等待中的分析');
        const backend=await resolveBackend();owned(owner,id,s);assert(!controller.signal.aborted,'SURFACE_CANCELLED');
        assert(backend.configured&&string(backend.path,4096)&&path.resolve(backend.path).toLowerCase()===path.resolve(s.backendPath).toLowerCase(),'SURFACE_BACKEND_CHANGED: Multiwfn 路径已变化或不可用，请重新打开此分析来源；已有结果保留。');
        const configured=await currentResources(owner,s,captured),budget=lease.budget(configured.memoryBudgetBytes,{domain:'surface',sessionId:id});
        resources={...configured,memoryBudgetBytes:budget.availableBytes,sharedReservedBytes:budget.reservedBytes,configuredMemoryBudgetBytes:budget.memoryBudgetBytes};
        if(s.family==='hirshfeld')s.info={...s.info,resources,resourceSnapshot:'analysis-grant'};
      }
      taskProgress?.report('running');const pendingResult=request(operation,s,{request:{...raw,stamp:identity},...(resources?{resources}:{})});submitted=true;const result=await pendingResult;owned(owner,id,s);taskProgress?.report('parse');
      assert(plain(result),'Invalid surface operation result');
      const actual=result.stamp;
      if(!EXPORTS.has(operation))assert(plain(actual)&&actual.requestId===identity.requestId&&actual.analysisId===identity.analysisId&&sameContext(actual,s.context),'Surface result stamp changed');
      if(EXPORTS.has(operation))assert(string(result.name,512)&&path.basename(result.name)===result.name&&typeof result.text==='string'&&(!result.domain||plain(result.domain)&&string(result.domain.name,512)&&path.basename(result.domain.name)===result.domain.name&&typeof result.domain.text==='string'),'Invalid Cube export payload');
      if(s.family==='hirshfeld'&&!EXPORTS.has(operation))assert(result.kind==='hirshfeld'&&plain(result.pair)&&result.pair.kind==='hirshfeld'&&result.pair.shape?.function==='hirshfeld-weight'&&result.pair.mapping?.function==='dnorm','Invalid HS result family or field roles');
      const value=hydrate(result);if(s.family==='hirshfeld'&&!EXPORTS.has(operation))value.sessionInfo=structuredClone(s.info);successful=true;emit(s,'completed',operation,raw);return value;
    }catch(error){
      if(s.family==='hirshfeld'&&submitted&&!controller.signal.aborted){
        const diagnostic=await retainHirshfeldFailure(s).catch(()=>null);
        if(diagnostic)error.message+='\n诊断文件：'+diagnostic;
      }
      emit(s,'failed',operation,raw);throw error;
    }finally{lease?.release();if(controller.signal.aborted)taskProgress?.report('stopped',{settlement:submitted?'native-settled':'cancelled-before-start'});else if(successful)taskProgress?.report('parse',{stageLabel:'等待结果接受',settlement:'native-settled',validated:true});else taskProgress?.report('failed',{settlement:submitted?'native-settled':'not-started'});if(s.operationAbort===controller)s.operationAbort=null;if(s.taskProgress===taskProgress)s.taskProgress=null;s.busy=false;active--;}
  }
  async function retainHirshfeldFailure(s){
    // Small owned diagnostic records survive closing the failed session. Cube
    // arrays and native working directories are still released normally.
    if(!s.directory)return null;
    const entries=await fs.readdir(s.directory,{withFileTypes:true});
    const names=['hirshfeld-diagnostic.json','source.xyz','settings.ini','native-output.txt','menu-input.txt'];
    const candidates=[];
    for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink()&&entry.name.startsWith('hirshfeld-')){
      const directory=path.join(s.directory,entry.name),marker=await fs.lstat(path.join(directory,names[0])).catch(()=>null);
      if(marker?.isFile()&&!marker.isSymbolicLink())candidates.push({directory,mtime:marker.mtimeMs});
    }
    candidates.sort((a,b)=>b.mtime-a.mtime);if(!candidates.length)return null;
    const parent=path.join(jobRoot,'diagnostics');await fs.mkdir(parent,{recursive:true});
    const target=await fs.mkdtemp(path.join(parent,'hirshfeld-')),members=[];
    for(const name of names){const source=path.join(candidates[0].directory,name),stat=await fs.lstat(source).catch(()=>null);if(!stat?.isFile()||stat.isSymbolicLink())continue;
      const handle=await fs.open(source,'r');try{const buffer=Buffer.alloc(Math.min(stat.size,512*1024)),{bytesRead}=await handle.read(buffer,0,buffer.length,0);await fs.writeFile(path.join(target,name),buffer.subarray(0,bytesRead),{flag:'wx'});members.push({name,sourceBytes:stat.size,retainedBytes:bytesRead,truncated:bytesRead<stat.size});}finally{await handle.close();}
    }
    await fs.writeFile(path.join(target,'receipt.json'),JSON.stringify({sessionId:s.sessionId,context:s.context,members,createdAt:new Date().toISOString()},null,2),{flag:'wx'});return target;
  }
  function sessionOperation(owner,id,operation,raw) {const s=owned(owner,id);const task=operate(owner,id,operation,raw);s.inflight.add(task);task.then(()=>s.inflight.delete(task),()=>s.inflight.delete(task));return track(task);}
  async function cancel(owner,id) {
    const s=owned(owner,id);s.taskProgress?.report('stopping');s.operationAbort?.abort();const inflight=[...s.inflight];const result=await request('cancel',s);await Promise.allSettled(inflight);return {...result,activeOperationPending:false};
  }
  async function clean(directory) {
    if(!directory)return;
    assert(path.resolve(directory).startsWith(path.resolve(jobRoot)+path.sep),'Surface cleanup target escapes its owned job root');
    const entries=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries){const target=path.join(directory,entry.name);if(entry.isFile()&&!entry.isSymbolicLink())await fs.unlink(target).catch(()=>{});else if(entry.isDirectory()&&!entry.isSymbolicLink())await clean(target);}
    await fs.rmdir(directory).catch(()=>{});
  }
  async function closeSession(owner,id) {
    const s=sessions.get(id);if(!s)return {sessionId:id,status:'closed'};assert(s.owner===owner,'Surface source belongs to another owner');if(s.closeTask)return s.closeTask;
    s.closed=true;s.openAbort.abort();s.operationAbort?.abort();
    return s.closeTask=(async()=>{try{if(worker&&!worker.closed&&!worker.terminating)await request('close',s);await Promise.allSettled([...s.inflight]);if(worker?.terminating)await worker.finished;}finally{sessions.delete(id);await clean(s.directory);if(!sessions.size&&worker&&!worker.closed&&!worker.terminating){const w=worker;w.terminating=true;w.child.stdin.end();w.timer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.timer.unref?.();await w.finished;}}return {sessionId:id,status:'closed'};})();
  }
  async function closeOwner(owner) {closedOwners.add(owner);await Promise.all([...sessions.values()].filter(s=>s.owner===owner).map(s=>closeSession(owner,s.sessionId)));}
  function dispose() {
    if(disposed)return;disposed=true;
    for(const s of sessions.values()){s.closed=true;s.openAbort.abort();s.operationAbort?.abort();}
    const w=worker;if(w&&!w.terminating){w.terminating=true;w.child.stdin.end();w.timer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.timer.unref?.();}
    const inflight=[...tasks];
    track((async()=>{if(w)await w.finished;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Surface host disposed'));}pending.clear();await Promise.allSettled(inflight);for(const s of sessions.values())await clean(s.directory);sessions.clear();})());
  }
  return {
    open:(...args)=>track(open(...args)),capabilities:async(owner,id)=>{if(id)return owned(owner,id).info.capabilities;assert(Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&!disposed,'Surface owner is closed');const backend=await resolveBackend();return ['esp','alie'].map(function_=>({function:function_,wavefunctionDirect:!!backend.configured,cubeInterpolation:!!backend.configured,atomRegions:!!backend.configured,fragmentRegions:!!backend.configured,extrema:!!backend.configured,distribution:!!backend.configured,generation:!!backend.configured,valueUnit:'a.u.',...(!backend.configured?{reason:'请先选择本机 Multiwfn；具体来源能力在打开后单独核对。'}:{})}));},
    analyze:(owner,id,raw)=>sessionOperation(owner,id,'analyze',raw),region:(owner,id,raw)=>sessionOperation(owner,id,'region',raw),
    distribution:(owner,id,raw)=>sessionOperation(owner,id,'distribution',raw),generate:(owner,id,raw)=>sessionOperation(owner,id,'generate',raw),
    restoreFields:(owner,id,raw)=>sessionOperation(owner,id,'restore-fields',raw),
    hirshfeldAnalyze:(owner,id,raw)=>sessionOperation(owner,id,'hirshfeld-analyze',raw),
    hirshfeldRestore:(owner,id,raw)=>sessionOperation(owner,id,'hirshfeld-restore',raw),
    hirshfeldExport:(owner,id,raw)=>sessionOperation(owner,id,'hirshfeld-export',raw),
    exportCube:(owner,id,raw)=>sessionOperation(owner,id,'export-cube',raw),
    evidence:(owner,id)=>request('evidence',owned(owner,id)),
    cancel:(...args)=>track(cancel(...args)),closeSession:(...args)=>track(closeSession(...args)),closeOwner:(...args)=>track(closeOwner(...args)),dispose,
    settle:async()=>{while(tasks.size)await Promise.allSettled([...tasks]);},
    workerCount:()=>worker&&!worker.closed?1:0,sessionCount:()=>sessions.size,activeCount:()=>active,
    reservedMemoryBytes:()=>[...sessions.values()].reduce((bytes,s)=>bytes+(s.retainedBytes||0)+retainedJsBytes(s.source),0),
  };
}
module.exports={createSurfaceAnalysisHost,hydrate,stamp,context};
