"use strict";
const { SCHEDULER_END_CAPABILITY, matchesSchedulerEndReceipt, verifiedOwnerEndReceipt, schedulerPreparationFailure } = require("./execution/scheduler-end.cjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { listAll, iterateRecords } = require("./operation-guards.cjs");
const { AsyncLocalStorage } = require("node:async_hooks");
const { taskDetail } = require("./projections.cjs");
const { executionRequest } = require("./submission.cjs");
const { fail, noLinks } = require("./platform/global-settings.cjs");
const { activePreparation } = require("./exit.cjs");
const { describeFailure, updateFailures, prelaunchFailure, verifiedNotStarted, prelaunchReadFailure } = require("./task-failures.cjs");
const { classifyEndReceipt, endedLaunchIdentity } = require("./end-receipts.cjs");
const launchReconciliation = "journal-launch-reconciled-v1";
const unresolvedReceiptConflicts = (run) => (run.executionReceiptConflicts || []).filter((item) =>
	item.resolution?.kind !== launchReconciliation ||
	!item.resolution.launchReceiptId || !item.resolution.anchorReceiptId ||
	item.resolution.launchReceiptId !== run.executionIdentity.launchReceipt?.receiptId ||
	item.resolution.anchorReceiptId !== run.executionIdentity.endReceipt?.receiptId);
const conflictingObservation = (code) => /CONFLICT|MISMATCH|IDENTITY_CHANGED/.test(code || "");
function isHistoricalPosixLaunch(run, launch) {
	const execution = run.executionIdentity, end = execution.endReceipt;
	const identity = launch.payload.identity, tree = end?.payload.processTree;
	return run.requiredCapabilities?.includes("es:task-posix-stop-dispatch-v1") &&
		run.state.executionState === "ended" && run.state.verificationState === "verified" && launch.eventType === "run.launched" &&
		launch.taskId === run.taskId && launch.runId === run.runId &&
		launch.submissionIntentId === execution.submissionIntentId &&
		end?.taskId === run.taskId && end.runId === run.runId && end.submissionIntentId === execution.submissionIntentId &&
		launch.operationId === end?.operationId && launch.operationId === run.submitOperationId &&
		launch.source === end.source && launch.sequence < end.sequence &&
		typeof launch.payload.manifestHash === "string" && launch.payload.manifestHash === execution.executorIdentity?.manifestHash &&
		identity?.kind === "linux" && identity.cwd === execution.workLocation?.path &&
		Number.isSafeInteger(identity.pid) && Number.isSafeInteger(identity.startTicks) &&
		tree?.scope === "linux-session" && tree.verified === true &&
		(tree.activeProcesses === undefined || tree.activeProcesses === 0) && end.payload.notStarted !== true &&
		tree.pid === identity.pid && tree.bootId === identity.bootId && tree.userId === identity.userId;
}
function completedPosixHandoff(run, operation, related) {
	const scope = operation.authorizationScope;
	const launches = related.filter(receipt => receipt.eventType === "run.launched");
	return run && operation.type === "submit" && operation.operationId === run.submitOperationId &&
		!unresolvedReceiptConflicts(run).length && launches.length === 1 &&
		scope.taskId === run.taskId && scope.runId === run.runId &&
		(scope.inputSnapshotId === undefined || scope.inputSnapshotId === run.inputSnapshotId) &&
		scope.submissionIntentId === run.executionIdentity.submissionIntentId &&
		(scope.workLocation === undefined || isDeepStrictEqual(scope.workLocation, run.executionIdentity.workLocation)) &&
		isHistoricalPosixLaunch(run, launches[0]) ? launches[0] : null;
}
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function writeJSON(file, value) {
	const candidate = file + ".candidate-" + crypto.randomUUID(),
		fd = fs.openSync(candidate, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(candidate, file);
}
// Arrays replace under the library's recursive merge contract. A single exact
// display structure therefore cannot inherit an omitted bonds/cell from an old frame.
function thumbnailSnapshot(frame, task, run, sourceVersion, readerImplementationVersion) {
	if (!frame) return null;
	return {
		schema: 1, readerImplementationVersion, sourceVersion,
		owner: { taskId: task.taskId, runId: run?.runId || null,
			sourceSetId: run ? null : task.sourceSetId, sourceVersion: run ? null : task.sourceVersion },
		structures: [{ id: frame.frameId, name: task.displayName, format: "task-monitor",
			atoms: frame.atoms, ...(frame.bonds !== undefined ? { bonds: frame.bonds } : {}),
			charge: null, multiplicity: null, notes: [], ...(frame.cell ? { cell: frame.cell } : {}) }]
	};
}
function createMonitoring({
	store,
	directory,
	manager,
	execution,
	provider,
	readerImplementationVersion = null,
	getStopOptions = () => undefined,
	settings,
	beforeRefresh = () => {},
	collectAuxiliaries,
	taskOwned = () => false,
	finalPreparation = () => null,
	trackDisplayPreparation = () => {},
	ioAdmission,
	now = () => new Date().toISOString(),
	onError = () => {},
	onChanged = () => {}
}) {
	const operationScope = new AsyncLocalStorage(), rawStore = store, uiManager = manager;
	// A continuation is a restricted Operation permit, not a replacement global
	// manager. Ordinary callers retain the original epoch checks unchanged.
	manager = () => operationScope.getStore() || uiManager();
	store = new Proxy(rawStore, { get(target, property) {
		if (property === "assertManager") return claim => { const access = operationScope.getStore(); return access ? (claim === access ? access.assert() : (() => { throw fail("RESULT_ADOPTION_AUTHORITY_MISMATCH"); })()) : target.assertManager(claim); };
		if (property === "commit") return input => { const access = operationScope.getStore(); return access ? access.commit(input.mutations) : target.commit(input); };
		if (property === "listExecutionReceipts") return (filters = {}) => { const rows = target.listExecutionReceipts(filters), access = operationScope.getStore(); return access ? rows.filter(row => row.runId === access.runId && row.managerEpoch === undefined && row.sourceRevision === undefined && ["run.launched", "run.ended", "run.recovered-end", "run.scheduler-ended", "operation.preparation-launched", "operation.preparation-ended"].includes(row.eventType) && (!filters.pendingOnly || !access.applied(row.receiptId))) : rows; };
		if (property === "applyExecutionReceipt") return input => {
			const receipt = target.readExecutionReceipt(input.receiptId), access = operationScope.getStore();
			if (access) { if (receipt?.runId !== access.runId) throw fail("RESULT_ADOPTION_RECEIPT_SCOPE"); if (!access.applied(input.receiptId)) access.commit(input.mutations || [], receipt); return input.mutations || []; }
			const run = receipt && target.read("run", receipt.runId), adoption = run?.resultAdoptionOperationId && target.read("operation", run.resultAdoptionOperationId);
			// The restricted continuation already committed these exact facts. A
			// later UI manager completes journal bookkeeping without replaying them.
			const adopted = adoption?.results?.some(result => result.adoptedReceiptId === input.receiptId);
			return target.applyExecutionReceipt(adopted ? { ...input, mutations: [] } : input);
		};
		const value = target[property]; return typeof value === "function" ? value.bind(target) : value;
	} });
	const owners = new Map(),
		ownerVersions = new Map(),
		ownerTokens = new Map(),
		ownerLastUsed = new Map(),
		snapshotPins = new Map(),
		retiredOwners = new Set(),
		ownerDisposals = new Set(),
		running = new Map(),
		inspecting = new Map(),
		progress = new Map(),
		lastInspection = new Map(),
		lastScheduled = new Map(),
		pendingPreparations = new Map(),
		sourceErrors = new Map(),
		failures = new Map(),
		selected = new Set(),
		frameKeys = new WeakMap();
	const cacheRoot = path.join(directory, "monitor-cache"),
		frameRoot = path.join(cacheRoot, "frames");
	noLinks(cacheRoot);
	fs.mkdirSync(frameRoot, { recursive: true });
	let timer,
		stopped = false,
		serial = Promise.resolve();
	let controlSerial = Promise.resolve();
	let ownerClock = 0;
	async function retireOwner(source) {
		if (!source) return;
		if (snapshotPins.get(source)) retiredOwners.add(source);
		else {
			const work = Promise.resolve().then(() => source.dispose?.());
			ownerDisposals.add(work);
			try {
				await work;
			} finally {
				ownerDisposals.delete(work);
			}
		}
	}
	async function trimIdleOwners() {
		// Match the center workspace: active consumers are pinned, two idle sources stay warm.
		const idle = [...owners.entries()]
			.filter(([id, source]) => !taskOwned(id) && !selected.has(id) && !running.has(id) && !snapshotPins.get(source))
			.sort(([a], [b]) => (ownerLastUsed.get(b) || 0) - (ownerLastUsed.get(a) || 0));
		for (const [id, source] of idle.slice(2)) {
			if (owners.get(id) !== source) continue;
			owners.delete(id);
			ownerVersions.delete(id);
			ownerTokens.delete(id);
			ownerLastUsed.delete(id);
			await retireOwner(source);
		}
	}
	function validClaim(expected) {
		try {
			const claim = manager();
			store.assertManager(claim);
			return (
				!expected || (expected.instanceId === claim.instanceId && expected.epoch === claim.epoch)
			);
		} catch {
			return false;
		}
	}
	function cachePath(runId) {
		if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw fail("RUN_ID_INVALID");
		return path.join(cacheRoot, runId + ".json");
	}
	function cache(runId, { forRetention = false } = {}) {
		try {
			const file = cachePath(runId);
			noLinks(file);
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if (
				typeof value.revision !== "string" ||
				!Array.isArray(value.frameRefs) ||
				value.frameCount !== value.frameRefs.length ||
				!Array.isArray(value.previousFrameRefs) ||
				[...value.frameRefs, ...value.previousFrameRefs].some(
					(key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)
				)
			)
				throw fail("MONITOR_CACHE_IDENTITY_INVALID");
			if (
				!forRetention &&
				(value.readerImplementationVersion ?? null) !== readerImplementationVersion
			)
				return null;
			return value;
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw fail("MONITOR_CACHE_UNAVAILABLE");
		}
	}
	function sourceCacheKey(task) {
		return "source-" + hash(JSON.stringify([task.taskId, task.sourceSetId, task.sourceVersion]));
	}
	function writePublication(run, prepared, task = null, final = false) {
		operationScope.getStore()?.assert();
		const cacheKey = run?.runId || sourceCacheKey(task);
		const previous = cache(cacheKey),
			frames = prepared.frames || [],
			frameRefs = [];
		if (operationScope.getStore() && final && !frames.length && !(prepared.cards || []).length) throw fail("RESULT_ADOPTION_NO_USABLE_RESULT", "来源尚未提供可浏览结构或结果卡片，不能将空集合标为最终就绪");
		if (
			previous?.revision === String(prepared.revision) &&
			previous.collectionId === prepared.collectionId &&
			JSON.stringify(previous.archiveFailure || null) === JSON.stringify(prepared.archiveFailure || null) &&
			JSON.stringify(previous.actualReadLocation || null) === JSON.stringify(prepared.actualReadLocation || null) &&
			(prepared.scientificState === undefined || previous.scientificProjectionVersion === 1)
		) {
			if (final) operationScope.getStore()?.didPrepare(prepared);
			return previous;
		}
		for (const frame of frames) {
			let key = frameKeys.get(frame);
			if (!key) {
				const bytes = JSON.stringify(frame);
				key = hash(bytes);
				frameKeys.set(frame, key);
				const file = path.join(frameRoot, key + ".json");
				if (!fs.existsSync(file)) writeJSON(file, frame);
			}
			frameRefs.push(key);
		}
		const scalar = {
			...(prepared.sourceIdentity ? { sourceIdentity: prepared.sourceIdentity } : {}),
			...(prepared.archiveFailure ? { archiveFailure: prepared.archiveFailure } : {}),
			...(prepared.actualReadLocation ? { actualReadLocation: prepared.actualReadLocation } : {}),
			...(typeof prepared.resultsComplete === "boolean"
				? { resultsComplete: prepared.resultsComplete }
				: {}),
			results: prepared.results || previous?.results || [],
			sourceGeneration: prepared.sourceGeneration || null,
			sourceBoundary: prepared.sourceBoundary || null,
			collectionId: prepared.collectionId,
			revision: String(prepared.revision),
			sourceRevision: prepared.sourceRevision || null,
			readerImplementationVersion,
			scientificProjectionVersion: prepared.scientificState === undefined ? 0 : 1,
			frameCount: frames.length,
			prepared: prepared.prepared === true,
			frameRefs,
			cards: prepared.cards || [],
			stage: prepared.stage || null,
			iteration: prepared.iteration || null,
			elapsedSeconds: prepared.elapsedSeconds ?? null,
			notices: prepared.notices || [],
			updatedAt: now(),
			previousRevision: previous?.revision || null,
			previousCollectionId: previous?.collectionId || null,
			previousFrameRefs: previous?.frameRefs || []
		};
		writeJSON(cachePath(cacheKey), scalar);
		if (!run) {
			const currentTask = store.read("task", task.taskId),
				last = frames.at(-1);
			if (
				last &&
				currentTask &&
				!currentTask.deleted &&
				currentTask.sourceSetId === task.sourceSetId &&
				currentTask.sourceVersion === task.sourceVersion
			) {
				const counts = new Map();
				for (const atom of last.atoms)
					counts.set(atom.element, (counts.get(atom.element) || 0) + 1);
				const formula = [...counts]
					.sort(([a], [b]) =>
						a === "C" ? -1 : b === "C" ? 1 : a === "H" ? -1 : b === "H" ? 1 : a.localeCompare(b)
					)
					.map(([element, count]) => element + (count > 1 ? count : ""))
					.join("");
				const results = (prepared.results || []).map((view) => view.result).filter(Boolean),
					software = [
						...new Set(
							results
								.map((result) => result.source?.software)
								.filter((value) => typeof value === "string" && value !== "unknown")
						)
					];
				const kinds = results.map((result) => {
					const tasks = [...new Set(result.scientific?.tasks || [])];
					return tasks.length === 1
						? tasks[0]
						: tasks.length === 2 && tasks.includes("opt") && tasks.includes("freq")
							? "optfreq"
							: null;
				});
				const taskKinds = [...new Set(kinds.filter(Boolean))];
				store.commit({
					manager: manager(),
					mutations: [
						{
							kind: "task",
							id: task.taskId,
							expectedRevision: currentTask.revision,
							value: {
								...currentTask,
								revision: currentTask.revision + 1,
								formula,
								observedSource: {
									sourceSetId: task.sourceSetId,
									sourceVersion: task.sourceVersion,
									engineId:
										results.length > 0 &&
										software.length === 1 &&
										results.every(
											(result) =>
												typeof result.source?.software === "string" &&
												result.source.software !== "unknown"
										)
											? software[0]
											: null,
									taskKind:
										prepared.resultsComplete === true &&
										kinds.length > 0 &&
										kinds.every(Boolean) &&
										taskKinds.length === 1
											? taskKinds[0]
											: null,
									sourceGeneration: prepared.sourceGeneration ?? null,
									sourceRevision: prepared.sourceRevision ?? null,
									readerImplementationVersion,
									observedAt: scalar.updatedAt
								},
								thumbnailSnapshot: thumbnailSnapshot(last, currentTask, null, scalar.revision, readerImplementationVersion),
								thumbnailStructure: null,
								thumbnailSourceVersion: scalar.revision
							}
						}
					]
				});
			}
			sourceErrors.delete(task.taskId);
			onChanged({
				type: "monitor-publication",
				taskId: task.taskId,
				sourceSetId: task.sourceSetId,
				revision: scalar.revision
			});
			return scalar;
		}
		const current = store.read("run", run.runId),
			claim = manager();
		const snapshot = thumbnailSnapshot(frames.at(-1), store.read("task", run.taskId), run, scalar.revision, readerImplementationVersion);
		store.commit({
			manager: claim,
			mutations: [
				{
					kind: "run",
					id: run.runId,
					expectedRevision: current.revision,
					value: {
						...current,
						revision: current.revision + 1,
						...(prepared.scientificState
							? {
									state: {
										...current.state,
										scientificState: require("./scientific-states.cjs").mergeScientificStates(
											current.state.scientificState,
											prepared.scientificState
										)
									}
								}
							: {}),
						monitorSummary: {
							thumbnailSnapshot: snapshot,
							thumbnailStructure: null,
							thumbnailSourceVersion: scalar.revision,
							readerImplementationVersion,
							stage: scalar.stage,
							iteration: scalar.iteration,
							elapsedSeconds: scalar.elapsedSeconds,
							notices: scalar.notices,
							updatedAt: scalar.updatedAt,
							collectionId: scalar.collectionId,
							revision: scalar.revision
						}
					}
				}
			]
		});
		// Only known retired cache chunks, never source assets or a directory glob.
		const retained = new Set([...scalar.frameRefs, ...scalar.previousFrameRefs]);
		for (const other of iterateRecords(store, "run"))
			if (other.runId !== run.runId) {
				// An incompatible projection still owns its cached bytes until replacement succeeds.
				const publication = cache(other.runId, { forRetention: true });
				for (const key of [
					...(publication?.frameRefs || []),
					...(publication?.previousFrameRefs || [])
				])
					retained.add(key);
			}
		for (const key of new Set(previous?.previousFrameRefs || []))
			if (!retained.has(key)) {
				const file = path.join(frameRoot, key + ".json");
				try {
					noLinks(file);
					const bytes = fs.readFileSync(file);
					if (hash(bytes) !== key) throw fail("MONITOR_FRAME_CACHE_CORRUPT");
					fs.unlinkSync(file);
				} catch (error) {
					if (error.code !== "ENOENT")
						onError({ taskId: run.taskId, code: error.code || "MONITOR_CACHE_RETIRE_FAILED" });
				}
			}
		onChanged({
			type: "monitor-publication",
			taskId: run.taskId,
			runId: run.runId,
			revision: scalar.revision
		});
		if (final) operationScope.getStore()?.didPrepare(prepared);
		return scalar;
	}
	function reconcileEndedLaunch(claim, run) {
		const task = run && store.read("task", run.taskId);
		if (!run || run.state.executionState !== "ended" || !run.executionIdentity.endReceipt ||
			(run.executionIdentity.launchIdentity && run.executionIdentity.launchReceipt) ||
			run.deleted || task?.deleted || task?.latestRunId !== run.runId) return;
		const receipts = store.listExecutionReceipts({ runId: run.runId }),
			launches = receipts.filter(row => row.eventType === "run.launched" && row.operationId === run.executionIdentity.endReceipt.operationId);
		if (launches.length !== 1) return;
		const launch = launches[0], executionIdentity = endedLaunchIdentity(run, launch);
		if (!executionIdentity) return;
		const value = { ...run, revision: run.revision + 1, executionIdentity };
		if (run.executionReceiptConflicts?.length) {
			const byId = new Map(receipts.map(row => [row.receiptId, row])), corroborated = [];
			value.executionReceiptConflicts = run.executionReceiptConflicts.map(item => {
				const receipt = byId.get(item.receiptId);
				if (item.code !== "EXECUTION_END_PROOF_UNVERIFIED" || item.field !== "bound launch/tree end proof" ||
					item.anchorReceiptId !== executionIdentity.endReceipt.receiptId || !receipt ||
					!["run.ended", "run.recovered-end"].includes(receipt.eventType) || classifyEndReceipt(value, receipt).kind !== "corroborated") return item;
				corroborated.push(receipt);
				return { ...item, resolution: { kind: launchReconciliation, launchReceiptId: launch.receiptId,
					anchorReceiptId: item.anchorReceiptId, checkedAt: now(), evidenceRefs: [...launch.evidenceRefs, ...receipt.evidenceRefs] } };
			});
			if (corroborated.length) {
				value.executionEndEvidenceReceiptIds = [...new Set([...(run.executionEndEvidenceReceiptIds || []), executionIdentity.endReceipt.receiptId, ...corroborated.map(row => row.receiptId)])];
				if (!unresolvedReceiptConflicts(value).length) {
					value.state = { ...run.state, verificationState: "verified", verificationFailureCode: null, checkedAt: now(), evidenceRefs: executionIdentity.endReceipt.evidenceRefs };
					value.taskFailures = { ...run.taskFailures, "execution-receipt": null };
					value.transitionEvidence = { type: "verification", checkedAt: value.state.checkedAt, evidenceRefs: [...launch.evidenceRefs, ...value.state.evidenceRefs] };
				}
			}
		}
		// Works both for an unapplied launch and the old journal bookkeeping
		// that marked it applied without adopting its identity. No external IO.
		store.commit({ manager: claim, mutations: [{ kind: "run", id: run.runId, expectedRevision: run.revision, value }] });
	}
	function applyReceipts(claim, observedRunId) {
		const pending = store
			.listExecutionReceipts({ pendingOnly: true })
			.sort((a, b) => a.source.localeCompare(b.source) || a.sequence - b.sequence);
		const scopedRunId = operationScope.getStore()?.runId || observedRunId;
		for (const run of scopedRunId ? [store.read("run", scopedRunId)] : iterateRecords(store, "run"))
			if (run && unresolvedReceiptConflicts(run).some(item => item.code === "EXECUTION_END_PROOF_UNVERIFIED")) reconcileEndedLaunch(claim, run);
		for (const receipt of pending) {
			const run = store.read("run", receipt.runId);
			if (!run) continue;
			let value = run,
				type;
			if (receipt.eventType === "run.scheduler-ended" && matchesSchedulerEndReceipt(run, receipt) &&
				!run.executionIdentity.schedulerEndReceipt) {
				type = "ended";
				value = { ...run, executionIdentity: { ...run.executionIdentity, schedulerEndReceipt: receipt } };
			}
			if (receipt.eventType === "run.launched") {
				type = "running";
				value = {
					...run,
					executionIdentity: {
						...run.executionIdentity,
						launchIdentity: run.executionIdentity.launchIdentity || receipt.payload.identity || receipt.payload.launchIdentity || null,
						launchReceipt: receipt,
						fieldStatus: {
							...run.executionIdentity.fieldStatus,
							launchIdentity: receipt.payload.identity
								? { state: "known", evidenceRefs: receipt.evidenceRefs }
								: { state: "unknown", reason: "Launch identity unavailable" },
							launchReceipt: { state: "known", evidenceRefs: receipt.evidenceRefs }
						}
					}
				};
			}
			if (["run.ended", "run.recovered-end"].includes(receipt.eventType)) {
				const assessment = classifyEndReceipt(run, receipt);
				if (assessment.kind === "conflict") {
					const conflict = {
							receiptId: receipt.receiptId,
							anchorReceiptId: assessment.anchorReceiptId,
							code: assessment.code,
							field: assessment.field,
							observedAt: now()
						},
						failure = describeFailure(
							Object.assign(new Error("结束回执证据冲突，保留原结束记录"), {
								code: assessment.code,
								details: conflict
							}),
							{ stage: "execution-receipt", operationId: receipt.operationId, now }
						);
					value = {
						...run,
						revision: run.revision + 1,
						executionReceiptConflicts: [
							...(run.executionReceiptConflicts || []).filter(
								(item) => item.receiptId !== receipt.receiptId
							),
							conflict
						],
						taskFailures: { ...(run.taskFailures || {}), "execution-receipt": failure },
						state: {
							...run.state,
							verificationState: "conflict",
							verificationFailureCode: assessment.code,
							verificationAttemptAt: now()
						},
						transitionEvidence: {
							type: "verification",
							checkedAt: now(),
							evidenceRefs: receipt.evidenceRefs
						}
					};
				} else {
					type = "ended";
					value = {
						...run,
						executionEndEvidenceReceiptIds: [
							...new Set([
								...(run.executionEndEvidenceReceiptIds || []),
								...(run.executionIdentity.endReceipt?.receiptId
									? [run.executionIdentity.endReceipt.receiptId]
									: []),
								receipt.receiptId
							])
						],
						executionIdentity: {
							...run.executionIdentity,
							endReceipt: run.executionIdentity.endReceipt || receipt,
							fieldStatus: {
								...run.executionIdentity.fieldStatus,
								endReceipt: { state: "known", evidenceRefs: receipt.evidenceRefs }
							}
						}
					};
				}
			}
			const evidence = type ? { type, evidenceRefs: receipt.evidenceRefs, checkedAt: now() } : null;
			if (
				["operation.preparation-launched", "operation.preparation-ended"].includes(
					receipt.eventType
				)
			) {
				const previous = run.resultPreparationState || {},
					ended = receipt.eventType === "operation.preparation-ended",
					proof = receipt.payload.end?.processTree;
				value = {
					...value,
					revision: run.revision + 1,
					resultPreparationState: {
						...previous,
						operationId: receipt.operationId,
						state: !ended
							? "running"
							: receipt.payload.notStarted === true
								? "not-started"
								: proof?.verified === true || proof?.treeEnded === true
									? "ended"
									: "unknown",
						...(ended
							? { endReceipt: receipt }
							: {
									launchIdentity:
										receipt.payload.launch?.identity || receipt.payload.identity || null,
									launchReceipt: receipt
								})
					}
				};
			}
			if (type) {
				if (run.state.executionState === "ended" && type !== "ended" &&
					!(receipt.eventType === "run.launched" && run.executionIdentity.schedulerEndReceipt &&
						!run.executionIdentity.launchReceipt && receipt.operationId === run.submitOperationId &&
						receipt.taskId === run.taskId && receipt.submissionIntentId === run.executionIdentity.submissionIntentId &&
						receipt.payload.manifestHash === run.executionIdentity.executorIdentity?.manifestHash)) {
					if (receipt.eventType === "run.launched") reconcileEndedLaunch(claim, run);
					try {
						store.applyExecutionReceipt({ manager: claim, receiptId: receipt.receiptId });
					} catch (error) {
						// Keep an older launch in the journal as independent evidence
						// without replaying it past an already applied owner END.
						if (error.code !== "STALE_RECEIPT_SEQUENCE" || !isHistoricalPosixLaunch(run, receipt)) throw error;
					}
					continue;
				}
				value = {
					...value,
					revision: run.revision + 1,
					state: {
						...run.state,
						executionState: run.state.executionState === "ended" ? "ended" : type,
						verificationState: unresolvedReceiptConflicts(run).length ? "conflict" : "verified",
						verificationFailureCode: unresolvedReceiptConflicts(run).length
							? run.state.verificationFailureCode
							: null,
						checkedAt:
							type === "ended" && run.executionIdentity.endReceipt ? now() : evidence.checkedAt,
						evidenceRefs: receipt.evidenceRefs,
						...(type === "ended"
							? {
									endReason:
										run.state.executionState === "ended"
											? run.state.endReason
											: receipt.payload.endReason || "unknown"
								}
							: {})
					},
					transitionEvidence: evidence
				};
				if (
					type === "ended" &&
					receipt.payload.notStarted === true &&
					!run.resultPreparationState?.launchReceipt
				)
					value.resultPreparationState = {
						...run.resultPreparationState,
						operationId: run.preparationOperationId || null,
						state: "not-started",
						endReceipt: receipt,
						reason: receipt.payload.endReason === "failed"
							? (run.resultPreparationState?.reason && run.resultPreparationState.reason !== "Native execution was cancelled before launch"
								? run.resultPreparationState.reason : "输入准备失败，未启动计算或转换")
							: receipt.payload.endReason === "stopped" ? "原生运行在启动前已取消" : "原生运行未启动"
					};
			}
			const mutations =
				value === run
					? []
					: [{ kind: "run", id: run.runId, expectedRevision: run.revision, value }];
			if (
				receipt.eventType === "operation.preparation-ended" &&
				receipt.payload.succeeded === true
			) {
				const operation = store.read("operation", receipt.operationId),
					configured = operation?.authorizationScope.preparation,
					output = receipt.payload.output,
					artifact = store.read("artifact", operation?.authorizationScope.outputArtifactId);
				if (
					!configured ||
					!artifact ||
					configured.compatibleWithRun !== true ||
					output?.path !== artifact.locations?.[0]?.path ||
					!Number.isSafeInteger(output.byteSize) ||
					output.byteSize <= 0 ||
					!/^[a-f0-9]{64}$/i.test(output.sha256 || "") ||
					receipt.payload.source?.sourcePath !== configured.sourcePath ||
					!Number.isSafeInteger(receipt.payload.source?.byteSize) ||
					!/^[a-f0-9]{64}$/i.test(receipt.payload.source?.sha256 || "")
				)
					throw fail("PREPARATION_OUTPUT_IDENTITY_CONFLICT");
				mutations.push({
					kind: "artifact",
					id: artifact.artifactId,
					expectedRevision: artifact.revision,
					value: {
						...artifact,
						revision: artifact.revision + 1,
						byteSize: output.byteSize,
						integrity: "complete",
						compatible: true,
						stable: true,
						contentHash: { algorithm: "sha256", hash: output.sha256 },
						preparationReceiptId: receipt.receiptId,
						fieldStatus: {
							...artifact.fieldStatus,
							byteSize: { state: "known", evidenceRefs: receipt.evidenceRefs },
							contentHash: { state: "known", evidenceRefs: receipt.evidenceRefs }
						}
					}
				});
				const source = store.read("artifact", configured.sourceArtifactId),
					sourceReceipt = receipt.payload.source;
				if (source && sourceReceipt?.sha256)
					mutations.push({
						kind: "artifact",
						id: source.artifactId,
						expectedRevision: source.revision,
						value: {
							...source,
							revision: source.revision + 1,
							byteSize: sourceReceipt.byteSize,
							integrity: "complete",
							stable: true,
							contentHash: { algorithm: "sha256", hash: sourceReceipt.sha256 },
							fieldStatus: {
								...source.fieldStatus,
								byteSize: { state: "known", evidenceRefs: receipt.evidenceRefs },
								contentHash: { state: "known", evidenceRefs: receipt.evidenceRefs }
							}
						}
					});
			}
			store.applyExecutionReceipt({ manager: claim, receiptId: receipt.receiptId, mutations });
		}
		// This is receipt bookkeeping, never operation takeover or external replay.
		const receipts = store.listExecutionReceipts();
		for (const operation of iterateRecords(store, "operation")) {
			const access = operationScope.getStore();
			if (access && !store.read("operation", access.operationId)?.targets.some(target => target.kind === "operation" && target.id === operation.operationId)) continue;
			if (["succeeded", "failed", "cancelled"].includes(operation.operationState))
				continue;
			const related = receipts.filter((receipt) => receipt.operationId === operation.operationId),
				targetRun = operation.targets.find((target) => target.kind === "run"),
				run = targetRun && store.read("run", targetRun.id);
			const ownerEnd = verifiedOwnerEndReceipt(run);
			const schedulerEnd = ownerEnd && matchesSchedulerEndReceipt(run, run.executionIdentity.schedulerEndReceipt)
				? run.executionIdentity.schedulerEndReceipt : null;
			const posixLaunch = completedPosixHandoff(run, operation, related);
			if (/:dispatching$/.test(operation.phase) &&
				!(schedulerEnd && ["submit", "result-preparation"].includes(operation.type))) continue;
			let terminal = null,
				evidenceRefs = [];
			if (operation.type === "submit" && (run?.executionIdentity.launchReceipt || schedulerEnd || posixLaunch)) {
				terminal = "succeeded";
				evidenceRefs = [...new Set([...(run.executionIdentity.launchReceipt || schedulerEnd || posixLaunch).evidenceRefs,
					...(posixLaunch ? ownerEnd.evidenceRefs : [])])];
			}
			if (
				["submit", "result-preparation"].includes(operation.type) &&
				run?.executionIdentity.endReceipt?.payload?.notStarted === true &&
				!run.resultPreparationState?.launchReceipt
			) {
				terminal = "cancelled";
				evidenceRefs = run.executionIdentity.endReceipt.evidenceRefs;
			}
			if (
				operation.type === "request-stop" &&
				run?.state.executionState === "ended" &&
				run.state.verificationState === "verified" &&
				!activePreparation(store, run.runId) &&
				ownerEnd
			) {
				terminal = "succeeded";
				evidenceRefs = ownerEnd.evidenceRefs;
			}
			const preparation = related.find(
				(receipt) => receipt.eventType === "operation.preparation-ended"
			);
			if (
				operation.type === "result-preparation" &&
				preparation &&
				["ended", "not-started"].includes(run?.resultPreparationState?.state)
			) {
				terminal =
					preparation.payload.notStarted === true
						? "cancelled"
						: preparation.payload.succeeded
							? "succeeded"
							: "failed";
				evidenceRefs = preparation.evidenceRefs;
			}
			const missingPreparationReceipt = operation.type === "result-preparation" && !terminal &&
				schedulerEnd && operation.operationId === run.preparationOperationId;
			if (missingPreparationReceipt) {
				const failure = schedulerPreparationFailure(run, operation, schedulerEnd, now());
				store.commit({ manager: claim, mutations: [
					{ kind: "run", id: run.runId, expectedRevision: run.revision, value: { ...run,
						revision: run.revision + 1, resultPreparationState: failure.preparationState } },
					{ kind: "operation", id: operation.operationId, expectedRevision: operation.revision, value: failure.operation }
				] });
				continue;
			}
			if (!terminal) continue;
			store.commit({
				manager: claim,
				mutations: [
					{
						kind: "operation",
						id: operation.operationId,
						expectedRevision: operation.revision,
						value: {
							...operation,
							revision: operation.revision + 1,
							operationState: terminal,
							phase: "receipt-verified",
							transitionEvidence: {
								type:
									terminal === "succeeded"
										? "operation-complete"
										: terminal === "cancelled"
											? "not-started"
											: "verification",
								checkedAt: now(),
								evidenceRefs
							},
							results: [
								...operation.results,
								...(preparation
									? [{ preparationReceipt: preparation }]
									: [{ observedRunId: run.runId, evidenceRefs }])
							]
						}
					}
				]
			});
		}
	}
	function retainSchedulerEnd(claim, run) {
		const receipt = run.executionIdentity.schedulerEndReceipt;
		if (run.state.executionState !== "ended" || run.executionIdentity.endReceipt ||
			!run.requiredCapabilities?.includes(SCHEDULER_END_CAPABILITY) ||
			!matchesSchedulerEndReceipt(run, receipt)) return false;
		// Missing control files or an unavailable transport do not contradict an
		// already recorded end. They also cannot resolve a known conflict.
		if (["unknown", "unreachable"].includes(run.state.verificationState) &&
			!conflictingObservation(run.state.verificationFailureCode) && !unresolvedReceiptConflicts(run).length) {
			const { occurredAt: checkedAt, evidenceRefs } = receipt;
			const value = { ...run, revision: run.revision + 1,
				state: { ...run.state, verificationState: "verified", verificationFailureCode: null, checkedAt, evidenceRefs },
				transitionEvidence: { type: "ended", checkedAt, evidenceRefs } };
			store.commit({ manager: claim, mutations: [{ kind: "run", id: run.runId, expectedRevision: run.revision, value }] });
			onChanged({ type: "execution-state", taskId: run.taskId, runId: run.runId });
		}
		return true;
	}
	async function refresh(taskId, scientific = true) {
		if (!validClaim() || stopped) return;
		if (scientific && !operationScope.getStore()) { const preparing = finalPreparation(taskId); if (preparing) { await preparing; return; } }
		const lane = scientific ? running : inspecting;
		const existing = lane.get(taskId);
		if (existing) {
			existing.again ||= scientific;
			return existing.promise;
		}
		const claim = manager(),
			controller = new AbortController(),
			state = { controller, again: false, promise: null, operationId: operationScope.getStore()?.operationId };
		const work = (scientific ? serial : controlSerial)
			.catch(() => {})
			.then(async () => {
				if (!validClaim(claim) || controller.signal.aborted) return;
				const task = store.read("task", taskId);
				if (task?.deleted) return;
				let run = task && store.read("run", task.latestRunId);
				if (!run) {
					if (!scientific || !provider || !task?.sourceSetId) return;
					const sourceSet = store.read("sourceSet", task.sourceSetId);
					if (!sourceSet) return;
					const sourceLease = ioAdmission?.acquire("read");
					try {
						const ownerVersion = `source:${sourceSet.sourceSetId}:${sourceSet.sourceVersion}`;
						if (owners.has(taskId) && ownerVersions.get(taskId) !== ownerVersion) {
							const previous = owners.get(taskId);
							owners.delete(taskId);
							await retireOwner(previous);
						}
						let source = owners.get(taskId);
						if (!source) {
							const ownerToken = Symbol("source-owner");
							source = await provider({
								task,
								run: null,
								sourceSet,
								artifacts: listAll(store, "artifact", { taskId })
									.filter((artifact) =>
										sourceSet.files.some((file) => file.artifactId === artifact.artifactId)
									),
								epoch: claim.epoch,
								signal: controller.signal,
								onProgress: (value) => {
									if (
										validClaim(claim) &&
										ownerTokens.get(taskId) === ownerToken &&
										ownerVersions.get(taskId) === ownerVersion &&
										running.get(taskId) &&
										!running.get(taskId).controller.signal.aborted
									) {
										progress.set(taskId, value);
										onChanged({ type: "monitor-progress", taskId });
									}
								},
								onIntermediatePublication: (prepared) => {
									const current = store.read("task", taskId);
									if (
										validClaim(claim) &&
										ownerTokens.get(taskId) === ownerToken &&
										ownerVersions.get(taskId) === ownerVersion &&
										running.get(taskId) &&
										!running.get(taskId).controller.signal.aborted &&
										current?.sourceSetId === task.sourceSetId &&
										current?.sourceVersion === task.sourceVersion &&
										prepared?.prepared === true
									)
										writePublication(null, prepared, task);
								}
							});
							if (!validClaim(claim) || controller.signal.aborted) {
								await source?.dispose?.();
								return;
							}
							owners.set(taskId, source);
							ownerLastUsed.set(taskId, ++ownerClock);
							ownerVersions.set(taskId, ownerVersion);
							ownerTokens.set(taskId, ownerToken);
						}
						const prepared = await source.refresh({
							run: null,
							signal: controller.signal,
							epoch: claim.epoch
						});
						try {
							if (
								validClaim(claim) &&
								!controller.signal.aborted &&
								prepared?.prepared === true &&
								store.read("task", taskId)?.sourceVersion === task.sourceVersion &&
								store.read("task", taskId)?.sourceSetId === task.sourceSetId
							)
								writePublication(null, prepared, task);
						} finally {
							await prepared?.release?.();
						}
					} finally {
						sourceLease?.release();
					}
					return;
				}
				let preparationPending = pendingPreparations.get(taskId) || false,
					stage = "execution-inspect",
					verificationAttempted = false,
					verificationObserved = false,
					stopDispositionOnly = false;
				let ioLease;
				try {
					ioLease = ioAdmission?.acquire("read");
					await beforeRefresh({ operation: operationScope.getStore() });
					const recoveredPrepare = prelaunchFailure(run);
					if (recoveredPrepare && store.read("task", taskId)?.latestRunId === run.runId &&
						(!run.taskFailures?.["control-prepare"] || run.resultPreparationState?.reason === "Native execution was cancelled before launch")) {
						const current = store.read("run", run.runId);
						if (current.revision === run.revision) {
							const value = { ...current, revision: current.revision + 1,
								taskFailures: { ...current.taskFailures, "control-prepare": current.taskFailures?.["control-prepare"] || recoveredPrepare },
								...(current.resultPreparationState?.reason === "Native execution was cancelled before launch"
									? { resultPreparationState: { ...current.resultPreparationState, reason: "输入准备失败，未启动计算或转换" } } : {}) };
							store.commit({ manager: claim, mutations: [{ kind: "run", id: run.runId, expectedRevision: current.revision, value }] });
							run = store.read("run", run.runId);
						}
					}
					const pendingPreparation = activePreparation(store, run.runId);
					const originalEnd = run.executionIdentity.endReceipt?.payload;
					const missingStopDisposition = !run.stopDisposition && task.workFileState !== "cleared" &&
						run.state.endReason === "failed" && Number.isInteger(originalEnd?.exitCode) && originalEnd.exitCode !== 0 &&
						run.requiredCapabilities?.includes("es:task-posix-stop-dispatch-v1");
					stopDispositionOnly = !!missingStopDisposition && run.state.executionState === "ended" &&
						run.state.verificationState === "verified" && !pendingPreparation;
					if (
						(!scientific || performance.now() - (lastInspection.get(taskId) ?? -Infinity) > 500) &&
						(run.state.executionState !== "ended" ||
							run.state.verificationState !== "verified" ||
							missingStopDisposition ||
							(run.environmentSnapshot.scheduler.kind === "slurm" && !run.executionIdentity.endReceipt) ||
							pendingPreparation)
					) {
						verificationAttempted = true;
						const result = await execution().inspect(
							executionRequest(run, "inspect", run.submitOperationId),
							{ signal: controller.signal }
						);
						preparationPending = result.payload?.preparationPending === true;
						pendingPreparations.set(taskId, preparationPending);
						if (!validClaim(claim) || controller.signal.aborted) return;
						applyReceipts(claim, run.runId);
						lastInspection.set(taskId, performance.now());
						run = store.read("run", run.runId);
						const actual = result.actualState;
						const verifiedNativeSlurmEnd = run.environmentSnapshot.scheduler.kind === "slurm" &&
							run.executionIdentity.endReceipt && verifiedOwnerEndReceipt(run);
						const retainedSchedulerEnd = actual?.executionState === "unknown" &&
							["unknown", "unreachable"].includes(actual.verificationState) && retainSchedulerEnd(claim, run);
						if (retainedSchedulerEnd) run = store.read("run", run.runId);
						if (actual && actual.executionState && actual.executionState !== "preparing" &&
							!verifiedNativeSlurmEnd && !retainedSchedulerEnd) {
							const checkedAt = now(),
								evidenceRefs = result.evidenceRefs?.length
									? result.evidenceRefs
									: result.payload?.evidenceRefs || [];
							const desired =
								run.state.executionState === "ended"
									? "ended"
									: run.state.executionState === "stop-requested" &&
										  ["running", "queued"].includes(actual.executionState)
										? "stop-requested"
										: actual.executionState;
							if (evidenceRefs.length) {
								const evidence = {
									type:
										desired === "ended"
											? "ended"
											: desired === "submitting"
												? "intent-persisted"
												: desired === "stop-requested"
													? "stop-intent"
													: ["running", "queued"].includes(desired)
														? desired
														: "verification",
									checkedAt,
									evidenceRefs
								};
								const value = {
									...run,
									...(require("./runtime-timing.cjs").runtimeTimingObservation(run, result, checkedAt) ? { runtimeTimingObservation: require("./runtime-timing.cjs").runtimeTimingObservation(run, result, checkedAt) } : {}),
									revision: run.revision + 1,
									state: {
										...run.state,
										executionState: desired,
										verificationState: unresolvedReceiptConflicts(run).length
											? "conflict"
											: actual.verificationState || "unknown",
										verificationFailureCode: unresolvedReceiptConflicts(run).length
											? run.state.verificationFailureCode
											: null,
										checkedAt,
										evidenceRefs,
										...(desired === "ended"
											? {
													endReason:
														run.state.executionState === "ended"
															? run.state.endReason
															: actual.endReason || "unknown"
												}
											: {})
									},
									transitionEvidence: evidence
								};
								store.commit({
									manager: claim,
									mutations: [{ kind: "run", id: run.runId, expectedRevision: run.revision, value }]
								});
								run = value;
								onChanged({ type: "execution-state", taskId, runId: run.runId });
							}
						}
						const stop = result.payload?.stopDisposition, original = run.executionIdentity.endReceipt;
						const launch = stop && (run.executionIdentity.launchReceipt || store.readExecutionReceipt(stop.launchReceiptId));
						if (stop && !run.stopDisposition && run.state.executionState === "ended" &&
							run.state.verificationState === "verified" && run.state.endReason === "failed" &&
							!unresolvedReceiptConflicts(run).length &&
							stop.taskId === run.taskId && stop.runId === run.runId &&
							stop.submissionIntentId === run.executionIdentity.submissionIntentId &&
							stop.launchReceiptId === launch?.receiptId && launch.eventType === "run.launched" &&
							launch.taskId === run.taskId && launch.runId === run.runId &&
							launch.submissionIntentId === stop.submissionIntentId && launch.operationId === original?.operationId &&
							stop.endReceiptId === original?.receiptId && stop.exitCode === original.payload.exitCode) {
							const value = { ...run, revision: run.revision + 1, stopDisposition: stop };
							store.commit({ manager: claim, mutations: [{ kind: "run", id: run.runId, expectedRevision: run.revision, value }] });
							run = value;
							onChanged({ type: "execution-state", taskId, runId: run.runId });
						}
					}
					verificationObserved = true;
					if (preparationPending) return;
					if (run.state.verificationState === "verified")
						updateFailures(
							store,
							run.runId,
							(values) => {
								delete values["execution-inspect"];
								if (
									run.executionIdentity.launchReceipt?.evidenceRefs?.length ||
									(run.executionIdentity.endReceipt?.evidenceRefs?.length && run.executionIdentity.endReceipt.payload?.notStarted !== true)
								) {
									delete values["control-prepare"];
									delete values["control-submit"];
								}
							},
							{ manager: claim }
						);
					if (verifiedNotStarted(run)) {
						updateFailures(store, run.runId, values => {
							for (const [key, failure] of Object.entries(values)) if (prelaunchReadFailure(run, failure)) delete values[key];
						}, { manager: claim });
						const previous = owners.get(taskId);
						owners.delete(taskId); ownerVersions.delete(taskId); ownerTokens.delete(taskId); progress.delete(taskId);
						if (previous) await retireOwner(previous);
						failures.delete(taskId);
						return;
					}
					if (scientific && provider && validClaim(claim)) {
						stage = "scientific-source";
						if (owners.has(taskId) && ownerVersions.get(taskId) !== run.runId) {
							const previous = owners.get(taskId);
							owners.delete(taskId);
							await retireOwner(previous);
						}
						let source = owners.get(taskId);
						if (!source) {
							const ownerToken = Symbol("run-source-owner");
							source = await provider({
								task,
								run,
								artifacts: listAll(store, "artifact", { runId: run.runId }),
								onProgress: (value) => {
									if (
										validClaim(claim) &&
										ownerTokens.get(taskId) === ownerToken &&
										ownerVersions.get(taskId) === run.runId &&
										running.get(taskId) &&
										!running.get(taskId).controller.signal.aborted
									) {
										progress.set(taskId, value);
										onChanged({ type: "monitor-progress", taskId, runId: run.runId });
									}
								},
								onIntermediatePublication: (prepared) => {
									if (
										validClaim(claim) &&
										ownerTokens.get(taskId) === ownerToken &&
										ownerVersions.get(taskId) === run.runId &&
										running.get(taskId) &&
										!running.get(taskId).controller.signal.aborted &&
										store.read("task", taskId)?.latestRunId === run.runId &&
										prepared?.prepared === true
									)
										writePublication(run, prepared);
								},
								epoch: claim.epoch,
								signal: controller.signal
							});
							if (!validClaim(claim) || controller.signal.aborted) {
								await source?.dispose?.();
								return;
							}
							owners.set(taskId, source);
							ownerLastUsed.set(taskId, ++ownerClock);
							ownerVersions.set(taskId, run.runId);
							ownerTokens.set(taskId, ownerToken);
						}
						stage = "scientific-refresh";
						const prepared = await source.refresh({
							run,
							signal: controller.signal,
							epoch: claim.epoch
						});
						if (!validClaim(claim) || controller.signal.aborted) {
							await prepared?.release?.();
							return;
						}
						if (
							prepared?.observationState === "pending" &&
							prepared.reason === "source-in-flight-change"
						) {
							await prepared.release?.();
							return;
						}
						try {
							if (prepared && prepared.prepared === true) writePublication(run, prepared, null, true);
						} finally {
							await prepared?.release?.();
						}
						if (prepared)
							updateFailures(
								store,
								run.runId,
								(values) => {
									delete values["scientific-source"];
									delete values["scientific-refresh"];
								},
								{ manager: claim }
							);
					}
					if (
						collectAuxiliaries &&
						!operationScope.getStore() &&
						run.state.executionState === "ended" &&
						run.state.verificationState === "verified" &&
						validClaim(claim)
					) {
						stage = "auxiliary-collection";
						await collectAuxiliaries({
							task,
							run: store.read("run", run.runId),
							primaryProvider: owners.get(taskId),
							signal: controller.signal,
							isCurrent: () => validClaim(claim) && !controller.signal.aborted
						});
						updateFailures(
							store,
							run.runId,
							(values) => {
								delete values[stage];
							},
							{ manager: claim }
						);
					}
					failures.delete(taskId);
				} catch (error) {
					if (!controller.signal.aborted) {
						const failure = describeFailure(error, { stage, now });
						if (validClaim(claim))
							try {
								updateFailures(
									store,
									run.runId,
									(values) => {
										values[stage] = failure;
									},
									{ manager: claim }
								);
							} catch {}
						if (verificationAttempted && !verificationObserved && validClaim(claim))
							try {
								const record = store.read("run", run.runId),
									code = error.code || "MONITOR_REFRESH_FAILED";
								if (conflictingObservation(code) || (!stopDispositionOnly && !retainSchedulerEnd(claim, record))) store.commit({
									manager: claim,
									mutations: [
										{
											kind: "run",
											id: record.runId,
											expectedRevision: record.revision,
											value: {
												...record,
												revision: record.revision + 1,
												state: {
													...record.state,
													verificationState: conflictingObservation(code)
														? "conflict"
														: /SSH|WSL|CONNECT|NETWORK|AUTH|UNREACHABLE/.test(code)
															? "unreachable"
															: "unknown",
													verificationAttemptAt: now(),
													verificationFailureCode: code
												}
											}
										}
									]
								});
							} catch {}
						const current = failures.get(taskId);
						failures.set(taskId, { count: (current?.count || 0) + 1, at: Date.now() });
						onError({ taskId, runId: run.runId, ...failure });
					}
				} finally {
					ioLease?.release();
				}
			})
			.catch((error) => {
				if (!controller.signal.aborted && validClaim(claim)) {
					const failure = describeFailure(error, { stage: "scientific-source", now });
					sourceErrors.set(taskId, failure);
					onError({ taskId, ...failure });
					onChanged({ type: "monitor-error", taskId });
				}
			})
			.finally(() => {
				lane.delete(taskId);
				if (state.again && validClaim(claim) && !stopped) void refresh(taskId, scientific);
				void trimIdleOwners().catch((error) =>
					onError({ taskId, code: error.code, message: error.message })
				);
			});
		state.promise = work;
		if (scientific) serial = work;
		else controlSerial = work;
		lane.set(taskId, state);
		if (scientific && !state.operationId) trackDisplayPreparation(taskId, state.promise);
		return state.promise;
	}
	async function read({ taskId, refresh: immediate, knownRevision }, retried = false) {
		selected.add(taskId);
		ownerLastUsed.set(taskId, ++ownerClock);
		if (
			validClaim() &&
			(immediate ||
				(immediate !== false && !cache(store.read("task", taskId)?.latestRunId || "missing")))
		)
			void refresh(taskId, false).then(() => refresh(taskId, true));
		if (validClaim() && immediate !== false) void refresh(taskId, false);
		const detail = taskDetail(store, taskId, readerImplementationVersion, getStopOptions()),
			run = store.read("run", detail.task.runId),
			candidatePublication = store.read("task", taskId)?.resultsInvalidatedByOverwrite || detail.task.workFileState === "cleared" && !detail.files.some(file => file.sourceKind === "archive" && file.role.split("、").includes("primary-output")) ? null : run
				? cache(run.runId)
				: detail.task.sourceSetId
					? cache(sourceCacheKey(store.read("task", taskId)))
					: null,
			currentSourceFile = detail.files.find(file => file.artifactId === candidatePublication?.sourceIdentity?.artifactId),
			fallbackLocation = candidatePublication?.actualReadLocation,
			fallbackArtifact = candidatePublication?.archiveFailure && store.read("artifact", candidatePublication.archiveFailure.artifactId),
			verifiedFallback = Boolean(candidatePublication?.archiveFailure && currentSourceFile && fallbackArtifact && fallbackLocation && run && detail.task.workFileState !== "cleared" && fallbackArtifact.runId === run.runId && candidatePublication.sourceIdentity?.artifactId === fallbackArtifact.artifactId && candidatePublication.sourceIdentity.path === fallbackLocation.path && fallbackArtifact.locations?.some(location => location.role === "original" && location.path === fallbackLocation.path && location.environmentId === fallbackLocation.environmentId)),
			publication = candidatePublication?.sourceIdentity?.path && currentSourceFile && candidatePublication.sourceIdentity.path !== currentSourceFile.path && !verifiedFallback ? null : candidatePublication;
		if (publication?.archiveFailure && verifiedFallback) {
			currentSourceFile.path = fallbackLocation.path;
			currentSourceFile.sourceKind = "work";
			detail.resultSource = { kind: "work", path: run.executionIdentity.workLocation.path };
			detail.task.archiveState = "failed";
		}
		// The scientific publication carries the actual source stat and read boundary.
		// Reuse this observation for that exact file; it is independent of scientific convergence.
		const observedSource = publication?.sourceIdentity,
			observedFile = publication?.sourceBoundary?.fileIdentity,
			observedRead = publication?.sourceBoundary?.readByteRange;
		if (observedSource && observedFile && !sourceErrors.has(taskId)) {
			const file = detail.files.find(value => value.artifactId === observedSource.artifactId && value.path === observedFile.path);
			if (file && file.exists !== false && observedFile.isRegularFile === true) {
				file.size = observedFile.byteSize;
				file.exists = true;
				file.checkedAt = observedFile.checkedAt || publication.updatedAt || null;
				file.verificationState = "verified";
				if (observedRead && observedRead.end > observedRead.start) {
					file.readable = true;
					file.readError = null;
				}
			}
		}
		if (sourceErrors.has(taskId))
			detail.notices.push(
				...require("./task-failures.cjs").failureNotices({
					runId: taskId,
					taskFailures: { source: sourceErrors.get(taskId) }
				})
			);
		if (!publication)
			return {
				...detail,
				progress: progress.get(taskId) || null,
				results: [],
				sourceGeneration: null,
				sourceRevision: null,
				sourceBoundary: null,
				collectionId: null,
				revision: null,
				baseRevision: knownRevision || null,
				frameCount: 0,
				framesDelta: [],
				reset: true,
				prepared: false,
				cards: [],
				layout: run?.monitorLayout ?? ["energy"]
			};
		const unchanged = knownRevision === publication.revision,
			incremental =
				knownRevision !== null &&
				knownRevision === publication.previousRevision &&
				publication.previousCollectionId === publication.collectionId;
		const framesDelta = [];
		try {
			if (!unchanged)
				for (const [index, key] of publication.frameRefs.entries()) {
					if (incremental && key === publication.previousFrameRefs[index]) continue;
					const file = path.join(frameRoot, key + ".json");
					noLinks(file);
					const bytes = fs.readFileSync(file);
					if (hash(bytes) !== key) throw fail("MONITOR_FRAME_CACHE_CORRUPT");
					framesDelta.push({ index, frame: JSON.parse(bytes) });
				}
		} catch (error) {
			if (error.code === "ENOENT" && !retried)
				return read({ taskId, refresh: false, knownRevision: null }, true);
			throw error;
		}
		return {
			...detail,
			...(publication.sourceIdentity ? { sourceIdentity: publication.sourceIdentity } : {}),
			...(publication.archiveFailure ? { archiveFailure: publication.archiveFailure } : {}),
			...(publication.actualReadLocation ? { actualReadLocation: publication.actualReadLocation } : {}),
			...(typeof publication.resultsComplete === "boolean"
				? { resultsComplete: publication.resultsComplete }
				: {}),
			progress: progress.get(taskId) || null,
			results: publication.results || [],
			sourceGeneration: publication.sourceGeneration || null,
			sourceRevision: publication.sourceRevision || null,
			sourceBoundary: publication.sourceBoundary || null,
			stage: publication.stage,
			iteration: publication.iteration,
			elapsedSeconds: detail.elapsedSeconds,
			notices: [
				...new Map(
					[...(publication.notices || []), ...detail.notices].map((notice) => [notice.id, notice])
				).values()
			],
			updatedAt: publication.updatedAt,
			collectionId: publication.collectionId,
			revision: publication.revision,
			baseRevision: unchanged || incremental ? knownRevision : null,
			frameCount: publication.frameCount,
			framesDelta,
			reset: !unchanged && !incremental,
			prepared: publication.prepared,
			cards: publication.cards,
			layout: run?.monitorLayout ?? ["energy"]
		};
	}
	function start() {
		stopped = false;
		if (timer) return;
		timer = setInterval(() => {
			const config = settings.read().value.monitoring;
			if (!config.automatic || !validClaim()) return;
			const stamp = performance.now();
			for (const task of iterateRecords(store, "task")) {
				if (task.deleted) continue;
				const run = task.latestRunId && store.read("run", task.latestRunId);
				if (!run || (run.state.executionState === "ended" && !activePreparation(store, run.runId)))
					continue;
				const interval = selected.has(task.taskId)
						? run.environmentSnapshot.connection.kind === "ssh" ||
							run.environmentSnapshot.scheduler.kind === "slurm"
							? config.remoteIntervalSeconds
							: config.localIntervalSeconds
						: config.backgroundIntervalSeconds,
					failed = failures.get(task.taskId),
					backoff = failed ? Math.min(8, 2 ** failed.count) : 1;
				if (stamp - (lastScheduled.get(task.taskId) ?? -Infinity) >= interval * 1000 * backoff) {
					lastScheduled.set(task.taskId, stamp);
					void refresh(task.taskId, false);
					if (selected.has(task.taskId)) void refresh(task.taskId, true);
				}
			}
		}, 1000);
		timer.unref?.();
	}
	async function release(taskId) {
		selected.delete(taskId);
		ownerLastUsed.set(taskId, ++ownerClock);
		await trimIdleOwners();
	}
	async function detachViews() {
		clearInterval(timer); timer = null; selected.clear();
		const display = [...running.values(), ...inspecting.values()].filter(work => !work.operationId);
		for (const work of display) work.controller.abort();
		await Promise.allSettled(display.map(work => work.promise));
		await trimIdleOwners();
	}
	async function stop() {
		stopped = true;
		clearInterval(timer);
		timer = null;
		for (const value of running.values()) value.controller.abort();
		for (const value of inspecting.values()) value.controller.abort();
		await Promise.allSettled([...running.values(), ...inspecting.values()].map((x) => x.promise));
		await Promise.allSettled([...owners.values()].map(retireOwner));
		await Promise.allSettled([...ownerDisposals]);
		owners.clear();
		ownerVersions.clear();
		ownerTokens.clear();
		ownerLastUsed.clear();
		selected.clear();
	}
	return {
		detachViews,
		resumeOperations() { stopped = false; },
		async continueOperation(access, taskId, scientific) { access.assert(); const work = (scientific ? running : inspecting).get(taskId); if (work && work.operationId !== access.operationId) await work.promise; access.assert(); return operationScope.run(access, () => refresh(taskId, scientific)); },
		cancelOperation(operationId) { for (const work of [...running.values(), ...inspecting.values()]) if (work.operationId === operationId) work.controller.abort(); },
		preparedPublication(taskId, runId) { const task = rawStore.read("task", taskId); return task?.latestRunId === runId ? cache(runId) : null; },
		start,
		stop,
		read,
		refresh,
		release,
		applyReceipts,
		cancel(taskId) {
			running.get(taskId)?.controller.abort();
		},
		active: () => running.size,
		usesTask: (taskId) => running.has(taskId),
		async snapshotSources(taskId, signal) {
			const source = owners.get(taskId);
			if (!source?.snapshotSources) {
				const task = store.read("task", taskId),
					publication = task && cache(task.latestRunId || sourceCacheKey(task));
				throw fail("SNAPSHOT_SOURCE_NOT_PREPARED", {
					taskId,
					sourceSetId: task?.sourceSetId ?? null,
					sourceVersion: task?.sourceVersion ?? null,
					preparedPublication: publication?.prepared === true
				});
			}
			snapshotPins.set(source, (snapshotPins.get(source) || 0) + 1);
			const unpin = async () => {
				const count = (snapshotPins.get(source) || 1) - 1;
				if (count) snapshotPins.set(source, count);
				else {
					snapshotPins.delete(source);
					if (retiredOwners.delete(source)) await retireOwner(source);
				}
				await trimIdleOwners();
			};
			let retained;
			try {
				retained = await source.snapshotSources({ signal });
			} catch (error) {
				await unpin();
				throw error;
			}
			let released = false;
			return {
				...retained,
				async release() {
					if (released) return;
					released = true;
					try {
						await retained.release?.();
					} finally {
						await unpin();
					}
				}
			};
		}
	};
}
module.exports = { createMonitoring };
