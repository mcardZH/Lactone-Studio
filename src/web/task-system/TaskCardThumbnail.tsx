import { memo, useEffect, useMemo, useState } from "react";
import type { TaskCardView } from "../../task-system/application-contracts";
import type { Structure } from "../../core/types";
import { DEFAULT_DISPLAY } from "../../modeling/contracts";
import { applyViewBondSnapshot, prepareViewBondSnapshot } from "../../results/view-bonds";
import { createRenderAdapter } from "../modeling/render/adapter";
import { monitorDocument } from "./ReadOnlyTaskModel";

// Cards retain PNGs, never a WebGL context or source reader per task.
interface ThumbnailJob {
	promise: Promise<string>;
	controller: AbortController;
	leases: number;
	complete: boolean;
}
const images = new Map<string, ThumbnailJob>();
let queue: Promise<unknown> = Promise.resolve();
export function taskThumbnailKey(task: TaskCardView, structure: Structure): string {
	return JSON.stringify([
		task.taskId,
		task.runId,
		task.thumbnailSourceVersion ?? task.sourceSummary?.sourceVersion,
		structure.atoms.map((atom) => [atom.id, atom.element, atom.x, atom.y, atom.z]),
		structure.bonds,
		structure.cell
	]);
}
function thumbnail(key: string, structure: Structure) {
	const existing = images.get(key);
	if (existing && !existing.controller.signal.aborted) {
		existing.leases++;
		return { promise: existing.promise, release: () => release(existing) };
	}
	const entry: ThumbnailJob = {
		promise: Promise.resolve(""),
		controller: new AbortController(),
		leases: 1,
		complete: false
	};
	const signal = entry.controller.signal;
	const job = queue
		.catch(() => {})
		.then(async () => {
			if (signal.aborted) throw new DOMException("预览已释放", "AbortError");
			const snapshot = await prepareViewBondSnapshot(structure, 0, signal);
			const resolved = applyViewBondSnapshot(snapshot, structure);
			if (resolved.source === "unavailable") throw new Error(resolved.message);
			const host = document.createElement("div");
			Object.assign(host.style, {
				position: "fixed",
				left: "-10000px",
				top: "0",
				width: "240px",
				height: "240px",
				pointerEvents: "none"
			});
			document.body.appendChild(host);
			let adapter: Awaited<ReturnType<typeof createRenderAdapter>> | undefined;
			try {
				adapter = await createRenderAdapter(host, { orthographic: true });
				if (signal.aborted) throw new DOMException("预览已释放", "AbortError");
				if (!resolved.structure.bonds) throw new Error("显示连接准备未完成");
				const model = monitorDocument({
					sourceKey: key,
					frameId: key,
					atoms: resolved.structure.atoms.map((atom, index) => ({
						...atom,
						id: atom.id ?? `thumbnail-atom-${index}`
					})),
					bonds: resolved.structure.bonds,
					cell: resolved.structure.cell
				});
				const display = {
					...DEFAULT_DISPLAY,
					representation: "ball-stick" as const,
					atomNumbers: false,
					elementLabels: false,
					cell: false,
					legend: false
				};
				if (adapter.drawAsync)
					await adapter.drawAsync(
						model,
						display,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						signal
					);
				else adapter.draw(model, display);
				adapter.resetView();
				const canvas = host.querySelector("canvas");
				if (!canvas?.width || !canvas.height) throw new Error("缩略图尚未渲染");
				const output = document.createElement("canvas");
				output.width = canvas.width;
				output.height = canvas.height;
				const context = output.getContext("2d");
				if (!context) throw new Error("无法读取预览图片");
				// Fit actual visible balls as well as atom centres, including a lone atom.
				for (let pass = 0; pass < 4; pass++) {
					context.drawImage(canvas, 0, 0);
					const pixels = context.getImageData(0, 0, output.width, output.height).data;
					let left = output.width,
						right = -1,
						top = output.height,
						bottom = -1;
					for (let y = 0; y < output.height; y++)
						for (let x = 0; x < output.width; x++) {
							const i = (y * output.width + x) * 4;
							if (
								Math.max(
									Math.abs(pixels[i] - pixels[0]),
									Math.abs(pixels[i + 1] - pixels[1]),
									Math.abs(pixels[i + 2] - pixels[2])
								) > 10
							) {
								left = Math.min(left, x);
								right = Math.max(right, x);
								top = Math.min(top, y);
								bottom = Math.max(bottom, y);
							}
						}
					const extent = Math.max(right - left + 1, bottom - top + 1);
					if (extent <= 0) throw new Error("预览未包含可见结构");
					const factor = (0.85 * Math.min(output.width, output.height)) / extent;
					if (pass === 3 || Math.abs(factor - 1) < 0.02) break;
					adapter.zoom(-Math.log(factor) / 0.0015);
				}
				return output.toDataURL("image/png");
			} finally {
				adapter?.dispose();
				host.remove();
			}
		});
	entry.promise = job;
	queue = job;
	images.set(key, entry);
	void job.then(
		() => {
			entry.complete = true;
			trim();
		},
		() => {
			if (images.get(key) === entry) images.delete(key);
		}
	);
	return { promise: job, release: () => release(entry) };
}
function release(entry: ThumbnailJob) {
	entry.leases = Math.max(0, entry.leases - 1);
	if (!entry.leases && !entry.complete) entry.controller.abort();
}
function trim() {
	for (const [key, entry] of images) {
		if (images.size <= 150) break;
		if (entry.complete && !entry.leases) images.delete(key);
	}
}
export default memo(function TaskCardThumbnail({ task }: { task: TaskCardView }) {
	const structure = task.thumbnailStructure ?? task.sourceSummary?.structure;
	const key = useMemo(
		() => (structure?.atoms.length ? taskThumbnailKey(task, structure) : ""),
		[
			task.taskId,
			task.runId,
			task.thumbnailSourceVersion,
			task.sourceSummary?.sourceVersion,
			structure
		]
	);
	const [image, setImage] = useState<{ key: string; url: string } | null>(null),
		[failed, setFailed] = useState("");
	useEffect(() => {
		if (!structure || !key) return;
		let active = true;
		setFailed("");
		const lease = thumbnail(key, structure);
		void lease.promise.then(
			(url) => {
				if (active) setImage({ key, url });
			},
			() => {
				if (active) setFailed("结构预览准备失败");
			}
		);
		return () => {
			active = false;
			lease.release();
		};
	}, [key]);
	const url = image?.key === key ? image.url : !structure ? task.thumbnail?.dataUrl : undefined;
	return url ? (
		<img className="task-card-thumbnail" src={url} alt="任务最新完整结构的球棍图" />
	) : (
		<div
			className="task-card-thumbnail task-thumbnail-empty"
			role="status"
			aria-label={failed || (key ? "正在准备结构缩略图" : "暂无结构缩略图")}
		>
			{failed ? "预览不可用" : key ? "准备中…" : "暂无结构"}
		</div>
	);
});
