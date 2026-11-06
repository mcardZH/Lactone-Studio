import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createPortableContract,ROOT} from './contract.mjs';
import {buildLauncher} from '../portable/launcher.mjs';
export async function buildLocalLauncher({run,root=ROOT}){
  const file=resolve(root,'desktop/packaging/native-toolchain.lock.json'),bytes=await readFile(file);
  return buildLauncher(createPortableContract({root}),{run,tools:{lock:{path:'desktop/packaging/native-toolchain.lock.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}},executeApproved:true});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [arg]=process.argv.slice(2);assert(/^--run=[a-z][a-z0-9-]*$/.test(arg??''));console.log(JSON.stringify(await buildLocalLauncher({run:arg.slice(6)}),null,2));
}
