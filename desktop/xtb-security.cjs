'use strict';
const { assert, plain, string, boundedJSON, validateStructure, validateEmpiricalBondParameters, MAX_FINGERPRINT_BYTES } = require('./security.cjs');
const { cpuResourceSnapshot } = require('./cpu-resources.cjs');
const { validateOptimizationPool } = require('./candidate-pool-admission.cjs');

const METHODS = Object.freeze(['gfn0', 'gfn1', 'gfn2', 'gfnff']);
const LIMITS = Object.freeze({ maxSteps: Number.MAX_SAFE_INTEGER, maxWallTimeSeconds: Number.MAX_VALUE, threads: cpuResourceSnapshot().logicalCpuCount });
// Canonical CLI names from locked upstream 5071a886 src/solv/model.f90.
// GFN0 has no dedicated parameterization; FF GBSA would borrow GFN2 values.
// Neither fallback is exposed as a supported scientific combination.
const ALPB_SOLVENTS=Object.freeze(['acetone','acetonitrile','aniline','benzaldehyde','benzene','ch2cl2','chcl3','cs2','dioxane','dmf','dmso','ethanol','ether','ethylacetate','furane','hexadecane','hexane','methanol','nitromethane','octanol','woctanol','phenol','toluene','thf','water']);
const GBSA_SOLVENTS=Object.freeze(['acetone','acetonitrile','benzene','ch2cl2','chcl3','cs2','dmso','ether','water','methanol','thf','toluene']);
const SOLVATION_SOLVENTS=Object.freeze({alpb:Object.freeze({gfn1:ALPB_SOLVENTS,gfn2:ALPB_SOLVENTS,gfnff:ALPB_SOLVENTS}),gbsa:Object.freeze({gfn1:GBSA_SOLVENTS,gfn2:Object.freeze([...GBSA_SOLVENTS,'dmf','hexane'])})});
// xTB 5071a886 scanparam.f90 defaults to 0.05. This bounded application policy
// was tested with real B/A/D and coupled fixtures; acceptance still measures
// every native result, since a stronger harmonic potential is not exact fixing.
const INTERNAL_CONSTRAINT_POLICY = Object.freeze({ forceConstant: 20, forceConstantUnit: 'hartree/bohr^2', bondToleranceAngstrom: 0.001, angleToleranceDegree: 0.1 });
const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
function sessionIdentity(value) { assert(string(value,100) && /^[A-Za-z0-9_-]+$/.test(value),'Invalid xTB session identity'); return value; }
function validateStart(value, cpuResources = cpuResourceSnapshot()) {
  boundedJSON(value);assert(plain(value),'Invalid xTB request');
  const keys=['stamp','structure','method','calculation','charge','uhf','frozenAtomIds','constraints','internalConstraintsConfirmed','maxSteps','maxSccIterations','maxWallTimeSeconds','threads','memoryBudgetBytes','empiricalBondParameters','electronicProperties','runIdentity','solvation','optimizationPool'];
  assert(Object.keys(value).every(key=>keys.includes(key)),'Unknown xTB request field');assert(METHODS.includes(value.method),'Invalid xTB method');
  assert(value.memoryBudgetBytes===undefined||Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>0,'Invalid xTB soft memory budget');
  if(value.empiricalBondParameters!==undefined)validateEmpiricalBondParameters(value.empiricalBondParameters);
  const calculation=value.calculation??'optimize';assert(['optimize','singlepoint'].includes(calculation),'Invalid xTB calculation');assert(calculation!=='singlepoint'||value.method==='gfn2','Only GFN2 singlepoint is supported');
  validateOptimizationPool({...value,calculation});
  if(value.runIdentity!==undefined){assert(plain(value.runIdentity)&&Object.keys(value.runIdentity).length===2&&Object.keys(value.runIdentity).every(key=>['taskId','runId'].includes(key)),'Invalid xTB task/run identity');sessionIdentity(value.runIdentity.taskId);sessionIdentity(value.runIdentity.runId);}
  const stamp=value.stamp;assert(plain(stamp)&&string(stamp.documentId)&&Number.isSafeInteger(stamp.revision)&&stamp.revision>=0&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(key=>typeof stamp[key]==='string'),'Invalid xTB document stamp');
  assert(stamp.activationEpoch===undefined||Number.isSafeInteger(stamp.activationEpoch)&&stamp.activationEpoch>=0,'Invalid xTB activation epoch');
  const ids=validateStructure(value.structure),atoms=value.structure.atoms;assert(atoms.length>0,'xTB requires a nonempty molecule');
  assert(value.structure.dimension===undefined||value.structure.dimension===3,'xTB requires three-dimensional coordinates');
  assert(value.structure.periodicSource?.completeness!=='partial','xTB requires a complete cell, not partial translation vectors');
  if(value.structure.cell!==undefined){const cell=value.structure.cell;assert(plain(cell)&&Array.isArray(cell.pbc)&&cell.pbc.length===3&&cell.pbc.every(flag=>typeof flag==='boolean')&&Array.isArray(cell.vectors)&&cell.vectors.length===3&&cell.vectors.every(vector=>Array.isArray(vector)&&vector.length===3&&vector.every(number=>Number.isFinite(number)&&Math.abs(number)<=1e6)),'xTB requires a finite complete cell');assert(cell.origin===undefined||Array.isArray(cell.origin)&&cell.origin.length===3&&cell.origin.every(Number.isFinite),'Invalid box origin');const [a,b,c]=cell.vectors,det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);assert(!cell.pbc.some(Boolean)||Number.isFinite(det)&&Math.abs(det)>1e-8,'xTB requires a nonsingular periodic cell');}
  const periodic=isPeriodic(value);assert(periodic||!value.structure.bonds?.some(bond=>bond.image?.some(number=>number!==0)),'Image bonds require a periodic cell');
  if(value.solvation!==undefined){const solvation=value.solvation;assert(plain(solvation)&&Object.keys(solvation).length===2&&Object.keys(solvation).every(key=>['model','solvent'].includes(key))&&['alpb','gbsa'].includes(solvation.model)&&typeof solvation.solvent==='string','Invalid xTB solvation request');assert(!periodic,'Implicit solvation is restricted to isolated structures');assert(SOLVATION_SOLVENTS[solvation.model][value.method]?.includes(solvation.solvent),'Solvation model/solvent is not parametrized for the selected xTB method');}
  assert(value.electronicProperties===undefined||typeof value.electronicProperties==='boolean','Invalid xTB electronic properties option');
  assert(!value.electronicProperties||calculation==='singlepoint'&&value.method==='gfn2'&&!periodic,'Electronic properties require an isolated GFN2 singlepoint');
  if(periodic){assert(!(value.constraints??[]).length,'Periodic internal-coordinate constraints are not verified; explicitly adjust this request before running');}
  for(const atom of atoms)assert(ELEMENTS.includes(atom.element)&&[atom.x,atom.y,atom.z].every(number=>Math.abs(number)<=1e6),'Invalid xTB element or coordinate bound');
  assert(Number.isSafeInteger(value.charge)&&Math.abs(value.charge)<=100,'Explicit integer xTB charge required');
  const electrons=atoms.reduce((sum,atom)=>sum+ELEMENTS.indexOf(atom.element)+1,0)-value.charge;assert(electrons>0,'Invalid xTB electron count');
  if(value.method==='gfnff')assert(value.uhf===undefined||value.uhf===0,'GFNFF has no spin treatment');
  else assert(Number.isSafeInteger(value.uhf)&&value.uhf>=0&&value.uhf<=electrons&&(electrons-value.uhf)%2===0,'Explicit UHF must match electron count and parity');
  const frozen=value.frozenAtomIds??[],constraints=value.constraints??[];assert(Array.isArray(frozen)&&new Set(frozen).size===frozen.length&&frozen.every(id=>ids.has(id)),'Invalid xTB frozen atom identities');
  assert(Array.isArray(constraints),'Invalid xTB native constraints');const seen=new Set();
  for(const row of constraints){assert(plain(row)&&Object.keys(row).every(key=>['id','objectId','type','atomIds','action','steps','increment','source','value'].includes(key))&&['B','A','D'].includes(row.type)&&row.action==='freeze','xTB accepts only native B/A/D freeze constraints');const count={B:2,A:3,D:4}[row.type];assert(Array.isArray(row.atomIds)&&row.atomIds.length===count&&new Set(row.atomIds).size===count&&row.atomIds.every(id=>ids.has(id)),'Invalid xTB constraint atom identities');assert(row.id===undefined||string(row.id),'Invalid xTB constraint identity');assert(row.objectId===undefined||string(row.objectId),'Invalid xTB coordinate object identity');assert(row.source===undefined||row.source==='orca','Invalid xTB constraint source');assert(row.steps===undefined||row.steps===0||row.steps===1,'xTB cannot run coordinate scans');assert(row.increment===undefined||row.increment===null,'xTB cannot run coordinate scans');assert(row.value===undefined||Number.isFinite(row.value)&&(row.type==='B'?row.value>0&&row.value<=1e6:row.type==='A'?row.value>=0&&row.value<=180:Math.abs(row.value)<=180),'Invalid xTB native target or angle unit');const forward=row.atomIds.join('\0'),reverse=[...row.atomIds].reverse().join('\0'),key=row.type+':'+(forward<reverse?forward:reverse);assert(!seen.has(key),'Duplicate xTB native constraint');seen.add(key);if(calculation==='optimize')measure(row,atoms);}
  assert(calculation==='singlepoint'||!constraints.length||value.internalConstraintsConfirmed===true,'Native internal-coordinate constraints require confirmation for every start');
  const maxSteps=value.maxSteps??500,maxSccIterations=value.maxSccIterations??250,maxWallTimeSeconds=value.maxWallTimeSeconds,threads=value.threads??2;
  const threadLimit=cpuResources.logicalCpuCount;
  assert(Number.isSafeInteger(maxSteps)&&maxSteps>=1,'Invalid xTB step budget');assert(Number.isSafeInteger(maxSccIterations)&&maxSccIterations>=1,'Invalid xTB SCC iteration budget');assert(maxWallTimeSeconds===undefined||Number.isFinite(maxWallTimeSeconds)&&maxWallTimeSeconds>0,'Invalid xTB wall budget');assert(Number.isSafeInteger(threadLimit)&&threadLimit>=1&&Number.isSafeInteger(threads)&&threads>=1&&threads<=threadLimit,'Invalid xTB thread budget');
  const normalized={...value,calculation,frozenAtomIds:frozen,constraints:calculation==='singlepoint'?constraints:constraints.map(row=>({...row,value:row.value??measure(row,atoms)})),maxSteps,maxSccIterations,maxWallTimeSeconds,threads};boundedJSON(normalized);return structuredClone(normalized);
}
function xyzInput(request){return request.structure.atoms.length+'\nEster Studio owned xTB preoptimization; coordinates in angstrom\n'+request.structure.atoms.map(atom=>[atom.element,atom.x.toPrecision(17),atom.y.toPrecision(17),atom.z.toPrecision(17)].join(' ')).join('\n')+'\n';}
// The approved xTB run uses the complete current box as XYZ; source axes stay untouched.
function isPeriodic(request){return Boolean(request.structure.cell);}
function optimizerFor(request){return request.frozenAtomIds.length?'inertial':'rf';}
function xcontrolInput(request){
  if(request.calculation==='singlepoint')return '';
  // Native FIRE keeps fixed Cartesian gradient components in Cartesian space.
  // The actual translated-fix probe rejected default RF/ANC atom movement;
  // no output alignment, per-atom correction or constraint tolerance is added.
  const index=new Map(request.structure.atoms.map((atom,i)=>[atom.id,i+1])),lines=['$opt','  engine='+optimizerFor(request),'  maxcycle='+request.maxSteps];
  if(request.frozenAtomIds.length)lines.push('$fix','  atoms: '+request.frozenAtomIds.map(id=>index.get(id)).join(','));
  if(request.constraints.length){lines.push('$constrain','  force constant='+INTERNAL_CONSTRAINT_POLICY.forceConstant);for(const row of request.constraints)lines.push('  '+{B:'distance',A:'angle',D:'dihedral'}[row.type]+': '+row.atomIds.map(id=>index.get(id)).join(', ')+', '+row.value.toPrecision(17));}
  return lines.concat('$end','').join('\n');
}
function sccIterationLimit(request){return request.maxSccIterations??250;}
function invocation(request){const sp=request.calculation==='singlepoint';return ['input.xyz',...(request.method==='gfnff'?['--gfnff']:['--gfn',request.method.slice(3)]),...(sp?['--scc']:['--opt']),...(['gfn1','gfn2'].includes(request.method)?['--iterations',String(sccIterationLimit(request))]:[]),'--chrg',String(request.charge),...(request.method==='gfnff'?[]:['--uhf',String(request.uhf)]),...(sp?[]:['--input','xcontrol.inp']),...(request.electronicProperties?['--molden']:[]),'--norestart','--parallel',String(request.threads),...(request.solvation?['--'+request.solvation.model,request.solvation.solvent]:[])];}
function nativeSolvation(stdout,request){
  const output=stdout.replaceAll('\r\n','\n'),markers=[...output.matchAll(/^[ \t]*\*[ \t]+Solvation model:[ \t]+([^\n]+)$/gm)];
  if(request.solvation===undefined){assert(!/^[ \t]*\*?[ \t]*Solvation model:/m.test(output),'Gas-phase xTB request unexpectedly used a solvation model');return undefined;}
  assert(markers.length===1,'Actual native solvation setup is missing or ambiguous');
  const expected=request.solvation,tail=output.slice(markers[0].index,markers[0].index+8192),end=/^[ \t]+Grid points[ \t]+\d+[ \t]+per atom[ \t]*$/m.exec(tail);assert(end,'Native solvation setup is truncated');const block=tail.slice(0,end.index);
  // Locked upstream info() uses 8x,a,t40: labels occupy columns 9–39 and
  // values start at column 40. Prefix matching would also consume Solvent mass.
  const field=label=>{const rows=block.split('\n').filter(line=>line.startsWith('        ')&&line.slice(8,39).trimEnd()===label);assert(rows.length===1,'Native solvation '+label+' is missing or ambiguous');return rows[0].slice(39).trim();};
  const parameterSet='internal '+{gfn1:'GFN1-xTB',gfn2:'GFN2-xTB',gfnff:'GFN-FF'}[request.method]+'/'+expected.model.toUpperCase(),kernel=expected.model==='alpb'?'p16':'still';
  assert(markers[0][1].trim()===expected.model.toUpperCase()&&field('Solvent')===expected.solvent,'Native solvation model or solvent differs from the request');
  assert(field('Parameter file')===parameterSet,'Native solvation parameter set differs from the fixed internal parameterization');
  assert(field('Interaction kernel')===(kernel==='p16'?'P16':'Still'),'Native solvation interaction kernel differs from the request');
  assert(field('Reference state')==='gsolv [1 M gas/solution]','Native solvation reference state differs from the fixed default');
  const temperature=field('Temperature'),numeric=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?)[ \t]+K$/.exec(temperature);assert(numeric&&Number(numeric[1].replace(/[dD]/,'e'))===298.15,'Native solvation temperature differs from the fixed default');
  return {model:expected.model,solvent:expected.solvent,kernel,referenceState:'gsolv',temperatureKelvin:298.15,parameterSet,sourceField:'stdout:solvation-model'};
}
function optimizedCoordinates(text,request){
  assert(typeof text==='string','Invalid optimized XYZ output');const lines=text.replaceAll('\r\n','\n').trimEnd().split('\n');assert(/^\s*\d+\s*$/.test(lines[0])&&Number(lines[0])===request.structure.atoms.length&&lines.length===request.structure.atoms.length+2,'Optimized XYZ must retain the exact atom count');
  const fixed=new Set(request.frozenAtomIds);return request.structure.atoms.map((atom,index)=>{const fields=lines[index+2].trim().split(/\s+/);assert(fields.length===4&&fields[0]===atom.element,'Optimized XYZ element/order changed');assert(fields.slice(1).every(value=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(value)),'Invalid native XYZ numeric syntax');const xyz=fields.slice(1).map(value=>Number(value.replace(/[dD]/,'e')));assert(xyz.every(value=>Number.isFinite(value)&&Math.abs(value)<=1e6),'Nonfinite or unsafe optimized coordinate');if(fixed.has(atom.id)){assert(xyz.every((value,i)=>Math.abs(value-atom[['x','y','z'][i]])<=1e-7),'Strictly fixed atom moved in xTB output');return {id:atom.id,element:atom.element,x:atom.x,y:atom.y,z:atom.z};}return{id:atom.id,element:atom.element,x:xyz[0],y:xyz[1],z:xyz[2]};});
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
function constraintResiduals(request,coordinates){return request.constraints.map(row=>{const actual=measure(row,coordinates),delta=actual-row.value;return {...row,target:row.value,actual,residual:row.type==='D'?((delta+180)%360+360)%360-180:delta,unit:row.type==='B'?'angstrom':'degree',mode:'native-harmonic'};});}
function acceptedConstraintResiduals(request,coordinates){
  const residuals=constraintResiduals(request,coordinates);
  for(const row of residuals){
    const tolerance=row.type==='B'?INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom:INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree;
    assert([row.target,row.actual,row.residual].every(Number.isFinite),'xTB internal constraint measurement is nonfinite');
    assert(Math.abs(row.residual)<=tolerance,`xTB内坐标冻结未达标：${row.type} ${row.atomIds.join('-')} 偏差 ${Math.abs(row.residual).toPrecision(6)} ${row.unit}，超过 ${tolerance} ${row.unit}；保留原模型。`);
  }
  return residuals;
}
function convergence(stdout,request){
  assert(!/FAILED TO CONVERGE|ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR/i.test(stdout),'xTB reported a failed calculation');const matches=[...stdout.matchAll(/^\s*\*{3}\s+GEOMETRY OPTIMIZATION CONVERGED AFTER\s+(\d+)\s+(ITERATIONS|CYCLES)\s+\*{3}\s*$/gm)];assert(matches.length===1,'Actual xTB optimization convergence evidence missing');const optimizer=optimizerFor(request);assert(matches[0][2]===(optimizer==='inertial'?'CYCLES':'ITERATIONS'),'Native convergence counter must match its selected optimizer');assert(optimizer==='inertial'?/Fast Inertial Relaxation Engine/.test(stdout):/RF solver/.test(stdout),'Actual selected native optimizer setup missing');const iterations=Number(matches[0][1]);assert(Number.isSafeInteger(iterations)&&iterations>=0&&iterations<=request.maxSteps,'xTB convergence exceeds the step budget');
  const energies=[...stdout.matchAll(/\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|/g)],energyHartree=Number(energies.at(-1)?.[1].replace(/[dD]/,'e'));assert(Number.isFinite(energyHartree)&&energies.at(-1).index>matches[0].index,'Actual final xTB energy after convergence missing');return {calculation:'optimize',optimizer,iterations,convergenceCounterUnit:matches[0][2].toLowerCase(),energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',converged:true};
}
function singlepointConvergence(stdout,request){
  assert(request.method==='gfn2'&&request.calculation==='singlepoint','GFN2 singlepoint request required');assert(!/FAILED TO CONVERGE|convergence criteria cannot be satisfied|ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR/i.test(stdout),'xTB reported a failed singlepoint');assert(!/GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver/.test(stdout),'Singlepoint must not execute a geometry optimizer');
  const rows=[...stdout.matchAll(/^\s*\*{3}\s+convergence criteria satisfied after\s+(\d+)\s+iterations\s+\*{3}\s*$/gm)];assert(rows.length===1,'Actual GFN2 SCC convergence evidence missing');const sccIterations=Number(rows[0][1]),limit=sccIterationLimit(request);assert(Number.isSafeInteger(sccIterations)&&sccIterations>=1&&sccIterations<=limit,'Singlepoint exceeds its SCC iteration budget');
  const energies=[...stdout.matchAll(/\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|/g)],energyHartree=Number(energies.at(-1)?.[1].replace(/[dD]/,'e'));assert(Number.isFinite(energyHartree)&&energies.at(-1).index>rows[0].index,'Actual singlepoint total energy after SCC convergence missing');return {calculation:'singlepoint',sccIterations,sccIterationLimit:limit,energyHartree,energyUnit:'hartree',coordinateUnit:'angstrom',converged:true};
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
module.exports={METHODS,LIMITS,SOLVATION_SOLVENTS,INTERNAL_CONSTRAINT_POLICY,sessionIdentity,validateStart,xyzInput,xcontrolInput,invocation,nativeSolvation,optimizedCoordinates,convergence,singlepointConvergence,nativeBondOrders,sccIterationLimit,measure,constraintResiduals,acceptedConstraintResiduals,optimizerFor,createTrajectoryParser,isPeriodic};
