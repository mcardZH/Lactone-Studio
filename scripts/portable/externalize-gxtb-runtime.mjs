// Create a new runtime; retained internal runtimes are never edited in place.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import contract from '../../desktop/xtb-runtime-contract.cjs';
import {createTree,readFileChecked,encoded,identity} from './io.mjs';
export function planExternalGxtbRuntime(record,before){
 assert.equal(record.schema,contract.RUNTIME_SET,'Externalization starts from the historical complete v3 runtime');
 const excluded=before.files.filter(r=>r.path.startsWith('variants/gxtb/'));
 assert(excluded.length>0,'Expected exclusive g-xTB members');
 const externalNotice=encoded({schema:'ester-external-program-reference/v1',program:'g-xTB',route:'user-supplied-cli',downloadUrl:'https://github.com/grimme-lab/g-xtb/releases',binaryBundled:false,samePackageDllsRequired:true});
 const generated=new Map([['provenance/gxtb.json',externalNotice]]);
 const files=before.files.filter(r=>!r.path.startsWith('variants/gxtb/')).map(r=>generated.has(r.path)?identity(r.path,generated.get(r.path)):r);
 const inv=encoded({...before,files}),descriptor={...structuredClone(record),schema:contract.EXTERNAL_GXTB_RUNTIME_SET,methods:['gfn0','gfn1','gfn2','gfnff'],externalProviders:{gxtb:'user-supplied-cli'},inventory:identity('inventory.json',inv)};
 delete descriptor.variants.gxtb;
 return{excluded,files,generated,inventoryBytes:inv,descriptor,runtimeBytes:encoded(descriptor)};
}
export async function externalizeGxtbRuntime({inputRoot,outputRoot,expectedManifest}){
 inputRoot=resolve(inputRoot);outputRoot=resolve(outputRoot);assert.notEqual(inputRoot,outputRoot);
 const verified=contract.verifyRuntimeSet(inputRoot,expectedManifest),record=structuredClone(verified.record);
 const before=JSON.parse(await readFileChecked(join(inputRoot,record.inventory.path),record.inventory));
 const {excluded,files,generated,inventoryBytes:inv,runtimeBytes:descriptorBytes}=planExternalGxtbRuntime(record,before);
 const runtimeManifest=identity('runtime.json',descriptorBytes),tree=await createTree(outputRoot);
 for(const row of files)await tree.put(row.path,generated.get(row.path)??await readFileChecked(join(inputRoot,row.path),row));
 await tree.put('inventory.json',inv);await tree.put('runtime.json',descriptorBytes);
 const result=contract.verifyRuntimeSet(outputRoot,runtimeManifest);
 return{schema:'ester-external-gxtb-runtime-projection/v1',runtimeManifest,variantIdentities:Object.fromEntries(Object.entries(result.variants).map(([id,v])=>[id,v.engineIdentity])),excluded,files:[...files,identity('inventory.json',inv),runtimeManifest],scientificEvaluations:0};
}
