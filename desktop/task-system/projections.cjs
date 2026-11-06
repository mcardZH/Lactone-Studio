"use strict";
const path = require("node:path");
const { listAll } = require("./operation-guards.cjs");
const { failureNotices } = require("./task-failures.cjs");
const { taskStopControl } = require("./stop-control.cjs");
const { groupIds } = require("./library/organization.cjs");
const { resolveLocation } = require("./library/markers.cjs");
const { runtimeTiming } = require("./runtime-timing.cjs");
function verifiedStopDisposition(store, run) {
	const stop = run?.stopDisposition, execution = run?.executionIdentity, end = execution?.endReceipt;
	if (stop?.kind !== "posix-term-verified" || !run.requiredCapabilities?.includes("es:task-posix-stop-dispatch-v1") ||
		run.state.executionState !== "ended" || run.state.verificationState !== "verified" ||
		stop.taskId !== run.taskId || stop.runId !== run.runId || stop.submissionIntentId !== execution.submissionIntentId ||
		stop.endReceiptId !== end?.receiptId || !Number.isInteger(stop.exitCode) || stop.exitCode === 0 ||
		stop.exitCode !== end?.payload.exitCode || typeof stop.launchReceiptId !== "string" || !stop.launchReceiptId) return null;
	const launch = execution.launchReceipt || store.readExecutionReceipt?.(stop.launchReceiptId);
	return launch?.receiptId === stop.launchReceiptId && launch.eventType === "run.launched" &&
		launch.taskId === run.taskId && launch.runId === run.runId && launch.submissionIntentId === stop.submissionIntentId &&
		launch.operationId === end.operationId ? stop : null;
}
function locationPath(store, value, libraryDirectory) {
	if (!value || typeof value.path !== "string") return null;
	try {
		if (value.scope === "library") {
			const root = libraryDirectory || store.describe?.().root;
			return typeof root === "string" ? resolveLocation(root, value) : null;
		}
		return path.isAbsolute(value.path) || path.win32.isAbsolute(value.path) ? value.path : null;
	} catch {
		return null;
	}
}
function currentSourceSet(store, task) {
	const source = task.sourceSetId && store.read("sourceSet", task.sourceSetId);
	return source?.taskId === task.taskId && source.sourceVersion === task.sourceVersion ? source : null;
}
/** Select a declared primary identity, never the first currently readable file. */
function taskMainFile(store, taskId, files) {
	const task = store.read("task", taskId);
	if (!task || task.deleted || task.resultsInvalidatedByOverwrite) return null;
	const run = task.latestRunId && store.read("run", task.latestRunId);
	if (run) {
		if (run.taskId != null && run.taskId !== taskId) return null;
		if (run.primaryOutputArtifactId) {
			const matches = files.filter(file => file.artifactId === run.primaryOutputArtifactId);
			return matches.length === 1 ? matches[0] : null;
		}
		const primary = files.filter(file => file.role?.split("、").includes("primary-output"));
		return primary.length === 1 ? primary[0] : null;
	}
	const source = currentSourceSet(store, task);
	if (!source || !["archived", "external"].includes(source.state) || !Array.isArray(source.files)) return null;
	let candidates;
	if (source.main != null) {
		if (typeof source.main !== "string") return null;
		const main = source.main.replace(/\\/g, "/");
		if (main.startsWith("/") || /^[a-z]:/i.test(main) || main.split("/").some(part => !part || part === "." || part === "..")) return null;
		candidates = source.files.filter(file => file.relativePath?.replace(/\\/g, "/") === main || file.name?.replace(/\\/g, "/") === main);
	} else {
		// Older source sets can be adapted only when a supported role is unique.
		const primary = source.files.filter(file => file.roles?.includes("primary-output"));
		candidates = primary.length ? primary : source.files.filter(file =>
			file.roles?.some(role => ["wavefunction", "trajectory", "structure", "modes"].includes(role)));
	}
	if (candidates.length !== 1 || typeof candidates[0].artifactId !== "string") return null;
	const matches = files.filter(file => file.artifactId === candidates[0].artifactId && file.sourceIdentity?.sourceSetId === source.sourceSetId);
	return matches.length === 1 ? matches[0] : null;
}
function displaySnapshot(snapshot, task, run, sourceSet, sourceVersion, readerVersion) {
	if (task.resultsInvalidatedByOverwrite || !run && sourceSet && !["archived", "external"].includes(sourceSet.state) ||
		!snapshot || snapshot.schema !== 1 || snapshot.readerImplementationVersion !== (readerVersion ?? null) ||
		typeof sourceVersion !== "string" || snapshot.sourceVersion !== sourceVersion ||
		snapshot.owner?.taskId !== task.taskId || snapshot.owner.runId !== (run?.runId || null) ||
		(run ? snapshot.owner.sourceSetId !== null || snapshot.owner.sourceVersion !== null :
			!sourceSet || snapshot.owner.sourceSetId !== sourceSet.sourceSetId || snapshot.owner.sourceVersion !== sourceSet.sourceVersion) ||
		!Array.isArray(snapshot.structures) || snapshot.structures.length !== 1) return null;
	const structure = snapshot.structures[0], atoms = structure?.atoms;
	if (!Array.isArray(atoms) || !atoms.length || atoms.some(atom => typeof atom.id !== "string" || !atom.id ||
		typeof atom.element !== "string" || !atom.element || ![atom.x, atom.y, atom.z].every(Number.isFinite)) ||
		new Set(atoms.map(atom => atom.id)).size !== atoms.length ||
		structure.bonds !== undefined && (!Array.isArray(structure.bonds) || structure.bonds.some(bond =>
			![bond.a, bond.b].every(index => Number.isSafeInteger(index) && index >= 0 && index < atoms.length) || !Number.isFinite(bond.order)))) return null;
	return structure;
}
function taskCard(store, task, stopOptions) {
	const run = task.latestRunId ? store.read("run", task.latestRunId) : null;
	const resolvePath = (value) => locationPath(store, value, stopOptions?.libraryDirectory);
	const sourceSet = currentSourceSet(store, task);
	const sourcePath = sourceSet
		? resolvePath({ scope: sourceSet.scope, path: sourceSet.directory })
		: null;
	const matchingArchive = (task.locations || [])
		.filter(
			(location) =>
				location.kind === "archive" &&
				location.sourceSetId === task.sourceSetId &&
				location.sourceVersion === task.sourceVersion
		)
		.map(resolvePath)
		.filter(Boolean);
	const sourceCandidates = [
		...new Set(
			(task.locations || [])
				.filter(
					(location) =>
						["external", "archive"].includes(location.kind) &&
						location.sourceSetId === task.sourceSetId &&
						location.sourceVersion === task.sourceVersion
				)
				.map(resolvePath)
				.filter(Boolean)
		)
	];
	const observed = task.observedSource,
		observedMatches =
			!run &&
			sourceSet &&
			observed?.sourceSetId === sourceSet.sourceSetId &&
			observed.sourceVersion === sourceSet.sourceVersion &&
			observed.readerImplementationVersion === stopOptions?.readerImplementationVersion;
	const env = run?.environmentSnapshot,
		archive = listAll(store, "archiveManifest", { taskId: task.taskId })
			.find((value) => value.status === "verified" && (!run || value.runId === run.runId));
	const directoryMode = task.directoryMode || (task.plannedArchiveLocation || archive ? "dual" : env?.connection.kind === "local" ? "single" : "dual");
	const archiveOperation = run && listAll(store, "operation").filter(operation => operation.type === "archive" && operation.authorizationScope?.manifest?.runId === run.runId).at(-1);
	const archiveObservation = stopOptions?.archiveObservations?.get(task.taskId);
	const summaryCurrent = !!run?.monitorSummary?.revision && run.monitorSummary.readerImplementationVersion === stopOptions?.readerImplementationVersion;
	const limitedState = summaryCurrent ? Object.values(run.state.scientificState || {}).find(value => value.active !== false && value.source?.kind === "scientific-monitor" && value.source.revision === run.monitorSummary.revision && (["not-satisfied", "conflict"].includes(value.state) || ["damaged-tail", "changed-during-read", "incomplete", "partial", "no-compatible-companion", "unsupported", "conflict"].includes(value.diagnosticStatus))) : null;
	const limitedNotice = summaryCurrent ? (run.monitorSummary.notices || []).find(notice => notice.limited === true || notice.severity === "error" || notice.kind === "limited") : null;
	const sourceArchived = !run && sourceSet?.state === "archived";
	const archiveState = archiveObservation && archiveObservation.runId === (run?.runId || null) && archiveObservation.state === "failed" ? "failed" : ["cleared", "cleaned"].includes(task.archiveState) ? "cleared" : archive || sourceArchived ? "archived" : archiveOperation && !["succeeded", "failed", "cancelled", "partial", "waiting-verification"].includes(archiveOperation.operationState) ? "archiving" : archiveOperation && ["failed", "partial", "waiting-verification"].includes(archiveOperation.operationState) ? "failed" : "unarchived";
	const readerVersion = stopOptions?.readerImplementationVersion;
	const thumbnailVersion = run ? run.monitorSummary?.thumbnailSourceVersion : task.thumbnailSourceVersion;
	const thumbnailStructure = displaySnapshot(run ? run.monitorSummary?.thumbnailSnapshot : task.thumbnailSnapshot,
		task, run, sourceSet, thumbnailVersion, readerVersion);
	const nativeEnd = run?.executionIdentity.endReceipt?.payload;
	const stopDisposition = verifiedStopDisposition(store, run);
	return {
		taskId: task.taskId,
		runId: run?.runId || null,
		displayName: task.displayName,
		engineId: observedMatches && observed.engineId ? observed.engineId : task.engineId,
		taskKind:
			observedMatches && observed.taskKind
				? observed.taskKind
				: task.taskKind === "external-input"
					? "外部计算"
					: task.taskKind,
		formula: task.formula || null,
		createdAt: task.createdAt,
		lastSubmittedAt: task.lastSubmittedAt || task.createdAt,
		...runtimeTiming(run),
		resultLimited: !!(limitedState || limitedNotice),
		resultLimitReason: limitedState?.reason || limitedState?.label || limitedNotice?.message || null,
		directoryMode,
		workFileState: task.workFileState || "unknown",
		...(directoryMode === "dual" ? { archiveState } : {}),
		failureKind: run?.state.verificationState === "unknown" && ["unknown", "submitting"].includes(run?.state.executionState) ? "verification" : run?.state.endReason === "failed" ? run.executionIdentity.launchReceipt || stopDisposition ? "execution" : "submission" : null,
		environmentId: env?.environmentId || "",
		environmentName: env?.configuration?.displayName || env?.environmentId || "",
		connectionKind: env?.connection.kind || "local",
		schedulerKind: env?.scheduler.kind || "none",
		groupId: task.groupId,
		groupIds: groupIds(store, task),
		noRun: !run,
		origin: task.origin,
		sourceSetId: task.sourceSetId || null,
		sourceVersion: task.sourceVersion || null,
		sourceSummary: task.sourceSummary || null,
		locations: task.locations || [],
		thumbnail: null,
		thumbnailStructure: thumbnailStructure || task.inputStructure || null,
		thumbnailSourceVersion:
			(thumbnailStructure ? thumbnailVersion : null) ||
			task.inputStructureSourceVersion ||
			task.inputStructureTextSha256 ||
			undefined,
		resourceSummary: run?.resources?.inputRequest
			? {
					cpuLabel: run.resources.inputRequest.mpiProcesses ? "进程" : "共享线程",
					cpuValue:
						run.resources.inputRequest.mpiProcesses ||
						run.resources.inputRequest.threadsPerProcess ||
						run.resources.inputRequest.cpuCores ||
						null,
					memoryValue: run.resources.inputRequest.memory?.value?.toString() || null,
					memoryUnit: run.resources.inputRequest.memory?.unit || null,
					memoryScope: run.resources.inputRequest.memory?.scope || null
				}
			: null,
		executionState: run?.state.executionState || "unknown",
		verificationState: run?.state.verificationState || "unknown",
		checkedAt: run?.state.checkedAt || null,
		stopControl: taskStopControl(store, run, stopOptions),
		...(run?.state.endReason ? { endReason: stopDisposition ? "stopped" : run.state.endReason } : {}),
		...(stopDisposition ? { stopDisposition } : {}),
		...(stopDisposition || nativeEnd?.nativeExitReason ? {
			nativeEndReason: nativeEnd.nativeExitReason || nativeEnd.endReason, nativeExitCode: nativeEnd.exitCode
		} : {}),
		archived:
			!!archive || sourceArchived,
		recycled: task.recycleState === "recycled",
		workPath: run?.executionIdentity.workLocation?.path || null,
		sourcePath: !run
			? sourcePath || (sourceCandidates.length === 1 ? sourceCandidates[0] : null)
			: null,
		archivePath:
			resolvePath(archive?.targetLocation) ||
			resolvePath({ path: archive?.archiveDirectory || archive?.directory }) ||
			(archive?.items?.find((x) => x.targetPath)?.targetPath
				? resolvePath({ path: path.dirname(archive.items.find((x) => x.targetPath).targetPath) })
				: null) ||
			(sourceSet?.state === "archived" ? sourcePath : null) ||
			(!run && sourceSet?.state === "archived" && new Set(matchingArchive).size === 1
				? matchingArchive[0]
				: null) || (directoryMode === "dual" ? task.plannedArchiveLocation?.path || null : null)
	};
}
function taskDetail(store, taskId, readerImplementationVersion = null, stopOptions) {
	const task = store.read("task", taskId);
	if (!task) throw Object.assign(new Error("任务不存在"), { code: "TASK_NOT_FOUND" });
	const run = store.read("run", task.latestRunId),
		sourceSet = !run ? currentSourceSet(store, task) : null,
		summary = run?.monitorSummary || {},
		compatibleReader =
			(summary.readerImplementationVersion ?? null) === readerImplementationVersion;
	const archiveByArtifact = new Map();
	for (const manifest of listAll(store, "archiveManifest", { taskId })) if (manifest.runId === run?.runId && manifest.status === "verified")
		for (const item of manifest.items || []) if (item.included && item.verificationState === "verified" && item.storageState !== "recycled" && !archiveByArtifact.has(item.artifactId)) archiveByArtifact.set(item.artifactId, manifest);
	const files = (
		run ? listAll(store, "artifact", { runId: run.runId }) : listAll(store, "artifact", { taskId })
	).map((artifact) => {
		const archive = archiveByArtifact.get(artifact.artifactId);
		const archivedItem = archive?.items.find(item => item.artifactId === artifact.artifactId && item.included);
		const location = archivedItem ? { environmentId: archive.targetLocation.environmentId, path: archivedItem.targetPath, role: "archive" } : artifact.locations?.find((x) => x.role === "original" || x.role === "prepared") || artifact.locations?.find((x) => x.path);
		const sourceFile = !run && sourceSet?.files?.find(file => file.artifactId === artifact.artifactId);
		const unavailableSource = !run && (!sourceSet || artifact.sourceSetId !== sourceSet.sourceSetId || !sourceFile || ["cleared", "deleted", "recycled"].includes(sourceSet.state));
		const work = run?.executionIdentity.workLocation, api = work?.path.startsWith("/") ? path.posix : path.win32;
		const relative = work && location?.path ? api.relative(work.path, location.path) : null;
		const insideWork = relative && relative !== ".." && !relative.startsWith(".." + api.sep) && !api.isAbsolute(relative);
		const cleared = (task.workFileState === "cleared" && insideWork || task.resultsInvalidatedByOverwrite) && !archivedItem && location?.role !== "frozen-input";
		return {
			artifactId: artifact.artifactId,
			name:
				artifact.originalName ||
				artifact.preparedName ||
				path.basename(location?.path || artifact.artifactId),
			role: artifact.roles.join("、"),
			size: archivedItem?.byteSize ?? artifact.byteSize,
			sourceKind: archivedItem || location?.role === "archive" ? "archive" : "work",
			checkedAt: artifact.observedAt || null,
			verificationState:
				unavailableSource ? "unknown" : archivedItem?.verificationState || artifact.verificationState || (run && artifact.integrity === "complete" ? "verified" : "unknown"),
			path: location?.path || "",
			kind: artifact.representation || "unknown",
			sourceIdentity: {
				artifactId: artifact.artifactId,
				revision: artifact.revision,
				sourceSetId: artifact.sourceSetId || null
			},
			exists: cleared || unavailableSource ? false : run && (artifact.integrity === "complete" || archivedItem) ? true : null
		};
	});
	const mainFile = taskMainFile(store, taskId, files);
	const card = taskCard(store, task, { ...stopOptions, readerImplementationVersion });
	return {
		task: card,
		files,
		stage: compatibleReader ? summary.stage || null : null,
		iteration: compatibleReader ? summary.iteration || null : null,
		...runtimeTiming(run),
		resultSource: !mainFile || mainFile.exists === false || task.resultsInvalidatedByOverwrite ? null : mainFile.sourceKind === "archive" ? { kind: "archive", path: task.plannedArchiveLocation?.path || path.dirname(mainFile.path) } : run ? { kind: "work", path: run.executionIdentity.workLocation.path } : null,
		updatedAt: summary.updatedAt || run?.state.checkedAt || null,
		notices: [
			...(compatibleReader ? summary.notices || [] : []),
			...(run?.auxCollectionState?.warnings || []),
			...(card.nativeExitCode != null && card.endReason === "stopped" ? [{
				id: `${run.runId}:verified-stop-native-exit`,
				message: `已核实停止，原生退出码 ${card.nativeExitCode}`,
				details: JSON.stringify({ nativeEndReason: card.nativeEndReason, nativeExitCode: card.nativeExitCode,
					stopDisposition: card.stopDisposition || null }, null, 2)
			}] : []),
			...failureNotices(run)
		],
		scientificStates: Object.entries(compatibleReader ? run?.state.scientificState || {} : {})
			.filter(([, value]) => value.source?.kind === "scientific-monitor" && value.active !== false)
			.map(([key, value]) => ({
				key,
				label: value.label,
				state: value.state,
				jobIndex: value.jobIndex,
				segmentIndex: value.segmentIndex,
				...(typeof value.stageId === "string" && value.hasStageId !== false
					? { stageId: value.stageId }
					: {}),
				...(value.frameIndex !== undefined && value.hasFrameIndex !== false
					? { frameIndex: value.frameIndex }
					: {}),
				...(typeof value.sourceLine === "number" && value.hasSourceLine !== false
					? { sourceLine: value.sourceLine }
					: {}),
				sourceLabel: value.sourceLabel,
				evidenceRefs: value.evidenceRefs,
				...(value.raw !== undefined && value.hasRaw !== false ? { raw: value.raw } : {}),
				...(value.reason !== undefined ? { reason: value.reason } : {})
			}))
	};
}
module.exports = { taskCard, taskDetail, taskMainFile, runtimeTiming, verifiedStopDisposition };
