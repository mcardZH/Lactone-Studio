"use strict";
const path = require("node:path");
const { basename } = require("../execution/common.cjs");
function locateWavefunction({
	engineId,
	inputSnapshot,
	environmentSnapshot,
	workLocation,
	platform
}) {
	const jobs = inputSnapshot.parsedRequests?.jobs,
		api = platform === "win32" ? path.win32 : path.posix;
	const restricted = (code, reason) => ({ restricted: true, code, reason });
	if (!Array.isArray(jobs) || jobs.length !== 1)
		return restricted("WAVEFUNCTION_SOURCE_JOB_UNRESOLVED", "最终输入的job来源尚不能可靠定位");
	const refs = jobs[0].dependencyReferences || [];
	let name;
	if (engineId === "gaussian") {
		const checkpoints = refs
			.filter((ref) => String(ref.directive).toLowerCase() === "chk")
			.map((ref) => ref.name);
		if (checkpoints.length !== 1)
			return restricted(
				"NO_UNIQUE_DECLARED_CHECKPOINT",
				"最终输入没有唯一明确的%chk来源；不会补造或修改科学输入"
			);
		name = checkpoints[0];
	} else if (engineId === "orca") {
		const bases = refs.filter((ref) => ref.kind === "output-prefix").map((ref) => ref.name);
		if (bases.length > 1)
			return restricted("ORCA_OUTPUT_BASE_CONFLICT", "最终输入的ORCA输出basename冲突");
		name =
			(bases[0] || basename(inputSnapshot.preparedName || "input.inp").replace(/\.[^.]+$/, "")) +
			".gbw";
	} else
		return restricted("ENGINE_PREPARATION_UNSUPPORTED", "当前引擎没有获批的波函数格式准备适配");
	try {
		basename(name);
	} catch {
		return restricted("WAVEFUNCTION_SOURCE_OUTSIDE_RUN", "波函数来源不是当前支持的单文件名");
	}
	if (engineId === "gaussian" && platform === "win32" && environmentSnapshot.softwareAdapter.commandMode !== "gaussian-windows-cli-v1") {
		const settings = environmentSnapshot.softwareAdapter.installationSettings;
		if (
			!settings?.iniIdentity ||
			!settings.iniSha256 ||
			!settings.evidenceRefs?.length ||
			!api.isAbsolute(settings.scratchDirPath || "")
		)
			return restricted(
				"GAUSSIAN_WINDOWS_INI_MAPPING_UNVERIFIED",
				"G16W相对CHK的实际INI ScratchDir_Path尚未核实"
			);
		return {
			name,
			path: api.join(settings.scratchDirPath, name),
			root: settings.scratchDirPath,
			external: true,
			installationIni: {
				path: settings.iniPath,
				identity: settings.iniIdentity,
				sha256: settings.iniSha256
			}
		};
	}
	return {
		name,
		path: api.join(workLocation.path, name),
		root: workLocation.path,
		external: false
	};
}
module.exports = { locateWavefunction };
