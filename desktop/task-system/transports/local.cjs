"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn: systemSpawn } = require("node:child_process");
const { verifiedChunks, writeStream } = require("../execution/sources.cjs");
const { fileControlDetails, fileObservationDetails } = require("./file-errors.cjs");
const {
	fail,
	sha256,
	requireText,
	abort,
	checkRange,
	sameFile,
	unchanged
} = require("../execution/common.cjs");
function createLocalTransport({
	environmentId,
	spawn = systemSpawn,
	now = () => new Date().toISOString(),
	maxControlBytes = 8 * 1024 * 1024
} = {}) {
	requireText(environmentId, "ENVIRONMENT");
	let disposed = false;
	const controls = new Set();
	function admit(io) {
		if (disposed) fail("TRANSPORT_DISPOSED");
		abort(io?.signal);
	}
	async function lstat(file, options) {
		try {
			return await fs.lstat(file, options);
		} catch (error) {
			const details = {
				...fileControlDetails(
					{ operation: "stat", path: file },
					{ stderr: Buffer.from(error.message || ""), exitCode: null }
				),
				nativeCode: error.code || null
			};
			if (error.code === "ENOENT") fail("FILE_NOT_FOUND", { ...details, missing: true });
			error.details = details;
			throw error;
		}
	}
	async function stat(file, io) {
		admit(io);
		if (!path.isAbsolute(file)) fail("ABSOLUTE_PATH_REQUIRED");
		if (/(^|[\\/])\.\.?([\\/]|$)/.test(file)) fail("NON_CANONICAL_PATH");
		let ancestor = path.dirname(file);
		while (true) {
			const info = await lstat(ancestor);
			if (info.isSymbolicLink()) fail("PATH_LINK_REFUSED");
			const parent = path.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const value = await lstat(file, { bigint: true });
		if (value.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED");
		if (value.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("BYTE_SIZE_UNSUPPORTED");
		return {
			environmentId,
			path: file,
			fileId: `${value.dev}:${value.ino}`,
			byteSize: Number(value.size),
			modifiedAt: value.mtime.toISOString(),
			changeToken: `${value.mtimeNs}:${value.ctimeNs}`,
			checkedAt: now(),
			verification: "verified",
			isDirectory: value.isDirectory(),
			isRegularFile: value.isFile()
		};
	}
	async function listDirectory({ path: directory, identity }, io) {
		const before = await stat(directory, io);
		if (!before.isDirectory || !sameFile(identity, before)) fail("DIRECTORY_IDENTITY_CHANGED");
		const entries = (await fs.readdir(directory, { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				kind: entry.isSymbolicLink()
					? "link"
					: entry.isFile()
						? "file"
						: entry.isDirectory()
							? "directory"
							: "other"
			})),
			after = await stat(directory, io);
		if (!unchanged(before, after)) fail("DIRECTORY_CHANGED_DURING_LIST");
		return { before, after, entries };
	}
	async function readRange({ path: file, identity, offset, length }, io) {
		admit(io);
		checkRange(offset, length);
		const before = await stat(file, io);
		if (!before.isRegularFile) fail("NON_REGULAR_FILE_UNSUPPORTED");
		if (!sameFile(identity, before) || before.byteSize < offset + length)
			fail(
				"FILE_IDENTITY_CHANGED",
				fileObservationDetails({
					operation: "readRange",
					phase: "preflight",
					path: file,
					requestedIdentity: identity,
					before,
					after: null,
					range: { offset, length }
				})
			);
		const handle = await fs.open(file, "r");
		let bytes;
		try {
			bytes = Buffer.alloc(length);
			let consumed = 0;
			while (consumed < length) {
				admit(io);
				const result = await handle.read(bytes, consumed, length - consumed, offset + consumed);
				if (!result.bytesRead) break;
				consumed += result.bytesRead;
			}
			bytes = bytes.subarray(0, consumed);
		} finally {
			await handle.close();
		}
		const after = await stat(file, io);
		if (!sameFile(before, after) || bytes.length !== length || !unchanged(before, after))
			fail(
				"FILE_CHANGED_DURING_READ",
				fileObservationDetails({
					operation: "readRange",
					phase: "postflight",
					path: file,
					requestedIdentity: identity,
					before,
					after,
					range: { offset, length }
				})
			);
		return { bytes, offset, length: bytes.length, before, after, sha256: sha256(bytes) };
	}
	// One bounded observation of a growing OUT. Static readRange/hash stay strict.
	async function readObservedRange({ path: file, identity, offset, length, previousPrefix }, io) {
		admit(io); checkRange(offset, length);
		const before = await stat(file, io);
		if (!before.isRegularFile || identity && !sameFile(identity, before) || before.byteSize < offset + length)
			fail("FILE_IDENTITY_CHANGED", { operation: "readObservedRange", path: file, before });
		if (previousPrefix && (!Number.isSafeInteger(previousPrefix.end) || previousPrefix.end < 0 || previousPrefix.end > before.byteSize || !/^[a-f0-9]{64}$/.test(previousPrefix.sha256))) fail("INVALID_PREFIX_PROOF");
		const handle = await fs.open(file, "r");
		try {
			const opened = await handle.stat({ bigint: true });
			if (`${opened.dev}:${opened.ino}` !== before.fileId) fail("FILE_IDENTITY_CHANGED");
			let prefix;
			const bytes = Buffer.alloc(length);
			for (let done = 0; done < length;) {
				admit(io); const read = await handle.read(bytes, done, length - done, offset + done);
				if (!read.bytesRead) fail("OBSERVED_RANGE_SHORT_READ"); done += read.bytesRead;
			}
			// Prove the old consumed bytes after obtaining the new range, so an
			// in-place rewrite during that read cannot pass as a normal append.
			if (previousPrefix) {
				const digest = crypto.createHash("sha256");
				for (let at = 0; at < previousPrefix.end;) {
					admit(io); const buffer = Buffer.alloc(Math.min(1024 * 1024, previousPrefix.end - at));
					const read = await handle.read(buffer, 0, buffer.length, at);
					if (!read.bytesRead) fail("OBSERVED_RANGE_SHORT_READ");
					digest.update(buffer.subarray(0, read.bytesRead)); at += read.bytesRead;
				}
				prefix = { end: previousPrefix.end, sha256: digest.digest("hex") };
			}
			const after = await stat(file, io);
			if (!sameFile(before, after) || after.byteSize < before.byteSize || after.byteSize < offset + length || after.byteSize === before.byteSize && !unchanged(before, after)) fail("OBSERVED_SOURCE_CHANGED", { operation: "readObservedRange", path: file, before, after });
			admit(io);
			return { before, after, offset, length, bytes, sha256: sha256(bytes), observedEnd: offset + length, ...(prefix ? { previousPrefix: prefix } : {}) };
		} finally { await handle.close(); }
	}
	async function hash({ path: file, identity, algorithm, range }, io) {
		admit(io);
		if (algorithm !== "sha256") fail("UNSUPPORTED_HASH");
		const before = await stat(file, io);
		if (!before.isRegularFile) fail("NON_REGULAR_FILE_UNSUPPORTED");
		if (!sameFile(identity, before))
			fail(
				"FILE_IDENTITY_CHANGED",
				fileObservationDetails({
					operation: "hash",
					phase: "preflight",
					path: file,
					requestedIdentity: identity,
					before,
					after: null,
					range
				})
			);
		if (range) {
			checkRange(range.offset, 0);
			if (
				!Number.isSafeInteger(range.length) ||
				range.length < 0 ||
				range.offset + range.length > before.byteSize
			)
				fail("INVALID_BYTE_RANGE");
		}
		const digest = crypto.createHash("sha256");
		const handle = await fs.open(file, "r");
		try {
			if (!range || range.length)
				for await (const chunk of handle.createReadStream({
					autoClose: false,
					...(range ? { start: range.offset, end: range.offset + range.length - 1 } : {})
				})) {
					abort(io?.signal);
					digest.update(chunk);
				}
		} finally {
			await handle.close();
		}
		const after = await stat(file, io);
		if (!unchanged(before, after))
			fail(
				"FILE_CHANGED_DURING_HASH",
				fileObservationDetails({
					operation: "hash",
					phase: "postflight",
					path: file,
					requestedIdentity: identity,
					before,
					after,
					range
				})
			);
		return { algorithm, hash: digest.digest("hex"), identity: after, ...(range ? { range } : {}) };
	}
	async function putAtomic(
		{ path: file, expectedAbsent, source, byteSize, sha256: expectedHash },
		io
	) {
		admit(io);
		if (!path.isAbsolute(file) || expectedAbsent !== true) fail("EXCLUSIVE_UPLOAD_REQUIRED");
		const parentIdentity = await stat(path.dirname(file), io);
		if (!parentIdentity.isDirectory) fail("UPLOAD_PARENT_NOT_DIRECTORY");
		if (
			!Number.isSafeInteger(byteSize) ||
			byteSize < 0 ||
			!/^[a-f0-9]{64}$/.test(expectedHash || "")
		)
			fail("UPLOAD_CONTENT_IDENTITY_REQUIRED");
		const temporary = `${file}.candidate-${crypto.randomUUID()}`;
		let created = false;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			created = true;
			try {
				for await (const bytes of verifiedChunks(source, { byteSize, sha256: expectedHash }, io)) {
					let offset = 0;
					while (offset < bytes.length) {
						const result = await handle.write(bytes, offset, bytes.length - offset);
						if (!result.bytesWritten) fail("UPLOAD_SHORT_WRITE");
						offset += result.bytesWritten;
					}
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
			abort(io?.signal);
			await fs.link(temporary, file); // Atomic, no-replace publication on the same filesystem.
		} finally {
			if (created) await fs.unlink(temporary).catch(() => {});
		}
		const identity = await stat(file, io);
		const verified = await hash({ path: file, identity, algorithm: "sha256" }, io);
		if (verified.hash !== expectedHash) fail("UPLOAD_VERIFICATION_FAILED");
		return { path: file, byteSize, sha256: expectedHash, identity: verified.identity };
	}
	async function removeFile({ path: file, identity, sha256: expectedHash, scopeRoot }, io) {
		admit(io);
		if (
			!path.isAbsolute(file) ||
			!path.isAbsolute(scopeRoot) ||
			!/^[a-f0-9]{64}$/.test(expectedHash || "")
		)
			fail("EXACT_CLEANUP_PRECONDITIONS_REQUIRED");
		const root = path.resolve(scopeRoot),
			target = path.resolve(file),
			relative = path.relative(root, target);
		if (
			!relative ||
			relative.startsWith(`..${path.sep}`) ||
			relative === ".." ||
			path.isAbsolute(relative)
		)
			fail("CLEANUP_OUTSIDE_SCOPE");
		let parent = path.dirname(target);
		while (true) {
			const info = await fs.lstat(parent);
			if (info.isSymbolicLink() || !info.isDirectory()) fail("CLEANUP_LINK_REFUSED");
			if (parent === root) break;
			const next = path.dirname(parent);
			if (next === parent) fail("CLEANUP_OUTSIDE_SCOPE");
			parent = next;
		}
		const before = await stat(target, io);
		if (!unchanged(identity, before) || before.isDirectory) fail("CLEANUP_IDENTITY_CHANGED");
		const verified = await hash({ path: target, identity: before, algorithm: "sha256" }, io);
		if (verified.hash !== expectedHash) fail("CLEANUP_HASH_CHANGED");
		const final = await stat(target, io);
		if (!unchanged(before, final)) fail("CLEANUP_IDENTITY_CHANGED");
		abort(io?.signal);
		await fs.unlink(target);
		return {
			path: target,
			removed: true,
			evidenceRefs: [`${environmentId}:${target}:sha256:${expectedHash}`]
		};
	}
	async function exec(command, io) {
		admit(io);
		requireText(command.executable, "EXECUTABLE");
		if (!Array.isArray(command.args) || !path.isAbsolute(command.cwd)) fail("INVALID_COMMAND");
		command.args.forEach((value) => {
			if (typeof value !== "string" || value.includes("\0")) fail("INVALID_ARGUMENT");
		});
		return new Promise((resolve, reject) => {
			let child,
				stdout = [],
				stderr = [],
				total = 0,
				feeding = Promise.resolve(),
				error,
				out,
				err;
			const onAbort = () => {
				error ||= Object.assign(new Error("IO_ABORTED"), { code: "IO_ABORTED" });
				child?.kill();
			};
			// Data consumers parse synchronously and never retain an unbounded control
			// Buffer. Stderr and ordinary command receipts remain strictly bounded.
			const collect = (target, sink) => (chunk) => {
				if (error) return;
				const bytes = Buffer.from(chunk);
				if (sink) {
					try { abort(io?.signal); sink(bytes); }
					catch (value) { error ||= value; child.kill(); }
					return;
				}
				total += bytes.length;
				if (total > maxControlBytes) {
					error ||= Object.assign(new Error("CONTROL_OUTPUT_LIMIT"), {
						code: "CONTROL_OUTPUT_LIMIT"
					});
					child.kill();
				} else target.push(bytes);
			};
			(async () => {
				try {
					if (command.stdoutPath) out = await fs.open(command.stdoutPath, "wx", 0o600);
					if (command.stderrPath) err = await fs.open(command.stderrPath, "wx", 0o600);
					child = spawn(command.executable, command.args, {
						cwd: command.cwd,
						env: { ...process.env, ...command.env },
						shell: false,
						windowsHide: true,
						stdio: ["pipe", out ? out.fd : "pipe", err ? err.fd : "pipe"]
					});
					controls.add(child);
					io?.signal?.addEventListener("abort", onAbort, { once: true });
					child.stdout?.on("data", collect(stdout, io?.stdoutSink));
					child.stderr?.on("data", collect(stderr));
					child.on("error", (value) => {
						error ||= value;
					});
					child.stdin?.on("error", (value) => {
						error ||= value;
					});
					child.on("close", async (exitCode, signal) => {
						await feeding.catch(() => {});
						controls.delete(child);
						io?.signal?.removeEventListener("abort", onAbort);
						await Promise.all([out?.close(), err?.close()]);
						if (error) reject(error);
						else
							resolve({
								exitCode,
								signal,
								stdout: Buffer.concat(stdout),
								stderr: Buffer.concat(stderr),
								evidenceRefs: []
							});
					});
					if (child.stdin)
						feeding = writeStream(child.stdin, command.stdin || Buffer.alloc(0), io).catch(
							(value) => {
								error ||= value;
								child.stdin.destroy();
								child.kill();
							}
						);
				} catch (value) {
					await Promise.all([out?.close(), err?.close()]);
					reject(value);
				}
			})();
		});
	}
	return {
		kind: "local",
		capabilities: async () => ({
			supported: [
				"exec",
				"stat",
				"read-range",
				"sha256",
				"exclusive-upload",
				"exclusive-directory",
				"exact-remove-file",
				"directory-list"
			],
			unavailable: [],
			unverified: []
		}),
		exec,
		stat,
		listDirectory,
		readRange,
		readObservedRange,
		hash,
		putAtomic,
		removeFile,
		async mkdirExclusive(directory, io) {
			admit(io);
			if (!path.isAbsolute(directory)) fail("ABSOLUTE_PATH_REQUIRED");
			const parent = await stat(path.dirname(directory), io);
			if (!parent.isDirectory) fail("WORK_PARENT_NOT_DIRECTORY");
			try {
				await fs.mkdir(directory, { mode: 0o700 });
				return { path: directory, created: true, evidenceRefs: [] };
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				fail("WORK_DIRECTORY_EXISTS");
			}
		},
		async dispose() {
			disposed = true;
			for (const child of controls) child.kill();
		}
	};
}
module.exports = { createLocalTransport };
