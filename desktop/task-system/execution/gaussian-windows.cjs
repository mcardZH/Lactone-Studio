"use strict";
const fs = require("node:fs/promises"),
	crypto = require("node:crypto");
const { fail } = require("./common.cjs");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function stableFile(file, { hash = false, tail = false } = {}) {
	const before = await fs.lstat(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink()) fail("GAUSSIAN_WINDOWS_SOURCE_NOT_REGULAR");
	const identity = {
			path: file,
			fileId: `${before.dev}:${before.ino}`,
			byteSize: Number(before.size),
			modifiedAt: before.mtime.toISOString(),
			changeToken: `${before.mtimeNs}:${before.ctimeNs}`
		},
		handle = await fs.open(file, "r");
	let digest = null,
		text = null;
	try {
		if (hash) {
			const result = crypto.createHash("sha256");
			for await (const chunk of handle.createReadStream({ autoClose: false })) result.update(chunk);
			digest = result.digest("hex");
		}
		if (tail) {
			const start = Math.max(0, Number(before.size) - 262144),
				bytes = Buffer.alloc(Number(before.size) - start),
				read = await handle.read(bytes, 0, bytes.length, start);
			text = bytes.subarray(0, read.bytesRead).toString("latin1");
		}
	} finally {
		await handle.close();
	}
	const after = await fs.lstat(file, { bigint: true });
	if (
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	)
		fail("GAUSSIAN_WINDOWS_SOURCE_CHANGING");
	return { identity, sha256: digest, text };
}
async function observeGaussianFiles(lifecycle) {
	const output = await stableFile(lifecycle.primaryOutputPath, { tail: true }),
		normal = [
			...output.text.matchAll(/(?:^|\n)\s*Normal termination of Gaussian[^\r\n]*\r?\n/g)
		].at(-1),
		error = [...output.text.matchAll(/(?:^|\n)\s*Error termination[^\r\n]*\r?\n/g)].at(-1);
	const outcome =
			normal && (!error || normal.index > error.index) ? "completed" : error ? "failed" : null,
		checkpoints = [];
	if (outcome === "completed")
		for (const file of lifecycle.checkpointPaths || []) {
			const value = await stableFile(file, { hash: true });
			if (!value.identity.byteSize) fail("GAUSSIAN_WINDOWS_CHECKPOINT_EMPTY");
			checkpoints.push(value);
		}
	return {
		output: {
			identity: output.identity,
			normalLine: normal?.[0]?.trim() || null,
			errorLine: error?.[0]?.trim() || null
		},
		checkpoints,
		outcome
	};
}
/** Completion of the calculation and lifetime of G16W's GUI owner are separate facts. */
async function monitorGaussianWindows({
	command,
	launch,
	identityProvider,
	onManagedCleanupIntent,
	observeFiles = observeGaussianFiles,
	wait = delay,
	pollMs = 1000,
	signal
}) {
	const lifecycle = command.lifecycle;
	if (
		lifecycle?.kind !== "gaussian-windows-completion-modal-v1" ||
		!identityProvider.inspectOwnedWindows ||
		!onManagedCleanupIntent
	)
		fail("GAUSSIAN_WINDOWS_LIFECYCLE_UNAVAILABLE");
	let previous = null;
	for (;;) {
		if (signal?.aborted)
			return {
				exitCode: null,
				signal: null,
				processTree: { verified: false, reason: "OWNER_OBSERVER_CANCELLED" },
				error: null
			};
		const state = await identityProvider.probe(launch.identity);
		if (state.status === "dead" && state.treeEnded === true) {
			const tree = await identityProvider.waitTreeEnded(launch.identity);
			let files = null;
			try {
				files = await observeFiles(lifecycle);
			} catch {}
			return {
				exitCode: tree.exitCode ?? null,
				signal: null,
				endedAt: tree.endedAt || null,
				processTree: tree,
				error: null,
				naturalOwnerExit: null,
				executionEndReason: files?.outcome || (tree.exitCode === 0 ? "unknown" : "failed")
			};
		}
		if (state.status === "conflict")
			return {
				exitCode: null,
				signal: null,
				processTree: { verified: false, reason: "OWNER_IDENTITY_CONFLICT", evidence: state },
				error: null
			};
		const owned = lifecycle.scriptNativeExecutable
			? ((await identityProvider.inspectNativeWindows?.(
					launch.identity,
					lifecycle.scriptNativeExecutable
				)) ?? { status: "unknown", reason: "SCRIPT_NATIVE_OBSERVER_UNAVAILABLE" })
			: await identityProvider.inspectOwnedWindows(launch.identity);
		const rootOnly =
			owned.status === "alive" &&
			owned.identityMatched === true &&
			owned.jobMembershipVerified === true &&
			(lifecycle.scriptNativeExecutable ? owned.nativeOnly === true : owned.rootOnly === true);
		let files = null;
		try {
			files = await observeFiles(lifecycle);
		} catch (error) {
			if (
				![
					"ENOENT",
					"GAUSSIAN_WINDOWS_SOURCE_CHANGING",
					"GAUSSIAN_WINDOWS_CHECKPOINT_EMPTY"
				].includes(error.code)
			)
				files = { outcome: null, observationError: error.code || "SOURCE_UNAVAILABLE" };
		}
		const rawModal = (owned.windows || [])
				.flatMap((window) => window.staticLabels || [])
				.join("\n"),
			fatalModal =
				/GetNewArg|wsystem|\bError\s*#?\s*\d+|missing[^\n]*double quote|错误\s*[#：:]?\s*\d+/i.test(
					rawModal
				),
			outcome = files?.outcome || (fatalModal ? "failed" : null);
		if (rootOnly && outcome) {
			const signature = JSON.stringify({
				outcome,
				output: files?.output || null,
				checkpoints: files?.checkpoints || [],
				modal: outcome === "failed" ? rawModal : null
			});
			const observation = {
				checkedAt: owned.checkedAt || new Date().toISOString(),
				owner: owned,
				files,
				rawModal: outcome === "failed" ? rawModal : null,
				outcome
			};
			if (previous?.signature === signature) {
				const intent = await onManagedCleanupIntent({
					kind: "gaussian-windows-owner-cleanup",
					outcome,
					naturalOwnerExit: false,
					identity: launch.identity,
					observations: [previous.observation, observation]
				});
				const requested = await identityProvider.stop(launch.identity);
				if (requested?.requested !== true)
					return {
						exitCode: null,
						signal: null,
						error: null,
						processTree: {
							verified: false,
							reason: "OWNER_CLEANUP_REQUEST_UNVERIFIED",
							evidence: requested
						},
						managedLauncherCleanup: intent
					};
				const tree = await identityProvider.waitTreeEnded(launch.identity);
				return {
					exitCode: tree.exitCode ?? null,
					signal: null,
					endedAt: tree.endedAt || null,
					error: null,
					processTree: tree,
					naturalOwnerExit: false,
					executionEndReason: outcome,
					managedLauncherCleanup: intent
				};
			}
			previous = { signature, observation };
		} else previous = null;
		await wait(pollMs);
	}
}
module.exports = { stableFile, observeGaussianFiles, monitorGaussianWindows };
