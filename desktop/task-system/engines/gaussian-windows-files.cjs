"use strict";
const fs = require("node:fs"),
	fsp = fs.promises,
	path = require("node:path"),
	crypto = require("node:crypto"),
	{ isDeepStrictEqual } = require("node:util");
const { fail } = require("../execution/common.cjs");
const KIND = "gaussian-windows-scratch-v1";
const safeName = (name) => {
	if (
		typeof name !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ||
		name.endsWith(".") ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	)
		fail("GAUSSIAN_WINDOWS_CHECKPOINT_NAME_UNSUPPORTED", { name });
	return name;
};
function planGaussianWindowsFiles({ inputSnapshot, workLocation, scratch }) {
	if (
		!scratch ||
		path.win32.resolve(path.win32.dirname(scratch.path)).toLowerCase() !==
			path.win32.resolve(workLocation.path).toLowerCase() ||
		path.win32.basename(scratch.path) !== "scratch"
	)
		fail("GAUSSIAN_WINDOWS_OWNED_SCRATCH_REQUIRED");
	const outputs = new Map(),
		inputs = new Map(),
		previous = new Set();
	for (const [jobIndex, job] of (inputSnapshot.parsedRequests?.jobs || []).entries()) {
		const references = job.dependencyReferences || [],
			names = (directive) => [
				...new Set(
					references
						.filter((ref) => String(ref.directive).toLowerCase() === directive)
						.map((ref) => safeName(ref.name))
				)
			];
		const checkpoints = names("chk"),
			old = names("oldchk");
		if (checkpoints.length > 1 || old.length > 1)
			fail("GAUSSIAN_WINDOWS_CHECKPOINT_DECLARATIONS_CONFLICT", { jobIndex, checkpoints, old });
		if (old.length && checkpoints.length && old[0].toLowerCase() === checkpoints[0].toLowerCase())
			fail("GAUSSIAN_WINDOWS_OLDCHK_SELF_COPY_UNVERIFIED", { jobIndex, name: old[0] });
		const reads = [
			...old,
			...(references.some((ref) => ref.kind === "checkpoint-read") && !old.length
				? checkpoints
				: [])
		];
		for (const name of reads) {
			const key = name.toLowerCase();
			if (previous.has(key)) continue;
			const candidates = (inputSnapshot.dependencies || []).filter(
				(dep) =>
					String(
						dep.preparedName || path.win32.basename(dep.preparedLocation?.path || "")
					).toLowerCase() === key
			);
			if (
				candidates.length !== 1 ||
				candidates[0].integrity !== "complete" ||
				!/^[a-f0-9]{64}$/.test(candidates[0].contentIdentity?.hash || "")
			)
				fail("GAUSSIAN_WINDOWS_CHECKPOINT_DEPENDENCY_UNVERIFIED", { jobIndex, name });
			const current = inputs.get(key),
				sha256 = candidates[0].contentIdentity.hash;
			if (current && current.sha256 !== sha256)
				fail("GAUSSIAN_WINDOWS_CHECKPOINT_DEPENDENCY_CONFLICT", { jobIndex, name });
			inputs.set(key, { name, sha256 });
		}
		for (const name of checkpoints) {
			const key = name.toLowerCase();
			if (!outputs.has(key)) outputs.set(key, { name });
			previous.add(key);
		}
	}
	return {
		kind: KIND,
		version: 1,
		workPath: workLocation.path,
		scratchPath: scratch.path,
		inputSnapshotId: inputSnapshot.inputSnapshotId,
		checkpoints: [...outputs.values()],
		inputs: [...inputs].map(([key, value]) => ({ ...value, writes: outputs.has(key) }))
	};
}
function fileId(info) {
	return `${info.dev}:${info.ino}`;
}
async function checked(file, directory = false) {
	let node = path.resolve(file);
	for (;;) {
		const info = await fsp.lstat(node);
		if (info.isSymbolicLink()) fail("GAUSSIAN_WINDOWS_PATH_LINK_REFUSED", { path: node });
		const parent = path.dirname(node);
		if (parent === node) break;
		node = parent;
	}
	const value = await fsp.lstat(file, { bigint: true });
	if (directory ? !value.isDirectory() : !value.isFile())
		fail("GAUSSIAN_WINDOWS_FILE_KIND_CHANGED", { path: file });
	return value;
}
async function absent(file) {
	try {
		await fsp.lstat(file);
		return false;
	} catch (error) {
		if (error.code === "ENOENT") return true;
		throw error;
	}
}
async function digest(file) {
	const before = await checked(file),
		hash = crypto.createHash("sha256"),
		handle = await fsp.open(file, "r");
	try {
		for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
	} finally {
		await handle.close();
	}
	const after = await checked(file);
	if (
		fileId(before) !== fileId(after) ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	)
		fail("GAUSSIAN_WINDOWS_FILE_CHANGED", { path: file });
	return {
		sha256: hash.digest("hex"),
		byteSize: Number(after.size),
		fileId: fileId(after),
		changeToken: `${after.mtimeNs}:${after.ctimeNs}`
	};
}
async function createGaussianWindowsFilesOwner(manifest, { pollMs = 25 } = {}) {
	const plan = manifest.gaussianWindowsFiles;
	if (!plan) return null;
	if (
		process.platform !== "win32" ||
		plan.kind !== KIND ||
		plan.version !== 1 ||
		plan.workPath !== manifest.workLocation.path ||
		plan.scratchPath !== manifest.scratch?.path ||
		path.win32.join(plan.workPath, "scratch") !== plan.scratchPath
	)
		fail("GAUSSIAN_WINDOWS_FILE_CONTRACT_INVALID");
	const work = plan.workPath,
		scratch = plan.scratchPath,
		state = path.join(work, ".es-execution"),
		rootIdentity = await checked(work, true),
		scratchIdentity = await checked(scratch, true);
	if (
		fileId(rootIdentity) !== manifest.workIdentity?.fileId ||
		fileId(scratchIdentity) !== manifest.scratch.identity?.fileId ||
		rootIdentity.dev !== scratchIdentity.dev
	)
		fail("GAUSSIAN_WINDOWS_DIRECTORY_IDENTITY_CHANGED");
	await checked(state, true);
	const markerPath = path.join(scratch, ".es-scratch-owner.json"),
		marker = await digest(markerPath),
		owner = JSON.parse(await fsp.readFile(markerPath, "utf8"));
	if (
		marker.fileId !== manifest.scratch.ownerMarker?.identity?.fileId ||
		marker.sha256 !== manifest.scratch.ownerMarker?.sha256 ||
		marker.changeToken !== manifest.scratch.ownerMarker?.identity?.changeToken ||
		owner.taskId !== manifest.taskId ||
		owner.runId !== manifest.runId ||
		owner.submissionIntentId !== manifest.submissionIntentId ||
		owner.inputSnapshotId !== plan.inputSnapshotId ||
		!isDeepStrictEqual(owner.inputContentIdentity, manifest.scratch.inputContentIdentity) ||
		!isDeepStrictEqual(owner.workLocation, manifest.workLocation) ||
		owner.scratchLocation?.path !== scratch
	)
		fail("GAUSSIAN_WINDOWS_SCRATCH_OWNER_CHANGED");
	const locationOwner = JSON.parse(
		await fsp.readFile(path.join(state, "location-owner.json"), "utf8")
	);
	if (
		locationOwner.taskId !== manifest.taskId ||
		locationOwner.runId !== manifest.runId ||
		locationOwner.submissionIntentId !== manifest.submissionIntentId ||
		!isDeepStrictEqual(locationOwner.workLocation, manifest.workLocation)
	)
		fail("GAUSSIAN_WINDOWS_WORK_OWNER_CHANGED");
	const records = new Map(),
		inputProofs = [],
		diagnostics = [];
	let watcher,
		timer,
		active = false,
		closed = false,
		queued = false,
		chain = Promise.resolve(),
		isAlive = async () => false,
		failure = null,
		finalResult = null;
	const guard = async () => {
		if (
			fileId(await checked(work, true)) !== fileId(rootIdentity) ||
			fileId(await checked(scratch, true)) !== fileId(scratchIdentity)
		)
			fail("GAUSSIAN_WINDOWS_DIRECTORY_IDENTITY_CHANGED");
		const current = await digest(markerPath);
		if (
			current.fileId !== marker.fileId ||
			current.sha256 !== marker.sha256 ||
			current.changeToken !== marker.changeToken
		)
			fail("GAUSSIAN_WINDOWS_SCRATCH_OWNER_CHANGED");
	};
	const paths = (name) => ({
		root: path.join(work, safeName(name)),
		alias: path.join(scratch, name)
	});
	const rememberFailure = (error) => {
		const value = {
			code: error.code || "GAUSSIAN_WINDOWS_FILE_PUBLICATION_FAILED",
			message: String(error.message),
			details: error.details || error.detail || null
		};
		failure ||= value;
		if (diagnostics.length < 128) diagnostics.push(value);
	};
	// Actual same-volume capability probe. Neither probe name is a checkpoint.
	const probeName = ".es-hardlink-probe-" + crypto.randomUUID(),
		probe = { root: path.join(work, probeName), alias: path.join(scratch, probeName) },
		bytes = crypto.randomBytes(32);
	let probeId;
	try {
		await fsp.writeFile(probe.alias, bytes, { flag: "wx" });
		probeId = fileId(await checked(probe.alias));
		await fsp.link(probe.alias, probe.root);
		if (
			fileId(await checked(probe.root)) !== probeId ||
			fileId(await checked(probe.alias)) !== probeId
		)
			fail("GAUSSIAN_WINDOWS_HARDLINK_UNVERIFIED");
	} catch (error) {
		fail("GAUSSIAN_WINDOWS_HARDLINK_UNAVAILABLE", { cause: error.code || String(error) });
	} finally {
		for (const file of [probe.root, probe.alias])
			if (!(await absent(file))) {
				const info = await checked(file);
				if (
					!probeId ||
					fileId(info) !== probeId ||
					!Buffer.from(await fsp.readFile(file)).equals(bytes)
				)
					fail("GAUSSIAN_WINDOWS_PROBE_IDENTITY_CHANGED", { path: file });
				await fsp.unlink(file);
			}
	}
	await guard();
	for (const name of [
		...plan.checkpoints.map((row) => row.name),
		...plan.inputs.map((row) => row.name)
	])
		safeName(name);
	for (const row of plan.checkpoints) {
		const p = paths(row.name);
		if (
			!plan.inputs.some((input) => input.name.toLowerCase() === row.name.toLowerCase()) &&
			!(await absent(p.root))
		)
			fail("GAUSSIAN_WINDOWS_CHECKPOINT_COLLISION", { path: p.root });
		if (!(await absent(p.alias))) fail("GAUSSIAN_WINDOWS_CHECKPOINT_COLLISION", { path: p.alias });
	}
	for (const input of plan.inputs) {
		const p = paths(input.name),
			prepared = (manifest.inputFiles || []).filter(
				(file) => file.name.toLowerCase() === input.name.toLowerCase()
			);
		if (prepared.length !== 1 || prepared[0].sha256 !== input.sha256)
			fail("GAUSSIAN_WINDOWS_CHECKPOINT_DEPENDENCY_UNVERIFIED", { name: input.name });
		const identity = await checked(p.root),
			proof = await digest(p.root);
		if (
			identity.nlink !== 1n ||
			proof.byteSize <= 0 ||
			proof.sha256 !== input.sha256 ||
			proof.byteSize !== prepared[0].byteSize
		)
			fail("GAUSSIAN_WINDOWS_CHECKPOINT_DEPENDENCY_CHANGED", { name: input.name });
		if (!(await absent(p.alias))) fail("GAUSSIAN_WINDOWS_CHECKPOINT_COLLISION", { path: p.alias });
		await fsp.link(p.root, p.alias);
		if (fileId(await checked(p.alias)) !== proof.fileId)
			fail("GAUSSIAN_WINDOWS_HARDLINK_UNVERIFIED");
		inputProofs.push({ ...input, ...p, ...proof });
		if (input.writes)
			records.set(input.name.toLowerCase(), {
				name: input.name,
				...p,
				fileId: proof.fileId,
				input: true,
				published: true,
				preparedSha256: proof.sha256,
				preparedMtimeNs: identity.mtimeNs.toString()
			});
	}
	const preflight = {
		kind: KIND,
		runId: manifest.runId,
		submissionIntentId: manifest.submissionIntentId,
		rootFileId: fileId(rootIdentity),
		scratchFileId: fileId(scratchIdentity),
		inputProofs
	};
	await fsp.writeFile(
		path.join(state, "gaussian-windows-files-preflight.json"),
		JSON.stringify(preflight),
		{ flag: "wx" }
	);
	// Hold the final diagnostic inode, so a later directory replacement cannot
	// redirect diagnostics to a new, unowned root.
	const endHandle = await fsp.open(path.join(state, "gaussian-windows-files-end.json"), "wx");
	async function check() {
		if (!active || closed || failure) return;
		await guard();
		for (const row of plan.checkpoints) {
			if (records.has(row.name.toLowerCase())) continue;
			const p = paths(row.name);
			if (await absent(p.alias)) continue;
			const source = await checked(p.alias);
			if (source.size === 0n) continue;
			if (source.nlink !== 1n)
				fail("GAUSSIAN_WINDOWS_CHECKPOINT_ALREADY_LINKED", { path: p.alias });
			if (!(await absent(p.root))) fail("GAUSSIAN_WINDOWS_CHECKPOINT_COLLISION", { path: p.root });
			if (!active || !(await isAlive())) continue;
			await guard();
			await fsp.link(p.alias, p.root);
			const root = await checked(p.root),
				alias = await checked(p.alias);
			if (fileId(root) !== fileId(source) || fileId(alias) !== fileId(source))
				fail("GAUSSIAN_WINDOWS_CHECKPOINT_IDENTITY_CHANGED", { name: row.name });
			const alive = active && (await isAlive());
			records.set(row.name.toLowerCase(), {
				name: row.name,
				...p,
				fileId: fileId(root),
				input: false,
				published: alive,
				linkedWhileRunning: alive,
				linkedAt: new Date().toISOString()
			});
			if (!alive) fail("GAUSSIAN_WINDOWS_PUBLICATION_END_RACE", { name: row.name });
		}
	}
	function schedule() {
		if (queued) return chain;
		queued = true;
		chain = chain
			.then(check)
			.catch(rememberFailure)
			.finally(() => {
				queued = false;
			});
		return chain;
	}
	function stop() {
		active = false;
		closed = true;
		clearInterval(timer);
		watcher?.close();
	}
	return {
		assertOwned: guard,
		async start(alive) {
			isAlive = alive;
			active = true;
			try {
				await guard();
				watcher = fs.watch(scratch, { persistent: false }, schedule);
				watcher.on("error", rememberFailure);
				timer = setInterval(schedule, pollMs);
				timer.unref?.();
			} catch (error) {
				rememberFailure(error);
			}
			return schedule();
		},
		async finish(terminal) {
			if (finalResult) return finalResult;
			stop();
			await chain;
			const verified = terminal.processTree?.verified === true;
			const outputs = [];
			try {
				await guard();
				if (!verified) fail("GAUSSIAN_WINDOWS_FILE_END_UNVERIFIED");
				for (const row of plan.checkpoints) {
					const record = records.get(row.name.toLowerCase());
					if (!record?.published) {
						outputs.push({
							name: row.name,
							published: false,
							code: "GAUSSIAN_CHECKPOINT_NOT_PUBLISHED"
						});
						continue;
					}
					const a = await checked(record.root),
						b = await checked(record.alias);
					if (
						fileId(a) !== record.fileId ||
						fileId(b) !== record.fileId ||
						a.nlink !== 2n ||
						b.nlink !== 2n
					)
						fail("GAUSSIAN_WINDOWS_CHECKPOINT_IDENTITY_CHANGED", { name: row.name });
					const proof = await digest(record.root),
						nativeWritten =
							!record.input ||
							proof.sha256 !== record.preparedSha256 ||
							a.mtimeNs.toString() !== record.preparedMtimeNs;
					outputs.push({
						...record,
						...proof,
						nativeWritten,
						published: nativeWritten,
						...(!nativeWritten ? { code: "GAUSSIAN_CHECKPOINT_NOT_UPDATED" } : {})
					});
				}
				for (const input of inputProofs)
					if (!input.writes) {
						const current = await digest(input.root), info = await checked(input.root);
						if (current.fileId !== input.fileId || current.sha256 !== input.sha256 || info.nlink !== 2n)
							fail("GAUSSIAN_WINDOWS_READ_DEPENDENCY_CHANGED", { name: input.name });
					}
				if (!failure) {
					for (const alias of [
						...outputs.filter((row) => row.published),
						...inputProofs.filter((row) => !row.writes)
					]) {
						await guard();
						const root = await digest(alias.root),
							other = await digest(alias.alias), rootInfo = await checked(alias.root), aliasInfo = await checked(alias.alias);
						if (
							root.fileId !== alias.fileId ||
							other.fileId !== alias.fileId ||
							root.sha256 !== other.sha256 || rootInfo.nlink !== 2n || aliasInfo.nlink !== 2n
						)
							fail("GAUSSIAN_WINDOWS_ALIAS_RELEASE_UNVERIFIED", { path: alias.alias });
						await fsp.unlink(alias.alias);
						const retained = await digest(alias.root);
						if (retained.fileId !== root.fileId || retained.sha256 !== root.sha256 || (await checked(alias.root)).nlink !== 1n)
							fail("GAUSSIAN_WINDOWS_ROOT_CHECKPOINT_CHANGED", { path: alias.root });
						Object.assign(alias, retained);
						alias.scratchAliasReleased = true;
					}
				}
			} catch (error) {
				rememberFailure(error);
			}
			const result = {
				kind: KIND,
				status: failure
					? "failed"
					: outputs.every((row) => row.published)
						? "complete"
						: "incomplete",
				outputs,
				inputProofs,
				diagnostics,
				failure
			};
			finalResult = result;
			try {
				await endHandle.writeFile(JSON.stringify(result));
				await endHandle.sync();
			} finally {
				await endHandle.close();
			}
			return result;
		},
		async cancelBeforeLaunch() {
			if (finalResult) return finalResult;
			stop();
			await chain;
			try {
				for (const input of inputProofs) {
					await guard();
					const root = await digest(input.root),
						alias = await digest(input.alias);
					if (
						root.fileId !== input.fileId ||
						alias.fileId !== input.fileId ||
						root.sha256 !== input.sha256 ||
						alias.sha256 !== input.sha256
					)
						fail("GAUSSIAN_WINDOWS_ALIAS_RELEASE_UNVERIFIED");
					await fsp.unlink(input.alias);
				}
				finalResult = { kind: KIND, status: "not-started" };
				return finalResult;
			} catch (error) {
				rememberFailure(error);
				finalResult = { kind: KIND, status: "failed", inputProofs, diagnostics, failure };
				throw error;
			} finally {
				try {
					await endHandle.writeFile(JSON.stringify(finalResult));
					await endHandle.sync();
				} finally {
					await endHandle.close();
				}
			}
		}
	};
}
module.exports = { KIND, planGaussianWindowsFiles, createGaussianWindowsFilesOwner };
