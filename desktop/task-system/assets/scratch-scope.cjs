"use strict";
const { isDeepStrictEqual } = require("node:util");
const { path, fail, digest, clone, sameFile, unchanged } = require("./io.cjs");
function descendant(api, root, file) {
	if (!api.isAbsolute(file) || api.resolve(file) !== file) return false;
	const relative = api.relative(root, file);
	return (
		!!relative &&
		relative !== ".." &&
		!relative.startsWith(".." + api.sep) &&
		!api.isAbsolute(relative)
	);
}
function regular(identity) {
	return (
		identity?.isRegularFile === true ||
		(typeof identity?.mode === "string" && (parseInt(identity.mode, 16) & 0xf000) === 0x8000)
	);
}
function createScratchVerifier({ library, transport }) {
	async function verifyScratchScope(scope, taskId, runId) {
		const run = library.read("run", runId),
			frozen = run?.executionIdentity?.executorIdentity?.scratch,
			scratch = scope?.scratch || scope,
			proof = scope?.proof;
		if (
			!run ||
			run.taskId !== taskId ||
			!frozen ||
			frozen.kind !== "gaussian-scratch" ||
			!proof ||
			!Array.isArray(scope.files)
		)
			throw fail("ASSET_SCRATCH_PROOF_REQUIRED");
		const api = frozen.path?.startsWith("/") ? path.posix : path.win32,
			work = run.executionIdentity.workLocation,
			snapshot = library.read("inputSnapshot", run.inputSnapshotId);
		if (
			!work ||
			!snapshot ||
			snapshot.inputSnapshotId !== run.inputSnapshotId ||
			!snapshot.contentIdentity?.hash
		)
			throw fail("ASSET_SCRATCH_INPUT_UNVERIFIED");
		const expectedName =
			"es-" +
			digest(JSON.stringify({ workLocation: work, inputSnapshotId: run.inputSnapshotId })).slice(
				0,
				32
			);
		if (
			!api.isAbsolute(frozen.root) ||
			api.resolve(frozen.root) !== frozen.root ||
			frozen.path !== api.join(frozen.root, snapshot.engineExtensions?.fileLayout === "task-relative-v1" ? "scratch" : expectedName) ||
			frozen.inputSnapshotId !== run.inputSnapshotId ||
			frozen.environmentId !== work.environmentId
		)
			throw fail("ASSET_SCRATCH_OWNER_CONFLICT");
		for (const key of ["environmentId", "root", "path", "kind", "inputSnapshotId"])
			if (scratch[key] !== frozen[key]) throw fail("ASSET_SCRATCH_OWNER_CONFLICT");
		if (
			proof.taskId !== taskId ||
			proof.runId !== runId ||
			proof.submissionIntentId !== run.executionIdentity.submissionIntentId ||
			proof.inputSnapshotId !== run.inputSnapshotId ||
			!isDeepStrictEqual(proof.inputContentIdentity, snapshot.contentIdentity)
		)
			throw fail("ASSET_SCRATCH_INPUT_UNVERIFIED");
		const marker = frozen.ownerMarker,
			markerPath = api.join(frozen.path, ".es-scratch-owner.json");
		if (
			!marker ||
			marker.path !== markerPath ||
			scratch.ownerMarker?.path !== markerPath ||
			scratch.ownerMarker?.sha256 !== marker.sha256 ||
			!sameFile(scratch.identity, frozen.identity) ||
			!sameFile(scratch.ownerMarker?.identity, marker.identity)
		)
			throw fail("ASSET_SCRATCH_MARKER_CONFLICT");
		const t = await transport(frozen.environmentId),
			directoryIdentity = await t.stat(frozen.path);
		if (!directoryIdentity.isDirectory || !sameFile(frozen.identity, directoryIdentity))
			throw fail("ASSET_SCRATCH_DIRECTORY_CHANGED");
		const markerIdentity = await t.stat(markerPath);
		if (
			!regular(markerIdentity) ||
			!unchanged(marker.identity, markerIdentity) ||
			markerIdentity.byteSize > 65536
		)
			throw fail("ASSET_SCRATCH_MARKER_CHANGED");
		const checked = await t.hash({
			path: markerPath,
			identity: markerIdentity,
			algorithm: "sha256"
		});
		if (checked.hash !== marker.sha256) throw fail("ASSET_SCRATCH_MARKER_CHANGED");
		const read = await t.readRange({
			path: markerPath,
			identity: markerIdentity,
			offset: 0,
			length: markerIdentity.byteSize
		});
		const owner = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(read.bytes))
		);
		if (
			owner.protocolVersion !== 1 ||
			owner.taskId !== taskId ||
			owner.runId !== runId ||
			owner.submissionIntentId !== run.executionIdentity.submissionIntentId ||
			!isDeepStrictEqual(owner.workLocation, work) ||
			!isDeepStrictEqual(owner.scratchLocation, {
				environmentId: frozen.environmentId,
				path: frozen.path
			}) ||
			!isDeepStrictEqual(proof.ownerMarker, owner) ||
			(owner.inputSnapshotId !== undefined && owner.inputSnapshotId !== run.inputSnapshotId) ||
			(owner.inputContentIdentity !== undefined &&
				!isDeepStrictEqual(owner.inputContentIdentity, snapshot.contentIdentity))
		)
			throw fail("ASSET_SCRATCH_OWNER_CONFLICT");
		if (!sameFile(directoryIdentity, await t.stat(frozen.path)))
			throw fail("ASSET_SCRATCH_DIRECTORY_CHANGED");
		const files = scope.files.map((file) => {
			if (
				!descendant(api, frozen.path, file.path) ||
				api.dirname(file.path) !== frozen.path ||
				file.path === markerPath ||
				!regular(file.identity) ||
				file.identity.path !== file.path ||
				file.identity.environmentId !== frozen.environmentId ||
				!/^[a-f0-9]{64}$/.test(file.sha256 || "")
			)
				throw fail("ASSET_SCRATCH_FILE_PROOF_INVALID");
			return clone(file);
		});
		const scopeId = digest(
			JSON.stringify({
				environmentId: frozen.environmentId,
				path: frozen.path,
				fileId: frozen.identity.fileId,
				ownerMarkerHash: marker.sha256,
				inputSnapshotId: run.inputSnapshotId
			})
		);
		return { scopeId, scratch: clone(frozen), proof: clone(proof), files };
	}
	function matchScratchFile(scope, location, identity, sha256) {
		const file = scope.files.find(
			(file) =>
				file.path === location.path && location.environmentId === scope.scratch.environmentId
		);
		if (
			!file ||
			!regular(identity) ||
			!unchanged(file.identity, identity) ||
			file.sha256 !== sha256
		)
			throw fail("ASSET_SCRATCH_FILE_CHANGED");
	}
	return { verifyScratchScope, matchScratchFile };
}
module.exports = { createScratchVerifier, descendant, regular };
