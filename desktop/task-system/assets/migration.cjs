"use strict";
const { fs, path, fail, clone, inside, copySource, listExactFiles } = require("./io.cjs");
const { observeMigrationTarget, claimMigrationTarget } = require("./migration-target.cjs");
function createMigration({ library, libraryDirectory, begin, update, now, fault, permits }) {
	function exactMigrationTargets() {
		const fields = {
				artifact: "artifactId",
				archiveManifest: "manifestId",
				recycleRecord: "recycleId"
			},
			targets = new Map();
		const add = (kind, id) => {
			if (Object.hasOwn(fields, kind) && typeof id === "string" && id)
				targets.set(JSON.stringify([kind, id]), { kind, id });
		};
		for (const [kind, field] of Object.entries(fields))
			for (let offset = 0; ; offset += 10000) {
				const page = library.list(kind, { limit: 10000, offset });
				for (const record of page) add(kind, record[field]);
				if (page.length < 10000) break;
			}
		for (let offset = 0; ; offset += 10000) {
			const page = library.list("operation", { limit: 10000, offset });
			for (const operation of page)
				if (!["succeeded", "failed", "cancelled"].includes(operation.operationState))
					for (const target of operation.targets || []) add(target.kind, target.id);
			if (page.length < 10000) break;
		}
		return [...targets.values()].sort(
			(a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
		);
	}
	async function migrateLibrary(request) {
		const {
			manager,
			targetDirectory,
			targetLibraryId,
			prepareMetadata,
			awaitSafeBoundary,
			reconcileReceipts,
			switchPointer,
			readPointer,
			transport
		} = request;
		if (
			![prepareMetadata, awaitSafeBoundary, reconcileReceipts, switchPointer, readPointer].every(
				(x) => typeof x === "function"
			) ||
			!transport
		)
			throw fail("ASSET_MIGRATION_CALLBACKS_REQUIRED");
		library.assertManager(manager);
		const source = path.resolve(libraryDirectory),
			target = path.resolve(targetDirectory);
		if (source === target) throw fail("ASSET_MIGRATION_SAME_LOCATION");
		for (const [a, b] of [
			[source, target],
			[target, source]
		]) {
			const rel = path.relative(a, b);
			if (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
				throw fail("ASSET_MIGRATION_NESTED_LOCATION");
		}
		const beforePointer = await readPointer();
		const targetAdmission = await observeMigrationTarget(target);
		let op = begin(manager, "migrate-library", exactMigrationTargets(), {
			targetAdmission,
			libraryId: library.describe().libraryId,
			sourceDirectory: source,
			targetDirectory: target,
			sourceLibraryId: library.describe().libraryId,
			targetLibraryId,
			beforePointer
		});
		library.setMigrationPause({
			manager,
			operationId: op.operationId,
			targetLibraryId,
			receiptLocation: path.join(source, "execution-receipts.sqlite")
		});
		let targetGuard;
		try {
			const boundary = await awaitSafeBoundary({ operationId: op.operationId });
			if (boundary?.safe !== true) throw fail("ASSET_MIGRATION_INFLIGHT_NOT_SAFE");
			await fault("migration-before-target-claim", {
				operationId: op.operationId,
				targetDirectory: target,
				targetAdmission
			});
			targetGuard = await claimMigrationTarget({
				target,
				admission: targetAdmission,
				operationId: op.operationId,
				libraryId: library.describe().libraryId,
				source,
				now
			});
			op = update(op, "target-claimed", "running", [{ targetClaim: targetGuard.describe() }]);
			await fault("migration-target-claimed", {
				operationId: op.operationId,
				targetDirectory: target,
				targetClaim: targetGuard.describe()
			});
			const copied = [];
			for (const category of ["inputs", "archive", "trash"]) {
				const root = path.join(source, category);
				try {
					await fs.lstat(root);
				} catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}
				const listing = await listExactFiles(root);
				if (listing.links.length) throw fail("ASSET_MIGRATION_UNKNOWN_LINK");
				for (const item of listing.files) {
					await targetGuard.assert({ phase: "before-asset-copy" });
					const relative = inside(source, item.path),
						destination = path.join(target, relative);
					await targetGuard.ensureAssetDirectory(path.dirname(destination));
					const identity = await transport.stat(item.path);
					const copy = await copySource(
						{ path: item.path, identity, sha256: item.sha256 },
						destination,
						{ transport, fault }
					);
					await targetGuard.recordOwnedFile({ path: destination, identity: copy, immutable: true });
					copied.push({ source: item, target: copy });
					op = update(op, "copying-assets", "running", [
						{ relativePath: relative, sourceIdentity: item, targetIdentity: copy }
					]);
				}
			}
			// Source mutation after a category was scanned cannot be silently missed.
			for (const category of ["inputs", "archive", "trash"]) {
				const root = path.join(source, category);
				let listing;
				try {
					listing = await listExactFiles(root);
				} catch (error) {
					if (error.code === "ENOENT") listing = { files: [], links: [] };
					else throw error;
				}
				const expected = copied.filter(
					(x) => inside(source, x.source.path).split(path.sep)[0] === category
				);
				if (
					listing.links.length ||
					listing.files.length !== expected.length ||
					listing.files.some(
						(x) =>
							!expected.some(
								(y) =>
									y.source.path === x.path &&
									y.source.fileId === x.fileId &&
									y.source.sha256 === x.sha256 &&
									y.source.changeToken === x.changeToken
							)
					)
				)
					throw fail("ASSET_MIGRATION_SOURCE_CHANGED");
			}
			await targetGuard.assert({ phase: "before-metadata" });
			const metadata = await prepareMetadata({
				targetGuard,
				operationPermit: clone(permits.get(op.operationId)),
				operationId: op.operationId,
				sourceDirectory: source,
				targetDirectory: target,
				targetLibraryId,
				assetCopies: copied
			});
			if (metadata?.verified !== true) throw fail("ASSET_MIGRATION_METADATA_NOT_VERIFIED");
			await targetGuard.assert({ phase: "metadata-verified" });
			op = update(op, "candidate-verified", "running", [
				{ metadata, copiedFiles: copied.length, targetClaim: targetGuard.describe() }
			]);
			const receipts = await reconcileReceipts({
				targetGuard,
				operationPermit: clone(permits.get(op.operationId)),
				operationId: op.operationId,
				sourceDirectory: source,
				targetDirectory: target
			});
			if (receipts?.verified !== true) throw fail("ASSET_MIGRATION_RECEIPTS_NOT_RECONCILED");
			await targetGuard.assert({ phase: "receipts-verified" });
			await fault("migration-before-pointer", {
				operationId: op.operationId,
				targetDirectory: target
			});
			await targetGuard.assert({ phase: "before-pointer" });
			await switchPointer({
				targetGuard,
				// Host-private only. Never return this permit through IPC or persist it in metadata.
				operationPermit: clone(permits.get(op.operationId)),
				operationId: op.operationId,
				expected: beforePointer,
				sourceDirectory: source,
				targetDirectory: target,
				targetLibraryId,
				metadata,
				receipts
			});
			await fault("migration-after-pointer", {
				operationId: op.operationId,
				targetDirectory: target
			});
			const pointer = await readPointer();
			if (path.resolve(pointer.directory || pointer.path || "") !== target)
				throw fail("ASSET_MIGRATION_POINTER_UNVERIFIED");
			// Main owns effective-write guards. Old database must remain paused and is kept.
			return {
				operationId: op.operationId,
				state: "switched",
				sourceRetained: true,
				targetDirectory: target,
				pointer,
				metadata,
				receipts,
				finalizationRequired: true
			};
		} catch (error) {
			const pointer = await readPointer().catch(() => null),
				switched = pointer && path.resolve(pointer.directory || pointer.path || "") === target;
			// After publication never mutate or unpause the old library. Main finalizes in target.
			if (!switched)
				op = update(op, "needs-inspection", "waiting-verification", [
					{
						error: error.code || String(error),
						pointer,
						...(targetGuard ? { targetClaim: targetGuard.describe() } : {})
					}
				]);
			error.migration = {
				operationId: op.operationId,
				sourceRetained: true,
				pointer,
				switched: !!switched,
				targetDirectory: target
			};
			throw error;
		}
	}
	return { migrateLibrary };
}
module.exports = { createMigration };
