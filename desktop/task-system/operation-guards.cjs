"use strict";
const { isDeepStrictEqual } = require("node:util");
const FILE_TYPES = new Set([
	"archive",
	"cleanup",
	"cleanup-original",
	"recycle",
	"restore",
	"empty-trash",
	"cleanup-archive",
	"delete-task",
	"overwrite-task",
	"result-adoption",
	"postprocess-source-save",
	"postprocess-cache-save",
	"postprocess-cache-delete"
]);
const terminal = (value) => ["succeeded", "failed", "cancelled"].includes(value);
function* recordPages(store, kind, filter = {}) {
	if (typeof store.iterate === "function") {
		let page = [];
		for (const record of store.iterate(kind, filter)) {
			page.push(record);
			if (page.length === 1000) { yield page; page = []; }
		}
		if (page.length) yield page;
		return;
	}
	for (let offset = 0; ; offset += 1000) {
		const batch = store.list(kind, { ...filter, limit: 1000, offset });
		if (batch.length) yield batch;
		if (batch.length !== 1000) return;
	}
}
function* iterateRecords(store, kind, filter = {}) {
	for (const page of recordPages(store, kind, filter)) yield* page;
}
function listAll(store, kind, filter = {}) {
	return Array.from(iterateRecords(store, kind, filter));
}
function operationRuns(store, operation) {
	const ids = new Set(),
		scope = operation.authorizationScope || {};
	for (const value of [
		scope,
		scope.manifest,
		scope.record,
		scope.archive,
		...(scope.entries || [])
	])
		if (value?.runId) ids.add(value.runId);
	for (const target of operation.targets) {
		if (target.kind === "run") ids.add(target.id);
		else if (
			["artifact", "archiveManifest", "cleanupManifest", "recycleRecord"].includes(target.kind)
		) {
			const record = store.read(target.kind, target.id);
			if (record?.runId) ids.add(record.runId);
		}
	}
	if (scope.archiveManifestId) {
		const archive = store.read("archiveManifest", scope.archiveManifestId);
		if (archive?.runId) ids.add(archive.runId);
	}
	if (scope.recycleId) {
		const record = store.read("recycleRecord", scope.recycleId);
		if (record?.runId) ids.add(record.runId);
	}
	return ids;
}
function isPotentialFileIO(operation, migration = false) {
	if (terminal(operation.operationState)) return false;
	if (["awaiting-confirmation", "tool-capability-unavailable"].includes(operation.phase))
		return false;
	if (operation.type === "result-adoption" && ["awaiting-execution-end", "application-closed", "library-detached", "exit-requested"].includes(operation.phase)) return false;
	return (
		FILE_TYPES.has(operation.type) ||
		(migration &&
			operation.type === "submit" &&
			(!operation.phase.startsWith("submit:") || operation.phase === "submit:dispatching"))
	);
}
function restoreFileIOSettlement(operation) {
	if (
		operation.type !== "restore" ||
		operation.operationState !== "partial" ||
		!["finished", "conflicts", "restore-file-io-reconciled"].includes(operation.phase) ||
		!operation.owner?.instanceId ||
		!Number.isSafeInteger(operation.owner.pid) ||
		operation.owner.pid <= 0 ||
		!Number.isFinite(Date.parse(operation.owner.startedAt)) ||
		!Array.isArray(operation.results)
	)
		return null;
	const scope = operation.authorizationScope || {},
		record = scope.record,
		archive = scope.archive;
	if (
		!record ||
		!archive ||
		!Array.isArray(record.files) ||
		!Number.isSafeInteger(record.revision) ||
		!Number.isSafeInteger(archive.revision) ||
		scope.recycleId !== record.recycleId ||
		record.archiveManifestId !== archive.manifestId
	)
		return null;
	return (
		[...operation.results].reverse().find(
			(receipt) =>
				receipt.kind === "restore-file-io-settlement-v1" &&
				receipt.operationId === operation.operationId &&
				receipt.taskId === record.taskId &&
				receipt.runId === record.runId &&
				receipt.recycleId === record.recycleId &&
				isDeepStrictEqual(receipt.owner, operation.owner) &&
				receipt.fileIOState === "released" &&
				(receipt.sideEffectState === "settled" ||
					(receipt.sideEffectState === "not-started" &&
						receipt.source === "restore-executor" &&
						receipt.recordRevision === record.revision &&
						receipt.archiveManifestRevision === archive.revision &&
						isDeepStrictEqual(receipt.remainingFiles, record.files))) &&
				((receipt.source === "restore-executor" &&
					["finished", "conflicts"].includes(operation.phase) &&
					receipt.outcome === "partial-path-conflict" &&
					Array.isArray(receipt.conflicts) &&
					receipt.conflicts.length > 0 &&
					receipt.conflicts.every((item) => item.error === "ASSET_RESTORE_PATH_CONFLICT")) ||
					(receipt.source === "manager-repair" &&
						operation.phase === "restore-file-io-reconciled" &&
						receipt.outcome === "partial-remainder-verified")) &&
				Number.isFinite(Date.parse(receipt.settledAt)) &&
				Array.isArray(receipt.evidenceRefs) &&
				receipt.evidenceRefs.length > 0 &&
				receipt.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0) &&
				Number.isSafeInteger(receipt.recordRevision) &&
				receipt.recordRevision >= record.revision &&
				Number.isSafeInteger(receipt.archiveManifestRevision) &&
				receipt.archiveManifestRevision >= archive.revision &&
				Array.isArray(receipt.remainingArtifactIds) &&
				receipt.remainingArtifactIds.length > 0 &&
				Array.isArray(receipt.remainingFiles) &&
				isDeepStrictEqual(
					receipt.remainingFiles.map((file) => file.artifactId).sort(),
					[...receipt.remainingArtifactIds].sort()
				) &&
				receipt.remainingFiles.every((file) =>
					isDeepStrictEqual(
						file,
						record.files.find((old) => old.artifactId === file.artifactId)
					)
				) &&
				new Set(receipt.remainingArtifactIds).size === receipt.remainingArtifactIds.length &&
				receipt.remainingArtifactIds.every((id) =>
					record.files.some((file) => file.artifactId === id)
				) &&
				(receipt.source !== "restore-executor" ||
					isDeepStrictEqual(
						[...receipt.remainingArtifactIds].sort(),
						[...receipt.conflicts.map((item) => item.artifactId)].sort()
					))
		) || null
	);
}
function releasedRestoreFileIO(operation, owner) {
	// This proves only the historical operation has released IO. Each new operation
	// still verifies its own frozen scope, current records and IO admission separately.
	return Boolean(restoreFileIOSettlement(operation) && isDeepStrictEqual(operation.owner, owner));
}
async function competingFileOperations({
	store,
	probe,
	runId,
	taskId,
	operationId,
	admissionOwner,
	migration = false
}) {
	const blocked = [];
	const current = operationId ? store.read("operation", operationId) : null;
	for (const operation of iterateRecords(store, "operation")) {
		if (operation.operationId === operationId || !isPotentialFileIO(operation, migration)) continue;
		const runs = operationRuns(store, operation);
		if (
			!migration &&
			!runs.has(runId) &&
			operation.authorizationScope.taskId !== taskId &&
			!operation.targets.some((target) => target.kind === "task" && target.id === taskId)
		)
			continue;
		const requestingOwner = current?.owner || admissionOwner;
		if (
			(!current ||
				FILE_TYPES.has(current.type) ||
				(migration && current.type === "migrate-library")) &&
			releasedRestoreFileIO(operation, requestingOwner)
		)
			continue;
		const status = operation.owner ? await probe(operation.owner) : "unknown";
		if (status !== "dead")
			blocked.push({
				operationId: operation.operationId,
				type: operation.type,
				ownerState: status,
				phase: operation.phase
			});
	}
	return blocked;
}

function isDeletedTaskOperation(store, operation) {
	const ids = new Set();
	for (const target of operation.targets || []) {
		if (target.kind === "task") ids.add(target.id);
		if (target.kind === "run") {
			const run = store.read("run", target.id);
			if (run) ids.add(run.taskId);
		}
	}
	if (operation.authorizationScope?.taskId) ids.add(operation.authorizationScope.taskId);
	return ids.size > 0 && [...ids].every((id) => store.read("task", id)?.deleted === true);
}
module.exports = {
	isDeletedTaskOperation,
	listAll,
	recordPages,
	iterateRecords,
	competingFileOperations,
	operationRuns,
	isPotentialFileIO,
	restoreFileIOSettlement,
	releasedRestoreFileIO
};
