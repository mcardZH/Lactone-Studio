import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	createProcessIdentityProvider,
	identityMatches,
	validateArgumentSerialization,
	GAUSSIAN_WINDOWS_SERIALIZATION
} = require("../../../../desktop/task-system/platform/process-identity.cjs");
const { createTaskSystemComposition } = require("../../../../desktop/task-system-composition.cjs");

test("validateArgumentSerialization validates Gaussian Windows command serialization", () => {
	assert.equal(validateArgumentSerialization({ executable: "C:\\g16w\\g16w.exe", cwd: "C:\\work", args: [] }), null);
	const valid = validateArgumentSerialization({
		argumentSerialization: GAUSSIAN_WINDOWS_SERIALIZATION,
		executable: "C:\\g16w\\g16w.exe",
		cwd: "C:\\work\\job1",
		args: ["-run", "-inp=C:\\work\\job1\\input.gjf", "-out=C:\\work\\job1\\output.out"]
	});
	assert.deepEqual(valid, {
		argumentSerialization: GAUSSIAN_WINDOWS_SERIALIZATION,
		inputPath: "C:\\work\\job1\\input.gjf",
		outputPath: "C:\\work\\job1\\output.out"
	});
	assert.throws(
		() =>
			validateArgumentSerialization({
				argumentSerialization: "unknown-v1",
				executable: "C:\\g16w\\g16w.exe",
				cwd: "C:\\work",
				args: []
			}),
		{ code: "UNSUPPORTED_ARGUMENT_SERIALIZATION" }
	);
});

test("identityMatches distinguishes POSIX case-sensitive paths from Windows case-insensitive paths", () => {
	const basePosix = {
		pid: 100,
		startedAt: "2026-11-08T04:00:00.000Z",
		hostId: "host-1",
		userId: "501",
		executableIdentity: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio",
		commandLine: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio --type=main",
		bootId: "boot-1",
		creationFileTime: "1794110400000"
	};
	assert.equal(identityMatches(basePosix, { ...basePosix }), true);
	assert.equal(
		identityMatches(basePosix, {
			...basePosix,
			executableIdentity: "/applications/ester studio.app/contents/macos/ester studio"
		}),
		false
	);

	const baseWin = {
		...basePosix,
		executableIdentity: "C:\\Program Files\\Ester Studio\\Ester Studio.exe"
	};
	assert.equal(
		identityMatches(baseWin, {
			...baseWin,
			executableIdentity: "c:\\program files\\ester studio\\ester studio.exe"
		}),
		true
	);
});

test("darwin provider inspect, currentIdentity, and probe handle alive, dead, conflict, and unknown states", async () => {
	let bootUuid = "BOOT-UUID-1111";
	let hostUuid = "HOST-UUID-2222";
	const processes = new Map([
		[
			4242,
			{
				uid: "501",
				lstart: "Sun Nov  8 04:00:00 2026",
				comm: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio",
				args: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio /workspace"
			}
		]
	]);
	let psFailure = null;
	let mutateSecondPs = false;

	const provider = createProcessIdentityProvider({
		platform: "darwin",
		execFile(file, args, _opts, cb) {
			if (file === "/usr/sbin/sysctl" && args[1] === "kern.bootsessionuuid") {
				return cb(null, bootUuid ? `${bootUuid}\n` : "", "");
			}
			if (file === "/usr/sbin/ioreg") {
				return cb(null, hostUuid ? `    "IOPlatformUUID" = "${hostUuid}"\n` : "", "");
			}
			if (file === "/bin/ps") {
				if (psFailure) return cb(psFailure.err, psFailure.stdout || "", psFailure.stderr || "");
				const pid = Number(args[2]);
				const proc = processes.get(pid);
				if (!proc) {
					const err = Object.assign(new Error("exit 1"), { code: 1 });
					return cb(err, "", "");
				}
				const format = args[4];
				if (format === "pid=,uid=,lstart=,comm=") {
					return cb(null, ` ${pid} ${proc.uid} ${proc.lstart} ${proc.comm}\n`, "");
				}
				if (format === "pid=,uid=,lstart=,args=") {
					const lstart = mutateSecondPs ? "Sun Nov  8 04:00:01 2026" : proc.lstart;
					return cb(null, ` ${pid} ${proc.uid} ${lstart} ${proc.args}\n`, "");
				}
			}
			cb(Object.assign(new Error("unexpected command"), { code: "ENOENT" }), "", "");
		}
	});

	const identity = await provider.inspect(4242, { instanceId: "es-task-host:test-1" });
	assert.ok(identity);
	assert.equal(identity.pid, 4242);
	assert.equal(identity.userId, "501");
	assert.equal(identity.hostId, "HOST-UUID-2222");
	assert.equal(identity.bootId, "BOOT-UUID-1111");
	assert.equal(identity.executableIdentity, "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio");
	assert.equal(identity.commandLine, "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio /workspace");
	assert.equal(identity.instanceId, "es-task-host:test-1");

	// Executable filter on POSIX
	assert.ok(
		await provider.inspect(4242, {
			executable: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio"
		})
	);
	assert.equal(
		await provider.inspect(4242, {
			executable: "/Applications/Other.app/Contents/MacOS/Other"
		}),
		null
	);
	// POSIX ps does not supply unflattened argv, so context.args must return null rather than guessing
	assert.equal(await provider.inspect(4242, { args: ["/workspace"] }), null);

	// Probe alive
	const alive = await provider.probe(identity);
	assert.equal(alive.status, "alive");
	assert.equal(alive.identity.instanceId, "es-task-host:test-1");

	// Race condition between the two ps calls returns unknown
	mutateSecondPs = true;
	const raced = await provider.probe(identity);
	assert.equal(raced.status, "unknown");
	assert.equal(raced.reason, "PROCESS_IDENTITY_CHANGED");
	mutateSecondPs = false;

	// PID reused by another process -> conflict
	processes.set(4242, {
		uid: "501",
		lstart: "Sun Nov  8 04:05:00 2026",
		comm: "/usr/bin/python3",
		args: "/usr/bin/python3 script.py"
	});
	const reused = await provider.probe(identity);
	assert.equal(reused.status, "conflict");
	assert.equal(reused.reason, "PROCESS_IDENTITY_MISMATCH");

	// Process exited on same host and boot -> dead
	processes.delete(4242);
	const dead = await provider.probe(identity);
	assert.equal(dead.status, "dead");

	// Process exited (ps returns 1) AND subsequent host query fails -> must return unknown, NOT conflict
	let failSecondHostRead = false;
	const providerWithTransientHostFailure = createProcessIdentityProvider({
		platform: "darwin",
		execFile(file, args, _opts, cb) {
			if (file === "/usr/sbin/sysctl" && args[1] === "kern.bootsessionuuid") {
				if (failSecondHostRead) {
					failSecondHostRead = false;
					return cb(Object.assign(new Error("sysctl failed"), { code: 1 }), "", "error");
				}
				failSecondHostRead = true;
				return cb(null, `${bootUuid}\n`, "");
			}
			if (file === "/usr/sbin/ioreg") {
				return cb(null, `    "IOPlatformUUID" = "${hostUuid}"\n`, "");
			}
			if (file === "/bin/ps") {
				return cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
			}
			cb(Object.assign(new Error("unexpected"), { code: "ENOENT" }), "", "");
		}
	});
	const deadWithHostFailure = await providerWithTransientHostFailure.probe(identity);
	assert.equal(deadWithHostFailure.status, "unknown");
	assert.equal(deadWithHostFailure.reason, "HOST_IDENTITY_UNAVAILABLE");

	// Missing primary bootUuid never switches to an incompatible fallback source
	bootUuid = "";
	const missingBoot = await provider.probe(identity);
	assert.equal(missingBoot.status, "unknown");
	assert.equal(missingBoot.reason, "HOST_IDENTITY_UNAVAILABLE");
	bootUuid = "BOOT-UUID-1111";

	// Process absent but bootId changed -> conflict (HOST_OR_BOOT_MISMATCH)
	bootUuid = "BOOT-UUID-NEW";
	const rebooted = await provider.probe(identity);
	assert.equal(rebooted.status, "conflict");
	assert.equal(rebooted.reason, "HOST_OR_BOOT_MISMATCH");
	bootUuid = "BOOT-UUID-1111";

	// ps execution error -> unknown (never false dead)
	psFailure = { err: Object.assign(new Error("ps crashed"), { code: 2 }), stdout: "", stderr: "ps error" };
	const errored = await provider.probe(identity);
	assert.equal(errored.status, "unknown");
	assert.equal(errored.reason, "IDENTITY_HELPER_UNAVAILABLE");
	psFailure = null;

	// Local task execution APIs are restricted to win32
	await assert.rejects(
		() => provider.launch({ executable: "/bin/echo", cwd: "/tmp", args: ["hi"] }),
		{ code: "PLATFORM_NOT_IMPLEMENTED" }
	);
	const stopped = await provider.stop(identity);
	assert.equal(stopped.requested, false);
	assert.equal(stopped.reason, "VERIFIED_JOB_REQUIRED");
	const waited = await provider.waitTreeEnded(identity);
	assert.equal(waited.verified, false);
	assert.equal(waited.reason, "VERIFIED_JOB_REQUIRED");
});

test("linux provider reads boot_id and machine-id and probes process state", async () => {
	const provider = createProcessIdentityProvider({
		platform: "linux",
		async readFile(file) {
			if (file === "/proc/sys/kernel/random/boot_id") return "linux-boot-123\n";
			if (file === "/etc/machine-id") return "linux-host-456\n";
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		execFile(file, args, _opts, cb) {
			if (file === "/bin/ps" && args[2] === "99") {
				if (args[4] === "pid=,uid=,lstart=,comm=") {
					return cb(null, " 99 1000 Sun Nov  8 04:00:00 2026 /usr/bin/node\n", "");
				}
				return cb(null, " 99 1000 Sun Nov  8 04:00:00 2026 /usr/bin/node app.js\n", "");
			}
			cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
		}
	});
	const identity = await provider.inspect(99);
	assert.ok(identity);
	assert.equal(identity.hostId, "linux-host-456");
	assert.equal(identity.bootId, "linux-boot-123");
	assert.equal((await provider.probe(identity)).status, "alive");
});

if (process.platform === "darwin") {
	test("macOS real process identity, child lifecycle probe, and task host composition smoke test", async () => {
		const provider = createProcessIdentityProvider();
		const selfIdentity = await provider.currentIdentity("es-task-host:darwin-smoke");
		if (!selfIdentity) {
			// Inside restricted sandboxes (such as Codex review sandbox) where /bin/ps or ioreg is blocked,
			// currentIdentity returns null rather than fabricating an unverified identity.
			const restrictedProbe = await provider.probe({
				pid: process.pid,
				startedAt: "2026-11-08T04:00:00.000Z",
				hostId: "sandbox-host",
				userId: String(process.getuid?.() ?? 501),
				executableIdentity: process.execPath,
				commandLine: process.execPath,
				bootId: "sandbox-boot",
				creationFileTime: "1794110400000"
			});
			assert.equal(restrictedProbe.status, "unknown");
			return;
		}
		assert.equal(selfIdentity.pid, process.pid);
		assert.equal(selfIdentity.instanceId, "es-task-host:darwin-smoke");
		const selfProbe = await provider.probe(selfIdentity);
		assert.equal(selfProbe.status, "alive");

		// Spawn a real child process, inspect it, terminate it, and verify probe reports dead
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore"
		});
		try {
			const childIdentity = await provider.inspect(child.pid);
			assert.ok(childIdentity);
			assert.equal((await provider.probe(childIdentity)).status, "alive");
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("close", resolve));
			const deadProbe = await provider.probe(childIdentity);
			assert.equal(deadProbe.status, "dead");
		} finally {
			try {
				child.kill("SIGKILL");
			} catch {}
		}

		// Verify task-system-composition initializes cleanly on macOS using currentIdentity & probe
		const realTmp = await fs.realpath(os.tmpdir());
		const tempRoot = await fs.mkdtemp(path.join(realTmp, "es-darwin-host-test-"));
		const composition = createTaskSystemComposition({
			globalDirectory: path.join(tempRoot, "global"),
			snapshotRoot: path.join(tempRoot, "snapshots"),
			assertOwner() {},
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (v) => Buffer.from(v, "utf8"),
				decryptString: (b) => Buffer.from(b).toString("utf8")
			},
			launchSources: { open: async () => [], describe: async () => ({}), close: async () => {} },
			chooseDirectory: async () => null,
			chooseOpenFile: async () => null,
			chooseDependencyFiles: async () => [],
			chooseSaveFile: async () => null,
			chooseImportFile: async () => null,
			writeClipboard: async () => {},
			openPath: async () => "",
			confirmImpact: async () => true
		});
		try {
			const state = await composition.request(1, {
				requestId: "00000000-0000-4000-8000-000000000001",
				command: "center.read",
				input: {}
			});
			assert.ok(Array.isArray(state.environments));
		} finally {
			await composition.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
}
