'use strict';
const path=require('node:path');
const {isDeepStrictEqual:same}=require('node:util');
const {StringDecoder}=require('node:string_decoder');
const {assert}=require('./security.cjs');
const {TERMINAL,sessionIdentity,validateStart,validateEvent}=require('./advanced-path-security.cjs');
const {DEFAULT_OUTPUT_BUDGET_BYTES,outputBudget}=require('./output-budget.cjs');

/** The injected admit hook must join Main's shared resource accounting.
 * No independent process pool or claim of a connected shared lease is made. */
function createAdvancedPathHost({spawn,resolveRuntime,resolveXtbRuntime,jobRoot,fs=require('node:fs/promises'),sendToWindow,admit,resolveResources,limits={}}){
  const sessions=new Map(),closedOwners=new Set();let disposed=false;
  const policy={stopMs:2000,maxOutputBytes:DEFAULT_OUTPUT_BUDGET_BYTES,maxPacketBytes:Infinity,maxFrames:Infinity,maxEvents:Infinity,...limits};
  const key=(owner,id)=>`${owner}:${id}`;
  function emit(s,value){if(s.ownerClosed)return;try{const {kind,seq,...rest}=value;sendToWindow(s.owner,{...rest,...(s.effectiveResources?{effectiveResources:s.effectiveResources}:{}),event:kind,seq:s.emitSeq++});}catch{closeOwner(s.owner);}}
  function stop(s,reason='cancelled'){
    if(s.closed||s.stopReason)return;s.stopReason=reason;
    // A queued lease/runtime lookup can be abandoned without a child. Once a
    // child exists, only its real close may release the granted resource.
    if(!s.child)s.abort.abort();
    if(s.child){try{s.child.stdin.write(JSON.stringify({schema:1,sessionId:s.id,runIdentity:s.request.runIdentity,command:'stop'})+'\n');}catch{}
      s.killTimer=setTimeout(()=>{if(!s.closed)try{s.child.kill();}catch{}},policy.stopMs);s.killTimer.unref?.();}
  }
  function cancelled(){return Object.assign(Error('Advanced path start cancelled'),{code:'PATH_CANCELLED'});}
  function pending(s,task){
    if(s.abort.signal.aborted){Promise.resolve(task).catch(()=>{});return Promise.reject(cancelled());}
    return new Promise((resolve,reject)=>{
      const abort=()=>{s.abort.signal.removeEventListener('abort',abort);reject(cancelled());};
      s.abort.signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(task).then(value=>{s.abort.signal.removeEventListener('abort',abort);resolve(value);},error=>{s.abort.signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  function admission(s,owner,request){
    return Promise.resolve(admit(owner,request,{signal:s.abort.signal,resources:s.configuredResources})).then(async release=>{
      assert(typeof release==='function','Shared resource admission must return its release function');
      let released=false;s.release=async()=>{if(released)return;released=true;await release();};
      if(s.configuredResources){assert(release.resources&&Number.isSafeInteger(release.resources.memoryBudgetBytes)&&release.resources.memoryBudgetBytes>0,'PATH_RESOURCE_GRANT: Shared actual resource grant unavailable');s.effectiveResources=structuredClone(release.resources);Object.assign(s.request,validateStart({...s.request,threads:release.resources.threads}));}
      // An uncancellable provider may resolve after cancellation/finish. Its
      // late resource still has exactly one owner and is released once.
      if(s.closed||s.abort.signal.aborted){await s.release();throw cancelled();}
      return s.release;
    });
  }
  function terminal(s,kind,data){return{schema:1,sessionId:s.id,runIdentity:s.request.runIdentity,stamp:s.request.stamp,operation:s.request.operation,method:s.request.method,kind,...data};}
  async function finish(s,code,signal){
    if(s.closed)return;s.closed=true;clearTimeout(s.wallTimer);clearTimeout(s.killTimer);
    try{
      if(s.stopReason){emit(s,terminal(s,s.stopReason==='cancelled'?'stopped':'error',s.stopReason==='cancelled'?{reason:'cancelled',lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal}}:{error:{code:'PATH_HOST_STOPPED',message:s.stopReason},lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal}}));}
      else if(s.failure||s.tail.trim()||!s.result||code!==0&&s.result.kind!=='error'||signal!==null){emit(s,terminal(s,'error',{error:{code:'PATH_WORKER_REJECTED',message:String(s.failure?.message??'Worker closed without a complete valid terminal result').slice(0,8192)},lastFrame:s.lastFrame,workerSettled:true,exit:{code,signal}}));}
      else emit(s,{...s.result,exit:{code,signal}});
    }finally{try{await s.release?.();sessions.delete(key(s.owner,s.id));s.resolve();}catch(error){s.reject(error);}}
  }
  async function start(owner,raw,id,beforeStart=()=>{}){
    assert(!disposed&&Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&typeof admit==='function','Advanced path owner/resource admission unavailable');sessionIdentity(id);
    assert(![...sessions.values()].some(s=>s.owner===owner),'Owned advanced path worker must close before another start');
    if(resolveResources)assert(raw?.threads===undefined||Number.isSafeInteger(raw.threads)&&raw.threads>0,'Invalid requested path threads');
    const request=validateStart(resolveResources?{...raw,threads:1}:raw),s={owner,id,request,abort:new AbortController(),workerSeq:-1,emitSeq:0,tail:'',bytes:0,stderrBytes:0,frames:0,events:0};s.finished=new Promise((resolve,reject)=>{s.resolve=resolve;s.reject=reject;});void s.finished.catch(()=>{});sessions.set(key(owner,id),s);
    try{
      if(resolveResources){s.configuredResources=await pending(s,resolveResources(owner,{...structuredClone(request),threads:raw.threads,memoryBudgetBytes:raw.memoryBudgetBytes}));beforeStart();Object.assign(request,validateStart({...request,threads:s.configuredResources.threads}));}
      await pending(s,admission(s,owner,request));
      s.outputBudgetBytes=outputBudget(s.effectiveResources??s.configuredResources,policy.maxOutputBytes);
      s.started=performance.now();if(request.maxWallTimeSeconds!==undefined){s.wallTimer=setTimeout(()=>stop(s,'Advanced path wall-time budget exceeded'),request.maxWallTimeSeconds*1000);s.wallTimer.unref?.();}
      const runtime=await pending(s,resolveRuntime());assert(runtime&&path.isAbsolute(runtime.executable)&&Array.isArray(runtime.args)&&runtime.args.includes('--advanced-path')&&path.isAbsolute(runtime.cwd),'Trusted fixed advanced path runtime required');
      beforeStart();if(s.stopReason||s.ownerClosed||disposed){stop(s);await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      let initialPath;
      if(request.neb?.initialPath==='xtb-bpp'){
        assert(typeof resolveXtbRuntime==='function'&&typeof jobRoot==='string','Trusted BPP runtime/jobRoot unavailable');
        const xtb=await pending(s,resolveXtbRuntime());
        const check=()=>assert(!s.stopReason&&!s.ownerClosed&&!disposed,'BPP start cancelled or timed out');check();
        emit(s,terminal(s,'started',{status:'running'}));s.startedEmitted=true;
        initialPath=await require('./advanced-path-bpp.cjs').generateBpp({request,runtime:xtb,jobRoot,fs,spawn,check,
          onChild(child){check();s.child=child;},onClosed(child){assert(s.child===child,'BPP child ownership changed');s.child=null;clearTimeout(s.killTimer);}});
        check();
      }
      const child=s.child=spawn(runtime.executable,runtime.args,{cwd:runtime.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:String(request.threads),OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads)}});
      const out=new StringDecoder('utf8');
      child.stdout.on('data',chunk=>{if(s.closed)return;try{
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);s.bytes+=bytes.length;if(limits.maxOutputBytes!==undefined)assert(s.bytes<=s.outputBudgetBytes,'Advanced path cumulative output exceeded budget');s.tail+=out.write(bytes);let end;
        while((end=s.tail.indexOf('\n'))>=0){const line=s.tail.slice(0,end);s.tail=s.tail.slice(end+1);assert(Buffer.byteLength(line)<=policy.maxPacketBytes,'Advanced path packet exceeded budget');const value=validateEvent(JSON.parse(line),s);assert(!s.result&&++s.events<=policy.maxEvents,'Late/duplicate or excessive path event');s.workerSeq=value.seq;
          if(TERMINAL.has(value.kind)){if(!s.stopReason&&value.lastFrame)assert(s.lastFrame&&value.lastFrame.frameIndex===s.frames-1&&value.lastFrame.stageId===s.lastFrame.stageId&&same(value.lastFrame.coordinates,s.lastFrame.coordinates)&&value.lastFrame.energyEV===s.lastFrame.energyEV,'Terminal path frame differs from the accepted stream');s.result=value;}
          else if(value.kind==='frame'){assert(value.frameIndex===s.frames&&++s.frames<=policy.maxFrames,'Advanced path frame order/budget exceeded');s.scientificBytes=(s.scientificBytes??0)+Buffer.byteLength(JSON.stringify({coordinates:value.coordinates,energyEV:value.energyEV,iteration:value.iteration,stageId:value.stageId,pointIndex:value.pointIndex,imageIndex:value.imageIndex}));assert(s.scientificBytes<=s.outputBudgetBytes,'Advanced path scientific output exceeded configured budget');if(!s.stopReason||s.stopReason==='cancelled'){s.lastFrame=structuredClone(value);emit(s,value);}}
          else if(!s.stopReason)emit(s,value);
        }assert(Buffer.byteLength(s.tail)<=policy.maxPacketBytes,'Unfinished path packet exceeded budget');
      }catch(error){s.failure=error;stop(s,'Invalid advanced path worker output');}});
      child.stderr.on('data',chunk=>{s.bytes+=Buffer.byteLength(chunk);s.stderrBytes+=Buffer.byteLength(chunk);if(limits.maxOutputBytes!==undefined&&s.bytes>s.outputBudgetBytes)stop(s,'Advanced path stderr/output exceeded budget');});
      child.stdin.on('error',error=>{s.failure=error;stop(s,'Advanced path worker input failed');});child.once('error',error=>{s.failure=error;stop(s,'Advanced path worker spawn failed');});
      child.once('close',(code,signal)=>{s.tail+=out.end();void finish(s,code,signal??null);});
      // The existing path worker has no memory-budget field. Keep this host
      // soft-budget in the trusted grant, without changing its solver wire.
      const nativeRequest={...request};delete nativeRequest.memoryBudgetBytes;
      child.stdin.write(JSON.stringify({schema:1,sessionId:id,request:nativeRequest,...(initialPath?{initialPath,elapsedBeforeSeconds:(performance.now()-s.started)/1000}:{})})+'\n');
      if(!s.startedEmitted)emit(s,terminal(s,'started',{status:'running'}));return{sessionId:id,status:'starting'};
    }catch(error){s.failure=error;if(!s.child)await finish(s,null,null);else stop(s,'Advanced path start failed');return{sessionId:id,status:s.stopReason==='cancelled'?'stopped':'error'};}
  }
  function command(owner,id,value){assert(value&&Object.keys(value).length===1&&value.command==='stop','Only advanced path stop is supported');const s=sessions.get(key(owner,sessionIdentity(id)));assert(s&&!s.closed,'Path session is not owned or active');stop(s);return s.finished.then(()=>({sessionId:id,status:'stopped'}));}
  function closeOwner(owner){closedOwners.add(owner);for(const s of sessions.values())if(s.owner===owner){s.ownerClosed=true;stop(s);}}
  function dispose(){disposed=true;for(const s of sessions.values()){s.ownerClosed=true;stop(s);}}
  async function settle(owner){await Promise.all([...sessions.values()].filter(s=>owner===undefined||s.owner===owner).map(s=>s.finished));}
  async function waitForOwnedChildren(owner,timeoutMs=5000){assert(Number.isFinite(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000,'Invalid close-wait budget');let timer;try{await Promise.race([settle(owner),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual advanced path worker close not confirmed')),timeoutMs);})]);}finally{clearTimeout(timer);}}
  return{start,command,closeOwner,dispose,settle,waitForOwnedChildren,activeCount:()=>sessions.size,workerCount:()=>[...sessions.values()].filter(s=>s.child&&!s.closed).length};
}
module.exports={createAdvancedPathHost};
