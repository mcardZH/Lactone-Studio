import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
export async function prepareSandboxPreload(base=root){
  const helper=await readFile(resolve(base,'desktop/preload-managed-results.cjs'),'utf8');
  if(!helper.includes('module.exports = { hydrateManagedResult };'))throw new Error('Unknown managed-result preload export');
  const begin='// BEGIN GENERATED MANAGED RESULT HYDRATOR',end='// END GENERATED MANAGED RESULT HYDRATOR';
  const body=`${begin}\nconst {hydrateManagedResult}=(()=>{\n${helper.replace('module.exports = { hydrateManagedResult };','return { hydrateManagedResult };').trim()}\n})();\n${end}`;
  const file=resolve(base,'desktop/preload.cjs'),current=await readFile(file,'utf8');
  const start=current.indexOf(begin),finish=current.indexOf(end,start);
  let next;
  if(start>=0&&finish>=start)next=current.slice(0,start)+body+current.slice(finish+end.length);
  else {const marker="const {hydrateManagedResult}=require('./preload-managed-results.cjs');";if(!current.includes(marker))throw new Error('Managed-result preload insertion point missing');next=current.replace(marker,body);}
  if(next!==current)await writeFile(file,next,'utf8');
}
await prepareSandboxPreload();
