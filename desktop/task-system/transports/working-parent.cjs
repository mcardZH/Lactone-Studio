"use strict";
const path = require("node:path");
const { isMissingFile } = require("./file-errors.cjs");
const { sameFile } = require("../execution/common.cjs");

function existingDirectoryRace(error, directory) {
	if (["WORK_DIRECTORY_EXISTS", "EEXIST"].includes(error?.code)) return true;
	return (
		error?.code === "POSIX_CONTROL_FAILED" &&
		error.details?.operation === "mkdirExclusive" &&
		error.details.path === directory &&
		error.details.exitCode === 1 &&
		error.details.stderr === `mkdir: cannot create directory '${directory}': File exists\n`
	);
}
function parentError(error, directory, createdPaths) {
	if (error?.code === "IO_ABORTED") return error;
	let nativeCode = error?.details?.nativeCode || error?.code;
	if (nativeCode === "POSIX_CONTROL_FAILED" && error.details?.exitCode === 1) {
		const details = error.details;
		for (const [suffix, code] of [
			["Permission denied", "EACCES"],
			["Read-only file system", "EROFS"],
			["Not a directory", "ENOTDIR"]
		]) {
			const diagnostics =
				details.operation === "mkdirExclusive"
					? [`mkdir: cannot create directory '${details.path}': ${suffix}\n`]
					: details.operation === "stat"
						? ["stat", "statx"].map((word) => `stat: cannot ${word} '${details.path}': ${suffix}\n`)
						: [];
			if (diagnostics.includes(details.stderr)) nativeCode = code;
		}
	}
	const reason = ["EACCES", "EPERM"].includes(nativeCode)
		? "没有创建或访问工作父目录的权限。"
		: nativeCode === "EROFS"
			? "工作父目录所在文件系统为只读。"
			: ["WORK_PARENT_NOT_DIRECTORY", "ENOTDIR"].includes(nativeCode)
				? "工作父目录路径中存在同名文件或非目录对象。"
				: ["PATH_LINK_REFUSED", "SYMLINK_NOT_ALLOWED", "WORK_PARENT_IDENTITY_CHANGED"].includes(
							nativeCode
					  )
					? "工作父目录路径已变化或包含不允许的链接。"
					: "工作父目录创建或访问失败。";
	return Object.assign(new Error(`${reason}\n${directory}\n${error?.message || String(error)}`), {
		code: "WORK_PARENT_UNAVAILABLE",
		details: {
			path: directory,
			createdPaths: [...createdPaths],
			nativeCode,
			...(error?.details || {})
		}
	});
}
/** Only detection / actual submission call this. Every component uses the transport's link policy. */
async function ensureWorkingParent(
	transport,
	directory,
	io,
	pathApi = transport.kind === "local" ? path : path.posix
) {
	const createdPaths = [];
	try {
		if (typeof directory !== "string" || directory.includes("\0") || !pathApi.isAbsolute(directory))
			throw Object.assign(new Error("ABSOLUTE_WORKING_ROOT_REQUIRED"), {
				code: "ABSOLUTE_WORKING_ROOT_REQUIRED"
			});
		const split = pathApi === path.posix ? /\// : /[\\/]/;
		if (directory.split(split).some((part) => part === "." || part === ".."))
			throw Object.assign(new Error("NON_CANONICAL_PATH"), { code: "NON_CANONICAL_PATH" });
		const normalized = pathApi.normalize(directory),
			root = pathApi.parse(normalized).root;
		let current = root,
			parent = await transport.stat(root, io);
		if (!parent.isDirectory)
			throw Object.assign(new Error("WORK_PARENT_NOT_DIRECTORY"), {
				code: "WORK_PARENT_NOT_DIRECTORY"
			});
		for (const component of normalized.slice(root.length).split(split).filter(Boolean)) {
			const next = pathApi.join(current, component);
			const before = await transport.stat(current, io);
			if (!before.isDirectory || !sameFile(parent, before))
				throw Object.assign(new Error("WORK_PARENT_IDENTITY_CHANGED"), {
					code: "WORK_PARENT_IDENTITY_CHANGED"
				});
			let value;
			try {
				value = await transport.stat(next, io);
			} catch (error) {
				if (!isMissingFile(error, next)) throw error;
				try {
					await transport.mkdirExclusive(next, io);
					createdPaths.push(next);
				} catch (creationError) {
					if (!existingDirectoryRace(creationError, next)) throw creationError;
				}
				value = await transport.stat(next, io);
			}
			if (!value.isDirectory)
				throw Object.assign(new Error("WORK_PARENT_NOT_DIRECTORY"), {
					code: "WORK_PARENT_NOT_DIRECTORY"
				});
			const after = await transport.stat(current, io);
			if (!after.isDirectory || !sameFile(before, after))
				throw Object.assign(new Error("WORK_PARENT_IDENTITY_CHANGED"), {
					code: "WORK_PARENT_IDENTITY_CHANGED"
				});
			current = next;
			parent = value;
		}
		const final = await transport.stat(normalized, io);
		if (!final.isDirectory || !sameFile(parent, final))
			throw Object.assign(new Error("WORK_PARENT_IDENTITY_CHANGED"), {
				code: "WORK_PARENT_IDENTITY_CHANGED"
			});
		return { path: directory, createdPaths, identity: final };
	} catch (error) {
		throw parentError(error, directory, createdPaths);
	}
}
module.exports = { ensureWorkingParent };
