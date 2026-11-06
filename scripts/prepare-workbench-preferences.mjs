// Generate the DOM-free preferences validator from its single TS authority.
// The desktop package ships this CJS output, never a compiler or TS runtime.
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),generated=join(root,'.cache/generated-workbench');
await mkdir(generated,{recursive:true});
if((await lstat(generated)).isSymbolicLink())throw Error('Generated validator directory must not be a link');
await new Promise((resolvePromise,reject)=>{
 const child=spawn(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--ignoreConfig','src/modeling/workbench-layout.ts','--module','commonjs','--target','es2022','--resolveJsonModule','--esModuleInterop','--skipLibCheck','--rootDir','.', '--outDir',generated],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',reject);child.on('close',code=>code===0?resolvePromise():reject(Error('Preference validator generation failed: '+output)));
});
const source=await readFile(join(root,'src/modeling/workbench-layout.ts'));
let code=await readFile(join(generated,'src/modeling/workbench-layout.js'),'utf8');
if(!code.includes('require("../../desktop/workbench-actions.json")'))throw Error('Generated validator import differs');
code=code.replace('require("../../desktop/workbench-actions.json")','require("./workbench-actions.json")');
const header='// Generated from src/modeling/workbench-layout.ts; SHA256 '+createHash('sha256').update(source).digest('hex')+'\n';
await writeFile(join(root,'desktop/workbench-layout-runtime.cjs'),header+code.replaceAll('\r\n','\n'));
console.log('Prepared same-source desktop workbench preferences validator.');
