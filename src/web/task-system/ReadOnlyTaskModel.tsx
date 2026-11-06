import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { MonitorGeometry } from "../../task-system/application-contracts";
import type { Structure, PeriodicCell } from "../../core/types";
import {
	DEFAULT_DISPLAY,
	type DisplaySettings,
	type ModelDocument
} from "../../modeling/contracts";
import { createRenderAdapter, type RenderAdapter } from "../modeling/render/adapter";
import { DismissibleNotice } from "../DismissibleNotice";
import { errorMessage } from "./presentation";
/** Exact supplied connectivity only. This adapter has no Store or scientific capabilities. */
export function monitorStructure(frame: MonitorGeometry): Structure {
	const cell = frame.cell;
	if (
		cell &&
		(cell.vectors.length !== 3 ||
			cell.vectors.some((v) => v.length !== 3 || !v.every(Number.isFinite)) ||
			cell.pbc.length !== 3 ||
			cell.pbc.some((value) => typeof value !== "boolean"))
	)
		throw Error("来源晶胞不完整");
	return {
		id: frame.sourceKey,
		name: "任务只读结构",
		format: "task-monitor",
		atoms: frame.atoms,
		bonds: frame.bonds,
		charge: null,
		multiplicity: null,
		notes: [],
		...(cell ? { cell: structuredClone(cell) as PeriodicCell } : {})
	};
}
/** Adapts an exact read snapshot to the shared renderer without fragment-library size policy. */
export function monitorDocument(frame: MonitorGeometry, revision = 0): ModelDocument {
	const structure = structuredClone(monitorStructure(frame)),
		ids = structure.atoms.map((atom) => atom.id);
	if (
		!ids.length ||
		ids.some((id) => !id) ||
		new Set(ids).size !== ids.length ||
		structure.atoms.some((atom) => ![atom.x, atom.y, atom.z].every(Number.isFinite))
	)
		throw Error("任务结构缺少稳定原子身份或完整坐标");
	if (
		(structure.bonds ?? []).some(
			(bond) =>
				![bond.a, bond.b].every(
					(index) => Number.isSafeInteger(index) && index >= 0 && index < ids.length
				) || !Number.isFinite(bond.order)
		)
	)
		throw Error("来源连接信息无效");
	const assignments = { layers: [], basis: [], fragments: [], frozenAtomIds: [] };
	return {
		id: `task-monitor:${frame.sourceKey}`,
		revision,
		draft: {
			structure,
			assignments,
			revision,
			selectedIds: [],
			touchedIds: [],
			assignmentIssues: [],
			createdFrom: {},
			past: [],
			future: [],
			dirty: false,
			baseAtomIds: ids as string[],
			baseStructure: structuredClone(structure),
			baseAssignments: structuredClone(assignments)
		},
		selection: { atomIds: [], bonds: [], auxiliaryIds: [], portIds: [] },
		auxiliaryRelations: [],
		deletedBonds: [],
		attachmentPorts: [],
		canUndo: false,
		canRedo: false
	};
}
export default function ReadOnlyTaskModel({ frame }: { frame: MonitorGeometry }) {
	const canvas = useRef<HTMLDivElement>(null),
		surface = useRef<HTMLDivElement>(null),
		adapter = useRef<RenderAdapter | null>(null),
		revision = useRef(0),
		drawAbort = useRef<AbortController | null>(null),
		[ready, setReady] = useState(false),
		[error, setError] = useState(""),
		[representation, setRepresentation] = useState<DisplaySettings["representation"]>(
			DEFAULT_DISPLAY.representation
		),
		[labels, setLabels] = useState(false);
	const drag = useRef<{ id: number; x: number; y: number; view: number[] } | null>(null),
		fitted = useRef("");
	const model = useMemo(() => {
		try {
			const document = monitorDocument(frame, ++revision.current);
			return { document, error: "" };
		} catch (e) {
			return { document: null, error: errorMessage(e) };
		}
	}, [frame]);
	const display = useMemo(
		() => ({
			...DEFAULT_DISPLAY,
			representation,
			atomNumbers: labels,
			cell: Boolean(frame.cell),
			alignment: "off" as const,
			legend: false
		}),
		[representation, labels, Boolean(frame.cell)]
	);
	useEffect(() => {
		const node = canvas.current!;
		let disposed = false;
		let observer: ResizeObserver | undefined;
		void createRenderAdapter(node, { orthographic: true })
			.then((instance) => {
				if (disposed) {
					instance.dispose();
					return;
				}
				adapter.current = instance;
				observer = new ResizeObserver(() => instance.resize());
				observer.observe(node);
				setReady(true);
			})
			.catch((e) => {
				if (!disposed) setError(errorMessage(e));
			});
		return () => {
			disposed = true;
			drawAbort.current?.abort();
			observer?.disconnect();
			if (drag.current && surface.current?.hasPointerCapture(drag.current.id))
				surface.current.releasePointerCapture(drag.current.id);
			drag.current = null;
			adapter.current?.dispose();
			adapter.current = null;
		};
	}, []);
	useEffect(() => {
		const instance = adapter.current;
		if (!ready || !instance || !model.document) return;
		const own = new AbortController();
		drawAbort.current?.abort();
		drawAbort.current = own;
		const previous = fitted.current ? instance.getView() : null;
		const isCurrent = () =>
			!own.signal.aborted && adapter.current === instance && drawAbort.current === own;
		const complete = () => {
			if (!isCurrent()) return;
			if (previous) instance.setView(previous);
			else {
				instance.resetView();
				fitted.current = frame.sourceKey;
			}
		};
		try {
			if (instance.drawAsync)
				void instance
					.drawAsync(
						model.document,
						display,
						undefined,
						undefined,
						undefined,
						undefined,
						{ isCurrent },
						own.signal
					)
					.then(complete, (e) => {
						if (!own.signal.aborted) setError(errorMessage(e));
					});
			else {
				instance.draw(model.document, display);
				complete();
			}
		} catch (e) {
			if (!own.signal.aborted) setError(errorMessage(e));
		}
		return () => own.abort();
	}, [ready, model, display, frame.sourceKey]);
	useEffect(() => {
		const target = surface.current!;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			adapter.current?.zoom(event.deltaY);
		};
		target.addEventListener("wheel", wheel, { passive: false });
		return () => target.removeEventListener("wheel", wheel);
	}, []);
	function release(event: PointerEvent<HTMLDivElement>) {
		if (drag.current?.id !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		drag.current = null;
	}
	return (
		<section className="task-readonly-model" aria-label="只读分子视图">
			<div className="task-actions">
				<label>
					显示风格
					<select
						value={representation}
						onChange={(event) =>
							setRepresentation(event.target.value as DisplaySettings["representation"])
						}
					>
						<option value="ball-stick">球棍</option>
						<option value="stick">棍状</option>
						<option value="vdw">空间填充</option>
					</select>
				</label>
				<label>
					<input
						type="checkbox"
						checked={labels}
						onChange={(event) => setLabels(event.target.checked)}
					/>
					原子序号
				</label>
				<button type="button" onClick={() => adapter.current?.resetView()}>
					重置视角
				</button>
			</div>
			{(model.error || error) && <DismissibleNotice>{model.error || error}</DismissibleNotice>}
			<div className="task-model-stage">
				<div className="task-model-canvas" ref={canvas} />
				<div
					className="task-model-surface"
					ref={surface}
					tabIndex={0}
					aria-label="旋转缩放只读结构"
					onPointerDown={(event) => {
						if (event.button !== 0 || !adapter.current) return;
						event.preventDefault();
						drag.current = {
							id: event.pointerId,
							x: event.clientX,
							y: event.clientY,
							view: adapter.current.getView()
						};
						event.currentTarget.setPointerCapture(event.pointerId);
					}}
					onPointerMove={(event) => {
						const own = drag.current;
						if (own?.id === event.pointerId)
							adapter.current?.camera(
								own.view,
								event.clientX - own.x,
								event.clientY - own.y,
								"rotate"
							);
					}}
					onPointerUp={release}
					onPointerCancel={release}
					onLostPointerCapture={() => {
						drag.current = null;
					}}
					onKeyDown={(event) => {
						if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
							event.preventDefault();
							adapter.current?.step(
								(
									{
										ArrowLeft: "left",
										ArrowRight: "right",
										ArrowUp: "up",
										ArrowDown: "down"
									} as const
								)[event.key as "ArrowLeft"]
							);
						} else if (["+", "=", "-"].includes(event.key)) {
							event.preventDefault();
							adapter.current?.zoom(event.key === "-" ? 80 : -80);
						}
					}}
				/>
			</div>
		</section>
	);
}
