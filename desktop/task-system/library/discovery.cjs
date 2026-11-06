"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { noLinks, fail } = require("../platform/global-settings.cjs");
const { readMarker, compareManagement } = require("./markers.cjs");
const markers = require("./markers.cjs");
function fileHash(file) {
	noLinks(file);
	const fd = fs.openSync(file, "r"),
		hash = crypto.createHash("sha256"),
		buffer = Buffer.alloc(1024 * 1024);
	try {
		for (let offset = 0; ;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
			if (!count) break;
			hash.update(buffer.subarray(0, count));
			offset += count;
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(fd);
	}
}
function samePrefix(left, right) {
	noLinks(left);
	noLinks(right);
	const a = fs.openSync(left, "r"),
		b = fs.openSync(right, "r"),
		limit = Math.min(fs.fstatSync(a).size, fs.fstatSync(b).size),
		x = Buffer.alloc(1024 * 1024),
		y = Buffer.alloc(1024 * 1024);
	try {
		for (let offset = 0; offset < limit;) {
			const length = Math.min(x.length, limit - offset),
				na = fs.readSync(a, x, 0, length, offset),
				nb = fs.readSync(b, y, 0, length, offset);
			if (na !== length || nb !== length || !x.subarray(0, length).equals(y.subarray(0, length)))
				return false;
			offset += length;
		}
		return true;
	} finally {
		fs.closeSync(a);
		fs.closeSync(b);
	}
}
function hasDirectoryMarker(directory) {
	const handle = fs.opendirSync(directory, { bufferSize: 256 });
	try {
		for (let entry; (entry = handle.readSync());)
			if (path.extname(entry.name).toLowerCase() === ".ddwz") return true;
		return false;
	} finally {
		handle.closeSync();
	}
}
/** Read directory entries in batches and retain traversal state without recursive calls. */
function* directoryEntries(root) {
	const stack = [];
	const open = (directory) => {
		noLinks(directory);
		const hasMarker = hasDirectoryMarker(directory);
		stack.push({ directory, hasMarker, handle: fs.opendirSync(directory, { bufferSize: 256 }) });
	};
	try {
		open(root);
		while (stack.length) {
			const frame = stack[stack.length - 1],
				entry = frame.handle.readSync();
			if (!entry) {
				stack.pop().handle.closeSync();
				continue;
			}
			const file = path.join(frame.directory, entry.name),
				stat = fs.lstatSync(file);
			yield { directory: frame.directory, hasMarker: frame.hasMarker, entry, file, stat };
			if (
				stat.isDirectory() &&
				!stat.isSymbolicLink() &&
				![".es-postprocess-cache", "monitor-cache", "checkpoints"].includes(entry.name)
			)
				open(file);
		}
	} finally {
		for (const frame of stack.reverse()) frame.handle.closeSync();
	}
}
/** Explicit complete root scan. Ordinary library opening never calls this. Links are reported, not followed. */
function discoverDirectory(root) {
	root = path.resolve(root);
	noLinks(root);
	if (!fs.statSync(root).isDirectory()) throw fail("LIBRARY_DIRECTORY_REQUIRED");
	const items = [],
		conflicts = [],
		issues = [],
		seen = new Map();
	for (const { directory, hasMarker, entry, file, stat } of directoryEntries(root)) {
		if (stat.isSymbolicLink()) {
			issues.push({ path: file, code: "LINK_NOT_FOLLOWED" });
			continue;
		}
		if (stat.isDirectory()) continue;
		if (!stat.isFile()) continue;
		if (entry.name === "manifest.json" && !hasMarker) {
			try {
				const bytes = fs.readFileSync(file),
					manifest = JSON.parse(bytes.toString("utf8"));
				if (
					manifest.schemaVersion === 1 &&
					typeof manifest.taskId === "string" &&
					Array.isArray(manifest.items) &&
					manifest.status === "verified"
				) {
					const included = manifest.items.filter((row) => row.included && row.targetPath);
					if (included.length) {
						const mainItem =
							included.find((row) => row.roles?.includes("primary-output")) || included[0];
						items.push({
							taskId: manifest.taskId,
							name: manifest.taskId,
							displayName: manifest.taskId,
							directory,
							markerPath: path.join(directory, "task.ddwz"),
							markerIdentity: crypto.createHash("sha256").update(bytes).digest("hex"),
							marker: {
								version: 1,
								id: manifest.taskId,
								name: manifest.taskId,
								main: path.basename(mainItem.targetPath),
								date: (manifest.createdAt || "").slice(0, 10),
								note: ""
							},
							legacyManifestPath: file,
							legacyManifest: manifest,
							state: "recoverable"
						});
					}
				}
			} catch (error) {
				issues.push({ path: file, code: "LEGACY_MANIFEST_INVALID", message: error.message });
			}
			continue;
		}
		if (path.extname(entry.name).toLowerCase() !== ".ddwz") continue;
		try {
			const marker = readMarker(file),
				taskId = marker.value.id || null;
			const item = {
				taskId,
				name: marker.value.name || path.basename(directory),
				displayName: marker.value.name || path.basename(directory),
				directory,
				markerPath: file,
				markerIdentity: marker.identity,
				marker: marker.value,
				state: "recoverable"
			};
			for (const name of ["managed-sources.json", "manifest.json"]) {
				const sidecar = path.join(directory, name);
				if (!fs.existsSync(sidecar)) continue;
				noLinks(sidecar);
				const sidecarStat = fs.statSync(sidecar);
				if (!sidecarStat.isFile())
					throw fail("TASK_DIRECTORY_MANIFEST_INVALID");
				const bytes = fs.readFileSync(sidecar),
					value = JSON.parse(bytes.toString("utf8"));
				if (
					(name === "managed-sources.json" &&
						value.schema === "ester-managed-postprocess-sources/v1" &&
						value.version === 1 &&
						value.sourceSetId === marker.value.sourceSetId &&
						Array.isArray(value.files)) ||
					(name === "manifest.json" &&
						value.schemaVersion === 1 &&
						value.taskId === taskId &&
						Array.isArray(value.items))
				) {
					item.directoryManifest = value;
					item.directoryManifestPath = sidecar;
					item.directoryManifestIdentity = crypto
						.createHash("sha256")
						.update(bytes)
						.digest("hex");
					break;
				}
			}
			const previous = taskId && seen.get(taskId);
			if (previous) {
				const relation = compareManagement(previous.marker.management, item.marker.management);
				if (relation === "conflict") {
					item.state = "conflict";
					conflicts.push({
						taskId,
						code: "MARKER_MANAGEMENT_CONFLICT",
						paths: [previous.markerPath, file]
					});
				}
				if (
					path.dirname(previous.markerPath) === directory &&
					previous.markerIdentity !== item.markerIdentity
				) {
					item.state = "conflict";
					conflicts.push({
						taskId,
						code: "MULTIPLE_DIRECTORY_MARKERS",
						paths: [previous.markerPath, file]
					});
				}
				if (
					previous.marker.main &&
					item.marker.main &&
					!(
						previous.marker.sourceVersion &&
						item.marker.sourceVersion &&
						previous.marker.sourceVersion !== item.marker.sourceVersion
					)
				) {
					const left = path.join(previous.directory, previous.marker.main),
						right = path.join(directory, item.marker.main);
					if (fs.existsSync(left) && fs.existsSync(right) && !samePrefix(left, right)) {
						item.state = "conflict";
						conflicts.push({
							taskId,
							code: "MARKER_SCIENTIFIC_SOURCE_CONFLICT",
							paths: [previous.markerPath, file]
						});
					}
				}
			} else if (taskId) seen.set(taskId, item);
			items.push(item);
		} catch (error) {
			issues.push({
				path: file,
				code: error.code || "TASK_MARKER_INVALID",
				message: error.detail || error.message
			});
		}
	}
	return {
		candidateId: "discovery-" + crypto.randomUUID(),
		root,
		items,
		conflicts: conflicts.map((row, index) => ({
			id: "conflict-" + index,
			message: row.code,
			...row
		})),
		issues: issues.map((row, index) => ({ id: "issue-" + index, message: row.code, ...row }))
	};
}
function verifyDiscovery(candidate) {
	for (const item of candidate.items)
		if (
			(item.legacyManifestPath
				? fileHash(item.legacyManifestPath)
				: readMarker(item.markerPath).identity) !== item.markerIdentity
		)
			throw fail("LIBRARY_DISCOVERY_CHANGED");
	for (const item of candidate.items)
		if (
			item.directoryManifestPath &&
			fileHash(item.directoryManifestPath) !== item.directoryManifestIdentity
		)
			throw fail("LIBRARY_DISCOVERY_CHANGED");
	return candidate;
}
function importDiscovered({
	store,
	manager,
	directory,
	candidate,
	choices = {},
	localEnvironmentId = "local-library",
	now = () => new Date().toISOString(),
	commitRecords
}) {
	verifyDiscovery(candidate);
	const result = [];
	for (const item of candidate.items) {
		if (item.marker.deleted === true) {
			result.push({
				taskId: item.taskId,
				outcome: "not-executed",
				message: "保留删除标记，未重新登记"
			});
			continue;
		}
		if (choices[item.markerPath] === "skip") {
			result.push({ path: item.markerPath, outcome: "not-executed" });
			continue;
		}
		if (item.state === "conflict" && !["use", "new-id"].includes(choices[item.markerPath]))
			throw fail("LIBRARY_DISCOVERY_CONFLICT_UNRESOLVED");
		const marker = item.marker,
			id =
				choices[item.markerPath] === "new-id" || !marker.id
					? item.plannedTaskId || "task-" + crypto.randomUUID()
					: marker.id;
		const old = store.read("task", id);
		if (
			Object.hasOwn(item, "expectedTaskRevision") &&
			(old?.revision ?? null) !== item.expectedTaskRevision
		)
			throw fail("LIBRARY_REBUILD_TARGET_CHANGED");
		const location = markers.locate(directory, item.directory, "external", {
			markerPath: item.markerPath,
			management: marker.management
		});
		if (old?.deleted) {
			result.push({
				taskId: id,
				outcome: "not-executed",
				message: "任务已删除，残留标记未重新登记"
			});
			continue;
		}
		const implicitInitialManagement =
			!marker.management &&
			old?.management?.revision === 1 &&
			old.management.parentChangeId === null &&
			!old.management.recycled;
		if (
			old?.management &&
			!implicitInitialManagement &&
			compareManagement(old.management, marker.management) === "conflict" &&
			choices[item.markerPath] !== "use"
		)
			throw fail("MARKER_MANAGEMENT_CONFLICT");
		const relation =
				old && !implicitInitialManagement
					? compareManagement(old.management, marker.management)
					: "same",
			replaceSource = item.state === "conflict" && choices[item.markerPath] === "use";
		const sourceSetId =
				item.plannedSourceSetId ||
				(!replaceSource && (old?.sourceSetId || marker.sourceSetId)) ||
				"sources-" + crypto.randomUUID(),
			sourceVersion =
				(!replaceSource && old?.sourceVersion) ||
				marker.sourceVersion ||
				"marker-v1:" + item.markerIdentity;
		const authoritativeManagement =
			relation === "left-newer"
				? old.management
				: marker.management || old?.management || markers.management(null, false);
		Object.assign(location, { sourceSetId, sourceVersion: marker.sourceVersion || sourceVersion });
		const base = {
			schemaVersion: 1,
			revision: 1,
			requiredCapabilities: ["es:task-marker-v1", "es:task-source-only-v1"]
		};
		const task = {
			...(old || base),
			taskId: id,
			displayName:
				(relation === "right-newer" ? marker.name : old?.displayName) || marker.name || item.name,
			createdAt: old?.createdAt || now(),
			engineId: old?.engineId || "unknown",
			taskKind: old?.taskKind || "external-result",
			sourceProjectRef: old?.sourceProjectRef || null,
			groupId: old?.groupId || null,
			latestRunId: old?.latestRunId || null,
			revision: (old?.revision || 0) + 1,
			origin: old?.origin || { kind: "marker-recovered" },
			sourceSetId,
			sourceVersion,
			locations: [
				...(old?.locations || []).filter((row) => row.locationId !== location.locationId),
				location
			],
			management: authoritativeManagement,
			recycleState: authoritativeManagement.recycled ? "recycled" : "active"
		};
		const mutations = [{ kind: "task", id, expectedRevision: old?.revision ?? null, value: task }];
		if (replaceSource) {
			if (old?.sourceSummary) task.sourceSummary = null;
			task.thumbnailStructure = null;
			task.formula = null;
		}
		if (!old?.sourceSetId || replaceSource) {
			const files = [];
			const rawFiles =
				item.directoryManifest?.files?.map((row) => ({
					...row,
					roles: row.roles || [row.role || "other"]
				})) ||
				(item.legacyManifest || item.directoryManifest)?.items
					?.filter((row) => row.included && row.targetPath)
					.map((row) => ({
						...row,
						relativePath: path.basename(row.targetPath),
						name: row.originalName || row.originalRelativePath || path.basename(row.targetPath)
					})) ||
				(marker.main
					? [
							{
								relativePath: marker.main,
								roles: ["other"],
								name: path.basename(marker.main)
							}
						]
					: []);
			for (const raw of rawFiles) {
				const file = path.join(item.directory, markers.relativePath(raw.relativePath));
				noLinks(file);
				if (fs.existsSync(file) && fs.statSync(file).isFile()) {
					if (raw.sha256 && fileHash(file) !== raw.sha256)
						throw fail("LEGACY_ARCHIVE_CONTENT_CHANGED");
					const artifactId =
							item.plannedArtifacts?.find((row) => row.relativePath === raw.relativePath)
								?.artifactId || "artifact-" + crypto.randomUUID(),
						stat = fs.statSync(file);
					files.push({
						artifactId,
						roles: raw.roles || ["other"],
						name: raw.name,
						relativePath: raw.relativePath,
						byteSize: stat.size,
						sha256: raw.sha256 || null,
						sourceId: artifactId,
						required: raw.required !== false,
						format: raw.format || null,
						representation: raw.representation || "text"
					});
					mutations.push({
						kind: "artifact",
						id: artifactId,
						expectedRevision: null,
						value: {
							...base,
							artifactId,
							taskId: id,
							runId: null,
							sourceSetId,
							roles: raw.roles || ["other"],
							originalName: raw.name,
							format: raw.format || null,
							formatVersion: raw.formatVersion || null,
							representation: raw.representation === "binary" ? "binary" : "text",
							locations: [{ environmentId: localEnvironmentId, path: file, role: "original" }],
							provenance: {
								kind: "portable-marker",
								markerPath: item.markerPath,
								...(raw.provenance || {})
							},
							producer: raw.producer || { kind: "external-source" },
							dependencies: raw.dependencies || [],
							companionCandidate: raw.companionCandidate || null,
							byteSize: stat.size,
							integrity: "unknown",
							contentHash: raw.sha256 ? { algorithm: "sha256", hash: raw.sha256 } : null,
							fieldStatus: Object.fromEntries(
								["format", "formatVersion", "contentHash"].map((field) => [
									field,
									{
										state: "unknown",
										reason: "Marker discovery does not infer scientific file content"
									}
								])
							)
						}
					});
				}
			}
			mutations.push({
				kind: "sourceSet",
				id: sourceSetId,
				expectedRevision: null,
				value: {
					...base,
					sourceSetId,
					taskId: id,
					sourceVersion,
					origin: { kind: "postprocess" },
					scope: "external",
					directory: item.directory,
					manifestPath: item.legacyManifestPath || item.directoryManifestPath || item.markerPath,
					files,
					state:
						(item.legacyManifestPath || item.directoryManifestPath) &&
						rawFiles.every(
							(raw) =>
								raw.required === false ||
								files.some(
									(file) =>
										file.relativePath === raw.relativePath &&
										typeof file.sha256 === "string" &&
										/^[a-f0-9]{64}$/i.test(file.sha256)
								)
						)
							? "archived"
							: "external",
					...(item.directoryManifest?.summary ? { summary: item.directoryManifest.summary } : {}),
					...(marker.main ? { main: marker.main } : {})
				}
			});
		}
		if (
			!marker.id ||
			!marker.management ||
			item.legacyManifestPath ||
			choices[item.markerPath] === "new-id"
		)
			markers.writeMarker(
				item.markerPath,
				{ ...marker, id, management: task.management },
				item.legacyManifestPath ? null : item.markerIdentity
			);
		if (commitRecords) commitRecords(mutations);
		else store.commit({ manager, mutations });
		result.push({ taskId: id, outcome: "succeeded", displayName: task.displayName });
	}
	return result;
}
function prepareDiscoveryPlan(candidate, choices, store) {
	verifyDiscovery(candidate);
	const sourceSets = new Map(),
		targets = new Map();
	const add = (kind, id) => targets.set(kind + ":" + id, { kind, id });
	const items = candidate.items.map((original) => {
		const item = { ...original };
		if (choices[item.markerPath] === "skip" || item.marker.deleted) return item;
		const newId = choices[item.markerPath] === "new-id" || !item.marker.id;
		item.plannedTaskId = newId ? "task-" + crypto.randomUUID() : item.marker.id;
		const old = store.read("task", item.plannedTaskId);
		const replace = item.state === "conflict" && choices[item.markerPath] === "use";
		item.plannedSourceSetId = replace
			? "sources-" + crypto.randomUUID()
			: old?.sourceSetId ||
				item.marker.sourceSetId ||
				sourceSets.get(item.plannedTaskId) ||
				"sources-" + crypto.randomUUID();
		sourceSets.set(item.plannedTaskId, item.plannedSourceSetId);
		const manifest = item.legacyManifest || item.directoryManifest;
		const names =
			manifest?.files?.map((file) => file.relativePath) ||
			manifest?.items
				?.filter((file) => file.included && file.targetPath)
				.map((file) => path.basename(file.targetPath)) ||
			(item.marker.main ? [item.marker.main] : []);
		item.plannedArtifacts = names.map((relativePath) => ({
			relativePath,
			artifactId: "artifact-" + crypto.randomUUID()
		}));
		add("task", item.plannedTaskId);
		add("sourceSet", item.plannedSourceSetId);
		for (const file of item.plannedArtifacts) add("artifact", file.artifactId);
		return item;
	});
	return {
		candidate: { ...candidate, items },
		targets: [...targets.values()],
		expectedRevisions: new Map(
			items
				.filter((item) => item.plannedTaskId)
				.map((item) => [
					item.plannedTaskId,
					store.read("task", item.plannedTaskId)?.revision ?? null
				])
		)
	};
}
async function importDiscoveredAsync(options, onProgress = () => {}) {
	const results = [];
	verifyDiscovery(options.candidate);
	for (const item of options.candidate.items) {
		await new Promise((resolve) => setImmediate(resolve));
		if (item.plannedTaskId && options.expectedRevisions)
			item.expectedTaskRevision = options.expectedRevisions.get(item.plannedTaskId);
		const rows = importDiscovered({
			...options,
			candidate: { ...options.candidate, items: [item] }
		});
		for (const row of rows)
			if (row.taskId && options.expectedRevisions)
				options.expectedRevisions.set(
					row.taskId,
					options.store.read("task", row.taskId)?.revision ?? null
				);
		results.push(...rows);
		onProgress({
			completed: results.length,
			total: options.candidate.items.length,
			items: results
		});
	}
	return results;
}
module.exports = {
	discoverDirectory,
	verifyDiscovery,
	importDiscovered,
	prepareDiscoveryPlan,
	importDiscoveredAsync
};
