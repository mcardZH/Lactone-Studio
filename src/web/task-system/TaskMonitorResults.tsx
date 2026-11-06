import { useMemo, useState } from "react";
import type { Structure } from "../../core/types";
import { DEFAULT_DISPLAY } from "../../modeling/contracts";
import type { TrajectoryResult } from "../../results/contracts";
import PostprocessResultView from "../results/PostprocessResultView";
import type { RetainedStageBrowse } from "../results/PostprocessResultView";
import PostprocessPlotDeck from "../results/PostprocessPlotDeck";
import type { PostprocessPlotSnapshot } from "../results/PostprocessPresentation";
import { AnalysisCardDeck, type AnalysisPage } from "../results/PostprocessDisplayPanel";
import type { PlaybackContinuationIdentity } from "../results/useOptPlayback";
import WorkspaceTab from "../modeling/WorkspaceTab";
import { X } from "lucide-react";
import { ProjectUiScope, useProjectState, useProjectUiScope } from "../../projects/ui-state";
import { WorkspaceColumnDivider, type useWorkspaceColumns } from "../modeling/WorkspaceColumns";
const MONITOR_PAGES: readonly AnalysisPage[] = ["energy", "trajectory"];
export function taskDefaultAnalysisPage(taskKind: string): AnalysisPage {
	return /opt|optim|scan|irc|neb|md|trajectory|ts/i.test(taskKind) ? "trajectory" : "energy";
}
/** Capability-limited host of the same complete postprocessing presentation. */
export default function TaskMonitorResults(p: {
	title?: string;
	onClose?(): void;
	columns?: ReturnType<typeof useWorkspaceColumns>;
	results: TrajectoryResult[];
	taskKind: string;
	onExtract?(structure: Structure): void;
	onFrame?(structure: Structure | null): void;
	loadingHost?: HTMLElement | null;
	continuity?: Omit<PlaybackContinuationIdentity, "stageId">;
	collectionFixed?: boolean;
	onError(message: string): void;
}) {
	const [selected, setSelected] = useProjectState("task-results.selected", ""),
		[display, setDisplay] = useProjectState("task-results.display", { ...DEFAULT_DISPLAY }),
		[plots, setPlots] = useProjectState<PostprocessPlotSnapshot[]>("task-results.plots", []);
	const [tools, setTools] = useState<HTMLElement | null>(null),
		[toolbar, setToolbar] = useState<HTMLElement | null>(null);
	const result = p.results.find((row) => row.id === selected) ?? p.results[0];
	const scope = useProjectUiScope();
	const legacyStageBrowse = scope?.store.get<RetainedStageBrowse | undefined>(
		JSON.stringify([...scope.scope, "postprocess.stage-browse"]), undefined
	);
	const document = useMemo(
		() => (result ? { id: `task-monitor:${result.id}`, result } : null),
		[result]
	);
	return (
		<div className="task-monitor-results" data-testid="task-monitor-results">
			<main className="task-monitor-model" style={p.columns ? { gridColumn: 3, gridRow: 1 } : undefined}>
				<div className="workspace-tabs-row">
					<div className="workspace-document-tabs" role="tablist" aria-label="当前任务">
						<WorkspaceTab
							active
							label={p.title ?? "任务监控"}
							onActivate={() => {}}
							actions={
								<button aria-label="关闭当前任务观察页" title="返回任务列表" onClick={p.onClose}>
									<X size={12} />
								</button>
							}
						/>
					</div>
				</div>
				<div ref={setToolbar} className="task-monitor-result-toolbar" />
				{p.results.length > 1 && (
					<label className="task-result-source">
						结果阶段
						<select
							aria-label="监控结果阶段"
							value={result?.id ?? ""}
							onChange={(event) => setSelected(event.target.value)}
						>
							{p.results.map((row) => (
								<option key={row.id} value={row.id}>
									{row.label}
								</option>
							))}
						</select>
					</label>
				)}
				{document ? (
					<ProjectUiScope scope={["task-monitor-result", document.result.id]}>
					<PostprocessResultView
						document={document}
						legacyStageBrowse={legacyStageBrowse}
						presentationOwnerId={document.id}
						playbackContinuity={p.continuity}
						collectionFixed={p.collectionFixed===true}
						onObservedFrame={p.onFrame}
						loadingHost={p.loadingHost}
						active
						selected
						toolHost={tools}
						toolbarHost={toolbar}
						allowedPages={MONITOR_PAGES}
						observationOnly
						resumeObservedPlayback
						initialPage={taskDefaultAnalysisPage(p.taskKind)}
						display={display}
						onDisplay={setDisplay}
						onOpenPlot={(plot) => setPlots((previous) => [...previous, plot])}
						onExtract={(structure) => p.onExtract?.(structure)}
						onError={p.onError}
					/>
					</ProjectUiScope>
				) : (
					<div className="task-empty">暂无完整结果</div>
				)}
			</main>
			{p.columns && (
				<WorkspaceColumnDivider side="right" gridRow={1} sizes={p.columns.sizes} onChange={p.columns.update} />
			)}
			<aside
				ref={setTools}
				style={p.columns ? { gridColumn: 5, gridRow: 1 } : undefined}
				className="task-monitor-cards workspace-common-tools"
				aria-label="任务结果卡"
			>
				{!document && (
					<>
						<AnalysisCardDeck allowedPages={MONITOR_PAGES} disabled onSelect={() => {}} />
						<p className="postprocess-note">暂无完整结果</p>
					</>
				)}
			</aside>
			{plots.length > 0 && (
				<PostprocessPlotDeck
					snapshots={plots}
					onClose={(id) => setPlots((previous) => previous.filter((plot) => plot.id !== id))}
				/>
			)}
		</div>
	);
}
