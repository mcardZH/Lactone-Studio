"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { iterateRecords } = require("./operation-guards.cjs");
const { fail } = require("./platform/global-settings.cjs");
const base = () => ({ schemaVersion: 1, revision: 1, requiredCapabilities: [] });
const mutation = (kind, id, value, old) => ({
	kind,
	id,
	value,
	expectedRevision: old?.revision ?? null
});
/** Record revisions also advance for display/monitor observations. Plans bind
 * the remaining complete records, including unknown extensions, rather than a
 * whitelist that might omit a new scientific, source or management identity. */
function managementPlanIdentity(task, run, store) {
	const omit = (value, fields) => value && Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
	const taskValue = omit(task, ["revision", "formula", "thumbnail", "thumbnailStructure", "thumbnailSourceVersion"]);
	if (taskValue?.observedSource) taskValue.observedSource = omit(taskValue.observedSource, ["engineId", "taskKind", "readerImplementationVersion", "observedAt"]);
	const runValue = omit(run, ["revision", "monitorSummary", "runtimeTimingObservation"]);
	if (runValue?.state) runValue.state = omit(runValue.state, ["scientificState", "checkedAt", "evidenceRefs", "verificationAttemptAt", "verificationFailureCode"]);
	// Repeated same-state process inspections refresh this timestamp too. Keep
	// its evidence type, references and unknown extensions in the exact guard.
	if (runValue?.transitionEvidence) runValue.transitionEvidence = omit(runValue.transitionEvidence, ["checkedAt"]);
	if (runValue?.resources) runValue.resources = omit(runValue.resources, ["observation"]);
	const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
	const inputSnapshot = run?.inputSnapshotId ? store.read("inputSnapshot", run.inputSnapshotId) : null;
	const sourceSet = task?.sourceSetId ? store.read("sourceSet", task.sourceSetId) : null;
	return crypto.createHash("sha256").update(JSON.stringify(stable({ task: taskValue, run: runValue, inputSnapshot, sourceSet }))).digest("hex");
}
function managementTargetCurrent(target, task, run, store) {
	if (!task || task.deleted || run?.deleted) return false;
	return target.managementIdentity
		? managementPlanIdentity(task, run, store) === target.managementIdentity
		: task.revision === target.revision && run?.revision === target.runRevision;
}
function createManagement({
	store,
	claim,
	now = () => new Date().toISOString(),
	assets,
	executionRequest,
	execution,
	plans = new Map(),
	queueStop,
	queuedStopRecords = () => [],
	runFile = (_mode, work) => work(),
	withRun = (_run, work) => work(),
	enumerateScratch = async () => ({ scratchScopes: [], exclusions: [] }),
	onOperationRegistered = () => {},
	operations,
	launchBackground = () => {},
	libraryDirectory,
	onChanged = () => {},
	stopAndVerify,
	stopVerificationTimeoutMs = 10000
}) {
	const organization = require("./library/organization.cjs");
	function manager() {
		const active = claim();
		store.assertManager(active);
		return active;
	}
	function stopBinding(run) {
		return {
			taskId: run.taskId, runId: run.runId, inputSnapshotId: run.inputSnapshotId,
			submissionIntentId: run.executionIdentity.submissionIntentId,
			workLocation: run.executionIdentity.workLocation
		};
	}
	function stopRecord(run, operationId, extraScope) {
		return {
			...base(), operationId, type: "request-stop",
			targets: [{ kind: "run", id: run.runId }], preconditions: {},
			authorizationScope: { ...stopBinding(run), ...extraScope },
			phase: "intent-persisted", operationState: "pending", results: []
		};
	}
	async function requestAndVerify(registered, batchOperationId) {
		if (!registered || registered.queued) throw fail("STOP_TARGET_NOT_READY");
		const response = await execution().execute({
			permit: registered.permit,
			request: executionRequest(registered.run, "requestStop", registered.operation.operationId)
		});
		const commit = (mutations) =>
			batchOperationId && operations
				? operations.commitRecords(batchOperationId, mutations)
				: store.commit({ manager: manager(), mutations });
		const current = store.read("run", registered.run.runId);
		if (
			current.state.executionState !== "ended" &&
			response.actualState?.executionState === "stop-requested"
		) {
			const evidenceRefs = response.evidenceRefs?.length
				? response.evidenceRefs
				: ["operation:" + registered.operation.operationId];
			commit([
				mutation(
					"run",
					current.runId,
					{
						...current,
						revision: current.revision + 1,
						state: {
							...current.state,
							executionState: "stop-requested",
							checkedAt: now(),
							evidenceRefs
						},
						transitionEvidence: { type: "stop-intent", checkedAt: now(), evidenceRefs }
					},
					current
				)
			]);
		}
		const verified = await require("./stop-verification.cjs").verifyStoppedRun({
			store,
			runId: registered.run.runId,
			inspect: (run) =>
				execution().inspect(executionRequest(run, "inspect", run.submitOperationId)),
			commitRecords: commit,
			timeoutMs: stopVerificationTimeoutMs,
			now
		});
		if (!verified.verified)
			throw fail("STOP_VERIFICATION_PENDING", "停止请求已发送，实际退出尚待核实。");
		settleVerifiedStop(registered.operation.operationId, registered.run.runId, commit);
		return verified;
	}
	function settleVerifiedStop(operationId, runId, commit) {
		const stoppedOperation = store.read("operation", operationId);
		if (
			stoppedOperation &&
			!["succeeded", "failed", "cancelled"].includes(stoppedOperation.operationState)
		)
			commit([
				mutation(
					"operation",
					stoppedOperation.operationId,
					{
						...stoppedOperation,
						revision: stoppedOperation.revision + 1,
						phase: "actual-stop-verified",
						operationState: "succeeded",
						transitionEvidence: {
							type: "operation-complete",
							checkedAt: now(),
							evidenceRefs: ["run:" + runId + ":ended-verified"]
						}
					},
					stoppedOperation
				)
			]);
	}
	function saveGroup({
		groupId = "group-" + crypto.randomUUID(),
		parentGroupId,
		displayName,
		order
	}) {
		const current = store.read("group", groupId);
		if (typeof displayName !== "string" || !displayName.trim()) throw fail("GROUP_NAME_INVALID");
		if (
			parentGroupId &&
			(!store.read("group", parentGroupId) || store.read("group", parentGroupId).deleted)
		)
			throw fail("GROUP_NOT_FOUND");
		let parent = parentGroupId,
			seen = new Set([groupId]);
		while (parent) {
			if (seen.has(parent)) throw fail("GROUP_CYCLE");
			seen.add(parent);
			parent = store.read("group", parent)?.parentGroupId;
		}
		const value = {
			...(current || base()),
			groupId,
			parentGroupId: parentGroupId || null,
			order: Number.isFinite(order)
				? order
				: (current?.order ??
					store
						.list("group")
						.filter(
							(group) => !group.deleted && (group.parentGroupId || null) === (parentGroupId || null)
						).length),
			requiredCapabilities: [
				...new Set([...(current?.requiredCapabilities || []), "es:task-multigroup-v1"])
			],
			displayName: displayName.trim(),
			revision: (current?.revision || 0) + 1
		};
		store.commit({ manager: manager(), mutations: [mutation("group", groupId, value, current)] });
	}
	const service = {
		rename({ taskId, displayName }) {
			const task = store.read("task", taskId);
			if (!task || typeof displayName !== "string" || !displayName.trim())
				throw fail("TASK_NAME_INVALID");
			const portable = require("./library/markers.cjs"),
				fs = require("node:fs");
			const management = portable.management(task.management, task.recycleState === "recycled");
			for (const location of task.locations || [])
				if (location.markerPath) {
					const file =
						location.scope === "library"
							? path.resolve(libraryDirectory, portable.relativePath(location.markerPath))
							: location.markerPath;
					if (!fs.existsSync(file)) continue;
					const marker = portable.readMarker(file);
					if (
						marker.value.id !== taskId ||
						(task.management &&
							portable.compareManagement(task.management, marker.value.management) === "conflict")
					)
						throw fail("TASK_MARKER_MANAGEMENT_CONFLICT");
					portable.writeMarker(
						file,
						{ ...marker.value, name: displayName.trim(), management },
						marker.identity
					);
				}
			store.commit({
				manager: manager(),
				mutations: [
					mutation(
						"task",
						taskId,
						{
							...task,
							revision: task.revision + 1,
							displayName: displayName.trim(),
							...(management ? { management } : {})
						},
						task
					)
				]
			});
		},
		saveGroup,
		moveGroup({ groupId, parentGroupId, beforeGroupId }) {
			const group = store.read("group", groupId);
			if (!group) throw fail("GROUP_NOT_FOUND");
			if (
				parentGroupId &&
				(!store.read("group", parentGroupId) || store.read("group", parentGroupId).deleted)
			)
				throw fail("GROUP_NOT_FOUND");
			const seen = new Set([groupId]);
			let parent = parentGroupId;
			while (parent) {
				if (seen.has(parent)) throw fail("GROUP_CYCLE");
				seen.add(parent);
				parent = store.read("group", parent)?.parentGroupId;
			}
			const siblings = store
				.list("group")
				.filter(
					(row) =>
						!row.deleted &&
						row.groupId !== groupId &&
						(row.parentGroupId || null) === (parentGroupId || null)
				)
				.sort((a, b) => (a.order || 0) - (b.order || 0));
			const index = beforeGroupId
				? siblings.findIndex((row) => row.groupId === beforeGroupId)
				: siblings.length;
			if (index < 0) throw fail("GROUP_DROP_TARGET_INVALID");
			const rows = siblings.slice();
			rows.splice(index, 0, { ...group, parentGroupId: parentGroupId || null });
			const mutations = rows
				.filter((row, n) => row.order !== n || row.groupId === groupId)
				.map((row, n) =>
					mutation(
						"group",
						row.groupId,
						{
							...row,
							order: rows.indexOf(row),
							revision: row.revision + 1,
							requiredCapabilities: [
								...new Set([...(row.requiredCapabilities || []), "es:task-multigroup-v1"])
							]
						},
						store.read("group", row.groupId)
					)
				);
			if (mutations.length) store.commit({ manager: manager(), mutations });
		},
		membership({ taskIds, groupId, mode = "add" }) {
			if (!["add", "remove"].includes(mode) || !Array.isArray(taskIds) || !taskIds.length)
				throw fail("GROUP_MEMBERSHIP_INVALID");
			const mutations = organization.membershipMutations(
				store,
				taskIds,
				groupId,
				mode === "remove"
			);
			if (mutations.length) store.commit({ manager: manager(), mutations });
		},
		deleteGroup({ groupId }) {
			if (!store.read("group", groupId)) throw fail("GROUP_NOT_FOUND");
			const ids = organization.descendants(store, groupId),
				mutations = [];
			for (const group of store.list("group"))
				if (ids.has(group.groupId) && !group.deleted)
					mutations.push(
						mutation(
							"group",
							group.groupId,
							{ ...group, deleted: true, revision: group.revision + 1 },
							group
						)
					);
			for (const row of organization.memberships(store))
				if (ids.has(row.groupId))
					mutations.push(
						mutation(
							"groupMembership",
							row.membershipId,
							{ ...row, deleted: true, revision: row.revision + 1 },
							row
						)
					);
			store.commit({ manager: manager(), mutations });
		},
		async plan({
			action,
			taskIds,
			groupId,
			deleteLocal = true,
			deleteRemote = true,
			remindRemote = false,
			archiveMode = "default",
			selectedArtifactIds
		}) {
			manager();
			if (
				![
					"group",
					"stop",
					"archive",
					"cleanup",
					"cleanup-archive",
					"delete-task",
					"recycle",
					"restore"
				].includes(action) ||
				!Array.isArray(taskIds) ||
				!taskIds.length ||
				new Set(taskIds).size !== taskIds.length
			)
				throw fail("OPERATION_SCOPE_INVALID");
			if (action === "group" && groupId && !store.read("group", groupId))
				throw fail("GROUP_NOT_FOUND");
			const targets = [],
				items = [];
			for (const taskId of taskIds) {
				const task = store.read("task", taskId),
					run = task && store.read("run", task.latestRunId),
					managementIdentity = managementPlanIdentity(task, run, store);
				let cleanupImpact = null,
					reason =
						!task || task.deleted || run?.deleted || (!run && ["stop", "archive", "cleanup"].includes(action))
							? "任务或运行记录缺失"
							: null,
					prepared = null;
				if (
					!reason &&
					action !== "group" &&
					action !== "restore" &&
					action !== "stop" &&
					action !== "delete-task" &&
					action !== "cleanup" &&
					run &&
					(run.state.executionState !== "ended" || run.state.verificationState !== "verified")
				)
					reason = "须先确认运行真正结束";
				if (!reason && action === "stop") {
					const control = require("./stop-control.cjs").taskStopControl(store, run, {
						queuedStops: queuedStopRecords()
					});
					if (!control.canRequest) reason = control.reason;
				}
				try {
					if (!reason && ["cleanup-archive", "delete-task"].includes(action)) {
						prepared = await withRun(run, () =>
							assets().planDeletion({
								manager: manager(),
								taskId,
								action,
								deleteLocal,
								deleteRemote,
								remindRemote
							})
						);
						cleanupImpact = prepared.impact;
					}
					if (!reason && action === "archive") {
						prepared = await withRun(run, () =>
							assets().planArchive({
								manager: manager(),
								taskId,
								runId: run.runId,
								sourceLocation: run.executionIdentity.workLocation,
								archiveMode, selectedArtifactIds,
								artifacts: store.list("artifact", { runId: run.runId })
							})
						);
						if (!prepared.items.some((x) => x.included)) reason = "尚无可核验的结果清单";
					}
					if (!reason && action === "cleanup") {
						prepared = await withRun(run, () => assets().planClearWork({ manager: manager(), taskId, runId: run.runId }));
						cleanupImpact = `永久清空已确认的${prepared.impact.count}项工作文件，保留任务卡和提交记录。${prepared.directoryMode === "dual" ? "归档目录不在本次清空范围。" : ""}`;
					}
					if (!reason && action === "restore" && task.recycleState !== "recycled")
						reason = "任务不在回收区";
				} catch (error) {
					reason = error.message;
				}
				targets.push({
					taskId,
					runId: run?.runId,
					inputSnapshotId: run?.inputSnapshotId,
					submissionIntentId: run?.executionIdentity.submissionIntentId,
					workLocation: run?.executionIdentity.workLocation,
					managementIdentity,
					revision: task?.revision,
					runRevision: run?.revision,
					prepared
				});
				const files = prepared && ((action === "delete-task" || action === "cleanup-archive")
					? prepared.files.map(file => {
						const pathApi = file.path.startsWith("/") ? path.posix : path.win32;
						return {
							artifactId: file.artifactId,
							relativePath: pathApi.relative(file.root, file.path).split(pathApi.sep).join("/"),
							roles: [file.role],
							byteSize: file.identity.byteSize,
							included: true,
							recommended: false
						};
					})
					: (prepared.items || prepared.manifest?.items || []).map(file => ({
						artifactId: file.artifactId,
						relativePath: file.originalRelativePath || file.relativePath || file.path,
						roles: file.roles || [],
						byteSize: file.byteSize ?? null,
						included: file.included !== false,
						recommended: file.recommended === true
					})));
				items.push({
					taskId,
					displayName: task?.displayName || taskId,
					eligible: !reason,
					workPath: run?.executionIdentity.workLocation?.path || null,
					directoryMode: prepared?.directoryMode || task?.directoryMode || (task?.plannedArchiveLocation ? "dual" : run?.environmentSnapshot.connection.kind === "local" ? "single" : "dual"),
					...(prepared?.archiveCoverage ? { archiveCoverage: prepared.archiveCoverage } : {}),
					...(files ? {
						files,
						totalBytes: files.reduce((sum, file) => sum + (file.included ? file.byteSize ?? 0 : 0), 0),
						requiresStop: prepared.requiresStop === true
					} : {}),
					impact:
						cleanupImpact ||
						{
							group: "仅修改虚拟分组",
							stop: "请求停止，等待真实结束",
							archive: "复制并核验结果与必要来源",
							cleanup: "永久删除核验清单中的原位置副本及明确scratch",
							recycle: "仅修改回收登记，文件和路径保持",
							restore: "撤销回收登记，旧物理回收按真实路径兼容"
						}[action],
					...(reason ? { reason } : {})
				});
			}
			const planId = crypto.randomUUID();
			plans.set(planId, { action, targets, items, groupId: groupId || null });
			return { planId, action, items };
		},
		async executePlan({ planId, batchOperationId }, report = () => {}) {
			const active = manager(),
				plan = plans.get(planId);
			if (!plan) throw fail("OPERATION_PLAN_EXPIRED");
			plans.delete(planId);
			const batchId = "batch-" + crypto.randomUUID(),
				items = [];
			const registeredStops = new Map();
			if (["stop", "delete-task", "cleanup"].includes(plan.action))
				for (const [index, target] of plan.targets.entries()) {
					const task = store.read("task", target.taskId),
						run = task && store.read("run", task.latestRunId);
					if (
						!plan.items[index].eligible ||
						!managementTargetCurrent(target, task, run, store) ||
						!run ||
						run.runId !== target.runId ||
						run.inputSnapshotId !== target.inputSnapshotId ||
						run.executionIdentity.submissionIntentId !== target.submissionIntentId ||
						JSON.stringify(run.executionIdentity.workLocation) !==
							JSON.stringify(target.workLocation)
					)
						continue;
					if (
						["delete-task", "cleanup"].includes(plan.action) &&
						(run.state.executionState === "ended" ||
							target.prepared?.unprocessed?.some(
								(row) =>
									row.state === "unprocessed" &&
									/SSH|NETWORK|CONNECT|AUTH|UNREACHABLE|ECONN/i.test(row.reason || "")
							))
					)
						continue;
					const operation = stopRecord(run, target.stopOperationId || "stop-" + crypto.randomUUID(), { batchId });
					try {
						const registered = store.beginOperation({ manager: active, operation });
						onOperationRegistered(registered);
						registeredStops.set(target.taskId, { ...registered, run });
					} catch (error) {
						if (
							!queueStop ||
							!["LIBRARY_MIGRATION_FINALIZING", "LIBRARY_NOT_EFFECTIVE"].includes(error.code)
						)
							throw error;
						registeredStops.set(target.taskId, {
							queued: queueStop({ run, operation, manager: active }),
							run
						});
					}
				}
			const registeredAssets = new Map();
			if (["archive", "recycle", "restore", "cleanup-archive", "delete-task"].includes(plan.action))
				for (const [index, target] of plan.targets.entries()) {
					const task = store.read("task", target.taskId),
						run = task && store.read("run", task.latestRunId);
					if (
						!plan.items[index].eligible ||
						(!run && plan.action === "archive") ||
						!managementTargetCurrent(target, task, run, store)
					)
						continue;
					try {
						let registered;
						if (plan.action === "archive")
							registered = assets().registerArchive({ manager: active, manifest: target.prepared });
						if (["cleanup-archive", "delete-task"].includes(plan.action))
							registered = assets().registerDeletion({ manager: active, plan: target.prepared });
						if (plan.action === "recycle") {
							registered = {
								...assets().registerLogicalRecycle({ manager: active, taskId: task.taskId }),
								logical: true
							};
						}
						if (plan.action === "restore")
							registered =
								store.read("recycleRecord", task.recycleId)?.mode === "logical"
									? {
											...assets().registerLogicalRestore({ manager: active, taskId: task.taskId }),
											logical: true
										}
									: assets().registerRestore({ manager: active, recycleId: task.recycleId });
						registeredAssets.set(target.taskId, registered);
					} catch (error) {
						registeredAssets.set(target.taskId, { error });
					}
				}
			// One bounded lane. Every registered child keeps its independent operation permit after UI release.
			for (const [index, target] of plan.targets.entries()) {
				const item = plan.items[index],
					task = store.read("task", target.taskId),
					run = task && store.read("run", task.latestRunId);
				report(items, target.taskId);
				if (!item.eligible) {
					items.push({ ...item, outcome: "not-executed", message: item.reason });
					report(items);
					continue;
				}
				if (
					!registeredStops.has(target.taskId) &&
					!registeredAssets.has(target.taskId) &&
					!managementTargetCurrent(target, task, run, store)
				) {
					items.push({
						taskId: target.taskId,
						displayName: item.displayName,
						outcome: "not-executed",
						message: "任务已变化，请重新确认"
					});
					report(items);
					continue;
				}
				try {
					if (registeredAssets.get(target.taskId)?.error)
						throw registeredAssets.get(target.taskId).error;
					if (plan.action === "group")
						service.membership({ taskIds: [task.taskId], groupId: plan.groupId });
					if (["cleanup-archive", "delete-task"].includes(plan.action)) {
						const offline = target.prepared.unprocessed.some(
							(row) =>
								row.state === "unprocessed" &&
								/SSH|NETWORK|CONNECT|AUTH|UNREACHABLE|ECONN/i.test(row.reason || "")
						);
						if (
							plan.action === "delete-task" &&
							run &&
							run.state.executionState !== "ended" &&
							!offline &&
							!(await requestAndVerify(registeredStops.get(task.taskId), batchOperationId)).verified
						)
							throw fail("DELETE_STOP_NOT_VERIFIED");
						const outcome = await runFile(
							"write",
							() =>
								assets().executeDeletion({ ...registeredAssets.get(target.taskId), stopAndVerify }),
							run
						);
						if (outcome.retained) throw fail("DELETE_PARTIALLY_RETAINED");
					}
					if (plan.action === "stop") {
						const registered = registeredStops.get(target.taskId);
						if (!registered) throw fail("STOP_TARGET_CHANGED");
						if (registered.queued) {
							const queued = await registered.queued;
							items.push({
								taskId: task.taskId,
								displayName: item.displayName,
								outcome: "not-executed",
								message: "停止请求已持久排队；迁库安全边界后按原运行核实，尚未报停止完成",
								operationId: queued.operationId
							});
							continue;
						}
						await requestAndVerify(registered, batchOperationId);
					}
					if (plan.action === "archive")
						await runFile(
							"read",
							() => assets().executeRegisteredArchive(registeredAssets.get(target.taskId)),
							run
						);
					if (plan.action === "cleanup" && run.state.executionState !== "ended") await requestAndVerify(registeredStops.get(task.taskId), batchOperationId);
					if (plan.action === "cleanup") {
						const cleared = await runFile(
							"write",
							() =>
								assets().clearWork({
									manifestId: target.prepared.manifest.manifestId,
									confirmationToken: target.prepared.confirmationToken
								}),
							run
						);
						if (cleared.status !== "completed") throw fail("ASSET_CLEAR_PARTIAL", "部分工作文件已改变或仍在使用，已保留未处理内容。");
					}
					if (plan.action === "recycle")
						await runFile(
							"write",
							() =>
								registeredAssets.get(target.taskId)?.logical
									? assets().executeRegisteredLogicalRecycle(registeredAssets.get(target.taskId))
									: assets().executeRegisteredRecycle(registeredAssets.get(target.taskId)),
							run
						);
					if (plan.action === "restore") {
						const restored = await runFile(
							"write",
							() =>
								registeredAssets.get(target.taskId)?.logical
									? assets().executeRegisteredLogicalRecycle(registeredAssets.get(target.taskId))
									: assets().executeRegisteredRestore(registeredAssets.get(target.taskId)),
							run
						);
						if (restored.conflicts?.length)
							throw Object.assign(fail("RESTORE_PARTIAL_CONFLICT"), {
								message: `已恢复部分文件，${restored.conflicts.length}项冲突保留原状`
							});
					}
					items.push({
						taskId: task.taskId,
						displayName: item.displayName,
						childOperationId:
							registeredAssets.get(target.taskId)?.operationId ||
							registeredStops.get(target.taskId)?.operation?.operationId ||
							target.prepared?.manifest?.operationId ||
							target.prepared?.operationId,
						outcome: "succeeded",
						...(plan.action === "stop" ? { message: "已核实实际结束" } : {})
					});
				} catch (error) {
					items.push({
						taskId: task.taskId,
						displayName: item.displayName,
						childOperationId:
							registeredAssets.get(target.taskId)?.operationId ||
							registeredStops.get(target.taskId)?.operation?.operationId ||
							target.prepared?.manifest?.operationId ||
							target.prepared?.operationId,
						outcome: "failed",
						message: error.code === "ASSET_CLEAR_PARTIAL" ? "部分工作文件已变化或仍在使用，已保留未处理内容。" : error.message,
						...(error.code ? { errorCode: error.code } : {})
					});
				}
				report(items);
			}
			return { operationId: batchId, items };
		}
	};
	service.execute = async ({ planId }) => {
		const plan = plans.get(planId);
		if (!plan) throw fail("OPERATION_PLAN_EXPIRED");
		if (!operations) return service.executePlan({ planId });
		const plannedItems = plan.items.map((item) => ({
			taskId: item.taskId,
			displayName: item.displayName,
			state: "pending",
			phase: "等待执行"
		}));
		if (["stop", "delete-task", "cleanup"].includes(plan.action))
			for (const target of plan.targets) target.stopOperationId = "stop-" + crypto.randomUUID();
		const started = operations.begin({
			type: "batch-" + plan.action,
			targets: [
				...plan.targets.map((row) => ({ kind: "task", id: row.taskId })),
				...(["stop", "delete-task", "cleanup"].includes(plan.action)
					? [
							...plan.targets
								.filter((row) => row.runId)
								.map((row) => ({ kind: "run", id: row.runId })),
							...plan.targets.map((row) => ({ kind: "operation", id: row.stopOperationId })),
							...store
								.list("operation")
								.filter(
									(op) =>
										op.type === "result-preparation" &&
										op.targets.some(
											(target) =>
												target.kind === "run" && plan.targets.some((row) => row.runId === target.id)
										)
								)
								.map((op) => ({ kind: "operation", id: op.operationId }))
						]
					: [])
			],
			scope: {
				action: plan.action,
				groupId: plan.groupId,
				taskIds: plan.targets.map((row) => row.taskId),
				plannedItems
			}
		});
		const promise = service
			.executePlan({ planId, batchOperationId: started.operationId }, (items, currentTaskId) =>
				operations.update(started.operationId, {
					phase: plan.action,
					completed: items.length,
					total: plan.targets.length,
					unit: "tasks",
					items: plannedItems.map((row) => {
						const done = items.find((item) => item.taskId === row.taskId);
						return done
							? { ...done, state: done.outcome }
							: {
									...row,
									...(row.taskId === currentTaskId ? { state: "running", phase: plan.action } : {})
								};
					})
				})
			)
			.then(
				(result) => {
					operations.complete(started.operationId, { items: result.items });
					return result;
				},
				(error) => {
					operations.fail(started.operationId, error);
					throw error;
				}
			);
		launchBackground(promise);
		return started;
	};
	service.retry = async ({ operationId, taskIds }) => {
		manager();
		const previous = store.read("operation", operationId);
		if (
			!previous ||
			!previous.type.startsWith("batch-") ||
			!Array.isArray(taskIds) ||
			!taskIds.length
		)
			throw fail("OPERATION_RETRY_SCOPE_INVALID");
		const selected = taskIds.map((id) =>
			previous.items?.find((row) => row.taskId === id && row.outcome !== "succeeded")
		);
		if (selected.some((row) => !row)) throw fail("OPERATION_RETRY_SCOPE_INVALID");
		const retryingStop = previous.authorizationScope.action === "stop";
		const stopTargets = new Map();
		const operationRows = retryingStop ? [...iterateRecords(store, "operation")] : [];
		if (retryingStop) {
			if (previous.type !== "batch-stop" || !["partial", "failed"].includes(previous.operationState) ||
				new Set(taskIds).size !== taskIds.length)
				throw fail("OPERATION_RETRY_SCOPE_INVALID");
			for (const item of selected) {
				const task = store.read("task", item.taskId);
				const run = task?.latestRunId && store.read("run", task.latestRunId);
				const child = item.childOperationId && store.read("operation", item.childOperationId);
				const hasTarget = (operation, kind, id) => operation.targets.some(target => target.kind === kind && target.id === id);
				if (!run || task.deleted || run.deleted || run.taskId !== item.taskId ||
					!hasTarget(previous, "task", item.taskId) || !hasTarget(previous, "run", run.runId) ||
					(item.childOperationId && (!child || child.type !== "request-stop" ||
						!hasTarget(previous, "operation", child.operationId) || !hasTarget(child, "run", run.runId) ||
						child.authorizationScope.runId !== run.runId)))
					throw fail("STOP_TARGET_CHANGED");
				const binding = stopBinding(run);
				const resumable = run.requiredCapabilities?.includes("es:task-posix-stop-dispatch-v1") === true && !!child;
				if ((resumable || child?.authorizationScope.inputSnapshotId) &&
					!Object.entries(binding).every(([key, value]) => isDeepStrictEqual(child.authorizationScope[key], value)))
					throw fail("STOP_TARGET_CHANGED");
				const relatedStops = resumable ? operationRows.filter(op =>
					op.type === "request-stop" && op.authorizationScope.retryOfStop === child.operationId &&
					hasTarget(op, "run", run.runId) &&
					Object.entries(binding).every(([key, value]) => isDeepStrictEqual(op.authorizationScope[key], value))
				).map(op => op.operationId) : [];
				stopTargets.set(item.taskId, { binding, child, relatedStops, resumeId: resumable ? "stop-" + crypto.randomUUID() : null });
			}
		}
		const stopOperationTargets = [...stopTargets.values()].flatMap(({ binding, resumeId, relatedStops }) => [
			...(resumeId ? [resumeId] : []),
			...relatedStops,
			...operationRows.filter(op => op.type === "result-preparation" &&
				op.targets.some(target => target.kind === "run" && target.id === binding.runId)).map(op => op.operationId)
		]);
		const start = operations.begin({
			type: "batch-" + previous.authorizationScope.action,
			targets: [
				...selected.map((row) => ({ kind: "task", id: row.taskId })),
				...selected
					.map((row) => stopTargets.get(row.taskId)?.binding.runId || store.read("task", row.taskId)?.latestRunId)
					.filter(Boolean)
					.map((id) => ({ kind: "run", id })),
				...selected
					.filter((row) => row.childOperationId && store.read("operation", row.childOperationId))
					.map((row) => ({ kind: "operation", id: row.childOperationId })),
				...[...new Set(stopOperationTargets)].map(id => ({ kind: "operation", id }))
			],
			scope: { action: previous.authorizationScope.action, retryOf: operationId, taskIds }
		});
		const promise = (async () => {
			const items = [];
			for (const item of selected) {
				try {
					if (item.childOperationId && previous.authorizationScope.action === "archive")
						await assets().retryArchive({ operationId: item.childOperationId });
					else if (previous.authorizationScope.action === "stop") {
						const { binding, child, resumeId, relatedStops } = stopTargets.get(item.taskId);
						const current = () => {
							const task = store.read("task", item.taskId);
							const run = task?.latestRunId && store.read("run", task.latestRunId);
							if (!run || task.deleted || run.deleted || !isDeepStrictEqual(binding, stopBinding(run)))
								throw fail("STOP_TARGET_CHANGED");
							return run;
						};
						const inspect = run => execution().inspect(executionRequest(run, "inspect", run.submitOperationId));
						const commit = mutations => operations.commitRecords(start.operationId, mutations);
						let run = current();
						let dispatched = false;
						if (resumeId && run.state.executionState !== "ended") {
							const observation = await inspect(run);
							run = current();
							if (run.state.executionState !== "ended" && observation.actualState?.executionState !== "ended" &&
								!observation.payload?.endReceipt) {
								const old = store.read("operation", child.operationId);
								const terminal = ["succeeded", "failed", "cancelled"];
								const hasOtherStop = [...iterateRecords(store, "operation")].some(op =>
									op.type === "request-stop" && op.operationId !== child.operationId &&
									!terminal.includes(op.operationState) &&
									!(relatedStops.includes(op.operationId) && op.operationState === "waiting-verification") &&
									op.targets.some(target => target.kind === "run" && target.id === run.runId));
								const hasQueuedStop = queuedStopRecords().some(row => row.queueState !== "completed" &&
									Object.entries(binding).every(([key, value]) => isDeepStrictEqual(row[key], value)));
								if (!old || old.operationState !== "waiting-verification" || hasOtherStop || hasQueuedStop ||
									run.resultPreparationState?.state === "stop-requested" ||
									(run.state.executionState === "stop-requested" &&
										!old.results.some(result => result.action === "requestStop" && result.actualState?.executionState === "stop-requested")))
									throw fail("STOP_TARGET_NOT_READY");
								const registered = store.beginOperation({ manager: manager(), operation: stopRecord(run, resumeId, { retryOfStop: child.operationId }) });
								onOperationRegistered(registered);
								await requestAndVerify({ ...registered, run }, start.operationId);
								dispatched = true;
							}
						}
						const verified = dispatched || (await require("./stop-verification.cjs").verifyStoppedRun({
							store,
							runId: run.runId,
							inspect: () => inspect(current()),
							commitRecords: commit,
							timeoutMs: stopVerificationTimeoutMs,
							now
						})).verified;
						if (!verified) throw fail("STOP_VERIFICATION_PENDING");
						current();
						if (child) settleVerifiedStop(child.operationId, run.runId, commit);
						for (const id of relatedStops) settleVerifiedStop(id, run.runId, commit);
					} else {
						const action = previous.authorizationScope.action,
							task = store.read("task", item.taskId);
						if (!task || task.deleted) throw fail("OPERATION_TARGET_REMOVED");
						if (
							(action === "recycle" && task.recycleState === "recycled") ||
							(action === "restore" && task.recycleState !== "recycled")
						) {
							items.push({ ...item, outcome: "succeeded", message: "目标登记已完成，未重复执行" });
							continue;
						}
						const child = item.childOperationId && store.read("operation", item.childOperationId);
						if (
							child?.authorizationScope.task &&
							(child.authorizationScope.task.sourceSetId !== task.sourceSetId ||
								child.authorizationScope.task.sourceVersion !== task.sourceVersion)
						)
							throw fail("OPERATION_SCOPE_CHANGED");
						const retryPlan = await service.plan({
							action,
							taskIds: [item.taskId],
							groupId: previous.authorizationScope.groupId,
							...(child?.authorizationScope
								? {
										deleteLocal: child.authorizationScope.deleteLocal,
										deleteRemote: child.authorizationScope.deleteRemote,
										remindRemote: child.authorizationScope.remindRemote
									}
								: {})
						});
						const retried = await service.executePlan({
							planId: retryPlan.planId,
							batchOperationId: start.operationId
						});
						if (retried.items[0]?.outcome !== "succeeded")
							throw fail("OPERATION_RETRY_NOT_COMPLETED", retried.items[0]?.message);
					}
					items.push({ ...item, outcome: "succeeded" });
				} catch (error) {
					items.push({ ...item, outcome: "failed", message: error.message });
				}
				operations.update(start.operationId, {
					phase: "retrying",
					completed: items.length,
					total: selected.length,
					unit: "tasks",
					items
				});
			}
			operations.complete(start.operationId, { items });
		})();
		launchBackground(promise);
		return start;
	};
	return service;
}
module.exports = { createManagement, base, mutation };
