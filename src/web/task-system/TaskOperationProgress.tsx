import { useEffect, useRef, useState } from "react";
import type { TaskOperationView, TaskSystemBridge } from "../../task-system/application-contracts";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope } from "./task-error-scope";
const terminal = new Set(["succeeded", "failed", "partial", "cancelled"]);
const operationLabels: Record<string, string> = {
	group: "分组",
	stop: "停止任务",
	archive: "归档",
	cleanup: "清空工作目录",
	recycle: "移入回收区",
	restore: "恢复",
	"cleanup-archive": "清理归档位置",
	"delete-task": "彻底删除"
};
const phaseLabels: Record<string, string> = {
	"intent-persisted": "等待执行",
	等待执行: "等待执行",
	retrying: "正在重试",
	finished: "已结束",
	failed: "失败",
	"waiting-verification": "等待核验"
};
function operationPhase(type?: string, phase?: string, state?: string) {
	const action = operationLabels[type?.replace(/^batch-/, "") ?? ""] ?? "操作";
	const stateLabel: Record<string, string> = {
		pending: "等待执行",
		running: "进行中",
		"waiting-verification": "等待核验",
		succeeded: "完成",
		failed: "失败",
		"not-executed": "未执行",
		partial: "部分完成",
		cancelled: "已取消"
	};
	if (state && (terminal.has(state) || state === "not-executed"))
		return `${action} · ${stateLabel[state]}`;
	const phaseAction = operationLabels[phase ?? ""];
	return phaseAction
		? `正在${phaseAction}`
		: `${action} · ${phaseLabels[phase ?? ""] ?? stateLabel[state ?? ""] ?? "状态待确认"}`;
}
export default function TaskOperationProgress(p: {
	bridge: TaskSystemBridge;
	operationId: string;
	onBack(): void;
	onChanged(): void;
	onOperationStarted?(id: string): void;
	onClearWork?(taskIds: string[]): void | Promise<void>;
}) {
	const [view, setView] = useState<TaskOperationView | null>(null),
		[currentId, setCurrentId] = useState(p.operationId),
		[refreshEpoch, setRefreshEpoch] = useState(0),
		[retrying, setRetrying] = useState(false),
		live = useRef(true),
		errors = useTaskErrorScope(`operation:${currentId}`);
	useEffect(() => {
		live.current = true;
		let active = true,
			timer: ReturnType<typeof setTimeout> | undefined,
			inflight = false;
		const read = async () => {
			if (inflight) return;
			inflight = true;
			try {
				const value = await p.bridge.request("operation.read", { operationId: currentId });
				if (!active) return;
				setView(value);
				if (terminal.has(value.state)) p.onChanged();
				else timer = setTimeout(() => void read(), 700);
			} catch (error) {
				if (active) {
					errors.automatic("read")(error);
					timer = setTimeout(() => void read(), 2000);
				}
			} finally {
				inflight = false;
			}
		};
		void read();
		return () => {
			active = false;
			live.current = false;
			clearTimeout(timer);
		};
	}, [p.bridge, currentId, refreshEpoch]);
	async function retry(taskId: string) {
		if (retrying) return;
		setRetrying(true);
		const fail = errors.attempt("retry");
		try {
			const value = await p.bridge.request("operation.retry", {
				operationId: currentId,
				taskIds: [taskId]
			});
			if (!live.current) return;
			setCurrentId(value.operationId);
			setRefreshEpoch((value) => value + 1);
			setView(null);
			p.onOperationStarted?.(value.operationId);
		} catch (error) {
			fail(error);
		} finally {
			setRetrying(false);
		}
	}
	async function archiveAction(taskId: string, action: "open" | "cleanup") {
		const fail = errors.attempt(action);
		try {
			if (action === "open") await p.bridge.request("location.open", { taskId, kind: "archive" });
			else await p.onClearWork?.([taskId]);
		} catch (error) {
			if (live.current) fail(error);
		}
	}
	const total = view?.progress.total,
		fraction =
			typeof total === "number" && total > 0 ? Math.min(1, view!.progress.completed / total) : null;
	return (
		<section className="task-operation-page" aria-label="操作进度">
			<header>
				<h3>操作进度 · {view ? operationPhase(view.type, view.phase, view.state) : "正在读取"}</h3>
				<button onClick={p.onBack}>返回任务列表</button>
			</header>
			{errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={p.bridge} onDismiss={errors.dismiss} />
			)}
			<div role="status">
				<progress max={1} value={fraction ?? undefined} />
				{fraction !== null && <span>{Math.round(fraction * 100)}%</span>}
				<span>
					已处理 {view?.progress.completed ?? 0}
					{total != null ? ` / ${total}` : ""}{" "}
					{view?.progress.unit === "bytes"
						? "字节"
						: view?.progress.unit === "files"
							? "文件"
							: "项"}
				</span>
				<span>{view && !terminal.has(view.state) ? "预计剩余 估算中" : ""}</span>
			</div>
			<ul>
				{view?.items.map((item) => (
					<li key={item.taskId}>
						<strong>{item.displayName}</strong>
						<span>
							{item.outcome
								? {
										succeeded: "成功",
										failed: "失败",
										"not-executed": view && terminal.has(view.state) ? "未执行" : "等待执行"
									}[item.outcome]
								: operationPhase(view.type, item.phase, item.state ?? "pending")}
						</span>
						{item.totalBytes != null && item.totalBytes > 0 && (
							<progress max={item.totalBytes} value={item.completedBytes ?? 0} />
						)}
						<span>{item.message}</span>
						{view?.type === "batch-archive" &&
							terminal.has(view.state) &&
							(item.outcome === "succeeded" || item.state === "succeeded") && (
								<span className="task-actions">
									<button type="button" onClick={() => void archiveAction(item.taskId, "open")}>
										打开归档目录
									</button>
									{p.onClearWork && (
										<button
											type="button"
											onClick={() => void archiveAction(item.taskId, "cleanup")}
										>
											清空原工作目录
										</button>
									)}
								</span>
							)}
						{terminal.has(view!.state) &&
							(item.outcome === "failed" ||
								item.outcome === "not-executed" ||
								item.state === "failed" ||
								item.state === "not-executed") && (
								<button disabled={retrying} onClick={() => void retry(item.taskId)}>
									重试此项
								</button>
							)}
					</li>
				))}
			</ul>
			<p>
				{view && terminal.has(view.state)
					? {
							succeeded: "操作完成",
							failed: "操作失败",
							partial: "部分完成",
							cancelled: "操作已取消"
						}[view.state as "succeeded"]
					: "离开本页后操作继续，可从操作记录重新查看。"}
			</p>
			{view?.type === "batch-archive" && terminal.has(view.state) && (
				<button type="button" onClick={p.onBack}>
					关闭
				</button>
			)}
		</section>
	);
}
