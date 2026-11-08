"use strict";
const path = require("node:path");
const { fail } = require("./platform/global-settings.cjs");
const ENVIRONMENT_TEMPLATES_CAPABILITY = "es:task-environment-templates-v1";
const SLURM_MEMORY_POLICY_CAPABILITY = "es:task-slurm-memory-policy-v1";
function environmentRequiredCapabilities(environment, existing = []) {
	const required = existing.filter((capability) => ![ENVIRONMENT_TEMPLATES_CAPABILITY, SLURM_MEMORY_POLICY_CAPABILITY].includes(capability));
	if (environment.calculationTemplate?.trim() || environment.submitCommandTemplate?.trim())
		required.push(ENVIRONMENT_TEMPLATES_CAPABILITY);
	if (environment.slurmMemoryPolicy === "site-managed") required.push(SLURM_MEMORY_POLICY_CAPABILITY);
	return [...new Set(required)];
}
const FIELDS = [
	"environmentId",
	"revision",
	"displayName",
	"engineId",
	"connectionKind",
	"schedulerKind",
	"host",
	"port",
	"user",
	"distribution",
	"executable",
	"workingRoot",
	"scratchRoot",
	"partition",
	"account",
	"qos",
	"timeLimit",
	"initialization",
	"scriptTemplate",
	"calculationTemplate",
	"submitCommandTemplate",
	"slurmMemoryPolicy",
	"authentication",
	"privateKeyPath",
	"siteId",
	"siteRevision",
	"check"
];
function sanitizeEnvironment(input, { allowDraft = false, platform = process.platform } = {}) {
	const value = Object.fromEntries(
		FIELDS.filter((key) => Object.hasOwn(input || {}, key)).map((key) => [key, input[key]])
	);
	const allowedConnections = platform === "darwin" ? ["ssh"] : ["local", "wsl", "ssh"];
	if (
		typeof value.environmentId !== "string" ||
		(!value.environmentId && !(allowDraft && value.revision === 0)) ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		!["gaussian", "orca"].includes(value.engineId) ||
		!allowedConnections.includes(value.connectionKind) ||
		!["none", "slurm"].includes(value.schedulerKind) ||
		!value.displayName?.trim() ||
		!value.executable ||
		!value.workingRoot ||
		!["agent", "password", "private-key"].includes(value.authentication)
	)
		throw fail("ENVIRONMENT_INVALID");
	if (
		value.connectionKind === "ssh" &&
		(!value.host ||
			!value.user ||
			!Number.isInteger(value.port) ||
			value.port < 1 ||
			value.port > 65535)
	)
		throw fail("ENVIRONMENT_INVALID");
	if (value.connectionKind === "wsl" && (!value.distribution?.trim() || !value.user?.trim()))
		throw fail("ENVIRONMENT_INVALID");
	const targetPath = value.connectionKind === "local" ? path.win32 : path.posix;
	if (
		!targetPath.isAbsolute(value.executable) ||
		!targetPath.isAbsolute(value.workingRoot) ||
		(value.scratchRoot && !targetPath.isAbsolute(value.scratchRoot))
	)
		throw fail("ENVIRONMENT_PATH_DOMAIN_INVALID");
	const localPath = platform === "win32" ? path.win32 : path.posix;
	if (
		value.connectionKind === "ssh" &&
		value.authentication === "private-key" &&
		!localPath.isAbsolute(value.privateKeyPath || "")
	)
		throw fail("PRIVATE_KEY_LOCAL_PATH_REQUIRED");
	if (
		value.check &&
		value.check.fingerprint !==
			require("./environment-profiles.cjs").environmentCheckFingerprint(value)
	)
		delete value.check;
	if (value.schedulerKind === "slurm" && value.connectionKind !== "ssh")
		throw fail("ENVIRONMENT_INVALID");
	if (value.slurmMemoryPolicy !== undefined && !["input-request", "site-managed"].includes(value.slurmMemoryPolicy)) throw fail("SLURM_MEMORY_POLICY_UNSUPPORTED");
	if (value.slurmMemoryPolicy === "site-managed" && (value.connectionKind !== "ssh" || value.schedulerKind !== "slurm")) throw fail("SLURM_MEMORY_POLICY_REQUIRES_SSH_SLURM");
	for (const key of [
		"initialization",
		"scriptTemplate",
		"calculationTemplate",
		"submitCommandTemplate"
	])
		if (value[key] != null && typeof value[key] !== "string") throw fail("ENVIRONMENT_INVALID");
	if (
		value.submitCommandTemplate?.trim() &&
		(value.connectionKind !== "ssh" || value.schedulerKind !== "slurm")
	)
		throw fail("CUSTOM_SUBMIT_REQUIRES_SSH_SLURM");
	for (const [field, required, allowed] of [
		["calculationTemplate", "standardScript", ["standardScript", "workingPath"]],
		["submitCommandTemplate", "submitScriptPath", ["submitScriptPath", "workingPath"]]
	]) {
		if (!value[field]?.trim()) continue;
		const variables = [...value[field].matchAll(/(?<![$\\])\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(
			(match) => match[1]
		);
		if (
			variables.some((key) => !allowed.includes(key)) ||
			variables.filter((key) => key === required).length !== 1
		)
			throw fail("ENVIRONMENT_TEMPLATE_INVALID", { field });
	}
	for (const item of Object.values(value))
		if (typeof item === "string" && item.includes("\0")) throw fail("ENVIRONMENT_INVALID");
	return value;
}
function environmentSnapshot(environment, softwareConfiguration = {}) {
	return {
		environmentId: environment.environmentId,
		configurationRevision: environment.revision,
		connection: {
			kind: environment.connectionKind,
			...(environment.connectionKind === "ssh"
				? { host: environment.host, port: environment.port, user: environment.user }
				: {}),
			...(environment.connectionKind === "wsl"
				? { distribution: environment.distribution, user: environment.user }
				: {})
		},
		scheduler: {
			kind: environment.schedulerKind,
			partition: environment.partition,
			account: environment.account,
			qos: environment.qos,
			timeLimit: environment.timeLimit,
			scriptTemplate: environment.scriptTemplate,
			submitCommandTemplate: environment.submitCommandTemplate || "",
			...(environment.schedulerKind === "slurm" ? { connectionKind: environment.connectionKind, slurmMemoryPolicy: environment.slurmMemoryPolicy || "input-request" } : {})
		},
		softwareAdapter: {
			...softwareConfiguration,
			engineId: environment.engineId,
			executable: softwareConfiguration.executable || environment.executable,
			sourceExecutable: environment.executable
		},
		workingRoot: environment.workingRoot,
		configuration: { ...environment }
	};
}
function viewEnvironment(record) {
	return {
		...record.configuration.configuration,
		environmentId: record.environmentId,
		revision: record.revision,
		displayName: record.displayName,
		templateVariables:
			record.configuration.scheduler.kind === "slurm"
				? (require("./execution/slurm.cjs").SLURM_TEMPLATE_VARIABLES || []).map((value) => ({
						name: value.name,
						description: value.description
					}))
				: []
	};
}
module.exports = {
	ENVIRONMENT_TEMPLATES_CAPABILITY,
	SLURM_MEMORY_POLICY_CAPABILITY,
	environmentRequiredCapabilities,
	sanitizeEnvironment,
	environmentSnapshot,
	viewEnvironment,
	ENVIRONMENT_FIELDS: FIELDS
};
