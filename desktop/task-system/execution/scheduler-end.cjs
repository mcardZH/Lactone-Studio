"use strict";

const SCHEDULER_END_CAPABILITY = "es:task-slurm-scheduler-end-v1";
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL",
	"OUT_OF_MEMORY", "PREEMPTED", "BOOT_FAIL", "DEADLINE", "REVOKED"]);
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value);

function schedulerTerminalAccounting(rows, identity, workPath) {
	if (!Array.isArray(rows) || !/^\d+$/.test(identity?.jobId)) return null;
	const ids = new Set();
	for (const row of rows) {
		if (!Array.isArray(row) || row.length !== 9 || typeof row[0] !== "string" ||
			(row[0] !== identity.jobId && !row[0].startsWith(identity.jobId + ".")) ||
			ids.has(row[0]) || (row[1] && row[1] !== identity.userId) ||
			!TERMINAL.has(row[2]?.split(/[ +]/)[0]) || !/^\d+:\d+$/.test(row[3]) ||
			!timestamp(row[6]) || !row[7] || (identity.cluster && row[7] !== identity.cluster)) return null;
		ids.add(row[0]);
	}
	const parent = rows.find(row => row[0] === identity.jobId);
	if (!parent || parent[1] !== identity.userId || parent[8] !== workPath || !timestamp(parent[4]) ||
		rows.some(row => row[7] !== parent[7])) return null;
	const started = timestamp(parent[5]);
	if (started && !ids.has(identity.jobId + ".batch")) return null;
	if (!started && (!["Unknown", "None", ""].includes(parent[5]) || rows.length !== 1)) return null;
	return parent;
}

function matchesSchedulerEndReceipt(run, receipt) {
	const execution = run?.executionIdentity, payload = receipt?.payload, identity = payload?.schedulerIdentity;
	const scheduler = run?.environmentSnapshot?.scheduler;
	const known = execution?.launchIdentity;
	const binding = payload?.binding;
	const boundToSubmission = binding?.kind === "durable-submit-action"
		? !!run?.submitOperationId && binding.operationId === run.submitOperationId
		: binding?.kind === "exact-accounting-comment" && !!execution?.submissionIntentId &&
			binding.comment === `es-intent:${execution.submissionIntentId}`;
	return !!(receipt?.eventType === "run.scheduler-ended" &&
		boundToSubmission &&
		receipt.requiredCapabilities?.includes(SCHEDULER_END_CAPABILITY) &&
		receipt.taskId === run?.taskId && receipt.runId === run.runId &&
		receipt.operationId === run.submitOperationId &&
		receipt.submissionIntentId === execution.submissionIntentId &&
		scheduler?.kind === "slurm" && identity?.siteId && identity.siteId === scheduler.siteId &&
		identity.userId && identity.userId === scheduler.user &&
		identity.submissionIntentId === execution.submissionIntentId &&
		(!known?.jobId || (known.jobId === identity.jobId && known.siteId === identity.siteId &&
			known.userId === identity.userId && (!known.cluster || known.cluster === identity.cluster))) &&
		payload.manifestHash && payload.manifestHash === execution.executorIdentity?.manifestHash &&
		payload.workPath === execution.workLocation?.path && payload.queueAbsent === true &&
		schedulerTerminalAccounting(payload.accountingRows, identity, payload.workPath));
}

function verifiedOwnerEndReceipt(run) {
	if (run?.state.executionState !== "ended" || run.state.verificationState !== "verified") return null;
	const execution = run.executionIdentity;
	return execution.endReceipt || (run.requiredCapabilities?.includes(SCHEDULER_END_CAPABILITY) &&
		matchesSchedulerEndReceipt(run, execution.schedulerEndReceipt)
		? execution.schedulerEndReceipt : null);
}

function schedulerPreparationFailure(run, operation, receipt, checkedAt) {
	const evidenceRefs = receipt.evidenceRefs;
	return {
		preparationState: { ...run.resultPreparationState, operationId: operation.operationId, state: "ended",
			reason: "调度分配已结束，缺少可核实的原生结果准备终态回执" },
		operation: { ...operation, revision: operation.revision + 1, operationState: "failed",
			phase: "scheduler-ended-preparation-unverified",
			transitionEvidence: { type: "verification", checkedAt, evidenceRefs },
			results: [...operation.results, { code: "SLURM_PREPARATION_RECEIPT_MISSING", schedulerEndReceiptId: receipt.receiptId, evidenceRefs }] }
	};
}

module.exports = { SCHEDULER_END_CAPABILITY, schedulerTerminalAccounting, matchesSchedulerEndReceipt,
	verifiedOwnerEndReceipt, schedulerPreparationFailure };
