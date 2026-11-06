"use strict";
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])])
		);
	return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function launchProof(receipt) {
	const tree = receipt?.payload?.processTree;
	return tree?.identity || tree?.evidence?.identity || receipt?.payload?.identity || null;
}
function strongLaunch(identity) {
	const birth = identity?.creationFileTime ?? identity?.startTicks;
	return (
		!!identity &&
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		!!identity.bootId &&
		((typeof birth === "string" && /^\d+$/.test(birth)) ||
			(Number.isSafeInteger(birth) && birth >= 0))
	);
}
function treeEnded(receipt) {
	const tree = receipt?.payload?.processTree;
	if (!tree || !(tree.verified === true || tree.treeEnded === true)) return false;
	for (const item of [tree, tree.evidence, tree.evidence?.evidence])
		if (item?.activeProcesses !== undefined && item.activeProcesses !== 0) return false;
	return true;
}
const known = (value) => value !== undefined && value !== null && value !== "unknown";
/** A durable launch record can fill missing metadata after END, but an END
 * observation cannot supply its own independent launch anchor. */
function endedLaunchIdentity(run, receipt) {
	const execution = run.executionIdentity, end = execution.endReceipt,
		identity = receipt?.payload?.identity || receipt?.payload?.launchIdentity;
	if (run.state.executionState !== "ended" || !end || end.payload?.notStarted === true ||
		receipt?.eventType !== "run.launched" || receipt.managerEpoch !== undefined || receipt.sourceRevision !== undefined ||
		receipt.taskId !== run.taskId || receipt.runId !== run.runId || receipt.submissionIntentId !== execution.submissionIntentId ||
		receipt.operationId !== end.operationId || (run.submitOperationId && receipt.operationId !== run.submitOperationId) ||
		end.taskId !== run.taskId || end.runId !== run.runId || end.submissionIntentId !== execution.submissionIntentId ||
		!strongLaunch(identity) || !treeEnded(end) || !same(launchProof(end), identity) ||
		(execution.launchIdentity && !same(execution.launchIdentity, identity)) ||
		(execution.launchReceipt && !same(execution.launchReceipt, receipt))) return null;
	return {
		...execution,
		launchIdentity: execution.launchIdentity || identity,
		launchReceipt: execution.launchReceipt || receipt,
		fieldStatus: { ...execution.fieldStatus,
			launchIdentity: { state: "known", evidenceRefs: receipt.evidenceRefs },
			launchReceipt: { state: "known", evidenceRefs: receipt.evidenceRefs } }
	};
}
/** Reconcile evidence, never replace a frozen executionIdentity anchor. */
function classifyEndReceipt(run, receipt) {
	const anchor = run.executionIdentity.endReceipt,
		launch = run.executionIdentity.launchIdentity;
	const conflict = (code, field) => ({
		kind: "conflict",
		code,
		field,
		anchorReceiptId: anchor?.receiptId || null
	});
	if (
		receipt.taskId !== run.taskId ||
		receipt.runId !== run.runId ||
		receipt.submissionIntentId !== run.executionIdentity.submissionIntentId ||
		(run.submitOperationId && receipt.operationId !== run.submitOperationId)
	)
		return conflict("EXECUTION_END_BINDING_CONFLICT", "task/run/intent/operation");
	if (anchor?.receiptId === receipt.receiptId)
		return same(anchor, receipt)
			? { kind: "duplicate" }
			: conflict("EXECUTION_END_RECEIPT_CONFLICT", "same receiptId different bytes");
	const proof = launchProof(receipt);
	if (proof && strongLaunch(launch) && !same(proof, launch))
		return conflict("EXECUTION_END_LAUNCH_CONFLICT", "launchIdentity");
	if (!anchor) return { kind: "first" };
	if (
		anchor.taskId !== receipt.taskId ||
		anchor.runId !== receipt.runId ||
		anchor.submissionIntentId !== receipt.submissionIntentId ||
		anchor.operationId !== receipt.operationId
	)
		return conflict("EXECUTION_END_BINDING_CONFLICT", "anchor task/run/intent/operation");
	const neverStarted = anchor.payload?.notStarted === true,
		newNeverStarted = receipt.payload?.notStarted === true;
	if (neverStarted !== newNeverStarted)
		return conflict("EXECUTION_END_START_CONFLICT", "notStarted");
	if (neverStarted) {
		if (
			!anchor.payload.processTree?.notStarted ||
			!receipt.payload.processTree?.notStarted ||
			!treeEnded(anchor) ||
			!treeEnded(receipt)
		)
			return conflict("EXECUTION_END_PROOF_UNVERIFIED", "notStarted proof");
	} else if (
		!strongLaunch(launch) ||
		!same(launchProof(anchor), launch) ||
		!same(proof, launch) ||
		!treeEnded(anchor) ||
		!treeEnded(receipt)
	)
		return conflict("EXECUTION_END_PROOF_UNVERIFIED", "bound launch/tree end proof");
	for (const field of ["exitCode", "endReason"]) {
		const before = anchor.payload?.[field],
			after = receipt.payload?.[field];
		if (known(before) && known(after) && !same(before, after))
			return conflict("EXECUTION_END_RESULT_CONFLICT", field);
	}
	return { kind: "corroborated" };
}
module.exports = { classifyEndReceipt, endedLaunchIdentity };
