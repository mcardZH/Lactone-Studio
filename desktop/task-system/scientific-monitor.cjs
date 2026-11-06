"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createLocalTransport } = require("./transports/local.cjs");
const { fail, noLinks } = require("./platform/global-settings.cjs");
const { scientificStates } = require("./scientific-states.cjs");
function cardsFor(jobs) {
	const rows = [],
		points = [],
		notices = [];
	for (const job of jobs) {
		for (const frame of job.frames)
			if (frame.energy) {
				rows.push([
					String(job.jobIndex + 1),
					String(frame.index + 1),
					String(frame.energy.value),
					frame.energy.unit,
					`line ${frame.sourceLine}`
				]);
				points.push({
					x: frame.index,
					y: frame.energy.value,
					index: frame.index,
					segment: `${job.jobIndex}:${job.segmentIndex}`,
					tooltip: `job ${job.jobIndex + 1} / line ${frame.sourceLine}`
				});
			}
		for (const message of job.data.notices || [])
			notices.push({ id: `${job.jobIndex}:${message}`, message });
	}
	const cards = rows.length
		? [
				{
					kind: "energy",
					title: "能量",
					columns: ["Job", "帧", "能量", "单位", "来源"],
					rows,
					sourceLabel: "主输出中的完整结构及其能量",
					plot: { xLabel: "帧", yLabel: "能量", series: [{ id: "native-energy", points }] }
				}
			]
		: [];
	const trajectory = jobs.flatMap((job) =>
		job.frames.map((frame) => [
			String(job.jobIndex + 1),
			frame.stageId || "",
			String(frame.index + 1),
			frame.sourceStep === null ? "" : String(frame.sourceStep),
			`line ${frame.sourceLine}`
		])
	);
	if (trajectory.length)
		cards.push({
			kind: "trajectory",
			title: "轨迹",
			columns: ["Job", "阶段", "帧", "原始步", "来源"],
			rows: trajectory,
			sourceLabel: "主输出中的完整结构帧"
		});
	const excited = jobs.flatMap((job) =>
		(job.data.excitedStates || []).map((value) => [
			String(job.jobIndex + 1),
			value.label,
			String(value.energyEv),
			value.oscillatorStrength === undefined ? "" : String(value.oscillatorStrength),
			`line ${value.sourceLine}`
		])
	);
	if (excited.length)
		cards.push({
			kind: "excited",
			title: "激发态",
			columns: ["Job", "状态", "能量/eV", "振子强度", "来源"],
			rows: excited,
			sourceLabel: "主输出中的已打印激发态"
		});
	const atomic = jobs.flatMap((job) =>
		(job.data.atomicProperties || []).flatMap((group) =>
			group.values.map((value) => [
				String(job.jobIndex + 1),
				group.scheme,
				String(value.atomIndex),
				value.element || "",
				String(value.value),
				group.unit,
				`line ${group.sourceLine}`
			])
		)
	);
	if (atomic.length)
		cards.push({
			kind: "atomic",
			title: "已打印原子性质",
			columns: ["Job", "方法", "原子索引", "元素", "数值", "单位", "来源"],
			rows: atomic,
			sourceLabel: "主输出中的原生原子索引与性质"
		});
	const vibrations = jobs.flatMap((job) =>
		(job.data.vibrationSets || (job.data.vibrations ? [job.data.vibrations] : [])).flatMap(
			(group) =>
				group.modes.map((mode) => [
					String(job.jobIndex + 1),
					String(mode.sourceIndex ?? mode.index),
					String(mode.frequency),
					mode.irIntensity === undefined ? "" : String(mode.irIntensity),
					mode.irIntensityUnit || "",
					`line ${mode.sourceLine}`
				])
		)
	);
	if (vibrations.length)
		cards.push({
			kind: "vibrations",
			title: "振动",
			columns: ["Job", "原始模式", "频率/cm⁻¹", "IR强度", "IR单位", "来源"],
			rows: vibrations,
			sourceLabel: "主输出中的已打印模式"
		});
	return { cards, notices };
}
/** Thin C-runtime adapter; it neither interprets source text nor calculates chemistry. */
async function createHostScientificMonitor({
	runtime,
	task,
	run,
	sourceSet,
	signal: sourceSignal,
	artifacts,
	epoch,
	transportFor,
	resolveSource,
	localEnvironmentId,
	snapshotDirectory,
	onProgress,
	onIntermediatePublication
}) {
	let sourceSummaryWarning, confirmedSource;
	if (!run && sourceSet) {
		const inputs={runtime,task,sourceSet,artifacts,epoch,transportFor,resolveSource,onProgress,signal:sourceSignal};
		const facade=require("./source-only-monitor.cjs");
		if(await facade.chooseSourceOnlyMonitor(inputs))return facade.createHostSourceOnlyMonitor(inputs);
		sourceSummaryWarning = inputs.summaryWarning;
		confirmedSource = inputs.sourceSelection;
	}
	const artifact =
		artifacts.find((value) => value.artifactId === run?.primaryOutputArtifactId) ||
		(!run && confirmedSource?.recognition.format === "output" && ["gaussian","orca"].includes(confirmedSource.recognition.software)
			? artifacts.find(value => value.artifactId === confirmedSource.artifactId) : null) ||
		artifacts.find((value) => value.roles.includes("primary-output"));
	const originalLocation =
		artifact?.locations?.find((value) => value.role === "original") || artifact?.locations?.[0];
	if (!artifact || !originalLocation) throw fail("PRIMARY_OUTPUT_UNAVAILABLE");
	let initialSelection = confirmedSource?.source;
	let provider,
		selection,
		selectionKey,
		location = originalLocation,
		observedSource = artifact.observedAt != null || artifact.byteSize != null,
		lastRevision = null,
		lastView;
	function publication(prepared, leased = false) {
		if (lastRevision !== prepared.revision) {
			lastView = cardsFor(prepared.jobs); lastView.results = runtime.preparedMonitorResultViews(prepared); lastRevision = prepared.revision;
		}
		const last = prepared.jobs.at(-1);
		const archiveFailure = selection?.archiveFailure;
		return { scientificState: scientificStates(prepared), collectionId: prepared.collectionId, revision: prepared.revision,
			sourceRevision: prepared.sourceRevision, sourceGeneration: prepared.sourceGeneration, sourceBoundary: prepared.sourceBoundary, sourceIdentity: prepared.sourceIdentity,
			actualReadLocation: selection?.location || location, ...(archiveFailure ? { archiveFailure } : {}),
			prepared: true, frames: prepared.frames, results: lastView.results,
			resultsComplete: prepared.jobs.length > 0 && lastView.results.length === prepared.jobs.length, cards: lastView.cards,
			notices: [...lastView.notices.map(notice => ({ ...notice, severity: "warning", artifactId: artifact.artifactId })), ...(sourceSummaryWarning ? [{id:`summary:${sourceSet.sourceVersion}`,message:sourceSummaryWarning,severity:"warning",artifactId:artifact.artifactId}] : []),
				...(archiveFailure ? [{ id: `archive-source:${archiveFailure.manifestId}:${archiveFailure.artifactId}:${archiveFailure.code}`, message: "归档文件不可用，当前读取已核对一致的原工作文件。", severity: "warning", artifactId: artifact.artifactId, archiveFailure }] : [])],
			stage: last?.data.tasks.join(" / ") || null, iteration: last?.frames.length ? String(last.frames.at(-1).sourceStep ?? last.frames.length) : null,
			...(leased ? { release: () => prepared.release() } : {}) };
	}
	async function selectProvider(latest, signal, currentEpoch) {
		const selected = initialSelection || (resolveSource
			? await resolveSource({ artifactId: artifact.artifactId, run: latest, signal })
			: {
					location: originalLocation,
					originalLocation,
					transport: await transportFor(originalLocation.environmentId),
					sourceKey: JSON.stringify(originalLocation),
					originalName: artifact.originalName || path.basename(originalLocation.path),
					provenance: artifact.provenance || {}
				});
		initialSelection = null;
		if (selected.sourceKey !== selectionKey) {
			await provider?.dispose();
			provider = null;
			selection = selected;
			selectionKey = selected.sourceKey;
			location = selected.location;
			lastRevision = null;
			lastView = null;
			provider = runtime.createScientificMonitorProvider({
				source: {
					sourceId: `${run?.runId || sourceSet?.sourceSetId || task.taskId}:${artifact.artifactId}`,
					taskId: task.taskId,
					runId: run?.runId ?? null,
					artifactId: artifact.artifactId,
					path: location.path
				},
				transport: selected.transport,
				managerEpoch: currentEpoch,
				onProgress,
				onIntermediatePublication(snapshot, prepared) {
					// A fixed archived SHA is a full-content contract. Never label an
					// unchecked partial digest as that archived version.
					if (selection?.sha256 && prepared.observedSha256 !== selection.sha256) return;
					onIntermediatePublication?.(publication(prepared));
				}
			});
			if (location.role === "archive") observedSource = true;
		}
		// The resolver has just obtained this observation. Reuse it in the reader
		// instead of issuing another identical remote stat before the first range.
		selection = selected;
	}
	return {
		async refresh({ run: latest, signal, epoch: currentEpoch }) {
			try {
				await selectProvider(latest, signal, currentEpoch);
			} catch (error) {
				if (
					!observedSource &&
					error?.code === "FILE_NOT_FOUND" &&
					error.details?.missing === true &&
					error.details.operation === "stat" &&
					error.details.path === originalLocation.path
				)
					return null;
				throw error;
			}
			provider.setManagerEpoch(currentEpoch);
			const final = !latest ||
				latest.state.executionState === "ended" && latest.state.verificationState === "verified";
			const result = await provider.refresh({
				managerEpoch: currentEpoch,
				signal,
				final,
				...(selection?.identity ? { observedIdentity: selection.identity } : {}),
				observationMode:
					!selection?.sha256 && latest && location.role === "original" && latest.state.executionState !== "ended"
						? "live-primary-output"
						: "fixed-source"
			});
			if (result.kind === "pending" && result.reason === "source-in-flight-change") {
				observedSource = true;
				return { prepared: false, observationState: "pending", reason: result.reason };
			}
			if (result.kind === "failed") {
				const error = result.error;
				if (
					!observedSource &&
					error?.code === "FILE_NOT_FOUND" &&
					error.details?.missing === true &&
					error.details.operation === "stat" &&
					error.details.path === location.path
				)
					return null;
				throw error || fail("SCIENTIFIC_MONITOR_FAILED");
			}
			observedSource = true;
			const prepared = await provider.retainPrepared();
			if (!prepared) return null;
			if (selection?.sha256 && prepared.observedSha256 && selection.sha256 !== prepared.observedSha256) { prepared.release(); throw fail("ARCHIVED_SOURCE_CONTENT_CHANGED"); }
			return publication(prepared, true);
		},
		async snapshotSources({ signal } = {}) {
			if (!snapshotDirectory) throw fail("SNAPSHOT_DESTINATION_UNAVAILABLE");
			const prepared = await provider?.retainPrepared();
			if (!prepared) throw fail("SNAPSHOT_SOURCE_NOT_PREPARED");
			if (selection?.sha256 && prepared.observedSha256 !== selection.sha256) { prepared.release(); throw fail("SNAPSHOT_SOURCE_CONTENT_NOT_VERIFIED"); }
			const boundary = prepared.sourceBoundary,
				revision = prepared.sourceRevision;
			const directory = path.join(snapshotDirectory, "source-staging-" + crypto.randomUUID());
			const file = path.join(directory, "output-source.asset"),
				sha = crypto.createHash("sha256");
			let fd,
				ownedDirectory,
				ownedFile,
				primaryError,
				failed = false,
				closed = false;
			const cleanupErrors = [];
			try {
				noLinks(path.dirname(directory));
				await fs.mkdir(snapshotDirectory, { recursive: true });
				await fs.mkdir(directory);
				ownedDirectory = await fs.lstat(directory, { bigint: true });
				fd = await fs.open(file, "wx", 0o600);
				ownedFile = await fd.stat({ bigint: true });
				const end = boundary.publishedByteRange.end;
				for (let start = 0; start < end; start += 1024 * 1024) {
					signal?.throwIfAborted();
					const bytes = await prepared.readSourceRange(
						start,
						Math.min(end, start + 1024 * 1024),
						signal
					);
					await fd.writeFile(bytes);
					sha.update(bytes);
				}
				await fd.sync();
			} catch (error) {
				failed = true;
				primaryError = error;
			} finally {
				try {
					if (fd) {
						await fd.close();
						closed = true;
					}
				} catch (error) {
					cleanupErrors.push({ stage: "close", error });
				}
				try {
					await prepared.release();
				} catch (error) {
					cleanupErrors.push({ stage: "prepared-release", error });
				}
			}
			if (failed || cleanupErrors.length) {
				const verifyDirectory = async () => {
					noLinks(directory);
					const current = await fs.lstat(directory, { bigint: true });
					if (
						!current.isDirectory() ||
						current.isSymbolicLink() ||
						current.dev !== ownedDirectory.dev ||
						current.ino !== ownedDirectory.ino
					)
						throw fail("SNAPSHOT_STAGING_DIRECTORY_CHANGED");
				};
				// A failed close does not establish that even our own candidate can be removed.
				if (closed && ownedFile && ownedDirectory) {
					try {
						await verifyDirectory();
						const current = await fs.lstat(file, { bigint: true });
						if (
							!current.isFile() ||
							current.isSymbolicLink() ||
							current.dev !== ownedFile.dev ||
							current.ino !== ownedFile.ino
						)
							throw fail("SNAPSHOT_STAGING_FILE_CHANGED");
						await fs.unlink(file);
					} catch (error) {
						cleanupErrors.push({ stage: "remove-file", error });
					}
				}
				if (ownedDirectory && (!fd || closed)) {
					try {
						await verifyDirectory();
						await fs.rmdir(directory);
					} catch (error) {
						cleanupErrors.push({ stage: "remove-directory", error });
					}
				}
				if (cleanupErrors.length) {
					const cause = failed ? primaryError : cleanupErrors[0].error;
					const combined = new AggregateError(
						[...(failed ? [primaryError] : []), ...cleanupErrors.map((value) => value.error)],
						cause?.message || "快照来源收尾失败",
						{ cause }
					);
					combined.code = cause?.code || "SNAPSHOT_SOURCE_STAGING_FAILED";
					combined.details = {
						primaryError: failed
							? {
									code: primaryError?.code || null,
									message: String(primaryError?.message || primaryError)
								}
							: null,
						cleanupErrors: cleanupErrors.map(({ stage, error }) => ({
							stage,
							code: error?.code || null,
							message: String(error?.message || error)
						})),
						candidate: { file, directory, closed }
					};
					throw combined;
				}
				throw primaryError;
			}
			const local = createLocalTransport({ environmentId: localEnvironmentId }),
				identity = await local.stat(file),
				digest = sha.digest("hex");
			await local.dispose();
			let released = false;
			return {
				sources: [
					{
						artifactId: artifact.artifactId,
						environmentId: localEnvironmentId,
						path: file,
						identity,
						sha256: digest,
						roles: ["primary-output"],
						representation: "text",
						format: artifact.format ?? null,
						formatVersion: artifact.formatVersion ?? null,
						stable: true,
						originalName:
							selection?.originalName || artifact.originalName || path.basename(location.path),
						provenance: {
							...(selection?.provenance || {}),
							originalLocation: selection?.originalLocation || location,
							actualReadLocation: location,
							sourceBoundary: boundary,
							sourceRevision: revision
						}
					}
				],
				async release() {
					if (released) return;
					released = true;
					await fs.unlink(file);
					await fs.rmdir(directory);
				}
			};
		},
		retainClassifierPrimary: () => provider?.retainClassifierPrimary?.() || null,
		dispose: () => { initialSelection?.releaseObservation?.(); selection?.releaseObservation?.(); return provider?.dispose(); }
	};
}
module.exports = { createHostScientificMonitor, cardsFor };
