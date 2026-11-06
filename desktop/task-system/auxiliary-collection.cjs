"use strict";
const crypto = require("node:crypto");
const { fail } = require("./platform/global-settings.cjs");
const { base } = require("./management.cjs");

function fixedSource(candidate, identity, transport, signal, options = {}) {
	let closed = false;
	const lifetime = new AbortController();
	const source = {
		id: candidate.sourceId || `${candidate.runId}:${candidate.candidateId}:${identity.fileId}`,
		name: candidate.relativePath,
		size: identity.byteSize,
		async readRange(start, end, readSignal) {
			if (closed || signal?.aborted || readSignal?.aborted) throw fail("AUX_SOURCE_CLOSED");
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end < start ||
				end > identity.byteSize ||
				(!options.explicitLargeRanges && end - start > 1024 * 1024)
			)
				throw fail("AUX_RANGE_INVALID");
			// Only an explicit legacy caller range may assemble a larger result.
			// Stream pulls and each transport transaction remain bounded at 1 MiB.
			if (end - start > 1024 * 1024) {
				const bytes = new Uint8Array(end - start);
				for (let offset = start; offset < end; offset += 1024 * 1024) {
					const next = Math.min(end, offset + 1024 * 1024);
					bytes.set(await source.readRange(offset, next, readSignal), offset - start);
				}
				return bytes;
			}
			const request = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(readSignal ? [readSignal] : [])]);
			const result = await transport.readRange(
				{ path: candidate.path, identity, offset: start, length: end - start },
				{ signal: request }
			);
			request.throwIfAborted();
			const bytes = Buffer.from(result.bytes || result);
			if (bytes.length !== end - start) throw fail("AUX_SHORT_READ");
			return new Uint8Array(bytes);
		},
		stream() {
			let position = 0;
			const observation = options.observeStream?.();
			return new ReadableStream({
				async pull(controller) {
					try {
						if (closed || signal?.aborted) throw fail("AUX_SOURCE_CLOSED");
						if (position >= identity.byteSize) {
							observation?.end?.();
							controller.close();
							return;
						}
						const end = Math.min(identity.byteSize, position + 1024 * 1024),
							bytes = await source.readRange(position, end, signal);
						observation?.chunk?.(bytes, position);
						position = end;
						controller.enqueue(bytes);
					} catch (error) {
						observation?.error?.(error);
						controller.error(error);
					}
				},
				cancel(reason) { observation?.cancel?.(reason); }
			}, { highWaterMark: 0 });
		},
		close() {
			closed = true;
			lifetime.abort();
		}
	};
	return source;
}
function companionKind(candidate) {
	return {
		"orca-cis": "cis",
		"orca-json": "orca-json",
		"orca-engrad": "engrad",
		"orca-gbw": "gbw",
		"gaussian-checkpoint": "chk"
	}[candidate.formatCandidate];
}
function createAuxiliaryCollector({
	store,
	transportFor,
	runtime,
	resolveOutputCandidates,
	resolveSource,
	manager,
	now = () => new Date().toISOString(),
	onChanged = () => {}
}) {
	const flights = new Map();
	async function collect({ task, run, primaryProvider, signal, isCurrent = () => true }) {
		if (
			!runtime?.classifyScientificCandidate ||
			!resolveOutputCandidates ||
			run.state.executionState !== "ended" ||
			run.state.verificationState !== "verified" ||
			store.describe().migration
		)
			return;
		if (flights.has(run.runId)) return flights.get(run.runId);
		const work = (async () => {
			let primary;
			try {
				const claim = manager(),
					snapshot = store.read("inputSnapshot", run.inputSnapshotId),
					artifacts = store.list("artifact", { runId: run.runId }),
					out =
						artifacts.find((value) => value.artifactId === run.primaryOutputArtifactId) ||
						artifacts.find((value) => value.roles.includes("primary-output")),
					originalLocation =
						out?.locations?.find((value) => value.role === "original") || out?.locations?.[0];
				if (!snapshot || !originalLocation) return;
				const resolvedPrimary = resolveSource ? await resolveSource({ artifactId: out.artifactId, run, signal }) : null;
				const location = resolvedPrimary?.location || originalLocation;
				const transport = resolvedPrimary?.transport || await transportFor(location.environmentId),
					outIdentity = await transport.stat(location.path, { signal }),
					outHash = await transport.hash(
						{ path: location.path, identity: outIdentity, algorithm: "sha256" },
						{ signal }
					),
					previous = store.read("run", run.runId).auxCollectionState;
				if (
					previous?.primaryHash === outHash.hash &&
					(previous?.primaryFileId === outHash.identity.fileId || location.role === "archive") &&
					previous?.completed === true
				)
					return;
				primary = await primaryProvider?.retainClassifierPrimary?.();
				const printedFileReferences = primary
					? primary.index.jobs.flatMap((job) =>
							(job.data.relatedFiles || []).map((reference) => ({
								path: reference.name,
								rawReference: reference.rawReference || reference.name,
								sourceArtifactId: out.artifactId,
								sourceRevision: out.revision,
								sourceLine: reference.sourceLine
							}))
						)
					: [];
				const candidates = await resolveOutputCandidates({
						run,
						inputSnapshot: snapshot,
						workLocation: run.executionIdentity.workLocation,
						printedFileReferences
					}),
					available = [],
					warnings = [];
				const completeWorkArchive = location.role === "archive" && store.list("archiveManifest", { taskId: run.taskId }).some(manifest => manifest.runId === run.runId && manifest.status === "verified" && manifest.fileLayout === "task-relative-v1" && manifest.archiveMode === "default" && manifest.items.every(item => item.included || item.reason === "scratch-excluded"));
				for (const candidate of candidates) {
					try {
						const archived = store.list("archiveManifest", { taskId: run.taskId }).filter(manifest => manifest.runId === run.runId && manifest.status === "verified").flatMap(manifest => manifest.items.filter(item => item.included && item.verificationState === "verified" && item.copyState === "copied" && item.storageState !== "recycled" && item.sourceLocation?.environmentId === candidate.workLocation.environmentId && item.sourceLocation.path === candidate.path).map(item => ({ manifest, item })));
						if (archived.length > 1) throw fail("VERIFIED_ARCHIVE_SOURCE_AMBIGUOUS");
						const archive = archived[0], readLocation = archive ? { environmentId: archive.manifest.targetLocation.environmentId, path: archive.item.targetPath } : { environmentId: candidate.workLocation.environmentId, path: candidate.path };
						if (!archive && (task.workFileState === "cleared" || completeWorkArchive)) continue;
						const t = await transportFor(readLocation.environmentId),
							identity = await t.stat(readLocation.path, { signal });
						if (archive && (identity.fileId !== archive.item.copyIdentity?.fileId || identity.changeToken !== archive.item.copyIdentity?.changeToken || identity.byteSize !== archive.item.byteSize)) throw fail("VERIFIED_ARCHIVE_CONTENT_CHANGED");
						if (identity.isDirectory) continue;
						available.push({ candidate, transport: t, identity, readLocation, archive });
					} catch (error) {
						if (!(
							error.code === "FILE_NOT_FOUND" &&
							error.details?.missing === true &&
							error.details.operation === "stat" &&
							error.details.path === candidate.path
						))
							warnings.push({
								id: candidate.candidateId,
								message: "配套来源暂不可用；主输出保留",
								details: JSON.stringify(
									require("./task-failures.cjs").describeFailure(error, {
										stage: "auxiliary-stat",
										now
									})
								)
							});
					}
				}
				const counts = new Map();
				for (const item of available) {
					const kind = companionKind(item.candidate);
					if (kind) counts.set(kind, (counts.get(kind) || 0) + 1);
				}
				let classified = 0;
				for (const item of available) {
					if (signal?.aborted || !isCurrent()) return;
					const { candidate, identity, readLocation, archive } = item,
						t = item.transport;
					let source;
					try {
						const checked = await t.hash(
								{ path: readLocation.path, identity, algorithm: "sha256" },
								{ signal }
							),
							known = artifacts.find(
								(artifact) =>
									!artifact.roles.includes("input") &&
									artifact.locations?.some(
										(value) =>
											value.environmentId === candidate.workLocation.environmentId &&
											value.path === candidate.path
									)
							),
							artifactId =
								known?.artifactId || archive?.item.artifactId ||
								"artifact-" +
									crypto
										.createHash("sha256")
										.update(`${run.runId}:${candidate.path}`)
										.digest("hex")
										.slice(0, 32),
							cacheKey = `${identity.fileId}:${checked.hash}`;
						if (archive && checked.hash !== archive.item.sha256) throw fail("VERIFIED_ARCHIVE_CONTENT_CHANGED");
						if (known?.classificationCacheKey === cacheKey) continue;
						const inputRefs = candidate.inputDependencyRefs || [],
							inputSame = inputRefs.some((value) => value.contentIdentity?.hash === checked.hash),
							rewritten = !!known?.contentHash?.hash && known.contentHash.hash !== checked.hash,
							origin = inputSame
								? "input-dependency"
								: inputRefs.length ||
									  rewritten ||
									  !run.executionIdentity.executorIdentity?.manifestHash
									? "unknown"
									: "native-produced",
							kind = companionKind(candidate),
							boundary = {
								fileIdentity: checked.identity,
								readByteRange: { start: 0, end: identity.byteSize },
								publishedByteRange: { start: 0, end: identity.byteSize }
							};
						source = fixedSource({ ...candidate, path: readLocation.path }, checked.identity, t, signal);
						const assessment = await runtime.classifyScientificCandidate(
							{
								source,
								provenance: {
									artifactId,
									runId: run.runId,
									fileIdentity: checked.identity,
									contentHash: { algorithm: "sha256", hash: checked.hash },
									sourceBoundary: boundary,
									origin,
									runEvidenceRefs: [
										...(run.state.evidenceRefs || []),
										`manifest:${run.executionIdentity.executorIdentity?.manifestHash || "unverified"}`
									],
									discovery: {
										kind: candidate.discovery.kind,
										primarySourceId: out.artifactId,
										sourceLine: candidate.discovery.sourceLine,
										rawReference: candidate.discovery.rawReference,
										companionKind: kind,
										unambiguous: kind ? counts.get(kind) === 1 : false
									}
								},
								primary: primary || undefined
							},
							{ signal }
						);
						const final = await t.hash(
							{
								path: readLocation.path,
								identity: await t.stat(readLocation.path, { signal }),
								algorithm: "sha256"
							},
							{ signal }
						);
						if (
							final.hash !== checked.hash ||
							final.identity.fileId !== checked.identity.fileId ||
							final.identity.byteSize !== identity.byteSize
						)
							throw fail("AUX_SOURCE_CHANGED");
						if (signal?.aborted || !isCurrent()) return;
						const old = store.read("artifact", artifactId),
							preserved = old?.contentHash?.hash === checked.hash,
							roles = [
								...new Set([
									...(known?.roles || []),
									...(inputSame ? ["input"] : []),
									...assessment.roles
								])
							];
						const value = {
							...(old || base()),
							artifactId,
							runId: run.runId,
							revision: (old?.revision || 0) + 1,
							originalName: candidate.relativePath,
							roles,
							format: assessment.identity.format ?? old?.format ?? null,
							formatVersion: assessment.identity.version ?? null,
							representation:
								assessment.identity.representation === "unknown"
									? old?.representation || "binary"
									: assessment.identity.representation,
							locations: old?.locations || [
								{
									environmentId: candidate.workLocation.environmentId,
									path: candidate.path,
									role: "original"
								}
							],
							provenance: {
								...(old?.provenance || {}),
								kind: old?.provenance?.kind || "controlled-output-candidate",
								originalProducer: old?.provenance?.originalProducer || old?.producer || null,
								discovery: candidate.discovery,
								origin,
								inputDependencyRefs: inputRefs,
								primarySource: { artifactId: out.artifactId, sha256: outHash.hash }
							},
							producer:
								preserved && old?.producer
									? old.producer
									: origin === "unknown"
										? null
										: {
												kind:
													origin === "input-dependency"
														? "submitted-dependency"
														: "verified-execution-workspace",
												runId: run.runId,
												evidenceRefs: run.state.evidenceRefs
											},
							byteSize: identity.byteSize,
							integrity: ["source-changed", "cancelled"].includes(assessment.content.state)
								? "changed-during-read"
								: "complete",
							contentHash: { algorithm: "sha256", hash: checked.hash },
							sourceBoundary: boundary,
							classificationCacheKey: cacheKey,
							candidateAssessment: assessment,
							companionCandidate: assessment.companionCandidate || null,
							compatible: preserved
								? old?.compatible === true
								: assessment.association.scienceState === "confirmed",
							stable: true,
							fieldStatus: {
								...(old?.fieldStatus || {}),
								format: assessment.identity.format
									? { state: "known", evidenceRefs: [`classification:${cacheKey}`] }
									: { state: "unknown", reason: "Content format remains unknown" },
								formatVersion: assessment.identity.version
									? { state: "known", evidenceRefs: [`classification:${cacheKey}`] }
									: { state: "unknown", reason: "Version not established by the source" },
								producer:
									origin === "unknown"
										? { state: "unknown", reason: "Native producer not independently confirmed" }
										: { state: "known", evidenceRefs: run.state.evidenceRefs }
							}
						};
						store.commit({
							manager: claim,
							mutations: [
								{ kind: "artifact", id: artifactId, expectedRevision: old?.revision ?? null, value }
							]
						});
						classified++;
					} catch (error) {
						if (signal?.aborted || !isCurrent()) return;
						warnings.push({
							id: candidate.candidateId,
							message: "配套文件未通过本次核验；保留原件及主输出",
							details: error.code || "AUX_CLASSIFICATION_FAILED"
						});
					} finally {
						await source?.close?.();
					}
				}
				if (signal?.aborted || !isCurrent()) return;
				const current = store.read("run", run.runId);
				store.commit({
					manager: claim,
					mutations: [
						{
							kind: "run",
							id: run.runId,
							expectedRevision: current.revision,
							value: {
								...current,
								revision: current.revision + 1,
								auxCollectionState: {
									primaryArtifactId: out.artifactId,
									primaryFileId: outHash.identity.fileId,
									primaryHash: outHash.hash,
									completed: true,
									checkedAt: now(),
									candidateCount: available.length,
									classifiedCount: classified,
									warnings
								}
							}
						}
					]
				});
				onChanged({ type: "auxiliary-publication", taskId: task.taskId, runId: run.runId });
			} finally {
				await primary?.release?.();
			}
		})();
		flights.set(run.runId, work);
		try {
			return await work;
		} finally {
			flights.delete(run.runId);
		}
	}
	return { collect };
}
module.exports = { createAuxiliaryCollector, fixedSource };
