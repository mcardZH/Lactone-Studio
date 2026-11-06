"use strict";
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { fail, sha256, quote, response, validate, joinLocation, basename } = require("./common.cjs");
const { buildPosixRunner, linuxProbeScript } = require("./posix-runner.cjs");
const { RUNNER_VERSION } = require("./runner.cjs");
const { event } = require("./runner.cjs");
const { chunks } = require("./sources.cjs");
const { reserveExternalOutputs } = require("./external-outputs.cjs");
const { cancellationClaim, isCancellationClaim } = require("./claims.cjs");
const { isMissingFile } = require("../transports/file-errors.cjs");
function createProcessAdapter({
	protocol,
	transport,
	platform,
	runtimeAssets,
	spawnDetached,
	probeProcessIdentity,
	stopVerifiedProcessTree,
	readInputFile,
	readExecutionReceipt,
	shouldStopBeforeSubmit,
	canProveBeforeHandoff,
	now = () => new Date().toISOString()
}) {
	const join = (...parts) =>
		platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
	const preparedHere = new Set(),
		handoffHere = new Set(),
		preparingHere = new Set();
	async function read(file, io) {
		try {
			const identity = await transport.stat(file, io);
			if (identity.byteSize > 1024 * 1024) fail("RECEIPT_TOO_LARGE");
			const range = await transport.readRange(
				{ path: file, identity, offset: 0, length: identity.byteSize },
				io
			);
			return JSON.parse(Buffer.from(range.bytes).toString("utf8"));
		} catch (error) {
			if (isMissingFile(error, file)) return null;
			throw error;
		}
	}
	function location(request) {
		const work = request.payload.workLocation;
		if (work?.environmentId !== request.environmentId || typeof work.path !== "string")
			fail("WORK_LOCATION_MISMATCH");
		return work;
	}
	function paths(request) {
		const work = location(request);
		const state = join(work.path, ".es-execution");
		return {
			work,
			state,
			manifest: join(state, "manifest.json"),
			launch: join(state, "launch.json"),
			end: join(state, "end.json")
		};
	}
	async function put(file, bytes, io) {
		return transport.putAtomic(
			{
				path: file,
				source: bytes,
				byteSize: bytes.length,
				sha256: sha256(bytes),
				expectedAbsent: true
			},
			io
		);
	}
	async function checkPrepared(request, io) {
		const p = paths(request),
			manifest = await read(p.manifest, io);
		assertPrepared(request, manifest);
		return { p, manifest };
	}
	async function readStopEvidence(file, io) {
		try {
			const identity = await transport.stat(file, io);
			if (!identity.isRegularFile || identity.byteSize > 1024 * 1024) return null;
			const range = await transport.readRange({ path: file, identity, offset: 0, length: identity.byteSize }, io);
			return { text: Buffer.from(range.bytes).toString("utf8").trimEnd(), modifiedAt: identity.modifiedAt };
		} catch (error) {
			if (isMissingFile(error, file)) return null;
			throw error;
		}
	}
	async function stoppedDisposition(manifest, p, launch, end, io) {
		if (platform === "win32" || !manifest.executionFeatures?.includes("posix-stop-dispatch-v1") ||
			end.eventType !== "run.ended" || end.operationId !== manifest.operationId ||
			end.payload.notStarted === true || end.payload.endReason !== "failed" ||
			!Number.isInteger(end.payload.exitCode) || end.payload.exitCode === 0)
			return null;
		const identity = launch?.payload.identity, tree = end.payload.processTree;
		const manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
		if (launch?.eventType !== "run.launched" || launch.operationId !== manifest.operationId ||
			launch.payload.manifestHash !== manifestHash || identity?.kind !== "linux" || identity.cwd !== p.work.path ||
			!Number.isSafeInteger(identity.pid) || !Number.isSafeInteger(identity.startTicks) ||
			tree?.scope !== "linux-session" || tree.verified !== true ||
			(tree.activeProcesses !== undefined && tree.activeProcesses !== 0) || tree.pid !== identity.pid ||
			tree.bootId !== identity.bootId || tree.userId !== identity.userId) return null;
		const ownerPath = join(p.state, "stop-dispatch-owner"), owner = await readStopEvidence(ownerPath, io);
		if (!owner) return null;
		const [ownerProcess, ownerBinding, ownerIntent, extra] = owner.text.split("\n");
		if (extra !== undefined || !/^[1-9]\d* [1-9]\d*$/.test(ownerProcess || "")) return null;
		const { taskId, runId, submissionIntentId } = manifest;
		const { pid, bootId, startTicks } = identity;
		const binding = { runId, submissionIntentId, pid, bootId, startTicks, manifestHash };
		if (ownerBinding !== JSON.stringify(binding)) return null;
		let intent;
		try { intent = JSON.parse(ownerIntent); } catch { return null; }
		const stopOperationId = intent?.operationId;
		const expected = JSON.stringify({ operationId: stopOperationId, runId, submissionIntentId, pid, bootId, startTicks });
		if (typeof stopOperationId !== "string" || !stopOperationId || ownerIntent !== expected) return null;
		const attemptPath = join(p.state, `stop-signal-attempt.${ownerProcess.replace(" ", ".")}.json`),
			dispatchPath = join(p.state, "stop-dispatched.json"), intentPath = join(p.state, "stop-intent.json");
		const attempt = await readStopEvidence(attemptPath, io), dispatch = await readStopEvidence(dispatchPath, io),
			savedIntent = await readStopEvidence(intentPath, io), savedEnd = await readStopEvidence(p.end, io);
		if ([attempt, dispatch, savedIntent].some(record => record?.text !== expected) || !savedEnd ||
			!isDeepStrictEqual(JSON.parse(savedEnd.text), end)) return null;
		const [attemptAt, dispatchedAt, endAt] = [attempt, dispatch, savedEnd].map(record => record.modifiedAt);
		const launchAt = launch.occurredAt?.replace("T", " ").replace(/Z$/, "");
		if (!launchAt || ![attemptAt, dispatchedAt, endAt].every(time =>
			/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} \+0000$/.test(time)) ||
			attemptAt.slice(0, 19) < launchAt.slice(0, 19) || attemptAt > dispatchedAt || attemptAt > endAt) return null;
		return { kind: "posix-term-verified", taskId, runId, submissionIntentId, stopOperationId,
			launchReceiptId: launch.receiptId, endReceiptId: end.receiptId, exitCode: end.payload.exitCode,
			attemptAt, dispatchedAt, endAt, evidenceRefs: [p.manifest, p.launch, p.end, ownerPath, intentPath, attemptPath, dispatchPath] };
	}
	function assertPrepared(request, manifest) {
		if (
			!manifest ||
			manifest.runId !== request.runId ||
			manifest.submissionIntentId !== request.submissionIntentId ||
			manifest.taskId !== request.taskId
		)
			fail("PREPARED_INTENT_MISMATCH");
		if (
			request.payload.manifestHash &&
			sha256(Buffer.from(JSON.stringify(manifest))) !== request.payload.manifestHash
		)
			fail("MANIFEST_IDENTITY_CHANGED");
	}
	async function persistentHandoff(request, p, scriptName, logName, io) {
		if (typeof transport.handoffPersistentCommand !== "function")
			fail("WSL_PERSISTENT_HANDOFF_UNAVAILABLE");
		const binding = {
				taskId: request.taskId,
				runId: request.runId,
				submissionIntentId: request.submissionIntentId,
				operationId: request.operationId
			},
			command = {
				executable: "bash",
				args: [join(p.state, scriptName)],
				cwd: p.work.path,
				env: {},
				stdoutPath: join(p.state, logName),
				stderrPath: join(p.state, logName)
			},
			commandHash = sha256(Buffer.from(JSON.stringify(command))),
			kind = scriptName === "runner.sh" ? "native" : "preparation",
			claimPath = join(p.state, `persistent-${kind}-connection-claim.json`),
			receiptPath = join(p.state, `persistent-${kind}-connection.json`),
			claim = { protocolVersion: 1, ...binding, commandHash, claimedAt: now() };
		const existing = await read(claimPath, io);
		if (existing) {
			if (
				!Object.entries({ ...binding, commandHash }).every(
					([key, value]) => existing[key] === value
				)
			)
				fail("PERSISTENT_HANDOFF_IDENTITY_CONFLICT");
			const receipt = await read(receiptPath, io);
			if (!receipt)
				fail("PERSISTENT_HANDOFF_CLAIM_WITHOUT_RECEIPT", {
					stage: "persistent-handoff",
					binding,
					claimPath,
					receiptPath
				});
			if (
				!Object.entries({ ...binding, commandHash }).every(([key, value]) => receipt[key] === value)
			)
				fail("PERSISTENT_HANDOFF_IDENTITY_CONFLICT");
			return { ...receipt, reusedIntent: true };
		}
		try {
			await put(claimPath, Buffer.from(JSON.stringify(claim)), io);
		} catch (error) {
			if (await read(claimPath, io)) return persistentHandoff(request, p, scriptName, logName, io);
			throw error;
		}
		let launched;
		try {
			launched = await transport.handoffPersistentCommand({ command, binding }, io);
		} catch (error) {
			fail("PERSISTENT_HANDOFF_UNVERIFIED", {
				stage: "persistent-handoff",
				binding,
				claimPath,
				receiptPath,
				causeCode: error.code || "WSL_CONNECTION_DISPATCH_FAILED"
			});
		}
		const receipt = {
			...launched,
			...binding,
			commandHash,
			evidenceRefs: [claimPath, receiptPath, ...launched.evidenceRefs]
		};
		await put(receiptPath, Buffer.from(JSON.stringify(receipt)), io);
		return receipt;
	}
	async function probe(identity, work, io) {
		if (!identity) return { status: "unknown" };
		if (platform === "win32")
			return probeProcessIdentity ? probeProcessIdentity(identity) : { status: "unknown" };
		try {
			const result = await transport.exec(
				{ executable: "bash", args: ["-c", linuxProbeScript(identity) + "; printf '\\n'; awk '{print $1}' /proc/uptime; getconf CLK_TCK 2>/dev/null || true"], cwd: work.path, env: {} },
				io
			);
			const fields = Buffer.from(result.stdout).toString("ascii").trim().split(/\s+/), status = result.exitCode === 0 ? fields[0] : "unknown";
			const timing = status === "alive" ? require("../runtime-timing.cjs").linuxTiming(identity, Number(fields[1]), Number(fields[2])) : null;
			return { status, ...(timing ? { runtimeTiming: timing } : {}) };
		} catch {
			return { status: "unknown" };
		}
	}
	async function preparationStatus(manifest, p, launch, end, io) {
		if (!manifest.resultPreparation) return { state: "unavailable", ended: true };
		if (end && (end.payload.notStarted === true || end.payload.end?.processTree?.verified === true))
			return { state: "ended", ended: true };
		if (!launch) return { state: "pending", ended: false };
		const observation = await probe(
			launch.payload.launch?.identity || launch.payload.identity,
			p.work,
			io
		);
		return {
			state:
				observation.status === "alive"
					? "running"
					: observation.treeEnded === true
						? "ended-unverified"
						: "unknown",
			ended: observation.treeEnded === true,
			observation
		};
	}
	async function cancelBeforeLaunch(request, owner, io) {
		const p = paths(request);
		if (!owner.executionFeatures?.includes("intent-cancel-gate-v1")) return null;
		if (
			owner.taskId !== request.taskId ||
			owner.runId !== request.runId ||
			owner.submissionIntentId !== request.submissionIntentId
		)
			fail("RUN_LOCATION_OWNER_CONFLICT");
		const knownEnd = await read(p.end, io);
		if (knownEnd && !knownEnd.payload.notStarted) return null;
		if ((await read(p.launch, io)) || request.payload.knownLaunchIdentity) return null;
		const claimPath = join(p.state, "intent-claim.json"),
			claim = cancellationClaim(request);
		try {
			await put(claimPath, Buffer.from(JSON.stringify(claim)), io);
		} catch (error) {
			if (
				error.code !== "EEXIST" &&
				!(error.code === "POSIX_CONTROL_FAILED" && /File exists/.test(error.details?.stderr || ""))
			)
				throw error;
			const existing = await read(claimPath, io);
			if (!isCancellationClaim(existing, request)) return null;
		}
		const beforeHandoff =
			(preparedHere.has(request.runId) && !handoffHere.has(request.runId)) ||
			canProveBeforeHandoff?.(request, owner) === true;
		let end = knownEnd;
		if (!end && !beforeHandoff)
			return response(
				protocol,
				request,
				{ evidenceRefs: [claimPath], cancellationRequested: true },
				"accepted",
				{
					executionState: "stop-requested",
					verificationState: "unknown",
					relatedActivityEnded: false
				}
			);
		if (!end) {
			end = {
				...event({ ...owner, workLocation: p.work }, "run.ended", 2, {
					notStarted: true,
					exitCode: null,
					signal: null,
					endReason: "stopped",
					processTree: { verified: true, notStarted: true },
					stopOperationId: request.action === "requestStop" ? request.operationId : null
				}),
				source: `es-prepare-owner:${request.runId}`
			};
			try {
				await put(p.end, Buffer.from(JSON.stringify(end)), io);
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				end = await read(p.end, io);
			}
		}
		return response(
			protocol,
			request,
			{ endReceipt: end, cancelledBeforeLaunch: true, evidenceRefs: [claimPath, p.end] },
			"completed",
			{
				executionState: "ended",
				endReason: "stopped",
				verificationState: "verified",
				notStarted: true,
				relatedActivityEnded: !preparingHere.has(request.runId),
				resultPreparation: owner.resultPreparation ? "not-started" : "unavailable"
			}
		);
	}
	const adapter = {
		kind: "process",
		adapterVersion: "1.0.0",
		async capabilities(request, io) {
			validate(protocol, request, "capabilities");
			const capabilities = await transport.capabilities(io);
			return response(protocol, request, {
				...capabilities,
				platform,
				adapterVersion: adapter.adapterVersion,
				nativeVerified: false
			});
		},
		async prepare(request, io) {
			validate(protocol, request, "prepare");
			preparingHere.add(request.runId);
			try {
				const p = paths(request),
					payload = request.payload;
				const supportsPosixStop = platform !== "win32" && request.adapterTarget !== "slurm" &&
					["ssh", "wsl"].includes(transport.kind);
				const manifest = payload.manifest
					? {
							...payload.manifest,
							executionFeatures: [
								...(payload.manifest.executionFeatures || []),
								"intent-cancel-gate-v1",
								...(supportsPosixStop ? ["posix-stop-dispatch-v1"] : [])
							],
							inputFiles: (payload.files || []).map((file) => ({
								name: file.name,
								byteSize: file.byteSize,
								sha256: file.sha256,
								artifactId: file.artifactId
							}))
						}
					: null;
				if (
					!manifest ||
					manifest.runId !== request.runId ||
					manifest.taskId !== request.taskId ||
					manifest.submissionIntentId !== request.submissionIntentId ||
					manifest.operationId !== request.operationId ||
					manifest.workLocation.path !== p.work.path ||
					manifest.command.cwd !== p.work.path
				)
					fail("MANIFEST_IDENTITY_MISMATCH");
				for (const file of [
					manifest.command.stdoutPath,
					manifest.command.stderrPath,
					manifest.command.stdinPath
				].filter(Boolean))
					if (
						join(
							p.work.path,
							platform === "win32" ? path.win32.basename(file) : path.posix.basename(file)
						) !== file
					)
						fail("COMMAND_FILE_OUTSIDE_WORK_LOCATION");
				const key = (value) => (platform === "win32" ? value.toLowerCase() : value);
				const reserved = new Set(
					[manifest.command.stdoutPath, manifest.command.stderrPath, manifest.primaryOutputPath]
						.filter(Boolean)
						.map(key)
				);
				await require("../transports/working-parent.cjs").ensureWorkingParent(transport, (platform === "win32" ? path.win32 : path.posix).dirname(p.work.path), io);
				if (supportsPosixStop) {
					const capability = await transport.exec({
						executable: "bash",
						args: ["-c", "command flock --version"],
						cwd: path.posix.dirname(p.work.path),
						env: {}
					}, io);
					if (capability.exitCode !== 0) fail("POSIX_STOP_FLOCK_UNAVAILABLE");
				}
				await transport.mkdirExclusive(p.work.path, io);
				await transport.mkdirExclusive(p.state, io);
				await put(
					join(p.state, "location-owner.json"),
					Buffer.from(
						JSON.stringify({
							protocolVersion: 1,
							taskId: request.taskId,
							runId: request.runId,
							submissionIntentId: request.submissionIntentId,
							operationId: request.operationId,
							workLocation: p.work,
							executionFeatures: manifest.executionFeatures,
							resultPreparation: manifest.resultPreparation || null
						})
					),
					io
				);
				preparedHere.add(request.runId);
				if (shouldStopBeforeSubmit?.(request)) {
					const cancelled = await cancelBeforeLaunch(request, manifest, io);
					if (cancelled) {
						const saved = await put(p.manifest, Buffer.from(JSON.stringify(manifest)), io);
						cancelled.payload.files = [saved];
						cancelled.payload.manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
						return cancelled;
					}
				}
				manifest.externalOutputs = await reserveExternalOutputs({
					manifest,
					request,
					transport,
					platform,
					io
				});
				let scratch = null;
				if (manifest.scratch) {
					const value = manifest.scratch,
						api = platform === "win32" ? path.win32 : path.posix;
					if (
						value.environmentId !== request.environmentId ||
						!api.isAbsolute(value.path) ||
						api.dirname(value.path) !== value.root ||
						!(api.basename(value.path) === "scratch" || /^es-[a-f0-9]{32}$/.test(api.basename(value.path)))
					)
						fail("SCRATCH_IDENTITY_CONFLICT");
					await transport.mkdirExclusive(value.path, io);
					const identity = await transport.stat(value.path, io),
						owner = {
							protocolVersion: 1,
							taskId: request.taskId,
							runId: request.runId,
							submissionIntentId: request.submissionIntentId,
							inputSnapshotId: value.inputSnapshotId,
							inputContentIdentity: value.inputContentIdentity,
							workLocation: p.work,
							scratchLocation: { environmentId: request.environmentId, path: value.path }
						};
					const marker = await put(
						join(value.path, ".es-scratch-owner.json"),
						Buffer.from(JSON.stringify(owner)),
						io
					);
					scratch = { ...value, identity, ownerMarker: marker };
				}
				const files = payload.files;
				if (!Array.isArray(files) || !files.length) fail("INPUT_FILES_REQUIRED");
				const seen = new Set(),
					results = [];
				if (!readInputFile) fail("INPUT_FILE_PROVIDER_REQUIRED");
				for (const file of files) {
					basename(file.name);
					const destination = joinLocation(p.work.path, file.name, platform);
					if (reserved.has(key(destination))) fail("INPUT_OUTPUT_PATH_COLLISION");
					if (seen.has(key(file.name))) fail("DUPLICATE_PREPARED_FILE");
					seen.add(key(file.name));
					const source = await readInputFile(file, request, io);
					try {
						results.push(
							await transport.putAtomic(
								{
									path: destination,
									source: chunks(source, io),
									byteSize: file.byteSize,
									sha256: file.sha256,
									expectedAbsent: true
								},
								io
							)
						);
					} finally {
						await source.close?.();
					}
				}
				if (platform !== "win32") {
					const sources = buildPosixRunner(manifest);
					results.push(await put(join(p.state, "engine.sh"), sources.engine, io));
					results.push(await put(join(p.state, "runner.sh"), sources.runner, io));
					results.push(await put(join(p.state, "prepare.sh"), sources.preparation, io));
				}
				const cancelled = shouldStopBeforeSubmit?.(request)
					? await cancelBeforeLaunch(request, manifest, io)
					: null;
				if (manifest.gaussianWindowsFiles) {
					if (scratch) manifest.scratch = scratch;
					manifest.workIdentity = await transport.stat(p.work.path, io);
				}
				results.push(await put(p.manifest, Buffer.from(JSON.stringify(manifest)), io));
				if (cancelled) {
					cancelled.payload.files = results;
					cancelled.payload.manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
					cancelled.payload.scratch = scratch;
					cancelled.payload.externalOutputs = manifest.externalOutputs;
					return cancelled;
				}
				return response(
					protocol,
					request,
					{
						workLocation: p.work,
						files: results,
						manifestHash: sha256(Buffer.from(JSON.stringify(manifest))),
						scratch,
						externalOutputs: manifest.externalOutputs,
						evidenceRefs: [p.manifest]
					},
					"completed",
					{ executionState: "preparing" }
				);
			} finally {
				preparingHere.delete(request.runId);
			}
		},
		async submit(request, io) {
			validate(protocol, request, "submit");
			const { p, manifest } = await checkPrepared(request, io);
			if (shouldStopBeforeSubmit?.(request)) {
				const cancelled = await cancelBeforeLaunch(request, manifest, io);
				if (cancelled) return cancelled;
			}
			const existing = await read(p.launch, io),
				ended = await read(p.end, io);
			if (existing || ended)
				return response(
					protocol,
					request,
					{
						launchReceipt: existing,
						endReceipt: ended,
						reusedIntent: true,
						evidenceRefs: [existing ? p.launch : p.end]
					},
					"completed",
					{ executionState: ended ? "ended" : "running" }
				);
			// A helper may be requested twice; its permanent exclusive claim admits one native launch.
			// The host must not clear a claim or create a new intent after a transport failure.
			let persistentConnection = null;
			if (transport.kind === "wsl") {
				handoffHere.add(request.runId);
				persistentConnection = await persistentHandoff(
					request,
					p,
					"runner.sh",
					"runner-stdio.txt",
					io
				);
			} else if (platform === "win32") {
				handoffHere.add(request.runId);
				if (
					!spawnDetached ||
					!runtimeAssets?.executable ||
					!runtimeAssets.runnerPath ||
					!manifest.identityModulePath
				)
					fail("RUNNER_RUNTIME_UNAVAILABLE");
				await spawnDetached({
					executable: runtimeAssets.executable,
					args: [runtimeAssets.runnerPath, p.manifest],
					cwd: p.work.path,
					env: { ELECTRON_RUN_AS_NODE: "1" },
					stdio: "ignore",
					detached: true,
					windowsHide: true
				});
			} else {
				handoffHere.add(request.runId);
				const command = `nohup setsid bash ${quote(join(p.state, "runner.sh"))} </dev/null > ${quote(join(p.state, "runner-stdio.txt"))} 2>&1 &`;
				const receipt = await transport.exec(
					{ executable: "bash", args: ["-c", command], cwd: p.work.path, env: {} },
					io
				);
				if (receipt.exitCode !== 0) fail("RUNNER_HANDOFF_UNVERIFIED");
			}
			return response(
				protocol,
				request,
				{
					evidenceRefs: [p.manifest, ...(persistentConnection?.evidenceRefs || [])],
					intentAccepted: true,
					...(persistentConnection ? { persistentConnection } : {})
				},
				"accepted",
				{ executionState: "submitting", verificationState: "unknown" }
			);
		},
		async inspect(request, io) {
			validate(protocol, request, "inspect");
			const { p, manifest } = await checkPrepared(request, io),
				launch = await read(p.launch, io),
				end = await read(p.end, io);
			const preparationLaunch = await read(join(p.state, "preparation-launch.json"), io),
				preparationEnd = await read(join(p.state, "preparation-end.json"), io);
			const runnerError = await read(join(p.state, "runner-error.json"), io),
				primaryEnd = await read(join(p.state, "primary-end.json"), io);
			for (const receipt of [launch, end, preparationLaunch, preparationEnd].filter(Boolean))
				if (
					receipt.taskId !== request.taskId ||
					receipt.runId !== request.runId ||
					receipt.submissionIntentId !== request.submissionIntentId
				)
					fail("RECEIPT_IDENTITY_CONFLICT");
			if (end) {
				const stopDisposition = await stoppedDisposition(manifest, p, launch, end, io).catch(error => {
					if (io?.signal?.aborted) throw error;
					return null;
				});
				const preparation =
					end.payload.notStarted === true && !preparationLaunch
						? { state: "not-started", ended: true }
						: await preparationStatus(manifest, p, preparationLaunch, preparationEnd, io);
				return response(
					protocol,
					request,
					{
						launchReceipt: launch,
						endReceipt: end,
						...(stopDisposition ? { stopDisposition } : {}),
						preparationLaunch,
						preparationEnd,
						preparationObservation: preparation.observation || null,
						evidenceRefs: [p.end]
					},
					"completed",
					{
						executionState: "ended",
						endReason: end.payload.endReason,
						verificationState: "verified",
						resultPreparation: preparation.state,
						relatedActivityEnded: preparation.ended && !preparingHere.has(request.runId)
					}
				);
			}
			const observed = await probe(launch?.payload.identity, p.work, io);
			if (observed.treeEnded === true && observed.status === "dead") {
				const cleanupIntent = await read(join(p.state, "gaussian-owner-cleanup-intent.json"), io),
					userStop = await read(join(p.state, "stop-intent.json"), io);
				if (
					cleanupIntent &&
					(cleanupIntent.runId !== request.runId ||
						cleanupIntent.submissionIntentId !== request.submissionIntentId ||
						cleanupIntent.payload.identity?.native?.jobName !==
							launch?.payload.identity?.native?.jobName)
				)
					fail("GAUSSIAN_OWNER_CLEANUP_CONFLICT");
				const id = `${request.submissionIntentId}:run.recovered-end:5`;
				let recovered = readExecutionReceipt?.(id);
				if (!recovered)
					recovered = {
						...event(manifest, "run.recovered-end", 5, {
							exitCode: observed.exitCode ?? null,
							endedAt: observed.endedAt || null,
							endReason: userStop
								? "stopped"
								: cleanupIntent?.payload.outcome
									? cleanupIntent.payload.outcome
									: observed.exitCode === 0
										? "completed"
										: Number.isInteger(observed.exitCode)
											? "failed"
											: "unknown",
							processTree: observed,
							...(cleanupIntent
								? {
										managedLauncherCleanup: {
											...cleanupIntent.payload,
											actionVerification: "intent-only-recovered"
										},
										naturalOwnerExit: null
									}
								: {}),
							recovered: true
						}),
						source: `es-recovery:1.0.0:${request.runId}`
					};
				return response(
					protocol,
					request,
					{
						launchReceipt: launch,
						endReceipt: recovered,
						preparationLaunch,
						preparationEnd,
						evidenceRefs: recovered.evidenceRefs
					},
					"completed",
					{
						executionState: "ended",
						endReason: recovered.payload.endReason,
						verificationState: "verified"
					}
				);
			}
			if (observed.status === "alive")
				return response(
					protocol,
					request,
					{
						launchReceipt: launch,
						preparationLaunch,
						preparationEnd,
						observation: observed,
						evidenceRefs: [p.launch]
					},
					"completed",
					{ executionState: "running", verificationState: "verified" }
				);
			return response(
				protocol,
				request,
				{
					launchReceipt: launch,
					preparationLaunch,
					preparationEnd,
					runnerError,
					primaryEnd,
					observation: observed,
					manifestHash: sha256(Buffer.from(JSON.stringify(manifest))),
					evidenceRefs: [p.manifest]
				},
				"waiting-verification",
				{
					executionState: "unknown",
					verificationState: observed.status === "conflict" ? "conflict" : "unknown",
					reason:
						runnerError?.payload.code ||
						primaryEnd?.payload.reason ||
						(observed.status === "dead"
							? "PROCESS_GONE_WITHOUT_END_RECEIPT"
							: "EXECUTION_IDENTITY_UNVERIFIED")
				}
			);
		},
		async requestStop(request, io) {
			validate(protocol, request, "requestStop");
			const location = paths(request),
				prepared = await read(location.manifest, io),
				owner = prepared || (await read(join(location.state, "location-owner.json"), io));
			const fastPosixStop = platform !== "win32" && prepared?.executionFeatures?.includes("posix-stop-dispatch-v1");
			async function stopPosixNative(launch) {
				if (launch && (launch.taskId !== request.taskId || launch.runId !== request.runId ||
					launch.submissionIntentId !== request.submissionIntentId || launch.operationId !== prepared.operationId))
					fail("RECEIPT_IDENTITY_CONFLICT");
				const identity = launch?.payload.identity || request.payload.knownLaunchIdentity;
				if (!identity) return null;
				if (identity.cwd !== location.work.path) fail("STOP_IDENTITY_CONFLICT");
				assertPrepared(request, prepared);
				const intent = {
					operationId: request.operationId, runId: request.runId,
					submissionIntentId: request.submissionIntentId,
					pid: identity.pid, bootId: identity.bootId, startTicks: identity.startTicks
				};
				const result = await transport.exec({
					executable: "bash",
					args: ["-c", linuxProbeScript(identity, true, {
						state: location.state, end: location.end, intent,
						manifest: location.manifest, manifestHash: sha256(Buffer.from(JSON.stringify(prepared)))
					})],
					cwd: location.work.path,
					env: {}
				}, io);
				const status = result.exitCode === 0 ? Buffer.from(result.stdout).toString("ascii") : "unknown";
				if (status === "ended" || status === "dead") return null;
				const requested = status === "requested";
				return response(protocol, request, {
					stopRequested: requested,
					evidenceRefs: [requested ? join(location.state, "stop-dispatched.json") : location.manifest]
				}, requested ? "accepted" : "waiting-verification", {
					executionState: requested ? "stop-requested" : "unknown",
					verificationState: requested ? "verified" : status === "conflict" ? "conflict" : "unknown",
					relatedActivityEnded: false
				});
			}
			if (fastPosixStop) {
				assertPrepared(request, prepared);
				const launch = request.payload.knownLaunchIdentity ? null : await read(location.launch, io);
				const stopped = await stopPosixNative(launch);
				if (stopped) return stopped;
			}
			if (owner) {
				const cancelled = await cancelBeforeLaunch(request, owner, io);
				if (cancelled && !prepared) return cancelled;
			}
			if (!prepared)
				return response(
					protocol,
					request,
					{ evidenceRefs: [location.state], cancellationPendingPreparation: true },
					"accepted",
					{
						executionState: "stop-requested",
						verificationState: "unknown",
						relatedActivityEnded: false
					}
				);
			const { p, manifest } = await checkPrepared(request, io),
				end = await read(p.end, io),
				launch = await read(p.launch, io);
			if (!end && fastPosixStop && launch) {
				const stopped = await stopPosixNative(launch);
				if (stopped) return stopped;
				return response(protocol, request, { evidenceRefs: [p.manifest] }, "waiting-verification", {
					executionState: "unknown", verificationState: "unknown", relatedActivityEnded: false
				});
			}
			let preparationLaunch = await read(join(p.state, "preparation-launch.json"), io),
				preparationEnd = await read(join(p.state, "preparation-end.json"), io);
			let preparationEnded =
				preparationEnd &&
				(preparationEnd.payload.notStarted === true ||
					preparationEnd.payload.end?.processTree?.verified === true);
			if (manifest.resultPreparation && !preparationEnded) {
				const preparationStopPath = join(p.state, "preparation-stop-intent.json");
				if (!(await read(preparationStopPath, io)))
					await put(
						preparationStopPath,
						Buffer.from(
							JSON.stringify({
								operationId: request.operationId,
								runId: request.runId,
								submissionIntentId: request.submissionIntentId,
								requestedAt: now()
							})
						),
						io
					);
				if (!preparationLaunch) {
					let claimed = false;
					try {
						await transport.mkdirExclusive(join(p.state, "preparation"), io);
						claimed = true;
					} catch (error) {
						if (
							error.code !== "WORK_DIRECTORY_EXISTS" &&
							!(
								error.code === "POSIX_CONTROL_FAILED" &&
								/File exists/.test(error.details?.stderr || "")
							)
						)
							throw error;
					}
					if (claimed) {
						preparationEnd = {
							...event(manifest, "operation.preparation-ended", 4, {
								operationId: manifest.resultPreparation.operationId,
								succeeded: false,
								cancelled: true,
								notStarted: true,
								code: "PREPARATION_CANCELLED_BEFORE_START"
							}),
							source: `es-stop:1.0.0:${request.runId}`
						};
						await put(
							join(p.state, "preparation-end.json"),
							Buffer.from(JSON.stringify(preparationEnd)),
							io
						);
						preparationEnded = true;
					}
				}
			}
			if (end && (!manifest.resultPreparation || preparationEnded))
				return response(
					protocol,
					request,
					{ endReceipt: end, preparationEnd, evidenceRefs: [p.end] },
					"completed",
					{
						executionState: "ended",
						endReason: end.payload.endReason,
						relatedActivityEnded: !preparingHere.has(request.runId),
						resultPreparation: preparationEnd ? "ended" : "unavailable"
					}
				);
			const stoppingPreparation = !!end,
				identity = stoppingPreparation
					? preparationLaunch?.payload.launch?.identity || preparationLaunch?.payload.identity
					: launch?.payload.identity,
				observed = await probe(identity, p.work, io);
			if (stoppingPreparation && observed.treeEnded === true)
				return response(
					protocol,
					request,
					{
						endReceipt: end,
						preparationLaunch,
						preparationObservation: observed,
						evidenceRefs: [p.end]
					},
					"completed",
					{
						executionState: "ended",
						relatedActivityEnded: true,
						resultPreparation: "ended-unverified"
					}
				);
			if (observed.status !== "alive")
				return response(
					protocol,
					request,
					{ observation: observed, evidenceRefs: [p.manifest] },
					"waiting-verification",
					{
						executionState: stoppingPreparation ? "ended" : "unknown",
						relatedActivityEnded: false,
						...(stoppingPreparation ? { resultPreparation: "unknown" } : {}),
						verificationState: observed.status === "conflict" ? "conflict" : "unknown"
					}
				);
			const stopPath = join(
					p.state,
					stoppingPreparation ? "preparation-stop-intent.json" : "stop-intent.json"
				),
				previous = await read(stopPath, io);
			if (!previous)
				await put(
					stopPath,
					Buffer.from(
						JSON.stringify({
							operationId: request.operationId,
							runId: request.runId,
							submissionIntentId: request.submissionIntentId,
							requestedAt: now()
						})
					),
					io
				);
			else if (
				previous.runId !== request.runId ||
				previous.submissionIntentId !== request.submissionIntentId
			)
				fail("STOP_IDENTITY_CONFLICT");
			if (platform === "win32") {
				if (!stopVerifiedProcessTree) fail("STOP_PROVIDER_UNAVAILABLE");
				const stopped = await stopVerifiedProcessTree(identity);
				if (stopped?.requested === false)
					return response(
						protocol,
						request,
						{ observation: stopped, evidenceRefs: [stopPath] },
						"waiting-verification",
						{
							executionState: stoppingPreparation ? "ended" : "stop-requested",
							relatedActivityEnded: false,
							resultPreparation: stoppingPreparation ? "stop-requested" : "pending"
						}
					);
			} else {
				const receipt = await transport.exec(
					{
						executable: "bash",
						args: ["-c", linuxProbeScript(identity, true)],
						cwd: p.work.path,
						env: {}
					},
					io
				);
				if (receipt.exitCode !== 0 || Buffer.from(receipt.stdout).toString("ascii") !== "requested")
					return response(protocol, request, { evidenceRefs: [stopPath] }, "waiting-verification", {
						executionState: "stop-requested",
						verificationState: "unknown"
					});
			}
			return response(
				protocol,
				request,
				{ evidenceRefs: [stopPath], stopRequested: true },
				"accepted",
				{
					executionState: stoppingPreparation ? "ended" : "stop-requested",
					verificationState: "verified",
					relatedActivityEnded: false,
					...(stoppingPreparation ? { resultPreparation: "stop-requested" } : {})
				}
			);
		},
		async prepareResult(request, io) {
			validate(protocol, request, "submit");
			const { p, manifest } = await checkPrepared(request, io);
			if (
				!manifest.resultPreparation ||
				manifest.resultPreparation.operationId !== request.operationId
			)
				fail("PREPARATION_OPERATION_MISMATCH");
			const inspected = await adapter.inspect({ ...request, action: "inspect" }, io);
			if (inspected.actualState.executionState !== "ended")
				return response(
					protocol,
					request,
					{ evidenceRefs: inspected.evidenceRefs, reason: "NATIVE_END_UNVERIFIED" },
					"waiting-verification",
					inspected.actualState
				);
			if (inspected.payload.preparationEnd)
				return response(
					protocol,
					request,
					{
						preparationEnd: inspected.payload.preparationEnd,
						evidenceRefs: inspected.evidenceRefs
					},
					"completed",
					inspected.actualState
				);
			if (
				inspected.payload.endReceipt?.payload.notStarted === true &&
				inspected.actualState.resultPreparation === "not-started"
			)
				return response(
					protocol,
					request,
					{ endReceipt: inspected.payload.endReceipt, evidenceRefs: inspected.evidenceRefs },
					"completed",
					inspected.actualState
				);
			if (
				inspected.payload.endReceipt?.eventType === "run.recovered-end" &&
				!(await read(join(p.state, "recovered-end.json"), io))
			)
				await put(
					join(p.state, "recovered-end.json"),
					Buffer.from(JSON.stringify(inspected.payload.endReceipt)),
					io
				);
			let persistentConnection = null;
			if (transport.kind === "wsl") {
				persistentConnection = await persistentHandoff(
					request,
					p,
					"prepare.sh",
					"preparation-runner-stdio.txt",
					io
				);
			} else if (platform === "win32") {
				if (!spawnDetached || !runtimeAssets?.executable || !runtimeAssets.runnerPath)
					fail("RUNNER_RUNTIME_UNAVAILABLE");
				await spawnDetached({
					executable: runtimeAssets.executable,
					args: [runtimeAssets.runnerPath, "--prepare", p.manifest],
					cwd: p.work.path,
					env: { ELECTRON_RUN_AS_NODE: "1" },
					stdio: "ignore",
					detached: true,
					windowsHide: true
				});
			} else {
				const result = await transport.exec(
					{
						executable: "bash",
						args: [
							"-c",
							`nohup setsid bash ${quote(join(p.state, "prepare.sh"))} </dev/null > ${quote(join(p.state, "preparation-runner-stdio.txt"))} 2>&1 &`
						],
						cwd: p.work.path,
						env: {}
					},
					io
				);
				if (result.exitCode !== 0) fail("PREPARATION_HANDOFF_UNVERIFIED");
			}
			return response(
				protocol,
				request,
				{
					evidenceRefs: [p.manifest, ...(persistentConnection?.evidenceRefs || [])],
					preparationIntentAccepted: true,
					...(persistentConnection ? { persistentConnection } : {})
				},
				"accepted",
				{ executionState: "ended", resultPreparation: "pending" }
			);
		},
		async collectArtifacts(request, io) {
			validate(protocol, request, "collectArtifacts");
			const p = paths(request);
			const results = [];
			for (const target of request.payload.files || []) {
				basename(target.name);
				const file = join(p.work.path, target.name);
				try {
					results.push({ ...target, identity: await transport.stat(file, io) });
				} catch (error) {
					results.push({ ...target, unavailable: true, code: error.code || "FILE_UNAVAILABLE" });
				}
			}
			return response(protocol, request, {
				files: results,
				evidenceRefs: results.filter((value) => value.identity).map((value) => value.identity.path)
			});
		}
	};
	return adapter;
}
module.exports = { createProcessAdapter };
