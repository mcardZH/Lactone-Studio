/** Re-link the accepted xTB static objects using explicit, hash-locked project
 * inputs. No download, dependency install, inherited PATH, or science is used.
 * The output is recorded, never silently substituted into an accepted runtime. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {absent,ancestors,encoded,identity,projectPath,readFileChecked,sha,stable} from './portable/io.mjs';

export async function relinkPesLibxtb({inputRoot,outputRoot,compiler,lockPath=resolve(import.meta.dirname,'../desktop/packaging/pes-libxtb-runtime.lock.json')}){
 inputRoot=resolve(inputRoot);outputRoot=resolve(outputRoot);compiler=resolve(compiler);
 const lock=JSON.parse(await readFileChecked(lockPath));assert.equal(lock.schema,'ester-pes-libxtb-runtime-lock/v1');assert.equal(lock.version,'6.8.0');
 const rel=relative(inputRoot,outputRoot),reverse=relative(outputRoot,inputRoot);
 assert(rel&&reverse&&!(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel))&&!(reverse!=='..'&&!reverse.startsWith('..'+sep)&&!isAbsolute(reverse)),'Input/output roots must not overlap');
 const compilerBytes=await readFileChecked(compiler);assert.equal(sha(compilerBytes),lock.relink.compiler.sha256,'Compiler differs from the accepted toolchain');
 for(const row of lock.relink.inputs)await readFileChecked(projectPath(inputRoot,row.path),row);
 await absent(outputRoot);const parents=await ancestors(dirname(outputRoot));await mkdir(outputRoot);await stable(parents);
 const input=name=>projectPath(inputRoot,name),output=join(outputRoot,'libxtb-openblas030.dll');
 const args=['cc','-target','x86_64-windows-gnu','-shared','-o',output,input('link/libxtb.def'),'-Wl,--whole-archive',
  input('xtb/lib/libxtb.a'),'-Wl,--no-whole-archive',input('xtb/lib/libcpx.a'),
  input('gnu/lib/libgfortran.dll.a'),input('gnu/lib/libgomp.dll.a'),input('gnu/lib/libquadmath.dll.a'),input('link/libopenblas.a')];
 let stdout='',stderr='';const command={executable:compiler,args,cwd:outputRoot,startedAt:new Date().toISOString(),timedOut:false};
 const ended=await new Promise((done,fail)=>{const child=spawn(compiler,args,{cwd:outputRoot,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:'',TEMP:outputRoot,TMP:outputRoot,ZIG_GLOBAL_CACHE_DIR:join(outputRoot,'zig-global'),ZIG_LOCAL_CACHE_DIR:join(outputRoot,'zig-local')}});const timer=setTimeout(()=>{command.timedOut=true;child.kill();},180000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('close',(code,signal)=>{clearTimeout(timer);done({pid:child.pid,code,signal,closedAt:new Date().toISOString()});});});Object.assign(command,ended);
 await writeFile(join(outputRoot,'stdout.log'),stdout,{flag:'wx'});await writeFile(join(outputRoot,'stderr.log'),stderr,{flag:'wx'});
 await writeFile(join(outputRoot,'execution.json'),encoded(command),{flag:'wx'});assert.equal(command.code,0);assert.equal(command.signal,null);assert.equal(command.timedOut,false);
 const artifact=identity('libxtb-openblas030.dll',await readFileChecked(output));
 for(const row of lock.relink.inputs)await readFileChecked(projectPath(inputRoot,row.path),row);
 const report={schema:'ester-pes-libxtb-relink/v1',passed:true,status:'built-not-automatically-adopted',inputRoot,outputRoot,
  compiler:{path:compiler,sha256:sha(compilerBytes),version:lock.relink.compiler.version},inputs:lock.relink.inputs,command,artifact,
  matchesAcceptedLibrary:artifact.sha256===lock.identity.librarySha256,acceptedLibrarySha256:lock.identity.librarySha256,
  scientificEvaluations:0,globalEnvironmentModified:false};
 await writeFile(join(outputRoot,'relink-receipt.json'),encoded(report),{flag:'wx'});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),options={};assert(args.length%2===0);
 for(let i=0;i<args.length;i+=2){assert(['--input-root','--output-root','--zig','--lock'].includes(args[i]));assert(!options[args[i]]);options[args[i]]=args[i+1];}
 assert(options['--input-root']&&options['--output-root']&&options['--zig'],'Pass --input-root, --output-root and --zig');
 const result=await relinkPesLibxtb({inputRoot:options['--input-root'],outputRoot:options['--output-root'],compiler:options['--zig'],...(options['--lock']?{lockPath:resolve(options['--lock'])}:{})});
 console.log(JSON.stringify({passed:result.passed,artifact:result.artifact,matchesAcceptedLibrary:result.matchesAcceptedLibrary,scientificEvaluations:0}));
}
