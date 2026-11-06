"use strict";
const { verifiedOwnerEndReceipt } = require("../execution/scheduler-end.cjs");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fail, noLinks } = require("../platform/global-settings.cjs");
const markers = require("./markers.cjs");
const { membershipId } = require("./organization.cjs");
const base = (cap) => ({ schemaVersion: 1, revision: 1, requiredCapabilities: cap });
const roles = new Set([
	"input",
	"primary-output",
	"structure",
	"trajectory",
	"wavefunction",
	"modes",
	"restart",
	"diagnostic",
	"scratch",
	"other"
]);
function createSourceTasks({
	store,
	directory,
	manager,
	operations,
	localEnvironmentId = "local-library",
	now = () => new Date().toISOString()
}) {
	function resolveLinkedRun(origin = {}) {
		const task = origin.linkedTaskId && store.read("task", origin.linkedTaskId);
		const runId = origin.linkedRunId || task?.latestRunId || null;
		if (!runId) return { runId: null, ended: true };
		const run = store.read("run", runId);
		if (!run || (origin.linkedTaskId && run.taskId !== origin.linkedTaskId))
			throw fail("SOURCE_LINKED_RUN_IDENTITY_MISMATCH");
		return {
			runId,
			ended:
				run.state.executionState === "ended" &&
				run.state.verificationState === "verified" &&
				!!verifiedOwnerEndReceipt(run),
			reason: "关联运行尚未确认实际结束"
		};
	}
	function registerSourceTask(input) {
		const claim = input.operationId && operations ? null : manager();
		if (claim) store.assertManager(claim);
		const origin = input.sourceOrigin || input.origin;
		if (!resolveLinkedRun(origin).ended) throw fail("SOURCE_RUN_NOT_ENDED");
		const taskId = input.taskId || "task-" + crypto.randomUUID(),
			previous = store.read("task", taskId);
		if (
			previous &&
			previous.sourceSetId &&
			previous.sourceSetId !== input.sourceSetId &&
			(previous.latestRunId || previous.origin?.kind !== "postprocess-saved")
		)
			throw fail("SOURCE_TASK_ALREADY_ASSOCIATED");
		const sourceLocation = input.locations?.[0];
		if (!sourceLocation?.directory || !path.isAbsolute(sourceLocation.directory))
			throw fail("SOURCE_DIRECTORY_REQUIRED");
		const target = path.resolve(sourceLocation.directory);
		noLinks(target);
		const location = markers.locate(directory, target, sourceLocation.role || "archive");
		const manifestPath = sourceLocation.manifestPath || path.join(target, "managed-sources.json");
		if (path.dirname(path.resolve(manifestPath)) !== target)
			throw fail("SOURCE_MANIFEST_OUTSIDE_DIRECTORY");
		noLinks(manifestPath);
		const files = input.files || [],
			sourceSetId = input.sourceSetId;
		const summary = input.summary;
		if (
			summary &&
			(summary.sourceSetId !== sourceSetId ||
				summary.sourceVersion !== input.sourceVersion ||
				!files.some((file) => file.sha256 === summary.sourceSha256))
		)
			throw fail("SOURCE_SUMMARY_IDENTITY_MISMATCH");
		if (!sourceSetId || typeof input.sourceVersion !== "string" || !files.length)
			throw fail("SOURCE_SET_REQUIRED");
		const main =
			input.main ||
			files.find((file) => file.roles.includes("primary-output"))?.relativePath ||
			files.find((file) => file.roles.includes("wavefunction"))?.relativePath ||
			files[0].relativePath;
		markers.relativePath(main);
		const markerFile = path.join(target, "task.ddwz"),
			existingMarker = fs.existsSync(markerFile) ? markers.readMarker(markerFile) : null;
		if (existingMarker?.value.id && existingMarker.value.id !== taskId)
			throw fail("TASK_MARKER_ID_CONFLICT");
		const management =
			previous?.management || existingMarker?.value.management || markers.management(null, false);
		const task = {
			...(previous ||
				base(["es:task-marker-v1", "es:task-source-only-v1", "es:task-multigroup-v1"])),
			revision: (previous?.revision || 0) + 1,
			taskId,
			displayName: input.displayName?.trim() || existingMarker?.value.name || "结果任务",
			createdAt: previous?.createdAt || now(),
			engineId: input.engineId || previous?.engineId || "unknown",
			taskKind: input.taskKind || previous?.taskKind || "external-result",
			sourceProjectRef: previous?.sourceProjectRef || null,
			groupId: previous?.groupId || null,
			latestRunId: previous?.latestRunId || null,
			origin: {
				kind:
					input.origin?.kind === "marker-recovered"
						? "marker-recovered"
						: input.origin?.kind === "external-directory"
							? "external-directory"
							: "postprocess-saved",
				...(input.origin?.sourceKind ? { sourceKind: input.origin.sourceKind } : {})
			},
			sourceSetId,
			sourceVersion: input.sourceVersion,
			management,
			locations: [
				...(previous?.locations || []).filter((row) => row.locationId !== location.locationId),
				{
					...location,
					sourceSetId,
					sourceVersion: input.sourceVersion,
					markerPath:
						location.scope === "library" ? path.relative(directory, markerFile) : markerFile
				}
			],
			recycleState: management.recycled ? "recycled" : "active"
		};
		const mutations = [
			{ kind: "task", id: taskId, expectedRevision: previous?.revision ?? null, value: task }
		];
		const changingSource =
			previous &&
			(previous.sourceSetId !== sourceSetId || previous.sourceVersion !== input.sourceVersion);
		if (changingSource && (previous.latestRunId || previous.origin?.kind !== "postprocess-saved"))
			throw fail("SOURCE_TASK_IMMUTABLE_RUN_OR_ORIGIN");
		if (changingSource && previous.postprocessCache) task.postprocessCache = null;
		if (changingSource && previous.sourceSummary && !summary) task.sourceSummary = null;
		if (changingSource) {
			task.thumbnailStructure = null;
			task.thumbnailSourceVersion = null;
			if (!summary) task.formula = null;
		}
		if (summary) {
			task.sourceSummary = summary;
			task.engineId = summary.engineId || task.engineId;
			task.taskKind = summary.taskKind || task.taskKind;
			const counts = new Map();
			for (const atom of summary.structure?.atoms || []) {
				const element = atom.element?.symbol || atom.element;
				if (typeof element === "string") counts.set(element, (counts.get(element) || 0) + 1);
			}
			task.formula =
				[...counts]
					.sort(([a], [b]) =>
						a === "C" ? -1 : b === "C" ? 1 : a === "H" ? -1 : b === "H" ? 1 : a.localeCompare(b)
					)
					.map(([element, count]) => element + (count > 1 ? count : ""))
					.join("") || null;
		}
		const oldSet = store.read("sourceSet", sourceSetId);
		const preserveSet =
			oldSet?.state === "archived" && oldSet.sourceVersion === input.sourceVersion;
		if (
			preserveSet &&
			(oldSet.files.length !== files.length ||
				files.some(
					(file) =>
						!oldSet.files.some(
							(old) =>
								old.sha256 === file.sha256 &&
								old.name === file.name &&
								old.byteSize === file.byteSize &&
								JSON.stringify(old.roles) === JSON.stringify(file.roles)
						)
				))
		)
			throw fail("SOURCE_SET_VERSION_CONFLICT");
		if (preserveSet && previous?.sourceSummary) task.sourceSummary = previous.sourceSummary;
		if (!preserveSet)
			mutations.push({
				kind: "sourceSet",
				id: sourceSetId,
				expectedRevision: oldSet?.revision ?? null,
				value: {
					...(oldSet || base(["es:task-source-only-v1"])),
					revision: (oldSet?.revision || 0) + 1,
					sourceSetId,
					taskId,
					sourceVersion: input.sourceVersion,
					origin: input.sourceOrigin || { kind: input.origin?.sourceKind || "postprocess" },
					scope: location.scope,
					directory: location.path,
					manifestPath:
						location.scope === "library" ? path.relative(directory, manifestPath) : manifestPath,
					files,
					...(summary ? { summary } : {}),
					...(oldSet && oldSet.sourceVersion !== input.sourceVersion && oldSet.summary && !summary
						? { summary: null }
						: {}),
					...(oldSet && oldSet.sourceVersion !== input.sourceVersion
						? {
								history: [
									...(oldSet.history || []),
									{
										sourceVersion: oldSet.sourceVersion,
										scope: oldSet.scope,
										directory: oldSet.directory,
										manifestPath: oldSet.manifestPath
									}
								]
							}
						: {}),
					state: sourceLocation.role === "external" ? "external" : "archived",
					main
				}
			});
		for (const file of files) {
			markers.relativePath(file.relativePath);
			const absolute = path.join(target, file.relativePath);
			noLinks(absolute);
			const stat = fs.statSync(absolute);
			if (!stat.isFile() || stat.size !== file.byteSize)
				throw fail("SOURCE_ASSET_MISSING_OR_CHANGED");
			if (preserveSet) continue;
			const old = store.read("artifact", file.artifactId);
			mutations.push({
				kind: "artifact",
				id: file.artifactId,
				expectedRevision: old?.revision ?? null,
				value: {
					...(old || base(["es:task-source-only-v1"])),
					revision: (old?.revision || 0) + 1,
					artifactId: file.artifactId,
					taskId,
					sourceSetId,
					runId: null,
					roles: file.roles.filter((role) => roles.has(role)).length
						? file.roles.filter((role) => roles.has(role))
						: ["other"],
					originalName: file.name,
					format: file.format || null,
					formatVersion: null,
					representation: file.representation || "text",
					locations: [
						{
							environmentId: localEnvironmentId,
							path: absolute,
							role: "archive",
							scope: location.scope,
							relativePath:
								location.scope === "library" ? path.relative(directory, absolute) : undefined
						}
					],
					provenance: {
						kind: "managed-source",
						sourceId: file.sourceId,
						sourceVersion: input.sourceVersion,
						originalRoles: file.roles
					},
					producer: { kind: "external-source", origin },
					byteSize: file.byteSize,
					integrity: "complete",
					contentHash: file.sha256 ? { algorithm: "sha256", hash: file.sha256 } : null,
					fieldStatus: {
						format: {
							state: "unknown",
							reason: "Source format is read by the shared scientific reader"
						},
						formatVersion: {
							state: "unknown",
							reason: "Original software version is not inferred from a file name"
						},
						...(file.sha256
							? {}
							: { contentHash: { state: "unknown", reason: "Source content hash not yet frozen" } })
					}
				}
			});
			Object.assign(mutations.at(-1).value, {
				...(file.sourceIdentity ? { sourceIdentity: file.sourceIdentity } : {}),
				...(file.companionCandidate ? { companionCandidate: file.companionCandidate } : {}),
				...(file.dependencies ? { dependencies: file.dependencies } : {})
			});
		}
		for (const groupId of new Set(input.groupIds || [])) {
			const group = store.read("group", groupId);
			if (!group || group.deleted) throw fail("GROUP_NOT_FOUND");
			const id = membershipId(taskId, groupId),
				old = store.read("groupMembership", id);
			if (!old || old.deleted)
				mutations.push({
					kind: "groupMembership",
					id,
					expectedRevision: old?.revision ?? null,
					value: {
						...(old || base(["es:task-multigroup-v1"])),
						revision: (old?.revision || 0) + 1,
						membershipId: id,
						taskId,
						groupId,
						deleted: false
					}
				});
		}
		markers.writeMarker(
			markerFile,
			{
				...(existingMarker?.value || {}),
				version: 1,
				id: taskId,
				name: existingMarker?.value.name || task.displayName,
				date: existingMarker?.value.date || now().slice(0, 10),
				main,
				sourceSetId,
				sourceVersion: input.sourceVersion,
				note: existingMarker?.value.note || "",
				management
			},
			existingMarker?.identity ?? null
		);
		if (input.operationId && operations) operations.commitRecords(input.operationId, mutations);
		else store.commit({ manager: claim, mutations });
		return {
			taskId,
			locationId: location.locationId,
			activeDirectory: preserveSet
				? markers.resolveLocation(directory, { scope: oldSet.scope, path: oldSet.directory })
				: target,
			artifactIds: preserveSet
				? oldSet.files.map((file) => file.artifactId)
				: files.map((file) => file.artifactId)
		};
	}
	function resolveArchivedSourceSet({ taskId, sourceSetId, sourceVersion }) {
		const task = store.read("task", taskId);
		sourceSetId ||= task?.sourceSetId;
		let set = sourceSetId && store.read("sourceSet", sourceSetId);
		sourceVersion ||= set?.sourceVersion;
		if (set && sourceVersion !== set.sourceVersion) {
			const older = set.history?.find((row) => row.sourceVersion === sourceVersion);
			if (older) {
				const manifestFile = markers.resolveLocation(directory, {
					path: older.manifestPath,
					scope: older.scope
				});
				noLinks(manifestFile);
				const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
				if (manifest.sourceSetId !== sourceSetId || manifest.sourceVersion !== sourceVersion)
					throw fail("ARCHIVED_SOURCE_SET_IDENTITY_CONFLICT");
				set = { ...set, ...older, files: manifest.files, summary: manifest.summary, sourceVersion };
			}
		}
		if (
			!task ||
			!set ||
			set.taskId !== taskId ||
			set.sourceVersion !== sourceVersion ||
			set.state !== "archived"
		)
			throw fail("ARCHIVED_SOURCE_SET_REQUIRED");
		const root = markers.resolveLocation(directory, { path: set.directory, scope: set.scope }),
			manifestPath = markers.resolveLocation(directory, {
				path: set.manifestPath,
				scope: set.scope
			});
		noLinks(root);
		noLinks(manifestPath);
		if (!fs.existsSync(manifestPath)) throw fail("ARCHIVED_SOURCE_MANIFEST_MISSING");
		return { task, directory: root, manifestPath, sourceSetId, sourceVersion, files: set.files };
	}
	return { registerSourceTask, resolveLinkedRun, resolveArchivedSourceSet };
}
module.exports = { createSourceTasks };
