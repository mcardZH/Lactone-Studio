"use strict";
const { createHash } = require("node:crypto");

// This is an admission reader for an already expanded script, never a shell
// evaluator or a statement about the resources Slurm will actually allocate.
const FIELDS = {
	"--ntasks": "ntasks",
	"-n": "ntasks",
	"--cpus-per-task": "cpusPerTask",
	"-c": "cpusPerTask",
	"--nodes": "nodes",
	"-N": "nodes",
	"--ntasks-per-node": "ntasksPerNode",
	"--mem": "memoryPerNode",
	"--mem-per-cpu": "memoryPerCpu"
};
const NEUTRAL_VALUES = new Set([
	"--partition",
	"-p",
	"--account",
	"-A",
	"--qos",
	"-q",
	"--time",
	"-t",
	"--job-name",
	"-J",
	"--output",
	"-o",
	"--error",
	"-e",
	"--chdir",
	"-D",
	"--comment",
	"--export",
	"--mail-type",
	"--mail-user",
	"--open-mode"
]);
const NEUTRAL_FLAGS = new Set(["--exclusive", "--no-requeue", "--requeue", "--parsable"]);
const MEMORY_UNITS = {
	K: ["KiB", 1024n],
	M: ["MiB", 1024n ** 2n],
	G: ["GiB", 1024n ** 3n],
	T: ["TiB", 1024n ** 4n]
};
function positiveInteger(value) {
	return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0
		? Number(value)
		: null;
}
function parseMemory(raw, scope) {
	const match = String(raw).match(/^(\d+)([KMGT])?$/i);
	if (!match || !positiveInteger(match[1])) return null;
	const [unit, multiplier] = MEMORY_UNITS[(match[2] || "M").toUpperCase()];
	return {
		value: match[1],
		unit,
		scope,
		raw: String(raw),
		normalizedBytes: (BigInt(match[1]) * multiplier).toString()
	};
}
function tokensOf(text) {
	const tokens = [];
	let value = "",
		quote = null,
		started = false;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = null;
			else value += char;
			started = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "#" && !started) break;
		if (/\s/.test(char)) {
			if (started) tokens.push(value);
			value = "";
			started = false;
		} else {
			value += char;
			started = true;
		}
	}
	if (started) tokens.push(value);
	return quote ? null : tokens;
}
function inputMemoryRatio(memory) {
	const value = String(memory?.value ?? ""),
		match = value.match(/^(\d+)(?:\.(\d+))?$/);
	if (!match) return null;
	const unit = String(memory.unit || "").toUpperCase();
	const units = {
		B: 1n,
		KIB: 1024n,
		MIB: 1024n ** 2n,
		GIB: 1024n ** 3n,
		TIB: 1024n ** 4n,
		KB: 1024n,
		MB: 1024n ** 2n,
		GB: 1024n ** 3n,
		TB: 1024n ** 4n,
		W: 8n,
		KW: 8n * 1024n,
		MW: 8n * 1024n ** 2n,
		GW: 8n * 1024n ** 3n,
		TW: 8n * 1024n ** 4n
	};
	if (!units[unit]) return null;
	const numerator = BigInt(match[1] + (match[2] || "")) * units[unit];
	return numerator > 0n ? { numerator, denominator: 10n ** BigInt((match[2] || "").length) } : null;
}
/** Only the standard wrapper calls this. No explicit field is replaced and no
 * site/global CPU or memory default is supplied. */
function standardInputDirectives({ engineId, parsedRequests, declarations = {}, memoryPolicy = "input-request" }) {
	const directives = [], generatedFields = {}, input = parsedRequests?.resources?.inputRequest;
	if (!["gaussian", "orca"].includes(engineId) || parsedRequests?.engineId && parsedRequests.engineId !== engineId) return { directives, generatedFields };
	const cpu = positiveInteger(input?.[engineId === "gaussian" ? "threadsPerProcess" : "mpiProcesses"]);
	const add = (field, flag, value, detail = {}) => {
		if (declarations[field]?.length) return;
		directives.push(`--${flag}=${value}`);
		generatedFields[field] = { kind: "final-input-resource-mapping", engineId, inputSource: input?.source, ...detail };
	};
	if (cpu) {
		add("nodes", "nodes", 1);
		if (!declarations.ntasksPerNode?.length) add("ntasks", "ntasks", engineId === "gaussian" ? 1 : cpu);
		add("cpusPerTask", "cpus-per-task", engineId === "gaussian" ? cpu : 1);
	}
	const memory = inputMemoryRatio(input?.memory), scope = engineId === "gaussian" ? "total" : "per-process";
	if (memoryPolicy === "input-request" && !declarations.memoryPerNode?.length && !declarations.memoryPerCpu?.length && memory && input.memory.scope === scope && (engineId === "gaussian" || cpu)) {
		const processes = engineId === "orca" ? cpu : 1;
		const denominator = memory.denominator * 1024n;
		const kib = (memory.numerator * BigInt(processes) + denominator - 1n) / denominator;
		for (const [suffix, factor] of [["T", 1024n ** 3n], ["G", 1024n ** 2n], ["M", 1024n], ["K", 1n]]) if (kib % factor === 0n) {
			add("memoryPerNode", "mem", `${kib / factor}${suffix}`, { memorySemantics: engineId === "orca" ? "major-working-memory-only" : "input-total-working-memory", processes, extraOverheadInferred: false, rounding: "up-to-KiB" }); break;
		}
	}
	return { directives, generatedFields };
}
function evidenced(value) {
	const source = value?.source;
	const hasSource =
		typeof source === "string"
			? source.trim().length > 0
			: source &&
				typeof source === "object" &&
				!Array.isArray(source) &&
				Object.keys(source).length > 0;
	return (
		hasSource &&
		Array.isArray(value.evidenceRefs) &&
		value.evidenceRefs.length > 0 &&
		value.evidenceRefs.every((ref) => typeof ref === "string" && ref.trim())
	);
}

/**
 * siteDefaults accepts {ntasks, cpusPerTask, nodes, ntasksPerNode,
 * memory:{value,unit,scope}, source, evidenceRefs}; individual fields can instead
 * be {value,source,evidenceRefs}. Defaults describe actual frozen site evidence,
 * not ES settings. Unsupported fields never supply a missing resource.
 */
function inspectSlurmResources({ scriptText, engineId, parsedRequests, siteDefaults, memoryPolicy = "input-request", generatedFields = {} } = {}) {
	const text = typeof scriptText === "string" ? scriptText : "";
	const restrictions = [],
		fieldStatus = {},
		declarations = {},
		rawDirectives = [],
		ignoredDirectives = [];
	const restrict = (code, field, state, reason) => {
		restrictions.push(code);
		if (field) fieldStatus[field] = { state, reason };
	};
	if (!["input-request", "site-managed"].includes(memoryPolicy)) restrict("SLURM_MEMORY_POLICY_UNSUPPORTED", "memoryPolicy", "unsupported", "Unknown Slurm memory policy");
	if (typeof scriptText !== "string" || /\0|\uFFFD/.test(text))
		restrict(
			"SLURM_SCRIPT_TEXT_UNVERIFIED",
			"script",
			"unknown",
			"Final script text is absent or contains invalid characters"
		);
	let executableSeen = false;
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const match = line.match(/^\s*#SBATCH(?:\s+(.*))?$/);
		if (!match) {
			if (line.trim() && !line.trimStart().startsWith("#")) executableSeen = true;
			continue;
		}
		const record = { lineNumber: index + 1, text: line };
		if (executableSeen) {
			ignoredDirectives.push(record);
			continue;
		}
		rawDirectives.push(record);
		if (/\\\s*$/.test(line)) {
			restrict(
				"SLURM_DIRECTIVE_SYNTAX_UNSUPPORTED",
				"script",
				"unsupported",
				"Multiline directives are not evaluated"
			);
			continue;
		}
		const tokens = tokensOf(match[1] || "");
		if (!tokens) {
			restrict(
				"SLURM_DIRECTIVE_SYNTAX_UNSUPPORTED",
				"script",
				"unsupported",
				"Unclosed directive quotation"
			);
			continue;
		}
		for (let offset = 0; offset < tokens.length; offset++) {
			const token = tokens[offset];
			let flag = token,
				raw;
			if (token.startsWith("--") && token.includes("=")) {
				const split = token.indexOf("=");
				flag = token.slice(0, split);
				raw = token.slice(split + 1);
			} else if (/^-[ncN].+/.test(token)) {
				flag = token.slice(0, 2);
				raw = token.slice(2).replace(/^=/, "");
			}
			if (FIELDS[flag] || NEUTRAL_VALUES.has(flag)) {
				if (raw === undefined && offset + 1 < tokens.length && !tokens[offset + 1].startsWith("-"))
					raw = tokens[++offset];
				if (FIELDS[flag]) {
					const field = FIELDS[flag];
					(declarations[field] ||= []).push({
						raw: raw ?? "",
						flag,
						source: { kind: "sbatch-directive", ...record }
					});
				} else if (raw === undefined)
					restrict(
						"SLURM_DIRECTIVE_SYNTAX_UNSUPPORTED",
						"script",
						"unsupported",
						`Missing value for ${flag}`
					);
			} else if (!NEUTRAL_FLAGS.has(flag) || raw !== undefined) {
				restrict(
					"SLURM_RESOURCE_OPTION_UNSUPPORTED",
					"script",
					"unsupported",
					`Unsupported directive option ${flag}`
				);
				// Consume the unknown option's separate value without interpreting it.
				if (raw === undefined && tokens[offset + 1] && !tokens[offset + 1].startsWith("-"))
					offset++;
			}
		}
	}
	const resolved = {};
	for (const field of [
		"ntasks",
		"cpusPerTask",
		"nodes",
		"ntasksPerNode",
		"memoryPerNode",
		"memoryPerCpu"
	]) {
		const values = declarations[field] || [];
		if (!values.length && !field.startsWith("memory")) {
			const entry = siteDefaults?.[field];
			const proof = evidenced(entry) ? entry : evidenced(siteDefaults) ? siteDefaults : null;
			const raw = entry && typeof entry === "object" ? entry.value : entry;
			if (entry !== undefined && proof)
				values.push({
					raw: String(raw),
					source: { kind: "site-default", source: proof.source, evidenceRefs: proof.evidenceRefs }
				});
			else if (entry !== undefined)
				fieldStatus[field] = {
					state: "unknown",
					reason: "Site default lacks source and evidenceRefs"
				};
		}
		if (!values.length) continue;
		const parsed = values.map((entry) => ({
			...entry,
			value: field.startsWith("memory")
				? parseMemory(entry.raw, field === "memoryPerNode" ? "per-node" : "per-cpu")
				: positiveInteger(entry.raw)
		}));
		const key = (item) =>
			typeof item.value === "object" ? item.value?.normalizedBytes : item.value;
		const first = parsed[0];
		if (parsed.some((item) => item.value === null || key(item) !== key(first))) {
			restrict(
				"SLURM_RESOURCE_DECLARATION_UNRESOLVED",
				field,
				parsed.some((item) => item.value === null) ? "unsupported" : "conflict",
				"Nonliteral, invalid or conflicting resource declarations"
			);
			continue;
		}
		resolved[field] = field.startsWith("memory")
			? { ...first.value, source: first.source }
			: first.value;
		fieldStatus[field] = { state: "known", source: first.source };
		if (generatedFields[field]) {
			const source = { ...generatedFields[field], directiveSource: first.source };
			fieldStatus[field].source = source;
			if (field.startsWith("memory")) resolved[field].source = source;
		}
	}
	// A default memory object uses explicit units and scope, never an inferred total.
	if (
		memoryPolicy !== "site-managed" && !declarations.memoryPerNode &&
		!declarations.memoryPerCpu &&
		siteDefaults?.memory !== undefined
	) {
		const memory = siteDefaults.memory,
			proof = evidenced(memory) ? memory : evidenced(siteDefaults) ? siteDefaults : null;
		const suffix = { KiB: "K", MiB: "M", GiB: "G", TiB: "T", K: "K", M: "M", G: "G", T: "T" }[
			memory?.unit
		];
		const field =
			memory?.scope === "per-node"
				? "memoryPerNode"
				: memory?.scope === "per-cpu"
					? "memoryPerCpu"
					: null;
		const parsed = suffix && field && parseMemory(`${memory.value}${suffix}`, memory.scope);
		if (proof && parsed) {
			resolved[field] = {
				...parsed,
				source: { kind: "site-default", source: proof.source, evidenceRefs: proof.evidenceRefs }
			};
			fieldStatus[field] = { state: "known", source: resolved[field].source };
		} else
			fieldStatus.memory = {
				state: "unknown",
				reason: "Site memory default needs supported explicit units/scope and source/evidenceRefs"
			};
	}
	if (declarations.memoryPerNode && declarations.memoryPerCpu) {
		delete resolved.memoryPerNode;
		delete resolved.memoryPerCpu;
		restrict(
			"SLURM_MEMORY_OPTIONS_CONFLICT",
			"memory",
			"conflict",
			"--mem and --mem-per-cpu are mutually exclusive"
		);
	}
	let tasks = resolved.ntasks;
	if (tasks === undefined && !declarations.ntasks && resolved.nodes && resolved.ntasksPerNode) {
		const derived = resolved.nodes * resolved.ntasksPerNode;
		if (Number.isSafeInteger(derived)) {
			tasks = derived;
			fieldStatus.ntasks = {
				state: "known",
				source: { kind: "derived-explicit-request", fields: ["nodes", "ntasksPerNode"] }
			};
		}
	}
	const cpus = resolved.cpusPerTask;
	let totalCpu = tasks && cpus && Number.isSafeInteger(tasks * cpus) ? tasks * cpus : null;
	if (
		restrictions.includes("SLURM_RESOURCE_OPTION_UNSUPPORTED") ||
		restrictions.includes("SLURM_DIRECTIVE_SYNTAX_UNSUPPORTED")
	)
		totalCpu = null;
	if (!totalCpu)
		restrict(
			"SLURM_CPU_REQUEST_UNRESOLVED",
			"cpuCores",
			"unknown",
			"Explicit task count and CPUs per task are required"
		);
	else
		fieldStatus.cpuCores = {
			state: "known",
			source: { kind: "derived-explicit-request", fields: ["ntasks", "cpusPerTask"] }
		};
	if (
		tasks &&
		resolved.nodes &&
		resolved.ntasksPerNode &&
		tasks > resolved.nodes * resolved.ntasksPerNode
	)
		restrict(
			"SLURM_TASK_PLACEMENT_CONFLICT",
			"placement",
			"conflict",
			"Task count exceeds the explicit nodes times maximum tasks per node"
		);
	let memory = resolved.memoryPerNode || resolved.memoryPerCpu || null;
	if (memoryPolicy === "site-managed") {
		const ignoredMemory = ignoredDirectives.some(record => tokensOf(record.text.replace(/^\s*#SBATCH\s*/, ""))?.some(token => /^--mem(?:-per-cpu)?(?:=|$)/.test(token)));
		if (declarations.memoryPerNode || declarations.memoryPerCpu || ignoredMemory) restrict("SLURM_MEMORY_POLICY_CONFLICT", "memory", "conflict", "站点管理内存策略与脚本显式内存指令冲突；未删除手稿。");
		else fieldStatus.memory = { state: "unknown", reason: "站点管理，调度器未核定内存；输入预算须单独校验", source: { kind: "environment-slurm-memory-policy", policy: "site-managed" } };
		if (resolved.nodes !== 1) restrict("SLURM_SITE_MANAGED_SINGLE_NODE_REQUIRED", "placement", "unsupported", "Site-managed memory supports only an explicit single-node request");
		memory = null;
	} else if (!memory)
		restrict(
			"SLURM_MEMORY_REQUEST_UNRESOLVED",
			"memory",
			fieldStatus.memory?.state || "unknown",
			fieldStatus.memory?.reason || "Explicit supported memory request is required"
		);
	else fieldStatus.memory = { state: "known", source: memory.source };
	const input = parsedRequests?.resources?.inputRequest;
	if (
		!["gaussian", "orca"].includes(engineId) ||
		(parsedRequests?.engineId && parsedRequests.engineId !== engineId)
	)
		restrict(
			"SLURM_ENGINE_RESOURCE_MAPPING_UNSUPPORTED",
			"inputMapping",
			"unsupported",
			"Only matching Gaussian or ORCA input requests are supported"
		);
	else {
		const requestedCpu = positiveInteger(
			input?.[engineId === "gaussian" ? "threadsPerProcess" : "mpiProcesses"]
		);
		if (!requestedCpu)
			restrict(
				"SLURM_INPUT_CPU_UNRESOLVED",
				"inputMapping.cpu",
				"unknown",
				"Reliable final input CPU request is required"
			);
		else if (totalCpu) {
			if (engineId === "gaussian" && (tasks !== 1 || resolved.nodes > 1))
				restrict(
					"SLURM_GAUSSIAN_SHARED_MEMORY_MAPPING_CONFLICT",
					"inputMapping.cpu",
					"conflict",
					"Gaussian shared threads require one task on one node"
				);
			else if (engineId === "orca" && cpus !== 1)
				restrict(
					"SLURM_ORCA_MPI_MAPPING_CONFLICT",
					"inputMapping.cpu",
					"conflict",
					"ORCA MPI mapping requires explicit one CPU per process"
				);
			else if ((engineId === "gaussian" ? cpus : tasks) < requestedCpu)
				restrict(
					"SLURM_CPU_REQUEST_INSUFFICIENT",
					"inputMapping.cpu",
					"conflict",
					"Scheduler request is smaller than the final input CPU request"
				);
			else
				fieldStatus["inputMapping.cpu"] = {
					state: "known",
					reason: "Explicit scheduler request covers the final input request"
				};
		}
		const required = inputMemoryRatio(input?.memory),
			expectedScope = engineId === "gaussian" ? "total" : "per-process";
		if (!required || input?.memory?.scope !== expectedScope)
			restrict(
				"SLURM_INPUT_MEMORY_UNRESOLVED",
				"inputMapping.memory",
				"unknown",
				"Reliable final input memory value, unit and engine scope are required"
			);
		else if (memoryPolicy === "site-managed") {
			fieldStatus["inputMapping.memory"] = { state: "known", reason: "Final input working-memory budget retained; scheduler memory is not verified", source: input.memory };
			if (fieldStatus.memory?.state === "unknown") fieldStatus.memory.reason = "站点管理，调度器未核定内存；输入预算仍有效";
		} else if (memory && requestedCpu) {
			let available,
				needed = required.numerator;
			if (memory.scope === "per-cpu") {
				if (engineId === "orca" || cpus)
					available = BigInt(memory.normalizedBytes) * BigInt(engineId === "gaussian" ? cpus : 1);
			} else if (
				resolved.nodes === 1 ||
				(engineId === "gaussian" && tasks === 1 && !resolved.nodes)
			) {
				available = BigInt(memory.normalizedBytes);
				if (engineId === "orca") needed *= BigInt(requestedCpu);
			} else
				restrict(
					"SLURM_MEMORY_PLACEMENT_UNRESOLVED",
					"inputMapping.memory",
					"unknown",
					"Per-node memory comparison requires an explicit single-node mapping"
				);
			if (available !== undefined) {
				if (available * required.denominator < needed)
					restrict(
						"SLURM_MEMORY_REQUEST_INSUFFICIENT",
						"inputMapping.memory",
						"conflict",
						"Scheduler memory request does not cover the input working-memory request"
					);
				else
					fieldStatus["inputMapping.memory"] = {
						state: "known",
						reason:
							engineId === "orca"
								? "Covers per-process major working memory only; no total RSS bound or extra overhead inferred"
								: "Covers final input memory request"
					};
			} else if (!fieldStatus["inputMapping.memory"])
				restrict(
					"SLURM_MEMORY_PLACEMENT_UNRESOLVED",
					"inputMapping.memory",
					"unknown",
					"Per-CPU memory comparison requires a reliable CPUs-per-task request"
				);
		}
	}
	const source = {
		kind: "expanded-slurm-script",
		algorithm: "sha256",
		contentHash: createHash("sha256").update(text).digest("hex"),
		text,
		phase: "submission-request",
		memoryPolicy
	};
	const schedulerRequest = {
		source,
		cpuCores: totalCpu,
		...(engineId === "orca" ? { mpiProcesses: tasks ?? null } : {}),
		threadsPerProcess: cpus ?? null,
		memory,
		slurmMemoryPolicy: memoryPolicy,
		slurm: {
			ntasks: tasks ?? null,
			cpusPerTask: cpus ?? null,
			nodes: resolved.nodes ?? null,
			ntasksPerNode: resolved.ntasksPerNode ?? null,
			cpuUnit: "slurm-cpu",
			fieldSources: Object.fromEntries(
				Object.entries(fieldStatus)
					.filter(([, status]) => status.source)
					.map(([field, status]) => [field, status.source])
			),
			rawDirectives,
			ignoredDirectives,
			declarations
		}
	};
	fieldStatus.schedulerRequest = {
		state: restrictions.length ? "restricted" : "known",
		reason: "Submission request only; grant and observation are not inferred"
	};
	schedulerRequest.fieldStatus = { ...fieldStatus };
	return { schedulerRequest, restrictions: [...new Set(restrictions)], fieldStatus };
}
module.exports = { inspectSlurmResources, standardInputDirectives };
