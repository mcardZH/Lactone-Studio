"use strict";
const {
	fs,
	path,
	crypto,
	fail,
	digest,
	clone,
	ensureDirectory,
	exclusiveDirectory,
	hashLocal,
	atomicJSON,
	copySource,
	removeExact
} = require("./io.cjs");
const { base, safeName } = require("./common.cjs");
function snapshotSourceIdentity(source, fileId, environmentId, range, sha256) {
	return {
		artifactId: source.artifactId,
		fileId: source.provenance?.sourceBoundary?.fileIdentity?.fileId || fileId,
		environmentId: source.provenance?.originalLocation?.environmentId || environmentId,
		range:
			source.provenance?.sourceBoundary?.publishedByteRange ||
			source.provenance?.sourceBoundary?.readByteRange ||
			range,
		sha256
	};
}
function snapshotIdFor(request, sources) {
	return "snapshot-" + digest(JSON.stringify({
		...(request.sourceSetId
			? { sourceSetId: request.sourceSetId, sourceVersion: request.sourceVersion }
			: {}),
		taskId: request.taskId,
		runId: request.runId,
		sources,
		jobRef: request.jobRef ?? null,
		stageRef: request.stageRef ?? null,
		frameRef: request.frameRef ?? null
	}));
}
function unstableWavefunction(source) {
	return (source.roles || []).includes("wavefunction") &&
		(source.stable !== true || source.compatible !== true || source.range);
}
/** Only already verified source descriptors can identify an existing fixed copy.
 * Unverified requests continue through the ordinary materialization path. */
function expectedSnapshotId(request) {
	const identities = [];
	for (const source of request.sources || []) {
		const identity = source.identity;
		const range = source.range || { offset: 0, length: identity?.byteSize };
		if (
			!identity?.fileId || identity.isDirectory ||
			!/^[a-f0-9]{64}$/.test(source.sha256 || "") ||
			unstableWavefunction(source) ||
			![range.offset, range.length, identity.byteSize].every(Number.isSafeInteger) ||
			range.offset < 0 || range.length < 0 || range.offset + range.length > identity.byteSize
		) return;
		identities.push(snapshotSourceIdentity(source, identity.fileId, source.environmentId, range, source.sha256));
	}
	return snapshotIdFor(request, identities);
}
function createSnapshot(context) {
	const { fault, transport, location } = context;
	async function materializeSnapshot(request, { destination, lease, signal } = {}) {
		if (!path.isAbsolute(destination)) throw fail("ASSET_SNAPSHOT_DESTINATION_REQUIRED");
		lease?.assertActive?.();
		await ensureDirectory(destination);
		const directory = path.join(destination, "snapshot-candidate-" + crypto.randomUUID());
		await exclusiveDirectory(directory);
		const files = [],
			owned = [],
			createdPaths = [];
		try {
			for (const source of request.sources || []) {
				lease?.assertActive?.();
				if (unstableWavefunction(source))
					throw fail("ASSET_WAVEFUNCTION_NOT_STABLE_COMPATIBLE");
				const target = path.join(directory, safeName(source.artifactId) + ".asset");
				createdPaths.push(target);
				const copy = await copySource(source, target, {
					transport: await transport(source.environmentId),
					signal,
					fault
				});
				owned.push(copy);
				files.push({
					artifactId: source.artifactId,
					path: target,
					originalName: source.originalName || path.basename(source.path),
					...(source.provenance ? { provenance: clone(source.provenance) } : {}),
					...(source.sourceIdentity
						? { classificationSourceIdentity: clone(source.sourceIdentity) }
						: {}),
					...Object.fromEntries(
						["format", "formatVersion", "representation", "dependencies", "companionCandidate"]
							.filter((key) => Object.hasOwn(source, key) && source[key] !== undefined)
							.map((key) => [key, clone(source[key])])
					),
					byteSize: copy.byteSize,
					sha256: copy.sha256,
					roles: source.roles || [],
					originalLocation: { environmentId: source.environmentId, path: source.path },
					sourceIdentity: source.identity,
					range: copy.sourceRange
				});
			}
			lease?.assertActive?.();
			const snapshotId = snapshotIdFor(request, files.map((file) => snapshotSourceIdentity(
				file, file.sourceIdentity.fileId, file.originalLocation.environmentId, file.range, file.sha256
			)));
			const snapshot = {
				...base(),
				...(request.runId === null
					? {
							requiredCapabilities: ["es:task-source-only-v1"],
							sourceSetId: request.sourceSetId,
							sourceVersion: request.sourceVersion,
							origin: request.origin
						}
					: {}),
				snapshotId,
				taskId: request.taskId,
				runId: request.runId,
				sources: clone(request.sources || []),
				contentIdentity: {
					algorithm: "sha256",
					hash: digest(
						JSON.stringify(
							files.map((x) => ({ artifactId: x.artifactId, sha256: x.sha256, range: x.range }))
						)
					)
				},
				independentSources: files.map((x) => ({ ...x, location: location(x.path) })),
				preparationState: { sourcesReady: true, playbackReady: false },
				jobRef: request.jobRef ?? null,
				stageRef: request.stageRef ?? null,
				frameRef: request.frameRef ?? null
			};
			const metadataPath = path.join(directory, "snapshot.json");
			createdPaths.push(metadataPath);
			await atomicJSON(metadataPath, snapshot);
			owned.push(await hashLocal(metadataPath));
			let refs = 1,
				released = false;
			const handle = {
				snapshot,
				files,
				retain() {
					if (released) throw fail("ASSET_SNAPSHOT_RELEASED");
					refs++;
					return handle;
				},
				async release() {
					if (released) return;
					if (--refs > 0) return;
					released = true;
					const results = [];
					for (const item of owned) {
						try {
							results.push(await removeExact(directory, item));
						} catch (error) {
							results.push({ path: item.path, removed: false, error: error.code || String(error) });
						}
					}
					if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
					return results;
				}
			};
			lease?.onDispose?.(() => handle.release());
			return handle;
		} catch (error) {
			// Only names created by this exclusive snapshot attempt, never a directory glob.
			for (const file of createdPaths)
				try {
					await removeExact(directory, await hashLocal(file));
				} catch (cleanupError) {
					if (cleanupError.code !== "ENOENT")
						(error.cleanupIssues ||= []).push({
							path: file,
							error: cleanupError.code || String(cleanupError)
						});
				}
			if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
			throw error;
		}
	}

	return { materializeSnapshot };
}
module.exports = { createSnapshot, expectedSnapshotId };
