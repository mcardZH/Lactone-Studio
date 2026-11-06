"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createAtomicConfigStore, fail, noLinks } = require("./global-settings.cjs");
const KEYS = ["password", "privateKeyPassphrase"];
function environmentCredentialKey(environment) {
	const binding = {
		environmentId: environment.environmentId,
		connectionKind: environment.connectionKind,
		host: environment.host || "",
		port: environment.port || 22,
		user: environment.user || "",
		distribution: environment.distribution || "",
		authentication: environment.authentication,
		privateKeyPath: environment.privateKeyPath || ""
	};
	return (
		"environment-credential:" +
		crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex")
	);
}
/** Only explicit remember persists, using the injected OS-bound safeStorage implementation. */
function createCredentialVault(options) {
	const { safeStorage } = options;
	const store = createAtomicConfigStore({
		...options,
		name: "credentials",
		defaults: { entries: {} },
		validate: (value) => !!value?.entries && typeof value.entries === "object"
	});
	const transient = new Map();
	function available() {
		return !!(safeStorage?.isEncryptionAvailable?.() ?? safeStorage?.isAvailable?.());
	}
	function sanitize(secret) {
		return Object.fromEntries(
			KEYS.filter((key) => typeof secret?.[key] === "string").map((key) => [key, secret[key]])
		);
	}
	return {
		async save(environmentId, secret) {
			if (!secret) return;
			const value = sanitize(secret);
			if (secret.remember) {
				if (!available()) throw fail("SECURE_STORAGE_UNAVAILABLE");
				const bytes = safeStorage.encryptString(JSON.stringify(value)),
					state = store.read();
				await store.update(state.revision, (config) => ({
					...config,
					entries: { ...config.entries, [environmentId]: Buffer.from(bytes).toString("base64") }
				}));
				transient.delete(environmentId);
			} else {
				transient.set(environmentId, value);
			}
		},
		async resolve(environment, supplied) {
			const id = environment.environmentId,
				config = environment.configuration || environment;
			let secret = supplied ? sanitize(supplied) : transient.get(id);
			if (!secret) {
				const encrypted = store.read().value.entries[id];
				if (encrypted) {
					if (!available()) throw fail("SECURE_STORAGE_UNAVAILABLE");
					try {
						secret = sanitize(
							JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")))
						);
					} catch {
						throw fail("CREDENTIAL_DECRYPT_FAILED");
					}
				}
			}
			const auth = config.authentication || config.configuration?.authentication || "agent",
				result = {};
			if (auth === "password") {
				if (!secret?.password) throw fail("CREDENTIAL_REQUIRED");
				result.password = secret.password;
			}
			if (auth === "private-key") {
				const keyPath = config.privateKeyPath || config.configuration?.privateKeyPath;
				if (!keyPath) throw fail("PRIVATE_KEY_REQUIRED");
				noLinks(keyPath);
				result.privateKey = await fs.promises.readFile(keyPath);
				if (secret?.privateKeyPassphrase) result.passphrase = secret.privateKeyPassphrase;
			}
			if (auth === "agent") result.agent = options.agent || process.env.SSH_AUTH_SOCK || undefined;
			let released = false;
			return {
				value: result,
				release() {
					if (released) return;
					released = true;
					if (Buffer.isBuffer(result.privateKey)) result.privateKey.fill(0);
					for (const key of Object.keys(result)) delete result[key];
				}
			};
		},
		async forget(id) {
			transient.delete(id);
			const state = store.read();
			if (Object.hasOwn(state.value.entries, id))
				await store.update(state.revision, (config) => {
					delete config.entries[id];
					return config;
				});
		},
		clearTransient() {
			transient.clear();
		}
	};
}
function createHostKeyVerifier({ settings }) {
	const challenges = new Map();
	return {
		verify({ host, port = 22, algorithm, fingerprint }) {
			const key = `${host}:${port}:${algorithm}`,
				known = settings.read().value.trustedHostKeys[key];
			if (known === fingerprint) return { trusted: true };
			const challenge = {
				challengeId: crypto.randomUUID(),
				host,
				port,
				algorithm,
				fingerprint,
				state: known ? "changed" : "unknown"
			};
			challenges.set(challenge.challengeId, { ...challenge, key });
			return { trusted: false, challenge };
		},
		async trust({ challengeId, fingerprint }) {
			const challenge = challenges.get(challengeId);
			if (!challenge || challenge.fingerprint !== fingerprint)
				throw fail("HOST_KEY_CHALLENGE_INVALID");
			if (challenge.state === "changed") throw fail("HOST_KEY_CHANGED");
			await settings.trustHostKey(challenge.key, fingerprint);
			challenges.delete(challengeId);
		},
		clear() {
			challenges.clear();
		}
	};
}
module.exports = { createCredentialVault, createHostKeyVerifier, environmentCredentialKey };
