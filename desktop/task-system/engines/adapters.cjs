"use strict";
const path = require("node:path");
const { inspectInput, validateDependencies } = require("./input.cjs");
const {
	fail,
	requireText,
	basename,
	joinLocation,
	sha256,
	unchanged
} = require("../execution/common.cjs");
const ADAPTER_VERSION = "1.0.0";
const { locateWavefunction } = require("./wavefunction-source.cjs");
function engineFamily(rawVersion) {
	if (typeof rawVersion !== "string") return null;
	const gaussian =
			/\bGaussian\s*(?:\([^)]*\)\s*)?\d{2,4}W?\b|\b[A-Za-z0-9_-]*G\d{2}Rev[A-Z]\.\d+\b/i.test(
				rawVersion
			),
		orca = /\bORCA\b|\bO\s+R\s+C\s+A\b/i.test(rawVersion);
	return gaussian && orca ? "conflict" : gaussian ? "gaussian" : orca ? "orca" : null;
}
function assertEngineFamily(engineId, softwareSnapshot) {
	const family = engineFamily(softwareSnapshot.rawVersion),
		identity = softwareSnapshot.engineIdentity;
	if (family === "conflict" || (family && family !== engineId))
		fail("SOFTWARE_ENGINE_IDENTITY_CONFLICT");
	if (
		!family &&
		!(
			identity?.engineId === engineId &&
			identity.verified === true &&
			Array.isArray(identity.evidenceRefs) &&
			identity.evidenceRefs.length &&
			identity.evidenceRefs.every((ref) => typeof ref === "string" && ref.length)
		)
	)
		fail("SOFTWARE_ENGINE_IDENTITY_UNVERIFIED");
}
function resolveCommandMode(engineId, platform, config) {
	const evidence = config.commandModeEvidence,
		explicitProof =
			evidence?.verified === true &&
			Array.isArray(evidence.evidenceRefs) &&
			evidence.evidenceRefs.length > 0;
	const selected =
		config.commandMode ||
		(engineId === "orca"
			? "orca-argv-v1"
			: config.inputMode === "argument"
				? "gaussian-argument-v1"
				: "gaussian-stdin-v1");
	if (engineId === "orca") {
		if (selected !== "orca-argv-v1" || (config.inputMode && config.inputMode !== "argument"))
			fail("COMMAND_MODE_CONFLICT");
		if (
			config.argumentTemplate &&
			JSON.stringify(config.argumentTemplate) !== JSON.stringify(["{input}"])
		)
			fail("ORCA_COMMAND_TEMPLATE_UNSUPPORTED");
		return {
			id: selected,
			inputMode: "argument",
			supported: true,
			evidenceRefs: [
				"https://www.faccts.de/docs/orca/6.1/manual/contents/quickstartguide/running.html"
			]
		};
	}
	if (selected === "gaussian-windows-cli-v1") {
		if (platform !== "win32" || !explicitProof || path.win32.basename(config.executable || "").toLowerCase() !== "g16.exe" || JSON.stringify(config.argumentTemplate) !== JSON.stringify(["{input}", "{output}"])) fail("GAUSSIAN_WINDOWS_CLI_CONTRACT_UNVERIFIED");
		return { id: selected, inputMode: "argument", supported: true, evidenceRefs: evidence.evidenceRefs };
	}
	if (selected === "gaussian-windows-options-v1") {
		if (platform !== "win32" || !explicitProof) fail("GAUSSIAN_WINDOWS_COMMAND_MODE_UNVERIFIED");
		if (
			path.win32.basename(config.executable || "").toLowerCase() !== "g16w.exe" ||
			JSON.stringify(config.argumentTemplate) !==
				JSON.stringify(["-run", "-inp={input}", "-out={output}"])
		)
			fail("GAUSSIAN_WINDOWS_OPTION_CONTRACT_CONFLICT");
		return {
			id: selected,
			inputMode: "argument",
			supported: true,
			argumentSerialization: "gaussian-windows-options-v1",
			evidenceRefs: evidence.evidenceRefs
		};
	}
	if (selected === "gaussian-stdin-v1") {
		if (config.inputMode && config.inputMode !== "stdin") fail("COMMAND_MODE_CONFLICT");
		if (platform === "win32") fail("GAUSSIAN_WINDOWS_COMMAND_MODE_UNVERIFIED");
		return {
			id: selected,
			inputMode: "stdin",
			supported: true,
			evidenceRefs: explicitProof ? evidence.evidenceRefs : ["gaussian-linux-stdin-adapter-v1"]
		};
	}
	if (selected === "gaussian-argument-v1") {
		if (platform === "win32") fail("GAUSSIAN_WINDOWS_SPECIAL_SERIALIZER_REQUIRED");
		if (config.inputMode && config.inputMode !== "argument") fail("COMMAND_MODE_CONFLICT");
		if (
			!explicitProof ||
			!Array.isArray(config.argumentTemplate) ||
			!config.argumentTemplate.some(
				(value) => typeof value === "string" && value.includes("{input}")
			)
		)
			fail("GAUSSIAN_COMMAND_MODE_UNVERIFIED");
		return {
			id: selected,
			inputMode: "argument",
			supported: true,
			evidenceRefs: evidence.evidenceRefs
		};
	}
	fail("COMMAND_MODE_UNSUPPORTED");
}
function planScratch(engineId, environmentSnapshot, inputSnapshot, workLocation, platform) {
	const configured = environmentSnapshot.configuration?.scratchRoot || "",
		api = platform === "win32" ? path.win32 : path.posix;
	if (engineId === "orca") {
		if (configured && api.normalize(configured) !== api.normalize(workLocation.path))
			fail("ORCA_EXTERNAL_SCRATCH_UNSUPPORTED", {
				workingDirectory: workLocation.path,
				reason:
					"ORCA temporary files use the actual task working/input directory; no generic external scratch variable is assumed"
			});
		return null;
	}
	if (platform === "win32" && environmentSnapshot.softwareAdapter?.commandMode !== "gaussian-windows-cli-v1") {
		if (configured)
			fail("GAUSSIAN_WINDOWS_SCRATCH_OVERRIDE_UNSUPPORTED", {
				reason:
					"G16W uses its evidenced installation INI mapping; GAUSS_SCRDIR is not claimed effective"
			});
		return null;
	}
	const taskLocal = inputSnapshot.engineExtensions?.fileLayout === "task-relative-v1";
	if (taskLocal && configured && api.resolve(configured) !== api.resolve(workLocation.path)) fail("TASK_LOCAL_SCRATCH_REQUIRED");
	const requestedRoot = taskLocal ? workLocation.path : configured || workLocation.path;
	if (!api.isAbsolute(requestedRoot)) fail("ABSOLUTE_SCRATCH_ROOT_REQUIRED");
	const root = api.resolve(requestedRoot);
	const name =
		"es-" +
		sha256(
			Buffer.from(JSON.stringify({ workLocation, inputSnapshotId: inputSnapshot.inputSnapshotId }))
		).slice(0, 32);
	return {
		environmentId: workLocation.environmentId,
		root,
		path: api.join(root, taskLocal ? "scratch" : name),
		kind: "gaussian-scratch",
		inputSnapshotId: inputSnapshot.inputSnapshotId,
		inputContentIdentity: inputSnapshot.contentIdentity || null
	};
}
function createSoftwareAdapter(engineId) {
	if (!["gaussian", "orca"].includes(engineId)) fail("UNSUPPORTED_ENGINE");
	return {
		engineId,
		adapterVersion: ADAPTER_VERSION,
		inspectInput: (input) =>
			validateDependencies(inspectInput(engineId, input.bytes), input.dependencies),
		async probe({ transport, environment }, io) {
			const config = environment.softwareAdapter;
			const executable = requireText(config.executable, "SOFTWARE_EXECUTABLE");
			const entryIdentity = await transport.stat(executable, io);
			let rawVersion = null,
				recognizedVersion = null,
				probeExitCode = null,
				metadataIdentity = null;
			// A configured version command is explicit; path existence never certifies a scientific chain.
			if (config.versionMetadata) {
				const metadata = config.versionMetadata;
				if (
					typeof metadata.rawVersion !== "string" ||
					!metadata.rawVersion ||
					!Array.isArray(metadata.evidenceRefs) ||
					!metadata.evidenceRefs.length ||
					!["path", "fileId", "byteSize", "modifiedAt", "changeToken"].every(
						(key) =>
							metadata.entryIdentity?.[key] !== undefined &&
							metadata.entryIdentity[key] === entryIdentity[key]
					)
				)
					fail("SOFTWARE_VERSION_METADATA_UNBOUND");
				rawVersion = metadata.rawVersion;
				metadataIdentity = metadata.engineIdentity || null;
				for (const member of metadata.distributionMembers || [])
					if (!unchanged(member, await transport.stat(member.path, io)))
						fail("SOFTWARE_DISTRIBUTION_METADATA_UNBOUND");
			} else if (config.versionCommand) {
				const result = await transport.exec(
					{ ...config.versionCommand, cwd: environment.workingRoot, env: config.environment || {} },
					io
				);
				probeExitCode = result.exitCode;
				if (result.stdout?.length || result.stderr?.length) {
					rawVersion = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)])
						.toString("utf8")
						.trim();
					recognizedVersion =
						engineId === "orca"
							? rawVersion.match(
									/(?:Program\s+Version|ORCA\s+Version)\s*[:=]?\s*(\d+\.\d+(?:\.\d+)?)/i
								)?.[1] || null
							: rawVersion.match(/Gaussian\s+(?:09|16)[\s\S]*?Revision\s+([A-Z]\.\d+)/i)?.[1] ||
								null;
				}
			}
			if (rawVersion)
				recognizedVersion =
					engineId === "orca"
						? rawVersion.match(
								/(?:Program\s+Version|ORCA\s+(?:Version\s*)?)\s*[:=]?\s*(\d+\.\d+(?:\.\d+)?)/i
							)?.[1] || null
						: rawVersion.match(
								/Gaussian\s*(?:\([^)]*\)\s*)?\d{2,4}W?[\s\S]*?Revision\s+([A-Z]\.\d+)/i
							)?.[1] ||
							rawVersion.match(/\b[A-Za-z0-9_-]*G\d{2}Rev([A-Z]\.\d+)\b/i)?.[1] ||
							null;
			const family = engineFamily(rawVersion),
				engineIdentity =
					family && family !== "conflict"
						? {
								engineId: family,
								verified: true,
								source: config.versionMetadata
									? "bound-executable-metadata"
									: "actual-version-output",
								evidenceRefs: config.versionMetadata?.evidenceRefs || [
									`${entryIdentity.path}#version-command`
								]
							}
						: metadataIdentity;
			const nativeEvidence = config.nativeVerification,
				launchVerified =
					family === engineId &&
					nativeEvidence?.verified === true &&
					nativeEvidence.entryFileId === entryIdentity.fileId &&
					Array.isArray(nativeEvidence.evidenceRefs) &&
					nativeEvidence.evidenceRefs.length > 0;
			const identifiedFamily =
				family ||
				(engineIdentity?.verified === true &&
				Array.isArray(engineIdentity.evidenceRefs) &&
				engineIdentity.evidenceRefs.length > 0 &&
				engineIdentity.evidenceRefs.every((ref) => typeof ref === "string" && ref.length)
					? engineIdentity.engineId
					: null);
			return {
				engineId,
				rawVersion,
				recognizedVersion,
				platform: environment.connection.kind === "local" ? process.platform : "linux",
				entryIdentity,
				engineIdentity,
				distributionIdentity: { members: config.versionMetadata?.distributionMembers || [] },
				probeExitCode: config.probeEvidence?.exitCode ?? probeExitCode,
				...(config.probeEvidence ? { probeEvidence: config.probeEvidence } : {}),
				adapterVersion: ADAPTER_VERSION,
				capabilities: {
					supported: ["input-resource-inspection"],
					launchVerified,
					nativeVerified: launchVerified,
					unverified: launchVerified
						? []
						: ["native-launch", "native-stop", "wavefunction-conversion"]
				},
				fieldStatus: {
					...(identifiedFamily === null
						? {
								engineIdentity: {
									state: "unknown",
									reason: "Software family not identified from actual output"
								}
							}
						: identifiedFamily !== engineId
							? {
									engineIdentity: {
										state: "conflict",
										reason: "Actual software family does not match selected engine"
									}
								}
							: {}),
					...(rawVersion === null
						? { rawVersion: { state: "unknown", reason: "No verified version command result" } }
						: {}),
					...(recognizedVersion === null
						? {
								recognizedVersion: {
									state: "unknown",
									reason: "Version not recognized from actual tool output"
								}
							}
						: {})
				}
			};
		},
		planLaunch({ inputSnapshot, environmentSnapshot, softwareSnapshot, workLocation }) {
			if (
				softwareSnapshot.engineId !== engineId ||
				!softwareSnapshot.entryIdentity ||
				!softwareSnapshot.rawVersion ||
				environmentSnapshot.environmentId !== workLocation.environmentId
			)
				fail("SOFTWARE_IDENTITY_UNVERIFIED");
			assertEngineFamily(engineId, softwareSnapshot);
			const config = environmentSnapshot.softwareAdapter,
				platform = softwareSnapshot.platform;
			if (engineId === "gaussian" && platform === "win32" && inputSnapshot.engineExtensions?.fileLayout === "task-relative-v1" && config.commandMode !== "gaussian-windows-cli-v1")
				fail("GAUSSIAN_WINDOWS_TASK_PATH_UNVERIFIED", { reason: "G16W任务级CHK及scratch路径尚未验证，不能使用公共Scratch运行本次独立任务。" });
			const pathAPI = platform === "win32" ? path.win32 : path.posix;
			if (
				pathAPI.normalize(softwareSnapshot.entryIdentity.path || "") !==
				pathAPI.normalize(config.executable || "")
			)
				fail("SOFTWARE_ENTRY_IDENTITY_CONFLICT");
			if (!(platform === "win32" ? path.win32 : path.posix).isAbsolute(config.executable || ""))
				fail("ABSOLUTE_SOFTWARE_EXECUTABLE_REQUIRED");
			const name = basename(
				inputSnapshot.preparedName || (engineId === "gaussian" ? "input.gjf" : "input.inp")
			);
			const inputPath = joinLocation(workLocation.path, name, platform),
				primaryOutputPath = joinLocation(
					workLocation.path,
					basename(config.primaryOutputName || "output.out"),
					platform
				),
				stdoutPath = joinLocation(
					workLocation.path,
					basename(config.nativeStdoutName || config.primaryOutputName || "output.out"),
					platform
				),
				stderrPath = joinLocation(workLocation.path, "native-stderr.txt", platform);
			const commandMode = resolveCommandMode(engineId, platform, config);
			// Windows initialization is part of the frozen, managed PowerShell
			// calculation script. Native lifecycle and Job ownership remain outside it.
			const scratch = planScratch(
				engineId,
				environmentSnapshot,
				inputSnapshot,
				workLocation,
				platform
			);
			let args, stdinPath;
			if (engineId === "orca") args = [inputPath];
			else if (commandMode.inputMode === "stdin") {
				args = [];
				stdinPath = inputPath;
			} else if (commandMode.inputMode === "argument" && Array.isArray(config.argumentTemplate))
				args = config.argumentTemplate.map((value) => {
					requireText(value, "ARGUMENT");
					return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_token, key) => {
						if (key === "input") return inputPath;
						if (key === "output") return primaryOutputPath;
						fail("GAUSSIAN_COMMAND_TEMPLATE_VARIABLE_UNSUPPORTED", { variable: key });
					});
				});
			else fail("GAUSSIAN_COMMAND_MODE_UNVERIFIED");
			const gaussianWindowsFiles = commandMode.id === "gaussian-windows-cli-v1" ? require("./gaussian-windows-files.cjs").planGaussianWindowsFiles({inputSnapshot,workLocation,scratch}) : null;
			if (gaussianWindowsFiles) args.push("/scrdir=" + scratch.path + path.win32.sep);
			let lifecycle = null,
				externalOutputs = [];
			if (commandMode.id === "gaussian-windows-options-v1") {
				const references =
					inputSnapshot.parsedRequests?.jobs?.flatMap((job) => job.dependencyReferences || []) ||
					[];
				if (
					references.some(
						(reference) =>
							String(reference.directive).toLowerCase() === "oldchk" ||
							reference.kind === "checkpoint-read"
					)
				)
					fail("GAUSSIAN_WINDOWS_RESTART_MAPPING_UNSUPPORTED");
				const declared = references.filter(
					(reference) => String(reference.directive).toLowerCase() === "chk"
				);
				let source = null;
				if (declared.length) {
					source = locateWavefunction({
						engineId,
						inputSnapshot,
						environmentSnapshot,
						workLocation,
						platform
					});
					if (source.restricted) fail(source.code, { reason: source.reason });
				}
				const settings = config.installationSettings,
					installationIni =
						source?.installationIni ||
						(settings?.iniIdentity && settings.iniSha256
							? {
									path: settings.iniPath,
									identity: settings.iniIdentity,
									sha256: settings.iniSha256
								}
							: null);
				lifecycle = {
					kind: "gaussian-windows-completion-modal-v1",
					primaryOutputPath,
					checkpointPaths: source ? [source.path] : [],
					checkpointStatus: source ? "declared" : "not-declared",
					installationIni,
					evidenceRefs: commandMode.evidenceRefs
				};
				if (source)
					externalOutputs = [
						{
							path: source.path,
							environmentId: workLocation.environmentId,
							expectedAbsent: true,
							role: "wavefunction",
							sourceRoot: source.root,
							installationIni: source.installationIni
						}
					];
			}
			const launch = {
				...(gaussianWindowsFiles ? { gaussianWindowsFiles } : {}),
				inputSnapshotId: inputSnapshot.inputSnapshotId,
				workLocation,
				engineId,
				commandMode,
				scratch,
				externalOutputs,
				primaryOutputPath,
				command: {
					...(lifecycle ? { lifecycle } : {}),
					...(commandMode.argumentSerialization
						? { argumentSerialization: commandMode.argumentSerialization }
						: {}),
					executable: requireText(config.executable, "SOFTWARE_EXECUTABLE"),
					args,
					cwd: workLocation.path,
					env: {
						...(config.environment || {}),
						...(scratch ? { GAUSS_SCRDIR: scratch.path } : {}),
						...(engineId === "orca" ? { OMP_NUM_THREADS: "1" } : {})
					},
					stdoutPath,
					stderrPath,
					...(stdinPath ? { stdinPath } : {})
				},
				initialization: environmentSnapshot.configuration.initialization || "",
				engineExtensions: inputSnapshot.engineExtensions || {}
			};
			const planned = require("./calculation-script.cjs").resolveCalculationScript({
				launch,
				softwareSnapshot,
				override:
					inputSnapshot.calculationScript || inputSnapshot.engineExtensions?.calculationScript
			});
			const frozenIdentity =
				inputSnapshot.calculationScriptIdentity ||
				inputSnapshot.engineExtensions?.calculationScriptIdentity;
			if (
				frozenIdentity &&
				(planned.identity.hash !== frozenIdentity.hash ||
					planned.identity.byteSize !== frozenIdentity.byteSize)
			)
				fail("CALCULATION_SCRIPT_IDENTITY_CHANGED");
			return planned.launch;
		},
		planWavefunctionPreparation({ run, stableSource, toolSnapshot }) {
			const restricted = (code, reason) => ({ restricted: true, code, reason });
			if (run.state.executionState !== "ended")
				return restricted("SOURCE_RUNNING", "Native execution has not ended");
			if (
				stableSource.runId !== run.runId ||
				!stableSource.contentHash?.hash ||
				stableSource.integrity !== "complete" ||
				!stableSource.stableCopyLocation
			)
				return restricted("SOURCE_UNVERIFIED", "A verified stable source copy is required");
			if (
				!toolSnapshot?.entryIdentity ||
				!toolSnapshot.rawVersion ||
				toolSnapshot.engineId !== engineId ||
				toolSnapshot.compatibleWithRun !== true
			)
				return restricted("TOOL_UNVERIFIED", "Matching conversion tool is not verified");
			if (
				run.environmentSnapshot.scheduler.kind === "slurm" &&
				toolSnapshot.allocationActive !== true
			)
				return restricted("ALLOCATION_UNAVAILABLE", "No active original allocation for conversion");
			const location = stableSource.stableCopyLocation,
				platform = toolSnapshot.platform,
				output = joinLocation(
					location.directory,
					engineId === "gaussian" ? "wavefunction.fchk" : "wavefunction.molden.input",
					platform
				);
			const command = {
				executable: toolSnapshot.executable || toolSnapshot.entryIdentity.path,
				args: engineId === "gaussian" ? [location.path, output] : [location.basePath, "-molden"],
				cwd: location.directory,
				env: toolSnapshot.environment || {}
			};
			return {
				command,
				sourceArtifactId: stableSource.artifactId,
				sourceHash: stableSource.contentHash.hash,
				outputPath: output,
				reuseKey: `${engineId}:${ADAPTER_VERSION}:${stableSource.contentHash.hash}:${toolSnapshot.rawVersion}:${toolSnapshot.entryIdentity.contentHash || toolSnapshot.entryIdentity.fileId}`
			};
		}
	};
}
module.exports = {
	createSoftwareAdapter,
	ADAPTER_VERSION,
	engineFamily,
	resolveCommandMode,
	planScratch
};
