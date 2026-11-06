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
				if (
					(source.roles || []).includes("wavefunction") &&
					(source.stable !== true || source.compatible !== true || source.range)
				)
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
			const signature = {
				...(request.sourceSetId
					? { sourceSetId: request.sourceSetId, sourceVersion: request.sourceVersion }
					: {}),
				taskId: request.taskId,
				runId: request.runId,
				sources: files.map((x) => ({
					artifactId: x.artifactId,
					fileId: x.provenance?.sourceBoundary?.fileIdentity?.fileId || x.sourceIdentity.fileId,
					environmentId:
						x.provenance?.originalLocation?.environmentId || x.originalLocation.environmentId,
					range:
						x.provenance?.sourceBoundary?.publishedByteRange ||
						x.provenance?.sourceBoundary?.readByteRange ||
						x.range,
					sha256: x.sha256
				})),
				jobRef: request.jobRef ?? null,
				stageRef: request.stageRef ?? null,
				frameRef: request.frameRef ?? null
			};
			const snapshotId = "snapshot-" + digest(JSON.stringify(signature));
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
module.exports = { createSnapshot };
