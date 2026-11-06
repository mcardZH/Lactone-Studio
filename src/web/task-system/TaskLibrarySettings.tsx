import { useState } from "react";
import type {
	LibraryDiagnosticView,
	LibraryDiscoveryView,
	TaskLibraryView,
	TaskSystemBridge
} from "../../task-system/application-contracts";
import DialogShell from "../DialogShell";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope } from "./task-error-scope";
export interface TaskLibrarySettingsProps {
	bridge: TaskSystemBridge;
	library: TaskLibraryView;
	canManage: boolean;
	onChanged(): void | Promise<void>;
	onOpenRecycle(): void;
	onClose(): void;
	onOperationStarted?(id: string): void;
}
export function canRepairTaskLibrary(
	canManage: boolean,
	pending: boolean,
	diagnostic: LibraryDiagnosticView | null
) {
	return canManage && !pending && Boolean(diagnostic?.issues.some((issue) => issue.repairable));
}
/** The same explicit setup entry can be hosted by task navigation or input drafts. */
export function TaskLibraryEntry(p: {
	bridge: TaskSystemBridge;
	library: TaskLibraryView;
	onChanged(): void | Promise<void>;
}) {
	const [pending, setPending] = useState(false),
		[details, setDetails] = useState(false);
	const errors = useTaskErrorScope(`library-entry:${p.library.path ?? "new"}`);
	const unavailable = Boolean(p.library.path);
	async function associate(mode: "create" | "open") {
		if (pending) return;
		setPending(true);
		try {
			await p.bridge.request("library.associate", { mode });
			await p.onChanged();
		} catch (error) {
			errors.attempt(mode)(error);
		} finally {
			setPending(false);
		}
	}
	return (
		<section className="task-library-entry" aria-label="任务库设置引导">
			<h3>{unavailable ? "原任务库暂时无法访问" : "尚未设置任务库"}</h3>
			{unavailable ? (
				<p>
					原位置 <code>{p.library.path}</code>
				</p>
			) : (
				<p>任务库用于保存任务记录和分组，可跨版本继续使用。</p>
			)}
			<div className="task-actions">
				{unavailable ? (
					<>
						<button disabled={pending} onClick={() => void p.onChanged()}>
							重试
						</button>
						<button disabled={pending} onClick={() => void associate("open")}>
							重新定位任务库
						</button>
						<button onClick={() => setDetails((value) => !value)}>详情</button>
					</>
				) : (
					<>
						<button disabled={pending} onClick={() => void associate("create")}>
							新建任务库
						</button>
						<button disabled={pending} onClick={() => void associate("open")}>
							打开已有任务库
						</button>
					</>
				)}
			</div>
			{pending && <p role="status">正在接入任务库…</p>}
			{details && <p>保留原任务库关联。请检查目录是否可访问，然后重试或重新定位原任务库。</p>}
			{errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={p.bridge} onDismiss={errors.dismiss} />
			)}
		</section>
	);
}
export default function TaskLibrarySettings(p: TaskLibrarySettingsProps) {
	const [root, setRoot] = useState(p.library.path ?? ""),
		[pending, setPending] = useState(false),
		[phase, setPhase] = useState(""),
		[diagnostic, setDiagnostic] = useState<LibraryDiagnosticView | null>(null),
		[discovery, setDiscovery] = useState<LibraryDiscoveryView | null>(null),
		[choices, setChoices] = useState<Record<string, string>>({}),
		[migrate, setMigrate] = useState(false);
	const errors = useTaskErrorScope(`library:${p.library.libraryId ?? "unassociated"}`);
	async function perform(label: string, action: () => Promise<void>) {
		if (pending) return;
		setPending(true);
		setPhase(label);
		try {
			await action();
		} catch (error) {
			errors.attempt(label)(error);
			setPhase("本次操作未完成");
		} finally {
			setPending(false);
		}
	}
	async function associate(select = false, create = false) {
		await perform("正在接入任务库", async () => {
			const library = await p.bridge.request("library.associate", {
				...(select ? {} : { root: root.trim() }),
				mode: create ? "create" : "open"
			});
			setRoot(library.path ?? root);
			setPhase("已接入任务库");
			await p.onChanged();
		});
	}
	const unresolved = discovery?.items.some(
		(item) => item.state === "conflict" && !choices[item.markerPath ?? item.directory]
	);
	return (
		<DialogShell
			className="task-dialog task-library-dialog"
			onCancel={p.onClose}
			aria-label="任务库设置"
		>
			<header>
				<h2>任务库设置</h2>
				<button onClick={p.onClose} aria-label="关闭任务库设置">
					×
				</button>
			</header>
			{errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={p.bridge} onDismiss={errors.dismiss} />
			)}
			<label>
				任务库根目录
				<input
					aria-label="任务库根目录"
					value={root}
					onChange={(event) => setRoot(event.target.value)}
				/>
			</label>
			<div className="task-actions">
				<button disabled={pending || !root.trim()} onClick={() => void associate()}>
					接入此任务库
				</button>
				<button disabled={pending} onClick={() => void associate(true)}>
					选择文件夹并接入
				</button>
				<button
					disabled={pending || !root.trim() || Boolean(p.library.libraryId)}
					onClick={() => void associate(false, true)}
				>
					新建任务库
				</button>
			</div>
			<dl>
				<dt>当前路径</dt>
				<dd>{p.library.path ?? "尚未关联任务库"}</dd>
				<dt>任务库编号</dt>
				<dd>{p.library.libraryId ?? "—"}</dd>
				<dt>状态</dt>
				<dd>{p.library.migrating ? "迁移中" : p.canManage ? "可管理" : "只读"}</dd>
				<dt>回收区</dt>
				<dd>{p.library.recycledCount} 项</dd>
			</dl>
			{phase && (
				<div role="status">
					{phase}
					{pending && <progress />}
				</div>
			)}
			<div className="task-actions">
				<button
					disabled={pending || !root.trim()}
					onClick={() =>
						void perform("正在重新识别目录", async () => {
							setDiscovery(await p.bridge.request("library.discover", { root: root.trim() }));
							setChoices({});
							setPhase("目录识别完成，请核对恢复候选");
						})
					}
				>
					重新识别目录
				</button>
				<button
					disabled={pending || !p.library.path}
					onClick={() =>
						void perform("正在自检任务库", async () => {
							setDiagnostic(await p.bridge.request("library.self-check", { repair: false }));
							setPhase("任务库自检完成");
						})
					}
				>
					任务库自检
				</button>
				<button disabled={!p.library.path} onClick={p.onOpenRecycle}>
					查看回收区
				</button>
				<button disabled={pending || !p.canManage} onClick={() => setMigrate(true)}>
					迁移任务库
				</button>
			</div>
			{discovery && (
				<section className="task-library-recovery">
					<h3>恢复候选 · {discovery.items.length} 项</h3>
					{discovery.issues.map((issue) => (
						<p key={issue.id}>{issue.message}</p>
					))}
					{discovery.conflicts.map((conflict) => (
						<p key={conflict.id} className="task-recovery-conflict">
							{conflict.message}
						</p>
					))}
					<ul>
						{discovery.items.map((item) => (
							<li key={item.markerPath ?? item.directory}>
								<strong>{item.displayName}</strong>
								<code>{item.directory}</code>
								<span>{item.state}</span>
								<select
									aria-label={`恢复 ${item.displayName}`}
									value={choices[item.markerPath ?? item.directory] ?? ""}
									onChange={(event) =>
										setChoices((prior) => ({
											...prior,
											[item.markerPath ?? item.directory]: event.target.value
										}))
									}
								>
									<option value="">
										{item.state === "conflict" ? "选择处理方式" : "按已识别身份恢复"}
									</option>
									<option value="use">使用此来源</option>
									<option value="new-id">登记为独立任务</option>
									<option value="skip">跳过此项</option>
								</select>
							</li>
						))}
					</ul>
					<button
						disabled={pending || Boolean(unresolved)}
						onClick={() =>
							void perform("正在建立候选索引", async () => {
								const operation = await p.bridge.request("library.rebuild", {
									candidateId: discovery.candidateId,
									choices
								});
								p.onOperationStarted?.(operation.operationId);
								await p.onChanged();
								setPhase("已提交恢复操作");
							})
						}
					>
						确认恢复候选
					</button>
				</section>
			)}
			{diagnostic && (
				<section>
					<h3>任务库诊断</h3>
					{diagnostic.issues.length ? (
						<ul>
							{diagnostic.issues.map((issue) => (
								<li key={issue.id}>
									{issue.message}
									{issue.repairable ? "（可修复）" : ""}
								</li>
							))}
						</ul>
					) : (
						<p>本次检查未发现问题</p>
					)}
					<button
						disabled={!canRepairTaskLibrary(p.canManage, pending, diagnostic)}
						onClick={() =>
							void perform("正在修复已确认项", async () => {
								setDiagnostic(
									await p.bridge.request("library.self-check", {
										repair: true,
										checkId: diagnostic.checkId
									})
								);
								await p.onChanged();
								setPhase("修复完成");
							})
						}
					>
						修复可修复项
					</button>
				</section>
			)}
			{migrate && (
				<section className="task-confirm">
					<h3>迁移任务库</h3>
					<p>
						选择新位置后复制当前任务记录和归档，核验成功再切换，旧库保留。迁移期间已有计算继续。
					</p>
					<button onClick={() => setMigrate(false)}>取消</button>
					<button
						disabled={pending}
						onClick={() =>
							void perform("正在迁移任务库", async () => {
								const value = await p.bridge.request("library.migrate", {});
								setMigrate(false);
								p.onOperationStarted?.(value.operationId);
								setPhase(value.message);
								await p.onChanged();
							})
						}
					>
						选择位置并迁移
					</button>
				</section>
			)}
			<footer>
				<button onClick={p.onClose}>关闭</button>
			</footer>
		</DialogShell>
	);
}
