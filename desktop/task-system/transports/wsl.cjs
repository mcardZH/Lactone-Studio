"use strict";
const { createLocalTransport } = require("./local.cjs");
const { createPosixTransport } = require("./posix.cjs");
const { commandScript } = require("./posix.cjs");
const path = require("node:path");
const { requireText, fail, abort, quote } = require("../execution/common.cjs");
function createWslTransport({
	environmentId,
	distribution,
	user,
	hostWorkingDirectory,
	wslExecutable = "wsl.exe",
	spawn,
	spawnDetached,
	now
}) {
	requireText(distribution, "WSL_DISTRIBUTION");
	requireText(user, "WSL_USER");
	const host = createLocalTransport({ environmentId: `${environmentId}:control`, spawn, now });
	let disposed = false;
	const transport = createPosixTransport({
		kind: "wsl",
		environmentId,
		now,
		control: (script, stdin, io) =>
			host.exec(
				{
					executable: wslExecutable,
					args: ["-d", distribution, "-u", user, "--exec", "bash", "-c", script],
					cwd: hostWorkingDirectory,
					env: {},
					stdin
				},
				io
			),
		dispose: () => {
			disposed = true;
			return host.dispose();
		}
	});
	transport.handoffPersistentCommand = async ({ command, binding }, io) => {
		if (disposed) fail("TRANSPORT_DISPOSED");
		abort(io?.signal);
		if (typeof spawnDetached !== "function") fail("WSL_PERSISTENT_HANDOFF_UNAVAILABLE");
		for (const key of ["taskId", "runId", "submissionIntentId", "operationId"])
			requireText(binding?.[key], `WSL_BINDING_${key.toUpperCase()}`);
		const state = path.posix.join(command.cwd, ".es-execution");
		if (
			command.executable !== "bash" ||
			!Array.isArray(command.args) ||
			command.args.length !== 1 ||
			!["runner.sh", "prepare.sh"].some(
				(name) => command.args[0] === path.posix.join(state, name)
			) ||
			Object.keys(command.env || {}).length ||
			command.stdin !== undefined ||
			!command.stdoutPath ||
			path.posix.dirname(command.stdoutPath) !== state ||
			command.stderrPath !== command.stdoutPath
		)
			fail("WSL_PERSISTENT_COMMAND_SCOPE_CONFLICT");
		// The foreground bash waits for the full Linux wrapper, including conversion.
		// Append diagnostics: an uncertain/repeated caller must not truncate an original log.
		const script = `${commandScript({ ...command, stdoutPath: undefined, stderrPath: undefined })} </dev/null >> ${quote(command.stdoutPath)} 2>&1`;
		const launched = await spawnDetached({
			executable: wslExecutable,
			args: ["-d", distribution, "-u", user, "--exec", "bash", "-c", script],
			cwd: hostWorkingDirectory,
			env: {},
			stdio: "ignore",
			detached: true,
			windowsHide: true
		});
		if (!Number.isSafeInteger(launched?.pid) || launched.pid < 1)
			fail("WSL_PERSISTENT_HANDOFF_UNVERIFIED", { stage: "persistent-handoff", binding });
		return {
			kind: "wsl-foreground-connection-v1",
			pid: launched.pid,
			distribution,
			user,
			acceptedAt: now ? now() : new Date().toISOString(),
			evidenceRefs: [`wsl-connection:${environmentId}:${launched.pid}`]
		};
	};
	if (typeof spawnDetached !== "function") delete transport.handoffPersistentCommand;
	const capabilities = transport.capabilities;
	transport.capabilities = async (io) => {
		const value = await capabilities(io);
		return {
			...value,
			supported: [...value.supported, ...(spawnDetached ? ["persistent-command-handoff"] : [])],
			unavailable: [
				...value.unavailable,
				...(!spawnDetached ? ["persistent-command-handoff"] : [])
			],
			unverified: [...value.unverified, "native-survival-after-owner-exit"]
		};
	};
	return transport;
}
module.exports = { createWslTransport };
