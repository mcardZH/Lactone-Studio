"use strict";
const path = require("node:path");
const { sha256, basename, fail } = require("../execution/common.cjs");
/** Names enumerate possible assets only. Content/association/producer are never certified here. */
function resolveOutputCandidates({
	run,
	inputSnapshot,
	workLocation = run.executionIdentity.workLocation,
	printedFileReferences = []
}) {
	if (!workLocation || workLocation.environmentId !== run.environmentSnapshot.environmentId)
		fail("OUTPUT_CANDIDATE_ENVIRONMENT_CONFLICT");
	const api = run.softwareSnapshot.platform === "win32" ? path.win32 : path.posix,
		root = api.resolve(workLocation.path),
		engineId = run.softwareSnapshot.engineId,
		candidates = new Map();
	const add = (file, formatCandidate, expectedRoles, discovery) => {
		if (
			typeof file !== "string" ||
			!file ||
			file.includes("\0") ||
			/(^|[\\/])\.\.?(?:[\\/]|$)/.test(file)
		)
			fail("OUTPUT_CANDIDATE_PATH_UNSAFE");
		const absolute = api.isAbsolute(file) ? api.resolve(file) : api.resolve(root, file),
			relative = api.relative(root, absolute);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith(".." + api.sep) ||
			api.isAbsolute(relative)
		)
			fail("OUTPUT_CANDIDATE_OUTSIDE_RUN");
		const key = run.softwareSnapshot.platform === "win32" ? absolute.toLowerCase() : absolute,
			dependencyRefs = (inputSnapshot.dependencies || [])
				.filter(
					(value) => value.preparedName === relative || value.preparedLocation?.path === absolute
				)
				.map((value) => ({
					artifactId: value.artifactId,
					contentIdentity: value.contentIdentity,
					preparedLocation: value.preparedLocation || null
				}));
		const candidate = {
			candidateId: "candidate-" + sha256(Buffer.from(`${run.runId}:${key}`)).slice(0, 32),
			taskId: run.taskId,
			runId: run.runId,
			path: absolute,
			relativePath: relative,
			workLocation: { environmentId: workLocation.environmentId, path: root },
			formatCandidate,
			expectedRoles,
			discovery,
			inputDependencyRefs: dependencyRefs,
			association: {
				state: "unknown",
				reason:
					"A controlled path is only a candidate; content, producer and job/stage need independent evidence"
			}
		};
		const previous = candidates.get(key);
		if (!previous || discovery.kind === "output-reference") candidates.set(key, candidate);
	};
	const jobs = inputSnapshot.parsedRequests?.jobs || [];
	if (engineId === "orca" && jobs.length === 1) {
		const bases = (jobs[0].dependencyReferences || [])
			.filter((value) => value.kind === "output-prefix")
			.map((value) => value.name);
		if (bases.length > 1) fail("ORCA_OUTPUT_BASE_CONFLICT");
		const base = basename(
			bases[0] || basename(inputSnapshot.preparedName || "input.inp").replace(/\.[^.]+$/, "")
		);
		for (const [suffix, format, roles] of [
			[".hess", "orca-hessian", ["modes"]],
			[".xyz", "xyz", ["structure"]],
			["_trj.xyz", "xyz", ["trajectory"]],
			[".engrad", "orca-engrad", ["other"]],
			[".cis", "orca-cis", ["other"]],
			[".json", "orca-json", ["other"]]
		])
			add(base + suffix, format, roles, {
				kind: "fixed-basename",
				engineId,
				inputSnapshotId: inputSnapshot.inputSnapshotId,
				inputContentIdentity: inputSnapshot.contentIdentity
			});
	}
	for (const reference of printedFileReferences) {
		if (
			typeof reference.sourceArtifactId !== "string" ||
			!reference.sourceArtifactId ||
			!Number.isSafeInteger(reference.sourceLine) ||
			reference.sourceLine < 1 ||
			typeof reference.rawReference !== "string"
		)
			fail("OUTPUT_REFERENCE_EVIDENCE_REQUIRED");
		add(
			reference.path || reference.rawReference,
			reference.formatCandidate || null,
			reference.expectedRoles || ["other"],
			{
				kind: "output-reference",
				sourceArtifactId: reference.sourceArtifactId,
				sourceRevision: reference.sourceRevision ?? null,
				sourceLine: reference.sourceLine,
				byteRange: reference.byteRange || null,
				rawReference: reference.rawReference
			}
		);
	}
	return [...candidates.values()];
}
module.exports = { resolveOutputCandidates };
