export interface ResourceToken {
	start: number;
	end: number;
	raw: string;
}
export interface SubmissionResources {
	cpu: string;
	memory: string;
	unit: string;
	cpuTokens: ResourceToken[];
	memoryTokens: ResourceToken[];
	problems: string[];
}
/** Same binary units as the execution resource mapper; decimal arithmetic never rounds a budget. */
export function convertSubmissionMemory(value: string, from: string, to: string): string {
	const match = value.match(/^(\d+)(?:\.(\d+))?$/);
	const units: Record<string, bigint> = {
		B: 1n,
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
	if (!match || !units[from] || !units[to]) throw new Error("请先填写合法的内存值和单位。");
	const numerator = BigInt(match[1] + (match[2] ?? "")) * units[from];
	if (numerator <= 0n) throw new Error("内存须为正数。");
	const denominator = 10n ** BigInt(match[2]?.length ?? 0) * units[to];
	let result = String(numerator / denominator),
		remainder = numerator % denominator;
	if (remainder) {
		result += ".";
		while (remainder) {
			remainder *= 10n;
			result += String(remainder / denominator);
			remainder %= denominator;
		}
	}
	return result;
}
function tokens(text: string, pattern: RegExp, group = 1): ResourceToken[] {
	return [...text.matchAll(pattern)].map((match) => {
		const raw = match[group];
		const start = match.index! + match[0].lastIndexOf(raw);
		return { start, end: start + raw.length, raw };
	});
}
export function readSubmissionResources(
	engine: "gaussian" | "orca",
	text: string
): SubmissionResources {
	const problems: string[] = [];
	if (/^\s*(?:--link1--|\$new_job)\s*$/im.test(text))
		problems.push("多作业输入需逐作业核对资源，不能用单一面板覆盖。");
	let cpuTokens: ResourceToken[], memoryTokens: ResourceToken[];
	if (engine === "gaussian") {
		cpuTokens = tokens(text, /^[ \t]*%nprocshared[ \t]*=[ \t]*(\S+)[ \t]*$/gim);
		memoryTokens = tokens(text, /^[ \t]*%mem[ \t]*=[ \t]*(\S+)[ \t]*$/gim);
	} else {
		cpuTokens = [];
		for (const line of text.matchAll(/^[ \t]*!.*$/gm))
			for (const token of tokens(line[0], /\bPAL(\d+)\b/gi))
				cpuTokens.push({
					...token,
					start: token.start + line.index!,
					end: token.end + line.index!
				});
		for (const block of text.matchAll(/%pal\b([\s\S]*?)\bend\b/gi))
			for (const token of tokens(block[0], /\bnprocs[ \t]+(\S+)/gi))
				cpuTokens.push({
					...token,
					start: token.start + block.index!,
					end: token.end + block.index!
				});
		memoryTokens = tokens(text, /^[ \t]*%maxcore[ \t]+(\S+)/gim);
	}
	const cpu = cpuTokens[0]?.raw ?? "";
	const rawMemory = memoryTokens[0]?.raw ?? "";
	const memoryMatch = rawMemory.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
	const memory = memoryMatch?.[1] ?? rawMemory;
	const unit = engine === "orca" ? "MB" : memoryMatch?.[2]?.toUpperCase() || "W";
	if (
		cpuTokens.some(
			(token) =>
				!/^\d+$/.test(token.raw) ||
				Number(token.raw) < 1 ||
				!Number.isSafeInteger(Number(token.raw)) ||
				Number(token.raw) !== Number(cpu)
		)
	)
		problems.push("CPU声明冲突或无效，请在最终输入中修正。");
	if (
		memoryTokens.some((token) => token.raw.toUpperCase() !== rawMemory.toUpperCase()) ||
		(rawMemory &&
			(!memoryMatch ||
				Number(memory) <= 0 ||
				(engine === "gaussian" && !/^(?:[KMGT]?[BW])$/.test(unit)) ||
				(engine === "orca" && memoryMatch?.[2])))
	)
		problems.push("内存声明冲突或无效，请在最终输入中修正。");
	return { cpu, memory, unit, cpuTokens, memoryTokens, problems };
}
/** Project legacy units for the editor without rewriting the final input text. */
export function readSubmissionResourceEditor(engine: "gaussian" | "orca", text: string): SubmissionResources {
	const state = readSubmissionResources(engine, text);
	if (engine !== "gaussian" || state.unit === "MB" || state.unit === "GB") return state;
	if (!state.memory || state.problems.length) return { ...state, memory: "", unit: "GB" };
	try {
		const gb = convertSubmissionMemory(state.memory, state.unit, "GB");
		return gb.includes(".")
			? { ...state, memory: convertSubmissionMemory(state.memory, state.unit, "MB"), unit: "MB" }
			: { ...state, memory: gb, unit: "GB" };
	} catch { return { ...state, memory: "", unit: "GB" }; }
}
/** Replace resource token spans only; retain every other byte, including comments and line endings. */
export function patchSubmissionResource(
	engine: "gaussian" | "orca",
	text: string,
	field: "cpu" | "memory",
	value: string,
	unit = "MB"
): string {
	const state = readSubmissionResources(engine, text);
	if (state.problems.length) throw new Error(state.problems[0]);
	if (
		field === "cpu"
			? !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))
			: !/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0
	)
		throw new Error(field === "cpu" ? "核数/进程数须为正整数。" : "内存须为正数。");
	if (field === "memory" && engine === "gaussian" && !/^(?:[KMGT]?[BW])$/.test(unit))
		throw new Error("内存单位无效。");
	const replacement = field === "memory" && engine === "gaussian" ? value + unit : value;
	const spans = field === "cpu" ? state.cpuTokens : state.memoryTokens;
	if (spans.length)
		return [...spans]
			.sort((a, b) => b.start - a.start)
			.reduce(
				(result, token) => result.slice(0, token.start) + replacement + result.slice(token.end),
				text
			);
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const declaration =
		engine === "gaussian"
			? field === "cpu"
				? "%NProcShared=" + value
				: "%Mem=" + replacement
			: field === "cpu"
				? "%pal nprocs " + value + " end"
				: "%maxcore " + value;
	return declaration + newline + text;
}
export function submissionRestrictionMessage(code: string, engine: "gaussian" | "orca"): string {
	const messages: Record<string, string> = {
		CPU_REQUEST_UNRESOLVED:
			engine === "gaussian"
				? "最终输入未明确CPU核数，请填写 %NProcShared 或上方核数。"
				: "最终输入未明确进程数，请填写 PALn/%pal 或上方进程数。",
		MEMORY_REQUEST_UNRESOLVED:
			engine === "gaussian"
				? "最终输入未明确总内存，请填写 %Mem 或上方内存。"
				: "最终输入未明确每进程内存，请填写 %maxcore 或上方内存。",
		MULTI_JOB_RESOURCE_MAPPING_REQUIRES_EXPLICIT_TEMPLATE:
			"多作业输入尚不能可靠映射资源，请逐作业核对。"
	};
	return messages[code] ?? "提交条件尚未满足，请查看详情并修正。";
}
