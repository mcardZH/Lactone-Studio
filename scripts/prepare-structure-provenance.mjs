// Generate the desktop validator from its sole TypeScript authority.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),generated=join(root,'.cache/generated-structure-provenance');
await mkdir(generated,{recursive:true});
if((await lstat(generated)).isSymbolicLink())throw Error('Generated validator directory must not be a link');
await new Promise((resolvePromise,reject)=>{
  const child=spawn(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--ignoreConfig','src/core/structure-library-provenance.ts','--module','commonjs','--target','es2022','--skipLibCheck','--rootDir','.', '--outDir',generated],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',reject);child.on('close',code=>code===0?resolvePromise():reject(Error('Structure provenance validator generation failed: '+output)));
});
const source=await readFile(join(root,'src/core/structure-library-provenance.ts'));
const code=await readFile(join(generated,'src/core/structure-library-provenance.js'),'utf8');
if(/require\(/.test(code))throw Error('Provenance validator must have no runtime imports');
const header='// Generated from src/core/structure-library-provenance.ts; SHA256 '+createHash('sha256').update(source).digest('hex')+'\n';
await writeFile(join(root,'desktop/structure-library-provenance-runtime.cjs'),header+code.replaceAll('\r\n','\n'));
console.log('Prepared same-source desktop structure provenance validator.');
