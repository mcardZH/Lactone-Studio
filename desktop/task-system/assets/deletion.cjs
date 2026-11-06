"use strict";
const { fs, path, fail, hashLocal, removeExact } = require("./io.cjs");
const { id, assertFrozenScope, withArtifactReferences, EXECUTION_BATCH_ITEMS, yieldIO } = require("./common.cjs");
const { inventory, ownedArtifactId } = require("./work-files.cjs");
const markers = require("../library/markers.cjs");
const { iterateRecords } = require("../operation-guards.cjs");
/** Deletion consumes a frozen explicit file inventory, never a recursive directory deletion. */
function createDeletion({
	library,
	libraryDirectory,
	localEnvironmentId,
	transport,
	begin,
	update,
	mutation,
	assertNoActiveIO,
	now
}) {
	function ownedWorkDirectory(task, run) {
		// Legacy records authorize their registered artifacts, not an expansion
		// into an arbitrary historical working parent or the library itself.
		if (!task.directoryMode) return false;
		const work = run.executionIdentity.workLocation;
		if (work.environmentId !== localEnvironmentId) return true;
		const relative = path.relative(work.path, libraryDirectory);
		return relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative));
	}
	async function planDeletion({
		manager,
		taskId,
		action,
		deleteLocal = true,
		deleteRemote = true,
		remindRemote = false
	}) {
		library.assertManager(manager);
		const task = library.read("task", taskId);
		if (!task || task.deleted) throw fail("TASK_NOT_FOUND");
		const run = task.latestRunId && library.read("run", task.latestRunId),
			candidates = [],
			seen = new Set();
		function add(environmentId, file, root, artifactId, role) {
			if (!file || path.basename(file).toLowerCase().endsWith(".ddwz")) return;
			const key = environmentId + ":" + file;
			if (!seen.has(key)) {
				seen.add(key);
				candidates.push({ environmentId, path: file, root, artifactId, role });
			}
		}
		for (const manifest of iterateRecords(library, "archiveManifest", { taskId }))
			for (const item of manifest.items || [])
				if (item.included && item.copyState === "copied")
					add(
						localEnvironmentId,
						item.recyclePath || item.targetPath,
						item.recyclePath ? path.dirname(item.recyclePath) : manifest.targetLocation.path,
						item.artifactId,
						"archive"
					);
		if (task.sourceSetId) {
			const set = library.read("sourceSet", task.sourceSetId);
			if (set) {
				const root = markers.resolveLocation(libraryDirectory, {
					scope: set.scope,
					path: set.directory
				});
				for (const file of set.files || [])
					add(
						localEnvironmentId,
						path.join(root, markers.relativePath(file.relativePath)),
						root,
						file.artifactId,
						"source"
					);
			}
		}
		if (action === "delete-task" && run)
			for (const artifact of iterateRecords(library, "artifact", { runId: run.runId }))
				for (const location of artifact.locations || [])
					if (location.role === "original") {
						const work = run.executionIdentity.workLocation,
							api = location.path.startsWith("/") ? path.posix : path.win32,
							relative = work && api.relative(work.path, location.path);
						if (
							work &&
							location.environmentId === work.environmentId &&
							relative &&
							relative !== ".." &&
							!relative.startsWith(".." + api.sep) &&
							!api.isAbsolute(relative)
						)
							add(
								location.environmentId,
								location.path,
								work.path,
								artifact.artifactId,
								"original"
							);
					}
		if (action === "delete-task" && run && ownedWorkDirectory(task, run)) {
			const work = run.executionIdentity.workLocation;
			if ((work.environmentId === localEnvironmentId ? deleteLocal : deleteRemote)) {
				try {
					const listing = await inventory(await transport(work.environmentId), work);
					for (const file of listing.files) add(work.environmentId, file.path, work.path, ownedArtifactId(run.runId, file.relativePath), "original");
					for (const entry of listing.exclusions) candidates.push({ ...entry, environmentId: work.environmentId, root: work.path, exclusion: true });
				} catch (error) {
					if (!require("../transports/file-errors.cjs").isMissingFile(error, work.path)) candidates.push({ ...work, root: work.path, exclusion: true, reason: error.code || error.message });
				}
			}
		}
		const files = [],
			unprocessed = [];
		for (const item of candidates) {
			if (item.exclusion) { unprocessed.push({ ...item, state: "unprocessed", reason: item.reason || "unsupported-entry" }); continue; }
			const local = item.environmentId === localEnvironmentId;
			if (local ? !deleteLocal : !deleteRemote) {
				unprocessed.push({ ...item, state: "not-selected" });
				continue;
			}
			try {
				const checked = local
					? await hashLocal(item.path)
					: await (async () => {
							const t = await transport(item.environmentId),
								identity = await t.stat(item.path),
								result = await t.hash({ path: item.path, identity, algorithm: "sha256" });
							return { ...result.identity, sha256: result.hash };
						})();
				files.push({ ...item, identity: checked });
			} catch (error) {
				if (error.code === "ENOENT" || /NOT_FOUND/.test(error.code || ""))
					unprocessed.push({ ...item, state: "missing" });
				else
					unprocessed.push({ ...item, state: "unprocessed", reason: error.code || error.message });
			}
		}
		return {
			taskId,
			action,
			taskRevision: task.revision,
			runId: run?.runId || null,
			runIdentity: run?.executionIdentity || null,
			files,
			unprocessed,
			deleteLocal,
			deleteRemote,
			remindRemote,
			byteSize: files.reduce((sum, row) => sum + row.identity.byteSize, 0),
			impact: `永久删除精确清单${files.length}个结果文件（${files.reduce((sum, row) => sum + row.identity.byteSize, 0)}字节）；${unprocessed.length}项缺失、未选择或远端未处理。${action === "cleanup-archive" ? "保留任务卡、标记和原位置。" : "在线活动任务先停止并核实退出；离线仅处理已选本地，远端不会重连自动补删。"}`
		};
	}
	function registerDeletion({ manager, plan }) {
		const task = library.read("task", plan.taskId);
		if (!task || task.revision !== plan.taskRevision) throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
		const targets = [{ kind: "task", id: task.taskId }];
		for (const row of iterateRecords(library, "archiveManifest", { taskId: task.taskId }))
			targets.push({ kind: "archiveManifest", id: row.manifestId });
		if (task.sourceSetId) targets.push({ kind: "sourceSet", id: task.sourceSetId });
		return { operationId: begin(manager, plan.action, targets, { ...plan, task }).operationId };
	}
	async function executeDeletion({ operationId, stopAndVerify, signal, onProgress }) {
		let op = library.read("operation", operationId);
		if (
			!op ||
			!["cleanup-archive", "delete-task"].includes(op.type) ||
			op.operationState !== "pending"
		)
			throw fail("ASSET_OPERATION_ALREADY_STARTED");
		assertFrozenScope(op);
		const scope = op.authorizationScope,
			run = scope.runId && library.read("run", scope.runId),
			remoteOffline = scope.unprocessed.some(
				(row) =>
					row.environmentId !== localEnvironmentId &&
					row.state === "unprocessed" &&
					/SSH|NETWORK|CONNECT|AUTH|UNREACHABLE|ECONN/i.test(row.reason || "")
			);
		if (library.read("task", scope.taskId)?.revision !== scope.taskRevision)
			throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
		op = update(op, "verifying-execution", "running");
		if (
			run &&
			(run.state.executionState !== "ended" || run.state.verificationState !== "verified")
		) {
			if (scope.action !== "delete-task") throw fail("ASSET_RUN_NOT_VERIFIED_ENDED");
			if (!remoteOffline) {
				if (!stopAndVerify || !(await stopAndVerify(scope.taskId)).verified) {
					update(op, "stop-not-verified", "failed", [
						{ state: "not-executed", reason: "实际退出尚未核实，原位置未删除" }
					]);
					throw fail("DELETE_STOP_NOT_VERIFIED");
				}
			}
		}
		const results = []; let completed = 0, pending = [], cancelled = signal?.aborted === true;
		async function recordResult(result) {
			results.push(result); completed++; pending.push(result);
			if (pending.length === EXECUTION_BATCH_ITEMS) {
				const progress = { completed, total: scope.files.length, unit: "files" };
				op = update(op, "deleting-files", "running", pending, [], progress); pending = [];
				onProgress?.(progress); await yieldIO();
			}
		}
		for (const file of scope.files) {
			if (signal?.aborted) { cancelled = true; break; }
			if (remoteOffline && file.environmentId !== localEnvironmentId) {
				await recordResult({ path: file.path, environmentId: file.environmentId, state: "unprocessed", reason: "offline" });
				continue;
			}
			const safe = await assertNoActiveIO({
				taskId: scope.taskId,
				runId: scope.runId,
				artifactIds: [file.artifactId],
				operationId,
				localOnly: remoteOffline && file.environmentId === localEnvironmentId
			});
			if (safe?.safe !== true) {
				await recordResult({ path: file.path, environmentId: file.environmentId, state: "retained", reason: safe?.reason || "active-io" });
				continue;
			}
			let result;
			try {
				await withArtifactReferences(library, file, file.artifactId, async () => {
				if (file.environmentId === localEnvironmentId) await removeExact(file.root, file.identity);
				else {
					const t = await transport(file.environmentId);
					await t.removeFile({
						path: file.path,
						identity: file.identity,
						sha256: file.identity.sha256,
						scopeRoot: file.root
					});
				}
				});
				result = { path: file.path, environmentId: file.environmentId, state: "deleted", byteSize: file.identity.byteSize };
			} catch (error) {
				result = { path: file.path, environmentId: file.environmentId, state: "retained", reason: error.code === "ASSET_SHARED_REFERENCE" ? "shared-reference" : error.code || error.message };
			}
			await recordResult(result);
		}
		if (cancelled) for (const file of scope.files.slice(completed)) results.push({ path: file.path, environmentId: file.environmentId, state: "retained", reason: "cancelled" });
		if (scope.action === "delete-task" && run && !remoteOffline && ownedWorkDirectory(library.read("task", scope.taskId), run)) {
			const work = run.executionIdentity.workLocation;
			if (work.environmentId === localEnvironmentId ? scope.deleteLocal : scope.deleteRemote) try {
				const listing = await inventory(await transport(work.environmentId), work);
				for (const file of listing.files) if (!results.some(result => result.path === file.path && result.state === "retained")) results.push({ path: file.path, environmentId: work.environmentId, state: "retained", reason: "not-in-confirmed-scope" });
			} catch (error) { if (!require("../transports/file-errors.cjs").isMissingFile(error, work.path)) results.push({ path: work.path, environmentId: work.environmentId, state: "retained", reason: error.code || error.message }); }
		}
		const task = library.read("task", scope.taskId),
			all = [...results, ...scope.unprocessed],
			retained = all.some((row) => ["retained", "unprocessed"].includes(row.state)),
			mutations = [];
		const anyDeleted = results.some((row) => row.state === "deleted"),
			localRetained = results.some((row) => row.state === "retained") || scope.unprocessed.some(row => row.environmentId === localEnvironmentId && row.state === "unprocessed");
		const next = {
			...task,
			revision: task.revision + 1,
			...(anyDeleted
				? {
						archiveState: retained ? "partially-cleaned" : "cleaned",
						...(task.postprocessCache ? { postprocessCache: null } : {})
					}
				: {}),
			deleted: scope.action === "delete-task" && !localRetained && !cancelled,
			requiredCapabilities:
				scope.action === "delete-task"
					? [...new Set([...(task.requiredCapabilities || []), "es:task-logical-recycle-v1"])]
					: task.requiredCapabilities,
			...(scope.remindRemote && remoteOffline
				? {
						remoteUnprocessedReminder: {
							runId: scope.runId,
							automaticAction: false,
							observedAt: now()
						}
					}
				: {})
		};
		mutations.push(mutation("task", task.taskId, next, task.revision));
		if (anyDeleted)
			for (const manifest of iterateRecords(library, "archiveManifest", { taskId: task.taskId }))
				mutations.push(
					mutation(
						"archiveManifest",
						manifest.manifestId,
						{
							...manifest,
							revision: manifest.revision + 1,
							status: retained ? "partially-cleaned" : "cleaned",
							cleanedAt: now()
						},
						manifest.revision
					)
				);
		if (anyDeleted && task.sourceSetId) {
			const set = library.read("sourceSet", task.sourceSetId);
			if (set)
				mutations.push(
					mutation(
						"sourceSet",
						set.sourceSetId,
						{ ...set, revision: set.revision + 1, state: "missing" },
						set.revision
					)
				);
		}
		if (next.deleted)
			for (const location of task.locations || [])
				if (location.markerPath) {
					const file =
						location.scope === "library"
							? path.resolve(libraryDirectory, markers.relativePath(location.markerPath))
							: location.markerPath;
					try {
						const marker = markers.readMarker(file);
						if (marker.value.id === task.taskId)
							markers.writeMarker(file, { ...marker.value, deleted: true }, marker.identity);
					} catch (error) {
						if (error.code !== "ENOENT")
							results.push({ path: file, state: "retained", reason: error.code });
					}
				}
		const progress = { completed, total: scope.files.length, unit: "files" };
		update(op, "finished", cancelled ? "cancelled" : retained ? "partial" : "succeeded", [...results.slice(completed - pending.length), ...scope.unprocessed], mutations, progress);
		onProgress?.(progress);
		return { results: all, retained, ...(cancelled ? { cancelled: true } : {}) };
	}
	return { planDeletion, registerDeletion, executeDeletion };
}
module.exports = { createDeletion };
