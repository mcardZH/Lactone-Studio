"use strict";
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { iterateRecords } = require("./operation-guards.cjs");
const { fail } = require("./platform/global-settings.cjs");
const { hashFile } = require("./submission.cjs");
function createSnapshotGateway({
	assets,
	store,
	monitoring,
	transportFor,
	destination,
	resolveSource
}) {
	const snapshots = new Map(),
		leases = new Map();
	const libraryId = store.describe().libraryId;
	let building = 0;
	const buildingTasks = new Map();
	function owned(owner, snapshotId, leaseId) {
		const value = leases.get(leaseId);
		if (!value || value.owner !== owner || value.snapshotId !== snapshotId)
			throw fail("SNAPSHOT_LEASE_INVALID");
		const handle = snapshots.get(snapshotId);
		if (!handle) throw fail("SNAPSHOT_RELEASED");
		return handle;
	}
	function register(owner, handle) {
		const id = handle.snapshot.snapshotId,
			previous = snapshots.get(id);
		if (previous) {
			void handle.release();
			handle = previous;
			handle.retain();
		} else snapshots.set(id, handle);
		const leaseId = crypto.randomUUID();
		leases.set(leaseId, { owner, snapshotId: id });
		return { snapshotId: id, leaseId };
	}
	return {
		async open(owner, { taskId }, { signal } = {}) {
			building++;
			buildingTasks.set(taskId, (buildingTasks.get(taskId) || 0) + 1);
			try {
				if (!destination) throw fail("SNAPSHOT_DESTINATION_UNAVAILABLE");
				const task = store.read("task", taskId),
					run = task && store.read("run", task.latestRunId);
				if (!task) throw fail("TASK_NOT_FOUND");
				if (!run) {
					const sourceSet = task.sourceSetId && store.read("sourceSet", task.sourceSetId);
					if (!sourceSet || sourceSet.state === "missing")
						throw fail("SNAPSHOT_SOURCE_UNAVAILABLE");
					let retained;
					const assertSourceVersion = () => {
						const currentTask = store.read("task", taskId),
							currentSet = store.read("sourceSet", sourceSet.sourceSetId);
						if (
							currentTask?.sourceSetId !== sourceSet.sourceSetId ||
							currentTask?.sourceVersion !== sourceSet.sourceVersion ||
							currentSet?.sourceVersion !== sourceSet.sourceVersion
						)
							throw fail("SNAPSHOT_SOURCE_VERSION_CHANGED");
					};
					try {
						retained = await monitoring.snapshotSources(taskId, signal);
					} catch (error) {
						if (
							signal?.aborted ||
							error.code !== "SNAPSHOT_SOURCE_NOT_PREPARED" ||
							error.detail?.preparedPublication
						)
							throw error;
					}
					try {
						assertSourceVersion();
						const sources = (retained?.sources || [])
							.filter((source) => source.roles?.includes("primary-output"))
							.map((source) => {
								const artifact = store.read("artifact", source.artifactId),
									boundary = source.provenance?.sourceBoundary;
								if (
									!artifact ||
									artifact.sourceSetId !== sourceSet.sourceSetId ||
									!sourceSet.files.some((file) => file.artifactId === artifact.artifactId) ||
									!boundary?.publishedByteRange ||
									!Number.isSafeInteger(boundary.publishedByteRange.end) ||
									!Number.isSafeInteger(boundary.publishedByteRange.start) ||
									boundary.publishedByteRange.start < 0 ||
									boundary.publishedByteRange.end < boundary.publishedByteRange.start ||
									source.provenance?.sourceSetId !== sourceSet.sourceSetId ||
									source.provenance?.sourceVersion !== sourceSet.sourceVersion ||
									!boundary.fileIdentity
								)
									throw fail("SNAPSHOT_RETAINED_SOURCE_IDENTITY_INVALID");
								return {
									...source,
									provenance: {
										...source.provenance,
										sourceSetId: sourceSet.sourceSetId,
										sourceVersion: sourceSet.sourceVersion,
										fullSourceContentIdentity:
											sourceSet.state === "archived" ? artifact.contentHash : null,
										fullSourceByteSize: sourceSet.state === "archived" ? artifact.byteSize : null
									}
								};
							});
						for (const artifact of iterateRecords(store, "artifact", { taskId })) {
							if (
								artifact.sourceSetId !== sourceSet.sourceSetId ||
								!sourceSet.files.some((file) => file.artifactId === artifact.artifactId)
							)
								continue;
							if (sources.some((source) => source.artifactId === artifact.artifactId)) continue;
							const resolved = await resolveSource({
									artifactId: artifact.artifactId,
									run: null,
									signal
								}),
								t = resolved.transport,
								identity = resolved.identity || (await t.stat(resolved.location.path)),
								checked = await t.hash({
									path: resolved.location.path,
									identity,
									algorithm: "sha256"
								});
							if (artifact.contentHash?.hash && checked.hash !== artifact.contentHash.hash)
								throw fail("SNAPSHOT_SOURCE_CHANGED");
							sources.push({
								artifactId: artifact.artifactId,
								originalName: artifact.originalName,
								environmentId: resolved.location.environmentId,
								path: resolved.location.path,
								identity: checked.identity,
								sha256: checked.hash,
								roles: artifact.roles,
								format: artifact.format,
								formatVersion: artifact.formatVersion,
								representation: artifact.representation,
								dependencies: artifact.dependencies || [],
								companionCandidate: artifact.companionCandidate,
								sourceIdentity: artifact.sourceIdentity,
								provenance: artifact.provenance,
								stable: true,
								compatible: artifact.roles.includes("wavefunction")
									? ["molden", "fchk", "wfn", "wfx"].includes(artifact.format)
									: false
							});
						}
						if (!sources.length) throw fail("SNAPSHOT_SOURCE_UNAVAILABLE");
						assertSourceVersion();
						const handle = await assets().materializeSnapshot(
							{
								taskId,
								runId: null,
								sourceSetId: sourceSet.sourceSetId,
								sourceVersion: sourceSet.sourceVersion,
								origin: sourceSet.origin,
								sources
							},
							{ destination, signal }
						);
						try {
							assertSourceVersion();
						} catch (error) {
							await handle.release();
							throw error;
						}
						if (signal?.aborted) {
							await handle.release();
							throw fail("SNAPSHOT_CANCELLED");
						}
						return register(owner, handle);
					} finally {
						await retained?.release?.();
					}
				}
				let retained;
				try {
					retained = await monitoring.snapshotSources(taskId, signal);
				} catch (error) {
					if (
						signal?.aborted ||
						run.state.executionState !== "ended" ||
						run.state.verificationState !== "verified"
					)
						throw error;
				}
				try {
					const sources = retained?.sources || [],
						excludedSources = [];
					if (run.state.executionState === "ended" && run.state.verificationState === "verified")
						for (const artifact of iterateRecords(store, "artifact", { runId: run.runId })) {
							if (sources.some((source) => source.artifactId === artifact.artifactId)) continue;
							if (
								!artifact.roles.some((x) =>
									["primary-output", "wavefunction", "trajectory", "modes"].includes(x)
								) &&
								!(
									artifact.companionCandidate?.rawReadable &&
									artifact.companionCandidate.originVerified &&
									artifact.companionCandidate.unambiguous
								)
							)
								continue;
							if (artifact.roles.includes("wavefunction") && artifact.compatible !== true) continue;
							try {
								const resolved = resolveSource
									? await resolveSource({ artifactId: artifact.artifactId, run, signal })
									: null;
								const location =
									resolved?.location ||
									artifact.locations?.find((x) => x.role === "archive") ||
									artifact.locations?.[0];
								if (!location) continue;
								const transport =
										resolved?.transport || (await transportFor(location.environmentId)),
									identity = resolved?.identity || (await transport.stat(location.path)),
									checked = await transport.hash({
										path: location.path,
										identity,
										algorithm: "sha256"
									});
								if (
									artifact.contentHash?.hash &&
									artifact.contentHash.hash !== checked.hash &&
									!artifact.roles.includes("primary-output")
								)
									throw fail("SNAPSHOT_AUX_CONTENT_CHANGED");
								sources.push({
									artifactId: artifact.artifactId,
									originalName:
										resolved?.originalName || artifact.originalName || artifact.preparedName,
									environmentId: location.environmentId,
									path: location.path,
									identity: checked.identity,
									sha256: checked.hash,
									roles: artifact.roles,
									format: artifact.format,
									formatVersion: artifact.formatVersion,
									representation: artifact.representation,
									dependencies: artifact.dependencies || [],
									companionCandidate: artifact.companionCandidate,
									provenance: resolved?.provenance || artifact.provenance,
									stable: true,
									compatible: artifact.compatible === true
								});
							} catch (error) {
								if (signal?.aborted || artifact.roles.includes("primary-output")) throw error;
								excludedSources.push({
									artifactId: artifact.artifactId,
									reason: error.code || "AUX_SOURCE_UNAVAILABLE"
								});
							}
						}
					if (!sources.length) {
						throw fail("SNAPSHOT_SOURCE_UNAVAILABLE");
					}
					const primarySource = sources.find((source) => source.roles.includes("primary-output"));
					for (let index = sources.length - 1; index >= 0; index--) {
						const candidate = sources[index];
						if (
							candidate.companionCandidate &&
							candidate.provenance?.primarySource?.sha256 &&
							primarySource?.sha256 &&
							candidate.provenance.primarySource.sha256 !== primarySource.sha256
						) {
							excludedSources.push({
								artifactId: candidate.artifactId,
								reason: "AUX_PRIMARY_VERSION_CHANGED"
							});
							sources.splice(index, 1);
						}
					}
					const handle = await assets().materializeSnapshot(
						{ taskId, runId: run.runId, sources },
						{ destination, signal }
					);
					handle.snapshot.excludedSources = excludedSources;
					if (signal?.aborted) {
						await handle.release();
						throw fail("SNAPSHOT_CANCELLED");
					}
					const registered = register(owner, handle);
					return registered;
				} finally {
					await retained?.release?.();
				}
			} finally {
				building--;
				buildingTasks.set(taskId, buildingTasks.get(taskId) - 1);
			}
		},
		describe(owner, { snapshotId, leaseId }) {
			if (!leaseId)
				leaseId = [...leases.entries()].find(
					([, value]) => value.owner === owner && value.snapshotId === snapshotId
				)?.[0];
			const handle = owned(owner, snapshotId, leaseId);
			return {
				snapshotId,
				leaseId,
				taskId: handle.snapshot.taskId,
				runId: handle.snapshot.runId,
				sourceSetId: handle.snapshot.sourceSetId,
				sourceVersion: handle.snapshot.sourceVersion,
				origin: handle.snapshot.origin,
				libraryId,
				contentIdentity: handle.snapshot.contentIdentity,
				preparationState: handle.snapshot.preparationState,
				excludedSources: handle.snapshot.excludedSources || [],
				files: handle.files.map((file) => ({
					artifactId: file.artifactId,
					sourceRef: file.artifactId,
					name: file.originalName,
					byteSize: file.byteSize,
					sha256: file.sha256,
					roles: file.roles,
					format: file.format ?? null,
					formatVersion: file.formatVersion ?? null,
					representation: file.representation || "unknown",
					dependencies: file.dependencies || [],
					companionCandidate: file.companionCandidate || null,
					provenance: file.provenance || null,
					sourceIdentity: file.classificationSourceIdentity || file.sourceIdentity,
					range: file.range
				}))
			};
		},
		retain(owner, { snapshotId, leaseId }) {
			const handle = owned(owner, snapshotId, leaseId);
			handle.retain();
			const next = crypto.randomUUID();
			leases.set(next, { owner, snapshotId });
			return { snapshotId, leaseId: next };
		},
		async readRange(owner, { snapshotId, leaseId, sourceRef, offset, length }) {
			const handle = owned(owner, snapshotId, leaseId),
				file = handle.files.find((value) => value.artifactId === sourceRef);
			if (
				!file ||
				!Number.isSafeInteger(offset) ||
				!Number.isSafeInteger(length) ||
				offset < 0 ||
				length < 0 ||
				length > 1024 * 1024 ||
				offset + length > file.byteSize
			)
				throw fail("SNAPSHOT_RANGE_INVALID");
			const fd = await fs.open(file.path, "r");
			try {
				const bytes = Buffer.alloc(length),
					result = await fd.read(bytes, 0, length, offset);
				if (result.bytesRead !== length) throw fail("SNAPSHOT_BYTES_INCOMPLETE");
				return { bytes: new Uint8Array(bytes), offset, length, sha256: file.sha256 };
			} finally {
				await fd.close();
			}
		},
		async describeSource(owner, { snapshotId, leaseId, sourceRef }) {
			const handle = owned(owner, snapshotId, leaseId),
				file = handle.files.find((value) => value.artifactId === sourceRef);
			if (!file) throw fail("SNAPSHOT_SOURCE_NOT_FOUND");
			const actual = await hashFile(file.path);
			if (actual.hash !== file.sha256 || actual.byteSize !== file.byteSize)
				throw fail("SNAPSHOT_SOURCE_CHANGED");
			return {
				path: file.path,
				name: file.originalName,
				byteSize: file.byteSize,
				sha256: file.sha256
			};
		},
		has(owner, snapshotId) {
			return [...leases.values()].some(
				(value) => value.owner === owner && value.snapshotId === snapshotId
			);
		},
		async release(owner, { snapshotId, leaseId }) {
			const handle = owned(owner, snapshotId, leaseId);
			leases.delete(leaseId);
			await handle.release();
			if (![...leases.values()].some((value) => value.snapshotId === snapshotId))
				snapshots.delete(snapshotId);
		},
		async releaseOwner(owner) {
			for (const [leaseId, value] of [...leases])
				if (value.owner === owner) {
					leases.delete(leaseId);
					await snapshots.get(value.snapshotId)?.release();
					if (![...leases.values()].some((x) => x.snapshotId === value.snapshotId))
						snapshots.delete(value.snapshotId);
				}
		},
		active: () => leases.size,
		activeIO: () => building,
		usesTask: (taskId) => !!buildingTasks.get(taskId)
	};
}
module.exports = { createSnapshotGateway };
