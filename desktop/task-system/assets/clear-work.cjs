"use strict";
const { fail, digest, crypto, clone, unchanged } = require("./io.cjs");
const { base, id, assertFrozenScope, withArtifactReferences, EXECUTION_BATCH_ITEMS, yieldIO } = require("./common.cjs");
const { inventory, ownedArtifactId } = require("./work-files.cjs");
const { listAll } = require("../operation-guards.cjs");
function createClearWork(context) {
	const { library, transport, begin, update, mutation, safeState, now, permits, executionLocks = new Set() } = context;
	async function planClearWork({ manager, taskId, runId, signal, onProgress }) {
		library.assertManager(manager);
		const task = library.read("task", taskId), run = library.read("run", runId);
		if (!task || !run || run.taskId !== taskId || task.latestRunId !== runId) throw fail("ASSET_CLEAR_RUN_MISMATCH");
		const work = run.executionIdentity.workLocation;
		const runActiveAtPreview = run.state.executionState !== "ended";
		let listing;
		try { listing = await inventory(await transport(work.environmentId), work, { hash: !runActiveAtPreview, signal, onProgress }); }
		catch (error) { if (!require("../transports/file-errors.cjs").isMissingFile(error, work.path)) throw error; listing = { rootIdentity: null, files: [], exclusions: [] }; }
		const artifactRows = listAll(library, "artifact", { runId });
		const artifactsByPath = new Map(); for (const artifact of artifactRows) for (const location of artifact.locations || []) if (location.environmentId === work.environmentId && !artifactsByPath.has(location.path)) artifactsByPath.set(location.path, artifact.artifactId);
		const files = listing.files.filter(file => !file.relativePath.endsWith("/.es-scratch-owner.json")).map(file => ({ ...file, ...(runActiveAtPreview ? { hashAfterStop: true } : {}), fileIdentity: file.identity, basis: { kind: "explicit-clear-work", taskId, runId }, dependencyCheck: { state: "recheck-before-delete" }, impact: "永久删除本次确认的工作文件，保留任务卡和提交记录", artifactId: artifactsByPath.get(file.path) || ownedArtifactId(runId, file.relativePath), originalLocation: { ...work, path: file.path }, result: { state: "not-executed" } }));
		const archives = listAll(library, "archiveManifest", { taskId }).filter(archive => archive.runId === runId && archive.status === "verified");
		const archivedByPath = new Map(); for (const archive of archives) for (const item of archive.items) if (item.included && item.copyState === "copied" && item.verificationState === "verified" && item.storageState !== "recycled" && item.sourceLocation?.environmentId === work.environmentId) { const values = archivedByPath.get(item.sourceLocation.path) || []; values.push(item); archivedByPath.set(item.sourceLocation.path, values); }
		const directoryMode = task.directoryMode || (task.plannedArchiveLocation || archives.length ? "dual" : run.environmentSnapshot.connection.kind === "local" ? "single" : "dual");
		let covered = 0, uncertain = false;
		if (directoryMode === "dual") for (const file of files) {
			if (runActiveAtPreview) { if (archives.length) uncertain = true; continue; }
			const candidates = (archivedByPath.get(file.path) || []).filter(item => item.sha256 === file.sha256 && unchanged(item.sourceIdentity, file.identity));
			let verified = false;
			for (const item of candidates) {
				try {
					const copy = await require("./io.cjs").hashLocal(item.targetPath);
					// fileId is comparable only within the local filesystem domain. A
					// second name (including a hard link) for this source is not a copy.
					if (run.environmentSnapshot.connection.kind === "local" && copy.fileId === file.identity.fileId) continue;
					if (copy.sha256 === file.sha256 && copy.byteSize === file.byteSize) verified = true; else uncertain = true;
				}
				catch { uncertain = true; }
			}
			if (verified) covered++;
		}
		const archiveCoverage = directoryMode === "single" ? undefined : uncertain ? "unknown" : files.length && covered === files.length ? "full" : covered ? "partial" : "none";
		const manifestId = id("cleanup"), operationId = id("op"), confirmationToken = crypto.randomBytes(32).toString("hex");
		const manifest = { ...base(), requiredCapabilities: ["es:task-clear-work-v1"], manifestId, taskId, runId, operationId, kind: "clear-work", runActiveAtPreview, sourceLocation: work, rootIdentity: listing.rootIdentity, items: files, exclusions: listing.exclusions, status: "awaiting-confirmation" };
		const op = begin(manager, "cleanup-original", [{ kind: "task", id: taskId }, { kind: "run", id: runId }, { kind: "cleanupManifest", id: manifestId }], { requiredCapabilities: ["es:task-clear-work-v1"], operationId, confirmationHash: digest(confirmationToken), manifest, irreversible: true });
		update(op, "awaiting-confirmation", "running", [], [mutation("cleanupManifest", manifestId, manifest)]);
		return { manifest, confirmationToken, directoryMode, workPath: work.path, ...(archiveCoverage ? { archiveCoverage } : {}), impact: { count: files.length, logicalBytes: files.reduce((sum,file) => sum + file.byteSize, 0), irreversible: true }, requiresStop: run.state.executionState !== "ended" };
	}
	async function clearWork({ manifestId, confirmationToken, signal, onProgress }) {
		const manifest = library.read("cleanupManifest", manifestId);
		let op = manifest && library.read("operation", manifest.operationId);
		if (!manifest || manifest.kind !== "clear-work") throw fail("ASSET_CLEAR_PLAN_REQUIRED");
		if (!permits.has(op.operationId) || digest(confirmationToken || "") !== op.authorizationScope.confirmationHash) throw fail("ASSET_CONFIRMATION_REQUIRED");
		assertFrozenScope(op);
		if (executionLocks.has(op.operationId) || ["succeeded", "failed", "cancelled"].includes(op.operationState)) throw fail("ASSET_OPERATION_ALREADY_EXECUTING");
		executionLocks.add(op.operationId);
		try {
		await safeState(manifest.taskId, manifest.runId, [], op.operationId);
		const t = await transport(manifest.sourceLocation.environmentId);
		let root;
		try { root = await t.stat(manifest.sourceLocation.path); }
		catch (error) { if (!require("../transports/file-errors.cjs").isMissingFile(error, manifest.sourceLocation.path) || manifest.rootIdentity) throw error; root = null; }
		if (root ? !root.isDirectory || root.fileId !== manifest.rootIdentity?.fileId : manifest.rootIdentity) throw fail("ASSET_CLEAR_ROOT_CHANGED");
		const next = clone(manifest); let completed = 0, pending = [], cancelled = false;
		for (const item of next.items) {
			if (signal?.aborted) { cancelled = true; break; }
			try {
				await withArtifactReferences(library, item.originalLocation, item.artifactId, async () => {
				await safeState(manifest.taskId, manifest.runId, [item.artifactId], op.operationId);
				const current = await t.stat(item.path);
				if (!unchanged(item.identity, current)) throw fail("ASSET_DELETE_IDENTITY_CHANGED");
				if (!item.sha256) {
					if (item.hashAfterStop !== true || manifest.runActiveAtPreview !== true) throw fail("ASSET_CLEAR_HASH_REQUIRED");
					// Only unchanged confirmed files may receive a hash after a verified stop.
					const checked = await t.hash({ path: item.path, identity: current, algorithm: "sha256" });
					if (!unchanged(item.identity, checked.identity)) throw fail("ASSET_DELETE_IDENTITY_CHANGED");
					item.sha256 = checked.hash;
				}
				await t.removeFile({ path: item.path, identity: item.identity, sha256: item.sha256, scopeRoot: manifest.sourceLocation.path });
				});
				item.result = { state: "deleted", checkedAt: now(), logicalBytes: item.byteSize };
			} catch (error) { item.result = { state: "retained", error: error.code || String(error), checkedAt: now() }; }
			completed++; pending.push({ artifactId: item.artifactId, ...item.result });
			if (pending.length === EXECUTION_BATCH_ITEMS) {
				const progress = { completed, total: next.items.length, unit: "files" };
				op = update(op, "clearing-files", "running", pending, [], progress); pending = [];
				onProgress?.(progress); await yieldIO();
			}
		}
		const after = root ? await inventory(t, manifest.sourceLocation) : { files: [], exclusions: [] };
		const remaining = after.files.filter(file => !file.relativePath.endsWith("/.es-scratch-owner.json"));
		next.status = cancelled || next.items.some(item => item.result.state !== "deleted") || remaining.length || after.exclusions.length ? "partial" : "completed";
		next.revision++;
		const task = library.read("task", manifest.taskId), value = { ...task, requiredCapabilities: [...new Set([...(task.requiredCapabilities || []), "es:task-clear-work-v1"])], revision: task.revision + 1, workFileState: next.status === "completed" ? "cleared" : "unknown" };
		const progress = { completed, total: next.items.length, unit: "files" };
		op = update(op, "finished", cancelled ? "cancelled" : next.status === "completed" ? "succeeded" : "failed", pending, [mutation("cleanupManifest", manifestId, next, manifest.revision), mutation("task", task.taskId, value, task.revision)], progress);
		onProgress?.(progress);
		if (cancelled) throw fail("ASSET_CANCELLED");
		return next;
		} finally { executionLocks.delete(op.operationId); }
	}
	return { planClearWork, clearWork };
}
module.exports = { createClearWork };
