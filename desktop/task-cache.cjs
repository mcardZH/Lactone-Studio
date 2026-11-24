'use strict';
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {assert, within} = require('./security.cjs');
const {readRecord,writeRecord} = require('./conformer-recovery-store.cjs');
const token = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
async function directory(target, io = fs) {
  const stat = await io.lstat(target);
  const actual=path.resolve(await io.realpath(target)),expected=path.resolve(target);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && (process.platform==='win32'?actual.toLowerCase()===expected.toLowerCase():actual===expected), 'TASK_CACHE_PATH: unsafe task directory');
  return stat;
}
/** Only for a newly allocated, closed task directory. Enumerate exact members,
 * validate the entire tree first, then recheck each identity before unlinking. */
async function cleanTaskDirectory(root, io = fs, verifiedRecovery) {
  const fs = io;
  const dirs = [], files = [];
  async function collect(dir) {
    const stat = await directory(dir, fs); dirs.push([dir, `${stat.dev}:${stat.ino}`]);
    const names = await fs.readdir(dir);
    assert(verifiedRecovery || !names.includes('.retain-recovery.json'), 'TASK_CACHE_RECOVERY_REQUIRED');
    for (const name of names) {
      const file = path.join(dir, name); assert(within(root, file) && file !== root, 'TASK_CACHE_ESCAPE');
      const value = await fs.lstat(file); assert(!value.isSymbolicLink(), 'TASK_CACHE_LINK_RETAINED');
      if (value.isDirectory()) await collect(file);
      else { assert(value.isFile() && value.nlink === 1, 'TASK_CACHE_MEMBER_RETAINED'); files.push([file, token(value)]); }
    }
  }
  await collect(root);
  if (verifiedRecovery) assert(files.length === verifiedRecovery.size && files.every(([file, identity]) => verifiedRecovery.get(file) === identity), 'TASK_CACHE_RECOVERY_CHANGED');
  let bytes = 0;
  for (const [file, identity] of files) {
    await directory(path.dirname(file), fs); const current = await fs.lstat(file);
    assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && token(current) === identity, 'TASK_CACHE_CHANGED');
    bytes += current.size; await fs.unlink(file);
  }
  for (const [dir, identity] of dirs.reverse()) { const current = await directory(dir, fs); assert(`${current.dev}:${current.ino}` === identity, 'TASK_CACHE_CHANGED'); await fs.rmdir(dir); }
  return {files: files.length, bytes};
}

async function readRecoveryFile(file, identity, target) {
  await directory(path.dirname(file));
  const before = await fs.lstat(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && token(before) === identity, 'TASK_CACHE_RECOVERY_CHANGED');
  const reader = await fs.open(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024), hash = createHash('sha256');
  let size = 0;
  try {
    assert(token(await reader.stat()) === identity, 'TASK_CACHE_RECOVERY_CHANGED');
    for (;;) {
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      if (target) {
        for (let written = 0; written < bytesRead;) {
          const { bytesWritten } = await target.write(buffer, written, bytesRead - written, null);
          assert(bytesWritten > 0, 'TASK_CACHE_RECOVERY_WRITE');
          written += bytesWritten;
        }
      }
      size += bytesRead;
    }
    assert(size === before.size && token(await reader.stat()) === identity && token(await fs.lstat(file)) === identity, 'TASK_CACHE_RECOVERY_CHANGED');
    return { size, sha256: hash.digest('hex') };
  } finally { await reader.close(); }
}

async function optionalInfo(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifyRecovered(file, expected) {
  const info = await optionalInfo(file);
  if (!info) return false;
  const actual = await readRecoveryFile(file, token(info));
  assert(actual.size === expected.size && actual.sha256 === expected.sha256, 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
  return true;
}

async function prepareRecoveryDirectory(base, target) {
  assert(within(base,target), 'TASK_CACHE_RECOVERY_TARGET_CHANGED');
  await directory(base);
  let cursor = base;
  for (const part of path.relative(base,target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor,part);
    try { await fs.mkdir(cursor); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await directory(cursor);
  }
}

async function recoverFile(file, identity, destination) {
  const parent = path.dirname(destination);
  const folder = await directory(parent), folderId = `${folder.dev}:${folder.ino}`;
  if (await optionalInfo(destination)) {
    const expected = await readRecoveryFile(file, identity);
    await verifyRecovered(destination, expected);
    return expected;
  }
  const temporary = path.join(parent, '.task-recovery-' + randomUUID() + '.part');
  const writer = await fs.open(temporary, 'wx');
  let owned;
  try {
    let expected;
    try {
      const info = await writer.stat(); owned = `${info.dev}:${info.ino}`;
      expected = await readRecoveryFile(file, identity, writer);
      await writer.sync();
    } finally { await writer.close(); }
    const current = await directory(parent);
    assert(`${current.dev}:${current.ino}` === folderId, 'TASK_CACHE_RECOVERY_TARGET_CHANGED');
    const written = await fs.lstat(temporary);
    assert(`${written.dev}:${written.ino}` === owned && await verifyRecovered(temporary, expected), 'TASK_CACHE_RECOVERY_WRITE');
    try { await fs.link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Remove our publication helper name before checking the final inode's link count.
    const linked = await fs.lstat(temporary);
    assert(`${linked.dev}:${linked.ino}` === owned && !linked.isSymbolicLink(), 'TASK_CACHE_RECOVERY_TARGET_CHANGED');
    await fs.unlink(temporary); owned = undefined;
    assert(await verifyRecovered(destination, expected), 'TASK_CACHE_RECOVERY_WRITE');
    return expected;
  } finally {
    if (owned) {
      const current = await directory(parent), saved = await optionalInfo(temporary);
      if (saved && `${current.dev}:${current.ino}` === folderId && `${saved.dev}:${saved.ino}` === owned && !saved.isSymbolicLink()) await fs.unlink(temporary);
    }
  }
}

const recoverNames = new Set(['input.xyz','input.coord','xcontrol.inp','md.inp','xtbopt.xyz','xtbopt.log','optimization.json','xtb.trj','mdrestart','molden.input','stdout.log','stderr.log','request.json','run-diagnostics.json','run-result.json','process.json','stdout.txt','stderr.txt','mtd-reference.xyz']);

async function recoverClosedTask(root, recovery, stillInactive) {
  const owned = new Map(), selected = [];
  async function collect(dir, retainParent) {
    await directory(dir);
    const names = await fs.readdir(dir), retained = retainParent || names.includes('.retain-recovery.json');
    for (const name of names) {
      const file = path.join(dir, name), info = await fs.lstat(file);
      assert(within(root, file) && file !== root && !info.isSymbolicLink(), 'TASK_CACHE_RECOVERY_MEMBER');
      if (info.isDirectory()) await collect(file, retained);
      else {
        assert(info.isFile() && info.nlink === 1, 'TASK_CACHE_RECOVERY_MEMBER');
        const identity = token(info);
        owned.set(file, identity);
        if (retained || recoverNames.has(name)) selected.push({ file, identity });
      }
    }
  }
  await collect(root, false);
  const proof = [], base = path.dirname(path.dirname(recovery));
  for (const { file, identity } of selected) {
    const relative = path.relative(root, file), destination = path.join(recovery, relative);
    assert(within(recovery, destination) && destination !== recovery, 'TASK_CACHE_RECOVERY_TARGET_CHANGED');
    await prepareRecoveryDirectory(base,path.dirname(destination));
    proof.push({ path:relative.split(path.sep).join('/'), ...await recoverFile(file, identity, destination) });
  }
  if (proof.length) {
    const indexName = '.task-recovery-index.json', receiptPath = path.join(recovery,indexName);
    assert(!proof.some(item => item.path === indexName), 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
    const previous = await optionalInfo(receiptPath), bound = new Map();
    let indexIdentity;
    if (previous) {
      const { value, identity } = await readRecord(fs,receiptPath);
      indexIdentity = identity;
      assert(value.schema === 1 && value.closedOwner === path.basename(root) && Array.isArray(value.files), 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
      for (const row of value.files) {
        assert(typeof row.path === 'string' && row.path.split('/').every(part=>part && part !== '.' && part !== '..' && !/[:\\]/.test(part))
          && Number.isSafeInteger(row.size) && row.size >= 0 && /^[0-9a-f]{64}$/.test(row.sha256) && !bound.has(row.path), 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
        assert(await verifyRecovered(path.join(recovery,row.path),row), 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
        bound.set(row.path,row);
      }
    }
    for (const item of proof) {
      const existing = bound.get(item.path);
      assert(!existing || existing.size === item.size && existing.sha256 === item.sha256, 'TASK_CACHE_RECOVERY_TARGET_CONFLICT');
      bound.set(item.path,item);
    }
    await writeRecord(fs,recovery,indexName,Buffer.from(JSON.stringify({schema:1,closedOwner:path.basename(root),files:[...bound.values()]})+'\n'),indexIdentity);
  }
  assert(stillInactive(), 'TASK_CACHE_CHILDREN_ACTIVE');
  return cleanTaskDirectory(root, fs, owned);
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
          const recovery = path.join(root, 'recovery', name);
          // The original is reclaimable only after all selected bytes have a
          // verified durable copy. A prior copy is reused only by exact digest.
          const result = await recoverClosedTask(old, recovery, () => !alive(value.pid) && !childIds.some(alive));
          report({event:'recovered', owner:name, recovery, ...result});
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
