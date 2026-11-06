"use strict";
const crypto = require("node:crypto");
const { executionRequest } = require("./submission.cjs");
const { base } = require("./management.cjs");
const terminal = (state) => ["succeeded", "failed", "cancelled"].includes(state);
const { activePreparation } = require("./stop-control.cjs");
async function stopForExit({ context, owners, timeoutMs = 10000 }) {
	if (!context.store)
		return { verified: false, reason: "任务库不可用，无法核实停止", remaining: [] };
	const entry = "host-exit-management";
	if (!context.entries.size) context.entries.add(entry);
	if (!context.claim) {
		const acquired = await context.store.acquireManager();
		if (!acquired.acquired)
			return {
				verified: false,
				reason: "任务库由其他ES管理，当前只读端无法代其停止",
				remaining: context.store
					.list("run")
					.filter((run) => !context.store.read("task", run.taskId)?.deleted)
					.filter((run) => run.state.executionState !== "ended")
			};
		context.claim = acquired.manager;
	}
	const store = context.store,
		manager = context.manager(),
		requests = [];
	await context.drainQueuedStops?.();
	// Observe first; no native dispatch and no implicit resume/restart occurs here.
	for (const run of store.list("run").filter((run) => !store.read("task", run.taskId)?.deleted))
		if (
			run.state.executionState !== "ended" ||
			run.state.verificationState !== "verified" ||
			activePreparation(store, run.runId)
		)
			await context.monitoring.refresh(run.taskId, false);
	for (const run of store.list("run").filter((run) => !store.read("task", run.taskId)?.deleted)) {
		if (
			run.state.executionState === "ended" &&
			run.state.verificationState === "verified" &&
			!activePreparation(store, run.runId)
		)
			continue;
		const existing = store
			.list("operation")
			.find(
				(operation) =>
					operation.type === "request-stop" &&
					!terminal(operation.operationState) &&
					operation.targets.some((target) => target.kind === "run" && target.id === run.runId)
			);
		if (existing) {
			const original = [...owners.values()].find(
				(value) =>
					value.identity.instanceId === existing.owner?.instanceId &&
					value.operationPermits?.has(existing.operationId)
			);
			if (original)
				requests.push({
					context: original,
					run,
					operationId: existing.operationId,
					permit: original.operationPermits.get(existing.operationId),
					reconcile: true
				});
			continue;
		}
		const operation = {
			...base(),
			operationId: "exit-stop-" + crypto.randomUUID(),
			type: "request-stop",
			targets: [{ kind: "run", id: run.runId }],
			preconditions: {},
			authorizationScope: { runId: run.runId, purpose: "user-stop-before-exit" },
			phase: "intent-persisted",
			operationState: "pending",
			results: []
		};
		const registered = store.beginOperation({ manager, operation });
		context.rememberOperation(registered);
		requests.push({
			context,
			run,
			operationId: operation.operationId,
			permit: registered.permit,
			reconcile: false
		});
	}
	const errors = [];
	for (const request of requests)
		try {
			const action = executionRequest(
				request.run,
				request.reconcile ? "inspect" : "requestStop",
				request.operationId
			);
			if (request.reconcile)
				await request.context.execution.reconcile({ permit: request.permit, request: action });
			else await request.context.execution.execute({ permit: request.permit, request: action });
		} catch (error) {
			errors.push({ runId: request.run.runId, code: error.code || "STOP_UNVERIFIED" });
		}
	const started = Date.now();
	let remaining;
	do {
		for (const run of store.list("run").filter((run) => !store.read("task", run.taskId)?.deleted))
			if (
				run.state.executionState !== "ended" ||
				run.state.verificationState !== "verified" ||
				activePreparation(store, run.runId)
			)
				await context.monitoring.refresh(run.taskId, false);
		context.monitoring.applyReceipts(manager);
		remaining = store
			.list("run")
			.filter((run) => !store.read("task", run.taskId)?.deleted)
			.filter(
				(run) =>
					run.state.executionState !== "ended" ||
					run.state.verificationState !== "verified" ||
					activePreparation(store, run.runId)
			)
			.map((run) => ({
				taskId: run.taskId,
				runId: run.runId,
				executionState: run.state.executionState,
				verificationState: run.state.verificationState,
				resultPreparationActive: activePreparation(store, run.runId)
			}));
		if (!remaining.length) return { verified: true, remaining: [], errors };
		if (errors.length || Date.now() - started >= timeoutMs) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (true);
	return {
		verified: false,
		reason: "停止请求已登记，仍有运行或准备owner未确认结束",
		remaining,
		errors
	};
}
module.exports = { stopForExit, activePreparation };
