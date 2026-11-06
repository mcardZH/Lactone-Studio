"use strict";
const path = require("node:path");
const { sha256, fail } = require("../execution/common.cjs");
const { commandScript } = require("../transports/posix.cjs");
const ps = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function crt(value) {
	return !/[\s"]/.test(value) && value
		? value
		: '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}
function windowsArguments(command) {
	if (command.argumentSerialization === "gaussian-windows-options-v1") {
		require("../platform/process-identity.cjs").validateArgumentSerialization(command);
		return `-run -inp="${command.args[1].slice(5)}" -out="${command.args[2].slice(5)}"`;
	}
	return command.args.map(crt).join(" ");
}
function defaultCalculationScript(launch, platform) {
	const command = launch.command;
	if (platform !== "win32")
		return {
			kind: "bash",
			text: `#!/usr/bin/env bash\nset -e\n${launch.initialization || ""}\n${commandScript(command)}${command.stdinPath ? " < " + require("../execution/common.cjs").quote(command.stdinPath) : ""}\n`
		};
	// ORCA's Windows MPI launcher expects native separators in its executable pathname.
	const executable = launch.engineId === "orca" ? path.win32.normalize(command.executable) : command.executable;
	const env = Object.entries(command.env || {})
		.map(
			([key, value]) => `[Environment]::SetEnvironmentVariable(${ps(key)}, ${ps(value)}, 'Process')`
		)
		.join("\n");
	return {
		kind: "powershell",
		text: `$ErrorActionPreference = 'Stop'\n${launch.initialization || ""}\n${env}\n$esStart = New-Object System.Diagnostics.ProcessStartInfo\n$esStart.FileName = ${ps(executable)}\n$esStart.Arguments = ${ps(windowsArguments(command))}\n$esStart.WorkingDirectory = ${ps(command.cwd)}\n$esStart.UseShellExecute = $false\n$esStart.CreateNoWindow = $true\n$esStart.RedirectStandardOutput = $true\n$esStart.RedirectStandardError = $true\n$esStart.RedirectStandardInput = $true\n$esNative = [System.Diagnostics.Process]::Start($esStart)\n$esOut = [IO.File]::Open(${ps(command.stdoutPath)}, [IO.FileMode]::CreateNew)\n$esErr = [IO.File]::Open(${ps(command.stderrPath)}, [IO.FileMode]::CreateNew)\ntry {\n  $esOutCopy = $esNative.StandardOutput.BaseStream.CopyToAsync($esOut)\n  $esErrCopy = $esNative.StandardError.BaseStream.CopyToAsync($esErr)\n  ${command.stdinPath ? `$esIn = [IO.File]::OpenRead(${ps(command.stdinPath)}); try { $esIn.CopyTo($esNative.StandardInput.BaseStream) } finally { $esIn.Dispose() }` : ""}\n  $esNative.StandardInput.Close()\n  $esNative.WaitForExit()\n  $esOutCopy.GetAwaiter().GetResult()\n  $esErrCopy.GetAwaiter().GetResult()\n  exit $esNative.ExitCode\n} finally { $esOut.Dispose(); $esErr.Dispose(); $esNative.Dispose() }\n`
	};
}
function calculationScriptIdentity(script) {
	if (
		!script ||
		!["bash", "powershell"].includes(script.kind) ||
		typeof script.text !== "string" ||
		!script.text.trim() ||
		script.text.includes("\0")
	)
		fail("CALCULATION_SCRIPT_INVALID");
	const bytes = Buffer.from(script.text, "utf8");
	return { algorithm: "sha256", hash: sha256(bytes), byteSize: bytes.length };
}
/** This batch checks the known standard launch assignments only; it does not
 * claim to prove arbitrary PowerShell semantics. The native file owner remains
 * responsible for observing the actual scratch/checkpoint mapping. */
function assertGaussianWindowsScriptMapping(script, launch) {
	if (!launch.gaussianWindowsFiles) return;
	const expected = {FileName:launch.command.executable,Arguments:windowsArguments(launch.command),WorkingDirectory:launch.command.cwd};
	for (const [field,value] of Object.entries(expected)) {
		const lines = [...script.text.matchAll(new RegExp("^\\s*\\$esStart\\."+field+"\\s*=([^\\r\\n]*)$","gim"))];
		const literal = lines.length === 1 ? lines[0][1].trim().match(/^'((?:[^']|'')*)'$/) : null;
		if (!literal) fail("GAUSSIAN_WINDOWS_SCRIPT_MAPPING_UNVERIFIED",{field,reason:"本次Windows Gaussian任务路径合同无法核实该手稿的唯一字面量启动设置；保留原稿，可恢复系统稿。"});
		const actual = literal[1].replaceAll("''", "'");
		if (actual !== value) fail("GAUSSIAN_WINDOWS_SCRIPT_PATH_CONFLICT",{field,expected:value,actual,reason:"手稿启动设置与本次任务工作目录及scratch映射冲突；保留原稿，可恢复系统稿。"});
	}
}
const CALCULATION_TEMPLATE_VARIABLES = Object.freeze([
	{
		name: "standardScript",
		description: "本次完整标准计算脚本，含真实输入/输出、软件入口、初始化及已解析资源；必须恰好一次"
	},
	{ name: "workingPath", description: "本次任务工作目录，自动按目标shell引用，请勿再套引号" }
]);
function renderCalculationTemplate(template, launch, platform) {
	if (typeof template !== "string" || !template.trim() || template.includes("\0"))
		fail("CALCULATION_TEMPLATE_INVALID");
	const standard = defaultCalculationScript(launch, platform);
	let count = 0;
	const text = template.replace(/(?<![$\\])\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, key, offset) => {
		if (key === "standardScript") {
			count++;
			return standard.text;
		}
		if (key !== "workingPath") fail("CALCULATION_TEMPLATE_UNKNOWN_VARIABLE", { variable: key });
		const before = template.slice(0, offset),
			after = template.slice(offset + token.length);
		if ((before && !/[\s;(]$/.test(before)) || (after && !/^[\s;)]/.test(after)))
			fail("CALCULATION_TEMPLATE_PATH_MUST_BE_BARE_TOKEN");
		return platform === "win32"
			? ps(launch.command.cwd)
			: require("../execution/common.cjs").quote(launch.command.cwd);
	});
	if (count !== 1) fail("CALCULATION_TEMPLATE_SINGLE_STANDARD_SCRIPT_REQUIRED");
	return { kind: standard.kind, text };
}
function resolveCalculationScript({ launch, softwareSnapshot, override, environment }) {
	const platform = softwareSnapshot.platform;
	const template =
		environment?.configuration?.calculationTemplate ?? environment?.calculationTemplate;
	const script =
		override ||
		(template?.trim()
			? renderCalculationTemplate(template, launch, platform)
			: defaultCalculationScript(launch, platform));
	if (script.kind !== (platform === "win32" ? "powershell" : "bash"))
		fail("CALCULATION_SCRIPT_PLATFORM_MISMATCH");
	assertGaussianWindowsScriptMapping(script,launch);
	const identity = calculationScriptIdentity(script);
	return {
		script,
		identity,
		launch: { ...launch, calculationScript: script, calculationScriptIdentity: identity },
		restrictions: []
	};
}
function windowsScriptCommand(command, script, identity) {
	const actual = calculationScriptIdentity(script);
	if (!identity || actual.hash !== identity.hash || actual.byteSize !== identity.byteSize)
		fail("CALCULATION_SCRIPT_IDENTITY_CHANGED");
	return {
		executable: path.win32.join(
			process.env.SystemRoot || "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe"
		),
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script.text, "utf16le").toString("base64")
		],
		cwd: command.cwd,
		env: command.env,
		stdoutPath: path.win32.join(command.cwd, ".es-execution", "calculation-stdout.txt"),
		stderrPath: path.win32.join(command.cwd, ".es-execution", "calculation-stderr.txt"),
		...(command.lifecycle
			? { lifecycle: { ...command.lifecycle, scriptNativeExecutable: command.executable } }
			: {})
	};
}
module.exports = {
	defaultCalculationScript,
	CALCULATION_TEMPLATE_VARIABLES,
	renderCalculationTemplate,
	calculationScriptIdentity,
	assertGaussianWindowsScriptMapping,
	resolveCalculationScript,
	windowsScriptCommand
};
