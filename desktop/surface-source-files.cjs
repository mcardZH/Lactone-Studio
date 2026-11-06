'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {inspectManagedSource}=require('./analysis-result-wire.cjs');
const { assert, plain, string } = require('./security.cjs');
const { hash, directoryIdentity, checkDirectory, readChecked, sameFile, currentFile, atomicWrite } = require('./portable-storage.cjs');
const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
/** Main-owned immutable source snapshots. Tokens never grant arbitrary path access. */
function createSurfaceSourceFiles({ root, domainRoot = path.join(path.dirname(root), 'surface-domain-records'), snapshotSource }) {
  assert(path.isAbsolute(root));
  const records = new Map(), sessions = new Map(), closedOwners = new Set(), pending = new Map(), reservedSlots = new Map(); let rootIdentity, disposed = false, domainEpoch = 0;
  const sessionKey = (owner, id) => `${owner}:${id}`;
  const active = owner => assert(!disposed && !closedOwners.has(owner) && Number.isSafeInteger(owner) && owner >= 0, 'Surface source owner closed');
  function domain(value, revision) {
    assert(plain(value) && value.sourceRevision === revision && plain(value.validDomain), 'Surface domain content identity differs');
    const result = structuredClone(value), valid = result.validDomain;
    assert(['node-mask', 'unknown', 'full-grid'].includes(valid.kind), 'Invalid surface domain');
    if (valid.kind === 'node-mask') {
      if (valid.mask?.encoding === 'base64') { valid.maskBase64 = valid.mask.data; delete valid.mask; }
      if (typeof valid.maskBase64 === 'string') { assert(/^[A-Za-z0-9+/]*={0,2}$/.test(valid.maskBase64), 'Invalid domain mask encoding'); valid.mask = new Uint8Array(Buffer.from(valid.maskBase64, 'base64')); delete valid.maskBase64; }
      else if (Array.isArray(valid.mask) || plain(valid.mask)) { const values = Object.values(valid.mask); assert(values.every(v => v === 0 || v === 1), 'Invalid surface domain mask'); valid.mask = Uint8Array.from(values); }
      assert(valid.mask instanceof Uint8Array && valid.mask.length > 0 && valid.mask.length <= MAX_SOURCE_BYTES && valid.mask.every(v => v === 0 || v === 1) && string(valid.evidence, 4096), 'Invalid surface domain mask');
    }
    return result;
  }
  const encodeDomain = value => JSON.stringify(value, (_key, value) => value instanceof Uint8Array ? { encoding: 'base64', data: Buffer.from(value).toString('base64') } : value);
  async function knownDomain(revision) {
    const file = path.join(domainRoot, revision + '.json');
    let saved; try { saved = await readChecked(file, MAX_SOURCE_BYTES); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    const value = JSON.parse(saved.bytes.toString('utf8'));
    if (value.validDomain?.mask?.encoding === 'base64') { value.validDomain.maskBase64 = value.validDomain.mask.data; delete value.validDomain.mask; }
    return domain(value, revision);
  }
  async function rememberDomain(text, domainText) {
    const revision = hash(Buffer.from(text, 'utf8')), value = domain(typeof domainText === 'string' ? JSON.parse(domainText) : domainText, revision);
    await fs.mkdir(domainRoot, { recursive: true }); const parent = await directoryIdentity(domainRoot), file = path.join(domainRoot, revision + '.json');
    const old = await knownDomain(revision);
    // A previously restricted content revision is never promoted by a later slot.
    if (old && old.validDomain.kind !== 'full-grid') return old;
    await atomicWrite(file, Buffer.from(encodeDomain(value), 'utf8'), await currentFile(file, fs, MAX_SOURCE_BYTES), parent, fs, MAX_SOURCE_BYTES);
    domainEpoch++;
    for (const record of records.values()) if (record.sha256 === revision) record.knownDomain = value;
    return value;
  }
  function context(value) { assert(plain(value) && string(value.sourceId, 256) && string(value.sourceRevision, 256) && Number.isSafeInteger(value.generation) && value.generation >= 0 && (value.jobIndex === null || Number.isSafeInteger(value.jobIndex) && value.jobIndex >= 0) && (value.sourceFrameIndex === null || Number.isSafeInteger(value.sourceFrameIndex) && value.sourceFrameIndex >= 0), 'Invalid surface source context'); return structuredClone(value); }
  async function verifyRecord(record){if(!record.streamed)return sameFile(record.path,record,fs,MAX_SOURCE_BYTES);const current=await inspectManagedSource(record.path);assert(current.identity===record.identity&&current.sha256===record.sha256,'Managed surface source changed');return current;}
  function remove(record) { return record.removal ??= (async () => { await checkDirectory(root, rootIdentity); await verifyRecord(record); const stat = await fs.lstat(record.path); assert(stat.nlink === 1, 'Shared surface snapshot retained'); await fs.unlink(record.path); records.delete(record.token); })(); }
  async function register(owner, value, originalPath = null, kind = 'cube') {
    active(owner); assert(plain(value) && Object.keys(value).every(key => ['name', 'text'].includes(key)) && string(value.name, 256) && !/[\\/]/.test(value.name) && string(value.text, MAX_SOURCE_BYTES) && Buffer.byteLength(value.text) <= MAX_SOURCE_BYTES, 'Invalid bounded surface source');
    reservedSlots.set(owner, (reservedSlots.get(owner) ?? 0) + 1);
    let task;
    task = (async () => {
      await fs.mkdir(root, { recursive: true }); const initial = await directoryIdentity(root); rootIdentity ??= initial; await checkDirectory(root, rootIdentity); active(owner);
      const token = randomUUID(), extension = kind === 'cube' ? '.cube' : /^\s*\[Molden Format\]/i.test(value.text.slice(0, 256)) ? '.molden' : '.fchk', location = path.join(root, token + extension); let created = false, owned;
      try {
        const handle = await fs.open(location, 'wx'); created = true; try { owned = await handle.stat(); await handle.writeFile(value.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        const checked = await readChecked(location, MAX_SOURCE_BYTES), stat = await fs.lstat(location); assert(stat.dev === owned.dev && stat.ino === owned.ino && stat.nlink === 1, 'Surface snapshot replaced'); active(owner);
        const { bytes, ...reference } = checked;
        const startingDomainEpoch = domainEpoch, known = kind === 'cube' ? await knownDomain(checked.sha256) : undefined; active(owner);
        const record = { ...reference, bytesLength: bytes.length, token, owner, kind, name: value.name, originalPath, knownDomain: known, refs: new Set() }; records.set(token, record); created = false;
        try { if (kind === 'cube' && startingDomainEpoch !== domainEpoch) { const refreshed = await knownDomain(checked.sha256); if (refreshed) record.knownDomain = refreshed; } active(owner); }
        catch (error) { await remove(record); throw error; }
        return { token, name: value.name, text: value.text, bytes: checked.bytes.length, sourceRevision: checked.sha256, ...(record.knownDomain ? { knownDomain: record.knownDomain } : {}) };
      } finally { if (created && owned) { await checkDirectory(root, rootIdentity); const current = await fs.lstat(location); if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && current.nlink === 1) await fs.unlink(location); } }
    })();
    pending.set(task, owner); try { return await task; } finally { pending.delete(task); const count = reservedSlots.get(owner) - 1; if (count) reservedSlots.set(owner, count); else reservedSlots.delete(owner); }
  }
  function cube(owner, ref) {
    assert(plain(ref) && Object.keys(ref).every(key => ['token', 'fieldMetadata'].includes(key)) && string(ref.token, 100) && plain(ref.fieldMetadata) && !Object.hasOwn(ref.fieldMetadata, 'values'), 'Invalid surface Cube source reference');
    const record = records.get(ref.token); assert(record && record.owner === owner && record.kind === 'cube' && record.sha256 === ref.fieldMetadata.source?.revision, 'Surface Cube token/source identity differs');
    const metadata = structuredClone(ref.fieldMetadata); if (record.knownDomain) metadata.validDomain = structuredClone(record.knownDomain.validDomain);
    return { record, trusted: { path: record.path, fieldMetadata: metadata } };
  }
  async function openOwned(owner, request) {
    active(owner); assert(plain(request) && string(request.sessionId, 100) && /^[A-Za-z0-9_-]+$/.test(request.sessionId) && plain(request.source), 'Invalid surface session source');
    const key = sessionKey(owner, request.sessionId); assert(!sessions.has(key), 'Surface session source already registered');
    const source = request.source, sourceContext = context(source.context); let trusted, used, temporaryToken;
    try {
    if (source.kind === 'wavefunction') {
      assert(Object.keys(source).every(key => ['kind', 'text', 'sourceToken', 'name', 'sourceId', 'sourceRevision', 'context'].includes(key)) && string(source.sourceId, 256), 'Invalid wavefunction source');
      let imported;
      if(source.sourceToken!==undefined){
        assert(source.text===undefined&&string(source.sourceToken,256)&&string(source.name,256)&&typeof snapshotSource==='function','Managed wavefunction source required');
        await fs.mkdir(root,{recursive:true});rootIdentity??=await directoryIdentity(root);await checkDirectory(root,rootIdentity);
        const saved=await snapshotSource(owner,source.sourceToken,{directory:root,name:source.name,...(source.sourceRevision?{revision:source.sourceRevision}:{})});
        assert(path.dirname(saved.path)===root,'Wavefunction snapshot is outside its owned root');
        const checked=await inspectManagedSource(saved.path);const token=randomUUID();
        records.set(token,{...checked,streamed:true,token,owner,kind:'wavefunction',name:source.name,refs:new Set()});
        imported={token,sourceRevision:checked.sha256};
      }else imported = await register(owner, { name: source.name, text: source.text }, null, 'wavefunction');
      temporaryToken = imported.token;
      assert(source.sourceRevision === undefined || imported.sourceRevision === source.sourceRevision, 'Wavefunction revision differs from source bytes');
      const record = records.get(imported.token); used = [record]; trusted = { sessionId: request.sessionId, kind: 'wavefunction', sourcePath: record.path, sourceRevision: record.sha256, sourceId: source.sourceId, context: sourceContext };
    } else {
      assert(source.kind === 'cubes' && Object.keys(source).every(key => ['kind', 'shape', 'mapping', 'context'].includes(key)), 'Unknown surface source kind');
      const shape = cube(owner, source.shape), mapping = source.mapping === null ? null : cube(owner, source.mapping); used = [shape.record, ...(mapping ? [mapping.record] : [])];
      trusted = { sessionId: request.sessionId, kind: 'cube-pair', shape: shape.trusted, mapping: mapping?.trusted ?? null, context: sourceContext };
    }
    active(owner);
    for (const record of used) { await verifyRecord(record); active(owner); record.refs.add(key); }
    sessions.set(key, { owner, sessionId: request.sessionId, records: used, temporaryToken }); return trusted;
    } catch (error) { for (const record of used ?? []) record.refs.delete(key); const record = records.get(temporaryToken); if (record && !record.refs.size) await remove(record); throw error; }
  }
  async function open(owner,request){const task=openOwned(owner,request);pending.set(task,owner);try{return await task;}finally{pending.delete(task);}}
  async function closeSession(owner, id) { const key = sessionKey(owner, id), session = sessions.get(key); if (!session) return; sessions.delete(key); for (const record of session.records) { record.refs.delete(key); if (record.token === session.temporaryToken && !record.refs.size) await remove(record); } }
  async function release(owner, token) { active(owner); const record = records.get(token); assert(record && record.owner === owner && record.kind === 'cube', 'Surface source token is not owned'); assert(record.refs.size === 0, 'Surface source is in use'); await remove(record); return { released: true }; }
  async function read(owner, token) { active(owner); const record = records.get(token); assert(record && record.owner === owner && record.kind === 'cube', 'Surface source token is not owned'); const checked = await sameFile(record.path, record, fs, MAX_SOURCE_BYTES); const known = await knownDomain(record.sha256); active(owner); return { token, name: record.name, text: checked.bytes.toString('utf8'), bytes: checked.bytes.length, sourceRevision: record.sha256, ...(known ? { knownDomain: known } : {}) }; }
  async function closeOwner(owner) { closedOwners.add(owner); await Promise.allSettled([...pending].filter(([, pendingOwner]) => pendingOwner === owner).map(([task]) => task)); for (const record of [...records.values()]) if (record.owner === owner) await remove(record); for (const [key, session] of sessions) if (session.owner === owner) sessions.delete(key); }
  async function dispose() { disposed = true; await Promise.allSettled([...pending.keys()]); for (const record of [...records.values()]) await remove(record); sessions.clear(); }
  async function exportRegistered(owner, ref) { active(owner); const { record, trusted } = cube(owner, ref); const checked = await sameFile(record.path, record, fs, MAX_SOURCE_BYTES); active(owner); const known = record.knownDomain; assert(known || trusted.fieldMetadata.validDomain?.kind === 'full-grid', 'Restricted Cube requires content-bound domain evidence'); return { name: record.name, text: checked.bytes.toString('utf8'), ...(known ? { domain: { name: record.name + '.sciyue-domain.json', text: encodeDomain(known) } } : {}) }; }
  function assertExport(_owner, file) { const target = path.resolve(file).toLowerCase(); for (const record of records.values()) assert(![record.path, ...(record.originalPath ? [record.originalPath, record.originalPath + '.sciyue-domain.json'] : [])].some(source => target === path.resolve(source).toLowerCase()), 'Cannot overwrite a surface source'); }
  return { register, read, open, release, closeSession, closeOwner, dispose, assertExport, exportRegistered, rememberDomain, activeCount: () => pending.size, MAX_SOURCE_BYTES };
}
module.exports = { createSurfaceSourceFiles, MAX_SOURCE_BYTES };
