"use strict";
const crypto = require("node:crypto");
const { writeStream } = require("../execution/sources.cjs");
const { createPosixTransport } = require("./posix.cjs");
const { fail, requireText, abort } = require("../execution/common.cjs");
/** Auth and host-key decisions are injected by the host, never serialized by this module. */
function createSshTransport({
	environmentId,
	connection,
	credentialRef,
	credentials,
	verifyHostKey,
	Client,
	now,
	maxControlBytes = 8 * 1024 * 1024
}) {
	requireText(connection.host, "SSH_HOST");
	requireText(connection.user, "SSH_USER");
	if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)
		fail("INVALID_SSH_PORT");
	if (typeof verifyHostKey !== "function" || !credentials?.resolve)
		fail("SSH_SECURITY_PROVIDERS_REQUIRED");
	let client,
		connecting,
		disposed = false;
	const channels = new Set();
	async function connect(io) {
		abort(io?.signal);
		if (disposed) fail("TRANSPORT_DISPOSED");
		if (client) return client;
		if (connecting) return connecting;
		connecting = (async () => {
			let authLease;
			try {
				authLease = await credentials.resolve({
					environmentId,
					credentialRef,
					purpose: "ssh-connect"
				});
			} catch {
				fail("SSH_CREDENTIALS_UNAVAILABLE");
			}
			const auth = authLease?.value || authLease;
			let releaseAbort = () => {};
			try {
				const Constructor = Client || require("ssh2").Client,
					candidate = new Constructor();
				return await new Promise((resolve, reject) => {
					let ready = false;
					const onAbort = () => {
						candidate.end();
						reject(Object.assign(new Error("IO_ABORTED"), { code: "IO_ABORTED" }));
					};
					io?.signal?.addEventListener("abort", onAbort, { once: true });
					releaseAbort = () => io?.signal?.removeEventListener("abort", onAbort);
					candidate.once("ready", () => {
						ready = true;
						client = candidate;
						io?.signal?.removeEventListener("abort", onAbort);
						resolve(candidate);
					});
					candidate.on("error", () => {
						if (!ready) {
							candidate.end();
							reject(
								Object.assign(new Error("SSH_CONNECTION_FAILED"), { code: "SSH_CONNECTION_FAILED" })
							);
						}
					});
					candidate.on("close", () => {
						if (client === candidate) client = undefined;
						if (!ready)
							reject(
								Object.assign(new Error("SSH_CONNECTION_CLOSED"), { code: "SSH_CONNECTION_CLOSED" })
							);
					});
					// No debug callback and no raw ssh2 error forwarding: either may contain secret material.
					try {
						candidate.connect({
							host: connection.host,
							port: connection.port,
							username: connection.user,
							...(auth?.password !== undefined ? { password: auth.password } : {}),
							...(auth?.privateKey ? { privateKey: auth.privateKey } : {}),
							...(auth?.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
							...(auth?.agent ? { agent: auth.agent } : {}),
							hostVerifier: (key, done) => {
								const fingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
								Promise.resolve(
									verifyHostKey({
										environmentId,
										host: connection.host,
										port: connection.port,
										fingerprint,
										key: Buffer.from(key)
									})
								).then(
									(value) => done(value === true),
									() => done(false)
								);
							}
						});
					} catch {
						candidate.end();
						reject(
							Object.assign(new Error("SSH_AUTH_CONFIGURATION_INVALID"), {
								code: "SSH_AUTH_CONFIGURATION_INVALID"
							})
						);
					}
				});
			} finally {
				releaseAbort();
				try {
					if (authLease?.release) await authLease.release();
					else await auth?.release?.();
				} catch {
					fail("SSH_CREDENTIAL_RELEASE_FAILED");
				}
			}
		})();
		try {
			return await connecting;
		} finally {
			connecting = undefined;
		}
	}
	async function control(script, stdin, io) {
		const active = await connect(io);
		abort(io?.signal);
		return new Promise((resolve, reject) => {
			active.exec(script, { pty: false }, (error, channel) => {
				if (error) {
					reject(Object.assign(new Error("SSH_EXEC_FAILED"), { code: "SSH_EXEC_FAILED" }));
					return;
				}
				channels.add(channel);
				let feeding = Promise.resolve(),
					stdout = [],
					stderr = [],
					total = 0,
					failed;
				const onAbort = () => {
					failed ||= Object.assign(new Error("IO_ABORTED"), { code: "IO_ABORTED" });
					channel.close();
				};
				io?.signal?.addEventListener("abort", onAbort, { once: true });
				const collect = (list, sink) => (chunk) => {
					if (failed) return;
					if (sink) {
						try { abort(io?.signal); sink(Buffer.from(chunk)); }
						catch (value) { failed ||= value; channel.close(); }
						return;
					}
					total += chunk.length;
					if (total > maxControlBytes) {
						failed ||= Object.assign(new Error("CONTROL_OUTPUT_LIMIT"), {
							code: "CONTROL_OUTPUT_LIMIT"
						});
						channel.close();
					} else list.push(Buffer.from(chunk));
				};
				channel.on("data", collect(stdout, io?.stdoutSink));
				channel.stderr.on("data", collect(stderr));
				channel.on("error", () => {
					failed ||= Object.assign(new Error("SSH_CHANNEL_FAILED"), { code: "SSH_CHANNEL_FAILED" });
				});
				channel.once("close", async (exitCode, signal) => {
					await feeding.catch(() => {});
					channels.delete(channel);
					io?.signal?.removeEventListener("abort", onAbort);
					if (failed) reject(failed);
					else
						resolve({
							exitCode: Number.isInteger(exitCode) ? exitCode : null,
							signal,
							stdout: Buffer.concat(stdout),
							stderr: Buffer.concat(stderr),
							evidenceRefs: []
						});
				});
				feeding = writeStream(channel, stdin || Buffer.alloc(0), io).catch(() => {
					failed ||= Object.assign(new Error("SSH_UPLOAD_SOURCE_FAILED"), {
						code: "SSH_UPLOAD_SOURCE_FAILED"
					});
					channel.close();
				});
			});
		});
	}
	return createPosixTransport({
		kind: "ssh",
		environmentId,
		control,
		now,
		async dispose() {
			disposed = true;
			for (const channel of channels) channel.close();
			client?.end();
			client = undefined;
		}
	});
}
module.exports = { createSshTransport };
