import { useEffect, useId, useRef, useState } from "react";
import type {
	EnvironmentSecretPayload,
	EnvironmentView,
	HostKeyChallenge,
	TaskSystemBridge,
	EnvironmentImportPreview,
	EnvironmentBrowseResult,
	SiteProfileView
} from "../../task-system/application-contracts";
import {
	calculationTemplateVariables,
	detectClientPlatform,
	submitTemplateVariables,
	environmentConfigurationMarkdown,
	initializationSnippets,
	environmentPathPlaceholder,
	isMacClientPlatform
} from "./environment-assistant";
import TaskFieldHelp from "./TaskFieldHelp";
import DialogShell from "../DialogShell";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope } from "./task-error-scope";
import "./environment-submit.css";
const siteKeys = [
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
] as const;
type PathField = "executable" | "workingRoot" | "privateKeyPath";
export type EnvironmentMode = "local" | "wsl" | "ssh" | "slurm";
const DEFAULT_MODE_LABELS: Record<EnvironmentMode, string> = {
	local: "Windows 本机",
	wsl: "WSL2",
	ssh: "SSH服务器",
	slurm: "SSH + Slurm"
};
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
export function environmentDraftForMode(
	current: EnvironmentView,
	mode: EnvironmentMode,
	engine: EnvironmentView["engineId"],
	remembered: EnvironmentView | undefined,
	customName: boolean,
	platform?: string
): EnvironmentView {
	const connectionKind = mode === "slurm" ? "ssh" : mode;
	const next = remembered ?? {
		...(connectionKind === current.connectionKind && engine === current.engineId
			? current
			: newEnvironment(platform)),
		engineId: engine,
		connectionKind,
		schedulerKind: mode === "slurm" ? "slurm" : "none"
	};
	// The Slurm owner retains its complete draft before this projection. A
	// hidden site-managed policy must never become an active non-Slurm config.
	const { slurmMemoryPolicy: _slurmMemoryPolicy, ...nonSlurm } = next;
	return {
		...(mode === "slurm" ? next : nonSlurm),
		environmentId: current.environmentId,
		revision: current.revision,
		displayName: customName
			? current.displayName
			: `${engine === "gaussian" ? "Gaussian" : "ORCA"} · ${{ local: "Windows 本机", wsl: "WSL2", ssh: "SSH服务器", slurm: "SSH + Slurm" }[mode]}`
	};
}
type TextField =
	| PathField
	| "displayName"
	| "host"
	| "user"
	| "distribution"
	| "partition"
	| "account"
	| "qos"
	| "timeLimit";
export interface EnvironmentSettingsProps {
	bridge: TaskSystemBridge;
	environments: EnvironmentView[];
	canManage: boolean;
	onChanged(): void | Promise<void>;
	onClose(): void;
}
export function newEnvironment(platform?: string): EnvironmentView {
	const mac = isMacClientPlatform(platform);
	return {
		environmentId: "",
		revision: 0,
		displayName: mac ? "Gaussian · SSH服务器" : "Gaussian · Windows 本机",
		engineId: "gaussian",
		connectionKind: mac ? "ssh" : "local",
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
	key: PathField,
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
export function environmentScratchState(
	draft: Pick<EnvironmentView, "engineId" | "connectionKind" | "scratchRoot">
) {
	return {
		supported: false,
		blocked: Boolean(draft.scratchRoot),
		disabled: !draft.scratchRoot,
		hint: "本次临时文件由任务工作目录管理。"
	};
}
export function EnvironmentCheckFeedback({
	message,
	details
}: {
	message: string;
	details?: string;
}) {
	if (!message && !details) return null;
	return (
		<div className="task-environment-feedback">
			{message && <p role="status">{message}</p>}
			{details && (
				<details>
					<summary>检测详情</summary>
					<pre>{details}</pre>
				</details>
			)}
		</div>
	);
}
function configurationIdentity(value: EnvironmentView, port: string) {
	const {
		check: _check,
		templateVariables: _variables,
		environmentId: _id,
		revision: _revision,
		...configuration
	} = value;
	return JSON.stringify({ ...configuration, port });
}
export default function EnvironmentSettings({
	bridge,
	environments,
	canManage,
	onChanged,
	onClose
}: EnvironmentSettingsProps) {
	const prefix = useId(),
		initial = environments[0] ?? newEnvironment();
	const [draft, setDraft] = useState<EnvironmentView>({ ...initial }),
		[port, setPort] = useState(String(initial.port));
	const [baseline, setBaseline] = useState(configurationIdentity(initial, String(initial.port)));
	const [secret, setSecret] = useState(""),
		[remember, setRemember] = useState(false),
		[pending, setPending] = useState(false);
	const [message, setMessage] = useState(""),
		[messageDetails, setMessageDetails] = useState(""),
		[checked, setChecked] = useState(initial.check);
	const [challenge, setChallenge] = useState<HostKeyChallenge | null>(null),
		[touched, setTouched] = useState<Record<string, boolean>>({});
	const [sites, setSites] = useState<SiteProfileView[]>([]),
		[siteName, setSiteName] = useState(""),
		[siteEditing, setSiteEditing] = useState(false),
		[siteEditId, setSiteEditId] = useState("");
	const [deleting, setDeleting] = useState(false),
		[deletingSite, setDeletingSite] = useState(false);
	const [importOpen, setImportOpen] = useState(false),
		[paste, setPaste] = useState(""),
		[imported, setImported] = useState<EnvironmentImportPreview | null>(null);
	const [documentPreservation, setDocumentPreservation] =
			useState<EnvironmentImportPreview["preserved"]>(),
		[requiredCapabilities, setRequiredCapabilities] = useState<string[]>();
	const [browser, setBrowser] = useState<{
		field: PathField;
		result: EnvironmentBrowseResult;
	} | null>(null);
	const [documentOpen, setDocumentOpen] = useState(false),
		[includeScripts, setIncludeScripts] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false),
		[siteOpen, setSiteOpen] = useState(false),
		[documentSaved, setDocumentSaved] = useState(false);
	const [customCalculation, setCustomCalculation] = useState(Boolean(initial.calculationTemplate)),
		[customSubmit, setCustomSubmit] = useState(Boolean(initial.submitCommandTemplate));
	const [snippet, setSnippet] = useState(""),
		[templateReset, setTemplateReset] = useState(false);
	const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
	const modes = useRef<Record<string, EnvironmentView>>({}),
		modePorts = useRef<Record<string, string>>({}),
		modeTouched = useRef<Record<string, Record<string, boolean>>>({}),
		modeCustom = useRef<Record<string, { calculation: boolean; submit: boolean }>>({}),
		modeBaselines = useRef<Record<string, string>>({
			[`${environmentMode(initial)}:${initial.engineId}`]: configurationIdentity(
				initial,
				String(initial.port)
			)
		}),
		modeDirty = useRef<Record<string, boolean>>({}),
		submitDraft = useRef(initial.submitCommandTemplate || ""),
		generation = useRef(0),
		mounted = useRef(true),
		busy = useRef(false),
		nameEdited = useRef(
			Boolean(initial.environmentId) || !isDefaultEnvironmentDisplayName(initial.displayName)
		);
	const errors = useTaskErrorScope(`environment:${draft.environmentId || "new"}`);
	useEffect(() => {
		mounted.current = true;
		void bridge
			.request("center.read", {})
			.then((value) => {
				if (mounted.current) setSites(value.siteProfiles ?? []);
			})
			.catch(errors.automatic("site-list"));
		return () => {
			mounted.current = false;
			generation.current++;
		};
	}, [bridge]);
	const otherModeDirty = Object.entries(modeDirty.current).some(
		([key, changed]) => changed && key !== `${environmentMode(draft)}:${draft.engineId}`
	);
	const siteDraftDirty =
		siteEditing &&
		siteName !== (sites.find((site) => site.siteId === siteEditId)?.displayName ?? "");
	const dirty =
		baseline !== configurationIdentity(draft, port) ||
		Boolean(secret) ||
		otherModeDirty ||
		siteDraftDirty;
	const validPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
	function validPath(key: PathField, value: string) {
		return isValidEnvironmentPath(key, value, draft.connectionKind);
	}
	function invalid(key: TextField | "port") {
		if (key === "port") return !validPort;
		const value = draft[key];
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
			!validPath(key as PathField, value)
		);
	}
	const valid =
		(!isMacClientPlatform() || draft.connectionKind === "ssh") &&
		!invalid("displayName") &&
		!invalid("executable") &&
		!invalid("workingRoot") &&
		(draft.connectionKind !== "wsl" || (!invalid("distribution") && !invalid("user"))) &&
		(draft.connectionKind !== "ssh" ||
			(!invalid("host") &&
				!invalid("port") &&
				!invalid("user") &&
				(draft.authentication !== "private-key" || !invalid("privateKeyPath")))) &&
		(!customCalculation || Boolean(draft.calculationTemplate?.trim())) &&
		(draft.connectionKind !== "ssh" ||
			draft.schedulerKind !== "slurm" ||
			(["partition", "account", "qos", "timeLimit"].every((key) => !invalid(key as TextField)) &&
				(!customSubmit || Boolean(draft.submitCommandTemplate?.trim()))));
	const finalDraft: EnvironmentView = {
		...draft,
		port: validPort ? Number(port) : draft.port,
		submitCommandTemplate:
			draft.connectionKind === "ssh" && draft.schedulerKind === "slurm"
				? draft.submitCommandTemplate
				: ""
	};
	const selectedSaved = environments.find((value) => value.environmentId === draft.environmentId);
	function invalidate() {
		generation.current++;
		setMessage("");
		setMessageDetails("");
		setChallenge(null);
		setChecked(undefined);
	}
	function update<K extends keyof EnvironmentView>(key: K, value: EnvironmentView[K]) {
		setDraft((current) => ({ ...current, [key]: value }));
		if (key === "displayName") nameEdited.current = true;
		invalidate();
	}
	function select(value: EnvironmentView, saved = true) {
		generation.current++;
		setDraft({ ...value });
		setPort(String(value.port));
		setBaseline(saved ? configurationIdentity(value, String(value.port)) : "");
		setSecret("");
		setRemember(false);
		setTouched({});
		setChecked(value.check);
		setMessage("");
		setMessageDetails("");
		setChallenge(null);
		setBrowser(null);
		setImported(null);
		setImportOpen(false);
		setPaste("");
		setSiteEditing(false);
		setSiteEditId("");
		setSiteName("");
		setSiteOpen(false);
		setMoreOpen(false);
		setDeleting(false);
		setDeletingSite(false);
		setDocumentOpen(false);
		setDocumentSaved(false);
		setIncludeScripts(false);
		setSnippet("");
		setTemplateReset(false);
		setDocumentPreservation(undefined);
		setRequiredCapabilities(undefined);
		setCustomCalculation(Boolean(value.calculationTemplate));
		setCustomSubmit(Boolean(value.submitCommandTemplate));
		modes.current = {};
		modePorts.current = {};
		modeTouched.current = {};
		modeCustom.current = {};
		modeDirty.current = {};
		modeBaselines.current = {
			[`${environmentMode(value)}:${value.engineId}`]: configurationIdentity(
				value,
				String(value.port)
			)
		};
		submitDraft.current = value.submitCommandTemplate || "";
		nameEdited.current =
			!saved || Boolean(value.environmentId) || !isDefaultEnvironmentDisplayName(value.displayName);
		errors.clear();
	}
	function guard(action: () => void) {
		if (pending) return;
		if (dirty) setLeaveAction(() => action);
		else action();
	}
	function switchMode(mode: EnvironmentMode, engine = draft.engineId) {
		const key = `${environmentMode(draft)}:${draft.engineId}`;
		modes.current[key] = { ...draft, port: validPort ? Number(port) : draft.port };
		modePorts.current[key] = port;
		modeTouched.current[key] = touched;
		modeCustom.current[key] = { calculation: customCalculation, submit: customSubmit };
		modeDirty.current[key] = configurationIdentity(draft, port) !== modeBaselines.current[key];
		const nextKey = `${mode}:${engine}`;
		const next = environmentDraftForMode(
			draft,
			mode,
			engine,
			modes.current[nextKey],
			nameEdited.current
		);
		const nextPort = modePorts.current[nextKey] ?? String(next.port);
		modeBaselines.current[nextKey] ??= configurationIdentity(next, nextPort);
		setDraft(next);
		setPort(nextPort);
		setCustomCalculation(
			modeCustom.current[nextKey]?.calculation ?? Boolean(next.calculationTemplate)
		);
		setCustomSubmit(modeCustom.current[nextKey]?.submit ?? Boolean(next.submitCommandTemplate));
		setTouched(modeTouched.current[nextKey] ?? {});
		setSecret("");
		setRemember(false);
		setBrowser(null);
		setSnippet("");
		setTemplateReset(false);
		invalidate();
	}
	function secretPayload(): EnvironmentSecretPayload | undefined {
		return secret
			? {
					...(draft.authentication === "private-key"
						? { privateKeyPassphrase: secret }
						: { password: secret }),
					remember
				}
			: undefined;
	}
	async function perform(action: () => Promise<void>) {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		const fail = errors.attempt("environment-action");
		try {
			await action();
		} catch (error) {
			if (mounted.current) fail(error);
		} finally {
			busy.current = false;
			if (mounted.current) setPending(false);
		}
	}
	async function save() {
		if (!canManage || !valid) return false;
		const identity = generation.current,
			result = await bridge.request("environment.save", {
				environment: finalDraft,
				secret: secretPayload(),
				documentPreservation,
				requiredCapabilities
			});
		if (!mounted.current || identity !== generation.current) return false;
		setDraft(result);
		setPort(String(result.port));
		setBaseline(configurationIdentity(result, String(result.port)));
		const modeKey = `${environmentMode(result)}:${result.engineId}`;
		modeBaselines.current[modeKey] = configurationIdentity(result, String(result.port));
		modeDirty.current[modeKey] = false;
		setSecret("");
		setRemember(false);
		setMessage("环境已保存");
		await onChanged();
		return true;
	}
	async function browse(field: PathField, path?: string) {
		const identity = generation.current;
		const result = await bridge.request("environment.browse", {
			environment: finalDraft,
			secret: secretPayload(),
			purpose: {
				executable: "executable",
				workingRoot: "working-root",
				privateKeyPath: "private-key"
			}[field] as "executable" | "working-root" | "private-key",
			mode: field === "workingRoot" ? "directory" : "file",
			path: path ?? draft[field]
		});
		if (!result || identity !== generation.current || !mounted.current) return;
		if (result.selected) {
			update(field, result.selected);
			setBrowser(null);
		} else setBrowser({ field, result });
	}
	function download(text: string, name: string) {
		const doc = document,
			url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })),
			link = doc.createElement("a");
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	function help(topic: string, label: string) {
		return (
			<TaskFieldHelp
				key={`${draft.connectionKind}:${draft.engineId}:${topic}`}
				topic={topic}
				label={label}
			/>
		);
	}
	function textField(key: TextField, label: string, required = false, topic?: string) {
		return (
			<label
				className={`task-env-row${["executable", "workingRoot", "privateKeyPath"].includes(key) ? " task-env-path-row" : ""}`}
				htmlFor={`${prefix}-${key}`}
			>
				<span className="task-field-heading">
					{label}
					{required && " *"}
					{topic && help(topic, label)}
				</span>
				<span className="task-path-field">
					<input
						id={`${prefix}-${key}`}
						aria-label={label}
						value={draft[key]}
						placeholder={
							["executable", "workingRoot", "privateKeyPath"].includes(key)
								? environmentPathPlaceholder(draft, key as PathField)
								: undefined
						}
						required={required}
						disabled={!canManage || pending}
						aria-invalid={touched[key] && invalid(key) ? true : undefined}
						onBlur={() => setTouched((value) => ({ ...value, [key]: true }))}
						onChange={(event) => update(key, event.target.value)}
					/>
					{["executable", "workingRoot", "privateKeyPath"].includes(key) && (
						<button
							type="button"
							disabled={!canManage || pending}
							onClick={() => void perform(() => browse(key as PathField))}
						>
							选择
						</button>
					)}
				</span>
			</label>
		);
	}
	function variables(items: { name: string; description: string }[]) {
		return (
			<details>
				<summary>可用变量</summary>
				<dl>
					{items.map((item) => (
						<div key={item.name}>
							<dt>{`{${item.name}}`}</dt>
							<dd>{item.description}</dd>
						</div>
					))}
				</dl>
			</details>
		);
	}
	return (
		<DialogShell
			className="task-dialog task-environment-dialog"
			aria-label="执行环境配置"
			onCancel={() => guard(onClose)}
		>
			<header>
				<h2>执行环境</h2>
				<button type="button" aria-label="关闭环境配置" onClick={() => guard(onClose)}>
					×
				</button>
			</header>
			<div
				className="task-environment-body"
				onScroll={() =>
					draft && document.dispatchEvent(new CustomEvent("es-task-help-open", { detail: "" }))
				}
			>
				{!canManage && <p role="status">只读 · 取得管理权后可修改配置</p>}
				{errors.notice && (
					<TaskErrorNotice {...errors.notice} bridge={bridge} onDismiss={errors.dismiss} />
				)}
				<div className="task-env-toolbar">
					<label className="task-env-saved">
						已保存环境
						<select
							value={draft.environmentId}
							disabled={pending}
							onChange={(event) => {
								const value = event.target.value;
								guard(() =>
									select(
										environments.find((env) => env.environmentId === value) ?? newEnvironment()
									)
								);
							}}
						>
							<option value="">新环境</option>
							{environments.map((env) => (
								<option key={env.environmentId} value={env.environmentId}>
									{env.displayName}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={!canManage || pending}
						onClick={() => guard(() => select(newEnvironment()))}
					>
						新建
					</button>

					<button
						type="button"
						disabled={!canManage || pending}
						onClick={() => setImportOpen(true)}
					>
						导入
					</button>
					<button
						type="button"
						onClick={() => {
							setIncludeScripts(false);
							setDocumentSaved(false);
							setDocumentOpen(true);
						}}
					>
						配置助手
					</button>
					<button
						type="button"
						aria-expanded={moreOpen}
						onClick={() => setMoreOpen((value) => !value)}
					>
						更多⋯
					</button>
				</div>
				{moreOpen && (
					<section className="task-env-panel task-env-more" aria-label="更多环境操作">
						<div className="task-actions">
							<button
								type="button"
								disabled={!selectedSaved || pending}
								onClick={() =>
									void perform(async () => {
										if (!selectedSaved) return;
										const result = await bridge.request("environment.export", {
											environmentId: selectedSaved.environmentId
										});
										if (result.saved) setMessage("已导出无秘密环境配置");
									})
								}
							>
								导出配置
							</button>
							<button
								type="button"
								onClick={() =>
									download(
										environmentConfigurationMarkdown(),
										"Ester-Studio-environment-configuration.md"
									)
								}
							>
								下载配置说明.md
							</button>
							<button
								type="button"
								aria-expanded={siteOpen}
								onClick={() => setSiteOpen((value) => !value)}
							>
								站点管理
							</button>
						</div>
						<button
							type="button"
							disabled={!selectedSaved || pending}
							onClick={() => {
								setIncludeScripts(false);
								setDocumentSaved(true);
								setDocumentOpen(true);
							}}
						>
							下载含当前配置的说明
						</button>
						{draft.environmentId && (
							<button
								type="button"
								disabled={!canManage || pending}
								onClick={() => setDeleting(true)}
							>
								删除环境
							</button>
						)}
						{draft.scriptTemplate &&
							draft.connectionKind === "ssh" &&
							draft.schedulerKind === "slurm" && (
								<label>
									兼容 Slurm 外壳{help("scriptTemplate", "兼容 Slurm 外壳")}
									<textarea
										aria-label="兼容 Slurm 外壳"
										value={draft.scriptTemplate}
										disabled={!canManage || pending}
										onChange={(event) => update("scriptTemplate", event.target.value)}
									/>
									{variables(draft.templateVariables ?? [])}
								</label>
							)}
						{draft.scratchRoot && (
							<p>
								历史 Scratch 配置：{draft.scratchRoot}{" "}
								<button
									type="button"
									disabled={!canManage || pending}
									onClick={() => update("scratchRoot", "")}
								>
									清除历史外置配置
								</button>
							</p>
						)}
						{siteOpen && (
							<div className="task-env-site-manager">
								<label>
									站点
									<select
										aria-label="站点"
										value={draft.siteId ?? ""}
										disabled={!canManage || pending}
										onChange={(event) => {
											setSiteEditing(false);
											setSiteEditId("");
											const site = sites.find((value) => value.siteId === event.target.value);
											if (!site) {
												update("siteId", undefined);
												update("siteRevision", undefined);
												return;
											}
											setDraft((current) => ({
												...current,
												...Object.fromEntries(siteKeys.map((key) => [key, site[key]])),
												siteId: site.siteId,
												siteRevision: site.revision
											}));
											setPort(String(site.port));
											setSiteName(site.displayName);
											invalidate();
										}}
									>
										<option value="">独立环境</option>
										{sites.map((site) => (
											<option key={site.siteId} value={site.siteId}>
												{site.displayName}
											</option>
										))}
									</select>
								</label>
								<button
									type="button"
									disabled={!canManage || pending}
									onClick={() => {
										setSiteEditId("");
										setSiteName("");
										setSiteEditing(true);
									}}
								>
									新建站点
								</button>
								<button
									type="button"
									disabled={!canManage || pending || !draft.siteId}
									onClick={() => {
										setSiteEditId(draft.siteId ?? "");
										setSiteName(
											sites.find((site) => site.siteId === draft.siteId)?.displayName ?? ""
										);
										setSiteEditing(true);
									}}
								>
									编辑站点
								</button>
								{siteEditing && (
									<section className="task-env-site-editor" aria-label="站点编辑">
										<label>
											站点名称
											<input
												aria-label="站点名称"
												value={siteName}
												onChange={(event) => setSiteName(event.target.value)}
											/>
										</label>
										<button
											type="button"
											disabled={
												!canManage ||
												pending ||
												(isMacClientPlatform() && draft.connectionKind !== "ssh") ||
												!siteName.trim() ||
												!draft.workingRoot ||
												(draft.connectionKind !== "local" && !draft.user) ||
												(draft.connectionKind === "ssh" && (!validPort || !draft.host)) ||
												(draft.connectionKind === "wsl" && !draft.distribution)
											}
											onClick={() =>
												void perform(async () => {
													const old = sites.find((site) => site.siteId === siteEditId);
													const site = await bridge.request("environment.site-save", {
														site: {
															...Object.fromEntries(siteKeys.map((key) => [key, finalDraft[key]])),
															siteId: old?.siteId ?? "",
															revision: old?.revision ?? 0,
															displayName: siteName
														} as SiteProfileView
													});
													setSites((current) => [
														...current.filter((value) => value.siteId !== site.siteId),
														site
													]);
													update("siteId", site.siteId);
													update("siteRevision", site.revision);
													setSiteEditing(false);
												})
											}
										>
											保存站点
										</button>
										{siteEditId && (
											<button
												type="button"
												disabled={!canManage || pending}
												onClick={() => setDeletingSite(true)}
											>
												删除站点配置
											</button>
										)}
										<button type="button" onClick={() => setSiteEditing(false)}>
											关闭站点编辑
										</button>
									</section>
								)}
							</div>
						)}
					</section>
				)}
				{importOpen && (
					<section className="task-env-panel">
						<h3>导入配置</h3>
						<button
							type="button"
							disabled={pending}
							onClick={() =>
								void perform(async () =>
									setImported(await bridge.request("environment.import-preview", {}))
								)
							}
						>
							选择文件
						</button>
						<label>
							粘贴 JSON
							<textarea
								aria-label="粘贴环境JSON"
								value={paste}
								onChange={(event) => setPaste(event.target.value)}
							/>
						</label>
						<button
							type="button"
							disabled={pending || !paste.trim()}
							onClick={() =>
								void perform(async () =>
									setImported(await bridge.request("environment.import-preview", { text: paste }))
								)
							}
						>
							预览粘贴配置
						</button>
						{imported && (
							<div className="task-import-preview">
								<h3>导入预览</h3>
								<p>应用为新草稿，保存与检测分别进行。</p>
								<dl>
									{imported.changes.map((change) => (
										<div key={change.field}>
											<dt>{change.field}</dt>
											<dd>{String(change.value)}</dd>
										</div>
									))}
								</dl>
								<button
									type="button"
									disabled={!canManage || pending}
									onClick={() => {
										const value = imported;
										guard(() => {
											select(
												{ ...value.environment, environmentId: "", revision: 0, check: undefined },
												false
											);
											setDocumentPreservation(value.preserved);
											setRequiredCapabilities(value.requiredCapabilities);
											setImportOpen(false);
											setMessage("已应用到新草稿，待保存与检测");
										});
									}}
								>
									应用到新草稿
								</button>
								<button type="button" onClick={() => setImported(null)}>
									关闭预览
								</button>
							</div>
						)}
						<button
							type="button"
							onClick={() => {
								setImportOpen(false);
								setImported(null);
							}}
						>
							关闭导入
						</button>
					</section>
				)}
				{documentOpen && (!documentSaved || selectedSaved) && (
					<section className="task-env-panel">
						<h3>配置助手</h3>
						<p>核对以下字段，再下载说明交给配置助手。凭据与私钥正文不会附带。</p>
						<label className="task-checkbox">
							<input
								type="checkbox"
								checked={includeScripts}
								onChange={(event) => setIncludeScripts(event.target.checked)}
							/>
							加入初始化与自定义脚本（核对后再下载）
						</label>
						<pre>
							{environmentConfigurationMarkdown(
								documentSaved ? selectedSaved : finalDraft,
								includeScripts,
								documentSaved ? "saved" : "draft"
							)}
						</pre>
						<button
							type="button"
							onClick={() =>
								download(
									environmentConfigurationMarkdown(
										documentSaved ? selectedSaved : finalDraft,
										includeScripts,
										documentSaved ? "saved" : "draft"
									),
									"Ester-Studio-environment-current.md"
								)
							}
						>
							下载此说明.md
						</button>
						<button type="button" onClick={() => setDocumentOpen(false)}>
							关闭预览
						</button>
					</section>
				)}
				<section className="task-env-section">
					<h3>基本信息</h3>
					{textField("displayName", "环境名称", true)}
					<div className="task-env-pair">
						<label className="task-env-row">
							<span>计算软件 *</span>
							<select
								aria-label="计算软件"
								disabled={!canManage || pending}
								value={draft.engineId}
								onChange={(event) =>
									switchMode(
										environmentMode(draft),
										event.target.value as EnvironmentView["engineId"]
									)
								}
							>
								<option value="gaussian">Gaussian</option>
								<option value="orca">ORCA</option>
							</select>
						</label>
						<label className="task-env-row">
							<span>环境类型 *</span>
							<select
								aria-label="环境类型"
								disabled={!canManage || pending}
								value={
									isMacClientPlatform() && draft.connectionKind !== "ssh"
										? ""
										: environmentMode(draft)
								}
								onChange={(event) => switchMode(event.target.value as EnvironmentMode)}
							>
								{isMacClientPlatform() && draft.connectionKind !== "ssh" && (
									<option value="" disabled hidden>
										请选择远程环境
									</option>
								)}
								{!isMacClientPlatform() && (
									<>
										<option value="local">Windows 本机</option>
										<option value="wsl">WSL2</option>
									</>
								)}
								<option value="ssh">SSH服务器</option>
								<option value="slurm">SSH + Slurm</option>
							</select>
						</label>
					</div>
					{isMacClientPlatform() && draft.connectionKind !== "ssh" && (
						<p role="status">
							当前已加载的环境类型（{draft.connectionKind === "local" ? "Windows 本机" : "WSL2"}）在 macOS 上不受支持，请切换为 SSH服务器 或 SSH + Slurm。
						</p>
					)}
				</section>
				{draft.connectionKind !== "local" &&
					(!isMacClientPlatform() || draft.connectionKind === "ssh") && (
					<section className="task-env-section">
						<h3>连接设置</h3>
						{draft.connectionKind === "wsl" ? (
							<>
								<div className="task-env-pair">
									{textField("distribution", "发行版", true)}
									{textField("user", "执行用户", true, "user")}
								</div>
							</>
						) : (
							<>
								<div className="task-env-pair task-env-host-port">
									{textField("host", "主机", true)}
									<label className="task-env-row">
										<span>端口 *</span>
										<input
											aria-label="端口"
											inputMode="numeric"
											value={port}
											disabled={!canManage || pending}
											aria-invalid={touched.port && !validPort ? true : undefined}
											onBlur={() => setTouched((current) => ({ ...current, port: true }))}
											onChange={(event) => {
												setPort(event.target.value);
												invalidate();
											}}
										/>
									</label>
								</div>
								<div className="task-env-pair">
									{textField("user", "用户名", true)}
									<label className="task-env-row">
										<span className="task-field-heading">
											认证方式{help("authentication", "认证方式")}
										</span>
										<select
											aria-label="认证方式"
											value={draft.authentication}
											disabled={!canManage || pending}
											onChange={(event) => {
												update(
													"authentication",
													event.target.value as EnvironmentView["authentication"]
												);
												setSecret("");
												setRemember(false);
											}}
										>
											<option value="agent">SSH Agent</option>
											<option value="password">密码</option>
											<option value="private-key">私钥文件</option>
										</select>
									</label>
								</div>
								{draft.authentication === "private-key" &&
									textField("privateKeyPath", "本机私钥文件", true)}
								{draft.authentication !== "agent" && (
									<>
										<label className="task-env-row">
											<span>{draft.authentication === "password" ? "密码" : "私钥口令"}</span>
											<input
												type="password"
												autoComplete="off"
												value={secret}
												disabled={!canManage || pending}
												onChange={(event) => {
													setSecret(event.target.value);
													invalidate();
												}}
											/>
										</label>
										<label className="task-checkbox">
											<input
												type="checkbox"
												checked={remember}
												disabled={!canManage || pending}
												onChange={(event) => setRemember(event.target.checked)}
											/>
											记住凭据（系统安全存储）
										</label>
									</>
								)}
							</>
						)}
					</section>
				)}
				<section className="task-env-section">
					<h3>运行设置</h3>
					{textField("executable", "软件可执行文件", true)}
					{textField("workingRoot", "工作父目录", true, "workingRoot")}
					{draft.connectionKind === "ssh" && draft.schedulerKind === "slurm" && (
						<>
							<div className="task-env-group-heading">Slurm 参数{help("slurm", "Slurm 参数")}</div>
							<div className="task-env-pair">
								{textField("partition", "分区")}
								{textField("account", "账户")}
								{textField("qos", "QoS")}
								{textField("timeLimit", "默认申请时限")}
							</div>
							<label className="task-env-row">
								<span className="task-field-heading">
									内存申请{help("slurmMemoryPolicy", "内存申请")}
								</span>
								<select
									aria-label="内存申请"
									value={draft.slurmMemoryPolicy ?? "input-request"}
									disabled={!canManage || pending}
									onChange={(event) =>
										update(
											"slurmMemoryPolicy",
											event.target.value as NonNullable<EnvironmentView["slurmMemoryPolicy"]>
										)
									}
								>
									<option value="input-request">按计算输入申请</option>
									<option value="site-managed">由站点管理</option>
								</select>
							</label>
						</>
					)}
				</section>
				<details className="task-environment-advanced">
					<summary>
						初始化、环境变量与运行模板
						{(draft.initialization || draft.calculationTemplate) && (
							<span className="task-env-summary">已配置</span>
						)}
					</summary>
					<label className="task-env-row">
						<span className="task-field-heading">
							初始化命令{help("initialization", "初始化命令")}
						</span>
						<div>
							{initializationSnippets(draft).length > 0 && (
								<select
									aria-label="插入适用片段"
									value={snippet}
									disabled={!canManage || pending}
									onChange={(event) => setSnippet(event.target.value)}
								>
									<option value="">插入适用片段</option>
									{initializationSnippets(draft).map((item) => (
										<option key={item.id} value={item.id}>
											{item.name}
										</option>
									))}
								</select>
							)}
							<textarea
								rows={4}
								aria-label="初始化命令"
								value={draft.initialization}
								disabled={!canManage || pending}
								spellCheck={false}
								onChange={(event) => update("initialization", event.target.value)}
							/>
						</div>
					</label>
					{snippet && (
						<div className="task-env-panel">
							<p>将以下说明片段追加到初始化命令，已有手改保留；实际命令需按安装资料填写。</p>
							<pre>{initializationSnippets(draft).find((item) => item.id === snippet)?.text}</pre>
							<button
								type="button"
								onClick={() => {
									update(
										"initialization",
										draft.initialization +
											(draft.initialization && !draft.initialization.endsWith("\n") ? "\n" : "") +
											initializationSnippets(draft).find((item) => item.id === snippet)!.text
									);
									setSnippet("");
								}}
							>
								确认插入
							</button>
							<button type="button" onClick={() => setSnippet("")}>
								取消
							</button>
						</div>
					)}
					<label className="task-env-row">
						<span className="task-field-heading">
							运行模板{help("calculationTemplate", "运行模板")}
						</span>
						<select
							aria-label="运行模板"
							disabled={!canManage || pending}
							value={customCalculation ? "custom" : "standard"}
							onChange={(event) => {
								if (event.target.value === "standard" && draft.calculationTemplate)
									setTemplateReset(true);
								else {
									setCustomCalculation(event.target.value === "custom");
									if (event.target.value === "custom" && !draft.calculationTemplate)
										update("calculationTemplate", "{standardScript}");
								}
							}}
						>
							<option value="standard">系统标准</option>
							<option value="custom">自定义</option>
						</select>
					</label>
					{customCalculation && (
						<div className="task-env-template">
							<textarea
								aria-label="运行模板编辑区"
								rows={8}
								spellCheck={false}
								disabled={!canManage || pending}
								value={draft.calculationTemplate ?? ""}
								onChange={(event) => update("calculationTemplate", event.target.value)}
							/>
							{variables(calculationTemplateVariables)}
							<button
								type="button"
								disabled={!canManage || pending}
								onClick={() => setTemplateReset(true)}
							>
								恢复标准模板
							</button>
						</div>
					)}
					{templateReset && (
						<div className="task-confirm">
							<p>恢复系统标准模板？仅覆盖当前自定义运行模板。</p>
							<button
								type="button"
								onClick={() => {
									update("calculationTemplate", "");
									setCustomCalculation(false);
									setTemplateReset(false);
								}}
							>
								确认恢复
							</button>
							<button type="button" onClick={() => setTemplateReset(false)}>
								取消
							</button>
						</div>
					)}
				</details>
				{draft.connectionKind === "ssh" && draft.schedulerKind === "slurm" && (
					<details className="task-environment-advanced">
						<summary>
							自定义提交
							{draft.submitCommandTemplate && <span className="task-env-summary">已配置</span>}
						</summary>
						<label className="task-env-row">
							<span className="task-field-heading">
								提交方式{help("submitCommandTemplate", "提交方式")}
							</span>
							<select
								aria-label="提交方式"
								disabled={!canManage || pending}
								value={customSubmit ? "custom" : "standard"}
								onChange={(event) => {
									const custom = event.target.value === "custom";
									if (!custom) submitDraft.current = draft.submitCommandTemplate || "";
									setCustomSubmit(custom);
									update(
										"submitCommandTemplate",
										custom
											? draft.submitCommandTemplate ||
													submitDraft.current ||
													"sbatch --parsable {submitScriptPath}"
											: ""
									);
								}}
							>
								<option value="standard">ES标准提交</option>
								<option value="custom">自定义提交命令</option>
							</select>
						</label>
						{customSubmit && (
							<>
								<textarea
									aria-label="提交命令模板"
									rows={5}
									spellCheck={false}
									disabled={!canManage || pending}
									value={draft.submitCommandTemplate ?? ""}
									onChange={(event) => update("submitCommandTemplate", event.target.value)}
								/>
								{variables(submitTemplateVariables)}
								<p>返回单一 Slurm Job ID，查询、停止和文件位置仍由 ES 管理。</p>
							</>
						)}
					</details>
				)}
				{browser && (
					<section className="task-remote-browser">
						<h3>{browser.result.domain} 路径</h3>
						<p>{browser.result.path}</p>
						{browser.result.parentPath && (
							<button
								type="button"
								disabled={pending}
								onClick={() => void perform(() => browse(browser.field, browser.result.parentPath))}
							>
								上一级
							</button>
						)}
						{browser.field === "workingRoot" && (
							<button
								type="button"
								onClick={() => {
									update(browser.field, browser.result.path);
									setBrowser(null);
								}}
							>
								选择此目录
							</button>
						)}
						<ul>
							{browser.result.entries.map((entry) => (
								<li key={entry.name}>
									<button
										type="button"
										disabled={pending || !["file", "directory"].includes(entry.kind)}
										onClick={() => {
											const path = browser.result.path.replace(/\/$/, "") + "/" + entry.name;
											if (entry.kind === "directory")
												void perform(() => browse(browser.field, path));
											else if (browser.field !== "workingRoot") {
												update(browser.field, path);
												setBrowser(null);
											}
										}}
									>
										{entry.kind === "directory" ? "▸ " : ""}
										{entry.name}
									</button>
								</li>
							))}
						</ul>
						<button type="button" onClick={() => setBrowser(null)}>
							关闭浏览
						</button>
					</section>
				)}
				{challenge && (
					<section className="task-host-key" role="alert">
						<h3>
							{challenge.state === "changed"
								? "SSH 主机指纹已变化，连接被拒绝"
								: "首次连接：确认 SSH 主机指纹"}
						</h3>
						<p>
							{challenge.host} · {challenge.algorithm}
						</p>
						<code>{challenge.fingerprint}</code>
						{challenge.state === "unknown" && (
							<button
								type="button"
								disabled={!canManage || pending}
								onClick={() =>
									void perform(async () => {
										await bridge.request("environment.trust-host-key", {
											challengeId: challenge.challengeId,
											fingerprint: challenge.fingerprint
										});
										setChallenge(null);
										setMessage("指纹已确认，请重新检测连接");
									})
								}
							>
								确认此指纹
							</button>
						)}
						<button type="button" onClick={() => setChallenge(null)}>
							关闭提示
						</button>
					</section>
				)}
				{deleting && (
					<div className="task-confirm">
						<p>删除环境“{draft.displayName}”？已运行任务快照保留。</p>
						<button type="button" onClick={() => setDeleting(false)}>
							取消
						</button>
						<button
							type="button"
							disabled={!canManage || pending}
							onClick={() =>
								void perform(async () => {
									await bridge.request("environment.delete", {
										environmentId: draft.environmentId
									});
									await onChanged();
									select(newEnvironment());
								})
							}
						>
							确认删除环境
						</button>
					</div>
				)}
				{deletingSite && (
					<div className="task-confirm">
						<p>删除此站点配置？已保存环境和运行快照保留。</p>
						<button type="button" onClick={() => setDeletingSite(false)}>
							取消
						</button>
						<button
							type="button"
							disabled={pending}
							onClick={() =>
								void perform(async () => {
									const site = sites.find((value) => value.siteId === draft.siteId);
									if (!site) return;
									await bridge.request("environment.site-delete", {
										siteId: site.siteId,
										expectedRevision: site.revision
									});
									setSites((current) => current.filter((value) => value.siteId !== site.siteId));
									update("siteId", undefined);
									update("siteRevision", undefined);
									setDeletingSite(false);
								})
							}
						>
							确认删除站点配置
						</button>
					</div>
				)}
				<EnvironmentCheckFeedback message={message} details={messageDetails} />
				{leaveAction && (
					<div className="task-confirm" role="alert">
						<p>
							有未保存的环境修改，保存后继续？
							{otherModeDirty && "保存仅保存当前环境类型；继续将放弃其他类型未保存的草稿。"}
							{siteDraftDirty && "站点名称尚未保存；继续将放弃站点名称草稿。"}
						</p>
						<button
							type="button"
							disabled={pending || !valid || !canManage}
							onClick={() =>
								void perform(async () => {
									if (await save()) {
										const action = leaveAction;
										setLeaveAction(null);
										action();
									}
								})
							}
						>
							保存并继续
						</button>
						<button
							type="button"
							disabled={pending}
							onClick={() => {
								const action = leaveAction;
								setLeaveAction(null);
								action();
							}}
						>
							放弃修改
						</button>
						<button type="button" disabled={pending} onClick={() => setLeaveAction(null)}>
							取消
						</button>
					</div>
				)}
			</div>
			<footer>
				<span className="task-environment-status" role="status">
					检测状态：
					{checked?.state === "passed"
						? `已检测${checked.version.value ? ` · ${checked.version.value}` : ""} · 计算未验证`
						: checked?.state === "failed"
							? "检测未通过 · 计算未验证"
							: checked
								? checked.entry === "passed"
									? "入口已核，其他信息待核 · 计算未验证"
									: "检测信息待核 · 计算未验证"
								: "未检测"}
					{draft.connectionKind === "ssh" &&
						draft.schedulerKind === "slurm" &&
						draft.slurmMemoryPolicy === "site-managed" &&
						" · 调度内存未核实"}
				</span>
				<button
					type="button"
					className={checked?.state === "passed" ? "task-check-passed" : "task-check-pending"}
					disabled={!canManage || pending || !valid}
					onClick={() =>
						void perform(async () => {
							const identity = generation.current;
							const result = await bridge.request("environment.check", {
								environment: finalDraft,
								secret: secretPayload()
							});
							if (!mounted.current || identity !== generation.current) return;
							setMessage(result.message);
							setMessageDetails(result.details ?? "");
							setChallenge(result.hostKey ?? null);
							setChecked(result.check);
						})
					}
				>
					检测环境
				</button>
				<button
					type="button"
					className="button button-primary task-save-environment"
					disabled={!canManage || pending || !valid}
					onClick={() =>
						void perform(async () => {
							await save();
						})
					}
				>
					{pending ? "处理中…" : "保存环境"}
				</button>
				<button type="button" disabled={pending} onClick={() => guard(onClose)}>
					关闭
				</button>
			</footer>
		</DialogShell>
	);
}
