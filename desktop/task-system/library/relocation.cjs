"use strict";
const fs = require("node:fs"),
	path = require("node:path");
const { hashLocal } = require("../assets/io.cjs");
const { mapLocations } = require("../migration-host.cjs");
const { fail } = require("../platform/global-settings.cjs");
const { listAll } = require("../operation-guards.cjs");
function remap(file, source, target) {
	if (typeof file !== "string") return file;
	const relative = path.relative(source, file);
	return relative &&
		relative !== ".." &&
		!relative.startsWith(".." + path.sep) &&
		!path.isAbsolute(relative)
		? path.join(target, relative)
		: file;
}
/** An explicit same-library root selection rebinds only registered local assets after content verification. */
async function reconcileLibraryRoot({ store, manager, directory, operations }) {
	const pointer = JSON.parse(fs.readFileSync(path.join(directory, "checkpoint.json"), "utf8"));
	const source = store.describe().root || path.dirname(path.dirname(pointer.path));
	if (path.resolve(source) === path.resolve(directory)) {
		if (!store.describe().root) store.setRootMetadata({ manager });
		return;
	}
	const kinds = ["artifact", "archiveManifest", "recycleRecord", "task"],
		recordIds = {
			artifact: "artifactId",
			archiveManifest: "manifestId",
			recycleRecord: "recycleId",
			task: "taskId"
		},
		records = kinds.flatMap((kind) =>
			listAll(store, kind).map((record) => ({ kind, record }))
		),
		descriptors = [];
	const add = (identity, sha256, byteSize) => {
		if (identity?.path && remap(identity.path, source, directory) !== identity.path)
			descriptors.push({
				identity,
				sha256: sha256 || identity.sha256,
				byteSize: byteSize ?? identity.byteSize
			});
	};
	for (const { kind, record } of records) {
		if (kind === "artifact")
			for (const location of record.locations || [])
				if (["archive", "recycle", "frozen-input"].includes(location.role))
					add(location, record.contentHash?.hash, record.byteSize);
		if (kind === "archiveManifest")
			for (const item of record.items || [])
				if (item.included) add(item.copyIdentity, item.sha256, item.byteSize);
		if (kind === "recycleRecord")
			for (const item of record.files || [])
				add(item.recycleIdentity, item.recycleIdentity?.sha256, item.recycleIdentity?.byteSize);
	}
	const started = operations.begin({
			type: "relink-library-root",
			targets: records.map(({ kind, record }) => ({ kind, id: record[recordIds[kind]] })),
			scope: {
				sourceDirectory: source,
				targetDirectory: directory,
				libraryId: store.describe().libraryId
			}
		}),
		copies = [];
	try {
		for (const [index, row] of descriptors.entries()) {
			if (!row.sha256 || !Number.isSafeInteger(row.byteSize))
				throw fail("LIBRARY_RELOCATION_CONTENT_IDENTITY_REQUIRED");
			const target = await hashLocal(remap(row.identity.path, source, directory));
			if (target.sha256 !== row.sha256 || target.byteSize !== row.byteSize)
				throw fail("LIBRARY_RELOCATION_ASSET_CHANGED");
			copies.push({
				source: { ...row.identity, sha256: row.sha256, byteSize: row.byteSize },
				target
			});
			operations.update(started.operationId, {
				phase: "verifying-registered-assets",
				completed: index + 1,
				total: descriptors.length,
				unit: "files"
			});
		}
		const mutations = [];
		for (const { kind, record } of records) {
			const value = mapLocations(record, kind, source, directory, copies);
			if (kind === "task") {
				if (value.plannedArchiveLocation?.path)
					value.plannedArchiveLocation.path = remap(
						value.plannedArchiveLocation.path,
						source,
						directory
					);
				if (value.postprocessCache?.manifestPath)
					value.postprocessCache.manifestPath = remap(
						value.postprocessCache.manifestPath,
						source,
						directory
					);
			}
			if (JSON.stringify(value) !== JSON.stringify(record)) {
				value.revision = record.revision + 1;
				mutations.push({
					kind,
					id: value[recordIds[kind]],
					expectedRevision: record.revision,
					value
				});
			}
		}
		if (mutations.length) operations.commitRecords(started.operationId, mutations);
		store.setRootMetadata({ manager });
		operations.complete(started.operationId, {
			results: [
				{
					sourceRetained: true,
					registeredAssetsVerified: descriptors.length,
					externalWorkDirectoriesChanged: false
				}
			]
		});
	} catch (error) {
		operations.fail(started.operationId, error);
		throw error;
	}
}
module.exports = { reconcileLibraryRoot };
