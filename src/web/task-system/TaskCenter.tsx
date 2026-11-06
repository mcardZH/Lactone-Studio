import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Folder, MoreHorizontal, Plus } from "lucide-react";
import type { Structure } from "../../core/types";
import type {
	TaskCenterView,
	TaskBatchAction,
	TaskOperationPlan,
	TaskSystemBridge
} from "../../task-system/application-contracts";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope, type TaskErrorDismissalState } from "./task-error-scope";
import TaskMonitor from "./TaskMonitor";
import TaskCardThumbnail from "./TaskCardThumbnail";
import TaskDirectories from "./TaskDirectories";
import DialogShell from "../DialogShell";
import {useTransientLayer} from "../TransientLayer";
import TaskLibrarySettings, { TaskLibraryEntry } from "./TaskLibrarySettings";
import EnvironmentSettings from "./EnvironmentSettings";
import OperationDialog, { actionLabels } from "./OperationDialog";
import TaskOperationProgress from "./TaskOperationProgress";
import {
	defaultFilters,
	filterTasks,
	descendantGroups,
	taskStatus,
	taskStopPresentation,
	taskStatusTone,
	timeLabel,
	type TaskFilters,
	elapsedLabel,
	taskKindLabel
} from "./presentation";
import { useTaskTextPreviewWindows, type OpenTaskPreview } from "./TaskTextPreviewWindows";
import "./task-system.css";
import { TaskMonitorWorkspaceCache } from "./monitor-workspace-cache";
export interface TaskCenterProps {
	onLibraryChanged?(): void;
	workspaceCache?: TaskMonitorWorkspaceCache;
	previewNotice?: { error: string; identity: string; taskId?: string };
	onDismissPreview?(): void;
	bridge: TaskSystemBridge;
	onClose(): void;
	initialTaskId?: string;
	onPreview?: OpenTaskPreview;
	onExtract?(structure: Structure): void;
	onResubmit?(taskId: string): void;
	operationIds?: readonly string[];
	onOperationStarted?(id: string): void;
	onOpenSnapshot?(
		taskId: string,
		snapshotId: string,
		leaseId: string,
		canNavigate?: () => boolean
	): void | Promise<void>;
}
const GROUP_MIME = "application/x-es-task-group",
	TASK_MIME = "application/x-es-task-ids";
interface CenterPresentation {
	filters: TaskFilters;
	checked: Set<string>;
	monitor: string;
	operation: string;
	ownOperations: string[];
	collapsed: Set<string>;
	page: number;
	libraryIdentity: string | null;
	galleryScroll: number;
	groupsScroll: number;
}
export function TaskRemoteReminders(p: {
	reminders?: TaskCenterView["remoteReminders"];
	canManage: boolean;
	onDismiss(id: string): void;
}) {
	if (!p.reminders?.length) return null;
	return (
		<section className="task-remote-reminders" aria-label="远端未处理提醒">
			<h4>远端未处理提醒</h4>
			<ul>
				{p.reminders.map((reminder) => (
					<li
						className="task-reminder-row"
						key={reminder.reminderId}
						data-reminder-id={reminder.reminderId}
					>
						<strong>{reminder.displayName}</strong>
						<span>{reminder.environmentName}</span>
						<small>{reminder.message}</small>
						{reminder.workPath && (
							<details>
								<summary>位置</summary>
								<code>{reminder.workPath}</code>
							</details>
						)}
						<button
							type="button"
							disabled={!p.canManage}
							onClick={() => p.onDismiss(reminder.reminderId)}
						>
							清除此提醒
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
export default function TaskCenter(p: TaskCenterProps) {
	const { bridge } = p;
	const [ownedCache] = useState(() => new TaskMonitorWorkspaceCache()),
		workspace = p.workspaceCache ?? ownedCache,
		cacheEpoch = useRef(0),
		libraryIdentity = useRef<string | null>(
			workspace.readPresentation<CenterPresentation>("center")?.libraryIdentity ?? null
		);
	const restored = useRef(workspace.readPresentation<CenterPresentation>("center")).current;
	useEffect(() => {
		const epoch = ++cacheEpoch.current;
		return () => {
			if (!p.workspaceCache)
				queueMicrotask(() => {
					if (cacheEpoch.current === epoch) ownedCache.clear();
				});
		};
	}, [ownedCache, p.workspaceCache]);
	const [view, setView] = useState<TaskCenterView | null>(null),
		[filters, setFilters] = useState(restored?.filters ?? defaultFilters),
		[checked, setChecked] = useState(restored?.checked ?? new Set<string>()),
		[monitor, setMonitor] = useState(p.initialTaskId ?? restored?.monitor ?? ""),
		[modal, setModal] = useState<"library" | "environment" | null>(null),
		[plan, setPlan] = useState<TaskOperationPlan | null>(null),
		[operation, setOperation] = useState(restored?.operation ?? ""),
		[ownOperations, setOwnOperations] = useState<string[]>(restored?.ownOperations ?? []),
		[groupName, setGroupName] = useState(""),
		[groupParent, setGroupParent] = useState(""),
		[batchGroup, setBatchGroup] = useState(""),
		[deleteGroup, setDeleteGroup] = useState<string | null>(null),
		[collapsed, setCollapsed] = useState(restored?.collapsed ?? new Set<string>()),
		[page, setPage] = useState(restored?.page ?? 0),
		[groupMenu, setGroupMenu] = useState<string | null>(null),
		[cardMenu, setCardMenu] = useState<string | null>(null),
		[addGroupTarget, setAddGroupTarget] = useState<string | null>(null),
		[addTaskIds, setAddTaskIds] = useState(new Set<string>()),
		[dropTarget, setDropTarget] = useState("");
	const groupTrigger=useRef<HTMLElement>(null),groupPopup=useRef<HTMLDivElement>(null),cardTrigger=useRef<HTMLElement>(null),cardPopup=useRef<HTMLDivElement>(null);
	const menuScope=String(view?.library.libraryId??'')+'|'+monitor+'|'+String(modal??'');
	const [groupMenuEpoch,raiseGroupMenu]=useState(0),[cardMenuEpoch,raiseCardMenu]=useState(0);
	const cardMenuTask=view?.tasks.find(task=>task.taskId===cardMenu),cardScope=menuScope+'|'+String(cardMenuTask?.runId??'')+'|'+String(cardMenuTask?.sourceSetId??'')+'|'+String(cardMenuTask?.sourceVersion??'');
	useTransientLayer({open:groupMenu!==null,triggerRef:groupTrigger,contentRef:groupPopup,onDismiss:()=>setGroupMenu(null),scopeKey:menuScope,layerKey:String(groupMenu)+'|'+groupMenuEpoch,peerGroup:'task-center-menu'});
	useTransientLayer({open:cardMenu!==null,triggerRef:cardTrigger,contentRef:cardPopup,onDismiss:()=>setCardMenu(null),scopeKey:cardScope,layerKey:String(cardMenu)+'|'+cardMenuEpoch,peerGroup:'task-center-menu'});
	const groupEditor = useRef<HTMLDetailsElement>(null);
	function showGroupEditor() {
		if (groupEditor.current) {
			groupEditor.current.open = true;
			groupEditor.current.querySelector("input")?.focus();
		}
	}
	const gallery = useRef<HTMLElement>(null),
		groupPane = useRef<HTMLElement>(null),
		scroll = useRef({ gallery: restored?.galleryScroll ?? 0, groups: restored?.groupsScroll ?? 0 });
	useLayoutEffect(() => {
		workspace.writePresentation<CenterPresentation>("center", {
			filters,
			checked,
			monitor,
			operation,
			ownOperations,
			collapsed,
			page,
			libraryIdentity: libraryIdentity.current,
			galleryScroll: scroll.current.gallery,
			groupsScroll: scroll.current.groups
		});
		return () => {
			const latest = workspace.readPresentation<CenterPresentation>("center");
			if (latest)
				workspace.writePresentation("center", {
					...latest,
					galleryScroll: scroll.current.gallery,
					groupsScroll: scroll.current.groups
				});
		};
	});
	useLayoutEffect(() => {
		if (!monitor && !operation) {
			if (gallery.current) gallery.current.scrollTop = scroll.current.gallery;
			if (groupPane.current) groupPane.current.scrollTop = scroll.current.groups;
		}
	}, [monitor, operation, Boolean(view)]);
	const entry = useRef(`center-${crypto.randomUUID()}`),
		alive = useRef(true),
		reading = useRef(false),
		dragging = useRef(false);
	const groupDrag = useRef<string | null>(null);
	const errorDismissals = useMemo(() => {
		const key = `center-errors:${view?.library.libraryId ?? "unassociated"}`;
		let saved = workspace.readPresentation<TaskErrorDismissalState>(key);
		if (!saved) {
			saved = { automaticCauses: new Set() };
			workspace.writePresentation(key, saved);
		}
		return saved;
	}, [workspace, view?.library.libraryId]);
	const errors = useTaskErrorScope(
			`center:${view?.library.libraryId ?? "unassociated"}:${view?.manager.epoch ?? "readonly"}`,
			errorDismissals
		),
		previews = useTaskTextPreviewWindows(bridge, errors.automatic("preview-window"));
	const canManage = view?.manager.access === "manager" && !view.library.migrating,
		groups = view?.groups ?? [];
	async function refresh() {
		if (!alive.current || reading.current) return;
		reading.current = true;
		try {
			const value = await bridge.request("center.read", {});
			if (alive.current) setView(value);
		} catch (error) {
			if (alive.current) errors.automatic("read")(error);
		} finally {
			reading.current = false;
		}
	}
	useEffect(() => {
		alive.current = true;
		const entryId = `center-${crypto.randomUUID()}`;
		entry.current = entryId;
		let entered = false,
			active = true;
		void bridge
			.request("center.enter", { entryId })
			.then((value) => {
				entered = true;
				if (active) setView(value);
				else void bridge.request("center.leave", { entryId }).catch(() => {});
			})
			.catch(errors.automatic("enter"));
		const timer = setInterval(() => void refresh(), 2000);
		return () => {
			active = false;
			alive.current = false;
			clearInterval(timer);
			if (entered) void bridge.request("center.leave", { entryId }).catch(() => {});
		};
	}, [bridge]);
	const filtered = useMemo(
		() => filterTasks(view?.tasks ?? [], filters, groups),
		[view?.tasks, filters, view?.groups]
	);
	useEffect(() => {
		if (p.initialTaskId) {
			setMonitor(p.initialTaskId);
			setOperation("");
		}
	}, [p.initialTaskId]);
	useEffect(() => {
		const id = view?.library.libraryId
			? JSON.stringify([view.library.libraryId, view.library.path])
			: null;
		if (libraryIdentity.current && id && libraryIdentity.current !== id) {
			workspace.clear();
			setMonitor("");
			setOperation("");
			setOwnOperations([]);
			setChecked(new Set());
			previews.closeAll();
			p.onLibraryChanged?.();
			errors.automatic("library-changed")("任务库已更换，已返回当前任务库列表。");
		}
		libraryIdentity.current = id;
		if (
			view?.library.libraryId &&
			view.manager.access !== "unavailable" &&
			monitor &&
			!view.tasks.some((task) => task.taskId === monitor)
		) {
			setMonitor("");
			errors.automatic("missing-target")("原任务已不在当前任务库中，已返回任务列表。");
		}
	}, [view?.library.libraryId, view?.library.path, view?.tasks, monitor, workspace]);
	const selectedInFilter = filtered.filter((task) => checked.has(task.taskId)),
		pages = Math.max(1, Math.ceil(filtered.length / 60)),
		currentPage = Math.min(page, pages - 1);
	const lastFilters = useRef(filters);
	useEffect(() => {
		if (lastFilters.current !== filters) {
			setPage(0);
			lastFilters.current = filters;
		}
		if (!view) return;
		const valid = new Set(filtered.map((task) => task.taskId));
		setChecked((prior) =>
			[...prior].every((id) => valid.has(id))
				? prior
				: new Set([...prior].filter((id) => valid.has(id)))
		);
	}, [filters, filtered, view]);
	async function mutate(action: () => Promise<unknown>) {
		try {
			await action();
			await refresh();
		} catch (error) {
			if (alive.current) errors.attempt("manage")(error);
		}
	}
	async function run(action: TaskBatchAction, ids: string[]) {
		if (!ids.length) return;
		try {
			setPlan(await bridge.request("operation.plan", { action, taskIds: ids }));
		} catch (error) {
			errors.attempt(`plan:${action}`)(error);
		}
	}
	function started(id: string) {
		setPlan(null);
		setMonitor("");
		setOperation(id);
		setOwnOperations((prior) => (prior.includes(id) ? prior : [...prior, id]));
		p.onOperationStarted?.(id);
	}
	function receiveDrop(
		event: DragEvent<HTMLElement>,
		parentGroupId: string | null,
		beforeGroupId?: string
	) {
		if (!canManage) return;
		event.preventDefault();
		event.stopPropagation();
		const groupId = event.dataTransfer.getData(GROUP_MIME),
			raw = event.dataTransfer.getData(TASK_MIME);
		setDropTarget("");
		if (groupId) {
			if (
				groupId === parentGroupId ||
				(parentGroupId && descendantGroups(groups, groupId).has(parentGroupId))
			)
				return;
			void mutate(() =>
				bridge.request("group.move", {
					groupId,
					parentGroupId,
					beforeGroupId: beforeGroupId ?? null
				})
			);
		} else if (raw && parentGroupId) {
			try {
				const ids = JSON.parse(raw);
				if (Array.isArray(ids) && ids.every((id) => typeof id === "string"))
					void mutate(() =>
						bridge.request("group.membership", {
							taskIds: ids,
							groupId: parentGroupId,
							mode: "add"
						})
					);
			} catch {}
		}
	}
	const over = (event: DragEvent<HTMLElement>, target = "") => {
		const parent = target.startsWith("into:")
			? target.slice(5)
			: target.startsWith("before:")
				? groups.find((group) => group.groupId === target.slice(7))?.parentGroupId
				: null;
		if (groupDrag.current && parent && descendantGroups(groups, groupDrag.current).has(parent)) {
			setDropTarget("");
			return;
		}
		if (
			canManage &&
			(event.dataTransfer.types.includes(GROUP_MIME) ||
				event.dataTransfer.types.includes(TASK_MIME))
		) {
			event.preventDefault();
			event.stopPropagation();
			setDropTarget(target);
		}
	};
	function groupRows(parent: string | null, depth = 0, seen = new Set<string>()): React.ReactNode {
		return groups
			.filter((group) => group.parentGroupId === parent)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
			.map((group) => {
				if (seen.has(group.groupId)) return null;
				const count = filterTasks(
						view?.tasks ?? [],
						{
							...filters,
							category: filters.category === "ungrouped" ? "all" : filters.category,
							groupId: group.groupId
						},
						groups
					).length,
					hasChildren = groups.some((row) => row.parentGroupId === group.groupId);
				return (
					<div
						key={group.groupId}
						className="task-group-node"
						style={{ paddingLeft: depth ? 12 : 0 }}
					>
						<div
							className="task-group-insertion"
							data-drop-active={dropTarget === `before:${group.groupId}`}
							aria-label={`移动到${group.displayName}之前`}
							onDragOver={(event) => over(event, `before:${group.groupId}`)}
							onDrop={(event) => receiveDrop(event, parent, group.groupId)}
						/>
						<div
							className="task-group-row"
							onContextMenu={(event) => {
								event.preventDefault();
								groupTrigger.current=event.currentTarget;raiseGroupMenu(epoch=>epoch+1);
								setGroupMenu(group.groupId);
							}}
						>
							<button
								className="task-group-toggle"
								aria-label={`${collapsed.has(group.groupId) ? "展开" : "折叠"} ${group.displayName}`}
								disabled={!hasChildren}
								onClick={() =>
									setCollapsed((prior) => {
										const next = new Set(prior);
										next.has(group.groupId) ? next.delete(group.groupId) : next.add(group.groupId);
										return next;
									})
								}
							>
								{hasChildren ? (collapsed.has(group.groupId) ? "▸" : "▾") : ""}
							</button>
							<button
								draggable={Boolean(canManage)}
								onDragStart={(event) => {
									groupDrag.current = group.groupId;
									event.stopPropagation();
									event.dataTransfer.setData(GROUP_MIME, group.groupId);
									event.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={() => {
									groupDrag.current = null;
									setDropTarget("");
								}}
								onDragOver={(event) => over(event, `into:${group.groupId}`)}
								data-drop-active={dropTarget === `into:${group.groupId}`}
								title={`加入“${group.displayName}”直接成员；拖入分组成为子分组`}
								onDrop={(event) => receiveDrop(event, group.groupId)}
								aria-pressed={filters.groupId === group.groupId}
								onClick={() =>
									setFilters((prior) => ({ ...prior, category: "all", groupId: group.groupId }))
								}
							>
								<Folder className="task-group-folder" size={17} aria-hidden="true" />
								<span>{group.displayName}</span>
								<small>{count}</small>
							</button>
						</div>
						{groupMenu === group.groupId && (
							<div
								ref={groupPopup}
								className="task-context-menu"
								role="menu"
								aria-label={`${group.displayName} 分组菜单`}
							>
								<button
									role="menuitem"
									disabled={!canManage}
									onClick={() => {
										setGroupParent(group.groupId);
										setGroupMenu(null);
										setGroupName("");
										showGroupEditor();
									}}
								>
									新建子分组
								</button>
								<button
									role="menuitem"
									disabled={!canManage}
									onClick={() => {
										setAddGroupTarget(group.groupId);
										setAddTaskIds(new Set(selectedInFilter.map((task) => task.taskId)));
										setGroupMenu(null);
									}}
								>
									加入已有任务
								</button>
								<button
									role="menuitem"
									disabled={!canManage}
									onClick={() => {
										setGroupName(group.displayName);
										setFilters((prior) => ({ ...prior, groupId: group.groupId, category: "all" }));
										setGroupMenu(null);
										showGroupEditor();
									}}
								>
									重命名
								</button>
								<label>
									移动到
									<select
										aria-label={`移动分组 ${group.displayName}`}
										value=""
										disabled={!canManage}
										onChange={(event) => {
											void mutate(() =>
												bridge.request("group.move", {
													groupId: group.groupId,
													parentGroupId:
														event.target.value === "__root" ? null : event.target.value,
													beforeGroupId: null
												})
											);
											setGroupMenu(null);
										}}
									>
										<option value="" disabled>
											选择目标
										</option>
										<option value="__root">顶层</option>
										{groups
											.filter((row) => !descendantGroups(groups, group.groupId).has(row.groupId))
											.map((row) => (
												<option key={row.groupId} value={row.groupId}>
													{row.displayName}
												</option>
											))}
									</select>
								</label>
								<button
									role="menuitem"
									disabled={!canManage}
									onClick={() => {
										setDeleteGroup(group.groupId);
										setGroupMenu(null);
									}}
								>
									删除分组
								</button>
								<button onClick={() => setGroupMenu(null)}>关闭菜单</button>
							</div>
						)}
						{!collapsed.has(group.groupId) &&
							groupRows(group.groupId, depth + 1, new Set([...seen, group.groupId]))}
					</div>
				);
			});
	}
	const history = [
		...new Set([
			...(view?.operations ?? []).map((row) => row.operationId),
			...(p.operationIds ?? []),
			...ownOperations
		])
	];
	return (
		<section className="task-center" aria-label="任务中心" data-testid="task-center">
			{!monitor && (
				<header className="task-center-header">
					<h2>任务中心</h2>
					<div className="task-actions">
						<button onClick={() => setModal("environment")}>执行环境</button>
						<button onClick={() => setModal("library")}>任务库设置</button>
						<button onClick={p.onClose}>退出任务中心</button>
					</div>
				</header>
			)}
			{!monitor && errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={bridge} onDismiss={errors.dismiss} />
			)}
			{!monitor && p.previewNotice && (
				<TaskErrorNotice {...p.previewNotice} bridge={bridge} onDismiss={p.onDismissPreview} />
			)}
			{!view ? (
				<p role="status">正在打开任务库…</p>
			) : !view.library.libraryId || view.manager.access === "unavailable" ? (
				<TaskLibraryEntry bridge={bridge} library={view.library} onChanged={refresh} />
			) : monitor ? (
				<TaskMonitor
					workspaceCache={workspace}
					previewNotice={p.previewNotice}
					onDismissPreview={p.onDismissPreview}
					key={monitor}
					bridge={bridge}
					taskId={monitor}
					initialTask={view.tasks.find((task) => task.taskId === monitor)}
					manager={view.manager}
					settings={view.monitoring}
					onBack={() => {
						setMonitor("");
						void refresh();
					}}
					onChanged={refresh}
					onOpenSnapshot={p.onOpenSnapshot}
					onPreview={p.onPreview ?? previews.open}
					onExtract={p.onExtract}
					onResubmit={p.onResubmit}
					onOperationStarted={started}
				/>
			) : operation ? (
				<TaskOperationProgress
					key={operation}
					onOperationStarted={(id) => {
						setOwnOperations((prior) => (prior.includes(id) ? prior : [...prior, id]));
						p.onOperationStarted?.(id);
					}}
					bridge={bridge}
					operationId={operation}
					onClearWork={(taskIds) => run("cleanup", taskIds)}
					onBack={() => setOperation("")}
					onChanged={() => void refresh()}
				/>
			) : (
				<>
					{view.manager.access !== "manager" && (
						<div className="task-access" role="status">
							只读 · {view.manager.ownerLabel ?? view.manager.reason ?? "尚未取得管理权"}
							<button
								onClick={() =>
									void mutate(() => bridge.request("manager.acquire", { entryId: entry.current }))
								}
							>
								取得管理权
							</button>
						</div>
					)}
					<div className="task-center-body">
						<nav
							ref={groupPane}
							className="task-groups"
							aria-label="分组管理"
							onScroll={(event) => {
								scroll.current.groups = event.currentTarget.scrollTop;
							}}
						>
							<div className="task-group-heading">
								<strong>分组管理</strong>
								<button
									aria-label="新建分组"
									onClick={() => {
										setGroupName("");
										setGroupParent("");
										showGroupEditor();
									}}
								>
									<Plus size={16} />
								</button>
								<button
									aria-label="分组管理菜单"
									onClick={event => {groupTrigger.current=event.currentTarget;raiseGroupMenu(epoch=>epoch+1);setGroupMenu(groupMenu ? null : "root");}}
								>
									<MoreHorizontal size={16} />
								</button>
							</div>
							<div
								className="task-group-root-drop"
								data-drop-active={dropTarget === "root"}
								onDragOver={(event) => over(event, "root")}
								onDrop={(event) => receiveDrop(event, null)}
							>
								拖到此处设为顶层
							</div>
							{groupMenu === "root" && (
								<div ref={groupPopup} className="task-context-menu" role="menu">
									<button
										disabled={!canManage}
										onClick={() => {
											setGroupName("");
											setGroupParent("");
											setGroupMenu(null);
											showGroupEditor();
										}}
									>
										新建分组
									</button>
									<button
										onClick={() => {
											setCollapsed(new Set(groups.map((row) => row.groupId)));
											setGroupMenu(null);
										}}
									>
										收起全部
									</button>
									<button
										onClick={() => {
											setCollapsed(new Set());
											setGroupMenu(null);
										}}
									>
										展开全部
									</button>
								</div>
							)}
							{groupRows(null)}
							<details ref={groupEditor}>
								<summary>管理分组</summary>
								<label>
									名称
									<input value={groupName} onChange={(event) => setGroupName(event.target.value)} />
								</label>
								<label>
									父组
									<select
										value={groupParent}
										onChange={(event) => setGroupParent(event.target.value)}
									>
										<option value="">顶层</option>
										{groups.map((group) => (
											<option key={group.groupId} value={group.groupId}>
												{group.displayName}
											</option>
										))}
									</select>
								</label>
								<button
									disabled={!canManage || !groupName.trim()}
									onClick={() =>
										void mutate(async () => {
											await bridge.request("group.save", {
												displayName: groupName.trim(),
												parentGroupId: groupParent || null
											});
											setGroupName("");
										})
									}
								>
									新建分组
								</button>
								{filters.groupId && (
									<>
										<button
											disabled={!canManage || !groupName.trim()}
											onClick={() =>
												void mutate(() =>
													bridge.request("group.save", {
														groupId: filters.groupId!,
														displayName: groupName.trim(),
														parentGroupId:
															groups.find((group) => group.groupId === filters.groupId)
																?.parentGroupId ?? null
													})
												)
											}
										>
											重命名当前组
										</button>
										<button disabled={!canManage} onClick={() => setDeleteGroup(filters.groupId)}>
											删除分组
										</button>
									</>
								)}
							</details>
							{deleteGroup && (
								<div className="task-confirm">
									<p>
										删除分组“{groups.find((group) => group.groupId === deleteGroup)?.displayName}”？
									</p>
									<p>
										将删除此分组及其 {descendantGroups(groups, deleteGroup).size - 1} 个子分组。
									</p>
									<p>任务和计算文件保留，其他分组归属不变。没有剩余分组的任务将进入“未分组”。</p>
									<button onClick={() => setDeleteGroup(null)}>取消</button>
									<button
										onClick={() =>
											void mutate(async () => {
												await bridge.request("group.delete", { groupId: deleteGroup });
												setDeleteGroup(null);
												setFilters((prior) => ({ ...prior, groupId: null }));
											})
										}
									>
										删除分组
									</button>
								</div>
							)}
							{history.length > 0 && (
								<details>
									<summary>操作记录</summary>
									{history.map((id, index) => (
										<button key={id} onClick={() => setOperation(id)}>
											{view.operations?.find((row) => row.operationId === id)
												? (actionLabels[
														view.operations.find((row) => row.operationId === id)!
															.type as TaskBatchAction
													] ?? "后台操作")
												: `操作 ${index + 1}`}
										</button>
									))}
								</details>
							)}
							<TaskRemoteReminders
								reminders={view.remoteReminders}
								canManage={Boolean(canManage)}
								onDismiss={(reminderId) =>
									void mutate(() => bridge.request("reminder.dismiss", { reminderId }))
								}
							/>
						</nav>
						<section
							ref={gallery}
							className="task-gallery"
							aria-label="任务卡片"
							onScroll={(event) => {
								scroll.current.gallery = event.currentTarget.scrollTop;
							}}
						>
							<div className="task-filters">
								<label>
									查看范围
									<select
										aria-label="查看范围"
										value={
											filters.groupId
												? "group"
												: filters.category === "ungrouped"
													? "ungrouped"
													: "all"
										}
										onChange={(event) =>
											setFilters((prior) => ({
												...prior,
												category: event.target.value as "all" | "ungrouped",
												groupId: null
											}))
										}
									>
										<option value="all">全部任务</option>
										<option value="ungrouped">未分组</option>
										{filters.groupId && (
											<option value="group">
												{groups.find((row) => row.groupId === filters.groupId)?.displayName ??
													"当前分组"}
											</option>
										)}
									</select>
								</label>
								<label>
									搜索
									<input
										type="search"
										placeholder="任务名、化学式、编号"
										value={filters.query}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, query: event.target.value }))
										}
									/>
								</label>
								<label>
									提交/登记日期
									<input
										type="date"
										value={filters.fromDate}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, fromDate: event.target.value }))
										}
									/>
								</label>
								<label>
									至
									<input
										type="date"
										value={filters.toDate}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, toDate: event.target.value }))
										}
									/>
								</label>
								<label>
									环境
									<select
										value={filters.environmentId}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, environmentId: event.target.value }))
										}
									>
										<option value="">全部</option>
										{[
											...new Map(
												view.tasks.map((task) => [
													task.environmentId,
													{ environmentId: task.environmentId, displayName: task.environmentName }
												])
											).values()
										].map((env) => (
											<option key={env.environmentId} value={env.environmentId}>
												{env.displayName || "未识别环境"}
											</option>
										))}
									</select>
								</label>
								<label>
									软件
									<select
										value={filters.engineId}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, engineId: event.target.value }))
										}
									>
										<option value="">全部</option>
										{[...new Set(view.tasks.map((task) => task.engineId))].map((engine) => (
											<option key={engine} value={engine}>
												{engine || "未识别来源"}
											</option>
										))}
									</select>
								</label>
								<label>
									状态
									<select
										value={filters.state}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, state: event.target.value }))
										}
									>
										<option value="">全部</option>
										{Object.entries({
											preparing: "准备中",
											submitting: "提交中",
											queued: "排队中",
											running: "运行中",
											"stop-requested": "停止中",
											completed: "已完成",
											stopped: "已停止",
											"submission-failed": "提交失败",
											failed: "运行失败",
											unknown: "待核实",
											external: "外部结果"
										}).map(([state, label]) => (
											<option key={state} value={state}>
												{label}
											</option>
										))}
									</select>
								</label>
								<label>
									归档
									<select
										aria-label="归档筛选"
										value={filters.archive}
										onChange={(event) =>
											setFilters((prior) => ({ ...prior, archive: event.target.value }))
										}
									>
										<option value="">全部</option>
										<option value="unarchived">未归档</option>
										<option value="archiving">归档中</option>
										<option value="archived">已归档</option>
										<option value="cleared">已清空</option>
										<option value="failed">归档异常</option>
									</select>
								</label>
								<label>
									回收区
									<select
										aria-label="回收区筛选"
										value={filters.recycle}
										onChange={(event) =>
											setFilters((prior) => ({
												...prior,
												recycle: event.target.value as TaskFilters["recycle"]
											}))
										}
									>
										<option value="exclude">不含回收区</option>
										<option value="only">仅回收区</option>
										<option value="all">全部含回收区</option>
									</select>
								</label>
								<button
									onClick={() =>
										setFilters({
											...defaultFilters,
											category: filters.category === "ungrouped" ? "ungrouped" : "all",
											groupId: filters.groupId
										})
									}
								>
									清除筛选
								</button>
							</div>
							<div className="task-selection">
								<label>
									<input
										type="checkbox"
										checked={filtered.length > 0 && selectedInFilter.length === filtered.length}
										onChange={(event) =>
											setChecked((prior) => {
												const next = new Set(prior);
												for (const task of filtered)
													event.target.checked ? next.add(task.taskId) : next.delete(task.taskId);
												return next;
											})
										}
									/>
									全选当前筛选结果（{filtered.length}）
								</label>
								<span>已选 {checked.size}</span>
								<button onClick={() => setChecked(new Set())}>清空选择</button>
							</div>
							<div className="task-batch-actions">
								<select
									aria-label="批量分组目标"
									value={batchGroup}
									onChange={(event) => setBatchGroup(event.target.value)}
								>
									<option value="">选择分组</option>
									{groups.map((group) => (
										<option key={group.groupId} value={group.groupId}>
											{group.displayName}
										</option>
									))}
								</select>
								<button
									disabled={!canManage || !checked.size || !batchGroup}
									onClick={() =>
										void mutate(() =>
											bridge.request("group.membership", {
												taskIds: selectedInFilter.map((task) => task.taskId),
												groupId: batchGroup,
												mode: "add"
											})
										)
									}
								>
									加入分组
								</button>
								{filters.groupId && (
									<button
										disabled={!canManage || !checked.size}
										onClick={() =>
											void mutate(() =>
												bridge.request("group.membership", {
													taskIds: selectedInFilter.map((task) => task.taskId),
													groupId: filters.groupId!,
													mode: "remove"
												})
											)
										}
									>
										从当前组移除
									</button>
								)}
								{(Object.keys(actionLabels) as TaskBatchAction[])
									.filter(
										(action) =>
											!["archive", "cleanup-archive"].includes(action) ||
											(selectedInFilter.length ? selectedInFilter : filtered).some(
												(task) =>
													(task.directoryMode ??
														(task.connectionKind === "local" ? "single" : "dual")) === "dual"
											)
									)
									.filter(
										(action) =>
											action !== "group" &&
											(filters.recycle === "only"
												? ["restore", "delete-task"].includes(action)
												: action !== "restore")
									)
									.map((action) => (
										<button
											key={action}
											disabled={
												!checked.size ||
												!canManage ||
												(action === "stop" &&
													![...checked].some(
														(id) =>
															taskStopPresentation(
																view.tasks.find((task) => task.taskId === id),
																true
															).canRequest
													))
											}
											onClick={() =>
												void run(
													action,
													selectedInFilter.map((task) => task.taskId)
												)
											}
										>
											{actionLabels[action]}
										</button>
									))}
							</div>
							<div className="task-card-grid">
								{filtered.slice(currentPage * 60, (currentPage + 1) * 60).map((task) => (
									<article
										className="task-card"
										key={task.taskId}
										data-task-id={task.taskId}
										tabIndex={0}
										role="button"
										onContextMenu={(event) => {
											event.preventDefault();
											cardTrigger.current=event.currentTarget;raiseCardMenu(epoch=>epoch+1);
											setCardMenu(task.taskId);
										}}
										aria-label={`打开 ${task.displayName}`}
										draggable={Boolean(canManage)}
										onDragStart={(event) => {
											dragging.current = true;
											event.dataTransfer.setData(
												TASK_MIME,
												JSON.stringify(
													checked.has(task.taskId)
														? selectedInFilter.map((row) => row.taskId)
														: [task.taskId]
												)
											);
											event.dataTransfer.effectAllowed = "copy";
										}}
										onDragEnd={() => {
											setDropTarget("");
											setTimeout(() => {
												dragging.current = false;
											}, 0);
										}}
										onClick={() => {
											if (!dragging.current) setMonitor(task.taskId);
										}}
										onKeyDown={(event) => {
											if (event.target !== event.currentTarget) return;
											if (event.key === "Enter") {
												event.preventDefault();
												setMonitor(task.taskId);
											}
										}}
									>
										<label className="task-card-check" onClick={(event) => event.stopPropagation()}>
											<input
												type="checkbox"
												aria-label={`选择 ${task.displayName}`}
												checked={checked.has(task.taskId)}
												onChange={(event) =>
													setChecked((prior) => {
														const next = new Set(prior);
														event.target.checked ? next.add(task.taskId) : next.delete(task.taskId);
														return next;
													})
												}
											/>
										</label>
										<TaskCardThumbnail task={task} />
										<div className="task-card-content">
											<h3 className="task-card-title" title={task.displayName}>
												{task.displayName}
											</h3>
											<p className="task-card-formula">
												{task.formula ?? task.thumbnail?.formula ?? "—"}
											</p>
											<p className="task-card-environment">{task.environmentName || "—"}</p>
											<p>
												{task.engineId === "gaussian" ? "Gaussian" : task.engineId.toUpperCase()} ·{" "}
												{taskKindLabel(task.taskKind)}
											</p>
											<p className="task-state" data-status-tone={taskStatusTone(task)}>
												{taskStatus(task)}
											</p>
											{task.recycled && <span className="task-state">回收区</span>}
											{task.resultLimited && (
												<span
													className="task-state"
													data-status-tone="unknown"
													title={task.resultLimitReason ?? undefined}
												>
													结果受限
												</span>
											)}
											{!task.noRun && (
												<p>
													{task.executionState === "ended" ? "运行用时" : "已运行"}{" "}
													{elapsedLabel(task.elapsedSeconds)}
												</p>
											)}
											<p>
												{task.noRun ? "登记" : "提交"}{" "}
												{timeLabel(task.lastSubmittedAt ?? task.createdAt)}
											</p>
										</div>
										<TaskDirectories
											task={task}
											bridge={bridge}
											canManage={Boolean(canManage)}
											onAction={(action) => void run(action, [task.taskId])}
											onError={(error) => errors.attempt(`directory:${task.taskId}`)(error)}
										/>
										<div
											className="task-card-footer"
											onClick={(event) => event.stopPropagation()}
											onKeyDown={(event) => event.stopPropagation()}
										>
											{task.executionState === "ended" && !task.noRun && (
												<button
													disabled={
														!canManage || Boolean(task.stopControl?.targets.length) || !p.onResubmit
													}
													onClick={() => p.onResubmit?.(task.taskId)}
												>
													重新提交
												</button>
											)}
											<button
												aria-label={`${task.displayName} 更多操作`}
												onClick={event => {cardTrigger.current=event.currentTarget;raiseCardMenu(epoch=>epoch+1);setCardMenu(cardMenu === task.taskId ? null : task.taskId);}}
											>
												<MoreHorizontal size={17} />
											</button>
											{cardMenu === task.taskId && (
												<div
													ref={cardPopup}
													role="menu"
													className="task-context-menu"
													aria-label={`${task.displayName} 操作菜单`}
												>
													{filters.groupId && (
														<button
															disabled={!canManage}
															onClick={() => {
																void mutate(() =>
																	bridge.request("group.membership", {
																		taskIds: [task.taskId],
																		groupId: filters.groupId!,
																		mode: "remove"
																	})
																);
																setCardMenu(null);
															}}
														>
															从当前分组移除
														</button>
													)}
													<label>
														加入分组
														<select
															value=""
															disabled={!canManage}
															onChange={(event) => {
																void mutate(() =>
																	bridge.request("group.membership", {
																		taskIds: [task.taskId],
																		groupId: event.target.value,
																		mode: "add"
																	})
																);
																setCardMenu(null);
															}}
														>
															<option value="">选择分组</option>
															{groups.map((group) => (
																<option key={group.groupId} value={group.groupId}>
																	{group.displayName}
																</option>
															))}
														</select>
													</label>
													<button
														disabled={!canManage}
														onClick={() => {
															void run(task.recycled ? "restore" : "recycle", [task.taskId]);
															setCardMenu(null);
														}}
													>
														{task.recycled ? "恢复任务" : "移入回收区"}
													</button>
													{task.recycled && (
														<button
															disabled={!canManage}
															onClick={() => {
																void run("delete-task", [task.taskId]);
																setCardMenu(null);
															}}
														>
															彻底移除
														</button>
													)}
													<button onClick={() => setCardMenu(null)}>关闭菜单</button>
												</div>
											)}
										</div>
									</article>
								))}
							</div>
							{!filtered.length && (
								<p className="task-empty">
									{filters.groupId ? "本组暂无直接任务" : "当前条件下暂无任务"}
								</p>
							)}
							<div className="task-pagination">
								<button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
									上一页
								</button>
								<span>
									{currentPage + 1} / {pages}
								</span>
								<button
									disabled={currentPage + 1 >= pages}
									onClick={() => setPage(currentPage + 1)}
								>
									下一页
								</button>
							</div>
						</section>
					</div>
				</>
			)}
			{plan && (
				<OperationDialog
					bridge={bridge}
					plan={plan}
					onClose={() => setPlan(null)}
					onChanged={() => void refresh()}
					onStarted={started}
				/>
			)}
			{addGroupTarget && (
				<DialogShell
					className="task-dialog"
					aria-label="加入已有任务"
					onCancel={() => setAddGroupTarget(null)}
				>
					<header>
						<h3>
							加入已有任务 · {groups.find((group) => group.groupId === addGroupTarget)?.displayName}
						</h3>
						<button onClick={() => setAddGroupTarget(null)}>×</button>
					</header>
					<div className="task-existing-members">
						{(view?.tasks ?? [])
							.filter((task) => !task.recycled)
							.map((task) => (
								<label key={task.taskId}>
									<input
										type="checkbox"
										checked={addTaskIds.has(task.taskId)}
										onChange={(event) =>
											setAddTaskIds((prior) => {
												const next = new Set(prior);
												event.target.checked ? next.add(task.taskId) : next.delete(task.taskId);
												return next;
											})
										}
									/>
									{task.displayName}
								</label>
							))}
					</div>
					<footer>
						<button onClick={() => setAddGroupTarget(null)}>取消</button>
						<button
							disabled={!canManage || !addTaskIds.size}
							onClick={() =>
								void mutate(async () => {
									await bridge.request("group.membership", {
										taskIds: [...addTaskIds],
										groupId: addGroupTarget,
										mode: "add"
									});
									setAddGroupTarget(null);
								})
							}
						>
							加入分组
						</button>
					</footer>
				</DialogShell>
			)}
			{modal === "library" && (
				<TaskLibrarySettings
					bridge={bridge}
					library={
						view?.library ?? {
							libraryId: null,
							path: null,
							migrating: false,
							recycledCount: 0,
							recycledBytes: null
						}
					}
					canManage={Boolean(canManage)}
					onChanged={refresh}
					onOpenRecycle={() => {
						setModal(null);
						setMonitor("");
						setOperation("");
						setFilters({ ...defaultFilters, recycle: "only" });
					}}
					onOperationStarted={(id) => {
						setModal(null);
						started(id);
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{modal === "environment" && view && (
				<EnvironmentSettings
					bridge={bridge}
					environments={view.environments}
					canManage={Boolean(canManage)}
					onChanged={refresh}
					onClose={() => setModal(null)}
				/>
			)}
			{previews.windows}
		</section>
	);
}
