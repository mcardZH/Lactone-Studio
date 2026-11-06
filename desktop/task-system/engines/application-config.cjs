"use strict";
/** Host-only composition of frozen, evidenced configuration. No credentials, UI or native calls. */
const path = require("node:path");
const { sha256, fail } = require("../execution/common.cjs");
const { createDefaultEvidenceReaders } = require("./default-evidence.cjs");
const { locateWavefunction } = require("./wavefunction-source.cjs");
const { resolveOutputCandidates } = require("./output-candidates.cjs");
const { SLURM_TEMPLATE_VARIABLES } = require("../execution/slurm.cjs");
const WINDOWS_GAUSSIAN_CONTRACT = {
	commandMode: "gaussian-windows-options-v1",
	inputMode: "argument",
	argumentTemplate: ["-run", "-inp={input}", "-out={output}"],
	verified: true,
	evidenceRefs: ["adapter-contract:gaussian-windows-options-v1"],
	primaryOutputName: "output.out",
	nativeStdoutName: "native-stdout.txt"
};
function createTaskEnvironmentConfiguration({
	platform = process.platform,
	readSoftwareEvidence,
	readEnvironmentEvidence,
	readToolEvidence,
	windowsGaussianCommandMode,
	onProbeEvidence
} = {}) {
	const defaults = createDefaultEvidenceReaders({ platform, onProbeEvidence });
	readSoftwareEvidence ||= defaults.readSoftwareEvidence;
	readEnvironmentEvidence ||= defaults.readEnvironmentEvidence;
	readToolEvidence ||= defaults.readToolEvidence;
	const executionPlatform = (environment) =>
		environment.connectionKind === "local" ? platform : "linux";
	async function resolveSoftwareConfiguration(environment, context = {}) {
		if (!["gaussian", "orca"].includes(environment.engineId))
			return { executable: environment.executable, restrictions: ["ENGINE_EXECUTION_UNSUPPORTED"] };
		const targetPlatform = executionPlatform(environment),
			evidence =
				(await readSoftwareEvidence(environment, {
					...context,
					platform: targetPlatform,
					engineId: environment.engineId,
					executable: environment.executable
				})) || {},
			configuration = {
				executable: evidence.executable || environment.executable,
				environment: evidence.environment || {},
				commandMode: environment.engineId === "orca" ? "orca-argv-v1" : "gaussian-stdin-v1"
			};
		if (environment.engineId === "gaussian") {
			configuration.inputMode = "stdin";
			if (targetPlatform === "win32") {
				const contract =
					evidence.commandContract || windowsGaussianCommandMode || WINDOWS_GAUSSIAN_CONTRACT;
				configuration.commandMode = contract?.commandMode || "gaussian-argument-v1";
				configuration.inputMode = contract?.inputMode || "argument";
				if (contract?.argumentTemplate)
					configuration.argumentTemplate = [...contract.argumentTemplate];
				if (contract?.verified === true && contract.evidenceRefs?.length)
					configuration.commandModeEvidence = {
						verified: true,
						evidenceRefs: [...contract.evidenceRefs]
					};
				else configuration.restrictions = ["GAUSSIAN_WINDOWS_COMMAND_MODE_UNVERIFIED"];
				if (contract?.primaryOutputName)
					configuration.primaryOutputName = contract.primaryOutputName;
				if (contract?.nativeStdoutName) configuration.nativeStdoutName = contract.nativeStdoutName;
			}
		}
		if (evidence.rawVersion && evidence.entryIdentity && evidence.evidenceRefs?.length)
			configuration.versionMetadata = {
				rawVersion: evidence.rawVersion,
				engineIdentity: evidence.engineIdentity || null,
				entryIdentity: evidence.entryIdentity,
				evidenceRefs: evidence.evidenceRefs,
				distributionMembers:
					evidence.distributionMembers ||
					(evidence.distributionMemberIdentity ? [evidence.distributionMemberIdentity] : [])
			};
		else if (evidence.versionCommand) configuration.versionCommand = evidence.versionCommand;
		else
			configuration.restrictions = [
				...(configuration.restrictions || []),
				"SOFTWARE_VERSION_EVIDENCE_UNAVAILABLE"
			];
		if (evidence.nativeVerification) configuration.nativeVerification = evidence.nativeVerification;
		if (evidence.installationSettings)
			configuration.installationSettings = evidence.installationSettings;
		if (evidence.probeEvidence) configuration.probeEvidence = evidence.probeEvidence;
		if (
			targetPlatform === "win32" &&
			environment.engineId === "gaussian" &&
			evidence.installationSettings?.binPath
		)
			configuration.environment = {
				GAUSS_EXEDIR: evidence.installationSettings.binPath,
				PATH: evidence.installationSettings.binPath + ";" + (process.env.PATH || ""),
				...configuration.environment
			};
		return configuration;
	}
	async function resolveEnvironmentConfiguration(environment, context = {}) {
		if (environment.slurmMemoryPolicy !== undefined && !["input-request", "site-managed"].includes(environment.slurmMemoryPolicy)) fail("SLURM_MEMORY_POLICY_UNSUPPORTED");
		if (environment.slurmMemoryPolicy === "site-managed" && (environment.connectionKind !== "ssh" || environment.schedulerKind !== "slurm")) fail("SLURM_MEMORY_POLICY_REQUIRES_SSH_SLURM");
		if (environment.schedulerKind !== "slurm") return { scheduler: { kind: "none" } };
		const evidence = (await readEnvironmentEvidence(environment, context)) || {},
			scheduler = {
				kind: "slurm",
				connectionKind: environment.connectionKind,
				slurmMemoryPolicy: environment.slurmMemoryPolicy || "input-request",
				siteId: evidence.siteId || null,
				user: evidence.user || null,
				commands: evidence.commands || {},
				capabilities: evidence.capabilities || {},
				directives: evidence.directives || [],
				partition: environment.partition || "",
				account: environment.account || "",
				qos: environment.qos || "",
				timeLimit: environment.timeLimit || "",
				submitCommandTemplate: environment.submitCommandTemplate || "",
				initialization: environment.initialization || "",
				scriptTemplate: environment.scriptTemplate || "",
				workingRoot: environment.workingRoot,
				environment: evidence.environment || {},
				evidenceRefs: evidence.evidenceRefs || []
			};
		if (!scheduler.siteId || !scheduler.user)
			scheduler.restrictions = ["SLURM_SITE_USER_IDENTITY_UNVERIFIED"];
		scheduler.templateVariables = SLURM_TEMPLATE_VARIABLES;
		return { scheduler };
	}
	async function resolveResultPreparation({
		run,
		inputSnapshot,
		workLocation,
		operationId,
		transport,
		signal
	}) {
		const engineId = run.softwareSnapshot.engineId,
			targetPlatform = run.softwareSnapshot.platform,
			api = targetPlatform === "win32" ? path.win32 : path.posix,
			environment = run.environmentSnapshot.configuration || {};
		const located = locateWavefunction({
			engineId,
			inputSnapshot,
			environmentSnapshot: run.environmentSnapshot,
			workLocation,
			platform: targetPlatform
		});
		if (located.restricted) return located;
		const sourcePath = located.path,
			sourceArtifactId =
				"artifact-" +
				sha256(Buffer.from(`${run.runId}:native-wavefunction:${sourcePath}`)).slice(0, 32),
			outputArtifactId =
				"artifact-" +
				sha256(Buffer.from(`${run.runId}:prepared-wavefunction:${sourcePath}`)).slice(0, 32),
			format = engineId === "gaussian" ? "gaussian-checkpoint" : "orca-gbw",
			sourceArtifact = {
				artifactId: sourceArtifactId,
				runId: run.runId,
				path: sourcePath,
				roles: ["wavefunction", "restart"],
				format,
				formatVersion: run.softwareSnapshot.recognizedVersion || null,
				representation: "binary"
			};
		const extension = targetPlatform === "win32" ? ".exe" : "",
			toolName = (engineId === "gaussian" ? "formchk" : "orca_2mkl") + extension,
			candidatePath = api.join(
				api.dirname(run.environmentSnapshot.softwareAdapter.executable),
				toolName
			);
		let tool = null;
		try {
			tool =
				(await readToolEvidence({
					environment,
					run,
					engineId,
					toolName,
					candidatePath,
					transport,
					signal
				})) || null;
		} catch (error) {
			return {
				restricted: true,
				code: error.code || "MATCHING_CONVERSION_TOOL_UNAVAILABLE",
				reason: "转换工具采证失败；保留明确的原始波函数来源并待准备",
				sourceArtifact,
				outputArtifactId,
				toolCandidatePath: candidatePath
			};
		}
		if (
			!tool?.entryIdentity ||
			!tool.rawVersion ||
			tool.engineId !== engineId ||
			tool.compatibleWithRun !== true
		)
			return {
				restricted: true,
				code: "MATCHING_CONVERSION_TOOL_UNAVAILABLE",
				reason: "匹配本Run的软件/转换工具身份尚未核实，保留原始CHK/GBW并待准备",
				sourceArtifact,
				outputArtifactId,
				toolCandidatePath: candidatePath
			};
		const executable = tool.executable || tool.entryIdentity.path;
		if (!api.isAbsolute(executable)) fail("ABSOLUTE_CONVERSION_TOOL_REQUIRED");
		return {
			operationId,
			sourceArtifactId,
			outputArtifactId,
			sourceArtifact,
			sourcePath,
			sourceCopyName: engineId === "gaussian" ? "wavefunction.chk" : "wavefunction.gbw",
			outputName: engineId === "gaussian" ? "wavefunction.fchk" : "wavefunction.molden.input",
			compatibleWithRun: true,
			toolIdentity: tool,
			initialization: tool.initialization ?? environment.initialization ?? "",
			executionScope:
				run.environmentSnapshot.scheduler.kind === "slurm"
					? "original-allocation"
					: "same-frozen-environment",
			command: {
				executable,
				args: engineId === "gaussian" ? ["{source}", "{output}"] : ["{sourceBase}", "-molden"],
				env: {
					...(run.environmentSnapshot.softwareAdapter.environment || {}),
					...(tool.environment || {})
				}
			}
		};
	}
	return {
		resolveSoftwareConfiguration,
		resolveEnvironmentConfiguration,
		resolveResultPreparation,
		resolveOutputCandidates
	};
}
module.exports = {
	createTaskEnvironmentConfiguration,
	WINDOWS_GAUSSIAN_CONTRACT,
	resolveOutputCandidates
};
