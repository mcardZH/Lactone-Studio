'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {assert,plain}=require('./security.cjs');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function validateFixedFf(model,request){
  assert(request.method==='gfnff'&&request.calculation!=='singlepoint'&&!request.structure.cell,'Fixed GFN-FF model requires isolated ordinary optimization');
  assert(plain(model)&&model.schemaVersion===1&&model.method==='gfnff'&&typeof model.modelId==='string'&&model.modelId&&plain(model.reference),'Invalid fixed GFN-FF model');
  assert(model.reference.charge===request.charge&&Number.isSafeInteger(model.reference.multiplicity)&&model.reference.multiplicity>=1&&isDeepStrictEqual(model.solvation,request.solvation),'Fixed GFN-FF electronic state or solvent changed');
  assert(Array.isArray(model.reference.atoms)&&model.reference.atoms.length===request.structure.atoms.length&&Array.isArray(model.atomOrder)&&model.atomOrder.length===request.structure.atoms.length,'Fixed GFN-FF atom membership changed');
  model.reference.atoms.forEach((atom,index)=>{const current=request.structure.atoms[index];assert(plain(atom)&&atom.id===current.id&&atom.element===current.element&&model.atomOrder[index]===current.id&&[atom.x,atom.y,atom.z].every(Number.isFinite),'Fixed GFN-FF atom order changed');});
  assert(model.parameterIdentity===undefined||plain(model.parameterIdentity),'Invalid fixed GFN-FF parameter identity');
}

/** Prepare only the immutable potential; the caller retains its ordinary --opt driver. */
async function prepareFixedFf({session,fs,spawn,env,readRegular,directory,clearTimer,outputLimit}){
  const model=session.request.ffModel;if(!model)return;
  validateFixedFf(model,session.request);
  const parameterFile=path.join(session.runtime.dataDirectory,'.param_gfnff.xtb'),parameterSha256=digest(Buffer.from(await readRegular(parameterFile),'utf8'));
  const saved=model.parameterIdentity;
  if(saved)assert(saved.parameterSha256===parameterSha256&&saved.version===session.runtime.version,'Fixed GFN-FF parameters differ from current ordinary runtime');
  const folder=path.join(session.job,'reference-seed');await fs.mkdir(folder);await directory(folder);
  const input=model.reference.atoms.length+'\nEster Studio fixed GFN-FF reference\n'+model.reference.atoms.map(atom=>[atom.element,atom.x.toPrecision(17),atom.y.toPrecision(17),atom.z.toPrecision(17)].join(' ')).join('\n')+'\n';
  await fs.writeFile(path.join(folder,'reference.xyz'),input,{encoding:'utf8',flag:'wx'});
  if(session.stopReason)return;
  const argv=['reference.xyz','--gfnff','--grad','--parallel',String(session.request.threads),'--chrg',String(session.request.charge),'--verbose','--norestart',...(model.solvation?['--alpb',model.solvation.solvent]:[])];
  let stdout='',stderr='',bytes=0;
  const logs={stdout:await fs.open(path.join(folder,'stdout.log'),'wx'),stderr:await fs.open(path.join(folder,'stderr.log'),'wx')};let writes=Promise.resolve();
  const result=await new Promise((resolve,reject)=>{
    const child=session.child=spawn(session.runtime.executable,argv,{cwd:folder,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    const receive=(stream,chunk)=>{const raw=Buffer.from(chunk);bytes+=raw.length;session.outputBytes+=raw.length;try{session.releaseAdmission?.consumeOutput?.(raw.length);}catch(error){session.stopReason={code:'XTB_OUTPUT_LIMIT',message:error.message};child.kill();}
      if(bytes>outputLimit){session.stopReason={code:'XTB_OUTPUT_LIMIT',message:'GFN-FF reference output exceeded the configured limit'};child.kill();}
      if(stream==='stdout')stdout+=raw.toString('utf8');else stderr+=raw.toString('utf8');writes=writes.then(()=>logs[stream].writeFile(raw));};
    child.stdout.on('data',chunk=>receive('stdout',chunk));child.stderr.on('data',chunk=>receive('stderr',chunk));child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal:signal??null}));
  }).finally(async()=>{await writes;await Promise.all(Object.values(logs).map(handle=>handle.close()));session.child=undefined;clearTimer(session.killTimer);session.killTimer=undefined;});
  const record={schema:1,modelId:model.modelId,referenceSha256:digest(Buffer.from(input)),parameterSha256,engineIdentity:session.runtime.engineIdentity,argv,exit:result};
  await fs.writeFile(path.join(folder,'seed-result.json'),JSON.stringify(record)+'\n',{encoding:'utf8',flag:'wx'});
  if(session.stopReason)return;
  assert(result.code===0&&result.signal===null&&/normal termination of xtb/i.test(stdout+'\n'+stderr),'GFN-FF reference initialization did not terminate normally');
  await readRegular(path.join(folder,'gfnff_topo'));
  // Binary topology is copied as bytes; readRegular above verifies ownership.
  const seedBytes=await fs.readFile(path.join(folder,'gfnff_topo'));assert(seedBytes.length>0,'GFN-FF reference topology is empty');
  await fs.writeFile(path.join(session.job,'gfnff_topo'),seedBytes,{flag:'wx'});
  session.fixedFf={...record,topologySha256:digest(seedBytes)};
}
async function verifyFixedFf(session,fs,readRegular,output){
  if(!session.fixedFf)return;
  await readRegular(path.join(session.job,'gfnff_topo'));
  const bytes=await fs.readFile(path.join(session.job,'gfnff_topo'));
  assert(digest(bytes)===session.fixedFf.topologySha256&&output.includes('GFN-FF topology read from file successfully!')&&!output.includes('generating topology and atomic info file'),'Ordinary optimization did not preserve the fixed GFN-FF topology');
}
module.exports={validateFixedFf,prepareFixedFf,verifyFixedFf};
