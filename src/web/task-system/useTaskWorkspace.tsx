import { useCallback, useEffect, useRef, useState } from "react";
import type {
	SubmitTaskInput,
	SubmitTaskRequest,
	TaskLibraryView
} from "../../task-system/application-contracts";
import type { ExternalInputDraft } from "../../task-system/integration/input-draft";
import { createTaskSystemBridge } from "../../task-system/integration/desktop-bridge";
import { stageExternalInput } from "../../task-system/integration/stage-input";
import TaskCenter from "./TaskCenter";
import SubmitTaskDialog from "./SubmitTaskDialog";
import { useTaskTextPreviewWindows } from "./TaskTextPreviewWindows";
import type { Structure } from "../../core/types";
import { useTaskErrorScope } from "./task-error-scope";
import { TaskMonitorWorkspaceCache } from "./monitor-workspace-cache";
import { retainSnapshotMonitorResults } from "./snapshot-monitor-reuse";
import type { SnapshotProjectSources } from "../../task-system/integration/snapshot-project";
import type { ScientificSourceFile } from "../../results/input-file";
import { TaskLibraryEntry } from "./TaskLibrarySettings";
import DialogShell from "../DialogShell";

/** Window navigation only. Task lifetime belongs to the independent host. */
export function useTaskWorkspace(ports: {
	identity(): string;
	projectId(): string | null;
	openSnapshot(
		taskId: string,
		snapshotId: string,
		leaseId: string,
		canNavigate: () => boolean
	): Promise<void>;
	extractStructure?(structure: Structure): void;
	onError(message: string): void;
}) {
	const [bridge] = useState(() => createTaskSystemBridge());
	const [opened, setOpened] = useState(false),
		[initialTask, setInitialTask] = useState<string>(),
		[input, setInput] = useState<SubmitTaskInput | null>(null),
		[initialRequest, setInitialRequest] = useState<SubmitTaskRequest>(),
		[libraryEntry, setLibraryEntry] = useState<TaskLibraryView | null>(null);
	const pendingDraft = useRef<{
		draft: ExternalInputDraft;
		identity: string;
		epoch: number;
	} | null>(null);
	const [operationIds, setOperationIds] = useState<string[]>([]);
	const [monitorCache] = useState(() => new TaskMonitorWorkspaceCache());
	const openedRef = useRef(false),
		isOpen = useCallback(() => openedRef.current, []);
	const current = useRef(ports);
	current.current = ports;
	const previewErrors = useTaskErrorScope("task-preview-windows");
	const [previewErrorTask, setPreviewErrorTask] = useState<string>();
	const previews = useTaskTextPreviewWindows(bridge, (message, taskId) => {
		setPreviewErrorTask(taskId);
		if (openedRef.current) previewErrors.attempt("open")(message);
		else current.current.onError(message);
	});
	const revision = useRef(0),
		preparing = useRef<AbortController | null>(null),
		alive = useRef(true),
		stagingEntry = useRef<string | null>(null);
	const releaseEntry = useCallback(() => {
		const entryId = stagingEntry.current;
		stagingEntry.current = null;
		if (entryId) void bridge.request("center.leave", { entryId }).catch(() => {});
	}, [bridge]);
	useEffect(() => {
		alive.current = true;
		return () => {
			monitorCache.clear();
			alive.current = false;
			revision.current++;
			preparing.current?.abort();
			releaseEntry();
		};
	}, [releaseEntry]);
	const closeSubmission = useCallback(() => {
		revision.current++;
		preparing.current?.abort();
		preparing.current = null;
		setInput(null);
		setInitialRequest(undefined);
		setLibraryEntry(null);
		pendingDraft.current = null;
		releaseEntry();
	}, [releaseEntry]);
	const leave = useCallback(() => {
		closeSubmission();
		openedRef.current = false;
		setOpened(false);
	}, [closeSubmission]);
	const open = useCallback(() => {
		closeSubmission();
		setInitialTask(undefined);
		openedRef.current = true;
		setOpened(true);
	}, [closeSubmission]);
	const openTask = useCallback(
		(taskId: string) => {
			closeSubmission();
			setInitialTask(taskId);
			openedRef.current = true;
			setOpened(true);
		},
		[closeSubmission]
	);
	const submit = useCallback(
		async (draft: ExternalInputDraft) => {
			closeSubmission();
			const epoch = revision.current,
				identity = current.current.identity(),
				controller = new AbortController();
			preparing.current = controller;
			const entryId = `input-preparation-${crypto.randomUUID()}`;
			stagingEntry.current = entryId;
			const valid = () =>
				alive.current &&
				!controller.signal.aborted &&
				revision.current === epoch &&
				current.current.identity() === identity;
			try {
				let center = await bridge.request("center.enter", { entryId });
				if (!valid()) return;
				if (!center.library.libraryId || center.manager.access === "unavailable") {
					pendingDraft.current = { draft, identity, epoch };
					setLibraryEntry(center.library);
					preparing.current = null;
					return;
				}
				if (!valid()) return;
				if (center.manager.access !== "manager")
					throw new Error("当前任务库由其他窗口管理，请取得管理权后提交。");
				const prepared = await stageExternalInput(
					draft,
					bridge,
					current.current.projectId(),
					controller.signal
				);
				if (!valid()) {
					await bridge.request("submission.release-dependencies", {
						sourceRefs: prepared.dependencies.map((row) => row.sourceRef)
					});
					return;
				}
				preparing.current = null;
				setInput(prepared);
			} catch (error) {
				if (stagingEntry.current === entryId) releaseEntry();
				throw error;
			} finally {
				if (!valid()) await bridge.request("center.leave", { entryId }).catch(() => {});
			}
		},
		[bridge, closeSubmission, releaseEntry]
	);
	const openSnapshot = useCallback(
		(taskId: string, snapshotId: string, leaseId: string, canNavigate?: () => boolean) => {
			const epoch = revision.current;
			return current.current.openSnapshot(
				taskId,
				snapshotId,
				leaseId,
				() =>
					alive.current &&
					document.hasFocus() &&
					revision.current === epoch &&
					canNavigate?.() !== false
			);
		},
		[]
	);
	return {
		bridge,
		opened,
		isOpen,
		open,
		openTask,
		leave,
		submit,
		retainSnapshotResults: (bundle: SnapshotProjectSources, file: ScientificSourceFile) =>
			retainSnapshotMonitorResults(monitorCache, bundle, file),
		center: (
			<>
				{opened ? (
					<TaskCenter
						onLibraryChanged={() => {
							previewErrors.clear();
							previews.closeAll();
							setOperationIds([]);
						}}
						workspaceCache={monitorCache}
						previewNotice={
							previewErrors.notice
								? { ...previewErrors.notice, taskId: previewErrorTask }
								: undefined
						}
						onDismissPreview={previewErrors.dismiss}
						bridge={bridge}
						initialTaskId={initialTask}
						operationIds={operationIds}
						onOperationStarted={(id) =>
							setOperationIds((prior) => (prior.includes(id) ? prior : [...prior, id]))
						}
						onClose={leave}
						onOpenSnapshot={openSnapshot}
						onPreview={previews.open}
						onExtract={
							ports.extractStructure
								? (structure) => {
										leave();
										current.current.extractStructure?.(structure);
									}
								: undefined
						}
						onResubmit={(taskId) => {
							const own = ++revision.current;
							void bridge
								.request("submission.resubmit-draft", { taskId })
								.then((request) => {
									if (!alive.current || revision.current !== own || !openedRef.current) return;
									setInitialRequest(request);
									setInput(request.input);
								})
								.catch((error) =>
									current.current.onError(error instanceof Error ? error.message : String(error))
								);
						}}
					/>
				) : null}
				{previews.windows}
			</>
		),
		dialog: libraryEntry ? (
			<DialogShell className="task-dialog" aria-label="提交前设置任务库" onCancel={closeSubmission}>
				<button type="button" aria-label="关闭任务库引导" onClick={closeSubmission}>
					×
				</button>
				<TaskLibraryEntry
					bridge={bridge}
					library={libraryEntry}
					onChanged={async () => {
						const saved = pendingDraft.current;
						if (
							!saved ||
							!alive.current ||
							saved.epoch !== revision.current ||
							current.current.identity() !== saved.identity
						) {
							closeSubmission();
							return;
						}
						const center = await bridge.request("center.read", {});
						if (!center.library.libraryId || center.manager.access === "unavailable") {
							setLibraryEntry(center.library);
							return;
						}
						await submit(saved.draft);
					}}
				/>
			</DialogShell>
		) : input ? (
			<SubmitTaskDialog
				key={revision.current}
				bridge={bridge}
				input={input}
				initialRequest={initialRequest}
				onClose={closeSubmission}
				onSubmitted={(result) => {
					if (document.hasFocus()) {
						setInitialTask(result.taskId);
						openedRef.current = true;
						setOpened(true);
					}
					setInput(null);
					releaseEntry();
				}}
			/>
		) : null
	};
}
