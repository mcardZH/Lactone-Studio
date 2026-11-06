'use strict';
const { readManagedResult } = require('./analysis-result-wire.cjs');
const {assert,plain,string}=require('./security.cjs');
const fs=require('node:fs/promises');const path=require('node:path');
const {progressIdentity,createMultiwfnProgress,createNativeProgressReader}=require('./multiwfn-progress.cjs');
const GENERATED_POLICY_VERSION='generated-gfn2-prerequisites-20261023-2';
function occupationPrintEvidence(text){
  const entries=[];let mo=false;
  for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
    const section=line.match(/^\s*\[([^\]]+)\]\s*$/);if(section){mo=section[1].toLowerCase()==='mo';continue;}
    if(!mo||!/^\s*Occup\s*=/i.test(line))continue;
    const match=line.match(/^\s*Occup\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][-+]?\d+)?)\s*$/i);
    if(!match){entries.push(null);continue;}
    const token=match[1].replace(/[dD]/,'e'),[mantissa,exponent='0']=token.toLowerCase().split('e'),decimals=(mantissa.split('.')[1]??'').length,value=Number(token),tolerance=.5*10**(Number(exponent)-decimals);
    entries.push(Number.isFinite(value)&&Number.isFinite(tolerance)&&tolerance>0?{value,tolerance}:null);
  }
  return entries;
}
function createGeneratedAnalysisPolicy(session,expectation){
  const orbitals=session.metadata.orbitals,evidence=session.occupationPrintEvidence;
  const density=Number.isSafeInteger(session.metadata.basisCount)&&session.metadata.basisCount>0&&orbitals.length>0&&orbitals.every(o=>Number.isFinite(o.occupation)&&o.occupation>=0&&o.occupation<=2);
  const energies=density&&orbitals.every(o=>Number.isFinite(o.energy));
  const zeroOrTwo=Array.isArray(evidence)&&evidence.length===orbitals.length&&orbitals.length>0&&orbitals.every((o,i)=>{
    const row=evidence[i],ulp=4*Number.EPSILON*Math.max(1,Math.abs(o.occupation));
    return row&&Number.isFinite(o.occupation)&&Math.abs(row.value-o.occupation)<=row.tolerance+ulp&&Math.min(Math.abs(o.occupation),Math.abs(o.occupation-2))<=row.tolerance+ulp;
  });
  return Object.freeze({schema:'sciyue-generated-analysis-policy/v1',policyVersion:GENERATED_POLICY_VERSION,sourceRevision:session.sourceRevision,requestedUhf:expectation.requestedUhf,sourceSpinResolution:'spin-summed',
    chargeMethods:Object.freeze(density?['mulliken','lowdin','adch','hirshfeld','hirshfeld-i','cm5','resp','scpa']:[]),compositionMethods:Object.freeze(density?['mulliken','scpa']:[]),
    bondOrderMethods:Object.freeze(density?(expectation.requestedUhf===0&&zeroOrTwo?['mayer','wiberg-lowdin','mulliken','laplacian','fuzzy']:['laplacian']):[]),
    spinPopulation:false,spinDensity:false,independentAlphaBeta:false,realSpaceMethods:Object.freeze(density?['esp',...(energies?['alie']:[]),'iri','rdg','igmh']:[])});
}
function assertGeneratedAnalysisPolicy(session,request){
  const root=session.sourceRoot??session;if(!root.trustedSourceExpectation)return;
  const policy=root.analysisPolicy;
  assert(plain(policy)&&policy.schema==='sciyue-generated-analysis-policy/v1'&&policy.policyVersion===GENERATED_POLICY_VERSION&&policy.sourceRevision===session.sourceRevision,'GENERATED_ANALYSIS_POLICY: 自产来源的方法适用性身份缺失或已变化');
  const methods={charges:policy.chargeMethods,composition:policy.compositionMethods,'bond-orders':policy.bondOrderMethods};
  assert(Array.isArray(methods[request.kind])&&methods[request.kind].includes(request.method),'GENERATED_ANALYSIS_POLICY: 此自产GFN2来源尚未开放该分析方法');
}
async function unlinkOwned(target){
  const deadline=Date.now()+2000;
  while(true){
    const stat=await fs.lstat(target).catch(()=>null);if(!stat||!stat.isFile()||stat.isSymbolicLink())return;
    try{await fs.unlink(target);return;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||Date.now()>=deadline)return;await new Promise(resolve=>setTimeout(resolve,25));}
  }
}
async function cleanupJob(directory){
  if(!directory)return;
  for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){
    const target=path.join(directory,entry.name);
    if(entry.isFile()&&!entry.isSymbolicLink())await unlinkOwned(target);
    else if(entry.isDirectory()&&!entry.isSymbolicLink()&&entry.name.startsWith('numerical-')){
      for(const file of await fs.readdir(target,{withFileTypes:true}).catch(()=>[])){
        if(file.isFile()&&!file.isSymbolicLink())await unlinkOwned(path.join(target,file.name));
        else if(file.isDirectory()&&!file.isSymbolicLink()&&file.name==='atmrad'){
          const radial=path.join(target,file.name);
          for(const density of await fs.readdir(radial,{withFileTypes:true}).catch(()=>[]))if(density.isFile()&&!density.isSymbolicLink())await unlinkOwned(path.join(radial,density.name));
          await fs.rmdir(radial).catch(()=>{});
        }
      }
      await fs.rmdir(target).catch(()=>{});
    }
  }
  await fs.rmdir(directory).catch(()=>{});
}
function analysisRequest(value,keys) {
  assert(plain(value)&&Object.keys(value).every(k=>['kind','method','orbitalKey','bader'].includes(k)), 'Invalid numerical analysis request');
  const methods={charges:['mulliken','lowdin','adch','hirshfeld','hirshfeld-i','cm5','resp','scpa','bader'],'bond-orders':['mayer','wiberg-lowdin','mulliken','laplacian','fuzzy'],composition:['mulliken','scpa']};
  assert(methods[value.kind]?.includes(value.method),'Unsupported numerical analysis method');
  if(value.kind==='charges'&&value.method==='bader')baderOptions(value.bader);
  else assert(value.bader===undefined,'Bader parameters require Bader charges');
  if(value.kind==='composition')assert(keys.has(value.orbitalKey),'Composition requires an existing source orbital');
  else assert(value.orbitalKey===undefined,'Orbital key is only valid for composition');
  return {...value,...(value.bader===undefined?{}:{bader:{...value.bader}})};
}
function baderOptions(raw){
  assert(raw===undefined||(plain(raw)&&Object.keys(raw).every(k=>['spacingBohr','paddingBohr','integration'].includes(k))),'Invalid Bader options');
  const value={spacingBohr:.1,paddingBohr:6,integration:'mixed-exact',...raw};
  assert(Number.isFinite(value.spacingBohr)&&value.spacingBohr>=.025&&value.spacingBohr<=.5&&Number.isFinite(value.paddingBohr)&&value.paddingBohr>=3&&value.paddingBohr<=20&&value.integration==='mixed-exact','Invalid Bader grid/integration range');
  return value;
}
function baderGridPlan(session,request,threads=1){
  const metadata=session.metadata;assert(metadata.format==='fchk','BADER_SOURCE_SCOPE: 仅全电子非周期 FCHK 的核参考链已实现；Molden/Cube/ECP/周期仍需单独科学接受');
  const atoms=metadata.structure.atoms,config=baderOptions(request.bader),positions=atoms.map(a=>[a.x,a.y,a.z].map(x=>x/.529177210903));
  assert(positions.length>0&&positions.every(p=>p.every(x=>Number.isFinite(x)&&Math.abs(x)<=1e6)),'Invalid Bader source coordinates');
  const originBohr=[0,1,2].map(k=>Math.min(...positions.map(p=>p[k]))-config.paddingBohr),spacingBohr=Array(3).fill(config.spacingBohr);
  const dimensions=[0,1,2].map(k=>Math.ceil((Math.max(...positions.map(p=>p[k]))+config.paddingBohr-originBohr[k])/config.spacingBohr-1e-10)+1),pointCount=dimensions.reduce((a,b)=>a*b,1),paddedPointCount=dimensions.reduce((a,b)=>a*(b+4),1);
  assert(dimensions.every(n=>Number.isSafeInteger(n)&&n>=2)&&Number.isSafeInteger(pointCount*8),'BADER_GRID_BUDGET: 显式网格超过范围，未自动降低精度');
  assert(Number.isSafeInteger(threads)&&threads>0,'Invalid Bader effective thread count');const threadStackBytes=threads*200*1024**2;
  const estimatedMemoryBytes=320*1024**2+metadata.basisCount**2*128+session.sourceBytes*5+paddedPointCount*256+atoms.length*1024**2+threadStackBytes;
  assert(Number.isSafeInteger(estimatedMemoryBytes)&&estimatedMemoryBytes>0,'Invalid Bader memory estimate');
  return {originBohr,spacingBohr,dimensions,pointCount,paddedPointCount,estimatedMemoryBytes,integration:config.integration,paddingBohr:config.paddingBohr,threads,threadStackBytes};
}
function validateBader(value,session,request,expectedResources){
  const info=value.bader,atoms=session.metadata.structure.atoms,finite=n=>Number.isFinite(n),nonnegative=n=>finite(n)&&n>=0,close=(a,b,t=1e-7)=>finite(a)&&finite(b)&&Math.abs(a-b)<=t;
  assert(plain(info)&&info.electronRepresentation==='all-electron'&&info.referenceConvention==='nuclear-charge'&&info.integrationMethod==='mixed-exact'&&info.scientificAcceptance==='pending-native-calibration'&&value.quantity==='net-charge'&&value.spinAvailable===false&&string(value.chargeConvention,1024),'Invalid Bader convention/acceptance provenance');
  assert(Array.isArray(info.basins)&&info.basins.length>=atoms.length&&info.basins.length<=atoms.length*9+32,'Incomplete/excessive Bader basins');
  const symbols='X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
  const grid=expectedResources?.baderGridPlan??baderGridPlan(session,request);
  assert(plain(info.grid)&&['originBohr','spacingBohr','dimensions'].every(k=>Array.isArray(info.grid[k])&&info.grid[k].length===3&&info.grid[k].every((n,i)=>close(n,grid[k][i],1e-9)))&&['pointCount','paddedPointCount','estimatedMemoryBytes','paddingBohr','threads','threadStackBytes'].every(k=>close(info.grid[k],grid[k]))&&info.grid.integration==='mixed-exact','Bader grid/resource provenance changed');
  if(expectedResources)assert(Number.isSafeInteger(info.grid.estimatedMemoryBytes)&&info.grid.estimatedMemoryBytes>0,'Invalid Bader memory estimate');
  const ids=new Set(),atomic=new Map();let basinPopulation=0;
  for(const basin of info.basins){
    assert(plain(basin)&&Number.isSafeInteger(basin.basinId)&&basin.basinId>0&&!ids.has(basin.basinId)&&nonnegative(basin.electronPopulation)&&nonnegative(basin.volumeBohr3)&&nonnegative(basin.vdWVolumeBohr3)&&basin.vdWVolumeBohr3<=basin.volumeBohr3+1e-5&&Array.isArray(basin.attractorPositionBohr)&&basin.attractorPositionBohr.length===3&&basin.attractorPositionBohr.every(finite),'Invalid Bader raw basin');ids.add(basin.basinId);basinPopulation+=basin.electronPopulation;
    if(basin.role==='atomic'){
      const i=basin.sourceIndex-1;assert(Number.isInteger(i)&&i>=0&&i<atoms.length&&basin.atomId===atoms[i].id&&!atomic.has(i)&&close(basin.referenceCharge,symbols.indexOf(atoms[i].element))&&basin.referenceCharge>0&&close(basin.netCharge,basin.referenceCharge-basin.electronPopulation)&&basin.mappingEvidence==='native-atom-and-voxel','Invalid Bader atom/basin mapping');atomic.set(i,basin);
      const position=[atoms[i].x,atoms[i].y,atoms[i].z].map(x=>x/.529177210903),radius=Math.hypot(...grid.spacingBohr)+1e-7;
      const candidates=atoms.filter(a=>Math.hypot(...[a.x,a.y,a.z].map((x,k)=>x/.529177210903-basin.attractorPositionBohr[k]))<=radius);
      assert(candidates.length===1&&Math.hypot(...position.map((x,k)=>x-basin.attractorPositionBohr[k]))<=radius,'Ambiguous Bader nuclear grid neighborhood');
    }else assert(basin.role==='non-nuclear'&&basin.atomId===undefined&&basin.sourceIndex===undefined&&basin.referenceCharge===0&&close(basin.netCharge,-basin.electronPopulation)&&basin.mappingEvidence==='native-nna-and-nonnuclear-position'&&atoms.every(a=>Math.hypot(...[a.x,a.y,a.z].map((x,k)=>x/.529177210903-basin.attractorPositionBohr[k]))>Math.hypot(...grid.spacingBohr)+1e-7),'Invalid non-nuclear Bader basin');
  }
  assert(atomic.size===atoms.length,'Missing atomic Bader basin');
  value.atoms.forEach((row,i)=>{const basin=atomic.get(i);assert(nonnegative(row.electronPopulation)&&close(row.referenceCharge,basin.referenceCharge)&&close(row.value,row.referenceCharge-row.electronPopulation)&&close(row.electronPopulation,basin.electronPopulation)&&Array.isArray(row.basinIds)&&row.basinIds.length===1&&row.basinIds[0]===basin.basinId&&row.spinPopulation===undefined,'Bader population/reference/net-charge identity failed');});
  for(const r of [info.unassigned,info.boundary])assert(plain(r)&&Number.isSafeInteger(r.gridCount)&&r.gridCount>=0&&nonnegative(r.electronPopulation)&&['native-integral','explicit-zero-grid-count'].includes(r.evidence)&&(r.gridCount!==0||r.electronPopulation===0)&&(r.evidence!=='explicit-zero-grid-count'||r.gridCount===0),'Unknown/invalid Bader remainder was treated as zero');
  const integrated=basinPopulation+info.unassigned.electronPopulation+info.boundary.electronPopulation,nuclear=value.atoms.reduce((s,a)=>s+a.referenceCharge,0),expected=session.metadata.orbitals?.reduce((s,o)=>s+o.occupation,0);
  assert(finite(expected)&&expected>0&&Number.isSafeInteger(session.metadata.structure.charge)&&close(nuclear-session.metadata.structure.charge,expected)&&close(info.expectedElectronCount,expected)&&close(info.integratedElectronCount,integrated)&&close(info.electronResidual,expected-integrated)&&close(info.chargeIncludingNonAtomicBasins,nuclear-integrated),'Bader raw electron/charge conservation failed');
  assert(finite(info.normalizationFactor)&&info.normalizationFactor>0&&close(info.normalizationFactor,basinPopulation/expected,1e-6)&&Array.isArray(info.nativeNormalizedCharges)&&info.nativeNormalizedCharges.length===atoms.length,'Invalid native Bader normalization evidence');
  info.nativeNormalizedCharges.forEach((row,i)=>assert(plain(row)&&row.sourceIndex===i+1&&close(row.value,value.atoms[i].referenceCharge-value.atoms[i].electronPopulation/(basinPopulation/expected),2e-5),'Bader native normalization direction/mapping changed'));
}
function validateResult(value,session,request,expectedResources,trustedExpectation=(session.sourceRoot??session).trustedSourceExpectation) {
  assert(plain(value)&&value.sessionId===session.sessionId&&value.sourceRevision===session.sourceRevision&&value.kind===request.kind&&value.method===request.method,'Numerical analysis identity changed');
  assert(value.coordinateUnit==='bohr'&&/^[a-f0-9]{64}$/.test(value.geometryIdentity)&&plain(value.parameters),'Invalid numerical analysis geometry/parameter provenance');
  assert(plain(value.backend)&&string(value.backend.name,256)&&string(value.backend.version,256)&&Number.isInteger(value.backend.threads)&&value.backend.threads>=1&&value.backend.threads<=2147483647&&Array.isArray(value.warnings)&&value.warnings.every(v=>string(v,8192)),'Invalid numerical analysis provenance');
  if(expectedResources)assert(plain(value.resources)&&value.backend.threads===expectedResources.threads&&value.resources.settingsRevision===expectedResources.settingsRevision,'Numerical resources changed after planning');
  const expectationFields=['chargeExpectationSource','chargeExpectationArtifactId','chargeExpectationSourceSha256','expectedCharge','requestedUhf','sourceSpinResolution','independentAlphaBeta','representedElectronCount','physicalElectronCount'];
  if(trustedExpectation){
    const expected={chargeExpectationSource:'owned-generated-gfn2-sp',chargeExpectationArtifactId:trustedExpectation.artifactId,chargeExpectationSourceSha256:trustedExpectation.sourceSha256,expectedCharge:trustedExpectation.charge,requestedUhf:trustedExpectation.requestedUhf,sourceSpinResolution:'spin-summed',independentAlphaBeta:false,representedElectronCount:trustedExpectation.representedElectronCount,physicalElectronCount:trustedExpectation.physicalElectronCount};
    assert(trustedExpectation.sourceSha256===session.sourceRevision&&expectationFields.every(k=>value.parameters[k]===expected[k]),'Trusted generated-source expectation provenance changed');
    if(request.kind==='charges')assert(Number.isFinite(value.sum)&&Math.abs(value.sum-trustedExpectation.charge)<=Math.max(.002,session.metadata.structure.atoms.length*2e-6),'TRUSTED_CHARGE_SUM: 原子电荷和不符合已认证受管请求；未归一化或推断有效核参考');
  }else {
    const nativeXtb=value.parameters.sourceRepresentation==='xtb-valence-molden';
    assert(expectationFields.filter(k=>!nativeXtb||!['sourceSpinResolution','independentAlphaBeta'].includes(k)).every(k=>value.parameters[k]===undefined),'Unbound external source claimed a trusted charge expectation');
    if(nativeXtb)assert(value.parameters.sourceSpinResolution==='spin-summed'&&value.parameters.independentAlphaBeta===false&&Number.isFinite(value.parameters.nativeRepresentedElectronCount)&&Math.abs(value.parameters.nativeRepresentedElectronCount-session.metadata.orbitals.reduce((sum,o)=>sum+o.occupation,0))<=1e-6&&Number.isSafeInteger(value.parameters.coreElectronCount)&&value.parameters.coreElectronCount>=0&&value.parameters.nativePhysicalElectronCount===value.parameters.nativeRepresentedElectronCount+value.parameters.coreElectronCount,'Invalid native xTB representation evidence');
  }
  const atoms=session.metadata.structure.atoms;
  if(request.kind==='bond-orders') {
    assert(value.unit==='dimensionless'&&Array.isArray(value.bonds)&&value.bonds.length===atoms.length*(atoms.length-1)/2,'Incomplete bond order result');
    const seen=new Set();for(const b of value.bonds){const i=b.sourceIndex1,j=b.sourceIndex2;assert(Number.isInteger(i)&&Number.isInteger(j)&&i>0&&i<j&&j<=atoms.length&&b.atomId1===atoms[i-1].id&&b.atomId2===atoms[j-1].id&&Number.isFinite(b.value)&&!seen.has(`${i}:${j}`),'Invalid bond order atom mapping/value');seen.add(`${i}:${j}`);}
  } else {
    assert(Array.isArray(value.atoms)&&value.atoms.length===atoms.length&&Number.isFinite(value.sum),'Incomplete numerical atom result');
    value.atoms.forEach((a,i)=>{assert(a.sourceIndex===i+1&&a.atomId===atoms[i].id&&a.element===atoms[i].element&&Number.isFinite(a.value),'Invalid numerical atom mapping/value');assert(a.spinPopulation===undefined||Number.isFinite(a.spinPopulation),'Nonfinite numerical atom spin');});
    assert(Math.abs(value.sum-value.atoms.reduce((sum,a)=>sum+a.value,0))<1e-5,'Numerical atom sum changed');
    if(request.kind==='composition')assert(value.unit==='percent'&&value.orbitalKey===request.orbitalKey&&plain(value.angular)&&['s','p','d','f','other'].every(k=>Number.isFinite(value.angular[k])),'Invalid orbital composition units/angular values');
    else assert(value.unit==='e'&&value.quantity==='net-charge'&&typeof value.spinAvailable==='boolean'&&(!value.spinAvailable||value.atoms.every(a=>Number.isFinite(a.spinPopulation))),'Invalid charge/spin units');
    if(request.kind==='charges'&&request.method==='bader')validateBader(value,session,request,expectedResources);
    if(trustedExpectation&&request.kind==='charges')assert(value.spinAvailable===false&&value.atoms.every(a=>a.spinPopulation===undefined),'SPIN_SUMMED_SOURCE: 该自产Molden不含独立α/β数据，不能发布自旋布居');
  }
  return value;
}
function validateAnalysisEvidence(value,session,request){
  const fields=['schema','sessionId','sourceRevision','kind','method','nativeOutput','files'];
  assert(plain(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(k=>fields.includes(k))&&value.schema==='sciyue-wavefunction-analysis-evidence/v1'&&value.sessionId===session.sessionId&&value.sourceRevision===session.sourceRevision&&value.kind===request.kind&&value.method===request.method,'Analysis evidence identity/schema changed');
  assert(typeof value.nativeOutput==='string'&&Buffer.byteLength(value.nativeOutput,'utf8')<=2*1024**2&&plain(value.files)&&Object.keys(value.files).every(k=>['source.chg','bndmat.txt'].includes(k)&&typeof value.files[k]==='string'&&Buffer.byteLength(value.files[k],'utf8')<=1024**2)&&Buffer.byteLength(JSON.stringify(value),'utf8')<=4*1024**2,'Analysis raw evidence exceeds its exact snapshot limits');
  return value;
}
/** One numeric operation across all sessions, separate from the MO scheduler. */
function createWavefunctionAnalysisRunner({spawn,resolveRuntime,resolveBackend,resolveResources,captureResources,limits={},scheduler,sendProgress=()=>{},onAnalysisEvidence}) {
  assert(onAnalysisEvidence===undefined||typeof onAnalysisEvidence==='function','Internal analysis evidence callback must be a function');
  const jobs=new Map(),queue=[];const policy={timeoutMs:0,...limits};let disposed=false,active=null;
  function startNext(){if(active||disposed)return;const next=queue.shift();if(!next)return;if(next.cancelled){next.start();startNext();return;}active=next;next.start();}
  async function run(session,raw,progressContext) {
    const request=analysisRequest(raw,session.keys);assert(!disposed&&!session.closed,'Analysis source closed');assert(!jobs.has(session.sessionId),'ANALYSIS_BUSY: 此分析实例已有任务');
    assertGeneratedAnalysisPolicy(session,request);
    // Snapshot the immutable root binding before queueing. Late changes cannot
    // alter the scientific expectation for an already-owned operation.
    const trustedExpectation=(session.sourceRoot??session).trustedSourceExpectation??null;
    const id=progressIdentity(progressContext,{sessionId:session.sessionId,sourceId:session.sourceId,sourceRevision:session.sourceRevision,analysisId:session.instanceId,operation:request.kind});
    const job={child:null,cancelled:false,done:null,controller:new AbortController()};job.finished=new Promise(resolve=>{job.finish=resolve;});jobs.set(session.sessionId,job);
    job.progress=createMultiwfnProgress(id,snapshot=>sendProgress(session.owner,snapshot));job.progress.report('queued');let successful=false;
    try {
      assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');
      const ready=new Promise(resolve=>{job.start=resolve;});queue.push(job);startNext();await ready;
      assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');
      if(scheduler)job.lease=await scheduler.acquire({owner:session.owner,key:`analysis:${session.sessionId}`,signal:job.controller.signal});
      assert(!job.cancelled&&!disposed&&!session.closed&&!job.controller.signal.aborted,'ANALYSIS_CANCELLED: 数值分析已取消');
      if(captureResources)job.resourceSnapshot=await new Promise((resolve,reject)=>{
        const signal=job.controller.signal;
        const aborted=()=>{signal.removeEventListener('abort',aborted);reject(Error('ANALYSIS_CANCELLED: 数值分析资源读取已取消'));};
        signal.addEventListener('abort',aborted,{once:true});
        if(signal.aborted){aborted();return;}
        Promise.resolve().then(()=>{
          assert(!signal.aborted&&!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析资源读取已取消');
          return captureResources(session);
        }).then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
      });
      assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');
      job.progress.report('reading');
      job.reservedBytes=64*1024**2+(session.metadata.basisCount??0)**2*64+(session.sourceBytes??0)*5;
      const backend=await resolveBackend();assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');assert(backend.configured&&string(backend.path,4096),'ANALYSIS_BACKEND_MISSING: 请先选择本机 Multiwfn');
      let resources=resolveResources?await resolveResources(session,backend,request,job.resourceSnapshot):null;
      if(job.lease&&resources){const grant=job.lease.budget(resources.memoryBudgetBytes,{domain:'analysis',sessionId:session.sessionId});resources={...resources,nativeMemoryBudgetBytes:Math.min(resources.nativeMemoryBudgetBytes??grant.availableBytes,grant.availableBytes)};}
      assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');job.reservedBytes=resources?.estimatedMemoryBytes??0;
      job.directory=await fs.mkdtemp(path.join(session.directory,'analysis-'));assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消');
      const runtime=resolveRuntime(),args=runtime.args.filter(a=>a!=='--orbitals');args.push('--analysis');
      const resourceEnv=resources?{OMP_NUM_THREADS:String(resources.threads),OPENBLAS_NUM_THREADS:String(resources.threads),MKL_NUM_THREADS:String(resources.threads)}:{};
      const child=job.child=spawn(runtime.executable,args,{cwd:runtime.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,...resourceEnv,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
      job.progress.report('running');const observeProgress=createNativeProgressReader(job.progress.report);
      job.childClosed=new Promise(resolve=>child.once('close',resolve));
      job.done=new Promise((resolve,reject)=>{
        let output='',stderr='',settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
        const timer=policy.timeoutMs>0?setTimeout(()=>{job.cancelled=true;child.kill();},policy.timeoutMs):undefined;timer?.unref?.();
        child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');});
        child.stderr.on('data',chunk=>{observeProgress(chunk);stderr=(stderr+chunk.toString('utf8')).slice(-8192);});
        child.on('error',error=>finish(error));child.stdin.on('error',error=>{job.cancelled=true;child.kill();finish(error);});
        child.on('close',code=>{void(async()=>{try{clearTimeout(timer);job.progress.report('parse');let packet;try{packet=JSON.parse(output);}catch(error){assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消、超时或来源已关闭');throw error;}assert(plain(packet),'Invalid analysis worker packet');
          if(packet.evidence!==undefined){assert(onAnalysisEvidence,'Unrequested raw evidence from worker');const evidence=validateAnalysisEvidence(packet.evidence,session,request),record={...evidence,workerOk:packet.ok===true,workerExitCode:code};assert(Buffer.byteLength(JSON.stringify(record),'utf8')<=4*1024**2,'Analysis evidence including worker status exceeds 4 MiB');await onAnalysisEvidence(record);}
          else if(onAnalysisEvidence&&packet.ok===true)assert(false,'Requested analysis evidence is missing');
          assert(!job.cancelled&&!disposed&&!session.closed,'ANALYSIS_CANCELLED: 数值分析已取消、超时或来源已关闭');assert(packet.ok===true,packet?.error?`${packet.error.code}: ${packet.error.message}`:`Analysis worker exited (${code}): ${stderr}`);assert(code===0,'Numerical analysis worker failed');const result=await readManagedResult(packet.result,job.directory);finish(null,validateResult(result,session,request,resources,trustedExpectation));
        }catch(error){finish(error);}})();});
        child.stdin.end(JSON.stringify({sessionId:session.sessionId,sourceRevision:session.sourceRevision,sourcePath:session.sourcePath,workspacePath:job.directory,executable:backend.path,request,...(trustedExpectation?{trustedSourceExpectation:trustedExpectation}:{}),...(onAnalysisEvidence?{captureEvidence:true}:{}),...(resources?{resources,nativeMemoryBudgetBytes:resources.nativeMemoryBudgetBytes,...(resources.baderGridPlan?{baderGridPlan:resources.baderGridPlan}:{})}:{})})+'\n');
      });
      const result=await job.done;successful=true;return result;
    } finally {try{if(job.childClosed)await job.childClosed;await cleanupJob(job.directory);}finally{job.lease?.release();if(job.cancelled)job.progress.report('stopped',{settlement:job.child?'native-settled':'cancelled-before-start'});else if(successful)job.progress.report('parse',{stageLabel:'等待结果接受',settlement:'native-settled',validated:true});else job.progress.report('failed',{settlement:job.child?'native-settled':'not-started'});if(jobs.get(session.sessionId)===job)jobs.delete(session.sessionId);if(active===job)active=null;job.finish();startNext();}}
  }
  async function cancel(sessionId){const job=jobs.get(sessionId);if(!job)return;job.progress.report('stopping');job.cancelled=true;job.controller.abort();job.start?.();if(job.child)job.child.kill();await job.finished;}
  function dispose(){disposed=true;for(const job of jobs.values()){job.cancelled=true;job.controller.abort();job.start?.();job.child?.kill();}}
  return {run,cancel,dispose,activeCount:()=>jobs.size,reservedMemoryBytes:()=>active?.reservedBytes??0};
}
module.exports={analysisRequest,baderGridPlan,validateResult,createWavefunctionAnalysisRunner,GENERATED_POLICY_VERSION,occupationPrintEvidence,createGeneratedAnalysisPolicy};
