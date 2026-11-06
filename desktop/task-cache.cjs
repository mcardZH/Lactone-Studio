'use strict';
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {assert, within} = require('./security.cjs');
const token = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
async function directory(target, io = fs) {
  const stat = await io.lstat(target);
  const actual=path.resolve(await io.realpath(target)),expected=path.resolve(target);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (process.platform==='win32'?actual.toLowerCase()===expected.toLowerCase():actual===expected), 'TASK_CACHE_PATH: unsafe task directory');
  return stat;
}
/** Only for a newly allocated, closed task directory. Enumerate exact members,
 * validate the entire tree first, then recheck each identity before unlinking. */
async function cleanTaskDirectory(root, io = fs) {
  const fs = io;
  const dirs = [], files = [];
  async function collect(dir) {
    const stat = await directory(dir, fs); dirs.push([dir, `${stat.dev}:${stat.ino}`]);
    const names = await fs.readdir(dir);
    assert(!names.includes('.retain-recovery.json'), 'TASK_CACHE_RECOVERY_REQUIRED');
    for (const name of names) {
      const file = path.join(dir, name); assert(within(root, file) && file !== root, 'TASK_CACHE_ESCAPE');
      const value = await fs.lstat(file); assert(!value.isSymbolicLink(), 'TASK_CACHE_LINK_RETAINED');
      if (value.isDirectory()) await collect(file);
      else { assert(value.isFile() && value.nlink === 1, 'TASK_CACHE_MEMBER_RETAINED'); files.push([file, token(value)]); }
    }
  }
  await collect(root);
  let bytes = 0;
  for (const [file, identity] of files) {
    await directory(path.dirname(file), fs); const current = await fs.lstat(file);
    assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && token(current) === identity, 'TASK_CACHE_CHANGED');
    bytes += current.size; await fs.unlink(file);
  }
  for (const [dir, identity] of dirs.reverse()) { const current = await directory(dir, fs); assert(`${current.dev}:${current.ino}` === identity, 'TASK_CACHE_CHANGED'); await fs.rmdir(dir); }
  return {files: files.length, bytes};
}
function createTaskCache({root, pid = process.pid, alive = id => {try {process.kill(id, 0); return true;} catch (error) {return error.code !== 'ESRCH';}}, report = () => {}}) {
  const owner = `${pid}-${randomUUID()}`, ownerRoot = path.join(root, owner);
  const children = new Set();
  let ready, finishing;
  async function initialize() {
    await fs.mkdir(root, {recursive:true}); await directory(root);
    for (const name of await fs.readdir(root)) {
      if (!/^\d+-[a-f0-9-]{36}$/.test(name)) continue;
      const old = path.join(root, name);
      try {
        await directory(old); const marker = path.join(old, 'owner.json'), stat = await fs.lstat(marker);
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 4096, 'TASK_CACHE_OWNER');
        const value = JSON.parse(await fs.readFile(marker, 'utf8'));
        assert(value.schema === 1 && value.owner === name && Number.isSafeInteger(value.pid) && name.startsWith(`${value.pid}-`), 'TASK_CACHE_OWNER');
        const childIds = (await fs.readdir(old)).filter(member => /^child-\d+\.json$/.test(member)).map(member => Number(member.slice(6,-5)));
        if (!alive(value.pid) && !childIds.some(alive)) {
          // A crash may interrupt publication. Preserve the few native result
          // files needed for manual recovery before reclaiming evaluation raw.
          const recovery = path.join(root, 'recovery', name);
          const recoverNames = new Set(['input.xyz','input.coord','xcontrol.inp','md.inp','xtbopt.xyz','xtbopt.log','optimization.json','xtb.trj','mdrestart','molden.input','stdout.log','stderr.log','request.json','run-diagnostics.json','run-result.json','process.json','stdout.txt','stderr.txt','mtd-reference.xyz']);
          const recoveryMarkers=[];
          async function preserve(dir) {
            await directory(dir);
            for(const member of await fs.readdir(dir)) {
              const file=path.join(dir,member), info=await fs.lstat(file);
              assert(!info.isSymbolicLink(),'TASK_CACHE_LINK_RETAINED');
              if(info.isDirectory())await preserve(file);
              else if(member==='.retain-recovery.json')recoveryMarkers.push([file,token(info)]);
              else if(recoverNames.has(member)) {
                assert(info.isFile()&&info.nlink===1&&info.size<=64*1024*1024,'TASK_CACHE_RECOVERY_MEMBER');
                const destination=path.join(recovery,path.relative(old,file));
                await fs.mkdir(path.dirname(destination),{recursive:true});
                await directory(path.dirname(destination));
                await fs.copyFile(file,destination,syncFS.constants.COPYFILE_EXCL);
                assert(token(await fs.lstat(file))===token(info),'TASK_CACHE_RECOVERY_CHANGED');
              }
            }
          }
          await preserve(old);
          for(const [file,identity]of recoveryMarkers){assert(token(await fs.lstat(file))===identity,'TASK_CACHE_RECOVERY_CHANGED');await fs.unlink(file);}
          const result = await cleanTaskDirectory(old); report({event:'recovered', owner:name, recovery, ...result});
        }
      } catch (error) {report({event:'retained', owner:name, message:error.message});}
    }
    await fs.mkdir(ownerRoot); await directory(ownerRoot);
    await fs.writeFile(path.join(ownerRoot, 'owner.json'), JSON.stringify({schema:1, owner, pid})+'\n', {flag:'wx'});
    return ownerRoot;
  }
  return {
    root:ownerRoot,
    ready() {return ready ??= initialize();},
    track(child) {
      children.add(child);
      child.once('close', () => children.delete(child));
      if (!Number.isSafeInteger(child.pid) || !syncFS.existsSync(ownerRoot)) return child;
      const marker = path.join(ownerRoot, `child-${child.pid}.json`);
      let identity;
      try {syncFS.writeFileSync(marker, JSON.stringify({pid:child.pid})+'\n', {flag:'wx'});identity=token(syncFS.lstatSync(marker));}
      catch(error) {report({event:'retained',message:`Child ownership marker failed: ${error.message}`});return child;}
      child.once('close', () => {try {const current=syncFS.lstatSync(marker);if(!current.isSymbolicLink()&&token(current)===identity)syncFS.unlinkSync(marker);else report({event:'retained',message:'Child ownership marker changed'});} catch (error) {if(error.code!=='ENOENT')report({event:'retained',message:error.message});}});
      return child;
    },
    finish() {
      // A kill/error is not actual close. Failed attempts retain the directory
      // and may be retried after its owned handles close; success is idempotent.
      if (!finishing) finishing = this.ready().then(async () => {
        assert(children.size === 0, 'TASK_CACHE_CHILDREN_ACTIVE');
        const result = await cleanTaskDirectory(ownerRoot); report({event:'closed', owner, ...result}); return result;
      }).catch(error => { finishing = undefined; throw error; });
      return finishing;
    },
  };
}
const RENDER_CACHE_NAMES = Object.freeze(['Cache','Code Cache','DawnGraphiteCache','DawnWebGPUCache','GPUCache','GPUPersistentCache','GrShaderCache','ShaderCache']);
/** Only regenerable Chromium caches in this locked instance's session directory.
 * Local Storage, Network, preferences and recovery are never part of this list. */
async function cleanRenderCaches(root, report = () => {}) {
  await directory(root);
  let files=0,bytes=0;const retained=[];
  for(const name of RENDER_CACHE_NAMES){
    const target=path.join(root,name);
    try{const result=await cleanTaskDirectory(target);files+=result.files;bytes+=result.bytes;}
    catch(error){if(error.code!=='ENOENT'){retained.push(name);report({event:'render-cache-retained',name,message:error.message});}}
  }
  report({event:'render-cache-cleaned',files,bytes,retained});return{files,bytes,retained};
}
module.exports = {cleanTaskDirectory, createTaskCache, cleanRenderCaches, RENDER_CACHE_NAMES};
