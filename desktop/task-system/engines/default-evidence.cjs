"use strict";
const path = require("node:path"),
	crypto = require("node:crypto");
const { quote, sha256, fail, unchanged } = require("../execution/common.cjs");
const { engineFamily } = require("./adapters.cjs");
const { inspectSlurmCapabilities } = require("../execution/slurm.cjs");
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function gaussianPeFamilyIdentity(metadata, entryIdentity, header) {
	// These bound PE fields identify the front-end family, not the scientific
	// revision. Keep FileVersion and ProductVersion in their original raw slots.
	const field = (name) => (typeof metadata?.[name] === "string" ? metadata[name].trim() : "");
	if (
		Buffer.from(header).subarray(0, 2).toString("ascii") !== "MZ" ||
		!/^g16w\.exe$/i.test(path.win32.basename(entryIdentity.path)) ||
		!/^Gaussian$/i.test(field("ProductName").replace(/[®™]/g, "").normalize("NFKC").trim()) ||
		field("ProductVersion") !== "16" ||
		!/^G16W\.EXE$/i.test(field("OriginalFilename")) ||
		!/^G16w[ \t]+User[ \t]+Front-End$/i.test(field("FileDescription"))
	)
		return null;
	return {
		engineId: "gaussian",
		verified: true,
		source: "bound-pe-product-family",
		evidenceRefs: ["ProductName", "ProductVersion", "OriginalFilename", "FileDescription"].map(
			(name) => `${entryIdentity.path}#pe-version-resource/${name}`
		)
	};
}
function versionLines(bytes) {
	return Buffer.from(bytes)
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) =>
			/Gaussian\s*\(?|G\d{2}Rev[A-Z]\.\d+|Program\s+Version|\bORCA\b|\bO\s+R\s+C\s+A\b/i.test(line)
		)
		.slice(0, 12)
		.join("\n")
		.trim();
}
/** Embedded diagnostic/termination strings establish neither a run outcome nor a revision. */
function embeddedVersionLines(bytes) {
	const text = Buffer.from(bytes).toString("utf8");
	return [
		...new Set(
			[
				...text.matchAll(
					/\b(?:G\d{2}Rev[A-Z]\.\d+|Gaussian\s+(?:09|16)W?(?:\s*,?\s*Revision\s+[A-Z]\.\d+)?|ORCA\s+(?:[Vv]ersion\s*)?\d+(?:\.\d+)+|Program\s+Version\s+\d+(?:\.\d+)+)\b/g
				)
			].map((match) => match[0])
		)
	]
		.slice(0, 12)
		.join("\n");
}
async function peMetadata({ environment, transport, entryIdentity, executable, signal }) {
	const directory = path.win32.dirname(executable),
		companions = [];
	let iniIdentity = null;
	if (environment.engineId === "gaussian") {
		for (const name of ["l1.exe"]) {
			try {
				companions.push(await transport.stat(path.win32.join(directory, name), { signal }));
			} catch {}
		}
		try {
			iniIdentity = await transport.stat(path.win32.join(directory, "g16w.ini"), { signal });
		} catch {}
	}
	const markerPaths = [executable, ...companions.map((value) => value.path)];
	const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$v=(Get-Item -LiteralPath ${literal(executable)}).VersionInfo;$markers=@();foreach($f in @(${markerPaths.map(literal).join(",")})){$s=[IO.File]::OpenRead($f);try{$b=New-Object byte[] 1048576;$tail='';while(($n=$s.Read($b,0,$b.Length))-gt 0){$t=$tail+[Text.Encoding]::ASCII.GetString($b,0,$n);foreach($m in [regex]::Matches($t,'[A-Za-z0-9_-]*G[0-9]{2}Rev[A-Z]\\.[0-9]+|Gaussian[ ]+(?:09|16)W?|ORCA[ ,:]+(?:[Vv]ersion[ ]*)?[0-9]+(?:\\.[0-9]+){1,3}')){if($markers -notcontains $m.Value){$markers+=$m.Value}};$tail=$t.Substring([Math]::Max(0,$t.Length-256));if($markers.Count-ge 8){break}}}finally{$s.Dispose()}};$ini=$null;${iniIdentity ? `$section='';$fields=@{};$conflict=$false;foreach($line in [IO.File]::ReadAllLines(${literal(iniIdentity.path)},[Text.Encoding]::Default)){if($line -match '^\\s*\\[([^]]+)\\]'){$section=$Matches[1]}elseif($section -eq 'File' -and $line -match '^\\s*([^=;]+)=(.*)$'){$k=$Matches[1].Trim();if($fields.ContainsKey($k)){$conflict=$true};$fields[$k]=$Matches[2].Trim()}};$ini=@{binPath=$fields['Bin_Path'];scratchDirPath=$fields['ScratchDir_Path'];conflict=$conflict};` : ""}[pscustomobject]@{ProductName=$v.ProductName;ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion;FileDescription=$v.FileDescription;OriginalFilename=$v.OriginalFilename;markers=$markers;installationIni=$ini}|ConvertTo-Json -Depth 5 -Compress`;
	const executablePath = path.win32.join(
			process.env.SystemRoot || "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe"
		),
		result = await transport.exec(
			{
				executable: executablePath,
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
				cwd: environment.workingRoot,
				env: {}
			},
			{ signal }
		);
	if (result.exitCode !== 0) return null;
	let metadata;
	try {
		metadata = JSON.parse(
			Buffer.from(result.stdout)
				.toString("utf8")
				.replace(/^\uFEFF/, "")
		);
	} catch {
		return null;
	}
	const rawVersion = [
		...(metadata.markers || []),
		...Object.entries(metadata)
			.filter(([, value]) => typeof value === "string" && value.trim())
			.map(([key, value]) => `${key}: ${value}`)
	].join("\n");
	if (!rawVersion) return null;
	const after = await transport.stat(executable, { signal });
	if (!unchanged(entryIdentity, after)) fail("SOFTWARE_CHANGED_DURING_METADATA");
	for (const member of companions)
		if (!unchanged(member, await transport.stat(member.path, { signal })))
			fail("SOFTWARE_CHANGED_DURING_METADATA");
	let installationSettings = null;
	if (iniIdentity && metadata.installationIni) {
		if (!unchanged(iniIdentity, await transport.stat(iniIdentity.path, { signal })))
			fail("SOFTWARE_CHANGED_DURING_METADATA");
		const ini = metadata.installationIni;
		if (
			ini.conflict ||
			!ini.binPath ||
			path.win32.normalize(ini.binPath).toLowerCase() !==
				path.win32.normalize(directory).toLowerCase()
		)
			fail("GAUSSIAN_INSTALLATION_INI_CONFLICT");
		const hash = await transport.hash(
			{ path: iniIdentity.path, identity: iniIdentity, algorithm: "sha256" },
			{ signal }
		);
		installationSettings = {
			iniPath: iniIdentity.path,
			iniIdentity,
			iniSha256: hash.hash,
			binPath: ini.binPath,
			scratchDirPath: ini.scratchDirPath,
			evidenceRefs: [
				`${iniIdentity.path}#File/Bin_Path`,
				`${iniIdentity.path}#File/ScratchDir_Path`
			]
		};
	}
	return {
		rawVersion,
		entryIdentity: after,
		distributionMembers: companions,
		evidenceRefs: [
			`${executable}#pe-version-resource`,
			...companions.map((value) => `${value.path}#embedded-version-marker`)
		],
		metadata,
		installationSettings,
		source: "pe-version-resource-and-bound-distribution-markers"
	};
}
async function binaryMarkers({ environment, transport, entryIdentity, executable, signal }) {
	const candidates = [executable],
		markerSources = [],
		inspectedMembers = [];
	if (environment.engineId === "gaussian")
		candidates.push(path.posix.join(path.posix.dirname(executable), "l1.exe"));
	for (const candidate of candidates) {
		let identity;
		try {
			identity = await transport.stat(candidate, { signal });
		} catch {
			continue;
		}
		const pattern =
			environment.engineId === "gaussian"
				? "Gaussian[[:space:]]+[0-9]{2}|G[0-9]{2}Rev[A-Z]\\.[0-9]+"
				: "ORCA[[:space:]]+([Vv]ersion[[:space:]]*)?[0-9]|Program[[:space:]]+Version[[:space:]]+[0-9]";
		const result = await transport.exec(
			{
				executable: "bash",
				args: [
					"-c",
					`command -v strings >/dev/null && LC_ALL=C strings -a -- ${quote(candidate)} | LC_ALL=C grep -m 4 -E ${quote(pattern)}`
				],
				cwd: environment.workingRoot,
				env: {}
			},
			{ signal }
		);
		const rawVersion = embeddedVersionLines(result.stdout),
			after = await transport.stat(candidate, { signal });
		if (!unchanged(identity, after)) fail("SOFTWARE_CHANGED_DURING_METADATA");
		inspectedMembers.push(after);
		if (rawVersion && engineFamily(rawVersion) === environment.engineId) {
			markerSources.push({ rawVersion, identity: after });
			// A termination-message string identifies the family, not a revision.
			// Preserve it and inspect the same-installation link binary before
			// settling for unknown revision. Neither case needs a native startup.
			if (
				environment.engineId !== "gaussian" ||
				/\b[A-Za-z0-9_-]*G\d{2}Rev[A-Z]\.\d+\b|\bGaussian\s+(?:09|16)W?\b[\s\S]*?\bRevision\s+[A-Z]\.\d+/i.test(
					rawVersion
				)
			)
				break;
		}
	}
	if (!markerSources.length) return null;
	// The first source must stay bound while a later companion is inspected.
	// Checking only the most recently read member could publish stale markers.
	for (const member of inspectedMembers)
		if (!unchanged(member, await transport.stat(member.path, { signal })))
			fail("SOFTWARE_CHANGED_DURING_METADATA");
	const nativeAfter = await transport.stat(executable, { signal });
	if (!unchanged(entryIdentity, nativeAfter)) fail("SOFTWARE_CHANGED_DURING_METADATA");
	return {
		rawVersion: markerSources.map((source) => source.rawVersion).join("\n"),
		entryIdentity: nativeAfter,
		evidenceRefs: markerSources.map((source) => `${source.identity.path}#embedded-version-markers`),
		distributionMembers: inspectedMembers.filter((member) => member.path !== executable),
		source: "embedded-version-markers"
	};
}
async function startupBanner({ environment, transport, entryIdentity, signal, onProbeEvidence }) {
	// There is no invented -v/--version flag. An empty owned cwd and closed stdin provide no scientific input.
	const directory = path.posix.join(
		environment.workingRoot,
		"es-capability-probe-" + crypto.randomUUID()
	);
	await transport.mkdirExclusive(directory, { signal });
	const script = `command -v timeout >/dev/null || exit 127; exec timeout --signal=TERM --kill-after=2s 8s bash -c ${quote(`${environment.initialization || ""}\nexec ${quote(environment.executable)}`)}`;
	const controllerSignal = AbortSignal.timeout(15000),
		io = { signal: signal ? AbortSignal.any([signal, controllerSignal]) : controllerSignal };
	const started = Date.now(),
		startedMonotonic = performance.now(),
		startedAt = new Date(started).toISOString(),
		command = {
			executable: "bash",
			args: ["-c", script],
			cwd: directory,
			env: {},
			stdinClosed: true
		};
	let result = null,
		failure = null;
	try {
		result = await transport.exec({ ...command, stdin: Buffer.alloc(0) }, io);
	} catch (error) {
		failure = error;
	}
	const ended = Date.now(),
		probeEvidence = {
			probeId: crypto.randomUUID(),
			environmentId: environment.environmentId,
			engineId: environment.engineId,
			engineExecutable: environment.executable,
			startedAt,
			endedAt: new Date(ended).toISOString(),
			elapsedMs: Math.max(0, Math.round(performance.now() - startedMonotonic)),
			elapsedScope: "startup-probe-control-wall",
			command,
			exitCode: result?.exitCode ?? null,
			signal: result?.signal ?? null,
			diagnosticDirectory: directory,
			evidenceRefs: [],
			invokedNative: true,
			launchVerification: result ? "control-returned" : "unknown",
			...(failure ? { error: { code: failure.code || "STARTUP_PROBE_UNVERIFIED" } } : {})
		};
	try {
		for (const [name, value] of [
			["startup-stdout.txt", result?.stdout],
			["startup-stderr.txt", result?.stderr]
		]) {
			if (value === undefined) continue;
			const bytes = Buffer.from(value),
				file = path.posix.join(directory, name);
			await transport.putAtomic(
				{
					path: file,
					expectedAbsent: true,
					source: bytes,
					byteSize: bytes.length,
					sha256: sha256(bytes)
				},
				{ signal }
			);
			probeEvidence.evidenceRefs.push(file);
		}
		const file = path.posix.join(directory, "probe-receipt.json");
		probeEvidence.receiptPath = file;
		const bytes = Buffer.from(JSON.stringify(probeEvidence));
		await transport.putAtomic(
			{
				path: file,
				expectedAbsent: true,
				source: bytes,
				byteSize: bytes.length,
				sha256: sha256(bytes)
			},
			{ signal }
		);
	} catch (error) {
		probeEvidence.diagnosticWriteError = { code: error.code || "PROBE_DIAGNOSTIC_WRITE_FAILED" };
	}
	try {
		await onProbeEvidence?.(probeEvidence);
	} catch (error) {
		failure ||= Object.assign(new Error("PROBE_OBSERVER_FAILED"), {
			code: "PROBE_OBSERVER_FAILED",
			observerCode: error.code || null
		});
	}
	if (failure) {
		failure.details = { ...(failure.details || {}), probeEvidence };
		throw failure;
	}
	const after = await transport.stat(environment.executable, { signal });
	if (!unchanged(entryIdentity, after)) fail("SOFTWARE_CHANGED_DURING_PROBE", { probeEvidence });
	const rawVersion = versionLines(
		Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)])
	);
	return {
		rawVersion: rawVersion || null,
		entryIdentity: after,
		evidenceRefs: probeEvidence.evidenceRefs,
		source: "closed-input-startup-banner",
		probeExitCode: result.exitCode,
		probeEvidence
	};
}
function createDefaultEvidenceReaders({ platform = process.platform, onProbeEvidence } = {}) {
	const cache = new Map(),
		environmentCache = new Map();
	async function readSoftwareEvidence(environment, { transport, signal } = {}) {
		if (!transport) return null;
		const target = environment.connectionKind === "local" ? platform : "linux",
			api = target === "win32" ? path.win32 : path.posix;
		let executable = environment.executable;
		const selected = await transport.stat(executable, { signal });
		if (selected.isDirectory)
			executable = api.join(
				executable,
				environment.engineId === "orca"
					? target === "win32"
						? "orca.exe"
						: "orca"
					: target === "win32"
						? "g16.exe"
						: "g16"
			);
		if (
			target === "win32" &&
			environment.engineId === "gaussian" &&
			/^g16(?:w)?\.exe$/i.test(path.win32.basename(executable))
		) {
			const candidate = path.win32.join(path.win32.dirname(executable), "g16.exe");
			try {
				const sibling = await transport.stat(candidate, { signal });
				if (sibling.isDirectory) fail("SOFTWARE_ENTRY_NOT_NATIVE_BINARY");
				executable = candidate;
			} catch (error) { if (!require("../transports/file-errors.cjs").isMissingFile(error, candidate)) throw error; }
		}
		const entryIdentity = await transport.stat(executable, { signal }),
			companions = [];
		const magic = await transport.readRange(
				{
					path: executable,
					identity: entryIdentity,
					offset: 0,
					length: Math.min(4, entryIdentity.byteSize)
				},
				{ signal }
			),
			header = Buffer.from(magic.bytes);
		if (
			!(target === "win32"
				? header.subarray(0, 2).toString("ascii") === "MZ"
				: header.equals(Buffer.from([0x7f, 69, 76, 70])))
		)
			fail("SOFTWARE_ENTRY_NOT_NATIVE_BINARY");
		if (environment.engineId === "gaussian") {
			const api = target === "win32" ? path.win32 : path.posix;
			for (const name of target === "win32" ? ["l1.exe", "g16w.ini", ...(/^g16\.exe$/i.test(path.win32.basename(executable)) ? ["g16w.exe"] : [])] : ["l1.exe"]) {
				try {
					const value = await transport.stat(api.join(api.dirname(executable), name), { signal });
					companions.push([
						value.path,
						value.fileId,
						value.byteSize,
						value.changeToken,
						value.modifiedAt
					]);
				} catch {}
			}
		}
		const key = JSON.stringify([
			environment.environmentId,
			environment.engineId,
			environment.connectionKind,
			environment.host,
			environment.port,
			environment.user,
			environment.distribution,
			environment.initialization,
			entryIdentity.fileId,
			entryIdentity.path,
			entryIdentity.byteSize,
			entryIdentity.changeToken,
			entryIdentity.modifiedAt,
			companions
		]);
		if (cache.has(key)) return cache.get(key);
		const pending = (async () => {
			let evidence;
			if (target === "win32") {
				evidence = await peMetadata({ environment, transport, entryIdentity, executable, signal });
				if (environment.engineId === "gaussian" && /^g16\.exe$/i.test(path.win32.basename(executable))) {
					const frontEnd = path.win32.join(path.win32.dirname(executable), "g16w.exe");
					try {
						const frontIdentity = await transport.stat(frontEnd, { signal });
						const frontHeader = await transport.readRange({ path: frontEnd, identity: frontIdentity, offset: 0, length: Math.min(4, frontIdentity.byteSize) }, { signal });
						const front = await peMetadata({ environment, transport, entryIdentity: frontIdentity, executable: frontEnd, signal });
						const family = front && gaussianPeFamilyIdentity(front.metadata, front.entryIdentity, frontHeader.bytes);
						if (family && front.installationSettings?.binPath && unchanged(entryIdentity, await transport.stat(executable, { signal }))) {
							const refs = [...family.evidenceRefs, `${executable}#same-installation-cli-sibling`, ...front.installationSettings.evidenceRefs];
							const members = [...(front.distributionMembers || []), front.entryIdentity];
							evidence = { ...front, ...(evidence || {}), entryIdentity, distributionMembers: members, engineIdentity: { engineId: "gaussian", verified: true, source: "bound-pe-front-end-family-and-cli-sibling", evidenceRefs: refs }, evidenceRefs: [...new Set([...(front.evidenceRefs || []), ...(evidence?.evidenceRefs || []), ...refs])] };
						}
					} catch (error) { if (!require("../transports/file-errors.cjs").isMissingFile(error, frontEnd)) throw error; }
				}
			} else {
				evidence = await binaryMarkers({
					environment,
					transport,
					entryIdentity,
					executable,
					signal
				});
				if (!evidence)
					evidence = await startupBanner({
						environment: { ...environment, executable },
						transport,
						entryIdentity,
						signal,
						onProbeEvidence
					});
			}
			if (!evidence) return null;
			const family = engineFamily(evidence.rawVersion);
			const metadataIdentity =
				evidence.engineIdentity ||
				(target === "win32" && unchanged(entryIdentity, evidence.entryIdentity)
					? gaussianPeFamilyIdentity(evidence.metadata, evidence.entryIdentity, header)
					: null);
			return {
				...evidence,
				executable,
				...(target === "win32" && environment.engineId === "gaussian" && /^g16\.exe$/i.test(path.win32.basename(executable)) && (family === "gaussian" || metadataIdentity?.engineId === "gaussian" && metadataIdentity.verified) && evidence.installationSettings?.binPath
					? { commandContract: { commandMode: "gaussian-windows-cli-v1", inputMode: "argument", argumentTemplate: ["{input}", "{output}"], verified: true, evidenceRefs: ["adapter-contract:gaussian-windows-cli-v1", "https://winmostar.com/jp/manual_jp/V10/installation/Gaussian_setup_manual_jp_win.pdf", ...evidence.evidenceRefs], primaryOutputName: "output.out", nativeStdoutName: "native-stdout.txt" } } : {}),
				engineIdentity: family
					? {
							engineId: family,
							verified: true,
							evidenceRefs: evidence.evidenceRefs,
							source: evidence.source
						}
					: metadataIdentity
			};
		})();
		cache.set(key, pending);
		try {
			return await pending;
		} catch (error) {
			if (error.details?.probeEvidence?.invokedNative !== true) cache.delete(key);
			throw error;
		}
	}
	async function readToolEvidence({
		environment,
		run,
		engineId,
		candidatePath,
		transport,
		signal
	}) {
		if (!transport) return null;
		const identity = await transport.stat(candidatePath, { signal }),
			sourceEntry = run.softwareSnapshot.entryIdentity,
			actualEntry = await transport.stat(run.environmentSnapshot.softwareAdapter.executable, {
				signal
			});
		if (!unchanged(sourceEntry, actualEntry)) fail("SOFTWARE_CHANGED_BEFORE_TOOL_PREPARATION");
		const api = run.softwareSnapshot.platform === "win32" ? path.win32 : path.posix;
		const candidateDirectory = api.dirname(candidatePath),
			entryDirectory = api.dirname(actualEntry.path);
		const sameDirectory = api === path.win32
			? api.normalize(candidateDirectory) === api.normalize(entryDirectory)
			: candidateDirectory === entryDirectory;
		if (!sameDirectory)
			fail("CONVERSION_TOOL_DISTRIBUTION_CONFLICT");
		const magic = await transport.readRange(
				{ path: candidatePath, identity, offset: 0, length: Math.min(4, identity.byteSize) },
				{ signal }
			),
			bytes = Buffer.from(magic.bytes);
		if (
			!(run.softwareSnapshot.platform === "win32"
				? bytes.subarray(0, 2).toString("ascii") === "MZ"
				: bytes.equals(Buffer.from([0x7f, 69, 76, 70])))
		)
			return null;
		return {
			engineId,
			rawVersion: run.softwareSnapshot.rawVersion,
			recognizedVersion: run.softwareSnapshot.recognizedVersion,
			platform: run.softwareSnapshot.platform,
			executable: candidatePath,
			entryIdentity: identity,
			adapterVersion: "1.0.0",
			capabilities: { supported: ["same-installation-conversion-attempt"], nativeVerified: false },
			compatibleWithRun: true,
			versionSource: "same-installation-association",
			toolRawVersion: null,
			fieldStatus: {
				toolRawVersion: {
					state: "unavailable",
					reason:
						"The utility does not have a separately verified version print; parent installation version is preserved separately"
				}
			},
			compatibilityEvidence: {
				kind: "same-frozen-installation-native-utility",
				softwareEntry: actualEntry,
				toolEntry: identity,
				evidenceRefs: [`${candidatePath}#native-binary`, `${actualEntry.path}#same-installation`]
			},
			environment: run.environmentSnapshot.softwareAdapter.environment || {},
			initialization: environment.initialization || ""
		};
	}
	async function readEnvironmentEvidence(environment, { transport, signal } = {}) {
		if (!transport) return null;
		const key = JSON.stringify([
			environment.environmentId,
			environment.revision,
			environment.host,
			environment.port,
			environment.user,
			environment.workingRoot
		]);
		if (environmentCache.has(key)) return environmentCache.get(key);
		const pending = (async () => {
			const invoke = (executable, args) =>
				transport.exec({ executable, args, cwd: environment.workingRoot, env: {} }, { signal });
			const userResult = await invoke("id", ["-un"]),
				hostResult = await invoke("hostname", []),
				user = Buffer.from(userResult.stdout).toString("utf8").trim(),
				hostname = Buffer.from(hostResult.stdout).toString("utf8").trim();
			if (
				userResult.exitCode !== 0 ||
				!user ||
				/[\r\n|\0\s]/.test(user) ||
				hostResult.exitCode !== 0 ||
				!hostname ||
				/[\r\n|\0]/.test(hostname)
			)
				fail("SLURM_SITE_USER_IDENTITY_UNVERIFIED");
			const commands = {};
			for (const name of ["sbatch", "squeue", "sacct", "scancel", "scontrol"]) {
				try {
					const result = await invoke("bash", ["-c", `command -v ${quote(name)}`]),
						resolved = Buffer.from(result.stdout).toString("utf8").trim();
					if (result.exitCode === 0 && resolved.startsWith("/") && !/[\r\n\0]/.test(resolved))
						commands[name] = resolved;
				} catch {}
			}
			let clusterName = null,
				accountingComment = false;
			if (commands.scontrol) {
				try {
					const result = await invoke(commands.scontrol, ["show", "config"]);
					if (result.exitCode === 0) {
						const raw = Buffer.from(result.stdout).toString("utf8");
						clusterName = raw.match(/^\s*ClusterName\s*=\s*(\S+)\s*$/m)?.[1] || null;
						accountingComment = /^\s*AccountingStoreFlags\s*=.*\bjob_comment\b/im.test(raw);
					}
				} catch {}
			}
			const capabilities = await inspectSlurmCapabilities(
				{ transport, workingRoot: environment.workingRoot, commands, accountingComment },
				{ signal }
			);
			return {
				siteId:
					"slurm-" +
					sha256(
						Buffer.from(
							JSON.stringify({
								host: environment.host || hostname,
								port: environment.port || null,
								hostname,
								clusterName
							})
						)
					).slice(0, 32),
				user,
				commands,
				capabilities: capabilities.schedulerCapabilities,
				clusterName,
				hostname,
				directives: [],
				evidenceRefs: [
					`${environment.environmentId}#id-un`,
					`${environment.environmentId}#hostname`,
					`${environment.environmentId}#slurm-version-help`
				],
				nativeVerified: false,
				checkedAt: new Date().toISOString()
			};
		})();
		environmentCache.set(key, pending);
		try {
			return await pending;
		} catch (error) {
			environmentCache.delete(key);
			throw error;
		}
	}
	return { readSoftwareEvidence, readToolEvidence, readEnvironmentEvidence };
}
module.exports = {
	createDefaultEvidenceReaders,
	versionLines,
	embeddedVersionLines,
	peMetadata,
	binaryMarkers,
	startupBanner
};
