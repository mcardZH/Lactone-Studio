'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert, plain, string, boundedJSON } = require('./security.cjs');
const { hash, directoryIdentity, checkDirectory, readChecked, sameFile } = require('./portable-storage.cjs');
const { sessionIdentity } = require('./xtb-security.cjs');
// Compatibility export: file-size identity is checked against each actual member.
const MAX_BUNDLE_BYTES = Number.MAX_SAFE_INTEGER;
const FILES = Object.freeze({ molden: 'molden.input', stdout: 'stdout.log', stderr: 'stderr.log', wbo: 'wbo' });

/** Host-only immutable snapshots. Public references never expose native paths.
 * Acknowledging retain means every byte was independently saved and verified. */
function createXtbElectronicArtifacts({ root }) {
  assert(path.isAbsolute(root), 'Absolute managed xTB source root required');
  const records = new Map(), bindings = new Map(), pending = new Map(), reservations = new Map(), closedOwners = new Set();
  let rootIdentity, disposed = false;
  const active = owner => assert(!disposed && !closedOwners.has(owner) && Number.isSafeInteger(owner) && owner >= 0, 'xTB artifact owner closed');
  const receipt = record => ({ artifactId: record.artifactId, files: record.files.map(({ role, name, bytes, sha256 }) => ({ role, name, bytes, sha256 })) });
  async function remove(record) {
    if (record.removal) return record.removal;
    record.removal = (async () => {
      await checkDirectory(root, rootIdentity);
      await checkDirectory(record.directory, record.directoryIdentity);
      // Preflight the complete exact inventory before unlinking any member.
      const names = await fs.readdir(record.directory);
      assert(names.length === record.files.length && names.every(name => record.files.some(file => file.name === name)), 'Unexpected xTB artifact member retained');
      for (const file of record.files) {
        await sameFile(file.path, file.identity, fs, file.bytes);
        assert((await fs.lstat(file.path)).nlink === 1, 'Shared xTB artifact retained');
      }
      for (const file of record.files) await fs.unlink(file.path);
      await fs.rmdir(record.directory); records.delete(record.artifactId); bindings.delete(record.bindingKey);
    })();
    return record.removal;
  }
  async function retain(owner, value) {
    active(owner);
    assert(plain(value) && Object.keys(value).every(key => ['sessionId', 'stamp', 'runIdentity', 'metadata', 'files'].includes(key)) && string(value.sessionId, 100) && /^[A-Za-z0-9_-]+$/.test(value.sessionId) && plain(value.stamp) && plain(value.metadata), 'Invalid xTB artifact provenance');
    if (value.runIdentity !== undefined) { assert(plain(value.runIdentity) && Object.keys(value.runIdentity).length === 2 && Object.keys(value.runIdentity).every(key => ['taskId', 'runId'].includes(key)), 'Invalid xTB artifact task/run identity'); sessionIdentity(value.runIdentity.taskId); sessionIdentity(value.runIdentity.runId); }
    boundedJSON({ sessionId: value.sessionId, stamp: value.stamp, runIdentity: value.runIdentity, metadata: value.metadata });
    assert(Array.isArray(value.files) && value.files.length >= 2 && value.files.length <= 4, 'Invalid xTB artifact inventory');
    const roles = new Set();
    const files = value.files.map(file => {
      assert(plain(file) && Object.keys(file).every(key => ['role', 'name', 'text', 'sha256', 'bytes'].includes(key)) && Object.hasOwn(FILES, file.role) && file.name === FILES[file.role] && typeof file.text === 'string' && !roles.has(file.role), 'Invalid xTB artifact member');
      roles.add(file.role); const bytes = Buffer.from(file.text, 'utf8');
      assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes === bytes.length && file.sha256 === hash(bytes), 'xTB artifact bytes differ from their provenance');
      return { role: file.role, name: file.name, content: bytes, sha256: file.sha256, bytes: bytes.length };
    });
    assert(roles.has('molden') && roles.has('stdout'), 'Molden and native output are required');
    const bindingKey = owner + ':' + value.sessionId;
    const signature = hash(Buffer.from(JSON.stringify({ stamp: value.stamp, runIdentity: value.runIdentity, metadata: value.metadata, files: files.map(({ role, name, bytes, sha256 }) => ({ role, name, bytes, sha256 })) }), 'utf8'));
    const previous = bindings.get(bindingKey);
    if (previous) { assert(previous.signature === signature, 'xTB session artifact identity cannot be rebound'); return previous.task; }
    reservations.set(owner, (reservations.get(owner) ?? 0) + 1);
    // Snapshot caller-owned provenance before the first await.
    const provenance = structuredClone({ sessionId: value.sessionId, stamp: value.stamp, ...(value.runIdentity ? { runIdentity: value.runIdentity } : {}), metadata: value.metadata });
    const task = (async () => {
      await fs.mkdir(root, { recursive: true }); const initial = await directoryIdentity(root); rootIdentity ??= initial; await checkDirectory(root, rootIdentity); active(owner);
      const directory = await fs.mkdtemp(path.join(root, 'artifact-'));
      const record = { ...provenance, owner, bindingKey, artifactId: randomUUID(), directory, directoryIdentity: await directoryIdentity(directory), files: [], reads: new Set() };
      try {
        for (const file of files) {
          await checkDirectory(root, rootIdentity); await checkDirectory(directory, record.directoryIdentity); active(owner);
          const location = path.join(directory, file.name), handle = await fs.open(location, 'wx'); let owned;
          try { owned = await handle.stat(); await handle.writeFile(file.content); await handle.sync(); }
          finally { await handle.close(); }
          const saved = await readChecked(location, file.bytes), stat = await fs.lstat(location);
          assert(stat.dev === owned.dev && stat.ino === owned.ino && stat.nlink === 1 && saved.sha256 === file.sha256, 'Managed xTB artifact changed during retention');
          record.files.push({ role: file.role, name: file.name, path: location, sha256: file.sha256, bytes: file.bytes, identity: { identity: saved.identity, sha256: saved.sha256 } });
        }
        active(owner); records.set(record.artifactId, record); return receipt(record);
      } catch (error) {
        // Failed/partial snapshots remain diagnostic evidence. The original job
        // remains owned by the calling host and must never be cleaned on failure.
        error.artifactDiagnosticDirectory = directory; throw error;
      }
    })();
    bindings.set(bindingKey, { signature, task });
    pending.set(task, owner);
    try { return await task; }
    catch (error) { if (bindings.get(bindingKey)?.task === task) bindings.delete(bindingKey); throw error; }
    finally { pending.delete(task); const count = reservations.get(owner) - 1; if (count) reservations.set(owner, count); else reservations.delete(owner); }
  }
  function owned(owner, artifactId) {
    active(owner); assert(string(artifactId, 100), 'Invalid xTB artifact identity');
    const record = records.get(artifactId); assert(record && record.owner === owner && !record.closing, 'xTB artifact is not owned or available'); return record;
  }
  async function read(owner, artifactId) {
    const record = owned(owner, artifactId);
    const task = (async () => {
      await checkDirectory(root, rootIdentity); await checkDirectory(record.directory, record.directoryIdentity);
      const files = [];
      for (const file of record.files) { const checked = await sameFile(file.path, file.identity, fs, file.bytes); assert((await fs.lstat(file.path)).nlink === 1, 'Shared xTB artifact rejected'); files.push({ role: file.role, name: file.name, bytes: file.bytes, sha256: file.sha256, text: checked.bytes.toString('utf8') }); }
      active(owner); return { ...structuredClone({ artifactId, sessionId: record.sessionId, stamp: record.stamp, ...(record.runIdentity ? { runIdentity: record.runIdentity } : {}), metadata: record.metadata }), files };
    })();
    record.reads.add(task); try { return await task; } finally { record.reads.delete(task); }
  }
  async function release(owner, artifactId) {
    active(owner); assert(string(artifactId, 100), 'Invalid xTB artifact identity'); const record = records.get(artifactId);
    if (!record) return { released: false };
    assert(record.owner === owner, 'xTB artifact is not owned'); record.closing = true;
    await Promise.allSettled([...record.reads]); await remove(record); return { released: true };
  }
  async function closeOwner(owner) {
    closedOwners.add(owner); await Promise.allSettled([...pending].filter(([, pendingOwner]) => pendingOwner === owner).map(([task]) => task));
    const ownedRecords = [...records.values()].filter(record => record.owner === owner); for (const record of ownedRecords) record.closing = true;
    await Promise.allSettled(ownedRecords.flatMap(record => [...record.reads])); for (const record of ownedRecords) await remove(record);
  }
  async function dispose() {
    disposed = true; await Promise.allSettled([...pending.keys()]); const all = [...records.values()]; for (const record of all) record.closing = true;
    await Promise.allSettled(all.flatMap(record => [...record.reads])); for (const record of all) await remove(record);
  }
  return { retain, read, release, closeOwner, dispose, activeCount: () => records.size, MAX_BUNDLE_BYTES };
}
module.exports = { createXtbElectronicArtifacts, MAX_BUNDLE_BYTES };
