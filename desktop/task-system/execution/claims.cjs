"use strict";
function cancellationClaim(value) {
	return {
		protocolVersion: 1,
		taskId: value.taskId,
		runId: value.runId,
		submissionIntentId: value.submissionIntentId,
		cancelled: true
	};
}
function isCancellationClaim(claim, value) {
	return (
		claim?.protocolVersion === 1 &&
		claim.cancelled === true &&
		claim.taskId === value.taskId &&
		claim.runId === value.runId &&
		claim.submissionIntentId === value.submissionIntentId
	);
}
module.exports = { cancellationClaim, isCancellationClaim };
