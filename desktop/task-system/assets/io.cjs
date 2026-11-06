"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const fail = (code) => Object.assign(new Error(code), { code });
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
function abort(signal) {
	if (signal?.aborted) throw fail("ASSET_CANCELLED");
}
function inside(root, file) {
	const relative = path.relative(path.resolve(root), path.resolve(file));
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(".." + path.sep) ||
		path.isAbsolute(relative)
	)
		throw fail("ASSET_OUTSIDE_SCOPE");
	return relative;
}
async function noLinks(file, { missing = false } = {}) {
	let current = path.resolve(file);
	while (true) {
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw fail("ASSET_LINK_REFUSED");
		} catch (error) {
			if (error.code !== "ENOENT" || (!missing && current === path.resolve(file))) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
async function ensureDirectory(directory) {
	await noLinks(directory, { missing: true });
	await fs.mkdir(directory, { recursive: true });
	await noLinks(directory);
}
async function exclusiveDirectory(directory) {
	await noLinks(path.dirname(directory));
	await fs.mkdir(directory);
	await noLinks(directory);
}
function sameFile(a, b) {
	return a?.environmentId === b?.environmentId && a?.fileId === b?.fileId && a?.path === b?.path;
}
function unchanged(a, b) {
	return sameFile(a, b) && a.byteSize === b.byteSize && a.changeToken === b.changeToken;
}
async function localIdentity(file) {
	await noLinks(file);
	const s = await fs.lstat(file, { bigint: true });
	if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) throw fail("ASSET_NOT_REGULAR_FILE");
	return {
		path: path.resolve(file),
		fileId: `${s.dev}:${s.ino}`,
		byteSize: Number(s.size),
		changeToken: `${s.mtimeNs}:${s.ctimeNs}`
	};
}
async function hashLocal(file) {
	const before = await localIdentity(file),
		hash = crypto.createHash("sha256"),
		handle = await fs.open(file, "r");
	try {
		for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
	} finally {
		await handle.close();
	}
	const after = await localIdentity(file);
	if (JSON.stringify(before) !== JSON.stringify(after)) throw fail("ASSET_CHANGED");
	return { ...after, sha256: hash.digest("hex") };
}
async function atomicJSON(file, value) {
	await noLinks(path.dirname(file));
	const tmp = file + ".candidate-" + crypto.randomUUID();
	const handle = await fs.open(tmp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	// hard link gives no-overwrite publication; candidate bytes survive failure for inspection.
	await fs.link(tmp, file);
	await fs.unlink(tmp);
}
async function copySource(
	source,
	destination,
	{ transport, chunkBytes = 1024 * 1024, signal, fault = () => {} } = {}
) {
	abort(signal);
	await noLinks(path.dirname(destination));
	const before = await transport.stat(source.path, { signal });
	if (!sameFile(source.identity, before) || before.isDirectory)
		throw fail("ASSET_SOURCE_IDENTITY_CHANGED");
	const range = source.range || { offset: 0, length: before.byteSize };
	if (
		![range.offset, range.length].every(Number.isSafeInteger) ||
		range.offset < 0 ||
		range.length < 0 ||
		range.offset + range.length > before.byteSize
	)
		throw fail("ASSET_INVALID_RANGE");
	if (!source.range && !unchanged(source.identity, before)) throw fail("ASSET_SOURCE_CHANGED");
	const initialHash = await transport.hash(
		{ path: source.path, identity: before, algorithm: "sha256", range },
		{ signal }
	);
	if (source.sha256 && source.sha256 !== initialHash.hash) throw fail("ASSET_SOURCE_HASH_CHANGED");
	const handle = await fs.open(destination, "wx", 0o600),
		hash = crypto.createHash("sha256");
	let offset = 0;
	try {
		while (offset < range.length) {
			abort(signal);
			const length = Math.min(chunkBytes, range.length - offset);
			const part = await transport.readRange(
				{ path: source.path, identity: before, offset: range.offset + offset, length },
				{ signal }
			);
			const bytes = Buffer.from(part.bytes);
			if (bytes.length !== length) throw fail("ASSET_SHORT_READ");
			await handle.writeFile(bytes);
			hash.update(bytes);
			offset += length;
			await fault("copy-chunk", { source, destination, copiedBytes: offset });
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
	const after = await transport.stat(source.path, { signal });
	if (!sameFile(before, after) || (!source.range && !unchanged(before, after)))
		throw fail("ASSET_SOURCE_CHANGED");
	const finalHash = await transport.hash(
		{ path: source.path, identity: after, algorithm: "sha256", range },
		{ signal }
	);
	const output = await hashLocal(destination);
	if (
		hash.digest("hex") !== initialHash.hash ||
		finalHash.hash !== initialHash.hash ||
		output.sha256 !== initialHash.hash ||
		output.byteSize !== range.length
	)
		throw fail("ASSET_COPY_VERIFICATION_FAILED");
	return { ...output, sourceIdentity: clone(before), sourceRange: range };
}
async function removeExact(root, item) {
	inside(root, item.path);
	const current = await hashLocal(item.path);
	if (
		current.fileId !== item.fileId ||
		current.byteSize !== item.byteSize ||
		current.sha256 !== item.sha256 ||
		(item.changeToken && item.changeToken !== current.changeToken)
	)
		throw fail("ASSET_DELETE_IDENTITY_CHANGED");
	const final = await localIdentity(item.path);
	if (
		final.fileId !== current.fileId ||
		final.byteSize !== current.byteSize ||
		final.changeToken !== current.changeToken
	)
		throw fail("ASSET_DELETE_IDENTITY_CHANGED");
	await fs.unlink(item.path);
	return { path: item.path, removed: true, logicalBytes: current.byteSize };
}
async function listExactFiles(root) {
	await noLinks(root);
	const files = [],
		links = [];
	async function walk(directory) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			const stat = await fs.lstat(file);
			if (stat.isSymbolicLink()) {
				links.push(file);
				continue;
			}
			if (stat.isDirectory()) await walk(file);
			else if (stat.isFile()) files.push(await hashLocal(file));
			else links.push(file);
		}
	}
	await walk(root);
	return { files, links };
}
module.exports = {
	fs,
	path,
	crypto,
	fail,
	digest,
	clone,
	abort,
	inside,
	noLinks,
	ensureDirectory,
	exclusiveDirectory,
	sameFile,
	unchanged,
	localIdentity,
	hashLocal,
	atomicJSON,
	copySource,
	removeExact,
	listExactFiles
};
