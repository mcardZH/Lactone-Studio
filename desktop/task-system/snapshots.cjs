"use strict";
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { iterateRecords } = require("./operation-guards.cjs");
const { fail } = require("./platform/global-settings.cjs");
const { hashFile } = require("./submission.cjs");
const { expectedSnapshotId } = require("./assets/snapshot.cjs");
const { unchanged } = require("./assets/io.cjs");

function requireSnapshotPublication(sources, expected) {
	if (!expected) return;
	const source = sources.find(item => item.artifactId === expected.artifactId);
	if (source?.provenance?.sourceRevision !== expected.revision ||
		!isDeepStrictEqual(source?.provenance?.sourceBoundary, expected.boundary))
		throw fail("SNAPSHOT_SOURCE_VERSION_CHANGED", "当前固定来源与监控页面显示的版本不一致，请刷新后重试。");
}

/** An ended or independently registered source can be read after its monitor owner
 * has retired, provided the exact observed file and published bytes still exist. */
function observedRange(identity, expected) {
	const observed = expected.boundary?.fileIdentity;
	const range = expected.boundary?.publishedByteRange;
	if (!observed?.fileId || !observed.changeToken || !identity?.isRegularFile ||
		!unchanged(observed, identity) || range?.start !== 0 ||
		!Number.isSafeInteger(range.end) || range.end <= 0 || range.end > identity.byteSize)
		throw fail("SNAPSHOT_SOURCE_VERSION_CHANGED", "监控页面显示的来源已变化或不可用，请刷新后重试。");
	return { offset: 0, length: range.end };
}

function observedProvenance(provenance, expected) {
	return expected
		? { ...provenance, sourceBoundary: expected.boundary, sourceRevision: expected.revision }
		: provenance;
}

async function waitForSnapshot(pending, signal) {
	if (!signal) return pending;
	if (signal.aborted) throw fail("SNAPSHOT_CANCELLED");
	let abort;
	try {
		await Promise.race([pending, new Promise((_, reject) => {
			abort = () => reject(fail("SNAPSHOT_CANCELLED"));
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

function createSnapshotGateway({
	assets,
	store,
	monitoring,
	transportFor,
	destination,
	resolveSource
}) {
	const snapshots = new Map(),
		leases = new Map(),
		pendingSnapshots = new Map();
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
		return createLease(owner, id);
	}
	function createLease(owner, id) {
		const leaseId = crypto.randomUUID();
		leases.set(leaseId, { owner, snapshotId: id });
		return { snapshotId: id, leaseId };
	}
	async function releaseLease(leaseId, snapshotId, handle) {
		leases.delete(leaseId);
		// Stop advertising the final handle before its asynchronous removal.
		if (![...leases.values()].some((value) => value.snapshotId === snapshotId))
			snapshots.delete(snapshotId);
		await handle.release();
	}
	async function openFixed(owner, request, { signal, assertSourceVersion, excludedSources } = {}) {
		const expectedId = expectedSnapshotId(request);
		const checkCurrent = () => {
			assertSourceVersion?.();
			if (signal?.aborted) throw fail("SNAPSHOT_CANCELLED");
		};
		checkCurrent();
		let finish;
		if (expectedId) {
			for (;;) {
				const previous = snapshots.get(expectedId);
				if (previous) {
					previous.retain();
					return createLease(owner, expectedId);
				}
				const pending = pendingSnapshots.get(expectedId);
				if (!pending) break;
				await waitForSnapshot(pending, signal);
				checkCurrent();
			}
			pendingSnapshots.set(expectedId, new Promise((resolve) => { finish = resolve; }));
		}
		try {
			const handle = await assets().materializeSnapshot(request, { destination, signal });
			try {
				checkCurrent();
			} catch (error) {
				await handle.release();
				throw error;
			}
			if (excludedSources) handle.snapshot.excludedSources = excludedSources;
			return register(owner, handle);
		} finally {
			if (finish) {
				pendingSnapshots.delete(expectedId);
				finish();
			}
		}
	}
	return {
		async open(owner, { taskId, target }, { signal } = {}) {
			building++;
			buildingTasks.set(taskId, (buildingTasks.get(taskId) || 0) + 1);
			try {
				if (!destination) throw fail("SNAPSHOT_DESTINATION_UNAVAILABLE");
				const task = store.read("task", taskId);
				if (!task) throw fail("TASK_NOT_FOUND");
				const runId = target ? target.runId : task.latestRunId;
				const run = runId == null ? null : store.read("run", runId);
				if (target && runId !== null && (!run || run.taskId !== taskId))
					throw fail("SNAPSHOT_RUN_UNAVAILABLE", "监控页面显示的运行已不可用。");
				const expectedSource = target?.source;
				if (!run) {
					const sourceSet = task.sourceSetId && store.read("sourceSet", task.sourceSetId);
					if (!sourceSet || sourceSet.state === "missing")
						throw fail("SNAPSHOT_SOURCE_UNAVAILABLE");
					if (target && (target.sourceSetId !== sourceSet.sourceSetId ||
						target.sourceVersion !== sourceSet.sourceVersion))
						throw fail("SNAPSHOT_SOURCE_VERSION_CHANGED");
					const sourceTarget = {
						runId: null, sourceSetId: sourceSet.sourceSetId, sourceVersion: sourceSet.sourceVersion,
						source: expectedSource
					};
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
						retained = await monitoring.snapshotSources(taskId, signal, sourceTarget);
					} catch (error) {
						if (
							signal?.aborted ||
							error.code !== "SNAPSHOT_SOURCE_NOT_PREPARED" ||
							(error.detail?.preparedPublication && !expectedSource)
						)
							throw error;
					}
					try {
						assertSourceVersion();
						if (retained) requireSnapshotPublication(retained.sources, expectedSource);
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
								identity = resolved.identity || (await t.stat(resolved.location.path, { signal })),
								expected = expectedSource?.artifactId === artifact.artifactId ? expectedSource : undefined,
								range = expected ? observedRange(identity, expected) : undefined,
								checked = await t.hash({
									path: resolved.location.path,
									identity,
									algorithm: "sha256",
									...(range ? { range } : {})
								}, { signal });
							if (artifact.contentHash?.hash && (!range || range.length === identity.byteSize) &&
								checked.hash !== artifact.contentHash.hash)
								throw fail("SNAPSHOT_SOURCE_CHANGED");
							sources.push({
								artifactId: artifact.artifactId,
								originalName: artifact.originalName,
								environmentId: resolved.location.environmentId,
								path: resolved.location.path,
								identity: checked.identity,
								sha256: checked.hash,
								...(range ? { range } : {}),
								roles: artifact.roles,
								format: artifact.format,
								formatVersion: artifact.formatVersion,
								representation: artifact.representation,
								dependencies: artifact.dependencies || [],
								companionCandidate: artifact.companionCandidate,
								sourceIdentity: artifact.sourceIdentity,
								provenance: observedProvenance(resolved.provenance || artifact.provenance, expected),
								stable: true,
								compatible: artifact.roles.includes("wavefunction")
									? ["molden", "fchk", "wfn", "wfx"].includes(artifact.format)
									: false
							});
						}
						if (!sources.length) throw fail("SNAPSHOT_SOURCE_UNAVAILABLE");
						requireSnapshotPublication(sources, expectedSource);
						return await openFixed(
							owner,
							{
								taskId,
								runId: null,
								sourceSetId: sourceSet.sourceSetId,
								sourceVersion: sourceSet.sourceVersion,
								origin: sourceSet.origin,
								sources
							},
							{ signal, assertSourceVersion }
						);
					} finally {
						await retained?.release?.();
					}
				}
				let retained;
				try {
					retained = await monitoring.snapshotSources(taskId, signal, { runId: run.runId, source: expectedSource });
				} catch (error) {
					if (
						signal?.aborted ||
						run.state.executionState !== "ended" ||
						run.state.verificationState !== "verified" ||
						(expectedSource && error.code !== "SNAPSHOT_SOURCE_NOT_PREPARED")
					)
						throw error;
				}
				try {
					const sources = retained?.sources || [],
						excludedSources = [];
					if (retained) requireSnapshotPublication(sources, expectedSource);
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
									identity = resolved?.identity || (await transport.stat(location.path, { signal })),
									expected = expectedSource?.artifactId === artifact.artifactId ? expectedSource : undefined,
									range = expected ? observedRange(identity, expected) : undefined,
									checked = await transport.hash({
										path: location.path,
										identity,
										algorithm: "sha256",
										...(range ? { range } : {})
									}, { signal });
								if (artifact.roles.includes("primary-output") && !expected &&
									task.latestRunId !== run.runId && !resolved?.sha256 &&
									artifact.contentHash?.hash !== checked.hash)
									throw fail("SNAPSHOT_SOURCE_VERSION_CHANGED", "历史运行的主输出字节无法核对。");
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
									...(range ? { range } : {}),
									roles: artifact.roles,
									format: artifact.format,
									formatVersion: artifact.formatVersion,
									representation: artifact.representation,
									dependencies: artifact.dependencies || [],
									companionCandidate: artifact.companionCandidate,
									provenance: observedProvenance(resolved?.provenance || artifact.provenance, expected),
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
					requireSnapshotPublication(sources, expectedSource);
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
					return await openFixed(
						owner,
						{ taskId, runId: run.runId, sources },
						{ signal, excludedSources }
					);
				} finally {
					await retained?.release?.();
				}
			} finally {
				building--;
				const remaining = buildingTasks.get(taskId) - 1;
				if (remaining) buildingTasks.set(taskId, remaining);
				else buildingTasks.delete(taskId);
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
			await releaseLease(leaseId, snapshotId, handle);
		},
		async releaseOwner(owner) {
			for (const [leaseId, value] of [...leases])
				if (value.owner === owner && leases.has(leaseId))
					await releaseLease(leaseId, value.snapshotId, owned(owner, value.snapshotId, leaseId));
		},
		active: () => leases.size,
		activeIO: () => building,
		usesTask: (taskId) => !!buildingTasks.get(taskId)
	};
}
module.exports = { createSnapshotGateway };
