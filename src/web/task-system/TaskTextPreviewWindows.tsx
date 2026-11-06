import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskFileView, TaskSystemBridge } from "../../task-system/application-contracts";
import type { AnalysisWindowLease } from "../../modeling/contracts";
import { bootstrapWindowVisuals } from "../window-visual-bootstrap";
import FilePreview from "./FilePreview";

export type OpenTaskPreview = (taskId: string, file: TaskFileView, ended: boolean) => void;
export function taskPreviewIdentity(taskId: string, file: TaskFileView) {
	const source = file.sourceIdentity;
	const actual = file.previewSourceIdentity;
	return JSON.stringify([
		taskId,
		file.artifactId,
		actual?.environmentId ?? "",
		actual?.sourceGeneration ?? source?.generation ?? "",
		actual?.path ?? source?.location ?? file.path,
		actual?.fileId ?? null
	]);
}
interface PreviewWindow {
	key: string;
	taskId: string;
	file: TaskFileView;
	ended: boolean;
	child: Window;
	host: HTMLElement;
	lease: AnalysisWindowLease | null;
	disposeVisuals(): void;
}
/** Lives with the task workspace, independently of its list/detail route. */
export function useTaskTextPreviewWindows(
	bridge: TaskSystemBridge,
	onError: (message: string, taskId?: string) => void
) {
	const [revision, bump] = useState(0),
		windows = useRef(new Map<string, PreviewWindow>()),
		pending = useRef(new Set<string>()),
		alive = useRef(true),
		generation = useRef(0),
		report = useRef(onError);
	report.current = onError;
	const close = useCallback((key: string) => {
		const entry = windows.current.get(key);
		if (!entry) return;
		windows.current.delete(key);
		entry.disposeVisuals();
		if (entry.lease)
			void window.sciyueDesktop
				?.releaseAnalysisWindow?.({ leaseId: entry.lease.leaseId })
				.catch(() => {});
		else if (!entry.child.closed) entry.child.close();
		if (alive.current) bump((value) => value + 1);
	}, []);
	const closeAll = useCallback(() => {
		generation.current++;
		for (const key of windows.current.keys()) close(key);
	}, [close]);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			closeAll();
		};
	}, [closeAll]);
	const open = useCallback<OpenTaskPreview>(
		(taskId, file, ended) => {
			if (file.kind !== "text" || file.exists === false) {
				report.current(file.exists === false ? "文件尚未生成。" : "此文件不提供文本预览。", taskId);
				return;
			}
			const key = taskPreviewIdentity(taskId, file),
				existing = windows.current.get(key);
			if (existing && !existing.child.closed) {
				existing.child.focus();
				return;
			}
			if (pending.current.has(key)) return;
			pending.current.add(key);
			const epoch = generation.current;
			void (async () => {
				let lease: AnalysisWindowLease | null = null,
					child: Window | null = null,
					disposeVisuals: (() => void) | undefined;
				try {
					const title = `${file.name} · 文本预览`,
						instanceId = `task-preview-${crypto.randomUUID()}`;
					lease =
						(await window.sciyueDesktop?.prepareAnalysisWindow?.({
							instanceId,
							title,
							bounds: { width: 1040, height: 760 }
						})) ?? null;
					if (!alive.current || epoch !== generation.current) {
						if (lease)
							await window.sciyueDesktop?.releaseAnalysisWindow?.({ leaseId: lease.leaseId });
						return;
					}
					child = window.open(
						"about:blank",
						lease?.target ?? instanceId,
						lease ? "" : "popup,width=1040,height=760"
					);
					if (!child) throw Error("独立文本预览窗口未能打开。");
					child.document.title = title;
					disposeVisuals = bootstrapWindowVisuals(document, child.document);
					child.document.body.className = "task-preview-window-body";
					const host = child.document.createElement("main");
					host.className = "task-preview-window-host";
					child.document.body.appendChild(host);
					windows.current.set(key, {
						key,
						taskId,
						file,
						ended,
						child,
						host,
						lease,
						disposeVisuals
					});
					child.addEventListener("beforeunload", () => close(key), { once: true });
					bump((value) => value + 1);
					child.focus();
				} catch (error) {
					disposeVisuals?.();
					if (lease)
						void window.sciyueDesktop
							?.releaseAnalysisWindow?.({ leaseId: lease.leaseId })
							.catch(() => {});
					else child?.close();
					report.current(
						`${file.name}：${error instanceof Error ? error.message : String(error)}`,
						taskId
					);
				} finally {
					pending.current.delete(key);
				}
			})();
		},
		[close]
	);
	return {
		closeAll,
		open,
		windows: (
			<>
				{[...windows.current.values()].map((entry) =>
					createPortal(
						<FilePreview
							key={entry.key}
							embedded
							bridge={bridge}
							taskId={entry.taskId}
							file={entry.file}
							initiallyEnded={entry.ended}
							refreshIntervalSeconds={2}
							onClose={() => close(entry.key)}
						/>,
						entry.host,
						`${entry.key}:${revision > 0 ? "open" : ""}`
					)
				)}
			</>
		)
	};
}
