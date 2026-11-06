"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { fail } = require("./platform/global-settings.cjs");
const { fixedSource } = require("./auxiliary-collection.cjs");
function descriptor(artifact, sourceSet) {
	const file = sourceSet.files?.find((item) => item.artifactId === artifact.artifactId);
	return {
		artifactId: artifact.artifactId,
		sourceId: file?.sourceId || artifact.provenance?.sourceId,
		name: file?.name || artifact.originalName || "source",
		byteSize: file?.byteSize ?? artifact.byteSize ?? 0,
		sha256: file?.sha256 || file?.revision || artifact.contentHash?.hash,
		roles: artifact.roles || file?.roles || [],
		relativePath: file?.relativePath,
		format: artifact.format || file?.format || null
	};
}
function mainSource(files, sourceSet) {
	const main = sourceSet.main?.replace(/\\/g, "/");
	if (main) {
		const matches = files.filter(file => file.relativePath?.replace(/\\/g,"/") === main || file.name.replace(/\\/g,"/") === main);
		if (matches.length !== 1) throw fail(matches.length ? "SOURCE_SET_MAIN_AMBIGUOUS" : "SOURCE_SET_MAIN_UNAVAILABLE");
		return matches[0];
	}
	return (
		files.find((file) => file.roles.includes("primary-output")) ||
		files.find((file) => file.roles.includes("wavefunction")) ||
		files.find((file) =>
			file.roles.some((role) => ["trajectory", "structure", "modes"].includes(role))
		) ||
		files[0]
	);
}
function summaryReplacesMain(saved, main) {
	return (
		saved &&
		main &&
		saved.artifactId === main.artifactId &&
		saved.roles.includes("wavefunction") &&
		["molden", "fchk"].includes(saved.format)
	);
}
function reuseHeaderObservation(selected, receipt) {
	const base = selected.transport, before = receipt.before, after = receipt.after;
	if (!base.readObservedRange || receipt.offset !== 0 || !before || !after || before.fileId !== after.fileId || before.byteSize !== after.byteSize || before.modifiedAt !== after.modifiedAt || before.changeToken !== after.changeToken) return selected;
	let cached = receipt;
	return { ...selected, releaseObservation() { cached = null; }, transport: { ...base,
		async readObservedRange(input,io) {
			const head = cached; cached = null;
			if (!head || input.offset !== 0 || input.length < head.bytes.length || input.identity?.fileId !== head.before.fileId || input.identity?.path !== head.before.path || input.identity?.environmentId !== head.before.environmentId || input.identity?.changeToken !== head.before.changeToken || input.identity?.modifiedAt !== head.before.modifiedAt) return base.readObservedRange(input,io);
			io?.signal?.throwIfAborted();
			if (input.length === head.bytes.length) return head;
			const tail = await base.readObservedRange({...input,offset:head.bytes.length,length:input.length-head.bytes.length},io), bytes = Buffer.concat([Buffer.from(head.bytes),Buffer.from(tail.bytes)]);
			return {offset:0,length:bytes.length,bytes,before:head.before,after:tail.after,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),observedEnd:input.length};
		}
	} };
}
function memoryFile(bytes, source) {
	let closed = false;
	return {
		id: source.id,
		name: source.name,
		size: bytes.length,
		async readRange(start, end, signal) {
			signal?.throwIfAborted();
			if (closed) throw fail("SOURCE_MONITOR_DISPOSED");
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end < start ||
				end > bytes.length
			)
				throw fail("INVALID_BYTE_RANGE");
			return new Uint8Array(bytes.subarray(start, end));
		},
		stream() {
			let offset = 0;
			return new ReadableStream({
				pull(controller) {
					if (closed) {
						controller.error(fail("SOURCE_MONITOR_DISPOSED"));
						return;
					}
					if (offset >= bytes.length) {
						controller.close();
						return;
					}
					const end = Math.min(bytes.length, offset + 1024 * 1024);
					controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
					offset = end;
				}
			});
		},
		close() {
			closed = true;
		}
	};
}
async function chooseSourceOnlyMonitor(options) {
	const { runtime, sourceSet, artifacts, resolveSource, transportFor, signal } = options;
	const files = artifacts.map((artifact) => descriptor(artifact, sourceSet));
	const chosen = mainSource(files, sourceSet);
	if (sourceSet.summary) {
		try {
			const saved = runtime.validateSourceMonitorSummary(
				sourceSet.summary,
				sourceSet.sourceSetId,
				sourceSet.sourceVersion,
				files
			);
			if (summaryReplacesMain(saved, chosen)) return true;
			// A last-frame projection may thumbnail any source. It is not the
			// complete OUT, trajectory or modes source used by task details.
			options.ignoreSummary = true;
		} catch (error) {
			options.ignoreSummary = true;
			options.summaryWarning = String(error.message || error);
		}
	}
	const artifact = artifacts.find((item) => item.artifactId === chosen?.artifactId);
	if (!artifact) return true;
	const selected = resolveSource
		? await resolveSource({ artifactId: artifact.artifactId, signal })
		: {
				location: artifact.locations[0],
				transport: await transportFor(artifact.locations[0].environmentId)
			};
	const identity =
			selected.identity || (await selected.transport.stat(selected.location.path, { signal })),
		limit = Math.min(identity.byteSize, 1024 * 1024);
	const receipt = selected.transport.readObservedRange
		? await selected.transport.readObservedRange(
				{ path: identity.path, identity, offset: 0, length: limit },
				{ signal }
			)
		: await selected.transport.readRange(
				{ path: identity.path, identity, offset: 0, length: limit },
				{ signal }
			);
	signal?.throwIfAborted();
	// Recognition's 1 MiB is a continuation block, never a total identity gate.
	// Preserve the first observation for the eventual reader while exposing the
	// complete frozen source to the recognizer's existing range loop.
	const head = fixedSource({ sourceId: artifact.artifactId,
		relativePath: artifact.originalName || path.basename(identity.path), path: identity.path }, identity,
		{ async readRange(input, io) {
			if (input.offset === 0 && input.length === receipt.bytes.length) return receipt;
			const next = await selected.transport.readRange(input, io);
			if (next.before.fileId !== identity.fileId || next.after.fileId !== identity.fileId ||
				next.before.byteSize !== identity.byteSize || next.after.byteSize !== identity.byteSize ||
				next.before.modifiedAt !== identity.modifiedAt || next.after.modifiedAt !== identity.modifiedAt ||
				next.before.changeToken !== identity.changeToken || next.after.changeToken !== identity.changeToken)
				throw fail("SOURCE_SET_CHANGED_DURING_READ");
			return next;
		} }, signal);
	try {
		const kind = await runtime.recognizeMonitorSource(head);
		if (kind.status === "conflict") throw fail("SOURCE_CONTENT_CONFLICT", { artifactId: artifact.artifactId, recognition: kind });
		// Selection and content recognition are one decision. Keep the original
		// artifact identity/roles and pass this observation to the chosen reader.
		options.sourceSelection = {
			artifactId: artifact.artifactId,
			recognition: kind,
			source: reuseHeaderObservation({ ...selected, identity, originalLocation: selected.originalLocation || selected.location,
				sourceKey: selected.sourceKey || JSON.stringify([selected.location.environmentId,selected.location.path,selected.location.role]),
				originalName: selected.originalName || chosen.name, provenance: selected.provenance || artifact.provenance || {} },receipt)
		};
		return !(kind.format === "output" && ["gaussian", "orca"].includes(kind.software));
	} finally {
		head.close();
	}
}
async function createHostSourceOnlyMonitor(options) {
	const { runtime, task, sourceSet, artifacts, resolveSource, transportFor, onProgress } = options;
	const files = artifacts.map((artifact) => descriptor(artifact, sourceSet));
	let initialSelection = options.sourceSelection;
	let current = null,
		identityKey = null,
		disposed = false,
		revision = 0,
		sequence = 0,
		flight = null,
		active = null,
		managerEpoch = options.epoch;
	const lifetime = new AbortController();
	return {
		async refresh({ signal, epoch }) {
			if (disposed) throw fail("SOURCE_MONITOR_DISPOSED");
			while (flight && epoch !== managerEpoch) {
				active?.abort();
				await flight.catch(() => {});
				if (disposed) throw fail("SOURCE_MONITOR_DISPOSED");
			}
			if (flight) return flight;
			managerEpoch = epoch;
			active = new AbortController();
			const request = AbortSignal.any([
					lifetime.signal,
					active.signal,
					...(signal ? [signal] : [])
				]),
				operationId = `${sourceSet.sourceSetId}:read:${++revision}`;
			let phase,
				started = performance.now();
			const report = (stage, counts = {}) => {
				if (request.aborted) return;
				if (phase !== stage) {
					phase = stage;
					started = performance.now();
				}
				try {
					onProgress?.({
						taskId: task.taskId,
						runId: null,
						sourceId: sourceSet.summary?.sourceId || sourceSet.sourceSetId,
						artifactId:
							files.find((file) => file.sourceId === sourceSet.summary?.sourceId)?.artifactId ||
							files[0]?.artifactId ||
							sourceSet.sourceSetId,
						managerEpoch: epoch,
						sourceGeneration: 1,
						sourceRevision: revision,
						operationId,
						sequence: ++sequence,
						stage,
						observedAt: new Date().toISOString(),
						completedBytes: 0,
						totalBytes: null,
						completeFrames: current?.frames.length || 0,
						preparedFrames: 0,
						elapsedMs: performance.now() - started,
						...counts
					});
				} catch {}
			};
			flight = (async () => {
				report("connecting");
				let summary = options.ignoreSummary ? undefined : sourceSet.summary,
					saved;
				try {
					saved = runtime.validateSourceMonitorSummary(
						summary,
						sourceSet.sourceSetId,
						sourceSet.sourceVersion,
						files
					);
				} catch (error) {
					summary = undefined;
					options.summaryWarning = String(error.message || error);
					saved = null;
				}
				if (!summaryReplacesMain(saved, mainSource(files, sourceSet))) {
					saved = null;
					summary = undefined;
				}
				let input, selected, boundary, key, verifyInput;
				const chosen = saved || mainSource(files, sourceSet);
				if (!chosen) throw fail("SOURCE_SET_FILES_UNAVAILABLE");
				if (saved) {
					key = JSON.stringify([sourceSet.sourceSetId, sourceSet.sourceVersion, saved.sha256]);
					boundary = {
						fileIdentity: {
							kind: "archived-source-summary",
							sourceSetId: sourceSet.sourceSetId,
							sourceVersion: sourceSet.sourceVersion,
							sourceId: saved.sourceId,
							sha256: saved.sha256
						},
						readByteRange: { start: 0, end: 0 },
						publishedByteRange: { start: 0, end: 0 }
					};
				} else {
					const artifact = artifacts.find((item) => item.artifactId === chosen.artifactId);
					selected = initialSelection?.artifactId === chosen.artifactId ? initialSelection.source : resolveSource
						? await resolveSource({ artifactId: chosen.artifactId, signal: request })
						: {
								location: artifact.locations[0],
								transport: await transportFor(artifact.locations[0].environmentId)
							};
					initialSelection = null;
					const identity =
						selected.identity ||
						(await selected.transport.stat(selected.location.path, { signal: request }));
					key = JSON.stringify([
						sourceSet.sourceVersion,
						identity.fileId,
						identity.byteSize,
						identity.modifiedAt,
						identity.changeToken
					]);
					if (current && key === identityKey) {
						report("ready", {
							completeFrames: current.frames.length,
							preparedFrames: current.frames.length
						});
						return { ...current, release() {} };
					}
					let verifiedDigest = null, streamFailure = null;
					const observedTransport = { async readRange(range, io) {
						request.throwIfAborted();
						const { offset, length } = range, receipt = selected.transport.readObservedRange
							? await selected.transport.readObservedRange(range, io)
							: await selected.transport.readRange(range, io);
						request.throwIfAborted();
						if (
							receipt.offset !== offset ||
							receipt.length !== length ||
							receipt.bytes.length !== length ||
							receipt.before.path !== identity.path ||
							receipt.after.path !== identity.path ||
							receipt.before.fileId !== identity.fileId ||
							receipt.after.fileId !== identity.fileId ||
							receipt.before.byteSize !== identity.byteSize ||
							receipt.after.byteSize !== identity.byteSize ||
							receipt.before.modifiedAt !== identity.modifiedAt ||
							receipt.after.modifiedAt !== identity.modifiedAt ||
							receipt.before.changeToken !== identity.changeToken ||
							receipt.after.changeToken !== identity.changeToken
						)
							throw fail("SOURCE_SET_CHANGED_DURING_READ");
						return receipt;
					} };
					// memoryFile previously allowed any explicit safe range up to source
					// size. Preserve that legacy text fallback without eager aggregation.
					const streamOptions = { explicitLargeRanges: true, observeStream() {
						const hash = crypto.createHash("sha256"); let consumed = 0;
						return {
							chunk(bytes, offset) {
								if (offset !== consumed) throw fail("SOURCE_MONITOR_NON_SEQUENTIAL_STREAM");
								hash.update(bytes); consumed += bytes.length;
								report("transferring", {
									completedBytes: consumed,
									totalBytes: identity.byteSize
								});
							},
							end() {
								request.throwIfAborted();
								if (consumed !== identity.byteSize) throw fail("SOURCE_MONITOR_INCOMPLETE_READ");
								const digest = hash.digest("hex");
								if (chosen.sha256 && chosen.sha256 !== digest) throw fail("ARCHIVED_SOURCE_CONTENT_CHANGED");
								verifiedDigest = digest;
							},
							error(error) { streamFailure ||= error; }
						};
					} };
					const candidate = { sourceId: JSON.stringify([sourceSet.sourceSetId, chosen.artifactId, key]), relativePath: chosen.name, path: identity.path };
					input = fixedSource(candidate, identity, observedTransport, request, streamOptions);
					verifyInput = async () => {
						request.throwIfAborted();
						if (streamFailure) throw streamFailure;
						// Range-only structure readers also require a complete independent
						// bounded verification pass. FCHK/Molden reuse their consumed stream.
						if (!verifiedDigest) {
							const verifier = fixedSource(candidate, identity, observedTransport, request, streamOptions), reader = verifier.stream().getReader();
							try { while (!(await reader.read()).done) {} }
							finally { await reader.cancel().catch(() => {}); reader.releaseLock(); verifier.close(); }
						}
						if (streamFailure) throw streamFailure;
						if (!verifiedDigest) throw fail("SOURCE_MONITOR_INCOMPLETE_READ");
					};
					boundary = {
						fileIdentity: identity,
						observedEnd: identity.byteSize,
						readByteRange: { start: 0, end: identity.byteSize },
						consumedByteRange: { start: 0, end: identity.byteSize },
						publishedByteRange: { start: 0, end: identity.byteSize }
					};
				}
				if (current && key === identityKey) {
					report("ready", {
						completeFrames: current.frames.length,
						preparedFrames: current.frames.length
					});
					return { ...current, release() {} };
				}
				report("parsing");
				try {
					const result = await runtime.readSourceOnlyMonitor({
						taskId: task.taskId,
						sourceSetId: sourceSet.sourceSetId,
						sourceVersion: sourceSet.sourceVersion,
						files,
						summary,
						file: input,
						format: chosen.format,
						signal: request,
						onProgress: (completed, total) =>
							report("parsing", { completedBytes: completed, totalBytes: total }),
						onPreparedFrames: (completed, total) =>
							report("preparing", { completeFrames: total, preparedFrames: completed })
					});
					await verifyInput?.();
					request.throwIfAborted();
					report("publishing", {
						completeFrames: result.frames.length,
						preparedFrames: result.frames.length
					});
					const knownPath =
						selected?.location.path ||
						artifacts.find((item) => item.artifactId === chosen.artifactId)?.locations?.[0]?.path ||
						null;
					const next = {
						...result,
						notices: [
							...result.notices,
							...(options.summaryWarning
								? [
										{
											id: `summary:${sourceSet.sourceVersion}`,
											message: options.summaryWarning,
											severity: "warning",
											artifactId: chosen.artifactId
										}
									]
								: [])
						],
						sourceRevision: revision,
						sourceBoundary: boundary,
						sourceIdentity: {
							sourceId: sourceSet.sourceSetId,
							taskId: task.taskId,
							runId: null,
							artifactId: chosen.artifactId,
							path: knownPath
						},
						scientificState: {}
					};
					current = next;
					identityKey = key;
					report("ready", {
						completeFrames: result.frames.length,
						preparedFrames: result.frames.length
					});
					return { ...next, release() {} };
				} finally {
					input?.close();
				}
			})()
				.catch((error) => {
					report("failed");
					throw error;
				})
				.finally(() => {
					flight = null;
					active = null;
				});
			return flight;
		},
		retainClassifierPrimary() {
			return null;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			options.sourceSelection?.source.releaseObservation?.();
			lifetime.abort();
			await flight?.catch(() => {});
			current = null;
		}
	};
}
module.exports = { chooseSourceOnlyMonitor, createHostSourceOnlyMonitor };
