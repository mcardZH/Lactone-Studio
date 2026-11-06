"use strict";
const { fail } = require("./platform/global-settings.cjs");
const { operationRuns } = require("./operation-guards.cjs");
const { verifiedStopDisposition } = require("./projections.cjs");
function page(value, fallback) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > 200)
		throw fail("EVIDENCE_PAGE_INVALID");
	return Math.min(199, result);
}
function offset(value) {
	const result = value ?? 0;
	if (!Number.isSafeInteger(result) || result < 0) throw fail("EVIDENCE_OFFSET_INVALID");
	return result;
}
function readExecutionEvidence(store, input, now = () => new Date().toISOString()) {
	const task = store.read("task", input.taskId);
	if (!task) throw fail("TASK_NOT_FOUND");
	const runId = input.runId || task.latestRunId,
		run = store.read("run", runId);
	if (!run || run.taskId !== task.taskId) throw fail("EVIDENCE_RUN_TASK_MISMATCH");
	const operationOffset = offset(input.operationOffset),
		operationLimit = page(input.operationLimit, 50),
		receiptOffset = offset(input.receiptOffset),
		receiptLimit = page(input.receiptLimit, 50);
	const candidates = store.list("operation", {
			offset: operationOffset,
			limit: operationLimit + 1
		}),
		consumed = candidates.slice(0, operationLimit),
		operations = [];
	for (const operation of consumed) {
		if (["migrate-library", "self-check-recovery"].includes(operation.type)) continue;
		const runs = operationRuns(store, operation);
		if (runs.has(runId) && runs.size === 1) operations.push(operation);
	}
	const receipts = store.listExecutionReceipts({
			taskId: task.taskId,
			runId,
			offset: receiptOffset,
			limit: receiptLimit + 1
		}),
		executionReceipts = receipts.slice(0, receiptLimit),
		snapshot = store.read("inputSnapshot", run.inputSnapshotId),
		stopDisposition = verifiedStopDisposition(store, run);
	return {
		libraryId: store.describe().libraryId,
		taskId: task.taskId,
		runId,
		observedAt: now(),
		run: {
			executionIdentity: run.executionIdentity,
			state: run.state,
			...(stopDisposition ? { stopDisposition } : {}),
			softwareSnapshot: run.softwareSnapshot,
			environmentSnapshot: run.environmentSnapshot,
			inputSnapshotId: run.inputSnapshotId,
			resources: run.resources || null,
			resultPreparationState: run.resultPreparationState || null
		},
		inputSnapshot: snapshot
			? {
					inputSnapshotId: snapshot.inputSnapshotId,
					contentIdentity: snapshot.contentIdentity,
					primaryInputArtifactId: snapshot.primaryInputArtifactId,
					dependencies: snapshot.dependencies,
					parsedRequests: snapshot.parsedRequests,
					engineExtensions: snapshot.engineExtensions
				}
			: null,
		operations,
		operationPage: {
			nextOffset: operationOffset + consumed.length,
			hasMore: candidates.length > consumed.length,
			scanned: candidates.length
		},
		executionReceipts,
		receiptPage: {
			nextOffset: receiptOffset + executionReceipts.length,
			hasMore: receipts.length > executionReceipts.length
		}
	};
}
module.exports = { readExecutionEvidence };
