"use strict";
const crypto = require("node:crypto");
const { executionRequest } = require("./submission.cjs");
const { base } = require("./management.cjs");
const { fail } = require("./platform/global-settings.cjs");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const terminal = (state) => ["succeeded", "failed", "cancelled"].includes(state);
function createQueuedStops({ settings, probe, now = () => new Date().toISOString() }) {
	const flights = new Map();
	async function mutate(operationId, change) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const current = settings.read();
			try {
				return await settings.update(current.revision, (value) => {
					value.pendingStops ||= {};
					const next = change(value.pendingStops[operationId]);
					if (next) value.pendingStops[operationId] = next;
					return value;
				});
			} catch (error) {
				if (error.code !== "CONFIG_REVISION_CONFLICT" || attempt === 3) throw error;
			}
		}
	}
	function list(libraryId) {
		return Object.values(settings.read().value.pendingStops || {}).filter(
			(value) =>
				value.libraryId === libraryId &&
				!["completed", "suppressed-deleted-task"].includes(value.queueState)
		);
	}
	async function register({ run, operation, manager, libraryPointer, processIdentity }) {
		const current = settings.readPointer();
		if (
			!current ||
			current.libraryId !== libraryPointer.libraryId ||
			manager.libraryId !== libraryPointer.libraryId ||
			!manager.instanceId ||
			!Number.isSafeInteger(manager.epoch)
		)
			throw fail("QUEUED_STOP_AUTHORITY_INVALID");
		const record = {
			schemaVersion: 1,
			operationId: operation.operationId,
			libraryId: libraryPointer.libraryId,
			taskId: run.taskId,
			runId: run.runId,
			submissionIntentId: run.executionIdentity.submissionIntentId,
			inputSnapshotId: run.inputSnapshotId,
			workLocation: run.executionIdentity.workLocation,
			sourcePointer: libraryPointer,
			sourceManager: manager,
			requestedBy: processIdentity,
			requestedAt: now(),
			queueState: "pending",
			evidenceRefs: [`manager:${manager.instanceId}:${manager.epoch}`]
		};
		await mutate(record.operationId, (existing) => {
			if (existing && !same(existing, record)) throw fail("QUEUED_STOP_ID_CONFLICT");
			return existing || record;
		});
		return { operationId: record.operationId, queued: true };
	}
	function matches(record, run, libraryId) {
		return (
			record.libraryId === libraryId &&
			record.taskId === run?.taskId &&
			record.runId === run?.runId &&
			record.inputSnapshotId === run?.inputSnapshotId &&
			record.submissionIntentId === run?.executionIdentity.submissionIntentId &&
			same(record.workLocation, run.executionIdentity.workLocation)
		);
	}
	async function drain(context) {
		const libraryId = context.store.describe().libraryId;
		if (flights.has(libraryId)) return flights.get(libraryId);
		const promise = (async () => {
			const claim = context.manager();
			for (const queued of list(libraryId)) {
				if (context.store.read("task", queued.taskId)?.deleted) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "suppressed-deleted-task",
						automaticDispatchSuppressed: true,
						reason: "任务已从管理中删除，保留原停止事实，不自动补发动作"
					}));
					continue;
				}
				const run = context.store.read("run", queued.runId);
				const effective = settings.readPointer();
				if (
					claim.epoch < queued.sourceManager.epoch ||
					queued.requestedBy.hostId !== context.identity.hostId ||
					queued.requestedBy.userId !== context.identity.userId ||
					effective.locationEpoch < queued.sourcePointer.locationEpoch ||
					(effective.root !== queued.sourcePointer.root &&
						!(effective.receiptSources || []).includes(queued.sourcePointer.root))
				) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "waiting-verification",
						reason: "原管理epoch、电脑/用户或位置切换证据不相符，保留停止请求"
					}));
					continue;
				}
				if (!matches(queued, run, libraryId)) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "waiting-verification",
						reason: "原任务、运行、输入或工作位置身份不一致，未发停止"
					}));
					continue;
				}
				let operation = context.store.read("operation", queued.operationId),
					permit = context.operationPermits.get(queued.operationId);
				if (
					operation &&
					(operation.type !== "request-stop" ||
						!operation.targets.some(
							(target) => target.kind === "run" && target.id === queued.runId
						) ||
						operation.authorizationScope.submissionIntentId !== queued.submissionIntentId ||
						operation.authorizationScope.inputSnapshotId !== queued.inputSnapshotId ||
						!same(operation.authorizationScope.workLocation, queued.workLocation))
				) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "waiting-verification",
						reason: "持久操作身份冲突，未发送或重发停止"
					}));
					continue;
				}
				if (
					run.state.executionState === "ended" &&
					run.state.verificationState === "verified" &&
					!require("./exit.cjs").activePreparation(context.store, run.runId)
				) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "completed",
						completedAt: now(),
						endEvidenceRefs: run.state.evidenceRefs,
						stopIssued: false
					}));
					continue;
				}
				if (operation && terminal(operation.operationState)) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "waiting-verification",
						reason: "原停止操作已结束但运行或准备尚未证实结束，保留原停止请求"
					}));
					continue;
				}
				if (!operation) {
					const registered = context.store.beginOperation({
						manager: claim,
						operation: {
							...base(),
							operationId: queued.operationId,
							type: "request-stop",
							targets: [{ kind: "run", id: run.runId }],
							preconditions: {},
							authorizationScope: {
								runId: run.runId,
								queuedRequest: {
									sourcePointer: queued.sourcePointer,
									sourceManager: queued.sourceManager,
									requestedBy: queued.requestedBy,
									requestedAt: queued.requestedAt
								},
								submissionIntentId: queued.submissionIntentId,
								inputSnapshotId: queued.inputSnapshotId,
								workLocation: queued.workLocation
							},
							phase: "intent-persisted",
							operationState: "pending",
							results: []
						}
					});
					operation = registered.operation;
					permit = registered.permit;
					context.rememberOperation(registered);
				}
				if (!permit) {
					if (operation.phase !== "intent-persisted" || (await probe(operation.owner)) !== "dead") {
						await mutate(queued.operationId, (value) => ({
							...value,
							queueState: "waiting-verification",
							reason: "原停止操作已登记；等待原owner收尾或核实实际回执"
						}));
						continue;
					}
					const inspection = await context.execution.inspect(
						executionRequest(run, "inspect", operation.operationId)
					);
					const evidenceRefs = inspection.evidenceRefs?.length
						? inspection.evidenceRefs
						: inspection.payload?.evidenceRefs;
					if (!evidenceRefs?.length) {
						await mutate(queued.operationId, (value) => ({
							...value,
							queueState: "waiting-verification",
							reason: "原运行尚未取得可核验事实，未重发停止"
						}));
						continue;
					}
					const resumed = await context.store.resumeOperation({
						manager: claim,
						operationId: operation.operationId,
						expectedRevision: operation.revision,
						evidence: {
							sideEffectState: "not-occurred",
							checkedAt: now(),
							evidenceRefs: [
								...evidenceRefs,
								`operation:${operation.operationId}:intent-persisted-before-dispatch`
							]
						}
					});
					operation = resumed.operation;
					permit = resumed.permit;
					context.rememberOperation(resumed);
				}
				await mutate(queued.operationId, (value) => ({
					...value,
					queueState: "registered",
					registeredAt: value.registeredAt || now(),
					effectivePointer: settings.readPointer()
				}));
				try {
					if (context.store.read("task", queued.taskId)?.deleted) {
						await mutate(queued.operationId, (value) => ({
							...value,
							queueState: "suppressed-deleted-task",
							automaticDispatchSuppressed: true,
							reason: "任务已删除，不自动补发停止"
						}));
						continue;
					}
					if (operation.phase === "intent-persisted")
						await context.execution.execute({
							permit,
							request: executionRequest(run, "requestStop", operation.operationId)
						});
					else
						await context.execution.reconcile({
							permit,
							request: executionRequest(run, "inspect", operation.operationId)
						});
				} catch (error) {
					await mutate(queued.operationId, (value) => ({
						...value,
						queueState: "waiting-verification",
						reason: "停止已登记，执行回执仍待核实",
						code: error.code || "STOP_UNVERIFIED"
					}));
				}
			}
		})();
		flights.set(libraryId, promise);
		try {
			return await promise;
		} finally {
			flights.delete(libraryId);
		}
	}
	return { list, register, drain };
}
module.exports = { createQueuedStops };
