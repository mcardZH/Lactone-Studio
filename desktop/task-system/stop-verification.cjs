"use strict";
const { classifyEndReceipt } = require("./end-receipts.cjs");
const { matchesSchedulerEndReceipt, verifiedOwnerEndReceipt, schedulerPreparationFailure } = require("./execution/scheduler-end.cjs");
const { fail } = require("./platform/global-settings.cjs");
/** Operation-owned observation; it never sends a second stop or resubmits a run. */
async function verifyStoppedRun({
	store,
	runId,
	inspect,
	commitRecords,
	timeoutMs = 10000,
	now = () => new Date().toISOString()
}) {
	const started = performance.now();
	do {
		const before = store.read("run", runId);
		if (!before) throw fail("STOP_RUN_IDENTITY_MISSING");
		const response = await inspect(before),
			current = store.read("run", runId),
			receipts = store.listExecutionReceipts({ runId });
		if (
			!current ||
			current.taskId !== before.taskId ||
			current.executionIdentity.submissionIntentId !== before.executionIdentity.submissionIntentId
		)
			throw fail("STOP_RUN_IDENTITY_CHANGED");
		const mutations = [];
		let next = current;
		const schedulerEnd = receipts.find(receipt => matchesSchedulerEndReceipt(current, receipt));
		if (current.state.executionState !== "ended" ||
			(!current.executionIdentity.endReceipt && !current.executionIdentity.schedulerEndReceipt &&
				current.environmentSnapshot?.scheduler.kind === "slurm")) {
			const end = receipts
				.filter(
					(receipt) =>
						receipt.eventType === "run.ended" &&
						receipt.payload?.processTree &&
						(receipt.payload.processTree.verified === true ||
							receipt.payload.processTree.treeEnded === true) &&
						(!Object.hasOwn(receipt.payload.processTree, "activeProcesses") ||
							receipt.payload.processTree.activeProcesses === 0)
				)
				.find((receipt) => classifyEndReceipt(current, receipt).kind !== "conflict") || schedulerEnd;
			if (end) {
				const evidence = { type: "ended", checkedAt: now(), evidenceRefs: end.evidenceRefs };
				next = {
					...current,
					revision: current.revision + 1,
					executionIdentity: {
						...current.executionIdentity,
						...(end.eventType === "run.scheduler-ended" ? { schedulerEndReceipt: end }
							: { endReceipt: current.executionIdentity.endReceipt || end })
					},
					state: {
						...current.state,
						executionState: "ended",
						verificationState: "verified",
						endReason: current.state.executionState === "ended" ? current.state.endReason :
							end.payload.endReason || response.actualState?.endReason || "unknown",
						checkedAt: now(),
						evidenceRefs: end.evidenceRefs
					},
					transitionEvidence: evidence
				};
			}
		}
		const settledPreparations = new Set();
		for (const receipt of receipts.filter(
			(row) => row.eventType === "operation.preparation-ended"
		)) {
			const operation = store.read("operation", receipt.operationId);
			if (!operation || settledPreparations.has(operation.operationId) ||
				["succeeded", "failed", "cancelled"].includes(operation.operationState))
				continue;
			const tree = receipt.payload.end?.processTree,
				notStarted = receipt.payload.notStarted === true,
				stopped = receipt.payload.cancelled === true || tree?.stopRequested === true || tree?.evidence?.stopRequested === true;
			if (!notStarted && tree?.verified !== true && tree?.treeEnded !== true) continue;
			settledPreparations.add(operation.operationId);
			if (operation.operationId === current.preparationOperationId) {
				next = { ...next, revision: current.revision + 1, resultPreparationState: {
					...next.resultPreparationState, operationId: operation.operationId,
					state: notStarted ? "not-started" : "ended", endReceipt: receipt
				} };
			}
			mutations.push({
				kind: "operation",
				id: operation.operationId,
				expectedRevision: operation.revision,
				value: {
					...operation,
					revision: operation.revision + 1,
					phase: stopped ? "stop-verified-preparation-ended" : "verified-preparation-ended",
					operationState: notStarted
						? "cancelled"
						: receipt.payload.succeeded
							? "succeeded"
							: "failed",
					transitionEvidence: {
						type: notStarted
							? "not-started"
							: receipt.payload.succeeded
								? "operation-complete"
								: "verification",
						checkedAt: now(),
						evidenceRefs: receipt.evidenceRefs
					},
					// Observing END after a Stop request does not prove Stop caused END.
					results: [...operation.results, { receiptId: receipt.receiptId, verifiedEnded: true, ...(stopped ? { stopped: true } : {}) }]
				}
			});
		}
		const preparation = current.preparationOperationId && store.read("operation", current.preparationOperationId);
		if (schedulerEnd && verifiedOwnerEndReceipt(next) && preparation?.type === "result-preparation" &&
			!["succeeded", "failed", "cancelled"].includes(preparation.operationState) &&
			!settledPreparations.has(preparation.operationId)) {
			const failure = schedulerPreparationFailure(next, preparation, schedulerEnd, now());
			next = { ...next, revision: current.revision + 1, resultPreparationState: failure.preparationState };
			mutations.push({ kind: "operation", id: preparation.operationId, expectedRevision: preparation.revision, value: failure.operation });
		}
		if (next !== current)
			mutations.push({ kind: "run", id: runId, expectedRevision: current.revision, value: next });
		if (mutations.length) commitRecords(mutations);
		const observed = store.read("run", runId),
			pending = require("./exit.cjs").activePreparation(store, runId);
		if (
			observed.state.executionState === "ended" &&
			observed.state.verificationState === "verified" &&
			verifiedOwnerEndReceipt(observed) &&
			!pending &&
			response.payload?.preparationPending !== true
		)
			return { verified: true };
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (performance.now() - started < timeoutMs);
	return { verified: false };
}
module.exports = { verifyStoppedRun };
