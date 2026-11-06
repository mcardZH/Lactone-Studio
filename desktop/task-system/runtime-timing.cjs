"use strict";
const nonnegative = value => Number.isFinite(value) && value >= 0;
function linuxTiming(identity, uptimeSeconds, clockTicksPerSecond) {
	if (!identity?.bootId || !Number.isSafeInteger(identity.startTicks) || identity.startTicks < 0 || !nonnegative(uptimeSeconds) || !Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0) return null;
	const elapsedSeconds = uptimeSeconds - identity.startTicks / clockTicksPerSecond;
	return nonnegative(elapsedSeconds) ? { kind: "linux-boot-uptime-v1", clockDomain: identity.bootId, elapsedSeconds } : null;
}
function runtimeTimingObservation(run, result, observedAt) {
	const timing = result?.payload?.observation?.runtimeTiming;
	const identity = run?.executionIdentity?.launchIdentity?.bootId ? run.executionIdentity.launchIdentity : run?.executionIdentity?.launchReceipt?.payload?.identity;
	if (!run?.executionIdentity?.launchReceipt || result.actualState?.executionState !== "running" || timing?.kind !== "linux-boot-uptime-v1" || timing.clockDomain !== identity?.bootId || !nonnegative(timing.elapsedSeconds)) return null;
	return { ...timing, runId: run.runId, submissionIntentId: run.executionIdentity.submissionIntentId, state: "running", observedAt };
}
function runtimeTiming(run, localNow = Date.now()) {
	const launch = run?.executionIdentity?.launchReceipt, end = run?.executionIdentity?.endReceipt;
	const startedAt = launch?.payload?.launchedAt || launch?.payload?.launch?.launchedAt || launch?.occurredAt || null;
	const endedAt = end?.payload?.endedAt || end?.payload?.end?.endedAt || end?.occurredAt || null;
	const value = { startedAt, endedAt, elapsedSeconds: null };
	if (!launch || end?.payload?.notStarted === true) return value;
	if ([launch, end].filter(Boolean).some(receipt => receipt.runId !== undefined && receipt.runId !== run.runId || receipt.submissionIntentId !== undefined && receipt.submissionIntentId !== run.executionIdentity.submissionIntentId)) return value;
	const terminalTiming = end?.payload?.runtimeTiming;
	if (terminalTiming && ["linux-boot-uptime-v1", "runner-monotonic-v1"].includes(terminalTiming.kind) && nonnegative(terminalTiming.elapsedSeconds)) {
		const bootId = launch.payload?.identity?.bootId || run.executionIdentity.launchIdentity?.bootId;
		if (terminalTiming.kind !== "linux-boot-uptime-v1" || terminalTiming.clockDomain === bootId) return { ...value, elapsedSeconds: terminalTiming.elapsedSeconds };
	}
	if (terminalTiming) return value;
	const local = run?.environmentSnapshot?.connection?.kind === "local";
	if (end) {
		// Constant skew cancels only within one execution host's receipt clock.
		const sameReceiptClock = typeof launch.source === "string" && launch.source.length && launch.source === end.source;
		if (local || sameReceiptClock) {
			const seconds = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
			if (nonnegative(seconds)) return { ...value, elapsedSeconds: seconds };
		}
		return value;
	}
	const observation = run.runtimeTimingObservation;
	if (observation?.runId === run.runId && observation.submissionIntentId === run.executionIdentity.submissionIntentId && observation.kind === "linux-boot-uptime-v1" && observation.clockDomain === (launch.payload?.identity?.bootId || run.executionIdentity.launchIdentity?.bootId) && nonnegative(observation.elapsedSeconds)) return { ...value, elapsedSeconds: observation.elapsedSeconds };
	// Only a genuinely local launch shares this Date.now clock. Remote values
	// stay at their last measured uptime duration; no wall-clock extrapolation.
	if (local) {
		const seconds = (localNow - Date.parse(startedAt)) / 1000;
		if (nonnegative(seconds)) return { ...value, elapsedSeconds: seconds };
	}
	return value;
}
module.exports = { linuxTiming, runtimeTimingObservation, runtimeTiming };
