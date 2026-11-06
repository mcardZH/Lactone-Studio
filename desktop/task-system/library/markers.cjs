"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { noLinks, fail } = require("../platform/global-settings.cjs");
const CAPABILITIES = Object.freeze([
	"es:task-marker-v1",
	"es:task-multigroup-v1",
	"es:task-source-only-v1",
	"es:task-logical-recycle-v1",
	"es:task-postprocess-cache-v1",
	"es:task-environment-sites-v1",
	"es:task-editable-script-v1"
]);
const MAX_MARKER_BYTES = 128 * 1024;
function relativePath(value) {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		/^[A-Za-z]:/.test(value) ||
		path.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		value.split(/[\\/]/).some((part) => part === "..")
	)
		throw fail("TASK_MARKER_RELATIVE_PATH_REQUIRED");
	return value;
}
function validateMarker(value) {
	if (!value || Array.isArray(value) || value.version !== 1)
		throw fail("TASK_MARKER_VERSION_UNSUPPORTED");
	for (const field of ["id", "name", "date", "note"])
		if (value[field] !== undefined && typeof value[field] !== "string")
			throw fail("TASK_MARKER_FIELD_INVALID", field);
	if (value.main !== undefined && value.main !== null && value.main !== "")
		relativePath(value.main);
	if (value.requiredCapabilities?.some((cap) => !CAPABILITIES.includes(cap)))
		throw fail("TASK_MARKER_CAPABILITY_UNSUPPORTED");
	if (value.management) {
		const m = value.management;
		if (
			!Number.isSafeInteger(m.revision) ||
			m.revision < 1 ||
			typeof m.changeId !== "string" ||
			!m.changeId ||
			!(m.parentChangeId === null || typeof m.parentChangeId === "string") ||
			typeof m.recycled !== "boolean"
		)
			throw fail("TASK_MARKER_MANAGEMENT_INVALID");
	}
	if (
		value.remote &&
		(typeof value.remote.host !== "string" ||
			typeof value.remote.dir !== "string" ||
			(value.remote.user !== undefined && typeof value.remote.user !== "string"))
	)
		throw fail("TASK_MARKER_REMOTE_INVALID");
	// Credentials and executable content have no place in a portable locator.
	for (const field of ["password", "privateKey", "privateKeyContent", "token", "script", "pid"])
		if (Object.hasOwn(value, field) || (value.remote && Object.hasOwn(value.remote, field)))
			throw fail("TASK_MARKER_SECRET_OR_EXECUTION_FIELD", field);
	function inspect(object) {
		if (!object || typeof object !== "object") return;
		for (const [key, child] of Object.entries(object)) {
			if (
				/^(password|passphrase|privatekey|privatekeycontent|token|credentials|authorization)$/i.test(
					key
				)
			)
				throw fail("TASK_MARKER_SECRET_OR_EXECUTION_FIELD", key);
			inspect(child);
		}
	}
	inspect(value);
	return value;
}
function readMarker(file) {
	noLinks(file);
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.size > MAX_MARKER_BYTES)
		throw fail("TASK_MARKER_SIZE_OR_KIND_INVALID");
	const bytes = fs.readFileSync(file);
	let value;
	try {
		value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw fail("TASK_MARKER_JSON_INVALID");
	}
	return {
		file: path.resolve(file),
		value: validateMarker(value),
		identity: crypto.createHash("sha256").update(bytes).digest("hex")
	};
}
function writeMarker(file, value, expectedIdentity) {
	validateMarker(value);
	noLinks(file);
	const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
	if (bytes.length > MAX_MARKER_BYTES) throw fail("TASK_MARKER_TOO_LARGE");
	const current = fs.existsSync(file) ? readMarker(file) : null;
	if (
		(expectedIdentity === null && current) ||
		(typeof expectedIdentity === "string" && current?.identity !== expectedIdentity)
	)
		throw fail("TASK_MARKER_CHANGED");
	const candidate = file + ".candidate-" + crypto.randomUUID();
	const fd = fs.openSync(candidate, "wx", 0o600);
	try {
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (current && readMarker(file).identity !== current.identity) throw fail("TASK_MARKER_CHANGED");
	if (!current) {
		fs.linkSync(candidate, file);
		fs.unlinkSync(candidate);
	} else fs.renameSync(candidate, file);
	return readMarker(file);
}
function management(previous, recycled = false) {
	return {
		revision: (previous?.revision || 0) + 1,
		changeId: crypto.randomUUID(),
		parentChangeId: previous?.changeId || null,
		recycled
	};
}
function compareManagement(a, b) {
	if (!a && !b) return "same";
	if (!a || !b) return "conflict";
	if (a.changeId === b.changeId && JSON.stringify(a) === JSON.stringify(b)) return "same";
	if (a.parentChangeId === b.changeId && a.revision === b.revision + 1) return "left-newer";
	if (b.parentChangeId === a.changeId && b.revision === a.revision + 1) return "right-newer";
	return "conflict";
}
function locate(root, file, kind = "archive", extra = {}) {
	const absolute = path.resolve(file),
		rel = path.relative(path.resolve(root), absolute);
	const internal = rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
	return {
		locationId: "location-" + crypto.createHash("sha256").update(absolute).digest("hex"),
		kind,
		scope: internal ? "library" : "external",
		path: internal ? rel : absolute,
		...extra
	};
}
function resolveLocation(root, location) {
	if (!location || typeof location.path !== "string") throw fail("TASK_LOCATION_INVALID");
	if (location.scope !== "library") return location.path;
	relativePath(location.path);
	return path.resolve(root, location.path);
}
module.exports = {
	CAPABILITIES,
	validateMarker,
	readMarker,
	writeMarker,
	management,
	compareManagement,
	relativePath,
	locate,
	resolveLocation
};
