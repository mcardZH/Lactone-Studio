'use strict';
// User supplied CLI. Inspection runs only --version/--help, never a molecule.
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn: nativeSpawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const os = require('node:os');
const {assert, string} = require('./security.cjs');
const {fileIdentity,digest,assertEngineIdentity} = require('./xtb-runtime-contract.cjs');
const DOWNLOAD_URL = 'https://github.com/grimme-lab/g-xtb/releases';
const KNOWN_EXE = 'c2af5f3db91794cc40b5e38712f28f0d24acb9af040abb0bfb627313e926cff6';
const isSharedLibraryName = name => /\.(?:dll|dylib)$/i.test(name) || /\.so(?:\.\d+)*$/i.test(name);
function environment(directory, dataDirectory, workspace, hasLibDirectory = false) {
  const libPaths = hasLibDirectory ? [path.join(path.dirname(directory), 'lib'), directory] : [directory];
  return {...Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(SystemRoot|WINDIR|SYSTEMDRIVE)$/i.test(name))),
    PATH:directory,XTBPATH:dataDirectory,
    ...(process.platform==='darwin'?{DYLD_FALLBACK_LIBRARY_PATH:[...libPaths,'/usr/lib'].join(':')}:{}),
    ...(process.platform==='linux'?{LD_LIBRARY_PATH:libPaths.join(':')}:{}),
    HOME:workspace,USERPROFILE:workspace,TEMP:workspace,TMP:workspace,LANG:'C',LC_ALL:'C',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'};
}
function probe(spawn, executable, args, directory, dataDirectory, workspace, signal, hasLibDirectory = false) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('GXTB_DETECTION_CANCELLED: g-xTB 程序检查已取消'));return;}
    let output='',error='',closed=false,overflow=false;
    const child=spawn(executable,args,{cwd:workspace,env:environment(directory,dataDirectory,workspace,hasLibDirectory),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>child.kill(),10000);timer.unref?.();
    const collect=key=>chunk=>{if(output.length+error.length+chunk.length>1024*1024){overflow=true;child.kill();return;}if(key==='out')output+=chunk;else error+=chunk;};
    child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'));
    child.once('error',cause=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!closed){closed=true;reject(cause);}});
    child.once('close',(code,exitSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(closed)return;closed=true;if(signal?.aborted){reject(Error('GXTB_DETECTION_CANCELLED: g-xTB 程序检查已取消'));return;}resolve({args,code,signal:exitSignal,stdout:output,stderr:error,overflow});});
  });
}
function createGxtbBackendStore(root,{spawn=nativeSpawn}={}) {
  const location=path.join(root,'gxtb-backend.json');let writing=Promise.resolve(),detectionEpoch=0;
  const machine=digest([os.hostname(),os.homedir(),process.platform,process.arch]);
  // The 1 MiB probe diagnostic may require sixfold JSON escaping plus path metadata.
  // This bound applies only to the local control record, never scientific results.
  async function configuration(){try{const stat=await fs.lstat(location);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=8*1024*1024,'g-xTB 配置文件无效');const value=JSON.parse(await fs.readFile(location,'utf8'));assert(value.schema===1&&(value.path===undefined||string(value.path,4096)),'g-xTB 配置文件无效');return value.machine===machine?value:{schema:1};}catch(error){if(error.code==='ENOENT')return {schema:1};throw error;}}
  async function selected(executable){assert(string(executable,4096)&&path.isAbsolute(executable),'请选择 g-xTB 程序');const actual=await fs.realpath(executable);const stat=await fs.lstat(actual);assert(stat.isFile(),'所选 g-xTB 程序不可用');if(process.platform!=='win32')assert((stat.mode&0o111)!==0,'所选 g-xTB 程序缺少可执行权限 (chmod +x)');return actual;}
  async function inventory(executable){const directory=path.dirname(executable),distribution=path.dirname(directory),dataDirectory=path.join(distribution,'share','xtb'),libDirectory=path.join(distribution,'lib');
    const members=[fileIdentity(directory,path.basename(executable))];
    for(const name of (await fs.readdir(directory)).filter(isSharedLibraryName).sort())members.push(fileIdentity(directory,name));
    let hasLibDirectory=false;
    try{const libStat=await fs.lstat(libDirectory);assert(!libStat.isSymbolicLink()&&libStat.isDirectory(),'g-xTB lib 目录不可为软链接或非目录文件');hasLibDirectory=true;for(const name of (await fs.readdir(libDirectory)).filter(isSharedLibraryName).sort()){const row=fileIdentity(libDirectory,name);members.push({...row,path:'lib/'+name});}}catch(error){if(error.code!=='ENOENT')throw error;}
    let parameters=[];try{const dataStat=await fs.lstat(dataDirectory);assert(!dataStat.isSymbolicLink()&&dataStat.isDirectory(),'g-xTB share/xtb 目录不可为软链接或非目录文件');for(const name of (await fs.readdir(dataDirectory)).sort()){const stat=await fs.lstat(path.join(dataDirectory,name));assert(!stat.isSymbolicLink(),'g-xTB share/xtb 参数文件不可为软链接');if(stat.isFile())parameters.push(fileIdentity(dataDirectory,name));}}catch(error){if(error.code!=='ENOENT')throw error;}
    return {directory,dataDirectory,hasLibDirectory,members,parameters};}
  async function info(){let value;try{value=await configuration();}catch(error){return {configured:false,status:'configuration-invalid',details:String(error.message)};}
    if(!value.path)return {configured:false,status:'unconfigured'};
    // A completed detection is owned by this selected path. Reading settings
    // does not rerun it or turn an actual failure into an unchecked path.
    if(['ready','unsupported','detection-failed'].includes(value.detection?.status))return {configured:true,path:value.path,...value.detection};
    try{const executable=await selected(value.path),files=await inventory(executable);return {configured:true,path:executable,status:'unchecked',...(value.inspection?.executableSha256===files.members[0].sha256&&value.inspection?.runtimeMemberDigest===digest(files.members)&&value.inspection?.parameterDigest===digest(files.parameters)?{status:value.inspection.capable?'ready':'unsupported',hostVersion:value.inspection.hostVersion,gxtbRelease:value.inspection.gxtbRelease,capable:value.inspection.capable,detectionId:value.detection?.detectionId}: {})};}
    catch(error){return {configured:false,path:value.path,status:'program-unavailable',details:String(error.message)};}}
  function update(fields,expectedPath,expectedEpoch){const task=writing.then(async()=>{const value=await configuration().catch(()=>({schema:1}));if(expectedPath!==undefined&&value.path!==expectedPath||expectedEpoch!==undefined&&expectedEpoch!==detectionEpoch)return info();await fs.mkdir(root,{recursive:true});const temporary=location+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify({...value,...fields,machine})+'\n',{encoding:'utf8',flag:'wx'});try{await fs.rename(temporary,location);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}return info();});writing=task.catch(()=>{});return task;}
  async function inspect(executable,signal){executable=await selected(executable);const files=await inventory(executable);await fs.mkdir(root,{recursive:true});const workspace=await fs.mkdtemp(path.join(root,'gxtb-inspect-'));let probes;
    try{probes=[];for(const flag of ['--version','--help'])probes.push(await probe(spawn,executable,[flag],files.directory,files.dataDirectory,workspace,signal,files.hasLibDirectory));}
    finally{await fs.rmdir(workspace).catch(()=>{});}
    const after=await inventory(executable);assert(digest(files)===digest(after),'g-xTB 程序在检测期间发生变化，请重试');
    const output=probes.map(row=>row.stdout+'\n'+row.stderr).join('\n'),help=probes[1];
    assert(!probes.some(row=>row.signal||row.overflow),'g-xTB 检测未正常结束');
    assert(help.code===0,`g-xTB 帮助检查失败（退出码 ${help.code}）。请检查程序权限及官方同包动态库（DLL / dylib / so）。\n${help.stderr}`);
    const capable=help.code===0&&/(?:^|[\s,])--gxtb(?:[\s,=]|$)/m.test(help.stdout+'\n'+help.stderr);
    const host=output.match(/\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)(?:\s+\(([a-f\d]{7,40})\))?/i);
    const release=output.match(/\bg[- ]xtb(?:\s+version|\s+release|\s+v)\s*(\d+\.\d+\.\d+)/i)?.[1]??(files.members[0].sha256===KNOWN_EXE?'2.0.1':null);
    return {executable,files,inspection:{executableSha256:files.members[0].sha256,runtimeMemberDigest:digest(files.members),parameterDigest:digest(files.parameters),capable,hostVersion:host?.[1]??null,hostCommit:host?.[2]??null,gxtbRelease:release},probes};
  }
  async function detect(){const epoch=++detectionEpoch,value=await configuration();if(!value.path)return info();const detectionId=randomUUID();try{const result=await inspect(value.path),{capable,hostVersion,gxtbRelease}=result.inspection;return update({path:result.executable,inspection:result.inspection,detection:{detectionId,status:capable?'ready':'unsupported',capable,hostVersion,gxtbRelease}},value.path,epoch);}catch(error){return update({inspection:undefined,detection:{status:'detection-failed',detectionId,details:String(error.message)}},value.path,epoch);}}
  async function select(executable){const selectedPath=await selected(executable);detectionEpoch++;return update({path:selectedPath,inspection:undefined,detection:undefined});}
  async function resolve({signal}={}){// Capture configuration before any runtime admission wait at the caller.
    const value=await configuration();assert(value.path,'GXTB_NOT_CONFIGURED: 请先在全局设置中配置 g-xTB 程序（用户自备）');
    const {executable,files,inspection}=await inspect(value.path,signal);assert(inspection.capable,'GXTB_CAPABILITY_MISSING: 所选程序未提供 --gxtb 能力，请在全局设置中检测官方 g-xTB 程序');
    const payload={runtimeVariant:'gxtb',provider:'user-external-cli',version:inspection.hostVersion,hostVersion:inspection.hostVersion,hostCommit:inspection.hostCommit,sourceCommit:inspection.hostCommit,gxtbRelease:inspection.gxtbRelease,
      buildId:'external-sha256-'+inspection.executableSha256,executableSha256:inspection.executableSha256,runtimeMemberDigest:inspection.runtimeMemberDigest,parameterDigest:inspection.parameterDigest,
      capabilities:['gxtb-cli'],members:files.members,parameters:files.parameters};
    const engineIdentity=assertEngineIdentity({schema:'sciyue-xtb-engine-identity/v1',engine:'xtb',kind:'external-user-program',...payload,sha256:digest(payload)});
    return {root:path.dirname(files.directory),directory:files.directory,executable,dataDirectory:files.dataDirectory,version:inspection.hostVersion??'unknown',gxtbRelease:inspection.gxtbRelease,hostVersion:inspection.hostVersion,hostCommit:inspection.hostCommit,engineIdentity};
  }
  return {info,select,detect,resolve};
}
async function verifyGxtbRuntime(runtime){
  if(runtime?.engineIdentity?.kind!=='external-user-program')return;
  const identity=assertEngineIdentity(runtime.engineIdentity);
  const libDirectory=path.join(path.dirname(runtime.directory),'lib');
  const actual=[path.basename(runtime.executable),...(await fs.readdir(runtime.directory)).filter(isSharedLibraryName)];
  try{const libStat=await fs.lstat(libDirectory);assert(!libStat.isSymbolicLink()&&libStat.isDirectory(),'GXTB_PROGRAM_CHANGED: g-xTB lib 目录已变化或包含软链接，请重新提交');for(const name of (await fs.readdir(libDirectory)).filter(isSharedLibraryName))actual.push('lib/'+name);}catch(error){if(error.code!=='ENOENT')throw error;}
  actual.sort();
  assert(JSON.stringify(actual)===JSON.stringify(identity.members.map(row=>row.path).sort()),'GXTB_PROGRAM_CHANGED: g-xTB 程序或动态库（DLL / dylib / so）已变化，请重新提交');
  for(const row of identity.members){const fromLib=row.path.startsWith('lib/');const root=fromLib?libDirectory:runtime.directory;const relative=fromLib?row.path.slice(4):row.path;const measured=fileIdentity(root,relative);assert(digest(fromLib?{...measured,path:row.path}:measured)===digest(row),'GXTB_PROGRAM_CHANGED: g-xTB 程序或参数已变化，请重新提交');}
  try{const dataStat=await fs.lstat(runtime.dataDirectory);assert(!dataStat.isSymbolicLink()&&dataStat.isDirectory(),'GXTB_PROGRAM_CHANGED: g-xTB 参数目录不可为软链接，请重新提交');const actualParams=[];for(const name of (await fs.readdir(runtime.dataDirectory)).sort()){const stat=await fs.lstat(path.join(runtime.dataDirectory,name));assert(!stat.isSymbolicLink(),'GXTB_PROGRAM_CHANGED: g-xTB 参数文件不可为软链接，请重新提交');if(stat.isFile())actualParams.push(name);}assert(JSON.stringify(actualParams)===JSON.stringify(identity.parameters.map(row=>row.path).sort()),'GXTB_PROGRAM_CHANGED: g-xTB 程序或参数已变化，请重新提交');}catch(error){if(error.code!=='ENOENT'||identity.parameters.length>0)throw error;}
  for(const row of identity.parameters)assert(digest(fileIdentity(runtime.dataDirectory,row.path))===digest(row),'GXTB_PROGRAM_CHANGED: g-xTB 程序或参数已变化，请重新提交');
}
module.exports={createGxtbBackendStore,verifyGxtbRuntime,DOWNLOAD_URL};
