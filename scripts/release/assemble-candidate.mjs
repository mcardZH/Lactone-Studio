// A candidate is not publication approval. All review states are caller evidence.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,copyFile} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {assembleLocalPortable} from './assemble-local.mjs';
import {checked,cleanMember} from './export-source.mjs';
import {releaseState,validateReleaseDate} from './contract.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function candidateName({publicationDate,candidateId}){
  if(publicationDate!==undefined&&publicationDate!==null)return'Ester-Studio-'+validateReleaseDate(publicationDate);
  assert(typeof candidateId==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(candidateId),'Unannounced release requires explicit internal candidate ID');return'Ester-Studio-candidate-'+candidateId;
}
async function absent(path){try{await lstat(path);}catch(e){if(e.code==='ENOENT')return;throw e;}throw Error('Candidate exists; do not overwrite');}
export async function assembleCandidate(options){
  const {sourceRoot,outputParent,native,xtb,launcher,electron,dist,python,review,nativeReceipt,nativeReceiptRoot}=options;
  for(const value of[sourceRoot,outputParent,native,xtb,launcher,dist,python])assert(typeof value==='string'&&isAbsolute(value),'Explicit absolute inputs required');
  for(const value of [nativeReceipt,nativeReceiptRoot])if(value!==undefined)assert(typeof value==='string'&&isAbsolute(value),'Explicit absolute native receipt/root required');
  assert(review&&review.path&&Number.isSafeInteger(review.bytes)&&/^[a-f0-9]{64}$/.test(review.sha256),'Exact external review observation required');
  const reviewBytes=await checked(review.path);assert.equal(reviewBytes.length,review.bytes);assert.equal(sha(reviewBytes),review.sha256);
  const observed=JSON.parse(reviewBytes),status=releaseState(observed),rootName=candidateName(options),output=resolve(outputParent),portable=join(outputParent,rootName),source=join(outputParent,'source-code');
  const encloses=(parent,child)=>{const name=relative(resolve(parent),resolve(child));return name===''||name!=='..'&&!name.startsWith('..'+sep)&&!isAbsolute(name);};
  for(const input of[sourceRoot,native,xtb,launcher,dist,...(electron?[electron]:[])])assert(!encloses(input,output)&&!encloses(output,input),'Candidate/input overlap refused');
  const original=JSON.parse(await checked(join(sourceRoot,'source-export-manifest.json')));assert.equal(original.schema,'sy-public-source-snapshot/v1');
  await absent(output);await mkdir(output);await mkdir(source);
  for(const row of original.files){cleanMember(row.path);const data=await checked(join(sourceRoot,row.path));assert.equal(data.length,row.bytes);assert.equal(sha(data),row.sha256,'Exported source drift');const target=join(source,row.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx'});}
  await copyFile(join(sourceRoot,'source-export-manifest.json'),join(source,'source-export-manifest.json'));
  const assembly=await assembleLocalPortable({dist,native,xtb,launcher,electron,nativeReceipt,nativeReceiptRoot,out:portable},{sourceRoot});
  const sourceLicense=await readFile(join(source,'LICENSE.txt')),portableLicense=await readFile(join(portable,'LICENSE.txt'));assert(sourceLicense.equals(portableLicense),'Root LICENSE texts differ');
  const provenance={schema:'sy-public-candidate-status/v1',version:original.version,sourceCommit:original.sourceCommit,sourceSnapshotSha256:sha(await readFile(join(source,'source-export-manifest.json'))),rootLicenseSha256:sha(sourceLicense),...status,publicationDate:options.publicationDate??null,publicationAnnounced:false};
  await writeFile(join(portable,'runtime/provenance/candidate-status.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
  for(const row of original.files){const bytes=await checked(join(sourceRoot,row.path));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256,'Source changed during candidate assembly');}
  const zip=join(output,'packages.zip'),command=[join(sourceRoot,'scripts/release/zip-directory.py'),'--directory',portable,'--output',zip,'--root-name',rootName];
  await new Promise((done,fail)=>{const child=spawn(python,command,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);child.on('error',fail);child.on('close',code=>code===0?done():fail(Error('Candidate ZIP failed; directory retained: '+log)));});
  const zipHash=createHash('sha256');let zipBytes=0;for await(const block of createReadStream(zip)){zipHash.update(block);zipBytes+=block.length;}
  // The uncompressed owned stage is retained as build evidence. Only source-code
  // and packages.zip are the two intended publication objects.
  return{output,source,packages:zip,packagesIdentity:{bytes:zipBytes,sha256:zipHash.digest('hex')},portableStage:portable,assembly,...provenance,intendedPublicObjects:['source-code/','packages.zip'],uploadPerformed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const[file]=process.argv.slice(2);assert(file,'Supply one explicit candidate options JSON');console.log(JSON.stringify(await assembleCandidate(JSON.parse(await readFile(file,'utf8'))),null,2));
}
