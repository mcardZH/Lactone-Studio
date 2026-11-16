'use strict';
const { assert, plain, string, boundedJSON, validateStructure, validateEmpiricalBondParameters, MAX_FINGERPRINT_BYTES } = require('./security.cjs');
const { cpuResourceSnapshot } = require('./cpu-resources.cjs');
const { validateOptimizationPool } = require('./candidate-pool-admission.cjs');
const { nativePeriodicOptimization, createPeriodicOptimizationChart, FIRE_GRADIENT_LIMIT } = require('./xtb-native-periodic.cjs');
const { XTB_METHOD_IDS:METHODS, XTB_METHOD_LABELS, supportsXtbOperation, supportsXtbAlpb, xtbSolvents } = require('./xtb-capabilities.cjs');
const {validateFixedFf}=require('./xtb-fixed-ff.cjs');

const LIMITS = Object.freeze({ maxSteps: Number.MAX_SAFE_INTEGER, maxWallTimeSeconds: Number.MAX_VALUE, threads: cpuResourceSnapshot().logicalCpuCount });
// Compatibility export for existing consumers of historical solvation data.
const SOLVATION_SOLVENTS=Object.freeze(Object.fromEntries(['alpb','gbsa'].map(model=>[model,Object.freeze(Object.fromEntries(METHODS.flatMap(method=>{
  const solvents=xtbSolvents(method,model);return solvents.length?[[method,solvents]]:[];
})))])));
// xTB 5071a886 scanparam.f90 defaults to 0.05. This bounded application policy
// was tested with real B/A/D and coupled fixtures; acceptance still measures
// every native result, since a stronger harmonic potential is not exact fixing.
const INTERNAL_CONSTRAINT_POLICY = Object.freeze({ forceConstant: 20, forceConstantUnit: 'hartree/bohr^2', bondToleranceAngstrom: 0.001, angleToleranceDegree: 0.1 });
const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
function sessionIdentity(value) { assert(string(value,100) && /^[A-Za-z0-9_-]+$/.test(value),'Invalid xTB session identity'); return value; }
function validateStart(value, cpuResources = cpuResourceSnapshot()) {
  boundedJSON(value);assert(plain(value),'Invalid xTB request');
  const keys=['stamp','structure','method','calculation','charge','uhf','frozenAtomIds','constraints','internalConstraintsConfirmed','maxSteps','optimizationStepPolicy','maxSccIterations','maxWallTimeSeconds','threads','memoryBudgetBytes','empiricalBondParameters','electronicProperties','runIdentity','solvation','optimizationPool','ffModel'];
  assert(Object.keys(value).every(key=>keys.includes(key)),'Unknown xTB request field');assert(METHODS.includes(value.method),'Invalid xTB method');
  assert(value.memoryBudgetBytes===undefined||Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>0,'Invalid xTB soft memory budget');
  if(value.empiricalBondParameters!==undefined)validateEmpiricalBondParameters(value.empiricalBondParameters);
  const calculation=value.calculation??'optimize';assert(['optimize','singlepoint'].includes(calculation),'Invalid xTB calculation');
  assert(calculation!=='singlepoint'||value.method==='gfn2'||value.method==='gxtb'&&value.electronicProperties===true,'Singlepoint requires GFN2 or g-xTB electronic properties');
  validateOptimizationPool({...value,calculation});
  if(value.runIdentity!==undefined){assert(plain(value.runIdentity)&&Object.keys(value.runIdentity).length===2&&Object.keys(value.runIdentity).every(key=>['taskId','runId'].includes(key)),'Invalid xTB task/run identity');sessionIdentity(value.runIdentity.taskId);sessionIdentity(value.runIdentity.runId);}
  const stamp=value.stamp;assert(plain(stamp)&&string(stamp.documentId)&&Number.isSafeInteger(stamp.revision)&&stamp.revision>=0&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(key=>typeof stamp[key]==='string'),'Invalid xTB document stamp');
  assert(stamp.activationEpoch===undefined||Number.isSafeInteger(stamp.activationEpoch)&&stamp.activationEpoch>=0,'Invalid xTB activation epoch');
  const ids=validateStructure(value.structure),atoms=value.structure.atoms;assert(atoms.length>0,'xTB requires a nonempty molecule');
  assert(value.structure.dimension===undefined||value.structure.dimension===3,'xTB requires three-dimensional coordinates');
  assert(value.structure.periodicSource?.completeness!=='partial','xTB requires a complete cell, not partial translation vectors');
  if(value.structure.cell!==undefined){const cell=value.structure.cell;assert(plain(cell)&&Array.isArray(cell.pbc)&&cell.pbc.length===3&&cell.pbc.every(flag=>typeof flag==='boolean')&&Array.isArray(cell.vectors)&&cell.vectors.length===3&&cell.vectors.every(vector=>Array.isArray(vector)&&vector.length===3&&vector.every(number=>Number.isFinite(number)&&Math.abs(number)<=1e6)),'xTB requires a finite complete cell');assert(cell.origin===undefined||Array.isArray(cell.origin)&&cell.origin.length===3&&cell.origin.every(Number.isFinite),'Invalid box origin');const [a,b,c]=cell.vectors,det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);assert(!cell.pbc.some(Boolean)||Number.isFinite(det)&&Math.abs(det)>1e-8,'xTB requires a nonsingular periodic cell');}
  const periodic=isPeriodic(value);assert(periodic||!value.structure.bonds?.some(bond=>bond.image?.some(number=>number!==0)),'Image bonds require a periodic cell');
  if(value.solvation!==undefined){const solvation=value.solvation;assert(plain(solvation)&&Object.keys(solvation).length===2&&Object.keys(solvation).every(key=>['model','solvent'].includes(key))&&solvation.model==='alpb'&&typeof solvation.solvent==='string','Invalid xTB solvation request');assert(!periodic,'Implicit solvation is restricted to isolated structures');assert(supportsXtbAlpb(value.method,solvation.solvent,periodic),'Solvation model/solvent is not parametrized for the selected xTB method');}
  assert(value.electronicProperties===undefined||typeof value.electronicProperties==='boolean','Invalid xTB electronic properties option');
  assert(!value.electronicProperties||calculation==='singlepoint'&&['gfn2','gxtb'].includes(value.method)&&!periodic,'Electronic properties require an isolated GFN2 or g-xTB singlepoint');
  assert(supportsXtbOperation(value.method,calculation,periodic),'Selected xTB method does not support this structure and operation');
  for(const atom of atoms)assert(ELEMENTS.includes(atom.element)&&[atom.x,atom.y,atom.z].every(number=>Math.abs(number)<=1e6),'Invalid xTB element or coordinate bound');
  assert(Number.isSafeInteger(value.charge)&&Math.abs(value.charge)<=100,'Explicit integer xTB charge required');
  const electrons=atoms.reduce((sum,atom)=>sum+ELEMENTS.indexOf(atom.element)+1,0)-value.charge;assert(electrons>0,'Invalid xTB electron count');
  const uhf=value.method==='gxtb'?(value.uhf??0):value.uhf;
  if(value.method==='gfnff')assert(uhf===undefined||uhf===0,'GFNFF has no spin treatment');
  else assert(Number.isSafeInteger(uhf)&&uhf>=0&&uhf<=electrons&&(electrons-uhf)%2===0,'Explicit UHF must match electron count and parity');
  const frozen=value.frozenAtomIds??[],constraints=value.constraints??[];assert(Array.isArray(frozen)&&new Set(frozen).size===frozen.length&&frozen.every(id=>ids.has(id)),'Invalid xTB frozen atom identities');
  assert(Array.isArray(constraints),'Invalid xTB native constraints');const seen=new Set();
  const chart=periodic&&calculation==='optimize'&&constraints.length?createPeriodicOptimizationChart(value):undefined;
  for(const row of constraints){
    assert(plain(row)&&Object.keys(row).every(key=>['id','objectId','type','atomIds','images','action','steps','increment','source','value'].includes(key))&&['B','A','D'].includes(row.type)&&row.action==='freeze','xTB accepts only native B/A/D freeze constraints');
    const count={B:2,A:3,D:4}[row.type];
    assert(Array.isArray(row.atomIds)&&row.atomIds.length===count&&new Set(row.atomIds).size===count&&row.atomIds.every(id=>ids.has(id)),'Invalid xTB constraint atom identities');
    if(row.images!==undefined){
      assert(Array.isArray(row.images)&&row.images.length===count&&row.images.every(image=>Array.isArray(image)&&image.length===3&&image.every(Number.isSafeInteger)),'Invalid xTB constraint images');
      assert(row.images.every(image=>image.every((component,axis)=>component===(periodic?row.images[0][axis]:0))),'周期xTB仅支持同胞B/A/D，不能应用跨胞内坐标约束。');
    }
    if(chart){
      const [first,...rest]=row.atomIds.map(id=>chart.byAtom.get(id).image);
      assert(rest.every(image=>image.every((component,axis)=>component===first[axis])),'周期B/A/D在原生折回后跨越晶胞，当前原生优化无法应用该约束。');
    }
    assert(row.id===undefined||string(row.id),'Invalid xTB constraint identity');assert(row.objectId===undefined||string(row.objectId),'Invalid xTB coordinate object identity');assert(row.source===undefined||row.source==='orca','Invalid xTB constraint source');
    assert(row.steps===undefined||row.steps===0||row.steps===1,'xTB cannot run coordinate scans');assert(row.increment===undefined||row.increment===null,'xTB cannot run coordinate scans');
    assert(row.value===undefined||Number.isFinite(row.value)&&(row.type==='B'?row.value>0&&row.value<=1e6:row.type==='A'?row.value>=0&&row.value<=180:Math.abs(row.value)<=180),'Invalid xTB native target or angle unit');
    const forward=row.atomIds.join('\0'),reverse=[...row.atomIds].reverse().join('\0'),key=row.type+':'+(forward<reverse?forward:reverse);assert(!seen.has(key),'Duplicate xTB native constraint');seen.add(key);if(calculation==='optimize')measure(row,atoms);
  }
  assert(calculation==='singlepoint'||!constraints.length||value.internalConstraintsConfirmed===true,'Native internal-coordinate constraints require confirmation for every start');
  const nativeSteps=value.optimizationStepPolicy==='native-default';
  assert(value.optimizationStepPolicy===undefined||nativeSteps&&calculation==='optimize'&&!periodic&&value.runIdentity&&value.maxSteps===undefined,'Native default steps require an isolated advanced optimization without an explicit step count');
  const maxSteps=nativeSteps?undefined:value.maxSteps??(periodic&&calculation==='optimize'?1000:500),maxSccIterations=value.maxSccIterations??250,maxWallTimeSeconds=value.maxWallTimeSeconds,threads=value.threads??2;
  const threadLimit=cpuResources.logicalCpuCount;
  assert(nativeSteps||Number.isSafeInteger(maxSteps)&&maxSteps>=1,'Invalid xTB step budget');assert(Number.isSafeInteger(maxSccIterations)&&maxSccIterations>=1,'Invalid xTB SCC iteration budget');assert(maxWallTimeSeconds===undefined||Number.isFinite(maxWallTimeSeconds)&&maxWallTimeSeconds>0,'Invalid xTB wall budget');assert(Number.isSafeInteger(threadLimit)&&threadLimit>=1&&Number.isSafeInteger(threads)&&threads>=1&&threads<=threadLimit,'Invalid xTB thread budget');
  const normalized={...value,...(uhf===undefined?{}:{uhf}),calculation,frozenAtomIds:frozen,constraints:calculation==='singlepoint'?constraints:constraints.map(row=>({...row,value:row.value??measure(row,atoms)})),maxSteps,maxSccIterations,maxWallTimeSeconds,threads};if(value.ffModel!==undefined)validateFixedFf(value.ffModel,normalized);boundedJSON(normalized);return structuredClone(normalized);
}
function xyzInput(request){return request.structure.atoms.length+'\nEster Studio owned xTB preoptimization; coordinates in angstrom\n'+request.structure.atoms.map(atom=>[atom.element,atom.x.toPrecision(17),atom.y.toPrecision(17),atom.z.toPrecision(17)].join(' ')).join('\n')+'\n';}
// The approved xTB run uses the complete current box as XYZ; source axes stay untouched.
function isPeriodic(request){return Boolean(request.structure.cell);}
function optimizerFor(request){return nativePeriodicOptimization(request)?'inertial':'rf';}
function xcontrolInput(request){
  if(request.calculation==='singlepoint')return '';
  const index=new Map(request.structure.atoms.map((atom,i)=>[atom.id,i+1])),lines=['$opt','  engine='+optimizerFor(request)];
  if(request.maxSteps!==undefined)lines.push('  maxcycle='+request.maxSteps);
  if(request.frozenAtomIds.length)lines.push('$fix','  atoms: '+request.frozenAtomIds.map(id=>index.get(id)).join(','));
  if(request.constraints.length){lines.push('$constrain','  force constant='+INTERNAL_CONSTRAINT_POLICY.forceConstant);for(const row of request.constraints)lines.push('  '+{B:'distance',A:'angle',D:'dihedral'}[row.type]+': '+row.atomIds.map(id=>index.get(id)).join(', ')+', '+row.value.toPrecision(17));}
  return lines.concat('$end','').join('\n');
}
function sccIterationLimit(request){return request.maxSccIterations??250;}
function invocation(request){
  const sp=request.calculation==='singlepoint', periodic=nativePeriodicOptimization(request), gxtb=request.method==='gxtb';
  const method=gxtb?['--gxtb']:request.method==='gfnff'?['--gfnff']:['--gfn',request.method.slice(3)];
  const gfnScc=['gfn1','gfn2'].includes(request.method);
  return [periodic?'input.coord':'input.xyz',...method,...(periodic&&gfnScc?['--tblite']:[]),
    ...(periodic?['--opt','extreme','--acc','0.01','--nocellopt','--verbose']:sp?(gxtb?[]:['--scc']):['--opt']),
    ...(gfnScc||gxtb?['--iterations',String(sccIterationLimit(request))]:[]),'--chrg',String(request.charge),
    ...(request.method==='gfnff'||gxtb&&request.uhf===0?[]:['--uhf',String(request.uhf)]),
    ...(sp?[]:['--input','xcontrol.inp']),...(request.electronicProperties?['--molden']:[]),...(sp&&gxtb?['--acc','0.1']:[]),
    ...(!periodic&&(gxtb||!sp&&request.constraints.length)?['--verbose']:[]),...(request.ffModel?[]:['--norestart']),'--parallel',String(request.threads),...(request.solvation?['--'+request.solvation.model,request.solvation.solvent]:[])];
}
function nativeSolvation(stdout,request){
  const output=stdout.replaceAll('\r\n','\n'),markers=[...output.matchAll(/^[ \t]*\*[ \t]+Solvation model:[ \t]+([^\n]+)$/gm)];
  if(request.solvation===undefined){assert(!/^[ \t]*\*?[ \t]*Solvation model:/m.test(output),'Gas-phase xTB request unexpectedly used a solvation model');return undefined;}
  assert(markers.length===1,'Actual native solvation setup is missing or ambiguous');
  const expected=request.solvation,tail=output.slice(markers[0].index,markers[0].index+8192),end=/^[ \t]+Grid points[ \t]+\d+[ \t]+per atom[ \t]*$/m.exec(tail);assert(end,'Native solvation setup is truncated');const block=tail.slice(0,end.index);
  // Locked upstream info() uses 8x,a,t40: labels occupy columns 9–39 and
  // values start at column 40. Prefix matching would also consume Solvent mass.
  const field=label=>{const rows=block.split('\n').filter(line=>line.startsWith('        ')&&line.slice(8,39).trimEnd()===label);assert(rows.length===1,'Native solvation '+label+' is missing or ambiguous');return rows[0].slice(39).trim();};
  const parameterSet='internal '+XTB_METHOD_LABELS[request.method]+'/'+expected.model.toUpperCase(),kernel=expected.model==='alpb'?'p16':'still';
  assert(markers[0][1].trim()===expected.model.toUpperCase()&&field('Solvent')===expected.solvent,'Native solvation model or solvent differs from the request');
  assert(field('Parameter file')===parameterSet,'Native solvation parameter set differs from the fixed internal parameterization');
  assert(field('Interaction kernel')===(kernel==='p16'?'P16':'Still'),'Native solvation interaction kernel differs from the request');
  assert(field('Reference state')==='gsolv [1 M gas/solution]','Native solvation reference state differs from the fixed default');
  const temperature=field('Temperature'),numeric=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?)[ \t]+K$/.exec(temperature);assert(numeric&&Number(numeric[1].replace(/[dD]/,'e'))===298.15,'Native solvation temperature differs from the fixed default');
  return {model:expected.model,solvent:expected.solvent,kernel,referenceState:'gsolv',temperatureKelvin:298.15,parameterSet,sourceField:'stdout:solvation-model'};
}
function optimizedCoordinates(text,request){
  assert(typeof text==='string','Invalid optimized XYZ output');const lines=text.replaceAll('\r\n','\n').trimEnd().split('\n');assert(/^\s*\d+\s*$/.test(lines[0])&&Number(lines[0])===request.structure.atoms.length&&lines.length===request.structure.atoms.length+2,'Optimized XYZ must retain the exact atom count');
  const rows=lines.slice(2).map(line=>line.trim().split(/\s+/));
  assert(rows.every((fields,index)=>fields.length===4&&fields[0]===request.structure.atoms[index].element),'Optimized XYZ element/order changed');
  const fixed=new Set(request.frozenAtomIds);
  return request.structure.atoms.map((atom,index)=>{
    const fields=rows[index],numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
    assert(fields.slice(1).every(value=>numeric.test(value)||/^[+-]?(?:nan|infinity|inf)$/i.test(value)),'Invalid native XYZ numeric syntax');
    const xyz=fields.slice(1).map(value=>Number(value.replace(/[dD]/,'e')));
    const valid=xyz.every(value=>Number.isFinite(value)&&Math.abs(value)<=1e6);
    if(!valid&&request.optimizationPool)throw Object.assign(Error('Native candidate returned nonfinite or unsafe optimized coordinates'),{code:'XTB_CANDIDATE_RESULT'});
    assert(valid,'Nonfinite or unsafe optimized coordinate');
    if(fixed.has(atom.id)){assert(xyz.every((value,i)=>Math.abs(value-atom[['x','y','z'][i]])<=1e-7),'Strictly fixed atom moved in xTB output');return{id:atom.id,element:atom.element,x:atom.x,y:atom.y,z:atom.z};}
    return{id:atom.id,element:atom.element,x:xyz[0],y:xyz[1],z:xyz[2]};
  });
}
function createTrajectoryParser(request){
  assert(request.calculation==='optimize','Only optimization has a native trajectory');let tail='',lines=[],frameCount=0;
  return {push(text){
    assert(typeof text==='string','Invalid native trajectory text');tail+=text;const frames=[];let end;
    while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end).replace(/\r$/,'');tail=tail.slice(end+1);assert(Buffer.byteLength(line)<=8192,'Native trajectory line exceeds its byte bound');
      if(!lines.length)assert(/^\s*\d+\s*$/.test(line)&&Number(line)===request.structure.atoms.length,'Native trajectory atom count changed');lines.push(line);
      if(lines.length===request.structure.atoms.length+2){const coordinates=optimizedCoordinates(lines.join('\n')+'\n',request);frames.push({coordinates,step:frameCount++,stepKind:'native-log-frame'});lines=[];}
    }return frames;
  },finish(){assert(!tail.length&&!lines.length,'Native trajectory ended with a partial frame');assert(frameCount>0,'Native trajectory has no complete frames');return frameCount;},count:()=>frameCount};
}
// Same ordered signed-dihedral convention as core/tasks.ts. These measurements
// describe native harmonic restraint residuals; they are not an exact solver.
function measure(row,atoms){
  const points=row.atomIds.map(id=>{const atom=atoms.find(value=>value.id===id);assert(atom,'Missing xTB coordinate atom');return[atom.x,atom.y,atom.z];}),sub=(a,b)=>a.map((n,i)=>n-b[i]),dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0),norm=a=>Math.hypot(...a),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  if(row.type==='B')return norm(sub(points[0],points[1]));
  if(row.type==='A'){const a=sub(points[0],points[1]),b=sub(points[2],points[1]),length=norm(a)*norm(b);assert(length>1e-12,'Coincident atoms cannot define xTB angle');return Math.acos(Math.max(-1,Math.min(1,dot(a,b)/length)))*180/Math.PI;}
  const a=sub(points[0],points[1]),b=sub(points[2],points[1]),c=sub(points[3],points[2]),length=norm(b);assert(length>1e-12,'Coincident atoms cannot define xTB dihedral');const axis=b.map(n=>n/length),v=a.map((n,i)=>n-dot(a,axis)*axis[i]),w=c.map((n,i)=>n-dot(c,axis)*axis[i]);assert(norm(v)*norm(w)>1e-12,'Collinear atoms cannot define xTB dihedral');return Math.atan2(dot(cross(axis,v),w),dot(v,w))*180/Math.PI;
}
function constraintResiduals(request,coordinates){return request.constraints.map(row=>{const actual=measure(row,coordinates),delta=actual-row.value;assert([row.value,actual,delta].every(Number.isFinite),'xTB internal constraint measurement is nonfinite');return {...row,target:row.value,actual,residual:row.type==='D'?((delta+180)%360+360)%360-180:delta,unit:row.type==='B'?'angstrom':'degree',mode:'native-harmonic'};});}
function validateNativeConstraints(stdout,request){
  if(!request.constraints.length)return;
  const constant=/^\s*(?:->\s+)?force constant\s*=\s*([-+\d.eEdD]+)\s*$/mi.exec(stdout);
  assert(constant&&Number(constant[1].replace(/[dD]/,'e'))===INTERNAL_CONSTRAINT_POLICY.forceConstant&&/total constraint energy\/grad norm:/i.test(stdout),'Native xTB constraint setup was not confirmed');
  const rows=[...stdout.matchAll(/^\s*constraining (bond|angle)\s+([\d\t ]+?)\s+to\s+([-+\d.eEdD]+)\s*(?:Å|°),\s*actual value:/gmi)];
  const atomIndices=new Map(request.structure.atoms.map((atom,i)=>[atom.id,i+1]));
  assert(rows.length===request.constraints.length&&request.constraints.every((row,i)=>{
    const [,kind,indices,value]=rows[i], target=Number(value.replace(/[dD]/,'e'));
    const difference=target-row.value;
    return kind.toLowerCase()===(row.type==='B'?'bond':'angle')&&indices.trim().split(/\s+/).map(Number).join(',')===row.atomIds.map(id=>atomIndices.get(id)).join(',')
      &&Number.isFinite(target)&&Math.abs(row.type==='D'?((difference+180)%360+360)%360-180:difference)<=1e-6;
  }),'Native xTB consumed different B/A/D restraints from the request');
}
function nativeOptimizationFailure(stdout, request){
  if(request.calculation!=='optimize')return undefined;
  const optimizer=/^-\d+- ANC generation failed, not enough modes!\s*$/im.exec(stdout);
  if(optimizer)return {code:'XTB_CANDIDATE_OPTIMIZER',message:optimizer[0].trim()};
  if(!['gfn1','gfn2','gxtb'].includes(request.method))return undefined;
  const scc=/\b(?:SCC|SCF) not converged in \d+ (?:cycles|iterations)\b|^\s*\*{3}\s+convergence criteria cannot be satisfied\b[^\n]*/im.exec(stdout);
  if(scc)return {code:'XTB_CANDIDATE_SCC',message:scc[0].trim()};
  const geometry=/^-\d+- scc_core: Diagonalization of Hamiltonian failed\s*$/im.exec(stdout);
  if(geometry)return {code:'XTB_CANDIDATE_GEOMETRY',message:geometry[0].trim()};
}
function convergence(stdout,request){
  assert(!/ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|convergence criteria cannot be satisfied|SCC (?:iteration )?failed/i.test(stdout),'xTB reported a failed calculation');
  const matches=[...stdout.matchAll(/^\s*\*{3}\s+(GEOMETRY OPTIMIZATION CONVERGED AFTER|FAILED TO CONVERGE GEOMETRY OPTIMIZATION IN)\s+(\d+)\s+(ITERATIONS|CYCLES)\s+\*{3}\s*$/gmi)];
  assert(matches.length===1,'Actual xTB optimization terminal evidence missing or ambiguous');
  const [record,terminal,count,counterUnit]=matches[0], optimizer=optimizerFor(request), periodic=optimizer==='inertial';
  assert(counterUnit.toUpperCase()===(periodic?'CYCLES':'ITERATIONS'),'Native convergence counter must match its selected optimizer');
  assert(periodic?/Fast Inertial Relaxation Engine/i.test(stdout):/RF solver/.test(stdout),'Actual selected native optimizer setup missing');
  const iterations=Number(count), converged=/^GEOMETRY OPTIMIZATION CONVERGED/i.test(terminal);
  let maxSteps=request.maxSteps;
  if(request.optimizationStepPolicy==='native-default'){
    const limits=[...stdout.matchAll(/^\s*:\s*max\. optcycles\s+(\d+)\s*:\s*$/gmi)];
    assert(limits.length===1&&Number.isSafeInteger(Number(limits[0][1]))&&Number(limits[0][1])>=1,'Native RF optimization step limit is missing or ambiguous');
    maxSteps=Number(limits[0][1]);
  }
  const stepLimitExceeded=iterations>maxSteps;
  const nativeRfSegment=!periodic&&(request.optimizationStepPolicy==='native-default'||Boolean(request.optimizationPool));
  if(!Number.isSafeInteger(iterations)||iterations<0||stepLimitExceeded&&!nativeRfSegment){
    throw Object.assign(Error(`原生xTB报告${iterations}步，超过本次${maxSteps}步上限。`),{code:'XTB_NATIVE_STEP_OVERRUN'});
  }
  assert(converged||(nativeRfSegment?iterations>=maxSteps:iterations===maxSteps),'Native xTB did not report a verified step-limit terminal');
  assert(!/FAILED TO CONVERGE/i.test(stdout.replace(record,'')),'xTB reported an independent convergence failure');
  const final=stdout.slice(matches[0].index+record.length), energies=[...final.matchAll(/\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|/g)];
  const energyHartree=Number(energies.at(-1)?.[1].replace(/[dD]/,'e'));
  assert(Number.isFinite(energyHartree),'Actual final xTB energy is missing');
  let movableGradientNormHartreePerBohr;
  if(periodic){
    const call=/program call\s*:\s*([^\r\n]+)/.exec(stdout)?.[1];
    assert(/Periodic properties/.test(stdout)&&call&&/--opt extreme\b/.test(call)&&/--acc 0\.01\b/.test(call)&&/--nocellopt\b/.test(call)
      &&/--tblite\b/.test(call)===['gfn1','gfn2'].includes(request.method),'Native fixed-cell FIRE setup was not confirmed');
    const gradients=[...final.matchAll(/\|\s*GRADIENT NORM\s+([-+\d.eEdD]+)\s+Eh\/(?:α|a0|bohr)\s*\|/gi)];
    movableGradientNormHartreePerBohr=Number(gradients.at(-1)?.[1].replace(/[dD]/,'e'));
    assert(Number.isFinite(movableGradientNormHartreePerBohr)&&movableGradientNormHartreePerBohr>=0,'Native FIRE movable gradient is missing');
  }
  return {calculation:'optimize',optimizer,iterations,maxSteps,...(stepLimitExceeded?{stepLimitExceeded:true}:{}),convergenceCounterUnit:counterUnit.toLowerCase(),energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',converged,
    convergenceStatus:converged?'converged':'step-limit',...(periodic?{movableGradientNormHartreePerBohr,gradientTargetHartreePerBohr:FIRE_GRADIENT_LIMIT,gradientTargetMet:movableGradientNormHartreePerBohr<=FIRE_GRADIENT_LIMIT}:{})};
}
function singlepointConvergence(stdout,request){
  assert(['gfn2','gxtb'].includes(request.method)&&request.calculation==='singlepoint','Supported xTB singlepoint request required');assert(!/FAILED TO CONVERGE|convergence criteria cannot be satisfied|ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR/i.test(stdout),'xTB reported a failed singlepoint');assert(!/GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver/.test(stdout),'Singlepoint must not execute a geometry optimizer');
  if(request.method==='gxtb')return gxtbSinglepointConvergence(stdout,request);
  const rows=[...stdout.matchAll(/^\s*\*{3}\s+convergence criteria satisfied after\s+(\d+)\s+iterations\s+\*{3}\s*$/gm)];assert(rows.length===1,'Actual GFN2 SCC convergence evidence missing');const sccIterations=Number(rows[0][1]),limit=sccIterationLimit(request);assert(Number.isSafeInteger(sccIterations)&&sccIterations>=1&&sccIterations<=limit,'Singlepoint exceeds its SCC iteration budget');
  const energies=[...stdout.matchAll(/\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|/g)],energyHartree=Number(energies.at(-1)?.[1].replace(/[dD]/,'e'));assert(Number.isFinite(energyHartree)&&energies.at(-1).index>rows[0].index,'Actual singlepoint total energy after SCC convergence missing');return {calculation:'singlepoint',sccIterations,sccIterationLimit:limit,energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',converged:true,convergenceStatus:'converged'};
}
function gxtbSpin(stdout,request){
  const rows=[...stdout.matchAll(/^\s*wavefunction\s+(restricted|unrestricted)\s*$/gmi)];
  const charges=[...stdout.matchAll(/^\s*molecular charge\s+([-+\d.eEdD]+)\s+e\s*$/gmi)];
  const unpaired=[...stdout.matchAll(/^\s*number of unpaired electrons\s+([-+\d.eEdD]+)\s+e\s*$/gmi)];
  const number=value=>Number(value.replace(/[dD]/,'e'));
  assert(rows.length&&charges.length&&unpaired.length&&charges.every(row=>Math.abs(number(row[1])-request.charge)<1e-7)
    &&unpaired.every(row=>Math.abs(number(row[1])-request.uhf)<1e-7),'g-xTB electronic state evidence does not match the request');
  const spin=rows.at(-1)[1].toLowerCase();
  assert(request.uhf===0||spin==='unrestricted','g-xTB open-shell result lacks unrestricted evidence');
  return spin;
}
function gxtbSinglepointConvergence(stdout,request){
  const limit=sccIterationLimit(request), number=value=>Number(value?.replace(/[dD]/,'e'));
  const energyThreshold=number(/^\s*energy convergence\s+([-+\d.eEdD]+)\s+Eh\s*$/mi.exec(stdout)?.[1]);
  const densityThreshold=number(/^\s*density convergence\s+([-+\d.eEdD]+)\s+e\s*$/mi.exec(stdout)?.[1]);
  const post=/^\s*Post processing:/mi.exec(stdout);
  assert(post&&energyThreshold>0&&densityThreshold>0&&/normal termination of xtb/i.test(stdout),'g-xTB singlepoint setup or normal termination is missing');
  const iterations=[...stdout.slice(0,post.index).matchAll(/^\s*(\d+)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)\s*$/gm)];
  const last=iterations.at(-1), sccIterations=Number(last?.[1]);
  assert(last&&iterations.every((row,i)=>Number(row[1])===i+1)&&sccIterations<=limit&&Math.abs(number(last[3]))<=energyThreshold&&number(last[4])>=0&&number(last[4])<=densityThreshold,'g-xTB SCF did not reach its reported energy and density thresholds');
  const energyHartree=number(/\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|/.exec(stdout.slice(post.index))?.[1]);
  assert(Number.isFinite(energyHartree)&&Math.abs(energyHartree-number(last[2]))<=1e-8,'g-xTB singlepoint final energy differs from its converged SCF');
  return {calculation:'singlepoint',sccIterations,sccIterationLimit:limit,energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',converged:true,convergenceStatus:'converged',spinTreatment:gxtbSpin(stdout,request)};
}
function nativeBondOrders(text,request){
  // Native 5071a property.F90 print_wbofile writes j<i, full list-directed
  // values strictly above .1. Missing pairs are unreported, never fabricated 0.
  assert(request.method==='gfn2'&&typeof text==='string','Invalid GFN2 native wbo source');const atoms=request.structure.atoms;assert(atoms.length>0&&new Set(atoms.map(atom=>atom.id)).size===atoms.length,'Stable ordered atoms required for wbo mapping');
  const entries=[],seen=new Set();let byteBudget=0;
  if(text!==''){assert(text.endsWith('\n'),'Native wbo is truncated (missing final newline)');const lines=text.replaceAll('\r\n','\n').split('\n');lines.pop();assert(lines.length<=atoms.length*(atoms.length-1)/2,'Native wbo pair inventory exceeds its atom count');
    for(const line of lines){const fields=line.trim().split(/\s+/);assert(fields.length===3&&/^[1-9]\d*$/.test(fields[0])&&/^[1-9]\d*$/.test(fields[1]),'Invalid native wbo row or atom indices');const a=Number(fields[0]),b=Number(fields[1]);assert(Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a<=atoms.length&&b<=atoms.length&&a!==b,'Native wbo atom index outside its original structure');const key=[a,b].sort((x,y)=>x-y).join(':');assert(!seen.has(key),'Duplicate or reversed native wbo pair');assert(a<b,'Native wbo pair order differs from the native writer');seen.add(key);assert(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(fields[2]),'Invalid native wbo number');const value=Number(fields[2].replace(/[dD]/,'e'));assert(Number.isFinite(value)&&value>.1,'Native wbo values must be finite and strictly above its reported threshold');const entry={atomIds:[atoms[a-1].id,atoms[b-1].id],value};byteBudget+=Buffer.byteLength(JSON.stringify(entry));entries.push(entry);}
  }
  const result={definition:'mayer-ao',sourceField:'wbo',threshold:.1,entries};boundedJSON(result);return result;
}
module.exports={METHODS,LIMITS,SOLVATION_SOLVENTS,INTERNAL_CONSTRAINT_POLICY,sessionIdentity,validateStart,xyzInput,xcontrolInput,invocation,nativeSolvation,optimizedCoordinates,convergence,singlepointConvergence,gxtbSpin,nativeBondOrders,sccIterationLimit,measure,constraintResiduals,validateNativeConstraints,nativeOptimizationFailure,optimizerFor,createTrajectoryParser,isPeriodic};
