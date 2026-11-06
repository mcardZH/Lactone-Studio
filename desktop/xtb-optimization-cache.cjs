'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assert, within } = require('./security.cjs');
const { cleanTaskDirectory } = require('./task-cache.cjs');
const { assertEngineIdentity, digest } = require('./xtb-runtime-contract.cjs');
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
/** Only host-created, actually closed xTB directories can enter this registry.
 * Releases accept session identities, never renderer-controlled paths. */
function createXtbOptimizationCache({ fs, root }) {
  const records = new Map();
  let releaseQueue = Promise.resolve();
  async function inventory(directory) {
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await fs.realpath(directory)).toLowerCase() === path.resolve(directory).toLowerCase(), 'Unsafe optimization cache root');
    const files = [];
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), entry = await fs.lstat(file);
      assert(within(root, file) && entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, 'Optimization cache contains unsafe members');
      files.push({ name, identity: identity(entry), bytes: entry.size });
    }
    return { directoryIdentity: `${stat.dev}:${stat.ino}`, files };
  }
  return {
    async retain(owner, sessionId, directory, request, byteLimit, runtimeIdentity) {
      assertEngineIdentity(runtimeIdentity);
      assert(path.dirname(path.resolve(directory)) === path.resolve(root), 'Optimization cache escaped owned root');
      assert(!records.has(`${owner}:${sessionId}`), 'Duplicate optimization cache');
      const handle = await fs.open(path.join(directory, 'xtbopt.log'), 'r');
      let raw; try { raw = await handle.readFile(); } finally { await handle.close(); }
      assert(raw.length > 0, 'Complete original optimization trajectory is missing');
      const provenance = { schema: 'sciyue-xtb-optimization-cache/v1', sessionId, runIdentity: request.runIdentity,
        engineIdentity: structuredClone(runtimeIdentity), requestIdentity: digest(request), cacheIdentity: digest({ engineIdentity: runtimeIdentity.sha256, request }),
        sourceField: 'xtbopt.log', trajectoryBytes: raw.length, trajectorySha256: createHash('sha256').update(raw).digest('hex') };
      const requestFile=path.join(directory,'request.json'),requestBytes=Buffer.from(JSON.stringify(request)+'\n');
      try { await fs.writeFile(requestFile,requestBytes,{flag:'wx'}); }
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const selected=await fs.lstat(requestFile);assert(selected.isFile()&&!selected.isSymbolicLink()&&selected.nlink===1,'Unsafe existing optimization request');
        const input=await fs.open(requestFile,'r');
        try {const opened=await input.stat();assert(identity(opened)===identity(selected),'Optimization request changed before read');const saved=await input.readFile();assert(saved.equals(requestBytes)&&identity(await input.stat())===identity(opened)&&identity(await fs.lstat(requestFile))===identity(opened),'Existing optimization request differs from this run');}
        finally {await input.close();}
      }
      await fs.writeFile(path.join(directory, 'provenance.json'), JSON.stringify(provenance) + '\n', { encoding: 'utf8', flag: 'wx' });
      const snapshot = await inventory(directory), bytes = snapshot.files.reduce((sum, row) => sum + row.bytes, 0);
      const retained = [...records.values()].filter(record => record.owner === owner && record.taskId === request.runIdentity.taskId).reduce((sum, record) => sum + record.bytes, 0);
      assert(bytes + retained <= byteLimit, 'XTB_OUTPUT_LIMIT: 累计优化原始缓存达到本次输出预算');
      records.set(`${owner}:${sessionId}`, { owner, sessionId, taskId: request.runIdentity.taskId, directory, snapshot, bytes });
      return { diagnosticDirectory: directory, optimizationCache: provenance };
    },
    release(owner, sessionIds) {
      assert(Array.isArray(sessionIds) && new Set(sessionIds).size === sessionIds.length
        && sessionIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)), 'Invalid owned optimization cache identities');
      const pending = releaseQueue.then(async () => {
      const released = [];
      for (const id of sessionIds) {
        const key = `${owner}:${id}`, record = records.get(key); if (!record) { released.push(id); continue; }
        assert(JSON.stringify(await inventory(record.directory)) === JSON.stringify(record.snapshot), 'Optimization cache changed; retained for recovery');
        await cleanTaskDirectory(record.directory, fs); records.delete(key); released.push(id);
      }
      return { released };
      }); releaseQueue = pending.catch(() => {}); return pending;
    },
    ids: owner => [...records.values()].filter(record => owner === undefined || record.owner === owner).map(record => ({ owner: record.owner, sessionId: record.sessionId })),
  };
}
module.exports = { createXtbOptimizationCache };
