'use strict';
const {assert,plain,boundedJSON,validateStructure,MAX_FINGERPRINT_BYTES}=require('./security.cjs');
const {sessionIdentity}=require('./xtb-security.cjs');
const {cpuResourceSnapshot}=require('./cpu-resources.cjs');
const ELEMENTS='H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' ');
const DEFAULTS=Object.freeze({threads:2,maxWallTimeSeconds:30});
const SEARCH=Object.freeze({maxGenerations:2,maxParents:28,stackPoints:32,angularStepDegrees:90,radialStepBohr:4});
const REFINEMENT=Object.freeze({candidateCount:2,maxSteps:50});
const CALCULATOR=Object.freeze({accuracy:1,maxIterations:250,electronicTemperatureK:300});
const BOHR=.52917726; // Locked reader/wrc2 native conversion, not a new CODATA substitution.
// The Windows bundle's mctc-lib reader can use modern Bohr while this locked
// wrc2 writer is hardcoded above. Bound only that representational roundtrip;
// never rescale the raw pose or forgive an actual internal-coordinate change.
const BOHR_ROUNDTRIP=Math.abs(BOHR/.529177210903-1);
const integer=(n,a,b)=>Number.isSafeInteger(n)&&n>=a&&n<=b;
const finite=(n,a=-1e6,b=1e6)=>typeof n==='number'&&Number.isFinite(n)&&n>=a&&n<=b;
const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
function keys(value,allowed){assert(plain(value)&&Object.keys(value).every(key=>allowed.includes(key)),'Unknown or invalid aISS request field');}
function stamp(value){keys(value,['documentId','revision','activationEpoch','graphFingerprint','coordinatesFingerprint','constraintsFingerprint']);assert(typeof value.documentId==='string'&&value.documentId.length>0&&value.documentId.length<=1024&&!value.documentId.includes('\0')&&integer(value.revision,0,Number.MAX_SAFE_INTEGER)&&(value.activationEpoch===undefined||integer(value.activationEpoch,0,Number.MAX_SAFE_INTEGER))&&['graphFingerprint','coordinatesFingerprint','constraintsFingerprint'].every(key=>typeof value[key]==='string'&&Buffer.byteLength(value[key])<=MAX_FINGERPRINT_BYTES),'Invalid aISS source stamp');}
function diameter(atoms){let max=0;for(let i=0;i<atoms.length;i++)for(let j=0;j<i;j++)max=Math.max(max,Math.hypot(atoms[i].x-atoms[j].x,atoms[i].y-atoms[j].y,atoms[i].z-atoms[j].z));return max/BOHR;}
function validateStart(raw,cpu=cpuResourceSnapshot()){
  boundedJSON(raw);keys(raw,['schema','operation','stamp','runIdentity','sources','method','threads','memoryBudgetBytes','maxWallTimeSeconds','search','refinement','calculator']);
  assert(raw.memoryBudgetBytes===undefined||integer(raw.memoryBudgetBytes,1,Number.MAX_SAFE_INTEGER),'Invalid aISS soft memory budget');
  assert(raw.schema===1&&raw.operation==='aiss-docking'&&raw.method==='gfn2','The first aISS adapter requires GFN2 gas docking');stamp(raw.stamp);keys(raw.runIdentity,['taskId','runId']);sessionIdentity(raw.runIdentity.taskId);sessionIdentity(raw.runIdentity.runId);
  assert(Array.isArray(raw.sources)&&raw.sources.length===2,'aISS requires exactly two complete sources');let total=0;
  for(const source of raw.sources){keys(source,['stamp','structure','charge','uhf']);stamp(source.stamp);const molecule=source.structure;validateStructure(molecule);total+=molecule.atoms.length;
    assert(molecule.atoms.length>0&&!molecule.cell&&!molecule.periodicSource&&(molecule.dimension===undefined||molecule.dimension===3)&&!molecule.bonds?.some(b=>b.image?.some(Boolean)),'aISS requires complete isolated three-dimensional molecules');
    assert(!molecule.modelLayers?.some(layer=>layer.frozen),'aISS does not silently discard frozen source layers');
    assert(source.charge===0&&source.uhf===0&&(molecule.charge==null||molecule.charge===0)&&(molecule.multiplicity==null||molecule.multiplicity===1),'The first aISS adapter requires two explicit neutral closed-shell sources');
    let electrons=0;for(const atom of molecule.atoms){assert(ELEMENTS.includes(atom.element)&&[atom.x,atom.y,atom.z].every(x=>finite(x)),'Unsupported aISS element/coordinate');electrons+=ELEMENTS.indexOf(atom.element)+1;}assert(electrons>0&&electrons%2===0,'aISS source electron count does not match its closed-shell state');
  }assert(total<=500,'aISS combined source exceeds the existing 500-atom request budget');
  for(const field of ['search','refinement','calculator'])assert(raw[field]===undefined||plain(raw[field]),'Invalid aISS parameter group');
  const value={...DEFAULTS,...raw,search:{...SEARCH,...raw.search},refinement:{...REFINEMENT,...raw.refinement},calculator:{...CALCULATOR,...raw.calculator}};
  keys(value.search,Object.keys(SEARCH));keys(value.refinement,Object.keys(REFINEMENT));keys(value.calculator,Object.keys(CALCULATOR));
  const s=value.search,r=value.refinement,c=value.calculator,cores=cpu.physicalCoreCount??cpu.logicalCpuCount;
  assert(integer(cores,1,Number.MAX_SAFE_INTEGER)&&integer(value.threads,1,Math.min(2,cores))&&finite(value.maxWallTimeSeconds,.01,1800),'Invalid aISS thread/wall budget');
  assert(integer(s.maxGenerations,1,10)&&integer(s.maxParents,28,100)&&integer(s.stackPoints,16,250)&&[45,60,90,120,180].includes(s.angularStepDegrees)&&finite(s.radialStepBohr,1,20)&&Math.abs(s.radialStepBohr*100-Math.round(s.radialStepBohr*100))<1e-10,'Invalid bounded aISS screening configuration');
  assert(integer(r.candidateCount,2,Math.min(32,s.maxParents))&&integer(r.maxSteps,1,500),'aISS native refinement needs 2-32 candidates and positive finite optimization cycles');
  assert(c.accuracy===1&&integer(c.maxIterations,1,250)&&c.electronicTemperatureK===300,'Invalid first aISS calculator/SCC budget');
  // A conservative source-size bound for the native rare-gas grid before any
  // allocation. The angular and stack grids have independent fixed bounds.
  const bound=(1+Math.floor((3*diameter(raw.sources[0].structure.atoms)+diameter(raw.sources[1].structure.atoms)+32)/s.radialStepBohr))**3;
  assert(Number.isSafeInteger(bound)&&bound<=250000,'aISS source extent exceeds the bounded radial screening grid');
  boundedJSON(value);return structuredClone(value);
}
function sourceAtomMapping(request){return request.sources.flatMap((source,sourceIndex)=>source.structure.atoms.map((atom,sourceAtomIndex)=>({combinedAtomId:`aiss-${sourceIndex}-${sourceAtomIndex}`,sourceIndex,sourceAtomId:atom.id,sourceAtomIndex,element:atom.element})));}
function xyzInput(source){return source.structure.atoms.length+'\nEster Studio owned aISS source; coordinates in angstrom\n'+source.structure.atoms.map(atom=>[atom.element,atom.x.toPrecision(17),atom.y.toPrecision(17),atom.z.toPrecision(17)].join(' ')).join('\n')+'\n';}
function invocation(r){return ['dock','source-a.xyz','source-b.xyz','--gfn2','--chrg1','0','--chrg2','0','--uhf1','0','--uhf2','0','--maxgen',String(r.search.maxGenerations),'--maxparent',String(r.search.maxParents),'--nstack',String(r.search.stackPoints),'--stepa',String(r.search.angularStepDegrees),'--stepr',String(r.search.radialStepBohr),'--nfinal',String(r.refinement.candidateCount),'--opt','normal','--cycles',String(r.refinement.maxSteps),'--iterations',String(r.calculator.maxIterations),'--etemp','300','--acc','1','--verbose'];}
function parsePoses(text,request,role){
  assert(['screened','refined'].includes(role)&&typeof text==='string'&&Buffer.byteLength(text)<=16*1024*1024&&text.endsWith('\n'),'Invalid or truncated aISS pose source');
  const lines=text.replaceAll('\r\n','\n').split('\n');lines.pop();const mapping=sourceAtomMapping(request),frames=[];let cursor=0;
  while(cursor<lines.length){assert(/^\s*\d+\s*$/.test(lines[cursor])&&Number(lines[cursor++])===mapping.length,'aISS pose atom count changed');const comment=lines[cursor++];assert(typeof comment==='string','Missing aISS pose score');const valueText=role==='screened'?/^\s*SCF done\s+(.+?)\s*$/.exec(comment)?.[1]:comment.trim();assert(typeof valueText==='string'&&numeric.test(valueText),'Invalid aISS pose score syntax');const energy=Number(valueText.replace(/[dD]/,'e'));assert(finite(energy,-1e12,1e12),'Nonfinite aISS pose score');
    const coordinates=mapping.map(map=>{const line=lines[cursor++];assert(typeof line==='string','Partial aISS pose');const fields=line.trim().split(/\s+/);assert(fields.length===4&&fields[0]===map.element&&fields.slice(1).every(x=>numeric.test(x)),'aISS pose atom elements/order changed');const xyz=fields.slice(1).map(x=>Number(x.replace(/[dD]/,'e')));assert(xyz.every(x=>finite(x)),'Nonfinite aISS pose coordinates');return{id:map.combinedAtomId,element:map.element,x:xyz[0],y:xyz[1],z:xyz[2]};});
    if(role==='screened'){let offset=0;for(const source of request.sources){const original=source.structure.atoms;for(let i=0;i<original.length;i++)for(let j=0;j<i;j++){const a=original[i],b=original[j],p=coordinates[offset+i],q=coordinates[offset+j],before=Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),after=Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);assert(Math.abs(before-after)<=2e-8+BOHR_ROUNDTRIP*before+32*Number.EPSILON*Math.max(1,...[a,b,p,q].flatMap(v=>[Math.abs(v.x),Math.abs(v.y),Math.abs(v.z)])),'Rigid aISS screening changed intramolecular geometry');}offset+=original.length;}}
    frames.push(role==='screened'?{poseIndex:frames.length,coordinates,screening:{method:'xTB-IFF',value:energy,unit:'kcal/mol',sourceField:'structures_after_gen.xyz:comment'}}:{candidateIndex:frames.length,coordinates,refinementEnergyHartree:energy,screenedPoseId:null,searchConverged:null,requiresUnbiasedOptimization:true});assert(frames.length<=request.refinement.candidateCount,'aISS pose inventory exceeds the requested count');
  }
  assert(frames.length===request.refinement.candidateCount,'aISS pose inventory is incomplete');if(role==='refined')for(let i=1;i<frames.length;i++)assert(frames[i].refinementEnergyHartree>=frames[i-1].refinementEnergyHartree,'Native refined candidate energies are not sorted');return frames;
}
function outputEvidence(text,r,version,scope='complete'){
  assert(['complete','search-checkpoint'].includes(scope),'Invalid aISS evidence scope');
  let out=text.replaceAll('\r\n','\n');
  if(scope==='search-checkpoint'){
    const boundaries=[...out.matchAll(/^Optimizing[ \t]+\d+[ \t]+best structures with gfn2[ \t]*$/gm)];
    assert(boundaries.length===1,'Missing or ambiguous complete search boundary');
    out=out.slice(0,boundaries[0].index+boundaries[0][0].length)+'\n';
  }
  assert(!/\[ERROR\]|ABNORMAL TERMINATION|FATAL ERROR|FAILED TO CONVERGE/i.test(out),'aISS reported a failed native calculation');
  const match=expression=>{const values=[...out.matchAll(new RegExp(expression,'gm'))];assert(values.length===1,'Missing or ambiguous aISS native setup evidence');return values[0];};
  assert(match('^[ \\t]*\\*[ \\t]+xtb-docking algorithm[ \\t]+(\\d+\\.\\d+\\.\\d+(?:pre)?)\\b[^\\n]*$')[1]===version,'Actual aISS version differs from the trusted runtime');
  const field=(label,expected)=>{const value=match('^[ \\t]*'+label+'[ \\t]*:[ \\t]*([^\\n]+)$')[1].trim();assert(numeric.test(value)&&Number(value.replace(/[dD]/,'e'))===expected,'Actual aISS '+label+' differs from the request');};
  for(let i=0;i<2;i++){field('number of atoms '+(i?'B':'A'),r.sources[i].structure.atoms.length);field('charge of molecule '+(i?'B':'A'),0);field('spin of molecule '+(i?'B':'A'),0);}field('omp threads',r.threads);
  field('# of genetic optimizations',r.search.maxGenerations);field('# of parents',r.search.maxParents);field('# of final geo\\. opts\\.',r.refinement.candidateCount);field('Rare gas grid step size',r.search.radialStepBohr);field('ang step size /deg',r.search.angularStepDegrees);
  assert(match('^ Method for final opts\\.[ \\t]*:[ \\t]*([^\\n]+)$')[1].trim()==='gfn2','aISS refinement method changed');
  assert((out.match(/^[ \t]*Successful[ \t]*$/gm)??[]).length===2&&!/Performing pocket search/.test(out),'aISS monomer preparation or screening route differs');
  const monomerEnergiesHartree=[1,2].map(index=>{const value=match('^[ \\t]*Total gfn2 energy molecule '+index+':[ \\t]*([^\\n]+)$')[1].trim();assert(numeric.test(value),'Invalid monomer reference energy');return Number(value.replace(/[dD]/,'e'));});assert(monomerEnergiesHartree.every(x=>finite(x,-1e12,1e12)),'Invalid monomer energies');
  const section=(start,end)=>{const first=out.indexOf(start);assert(first>=0,'Missing aISS phase');const last=out.indexOf(end,first+start.length);assert(last>first,'Missing aISS phase boundary');return out.slice(first,last);};
  const radialProbePoints=Number(match('^[ \\t]*# probe RG points[ \\t]*:[ \\t]*(\\d+)[ \\t]*$')[1]);assert(integer(radialProbePoints,1,250000),'aISS radial probe budget exceeded');
  const stack=section('Starting stack search','Starting angular search'),angular=section('Starting angular search','genetic optimization algorithm');
  const grid=part=>{const rows=[...part.matchAll(/^[ \t]*Grid points:[ \t]*(\d+)[ \t]*$/gm)];assert(rows.length===1,'Missing or ambiguous aISS grid count');return Number(rows[0][1]);};
  const stackGridPoints=grid(stack),angularGridPoints=grid(angular);assert(stackGridPoints===56*r.search.stackPoints&&angularGridPoints===66*(360/r.search.angularStepDegrees)**3,'aISS stack/angular screening grids differ from the bounded request');
  const genetic=section('genetic optimization algorithm','Optimizing '),generations=[...genetic.matchAll(/^[ \t]*(\d+)[ \t]+([-+\d.]+)[ \t]+([-+\d.]+)[ \t]*$/gm)];assert(generations.length>=1&&generations.length<=r.search.maxGenerations&&generations.every((row,index)=>Number(row[1])===index+1&&finite(Number(row[2]),-1e12,1e12)&&finite(Number(row[3]),-1e12,1e12)),'Invalid aISS genetic generation evidence');
  assert(Number(match('^Optimizing[ \\t]+(\\d+)[ \\t]+best structures with gfn2[ \\t]*$')[1])===r.refinement.candidateCount,'aISS refinement count changed');
  return {engine:'xtb-aiss',version,precomputeMethod:'gfn2',scoreMethod:'xTB-IFF',solvation:'gas',internalRefinement:{method:'gfn2',...r.refinement,optLevel:'normal',convergencePerPose:'not-reported'},calculator:{...r.calculator},search:{...r.search},monomerEnergiesHartree,sourceElectronicStates:[{charge:0,uhf:0},{charge:0,uhf:0}],combinedElectronicState:{charge:0,uhf:0,coupling:'sum-of-unpaired-electrons'},counts:{radialProbePoints,stackGridPoints,angularGridPoints,geneticGenerations:generations.length,refinedCandidates:scope==='complete'?r.refinement.candidateCount:0,evaluations:null}};
}
module.exports={DEFAULTS,SEARCH,REFINEMENT,CALCULATOR,sessionIdentity,validateStart,sourceAtomMapping,xyzInput,invocation,parsePoses,outputEvidence};
