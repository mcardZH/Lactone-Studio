"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const clone = (value) => JSON.parse(JSON.stringify(value));
function fail(code, detail) {
	return Object.assign(new Error(code), { code, detail });
}
function digest(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
function noLinks(directory) {
	let current = path.resolve(directory);
	for (;;) {
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
			throw fail("CONFIG_LINK_REFUSED");
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function atomic(file, value) {
	const candidate = file + ".candidate-" + crypto.randomUUID();
	const fd = fs.openSync(candidate, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(candidate, file);
}
/** App-data owned, version independent. An unreadable current file never becomes an empty config. */
function createAtomicConfigStore({
	directory,
	name = "settings",
	processIdentity,
	probeProcessIdentity,
	defaults,
	validate = () => true
}) {
	if (
		!path.isAbsolute(directory) ||
		!processIdentity?.instanceId ||
		typeof probeProcessIdentity !== "function"
	)
		throw fail("CONFIG_COMPOSITION_REQUIRED");
	noLinks(directory);
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, name + ".json"),
		previous = file + ".previous",
		lock = file + ".lock.sqlite";
	function decode(target) {
		if (fs.lstatSync(target).isSymbolicLink()) throw fail("CONFIG_LINK_REFUSED");
		const envelope = JSON.parse(fs.readFileSync(target, "utf8"));
		if (
			envelope.schemaVersion !== 1 ||
			!Number.isSafeInteger(envelope.revision) ||
			envelope.revision < 1 ||
			digest(JSON.stringify(envelope.value)) !== envelope.sha256 ||
			!validate(envelope.value)
		)
			throw fail("CONFIG_CORRUPT");
		return envelope;
	}
	function read() {
		try {
			return { ...clone(decode(file)), source: "current", writable: true };
		} catch (error) {
			if (error.code === "ENOENT" && !fs.existsSync(previous))
				return {
					schemaVersion: 1,
					revision: 0,
					value: clone(defaults),
					source: "default",
					writable: true
				};
			try {
				return {
					...clone(decode(previous)),
					source: "previous",
					writable: false,
					issue: error.code || "CONFIG_CORRUPT"
				};
			} catch {
				throw fail("CONFIG_RECOVERY_REQUIRED", { current: file, previous });
			}
		}
	}
	function acquire() {
		noLinks(lock);
		const db = new DatabaseSync(lock);
		try {
			db.exec(
				"PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner(singleton INTEGER PRIMARY KEY,json TEXT NOT NULL); BEGIN IMMEDIATE;"
			);
			db.prepare(
				"INSERT INTO owner VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json"
			).run(JSON.stringify(processIdentity));
			// The OS releases this transaction only on close/process death; no TTL or file-unlink race.
			return db;
		} catch (error) {
			db.close();
			throw fail("CONFIG_BUSY", error.code);
		}
	}
	async function update(expectedRevision, change) {
		const writer = acquire();
		try {
			const current = read();
			if (!current.writable) throw fail("CONFIG_RECOVERY_REQUIRED");
			if (expectedRevision !== current.revision) throw fail("CONFIG_REVISION_CONFLICT");
			const value = change(clone(current.value));
			if (!validate(value)) throw fail("CONFIG_INVALID");
			const next = {
				schemaVersion: 1,
				revision: current.revision + 1,
				value,
				sha256: digest(JSON.stringify(value))
			};
			if (current.revision)
				atomic(previous, {
					schemaVersion: 1,
					revision: current.revision,
					value: current.value,
					sha256: digest(JSON.stringify(current.value))
				});
			atomic(file, next);
			return clone(next);
		} finally {
			writer.exec("ROLLBACK");
			writer.close();
		}
	}
	return { read, update, file };
}
const DEFAULT_MONITORING = Object.freeze({
	localIntervalSeconds: 5,
	remoteIntervalSeconds: 30,
	backgroundIntervalSeconds: 60,
	automatic: true
});
function validMonitoring(value) {
	return (
		value &&
		typeof value.automatic === "boolean" &&
		["localIntervalSeconds", "remoteIntervalSeconds", "backgroundIntervalSeconds"].every(
			(key) => Number.isFinite(value[key]) && value[key] >= 1 && value[key] <= 86400
		)
	);
}
function createGlobalSettings(options) {
	const store = createAtomicConfigStore({
		...options,
		defaults: { pointer: null, monitoring: DEFAULT_MONITORING, trustedHostKeys: {} },
		validate(value) {
			const p = value?.pointer;
			return (
				validMonitoring(value?.monitoring) &&
				value.trustedHostKeys &&
				(!p ||
					(typeof p.libraryId === "string" &&
						path.isAbsolute(p.root) &&
						Number.isSafeInteger(p.locationEpoch) &&
						p.locationEpoch > 0))
			);
		}
	});
	return {
		...store,
		readPointer() {
			return clone(store.read().value.pointer);
		},
		async switchPointer({ expected, libraryId, root, receiptSources }) {
			noLinks(root);
			const resolved = fs.realpathSync.native(root),
				current = store.read();
			if (JSON.stringify(current.value.pointer) !== JSON.stringify(expected))
				throw fail("LIBRARY_POINTER_CONFLICT");
			return (
				await store.update(current.revision, (value) => ({
					...value,
					freeze: null,
					pointer: {
						libraryId,
						root: resolved,
						locationEpoch: (expected?.locationEpoch || 0) + 1,
						...(receiptSources?.length ? { receiptSources } : {})
					}
				}))
			).value.pointer;
		},
		assertEffective({ kind, libraryId, directory, locationEpoch }) {
			const state = store.read(),
				pointer = state.value.pointer;
			if (
				!state.writable ||
				!pointer ||
				pointer.libraryId !== libraryId ||
				path.resolve(pointer.root).toLowerCase() !== path.resolve(directory).toLowerCase() ||
				(locationEpoch !== undefined && pointer.locationEpoch !== locationEpoch)
			)
				throw fail("LIBRARY_NOT_EFFECTIVE");
			if (
				state.value.freeze &&
				state.value.freeze.libraryId === libraryId &&
				state.value.freeze.locationEpoch === pointer.locationEpoch &&
				kind !== "checkpoint"
			)
				throw fail("LIBRARY_MIGRATION_FINALIZING");
			return true;
		},
		async freezeMetadata(expected, operationId, details = {}) {
			const current = store.read();
			if (JSON.stringify(current.value.pointer) !== JSON.stringify(expected))
				throw fail("LIBRARY_POINTER_CONFLICT");
			await store.update(current.revision, (value) => ({
				...value,
				freeze: {
					libraryId: expected.libraryId,
					locationEpoch: expected.locationEpoch,
					operationId,
					...details
				}
			}));
		},
		async thawMetadata(expected, operationId) {
			const current = store.read();
			if (
				JSON.stringify(current.value.pointer) !== JSON.stringify(expected) ||
				current.value.freeze?.operationId !== operationId
			)
				throw fail("LIBRARY_POINTER_CONFLICT");
			await store.update(current.revision, (value) => ({ ...value, freeze: null }));
		},
		async saveMonitoring(monitoring) {
			if (!validMonitoring(monitoring)) throw fail("MONITOR_SETTINGS_INVALID");
			const current = store.read();
			return (
				await store.update(current.revision, (value) => ({
					...value,
					monitoring: clone(monitoring)
				}))
			).value.monitoring;
		},
		async trustHostKey(key, fingerprint) {
			const current = store.read();
			const known = current.value.trustedHostKeys[key];
			if (known && known !== fingerprint) throw fail("HOST_KEY_CHANGED");
			await store.update(current.revision, (value) => ({
				...value,
				trustedHostKeys: { ...value.trustedHostKeys, [key]: fingerprint }
			}));
		}
	};
}
module.exports = {
	createAtomicConfigStore,
	createGlobalSettings,
	DEFAULT_MONITORING,
	fail,
	noLinks
};
