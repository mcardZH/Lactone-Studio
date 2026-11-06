import { useEffect, useRef, useState } from "react";
import type { TaskOperationPlan, TaskSystemBridge } from "../../task-system/application-contracts";
import DialogShell from "../DialogShell";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope } from "./task-error-scope";
import TaskOperationProgress from "./TaskOperationProgress";
import { bytesLabel } from "./presentation";
export const actionLabels = {
	group: "分组",
	stop: "停止任务",
	archive: "归档",
	cleanup: "清空工作目录",
	recycle: "移入回收区",
	restore: "恢复",
	"cleanup-archive": "清理归档位置",
	"delete-task": "彻底删除"
};
export default function OperationDialog(p: {
	bridge: TaskSystemBridge;
	plan: TaskOperationPlan;
	onClose(): void;
	onChanged(): void;
	onStarted?(id: string): void;
}) {
	const [plan, setPlan] = useState(p.plan),
		[pending, setPending] = useState(false),
		[valid, setValid] = useState(true),
		[started, setStarted] = useState(""),
		[executing, setExecuting] = useState(false),
		[options, setOptions] = useState({
			deleteLocal: true,
			deleteRemote: true,
			remindRemote: false
		}),
		[archiveMode, setArchiveMode] = useState<"default" | "selected">("default"),
		[selectedFiles, setSelectedFiles] = useState<string[]>([]);
	const errors = useTaskErrorScope(`operation:${plan.planId}`);
	const live = useRef(true),
		planningRevision = useRef(0);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	async function replan(next: typeof options) {
		setOptions(next);
		setValid(false);
		setPending(true);
		const fail = errors.attempt("targets");
		try {
			setPlan(
				await p.bridge.request("operation.plan", {
					action: "delete-task",
					taskIds: plan.items.map((item) => item.taskId),
					...next
				})
			);
			setValid(true);
		} catch (error) {
			fail(error);
		} finally {
			setPending(false);
		}
	}
	async function replanArchive(mode: "default" | "selected", selectedArtifactIds?: string[]) {
		const revision = ++planningRevision.current;
		setArchiveMode(mode);
		setValid(false);
		setPending(true);
		const fail = errors.attempt("archive-selection");
		try {
			const next = await p.bridge.request("operation.plan", {
				action: "archive",
				taskIds: plan.items.map((item) => item.taskId),
				archiveMode: mode,
				...(selectedArtifactIds !== undefined ? { selectedArtifactIds } : {})
			});
			if (!live.current || revision !== planningRevision.current) return;
			setPlan(next);
			setSelectedFiles(
				next.items.flatMap((item) =>
					(item.files ?? []).filter((file) => file.included).map((file) => file.artifactId)
				)
			);
			setValid(true);
		} catch (error) {
			if (live.current && revision === planningRevision.current) fail(error);
		} finally {
			if (live.current && revision === planningRevision.current) setPending(false);
		}
	}
	async function execute() {
		if (pending || !valid) return;
		const fail = errors.attempt("execute");
		setPending(true);
		setExecuting(true);
		try {
			const value = await p.bridge.request("operation.execute", { planId: plan.planId });
			if (!live.current) {
				p.onChanged();
				return;
			}
			if (p.onStarted) p.onStarted(value.operationId);
			else setStarted(value.operationId);
			p.onChanged();
		} catch (error) {
			fail(error);
		} finally {
			setPending(false);
			setExecuting(false);
		}
	}
	if (started)
		return (
			<TaskOperationProgress
				bridge={p.bridge}
				operationId={started}
				onBack={p.onClose}
				onChanged={p.onChanged}
				onClearWork={async (taskIds) => {
					const next = await p.bridge.request("operation.plan", { action: "cleanup", taskIds });
					if (live.current) {
						setPlan(next);
						setStarted("");
						setValid(true);
					}
				}}
			/>
		);
	return (
		<DialogShell
			className="task-dialog task-operation-dialog"
			onCancel={p.onClose}
			aria-label={actionLabels[plan.action]}
		>
			<header>
				<h2>
					{actionLabels[plan.action]} · {plan.items.length} 项
				</h2>
				<button type="button" onClick={p.onClose} aria-label="关闭">
					×
				</button>
			</header>
			{errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={p.bridge} onDismiss={errors.dismiss} />
			)}
			{plan.warning && <p>{plan.warning}</p>}
			{plan.action === "archive" && (
				<fieldset>
					<legend>归档范围</legend>
					<label className="task-checkbox">
						<input
							type="radio"
							name="archive-mode"
							checked={archiveMode === "default"}
							disabled={pending}
							onChange={() => void replanArchive("default")}
						/>
						按软件默认归档
					</label>
					<label className="task-checkbox">
						<input
							type="radio"
							name="archive-mode"
							checked={archiveMode === "selected"}
							disabled={pending}
							onChange={() => void replanArchive("selected")}
						/>
						自选文件
					</label>
				</fieldset>
			)}
			{(plan.action === "archive" || plan.action === "cleanup") && (
				<p>
					本次文件总大小：
					{bytesLabel(
						plan.totalBytes ??
							(plan.items.every((item) => item.totalBytes !== undefined)
								? plan.items.reduce((sum, item) => sum + item.totalBytes!, 0)
								: null)
					)}
				</p>
			)}
			{plan.action === "archive" && archiveMode === "selected" && (
				<div className="task-actions">
					<button
						type="button"
						disabled={pending}
						onClick={() =>
							void replanArchive(
								"selected",
								plan.items
									.filter((item) => item.eligible)
									.flatMap((item) => (item.files ?? []).map((file) => file.artifactId))
							)
						}
					>
						全选
					</button>
					<button
						type="button"
						disabled={pending}
						onClick={() =>
							void replanArchive(
								"selected",
								plan.items
									.filter((item) => item.eligible)
									.flatMap((item) =>
										(item.files ?? [])
											.filter((file) => file.recommended)
											.map((file) => file.artifactId)
									)
							)
						}
					>
						只选推荐文件
					</button>
					<button
						type="button"
						disabled={pending}
						onClick={() => void replanArchive("selected", [])}
					>
						取消全选
					</button>
					<span>已选 {selectedFiles.length} 项</span>
				</div>
			)}
			{plan.action === "cleanup" && plan.items.some((item) => item.requiresStop) && (
				<p>将先停止仍在运行的任务；确认实际结束后，按本次清单清空工作目录。</p>
			)}
			{plan.action === "delete-task" && (
				<fieldset className="task-delete-options">
					<legend>删除范围</legend>
					<label>
						<input
							type="checkbox"
							checked={options.deleteLocal}
							disabled={pending}
							onChange={(event) => void replan({ ...options, deleteLocal: event.target.checked })}
						/>
						删除本地目标
					</label>
					<label>
						<input
							type="checkbox"
							checked={options.deleteRemote}
							disabled={pending}
							onChange={(event) => void replan({ ...options, deleteRemote: event.target.checked })}
						/>
						删除可连接的原位置目标
					</label>
					<label>
						<input
							type="checkbox"
							checked={options.remindRemote}
							disabled={pending}
							onChange={(event) => void replan({ ...options, remindRemote: event.target.checked })}
						/>
						保留远端未处理提醒
					</label>
					<small>无法连接的远端目标单列为未处理，重连后仅提醒。</small>
				</fieldset>
			)}
			<div className="task-table-scroll">
				<table>
					<thead>
						<tr>
							<th>任务</th>
							<th>影响／不适用原因</th>
						</tr>
					</thead>
					<tbody>
						{plan.items.map((item) => (
							<tr key={item.taskId}>
								<td>{item.displayName}</td>
								<td>
									{item.eligible ? item.impact : `不适用：${item.reason ?? "当前状态不支持"}`}
									{item.workPath && <p className="task-path">目录：{item.workPath}</p>}
									{plan.action === "cleanup" && item.directoryMode === "dual" && (
										<p>
											归档情况：
											{
												{
													full: "已完整归档",
													partial: "部分归档",
													none: "未归档",
													unknown: "待核实"
												}[item.archiveCoverage ?? "unknown"]
											}
											；保留任务卡、提交记录和已有独立归档。
										</p>
									)}
									{plan.action === "cleanup" && item.directoryMode === "single" && (
										<p>保留任务卡和提交记录。</p>
									)}
									{item.files && (
										<details open={plan.action === "archive" && archiveMode === "selected"}>
											<summary>
												文件清单 · {item.files.length} 项 · {bytesLabel(item.totalBytes ?? null)}
											</summary>
											<table className="task-operation-files">
												<thead>
													<tr>
														<th>选择</th>
														<th>文件/相对路径</th>
														<th>用途</th>
														<th>大小</th>
													</tr>
												</thead>
												<tbody>
													{item.files.map((file) => (
														<tr key={file.artifactId}>
															<td>
																{plan.action === "archive" && archiveMode === "selected" ? (
																	<input
																		type="checkbox"
																		aria-label={`归档 ${file.relativePath}`}
																		checked={selectedFiles.includes(file.artifactId)}
																		disabled={pending || !item.eligible}
																		onChange={(event) =>
																			void replanArchive(
																				"selected",
																				event.target.checked
																					? [...selectedFiles, file.artifactId]
																					: selectedFiles.filter((id) => id !== file.artifactId)
																			)
																		}
																	/>
																) : file.included ? (
																	"✓"
																) : (
																	"—"
																)}
															</td>
															<td>{file.relativePath}</td>
															<td>
																{(file.roles ?? [])
																	.map(
																		(role) =>
																			(
																				({
																					input: "输入",
																					"primary-output": "主输出",
																					wavefunction: "波函数",
																					trajectory: "轨迹",
																					structure: "结构",
																					scratch: "临时文件",
																					other: "其他"
																				}) as Record<string, string>
																			)[role] ?? role
																	)
																	.join("、") || "其他"}
															</td>
															<td>{bytesLabel(file.byteSize)}</td>
														</tr>
													))}
												</tbody>
											</table>
										</details>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{pending && (
				<div role="status">
					<progress />
					{valid ? "正在登记操作…" : "正在核对所选目标…"}
				</div>
			)}
			<footer>
				<button type="button" onClick={p.onClose}>
					{executing ? "后台继续，返回" : "取消"}
				</button>
				<button
					type="button"
					className="button button-primary"
					disabled={
						pending ||
						!valid ||
						!plan.items.some((item) => item.eligible) ||
						(plan.action === "delete-task" && !options.deleteLocal && !options.deleteRemote)
					}
					onClick={() => void execute()}
				>
					{plan.action === "cleanup"
						? plan.items.some((item) => item.requiresStop)
							? "停止并清空"
							: "确认清空"
						: plan.action === "archive"
							? "开始归档"
							: `确认${actionLabels[plan.action]}`}
				</button>
			</footer>
		</DialogShell>
	);
}
