'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {assert}=require('./security.cjs');

const SOURCE='https://github.com/grimme-lab/xtb/blob/5071a8869720fb0ecd788af977159869b64a277c/src/bias_path.f90';
function xyz(atoms,comment){return `${atoms.length}\n${comment}\n${atoms.map(a=>`${a.element} ${a.x.toPrecision(17)} ${a.y.toPrecision(17)} ${a.z.toPrecision(17)}`).join('\n')}\n`;}
function parsePath(text,atoms){
  const lines=text.replace(/\r/g,'').trimEnd().split('\n'),frames=[],comments=[];let i=0;
  while(i<lines.length){
    assert(/^\s*\d+\s*$/.test(lines[i])&&Number(lines[i++])===atoms.length,'BPP partial or reordered atom frame');
    assert(i<lines.length,'BPP missing comment');comments.push(lines[i++]);const positions=[];
    for(const atom of atoms){const fields=lines[i++]?.trim().split(/\s+/);assert(fields?.length===4&&fields[0]===atom.element,'BPP atom order/element changed');const p=fields.slice(1).map(x=>Number(x.replace(/[dD]/g,'e')));assert(p.every(x=>Number.isFinite(x)&&Math.abs(x)<=1e6),'BPP nonfinite coordinate');positions.push(p);}
    frames.push(positions);
  }assert(frames.length>=3,'BPP complete path required');return{frames,comments};
}
function controls(request){
  const b=request.neb.bpp;
  // nrun is refinement count, not a physical E/F evaluation limit. The fixed
  // source searches up to 4 alpha x 6 force-constant trials internally.
  // Keep the existing input, but do not claim this $opt maxcycle limits those
  // trials: bias_path passes zero directly to ANCopt, which uses get_optthr.
  return `$path\n nrun=1\n npoint=${b.npoint}\n anopt=${b.anopt}\n kpush=${b.kpush}\n kpull=${b.kpull}\n ppull=${b.ppull}\n alp=${b.alp}\n$opt\n maxcycle=${request.maxSteps}\n$end\n`;
}
function pathStatistics(text){
  const out=text.replace(/\r/g,''),trials=[...out.matchAll(/^run\s*(\d+)\s+barrier:/gm)],selected=[...out.matchAll(/^path\s+(\d+)\s+taken with\s+(\d+)\s+points\./gm)],refinement=[...out.matchAll(/^refinement cycle\s*(\d+)\s*$/gm)];
  const valid=trials.length>0&&trials.length<=24&&trials.every((row,i)=>Number(row[1])===i+1),chosen=selected.length===1?selected[0]:null;
  return{actualTrialCount:valid?trials.length:null,selectedTrial:chosen&&valid&&Number(chosen[1])<=trials.length&&Number(chosen[1])>0?Number(chosen[1]):null,selectedFrameCount:chosen&&Number(chosen[2])>=3?Number(chosen[2]):null,actualPathFrameCount:null,actualRefinementRuns:refinement.length&&refinement.every((row,i)=>Number(row[1])===i+1)?refinement.length:null};
}
async function directory(fs,target){const absolute=path.resolve(target),parsed=path.parse(absolute);let cursor=parsed.root;for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{await fs.mkdir(cursor);}catch(error){if(error.code!=='EEXIST')throw error;}const stat=await fs.lstat(cursor);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'BPP job parent must be an ordinary directory');}}
async function generateBpp({request,runtime,jobRoot,fs,spawn,onChild,onClosed,check}){
  assert(path.isAbsolute(jobRoot)&&runtime&&path.isAbsolute(runtime.executable)&&path.isAbsolute(runtime.directory)&&path.isAbsolute(runtime.dataDirectory),'Trusted xTB runtime/jobRoot required');
  await directory(fs,jobRoot);check();const job=path.join(jobRoot,`path-bpp-${randomUUID()}`);await fs.mkdir(job);check();
  const atoms=request.structure.atoms,products=new Map(request.neb.product.atoms.map(a=>[a.id,a])),mapping=new Map(request.neb.mapping.map(m=>[m.reactantAtomId,m.productAtomId]));
  await fs.writeFile(path.join(job,'input.xyz'),xyz(atoms,'Ester Studio immutable reactant'),{flag:'wx'});
  await fs.writeFile(path.join(job,'product.xyz'),xyz(atoms.map(a=>products.get(mapping.get(a.id))),'Ester Studio mapped product'),{flag:'wx'});
  await fs.writeFile(path.join(job,'path.inp'),controls(request),{flag:'wx'});check();
  const args=['input.xyz','--gfn',request.method==='gfn1'?'1':'2','--path','product.xyz','--input','path.inp','--chrg',String(request.charge),'--uhf',String(request.uhf),'--norestart','--parallel',String(request.threads)];
  let stdout='',stderr='',bytes=0,failure;
  const child=spawn(runtime.executable,args,{cwd:job,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PATH:runtime.directory+path.delimiter+(process.env.PATH??''),XTBPATH:runtime.dataDirectory,XTBHOME:runtime.root,OMP_NUM_THREADS:String(request.threads),OPENBLAS_NUM_THREADS:String(request.threads),MKL_NUM_THREADS:String(request.threads)}});
  onChild(child);
  const result=await new Promise(resolve=>{
    const consume=(key,chunk)=>{bytes+=Buffer.byteLength(chunk);if(key==='out')stdout+=chunk;else stderr+=chunk;};
    child.stdout.on('data',chunk=>consume('out',chunk));child.stderr.on('data',chunk=>consume('err',chunk));child.stdin.on('error',()=>{});
    child.once('error',error=>{failure=error;});child.once('close',(code,signal)=>resolve({code,signal:signal??null}));
  });onClosed(child); // Only real close may clear the active native child.
  await fs.writeFile(path.join(job,'stdout.txt'),stdout,{flag:'wx'});await fs.writeFile(path.join(job,'stderr.txt'),stderr,{flag:'wx'});
  const evidence={driver:'xtb-rmsd-bpp',source:SOURCE,defaultsReference:'https://xtb-docs.readthedocs.io/en/latest/path.html',version:runtime.version,diagnosticDirectory:job,physicalEvaluationCount:null,evaluationBudgetScope:'subsequent-tblite-neb-ts-only',maximumBiasTrials:24,refinementRuns:1,nativeControls:{...request.neb.bpp,trialOptimizationMaxCycles:null,requestedMaxSteps:request.maxSteps,requestMaxStepsAppliedToSearch:false},searchTrialCycleControl:{source:'locked-get_optthr-with-zero-maxcycle-input',minimum:200,maximum:10000,optLevelDependent:true,observed:false},...pathStatistics(stdout),sourceFixedControls:{singlepointAccuracy:2,maximumDisplacementBohr:.5,hlow:.03},argv:args,exit:result};
  let parsed;
  try{
    check();
    assert(!failure&&result.code===0&&result.signal===null&&/path\s+\d+\s+taken with\s+\d+\s+points/i.test(stdout)&&/estimated TS on file\s+xtbpath_ts\.xyz/i.test(stdout),'xTB-BPP did not close with a complete selected path');
    const target=path.join(job,'xtbpath.xyz'),stat=await fs.lstat(target);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0,'BPP selected path is not an owned regular file');
    parsed=parsePath(await fs.readFile(target,'utf8'),atoms);evidence.actualPathFrameCount=parsed.frames.length;
  }finally{await fs.writeFile(path.join(job,'process.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});}
  return{...parsed,evidence:{...evidence,rawCommentsUnit:'relative-kcal/mol-source-comments-not-reused-as-physical-energy',sourceFile:'xtbpath.xyz'}};
}
module.exports={generateBpp,parsePath,controls,xyz,pathStatistics};
