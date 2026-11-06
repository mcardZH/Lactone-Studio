'use strict';
const { readManagedResult } = require('./analysis-result-wire.cjs');
const nativeFS=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {createWavefunctionAnalysisRunner,baderGridPlan,occupationPrintEvidence,createGeneratedAnalysisPolicy}=require('./wavefunction-analysis.cjs');
const {progressIdentity,createMultiwfnProgress}=require('./multiwfn-progress.cjs');
const {assert,plain,string}=require('./security.cjs');
const {MAX_CUBE_BYTES,rendererReserveBytes,cubeExportUpperBound,identity,nativeDiagnostics,resourceInfo,sourceRequest,planRequest,commandRequest,decodeField}=require('./orbital-security.cjs');
const SYMBOLS='X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
function wavefunctionFormat(text) {
  // Match the frontend's bounded, complete-line format evidence without trimming the source.
  const limit=1024*1024,bytes=Buffer.from(text,'utf8'),head=bytes.subarray(0,limit).toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const complete=bytes.length>limit?head.slice(0,head.lastIndexOf('\n')+1):head;
  const molden=/^[^\S\n]*\[Molden Format\][^\S\n]*$/im.test(complete);
  const fchk=/^Atomic numbers\s+I\s+N=\s*\d+/m.test(complete)&&/^Number of atoms\s+I\s+\d+/m.test(complete);
  assert(!(molden&&fchk),'SOURCE_FORMAT_CONFLICT: Wavefunction contains both Molden and FCHK format evidence');
  return molden?'molden':'fchk';
}
function metadata(raw,session) {
  assert(plain(raw) && raw.coordinateUnit==='bohr' && raw.energyUnit==='hartree' && ['fchk','molden'].includes(raw.format) && /^[a-f0-9]{64}$/.test(raw.sourceSha256), 'Invalid wavefunction metadata');
  assert(raw.sourceSha256===session.sourceRevision, 'Wavefunction source changed');
  assert(Number.isSafeInteger(raw.basisCount) && raw.basisCount>0 && raw.basisCount<=100000 && Array.isArray(raw.atoms) && raw.atoms.length>0 && raw.atoms.length<=100000, 'Invalid wavefunction atom/basis count');
  const atoms=raw.atoms.map((atom,i)=>{assert(plain(atom)&&Number.isInteger(atom.atomicNumber)&&atom.atomicNumber>0&&atom.atomicNumber<SYMBOLS.length&&Array.isArray(atom.positionBohr)&&atom.positionBohr.length===3&&atom.positionBohr.every(Number.isFinite),'Invalid wavefunction atom'); const p=atom.positionBohr.map(n=>n*0.529177210903);return {id:`a${i+1}`,sourceIndex:i+1,element:SYMBOLS[atom.atomicNumber],x:p[0],y:p[1],z:p[2]};});
  assert(Array.isArray(raw.orbitals)&&raw.orbitals.length>0&&raw.orbitals.length<=100000,'Invalid source orbital count');
  const keys=new Set();const orbitals=raw.orbitals.map(o=>{assert(plain(o)&&string(o.id,100)&&!keys.has(o.id)&&['restricted','alpha','beta'].includes(o.spin)&&['index','sourceIndex','displayIndex','sourceLine'].every(k=>Number.isSafeInteger(o[k])&&o[k]>0)&&Number.isFinite(o.energyHartree)&&Number.isFinite(o.occupation)&&o.occupation>=0&&o.occupation<=2&&string(o.sourceField,256),'Invalid source orbital');keys.add(o.id);return {key:o.id,spin:o.spin,ordinal:o.index,sourceIndex:o.sourceIndex,displayIndex:o.displayIndex,energy:o.energyHartree,energyUnit:'hartree',occupation:o.occupation,sourceLine:o.sourceLine,sourceField:o.sourceField};});
  return {sourceId:session.sourceId,sourceRevision:session.sourceRevision,name:session.name,format:raw.format,structure:{id:session.sourceId,name:session.name,format:raw.format,atoms,charge:Number.isSafeInteger(raw.charge)?raw.charge:null,multiplicity:Number.isSafeInteger(raw.multiplicity)&&raw.multiplicity>0?raw.multiplicity:null,notes:['Wavefunction source geometry; no bond inference.'],dimension:3},basisCount:raw.basisCount,orbitals,messages:[raw.basisConvention].filter(v=>typeof v==='string')};
}
/** One shared scientific worker; each opening metadata inspection owns its child. */
function createOrbitalHost({spawn,spawnInspect=spawn,resolveRuntime,resolveBackend,resolveResources,snapshotSource,jobRoot,sendToWindow,sendProgress=()=>{},onAnalysisEvidence,analysisResourceOverrides,fs=nativeFS,limits={},scheduler,timers={setTimeout,clearTimeout}}) {
  assert(analysisResourceOverrides===undefined||(plain(analysisResourceOverrides)&&Object.keys(analysisResourceOverrides).length===2&&Object.keys(analysisResourceOverrides).every(k=>['threads','memoryBudgetBytes'].includes(k))&&Number.isSafeInteger(analysisResourceOverrides.threads)&&analysisResourceOverrides.threads>0&&analysisResourceOverrides.threads<=2147483647&&Number.isSafeInteger(analysisResourceOverrides.memoryBudgetBytes)&&analysisResourceOverrides.memoryBudgetBytes>0),'Invalid trusted numerical-analysis resource overrides');
  const analysisOverrides=analysisResourceOverrides===undefined?undefined:Object.freeze({...analysisResourceOverrides});
  const policy={requestMs:0,fieldMs:0,stopMs:6000,idleMs:30000,...limits};
  assert(Number.isInteger(policy.idleMs)&&policy.idleMs>0&&policy.idleMs<=30000,'Invalid orbital idle bound');
  const sessions=new Map(),pending=new Map(),closedOwners=new Set(),closedSessions=new Map(),cleanupAfterClose=new Set(),cleanupTasks=new Set(),operationTasks=new Set(),inspectWorkers=new Set();let worker=null,disposed=false,requestSequence=0,starting=0,planningTail=Promise.resolve(),inspectTail=Promise.resolve(),idleTimer;
  const analyses=createWavefunctionAnalysisRunner({spawn,resolveRuntime,resolveBackend,resolveResources:analysisResources,captureResources:resolveResources?s=>resolveResources(s.owner,{domain:'analysis'}):undefined,limits:limits.analysis,scheduler,sendProgress,onAnalysisEvidence});
  function cancelIdle(){if(idleTimer!==undefined){timers.clearTimeout(idleTimer);idleTimer=undefined;}}
  function canIdle(w){return !disposed&&worker===w&&!w.closed&&!w.terminating&&!sessions.size&&!pending.size&&!starting&&!analyses.activeCount()&&!operationTasks.size&&!cleanupTasks.size&&!cleanupAfterClose.size;}
  function scheduleIdle(){const w=worker;if(!w||!canIdle(w)||idleTimer!==undefined)return;idleTimer=timers.setTimeout(()=>{idleTimer=undefined;if(!canIdle(w))return;w.terminating=true;w.idleClosing=true;try{w.child.stdin.end();}catch{/* Actual close remains required. */}w.killTimer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.killTimer.unref?.();},policy.idleMs);idleTimer.unref?.();}
  function reservedMemoryBytes(context={}) { return [...sessions.values()].filter(s=>!s.closed&&s.nativeOpen&&!(context.domain==='orbital'&&context.sessionId===s.sessionId)).reduce((sum,s)=>sum+(s.plan?.fieldBytes??0)*s.completed.size,0)+(context.domain==='analysis'?0:analyses.reservedMemoryBytes()); }
  function captureResources(s,controller){return require('./compute-resources.cjs').captureComputeResources(resolveResources?owner=>resolveResources(owner,{domain:'orbital'}):undefined,s.owner,controller.signal);}
  async function allocation(owner,key,operation,sessionId) {const s=owned(owner,sessionId),controller=new AbortController();s.allocationControllers??=new Set();s.allocationControllers.add(controller);let lease;try{if(scheduler)lease=await scheduler.acquire({owner,key,signal:controller.signal});const resources=await captureResources(s,controller);owned(owner,sessionId,s);assert(!controller.signal.aborted,'ORBITAL_CANCELLED: 资源读取已取消');return await operation(lease,resources);}finally{lease?.release();s.allocationControllers.delete(controller);} }
  function nativeIdle(s,generation) { s.nativeIdleGeneration=Math.max(s.nativeIdleGeneration??-1,generation);for(const waiter of [...(s.nativeIdleWaiters??[])])if(waiter.generation<=s.nativeIdleGeneration){s.nativeIdleWaiters.delete(waiter);waiter.resolve();} }
  function waitNativeIdle(s,generation) { if((s.nativeIdleGeneration??-1)>=generation)return Promise.resolve();return new Promise(resolve=>{s.nativeIdleWaiters??=new Set();s.nativeIdleWaiters.add({generation,resolve});}); }
  function rendererTotal(candidate,candidatePerView){
    let sum=0;
    for(const root of sessions.values())if(!root.closed&&!root.parent){
      let largest=root===candidate?candidatePerView:root.plan?.rendererBytesPerView??0;
      for(const child of root.children??[])if(!child.closed)largest=Math.max(largest,child===candidate?candidatePerView:child.plan?.rendererBytesPerView??0);
      sum+=largest*root.viewCount;
    }
    return sum;
  }
  function refreshRendererBudgets(){for(const s of sessions.values()){if(s.parent){if(s.plan)s.plan.rendererBytes=0;}else{let size=s.plan?.rendererBytesPerView??0;for(const child of s.children??[])if(!child.closed)size=Math.max(size,child.plan?.rendererBytesPerView??0);s.canvasReserve=size*s.viewCount;if(s.plan)s.plan.rendererBytes=s.canvasReserve;}}}
  async function configuredResources(backend,overrides={},captured){if(worker?.idleClosing)await worker.finished;const effective=captured??overrides,value=await request('resources',null,{...(backend.configured?{executable:backend.path}:{}),...(effective.threads===undefined?{}:{threads:effective.threads}),...(effective.memoryBudgetBytes===undefined?{}:{memoryBudgetBytes:effective.memoryBudgetBytes})});return {...resourceInfo(value.resources),configured:backend.configured,...(captured?{computeResourceVersion:captured.version,computeResourceSource:captured.source}:{} )};}
  async function resources(owner,overrides,resourceSnapshot){
    assert(Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&!disposed,'Resource owner closed');
    assert(overrides===undefined||(plain(overrides)&&Object.keys(overrides).length===2&&Object.keys(overrides).every(k=>['threads','memoryBudgetBytes'].includes(k))&&Number.isSafeInteger(overrides.threads)&&overrides.threads>0&&overrides.threads<=2147483647&&Number.isSafeInteger(overrides.memoryBudgetBytes)&&overrides.memoryBudgetBytes>0),'Invalid explicit Multiwfn resource overrides');
    const snapshot=overrides===undefined?undefined:{...overrides};
    const captured=resourceSnapshot??(resolveResources?await resolveResources(owner,snapshot??{}):undefined),resolved=await configuredResources(await resolveBackend(),snapshot,captured);
    if(snapshot)assert(snapshot.threads<=resolved.logicalCpuCount&&snapshot.memoryBudgetBytes<=resolved.totalPhysicalMemoryBytes,'Explicit Multiwfn resource overrides exceed available logical CPUs or physical RAM');
    return resolved;
  }
  async function analysisResources(s,backend,analysis,captured){
    owned(s.owner,s.sessionId,s);const config=await configuredResources(backend,analysisOverrides,captured);owned(s.owner,s.sessionId,s);
    const reserved=reservedMemoryBytes({domain:'analysis'});
    const bader=analysis?.kind==='charges'&&analysis.method==='bader'?baderGridPlan(s,analysis,config.threads):null;
    const nativeMemoryBudgetBytes=config.memoryBudgetBytes-reserved,estimatedMemoryBytes=bader?.estimatedMemoryBytes??64*1024**2+s.metadata.basisCount**2*64+s.sourceBytes*5;
    assert(nativeMemoryBudgetBytes>0,'ANALYSIS_MEMORY_BUDGET: 已实际保留的轨道缓存达到本次内存预算');
    return {...config,nativeMemoryBudgetBytes,estimatedMemoryBytes,...(bader?{baderGridPlan:bader}:{})};
  }
  function track(task){cancelIdle();operationTasks.add(task);const finished=()=>{operationTasks.delete(task);scheduleIdle();};task.then(finished,finished);return task;}
  function sessionTask(fn,args,id){const task=fn(...args),s=sessions.get(id);if(s){s.inflight??=new Set();s.inflight.add(task);task.then(()=>s.inflight.delete(task),()=>s.inflight.delete(task));}return track(task);}
  function owned(owner,sessionId,expected) { identity(sessionId); const s=sessions.get(sessionId);assert(s&&s.owner===owner&&!s.closed&&(!expected||s===expected),'Orbital session not owned or closed');return s; }
  function send(s,event) {if(s.closed||closedOwners.has(s.owner))return;try{sendToWindow(s.owner,event);}catch{closeOwner(s.owner);}}
  function completedSnapshot(s,value) {
    assert(Array.isArray(value.completedIds)&&new Set(value.completedIds).size===value.completedIds.length&&value.completedIds.every(key=>s.keys.has(key)), 'Invalid orbital completed keys');
    assert(value.total===s.keys.size&&(value.completed===undefined||value.completed===value.completedIds.length), 'Invalid orbital completed count');
    // A later cache commit can precede an older queued status reply. Cache is
    // append-only until explicit replan/close, so a snapshot may only add keys.
    for(const key of value.completedIds)s.completed.add(key);
    updateSelectedReserve(s);
  }
  function updateSelectedReserve(s){if(s.plan?.mode!=='selected')return;const target=s.requestedKeys?.[0],count=Math.max(1,s.completed.size+(target&&!s.completed.has(target)?1:0));s.plan.nativeBytes=s.plan.nativeWorkingBytes+s.plan.fieldBytes*count;}
  function progress(s,event) {return {event:event.event,seq:event.seq,sessionId:s.sessionId,sourceRevision:s.sourceRevision,gridKey:s.plan?.gridKey??'',status:s.state,completedKeys:[...s.completed],total:s.metadata?.orbitals.length??0,currentKey:event.orbital?.id??s.requestedKeys?.[0]??null,cacheBytes:(s.plan?.fieldBytes??0)*s.completed.size,mode:s.plan?.mode??'all',...(s.runResources?{resources:s.runResources}:{}),requestedKeys:s.requestedKeys??[],...(event.error?{message:event.error.message,error:event.error}:{} )};}
  function failAll(error,w=worker) {if(!w||worker!==w)return;for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();for(const s of sessions.values()){s.state='failed';send(s,progress(s,{event:'error',seq:++s.seq,error:{code:'ORBITAL_WORKER_FAILED',message:error.message}}));}if(!w.terminating){w.terminating=true;try{w.child.stdin.end();}catch{}w.killTimer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.killTimer.unref?.();}}
  function ensureWorker() {
    cancelIdle();assert(!disposed,'Orbital host disposed');if(worker){assert(!worker.terminating,'Orbital worker is closing');return worker;}
    const runtime=resolveRuntime();const child=spawn(runtime.executable,runtime.args,{cwd:runtime.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
    const w=worker={child,parts:[],bytes:0,stderr:'',closed:false,terminating:false};
    w.finished=new Promise(resolve=>{w.finish=resolve;});
    child.once('close',()=>{if(worker===w)cancelIdle();});
    function message(value) {
      assert(plain(value),'Invalid orbital worker packet');
      if(value.id!==undefined&&value.id!==null){const p=pending.get(value.id);assert(p,'Unknown orbital reply');if(p.session){assert(value.sessionId===p.session.sessionId&&value.sourceRevision===p.session.sourceRevision&&value.gridKey===(p.gridKey??p.session.plan?.gridKey??'')&&value.generation===p.generation,'Orbital reply identity changed');}assert(typeof value.ok==='boolean','Invalid orbital reply status');if(!value.ok)assert(plain(value.error)&&string(value.error.code,128)&&string(value.error.message,8192),'Invalid orbital error');pending.delete(value.id);clearTimeout(p.timer);if(!value.ok)p.reject(new Error(`${value.error.code}: ${value.error.message}`));else p.resolve(value);return;}
      assert(['progress','state','error','native-idle','task-progress'].includes(value.event)&&string(value.sessionId,128),'Invalid orbital worker event');const s=sessions.get(value.sessionId);if(!s)return;
      if(value.event==='task-progress'){if(!s.closed&&value.sourceRevision===s.sourceRevision&&value.gridKey===s.plan?.gridKey&&value.generation===s.generation&&Number.isSafeInteger(value.seq)&&value.seq>s.seq){s.seq=value.seq;if(plain(value.progress))s.taskProgress?.report(value.progress.phase,value.progress);}return;}
      if(value.event==='native-idle'){assert(value.sourceRevision===s.sourceRevision&&value.gridKey===s.plan?.gridKey&&Number.isSafeInteger(value.generation)&&value.generation<=s.generation&&value.nativeSettled===true,'Invalid orbital native settle identity');nativeIdle(s,value.generation);return;}if(s.closed)return;
      assert(value.sourceRevision===s.sourceRevision&&value.gridKey===s.plan?.gridKey&&Number.isSafeInteger(value.seq)&&value.seq>s.seq,'Orbital event identity/sequence changed');s.seq=value.seq;
      assert(Number.isSafeInteger(value.generation)&&value.generation>=0&&value.generation<=s.generation,'Invalid orbital event generation');
      const currentGeneration=value.generation===s.generation;
      if(value.event==='progress'){assert(plain(value.orbital)&&s.keys.has(value.orbital.id)&&Number.isSafeInteger(value.completed)&&value.completed>=1&&Array.isArray(value.completedIds)&&value.completedIds.includes(value.orbital.id),'Invalid orbital completion');completedSnapshot(s,value);if(currentGeneration&&s.state!=='stopped'){s.state='running';const keys=s.plan?.mode==='selected'?s.requestedKeys:[...s.keys];if(keys?.length)s.taskProgress?.report('running',{stageId:'orbital-fields',measure:{kind:'items',completed:keys.filter(key=>s.completed.has(key)).length,total:keys.length,unit:'轨道'}});}}
      else if(value.event==='state'){assert(['idle','queued','running','stopped','complete','error'].includes(value.state),'Invalid orbital state');if(value.completedIds!==undefined)completedSnapshot(s,value);if(currentGeneration)s.state=value.state==='complete'?'completed':value.state==='error'?'failed':value.state;}
      else {assert(plain(value.error)&&string(value.error.code,128)&&string(value.error.message,8192),'Invalid orbital failure');if(value.error.diagnostics!==undefined)nativeDiagnostics(value.error.diagnostics);if(!currentGeneration)return;s.lastNativeError={generation:value.generation,message:value.error.message};s.state='failed';}
      send(s,progress(s,value));
    }
    child.stdout.on('data',chunk=>{if(w.terminating)return;try{let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);while(bytes.length){const index=bytes.indexOf(10),part=index<0?bytes:bytes.subarray(0,index);w.parts.push(part);w.bytes+=part.length;if(index<0)break;const line=Buffer.concat(w.parts,w.bytes).toString('utf8');w.parts=[];w.bytes=0;assert(line.length>0,'Empty orbital worker packet');message(JSON.parse(line));bytes=bytes.subarray(index+1);}}catch(error){failAll(error,w);}});
    child.stderr.on('data',chunk=>{w.stderr=(w.stderr+chunk.toString('utf8')).slice(-8192);});child.stdin.on('error',error=>failAll(error,w));child.on('error',error=>failAll(error,w));
    child.on('close',code=>{w.closed=true;w.finish();clearTimeout(w.killTimer);if(worker!==w)return;if(!w.terminating)failAll(new Error(`Orbital worker exited (${code}): ${w.stderr}`),w);worker=null;for(const s of sessions.values()){s.nativeOpen=false;s.state='failed';nativeIdle(s,s.generation);}for(const s of cleanupAfterClose){void clean(s);cleanupAfterClose.delete(s);} });
    return w;
  }
  function request(operation,s,extra={},gridKey) {const w=ensureWorker();const id=`orb-${++requestSequence}`,generation=s?.generation??0;return new Promise((resolve,reject)=>{const waitMs=['field','export-cube'].includes(operation)?policy.fieldMs:policy.requestMs;const timer=waitMs>0?setTimeout(()=>{pending.delete(id);reject(new Error('ORBITAL_TIMEOUT: 轨道引擎响应超时'));failAll(new Error('Orbital worker response timeout'),w);},waitMs):undefined;pending.set(id,{resolve,reject,timer,session:s,gridKey,generation});try{w.child.stdin.write(JSON.stringify({id,operation,...(s?{sessionId:s.sessionId,sourceRevision:s.sourceRevision,gridKey:gridKey??s.plan?.gridKey??'',generation}:{}),...extra})+'\n');}catch(error){pending.delete(id);clearTimeout(timer);reject(error);}}).then(value=>readManagedResult(value,s?.directory));}
  function cancelledOpen(){return new Error('ORBITAL_CANCELLED: 波函数读取已取消');}
  function rememberClosed(owner,id){let ids=closedSessions.get(owner);if(!ids)closedSessions.set(owner,ids=new Set());ids.add(id);}
  function stopInspect(w,error,force=false){
    if(!w||w.closed)return;
    if(error&&!w.error)w.error=error;
    if(!w.stopping){w.stopping=true;try{w.child.stdin.end();}catch(failure){w.error??=failure;}}
    if(force&&!w.killed){w.killed=true;w.child.kill();}
    if(!w.killTimer){w.killTimer=setTimeout(()=>{if(!w.closed&&!w.killed){w.killed=true;w.child.kill();}},policy.stopMs);w.killTimer.unref?.();}
  }
  async function acquireInspect(s){
    const signal=s.openController.signal;signal.throwIfAborted();
    const previous=inspectTail;let release;
    const ticket=new Promise(resolve=>{release=resolve;});inspectTail=previous.then(()=>ticket);
    let abort;
    try{
      await new Promise((resolve,reject)=>{abort=()=>reject(signal.reason||cancelledOpen());signal.addEventListener('abort',abort,{once:true});previous.then(resolve,reject);if(signal.aborted)abort();});
      signal.throwIfAborted();return release;
    }catch(error){release();throw error;}
    finally{signal.removeEventListener('abort',abort);}
  }
  async function inspectSource(s){
    const release=await acquireInspect(s);
    try{return await inspectSourceOwned(s);}finally{release();}
  }
  async function inspectSourceOwned(s){
    s.openController.signal.throwIfAborted();assert(!s.closed&&!disposed,'Orbital source owner closed');
    const runtime=resolveRuntime(),child=spawnInspect(runtime.executable,runtime.args,{cwd:runtime.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}}),
      id=`orb-inspect-${++requestSequence}`,generation=s.generation,w={child,parts:[],bytes:0,stderr:'',closed:false,stopping:false,killed:false};
    s.inspectOwner=w;inspectWorkers.add(w);w.finished=new Promise(resolve=>{w.finish=resolve;});
    child.stdout.on('data',chunk=>{if(w.stopping||w.closed)return;try{
      let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      while(bytes.length){const index=bytes.indexOf(10),part=index<0?bytes:bytes.subarray(0,index);w.parts.push(part);w.bytes+=part.length;if(index<0)break;
        const value=JSON.parse(Buffer.concat(w.parts,w.bytes).toString('utf8'));w.parts=[];w.bytes=0;
        assert(plain(value)&&value.id===id&&value.sessionId===s.sessionId&&value.sourceRevision===s.sourceRevision&&value.gridKey===''&&value.generation===generation,'Orbital inspect reply identity changed');
        assert(typeof value.ok==='boolean','Invalid orbital inspect reply status');
        if(!value.ok){assert(plain(value.error)&&string(value.error.code,128)&&string(value.error.message,8192),'Invalid orbital inspect error');throw new Error(`${value.error.code}: ${value.error.message}`);}
        w.value=value;stopInspect(w);break;
      }
    }catch(error){stopInspect(w,error,true);}});
    child.stderr.on('data',chunk=>{w.stderr=(w.stderr+chunk.toString('utf8')).slice(-8192);});
    child.stdin.on('error',error=>stopInspect(w,error,true));child.on('error',error=>stopInspect(w,error,true));
    child.once('close',code=>{w.closed=true;w.exitCode=code;clearTimeout(w.killTimer);clearTimeout(w.requestTimer);inspectWorkers.delete(w);w.finish();});
    const abort=()=>stopInspect(w,s.openController.signal.reason||cancelledOpen(),true);
    s.openController.signal.addEventListener('abort',abort,{once:true});
    if(policy.requestMs>0){w.requestTimer=setTimeout(()=>stopInspect(w,new Error('ORBITAL_TIMEOUT: 轨道引擎响应超时'),true),policy.requestMs);w.requestTimer.unref?.();}
    try{
      if(s.openController.signal.aborted)abort();
      else child.stdin.write(JSON.stringify({id,operation:'inspect',sessionId:s.sessionId,sourceRevision:s.sourceRevision,gridKey:'',generation,sourcePath:s.sourcePath})+'\n');
      await w.finished;
      s.openController.signal.throwIfAborted();if(w.error)throw w.error;
      assert(w.exitCode===0&&w.value,`Orbital inspect exited (${w.exitCode}): ${w.stderr}`);
      return await readManagedResult(w.value,s.directory);
    }catch(error){stopInspect(w,error,true);await w.finished;throw error;}
    finally{s.openController.signal.removeEventListener('abort',abort);if(s.inspectOwner===w)delete s.inspectOwner;}
  }
  function clean(s){if(s.cleanupTask)return s.cleanupTask;const task=s.cleanupTask=(async()=>{await s.creation?.catch(()=>{});await s.inspectOwner?.finished;await Promise.all([...(s.children??[])].map(clean));await analyses.cancel(s.sessionId);const root=s.sourceRoot??s;root.sourceUsers?.delete(s.sessionId);if(root===s&&(!root.sourceUsers||root.sourceUsers.size===0)&&s.sourcePath)await fs.unlink(s.sourcePath).catch(()=>{});if(s.directory)await fs.rmdir(s.directory).catch(()=>{});s.parent?.children.delete(s);refreshRendererBudgets();})();cleanupTasks.add(task);task.finally(()=>cleanupTasks.delete(task));return task;}
  function closeSession(s){
    if(s.closeTask)return s.closeTask;rememberClosed(s.owner,s.sessionId);s.closed=true;s.state='closed';s.openController?.abort(cancelledOpen());s.leaseCycle?.controller.abort();for(const controller of s.allocationControllers??[])controller.abort();
    const childClosures=[...(s.children??[])].map(closeSession);
    return s.closeTask=(async()=>{
      await s.creation?.catch(()=>{});await Promise.all(childClosures);
      try{
        await analyses.cancel(s.sessionId);
        if(s.nativeOpen&&!disposed){try{await request('close',s);nativeIdle(s,s.generation);}catch(error){const w=worker;if(w){failAll(error,w);await w.finished;}nativeIdle(s,s.generation);throw error;}}
        await Promise.allSettled([...(s.inflight??[])]);
      }finally{
        if(disposed&&worker){await worker.finished;nativeIdle(s,s.generation);}
        await s.leaseCycle?.task;
        if(sessions.get(s.sessionId)===s)sessions.delete(s.sessionId);await clean(s);
      }
      return {sessionId:s.sessionId,status:'closed'};
    })();
  }
  async function open(owner,raw) {
    if(worker?.idleClosing)await worker.finished;
    assert(Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&!disposed,'Orbital owner closed');const input=sourceRequest(raw);if(closedSessions.get(owner)?.has(input.sessionId))throw cancelledOpen();assert(!sessions.has(input.sessionId),'Duplicate orbital session');
    const s={owner,sessionId:input.sessionId,sourceId:input.sourceId,name:input.name,sourceRevision:null,sourceBytes:0,occupationPrintEvidence:[],state:'idle',seq:0,generation:0,viewCount:1,keys:new Set(),completed:new Set(),closed:false,nativeOpen:false,openController:new AbortController(),children:new Set(),sourceUsers:new Set([input.sessionId])};s.sourceRoot=s;sessions.set(s.sessionId,s);starting++;
    s.creation=(async()=>{
      await fs.mkdir(jobRoot,{recursive:true});s.openController.signal.throwIfAborted();s.directory=await fs.mkdtemp(path.join(jobRoot,'session-'));s.openController.signal.throwIfAborted();
      if(input.sourceToken!==undefined){
        assert(typeof snapshotSource==='function','Managed wavefunction source channel is unavailable');
        const snapshot=await snapshotSource(owner,input.sourceToken,{directory:s.directory,name:input.name,signal:s.openController.signal});
        assert(path.dirname(snapshot.path)===s.directory&&/^[a-f0-9]{64}$/.test(snapshot.revision)&&Number.isSafeInteger(snapshot.bytes)&&snapshot.bytes>0,'Invalid owned wavefunction snapshot');
        s.sourcePath=snapshot.path;s.sourceRevision=snapshot.revision;s.sourceBytes=snapshot.bytes;
      }else{
        const format=wavefunctionFormat(input.text);s.sourceRevision=createHash('sha256').update(input.text,'utf8').digest('hex');s.sourceBytes=Buffer.byteLength(input.text,'utf8');s.occupationPrintEvidence=format==='molden'?occupationPrintEvidence(input.text):[];
        s.sourcePath=path.join(s.directory,`source.${format}`);await fs.writeFile(s.sourcePath,input.text,{encoding:'utf8',flag:'wx'});
      }
    })();
    try{await s.creation;s.openController.signal.throwIfAborted();assert(!s.closed&&!disposed,'Orbital source owner closed');const value=await inspectSource(s);assert(!s.closed&&!disposed,'Orbital source owner closed');s.metadata=metadata(value.metadata,s);s.keys=new Set(s.metadata.orbitals.map(o=>o.key));return s.metadata;}catch(error){if(sessions.get(s.sessionId)===s)sessions.delete(s.sessionId);s.closed=true;await clean(s);throw error;}finally{starting--;scheduleIdle();}
  }
  // Internal capability only. The caller must first authenticate an owned,
  // completed generated artifact. No renderer request can invoke this binding.
  function bindTrustedSourceExpectation(owner,rootSessionId,expectation){
    const s=owned(owner,rootSessionId);assert(!s.parent&&s.sourceRoot===s&&s.metadata&&s.metadata.format==='molden','TRUSTED_SOURCE_BINDING: inspected Molden root session required');
    const fields=['kind','artifactId','sourceSha256','charge','uhf','atomElements'];
    assert(plain(expectation)&&Object.keys(expectation).length===fields.length&&Object.keys(expectation).every(k=>fields.includes(k))&&expectation.kind==='generated-gfn2-sp'&&string(expectation.artifactId,256)&&/^[a-f0-9]{64}$/.test(expectation.sourceSha256),'TRUSTED_SOURCE_BINDING: invalid generated expectation');
    assert(expectation.sourceSha256===s.sourceRevision,'TRUSTED_SOURCE_BINDING: artifact digest differs from immutable source');
    const atoms=s.metadata.structure.atoms;
    assert(Array.isArray(expectation.atomElements)&&expectation.atomElements.length===atoms.length&&expectation.atomElements.every((e,i)=>typeof e==='string'&&e===atoms[i].element),'TRUSTED_SOURCE_BINDING: source atom order differs from artifact');
    assert(Number.isSafeInteger(expectation.charge)&&Number.isSafeInteger(expectation.uhf)&&expectation.uhf>=0,'TRUSTED_SOURCE_BINDING: invalid charge/UHF');
    const physicalElectronCount=atoms.reduce((sum,a)=>{const z=SYMBOLS.indexOf(a.element);assert(z>0,'Invalid generated source element');return sum+z;},0)-expectation.charge;
    const representedElectronCount=s.metadata.orbitals.reduce((sum,o)=>sum+o.occupation,0);
    // A spin-summed occupation list has no independent alpha/beta populations.
    // Fractional thermal occupations do not reveal the requested spin count.
    assert(Number.isSafeInteger(physicalElectronCount)&&physicalElectronCount>0&&expectation.uhf<=physicalElectronCount&&(physicalElectronCount-expectation.uhf)%2===0&&Number.isFinite(representedElectronCount)&&representedElectronCount>0&&Math.abs(representedElectronCount-Math.round(representedElectronCount))<1e-6&&representedElectronCount<=physicalElectronCount+1e-6,'TRUSTED_SOURCE_BINDING: physical/represented electron count or requested UHF parity is invalid');
    assert((s.metadata.structure.charge===null||s.metadata.structure.charge===expectation.charge)&&(s.metadata.structure.multiplicity===null||s.metadata.structure.multiplicity===expectation.uhf+1),'TRUSTED_SOURCE_BINDING: explicit source charge/multiplicity conflicts with artifact');
    const bound=Object.freeze({kind:expectation.kind,artifactId:expectation.artifactId,sourceSha256:expectation.sourceSha256,charge:expectation.charge,requestedUhf:expectation.uhf,atomElements:Object.freeze([...expectation.atomElements]),representedElectronCount,physicalElectronCount,sourceSpinResolution:'spin-summed',independentAlphaBeta:false});
    const previous=s.trustedSourceExpectation;
    if(previous)assert(JSON.stringify(previous)===JSON.stringify(bound),'TRUSTED_SOURCE_BINDING: conflicting immutable source expectation');
    else{assert(!s.sourceExpectationUsed,'TRUSTED_SOURCE_BINDING: bind before the first numerical analysis');Object.defineProperty(s,'trustedSourceExpectation',{value:bound,writable:false,configurable:false});Object.defineProperty(s,'analysisPolicy',{value:createGeneratedAnalysisPolicy(s,bound),writable:false,configurable:false});s.metadata.analysisPolicy=s.analysisPolicy;}
    return {sessionId:s.sessionId,sourceRevision:s.sourceRevision,alreadyBound:Boolean(previous),expectation:{...bound,atomElements:[...bound.atomElements]},analysisPolicy:structuredClone(s.analysisPolicy),metadata:structuredClone(s.metadata)};
  }
  async function forkSession(owner,parentSessionId,instanceId){
    const parent=owned(owner,parentSessionId);identity(instanceId);assert(!parent.parent&&parent.metadata,'Analysis instances require an inspected parent source');
    const existing=[...parent.children].find(child=>!child.closed&&child.instanceId===instanceId);if(existing)return {sessionId:existing.sessionId,metadata:existing.metadata};
    const sessionId='analysis_'+randomUUID().replaceAll('-','');const s={owner,sessionId,instanceId,parent,sourceRoot:parent,sourceId:parent.sourceId,name:parent.name,sourceRevision:parent.sourceRevision,sourceBytes:parent.sourceBytes,sourcePath:parent.sourcePath,metadata:parent.metadata,state:'idle',seq:0,generation:0,viewCount:0,keys:new Set(parent.keys),completed:new Set(),closed:false,nativeOpen:false,children:new Set()};
    sessions.set(sessionId,s);parent.children.add(s);parent.sourceUsers.add(sessionId);starting++;
    s.creation=(async()=>{s.directory=await fs.mkdtemp(path.join(jobRoot,'instance-'));})();
    try{await s.creation;owned(owner,parentSessionId,parent);owned(owner,sessionId,s);return {sessionId,metadata:s.metadata};}catch(error){s.closed=true;sessions.delete(sessionId);await clean(s);throw error;}finally{starting--;}
  }
  async function plan(owner,sessionId,raw,lease,captured) {
    const s=owned(owner,sessionId),p=planRequest(raw);assert(!s.planning&&!['running','queued'].includes(s.state),'Orbital generation or planning is active');s.planning=true;
    const previous=planningTail;let releasePlan;planningTail=new Promise(resolve=>{releasePlan=resolve;});
    try{await previous;owned(owner,sessionId,s);const backend=await resolveBackend(),effective=await configuredResources(backend,p,captured);p.threads=effective.threads;p.memoryBudgetBytes=effective.memoryBudgetBytes;p.resources=effective;owned(owner,sessionId,s);const grid={originBohr:p.grid.origin,axesBohr:p.grid.axes,dimensions:p.grid.dimensions};const value=await request('plan',s,{sourcePath:s.sourcePath,...(backend.configured?{executable:backend.path}:{}),grid,memoryBudgetBytes:p.memoryBudgetBytes,mode:p.mode},s.plan?.gridKey??'');owned(owner,sessionId,s);const native=value.plan;assert(plain(native)&&['points','orbitalCount','fieldBytes','cacheBytes','workingBytes','estimatedPeakBytes'].every(k=>Number.isSafeInteger(native[k])&&native[k]>=0)&&native.points===grid.dimensions.reduce((a,b)=>a*b,1)&&native.orbitalCount===s.keys.size&&native.fieldBytes===native.points*8&&(native.mode??'all')===p.mode,'Invalid orbital resource plan');
      assert(typeof native.requiresMemoryConfirmation==='boolean','Invalid orbital budget result');
      const nativeTotalBytes=native.combinedEstimatedPeakBytes??native.estimatedPeakBytes;
      assert(Number.isSafeInteger(nativeTotalBytes)&&nativeTotalBytes>=native.estimatedPeakBytes,'Invalid combined orbital budget');
      const rendererBytesPerView=rendererReserveBytes(p.grid),rendererBytes=rendererBytesPerView*s.viewCount;
      const allRendererBytes=rendererTotal(s,rendererBytesPerView),numericBytes=analyses.reservedMemoryBytes();
      const sharedExtra=lease?lease.budget(p.memoryBudgetBytes,{domain:'orbital',sessionId}).reservedBytes-reservedMemoryBytes({domain:'orbital',sessionId}):0;
      const totalBytes=nativeTotalBytes+allRendererBytes+numericBytes+sharedExtra;
      const output={gridKey:p.gridKey,pointCount:native.points,orbitalCount:native.orbitalCount,cacheBytes:native.cacheBytes,workingBytes:native.workingBytes+rendererBytes,totalBytes,withinBudget:true,mode:p.mode,resources:effective};
      if(!output.withinBudget)return output;
      if(s.nativeOpen&&p.mode==='selected'&&s.plan?.mode==='selected'&&s.plan.gridKey===p.gridKey&&s.plan.threads===p.threads&&s.plan.memoryBudgetBytes===p.memoryBudgetBytes&&s.plan.resources?.settingsRevision===effective.settingsRevision){s.plan={...s.plan,...p,rendererBytes,rendererBytesPerView,nativeBytes:native.estimatedPeakBytes,nativeWorkingBytes:native.workingBytes};updateSelectedReserve(s);refreshRendererBudgets();return output;}
      if(s.nativeOpen){await request('close',s);s.nativeOpen=false;s.completed.clear();s.seq=0;}
      assert(backend.configured&&string(backend.path,4096),'ORBITAL_BACKEND_MISSING: 请先选择本机 Multiwfn');
      owned(owner,sessionId,s);
      // A native reopen starts generation numbering again. Settlement from the
      // closed grid/session cannot release the new run's scientific lease.
      s.plan={...p,fieldBytes:native.fieldBytes,rendererBytes,rendererBytesPerView,nativeBytes:native.estimatedPeakBytes,nativeWorkingBytes:native.workingBytes};s.generation=0;s.nativeIdleGeneration=-1;s.requestedKeys=[];
      s.nativeBudgetCeiling=p.memoryBudgetBytes-reservedMemoryBytes({domain:'orbital',sessionId})-Math.max(0,sharedExtra);
      refreshRendererBudgets();await request('open',s,{sourcePath:s.sourcePath,executable:backend.path,grid,threads:p.threads,memoryBudgetBytes:s.nativeBudgetCeiling,workspacePath:s.directory,mode:p.mode,settingsRevision:effective.settingsRevision});s.nativeOpen=true;
      if(s.closed||disposed){await request('close',s).catch(()=>{});s.nativeOpen=false;await clean(s);throw new Error('Orbital owner closed during planning');}
      owned(owner,sessionId,s);s.state='idle';return output;
    }finally{s.planning=false;releasePlan();}
  }
  async function reserveViews(owner,sessionId,viewCount,lease) {
    const s=owned(owner,sessionId);
    assert(Number.isSafeInteger(viewCount)&&(s.parent?viewCount===0:viewCount>=1),'Orbital view count must be a positive integer; analysis children have zero viewports');
    const previous=planningTail;let releasePlan;planningTail=new Promise(resolve=>{releasePlan=resolve;});
    try{
      await previous;owned(owner,sessionId,s);
      const previousCount=s.viewCount;s.viewCount=viewCount;
      const totalBytes=rendererTotal()+analyses.reservedMemoryBytes()+[...sessions.values()].filter(other=>!other.closed).reduce((total,other)=>total+(other.nativeOpen?other.plan?.nativeBytes??0:0),0);
      const budget=s.plan?.memoryBudgetBytes??[...(s.children??[])].find(child=>child.plan)?.plan.memoryBudgetBytes;
      let extra;try{extra=budget!==undefined&&lease?lease.budget(budget,{domain:'orbital-views',sessionId}).reservedBytes-reservedMemoryBytes({domain:'orbital-views',sessionId}):0;}catch(error){s.viewCount=previousCount;throw error;}
      const withinBudget=true; // View estimates remain advisory; opening a view performs no science.
      if(!withinBudget)s.viewCount=previousCount;refreshRendererBudgets();
      return {viewCount:s.viewCount,totalBytes:totalBytes+extra,withinBudget};
    }finally{releasePlan();}
  }
  async function commandDirect(owner,sessionId,raw,nativeMemoryBudgetBytes,resourceGrant) {
    const s=owned(owner,sessionId),value=commandRequest(raw,s.keys);
    if(value.operation==='close')return closeSession(s);
    assert(s.nativeOpen&&!s.planning,'Plan the orbital grid before generation');
    const selected=s.plan.mode==='selected';
    assert(value.operation!=='generate-one'||selected,'generate-one requires a selected-mode resource plan');
    assert(!selected||!['generate','continue','prioritize'].includes(value.operation),'Selected mode requires generate-one, not legacy all-orbital commands');
    if(value.operation==='generate-one'){
      const count=Math.max(1,s.completed.size+(s.completed.has(value.orbitalId)?0:1));
      const nextNative=s.plan.nativeWorkingBytes+s.plan.fieldBytes*count;
      const total=rendererTotal()+analyses.reservedMemoryBytes()+[...sessions.values()].filter(other=>!other.closed).reduce((sum,other)=>sum+(other===s?nextNative:other.nativeOpen?other.plan?.nativeBytes??0:0),0);
      s.requestedKeys=[value.orbitalId];updateSelectedReserve(s);
    }
    if(['generate','continue','generate-one','stop'].includes(value.operation))s.generation++;
    if(['generate','continue','generate-one'].includes(value.operation)){s.lastNativeError=undefined;s.state='queued';}
    if(value.operation==='stop'){s.state='stopped';s.requestedKeys=[];updateSelectedReserve(s);}
    const generation=s.generation;
    try{
      const result=await request(value.operation,s,{priorityIds:value.priorityIds,...(value.orbitalId?{orbitalId:value.orbitalId}:{}),...(nativeMemoryBudgetBytes===undefined?{}:{nativeMemoryBudgetBytes}),...(resourceGrant?{resourceGrant}:{})});owned(owner,sessionId);
      if(result.completedIds!==undefined||['stop','status'].includes(value.operation))completedSnapshot(s,result);
      if(selected&&result.state==='complete'&&s.generation===generation)s.state='completed';
      return {...progress(s,{event:'state',seq:s.seq}),status:s.state};
    }catch(error){if(selected&&s.generation===generation)s.state='failed';throw error;}
  }
  async function command(owner,sessionId,raw,progressContext) {
    if(raw?.operation==='close'){
      assert(Number.isSafeInteger(owner)&&owner>=0,'Invalid orbital owner');identity(sessionId);commandRequest(raw,new Set());
      const s=sessions.get(sessionId);if(s){assert(s.owner===owner,'Orbital session not owned or closed');return closeSession(s);}
      rememberClosed(owner,sessionId);return {sessionId,status:'closed'};
    }
    if(!scheduler)return commandDirect(owner,sessionId,raw);
    const s=owned(owner,sessionId),value=commandRequest(raw,s.keys);
    if(value.operation==='close')return closeSession(s);
    // Replanning also sends stop to an already settled session. Only a live
    // scientific cycle may change its run progress to stopping/stopped.
    if(value.operation==='stop') { const cycle=s.leaseCycle;if(cycle)s.taskProgress?.report('stopping');cycle?.controller.abort();const result=await commandDirect(owner,sessionId,raw);if(cycle)await cycle.task;return result; }
    if(!['generate','continue','generate-one'].includes(value.operation))return commandDirect(owner,sessionId,raw);
    // Only the user's explicit replacement may stop their previous selection.
    if(s.leaseCycle){const previous=s.leaseCycle;previous.controller.abort();if(previous.lease)await commandDirect(owner,sessionId,{operation:'stop'});await previous.task;owned(owner,sessionId,s);}
    const id=progressIdentity(progressContext,{sessionId:s.sessionId,sourceId:s.sourceId,sourceRevision:s.sourceRevision,analysisId:s.instanceId,operation:'orbital'}),taskProgress=createMultiwfnProgress(id,snapshot=>sendProgress(owner,snapshot));s.taskProgress=taskProgress;taskProgress.report('queued');
    const cycle={controller:new AbortController()};s.leaseCycle=cycle;
    let resolveAck,rejectAck;const receipt=new Promise((resolve,reject)=>{resolveAck=resolve;rejectAck=reject;});
    cycle.task=track((async()=>{let generation=s.generation,failure;
      try{
        cycle.lease=await scheduler.acquire({owner,key:`orbital:${sessionId}`,signal:cycle.controller.signal});owned(owner,sessionId,s);
        const captured=resolveResources?await captureResources(s,cycle.controller):undefined;owned(owner,sessionId,s);assert(!cycle.controller.signal.aborted,'ORBITAL_CANCELLED');
        assert(s.plan,'Plan the orbital grid before generation');
        let admittedBackend;
        if(captured){admittedBackend=await resolveBackend();const effective=await configuredResources(admittedBackend,{},captured);owned(owner,sessionId,s);assert(!cycle.controller.signal.aborted,'ORBITAL_CANCELLED');s.plan={...s.plan,threads:effective.threads,memoryBudgetBytes:effective.memoryBudgetBytes,resources:effective};}
        const budget=cycle.lease.budget(s.plan?.memoryBudgetBytes,{domain:'orbital',sessionId});
        const ownCeiling=s.plan.memoryBudgetBytes-reservedMemoryBytes({domain:'orbital',sessionId});
        const nativeBudget=Math.min(budget.availableBytes,captured?ownCeiling:s.nativeBudgetCeiling??ownCeiling);assert(Number.isSafeInteger(nativeBudget)&&nativeBudget>0,'ORBITAL_MEMORY_BUDGET: 已实际保留的缓存达到当前可用内存预算');s.runResources={...s.plan.resources,nativeMemoryBudgetBytes:nativeBudget,...(captured?{computeResourceVersion:captured.version,computeResourceSource:captured.source}:{})};
        const grant=captured?{threads:s.plan.threads,memoryBudgetBytes:nativeBudget,settingsRevision:s.plan.resources.settingsRevision,executable:admittedBackend.path}:undefined;
        taskProgress.report('running');const result=await commandDirect(owner,sessionId,raw,nativeBudget,grant);generation=s.generation;resolveAck(result);
        await waitNativeIdle(s,generation);
      }catch(error){failure=error;rejectAck(error);if(cycle.lease){const w=worker;if(w?.terminating||disposed){if(w)await w.finished;}else if(s.closed){await waitNativeIdle(s,s.generation);}else if(s.nativeOpen){try{await commandDirect(owner,sessionId,{operation:'stop'});nativeIdle(s,s.generation);}catch{const failed=worker;if(failed){failAll(error);await failed.finished;}}}}}
      finally{cycle.lease?.release();if(cycle.controller.signal.aborted)taskProgress.report('stopped',{settlement:cycle.lease?'native-settled':'cancelled-before-start'});else if(failure||s.state==='failed')taskProgress.report('failed',{settlement:cycle.lease?'native-settled':'not-started',message:(failure?.message??(s.lastNativeError?.generation===generation?s.lastNativeError.message:undefined))?.slice(0,2048)});else taskProgress.report('parse',{stageLabel:'等待轨道格点接受',settlement:'native-settled',validated:true});if(s.leaseCycle===cycle)delete s.leaseCycle;}
    })());return receipt;
  }
  async function field(owner,sessionId,key){const s=owned(owner,sessionId);assert(s.nativeOpen&&s.keys.has(key)&&s.completed.has(key),'Orbital field is absent or pending');const value=await request('field',s,{orbitalId:key});owned(owner,sessionId);return decodeField(value,s,key);}
  async function cube(owner,sessionId,key){const s=owned(owner,sessionId);assert(s.nativeOpen&&s.keys.has(key)&&s.completed.has(key),'Orbital field is absent or pending');const value=await request('export-cube',s,{orbitalId:key});owned(owner,sessionId);assert(typeof value.text==='string','Invalid orbital Cube export');return value.text;}
  async function analyze(owner,sessionId,raw,progressContext){const s=owned(owner,sessionId);(s.sourceRoot??s).sourceExpectationUsed=true;const result=await analyses.run(s,raw,progressContext);owned(owner,sessionId,s);return result;}
  async function cancelAnalysis(owner,sessionId){owned(owner,sessionId);await analyses.cancel(sessionId);}
  function closeOwner(owner){closedOwners.add(owner);scheduler?.cancelOwner(owner);for(const s of sessions.values())if(s.owner===owner&&!s.parent)void track(closeSession(s)).catch(()=>{});}
  function dispose(){if(disposed)return;disposed=true;cancelIdle();analyses.dispose();const w=worker;for(const s of sessions.values()){s.closed=true;s.openController?.abort(cancelledOpen());s.leaseCycle?.controller.abort();for(const controller of s.allocationControllers??[])controller.abort();if(w)w.finished.then(()=>nativeIdle(s,s.generation));if(!s.parent){if(w)cleanupAfterClose.add(s);else void clean(s);}}sessions.clear();if(w){w.terminating=true;clearTimeout(w.killTimer);for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Orbital host closing'));}pending.clear();try{w.child.stdin.end();}catch{}w.killTimer=setTimeout(()=>{if(!w.closed)w.child.kill();},policy.stopMs);w.killTimer.unref?.();}}
  return {open:(...args)=>sessionTask(open,args,args[1]?.sessionId),bindTrustedSourceExpectation,forkSession:(...args)=>sessionTask(forkSession,args,args[1]),resources:(...args)=>track(resources(...args)),analyze:(...args)=>sessionTask(analyze,args,args[1]),cancelAnalysis:(...args)=>track(cancelAnalysis(...args)),plan:(...args)=>sessionTask((...values)=>allocation(values[0],`orbital-plan:${values[1]}`,(lease,resources)=>plan(...values,lease,resources),values[1]),args,args[1]),reserveViews:(...args)=>sessionTask((...values)=>allocation(values[0],`orbital-views:${values[1]}`,lease=>reserveViews(...values,lease),values[1]),args,args[1]),command:(...args)=>args[2]?.operation==='close'?track(command(...args)):sessionTask(command,args,args[1]),field:(...args)=>sessionTask(field,args,args[1]),cube:(...args)=>sessionTask(cube,args,args[1]),closeOwner,dispose,reservedMemoryBytes,settle:async()=>{while(operationTasks.size||cleanupTasks.size)await Promise.allSettled([...operationTasks,...cleanupTasks]);},sessionCount:()=>sessions.size,activeCount:()=>analyses.activeCount()+starting+[...sessions.values()].filter(s=>s.planning||s.leaseCycle||['running','queued'].includes(s.state)).length,workerCount:()=>(worker&&!worker.closed?1:0)+inspectWorkers.size};
}
module.exports={createOrbitalHost};
