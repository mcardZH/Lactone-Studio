import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import {
	ProjectUiScope,
	ProjectUiStore,
	ProjectNativeDetailsBoundary
} from "../../projects/ui-state";
import {
	WorkspaceColumns,
	WorkspaceColumnDivider,
	useWorkspaceColumns
} from "../modeling/WorkspaceColumns";
import { InputSettingsCard } from "../InputSettingsFields";
import { InputSettingsLayout } from "../InputSettingsLayout";
import TaskDirectories from "./TaskDirectories";
import type { TrajectoryResult } from "../../results/contracts";
import type { Structure } from "../../core/types";
import type {
	MonitoringSettings,
	TaskCardView,
	TaskManagerView,
	TaskMonitorView,
	TaskOperationPlan,
	TaskSystemBridge
} from "../../task-system/application-contracts";
import { TaskMonitorWorkspaceCache, type TaskMonitorPublication } from "./monitor-workspace-cache";
import { DismissibleNotice } from "../DismissibleNotice";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope, type TaskErrorDismissalState } from "./task-error-scope";
import TaskScientificStates from "./TaskScientificStates";
import TaskMonitorResults from "./TaskMonitorResults";
import {
	EMPTY_MONITOR_FRAMES,
	mergeMonitorFrames,
	MonitorRevisionError,
	type MonitorFrames
} from "./monitor-state";
import OperationDialog from "./OperationDialog";
import {
	bytesLabel,
	isAbort,
	taskStatus,
	timeLabel,
	taskStopPresentation,
	taskStatusTone,
	elapsedLabel,
	taskKindLabel
} from "./presentation";
import { useTaskTextPreviewWindows, type OpenTaskPreview } from "./TaskTextPreviewWindows";

export interface TaskMonitorProps {
	workspaceCache?: TaskMonitorWorkspaceCache;
	previewNotice?: { error: string; identity: string; taskId?: string };
	onDismissPreview?(): void;
	bridge: TaskSystemBridge;
	taskId: string;
	manager: TaskManagerView;
	settings: MonitoringSettings;
	initialTask?: TaskCardView;
	onBack(): void;
	onChanged?(): void | Promise<void>;
	onPreview?: OpenTaskPreview;
	onExtract?(structure: Structure): void;
	onResubmit?(taskId: string): void;
	onOperationStarted?(operationId: string): void;
	onOpenSnapshot?(
		taskId: string,
		snapshotId: string,
		leaseId: string,
		canNavigate?: () => boolean
	): void | Promise<void>;
}
const progressLabels = {
	connecting: "连接来源",
	transferring: "读取来源",
	parsing: "解析结果",
	preparing: "准备结构",
	publishing: "发布结果",
	ready: "结果就绪",
	failed: "读取失败"
};
const EMPTY_RESULTS: TrajectoryResult[] = [];
/** A paused animation is not a frozen source. Only a verified ended Run, or
 * an explicit source-only saved version, can make this publication fixed. */
export function taskMonitorCollectionFixed(task:TaskCardView|undefined,publication:TaskMonitorView|null|undefined):boolean {
	if(!task||!publication||task.taskId!==publication.task.taskId||task.runId!==publication.task.runId||!publication.prepared||publication.resultsComplete!==true)return false;
	if(task.noRun===true)return Boolean(task.sourceSetId&&task.sourceVersion&&publication.sourceIdentity?.runId===null&&task.stopControl?.canRequest!==true);
	return task.executionState==='ended'&&task.verificationState==='verified'&&task.stopControl?.canRequest!==true;
}
type OpeningReadAction = "idle" | "prepare" | "follow" | "settled";
type OpeningMonitorView = TaskMonitorView & { actualReadLocation?: { path?: string } };
/** One opening owns one preparation request; following it never refreshes the source. */
export class TaskMonitorOpeningRead {
	action: OpeningReadAction = "idle";
	private source: string | null = null;
	private attempted = false;
	private previousProgress: string | null = null;
	constructor(private readonly taskId: string) {}
	started() {
		if (this.action === "prepare") {
			this.attempted = true;
			this.action = "follow";
		}
	}
	cancel() {
		this.action = "settled";
	}
	observe(view: OpeningMonitorView, access: TaskManagerView["access"]): OpeningReadAction {
		if (this.action === "settled") return this.action;
		if (view.task.taskId !== this.taskId) {
			this.cancel();
			return this.action;
		}
		const candidates = view.task.noRun
			? view.files.filter((file) => file.path && file.path === view.actualReadLocation?.path)
			: view.files.filter((file) => file.role.split("、").includes("primary-output"));
		const main = candidates.length === 1 ? candidates[0] : null;
		const source =
			main &&
			JSON.stringify([
				view.task.taskId,
				view.task.runId,
				view.task.sourceSetId,
				view.task.sourceVersion,
				main.artifactId,
				main.path,
				main.sourceKind,
				main.sourceId,
				main.sourceVersion,
				main.sourceGeneration,
				main.sourceIdentity
			]);
		const samePublication =
			view.prepared &&
			view.collectionId &&
			view.revision &&
			main &&
			view.sourceIdentity?.taskId === this.taskId &&
			view.sourceIdentity.runId === view.task.runId &&
			view.sourceIdentity.artifactId === main.artifactId &&
			view.sourceIdentity.path === main.path;
		// A valid prefix remains consumable even alongside warnings or later read failures.
		if (samePublication || (this.source !== null && this.source !== source)) {
			this.cancel();
			return this.action;
		}
		const failedSource = view.notices.some((notice) => {
			if (notice.artifactId && notice.artifactId !== main?.artifactId) return false;
			if (notice.severity === "error") return true;
			try {
				const detail = JSON.parse(notice.details ?? "null");
				return ["scientific-source", "scientific-refresh"].includes(detail?.stage);
			} catch {
				return false;
			}
		});
		const supported = view.task.noRun
			? main?.role
					.split("、")
					.some((role) =>
						["primary-output", "structure", "trajectory", "wavefunction", "modes"].includes(role)
					)
			: ["gaussian", "orca"].includes(view.task.engineId);
		if (
			access !== "manager" ||
			!main ||
			!source ||
			!supported ||
			main.exists !== true ||
			main.readable !== true ||
			!main.path ||
			!(main.size != null && main.size > 0) ||
			view.task.failureKind === "submission" ||
			failedSource
		) {
			this.cancel();
			return this.action;
		}
		const progress =
			view.progress &&
			view.progress.taskId === this.taskId &&
			view.progress.runId === view.task.runId &&
			view.progress.artifactId === main.artifactId
				? JSON.stringify([view.progress.operationId, view.progress.sequence, view.progress.stage])
				: null;
		if (!this.attempted) {
			this.source = source;
			this.previousProgress = progress;
			this.action = "prepare";
		} else if (
			progress &&
			progress !== this.previousProgress &&
			(view.progress?.stage === "failed" || view.progress?.stage === "ready")
		) {
			// A completed empty/unsupported read is not an endlessly pending publication.
			this.cancel();
		} else this.action = "follow";
		return this.action;
	}
}
export function taskMonitorReadSchedule(p: {
	ended: boolean;
	automatic: boolean;
	seconds: string;
	preparing: boolean;
	followingOpening: boolean;
}) {
	if (p.ended && !p.preparing) return null;
	const interval = Number(p.seconds);
	if (!p.preparing && (!/^\d+$/.test(p.seconds) || interval < 1 || !p.automatic)) return null;
	return {
		refresh: !p.followingOpening && !p.ended && p.automatic,
		milliseconds: (p.preparing ? 1 : interval) * 1000
	};
}
export default function TaskMonitor(p: TaskMonitorProps) {
	const { bridge, taskId, manager, settings } = p;
	const [ownedCache] = useState(() => new TaskMonitorWorkspaceCache()),
		workspace = p.workspaceCache ?? ownedCache,
		initial = workspace.latest(taskId);
	const columns = useWorkspaceColumns("task-center");
	const sidebar = useRef<HTMLElement>(null);
	const retainedPreferences = workspace.readPresentation<{ automatic: boolean; seconds: string }>(
		`monitor-preferences:${taskId}`
	);
	const [view, setView] = useState<TaskMonitorView | null>(initial?.view ?? null),
		[preparationHost, setPreparationHost] = useState<HTMLElement | null>(null),
		[publication, setPublication] = useState<TaskMonitorPublication | null>(initial ?? null),
		[openingAction, setOpeningAction] = useState<OpeningReadAction>("idle"),
		[pending, setPending] = useState(false),
		[automatic, setAutomatic] = useState(retainedPreferences?.automatic ?? settings.automatic),
		[seconds, setSeconds] = useState(
			retainedPreferences?.seconds ??
				String(
					p.initialTask?.connectionKind === "ssh"
						? settings.remoteIntervalSeconds
						: settings.localIntervalSeconds
				)
		),
		[plan, setPlan] = useState<TaskOperationPlan | null>(null),
		[rename, setRename] = useState<string | null>(null),
		[snapshotPending, setSnapshotPending] = useState(false);
	useLayoutEffect(() => {
		workspace.writePresentation(`monitor-preferences:${taskId}`, { automatic, seconds });
	}, [workspace, taskId, automatic, seconds]);
	const live = useRef(true),
		opening = useRef(new TaskMonitorOpeningRead(taskId)),
		inflight = useRef<AbortController | null>(null),
		cache = useRef(initial?.frames ?? EMPTY_MONITOR_FRAMES),
		snapshotEpoch = useRef(0);
	const dismissalKey = JSON.stringify([
		taskId,
		view?.task.runId ?? p.initialTask?.runId,
		view?.collectionId,
		view?.sourceGeneration
	]);
	const dismissals = useMemo(() => {
		const key = `errors:${dismissalKey}`;
		let memory = workspace.readPresentation<TaskErrorDismissalState>(key);
		if (!memory) {
			memory = { automaticCauses: new Set() };
			workspace.writePresentation(key, memory);
		}
		return memory;
	}, [workspace, dismissalKey]);
	const errors = useTaskErrorScope(
		`monitor:${taskId}:${view?.task.runId ?? "no-run"}:${manager.epoch ?? "readonly"}`,
		dismissals
	);
	const previews = useTaskTextPreviewWindows(bridge, errors.automatic("preview-window"));
	const task = view?.task ?? p.initialTask,
		ended = task?.executionState === "ended";
	const presentationIdentity = JSON.stringify([
		taskId,
		task?.runId,
		view?.collectionId,
		view?.sourceGeneration
	]);
	const ui = useMemo(() => {
		const key = `monitor-ui:${presentationIdentity}`;
		let store = workspace.readPresentation<ProjectUiStore>(key);
		if (!store) {
			store = new ProjectUiStore();
			workspace.writePresentation(key, store);
		}
		return store;
	}, [workspace, presentationIdentity]);
	useLayoutEffect(() => {
		const host = sidebar.current;
		if (!host) return;
		host.scrollTop = workspace.readPresentation<number>(`monitor-scroll:${taskId}`) ?? 0;
	}, [taskId]);
	const observedFrame = useRef<Structure | null>(null),
		captureFrame = useCallback((structure: Structure | null) => {
			observedFrame.current = structure;
		}, []);
	async function read(refresh: boolean, explicit = false) {
		if (!live.current || inflight.current) return;
		const own = new AbortController();
		inflight.current = own;
		if (refresh && manager.access === "manager") opening.current.started();
		setPending(true);
		const fail = explicit ? errors.attempt("refresh") : errors.automatic("read");
		try {
			let value = await bridge.request(
				"monitor.read",
				{
					taskId,
					refresh: refresh && manager.access === "manager",
					knownRevision: cache.current.revision
				},
				{ signal: own.signal }
			);
			if (!live.current || own.signal.aborted) return;
			if (value.task.taskId !== taskId) throw new Error("读取结果不属于当前任务。");
			let merged: MonitorFrames;
			try {
				merged = mergeMonitorFrames(cache.current, value);
			} catch (error) {
				if (!(error instanceof MonitorRevisionError)) throw error;
				value = await bridge.request(
					"monitor.read",
					{ taskId, refresh: false, knownRevision: null },
					{ signal: own.signal }
				);
				if (!live.current || own.signal.aborted) return;
				merged = mergeMonitorFrames(EMPTY_MONITOR_FRAMES, value);
			}
			if (value.task.taskId !== taskId) throw new Error("读取结果不属于当前任务。");
			cache.current = merged;
			setView(value);
			setPublication(workspace.publish(taskId, value, merged));
			setOpeningAction(opening.current.observe(value, manager.access));
		} catch (error) {
			if (!own.signal.aborted) {
				opening.current.cancel();
				setOpeningAction("settled");
			}
			if (live.current && !own.signal.aborted && !isAbort(error)) fail(error);
		} finally {
			if (inflight.current === own) {
				inflight.current = null;
				if (live.current) setPending(false);
			}
		}
	}
	useEffect(() => {
		live.current = true;
		opening.current = new TaskMonitorOpeningRead(taskId);
		setOpeningAction("idle");
		void read(false);
		return () => {
			live.current = false;
			opening.current.cancel();
			snapshotEpoch.current++;
			inflight.current?.abort();
			inflight.current = null;
			void bridge.request("monitor.release", { taskId }).catch(() => {});
		};
	}, [bridge, taskId, manager.epoch]);
	useEffect(() => {
		if (openingAction === "prepare") void read(true);
	}, [openingAction]);
	const followingOpening = openingAction === "follow",
		preparing =
			followingOpening ||
			Boolean(view?.progress && !["ready", "failed"].includes(view.progress.stage));
	useEffect(() => {
		// Native terminal stops source polling; a preparation owner may still publish.
		const schedule = taskMonitorReadSchedule({
			ended,
			preparing,
			followingOpening,
			automatic,
			seconds
		});
		if (!schedule) return;
		const timer = setInterval(() => void read(schedule.refresh), schedule.milliseconds);
		return () => clearInterval(timer);
	}, [
		ended,
		preparing,
		followingOpening,
		automatic,
		seconds,
		manager.access,
		manager.epoch,
		bridge,
		taskId
	]);
	useEffect(
		() => (publication ? workspace.retain(publication) : undefined),
		[workspace, publication]
	);
	const ownedEpoch = useRef(0);
	useEffect(() => {
		const epoch = ++ownedEpoch.current;
		return () => {
			if (!p.workspaceCache)
				queueMicrotask(() => {
					if (ownedEpoch.current === epoch) ownedCache.clear();
				});
		};
	}, [ownedCache, p.workspaceCache]);
	const results = publication?.results ?? EMPTY_RESULTS;
	const continuity =
		publication &&
		publication.view.collectionId &&
		publication.view.revision &&
		typeof publication.view.sourceGeneration === "number"
			? {
					ownerId: taskId,
					collectionId: publication.view.collectionId,
					sourceGeneration: publication.view.sourceGeneration,
					revision: publication.view.revision,
					baseRevision: publication.view.baseRevision,
					incremental: !publication.view.reset
				}
			: undefined;
	const stop = taskStopPresentation(task, manager.access === "manager"),
		progress = view?.progress;
	const fraction =
		progress?.stage === "transferring" && progress.totalBytes && progress.totalBytes > 0
			? Math.min(1, progress.completedBytes / progress.totalBytes)
			: null;
	async function snapshot() {
		const epoch = ++snapshotEpoch.current;
		setSnapshotPending(true);
		const canNavigate = () => live.current && snapshotEpoch.current === epoch;
		try {
			const result = await bridge.request("snapshot.open", { taskId });
			if (p.onOpenSnapshot)
				await p.onOpenSnapshot(taskId, result.snapshotId, result.leaseId, canNavigate);
			else
				await bridge.request("snapshot.release", {
					snapshotId: result.snapshotId,
					leaseId: result.leaseId
				});
		} catch (error) {
			if (canNavigate()) errors.attempt("snapshot")(error);
		} finally {
			if (canNavigate()) setSnapshotPending(false);
		}
	}
	async function saveRename() {
		if (!rename?.trim()) return;
		try {
			await bridge.request("task.rename", { taskId, displayName: rename.trim() });
			setRename(null);
			await read(false);
			await p.onChanged?.();
		} catch (error) {
			errors.attempt("rename")(error);
		}
	}
	return (
		<ProjectUiScope store={ui} scope={["task-monitor", presentationIdentity]}>
			<ProjectNativeDetailsBoundary>
				<WorkspaceColumns
					sizes={columns.sizes}
					className="task-monitor"
					aria-label="任务监控"
					data-testid="task-monitor"
				>
					<aside
						ref={sidebar}
						style={{ gridColumn: 1, gridRow: 1 }}
						onScroll={(event) =>
							workspace.writePresentation(`monitor-scroll:${taskId}`, event.currentTarget.scrollTop)
						}
						className="task-monitor-info postprocess-sidebar workspace-workflow-panel desktop-mode"
						aria-label="任务信息"
					>
						<div className="task-actions">
							<button onClick={p.onBack}>返回任务列表</button>
							<button disabled={!view || snapshotPending} onClick={() => void snapshot()}>
								{snapshotPending ? "正在交接…" : "转到后处理"}
							</button>
						</div>
						<InputSettingsLayout>
							<InputSettingsCard title="运行信息">
								<div className="task-monitor-name">
									<button
										disabled={manager.access !== "manager"}
										onClick={() => setRename(task?.displayName ?? "")}
									>
										改名
									</button>
								</div>
								{rename !== null && (
									<form
										onSubmit={(event) => {
											event.preventDefault();
											void saveRename();
										}}
									>
										<input
											aria-label="任务名称"
											value={rename}
											onChange={(event) => setRename(event.target.value)}
										/>
										<button disabled={!rename.trim()}>保存</button>
										<button type="button" onClick={() => setRename(null)}>
											取消
										</button>
									</form>
								)}
								{errors.notice && (
									<TaskErrorNotice {...errors.notice} bridge={bridge} onDismiss={errors.dismiss} />
								)}
								{p.previewNotice &&
									(!p.previewNotice.taskId || p.previewNotice.taskId === taskId) && (
										<TaskErrorNotice
											{...p.previewNotice}
											bridge={bridge}
											onDismiss={p.onDismissPreview}
										/>
									)}
								{view?.notices
									.filter(
										(notice) =>
											!workspace.readPresentation(
												`notice:${dismissalKey}:${notice.id}:${notice.message}`
											) &&
											(notice.severity !== "warning" ||
												!view.files.some((file) => file.artifactId === notice.artifactId))
									)
									.map((notice) => (
										<DismissibleNotice
											key={notice.id}
											onDismiss={() =>
												workspace.writePresentation(
													`notice:${dismissalKey}:${notice.id}:${notice.message}`,
													true
												)
											}
											identity={`${taskId}:${task?.runId}:${view.sourceGeneration}:${notice.id}:${notice.message}`}
										>
											<span>{notice.message}</span>
											{notice.details && (
												<details>
													<summary>详情</summary>
													<pre>{notice.details}</pre>
												</details>
											)}
										</DismissibleNotice>
									))}
								{(!view || pending || preparing) && (
									<div className="task-read-progress" role="status">
										<span>
											{progress
												? progressLabels[progress.stage]
												: pending
													? "读取中"
													: "正在打开任务"}
										</span>
										<progress max={1} value={fraction ?? undefined} />
										{fraction !== null && <span>{Math.round(fraction * 100)}%</span>}
										<span>
											{progress
												? `${progress.completeFrames} 完整帧${progress.stage === "preparing" ? ` · 已准备 ${progress.preparedFrames} 帧` : ""} · ${bytesLabel(progress.completedBytes)}`
												: ""}
										</span>
										<span>预计剩余 估算中</span>
									</div>
								)}
								<div ref={setPreparationHost} className="task-display-preparation" />
								<p>
									{task?.engineId === "gaussian"
										? "Gaussian"
										: (task?.engineId.toUpperCase() ?? "—")}{" "}
									· {taskKindLabel(task?.taskKind ?? "")} ·{" "}
									{task?.noRun ? "外部结果" : (task?.environmentName ?? "—")}
								</p>
								<p
									className="task-state"
									data-status-tone={task ? taskStatusTone(task) : "unknown"}
								>
									{task ? taskStatus(task) : "读取中"}
								</p>
								{task?.resourceSummary && (
									<p>
										{task.resourceSummary.cpuValue ?? "未知"} {task.resourceSummary.cpuLabel} ·{" "}
										{task.resourceSummary.memoryScope === "per-process"
											? "每进程内存"
											: task.resourceSummary.memoryScope === "total"
												? "总内存"
												: "内存"}{" "}
										{task.resourceSummary.memoryValue ?? "未知"}{" "}
										{task.resourceSummary.memoryUnit}{" "}
									</p>
								)}
								{!task?.noRun && (
									<p>
										{ended ? "运行用时" : "已运行"}{" "}
										{elapsedLabel(view?.elapsedSeconds ?? task?.elapsedSeconds)}
									</p>
								)}
								<div className="task-monitor-update">
									<label>
										<input
											type="checkbox"
											checked={automatic && !ended}
											disabled={ended || manager.access !== "manager"}
											onChange={(event) => setAutomatic(event.target.checked)}
										/>
										自动更新
									</label>
									<label>
										每
										<input
											aria-label="任务更新间隔"
											inputMode="numeric"
											value={seconds}
											aria-invalid={!/^\d+$/.test(seconds) || Number(seconds) < 1}
											onChange={(event) => setSeconds(event.target.value)}
											onBlur={() => {
												if (
													/^\d+$/.test(seconds) &&
													Number(seconds) >= 1 &&
													manager.access === "manager"
												)
													void bridge
														.request("monitor.settings", {
															...settings,
															automatic,
															...(task?.connectionKind === "ssh"
																? { remoteIntervalSeconds: Number(seconds) }
																: { localIntervalSeconds: Number(seconds) })
														})
														.catch(errors.attempt("settings"));
											}}
										/>
										秒
									</label>
									<button disabled={pending} onClick={() => void read(true, true)}>
										{pending ? "更新中…" : "立即更新"}
									</button>
								</div>
								{(!ended || task?.stopControl?.canRequest || stop.pending) && (
									<button
										disabled={!stop.canRequest}
										title={stop.reason}
										onClick={() =>
											void bridge
												.request("operation.plan", { action: "stop", taskIds: [taskId] })
												.then(setPlan)
												.catch(errors.attempt("stop-plan"))
										}
									>
										{stop.label}
									</button>
								)}
								{ended && !task?.noRun && (
									<button
										disabled={
											manager.access !== "manager" ||
											Boolean(task?.stopControl?.targets.length) ||
											!p.onResubmit
										}
										onClick={() => p.onResubmit?.(taskId)}
									>
										重新提交
									</button>
								)}
							</InputSettingsCard>
							<InputSettingsCard title="任务文件">
								<p>
									当前来源{" "}
									{view?.resultSource
										? view.resultSource.kind === "archive"
											? "归档目录"
											: "工作目录"
										: "待核实"}
								</p>
								<ul className="task-file-list">
									{view?.files.map((file) => (
										<li key={file.artifactId}>
											<span title={file.path}>{file.name}</span>
											<small>
												{bytesLabel(file.size)} ·{" "}
												{file.exists === false
													? "不存在"
													: file.readable === true
														? "可读取"
														: file.readable === false
															? "不可读取"
															: "待核实"}
											</small>
											{(view?.notices ?? [])
												.filter(
													(notice) =>
														notice.severity === "warning" && notice.artifactId === file.artifactId
												)
												.map((notice) => (
													<details key={notice.id} className="task-source-warning">
														<summary aria-label={`${file.name} 来源警告`} title={notice.message}>
															⚠
														</summary>
														<DismissibleNotice
															identity={`${taskId}:${task?.runId}:${notice.id}:${notice.message}`}
														>
															{notice.message}
															{notice.details && <pre>{notice.details}</pre>}
														</DismissibleNotice>
													</details>
												))}
											{file.kind === "text" && (
												<button
													disabled={file.exists === false}
													onClick={() => (p.onPreview ?? previews.open)(taskId, file, ended)}
												>
													预览
												</button>
											)}
											{file.kind === "binary" && <small>二进制</small>}
										</li>
									))}
								</ul>
								<button
									disabled={!p.onExtract || !results.length}
									onClick={() => {
										const frame = observedFrame.current;
										if (!frame) {
											errors.attempt("extract")("当前帧仍在准备，请稍后重试。");
											return;
										}
										p.onExtract?.(structuredClone(frame));
									}}
								>
									以当前帧副本新建结构并编辑
								</button>
							</InputSettingsCard>
							<InputSettingsCard title="目录">
								{task && (
									<TaskDirectories
										task={task}
										bridge={bridge}
										canManage={manager.access === "manager"}
										onAction={(action) =>
											void bridge
												.request("operation.plan", { action, taskIds: [taskId] })
												.then(setPlan)
												.catch(errors.attempt("directory-plan"))
										}
										onError={(error) => errors.attempt("directory")(error)}
									/>
								)}
								<details>
									<summary>路径与详细信息</summary>
									<dl>
										<dt>当前阶段</dt>
										<dd>{view?.stage ?? "暂无数据"}</dd>
										<dt>真实迭代</dt>
										<dd>{view?.iteration ?? "暂无数据"}</dd>
										<dt>最近成功更新</dt>
										<dd>{timeLabel(view?.updatedAt ?? null)}</dd>
										<dt>
											{task?.noRun
												? task.sourcePath && task.sourcePath === task.archivePath
													? "归档来源位置"
													: "来源位置"
												: "原运行位置"}
										</dt>
										<dd>
											<code>{(task?.noRun ? task.sourcePath : task?.workPath) ?? "—"}</code>
										</dd>
										{(task?.directoryMode ??
											(task?.connectionKind === "local" ? "single" : "dual")) === "dual" &&
											!(task?.noRun && task.sourcePath && task.sourcePath === task.archivePath) && (
												<>
													<dt>归档位置</dt>
													<dd>
														<code>{task?.archivePath ?? "—"}</code>
													</dd>
												</>
											)}
									</dl>
									<TaskScientificStates rows={view?.scientificStates} />
								</details>
							</InputSettingsCard>
						</InputSettingsLayout>
					</aside>
					<WorkspaceColumnDivider
						side="left"
						gridRow={1}
						sizes={columns.sizes}
						onChange={columns.update}
					/>
					<TaskMonitorResults
						columns={columns}
						title={task?.displayName ?? "任务监控"}
						onClose={p.onBack}
						continuity={continuity}
						loadingHost={preparationHost}
						onFrame={captureFrame}
						results={results}
						taskKind={task?.taskKind ?? ""}
						collectionFixed={taskMonitorCollectionFixed(task,publication?.view)}
						onExtract={p.onExtract}
						onError={errors.automatic("result-view")}
					/>
					{plan && (
						<OperationDialog
							bridge={bridge}
							plan={plan}
							onClose={() => setPlan(null)}
							onChanged={() => {
								void read(false);
								void p.onChanged?.();
							}}
							onStarted={(id) => {
								setPlan(null);
								p.onOperationStarted?.(id);
							}}
						/>
					)}
					{previews.windows}
				</WorkspaceColumns>
			</ProjectNativeDetailsBoundary>
		</ProjectUiScope>
	);
}
