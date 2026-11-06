import type {
	TaskCardView,
	TaskBatchAction,
	TaskSystemBridge
} from "../../task-system/application-contracts";
import { taskArchiveState } from "./presentation";
export default function TaskDirectories(p: {
	task: TaskCardView;
	bridge: TaskSystemBridge;
	canManage: boolean;
	onAction(action: TaskBatchAction): void;
	onError(error: unknown): void;
}) {
	const { task } = p,
		dual = (task.directoryMode ?? (task.connectionKind === "local" ? "single" : "dual")) === "dual";
	const archiveState = taskArchiveState(task),
		activeOwner = Boolean(task.stopControl?.targets.length);
	async function open(kind: "work" | "archive") {
		try {
			await p.bridge.request("location.open", { taskId: task.taskId, kind });
		} catch (error) {
			p.onError(error);
		}
	}
	return (
		<div
			className="task-directories"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<div className="task-directory-row">
				<span>工作目录</span>
				<span>
					{task.workFileState === "cleared"
						? "已清空"
						: task.workFileState === "present"
							? "有文件"
							: "待核实"}
				</span>
				{task.connectionKind === "local" ? (
					<button disabled={!task.workPath} onClick={() => void open("work")}>
						打开
					</button>
				) : (
					<button
						disabled={!task.workPath}
						onClick={() => void navigator.clipboard.writeText(task.workPath ?? "").catch(p.onError)}
					>
						复制路径
					</button>
				)}
				<button
					disabled={
						!p.canManage ||
						activeOwner ||
						task.executionState !== "ended" ||
						task.workFileState === "cleared"
					}
					onClick={() => p.onAction("cleanup")}
				>
					清空
				</button>
			</div>
			{dual && (
				<div className="task-directory-row">
					<span>归档目录</span>
					<span data-archive-state={taskArchiveState(task)}>
						{(
							{
								unarchived: "未归档",
								archiving: "归档中",
								archived: "已归档",
								cleared: "已清空",
								failed: "归档异常"
							} as Record<string, string>
						)[taskArchiveState(task)] ?? "待核实"}
					</span>
					<button disabled={!task.archivePath} onClick={() => void open("archive")}>
						打开
					</button>
					<button
						disabled={
							!p.canManage ||
							activeOwner ||
							task.executionState !== "ended" ||
							archiveState === "archiving"
						}
						onClick={() => p.onAction(archiveState === "archived" ? "cleanup-archive" : "archive")}
					>
						{archiveState === "archived" ? "清空" : "归档"}
					</button>
				</div>
			)}
		</div>
	);
}
