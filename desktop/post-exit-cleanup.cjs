'use strict';
const fs=require('node:fs');
const io=require('node:fs/promises');
const path=require('node:path');
const {checkedDirectory}=require('./portable-profile.cjs');
const {checkDirectory,readChecked,atomicWrite}=require('./portable-storage.cjs');
const {assert}=require('./security.cjs');
/** The read handle deliberately remains open until OS process teardown, after
 * Chromium's final flush. A launcher needs exclusive access before deletion. */
function createPostExitCleanup({profile,environment=process.env,parentPid=process.ppid,pid=process.pid}){
  if(profile?.layout?.layoutVersion!==2)return null;
  assert(checkedDirectory(fs,profile.root)===profile.identities.root,'POST_EXIT_ROOT_CHANGED');
  const lock=path.join(profile.root,'.chromium-cache.lock');
  try{const created=fs.openSync(lock,'wx');fs.closeSync(created);}catch(error){if(error.code!=='EEXIST')throw error;}
  const before=fs.lstatSync(lock);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1,'POST_EXIT_LOCK_UNSAFE');
  const leaseFD=fs.openSync(lock,'r'),held=fs.fstatSync(leaseFD);
  if(!held.isFile()||held.nlink!==1||held.dev!==before.dev||held.ino!==before.ino){fs.closeSync(leaseFD);throw Error('POST_EXIT_LOCK_CHANGED');}
  const token=environment.SCIYUE_LAUNCH_CACHE_TOKEN,match=typeof token==='string'&&/^L([1-9][0-9]{0,9})-[a-f0-9]{16}$/.exec(token);
  const available=Boolean(match&&Number(match[1])===parentPid);
  return{available,leaseFD,async defer(){
    assert(available&&profile.run.pid===pid,'POST_EXIT_OWNER_UNCONFIRMED');
    for(const key of ['root','cache','temp'])await checkDirectory(key==='root'?profile.root:profile.paths[key],profile.identities[key]);
    const marker=await readChecked(path.join(profile.paths.temp,'.portable-run.json'),4096),active=JSON.stringify(profile.run);
    assert(marker.bytes.toString('utf8')===active+'\n'&&profile.run.state==='active','POST_EXIT_RUN_CHANGED');
    const tag=path.basename(profile.paths.cache);assert(/^v\d+\.\d+\.\d+(?:-r(?:[2-9]|[1-9]\d+))?$/.test(tag)&&/^[A-Za-z0-9_-]{1,80}$/.test(profile.runId),'POST_EXIT_TAG_INVALID');
    const [state,cache,temp]=await Promise.all([profile.root,profile.paths.cache,profile.paths.temp].map(file=>io.lstat(file,{bigint:true})));
    const text=['SCIYUE_POST_EXIT_V1',token,String(pid),tag,profile.runId,state.ino.toString(),cache.ino.toString(),temp.ino.toString(),active].join('\n')+'\n';
    assert(text.length<8192&&/^[\x20-\x7e\n]+$/.test(text),'POST_EXIT_HANDOFF_INVALID');
    const file=path.join(profile.root,`.post-exit-${token}.request`);
    await atomicWrite(file,Buffer.from(text,'ascii'),null,profile.identities.root);
    return{deferred:true,token};
  }};
}
module.exports={createPostExitCleanup};
