// Same-interface local library derivation, without loading or executing native code.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTree,readFileChecked,encoded,identity,sha} from '../portable/io.mjs';
import {verifyLibxtbRuntime} from '../portable/pes-libxtb-runtime.mjs';

export async function derivePesLibrary({sourceRoot,baseLibraryRoot,basePesRoot,replacementLibrary,outputRoot}){
 sourceRoot=resolve(sourceRoot);baseLibraryRoot=resolve(baseLibraryRoot);basePesRoot=resolve(basePesRoot);outputRoot=resolve(outputRoot);
 const componentPath='desktop/packaging/pes-libxtb-runtime.lock.json',pesPath='desktop/packaging/pes-runtime.lock.json';
 const parentLockBytes=await readFileChecked(join(sourceRoot,componentPath)),lock=JSON.parse(parentLockBytes);
 const parent=await verifyLibxtbRuntime(baseLibraryRoot,lock),dll=await readFileChecked(resolve(replacementLibrary));
 assert(dll.length>0,'Replacement library is empty');assert.notEqual(sha(dll),lock.identity.librarySha256,'Replacement must change actual library bytes');
 const parentPesBytes=await readFileChecked(join(basePesRoot,'runtime.json')),parentPes=JSON.parse(parentPesBytes);
 const pes=JSON.parse(await readFileChecked(join(sourceRoot,pesPath)));assert.equal(parentPes.schema,pes.schema);
 assert.equal(parentPes.residentLibrary?.runtimeManifest?.sha256,parent.reference.sha256,'PES parent must bind this library');
 const manifest=structuredClone(parent.manifest);manifest.files=manifest.files.map(r=>r.path===lock.libraryRelativePath?identity(r.path,dll):r);
 manifest.identity={...manifest.identity,buildKind:'explicit-user-modified-library',librarySha256:sha(dll),filesSha256:sha(JSON.stringify(manifest.files)),parentLibrarySha256:lock.identity.librarySha256};
 const manifestBytes=encoded(manifest),ref=identity('runtime.json',manifestBytes),derived={...lock,identity:manifest.identity,files:manifest.files,runtimeManifest:ref};
 pes.baseRuntime={lockSha256:parentPes.lockSha256,runtimeManifest:identity('runtime.json',parentPesBytes)};
 pes.residentLibrary={...pes.residentLibrary,manifestSha256:ref.sha256};
 const tree=await createTree(outputRoot);
 for(const row of parent.files){const b=row.path==='runtime.json'?manifestBytes:row.path===lock.libraryRelativePath?dll:await readFileChecked(join(baseLibraryRoot,row.path),row);await tree.put('libxtb/'+row.path,b);}
 await tree.put('source-overlay/'+componentPath,encoded(derived));await tree.put('source-overlay/'+pesPath,encoded(pes));
 const receipt={schema:'ester-local-pes-library-derivation/v1',parentManifest:parent.reference,parentComponentLock:identity(componentPath,parentLockBytes),library:identity(lock.libraryRelativePath,dll),runtimeManifest:ref,sourceOverlay:['source-overlay/'+componentPath,'source-overlay/'+pesPath],officialAcceptance:false,scientificAccepted:false,actualLoadValidated:false,scientificEvaluations:0};
 await tree.put('derivation.json',encoded(receipt));await verifyLibxtbRuntime(join(outputRoot,'libxtb'),derived);return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [file]=process.argv.slice(2);assert(file,'Supply explicit JSON options');console.log(JSON.stringify(await derivePesLibrary(JSON.parse(await readFile(file))),null,2));}
