"use strict";
const crypto = require("node:crypto");
const nodePath = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { verifiedChunks } = require("../execution/sources.cjs");
const {
	fileControlDetails,
	exactStatMissing,
	fileObservationDetails
} = require("./file-errors.cjs");
const {
	fail,
	sha256,
	quote,
	abort,
	checkRange,
	sameFile,
	unchanged
} = require("../execution/common.cjs");
function absolute(file) {
	if (typeof file !== "string" || !file.startsWith("/") || file.includes("\0"))
		fail("ABSOLUTE_POSIX_PATH_REQUIRED");
	return file;
}
function commandScript(command) {
	const environment = Object.entries(command.env || {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail("INVALID_ENVIRONMENT_KEY");
		return `${key}=${quote(String(value))}`;
	});
	let line = `cd -- ${quote(absolute(command.cwd))} && exec env ${environment.join(" ")} ${quote(command.executable)} ${(command.args || []).map(quote).join(" ")}`;
	if (command.stdoutPath) line += ` > ${quote(absolute(command.stdoutPath))}`;
	if (command.stderrPath) line += ` 2> ${quote(absolute(command.stderrPath))}`;
	return line;
}
/** A byte-safe filesystem facade over an injected short control-command channel. */
function createPosixTransport({
	kind,
	environmentId,
	control,
	dispose = async () => {},
	now = () => new Date().toISOString()
}) {
	async function shell(script, stdin, io, context) {
		abort(io?.signal);
		const result = await control(script, stdin, io);
		if (result.exitCode !== 0) {
			const details = fileControlDetails(context, result);
			if (exactStatMissing(context, result)) fail("FILE_NOT_FOUND", { ...details, missing: true });
			fail("POSIX_CONTROL_FAILED", details);
		}
		return result;
	}
	async function stat(file, io) {
		absolute(file);
		if (/(^|\/)\.\.?(\/|$)/.test(file)) fail("NON_CANONICAL_PATH");
		const checks = [];
		let ancestor = file;
		while (true) {
			checks.push(`test ! -L ${quote(ancestor)}`);
			const parent = nodePath.posix.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const result = await shell(
			`${checks.join(" && ")} && TZ=UTC LC_ALL=C stat -Lc '%d:%i|%s|%y|%z|%f' -- ${quote(file)}`,
			undefined,
			io,
			{ operation: "stat", path: file }
		);
		const [fileId, size, mtime, ctime, mode] = Buffer.from(result.stdout)
			.toString("utf8")
			.trim()
			.split("|");
		if (!/^\d+:\d+$/.test(fileId) || !/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)))
			fail("INVALID_STAT_RECEIPT");
		return {
			environmentId,
			path: file,
			fileId,
			byteSize: Number(size),
			modifiedAt: mtime,
			changeToken: ctime,
			mode,
			isDirectory: (parseInt(mode, 16) & 0xf000) === 0x4000,
			isRegularFile: (parseInt(mode, 16) & 0xf000) === 0x8000,
			checkedAt: now(),
			verification: "verified"
		};
	}
	async function listDirectory({ path: directory, identity }, io) {
		const before = await stat(directory, io);
		if (!before.isDirectory || !sameFile(identity, before)) fail("DIRECTORY_IDENTITY_CHANGED");
		const entries = [], decoder = new StringDecoder("utf8");
		let pending = "", name = null, streamed = false;
		const consume = (bytes) => {
			streamed = true;
			pending += decoder.write(bytes);
			let at;
			while ((at = pending.indexOf("\0")) >= 0) {
				const field = pending.slice(0, at); pending = pending.slice(at + 1);
				if (name === null) { name = field; continue; }
				const kind = field;
				entries.push({
					name,
					kind: name.includes("\ufffd")
						? "other"
						: kind === "f"
							? "file"
							: kind === "d"
								? "directory"
								: kind === "l"
									? "link"
									: "other"
				});
				name = null;
			}
		};
		const result = await shell(
			`find -P ${quote(directory)} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0'`,
			undefined, { ...io, stdoutSink: consume }, { operation: "listDirectory", path: directory }
		);
		// Injected legacy test/control channels may return a bounded receipt.
		if (!streamed && result.stdout?.length) consume(Buffer.from(result.stdout));
		pending += decoder.end();
		if (pending || name !== null) fail("DIRECTORY_LIST_RECEIPT_INVALID");
		const after = await stat(directory, io);
		if (!unchanged(before, after)) fail("DIRECTORY_CHANGED_DURING_LIST");
		return { before, after, entries };
	}
	async function readRange({ path, identity, offset, length }, io) {
		checkRange(offset, length);
		const before = await stat(path, io);
		if (!before.isRegularFile) fail("NON_REGULAR_FILE_UNSUPPORTED");
		if (!sameFile(identity, before) || before.byteSize < offset + length)
			fail(
				"FILE_IDENTITY_CHANGED",
				fileObservationDetails({
					operation: "readRange",
					phase: "preflight",
					path,
					requestedIdentity: identity,
					before,
					after: null,
					range: { offset, length }
				})
			);
		const bytes = Buffer.alloc(length);
		let consumed = 0, streamed = false;
		const consume = (chunk) => {
			streamed = true;
			if (consumed + chunk.length > length) fail("INVALID_RANGE_RECEIPT");
			chunk.copy(bytes, consumed); consumed += chunk.length;
		};
		const result = await shell(
			`dd if=${quote(path)} iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`,
			undefined,
			{ ...io, stdoutSink: consume },
			{ operation: "readRange", path }
		);
		if (!streamed && result.stdout?.length) consume(Buffer.from(result.stdout));
		const after = await stat(path, io);
		if (consumed !== length || !unchanged(before, after))
			fail(
				"FILE_CHANGED_DURING_READ",
				fileObservationDetails({
					operation: "readRange",
					phase: "postflight",
					path,
					requestedIdentity: identity,
					before,
					after,
					range: { offset, length }
				})
			);
		return { bytes, offset, length, before, after, sha256: sha256(bytes) };
	}
	async function hash({ path, identity, algorithm, range }, io) {
		if (algorithm !== "sha256") fail("UNSUPPORTED_HASH");
		const before = await stat(path, io);
		if (!before.isRegularFile) fail("NON_REGULAR_FILE_UNSUPPORTED");
		if (!sameFile(identity, before))
			fail(
				"FILE_IDENTITY_CHANGED",
				fileObservationDetails({
					operation: "hash",
					phase: "preflight",
					path,
					requestedIdentity: identity,
					before,
					after: null,
					range
				})
			);
		if (
			range &&
			(!Number.isSafeInteger(range.offset) ||
				!Number.isSafeInteger(range.length) ||
				range.offset < 0 ||
				range.length < 0 ||
				range.offset + range.length > before.byteSize)
		)
			fail("INVALID_BYTE_RANGE");
		const script = range
			? `set -o pipefail; dd if=${quote(path)} iflag=skip_bytes,count_bytes skip=${range.offset} count=${range.length} status=none | sha256sum`
			: `sha256sum -- ${quote(path)}`;
		const result = await shell(script, undefined, io, { operation: "hash", path });
		const digest = Buffer.from(result.stdout)
			.toString("ascii")
			.match(/^([a-f0-9]{64})\s/);
		if (!digest) fail("INVALID_HASH_RECEIPT");
		const after = await stat(path, io);
		if (!unchanged(before, after))
			fail(
				"FILE_CHANGED_DURING_HASH",
				fileObservationDetails({
					operation: "hash",
					phase: "postflight",
					path,
					requestedIdentity: identity,
					before,
					after,
					range
				})
			);
		return { algorithm, hash: digest[1], identity: after, ...(range ? { range } : {}) };
	}
	async function readObservedRange({ path: file, identity, offset, length, previousPrefix }, io) {
		absolute(file); checkRange(offset, length);
		if (/(^|\/)\.\.?(\/|$)/.test(file)) fail("NON_CANONICAL_PATH");
		if (length > 4 * 1024 * 1024) fail("OBSERVED_RANGE_LIMIT");
		if (previousPrefix && (!Number.isSafeInteger(previousPrefix.end) || previousPrefix.end < 0 || !/^[a-f0-9]{64}$/.test(previousPrefix.sha256))) fail("INVALID_PREFIX_PROOF");
		const checks=[];let ancestor=file;
		while(true){checks.push(`test ! -L ${quote(ancestor)}`);const parent=nodePath.posix.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
		// A single control channel carries metadata, optional whole consumed-prefix
		// proof, and the exact binary range. No per-parser-chunk SSH/stat/hash calls.
		const format="%d:%i|%s|%y|%z|%f";
		const script=[
			'set -e; set -o pipefail', checks.join(' && '), `exec 3< ${quote(file)}`,
			`before=$(TZ=UTC LC_ALL=C stat -Lc '${format}' -- /proc/$$/fd/3)`,
			'printf \'%s\\n\' "$before"',
			`dd if=/proc/$$/fd/3 iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`,
			previousPrefix ? `dd if=/proc/$$/fd/3 iflag=count_bytes count=${previousPrefix.end} status=none | sha256sum` : "printf '\\n'",
			checks.join(' && '),
			`TZ=UTC LC_ALL=C stat -Lc '${format}' -- ${quote(file)}`
		].join('\n');
		const result=await shell(script,undefined,io,{operation:'readObservedRange',path:file}), raw=Buffer.from(result.stdout);
		const first=raw.indexOf(10),second=raw.indexOf(10,first+1+length);
		if(first<0||second<0||raw.length<first+1+length)fail('INVALID_OBSERVED_RANGE_RECEIPT');
		const parse=text=>{const [fileId,size,modifiedAt,changeToken,mode]=text.trim().split('|');if(!/^\d+:\d+$/.test(fileId)||!/^\d+$/.test(size)||!Number.isSafeInteger(Number(size)))fail('INVALID_STAT_RECEIPT');return {environmentId,path:file,fileId,byteSize:Number(size),modifiedAt,changeToken,mode,isDirectory:(parseInt(mode,16)&0xf000)===0x4000,isRegularFile:(parseInt(mode,16)&0xf000)===0x8000,checkedAt:now(),verification:'verified'};};
		const before=parse(raw.subarray(0,first).toString('utf8')),after=parse(raw.subarray(second+1).toString('utf8')),bytes=raw.subarray(first+1,first+1+length);
		if(!before.isRegularFile||identity&&!sameFile(identity,before)||!sameFile(before,after)||before.byteSize<offset+length||after.byteSize<before.byteSize||after.byteSize===before.byteSize&&!unchanged(before,after))fail('OBSERVED_SOURCE_CHANGED',{operation:'readObservedRange',path:file,before,after});
		let prefix;if(previousPrefix){const digest=raw.subarray(first+1+length,second).toString('ascii').match(/^([a-f0-9]{64})\s/);if(!digest||previousPrefix.end>before.byteSize)fail('INVALID_PREFIX_PROOF');prefix={end:previousPrefix.end,sha256:digest[1]};}
		return {before,after,offset,length,bytes,sha256:sha256(bytes),observedEnd:offset+length,...(prefix?{previousPrefix:prefix}:{})};
	}
	async function putAtomic({ path, expectedAbsent, source, byteSize, sha256: expectedHash }, io) {
		absolute(path);
		if (expectedAbsent !== true) fail("EXCLUSIVE_UPLOAD_REQUIRED");
		if (
			!Number.isSafeInteger(byteSize) ||
			byteSize < 0 ||
			!/^[a-f0-9]{64}$/.test(expectedHash || "")
		)
			fail("UPLOAD_CONTENT_IDENTITY_REQUIRED");
		const parent = await stat(nodePath.posix.dirname(path), io);
		if (!parent.isDirectory) fail("UPLOAD_PARENT_NOT_DIRECTORY");
		const temporary = `${path}.candidate-${crypto.randomUUID()}`;
		await shell(
			`umask 077; set -C; cat > ${quote(temporary)} && sync -- ${quote(temporary)}`,
			verifiedChunks(source, { byteSize, sha256: expectedHash }, io),
			io,
			{ operation: "upload", path }
		);
		// Publication is a separate acknowledged step, never triggered by an aborted upload EOF.
		await shell(
			`test "$(stat -Lc %s -- ${quote(temporary)})" = ${quote(String(byteSize))} && test "$(sha256sum -- ${quote(temporary)} | cut -d ' ' -f 1)" = ${quote(expectedHash)} && ln -- ${quote(temporary)} ${quote(path)}; result=$?; rm -f -- ${quote(temporary)}; exit "$result"`,
			undefined,
			io,
			{ operation: "publishUpload", path }
		);
		const identity = await stat(path, io);
		const verified = await hash({ path, identity, algorithm: "sha256" }, io);
		if (verified.hash !== expectedHash) fail("UPLOAD_VERIFICATION_FAILED");
		return { path, byteSize, sha256: expectedHash, identity: verified.identity };
	}
	async function removeFile({ path, identity, sha256: expectedHash, scopeRoot }, io) {
		absolute(path);
		absolute(scopeRoot);
		const root = nodePath.posix.normalize(scopeRoot),
			target = nodePath.posix.normalize(path),
			relative = nodePath.posix.relative(root, target);
		if (
			!relative ||
			relative === ".." ||
			relative.startsWith("../") ||
			nodePath.posix.isAbsolute(relative) ||
			!/^[a-f0-9]{64}$/.test(expectedHash || "")
		)
			fail("CLEANUP_OUTSIDE_SCOPE");
		const parts = relative.split("/");
		let parent = root;
		const checks = [`test ! -L ${quote(root)}`];
		for (const part of parts) {
			parent = nodePath.posix.join(parent, part);
			checks.push(`test ! -L ${quote(parent)}`);
		}
		await shell(checks.join(" && "), undefined, io, {
			operation: "removeFile-preflight",
			path: target
		});
		const before = await stat(target, io);
		if (!unchanged(identity, before)) fail("CLEANUP_IDENTITY_CHANGED");
		const verified = await hash({ path: target, identity: before, algorithm: "sha256" }, io);
		if (verified.hash !== expectedHash) fail("CLEANUP_HASH_CHANGED");
		const final = await stat(target, io);
		if (!unchanged(before, final)) fail("CLEANUP_IDENTITY_CHANGED");
		await shell(
			`${checks.join(" && ")} && test -f ${quote(target)} && test "$(TZ=UTC LC_ALL=C stat -Lc '%d:%i|%s|%y|%z' -- ${quote(target)})" = ${quote(`${before.fileId}|${before.byteSize}|${before.modifiedAt}|${before.changeToken}`)} && test "$(sha256sum -- ${quote(target)} | cut -d ' ' -f 1)" = ${quote(expectedHash)} && rm -- ${quote(target)}`,
			undefined,
			io,
			{ operation: "removeFile", path: target }
		);
		return {
			path: target,
			removed: true,
			evidenceRefs: [`${environmentId}:${target}:sha256:${expectedHash}`]
		};
	}
	return {
		kind,
		stat,
		listDirectory,
		readRange,
		readObservedRange,
		hash,
		putAtomic,
		removeFile,
		capabilities: async (io) => {
			await shell(
				"command -v bash stat dd sha256sum ln setsid nohup sync ps awk sed cp cut date sleep rm find >/dev/null && test -r /proc/sys/kernel/random/boot_id",
				undefined,
				io,
				{ operation: "capabilities" }
			);
			return {
				supported: [
					"exec",
					"stat",
					"read-range",
					"sha256",
					"exclusive-upload",
					"exclusive-directory",
					"linux-process-identity",
					"exact-remove-file",
					"directory-list"
				],
				unavailable: [],
				unverified: []
			};
		},
		exec: (command, io) => control(commandScript(command), command.stdin, io),
		async mkdirExclusive(path, io) {
			absolute(path);
			const parent = await stat(nodePath.posix.dirname(path), io);
			if (!parent.isDirectory) fail("WORK_PARENT_NOT_DIRECTORY");
			await shell(`umask 077; LC_ALL=C mkdir -- ${quote(path)}`, undefined, io, {
				operation: "mkdirExclusive",
				path
			});
			return { path, created: true, evidenceRefs: [] };
		},
		dispose
	};
}
module.exports = { createPosixTransport, commandScript, absolute };
