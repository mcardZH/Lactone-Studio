"use strict";
const path = require("node:path");
const sensitive =
	/^(?:password|passphrase|privateKey|privateKeyPassphrase|secret|credentials?|authorization|cookie|token|environment|env)$/i;
function safeText(value, limit = 8192) {
	return String(value)
		.replace(
			/((?:password|passphrase|authorization|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"$1[redacted]"
		)
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
			"[private key redacted]"
		)
		.slice(0, limit);
}
function safeValue(value, depth = 0) {
	if (value === undefined) return null;
	if (value == null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return safeText(value);
	if (depth >= 3) return "[bounded]";
	if (Array.isArray(value)) return value.slice(0, 16).map((item) => safeValue(item, depth + 1));
	if (typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, 32)
				.map(([key, item]) => [
					key,
					sensitive.test(key) ? "[redacted]" : safeValue(item, depth + 1)
				])
		);
	return safeText(value, 512);
}
function describeFailure(error, { stage, operationId, now = () => new Date().toISOString() } = {}) {
	const value = {
		code: safeText(error?.code || "TASK_OPERATION_FAILED", 120),
		stage: stage ?? null,
		operationId: operationId || null,
		message: safeText(error?.message || error || "任务操作失败"),
		details: safeValue(error?.details),
		observedAt: now()
	};
	if (JSON.stringify(value).length > 16384)
		value.details = { boundedOriginal: safeText(JSON.stringify(value.details), 8192) };
	return value;
}
function verifiedNotStarted(run) {
	const receipt = run?.executionIdentity?.endReceipt, payload = receipt?.payload, tree = payload?.processTree;
	return !(run?.state?.executionState !== "ended" || !["failed", "stopped"].includes(run.state.endReason) || run.state.verificationState !== "verified" ||
		run.executionIdentity.launchReceipt || run.executionReceiptConflicts?.length || receipt?.eventType !== "run.ended" ||
		receipt.taskId !== run.taskId || receipt.runId !== run.runId || receipt.submissionIntentId !== run.executionIdentity.submissionIntentId ||
		!run.submitOperationId || receipt.operationId !== run.submitOperationId || payload?.notStarted !== true || payload.endReason !== run.state.endReason ||
		run.resultPreparationState?.launchReceipt || tree?.verified !== true || tree.notStarted !== true || tree.activeProcesses !== 0);
}
function prelaunchReadFailure(run, failure) {
	if (!verifiedNotStarted(run) || !["scientific-source", "scientific-refresh", "auxiliary-collection"].includes(failure?.stage) ||
		failure.code !== "FILE_NOT_FOUND" || failure.details?.missing !== true || failure.details.nativeCode !== "ENOENT") return false;
	const api = run.environmentSnapshot?.connection?.kind === "local" && run.softwareSnapshot?.platform === "win32" ? path.win32 : path.posix,
		root = run.executionIdentity.workLocation?.path, file = failure.details.path;
	if (typeof root !== "string" || typeof file !== "string" || !api.isAbsolute(root) || !api.isAbsolute(file)) return false;
	const relative = api.relative(root, file);
	return relative === "" || (relative !== ".." && !relative.startsWith(".." + api.sep) && !api.isAbsolute(relative));
}
function prelaunchFailure(run) {
	const receipt = run?.executionIdentity?.endReceipt, payload = receipt?.payload;
	if (!verifiedNotStarted(run) || payload.endReason !== "failed" || payload.processTree.scope !== "pre-launch-preparation" ||
		typeof payload.code !== "string" || !payload.code) return null;
	return describeFailure({ code: payload.code, message: "提交准备失败，原生计算未启动", details: { recoveredFrom: receipt.receiptId, evidenceRefs: receipt.evidenceRefs || [] } },
		{ stage: "control-prepare", operationId: receipt.operationId, now: () => receipt.occurredAt });
}
function failureNotices(run) {
	const failures = { ...(run?.taskFailures || {}) };
	// Older failed prepares could lose their error before commit. Only their exact
	// verified never-started END can recover it; do not invent an error for a cancel.
	if (!failures["control-prepare"]) failures["control-prepare"] = prelaunchFailure(run);
	return Object.values(failures)
		.filter(failure => failure && !prelaunchReadFailure(run, failure))
		.map((failure) => ({
			id: `${run.runId}:${failure.operationId || "monitor"}:${failure.stage}:${failure.code}`,
			message: failure.stage === "control-prepare"
				? shortFailureReason(failure.code)
				: failure.stage?.startsWith("control-")
				? "提交回执待核实，请查看详情"
				: "本次任务状态或结果读取未完成，请查看详情",
			details: JSON.stringify(
				{
					stage: failure.stage,
					code: failure.code,
					message: failure.message,
					details: failure.details
				},
				null,
				2
			)
		}));
}
function shortFailureReason(code) {
	const reasons = { WORK_DIRECTORY_EXISTS: "工作目录已存在，输入准备失败", EXTERNAL_OUTPUT_ALREADY_EXISTS: "输出文件已存在，输入准备失败", DEPENDENCY_SOURCE_CHANGED: "依赖文件已改变，请重新选择", INPUT_SOURCE_CHANGED: "输入文件已改变，请重新选择", INPUT_LEASE_CLOSE_FAILED: "输入读取未正常结束，请查看详情", EACCES: "没有目录写入权限", EPERM: "没有目录写入权限", ENOSPC: "磁盘空间不足", ECONNREFUSED: "无法连接执行环境", GAUSSIAN_WINDOWS_TASK_PATH_UNVERIFIED: "G16W任务路径尚未验证，暂不能提交" };
	return reasons[code] || "提交准备失败，请查看详情";
}
function updateFailures(store, runId, change, { manager, permit } = {}) {
	const current = store.read("run", runId);
	if (!current) return;
	const taskFailures = { ...(current.taskFailures || {}) };
	change(taskFailures);
	// Protocol merge preserves omitted extension keys. Null is the explicit inactive value.
	for (const key of Object.keys(current.taskFailures || {}))
		if (!Object.hasOwn(taskFailures, key)) taskFailures[key] = null;
	if (JSON.stringify(taskFailures) === JSON.stringify(current.taskFailures || {})) return;
	const value = { ...current, revision: current.revision + 1, taskFailures },
		mutations = [{ kind: "run", id: runId, expectedRevision: current.revision, value }];
	if (permit) {
		const operation = store.operationPermit(permit);
		store.commitOperation({
			permit,
			expectedRevision: operation.revision,
			operation: { ...operation, revision: operation.revision + 1 },
			mutations
		});
	} else store.commit({ manager, mutations });
}
module.exports = { describeFailure, failureNotices, updateFailures, shortFailureReason, prelaunchFailure, verifiedNotStarted, prelaunchReadFailure };
