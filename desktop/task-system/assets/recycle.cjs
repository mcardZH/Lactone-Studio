"use strict";
const {
	fs,
	path,
	crypto,
	fail,
	digest,
	clone,
	inside,
	ensureDirectory,
	exclusiveDirectory,
	hashLocal,
	atomicJSON,
	copySource,
	removeExact,
	listExactFiles
} = require("./io.cjs");
const base = () => ({ schemaVersion: 1, revision: 1, requiredCapabilities: [] });
const { assertScopeSize } = require("./common.cjs");
const { isDeepStrictEqual } = require("node:util");
function createRecycle(context) {
	const {
		library,
		libraryDirectory,
		location,
		safeState,
		begin,
		update,
		mutation,
		now,
		fault,
		transport,
		assertEndedMetadata,
		claimRegistered,
		executionLocks
	} = context;
	async function localCopy(file, target) {
		const t = await transport(location(file).environmentId),
			identity = await t.stat(file);
		return copySource({ path: file, identity, sha256: (await hashLocal(file)).sha256 }, target, {
			transport: t,
			fault
		});
	}
	function restoreSettlement(
		operation,
		record,
		archive,
		outcome,
		conflicts,
		{ source = "restore-executor", sideEffectState = "settled", observations = [] } = {}
	) {
		return {
			kind: "restore-file-io-settlement-v1",
			operationId: operation.operationId,
			taskId: record.taskId,
			runId: record.runId,
			recycleId: record.recycleId,
			owner: clone(operation.owner),
			source,
			fileIOState: "released",
			sideEffectState,
			outcome,
			settledAt: now(),
			recordRevision: record.revision,
			archiveManifestRevision: archive.revision,
			remainingArtifactIds: record.files.map((file) => file.artifactId),
			remainingFiles: clone(record.files),
			conflicts: clone(conflicts),
			evidenceRefs: [
				`operation:${operation.operationId}:file-io-settled`,
				`recycle:${record.recycleId}:revision:${record.revision}`,
				`archive:${record.archiveManifestId}:revision:${archive.revision}`,
				...observations.map(
					(value, index) =>
						`restore-inspection:${operation.operationId}:${index}:${value.sha256 || value.state}`
				)
			]
		};
	}
	function registerRecycle({
		manager,
		taskId,
		archiveManifestId,
		artifactIds,
		knownReferences = []
	}) {
		library.assertManager(manager);
		const archive = library.read("archiveManifest", archiveManifestId),
			task = library.read("task", taskId);
		if (
			!task ||
			!archive ||
			archive.taskId !== taskId ||
			archive.status !== "verified" ||
			task.recycleState === "recycled"
		)
			throw fail("ASSET_RECYCLE_SCOPE_INVALID");
		const selected = archive.items.filter(
			(x) => x.included && (!artifactIds || artifactIds.includes(x.artifactId))
		);
		if (!selected.length || selected.some((x) => x.storageState === "recycled"))
			throw fail("ASSET_RECYCLE_SCOPE_INVALID");
		if (
			artifactIds &&
			(new Set(artifactIds).size !== artifactIds.length || selected.length !== artifactIds.length)
		)
			throw fail("ASSET_RECYCLE_SCOPE_INVALID");
		assertEndedMetadata(taskId, archive.runId);
		const recycleId = "recycle-" + crypto.randomUUID(),
			directory = path.join(libraryDirectory, "trash", recycleId);
		const targets = [
			{ kind: "recycleRecord", id: recycleId },
			{ kind: "archiveManifest", id: archiveManifestId },
			...(!artifactIds ? [{ kind: "task", id: taskId }] : [])
		];
		const scope = {
			taskId,
			archiveManifestId,
			artifactIds: selected.map((x) => x.artifactId),
			wholeTask: !artifactIds,
			knownReferences,
			originalGroupId: task.groupId,
			recycleId,
			directory,
			task: clone(task),
			archive: clone(archive)
		};
		assertScopeSize(scope, selected.length);
		const op = begin(manager, "recycle", targets, scope);
		return { operationId: op.operationId };
	}
	async function executeRegisteredRecycle({ operationId }) {
		let op = claimRegistered(operationId, "recycle");
		const {
				taskId,
				archiveManifestId,
				artifactIds,
				wholeTask,
				knownReferences,
				recycleId,
				directory,
				task,
				archive
			} = clone(op.authorizationScope),
			selected = archive.items.filter((x) => x.included && artifactIds.includes(x.artifactId));
		try {
			if (
				library.read("task", taskId)?.revision !== task.revision ||
				library.read("archiveManifest", archiveManifestId)?.revision !== archive.revision
			)
				throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
			await safeState(taskId, archive.runId, artifactIds, op.operationId);
			await ensureDirectory(path.dirname(directory));
			await exclusiveDirectory(directory);
			const next = clone(archive),
				copies = [];
			for (const item of selected) {
				inside(path.join(libraryDirectory, "archive"), item.targetPath);
				const current = await hashLocal(item.targetPath);
				if (current.sha256 !== item.sha256 || current.byteSize !== item.byteSize)
					throw fail("ASSET_ARCHIVE_COPY_CHANGED");
				const target = path.join(directory, path.basename(item.targetPath)),
					copy = await localCopy(item.targetPath, target);
				copies.push({
					artifactId: item.artifactId,
					originalIdentity: current,
					recycleIdentity: copy
				});
				const updated = next.items.find((x) => x.artifactId === item.artifactId);
				updated.storageState = "recycled";
				updated.recyclePath = target;
				op = update(op, "copying-to-trash", "running", [
					{ artifactId: item.artifactId, recycleIdentity: copy }
				]);
			}
			await safeState(
				taskId,
				archive.runId,
				selected.map((x) => x.artifactId),
				op.operationId
			);
			const record = {
				...base(),
				recycleId,
				taskId,
				runId: archive.runId,
				archiveManifestId,
				artifactIds: selected.map((x) => x.artifactId),
				originalGroupId: task.groupId,
				originalLocations: selected.map((x) => location(x.targetPath)),
				recycleLocations: copies.map((x) => location(x.recycleIdentity.path)),
				cleanupRecordRef: null,
				status: "recycled",
				wholeTask,
				knownReferences: clone(knownReferences),
				files: copies,
				createdAt: now()
			};
			await atomicJSON(path.join(directory, "recycle.json"), record);
			await fault("recycle-before-register", { record });
			next.revision++;
			const mutations = [
				mutation("recycleRecord", recycleId, record),
				mutation("archiveManifest", archiveManifestId, next, archive.revision)
			];
			if (wholeTask)
				mutations.push(
					mutation(
						"task",
						taskId,
						{
							...task,
							revision: task.revision + 1,
							recycleState: "recycled",
							recycleId,
							originalGroupId: task.groupId
						},
						task.revision
					)
				);
			// Publish complete verified trash before removing exact old copies. Failure leaves both.
			op = update(op, "trash-registered", "running", [], mutations);
			for (const file of copies) {
				await safeState(taskId, archive.runId, [file.artifactId], op.operationId);
				await removeExact(path.join(libraryDirectory, "archive"), file.originalIdentity);
				op = update(op, "removing-old-copies", "running", [
					{ artifactId: file.artifactId, originalRemoved: true }
				]);
			}
			update(op, "finished", "succeeded");
			return record;
		} catch (error) {
			update(op, "needs-inspection", "waiting-verification", [
				{ error: error.code || String(error) }
			]);
			throw error;
		} finally {
			executionLocks.delete(operationId);
		}
	}
	async function recycle(request) {
		const registered = registerRecycle(request);
		return executeRegisteredRecycle(registered);
	}
	function registerRestore({ manager, recycleId }) {
		library.assertManager(manager);
		const record = library.read("recycleRecord", recycleId);
		if (!record || !["recycled", "partially-restored"].includes(record.status))
			throw fail("ASSET_RECYCLE_NOT_FOUND");
		const task = library.read("task", record.taskId),
			archive = library.read("archiveManifest", record.archiveManifestId);
		if (!task || !archive || (record.wholeTask && task.recycleId !== recycleId))
			throw fail("ASSET_RESTORE_ID_CONFLICT");
		assertEndedMetadata(record.taskId, record.runId);
		const scope = {
			recycleId,
			files: record.files,
			record: clone(record),
			task: clone(task),
			archive: clone(archive)
		};
		assertScopeSize(scope, record.files.length);
		const op = begin(
			manager,
			"restore",
			[
				{ kind: "recycleRecord", id: recycleId },
				{ kind: "archiveManifest", id: record.archiveManifestId },
				...(record.wholeTask ? [{ kind: "task", id: record.taskId }] : [])
			],
			scope
		);
		return { operationId: op.operationId };
	}
	async function executeRegisteredRestore({ operationId }) {
		let op = claimRegistered(operationId, "restore");
		const { recycleId, record, task, archive } = clone(op.authorizationScope);
		let admissionPassed = false,
			fileEffectsStarted = false;
		try {
			if (
				library.read("recycleRecord", recycleId)?.revision !== record.revision ||
				library.read("task", record.taskId)?.revision !== task.revision ||
				library.read("archiveManifest", record.archiveManifestId)?.revision !== archive.revision
			)
				throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
			await safeState(record.taskId, record.runId, record.artifactIds, op.operationId);
			admissionPassed = true;
			const conflicts = [],
				restored = [],
				nextArchive = clone(archive);
			for (const file of record.files) {
				try {
					inside(path.join(libraryDirectory, "trash"), file.recycleIdentity.path);
					inside(path.join(libraryDirectory, "archive"), file.originalIdentity.path);
					try {
						await fs.lstat(file.originalIdentity.path);
						throw fail("ASSET_RESTORE_PATH_CONFLICT");
					} catch (error) {
						if (error.code !== "ENOENT") throw error;
					}
					const current = await hashLocal(file.recycleIdentity.path);
					if (
						current.sha256 !== file.recycleIdentity.sha256 ||
						current.byteSize !== file.recycleIdentity.byteSize
					)
						throw fail("ASSET_TRASH_CHANGED");
					fileEffectsStarted = true;
					const copy = await localCopy(file.recycleIdentity.path, file.originalIdentity.path);
					restored.push({ artifactId: file.artifactId, copy });
					const item = nextArchive.items.find((x) => x.artifactId === file.artifactId);
					item.storageState = "active";
					item.recyclePath = null;
					item.copyIdentity = copy;
					op = update(op, "restoring", "running", [{ artifactId: file.artifactId, copy }]);
				} catch (error) {
					conflicts.push({ artifactId: file.artifactId, error: error.code || String(error) });
				}
			}
			if (conflicts.length && !restored.length) {
				const uncertain = conflicts.some((value) => value.error !== "ASSET_RESTORE_PATH_CONFLICT");
				update(
					op,
					uncertain ? "needs-inspection" : "finished",
					uncertain ? "waiting-verification" : "partial",
					[
						{ conflicts, restored },
						...(!uncertain
							? [
									restoreSettlement(op, record, archive, "partial-path-conflict", conflicts, {
										sideEffectState: "not-started"
									})
								]
							: [])
					]
				);
				return { record, conflicts, restored };
			}
			const next = {
				...record,
				revision: record.revision + 1,
				status: conflicts.length ? "partially-restored" : "restored",
				restoredAt: now(),
				files: record.files.filter(
					(file) => !restored.some((x) => x.artifactId === file.artifactId)
				),
				restoredArtifactIds: [
					...(record.restoredArtifactIds || []),
					...restored.map((x) => x.artifactId)
				]
			};
			nextArchive.revision++;
			const mutations = [
				mutation("recycleRecord", recycleId, next, record.revision),
				mutation("archiveManifest", record.archiveManifestId, nextArchive, archive.revision)
			];
			if (record.wholeTask && !conflicts.length)
				mutations.push(
					mutation(
						"task",
						record.taskId,
						{
							...task,
							revision: task.revision + 1,
							groupId:
								record.originalGroupId && library.read("group", record.originalGroupId)
									? record.originalGroupId
									: null,
							recycleState: "active",
							recycleId: null
						},
						task.revision
					)
				);
			op = update(op, "restored-registered", "running", [], mutations);
			for (const file of record.files.filter((file) =>
				restored.some((x) => x.artifactId === file.artifactId)
			)) {
				await safeState(record.taskId, record.runId, [file.artifactId], op.operationId);
				await removeExact(path.join(libraryDirectory, "trash"), file.recycleIdentity);
			}
			const uncertain = conflicts.some((value) => value.error !== "ASSET_RESTORE_PATH_CONFLICT");
			update(
				op,
				uncertain ? "needs-inspection" : "finished",
				uncertain ? "waiting-verification" : conflicts.length ? "partial" : "succeeded",
				[
					{ conflicts, restored },
					...(!uncertain
						? [
								restoreSettlement(
									op,
									next,
									nextArchive,
									conflicts.length ? "partial-path-conflict" : "restored",
									conflicts
								)
							]
						: [])
				]
			);
			return { record: next, conflicts, restored };
		} catch (error) {
			const noEffects = !admissionPassed && !fileEffectsStarted;
			update(
				op,
				noEffects ? "admission-refused-no-file-effects" : "needs-inspection",
				noEffects ? "failed" : "waiting-verification",
				[
					{ error: error.code || String(error) },
					...(noEffects
						? [
								restoreSettlement(op, record, archive, "admission-refused", [], {
									sideEffectState: "not-started"
								})
							]
						: [])
				]
			);
			throw error;
		} finally {
			executionLocks.delete(operationId);
		}
	}
	async function restore(request) {
		const registered = registerRestore(request);
		return executeRegisteredRestore(registered);
	}
	async function reconcileRestoreOperation({ manager, operationId }) {
		library.assertManager(manager);
		const original = library.read("operation", operationId);
		if (
			!original ||
			original.type !== "restore" ||
			original.authorizationScope.purpose === "metadata-only-file-io-reconciliation"
		)
			return { reconciled: false, operationId, reason: "not-a-restore-attempt" };
		if (
			original.results.some(
				(value) =>
					value.kind === "restore-file-io-settlement-v1" &&
					value.operationId === operationId &&
					value.fileIOState === "released" &&
					isDeepStrictEqual(value.owner, original.owner) &&
					value.taskId === original.authorizationScope.record?.taskId &&
					value.runId === original.authorizationScope.record?.runId &&
					value.recycleId === original.authorizationScope.recycleId &&
					Number.isFinite(Date.parse(value.settledAt)) &&
					Array.isArray(value.evidenceRefs) &&
					value.evidenceRefs.length > 0 &&
					value.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0) &&
					Number.isSafeInteger(value.recordRevision) &&
					value.recordRevision >= original.authorizationScope.record?.revision &&
					Number.isSafeInteger(value.archiveManifestRevision) &&
					value.archiveManifestRevision >= original.authorizationScope.archive?.revision &&
					Array.isArray(value.remainingArtifactIds) &&
					Array.isArray(value.remainingFiles) &&
					new Set(value.remainingArtifactIds).size === value.remainingArtifactIds.length &&
					isDeepStrictEqual(
						[...value.remainingArtifactIds].sort(),
						value.remainingFiles.map((file) => file.artifactId).sort()
					) &&
					value.remainingFiles.every((file) =>
						isDeepStrictEqual(
							file,
							original.authorizationScope.record?.files?.find(
								(old) => old.artifactId === file.artifactId
							)
						)
					) &&
					((original.operationState === "partial" &&
						original.phase === "finished" &&
						value.source === "restore-executor" &&
						value.outcome === "partial-path-conflict" &&
						Array.isArray(value.conflicts) &&
						value.conflicts.length > 0 &&
						value.conflicts.every((item) => item.error === "ASSET_RESTORE_PATH_CONFLICT")) ||
						(original.operationState === "partial" &&
							original.phase === "restore-file-io-reconciled" &&
							value.source === "manager-repair" &&
							value.outcome === "partial-remainder-verified" &&
							value.sideEffectState === "settled") ||
						(original.operationState === "failed" &&
							original.phase === "admission-refused-no-file-effects" &&
							["restore-executor", "manager-repair"].includes(value.source) &&
							value.outcome === "admission-refused" &&
							value.sideEffectState === "not-started") ||
						(original.operationState === "succeeded" &&
							original.phase === "finished" &&
							value.source === "restore-executor" &&
							value.outcome === "restored" &&
							value.sideEffectState === "settled"))
			)
		)
			return { reconciled: true, operationId, reason: "already-settled" };
		const partial =
			original.operationState === "partial" && ["finished", "conflicts"].includes(original.phase);
		const denied =
			original.operationState === "waiting-verification" &&
			original.phase === "needs-inspection" &&
			original.results.length > 0 &&
			original.results.every(
				(value) =>
					value.error === "ASSET_ACTIVE_IO_OR_DEPENDENCY" && Object.keys(value).length === 1
			);
		if (!partial && !denied)
			return { reconciled: false, operationId, reason: "restore-effects-not-at-known-boundary" };
		if (executionLocks.has(operationId))
			return { reconciled: false, operationId, reason: "restore-still-executing" };
		const scope = original.authorizationScope,
			prior = scope.record,
			priorArchive = scope.archive,
			priorTask = scope.task;
		if (!prior || !priorArchive || !priorTask || !isDeepStrictEqual(scope.files, prior.files))
			return { reconciled: false, operationId, reason: "legacy-scope-incomplete" };
		const record = library.read("recycleRecord", prior.recycleId),
			archive = library.read("archiveManifest", prior.archiveManifestId),
			task = library.read("task", prior.taskId);
		if (
			!record ||
			!archive ||
			!task ||
			record.taskId !== prior.taskId ||
			record.runId !== prior.runId ||
			archive.runId !== record.runId ||
			record.archiveManifestId !== archive.manifestId ||
			task.recycleId !== record.recycleId ||
			task.recycleState !== "recycled"
		)
			return { reconciled: false, operationId, reason: "legacy-record-identity-conflict" };
		let inspection = begin(manager, "restore", [{ kind: "operation", id: operationId }], {
			purpose: "metadata-only-file-io-reconciliation",
			restoredOperationId: operationId,
			taskId: record.taskId,
			runId: record.runId,
			recycleId: record.recycleId,
			record: clone(record),
			archive: clone(archive),
			task: clone(task),
			files: []
		});
		inspection = update(inspection, "restore-file-io-reconciliation", "running");
		const observations = [];
		function reject(reason) {
			inspection = update(inspection, "restore-reconciliation-refused", "failed", [
				{ restoredOperationId: operationId, reason, observations }
			]);
			return { reconciled: false, operationId, reason };
		}
		async function observe(file, role) {
			try {
				const identity = await hashLocal(file);
				const value = { path: file, role, state: "present", ...identity };
				observations.push(value);
				return value;
			} catch (error) {
				if (error.code === "ENOENT") {
					const value = { path: file, role, state: "missing" };
					observations.push(value);
					return value;
				}
				if (
					["ASSET_LINK_REFUSED", "ASSET_NOT_REGULAR_FILE", "ASSET_CHANGED"].includes(error.code)
				) {
					const value = { path: file, role, state: "unsafe", error: error.code };
					observations.push(value);
					return value;
				}
				throw error;
			}
		}
		function identityMatches(expected, actual) {
			return (
				actual.state === "present" &&
				expected.path === actual.path &&
				expected.fileId === actual.fileId &&
				expected.byteSize === actual.byteSize &&
				expected.sha256 === actual.sha256 &&
				(!expected.changeToken || expected.changeToken === actual.changeToken)
			);
		}
		try {
			await safeState(record.taskId, record.runId, record.artifactIds, inspection.operationId);
			if (!isDeepStrictEqual(task, priorTask)) return reject("legacy-task-revision-changed");
			const remaining = new Set(record.files.map((file) => file.artifactId));
			if (
				remaining.size !== record.files.length ||
				record.files.some((file) => !prior.files.some((old) => isDeepStrictEqual(file, old)))
			)
				return reject("legacy-remaining-set-conflict");
			const restored = prior.files.filter((file) => !remaining.has(file.artifactId));
			if (denied || !restored.length) {
				if (!isDeepStrictEqual(record, prior) || !isDeepStrictEqual(archive, priorArchive))
					return reject("legacy-zero-effects-revision-changed");
			} else {
				const expected = {
					...clone(prior),
					revision: prior.revision + 1,
					status: "partially-restored",
					restoredAt: record.restoredAt,
					files: prior.files.filter((file) => remaining.has(file.artifactId)),
					restoredArtifactIds: [
						...(prior.restoredArtifactIds || []),
						...restored.map((file) => file.artifactId)
					]
				};
				if (
					!Number.isFinite(Date.parse(record.restoredAt)) ||
					!isDeepStrictEqual(record, expected) ||
					archive.revision !== priorArchive.revision + 1 ||
					!record.files.length
				)
					return reject("legacy-partial-revision-conflict");
			}
			const expectedArchive = clone(priorArchive);
			if (restored.length) expectedArchive.revision++;
			for (const file of prior.files) {
				try {
					inside(path.join(libraryDirectory, "archive"), file.originalIdentity.path);
					inside(path.join(libraryDirectory, "trash"), file.recycleIdentity.path);
				} catch (error) {
					if (error.code === "ASSET_OUTSIDE_SCOPE")
						return reject("legacy-path-outside-current-library");
					throw error;
				}
				const target = await observe(file.originalIdentity.path, "archive-destination"),
					trash = await observe(file.recycleIdentity.path, "recycle-payload");
				const item = archive.items.find((value) => value.artifactId === file.artifactId),
					oldItem = expectedArchive.items.find((value) => value.artifactId === file.artifactId);
				if (!item || !oldItem) return reject("legacy-archive-item-missing");
				if (remaining.has(file.artifactId)) {
					if (
						target.state !== "missing" ||
						!identityMatches(file.recycleIdentity, trash) ||
						item.storageState !== "recycled" ||
						item.recyclePath !== file.recycleIdentity.path
					)
						return reject("legacy-remainder-not-unambiguous");
				} else {
					const copied = original.results.find(
						(value) => value.artifactId === file.artifactId && value.copy
					)?.copy;
					if (
						trash.state !== "missing" ||
						!copied ||
						!identityMatches(copied, target) ||
						copied.sha256 !== file.recycleIdentity.sha256 ||
						copied.byteSize !== file.recycleIdentity.byteSize ||
						item.storageState !== "active" ||
						item.recyclePath !== null ||
						!isDeepStrictEqual(item.copyIdentity, copied)
					)
						return reject("legacy-restored-copy-not-unambiguous");
					oldItem.storageState = "active";
					oldItem.recyclePath = null;
					oldItem.copyIdentity = clone(copied);
				}
			}
			if (!isDeepStrictEqual(archive, expectedArchive))
				return reject("legacy-archive-revision-conflict");
			await safeState(record.taskId, record.runId, record.artifactIds, inspection.operationId);
			if (
				!isDeepStrictEqual(record, library.read("recycleRecord", record.recycleId)) ||
				!isDeepStrictEqual(archive, library.read("archiveManifest", archive.manifestId)) ||
				!isDeepStrictEqual(task, library.read("task", task.taskId))
			)
				return reject("legacy-records-changed-during-inspection");
			for (const value of [...observations]) {
				const current = await observe(value.path, "final-recheck");
				if (
					value.state !== current.state ||
					(value.state === "present" && !identityMatches(value, current))
				)
					return reject("legacy-files-changed-during-inspection");
			}
			let resumed;
			try {
				resumed = await library.resumeOperation({
					manager,
					operationId,
					expectedRevision: original.revision,
					evidence: {
						sideEffectState: denied ? "not-occurred" : "partial",
						checkedAt: now(),
						evidenceRefs: [`restore-inspection:${inspection.operationId}`],
						action: "metadata-only-restore-file-io-settlement",
						previousOwner: clone(original.owner),
						observations: clone(observations)
					}
				});
			} catch (error) {
				if (
					["OPERATION_OWNER_NOT_DEAD", "REVISION_CONFLICT", "OPERATION_RESUME_CONFLICT"].includes(
						error.code
					)
				)
					return reject(
						error.code === "OPERATION_OWNER_NOT_DEAD"
							? "legacy-owner-alive-or-unverified"
							: "legacy-operation-changed"
					);
				throw error;
			}
			const receipt = restoreSettlement(
				resumed.operation,
				record,
				archive,
				denied ? "admission-refused" : "partial-remainder-verified",
				[],
				{
					source: "manager-repair",
					sideEffectState: denied ? "not-started" : "settled",
					observations
				}
			);
			const value = {
				...resumed.operation,
				revision: resumed.operation.revision + 1,
				phase: denied ? "admission-refused-no-file-effects" : "restore-file-io-reconciled",
				operationState: denied ? "failed" : "partial",
				results: [
					...resumed.operation.results,
					{
						kind: "restore-file-io-verification-v1",
						inspectionOperationId: inspection.operationId,
						observations: clone(observations)
					},
					receipt
				],
				transitionEvidence: {
					type: denied ? "verification" : "operation-partial",
					checkedAt: now(),
					evidenceRefs: receipt.evidenceRefs
				}
			};
			library.commitOperation({
				permit: resumed.permit,
				expectedRevision: resumed.operation.revision,
				operation: value
			});
			inspection = update(inspection, "restore-reconciliation-complete", "succeeded", [
				{ restoredOperationId: operationId, observations, settlement: receipt }
			]);
			return { reconciled: true, operationId };
		} catch (error) {
			if (error.code === "ASSET_ACTIVE_IO_OR_DEPENDENCY")
				return reject("active-file-io-or-dependency");
			inspection = update(inspection, "restore-reconciliation-error", "failed", [
				{ restoredOperationId: operationId, error: error.code || String(error), observations }
			]);
			throw error;
		}
	}
	async function planEmptyTrash({ manager, recycleIds, knownReferences = [] }) {
		library.assertManager(manager);
		const planId = "empty-" + crypto.randomUUID(),
			confirmationToken = crypto.randomBytes(32).toString("hex"),
			entries = [];
		for (const recycleId of recycleIds) {
			const record = library.read("recycleRecord", recycleId);
			if (!record || record.status !== "recycled") throw fail("ASSET_RECYCLE_NOT_FOUND");
			await safeState(record.taskId, record.runId, record.artifactIds);
			for (const file of record.files) {
				const identity = await hashLocal(file.recycleIdentity.path);
				if (
					identity.sha256 !== file.recycleIdentity.sha256 ||
					identity.byteSize !== file.recycleIdentity.byteSize
				)
					throw fail("ASSET_TRASH_CHANGED");
				entries.push({
					recycleId,
					taskId: record.taskId,
					runId: record.runId,
					artifactId: file.artifactId,
					identity
				});
			}
		}
		const impact = {
			count: entries.length,
			logicalBytes: entries.reduce((n, x) => n + x.identity.byteSize, 0),
			knownReferences: clone(knownReferences),
			originalWorkDirectoriesAffected: false,
			independentSnapshotsAffected: false,
			irreversible: true
		};
		const op = begin(
			manager,
			"empty-trash",
			recycleIds.map((key) => ({ kind: "recycleRecord", id: key })),
			{
				operationId: planId,
				entries,
				recycleIds,
				confirmationHash: digest(confirmationToken),
				impact
			}
		);
		return { planId: op.operationId, confirmationToken, impact };
	}
	async function emptyTrash({ planId, confirmationToken }) {
		let op = library.read("operation", planId);
		if (
			!op ||
			op.type !== "empty-trash" ||
			digest(confirmationToken || "") !== op.authorizationScope.confirmationHash
		)
			throw fail("ASSET_CONFIRMATION_REQUIRED");
		const results = [];
		for (const item of op.authorizationScope.entries) {
			try {
				await safeState(item.taskId, item.runId, [item.artifactId], op.operationId);
				await fault("trash-before-delete", { item });
				await removeExact(path.join(libraryDirectory, "trash"), item.identity);
				results.push({
					artifactId: item.artifactId,
					recycleId: item.recycleId,
					state: "deleted",
					logicalBytes: item.identity.byteSize
				});
			} catch (error) {
				results.push({
					artifactId: item.artifactId,
					recycleId: item.recycleId,
					state: "failed",
					error: error.code || String(error)
				});
			}
			op = update(op, "deleting-exact-trash", "running", [results.at(-1)]);
		}
		const mutations = [];
		for (const recycleId of op.authorizationScope.recycleIds) {
			const record = library.read("recycleRecord", recycleId),
				items = results.filter((x) => x.recycleId === recycleId);
			const next = {
				...record,
				revision: record.revision + 1,
				status: items.every((x) => x.state === "deleted") ? "emptied" : "partially-emptied",
				deletionResults: items
			};
			mutations.push(mutation("recycleRecord", recycleId, next, record.revision));
		}
		update(
			op,
			"finished",
			results.some((x) => x.state === "failed") ? "partial" : "succeeded",
			[],
			mutations
		);
		return {
			results,
			logicalBytes: results
				.filter((x) => x.state === "deleted")
				.reduce((n, x) => n + x.logicalBytes, 0),
			measuredDiskFreeDelta: null
		};
	}
	async function relocateWithinLibrary({ markerId, kind = "archive", manager }) {
		if (!["archive", "trash"].includes(kind)) throw fail("ASSET_RELOCATION_SCOPE_INVALID");
		const root = path.join(libraryDirectory, kind);
		await ensureDirectory(root);
		const found = [],
			invalid = [];
		// Only this associated library, bounded to one flat physical directory level.
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const directory = path.join(root, entry.name),
				marker = path.join(directory, kind === "archive" ? "manifest.json" : "recycle.json");
			try {
				const identity = await hashLocal(marker);
				const value = JSON.parse(await fs.readFile(marker, "utf8"));
				if ((kind === "archive" ? value.manifestId : value.recycleId) === markerId)
					found.push({ directory, marker, identity, value });
			} catch (error) {
				if (error.code !== "ENOENT")
					invalid.push({ directory, error: error.code || String(error) });
			}
		}
		if (found.length !== 1)
			return {
				state: found.length ? "conflict" : "missing",
				matches: found.map((x) => x.directory),
				invalid
			};
		const match = found[0],
			record = library.read(kind === "archive" ? "archiveManifest" : "recycleRecord", markerId);
		if (!record) return { state: "conflict", reason: "marker-record-missing" };
		const items =
			kind === "archive"
				? record.items
						.filter((x) => x.included && x.storageState !== "recycled")
						.map((x) => ({ path: x.targetPath, sha256: x.sha256, byteSize: x.byteSize }))
				: record.files.map((x) => x.recycleIdentity);
		for (const item of items) {
			const file = path.join(match.directory, path.basename(item.path));
			try {
				const actual = await hashLocal(file);
				if (actual.sha256 !== item.sha256 || actual.byteSize !== item.byteSize)
					return { state: "conflict", reason: "content-mismatch", path: file };
			} catch (error) {
				return { state: "conflict", reason: error.code || String(error), path: file };
			}
		}
		if (manager) {
			library.assertManager(manager);
			const recordKind = kind === "archive" ? "archiveManifest" : "recycleRecord";
			const next = clone(record);
			next.revision++;
			next.relocationHistory = [
				...(next.relocationHistory || []),
				{
					from:
						kind === "archive"
							? record.targetLocation.path
							: record.recycleLocations.map((x) => x.path),
					to: match.directory,
					checkedAt: now(),
					markerIdentity: match.identity
				}
			];
			const mutations = [],
				targets = [{ kind: recordKind, id: markerId }];
			if (kind === "archive") {
				next.targetLocation = location(match.directory);
				for (const item of next.items.filter((x) => x.included && x.storageState !== "recycled")) {
					item.targetPath = path.join(match.directory, path.basename(item.targetPath));
					item.copyIdentity = await hashLocal(item.targetPath);
				}
			} else {
				for (const file of next.files)
					file.recycleIdentity = await hashLocal(
						path.join(match.directory, path.basename(file.recycleIdentity.path))
					);
				next.recycleLocations = next.files.map((x) => location(x.recycleIdentity.path));
				const archive = library.read("archiveManifest", record.archiveManifestId);
				if (!archive) throw fail("ASSET_RELOCATION_ARCHIVE_MISSING");
				const nextArchive = clone(archive);
				nextArchive.revision++;
				for (const file of next.files) {
					const item = nextArchive.items.find((x) => x.artifactId === file.artifactId);
					if (item) item.recyclePath = file.recycleIdentity.path;
				}
				targets.push({ kind: "archiveManifest", id: record.archiveManifestId });
				mutations.push(
					mutation("archiveManifest", record.archiveManifestId, nextArchive, archive.revision)
				);
			}
			mutations.push(mutation(recordKind, markerId, next, record.revision));
			const op = begin(manager, "relink-library-asset", targets, {
				markerId,
				kind,
				directory: match.directory,
				markerIdentity: match.identity
			});
			update(op, "relinked", "succeeded", [], mutations);
			return {
				state: "relinked",
				directory: match.directory,
				markerIdentity: match.identity,
				record: next,
				automaticIndexMutation: true
			};
		}
		return {
			state: "matched",
			directory: match.directory,
			markerIdentity: match.identity,
			record,
			automaticIndexMutation: false
		};
	}
	return {
		recycle,
		restore,
		planEmptyTrash,
		emptyTrash,
		relocateWithinLibrary,
		registerRecycle,
		executeRegisteredRecycle,
		registerRestore,
		executeRegisteredRestore,
		reconcileRestoreOperation
	};
}
module.exports = { createRecycle };
