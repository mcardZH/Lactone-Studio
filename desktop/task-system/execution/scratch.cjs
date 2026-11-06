"use strict";
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { sha256, sameFile, unchanged, abort, fail } = require("./common.cjs");

const OWNER_MARKER = ".es-scratch-owner.json";
const clone = (value) => JSON.parse(JSON.stringify(value));
function regular(identity) {
	return (
		identity?.isRegularFile === true ||
		(typeof identity?.mode === "string" && (parseInt(identity.mode, 16) & 0xf000) === 0x8000)
	);
}
function identityAt(identity, file, environmentId) {
	return (
		identity?.path === file &&
		identity.environmentId === environmentId &&
		typeof identity.fileId === "string" &&
		!!identity.fileId &&
		Number.isSafeInteger(identity.byteSize) &&
		identity.byteSize >= 0
	);
}
function idle(run) {
	if (run?.state?.executionState !== "ended" || run.state.verificationState !== "verified")
		fail("SCRATCH_RUN_END_UNVERIFIED");
	const preparation = run.resultPreparationState?.state;
	if (
		(run.resultPreparationConfigured && !["ended", "not-started"].includes(preparation)) ||
		(preparation !== undefined && !["ended", "not-started", "unavailable"].includes(preparation)) ||
		run.state.relatedActivityEnded === false ||
		(run.state.resultPreparation !== undefined &&
			!["ended", "not-started", "unavailable"].includes(run.state.resultPreparation))
	)
		fail("SCRATCH_PREPARATION_NOT_ENDED");
}

/**
 * Read-only, direct-file inventory. The caller owns the library's active-IO gate;
 * this function cannot infer remote consumers or leases from a persisted run.
 * Every returned scope still requires independent verification before cleanup.
 */
async function enumerateOwnedScratch({ run, transport }, io) {
	const scratchScopes = [],
		exclusions = [],
		frozen = run?.executionIdentity?.executorIdentity?.scratch;
	const exclude = (file, code) => exclusions.push({ path: file, code });
	if (!frozen) return { scratchScopes, exclusions };
	try {
		abort(io?.signal);
		idle(run);
		const work = run.executionIdentity.workLocation,
			api = frozen.path?.startsWith("/") ? path.posix : path.win32,
			expectedName =
				"es-" +
				sha256(JSON.stringify({ workLocation: work, inputSnapshotId: run.inputSnapshotId })).slice(
					0,
					32
				),
			content = frozen.inputContentIdentity;
		if (
			frozen.kind !== "gaussian-scratch" ||
			!run.taskId ||
			!run.runId ||
			!run.inputSnapshotId ||
			!run.executionIdentity.submissionIntentId ||
			!work?.environmentId ||
			typeof work.path !== "string" ||
			!api.isAbsolute(work.path) ||
			api.resolve(work.path) !== work.path ||
			typeof frozen.root !== "string" ||
			!api.isAbsolute(frozen.root) ||
			api.resolve(frozen.root) !== frozen.root ||
			frozen.path !== api.join(frozen.root, expectedName) ||
			frozen.environmentId !== work.environmentId ||
			frozen.inputSnapshotId !== run.inputSnapshotId ||
			!content ||
			typeof content.hash !== "string" ||
			!content.hash
		)
			fail("SCRATCH_OWNER_UNVERIFIED");
		if (!transport?.listDirectory || !transport.stat || !transport.hash || !transport.readRange)
			fail("SCRATCH_INVENTORY_UNAVAILABLE");
		const marker = frozen.ownerMarker,
			markerPath = api.join(frozen.path, OWNER_MARKER);
		if (
			!identityAt(frozen.identity, frozen.path, frozen.environmentId) ||
			!frozen.identity.isDirectory ||
			marker?.path !== markerPath ||
			!identityAt(marker.identity, markerPath, frozen.environmentId) ||
			!regular(marker.identity) ||
			!/^[a-f0-9]{64}$/.test(marker.sha256 || "")
		)
			fail("SCRATCH_DESCRIPTOR_UNVERIFIED");
		const directory = await transport.stat(frozen.path, io);
		if (!directory.isDirectory || !sameFile(frozen.identity, directory))
			fail("SCRATCH_DIRECTORY_CHANGED");
		const markerIdentity = await transport.stat(markerPath, io);
		if (
			!regular(markerIdentity) ||
			!unchanged(marker.identity, markerIdentity) ||
			markerIdentity.byteSize > 65536
		)
			fail("SCRATCH_MARKER_CHANGED");
		const markerHash = await transport.hash(
			{ path: markerPath, identity: markerIdentity, algorithm: "sha256" },
			io
		);
		if (markerHash.hash !== marker.sha256 || !unchanged(markerIdentity, markerHash.identity))
			fail("SCRATCH_MARKER_CHANGED");
		const read = await transport.readRange(
				{ path: markerPath, identity: markerIdentity, offset: 0, length: markerIdentity.byteSize },
				io
			),
			bytes = Buffer.from(read.bytes);
		if (
			bytes.length !== markerIdentity.byteSize ||
			sha256(bytes) !== marker.sha256 ||
			!unchanged(markerIdentity, read.before) ||
			!unchanged(markerIdentity, read.after)
		)
			fail("SCRATCH_MARKER_CHANGED");
		const owner = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (
			owner.protocolVersion !== 1 ||
			owner.taskId !== run.taskId ||
			owner.runId !== run.runId ||
			owner.submissionIntentId !== run.executionIdentity.submissionIntentId ||
			owner.inputSnapshotId !== run.inputSnapshotId ||
			!isDeepStrictEqual(owner.inputContentIdentity, content) ||
			!isDeepStrictEqual(owner.workLocation, work) ||
			!isDeepStrictEqual(owner.scratchLocation, {
				environmentId: frozen.environmentId,
				path: frozen.path
			})
		)
			fail("SCRATCH_OWNER_CONFLICT");
		const listing = await transport.listDirectory({ path: frozen.path, identity: directory }, io);
		if (
			!listing.before?.isDirectory ||
			!listing.after?.isDirectory ||
			!unchanged(directory, listing.before) ||
			!unchanged(listing.before, listing.after) ||
			!Array.isArray(listing.entries)
		)
			fail("SCRATCH_DIRECTORY_CHANGED");
		const names = new Set(),
			files = [];
		for (const entry of listing.entries) {
			abort(io?.signal);
			const name = entry?.name;
			if (
				typeof name !== "string" ||
				!name ||
				name === "." ||
				name === ".." ||
				/[\\/\0:]/.test(name)
			) {
				exclude(frozen.path, "SCRATCH_UNSAFE_ENTRY_NAME");
				continue;
			}
			if (names.has(name)) fail("SCRATCH_DUPLICATE_ENTRY");
			names.add(name);
			const file = api.join(frozen.path, name);
			if (name === OWNER_MARKER) {
				exclude(file, "SCRATCH_OWNER_MARKER_PROTECTED");
				continue;
			}
			if (entry.kind !== "file") {
				exclude(
					file,
					entry.kind === "directory"
						? "SCRATCH_SUBDIRECTORY_PRESERVED"
						: entry.kind === "link"
							? "SCRATCH_LINK_PRESERVED"
							: "SCRATCH_NONREGULAR_PRESERVED"
				);
				continue;
			}
			try {
				const before = await transport.stat(file, io);
				if (
					!identityAt(before, file, frozen.environmentId) ||
					!regular(before) ||
					before.isDirectory
				)
					fail("SCRATCH_NONREGULAR_PRESERVED");
				const checked = await transport.hash(
						{ path: file, identity: before, algorithm: "sha256" },
						io
					),
					after = await transport.stat(file, io);
				if (
					!/^[a-f0-9]{64}$/.test(checked.hash || "") ||
					!unchanged(before, checked.identity) ||
					!unchanged(before, after) ||
					!regular(after)
				)
					fail("SCRATCH_FILE_CHANGED");
				files.push({
					path: file,
					identity: clone(after),
					sha256: checked.hash,
					byteSize: after.byteSize
				});
			} catch (error) {
				if (error.code === "IO_ABORTED") throw error;
				exclude(file, error.code || "SCRATCH_FILE_UNAVAILABLE");
			}
		}
		if (!names.has(OWNER_MARKER)) fail("SCRATCH_MARKER_MISSING_FROM_INVENTORY");
		if (
			!unchanged(listing.after, await transport.stat(frozen.path, io)) ||
			!unchanged(markerIdentity, await transport.stat(markerPath, io))
		)
			fail("SCRATCH_DIRECTORY_OR_MARKER_CHANGED");
		idle(run);
		scratchScopes.push({
			scratch: clone(frozen),
			proof: {
				taskId: run.taskId,
				runId: run.runId,
				submissionIntentId: run.executionIdentity.submissionIntentId,
				inputSnapshotId: run.inputSnapshotId,
				inputContentIdentity: clone(content),
				ownerMarker: owner
			},
			files
		});
	} catch (error) {
		if (error.code === "IO_ABORTED") throw error;
		exclude(frozen.path, error.code || "SCRATCH_INVENTORY_UNVERIFIED");
	}
	return { scratchScopes, exclusions };
}
module.exports = { enumerateOwnedScratch };
