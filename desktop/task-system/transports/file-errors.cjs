"use strict";
const DETAIL_BYTES = 8192;
function bounded(value) {
	const raw = Buffer.from(value || []);
	return {
		stderr: raw.subarray(0, DETAIL_BYTES).toString("utf8"),
		stderrTruncated: raw.length > DETAIL_BYTES
	};
}
function fileControlDetails(context, result) {
	return {
		stage: "transport-filesystem",
		operation: context?.operation || "control",
		...(context?.path ? { path: context.path } : {}),
		exitCode: result.exitCode ?? null,
		signal: result.signal ?? null,
		...bounded(result.stderr)
	};
}
// GNU stat's C-locale errno text, matched to the entire diagnostic for this exact path.
// Other tools, permissions, shell failures and ambiguous diagnostics stay unclassified.
function exactStatMissing(context, result) {
	if (context?.operation !== "stat" || result.exitCode !== 1 || typeof context.path !== "string")
		return false;
	const stderr = Buffer.from(result.stderr || []).toString("utf8");
	return ["cannot stat", "cannot statx"].some(
		(action) => stderr === `stat: ${action} '${context.path}': No such file or directory\n`
	);
}
function isMissingFile(error, file) {
	return (
		error?.code === "ENOENT" ||
		(error?.code === "FILE_NOT_FOUND" &&
			error.details?.missing === true &&
			error.details.path === file)
	);
}
function fileObservationDetails({
	operation,
	phase,
	path,
	requestedIdentity,
	before,
	after,
	range
}) {
	const copy = (value) =>
		value
			? Object.fromEntries(
					[
						"environmentId",
						"path",
						"fileId",
						"byteSize",
						"modifiedAt",
						"changeToken",
						"mode",
						"checkedAt",
						"verification",
						"isDirectory",
						"isRegularFile"
					]
						.filter((key) => value[key] !== undefined)
						.map((key) => [key, value[key]])
				)
			: null;
	return {
		stage: "transport-filesystem",
		operation,
		phase,
		path,
		requestedIdentity: copy(requestedIdentity),
		before: copy(before),
		after: copy(after),
		...(range ? { range: { offset: range.offset, length: range.length } } : {})
	};
}
module.exports = { fileControlDetails, exactStatMissing, isMissingFile, fileObservationDetails };
