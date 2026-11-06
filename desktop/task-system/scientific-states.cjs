"use strict";
const path = require("node:path");
/** Projection only. Every status is supplied by C for this exact published prefix. */
function scientificStates(prepared) {
	const result = {},
		identity = prepared.sourceIdentity,
		source = {
			kind: "scientific-monitor",
			identity,
			collectionId: prepared.collectionId,
			revision: prepared.revision,
			sourceRevision: prepared.sourceRevision,
			snapshotId: prepared.snapshotId,
			sourceBoundary: prepared.sourceBoundary
		};
	for (const job of prepared.jobs || []) {
		const diagnostics = job.data?.diagnostics;
		if (!diagnostics) continue;
		const prefix = `job:${job.jobIndex}:segment:${job.segmentIndex}`;
		function add(key, label, event, mapping) {
			if (!event || !Object.hasOwn(mapping, event.status)) return;
			const state = mapping[event.status],
				sourceLine = event.sourceLine,
				evidenceRefs = [
					`source:${identity.artifactId}:${prepared.collectionId}:${prepared.revision}${sourceLine === undefined ? "" : `:line:${sourceLine}`}`
				];
			result[`${prefix}:${key}`] = {
				label,
				state,
				jobIndex: job.jobIndex,
				segmentIndex: job.segmentIndex,
				...(event.stageId !== undefined ? { stageId: event.stageId } : {}),
				...(event.frameIndex !== undefined ? { frameIndex: event.frameIndex } : {}),
				...(sourceLine !== undefined ? { sourceLine } : {}),
				sourceLabel: `${path.basename(identity.path)} · Job ${job.jobIndex + 1} / 段 ${job.segmentIndex + 1}${sourceLine === undefined ? "" : ` · 行 ${sourceLine}`}`,
				evidenceRefs,
				...(event.raw !== undefined ? { raw: event.raw } : {}),
				reason: event.message || `来源诊断：${event.status}`,
				diagnosticStatus: event.status,
				source
			};
		}
		add("integrity", "文件完整性", diagnostics.integrity, {
			"complete-snapshot": "satisfied",
			"damaged-tail": "not-satisfied",
			"changed-during-read": "conflict",
			unknown: "unknown"
		});
		add("termination", "科学输出终止", diagnostics.termination, {
			normal: "satisfied",
			error: "not-satisfied",
			"not-observed": "unknown"
		});
		for (const event of diagnostics.scf || [])
			add(`scf:frame:${event.frameIndex ?? "unassigned"}`, "SCF收敛", event, {
				converged: "satisfied",
				"not-converged": "not-satisfied",
				unknown: "unknown"
			});
		for (const event of diagnostics.tasks || [])
			add(
				`task:${event.task}:stage:${event.stageId ?? "unassigned"}:frame:${event.frameIndex ?? "unassigned"}`,
				`任务条件 · ${event.task}`,
				event,
				{
					completed: "satisfied",
					"not-converged": "not-satisfied",
					incomplete: "unknown",
					unknown: "unknown"
				}
			);
		for (const event of diagnostics.fields || [])
			add(
				`field:${event.field}:frame:${event.frameIndex ?? "unassigned"}`,
				`字段 · ${event.field}`,
				event,
				{
					complete: "satisfied",
					partial: "unknown",
					"not-printed": "unknown",
					"stage-not-reached": "unknown",
					"no-compatible-companion": "unknown",
					unsupported: "unknown",
					conflict: "conflict"
				}
			);
	}
	return result;
}
function mergeScientificStates(previous, publication) {
	const result = Object.fromEntries(
		Object.entries(previous || {}).map(([key, value]) => [
			key,
			value.source?.kind === "scientific-monitor" ? { ...value, active: false } : value
		])
	);
	for (const [key, value] of Object.entries(publication))
		result[key] = {
			...value,
			active: true,
			hasStageId: value.stageId !== undefined,
			stageId: value.stageId ?? null,
			hasFrameIndex: value.frameIndex !== undefined,
			frameIndex: value.frameIndex ?? null,
			hasSourceLine: value.sourceLine !== undefined,
			sourceLine: value.sourceLine ?? null,
			hasRaw: value.raw !== undefined,
			raw: value.raw ?? ""
		};
	return result;
}
module.exports = { scientificStates, mergeScientificStates };
