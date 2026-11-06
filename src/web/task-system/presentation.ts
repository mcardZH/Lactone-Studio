import type {
	TaskCardView,
	TaskCategory,
	TaskGroupView
} from "../../task-system/application-contracts";
export const categoryLabels: Record<TaskCategory, string> = {
	all: "全部",
	active: "运行／排队",
	unverified: "待核实",
	completed: "已完成·待处理",
	failed: "失败／中断",
	archived: "已归档",
	recycle: "回收区",
	ungrouped: "未分组"
};
export const executionLabels: Record<string, string> = {
	preparing: "准备中",
	submitting: "提交中",
	queued: "排队中",
	running: "运行中",
	"stop-requested": "停止中",
	ended: "已结束",
	unknown: "待核实"
};
export const verificationLabels: Record<string, string> = {
	verified: "已核实",
	stale: "待更新",
	unreachable: "暂不可达",
	conflict: "信息冲突",
	unknown: "待核实"
};
export function taskStatus(task: TaskCardView): string {
	if (task.noRun) return "外部结果";
	if (task.failureKind === "verification") return "待核实";
	if (task.endReason === "failed" && task.failureKind === "submission") return "提交失败";
	return task.verificationState === "conflict"
		? "信息冲突"
		: task.endReason === "failed"
			? "运行失败"
			: task.endReason === "interrupted"
				? "中断"
				: task.endReason === "stopped"
					? "已停止"
					: task.executionState === "ended" && task.endReason === "completed"
						? "已完成"
						: (executionLabels[task.executionState] ?? task.executionState);
}
export function taskStatusTone(
	task: TaskCardView
): "running" | "success" | "failed" | "stopped" | "unknown" | "neutral" {
	if (task.noRun) return "neutral";
	if (task.failureKind === "verification") return "unknown";
	if (task.executionState === "ended") {
		if (task.endReason === "stopped") return "stopped";
		if (task.endReason === "failed" || task.endReason === "interrupted") return "failed";
		if (task.endReason === "completed") return "success";
	}
	if (["preparing", "submitting", "queued"].includes(task.executionState)) return "neutral";
	return ["running", "stop-requested"].includes(task.executionState) ? "running" : "unknown";
}
export function taskGroupIds(task: Pick<TaskCardView, "groupIds" | "groupId">): string[] {
	return task.groupIds ?? (task.groupId ? [task.groupId] : []);
}
export function timeLabel(raw: string | null): string {
	if (!raw) return "—";
	const value = new Date(raw);
	return Number.isNaN(value.getTime()) ? raw : value.toLocaleString("zh-CN", { hour12: false });
}
/** Native exit and related owners stay separate; only the host can expose preparation activity. */
export function taskStopPresentation(
	task: Pick<TaskCardView, "executionState" | "stopControl"> | null | undefined,
	canManage: boolean
) {
	const control = task?.stopControl,
		pending = control ? control.pending : task?.executionState === "stop-requested";
	const available = Boolean(
		task && (control ? control.canRequest : task.executionState !== "ended") && !pending
	);
	return {
		canRequest: canManage && available,
		pending: Boolean(pending),
		label: pending ? "停止中" : "停止任务",
		reason: !canManage ? "只读状态不能停止任务" : control?.reason
	};
}
export function bytesLabel(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "未知";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let n = bytes / 1024,
		i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(3).replace(/\.?0+$/, "")} ${units[i]}`;
}
export interface TaskFilters {
	category: TaskCategory;
	query: string;
	fromDate: string;
	toDate: string;
	environmentId: string;
	engineId: string;
	state: string;
	archive: string;
	recycle: "exclude" | "only" | "all";
	groupId: string | null;
}
export const defaultFilters: TaskFilters = {
	category: "all",
	query: "",
	fromDate: "",
	toDate: "",
	environmentId: "",
	engineId: "",
	state: "",
	archive: "",
	recycle: "exclude",
	groupId: null
};
export function localSubmissionDay(raw: string): string {
	const date = new Date(raw);
	return Number.isNaN(date.getTime())
		? raw.slice(0, 10)
		: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function selectedInFilter(
	selected: ReadonlySet<string>,
	filtered: readonly TaskCardView[]
): Set<string> {
	const ids = new Set(filtered.map((task) => task.taskId));
	return new Set([...selected].filter((id) => ids.has(id)));
}
export function descendantGroups(groups: TaskGroupView[], root: string): Set<string> {
	const result = new Set([root]);
	for (let pass = 0; pass < groups.length; pass++) {
		const prior = result.size;
		for (const group of groups)
			if (group.parentGroupId && result.has(group.parentGroupId)) result.add(group.groupId);
		if (prior === result.size) break;
	}
	return result;
}
export function matchesTaskState(task: TaskCardView, state: string): boolean {
	if (state === "external") return Boolean(task.noRun);
	if (task.noRun) return false;
	if (state === "unknown" && task.failureKind === "verification") return true;
	if (state === "submission-failed")
		return task.endReason === "failed" && task.failureKind === "submission";
	if (state === "failed") return task.endReason === "failed" && task.failureKind !== "submission";
	if (["completed", "stopped", "failed", "interrupted"].includes(state))
		return task.endReason === state;
	return task.executionState === state;
}
/** Older payloads expose only a proven archive boolean; absence is never cleared. */
export function taskArchiveState(task: TaskCardView): string {
	return task.archiveState ?? (task.archived ? "archived" : "unarchived");
}
export function elapsedLabel(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
	const value = Math.floor(seconds);
	return [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}
export function taskKindLabel(kind: string): string {
	return (
		(
			{
				opt: "结构优化",
				optimization: "结构优化",
				freq: "频率分析",
				frequency: "频率分析",
				sp: "单点能",
				singlepoint: "单点能",
				"opt-freq": "优化与频率",
				optfreq: "优化与频率",
				opt_freq: "优化与频率",
				scan: "扫描",
				irc: "IRC",
				neb: "NEB",
				md: "分子动力学",
				ts: "过渡态优化",
				td: "激发态",
				tdopt: "激发态优化",
				nmr: "NMR",
				stable: "波函数稳定性",
				bsse: "BSSE",
				esd: "ESD",
				"external-input": "外部计算"
			} as Record<string, string>
		)[kind.toLowerCase()] ?? kind
	);
}
export function filterTasks(
	tasks: TaskCardView[],
	filters: TaskFilters,
	groups: TaskGroupView[] = []
): TaskCardView[] {
	void groups;
	return tasks
		.filter((task) => {
			const recycle = filters.category === "recycle" ? "only" : (filters.recycle ?? "exclude");
			if (recycle === "only" ? !task.recycled : recycle === "exclude" && task.recycled)
				return false;
			if (
				filters.category === "active" &&
				!["preparing", "submitting", "queued", "running", "stop-requested"].includes(
					task.executionState
				)
			)
				return false;
			if (filters.category === "unverified" && task.verificationState === "verified") return false;
			if (
				filters.category === "completed" &&
				(task.executionState !== "ended" || task.archived || task.endReason !== "completed")
			)
				return false;
			if (
				filters.category === "failed" &&
				!["failed", "interrupted", "stopped"].includes(task.endReason ?? "")
			)
				return false;
			if (filters.category === "archived" && !task.archived) return false;
			if (filters.groupId && !taskGroupIds(task).includes(filters.groupId)) return false;
			if ((filters.groupId === "" || filters.category === "ungrouped") && taskGroupIds(task).length)
				return false;
			if (
				(filters.environmentId && task.environmentId !== filters.environmentId) ||
				(filters.engineId && task.engineId !== filters.engineId) ||
				(filters.state && !matchesTaskState(task, filters.state))
			)
				return false;
			if (
				filters.archive &&
				((task.directoryMode ?? (task.connectionKind === "local" ? "single" : "dual")) !== "dual" ||
					taskArchiveState(task) !== filters.archive)
			)
				return false;
			const day = localSubmissionDay(task.lastSubmittedAt ?? task.createdAt);
			if ((filters.fromDate && day < filters.fromDate) || (filters.toDate && day > filters.toDate))
				return false;
			const query = filters.query.trim().toLocaleLowerCase();
			return (
				!query ||
				[
					task.displayName,
					task.taskId,
					task.formula ?? "",
					task.engineId,
					task.taskKind,
					task.environmentName
				]
					.join("\n")
					.toLocaleLowerCase()
					.includes(query)
			);
		})
		.sort(
			(a, b) =>
				Number(
					["running", "queued", "preparing", "submitting", "stop-requested"].includes(
						b.executionState
					)
				) -
					Number(
						["running", "queued", "preparing", "submitting", "stop-requested"].includes(
							a.executionState
						)
					) ||
				(b.lastSubmittedAt ?? b.createdAt).localeCompare(a.lastSubmittedAt ?? a.createdAt) ||
				a.taskId.localeCompare(b.taskId)
		);
}
export function errorMessage(error: unknown): string {
	if (error && typeof error === "object" && "message" in error) {
		const value = error as { message: unknown; details?: unknown };
		return `${String(value.message)}${typeof value.details === "string" && value.details ? `\n${value.details}` : ""}`;
	}
	return String(error);
}
export function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
