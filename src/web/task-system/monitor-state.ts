import type { MonitorGeometry, TaskMonitorFramePage, TaskMonitorView, TaskSystemBridge } from "../../task-system/application-contracts";
export interface MonitorFrames {
	collectionId: string | null;
	revision: string | null;
	frames: MonitorGeometry[];
	ready: boolean;
}
export const EMPTY_MONITOR_FRAMES: MonitorFrames = {
	collectionId: null,
	revision: null,
	frames: [],
	ready: false
};
export class MonitorRevisionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MonitorRevisionError";
	}
}
export async function hydrateMonitorFrames(
	bridge: TaskSystemBridge,
	view: TaskMonitorView,
	signal: AbortSignal,
	progress: (completed: number, total: number) => void
): Promise<TaskMonitorView> {
	const { framePage, collectionId, revision } = view;
	if (!framePage) return view;
	const { taskId } = view.task;
	const { token, count } = framePage;
	if (!collectionId || !revision || !token || !Number.isSafeInteger(count) || count < 1 ||
		count > view.frameCount || view.reset && count !== view.frameCount || view.framesDelta.length)
		throw new MonitorRevisionError("监控分页清单无效");
	const framesDelta: TaskMonitorView["framesDelta"] = [];
	progress(0, count);
	for (let offset = 0; offset < count;) {
		signal.throwIfAborted();
		const page: TaskMonitorFramePage = await bridge.request("monitor.frames", { taskId, collectionId, revision, token, offset }, { signal });
		signal.throwIfAborted();
		if (page.taskId !== taskId || page.collectionId !== collectionId || page.revision !== revision ||
			page.token !== token || page.count !== count || page.offset !== offset ||
			!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > count ||
			page.framesDelta.length !== page.nextOffset - offset)
			throw new MonitorRevisionError("监控分页回执与当前来源不一致");
		for (const item of page.framesDelta) framesDelta.push(item);
		offset = page.nextOffset;
		progress(offset, count);
	}
	return { ...view, framesDelta, framePage: undefined };
}
/** Identity-checked immutable merging. Never mutates an already published prefix. */
export function mergeMonitorFrames(
	previous: MonitorFrames,
	update: Pick<
		TaskMonitorView,
		| "collectionId"
		| "revision"
		| "baseRevision"
		| "frameCount"
		| "framesDelta"
		| "reset"
		| "prepared"
	>
): MonitorFrames {
	if (!Number.isSafeInteger(update.frameCount) || update.frameCount < 0)
		throw new MonitorRevisionError("监控帧总数无效");
	if (update.frameCount && (!update.collectionId || !update.revision))
		throw new MonitorRevisionError("监控集合身份缺失");
	if (
		!update.reset &&
		(update.collectionId !== previous.collectionId || update.baseRevision !== previous.revision)
	)
		throw new MonitorRevisionError("监控版本已变化，需要重新准备完整集合");
	if (!update.reset && update.frameCount < previous.frames.length)
		throw new MonitorRevisionError("监控集合缩短必须重新准备");
	if (!update.reset && update.revision === previous.revision && update.framesDelta.length)
		throw new MonitorRevisionError("监控版本未变化却包含坐标改动");
	if (
		!update.reset &&
		update.framesDelta.length === 0 &&
		update.frameCount === previous.frames.length
	)
		return { ...previous, revision: update.revision, ready: update.prepared };
	const frames = update.reset
		? new Array<MonitorGeometry>(update.frameCount)
		: previous.frames.slice();
	frames.length = update.frameCount;
	const indices = new Set<number>();
	for (const item of update.framesDelta) {
		if (
			!Number.isSafeInteger(item.index) ||
			item.index < 0 ||
			item.index >= update.frameCount ||
			indices.has(item.index)
		)
			throw new MonitorRevisionError("监控增量帧索引无效或重复");
		if (!item.frame.frameId || !item.frame.sourceKey || !item.frame.atoms.length)
			throw new MonitorRevisionError("监控增量包含不完整结构");
		indices.add(item.index);
		frames[item.index] = item.frame;
	}
	// Array.every skips sparse holes; check every promised index explicitly.
	for (let index = 0; index < update.frameCount; index++)
		if (!frames[index]) throw new MonitorRevisionError("监控批次尚未完整准备，不能开放连续播放");
	return {
		collectionId: update.collectionId,
		revision: update.revision,
		frames,
		ready: update.prepared
	};
}
