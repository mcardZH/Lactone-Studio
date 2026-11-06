"use strict";
const path = require("node:path");
const { fail } = require("./platform/global-settings.cjs");
const { listAll } = require("./operation-guards.cjs");
function exactMissing(error, file) {
	return (
		error?.code === "FILE_NOT_FOUND" &&
		error.details?.missing === true &&
		error.details.operation === "stat" &&
		error.details.path === file
	);
}
function descendant(root, file) {
	const relative = path.relative(root, file);
	return (
		relative &&
		relative !== ".." &&
		!relative.startsWith(".." + path.sep) &&
		!path.isAbsolute(relative)
	);
}
function sameWorkIdentity(expected, observed) {
	return !!expected?.fileId && !!expected.changeToken &&
		expected.environmentId === observed?.environmentId && expected.path === observed.path &&
		expected.fileId === observed.fileId && expected.byteSize === observed.byteSize &&
		expected.changeToken === observed.changeToken && expected.modifiedAt === observed.modifiedAt;
}
function failureMetadata(error, location) {
	return { path: location.path, code: error?.code || "SOURCE_UNAVAILABLE", message: String(error?.message || error).slice(0, 512) };
}
function createArtifactSourceResolver({
	store,
	transportFor,
	localEnvironmentId,
	libraryDirectory,
	withRun = (_run, work) => work()
}) {
	// Metadata proof cache only; no source bytes, transport lease or Run is owned.
	const verifiedArchives = new Map();
	return async function resolve({ artifactId, run: requestedRun, signal }) {
		const artifact = store.read("artifact", artifactId),
			run = artifact && store.read("run", artifact.runId);
		if (artifact && artifact.runId === null && !requestedRun) {
			const task = store.read("task", artifact.taskId), set = artifact.sourceSetId && store.read("sourceSet", artifact.sourceSetId);
			if (!task || !set || set.taskId !== task.taskId || task.sourceSetId !== set.sourceSetId) throw fail("ARTIFACT_SOURCE_IDENTITY_MISMATCH");
			const raw = artifact.locations?.find(item => item.role === "archive") || artifact.locations?.[0];
			if (!raw) throw fail("SOURCE_SET_LOCATION_UNAVAILABLE");
			const location = raw.scope === "library" && raw.relativePath ? { ...raw, path: path.resolve(libraryDirectory, raw.relativePath) } : raw;
			if (raw.scope === "library" && !descendant(libraryDirectory, location.path)) throw fail("SOURCE_SET_LOCATION_OUTSIDE_LIBRARY");
			const transport = await transportFor(location.environmentId), identity = await transport.stat(location.path, { signal });
			return { artifact, location, originalLocation: location, transport, identity, sha256: artifact.contentHash?.hash,
				sourceKey: JSON.stringify([task.taskId, set.sourceSetId, set.sourceVersion, location.environmentId, location.path]),
				originalName: artifact.originalName || path.basename(location.path), provenance: { ...artifact.provenance, sourceSetId: set.sourceSetId, sourceVersion: set.sourceVersion } };
		}
		if (!artifact || !run || artifact.taskId != null && artifact.taskId !== run.taskId ||
			(requestedRun && (requestedRun.runId !== run.runId || requestedRun.taskId != null && requestedRun.taskId !== run.taskId)))
			throw fail("ARTIFACT_SOURCE_IDENTITY_MISMATCH");
		const owningTask = store.read("task", run.taskId);
		if (!owningTask || owningTask.taskId !== run.taskId) throw fail("ARTIFACT_SOURCE_IDENTITY_MISMATCH");
		if (owningTask?.latestRunId === run.runId && owningTask.resultsInvalidatedByOverwrite) throw fail("TASK_RESULTS_OVERWRITTEN", "原结果已进入确认覆盖流程，不能继续作为当前结果读取。");
		return withRun(run, async () => {
			const original =
				artifact.locations?.find((item) => item.role === "original") ||
				artifact.locations?.find((item) => !["archive", "recycle"].includes(item.role));
			const cleaned = listAll(store, "cleanupManifest", { taskId: run.taskId })
				.filter((manifest) => manifest.runId === run.runId)
				.flatMap((manifest) => manifest.items || [])
				.filter(
					(item) =>
						item.artifactId === artifactId &&
						item.result?.state === "deleted" &&
						original &&
						item.originalLocation?.environmentId === original.environmentId &&
						item.originalLocation.path === original.path
				);
			let originalError;
			const archived = listAll(store, "archiveManifest", { taskId: run.taskId }).some(manifest => manifest.runId === run.runId && manifest.status === "verified" && manifest.items?.some(item => item.artifactId === artifactId && item.included === true && item.copyState === "copied" && item.verificationState === "verified" && item.storageState !== "recycled"));
			if (original && !cleaned.length && !archived) {
				try {
					const transport = await transportFor(original.environmentId),
						identity = await transport.stat(original.path, { signal });
					return {
						artifact,
						location: original,
						originalLocation: original,
						transport,
						identity,
						sourceKey: JSON.stringify([original.environmentId, original.path, original.role]),
						originalName:
							artifact.originalName || artifact.preparedName || path.basename(original.path),
						provenance: artifact.provenance || {}
					};
				} catch (error) {
					if (!exactMissing(error, original.path)) throw error;
					originalError = error;
				}
			}
			const cleanupArchives = new Set(
				cleaned
					.filter((item) => item.basis?.kind === "verified-archive")
					.map((item) => item.basis.archiveManifestId)
			);
			const candidates = listAll(store, "archiveManifest", { taskId: run.taskId })
				.filter(
					(manifest) =>
						manifest.taskId === run.taskId && manifest.runId === run.runId &&
						manifest.status === "verified" &&
						(!cleanupArchives.size || cleanupArchives.has(manifest.manifestId))
				)
				.flatMap((manifest) =>
					(manifest.items || [])
						.filter(
							(item) =>
								item.artifactId === artifactId &&
								item.included === true &&
								item.copyState === "copied" &&
								item.verificationState === "verified" &&
								item.storageState !== "recycled"
						)
						.map((item) => ({ manifest, item }))
				);
			if (!candidates.length) {
				if (originalError) throw originalError;
				throw fail("VERIFIED_ARCHIVE_SOURCE_UNAVAILABLE");
			}
			if (candidates.length !== 1) throw fail("VERIFIED_ARCHIVE_SOURCE_AMBIGUOUS");
			const { manifest, item } = candidates[0],
				location = {
					environmentId: manifest.targetLocation.environmentId,
					path: item.targetPath,
					role: "archive"
				},
				copy = item.copyIdentity;
			const task = store.read("task", run.taskId), targetRoot = manifest.targetLocation.path;
			const registered = task?.locations?.some(location => {
				const root = location.scope === "library" ? path.resolve(libraryDirectory, location.path) : location.path;
				return location.kind === "archive" && path.isAbsolute(root) && (location.scope !== "library" || descendant(libraryDirectory, root)) && path.resolve(root) === path.resolve(targetRoot);
			});
			const planned = task?.plannedArchiveLocation;
			const authorizedRoot = path.isAbsolute(targetRoot) && (descendant(path.join(libraryDirectory, "archive"), location.path) || registered || planned?.environmentId === localEnvironmentId && path.resolve(planned.path) === path.resolve(targetRoot));
			if (
				location.environmentId !== localEnvironmentId ||
				!authorizedRoot ||
				!descendant(manifest.targetLocation.path, location.path) ||
				!copy ||
				copy.path !== location.path ||
				!copy.fileId ||
				!copy.changeToken ||
				!Number.isSafeInteger(item.byteSize) ||
				item.byteSize < 0 ||
				!/^[a-f0-9]{64}$/.test(item.sha256 || "") ||
				copy.sha256 !== item.sha256 ||
				copy.byteSize !== item.byteSize
			)
				throw fail("VERIFIED_ARCHIVE_IDENTITY_INVALID");
			try {
			const transport = await transportFor(location.environmentId),
				identity = await transport.stat(location.path, { signal });
			if (
				!identity.isRegularFile ||
				identity.fileId !== copy.fileId ||
				identity.changeToken !== copy.changeToken ||
				identity.byteSize !== item.byteSize
			)
				throw fail("VERIFIED_ARCHIVE_SOURCE_CHANGED", {
					stage: "archive-source",
					operation: "stat",
					path: location.path,
					manifestId: manifest.manifestId,
					expected: copy,
					observed: identity
				});
			const proofKey = JSON.stringify([manifest.manifestId, location.path, identity.fileId, identity.byteSize, identity.modifiedAt, identity.changeToken, item.sha256]);
			const checked = verifiedArchives.get(artifactId) === proofKey ? { identity, hash: item.sha256 } : await transport.hash(
				{ path: location.path, identity, algorithm: "sha256" }, { signal });
			if (
				checked.hash !== item.sha256 ||
				checked.identity.fileId !== copy.fileId ||
				checked.identity.byteSize !== item.byteSize ||
				checked.identity.changeToken !== copy.changeToken
			)
				throw fail("VERIFIED_ARCHIVE_SOURCE_CHANGED", {
					stage: "archive-source",
					operation: "hash",
					path: location.path,
					manifestId: manifest.manifestId,
					expectedSha256: item.sha256,
					observedSha256: checked.hash,
					expected: copy,
					observed: checked.identity
				});
			verifiedArchives.delete(artifactId); verifiedArchives.set(artifactId, proofKey);
			if (verifiedArchives.size > 64) verifiedArchives.delete(verifiedArchives.keys().next().value);
			return {
				artifact,
				location,
				originalLocation: item.sourceLocation,
				transport,
				identity: checked.identity,
				sha256: checked.hash,
				sourceKey: JSON.stringify([
					location.environmentId,
					location.path,
					"archive",
					manifest.manifestId,
					copy.fileId,
					copy.changeToken,
					checked.hash
				]),
				originalName:
					artifact.originalName || artifact.preparedName || path.basename(item.sourceLocation.path),
				provenance: {
					...(artifact.provenance || {}),
					originalLocation: item.sourceLocation,
					actualReadLocation: location,
					archive: {
						manifestId: manifest.manifestId,
						artifactId,
						copyIdentity: copy,
						sha256: item.sha256,
						byteSize: item.byteSize
					}
				}
			};
			} catch (error) {
				// Only physical archive loss/content or identity changes permit a
				// proven original fallback. Configuration, links, permissions and
				// cancellation remain authoritative failures, never a bypass route.
				const missing = error?.code === "FILE_NOT_FOUND" && error.details?.missing === true &&
					error.details.operation === "stat" && (error.details.path === targetRoot || descendant(targetRoot, error.details.path || ""));
				if (!missing && !["VERIFIED_ARCHIVE_SOURCE_CHANGED", "FILE_IDENTITY_CHANGED", "FILE_CHANGED_DURING_HASH"].includes(error?.code)) throw error;
				verifiedArchives.delete(artifactId);
				const archiveFailure = { artifactId, manifestId: manifest.manifestId, ...failureMetadata(error, location) };
				const workLocation = run.executionIdentity?.workLocation;
				const workApi = original?.path?.startsWith("/") ? path.posix : path.win32;
				const workRelative = original && workLocation && workApi.relative(workLocation.path, original.path);
				const originals = artifact.locations?.filter(value => value.role === "original") || [];
				const fallbackFailure = (cause, preserveArchiveCode = false) => {
					const workFailure = failureMetadata(cause, original || { path: item.sourceLocation?.path || "" });
					const details = { archiveFailure, workFailure };
					const combined = preserveArchiveCode ? error : fail("ARCHIVE_AND_WORK_SOURCE_UNAVAILABLE", details);
					combined.details = { ...(combined.details || {}), ...details };
					throw combined;
				};
				if (cleaned.length || owningTask?.workFileState === "cleared")
					fallbackFailure(fail("WORK_SOURCE_CLEARED"), true);
				if (!original || originals.length > 1 || !originals.length && artifact.locations.filter(value => !["archive", "recycle"].includes(value.role)).length !== 1 ||
					!workLocation || !workApi.isAbsolute(workLocation.path) || original.environmentId !== workLocation.environmentId ||
					!workRelative || workRelative === ".." || workRelative.startsWith(".." + workApi.sep) || workApi.isAbsolute(workRelative) ||
					item.sourceLocation?.environmentId !== original.environmentId || item.sourceLocation.path !== original.path ||
					item.sourceIdentity?.environmentId !== original.environmentId || item.sourceIdentity.path !== original.path ||
					item.sourceIdentity.byteSize !== item.byteSize || !item.sourceIdentity.fileId || !item.sourceIdentity.changeToken)
					fallbackFailure(fail("ARCHIVE_FALLBACK_SOURCE_PROOF_INVALID"));
				try {
					const transport = await transportFor(original.environmentId), identity = await transport.stat(original.path, { signal });
					if (!identity.isRegularFile || !sameWorkIdentity(item.sourceIdentity, identity)) throw fail("ARCHIVE_FALLBACK_WORK_IDENTITY_CHANGED");
					const checked = await transport.hash({ path: original.path, identity, algorithm: "sha256" }, { signal });
					if (!sameWorkIdentity(item.sourceIdentity, checked.identity) || checked.hash !== item.sha256)
						throw fail("ARCHIVE_FALLBACK_WORK_CONTENT_CHANGED");
					return {
						artifact, location: original, originalLocation: original, transport, identity: checked.identity,
						sha256: checked.hash, archiveFailure,
						sourceKey: JSON.stringify([original.environmentId, original.path, "archive-fallback", manifest.manifestId, checked.identity.fileId, checked.identity.changeToken, checked.hash]),
						originalName: artifact.originalName || artifact.preparedName || workApi.basename(original.path),
						provenance: { ...(artifact.provenance || {}), originalLocation: original, actualReadLocation: original, archiveFailure }
					};
				} catch (workError) { if (signal?.aborted) throw workError; fallbackFailure(workError); }
			}
		});
	};
}
module.exports = { createArtifactSourceResolver, exactMissing };
