import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	TaskFileView,
	TaskSystemBridge,
	TextPreviewChunk,
	PreviewSourceIdentity
} from "../../task-system/application-contracts";
import DialogShell from "../DialogShell";
import TaskErrorNotice from "./TaskErrorNotice";
import { useTaskErrorScope, type TaskErrorReporter } from "./task-error-scope";
import { bytesLabel, verificationLabels, isAbort } from "./presentation";
export interface FilePreviewProps {
	bridge: TaskSystemBridge;
	file: TaskFileView;
	onClose(): void;
	refreshIntervalSeconds?: number;
	embedded?: boolean;
	taskId?: string;
	initiallyEnded?: boolean;
}
const CHUNK_BYTES = 128 * 1024,
	ROW_HEIGHT = 24,
	OVERSCAN = 12;
function sourceChanged(error: unknown) {
	return (
		Boolean(
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "PREVIEW_SOURCE_CHANGED"
		) ||
		(error instanceof Error && error.message.includes("PREVIEW_SOURCE_CHANGED"))
	);
}
export default function FilePreview({
	bridge,
	file,
	onClose,
	refreshIntervalSeconds = 0,
	embedded = false,
	taskId,
	initiallyEnded = false
}: FilePreviewProps) {
	const [intervalDraft, setIntervalDraft] = useState(
			String(Math.max(1, refreshIntervalSeconds || 2))
		),
		[automatic, setAutomatic] = useState(refreshIntervalSeconds > 0 && !initiallyEnded),
		[ended, setEnded] = useState(initiallyEnded),
		[rowHeight, setRowHeight] = useState(ROW_HEIGHT);
	const [chunk, setChunk] = useState<TextPreviewChunk | null>(null),
		[query, setQuery] = useState(""),
		[finding, setFinding] = useState(false),
		[pending, setPending] = useState(false),
		[following, setFollowing] = useState(true),
		[scrollTop, setScrollTop] = useState(0),
		[height, setHeight] = useState(480),
		[anchorInput, setAnchorInput] = useState("");
	const [searchProgress, setSearchProgress] = useState<{ completed: number; total: number; started: number } | null>(null);
	const ownerId = useRef(`preview-${crypto.randomUUID()}`),
		current = useRef<AbortController | null>(null),
		search = useRef<AbortController | null>(null),
		surface = useRef<HTMLDivElement>(null),
		live = useRef(true),
		follow = useRef(true),
		matchByte = useRef<number | null>(null),
		programmatic = useRef<number | null>(null),
		lastScrollTop = useRef(0),
		loadedTail = useRef(true);
	const preservedScroll = useRef<number | null>(null);
	const laidOutChunk = useRef<TextPreviewChunk | null>(null);
	const expectedSource = useRef<PreviewSourceIdentity | undefined>(undefined);
	follow.current = following;
	const errors = useTaskErrorScope(`preview:${file.artifactId}`);
	async function read(
		anchor: number | "tail",
		fail: TaskErrorReporter = errors.automatic("read"),
		preserveScroll = false
	) {
		search.current?.abort();
		setFinding(false);
		preservedScroll.current = preserveScroll ? (surface.current?.scrollTop ?? 0) : null;
		current.current?.abort();
		const own = new AbortController();
		current.current = own;
		setPending(true);
		try {
			const value = await bridge.request(
				"preview.read",
				{
					ownerId: ownerId.current,
					artifactId: file.artifactId,
					anchor,
					maxBytes: CHUNK_BYTES,
					expectedSourceIdentity: expectedSource.current
				},
				{ signal: own.signal }
			);
			if (
				!live.current ||
				own.signal.aborted ||
				current.current !== own ||
				(anchor === "tail" && !follow.current)
			)
				return;
			loadedTail.current = anchor === "tail";
			if (value.sourceIdentity && !expectedSource.current)
				expectedSource.current = value.sourceIdentity;
			if (
				anchor === "tail" &&
				chunk?.version === value.version &&
				chunk.byteStart === value.byteStart &&
				chunk.byteEnd === value.byteEnd
			)
				return;
			setChunk(value);
			setScrollTop(preservedScroll.current ?? 0);
		} catch (e) {
			if (live.current && !own.signal.aborted && sourceChanged(e)) {
				setAutomatic(false);
				setFollowing(false);
				follow.current = false;
			}
			if (live.current && !own.signal.aborted && current.current === own && !isAbort(e)) fail(e);
		} finally {
			if (live.current && current.current === own) setPending(false);
		}
	}
	useLayoutEffect(() => {
		const node = surface.current;
		if (!node || !chunk) return;
		const changed = laidOutChunk.current !== chunk;
		laidOutChunk.current = chunk;
		node.scrollTop = changed
			? preservedScroll.current ?? (loadedTail.current && follow.current ? node.scrollHeight : 0)
			: loadedTail.current && follow.current ? node.scrollHeight : node.scrollTop;
		if (changed) preservedScroll.current = null;
		programmatic.current = node.scrollTop;
		lastScrollTop.current = node.scrollTop;
		setScrollTop(node.scrollTop);
	}, [chunk, height, rowHeight]);
	useEffect(() => {
		live.current = true;
		ownerId.current = `preview-${crypto.randomUUID()}`;
		const ownOwnerId = ownerId.current;
		expectedSource.current = undefined;
		matchByte.current = null;
		setChunk(null);
		if (file.kind === "text") void read("tail");
		return () => {
			live.current = false;
			current.current?.abort();
			search.current?.abort();
			void bridge.request("preview.release", { ownerId: ownOwnerId }).catch(() => {});
		};
	}, [bridge, file.artifactId]);
	useEffect(() => {
		const seconds = Number(intervalDraft);
		if (file.kind !== "text" || !automatic || !/^\d+$/.test(intervalDraft) || seconds < 1) return;
		const timer = setInterval(() => {
			if (follow.current && !pending) void read("tail");
			if (taskId && !ended)
				void bridge
					.request("task.details", { taskId })
					.then((value) => {
						if (!live.current) return;
						if (value.task.executionState === "ended") {
							setEnded(true);
							setAutomatic(false);
						}
					})
					.catch(errors.automatic("status"));
		}, seconds * 1000);
		return () => clearInterval(timer);
	}, [bridge, file.artifactId, file.kind, pending, intervalDraft, automatic, taskId, ended]);
	useEffect(() => {
		const node = surface.current;
		if (!node) return;
		const update = () => {
			setHeight(node.clientHeight);
			const size = Number.parseFloat(
				node.ownerDocument.defaultView!.getComputedStyle(node).fontSize
			);
			setRowHeight(Math.max(ROW_HEIGHT, Math.ceil(size * 1.5)));
		};
		update();
		const observer = new node.ownerDocument.defaultView!.ResizeObserver(update);
		observer.observe(node);
		return () => observer.disconnect();
	}, [file.kind, Boolean(chunk)]);
	async function find(direction: "previous" | "next") {
		if (!query || finding) return;
		const fail = errors.attempt("find");
		const own = new AbortController();
		search.current?.abort();
		search.current = own;
		current.current?.abort();
		setPending(false);
		setFinding(true);
		setFollowing(false);
		follow.current = false;
		const started = performance.now();
		setSearchProgress(null);
		try {
			let fromByte = Math.max(0, Math.min(chunk?.totalBytes ?? file.size ?? Number.MAX_SAFE_INTEGER,
				matchByte.current === null ? (chunk?.byteStart ?? 0) : matchByte.current + (direction === "next" ? 1 : -1)));
			let searchEndByte: number | undefined;
			while (live.current && !own.signal.aborted && search.current === own) {
				const found = await bridge.request(
					"preview.find",
					{
						ownerId: ownerId.current,
						expectedSourceIdentity: expectedSource.current,
						artifactId: file.artifactId,
						query,
						fromByte,
						searchEndByte,
						direction
					},
					{ signal: own.signal }
				);
				if (!live.current || own.signal.aborted || search.current !== own) return;
				if (found && "kind" in found) {
					fromByte = found.nextByte;
					searchEndByte = found.searchEndByte;
					setSearchProgress({ completed: found.completedBytes, total: found.totalBytes, started });
					continue;
				}
				if (found) {
					matchByte.current = found.byteOffset;
					setAnchorInput(String(found.byteOffset));
					await read(found.byteOffset, fail);
				} else fail("未找到更多匹配");
				break;
			}
		} catch (e) {
			if (live.current && !own.signal.aborted && sourceChanged(e)) {
				setAutomatic(false);
				setFollowing(false);
				follow.current = false;
			}
			if (live.current && search.current === own && !own.signal.aborted && !isAbort(e)) fail(e);
		} finally {
			if (live.current && search.current === own) setFinding(false);
		}
	}
	async function copySelected() {
		const selection = surface.current?.ownerDocument.getSelection();
		if (
			!selection?.rangeCount ||
			!surface.current?.contains(selection.getRangeAt(0).commonAncestorContainer)
		)
			return;
		const text = selection.toString();
		const fail = errors.attempt("copy-selected");
		if (text)
			try {
				await bridge.request("clipboard.write", { text });
			} catch (e) {
				fail(e);
			}
	}
	const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN),
		last = Math.min(
			chunk?.lines.length ?? 0,
			Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN
		);
	const Container = embedded ? "section" : DialogShell;
	const searchPercent = searchProgress ? Math.floor(100 * searchProgress.completed / Math.max(1, searchProgress.total)) : null;
	const searchRemaining = searchProgress && searchProgress.completed > 0
		? `${Math.ceil((performance.now() - searchProgress.started) / 1000 * (searchProgress.total - searchProgress.completed) / searchProgress.completed)} 秒`
		: "估算中";
	return (
		<Container
			className="task-dialog task-file-preview"
			onCancel={onClose}
			aria-label={`只读预览 ${file.name}`}
		>
			<header>
				<h2>{file.name} · 只读预览</h2>
				<button type="button" aria-label="关闭预览" onClick={onClose}>
					×
				</button>
			</header>
			<p className="task-file-info">
				{file.role} · {bytesLabel(file.size)} ·{" "}
				{verificationLabels[file.verificationState] ?? file.verificationState}
			</p>
			{errors.notice && (
				<TaskErrorNotice {...errors.notice} bridge={bridge} onDismiss={errors.dismiss} />
			)}
			<div className="task-actions">
				{file.kind === "text" && (
					<>
						<label>
							查找
							<input
								type="search"
								value={query}
								onChange={(event) => {
									search.current?.abort();
									setFinding(false);
									setQuery(event.target.value);
									matchByte.current = null;
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void find(event.shiftKey ? "previous" : "next");
									}
								}}
							/>
						</label>
						<button
							type="button"
							disabled={!query || finding}
							onClick={() => void find("previous")}
						>
							上一处
						</button>
						<button type="button" disabled={!query || finding} onClick={() => void find("next")}>
							下一处
						</button>
						{finding && (
							<>
								<span role="status">
									查找中 {searchProgress && `${bytesLabel(searchProgress.completed)} / ${bytesLabel(searchProgress.total)} · ${searchPercent}% · `}
									预计剩余 {searchRemaining}
								</span>
								<progress max={searchProgress?.total || undefined} value={searchProgress?.completed} aria-label="查找进度" />
								<button
									type="button"
									onClick={() => {
										search.current?.abort();
										setFinding(false);
									}}
								>
									取消查找
								</button>
							</>
						)}
						<button
							type="button"
							onClick={() => {
								setFollowing(true);
								void read("tail", errors.attempt("follow-tail"));
							}}
						>
							回到末尾
						</button>
						<button type="button" onClick={() => void copySelected()}>
							复制选中
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() =>
						void bridge
							.request("clipboard.write", { text: file.path })
							.catch(errors.attempt("copy-path-or-save"))
					}
				>
					复制路径
				</button>
				<button
					type="button"
					onClick={() =>
						void bridge
							.request("file.save-copy", {
								artifactId: file.artifactId,
								expectedSourceIdentity: expectedSource.current
							})
							.catch(errors.attempt("copy-path-or-save"))
					}
				>
					另存副本
				</button>
			</div>
			{file.kind === "text" ? (
				<>
					<div className="task-preview-location">
						<label>
							<input
								type="checkbox"
								checked={automatic && following}
								onChange={(event) => {
									const enabled = event.target.checked;
									setAutomatic(enabled);
									setFollowing(enabled);
									if (enabled) {
										follow.current = true;
										void read("tail", errors.attempt("follow"));
									}
								}}
							/>
							跟随末尾
						</label>
						<label>
							每
							<input
								aria-label="文本更新间隔"
								inputMode="numeric"
								value={intervalDraft}
								aria-invalid={!/^\d+$/.test(intervalDraft) || Number(intervalDraft) < 1}
								onChange={(event) => setIntervalDraft(event.target.value)}
							/>
							秒
						</label>
						<button
							disabled={pending}
							onClick={() =>
								void read(
									follow.current ? "tail" : (chunk?.byteStart ?? 0),
									errors.attempt("refresh"),
									!follow.current
								)
							}
						>
							立即更新
						</button>
						<span>{following ? "跟随末尾" : "已暂停跟随"}</span>
						<span>
							字节 {chunk?.byteStart ?? "—"}–{chunk?.byteEnd ?? "—"}
							{chunk?.lineStart != null
								? ` · 来源行 ${chunk.lineStart}–${chunk.lineStart + chunk.lines.length - 1}`
								: " · 尚无来源行索引"}
						</span>
						<label>
							字节位置
							<input
								aria-label="字节位置"
								inputMode="numeric"
								value={anchorInput}
								onChange={(event) => setAnchorInput(event.target.value)}
							/>
						</label>
						<button
							type="button"
							disabled={!/^\d+$/.test(anchorInput) || !Number.isSafeInteger(Number(anchorInput))}
							onClick={() => {
								setFollowing(false);
								void read(Number(anchorInput), errors.attempt("jump"));
							}}
						>
							跳转
						</button>
					</div>
					<div
						className="task-preview-text"
						ref={surface}
						tabIndex={0}
						aria-label="只读原文"
						onScroll={(event) => {
							const node = event.currentTarget;
							const expected = programmatic.current;
							programmatic.current = null;
							if ((expected === null || node.scrollTop !== expected) && node.scrollTop < lastScrollTop.current) {
								follow.current = false;
								setFollowing(false);
							}
							lastScrollTop.current = node.scrollTop;
							setScrollTop(node.scrollTop);
						}}
					>
						<div
							style={{
								height: (chunk?.lines.length ?? 0) * rowHeight,
								position: "relative",
								minWidth: "max-content"
							}}
						>
							{chunk?.lines.slice(first, last).map((line, index) => (
								<div
									key={first + index}
									className="task-preview-row"
									style={{
										position: "absolute",
										top: (first + index) * rowHeight,
										height: rowHeight,
										lineHeight: `${rowHeight}px`
									}}
								>
									<span className="task-preview-line">
										{chunk.lineStart == null ? "" : chunk.lineStart + first + index}
									</span>
									<code>{line}</code>
								</div>
							))}
						</div>
					</div>
					<div className="task-actions">
						<button
							type="button"
							disabled={!chunk?.hasBefore || pending}
							onClick={() => {
								setFollowing(false);
								void read(
									Math.max(0, (chunk?.byteStart ?? 0) - CHUNK_BYTES),
									errors.attempt("previous-chunk")
								);
							}}
						>
							上一段
						</button>
						<button
							type="button"
							disabled={!chunk?.hasAfter || pending}
							onClick={() => {
								setFollowing(false);
								void read(chunk?.byteEnd ?? 0, errors.attempt("next-chunk"));
							}}
						>
							下一段
						</button>
						{pending && <span role="status">读取中…</span>}
					</div>
				</>
			) : (
				<div className="task-empty">
					<p>{file.kind === "binary" ? "二进制文件" : "尚未确认文本格式"}</p>
					<p>可复制路径或另存副本</p>
					<code>{file.path}</code>
				</div>
			)}
			<footer>
				<button type="button" onClick={onClose}>
					关闭
				</button>
			</footer>
		</Container>
	);
}
