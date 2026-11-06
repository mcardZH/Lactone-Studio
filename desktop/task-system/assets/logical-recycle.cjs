"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { base, id } = require("./common.cjs");
const { fail } = require("./io.cjs");
const markers = require("../library/markers.cjs");
function createLogicalRecycle({
	library,
	libraryDirectory,
	begin,
	update,
	mutation,
	assertEndedMetadata,
	now
}) {
	function assertEnded(task) {
		if (task.latestRunId) assertEndedMetadata(task.taskId, task.latestRunId);
		else if (!task.sourceSetId || !library.read("sourceSet", task.sourceSetId))
			throw fail("ASSET_SOURCE_STATE_UNKNOWN");
	}
	function register({ manager, taskId, restoring = false }) {
		library.assertManager(manager);
		const task = library.read("task", taskId);
		if (!task || task.deleted) throw fail("TASK_NOT_FOUND");
		assertEnded(task);
		if (restoring ? task.recycleState !== "recycled" : task.recycleState === "recycled")
			throw fail("ASSET_RECYCLE_SCOPE_INVALID");
		const recycleId = restoring ? task.recycleId : id("recycle"),
			record = restoring ? library.read("recycleRecord", recycleId) : null;
		if (restoring && record?.mode !== "logical") throw fail("LEGACY_PHYSICAL_RESTORE_REQUIRED");
		const op = begin(
			manager,
			restoring ? "logical-restore" : "logical-recycle",
			[
				{ kind: "task", id: taskId },
				{ kind: "recycleRecord", id: recycleId }
			],
			{ task, recycleId, restoring, record, effects: "metadata-only-no-file-move" }
		);
		return { operationId: op.operationId };
	}
	async function execute({ operationId }) {
		// The registered permit owns the mutation after UI management is released.
		let op = library.read("operation", operationId);
		if (
			!op ||
			!["logical-recycle", "logical-restore"].includes(op.type) ||
			op.operationState !== "pending"
		)
			throw fail("ASSET_OPERATION_ALREADY_STARTED");
		const { task, recycleId, restoring, record } = op.authorizationScope;
		if (library.read("task", task.taskId)?.revision !== task.revision)
			throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
		assertEnded(task);
		op = update(op, "updating-registration", "running");
		const management = markers.management(task.management, !restoring);
		const markerUpdates = [];
		for (const location of task.locations || []) {
			if (!location.markerPath) continue;
			const file =
				location.scope === "library"
					? path.resolve(libraryDirectory, markers.relativePath(location.markerPath))
					: location.markerPath;
			if (!fs.existsSync(file)) continue;
			const current = markers.readMarker(file);
			if (
				current.value.id !== task.taskId ||
				(task.management &&
					markers.compareManagement(task.management, current.value.management) === "conflict")
			)
				throw fail("TASK_MARKER_MANAGEMENT_CONFLICT");
			markerUpdates.push({ file, current });
		}
		for (const { file, current } of markerUpdates)
			markers.writeMarker(file, { ...current.value, management }, current.identity);
		const next = {
			...task,
			revision: task.revision + 1,
			management,
			recycleState: restoring ? "active" : "recycled",
			recycleId,
			requiredCapabilities: [
				...new Set([...(task.requiredCapabilities || []), "es:task-logical-recycle-v1"])
			]
		};
		const value = {
			...(record || base()),
			revision: (record?.revision || 0) + 1,
			requiredCapabilities: ["es:task-logical-recycle-v1"],
			recycleId,
			taskId: task.taskId,
			runId: task.latestRunId,
			mode: "logical",
			artifactIds: [],
			originalGroupId: task.groupId || null,
			originalLocations: [],
			recycleLocations: [],
			cleanupRecordRef: null,
			files: [],
			management,
			status: restoring ? "restored" : "recycled",
			createdAt: record?.createdAt || now()
		};
		update(
			op,
			"finished",
			"succeeded",
			[{ taskId: task.taskId, state: value.status, filesMoved: 0 }],
			[
				mutation("task", task.taskId, next, task.revision),
				mutation("recycleRecord", recycleId, value, record?.revision ?? null)
			]
		);
		return value;
	}
	return {
		registerLogicalRecycle: (request) => register(request),
		registerLogicalRestore: (request) => register({ ...request, restoring: true }),
		executeRegisteredLogicalRecycle: execute
	};
}
module.exports = { createLogicalRecycle };
