"use strict";
const crypto = require("node:crypto");
const { fail } = require("../platform/global-settings.cjs");
function createOperations({
	store,
	manager,
	permits = new Map(),
	now = () => new Date().toISOString(),
	onChanged = () => {}
}) {
	function read(operationId) {
		const op = store.read("operation", operationId);
		if (!op) throw fail("OPERATION_NOT_FOUND");
		return {
			operationId,
			type: op.type,
			phase: op.phase,
			state: op.operationState,
			operationState: op.operationState,
			progress: op.progress
				? { ...op.progress, total: op.progress.total ?? null }
				: { completed: 0, total: null, unit: "tasks" },
			items: op.items || [],
			results: op.results || []
		};
	}
	function begin({ type, taskId, targets = [], scope = {}, phase = "intent-persisted" }) {
		const operationId = "operation-" + crypto.randomUUID();
		const value = {
			schemaVersion: 1,
			revision: 1,
			requiredCapabilities: [],
			operationId,
			type,
			targets: taskId && !targets.length ? [{ kind: "task", id: taskId }] : targets,
			preconditions: {},
			authorizationScope: scope,
			phase,
			operationState: "pending",
			results: [],
			items: scope.plannedItems || []
		};
		const registered = store.beginOperation({ manager: manager(), operation: value });
		permits.set(operationId, registered.permit);
		onChanged({ type: "operation-progress", operationId });
		return { operationId };
	}
	function change(operationId, patch, state) {
		const permit = permits.get(operationId);
		if (!permit) throw fail("OPERATION_OWNER_REQUIRED");
		const op = store.operationPermit(permit);
		if (["succeeded", "failed", "cancelled"].includes(op.operationState))
			throw fail("OPERATION_ALREADY_SETTLED");
		const progress =
			patch.completed === undefined
				? op.progress
				: {
						completed: patch.completed,
						...(patch.total === undefined ? {} : { total: patch.total }),
						unit: patch.unit || "files",
						observedAt: now()
					};
		if (
			progress &&
			(!Number.isFinite(progress.completed) ||
				progress.completed < 0 ||
				(progress.total !== undefined &&
					progress.total !== null &&
					(!Number.isFinite(progress.total) || progress.total < progress.completed)))
		)
			throw fail("OPERATION_PROGRESS_INVALID", progress);
		const next = {
			...op,
			revision: op.revision + 1,
			phase: patch.phase || op.phase,
			operationState: state,
			...(progress ? { progress } : {}),
			...(patch.items ? { items: patch.items } : {}),
			results: [...op.results, ...(patch.results || [])],
			transitionEvidence: {
				type:
					state === "succeeded"
						? "operation-complete"
						: state === "partial"
							? "operation-partial"
							: "verification",
				checkedAt: now(),
				evidenceRefs: ["operation:" + operationId + ":" + (patch.phase || op.phase)]
			}
		};
		store.commitOperation({
			permit,
			expectedRevision: op.revision,
			operation: JSON.parse(JSON.stringify(next))
		});
		onChanged({ type: "operation-progress", operationId });
	}
	return {
		begin,
		read,
		commitRecords(id, mutations) {
			const permit = permits.get(id);
			if (!permit) throw fail("OPERATION_OWNER_REQUIRED");
			const op = store.operationPermit(permit);
			return store.commitOperation({
				permit,
				expectedRevision: op.revision,
				operation: { ...op, revision: op.revision + 1 },
				mutations
			});
		},
		update(id, patch) {
			change(id, patch, "running");
		},
		complete(id, patch = {}) {
			const items = patch.items || [];
			const state = items.some((row) => row.outcome === "failed" || row.outcome === "not-executed")
				? "partial"
				: "succeeded";
			change(id, { ...patch, phase: "finished" }, state);
		},
		fail(id, error, patch = {}) {
			change(
				id,
				{
					...patch,
					phase: "failed",
					results: [
						...(patch.results || []),
						{ error: error.code || error.message || String(error) }
					]
				},
				"failed"
			);
		}
	};
}
module.exports = { createOperations };
