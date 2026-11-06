"use strict";
const S = require("./postprocess-storage.cjs");
function createPostprocessManagedSources({ getLibrary, assertManager = () => {}, registerSourceTask, resolveLinkedRun, operations, now = () => new Date().toISOString() }) {
 const uploads = new Map(), requests = new Map();
 async function ended(origin) { const state = await resolveLinkedRun(origin); if (!state?.ended) throw S.fail("POSTPROCESS_LINKED_RUN_ACTIVE", state?.reason || "原运行尚未确认结束，不能归档。" ); }
 return {
  async admission({ origin }) { const state = await resolveLinkedRun(origin); return { eligible: state?.ended === true, ...(state?.ended ? {} : { reason: state?.reason || '原运行尚未确认结束，不能归档。' }) }; },
  async begin(input) {
   assertManager(); S.safeId(input.requestId); if (requests.has(input.requestId)) return requests.get(input.requestId);
   if (!input.displayName?.trim() || !input.sourceSet?.sourceSetId || !input.sourceSet.sourceVersion || !input.sourceSet.documentId) throw S.fail("POSTPROCESS_SOURCE_IDENTITY_REQUIRED");
   await ended(input.sourceSet.origin); const library = await getLibrary(), taskId = input.taskId || S.id(), uploadId = S.id();
   const root = await S.directory(input.archiveRootOverride || S.path.join(library.directory, "archive"));
   const directory = S.path.join(root, "source-" + uploadId); await S.directory(directory);
   const files = S.validateFiles(input.sourceSet.files).map(file => ({ ...file, artifactId: S.id() }));
   const { membershipId } = require('./library/organization.cjs');
   const operation = await operations.begin({ type: "postprocess-source-save", taskId, targets: [{ kind: 'task', id: taskId }, { kind: 'sourceSet', id: input.sourceSet.sourceSetId }, ...files.map(file => ({ kind: 'artifact', id: file.artifactId })), ...[...new Set(input.groupIds || [])].map(groupId => ({ kind: 'groupMembership', id: membershipId(taskId, groupId) }))], phase: "copying", scope: { uploadId, directory, sourceSetId: input.sourceSet.sourceSetId, sourceVersion: input.sourceSet.sourceVersion, origin: input.sourceSet.origin, groupIds: input.groupIds } });
   const upload = { uploadId, directory, files, input: structuredClone(input), taskId, operationId: operation.operationId, libraryId: library.libraryId };
   await S.atomic(S.path.join(directory, "source-save.pending.json"), { uploadId, taskId, operationId: operation.operationId, sourceSet: input.sourceSet, createdAt: now() });
   uploads.set(uploadId, upload); const result = { uploadId, operationId: operation.operationId, taskId }; requests.set(input.requestId, result); return result;
  },
  async append(input) { const upload = uploads.get(input.uploadId); if (!upload) throw S.fail("POSTPROCESS_UPLOAD_NOT_FOUND"); const result = await S.append(upload, input); await operations.update(upload.operationId, { phase: "copying", ...S.progress(upload) }); return result; },
  async commit({ uploadId }) {
   const upload = uploads.get(uploadId); if (!upload) throw S.fail("POSTPROCESS_UPLOAD_NOT_FOUND"); if (upload.receipt) return upload.receipt; if (upload.done) throw S.fail("POSTPROCESS_UPLOAD_CLOSED"); if (upload.committing) throw S.fail("POSTPROCESS_UPLOAD_COMMITTING"); upload.committing = true;
   try {
    await ended(upload.input.sourceSet.origin); await S.verify(upload, value => operations.update(upload.operationId, {phase:"verifying",...value}));
    const { sourceSet } = upload.input; const files = upload.files.map(({ written, ...file }) => ({ ...file, category: "source", roles: [file.role], revision: file.sha256 }));
    const summary=sourceSet.summary;
    if(summary&&(summary.schema!==1||summary.sourceSetId!==sourceSet.sourceSetId||summary.sourceVersion!==sourceSet.sourceVersion||!files.some(file=>file.sha256===summary.sourceSha256&&file.sourceId===summary.sourceId)||!summary.structure?.atoms?.length||summary.structure.atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite))||summary.energy!==null&&(!summary.energy||!Number.isFinite(summary.energy.value)||typeof summary.energy.unit!=='string')))throw S.fail('POSTPROCESS_SUMMARY_IDENTITY_INVALID');
    const manifest = { schema: "ester-managed-postprocess-sources/v1", version: 1, requiredCapabilities: ["es:task-source-only-v1"], sourceSetId: sourceSet.sourceSetId, sourceVersion: sourceSet.sourceVersion, documentId: sourceSet.documentId, origin: sourceSet.origin, files, ...(summary?{summary}:{}), savedAt: now() };
    const manifestPath = S.path.join(upload.directory, "managed-sources.json"); await S.atomic(manifestPath, manifest);
    const registered = await registerSourceTask({ taskId: upload.taskId, displayName: upload.input.displayName, sourceSetId: sourceSet.sourceSetId, sourceVersion: sourceSet.sourceVersion, sourceOrigin: sourceSet.origin, origin: { kind: "postprocess-saved", sourceKind: sourceSet.origin?.kind || "postprocess" }, groupIds: upload.input.groupIds, locations: [{ directory: upload.directory, manifestPath, role: "archive" }], files,...(summary?{summary,engineId:summary.engineId,taskKind:summary.taskKind}:{}), main: files.find(file => ["primary-output", "wavefunction", "molden"].includes(file.role))?.relativePath || files[0].relativePath, operationId: upload.operationId });
    const receipt = { taskId: registered.taskId || upload.taskId, sourceSetId: sourceSet.sourceSetId, sourceVersion: sourceSet.sourceVersion, locationId: registered.locationId, directory: registered.activeDirectory || upload.directory, artifactIds: registered.artifactIds || files.map(file => file.artifactId), archived: true };
    await S.atomic(S.path.join(upload.directory, "source-save.receipt.json"), receipt); upload.receipt = receipt; upload.done = true; await operations.complete(upload.operationId, { results: [{ ...receipt }] }); return receipt;
   } catch (error) { await operations.fail(upload.operationId, error); throw error; } finally { upload.committing = false; }
  },
  async abort({ uploadId }) { const upload = uploads.get(uploadId); if (!upload || upload.done) return { aborted: false }; if (upload.committing) throw S.fail("POSTPROCESS_UPLOAD_COMMITTING"); upload.done = true; await operations.fail(upload.operationId, S.fail("POSTPROCESS_UPLOAD_ABORTED", "已取消来源归档，原始来源保留。")); return { aborted: true }; },
  async close() { uploads.clear(); requests.clear(); }
 };
}
module.exports = { createPostprocessManagedSources };
