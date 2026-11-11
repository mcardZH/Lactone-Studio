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

test("identityMatches verifies all required identity fields and optional argv", () => {
	const base = {
		pid: 100,
		startedAt: "2026-11-08T04:00:00.000Z",
		hostId: "host-1",
		userId: "501",
		executableIdentity: "C:\\Program Files\\Ester Studio\\Ester Studio.exe",
		commandLine: "\"C:\\Program Files\\Ester Studio\\Ester Studio.exe\" --type=main",
		bootId: "boot-1",
		creationFileTime: "1794110400000"
	};
	assert.equal(
		identityMatches(base, {
			...base,
			executableIdentity: "c:\\program files\\ester studio\\ester studio.exe"
		}),
		true
	);
	assert.equal(identityMatches({ ...base, argv: ["a", "b"] }, { ...base, argv: ["a", "b"] }), true);
	assert.equal(identityMatches({ ...base, argv: ["a", "b"] }, { ...base, argv: ["a b"] }), false);
});

test("darwin provider inspect, currentIdentity, and probe handle alive, dead, conflict, and unknown states", async () => {
	let bootUuid = "BOOT-UUID-1111";
	let hostUuid = "HOST-UUID-2222";
	const processes = new Map([
		[
			4242,
			{
				uid: "501",
				state: "S",
				lstart: "Sun Nov  8 04:00:00 2026",
				comm: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio",
				args: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio /workspace"
			}
		]
	]);
	let psFailure = null;
	let mutateSecondPs = false;
	let zombieOnSecondPs = false;

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
				if (format === "pid=,uid=,state=,lstart=,comm=") {
					return cb(null, ` ${pid} ${proc.uid} ${proc.state} ${proc.lstart} ${proc.comm}\n`, "");
				}
				if (format === "pid=,uid=,state=,lstart=,args=") {
					const lstart = mutateSecondPs ? "Sun Nov  8 04:00:01 2026" : proc.lstart;
					const state = zombieOnSecondPs ? "Z+" : proc.state;
					const cmdArgs = zombieOnSecondPs ? "<defunct>" : proc.args;
					return cb(null, ` ${pid} ${proc.uid} ${state} ${lstart} ${cmdArgs}\n`, "");
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

	// darwin inspect rejects context.executable and context.args filters (used only by win32 local task runner)
	assert.equal(
		await provider.inspect(4242, {
			executable: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio"
		}),
		null
	);
	assert.equal(await provider.inspect(4242, { args: ["/workspace"] }), null);

	// Probe alive
	const alive = await provider.probe(identity);
	assert.equal(alive.status, "alive");
	assert.equal(alive.identity.instanceId, "es-task-host:test-1");

	// Parenthesized ps fallback output (when KERN_PROCARGS2 is unreadable) returns unknown, NOT conflict
	processes.set(4242, {
		uid: "501",
		state: "S",
		lstart: "Sun Nov  8 04:00:00 2026",
		comm: "(Ester Studio)",
		args: "(Ester Studio)"
	});
	assert.equal(await provider.inspect(4242), null);
	const fallbackProbe = await provider.probe(identity);
	assert.equal(fallbackProbe.status, "unknown");
	assert.equal(fallbackProbe.reason, "PROCESS_UNREADABLE");
	processes.set(4242, {
		uid: "501",
		state: "S",
		lstart: "Sun Nov  8 04:00:00 2026",
		comm: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio",
		args: "/Applications/Ester Studio.app/Contents/MacOS/Ester Studio /workspace"
	});

	// Race condition between the two ps calls returns unknown
	mutateSecondPs = true;
	const raced = await provider.probe(identity);
	assert.equal(raced.status, "unknown");
	assert.equal(raced.reason, "PROCESS_IDENTITY_CHANGED");
	mutateSecondPs = false;

	// PID reused by another process on the same host/boot -> PROCESS_IDENTITY_MISMATCH
	processes.set(4242, {
		uid: "501",
		state: "R",
		lstart: "Sun Nov  8 04:05:00 2026",
		comm: "/usr/bin/python3",
		args: "/usr/bin/python3 script.py"
	});
	const reused = await provider.probe(identity);
	assert.equal(reused.status, "conflict");
	assert.equal(reused.reason, "PROCESS_IDENTITY_MISMATCH");

	// PID occupied by a live process after reboot or on another host -> HOST_OR_BOOT_MISMATCH
	bootUuid = "BOOT-UUID-AFTER-REBOOT";
	const reusedAfterReboot = await provider.probe(identity);
	assert.equal(reusedAfterReboot.status, "conflict");
	assert.equal(reusedAfterReboot.reason, "HOST_OR_BOOT_MISMATCH");
	bootUuid = "BOOT-UUID-1111";

	hostUuid = "HOST-UUID-OTHER";
	const reusedOnOtherHost = await provider.probe(identity);
	assert.equal(reusedOnOtherHost.status, "conflict");
	assert.equal(reusedOnOtherHost.reason, "HOST_OR_BOOT_MISMATCH");
	hostUuid = "HOST-UUID-2222";

	// Process transitions to zombie (Z) between first and second ps query -> treated as dead
	zombieOnSecondPs = true;
	const zombieTransition = await provider.probe(identity);
	assert.equal(zombieTransition.status, "dead");
	zombieOnSecondPs = false;

	// Process is a zombie (Z / <defunct>) on first ps query -> inspect returns null, probe returns dead
	processes.set(4242, {
		uid: "501",
		state: "Z",
		lstart: "Sun Nov  8 04:00:00 2026",
		comm: "<defunct>",
		args: "<defunct>"
	});
	assert.equal(await provider.inspect(4242), null);
	const zombieProbe = await provider.probe(identity);
	assert.equal(zombieProbe.status, "dead");

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

test("win32 provider inspect, probe, exact args matching, and host failure handling", async () => {
	const EventEmitter = require("node:events");
	let inspectReply = {
		status: "alive",
		pid: 888,
		startedAt: "2026-11-08T04:00:00.000Z",
		hostId: "WIN-HOST-1",
		userId: "S-1-5-21-1000",
		executableIdentity: "C:\\Program Files\\Ester Studio\\Ester Studio.exe",
		commandLine: "\"C:\\Program Files\\Ester Studio\\Ester Studio.exe\" two words",
		bootId: "WIN-BOOT-1",
		creationFileTime: "134000000000000000",
		argv: ["C:\\Program Files\\Ester Studio\\Ester Studio.exe", "two", "words"]
	};
	let hostReply = { hostId: "WIN-HOST-1", bootId: "WIN-BOOT-1" };

	const provider = createProcessIdentityProvider({
		platform: "win32",
		spawn() {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = { resume() {} };
			child.kill = () => {};
			child.stdin = {
				on() {},
				end(payload) {
					const req = JSON.parse(payload);
					const reply = req.action === "host" ? hostReply : inspectReply;
					queueMicrotask(() => {
						child.stdout.emit("data", Buffer.from(JSON.stringify(reply)));
						child.emit("close", 0);
					});
				}
			};
			return child;
		}
	});

	const identity = await provider.inspect(888, {
		executable: "c:\\program files\\ester studio\\ester studio.exe",
		args: ["two", "words"],
		instanceId: "win-host:1"
	});
	assert.ok(identity);
	assert.equal(identity.instanceId, "win-host:1");
	// Exact argv boundary check: ["two words"] must not match ["two", "words"]
	assert.equal(await provider.inspect(888, { args: ["two words"] }), null);
	assert.equal((await provider.probe(identity)).status, "alive");

	// Dead process with valid host reply -> dead
	inspectReply = { status: "dead" };
	assert.equal((await provider.probe(identity)).status, "dead");

	// win32 preserves original main behavior when host query fails on dead process
	hostReply = { status: "unknown", reason: "WINDOWS_IDENTITY_HELPER_FAILED" };
	const failedHost = await provider.probe(identity);
	assert.equal(failedHost.status, "conflict");
	assert.equal(failedHost.reason, "HOST_OR_BOOT_MISMATCH");

	// Unsupported platform returns PLATFORM_NOT_IMPLEMENTED
	const unsupported = createProcessIdentityProvider({ platform: "freebsd" });
	assert.equal(await unsupported.inspect(100), null);
	assert.equal((await unsupported.probe(identity)).reason, "PLATFORM_NOT_IMPLEMENTED");

	// Linux platform inspects via /proc/sys/kernel/random/boot_id + /etc/machine-id + ps
	const linuxProvider = createProcessIdentityProvider({
		platform: "linux",
		fs: {
			async readFile(filePath) {
				if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-linux-001\n";
				if (filePath === "/etc/machine-id") return "machine-linux-001\n";
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			}
		},
		execFile(_file, args, _opts, cb) {
			const fmt = args[args.length - 1];
			if (fmt.endsWith("comm=")) {
				cb(null, "  4242  1000 S    Mon Nov  9 10:20:30 2026 lactone-studio-bin\n", "");
			} else {
				cb(null, "  4242  1000 S    Mon Nov  9 10:20:30 2026 /opt/lactone-studio/lactone-studio-bin --no-sandbox\n", "");
			}
		}
	});
	const linuxIdentity = await linuxProvider.inspect(4242, { instanceId: "linux-host-test" });
	assert.ok(linuxIdentity);
	assert.equal(linuxIdentity.hostId, "machine-linux-001");
	assert.equal(linuxIdentity.bootId, "boot-linux-001");
	assert.equal((await linuxProvider.probe(linuxIdentity)).status, "alive");
});

if (process.platform === "darwin") {
	test("macOS real process identity, child lifecycle probe, and task host composition smoke test", async () => {
		const provider = createProcessIdentityProvider();
		const selfIdentity = await provider.currentIdentity("es-task-host:darwin-smoke");
		assert.ok(selfIdentity);
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
