"use strict";
const path = require("node:path");
const { fail } = require("./platform/global-settings.cjs");
/** A request-owned browser: no directory creation, script execution, or persistent transport. */
async function browseEnvironment(
	input,
	{ chooseDirectory, chooseFile, openTransport, signal } = {}
) {
	const local = input.purpose === "private-key" || input.environment.connectionKind === "local";
	if (local) {
		const selected = await (input.mode === "directory" ? chooseDirectory : chooseFile)?.({
			purpose: input.purpose,
			path: input.path,
			mode: input.mode
		});
		if (!selected) return null;
		return { domain: "local", path: selected, entries: [], selected };
	}
	const environment = input.environment;
	if (
		environment.connectionKind === "wsl"
			? !environment.distribution?.trim() || !environment.user?.trim()
			: environment.connectionKind !== "ssh" ||
				!environment.host?.trim() ||
				!environment.user?.trim() ||
				!Number.isInteger(environment.port) ||
				environment.port < 1 ||
				environment.port > 65535
	)
		throw fail("BROWSE_CONNECTION_REQUIRED");
	const directory = input.path || environment.workingRoot || "/";
	if (!path.posix.isAbsolute(directory) || directory.includes("\0"))
		throw fail("ABSOLUTE_BROWSE_PATH_REQUIRED");
	const transport = await openTransport(environment, input.secret);
	try {
		const identity = await transport.stat(directory, { signal });
		if (identity.isRegularFile && input.mode === "file")
			return {
				domain: environment.connectionKind,
				path: path.posix.dirname(directory),
				parentPath: path.posix.dirname(path.posix.dirname(directory)),
				entries: [],
				selected: directory
			};
		if (!identity.isDirectory) throw fail("BROWSE_DIRECTORY_REQUIRED");
		const result = await transport.listDirectory({ path: directory, identity }, { signal });
		const entries = Array.isArray(result) ? result : result.entries;
		return {
			domain: environment.connectionKind,
			path: directory,
			parentPath: directory === "/" ? undefined : path.posix.dirname(directory),
			entries: (entries || [])
				.filter((entry) => input.mode !== "directory" || entry.kind === "directory")
				.sort((a, b) => a.name.localeCompare(b.name))
		};
	} finally {
		await transport.dispose();
	}
}
module.exports = { browseEnvironment };
