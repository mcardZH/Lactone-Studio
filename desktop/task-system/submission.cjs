"use strict";
const { SCHEDULER_END_CAPABILITY, verifiedOwnerEndReceipt } = require("./execution/scheduler-end.cjs");
const { listAll, iterateRecords } = require("./operation-guards.cjs");
const { withArtifactReferences, EXECUTION_BATCH_ITEMS, yieldIO } = require("./assets/common.cjs");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { createSoftwareAdapter } = require("./engines/adapters.cjs");
const { base, mutation } = require("./management.cjs");
const { fail, noLinks } = require("./platform/global-settings.cjs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function safeName(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value === "..")
		throw fail("INPUT_NAME_UNSAFE");
	return value;
}
async function hashFile(file, { signal } = {}) {
	noLinks(file);
	const before = await fsp.stat(file);
	if (!before.isFile()) throw fail("INPUT_NOT_REGULAR_FILE");
	const hash = crypto.createHash("sha256"),
		stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024, signal });
	for await (const chunk of stream) hash.update(chunk);
	const after = await fsp.stat(file);
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs
	)
		throw fail("INPUT_SOURCE_CHANGED");
	return {
		hash: hash.digest("hex"),
		byteSize: after.size,
		fileId: `${after.dev}:${after.ino}`,
		mtimeMs: after.mtimeMs,
		ctimeMs: after.ctimeMs
	};
}
function executionRequest(run, action, operationId, payload = {}) {
	return {
		protocolVersion: 1,
		requestId: crypto.randomUUID(),
		action,
		environmentId: run.environmentSnapshot.environmentId,
		adapterTarget: run.environmentSnapshot.scheduler.kind === "slurm" ? "slurm" : "process",
		taskId: run.taskId,
		runId: run.runId,
		submissionIntentId: run.executionIdentity.submissionIntentId,
		operationId,
		preconditions: {},
		payloadVersion: 1,
		payload: { workLocation: run.executionIdentity.workLocation, ...payload }
	};
}
function createSubmission({
	store,
	directory,
	localEnvironmentId,
	manager,
	environmentFor,
	softwareFor,
	execution,
	transportFor,
	assertNoActiveIO = async () => ({ safe: true }),
	chooseDependencyFiles,
	ownerId,
	now = () => new Date().toISOString(),
	runtimeAssets = {},
	inputStructureRuntime,
	resolveResultPreparation,
	dependencyRegistry = {},
	shouldStopBeforeSubmit = () => false,
	stopOperationFor = () => null,
	ioAdmission,
	onControlFailure = () => {},
	onRegistered,
	onOperationRegistered = () => {},
	launchBackground = (promise) => promise.catch(() => {})
}) {
	const sources = (dependencyRegistry.sources ||= new Map()),
		previews = (dependencyRegistry.previews ||= new Map()),
		stages = (dependencyRegistry.stages ||= new Map()),
		submitFlights = (dependencyRegistry.submitFlights ||= new Map()),
		overwritePlans = (dependencyRegistry.overwritePlans ||= new Map());
	function assertResubmittable(taskId) {
		const task = store.read("task", taskId), run = task && store.read("run", task.latestRunId);
		if (!task || !run || task.deleted) throw fail("TASK_NOT_FOUND");
		if (!verifiedOwnerEndReceipt(run)) throw fail("RESUBMIT_STOP_REQUIRED", "请先停止任务并核实运行结束。");
		return { task, run };
	}
	async function resubmitDraft({ taskId }) {
		store.assertManager(manager());
		const { task, run } = assertResubmittable(taskId), snapshot = store.read("inputSnapshot", run.inputSnapshotId);
		if (!snapshot?.submittedFiles?.length) throw fail("RESUBMIT_INPUT_UNAVAILABLE");
		const dependencies = [];
		let finalInputText;
		for (const file of snapshot.submittedFiles) {
			const target = path.join(directory, "inputs", safeName(run.runId), safeName(file.name)), identity = await hashFile(target);
			if (identity.hash !== file.sha256 || identity.byteSize !== file.byteSize) throw fail("FROZEN_INPUT_CHANGED");
			if (file.artifactId === snapshot.primaryInputArtifactId) finalInputText = new TextDecoder("utf-8", { fatal: true }).decode(await fsp.readFile(target));
			else { const sourceRef = "source-" + crypto.randomUUID(); sources.set(sourceRef, { file: target, name: file.name, identity }); dependencies.push({ name: file.name, sourceRef, role: "input", size: identity.byteSize }); }
		}
		if (typeof finalInputText !== "string") throw fail("RESUBMIT_INPUT_UNAVAILABLE");
		return { resubmitTaskId: taskId, environmentId: run.environmentSnapshot.environmentId, displayName: task.displayName,
			groupIds: require("./library/organization.cjs").groupIds(store, task),
			input: { engineId: task.engineId, inputName: snapshot.preparedName, finalInputText, dependencies, suggestedName: task.displayName, projectId: task.sourceProjectRef?.projectId || null, resources: [] } };
	}
	async function overwritePreview({ resubmitTaskId, submissionPlanId }) {
		store.assertManager(manager());
		const { task, run } = assertResubmittable(resubmitTaskId), plan = previews.get(submissionPlanId);
		if (!plan || plan.taskId !== task.taskId) throw fail("SUBMISSION_PLAN_EXPIRED");
		if ((await assertNoActiveIO({ taskId: task.taskId, runId: run.runId })).safe !== true) throw fail("ASSET_ACTIVE_IO_OR_DEPENDENCY");
		const { inventory } = require("./assets/work-files.cjs"), locations = [{ kind: "work", ...run.executionIdentity.workLocation }];
		if (task.plannedArchiveLocation && !(task.plannedArchiveLocation.environmentId === locations[0].environmentId && task.plannedArchiveLocation.path === locations[0].path)) locations.push({ kind: "archive", ...task.plannedArchiveLocation });
		for (const manifest of iterateRecords(store, "archiveManifest", { taskId: task.taskId })) if (manifest.runId === run.runId && manifest.status === "verified" && !locations.some(location => location.environmentId === manifest.targetLocation.environmentId && location.path === manifest.targetLocation.path)) locations.push({ kind: "archive", ...manifest.targetLocation });
		const targets = [];
		for (const location of locations) {
			const t = await transportFor(location.environmentId);
			try { const listing = await inventory(t, location, { includeManagement: true, hash: true }); if (listing.exclusions.length) throw fail("RESUBMIT_UNSUPPORTED_WORK_ENTRY"); targets.push({ location, ...listing }); }
			catch (error) { if (!require("./transports/file-errors.cjs").isMissingFile(error, location.path)) throw error; targets.push({ location, rootIdentity: null, files: [] }); }
		}
		const overwritePlanId = "overwrite-" + crypto.randomUUID();
		overwritePlans.set(overwritePlanId, { taskId: task.taskId, runId: run.runId, submissionPlanId, targets });
		const workFiles = targets.filter(target => target.location.kind === "work").flatMap(target => target.files.map(file => ({ path: file.path, byteSize: file.byteSize }))), archiveFiles = targets.filter(target => target.location.kind === "archive").flatMap(target => target.files.map(file => ({ path: file.path, byteSize: file.byteSize })));
		return { overwritePlanId, workFiles, archiveFiles, workBytes: workFiles.reduce((sum,file) => sum + file.byteSize, 0), archiveBytes: archiveFiles.reduce((sum,file) => sum + file.byteSize, 0) };
	}
	async function executeOverwrite(request, replacement) {
		const plan = overwritePlans.get(request.overwritePlanId);
		if (!plan || plan.taskId !== request.resubmitTaskId || plan.submissionPlanId !== request.submissionPlanId) throw fail("RESUBMIT_CONFIRMATION_REQUIRED");
		const { run } = assertResubmittable(plan.taskId);
		if (run.runId !== plan.runId || (await assertNoActiveIO({ taskId: plan.taskId, runId: plan.runId })).safe !== true) throw fail("RESUBMIT_SOURCE_CHANGED");
		const { inventory } = require("./assets/work-files.cjs"), { unchanged } = require("./assets/io.cjs");
		// Recheck the complete confirmed set before the first irreversible action.
		for (const target of plan.targets) {
			const t = await transportFor(target.location.environmentId);
			if (!target.rootIdentity) continue;
			const listing = await inventory(t, target.location, { includeManagement: true });
			const expected = new Map(target.files.map(file => [file.path, file]));
			if (listing.rootIdentity.fileId !== target.rootIdentity.fileId || listing.exclusions.length || listing.files.length !== target.files.length || listing.files.some(file => !expected.has(file.path) || !unchanged(expected.get(file.path).identity, file.identity))) throw fail("RESUBMIT_FILES_CHANGED");
		}
		const archives = listAll(store, "archiveManifest", { taskId: plan.taskId }).filter(manifest => manifest.runId === plan.runId && manifest.status === "verified"), task = store.read("task", plan.taskId);
		const registered = store.beginOperation({ manager: manager(), operation: { ...base(), requiredCapabilities: ["es:task-overwrite-v1"], operationId: "overwrite-" + crypto.randomUUID(), type: "overwrite-task", targets: [{ kind: "task", id: task.taskId }, { kind: "run", id: run.runId }, ...archives.map(manifest => ({ kind: "archiveManifest", id: manifest.manifestId }))], preconditions: {}, authorizationScope: { taskId: task.taskId, runId: run.runId, submissionPlanId: plan.submissionPlanId, targets: plan.targets, inventorySha256: sha(JSON.stringify(plan.targets)), replacement }, phase: "confirmed-input-frozen", operationState: "pending", results: [] } });
		onOperationRegistered(registered);
		let operation = registered.operation;
		function persist(state, phase, mutations = [], result) {
			operation = store.commitOperation({ permit: registered.permit, expectedRevision: operation.revision, operation: { ...operation, revision: operation.revision + 1, operationState: state, phase, results: [...operation.results, ...(Array.isArray(result) ? result : result ? [result] : [])], transitionEvidence: { type: state === "succeeded" ? "operation-complete" : "verification", checkedAt: now(), evidenceRefs: ["operation:" + operation.operationId] } }, mutations }).operation;
		}
		persist("running", "deleting-confirmed-files", [mutation("task", task.taskId, { ...task, revision: task.revision + 1, resultsInvalidatedByOverwrite: true, workFileState: "unknown", archiveState: "cleared", requiredCapabilities: [...new Set([...(task.requiredCapabilities || []), "es:task-overwrite-v1"])] }, task), ...archives.map(manifest => mutation("archiveManifest", manifest.manifestId, { ...manifest, revision: manifest.revision + 1, status: "cleared", clearedByOverwrite: operation.operationId }, manifest))]);
		overwritePlans.delete(request.overwritePlanId);
		let pending = [];
		const ownedArtifacts = new Set(Array.from(iterateRecords(store, "artifact", { runId: run.runId }), artifact => artifact.artifactId));
		try {
			for (const target of plan.targets) {
				const t = await transportFor(target.location.environmentId);
				for (const file of target.files) {
					await withArtifactReferences(store, { environmentId: target.location.environmentId, path: file.path }, ownedArtifacts, () => t.removeFile({ path: file.path, identity: file.identity, sha256: file.sha256, scopeRoot: target.location.path }));
					pending.push({ path: file.path, state: "deleted", byteSize: file.byteSize });
					if (pending.length === EXECUTION_BATCH_ITEMS) { persist("running", "deleting-confirmed-files", [], pending); pending = []; await yieldIO(); }
				}
			}
			persist("succeeded", "old-scientific-files-cleared", [], pending);
		} catch (error) { persist("failed", "old-files-partially-retained", [], [...pending, { code: error.code || "OVERWRITE_CLEAR_FAILED", message: String(error.message || error) }]); throw error; }
		return plan;
	}
	function plannedLocation({ submissionPlanId, kind }) {
		const plan = previews.get(submissionPlanId);
		if (!plan) throw fail("SUBMISSION_PLAN_EXPIRED");
		return kind === "work" ? { ...plan.workLocation, connectionKind: plan.connectionKind } : plan.archivePath ? { environmentId: localEnvironmentId, path: plan.archivePath, connectionKind: "local" } : null;
	}
	async function stageBegin({ name, role, byteSize }) {
		if (dependencyRegistry.closed) throw fail("STAGING_OWNER_CLOSED");
		safeName(name);
		if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw fail("STAGING_SIZE_INVALID");
		const token = crypto.randomUUID(),
			root = path.join(directory, "inputs", "staging"),
			candidate = path.join(root, "stage-" + token + ".candidate");
		const value = {
			name,
			role,
			byteSize,
			received: 0,
			candidate,
			fd: null,
			hash: crypto.createHash("sha256"),
			busy: true
		};
		// Register before the first await so owner disposal sees opening files too.
		stages.set(token, value);
		value.pending = (async () => {
			try {
				noLinks(root);
				await fsp.mkdir(root, { recursive: true });
				if (dependencyRegistry.closed || value.aborted) throw fail("STAGING_OWNER_CLOSED");
				value.fd = await fsp.open(candidate, "wx", 0o600);
				if (dependencyRegistry.closed || value.aborted) throw fail("STAGING_OWNER_CLOSED");
				return { token };
			} catch (error) {
				await closeStage(value);
				stages.delete(token);
				throw error;
			} finally {
				value.busy = false;
			}
		})();
		return value.pending;
	}
	async function stageAppend({ token, offset, bytes }) {
		const value = stages.get(token);
		if (dependencyRegistry.closed || !value || value.busy || value.aborted)
			throw fail("STAGING_TOKEN_INVALID");
		if (
			!ArrayBuffer.isView(bytes) ||
			bytes.byteLength > 1024 * 1024 ||
			offset !== value.received ||
			offset + bytes.byteLength > value.byteSize
		)
			throw fail("STAGING_RANGE_INVALID");
		value.busy = true;
		value.pending = (async () => {
			try {
				const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				await value.fd.writeFile(buffer);
				value.hash.update(buffer);
				value.received += buffer.length;
				return { receivedBytes: value.received };
			} finally {
				value.busy = false;
			}
		})();
		return value.pending;
	}
	async function stageFinish({ token }) {
		const value = stages.get(token);
		if (
			dependencyRegistry.closed ||
			!value ||
			value.busy ||
			value.aborted ||
			value.received !== value.byteSize
		)
			throw fail("STAGING_INCOMPLETE");
		value.busy = true;
		value.pending = (async () => {
			try {
				await value.fd.sync();
				await value.fd.close();
				const expected = value.hash.digest("hex"),
					identity = await hashFile(value.candidate);
				if (identity.hash !== expected || identity.byteSize !== value.byteSize)
					throw fail("STAGING_IDENTITY_MISMATCH");
				const target = value.candidate.replace(/\.candidate$/, ".asset");
				await fsp.link(value.candidate, target);
				value.publishedPath = target;
				await fsp.unlink(value.candidate);
				stages.delete(token);
				const sourceRef = "source-" + crypto.randomUUID();
				value.sourceRef = sourceRef;
				sources.set(sourceRef, { file: target, name: value.name, identity, staged: true });
				if (dependencyRegistry.closed || value.aborted) {
					await releaseDependencies({ sourceRefs: [sourceRef] });
					throw fail("STAGING_OWNER_CLOSED");
				}
				return { name: value.name, sourceRef, role: value.role || "input", size: value.byteSize };
			} finally {
				value.busy = false;
			}
		})();
		return value.pending;
	}
	async function stageAbort({ token }) {
		const value = stages.get(token);
		if (!value) return;
		value.aborted = true;
		if (value.pending) await value.pending.catch(() => {});
		if (value.sourceRef) await releaseDependencies({ sourceRefs: [value.sourceRef] });
		await closeStage(value);
		stages.delete(token);
	}
	async function closeStage(value) {
		try {
			await value.fd?.close();
		} catch (error) {
			if (error.code !== "EBADF") throw error;
		}
		try {
			await fsp.unlink(value.candidate);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (value.publishedPath && !value.sourceRef) {
			try {
				await fsp.unlink(value.publishedPath);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	async function releaseSource(value) {
		if (value.staged && !value.removed) {
			value.removed = true;
			await fsp.unlink(value.file);
		}
	}
	async function releaseDependencies({ sourceRefs }) {
		if (
			!Array.isArray(sourceRefs) ||
			sourceRefs.some((value) => typeof value !== "string") ||
			new Set(sourceRefs).size !== sourceRefs.length
		)
			throw fail("DEPENDENCY_RELEASE_SCOPE_INVALID");
		for (const sourceRef of sourceRefs) {
			const value = sources.get(sourceRef);
			if (!value) continue;
			sources.delete(sourceRef);
			if (value.inUse) value.releasePending = true;
			else await releaseSource(value);
		}
	}
	async function chooseDependencies(input, { signal } = {}) {
		if (!["gaussian", "orca"].includes(input.engineId)) throw fail("UNSUPPORTED_ENGINE");
		const files = (await chooseDependencyFiles?.({ engineId: input.engineId, ownerId })) || [],
			result = [];
		const readLease = ioAdmission?.acquire("read");
		try {
			for (const value of files) {
				signal?.throwIfAborted();
				const file = typeof value === "string" ? value : value.path,
					name = path.basename(file),
					identity = await hashFile(file, { signal }),
					sourceRef = "source-" + crypto.randomUUID();
				sources.set(sourceRef, { file, name, identity });
				result.push({
					name,
					sourceRef,
					role: typeof value === "object" && value.role ? value.role : "input",
					size: identity.byteSize
				});
			}
			return result;
		} finally {
			readLease?.release();
		}
	}
	function dependencies(input) {
		const names = new Set([safeName(input.inputName)]);
		return (input.dependencies || []).map((value) => {
			const source = sources.get(value.sourceRef);
			if (!source || source.name !== value.name) throw fail("DEPENDENCY_SELECTION_EXPIRED");
			safeName(value.name);
			const key = value.name.toLowerCase();
			if ([...names].some((x) => x.toLowerCase() === key)) throw fail("DUPLICATE_PREPARED_FILE");
			names.add(value.name);
			return {
				source,
				name: value.name,
				roles: ["input"],
				preparedName: value.name,
				contentIdentity: { algorithm: "sha256", hash: source.identity.hash },
				integrity: "complete"
			};
		});
	}
	async function prepare(request, actualSubmission = false) {
		const input = request?.input;
		if (
			!input ||
			!["gaussian", "orca"].includes(input.engineId) ||
			typeof input.finalInputText !== "string" ||
			!input.finalInputText.trim()
		)
			throw fail("FINAL_INPUT_REQUIRED");
		const environment = await environmentFor(request.environmentId, actualSubmission ? {
			ensureWorkingParent: true, workingRootOverride: request.workingRootOverride
		} : undefined);
		if (environment.softwareAdapter.engineId !== input.engineId)
			throw fail("ENGINE_ENVIRONMENT_MISMATCH");
		environment.workingRoot = request.workingRootOverride || environment.workingRoot;
		if (request.slurm) environment.scheduler = { ...environment.scheduler, ...request.slurm };
		const platform = environment.connection.kind === "local" ? process.platform : "linux",
			pathApi = platform === "win32" ? path.win32 : path.posix;
		if (!pathApi.isAbsolute(environment.workingRoot)) throw fail("ABSOLUTE_WORKING_ROOT_REQUIRED");
		const selected = dependencies(input),
			bytes = Buffer.from(input.finalInputText, "utf8"),
			adapter = createSoftwareAdapter(input.engineId),
			interpretation = adapter.inspectInput({ bytes, dependencies: selected });
		interpretation.restrictions = [
			...new Set([
				...interpretation.restrictions,
				...(environment.softwareAdapter.restrictions || []),
				...(environment.scheduler.restrictions || [])
			])
		];
		const key = sha(
			JSON.stringify({
				request,
				environmentId: environment.environmentId,
				configurationRevision: environment.configurationRevision,
				configuration: environment.configuration,
				connection: environment.connection,
				workingRoot: environment.workingRoot,
				executable: environment.softwareAdapter.executable,
				commandMode: environment.softwareAdapter.commandMode,
				inputMode: environment.softwareAdapter.inputMode,
				argumentTemplate: environment.softwareAdapter.argumentTemplate
			})
		);
		const binding = sha(
			JSON.stringify({
				environmentId: environment.environmentId,
				revision: environment.configurationRevision,
				workingRoot: environment.workingRoot,
				archiveRoot: request.archiveRootOverride || path.join(directory, "archive")
			})
		);
		// Content is not an intent: two separately opened identical drafts are new tasks.
		let preview = request.submissionPlanId ? previews.get(request.submissionPlanId) : null;
		if (request.submissionPlanId && (!preview || preview.binding !== binding))
			throw fail("SUBMISSION_PLAN_EXPIRED");
		if (!preview) {
			const runId = "run-" + crypto.randomUUID();
			preview = {
				connectionKind: environment.connection.kind,
				key,
				binding,
				submissionPlanId: "submission-plan-" + crypto.randomUUID(),
				taskId: "task-" + crypto.randomUUID(),
				archivePath: path.join(
					request.archiveRootOverride || path.join(directory, "archive"),
					now().slice(0, 10) + "-" + runId
				),
				runId,
				workLocation: {
					environmentId: environment.environmentId,
					path: pathApi.join(environment.workingRoot, now().slice(0, 10) + "-" + runId)
				}
			};
			preview.directoryMode = environment.connection.kind === "local" ? "single" : "dual";
			if (preview.directoryMode === "single") preview.archivePath = null;
			const baseName = input.suggestedName || input.inputName.replace(/\.[^.]+$/, "");
			const existingNames = new Set([...previews.values()].map(plan => plan.suggestedDisplayName)); for (const task of iterateRecords(store, "task")) existingNames.add(task.displayName);
			let suffix = 1, name = baseName;
			while (existingNames.has(name)) name = `${baseName} (${++suffix})`;
			preview.suggestedDisplayName = name;
			previews.set(preview.submissionPlanId, preview);
		}
		if (request.resubmitTaskId) { const { task } = assertResubmittable(request.resubmitTaskId); preview.taskId = task.taskId; preview.suggestedDisplayName = task.displayName; }
		if (preview.archivePath && !path.isAbsolute(preview.archivePath)) throw fail("ABSOLUTE_ARCHIVE_ROOT_REQUIRED");
		return { input, environment, selected, bytes, adapter, interpretation, preview };
	}
	function resourceViews(interpretation) {
		return interpretation.parsedRequests.jobs.flatMap((job, index) => {
			const layer = job.inputRequest || {};
			return [
				layer.threadsPerProcess
					? {
							label: "共享线程",
							value: String(layer.threadsPerProcess),
							source: `最终输入 job ${index + 1}`
						}
					: layer.mpiProcesses
						? {
								label: "进程",
								value: String(layer.mpiProcesses),
								source: `最终输入 job ${index + 1}`
							}
						: { label: "CPU", value: "未确认", source: "最终输入" },
				{
					label: "内存",
					value: layer.memory ? `${layer.memory.raw} (${layer.memory.scope})` : "未确认",
					source: `最终输入 job ${index + 1}`
				}
			];
		});
	}
	function inputTaskSummary(input) {
		if (!inputStructureRuntime?.identifyFinalInputTask) return { taskKind: null, taskKindUnavailableReason: "当前运行库未提供最终输入任务识别" };
		try { const result = inputStructureRuntime.identifyFinalInputTask({ engineId: input.engineId, inputName: input.inputName, finalInputText: input.finalInputText }); return { taskKind: result.taskKind || null, taskKindUnavailableReason: result.reason || null }; }
		catch (error) { return { taskKind: null, taskKindUnavailableReason: error.code || "最终输入任务类型暂不能可靠读取" }; }
	}
	async function preview(request) {
		const prepared = await prepare(request),
			restrictions = [...prepared.interpretation.restrictions],
			restrictionDetails = [];
		let script = "",
			executable = null,
			calculation = null,
			schedulerRequest = null;
		try {
			const software = await softwareFor(prepared.environment),
				launch = prepared.adapter.planLaunch({
					inputSnapshot: {
						inputSnapshotId: "preview",
						preparedName: prepared.input.inputName,
						engineExtensions: { fileLayout: "task-relative-v1" }
					},
					environmentSnapshot: prepared.environment,
					softwareSnapshot: software,
					workLocation: prepared.preview.workLocation
				});
			executable = software.entryIdentity?.path || prepared.environment.softwareAdapter.executable;
			calculation = require("./engines/calculation-script.cjs").resolveCalculationScript({
				launch,
				environment: prepared.environment,
				softwareSnapshot: software,
				override: request.calculationScript
			});
			if (prepared.environment.scheduler.kind === "slurm") {
				if (!prepared.environment.scheduler.siteId || !prepared.environment.scheduler.user)
					restrictions.push("SLURM_SITE_USER_UNVERIFIED");
				const rendered = require("./execution/slurm.cjs").renderSlurmScript({
					workLocation: prepared.preview.workLocation,
					configuration: prepared.environment.scheduler,
					engineId: prepared.input.engineId,
					parsedRequests: prepared.interpretation.parsedRequests
				});
				script = rendered.expandedScript;
				restrictions.push(...rendered.restrictions);
				schedulerRequest = rendered.schedulerRequest;
			} else if (software.platform !== "win32")
				script =
					require("./transports/posix.cjs").commandScript(launch.command) +
					(launch.command.stdinPath
						? " < " + require("./execution/common.cjs").quote(launch.command.stdinPath)
						: "");
			else
				script =
					[launch.command.executable, ...launch.command.args]
						.map((value) => JSON.stringify(value))
						.join(" ") +
					(launch.command.stdinPath ? "\nstdin: " + launch.command.stdinPath : "") +
					"\nstdout: " +
					launch.command.stdoutPath +
					"\nstderr: " +
					launch.command.stderrPath;
			if (launch.initialization && prepared.environment.scheduler.kind !== "slurm")
				script = launch.initialization + "\n" + script;
		} catch (error) {
			const code = error.code || "SOFTWARE_CAPABILITY_UNVERIFIED";
			restrictions.push(code);
			if (["GAUSSIAN_WINDOWS_SCRIPT_PATH_CONFLICT", "GAUSSIAN_WINDOWS_SCRIPT_MAPPING_UNVERIFIED"].includes(code)) {
				const detail = { code };
				// Only the validator's small textual diagnostic contract crosses IPC;
				// do not serialize arbitrary errors, objects or the script draft.
				for (const field of ["field", "expected", "actual", "reason"])
					if (typeof error.details?.[field] === "string") detail[field] = error.details[field];
				restrictionDetails.push(detail);
			}
		}
		return {
			submissionPlanId: prepared.preview.submissionPlanId,
			...inputTaskSummary(prepared.input),
			directoryMode: prepared.preview.directoryMode,
			suggestedDisplayName: prepared.preview.suggestedDisplayName,
			executable,
			archivePath: prepared.preview.archivePath,
			calculationScript: calculation?.script,
			calculationScriptIdentity: calculation?.identity,
			workingPath: prepared.preview.workLocation.path,
			script,
			resources: [
				...resourceViews(prepared.interpretation),
				...(schedulerRequest
					? [
							{
								label: "调度CPU申请",
								value: String(
									schedulerRequest.cpuCores ?? schedulerRequest.mpiProcesses ?? "未确认"
								),
								source: "最终Slurm脚本"
							},
							{
								label: "调度内存申请",
								value: schedulerRequest.memory
									? `${schedulerRequest.memory.value} ${schedulerRequest.memory.unit} (${schedulerRequest.memory.scope})`
									: "未确认",
								source: schedulerRequest.slurmMemoryPolicy === "site-managed" ? "站点管理，调度器未核定内存；输入预算仍有效" : "最终Slurm脚本"
							}
						]
					: [])
			],
			restrictions: [...new Set(restrictions)],
			...(restrictionDetails.length ? { restrictionDetails } : {})
		};
	}
	async function submit(request) {
		const intent = request.submissionIntentId || request.submissionPlanId;
		if (intent) {
			let existing; for (const run of iterateRecords(store, "run")) if (run.executionIdentity?.submissionIntentId === intent) { existing = run; break; }
			if (existing) return { taskId: existing.taskId, runId: existing.runId, operationId: existing.submitOperationId };
			if (submitFlights.has(intent)) return submitFlights.get(intent);
			const flight = submitOnce(request);
			submitFlights.set(intent, flight);
			try { return await flight; } finally { submitFlights.delete(intent); }
		}
		return submitOnce(request);
	}
	async function submitOnce(request) {
		const claim = manager();
		store.assertManager(claim);
		const prepared = await prepare(request, true),
			{ input, bytes, selected, interpretation, environment, adapter } = prepared;
		if (transportFor) {
			const workTransport = await transportFor(environment.environmentId, environment);
			await require("./transports/working-parent.cjs").ensureWorkingParent(workTransport, environment.workingRoot);
			const api = environment.connection.kind === "local" && process.platform === "win32" ? path.win32 : path.posix;
			const defaultArchiveRoot = path.join(directory, "archive");
			const exactLocalMissing = (error, file) => error?.code === "FILE_NOT_FOUND" && error.details?.missing === true && error.details.nativeCode === "ENOENT" && error.details.path === file;
			async function missingDefaultArchiveParent(error, target, transport) {
				if (request.archiveRootOverride || prepared.preview.directoryMode !== "dual" ||
					target.environmentId !== localEnvironmentId || target.path !== prepared.preview.archivePath ||
					path.dirname(target.path) !== defaultArchiveRoot || !exactLocalMissing(error, defaultArchiveRoot)) return false;
				// Only the library-owned default parent may be absent before registration.
				// Re-observe both boundaries; permissions, links and missing ancestors stay failures.
				const library = await transport.stat(directory);
				if (!library.isDirectory) return false;
				try { await transport.stat(defaultArchiveRoot); return false; }
				catch (parentError) { if (!exactLocalMissing(parentError, defaultArchiveRoot)) throw parentError; return true; }
			}
			for (let attempt = 0; attempt < 8; attempt++) {
				let exists = false;
				const targets = [prepared.preview.workLocation, ...(prepared.preview.archivePath ? [{ environmentId: localEnvironmentId, path: prepared.preview.archivePath }] : [])];
				for (const target of targets) {
					const transport = target === prepared.preview.workLocation ? workTransport : await transportFor(target.environmentId);
					try { await transport.stat(target.path); exists = true; }
					catch (error) { if (!require("./transports/file-errors.cjs").isMissingFile(error, target.path) && !await missingDefaultArchiveParent(error, target, transport)) throw error; }
				}
				if (!exists) break;
				const suffix = now().slice(0,10) + "-run-" + crypto.randomUUID();
				prepared.preview.workLocation.path = api.join(environment.workingRoot, suffix);
				if (prepared.preview.archivePath) prepared.preview.archivePath = path.join(path.dirname(prepared.preview.archivePath), suffix);
				if (attempt === 7) throw fail("SUBMISSION_DIRECTORY_COLLISION");
			}
		}
		for (const item of selected) item.source.inUse = (item.source.inUse || 0) + 1;
		let freezeLease;
		try {
			if (interpretation.restrictions.length)
				throw fail("FINAL_INPUT_RESTRICTED", interpretation.restrictions);
			const software = await softwareFor(environment);
			const taskId = prepared.preview.taskId,
				runId = prepared.preview.runId,
				inputSnapshotId = "input-" + crypto.randomUUID(),
				operationId = "submit-" + crypto.randomUUID(),
				preparationOperationId = "prepare-" + crypto.randomUUID(),
				submissionIntentId = request.submissionIntentId || request.submissionPlanId || "intent-" + crypto.randomUUID(),
				workLocation = prepared.preview.workLocation;
			if (store.read("run", runId)) throw fail("SUBMISSION_ALREADY_REGISTERED");
			freezeLease = ioAdmission?.acquire("read");
			const inputDirectory = path.join(directory, "inputs", runId);
			noLinks(path.dirname(inputDirectory));
			await fsp.mkdir(path.dirname(inputDirectory), { recursive: true });
			await fsp.mkdir(inputDirectory);
			const primaryId = "artifact-" + crypto.randomUUID(),
				files = [],
				artifacts = [];
			async function frozen({ artifactId, name, source, buffer }) {
				const target = path.join(inputDirectory, safeName(name));
				if (source) {
					const original = await hashFile(source.file);
					if (
						original.hash !== source.identity.hash ||
						original.fileId !== source.identity.fileId ||
						original.byteSize !== source.identity.byteSize
					)
						throw fail("DEPENDENCY_SOURCE_CHANGED");
					await fsp.copyFile(source.file, target, fs.constants.COPYFILE_EXCL);
				} else await fsp.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
				const fd = await fsp.open(target, "r+");
				try {
					await fd.sync();
				} finally {
					await fd.close();
				}
				const identity = await hashFile(target);
				if (source && identity.hash !== source.identity.hash)
					throw fail("DEPENDENCY_COPY_MISMATCH");
				const sourceRef = `${runId}/${name}`;
				files.push({
					artifactId,
					name,
					sourceRef,
					byteSize: identity.byteSize,
					sha256: identity.hash
				});
				const record = {
					...base(),
					artifactId,
					runId,
					originalName: name,
					roles: ["input"],
					format: null,
					formatVersion: null,
					representation: buffer ? "text" : "binary",
					locations: [
						{ environmentId: localEnvironmentId, path: target, role: "frozen-input" },
						{
							environmentId: environment.environmentId,
							path: (software.platform === "win32" ? path.win32 : path.posix).join(
								workLocation.path,
								name
							),
							role: "prepared"
						}
					],
					provenance: {
						kind: "frozen-submission",
						originalLocation: source
							? { environmentId: localEnvironmentId, path: source.file }
							: null
					},
					producer: { kind: "ester-submission", submissionIntentId },
					byteSize: identity.byteSize,
					integrity: "complete",
					contentHash: { algorithm: "sha256", hash: identity.hash },
					fieldStatus: {
						format: { state: "unknown", reason: "Input source format retained without inference" },
						formatVersion: { state: "unknown", reason: "Not applicable to submitted bytes" }
					}
				};
				artifacts.push(record);
				return record;
			}
			await frozen({ artifactId: primaryId, name: input.inputName, buffer: bytes });
			const deps = [];
			for (const item of selected) {
				const artifactId = "artifact-" + crypto.randomUUID(),
					artifact = await frozen({ artifactId, name: item.name, source: item.source });
				deps.push({
					artifactId,
					roles: ["input"],
					originalLocation: { environmentId: localEnvironmentId, path: item.source.file },
					preparedLocation: artifact.locations[1],
					preparedName: item.name,
					integrity: "complete",
					contentIdentity: artifact.contentHash
				});
			}
			// Durable registration precedes every external create/upload/launch.
			freezeLease?.release();
			freezeLease = null;
			const snapshot = {
				...base(),
				requiredCapabilities: ["es:task-layout-v2"],
				inputSnapshotId,
				primaryInputArtifactId: primaryId,
				preparedName: input.inputName,
				dependencies: deps,
				contentIdentity: { algorithm: "sha256", hash: sha(bytes) },
				parsedRequests: interpretation.parsedRequests,
				engineExtensions: { fileLayout: "task-relative-v1" },
				submittedFiles: files
			};
			const task = {
				...base(),
				taskId,
				displayName:
					request.displayName?.trim() || prepared.preview.suggestedDisplayName,
				createdAt: now(),
				engineId: input.engineId,
				taskKind: "external-input",
				sourceProjectRef: input.projectId ? { projectId: input.projectId } : null,
				groupId: null,
				latestRunId: runId,
				formula: null
			};
			const taskSummary = inputTaskSummary(input);
			task.taskKind = taskSummary.taskKind || "external-input";
			task.taskKindUnavailableReason = taskSummary.taskKindUnavailableReason;
			const originalTask = request.resubmitTaskId ? assertResubmittable(request.resubmitTaskId).task : null;
			if (originalTask) Object.assign(task, { createdAt: originalTask.createdAt, displayName: originalTask.displayName, revision: originalTask.revision + 1, groupId: originalTask.groupId });
			task.lastSubmittedAt = now();
			task.workFileState = "unknown";
			task.resultsInvalidatedByOverwrite = false;
			task.directoryMode = prepared.preview.directoryMode;
			if (
				inputStructureRuntime?.parseFinalInputStructure &&
				inputStructureRuntime?.finalInputXyzDependencies
			) {
				try {
					const dependencies = [];
					for (const name of inputStructureRuntime.finalInputXyzDependencies(
						input.engineId,
						input.finalInputText
					)) {
						const frozenFile = files.find((file) => file.name === name);
						if (!frozenFile) continue;
						const raw = await fsp.readFile(path.join(inputDirectory, safeName(frozenFile.name)));
						if (sha(raw) !== frozenFile.sha256) throw fail("INPUT_STRUCTURE_SOURCE_CHANGED");
						dependencies.push({
							name,
							text: new TextDecoder("utf-8", { fatal: true }).decode(raw),
							sha256: frozenFile.sha256
						});
					}
					const parsed = inputStructureRuntime.parseFinalInputStructure({
						engineId: input.engineId,
						inputName: input.inputName,
						finalInputText: input.finalInputText,
						dependencies
					});
					task.inputStructure = parsed.structure;
					task.inputStructureUnavailableReason = parsed.reason || null;
					if (parsed.structure) {
						const provenance = {
							inputSha256: sha(bytes),
							dependencies: parsed.usedDependencies
								.map((name) => ({
									name,
									sha256: dependencies.find((file) => file.name === name).sha256
								}))
								.sort((a, b) => a.name.localeCompare(b.name))
						};
						task.inputStructureTextSha256 = provenance.inputSha256;
						task.inputStructureSource = provenance;
						task.inputStructureSourceVersion = sha(JSON.stringify(provenance));
						const counts = new Map();
						for (const atom of parsed.structure.atoms)
							counts.set(atom.element, (counts.get(atom.element) || 0) + 1);
						task.formula = [...counts]
							.sort(([a], [b]) =>
								a === "C" ? -1 : b === "C" ? 1 : a === "H" ? -1 : b === "H" ? 1 : a.localeCompare(b)
							)
							.map(([element, count]) => element + (count > 1 ? count : ""))
							.join("");
					}
				} catch (error) {
					if (error.code === "INPUT_STRUCTURE_SOURCE_CHANGED") throw error;
					task.inputStructure = null;
					task.inputStructureUnavailableReason =
						error.code || "最终输入或XYZ依赖暂不能可靠读取为单一结构";
				}
			} else task.inputStructureUnavailableReason = "当前运行库未提供最终输入结构读取能力";
			const memoryPolicyCapabilities = environment.scheduler.slurmMemoryPolicy === "site-managed" ? [require("./environments.cjs").SLURM_MEMORY_POLICY_CAPABILITY] : [];
			const executionCapabilities = software.platform !== "win32" && ["ssh", "wsl"].includes(environment.connection.kind) && environment.scheduler.kind === "none" ? ["es:task-posix-stop-dispatch-v1"] : [];
			if (environment.scheduler.kind === "slurm") executionCapabilities.push(SCHEDULER_END_CAPABILITY);
			task.requiredCapabilities = [...new Set([...(originalTask?.requiredCapabilities || []), "es:task-marker-v1", "es:task-layout-v2", ...memoryPolicyCapabilities, ...executionCapabilities, ...(originalTask ? ["es:task-overwrite-v1"] : [])])];
			task.origin = { kind: "submitted" };
			task.management = require("./library/markers.cjs").management(null);
			const markerDirectory = prepared.preview.directoryMode === "single" ? workLocation.path : prepared.preview.archivePath;
			task.locations = [
				require("./library/markers.cjs").locate(
					directory,
					markerDirectory,
					prepared.preview.directoryMode === "single" ? "work" : "planned-archive"
				)
			];
			task.locations[0].markerPath =
				task.locations[0].scope === "library"
					? path.relative(directory, path.join(markerDirectory, "task.ddwz"))
					: path.join(markerDirectory, "task.ddwz");
			if (prepared.preview.directoryMode === "dual") task.plannedArchiveLocation = {
				environmentId: localEnvironmentId,
				path: prepared.preview.archivePath
			};
			const run = {
				...base(),
				requiredCapabilities: ["es:task-layout-v2", ...memoryPolicyCapabilities, ...executionCapabilities, ...(originalTask ? ["es:task-overwrite-v1"] : [])],
				runId,
				taskId,
				attemptOrdinal: 1,
				inputSnapshotId,
				environmentSnapshot: environment,
				softwareSnapshot: software,
				resources: interpretation.parsedRequests.resources,
				executionIdentity: {
					submissionIntentId,
					workLocation,
					executorIdentity: null,
					launchIdentity: null,
					launchReceipt: null,
					endReceipt: null,
					fieldStatus: Object.fromEntries(
						["executorIdentity", "launchIdentity", "launchReceipt", "endReceipt"].map((key) => [
							key,
							{ state: "unknown", reason: "Not launched" }
						])
					)
				},
				state: {
					executionState: "preparing",
					verificationState: "unknown",
					checkedAt: null,
					evidenceRefs: [],
					scientificState: {}
				},
				submitOperationId: operationId,
				preparationOperationId
			};
			if (environment.scheduler.kind === "slurm") {
				const rendered = require("./execution/slurm.cjs").renderSlurmScript({
					workLocation,
					configuration: environment.scheduler,
					engineId: input.engineId,
					parsedRequests: interpretation.parsedRequests
				});
				if (rendered.restrictions.length)
					throw fail("SLURM_RESOURCE_REQUEST_RESTRICTED", rendered.restrictions);
				const script = rendered.bytes;
				snapshot.engineExtensions.submissionScript = {
					text: script.toString("utf8"),
					algorithm: "sha256",
					hash: sha(script)
				};
				run.resources.schedulerRequest = rendered.schedulerRequest;
				run.resources.fieldStatus = {
					...run.resources.fieldStatus,
					schedulerRequest: { state: "known", evidenceRefs: [`submission-script:${sha(script)}`] }
				};
			}
			const launch = adapter.planLaunch({
				inputSnapshot: snapshot,
				environmentSnapshot: environment,
				softwareSnapshot: software,
				workLocation
			});
			const calculation = require("./engines/calculation-script.cjs").resolveCalculationScript({
				launch,
				environment,
				softwareSnapshot: software,
				override: request.calculationScript
			});
			Object.assign(launch, calculation.launch);
			snapshot.calculationScript = calculation.script;
			snapshot.calculationScriptIdentity = calculation.identity;
			snapshot.requiredCapabilities = [
				...new Set([...(snapshot.requiredCapabilities || []), "es:task-editable-script-v1"])
			];
			snapshot.engineExtensions.calculationScript = calculation.script;
			snapshot.engineExtensions.calculationScriptIdentity = calculation.identity;
			const outputArtifactId = "artifact-" + crypto.randomUUID();
			artifacts.push({
				...base(),
				artifactId: outputArtifactId,
				runId,
				originalName: (software.platform === "win32" ? path.win32 : path.posix).basename(
					launch.primaryOutputPath
				),
				roles: ["primary-output"],
				format: null,
				formatVersion: null,
				representation: "text",
				locations: [
					{
						environmentId: environment.environmentId,
						path: launch.primaryOutputPath,
						role: "original"
					}
				],
				provenance: { kind: "execution-output", inputSnapshotId },
				producer: { kind: "native-engine", engineId: input.engineId, submissionIntentId },
				byteSize: null,
				integrity: "unobserved",
				contentHash: null,
				fieldStatus: Object.fromEntries(
					["format", "formatVersion", "byteSize", "contentHash"].map((key) => [
						key,
						{ state: "unknown", reason: "Execution output not yet observed" }
					])
				)
			});
			run.primaryOutputArtifactId = outputArtifactId;
			const preparationResolution = await resolveResultPreparation?.({
				run,
				inputSnapshot: snapshot,
				workLocation,
				operationId: preparationOperationId
			});
			const preparation = preparationResolution?.restricted ? null : preparationResolution;
			if (preparationResolution?.restricted && preparationResolution.sourceArtifact) {
				const source = preparationResolution.sourceArtifact,
					api = software.platform === "win32" ? path.win32 : path.posix;
				artifacts.push({
					...base(),
					artifactId: source.artifactId,
					runId,
					originalName: api.basename(source.path),
					roles: source.roles || ["wavefunction", "restart"],
					format: source.format || null,
					formatVersion: null,
					representation: source.representation || "binary",
					locations: [
						{ environmentId: environment.environmentId, path: source.path, role: "original" }
					],
					provenance: { kind: "declared-native-output", inputSnapshotId },
					producer: { kind: "native-engine", engineId: input.engineId, submissionIntentId },
					byteSize: null,
					integrity: "unobserved",
					contentHash: null,
					fieldStatus: Object.fromEntries(
						["formatVersion", "byteSize", "contentHash"].map((key) => [
							key,
							{ state: "unknown", reason: "Native output not yet observed" }
						])
					)
				});
			}
			run.resultPreparationConfigured = !!preparation;
			let preparationOutputId = null;
			if (preparation) {
				const api = software.platform === "win32" ? path.win32 : path.posix;
				const planned = (artifactId, file, roles, format, representation) => ({
					...base(),
					artifactId,
					runId,
					originalName: api.basename(file),
					roles,
					format,
					formatVersion: null,
					representation,
					locations: [{ environmentId: environment.environmentId, path: file, role: "original" }],
					provenance: { kind: "execution-preparation", inputSnapshotId, preparationOperationId },
					producer: {
						kind: "native-engine-or-converter",
						engineId: input.engineId,
						submissionIntentId,
						toolIdentity: preparation.toolIdentity
					},
					byteSize: null,
					integrity: "unobserved",
					compatible: false,
					contentHash: null,
					fieldStatus: {
						formatVersion: { state: "unknown", reason: "Actual source not yet observed" },
						byteSize: { state: "unknown", reason: "File not yet produced" },
						contentHash: { state: "unknown", reason: "File not yet produced" }
					}
				});
				if (!artifacts.some((value) => value.artifactId === preparation.sourceArtifactId))
					artifacts.push(
						planned(
							preparation.sourceArtifactId,
							preparation.sourcePath,
							["wavefunction", "restart"],
							input.engineId === "gaussian" ? "gaussian-checkpoint" : "orca-gbw",
							"binary"
						)
					);
				preparationOutputId = preparation.outputArtifactId || "artifact-" + crypto.randomUUID();
				artifacts.push(
					planned(
						preparationOutputId,
						api.join(
							workLocation.path,
							safeName(preparation.outputName)
						),
						["wavefunction"],
						input.engineId === "gaussian" ? "gaussian-formatted-checkpoint" : "molden",
						"text"
					)
				);
			}
			const manifest = {
				fileLayout: "task-relative-v1",
				protocolVersion: 1,
				runnerVersion: "1.0.0",
				taskId,
				runId,
				submissionIntentId,
				operationId,
				...launch,
				identityModulePath: runtimeAssets.identityModulePath || null
			};
			if (preparation) manifest.resultPreparation = preparation;
			const values = [
				{ kind: "task", id: taskId, value: task },
				{ kind: "run", id: runId, value: run },
				{ kind: "inputSnapshot", id: inputSnapshotId, value: snapshot },
				...artifacts.map((value) => ({ kind: "artifact", id: value.artifactId, value }))
			];
			for (const groupId of originalTask ? [] : [...new Set(request.groupIds || input.initialGroupIds || [])]) {
				const group = store.read("group", groupId);
				if (!group || group.deleted) throw fail("GROUP_NOT_FOUND");
				const membershipId = require("./library/organization.cjs").membershipId(taskId, groupId);
				values.push({ kind: "groupMembership", id: membershipId, value: { ...base(), membershipId, taskId, groupId, deleted: false } });
			}
			const operation = {
				...base(),
				requiredCapabilities: ["es:task-layout-v2", ...executionCapabilities, ...(originalTask ? ["es:task-overwrite-v1"] : [])],
				operationId,
				type: "submit",
				targets: values.map(({ kind, id }) => ({ kind, id })),
				preconditions: {},
				authorizationScope: { taskId, runId, submissionIntentId },
				phase: "intent-persisted",
				operationState: "pending",
				results: []
			};
			// A real submission begins using the frozen runner contract here. Merely
			// opening a library, saving an environment or previewing never raises it.
			if (executionCapabilities.length) store.requireCapabilities({ manager: claim, requiredCapabilities: executionCapabilities });
			if (originalTask) {
				await executeOverwrite(request, { runId, inputSnapshotId, submittedFiles: files, frozenInputDirectory: inputDirectory, environmentSnapshot: environment, softwareSnapshot: software, manifest });
				Object.assign(originalTask, store.read("task", taskId));
				task.revision = originalTask.revision + 1;
				task.displayName = originalTask.displayName;
			}
			const markerFile = path.join(markerDirectory, "task.ddwz");
			const writeTaskMarker = () => require("./library/markers.cjs").writeMarker(
				markerFile,
				{
					version: 1,
					id: taskId,
					name: task.displayName,
					date: task.createdAt.slice(0, 10),
					note: "",
					main: path.basename(launch.primaryOutputPath),
					sourceVersion: runId,
					management: task.management,
					...(environment.connection.kind === "ssh"
						? {
								remote: {
									host: environment.connection.host,
									user: environment.connection.user,
									dir: workLocation.path,
									...(environment.connection.port && environment.connection.port !== 22
										? { port: environment.connection.port }
										: {})
								}
							}
						: {})
				},
				null
			);
			const registered = store.beginOperation({
				manager: claim,
				operation,
				mutations: values.map((value) => ({ ...value, expectedRevision: value.kind === "task" && originalTask ? originalTask.revision : null }))
			});
			onOperationRegistered(registered);
			const prep = store.beginOperation({
				manager: claim,
				operation: {
					...base(),
					operationId: preparationOperationId,
					type: "result-preparation",
					targets: [
						{ kind: "run", id: runId },
						...(preparation
							? [
									{ kind: "artifact", id: preparation.sourceArtifactId },
									{ kind: "artifact", id: preparationOutputId }
								]
							: [])
					],
					preconditions: {},
					authorizationScope: {
						taskId,
						runId,
						source: "native-wavefunction-after-end",
						configured: !!preparation,
						...(preparation ? { preparation, outputArtifactId: preparationOutputId } : {})
					},
					phase: preparation ? "awaiting-native-end" : "tool-capability-unavailable",
					operationState: "pending",
					results: []
				}
			});
			onOperationRegistered(prep);
			if (!preparation)
				store.commitOperation({
					permit: prep.permit,
					expectedRevision: prep.operation.revision,
					operation: {
						...prep.operation,
						revision: prep.operation.revision + 1,
						operationState: "waiting-verification",
						transitionEvidence: {
							type: "verification",
							checkedAt: now(),
							evidenceRefs: ["configuration:" + environment.environmentId]
						},
						results: [
							{
								code: preparationResolution?.code || "PREPARATION_CAPABILITY_UNAVAILABLE",
								reason:
									preparationResolution?.reason ||
									"转换工具及其兼容能力尚未配置，保留原文件并待准备"
							}
						]
					}
				});
			previews.delete(prepared.preview.key);
			previews.delete(prepared.preview.submissionPlanId);
			onRegistered?.({ taskId, runId, operationId });
			launchBackground(
				(async () => {
					let stage = "control-prepare";
					try {
						noLinks(path.dirname(markerDirectory));
						await fsp.mkdir(path.dirname(markerDirectory), { recursive: true });
						if (prepared.preview.directoryMode === "dual") { await fsp.mkdir(markerDirectory); writeTaskMarker(); }
						const response = await execution().execute({
							permit: registered.permit,
							request: executionRequest(run, "prepare", operationId, { files, manifest })
						});
						if (response.responseState !== "completed") return;
						const preparedTask = store.read("task", taskId), preparedOperation = store.operationPermit(registered.permit);
						store.commitOperation({ permit: registered.permit, expectedRevision: preparedOperation.revision, operation: { ...preparedOperation, revision: preparedOperation.revision + 1 }, mutations: [mutation("task", taskId, { ...preparedTask, revision: preparedTask.revision + 1, workFileState: "present" }, preparedTask)] });
						if (prepared.preview.directoryMode === "single") writeTaskMarker();
						if (shouldStopBeforeSubmit(store.read("run", runId))) {
							const stop = stopOperationFor(run);
							if (stop?.permit)
								await execution().execute({
									permit: stop.permit,
									request: executionRequest(
										store.read("run", runId),
										"requestStop",
										stop.operation.operationId
									)
								});
							return;
						}
						const current = store.read("run", runId),
							operation = store.operationPermit(registered.permit),
							evidence = {
								type: "intent-persisted",
								checkedAt: now(),
								evidenceRefs: ["operation:" + operationId]
							};
						store.commitOperation({
							permit: registered.permit,
							expectedRevision: operation.revision,
							operation: { ...operation, revision: operation.revision + 1 },
							mutations: [
								mutation(
									"run",
									runId,
									{
										...current,
										revision: current.revision + 1,
										state: {
											...current.state,
											executionState: "submitting",
											checkedAt: now(),
											evidenceRefs: evidence.evidenceRefs
										},
										transitionEvidence: evidence
									},
									current
								)
							]
						});
						stage = "control-submit";
						await execution().execute({
							permit: registered.permit,
							request: executionRequest(store.read("run", runId), "submit", operationId)
						});
					} catch (error) {
						await onControlFailure({
							taskId,
							runId,
							operationId,
							permit: registered.permit,
							stage,
							error
						});
						// Prepare never invokes the engine. Its settled rejection is a proven
						// submission failure, while a submit/transport loss remains uncertain.
						if (stage === "control-prepare") {
							const current = store.read("run", runId), operation = store.operationPermit(registered.permit);
							if (!current.executionIdentity.launchReceipt && current.state.executionState !== "ended") {
								const receipt = require("./execution/runner.cjs").event(manifest, "run.ended", 2, { notStarted: true, endReason: "failed", endedAt: now(), code: error.code || "TASK_PREPARATION_FAILED", processTree: { verified: true, notStarted: true, activeProcesses: 0, scope: "pre-launch-preparation" } });
								store.appendExecutionReceipt(receipt);
								const evidence = { type: "not-started", checkedAt: now(), evidenceRefs: receipt.evidenceRefs };
								store.commitOperation({ permit: registered.permit, expectedRevision: operation.revision, operation: { ...operation, revision: operation.revision + 1, phase: "prepare-failed-before-launch", operationState: "failed", transitionEvidence: evidence }, mutations: [mutation("run", runId, { ...current, revision: current.revision + 1, executionIdentity: { ...current.executionIdentity, endReceipt: receipt }, resultPreparationState: { state: "not-started", reason: "输入准备失败，未启动计算或转换" }, state: { ...current.state, executionState: "ended", verificationState: "verified", endReason: "failed", checkedAt: now(), evidenceRefs: receipt.evidenceRefs }, transitionEvidence: evidence }, current)] });
								const prepareOperation = store.operationPermit(prep.permit);
								store.commitOperation({ permit: prep.permit, expectedRevision: prepareOperation.revision, operation: { ...prepareOperation, revision: prepareOperation.revision + 1, phase: "native-not-started", operationState: "failed", transitionEvidence: evidence } });
							}
						}
						throw error;
					}
				})()
			);
			return { taskId, runId, operationId, workingPath: workLocation.path, archivePath: prepared.preview.archivePath, directoryMode: prepared.preview.directoryMode };
		} finally {
			freezeLease?.release();
			for (const item of selected) {
				item.source.inUse--;
				if (!item.source.inUse && item.source.releasePending) await releaseSource(item.source);
			}
		}
	}
	async function resolveInputFile(file, { run } = {}) {
		const snapshot = store.read("inputSnapshot", run.inputSnapshotId),
			entry = snapshot?.submittedFiles?.find(
				(x) => x.artifactId === file.artifactId && x.sourceRef === file.sourceRef
			);
		if (!entry || entry.sha256 !== file.sha256 || entry.byteSize !== file.byteSize)
			throw fail("INPUT_SOURCE_NOT_AUTHORIZED");
		const target = path.join(directory, "inputs", safeName(run.runId), safeName(entry.name)),
			identity = await hashFile(target);
		if (identity.hash !== entry.sha256 || identity.byteSize !== entry.byteSize)
			throw fail("FROZEN_INPUT_CHANGED");
		const handle = await fsp.open(target, "r");
		let closed = false;
		return {
			byteSize: identity.byteSize,
			sha256: identity.hash,
			async readRange({ offset, length, signal }) {
				if (closed || signal?.aborted) throw fail("INPUT_LEASE_CLOSED");
				if (
					!Number.isSafeInteger(offset) ||
					!Number.isSafeInteger(length) ||
					offset < 0 ||
					length < 0 ||
					length > 1024 * 1024 ||
					offset + length > identity.byteSize
				)
					throw fail("INPUT_RANGE_INVALID");
				const buffer = Buffer.alloc(length),
					result = await handle.read(buffer, 0, length, offset);
				return buffer.subarray(0, result.bytesRead);
			},
			async close() {
				if (!closed) {
					closed = true;
					await handle.close();
				}
			}
		};
	}
	return {
		resubmitDraft,
		overwritePreview,
		plannedLocation,
		chooseDependencies,
		preview,
		submit,
		resolveInputFile,
		stageBegin,
		stageAppend,
		stageFinish,
		stageAbort,
		releaseDependencies,
		async dispose() {
			dependencyRegistry.closed = true;
			for (const token of [...stages.keys()]) await stageAbort({ token });
			await releaseDependencies({ sourceRefs: [...sources.keys()] });
			previews.clear();
		}
	};
}
module.exports = { createSubmission, executionRequest, hashFile };
