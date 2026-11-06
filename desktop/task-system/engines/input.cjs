"use strict";
const { sha256 } = require("../execution/common.cjs");
function inspectInput(engineId, bytes, dependencies) {
	const text = Buffer.from(bytes).toString("utf8"),
		restrictions = [],
		fieldStatus = {},
		requests = [];
	if (text.includes("\uFFFD")) restrictions.push("INPUT_ENCODING_UNVERIFIED");
	const jobs =
		engineId === "gaussian" ? text.split(/^\s*--link1--\s*$/im) : text.split(/^\s*\$new_job\s*$/im);
	for (const [jobIndex, job] of jobs.entries()) {
		const cpuValues = [],
			memoryValues = [];
		let cpuKind;
		if (engineId === "gaussian") {
			for (const match of job.matchAll(/^\s*%nprocshared\s*=\s*(\S+)\s*$/gim))
				cpuValues.push({ raw: match[1], value: /^\d+$/.test(match[1]) ? Number(match[1]) : null });
			for (const match of job.matchAll(/^\s*%mem\s*=\s*(\S+)\s*$/gim)) {
				const parsed = match[1].match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|KW|MW|GW|TW)?$/i);
				memoryValues.push(
					parsed
						? {
								value: parsed[1],
								unit: (parsed[2] || "W").toUpperCase(),
								scope: "total",
								raw: match[1]
							}
						: { raw: match[1], value: null }
				);
			}
			cpuKind = "threadsPerProcess";
		} else {
			for (const line of job.match(/^\s*!.*$/gm) || [])
				for (const match of line.matchAll(/\bPAL(\d+)\b/gi))
					cpuValues.push({ raw: match[0], value: Number(match[1]) });
			for (const block of job.matchAll(/%pal\b([\s\S]*?)\bend\b/gi))
				for (const match of block[1].matchAll(/\bnprocs\s+(\S+)/gi))
					cpuValues.push({
						raw: match[1],
						value: /^\d+$/.test(match[1]) ? Number(match[1]) : null
					});
			for (const match of job.matchAll(/^\s*%maxcore\s+(\S+)/gim))
				memoryValues.push(
					/^\d+(?:\.\d+)?$/.test(match[1])
						? { value: match[1], unit: "MB", scope: "per-process", raw: match[1] }
						: { raw: match[1], value: null }
				);
			cpuKind = "mpiProcesses";
		}
		const cpu = cpuValues.length ? cpuValues[0].value : null,
			memory = memoryValues.length ? memoryValues[0] : null;
		const cpuConflict = cpuValues.some(
			(value) =>
				value.value === null ||
				value.value < 1 ||
				!Number.isSafeInteger(value.value) ||
				value.value !== cpu
		);
		const memoryConflict = memoryValues.some(
			(value) =>
				value.value === null ||
				Number(value.value) <= 0 ||
				value.value !== memory?.value ||
				value.unit !== memory?.unit
		);
		const prefix = `jobs.${jobIndex}`;
		if (cpu === null || cpuConflict) {
			fieldStatus[`${prefix}.${cpuKind}`] = {
				state: cpuConflict ? "conflict" : "unknown",
				reason: cpuConflict
					? "Conflicting or invalid CPU declarations"
					: "CPU request absent from final input"
			};
			restrictions.push("CPU_REQUEST_UNRESOLVED");
		}
		if (!memory || memoryConflict) {
			fieldStatus[`${prefix}.memory`] = {
				state: memoryConflict ? "conflict" : "unknown",
				reason: memoryConflict
					? "Conflicting or invalid memory declarations"
					: "Memory request absent from final input"
			};
			restrictions.push("MEMORY_REQUEST_UNRESOLVED");
		}
		const dependencies = [];
		if (engineId === "gaussian") {
			for (const match of job.matchAll(/^\s*%(oldchk|chk)\s*=\s*(.+?)\s*$/gim))
				dependencies.push({
					kind: match[1].toLowerCase() === "oldchk" ? "required-input" : "output-or-existing-input",
					name: match[2],
					directive: match[1]
				});
			for (const match of job.matchAll(/^\s*@([^\r\n]+)$/gm))
				dependencies.push({ kind: "required-input", name: match[1].trim(), directive: "@include" });
			if (
				/\b(?:geom\s*=\s*\(?\s*(?:allcheck|check|checkpoint)|guess\s*=\s*\(?\s*read)\b/i.test(job)
			)
				dependencies.push({ kind: "checkpoint-read", name: null, directive: "route" });
		} else {
			for (const match of job.matchAll(/^\s*\*\s*xyzfile\s+-?\d+\s+\d+\s+(.+?)\s*$/gim))
				dependencies.push({
					kind: "required-input",
					name: match[1].replace(/^"(.*)"$/, "$1"),
					directive: "xyzfile"
				});
			for (const match of job.matchAll(/^\s*%(moinp|base)\s+"([^"]+)"/gim))
				dependencies.push({
					kind: match[1].toLowerCase() === "base" ? "output-prefix" : "required-input",
					name: match[2],
					directive: match[1]
				});
		}
		requests.push({
			jobIndex,
			inputRequest: {
				source: { contentHash: sha256(bytes), jobIndex },
				[cpuKind]: cpuConflict ? null : cpu,
				memory: memoryConflict ? null : memory,
				rawCpuDeclarations: cpuValues,
				rawMemoryDeclarations: memoryValues
			},
			dependencyReferences: dependencies
		});
	}
	if (jobs.length !== 1) restrictions.push("MULTI_JOB_RESOURCE_MAPPING_REQUIRES_EXPLICIT_TEMPLATE");
	return {
		parsedRequests: {
			engineId,
			jobs: requests,
			resources: {
				inputRequest: requests.length === 1 ? requests[0].inputRequest : null,
				schedulerRequest: null,
				grant: null,
				observation: null,
				fieldStatus: {
					schedulerRequest: { state: "unknown", reason: "Not requested from scheduler" },
					grant: { state: "unknown", reason: "Not observed" },
					observation: { state: "unknown", reason: "Not observed" }
				}
			}
		},
		fieldStatus,
		restrictions: [...new Set(restrictions)]
	};
}
function validateDependencies(interpretation, dependencies) {
	const restrictions = [...interpretation.restrictions];
	for (const job of interpretation.parsedRequests.jobs) {
		for (const output of job.dependencyReferences.filter((reference) =>
			["output-prefix", "output-or-existing-input"].includes(reference.kind)
		))
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(output.name || "") || output.name === "..")
				restrictions.push("OUTPUT_REFERENCE_OUTSIDE_TASK_DIRECTORY");
		const references = job.dependencyReferences.filter(
			(reference) => reference.kind === "required-input"
		);
		if (
			job.dependencyReferences.some((reference) => reference.kind === "checkpoint-read") &&
			!references.some((reference) => reference.directive.toLowerCase() === "oldchk")
		) {
			const checkpoint = job.dependencyReferences.find(
				(reference) => reference.directive.toLowerCase() === "chk"
			);
			if (checkpoint) references.push({ ...checkpoint, kind: "required-input" });
			else restrictions.push("CHECKPOINT_REFERENCE_UNRESOLVED");
		}
		for (const reference of references) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference.name || "") || reference.name === "..") {
				restrictions.push("DEPENDENCY_PATH_REQUIRES_EXPLICIT_PREPARATION");
				continue;
			}
			const matches = (dependencies || []).filter(
				(value) =>
					value.preparedName === reference.name ||
					value.preparedLocation?.path?.split(/[\\/]/).at(-1) === reference.name
			);
			if (
				matches.length !== 1 ||
				!matches[0].contentIdentity?.hash ||
				matches[0].integrity !== "complete"
			)
				restrictions.push(`DEPENDENCY_UNVERIFIED:${reference.name}`);
		}
	}
	return { ...interpretation, restrictions: [...new Set(restrictions)] };
}
module.exports = { inspectInput, validateDependencies };
