'use strict';
const path=require('node:path');
const nativeFS=require('node:fs/promises');
const {StringDecoder}=require('node:string_decoder');
const {assert,within,boundedJSON}=require('./security.cjs');
const {directoryIdentity,checkDirectory,readChecked}=require('./portable-storage.cjs');
const {sessionIdentity,validateStart,sourceAtomMapping,xyzInput,invocation,parsePoses,outputEvidence}=require('./aiss-security.cjs');

/** One locked native process, Main's shared scientific lease, no new scheduler.
 * Accepted candidates retain their original owned job as scientific provenance. */
function createAissHost({spawn,resolveRuntime,jobRoot,sendToWindow,admit,resolveResources,fs=nativeFS,setTimeout:later=setTimeout,clearTimeout:clearLater=clearTimeout,limits={}}){
  assert(typeof spawn==='function'&&typeof resolveRuntime==='function'&&typeof sendToWindow==='function'&&typeof admit==='function'&&path.isAbsolute(jobRoot),'Trusted aISS host/runtime/admission required');
  const policy={maxSessions:2,stopMs:2000,maxOutputBytes:8*1024*1024,maxStderrBytes:1024*1024,maxArtifactBytes:64*1024*1024,...limits};
  assert(Number.isSafeInteger(policy.maxSessions)&&policy.maxSessions>=1&&policy.maxSessions<=2&&Number.isFinite(policy.stopMs)&&policy.stopMs>=0&&policy.stopMs<=5000&&Number.isSafeInteger(policy.maxOutputBytes)&&policy.maxOutputBytes>=1024&&policy.maxOutputBytes<=8*1024*1024&&Number.isSafeInteger(policy.maxStderrBytes)&&policy.maxStderrBytes>=1024&&policy.maxStderrBytes<=1024*1024&&Number.isSafeInteger(policy.maxArtifactBytes)&&policy.maxArtifactBytes>=1024&&policy.maxArtifactBytes<=64*1024*1024,'Invalid aISS host limits');
  const sessions=new Map(),closedOwners=new Set();let disposed=false,rootIdentity;
  const key=(owner,id)=>`${owner}:${sessionIdentity(id)}`;
  function emit(s,event,extra={}){
    if(s.ownerClosed||s.terminal)return;
    const value={schema:1,sessionId:s.id,stamp:s.request.stamp,runIdentity:s.request.runIdentity,operation:'aiss-docking',method:'gfn2',event,seq:s.seq++,...extra,...(s.effectiveResources?{effectiveResources:s.effectiveResources}:{})};boundedJSON(value);
    if(['completed','search-checkpoint','stopped','error'].includes(event))s.terminal=true;
    try{sendToWindow(s.owner,value);}catch{s.ownerClosed=true;stop(s,'owner-closed');}
  }
  function stop(s,reason='cancelled'){
    if(s.terminal||s.stopReason)return;s.stopReason=reason;s.abort.abort();clearLater(s.wallTimer);
    if(s.child&&!s.nativeClosed){try{s.child.kill();}catch{}s.killTimer=later(()=>{if(!s.nativeClosed)try{s.child.kill('SIGKILL');}catch{}},policy.stopMs);s.killTimer.unref?.();}
  }
  async function runtimeInput(){
    const r=await resolveRuntime();assert(r&&['executable','directory','dataDirectory'].every(name=>typeof r[name]==='string'&&path.isAbsolute(r[name]))&&/^(?:xtb|xtb\.exe)$/i.test(path.basename(r.executable))&&within(r.root??r.directory,r.executable)&&within(r.root??r.directory,r.dataDirectory)&&r.version==='6.7.1pre','Locked aISS 6.7.1pre runtime required');
    await directoryIdentity(r.directory,fs);await directoryIdentity(r.dataDirectory,fs);const stat=await fs.lstat(r.executable);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'aISS executable must be an independent ordinary runtime member');
    try{await fs.lstat(path.join(r.dataDirectory,'.xtbrc'));throw Error('aISS gas calculation cannot inherit a runtime .xtbrc');}catch(error){if(error.code!=='ENOENT')throw error;}return{...r};
  }
  async function job(s){
    const parent=await directoryIdentity(path.dirname(jobRoot),fs);try{await fs.mkdir(jobRoot);}catch(error){if(error.code!=='EEXIST')throw error;}await checkDirectory(path.dirname(jobRoot),parent,fs);
    const current=await directoryIdentity(jobRoot,fs);rootIdentity??=current;await checkDirectory(jobRoot,rootIdentity,fs);s.job=await fs.mkdtemp(path.join(jobRoot,'aiss-'));assert(path.dirname(s.job)===path.resolve(jobRoot)&&within(jobRoot,s.job),'aISS job escaped host ownership');s.jobIdentity=await directoryIdentity(s.job,fs);
    await fs.writeFile(path.join(s.job,'source-a.xyz'),xyzInput(s.request.sources[0]),{encoding:'utf8',flag:'wx'});await fs.writeFile(path.join(s.job,'source-b.xyz'),xyzInput(s.request.sources[1]),{encoding:'utf8',flag:'wx'});await fs.writeFile(path.join(s.job,'request.json'),boundedJSON(s.request)+'\n',{encoding:'utf8',flag:'wx'});
  }
  async function diagnostics(s){
    if(!s.job)return;try{await checkDirectory(s.job,s.jobIdentity,fs);}catch{return;}
    for(const [name,text] of [['stdout.log',s.stdout],['stderr.log',s.stderr]])try{await fs.writeFile(path.join(s.job,name),text,{encoding:'utf8',flag:'wx'});}catch{/* Preserve native identity and the terminal failure even if diagnostics cannot be saved. */}
  }
  async function regular(file){const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Unsafe aISS artifact');return readChecked(file,16*1024*1024,fs);}
  async function inventory(s){
    await checkDirectory(jobRoot,rootIdentity,fs);await checkDirectory(s.job,s.jobIdentity,fs);const names=await fs.readdir(s.job);assert(names.length<=128,'aISS artifact inventory exceeded');let total=0;const artifacts=[];
    for(const name of names.sort()){const location=path.join(s.job,name);assert(path.dirname(location)===s.job,'Unsafe aISS artifact name');const stat=await fs.lstat(location);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&Number.isSafeInteger(stat.size),'Unexpected aISS directory/link retained');total+=stat.size;assert(total<=policy.maxArtifactBytes,'aISS retained artifact byte budget exceeded');const checked=await regular(location);artifacts.push({name,bytes:checked.bytes.length,sha256:checked.sha256});}
    return artifacts;
  }
  function progress(s,line){
    let phase;if(line.includes('Precomputation of electronic porperties'))phase='monomer-precomputation';else if(line.includes('Starting Energy Screening'))phase='screening';else if(line.includes('Starting stack search'))phase='stack-search';else if(line.includes('Starting angular search'))phase='angular-search';else if(line.includes('genetic optimization algorithm'))phase='genetic-search';else if(/^Optimizing \d+ best structures with gfn2\s*$/.test(line.trim()))phase='native-refinement';
    if(phase&&s.phase!==phase&&!s.stopReason){s.phase=phase;emit(s,'progress',{phase,evaluations:null});}
  }
  function capture(s,stream,chunk){
    if(s.nativeClosed)return;const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);s.bytes+=bytes.length;if(stream==='stderr')s.stderrBytes+=bytes.length;
    if(s.bytes>policy.maxOutputBytes||s.stderrBytes>policy.maxStderrBytes){stop(s,'output-limit');return;}
    const text=(stream==='stdout'?s.out:s.err).write(bytes);s[stream]+=text;
    if(stream==='stdout'){s.tail+=text;let at;while((at=s.tail.indexOf('\n'))>=0){const line=s.tail.slice(0,at).replace(/\r$/,'');s.tail=s.tail.slice(at+1);progress(s,line);}if(Buffer.byteLength(s.tail)>8192)stop(s,'output-line-limit');}
  }
  async function finish(s,code,signal){
    if(s.finishing)return;s.finishing=true;s.nativeClosed=true;clearLater(s.wallTimer);clearLater(s.killTimer);
    try{
      await diagnostics(s);
      if(s.stopReason){emit(s,s.stopReason==='cancelled'?'stopped':'error',s.stopReason==='cancelled'?{reason:'cancelled',nativeClosed:true,exit:{code,signal},...(s.job?{diagnosticDirectory:s.job}:{})}:{error:{code:'AISS_HOST_STOPPED',message:s.stopReason},nativeClosed:true,exit:{code,signal},...(s.job?{diagnosticDirectory:s.job}:{})});return;}
      assert(Number.isSafeInteger(code)&&signal===null&&!s.failure,'aISS process did not close naturally');await checkDirectory(s.job,s.jobIdentity,fs);
      for(let index=0;index<2;index++)assert((await regular(path.join(s.job,index?'source-b.xyz':'source-a.xyz'))).bytes.toString('utf8')===xyzInput(s.request.sources[index]),'aISS changed its captured input coordinates');
      if(code!==0){
        const backend=outputEvidence(s.stdout,s.request,s.runtime.version,'search-checkpoint');
        const screened=await regular(path.join(s.job,'structures_after_gen.xyz')),screenedPoses=parsePoses(screened.bytes.toString('utf8'),s.request,'screened');
        const artifacts=await inventory(s);for(const name of ['source-a.xyz','source-b.xyz','request.json','stdout.log','stderr.log','structures_after_gen.xyz'])assert(artifacts.some(file=>file.name===name),'Required aISS checkpoint provenance artifact is missing');
        assert(artifacts.find(file=>file.name==='structures_after_gen.xyz').sha256===screened.sha256,'aISS checkpoint changed after parsing');
        if(s.stopReason){emit(s,s.stopReason==='cancelled'?'stopped':'error',s.stopReason==='cancelled'?{reason:'cancelled',nativeClosed:true,exit:{code,signal},diagnosticDirectory:s.job}:{error:{code:'AISS_HOST_STOPPED',message:s.stopReason},nativeClosed:true,exit:{code,signal},diagnosticDirectory:s.job});return;}
        emit(s,'search-checkpoint',{nativeClosed:true,resultKind:'screened-pose-candidates',disposition:'candidates-ready',requiresUnbiasedOptimization:true,
          searchCheckpoint:{complete:true,completedGenerations:backend.counts.geneticGenerations,artifact:'structures_after_gen.xyz'},
          nativeRefinement:{status:'failed',exit:{code,signal},error:{code:'AISS_NATIVE_REFINEMENT_FAILED',message:'原生精修失败；完整搜索候选已核验，尚未独立优化。'}},
          sourceStamps:s.request.sources.map(source=>source.stamp),sourceAtomMapping:sourceAtomMapping(s.request),screenedPoses,backend,evaluations:null,exit:{code,signal},diagnosticDirectory:s.job,artifacts});return;
      }
      const backend=outputEvidence(s.stdout,s.request,s.runtime.version),screened=await regular(path.join(s.job,'structures_after_gen.xyz')),refined=await regular(path.join(s.job,'final_structures.xyz'));
      const screenedPoses=parsePoses(screened.bytes.toString('utf8'),s.request,'screened'),refinedCandidates=parsePoses(refined.bytes.toString('utf8'),s.request,'refined');
      const artifacts=await inventory(s);for(const name of ['source-a.xyz','source-b.xyz','request.json','stdout.log','stderr.log','structures_after_gen.xyz','final_structures.xyz'])assert(artifacts.some(file=>file.name===name),'Required aISS provenance artifact is missing');
      assert(artifacts.find(file=>file.name==='structures_after_gen.xyz').sha256===screened.sha256&&artifacts.find(file=>file.name==='final_structures.xyz').sha256===refined.sha256,'aISS poses changed after parsing');
      if(s.stopReason){emit(s,'stopped',{reason:'cancelled',nativeClosed:true,exit:{code,signal},diagnosticDirectory:s.job});return;}
      emit(s,'completed',{nativeClosed:true,resultKind:'refined-pose-candidates',optimizationAcceptance:'not-individually-verified',requiresUnbiasedOptimization:true,sourceStamps:s.request.sources.map(source=>source.stamp),sourceAtomMapping:sourceAtomMapping(s.request),screenedPoses,refinedCandidates,backend,evaluations:null,exit:{code,signal},diagnosticDirectory:s.job,artifacts});
    }catch(error){emit(s,'error',{error:{code:'AISS_RESULT_REJECTED',message:String(error.message).slice(0,8192)},nativeClosed:true,exit:{code,signal},...(s.job?{diagnosticDirectory:s.job}:{})});}
    finally{
      let released=true;if(s.release&&!s.released){s.released=true;try{await s.release();}catch(error){released=false;s.reject(error);}}
      if(released){sessions.delete(key(s.owner,s.id));s.resolve();}
    }
  }
  async function start(owner,raw,id,beforeStart=()=>{}){
    assert(!disposed&&Number.isSafeInteger(owner)&&owner>=0&&!closedOwners.has(owner)&&typeof beforeStart==='function','Invalid aISS owner');sessionIdentity(id);assert(![...sessions.values()].some(s=>s.owner===owner)&&sessions.size<policy.maxSessions,'Owned aISS session or finite host slot is busy');
    if(resolveResources)assert(raw?.threads===undefined||Number.isSafeInteger(raw.threads)&&raw.threads>0,'Invalid requested aISS threads');
    const request=validateStart(resolveResources?{...raw,threads:1}:raw),s={owner,id,request,seq:0,stdout:'',stderr:'',tail:'',bytes:0,stderrBytes:0,out:new StringDecoder('utf8'),err:new StringDecoder('utf8'),abort:new AbortController()};s.finished=new Promise((resolve,reject)=>{s.resolve=resolve;s.reject=reject;});void s.finished.catch(()=>{});sessions.set(key(owner,id),s);
    try{
      if(resolveResources){s.configuredResources=await new Promise((resolve,reject)=>{const signal=s.abort.signal,abort=()=>reject(Error('aISS resource capture cancelled'));if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(resolveResources(owner,{...structuredClone(request),threads:raw.threads,memoryBudgetBytes:raw.memoryBudgetBytes})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});beforeStart();Object.assign(request,validateStart({...request,threads:s.configuredResources.threads}));}
      const release=await admit(owner,structuredClone(request),{signal:s.abort.signal,resources:s.configuredResources});assert(typeof release==='function','aISS shared admission must return its release function');s.release=release;
      if(s.configuredResources){assert(release.resources&&Number.isSafeInteger(release.resources.memoryBudgetBytes)&&release.resources.memoryBudgetBytes>0,'AISS_RESOURCE_GRANT: Shared actual resource grant unavailable');s.effectiveResources=structuredClone(release.resources);Object.assign(request,validateStart({...request,threads:release.resources.threads}));}
      if(s.stopReason){await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      s.runtime=await runtimeInput();if(s.stopReason){await finish(s,null,null);return{sessionId:id,status:'stopped'};}await job(s);beforeStart();assert(!disposed&&!s.ownerClosed&&!closedOwners.has(owner),'aISS owner closed during preparation');if(s.stopReason){await finish(s,null,null);return{sessionId:id,status:'stopped'};}
      const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(?:SystemRoot|WINDIR|SYSTEMDRIVE)$/i.test(name))),PATH:s.runtime.directory,XTBPATH:s.runtime.dataDirectory,HOME:s.job,USERPROFILE:s.job,XDG_CONFIG_HOME:s.job,TEMP:s.job,TMP:s.job,LANG:'C',LC_ALL:'C',OMP_NUM_THREADS:String(request.threads),OMP_MAX_ACTIVE_LEVELS:'1',OMP_DYNAMIC:'FALSE',OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads)};
      const child=s.child=spawn(s.runtime.executable,invocation(request),{cwd:s.job,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>capture(s,'stdout',chunk));child.stderr.on('data',chunk=>capture(s,'stderr',chunk));child.once('error',error=>{s.failure=error;stop(s,'spawn-failed');});child.once('close',(code,signal)=>{s.stdout+=s.out.end();s.stderr+=s.err.end();void finish(s,code,signal??null);});
      s.wallTimer=later(()=>stop(s,'walltime-limit'),request.maxWallTimeSeconds*1000);s.wallTimer.unref?.();emit(s,'started',{status:'running'});return{sessionId:id,status:'starting'};
    }catch(error){s.failure=error;if(!s.child){s.stopReason??='start-failed: '+String(error.message).slice(0,4096);await finish(s,null,null);}else stop(s,'start-failed');return{sessionId:id,status:s.stopReason==='cancelled'?'stopped':'error'};}
  }
  function command(owner,id,value){assert(value&&Object.keys(value).length===1&&value.command==='stop','Only aISS stop is supported');const s=sessions.get(key(owner,id));assert(s&&!s.terminal,'aISS session is not owned or active');stop(s);return s.finished.then(()=>({sessionId:id,status:'stopped'}));}
  function closeOwner(owner){closedOwners.add(owner);for(const s of sessions.values())if(s.owner===owner){s.ownerClosed=true;stop(s,'owner-closed');}}
  function dispose(){disposed=true;for(const s of sessions.values()){s.ownerClosed=true;stop(s,'disposed');}}
  async function settle(owner){await Promise.all([...sessions.values()].filter(s=>owner===undefined||s.owner===owner).map(s=>s.finished));}
  return{start,command,closeOwner,dispose,settle,activeCount:()=>sessions.size,workerCount:()=>[...sessions.values()].filter(s=>s.child&&!s.nativeClosed).length};
}
module.exports={createAissHost};
