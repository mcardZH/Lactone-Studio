"use strict";
const { isDeepStrictEqual } = require("node:util");
const { createProcessAdapter } = require("./process.cjs");
const { createSlurmAdapter } = require("./slurm.cjs");
const { createSoftwareAdapter } = require("../engines/adapters.cjs");
const { planScratch } = require("../engines/adapters.cjs");
const { fail, sha256, response } = require("./common.cjs");
const { createExecutionQueue } = require("./queue.cjs");
const { SCHEDULER_END_CAPABILITY, matchesSchedulerEndReceipt } = require("./scheduler-end.cjs");
const { materializePrimary, CHUNK_BYTES } = require("./sources.cjs");
const { enumerateOwnedScratch } = require("./scratch.cjs");
/** The store is injected. This coordinator has no window, renderer, project or DB dependency. */
function createExecutionService({
	store,
	manager,
	protocol,
	transportFactory,
	runtimeAssets,
	spawnDetached,
	probeProcessIdentity,
	stopVerifiedProcessTree,
	resolveInputFile,
	shouldStopBeforeSubmit = () => false,
	now = () => new Date().toISOString(),
	controlledQueue = createExecutionQueue()
}) {
	const adapters = new Map(),
		inputReads = new Map(),
		prepareFlights = new Map();
	const flightKey = (run) =>
		JSON.stringify([
			run.taskId,
			run.runId,
			run.executionIdentity.submissionIntentId,
			run.environmentSnapshot.environmentId,
			run.executionIdentity.workLocation?.environmentId,
			run.executionIdentity.workLocation?.path
		]);
	function preparingResponse(request, run) {
		const flight = prepareFlights.get(flightKey(run));
		if (!flight) return null;
		return response(
			protocol,
			request,
			{
				preparationPending: true,
				stage: "input-preparation",
				evidenceRefs: [`operation:${flight.operationId}`]
			},
			"accepted",
			{ executionState: "preparing", verificationState: "unknown", relatedActivityEnded: false }
		);
	}
	async function readInputFile(file, request, io) {
		if (!resolveInputFile) fail("INPUT_FILE_PROVIDER_REQUIRED");
		let files = inputReads.get(request);
		if (!files) {
			files = new Map();
			inputReads.set(request, files);
		}
		if (!files.has(file.artifactId))
			files.set(
				file.artifactId,
				Promise.resolve(
					resolveInputFile(file, { run: context(request), request, signal: io?.signal })
				).then((value) => {
					if (ArrayBuffer.isView(value)) return value;
					let closing;
					return {
						byteSize: value.byteSize ?? file.byteSize,
						sha256: value.sha256,
						...(value.readRange
							? { readRange: value.readRange.bind(value) }
							: { openStream: value.openStream ? value.openStream.bind(value) : () => value }),
						...(value.verifyIdentity ? { verifyIdentity: value.verifyIdentity.bind(value) } : {}),
						...(value.close
							? {
									close() {
										return (closing ||= Promise.resolve().then(() => value.close()));
									}
								}
							: {})
					};
				})
			);
		const source = await files.get(file.artifactId),
			size = ArrayBuffer.isView(source) ? source.byteLength : source.byteSize;
		if (size !== file.byteSize || (source.sha256 && source.sha256 !== file.sha256))
			fail("INPUT_SOURCE_DESCRIPTOR_MISMATCH");
		const run = context(request),
			snapshot = store.read("inputSnapshot", run.inputSnapshotId);
		if (
			file.artifactId !== snapshot.primaryInputArtifactId &&
			ArrayBuffer.isView(source) &&
			size > CHUNK_BYTES
		)
			fail("DEPENDENCY_STREAM_REQUIRED");
		return source;
	}
	async function closeInputs(request) {
		const files = inputReads.get(request);
		inputReads.delete(request);
		if (!files) return;
		const sources = await Promise.allSettled(files.values()),
			unique = new Set(
				sources.filter((value) => value.status === "fulfilled").map((value) => value.value)
			);
		const closed = await Promise.allSettled([...unique].map((value) => value?.close?.()));
		if (closed.some((value) => value.status === "rejected")) fail("INPUT_LEASE_CLOSE_FAILED");
	}
	async function adapterFor(run) {
		const snapshot = run.environmentSnapshot,
			key = `${snapshot.environmentId}:${snapshot.configurationRevision}:${run.softwareSnapshot.platform}`;
		if (!adapters.has(key))
			adapters.set(
				key,
				(async () => {
					const transport = await transportFactory(snapshot);
					const adapter =
						snapshot.scheduler.kind === "slurm"
							? createSlurmAdapter({
									protocol,
									transport,
									configuration: { ...snapshot.scheduler, workingRoot: snapshot.workingRoot },
									readInputFile,
									readExecutionReceipt: id => store.readExecutionReceipt(id),
									shouldStopBeforeSubmit: (request) => shouldStopBeforeSubmit(context(request)),
									canProveBeforeHandoff: (request, owner) => {
										const current = context(request),
											submission = store.read("operation", owner.operationId);
										return (
											!["stale", "conflict"].includes(current.state?.verificationState) &&
											!!submission?.targets?.some(
												(target) => target.kind === "run" && target.id === current.runId
											) &&
											[
												"prepare:dispatching",
												"prepare:observed",
												"prepare:waiting-verification"
											].includes(submission.phase) &&
											!submission.results.some((result) => result.action === "submit")
										);
									},
									now
								})
							: createProcessAdapter({
									protocol,
									transport,
									platform: run.softwareSnapshot.platform,
									runtimeAssets,
									spawnDetached,
									probeProcessIdentity,
									stopVerifiedProcessTree,
									readInputFile,
									readExecutionReceipt: (id) => store.readExecutionReceipt?.(id),
									shouldStopBeforeSubmit: (request) => shouldStopBeforeSubmit(context(request)),
									canProveBeforeHandoff: (request, owner) => {
										const current = context(request),
											submission = store.read("operation", owner.operationId);
										return (
											!["stale", "conflict"].includes(current.state?.verificationState) &&
											!!submission?.targets?.some(
												(target) => target.kind === "run" && target.id === current.runId
											) &&
											[
												"prepare:dispatching",
												"prepare:observed",
												"prepare:waiting-verification"
											].includes(submission.phase) &&
											!submission.results.some((result) => result.action === "submit")
										);
									},
									now
								});
					return { adapter, transport };
				})()
			);
		try {
			return await adapters.get(key);
		} catch (error) {
			adapters.delete(key);
			throw error;
		}
	}
	function context(request) {
		protocol.assertExecutionRequest(request);
		const run = store.read("run", request.runId);
		if (
			!run ||
			run.taskId !== request.taskId ||
			run.executionIdentity.submissionIntentId !== request.submissionIntentId ||
			run.environmentSnapshot.environmentId !== request.environmentId
		)
			fail("RUN_REQUEST_IDENTITY_MISMATCH");
		if (request.payload.workLocation?.path !== run.executionIdentity.workLocation?.path)
			fail("RUN_WORK_LOCATION_MISMATCH");
		return run;
	}
	async function verifyInput(run, request, io) {
		const snapshot = store.read("inputSnapshot", run.inputSnapshotId),
			files = request.payload.files;
		if (!snapshot || !Array.isArray(files)) fail("INPUT_SNAPSHOT_UNAVAILABLE");
		if (!Array.isArray(snapshot.dependencies)) fail("DEPENDENCY_MANIFEST_UNVERIFIED");
		const expectedArtifacts = new Set([
			snapshot.primaryInputArtifactId,
			...snapshot.dependencies.map((value) => value.artifactId)
		]);
		if (
			files.length !== expectedArtifacts.size ||
			files.some((file) => !expectedArtifacts.has(file.artifactId))
		)
			fail("PREPARED_FILE_MANIFEST_MISMATCH");
		const primary = files.filter((file) => file.artifactId === snapshot.primaryInputArtifactId);
		if (primary.length !== 1 || primary[0].sha256 !== snapshot.contentIdentity.hash)
			fail("PRIMARY_INPUT_IDENTITY_MISMATCH");
		const primarySource = await readInputFile(primary[0], request, io);
		const primaryBytes = await materializePrimary(primarySource, primary[0], io);
		if (
			sha256(primaryBytes) !== snapshot.contentIdentity.hash ||
			primaryBytes.length !== primary[0].byteSize
		)
			fail("PRIMARY_INPUT_IDENTITY_MISMATCH");
		for (const dependency of snapshot.dependencies || []) {
			const matching = files.filter((file) => file.artifactId === dependency.artifactId);
			if (matching.length !== 1 || matching[0].sha256 !== dependency.contentIdentity?.hash)
				fail("DEPENDENCY_CONTENT_MISMATCH");
		}
		const interpretation = createSoftwareAdapter(run.softwareSnapshot.engineId).inspectInput({
			bytes: primaryBytes,
			dependencies: snapshot.dependencies || []
		});
		if (interpretation.restrictions.length)
			fail("FINAL_INPUT_RESTRICTED", { restrictions: interpretation.restrictions });
		const scratch = planScratch(
			run.softwareSnapshot.engineId,
			run.environmentSnapshot,
			snapshot,
			request.payload.workLocation,
			run.softwareSnapshot.platform
		);
		if (
			request.payload.manifest.scratch &&
			JSON.stringify(request.payload.manifest.scratch) !== JSON.stringify(scratch)
		)
			fail("SCRATCH_IDENTITY_CONFLICT");
		request.payload.manifest = {
			...request.payload.manifest,
			scratch,
			command: {
				...request.payload.manifest.command,
				env: {
					...request.payload.manifest.command.env,
					...(scratch ? { GAUSS_SCRDIR: scratch.path } : {})
				}
			}
		};
		request.payload.manifest.engineId = run.softwareSnapshot.engineId;
		request.payload.manifest.inputRequests = interpretation.parsedRequests;
		if (run.softwareSnapshot.entryIdentity?.fileId)
			request.payload.manifest.softwareIdentity = {
				entry: run.softwareSnapshot.entryIdentity,
				members: run.softwareSnapshot.distributionIdentity?.members || []
			};
		if (run.environmentSnapshot.softwareAdapter?.commandMode === "gaussian-windows-options-v1") {
			const plan = createSoftwareAdapter(run.softwareSnapshot.engineId).planLaunch({
				inputSnapshot: snapshot,
				environmentSnapshot: run.environmentSnapshot,
				softwareSnapshot: run.softwareSnapshot,
				workLocation: request.payload.workLocation
			});
			request.payload.manifest = {
				...request.payload.manifest,
				command: plan.command,
				externalOutputs: plan.externalOutputs,
				primaryOutputPath: plan.primaryOutputPath,
				commandMode: plan.commandMode
			};
		}
		const preparation = request.payload.manifest?.resultPreparation;
		if (preparation) {
			const operation = store.read("operation", preparation.operationId);
			if (
				!operation ||
				!operation.targets.some((target) => target.kind === "run" && target.id === run.runId)
			)
				fail("PREPARATION_OPERATION_NOT_PERSISTED");
		}
		return interpretation;
	}
	async function persist(permit, operation, phase, operationState, result, mutations = []) {
		const evidenceRefs = result?.evidenceRefs?.length
			? result.evidenceRefs
			: [`operation:${operation.operationId}:intent`];
		return store.commitOperation({
			permit,
			expectedRevision: operation.revision,
			mutations,
			operation: {
				...operation,
				revision: operation.revision + 1,
				phase,
				operationState,
				results: result ? [...operation.results, result] : operation.results,
				transitionEvidence: {
					type:
						operationState === "succeeded"
							? "operation-complete"
							: operationState === "cancelled"
								? "not-started"
								: "verification",
					evidenceRefs,
					checkedAt: now()
				}
			}
		});
	}
	function sealedRequest(request, run) {
		const submit = run.environmentSnapshot.scheduler.kind === "slurm" && store.read("operation", run.submitOperationId);
		const schedulerBindings = submit?.authorizationScope?.submissionIntentId === run.executionIdentity.submissionIntentId &&
			submit.authorizationScope.runId === run.runId && submit.authorizationScope.taskId === run.taskId
			? submit.results.filter(result => result.action === "submit" && result.responseState === "completed" &&
				result.schedulerSubmissionIdentity).map(result => result.schedulerSubmissionIdentity) : [];
		if (schedulerBindings.length > 1 && schedulerBindings.some(identity =>
			JSON.stringify(identity) !== JSON.stringify(schedulerBindings[0]))) fail("SLURM_SUBMISSION_IDENTITY_CONFLICT");
		const payload = { ...request.payload, submitOperationId: run.submitOperationId };
		delete payload.schedulerSubmissionIdentity;
		if (schedulerBindings.length) payload.schedulerSubmissionIdentity = schedulerBindings[0];
		request = { ...request, payload };
		const expected = run.executionIdentity.executorIdentity?.manifestHash;
		if (!expected)
			return run.executionIdentity.launchIdentity
				? {
						...request,
						payload: {
							...request.payload,
							knownLaunchIdentity: run.executionIdentity.launchIdentity
						}
					}
				: request;
		if (request.payload.manifestHash && request.payload.manifestHash !== expected)
			fail("MANIFEST_IDENTITY_CHANGED");
		return {
			...request,
			payload: {
				...request.payload,
				manifestHash: expected,
				...(run.executionIdentity.launchIdentity
					? { knownLaunchIdentity: run.executionIdentity.launchIdentity }
					: {})
			}
		};
	}
	function appendReceipts(result) {
		const stopDisposition = result.payload.stopDisposition;
		if (stopDisposition) {
			const run = store.read("run", stopDisposition.runId);
			const stop = store.read("operation", stopDisposition.stopOperationId);
			const scope = stop?.authorizationScope;
			if (!run || stop?.type !== "request-stop" ||
				!stop.targets.some(target => target.kind === "run" && target.id === run.runId) ||
				scope?.taskId !== run.taskId || scope.runId !== run.runId || scope.inputSnapshotId !== run.inputSnapshotId ||
				scope.submissionIntentId !== run.executionIdentity.submissionIntentId ||
				!isDeepStrictEqual(scope.workLocation, run.executionIdentity.workLocation))
				delete result.payload.stopDisposition;
		}
		for (const key of [
			"launchReceipt",
			"endReceipt",
			"preparationLaunch",
			"preparationEnd",
			"runnerError",
			"primaryEnd"
		]) {
			const receipt = result.payload[key];
			if (receipt?.receiptId && receipt?.operationId) store.appendExecutionReceipt(receipt);
		}
		const schedulerEnd = result.payload.schedulerEndReceipt;
		if (!schedulerEnd) return;
		protocol.assertEvent(schedulerEnd);
		const run = store.read("run", schedulerEnd.runId);
		if (!matchesSchedulerEndReceipt(run, schedulerEnd)) fail("SLURM_SCHEDULER_END_CONFLICT");
		if (!run.requiredCapabilities?.includes(SCHEDULER_END_CAPABILITY)) {
			const claim = manager?.();
			if (!claim) {
				delete result.payload.schedulerEndReceipt;
				if (!result.payload.endReceipt) {
					result.responseState = "waiting-verification";
					result.actualState = { executionState: "unknown", verificationState: "unknown" };
				}
				return;
			}
			const task = store.read("task", run.taskId);
			if (!task || task.deleted || run.deleted) return;
			store.requireCapabilities({ manager: claim, requiredCapabilities: [SCHEDULER_END_CAPABILITY] });
			store.commit({ manager: claim, mutations: [["task", task.taskId, task], ["run", run.runId, run]].map(([kind, id, value]) => ({
				kind, id, expectedRevision: value.revision,
				value: { ...value, revision: value.revision + 1, requiredCapabilities: [...new Set([...(value.requiredCapabilities || []), SCHEDULER_END_CAPABILITY])] }
			})) });
		}
		store.appendExecutionReceipt(schedulerEnd);
	}
	return {
		softwareAdapter: createSoftwareAdapter,
		async capabilities({ environmentSnapshot, request }, io) {
			protocol.assertExecutionRequest(request);
			if (
				request.action !== "capabilities" ||
				request.environmentId !== environmentSnapshot.environmentId
			)
				fail("CAPABILITY_ENVIRONMENT_MISMATCH");
			const transport = await transportFactory(environmentSnapshot);
			try {
				const adapter =
					environmentSnapshot.scheduler.kind === "slurm"
						? createSlurmAdapter({
								protocol,
								transport,
								configuration: {
									...environmentSnapshot.scheduler,
									workingRoot: environmentSnapshot.workingRoot
								},
								now
							})
						: createProcessAdapter({
								protocol,
								transport,
								platform:
									environmentSnapshot.connection.kind === "local" ? process.platform : "linux",
								runtimeAssets,
								spawnDetached,
								probeProcessIdentity,
								stopVerifiedProcessTree,
								now
							});
				return await adapter.capabilities(request, io);
			} finally {
				await transport.dispose();
			}
		},
		async execute({ permit, request }, io) {
			const run = context(request),
				sideEffect = ["prepare", "submit", "requestStop"].includes(request.action);
			if (["inspect", "readProgress"].includes(request.action)) {
				const pending = preparingResponse(request, run);
				if (pending) return pending;
			}
			request = {
				...sealedRequest(request, run),
				payload: { ...sealedRequest(request, run).payload }
			};
			let preparationFlight;
			try {
				let operation;
				if (sideEffect) {
					operation = store.operationPermit(permit);
					if (
						operation.operationId !== request.operationId ||
						!operation.targets.some(
							(target) => target.kind === "run" && target.id === request.runId
						)
					)
						fail("OPERATION_TARGET_MISMATCH");
					if (["prepare", "submit"].includes(request.action)) {
						const pending = preparingResponse(request, run);
						if (pending) return pending;
					}
					if (
						operation.results.some((result) => result.action === request.action) ||
						operation.phase.startsWith(`${request.action}:`)
					) {
						// A prior transport loss is evidence of uncertainty, never permission to repeat a side effect.
						const pending = preparingResponse(request, run);
						if (pending) return pending;
						const { adapter } = await adapterFor(run);
						const result = await adapter.inspect({ ...request, action: "inspect" }, io);
						appendReceipts(result);
						return result;
					}
					if (request.action === "prepare") {
						preparationFlight = { operationId: operation.operationId };
						prepareFlights.set(flightKey(run), preparationFlight);
						await verifyInput(run, request, io);
					}
					const committed = await persist(
						permit,
						operation,
						`${request.action}:dispatching`,
						"running"
					);
					operation = committed.operation;
				}
				return await controlledQueue.run(
					`execution:${run.environmentSnapshot.environmentId}`,
					async () => {
						const { adapter } = await adapterFor(run);
						let result;
						try {
							result = await adapter[request.action](request, io);
						} catch (error) {
							if (operation)
								await persist(
									permit,
									operation,
									`${request.action}:waiting-verification`,
									"waiting-verification",
									{
										action: request.action,
										code: error.code || "EXECUTION_ACTION_UNVERIFIED",
										checkedAt: now()
									}
								);
							throw error;
						}
						appendReceipts(result);
						if (operation) {
							const waiting =
								result.responseState === "waiting-verification" ||
								result.responseState === "accepted";
							const mutations = [];
							if (request.action === "prepare" && result.payload.manifestHash) {
								const current = store.read("run", run.runId),
									executorIdentity = {
										protocolVersion: 1,
										runnerVersion: "1.0.0",
										manifestHash: result.payload.manifestHash,
										manifestLocation: result.evidenceRefs.at(-1),
										scratch: result.payload.scratch || null,
										externalOutputs: result.payload.externalOutputs || []
									};
								const executionIdentity = {
									...current.executionIdentity,
									executorIdentity,
									fieldStatus: {
										...current.executionIdentity.fieldStatus,
										executorIdentity: { state: "known", evidenceRefs: result.evidenceRefs }
									}
								};
								const resources = result.payload.schedulerRequest
									? {
											...(current.resources || {}),
											schedulerRequest: result.payload.schedulerRequest,
											fieldStatus: {
												...current.resources?.fieldStatus,
												schedulerRequest: { state: "known", evidenceRefs: result.evidenceRefs }
											}
										}
									: current.resources;
								mutations.push({
									kind: "run",
									id: run.runId,
									expectedRevision: current.revision,
									value: {
										...current,
										revision: current.revision + 1,
										executionIdentity,
										...(resources ? { resources } : {})
									}
								});
							}
							await persist(
								permit,
								operation,
								`${request.action}:${waiting ? "waiting-verification" : "observed"}`,
								request.action !== "requestStop" &&
									result.payload.endReceipt?.payload.notStarted === true
									? "cancelled"
									: waiting
										? "waiting-verification"
										: "running",
								{
									action: request.action,
									requestId: request.requestId,
									responseState: result.responseState,
									actualState: result.actualState,
									...(request.action === "submit" && result.payload.schedulerSubmissionIdentity
										? { schedulerSubmissionIdentity: result.payload.schedulerSubmissionIdentity } : {}),
									manifestHash: result.payload.manifestHash || null,
									evidenceRefs: result.evidenceRefs
								},
								mutations
							);
						}
						return result;
					}
				);
			} finally {
				try {
					await closeInputs(request);
				} finally {
					if (preparationFlight && prepareFlights.get(flightKey(run)) === preparationFlight)
						prepareFlights.delete(flightKey(run));
				}
			}
		},
		async inspect(request, io) {
			const run = context(request);
			const pending = preparingResponse(request, run);
			if (pending) return pending;
			const { adapter } = await adapterFor(run);
			const result = await adapter.inspect(sealedRequest(request, run), io);
			appendReceipts(result);
			return result;
		},
		async reconcile({ permit, request }, io) {
			const run = context(request),
				operation = store.operationPermit(permit);
			if (
				operation.operationId !== request.operationId ||
				!operation.targets.some((target) => target.kind === "run" && target.id === request.runId)
			)
				fail("OPERATION_TARGET_MISMATCH");
			const pending = preparingResponse(request, run);
			if (pending) return pending;
			const { adapter } = await adapterFor(run);
			const result = await adapter.inspect(
				sealedRequest({ ...request, action: "inspect" }, run),
				io
			);
			appendReceipts(result);
			const stopping =
				operation.type === "request-stop" || operation.phase.startsWith("requestStop:");
			const preparing = operation.type === "result-preparation",
				preparationEnd = result.payload.preparationEnd;
			const nativeCancelled =
				preparing &&
				result.payload.endReceipt?.payload.notStarted === true &&
				result.actualState.resultPreparation === "not-started";
			const completed = stopping
				? result.actualState.executionState === "ended" &&
					(result.payload.endReceipt || result.payload.schedulerEndReceipt) &&
					result.actualState.verificationState === "verified" &&
					result.actualState.relatedActivityEnded !== false
				: preparing
					? nativeCancelled ||
						(!!preparationEnd &&
							(preparationEnd.payload.notStarted === true ||
								preparationEnd.payload.end?.processTree?.verified === true))
					: ["queued", "running", "ended"].includes(result.actualState.executionState);
			let terminalState = "waiting-verification";
			if (completed) {
				if (stopping) terminalState = "succeeded";
				else if (preparing)
					terminalState =
						nativeCancelled ||
						(preparationEnd?.payload.cancelled === true &&
							preparationEnd.payload.notStarted === true)
							? "cancelled"
							: preparationEnd?.payload.succeeded === true
								? "succeeded"
								: "failed";
				else
					terminalState =
						result.payload.endReceipt?.payload.notStarted === true ? "cancelled" : "succeeded";
			}
			await persist(permit, operation, completed ? "verified" : operation.phase, terminalState, {
				action: "inspect",
				requestId: request.requestId,
				actualState: result.actualState,
				evidenceRefs: result.evidenceRefs
			});
			return result;
		},
		async prepareResult({ permit, request }, io) {
			const run = context(request),
				operation = store.operationPermit(permit);
			if (
				operation.operationId !== request.operationId ||
				operation.type !== "result-preparation" ||
				!operation.targets.some((target) => target.kind === "run" && target.id === run.runId)
			)
				fail("PREPARATION_OPERATION_MISMATCH");
			const { adapter } = await adapterFor(run),
				sealed = sealedRequest(request, run);
			if (operation.phase.startsWith("preparation:")) {
				const result = await adapter.inspect({ ...sealed, action: "inspect" }, io);
				appendReceipts(result);
				return result;
			}
			const committed = await persist(permit, operation, "preparation:dispatching", "running");
			try {
				const result = await controlledQueue.run(
					`execution:${run.environmentSnapshot.environmentId}`,
					() => adapter.prepareResult(sealed, io)
				);
				appendReceipts(result);
				await persist(
					permit,
					committed.operation,
					"preparation:waiting-verification",
					"waiting-verification",
					{
						action: "result-preparation",
						responseState: result.responseState,
						evidenceRefs: result.evidenceRefs
					}
				);
				return result;
			} catch (error) {
				await persist(
					permit,
					committed.operation,
					"preparation:waiting-verification",
					"waiting-verification",
					{ action: "result-preparation", code: error.code || "PREPARATION_UNVERIFIED" }
				);
				throw error;
			}
		},
		appendReceipt(receipt) {
			return store.appendExecutionReceipt(receipt);
		},
		async dispose() {
			const settled = await Promise.allSettled([...adapters.values()]);
			adapters.clear();
			await Promise.all([...inputReads.keys()].map((request) => closeInputs(request)));
			await Promise.all(
				settled
					.filter((value) => value.status === "fulfilled")
					.map((value) => value.value.transport.dispose())
			);
		}
	};
}
module.exports = {
	createExecutionService,
	createProcessAdapter,
	createSlurmAdapter,
	createSoftwareAdapter,
	enumerateOwnedScratch
};
