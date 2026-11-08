"use strict";
/** Independent external-process identities; never registered with application cleanup. */
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { spawn, execFile } = require("node:child_process");
const POWERSHELL = path.join(
	process.env.SystemRoot || "C:\\Windows",
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"powershell.exe"
);
const HELPER = path.join(__dirname, "windows-process-identity.ps1");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function error(code) {
	return Object.assign(new Error(code), { code });
}
function text(value) {
	if (typeof value !== "string" || value.includes("\0")) throw error("INVALID_PROCESS_ARGUMENT");
	return value;
}
const GAUSSIAN_WINDOWS_SERIALIZATION = "gaussian-windows-options-v1";
function checkedWindowsPath(value, directory = false) {
	if (
		typeof value !== "string" ||
		!value ||
		/["<>|?*\p{Cc}]/u.test(value) ||
		/^\\\\[?.]\\/.test(value) ||
		!(/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+\\[^\\/]+\\/.test(value))
	)
		throw error("GAUSSIAN_WINDOWS_ABSOLUTE_PATH_REQUIRED");
	let normalized = path.win32.normalize(value);
	if (directory && normalized.length > path.win32.parse(normalized).root.length)
		normalized = normalized.replace(/[\\/]+$/, "");
	const rest = normalized.slice(path.win32.parse(normalized).root.length);
	if (
		((!directory || rest) &&
			rest
				.split(/[\\/]/)
				.some(
					(part) =>
						!part ||
						/[.: ]$/.test(part) ||
						part.includes(":") ||
						/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
				)) ||
		value.split(/[\\/]/).some((part) => part === "." || part === "..")
	)
		throw error("GAUSSIAN_WINDOWS_FILE_PATH_INVALID");
	return normalized;
}
/** Closed, data-only mode. It never accepts a user-supplied raw command line. */
function validateArgumentSerialization(command) {
	if (command.argumentSerialization === undefined || command.argumentSerialization === null)
		return null;
	if (command.argumentSerialization !== GAUSSIAN_WINDOWS_SERIALIZATION)
		throw error("UNSUPPORTED_ARGUMENT_SERIALIZATION");
	const executable = checkedWindowsPath(command.executable),
		cwd = checkedWindowsPath(command.cwd, true);
	if (path.win32.basename(executable).toLowerCase() !== "g16w.exe")
		throw error("GAUSSIAN_WINDOWS_EXECUTABLE_REQUIRED");
	if (
		!Array.isArray(command.args) ||
		command.args.length !== 3 ||
		command.args[0] !== "-run" ||
		typeof command.args[1] !== "string" ||
		!command.args[1].startsWith("-inp=") ||
		typeof command.args[2] !== "string" ||
		!command.args[2].startsWith("-out=")
	)
		throw error("GAUSSIAN_WINDOWS_THREE_FLAGS_REQUIRED");
	const inputPath = checkedWindowsPath(command.args[1].slice(5)),
		outputPath = checkedWindowsPath(command.args[2].slice(5));
	if (inputPath.toLowerCase() === outputPath.toLowerCase())
		throw error("GAUSSIAN_WINDOWS_DISTINCT_FILES_REQUIRED");
	for (const file of [inputPath, outputPath]) {
		const relative = path.win32.relative(cwd, file);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith("..\\") ||
			path.win32.isAbsolute(relative)
		)
			throw error("GAUSSIAN_WINDOWS_OWNED_PATH_REQUIRED");
	}
	return { argumentSerialization: GAUSSIAN_WINDOWS_SERIALIZATION, inputPath, outputPath };
}
async function checkedGaussianFiles(command, serialization) {
	if (!serialization) return;
	for (const file of [
		command.cwd,
		serialization.inputPath,
		path.win32.dirname(serialization.outputPath)
	]) {
		let current = file;
		for (;;) {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw error("GAUSSIAN_WINDOWS_LINK_REFUSED");
			const parent = path.win32.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	if (!(await fs.stat(serialization.inputPath)).isFile())
		throw error("GAUSSIAN_WINDOWS_INPUT_NOT_REGULAR");
	try {
		await fs.lstat(serialization.outputPath);
		throw error("GAUSSIAN_WINDOWS_OUTPUT_ALREADY_EXISTS");
	} catch (failure) {
		if (failure.code !== "ENOENT") throw failure;
	}
}
function identityMatches(expected, actual) {
	return (
		[
			"pid",
			"startedAt",
			"hostId",
			"userId",
			"executableIdentity",
			"commandLine",
			"bootId",
			"creationFileTime"
		].every(
			(key) =>
				expected[key] !== undefined &&
				(key === "executableIdentity"
					? String(expected[key]).startsWith("/") || String(actual[key]).startsWith("/")
						? path.posix.normalize(String(expected[key])) ===
							path.posix.normalize(String(actual[key]))
						: String(expected[key]).toLowerCase() === String(actual[key]).toLowerCase()
					: expected[key] === actual[key])
		) &&
		(expected.argv === undefined || isDeepStrictEqual(expected.argv, actual.argv))
	);
}
function parsePsLine(raw, expectedPid) {
	const lines = String(raw || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) return null;
	const match = lines[0].match(
		/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/
	);
	if (!match) return null;
	const pid = Number(match[1]),
		userId = match[2],
		lstart = match[3],
		value = match[4].trim();
	if (pid !== expectedPid || !value) return null;
	const startedMs = Date.parse(`${lstart} UTC`);
	if (!Number.isFinite(startedMs)) return null;
	return {
		pid,
		userId,
		lstart,
		startedAt: new Date(startedMs).toISOString(),
		creationFileTime: String(startedMs),
		value
	};
}
function createProcessIdentityProvider(options = {}) {
	const platform = options.platform || process.platform;
	const helper = options.helperPath || HELPER;
	const spawnProcess = options.spawn || spawn;
	const execFileProcess = options.execFile || execFile;
	const readFileText = options.readFile || ((file) => fs.readFile(file, "utf8"));
	function runPosixCommand(file, args) {
		return new Promise((resolve) => {
			execFileProcess(
				file,
				args,
				{
					timeout: options.controlTimeoutMs || 10000,
					maxBuffer: 2 * 1024 * 1024,
					windowsHide: true,
					env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
				},
				(err, stdout = "", stderr = "") => {
					resolve({
						ok: !err,
						code: err ? err.code : 0,
						killed: Boolean(err?.killed),
						signal: err?.signal || null,
						stdout: String(stdout),
						stderr: String(stderr)
					});
				}
			);
		});
	}
	async function posixHost() {
		if (platform === "darwin") {
			const bootUuid = await runPosixCommand("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
			const bootId = bootUuid.ok ? bootUuid.stdout.trim() : "";
			let hostId = "";
			const ioreg = await runPosixCommand("/usr/sbin/ioreg", [
				"-rd1",
				"-c",
				"IOPlatformExpertDevice"
			]);
			if (ioreg.ok) {
				const match = ioreg.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
				if (match) hostId = match[1].trim();
			}
			if (!hostId || !bootId || /[\r\n]/.test(hostId) || /[\r\n]/.test(bootId))
				return { status: "unknown", reason: "HOST_IDENTITY_UNAVAILABLE" };
			return { hostId, bootId };
		}
		if (platform === "linux") {
			try {
				const bootId = String(await readFileText("/proc/sys/kernel/random/boot_id")).trim();
				const hostId = String(await readFileText("/etc/machine-id")).trim();
				if (!hostId || !bootId || /[\r\n]/.test(hostId) || /[\r\n]/.test(bootId))
					return { status: "unknown", reason: "HOST_IDENTITY_UNAVAILABLE" };
				return { hostId, bootId };
			} catch {
				return { status: "unknown", reason: "HOST_IDENTITY_UNAVAILABLE" };
			}
		}
		return { status: "unknown", reason: "PLATFORM_NOT_IMPLEMENTED" };
	}
	async function posixInspect(pid) {
		const host = await posixHost();
		if (!host.hostId || !host.bootId)
			return { status: "unknown", reason: host.reason || "HOST_IDENTITY_UNAVAILABLE" };
		const commRes = await runPosixCommand("/bin/ps", [
			"-ww",
			"-p",
			String(pid),
			"-o",
			"pid=,uid=,lstart=,comm="
		]);
		if (!commRes.ok) {
			return commRes.code === 1 &&
				!commRes.killed &&
				!commRes.signal &&
				!commRes.stdout.trim() &&
				!commRes.stderr.trim()
				? { status: "dead" }
				: { status: "unknown", reason: "IDENTITY_HELPER_UNAVAILABLE" };
		}
		const commParsed = parsePsLine(commRes.stdout, pid);
		if (!commParsed) return { status: "unknown", reason: "IDENTITY_HELPER_INVALID_REPLY" };
		const argsRes = await runPosixCommand("/bin/ps", [
			"-ww",
			"-p",
			String(pid),
			"-o",
			"pid=,uid=,lstart=,args="
		]);
		if (!argsRes.ok) {
			return argsRes.code === 1 &&
				!argsRes.killed &&
				!argsRes.signal &&
				!argsRes.stdout.trim() &&
				!argsRes.stderr.trim()
				? { status: "dead" }
				: { status: "unknown", reason: "IDENTITY_HELPER_UNAVAILABLE" };
		}
		const argsParsed = parsePsLine(argsRes.stdout, pid);
		if (!argsParsed) return { status: "unknown", reason: "IDENTITY_HELPER_INVALID_REPLY" };
		if (
			commParsed.pid !== argsParsed.pid ||
			commParsed.userId !== argsParsed.userId ||
			commParsed.lstart !== argsParsed.lstart
		)
			return { status: "unknown", reason: "PROCESS_IDENTITY_CHANGED" };
		return {
			status: "alive",
			pid: commParsed.pid,
			startedAt: commParsed.startedAt,
			creationFileTime: commParsed.creationFileTime,
			userId: commParsed.userId,
			executableIdentity: commParsed.value,
			commandLine: argsParsed.value,
			hostId: host.hostId,
			bootId: host.bootId
		};
	}
	async function control(request) {
		if (platform === "darwin" || platform === "linux") {
			if (request.action === "host") return posixHost();
			if (request.action === "inspect") return posixInspect(request.pid);
			return { status: "unknown", reason: "PLATFORM_NOT_IMPLEMENTED" };
		}
		if (platform !== "win32") return { status: "unknown", reason: "PLATFORM_NOT_IMPLEMENTED" };
		return new Promise((resolve) => {
			const child = spawnProcess(
				POWERSHELL,
				["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper],
				{ windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }
			);
			let stdout = "",
				settled = false;
			const timer = setTimeout(() => {
				child.kill();
				finish({ status: "unknown", reason: "IDENTITY_CONTROL_TIMEOUT" });
			}, options.controlTimeoutMs || 30000);
			const finish = (value) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(value);
				}
			};
			child.stdout.on("data", (value) => {
				stdout += value;
				if (stdout.length > 2 * 1024 * 1024) child.kill();
			});
			child.stderr.resume();
			child.stdin.on("error", () => {});
			child.once("error", () =>
				finish({ status: "unknown", reason: "IDENTITY_HELPER_UNAVAILABLE" })
			);
			child.once("close", () => {
				try {
					finish(JSON.parse(stdout.trim()));
				} catch {
					finish({ status: "unknown", reason: "IDENTITY_HELPER_INVALID_REPLY" });
				}
			});
			child.stdin.end(JSON.stringify(request));
		});
	}
	async function inspect(pid, context = {}) {
		if (!Number.isSafeInteger(pid) || pid <= 0) return null;
		const actual = await control({ action: "inspect", pid });
		if (actual.status !== "alive") return null;
		if (context.executable) {
			const matched =
				platform === "win32"
					? path.win32.normalize(actual.executableIdentity).toLowerCase() ===
						path.win32.normalize(context.executable).toLowerCase()
					: path.posix.normalize(actual.executableIdentity) ===
						path.posix.normalize(context.executable);
			if (!matched) return null;
		}
		if (
			context.args &&
			(!Array.isArray(actual.argv) ||
				JSON.stringify(context.args) !== JSON.stringify(actual.argv.slice(1)))
		)
			return null;
		// Windows has no supported runtime cwd field. Supplied cwd is never reported as observed.
		return {
			...actual,
			instanceId:
				context.instanceId ||
				options.instanceId ||
				`process:${actual.pid}:${actual.creationFileTime}`
		};
	}
	async function readLaunch(identity) {
		if (
			!identity?.native ||
			identity.native.kind !== "windows-job-v1" ||
			!identity.launchEvidenceSha256
		)
			return null;
		try {
			const bytes = await fs.readFile(identity.native.evidencePath);
			if (digest(bytes) !== identity.launchEvidenceSha256) return null;
			const receipt = JSON.parse(bytes);
			if (
				!identityMatches(identity, receipt.identity) ||
				identity.instanceId !== receipt.identity.instanceId ||
				!isDeepStrictEqual(identity.native, receipt.identity.native) ||
				receipt.identity.native.jobPolicy !== "no-breakaway-no-kill-on-close"
			)
				return null;
			return receipt;
		} catch {
			return null;
		}
	}
	async function jobQuery(identity, stop = false) {
		const receipt = await readLaunch(identity);
		if (!receipt) return { status: "conflict", reason: "LAUNCH_EVIDENCE_MISMATCH" };
		return control({
			action: "job",
			hostId: identity.hostId,
			bootId: identity.bootId,
			jobName: identity.native.jobName,
			stop,
			launchId: identity.native.launchId,
			treeEndPath: path.join(path.dirname(identity.native.evidencePath), "tree-end.json")
		});
	}
	async function inspectOwnedWindows(identity) {
		if (!(await readLaunch(identity)))
			return { status: "unknown", reason: "LAUNCH_EVIDENCE_MISMATCH", windows: [] };
		const result = await control({ action: "owned-windows", identity });
		return {
			...result,
			windows: Array.isArray(result.windows) ? result.windows : [],
			checkedAt: result.checkedAt || new Date().toISOString()
		};
	}
	async function inspectNativeWindows(identity, nativeExecutable) {
		if (!(await readLaunch(identity)) || !path.win32.isAbsolute(nativeExecutable || ""))
			return { status: "unknown", reason: "LAUNCH_EVIDENCE_MISMATCH", windows: [] };
		const result = await control({ action: "owned-native-windows", identity, nativeExecutable });
		return {
			...result,
			windows: Array.isArray(result.windows) ? result.windows : [],
			checkedAt: result.checkedAt || new Date().toISOString()
		};
	}
	async function rootEndEvidence(identity) {
		try {
			const root = JSON.parse(
				await fs.readFile(
					path.join(path.dirname(identity.native.evidencePath), "root-end.json"),
					"utf8"
				)
			);
			return root.launchId === identity.native.launchId &&
				root.jobName === identity.native.jobName &&
				String(root.creationFileTime) === identity.creationFileTime &&
				root.pid === identity.pid &&
				Number.isInteger(root.exitCode)
				? root
				: null;
		} catch {
			return null;
		}
	}
	async function probe(identity) {
		if (
			!identity ||
			!Number.isSafeInteger(identity.pid) ||
			!identity.startedAt ||
			!identity.hostId ||
			!identity.userId ||
			!identity.executableIdentity ||
			!identity.commandLine ||
			!identity.creationFileTime ||
			!identity.bootId
		)
			return { status: "unknown", reason: "IDENTITY_INCOMPLETE" };
		if (identity.native?.kind === "windows-job-v1") {
			const result = await jobQuery(identity);
			if (result.status === "absent") {
				// Last-handle closure removes the name even while associated processes
				// survive. Absence alone is never evidence that the process tree ended.
				try {
					const end = JSON.parse(
						await fs.readFile(
							path.join(path.dirname(identity.native.evidencePath), "tree-end.json"),
							"utf8"
						)
					);
					if (
						end.launchId === identity.native.launchId &&
						end.jobName === identity.native.jobName &&
						end.verified === true &&
						end.activeProcesses === 0
					) {
						const root = await rootEndEvidence(identity);
						return {
							status: "dead",
							treeEnded: true,
							exitCode: root?.exitCode ?? null,
							rootEnd: root,
							endedAt: end.endedAt,
							reason: "DURABLE_JOB_ZERO_MEMBERS",
							evidence: end,
							identity
						};
					}
				} catch {}
				return {
					status: "unknown",
					treeEnded: false,
					reason: "JOB_NAME_GONE_WITHOUT_ALL_MEMBERS_END_EVIDENCE",
					identity
				};
			}
			if (result.status === "dead") {
				const root = await rootEndEvidence(identity);
				return {
					...result,
					treeEnded: true,
					exitCode: root?.exitCode ?? null,
					rootEnd: root,
					endedAt: new Date().toISOString(),
					identity
				};
			}
			return { ...result, treeEnded: false, identity };
		}
		const actual = await control({ action: "inspect", pid: identity.pid });
		if (actual.status === "dead") {
			const host = await control({ action: "host" });
			if (!host?.hostId || !host?.bootId)
				return { status: "unknown", reason: host?.reason || "HOST_IDENTITY_UNAVAILABLE" };
			return host.hostId === identity.hostId && host.bootId === identity.bootId
				? { status: "dead", identity }
				: { status: "conflict", reason: "HOST_OR_BOOT_MISMATCH" };
		}
		if (actual.status !== "alive")
			return { status: "unknown", reason: actual.reason || "PROCESS_UNREADABLE" };
		return identityMatches(identity, actual)
			? { status: "alive", identity: { ...actual, instanceId: identity.instanceId } }
			: { status: "conflict", reason: "PROCESS_IDENTITY_MISMATCH", identity: actual };
	}
	async function stop(identity) {
		if (identity?.native?.kind !== "windows-job-v1")
			return { requested: false, status: "unknown", reason: "VERIFIED_JOB_REQUIRED" };
		const result = await jobQuery(identity, true);
		return { ...result, requested: result.stopRequested === true, stopped: false };
	}
	async function waitTreeEnded(identity, context = {}) {
		if (identity?.native?.kind !== "windows-job-v1")
			return { verified: false, exitCode: null, reason: "VERIFIED_JOB_REQUIRED" };
		const started = Date.now();
		for (;;) {
			if (context.signal?.aborted)
				return { verified: false, exitCode: null, reason: "WAIT_ABORTED" };
			const state = await probe(identity);
			if (state.status === "dead") {
				const root = state.rootEnd || (await rootEndEvidence(identity));
				return {
					verified: true,
					exitCode: root?.exitCode ?? null,
					endedAt: state.endedAt || new Date().toISOString(),
					rootEnd: root,
					evidence: state,
					reason: root ? "JOB_ALL_MEMBERS_ENDED" : "JOB_ALL_MEMBERS_ENDED_ROOT_EXIT_UNKNOWN"
				};
			}
			if (state.status !== "alive")
				return {
					verified: false,
					exitCode: null,
					reason: state.reason || "TREE_IDENTITY_UNVERIFIED",
					evidence: state
				};
			if (context.timeoutMs !== undefined && Date.now() - started >= context.timeoutMs)
				return { verified: false, exitCode: null, reason: "WAIT_TIMEOUT", evidence: state };
			await delay(context.pollMs || 300);
		}
	}
	async function launch(command, context = {}) {
		if (platform !== "win32") throw error("PLATFORM_NOT_IMPLEMENTED");
		const executable = text(command.executable),
			cwd = text(command.cwd);
		if (!path.isAbsolute(executable) || !path.isAbsolute(cwd) || !Array.isArray(command.args))
			throw error("ABSOLUTE_LAUNCH_PATH_REQUIRED");
		const args = command.args.map(text),
			env = {};
		const serialization = validateArgumentSerialization({ ...command, executable, cwd, args });
		await checkedGaussianFiles({ ...command, cwd }, serialization);
		for (const [key, value] of Object.entries(command.env || {})) {
			if (!key || key.includes("=")) throw error("INVALID_ENVIRONMENT_KEY");
			env[text(key)] = text(value);
		}
		const launchId = crypto.randomUUID(),
			jobName = `Local\\EsterStudio.ExternalRun.${launchId}`;
		const directory = path.join(cwd, `.es-process-owner-${launchId}`);
		await fs.mkdir(directory);
		const evidencePath = path.join(directory, "launch.json");
		const frozenCommand = {
			executable,
			args,
			cwd,
			env,
			stdinPath: command.stdinPath || null,
			stdoutPath: command.stdoutPath || null,
			stderrPath: command.stderrPath || null
		};
		if (serialization) frozenCommand.argumentSerialization = serialization.argumentSerialization;
		for (const key of ["stdinPath", "stdoutPath", "stderrPath"])
			if (frozenCommand[key] !== null) {
				text(frozenCommand[key]);
				if (!path.isAbsolute(frozenCommand[key])) throw error("ABSOLUTE_STDIO_PATH_REQUIRED");
			}
		if (command.stdin !== undefined) {
			frozenCommand.stdinPath = path.join(directory, "stdin.bin");
			await fs.writeFile(frozenCommand.stdinPath, Buffer.from(command.stdin), { flag: "wx" });
		}
		const request = {
			action: "launch",
			command: frozenCommand,
			launchId,
			jobName,
			instanceId: context.instanceId || options.instanceId || `run:${context.runId || launchId}`,
			evidencePath,
			rootEndPath: path.join(directory, "root-end.json"),
			treeEndPath: path.join(directory, "tree-end.json")
		};
		const requestPath = path.join(directory, "request.json");
		await fs.writeFile(requestPath, JSON.stringify(request), { flag: "wx" });
		const helperOutput = await fs.open(path.join(directory, "helper.log"), "wx");
		let spawnFailure = null;
		// Windows children have independent lifetime. PowerShell 5.1 can silently exit
		// without executing when libuv combines DETACHED_PROCESS and CREATE_NO_WINDOW.
		try {
			const child = spawnProcess(
				POWERSHELL,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					helper,
					"-RequestPath",
					requestPath
				],
				{ windowsHide: true, shell: false, stdio: ["ignore", helperOutput.fd, helperOutput.fd] }
			);
			child.once("error", (failure) => {
				spawnFailure = failure;
			});
			child.unref();
		} finally {
			await helperOutput.close();
		}
		const started = Date.now();
		for (;;) {
			try {
				const bytes = await fs.readFile(evidencePath),
					receipt = JSON.parse(bytes);
				if (
					receipt.launchEvidence?.launchId !== launchId ||
					receipt.identity?.native?.jobName !== jobName
				)
					throw error("LAUNCH_EVIDENCE_MISMATCH");
				receipt.identity.launchEvidenceSha256 = digest(bytes);
				return receipt;
			} catch (failure) {
				if (failure.code !== "ENOENT") throw failure;
			}
			try {
				const failure = JSON.parse(await fs.readFile(evidencePath + ".error.json", "utf8"));
				throw Object.assign(error(failure.code), { detail: failure.message });
			} catch (failure) {
				if (failure.code !== "ENOENT") throw failure;
			}
			if (spawnFailure) throw spawnFailure;
			if (Date.now() - started > (options.launchTimeoutMs || 30000))
				throw error("LAUNCH_RECEIPT_UNCERTAIN");
			await delay(100);
		}
	}
	return {
		inspect,
		probe,
		stop,
		waitTreeEnded,
		launch,
		inspectOwnedWindows,
		inspectNativeWindows,
		currentIdentity: (instanceId) => inspect(process.pid, { instanceId }),
		probeProcessIdentity: probe,
		stopVerifiedProcessTree: stop
	};
}
module.exports = {
	createProcessIdentityProvider,
	identityMatches,
	validateArgumentSerialization,
	GAUSSIAN_WINDOWS_SERIALIZATION,
	...createProcessIdentityProvider()
};
