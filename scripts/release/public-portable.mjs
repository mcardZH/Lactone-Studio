// Make a clean public-shaped local candidate from a fully manifested staging input.
// This is a new copy. It neither mutates the retained candidate nor uploads it.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTree,readFileChecked,encoded,identity} from '../portable/io.mjs';
import {externalizeGxtbRuntime} from '../portable/externalize-gxtb-runtime.mjs';
const privateString=/(?:\b[A-Za-z]:[\\/]|\/(?:home|Users)\/|(?:^|[\\/])(?:\.private|\.cache|\.local)(?:[\\/]|$))/i;
const privateFields=new Set(['sourceRoot','inputRoot','outputRoot','stagingRoot','stage','target','cwd','env','environment','command','commands','execution','stdout','stderr','historicalProvenance','history','receiptPath','preconfiguredMultiwfn']);
export function publicProvenance(value,key=''){
 if(privateFields.has(key))return undefined;
 if(typeof value==='string')return privateString.test(value)?undefined:value;
 if(Array.isArray(value))return value.map(v=>publicProvenance(v)).filter(v=>v!==undefined);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicProvenance(v,k)]).filter(([,v])=>v!==undefined));
 return value;
}
const forbiddenMember=p=>p.startsWith('runtime/state/')||p.startsWith('runtime/resources/pes/third-party/pysisyphus/')||p.startsWith('runtime/resources/xtb/variants/gxtb/');
export async function projectPublicPortable({inputRoot,outputRoot,sourceRoot,version,sourceCommit,manifestPath='runtime/provenance/portable-manifest.json',sourceArchiveName}){
 inputRoot=resolve(inputRoot);outputRoot=resolve(outputRoot);sourceRoot=resolve(sourceRoot);
 assert(/^\d+\.\d+\.\d+$/.test(version)&&/^[a-f0-9]{40}$/.test(sourceCommit));
 assert(sourceArchiveName&&/^[A-Za-z0-9._-]+\.zip$/.test(sourceArchiveName),'Companion source ZIP name required');
 const inputManifestBytes=await readFileChecked(join(inputRoot,manifestPath)),manifest=JSON.parse(inputManifestBytes);
 assert.equal(manifest.version,version);assert.equal(manifest.sourceCommit??manifest.frontendProductCommit,sourceCommit);
 const licenses=JSON.parse(await readFileChecked(join(sourceRoot,'licenses/SOURCE_INDEX.json')));assert.equal(licenses.version,version);
 const tree=await createTree(outputRoot),files=[],add=async(p,b)=>files.push(await tree.put(p,b));
 // Old development/build receipts are never copied wholesale into public provenance.
 for(const row of manifest.files){
  if(row.path===manifestPath||forbiddenMember(row.path)||row.path.startsWith('runtime/provenance/')||row.path.startsWith('licenses/')||row.path.startsWith('runtime/resources/xtb/'))continue;
  await add(row.path,await readFileChecked(join(inputRoot,row.path),row));
 }
 for(const row of [...licenses.files,identity('SOURCE_INDEX.json',await readFileChecked(join(sourceRoot,'licenses/SOURCE_INDEX.json')))])await add('licenses/'+row.path,await readFileChecked(join(sourceRoot,'licenses',row.path),row));
 const dependencies=JSON.parse(await readFileChecked(join(inputRoot,'runtime/provenance/dependencies.json')));
 await mkdir(join(outputRoot,'runtime/resources'),{recursive:true});
 const xtb=await externalizeGxtbRuntime({inputRoot:join(inputRoot,'runtime/resources/xtb'),outputRoot:join(outputRoot,'runtime/resources/xtb'),expectedManifest:dependencies.xtb.runtimeManifest});
 files.push(...xtb.files.map(r=>({...r,path:'runtime/resources/xtb/'+r.path})));
 dependencies.xtb={...publicProvenance(dependencies.xtb),schema:'sciyue-xtb-bundled-runtime/v4',runtimeManifest:xtb.runtimeManifest,variants:xtb.variantIdentities,externalProviders:{gxtb:'user-supplied-cli'}};
 await add('runtime/provenance/dependencies.json',encoded(publicProvenance(dependencies)));
 for(const name of ['native-build.json','OPENBLAS-RUNTIME.json','pes-libxtb/build-provenance.json']){
  const row=manifest.files.find(r=>r.path==='runtime/provenance/'+name);if(row)await add(row.path,encoded(publicProvenance(JSON.parse(await readFileChecked(join(inputRoot,row.path),row)))));
 }
 await add('runtime/provenance/release.json',encoded({schema:'ester-public-shaped-local-candidate/v1',version,sourceCommit,publicDistributionApproved:false,uploadPerformed:false,companionSourceArchive:sourceArchiveName,sourceMaterialIndex:'licenses/COMPONENT_SOURCES.json',externalPrograms:['Gaussian','ORCA','Multiwfn','g-xTB']}));
 const outManifest={schema:'ester-public-shaped-portable-manifest/v1',version,peVersion:version+'.0',candidateId:manifest.candidateId,profileTag:'v'+version,revision:'',sourceCommit,publicDistributionApproved:false,uploadPerformed:false,manifestSelfExcludedFromHashes:true,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
 const bytes=encoded(outManifest);await tree.put('runtime/provenance/portable-manifest.json',bytes);
 const sourceLock={schema:'sciyue-xtb-lock-v1',platform:'win32-x64',lockId:'xtb-public-v4-'+version,root:'.local/dependencies/win-x64/xtb-public-v4-'+version,contentDirectories:['xtb'],version:'6.8.0',entry:'xtb/bin/xtb.exe',dataDirectory:'xtb/share/xtb',methods:['gfn0','gfn1','gfn2','gfnff'],scope:'local-experimental',localUseReady:false,sourceBuildRequired:true,publicRedistributionReviewed:false,distributionLicenseReady:false,runtimeManifest:xtb.runtimeManifest,variantIdentities:xtb.variantIdentities,externalProviders:{gxtb:'user-supplied-cli'}};
 return{schema:'ester-public-portable-projection/v1',version,sourceCommit,candidateId:manifest.candidateId,parentManifest:identity(manifestPath,inputManifestBytes),members:files.length+1,manifest:identity('runtime/provenance/portable-manifest.json',bytes),sourceXtbLock:sourceLock,excludedGxtb:xtb.excluded,scientificEvaluations:0,uploadPerformed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [options]=process.argv.slice(2);assert(options);console.log(JSON.stringify(await projectPublicPortable(JSON.parse(await readFile(options))),null,2));}
