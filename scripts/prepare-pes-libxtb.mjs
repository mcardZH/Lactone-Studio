import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareLibxtbRuntime} from './portable/pes-libxtb-runtime.mjs';

export async function preparePesLibxtb({inputRoot,outputRoot,lockPath=resolve(import.meta.dirname,'../desktop/packaging/pes-libxtb-runtime.lock.json')}) {
  const lock=JSON.parse(await readFile(lockPath));return prepareLibxtbRuntime({inputRoot:resolve(inputRoot),outputRoot:resolve(outputRoot),lock});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help')console.log('Usage: node scripts/prepare-pes-libxtb.mjs --input <self-contained-locked-runtime> --output <new-component-root> [--lock <lock.json>]\nCopies and verifies only the explicitly supplied locked libxtb component. No downloads, installation, global PATH changes or science.');
  else{const options={};assert(args.length%2===0);for(let i=0;i<args.length;i+=2){assert(['--input','--output','--lock'].includes(args[i]));assert(!options[args[i]],'Duplicate option');options[args[i]]=args[i+1];}
    assert(options['--input']&&options['--output'],'Pass --input and --output');
    console.log(JSON.stringify(await preparePesLibxtb({inputRoot:options['--input'],outputRoot:options['--output'],...(options['--lock']?{lockPath:resolve(options['--lock'])}:{})}),null,2));}
}
