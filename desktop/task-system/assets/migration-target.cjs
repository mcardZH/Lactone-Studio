"use strict";
const { fs, path, fail, clone, noLinks, hashLocal, atomicJSON, digest } = require("./io.cjs");
const fsSync = require("node:fs");
const MARKER = ".es-library-migration-owner.json";
async function directoryIdentity(directory) {
	await noLinks(directory);
	const s = await fs.lstat(directory, { bigint: true });
	if (!s.isDirectory() || s.isSymbolicLink()) throw fail("ASSET_MIGRATION_TARGET_NOT_DIRECTORY");
	return {
		path: path.resolve(directory),
		fileId: `${s.dev}:${s.ino}`,
		birthtimeNs: String(s.birthtimeNs),
		changeToken: `${s.mtimeNs}:${s.ctimeNs}`
	};
}
function sameDirectory(a, b) {
	return a?.fileId === b?.fileId && a?.birthtimeNs === b?.birthtimeNs;
}
function sameFile(a, b) {
	return (
		a?.fileId === b?.fileId && a?.byteSize === b?.byteSize && a?.changeToken === b?.changeToken
	);
}
async function observeMigrationTarget(target) {
	const parent = await directoryIdentity(path.dirname(target));
	try {
		const identity = await directoryIdentity(target);
		if ((await fs.readdir(target)).length) throw fail("ASSET_MIGRATION_TARGET_NOT_EMPTY");
		return { kind: "existing-empty", identity, parent };
	} catch (error) {
		if (error.code === "ENOENT") return { kind: "absent", parent };
		throw error;
	}
}
async function claimMigrationTarget({ target, admission, operationId, libraryId, source, now }) {
	if (!sameDirectory(admission.parent, await directoryIdentity(path.dirname(target))))
		throw fail("ASSET_MIGRATION_TARGET_PARENT_CHANGED");
	if (admission.kind === "absent") {
		try {
			await fs.mkdir(target);
		} catch (error) {
			if (error.code === "EEXIST") throw fail("ASSET_MIGRATION_TARGET_CHANGED");
			throw error;
		}
	} else if (admission.kind === "existing-empty") {
		if (!sameDirectory(admission.identity, await directoryIdentity(target)))
			throw fail("ASSET_MIGRATION_TARGET_CHANGED");
	} else throw fail("ASSET_MIGRATION_TARGET_ADMISSION_INVALID");
	const identity = await directoryIdentity(target);
	if ((await fs.readdir(target)).length) throw fail("ASSET_MIGRATION_TARGET_NOT_EMPTY");
	const markerPath = path.join(target, MARKER),
		owner = {
			schemaVersion: 1,
			kind: "ester-library-migration-target",
			operationId,
			libraryId,
			sourceDirectory: source,
			targetDirectory: target,
			targetIdentity: identity,
			admittedAs: admission.kind,
			claimedAt: now()
		};
	await atomicJSON(markerPath, owner);
	const markerIdentity = await hashLocal(markerPath);
	if (!sameDirectory(identity, await directoryIdentity(target)))
		throw fail("ASSET_MIGRATION_TARGET_CHANGED");
	const known = new Map([[MARKER, { kind: "file", identity: markerIdentity, immutable: true }]]);
	const pointerPublications = [],
		checkpointEvents = [];
	function relative(file) {
		const resolved = path.resolve(file),
			value = path.relative(target, resolved);
		if (!value || value === ".." || value.startsWith(".." + path.sep) || path.isAbsolute(value))
			throw fail("ASSET_MIGRATION_TARGET_PATH_OUTSIDE");
		return value;
	}
	function parentOwned(file) {
		const parent = path.dirname(file);
		if (parent === target) return;
		const record = known.get(relative(parent));
		if (record?.kind !== "directory") throw fail("ASSET_MIGRATION_TARGET_PARENT_UNOWNED");
	}
	async function assertClaim() {
		if (!sameDirectory(identity, await directoryIdentity(target)))
			throw fail("ASSET_MIGRATION_TARGET_CHANGED");
		const actual = await hashLocal(markerPath);
		if (!sameFile(markerIdentity, actual) || actual.sha256 !== markerIdentity.sha256)
			throw fail("ASSET_MIGRATION_TARGET_CLAIM_CHANGED");
	}
	async function assert({ phase } = {}) {
		await assertClaim();
		const seen = new Set();
		async function inspect(directory) {
			const before = await directoryIdentity(directory);
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name),
					key = relative(file),
					record = known.get(key);
				if (!record) throw fail("ASSET_MIGRATION_TARGET_UNEXPECTED_CONTENT");
				seen.add(key);
				const stat = await fs.lstat(file, { bigint: true });
				if (stat.isSymbolicLink()) throw fail("ASSET_LINK_REFUSED");
				if (record.kind === "directory") {
					if (!stat.isDirectory() || !sameDirectory(record.identity, await directoryIdentity(file)))
						throw fail("ASSET_MIGRATION_TARGET_CHANGED");
					await inspect(file);
				} else {
					if (!stat.isFile()) throw fail("ASSET_MIGRATION_TARGET_CHANGED");
					const current = {
						fileId: `${stat.dev}:${stat.ino}`,
						byteSize: Number(stat.size),
						changeToken: `${stat.mtimeNs}:${stat.ctimeNs}`
					};
					if (!sameFile(record.identity, current))
						throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
				}
			}
			const after = await directoryIdentity(directory);
			if (!sameDirectory(before, after) || before.changeToken !== after.changeToken)
				throw fail("ASSET_MIGRATION_TARGET_CONCURRENT_CHANGE");
		}
		await inspect(target);
		for (const key of known.keys())
			if (!seen.has(key)) throw fail("ASSET_MIGRATION_TARGET_OWNED_ENTRY_MISSING");
		await assertClaim();
		return { verified: true, phase, operationId, entryCount: known.size };
	}
	async function recordOwnedDirectory({ path: file, identity: expected } = {}) {
		await assertClaim();
		const key = relative(file);
		parentOwned(file);
		const current = await directoryIdentity(file),
			old = known.get(key);
		if (expected && !sameDirectory(expected, current)) throw fail("ASSET_MIGRATION_TARGET_CHANGED");
		if (old && (old.kind !== "directory" || !sameDirectory(old.identity, current)))
			throw fail("ASSET_MIGRATION_TARGET_CHANGED");
		if (!old && (await fs.readdir(file)).length)
			throw fail("ASSET_MIGRATION_TARGET_UNCLAIMED_DIRECTORY_CONTENT");
		known.set(key, { kind: "directory", identity: current });
		return clone(current);
	}
	async function recordOwnedFile({ path: file, identity: expected, immutable = false } = {}) {
		await assertClaim();
		const key = relative(file);
		if (key === MARKER) throw fail("ASSET_MIGRATION_TARGET_CLAIM_PROTECTED");
		parentOwned(file);
		const current = await hashLocal(file),
			old = known.get(key);
		if (
			expected &&
			(!sameFile(expected, current) || (expected.sha256 && expected.sha256 !== current.sha256))
		)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		if (old && (old.kind !== "file" || old.identity.fileId !== current.fileId || old.immutable))
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		known.set(key, { kind: "file", identity: current, immutable });
		return clone(current);
	}
	async function forgetOwnedFile({ path: file, identity: expected } = {}) {
		await assertClaim();
		const key = relative(file),
			old = known.get(key);
		if (key === MARKER || old?.kind !== "file" || !expected || !sameFile(old.identity, expected))
			throw fail("ASSET_MIGRATION_TARGET_UNOWNED_ENTRY");
		try {
			await fs.lstat(file);
			throw fail("ASSET_MIGRATION_TARGET_ENTRY_STILL_PRESENT");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		known.delete(key);
	}
	async function moveOwnedFile({ from, to, identity: expected } = {}) {
		await assertClaim();
		const fromKey = relative(from),
			toKey = relative(to),
			old = known.get(fromKey);
		if (
			fromKey === MARKER ||
			old?.kind !== "file" ||
			!expected ||
			!sameFile(old.identity, expected) ||
			known.has(toKey)
		)
			throw fail("ASSET_MIGRATION_TARGET_UNOWNED_ENTRY");
		parentOwned(to);
		const current = await hashLocal(from);
		if (!sameFile(old.identity, current) || current.sha256 !== old.identity.sha256)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		await noLinks(path.dirname(to));
		await fs.link(from, to); // Atomic no-replace; unknown destination bytes survive EEXIST.
		const linked = await hashLocal(to);
		known.set(toKey, { ...old, identity: linked });
		known.set(fromKey, { ...old, identity: await hashLocal(from) });
		if (linked.fileId !== current.fileId || linked.sha256 !== current.sha256)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		const final = await hashLocal(from);
		if (final.fileId !== linked.fileId || final.sha256 !== linked.sha256)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		await fs.unlink(from);
		known.delete(fromKey);
		const moved = await hashLocal(to);
		known.set(toKey, { ...old, identity: moved });
		return clone(moved);
	}
	async function ensureAssetDirectory(directory) {
		const rel = relative(directory);
		let parent = target;
		for (const name of rel.split(path.sep)) {
			const file = path.join(parent, name),
				key = relative(file),
				existing = known.get(key);
			if (existing) {
				if (
					existing.kind !== "directory" ||
					!sameDirectory(existing.identity, await directoryIdentity(file))
				)
					throw fail("ASSET_MIGRATION_TARGET_CHANGED");
			} else {
				await fs.mkdir(file);
				await recordOwnedDirectory({ path: file });
			}
			parent = file;
		}
	}
	// Synchronous adapter only for A's target-only migration checkpoints. It shares this
	// exact claim/map; ordinary recordOwnedFile still rejects replacement inodes.
	function noLinksSync(file) {
		let current = path.resolve(file);
		while (true) {
			if (fsSync.lstatSync(current).isSymbolicLink()) throw fail("ASSET_LINK_REFUSED");
			const parent = path.dirname(current);
			if (parent === current) return;
			current = parent;
		}
	}
	function directorySync(file) {
		noLinksSync(file);
		const s = fsSync.lstatSync(file, { bigint: true });
		if (!s.isDirectory()) throw fail("ASSET_MIGRATION_TARGET_NOT_DIRECTORY");
		return {
			path: path.resolve(file),
			fileId: `${s.dev}:${s.ino}`,
			birthtimeNs: String(s.birthtimeNs),
			changeToken: `${s.mtimeNs}:${s.ctimeNs}`
		};
	}
	function fileSync(file) {
		noLinksSync(file);
		const stat = () => {
			const s = fsSync.lstatSync(file, { bigint: true });
			if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER))
				throw fail("ASSET_MIGRATION_TARGET_CHANGED");
			return {
				path: path.resolve(file),
				fileId: `${s.dev}:${s.ino}`,
				byteSize: Number(s.size),
				changeToken: `${s.mtimeNs}:${s.ctimeNs}`
			};
		};
		const before = stat(),
			hash = require("node:crypto").createHash("sha256"),
			fd = fsSync.openSync(file, "r"),
			buffer = Buffer.allocUnsafe(1024 * 1024);
		try {
			let n;
			while ((n = fsSync.readSync(fd, buffer, 0, buffer.length, null)))
				hash.update(buffer.subarray(0, n));
		} finally {
			fsSync.closeSync(fd);
		}
		const after = stat();
		if (!sameFile(before, after)) throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		return { ...after, sha256: hash.digest("hex") };
	}
	function assertClaimSync() {
		if (!sameDirectory(identity, directorySync(target)))
			throw fail("ASSET_MIGRATION_TARGET_CHANGED");
		const marker = fileSync(markerPath);
		if (!sameFile(markerIdentity, marker) || marker.sha256 !== markerIdentity.sha256)
			throw fail("ASSET_MIGRATION_TARGET_CLAIM_CHANGED");
	}
	function exactIdentity(expected, current) {
		return (
			!!expected &&
			expected.path === current.path &&
			expected.fileId === current.fileId &&
			expected.byteSize === current.byteSize &&
			(!expected.changeToken || expected.changeToken === current.changeToken) &&
			(!expected.sha256 || expected.sha256 === current.sha256)
		);
	}
	function assertParentSync(file) {
		parentOwned(file);
		const parent = path.dirname(file);
		if (
			parent !== target &&
			!sameDirectory(known.get(relative(parent)).identity, directorySync(parent))
		)
			throw fail("ASSET_MIGRATION_TARGET_CHANGED");
	}
	function checkpointPath(kind, file) {
		relative(file);
		if (
			file === markerPath ||
			!["directory", "baseline", "pointer-candidate", "pointer"].includes(kind)
		)
			throw fail("ASSET_MIGRATION_CHECKPOINT_SCOPE_INVALID");
		if (kind === "directory" && file !== path.join(target, "checkpoints"))
			throw fail("ASSET_MIGRATION_CHECKPOINT_SCOPE_INVALID");
		if (kind === "baseline" && path.dirname(file) !== path.join(target, "checkpoints"))
			throw fail("ASSET_MIGRATION_CHECKPOINT_SCOPE_INVALID");
		if (kind === "pointer" && file !== path.join(target, "checkpoint.json"))
			throw fail("ASSET_MIGRATION_CHECKPOINT_SCOPE_INVALID");
		if (
			kind === "pointer-candidate" &&
			(path.dirname(file) !== target || file === path.join(target, "checkpoint.json"))
		)
			throw fail("ASSET_MIGRATION_CHECKPOINT_SCOPE_INVALID");
		assertParentSync(file);
	}
	function expectedCheckpoint({ kind, path: file }) {
		assertClaimSync();
		checkpointPath(kind, file);
		const entry = known.get(relative(file));
		if (!entry) {
			try {
				fsSync.lstatSync(file);
				throw fail("ASSET_MIGRATION_TARGET_UNEXPECTED_CONTENT");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			return "absent";
		}
		if (kind === "directory") {
			const current = directorySync(file);
			if (entry.kind !== "directory" || !sameDirectory(entry.identity, current))
				throw fail("ASSET_MIGRATION_TARGET_CHANGED");
			return clone(current);
		}
		const current = fileSync(file);
		if (
			entry.kind !== "file" ||
			!sameFile(entry.identity, current) ||
			entry.identity.sha256 !== current.sha256
		)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		return clone(current);
	}
	function changedCheckpoint({ action, kind, identity: provided }) {
		assertClaimSync();
		const file = provided?.path;
		if (typeof file !== "string") throw fail("ASSET_MIGRATION_CHECKPOINT_IDENTITY_REQUIRED");
		checkpointPath(kind, file);
		const key = relative(file),
			entry = known.get(key);
		if (action === "retired") {
			if (
				kind === "directory" ||
				entry?.kind !== "file" ||
				!exactIdentity(provided, entry.identity)
			)
				throw fail("ASSET_MIGRATION_TARGET_UNOWNED_ENTRY");
			try {
				fsSync.lstatSync(file);
				throw fail("ASSET_MIGRATION_TARGET_ENTRY_STILL_PRESENT");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			known.delete(key);
			checkpointEvents.push({ action: "retired", kind, identity: clone(provided) });
			return;
		}
		if (action !== "created" || kind === "pointer")
			throw fail("ASSET_MIGRATION_CHECKPOINT_EVENT_INVALID");
		if (kind === "directory") {
			const current = directorySync(file);
			if (
				entry ||
				provided.fileId !== current.fileId ||
				(provided.birthtimeNs && provided.birthtimeNs !== current.birthtimeNs) ||
				fsSync.readdirSync(file).length
			)
				throw fail("ASSET_MIGRATION_TARGET_CHANGED");
			known.set(key, { kind: "directory", identity: current, checkpointKind: kind });
			checkpointEvents.push({ action: "created", kind, identity: clone(current) });
			return;
		}
		const current = fileSync(file);
		if (entry || !exactIdentity(provided, current))
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		known.set(key, { kind: "file", identity: current, immutable: true, checkpointKind: kind });
		checkpointEvents.push({ action: "created", kind, identity: clone(current) });
	}
	function publishCheckpointPointer({
		operationId: requested,
		destination,
		candidateIdentity,
		expectedCurrent,
		baselineIdentity
	}) {
		assertClaimSync();
		if (requested !== operationId) throw fail("ASSET_MIGRATION_CHECKPOINT_OPERATION_CONFLICT");
		checkpointPath("pointer", destination);
		const candidatePath = candidateIdentity?.path,
			baselinePath = baselineIdentity?.path;
		checkpointPath("pointer-candidate", candidatePath);
		checkpointPath("baseline", baselinePath);
		const candidateEntry = known.get(relative(candidatePath)),
			baselineEntry = known.get(relative(baselinePath)),
			candidate = fileSync(candidatePath),
			baseline = fileSync(baselinePath);
		if (
			candidateEntry?.checkpointKind !== "pointer-candidate" ||
			baselineEntry?.checkpointKind !== "baseline" ||
			!exactIdentity(candidateIdentity, candidate) ||
			!sameFile(candidateEntry.identity, candidate) ||
			candidateEntry.identity.sha256 !== candidate.sha256 ||
			!exactIdentity(baselineIdentity, baseline) ||
			!sameFile(baselineEntry.identity, baseline) ||
			baselineEntry.identity.sha256 !== baseline.sha256
		)
			throw fail("ASSET_MIGRATION_CHECKPOINT_IDENTITY_CONFLICT");
		if (candidate.byteSize > 1024 * 1024)
			throw fail("ASSET_MIGRATION_CHECKPOINT_POINTER_TOO_LARGE");
		const data = JSON.parse(fsSync.readFileSync(candidatePath, "utf8"));
		if (
			data.path !== baseline.path ||
			data.sha256 !== baseline.sha256 ||
			data.byteSize !== baseline.byteSize ||
			data.libraryId !== libraryId
		)
			throw fail("ASSET_MIGRATION_CHECKPOINT_BASELINE_CONFLICT");
		let before = "absent",
			backupIdentity = null;
		const destinationKey = relative(destination);
		if (expectedCurrent === "absent") {
			if (known.has(destinationKey)) throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
			try {
				fsSync.lstatSync(destination);
				throw fail("ASSET_MIGRATION_TARGET_UNEXPECTED_CONTENT");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		} else {
			const entry = known.get(destinationKey),
				current = fileSync(destination);
			if (
				entry?.kind !== "file" ||
				!exactIdentity(expectedCurrent, current) ||
				!sameFile(entry.identity, current) ||
				entry.identity.sha256 !== current.sha256
			)
				throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
			before = current;
			const backup = destination + ".pre-" + operationId + "-" + digest(candidatePath).slice(0, 12),
				backupKey = relative(backup);
			if (known.has(backupKey)) throw fail("ASSET_MIGRATION_TARGET_UNOWNED_ENTRY");
			fsSync.linkSync(destination, backup);
			backupIdentity = fileSync(backup);
			const linkedOld = fileSync(destination);
			known.set(backupKey, { ...entry, identity: backupIdentity });
			known.set(destinationKey, { ...entry, identity: linkedOld });
			if (
				linkedOld.fileId !== before.fileId ||
				linkedOld.byteSize !== before.byteSize ||
				linkedOld.sha256 !== before.sha256 ||
				backupIdentity.fileId !== before.fileId ||
				backupIdentity.sha256 !== before.sha256
			)
				throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
			fsSync.unlinkSync(destination);
			known.delete(destinationKey);
			backupIdentity = fileSync(backup);
			known.set(backupKey, { ...entry, identity: backupIdentity });
		}
		// Both canonical destination and backup publication are atomic no-replace links.
		fsSync.linkSync(candidatePath, destination);
		let after = fileSync(destination),
			linkedCandidate = fileSync(candidatePath);
		known.set(destinationKey, {
			kind: "file",
			identity: after,
			immutable: true,
			checkpointKind: "pointer"
		});
		known.set(relative(candidatePath), { ...candidateEntry, identity: linkedCandidate });
		if (
			after.fileId !== candidate.fileId ||
			after.sha256 !== candidate.sha256 ||
			linkedCandidate.fileId !== candidate.fileId ||
			linkedCandidate.sha256 !== candidate.sha256
		)
			throw fail("ASSET_MIGRATION_TARGET_CONTENT_CHANGED");
		fsSync.unlinkSync(candidatePath);
		known.delete(relative(candidatePath));
		after = fileSync(destination);
		known.set(destinationKey, {
			kind: "file",
			identity: after,
			immutable: true,
			checkpointKind: "pointer"
		});
		const receipt = {
			schemaVersion: 1,
			operationId,
			libraryId,
			destination,
			before,
			after,
			backupIdentity,
			baselineIdentity: baseline
		};
		pointerPublications.push(clone(receipt));
		checkpointEvents.push({
			action: "pointer-published",
			kind: "pointer",
			receipt: clone(receipt)
		});
		return receipt;
	}
	await assert({ phase: "claimed" });
	return {
		assert,
		recordOwnedFile,
		recordOwnedDirectory,
		forgetOwnedFile,
		moveOwnedFile,
		ensureAssetDirectory,
		createCheckpointIO: () => ({
			expected: expectedCheckpoint,
			changed: changedCheckpoint,
			publishPointer: publishCheckpointPointer
		}),
		describe: () => ({
			operationId,
			libraryId,
			sourceDirectory: source,
			targetDirectory: target,
			admittedAs: admission.kind,
			targetIdentity: clone(identity),
			ownerMarker: clone(markerIdentity),
			pointerPublications: clone(pointerPublications),
			checkpointEvents: clone(checkpointEvents),
			ownedEntries: [...known.entries()].map(([relativePath, entry]) => ({
				relativePath,
				...clone(entry)
			}))
		})
	};
}
module.exports = { observeMigrationTarget, claimMigrationTarget };
