// Explicit product/build allowlist. No Git, private audit or old receipt reads.
import assert from 'node:assert/strict';
import {readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ROOT,createPortableContract} from './contract.mjs';
import {desktopAppearancePreviewFiles} from '../prepare-chemistry.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const encoded=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export const NATIVE_BUILDERS=Object.freeze(['scripts/native/build.py','scripts/native/common.py','scripts/native/prepare.py','desktop/packaging/native-engine.spec','scripts/native/runtime_pruning.py','desktop/packaging/native-runtime-win11-recipe.json','src/data/conformer-solvation.json']);
// xTB patch sources belong to the separately built xTB runtime. Do not add
// them to engine builderSources: reused engine receipts bind that exact list.
export const XTB_PATCH_BUILDERS=Object.freeze(['scripts/native/xtb-initial-velocity.f90','scripts/native/patch-xtb-initial-velocity.py','scripts/native/rebuild-xtb-initial-velocity.py','scripts/native/compose-xtb-initial-velocity.py']);
export const XTB_PUBLIC_SOURCE_RECEIPT='third-party/corresponding-sources/build-support/xtb-gnu/es-initial-velocity/provenance/es-initial-velocity-build.json';
export function publicXtbSourceLock(declaration,activeLock,receiptBytes){
  assert.equal(declaration.sourceBuildRequired,true,'Public source lock must still require an actual local build');
  assert.equal(declaration.localUseReady,false,'Source export cannot install an executable');
  const modification=activeLock.localModification;
  assert.equal(modification?.algorithm,'xtb-h-only-initial-cap-v1','Exact local xTB modification required');
  assert.equal(activeLock.version,'6.7.0');
  const ref=modification.sourceReceipt;
  assert.equal(receiptBytes.length,ref.bytes,'Published xTB source receipt size differs');
  assert.equal(sha(receiptBytes),ref.sha256,'Published xTB source receipt identity differs');
  assert.equal(activeLock.build.sourceReceiptSha256,ref.sha256);
  assert.equal(activeLock.engineIdentity.sourceReceiptSha256,ref.sha256);
  const receipt=JSON.parse(receiptBytes);
  assert.equal(receipt.schema,'es-xtb-initial-velocity-source-build/v1');
  assert.equal(receipt.algorithm,modification.algorithm);
  assert.equal(receipt.runtimeComposition.buildId,activeLock.build.id);
  const result={...structuredClone(declaration),localModification:{
    kind:modification.kind,algorithm:modification.algorithm,
    sourceReceipt:{path:XTB_PUBLIC_SOURCE_RECEIPT,bytes:ref.bytes,sha256:ref.sha256},
    originalEngineIdentity:structuredClone(modification.originalEngineIdentity),
    scientificAccepted:modification.scientificAccepted,
  },publishedRuntime:{version:activeLock.version,build:structuredClone(activeLock.build),engineIdentity:structuredClone(activeLock.engineIdentity)}};
  assert(!/\.private|(?:^|[^A-Za-z])[A-Za-z]:[\\/]|\/(?:home|Users)\//i.test(JSON.stringify(result)),'Private path in public source lock');
  return result;
}
export function publicArtifactPathHelpers(bytes){
  const source=bytes.toString('utf8'),start='export function packageRelativePath(value) {',end='\nconst leaf =';
  assert.equal(source.split(start).length,2,'Relative-path helper definition changed');
  const at=source.indexOf(start),stop=source.indexOf(end,at);
  assert(stop>at,'Relative-path helper boundary changed');
  const helper=source.slice(at,stop).trimEnd();assert(helper.endsWith('}'));
  return Buffer.from("import assert from 'node:assert/strict';\n\n"+helper+'\n');
}
export function cleanMember(name){
  assert(typeof name==='string'&&name&&!isAbsolute(name)&&!name.includes('\\')&&!name.includes(':')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  assert(!/(?:^|\/)(?:\.git|\.private|\.cache|\.local|node_modules|\.agents|state|evidence|AGENTS\.md)(?:\/|$)/i.test(name));
  const upstreamRecipeTest=/^third-party\/corresponding-sources\/native-shared\/recipes\/(?:libgcc-16\.2\.0-h110b43a_7|libgfortran5-16\.2\.0-h7c9de5e_7|libgomp-16\.2\.0-h8ee18e1_7)\.conda\/info\/recipe\/parent\/tests\//.test(name);
  assert(!/(?:^|\/)tests(?:\/|$)/i.test(name)||upstreamRecipeTest,'Private tests refused; only exact indexed upstream runtime recipe tests are admitted');
  assert(!/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|pfx|p12))$/i.test(name));return name;
}
async function noLinks(path){for(let p=resolve(path);;p=dirname(p)){const s=await lstat(p);assert(!s.isSymbolicLink(),'Linked source/target refused');if(dirname(p)===p)break;}}
export async function checked(path){await noLinks(path);const s=await lstat(path);assert(s.isFile()&&s.nlink===1);return readFile(path);}
export async function filesBelow(root){const rows=[];async function walk(dir,prefix=''){await noLinks(dir);for(const name of(await readdir(dir)).sort()){const path=join(dir,name),member=prefix?prefix+'/'+name:name,s=await lstat(path);assert(!s.isSymbolicLink());if(s.isDirectory())await walk(path,member);else{assert(s.isFile());rows.push({path:member,bytes:await checked(path)});}}}await walk(root);return rows;}
async function fresh(path){await noLinks(dirname(path));try{await lstat(path);throw Error('Destination exists; never overwrite');}catch(error){if(error.code!=='ENOENT')throw error;}await mkdir(path);}
async function put(root,name,bytes){cleanMember(name);const path=join(root,name);await mkdir(dirname(path),{recursive:true});await noLinks(dirname(path));await writeFile(path,bytes,{flag:'wx'});return{path:name,bytes:bytes.length,sha256:sha(bytes)};}
const CORRESPONDING_PREFIX='third-party/corresponding-sources/';
const CORRESPONDING_INDEX='third-party/corresponding-source-index.json';
// These official archives contain an upstream process-memory test fixture with
// captured credential environment data. Keep originals only as local evidence;
// public source supplies the declared exact-member privacy derivatives.
const RESTRICTED_UPSTREAM_SOURCE_HASHES=new Set(['e275e76442a6067341a27f04c5c6b83d8613144004c0413528863dc6b5c743da','071d00a097579e5ef7ce97fc4a9e58e73fd3503c0a013c765c970370a5a53b9b']);
const LOCAL_ONLY_CORRESPONDING_INPUTS=new Map([
  ['third-party/corresponding-sources/archives/gnu-runtime/gcc-13.2.0.tar.xz',{bytes:87858592,sha256:'e275e76442a6067341a27f04c5c6b83d8613144004c0413528863dc6b5c743da'}]
]);
export function validateCorrespondingSourceIndex(index){
  const fields=(value,allowed)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert(Object.keys(value).every(key=>allowed.includes(key)),'Unexpected corresponding-source index field');};
  fields(index,['schema','publicDistributionApproved','status','components','unresolved','files','componentClosureReport']);
  const closed=index.schema==='sy-corresponding-sources/v2';
  assert(closed||index.schema==='sy-corresponding-sources/v1');assert.equal(index.publicDistributionApproved,false,'Source provision cannot approve public distribution');
  fields(index.status,closed?['sourceAcquiredAndIncluded','recursiveBuildClosure','modifiedLibraryRebuildOrReplacement','wholeProductRebuild']:['sourceAcquiredAndIncluded','recursiveBuildClosure','modifiedLibraryRebuildOrReplacement']);
  assert.equal(index.status.sourceAcquiredAndIncluded,'completed');assert.equal(index.status.recursiveBuildClosure,closed?'completed':'pending');assert.equal(index.status.modifiedLibraryRebuildOrReplacement,closed?'completed':'pending');
  if(closed)assert.equal(index.status.wholeProductRebuild,'deferred-by-user','Component closure must not imply the deferred whole-product rebuild');
  else assert.equal(index.componentClosureReport,undefined,'Legacy pending index cannot claim component closure');
  assert(!/\.private|\b[A-Za-z]:[\\/]|\/(?:home|Users)\//i.test(JSON.stringify(index)),'Private or machine-bound corresponding-source index');
  assert(Array.isArray(index.files)&&index.files.length>0);assert(Array.isArray(index.components)&&index.components.length>0);assert(Array.isArray(index.unresolved)&&index.unresolved.every(value=>typeof value==='string'&&value));
  const members=new Map(),roles=['source-archive','license','build-patch','upstream-build-recipe','local-build-recipe','source-material-guide'];
  for(const row of index.files){
    fields(row,['path','bytes','sha256','role','url','component']);cleanMember(row.path);assert(row.path.startsWith(CORRESPONDING_PREFIX),'Corresponding-source member outside exact prefix');
    assert(!members.has(row.path.toLowerCase()),'Duplicate corresponding-source member');assert(Number.isSafeInteger(row.bytes)&&row.bytes>0);assert(/^[a-f0-9]{64}$/.test(row.sha256));assert(roles.includes(row.role));
    if(row.url){const url=new URL(row.url);assert.equal(url.protocol,'https:');assert(!url.username&&!url.password,'Credential-bearing upstream URL refused');}else assert(['source-material-guide','local-build-recipe'].includes(row.role),'Upstream material requires an exact origin URL');
    assert(!RESTRICTED_UPSTREAM_SOURCE_HASHES.has(row.sha256),'Credential-bearing upstream archive cannot be exported; use the indexed privacy derivative');
    members.set(row.path.toLowerCase(),row);
  }
  const ids=new Set();
  for(const component of index.components){
    fields(component,['id','version','sourceAcquiredAndIncluded','archives','materials','buildRelations','remaining']);assert(/^[a-z0-9][a-z0-9-]*$/.test(component.id)&&!ids.has(component.id));ids.add(component.id);
    assert(typeof component.version==='string'&&component.version);assert.equal(component.sourceAcquiredAndIncluded,'completed');assert(Array.isArray(component.archives)&&component.archives.length>0);
    for(const key of ['materials','buildRelations','remaining'])assert(Array.isArray(component[key]));
    for(const name of [...component.archives,...component.materials]){const row=members.get(name.toLowerCase());assert(row&&row.path===name&&row.component===component.id,'Missing or mismatched component source member');if(component.archives.includes(name))assert.equal(row.role,'source-archive');}
    assert([...component.buildRelations,...component.remaining].every(value=>typeof value==='string'&&value));
    if(closed)assert.equal(component.remaining.length,0,'Completed scope cannot retain unresolved component work');
  }
  for(const row of index.files)if(row.component)assert(ids.has(row.component),'Unknown corresponding-source component');
  if(closed){
    const ref=index.componentClosureReport;fields(ref,['path','bytes','sha256']);
    const row=members.get(ref.path?.toLowerCase());assert(row&&row.path===ref.path&&row.role==='source-material-guide'&&row.bytes===ref.bytes&&row.sha256===ref.sha256,'Completed component scope requires an indexed closure report');
  }
  return index;
}
export function validateComponentClosureReport(index,report){
  assert.equal(index.schema,'sy-corresponding-sources/v2');
  assert.equal(report?.schema,'sy-component-source-and-replacement-closure/v1');
  assert.equal(report.scope,'component-source-and-replacement');assert.equal(report.publicDistributionApproved,false);
  assert.equal(report.wholeProductRebuild,'deferred-by-user');
  assert(!/\.private|\b[A-Za-z]:[\\/]|\/(?:home|Users)\//i.test(JSON.stringify(report)),'Closure report must not contain private paths');
  assert(Array.isArray(report.components)&&report.components.length===index.components.length,'Every declared component needs a closure decision');
  const decisions=new Map();
  for(const row of report.components){assert(!decisions.has(row.id),'Duplicate component closure');decisions.set(row.id,row);}
  const members=new Map(index.files.map(row=>[row.path,row]));
  for(const component of index.components){
    const row=decisions.get(component.id);assert(row&&row.sourceStatus==='verified','Component source closure missing');
    assert(typeof row.reason==='string'&&row.reason.trim(),'Concrete component conclusion required');
    assert(Array.isArray(row.sourceArchives));
    assert.deepEqual(row.sourceArchives.map(ref=>ref.path).sort(),[...component.archives].sort(),'Closure must cover the actual component source archives');
    for(const ref of row.sourceArchives){const file=members.get(ref.path);assert(file&&file.role==='source-archive'&&file.bytes===ref.bytes&&file.sha256===ref.sha256,'Closure source archive identity differs');}
    assert(['verified','not-required'].includes(row.replacementStatus),'Explicit component replacement decision required');
    assert(Array.isArray(row.evidenceDigests)&&row.evidenceDigests.length>0&&row.evidenceDigests.every(value=>/^[a-f0-9]{64}$/.test(value)),'Actual scoped evidence identity required');
    if(row.replacementStatus==='not-required')assert(typeof row.exceptionOrReason==='string'&&row.exceptionOrReason.trim(),'Not-required needs its exact applicability reason');
    assert(Array.isArray(row.remaining)&&row.remaining.length===0,'Unresolved component cannot be marked closed');
  }
  return report;
}
export function verifyCorrespondingSourceMember(row,bytes){assert.equal(bytes.length,row.bytes,'Corresponding-source size changed: '+row.path);assert.equal(sha(bytes),row.sha256,'Corresponding-source SHA256 changed: '+row.path);return bytes;}
export async function correspondingSourceMaterials(root=ROOT){
  const indexPath=join(root,CORRESPONDING_INDEX),bytes=await checked(indexPath),index=validateCorrespondingSourceIndex(JSON.parse(bytes)),expected=new Map(index.files.map(row=>[row.path,row]));
  const actual=[];
  for(const row of await filesBelow(join(root,CORRESPONDING_PREFIX))){
    const name=CORRESPONDING_PREFIX+row.path,local=LOCAL_ONLY_CORRESPONDING_INPUTS.get(name);
    if(local){verifyCorrespondingSourceMember({...local,path:name},row.bytes);assert(!expected.has(name),'Local-only original cannot be a public member');continue;}
    actual.push(row);
  }
  assert.equal(actual.length,expected.size,'Unindexed or missing corresponding-source members');
  const planned=[{name:CORRESPONDING_INDEX,bytes,source:indexPath}];
  for(const row of actual){const name=CORRESPONDING_PREFIX+row.path,reference=expected.get(name);assert(reference,'Unindexed corresponding-source member: '+name);planned.push({name,bytes:verifyCorrespondingSourceMember(reference,row.bytes),source:join(root,name)});}
  if(index.schema==='sy-corresponding-sources/v2'){
    const report=planned.find(row=>row.name===index.componentClosureReport.path);assert(report,'Closure report was not read');validateComponentClosureReport(index,JSON.parse(report.bytes));
  }
  return planned;
}
export async function sourcePlan({root=ROOT,sourceCommit,licenseDirectory}){
  root=resolve(root);assert(/^[a-f0-9]{40}$/.test(sourceCommit??''),'Main supplies exact frozen source commit');assert(licenseDirectory&&isAbsolute(licenseDirectory),'Explicit reviewed material directory required');
  const pkg=JSON.parse(await checked(join(root,'package.json'))),c=createPortableContract({root}),planned=new Map(),guards=[],transforms=[];
  async function add(name,bytes,source,reason){cleanMember(name);assert(!planned.has(name.toLowerCase()),'Duplicate public member '+name);planned.set(name.toLowerCase(),{name,bytes});const input=source?await checked(source):null;if(input&&!reason)assert(bytes.equals(input),'Source changed during selection');if(input)guards.push({path:source,bytes:input.length,sha256:sha(input)});if(reason)transforms.push({path:name,reason,input:input?{bytes:input.length,sha256:sha(input)}:null,output:{bytes:bytes.length,sha256:sha(bytes)}});}
  async function tree(relativeRoot,filter=()=>true){for(const row of await filesBelow(join(root,relativeRoot))){const name=relativeRoot+'/'+row.path;if(filter(row.path))await add(name,row.bytes,join(root,name));}}
  await tree('src',name=>!name.endsWith('/README.md'));
  for(const file of desktopAppearancePreviewFiles){const name='public/appearance-previews/'+file;await add(name,await checked(join(root,name)),join(root,name));}
  await tree('public/structure-library');
  for(const name of ['public/favicon.svg','public/brand-icon.png','public/molecule-editor.html'])await add(name,await checked(join(root,name)),join(root,name));
  for(const name of [...c.applicationFiles.filter(n=>n!=='dist'&&n!=='src/data/conformer-solvation.json'&&!n.startsWith('node_modules/')),'desktop/personal-fragments-schema.d.mts','desktop/workspace-snapshot-codec.d.mts'])await add(name,await checked(join(root,name)),join(root,name));
  const profile=JSON.parse(await checked(join(root,'desktop/packaging/native-profile.json')));delete profile.preparation;
  await add('desktop/packaging/native-profile.json',encoded(profile),join(root,'desktop/packaging/native-profile.json'),'Remove machine-bound preparation reference; public local builder requires a fresh actual preparation');
  for(const name of profile.nativeSources)await add(name,await checked(join(root,name)),join(root,name));
  for(const name of ['scripts/prepare-preload.mjs','scripts/prepare-conformer-batch-runtime.mjs','scripts/prepare-task-system.mjs','desktop/preload-managed-results.cjs'])await add(name,await checked(join(root,name)),join(root,name));
  for(const name of [...NATIVE_BUILDERS.filter(name=>name!=='src/data/conformer-solvation.json'),...XTB_PATCH_BUILDERS,'desktop/launcher/sciyue-launcher.c','desktop/launcher/version.rc','scripts/portable/launcher.mjs','scripts/portable/io.mjs','scripts/portable-package-layout.mjs','scripts/3dmol-bond-primitives.cjs','scripts/prepare-chemistry.mjs','scripts/prepare-runtime-assets.mjs','scripts/prepare-workbench-preferences.mjs','scripts/prepare-structure-provenance.mjs','scripts/desktop-start.mjs','scripts/desktop-dev.mjs','scripts/portable/assets/sciyue.ico','index.html','vite.config.ts','package-lock.json','LICENSE.txt'])await add(name,await checked(join(root,name)),join(root,name));
  const artifactHelpers=join(root,'scripts/portable-artifact-identity.mjs');
  await add('scripts/portable-artifact-identity.mjs',publicArtifactPathHelpers(await checked(artifactHelpers)),artifactHelpers,'Public IO uses the unchanged packageRelativePath guard only; omit developer desktop target and internal delivery/acceptance functions');
  const icon=JSON.parse(await checked(join(root,'scripts/portable/assets/source.json')));delete icon.historicalProvenance;
  await add('scripts/portable/assets/source.json',encoded(icon),join(root,'scripts/portable/assets/source.json'),'Remove private icon-generation history; retain exact existing SVG/ICO identities');
  await add('scripts/portable/contract.mjs',Buffer.from("export {ROOT,createPortableContract,runId,assertCurrentRoot} from '../release/contract.mjs';\n"),null,'Public launcher contract has no old internal receipt constants');
  await tree('scripts/release',name=>!name.endsWith('.test.mjs')&&!name.endsWith('.test.py')&&!name.includes('__pycache__/'));
  await tree('third-party/build-inputs');
  for(const row of await correspondingSourceMaterials(root))await add(row.name,row.bytes,row.source);
  for(const name of ['native-runtime','native-toolchain','xtb-runtime']){
    const activePath=join(root,'desktop/packaging/'+name+'.lock.json');
    let bytes=await checked(join(root,'third-party/build-inputs/declarations',name+'.lock.json'));
    if(name==='xtb-runtime'){
      const active=JSON.parse(await checked(activePath));
      if(active.localModification?.algorithm==='xtb-h-only-initial-cap-v1'){
        const receipt=planned.get(XTB_PUBLIC_SOURCE_RECEIPT.toLowerCase());
        assert(receipt,'Modified xTB source receipt must be an indexed public source member');
        bytes=encoded(publicXtbSourceLock(JSON.parse(bytes),active,receipt.bytes));
      }
    }
    await add('desktop/packaging/'+name+'.lock.json',bytes,activePath,'Use public build/acquisition contract; bind a modified xTB receipt to its exact included relative member and retain source-build-required state');
  }
  const ts=JSON.parse(await checked(join(root,'tsconfig.json')));ts.include=['src','vite.config.ts'];delete ts.exclude;await add('tsconfig.json',encoded(ts),join(root,'tsconfig.json'),'Product-only TypeScript build; private test corpus is not exported');
  const commands=['prepare:chemistry','prepare:runtime','predev','prebuild','dev','build','preview','prepare:desktop','desktop:start','desktop:dev'];pkg.scripts=Object.fromEntries(commands.map(k=>[k,pkg.scripts[k]]));await add('package.json',encoded(pkg),join(root,'package.json'),'Expose supported standalone source commands; locked dependencies/version unchanged');
  for(const row of await filesBelow(licenseDirectory))await add('licenses/'+row.path,row.bytes,join(licenseDirectory,row.path));
  for(const name of ['README.md','BUILDING.md'])await add(name,await checked(join(root,'scripts/release/templates',name)),null,'Public build documentation template');
  const native={schema:'sy-source-native-identity/v1',sourceFiles:[],builderSources:[],xtbPatchSources:[]};
  for(const name of profile.nativeSources){const bytes=await checked(join(root,name));native.sourceFiles.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  for(const name of NATIVE_BUILDERS){const bytes=await checked(join(root,name));native.builderSources.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  for(const name of XTB_PATCH_BUILDERS){const bytes=await checked(join(root,name));native.xtbPatchSources.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  await add('source-native-identity.json',encoded(native),null,'Exact engine sources/builders and separately identified xTB patch sources; no private receipt copied');
  return{version:pkg.version,sourceCommit,planned:[...planned.values()],guards,transforms};
}
export async function exportSource(options){
  const plan=await sourcePlan(options),destination=resolve(options.destination);assert(destination!==ROOT&&!ROOT.startsWith(destination+'/'));
  const rel=relative(ROOT,destination).replaceAll('\\','/');assert(!/^(?:src|desktop|scripts|public|third-party|node_modules|\.local)(?:\/|$)/.test(rel));
  await fresh(destination);const files=[];for(const row of plan.planned)files.push(await put(destination,row.name,row.bytes));
  for(const guard of plan.guards){const data=await checked(guard.path);assert.equal(data.length,guard.bytes);assert.equal(sha(data),guard.sha256,'Source drift during export');}
  const manifest={schema:'sy-public-source-snapshot/v1',version:plan.version,sourceCommit:plan.sourceCommit,files,transforms:plan.transforms,officialAcceptance:false,scientificExecution:false};
  await put(destination,'source-export-manifest.json',encoded(manifest));return{destination,files:files.length,manifestSha256:sha(encoded(manifest)),officialAcceptance:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [file]=process.argv.slice(2);assert(file,'Supply one explicit JSON options file');console.log(JSON.stringify(await exportSource(JSON.parse(await readFile(file,'utf8'))),null,2));
}
