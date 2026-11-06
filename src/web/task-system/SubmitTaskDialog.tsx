import { useEffect, useMemo, useRef, useState } from "react";
import type {
	SubmitTaskInput,
	SubmitTaskRequest,
	TaskCenterView,
	TaskSystemBridge,
	TaskSystemCommands
} from "../../task-system/application-contracts";
import DialogShell from "../DialogShell";
import { DismissibleNotice } from "../DismissibleNotice";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope, type TaskErrorReporter } from "./task-error-scope";
import EnvironmentSettings from "./EnvironmentSettings";
import { TaskLibraryEntry } from "./TaskLibrarySettings";
import SubmissionResourceEditor from "./SubmissionResourceEditor";
import { submissionRestrictionMessage } from "./submission-resources";
import "./environment-submit.css";
import "./submit-task.css";
import { bytesLabel, isAbort, taskKindLabel } from "./presentation";
import {
	submissionRequestKey,
	currentSubmissionPreview,
	canSubmitPreview,
	releaseSubmissionDependencies
} from "./submission-state";
export interface SubmitTaskDialogProps {
	bridge: TaskSystemBridge;
	input: SubmitTaskInput;
	initialRequest?: SubmitTaskRequest;
	onClose(): void;
	onSubmitted(result: TaskSystemCommands["submission.submit"]["result"]): void;
	onConfigureEnvironment?(): void;
}
type PreviewRestrictionDetail = NonNullable<
	TaskSystemCommands["submission.preview"]["result"]["restrictionDetails"]
>[number];
export function SubmissionRestrictionNotice({
	restriction, detail, engine, identity, bridge
}: {
	restriction: string;
	detail?: PreviewRestrictionDetail;
	engine: "gaussian" | "orca";
	identity: string;
	bridge?: TaskSystemBridge;
}) {
	const scriptConflict = restriction === "GAUSSIAN_WINDOWS_SCRIPT_PATH_CONFLICT",
		scriptUnverified = restriction === "GAUSSIAN_WINDOWS_SCRIPT_MAPPING_UNVERIFIED",
		message = scriptConflict ? "手改脚本的启动设置与本次任务路径冲突。" :
			scriptUnverified ? "无法核实手改脚本的唯一启动设置。" : submissionRestrictionMessage(restriction, engine),
		lines = [restriction];
	if ((scriptConflict || scriptUnverified) && detail?.code === restriction) {
		if (typeof detail.field === "string") lines.push(`启动字段：${detail.field}`);
		if (typeof detail.expected === "string") lines.push(`本次期望值：${detail.expected}`);
		if (typeof detail.actual === "string") lines.push(`手稿实际值：${detail.actual}`);
		if (typeof detail.reason === "string") lines.push(`原因：${detail.reason}`);
	}
	return <TaskErrorNotice error={`${message}\n${lines.join("\n")}`} identity={identity} bridge={bridge} />;
}
export default function SubmitTaskDialog({
	bridge,
	input,
	initialRequest,
	onClose,
	onSubmitted,
	onConfigureEnvironment
}: SubmitTaskDialogProps) {
	const [view, setView] = useState<TaskCenterView | null>(null),
		[environmentId, setEnvironmentId] = useState(initialRequest?.environmentId ?? ""),
		[displayName, setDisplayName] = useState(initialRequest?.displayName ?? input.suggestedName),
		[override, setOverride] = useState(false),
		[workingRoot, setWorkingRoot] = useState(""),
		[partition, setPartition] = useState(""),
		[account, setAccount] = useState(""),
		[qos, setQos] = useState(""),
		[timeLimit, setTimeLimit] = useState(""),
		[pending, setPending] = useState(false),
		[preview, setPreview] = useState<TaskSystemCommands["submission.preview"]["result"] | null>(
			null
		),
		[previewKey, setPreviewKey] = useState(""),
		[previewNoticeId, setPreviewNoticeId] = useState(0),
		[configuration, setConfiguration] = useState(false),
		[dependencies, setDependencies] = useState(input.dependencies),
		[finalText, setFinalText] = useState(input.finalInputText),
		[submitting, setSubmitting] = useState(false);
	const [archiveOverride, setArchiveOverride] = useState(false),
		[archiveRoot, setArchiveRoot] = useState(""),
		[resourceInvalid, setResourceInvalid] = useState(false),
		[calculationScript, setCalculationScript] = useState<SubmitTaskRequest["calculationScript"]>(
			initialRequest?.calculationScript
		),
		[submissionPlanId, setSubmissionPlanId] = useState<string | undefined>(undefined);
	const [groupIds, setGroupIds] = useState(initialRequest?.groupIds ?? input.initialGroupIds ?? []),
		[fileTab, setFileTab] = useState<"input" | "dependencies" | "script">("input"),
		[expandedEditor, setExpandedEditor] = useState(false),
		[confirmReset, setConfirmReset] = useState(false),
		[overwrite, setOverwrite] = useState<
			TaskSystemCommands["submission.overwrite-preview"]["result"] | null
		>(null),
		[overwriteKey, setOverwriteKey] = useState("");
	const intentId = useRef(crypto.randomUUID()),
		nameEdited = useRef(Boolean(initialRequest)),
		nameSuggested = useRef(Boolean(initialRequest)),
		submittingRef = useRef(false),
		lastEnvironment = useRef<string | null>(null),
		liveEnvironment = useRef(environmentId);
	liveEnvironment.current = environmentId;
	const [scriptBasePath, setScriptBasePath] = useState<string | undefined>();
	const entryId = useRef(`submission-${crypto.randomUUID()}`),
		live = useRef(false),
		checking = useRef<AbortController | null>(null),
		latestKey = useRef(""),
		attemptedKey = useRef(""),
		dependencySources = useRef(new Set(input.dependencies.map((file) => file.sourceRef))),
		currentDependencies = useRef(input.dependencies),
		dependencyLifetime = useRef(0),
		draftSource = useRef(""),
		closing = useRef(false),
		sourceVersion = useRef({ source: "", revision: 0 }),
		requestVersion = useRef({ key: "", revision: 0 }),
		previewAttempt = useRef(0);
	draftSource.current = JSON.stringify([
		input.engineId,
		input.inputName,
		input.finalInputText,
		input.projectId
	]);
	if (sourceVersion.current.source !== draftSource.current)
		sourceVersion.current = {
			source: draftSource.current,
			revision: sourceVersion.current.revision + 1
		};
	const errors = useTaskErrorScope(`submission:${sourceVersion.current.revision}`);
	async function releaseDependencies(
		sourceRefs: string[],
		fail: TaskErrorReporter = errors.automatic("dependency-release")
	) {
		const exact = [...new Set(sourceRefs)].filter(Boolean);
		if (!exact.length) return;
		try {
			await releaseSubmissionDependencies(bridge, exact);
			for (const ref of exact) dependencySources.current.delete(ref);
		} catch (error) {
			if (live.current) fail(error);
		}
	}
	function closeDialog() {
		closing.current = true;
		void releaseDependencies([...dependencySources.current]);
		onClose();
	}
	useEffect(() => {
		const generation = ++dependencyLifetime.current;
		return () => {
			queueMicrotask(() => {
				if (dependencyLifetime.current === generation)
					void releaseDependencies([...dependencySources.current]);
			});
		};
	}, [bridge]);
	function removeDependency(index: number) {
		const removed = currentDependencies.current[index];
		if (!removed) return;
		const next = currentDependencies.current.filter((_, i) => i !== index);
		currentDependencies.current = next;
		setDependencies(next);
		void releaseDependencies([removed.sourceRef], errors.attempt("remove-dependency"));
	}
	async function chooseDependencies(replaceIndex?: number) {
		const source = draftSource.current;
		const fail = errors.attempt("choose-dependencies");
		try {
			const files = await bridge.request("submission.choose-dependencies", {
				engineId: input.engineId
			});
			if (!files.length) return;
			for (const file of files) dependencySources.current.add(file.sourceRef);
			if (!live.current || closing.current || draftSource.current !== source) {
				await releaseDependencies(
					files.map((file) => file.sourceRef),
					fail
				);
				return;
			}
			const removed = replaceIndex === undefined ? null : currentDependencies.current[replaceIndex];
			const retained = currentDependencies.current.filter((_, index) => index !== replaceIndex);
			const next = [
				...retained,
				...files.filter(
					(file) => !retained.some((existing) => existing.sourceRef === file.sourceRef)
				)
			];
			currentDependencies.current = next;
			setDependencies(next);
			if (removed && files.length) void releaseDependencies([removed.sourceRef], fail);
		} catch (error) {
			if (live.current && !closing.current && draftSource.current === source) fail(error);
		}
	}
	async function refresh(fail: TaskErrorReporter = errors.automatic("center-read")) {
		try {
			const next = await bridge.request("center.read", {});
			if (live.current) {
				setView(next);
				setEnvironmentId(
					(value) =>
						value ||
						next.environments.find((env) => env.engineId === input.engineId)?.environmentId ||
						""
				);
			}
		} catch (e) {
			if (live.current) fail(e);
		}
	}
	useEffect(() => {
		live.current = true;
		let active = true,
			entered = false;
		const ownEntryId = `submission-${crypto.randomUUID()}`;
		entryId.current = ownEntryId;
		const fail = errors.automatic("enter");
		void bridge.request("center.enter", { entryId: ownEntryId }).then(
			(value) => {
				entered = true;
				if (!active) {
					void bridge.request("center.leave", { entryId: ownEntryId }).catch(() => {});
					return;
				}
				setView(value);
				setEnvironmentId(
					(current) =>
						current ||
						value.environments.find((env) => env.engineId === input.engineId)?.environmentId ||
						""
				);
			},
			(e) => {
				if (active) fail(e);
			}
		);
		return () => {
			active = false;
			live.current = false;
			checking.current?.abort();
			if (entered) void bridge.request("center.leave", { entryId: ownEntryId }).catch(() => {});
		};
	}, [bridge]);
	const environment = view?.environments.find((env) => env.environmentId === environmentId);
	useEffect(() => {
		const retained = new Set(input.dependencies.map((file) => file.sourceRef));
		const removed = currentDependencies.current
			.filter((file) => !retained.has(file.sourceRef))
			.map((file) => file.sourceRef);
		for (const ref of retained) dependencySources.current.add(ref);
		currentDependencies.current = input.dependencies;
		setDependencies(input.dependencies);
		setFinalText(input.finalInputText);
		void releaseDependencies(removed);
	}, [input.engineId, input.inputName, input.finalInputText, input.projectId]);
	useEffect(() => {
		if (!environment) return;
		setPreview(null);
		setPreviewKey("");
		attemptedKey.current = "";
		if (lastEnvironment.current !== environmentId) {
			const original =
				lastEnvironment.current === null && initialRequest?.environmentId === environmentId
					? initialRequest
					: null;
			setWorkingRoot(original?.workingRootOverride ?? environment.workingRoot);
			setOverride(Boolean(original?.workingRootOverride));
			setArchiveRoot(original?.archiveRootOverride ?? "");
			setArchiveOverride(Boolean(original?.archiveRootOverride));
			setPartition(original?.slurm?.partition ?? environment.partition);
			setAccount(original?.slurm?.account ?? environment.account);
			setQos(original?.slurm?.qos ?? environment.qos);
			setTimeLimit(original?.slurm?.timeLimit ?? environment.timeLimit);
			lastEnvironment.current = environmentId;
		} else if (!override) setWorkingRoot(environment.workingRoot);
		setSubmissionPlanId(undefined);
	}, [environmentId, environment?.revision]);
	useEffect(() => {
		setSubmissionPlanId(undefined);
	}, [override, workingRoot, archiveOverride, archiveRoot]);
	const request = useMemo<SubmitTaskRequest>(
		() => ({
			input: {
				...input,
				dependencies,
				finalInputText: finalText,
				resources: finalText === input.finalInputText ? input.resources : []
			},
			environmentId,
			displayName: displayName.trim(),
			groupIds,
			submissionIntentId: intentId.current,
			...(initialRequest?.resubmitTaskId ? { resubmitTaskId: initialRequest.resubmitTaskId } : {}),
			submissionPlanId,
			calculationScript,
			...(archiveOverride && environment?.connectionKind !== "local"
				? { archiveRootOverride: archiveRoot }
				: {}),
			...(override ? { workingRootOverride: workingRoot } : {}),
			...(environment?.schedulerKind === "slurm"
				? { slurm: { partition, account, qos, timeLimit } }
				: {})
		}),
		[
			input,
			dependencies,
			finalText,
			environmentId,
			displayName,
			groupIds,
			initialRequest?.resubmitTaskId,
			environment?.connectionKind,
			override,
			workingRoot,
			environment?.schedulerKind,
			partition,
			account,
			qos,
			timeLimit,
			submissionPlanId,
			calculationScript,
			archiveOverride,
			archiveRoot
		]
	);
	const key = submissionRequestKey(request);
	if (requestVersion.current.key !== key)
		requestVersion.current = { key, revision: requestVersion.current.revision + 1 };
	latestKey.current = key;
	const scriptPathInvalid = Boolean(
		calculationScript &&
		scriptBasePath &&
		preview?.workingPath &&
		preview.workingPath !== scriptBasePath &&
		calculationScript.text.includes(scriptBasePath)
	);
	const valid = Boolean(
		view?.library.path &&
		view.manager.access === "manager" &&
		!view.library.migrating &&
		environment &&
		environment.engineId === input.engineId &&
		displayName.trim() &&
		finalText.trim() &&
		(!override || workingRoot.trim()) &&
		(!archiveOverride || environment?.connectionKind === "local" || archiveRoot.trim()) &&
		!resourceInvalid &&
		!scriptPathInvalid
	);
	const currentPreview = currentSubmissionPreview(request, previewKey, preview);
	const dualDirectory = environment && environment.connectionKind !== "local";
	const resources = (
		currentPreview?.resources ?? (finalText === input.finalInputText ? input.resources : [])
	).filter((resource) => resource.source.includes("Slurm"));
	async function copy(text: string | undefined) {
		if (!text) return;
		try {
			await bridge.request("clipboard.write", { text });
		} catch (error) {
			errors.attempt("copy-path")(error);
		}
	}
	async function prepare(explicit = true) {
		if (!valid || pending) return;
		errors.clear();
		const fail = explicit
			? errors.attempt("preview")
			: errors.automatic(`preview:${requestVersion.current.revision}`);
		checking.current?.abort();
		const own = new AbortController();
		checking.current = own;
		const checkedKey = key;
		const checkedAttempt = ++previewAttempt.current;
		setPending(true);
		try {
			const result = await bridge.request("submission.preview", request, { signal: own.signal });
			if (live.current && !own.signal.aborted && latestKey.current === checkedKey) {
				setPreview(result);
				setPreviewKey(checkedKey);
				setPreviewNoticeId(checkedAttempt);
				if (!nameEdited.current && !nameSuggested.current && result.suggestedDisplayName) {
					nameSuggested.current = true;
					setDisplayName(result.suggestedDisplayName);
				}
				if (result.submissionPlanId && result.submissionPlanId !== submissionPlanId) {
					const nextKey = submissionRequestKey({
						...request,
						submissionPlanId: result.submissionPlanId
					});
					setSubmissionPlanId(result.submissionPlanId);
					setPreviewKey(nextKey);
					attemptedKey.current = nextKey;
				}
			}
		} catch (e) {
			if (live.current && !own.signal.aborted && latestKey.current === checkedKey && !isAbort(e))
				fail(e);
		} finally {
			if (live.current && checking.current === own) setPending(false);
		}
	}
	useEffect(() => {
		if (!valid || pending || attemptedKey.current === key) return;
		const timer = setTimeout(() => {
			attemptedKey.current = key;
			void prepare(false);
		}, 250);
		return () => clearTimeout(timer);
	}, [valid, pending, key, previewKey]);
	async function submit(confirmedOverwrite?: string) {
		if (
			!valid ||
			!canSubmitPreview(request, previewKey, preview) ||
			pending ||
			submittingRef.current
		)
			return;
		const fail = errors.attempt("submit");
		const submittedKey = key;
		setPending(true);
		if (request.resubmitTaskId && !confirmedOverwrite) {
			try {
				if (!submissionPlanId) throw new Error("请先完成本次提交检查。");
				const value = await bridge.request("submission.overwrite-preview", {
					resubmitTaskId: request.resubmitTaskId,
					submissionPlanId
				});
				if (live.current && latestKey.current === submittedKey) {
					setOverwrite(value);
					setOverwriteKey(submittedKey);
				}
			} catch (error) {
				if (live.current) fail(error);
			} finally {
				if (live.current) setPending(false);
			}
			return;
		}
		if (confirmedOverwrite && overwriteKey !== submittedKey) {
			setPending(false);
			setOverwrite(null);
			return;
		}
		submittingRef.current = true;
		setSubmitting(true);
		try {
			const result = await bridge.request("submission.submit", {
				...request,
				...(confirmedOverwrite ? { overwritePlanId: confirmedOverwrite } : {})
			});
			void releaseDependencies([...dependencySources.current]);
			if (live.current && !closing.current && latestKey.current === submittedKey)
				onSubmitted(result);
		} catch (e) {
			if (live.current && latestKey.current === submittedKey) fail(e);
		} finally {
			submittingRef.current = false;
			if (live.current) {
				setPending(false);
				setSubmitting(false);
			}
		}
	}
	async function acquireManager() {
		const fail = errors.attempt("acquire-manager");
		try {
			await bridge.request("manager.acquire", { entryId: entryId.current });
			await refresh(fail);
		} catch (error) {
			if (live.current) fail(error);
		}
	}
	async function associateLibrary() {
		const fail = errors.attempt("associate-library");
		try {
			await bridge.request("library.associate", {});
			await bridge.request("manager.acquire", { entryId: entryId.current });
			await refresh(fail);
		} catch (error) {
			if (live.current) fail(error);
		}
	}
	async function chooseRoot(kind: "work" | "archive") {
		const fail = errors.attempt("choose-" + kind);
		const ownEnvironment = environmentId;
		try {
			const value = await bridge.request("submission.choose-root", {
				environmentId,
				kind,
				currentPath: kind === "work" ? workingRoot : archiveRoot
			});
			if (
				!live.current ||
				closing.current ||
				liveEnvironment.current !== ownEnvironment ||
				!value.path
			)
				return;
			if (kind === "work") {
				setWorkingRoot(value.path);
				setOverride(true);
			} else {
				setArchiveRoot(value.path);
				setArchiveOverride(true);
			}
		} catch (error) {
			if (live.current) fail(error);
		}
	}
	async function openLocation(kind: "work" | "archive") {
		try {
			await bridge.request("location.open", { kind, submissionPlanId });
		} catch (error) {
			if (live.current) errors.attempt("open-" + kind)(error);
		}
	}
	function editInput(text: string) {
		checking.current?.abort();
		checking.current = null;
		attemptedKey.current = "";
		setPending(false);
		setPreview(null);
		setPreviewKey("");
		setFinalText(text);
	}
	function restoreScript() {
		setCalculationScript(undefined);
		setScriptBasePath(undefined);
		setConfirmReset(false);
		attemptedKey.current = "";
	}
	const scriptText =
		calculationScript?.text ??
		currentPreview?.calculationScript?.text ??
		preview?.calculationScript?.text ??
		"";
	const canOpenWork =
		environment?.connectionKind === "local" || environment?.connectionKind === "wsl";
	const checkState = submitting
		? "正在提交"
		: pending
			? "检查中"
			: !valid
				? "待补充"
				: !currentPreview
					? "待检查"
					: currentPreview.restrictions.length
						? "有需处理项"
						: "可提交";
	const restrictions = (currentPreview?.restrictions ?? []).map((restriction, index) => (
		<SubmissionRestrictionNotice key={restriction} identity={`preview:${previewNoticeId}:${index}`}
			restriction={restriction} detail={currentPreview?.restrictionDetails?.find(value => value.code === restriction)}
			engine={input.engineId} bridge={bridge} />
	));
	function filesContent() {
		return (
			<>
				<div className="task-submit-file-tabs" role="tablist" aria-label="文件与脚本">
					{(
						[
							["input", "最终输入"],
							["dependencies", "依赖文件"],
							["script", "最终脚本"]
						] as const
					).map(([id, label]) => (
						<button
							type="button"
							role="tab"
							aria-selected={fileTab === id}
							key={id}
							onClick={() => setFileTab(id)}
						>
							{label}
						</button>
					))}
				</div>
				<div className="task-submit-editor-actions">
					<span>
						{fileTab === "input"
							? input.inputName
							: fileTab === "dependencies"
								? `${dependencies.length} 个已读入依赖`
								: calculationScript
									? "手改脚本"
									: "环境生成脚本"}
					</span>
					{fileTab !== "dependencies" && (
						<button
							type="button"
							onClick={() => void copy(fileTab === "input" ? finalText : scriptText)}
						>
							复制
						</button>
					)}
					<button type="button" onClick={() => setExpandedEditor((value) => !value)}>
						{expandedEditor ? "返回表单" : "放大编辑"}
					</button>
				</div>
				{fileTab === "input" && (
					<div role="tabpanel" aria-label="最终输入">
						<textarea
							aria-label="最终输入原文"
							rows={14}
							spellCheck={false}
							disabled={submitting}
							aria-invalid={!finalText.trim()}
							value={finalText}
							onChange={(event) => editInput(event.target.value)}
						/>
					</div>
				)}
				{fileTab === "dependencies" && (
					<div role="tabpanel" aria-label="依赖文件">
						<button type="button" disabled={submitting} onClick={() => void chooseDependencies()}>
							添加依赖文件
						</button>
						{dependencies.length ? (
							<div className="task-table-scroll">
								<table>
									<thead>
										<tr>
											<th>名称</th>
											<th>用途</th>
											<th>大小</th>
											<th>状态</th>
											<th>操作</th>
										</tr>
									</thead>
									<tbody>
										{dependencies.map((file, index) => (
											<tr key={file.sourceRef}>
												<td>{file.name}</td>
												<td>{file.role}</td>
												<td>{bytesLabel(file.size)}</td>
												<td>已读入</td>
												<td>
													<button
														type="button"
														disabled={submitting}
														onClick={() => void chooseDependencies(index)}
														aria-label={`更换依赖 ${file.name}`}
													>
														更换
													</button>{" "}
													<button
														type="button"
														disabled={submitting}
														onClick={() => removeDependency(index)}
														aria-label={`移除依赖 ${file.name}`}
													>
														移除
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<p>未关联附加依赖</p>
						)}
					</div>
				)}
				{fileTab === "script" && (
					<div role="tabpanel" aria-label="最终脚本">
						<textarea
							aria-label="最终计算脚本"
							rows={14}
							spellCheck={false}
							disabled={submitting || (!scriptText && !preview)}
							value={scriptText}
							onChange={(event) => {
								if (!calculationScript) setScriptBasePath(preview?.workingPath);
								setCalculationScript({
									kind:
										preview?.calculationScript?.kind ??
										(environment?.connectionKind === "local" ? "powershell" : "bash"),
									text: event.target.value
								});
							}}
						/>
						{scriptPathInvalid && (
							<DismissibleNotice identity={scriptBasePath + ":" + preview?.workingPath}>
								工作目录已改变，手改脚本仍引用原路径。请修正或恢复生成脚本。
							</DismissibleNotice>
						)}
						<button
							type="button"
							disabled={submitting || !calculationScript}
							onClick={() => setConfirmReset(true)}
						>
							恢复生成脚本
						</button>
						<details>
							<summary>受管执行外壳（只读）</summary>
							<pre>{currentPreview?.script ?? preview?.script ?? "等待检查"}</pre>
						</details>
					</div>
				)}
				{restrictions}
			</>
		);
	}
	return (
		<DialogShell
			className="task-dialog task-submit-dialog"
			onCancel={closeDialog}
			aria-label={initialRequest?.resubmitTaskId ? "重新提交计算" : "提交计算"}
		>
			<header>
				<h2>{initialRequest?.resubmitTaskId ? "重新提交计算" : "提交计算"}</h2>
				<button type="button" aria-label="关闭提交计算" onClick={closeDialog}>
					×
				</button>
			</header>
			<div className="task-submit-scroll">
				{errors.notice && (
					<TaskErrorNotice {...errors.notice} bridge={bridge} onDismiss={errors.dismiss} />
				)}
				{view && view.manager.access !== "manager" && view.library.path && (
					<div className="task-access">
						只读 ·{" "}
						{view.manager.ownerLabel
							? `${view.manager.ownerLabel} 正在管理任务库`
							: (view.manager.reason ?? "尚未取得管理权")}
						<button type="button" onClick={() => void acquireManager()}>
							取得管理权
						</button>
					</div>
				)}
				{view && (!view.library.path || view.manager.access === "unavailable") && (
					<TaskLibraryEntry
						bridge={bridge}
						library={view.library}
						onChanged={async () => {
							await acquireManager();
						}}
					/>
				)}
				{view?.library.migrating && <p role="status">任务库迁移中，暂缓新提交</p>}
				<div className="task-submit-main-fields">
					<label>
						任务名称
						<input
							value={displayName}
							disabled={submitting}
							aria-invalid={!displayName.trim()}
							onChange={(event) => {
								nameEdited.current = true;
								setDisplayName(event.target.value);
							}}
						/>
					</label>
					<div className="task-submit-environment">
						<label>
							执行环境
							<select
								value={environmentId}
								disabled={submitting}
								onChange={(event) => setEnvironmentId(event.target.value)}
							>
								<option value="">请选择环境</option>
								{view?.environments
									.filter((env) => env.engineId === input.engineId)
									.map((env) => (
										<option key={env.environmentId} value={env.environmentId}>
											{env.displayName}
										</option>
									))}
							</select>
						</label>
						<button type="button" disabled={submitting} onClick={() => setConfiguration(true)}>
							配置
						</button>
					</div>
					<details className="task-submit-groups">
						<summary>
							归属分组 ·{" "}
							{groupIds.length
								? groupIds
										.map(
											(id) =>
												view?.groups.find((group) => group.groupId === id)?.displayName ??
												"组不可用"
										)
										.join("、")
								: "未分组"}
						</summary>
						{view?.groups.length ? (
							view.groups.map((group) => (
								<label className="task-checkbox" key={group.groupId}>
									<input
										type="checkbox"
										disabled={submitting}
										checked={groupIds.includes(group.groupId)}
										onChange={(event) =>
											setGroupIds((current) =>
												event.target.checked
													? [...current, group.groupId]
													: current.filter((id) => id !== group.groupId)
											)
										}
									/>
									{group.displayName}
								</label>
							))
						) : (
							<p>暂无分组</p>
						)}
					</details>
				</div>
				<div className="task-submit-summary">
					<span>
						输入识别：{input.engineId === "gaussian" ? "Gaussian" : "ORCA"} ·{" "}
						{currentPreview?.taskKind
							? taskKindLabel(currentPreview.taskKind)
							: currentPreview
								? "任务类型待核实"
								: "待检查"}
					</span>
					<details>
						<summary>环境详情</summary>
						<dl>
							<dt>目标</dt>
							<dd>
								{environment
									? environment.connectionKind === "local"
										? "本机"
										: environment.connectionKind === "wsl"
											? `${environment.distribution} · ${environment.user}`
											: `${environment.user}@${environment.host}:${environment.port}`
									: "待选择"}
							</dd>
							<dt>软件入口</dt>
							<dd>{currentPreview?.executable ?? environment?.executable ?? "待选择"}</dd>
							<dt>版本</dt>
							<dd>{currentPreview?.softwareVersion ?? "未知"}</dd>
						</dl>
					</details>
				</div>
				<section className="task-submit-section">
					<h3>计算资源</h3>
					<SubmissionResourceEditor
						engine={input.engineId}
						text={finalText}
						disabled={submitting}
						onChange={setFinalText}
						onInvalid={setResourceInvalid}
					/>
					{resources.length > 0 && (
						<dl>
							{resources.map((resource, index) => (
								<div key={index}>
									<dt>{resource.label}</dt>
									<dd>
										{resource.value} <small>· {resource.source}</small>
									</dd>
								</div>
							))}
						</dl>
					)}
					{environment?.schedulerKind === "slurm" && (
						<fieldset>
							<legend>Slurm申请</legend>
							<div className="task-form-grid">
								{(
									[
										["分区", partition, setPartition],
										["账户", account, setAccount],
										["QoS", qos, setQos],
										["申请时限", timeLimit, setTimeLimit]
									] as const
								).map(([label, value, setter]) => (
									<label key={label}>
										{label}
										<input
											value={value}
											disabled={submitting}
											onChange={(event) => setter(event.target.value)}
										/>
									</label>
								))}
							</div>
						</fieldset>
					)}
				</section>
				<section className="task-submit-section">
					<h3>提交位置</h3>
					{(["work", ...(dualDirectory ? (["archive"] as const) : [])] as const).map((kind) => {
						const path =
							kind === "work" ? currentPreview?.workingPath : currentPreview?.archivePath;
						const canOpen = kind === "archive" || canOpenWork;
						return (
							<div className="task-submit-location" key={kind}>
								<strong>{kind === "work" ? "工作目录" : "归档目录"}</strong>
								<span className="task-path">
									{path ?? (environment ? "正在准备" : "待选择环境")}
								</span>
								<div className="task-submit-location-actions">
									<button type="button" disabled={!path} onClick={() => void copy(path)}>
										复制
									</button>
									{canOpen && (
										<button
											type="button"
											disabled={!submissionPlanId || !path}
											onClick={() => void openLocation(kind)}
										>
											打开/父目录
										</button>
									)}
									<button
										type="button"
										disabled={!environment || submitting || Boolean(initialRequest?.resubmitTaskId)}
										onClick={() => void chooseRoot(kind)}
									>
										更改
									</button>
								</div>
							</div>
						);
					})}
				</section>
				<details className="task-submit-files">
					<summary>
						文件与脚本 · {input.inputName} · 依赖 {dependencies.length} ·{" "}
						{calculationScript ? "手改脚本" : "环境生成"}
					</summary>
					{!expandedEditor && filesContent()}
				</details>
			</div>
			<footer>
				<span className="task-submit-status" role="status">
					{checkState}
				</span>
				<button type="button" onClick={closeDialog}>
					取消
				</button>
				<button type="button" disabled={!valid || pending} onClick={() => void prepare()}>
					重新检查
				</button>
				<button
					type="button"
					className="button button-primary"
					disabled={!valid || pending || !canSubmitPreview(request, previewKey, preview)}
					onClick={() => void submit()}
				>
					提交计算
				</button>
			</footer>
			{configuration && (
				<EnvironmentSettings
					bridge={bridge}
					environments={view?.environments ?? []}
					canManage={view?.manager.access === "manager"}
					onChanged={refresh}
					onClose={() => setConfiguration(false)}
				/>
			)}
			{expandedEditor && (
				<DialogShell
					className="task-dialog task-submit-file-expanded"
					onCancel={() => setExpandedEditor(false)}
					aria-label="放大编辑文件与脚本"
				>
					<header>
						<h2>文件与脚本</h2>
						<button type="button" onClick={() => setExpandedEditor(false)}>
							返回表单
						</button>
					</header>
					{filesContent()}
				</DialogShell>
			)}
			{confirmReset && (
				<DialogShell
					className="task-dialog"
					onCancel={() => setConfirmReset(false)}
					aria-label="恢复生成脚本"
				>
					<h2>恢复生成脚本？</h2>
					<p>将替换当前手改计算脚本。</p>
					<footer>
						<button type="button" onClick={() => setConfirmReset(false)}>
							取消
						</button>
						<button type="button" onClick={restoreScript}>
							恢复
						</button>
					</footer>
				</DialogShell>
			)}
			{overwrite && (
				<DialogShell
					className="task-dialog"
					onCancel={() => setOverwrite(null)}
					aria-label="确认覆盖重提"
				>
					<h2>覆盖原任务并重新提交？</h2>
					<p>
						原工作文件 {overwrite.workFiles.length} 项，共 {bytesLabel(overwrite.workBytes)}
						；原归档文件 {overwrite.archiveFiles.length} 项，共 {bytesLabel(overwrite.archiveBytes)}
						。
					</p>
					<p>确认后清空上述文件，并使用当前输入在原任务中重新运行。</p>
					<details>
						<summary>精确文件清单</summary>
						<ul>
							{[...overwrite.workFiles, ...overwrite.archiveFiles].map((file) => (
								<li key={file.path}>
									{file.path} · {bytesLabel(file.byteSize)}
								</li>
							))}
						</ul>
					</details>
					<footer>
						<button type="button" onClick={() => setOverwrite(null)}>
							取消
						</button>
						<button
							type="button"
							disabled={pending || overwriteKey !== key}
							onClick={() => {
								const id = overwrite.overwritePlanId;
								setOverwrite(null);
								void submit(id);
							}}
						>
							确认覆盖并提交
						</button>
					</footer>
				</DialogShell>
			)}
		</DialogShell>
	);
}
