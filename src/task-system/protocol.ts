import schema from "./schema-v1.json";
import {
	TASK_SYSTEM_CAPABILITIES,
	type ExecutionRequest,
	type ExecutionResponse,
	type RecordKind,
	type TaskEvent
} from "./contracts";
export { TASK_SYSTEM_CAPABILITIES } from "./contracts";
export * from "./state";

export interface ValidationIssue {
	path: string;
	code: string;
	message: string;
}
export interface ValidationOptions {
	supportedCapabilities?: readonly string[];
	forWrite?: boolean;
}
export const SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const RECORD_ID_FIELDS: Readonly<Record<RecordKind, string>> = {
	task: "taskId",
	run: "runId",
	inputSnapshot: "inputSnapshotId",
	environment: "environmentId",
	artifact: "artifactId",
	operation: "operationId",
	group: "groupId",
	groupMembership: "membershipId",
	siteProfile: "siteId",
	sourceSet: "sourceSetId",
	projectAssociation: "associationId",
	snapshot: "snapshotId",
	archiveManifest: "manifestId",
	cleanupManifest: "manifestId",
	recycleRecord: "recycleId",
	library: "libraryId"
};
export class TaskProtocolError extends Error {
	readonly code: string;
	readonly issues: ValidationIssue[];
	constructor(code: string, issues: ValidationIssue[] = []) {
		super(code);
		this.name = "TaskProtocolError";
		this.code = code;
		this.issues = issues;
	}
}
type ObjectValue = Record<string, unknown>;
type Schema = { [key: string]: unknown };
function object(value: unknown): value is ObjectValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function check(value: unknown, rule: Schema, path: string, issues: ValidationIssue[]): void {
	const bad = (code: string, message: string) => issues.push({ path, code, message });
	if (typeof rule.$ref === "string") {
		check(
			value,
			(schema.$defs as unknown as Record<string, Schema>)[rule.$ref.split("/").at(-1)!],
			path,
			issues
		);
		return;
	}
	if ("const" in rule && value !== rule.const) bad("CONST", `Expected ${String(rule.const)}`);
	if (Array.isArray(rule.enum) && !rule.enum.includes(value))
		bad("ENUM", "Value is outside protocol v1 enum");
	if (
		Array.isArray(rule.anyOf) &&
		!rule.anyOf.some((r) => {
			const trial: ValidationIssue[] = [];
			check(value, r as Schema, path, trial);
			return !trial.length;
		})
	)
		bad("ANY_OF", "Value does not match permitted forms");
	if (Array.isArray(rule.allOf))
		for (const child of rule.allOf) check(value, child as Schema, path, issues);
	if (rule.if) {
		const trial: ValidationIssue[] = [];
		check(value, rule.if as Schema, path, trial);
		if (!trial.length && rule.then) check(value, rule.then as Schema, path, issues);
	}
	if (rule.type) {
		const match =
			rule.type === "object"
				? object(value)
				: rule.type === "array"
					? Array.isArray(value)
					: rule.type === "integer"
						? Number.isSafeInteger(value)
						: rule.type === "null"
							? value === null
							: rule.type === "number"
								? typeof value === "number" && Number.isFinite(value)
								: typeof value === rule.type;
		if (!match) {
			bad("TYPE", `Expected ${String(rule.type)}`);
			return;
		}
	}
	if (typeof value === "string") {
		if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value))
			bad("PATTERN", "Value does not match protocol format");
		if (typeof rule.minLength === "number" && value.length < rule.minLength)
			bad("EMPTY", "Nonempty string required");
		if (
			rule.format === "date-time" &&
			(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
				!Number.isFinite(Date.parse(value)))
		)
			bad("UTC_TIME", "ISO 8601 UTC time required");
	}
	if (typeof value === "number") {
		if (typeof rule.minimum === "number" && value < rule.minimum)
			bad("MINIMUM", `Minimum ${rule.minimum}`);
		if (typeof rule.maximum === "number" && value > rule.maximum)
			bad("MAXIMUM", `Maximum ${rule.maximum}`);
	}
	if (Array.isArray(value)) {
		if (typeof rule.minItems === "number" && value.length < rule.minItems)
			bad("MIN_ITEMS", "Insufficient items");
		if (typeof rule.maxItems === "number" && value.length > rule.maxItems)
			bad("MAX_ITEMS", "Too many items");
		if (
			rule.contains &&
			!value.some((item) => {
				const trial: ValidationIssue[] = [];
				check(item, rule.contains as Schema, path, trial);
				return !trial.length;
			})
		)
			bad("CONTAINS", "Required collection member missing");
		if (rule.items)
			value.forEach((item, index) =>
				check(item, rule.items as Schema, `${path}[${index}]`, issues)
			);
	}
	if (object(value)) {
		if (Array.isArray(rule.required))
			for (const key of rule.required)
				if (typeof key === "string" && !Object.hasOwn(value, key))
					issues.push({
						path: `${path}.${key}`,
						code: "REQUIRED",
						message: "Required field missing"
					});
		const properties = rule.properties as Record<string, Schema> | undefined;
		for (const [key, child] of Object.entries(value)) {
			if (properties && Object.hasOwn(properties, key))
				check(child, properties[key], `${path}.${key}`, issues);
			else if (object(rule.additionalProperties))
				check(child, rule.additionalProperties, `${path}.${key}`, issues);
		}
	}
}
function jsonIssues(value: unknown, path = "$", ancestors = new Set<unknown>()): ValidationIssue[] {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return [];
	if (
		typeof value !== "object" ||
		ancestors.has(value) ||
		(!Array.isArray(value) &&
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		return [{ path, code: "JSON_VALUE", message: "Finite JSON data required" }];
	const next = new Set(ancestors).add(value);
	return Object.entries(value as ObjectValue).flatMap(([key, child]) =>
		jsonIssues(child, `${path}.${key}`, next)
	);
}
function definition(name: string, value: unknown): ValidationIssue[] {
	const issues = jsonIssues(value);
	const rule = (schema.$defs as unknown as Record<string, Schema>)[name];
	if (!rule) issues.push({ path: "$", code: "UNKNOWN_RECORD", message: name });
	else check(value, rule, "$", issues);
	return issues;
}
function fieldKnown(
	record: ObjectValue,
	key: string,
	issues: ValidationIssue[],
	path: string
): void {
	if (record[key] !== null) return;
	const statuses = record.fieldStatus;
	if (
		!object(statuses) ||
		!object(statuses[key]) ||
		statuses[key].state === "known" ||
		!statuses[key].reason
	)
		issues.push({
			path: `${path}.${key}`,
			code: "UNKNOWN_REASON_REQUIRED",
			message: "Unknown fact requires fieldStatus reason"
		});
}
export function validateRecord(
	kind: RecordKind,
	value: unknown,
	options: ValidationOptions = {}
): ValidationIssue[] {
	const issues = definition(kind, value);
	if (!object(value)) return issues;
	const requireCapability = (capability: string, path: string) => {
		if (
			!Array.isArray(value.requiredCapabilities) ||
			!value.requiredCapabilities.includes(capability)
		)
			issues.push({ path, code: "CAPABILITY_REQUIRED", message: capability });
	};
	// These fields change write/cleanup meaning. Old opaque optional-field roundtrips
	// cannot safely substitute for explicit support of the new behavior.
	if (kind === "task" && value.directoryMode !== undefined) {
		if (!["single", "dual"].includes(String(value.directoryMode)))
			issues.push({
				path: "$.directoryMode",
				code: "ENUM",
				message: "Explicit directory mode must be single or dual"
			});
		requireCapability(TASK_SYSTEM_CAPABILITIES.taskLayout, "$.directoryMode");
	}
	if (
		(kind === "inputSnapshot" &&
			object(value.engineExtensions) &&
			value.engineExtensions.fileLayout === "task-relative-v1") ||
		(kind === "archiveManifest" && value.fileLayout === "task-relative-v1")
	)
		requireCapability(TASK_SYSTEM_CAPABILITIES.taskLayout, "$.requiredCapabilities");
	if (kind === "cleanupManifest" && value.kind === "clear-work")
		requireCapability(TASK_SYSTEM_CAPABILITIES.clearWork, "$.kind");
	if (kind === "operation" && value.type === "overwrite-task")
		requireCapability(TASK_SYSTEM_CAPABILITIES.overwriteSubmission, "$.type");
	if (kind === "run" && value.resultAdoptionOperationId !== undefined)
		requireCapability(TASK_SYSTEM_CAPABILITIES.resultAdoption, "$.resultAdoptionOperationId");
	if (kind === "operation" && value.type === "result-adoption")
		requireCapability(TASK_SYSTEM_CAPABILITIES.resultAdoption, "$.type");
	if (kind === "run" && object(value.executionIdentity) && value.executionIdentity.schedulerEndReceipt)
		requireCapability(TASK_SYSTEM_CAPABILITIES.slurmSchedulerEnd, "$.executionIdentity.schedulerEndReceipt");
	if (options.forWrite && Array.isArray(value.requiredCapabilities))
		for (const capability of value.requiredCapabilities)
			if (typeof capability === "string" && !options.supportedCapabilities?.includes(capability))
				issues.push({
					path: "$.requiredCapabilities",
					code: "UNSUPPORTED_CAPABILITY",
					message: capability
				});
	if (kind === "run") {
		if (object(value.softwareSnapshot))
			for (const key of ["rawVersion", "recognizedVersion", "entryIdentity"])
				fieldKnown(value.softwareSnapshot, key, issues, "$.softwareSnapshot");
		if (object(value.executionIdentity))
			for (const key of [
				"submissionIntentId",
				"workLocation",
				"executorIdentity",
				"launchIdentity",
				"launchReceipt",
				"endReceipt"
			])
				fieldKnown(value.executionIdentity, key, issues, "$.executionIdentity");
		if (object(value.resources))
			for (const key of ["inputRequest", "schedulerRequest", "grant", "observation"])
				fieldKnown(value.resources, key, issues, "$.resources");
	}
	if (kind === "inputSnapshot") fieldKnown(value, "dependencies", issues, "$");
	if (kind === "task" || kind === "sourceSet") {
		const summary = kind === "task" ? value.sourceSummary : value.summary;
		if (object(summary)) {
			for (const key of ["sourceSetId", "sourceVersion"])
				if (value[key] !== summary[key])
					issues.push({
						path: `$.${kind === "task" ? "sourceSummary" : "summary"}.${key}`,
						code: "SOURCE_IDENTITY",
						message: "Summary must bind the owning source set and version"
					});
			if (
				kind === "sourceSet" &&
				Array.isArray(value.files) &&
				!value.files.some((file) => object(file) && file.sha256 === summary.sourceSha256)
			)
				issues.push({
					path: "$.summary.sourceSha256",
					code: "SOURCE_IDENTITY",
					message: "Summary must bind a manifest source SHA"
				});
		}
	}
	if (kind === "artifact")
		for (const key of [
			"format",
			"formatVersion",
			"locations",
			"provenance",
			"producer",
			"byteSize",
			"contentHash"
		])
			fieldKnown(value, key, issues, "$");
	if (kind === "artifact" && object(value.sourceBoundary))
		for (const key of ["readByteRange", "publishedByteRange", "consumedByteRange"]) {
			const range = value.sourceBoundary[key];
			if (
				object(range) &&
				typeof range.start === "number" &&
				typeof range.end === "number" &&
				range.end < range.start
			)
				issues.push({
					path: `$.sourceBoundary.${key}`,
					code: "BYTE_RANGE",
					message: "Byte end precedes start"
				});
		}
	if (kind === "artifact" && object(value.sourceBoundary)) {
		const boundary = value.sourceBoundary;
		const read = boundary.readByteRange,
			published = boundary.publishedByteRange,
			consumed = boundary.consumedByteRange;
		if (
			object(read) &&
			object(published) &&
			typeof read.start === "number" &&
			typeof read.end === "number" &&
			typeof published.start === "number" &&
			typeof published.end === "number" &&
			(published.start < read.start || published.end > read.end)
		)
			issues.push({
				path: "$.sourceBoundary.publishedByteRange",
				code: "BYTE_BOUNDARY",
				message: "Published bytes must belong to the observed read range"
			});
		if (
			typeof boundary.observedEnd === "number" &&
			object(read) &&
			typeof read.end === "number" &&
			boundary.observedEnd < read.end
		)
			issues.push({
				path: "$.sourceBoundary.observedEnd",
				code: "BYTE_BOUNDARY",
				message: "Observed end precedes read bytes"
			});
		if (
			object(consumed) &&
			object(read) &&
			typeof consumed.end === "number" &&
			typeof read.end === "number" &&
			consumed.end > read.end
		)
			issues.push({
				path: "$.sourceBoundary.consumedByteRange",
				code: "BYTE_BOUNDARY",
				message: "Consumed end exceeds read bytes"
			});
	}
	return issues;
}
export function assertRecord(
	kind: RecordKind,
	value: unknown,
	options: ValidationOptions = {}
): asserts value is ObjectValue {
	const issues = validateRecord(kind, value, options);
	if (issues.length) throw new TaskProtocolError("INVALID_RECORD", issues);
}
/** Full record plus recursive patches; arrays and explicit null replace, absent keys retain. */
export function mergeRecord<T>(previous: T, patch: unknown): T {
	if (!object(previous) || !object(patch)) return structuredClone(patch) as T;
	const result: ObjectValue = structuredClone(previous);
	for (const [key, value] of Object.entries(patch)) {
		const merged =
			object(value) && object(result[key])
				? mergeRecord(result[key], value)
				: structuredClone(value);
		// Unknown JSON keys roundtrip as own data, including prototype-sensitive names.
		Object.defineProperty(result, key, {
			value: merged,
			enumerable: true,
			writable: true,
			configurable: true
		});
	}
	return result as T;
}
export function validateExecutionRequest(value: unknown): ValidationIssue[] {
	return definition("executionRequest", value);
}
export function assertExecutionRequest(value: unknown): asserts value is ExecutionRequest {
	const issues = validateExecutionRequest(value);
	if (issues.length) throw new TaskProtocolError("INVALID_REQUEST", issues);
}
export function validateExecutionResponse(
	value: unknown,
	request?: ExecutionRequest
): ValidationIssue[] {
	const issues = definition("executionResponse", value);
	if (request && object(value))
		for (const key of [
			"protocolVersion",
			"requestId",
			"action",
			"taskId",
			"runId",
			"submissionIntentId",
			"operationId"
		] as const)
			if (request[key] !== undefined && value[key] !== request[key])
				issues.push({
					path: `$.${key}`,
					code: "RESPONSE_IDENTITY",
					message: "Response does not echo request identity"
				});
	return issues;
}
export function assertExecutionResponse(
	value: unknown,
	request?: ExecutionRequest
): asserts value is ExecutionResponse {
	const issues = validateExecutionResponse(value, request);
	if (issues.length) throw new TaskProtocolError("INVALID_RESPONSE", issues);
}
export function validateEvent(value: unknown): ValidationIssue[] {
	const issues = definition("event", value);
	if (object(value) && typeof value.eventType === "string") {
		if (/^(run\.|artifact\.|operation\.)/.test(value.eventType) && !value.taskId)
			issues.push({ path: "$.taskId", code: "REQUIRED", message: "Task event requires taskId" });
		if (/^run\./.test(value.eventType) && !value.runId)
			issues.push({ path: "$.runId", code: "REQUIRED", message: "Run event requires runId" });
		if (value.eventType === "run.scheduler-ended" &&
			(!value.operationId || !value.submissionIntentId || !Array.isArray(value.requiredCapabilities) ||
				!value.requiredCapabilities.includes(TASK_SYSTEM_CAPABILITIES.slurmSchedulerEnd)))
			issues.push({ path: "$.requiredCapabilities", code: "SCHEDULER_END_IDENTITY",
				message: "Scheduler END requires the original operation, intent and capability" });
		if (
			/^artifact\./.test(value.eventType) &&
			!value.runId &&
			(value.runId !== null ||
				!value.sourceSetId ||
				!Array.isArray(value.requiredCapabilities) ||
				!value.requiredCapabilities.includes(TASK_SYSTEM_CAPABILITIES.sourceOnly))
		)
			issues.push({
				path: "$.runId",
				code: "SOURCE_IDENTITY",
				message: "Source-only artifact event requires null run, source set and capability"
			});
		if (/^operation\./.test(value.eventType) && !value.operationId)
			issues.push({
				path: "$.operationId",
				code: "REQUIRED",
				message: "Operation event requires operationId"
			});
		if (
			value.eventType === "monitor.published" &&
			(!Number.isSafeInteger(value.sourceRevision) || !Number.isSafeInteger(value.managerEpoch))
		)
			issues.push({
				path: "$",
				code: "MONITOR_VERSION",
				message: "Monitor publication requires revision and epoch"
			});
		if (
			!/^(run\.|artifact\.|operation\.|monitor\.)/.test(value.eventType) &&
			!value.eventType.includes(":")
		)
			issues.push({
				path: "$.eventType",
				code: "EVENT_NAMESPACE",
				message: "Extension event requires namespace"
			});
		if (
			!/^(run\.|artifact\.|operation\.|monitor\.)/.test(value.eventType) &&
			(!Array.isArray(value.requiredCapabilities) ||
				!value.requiredCapabilities.length ||
				value.requiredCapabilities.some((item) => typeof item !== "string" || !item.includes(":")))
		)
			issues.push({
				path: "$.requiredCapabilities",
				code: "EVENT_CAPABILITY",
				message: "Extension event requires namespaced capability declaration"
			});
	}
	return issues;
}
export function assertEvent(value: unknown): asserts value is TaskEvent {
	const issues = validateEvent(value);
	if (issues.length) throw new TaskProtocolError("INVALID_EVENT", issues);
}
export { schema as TASK_SYSTEM_SCHEMA };
