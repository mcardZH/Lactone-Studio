'use strict';

const { createHash } = require('node:crypto');
const { createBinaryExportStore } = require('../binary-export-store.cjs');

function fail(code) {return Object.assign(new Error(code),{code});}

/** Copy a pinned artifact without publishing any bytes before both source hashes agree. */
async function copyTaskArtifact({ owner, target, sourcePath, transport, identity, signal, assertDestination }) {
  const check = () => {if(signal?.aborted)throw fail('TASK_REQUEST_CANCELLED');};
  check();
  const store=createBinaryExportStore({chooseDestination:async()=>({path:target,overwriteConfirmed:false}),assertDestination,ownerAlive:check});
  let receipt;
  try{
    const {token}=await store.begin(owner,{name:'job-artifact',extension:'bin'});
    const range={offset:0,length:identity.byteSize};
    const before=await transport.hash({path:sourcePath,identity,algorithm:'sha256',range,signal});
    const hash=createHash('sha256');
    for(let offset=0;offset<identity.byteSize;offset+=1024*1024){
      check();
      const length=Math.min(1024*1024,identity.byteSize-offset);
      const result=await transport.readRange({path:sourcePath,identity,offset,length,signal});
      const bytes=Buffer.from(result.bytes??result);
      if(bytes.length!==length)throw fail('SAVE_COPY_SHORT_READ');
      check();
      await store.append(owner,token,bytes);
      hash.update(bytes);
    }
    check();
    const after=await transport.hash({path:sourcePath,identity:await transport.stat(sourcePath),algorithm:'sha256',range,signal});
    if(hash.digest('hex')!==before.hash||before.hash!==after.hash)throw fail('SAVE_COPY_SOURCE_CHANGED');
    check();
    const result=await store.commit(owner,token);
    receipt={saved:true,path:target,bytes:result.bytes,sha256:before.hash};
  }catch(error){
    try{await store.dispose();}
    catch{if(error instanceof Error&&Object.isExtensible(error))error.temporaryCleanupFailed=true;}
    throw error;
  }
  try{await store.dispose();}
  catch(error){
    if(error instanceof Error&&Object.isExtensible(error)){
      error.publicationPerformed=true;
      error.temporaryCleanupFailed=true;
    }
    throw error;
  }
  return receipt;
}

module.exports={copyTaskArtifact};
