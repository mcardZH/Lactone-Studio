import { useEffect, useMemo, useRef, useState } from "react";
import type { PeriodicCell, Structure, Vector3 } from "../../core/types";
import {
	cartesianToFractional,
	cellInverse,
	cellParameters,
	cross3,
	dot3,
	fractionalToCartesian,
	norm3
} from "../../core/periodic";
import { resolveFinitePeriodicFragments } from "../../core/modeling/periodic-modeling";
import { ScientificDataTable } from "../results/ScientificDataTable";
import NumericInput from "../NumericInput";
import CellEditorPanel, { type CellEditorViewportDraft, type CellEditorPanelState } from "./CellEditorPanel";
import { candidateSlabGuides } from './slab-preview-presentation';
import type { StructureTransformEdit } from "../../core/modeling/structure-transform";
import type { StructureTransformCandidate } from "../../core/modeling/contracts";
import type {
	CrystalInspectOperation,
	CrystalParameters,
	CrystalResult,
	CrystalTransformOperation
} from "../../modeling/crystal-contracts";
import {
	parseTransformNumber as number,
	parseTransformVector as vector,
	TransformVectorFields,
	TransformPreviewFooter,
	TransformToolSurface,
	useStructureTransformPreview,
	type StructureTransformPanelProps
} from "./structure-transform-panel";

export type PeriodicModelingRequest =
	| StructureTransformEdit
	| { type: "crystal"; operation: CrystalTransformOperation; parameters: CrystalParameters };
export type PeriodicInspectRequest = {
	operation: CrystalInspectOperation;
	parameters: CrystalParameters;
};
export type PeriodicModelingTask =
	"cell-editor" | "supercell" | "symmetry" | "slab" | "wrap" | "finite-cluster" | "axes";
export const periodicModelingTasks: { id: PeriodicModelingTask; title: string }[] = [
	{ id: "cell-editor", title: "赋予/编辑晶胞" },
	{ id: "supercell", title: "扩晶胞" },
	{ id: "symmetry", title: "对称性" },
	{ id: "slab", title: "切面与真空" },
	{ id: "finite-cluster", title: "跨胞片段整理" },
	{ id: "axes", title: "晶胞轴重排" }
];
export interface PeriodicModelingPanelProps extends StructureTransformPanelProps<PeriodicModelingRequest> {
	draft?: PeriodicModelingDraft;
	onDraftChange?(draft: PeriodicModelingDraft): void;
	onCommitEdit?(candidate: StructureTransformCandidate): void | Promise<void>;
	onSaveCheckpoint?(): void;
	onRestoreCheckpoint?(): void;
	cellEditorDraft?: CellEditorPanelState;
	onCellEditorDraftChange?(draft: CellEditorPanelState): void;
	operation?: PeriodicModelingTask;
	onOperationChange?(operation: PeriodicModelingTask): void;
	onInspect(request: PeriodicInspectRequest): CrystalResult | Promise<CrystalResult>;
	previewResult?: CrystalResult | null;
	onAtomHighlightChange?(atomIds: string[]): void;
	onCellEditorChange?(draft: CellEditorViewportDraft | null): void;
}
export interface PeriodicModelingDraft {
	tab: PeriodicModelingTask;
	symprec: string;
	angleTolerance: string;
	symmetryOperation: "primitive" | "conventional" | "p1" | "idealize";
	repeat: string;
	miller: string;
	start: string;
	thickness: string;
	thicknessMode: "angstrom" | "fractional";
	slabVacuum: string;
	inplane: string;
	center: boolean;
	position: string;
	keepCell: boolean;
	axes: string;
	signs: string;
}
export function initialPeriodicModelingDraft(_structure: Structure): PeriodicModelingDraft {
	return {
		tab: "supercell",
		symprec: "0.01",
		angleTolerance: "auto",
		symmetryOperation: "primitive",
		repeat: "1 1 1",
		miller: "0 0 1",
		start: "0",
		thickness: "1",
		thicknessMode: "fractional",
		slabVacuum: "15",
		inplane: "1 1",
		center: true,
		position: "5",
		keepCell: false,
		axes: "1 2 3",
		signs: "1 1 1"
	};
}
export function periodicSymmetryParameters(draft: PeriodicModelingDraft): CrystalParameters {
	const angleTolerance =
		draft.angleTolerance === "auto" ? -1 : number(draft.angleTolerance, "角度容差");
	if (angleTolerance !== -1 && angleTolerance <= 0) throw new Error("角度容差须为正数或自动。");
	return { symprec: number(draft.symprec, "距离容差", true), angleTolerance };
}
export function periodicSlabParameters(draft: PeriodicModelingDraft): CrystalParameters {
	const miller = vector(draft.miller, "Miller指数");
	if (miller.some((value) => !Number.isSafeInteger(value)) || miller.every((value) => value === 0))
		throw new Error("Miller指数须为不全为零的三个整数。");
	const pair = draft.inplane
		.trim()
		.split(/[\s,，;；]+/)
		.map(Number);
	if (pair.length !== 2 || pair.some((value) => !Number.isSafeInteger(value) || value < 1))
		throw new Error("面内重复须为两个正整数。");
	const vacuum = number(draft.slabVacuum, "总真空");
	if (vacuum < 0) throw new Error("真空不能为负数。");
	const position = draft.center ? vacuum / 2 : number(draft.position, "薄片位置");
	if (position < 0 || position > vacuum)
		throw new Error("薄片位置须在0与总真空之间，请修正位置或真空。");
	return {
		...periodicSymmetryParameters(draft),
		miller,
		repeat: pair as [number, number],
		start: number(draft.start, "起始位置"),
		thickness: number(draft.thickness, "保留厚度", true),
		thicknessMode: draft.thicknessMode,
		vacuum,
		position
	};
}
export function buildPeriodicModelingRequest(
	draft: PeriodicModelingDraft,
	structure: Structure
): PeriodicModelingRequest {
	if (!structure.cell) throw new Error("周期工具需要完整晶胞，请先导入含晶胞的结构。");
	cellInverse(structure.cell);
	if (draft.tab === "symmetry")
		return {
			type: "crystal",
			operation: draft.symmetryOperation,
			parameters: periodicSymmetryParameters(draft)
		};
	if (draft.tab === "supercell") {
		const repeat = vector(draft.repeat, "扩胞倍数");
		if (repeat.some((value) => !Number.isSafeInteger(value) || value < 1))
			throw new Error("扩胞倍数须为三个正整数。");
		if (structure.atoms.length * repeat.reduce((a, b) => a * b, 1) > 10000)
			throw new Error("扩胞原子数超过10000安全上限。");
		return { type: "supercell", repeat };
	}
	if (draft.tab === "slab")
		return { type: "crystal", operation: "slab", parameters: periodicSlabParameters(draft) };
	if (draft.tab === "wrap") return { type: "wrap" };
	if (draft.tab === "finite-cluster") return { type: "finite-cluster", keepCell: draft.keepCell };
	const order = vector(draft.axes, "晶胞轴顺序"),
		signs = vector(draft.signs, "晶胞轴方向");
	if (new Set(order).size !== 3 || order.some((value) => ![1, 2, 3].includes(value)))
		throw new Error("每个原晶胞轴须且只能使用一次。");
	if (signs.some((value) => value !== 1 && value !== -1))
		throw new Error("晶胞轴方向须为正或反方向。");
	return {
		type: "axes",
		order: order.map((value) => value - 1) as [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2],
		signs
	};
}
/** Source hkl phase; projected atomic heights cluster within 1e-7 Angstrom. */
export function slabLayerGeometry(structure: Structure, millerText: string) {
	if (!structure.cell) throw new Error("缺少完整晶胞。");
	const hkl = vector(millerText, "Miller指数");
	if (hkl.some((v) => !Number.isSafeInteger(v)) || hkl.every((v) => !v))
		throw new Error("Miller指数无效。");
	const inverse = cellInverse(structure.cell),
		reciprocal = [0, 1, 2].map((axis) =>
			hkl.reduce((sum, value, i) => sum + value * inverse[i][axis], 0)
		) as Vector3;
	const spacing = 1 / norm3(reciprocal),
		normal = reciprocal.map((value) => value * spacing) as Vector3,
		tolerance = 1e-7 / spacing;
	const gcd = (a:number, b:number):number => b ? gcd(b, a % b) : Math.abs(a);
	const period = hkl.reduce(gcd, 0);
	const phases = structure.atoms
			.map((atom) => {
				const f = cartesianToFractional(structure.cell!, [atom.x, atom.y, atom.z]),
					phase = f.reduce((sum, value, i) => sum + value * hkl[i], 0),
					wrapped = ((phase % period) + period) % period;
				return wrapped > period - tolerance ? 0 : wrapped;
			})
			.sort((a, b) => a - b),
		levels: number[] = [];
	for (const phase of phases)
		if (!levels.length || phase - levels[levels.length - 1] > tolerance) levels.push(phase);
	return { spacing, normal, levels, tolerance, period };
}
export function stepSlabLayer(
	value: number,
	direction: -1 | 1,
	levels: readonly number[],
	tolerance = 1e-8,
	periodLength = 1
): number {
	if (!levels.length) throw new Error("当前结构没有原子层候选。");
	const period = Math.floor(value / periodLength),
		candidates = [period - 1, period, period + 1].flatMap((shift) =>
			levels.map((level) => level + shift * periodLength)
		),
		eligible = candidates.filter((next) =>
			direction === 1 ? next > value + tolerance : next < value - tolerance
		);
	return direction === 1 ? Math.min(...eligible) : Math.max(...eligible);
}
/** Display-only planes: retain hkl intercepts while covering the whole source cell. */
export function slabGuidePlanes(cell: PeriodicCell, normal: Vector3, distances: readonly number[]) {
	const n = normal.map((value) => value / norm3(normal)) as Vector3;
	const origin = cell.origin ?? [0, 0, 0],
		center = fractionalToCartesian(cell, [0.5, 0.5, 0.5]);
	const relative = center.map((value, i) => value - origin[i]) as Vector3;
	const centerHeight = dot3(relative, n);
	// Match the renderer's plane frame; projected corners are symmetric around
	// the cell center, including for oblique source lattices.
	const seed: Vector3 = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0],
		first = cross3(n, seed);
	const u = first.map((value) => value / norm3(first)) as Vector3,
		v = cross3(n, u);
	const corners = Array.from({ length: 8 }, (_, index) =>
		fractionalToCartesian(cell, [index & 1 ? 1 : 0, index & 2 ? 1 : 0, index & 4 ? 1 : 0])
	);
	const spans = [u, v].map((axis) => {
		const heights = corners.map((point) => dot3(point, axis));
		return Math.max(...heights) - Math.min(...heights);
	});
	const size = Math.max(...spans) * 1.12;
	return distances.map((distance) => ({
		center: center.map((value, i) => value + (distance - centerHeight) * n[i]) as Vector3,
		normal: n,
		size
	}));
}
export default function PeriodicModelingPanel(props: PeriodicModelingPanelProps) {
	const structure = props.document.draft.structure,
		[localDraft, setLocalDraft] = useState(() => initialPeriodicModelingDraft(structure)),
		[chosen, setChosen] = useState<PeriodicModelingTask | null>(props.operation ?? null);
	const draft = props.draft ?? localDraft;
	const setDraft = (change: PeriodicModelingDraft | ((current: PeriodicModelingDraft) => PeriodicModelingDraft)) => {
		const next = typeof change === "function" ? change(draft) : change;
		if (props.onDraftChange) props.onDraftChange(next); else setLocalDraft(next);
	};
	const operation = props.operation ?? chosen,
		activeDraft = { ...draft, tab: operation ?? draft.tab },
		key = JSON.stringify(activeDraft);
	const preview = useStructureTransformPreview(props, key, operation === "cell-editor" ? undefined : () =>
		buildPeriodicModelingRequest(activeDraft, structure)
	);
	const [inspection, setInspection] = useState<{ key: string; result: CrystalResult } | null>(null),
		[inspecting, setInspecting] = useState(false);
	const [currentGroup, setCurrentGroup] = useState<string[]>([]);
	const [positionInput, setPositionInput] = useState(draft.position);
	const positionDirty = useRef(false);
	const [totalInput, setTotalInput] = useState<string | null>(null);
	const stamp = JSON.stringify([
			props.document.id,
			props.document.revision,
			props.open,
			draft.symprec,
			draft.angleTolerance,
			operation
		]),
		serial = useRef(0),
		latest = useRef({ props, stamp });
	latest.current = { props, stamp };
	const symmetry = inspection?.key === stamp ? inspection.result.symmetry : null;
	let cellFacts: ReturnType<typeof cellParameters> | null = null,
		cellError = "";
	try {
		if (!structure.cell) throw new Error("当前模型没有完整晶胞。");
		cellFacts = cellParameters(structure.cell);
	} catch (cause) {
		cellError = cause instanceof Error ? cause.message : String(cause);
	}
	const layer = useMemo(() => {
		if (operation !== "slab") return null;
		try { return slabLayerGeometry(structure, draft.miller); }
		catch { return null; /* invalid draft is reported by preparation */ }
	}, [structure, draft.miller, operation]);
	const set = <K extends keyof PeriodicModelingDraft>(name: K, value: PeriodicModelingDraft[K]) =>
		setDraft((previous) => ({ ...previous, [name]: value }));
	useEffect(() => {
		if (!props.draft) setLocalDraft(initialPeriodicModelingDraft(structure));
	}, [props.document.id]);
	useEffect(() => {
		serial.current++;
		setInspection(null);
		setInspecting(false);
		setCurrentGroup([]);
		if (props.previewActive !== false) props.onAtomHighlightChange?.([]);
	}, [stamp]);
	useEffect(() => { setPositionInput(draft.position); positionDirty.current = false; }, [draft.position]);
	useEffect(
		() => () => {
			serial.current++;
			if (latest.current.props.previewActive !== false) latest.current.props.onAtomHighlightChange?.([]);
		},
		[]
	);
	useEffect(() => {
		if (props.previewActive !== false && operation === "symmetry")
			props.onAtomHighlightChange?.(symmetry && symmetry.number !== 1 ? currentGroup : []);
	}, [props.previewActive, symmetry, currentGroup, operation]);
	useEffect(() => {
		if (operation !== "symmetry" || !props.open || props.previewActive === false || props.disabled || !structure.cell) return;
		const timer = setTimeout(() => void inspect(), 180);
		return () => clearTimeout(timer);
	}, [stamp, props.disabled, props.previewActive]);
	useEffect(() => {
		if (props.previewActive === false) return;
		if (!preview.live || !preview.displayCandidate) {
			props.onPreviewPresentationChange?.(null);
			return;
		}
		try {
			let guides: import("./structure-transform-panel").TransformPreviewPresentation["guides"];
			let candidateGuides: typeof guides, rotation: [Vector3,Vector3,Vector3] | undefined;
			if (operation === "slab" && layer) {
				if (preview.candidate !== preview.displayCandidate || props.previewResult?.candidate !== preview.displayCandidate) return;
				const factor = draft.thicknessMode === "fractional" ? layer.spacing : 1,
					start = Number(draft.start) * factor, thickness = Number(draft.thickness) * factor;
				const planes = slabGuidePlanes(structure.cell!, layer.normal, [start, start + thickness]);
				guides = { planes, vectors: planes.map(plane => ({ origin: plane.center,
					vector: layer!.normal.map(value => value * Math.max(1, layer!.spacing * .7)) as Vector3 })) };
				candidateGuides = candidateSlabGuides(structure, preview.displayCandidate, guides, props.previewResult.details!);
				rotation = props.previewResult.details!.rotation as [Vector3,Vector3,Vector3];
			}
			props.onPreviewPresentationChange?.({mode: operation === "slab" ? "slab" : "single", source: structure,
				candidate: preview.displayCandidate, sourceCell: operation === "supercell" ? structure.cell : undefined,
				guides, candidateGuides, rotation});
		} catch (cause) { preview.setError(cause instanceof Error ? cause.message : String(cause)); }
	}, [preview.live, preview.displayCandidate, preview.candidate, props.previewActive, props.previewResult]);
	async function inspect() {
		const ticket = ++serial.current,
			expected = stamp;
		setInspecting(true);
		try {
			const result = await props.onInspect({
				operation: "symmetry",
				parameters: periodicSymmetryParameters(draft)
			});
			if (ticket !== serial.current || latest.current.stamp !== expected) return;
			if (
				result.documentId !== props.document.id ||
				result.expectedRevision !== props.document.revision ||
				!result.symmetry
			)
				throw new Error("对称性结果已过期或不可用。");
			setInspection({ key: expected, result });
		} catch (cause) {
			if (ticket === serial.current)
				preview.setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (ticket === serial.current) setInspecting(false);
		}
	}
	const fields = (name: "repeat" | "miller" | "inplane", label: string, axes?: string[]) => (
		<TransformVectorFields
			label={label}
			value={draft[name]}
			integer
			stepper={name !== "miller"}
			onChange={(value) => set(name, value)}
			axes={axes}
		/>
	);
	const input = (
		name: "symprec" | "start" | "thickness" | "slabVacuum" | "position",
		label: string
	) => (
		<label>
			{label}
			<NumericInput
				aria-label={label}
				step="any"
				value={draft[name]}
				onChange={(event) => set(name, event.target.value)}
			/>
		</label>
	);
	const details =
			props.previewResult?.candidate === preview.displayCandidate
				? props.previewResult?.details
				: undefined,
		equivalents = symmetry
			? [...new Set(symmetry.equivalentAtoms.map((entry) => entry.representativeId))].map((id) =>
					symmetry.equivalentAtoms
						.filter((entry) => entry.representativeId === id)
						.map((entry) => entry.atomId)
				)
			: [];
	const actualThickness = details?.actualThickness;
	const previewStatus = preview.busy ? "更新中 · " : !preview.candidate && preview.displayCandidate ? "上次有效预览 · " : "";
	const totalThickness = actualThickness === undefined ? "" : String(Number((actualThickness + Number(draft.slabVacuum)).toPrecision(12)));
	function commitPosition(force = false) {
		if (!force && !positionDirty.current) return;
		try {
			const next = number(positionInput, "层距底部"), vacuum = number(draft.slabVacuum, "真空层厚度");
			if (next < 0 || next > vacuum) throw new Error("层距底部须在0与真空层厚度之间。");
			setDraft(current => ({ ...current, position: positionInput, center: false }));
			positionDirty.current = false;
			preview.setError("");
		} catch (cause) { preview.setError(cause instanceof Error ? cause.message : String(cause)); }
	}
	function commitTotal() {
		if (totalInput === null) return;
		try {
			if (actualThickness === undefined) throw new Error("请先生成有效切面预览。");
			const next = number(totalInput, "总盒子厚度") - actualThickness;
			if (next < 0) throw new Error("总盒子厚度不能小于实际表面厚度。");
			set("slabVacuum", String(Number(next.toPrecision(12))));
			setTotalInput(null);
			preview.setError("");
		} catch (cause) { preview.setError(cause instanceof Error ? cause.message : String(cause)); }
	}
	function step(name: "start" | "thickness", direction: -1 | 1) {
		try {
			if (!layer) throw new Error("请先填写有效Miller指数。");
			const factor = draft.thicknessMode === "fractional" ? 1 : layer.spacing,
				start = Number(draft.start) / factor,
				current = Number(draft[name]) / factor,
				edge = name === "start" ? current : start + current,
				next = stepSlabLayer(edge, direction, layer.levels, layer.tolerance, layer.period),
				result = name === "start" ? next : next - start;
			if (name === "thickness" && result <= 0) throw new Error("保留厚度须大于零。");
			set(name, String(Number((result * factor).toPrecision(12))));
		} catch (cause) {
			preview.setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	function switchUnit(mode: PeriodicModelingDraft["thicknessMode"]) {
		if (mode === draft.thicknessMode) return;
		if (!layer) {
			preview.setError("有效晶胞和Miller指数就绪后才能换算单位。");
			return;
		}
		const factor = mode === "angstrom" ? layer.spacing : 1 / layer.spacing;
		setDraft((current) => ({
			...current,
			thicknessMode: mode,
			start: String(Number((Number(current.start) * factor).toPrecision(12))),
			thickness: String(Number((Number(current.thickness) * factor).toPrecision(12)))
		}));
	}
	let expected = "";
	try {
		const request = buildPeriodicModelingRequest({ ...activeDraft, tab: "supercell" }, structure);
		if (request.type === "supercell" && cellFacts)
			expected = `预计 ${cellFacts
				.slice(0, 3)
				.map((value, index) => (value * request.repeat[index]).toFixed(3))
				.join(
					" × "
				)} Å · ${structure.atoms.length * request.repeat.reduce((a, b) => a * b, 1)} 原子`;
	} catch {
		/* invalid input is explained on Apply */
	}
	let fragments = "";
	if (operation === "finite-cluster")
		try {
			const count = resolveFinitePeriodicFragments(structure).length;
			fragments = `有限片段 ${count}`;
		} catch (cause) {
			fragments = cause instanceof Error ? cause.message : String(cause);
		}
	if (!props.open) return null;
	return (
		<TransformToolSurface
			title={periodicModelingTasks.find((task) => task.id === operation)?.title ?? "周期建模"}
			testId="periodic-modeling-panel"
			onClose={preview.close}
			embedded={props.embedded}
		>
			{!operation ? (
				<div className="structure-transform-task-grid">
					{periodicModelingTasks.map((task) => (
						<button
							type="button"
							className="task-card"
							key={task.id}
							onClick={() => {
								setChosen(task.id);
								props.onOperationChange?.(task.id);
							}}
						>
							{task.title}
						</button>
					))}
				</div>
			) : operation === "cell-editor" ? (
				<CellEditorPanel key={props.document.id} document={props.document} open={props.open} disabled={props.disabled} embedded={props.embedded}
					onApply={props.onApply} onClose={props.onClose} onPreviewChange={props.onPreviewChange}
					onPreviewPresentationChange={props.onPreviewPresentationChange} onCellEditorChange={props.onCellEditorChange}
					previewActive={props.previewActive} onCommitEdit={props.onCommitEdit} onSaveCheckpoint={props.onSaveCheckpoint} onRestoreCheckpoint={props.onRestoreCheckpoint}
					draft={props.cellEditorDraft} onDraftChange={props.onCellEditorDraftChange}/>
			) : (
				<>
					{cellError && (
						<p role="status" className="structure-transform-error">
							{cellError}
						</p>
					)}
					{cellFacts && ["supercell", "wrap", "axes"].includes(operation) && (
						<div className="structure-transform-result">
							<dl>
								{["a", "b", "c", "α", "β", "γ"].map((label, index) => (
									<div key={label}>
										<dt>
											{label} / {index < 3 ? "Å" : "°"}
										</dt>
										<dd>{cellFacts![index].toFixed(3)}</dd>
									</div>
								))}
							</dl>
						</div>
					)}
					<fieldset disabled={props.disabled || Boolean(cellError)}>
						{operation === "supercell" && (
							<>
								<div className="structure-transform-row">
									{fields("repeat", "复制倍数", ["a", "b", "c"])}
								</div>
								<p className="structure-transform-muted">{expected}</p>
							</>
						)}
						{operation === "symmetry" && (
							<>
								<div className="structure-transform-row">
									{input("symprec", "距离容差 / Å")}
									<label>
										角度容差
										<select
											aria-label="角度容差方式"
											value={draft.angleTolerance === "auto" ? "auto" : "manual"}
											onChange={(event) =>
												set("angleTolerance", event.target.value === "auto" ? "auto" : "1")
											}
										>
											<option value="auto">自动</option>
											<option value="manual">指定</option>
										</select>
									</label>
									{draft.angleTolerance !== "auto" && (
										<label>
											角度 / °
											<NumericInput

												aria-label="角度容差 / °"
												value={draft.angleTolerance}
												onChange={(event) => set("angleTolerance", event.target.value)}
											/>
										</label>
									)}
								</div>
								{inspecting && <p role="status">正在识别对称性…</p>}
								{symmetry && (
									<div className="structure-transform-result">
										<dl>
											<dt>空间群</dt>
											<dd>
												{symmetry.symbol}（{symmetry.number}）
											</dd>
											<dt>点群</dt>
											<dd>{symmetry.pointGroup}</dd>
										</dl>
										<details>
											<summary>其他信息</summary>Hall {symmetry.hallSymbol}
										</details>
										{symmetry.number !== 1 && <ScientificDataTable
											title="等价原子"
											selectionScope={stamp}
											projection={{
												columns: [
													{ key: "group", label: "等价组" },
													{ key: "atoms", label: "原子编号 / 元素" }
												],
												rows: equivalents.map((ids, index) => ({
													key: ids.join(","),
													cells: [
														String(index + 1),
														ids
															.map((id) => {
																const i = structure.atoms.findIndex((atom) => atom.id === id);
																return `${i + 1} ${structure.atoms[i]?.element ?? "?"}`;
															})
															.join("、")
													]
												}))
											}}
											onRowPreview={(row) =>
												props.onAtomHighlightChange?.(row ? row.key.split(",") : currentGroup)
											}
											onRowActivate={(row) => { const ids = row.key.split(","); setCurrentGroup(ids); props.onAtomHighlightChange?.(ids); }}
										/>}
									</div>
								)}
								<div className="structure-transform-row">
									<label>
										结构变换
										<select
											aria-label="对称性变换"
											value={draft.symmetryOperation}
											onChange={(event) =>
												set(
													"symmetryOperation",
													event.target.value as PeriodicModelingDraft["symmetryOperation"]
												)
											}
										>
											<option value="primitive">原胞</option>
											<option value="conventional">常规胞</option>
											<option value="p1">P1（不施加对称约束）</option>
											<option value="idealize">理想化</option>
										</select>
									</label>
								</div>
								{draft.symmetryOperation === "idealize" && (
									<p className="structure-transform-muted">理想化可能改变原子坐标与晶胞。</p>
								)}
							</>
						)}
						{operation === "slab" && (
							<>
								<div className="structure-transform-row slab-miller-row">
									{fields("miller", "Miller指数", ["h", "k", "l"])}
								</div>
								<div className="structure-transform-row slab-range-row">
									<label>
										输入方式
										<select
											aria-label="切面输入方式"
											value={draft.thicknessMode}
											onChange={(event) =>
												switchUnit(event.target.value as PeriodicModelingDraft["thicknessMode"])
											}
										>
											<option value="fractional">分数</option>
											<option value="angstrom">Å</option>
										</select>
									</label>
								</div>
								<div className="structure-transform-row slab-range-row">
									{(["thickness"] as const).map((name) => (
										<div key={name} className="structure-transform-layer-input">
											{input(
												name,
												`表面厚度 / ${draft.thicknessMode === "fractional" ? "dₕₖₗ" : "Å"}`
											)}
											<button
												type="button"
												aria-label="厚度上一原子层"
												onClick={() => step(name, -1)}
											>
												↓
											</button>
											<button
												type="button"
												aria-label="厚度下一原子层"
												onClick={() => step(name, 1)}
											>
												↑
											</button>
										</div>
									))}
								</div>
								<div className="structure-transform-row slab-range-row">
									<div className="structure-transform-layer-input">
										{input("start", `起始位置 / ${draft.thicknessMode === "fractional" ? "dₕₖₗ" : "Å"}`)}
										<button type="button" aria-label="起点上一原子层" onClick={() => step("start", -1)}>↓</button>
										<button type="button" aria-label="起点下一原子层" onClick={() => step("start", 1)}>↑</button>
									</div>
								</div>
								<div className="structure-transform-row">
									{fields("inplane", "面内复制", ["a", "b"])}
								</div>
								{layer && (
									<p className="structure-transform-muted">
										晶面间距 {layer.spacing.toFixed(4)} Å · 法向{" "}
										{layer.normal.map((v) => v.toFixed(3)).join(" ")} · {layer.levels.length}{" "}
										组原子层 / 周期
									</p>
								)}
								<hr />
								<div className="structure-transform-row slab-vacuum-row">
									{input("slabVacuum", "真空层厚度 / Å")}
								</div>
								<div className="structure-transform-row slab-vacuum-row">
									<label>总盒子厚度 / Å<NumericInput step="any" aria-label="总盒子厚度 / Å"
										value={totalInput ?? totalThickness} disabled={actualThickness === undefined || preview.busy || !preview.candidate}
										onChange={event => setTotalInput(event.target.value)} onBlur={commitTotal}
										onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitTotal(); } }}/></label>
								</div>
								<div className="structure-transform-row slab-position-row">
									<label className="structure-transform-check">
										<input
											type="radio"
											name={`slab-position-${props.document.id}`}
											checked={draft.center}
											onChange={() => set("center", true)}
										/>
										居中
									</label>
								</div>
								<div className="structure-transform-row slab-position-row slab-vacuum-row">
									<label className="structure-transform-check"><input type="radio" name={`slab-position-${props.document.id}`}
										checked={!draft.center} onChange={() => commitPosition(true)}/>层距底部 / Å</label>
									<NumericInput step="any" aria-label="层距底部 / Å" value={positionInput}
										onChange={event => { positionDirty.current = true; setPositionInput(event.target.value); }} onBlur={() => commitPosition()}
										onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitPosition(); } }}/>
								</div>
								{details?.actualThickness !== undefined && (
									<p>
										{previewStatus}实际表面厚度 {details.actualThickness.toFixed(4)} Å · 下方真空{" "}
										{details.lowerVacuum?.toFixed(3)} Å · 上方真空 {details.upperVacuum?.toFixed(3)}{" "}
										Å
									</p>
								)}
								{preview.displayCandidate?.structure.cell && <p className="structure-transform-muted">{previewStatus}预览晶胞：{cellParameters(preview.displayCandidate.structure.cell).map((value, index) => `${["a", "b", "c", "α", "β", "γ"][index]} ${value.toFixed(3)}${index < 3 ? " Å" : "°"}`).join(" · ")}</p>}
							</>
						)}
						{operation === "finite-cluster" && (
							<>
								<div className="structure-transform-row">
									<label>
										输出
										<select
											aria-label="片段输出周期性"
											value={draft.keepCell ? "cell" : "finite"}
											onChange={(event) => set("keepCell", event.target.value === "cell")}
										>
											<option value="finite">非周期结构</option>
											<option value="cell">保留原晶胞与周期性</option>
										</select>
									</label>
								</div>
								<p>{fragments}</p>
							</>
						)}
						{operation === "axes" && (
							<div className="structure-transform-row">
								{["a", "b", "c"].map((axis, index) => (
									<label key={axis}>
										新{axis}
										<select
											aria-label={`新${axis}来源`}
											value={draft.axes.split(" ")[index]}
											onChange={(event) => {
												const next = draft.axes.split(" ");
												next[index] = event.target.value;
												set("axes", next.join(" "));
											}}
										>
											{["a", "b", "c"].map((old, i) => (
												<option key={old} value={i + 1}>
													原{old}
												</option>
											))}
										</select>
										<select
											aria-label={`新${axis}方向`}
											value={draft.signs.split(" ")[index]}
											onChange={(event) => {
												const next = draft.signs.split(" ");
												next[index] = event.target.value;
												set("signs", next.join(" "));
											}}
										>
											<option value="1">正</option>
											<option value="-1">反</option>
										</select>
									</label>
								))}
							</div>
						)}
					</fieldset>
					<TransformPreviewFooter
						preview={preview}
						disabled={props.disabled || Boolean(cellError)}
					/>
				</>
			)}
		</TransformToolSurface>
	);
}
