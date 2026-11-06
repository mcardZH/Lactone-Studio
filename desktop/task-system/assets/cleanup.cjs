"use strict";
const { path, crypto, fail, digest, clone, unchanged, hashLocal } = require("./io.cjs");
const { base, id } = require("./common.cjs");
function createCleanup(context) {
	const { assertNoActiveIO } = context;
	const { library, safeState, begin, update, mutation, now, fault, transport, permits } = context;
	const { descendant } = require("./scratch-scope.cjs");
	const { verifyScratchScope, matchScratchFile } =
		require("./scratch-scope.cjs").createScratchVerifier({ library, transport });
	async function planCleanup({ manager, archiveManifestId, items, scratchScopes = [] }) {
		library.assertManager(manager);
		const archive = library.read("archiveManifest", archiveManifestId);
		if (!archive || archive.status !== "verified") throw fail("ASSET_VERIFIED_ARCHIVE_REQUIRED");
		const { run } = await safeState(archive.taskId, archive.runId);
		if (
			archive.sourceLocation.environmentId !== run.executionIdentity.workLocation?.environmentId ||
			archive.sourceLocation.path !== run.executionIdentity.workLocation?.path
		)
			throw fail("ASSET_CLEANUP_WORK_LOCATION_CONFLICT");
		const verifiedScopes = [];
		for (const scope of scratchScopes) {
			const checked = await verifyScratchScope(scope, archive.taskId, archive.runId);
			if (verifiedScopes.some((x) => x.scopeId === checked.scopeId))
				throw fail("ASSET_DUPLICATE_SCRATCH_SCOPE");
			verifiedScopes.push(checked);
		}
		const manifestId = id("cleanup"),
			operationId = id("op"),
			confirmationToken = crypto.randomBytes(32).toString("hex"),
			planned = [];
		const cleanupPaths = new Set();
		if (!items?.length) throw fail("ASSET_EMPTY_CLEANUP_PLAN");
		for (const item of items || []) {
			const key = JSON.stringify(item.originalLocation);
			if (cleanupPaths.has(key)) throw fail("ASSET_DUPLICATE_CLEANUP_PATH");
			cleanupPaths.add(key);
			const originalLocation = item.originalLocation,
				t = await transport(originalLocation.environmentId),
				identity = await t.stat(originalLocation.path);
			if (
				identity.isDirectory ||
				identity.isRegularFile === false ||
				(identity.mode && (parseInt(identity.mode, 16) & 0xf000) !== 0x8000)
			)
				throw fail("ASSET_CLEANUP_NOT_REGULAR_FILE");
			const hash = await t.hash({ path: originalLocation.path, identity, algorithm: "sha256" });
			const archived = archive.items.find(
				(x) =>
					x.included &&
					x.artifactId === item.artifactId &&
					x.sourceLocation.environmentId === originalLocation.environmentId &&
					x.sourceLocation.path === originalLocation.path &&
					x.sha256 === hash.hash &&
					unchanged(x.sourceIdentity, hash.identity)
			);
			if (archived) {
				const copy = await hashLocal(archived.targetPath);
				if (copy.sha256 !== archived.sha256 || copy.byteSize !== archived.byteSize)
					throw fail("ASSET_ARCHIVE_COPY_CHANGED");
			}
			const scratch =
				item.basis?.kind === "task-owned-scratch" &&
				item.basis.taskId === archive.taskId &&
				item.basis.runId === archive.runId &&
				item.basis.evidenceRefs?.length;
			if (!archived && !scratch) throw fail("ASSET_CLEANUP_BASIS_UNCONFIRMED");
			if (!item.impact || item.shared === true)
				throw fail("ASSET_CLEANUP_IMPACT_OR_OWNERSHIP_REQUIRED");
			let scopeRoot = archive.sourceLocation.path,
				scratchScopeId;
			const pathApi = originalLocation.path.startsWith("/") ? path.posix : path.win32;
			const relative = pathApi.relative(scopeRoot, originalLocation.path);
			const frozenScratch = run.executionIdentity.executorIdentity?.scratch;
			if (
				frozenScratch?.environmentId === originalLocation.environmentId &&
				originalLocation.path === pathApi.join(frozenScratch.path, ".es-scratch-owner.json")
			)
				throw fail("ASSET_SCRATCH_MARKER_PROTECTED");
			const ownedScope = verifiedScopes.find(
				(x) =>
					x.scratch.environmentId === originalLocation.environmentId &&
					descendant(pathApi, x.scratch.path, originalLocation.path)
			);
			if (ownedScope) {
				matchScratchFile(ownedScope, originalLocation, hash.identity, hash.hash);
				scopeRoot = ownedScope.scratch.path;
				scratchScopeId = ownedScope.scopeId;
			} else if (
				frozenScratch?.environmentId === originalLocation.environmentId &&
				descendant(pathApi, frozenScratch.path, originalLocation.path)
			)
				throw fail("ASSET_SCRATCH_PROOF_REQUIRED");
			else if (
				originalLocation.environmentId !== archive.sourceLocation.environmentId ||
				!relative ||
				relative === ".." ||
				relative.startsWith(".." + pathApi.sep) ||
				pathApi.isAbsolute(relative)
			)
				throw fail("ASSET_CLEANUP_OUTSIDE_RUN");
			const dependencyCheck = await assertNoActiveIO({
				taskId: archive.taskId,
				runId: archive.runId,
				artifactIds: [item.artifactId]
			});
			if (dependencyCheck?.safe !== true) throw fail("ASSET_ACTIVE_IO_OR_DEPENDENCY");
			planned.push({
				artifactId: item.artifactId,
				originalLocation,
				fileIdentity: hash.identity,
				sha256: hash.hash,
				byteSize: hash.identity.byteSize,
				basis: archived
					? { kind: "verified-archive", archiveManifestId, archivePath: archived.targetPath }
					: clone(item.basis),
				dependencyCheck,
				impact: item.impact,
				scopeRoot,
				...(scratchScopeId ? { scratchScopeId } : {}),
				result: { state: "not-executed" }
			});
		}
		const manifest = {
			...base(),
			manifestId,
			taskId: archive.taskId,
			runId: archive.runId,
			operationId,
			items: planned,
			status: "awaiting-confirmation",
			...(verifiedScopes.length ? { scratchScopes: verifiedScopes } : {})
		};
		const op = begin(manager, "cleanup-original", [{ kind: "cleanupManifest", id: manifestId }], {
			operationId,
			manifest,
			confirmationHash: digest(confirmationToken),
			logicalBytes: planned.reduce((n, x) => n + x.byteSize, 0),
			irreversible: true
		});
		update(
			op,
			"awaiting-confirmation",
			"running",
			[],
			[mutation("cleanupManifest", manifestId, manifest)]
		);
		return {
			manifest,
			confirmationToken,
			impact: {
				count: planned.length,
				logicalBytes: planned.reduce((n, x) => n + x.byteSize, 0),
				irreversible: true
			}
		};
	}
	async function cleanup({ manifestId, confirmationToken }) {
		const manifest = library.read("cleanupManifest", manifestId);
		if (!manifest) throw fail("ASSET_CLEANUP_NOT_FOUND");
		let op = library.read("operation", manifest.operationId);
		if (digest(confirmationToken || "") !== op.authorizationScope.confirmationHash)
			throw fail("ASSET_CONFIRMATION_REQUIRED");
		if (!permits.has(op.operationId)) throw fail("ASSET_OPERATION_RESUME_REQUIRED");
		await safeState(manifest.taskId, manifest.runId, [], op.operationId);
		const next = clone(manifest);
		let failures = 0;
		for (const item of next.items) {
			if (item.result.state === "deleted") continue;
			try {
				await safeState(manifest.taskId, manifest.runId, [item.artifactId], op.operationId);
				if (item.scratchScopeId) {
					const original = manifest.scratchScopes?.find((x) => x.scopeId === item.scratchScopeId);
					if (!original) throw fail("ASSET_SCRATCH_PROOF_REQUIRED");
					const scope = await verifyScratchScope(original, manifest.taskId, manifest.runId);
					matchScratchFile(scope, item.originalLocation, item.fileIdentity, item.sha256);
				}
				if (item.basis.kind === "verified-archive") {
					const copy = await hashLocal(item.basis.archivePath);
					if (copy.sha256 !== item.sha256 || copy.byteSize !== item.byteSize)
						throw fail("ASSET_ARCHIVE_COPY_CHANGED");
				}
				const t = await transport(item.originalLocation.environmentId);
				if (typeof t.removeFile !== "function") throw fail("ASSET_DELETE_UNSUPPORTED");
				const current = await t.stat(item.originalLocation.path);
				if (!unchanged(item.fileIdentity, current)) throw fail("ASSET_DELETE_IDENTITY_CHANGED");
				await fault("cleanup-before-delete", { item });
				await t.removeFile({
					path: item.originalLocation.path,
					identity: item.fileIdentity,
					sha256: item.sha256,
					scopeRoot: item.scopeRoot
				});
				item.result = { state: "deleted", checkedAt: now(), logicalBytes: item.byteSize };
				await fault("cleanup-after-delete", { item });
			} catch (error) {
				if (item.result.state === "deleted")
					item.result.receiptBoundaryError = error.code || String(error);
				else {
					item.result = {
						state:
							[
								"ASSET_DELETE_IDENTITY_CHANGED",
								"ASSET_ACTIVE_IO_OR_DEPENDENCY",
								"ASSET_DELETE_UNSUPPORTED"
							].includes(error.code) || error.code?.startsWith("ASSET_SCRATCH_")
								? "retained"
								: error.code === "ENOENT"
									? "missing-requires-verification"
									: "failed",
						error: error.code || String(error),
						checkedAt: now()
					};
					failures++;
				}
			}
			next.revision++;
			op = update(
				op,
				"deleting-exact-items",
				"running",
				[{ artifactId: item.artifactId, result: item.result }],
				[mutation("cleanupManifest", manifestId, clone(next), next.revision - 1)]
			);
		}
		next.status = failures ? "partial" : "completed";
		next.revision++;
		update(
			op,
			"finished",
			failures ? "partial" : "succeeded",
			[],
			[mutation("cleanupManifest", manifestId, next, next.revision - 1)]
		);
		return next;
	}

	return { planCleanup, cleanup };
}
module.exports = { createCleanup };
