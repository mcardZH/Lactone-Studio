import assert from 'node:assert/strict';
import {lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {ancestors,createTree,identity,inventory,matchFiles,projectPath,readFileChecked,sha} from './io.mjs';

export const LIBXTB_RUNTIME_SCHEMA = 'ester-pes-libxtb-runtime/v1';
export const LIBXTB_LOCK_SCHEMA = 'ester-pes-libxtb-runtime-lock/v1';
function member(name) {
  assert(typeof name==='string' && /^[A-Za-z0-9._/-]+$/.test(name) && !isAbsolute(name)
    && name.split('/').every(part=>part && part!=='.' && part!=='..'), 'Invalid libxtb relative member');
  return name;
}
export function validateLibxtbLock(lock) {
  assert.equal(lock.schema,LIBXTB_LOCK_SCHEMA);assert.equal(lock.platform,'win32-x64');
  assert.equal(lock.subdirectory,'libxtb');
  assert.equal(lock.version,'6.8.0');assert.equal(lock.apiVersion,20000);
  assert.equal(lock.libraryRelativePath,'bin/libxtb.dll');assert.equal(lock.parameterDirectory,'data');
  assert.equal(lock.runtimeManifest.path,'runtime.json');assert.match(lock.runtimeManifest.sha256,/^[0-9a-f]{64}$/);
  assert(Number.isSafeInteger(lock.runtimeManifest.bytes)&&lock.runtimeManifest.bytes>0);
  assert(Array.isArray(lock.files)&&lock.files.length>0);const names=new Set();
  for(const row of lock.files){member(row.path);assert(row.path.startsWith('bin/')||row.path.startsWith('data/'),'Invalid libxtb payload location');assert(!names.has(row.path.toLowerCase()),'Duplicate libxtb member');names.add(row.path.toLowerCase());
    assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0);assert.match(row.sha256,/^[0-9a-f]{64}$/);}
  for(const name of [lock.libraryRelativePath,lock.parameters.gfn1,lock.parameters.gfn2])assert(names.has(member(name).toLowerCase()),'Required libxtb member absent');
  assert.equal(lock.identity.librarySha256,lock.files.find(row=>row.path===lock.libraryRelativePath).sha256);
  assert.equal(lock.identity.blas.librarySha256,lock.files.find(row=>row.path==='bin/libopenblas.dll')?.sha256);
  return lock;
}

/** Pure identity verification. Does not load DLLs, install, or evaluate science. */
export async function verifyLibxtbRuntime(root,lock) {
  root=resolve(root);validateLibxtbLock(lock);await ancestors(root);
  const bytes=await readFileChecked(join(root,'runtime.json'),lock.runtimeManifest),manifest=JSON.parse(bytes);
  assert.equal(manifest.schema,LIBXTB_RUNTIME_SCHEMA);assert.equal(manifest.platform,lock.platform);
  for(const key of ['version','apiVersion','libraryRelativePath','parameterDirectory'])assert.equal(manifest[key],lock[key]);
  assert.deepEqual(manifest.parameters,lock.parameters);assert.deepEqual(manifest.identity,lock.identity);
  matchFiles(manifest.files,lock.files);
  assert.equal(manifest.identity.filesSha256,sha(JSON.stringify(manifest.files)));
  matchFiles(await inventory(root),[...lock.files,lock.runtimeManifest]);
  return {root,manifest,reference:identity('runtime.json',bytes),files:[...lock.files,lock.runtimeManifest]};
}

/** Copy a locked component from an explicit local input. Fresh targets only;
 * an already complete identical target is reusable. No research-path fallback. */
export async function prepareLibxtbRuntime({inputRoot,outputRoot,lock}) {
  assert(typeof inputRoot==='string'&&isAbsolute(inputRoot),'Explicit absolute libxtb input root required');
  assert(typeof outputRoot==='string'&&isAbsolute(outputRoot),'Explicit absolute libxtb output root required');
  inputRoot=resolve(inputRoot);outputRoot=resolve(outputRoot);const input=await verifyLibxtbRuntime(inputRoot,lock);
  let exists=false;try{await lstat(outputRoot);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists){const verified=await verifyLibxtbRuntime(outputRoot,lock);return {schema:'ester-pes-libxtb-preparation/v1',passed:true,
    inputRoot,outputRoot,reused:true,manifest:verified.reference,members:verified.files.length,bytes:verified.files.reduce((n,r)=>n+r.bytes,0),scientificProcessesStarted:0};}
  const tree=await createTree(outputRoot);
  for(const row of input.files)await tree.put(row.path,await readFileChecked(projectPath(inputRoot,row.path),row));
  const verified=await verifyLibxtbRuntime(outputRoot,lock);
  return {schema:'ester-pes-libxtb-preparation/v1',passed:true,inputRoot,outputRoot,reused:false,
    manifest:verified.reference,members:verified.files.length,bytes:verified.files.reduce((n,r)=>n+r.bytes,0),scientificProcessesStarted:0};
}
