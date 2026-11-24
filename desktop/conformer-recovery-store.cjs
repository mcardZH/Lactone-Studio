'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assert, plain } = require('./security.cjs');

const contentHash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const fileIdentity = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');
const ordinaryFile = info => info.isFile() && !info.isSymbolicLink() && Number(info.nlink) === 1;

async function checkedDirectory(io, directory) {
  const info = await io.lstat(directory, { bigint: true });
  assert(info.isDirectory() && !info.isSymbolicLink() && samePath(await io.realpath(directory), path.resolve(directory)), 'Unsafe conformer recovery directory');
  return `${info.dev}:${info.ino}`;
}

async function readRecord(io, file) {
  const before = await io.lstat(file, { bigint: true });
  assert(ordinaryFile(before), 'Unsafe conformer recovery record');
  const identity = fileIdentity(before);
  const handle = await io.open(file, 'r');
  try {
    assert(fileIdentity(await handle.stat({ bigint: true })) === identity, 'Conformer recovery record changed');
    const bytes = await handle.readFile();
    const after = await io.lstat(file, { bigint: true });
    assert(ordinaryFile(after) && fileIdentity(after) === identity && fileIdentity(await handle.stat({ bigint: true })) === identity && BigInt(bytes.length) === before.size,
      'Conformer recovery record changed');
    return { value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length, sha256: contentHash(bytes), identity };
  } finally { await handle.close(); }
}

async function writeRecord(io, directory, name, bytes, replaceIdentity) {
  const before = await checkedDirectory(io, directory);
  const target = path.join(directory, name);
  const temporary = path.join(directory, `${name}.next-${randomUUID()}`);
  const handle = await io.open(temporary, 'wx');
  let owned;
  try {
    try { const info = await handle.stat({ bigint: true }); owned = `${info.dev}:${info.ino}`; await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    assert(await checkedDirectory(io, directory) === before, 'Conformer recovery directory changed');
    if (replaceIdentity !== undefined) {
      const previous = await io.lstat(target, { bigint: true });
      assert(ordinaryFile(previous) && fileIdentity(previous) === replaceIdentity, 'Conformer recovery record changed before publication');
      await io.rename(temporary, target);
      owned = undefined;
    } else {
      await io.link(temporary, target);
    }
  } finally {
    if (owned) {
      const info = await io.lstat(temporary, { bigint: true });
      assert(`${info.dev}:${info.ino}` === owned && !info.isSymbolicLink(), 'Conformer staging file changed');
      await io.unlink(temporary);
    }
  }
  const published = await io.lstat(target, { bigint: true });
  assert(ordinaryFile(published) && await checkedDirectory(io,directory) === before, 'Conformer recovery publication changed');
  return fileIdentity(published);
}

async function recoveryIds(io, root, pattern) {
  let names;
  try { await checkedDirectory(io, root); names = await io.readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => pattern.test(name)).sort();
}

function captureScope(scope) {
  if (scope === undefined) return undefined;
  const fields = ['projectId', 'documentId', 'documentEpoch', 'collectionId', 'collectionRevision'];
  assert(plain(scope) && Object.keys(scope).every(key => fields.includes(key)
    && (key === 'collectionRevision' ? Number.isSafeInteger(scope[key]) && scope[key] >= 0
      : typeof scope[key] === 'string' && scope[key].length > 0 && scope[key].length <= 4096)), 'Invalid trusted conformer recovery scope');
  return { ...scope };
}

/** Recovery never grants execution authority over the original producer. */
function createRecoveryAccess({ listIds, available, summarize, load, read, describeOpen, discard }) {
  const leases = new Map(), busy = new Set(), closedOwners = new Set();
  let closed = false;
  function own(owner, token) {
    const entry = leases.get(token);
    assert(!closed && entry && entry.owner === owner && !entry.closing && !closedOwners.has(owner), 'Invalid conformer recovery lease');
    return entry;
  }
  async function listRecovery() {
    const recoveries = [], issues = [];
    for (const id of await listIds()) {
      if (!available(id) || busy.has(id)) continue;
      busy.add(id);
      try {
        const descriptor = await summarize(id);
        if (descriptor.recoverableCount) recoveries.push(descriptor);
        else if (descriptor.issues?.length) issues.push({ id, message: descriptor.issues[0].message });
      }
      catch (error) { issues.push({ id, message: String(error.message).slice(0, 2048) }); }
      finally { busy.delete(id); }
    }
    return { recoveries, issues };
  }
  async function openRecovery(owner, id) {
    assert(!closed && Number.isSafeInteger(owner) && owner >= 0 && !closedOwners.has(owner) && available(id) && !busy.has(id), 'Conformer recovery is not available');
    busy.add(id);
    try {
      const value = await load(id);
      assert(!closed && !closedOwners.has(owner) && available(id) && value.descriptor.recoverableCount > 0, 'No verified conformer recovery results');
      const token = randomUUID();
      leases.set(token, { owner, id, value, reads: new Set() });
      return { ...value.descriptor, token, ...describeOpen(value) };
    } finally { busy.delete(id); }
  }
  async function readRecovery(owner, token, offset, limit, options = {}) {
    const entry = own(owner, token), total = entry.value.descriptor.recoverableCount;
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= total && Number.isSafeInteger(limit) && limit > 0 && limit <= 64, 'Invalid conformer recovery page');
    assert(plain(options) && Object.keys(options).every(key => key === 'summaryOnly')
      && (options.summaryOnly === undefined || typeof options.summaryOnly === 'boolean'), 'Invalid conformer recovery read options');
    const promise = Promise.resolve().then(async () => {
      const pageLimit = Math.min(limit, total - offset);
      const records = await read(entry.value, offset, pageLimit, options.summaryOnly === true);
      assert(Array.isArray(records) && records.length <= pageLimit && (offset === total || records.length > 0), 'Incomplete conformer recovery page');
      return { records, offset, total, done: offset + records.length === total };
    });
    entry.reads.add(promise);
    void promise.then(() => entry.reads.delete(promise), () => entry.reads.delete(promise));
    return promise;
  }
  function closeEntry(token, entry) {
    return entry.closeTask ??= (async () => {
      entry.closing = true;
      await Promise.allSettled([...entry.reads]);
      leases.delete(token);
      return { closed: true };
    })();
  }
  async function closeRecovery(owner, token) {
    const entry = leases.get(token);
    if (!entry) return { closed: true };
    assert(entry.owner === owner, 'Invalid conformer recovery lease');
    return closeEntry(token, entry);
  }
  async function closeRecoveryOwner(owner) {
    if (owner === undefined) closed = true;
    else closedOwners.add(owner);
    await Promise.all([...leases].filter(([, entry]) => owner === undefined || entry.owner === owner).map(([token, entry]) => closeEntry(token, entry)));
  }
  async function discardRecovery(owner, token) {
    const entry = own(owner, token);
    assert(available(entry.id) && !busy.has(entry.id) && ![...leases.values()].some(other => other !== entry && other.id === entry.id), 'A conformer recovery result still has another consumer');
    entry.closing = true;
    busy.add(entry.id);
    try {
      await Promise.allSettled([...entry.reads]);
      await discard(entry.value);
      leases.delete(token);
      return { discarded: true };
    } finally { entry.closing = false; busy.delete(entry.id); }
  }
  return { listRecovery, openRecovery, readRecovery, closeRecovery, closeRecoveryOwner, discardRecovery };
}

module.exports = { captureScope, checkedDirectory, contentHash, createRecoveryAccess, fileIdentity, ordinaryFile, readRecord, recoveryIds, writeRecord };
