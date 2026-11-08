"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { fail } = require("./platform/global-settings.cjs");
const SITE_FIELDS = Object.freeze([
	"connectionKind",
	"host",
	"port",
	"user",
	"distribution",
	"workingRoot",
	"schedulerKind",
	"partition",
	"account",
	"qos",
	"timeLimit",
	"authentication",
	"privateKeyPath"
]);
function sanitizeSiteProfile(input, { allowDraft = false, platform = process.platform } = {}) {
	const site = Object.fromEntries(
		["siteId", "revision", "displayName", ...SITE_FIELDS].map((key) => [key, input?.[key]])
	);
	const allowedConnections = platform === "darwin" ? ["ssh"] : ["local", "wsl", "ssh"];
	if (
		typeof site.siteId !== "string" ||
		(!site.siteId && !(allowDraft && site.revision === 0)) ||
		!Number.isSafeInteger(site.revision) ||
		site.revision < 0 ||
		!site.displayName?.trim() ||
		!allowedConnections.includes(site.connectionKind) ||
		!["none", "slurm"].includes(site.schedulerKind) ||
		!["agent", "password", "private-key"].includes(site.authentication) ||
		!site.workingRoot?.trim()
	)
		throw fail("SITE_PROFILE_INVALID");
	for (const key of SITE_FIELDS.filter((key) => key !== "port"))
		if (typeof site[key] !== "string" || site[key].includes("\0"))
			throw fail("SITE_PROFILE_INVALID");
	if (
		site.connectionKind === "ssh" &&
		(!site.host.trim() ||
			!site.user.trim() ||
			!Number.isInteger(site.port) ||
			site.port < 1 ||
			site.port > 65535)
	)
		throw fail("SITE_PROFILE_INVALID");
	if (site.connectionKind === "wsl" && (!site.distribution.trim() || !site.user.trim()))
		throw fail("SITE_PROFILE_INVALID");
	if (site.connectionKind !== "ssh" && site.schedulerKind !== "none")
		throw fail("SITE_PROFILE_INVALID");
	if (!(site.connectionKind === "local" ? path.win32 : path.posix).isAbsolute(site.workingRoot))
		throw fail("ENVIRONMENT_PATH_DOMAIN_INVALID");
	return site;
}
function flattenEnvironmentSite(environment, profile, options) {
	const site = sanitizeSiteProfile(profile, options);
	return {
		...environment,
		...Object.fromEntries(SITE_FIELDS.map((key) => [key, site[key]])),
		siteId: site.siteId,
		siteRevision: site.revision
	};
}
function environmentCheckFingerprint(environment) {
	const fields = [
		"engineId",
		...SITE_FIELDS,
		"executable",
		"scratchRoot",
		"initialization",
		"scriptTemplate",
		"calculationTemplate",
		"submitCommandTemplate"
	];
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(fields.map((key) => [key, environment?.[key] ?? null])))
		.digest("hex");
}
function environmentCheckView(environment, software, checkedAt = new Date().toISOString()) {
	const version = software.recognizedVersion || null;
	const refs = (software.evidenceRefs || []).join(" ");
	const evidenceKind = /embedded/.test(refs)
		? "embedded-strings"
		: /pe-|PE|metadata/.test(refs)
			? "pe-metadata"
			: /startup|command|banner/.test(refs)
				? "command-output"
				: "unknown";
	return {
		state: version ? "passed" : "limited",
		fingerprint: environmentCheckFingerprint(environment),
		checkedAt,
		connection: "passed",
		entry: "passed",
		family: { state: "passed", engineId: software.engineId },
		version: { state: version ? "known" : "unknown", value: version },
		execution: "not-tested",
		evidenceKind
	};
}
module.exports = {
	SITE_FIELDS,
	sanitizeSiteProfile,
	flattenEnvironmentSite,
	environmentCheckFingerprint,
	environmentCheckView
};
