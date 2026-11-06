import type {
	SubmitTaskRequest,
	TaskSystemCommands,
	TaskSystemBridge
} from "../../task-system/application-contracts";
export type SubmissionPreview = TaskSystemCommands["submission.preview"]["result"];
/** Includes exact final text and opaque dependency identities; display labels cannot substitute. */
export function submissionRequestKey(request: SubmitTaskRequest): string {
	return JSON.stringify(request);
}
export function currentSubmissionPreview(
	request: SubmitTaskRequest,
	checkedKey: string,
	preview: SubmissionPreview | null
): SubmissionPreview | null {
	return checkedKey === submissionRequestKey(request) ? preview : null;
}
export function canSubmitPreview(
	request: SubmitTaskRequest,
	checkedKey: string,
	preview: SubmissionPreview | null
): boolean {
	const current = currentSubmissionPreview(request, checkedKey, preview);
	return Boolean(current && !current.restrictions.length);
}
/** Release only trusted descriptors; the host owns in-use retention and never deletes picker originals. */
export async function releaseSubmissionDependencies(
	bridge: TaskSystemBridge,
	sourceRefs: readonly string[]
): Promise<void> {
	const exact = [...new Set(sourceRefs)].filter(Boolean);
	if (exact.length) await bridge.request("submission.release-dependencies", { sourceRefs: exact });
}
