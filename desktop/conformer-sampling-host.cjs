'use strict';
const path=require('node:path');
const {StringDecoder}=require('node:string_decoder');
const {isDeepStrictEqual:same}=require('node:util');
const {assert}=require('./security.cjs');
const {TERMINAL,sessionIdentity,validateStart,validateEvent,expectedFrames,expectedBiasHistoryCount,requiresXtbRuntime,samplingSegmentFields}=require('./conformer-sampling-security.cjs');
const {cleanTaskDirectory}=require('./task-cache.cjs');
const {DEFAULT_OUTPUT_BUDGET_BYTES,outputBudget}=require('./output-budget.cjs');
const {createConformerSamplingStore}=require('./conformer-sampling-store.cjs');

/** Shared admission belongs to Main. A stop/kill request retains the lease until
 * the actual owned worker close; this module has no independent scheduler. */
function createConformerSamplingHost({spawn,resolveRuntime,resolveXtbRuntime,resolveResources,jobRoot,resultRoot,fs,sendToWindow,admit,
  nativePidAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}},limits={}}){
  const sessions=new Map(),closedOwners=new Set();let disposed=false;
  assert(resultRoot===undefined||typeof resultRoot==='string'&&path.isAbsolute(resultRoot),'Sampling result root must be host-owned and absolute');
  const resultStore=fs&&typeof fs.writeFile==='function'&&(resultRoot||jobRoot)?createConformerSamplingStore({fs,root:resultRoot??path.join(jobRoot,'results')}):null;
  const resultCloseTasks=new Set();
  function detachResults(owner){if(!resultStore)return;const closing=resultStore.closeOwner(owner).catch(error=>console.warn('SAMPLING_RESULT_CACHE_RETAINED',error.message)).finally(()=>resultCloseTasks.delete(closing));resultCloseTasks.add(closing);}
  const policy={stopMs:2000,maxOutputBytes:DEFAULT_OUTPUT_BUDGET_BYTES,maxPacketBytes:Infinity,maxEvents:50000,...limits};
  const key=(owner,id)=>`${owner}:${id}`;
  function emit(s,value){if(s.ownerClosed)return;try{const{kind,seq,...rest}=value;sendToWindow(s.owner,{...rest,...(s.effectiveResources?{effectiveResources:s.effectiveResources}:{}),event:kind,seq:s.emitSeq++});}catch{closeOwner(s.owner);}}
  function terminal(s,kind,data){const step=data.step??data.lastFrame?.step??(s.request.segment&&TERMINAL.has(kind)?0:undefined);return{schema:1,sessionId:s.id,runIdentity:s.request.runIdentity,stamp:s.request.stamp,operation:s.request.operation,method:s.request.method,kind,...data,...samplingSegmentFields(s.request,step),...(s.request.segment&&step!==undefined?{step}:{})};}
  async function directory(target){const stat=await fs.lstat(target),actual=await fs.realpath(target);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&(process.platform==='win32'?path.resolve(actual).toLowerCase()===path.resolve(target).toLowerCase():path.resolve(actual)===path.resolve(target)),'Sampling workspace must not traverse links');}
  async function nativeSetup(s){
    assert(typeof resolveXtbRuntime==='function'&&fs&&typeof jobRoot==='string'&&path.isAbsolute(jobRoot),'Host-owned native GFN-FF runtime/workspace unavailable');
    const runtime=await ownedWait(s,resolveXtbRuntime({signal:s.abortController.signal}));
    assert(runtime&&['executable','directory','dataDirectory'].every(k=>typeof runtime[k]==='string'&&path.isAbsolute(runtime[k]))&&path.dirname(runtime.executable)===path.resolve(runtime.directory)&&typeof runtime.version==='string','Trusted fixed xTB runtime required');
    await fs.mkdir(jobRoot,{recursive:true});await directory(jobRoot);const job=await fs.mkdtemp(path.join(jobRoot,'sampling-'));
    assert(path.dirname(job)===path.resolve(jobRoot),'Native sampling workspace escaped ownership');await directory(job);s.job=job;s.xtbRuntime=runtime;
  }
  async function waitNativeClosed(s){
    while(s.nativePids.size){for(const pid of s.nativePids){try{if(!nativePidAlive(pid))s.nativePids.delete(pid);}catch{ /* Unknown lifetime retains resource ownership. */ }}if(s.nativePids.size)await new Promise(resolve=>setTimeout(resolve,20));}
  }
  function onceRelease(release){let released=false;const wrapped=()=>{if(released)return;released=true;return release();};if(release.resources)Object.defineProperty(wrapped,'resources',{value:release.resources});return wrapped;}
  function resourceFields(value){assert(value&&Number.isSafeInteger(value.threads)&&value.threads>=1&&Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>0,'Invalid trusted compute-resource grant');return structuredClone(value);}
  function ownedWait(s,promise,lease=false){
    return new Promise((resolve,reject)=>{
      const signal=s.abortController.signal;let settled=false;
      const abort=()=>{if(settled)return;settled=true;reject(Error('Owned sampling admission/runtime wait cancelled'));};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      Promise.resolve(promise).then(value=>{
        signal.removeEventListener('abort',abort);
        if(lease){assert(typeof value==='function','Shared resource admission must return its release function');value=onceRelease(value);}
        if(settled){if(lease)Promise.resolve().then(value).catch(()=>{});return;}
        settled=true;if(lease)s.release=value;resolve(value);
      },error=>{signal.removeEventListener('abort',abort);if(!settled){settled=true;reject(error);}}).catch(error=>{signal.removeEventListener('abort',abort);if(!settled){settled=true;reject(error);}});
    });
  }
  function stop(s,reason='cancelled'){
    if(s.closed||s.stopReason)return;s.stopReason=reason;
    if(!s.child){s.abortController.abort(reason);return;}
    if(s.child){try{s.child.stdin.write(JSON.stringify({schema:1,sessionId:s.id,runIdentity:s.request.runIdentity,command:'stop'})+'\n');}catch{}
      s.killTimer=setTimeout(()=>{if(!s.closed)try{s.child.kill();}catch{}},policy.stopMs);s.killTimer.unref?.();}
  }
  async function finish(s,code,signal){
    if(s.closed)return;s.closed=true;clearTimeout(s.wallTimer);clearTimeout(s.killTimer);
    let outgoing;
    try{
      await waitNativeClosed(s);
      const extra=s.job?{nativeClosed:true}:{};
      if(s.stopReason){const observed=s.result?.nativeTemperatureObservations;const temperature=observed?{nativeTemperatureObservations:observed}:{};outgoing=terminal(s,s.stopReason==='cancelled'?'stopped':'error',s.stopReason==='cancelled'?{reason:'cancelled',lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal},...extra,...temperature}:{error:{code:'SAMPLING_HOST_STOPPED',message:s.stopReason},lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal},...extra,...temperature});}
      else if(s.failure||s.tail.trim()||!s.result||(code!==0&&s.result.kind!=='error')||signal!==null){outgoing=terminal(s,'error',{error:{code:'SAMPLING_WORKER_REJECTED',message:String(s.failure?.message??'Worker closed without a valid sampling terminal result').slice(0,8192)},lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal},...extra});}
      else outgoing={...s.result,exit:{code,signal},...extra};
      if(s.storeEntry)Object.assign(outgoing,{frameCount:s.frames,candidateCount:s.candidates,biasHistory:s.history});
      if(s.storeEntry){
        try{outgoing.resultHandle=await resultStore.commit(s.storeEntry,{request:s.request,terminal:outgoing});}
        catch(error){s.failure=error;outgoing=terminal(s,'error',{error:{code:'SAMPLING_RESULT_PERSIST_FAILED',message:String(error.message).slice(0,8192)},workerSettled:true,exit:{code,signal},...extra,lastFrame:s.lastFrame});}
      }
      if(s.job&&(outgoing.kind==='error'||s.failure)){
        // A failure must survive the worker lifetime. Native actual inputs,
        // process command/settings, stdout/stderr and valid prefix remain at
        // this owned path; never run unconditional finally cleanup on it.
        try{await fs.writeFile(path.join(s.job,'run-diagnostics.json'),JSON.stringify({schema:1,request:s.request,exit:{code,signal},error:outgoing.error,workerFailure:s.failure?.message,workerStderr:s.stderr??'',lastFrame:s.lastFrame,resultHandle:outgoing.resultHandle})+'\n',{flag:'wx'});await fs.writeFile(path.join(s.job,'.retain-recovery.json'),JSON.stringify({schema:1,reason:'sampling-failure-evidence'})+'\n',{flag:'wx'});outgoing.diagnosticDirectory=s.job;}
        catch(error){console.warn('SAMPLING_DIAGNOSTIC_RETAINED',error.message);outgoing.diagnosticDirectory=s.job;}
      }
    }catch(error){s.failure=error;outgoing=terminal(s,'error',{error:{code:'SAMPLING_HOST_FINALIZE_FAILED',message:String(error.message).slice(0,8192)},workerSettled:true,exit:{code,signal},...(s.job?{diagnosticDirectory:s.job}:{}),lastFrame:s.lastFrame});}
    finally{try{if(s.job&&outgoing?.kind!=='error'&&(!s.storeEntry||outgoing.resultHandle))try{await cleanTaskDirectory(s.job,fs);}catch(error){console.warn('SAMPLING_TASK_CACHE_RETAINED',error.message);}await s.release?.();if(s.ownerClosed)detachResults(s.owner);}finally{sessions.delete(key(s.owner,s.id));if(outgoing)emit(s,outgoing);s.resolve();}}
  }
  async function start(owner,raw,id,beforeStart=()=>{}){
    assert(!disposed&&Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&typeof admit==='function','Sampling owner/shared resource admission unavailable');sessionIdentity(id);
    assert(![...sessions.values()].some(s=>s.owner===owner),'Owned sampling worker must close before another start');
    if(resolveResources)assert(raw.threads===undefined||Number.isSafeInteger(raw.threads)&&raw.threads>0,'Requested sampling threads must be a positive safe integer');
    let request=validateStart(resolveResources?{...raw,threads:1}:raw);const s={owner,id,request,workerSeq:-1,emitSeq:0,tail:'',bytes:0,stderrBytes:0,frames:0,candidates:0,events:0,history:[],nativePids:new Set(),expectedFrames:expectedFrames(request),abortController:new AbortController()};
    s.finished=new Promise(resolve=>{s.resolve=resolve;});sessions.set(key(owner,id),s);
    try{
      if(resolveResources){s.resourceSnapshot=Object.freeze(resourceFields(await ownedWait(s,Promise.resolve(resolveResources(owner,structuredClone(raw))))));request=validateStart({...request,threads:s.resourceSnapshot.threads,memoryBudgetBytes:s.resourceSnapshot.memoryBudgetBytes});s.request=request;}
      s.release=await ownedWait(s,admit(owner,request,{signal:s.abortController.signal,...(s.resourceSnapshot?{resources:s.resourceSnapshot}:{})}),true);
      if(s.resourceSnapshot){const actual=resourceFields(s.release.resources),configured=actual.configured??s.resourceSnapshot.configured??s.resourceSnapshot;assert(actual.threads<=configured.threads&&actual.memoryBudgetBytes<=configured.memoryBudgetBytes,'Actual grant exceeds the admitted resource ceiling');request=validateStart({...request,threads:actual.threads,memoryBudgetBytes:actual.memoryBudgetBytes});s.request=request;s.effectiveResources={...actual,memoryEnforced:false,configured,requested:{threads:raw.threads??s.resourceSnapshot.threads,memoryBudgetBytes:raw.memoryBudgetBytes??s.resourceSnapshot.memoryBudgetBytes},actual:{threads:actual.threads,memoryBudgetBytes:actual.memoryBudgetBytes}};}
      s.outputBudgetBytes=outputBudget(s.effectiveResources??s.resourceSnapshot,policy.maxOutputBytes);
      const runtime=await ownedWait(s,resolveRuntime({signal:s.abortController.signal}));assert(runtime&&path.isAbsolute(runtime.executable)&&Array.isArray(runtime.args)&&runtime.args.includes('--conformer-sampling')&&path.isAbsolute(runtime.cwd),'Trusted fixed conformer sampling runtime required');
      if(requiresXtbRuntime(request))await ownedWait(s,nativeSetup(s));
      if(resultStore)s.storeEntry=await resultStore.create(owner);
      beforeStart();if(s.stopReason||s.ownerClosed||disposed){stop(s);await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      const child=s.child=spawn(runtime.executable,runtime.args,{cwd:runtime.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:String(request.threads),OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads)}});
      const out=new StringDecoder('utf8');
      child.stdout.on('data',chunk=>{if(s.closed)return;try{
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);s.bytes+=bytes.length;if(limits.maxOutputBytes!==undefined)assert(s.bytes<=s.outputBudgetBytes,'Sampling cumulative output exceeded budget');s.tail+=out.write(bytes);let end;
        while((end=s.tail.indexOf('\n'))>=0){const line=s.tail.slice(0,end);s.tail=s.tail.slice(end+1);assert(Buffer.byteLength(line)<=policy.maxPacketBytes,'Sampling packet exceeded budget');
          const value=validateEvent(JSON.parse(line),s);assert(!s.result&&++s.events<=Math.max(policy.maxEvents,2*request.maxEvaluations+request.maxFrames+(request.metadynamics?.maxHistory??0)+10*(request.annealing?.cycles??1)+100),'Late/duplicate or excessive sampling event');s.workerSeq=value.seq;
          // Charge retained scientific values once. Repeated task stamps,
          // protection definitions, progress and terminal copies are transport
          // metadata and cannot exhaust the user's scientific output budget.
          if(value.kind==='frame'||value.kind==='bias'){
            const scientific=value.kind==='bias'?value.historyEntry:{coordinates:value.coordinates,velocitiesAngstromPerFs:value.velocitiesAngstromPerFs,
              step:value.step,timeFs:value.timeFs,physicalEnergyEV:value.physicalEnergyEV,coreBiasEV:value.coreBiasEV,metaBiasEV:value.metaBiasEV,sphereBiasEV:value.sphereBiasEV,
              sampledPotentialEV:value.sampledPotentialEV,kineticEnergyEV:value.kineticEnergyEV,temperatureK:value.temperatureK};
            s.scientificBytes=(s.scientificBytes??0)+Buffer.byteLength(JSON.stringify(scientific));
            assert(s.scientificBytes<=s.outputBudgetBytes,'Sampling retained scientific output exceeded configured budget');
          }
          if(value.kind==='frame'&&requiresXtbRuntime(request)&&request.driver!=='native-xtb-md')assert(s.nativePids.size===0,'Native sampling frame arrived during an unsettled evaluation');
          if(value.kind==='native-started'){assert(!s.nativePids.has(value.pid)&&s.nativePids.size===0,'Duplicate/concurrent native GFN-FF child');s.nativePids.add(value.pid);continue;}
          if(value.kind==='native-closed'){assert(s.nativePids.delete(value.pid),'Unknown native GFN-FF child close');continue;}
          if(value.kind==='bias'){assert(value.historyEntry.index===s.history.length,'RMSD history event gap');s.history.push(structuredClone(value.historyEntry));}
          if(value.kind==='progress'){assert(value.step>=(s.nativeProgressStep??0),'Native MD observed progress moved backwards');s.nativeProgressStep=value.step;}
          if(TERMINAL.has(value.kind)){
            if(requiresXtbRuntime(request))assert(value.nativeClosed===true&&s.nativePids.size===0,'Native sampling terminal arrived before actual native child close');
            if(value.kind==='completed'){assert(value.frameCount===s.frames&&value.candidateCount===s.candidates&&s.frames===s.expectedFrames.length&&value.step===s.expectedFrames.at(-1)?.step,'Sampling frame/candidate completion counts or end step differ');assert(same(value.biasHistory,s.history),'Terminal RMSD history differs from deposited history');if(request.operation==='metadynamics')assert(s.history.length===expectedBiasHistoryCount(request),'Metadynamics did not execute its complete bias schedule');}s.result=value;
          }else if(value.kind==='frame'){if(request.method==='gfnff'&&request.driver!=='native-xtb-md'){assert(s.nativePids.size===0,'GFN-FF frame arrived during an unsettled native evaluation');const hash=value.calculatorEvidence.forceFieldTopologySha256;if(s.gfnffTopologySha256)assert(hash===s.gfnffTopologySha256,'Initial native GFN-FF topology identity changed');else s.gfnffTopologySha256=hash;}const expected=s.expectedFrames[s.frames];assert(expected&&Object.keys(expected).every(k=>value[k]===expected[k])&&value.biasHistoryCount===s.history.length,'Sampling frame schedule/temperature/bias differs from request');assert(value.frameIndex===s.frames&&++s.frames<=request.maxFrames,'Sampling frame count/sequence exceeded');if(value.role==='sampled-candidate')s.candidates++;if(!s.stopReason||s.stopReason==='cancelled'){s.lastFrame=value;if(s.storeEntry){child.stdout.pause?.();const{kind,...payload}=value;const writing=s.pendingWrite=resultStore.append(s.storeEntry,{...payload,event:kind});writing.then(()=>{if(!s.closed&&s.pendingWrite===writing)child.stdout.resume?.();},error=>{s.failure=error;stop(s,'Sampling result persistence failed');});}else emit(s,value);}}
          else if(!s.stopReason&&!(s.storeEntry&&value.kind==='bias'))emit(s,value);
        }assert(Buffer.byteLength(s.tail)<=policy.maxPacketBytes,'Unfinished sampling packet exceeded budget');
      }catch(error){s.failure=error;stop(s,'Invalid conformer sampling worker output');}});
      child.stderr.on('data',chunk=>{s.bytes+=Buffer.byteLength(chunk);s.stderrBytes+=Buffer.byteLength(chunk);s.stderr=((s.stderr??'')+chunk.toString('utf8')).slice(-1024*1024);if(limits.maxOutputBytes!==undefined&&s.bytes>s.outputBudgetBytes)stop(s,'Sampling stderr/output exceeded budget');});
      child.stdin.on('error',error=>{s.failure=error;stop(s,'Sampling worker input failed');});child.once('error',error=>{s.failure=error;stop(s,'Sampling worker spawn failed');});
      child.once('close',(code,signal)=>{s.tail+=out.end();void finish(s,code,signal??null);});
      child.stdin.write(JSON.stringify({schema:1,sessionId:id,request,...(s.xtbRuntime?{runtime:s.xtbRuntime,workspacePath:s.job}:{})})+'\n');
      if(request.maxWallTimeSeconds!==undefined){s.wallTimer=setTimeout(()=>stop(s,'Sampling walltime budget exceeded'),request.maxWallTimeSeconds*1000);s.wallTimer.unref?.();}
      emit(s,terminal(s,'started',{status:'running'}));return{sessionId:id,status:'starting'};
    }catch(error){s.failure=error;if(!s.child)await finish(s,null,null);else stop(s,'Sampling start failed');return{sessionId:id,status:'error'};}
  }
  function command(owner,id,value){assert(value&&Object.keys(value).length===1&&value.command==='stop','Only sampling stop is supported');const s=sessions.get(key(owner,sessionIdentity(id)));assert(s&&!s.closed,'Sampling session is not owned/active');stop(s);return s.finished.then(()=>({sessionId:id,status:'stopped'}));}
  function closeOwner(owner){closedOwners.add(owner);for(const s of sessions.values())if(s.owner===owner){s.ownerClosed=true;stop(s);}detachResults(owner);}
  function dispose(){disposed=true;for(const s of sessions.values()){s.ownerClosed=true;stop(s);}detachResults();}
  async function settle(owner){await Promise.all([...sessions.values()].filter(s=>owner===undefined||s.owner===owner).map(s=>s.finished));await Promise.all([...resultCloseTasks]);}
  async function waitForOwnedChildren(owner,timeoutMs=5000){assert(Number.isFinite(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000,'Invalid sampling close-wait budget');let timer;try{await Promise.race([settle(owner),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual sampling worker close not confirmed')),timeoutMs);})]);}finally{clearTimeout(timer);}}
  return{start,command,closeOwner,dispose,settle,waitForOwnedChildren,readResult:(owner,id,offset,limit)=>{assert(resultStore,'Sampling result storage unavailable');return resultStore.read(owner,id,offset,limit);},releaseResult:(owner,id)=>{assert(resultStore,'Sampling result storage unavailable');return resultStore.release(owner,id);},activeCount:()=>sessions.size,workerCount:()=>[...sessions.values()].filter(s=>s.child&&!s.closed).length};
}
module.exports={createConformerSamplingHost};
