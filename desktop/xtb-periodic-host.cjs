'use strict';
const path=require('node:path');
const {isDeepStrictEqual:same}=require('node:util');
const {StringDecoder}=require('node:string_decoder');
const {assert,within}=require('./security.cjs');
const {validateStart}=require('./xtb-security.cjs');
const {cleanTaskDirectory}=require('./task-cache.cjs');
const {DEFAULT_OUTPUT_BUDGET_BYTES,outputBudget:resourceOutputBudget,boundedLog}=require('./output-budget.cjs');

/** One SciPy worker owns serial xTB gradient children. It reports native close
 * before final results; host ownership and actual worker close precede publish. */
function createPeriodicXtbHost({spawn,resolveRuntime,resolveXtbRuntime,resolveResources,admit,jobRoot,sendToWindow,fs,limits={}}){
  const sessions=new Map(),closedOwners=new Set();let disposed=false;
  const policy={stopMs:2000,maxOutputBytes:DEFAULT_OUTPUT_BUDGET_BYTES,...limits},key=(owner,id)=>`${owner}:${id}`;
  function outputBudget(request,id){
    // Python's protocol uses ensure_ascii; count escaped IDs/stamps, not their
    // shorter UTF-8 form. Raw chunks, including split UTF-8, are counted below.
    const wireBytes=value=>Buffer.byteLength(JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
    const n=request.structure.atoms.length,c=wireBytes(request.structure.atoms.map(({id,element})=>({id,element})))+128*n;
    const identity=wireBytes({sessionId:id,stamp:request.stamp,sourceCell:request.structure.cell}),sp=request.calculation==='singlepoint';
    const frame=4096+identity+c,terminal=32768+identity+4*c+(sp?4*1024*1024:0),native=1024+identity;
    const evaluations=sp?0:Math.max(20,22*request.maxSteps),frames=sp?0:request.maxSteps+1;
    return{frame,terminal,native,evaluations,frames,events:2*evaluations+frames+1,stderr:1024*1024,
      packet:Math.min(8*1024*1024,Math.max(frame,terminal,native)),
      total:policy.maxOutputBytes};
  }
  async function directory(target){const stat=await fs.lstat(target),actual=await fs.realpath(target);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&(process.platform==='win32'?path.resolve(actual).toLowerCase()===path.resolve(target).toLowerCase():path.resolve(actual)===path.resolve(target)),'Periodic workspace must not traverse links');}
  function singlepoint(s){return s.request.calculation==='singlepoint';}
  function emit(s,event,data={}){if(s.ownerClosed||s.terminal)return;const packet={schema:1,sessionId:s.id,stamp:s.request.stamp,operation:singlepoint(s)?'xtb-singlepoint':'xtb-optimize',method:s.request.method,event,seq:s.seq++,...data,...(s.effectiveResources?{effectiveResources:s.effectiveResources}:{})};if(event==='frame')s.lastFrame=structuredClone(data);if(['completed','stopped','error'].includes(event))s.terminal=true;try{sendToWindow(s.owner,packet);}catch{closeOwner(s.owner);}}
  function capture(s,task){
    return new Promise((resolve,reject)=>{const signal=s.abort.signal,aborted=()=>reject(new Error('Periodic resource capture cancelled'));if(signal.aborted){aborted();return;}signal.addEventListener('abort',aborted,{once:true});Promise.resolve(task).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));});
  }
  function stop(s,reason='cancelled'){
    if(s.stopReason||s.terminal)return;s.stopReason=reason;s.abort.abort();
    if(s.child&&!s.closed){try{s.child.stdin.write(JSON.stringify({command:'stop'})+'\n');}catch{}
      s.killTimer=setTimeout(()=>{if(!s.closed)try{s.child.kill();}catch{}},policy.stopMs);s.killTimer.unref?.();}
  }
  function periodic(s,value){assert(value&&same(value.sourceCell,s.request.structure.cell)&&same(value.sourcePbc,s.request.structure.cell.pbc)&&same(value.effectivePbc,[true,true,true])&&value.fixedCell===true,'Fixed-cell periodic evidence changed');if(singlepoint(s)){assert(s.request.method==='gfn2'&&value.backend==='tblite-api'&&value.bondOrderScope==='atom-pair-periodic-aggregate'&&value.imageResolved===false&&/^\d+\.\d+\.\d+$/.test(value.version??'')&&value.libraryVersion===value.version&&same(value.parameters,{method:'GFN2-xTB',accuracy:1,maxIterations:(s.request.maxSccIterations??250),electronicTemperatureHartree:.00095})&&!('optimizer' in value)&&!('gradientUnit' in value),'Periodic atom-pair evidence changed');return value;}assert(value.optimizer==='scipy-lbfgsb'&&typeof value.optimizerVersion==='string'&&value.optimizerVersion.length>0&&value.backend===(s.request.method==='gfn2'?'tblite':'native')&&value.gradientUnit==='hartree/bohr','Fixed-cell periodic optimizer evidence changed');if(s.request.method==='gfnff'){assert(/^[a-f0-9]{64}$/.test(value.forceFieldTopologySha256??'')&&(!s.topologySha||s.topologySha===value.forceFieldTopologySha256),'GFN-FF initial topology identity changed');s.topologySha=value.forceFieldTopologySha256;}return value;}
  function pairOrders(s,value){
    const atoms=s.request.structure.atoms;assert(value&&value.definition==='mayer-wiberg'&&value.sourceField==='tblite:bond-orders'&&value.threshold===0&&Array.isArray(value.entries)&&value.entries.length===atoms.length*(atoms.length-1)/2,'Incomplete periodic atom-pair bond orders');
    let index=0;for(let a=0;a<atoms.length;a++)for(let b=a+1;b<atoms.length;b++){const entry=value.entries[index++];assert(entry&&same(Object.keys(entry).sort(),['atomIds','value'])&&same(entry.atomIds,[atoms[a].id,atoms[b].id])&&Number.isFinite(entry.value),'Periodic atom-pair identity/order/value changed');}return value;
  }
  function coordinates(s,values){const fixed=new Set(s.request.frozenAtomIds);assert(Array.isArray(values)&&values.length===s.request.structure.atoms.length,'Periodic optimizer atom count changed');values.forEach((point,i)=>{const atom=s.request.structure.atoms[i];assert(point.id===atom.id&&point.element===atom.element&&['x','y','z'].every(axis=>Number.isFinite(point[axis])&&Math.abs(point[axis])<=1e6),'Periodic coordinate identity/order changed');if(singlepoint(s)||fixed.has(atom.id))assert(['x','y','z'].every(axis=>Object.is(point[axis],atom[axis])),singlepoint(s)?'Periodic singlepoint changed coordinates':'Periodic optimizer moved a fixed atom');});return values;}
  function optimization(s,value){
    if(value==null)return undefined;
    assert(!singlepoint(s)&&value.schema==='sciyue-periodic-optimization-v1'&&typeof value.reason==='string'&&value.reason.length<=128&&typeof value.message==='string'&&value.message.length<=8192&&(value.status===null||Number.isSafeInteger(value.status))&&value.gradientThresholdHartreePerBohr===1e-4&&value.maxSteps===s.request.maxSteps&&(value.maxWallTimeSeconds??undefined)===s.request.maxWallTimeSeconds&&value.method===s.request.method&&value.charge===s.request.charge&&value.uhf===s.request.uhf&&same(value.sourceCell,s.request.structure.cell)&&same(value.effectivePbc,[true,true,true]),'Periodic optimizer diagnostic source changed');
    assert(Number.isSafeInteger(value.evaluations)&&value.evaluations>=0&&Number.isFinite(value.elapsedSeconds)&&value.elapsedSeconds>=0&&Array.isArray(value.attempts)&&value.attempts.length<=2&&value.timings&&['nativeProcessSeconds','evaluationSeconds','optimizerSeconds'].every(name=>Number.isFinite(value.timings[name])&&value.timings[name]>=0),'Invalid periodic timing/budget diagnostic');
    assert(value.attempts.every((attempt,i)=>attempt.attempt===i&&typeof attempt.reason==='string'&&typeof attempt.message==='string'&&attempt.message.length<=2048&&typeof attempt.success==='boolean'&&(attempt.status===null||Number.isSafeInteger(attempt.status))&&Number.isSafeInteger(attempt.iterations)&&attempt.iterations>=0&&Number.isSafeInteger(attempt.functionEvaluations)&&attempt.functionEvaluations>=0&&Number.isFinite(attempt.energyHartree)&&Number.isFinite(attempt.gradientMaxHartreePerBohr)&&attempt.gradientMaxHartreePerBohr>=0)&&value.attempts.reduce((sum,attempt)=>sum+attempt.iterations,0)<=s.request.maxSteps,'Invalid periodic optimizer attempt history');
    if(value.accepted){const a=value.accepted,movable=s.request.structure.atoms.filter(atom=>!s.request.frozenAtomIds.includes(atom.id));coordinates(s,a.coordinates);assert(Number.isSafeInteger(a.step)&&a.step>=0&&a.step<=s.request.maxSteps&&Number.isFinite(a.energyHartree)&&Number.isFinite(a.gradientMaxHartreePerBohr)&&a.gradientMaxHartreePerBohr>=0&&same(a.movableAtomIds,movable.map(atom=>atom.id))&&Array.isArray(a.movableGradientHartreePerBohr)&&a.movableGradientHartreePerBohr.length===movable.length&&a.movableGradientHartreePerBohr.every(point=>Array.isArray(point)&&point.length===3&&point.every(Number.isFinite)),'Invalid last accepted periodic state');const maximum=a.movableGradientHartreePerBohr.reduce((maximum,point)=>point.reduce((maximum,component)=>Math.max(maximum,Math.abs(component)),maximum),0);assert(a.gradientMaxHartreePerBohr===maximum,'Accepted periodic gradient maximum differs from its raw components');}
    return value;
  }
  function packet(s,value){
    assert(value&&value.sessionId===s.id&&same(value.stamp,s.request.stamp),'Periodic worker source identity changed');
    const kind=value.kind;assert(['native-started','native-closed','frame','completed','stopped','error'].includes(kind),'Unknown periodic worker event');
    const count=s.counts[kind]=(s.counts[kind]??0)+1;s.eventCount++;
    assert(kind==='frame'?count<=s.budget.frames:kind.startsWith('native-')?true:(s.terminalPackets=(s.terminalPackets??0)+1)<=1,'Periodic worker event budget exceeded');
    if(value.kind==='native-started'){assert(Number.isSafeInteger(value.pid)&&value.pid>0&&!s.nativePids.has(value.pid),'Invalid periodic child identity');s.nativePids.add(value.pid);return;}
    if(value.kind==='native-closed'){assert(s.nativePids.has(value.pid)&&Number.isSafeInteger(value.code),'Unknown periodic native close');s.nativePids.delete(value.pid);return;}
    if(value.kind==='frame'){assert(!singlepoint(s),'Periodic singlepoint cannot publish optimizer frames');if(s.stopReason)return;assert(!s.result&&Number.isSafeInteger(value.step)&&value.step>s.lastStep&&value.step<=s.request.maxSteps&&value.stepKind==='outer-optimizer-iteration'&&Number.isFinite(value.energyHartree),'Invalid outer optimizer frame');periodic(s,value.periodic);coordinates(s,value.coordinates);s.lastStep=value.step;emit(s,'frame',{step:value.step,stepKind:value.stepKind,coordinates:value.coordinates,periodic:value.periodic});return;}
    assert(['completed','stopped','error'].includes(value.kind)&&!s.result&&value.nativeClosed===true&&s.nativePids.size===0,'Periodic worker did not settle its native children');
    optimization(s,value.optimization);
    if(value.kind==='completed'){coordinates(s,value.coordinates);periodic(s,value.periodic);assert(Number.isFinite(value.energyHartree),'Nonfinite periodic result energy');if(singlepoint(s))pairOrders(s,value.bondOrders);else{assert((!value.optimization||value.optimization.reason==='converged')&&Number.isFinite(value.gradientMaxHartreePerBohr)&&value.gradientMaxHartreePerBohr<=1e-4&&Number.isSafeInteger(value.iterations)&&value.iterations>=0&&value.iterations<=s.request.maxSteps,'Periodic result did not meet its convergence contract');if(value.optimization){const accepted=value.optimization.accepted;assert(accepted&&same(value.coordinates,accepted.coordinates)&&value.energyHartree===accepted.energyHartree&&value.gradientMaxHartreePerBohr===accepted.gradientMaxHartreePerBohr,'Periodic completed result differs from its last accepted state');}}}
    s.result=value;
  }
  async function diagnostics(s){if(!s.job)return;for(const [name,text]of [['worker-stdout.ndjson',s.stdout],['worker-stderr.txt',s.stderr]])try{await fs.writeFile(path.join(s.job,name),text,{flag:'wx'});}catch{}}
  async function releaseClosed(s){
    if(s.releaseStarted)return;s.releaseStarted=true;
    try{if(s.job)try{await cleanTaskDirectory(s.job,fs);}catch(error){console.warn('PERIODIC_TASK_CACHE_RETAINED',error.message);}if(s.release)await s.release();sessions.delete(key(s.owner,s.id));s.resolve();}
    catch(error){s.reject(error);}
  }
  async function finish(s,code,signal){
    if(s.finishing)return;s.finishing=true;s.closed=true;clearTimeout(s.wallTimer);clearTimeout(s.killTimer);
    try{
      if(s.nativePids.size){
        // A killed Windows worker closes its KILL_ON_JOB_CLOSE handle. Observe
        // the known children disappearing before reporting any terminal state.
        const deadline=Date.now()+5000;
        while(s.nativePids.size&&Date.now()<deadline){for(const pid of s.nativePids){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')s.nativePids.delete(pid);}}if(s.nativePids.size)await new Promise(resolve=>setTimeout(resolve,20));}
      }
      assert(s.nativePids.size===0,'Actual periodic xTB child close remains unconfirmed');
      if(s.failure)throw s.failure;
      if(s.stopReason||s.result?.kind==='stopped'){await diagnostics(s);emit(s,s.stopReason&&s.stopReason!=='cancelled'?'error':'stopped',s.stopReason&&s.stopReason!=='cancelled'?{error:{code:s.stopReason==='Periodic optimizer wall budget exceeded'?'XTB_PERIODIC_WALL_LIMIT':'XTB_PERIODIC_STOPPED',message:s.stopReason},...(s.result?.optimization?{optimization:s.result.optimization}:{}),exit:{code,signal}}:{reason:'cancelled',...(s.lastFrame??{}),...(s.result?.optimization?{optimization:s.result.optimization}:{}),exit:{code,signal}});return;}
      assert(!s.tail.trim()&&s.result?.nativeClosed===true,'Periodic worker ended without a settled result');
      assert(code===0&&signal===null&&s.result.kind==='completed',s.result.message??`Periodic optimizer did not exit successfully (${code},${signal})`);
      const r=s.result,sp=singlepoint(s),metadata={calculation:sp?'singlepoint':'optimize',converged:true,...(sp?{bondOrders:r.bondOrders}:{iterations:r.iterations}),energyHartree:r.energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',engine:sp?'tblite':'xtb',version:sp?r.periodic.version:s.runtime.version,method:s.request.method,charge:s.request.charge,uhf:s.request.method==='gfnff'?null:s.request.uhf,spinTreatment:s.request.method==='gfnff'?'not-supported':'requested-unpaired-electrons',threads:s.request.threads,maxSteps:s.request.maxSteps,maxWallTimeSeconds:s.request.maxWallTimeSeconds,frozenAtomIds:s.request.frozenAtomIds,internalConstraintMode:'none',internalConstraints:[],periodic:r.periodic};
      if(s.effectiveResources)metadata.resourceGrant=structuredClone(s.effectiveResources);
      if(r.optimization)metadata.optimization=r.optimization;
      // Keep raw pair diagnostics. The consumer alone chooses an unambiguous
      // nearest image; this host never invents image-resolved matrix entries.
      await diagnostics(s);emit(s,'completed',{coordinates:r.coordinates,metadata,periodic:r.periodic,...(sp?{}:{step:r.step,stepKind:'outer-optimizer-iteration'}),exit:{code,signal}});
    }catch(error){await diagnostics(s);const allowed=new Set(['XTB_PERIODIC_SCF_NOT_CONVERGED','XTB_PERIODIC_WALL_LIMIT','XTB_PERIODIC_EVALUATION_TIMEOUT','XTB_PERIODIC_EVALUATION_LIMIT','XTB_PERIODIC_STEP_LIMIT','XTB_PERIODIC_LINE_SEARCH','XTB_PERIODIC_FINAL_GRADIENT','XTB_PERIODIC_OPTIMIZER_FAILED','XTB_PERIODIC_FORCE_FIELD_IMAGE_CHANGED','XTB_PERIODIC_NONFINITE_RESULT']);emit(s,'error',{error:{code:!s.failure&&allowed.has(s.result?.code)?s.result.code:'XTB_PERIODIC_REJECTED',message:String(error.message).slice(0,8192)},...(s.lastFrame??{}),...(!s.failure&&s.result?.optimization?{optimization:s.result.optimization}:{}),exit:{code,signal}});}
    finally{
      if(!s.nativePids.size)await releaseClosed(s);
      else{const timer=setInterval(()=>{for(const pid of s.nativePids){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')s.nativePids.delete(pid);}}if(!s.nativePids.size){clearInterval(timer);void releaseClosed(s);}},100);timer.unref?.();}
    }
  }
  async function start(owner,request,id,beforeStart,resourceHints){
    assert(!disposed&&!closedOwners.has(owner)&&typeof resolveRuntime==='function','Packaged periodic optimizer runtime is unavailable');
    request=structuredClone(request);
    const s={owner,id,request,seq:0,stdout:'',stderr:'',tail:'',bytes:0,stderrBytes:0,budget:outputBudget(request,id),counts:{},eventCount:0,nativePids:new Set(),lastStep:-1,abort:new AbortController()};s.finished=new Promise((resolve,reject)=>{s.resolve=resolve;s.reject=reject;});void s.finished.catch(()=>{});sessions.set(key(owner,id),s);
    try{
      if(resolveResources){s.configuredResources=await capture(s,resolveResources(owner,{...structuredClone(request),...resourceHints}));beforeStart();Object.assign(request,validateStart({...request,threads:s.configuredResources.threads}));}
      if(admit){s.release=await admit(owner,structuredClone(request),{signal:s.abort.signal,resources:s.configuredResources});assert(typeof s.release==='function','Periodic admission must return a trusted release function');if(s.configuredResources){assert(s.release.resources&&Number.isSafeInteger(s.release.resources.memoryBudgetBytes)&&s.release.resources.memoryBudgetBytes>0,'XTB_RESOURCE_GRANT: Shared periodic resource grant unavailable');s.effectiveResources=structuredClone(s.release.resources);Object.assign(request,validateStart({...request,threads:s.release.resources.threads}));}}
      if(s.stopReason){s.result={kind:'stopped',nativeClosed:true};await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      s.budget.total=resourceOutputBudget(s.effectiveResources??s.configuredResources,policy.maxOutputBytes);
      s.runtime=await resolveXtbRuntime();const workerRuntime=await resolveRuntime();assert(workerRuntime&&path.isAbsolute(workerRuntime.executable)&&Array.isArray(workerRuntime.args)&&workerRuntime.args.includes('--xtb-periodic')&&path.isAbsolute(workerRuntime.cwd),'Trusted packaged periodic worker required');
      await fs.mkdir(jobRoot,{recursive:true});await directory(jobRoot);s.job=await fs.mkdtemp(path.join(jobRoot,'periodic-'));assert(within(jobRoot,s.job)&&path.dirname(s.job)===path.resolve(jobRoot),'Periodic workspace escaped ownership');await directory(s.job);
      beforeStart();if(s.stopReason){s.result={kind:'stopped',nativeClosed:true};await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      const child=s.child=spawn(workerRuntime.executable,workerRuntime.args,{cwd:workerRuntime.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:String(request.threads),OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads),OMP_MAX_ACTIVE_LEVELS:'1',OMP_DYNAMIC:'FALSE'}});
      const out=new StringDecoder('utf8'),err=new StringDecoder('utf8');
      child.stdout.on('data',chunk=>{if(s.closed)return;try{
        assert(s.bytes+chunk.length<=s.budget.total,'Periodic worker output exceeded its cumulative limit');
        s.bytes+=chunk.length;const text=out.write(chunk);s.stdout=boundedLog(s.stdout,text);s.tail+=text;let end;
        while((end=s.tail.indexOf('\n'))>=0){const line=s.tail.slice(0,end);s.tail=s.tail.slice(end+1);const value=JSON.parse(line),bound=value.kind==='frame'?s.budget.frame:value.kind?.startsWith('native-')?s.budget.native:s.budget.terminal;packet(s,value);}
      }catch(error){s.failure=error;stop(s,'Invalid periodic worker output');}});
      child.stderr.on('data',chunk=>{if(s.closed)return;try{assert(s.bytes+chunk.length<=s.budget.total,'Periodic worker stderr/output exceeded its limit');s.bytes+=chunk.length;s.stderrBytes+=chunk.length;s.stderr=boundedLog(s.stderr,err.write(chunk));}catch(error){s.failure=error;stop(s,'Periodic output limit exceeded');}});
      child.stdin.on('error',error=>{s.failure=error;stop(s,'Periodic worker input failed');});child.on('error',error=>{s.failure=error;stop(s,'Periodic worker failed to start');});
      child.once('close',(code,signal)=>{s.stdout+=out.end();s.stderr+=err.end();void finish(s,code,signal??null);});
      child.stdin.write(JSON.stringify({sessionId:id,request,runtime:s.runtime,workspacePath:s.job})+'\n');
      if(request.maxWallTimeSeconds!==undefined){s.wallTimer=setTimeout(()=>stop(s,'Periodic optimizer wall budget exceeded'),request.maxWallTimeSeconds*1000);s.wallTimer.unref?.();}emit(s,'started',{status:'running'});return{sessionId:id,status:'starting'};
    }catch(error){if(!s.stopReason)s.failure=error;if(!s.child)await finish(s,null,null);else stop(s,'Periodic setup failed');return{sessionId:id,status:s.stopReason==='cancelled'?'stopped':'error'};}
  }
  function command(owner,id){const s=sessions.get(key(owner,id));assert(s&&!s.terminal,'Periodic xTB session is not owned/active');stop(s);return s.finished.then(()=>({sessionId:id,status:'stopped'}));}
  function closeOwner(owner){closedOwners.add(owner);for(const s of sessions.values())if(s.owner===owner){s.ownerClosed=true;stop(s);}}
  function dispose(){disposed=true;for(const s of sessions.values()){s.ownerClosed=true;stop(s);}}
  // Shutdown callers close the owner/host first. Unlike the bounded diagnostic
  // wait, this resolves only after finish and every observed native child close.
  async function settle(owner){await Promise.all([...sessions.values()].filter(s=>owner===undefined||s.owner===owner).map(s=>s.finished));}
  async function waitForOwnedChildren(owner,timeoutMs=5000){const selected=[...sessions.values()].filter(s=>owner===undefined||s.owner===owner);if(!selected.length)return;let timer;try{await Promise.race([Promise.all(selected.map(s=>s.finished)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Actual periodic worker/native close not confirmed')),timeoutMs);})]);}finally{clearTimeout(timer);}}
  return{start,command,closeOwner,dispose,settle,waitForOwnedChildren,owns:(owner,id)=>sessions.has(key(owner,id)),hasOwner:owner=>[...sessions.values()].some(s=>s.owner===owner),activeCount:()=>sessions.size,workerCount:()=>[...sessions.values()].filter(s=>s.child&&!s.closed).length};
}
module.exports={createPeriodicXtbHost};
