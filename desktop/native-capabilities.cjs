'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
/** Cheap module admission only: no molecule, optimizer or electronic calculation. */
function createNativeCapabilities({ spawn, stat = fs.statSync, timeoutMs = 4000 }) {
  const cache = new Map(), pending = new Set(); let disposed = false;
  const unavailable = () => ({ periodicGfn2BondOrders: false });
  function identity(runtime) {
    const files = [runtime.executable, ...runtime.args.filter(value => /\.py$/i.test(value))];
    if(!runtime.bundled)files.push(path.join(runtime.cwd,'xtb_periodic_bonds.py'));
    return JSON.stringify([runtime.executable,runtime.args,files.map(file=>{const s=stat(file);return[file,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];})]);
  }
  return {
    read(owner, runtime) {
      if(disposed)return Promise.resolve(unavailable());
      let key;try{key=identity(runtime);}catch{return Promise.resolve(unavailable());}
      if(cache.has(key))return cache.get(key);
      const promise = new Promise(resolve => {
        let child, timer, settled=false, failed=false, text='', stderr='';const decoder=new StringDecoder('utf8');
        const job={owner,kill(){failed=true;cache.delete(key);try{child?.kill();}catch{}},closed:null};
        job.closed=new Promise(done=>{job.done=done;});
        const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
        try{
          child=spawn(runtime.executable,[...runtime.args,'--capabilities'],{cwd:runtime.cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
          pending.add(job);
          timer=setTimeout(()=>{job.kill();finish(unavailable());},timeoutMs);timer.unref?.();
          child.stdout.on('data',bytes=>{if(settled)return;text+=decoder.write(bytes);if(Buffer.byteLength(text)>16384){job.kill();finish(unavailable());}});
          child.stderr.on('data',bytes=>{if(settled)return;stderr+=bytes.toString('utf8');if(Buffer.byteLength(stderr)>8192){job.kill();finish(unavailable());}});
          child.on('error',()=>{job.kill();finish(unavailable());});
          child.once('close',(code,signal)=>{
            pending.delete(job);job.done();
            if(settled)return;
            try{const value=JSON.parse(text+decoder.end());if(failed||disposed||code!==0||signal||stderr.trim()||value.schema!=='sciyue-native-capabilities/v1'||value.periodicGfn2BondOrders!==true||value.module!=='xtb_periodic_bonds'||typeof value.tbliteVersion!=='string'||!value.tbliteVersion||typeof value.libraryVersion!=='string'||!value.libraryVersion)throw Error();finish({periodicGfn2BondOrders:true,tbliteVersion:value.tbliteVersion,libraryVersion:value.libraryVersion});}catch{finish(unavailable());}
          });
        }catch{if(!child){job.done();finish(unavailable());}else{job.kill();finish(unavailable());}}
      });
      cache.set(key,promise);return promise;
    },
    closeOwner(owner){for(const job of pending)if(job.owner===owner)job.kill();},
    dispose(){disposed=true;for(const job of pending)job.kill();cache.clear();},
    settle(){return Promise.all([...pending].map(job=>job.closed));},
  };
}
module.exports={createNativeCapabilities};
