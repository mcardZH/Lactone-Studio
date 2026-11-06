"use strict";
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { isMissingFile } = require("../transports/file-errors.cjs");
const { fail, sha256, quote, response, validate } = require("./common.cjs");
const { createProcessAdapter } = require("./process.cjs");
const { schedulerTerminalAccounting } = require("./scheduler-end.cjs");
const { inspectSlurmResources, standardInputDirectives } = require("../engines/slurm-resources.cjs");
const TERMINAL = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMEOUT",
	"NODE_FAIL",
	"OUT_OF_MEMORY",
	"PREEMPTED",
	"BOOT_FAIL",
	"DEADLINE",
	"REVOKED"
]);
const SLURM_FORM_FIELDS = {
	partition: "partition",
	account: "account",
	qos: "qos",
	timeLimit: "time"
};
const SLURM_TEMPLATE_VARIABLES = Object.freeze([
	{
		name: "workingPath",
		description: "本Run真实工作目录，已作为独立shell参数安全引用，勿再套引号"
	},
	{ name: "runnerPath", description: "本Run固定执行器脚本，已安全引用，必须在模板中恰好一次" },
	{ name: "partition", description: "本次明确分区，未填写却引用时拒绝展开" },
	{ name: "account", description: "本次明确账户，未填写却引用时拒绝展开" },
	{ name: "qos", description: "本次明确QoS，未填写却引用时拒绝展开" },
	{ name: "timeLimit", description: "本次申请时限原文，不是ETA" },
	{ name: "initialization", description: "用户明确配置的初始化代码，可为空" },
	{ name: "directives", description: "明确SBATCH行；标准wrapper的缺项按最终输入映射，不提供额外资源默认" }
]);
function bareTemplateToken(template, offset) {
	let quoted = null,
		comment = false;
	for (let index = 0; index < offset; index++) {
		const char = template[index];
		if (char === "\n") {
			comment = false;
			continue;
		}
		if (comment) continue;
		if (char === "\\" && quoted !== "'") {
			index++;
			continue;
		}
		if (quoted) {
			if (char === quoted) quoted = null;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(template[index - 1]))) {
			const line = template.slice(template.lastIndexOf("\n", index - 1) + 1);
			if (!line.trimStart().startsWith("#SBATCH")) comment = true;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quoted = char;
	}
	return !quoted && !comment;
}
function renderSlurmScript({
	workLocation,
	configuration,
	engineId,
	parsedRequests,
	siteDefaults
}) {
	const directives = configuration.directives || [];
	const memoryPolicy = configuration.slurmMemoryPolicy === undefined ? "input-request" : configuration.slurmMemoryPolicy;
	if (!["input-request", "site-managed"].includes(memoryPolicy)) fail("SLURM_MEMORY_POLICY_UNSUPPORTED");
	if (memoryPolicy === "site-managed" && configuration.connectionKind !== "ssh") fail("SLURM_MEMORY_POLICY_REQUIRES_SSH_SLURM");
	if (
		!Array.isArray(directives) ||
		directives.some(
			(line) =>
				typeof line !== "string" ||
				/[\r\n\0]/.test(line) ||
				!/^--[a-z][a-z0-9-]*(?:=|\s|$)/.test(line)
		)
	)
		fail("INVALID_SLURM_DIRECTIVES");
	if (
		typeof configuration.initialization !== "undefined" &&
		typeof configuration.initialization !== "string"
	)
		fail("INVALID_SLURM_INITIALIZATION");
	if (configuration.scriptTemplate != null && typeof configuration.scriptTemplate !== "string")
		fail("INVALID_SLURM_TEMPLATE");
	const values = {};
	for (const field of Object.keys(SLURM_FORM_FIELDS)) {
		const value = configuration[field];
		if (value === undefined || value === null || value === "") {
			values[field] = null;
			continue;
		}
		if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\0]/.test(value))
			fail("INVALID_SLURM_FORM_VALUE", { field });
		if (
			field === "timeLimit"
				? !/^(?:\d+(?:-\d+)?(?::\d{1,2}){0,2}|UNLIMITED|INFINITE)$/i.test(value)
				: !/^[A-Za-z0-9_.@,+:-]+$/.test(value)
		)
			fail("INVALID_SLURM_FORM_VALUE", { field });
		values[field] = value;
	}
	const variables = {
		workingPath: quote(workLocation.path),
		runnerPath: quote(path.posix.join(workLocation.path, ".es-execution", "runner.sh")),
		...values,
		initialization: configuration.initialization || "",
		directives: directives.map((line) => `#SBATCH ${line}`).join("\n")
	};
	let expandedScript, templateKind, generatedFields = {};
	if (configuration.scriptTemplate?.trim()) {
		templateKind = "controlled-template";
		const template = configuration.scriptTemplate;
		if (!/^#![^\r\n]*\bbash(?:\s|$)/.test(template)) fail("SLURM_TEMPLATE_BASH_SHEBANG_REQUIRED");
		const used = new Map();
		expandedScript = template.replace(
			/(?<![$\\])\{([A-Za-z][A-Za-z0-9_]*)\}/g,
			(_match, key, offset) => {
				if (!Object.hasOwn(variables, key))
					fail("SLURM_TEMPLATE_UNKNOWN_VARIABLE", { variable: key });
				if (variables[key] === null) fail("SLURM_TEMPLATE_VALUE_REQUIRED", { variable: key });
				if (["workingPath", "runnerPath"].includes(key) && !bareTemplateToken(template, offset))
					fail("SLURM_TEMPLATE_PATH_MUST_BE_BARE_TOKEN", { variable: key });
				used.set(key, (used.get(key) || 0) + 1);
				return variables[key];
			}
		);
		if (used.get("runnerPath") !== 1) fail("SLURM_TEMPLATE_SINGLE_RUNNER_REQUIRED");
		for (const field of [...Object.keys(SLURM_FORM_FIELDS), "initialization"])
			if (variables[field] && !used.has(field)) fail("SLURM_TEMPLATE_UNCONSUMED_FIELD", { field });
		if (directives.length && !used.has("directives"))
			fail("SLURM_TEMPLATE_DIRECTIVES_REQUIRE_EXPLICIT_PLACEHOLDER");
	} else {
		templateKind = "default";
		const resolved = [...directives];
		if (engineId && parsedRequests) {
			const explicit = inspectSlurmResources({ scriptText: `#!/bin/bash\n${directives.map(line => `#SBATCH ${line}`).join("\n")}\n`, engineId, parsedRequests, memoryPolicy });
			const generated = standardInputDirectives({ engineId, parsedRequests, declarations: explicit.schedulerRequest.slurm.declarations, memoryPolicy });
			resolved.push(...generated.directives); generatedFields = generated.generatedFields;
		}
		for (const [field, flag] of Object.entries(SLURM_FORM_FIELDS))
			if (values[field] !== null) {
				const matching = resolved.filter((line) => new RegExp(`^--${flag}(?:=|\\s|$)`).test(line));
				if (
					matching.some(
						(line) => line.replace(new RegExp(`^--${flag}(?:=|\\s+)`), "") !== values[field]
					)
				)
					fail("SLURM_FORM_DIRECTIVE_CONFLICT", { field });
				if (!matching.length) resolved.push(`--${flag}=${values[field]}`);
			}
		variables.directives = resolved.map(line => `#SBATCH ${line}`).join("\n");
		expandedScript = `#!/usr/bin/env bash\n${variables.directives}\ncd -- ${variables.workingPath} || exit 70\n${variables.initialization}\nbash ${variables.runnerPath}\n`;
	}
	const resources =
		engineId && parsedRequests
			? inspectSlurmResources({
					scriptText: expandedScript,
					engineId,
					parsedRequests,
					siteDefaults: siteDefaults || configuration.siteDefaults,
					memoryPolicy,
					generatedFields
				})
			: {
					schedulerRequest: null,
					restrictions: ["SLURM_INPUT_RESOURCE_CONTEXT_REQUIRED"],
					fieldStatus: {
						schedulerRequest: {
							state: "unknown",
							reason: "The final input resource context is not available"
						}
					}
				};
	return {
		bytes: Buffer.from(expandedScript),
		expandedScript,
		variables,
		templateKind,
		...resources
	};
}
function buildSlurmScript(input) {
	return renderSlurmScript(input).bytes;
}
function parseJobId(raw) {
	const match = raw.trim().match(/^(\d+)(?:;([A-Za-z0-9_.-]+))?$/);
	if (!match || !Number.isSafeInteger(Number(match[1]))) fail("SLURM_SUBMIT_RECEIPT_UNVERIFIED");
	return { jobId: match[1], cluster: match[2] || null };
}
function renderSubmitCommand(template, { submitScriptPath, workingPath }) {
	if (typeof template !== "string" || !template.trim()) return null;
	if (template.includes("\0")) fail("SLURM_SUBMIT_TEMPLATE_INVALID");
	const values = { submitScriptPath, workingPath }, used = new Set();
	const expanded = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name, offset) => {
		if (!Object.hasOwn(values, name)) fail("SLURM_SUBMIT_VARIABLE_UNSUPPORTED", { name });
		if (!bareTemplateToken(template, offset)) fail("SLURM_SUBMIT_VARIABLE_MUST_BE_BARE", { name });
		used.add(name);
		return quote(values[name]);
	});
	if (!used.has("submitScriptPath")) fail("SLURM_SUBMIT_SCRIPT_REQUIRED");
	return expanded;
}
async function inspectSlurmCapabilities(
	{
		transport,
		workingRoot,
		commands: commandPaths = {},
		environment = {},
		accountingComment = false
	},
	io
) {
	const invoke = (name, args) =>
			transport.exec(
				{ executable: commandPaths[name] || name, args, cwd: workingRoot, env: environment },
				io
			),
		commands = {};
	for (const name of ["sbatch", "squeue", "sacct", "scancel"]) {
		try {
			const result = await invoke(name, ["--version"]);
			commands[name] = {
				available: result.exitCode === 0,
				rawVersion: Buffer.from(result.stdout).toString("utf8").trim(),
				exitCode: result.exitCode
			};
		} catch {
			commands[name] = { available: false, rawVersion: null };
		}
	}
	let parsable = false,
		queueComment = false;
	if (commands.sbatch.available) {
		const result = await invoke("sbatch", ["--help"]);
		parsable =
			result.exitCode === 0 && /--parsable\b/.test(Buffer.from(result.stdout).toString("utf8"));
	}
	if (commands.squeue.available) {
		const result = await invoke("squeue", ["--helpformat"]);
		queueComment =
			result.exitCode === 0 && /\bComment\b/i.test(Buffer.from(result.stdout).toString("utf8"));
	}
	return {
		commands,
		schedulerCapabilities: {
			parsable,
			queueComment,
			accounting: commands.sacct.available,
			accountingComment: accountingComment === true
		},
		supported: [
			"slurm-template",
			"intent-claim",
			...(commands.scancel.available ? ["slurm-stop"] : [])
		],
		unverified: ["native-submit", "native-stop", "native-conversion"],
		nativeVerified: false
	};
}
function createSlurmAdapter({
	protocol,
	transport,
	configuration,
	readInputFile,
	readExecutionReceipt,
	shouldStopBeforeSubmit,
	now = () => new Date().toISOString()
}) {
	const processAdapter = createProcessAdapter({
		protocol,
		transport,
		platform: "linux",
		readInputFile,
		shouldStopBeforeSubmit
	});
	const user = configuration.user,
		site = configuration.siteId;
	if (!user || !site) fail("SLURM_SITE_USER_REQUIRED");
	const executable = (kind) => configuration.commands?.[kind] || kind;
	const statePath = (request) =>
		path.posix.join(request.payload.workLocation.path, ".es-execution");
	async function read(file, io) {
		try {
			const identity = await transport.stat(file, io);
			if (identity.byteSize > 1024 * 1024) fail("RECEIPT_TOO_LARGE");
			const range = await transport.readRange(
				{ path: file, identity, offset: 0, length: identity.byteSize },
				io
			);
			return Buffer.from(range.bytes).toString("utf8");
		} catch (error) {
			if (isMissingFile(error, file)) return null;
			throw error;
		}
	}
	async function exec(request, command, args, io) {
		const cwd = request.payload.workLocation?.path || configuration.workingRoot;
		if (!cwd) fail("SLURM_WORK_ROOT_REQUIRED");
		return transport.exec(
			{ executable: executable(command), args, cwd, env: configuration.environment || {} },
			io
		);
	}
	async function cancelledScheduler(request, io) {
		const state = statePath(request),
			raw = await read(`${state}/slurm-submit-claim/cancelled.json`, io);
		if (!raw) return null;
		const value = JSON.parse(raw);
		if (
			value.runId !== request.runId ||
			value.taskId !== request.taskId ||
			value.submissionIntentId !== request.submissionIntentId ||
			value.cancelled !== true ||
			!value.operationId ||
			!value.cancelledAt
		)
			fail("SLURM_CANCELLATION_IDENTITY_CONFLICT");
		return {
			protocolVersion: 1,
			receiptId: `${request.submissionIntentId}:run.scheduler-not-started:1`,
			eventId: `${request.submissionIntentId}:run.scheduler-not-started:1`,
			eventType: "run.scheduler-not-started",
			source: `es-slurm-gate:${request.runId}`,
			sequence: 1,
			occurredAt: value.cancelledAt,
			payloadVersion: 1,
			taskId: request.taskId,
			runId: request.runId,
			submissionIntentId: request.submissionIntentId,
			operationId: value.operationId,
			evidenceRefs: [`${state}/slurm-submit-claim/cancelled.json`],
			payload: {
				notStarted: true,
				exitCode: null,
				signal: null,
				endReason: "stopped",
				processTree: { verified: true, notStarted: true, scope: "slurm-submit-gate" },
				stopOperationId: value.stopOperationId
			}
		};
	}
	async function submission(request, io) {
		const state = statePath(request),
			value = await read(`${state}/slurm-submit.txt`, io);
		const original = request.payload.schedulerSubmissionIdentity;
		if (original) {
			const marker = value === null ? null : parseJobId(value);
			if (original.siteId !== site || original.userId !== user ||
				original.submissionIntentId !== request.submissionIntentId ||
				original.workPath !== request.payload.workLocation.path || !/^\d+$/.test(original.jobId) ||
				(marker && (marker.jobId !== original.jobId || marker.cluster !== original.cluster)))
				fail("SLURM_SUBMISSION_IDENTITY_CONFLICT");
			const { jobId, cluster, siteId, userId, submissionIntentId } = original;
			return { jobId, cluster, siteId, userId, submissionIntentId };
		}
		if (value !== null)
			return {
				...parseJobId(value),
				siteId: site,
				userId: user,
				submissionIntentId: request.submissionIntentId
			};
		const previous = request.payload.schedulerIdentity;
		if (
			previous &&
			previous.siteId === site &&
			previous.userId === user &&
			previous.submissionIntentId === request.submissionIntentId &&
			/^\d+$/.test(previous.jobId)
		)
			return previous;
		if (!configuration.capabilities?.queueComment) return null;
		const queue = await exec(
			request,
			"squeue",
			["--noheader", "--user", user, "--format", "%i|%u|%k"],
			io
		);
		if (queue.exitCode !== 0) return null;
		let matches = Buffer.from(queue.stdout)
			.toString("utf8")
			.split(/\r?\n/)
			.map((line) => line.trim().split("|"))
			.filter(
				(fields) =>
					/^\d+$/.test(fields[0]) &&
					fields[1] === user &&
					fields[2] === `es-intent:${request.submissionIntentId}`
			);
		// Accounting comments are optional at the site. Never assume job_comment retention.
		if (
			!matches.length &&
			configuration.capabilities.accountingComment &&
			request.payload.submittedAfter
		) {
			const history = await exec(
				request,
				"sacct",
				[
					"--noheader",
					"--parsable2",
					"--user",
					user,
					"--starttime",
					request.payload.submittedAfter,
					"--format",
					"JobIDRaw,User,Comment"
				],
				io
			);
			if (history.exitCode === 0)
				matches = Buffer.from(history.stdout)
					.toString("utf8")
					.split(/\r?\n/)
					.map((line) => line.trim().split("|"))
					.filter(
						(fields) =>
							/^\d+$/.test(fields[0]) &&
							fields[1] === user &&
							fields[2] === `es-intent:${request.submissionIntentId}`
					);
		}
		if (matches.length > 1) fail("SLURM_INTENT_IDENTITY_CONFLICT");
		return matches.length === 1
			? {
					jobId: matches[0][0],
					cluster: null,
					siteId: site,
					userId: user,
					submissionIntentId: request.submissionIntentId,
					recoveredBy: "exact-intent-comment"
				}
			: null;
	}
	async function inspectScheduler(request, identity, io) {
		const clusterArgs = identity.cluster ? ["--clusters", identity.cluster] : [];
		const readIntentComment = !request.payload.schedulerSubmissionIdentity &&
			configuration.capabilities?.accountingComment === true;
		const readQueueComment = !request.payload.schedulerSubmissionIdentity &&
			configuration.capabilities?.queueComment === true;
		const queue = await exec(
			request,
			"squeue",
			["--noheader", ...clusterArgs, "--user", user, "--format", readQueueComment ? "%i|%u|%T|%k" : "%i|%u|%T"],
			io
		);
		if (queue.exitCode !== 0) return { status: "unknown", reason: "SLURM_QUEUE_UNAVAILABLE" };
		const rows = Buffer.from(queue.stdout).toString("utf8").trim().split(/\r?\n/).filter(Boolean)
			.map(line => line.trim().split("|"));
		if (rows.some(row => row.length !== (readQueueComment ? 4 : 3) || !row[2]))
			return { status: "unknown", reason: "SLURM_QUEUE_IDENTITY_UNVERIFIED" };
		const matching = rows.find(fields => fields[0] === identity.jobId);
		if (matching && matching[1] !== user) return { status: "conflict" };
		const intentComment = `es-intent:${request.submissionIntentId}`;
		const active = matching && { status: /^(PENDING|CONFIGURING)$/.test(matching[2]) ? "queued" : "running", rawState: matching[2] };
		if (active && (request.payload.schedulerSubmissionIdentity ||
			(readQueueComment && matching[3] === intentComment && rows.filter(row => row[3] === intentComment).length === 1))) return active;
		if (active && !readIntentComment) return { status: "unknown", reason: "SLURM_INTENT_IDENTITY_UNVERIFIED" };
		if (rows.some(([jobId]) => [".", "_", "+"].some(separator => jobId.startsWith(identity.jobId + separator))))
			return { status: "unknown", reason: "SLURM_QUEUE_IDENTITY_UNVERIFIED" };
		if (!configuration.capabilities?.accounting)
			return { status: "unknown", reason: "SLURM_ACCOUNTING_UNVERIFIED" };
		const account = await exec(
			request,
			"sacct",
			[
				"--noheader",
				"--parsable2",
				...clusterArgs,
				"--jobs",
				identity.jobId,
				"--duplicates",
				"--format",
				`JobIDRaw,User%128,State%64,ExitCode,Submit,Start,End,Cluster,WorkDir%4096${readIntentComment ? ",Comment%128" : ""}`
			],
			io
		);
		if (account.exitCode !== 0)
			return { status: "unknown", reason: "SLURM_ACCOUNTING_UNAVAILABLE" };
		const accountingRows = Buffer.from(account.stdout)
			.toString("utf8")
			.split(/\r?\n/)
			.filter(line => line.trim())
			.map(line => line.trim().split("|").map(field => field.trim()));
		const terminalRows = accountingRows.every(row => row.length === (readIntentComment ? 10 : 9))
			? accountingRows.map(row => row.slice(0, 9)) : null;
		const parents = accountingRows.filter(value => value[0] === identity.jobId);
		const fields = parents[0];
		if (!fields) return { status: "unknown", reason: "SLURM_HISTORY_NOT_FOUND" };
		if (fields[1] !== user) return { status: "conflict" };
		const exactIntentComment = readIntentComment && terminalRows && parents.length === 1 &&
			fields[9] === intentComment && fields[8] === request.payload.workLocation.path &&
			fields[7] && (!identity.cluster || fields[7] === identity.cluster);
		if (active) return exactIntentComment ? active : { status: "unknown", reason: "SLURM_INTENT_IDENTITY_UNVERIFIED" };
		const rawState = fields[2],
			normalized = rawState.split(/[ +]/)[0];
		return TERMINAL.has(normalized)
			? {
					status: "ended",
					rawState,
					endReason:
						normalized === "COMPLETED"
							? "completed"
							: normalized === "CANCELLED"
								? "stopped"
								: ["NODE_FAIL", "BOOT_FAIL", "PREEMPTED"].includes(normalized)
									? "interrupted"
									: "failed",
					exitStatus: fields[3],
					submittedAtRaw: fields[4],
					startedAtRaw: fields[5],
					endedAtRaw: fields[6],
					...(exactIntentComment
						? { exactIntentComment: fields[9] } : {}),
					...(schedulerTerminalAccounting(terminalRows, identity, request.payload.workLocation.path)
						? { accountingRows: terminalRows } : {})
				}
			: { status: "unknown", rawState };
	}
	async function schedulerEnd(request, identity, observed, state, io) {
		const { manifestHash, knownLaunchIdentity, submitOperationId } = request.payload;
		if (!observed.accountingRows || !manifestHash || !submitOperationId) return null;
		const binding = request.payload.schedulerSubmissionIdentity
			? { kind: "durable-submit-action", operationId: submitOperationId }
			: observed.exactIntentComment
				? { kind: "exact-accounting-comment", comment: observed.exactIntentComment } : null;
		if (!binding) return null;
		const manifestPath = `${state}/manifest.json`, raw = await read(manifestPath, io);
		if (!raw || sha256(Buffer.from(raw)) !== manifestHash) return null;
		const manifest = JSON.parse(raw);
		if (manifest.taskId !== request.taskId || manifest.runId !== request.runId ||
			manifest.operationId !== submitOperationId || manifest.submissionIntentId !== request.submissionIntentId ||
			manifest.workLocation?.path !== request.payload.workLocation.path ||
			(knownLaunchIdentity?.jobId && (knownLaunchIdentity.jobId !== identity.jobId ||
				knownLaunchIdentity.siteId !== identity.siteId || knownLaunchIdentity.userId !== identity.userId ||
				(knownLaunchIdentity.cluster && knownLaunchIdentity.cluster !== identity.cluster)))) return null;
		const receiptId = `${request.submissionIntentId}:run.scheduler-ended:1`;
		const currentEvidence = { manifestHash, workPath: manifest.workLocation.path, schedulerIdentity: identity,
			queueAbsent: true, accountingRows: observed.accountingRows.toSorted((a, b) => a[0].localeCompare(b[0])), endReason: observed.endReason };
		const previous = readExecutionReceipt?.(receiptId);
		if (previous) {
			const { binding: originalBinding, ...originalEvidence } = previous.payload;
			// A fast job can end before the submit action has been committed.
			// Independent proofs of the same job do not replace the first receipt.
			const originalBindingMatches = originalBinding?.kind === "durable-submit-action"
				? originalBinding.operationId === submitOperationId
				: originalBinding?.kind === "exact-accounting-comment" &&
					originalBinding.comment === `es-intent:${request.submissionIntentId}`;
			if (originalBindingMatches && previous.eventType === "run.scheduler-ended" &&
				previous.taskId === request.taskId && previous.runId === request.runId &&
				previous.operationId === submitOperationId && previous.submissionIntentId === request.submissionIntentId &&
				isDeepStrictEqual(originalEvidence, currentEvidence)) return previous;
			fail("SLURM_SCHEDULER_END_CONFLICT");
		}
		return {
			protocolVersion: 1, receiptId, eventId: receiptId, eventType: "run.scheduler-ended",
			source: `es-slurm-accounting:${request.runId}`, sequence: 1, occurredAt: now(),
			payloadVersion: 1, taskId: request.taskId, runId: request.runId,
			submissionIntentId: request.submissionIntentId, operationId: submitOperationId,
			requiredCapabilities: [require("./scheduler-end.cjs").SCHEDULER_END_CAPABILITY],
			evidenceRefs: [manifestPath, `slurm:${site}:${identity.jobId}#squeue+sacct`,
				...(identity.recoveredBy ? [] : [`${state}/slurm-submit.txt`])], payload: { ...currentEvidence, binding }
		};
	}
	const adapter = {
		kind: "slurm",
		adapterVersion: "1.0.0",
		async capabilities(request, io) {
			validate(protocol, request, "capabilities");
			return response(
				protocol,
				request,
				await inspectSlurmCapabilities(
					{
						transport,
						workingRoot: request.payload.workLocation?.path || configuration.workingRoot,
						commands: configuration.commands,
						environment: configuration.environment,
						accountingComment: configuration.capabilities?.accountingComment
					},
					io
				)
			);
		},
		async prepare(request, io) {
			validate(protocol, request, "prepare");
			const manifest = request.payload.manifest,
				rendered = renderSlurmScript({
					workLocation: request.payload.workLocation,
					configuration,
					engineId: manifest.engineId,
					parsedRequests: manifest.inputRequests
				});
			if (rendered.restrictions.length)
				fail("SLURM_RESOURCE_REQUEST_RESTRICTED", {
					restrictions: rendered.restrictions,
					schedulerRequest: rendered.schedulerRequest,
					fieldStatus: rendered.fieldStatus
				});
			const bytes = rendered.bytes;
			const frozen = request.payload.manifest.engineExtensions?.submissionScript;
			if (
				frozen &&
				(frozen.algorithm !== "sha256" ||
					frozen.hash !== sha256(bytes) ||
					frozen.text !== bytes.toString("utf8"))
			)
				fail("SLURM_FROZEN_SCRIPT_IDENTITY_CONFLICT");
			async function freezeContent(identity) {
				const verified = await transport.hash({ path: identity.path, identity, algorithm: "sha256" }, io);
				if (!/^[a-f0-9]{64}$/.test(verified.hash) || verified.identity.path !== identity.path ||
					verified.identity.byteSize !== identity.byteSize || !verified.identity.isRegularFile)
					fail("SLURM_SOFTWARE_CONTENT_UNVERIFIED");
				return { path: identity.path, byteSize: identity.byteSize, sha256: verified.hash };
			}
			const software = [];
			if (manifest.softwareIdentity)
				for (const identity of [manifest.softwareIdentity.entry, ...manifest.softwareIdentity.members])
					software.push(await freezeContent(identity));
			const preparation = manifest.resultPreparation;
			let converter = null;
			if (preparation) {
				const identity = preparation.toolIdentity?.entryIdentity;
				if (!identity || identity.path !== preparation.command.executable) fail("SLURM_CONVERTER_CONTENT_UNVERIFIED");
				converter = await freezeContent(identity);
			}
			const preparedRequest = software.length || converter ? { ...request, payload: { ...request.payload,
				manifest: { ...manifest, slurmSoftwareContent: { software, converter } } } } : request;
			const result = await processAdapter.prepare(preparedRequest, io);
			const file = `${statePath(request)}/slurm.sh`;
			const prepared = await transport.putAtomic(
				{
					path: file,
					source: bytes,
					byteSize: bytes.length,
					sha256: sha256(bytes),
					expectedAbsent: true
				},
				io
			);
			result.payload.files.push(prepared);
			result.payload.schedulerRequest = rendered.schedulerRequest;
			return result;
		},
		async submit(request, io) {
			validate(protocol, request, "submit");
			const cancelled = await cancelledScheduler(request, io);
			if (cancelled)
				return response(
					protocol,
					request,
					{ endReceipt: cancelled, evidenceRefs: cancelled.evidenceRefs },
					"completed",
					{
						executionState: "ended",
						endReason: "stopped",
						verificationState: "verified",
						notStarted: true,
						resultPreparation: "not-started",
						relatedActivityEnded: true
					}
				);
			if (shouldStopBeforeSubmit?.(request)) {
				const stopped = await adapter.requestStop({ ...request, action: "requestStop" }, io);
				return response(
					protocol,
					request,
					stopped.payload,
					stopped.responseState,
					stopped.actualState
				);
			}
			if (configuration.capabilities?.parsable !== true)
				fail("SLURM_PARSABLE_CAPABILITY_UNVERIFIED");
			const state = statePath(request),
				existing = await submission(request, io);
			if (existing)
				return response(
					protocol,
					request,
					{
						launchIdentity: existing,
						reusedIntent: true,
						evidenceRefs: [`${state}/slurm-submit.txt`]
					},
					"completed",
					{ executionState: "queued" }
				);
			const submitCommand = renderSubmitCommand(configuration.submitCommandTemplate, { submitScriptPath: `${state}/slurm.sh`, workingPath: request.payload.workLocation.path }) || `${quote(executable("sbatch"))} --parsable --comment=${quote(`es-intent:${request.submissionIntentId}`)} --job-name=${quote(`es-${request.runId}`)} ${quote(`${state}/slurm.sh`)}`;
			const candidate = `${state}/slurm-submit.candidate`,
				stderr = `${state}/slurm-submit-stderr.txt`,
				receiptPath = `${state}/slurm-submit.txt`;
			const script = `umask 077; mkdir -- ${quote(`${state}/slurm-submit-claim`)} 2>/dev/null || { printf 'claim-exists'; exit 0; }; ( ${submitCommand}\n) > ${quote(candidate)} 2> ${quote(stderr)}; rc=$?; if ! sync -- ${quote(candidate)} 2>> ${quote(stderr)}; then printf 'submit-receipt-sync-failed'; exit 0; fi; if test "$rc" -eq 0; then if ! ln -T -- ${quote(candidate)} ${quote(receiptPath)} 2>> ${quote(stderr)}; then printf 'submit-receipt-publish-failed'; exit 0; fi; if ! rm -- ${quote(candidate)} 2>> ${quote(stderr)}; then printf 'submit-receipt-cleanup-failed'; exit 0; fi; fi; printf 'submit-status:%s' "$rc"`;
			const submitted = await transport.exec(
				{
					executable: "bash",
					args: ["-c", script],
					cwd: request.payload.workLocation.path,
					env: configuration.environment || {}
				},
				io
			);
			const status = Buffer.from(submitted.stdout || "").toString("ascii").trim();
			const publicationFailure = {
				"submit-receipt-sync-failed": "SLURM_SUBMIT_RECEIPT_SYNC_FAILED",
				"submit-receipt-publish-failed": "SLURM_SUBMIT_RECEIPT_PUBLISH_FAILED"
			}[status];
			const cleanupFailed = status === "submit-receipt-cleanup-failed";
			const directlySubmitted = submitted.exitCode === 0 &&
				(status === "submit-status:0" || cleanupFailed);
			const claimEvidence = [`${state}/slurm-submit-claim`, ...(publicationFailure || cleanupFailed ? [candidate, stderr] : [])];
			const identity = await submission(request, io);
			if (!identity)
				return response(
					protocol,
					request,
					{
						evidenceRefs: claimEvidence,
						reason: publicationFailure || "SUBMISSION_CLAIM_WITHOUT_RECEIPT"
					},
					"waiting-verification",
					{ executionState: "unknown", verificationState: "unknown" }
				);
			return response(
				protocol,
				request,
				{ launchIdentity: identity, evidenceRefs: publicationFailure ? claimEvidence :
					cleanupFailed ? [receiptPath, ...claimEvidence] : [receiptPath],
					...(directlySubmitted && !identity.recoveredBy ? {
						schedulerSubmissionIdentity: { ...identity, workPath: request.payload.workLocation.path }
					} : {}) },
				"completed",
				{ executionState: "queued", verificationState: "verified" }
			);
		},
		async inspect(request, io) {
			validate(protocol, request, "inspect");
			const identity = await submission(request, io),
				state = statePath(request);
			if (!identity) {
				const cancelled = await cancelledScheduler(request, io);
				if (cancelled)
					return response(
						protocol,
						request,
						{ endReceipt: cancelled, evidenceRefs: cancelled.evidenceRefs },
						"completed",
						{
							executionState: "ended",
							endReason: "stopped",
							verificationState: "verified",
							notStarted: true,
							resultPreparation: "not-started",
							relatedActivityEnded: true
						}
					);
			}
			if (!identity)
				return response(
					protocol,
					request,
					{
						evidenceRefs: [`${state}/slurm-submit-claim`],
						reason: "SUBMISSION_RECEIPT_MISSING_DO_NOT_RESUBMIT"
					},
					"waiting-verification",
					{ executionState: "unknown", verificationState: "unknown" }
				);
			const observed = await inspectScheduler(request, identity, io),
				launchRaw = await read(`${state}/launch.json`, io),
				endRaw = await read(`${state}/end.json`, io),
				nativeEnd = endRaw ? JSON.parse(endRaw) : null;
			const nativeLaunch = launchRaw ? JSON.parse(launchRaw) : null;
			const preparationLaunchRaw = await read(`${state}/preparation-launch.json`, io),
				preparationEndRaw = await read(`${state}/preparation-end.json`, io);
			const preparationLaunch = preparationLaunchRaw ? JSON.parse(preparationLaunchRaw) : null,
				preparationEnd = preparationEndRaw ? JSON.parse(preparationEndRaw) : null;
			if (
				nativeEnd &&
				(nativeEnd.runId !== request.runId ||
					nativeEnd.submissionIntentId !== request.submissionIntentId)
			)
				fail("SLURM_RECEIPT_CONFLICT");
			for (const receipt of [nativeLaunch, preparationLaunch, preparationEnd].filter(Boolean))
				if (
					receipt.runId !== request.runId ||
					receipt.submissionIntentId !== request.submissionIntentId ||
					receipt.taskId !== request.taskId
				)
					fail("SLURM_RECEIPT_CONFLICT");
			const schedulerEndReceipt = await schedulerEnd(request, identity, observed, state, io);
			const incompleteTerminal = observed.status === "ended" && !nativeEnd && !schedulerEndReceipt;
			return response(
				protocol,
				request,
				{
					launchIdentity: identity,
					scheduler: observed,
					endReceipt: nativeEnd,
					launchReceipt: nativeLaunch,
					schedulerEndReceipt,
					preparationLaunch,
					preparationEnd,
					evidenceRefs: [...new Set([`${state}/slurm-submit.txt`, ...(nativeEnd ? [`${state}/end.json`] : []),
						...(schedulerEndReceipt?.evidenceRefs || [])])]
				},
				incompleteTerminal || ["unknown", "conflict"].includes(observed.status) ? "waiting-verification" : "completed",
				{
					executionState: !incompleteTerminal && ["queued", "running", "ended"].includes(observed.status)
						? observed.status
						: "unknown",
					verificationState:
						observed.status === "conflict"
							? "conflict"
							: observed.status === "unknown" || incompleteTerminal
								? "unknown"
								: "verified",
					...(observed.endReason ? { endReason: observed.endReason } : {}),
					...(schedulerEndReceipt ? { relatedActivityEnded: true } : {})
				}
			);
		},
		async requestStop(request, io) {
			validate(protocol, request, "requestStop");
			const identity = await submission(request, io);
			if (!identity) {
				const state = statePath(request),
					marker = `${state}/slurm-submit-claim/cancelled.json`;
				const ownerRaw =
						(await read(`${state}/manifest.json`, io)) ||
						(await read(`${state}/location-owner.json`, io)),
					owner = ownerRaw ? JSON.parse(ownerRaw) : null;
				if (
					!owner ||
					owner.runId !== request.runId ||
					owner.taskId !== request.taskId ||
					owner.submissionIntentId !== request.submissionIntentId
				)
					return response(
						protocol,
						request,
						{ evidenceRefs: [state], reason: "SUBMISSION_OWNER_NOT_READY" },
						"waiting-verification",
						{ executionState: "stop-requested", verificationState: "unknown" }
					);
				let won = false;
				try {
					await transport.mkdirExclusive(`${state}/slurm-submit-claim`, io);
					const bytes = Buffer.from(
						JSON.stringify({
							protocolVersion: 1,
							taskId: request.taskId,
							runId: request.runId,
							submissionIntentId: request.submissionIntentId,
							cancelled: true,
							operationId: owner.operationId,
							stopOperationId: request.operationId,
							cancelledAt: now()
						})
					);
					await transport.putAtomic(
						{
							path: marker,
							expectedAbsent: true,
							source: bytes,
							byteSize: bytes.length,
							sha256: sha256(bytes)
						},
						io
					);
					won = true;
				} catch (error) {
					if (
						error.code !== "WORK_DIRECTORY_EXISTS" &&
						!(
							error.code === "POSIX_CONTROL_FAILED" &&
							/File exists/.test(error.details?.stderr || "")
						)
					)
						return response(
							protocol,
							request,
							{ evidenceRefs: [state], reason: "SUBMISSION_GATE_NOT_READY" },
							"waiting-verification",
							{ executionState: "stop-requested", verificationState: "unknown" }
						);
				}
				if (!won) {
					const previous = await read(marker, io);
					if (previous) {
						const value = JSON.parse(previous);
						won =
							value.cancelled === true &&
							value.runId === request.runId &&
							value.submissionIntentId === request.submissionIntentId;
					}
				}
				if (won) {
					const cancelled = await cancelledScheduler(request, io);
					return response(
						protocol,
						request,
						{ endReceipt: cancelled, evidenceRefs: [marker], notStarted: true },
						"completed",
						{
							executionState: "ended",
							endReason: "stopped",
							verificationState: "verified",
							notStarted: true,
							resultPreparation: "not-started",
							relatedActivityEnded: true
						}
					);
				}
				return response(
					protocol,
					request,
					{ evidenceRefs: [statePath(request)] },
					"waiting-verification",
					{ executionState: "unknown", verificationState: "unknown" }
				);
			}
			const observed = await inspectScheduler(request, identity, io);
			if (observed.status === "ended")
				return response(protocol, request, { scheduler: observed, evidenceRefs: [statePath(request)] },
					"waiting-verification", { executionState: "unknown", verificationState: "unknown" });
			if (!["queued", "running"].includes(observed.status))
				return response(
					protocol,
					request,
					{ scheduler: observed, evidenceRefs: [statePath(request)] },
					observed.status === "ended" ? "completed" : "waiting-verification",
					{
						executionState: observed.status === "ended" ? "ended" : "unknown",
						...(observed.endReason ? { endReason: observed.endReason } : {})
					}
				);
			const clusterArgs = identity.cluster ? ["--clusters", identity.cluster] : [];
			const stop = await exec(request, "scancel", [...clusterArgs, "--user", user, identity.jobId], io);
			return response(
				protocol,
				request,
				{ stopRequested: stop.exitCode === 0, evidenceRefs: [statePath(request)] },
				stop.exitCode === 0 ? "accepted" : "waiting-verification",
				{
					executionState: "stop-requested",
					verificationState: stop.exitCode === 0 ? "verified" : "unknown"
				}
			);
		},
		async prepareResult(request) {
			validate(protocol, request, "submit");
			return response(
				protocol,
				request,
				{
					evidenceRefs: [statePath(request)],
					reason: "ORIGINAL_ALLOCATION_REQUIRED_NO_LOGIN_NODE_CONVERSION"
				},
				"waiting-verification",
				{ resultPreparation: "pending" }
			);
		},
		collectArtifacts: (request, io) => processAdapter.collectArtifacts(request, io)
	};
	return adapter;
}
module.exports = {
	createSlurmAdapter,
	buildSlurmScript,
	renderSlurmScript,
	inspectSlurmCapabilities,
	SLURM_TEMPLATE_VARIABLES,
	parseJobId,
	renderSubmitCommand,
	TERMINAL
};
