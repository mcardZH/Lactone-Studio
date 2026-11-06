"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { AsyncLocalStorage } = require("node:async_hooks");
const { openTaskLibrary, inspectBaseline } = require("./library/index.cjs");
const { createGlobalSettings, fail, noLinks } = require("./platform/global-settings.cjs");
const {
	createCredentialVault,
	createHostKeyVerifier,
	environmentCredentialKey: credentialKey
} = require("./platform/credentials.cjs");
const { createExecutionService, createSoftwareAdapter } = require("./execution/index.cjs");
const { createAssetService } = require("./assets/index.cjs");
const { createLocalTransport } = require("./transports/local.cjs");
const { createWslTransport } = require("./transports/wsl.cjs");
const { createSshTransport } = require("./transports/ssh.cjs");
const { createSubmission, executionRequest } = require("./submission.cjs");
const { createManagement, base, mutation } = require("./management.cjs");
const { createMonitoring } = require("./monitoring.cjs");
const { createPreviewService } = require("./preview.cjs");
const { createSnapshotGateway } = require("./snapshots.cjs");
const { taskCard, taskDetail, taskMainFile } = require("./projections.cjs");
const { sanitizeEnvironment, environmentSnapshot, viewEnvironment } = require("./environments.cjs");
const portable = require("./library/markers.cjs");
const { SCHEDULER_END_CAPABILITY, verifiedOwnerEndReceipt } = require("./execution/scheduler-end.cjs");
const supportedCapabilities = portable.CAPABILITIES.concat(
	"es:task-postprocess-cache-v1",
	"es:task-environment-sites-v1",
	"es:task-layout-v2",
	"es:task-clear-work-v1",
	"es:task-overwrite-v1",
	"es:task-environment-templates-v1",
	"es:task-result-adoption-v1",
	"es:task-slurm-memory-policy-v1",
	"es:task-posix-stop-dispatch-v1",
	SCHEDULER_END_CAPABILITY
);
// This continuation capability is required only by libraries that actually
// register it, rather than by an ordinary visit to a legacy task library.
const baselineCapabilities = supportedCapabilities.filter(capability => !["es:task-result-adoption-v1", "es:task-slurm-memory-policy-v1", "es:task-posix-stop-dispatch-v1", SCHEDULER_END_CAPABILITY].includes(capability));
const COMMANDS = new Set([
	"center.enter",
	"center.leave",
	"center.read",
	"manager.acquire",
	"task.details",
	"task.execution-evidence",
	"task.rename",
	"group.save",
	"group.move",
	"group.delete",
	"group.membership",
	"operation.read",
	"operation.retry",
	"library.discover",
	"library.rebuild",
	"task.create-marker",
	"environment.site-save",
	"environment.site-delete",
	"environment.browse",
	"environment.import-preview",
	"reminder.dismiss",
	"operation.plan",
	"operation.execute",
	"monitor.read",
	"monitor.release",
	"monitor.layout",
	"monitor.settings",
	"preview.read",
	"preview.find",
	"preview.release",
	"file.save-copy",
	"clipboard.write",
	"library.associate",
	"library.migrate",
	"library.self-check",
	"library.empty-recycle",
	"environment.save",
	"environment.delete",
	"environment.import",
	"environment.export",
	"environment.check",
	"environment.trust-host-key",
	"submission.preview",
	"submission.choose-dependencies",
	"submission.submit",
	"submission.resubmit-draft",
	"submission.overwrite-preview",
	"submission.choose-root",
	"location.open",
	"snapshot.open",
	"snapshot.describe",
	"snapshot.readRange",
	"snapshot.retain",
	"snapshot.release"
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
for (const command of [
	"task.execution-evidence",
	"submission.stage-begin",
	"submission.stage-append",
	"submission.stage-finish",
	"submission.stage-abort",
	"submission.release-dependencies",
	"snapshot.read-range"
])
	COMMANDS.add(command);
function managementLiveness(expected, observed, currentHost) {
	const status = typeof observed === "string" ? observed : observed?.status;
	if (["alive", "dead"].includes(status)) return status;
	// UI manager qualification only. Never use this relaxation to stop/adopt an external Run.
	if (
		expected?.hostId &&
		expected.bootId &&
		currentHost?.hostId === expected.hostId &&
		currentHost.bootId &&
		currentHost.bootId !== expected.bootId
	)
		return "dead";
	const actual = observed?.identity;
	if (
		expected?.hostId &&
		expected.bootId &&
		expected.creationFileTime &&
		actual?.hostId === expected.hostId &&
		actual.bootId === expected.bootId &&
		actual.pid === expected.pid &&
		actual.creationFileTime &&
		actual.creationFileTime !== expected.creationFileTime
	)
		return "dead";
	return "unknown";
}
/** Composition root. Renderer never supplies a manager, permit, native path, or process identity. */
function createTaskSystemHost(dependencies) {
	const { globalDirectory, processIdentity, protocol, safeStorage } = dependencies;
	if (
		!globalDirectory ||
		!processIdentity?.instanceId ||
		!protocol?.assertRecord ||
		typeof dependencies.probeProcessIdentity !== "function"
	)
		throw fail("TASK_HOST_COMPOSITION_REQUIRED");
	const probe = async (identity) =>
		managementLiveness(
			identity,
			await dependencies.probeProcessIdentity(identity),
			processIdentity
		);
	const settings =
		dependencies.settings ||
		createGlobalSettings({
			directory: globalDirectory,
			processIdentity,
			probeProcessIdentity: probe
		});
	const vault =
		dependencies.vault ||
		createCredentialVault({
			directory: globalDirectory,
			processIdentity,
			probeProcessIdentity: probe,
			safeStorage
		});
	const hostKeys = createHostKeyVerifier({ settings }),
		owners = new Map(),
		resultAdoptionOwners = new Map(),
		jobs = new Set(),
		settledMigrationOwners = new Map(),
		idleListeners = new Set();
	const localEnvironmentId = dependencies.localEnvironmentId || "es-task-library-local",
		now = dependencies.now || (() => new Date().toISOString());
	const queuedStops = require("./queued-stops.cjs").createQueuedStops({ settings, probe, now });
	let disposed = false, closing = false;
	function notifyChanged(value) {
		try {
			dependencies.onChanged?.(value);
		} catch {}
	}
	function reportError(value) {
		try {
			dependencies.onError?.(value);
		} catch {}
	}
	async function composeEnvironment(environment, ports = {}) {
		const configured =
				(await dependencies.resolveEnvironmentConfiguration?.(environment, ports)) || {},
			software = (await dependencies.resolveSoftwareConfiguration?.(environment, ports)) || {};
		const snapshot = environmentSnapshot(environment, {
			...configured.softwareAdapter,
			...software
		});
		snapshot.scheduler = { ...snapshot.scheduler, ...configured.scheduler };
		return snapshot;
	}
	function background(promise, context) {
		jobs.add(promise);
		context?.jobs.add(promise);
		promise
			.catch((error) => reportError({ code: error.code || "TASK_OPERATION_UNVERIFIED" }))
			.finally(() => {
				jobs.delete(promise);
				context?.jobs.delete(promise);
				notifyChanged({ type: "operation-settled" });
				if (!jobs.size) {
					for (const listener of idleListeners) listener();
					for (const value of owners.values())
						if (value.released)
							void releaseOwner(value.ownerId).catch((error) =>
								reportError({ code: error.code || "TASK_OWNER_RELEASE_FAILED" })
							);
				}
			});
	}
	function identityFor(ownerId) {
		return {
			...processIdentity,
			instanceId: `${processIdentity.instanceId}:entry:${ownerId}:${crypto.randomUUID()}`
		};
	}
	function pointer() {
		return settings.readPointer();
	}
	async function readRebuildOperation(context, operationId) {
		const live = context.rebuildOperations?.get(operationId);
		if (live) return live.view || live.operations.read(operationId);
		const registered = settings.read().value.rebuildOperations?.[operationId];
		if (!registered) return null;
		const store = openTaskLibrary({
			directory: registered.directory,
			libraryId: registered.libraryId,
			protocol,
			processIdentity: context.identity,
			probeProcessIdentity: probe,
			supportedCapabilities,
			requireExisting: true,
			readOnly: true
		});
		try {
			const op = store.read("operation", operationId);
			if (!op || op.type !== "library-rebuild") throw fail("REBUILD_OPERATION_IDENTITY_INVALID");
			const view = require("./library/operations.cjs")
				.createOperations({ store, manager: () => null })
				.read(operationId);
			if (
				!["succeeded", "failed", "cancelled"].includes(view.state) &&
				(await probe(op.owner)) !== "alive"
			)
				return { ...view, state: "waiting-verification", phase: "候选重建已中断，保留现场待核实" };
			return view;
		} finally {
			store.close();
		}
	}
	async function registerRebuildOperation(operationId, directory, libraryId) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const current = settings.read();
			try {
				await settings.update(current.revision, (value) => {
					value.rebuildOperations = {
						...(value.rebuildOperations || {}),
						[operationId]: { directory, libraryId }
					};
					return value;
				});
				return;
			} catch (error) {
				if (error.code !== "CONFIG_REVISION_CONFLICT" || attempt === 3) throw error;
			}
		}
	}
	function activeManager(context) {
		if (!context.entries.size || !context.claim) throw fail("MANAGEMENT_REQUIRED");
		context.store.assertManager(context.claim);
		return context.claim;
	}
	function effective(context) {
		const value = pointer();
		return (
			value &&
			context.pointer &&
			value.libraryId === context.pointer.libraryId &&
			value.root === context.pointer.root &&
			value.locationEpoch === context.pointer.locationEpoch
		);
	}
	function owner(ownerId) {
		if (disposed || typeof ownerId !== "string" || !ownerId || ownerId.length > 200)
			throw fail("TASK_HOST_OWNER_INVALID");
		let context = owners.get(ownerId);
		if (!context) {
			context = {
				ownerId,
				entries: new Set(),
				jobs: new Set(),
				claim: null,
				pointer: null,
				store: null,
				identity: identityFor(ownerId),
				transportCache: new Map(),
				softwareCache: new Map(),
				errors: new Map(),
				released: false
			};
			owners.set(ownerId, context);
		}
		if (context.store && !effective(context)) {
			// Pointer handover requires explicit re-entry, never silently rebind an active operation.
			throw fail("LIBRARY_LOCATION_CHANGED");
		}
		if (!context.store && pointer())
			try {
				attach(context);
				context.openError = null;
			} catch (error) {
				context.openError = error;
				context.store = null;
			}
		return context;
	}
	function attach(context) {
		const location = pointer();
		if (!location) throw fail("LIBRARY_ASSOCIATION_REQUIRED");
		context.pointer = clone(location);
		context.fileObservationCache = new Map();
		context.fileObservationFlights = new Set();
		context.fileObservationClosing = false;
		context.fileContext ||= new AsyncLocalStorage();
		context.ioAdmission = require("./platform/io-admission.cjs").createIOAdmission({
			directory: path.join(globalDirectory, "io-admission"),
			libraryId: location.libraryId
		});
		const store = (context.store = (dependencies.openLibrary || openTaskLibrary)({
			directory: location.root,
			libraryId: location.libraryId,
			protocol,
			processIdentity: context.identity,
			probeProcessIdentity: probe,
			beforeWrite: (value) =>
				settings.assertEffective({ ...value, locationEpoch: location.locationEpoch }),
			requireExisting: true,
			supportedCapabilities
		}));
		context.drainReceipts = () =>
			require("./migration-host.cjs").drainReceiptSources(store, location.receiptSources || []);
		context.manager = () => activeManager(context);
		context.stopOptions = () => ({
			archiveObservations: (context.archiveObservations ||= new Map()),
			queuedStops: queuedStops.list(location.libraryId),
			libraryDirectory: location.root,
			readerImplementationVersion:
				dependencies.readingRuntime?.SCIENTIFIC_READER_IMPLEMENTATION_VERSION ?? null
		});
		context.operationPermits ||= new Map();
		context.rememberOperation = (registered) =>
			context.operationPermits.set(registered.operation.operationId, registered.permit);
		context.operations = require("./library/operations.cjs").createOperations({
			store,
			manager: context.manager,
			permits: context.operationPermits,
			now,
			onChanged: notifyChanged
		});
		context.sourceTasks = require("./library/source-tasks.cjs").createSourceTasks({
			store,
			directory: location.root,
			manager: context.manager,
			operations: context.operations,
			localEnvironmentId,
			now
		});
		const postprocessOptions = {
			getLibrary: () => ({ store, directory: location.root, libraryId: location.libraryId }),
			assertManager: context.manager,
			operations: context.operations,
			now,
			...context.sourceTasks
		};
		context.sourceSave = require("./postprocess-sources.cjs").createPostprocessManagedSources(
			postprocessOptions
		);
		context.postprocessCache = require("./postprocess-cache.cjs").createPostprocessCache({
			...postprocessOptions,
			updateCacheReference(taskId, reference, operationId) {
				const task = store.read("task", taskId);
				if (!task) throw fail("TASK_NOT_FOUND");
				const mutations = [
					mutation(
						"task",
						taskId,
						{
							...task,
							revision: task.revision + 1,
							postprocessCache: reference,
							requiredCapabilities: [
								...new Set([...(task.requiredCapabilities || []), "es:task-postprocess-cache-v1"])
							]
						},
						task
					)
				];
				if (operationId) context.operations.commitRecords(operationId, mutations);
				else store.commit({ manager: context.manager(), mutations });
			}
		});
		context.hasStopIntent = (run) =>
			require("./operation-guards.cjs")
				.listAll(store, "operation")
				.some(
					(operation) =>
						operation.type === "request-stop" &&
						operation.targets.some((target) => target.kind === "run" && target.id === run.runId)
				) ||
			queuedStops
				.list(location.libraryId)
				.some(
					(queued) =>
						queued.taskId === run.taskId &&
						queued.runId === run.runId &&
						queued.submissionIntentId === run.executionIdentity.submissionIntentId &&
						queued.inputSnapshotId === run.inputSnapshotId &&
						JSON.stringify(queued.workLocation) ===
							JSON.stringify(run.executionIdentity.workLocation)
				);
		context.drainQueuedStops = async () => {
			if (!effective(context) || settings.read().value.freeze) return;
			return queuedStops.drain(context);
		};
		context.environmentFor = async (id, submission = {}) => {
			const record = store.read("environment", id);
			if (!record || record.deleted) throw fail("ENVIRONMENT_NOT_FOUND");
			const environment = viewEnvironment(record);
			if (submission.workingRootOverride) environment.workingRoot = submission.workingRootOverride;
			const control = await transport(environmentSnapshot(environment, {}));
			try {
				if (submission.ensureWorkingParent)
					await require("./transports/working-parent.cjs").ensureWorkingParent(control, environment.workingRoot);
				return await composeEnvironment(environment, { transport: control });
			} finally {
				await control.dispose();
			}
		};
		context.openEnvironmentTransport = (environment, secret) =>
			transport(environmentSnapshot(environment, {}), secret);
		async function transport(snapshot, suppliedSecret) {
			const credentials = {
				resolve: () =>
					vault.resolve(
						{
							environmentId: credentialKey(snapshot.configuration),
							configuration: snapshot.configuration
						},
						suppliedSecret
					)
			};
			if (dependencies.transportFactory)
				return dependencies.transportFactory(snapshot, {
					vault,
					credentials,
					hostKeys,
					ownerId: context.ownerId
				});
			const id = snapshot.environmentId,
				connection = snapshot.connection;
			if (connection.kind === "local") return createLocalTransport({ environmentId: id });
			if (connection.kind === "wsl")
				return createWslTransport({
					environmentId: id,
					distribution: connection.distribution,
					user: connection.user,
					spawnDetached: dependencies.spawnDetached,
					hostWorkingDirectory: globalDirectory
				});
			return createSshTransport({
				environmentId: id,
				connection,
				credentials,
				verifyHostKey(value) {
					const algorithm =
						value.key?.length >= 4
							? value.key.subarray(4, 4 + value.key.readUInt32BE(0)).toString("ascii")
							: "unknown";
					const checked = hostKeys.verify({ ...value, algorithm });
					if (!checked.trusted) context.hostKeyChallenge = checked.challenge;
					return checked.trusted;
				}
			});
		}
		context.transportFor = async (id, submissionSnapshot) => {
			const frozenRun = context.fileContext.getStore();
			const snapshot =
				id === localEnvironmentId
					? { environmentId: id, connection: { kind: "local" }, configuration: {} }
					: submissionSnapshot?.environmentId === id ? submissionSnapshot
					: frozenRun?.environmentSnapshot.environmentId === id
						? frozenRun.environmentSnapshot
						: await context.environmentFor(id);
			const key = `${id}:${snapshot.configurationRevision || 0}`;
			if (!context.transportCache.has(key))
				context.transportCache.set(key, Promise.resolve(transport(snapshot)));
			return context.transportCache.get(key);
		};
		context.execution = (dependencies.createExecutionService || createExecutionService)({
			...dependencies.executionDependencies,
			store,
			manager: context.manager,
			protocol,
			transportFactory: transport,
			probeProcessIdentity: dependencies.probeProcessIdentity,
			stopVerifiedProcessTree: dependencies.stopVerifiedProcessTree,
			runtimeAssets: dependencies.runtimeAssets,
			spawnDetached: dependencies.spawnDetached,
			resolveInputFile: (file, request) => context.submission.resolveInputFile(file, request),
			shouldStopBeforeSubmit: context.hasStopIntent,
			now
		});
		context.softwareFor = async (snapshot, { transport: providedTransport } = {}) => {
			if (providedTransport)
				return createSoftwareAdapter(snapshot.softwareAdapter.engineId).probe({
					transport: providedTransport,
					environment: snapshot
				});
			const key = JSON.stringify(snapshot);
			if (!context.softwareCache.has(key)) {
				const promise = (async () => {
					const t = await transport(snapshot);
					try {
						return await createSoftwareAdapter(snapshot.softwareAdapter.engineId).probe({
							transport: t,
							environment: snapshot
						});
					} finally {
						await t.dispose();
					}
				})();
				context.softwareCache.set(key, promise);
				promise.catch(() => context.softwareCache.delete(key));
			}
			return context.softwareCache.get(key);
		};
		const snapshotDirectory =
			typeof dependencies.snapshotDirectory === "function"
				? dependencies.snapshotDirectory(context.ownerId)
				: dependencies.snapshotDirectory;
		context.resolveArtifactSource = require("./artifact-sources.cjs").createArtifactSourceResolver({
			store,
			transportFor: context.transportFor,
			localEnvironmentId,
			libraryDirectory: location.root,
			withRun: (run, work) => context.fileContext.run(run, work)
		});
		const scientificProvider =
			dependencies.monitorProvider ||
			(dependencies.readingRuntime
				? (input) =>
						require("./scientific-monitor.cjs").createHostScientificMonitor({
							...input,
							runtime: dependencies.readingRuntime,
							onProgress: input.onProgress,
							resolveSource: context.resolveArtifactSource,
							localEnvironmentId,
							snapshotDirectory
						})
				: null);
		context.auxiliaries = require("./auxiliary-collection.cjs").createAuxiliaryCollector({
			store,
			resolveSource: context.resolveArtifactSource,
			transportFor: context.transportFor,
			runtime: dependencies.readingRuntime,
			resolveOutputCandidates: dependencies.resolveOutputCandidates,
			manager: context.manager,
			now,
			onChanged: notifyChanged
		});
		context.monitoring = createMonitoring({
			taskOwned: taskId => context.resultAdoption?.pinned(taskId) || false,
			finalPreparation: taskId => context.resultAdoption?.finalPreparation(taskId),
			trackDisplayPreparation: (taskId, promise) => context.resultAdoption?.trackDisplay(taskId, promise),
			getStopOptions: context.stopOptions,
			readerImplementationVersion:
				dependencies.readingRuntime?.SCIENTIFIC_READER_IMPLEMENTATION_VERSION ?? null,
			ioAdmission: context.ioAdmission,
			store,
			directory: location.root,
			manager: context.manager,
			execution: () => context.execution,
			provider: scientificProvider
				? (input) =>
						context.fileContext.run(input.run, () =>
							scientificProvider({
								...input,
								transportFor: context.transportFor,
								ownerId: context.ownerId,
								directory: location.root
							})
						)
				: null,
			settings,
			beforeRefresh: async ({ operation } = {}) => {
				context.drainReceipts();
				if (!operation) await context.drainQueuedStops();
			},
			collectAuxiliaries: (input) =>
				context.fileContext.run(input.run, () => context.auxiliaries.collect(input)),
			onChanged: notifyChanged,
			now,
			onError: (error) => {
				const runId = error.taskId && store.read("task", error.taskId)?.latestRunId;
				const key = `${error.taskId || "library"}:${runId || ""}:${error.code}`;
				if (context.errors.has(key)) return;
				context.errors.set(key, true);
				reportError(error);
			}
		});
		context.resultAdoption = require("./result-adoption.cjs").createResultAdoption({
			store, manager: context.manager, monitoring: context.monitoring, settings,
			effective: () => effective(context), locationEpoch: () => pointer()?.locationEpoch,
			registry: resultAdoptionOwners, rememberOperation: context.rememberOperation,
			track: promise => background(promise, context), now, onChanged: notifyChanged, onError: reportError
		});
		context.preview = createPreviewService({
			store,
			transportFor: context.transportFor,
			resolveSource: context.resolveArtifactSource
		});
		context.assets = (dependencies.createAssetService || createAssetService)({
			library: store,
			libraryDirectory: location.root,
			localEnvironmentId,
			transportFor: context.transportFor,
			assertNoActiveIO: (context.assertNoActiveIO = async (scope) => {
				const run = store.read("run", scope.runId);
				const ids = scope.artifactIds?.length
					? scope.artifactIds
					: store.list("artifact", { runId: scope.runId }).map((value) => value.artifactId);
				if (ids.some(id => context.activeReads?.has(id)) || context.preview?.uses(ids)) return { safe: false, reason: "active-artifact-reader" };
				if (require("./exit.cjs").activePreparation(store, scope.runId))
					return { safe: false, reason: "active-or-unverified-preparation" };
				const competing = await require("./operation-guards.cjs").competingFileOperations({
					store,
					probe,
					...scope,
					admissionOwner: context.identity
				});
				if (competing.length)
					return { safe: false, reason: "another-file-operation", operations: competing };
				const active = store
					.list("operation")
					.filter(
						(op) =>
							["submit", "result-preparation", "archive", "cleanup"].includes(op.type) &&
							!["succeeded", "failed", "cancelled"].includes(op.operationState) &&
							!(op.type === "result-preparation" && op.authorizationScope.configured === false) &&
							op.targets.some((target) => target.kind === "run" && target.id === scope.runId)
					);
				// Unavailable conversion is an explicit waiting condition; never call it safe by assumption.
				if (active.length)
					return {
						safe: false,
						reason: "active-operation",
						operationIds: active.map((op) => op.operationId)
					};
				return dependencies.assertNoActiveIO
					? dependencies.assertNoActiveIO(scope)
					: {
							safe:
								(!run && !!store.read("task", scope.taskId)?.sourceSetId) ||
								scope.localOnly === true ||
								(run?.state.executionState === "ended" &&
									run.state.verificationState === "verified"),
							evidenceRefs: run?.state.evidenceRefs || []
						};
			}),
			now
		});
		context.submission = createSubmission({
			transportFor: context.transportFor,
			assertNoActiveIO: context.assertNoActiveIO,
			inputStructureRuntime: dependencies.readingRuntime,
			onControlFailure: ({ taskId, runId, operationId, permit, stage, error }) => {
				const failures = require("./task-failures.cjs"),
					failure = failures.describeFailure(error, { stage, operationId, now });
				try {
					failures.updateFailures(
						store,
						runId,
						(values) => {
							values[stage] = failure;
						},
						{ permit }
					);
				} catch (persistenceError) {
					reportError({ taskId, runId, ...failure, persistenceCode: persistenceError.code });
				}
			},
			ioAdmission: context.ioAdmission,
			shouldStopBeforeSubmit: context.hasStopIntent,
			stopOperationFor: (run) => {
				const operation = require("./operation-guards.cjs")
					.listAll(store, "operation")
					.find(
						(value) =>
							value.type === "request-stop" &&
							value.targets.some((target) => target.kind === "run" && target.id === run.runId)
					);
				return operation
					? { operation, permit: context.operationPermits.get(operation.operationId) }
					: null;
			},
			dependencyRegistry: (context.dependencyRegistry ||= {}),
			store,
			directory: location.root,
			localEnvironmentId,
			manager: context.manager,
			environmentFor: context.environmentFor,
			softwareFor: context.softwareFor,
			execution: () => context.execution,
			chooseDependencyFiles: dependencies.chooseDependencyFiles,
			ownerId: context.ownerId,
			now,
			runtimeAssets: dependencies.runtimeAssets,
			resolveResultPreparation: dependencies.resolveResultPreparation
				? async (input) => {
						const control = await transport(input.run.environmentSnapshot);
						try {
							return await dependencies.resolveResultPreparation({
								...input,
								softwareSnapshot: input.run.softwareSnapshot,
								transport: control
							});
						} finally {
							await control.dispose();
						}
					}
				: undefined,
			onOperationRegistered: context.rememberOperation,
			onRegistered: (value) => { context.resultAdoption.register(value); notifyChanged({ type: "submission-registered", ...value }); },
			launchBackground: (promise) => background(promise, context)
		});
		context.management = createManagement({
			stopVerificationTimeoutMs: dependencies.stopVerificationTimeoutMs || 10000,
			stopAndVerify: async (taskId) => {
				const plan = await context.management.plan({ action: "stop", taskIds: [taskId] });
				await context.management.executePlan({ planId: plan.planId });
				const started = performance.now();
				do {
					await context.monitoring.refresh(taskId, false);
					const task = store.read("task", taskId),
						run = task && store.read("run", task.latestRunId);
					if (
						run?.state.executionState === "ended" &&
						run.state.verificationState === "verified" &&
						verifiedOwnerEndReceipt(run)
					)
						return { verified: true };
					await new Promise((resolve) => setTimeout(resolve, 100));
				} while (performance.now() - started < (dependencies.stopVerificationTimeoutMs || 10000));
				return { verified: false };
			},
			operations: context.operations,
			launchBackground: (promise) => background(promise, context),
			libraryDirectory: location.root,
			onChanged: notifyChanged,
			queuedStopRecords: () => context.stopOptions().queuedStops,
			enumerateScratch: async (run) => {
				const safe = await context.assertNoActiveIO({
					taskId: run.taskId,
					runId: run.runId,
					artifactIds: []
				});
				if (safe.safe !== true)
					return {
						scratchScopes: [],
						exclusions: [
							{
								path: run.executionIdentity.executorIdentity?.scratch?.path || "",
								code: "SCRATCH_ACTIVE_IO_OR_DEPENDENCY"
							}
						]
					};
				const transport = await context.transportFor(run.environmentSnapshot.environmentId);
				return require("./execution/scratch.cjs").enumerateOwnedScratch({ run, transport });
			},
			runFile: (mode, work, run) =>
				context.fileContext.run(run, () => context.ioAdmission.run(mode, work, { wait: true })),
			withRun: (run, work) => context.fileContext.run(run, work),
			plans: (context.managementPlans ||= new Map()),
			queueStop: (input) =>
				queuedStops.register({
					...input,
					libraryPointer: context.pointer,
					processIdentity: context.identity
				}),
			store,
			claim: context.manager,
			assets: () => context.assets,
			executionRequest,
			execution: () => context.execution,
			onOperationRegistered: context.rememberOperation,
			now
		});
		context.snapshots = createSnapshotGateway({
			resolveSource: context.resolveArtifactSource,
			store,
			assets: () => context.assets,
			monitoring: context.monitoring,
			transportFor: context.transportFor,
			destination:
				typeof dependencies.snapshotDirectory === "function"
					? dependencies.snapshotDirectory(context.ownerId)
					: dependencies.snapshotDirectory
		});
		(context.snapshotGateways ||= []).push(context.snapshots);
	}
	function libraryView(context) {
		const location = pointer();
		const recycled =
			context.store
				?.list("recycleRecord")
				.filter(
					(value) =>
						["recycled", "partially-restored"].includes(value.status) && value.files?.length > 0
				) || [];
		return {
			libraryId: location?.libraryId || null,
			path: location?.root || null,
			migrating: !!context.store?.describe().migration,
			recycledCount: recycled.length,
			recycledBytes: recycled.reduce(
				(sum, record) =>
					sum +
					(record.files || []).reduce((n, file) => n + (file.recycleIdentity?.byteSize || 0), 0),
				0
			)
		};
	}
	function managerView(context) {
		if (!context.store)
			return {
				access: "unavailable",
				epoch: null,
				reason: context.openError ? "任务库不可用，请打开自检" : "请先关联固定ES任务库"
			};
		const active = context.store.describe().manager;
		let managed = false;
		try {
			managed =
				!!context.claim && !!context.entries.size && !!context.store.assertManager(context.claim);
		} catch {}
		return {
			access: managed ? "manager" : "readonly",
			epoch: active.epoch,
			...(active.instanceId && !managed ? { ownerLabel: active.instanceId } : {})
		};
	}
	function center(context) {
		const records = (kind) =>
			context.store ? require("./operation-guards.cjs").listAll(context.store, kind) : [];
		const stopOptions = context.store ? context.stopOptions() : undefined;
		return {
			manager: managerView(context),
			library: libraryView(context),
			tasks:
				records("task")
					.filter((task) => !task.deleted)
					.map((task) => taskCard(context.store, task, stopOptions))
					.sort(
						(a, b) =>
							Number(
								["running", "queued", "preparing", "submitting", "stop-requested"].includes(
									b.executionState
								)
							) -
								Number(
									["running", "queued", "preparing", "submitting", "stop-requested"].includes(
										a.executionState
									)
								) || b.createdAt.localeCompare(a.createdAt)
					) || [],
			groups:
				records("group")
					.filter((group) => !group.deleted)
					.map(({ groupId, parentGroupId, displayName, order }) => ({
						groupId,
						parentGroupId,
						displayName,
						order: order || 0
					})) || [],
			siteProfiles: records("siteProfile").filter((site) => !site.deleted),
			operations: [
				...records("operation")
					.filter(
						(operation) =>
							!["succeeded", "failed", "cancelled"].includes(operation.operationState) ||
							operation.type.startsWith("batch-")
					)
					.slice(-100)
					.map((operation) => ({
						operationId: operation.operationId,
						type: operation.type,
						phase: operation.phase,
						state: operation.operationState
					})),
				...Object.keys(settings.read().value.rebuildOperations || {})
					.filter((id) => !context.store?.read("operation", id))
					.map((id) => {
						const live = context.rebuildOperations?.get(id),
							view = live && (live.view || live.operations.read(id));
						return {
							operationId: id,
							type: "library-rebuild",
							phase: view?.phase || "候选重建待核实",
							state: view?.state || "waiting-verification"
						};
					})
			],
			remoteReminders: records("task")
				.filter((task) => task.remoteUnprocessedReminder)
				.map((task) => {
					const run = task.latestRunId && context.store.read("run", task.latestRunId);
					return {
						reminderId: task.taskId + ":remote-unprocessed",
						taskId: task.taskId,
						displayName: task.displayName,
						environmentName:
							run?.environmentSnapshot.configuration?.displayName ||
							run?.environmentSnapshot.environmentId ||
							"远端",
						workPath: run?.executionIdentity.workLocation?.path || null,
						message: "远端文件未处理；不会自动补停或补删。"
					};
				}),
			environments:
				records("environment")
					.filter((value) => !value.deleted)
					.map(viewEnvironment) || [],
			monitoring: clone(settings.read().value.monitoring)
		};
	}
	async function acquire(context, entryId, explicit = false) {
		if (!context.entries.has(entryId)) throw fail("MANAGEMENT_ENTRY_REQUIRED");
		if (!context.store) return managerView(context);
		if (context.store.describe().mode !== "writable")
			return {
				...managerView(context),
				access: "readonly",
				reason: "当前库格式或必要能力不支持写入"
			};
		if (settings.read().value.freeze && !context.claim) {
			if (!explicit)
				return {
					...managerView(context),
					access: "readonly",
					reason: "迁库暂停待核实，请显式取得管理权后自检"
				};
			const recovery = await migrationRepairStatus(context, () => null, true);
			if (!recovery.canRepair)
				return {
					...managerView(context),
					access: "readonly",
					reason: recovery.reason || "迁库状态尚不能接管"
				};
			assertMigrationRepairSnapshot(context, recovery.snapshot, () => null, false, true);
			await settings.thawMetadata(
				recovery.snapshot.pointer,
				recovery.snapshot.operation.operationId
			);
			assertMigrationRepairSnapshot(context, recovery.snapshot, () => null, true, true);
		}
		const result = await context.store.acquireManager();
		context.claim = result.acquired ? result.manager : null;
		if (context.claim) {
			await require("./library/relocation.cjs").reconcileLibraryRoot({
				store: context.store,
				manager: context.claim,
				directory: context.pointer.root,
				operations: context.operations
			});
			const required = context.store.describe().requiredCapabilities || [];
			if (baselineCapabilities.some((cap) => !required.includes(cap)))
				context.store.requireCapabilities({
					manager: context.claim,
					requiredCapabilities: baselineCapabilities
				});
			require("./library/organization.cjs").migrate(context.store, context.claim);
			context.monitoring.start();
			context.resultAdoption.resume();
			background(
				(async () => {
					await context.resultAdoption.recover();
					context.drainReceipts();
					context.monitoring.applyReceipts(context.claim);
					await context.drainQueuedStops();
					for (const task of context.store.list("task")) {
						if (task.deleted) continue;
						const run = context.store.read("run", task.latestRunId);
						if (run && run.state.executionState !== "ended")
							await context.monitoring.refresh(task.taskId, false);
					}
				})(),
				context
			);
		}
		return managerView(context);
	}
	async function leave(context, entryId) {
		context.entries.delete(entryId);
		if (!context.entries.size) await cancelFileObservations(context);
		if (!context.entries.size && context.claim) {
			await context.monitoring.detachViews();
			let boundaryWaitStarted = Date.now(),
				boundaryReported = false;
			while (
				effective(context) &&
				settings.read().value.freeze?.libraryId === context.pointer.libraryId
			) {
				const frozen = settings.read().value.freeze;
				if (Date.now() - boundaryWaitStarted > 10000) {
					const migration = context.store.read("operation", frozen.operationId);
					if (migration?.type === "migrate-library" && (await probe(migration.owner)) === "dead") {
						await settings.thawMetadata(pointer(), frozen.operationId);
						break;
					}
					if (!boundaryReported) {
						reportError({ code: "MANAGEMENT_RELEASE_WAITING_SAFE_BOUNDARY" });
						boundaryReported = true;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			try {
				if (effective(context)) context.store.releaseManager(context.claim);
				else {
					const current = pointer();
					if (current?.libraryId === context.pointer?.libraryId) {
						const target = openTaskLibrary({
							directory: current.root,
							libraryId: current.libraryId,
							protocol,
							processIdentity: context.identity,
							probeProcessIdentity: probe,
							beforeWrite: (value) =>
								settings.assertEffective({ ...value, locationEpoch: current.locationEpoch })
						});
						try {
							try {
								target.assertManager(context.claim);
								target.releaseManager(context.claim);
							} catch (error) {
								if (!/STALE|MANAGER/.test(error.code || "")) throw error;
							}
						} finally {
							target.close();
						}
					}
				}
			} finally {
				context.claim = null;
			}
		}
	}
	function environmentDraft(context, input) {
		const environment = sanitizeEnvironment(input, { allowDraft: true });
		if (!environment.environmentId) {
			const fingerprint = crypto
				.createHash("sha256")
				.update(JSON.stringify(environment))
				.digest("hex");
			if (context.environmentDraft?.fingerprint !== fingerprint)
				context.environmentDraft = {
					fingerprint,
					environmentId: "environment-" + crypto.randomUUID()
				};
			environment.environmentId = context.environmentDraft.environmentId;
		}
		return environment;
	}
	async function saveEnvironment(context, input, importedDocument) {
		if (!importedDocument && input.documentPreservation)
			importedDocument = { preserved: input.documentPreservation, requiredCapabilities: [] };
		const manager = activeManager(context),
			environment = environmentDraft(context, input.environment),
			old = context.store.read("environment", environment.environmentId);
		if ((old?.revision || 0) !== (environment.revision || 0))
			throw fail("ENVIRONMENT_REVISION_CONFLICT");
		const profiles = require("./environment-profiles.cjs"),
			fingerprint = profiles.environmentCheckFingerprint(environment),
			checked = context.environmentChecks?.get(fingerprint),
			oldCheck = old?.configuration?.configuration?.check;
		delete environment.check;
		if (checked) environment.check = checked;
		else if (oldCheck?.fingerprint === fingerprint) environment.check = oldCheck;
		environment.revision = (old?.revision || 0) + 1;
		if (input.secret) await vault.save(credentialKey(environment), input.secret);
		const value = {
			...(old || base()),
			...(importedDocument
				? {
						requiredCapabilities: importedDocument.requiredCapabilities,
						environmentDocument: importedDocument.preserved
					}
				: {}),
			requiredCapabilities: require("./environments.cjs").environmentRequiredCapabilities(environment, [...(old?.requiredCapabilities || []), ...(importedDocument?.requiredCapabilities || []), ...(input.requiredCapabilities || [])]),
			environmentId: environment.environmentId,
			displayName: environment.displayName,
			revision: environment.revision,
			deleted: false,
			configuration: await composeEnvironment(environment)
		};
		require("./environment-document.cjs").encodeEnvironmentDocument(value);
		if (environment.slurmMemoryPolicy === "site-managed") context.store.requireCapabilities({ manager, requiredCapabilities: [require("./environments.cjs").SLURM_MEMORY_POLICY_CAPABILITY] });
		context.store.commit({
			manager,
			mutations: [mutation("environment", value.environmentId, value, old)]
		});
		context.softwareCache.clear();
		return viewEnvironment(value);
	}
	function fileObservationKey(context, detail) {
		const task = context.store.read("task", detail.task.taskId);
		return JSON.stringify([context.pointer?.libraryId, context.pointer?.locationEpoch, task?.taskId, task?.latestRunId, task?.deleted, task?.sourceSetId, task?.sourceVersion, task?.workFileState, task?.resultsInvalidatedByOverwrite, task?.archiveState, task?.plannedArchiveLocation, task?.locations,
			detail.files.map(file => [file.artifactId, file.sourceIdentity?.revision, file.sourceIdentity?.sourceSetId, file.path, file.sourceKind, file.exists === false])]);
	}
	async function cancelFileObservations(context, taskId, closing = false) {
		if (closing) context.fileObservationClosing = true;
		const flights = [...(context.fileObservationFlights || [])].filter(flight => !taskId || flight.taskId === taskId);
		for (const flight of flights) flight.controller.abort();
		await Promise.allSettled(flights.map(flight => flight.promise));
		if (closing) context.fileObservationCache?.clear();
	}
	async function observeTaskFiles(context, detail, { signal, force = false } = {}) {
		if (signal?.aborted || context.fileObservationClosing || context.released) throw fail("TASK_SOURCE_IO_CANCELLED");
		const taskId = detail.task.taskId, canonical = taskDetail(context.store, taskId, dependencies.readingRuntime?.SCIENTIFIC_READER_IMPLEMENTATION_VERSION ?? null, context.stopOptions()), key = fileObservationKey(context, canonical), cache = context.fileObservationCache;
		if (detail.task.runId !== canonical.task.runId || detail.task.sourceSetId !== canonical.task.sourceSetId || detail.task.sourceVersion !== canonical.task.sourceVersion || JSON.stringify(detail.files.map(file => [file.artifactId, file.sourceIdentity?.revision])) !== JSON.stringify(canonical.files.map(file => [file.artifactId, file.sourceIdentity?.revision]))) throw fail("TASK_FILE_OBSERVATION_STALE");
		let state = cache.get(taskId);
		if (state?.key !== key) {
			state?.flight?.controller.abort();
			state = { key, records: null, observedAt: 0, flight: null };
			cache.delete(taskId); cache.set(taskId, state);
				for (const [id, value] of cache) { if (cache.size <= 4) break; if (!value.flight) cache.delete(id); }
		}
		const config = settings.read().value.monitoring, interval = (detail.task.connectionKind === "ssh" || detail.task.schedulerKind === "slurm" ? config.remoteIntervalSeconds : config.localIntervalSeconds) * 1000;
		const timestamp = () => { const value = Date.parse(now()); return Number.isFinite(value) ? value : Date.now(); };
		const current = () => {
			if (context.fileObservationClosing || context.released || !effective(context)) return false;
			try { return fileObservationKey(context, taskDetail(context.store, taskId, dependencies.readingRuntime?.SCIENTIFIC_READER_IMPLEMENTATION_VERSION ?? null, context.stopOptions())) === key; } catch { return false; }
		};
		function apply(records) {
			if (!current()) throw fail("TASK_FILE_OBSERVATION_STALE");
			for (let index = 0; index < detail.files.length; index++) {
				const file = detail.files[index], observed = records[index];
				// A newer actual publication read is already proof for that exact source.
				if (file.readable === true && Date.parse(file.checkedAt) > Date.parse(observed.checkedAt)) continue;
				Object.assign(file, observed);
			}
			const archives = detail.files.filter(file => file.sourceKind === "archive"), failures = detail.files.filter(file => file.archiveFailure);
			if (archives.length || failures.length || detail.archiveFailure) {
				const failed = Boolean(failures.length || detail.archiveFailure) || archives.some(file => file.readable === false);
				context.archiveObservations.set(taskId, { runId: detail.task.runId, state: failed ? "failed" : "verified" });
				if (failed) detail.task.archiveState = "failed";
			}
			const main = taskMainFile(context.store, taskId, detail.files);
			if (main?.archiveFailure) {
				detail.archiveFailure ||= main.archiveFailure;
			}
			if (main?.path && main.exists !== false && main.readable !== false) {
				if (main.sourceKind === "archive") {
					const archivePath = detail.task.archivePath, relative = archivePath ? path.relative(archivePath, main.path) : null;
					const insideArchive = relative !== null && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
					detail.resultSource = { kind: "archive", path: insideArchive ? archivePath : path.dirname(main.path) };
				} else if (main.sourceKind === "work") {
					detail.resultSource = { kind: "work", path: context.store.read("run", detail.task.runId)?.executionIdentity.workLocation?.path || path.dirname(main.path) };
				}
				if (main.readable === true && main.actualReadLocation) detail.actualReadLocation = main.actualReadLocation;
			} else if (!main || main.exists === false || main.readable === false) detail.resultSource = null;
			// A metadata observation can switch to a verified fallback before the
			// scientific reader finishes that source. Do not relabel the old publication.
			if (detail.prepared === true && detail.sourceIdentity && main && main.path !== detail.sourceIdentity.path) {
				Object.assign(detail, { prepared: false, results: [], resultsComplete: false, frameCount: 0, framesDelta: [], cards: [], reset: true, revision: null, collectionId: null, sourceBoundary: null, sourceGeneration: null, sourceRevision: null, stage: null, iteration: null, scientificStates: [] });
				delete detail.sourceIdentity;
				if (main.actualReadLocation) detail.actualReadLocation = main.actualReadLocation;
			}
			return detail;
		}
		if (!force && state.records && timestamp() - state.observedAt >= 0 && timestamp() - state.observedAt < interval) return apply(state.records);
		let flight = state.flight;
		if (!flight || flight.controller.signal.aborted) {
			const controller = new AbortController(), frozenRun = context.store.read("run", detail.task.runId);
			flight = { taskId, controller, consumers: 0, promise: null }; state.flight = flight;
			context.fileObservationFlights.add(flight);
			const own = flight, files = canonical.files.map(file => ({ ...file }));
			own.promise = context.fileContext.run(frozenRun, () => context.ioAdmission.run("read", async () => {
				const options = { signal: controller.signal };
				for (const file of files) {
					if (controller.signal.aborted) throw fail("TASK_SOURCE_IO_CANCELLED");
					if (file.exists === false || !file.path) { file.readable = false; file.readError = null; continue; }
					context.activeReads ||= new Map(); context.activeReads.set(file.artifactId, (context.activeReads.get(file.artifactId) || 0) + 1);
					let statObserved = false;
					try {
						const artifact = context.store.read("artifact", file.artifactId), location = file.sourceKind === "archive" ? null : artifact?.locations?.find(location => location.path === file.path);
						const resolved = location ? { location, transport: await context.transportFor(location.environmentId) } : await context.resolveArtifactSource({ artifactId: file.artifactId, signal: controller.signal });
						file.path = resolved.location.path; file.sourceKind = resolved.location.role === "archive" ? "archive" : "work";
						file.archiveFailure = resolved.archiveFailure;
						const identity = await resolved.transport.stat(resolved.location.path, options);
						file.path = resolved.location.path; file.size = identity.byteSize; file.exists = identity.isRegularFile === true; file.checkedAt = now(); file.readable = false; file.readError = null; file.verificationState = "verified"; statObserved = true;
						if (file.exists) {
							const length = Math.min(1, identity.byteSize), read = await resolved.transport.readRange({ path: resolved.location.path, identity, offset: 0, length }, options);
							const bytes = read?.bytes ?? read;
							if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== length) throw fail("TASK_FILE_OBSERVATION_SHORT_READ");
							file.readable = true;
							file.actualReadLocation = { environmentId: resolved.location.environmentId, path: resolved.location.path };
						}
					} catch (error) {
						if (controller.signal.aborted) throw fail("TASK_SOURCE_IO_CANCELLED");
						file.archiveFailure ||= error.details?.archiveFailure;
						file.readable = false; file.readError = error.code || "FILE_UNAVAILABLE"; file.checkedAt = now();
						if (require("./transports/file-errors.cjs").isMissingFile(error, file.path)) file.exists = false; else if (!statObserved) file.exists = null;
					} finally {
						const count = context.activeReads.get(file.artifactId) - 1; if (count) context.activeReads.set(file.artifactId, count); else context.activeReads.delete(file.artifactId);
					}
				}
				if (controller.signal.aborted) throw fail("TASK_SOURCE_IO_CANCELLED");
				if (!current()) throw fail("TASK_FILE_OBSERVATION_STALE");
				const records = files.map(file => Object.fromEntries(["path", "sourceKind", "actualReadLocation", "archiveFailure", "size", "exists", "checkedAt", "readable", "readError", "verificationState"].map(field => [field, file[field]])));
				if (cache.get(taskId) === state) { state.records = records; state.observedAt = timestamp(); }
				return records;
			}, { signal: controller.signal })).finally(() => { context.fileObservationFlights.delete(own); if (state.flight === own) state.flight = null; for (const [id, value] of cache) { if (cache.size <= 4) break; if (!value.flight) cache.delete(id); } });
		}
		flight.consumers++;
		let attached = true;
		const cancel = () => { if (!attached) return; attached = false; if (--flight.consumers === 0) flight.controller.abort(); };
		signal?.addEventListener("abort", cancel, { once: true });
		try { if (signal?.aborted) cancel(); const records = await flight.promise; if (signal?.aborted) throw fail("TASK_SOURCE_IO_CANCELLED"); return apply(records); }
		finally { signal?.removeEventListener("abort", cancel); if (attached) { attached = false; flight.consumers--; } }
	}
	async function dispatch(ownerId, command, input = {}, options = {}) {
		if (
			!COMMANDS.has(command) &&
			!/^source-save\.(begin|append|commit|abort|admission|choose-directory)$/.test(command) &&
			!/^postprocess-cache\.(describe|begin|append|commit|abort|read|retain|release|delete-plan|delete)$/.test(
				command
			) &&
			![
				"submission.stage-begin",
				"submission.stage-append",
				"submission.stage-finish",
				"submission.stage-abort",
				"snapshot.read-range"
			].includes(command)
		)
			throw fail("TASK_COMMAND_UNSUPPORTED");
		if (options.signal?.aborted) throw fail("TASK_REQUEST_CANCELLED");
		const previous = owners.get(ownerId);
		let preservedClaim = null;
		if (previous?.store && !effective(previous) && !previous.jobs.size) {
			preservedClaim = previous.claim;
			await previous.resultAdoption?.suspend("library-detached");
			await cancelFileObservations(previous, undefined, true);
            await previous.monitoring.stop();
			previous.preview.dispose();
			await previous.execution.dispose();
			for (const transport of previous.transportCache.values())
				try {
					await (await transport).dispose();
				} catch {}
			previous.store.close();
			previous.store = null;
			previous.claim = null;
			previous.transportCache.clear();
			previous.softwareCache.clear();
		}
		const context = owner(ownerId);
		if (preservedClaim && context.entries.size) {
			try {
				context.store.assertManager(preservedClaim);
				context.claim = preservedClaim;
				context.drainReceipts();
				context.monitoring.applyReceipts(context.claim);
				context.monitoring.start();
				background(context.drainQueuedStops(), context);
			} catch {}
		}
		if (command === "center.enter") {
			if (!input.entryId || typeof input.entryId !== "string") throw fail("ENTRY_ID_REQUIRED");
			const fresh = !context.entries.has(input.entryId);
			context.entries.add(input.entryId);
			if (fresh) await acquire(context, input.entryId);
			return center(context);
		}
		if (command === "center.leave") return leave(context, input.entryId);
		if (command === "center.read") return center(context);
		if (command === "library.discover") {
			const candidate = require("./library/discovery.cjs").discoverDirectory(input.root);
			(context.discoveryCandidates ||= new Map()).set(candidate.candidateId, candidate);
			return candidate;
		}
		if (
			command === "operation.read" &&
			(!context.store || !context.store.read("operation", input.operationId))
		) {
			const rebuilt = await readRebuildOperation(context, input.operationId);
			if (rebuilt) return rebuilt;
		}
		if (command === "library.rebuild") {
			const candidate = context.discoveryCandidates?.get(input.candidateId);
			if (!candidate) throw fail("LIBRARY_DISCOVERY_EXPIRED");
			if (jobs.size) throw fail("LIBRARY_ACTIVE_OPERATIONS");
			const sourcePointer = pointer(),
				existing = !!context.store,
				discovery = require("./library/discovery.cjs"),
				target = existing
					? context.pointer.root
					: candidate.root + "-recovered-" + crypto.randomUUID();
			const store = existing
				? context.store
				: openTaskLibrary({
						directory: target,
						protocol,
						processIdentity: context.identity,
						probeProcessIdentity: probe,
						supportedCapabilities
					});
			let claim = existing ? activeManager(context) : (await store.acquireManager()).manager;
			if (!claim) throw fail("MANAGEMENT_REQUIRED");
			if (!existing)
				store.requireCapabilities({ manager: claim, requiredCapabilities: baselineCapabilities });
			const operations = existing
					? context.operations
					: require("./library/operations.cjs").createOperations({
							store,
							manager: () => claim,
							now,
							onChanged: notifyChanged
						}),
				plan = discovery.prepareDiscoveryPlan(candidate, input.choices || {}, store);
			const started = operations.begin({
				type: "library-rebuild",
				targets: plan.targets,
				scope: { root: candidate.root, candidateId: candidate.candidateId, targetDirectory: target }
			});
			const tracking = { operations, view: null };
			(context.rebuildOperations ||= new Map()).set(started.operationId, tracking);
			await registerRebuildOperation(started.operationId, target, store.describe().libraryId);
			const promise = (async () => {
				await new Promise((resolve) => setImmediate(resolve));
				try {
					operations.update(started.operationId, {
						phase: "重新识别目录",
						completed: 0,
						total: plan.candidate.items.length,
						unit: "tasks",
						items: []
					});
					const items = await discovery.importDiscoveredAsync(
						{
							store,
							manager: claim,
							directory: target,
							candidate: plan.candidate,
							expectedRevisions: plan.expectedRevisions,
							choices: input.choices || {},
							localEnvironmentId,
							now,
							commitRecords: (mutations) => operations.commitRecords(started.operationId, mutations)
						},
						(progress) =>
							operations.update(started.operationId, {
								phase: "重建任务登记",
								...progress,
								unit: "tasks"
							})
					);
					if (!existing) {
						store.checkpoint({ manager: claim });
						await settings.switchPointer({
							expected: sourcePointer,
							libraryId: store.describe().libraryId,
							root: target
						});
					}
					operations.complete(started.operationId, {
						items,
						results: [{ targetDirectory: target, sourceRetained: true, candidateVerified: true }]
					});
					tracking.view = operations.read(started.operationId);
					if (!existing) {
						store.releaseManager(claim);
						store.close();
						context.openError = null;
						attach(context);
						if (context.entries.size) await acquire(context, [...context.entries][0]);
					}
				} catch (error) {
					try {
						operations.fail(started.operationId, error);
						tracking.view = operations.read(started.operationId);
					} finally {
						if (!existing) store.close();
					}
					throw error;
				}
			})();
			background(promise, context);
			return started;
		}
		if (command === "library.associate") {
			if (jobs.size) throw fail("LIBRARY_ACTIVE_OPERATIONS");
			if (
				context.store
					?.list("operation")
					.some(
						(operation) =>
							["postprocess-source-save", "postprocess-cache-save"].includes(operation.type) &&
							!["succeeded", "failed", "cancelled"].includes(operation.operationState)
					)
			)
				throw fail("LIBRARY_ACTIVE_OPERATIONS");
			const previousPointer = pointer();
			const target =
				input.root || (await dependencies.chooseDirectory?.({ purpose: "associate", ownerId }));
			if (!target) throw fail("LIBRARY_SELECTION_CANCELLED");
			noLinks(target);
			const initial = (dependencies.openLibrary || openTaskLibrary)({
				directory: target,
				protocol,
				processIdentity: context.identity,
				probeProcessIdentity: probe,
				requireExisting:
					input.mode === "open" ||
					fs.existsSync(path.join(target, "checkpoint.json")) ||
					fs.existsSync(path.join(target, "execution-receipts.sqlite")),
				supportedCapabilities
			});
			try {
				if (context.store) {
					await context.resultAdoption?.suspend("library-detached");
					await cancelFileObservations(context, undefined, true);
					await context.monitoring.stop();
					if (context.claim) context.store.releaseManager(context.claim);
					context.store.close();
					context.store = null;
					context.claim = null;
				}
				await settings.switchPointer({
					expected: previousPointer,
					libraryId: initial.describe().libraryId,
					root: target
				});
			} finally {
				initial.close();
			}
			attach(context);
			if (context.entries.size) await acquire(context, [...context.entries][0]);
			return libraryView(context);
		}
		if (command === "library.self-check") {
			let operation;
			operation = selfCheck(context, input, new Set(jobs), () => operation);
			if (input.repair) background(operation, context);
			return operation;
		}
		if (!context.store) throw context.openError || fail("LIBRARY_ASSOCIATION_REQUIRED");
		if (command === "reminder.dismiss") {
			const task = require("./operation-guards.cjs").listAll(context.store, "task")
				.find(
					(task) =>
						task.taskId + ":remote-unprocessed" === input.reminderId &&
						task.remoteUnprocessedReminder
				);
			if (!task) throw fail("REMINDER_NOT_FOUND");
			context.store.commit({
				manager: activeManager(context),
				mutations: [
					mutation(
						"task",
						task.taskId,
						{ ...task, revision: task.revision + 1, remoteUnprocessedReminder: null },
						task
					)
				]
			});
			return;
		}
		if (command === "source-save.choose-directory") {
			const directory = await dependencies.chooseDirectory?.({ purpose: "source-save", ownerId });
			return directory ? { directory } : null;
		}
		if (command.startsWith("source-save.") || command.startsWith("postprocess-cache.")) {
			const service = command.startsWith("source-save.")
				? context.sourceSave
				: context.postprocessCache;
			const method = command.slice(command.indexOf(".") + 1).replace("delete-plan", "deletePlan");
			const needsManagement = ["begin", "deletePlan", "delete"].includes(method),
				temporary = needsManagement && !context.entries.size;
			const entryId = "postprocess-operation-" + crypto.randomUUID();
			if (temporary) {
				context.entries.add(entryId);
				const granted = await acquire(context, entryId, true);
				if (granted.access !== "manager") {
					context.entries.delete(entryId);
					throw fail("MANAGEMENT_REQUIRED");
				}
			}
			try {
				const promise = service[method](input);
				if (!["describe", "read", "retain", "release"].includes(method))
					background(promise, context);
				return await promise;
			} finally {
				if (temporary) await leave(context, entryId);
			}
		}
		if (command === "environment.site-save") {
			const site = require("./environment-profiles.cjs").sanitizeSiteProfile(input.site, {
					allowDraft: true
				}),
				old = site.siteId && context.store.read("siteProfile", site.siteId);
			if ((old?.revision || 0) !== site.revision) throw fail("SITE_REVISION_CONFLICT");
			const value = {
				...(old || base()),
				...site,
				siteId: site.siteId || "site-" + crypto.randomUUID(),
				revision: (old?.revision || 0) + 1,
				requiredCapabilities: ["es:task-environment-sites-v1"]
			};
			context.store.commit({
				manager: activeManager(context),
				mutations: [mutation("siteProfile", value.siteId, value, old)]
			});
			return value;
		}
		if (command === "environment.site-delete") {
			const old = context.store.read("siteProfile", input.siteId);
			if (!old || (input.expectedRevision !== undefined && input.expectedRevision !== old.revision))
				throw fail("SITE_REVISION_CONFLICT");
			context.store.commit({
				manager: activeManager(context),
				mutations: [
					mutation(
						"siteProfile",
						old.siteId,
						{ ...old, revision: old.revision + 1, deleted: true },
						old
					)
				]
			});
			return;
		}
		if (command === "environment.import-preview") {
			const imported =
				input.text === undefined
					? await dependencies.readImportFile?.({ ownerId, purpose: "environment" })
					: input.text;
			if (!imported) return null;
			return require("./environment-document.cjs").previewEnvironmentDocument(
				require("./environment-document.cjs").parseEnvironmentJson(imported),
				protocol
			);
		}
		if (command === "environment.browse")
			return require("./environment-browser.cjs").browseEnvironment(input, {
				chooseDirectory: (options) => dependencies.chooseDirectory?.({ ...options, ownerId }),
				chooseFile: async (options) =>
					dependencies.chooseOpenFile
						? dependencies.chooseOpenFile({ ...options, ownerId })
						: (await dependencies.chooseDependencyFiles?.({ ...options, ownerId }))?.[0] || null,
				openTransport: (environment, secret) =>
					context.openEnvironmentTransport(
						{
							...environment,
							environmentId: environment.environmentId || "browse",
							workingRoot: environment.workingRoot || "/"
						},
						secret
					),
				signal: options.signal
			});
		if (command === "manager.acquire") return acquire(context, input.entryId, true);
		if (command === "task.details") {
			const detail = taskDetail(
				context.store,
				input.taskId,
				dependencies.readingRuntime?.SCIENTIFIC_READER_IMPLEMENTATION_VERSION ?? null,
				context.stopOptions()
			);
			return observeTaskFiles(context, detail, { signal: options.signal, force: true });
		}
		if (command === "task.execution-evidence")
			return require("./execution-evidence.cjs").readExecutionEvidence(context.store, input, now);
		if (command === "task.rename") return context.management.rename(input);
		if (command === "task.create-marker") {
			activeManager(context);
			const target =
				input.directory ||
				(await dependencies.chooseDirectory?.({ purpose: "task-marker", ownerId }));
			if (!target) return null;
			noLinks(target);
			const file = path.join(target, "task.ddwz");
			portable.writeMarker(
				file,
				{
					version: 1,
					id: "task-" + crypto.randomUUID(),
					name: input.displayName?.trim() || path.basename(target),
					date: now().slice(0, 10),
					note: "",
					...(input.main ? { main: portable.relativePath(input.main) } : {}),
					management: portable.management(null)
				},
				null
			);
			const candidate = require("./library/discovery.cjs").discoverDirectory(target);
			(context.discoveryCandidates ||= new Map()).set(candidate.candidateId, candidate);
			return candidate;
		}
		if (command === "group.save") return context.management.saveGroup(input);
		if (command === "group.move") return context.management.moveGroup(input);
		if (command === "group.delete") return context.management.deleteGroup(input);
		if (command === "group.membership") return context.management.membership(input);
		if (command === "operation.read") return context.operations.read(input.operationId);
		if (command === "operation.retry") return context.management.retry(input);
		if (command === "operation.plan")
			return ["archive", "cleanup"].includes(input.action)
				? context.ioAdmission.run("read", () => context.management.plan(input))
				: context.management.plan(input);
		if (command === "operation.execute") {
			return context.management.execute(input);
		}
		if (command === "monitor.read") {
			const cancel = () => context.monitoring.cancel(input.taskId);
			options.signal?.addEventListener("abort", cancel, { once: true });
			try {
				const detail = await context.monitoring.read(input);
                return await observeTaskFiles(context, detail, { signal: options.signal });
			} finally {
				options.signal?.removeEventListener("abort", cancel);
			}
		}
		if (command === "monitor.release") {
            const [result] = await Promise.all([context.monitoring.release(input.taskId), cancelFileObservations(context, input.taskId)]);
            return result;
        }
		if (command === "monitor.settings") {
			activeManager(context);
			return settings.saveMonitoring(input);
		}
		if (command === "monitor.layout") {
			const run = context.store.read("run", context.store.read("task", input.taskId)?.latestRunId);
			if (
				!run ||
				!Array.isArray(input.cards) ||
				new Set(input.cards).size !== input.cards.length ||
				input.cards.some(
					(value) => !["energy", "trajectory", "vibrations", "excited", "atomic"].includes(value)
				)
			)
				throw fail("MONITOR_LAYOUT_INVALID");
			context.store.commit({
				manager: activeManager(context),
				mutations: [
					mutation(
						"run",
						run.runId,
						{ ...run, revision: run.revision + 1, monitorLayout: input.cards },
						run
					)
				]
			});
			return;
		}
		if (command === "preview.read" || command === "preview.find") {
			const key = `${ownerId}:${input.ownerId}`,
				cancel = () => context.preview.release(key),
				lease = context.ioAdmission.acquire("read");
			options.signal?.addEventListener("abort", cancel, { once: true });
			try {
				const artifact = context.store.read("artifact", input.artifactId),
					frozenRun = artifact && context.store.read("run", artifact.runId);
				return await context.fileContext.run(frozenRun, () =>
					context.preview[command === "preview.read" ? "read" : "find"]({
						...input,
						ownerId: key
					})
				);
			} finally {
				lease.release();
				options.signal?.removeEventListener("abort", cancel);
			}
		}
		if (command === "preview.release")
			return context.preview.release(`${ownerId}:${input.ownerId}`);
		if (command === "clipboard.write") {
			if (typeof input.text !== "string" || input.text.length > 8 * 1024 * 1024)
				throw fail("CLIPBOARD_INPUT_INVALID");
			return dependencies.writeClipboard?.(input.text);
		}
		if (command === "environment.save") return saveEnvironment(context, input);
		if (command === "environment.delete") {
			const old = context.store.read("environment", input.environmentId);
			if (!old) throw fail("ENVIRONMENT_NOT_FOUND");
			context.store.commit({
				manager: activeManager(context),
				mutations: [
					mutation(
						"environment",
						old.environmentId,
						{ ...old, revision: old.revision + 1, deleted: true },
						old
					)
				]
			});
			await vault.forget(credentialKey(viewEnvironment(old)));
			return;
		}
		if (command === "environment.check") {
			activeManager(context);
			const environment = environmentDraft(context, input.environment);
			const control = await context.openEnvironmentTransport(environment, input.secret);
			try {
				await require("./transports/working-parent.cjs").ensureWorkingParent(control, environment.workingRoot, { signal: options.signal });
				const snapshot = await composeEnvironment(environment, { transport: control });
				const value = await context.softwareFor(snapshot, { transport: control });
				if (context.hostKeyChallenge) {
					const hostKey = context.hostKeyChallenge;
					context.hostKeyChallenge = null;
					return {
						message:
							hostKey.state === "changed"
								? "主机密钥已改变，连接已拒绝"
								: "请核对主机指纹后显式信任",
						hostKey
					};
				}
				const check = require("./environment-profiles.cjs").environmentCheckView(
					environment,
					value,
					now()
				);
				(context.environmentChecks ||= new Map()).set(check.fingerprint, check);
				return {
					check,
					message: value.recognizedVersion
						? `已识别软件版本：${value.recognizedVersion}`
						: "已核入口，具体软件版本仍待识别",
					...(value.rawVersion ? { details: value.rawVersion } : {})
				};
			} catch (error) {
				if (context.hostKeyChallenge) {
					const hostKey = context.hostKeyChallenge;
					context.hostKeyChallenge = null;
					return {
						message:
							hostKey.state === "changed"
								? "主机密钥已改变，连接已拒绝"
								: "请核对主机指纹后显式信任",
						hostKey
					};
				}
				throw error;
			} finally {
				await control.dispose();
			}
		}
		if (command === "environment.trust-host-key") {
			activeManager(context);
			return hostKeys.trust(input);
		}
		if (command === "environment.export") {
			const record = context.store.read("environment", input.environmentId);
			if (!record) throw fail("ENVIRONMENT_NOT_FOUND");
			const target = await dependencies.chooseSaveFile?.({ purpose: "environment", ownerId });
			if (!target) return { saved: false };
			await fs.promises.writeFile(
				target,
				JSON.stringify(
					require("./environment-document.cjs").encodeEnvironmentDocument(record),
					null,
					2
				),
				{ encoding: "utf8", flag: "wx" }
			);
			return { saved: true };
		}
		if (command === "environment.import") {
			activeManager(context);
			const imported = await dependencies.readImportFile?.({ ownerId, purpose: "environment" });
			if (!imported) return [];
			const document = require("./environment-document.cjs").parseEnvironmentJson(imported);
			const decoded = require("./environment-document.cjs").decodeEnvironmentDocument(
					document,
					protocol
				),
				value = decoded.environment,
				id = "environment-" + crypto.randomUUID();
			return [
				await saveEnvironment(
					context,
					{
						environment: { ...value, environmentId: id, revision: 0 }
					},
					decoded
				)
			];
		}
		if (command === "submission.choose-dependencies") {
			activeManager(context);
			return context.submission.chooseDependencies(input, options);
		}
		if (command === "submission.release-dependencies")
			return context.submission.releaseDependencies(input);
		if (command.startsWith("submission.stage-")) {
			if (command !== "submission.stage-abort") activeManager(context);
			const method = {
				"submission.stage-begin": "stageBegin",
				"submission.stage-append": "stageAppend",
				"submission.stage-finish": "stageFinish",
				"submission.stage-abort": "stageAbort"
			}[command];
			return context.submission[method](input);
		}
		if (command === "submission.preview") {
			activeManager(context);
			return context.submission.preview(input);
		}
		if (command === "submission.submit") return context.submission.submit(input);
		if (command === "submission.resubmit-draft") { activeManager(context); return context.submission.resubmitDraft(input); }
		if (command === "submission.overwrite-preview") { activeManager(context); return context.submission.overwritePreview(input); }
		if (command === "submission.choose-root") {
			activeManager(context);
			if (!["work", "archive"].includes(input.kind)) throw fail("TASK_LOCATION_KIND_INVALID");
			const env = await context.environmentFor(input.environmentId);
			if (input.kind === "work" && env.connection.kind !== "local") throw fail("REMOTE_ROOT_BROWSER_REQUIRED");
			if (input.kind === "archive" && env.connection.kind === "local") throw fail("ASSET_LOCAL_SINGLE_DIRECTORY");
			const selected = await dependencies.chooseDirectory?.({ purpose: "task-" + input.kind + "-root", ownerId, defaultPath: input.currentPath });
			if (selected) { noLinks(selected); if (!path.isAbsolute(selected) || !fs.statSync(selected).isDirectory()) throw fail("TASK_ROOT_UNAVAILABLE"); }
			return { path: selected || null };
		}
		if (command === "location.open") {
			if (!["work", "archive"].includes(input.kind)) throw fail("TASK_LOCATION_KIND_INVALID");
			let location, preSubmission = false;
			if (input.submissionPlanId) { location = context.submission.plannedLocation(input); preSubmission = true; }
			else {
				const task = context.store.read("task", input.taskId), run = task && context.store.read("run", task.latestRunId);
				if (!task) throw fail("TASK_NOT_FOUND");
				location = input.kind === "work" ? run?.executionIdentity.workLocation && { ...run.executionIdentity.workLocation, connectionKind: run.environmentSnapshot.connection.kind } : task.plannedArchiveLocation || context.store.list("archiveManifest", { taskId: task.taskId }).find(manifest => manifest.runId === task.latestRunId && manifest.status === "verified")?.targetLocation;
				if (!location && input.kind === "archive" && !task.latestRunId) {
					const source = task.sourceSetId && context.store.read("sourceSet", task.sourceSetId);
					if (source?.taskId === task.taskId && source.sourceVersion === task.sourceVersion && source.state === "archived") {
						const archivePath = taskCard(context.store, task, { libraryDirectory: context.pointer.root }).archivePath;
						if (archivePath) location = { environmentId: localEnvironmentId, connectionKind: "local", path: archivePath };
					}
				}
			}
			if (!location) throw fail("TASK_LOCATION_UNAVAILABLE");
			const env = location.connectionKind || location.environmentId === localEnvironmentId ? null : await context.environmentFor(location.environmentId);
			if (location.connectionKind && location.connectionKind !== "local" || env && env.connection.kind !== "local") throw fail("TASK_LOCATION_NOT_LOCAL");
			if (!path.isAbsolute(location.path)) throw fail("ABSOLUTE_PATH_REQUIRED");
			let target = location.path, openedParent = false;
			const directoryError = error => {
				const reason = { ENOENT: "目录不存在，请确认当前路径。", EACCES: "没有访问该目录的权限。", EPERM: "没有访问该目录的权限。", ENOTDIR: "当前路径不是目录。", TASK_LOCATION_NOT_DIRECTORY: "当前路径不是目录。" }[error.code];
				return reason ? Object.assign(new Error(`${reason}\n${error.message}`), { code: error.code, detail: error.detail }) : error;
			};
			try { noLinks(target); if (!fs.statSync(target).isDirectory()) throw fail("TASK_LOCATION_NOT_DIRECTORY"); }
			catch (error) {
				if (error.code !== "ENOENT" || !preSubmission) throw directoryError(error);
				target = path.dirname(target);
				try { noLinks(target); if (!fs.statSync(target).isDirectory()) throw fail("TASK_LOCATION_NOT_DIRECTORY"); }
				catch (parentError) { throw directoryError(parentError); }
				openedParent = true;
			}
			if (typeof dependencies.openPath !== "function") throw fail("TASK_OPEN_UNAVAILABLE");
			const error = await dependencies.openPath(target);
			if (error) throw fail("TASK_OPEN_FAILED", error);
			return { opened: true, path: target, openedParent };
		}
		if (command === "snapshot.open") {
			const frozenRun = context.store.read(
				"run",
				context.store.read("task", input.taskId)?.latestRunId
			);
			return context.fileContext.run(frozenRun, () =>
				context.ioAdmission.run("read", () => context.snapshots.open(ownerId, input, options))
			);
		}
		const snapshotGateway =
			command.startsWith("snapshot.") && command !== "snapshot.open"
				? context.snapshotGateways.find((gateway) => gateway.has(ownerId, input.snapshotId))
				: null;
		if (command === "snapshot.describe") {
			if (!snapshotGateway) throw fail("SNAPSHOT_LEASE_INVALID");
			return snapshotGateway.describe(ownerId, input);
		}
		if (command === "snapshot.readRange" || command === "snapshot.read-range") {
			if (!snapshotGateway) throw fail("SNAPSHOT_LEASE_INVALID");
			return snapshotGateway.readRange(ownerId, input);
		}
		if (command === "snapshot.retain") {
			if (!snapshotGateway) throw fail("SNAPSHOT_LEASE_INVALID");
			return snapshotGateway.retain(ownerId, input);
		}
		if (command === "snapshot.release") {
			if (!snapshotGateway) throw fail("SNAPSHOT_LEASE_INVALID");
			return snapshotGateway.release(ownerId, input);
		}
		if (command === "file.save-copy") {
			const artifact = context.store.read("artifact", input.artifactId),
				frozenRun = artifact && context.store.read("run", artifact.runId);
			return context.fileContext.run(frozenRun, () => saveCopy(context, input));
		}
		if (command === "library.migrate") {
			activeManager(context);
			const migration = require("./migration-host.cjs").migrateHostLibrary({
				context,
				settings,
				dependencies,
				protocol,
				probe,
				jobs: new Set(jobs),
				owners,
				localEnvironmentId
			});
			const rememberSettlement = () => {
				try {
					const paused = context.store.describe().migration;
					const operation = paused && context.store.read("operation", paused.operationId);
					if (
						operation?.type === "migrate-library" &&
						isDeepStrictEqual(operation.owner, context.identity)
					)
						settledMigrationOwners.set(operation.operationId, {
							owner: clone(operation.owner),
							revision: operation.revision
						});
				} catch {
					/* Without a complete local settlement proof recovery stays restricted. */
				}
			};
			migration.then(rememberSettlement, rememberSettlement);
			background(migration, context);
			return migration;
		}
		if (command === "library.empty-recycle") {
			const manager = activeManager(context),
				operation = (async () => {
					const plan = await context.ioAdmission.run("read", () =>
						context.assets.planEmptyTrash({
							manager,
							recycleIds: context.store
								.list("recycleRecord")
								.filter((record) => record.status === "recycled")
								.map((record) => record.recycleId)
						})
					);
					const accepted = await dependencies.confirmImpact?.({
						purpose: "empty-recycle",
						ownerId,
						impact: plan.impact
					});
					if (!accepted) throw fail("OPERATION_CONFIRMATION_REQUIRED");
					const result = await context.ioAdmission.run(
						"write",
						() =>
							context.assets.emptyTrash({
								planId: plan.planId,
								confirmationToken: plan.confirmationToken
							}),
						{ wait: true }
					);
					return {
						operationId: plan.planId,
						items: (result.results || []).map((value) => ({
							taskId: value.taskId || "",
							displayName: value.taskId || "",
							outcome: value.state === "deleted" ? "succeeded" : "failed",
							message: value.error
						}))
					};
				})();
			background(operation, context);
			return operation;
		}
		throw fail("TASK_COMMAND_UNSUPPORTED");
	}
	async function saveCopy(context, { artifactId, expectedSourceIdentity }) {
		const resolved = await context.resolveArtifactSource({ artifactId });
		require("./preview.cjs").assertPreviewSourceIdentity(resolved, expectedSourceIdentity);
		const artifact = resolved.artifact,
			location = resolved.location;
		if (!location) throw fail("ARTIFACT_NOT_FOUND");
		const target = await dependencies.chooseSaveFile?.({
			purpose: "artifact-copy",
			artifactId,
			ownerId: context.ownerId
		});
		if (!target) return { saved: false };
		noLinks(target);
		const ioLease = context.ioAdmission.acquire("read");
		context.activeReads ||= new Map();
		context.activeReads.set(artifactId, (context.activeReads.get(artifactId) || 0) + 1);
		try {
			const transport = resolved.transport,
				identity = await transport.stat(location.path);
			require("./preview.cjs").assertPreviewSourceIdentity(
				{ ...resolved, identity },
				expectedSourceIdentity || require("./preview.cjs").previewSourceIdentity(resolved)
			);
			const range = { offset: 0, length: identity.byteSize },
				before = await transport.hash({
					path: location.path,
					identity,
					algorithm: "sha256",
					range
				}),
				fd = await fs.promises.open(target, "wx", 0o600),
				hash = crypto.createHash("sha256");
			try {
				for (let offset = 0; offset < identity.byteSize; offset += 1024 * 1024) {
					const length = Math.min(1024 * 1024, identity.byteSize - offset),
						result = await transport.readRange({ path: location.path, identity, offset, length }),
						bytes = Buffer.from(result.bytes || result);
					if (bytes.length !== length) throw fail("SAVE_COPY_SHORT_READ");
					await fd.write(bytes);
					hash.update(bytes);
				}
				const after = await transport.hash({
					path: location.path,
					identity: await transport.stat(location.path),
					algorithm: "sha256",
					range
				});
				if (hash.digest("hex") !== before.hash || before.hash !== after.hash)
					throw fail("SAVE_COPY_SOURCE_CHANGED");
				await fd.sync();
			} finally {
				await fd.close();
			}
			return { saved: true, path: target };
		} finally {
			ioLease.release();
			const remaining = context.activeReads.get(artifactId) - 1;
			if (remaining) context.activeReads.set(artifactId, remaining);
			else context.activeReads.delete(artifactId);
		}
	}
	function assertMigrationRepairSnapshot(
		context,
		snapshot,
		thisCheck,
		thawed = false,
		acquiring = false
	) {
		if (acquiring) {
			if (
				!context.entries.size ||
				!isDeepStrictEqual(context.store.describe().manager, snapshot.manager)
			)
				throw fail("MIGRATION_RECOVERY_STATE_CHANGED");
		} else activeManager(context);
		if (
			[...jobs].some((job) => job !== thisCheck()) ||
			!isDeepStrictEqual(pointer(), snapshot.pointer) ||
			!effective(context) ||
			!isDeepStrictEqual(context.store.describe().migration, snapshot.migration) ||
			!isDeepStrictEqual(
				context.store.read("operation", snapshot.operation.operationId),
				snapshot.operation
			) ||
			!isDeepStrictEqual(settings.read().value.freeze || null, thawed ? null : snapshot.freeze)
		)
			throw fail("MIGRATION_RECOVERY_STATE_CHANGED");
	}
	async function migrationRepairStatus(context, thisCheck, acquiring = false) {
		const migration = context.store.describe().migration,
			freeze = settings.read().value.freeze || null;
		if (!migration && freeze?.type !== "migrate-library")
			return { present: false, canRepair: false };
		const blocked = (reason) => ({ present: true, canRepair: false, reason });
		if (acquiring) {
			if (!context.entries.size || !freeze) return blocked("需要有效管理入口及迁库冻结证据");
		} else {
			try {
				activeManager(context);
			} catch {
				return blocked("需要当前任务库管理权");
			}
		}
		if ([...jobs].some((job) => job !== thisCheck()))
			return blocked("仍有在途操作，暂不能恢复迁库暂停");
		const current = pointer(),
			operation = migration && context.store.read("operation", migration.operationId),
			scope = operation?.authorizationScope;
		if (
			!effective(context) ||
			!current ||
			!operation ||
			operation.type !== "migrate-library" ||
			!operation.owner ||
			["succeeded", "failed", "cancelled"].includes(operation.operationState) ||
			(scope.libraryId || scope.sourceLibraryId) !== current.libraryId ||
			migration.sourceLibraryId !== current.libraryId ||
			migration.targetLibraryId !== scope.targetLibraryId ||
			scope.beforePointer?.libraryId !== current.libraryId ||
			scope.beforePointer.locationEpoch !== current.locationEpoch ||
			typeof (scope.beforePointer.root || scope.beforePointer.directory) !== "string" ||
			path.resolve(scope.beforePointer.root || scope.beforePointer.directory).toLowerCase() !==
				path.resolve(current.root).toLowerCase() ||
			typeof scope.sourceDirectory !== "string" ||
			path.resolve(scope.sourceDirectory).toLowerCase() !==
				path.resolve(current.root).toLowerCase() ||
			typeof scope.targetDirectory !== "string" ||
			!path.isAbsolute(scope.targetDirectory) ||
			path.resolve(scope.targetDirectory).toLowerCase() ===
				path.resolve(current.root).toLowerCase() ||
			(freeze &&
				(freeze.type !== "migrate-library" ||
					freeze.operationId !== operation.operationId ||
					freeze.libraryId !== current.libraryId ||
					freeze.locationEpoch !== current.locationEpoch ||
					freeze.sourceDirectory !== scope.sourceDirectory ||
					freeze.targetDirectory !== scope.targetDirectory))
		)
			return blocked("有效来源库或迁库身份不一致");
		const snapshot = {
			pointer: clone(current),
			migration: clone(migration),
			operation: clone(operation),
			freeze: clone(freeze),
			manager: clone(context.store.describe().manager)
		};
		const local = settledMigrationOwners.get(operation.operationId);
		const locallySettled =
			local?.revision === operation.revision && isDeepStrictEqual(local.owner, operation.owner);
		const ownerState = locallySettled ? "same-host-settled" : await probe(operation.owner);
		if (ownerState !== "same-host-settled" && ownerState !== "dead")
			return blocked("原迁库 owner 尚未确认结束");
		if (
			acquiring &&
			snapshot.manager.instanceId &&
			!(locallySettled && isDeepStrictEqual(snapshot.manager.processIdentity, local.owner)) &&
			(await probe(snapshot.manager.processIdentity)) !== "dead"
		)
			return blocked("原管理 owner 尚未确认结束");
		try {
			assertMigrationRepairSnapshot(context, snapshot, thisCheck, false, acquiring);
		} catch {
			return blocked("迁库状态已变化，请重新自检");
		}
		return { present: true, canRepair: true, snapshot, ownerState };
	}
	async function selfCheck(context, input, existingJobs = new Set(jobs), thisCheck = () => null) {
		if (!context.store) {
			const location = pointer();
			if (!location) throw fail("LIBRARY_ASSOCIATION_REQUIRED");
			let baseline;
			try {
				baseline = inspectBaseline({ directory: location.root, libraryId: location.libraryId });
			} catch (error) {
				return {
					checkId: crypto.randomUUID(),
					issues: [
						{
							id: "unrecoverable-baseline",
							message: "任务库不可用，未找到可核验的完整恢复基线",
							repairable: false,
							details: error.code
						}
					]
				};
			}
			if (input.repair)
				return require("./recovery-host.cjs").recoverHostLibrary({
					context,
					settings,
					dependencies,
					protocol,
					probe,
					owners,
					jobs: existingJobs,
					baseline
				});
			return {
				checkId: crypto.randomUUID(),
				issues: [
					{
						id: "recoverable-library",
						message: "任务库不可用；已找到完整基线与连续日志，可保原件恢复到新目录",
						repairable: true
					}
				]
			};
		}
		let report = context.store.recoveryReport();
		let migrationRecovery = await migrationRepairStatus(context, thisCheck);
		if (input.repair) {
			if (migrationRecovery.present && !migrationRecovery.canRepair)
				throw fail("MIGRATION_RECOVERY_NOT_SAFE", migrationRecovery.reason);
			if (migrationRecovery.canRepair)
				assertMigrationRepairSnapshot(context, migrationRecovery.snapshot, thisCheck);
			const currentPointer = pointer(),
				frozen = settings.read().value.freeze;
			if (frozen?.type === "migrate-library" && frozen.sourceDirectory === currentPointer.root) {
				if (existingJobs.size) throw fail("RECOVERY_ACTIVE_OPERATION");
				const owner = context.store.describe().manager;
				if (
					owner.instanceId &&
					owner.instanceId !== context.identity.instanceId &&
					(await probe(owner.processIdentity)) !== "dead"
				)
					throw fail("RECOVERY_MANAGER_STILL_ALIVE_OR_UNKNOWN");
				await settings.thawMetadata(currentPointer, frozen.operationId);
				assertMigrationRepairSnapshot(context, migrationRecovery.snapshot, thisCheck, true);
				if (!context.claim) {
					const acquired = await context.store.acquireManager();
					if (!acquired.acquired) throw fail("MANAGEMENT_REQUIRED");
					context.claim = acquired.manager;
				}
			}
			const claim = activeManager(context),
				migration = context.store.describe().migration;
			if (migration) {
				assertMigrationRepairSnapshot(
					context,
					migrationRecovery.snapshot,
					thisCheck,
					Boolean(frozen)
				);
				if (existingJobs.size) throw fail("RECOVERY_ACTIVE_OPERATION");
				const operation = context.store.read("operation", migration.operationId);
				if (
					!operation ||
					path.resolve(operation.authorizationScope.sourceDirectory) !==
						path.resolve(currentPointer.root)
				)
					throw fail("MIGRATION_POINTER_VERIFICATION_REQUIRED");
				context.store.clearMigrationPause({ manager: claim, operationId: migration.operationId });
				context.store.commit({
					manager: claim,
					mutations: [
						{
							kind: "operation",
							id: operation.operationId,
							expectedRevision: operation.revision,
							value: {
								...operation,
								revision: operation.revision + 1,
								phase: "inactive-candidate-retained-source-effective",
								operationState: "failed",
								transitionEvidence: {
									type: "verification",
									checkedAt: now(),
									evidenceRefs: [
										"pointer:" + currentPointer.libraryId + ":" + currentPointer.locationEpoch
									]
								},
								results: [
									...operation.results,
									{
										sourceEffective: true,
										ownerVerification: {
											state: migrationRecovery.ownerState,
											owner: clone(operation.owner),
											operationRevision: operation.revision,
											checkedAt: now()
										},
										targetRetainedInactive: operation.authorizationScope.targetDirectory,
										externalActionsReplayed: false
									}
								]
							}
						}
					]
				});
				settledMigrationOwners.delete(operation.operationId);
			}
			for (const run of report.unverifiedRuns.slice(0, 100))
				await context.monitoring.refresh(run.taskId, false);
			for (const operation of report.pendingOperations.slice(0, 100))
				if (["archive", "cleanup", "recycle", "restore", "empty-trash"].includes(operation.type)) {
					if (require("./operation-guards.cjs").restoreFileIOSettlement(operation)) continue;
					const reconciled =
						operation.type === "restore" && context.assets.reconcileRestoreOperation
							? await context.assets.reconcileRestoreOperation({
									manager: claim,
									operationId: operation.operationId
								})
							: null;
					if (reconciled?.reconciled !== true)
						await context.assets.inspectOperation(operation.operationId);
				}
			context.monitoring.applyReceipts(claim);
			context.store.checkpoint({ manager: claim });
			report = context.store.recoveryReport();
			migrationRecovery = { present: false, canRepair: false };
		}
		const otherRepairsAllowed = !migrationRecovery.present || migrationRecovery.canRepair;
		return {
			checkId: crypto.randomUUID(),
			issues: [
				...(report.integrity.some((value) => value !== "ok")
					? [{ id: "integrity", message: "任务库完整性异常", repairable: otherRepairsAllowed }]
					: []),
				...(!report.previousBaseline?.verified
					? [{ id: "baseline", message: "上一有效基线尚未核验", repairable: otherRepairsAllowed }]
					: []),
				...report.pendingOperations
					.filter((value) => !require("./operation-guards.cjs").restoreFileIOSettlement(value))
					.map((value) => ({
						id: value.operationId,
						message:
							value.type === "migrate-library"
								? migrationRecovery.canRepair
									? "迁库已中断，可保留目标候选并恢复来源库"
									: `迁库待核实：${migrationRecovery.reason || "当前状态不允许恢复"}`
								: `操作待核实：${value.type}`,
						repairable:
							value.type === "migrate-library"
								? migrationRecovery.canRepair &&
									value.operationId === migrationRecovery.snapshot?.operation.operationId
								: otherRepairsAllowed &&
									value.type === "restore" &&
									typeof context.assets?.reconcileRestoreOperation === "function"
					})),
				...report.unverifiedRuns.slice(0, 100).map((run) => ({
					id: run.runId,
					message: `运行状态待按原身份核实：${run.runId}`,
					repairable: otherRepairsAllowed
				})),
				...(report.unverifiedRuns.length > 100 && input.repair
					? [
							{
								id: "bounded-check",
								message: `本次已核前100个待核实运行，仍有${report.unverifiedRuns.length - 100}个待继续检查`,
								repairable: true
							}
						]
					: [])
			]
		};
	}
	async function request(ownerId, command, input, options) {
		const result = await dispatch(ownerId, command, input, options);
		if (
			![
				"center.read",
				"task.details",
				"monitor.read",
				"preview.read",
				"preview.find",
				"snapshot.describe",
				"snapshot.read-range",
				"snapshot.readRange",
				"submission.preview"
			].includes(command)
		)
			notifyChanged({ type: "records-changed", command, ownerId });
		return result;
	}
	async function releaseOwner(ownerId) {
		const context = owners.get(ownerId);
		if (!context) return;
		const continuing = !closing && context.resultAdoption?.hasPending();
		if (continuing) await context.monitoring?.detachViews();
		else { await context.resultAdoption?.suspend(); await context.monitoring?.stop(); }
		await cancelFileObservations(context, undefined, true);
        if (context.dependencyRegistry) context.dependencyRegistry.closed = true;
		await context.submission?.dispose();
		for (const entry of [...context.entries]) await leave(context, entry);
		context.preview?.dispose();
		for (const gateway of context.snapshotGateways || []) await gateway.releaseOwner(ownerId);
		context.released = true;
		if (!jobs.size && !continuing) {
			await context.execution?.dispose();
			for (const promise of context.transportCache.values())
				try {
					await (await promise).dispose();
				} catch {}
			context.store?.close();
			owners.delete(ownerId);
		}
	}
	function exitSummary() {
		if (!owners.size && pointer()) owner("host-exit-observer");
		const runs = [],
			operations = [];
		let unavailable = false;
		for (const context of owners.values()) {
			if (context.openError) unavailable = true;
			if (!context.store || !effective(context)) continue;
			for (const run of context.store.list("run"))
				if (
					!context.store.read("task", run.taskId)?.deleted &&
					(run.state.executionState !== "ended" || run.state.verificationState !== "verified") &&
					!runs.some((x) => x.runId === run.runId)
				)
					runs.push({
						taskId: run.taskId,
						runId: run.runId,
						executionState: run.state.executionState,
						verificationState: run.state.verificationState
					});
			for (const op of context.store.list("operation"))
				if (
					!require("./operation-guards.cjs").isDeletedTaskOperation(context.store, op) &&
					!["succeeded", "failed", "cancelled"].includes(op.operationState) &&
					!operations.some((x) => x.operationId === op.operationId)
				)
					operations.push({
						operationId: op.operationId,
						type: op.type,
						operationState: op.operationState,
						configured: op.authorizationScope.configured !== false
					});
		}
		const pendingStops = pointer()
			? queuedStops
					.list(pointer().libraryId)
					.filter(
						(queued) =>
							![...owners.values()].some(
								(context) => context.store?.read("task", queued.taskId)?.deleted
							)
					)
			: [];
		const preparationCount = operations.filter(
			(value) => value.type === "result-preparation" && value.configured
		).length;
		return {
			runs,
			operations,
			pendingStops: pendingStops.map((value) => ({
				operationId: value.operationId,
				taskId: value.taskId,
				runId: value.runId,
				state: value.queueState,
				reason: value.reason || null
			})),
			activeOperations: jobs.size,
			unavailable,
			counts: {
				runningOrUnverified: runs.length,
				resultPreparations: preparationCount,
				fileOperations: jobs.size,
				pendingRecords: operations.length,
				queuedStops: pendingStops.length
			},
			requiresChoice: !!(runs.length || jobs.size || preparationCount || pendingStops.length)
		};
	}
	async function prepareExit(choice) {
		if (choice === "cancel") {
			for (const context of owners.values())
				if (context.entries.has("host-exit-management"))
					await leave(context, "host-exit-management");
			return { ready: false, cancelled: true, remaining: exitSummary() };
		}
		if (!["continue", "stop"].includes(choice)) throw fail("EXIT_CHOICE_INVALID");
		closing = true;
		await Promise.allSettled([...owners.values()].map(context => context.resultAdoption?.suspend("exit-requested")));
		if (choice === "stop") {
			await settle();
			const context =
				[...owners.values()].find(
					(value) => value.store && effective(value) && managerView(value).access === "manager"
				) || owner("host-exit-observer");
			const stopping = dependencies.stopAndVerifyAll
				? dependencies.stopAndVerifyAll({ summary: exitSummary(), request })
				: require("./exit.cjs").stopForExit({
						context,
						owners,
						timeoutMs: dependencies.stopVerificationTimeoutMs || 10000
					});
			background(stopping);
			const verified = await stopping;
			if (verified?.verified !== true)
				return {
					ready: false,
					reason: verified?.reason || "任务或准备过程仍未确认结束",
					remaining: verified?.remaining || exitSummary(),
					errors: verified?.errors || []
				};
		}
		await Promise.allSettled([...owners.values()].map((value) => value.monitoring?.stop()));
		for (const context of owners.values()) context.preview?.dispose();
		if (jobs.size)
			return { ready: false, reason: "已登记文件操作正在安全收尾", remaining: exitSummary() };
		return { ready: true, continueComputing: choice === "continue", remaining: exitSummary() };
	}
	async function settle({ signal } = {}) {
		while (jobs.size) {
			if (signal?.aborted) throw fail("TASK_WAIT_CANCELLED");
			const pending = Promise.allSettled([...jobs]);
			if (!signal) await pending;
			else
				await new Promise((resolve, reject) => {
					const cancel = () => {
						signal.removeEventListener("abort", cancel);
						reject(fail("TASK_WAIT_CANCELLED"));
					};
					signal.addEventListener("abort", cancel, { once: true });
					pending.then((value) => {
						signal.removeEventListener("abort", cancel);
						resolve(value);
					});
				});
		}
		return { idle: true, activeOperations: 0 };
	}
	return {
		request,
		async suspendResultAdoptionForDispose() { closing = true; await Promise.allSettled([...owners.values()].map(context => context.resultAdoption?.suspend("application-closed"))); },
		releaseOwner,
		exitSummary,
		prepareExit,
		resumeAfterCancelledExit() {
			closing = false;
			let resumedCount = 0;
			for (const context of owners.values()) {
				if (!context.released && context.store && effective(context)) context.resultAdoption?.resume();
				if (context.entries.has("host-exit-management"))
					background(leave(context, "host-exit-management"));
				if (
					!context.released &&
					context.store &&
					context.claim &&
					context.entries.size &&
					effective(context)
				) {
					try {
						context.store.assertManager(context.claim);
						context.monitoring.start();
						context.resultAdoption?.resume();
						resumedCount++;
					} catch {}
				}
			}
			return { resumedCount };
		},
		settle,
		whenIdle(listener) {
			idleListeners.add(listener);
			return () => idleListeners.delete(listener);
		},
		settings,
		vault,
		async describeSnapshotSource(ownerId, input) {
			const context = owners.get(ownerId),
				gateway = context?.snapshotGateways?.find((value) => value.has(ownerId, input.snapshotId));
			if (!gateway) throw fail("SNAPSHOT_LEASE_INVALID");
			return gateway.describeSource(ownerId, input);
		},
		async disposeUI() {
			closing = true;
			await Promise.all([...owners.keys()].map(releaseOwner));
			vault.clearTransient();
			hostKeys.clear();
			disposed = true;
		}
	};
}
module.exports = { createTaskSystemHost, COMMANDS, managementLiveness };
