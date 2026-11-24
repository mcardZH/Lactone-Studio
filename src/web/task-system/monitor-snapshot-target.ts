import type { MonitorSnapshotTarget, TaskMonitorView } from "../../task-system/application-contracts";
import type { ObservedPostprocessFrame } from "../results/PostprocessResultView";

/** Use the publication associated with the observed result, not the task list's current card. */
export function monitorSnapshotTarget(view: TaskMonitorView, cursor?: ObservedPostprocessFrame): MonitorSnapshotTarget | null {
	const { task, sourceIdentity, sourceBoundary, sourceRevision } = view;
	const target: MonitorSnapshotTarget = { runId: task.runId };
	if (task.runId === null) {
		target.sourceSetId = task.sourceSetId ?? undefined;
		target.sourceVersion = task.sourceVersion ?? undefined;
	}
	const attributable = sourceIdentity?.taskId === task.taskId && sourceIdentity.runId === target.runId &&
		sourceBoundary && typeof sourceRevision === "number" && Number.isSafeInteger(sourceRevision);
	if (attributable && sourceBoundary.publishedByteRange.end > sourceBoundary.publishedByteRange.start) {
		target.source = {
			artifactId: sourceIdentity.artifactId,
			revision: sourceRevision,
			boundary: sourceBoundary,
			observedSha256: view.observedSha256
		};
	}
	if (!cursor) return target;
	const frame = cursor.result.frames[cursor.index];
	const matchesResult = view.results?.some(({result}) =>
		result.id === cursor.sourceResultId && result.jobIndex === cursor.result.jobIndex &&
		result.source.id === cursor.result.source.id);
	if (!attributable || !frame || !matchesResult ||
		(cursor.publicationRevision !== undefined && cursor.publicationRevision !== view.revision)) return null;
	target.frame = {
		jobIndex: cursor.result.jobIndex,
		stageId: cursor.stageId,
		sourceFrameIndex: frame.sourceFrameIndex ?? frame.index,
		sourceLine: frame.sourceLine
	};
	return target;
}
