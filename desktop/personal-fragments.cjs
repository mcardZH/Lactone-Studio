'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const schemaPromise=import('./personal-fragments-schema.mjs');
const statKey=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
const directoryKey=stat=>[stat.dev,stat.ino,stat.birthtimeMs].join(':');
const version=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(value,message)=>{if(!value)throw new Error('PERSONAL_FRAGMENT: '+message);};
/** Root is the EXISTING private portable data directory selected by the host,
 * never renderer-provided. All ancestors are pinned; bad/unknown JSON remains
 * untouched. Only this host queue and read-issued owner CAS baselines mutate. */
function createPersonalFragmentStore({root,beforeCommit}={}){
  check(typeof root==='string'&&path.isAbsolute(root),'absolute private root required');
  root=path.resolve(root);const file=path.join(root,'personal-fragments-v1.json');
  let queue=Promise.resolve(),closed=false;const baselines=new Map(),epochs=new Map();
  const generation=owner=>epochs.get(owner)??0;
  const active=(owner,epoch)=>{check((typeof owner==='string'&&owner.length>0&&owner.length<=160)||(Number.isSafeInteger(owner)&&owner>=0),'owner identity invalid');check(!closed&&generation(owner)===epoch,'owner/store closed');};
  async function directories(){
    const paths=[];for(let current=root;;current=path.dirname(current)){paths.unshift(current);if(path.dirname(current)===current)break;}
    const result=[];
    for(const item of paths){const stat=await fs.lstat(item);check(stat.isDirectory()&&!stat.isSymbolicLink(),'root/ancestor must be a real directory');const real=await fs.realpath(item);check(path.resolve(real).toLowerCase()===path.resolve(item).toLowerCase(),'root/ancestor resolves outside configured directory');result.push([item,directoryKey(stat),real]);}
    return JSON.stringify(result);
  }
  const initialParent=directories();initialParent.catch(()=>{});
  async function parent(){const initial=await initialParent,current=await directories();check(current===initial,'root/ancestor replaced; reopen store explicitly');return current;}
  async function load(){
    const schema=await schemaPromise,parentIdentity=await parent();let handle;
    try{
      let selected;try{selected=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'){await parent();return{library:schema.emptyPersonalFragmentLibrary(),version:'missing',writable:true,parentIdentity};}throw error;}
      check(selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1&&Number.isSafeInteger(selected.size)&&selected.size>=0,'file is linked/not regular/invalid size');
      handle=await fs.open(file,'r');const opened=await handle.stat();check(statKey(opened)===statKey(selected),'file changed during open');
      const bytes=await handle.readFile();check(bytes.length===opened.size&&statKey(await handle.stat())===statKey(opened)&&statKey(await fs.lstat(file))===statKey(opened),'file changed during read');await parent();
      const token=version(bytes);
      try{return{library:schema.validatePersonalFragmentLibrary(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))),version:token,writable:true,parentIdentity};}
      catch(error){return{library:schema.emptyPersonalFragmentLibrary(),version:token,writable:false,parentIdentity,error:'个人片段库损坏或版本未支持，原文件已保留；禁止覆盖：'+error.message};}
    }finally{await handle?.close();}
  }
  const snapshot=state=>({library:structuredClone(state.library),version:state.version,writable:state.writable,...(state.error?{error:state.error}:{})});
  const serialize=action=>{const pending=queue.then(action);queue=pending.catch(()=>{});return pending;};
  return{
    settle:()=>queue,
    read(owner){const epoch=generation(owner);return serialize(async()=>{active(owner,epoch);const state=await load();active(owner,epoch);baselines.set(owner,state);return snapshot(state);});},
    update(owner,request){const epoch=generation(owner);return serialize(async()=>{
      active(owner,epoch);check(request&&typeof request==='object'&&!Array.isArray(request)&&[Object.prototype,null].includes(Object.getPrototypeOf(request))&&Reflect.ownKeys(request).length===2&&['library','baseVersion'].every(key=>Object.hasOwn(request,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(request,key),'value'))&&typeof request.baseVersion==='string'&&request.baseVersion.length<=64,'invalid CAS request');
      const schema=await schemaPromise,library=schema.validatePersonalFragmentLibrary(request.library),baseline=baselines.get(owner);active(owner,epoch);
      check(baseline&&baseline.version===request.baseVersion,'read owner snapshot before update');const current=await load();active(owner,epoch);
      check(baseline.writable&&current.writable,'bad/future schema preserved; write forbidden');
      check(current.version===baseline.version&&current.parentIdentity===baseline.parentIdentity,'CAS conflict; read current library and retry explicitly');
      const bytes=Buffer.from(schema.serializePersonalFragmentLibrary(library));
      const temporary=path.join(root,'.personal-fragments-'+randomUUID()+'.tmp');let temporaryIdentity;
      try{
        await parent();active(owner,epoch);const handle=await fs.open(temporary,'wx');
        try{temporaryIdentity=statKey(await handle.stat());await handle.writeFile(bytes);await handle.sync();temporaryIdentity=statKey(await handle.stat());}finally{await handle.close();}
        if(beforeCommit)await beforeCommit({file,temporary});
        await parent();active(owner,epoch);const recheck=await load();active(owner,epoch);
        check(recheck.writable&&recheck.version===current.version&&recheck.parentIdentity===current.parentIdentity,'file/parent changed before atomic commit');
        check(statKey(await fs.lstat(temporary))===temporaryIdentity,'owned temporary file replaced');await parent();active(owner,epoch);
        // First publication cannot overwrite an external file born after read.
        if(current.version==='missing'){await fs.link(temporary,file);await fs.unlink(temporary);}else await fs.rename(temporary,file);
        const saved=await load();active(owner,epoch);check(saved.version===version(bytes),'file changed after commit; reread required');baselines.set(owner,saved);return snapshot(saved);
      }finally{
        // Never unlink a same-name replacement or follow a swapped parent.
        if(temporaryIdentity){try{await parent();const stat=await fs.lstat(temporary);if(stat.isFile()&&!stat.isSymbolicLink()&&statKey(stat)===temporaryIdentity)await fs.unlink(temporary);}catch{/* Preserve uncertain filesystem contents, never broaden cleanup. */}}
      }
    });},
    disposeOwner(owner){epochs.set(owner,generation(owner)+1);baselines.delete(owner);},
    dispose(){closed=true;baselines.clear();},
  };
}
module.exports={createPersonalFragmentStore};
