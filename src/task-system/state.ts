import type { Evidence, ExecutionState, RunState, OperationState } from "./contracts";

export const EXECUTION_STATES = [
	"preparing",
	"submitting",
	"queued",
	"running",
	"stop-requested",
	"ended",
	"unknown"
] as const;
export const VERIFICATION_STATES = [
	"verified",
	"stale",
	"unreachable",
	"conflict",
	"unknown"
] as const;
export const SCIENTIFIC_STATES = [
	"unknown",
	"in-progress",
	"satisfied",
	"not-satisfied",
	"not-applicable",
	"conflict"
] as const;
export const OPERATION_STATES = [
	"pending",
	"running",
	"waiting-verification",
	"succeeded",
	"failed",
	"cancelled",
	"partial"
] as const;
export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
	"succeeded",
	"failed",
	"cancelled"
];
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
	preparing: ["preparing", "submitting", "stop-requested", "ended", "unknown"],
	submitting: ["submitting", "queued", "running", "stop-requested", "ended", "unknown"],
	queued: ["queued", "running", "stop-requested", "ended", "unknown"],
	running: ["running", "stop-requested", "ended", "unknown"],
	"stop-requested": ["stop-requested", "ended", "unknown"],
	ended: ["ended"],
	unknown: ["unknown", "preparing", "submitting", "queued", "running", "stop-requested", "ended"]
};
export function canTransitionExecution(
	from: ExecutionState,
	to: ExecutionState,
	evidence: Evidence
): boolean {
	if (
		!EXECUTION_TRANSITIONS[from]?.includes(to) ||
		!evidence ||
		!evidence.evidenceRefs?.length ||
		!Number.isFinite(Date.parse(evidence.checkedAt))
	)
		return false;
	const required: Record<ExecutionState, string[]> = {
		preparing: ["not-started"],
		submitting: ["intent-persisted"],
		queued: ["queued"],
		running: ["running"],
		"stop-requested": ["stop-intent"],
		ended: ["ended", "not-started"],
		unknown: ["verification"]
	};
	return (
		required[to].includes(evidence.type) &&
		(evidence.type !== "not-started" ||
			from === "preparing" ||
			from === "unknown" ||
			to === "preparing")
	);
}
/** Only the execution layer changes. Scientific facts are never inferred from an exit. */
export function transitionExecutionState(
	previous: RunState,
	next: ExecutionState,
	evidence: Evidence,
	endReason?: RunState["endReason"]
): RunState {
	if (!canTransitionExecution(previous.executionState, next, evidence))
		throw new Error("INVALID_EXECUTION_TRANSITION");
	if (next === "ended" && !endReason) throw new Error("END_REASON_REQUIRED");
	if (previous.executionState === "ended" && endReason && previous.endReason !== endReason)
		throw new Error("TERMINAL_EVIDENCE_CONFLICT");
	return {
		...previous,
		executionState: next,
		verificationState: next === "unknown" ? "unknown" : "verified",
		checkedAt: evidence.checkedAt,
		evidenceRefs: [...evidence.evidenceRefs],
		...(next === "ended" ? { endReason } : {}),
		lastReliableExecutionState:
			next === "unknown" ? (previous.lastReliableExecutionState ?? previous.executionState) : next
	};
}
export function canTransitionOperation(
	from: OperationState,
	to: OperationState,
	evidence: Evidence
): boolean {
	if (
		!OPERATION_STATES.includes(from) ||
		!OPERATION_STATES.includes(to) ||
		!evidence?.evidenceRefs?.length
	)
		return false;
	if (TERMINAL_OPERATION_STATES.includes(from)) return from === to;
	if (to === "cancelled") return evidence.type === "not-started";
	if (to === "succeeded") return evidence.type === "operation-complete";
	if (to === "partial") return evidence.type === "operation-partial";
	return true;
}
