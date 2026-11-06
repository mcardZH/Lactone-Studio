"use strict";
const { verifiedOwnerEndReceipt } = require("../execution/scheduler-end.cjs");
const { path, fail, clone, hashLocal } = require("./io.cjs");
const { base, id, scopeDigest, assertFrozenScope } = require("./common.cjs");
function createAssetService(options) {
	const { library, transportFor, libraryDirectory, localEnvironmentId, assertNoActiveIO } = options;
	if (
		!library ||
		typeof transportFor !== "function" ||
		typeof assertNoActiveIO !== "function" ||
		!path.isAbsolute(libraryDirectory) ||
		!localEnvironmentId
	)
		throw fail("ASSET_SERVICE_DEPENDENCIES_REQUIRED");
	const now = options.now || (() => new Date().toISOString()),
		fault = options.fault || (() => {}),
		permits = new Map(),
		executionLocks = new Set();
	const location = (file) => ({ environmentId: localEnvironmentId, path: file });
	async function transport(environmentId) {
		const value = await transportFor(environmentId);
		if (!value) throw fail("ASSET_TRANSPORT_UNAVAILABLE");
		return value;
	}
	function assertEndedMetadata(taskId, runId) {
		const run = library.read("run", runId);
		if (
			!run ||
			run.taskId !== taskId ||
			run.state.executionState !== "ended" ||
			run.state.verificationState !== "verified" ||
			!verifiedOwnerEndReceipt(run)
		)
			throw fail("ASSET_RUN_NOT_VERIFIED_ENDED");
		return run;
	}
	async function safeState(taskId, runId, artifactIds = [], operationId) {
		const run = assertEndedMetadata(taskId, runId);
		const evidence = await assertNoActiveIO({
			taskId,
			runId,
			artifactIds,
			...(operationId ? { operationId } : {})
		});
		if (evidence?.safe !== true) throw fail("ASSET_ACTIVE_IO_OR_DEPENDENCY");
		return { run, evidence };
	}
	function begin(manager, type, targets, scope) {
		const operation = {
			...base(),
			requiredCapabilities: [...(scope.requiredCapabilities || [])],
			operationId: scope.operationId || id("op"),
			type,
			targets,
			preconditions: {},
			authorizationScope: { ...clone(scope), scopeDigest: scopeDigest(scope) },
			phase: "intent-persisted",
			operationState: "pending",
			results: []
		};
		const started = library.beginOperation({ manager, operation });
		permits.set(started.operation.operationId, started.permit);
		return started.operation;
	}
	function update(operation, phase, state, results = [], mutations = [], progress) {
		const value = {
			...operation,
			revision: operation.revision + 1,
			phase,
			operationState: state,
			results: [...operation.results, ...results],
			...(progress ? { progress: { ...progress, observedAt: now() } } : {}),
			transitionEvidence: {
				type:
					state === "succeeded"
						? "operation-complete"
						: state === "partial"
							? "operation-partial"
							: "verification",
				checkedAt: now(),
				evidenceRefs: ["operation:" + operation.operationId + ":" + phase]
			}
		};
		const permit = permits.get(operation.operationId);
		if (!permit) throw fail("ASSET_OPERATION_RESUME_REQUIRED");
		return library.commitOperation({
			permit,
			expectedRevision: operation.revision,
			operation: value,
			mutations
		}).operation;
	}
	function claimRegistered(operationId, type) {
		if (executionLocks.has(operationId)) throw fail("ASSET_OPERATION_ALREADY_EXECUTING");
		const permit = permits.get(operationId);
		if (!permit) throw fail("ASSET_OPERATION_RESUME_REQUIRED");
		const op = library.operationPermit(permit);
		assertFrozenScope(op);
		if (op.type !== type || op.operationState !== "pending" || op.phase !== "intent-persisted")
			throw fail("ASSET_OPERATION_ALREADY_STARTED");
		const next = update(op, "execution-started", "running");
		executionLocks.add(operationId);
		return next;
	}
	const mutation = (kind, key, value, expectedRevision = null) => ({
		kind,
		id: key,
		expectedRevision,
		value
	});
	const context = {
		assertEndedMetadata,
		claimRegistered,
		executionLocks,
		assertNoActiveIO,
		library,
		libraryDirectory,
		localEnvironmentId,
		safeState,
		begin,
		update,
		mutation,
		now,
		fault,
		transport,
		location,
		permits
	};
	const {
		planArchive,
		archive,
		recoverArchive,
		retryArchive,
		registerArchive,
		executeRegisteredArchive
	} = require("./archive.cjs").createArchive(context);
	const { planCleanup, cleanup } = require("./cleanup.cjs").createCleanup(context);
	const { materializeSnapshot } = require("./snapshot.cjs").createSnapshot(context);
	return {
		...require("./clear-work.cjs").createClearWork(context),
		...require("./logical-recycle.cjs").createLogicalRecycle(context),
		...require("./deletion.cjs").createDeletion(context),
		registerArchive,
		executeRegisteredArchive,
		planArchive,
		archive,
		recoverArchive,
		retryArchive,
		planCleanup,
		cleanup,
		materializeSnapshot,
		async resumeOperation({ manager, operationId, expectedRevision, evidence }) {
			const result = await library.resumeOperation({
				manager,
				operationId,
				expectedRevision,
				evidence
			});
			permits.set(operationId, result.permit);
			return result.operation;
		},
		async inspectOperation(operationId) {
			const op = library.read("operation", operationId);
			if (!op) throw fail("ASSET_OPERATION_NOT_FOUND");
			const observations = [],
				candidates = [];
			for (const item of op.authorizationScope.manifest?.items || [])
				if (item.included !== false)
					candidates.push(
						item.targetPath
							? { artifactId: item.artifactId, path: item.targetPath }
							: item.originalLocation
								? {
										artifactId: item.artifactId,
										...item.originalLocation,
										identity: item.fileIdentity
									}
								: null
					);
			for (const item of op.authorizationScope.entries || [])
				candidates.push({ artifactId: item.artifactId, path: item.identity.path });
			for (const item of op.authorizationScope.files || []) {
				candidates.push({ artifactId: item.artifactId, path: item.originalIdentity.path });
				candidates.push({ artifactId: item.artifactId, path: item.recycleIdentity.path });
			}
			for (const result of op.results)
				if (result.recycleIdentity)
					candidates.push({ artifactId: result.artifactId, path: result.recycleIdentity.path });
			for (const item of candidates.filter(Boolean)) {
				try {
					const info = item.environmentId
						? await (
								await transport(item.environmentId)
							).hash({ path: item.path, identity: item.identity, algorithm: "sha256" })
						: await hashLocal(item.path);
					observations.push({
						artifactId: item.artifactId,
						path: item.path,
						present: true,
						identity: info
					});
				} catch (error) {
					observations.push({
						artifactId: item.artifactId,
						path: item.path,
						present: error.code === "ENOENT" ? false : null,
						error: error.code || String(error)
					});
				}
			}
			return { operation: op, observations, automaticExternalAction: false };
		},
		...require("./recycle.cjs").createRecycle({
			assertEndedMetadata,
			claimRegistered,
			executionLocks,
			library,
			libraryDirectory,
			location,
			safeState,
			begin,
			update,
			mutation,
			now,
			fault,
			transport
		}),
		...require("./migration.cjs").createMigration({
			library,
			libraryDirectory,
			begin,
			update,
			now,
			fault,
			permits
		})
	};
}
module.exports = { createAssetService };
