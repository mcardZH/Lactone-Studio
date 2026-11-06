'use strict';
const path=require('node:path');
const nativeFS=require('node:fs/promises');
const {StringDecoder}=require('node:string_decoder');
const {createHash}=require('node:crypto');
const {assert,within,boundedJSON}=require('./security.cjs');
const {sessionIdentity,validateStart,xyzInput,xcontrolInput,invocation,nativeSolvation,optimizedCoordinates,convergence,singlepointConvergence,nativeBondOrders,acceptedConstraintResiduals,createTrajectoryParser,isPeriodic}=require('./xtb-security.cjs');
const {createPeriodicXtbHost}=require('./xtb-periodic-host.cjs');
const {cleanTaskDirectory}=require('./task-cache.cjs');
const {DEFAULT_OUTPUT_BUDGET_BYTES,outputBudget,boundedLog,scientificLog}=require('./output-budget.cjs');
const {createXtbOptimizationCache}=require('./xtb-optimization-cache.cjs');

/** owner is a trusted webContents ID. Runtime paths and jobRoot are host-only. */
function createXtbHost({spawn,resolveRuntime,resolvePeriodicRuntime,retainElectronicArtifacts,admit,resolveResources,jobRoot,sendToWindow,fs=nativeFS,now=Date.now,setTimeout:later=setTimeout,clearTimeout:clearLater=clearTimeout,limits={}}){
  assert(typeof spawn==='function'&&typeof resolveRuntime==='function'&&typeof sendToWindow==='function'&&path.isAbsolute(jobRoot),'Trusted xTB host configuration required');
  assert(admit===undefined||typeof admit==='function','Trusted xTB admission hook required');
  const policy={stopMs:2000,maxOutputBytes:DEFAULT_OUTPUT_BUDGET_BYTES,trajectoryPollMs:50,...limits};
  assert((policy.maxSessions===undefined||Number.isSafeInteger(policy.maxSessions)&&policy.maxSessions>=1)&&Number.isFinite(policy.stopMs)&&policy.stopMs>=0&&policy.stopMs<=5000&&(policy.maxOutputBytes===DEFAULT_OUTPUT_BUDGET_BYTES||Number.isSafeInteger(policy.maxOutputBytes)&&policy.maxOutputBytes>0),'Invalid xTB host limits');
  assert(Number.isFinite(policy.trajectoryPollMs)&&policy.trajectoryPollMs>=20&&policy.trajectoryPollMs<=1000&&(policy.maxTrajectoryBytes===undefined||Number.isSafeInteger(policy.maxTrajectoryBytes)&&policy.maxTrajectoryBytes>0),'Invalid native trajectory observation bounds');
  const sessions=new Map(),closedOwners=new Set();let disposed=false;
  const optimizationCaches=createXtbOptimizationCache({fs,root:jobRoot}),cacheCloseTasks=new Set();
  const keyFor=(owner,id)=>`${owner}:${sessionIdentity(id)}`;
  const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  async function directory(target){const stat=await fs.lstat(target);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&samePath(await fs.realpath(target),target),'xTB directory must not traverse links');}
  async function runtimeInput(){
    const runtime=await resolveRuntime();assert(runtime&&path.isAbsolute(runtime.executable)&&path.isAbsolute(runtime.directory)&&path.isAbsolute(runtime.dataDirectory)&&within(runtime.root??runtime.directory,runtime.executable)&&within(runtime.root??runtime.directory,runtime.dataDirectory)&&/^(?:xtb|xtb\.exe)$/i.test(path.basename(runtime.executable))&&typeof runtime.version==='string'&&/^\d+\.\d+\.\d+(?:pre)?$/.test(runtime.version),'Trusted fixed xTB runtime required');
    await directory(runtime.directory);await directory(runtime.dataDirectory);const stat=await fs.lstat(runtime.executable);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&samePath(await fs.realpath(runtime.executable),runtime.executable),'xTB executable must be a regular independent runtime member');return {...runtime};
  }
  const periodicHost=createPeriodicXtbHost({spawn,resolveRuntime:resolvePeriodicRuntime,resolveXtbRuntime:runtimeInput,resolveResources,admit:resolveResources?admit:undefined,jobRoot,sendToWindow,fs,limits:policy});
  function emit(session,event,extra={}){
    if((session.ownerClosed&&!session.batchSink)||session.terminal)return;
    const value={schema:1,sessionId:session.sessionId,stamp:session.request.stamp,...(session.request.runIdentity?{runIdentity:session.request.runIdentity}:{}),operation:session.request.calculation==='singlepoint'?'xtb-singlepoint':'xtb-optimize',event,seq:session.seq++,method:session.request.method,...extra,...(session.effectiveResources?{effectiveResources:session.effectiveResources}:{})};
    if(event==='frame')session.lastReliableFrame=structuredClone(extra);
    if(['completed','stopped','error'].includes(event))session.terminal=true;
    if(session.batchSink){if(session.terminal)session.batchTerminal={...value,nativeStarted:!!session.child};return;}
    try{sendToWindow(session.owner,value);}catch{session.ownerClosed=true;stop(session,{code:'XTB_OWNER_CLOSED',message:'xTB owner is no longer available'});}
  }
  function nativeProgress(session){
    const step=session.trace?.lastFrameStep??-1,elapsed=Math.max(0,(now()-session.startedMs)/1000);
    const waiting=session.request.calculation==='singlepoint'?'原生单点计算运行中':step<0?'等待首个完整优化帧':`收到完整原生几何帧（索引 ${step}）`;
    const last=session.lastOutputMs===undefined?'尚无原生日志':`最近输出 ${Math.max(0,Math.floor((now()-session.lastOutputMs)/1000))} 秒前`;
    emit(session,'progress',{...(step>=0?{step,stepKind:'native-log-frame'}:{}),status:`${waiting} · 已用 ${Math.floor(elapsed)} 秒 · ${last}`,logTail:session.stdout.slice(-2048)});
  }
  function scheduleProgress(session){
    session.progressTimer=later(()=>{if(session.closed||session.terminal||session.stopReason)return;nativeProgress(session);scheduleProgress(session);},1000);session.progressTimer.unref?.();
  }
  function stop(session,reason={code:'XTB_CANCELLED',message:'xTB optimization cancelled'}){
    if(session.batchSink&&session.closed)return;
    if(session.terminal||session.stopReason)return;session.stopReason=reason;session.admissionController.abort();clearLater(session.wallTimer);clearLater(session.progressTimer);
    if(session.trace)clearLater(session.trace.timer);
    if(session.child&&!session.closed){session.killTimer=later(()=>{if(!session.closed)try{session.child.kill('SIGKILL');}catch{/* Never claim a close that was not observed. */}},policy.stopMs);session.killTimer.unref?.();try{session.child.kill();}catch{/* Actual close remains required. */}}
  }
  function appendLog(session,stream,text){
    if(!text||!session.logHandles)return;
    const handle=session.logHandles[stream];
    const readable=session.child?.[stream];readable?.pause?.();
    session.logTask=(session.logTask??Promise.resolve()).then(async()=>{await handle.writeFile(text,'utf8');session.logBytes??={stdout:0,stderr:0};session.logBytes[stream]+=Buffer.byteLength(text);}).catch(error=>{
      session.logError=String(error.message);session.preserveForRecovery=true;
    }).finally(()=>readable?.resume?.());
  }
  async function closeLogs(session){
    const failed=[];
    try{await session.logTask;}catch(error){failed.push(String(error.message));}
    if(session.logHandles){
      const handles=session.logHandles;session.logHandles=undefined;
      const closed=await Promise.allSettled(Object.entries(handles).map(async([stream,handle])=>{try{await handle.close();}catch(error){throw new Error(`${stream} close: ${error.message}`);}}));
      for(const result of closed)if(result.status==='rejected')failed.push(String(result.reason.message));
    }
    if(failed.length){session.logError=[session.logError,...failed].filter(Boolean).join('; ');session.preserveForRecovery=true;}
  }
  function resourceEvidence(value){
    if(!value)return undefined;
    return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='number'&&!Number.isFinite(item)?undefined:item));
  }
  async function runEvidence(session,terminal){
    if(!session.job)return;
    const value={schema:1,kind:'ester-xtb-run-diagnostics',sessionId:session.sessionId,owner:session.owner,
      stamp:session.request.stamp,runIdentity:session.request.runIdentity,method:session.request.method,
      calculation:session.request.calculation,atomCount:session.request.structure.atoms.length,
      charge:session.request.charge,uhf:session.request.uhf,maxSteps:session.request.maxSteps,maxSccIterations:session.request.maxSccIterations,
      startedAt:session.startedAt,closedAt:terminal?new Date(now()).toISOString():undefined,
      elapsedSeconds:session.startedMs===undefined?undefined:(now()-session.startedMs)/1000,
      runtime:session.runtime?{executable:session.runtime.executable,dataDirectory:session.runtime.dataDirectory,version:session.runtime.version,engineIdentity:session.runtime.engineIdentity}:undefined,
      configuredResources:resourceEvidence(session.configuredResources),effectiveResources:resourceEvidence(session.effectiveResources),
      invocation:session.argv,environment:session.threadEnvironment,pid:session.child?.pid,hostPid:process.pid,inputs:session.inputEvidence,
      receivedOutputBytes:session.outputBytes,storedLogBytes:session.logBytes,
      lastCompleteFrameStep:session.trace?.lastFrameStep??null,lastOutputAt:session.lastOutputMs===undefined?undefined:new Date(session.lastOutputMs).toISOString(),
      logError:session.logError,trajectoryCloseError:session.trace?.closeError,...terminal};
    await directory(session.job);await fs.writeFile(path.join(session.job,terminal?'run-result.json':'run-diagnostics.json'),JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  }
  async function preserveDiagnostics(session,terminal){
    if(!session.job)return;
    session.preserveForRecovery=true;
    await closeLogs(session);
    await runEvidence(session,terminal);
    await fs.writeFile(path.join(session.job,'.retain-recovery.json'),JSON.stringify({schema:1,reason:terminal.reason??'xtb-failed',sessionId:session.sessionId})+'\n',{encoding:'utf8',flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  }
  async function readRegular(file){
    const before=await fs.lstat(file);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&Number.isSafeInteger(before.size)&&before.size>=0,'Unsafe xTB output member');
    const fd=await fs.open(file,'r');try{const opened=await fd.stat();assert(opened.isFile()&&opened.nlink===1&&opened.dev===before.dev&&opened.ino===before.ino&&opened.size===before.size,'xTB output identity changed while opening');const bytes=await fd.readFile();const after=await fd.stat(),current=await fs.lstat(file);assert(bytes.length===before.size&&after.size===before.size&&after.mtimeMs===opened.mtimeMs&&!current.isSymbolicLink()&&current.dev===opened.dev&&current.ino===opened.ino,'xTB output changed while reading');return bytes.toString('utf8');}finally{await fd.close();}
  }
  async function absent(file){try{await fs.lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
  async function closeTrace(trace){if(trace?.fd){const fd=trace.fd;trace.fd=undefined;try{await fd.close();}catch(error){trace.closeError=String(error.message);}}}
  async function trajectoryWarning(session,error){
    const trace=session.trace;if(!trace||trace.warning)return;trace.warning={code:error.code==='ENOENT'?'XTB_TRAJECTORY_MISSING':error.code==='XTB_TRAJECTORY_LIMIT'?'XTB_TRAJECTORY_LIMIT':'XTB_TRAJECTORY_INVALID',message:String(error.message).slice(0,8192)};clearLater(trace.timer);await closeTrace(trace);
  }
  async function readTrajectory(session,final=false,afterStop=false){
    const blocked=()=>session.ownerClosed||session.stopReason&&!afterStop;
    const trace=session.trace;if(!trace||trace.warning||blocked())return;await directory(session.job);
    const file=path.join(session.job,'xtbopt.log');let before;try{before=await fs.lstat(file);}catch(error){if(!final&&error.code==='ENOENT')return;throw error;}
    const check=(stat)=>{assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&Number.isSafeInteger(stat.size)&&stat.size>=trace.offset,'Native trajectory must remain a regular append-only owned file');if(policy.maxTrajectoryBytes!==undefined&&stat.size>policy.maxTrajectoryBytes)throw Object.assign(new Error('Native trajectory exceeds its observation byte limit'),{code:'XTB_TRAJECTORY_LIMIT'});if(trace.identity)assert(stat.dev===trace.identity.dev&&stat.ino===trace.identity.ino,'Native trajectory file identity changed');};check(before);
    if(!trace.fd)try{trace.fd=await fs.open(file,'r');const opened=await trace.fd.stat();assert(opened.dev===before.dev&&opened.ino===before.ino,'Native trajectory changed while opening');trace.identity={dev:opened.dev,ino:opened.ino};}catch(error){if(!final&&['EACCES','EBUSY'].includes(error.code))return;throw error;}
    check(await trace.fd.stat());check(await fs.lstat(file));
    while(trace.offset<before.size){const bytes=Buffer.alloc(Math.min(65536,before.size-trace.offset)),read=await trace.fd.read(bytes,0,bytes.length,trace.offset);assert(read.bytesRead>0&&read.bytesRead<=bytes.length,'Native trajectory was truncated while reading');if(blocked())return;trace.offset+=read.bytesRead;
      for(const frame of trace.parser.push(trace.decoder.write(bytes.subarray(0,read.bytesRead)))){if(blocked()||trace.warning)return;boundedJSON({stamp:session.request.stamp,...frame});emit(session,'frame',frame);trace.lastFrameStep=frame.step;trace.frameCount++;}
    }
    const after=await trace.fd.stat();check(after);check(await fs.lstat(file));if(final){assert(after.size===before.size&&after.mtimeMs===before.mtimeMs,'Native trajectory changed after the actual child close');for(const frame of trace.parser.push(trace.decoder.end())){if(blocked())return;emit(session,'frame',frame);trace.lastFrameStep=frame.step;trace.frameCount++;}trace.parser.finish();}
  }
  function scheduleTrajectory(session){
    const trace=session.trace;if(!trace||trace.warning||session.stopReason||session.closed)return;
    trace.timer=later(()=>{trace.task=readTrajectory(session).catch(error=>trajectoryWarning(session,error)).finally(()=>{trace.task=undefined;scheduleTrajectory(session);});},policy.trajectoryPollMs);trace.timer.unref?.();
  }
  async function diagnostics(session){
    try{await session.logTask;}catch(error){session.logError=String(error.message);session.preserveForRecovery=true;}
    if(!session.job)return;try{await directory(session.job);}catch{return;}for(const [name,text] of [['stdout.log',session.stdout],['stderr.log',session.stderr]])try{await fs.writeFile(path.join(session.job,name),text,{encoding:'utf8',flag:'wx'});}catch{/* A diagnostic write failure cannot suppress the actual terminal event. */}
  }
  async function finish(session,code,signal){
    if(session.finishing)return;session.finishing=true;session.closed=true;clearLater(session.wallTimer);clearLater(session.killTimer);clearLater(session.progressTimer);
    try{
      if(session.trace){clearLater(session.trace.timer);await session.trace.task;}
      if(session.stopReason){
        if(session.trace&&session.job)try{await readTrajectory(session,true,true);}catch(error){await trajectoryWarning(session,error);}
        await diagnostics(session);await preserveDiagnostics(session,{reason:session.stopReason.code,exit:{code,signal}});emit(session,session.stopReason.code==='XTB_CANCELLED'?'stopped':'error',{...(session.stopReason.code==='XTB_CANCELLED'?{reason:'cancelled'}:{error:session.stopReason}),...(session.lastReliableFrame??{}),exit:{code,signal}});return;
      }
      if(session.trace)try{await readTrajectory(session,true);}catch(error){await trajectoryWarning(session,error);}await closeTrace(session.trace);
      await closeLogs(session);
      assert(code===0&&signal===null,`xTB process did not exit successfully (${code}, ${signal})`);await directory(session.job);
      assert(!session.logError&&!session.trace?.closeError,`xTB diagnostic I/O failed: ${session.logError??session.trace?.closeError}`);
      const notConverged=!(await absent(path.join(session.job,'NOT_CONVERGED')));
      if(session.batchSink&&notConverged)throw Object.assign(Error('xTB wrote NOT_CONVERGED'),{code:'XTB_NOT_CONVERGED'});
      assert(!notConverged,'xTB wrote NOT_CONVERGED');
      const sp=session.request.calculation==='singlepoint';
      const scientificOutput=session.scientificStdout.finish(),scientificErrors=session.scientificStderr.finish();
      const scientific=(sp?singlepointConvergence:convergence)(scientificOutput+'\n'+scientificErrors,session.request);
      let coordinates;if(sp){assert(await readRegular(path.join(session.job,'input.xyz'))===xyzInput(session.request),'Singlepoint input coordinates changed');assert(await absent(path.join(session.job,'xtbopt.xyz')),'Singlepoint produced unexpected optimized coordinates');coordinates=session.request.structure.atoms.map(({id,element,x,y,z})=>({id,element,x,y,z}));}else coordinates=optimizedCoordinates(await readRegular(path.join(session.job,'xtbopt.xyz')),session.request);
      const version=scientificOutput.match(/\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i)?.[1];assert(version===session.runtime.version,'Actual xTB runtime version does not match the trusted runtime');
      const metadata={...scientific,engine:'xtb',version,...(session.runtime.engineIdentity?{engineIdentity:structuredClone(session.runtime.engineIdentity)}:{}),method:session.request.method,charge:session.request.charge,uhf:session.request.method==='gfnff'?null:session.request.uhf,spinTreatment:session.request.method==='gfnff'?'not-supported':'requested-unpaired-electrons',threads:session.request.threads,...(session.effectiveResources?{resourceGrant:structuredClone(session.effectiveResources)}:{}),maxSteps:session.request.maxSteps,maxWallTimeSeconds:session.request.maxWallTimeSeconds,frozenAtomIds:session.request.frozenAtomIds,internalConstraintMode:!sp&&session.request.constraints.length?'native-harmonic':'none',internalConstraints:sp?[]:acceptedConstraintResiduals(session.request,coordinates)};
      try{const solvation=nativeSolvation(scientificOutput,session.request);if(solvation)metadata.solvation=solvation;}catch(error){throw Object.assign(new Error(String(error.message).slice(0,8192)),{code:'XTB_SOLVATION_MISMATCH'});}
      if(session.trace){metadata.trajectory={sourceField:'xtbopt.log',frameCount:session.trace.frameCount,lastFrameStep:session.trace.lastFrameStep};if(session.trace.warning)metadata.trajectoryWarning=session.trace.warning;}
      if(session.request.method==='gfn2')try{const bondOrders=nativeBondOrders(await readRegular(path.join(session.job,'wbo')),session.request);boundedJSON({stamp:session.request.stamp,coordinates,metadata:{...metadata,bondOrders}});metadata.bondOrders=bondOrders;}catch(error){const issue={code:error.code==='ENOENT'?'XTB_BOND_ORDERS_MISSING':'XTB_BOND_ORDERS_INVALID',message:String(error.message).slice(0,8192)};if(sp)throw Object.assign(new Error(issue.message),{code:issue.code});metadata.bondOrdersWarning=issue;}
      if(session.stopReason){await diagnostics(session);emit(session,'stopped',{reason:'cancelled',...(session.lastReliableFrame??{}),exit:{code,signal}});return;}
      let electronicArtifacts;
      if(session.request.electronicProperties)try{
        const molden=await readRegular(path.join(session.job,'molden.input'));
        assert(/^\s*\[Molden Format\]/i.test(molden)&&/^\[Atoms\]\s+AU\s*$/mi.test(molden)&&/^\[GTO\]\s*$/mi.test(molden)&&/^\[MO\]\s*$/mi.test(molden)&&molden.endsWith('\n'),'Native Molden output is missing its complete section envelope');
        const file=(role,name,text)=>({role,name,text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text,'utf8').digest('hex')});
        const files=[file('molden','molden.input',molden),file('stdout','stdout.log',session.stdout),file('wbo','wbo',await readRegular(path.join(session.job,'wbo'))),...(session.stderr?[file('stderr','stderr.log',session.stderr)]:[])];
        electronicArtifacts=await retainElectronicArtifacts(session.owner,{sessionId:session.sessionId,stamp:structuredClone(session.request.stamp),...(session.request.runIdentity?{runIdentity:structuredClone(session.request.runIdentity)}:{}),metadata:{...structuredClone(metadata),orderedAtoms:coordinates.map(atom=>({...atom}))},files});
        assert(electronicArtifacts&&typeof electronicArtifacts.artifactId==='string'&&electronicArtifacts.artifactId.length>0&&electronicArtifacts.artifactId.length<=100&&Array.isArray(electronicArtifacts.files)&&electronicArtifacts.files.length===files.length,'Invalid managed xTB artifact acknowledgement');
        for(const expected of files)assert(electronicArtifacts.files.some(value=>value.role===expected.role&&value.name===expected.name&&value.bytes===expected.bytes&&value.sha256===expected.sha256),'Managed xTB artifact acknowledgement differs from native bytes');
        // Copy only the agreed receipt; a trusted adapter must not accidentally
        // send local paths or whole wavefunctions through the terminal event.
        electronicArtifacts={artifactId:electronicArtifacts.artifactId,files:files.map(({role,name,bytes,sha256})=>({role,name,bytes,sha256}))};
        boundedJSON(electronicArtifacts);
      }catch(error){session.preserveForRecovery=true;await fs.writeFile(path.join(session.job,'.retain-recovery.json'),JSON.stringify({reason:'electronic-artifact-handoff-failed'})+'\n',{flag:'wx'}).catch(()=>{});throw Object.assign(new Error(String(error.message).slice(0,8192)),{code:'XTB_ARTIFACT_HANDOFF_FAILED'});}
      // Owner close/cancellation can race the awaited snapshot publication.
      // Independently retained sources keep their own lifetime; task cleanup
      // below occurs only after this awaited publication has settled.
      if(session.stopReason||!session.batchSink&&(session.ownerClosed||disposed)){await diagnostics(session);if(session.stopReason?.code==='XTB_CANCELLED')emit(session,'stopped',{reason:'cancelled',...(electronicArtifacts?{electronicArtifacts}:{}),exit:{code,signal}});return;}
      if(metadata.bondOrdersWarning||metadata.trajectoryWarning)await diagnostics(session);
      if(electronicArtifacts&&(session.stopReason||!session.batchSink&&(session.ownerClosed||disposed))){if(session.stopReason?.code==='XTB_CANCELLED')emit(session,'stopped',{reason:'cancelled',electronicArtifacts,exit:{code,signal}});return;}
      // The renderer applies only these ordered coordinates through the Store.
      // No native topology, bond perception or input electronic state is copied.
      let optimizationCache;
      if(!session.batchSink&&session.request.runIdentity&&session.trace?.frameCount>1){
        await diagnostics(session);
        try { optimizationCache=await optimizationCaches.retain(session.owner,session.sessionId,session.job,session.request,outputBudget(session.effectiveResources?.configured??session.configuredResources,policy.maxOutputBytes),session.runtime.engineIdentity);session.retainOptimizationCache=true; }
        catch(error){session.preserveForRecovery=true;await fs.writeFile(path.join(session.job,'.retain-recovery.json'),JSON.stringify({reason:'optimization-cache-handoff-failed'})+'\n',{flag:'wx'}).catch(()=>{});throw error;}
      }
      emit(session,'completed',{coordinates,metadata,...(optimizationCache??{}),...(electronicArtifacts?{electronicArtifacts}:{}),exit:{code,signal},...(session.trace&&session.trace.lastFrameStep>=0?{step:session.trace.lastFrameStep,stepKind:'native-log-frame'}:{})});
    }catch(error){await diagnostics(session);await preserveDiagnostics(session,{reason:'xtb-failed',error:String(error.message),exit:{code,signal}}).catch(failure=>{session.preserveForRecovery=true;console.warn('XTB_DIAGNOSTIC_RETAIN_FAILED',String(failure.message));});emit(session,'error',{error:{code:session.batchSink&&(error.code==='XTB_NOT_CONVERGED'||/FAILED TO CONVERGE|convergence criteria cannot be satisfied/i.test(session.stdout+'\n'+session.stderr))?'XTB_NOT_CONVERGED':['XTB_BOND_ORDERS_MISSING','XTB_BOND_ORDERS_INVALID','XTB_ARTIFACT_HANDOFF_FAILED','XTB_SOLVATION_MISMATCH'].includes(error.code)?error.code:session.lastReliableFrame?.step>=session.request.maxSteps?'XTB_STEP_LIMIT':'XTB_RESULT_REJECTED',message:String(error.message).slice(0,8192)},...(session.lastReliableFrame??{}),exit:{code,signal}});}
    finally{
      await closeTrace(session.trace);
      await closeLogs(session);
      // Dedicated batch handoff owns final coordinates; process trajectories are
      // not retained as display caches. Do not release the lease or clean native
      // evidence until the canonical result has durably committed.
      if(session.batchSink){
        try{
          assert(session.batchTerminal,'Batch xTB terminal handoff missing');
          const receipt=await session.batchSink(session.batchTerminal);
          if(receipt?.discardDiagnostics===true){
            if(session.job)try{
              const marker=path.join(session.job,'.retain-recovery.json'),value=JSON.parse(await readRegular(marker));
              assert(value.schema===1&&value.sessionId===session.sessionId,'Batch recovery marker identity changed');
              await fs.unlink(marker);
            }catch(error){if(error.code!=='ENOENT')throw error;} // eslint-disable-line no-unsafe-finally -- This rethrow is caught by the enclosing handoff catch below; it cannot escape finish's finally.
            session.preserveForRecovery=false;
          }
        }catch(error){
          session.preserveForRecovery=true;
          await preserveDiagnostics(session,{reason:'batch-result-handoff-failed',error:String(error.message),exit:{code,signal}}).catch(()=>{});
          session.rejectClosed(error);
        }
      }
      if(session.job&&!session.preserveForRecovery&&!session.retainOptimizationCache)try{await cleanTaskDirectory(session.job,fs);}catch(error){if(error.code!=='ENOENT'){console.warn('XTB_TASK_CACHE_RETAINED',error.message);if(session.batchSink)session.rejectClosed(error);}}
      // Keep the session occupied through actual close, artifact publication,
      // exact cleanup and the trusted lease release. Late close is idempotent.
      let released=true;if(session.releaseAdmission&&!session.releaseStarted){session.releaseStarted=true;try{await session.releaseAdmission();}catch(error){released=false;session.rejectClosed(error);}}
      if(released){if(sessions.get(session.key)===session)sessions.delete(session.key);session.resolveClosed();}
    }
  }
  function capture(session,stream,chunk){
    if(session.closed)return;const decoder=stream==='stdout'?session.outDecoder:session.errDecoder,text=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));session.outputBytes+=Buffer.byteLength(text);
    try { session.releaseAdmission?.consumeOutput?.(Buffer.byteLength(text)); } catch(error) { stop(session,{code:'XTB_OUTPUT_LIMIT',message:error.message}); return; }
    if(session.outputBytes>(session.outputBudgetBytes??policy.maxOutputBytes)){stop(session,{code:'XTB_OUTPUT_LIMIT',message:'xTB累计输出已达到本次配置上限。'});return;}
    try{session[stream==='stdout'?'scientificStdout':'scientificStderr'].push(text);}catch(error){stop(session,{code:'XTB_OUTPUT_PACKET_LIMIT',message:error.message});return;}
    appendLog(session,stream,text);session.lastOutputMs=now();session[stream]=boundedLog(session[stream],text);
    if(stream==='stdout'&&!session.stopReason&&now()-session.lastProgressAt>=250){session.lastProgressAt=now();nativeProgress(session);}
  }
  async function start(owner,rawRequest,id,beforeStart=()=>{},batchSink){
    assert(batchSink===undefined||typeof batchSink==='function','Trusted batch result sink required');
    assert(!disposed&&Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&typeof beforeStart==='function','Invalid or closed xTB owner');const sessionId=sessionIdentity(id),key=keyFor(owner,sessionId),resourceHints={threads:rawRequest?.threads,memoryBudgetBytes:rawRequest?.memoryBudgetBytes};if(resolveResources)assert(rawRequest?.threads===undefined||Number.isSafeInteger(rawRequest.threads)&&rawRequest.threads>0,'Invalid requested xTB threads');const request=validateStart(resolveResources?{...rawRequest,threads:1}:rawRequest);
    assert(!request.electronicProperties||typeof retainElectronicArtifacts==='function','Managed xTB electronic artifact handoff unavailable');
    const priorClosed = request.optimizationPool ? [...sessions.values()].filter(session=>session.owner===owner&&session.terminal) : [];
    // A batch backfill must acquire its own session identity synchronously.
    // Other terminal candidates may still await canonical persistence; their
    // shared pool grants already prevent execution until actual release.
    // Awaiting them here leaves a cancellable job with no registered identity.
    if (priorClosed.length&&!batchSink) await Promise.all(priorClosed.map(session=>session.closeTask));
    assert(!sessions.has(key),'Duplicate owned xTB session');
    const samePool = session => request.optimizationPool && session.request.optimizationPool
      && request.runIdentity.taskId===session.request.runIdentity.taskId && request.runIdentity.runId===session.request.runIdentity.runId
      && request.optimizationPool.stageId===session.request.optimizationPool.stageId;
    assert(![...sessions.values()].some(session=>session.owner===owner&&!samePool(session))&&!periodicHost.hasOwner(owner),'Only one owned xTB job per window, until actual child close');
    assert(policy.maxSessions===undefined||[...sessions.values()].filter(session=>!session.terminal).length+periodicHost.activeCount()<policy.maxSessions,'xTB configured concurrency limit reached');
    if(isPeriodic(request)){assert(!request.runIdentity,'Advanced xTB tasks require an isolated structure');return periodicHost.start(owner,request,sessionId,beforeStart,resourceHints);}
    const session={key,owner,sessionId,request,batchSink,seq:0,stdout:'',stderr:'',scientificStdout:scientificLog(),scientificStderr:scientificLog(),outputBytes:0,outDecoder:new StringDecoder('utf8'),errDecoder:new StringDecoder('utf8'),lastProgressAt:-Infinity,admissionController:new AbortController()};session.closeTask=new Promise((resolve,reject)=>{session.resolveClosed=resolve;session.rejectClosed=reject;});void session.closeTask.catch(()=>{});sessions.set(key,session);
    if(request.calculation==='optimize')session.trace={parser:createTrajectoryParser(request),decoder:new StringDecoder('utf8'),offset:0,frameCount:0,lastFrameStep:-1};
    try{
      if(resolveResources){session.configuredResources=await new Promise((resolve,reject)=>{const signal=session.admissionController.signal,abort=()=>reject(Error('xTB resource capture cancelled'));if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(resolveResources(owner,{...structuredClone(request),...resourceHints})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});beforeStart();Object.assign(request,validateStart({...request,threads:session.configuredResources.threads}));}
      if(admit&&(request.runIdentity||resolveResources)){const release=await admit(owner,structuredClone({...request,...(request.optimizationPool?{threads:1}:{})}),{signal:session.admissionController.signal,resources:session.configuredResources});assert(typeof release==='function','xTB admission must return a trusted release function');session.releaseAdmission=release;if(session.configuredResources){assert(release.resources&&Number.isSafeInteger(release.resources.memoryBudgetBytes)&&release.resources.memoryBudgetBytes>0,'XTB_RESOURCE_GRANT: Shared actual resource grant unavailable');session.effectiveResources=structuredClone(release.resources);Object.assign(request,validateStart({...request,threads:release.resources.threads}));}if(session.stopReason){await finish(session,null,null);return{sessionId,status:'stopped'};}}
      session.outputBudgetBytes=outputBudget(session.effectiveResources??session.configuredResources,policy.maxOutputBytes);
      session.runtime=await runtimeInput();if(session.stopReason){await finish(session,null,null);return{sessionId,status:'stopped'};}
      await fs.mkdir(jobRoot,{recursive:true});await directory(jobRoot);session.job=await fs.mkdtemp(path.join(jobRoot,'job-'));assert(within(jobRoot,session.job)&&path.dirname(session.job)===path.resolve(jobRoot),'Owned fresh xTB job required');await directory(session.job);
      assert(await absent(path.join(session.job,'gfnff_topo'))&&await absent(path.join(session.job,'NOT_CONVERGED')),'xTB job must be fresh, not a reused topology/restart');
      const inputs=[['input.xyz',xyzInput(request)],...(request.calculation==='optimize'?[['xcontrol.inp',xcontrolInput(request)]]:[])];session.inputEvidence=[];
      for(const [name,text]of inputs){await fs.writeFile(path.join(session.job,name),text,{encoding:'utf8',flag:'wx'});session.inputEvidence.push({name,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});}
      await fs.writeFile(path.join(session.job,'request.json'),JSON.stringify(request)+'\n',{encoding:'utf8',flag:'wx'});
      session.logHandles={};session.logHandles.stdout=await fs.open(path.join(session.job,'stdout.log'),'wx');session.logHandles.stderr=await fs.open(path.join(session.job,'stderr.log'),'wx');
      beforeStart();assert(!disposed&&!session.ownerClosed&&!closedOwners.has(owner),'xTB owner closed during preparation');if(session.stopReason){await finish(session,null,null);return{sessionId,status:'stopped'};}
      const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(?:SystemRoot|WINDIR|SYSTEMDRIVE)$/i.test(name))),PATH:session.runtime.directory,XTBPATH:session.runtime.dataDirectory,HOME:session.job,USERPROFILE:session.job,XDG_CONFIG_HOME:session.job,TEMP:session.job,TMP:session.job,LANG:'C',LC_ALL:'C',OMP_NUM_THREADS:String(request.threads),OMP_MAX_ACTIVE_LEVELS:'1',OMP_DYNAMIC:'FALSE',OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads)};
      session.argv=invocation(request);session.threadEnvironment=Object.fromEntries(['OMP_NUM_THREADS','OMP_MAX_ACTIVE_LEVELS','OMP_DYNAMIC','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'].map(key=>[key,env[key]]));session.startedMs=now();session.startedAt=new Date(session.startedMs).toISOString();await runEvidence(session);
      const child=session.child=spawn(session.runtime.executable,session.argv,{cwd:session.job,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',chunk=>capture(session,'stdout',chunk));child.stderr.on('data',chunk=>capture(session,'stderr',chunk));child.on('error',error=>stop(session,{code:'XTB_SPAWN_FAILED',message:String(error.message).slice(0,8192)}));child.once('close',(code,signal)=>{for(const stream of ['stdout','stderr']){const tail=session[stream==='stdout'?'outDecoder':'errDecoder'].end();session[stream]+=tail;appendLog(session,stream,tail);}void finish(session,code,signal??null);});
      if(request.maxWallTimeSeconds!==undefined){session.wallTimer=later(()=>stop(session,{code:'XTB_WALL_TIMEOUT',message:'xTB optimization exceeded its wall-time budget'}),request.maxWallTimeSeconds*1000);session.wallTimer.unref?.();}emit(session,'started',{status:'running'});scheduleTrajectory(session);scheduleProgress(session);return{sessionId,status:'starting'};
    }catch(error){if(!session.child){session.stopReason??={code:'XTB_START_FAILED',message:String(error.message).slice(0,8192)};await finish(session,null,null);}else stop(session,{code:'XTB_START_FAILED',message:String(error.message).slice(0,8192)});return{sessionId,status:session.stopReason?.code==='XTB_CANCELLED'?'stopped':'error'};}
  }
  function command(owner,id,value){assert(value&&Object.keys(value).length===1&&value.command==='stop','Only xTB stop is supported');if(periodicHost.owns(owner,id))return periodicHost.command(owner,id);const session=sessions.get(keyFor(owner,id));assert(session&&(!session.terminal||session.batchSink),'xTB job is not owned or is no longer active');stop(session);return session.closeTask.then(()=>({sessionId:session.sessionId,status:'stopped'}));}
  function closeOwner(owner){closedOwners.add(owner);periodicHost.closeOwner(owner);for(const session of sessions.values())if(session.owner===owner){session.ownerClosed=true;stop(session,{code:'XTB_OWNER_CLOSED',message:'xTB owner closed'});}closeOptimizationCaches(owner);}
  function dispose(){disposed=true;periodicHost.dispose();for(const session of sessions.values()){session.ownerClosed=true;stop(session,{code:'XTB_DISPOSED',message:'xTB host disposed'});}closeOptimizationCaches();}
  async function releaseOptimizationCaches(owner,sessionIds){await Promise.all(sessionIds.map(id=>sessions.get(keyFor(owner,id))?.closeTask));return optimizationCaches.release(owner,sessionIds);}
  function closeOptimizationCaches(owner){const closing=Promise.all([...sessions.values()].filter(session=>owner===undefined||session.owner===owner).map(session=>session.closeTask)).then(async()=>{for(const item of optimizationCaches.ids(owner))await optimizationCaches.release(item.owner,[item.sessionId]);});cacheCloseTasks.add(closing);closing.catch(error=>console.warn('XTB_OPT_CACHE_RETAINED',error.message)).finally(()=>cacheCloseTasks.delete(closing));}
  // Call after closeOwner/dispose when releasing sources on shutdown. Actual
  // finish includes native close, retained-source handoff and exact job cleanup.
  async function settle(owner){await Promise.all([Promise.all([...sessions.values()].filter(session=>owner===undefined||session.owner===owner).map(session=>session.closeTask)),periodicHost.settle(owner),...cacheCloseTasks]);}
  async function waitForOwnedChildren(owner,timeoutMs=5000){assert(Number.isFinite(timeoutMs)&&timeoutMs>=0&&timeoutMs<=10000,'Invalid xTB close-wait budget');const owned=[...sessions.values()].filter(session=>owner===undefined||session.owner===owner);if(!owned.length)return;let timer;try{await Promise.race([Promise.all(owned.map(session=>session.closeTask)),new Promise((_,reject)=>{timer=later(()=>reject(new Error('XTB_CLOSE_TIMEOUT: actual owned child close not confirmed')),timeoutMs);})]);}finally{clearLater(timer);}}
  function startBatch(owner,request,id,beforeStart,onTerminal){assert(request?.optimizationPool&&request?.runIdentity&&request.calculation==='optimize'&&!request.electronicProperties&&typeof onTerminal==='function','Dedicated isolated batch optimization required');return start(owner,request,id,beforeStart,onTerminal);}
  function waitForSession(owner,id){const session=sessions.get(keyFor(owner,id));return session?session.closeTask:Promise.reject(Error('xTB session is not owned or is no longer registered'));}
  return{start,startBatch,waitForSession,command,closeOwner,dispose,settle,releaseOptimizationCaches,waitForOwnedChildren:async(owner,timeoutMs=5000)=>Promise.all([waitForOwnedChildren(owner,timeoutMs),periodicHost.waitForOwnedChildren(owner,timeoutMs)]),activeCount:()=>sessions.size+periodicHost.activeCount(),workerCount:()=>[...sessions.values()].filter(session=>session.child&&!session.closed).length+periodicHost.workerCount()};
}
module.exports={createXtbHost};
