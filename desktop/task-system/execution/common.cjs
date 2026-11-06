"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
function fail(code, details) {
	const error = new Error(code);
	error.code = code;
	if (details) error.details = details;
	throw error;
}
function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
function requireText(value, name = "VALUE") {
	if (typeof value !== "string" || !value || value.includes("\0")) fail(`INVALID_${name}`);
	return value;
}
function quote(value) {
	if (typeof value !== "string" || value.includes("\0")) fail("INVALID_SHELL_ARGUMENT");
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function basename(value) {
	requireText(value, "FILE_NAME");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "..") fail("UNSAFE_FILE_NAME");
	return value;
}
function joinLocation(root, name, platform) {
	basename(name);
	return platform === "win32" ? path.win32.join(root, name) : path.posix.join(root, name);
}
function abort(signal) {
	if (signal?.aborted) fail("IO_ABORTED");
}
function checkRange(offset, length) {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		!Number.isSafeInteger(offset + length) ||
		length > 8 * 1024 * 1024
	)
		fail("INVALID_BYTE_RANGE");
}
function sameFile(left, right) {
	return (
		!!left?.fileId &&
		left.fileId === right?.fileId &&
		left.environmentId === right.environmentId &&
		left.path === right.path
	);
}
function unchanged(left, right) {
	return (
		sameFile(left, right) &&
		left.byteSize === right.byteSize &&
		left.modifiedAt === right.modifiedAt &&
		left.changeToken === right.changeToken
	);
}
function response(protocol, request, payload, responseState = "completed", actualState = {}) {
	const value = {
		protocolVersion: 1,
		requestId: request.requestId,
		action: request.action,
		payloadVersion: 1,
		payload,
		responseState,
		actualState,
		evidenceRefs: payload.evidenceRefs || []
	};
	for (const key of ["taskId", "runId", "submissionIntentId", "operationId"])
		if (request[key] !== undefined) value[key] = request[key];
	protocol.assertExecutionResponse(value, request);
	return value;
}
function validate(protocol, request, action) {
	protocol.assertExecutionRequest(request);
	if (request.action !== action) fail("ACTION_MISMATCH");
}
function manifestDigest(manifest) {
	return sha256(Buffer.from(JSON.stringify(manifest)));
}
module.exports = {
	fail,
	sha256,
	requireText,
	quote,
	basename,
	joinLocation,
	abort,
	checkRange,
	sameFile,
	unchanged,
	response,
	validate,
	manifestDigest
};
