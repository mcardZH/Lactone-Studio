import type { TaskMonitorView } from "../../task-system/application-contracts";
import { createMonitorResults } from "../../task-system/reading/monitor-results";
import type { TrajectoryResult } from "../../results/contracts";
import {
	registerPreparedTrajectoryFrameIdentities,
	inheritPreparedTrajectoryPrefix,
	preparedFrameMetadata,
	type PreparedTrajectoryView
} from "../../results/prepared-trajectory";
import { prepareTrajectoryView } from "../results/usePreparedTrajectory";
import type { MonitorFrames } from "./monitor-state";

export interface TaskMonitorPublication {
	key: string;
	taskId: string;
	view: TaskMonitorView;
	frames: MonitorFrames;
	results: TrajectoryResult[];
	/** A batch owner, separate from the mounted viewport/playback consumer. */
	prepared: PreparedTrajectoryView[];
	references: number;
	lastUsed: number;
	retired: boolean;
}
/** One center-session cache. Active consumers are pinned; only two inactive
 * publications remain warm. Closing the center retires, then releases owners. */
export class TaskMonitorWorkspaceCache {
	/** Window-session presentation only. Never serialized as scientific assets. */
	readonly presentation = new Map<string, unknown>();
	readPresentation<T>(key: string): T | undefined {
		return this.presentation.get(key) as T | undefined;
	}
	writePresentation<T>(key: string, value: T) {
		this.presentation.set(key, value);
	}
	private entries = new Map<string, TaskMonitorPublication>();
	private serial = 0;
	constructor(
		private readonly idleLimit = 2,
		private readonly prepareResult: (
			result: TrajectoryResult
		) => PreparedTrajectoryView = prepareTrajectoryView
	) {}
	latest(taskId: string) {
		return [...this.entries.values()]
			.filter((entry) => entry.taskId === taskId && !entry.retired)
			.sort((a, b) => b.lastUsed - a.lastUsed)[0];
	}
	publish(
		taskId: string,
		view: TaskMonitorView,
		frames: MonitorFrames
	): TaskMonitorPublication | null {
		if (!view.collectionId || !view.revision) return null;
		const key = JSON.stringify([taskId, view.collectionId, view.revision]);
		const existing = this.entries.get(key);
		if (existing && !existing.retired) {
			existing.view = view;
			existing.frames = frames;
			existing.lastUsed = ++this.serial;
			return existing;
		}
		if (existing) {
			this.entries.delete(key);
			existing.key = `${key}:retired:${++this.serial}`;
			this.entries.set(existing.key, existing);
		}
		const results = createMonitorResults(view, frames.frames),
			prepared: PreparedTrajectoryView[] = [];
		const previous = this.latest(taskId),
			append =
				previous &&
				!view.reset &&
				view.baseRevision === previous.view.revision &&
				view.collectionId === previous.view.collectionId &&
				view.task.runId === previous.view.task.runId &&
				typeof view.sourceGeneration === "number" &&
				view.sourceGeneration === previous.view.sourceGeneration &&
				view.sourceBoundary &&
				previous.view.sourceBoundary &&
				view.sourceBoundary.publishedByteRange.start ===
					previous.view.sourceBoundary.publishedByteRange.start &&
				view.sourceBoundary.publishedByteRange.end >=
					previous.view.sourceBoundary.publishedByteRange.end;
		try {
			for (let index = 0; index < results.length; index++) {
				const result = results[index],
					metadata = view.results![index];
				registerPreparedTrajectoryFrameIdentities(
					result,
					metadata.geometryIndices.map((index) => frames.frames[index]),
					(frame) => ({
						...preparedFrameMetadata(result.initialStructure),
						id: frame.raw.id,
						name: frame.raw.name
					})
				);
				const next = this.prepareResult(result);
				prepared.push(next);
				if (append) {
					const prior = previous.results.findIndex(
						(value) => value.id === result.id && value.jobIndex === result.jobIndex
					);
					if (prior >= 0) inheritPreparedTrajectoryPrefix(previous.prepared[prior], next);
				}
			}
		} catch (error) {
			for (const owner of prepared) owner.release();
			for (const result of results) void result.dispose();
			throw error;
		}
		const entry: TaskMonitorPublication = {
			key,
			taskId,
			view,
			frames,
			results,
			prepared,
			references: 0,
			lastUsed: ++this.serial,
			retired: false
		};
		this.entries.set(key, entry);
		// Effect replay can retain the just-published owner before idle collection.
		queueMicrotask(() => this.trim());
		return entry;
	}
	retain(entry: TaskMonitorPublication) {
		entry.references++;
		entry.lastUsed = ++this.serial;
		return () => {
			entry.references = Math.max(0, entry.references - 1);
			queueMicrotask(() => this.trim());
		};
	}
	clear() {
		this.presentation.clear();
		for (const entry of this.entries.values()) entry.retired = true;
		queueMicrotask(() => this.trim());
	}
	private trim() {
		const idle = [...this.entries.values()]
			.filter((entry) => entry.references === 0)
			.sort((a, b) => b.lastUsed - a.lastUsed);
		let kept = 0;
		for (const entry of idle) {
			if (!entry.retired && kept++ < this.idleLimit) continue;
			this.entries.delete(entry.key);
			for (const prepared of entry.prepared) prepared.release();
			for (const result of entry.results) void result.dispose();
		}
	}
}
