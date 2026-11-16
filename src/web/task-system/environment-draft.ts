import type { EnvironmentView } from "../../task-system/application-contracts";
import { detectClientPlatform, isSshOnlyClientPlatform } from "./environment-assistant";

/**
 * Pure environment draft helpers shared by the Task Center environment dialog
 * and the MCP `ester_environment_manage` tool so both apply identical defaults
 * and field validation.
 */
export type EnvironmentPathField = "executable" | "workingRoot" | "privateKeyPath";
export type EnvironmentMode = "local" | "wsl" | "ssh" | "slurm";
export type EnvironmentTextField =
	| EnvironmentPathField
	| "displayName"
	| "host"
	| "user"
	| "distribution"
	| "partition"
	| "account"
	| "qos"
	| "timeLimit";

export const DEFAULT_MODE_LABELS: Record<EnvironmentMode, string> = {
	local: "Windows 本机",
	wsl: "WSL2",
	ssh: "SSH服务器",
	slurm: "SSH + Slurm"
};

export function engineDisplayLabel(engine: EnvironmentView["engineId"]): string {
	return engine === "gaussian" ? "Gaussian" : "ORCA";
}

export function defaultEnvironmentDisplayName(
	engine: EnvironmentView["engineId"],
	mode: EnvironmentMode
): string {
	return `${engineDisplayLabel(engine)} · ${DEFAULT_MODE_LABELS[mode]}`;
}

export function isDefaultEnvironmentDisplayName(displayName: string): boolean {
	return ["Gaussian", "ORCA"].some((engineLabel) =>
		Object.values(DEFAULT_MODE_LABELS).some(
			(modeLabel) => displayName === `${engineLabel} · ${modeLabel}`
		)
	);
}

export function environmentMode(
	value: Pick<EnvironmentView, "connectionKind" | "schedulerKind">
): EnvironmentMode {
	return value.connectionKind === "ssh" && value.schedulerKind === "slurm"
		? "slurm"
		: value.connectionKind;
}

export function newEnvironment(platform?: string): EnvironmentView {
	const sshOnly = isSshOnlyClientPlatform(platform);
	return {
		environmentId: "",
		revision: 0,
		displayName: sshOnly ? "Gaussian · SSH服务器" : "Gaussian · Windows 本机",
		engineId: "gaussian",
		connectionKind: sshOnly ? "ssh" : "local",
		schedulerKind: "none",
		host: "",
		port: 22,
		user: "",
		distribution: "",
		executable: "",
		workingRoot: "",
		scratchRoot: "",
		partition: "",
		account: "",
		qos: "",
		timeLimit: "",
		initialization: "",
		scriptTemplate: "",
		calculationTemplate: "",
		submitCommandTemplate: "",
		authentication: "agent",
		privateKeyPath: ""
	};
}

/** Compatibility projection for historical callers; new forms have no external scratch control. */
export function isValidEnvironmentPath(
	key: EnvironmentPathField,
	value: string,
	connectionKind: EnvironmentView["connectionKind"],
	platform?: string
): boolean {
	const isPosixTarget =
		key === "privateKeyPath"
			? detectClientPlatform(platform) !== "win32"
			: connectionKind !== "local";
	return isPosixTarget
		? value.startsWith("/") && !value.includes("\0")
		: /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}

/** Field-level validity identical to the environment dialog (port handled separately). */
export function environmentFieldInvalid(
	draft: EnvironmentView,
	key: EnvironmentTextField,
	platform?: string
): boolean {
	const value = draft[key] ?? "";
	if (["partition", "account", "qos", "timeLimit"].includes(key) && value)
		return (
			value !== value.trim() ||
			(key === "timeLimit"
				? !/^(?:\d+(?:-\d+)?(?::\d{1,2}){0,2}|UNLIMITED|INFINITE)$/i.test(value)
				: !/^[A-Za-z0-9_.@,+:-]+$/.test(value))
		);
	if (
		["displayName", "executable", "workingRoot", "host", "user", "distribution"].includes(key) &&
		!value.trim()
	)
		return true;
	return (
		["executable", "workingRoot", "privateKeyPath"].includes(key) &&
		!isValidEnvironmentPath(key as EnvironmentPathField, value, draft.connectionKind, platform)
	);
}

export interface EnvironmentDraftIssue {
	field: EnvironmentTextField | "port" | "connectionKind";
	message: string;
}

const FIELD_MESSAGES: Record<EnvironmentTextField, string> = {
	displayName: "环境名称不能为空",
	executable: "可执行文件必须为执行目标上的绝对路径",
	workingRoot: "工作目录必须为执行目标上的绝对路径",
	host: "SSH 主机不能为空",
	user: "用户名不能为空",
	distribution: "WSL 发行版名称不能为空",
	privateKeyPath: "私钥文件必须为本机绝对路径",
	partition: "Slurm partition 只能包含字母、数字与 _.@,+:-",
	account: "Slurm account 只能包含字母、数字与 _.@,+:-",
	qos: "Slurm QoS 只能包含字母、数字与 _.@,+:-",
	timeLimit: "Slurm 时间限制格式无效（如 24:00:00、2-00:00:00、UNLIMITED）"
};

/** Whole-draft validation equivalent to the dialog's save/check enablement. */
export function environmentDraftIssues(
	draft: EnvironmentView,
	platform?: string
): EnvironmentDraftIssue[] {
	const issues: EnvironmentDraftIssue[] = [];
	const push = (field: EnvironmentTextField) => {
		if (environmentFieldInvalid(draft, field, platform))
			issues.push({ field, message: FIELD_MESSAGES[field] });
	};
	if (isSshOnlyClientPlatform(platform) && draft.connectionKind !== "ssh")
		issues.push({
			field: "connectionKind",
			message: "当前操作系统仅支持 SSH 服务器或 SSH + Slurm 执行环境"
		});
	push("displayName");
	push("executable");
	push("workingRoot");
	if (draft.connectionKind === "wsl") {
		push("distribution");
		push("user");
	}
	if (draft.connectionKind === "ssh") {
		push("host");
		if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)
			issues.push({ field: "port", message: "SSH 端口必须为 1-65535 的整数" });
		push("user");
		if (draft.authentication === "private-key") push("privateKeyPath");
		if (draft.schedulerKind === "slurm") {
			push("partition");
			push("account");
			push("qos");
			push("timeLimit");
		}
	}
	return issues;
}
