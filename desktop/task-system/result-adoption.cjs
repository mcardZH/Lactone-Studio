"use strict";
const { verifiedOwnerEndReceipt } = require("./execution/scheduler-end.cjs");
const crypto = require("node:crypto");
const { fail } = require("./platform/global-settings.cjs");
const TYPE = "result-adoption";
const CAPABILITY = "es:task-result-adoption-v1";
const terminal = operation => ["succeeded", "failed", "cancelled"].includes(operation?.operationState);
/** A submitted Run's restricted continuation, never an invisible UI manager. */
function createResultAdoption({ store, manager, monitoring, effective, locationEpoch, settings, registry, rememberOperation, track = promise => promise.catch(() => {}), now = () => new Date().toISOString(), onChanged = () => {}, onError = () => {} }) {
	const entries = new Map(); let closed = false;
	const key = runId => `${store.describe().libraryId}:${runId}`;
	function update(entry, phase, state, mutations = [], result) {
		const old = store.operationPermit(entry.permit);
		return store.commitOperation({ permit: entry.permit, expectedRevision: old.revision, operation: { ...old, revision: old.revision + 1, phase, operationState: state, results: [...old.results, ...(result ? [result] : [])], transitionEvidence: { type: state === "succeeded" ? "operation-complete" : state === "cancelled" ? "not-started" : "verification", checkedAt: now(), evidenceRefs: [`operation:${old.operationId}:${phase}`] } }, mutations }).operation;
	}
	function current(entry) {
		if (closed || entry.suspended || !effective()) return false;
		const run = store.read("run", entry.runId), task = run && store.read("task", run.taskId), operation = store.operationPermit(entry.permit);
		return !!task && !task.deleted && !task.resultsInvalidatedByOverwrite && task.workFileState !== "cleared" && task.latestRunId === entry.runId && run.inputSnapshotId === operation.authorizationScope.inputSnapshotId && run.executionIdentity.submissionIntentId === operation.authorizationScope.submissionIntentId && locationEpoch() === operation.authorizationScope.locationEpoch;
	}
	function authority(entry) {
		const op = store.operationPermit(entry.permit);
		return { operationId: op.operationId, runId: entry.runId, permit: entry.permit, instanceId: op.owner.instanceId, epoch: op.preconditions.managerEpoch,
			didPrepare(prepared) { entry.preparedResult = { collectionId: prepared.collectionId, revision: String(prepared.revision) }; },
			assert() { if (!current(entry)) throw fail("RESULT_ADOPTION_SOURCE_CHANGED"); return this; },
			commit(mutations, receipt) { this.assert(); return update(entry, store.operationPermit(entry.permit).phase, "running", mutations, receipt ? { adoptedReceiptId: receipt.receiptId } : undefined); },
			applied(receiptId) { return store.read("operation", entry.operationId)?.results.some(result => result.adoptedReceiptId === receiptId); }
		};
	}
	function interval(run) {
		const config = settings.read().value.monitoring;
		return (run?.environmentSnapshot.connection.kind === "ssh" || run?.environmentSnapshot.scheduler.kind === "slurm" ? config.remoteIntervalSeconds : config.localIntervalSeconds) * 1000;
	}
	function schedule(entry, milliseconds = 0) {
		if (closed || entry.suspended || entry.timer || entry.pending || terminal(store.read("operation", entry.operationId))) return;
		entry.timer = setTimeout(() => { entry.timer = null; const pending = step(entry); entry.pending = pending; track(pending); pending.finally(() => { entry.pending = null; const run = store.read("run", entry.runId); if (!closed && !entry.suspended && !terminal(store.read("operation", entry.operationId))) schedule(entry, interval(run)); }).catch(() => {}); }, milliseconds);
		entry.timer.unref?.();
	}
	async function step(entry) {
		try {
			if (!current(entry)) { if (!closed && effective()) update(entry, "source-invalidated", "cancelled"); return; }
			const access = authority(entry);
			await monitoring.continueOperation(access, entry.taskId, false);
			if (!current(entry)) return;
			const run = store.read("run", entry.runId);
			const ownerEnd = verifiedOwnerEndReceipt(run);
			if (!ownerEnd || require("./stop-control.cjs").activePreparation(store, entry.runId)) return;
			if (ownerEnd.payload?.notStarted === true) { update(entry, "native-not-started", "cancelled"); return; }
			entry.finalPreparing = true;
			update(entry, "final-preparation", "running");
			await Promise.allSettled([...(registry.get(key(entry.runId))?.displayWork || [])]);
			if (!current(entry)) return;
			entry.preparedResult = null;
			await monitoring.continueOperation(access, entry.taskId, true);
			if (!current(entry)) return;
			const publication = monitoring.preparedPublication(entry.taskId, entry.runId);
			if (!publication?.prepared || publication.collectionId !== entry.preparedResult?.collectionId || publication.revision !== entry.preparedResult?.revision) { update(entry, "final-preparation-unavailable", "failed", [], { code: "RESULT_ADOPTION_NOT_PREPARED", reason: "实际终态已接管，但结果尚不能准备为可浏览版本" }); return; }
			entry.retained = true;
			update(entry, "final-publication-ready", "succeeded", [], { collectionId: publication.collectionId, revision: publication.revision, sourceRevision: publication.sourceRevision, frameCount: publication.frameCount });
			onChanged({ type: "result-adoption-ready", taskId: entry.taskId, runId: entry.runId, collectionId: publication.collectionId, revision: publication.revision });
		} catch (error) {
			if (!closed && !entry.suspended) {
				try { if (effective()) update(entry, "adoption-needs-verification", "waiting-verification", [], { code: error.code || "RESULT_ADOPTION_FAILED" }); } catch {}
				entry.suspended = true;
				onError({ taskId: entry.taskId, runId: entry.runId, code: error.code || "RESULT_ADOPTION_FAILED" });
			}
		} finally { entry.finalPreparing = false; }
	}
	function install(registered, run) {
		const entry = { runId: run.runId, taskId: run.taskId, operationId: registered.operation.operationId, permit: registered.permit, timer: null, pending: null, suspended: false, retained: false, finalPreparing: false };
		entries.set(run.runId, entry); registry.set(key(run.runId), { owner: api, entry, displayWork: new Set() }); rememberOperation(registered); schedule(entry); return entry;
	}
	function register({ taskId, runId }) {
		const existing = registry.get(key(runId)); if (existing) return existing.entry.operationId;
		const run = store.read("run", runId), task = store.read("task", taskId);
		if (!run || task?.latestRunId !== runId) throw fail("RESULT_ADOPTION_RUN_MISMATCH");
		if (run.resultAdoptionOperationId) return run.resultAdoptionOperationId;
		const required = store.describe().requiredCapabilities || [];
		if (!required.includes(CAPABILITY)) store.requireCapabilities({ manager: manager(), requiredCapabilities: [...required, CAPABILITY] });
		const operationId = "adopt-" + crypto.randomUUID();
		const targets = [{ kind: "task", id: taskId }, { kind: "run", id: runId }, ...store.list("artifact", { runId }).map(artifact => ({ kind: "artifact", id: artifact.artifactId })), ...[run.submitOperationId, run.preparationOperationId].filter(Boolean).map(id => ({ kind: "operation", id }))];
		const registered = store.beginOperation({ manager: manager(), operation: { schemaVersion: 1, revision: 1, requiredCapabilities: [CAPABILITY], operationId, type: TYPE, targets, preconditions: {}, authorizationScope: { taskId, runId, inputSnapshotId: run.inputSnapshotId, submissionIntentId: run.executionIdentity.submissionIntentId, locationEpoch: locationEpoch() }, phase: "awaiting-execution-end", operationState: "pending", results: [] }, mutations: [{ kind: "run", id: runId, expectedRevision: run.revision, value: { ...run, revision: run.revision + 1, requiredCapabilities: [...new Set([...(run.requiredCapabilities || []), CAPABILITY])], resultAdoptionOperationId: operationId } }] });
		install(registered, store.read("run", runId)); return operationId;
	}
	async function recover() {
		for (const operation of store.list("operation").filter(operation => operation.type === TYPE && !terminal(operation))) {
			const run = store.read("run", operation.authorizationScope.runId), task = run && store.read("task", run.taskId);
			if (!run || task?.latestRunId !== run.runId || registry.has(key(run.runId))) continue;
			try { const registered = await store.resumeOperation({ manager: manager(), operationId: operation.operationId, expectedRevision: operation.revision, evidence: { sideEffectState: operation.results.some(result => result.adoptedReceiptId) ? "partial" : "not-occurred", checkedAt: now(), evidenceRefs: [`run:${run.runId}:persisted-result-adoption`] } }); install(registered, run); } catch (error) { if (error.code !== "OPERATION_OWNER_NOT_DEAD") onError({ taskId: run.taskId, runId: run.runId, code: error.code }); }
		}
	}
	async function suspend(reason = "application-closed") {
		closed = true;
		for (const entry of entries.values()) { entry.suspended = true; clearTimeout(entry.timer); entry.timer = null; monitoring.cancelOperation(entry.operationId); }
		await Promise.allSettled([...entries.values()].map(entry => entry.pending).filter(Boolean));
		for (const entry of entries.values()) { try { if (!terminal(store.read("operation", entry.operationId)) && effective()) update(entry, reason, "waiting-verification"); } catch {} registry.delete(key(entry.runId)); }
	}
	const api = { register, recover, suspend,
		resume() { closed = false; monitoring.resumeOperations(); for (const entry of entries.values()) if (!terminal(store.read("operation", entry.operationId))) { entry.suspended = false; registry.set(key(entry.runId), { owner: api, entry, displayWork: new Set() }); schedule(entry); } },
		hasPending() { return !closed && [...entries.values()].some(entry => !entry.suspended && !terminal(store.read("operation", entry.operationId))); },
		pinned(taskId) { const task = store.read("task", taskId); return !!task && !task.deleted && !task.resultsInvalidatedByOverwrite && task.workFileState !== "cleared" && [...entries.values()].some(entry => entry.taskId === taskId && task.latestRunId === entry.runId && !closed && (entry.retained || !terminal(store.read("operation", entry.operationId)))); },
		trackDisplay(taskId, promise) { const runId = store.read("task", taskId)?.latestRunId, shared = registry.get(key(runId)); if (shared) { shared.displayWork.add(promise); promise.finally(() => shared.displayWork.delete(promise)).catch(() => {}); } },
		finalPreparation(taskId) { const entry = registry.get(key(store.read("task", taskId)?.latestRunId))?.entry; return entry?.finalPreparing ? entry.pending : null; }
	};
	return api;
}
module.exports = { createResultAdoption, RESULT_ADOPTION_TYPE: TYPE };
