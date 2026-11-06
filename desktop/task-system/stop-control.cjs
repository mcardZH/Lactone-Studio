"use strict";
const { listAll } = require("./operation-guards.cjs");
const terminal = (state) => ["succeeded", "failed", "cancelled"].includes(state);
function activePreparation(store, runId) {
	const run = store.read("run", runId),
		actual = run?.resultPreparationState;
	if (run?.executionIdentity.endReceipt?.payload?.notStarted === true && !actual?.launchReceipt)
		return false;
	if (actual && ["running", "unknown", "stop-requested"].includes(actual.state)) return true;
	if (actual && ["ended", "not-started"].includes(actual.state)) return false;
	return listAll(store, "operation").some(
		(operation) =>
			operation.type === "result-preparation" &&
			operation.authorizationScope.configured !== false &&
			!terminal(operation.operationState) &&
			operation.targets.some((target) => target.kind === "run" && target.id === runId)
	);
}
function taskStopControl(store, run, { queuedStops = [] } = {}) {
	if (!run) return { canRequest: false, pending: false, targets: [], reason: "任务运行记录缺失" };
	const targets = [];
	if (run.state.executionState !== "ended") targets.push("execution");
	if (activePreparation(store, run.runId)) targets.push("result-preparation");
	const pending =
		run.state.executionState === "stop-requested" ||
		run.resultPreparationState?.state === "stop-requested" ||
		listAll(store, "operation").some(
			(operation) =>
				operation.type === "request-stop" &&
				!terminal(operation.operationState) &&
				operation.targets.some((target) => target.kind === "run" && target.id === run.runId)
		) ||
		queuedStops.some(
			(item) =>
				item.queueState !== "completed" &&
				item.taskId === run.taskId &&
				item.runId === run.runId &&
				item.inputSnapshotId === run.inputSnapshotId &&
				item.submissionIntentId === run.executionIdentity.submissionIntentId &&
				JSON.stringify(item.workLocation) === JSON.stringify(run.executionIdentity.workLocation)
		);
	return {
		canRequest: targets.length > 0 && !pending,
		pending,
		targets,
		...(pending
			? { reason: "停止请求已登记，正在核实实际结束" }
			: !targets.length
				? { reason: "运行与结果准备均已结束" }
				: {})
	};
}
module.exports = { activePreparation, taskStopControl };
