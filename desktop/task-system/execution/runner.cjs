"use strict";
/** Versioned headless owner. It never loads Electron UI, the task DB, or an application cleanup tree. */
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { claimIntent, readJson, writeReceipt } = require("./durable.cjs");
const { fail, basename } = require("./common.cjs");
const RUNNER_VERSION = "1.0.0";
const { monitorGaussianWindows, stableFile } = require("./gaussian-windows.cjs");
const { verifyExternalOutputs, releaseExternalOutputs } = require("./external-outputs.cjs");
async function verifyEntryIdentity(identity) {
	if (!identity?.fileId) return;
	const value = await fs.lstat(identity.path, { bigint: true });
	if (
		value.isSymbolicLink() ||
		!value.isFile() ||
		`${value.dev}:${value.ino}` !== identity.fileId ||
		Number(value.size) !== identity.byteSize ||
		`${value.mtimeNs}:${value.ctimeNs}` !== identity.changeToken
	)
		fail("EXECUTION_ENTRY_IDENTITY_CHANGED");
}
function event(manifest, type, sequence, payload) {
	return {
		protocolVersion: 1,
		eventId: `${manifest.submissionIntentId}:${type}:${sequence}`,
		receiptId: `${manifest.submissionIntentId}:${type}:${sequence}`,
		eventType: type,
		source: `es-runner:${RUNNER_VERSION}:${manifest.runId}`,
		sequence,
		occurredAt: new Date().toISOString(),
		payloadVersion: 1,
		taskId: manifest.taskId,
		runId: manifest.runId,
		submissionIntentId: manifest.submissionIntentId,
		operationId: payload.operationId || manifest.operationId,
		payload,
		evidenceRefs: [`${manifest.workLocation.path}#${type}:${sequence}`]
	};
}
async function runChild(command, identityProvider, onLaunch, spawnChild, context = {}) {
	const fileOwner = context.gaussianWindowsFilesOwner;
	if (context.calculationScript)
		command = require("../engines/calculation-script.cjs").windowsScriptCommand(
			command,
			context.calculationScript,
			context.calculationScriptIdentity
		);
	if (identityProvider.launch && !spawnChild) {
		const launch = await identityProvider.launch(command, context);
		await onLaunch({
			...launch,
			launchedAt: new Date().toISOString(),
			command,
			identityStatus: launch.identity ? "verified" : "unknown"
		});
		let nativeEnded = false;
		await fileOwner?.start(async () => !nativeEnded && (!identityProvider.probe || (await identityProvider.probe(launch.identity)).status === "alive"));
		if (command.lifecycle?.kind === "gaussian-windows-completion-modal-v1")
			return monitorGaussianWindows({
				command,
				launch,
				identityProvider,
				onManagedCleanupIntent: context.onManagedCleanupIntent
			});
		let processTree;
		try { processTree = await identityProvider.waitTreeEnded(launch.identity, { treeIdentity: launch.treeIdentity, command }); }
		catch (error) { nativeEnded = true; await fileOwner?.finish({processTree:{verified:false}}); throw error; }
		nativeEnded = true;
		const terminal = {
			exitCode: processTree.exitCode ?? null,
			signal: processTree.signal ?? null,
			endedAt: processTree.endedAt || new Date().toISOString(),
			processTree,
			error: null
		};
		if (fileOwner) { context.onNativeEnd?.(); terminal.gaussianWindowsFiles = await fileOwner.finish(terminal); }
		return terminal;
	}
	spawnChild ||= spawn;
	let stdin, stdout, stderr;
	try {
		stdin = command.stdinPath ? await fs.open(command.stdinPath, "r") : null;
		stdout = command.stdoutPath ? await fs.open(command.stdoutPath, "wx", 0o600) : null;
		stderr = command.stderrPath ? await fs.open(command.stderrPath, "wx", 0o600) : null;
		const child = spawnChild(command.executable, command.args, {
			cwd: command.cwd,
			env: { ...process.env, ...command.env },
			detached: true,
			windowsHide: true,
			shell: false,
			stdio: [stdin?.fd ?? "ignore", stdout?.fd ?? "ignore", stderr?.fd ?? "ignore"]
		});
		let nativeError, nativeEnded = false;
		const end = new Promise((resolve) => {
			child.once("error", (error) => {
				nativeError = { code: error.code || "SPAWN_FAILED" };
			});
			child.once("close", (exitCode, signal) => { nativeEnded=true; resolve({ exitCode, signal, error: nativeError || null, endedAt: new Date().toISOString() }); });
		});
		// Listener precedes awaits: short children may finish while identity probing is pending.
		const identity = child.pid
			? await identityProvider
					.inspect(child.pid, {
						cwd: command.cwd,
						executable: command.executable,
						args: command.args
					})
					.catch(() => null)
			: null;
		await onLaunch({
			pid: child.pid || null,
			identity,
			launchedAt: new Date().toISOString(),
			command,
			identityStatus: identity ? "verified" : "unknown"
		});
		await fileOwner?.start(async () => !nativeEnded && (!identityProvider.probe || (await identityProvider.probe(identity)).status === "alive"));
		const terminal = await end;
		const processTree =
			!child.pid && terminal.error
				? { verified: true, reason: "Spawn failed before a native PID existed" }
				: identityProvider.waitTreeEnded
					? await identityProvider
							.waitTreeEnded(identity, { primaryEnded: terminal, command })
							.catch(() => ({ verified: false }))
					: { verified: false, reason: "Tree termination provider unavailable" };
		const complete = { ...terminal, processTree };
		if (fileOwner) { context.onNativeEnd?.(); complete.gaussianWindowsFiles = await fileOwner.finish(complete); }
		return complete;
	} finally {
		await Promise.all([stdin?.close(), stdout?.close(), stderr?.close()]);
	}
}
async function stableCopy(sourcePath, destination) {
	const before = await fs.lstat(sourcePath);
	if (!before.isFile() || before.isSymbolicLink()) fail("PREPARATION_SOURCE_NOT_FILE");
	await fs.copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
	const sourceHash = await hashFile(sourcePath),
		copyHash = await hashFile(destination),
		after = await fs.stat(sourcePath);
	if (
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs
	)
		fail("PREPARATION_SOURCE_CHANGED");
	if (sourceHash !== copyHash) fail("PREPARATION_COPY_MISMATCH");
	const handle = await fs.open(destination, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	return { sha256: sourceHash, byteSize: after.size, sourcePath, copyPath: destination };
}
async function hashFile(file) {
	const digest = crypto.createHash("sha256"),
		handle = await fs.open(file, "r");
	try {
		for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
		return digest.digest("hex");
	} finally {
		await handle.close();
	}
}
async function runManifest(manifest, { identityProvider, spawnChild } = {}) {
	if (
		manifest.protocolVersion !== 1 ||
		manifest.runnerVersion !== RUNNER_VERSION ||
		!manifest.submissionIntentId ||
		!manifest.runId ||
		!manifest.operationId ||
		!path.isAbsolute(manifest.workLocation?.path) ||
		manifest.command.cwd !== manifest.workLocation.path
	)
		fail("INVALID_RUNNER_MANIFEST");
	identityProvider ||= manifest.identityModulePath ? require(manifest.identityModulePath) : null;
	if (!identityProvider?.inspect) fail("IDENTITY_PROVIDER_REQUIRED");
	const directory = path.join(manifest.workLocation.path, ".es-execution");
	const claim = await claimIntent(directory, manifest);
	if (claim.cancelled) {
		const existing = await readJson(path.join(directory, "end.json"));
		if (existing) return existing;
		const cancelled = event(manifest, "run.ended", 2, {
			notStarted: true,
			exitCode: null,
			signal: null,
			endReason: "stopped",
			processTree: { verified: true, notStarted: true }
		});
		await writeReceipt(directory, "end.json", cancelled);
		return cancelled;
	}
	if (!claim.claimed)
		return {
			alreadyClaimed: true,
			launch: await readJson(path.join(directory, "launch.json")),
			end: await readJson(path.join(directory, "end.json"))
		};
	await writeReceipt(
		directory,
		"runner.json",
		event(manifest, "run.executor", 0, {
			runnerVersion: RUNNER_VERSION,
			manifestHash: claim.digest,
			identity: await identityProvider
				.inspect(process.pid, {
					cwd: process.cwd(),
					executable: process.execPath,
					args: process.argv.slice(1)
				})
				.catch(() => null)
		})
	);
	let terminal,
		gaussianWindowsFilesOwner = null,
		monotonicLaunchedAt = null,
		monotonicNativeEndedAt = null,
		nativeLaunchAttempted = false;
	try {
		await verifyExternalOutputs(manifest);
		if (manifest.softwareIdentity) {
			for (const member of [manifest.softwareIdentity.entry, ...manifest.softwareIdentity.members])
				await verifyEntryIdentity(member);
		}
		for (const input of manifest.inputFiles || []) {
			const file = path.join(manifest.workLocation.path, basename(input.name)),
				info = await fs.lstat(file);
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				info.size !== input.byteSize ||
				(await hashFile(file)) !== input.sha256
			)
				fail("PREPARED_INPUT_CHANGED");
		}
		if (manifest.command.lifecycle?.installationIni) {
			const ini = manifest.command.lifecycle.installationIni,
				current = await stableFile(ini.path, { hash: true });
			if (
				current.sha256 !== ini.sha256 ||
				current.identity.fileId !== ini.identity.fileId ||
				current.identity.changeToken !== ini.identity.changeToken
			)
				fail("GAUSSIAN_WINDOWS_INI_CHANGED");
		}
		if (manifest.gaussianWindowsFiles) {
			gaussianWindowsFilesOwner = await require("../engines/gaussian-windows-files.cjs").createGaussianWindowsFilesOwner(manifest);
			if (await readJson(path.join(directory,"stop-intent.json"))) {
				await gaussianWindowsFilesOwner.cancelBeforeLaunch();
				const cancelled = event(manifest,"run.ended",2,{notStarted:true,exitCode:null,signal:null,endReason:"stopped",processTree:{verified:true,notStarted:true,activeProcesses:0}});
				await writeReceipt(directory,"end.json",cancelled); await runPreparation(manifest,{identityProvider,spawnChild}); return cancelled;
			}
		}
		await gaussianWindowsFilesOwner?.assertOwned();
		nativeLaunchAttempted = true;
		terminal = await runChild(
			manifest.command,
			identityProvider,
			(launch) => {
				monotonicLaunchedAt = performance.now();
				return writeReceipt(directory, "launch.json", event(manifest, "run.launched", 1, launch));
			},
			spawnChild,
			{
				gaussianWindowsFilesOwner,
				onNativeEnd: () => { monotonicNativeEndedAt = performance.now(); },
				calculationScript: manifest.calculationScript,
				calculationScriptIdentity: manifest.calculationScriptIdentity,
				runId: manifest.runId,
				intentId: manifest.submissionIntentId,
				onManagedCleanupIntent: async (intent) => {
					const file = path.join(directory, "gaussian-owner-cleanup-intent.json"),
						existing = await readJson(file);
					if (existing) {
						if (
							existing.runId !== manifest.runId ||
							existing.submissionIntentId !== manifest.submissionIntentId ||
							existing.payload.identity.native.jobName !== intent.identity.native.jobName ||
							existing.payload.outcome !== intent.outcome
						)
							fail("GAUSSIAN_OWNER_CLEANUP_CONFLICT");
						return existing.payload;
					}
					const receipt = {
						...event(manifest, "run.owner-cleanup-intent", 1, intent),
						source: `es-gaussian-windows-owner:${manifest.runId}`
					};
					await writeReceipt(directory, "gaussian-owner-cleanup-intent.json", receipt);
					return intent;
				}
			}
		);
		if (monotonicLaunchedAt !== null) terminal.runtimeTiming = { kind: "runner-monotonic-v1", clockDomain: "runner:" + manifest.runId, elapsedSeconds: Math.max(0, ((monotonicNativeEndedAt ?? performance.now()) - monotonicLaunchedAt) / 1000) };
		await gaussianWindowsFilesOwner?.assertOwned();
	} catch (error) {
		await gaussianWindowsFilesOwner?.finish({processTree:{verified:false}}).catch(()=>{});
		let owned=true;try{await gaussianWindowsFilesOwner?.assertOwned();if(manifest.gaussianWindowsFiles){const identity=await fs.lstat(manifest.workLocation.path,{bigint:true});if(identity.isSymbolicLink()||`${identity.dev}:${identity.ino}`!==manifest.workIdentity?.fileId)owned=false;}}catch{owned=false;}
		if(owned) await writeReceipt(
			directory,
			"runner-error.json",
			event(manifest, "run.verification-required", 2, {
				code: error.code || "RUNNER_FAILED",
				notStarted: !nativeLaunchAttempted,
				reason: "Launch or receipt could not be completed; inspect original intent"
			})
		);
		if (!nativeLaunchAttempted) await releaseExternalOutputs(manifest);
		throw error;
	}
	const stop = await readJson(path.join(directory, "stop-intent.json"));
	const receipt = event(manifest, "run.ended", 2, {
		...terminal,
		endReason: stop
			? "stopped"
			: terminal.executionEndReason
				? terminal.executionEndReason
				: terminal.exitCode === null && !terminal.error
					? "unknown"
					: terminal.error || terminal.exitCode !== 0
						? "failed"
						: "completed",
		stopOperationId: stop?.operationId || null
	});
	if (terminal.processTree?.verified !== true) {
		const uncertain = event(manifest, "run.primary-ended", 2, {
			...terminal,
			reason: "PROCESS_TREE_END_UNVERIFIED"
		});
		await writeReceipt(directory, "primary-end.json", uncertain);
		return uncertain;
	}
	await writeReceipt(directory, "end.json", receipt);
	// This is an independent, pre-authorized operation. It never changes the native end receipt.
	await runPreparation(manifest, { identityProvider, spawnChild });
	if (!manifest.resultPreparation || (await readJson(path.join(directory, "preparation-end.json"))))
		await writeReceipt(directory, "external-output-release.json", {
			runId: manifest.runId,
			submissionIntentId: manifest.submissionIntentId,
			checkedAt: new Date().toISOString(),
			results: await releaseExternalOutputs(manifest)
		});
	return receipt;
}
async function runPreparation(manifest, { identityProvider, spawnChild } = {}) {
	identityProvider ||= manifest.identityModulePath ? require(manifest.identityModulePath) : null;
	if (!identityProvider?.inspect) fail("IDENTITY_PROVIDER_REQUIRED");
	const directory = path.join(manifest.workLocation.path, ".es-execution");
	const nativeEnd =
		(await readJson(path.join(directory, "end.json"))) ||
		(await readJson(path.join(directory, "recovered-end.json")));
	if (
		!nativeEnd ||
		nativeEnd.runId !== manifest.runId ||
		nativeEnd.submissionIntentId !== manifest.submissionIntentId ||
		!(
			nativeEnd.payload.processTree?.verified === true ||
			nativeEnd.payload.processTree?.treeEnded === true
		)
	)
		fail("NATIVE_END_UNVERIFIED");
	const preparation = manifest.resultPreparation;
	if (preparation) {
		const preparationDirectory = path.join(directory, "preparation");
		let preparationAttempted = false,
			preparationTerminal = null,
			preparedSource = null;
		try {
			if (
				!preparation.operationId ||
				!preparation.toolIdentity ||
				!preparation.sourceArtifactId ||
				preparation.compatibleWithRun !== true
			)
				fail("PREPARATION_UNVERIFIED");
			await fs.mkdir(preparationDirectory, { mode: 0o700 });
			const cancelled = async () => {
				if (
					nativeEnd.payload.notStarted !== true &&
					!(await readJson(path.join(directory, "preparation-stop-intent.json")))
				)
					return false;
				await writeReceipt(
					directory,
					"preparation-end.json",
					event(manifest, "operation.preparation-ended", 4, {
						operationId: preparation.operationId,
						succeeded: false,
						cancelled: true,
						notStarted: true,
						code: "PREPARATION_CANCELLED_BEFORE_START"
					})
				);
				return true;
			};
			if (await cancelled()) return readJson(path.join(directory, "preparation-end.json"));
			if (manifest.gaussianWindowsFiles) {
				const publication = nativeEnd.payload.gaussianWindowsFiles;
				const source = publication?.outputs?.find(row=>row.root===preparation.sourcePath && row.published===true && row.scratchAliasReleased===true);
				if (!publication || publication.failure || !source) fail("GAUSSIAN_CHECKPOINT_NOT_PUBLISHED");
			}
			await verifyEntryIdentity(preparation.toolIdentity.entryIdentity);
			const sourceName = basename(
					preparation.sourceCopyName || path.basename(preparation.sourcePath)
				),
				sourceCopy = path.join(preparationDirectory, sourceName);
			const source = await stableCopy(preparation.sourcePath, sourceCopy);
			preparedSource = source;
			if (manifest.gaussianWindowsFiles) {
				const mapped=nativeEnd.payload.gaussianWindowsFiles.outputs.find(row=>row.root===preparation.sourcePath),identity=await fs.lstat(preparation.sourcePath,{bigint:true});
				if(mapped.sha256!==source.sha256||mapped.byteSize!==source.byteSize||mapped.fileId!==`${identity.dev}:${identity.ino}`)fail("PREPARATION_SOURCE_IDENTITY_CONFLICT");
			}
			const checkpoint = nativeEnd.payload.managedLauncherCleanup?.observations
				?.at(-1)
				?.files?.checkpoints?.find((value) => value.identity.path === preparation.sourcePath);
			if (checkpoint && checkpoint.sha256 !== source.sha256)
				fail("PREPARATION_SOURCE_IDENTITY_CONFLICT");
			const replacements = {
				"{source}": sourceCopy,
				"{sourceBase}": sourceCopy.replace(/\.[^.]+$/, ""),
				"{output}": path.join(preparationDirectory, basename(preparation.outputName))
			};
			const command = {
				...preparation.command,
				cwd: preparationDirectory,
				args: preparation.command.args.map((value) => replacements[value] || value),
				stdoutPath: path.join(preparationDirectory, "conversion-stdout.txt"),
				stderrPath: path.join(preparationDirectory, "conversion-stderr.txt")
			};
			if (await cancelled()) return readJson(path.join(directory, "preparation-end.json"));
			preparationAttempted = true;
			const end = await runChild(
				command,
				identityProvider,
				(launch) =>
					writeReceipt(
						directory,
						"preparation-launch.json",
						event(manifest, "operation.preparation-launched", 3, {
							operationId: preparation.operationId,
							source,
							toolIdentity: preparation.toolIdentity,
							launch
						})
					),
				spawnChild,
				{ runId: manifest.runId, intentId: `${manifest.submissionIntentId}:preparation` }
			);
			preparationTerminal = end;
			if (end.processTree?.verified !== true) {
				await writeReceipt(
					directory,
					"preparation-primary-end.json",
					event(manifest, "operation.preparation-verification-required", 4, {
						operationId: preparation.operationId,
						end,
						reason: "PREPARATION_TREE_END_UNVERIFIED"
					})
				);
				return null;
			}
			if (await hashFile(preparation.sourcePath) !== source.sha256) fail("PREPARATION_SOURCE_CHANGED_DURING_CONVERSION");
			let output = null;
			if (end.exitCode === 0 && !end.error && end.processTree?.verified === true) {
				const stat = await fs.stat(replacements["{output}"]);
				let outputPath = replacements["{output}"];
				if (manifest.fileLayout === "task-relative-v1") {
					const target = path.join(manifest.workLocation.path, basename(preparation.outputName));
					await fs.copyFile(outputPath, target, constants.COPYFILE_EXCL);
					if (await hashFile(target) !== await hashFile(outputPath)) fail("PREPARATION_OUTPUT_COPY_CHANGED");
					outputPath = target;
				}
				output = {
					path: outputPath,
					sha256: await hashFile(outputPath),
					byteSize: stat.size
				};
			}
			await writeReceipt(
				directory,
				"preparation-end.json",
				event(manifest, "operation.preparation-ended", 4, {
					operationId: preparation.operationId,
					source,
					end,
					output,
					toolIdentity: preparation.toolIdentity,
					succeeded: !!output && output.byteSize > 0
				})
			);
		} catch (error) {
			if (error.code === "EEXIST") return readJson(path.join(directory, "preparation-end.json"));
			if (preparationAttempted && preparationTerminal?.processTree?.verified !== true) {
				await writeReceipt(
					directory,
					"preparation-primary-end.json",
					event(manifest, "operation.preparation-verification-required", 4, {
						operationId: preparation.operationId,
						code: error.code || "PREPARATION_OUTCOME_UNVERIFIED",
						reason: "Preparation launch/end receipt is uncertain; inspect the original owner"
					})
				);
				return null;
			}
			await writeReceipt(
				directory,
				"preparation-end.json",
				event(manifest, "operation.preparation-ended", 4, {
					operationId: preparation.operationId,
					succeeded: false,
					notStarted: !preparationAttempted,
					source: preparedSource,
					end: preparationTerminal,
					toolIdentity: preparation.toolIdentity,
					code: error.code || "PREPARATION_FAILED"
				})
			);
		}
	}
	return readJson(path.join(directory, "preparation-end.json"));
}
if (require.main === module) {
	const preparationOnly = process.argv[2] === "--prepare";
	readJson(process.argv[preparationOnly ? 3 : 2])
		.then((manifest) => (preparationOnly ? runPreparation(manifest) : runManifest(manifest)))
		.then(
			() => {},
			() => {
				process.exitCode = 1;
			}
		);
}
module.exports = { RUNNER_VERSION, runManifest, runPreparation, runChild, stableCopy, event };
