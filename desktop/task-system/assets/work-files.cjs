"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { fail, abort, unchanged } = require("./io.cjs");
// Enumerate only regular files below a proven directory; links are never followed.
async function inventory(transport, location, { includeManagement = false, hash = false, signal, onProgress } = {}) {
	const api = location.path.startsWith("/") ? path.posix : path.win32;
	abort(signal);
	const root = await transport.stat(location.path, { signal });
	if (!root.isDirectory) throw fail("ASSET_WORK_ROOT_NOT_DIRECTORY");
	const files = [], exclusions = [], directories = [], pending = [{ directory: location.path, identity: root }];
	while (pending.length) {
		abort(signal);
		const { directory, identity } = pending.pop(); directories.push({ directory, identity });
		const listing = await transport.listDirectory({ path: directory, identity }, { signal });
		for (const entry of listing.entries) {
			abort(signal);
			if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/\0]/.test(entry.name)) throw fail("ASSET_WORK_ENTRY_UNSAFE");
			const file = api.join(directory, entry.name), relativePath = api.relative(location.path, file).split(api.sep).join("/");
			if (!includeManagement && (relativePath === "task.ddwz" || relativePath === ".es-execution" || relativePath.startsWith(".es-execution/"))) continue;
			if (entry.kind === "link" || !["file", "directory"].includes(entry.kind)) { exclusions.push({ path: file, kind: entry.kind }); continue; }
			const current = await transport.stat(file, { signal });
			if (entry.kind === "directory") { if (!current.isDirectory) throw fail("ASSET_WORK_ENTRY_CHANGED"); pending.push({ directory: file, identity: current }); }
			else {
				if (!current.isRegularFile) throw fail("ASSET_WORK_ENTRY_CHANGED");
				const checked = hash ? await transport.hash({ path: file, identity: current, algorithm: "sha256" }, { signal }) : null;
				files.push({ path: file, relativePath, identity: checked?.identity || current, byteSize: current.byteSize, ...(checked ? { sha256: checked.hash } : {}) });
				if (files.length % 128 === 0) { onProgress?.({ completed: files.length, unit: "files" }); await new Promise(resolve => setImmediate(resolve)); }
			}
		}
	}
	for (const row of directories) {
		abort(signal);
		if (!unchanged(row.identity, await transport.stat(row.directory, { signal }))) throw fail("ASSET_WORK_DIRECTORY_CHANGED");
	}
	onProgress?.({ completed: files.length, unit: "files" });
	return { rootIdentity: root, files, exclusions };
}
const ownedArtifactId = (runId, relativePath) => "artifact-file-" + crypto.createHash("sha256").update(JSON.stringify([runId, relativePath])).digest("hex");
module.exports = { inventory, ownedArtifactId };
