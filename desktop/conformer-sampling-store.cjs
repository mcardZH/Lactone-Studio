'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {assert}=require('./security.cjs');

/** Host-owned immutable terminal results. Each disk shard and each read are
 * limited to 64 frames; renderer transport never carries the complete set. */
function createConformerSamplingStore({fs,root}){
  const entries=new Map(),pageSize=64;
  async function ordinary(target){const stat=await fs.lstat(target),actual=await fs.realpath(target);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&(process.platform==='win32'?path.resolve(actual).toLowerCase()===path.resolve(target).toLowerCase():path.resolve(actual)===path.resolve(target)),'Unsafe sampling result directory');}
  async function durableWrite(target,text){const file=await fs.open(target,'wx');try{await file.writeFile(text,'utf8');await file.sync();}finally{await file.close();}}
  async function create(owner){
    await fs.mkdir(root,{recursive:true});await ordinary(root);
    const id=randomUUID(),directory=path.join(root,id);await fs.mkdir(directory);await ordinary(directory);
    await fs.writeFile(path.join(directory,'.retain-recovery.json'),JSON.stringify({schema:1,owner,id,kind:'sampling-results'})+'\n',{flag:'wx'});
    const entry={id,owner,directory,count:0,pending:[],shards:[],tail:Promise.resolve(),committed:false,reads:new Set()};entries.set(id,entry);
    return entry;
  }
  async function flush(entry){
    if(!entry.pending.length)return;
    const rows=entry.pending;entry.pending=[];const name=`frames-${String(entry.shards.length).padStart(6,'0')}.json`;
    await durableWrite(path.join(entry.directory,name),JSON.stringify(rows)+'\n');
    entry.shards.push({name,offset:entry.count-rows.length,count:rows.length});
  }
  function append(entry,frame){
    assert(!entry.committed&&entries.get(entry.id)===entry,'Sampling result is already sealed');
    entry.tail=entry.tail.then(async()=>{entry.pending.push(frame);entry.count++;if(entry.pending.length===pageSize)await flush(entry);});
    return entry.tail;
  }
  async function commit(entry,metadata){
    await entry.tail;await flush(entry);await ordinary(entry.directory);
    await durableWrite(path.join(entry.directory,'manifest.json'),JSON.stringify({schema:1,id:entry.id,owner:entry.owner,frameCount:entry.count,shards:entry.shards,...metadata})+'\n');
    entry.committed=true;return{id:entry.id,frameCount:entry.count};
  }
  function owned(owner,id){assert(typeof id==='string'&&entries.has(id),'Unknown sampling result');const entry=entries.get(id);assert(entry.owner===owner&&entry.committed,'Sampling result owner/commit mismatch');return entry;}
  async function readPage(owner,id,offset,limit=64){
    const entry=owned(owner,id);assert(Number.isSafeInteger(offset)&&offset>=0&&offset<=entry.count&&Number.isSafeInteger(limit)&&limit>=1&&limit<=pageSize,'Invalid sampling result page');
    await ordinary(entry.directory);const frames=[],end=Math.min(entry.count,offset+limit);
    for(const shard of entry.shards){if(shard.offset>=end)break;if(shard.offset+shard.count<=offset)continue;
      const target=path.join(entry.directory,shard.name),stat=await fs.lstat(target);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Unsafe sampling result shard');
      const rows=JSON.parse(await fs.readFile(target,'utf8'));assert(Array.isArray(rows)&&rows.length===shard.count,'Sampling result shard changed');
      frames.push(...rows.slice(Math.max(0,offset-shard.offset),Math.min(rows.length,end-shard.offset)));
    }
    assert(frames.length===end-offset,'Incomplete sampling result page');return{frames,offset,total:entry.count,done:end===entry.count};
  }
  async function read(owner,id,offset,limit=64){
    const entry=owned(owner,id);assert(!entry.releasing&&!entry.closing,'Sampling result is being released or its owner is closing');
    const pending=readPage(owner,id,offset,limit);entry.reads.add(pending);pending.finally(()=>entry.reads.delete(pending)).catch(()=>{});return pending;
  }
  async function release(owner,id){
    const entry=owned(owner,id);assert(!entry.releasing&&!entry.closing,'Sampling result is already being released or its owner is closing');entry.releasing=true;
    // This is the explicit adoption acknowledgement. Owner close is separate
    // and must never infer acknowledgement from a renderer's disappearance.
    entry.releaseTask=(async()=>{try{await Promise.allSettled([...entry.reads]);await ordinary(entry.directory);
    // Exact owned manifest, never a recursive directory deletion. A failed
    // unlink retains the handle for a later retry and reports its real error.
    const names=[...entry.shards.map(s=>s.name),'manifest.json','.retain-recovery.json'];
    for(const name of names){const target=path.join(entry.directory,name);let stat;try{stat=await fs.lstat(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Sampling result member changed');await fs.unlink(target);}
    await fs.rmdir(entry.directory);entries.delete(id);return{released:true};
    }finally{entry.releasing=false;}})();return entry.releaseTask;
  }
  async function closeOwner(owner){
    await Promise.all([...entries.values()].filter(e=>(owner===undefined||e.owner===owner)&&e.committed).map(async entry=>{
      if(entry.releasing){await entry.releaseTask;return;}
      if(entry.closing){await entry.closeTask;return;}
      entry.closing=true;
      entry.closeTask=(async()=>{
        await Promise.allSettled([...entry.reads]);
        // Successful raw may already be gone. Keep the immutable canonical
        // shards, source manifest and recovery marker until an explicit ack;
        // only abandon the dead renderer's in-memory ownership here.
        if(entries.get(entry.id)===entry)entries.delete(entry.id);
      })();await entry.closeTask;
    }));
  }
  return{create,append,commit,read,release,closeOwner};
}
module.exports={createConformerSamplingStore};
