"use strict";
const fs = require("node:fs/promises"),
	path = require("node:path");
const { fail, sha256 } = require("./common.cjs");
const { isMissingFile } = require("../transports/file-errors.cjs");
async function reserveExternalOutputs({ manifest, request, transport, platform, io }) {
	const api = platform === "win32" ? path.win32 : path.posix,
		result = [];
	for (const target of manifest.externalOutputs || []) {
		if (
			target.environmentId !== request.environmentId ||
			target.expectedAbsent !== true ||
			!api.isAbsolute(target.path) ||
			api.dirname(target.path) !== target.sourceRoot
		)
			fail("EXTERNAL_OUTPUT_SCOPE_CONFLICT");
		await transport.stat(target.sourceRoot, io);
		let existing = false;
		try {
			await transport.stat(target.path, io);
			existing = true;
		} catch (error) {
			if (!isMissingFile(error, target.path)) throw error;
		}
		if (existing)
			fail("EXTERNAL_OUTPUT_ALREADY_EXISTS", {
				path: target.path,
				reason: "Existing external files are never overwritten"
			});
		const key = platform === "win32" ? target.path.toLowerCase() : target.path,
			claimPath = api.join(
				target.sourceRoot,
				"es-output-claim-" + sha256(Buffer.from(key)).slice(0, 32)
			);
		try {
			await transport.mkdirExclusive(claimPath, io);
		} catch (error) {
			if (error.code === "WORK_DIRECTORY_EXISTS")
				fail("EXTERNAL_OUTPUT_ALREADY_RESERVED", { path: target.path });
			throw error;
		}
		const owner = {
				protocolVersion: 1,
				taskId: request.taskId,
				runId: request.runId,
				submissionIntentId: request.submissionIntentId,
				outputPath: target.path
			},
			bytes = Buffer.from(JSON.stringify(owner)),
			markerPath = api.join(claimPath, "owner.json"),
			marker = await transport.putAtomic(
				{
					path: markerPath,
					expectedAbsent: true,
					source: bytes,
					byteSize: bytes.length,
					sha256: sha256(bytes)
				},
				io
			);
		result.push({
			...target,
			claim: { path: claimPath, markerPath, markerHash: marker.sha256, owner }
		});
	}
	return result;
}
async function verifyExternalOutputs(manifest) {
	for (const target of manifest.externalOutputs || []) {
		if (!target.claim?.markerPath) fail("EXTERNAL_OUTPUT_CLAIM_MISSING");
		const bytes = await fs.readFile(target.claim.markerPath);
		if (sha256(bytes) !== target.claim.markerHash) fail("EXTERNAL_OUTPUT_CLAIM_CHANGED");
		const owner = JSON.parse(bytes);
		if (
			owner.runId !== manifest.runId ||
			owner.submissionIntentId !== manifest.submissionIntentId ||
			owner.outputPath !== target.path
		)
			fail("EXTERNAL_OUTPUT_OWNER_CONFLICT");
		try {
			await fs.lstat(target.path);
			fail("EXTERNAL_OUTPUT_ALREADY_EXISTS");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
}
async function releaseExternalOutputs(manifest) {
	const released = [];
	for (const target of manifest.externalOutputs || []) {
		const claim = target.claim;
		if (!claim) continue;
		try {
			if (
				path.dirname(claim.markerPath) !== claim.path ||
				!/^es-output-claim-[a-f0-9]{32}$/.test(path.basename(claim.path))
			)
				fail("EXTERNAL_OUTPUT_CLAIM_SCOPE_CONFLICT");
			const info = await fs.lstat(claim.path);
			if (!info.isDirectory() || info.isSymbolicLink()) fail("EXTERNAL_OUTPUT_CLAIM_CHANGED");
			const entries = await fs.readdir(claim.path);
			if (entries.length !== 1 || entries[0] !== "owner.json")
				fail("EXTERNAL_OUTPUT_CLAIM_CHANGED");
			const bytes = await fs.readFile(claim.markerPath);
			if (sha256(bytes) !== claim.markerHash) fail("EXTERNAL_OUTPUT_CLAIM_CHANGED");
			await fs.unlink(claim.markerPath);
			await fs.rmdir(claim.path);
			released.push({ path: claim.path, released: true });
		} catch (error) {
			released.push({
				path: claim.path,
				released: false,
				code: error.code || "CLAIM_RELEASE_FAILED"
			});
		}
	}
	return released;
}
module.exports = { reserveExternalOutputs, verifyExternalOutputs, releaseExternalOutputs };
