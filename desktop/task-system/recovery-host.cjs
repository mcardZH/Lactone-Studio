"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {
	inspectBaseline,
	prepareRecoveredLibrary,
	openTaskLibrary
} = require("./library/index.cjs");
const { listExactFiles, copySource } = require("./assets/io.cjs");
const { createLocalTransport } = require("./transports/local.cjs");
const { mapLocations, drainReceiptSources } = require("./migration-host.cjs");
const { fail, noLinks } = require("./platform/global-settings.cjs");
function recoveryManager(baseline) {
	const db = new DatabaseSync(baseline.baseline.path, { readOnly: true });
	let manager;
	try {
		manager = JSON.parse(db.prepare("SELECT json FROM manager WHERE singleton=1").get().json);
	} finally {
		db.close();
	}
	const journal = new DatabaseSync(baseline.journal.path, { readOnly: true });
	try {
		for (const row of journal
			.prepare("SELECT json FROM metadata_commits WHERE sequence>? ORDER BY sequence")
			.all(baseline.baseline.journalSequence)) {
			const value = JSON.parse(row.json);
			if (value.manager) manager = value.manager;
		}
	} finally {
		journal.close();
	}
	return manager;
}
async function recoverHostLibrary({
	context,
	settings,
	dependencies,
	protocol,
	probe,
	owners,
	jobs,
	baseline
}) {
	if (!context.entries.size) throw fail("MANAGEMENT_ENTRY_REQUIRED");
	const expected = settings.readPointer(),
		priorManager = recoveryManager(baseline);
	if (
		priorManager.instanceId &&
		priorManager.instanceId !== context.identity.instanceId &&
		(await probe(priorManager.processIdentity)) !== "dead"
	)
		throw fail("RECOVERY_MANAGER_STILL_ALIVE_OR_UNKNOWN");
	if (jobs.size) throw fail("RECOVERY_ACTIVE_OPERATION");
	const selected = await dependencies.chooseDirectory?.({
		purpose: "repair",
		ownerId: context.ownerId
	});
	if (!selected) throw fail("LIBRARY_SELECTION_CANCELLED");
	const operationId = "recovery-" + crypto.randomUUID(),
		target = path.join(selected, operationId);
	if (
		!(await dependencies.confirmImpact?.({
			purpose: "recover-library",
			ownerId: context.ownerId,
			source: expected.root,
			target,
			sourceRetained: true,
			runsRequireVerification: true,
			scientificActions: false
		}))
	)
		throw fail("OPERATION_CONFIRMATION_REQUIRED");
	await settings.freezeMetadata(expected, operationId, {
		type: "recover-library",
		sourceDirectory: expected.root,
		targetDirectory: target
	});
	for (const owner of owners.values()) await owner.monitoring?.stop();
	const recovery = prepareRecoveredLibrary({
		directory: expected.root,
		targetDirectory: target,
		libraryId: expected.libraryId,
		protocol,
		supportedCapabilities: require("./library/markers.cjs").CAPABILITIES.concat(
			"es:task-postprocess-cache-v1",
			"es:task-environment-sites-v1"
		)
	});
	const transport = createLocalTransport({ environmentId: "es-recovery-local" });
	let targetStore;
	try {
		const copied = [];
		for (const category of ["inputs", "archive", "trash"]) {
			const sourceRoot = path.join(expected.root, category);
			try {
				await fs.lstat(sourceRoot);
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			const exact = await listExactFiles(sourceRoot);
			if (exact.links.length) throw fail("RECOVERY_ASSET_LINK_REFUSED");
			for (const file of exact.files) {
				const relative = path.relative(expected.root, file.path),
					destination = path.join(target, relative);
				noLinks(path.dirname(destination));
				await fs.mkdir(path.dirname(destination), { recursive: true });
				const identity = await transport.stat(file.path),
					copy = await copySource({ path: file.path, identity, sha256: file.sha256 }, destination, {
						transport
					});
				copied.push({ source: file, target: copy });
			}
		}
		// Corrupt source and receipt journal are rechecked after copying; source original bytes stay untouched.
		const after = inspectBaseline({ directory: expected.root, libraryId: expected.libraryId });
		if (
			after.source.sha256 !== baseline.source.sha256 ||
			after.journal.sha256 !== baseline.journal.sha256
		)
			throw fail("RECOVERY_SOURCE_CHANGED");
		targetStore = openTaskLibrary({
			directory: target,
			libraryId: expected.libraryId,
			protocol,
			processIdentity: context.identity,
			probeProcessIdentity: probe,
			supportedCapabilities: require("./library/markers.cjs").CAPABILITIES.concat(
				"es:task-postprocess-cache-v1",
				"es:task-environment-sites-v1"
			)
		});
		const acquired = await targetStore.acquireManager();
		if (!acquired.acquired) throw fail("RECOVERY_MANAGER_UNAVAILABLE");
		const manager = acquired.manager;
		const mutations = [];
		for (const kind of ["artifact", "archiveManifest", "recycleRecord"])
			for (let offset = 0; ; offset += 1000) {
				const records = targetStore.list(kind, { limit: 1000, offset });
				for (const record of records) {
					const value = mapLocations(record, kind, expected.root, target, copied);
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
		const op = targetStore.beginOperation({
			manager,
			operation: {
				schemaVersion: 1,
				revision: 1,
				requiredCapabilities: [],
				operationId,
				type: "self-check-recovery",
				targets: mutations.map(({ kind, id }) => ({ kind, id })),
				preconditions: {},
				authorizationScope: {
					sourceDirectory: expected.root,
					targetDirectory: target,
					baseline: recovery.baseline,
					sourceIdentity: recovery.source,
					externalActionsReplayed: false
				},
				phase: "candidate-verified",
				operationState: "pending",
				results: []
			}
		});
		targetStore.commitOperation({
			permit: op.permit,
			expectedRevision: op.operation.revision,
			operation: {
				...op.operation,
				revision: op.operation.revision + 1,
				phase: "recovered-metadata-assets-verified",
				operationState: "succeeded",
				results: [
					{
						copiedFiles: copied.length,
						unverifiedRunIds: recovery.unverifiedRunIds,
						sourceRetained: true
					}
				],
				transitionEvidence: {
					type: "operation-complete",
					checkedAt: new Date().toISOString(),
					evidenceRefs: [path.join(target, "recovery-receipt.json")]
				}
			},
			mutations
		});
		drainReceiptSources(targetStore, [expected.root, ...(expected.receiptSources || [])]);
		targetStore.checkpoint({ manager });
		await settings.switchPointer({
			expected,
			libraryId: expected.libraryId,
			root: target,
			receiptSources: [...(expected.receiptSources || []), expected.root]
		});
		return {
			checkId: operationId,
			issues: recovery.unverifiedRunIds.map((runId) => ({
				id: runId,
				message: "元数据与独立来源已恢复；外部运行仍待按原身份核实，未重提计算",
				repairable: true
			}))
		};
	} finally {
		targetStore?.close();
		await transport.dispose();
	}
}
module.exports = { recoverHostLibrary, recoveryManager };
