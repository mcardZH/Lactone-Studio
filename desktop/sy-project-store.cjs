'use strict';
// The renderer supplies frozen metadata and byte chunks. Only the trusted main
// process chooses a project path or imports an already identified source file.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const safe = require('./portable-storage.cjs');
const SCHEMA = 'sciyue-project/v1';
const CATEGORIES = new Set(['models', 'sources', 'trajectories', 'results']);
// JSON/Buffer runtime limits are reported as real resource/format failures;
// project metadata has no separate business byte cap.
const MAX_INDEX = Number.MAX_SAFE_INTEGER;
const DEFAULT_CHUNK = 4 * 1024 * 1024;
const ASSET_BATCH_ITEMS = 32, ASSET_BATCH_BYTES = 1024 * 1024;
const fail = (code, message) => { throw safe.failure(code, message); };
const clone = value => JSON.parse(JSON.stringify(value));
const exists = async file => { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function validateManifest(value) {
  if (!value || value.schema !== SCHEMA || ![1, 2, 3, 4, 5, 6].includes(value.formatVersion)) fail('SY_SCHEMA_UNSUPPORTED', 'Unsupported Ester Studio project version; write-back is disabled.');
  if (typeof value.projectId !== 'string' || !value.projectId || !Number.isSafeInteger(value.generation) || value.generation < 1 || !value.assets || typeof value.assets !== 'object' || !Array.isArray(value.assetIds) || !Object.hasOwn(value, 'state')) fail('SY_INVALID_INDEX', 'Invalid Ester Studio project index.');
  for (const [id, asset] of Object.entries(value.assets)) {
    if (!asset || id !== asset.assetId || !/^[a-f0-9]{64}$/.test(id) || asset.sha256 !== id || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !CATEGORIES.has(asset.category) || asset.relativePath !== `${asset.category}/asset-${id}.bin`) fail('SY_INVALID_INDEX', 'Invalid project asset reference.');
  }
  for (const id of value.assetIds) if (typeof id !== 'string' || !value.assets[id]) fail('SY_INVALID_INDEX', 'Unknown project asset reference.');
  return value;
}
async function readManifest(file) {
  const current = await safe.currentFile(file, fs, MAX_INDEX);
  return current ? { current, manifest: validateManifest(JSON.parse(current.bytes.toString('utf8'))) } : null;
}
async function digestFile(file, expected) {
  const parent = await safe.directoryIdentity(path.dirname(file));
  const selected = await fs.lstat(file);
  if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink > 1) fail('SY_ASSET_CHANGED', 'Project/source file is not an independent regular file.');
  if (expected && safe.identity(selected) !== expected) fail('SY_SOURCE_CHANGED', 'Source identity changed; retain the original bytes or explicitly reload it.');
  const handle = await fs.open(file, 'r');
  try {
    if (safe.identity(await handle.stat()) !== safe.identity(selected)) fail('SY_ASSET_CHANGED', 'Asset changed before reading.');
    const hash = createHash('sha256');
    const bytes = Buffer.allocUnsafe(DEFAULT_CHUNK); let offset = 0;
    for (;;) { const read = await handle.read(bytes, 0, bytes.length, offset); if (!read.bytesRead) break; hash.update(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead; }
    if (safe.identity(await handle.stat()) !== safe.identity(selected) || safe.identity(await fs.lstat(file)) !== safe.identity(selected)) fail('SY_SOURCE_CHANGED', 'Source changed during reading.');
    await safe.checkDirectory(path.dirname(file), parent);
    return { sha256: hash.digest('hex'), bytes: offset, identity: safe.identity(selected) };
  } finally { await handle.close(); }
}
function createSyProjectStore({ appVersion = 'unknown', maxChunkBytes = DEFAULT_CHUNK } = {}) {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 16 * 1024 * 1024) fail('SY_INVALID_REQUEST', 'Invalid chunk budget.');
  const sessions = new Map();
  const sessionFor = id => { const s = sessions.get(id); if (!s || s.closed) fail('SY_SESSION_CLOSED', 'Project session is closed.'); return s; };
  // Every mutation in one store, including GC and close, shares this queue.
  const enqueue = (s, action) => { const next = s.queue.then(action); s.queue = next.catch(() => {}); return next; };
  async function checkRoot(s) { await safe.checkDirectory(s.root, s.rootIdentity); }
  async function managedDirectory(s, category) {
    await checkRoot(s); const directory = path.join(s.root, category);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const token = await safe.directoryIdentity(directory);
    if (s.directoryTokens.has(category) && s.directoryTokens.get(category) !== token) fail('SY_PROJECT_CHANGED', 'Project subdirectory identity changed.');
    s.directoryTokens.set(category, token); return { directory, token };
  }
  async function checkWriter(s) {
    if (s.writeProtection) fail('SY_SCHEMA_UNSUPPORTED', 'A project recovery point uses a newer format; this session cannot save or collect assets.');
    if (s.readOnly) fail('SY_READ_ONLY', 'This project was opened read-only.');
    await checkRoot(s); const lock = await safe.readChecked(s.lockPath, 4096);
    if (lock.sha256 !== s.lockHash || lock.identity !== s.lockIdentity) fail('SY_WRITE_CONFLICT', 'Project writer ownership changed.');
    // Per-chunk IO verifies the pinned identity instead of decoding/hashing the
    // entire saved index again. Atomic publication still checks its full SHA
    // immediately before replacing it through safe.atomicWrite/sameFile.
    const current = await exists(s.indexPath);
    if ((!current) !== (!s.expectedIndex) || current && (!current.isFile() || current.isSymbolicLink() || safe.identity(current) !== s.expectedIndex.identity)) fail('SY_WRITE_CONFLICT', 'Project index was changed outside this session.');
  }
  async function takeLock(s) {
    const lockBytes = Buffer.from(JSON.stringify({ token: randomUUID(), pid: process.pid, projectId: s.projectId }));
    try {
      const handle = await fs.open(s.lockPath, 'wx');
      try { await handle.writeFile(lockBytes); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await safe.readChecked(s.lockPath, 4096); let record;
      try { record = JSON.parse(old.bytes.toString('utf8')); } catch { fail('SY_WRITE_CONFLICT', 'Unrecognized project lock; no files were changed.'); }
      if (!Number.isSafeInteger(record.pid) || record.pid < 1) fail('SY_WRITE_CONFLICT', 'Unrecognized project writer.');
      let alive = true; try { process.kill(record.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) fail('SY_WRITE_CONFLICT', 'This project already has an active writer.');
      await safe.sameFile(s.lockPath, old, fs, 4096); await fs.unlink(s.lockPath);
      return takeLock(s);
    }
    const lock = await safe.readChecked(s.lockPath, 4096); s.lockHash = lock.sha256; s.lockIdentity = lock.identity;
  }
  async function cleanupAbandonedStaging(s) {
    const directory = path.join(s.root, '.sy-staging');
    if (!s.directoryTokens.has('.sy-staging')) return;
    await safe.checkDirectory(directory, s.directoryTokens.get('.sy-staging'));
    for (const name of await fs.readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(directory, name); const checked = await safe.readChecked(file, MAX_INDEX); let record;
      try { record = JSON.parse(checked.bytes.toString('utf8')); } catch { continue; }
      if (record.projectId !== s.projectId || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Array.isArray(record.files)) continue;
      let alive = true; try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) continue;
      const transactionId = path.basename(name, '.json'); let unchanged = true;
      for (const entry of record.files) {
        if (typeof entry.name !== 'string' || !entry.name.startsWith(`${transactionId}-`) || !/^[a-zA-Z0-9_-]+\.part$/.test(entry.name) || typeof entry.identity !== 'string') { unchanged = false; break; }
        const assetPath = path.join(directory, entry.name), stat = await exists(assetPath);
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== entry.identity) { unchanged = false; continue; }
        await checkWriter(s); await safe.checkDirectory(directory, s.directoryTokens.get('.sy-staging')); await fs.unlink(assetPath);
      }
      if (unchanged) { await safe.sameFile(file, checked, fs, MAX_INDEX); await fs.unlink(file); }
    }
  }
  function describe(s, issues = []) {
    const manifest = s.manifest ? clone(s.manifest) : null;
    return { sessionId: s.id, projectId: s.projectId, indexPath: s.indexPath, manifest, state: manifest?.state ?? null, recovery: { previous: s.previous ? clone(s.previous) : null, auto: s.auto ? clone(s.auto) : null }, ...(s.writeProtection ? { writeProtection: clone(s.writeProtection) } : {}), issues };
  }
  // Recheck recovery points at save/GC boundaries. Their observed identities do
  // not replace the pinned CAS identities used to publish over these files.
  async function inspectSessionRecovery(s) {
    await checkRoot(s);
    const points = [], unreadable = [], unsupported = new Set(s.writeProtection?.points || []);
    for (const kind of ['previous', 'auto']) {
      try {
        const point = await readManifest(path.join(s.root, 'recovery', `${kind}.sy`));
        if (point) {
          if (point.manifest.projectId !== s.projectId) fail('SY_PROJECT_CHANGED', 'Recovery point belongs to another project.');
          points.push(point.manifest); s.formatVersion = Math.max(s.formatVersion, point.manifest.formatVersion);
        }
      } catch (error) {
        if (error.code === 'SY_PROJECT_CHANGED') throw error;
        if (error.code === 'SY_SCHEMA_UNSUPPORTED') unsupported.add(kind);
        else if (error.code !== 'ENOENT') unreadable.push(kind);
      }
    }
    if (unsupported.size) s.writeProtection = { code: 'SY_SCHEMA_UNSUPPORTED', points: [...unsupported] };
    return { points, unreadable };
  }
  async function attach(indexPath, { create = false, readOnly = false, recovery = 'manual' } = {}) {
    const absolute = path.resolve(indexPath);
    if (!['.es', '.sy'].includes(path.extname(absolute).toLowerCase())) fail('SY_INVALID_REQUEST', 'Select an .es project index (.sy legacy projects are also supported).');
    const root = path.dirname(absolute);
    if (create) {
      await safe.directoryIdentity(path.dirname(root));
      const stat = await exists(root);
      if (!stat) await fs.mkdir(root);
      else if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(root)).length) fail('SY_TARGET_EXISTS', 'Save As requires a new or empty project directory.');
    }
    const rootIdentity = await safe.directoryIdentity(root);
    let main = null, brokenMain = null;
    try { main = await readManifest(absolute); } catch (error) {
      if (recovery === 'manual' || error.code === 'SY_SCHEMA_UNSUPPORTED') throw error;
      brokenMain = await safe.currentFile(absolute, fs, MAX_INDEX);
    }
    if (!create && !main && recovery === 'manual') fail('SY_INDEX_MISSING', 'Project index is missing.');
    let previous = null, auto = null; const issues = [], recoveryFiles = new Map(), unsupported = [];
    for (const kind of ['previous', 'auto']) {
      try {
        const recovered = await readManifest(path.join(root, 'recovery', `${kind}.sy`));
        recoveryFiles.set(kind, recovered?.current || null);
        if (kind === 'previous') previous = recovered?.manifest ?? null; else auto = recovered?.manifest ?? null;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error.code === 'SY_SCHEMA_UNSUPPORTED') unsupported.push(kind);
          issues.push({ kind, code: error.code || 'SY_INVALID_INDEX' });
          // Preserve damaged recovery bytes too; never replace an externally
          // changed recovery point using a freshly accepted identity.
          recoveryFiles.set(kind, await safe.currentFile(path.join(root, 'recovery', `${kind}.sy`), fs, MAX_INDEX));
        }
      }
    }
    const selected = recovery === 'previous' ? previous : recovery === 'auto' ? auto : main?.manifest;
    if (!create && !selected) fail('SY_RECOVERY_MISSING', 'Selected project recovery point is unavailable.');
    const projectId = selected?.projectId || randomUUID();
    if ((previous && previous.projectId !== projectId) || (auto && auto.projectId !== projectId) || (main && main.manifest.projectId !== projectId)) fail('SY_PROJECT_CHANGED', 'Recovery point belongs to another project.');
    const s = { id: randomUUID(), root, indexPath: absolute, rootIdentity, projectId, manifest: selected || null, manual: main?.manifest || null, previous, auto, recoveryFiles, expectedIndex: main?.current || brokenMain || null, lockPath: path.join(root, '.sy-writer.lock'), readOnly, ...(unsupported.length ? { writeProtection: { code: 'SY_SCHEMA_UNSUPPORTED', points: unsupported } } : {}), formatVersion: Math.max(1, ...[selected, main?.manifest, previous, auto].map(point => point?.formatVersion || 1)), queue: Promise.resolve(), transaction: null, leases: new Map(), readers: new Map(), deleting: new Set(), knownAssets: {}, directoryTokens: new Map(), closed: false };
    s.catalogPath = path.join(root, 'recovery', 'assets.json');
    s.catalogFile = await safe.currentFile(s.catalogPath, fs, MAX_INDEX);
    if (s.catalogFile) {
      const catalog = JSON.parse(s.catalogFile.bytes.toString('utf8'));
      if (catalog.schema !== 'sciyue-project-assets/v1' || catalog.projectId !== projectId) fail('SY_INVALID_INDEX', 'Project asset catalog identity is invalid.');
      validateManifest({ schema: SCHEMA, formatVersion: 1, projectId, generation: 1, assets: catalog.assets, assetIds: [], state: null });
      Object.assign(s.knownAssets, catalog.assets);
    }
    for (const manifest of [s.manifest, s.manual, previous, auto]) Object.assign(s.knownAssets, manifest?.assets || {});
    // Pin known directories at open. A later replacement cannot redirect reads/writes.
    for (const category of [...CATEGORIES, 'recovery', '.sy-staging']) if (await exists(path.join(root, category))) s.directoryTokens.set(category, await safe.directoryIdentity(path.join(root, category)));
    // Read-only sessions also hold an ownership lease so another process cannot
    // collect assets while that session still references an older generation.
    await takeLock(s);
    sessions.set(s.id, s);
    if (!readOnly && !s.writeProtection) {
      try { await cleanupAbandonedStaging(s); } catch (error) { issues.push({ kind: 'staging', code: error.code || 'SY_STAGING_RETAINED' }); }
    }
    for (const id of s.manifest?.assetIds || []) {
      const a = s.knownAssets[id]; const stat = await exists(path.join(root, a.relativePath));
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== a.bytes) issues.push({ assetId: id, code: 'SY_ASSET_MISSING_OR_DAMAGED' });
    }
    return describe(s, issues);
  }
  async function begin(sessionId, { kind = 'manual', state, assetIds } = {}) {
    const s = sessionFor(sessionId); return enqueue(s, async () => {
      await inspectSessionRecovery(s);
      await checkWriter(s); if (s.transaction) fail('SY_TRANSACTION_ACTIVE', 'A save is already in progress.');
      if (!['manual', 'auto'].includes(kind)) fail('SY_INVALID_REQUEST', 'Invalid save kind.');
      if (kind === 'auto' && !s.manual) fail('SY_UNSAVED_AUTOSAVE', 'An unsaved workspace cannot create automatic snapshots.');
      const { directory } = await managedDirectory(s, '.sy-staging');
      s.transaction = { id: randomUUID(), kind, state: clone(state === undefined ? s.manifest?.state ?? null : state), assetIds: assetIds === undefined ? [...(s.manifest?.assetIds || [])] : [...assetIds], added: new Set(), uploads: new Map(), staging: directory, stagingFile: null };
      return { transactionId: s.transaction.id };
    });
  }
  function transactionFor(s, id) { if (!s.transaction || s.transaction.id !== id) fail('SY_TRANSACTION_CLOSED', 'Save transaction is unavailable.'); return s.transaction; }
  async function persistCatalog(s, assets = s.knownAssets) {
    const { token } = await managedDirectory(s, 'recovery');
    const bytes = Buffer.from(JSON.stringify({ schema: 'sciyue-project-assets/v1', projectId: s.projectId, assets }));
    s.catalogFile = await safe.atomicWrite(s.catalogPath, bytes, s.catalogFile, token, fs, MAX_INDEX);
  }
  async function persistStaging(s, t) {
    const files = [...t.uploads.values()].filter(upload => !upload.done).map(upload => ({ name: path.basename(upload.file), identity: upload.identity.split(':').slice(0, 2).join(':') }));
    const bytes = Buffer.from(JSON.stringify({ projectId: s.projectId, pid: process.pid, files }));
    t.stagingFile = await safe.atomicWrite(path.join(t.staging, `${t.id}.json`), bytes, t.stagingFile, s.directoryTokens.get('.sy-staging'), fs, MAX_INDEX);
  }
  async function clearStagingRecord(s, t) {
    if (!t.stagingFile) return;
    const file = path.join(t.staging, `${t.id}.json`);
    await safe.checkDirectory(t.staging, s.directoryTokens.get('.sy-staging'));
    await safe.sameFile(file, t.stagingFile, fs, MAX_INDEX); await fs.unlink(file); t.stagingFile = null;
  }
  async function chunk(s, t, request) {
    if (t.failed) fail('SY_TRANSACTION_FAILED', 'Abort the failed asset transaction before writing again.');
    const { uploadId = randomUUID(), final = false, originalName, expectedSha256, expectedBytes } = request;
    const category = request.category || t.uploads.get(uploadId)?.category || 'sources';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(uploadId) || !CATEGORIES.has(category)) fail('SY_INVALID_REQUEST', 'Invalid asset upload.');
    const supplied = request.bytes ?? [];
    if (!(supplied instanceof ArrayBuffer) && !(supplied instanceof Uint8Array) && !Array.isArray(supplied)) fail('SY_INVALID_REQUEST', 'Asset chunk must contain binary bytes.');
    if ((supplied.byteLength ?? supplied.length) > maxChunkBytes) fail('SY_CHUNK_TOO_LARGE', 'Asset chunk exceeds the bounded transfer size.');
    const bytes = Buffer.from(supplied);
    if (bytes.length > maxChunkBytes) fail('SY_CHUNK_TOO_LARGE', 'Asset chunk exceeds the bounded transfer size.');
    let upload = t.uploads.get(uploadId);
    if (!upload) {
      const file = path.join(t.staging, `${t.id}-${uploadId}.part`); const handle = await fs.open(file, 'wx');
      upload = { file, handle, identity: safe.identity(await handle.stat()), hash: createHash('sha256'), bytes: 0, category, originalName, expectedSha256, expectedBytes }; t.uploads.set(uploadId, upload);
      await persistStaging(s, t);
    }
    if (upload.done) fail('SY_UPLOAD_FINISHED', 'Asset upload already finished.');
    if (upload.category !== category) fail('SY_INVALID_REQUEST', 'Asset category changed during upload.');
    let written = 0; while (written < bytes.length) { const result = await upload.handle.write(bytes, written, bytes.length - written); if (!result.bytesWritten) fail('SY_WRITE_FAILED', 'Asset write made no progress.'); written += result.bytesWritten; }
    upload.hash.update(bytes); upload.bytes += bytes.length;
    if (!final) return { uploadId, bytes: upload.bytes };
    await upload.handle.sync(); const uploadedIdentity = safe.identity(await upload.handle.stat()); await upload.handle.close(); upload.handle = null;
    const sha256 = upload.hash.digest('hex');
    if ((upload.expectedSha256 && sha256 !== upload.expectedSha256) || (upload.expectedBytes !== undefined && upload.bytes !== upload.expectedBytes)) fail('SY_SOURCE_CHANGED', 'Source bytes differ from their bound identity.');
    const duplicate = s.knownAssets[sha256]; const targetCategory = duplicate?.category || category;
    const { directory } = await managedDirectory(s, targetCategory); const relativePath = `${targetCategory}/asset-${sha256}.bin`; const target = path.join(directory, `asset-${sha256}.bin`);
    const asset = duplicate || { assetId: sha256, sha256, bytes: upload.bytes, relativePath, category: targetCategory, ...(upload.originalName ? { originalName: String(upload.originalName) } : {}) };
    // Record managed ownership before publishing the immutable file. A crash can
    // leave a missing catalog entry target, never an unowned asset to guess at.
    if (!duplicate) { await persistCatalog(s, { ...s.knownAssets, [sha256]: asset }); s.knownAssets[sha256] = asset; }
    if (safe.identity(await fs.lstat(upload.file)) !== uploadedIdentity) fail('SY_ASSET_CHANGED', 'Staged asset changed.');
    try { await fs.link(upload.file, target); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const verified = await digestFile(target); if (verified.sha256 !== sha256 || verified.bytes !== upload.bytes) fail('SY_ASSET_CHANGED', 'Existing immutable asset is damaged.');
    }
    await fs.unlink(upload.file); upload.done = true;
    // Completed assets are immutable and owned by the catalog. They are no
    // longer staging files and must not inflate the transaction cleanup list.
    await persistStaging(s, t);
    t.added.add(sha256);
    return { uploadId, asset: clone(s.knownAssets[sha256]) };
  }
  async function writeAssetChunk(sessionId, transactionId, request) { const s = sessionFor(sessionId); return enqueue(s, async () => { await checkWriter(s); return chunk(s, transactionFor(s, transactionId), request); }); }
  /** Complete bounded assets, with unchanged content-addressed files/receipts.
   * Durable staging ownership precedes writes; one durable catalog union
   * precedes publication. No receipt or project index can expose a partial group. */
  async function writeAssets(sessionId, transactionId, request) {
    const s = sessionFor(sessionId);
    return enqueue(s, async () => {
      await checkWriter(s); const t = transactionFor(s, transactionId);
      if (t.failed) fail('SY_TRANSACTION_FAILED', 'Abort the failed asset transaction before writing again.');
      const assets = request?.assets;
      if (!Array.isArray(assets) || assets.length < 1 || assets.length > ASSET_BATCH_ITEMS) fail('SY_INVALID_REQUEST', 'A complete asset batch requires 1–32 items.');
      const ids = new Set(); let total = 0;
      // Validate the whole group before opening files or changing ownership.
      const prepared = assets.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['uploadId','bytes','category','originalName','expectedSha256','expectedBytes'].includes(key))) fail('SY_INVALID_REQUEST', 'Invalid complete asset fields.');
        const { uploadId, originalName, expectedSha256, expectedBytes } = item, category = item.category || 'sources';
        if (typeof uploadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(uploadId) || ids.has(uploadId) || t.uploads.has(uploadId) || !CATEGORIES.has(category)) fail('SY_INVALID_REQUEST', 'Invalid or reused complete asset upload identity.');
        ids.add(uploadId);
        const supplied = item.bytes;
        if (!(supplied instanceof ArrayBuffer) && !(supplied instanceof Uint8Array) && !Array.isArray(supplied)) fail('SY_INVALID_REQUEST', 'Complete asset requires binary bytes.');
        const length = supplied.byteLength ?? supplied.length;
        total += length;
        if (!Number.isSafeInteger(total) || total > Math.min(maxChunkBytes, ASSET_BATCH_BYTES)) fail('SY_CHUNK_TOO_LARGE', 'Complete asset batch exceeds the bounded transfer size.');
        const bytes = supplied instanceof ArrayBuffer ? Buffer.from(new Uint8Array(supplied)) : Buffer.from(supplied);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) fail('SY_INVALID_REQUEST', 'Invalid complete asset expected identity.');
        if (expectedSha256 !== undefined && sha256 !== expectedSha256 || expectedBytes !== undefined && bytes.length !== expectedBytes) fail('SY_SOURCE_CHANGED', 'Source bytes differ from their bound identity.');
        return { uploadId, originalName, category, bytes, sha256 };
      });
      const uploads = [];
      try {
        // Record the complete bounded set once, including earlier active chunks.
        for (const item of prepared) {
          const file = path.join(t.staging, t.id + '-' + item.uploadId + '.part'), handle = await fs.open(file, 'wx');
          const upload = { file, handle, identity: safe.identity(await handle.stat()), bytes: item.bytes.length, category: item.category, originalName: item.originalName };
          t.uploads.set(item.uploadId, upload); uploads.push(upload);
        }
        await persistStaging(s, t);
        for (let index = 0; index < prepared.length; index++) {
          const item = prepared[index], upload = uploads[index]; let written = 0;
          while (written < item.bytes.length) {
            const value = await upload.handle.write(item.bytes, written, item.bytes.length - written);
            if (!value.bytesWritten) fail('SY_WRITE_FAILED', 'Asset write made no progress.'); written += value.bytesWritten;
          }
          // Each independent content file remains durable before publication.
          await upload.handle.sync(); upload.uploadedIdentity = safe.identity(await upload.handle.stat()); await upload.handle.close(); upload.handle = null;
        }
        const catalog = { ...s.knownAssets }; let added = false;
        for (const item of prepared) {
          if (catalog[item.sha256]) continue;
          catalog[item.sha256] = { assetId: item.sha256, sha256: item.sha256, bytes: item.bytes.length, relativePath: item.category + '/asset-' + item.sha256 + '.bin', category: item.category, ...(item.originalName ? { originalName: String(item.originalName) } : {}) }; added = true;
        }
        await checkWriter(s);
        if (added) { await persistCatalog(s, catalog); s.knownAssets = catalog; }
        for (let index = 0; index < prepared.length; index++) {
          const item = prepared[index], upload = uploads[index], asset = s.knownAssets[item.sha256];
          const { directory } = await managedDirectory(s, asset.category), target = path.join(directory, 'asset-' + item.sha256 + '.bin');
          await safe.checkDirectory(t.staging, s.directoryTokens.get('.sy-staging'));
          if (safe.identity(await fs.lstat(upload.file)) !== upload.uploadedIdentity) fail('SY_ASSET_CHANGED', 'Staged asset changed.');
          try { await fs.link(upload.file, target); } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const verified = await digestFile(target); if (verified.sha256 !== item.sha256 || verified.bytes !== item.bytes.length) fail('SY_ASSET_CHANGED', 'Existing immutable asset is damaged.');
          }
          await fs.unlink(upload.file); upload.done = true; t.added.add(item.sha256);
        }
        await persistStaging(s, t);
        return { receipts: prepared.map(item => ({ uploadId: item.uploadId, asset: clone(s.knownAssets[item.sha256]) })) };
      } catch (error) {
        // Never commit or acknowledge a partially published group. Keep its
        // exact staged/canonical ownership for explicit abort or crash recovery.
        t.failed = true;
        for (const upload of uploads) if (upload.handle) { try { await upload.handle.close(); upload.handle = null; } catch { /* Preserve the primary storage error and tracked handle. */ } }
        throw error;
      }
    });
  }
  async function importAsset(sessionId, transactionId, request) {
    const s = sessionFor(sessionId); return enqueue(s, async () => {
      await checkWriter(s); const t = transactionFor(s, transactionId);
      if (t.failed) fail('SY_TRANSACTION_FAILED', 'Abort the failed asset transaction before writing again.');
      if (!request.expectedIdentity || !request.expectedSha256) fail('SY_SOURCE_IDENTITY_REQUIRED', 'A source import requires its original identity and SHA-256.');
      const sourcePath = path.resolve(request.sourcePath); const parent = await safe.directoryIdentity(path.dirname(sourcePath));
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || safe.identity(stat) !== request.expectedIdentity) fail('SY_SOURCE_CHANGED', 'The original source file has changed.');
      const handle = await fs.open(sourcePath, 'r'); const uploadId = randomUUID(); let result;
      try {
        if (safe.identity(await handle.stat()) !== request.expectedIdentity) fail('SY_SOURCE_CHANGED', 'Source changed before import.');
        const bytes = Buffer.allocUnsafe(maxChunkBytes); let offset = 0;
        for (;;) { const read = await handle.read(bytes, 0, bytes.length, offset); if (!read.bytesRead) break; result = await chunk(s, t, { ...request, uploadId, bytes: bytes.subarray(0, read.bytesRead), final: false }); offset += read.bytesRead; }
        if (safe.identity(await handle.stat()) !== request.expectedIdentity || safe.identity(await fs.lstat(sourcePath)) !== request.expectedIdentity) fail('SY_SOURCE_CHANGED', 'Source changed while importing.');
        await safe.checkDirectory(path.dirname(sourcePath), parent);
        result = await chunk(s, t, { ...request, uploadId, bytes: Buffer.alloc(0), final: true });
      } finally { await handle.close(); }
      return result;
    });
  }
  async function publish(s, file, manifest) {
    const { token } = await managedDirectory(s, 'recovery');
    const parent = path.dirname(file) === s.root ? s.rootIdentity : token;
    const isMain = path.resolve(file) === s.indexPath; const kind = path.basename(file, '.sy');
    const expected = isMain ? s.expectedIndex : s.recoveryFiles.get(kind) || null;
    const saved = await safe.atomicWrite(file, Buffer.from(JSON.stringify(manifest)), expected, parent, fs, MAX_INDEX);
    if (!isMain) s.recoveryFiles.set(kind, saved);
    return saved;
  }
  async function commit(sessionId, transactionId, options = {}) {
    const s = sessionFor(sessionId); return enqueue(s, async () => {
      await inspectSessionRecovery(s);
      await checkWriter(s); const t = transactionFor(s, transactionId);
      if (t.failed) fail('SY_TRANSACTION_FAILED', 'Abort the failed asset transaction before committing.');
      if ([...t.uploads.values()].some(upload => !upload.done)) fail('SY_UPLOAD_INCOMPLETE', 'Save has incomplete asset uploads.');
      const assetIds = [...new Set([...(options.assetIds ?? t.assetIds), ...t.added])];
      for (const id of assetIds) if (!s.knownAssets[id]) fail('SY_ASSET_UNKNOWN', 'Save refers to an unregistered project asset.');
      const state = options.state === undefined ? t.state : clone(options.state);
      const requested = options.requiredFormatVersion ?? 1;
      const declared = state && typeof state === 'object' ? state.requiredProjectFormatVersion : undefined;
      if (![1, 2, 3, 4, 5, 6].includes(requested) || declared !== undefined && ![1, 2, 3, 4, 5, 6].includes(declared)) fail('SY_SCHEMA_UNSUPPORTED', 'Unsupported project save format requirement.');
      const formatVersion = Math.max(s.formatVersion, requested, declared || 1);
      // Protect the existing manual entry before publishing any newer auto
      // semantics. This is only a compatibility gate, never a manual save.
      if (t.kind === 'auto' && s.manual.formatVersion < formatVersion) {
        const original = s.manual, upgraded = { ...original, formatVersion };
        s.expectedIndex = await publish(s, s.indexPath, upgraded);
        s.manual = upgraded; s.formatVersion = formatVersion;
        if (s.manifest === original) s.manifest = upgraded;
      }
      if (t.kind === 'auto' && s.manifest && JSON.stringify(state) === JSON.stringify(s.manifest.state) && JSON.stringify(assetIds) === JSON.stringify(s.manifest.assetIds)) {
        await clearStagingRecord(s, t); s.transaction = null; return { ...describe(s), unchanged: true };
      }
      const manifest = { schema: SCHEMA, formatVersion, projectId: s.projectId, generation: Math.max(s.manual?.generation || 0, s.auto?.generation || 0, s.manifest?.generation || 0) + 1, appVersion, savedAt: new Date().toISOString(), kind: t.kind, assets: Object.fromEntries(assetIds.map(id => [id, clone(s.knownAssets[id])])), assetIds, state };
      validateManifest(manifest);
      if (t.kind === 'manual') {
        if (s.manual) { await publish(s, path.join(s.root, 'recovery', 'previous.sy'), s.manual); s.previous = s.manual; }
        await checkWriter(s); s.expectedIndex = await publish(s, s.indexPath, manifest); s.manual = manifest;
      } else { await publish(s, path.join(s.root, 'recovery', 'auto.sy'), manifest); s.auto = manifest; }
      s.manifest = manifest; s.formatVersion = formatVersion; s.transaction = null;
      const issues = [];
      try { await clearStagingRecord(s, t); } catch (error) { issues.push({ kind: 'staging', code: error.code || 'SY_STAGING_RETAINED' }); }
      return describe(s, issues);
    });
  }
  async function abortInner(s) {
    const t = s.transaction; if (!t) return;
    await checkRoot(s);
    for (const upload of t.uploads.values()) {
      if (upload.handle) { await upload.handle.close(); upload.handle = null; }
      if (!upload.done) { const stat = await exists(upload.file); if (stat?.isFile() && !stat.isSymbolicLink() && safe.identity(stat).split(':').slice(0, 2).join(':') === upload.identity.split(':').slice(0, 2).join(':')) { await safe.checkDirectory(t.staging, s.directoryTokens.get('.sy-staging')); await fs.unlink(upload.file); } }
    }
    await clearStagingRecord(s, t); s.transaction = null;
  }
  async function abort(sessionId, transactionId) { const s = sessionFor(sessionId); return enqueue(s, async () => { transactionFor(s, transactionId); await abortInner(s); }); }
  async function readAsset(sessionId, assetId, { offset = 0, length = maxChunkBytes } = {}) {
    const s = sessionFor(sessionId); const asset = s.knownAssets[assetId];
    if (!asset) fail('SY_ASSET_UNKNOWN', 'Unknown project asset.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > maxChunkBytes) fail('SY_INVALID_REQUEST', 'Invalid bounded asset read.');
    if (s.deleting.has(assetId)) { await s.queue; return readAsset(sessionId, assetId, { offset, length }); }
    s.readers.set(assetId, (s.readers.get(assetId) || 0) + 1);
    try {
      await checkRoot(s); const directory = path.join(s.root, asset.category); await safe.checkDirectory(directory, s.directoryTokens.get(asset.category));
      const file = path.join(s.root, asset.relativePath); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== asset.bytes) fail('SY_ASSET_MISSING_OR_DAMAGED', 'Project asset is missing or damaged.');
      // The first use verifies content once, then later chunks verify identity.
      if (!s.verified) s.verified = new Map();
      if (s.verified.get(assetId) !== safe.identity(stat)) { const digest = await digestFile(file); if (digest.sha256 !== asset.sha256) fail('SY_ASSET_MISSING_OR_DAMAGED', 'Project asset checksum failed.'); s.verified.set(assetId, digest.identity); }
      const handle = await fs.open(file, 'r');
      try {
        if (safe.identity(await handle.stat()) !== s.verified.get(assetId)) fail('SY_ASSET_CHANGED', 'Project asset changed.');
        const bytes = Buffer.alloc(Math.max(0, Math.min(length, asset.bytes - offset))); const read = await handle.read(bytes, 0, bytes.length, offset);
        if (safe.identity(await handle.stat()) !== s.verified.get(assetId) || safe.identity(await fs.lstat(file)) !== s.verified.get(assetId)) fail('SY_ASSET_CHANGED', 'Project asset changed while reading.');
        return { bytes: bytes.subarray(0, read.bytesRead), eof: offset + read.bytesRead >= asset.bytes, totalBytes: asset.bytes };
      } finally { await handle.close(); }
    } finally { const count = (s.readers.get(assetId) || 1) - 1; if (count) s.readers.set(assetId, count); else s.readers.delete(assetId); }
  }
  /** Complete small assets only. Pin the entire group before the first await,
   * reuse ordinary per-file identity checks, and never return a partial group. */
  async function readAssets(sessionId, request) {
    const s = sessionFor(sessionId), assetIds = request?.assetIds;
    if (!request || Object.keys(request).some(key => key !== 'assetIds') || !Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > ASSET_BATCH_ITEMS) fail('SY_INVALID_REQUEST', 'A complete asset read requires 1–32 identities.');
    let total = 0;
    const assets = assetIds.map(assetId => {
      if (typeof assetId !== 'string' || !/^[a-f0-9]{64}$/.test(assetId) || !Object.hasOwn(s.knownAssets, assetId)) fail('SY_ASSET_UNKNOWN', 'Unknown project asset.');
      const asset = s.knownAssets[assetId]; total += asset.bytes;
      if (!Number.isSafeInteger(total) || total > Math.min(maxChunkBytes, ASSET_BATCH_BYTES)) fail('SY_CHUNK_TOO_LARGE', 'Complete asset read exceeds the bounded transfer size.');
      return asset;
    });
    const unique = [...new Set(assetIds)];
    if (unique.some(id => s.deleting.has(id))) { await s.queue; return readAssets(sessionId, request); }
    for (const id of unique) s.readers.set(id, (s.readers.get(id) || 0) + 1);
    try {
      const completed = await Promise.allSettled(unique.map(async assetId => {
        const asset = s.knownAssets[assetId], result = await readAsset(sessionId, assetId, { offset: 0, length: Math.max(1, asset.bytes) });
        if (!result.eof || result.totalBytes !== asset.bytes || result.bytes.length !== asset.bytes || createHash('sha256').update(result.bytes).digest('hex') !== asset.sha256) fail('SY_ASSET_MISSING_OR_DAMAGED', 'Complete asset bytes do not match their immutable metadata.');
        return { assetId, bytes: result.bytes, asset: clone(asset) };
      }));
      for (const result of completed) if (result.status === 'rejected') throw result.reason;
      await checkRoot(s);
      for (const category of new Set(assets.map(asset => asset.category))) await safe.checkDirectory(path.join(s.root, category), s.directoryTokens.get(category));
      const byId = new Map(completed.map((result, index) => [unique[index], result.value]));
      return { assets: assetIds.map(id => byId.get(id)) };
    } finally {
      for (const id of unique) { const count = (s.readers.get(id) || 1) - 1; if (count) s.readers.set(id, count); else s.readers.delete(id); }
    }
  }
  function retainAssets(sessionId, assetIds) { const s = sessionFor(sessionId); for (const id of assetIds) if (!s.knownAssets[id]) fail('SY_ASSET_UNKNOWN', 'Unknown retained asset.'); const leaseId = randomUUID(); s.leases.set(leaseId, new Set(assetIds)); return { leaseId }; }
  function releaseAssets(sessionId, leaseId) { sessionFor(sessionId).leases.delete(leaseId); }
  async function gc(sessionId) {
    const s = sessionFor(sessionId); return enqueue(s, async () => {
      const recovery = await inspectSessionRecovery(s);
      await checkWriter(s); if (s.transaction) return { deleted: [], skipped: 'save-in-progress' };
      if (recovery.unreadable.length) return { deleted: [], skipped: 'recovery-unreadable' };
      if (s.manual && s.manual.formatVersion < s.formatVersion) return { deleted: [], skipped: 'format-upgrade-required' };
      const retained = new Set(); for (const manifest of [s.manifest, s.manual, s.previous, s.auto, ...recovery.points]) for (const id of manifest?.assetIds || []) retained.add(id);
      for (const lease of s.leases.values()) for (const id of lease) retained.add(id);
      const deleted = [], skipped = [];
      for (const [id, asset] of Object.entries(s.knownAssets)) {
        if (retained.has(id) || s.readers.has(id)) continue;
        const file = path.join(s.root, asset.relativePath);
        try {
          await checkWriter(s); await safe.checkDirectory(path.dirname(file), s.directoryTokens.get(asset.category));
          const digest = await digestFile(file); if (digest.sha256 !== id || digest.bytes !== asset.bytes) { skipped.push({ assetId: id, reason: 'changed' }); continue; }
          s.deleting.add(id);
          try {
            if (s.readers.has(id) || [...s.leases.values()].some(lease => lease.has(id))) continue;
            if (safe.identity(await fs.lstat(file)) !== digest.identity) { skipped.push({ assetId: id, reason: 'changed' }); continue; }
            if (s.readers.has(id) || [...s.leases.values()].some(lease => lease.has(id))) continue;
            await fs.unlink(file); deleted.push({ assetId: id, bytes: asset.bytes }); delete s.knownAssets[id];
          } finally { s.deleting.delete(id); }
        } catch (error) { if (error.code === 'ENOENT') { skipped.push({ assetId: id, reason: 'missing' }); continue; } throw error; }
      }
      if (deleted.length) await persistCatalog(s);
      return { deleted, skipped };
    });
  }
  async function close(sessionId) {
    const s = sessionFor(sessionId); return enqueue(s, async () => {
      if (s.readers.size) fail('SY_READ_IN_PROGRESS', 'Wait for project reads before closing.');
      await abortInner(s);
      await checkRoot(s); const current = await safe.readChecked(s.lockPath, 4096); if (current.sha256 !== s.lockHash || current.identity !== s.lockIdentity) fail('SY_WRITE_CONFLICT', 'Project lock changed; it was retained.'); await fs.unlink(s.lockPath);
      s.closed = true; s.leases.clear(); sessions.delete(sessionId);
    });
  }
  async function inspectRecovery(indexPath) {
    const root = path.dirname(path.resolve(indexPath)); const token = await safe.directoryIdentity(root);
    const points = {}, issues = [];
    for (const kind of ['previous', 'auto']) {
      try { const point = await readManifest(path.join(root, 'recovery', `${kind}.sy`)); if (point) { const { projectId, generation, savedAt } = point.manifest; points[kind] = { projectId, generation, savedAt }; } }
      catch (error) { if (error.code !== 'ENOENT') issues.push({ kind, code: error.code || 'SY_INVALID_INDEX' }); }
    }
    await safe.checkDirectory(root, token); return { points, issues };
  }
  return { create: indexPath => attach(indexPath, { create: true }), open: attach, inspectRecovery, begin, writeAssetChunk, writeAssets, importAsset, commit, abort, readAsset, readAssets, retainAssets, releaseAssets, gc, close, getSession: sessionId => describe(sessionFor(sessionId)) };
}
module.exports = { createSyProjectStore, validateManifest, SCHEMA, DEFAULT_CHUNK, ASSET_BATCH_ITEMS, ASSET_BATCH_BYTES };
