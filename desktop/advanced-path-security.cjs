'use strict';
const {isDeepStrictEqual:same}=require('node:util');
const {assert,plain,boundedJSON,validateStructure,MAX_FINGERPRINT_BYTES}=require('./security.cjs');
const {sessionIdentity,measure}=require('./xtb-security.cjs');
const {cpuResourceSnapshot}=require('./cpu-resources.cjs');
const ELEMENTS='H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' ');
const DEFAULTS=Object.freeze({threads:2,maxSteps:200,maxEvaluations:5000,forceToleranceEVPerAngstrom:.05});
const TERMINAL=new Set(['completed','stopped','error']);
const finite=(x,min=-1e12,max=1e12)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
function keys(value,allowed){assert(plain(value)&&Object.keys(value).every(k=>allowed.includes(k)),'Unknown or invalid advanced path field');}
function coordinate(row,ids){keys(row,['id','objectId','type','atomIds','action','value','source','steps','increment']);assert(['B','A','D'].includes(row.type)&&Array.isArray(row.atomIds)&&row.atomIds.length==={B:2,A:3,D:4}[row.type]&&new Set(row.atomIds).size===row.atomIds.length&&row.atomIds.every(id=>ids.has(id)),'Invalid path internal-coordinate identity');}
function structure(value){const ids=validateStructure(value);assert(ids.size>0&&!value.periodicSource&&!value.cell?.pbc.some(Boolean)&&!value.bonds?.some(b=>b.image?.some(Boolean)),'Path operations require a complete isolated structure');for(const a of value.atoms)assert(ELEMENTS.includes(a.element)&&[a.x,a.y,a.z].every(x=>Math.abs(x)<=1e6),'Unsupported path element or coordinate');return ids;}
function scanAxes(scan){return scan.coordinate?[{coordinate:scan.coordinate,start:scan.start,stop:scan.stop,pointCount:scan.pointCount}]:scan.coordinates;}
function scanCount(scan){return scan.combination==='grid'?scan.coordinates.reduce((n,a)=>n*a.pointCount,1):scan.pointCount;}
function scanPoint(scan,point){const axes=scanAxes(scan),grid=scan.combination==='grid',indices=[];let ordinal=point;for(let i=axes.length-1;i>=0;i--){indices[i]=grid?ordinal%axes[i].pointCount:point;if(grid)ordinal=Math.floor(ordinal/axes[i].pointCount);}return{indices,targets:axes.map((a,i)=>({...a.coordinate,value:a.start+(a.stop-a.start)*indices[i]/((grid?a.pointCount:scan.pointCount)-1)}))};}
function validateStart(raw,cpu=cpuResourceSnapshot()){
  boundedJSON(raw);keys(raw,['schema','stamp','runIdentity','operation','structure','method','charge','uhf','frozenAtomIds','constraints','threads','memoryBudgetBytes','maxSteps','maxEvaluations','maxWallTimeSeconds','forceToleranceEVPerAngstrom','calculator','scan','ts','neb']);
  assert(raw.memoryBudgetBytes===undefined||integer(raw.memoryBudgetBytes,1,Number.MAX_SAFE_INTEGER),'Invalid path soft memory budget');
  assert(raw.schema===1&&['scan','ts','ci-neb-ts'].includes(raw.operation)&&['gfn1','gfn2'].includes(raw.method),'Unsupported path operation/method');
  const stamp=raw.stamp;assert(plain(stamp)&&typeof stamp.documentId==='string'&&stamp.documentId.length>0&&integer(stamp.revision,0,Number.MAX_SAFE_INTEGER)&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(k=>typeof stamp[k]==='string'&&Buffer.byteLength(stamp[k])<=MAX_FINGERPRINT_BYTES)&&(stamp.activationEpoch===undefined||integer(stamp.activationEpoch,0,Number.MAX_SAFE_INTEGER)),'Invalid path source stamp');
  keys(raw.runIdentity,['taskId','runId']);sessionIdentity(raw.runIdentity.taskId);sessionIdentity(raw.runIdentity.runId);
  const ids=structure(raw.structure),atoms=raw.structure.atoms;
  assert(integer(raw.charge,-100,100),'Explicit integer charge required');const electrons=atoms.reduce((s,a)=>s+ELEMENTS.indexOf(a.element)+1,0)-raw.charge;
  assert(electrons>0&&integer(raw.uhf,0,electrons)&&(electrons-raw.uhf)%2===0,'Explicit UHF/electron parity required');
  const value={...DEFAULTS,...raw,frozenAtomIds:raw.frozenAtomIds??[],constraints:raw.constraints??[]};
  assert(Array.isArray(value.frozenAtomIds)&&new Set(value.frozenAtomIds).size===value.frozenAtomIds.length&&value.frozenAtomIds.every(id=>ids.has(id))&&value.frozenAtomIds.length<atoms.length,'Invalid or fully fixed path structure');
  assert(integer(value.maxSteps,1,Number.MAX_SAFE_INTEGER)&&integer(value.maxEvaluations,1,Number.MAX_SAFE_INTEGER)&&(value.maxWallTimeSeconds===undefined||finite(value.maxWallTimeSeconds,.01,1800))&&finite(value.forceToleranceEVPerAngstrom,1e-6,1),'Invalid path execution/convergence budget');
  const cores=cpu.logicalCpuCount;assert(integer(cores,1,Number.MAX_SAFE_INTEGER)&&integer(value.threads,1,cores),'Invalid path CPU budget');
  const calc={accuracy:1,maxIterations:250,electronicTemperatureK:300,...raw.calculator};keys(calc,['accuracy','maxIterations','electronicTemperatureK']);assert(finite(calc.accuracy,.001,10)&&integer(calc.maxIterations,1,Number.MAX_SAFE_INTEGER)&&finite(calc.electronicTemperatureK,0,10000),'Invalid electronic settings');value.calculator=calc;
  assert(Array.isArray(value.constraints)&&Number.isSafeInteger(value.constraints.length),'Invalid path constraints');const seen=new Set();
  value.constraints=value.constraints.map(row=>{coordinate(row,ids);assert(row.action==='freeze'&&(row.steps===undefined||row.steps===0||row.steps===1)&&(row.increment===undefined||row.increment===null),'Path constraints must be freezes');const key=row.type+':'+[row.atomIds.join('\0'),[...row.atomIds].reverse().join('\0')].sort()[0];assert(!seen.has(key),'Duplicate path constraint');seen.add(key);const target=row.value??measure(row,atoms);assert(finite(target,row.type==='B'?1e-6:row.type==='A'?1e-4:-180,row.type==='B'?1e6:180),'Invalid constraint target');measure(row,atoms);return {...row,value:target};});
  assert(raw.operation==='scan'||raw.scan===undefined,'Unexpected scan configuration');assert(raw.operation==='ts'||raw.ts===undefined,'Unexpected TS configuration');assert(raw.operation==='ci-neb-ts'||raw.neb===undefined,'Unexpected NEB configuration');
  if(raw.operation==='scan'){
    assert(plain(raw.scan),'Invalid scan configuration');const scan=structuredClone(raw.scan);
    if(scan.coordinate)keys(scan,['coordinate','start','stop','pointCount']);
    else{keys(scan,['coordinates','combination','pointCount']);assert(Array.isArray(scan.coordinates)&&scan.coordinates.length>=1&&scan.coordinates.length<=3,'A scan needs 1-3 coordinates');scan.combination??='synchronous';}
    assert(['synchronous','grid'].includes(scan.combination??'synchronous'),'Invalid scan combination');const grid=scan.combination==='grid';
    assert(grid?scan.pointCount===undefined:integer(scan.pointCount,2,Number.MAX_SAFE_INTEGER),'Invalid synchronous point count');
    for(const axis of scanAxes(scan)){
      keys(axis,['coordinate','start','stop','pointCount']);coordinate(axis.coordinate,ids);const {start,stop}=axis,type=axis.coordinate.type,count=grid?axis.pointCount:scan.pointCount;
      assert(integer(count,2,Number.MAX_SAFE_INTEGER)&&(!grid?axis.pointCount===undefined||axis.pointCount===count:true)&&finite(start,type==='B'?1e-6:type==='A'?1e-4:-100000,type==='B'?1e6:type==='A'?179.9999:100000)&&finite(stop,type==='B'?1e-6:type==='A'?1e-4:-100000,type==='B'?1e6:type==='A'?179.9999:100000)&&start!==stop,'Invalid directed scan range/count');
      const key=type+':'+[axis.coordinate.atomIds.join('\0'),[...axis.coordinate.atomIds].reverse().join('\0')].sort()[0];assert(!seen.has(key),'Duplicate or frozen scanned coordinate');seen.add(key);assert(axis.coordinate.atomIds.some(id=>!value.frozenAtomIds.includes(id)),'Scanned coordinate is fully atom-frozen');
    }assert(Number.isSafeInteger(scanCount(scan)),'Scan grid product exceeds exact integer range');value.scan=scan;
  }else if(raw.operation==='ts'){
    keys(raw.ts,['initialMode']);const mode=raw.ts.initialMode;keys(mode,['kind','vectors','seed']);assert(['vector','estimated'].includes(mode.kind),'Explicit TS initial mode source required');
    if(mode.kind==='estimated')assert(mode.vectors===undefined&&integer(mode.seed,0,4294967295),'A deterministic estimated-mode seed is required');
    else{assert(mode.seed===undefined&&Array.isArray(mode.vectors)&&mode.vectors.length===atoms.length,'Incomplete TS mode vector');let sum=0;mode.vectors.forEach((v,i)=>{keys(v,['atomId','x','y','z']);assert(v.atomId===atoms[i].id&&[v.x,v.y,v.z].every(x=>finite(x,-1e6,1e6)),'TS mode atom order changed');if(value.frozenAtomIds.includes(v.atomId))assert([v.x,v.y,v.z].every(x=>x===0),'Frozen atom has a nonzero initial mode');sum+=v.x*v.x+v.y*v.y+v.z*v.z;});assert(sum>1e-20,'Zero TS mode');}
  }else{
    keys(raw.neb,['product','mapping','imageCount','initialPath','springConstantEVPerAngstrom2','preoptimizeEndpoints','warmupForceToleranceEVPerAngstrom','previewOnly','bpp']);const n={imageCount:7,initialPath:'idpp',springConstantEVPerAngstrom2:.1,preoptimizeEndpoints:false,warmupForceToleranceEVPerAngstrom:.1,previewOnly:false,...raw.neb};
    const productIds=structure(n.product);assert(productIds.size===ids.size&&Array.isArray(n.mapping)&&n.mapping.length===ids.size&&new Set(n.mapping.map(x=>x.reactantAtomId)).size===ids.size&&new Set(n.mapping.map(x=>x.productAtomId)).size===ids.size,'NEB requires a complete bijective stable-ID mapping');
    for(const p of n.mapping){keys(p,['reactantAtomId','productAtomId']);assert(ids.has(p.reactantAtomId)&&productIds.has(p.productAtomId)&&atoms.find(a=>a.id===p.reactantAtomId).element===n.product.atoms.find(a=>a.id===p.productAtomId).element,'NEB mapping element mismatch');}
    assert(integer(n.imageCount,3,Number.MAX_SAFE_INTEGER)&&['linear','idpp','sidpp','xtb-bpp'].includes(n.initialPath)&&finite(n.springConstantEVPerAngstrom2,1e-6,10)&&typeof n.preoptimizeEndpoints==='boolean'&&typeof n.previewOnly==='boolean'&&!(n.previewOnly&&n.preoptimizeEndpoints)&&finite(n.warmupForceToleranceEVPerAngstrom,value.forceToleranceEVPerAngstrom,1),'Invalid NEB settings');
    assert(n.initialPath!=='sidpp'||n.imageCount>=4,'S-IDPP requires at least four images');assert(n.initialPath==='xtb-bpp'||n.bpp===undefined,'BPP settings belong only to xTB-BPP');
    if(n.initialPath==='xtb-bpp'){assert(!n.previewOnly&&!n.preoptimizeEndpoints&&!value.frozenAtomIds.length&&!value.constraints.length,'xTB-BPP requires explicit physical generation; preview/preoptimization/freezes are unsupported');const bpp={npoint:25,anopt:10,kpush:.003,kpull:-.015,ppull:.05,alp:1.2,...n.bpp};keys(bpp,['npoint','anopt','kpush','kpull','ppull','alp']);assert(integer(bpp.npoint,3,200)&&integer(bpp.anopt,1,100)&&finite(bpp.kpush,1e-6,1)&&finite(bpp.kpull,-1,-1e-6)&&finite(bpp.ppull,1e-6,1)&&finite(bpp.alp,.05,10),'Invalid BPP controls');n.bpp=bpp;}
    for(const id of value.frozenAtomIds){const p=n.mapping.find(x=>x.reactantAtomId===id),a=atoms.find(a=>a.id===id),b=n.product.atoms.find(a=>a.id===p.productAtomId);assert(['x','y','z'].every(k=>a[k]===b[k]),'Frozen endpoint coordinates differ');}value.neb=n;
  }
  boundedJSON(value);return structuredClone(value);
}
function validateCoordinates(values,request){const atoms=request.structure.atoms;assert(Array.isArray(values)&&values.length===atoms.length,'Incomplete path frame');for(let i=0;i<atoms.length;i++){const a=atoms[i],v=values[i];assert(v&&v.id===a.id&&v.element===a.element&&[v.x,v.y,v.z].every(x=>finite(x,-1e6,1e6)),'Path frame atom identity/finite geometry changed');if(request.frozenAtomIds.includes(a.id))assert(['x','y','z'].every(k=>a[k]===v[k]),'Path frame moved an atom freeze');}}
function validateFrame(value,request){
  validateCoordinates(value.coordinates,request);assert(typeof value.stageId==='string'&&value.collectionId===value.stageId&&integer(value.frameIndex,0,Number.MAX_SAFE_INTEGER)&&integer(value.iteration,0,request.maxSteps)&&['optimizer','candidate','point-result','initial-path'].includes(value.role),'Invalid path frame stage/role');
  let rows=request.constraints;
  if(request.operation==='scan'){
    assert(integer(value.pointIndex,0,scanCount(request.scan)-1)&&value.stageId===`scan-point-${value.pointIndex}`&&['optimizer','point-result'].includes(value.role),'Scan point/frame stage changed');
    const point=scanPoint(request.scan,value.pointIndex);assert(same(value.gridIndices,point.indices)&&Array.isArray(value.targets)&&value.targets.length===point.targets.length,'Scan grid identity changed');
    point.targets.forEach((target,i)=>{const actual=value.targets[i];assert(actual&&actual.type===target.type&&same(actual.atomIds,target.atomIds)&&finite(actual.target)&&Math.abs(actual.target-target.value)<=8*Number.EPSILON*Math.max(1,Math.abs(target.value)),'Scan target changed');});rows=[...rows,...point.targets];
    if(value.role==='point-result')assert(typeof value.searchConverged==='boolean','Point result needs independent convergence status');
  }else if(request.operation==='ts')assert(value.stageId==='ts-dimer'&&['optimizer','candidate'].includes(value.role),'TS frame stage changed');
  else{
    assert(['initial-path','neb','climbing-neb','neb-ts-dimer','reactant-opt','product-opt'].includes(value.stageId),'Unknown NEB scientific stage');
    const imageStage=['initial-path','neb','climbing-neb'].includes(value.stageId);
    assert(!imageStage||integer(value.imageIndex,0,request.neb.imageCount-1),'NEB image index changed');
    assert(value.role!=='initial-path'||value.stageId==='initial-path','Initial-path role belongs only to initial-path stage');
    assert(!request.neb.previewOnly||value.stageId==='initial-path'&&value.role==='initial-path','Preview emitted physical optimizer frames');
  }
  assert(same(value.units,{coordinates:'angstrom',energy:'eV',forces:'eV/angstrom',curvature:'eV/angstrom^2'})&&Array.isArray(value.constraintResiduals)&&value.constraintResiduals.length===rows.length,'Path units/constraint evidence changed');
  const delta=(a,b,type)=>type==='D'?((a-b+180)%360+360)%360-180:a-b;
  rows.forEach((row,i)=>{const r=value.constraintResiduals[i],actual=measure(row,value.coordinates),tolerance=row.type==='B'?1e-6:1e-4;
    assert(r&&r.type===row.type&&same(r.atomIds,row.atomIds)&&r.unit===(row.type==='B'?'angstrom':'degree')&&finite(r.target)&&Math.abs(r.target-row.value)<=8*Number.EPSILON*Math.max(1,Math.abs(row.value))&&finite(r.actual)&&Math.abs(delta(r.actual,actual,row.type))<1e-8&&finite(r.residual)&&Math.abs(r.residual-delta(actual,r.target,row.type))<1e-8&&Math.abs(r.residual)<=tolerance,'Path constraint target/actual/residual changed');
  });
  if(value.role==='initial-path')assert(value.energyEV===undefined&&value.rawForcesEVPerAngstrom===undefined,'Initial-path geometry cannot claim physical energy/force');
  else assert(finite(value.energyEV,-1e12,1e12)&&finite(value.projectedForceMaxEVPerAngstrom,0,1e12)&&Array.isArray(value.rawForcesEVPerAngstrom)&&value.rawForcesEVPerAngstrom.length===value.coordinates.length&&value.rawForcesEVPerAngstrom.every(v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x,-1e12,1e12))),'Incomplete physical path frame');
  if(value.stageId==='ts-dimer'||value.stageId==='neb-ts-dimer')assert(finite(value.curvatureEVPerAngstrom2,-1e12,1e12)&&plain(value.initialModeSource),'TS frame lacks curvature/mode source');
  if(value.role==='candidate')assert(value.curvatureEVPerAngstrom2<0&&value.projectedForceMaxEVPerAngstrom<=request.forceToleranceEVPerAngstrom,'TS candidate is not search-converged');
}
function validateEvent(value,session){
  assert(plain(value)&&value.schema===1&&value.sessionId===session.id&&same(value.stamp,session.request.stamp)&&same(value.runIdentity,session.request.runIdentity)&&value.operation===session.request.operation&&value.method===session.request.method&&value.seq===session.workerSeq+1,'Path worker identity/sequence changed');
  assert(['stage','frame',...TERMINAL].includes(value.kind),'Unknown path event');
  if(value.kind==='frame')validateFrame(value,session.request);
  if(value.lastFrame!==undefined&&value.lastFrame!==null)validateFrame(value.lastFrame,session.request);
  if(value.kind==='completed'){
    const expected=session.request.operation==='scan'?'scan':session.request.neb?.previewOnly?'initial-path':'ts-candidate';
    assert(value.resultKind===expected&&value.searchConverged===(expected!=='initial-path')&&value.stationaryPointValidation==='not-run'&&value.lastFrame&&integer(value.evaluations,0,session.request.maxEvaluations),'Unverified path completion claim');
    if(expected==='ts-candidate')assert(value.lastFrame.role==='candidate'&&finite(value.curvatureEVPerAngstrom2,-1e12,0)&&value.curvatureEVPerAngstrom2<0&&value.curvatureEVPerAngstrom2===value.lastFrame.curvatureEVPerAngstrom2,'TS candidate lacks matching negative curvature');
    if(expected==='initial-path')assert(value.evaluations===0&&value.backend?.physicalCalculatorCreated===false,'Preview performed physical evaluations');
    if(expected==='scan')assert(Array.isArray(value.points)&&value.points.length===scanCount(session.request.scan)&&value.points.every((p,i)=>p.pointIndex===i&&p.searchConverged===true&&finite(p.energyEV)),'Incomplete converged scan result');
  }
  if(value.kind==='error')assert(plain(value.error)&&typeof value.error.code==='string'&&typeof value.error.message==='string'&&value.error.message.length<=8192,'Invalid path error');
  if(TERMINAL.has(value.kind))assert(value.workerSettled===true,'Worker did not settle');return value;
}
module.exports={DEFAULTS,TERMINAL,sessionIdentity,validateStart,validateEvent,validateCoordinates,scanAxes,scanCount,scanPoint};
