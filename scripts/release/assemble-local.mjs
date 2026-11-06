#!/usr/bin/env node
// Explicit caller binaries and optional actual native build receipt.
// Source/receipt checks never infer or fabricate official approval.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {lstat,open,mkdir,readdir,copyFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,parse,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export const HELP=`Local self-assembled Ester Studio portable directory (officialValidation=false)

Usage:
  node scripts/assemble-local-portable.mjs --dist=<built-dist-directory> --native=<complete-engine-directory> --xtb=<complete-xtb-directory> --launcher=<launcher.exe> --out=<fresh-output-directory> [--electron=<electron-dist-directory>] [--native-receipt=<actual-receipt.json>] [--native-receipt-root=<receipt-origin-source-root>]

Source root is the parent of this script's scripts directory. Electron defaults
to source-root/node_modules/electron/dist and must match package.json's declared
Electron version. Native requires engine.exe, _internal/base_library.zip and
licenses/. xTB requires bin/xtb.exe and licenses/; supply its complete bin/share
runtime. The source root must contain LICENSE.txt and the complete licenses/.

All output parents must already exist. Output must be fresh and separate from
the source root and every supplied input. Links/hardlinks, private/user-state/
cache directories, case collisions and conflicting license destinations fail.
No download, install, native compilation, application or scientific run occurs.
The manifest hashes all payload members and explicitly excludes its own hash;
the command result reports the manifest hash and complete member count. GNU xTB v2 requires a real native receipt and its recorded build contract.
Receipt references resolve under --native-receipt-root (default: source root).
Legacy calls without a receipt retain their unverified behavior. This does not
prove official QA or redistribution rights.
`;
const MANIFEST='runtime/provenance/local-build-manifest.json';
const forbidden=new Set(['.git','.private','private','.cache','cache','caches','state','user data','user-data','userdata','profiles','profile','gpuCache'.toLowerCase(),'code cache','shadercache','dawncache','local storage','session storage','indexeddb','blob_storage','crashpad','recovery','logs']);
const secretNames=new Set(['.npmrc','.pypirc','.git-credentials','id_rsa','id_ed25519']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function safeMember(value){assert(typeof value==='string'&&value&&!isAbsolute(value)&&!value.includes('\\')&&!value.includes(':'));assert(value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[<>:"|?*\x00-\x1f]/.test(p)&&!/[. ]$/.test(p)&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)),'Unsafe package member: '+value);return value;}
function cleanName(name){const key=name.toLowerCase();assert(!forbidden.has(key)&&!secretNames.has(key)&&!/^\.env(?:\.|$)/.test(key)&&!key.endsWith('.sy')&&!key.endsWith('.es')&&!key.startsWith('.sy-'),'Private/state/cache input refused: '+name);}
function encloses(parent,child){const rel=relative(parent,child);return rel===''||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);}
async function ordinaryAncestors(path,{file=false}={}){
 let cursor=parse(resolve(path)).root;const parts=relative(cursor,resolve(path)).split(sep).filter(Boolean);
 for(const [i,part]of parts.entries()){cursor=join(cursor,part);const s=await lstat(cursor);assert(!s.isSymbolicLink(),'Linked path refused: '+cursor);if(i<parts.length-1||!file)assert(s.isDirectory(),'Ordinary directory required: '+cursor);else assert(s.isFile()&&s.nlink===1,'Ordinary unlinked file required: '+cursor);}
}
async function digest(path){
 await ordinaryAncestors(path,{file:true});const before=await lstat(path,{bigint:true}),hasher=createHash('sha256');let bytes=0;
 for await(const chunk of createReadStream(path)){bytes+=chunk.length;hasher.update(chunk);}
 const after=await lstat(path,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])assert.equal(after[key],before[key],'Input changed while hashing: '+path);assert(!after.isSymbolicLink()&&after.isFile()&&after.nlink===1n);
 return{bytes,sha256:hasher.digest('hex')};
}
async function fresh(path){try{await lstat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}throw Error('Output already exists; no overwrite or resume: '+path);}
async function walk(root,visit,prefix=''){
 await ordinaryAncestors(root);const names=await readdir(root);for(const name of names.sort()){cleanName(name);const child=join(root,name),rel=prefix?prefix+'/'+name:name,s=await lstat(child);assert(!s.isSymbolicLink(),'Linked input refused: '+child);safeMember(rel);if(s.isDirectory())await walk(child,visit,rel);else{assert(s.isFile()&&s.nlink===1,'Ordinary input file required: '+child);await visit(child,rel);}}
}
async function writeExclusive(path,bytes){await mkdir(dirname(path),{recursive:true});await ordinaryAncestors(dirname(path));const fd=await open(path,'wx');try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}}
export function parseOptions(args){const options={};for(const arg of args){const match=/^--(dist|native|xtb|launcher|out|electron|native-receipt|native-receipt-root)=(.+)$/.exec(arg);const key=match?.[1]==='native-receipt'?'nativeReceipt':match?.[1]==='native-receipt-root'?'nativeReceiptRoot':match?.[1];assert(match&&!Object.hasOwn(options,key),'Use explicit nonduplicated --name=<path> arguments');options[key]=match[2];}for(const key of ['dist','native','xtb','launcher','out'])assert(options[key],'Missing --'+key);return options;}

async function jsonInput(path,guards,expected){
 const observed=await digest(path);if(expected){assert.equal(observed.bytes,expected.bytes,'Metadata size differs');assert.equal(observed.sha256,expected.sha256,'Metadata identity differs');}
 assert(observed.bytes>0&&observed.bytes<=64*1024*1024,'Bounded metadata required');const bytes=await readFile(path);assert.equal(bytes.length,observed.bytes);assert.equal(hash(bytes),observed.sha256,'Metadata changed while reading');guards.push({path,...observed});return{value:JSON.parse(bytes),identity:observed};
}
async function referencedJson(root,ref,guards){assert(ref&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&/^[a-f0-9]{64}$/.test(ref.sha256),'Exact build identity required');safeMember(ref.path);return jsonInput(join(root,ref.path),guards,ref);}
function exactRows(rows){assert(Array.isArray(rows)&&rows.length>0);const seen=new Set();return rows.map(row=>{safeMember(row.path);assert(!seen.has(row.path.toLowerCase()),'Duplicate declared member');seen.add(row.path.toLowerCase());assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/.test(row.sha256),'Exact file identity required');return{path:row.path,bytes:row.bytes,sha256:row.sha256};}).sort((a,b)=>a.path.localeCompare(b.path));}
const replacementTargets=Object.freeze({'_internal/libtblite-0.dll':'tblite','_internal/libdftd4-4.dll':'dftd4','_internal/libs-dftd3-1.dll':'s-dftd3','_internal/iconv.dll':'libiconv','_internal/charset.dll':'libiconv','_internal/libquadmath-0.dll':'libquadmath','_internal/libmctc-lib-0.dll':'mctc-lib','_internal/libtoml-f-0.dll':'toml-f','_internal/libmulticharge-0.dll':'multicharge','_internal/openblas.dll':'openblas','_internal/tblite/_libtblite.cp312-win_amd64.pyd':'tblite'});
export async function verifyUpstreamOpenblasArtifact(root,change,guards=[]){
 assert.equal(change.target,'_internal/openblas.dll');assert.equal(change.component,'openblas');assert(!change.sourceEvidence&&!change.buildEvidence,'Upstream artifact cannot claim local source/build evidence');
 assert(Array.isArray(change.upstreamEvidence)&&change.upstreamEvidence.length===1);
 const record=(await referencedJson(root,change.upstreamEvidence[0],guards)).value;
 assert.equal(record.schema,'sy-upstream-library-artifact-evidence/v1');assert.equal(record.component,'openblas');assert.equal(record.kind,'upstream-prebuilt');assert.equal(record.localBuildExecuted,false);
 const pkg=record.package,url=new URL(pkg.url),filename='libopenblas-0.3.33-pthreads_h877e47f_0.conda';
 assert.equal(url.protocol,'https:');assert(!url.username&&!url.password&&!url.search&&!url.hash);
 assert(url.hostname==='conda.anaconda.org'&&url.pathname==='/conda-forge/win-64/'+filename||url.hostname==='api.anaconda.org'&&url.pathname==='/download/conda-forge/libopenblas/0.3.33/win-64/'+filename,'Exact approved official artifact required');
 const payload=safeMember(record.payloadRoot),metadata=record.metadata,binary=record.member;
 assert.equal(pkg.archive.path.split('/').at(-1),filename);assert.equal(binary.path,'Library/bin/openblas.dll');assert.deepEqual(binary.file,change.file);assert.equal(binary.file.path,payload+'/Library/bin/openblas.dll');
 assert.deepEqual(Object.keys(metadata).sort(),['about','index','paths']);for(const key of ['index','about','paths'])assert.equal(metadata[key].path,payload+'/info/'+key+'.json');
 const index=(await referencedJson(root,metadata.index,guards)).value,about=(await referencedJson(root,metadata.about,guards)).value,paths=(await referencedJson(root,metadata.paths,guards)).value,official=(await referencedJson(root,pkg.officialMetadata,guards)).value;
 assert.equal(index.name,'libopenblas');assert.equal(index.version,'0.3.33');assert.equal(index.build,'pthreads_h877e47f_0');assert.equal(index.subdir,'win-64');
 assert.equal(official.basename,'win-64/'+filename);assert.equal(official.sha256,pkg.archive.sha256);assert.equal(official.size,pkg.archive.bytes);
 const members=paths.paths.filter(row=>row._path===binary.path);assert.equal(members.length,1);assert.equal(members[0].sha256,binary.file.sha256);assert.equal(members[0].size_in_bytes,binary.file.bytes);
 assert(typeof about.license==='string'&&about.license.trim());assert(Array.isArray(record.licenseFiles)&&record.licenseFiles.length);
 const actual=[];await walk(join(root,payload,'info/licenses'),async(file,name)=>actual.push({path:payload+'/info/licenses/'+name,...await digest(file)}));assert.deepEqual(exactRows(record.licenseFiles),exactRows(actual),'Actual upstream license files differ');
 const refs=[pkg.archive,pkg.officialMetadata,...Object.values(metadata),binary.file,...record.licenseFiles,...['candidateReceipt','matrixReceipt','compatibilityEvidence'].filter(key=>record[key]).map(key=>record[key])];
 for(const ref of refs){safeMember(ref.path);const found=await digest(join(root,ref.path));assert.deepEqual(found,{bytes:ref.bytes,sha256:ref.sha256});guards.push({path:join(root,ref.path),...found});}
 return record;
}
const replacementSystem=new Set('advapi32 bcrypt crypt32 gdi32 kernel32 kernelbase msvcrt ntdll ole32 oleaut32 rpcrt4 user32 version shell32 shlwapi ws2_32 wtsapi32 userenv powrprof setupapi comdlg32 comctl32 normaliz dnsapi iphlpapi winhttp wininet secur32 psapi dbghelp imm32'.split(' '));
const ancillaryPolicyId='libiconv-1.18-current-host-ancillary-a02';
const openblasPolicyId='openblas-034-to-033-exact-consumer-abi-a01';
const openblasBefore={path:'_internal/openblas.dll',bytes:28410880,sha256:'d0073463ce449d6bb4a3f720b1ebf8a858b49ca2e376271585a7f75f6a1795d8'};
const openblasAfter={path:'_internal/openblas.dll',bytes:28357632,sha256:'ea5706aaa7e88ea76f350faf4181c5e3393817a1ce1cd800501bf3ee21f205e8'};
const openblasOmitted=new Set(['blas_level3_thread_enter','blas_level3_thread_leave','clarft_lvl2_','dlarft_lvl2_','openblas_set_xerbla','slarft_lvl2_','zlarft_lvl2_']);
// Reviewed ancillary compiler/CRT exports; sprintf is a public CRT function.
const ancillaryPolicy={
 '_internal/iconv.dll':{bytes:1098568,sha256:'dde13ae784d3b916ccde2e676f7caa8dd96f23d7e20764fe1b0a8de6424dbd0d',exports:[{ordinal:1,names:['_Avx2WmemEnabledWeakValue'],forwarder:null,kind:'data'}]},
 '_internal/charset.dll':{bytes:24904,sha256:'a3ae42aded452a43703db8f00638550efb3a1013cf8267c475cea4c668e3ab8d',exports:[{ordinal:1,names:['__local_stdio_printf_options'],forwarder:null,kind:'code'},{ordinal:2,names:['_vsnprintf_l'],forwarder:null,kind:'code'},{ordinal:3,names:['_vsprintf_l'],forwarder:null,kind:'code'},{ordinal:6,names:['sprintf'],forwarder:null,kind:'code'}]}};
const sameExport=(a,b)=>a.ordinal===b.ordinal&&a.kind===b.kind&&a.forwarder===b.forwarder&&JSON.stringify(a.names)===JSON.stringify(b.names);
async function replacementParent(receipt,originRoot,actualFiles,guards){
 assert.equal(receipt.schema,'sy-local-native-library-replacement/v1');for(const key of ['officialAcceptance','scientificAccepted','publicDistributionApproved','buildExecuted','actualLoadValidated'])assert.equal(receipt[key],false,'Replacement is not build/science/load acceptance');
 safeMember(receipt.parentReceiptRoot);safeMember(receipt.evidenceRoot);
 assert(receipt.parentReceipt.path.startsWith(receipt.parentReceiptRoot+'/')&&receipt.parentContract.path.startsWith(receipt.parentReceiptRoot+'/'),'Parent proof escaped its declared root');
 const parent=(await referencedJson(originRoot,receipt.parentReceipt,guards)).value,parentRoot=join(originRoot,receipt.parentReceiptRoot);
 assert(['sciyue-native-candidate-v1','sy-local-native-self-build/v1'].includes(parent.schema),'Actual parent build receipt required');
 const contractRef=parent.schema==='sciyue-native-candidate-v1'?parent.buildContract:parent.sourceContract;
 assert.deepEqual(receipt.parentContract,{...contractRef,path:receipt.parentReceiptRoot+'/'+contractRef.path},'Replacement parent contract binding differs');
 for(const key of ['sourceFiles','builderSources'])assert.deepEqual(receipt[key],parent[key],'Replacement changed parent product/build sources');
 const before=new Map(exactRows(parent.files).map(r=>[r.path,r])),after=new Map(exactRows(receipt.files).map(r=>[r.path,r]));
 assert.deepEqual([...before.keys()],[...after.keys()],'Replacement may not add/delete native members');assert.deepEqual(exactRows(receipt.files),exactRows(actualFiles),'Replacement full native inventory differs');
 const manifest=(await referencedJson(originRoot,receipt.inputManifest,guards)).value;assert.equal(manifest.schema,'sy-native-library-replacement-input/v1');
 const evidenceRoot=join(originRoot,receipt.evidenceRoot),changes=receipt.replacements;assert(Array.isArray(changes)&&changes.length>0&&changes.length===manifest.replacements.length);const targets=new Set(),licenseInputs=[],upstreamArtifacts=new Map(),artifactRecords=new Map();
 const available=new Set([...after.keys()].filter(p=>/\.(?:dll|pyd|exe)$/i.test(p)).map(p=>p.split('/').at(-1).toLowerCase()));
 for(const change of changes){
  const target=safeMember(change.target);assert(replacementTargets[target]===change.component&&!targets.has(target),'Unapproved/duplicate replacement target');targets.add(target);
  assert.deepEqual(change.before,before.get(target));assert.deepEqual(change.after,after.get(target));assert.notEqual(change.before.sha256,change.after.sha256);
  const input=manifest.replacements.find(r=>r.target===target);assert(input,'Replacement absent from input manifest');for(const key of ['component','file',...(change.upstreamEvidence?['upstreamEvidence']:['sourceEvidence','buildEvidence'])])assert.deepEqual(change[key],input[key]);
  assert.equal(change.after.bytes,change.file.bytes);assert.equal(change.after.sha256,change.file.sha256);
  if(change.upstreamEvidence){
   const artifact=await verifyUpstreamOpenblasArtifact(evidenceRoot,change,guards);artifactRecords.set(target,artifact);upstreamArtifacts.set(target,{kind:'upstream-prebuilt',version:'0.3.33',build:'pthreads_h877e47f_0',packageURL:artifact.package.url,archiveSha256:artifact.package.archive.sha256,localBuildExecuted:false});
   for(const ref of artifact.licenseFiles){const member=ref.path.slice((artifact.payloadRoot+'/info/licenses/').length);safeMember(member);licenseInputs.push({source:join(evidenceRoot,ref.path),path:'licenses/openblas-0.3.33/'+member,member:ref.path});}
  }else{
   assert(change.sourceEvidence.length>0&&change.buildEvidence.length>0);for(const ref of [...change.sourceEvidence,...change.buildEvidence]){safeMember(ref.path);const actual=await digest(join(evidenceRoot,ref.path));assert.deepEqual(actual,{bytes:ref.bytes,sha256:ref.sha256},'Replacement evidence changed');guards.push({path:join(evidenceRoot,ref.path),...actual});}
   const source=(await referencedJson(evidenceRoot,change.sourceEvidence[0],guards)).value,build=(await referencedJson(evidenceRoot,change.buildEvidence[0],guards)).value;
   assert.equal(source.schema,'sy-local-library-source-evidence/v1');assert.equal(source.component,change.component);assert.equal(build.schema,'sy-local-library-build-evidence/v1');assert.equal(build.component,change.component);assert.equal(build.exitCode,0);assert.equal(build.sourceEvidenceSha256,change.sourceEvidence[0].sha256);assert(build.outputs.some(r=>r.path===change.file.path&&r.bytes===change.file.bytes&&r.sha256===change.file.sha256));
   assert(source.sourceFiles.length&&source.recipeFiles.length);for(const ref of [...source.sourceFiles,...source.recipeFiles,...(source.patchFiles??[])]){safeMember(ref.path);const actual=await digest(join(evidenceRoot,ref.path));assert.deepEqual(actual,{bytes:ref.bytes,sha256:ref.sha256},'Replacement preferred-source/recipe changed');guards.push({path:join(evidenceRoot,ref.path),...actual});}
  }
  const abi=change.abi;assert.equal(abi.compatible,true);assert.equal(abi.actualLoadValidated,false);assert.equal(abi.parent.machine,0x8664);assert.equal(abi.replacement.machine,0x8664);
  const candidate=ancillaryPolicy[target],profile=candidate&&candidate.bytes===change.before.bytes&&candidate.sha256===change.before.sha256?candidate:null,exceptions=[];
  const isOpenblas=target===openblasBefore.path&&change.before.bytes===openblasBefore.bytes&&change.before.sha256===openblasBefore.sha256&&change.after.bytes===openblasAfter.bytes&&change.after.sha256===openblasAfter.sha256,blasExceptions=[];const exports=new Map(abi.replacement.exports.map(r=>[r.ordinal,r])),named=new Map(abi.replacement.exports.flatMap(r=>r.names.map(n=>[n,r])));for(const row of abi.parent.exports){if(profile&&profile.exports.some(r=>sameExport(r,row))&&!row.names.some(n=>named.has(n))){exceptions.push(row);continue;}if(isOpenblas&&row.names.length&&row.names.every(name=>openblasOmitted.has(name))&&!row.names.some(name=>named.has(name))){blasExceptions.push(row);continue;}assert(row.names.length?row.names.every(n=>named.get(n)&&named.get(n).forwarder===row.forwarder&&named.get(n).kind===row.kind&&(!profile||named.get(n).ordinal===row.ordinal)):exports.has(row.ordinal)&&exports.get(row.ordinal).forwarder===row.forwarder&&exports.get(row.ordinal).kind===row.kind,'Required parent export lost/reassigned');}
  assert.deepEqual(abi.openblasExportExceptions??[],blasExceptions,'Unreviewed OpenBLAS export exemption');assert.equal(abi.openblasExportPolicy??null,blasExceptions.length?openblasPolicyId:null);
  if(blasExceptions.length){assert.deepEqual(new Set(blasExceptions.flatMap(row=>row.names)),openblasOmitted);const artifact=artifactRecords.get(target);assert(artifact?.compatibilityEvidence,'Actual consumer/source evidence required');const review=(await referencedJson(evidenceRoot,artifact.compatibilityEvidence,guards)).value;assert.equal(review.schema,'ester-openblas-consumer-abi-review/v1');assert.equal(review.beforeSha256,openblasBefore.sha256);assert.equal(review.afterSha256,openblasAfter.sha256);assert.deepEqual(new Set(review.missingExports),openblasOmitted);assert.deepEqual(review.peMissingReferences,[]);assert.deepEqual(review.sourceLookupMissingReferences,[]);}
  assert.deepEqual(abi.ancillaryExportExceptions,exceptions,'Unreviewed ancillary export exemption');assert.equal(abi.ancillaryPolicy,exceptions.length?ancillaryPolicyId:null);assert.equal(abi.compatibilityScope,'current-host-public-api-and-consumers');assert.equal(abi.fullParentExportEquivalence,abi.parent.exports.every(row=>abi.replacement.exports.some(r=>sameExport(r,row))),'Full export equivalence claim differs');
  assert(Array.isArray(abi.consumers));for(const consumer of abi.consumers){assert(before.has(consumer.path),'Unknown consumer');for(const symbol of consumer.symbols){assert(![...exceptions,...blasExceptions].some(r=>symbol.name!==undefined?r.names.includes(symbol.name):r.ordinal===symbol.ordinal),'Current consumer uses an exempted ancillary export');if(symbol.name!==undefined)assert(named.has(symbol.name),'Current consumer export missing');else{const old=abi.parent.exports.find(r=>r.ordinal===symbol.ordinal),current=exports.get(symbol.ordinal);assert(old&&current&&old.names.every(n=>current.names.includes(n))&&old.forwarder===current.forwarder&&old.kind===current.kind,'Current consumer ordinal binding changed');}}}
  for(const row of abi.replacement.imports){const name=row.dll.toLowerCase(),stem=name.replace(/\.dll$/,'');assert(available.has(name)||replacementSystem.has(stem)||/^(?:api-ms-win-|ext-ms-win-)/.test(stem),'Replacement dependency is undeclared');}
 }
 const delta=[...before.keys()].filter(p=>before.get(p).bytes!==after.get(p).bytes||before.get(p).sha256!==after.get(p).sha256);assert.deepEqual([...targets].sort(),delta.sort(),'Actual native delta differs from declared replacements');
 assert(!targets.has('_internal/tblite/_libtblite.cp312-win_amd64.pyd')||targets.has('_internal/libtblite-0.dll'),'tblite pyd requires paired library');
 assert(!targets.has('_internal/charset.dll')||targets.has('_internal/iconv.dll'),'charset requires paired iconv');
 assert(!['_internal/libmctc-lib-0.dll','_internal/libtoml-f-0.dll','_internal/libmulticharge-0.dll'].some(p=>targets.has(p))||['_internal/libtblite-0.dll','_internal/libdftd4-4.dll','_internal/libs-dftd3-1.dll'].some(p=>targets.has(p)),'Fortran support requires an explicit main-library replacement set');
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 const identity=changes.map(r=>({target:r.target,before:r.before,after:r.after})).sort((a,b)=>a.target<b.target?-1:a.target>b.target?1:0);
 assert.equal(receipt.componentIdentitySha256,hash(Buffer.from(canonical(identity))),'Independent component identity differs');
 const replacement={schema:receipt.schema,identitySha256:receipt.componentIdentitySha256,parentReceiptSha256:receipt.parentReceipt.sha256,components:changes.map(r=>({target:r.target,component:r.component,before:r.before,after:r.after,compatibilityScope:r.abi.compatibilityScope,fullParentExportEquivalence:r.abi.fullParentExportEquivalence,ancillaryPolicy:r.abi.ancillaryPolicy,ancillaryExportExceptions:r.abi.ancillaryExportExceptions,...(r.abi.openblasExportPolicy?{openblasExportPolicy:r.abi.openblasExportPolicy,openblasExportExceptions:r.abi.openblasExportExceptions}:{}),...(upstreamArtifacts.has(r.target)?{upstreamArtifact:upstreamArtifacts.get(r.target)}:{})})),actualLoadValidated:false,scientificAccepted:false,officialAcceptance:false};Object.defineProperty(replacement,'licenseInputs',{value:licenseInputs});return{parent,parentRoot,replacement};
}
async function nativeProvenance(options,sourceRoot,roots,actualFiles,guards){
 if(!options.nativeReceipt){assert(!options.nativeReceiptRoot,'Receipt root requires an explicit receipt');return null;}
 assert(typeof options.nativeReceipt==='string'&&isAbsolute(options.nativeReceipt),'Explicit absolute native receipt required');
 const originRoot=resolve(options.nativeReceiptRoot??sourceRoot);await ordinaryAncestors(originRoot);
 const selected=await jsonInput(options.nativeReceipt,guards);let receipt=selected.value,contractRoot=originRoot,replacement=null;
 if(receipt.schema==='sy-local-native-library-replacement/v1'){const checked=await replacementParent(receipt,originRoot,actualFiles,guards);receipt=checked.parent;contractRoot=checked.parentRoot;replacement=checked.replacement;}
 const candidate=receipt.schema==='sciyue-native-candidate-v1',local=receipt.schema==='sy-local-native-self-build/v1';assert(candidate||local,'Supported actual native receipt required');
 if(candidate)assert(receipt.passed===true&&receipt.status==='built-not-scientifically-validated','Successful actual native candidate required');else assert(receipt.buildSucceeded===true&&receipt.officialAcceptance===false&&receipt.scientificAccepted===false,'Successful unapproved local build required');
 if(!replacement)assert.deepEqual(exactRows(receipt.files),exactRows(actualFiles),'Native receipt does not match complete supplied native members');
 const declared=await jsonInput(join(sourceRoot,'source-native-identity.json'),guards);assert.equal(declared.value.schema,'sy-source-native-identity/v1');
 for(const key of ['sourceFiles','builderSources']){assert.deepEqual(receipt[key],declared.value[key],'Exported native source/builder identity differs');for(const row of exactRows(declared.value[key])){const actual=await digest(join(sourceRoot,row.path));assert.equal(actual.bytes,row.bytes);assert.equal(actual.sha256,row.sha256,'Exported source changed: '+row.path);guards.push({path:join(sourceRoot,row.path),...actual});}}
 const contractRef=candidate?receipt.buildContract:receipt.sourceContract;assert(contractRef,'Actual buildContract/sourceContract reference required');const contract=(await referencedJson(contractRoot,contractRef,guards)).value;assert.equal(contract.schema,'sciyue-native-build-contract-v2','A source-only identity is not a build contract');
 for(const key of ['sourceFiles','builderSources'])assert.deepEqual(contract[key],declared.value[key],'Actual build contract/source mismatch');
 const profile=(await referencedJson(contractRoot,contract.profile,guards)).value;assert.equal(profile.backend,'OpenBLAS','Bound native profile backend required');if(receipt.backend!==undefined)assert.equal(receipt.backend,profile.backend);assert.deepEqual(profile.nativeSources,declared.value.sourceFiles.map(row=>row.path));if(receipt.profile)assert.deepEqual(receipt.profile,contract.profile);
 const entry=exactRows(receipt.files).find(row=>row.path==='engine.exe');assert(entry,'Native engine entry identity required');if(receipt.entry!==undefined)assert.equal(receipt.entry,entry.path);
 return{backend:profile.backend,entry,receiptSchema:selected.value.schema,receiptSha256:selected.identity.sha256,...(receipt.versions?{versions:receipt.versions}:{}),...(replacement?{libraryReplacement:replacement}:{}),origin:{candidateReceiptSha256:selected.identity.sha256,buildContractSha256:contractRef.sha256}};
}
async function xtbProvenance(sourceRoot,root,guards){
 const path=join(root,'runtime.json');try{await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const selected=await jsonInput(path,guards),record=selected.value;assert(['sciyue-xtb-bundled-runtime/v1','sciyue-xtb-bundled-runtime/v2'].includes(record.schema)&&/^\d+\.\d+\.\d+(?:pre)?$/.test(record.version),'Actual xTB descriptor schema/version required');
 if(record.schema==='sciyue-xtb-bundled-runtime/v2'){const {default:contract}=await import(pathToFileURL(join(sourceRoot,'desktop/xtb-runtime-contract.cjs')).href);contract.validateDescriptor(record);const inventory=(await referencedJson(root,record.inventory,guards)).value;assert.equal(inventory.schema,'sciyue-xtb-runtime-inventory/v1');const members=contract.verifyMemberInventory(root,inventory.files);for(const required of contract.REQUIRED)assert(members.some(row=>row.path===required),'Missing required xTB executable/parameter');}
 let runtimeLibraries;
 if(record.runtimeRevision){const revision=(await referencedJson(root,record.runtimeRevision,guards)).value;assert.equal(revision.schema,'sy-xtb-runtime-library-revision/v1');assert.equal(record.build.sourceReceiptSha256,record.runtimeRevision.sha256);assert.equal(revision.scientificProgramUnchanged,true);assert.equal(revision.parametersUnchanged,true);assert.equal(revision.replacements.length,1);const delta=revision.replacements[0];assert.equal(delta.target,'bin/openblas.dll');assert.equal(delta.before.sha256,openblasBefore.sha256);assert.equal(delta.after.sha256,openblasAfter.sha256);assert.deepEqual(delta.after,{path:'bin/openblas.dll',...await digest(join(root,'bin/openblas.dll'))});assert.equal(revision.upstreamArtifact.localBuildExecuted,false);runtimeLibraries={openblas:{version:'0.3.33',origin:'official-conda-forge-upstream-prebuilt',packageURL:revision.upstreamArtifact.packageURL,archiveSha256:revision.upstreamArtifact.archiveSha256,member:delta.after,parentRawBuildVersion:'0.3.34',parentSourceReceiptSha256:revision.parentSourceReceiptSha256}};}
 return{schema:record.schema,version:record.version,scope:record.scope,publicRedistributionReviewed:false,runtimeManifest:{path:'runtime.json',...selected.identity},...(runtimeLibraries?{runtimeLibraries}:{})};
}

export async function assembleLocalPortable(options,{sourceRoot=resolve(import.meta.dirname,'../..')}={}){
 // This module is imported from the exported source tree, never the private
 // official build adapter. The contract's receipt constants are not consumed.
 sourceRoot=resolve(sourceRoot);await ordinaryAncestors(sourceRoot);
 for(const name of ['package.json','scripts/release/contract.mjs','scripts/portable-artifact-identity.mjs','scripts/portable-package-layout.mjs','desktop/portable-layout.cjs'])await ordinaryAncestors(join(sourceRoot,name),{file:true});
 const pkgBytes=await readFile(join(sourceRoot,'package.json')),pkg=JSON.parse(pkgBytes);
 const {createPortableContract}=await import(pathToFileURL(join(sourceRoot,'scripts/release/contract.mjs')).href);
 const c=createPortableContract({root:sourceRoot});assert.equal(pkg.version,c.version,'Source package/contract versions differ');assert.equal(pkg.main,'desktop/main.cjs');assert.equal(pkg.type,'module');assert.equal(pkg.private,true);
 const roots={dist:resolve(options.dist),native:resolve(options.native),xtb:resolve(options.xtb),electron:resolve(options.electron??join(sourceRoot,'node_modules/electron/dist'))},launcher=resolve(options.launcher),output=resolve(options.out);
 await fresh(output);await ordinaryAncestors(dirname(output));
 for(const input of [sourceRoot,...Object.values(roots),launcher])assert(!encloses(input,output)&&!encloses(output,input),'Output/input overlap or recursive self-containment refused: '+input);
 for(const path of Object.values(roots))await ordinaryAncestors(path);await ordinaryAncestors(launcher,{file:true});
 for(const path of [join(roots.dist,'index.html'),join(roots.native,'engine.exe'),join(roots.native,'_internal/base_library.zip'),join(roots.xtb,'bin/xtb.exe'),join(roots.electron,'electron.exe'),join(roots.electron,'LICENSE'),join(roots.electron,'LICENSES.chromium.html'),join(sourceRoot,'LICENSE.txt')])await ordinaryAncestors(path,{file:true});
 await ordinaryAncestors(join(roots.native,'licenses'));await ordinaryAncestors(join(roots.xtb,'licenses'));await ordinaryAncestors(join(sourceRoot,'licenses'));
 assert.equal((await readFile(join(roots.electron,'version'),'utf8')).trim(),pkg.devDependencies?.electron,'Supplied Electron version differs from source package declaration');
 const plan=new Map(),inputs=[],verificationGuards=[];
 async function add(source,path,role,relativePath){
  safeMember(path);const value=await digest(source),origin={role,path:relativePath,...value};inputs.push(origin);
  const old=plan.get(path.toLowerCase());if(old){assert.equal(old.path,path,'Case-colliding destination');assert.equal(old.bytes,value.bytes,'Conflicting destination, including an upstream license: '+path);assert.equal(old.sha256,value.sha256,'Conflicting destination, including an upstream license: '+path);old.sources.push({source,...value});old.origins.push(origin);return;}
  plan.set(path.toLowerCase(),{path,...value,sources:[{source,...value}],origins:[origin]});
 }
 function generated(path,bytes,origins=[]){safeMember(path);assert(!plan.has(path.toLowerCase()),'Generated destination collides with supplied content: '+path);plan.set(path.toLowerCase(),{path,bytes:bytes.length,sha256:hash(bytes),generated:bytes,origins,sources:[]});}
 await walk(roots.electron,async(source,path)=>{assert(!/^resources\/(?:app(?:\/|$)|app\.asar$)/i.test(path),'Electron input already contains a user application');await add(source,c.layout.member(path==='electron.exe'?'sciyue.exe':path),'electron',path);});
 for(const name of c.applicationFiles){if(name==='dist')continue;safeMember(name);assert(!/^(?:LICENSE\.txt|licenses\/)/.test(name),'Project license sources are handled only at package root');await add(join(sourceRoot,name),c.layout.member('resources/app/'+name),'application',name);}
 await walk(roots.dist,(source,path)=>add(source,c.layout.member('resources/app/dist/'+path),'dist',path));
 for(const role of ['native','xtb'])await walk(roots[role],(source,path)=>add(source,c.layout.member('resources/'+(role==='native'?'chemistry':'xtb')+'/'+path),role,path));
 const xtbSummary=await xtbProvenance(sourceRoot,roots.xtb,verificationGuards);if(xtbSummary?.schema==='sciyue-xtb-bundled-runtime/v2')assert(options.nativeReceipt,'GNU xTB v2 requires an explicit actual native receipt');const nativeSummary=await nativeProvenance(options,sourceRoot,roots,inputs.filter(row=>row.role==='native').map(({path,bytes,sha256})=>({path,bytes,sha256})),verificationGuards);if(nativeSummary){for(const file of nativeSummary.libraryReplacement?.licenseInputs??[])await add(file.source,file.path,'upstream-library-license',file.member);assert(xtbSummary,'Receipt-backed assembly requires an actual xTB descriptor');generated('runtime/provenance/dependencies.json',Buffer.from(JSON.stringify({schema:'sciyue-portable-dependency-summary/v1',electron:pkg.devDependencies.electron,native:nativeSummary,xtb:xtbSummary},null,2)+'\n'));}
 await add(launcher,c.names.executableName,'launcher',c.names.executableName);
 await add(join(sourceRoot,'LICENSE.txt'),'LICENSE.txt','project-license','LICENSE.txt');
 let rootLicenseFiles=0;await walk(join(sourceRoot,'licenses'),async(source,path)=>{rootLicenseFiles++;await add(source,'licenses/'+path,'source-licenses','licenses/'+path);});assert(rootLicenseFiles>0,'Complete source license directory is empty');
 const packagedMetadata=Object.fromEntries(['name','version','private','type','main',...(pkg.productName?['productName']:[]),...(pkg.displayVersion?['displayVersion']:[]),...(pkg.releaseChannel?['releaseChannel']:[])].map(key=>[key,pkg[key]]));
 const packageInput={role:'source-metadata',path:'package.json',bytes:pkgBytes.length,sha256:hash(pkgBytes)};inputs.push(packageInput);
 generated(c.layout.member('resources/app/package.json'),Buffer.from(JSON.stringify(packagedMetadata,null,2)+'\n'),[packageInput]);
 generated('runtime/portable-layout.json',Buffer.from(JSON.stringify(c.layout.descriptor(c.version),null,2)+'\n'));
 const actualOpenblas=nativeSummary?.libraryReplacement?.components.find(row=>row.component==='openblas');if(actualOpenblas?.upstreamArtifact){generated('runtime/provenance/OPENBLAS-RUNTIME.json',Buffer.from(JSON.stringify({schema:'ester-openblas-runtime-composition/v1',actualNative:{version:'0.3.33',member:actualOpenblas.after,origin:actualOpenblas.upstreamArtifact},actualXtb:xtbSummary?.runtimeLibraries?.openblas??null,parentRawBuild:{version:actualOpenblas.before.sha256===openblasBefore.sha256?'0.3.34':'unknown',purpose:'unchanged original build source/provenance only; not the composed runtime library'},licenses:nativeSummary.libraryReplacement.licenseInputs.map(row=>row.path),localBuildExecuted:false,scientificAccepted:false},null,2)+'\n'));}
 generated('LOCAL-BUILD-NOTICE.txt',Buffer.from(`Ester Studio ${c.displayVersion??c.version} — LOCAL SELF-ASSEMBLED DIRECTORY\n${c.developmentOnly?'Development build: internal testing only; not a public release.\n':''}Machine version: ${c.version}\nPE numeric version: ${c.peVersion??c.version+'.0'}\nOfficial validation: false\nThis caller-supplied assembly has not passed the official scientific/UI/portable QA chain.\nNative/source correspondence and redistribution rights are not established by this assembly.\nNo application, scientific calculation, download or installation was run by this tool.\nKeep the complete runtime and licenses directories together.\n`));
 assert(!plan.has(MANIFEST.toLowerCase()));
 await fresh(output);await mkdir(output); // All input validation completed before first output mutation.
 const files=[];
 for(const row of [...plan.values()].sort((a,b)=>a.path.localeCompare(b.path))){const target=join(output,row.path);await mkdir(dirname(target),{recursive:true});await ordinaryAncestors(dirname(target));if(row.generated)await writeExclusive(target,row.generated);else await copyFile(row.sources[0].source,target,constants.COPYFILE_EXCL);const actual=await digest(target);assert.equal(actual.bytes,row.bytes);assert.equal(actual.sha256,row.sha256);files.push({path:row.path,...actual,origins:row.origins});}
 for(const row of plan.values())for(const source of row.sources){const now=await digest(source.source);assert.equal(now.bytes,source.bytes,'Input changed while copying');assert.equal(now.sha256,source.sha256,'Input changed while copying');}
 for(const ref of verificationGuards){const actual=await digest(ref.path);assert.equal(actual.bytes,ref.bytes);assert.equal(actual.sha256,ref.sha256,'Provenance input changed while copying');}
 assert.equal(hash(await readFile(join(sourceRoot,'package.json'))),packageInput.sha256,'Source metadata changed while copying');
 const manifest={schema:'sy-studio-local-portable-build/v1',version:c.version,displayVersion:c.displayVersion??c.version,releaseChannel:c.releaseChannel??'release',peVersion:c.peVersion??c.version+'.0',developmentOnly:c.developmentOnly===true,officialValidation:false,scientificExecutionPerformed:false,publicDistributionApproved:false,sourceCorrespondenceVerified:false,nativeSourceIdentityVerified:Boolean(nativeSummary),manifestSelfExcludedFromHashes:MANIFEST,files,inputs,createdAt:new Date().toISOString()};
 const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeExclusive(join(output,MANIFEST),manifestBytes);
 const actual=[];await walk(output,async(source,path)=>{actual.push({path,...await digest(source)});});const expected=[...files.map(({path,bytes,sha256})=>({path,bytes,sha256})),{path:MANIFEST,bytes:manifestBytes.length,sha256:hash(manifestBytes)}].sort((a,b)=>a.path.localeCompare(b.path));assert.deepEqual(actual.sort((a,b)=>a.path.localeCompare(b.path)),expected,'Complete output inventory differs');
 return{output,version:c.version,displayVersion:c.displayVersion??c.version,releaseChannel:c.releaseChannel??'release',peVersion:c.peVersion??c.version+'.0',developmentOnly:c.developmentOnly===true,officialValidation:false,sourceCorrespondenceVerified:false,memberCount:actual.length,manifest:{path:MANIFEST,bytes:manifestBytes.length,sha256:hash(manifestBytes)}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.slice(2).length===1&&process.argv[2]==='--help')console.log(HELP);else console.log(JSON.stringify(await assembleLocalPortable(parseOptions(process.argv.slice(2))),null,2));}
 catch(error){console.error('LOCAL ASSEMBLY FAILED:',error.stack??String(error));process.exitCode=1;}
}
