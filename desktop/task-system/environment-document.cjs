"use strict";
const { fail } = require("./platform/global-settings.cjs");
function parseEnvironmentJson(input) {
	if (typeof input !== "string") return input;
	try { return JSON.parse(input); }
	catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw Object.assign(new Error(`JSON 语法无效，请检查逗号、引号和括号。\n${error.message}`), {
			code: "ENVIRONMENT_JSON_SYNTAX",
			details: { nativeName: error.name, nativeMessage: error.message }
		});
	}
}
const {
	sanitizeEnvironment,
	viewEnvironment,
	environmentSnapshot,
	ENVIRONMENT_TEMPLATES_CAPABILITY,
	SLURM_MEMORY_POLICY_CAPABILITY,
	environmentRequiredCapabilities,
	ENVIRONMENT_FIELDS
} = require("./environments.cjs");
const SECRET_FIELDS = new Set([
	"password",
	"passwd",
	"passphrase",
	"privatekey",
	"privatekeypassphrase",
	"sshprivatekey",
	"privatekeybytes",
	"secret",
	"secrets",
	"secretvalue",
	"secretkey",
	"clientsecret",
	"credential",
	"credentials",
	"credentialvalue",
	"credentialstore",
	"vault",
	"vaultentries",
	"encryptedvault",
	"safestorage",
	"token",
	"accesstoken",
	"refreshtoken",
	"authtoken",
	"apitoken",
	"apikey",
	"authorization",
	"cookie",
	"encryptedpassword",
	"encryptedsecret",
	"encryptedcredentials"
]);
function rejectSecrets(value) {
	const pending = [{ value, path: "$" }];
	while (pending.length) {
		const next = pending.pop();
		if (!next.value || typeof next.value !== "object") continue;
		for (const [key, item] of Object.entries(next.value)) {
			if (SECRET_FIELDS.has(key.replace(/[-_]/g, "").toLowerCase()))
				throw Object.assign(
					fail("ENVIRONMENT_SECRET_IMPORT_REJECTED", { path: next.path + "." + key }),
					{ message: "环境配置含凭据字段，不能导入或导出" }
				);
			if (
				typeof item === "string" &&
				/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:password|passwd|passphrase|token|api[_-]?key|secret)\b\s*[:=]\s*\S+/i.test(
					item
				)
			)
				throw Object.assign(
					fail("ENVIRONMENT_SECRET_IMPORT_REJECTED", { path: next.path + "." + key }),
					{ message: "环境配置含私钥或疑似脚本凭据，不能导入或导出" }
				);
			if (item && typeof item === "object")
				pending.push({ value: item, path: next.path + "." + key });
		}
	}
}
function decodeEnvironmentDocument(document, protocol) {
	if (
		!document ||
		document.schemaVersion !== 1 ||
		!document.environment ||
		typeof document.environment !== "object" ||
		Array.isArray(document.environment) ||
		(Object.hasOwn(document.environment, "schemaVersion") &&
			document.environment.schemaVersion !== 1)
	)
		throw fail("ENVIRONMENT_FORMAT_UNSUPPORTED");
	rejectSecrets(document);
	const environment = sanitizeEnvironment(document.environment, { allowDraft: true }),
		required = [];
	// An imported document cannot attest that this installation has been checked.
	delete environment.check;
	for (const record of [document, document.environment]) {
		const capabilities = Object.hasOwn(record, "requiredCapabilities")
			? record.requiredCapabilities
			: [];
		try {
			protocol.assertRecord(
				"environment",
				{
					schemaVersion: 1,
					revision: 1,
					requiredCapabilities: capabilities,
					environmentId: "import-validation",
					displayName: environment.displayName,
					configuration: environmentSnapshot({
						...environment,
						environmentId: "import-validation",
						revision: 1
					})
				},
				{ forWrite: true, supportedCapabilities: [ENVIRONMENT_TEMPLATES_CAPABILITY, SLURM_MEMORY_POLICY_CAPABILITY] }
			);
		} catch (error) {
			if (error.issues?.some((issue) => issue.code === "UNSUPPORTED_CAPABILITY"))
				throw Object.assign(fail("ENVIRONMENT_CAPABILITY_UNSUPPORTED", { issues: error.issues }), {
					message: "环境配置需要当前版本不支持的能力"
				});
			throw error;
		}
		required.push(...capabilities);
	}
	const envelopeExtensions = Object.fromEntries(
			Object.entries(document).filter(
				([key]) => !["schemaVersion", "requiredCapabilities", "environment"].includes(key)
			)
		),
		environmentExtensions = Object.fromEntries(
			Object.entries(document.environment).filter(
				([key]) => !ENVIRONMENT_FIELDS.includes(key) && key !== "templateVariables"
			)
		);
	return {
		environment,
		requiredCapabilities: environmentRequiredCapabilities(environment, required),
		preserved: {
			envelopeExtensions: structuredClone(envelopeExtensions),
			environmentExtensions: structuredClone(environmentExtensions)
		}
	};
}
function encodeEnvironmentDocument(record) {
	if (record.schemaVersion !== 1) throw fail("ENVIRONMENT_FORMAT_UNSUPPORTED");
	const extensions = record.environmentDocument || {},
		document = {
			...(extensions.envelopeExtensions || {}),
			schemaVersion: 1,
			requiredCapabilities: record.requiredCapabilities || [],
			environment: { ...(extensions.environmentExtensions || {}), ...viewEnvironment(record) }
		};
	// JSON round-trips saved configuration, including non-secret scripts. The
	// separate current-configuration Markdown preview owns its script opt-in.
	delete document.environment.check;
	delete document.environment.templateVariables;
	document.requiredCapabilities = environmentRequiredCapabilities(
		document.environment,
		document.requiredCapabilities
	);
	if (Array.isArray(document.environment.requiredCapabilities))
		document.environment.requiredCapabilities = environmentRequiredCapabilities(
			document.environment,
			document.environment.requiredCapabilities
		);
	rejectSecrets(document);
	return document;
}
function previewEnvironmentDocument(document, protocol) {
	const decoded = decodeEnvironmentDocument(document, protocol);
	return {
		...decoded,
		changes: Object.entries(decoded.environment)
			.filter(([key]) => !["environmentId", "revision", "check"].includes(key))
			.map(([field, value]) => ({ field, value }))
	};
}
module.exports = {
	parseEnvironmentJson,
	decodeEnvironmentDocument,
	encodeEnvironmentDocument,
	previewEnvironmentDocument
};
