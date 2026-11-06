"use strict";
const { crypto, fail } = require("./io.cjs");
const { iterateRecords } = require("../operation-guards.cjs");
const references = new WeakMap();
const base = () => ({ schemaVersion: 1, revision: 1, requiredCapabilities: [] });
const id = (prefix) => prefix + "-" + crypto.randomUUID();
const safeName = (value) => {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9_.-]+$/.test(value) ||
		value === "." ||
		value === ".."
	)
		throw fail("ASSET_UNSAFE_ID");
	return value;
};
const resultRoles = new Set([
	"input",
	"primary-output",
	"structure",
	"trajectory",
	"wavefunction",
	"modes",
	"restart",
	"diagnostic"
]);

function assertScopeSize(scope, count) {
	if (!scope || typeof scope !== "object" || !Number.isSafeInteger(count) || count < 0)
		throw fail("ASSET_OPERATION_SCOPE_INVALID");
}
function sharedArtifactReference(store, location, artifactId) {
	const allowed = artifactId instanceof Set ? artifactId : new Set([artifactId]);
	const version = store.artifactRevision?.();
	let cached = version !== undefined && references.get(store);
	if (!cached || cached.version !== version) {
		const paths = new Map();
		for (const artifact of iterateRecords(store, "artifact")) for (const value of artifact.locations || []) {
			if (typeof value.path !== "string") continue;
			const key = JSON.stringify([value.environmentId ?? null, value.path]);
			let ids = paths.get(key); if (!ids) { ids = new Set(); paths.set(key, ids); }
			ids.add(artifact.artifactId);
		}
		cached = { version, paths }; if (version !== undefined) references.set(store, cached);
	}
	for (const key of [JSON.stringify([location.environmentId, location.path]), JSON.stringify([null, location.path])])
		for (const id of cached.paths.get(key) || []) if (!allowed.has(id)) return true;
	return false;
}
async function withArtifactReferences(store, location, artifactId, action) {
	const guarded = async () => {
		if (sharedArtifactReference(store, location, artifactId)) throw fail("ASSET_SHARED_REFERENCE");
		return action();
	};
	return store.withArtifactReferenceGuard ? store.withArtifactReferenceGuard({ ...location, artifactId }, guarded) : guarded();
}
const EXECUTION_BATCH_ITEMS = 128;
const yieldIO = () => new Promise(resolve => setImmediate(resolve));
const scopeDigest = scope => crypto.createHash("sha256").update(JSON.stringify(scope)).digest("hex");
function assertFrozenScope(operation) {
	const { scopeDigest: expected, ...scope } = operation.authorizationScope;
	if (expected !== undefined && scopeDigest(scope) !== expected) throw fail("ASSET_REGISTERED_SCOPE_CHANGED");
}
module.exports = { base, id, safeName, resultRoles, assertScopeSize, sharedArtifactReference, withArtifactReferences, EXECUTION_BATCH_ITEMS, yieldIO, scopeDigest, assertFrozenScope };
