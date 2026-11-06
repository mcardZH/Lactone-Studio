"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { openTaskLibrary } = require("./library/index.cjs");
const { createLocalTransport } = require("./transports/local.cjs");
const { fail } = require("./platform/global-settings.cjs");
const { hashFile } = require("./submission.cjs");
function remapPath(value, source, target) {
	if (typeof value !== "string") return value;
	const relative = path.relative(source, value);
	return relative &&
		relative !== ".." &&
		!relative.startsWith(".." + path.sep) &&
		!path.isAbsolute(relative)
		? path.join(target, relative)
		: value;
}
function mapLocations(record, kind, source, target, assetCopies = []) {
	const value = JSON.parse(JSON.stringify(record)),
		convert = (object) => {
			if (object?.path) object.path = remapPath(object.path, source, target);
		};
	const physicalFields = [
		"fileId",
		"changeToken",
		"modifiedMs",
		"modifiedAt",
		"mtimeMs",
		"mtimeNs",
		"ctimeMs",
		"ctimeNs",
		"checkedAt"
	];
	const keyPath = (file) =>
		process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
	const copiedIdentity = (object, content = {}, historical = false) => {
		if (!object || typeof object.path !== "string") return;
		const previousPath = object.path,
			targetPath = remapPath(previousPath, source, target);
		if (targetPath === previousPath) return;
		const receipts = assetCopies.filter(
			(copy) =>
				typeof copy.source?.path === "string" && keyPath(copy.source.path) === keyPath(previousPath)
		);
		if (!receipts.length) {
			if (!historical) throw fail("MIGRATION_COPY_RECEIPT_REQUIRED");
			object.path = targetPath;
			return;
		}
		let chosen;
		for (const { source: original, target: current } of receipts) {
			if (
				!current ||
				typeof current.path !== "string" ||
				keyPath(current.path) !== keyPath(targetPath) ||
				typeof original.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/i.test(original.sha256) ||
				original.sha256 !== current.sha256 ||
				!Number.isSafeInteger(original.byteSize) ||
				original.byteSize < 0 ||
				original.byteSize !== current.byteSize ||
				(object.sha256 !== undefined && object.sha256 !== original.sha256) ||
				(object.byteSize !== undefined && object.byteSize !== original.byteSize) ||
				(content.sha256 != null && content.sha256 !== original.sha256) ||
				(content.byteSize != null && content.byteSize !== original.byteSize) ||
				(object.fileId !== undefined && object.fileId !== original.fileId) ||
				(object.changeToken !== undefined && object.changeToken !== original.changeToken) ||
				typeof current.fileId !== "string" ||
				!current.fileId ||
				typeof current.changeToken !== "string" ||
				!current.changeToken ||
				(chosen &&
					["fileId", "changeToken", "sha256", "byteSize"].some(
						(key) => chosen[key] !== current[key]
					))
			)
				throw fail("MIGRATION_COPY_IDENTITY_CONFLICT");
			for (const key of physicalFields)
				if (
					Object.hasOwn(current, key) &&
					!(
						typeof current[key] === "string" ||
						(typeof current[key] === "number" && Number.isFinite(current[key]))
					)
				)
					throw fail("MIGRATION_COPY_IDENTITY_CONFLICT");
			chosen = current;
		}
		// Preserve the original object's other fields and sourceIdentity. A's migration
		// authority expects this insertion order for sparse location objects.
		object.path = targetPath;
		object.byteSize = chosen.byteSize;
		object.sha256 = chosen.sha256;
		for (const key of physicalFields) if (Object.hasOwn(chosen, key)) object[key] = chosen[key];
	};
	if (kind === "artifact")
		for (const location of value.locations || [])
			if (["frozen-input", "archive", "recycle"].includes(location.role))
				copiedIdentity(location, {
					sha256: value.contentHash?.algorithm === "sha256" ? value.contentHash.hash : null,
					byteSize: value.byteSize
				});
	if (kind === "archiveManifest") {
		convert(value.targetLocation);
		for (const item of value.items) {
			if (item.targetPath) item.targetPath = remapPath(item.targetPath, source, target);
			if (item.recyclePath) item.recyclePath = remapPath(item.recyclePath, source, target);
			copiedIdentity(
				item.copyIdentity,
				{ sha256: item.sha256, byteSize: item.byteSize },
				item.storageState === "recycled"
			);
		}
	}
	if (kind === "recycleRecord") {
		for (const location of [...value.originalLocations, ...value.recycleLocations])
			convert(location);
		for (const item of value.files || []) {
			convert(item.originalIdentity);
			copiedIdentity(
				item.recycleIdentity,
				{},
				(value.deletionResults || []).some(
					(result) => result.artifactId === item.artifactId && result.state === "deleted"
				)
			);
		}
	}
	return value;
}
function journalSequence(directory) {
	const db = new DatabaseSync(path.join(directory, "execution-receipts.sqlite"), {
		readOnly: true
	});
	try {
		return db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM metadata_commits").get()
			.sequence;
	} finally {
		db.close();
	}
}
function drainReceiptSources(store, sources, { deferUnknownOperations = false } = {}) {
	let copied = 0;
	for (const directory of [...new Set(sources || [])]) {
		const db = new DatabaseSync(path.join(directory, "execution-receipts.sqlite"), {
			readOnly: true
		});
		try {
			for (const row of db
				.prepare("SELECT json FROM receipts ORDER BY received_at,receipt_id")
				.all()) {
				const receipt = JSON.parse(row.json);
				if (deferUnknownOperations && !store.read("operation", receipt.operationId)) continue;
				store.appendExecutionReceipt(receipt);
				copied++;
			}
		} finally {
			db.close();
		}
	}
	return copied;
}
async function migrateHostLibrary({
	context,
	settings,
	dependencies,
	protocol,
	probe,
	jobs,
	owners,
	localEnvironmentId
}) {
	const manager = context.manager(),
		source = context.pointer.root,
		expected = settings.readPointer(),
		target = await dependencies.chooseDirectory?.({ purpose: "migrate", ownerId: context.ownerId });
	if (!target) throw fail("LIBRARY_SELECTION_CANCELLED");
	if (
		!(await dependencies.confirmImpact?.({
			purpose: "migrate",
			ownerId: context.ownerId,
			source,
			target,
			sourceRetained: true,
			workingDirectoriesMoved: false
		}))
	)
		throw fail("OPERATION_CONFIRMATION_REQUIRED");
	let inactive,
		stable,
		copiedAssets = [];
	let targetGuard, checkpointIO;
	const ownedMetadata = new Map();
	async function remember(file, expectedIdentity) {
		const identity = await targetGuard.recordOwnedFile({ path: file, identity: expectedIdentity });
		ownedMetadata.set(file, identity);
		return identity;
	}
	async function handleIdentity(handle, file) {
		const stat = await handle.stat({ bigint: true });
		return {
			path: file,
			fileId: `${stat.dev}:${stat.ino}`,
			byteSize: Number(stat.size),
			changeToken: `${stat.mtimeNs}:${stat.ctimeNs}`
		};
	}
	async function checkTarget(phase) {
		if (!targetGuard) throw fail("MIGRATION_TARGET_GUARD_REQUIRED");
		await targetGuard.assert({ phase });
	}
	async function refreshMutableMetadata() {
		for (const name of ["library.sqlite", "execution-receipts.sqlite"]) {
			const file = path.join(target, name);
			if (ownedMetadata.has(file)) await remember(file);
		}
	}
	async function targetAction(phase, work) {
		await checkTarget("before-" + phase);
		let result;
		try {
			result = work();
		} finally {
			await refreshMutableMetadata();
		}
		await checkTarget("after-" + phase);
		return result;
	}
	async function prepareFinalMetadata(operationId, operationPermit, final = false) {
		inactive?.close();
		inactive = null;
		await refreshMutableMetadata();
		await checkTarget(final ? "before-final-metadata" : "before-candidate-metadata");
		if (final)
			await settings.freezeMetadata(expected, operationId, {
				type: "migrate-library",
				sourceDirectory: source,
				targetDirectory: target
			});
		stable = context.store.checkpoint({ permit: operationPermit });
		// Each pass uses new target filenames. Earlier validated candidates are evidence, not overwritten.
		const metadataPath = path.join(target, "library.sqlite"),
			journalPath = path.join(target, "execution-receipts.sqlite");
		if (final)
			for (const name of ["library.sqlite", "execution-receipts.sqlite", "checkpoint.json"]) {
				const current = path.join(target, name);
				const identity =
					name === "checkpoint.json"
						? checkpointIO.expected({ kind: "pointer", path: current })
						: ownedMetadata.get(current);
				if (!identity || identity === "absent") throw fail("MIGRATION_METADATA_UNOWNED");
				const destination = current + ".pre-final-" + operationId,
					moved = await targetGuard.moveOwnedFile({ from: current, to: destination, identity });
				ownedMetadata.delete(current);
				ownedMetadata.set(destination, moved);
			}
		const stagingDirectory = path.join(
			target,
			".metadata-" + operationId + "-" + crypto.randomUUID()
		);
		await checkTarget("before-metadata-staging");
		await fs.mkdir(stagingDirectory);
		await targetGuard.recordOwnedDirectory({ path: stagingDirectory });
		const stagedMain = path.join(stagingDirectory, "library.sqlite"),
			input = await fs.open(stable.path, "r");
		let output;
		try {
			output = await fs.open(stagedMain, "wx", 0o600);
			const chunk = Buffer.alloc(1024 * 1024);
			let offset = 0;
			for (;;) {
				const read = await input.read(chunk, 0, chunk.length, offset);
				if (!read.bytesRead) break;
				await output.writeFile(chunk.subarray(0, read.bytesRead));
				offset += read.bytesRead;
			}
			await output.sync();
			await remember(stagedMain, await handleIdentity(output, stagedMain));
		} finally {
			await output?.close();
			await input.close();
		}
		const stagedMainHash = await hashFile(stagedMain);
		if (stagedMainHash.hash !== stable.sha256 || stagedMainHash.byteSize !== stable.byteSize)
			throw fail("MIGRATION_METADATA_CHANGED");
		await checkTarget("before-main-database-publish");
		const mainIdentity = await targetGuard.moveOwnedFile({
			from: stagedMain,
			to: metadataPath,
			identity: ownedMetadata.get(stagedMain)
		});
		ownedMetadata.delete(stagedMain);
		ownedMetadata.set(metadataPath, mainIdentity);
		const stagedJournal = path.join(stagingDirectory, "execution-receipts.sqlite"),
			reservation = await fs.open(stagedJournal, "wx", 0o600);
		let sourceJournal;
		try {
			await remember(stagedJournal, await handleIdentity(reservation, stagedJournal));
			sourceJournal = new DatabaseSync(path.join(source, "execution-receipts.sqlite"), {
				readOnly: true
			});
			await checkTarget("before-journal-backup");
			await backup(sourceJournal, stagedJournal);
			await remember(stagedJournal, await handleIdentity(reservation, stagedJournal));
		} finally {
			sourceJournal?.close();
			await reservation.close();
		}
		await checkTarget("before-journal-publish");
		const journalIdentity = await targetGuard.moveOwnedFile({
			from: stagedJournal,
			to: journalPath,
			identity: ownedMetadata.get(stagedJournal)
		});
		ownedMetadata.delete(stagedJournal);
		ownedMetadata.set(journalPath, journalIdentity);
		const copied = await hashFile(metadataPath);
		if (
			copied.hash !== stable.sha256 ||
			copied.byteSize !== stable.byteSize ||
			(final && journalSequence(source) !== stable.journalSequence)
		)
			throw fail("MIGRATION_METADATA_CHANGED");
		await targetAction("open-target-library", () => {
			inactive = openTaskLibrary({
				directory: target,
				libraryId: expected.libraryId,
				protocol,
				processIdentity: context.identity,
				probeProcessIdentity: probe,
				migrationContext: { operationId, permit: operationPermit, checkpointIO },
				supportedCapabilities: require("./library/markers.cjs").CAPABILITIES.concat(
					"es:task-postprocess-cache-v1",
					"es:task-environment-sites-v1"
				)
			});
			return inactive;
		});
		await targetAction("clear-target-pause", () =>
			inactive.clearMigrationPause({ permit: operationPermit, operationId })
		);
		const registered = inactive.operationPermit(operationPermit),
			allowed = new Set(registered.targets.map((target) => `${target.kind}:${target.id}`));
		for (const kind of ["artifact", "archiveManifest", "recycleRecord"]) {
			const mutations = [];
			for (let offset = 0; ; offset += 1000) {
				const records = inactive.list(kind, { limit: 1000, offset });
				for (const record of records) {
					if (!allowed.has(`${kind}:${record[protocol.RECORD_ID_FIELDS[kind]]}`))
						throw fail("MIGRATION_UNREGISTERED_RECORD");
					const value = mapLocations(record, kind, source, target, copiedAssets);
					if (JSON.stringify(value) === JSON.stringify(record)) continue;
					value.revision = record.revision + 1;
					mutations.push({
						kind,
						id: value[protocol.RECORD_ID_FIELDS[kind]],
						expectedRevision: record.revision,
						value
					});
				}
				if (records.length < 1000) break;
			}
			if (mutations.length) {
				const operation = inactive.operationPermit(operationPermit);
				await targetAction("map-target-" + kind, () =>
					inactive.commitOperation({
						permit: operationPermit,
						expectedRevision: operation.revision,
						operation: {
							...operation,
							revision: operation.revision + 1,
							phase: "target-locations-verified",
							operationState: "running",
							transitionEvidence: {
								type: "verification",
								checkedAt: new Date().toISOString(),
								evidenceRefs: ["migration:" + operationId + ":location-copy-map"]
							}
						},
						mutations
					})
				);
			}
		}
		return {
			verified: true,
			journalSequence: stable.journalSequence,
			sha256: stable.sha256,
			byteSize: stable.byteSize,
			targetLibraryId: expected.libraryId
		};
	}
	const local = createLocalTransport({ environmentId: localEnvironmentId });
	const sourceIO = context.ioAdmission.acquire("read");
	try {
		const result = await context.assets.migrateLibrary({
			manager,
			targetDirectory: target,
			targetLibraryId: expected.libraryId,
			transport: local,
			readPointer: async () => {
				const p = settings.readPointer();
				return { ...p, directory: p.root };
			},
			async awaitSafeBoundary({ operationId }) {
				await Promise.allSettled([...jobs]);
				for (const value of owners.values()) await value.monitoring?.stop();
				if (
					[...owners.values()].some(
						(value) =>
							value.preview?.active() ||
							(value.snapshotGateways || []).some((gateway) => gateway.activeIO())
					)
				)
					return { safe: false };
				const competing = await require("./operation-guards.cjs").competingFileOperations({
					store: context.store,
					probe,
					operationId,
					migration: true
				});
				if (competing.length)
					return { safe: false, reason: "other-instance-file-operation", operations: competing };
				return { safe: true };
			},
			prepareMetadata: ({ operationId, operationPermit, assetCopies, targetGuard: guard }) => {
				targetGuard = guard;
				checkpointIO = targetGuard.createCheckpointIO();
				copiedAssets = assetCopies;
				return prepareFinalMetadata(operationId, operationPermit);
			},
			async reconcileReceipts() {
				await checkTarget("before-reconcile-receipts");
				return {
					verified: true,
					copied: await targetAction("receipt-reconcile", () =>
						drainReceiptSources(inactive, [source, ...(expected.receiptSources || [])], {
							deferUnknownOperations: true
						})
					)
				};
			},
			async switchPointer({ operationId, operationPermit }) {
				try {
					// E has now persisted candidate/receipt facts. Freeze metadata, checkpoint the final state, and recopy.
					await prepareFinalMetadata(operationId, operationPermit, true);
					await targetAction("final-receipt-reconcile", () =>
						drainReceiptSources(inactive, [source, ...(expected.receiptSources || [])])
					);
					const op = inactive.read("operation", operationId);
					await targetAction("target-pointer-ready", () =>
						inactive.commitOperation({
							permit: operationPermit,
							expectedRevision: op.revision,
							operation: {
								...op,
								revision: op.revision + 1,
								phase: "pointer-ready",
								operationState: "running",
								transitionEvidence: {
									type: "verification",
									checkedAt: new Date().toISOString(),
									evidenceRefs: ["migration:" + operationId + ":target-verified"]
								},
								results: [
									...op.results,
									{ sourceDirectory: source, targetDirectory: target, sourceRetained: true }
								]
							}
						})
					);
					await targetAction("final-checkpoint", () =>
						inactive.checkpoint({ permit: operationPermit })
					);
					await checkTarget("before-effective-pointer-cas");
					await settings.switchPointer({
						expected,
						libraryId: expected.libraryId,
						root: target,
						receiptSources: [...(expected.receiptSources || []), source]
					});
					const latest = inactive.read("operation", operationId);
					await targetAction("migration-success", () =>
						inactive.commitOperation({
							permit: operationPermit,
							expectedRevision: latest.revision,
							operation: {
								...latest,
								revision: latest.revision + 1,
								phase: "effective-pointer-switched",
								results: [...latest.results, { targetClaim: targetGuard.describe() }],
								operationState: "succeeded",
								transitionEvidence: {
									type: "operation-complete",
									checkedAt: new Date().toISOString(),
									evidenceRefs: ["migration:" + operationId + ":pointer-switched"]
								}
							}
						})
					);
				} catch (error) {
					if (
						JSON.stringify(settings.readPointer()) === JSON.stringify(expected) &&
						settings.read().value.freeze?.operationId === operationId
					)
						await settings.thawMetadata(expected, operationId);
					throw error;
				}
			}
		});
		return {
			operationId: result.operationId,
			message: "任务库已迁移并切换，旧库保留；请重新进入任务中心"
		};
	} finally {
		sourceIO.release();
		inactive?.close();
		await local.dispose();
	}
}
module.exports = { migrateHostLibrary, drainReceiptSources, mapLocations };
