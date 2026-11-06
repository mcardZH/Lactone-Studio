"use strict";
const S = require("./postprocess-storage.cjs");
const capability = "es:task-postprocess-cache-v1";
function createPostprocessCache({ assertManager = () => {}, resolveArchivedSourceSet, operations, now = () => new Date().toISOString(), updateCacheReference = async () => {} }) {
 const uploads = new Map(), requests = new Map(), plans = new Map(), leases = new Map(), active = new Map();
 async function source(input) { return resolveArchivedSourceSet(input); }
 const rootFor = archived => S.path.join(archived.directory, ".es-postprocess-cache");
 async function current(input) { const archived = await source(input), root = rootFor(archived); let pointer; try { pointer = await S.json(S.path.join(root, "current.json")); } catch (error) { if (error.code === "ENOENT") return { archived, root }; throw error; } const directory = S.inside(root, S.safeId(pointer.cacheId)), manifest = await S.json(S.path.join(directory, "cache.json")); if (manifest.cacheId !== pointer.cacheId || manifest.taskId !== input.taskId || manifest.state !== "complete" || manifest.schema !== 1 || !manifest.requiredCapabilities?.every(value => value === capability)) throw S.fail("POSTPROCESS_CACHE_FORMAT_INVALID"); return { archived, root, directory, manifest }; }
 async function cache(input) { const archived = await source(input), root = rootFor(archived), directory = S.inside(root, S.safeId(input.cacheId)), manifest = await S.json(S.path.join(directory, "cache.json")); if (manifest.taskId !== input.taskId || manifest.cacheId !== input.cacheId || manifest.state !== "complete" || manifest.schema !== 1 || !manifest.requiredCapabilities?.every(value => value === capability)) throw S.fail("POSTPROCESS_CACHE_IDENTITY_INVALID"); if (manifest.sourceSetId !== archived.sourceSetId || manifest.sourceVersion !== archived.sourceVersion) throw S.fail("POSTPROCESS_CACHE_SOURCE_MISMATCH"); return { archived, root, directory, manifest }; }
 const inUse = cacheId => [...leases.values()].some(value => value.cacheId === cacheId) || (active.get(cacheId) || 0) > 0;
 const api = {
  async describe(input) { const value = await current(input), m = value.manifest; if (!m) return { cacheId: null, savedAt: null, byteSize: 0, state: "absent" }; const compatible = m.sourceSetId === input.sourceSetId && m.sourceVersion === input.sourceVersion; return { cacheId: m.cacheId, savedAt: m.savedAt, byteSize: m.byteSize, state: compatible ? "complete" : "incompatible", manifest: m }; },
  async begin(input) {
   assertManager(); S.safeId(input.requestId); if (requests.has(input.requestId)) return requests.get(input.requestId); const archived = await source(input), m = input.manifest;
   if (m.schema !== 1 || m.taskId !== input.taskId || m.sourceSetId !== input.sourceSetId || m.sourceVersion !== input.sourceVersion || !m.requiredCapabilities?.includes(capability) || !m.requiredCapabilities.every(value => value === capability) || !Array.isArray(m.entries) || !Array.isArray(m.assets)) throw S.fail("POSTPROCESS_CACHE_FORMAT_INVALID");
   const files = S.validateFiles(input.files, ["derived-cache", "state-index"]), cacheId = S.safeId(m.cacheId), uploadId = S.id(), directory = S.inside(rootFor(archived), cacheId);
   try { await S.fs.lstat(directory); throw S.fail("POSTPROCESS_CACHE_GENERATION_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
   const assets = new Map(m.assets.map(asset => [asset.assetId, asset])), byFile = new Map(m.assets.map(asset => [asset.fileId,asset])); if (assets.size !== m.assets.length || byFile.size !== m.assets.length || files.length !== assets.size || files.some(file => {const asset=byFile.get(file.fileId);return !asset||asset.role!==file.role||asset.byteSize!==file.byteSize;})) throw S.fail("POSTPROCESS_CACHE_ASSET_INDEX_INVALID");
   const sourceHashes = new Set(archived.files.map(file => file.sha256 || file.revision));
   for (const entry of m.entries) if (!entry.key || !assets.has(entry.assetId) || !Array.isArray(entry.assetReferences) || entry.assetReferences.some(ref => !assets.has(ref) && !sourceHashes.has(ref))) throw S.fail("POSTPROCESS_CACHE_DEPENDENCY_INVALID");
   await S.directory(directory); const operation = await operations.begin({ type: "postprocess-cache-save", taskId: input.taskId, targets: [{ kind: 'task', id: input.taskId }], phase: "writing", scope: { uploadId, cacheId, sourceSetId: input.sourceSetId, sourceVersion: input.sourceVersion } });
   const upload = { uploadId, directory, files, input: structuredClone(input), operationId: operation.operationId }; uploads.set(uploadId, upload); const receipt = { uploadId, operationId: operation.operationId }; requests.set(input.requestId, receipt); return receipt;
  },
  async append(input) { const upload = uploads.get(input.uploadId); if (!upload) throw S.fail("POSTPROCESS_UPLOAD_NOT_FOUND"); const value = await S.append(upload, input); await operations.update(upload.operationId, { phase: "writing", ...S.progress(upload) }); return value; },
  async commit({ uploadId }) {
   const upload = uploads.get(uploadId); if (!upload) throw S.fail("POSTPROCESS_UPLOAD_NOT_FOUND"); if (upload.receipt) return upload.receipt; if (upload.done) throw S.fail("POSTPROCESS_UPLOAD_CLOSED"); if (upload.committing) throw S.fail("POSTPROCESS_UPLOAD_COMMITTING"); upload.committing = true;
   try { const archived = await source(upload.input); await S.verify(upload, value => operations.update(upload.operationId,{phase:"verifying",...value})); const byFile=new Map(upload.files.map(file=>[file.fileId,file])); const manifest = { ...upload.input.manifest, assets: upload.input.manifest.assets.map(asset => ({ ...asset, relativePath: byFile.get(asset.fileId).relativePath, sha256: byFile.get(asset.fileId).sha256 })), savedAt: now(), byteSize: upload.files.reduce((a, f) => a + f.byteSize, 0), state: "complete" };
    await S.atomic(S.path.join(upload.directory, "cache.json"), manifest);
    const pointerPath = S.path.join(rootFor(archived), "current.json"); let previousPointer;
    try { previousPointer = await S.json(pointerPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await S.atomic(pointerPath, { cacheId: manifest.cacheId });
    const receipt = { cacheId: manifest.cacheId, taskId: manifest.taskId, sourceSetId: manifest.sourceSetId, sourceVersion: manifest.sourceVersion, savedAt: manifest.savedAt, byteSize: manifest.byteSize, state: "complete" };
    try { await updateCacheReference(manifest.taskId, { ...receipt, manifestPath: S.path.join(upload.directory, "cache.json"), requiredCapabilities: [capability] }, upload.operationId); }
    catch (error) { if (previousPointer) await S.atomic(pointerPath, previousPointer); else await S.fs.unlink(pointerPath); throw error; }
    upload.receipt = receipt; upload.done = true; await operations.complete(upload.operationId, { results: [receipt] }); return receipt;
   } catch (error) { await operations.fail(upload.operationId, error); throw error; } finally { upload.committing = false; }
  },
  async abort({ uploadId }) { const upload = uploads.get(uploadId); if (!upload || upload.done) return { aborted: false }; if (upload.committing) throw S.fail("POSTPROCESS_UPLOAD_COMMITTING"); upload.done = true; await operations.fail(upload.operationId, S.fail("POSTPROCESS_CACHE_CANCELLED")); return { aborted: true }; },
  async retain(input) { await cache(input); const leaseId = S.id(); leases.set(leaseId, { taskId: input.taskId, cacheId: input.cacheId }); return { leaseId }; },
  async release({ leaseId }) { leases.delete(leaseId); },
  async read(input) {
   const value = await cache(input); if (input.leaseId && (leases.get(input.leaseId)?.taskId !== input.taskId || leases.get(input.leaseId)?.cacheId !== input.cacheId)) throw S.fail("POSTPROCESS_CACHE_LEASE_EXPIRED");
   const derived = value.manifest.assets.find(row => row.fileId === input.fileId), original = derived ? undefined : value.archived.files.find(row => (row.sha256 || row.revision) === input.fileId), asset = derived || original;
   if (!asset || ![input.offset, input.length].every(Number.isSafeInteger) || input.offset < 0 || input.length < 0 || input.length > 1024 ** 2 || input.offset + input.length > asset.byteSize) throw S.fail("POSTPROCESS_CACHE_RANGE_INVALID");
   active.set(input.cacheId, (active.get(input.cacheId) || 0) + 1);
   try { const target = S.inside(derived ? value.directory : value.archived.directory, asset.relativePath); const info = await S.regular(target); if (info.size !== asset.byteSize) throw S.fail("POSTPROCESS_CACHE_ASSET_CHANGED"); const bytes = new Uint8Array(input.length), handle = await S.fs.open(target, "r"); try { const result = await handle.read(bytes, 0, bytes.length, input.offset); if (result.bytesRead !== bytes.length) throw S.fail("POSTPROCESS_CACHE_SHORT_READ"); } finally { await handle.close(); } return { offset: input.offset, bytes }; }
   finally { active.set(input.cacheId, active.get(input.cacheId) - 1); }
  },
  async deletePlan(input) {
   assertManager(); const value = await cache(input), planId = S.id(), generations = [];
   for (const entry of await S.fs.readdir(value.root, {withFileTypes:true})) {
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;let directory,manifest;
    try { directory=S.inside(value.root,S.safeId(entry.name));manifest=await S.json(S.path.join(directory,'cache.json')); } catch { continue; }
    if(manifest.schema!==1||manifest.state!=='complete'||manifest.taskId!==input.taskId||manifest.sourceSetId!==value.manifest.sourceSetId||manifest.sourceVersion!==value.manifest.sourceVersion||manifest.cacheId!==entry.name||!Array.isArray(manifest.assets)||!manifest.requiredCapabilities?.every(cap=>cap===capability))continue;
    if(manifest.assets.some(asset=>!['derived-cache','state-index'].includes(asset.role)))continue;
    generations.push({directory,manifest,indexSha256:await S.digest(S.path.join(directory,'cache.json'))});
   }
   if(!generations.some(generation=>generation.manifest.cacheId===input.cacheId))throw S.fail('POSTPROCESS_CACHE_DELETE_MANIFEST_INVALID');
   const files=generations.flatMap(generation=>generation.manifest.assets.map(asset=>({fileId:generation.manifest.cacheId+'/'+asset.fileId,role:asset.role,name:S.path.basename(asset.relativePath),byteSize:asset.byteSize})));
   plans.set(planId,{...input,...value,generations});return{planId,byteSize:files.reduce((sum,file)=>sum+file.byteSize,0),files,inUse:generations.some(generation=>inUse(generation.manifest.cacheId))};
  },
  async delete({ planId }) {
   assertManager(); const plan = plans.get(planId); if (!plan) throw S.fail("POSTPROCESS_CACHE_DELETE_PLAN_EXPIRED"); const value = await cache(plan), operation = await operations.begin({ type: "postprocess-cache-delete", taskId: plan.taskId, targets: [{ kind: 'task', id: plan.taskId }], phase: "deleting", scope: { planId, cacheId: plan.cacheId } }), deleted = [], retained = [];
   if (plan.generations.some(generation=>inUse(generation.manifest.cacheId))) { for (const generation of plan.generations) for(const asset of generation.manifest.assets)retained.push({ fileId:generation.manifest.cacheId+'/'+asset.fileId, reason: "in-use" }); await operations.complete(operation.operationId, { results: retained }); return { operationId: operation.operationId, deleted, retained }; }
   try {
    const removedGenerations=new Set();
    for(const generation of plan.generations){const cacheId=generation.manifest.cacheId,index=S.path.join(generation.directory,'cache.json');
     if(await S.digest(index)!==generation.indexSha256){for(const asset of generation.manifest.assets)retained.push({fileId:cacheId+'/'+asset.fileId,reason:'changed-index'});continue;}
     let complete=true;
     for (const asset of generation.manifest.assets) { const fileId=cacheId+'/'+asset.fileId;if (!["derived-cache", "state-index"].includes(asset.role)) throw S.fail("POSTPROCESS_CACHE_SOURCE_DELETE_DENIED"); const target = S.inside(generation.directory, asset.relativePath); try { const info = await S.regular(target); if (info.size !== asset.byteSize || await S.digest(target) !== asset.sha256) { retained.push({ fileId, reason: "changed" });complete=false;continue; } await S.fs.unlink(target); deleted.push(fileId); } catch (error) { if (error.code === "ENOENT") deleted.push(fileId); else{retained.push({ fileId, reason: error.code || error.message });complete=false;} } }
     if(complete){await S.fs.unlink(index);removedGenerations.add(cacheId);}
    }
    const pointer=await S.json(S.path.join(value.root,'current.json')).catch(()=>undefined);if(pointer&&removedGenerations.has(pointer.cacheId)){await S.fs.unlink(S.path.join(value.root,'current.json'));await updateCacheReference(plan.taskId,null,operation.operationId);}
    await operations.complete(operation.operationId, { results: [...deleted.map(fileId => ({ fileId, state: "deleted" })), ...retained] }); plans.delete(planId); return { operationId: operation.operationId, deleted, retained };
   } catch (error) { await operations.fail(operation.operationId, error, { results: retained }); throw error; }
  },
  async close() { uploads.clear(); requests.clear(); plans.clear(); leases.clear(); }
 }; return api;
}
module.exports = { createPostprocessCache };
