'use strict';
const {isDeepStrictEqual:same}=require('node:util');
const {assert,plain,boundedJSON,validateStructure,MAX_FINGERPRINT_BYTES}=require('./security.cjs');
const {sessionIdentity,SOLVATION_SOLVENTS}=require('./xtb-security.cjs');
const {cpuResourceSnapshot}=require('./cpu-resources.cjs');
const {nativeAlpbSupported,validateNativeSolvationEvidence}=require('./conformer-solvation.cjs');
const ELEMENTS='H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' ');
const METHODS=Object.freeze(['MMFF94','MMFF94s','UFF','gfn0','gfn1','gfn2','gfnff']);
const OPERATIONS=Object.freeze(['md','metadynamics','spherical-md']);
const DEFAULTS=Object.freeze({threads:2,maxSteps:100000,maxEvaluations:200001,maxFrames:2000,seed:731,dtFs:2,frictionPerFs:.01,reportEvery:20,shakeHydrogenBonds:true});
const ANNEAL_DEFAULTS=Object.freeze({lowTemperatureK:0,highTemperatureK:600,cycleDurationFs:10000,cycles:5});
const META_DEFAULTS=Object.freeze({temperatureK:300,durationFs:50000,sampleEveryFs:100,depositEveryFs:100,heightEV:.01,sigmaAngstrom:.5,maxHistory:1000});
const SPHERE_DEFAULTS=Object.freeze({temperatureK:300,durationFs:50000,sampleEveryFs:100});
const MD_DEFAULTS=Object.freeze({temperatureK:600,durationFs:50000,sampleEveryFs:100});
const TERMINAL=new Set(['completed','stopped','error']);
const finite=(v,lo=-1e12,hi=1e12)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
const integer=(v,lo,hi)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi;
function keys(value,allowed){assert(plain(value)&&Object.keys(value).every(k=>allowed.includes(k)),'Unknown or invalid sampling field');}
function validateInitialVelocityCorrection(value){
  if(value==null)return;
  keys(value,['algorithm','initialization','triggered','degreesOfFreedom','hydrogenCount','beforeKineticEnergyHartree','afterKineticEnergyHartree','beforeTemperatureK','afterTemperatureK','hydrogenScale','hydrogenKineticEnergyHartree','nonHydrogenKineticEnergyHartree','ceilingTemperatureK','sourceArtifact']);
  assert(value.algorithm==='xtb-h-only-initial-cap-v1'&&value.initialization==='automatic'&&typeof value.triggered==='boolean'&&integer(value.degreesOfFreedom,1,Number.MAX_SAFE_INTEGER)&&integer(value.hydrogenCount,0,Number.MAX_SAFE_INTEGER)&&value.ceilingTemperatureK===8000&&value.sourceArtifact==='stdout.txt','Invalid native initial-velocity source');
  for(const key of ['beforeKineticEnergyHartree','afterKineticEnergyHartree','beforeTemperatureK','afterTemperatureK','hydrogenKineticEnergyHartree','nonHydrogenKineticEnergyHartree'])assert(finite(value[key],0),'Invalid native initial-velocity value');
  assert(finite(value.hydrogenScale,0,1),'Invalid native hydrogen velocity scale');
  const near=(a,b)=>Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b));
  assert(near(value.beforeKineticEnergyHartree,value.hydrogenKineticEnergyHartree+value.nonHydrogenKineticEnergyHartree),'Initial kinetic-energy components disagree');
  assert(value.triggered===(value.beforeTemperatureK>8000),'Initial velocity correction trigger disagrees');
  if(value.triggered){
    assert(value.hydrogenCount>0&&value.hydrogenKineticEnergyHartree>0&&value.hydrogenScale<1&&near(value.afterTemperatureK,8000),'Invalid triggered initial velocity correction');
    assert(near(value.afterKineticEnergyHartree,value.nonHydrogenKineticEnergyHartree+value.hydrogenKineticEnergyHartree*value.hydrogenScale**2),'Hydrogen-only kinetic-energy correction disagrees');
  }else assert(value.hydrogenScale===1&&value.beforeKineticEnergyHartree===value.afterKineticEnergyHartree&&value.beforeTemperatureK===value.afterTemperatureK,'Untriggered initial velocities changed');
  if(value.beforeKineticEnergyHartree>0)assert(near(value.afterTemperatureK,value.beforeTemperatureK*value.afterKineticEnergyHartree/value.beforeKineticEnergyHartree),'Initial temperature and kinetic energy disagree');
}
function steps(value,dt,zero=false){assert(finite(value,zero?0:dt,Number.MAX_SAFE_INTEGER),'Invalid sampling duration');const n=Math.round(value/dt);assert(Math.abs(n*dt-value)<=1e-9,'Duration must be an integer multiple of the MD timestep');return n;}
function selected(values,ids,min=1){return Array.isArray(values)&&values.length>=min&&new Set(values).size===values.length&&values.every(id=>ids.has(id));}
function samplingSegmentFields(request,step){
  if(request.segment===undefined)return{};
  const fields={segment:structuredClone(request.segment),velocityInitialization:'fresh',biasInitialization:request.operation==='metadynamics'?'fresh':'not-applicable'};
  if(step!==undefined){assert(Number.isSafeInteger(step)&&step>=0&&Number.isSafeInteger(request.segment.completedStepsBefore+step),'Invalid complete sampling segment step');Object.assign(fields,{localStep:step,localTimeFs:step*request.dtFs,cumulativeStep:request.segment.completedStepsBefore+step,cumulativeTimeFs:(request.segment.completedStepsBefore+step)*request.dtFs});}
  return fields;
}
function validateSegmentProgress(value,request){
  const expected=samplingSegmentFields(request,value.step);
  for(const key of ['segment','velocityInitialization','biasInitialization','localStep','localTimeFs','cumulativeStep','cumulativeTimeFs'])assert(same(value[key],expected[key]),'Sampling segment/source progress differs from its fresh-run request');
}
function annealingSegments(a){const lo=a.lowTemperatureK,hi=a.highTemperatureK;return a.cycleDurationFs===undefined?[['heating',a.heatingFs,lo,hi],['high-hold',a.highHoldFs,hi,hi],['cooling',a.coolingFs,hi,lo],['low-hold',a.lowHoldFs,lo,lo]]:[['heating',a.cycleDurationFs*.1,lo,hi],['high-hold',a.cycleDurationFs*.7,hi,hi],['cooling',a.cycleDurationFs*.2,hi,lo]];}
function samplingDriver(request){if(['md','metadynamics'].includes(request.operation)&&['gfnff','gfn0','gfn1','gfn2'].includes(request.method))return{driver:'native-xtb-md',reason:request.operation==='metadynamics'?'native-rmsd-metadynamics':'native-ordinary-md'};return{driver:'ase-langevin',reason:'ase-forcefield-or-temperature-bias-route'};}
function requiresXtbRuntime(request){return samplingDriver(request).driver==='native-xtb-md'||['gfnff','gfn0'].includes(request.method);}
function validateStart(raw,cpu=cpuResourceSnapshot()){
  boundedJSON(raw);keys(raw,['schema','stamp','runIdentity','segment','operation','structure','method','charge','uhf','frozenAtomIds','constraints','calculator','solvation','annealing','metadynamics','molecularMD','sphericalMD','sphere','coreProtection','nativeProtection','memoryBudgetBytes','driver','driverReason','hydrogenMassAmu','maxWallTimeSeconds',...Object.keys(DEFAULTS)]);
  assert(raw.schema===1&&OPERATIONS.includes(raw.operation)&&METHODS.includes(raw.method),'Unsupported sampling operation/method');
  if(raw.segment!==undefined){keys(raw.segment,['id','previousSegmentId','completedStepsBefore']);assert(['md','metadynamics'].includes(raw.operation),'Fresh continuation segments belong only to MD/MTD');sessionIdentity(raw.segment.id);if(raw.segment.previousSegmentId!==undefined){sessionIdentity(raw.segment.previousSegmentId);assert(raw.segment.previousSegmentId!==raw.segment.id,'Sampling segment cannot be its own predecessor');}assert(integer(raw.segment.completedStepsBefore,0,Number.MAX_SAFE_INTEGER),'Invalid previously completed integration steps');}
  const stamp=raw.stamp;keys(stamp,['documentId','revision','activationEpoch','graphFingerprint','coordinatesFingerprint','constraintsFingerprint']);
  assert(typeof stamp.documentId==='string'&&stamp.documentId.length>0&&integer(stamp.revision,0,Number.MAX_SAFE_INTEGER)&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(k=>typeof stamp[k]==='string'&&Buffer.byteLength(stamp[k])<=MAX_FINGERPRINT_BYTES)&&(stamp.activationEpoch===undefined||integer(stamp.activationEpoch,0,Number.MAX_SAFE_INTEGER)),'Invalid sampling source stamp');
  keys(raw.runIdentity,['taskId','runId']);sessionIdentity(raw.runIdentity.taskId);sessionIdentity(raw.runIdentity.runId);
  const ids=validateStructure(raw.structure),atoms=raw.structure.atoms;
  assert(ids.size>0&&(raw.structure.dimension??3)===3&&!raw.structure.periodicSource&&!raw.structure.cell?.pbc.some(Boolean)&&!raw.structure.bonds?.some(b=>b.image?.some(Boolean)),'Sampling requires an isolated three-dimensional structure');
  assert(atoms.every(a=>ELEMENTS.includes(a.element)&&integer(a.formalCharge??0,-100,100)&&[a.x,a.y,a.z].every(v=>finite(v,-1e6,1e6))),'Invalid sampling atom');
  assert(integer(raw.charge,-100,100),'Explicit integer sampling charge required');const electrons=atoms.reduce((s,a)=>s+ELEMENTS.indexOf(a.element)+1,0)-raw.charge;
  assert(electrons>0&&integer(raw.uhf,0,electrons)&&(electrons-raw.uhf)%2===0,'Sampling UHF/electron parity mismatch');
  if(raw.method==='gfnff')assert(raw.uhf===0,'GFN-FF has no spin Hamiltonian');
  assert((raw.structure.charge===undefined||raw.structure.charge===raw.charge)&&(raw.structure.multiplicity===undefined||raw.structure.multiplicity===raw.uhf+1),'Source charge/multiplicity differ from sampling request');
  if(raw.operation==='spherical-md'){const neighbours=atoms.map(()=>new Set());for(const b of raw.structure.bonds??[]){neighbours[b.a].add(b.b);neighbours[b.b].add(b.a);}const pending=new Set(atoms.map((_,i)=>i));let fragments=0;while(pending.size){fragments++;const first=pending.values().next().value;pending.delete(first);const stack=[first];while(stack.length)for(const i of neighbours[stack.pop()])if(pending.delete(i))stack.push(i);}assert(fragments>=2,'Spherical multi-molecule sampling requires at least two connected components');}
  const value={...DEFAULTS,...structuredClone(raw),frozenAtomIds:raw.frozenAtomIds??[],constraints:raw.constraints??[]};
  if(value.method==='gfnff'&&raw.shakeHydrogenBonds===undefined)value.shakeHydrogenBonds=false;
  const ordinaryNative=samplingDriver(value).driver==='native-xtb-md';
  assert(value.hydrogenMassAmu===undefined||(value.hydrogenMassAmu===4&&value.method==='gfnff'),'Fixed hydrogen mass is supported only as 4 amu for GFN-FF sampling');
  if(ordinaryNative&&value.method==='gfnff'){if(raw.shakeHydrogenBonds===undefined)value.shakeHydrogenBonds=false;assert(value.shakeHydrogenBonds===false,'Locked native GFN-FF MD does not apply SHAKE; explicitly enable only a supported method');}
  if(ordinaryNative)assert(value.coreProtection===undefined&&value.sphere===undefined&&value.frozenAtomIds.length===0,'Ordinary xTB MD stays native; core/sphere/XYZ protection requires an explicitly supported native definition');
  if(value.nativeProtection!==undefined){
    assert(ordinaryNative,'Native protection belongs only to ordinary native xTB MD');const p=value.nativeProtection;keys(p,['core','sphere']);assert(p.core!==undefined||p.sphere!==undefined,'Empty native protection is not a scientific definition');
    if(p.core!==undefined){const c=p.core;keys(c,['kind','atomIds','forceConstantEVPerAngstrom2']);assert(c.kind==='pairwise-distance'&&selected(c.atomIds,ids,2)&&finite(c.forceConstantEVPerAngstrom2,1e-6,6000),'Invalid native pairwise-distance core definition');}
    if(p.sphere!==undefined){const s=p.sphere;keys(s,['kind','centerAngstrom','radiusAngstrom','exponent']);assert(s.kind==='polynomial'&&s.exponent===30&&Array.isArray(s.centerAngstrom)&&s.centerAngstrom.length===3&&s.centerAngstrom.every(v=>finite(v,-1e6,1e6))&&finite(s.radiusAngstrom,.01,10000),'Invalid native polynomial sphere definition');}
  }
  assert(Array.isArray(value.frozenAtomIds)&&new Set(value.frozenAtomIds).size===value.frozenAtomIds.length&&value.frozenAtomIds.every(id=>ids.has(id))&&value.frozenAtomIds.length<atoms.length,'Invalid or fully frozen sampling atoms');
  assert(Array.isArray(value.constraints)&&value.constraints.length===0,'Internal-coordinate momentum constraints are not validated for sampling');
  assert(typeof value.shakeHydrogenBonds==='boolean'&&(value.memoryBudgetBytes===undefined||integer(value.memoryBudgetBytes,1,Number.MAX_SAFE_INTEGER)),'Invalid SHAKE/host memory budget');
  if(value.shakeHydrogenBonds){const fixed=new Set(value.frozenAtomIds),pairs=(value.structure.bonds??[]).filter(b=>atoms[b.a].element==='H'||atoms[b.b].element==='H');assert(pairs.every(b=>Math.hypot(atoms[b.a].x-atoms[b.b].x,atoms[b.a].y-atoms[b.b].y,atoms[b.a].z-atoms[b.b].z)>1e-8),'SHAKE requires nonzero source X-H bond lengths');assert(3*(atoms.length-fixed.size)>pairs.filter(b=>!fixed.has(atoms[b.a].id)||!fixed.has(atoms[b.b].id)).length,'SHAKE leaves no free physical degrees of freedom');}
  assert(integer(value.seed,0,4294967295)&&integer(value.maxSteps,1,Number.MAX_SAFE_INTEGER)&&integer(value.maxEvaluations,1,Number.MAX_SAFE_INTEGER)&&(value.maxWallTimeSeconds===undefined||finite(value.maxWallTimeSeconds,.01,7200))&&integer(value.maxFrames,1,Number.MAX_SAFE_INTEGER)&&integer(value.reportEvery,1,Number.MAX_SAFE_INTEGER)&&finite(value.dtFs,.01,2)&&finite(value.frictionPerFs,1e-6,1),'Invalid sampling integration/resource budget');
  const cores=cpu.logicalCpuCount;assert(integer(cores,1,Number.MAX_SAFE_INTEGER)&&integer(value.threads,1,cores),'Invalid sampling CPU budget');
  const calc={accuracy:1,maxIterations:250,electronicTemperatureK:300,...raw.calculator};keys(calc,['accuracy','maxIterations','electronicTemperatureK']);
  assert(finite(calc.accuracy,.001,10)&&integer(calc.maxIterations,1,2000)&&finite(calc.electronicTemperatureK,0,10000),'Invalid sampling calculator settings');value.calculator=calc;
  if(value.solvation!==undefined){const sol=value.solvation;keys(sol,['model','solvent']);assert(ordinaryNative&&sol.model==='alpb'?nativeAlpbSupported(value.method,value.operation,sol.solvent):['gfn1','gfn2'].includes(value.method)&&SOLVATION_SOLVENTS[sol.model]?.[value.method]?.includes(sol.solvent),'Unsupported sampling solvation model/solvent');}
  if(['MMFF94','MMFF94s','UFF'].includes(value.method))assert(atoms.reduce((s,a)=>s+(a.formalCharge??0),0)===value.charge,'Force-field formal charges differ from total charge');
  if(value.coreProtection!==undefined){const c=value.coreProtection;keys(c,['atomIds','forceConstantEVPerAngstrom2']);assert(selected(c.atomIds,ids),'Invalid protected core identity');c.forceConstantEVPerAngstrom2??=10;assert(finite(c.forceConstantEVPerAngstrom2,1e-6,1000),'Invalid core protection strength');}
  const op=value.operation,dt=value.dtFs;
  for(const [operation,field] of [['md','molecularMD'],['anneal','annealing'],['metadynamics','metadynamics'],['spherical-md','sphericalMD']])assert(op===operation||raw[field]===undefined,'Configuration belongs to another sampling route');
  let requiredFrames;
  if(op==='anneal'){
    const legacy=['heatingFs','highHoldFs','coolingFs','lowHoldFs'],rawAnneal=value.annealing??{};keys(rawAnneal,[...Object.keys(ANNEAL_DEFAULTS),...legacy]);const hasLegacy=legacy.some(k=>rawAnneal[k]!==undefined);assert(!hasLegacy||rawAnneal.cycleDurationFs===undefined,'Do not combine canonical and legacy annealing schedules');
    const defaults=hasLegacy?{lowTemperatureK:0,highTemperatureK:600,cycles:5,heatingFs:100,highHoldFs:100,coolingFs:100,lowHoldFs:100}:ANNEAL_DEFAULTS,a={...defaults,...rawAnneal};assert(finite(a.lowTemperatureK,0,5000)&&finite(a.highTemperatureK,a.lowTemperatureK,5000)&&integer(a.cycles,1,1000),'Invalid annealing settings');
    assert(hasLegacy||finite(a.cycleDurationFs,dt,Number.MAX_SAFE_INTEGER),'Invalid annealing cycle duration');
    const total=annealingSegments(a).reduce((n,[name,duration])=>n+steps(duration,dt,hasLegacy&&name.includes('hold')),0)*a.cycles;assert(total<=value.maxSteps,'Annealing exceeds step budget');requiredFrames=Math.floor(total/value.reportEvery)+a.cycles;value.annealing=a;
  }else{
    const field=op==='metadynamics'?'metadynamics':op==='md'?'molecularMD':'sphericalMD',defaults=op==='metadynamics'?META_DEFAULTS:op==='md'?MD_DEFAULTS:SPHERE_DEFAULTS,a={...defaults,...value[field]};keys(a,[...Object.keys(defaults),...(op==='metadynamics'?['atomIds']:[])]);
    assert(finite(a.temperatureK,.01,5000),'Invalid sampling temperature');const n=steps(a.durationFs,dt),interval=steps(a.sampleEveryFs,dt);assert(n<=value.maxSteps,'Sampling duration exceeds step budget');
    if(value.segment)assert(Number.isSafeInteger(value.segment.completedStepsBefore+n),'Cumulative sampling segment steps exceed integer representation');
    function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}const reports=value.reportEvery,overlap=Math.floor(n/(interval*reports/gcd(interval,reports)))+Number(n%reports===0&&n%interval!==0);requiredFrames=Math.ceil(n/interval)+Math.floor(n/reports)-overlap;
    if(op==='metadynamics'){a.atomIds??=atoms.map(a=>a.id);assert(selected(a.atomIds,ids,2)&&finite(a.heightEV,1e-8,10)&&finite(a.sigmaAngstrom,1e-4,10)&&integer(a.maxHistory,1,Number.MAX_SAFE_INTEGER)&&Math.floor((n-(ordinaryNative?1:0))/steps(a.depositEveryFs,dt))+1<=a.maxHistory,'Invalid RMSD bias or complete history budget');}value[field]=a;
  }
  assert(op!=='spherical-md'||value.sphere!==undefined,'Legacy spherical MD requires an explicit sphere');
  if(value.sphere!==undefined){const s=value.sphere;keys(s,['centerAngstrom','radiusAngstrom','forceConstantEVPerAngstrom2']);s.forceConstantEVPerAngstrom2??=1;assert(Array.isArray(s.centerAngstrom)&&s.centerAngstrom.length===3&&s.centerAngstrom.every(v=>finite(v,-1e6,1e6))&&finite(s.radiusAngstrom,.01,1e6)&&finite(s.forceConstantEVPerAngstrom2,1e-6,1000),'Invalid explicit sampling sphere');}
  assert(requiredFrames<=value.maxFrames,'Configured sampling exceeds retained frame budget');
  const selection=samplingDriver(value);assert((value.driver===undefined||value.driver===selection.driver)&&(value.driverReason===undefined||value.driverReason===selection.reason),'Sampling driver differs from the actual capability route');value.driver=selection.driver;value.driverReason=selection.reason;
  if(value.driver==='native-xtb-md')assert(value.maxEvaluations>=steps((value.operation==='metadynamics'?value.metadynamics:value.molecularMD).durationFs,dt)+2,'Native MD requires the locked N+2 upper-bound energy/gradient budget (actual count is not reported)');
  boundedJSON(value);return structuredClone(value);
}
function validateCoordinates(values,request){const atoms=request.structure.atoms;assert(Array.isArray(values)&&values.length===atoms.length,'Incomplete sampling frame');for(let i=0;i<atoms.length;i++){const a=atoms[i],b=values[i];assert(b&&a.id===b.id&&a.element===b.element&&[b.x,b.y,b.z].every(v=>finite(v,-1e6,1e6))&&(a.formalCharge??0)===(b.formalCharge??0),'Sampling atom/charge identity changed');if(request.frozenAtomIds.includes(a.id))assert(['x','y','z'].every(k=>a[k]===b[k]),'Sampling moved an XYZ freeze');}}
function validateNativeProtectionEvidence(evidence,request){
  const wanted=request.nativeProtection;if(!wanted&&evidence===undefined)return;
  keys(evidence,['core','sphere','coordinateTransform']);const near=(a,b)=>finite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),bohr=.529177210903,hartree=27.211386024367243,atoms=request.structure.atoms;
  if(wanted?.core){const c=evidence.core,w=wanted.core,indices=w.atomIds.map(id=>atoms.findIndex(a=>a.id===id)+1);assert(plain(c)&&c.kind==='pairwise-distance'&&same(c.atomIds,w.atomIds)&&same(c.nativeAtomIndices,indices)&&c.forceConstantEVPerAngstrom2===w.forceConstantEVPerAngstrom2&&near(c.inputForceConstantHartreePerBohr2,w.forceConstantEVPerAngstrom2*bohr*bohr/hartree)&&near(c.actualPairForceConstantEVPerAngstrom2,w.forceConstantEVPerAngstrom2/(indices.length-1))&&Array.isArray(c.pairs)&&c.pairs.length===indices.length*(indices.length-1)/2,'Native core actual force constant, atom mapping or pair count differs');let index=0;for(let i=0;i<indices.length;i++)for(let j=0;j<i;j++){const p=c.pairs[index++],a=atoms[indices[i]-1],b=atoms[indices[j]-1];assert(p&&same(p.atomIds,[w.atomIds[i],w.atomIds[j]])&&same(p.nativeAtomIndices,[indices[i],indices[j]])&&near(p.referenceDistanceAngstrom,Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)),'Native core reference pair does not match the source');}}
  else assert(evidence.core===null,'Unexpected native core protection');
  if(wanted?.sphere){const s=evidence.sphere,w=wanted.sphere;assert(plain(s)&&s.kind==='polynomial'&&same(s.centerAngstrom,w.centerAngstrom)&&s.radiusAngstrom===w.radiusAngstrom&&s.exponent===30&&Array.isArray(s.nativeCenterBohr)&&s.nativeCenterBohr.every(v=>v===0)&&s.nativeCenterBohr.length===3&&near(s.nativeRadiusBohr,w.radiusAngstrom/bohr)&&s.energyScaleHartree===1&&s.appliesTo==='all-atoms','Native polynomial sphere definition changed');}
  else assert(evidence.sphere===null,'Unexpected native sphere protection');
  const offset=wanted?.sphere?wanted.sphere.centerAngstrom.map(v=>-v):[0,0,0],transform=evidence.coordinateTransform;assert(plain(transform)&&transform.kind===(wanted?.sphere?'translation':'identity')&&Array.isArray(transform.offsetAngstrom)&&transform.offsetAngstrom.length===3&&transform.offsetAngstrom.every((v,i)=>v===offset[i]),'Native source-coordinate transformation changed');
}
function validateFrame(value,request){
  validateSegmentProgress(value,request);
  const native=request.driver==='native-xtb-md';assert((value.driver??'ase-langevin')===(request.driver??'ase-langevin'),'Sampling frame driver changed');
  if(native&&request.operation==='metadynamics'){
    const m=request.metadynamics,e=value.nativeMD?.metadynamics,near=(a,b)=>finite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
    assert(plain(e)&&same(e.atomIds,m.atomIds)&&same(e.nativeAtomIndices,m.atomIds.map(id=>request.structure.atoms.findIndex(a=>a.id===id)+1))
      &&e.heightEV===m.heightEV&&e.sigmaAngstrom===m.sigmaAngstrom&&e.depositEveryFs===m.depositEveryFs&&e.maxHistory===m.maxHistory
      &&e.depositSteps===steps(m.depositEveryFs,request.dtFs)&&near(e.factorHartree,m.heightEV/27.211386024367243)
      &&near(e.alphaInverseBohr2,.529177210903**2/(2*m.sigmaAngstrom**2))&&e.scoordFs===(e.depositSteps-1)*request.dtFs
      &&e.rampPerStep===.03&&e.initialReference==='explicit-input-geometry'&&e.historyPolicy==='complete-no-rolling'
      &&e.depositTiming==='pre-step'&&e.instantaneousBiasEnergy==='not-reported'&&value.metaBiasEV===null&&value.physicalEnergyEV===null,
      'Native MTD parameter/identity/energy evidence differs');
  }
  validateCoordinates(value.coordinates,request);assert(['trajectory','sampled-candidate'].includes(value.role)&&integer(value.frameIndex,0,request.maxFrames-1)&&integer(value.step,0,request.maxSteps)&&finite(value.timeFs,0)&&Math.abs(value.timeFs-value.step*request.dtFs)<1e-9,'Invalid sampling frame role/time');
  assert(typeof value.stageId==='string'&&value.stageId.length<=100&&value.collectionId===(value.role==='sampled-candidate'?'sampled-candidates':'sampling-trajectory')&&integer(value.biasHistoryCount,0,request.metadynamics?.maxHistory??0),'Invalid sampling stage/collection/bias identity');
  assert(native&&value.velocitiesAngstromPerFs===null||Array.isArray(value.velocitiesAngstromPerFs)&&value.velocitiesAngstromPerFs.length===request.structure.atoms.length&&value.velocitiesAngstromPerFs.every(v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x))),'Invalid sampled velocities');
  request.structure.atoms.forEach((a,i)=>{if(request.frozenAtomIds.includes(a.id))assert(value.velocitiesAngstromPerFs?.[i].every(v=>v===0),'Frozen atom acquired velocity');});
  for(const field of ['physicalEnergyEV','coreBiasEV','metaBiasEV','sphereBiasEV','sampledPotentialEV','kineticEnergyEV','temperatureK','targetTemperatureK'])assert(native&&['physicalEnergyEV','coreBiasEV','metaBiasEV','sphereBiasEV','sampledPotentialEV','kineticEnergyEV','temperatureK'].includes(field)&&value[field]===null||finite(value[field],field==='physicalEnergyEV'||field==='sampledPotentialEV'?-1e12:0),'Invalid sampled energy/temperature');
  if([value.physicalEnergyEV,value.coreBiasEV,value.metaBiasEV,value.sphereBiasEV,value.sampledPotentialEV].every(v=>v!==null)){const total=value.physicalEnergyEV+value.coreBiasEV+value.metaBiasEV+value.sphereBiasEV;assert(Math.abs(total-value.sampledPotentialEV)<=1e-9*Math.max(1,Math.abs(total)),'Biased and physical energy identities differ');}
  assert(value.optimizationPerformed===false&&value.requiresUnbiasedOptimization===(value.role==='sampled-candidate'),'Sampling cannot claim optimized candidates');
  assert(plain(value.diagnostics)&&finite(value.diagnostics.maxWallPenetrationAngstrom,0),'Missing sphere penetration diagnostic');
  if(request.coreProtection){const c=value.diagnostics.core;assert(plain(c)&&finite(c.rmsdAngstrom,0)&&finite(c.maxResidualAngstrom,0)&&integer(c.rank,0,3)&&c.orientationUnique===(c.rank>=2)&&['none','single-atom','collinear-or-coincident'].includes(c.degeneracy),'Invalid core relative-geometry diagnostic');}
  if(native&&request.nativeProtection){assert(value.physicalEnergyEV===null&&value.coreBiasEV===(request.nativeProtection.core?null:0)&&value.sphereBiasEV===(request.nativeProtection.sphere?null:0),'Native total potential cannot be relabelled physical energy or split into invented bias components');}
  if(!request.coreProtection&&!request.nativeProtection?.core)assert(value.coreBiasEV===0,'Unexpected core bias');if(request.operation!=='metadynamics')assert(value.metaBiasEV===0,'Unexpected metadynamics bias');if(!request.sphere&&!request.nativeProtection?.sphere)assert(value.sphereBiasEV===0&&value.diagnostics.maxWallPenetrationAngstrom===0,'Unexpected sphere bias');
  if(native){const c=value.nativeMD;assert(plain(c)&&c.method===request.method&&typeof c.version==='string'&&c.version.length>0&&/^[a-f0-9]{64}$/.test(c.inputSha256??'')&&c.shakeHydrogenBonds===request.shakeHydrogenBonds&&['xtb.trj','mdrestart'].includes(c.sourceArtifact)&&integer(c.rawIndex,0,Number.MAX_SAFE_INTEGER)&&['pre-step','restart-final'].includes(c.frameTiming)&&['half-step','restart','unavailable'].includes(c.velocityPhase)&&typeof c.nativeClosed==='boolean','Missing native MD phase/parameter/source evidence');assert(request.hydrogenMassAmu===4?c.hydrogenMassAmu===4&&c.hydrogenMassMode==='fixed-amu'&&c.hydrogenMassScaling===undefined:c.hydrogenMassScaling===1&&(c.hydrogenMassAmu===undefined||c.hydrogenMassAmu===null)&&(c.hydrogenMassMode===undefined||c.hydrogenMassMode==='natural'),'Native hydrogen mass evidence differs from request');assert((c.sourceArtifact==='mdrestart')===(c.frameTiming==='restart-final'),'Native MD source phase changed');if(c.sourceArtifact==='mdrestart')assert(value.step===steps((request.operation==='metadynamics'?request.metadynamics:request.molecularMD).durationFs,request.dtFs)&&c.nativeClosed===true&&value.physicalEnergyEV===null&&value.sampledPotentialEV===null&&value.kineticEnergyEV===null&&value.temperatureK===null,'Final native restart cannot borrow another frame energy/temperature');}
  if(value.diagnostics.shake)assert(value.diagnostics.shake.enabled===request.shakeHydrogenBonds,'Observed SHAKE toggle differs from the request');
  if(native){const e=value.nativeMD;validateNativeSolvationEvidence(e.nativeSolvation,request);validateInitialVelocityCorrection(e.initialVelocityCorrection);assert(request.nativeProtection||request.operation==='metadynamics'?e.energyDefinition==='native-total-including-sampling-potentials':e.energyDefinition===undefined||e.energyDefinition==='native-physical-potential','Native potential-energy definition differs');validateNativeProtectionEvidence(e.nativeProtection,request);if(request.nativeProtection?.sphere){const s=request.nativeProtection.sphere,penetration=Math.max(0,...value.coordinates.map(a=>Math.hypot(a.x-s.centerAngstrom[0],a.y-s.centerAngstrom[1],a.z-s.centerAngstrom[2])-s.radiusAngstrom));assert(Math.abs(penetration-value.diagnostics.maxWallPenetrationAngstrom)<=1e-6,'Native sphere penetration differs from source-frame coordinates');}}
  if(!native&&request.shakeHydrogenBonds){const s=value.diagnostics.shake,pairs=(request.structure.bonds??[]).filter(b=>request.structure.atoms[b.a].element==='H'||request.structure.atoms[b.b].element==='H');assert(plain(s)&&s.enabled===true&&s.algorithm==='ASE-RATTLE'&&s.hydrogenBondCount===pairs.length&&finite(s.maxBondResidualAngstrom,0,1e-6),'Requested SHAKE lacks its actual constraint residual');const length=(atoms,b)=>Math.hypot(atoms[b.a].x-atoms[b.b].x,atoms[b.a].y-atoms[b.b].y,atoms[b.a].z-atoms[b.b].z),residual=Math.max(0,...pairs.map(b=>Math.abs(length(value.coordinates,b)-length(request.structure.atoms,b))));assert(residual<=1e-6&&Math.abs(residual-s.maxBondResidualAngstrom)<=1e-9,'Sampled X-H distances do not satisfy the selected SHAKE constraint');}
  if(!native&&request.method==='gfnff'){const c=value.calculatorEvidence;assert(plain(c)&&c.engine==='native-xtb'&&c.method==='gfnff'&&typeof c.version==='string'&&/^[a-f0-9]{64}$/.test(c.forceFieldTopologySha256??'')&&integer(c.evaluations,1,request.maxEvaluations)&&c.spinTreatment==='not-supported'&&same(c.coordinateTransform,{kind:'identity',offsetAngstrom:[0,0,0]})&&c.lastEvaluation?.nativeClosed===true,'Invalid fixed-topology native GFN-FF identity');}
  if(!native&&request.method==='gfn0'){const c=value.calculatorEvidence;assert(plain(c)&&c.engine==='native-xtb'&&c.method==='gfn0'&&typeof c.version==='string'&&c.forceFieldTopologySha256===undefined&&integer(c.evaluations,1,request.maxEvaluations)&&c.spinTreatment==='native-uhf'&&same(c.coordinateTransform,{kind:'identity',offsetAngstrom:[0,0,0]})&&c.lastEvaluation?.nativeClosed===true&&c.lastEvaluation.topologyReadFromOwnedSeed===false,'Invalid isolated native GFN0 identity');}
  assert(same(value.units,{coordinates:'angstrom',velocity:'angstrom/fs',energy:'eV',time:'fs',temperature:'K'}),'Sampling units changed');
}
function expectedBiasHistoryCount(request){
  if(request.operation!=='metadynamics')return 0;
  const m=request.metadynamics,total=steps(m.durationFs,request.dtFs),interval=steps(m.depositEveryFs,request.dtFs);
  // Native deposits before integration; the final restart is not another deposit.
  return 1+Math.floor((total-(request.driver==='native-xtb-md'?1:0))/interval);
}
function validateHistory(entry,request){const m=request.metadynamics;assert(m&&plain(entry)&&integer(entry.index,0,m.maxHistory-1)&&integer(entry.step,0,request.maxSteps)&&entry.step===entry.index*steps(m.depositEveryFs,request.dtFs)&&entry.timeFs===entry.step*request.dtFs&&same(entry.atomIds,m.atomIds)&&entry.heightEV===m.heightEV&&entry.sigmaAngstrom===m.sigmaAngstrom&&Array.isArray(entry.coordinatesAngstrom)&&entry.coordinatesAngstrom.length===m.atomIds.length&&entry.coordinatesAngstrom.every(v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x,-1e6,1e6))),'Invalid complete RMSD bias history');}
function expectedFrames(request){
  const frames=[],dt=request.dtFs;let step=0;
  if(request.operation==='anneal'){const a=request.annealing,lo=a.lowTemperatureK;
    for(let cycle=0;cycle<a.cycles;cycle++){
      for(const[name,duration,start,end]of annealingSegments(a)){
        const n=steps(duration,dt,true);for(let i=1;i<=n;i++){step++;if(step%request.reportEvery===0)frames.push({step,role:'trajectory',targetTemperatureK:start+(end-start)*i/n,stageId:`cycle-${cycle+1}-${name}`,cycleIndex:cycle});}
      }frames.push({step,role:'sampled-candidate',targetTemperatureK:lo,stageId:`cycle-${cycle+1}-end`,cycleIndex:cycle});
    }
  }else{const a=request.operation==='metadynamics'?request.metadynamics:request.operation==='md'?request.molecularMD:request.sphericalMD,n=steps(a.durationFs,dt),interval=steps(a.sampleEveryFs,dt);for(step=1;step<=n;step++){const candidate=step%interval===0||step===n;if(candidate||step%request.reportEvery===0)frames.push({step,role:candidate?'sampled-candidate':'trajectory',targetTemperatureK:a.temperatureK,stageId:request.operation});}}
  return frames;
}
function validateEvent(value,session){
  validateSegmentProgress(value,session.request);
  assert(plain(value)&&value.schema===1&&value.sessionId===session.id&&same(value.stamp,session.request.stamp)&&same(value.runIdentity,session.request.runIdentity)&&value.operation===session.request.operation&&value.method===session.request.method&&value.seq===session.workerSeq+1,'Sampling worker identity/sequence changed');
  assert(['stage','frame','progress','bias','native-started','native-closed',...TERMINAL].includes(value.kind),'Unknown sampling event');
  if(value.kind==='progress')assert(session.request.driver==='native-xtb-md'&&value.phase==='native-md'&&integer(value.step,0,session.request.maxSteps)&&integer(value.frameCount,0,session.request.maxFrames)&&(value.candidateCount===undefined||integer(value.candidateCount,0,value.frameCount)),'Invalid observed native MD progress');
  if(value.kind.startsWith('native-'))assert(requiresXtbRuntime(session.request)&&integer(value.pid,1,Number.MAX_SAFE_INTEGER)&&(value.kind==='native-started'||Number.isSafeInteger(value.code)),'Invalid native sampling child event');
  if(value.kind==='frame')validateFrame(value,session.request);
  if(value.nativeSolvation!==undefined){assert(session.request.driver==='native-xtb-md','Native solvation requires native MD');validateNativeSolvationEvidence(value.nativeSolvation,session.request);}
  if(value.initialVelocityCorrection!=null){assert(session.request.driver==='native-xtb-md','Initial velocity correction requires native MD');validateInitialVelocityCorrection(value.initialVelocityCorrection);}
  if(value.nativeMD?.initialVelocityCorrection!=null)validateInitialVelocityCorrection(value.nativeMD.initialVelocityCorrection);
  if(value.lastFrame?.nativeMD?.initialVelocityCorrection!=null)validateInitialVelocityCorrection(value.lastFrame.nativeMD.initialVelocityCorrection);
  if(value.kind==='stage'&&value.stageId==='sampling'&&value.status==='started'){
    if(value.configuration)assert(value.configuration.hydrogenMassAmu===session.request.hydrogenMassAmu&&value.configuration.shakeHydrogenBonds===session.request.shakeHydrogenBonds&&value.configuration.dtFs===session.request.dtFs,'Sampling configuration mass, constraint or timestep changed');
    if(value.integration)assert(session.request.hydrogenMassAmu===4?value.integration.hydrogenMassAmu===4&&value.integration.hydrogenMassMode==='fixed-amu':value.integration.hydrogenMassAmu==null&&(value.integration.hydrogenMassMode===undefined||value.integration.hydrogenMassMode==='natural'),'Sampling integration mass evidence differs from request');
  }
  if(value.kind==='bias')validateHistory(value.historyEntry,session.request);
  if(value.kind==='completed'){const native=session.request.driver==='native-xtb-md';assert(value.samplingCompleted===true&&value.optimizationPerformed===false&&value.requiresUnbiasedOptimization===true&&integer(value.candidateCount,1,session.request.maxFrames)&&integer(value.frameCount,value.candidateCount,session.request.maxFrames)&&integer(value.step,1,session.request.maxSteps)&&(native?value.driver==='native-xtb-md'&&value.evaluations===null&&value.evaluationCountSource==='not-reported-native-md'&&value.budgetEvaluationUpperBound===steps((session.request.operation==='metadynamics'?session.request.metadynamics:session.request.molecularMD).durationFs,session.request.dtFs)+2:integer(value.evaluations,1,session.request.maxEvaluations))&&same(value.postSamplingPotentials,{core:false,metadynamics:false,sphere:false})&&Array.isArray(value.biasHistory),'Invalid sampling completion identity');if(session.request.operation==='metadynamics'){value.biasHistory.forEach((h,i)=>{validateHistory(h,session.request);assert(h.index===i,'Incomplete RMSD bias history');});}else assert(value.biasHistory.length===0,'Unexpected bias history');}
  if(value.lastFrame!=null)validateFrame(value.lastFrame,session.request);
  if(value.nativeTemperatureObservations!==undefined){
    const observations=value.nativeTemperatureObservations,seen=new Set(),request=session.request;
    assert(TERMINAL.has(value.kind)&&request.driver==='native-xtb-md'&&Array.isArray(observations)&&observations.length<=Math.ceil(request.maxSteps/200),'Invalid native temperature observation source');
    for(const row of observations){
      keys(row,['step','timeFs','printedAtStep','temperatureK','kineticEnergyEV','sourceArtifact','sourceCommit','velocityPhase','temperatureResolutionK','kineticEnergyResolutionHartree']);
      assert(integer(row.step,0,request.maxSteps-1)&&row.printedAtStep===row.step+1&&row.printedAtStep%200===0&&!seen.has(row.step)&&finite(row.timeFs)&&Math.abs(row.timeFs-row.step*request.dtFs)<=1e-8&&finite(row.temperatureK,0,10000)&&finite(row.kineticEnergyEV,0)&&row.sourceArtifact==='stdout.txt'&&row.sourceCommit==='5071a8869720fb0ecd788af977159869b64a277c'&&row.velocityPhase==='centred-before-SHAKE-and-rmrottr'&&row.temperatureResolutionK===1&&row.kineticEnergyResolutionHartree===0.0001,'Invalid native temperature observation timing or values');
      seen.add(row.step);
    }
  }
  if(value.thermostatWarning!==undefined){
    const w=value.thermostatWarning,target=(session.request.operation==='metadynamics'?session.request.metadynamics:session.request.molecularMD)?.temperatureK;
    keys(w,['kind','message','targetTemperatureK','averageTemperatureK','relativeDeviation']);
    assert(value.kind==='completed'&&session.request.driver==='native-xtb-md'&&value.nativeClosed===true&&value.step>=500&&w.kind==='average-temperature-deviation'&&w.message==='thermostating problem'&&w.targetTemperatureK===target&&finite(w.averageTemperatureK,Number.MIN_VALUE,10000)&&finite(w.relativeDeviation)&&Math.abs(w.relativeDeviation)>.02&&Math.abs(w.relativeDeviation-(w.averageTemperatureK-target)/target)<=1e-12,'Invalid native mean-temperature warning');
  }
  if(value.kind==='error')assert(plain(value.error)&&typeof value.error.code==='string'&&typeof value.error.message==='string'&&value.error.message.length<=8192&&(value.error.details===undefined||plain(value.error.details)),'Invalid sampling error');
  if(TERMINAL.has(value.kind))assert(value.workerSettled===true,'Sampling worker did not settle');return value;
}
module.exports={METHODS,OPERATIONS,DEFAULTS,ANNEAL_DEFAULTS,META_DEFAULTS,SPHERE_DEFAULTS,MD_DEFAULTS,TERMINAL,sessionIdentity,validateStart,validateEvent,validateFrame,expectedFrames,expectedBiasHistoryCount,annealingSegments,samplingDriver,requiresXtbRuntime,samplingSegmentFields,validateInitialVelocityCorrection};
