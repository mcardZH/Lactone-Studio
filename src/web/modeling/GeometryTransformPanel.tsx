import { useEffect, useState } from "react";
import type { Structure, Vector3 } from "../../core/types";
import type { StructureTransformEdit } from "../../core/modeling/structure-transform";
import { fractionalToCartesian } from "../../core/periodic";
import weights from "../../data/atomic-weights.json";
import NumericInput from "../NumericInput";
import InteractiveSelectionField from "../InteractiveSelectionField";
import type { AnalysisSelectionPort } from "../analysis-selection-intent";
import {
	parseTransformNumber,
	parseTransformVector,
	TransformVectorFields,
	TransformPreviewFooter,
	TransformToolSurface,
	useStructureTransformPreview,
	type StructureTransformPanelProps,
	type TransformReferenceCapture
} from "./structure-transform-panel";

export type GeometryTransformTask = Exclude<
	GeometryTransformOperation,
	"matrix" | "wrap" | "finite-cluster" | "axes"
>;
export interface GeometryTransformPanelProps extends StructureTransformPanelProps<StructureTransformEdit> {
	draft?: GeometryTransformDraft;
	onDraftChange?(draft: GeometryTransformDraft): void;
	operation?: GeometryTransformTask;
	onOperationChange?(operation: GeometryTransformTask): void;
	selectionPort?: AnalysisSelectionPort;
	onReferenceCapture?(request: TransformReferenceCapture): void;
}
export type GeometryTransformOperation =
	| "translate"
	| "center"
	| "rotate"
	| "matrix"
	| "align"
	| "principal-axes"
	| "mirror"
	| "invert"
	| "scale"
	| "reorder"
	| "crop"
	| "wrap"
	| "finite-cluster"
	| "axes";
export interface GeometryTransformDraft {
	operation: GeometryTransformOperation;
	scope: "all" | "selected";
	delta: string;
	pivot: string;
	centerMode: "geometry" | "mass";
	rotationMode: "axis" | "vector" | "bond" | "matrix";
	axis: string;
	bond: string;
	degrees: string;
	matrix: [string, string, string];
	alignMode: "vector" | "plane";
	from: string;
	to: string;
	planeFirst: string;
	planeSecond: string;
	massWeighted: boolean;
	factors: string;
	order: string;
	cropMin: string;
	cropMax: string;
	cropSpace: "cartesian" | "fractional";
	keepCell: boolean;
	axes: string;
	signs: string;
	pivotMode?: "geometry" | "mass" | "atom" | "custom";
	pivotAtom?: string;
	centerTarget?: "origin" | "cell" | "custom";
	alignmentSource?: "vector" | "pair" | "plane";
	referenceAtoms?: string;
	targetDirection?: string;
	mirrorMode?: "xy" | "xz" | "yz" | "normal" | "atoms";
	scaleMode?: "uniform" | "axes";
}
export const initialGeometryTransformDraft: GeometryTransformDraft = {
	operation: "translate",
	scope: "all",
	delta: "0 0 0",
	pivot: "0 0 0",
	centerMode: "geometry",
	rotationMode: "axis",
	axis: "0 0 1",
	bond: "1 2",
	degrees: "90",
	matrix: ["1 0 0", "0 1 0", "0 0 1"],
	alignMode: "vector",
	from: "1 0 0",
	to: "0 0 1",
	planeFirst: "1 0 0",
	planeSecond: "0 1 0",
	massWeighted: false,
	factors: "1 1 1",
	order: "",
	cropMin: "-10 -10 -10",
	cropMax: "10 10 10",
	cropSpace: "cartesian",
	keepCell: false,
	axes: "1 2 3",
	signs: "1 1 1"
};

function indices(text: string, structure: Structure): number[] {
	if (!text.trim()) throw new Error("请填写原子编号。");
	const values = text
		.trim()
		.split(/[\s,，;；]+/)
		.map(Number);
	if (
		values.some(
			(value) => !Number.isSafeInteger(value) || value < 1 || value > structure.atoms.length
		) ||
		new Set(values).size !== values.length
	)
		throw new Error("原子编号须在当前范围内且不重复。");
	return values.map((value) => value - 1);
}
export function buildGeometryTransformEdit(
	draft: GeometryTransformDraft,
	structure: Structure,
	selectedAtomIds: readonly string[]
): StructureTransformEdit {
	const v = parseTransformVector;
	const usesPivot =
		["center", "rotate", "matrix", "align", "principal-axes", "mirror", "invert", "scale"].includes(
			draft.operation
		) && !(draft.operation === "rotate" && draft.rotationMode === "bond");
	let pivot: Vector3 =
		usesPivot && (!draft.pivotMode || draft.pivotMode === "custom")
			? v(draft.pivot, "变换中心")
			: [0, 0, 0];
	const scoped = !["reorder", "crop", "wrap", "finite-cluster", "axes"].includes(draft.operation);
	const scope = scoped && draft.scope === "selected" ? { atomIds: [...selectedAtomIds] } : {};
	if (scoped && draft.scope === "selected" && !selectedAtomIds.length)
		throw new Error("当前没有建模选区。");
	if (usesPivot && draft.pivotMode && draft.pivotMode !== "custom") {
		const atoms =
			draft.scope === "selected"
				? structure.atoms.filter((atom) => selectedAtomIds.includes(atom.id!))
				: structure.atoms;
		if (draft.pivotMode === "atom") {
			const refs = indices(draft.pivotAtom ?? "", structure);
			if (refs.length !== 1) throw new Error("中心须指定一个原子。");
			const atom = structure.atoms[refs[0]];
			pivot = [atom.x, atom.y, atom.z];
		} else {
			let total = 0;
			const sum: Vector3 = [0, 0, 0];
			for (const atom of atoms) {
				const w =
					draft.pivotMode === "mass"
						? (weights.weights as Record<string, number>)[atom.element]
						: 1;
				if (!Number.isFinite(w) || w <= 0) throw new Error("元素缺少明确质量。");
				total += w;
				sum[0] += atom.x * w;
				sum[1] += atom.y * w;
				sum[2] += atom.z * w;
			}
			if (!total) throw new Error("变换对象没有原子。");
			pivot = sum.map((value) => value / total) as Vector3;
		}
	}
	const references = () =>
		indices(draft.referenceAtoms ?? "", structure).map((index) => structure.atoms[index]);
	const difference = (
		a: (typeof structure.atoms)[number],
		b: (typeof structure.atoms)[number]
	): Vector3 => [b.x - a.x, b.y - a.y, b.z - a.z];
	const normal = (a: Vector3, b: Vector3): Vector3 => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0]
	];
	switch (draft.operation) {
		case "translate":
			return { type: "translate", delta: v(draft.delta, "平移向量"), ...scope };
		case "center":
			return {
				type: "center",
				mode: draft.centerMode,
				target:
					draft.centerTarget === "origin"
						? [0, 0, 0]
						: draft.centerTarget === "cell"
							? (() => {
									if (!structure.cell) throw new Error("晶胞中心需要完整晶胞。");
									return fractionalToCartesian(structure.cell, [0.5, 0.5, 0.5]);
								})()
							: v(draft.pivot, "目标中心"),
				...scope
			};
		case "rotate": {
			if (draft.rotationMode === "matrix")
				return {
					type: "matrix",
					matrix: draft.matrix.map((row, index) => v(row, `矩阵第${index + 1}行`)) as [
						Vector3,
						Vector3,
						Vector3
					],
					pivot,
					...scope
				};
			let axis: Vector3 = draft.rotationMode === "bond" ? [0, 0, 0] : v(draft.axis, "旋转轴"),
				origin = pivot;
			if (draft.rotationMode === "bond") {
				const pair = indices(draft.bond, structure);
				if (pair.length !== 2) throw new Error("键轴须指定两个原子编号。");
				const [a, b] = pair.map((index) => structure.atoms[index]);
				axis = [b.x - a.x, b.y - a.y, b.z - a.z];
				origin = [a.x, a.y, a.z];
				const bond = structure.bonds?.find(
					(edge) =>
						(edge.a === pair[0] && edge.b === pair[1]) || (edge.a === pair[1] && edge.b === pair[0])
				);
				if (bond?.image?.some(Boolean))
					throw new Error("跨晶胞键请用已确认的笛卡尔向量指定旋转轴。");
			}
			return {
				type: "rotate",
				axis,
				pivot: origin,
				degrees: parseTransformNumber(draft.degrees, "旋转角"),
				...scope
			};
		}
		case "matrix":
			return {
				type: "matrix",
				matrix: draft.matrix.map((row, index) => v(row, `矩阵第${index + 1}行`)) as [
					Vector3,
					Vector3,
					Vector3
				],
				pivot,
				...scope
			};
		case "align": {
			const atomReference = draft.alignmentSource === "pair" || draft.alignmentSource === "plane";
			let from: Vector3 = atomReference || draft.alignMode === "plane" ? [0, 0, 0] : v(draft.from, "源向量");
			if (!atomReference && draft.alignMode === "plane") {
				const a = v(draft.planeFirst, "平面向量1"),
					b = v(draft.planeSecond, "平面向量2");
				from = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
			}
			if (atomReference) {
				const refs = references();
				const count = draft.alignmentSource === "pair" ? 2 : 3;
				if (refs.length !== count) throw new Error(`请指定${count}个参考原子。`);
				from =
					count === 2
						? difference(refs[0], refs[1])
						: normal(difference(refs[0], refs[1]), difference(refs[0], refs[2]));
			}
			return {
				type: "align",
				from,
				to: v(
					draft.targetDirection && draft.targetDirection !== "custom"
						? draft.targetDirection
						: draft.to,
					draft.alignMode === "plane" ? "目标法向" : "目标向量"
				),
				pivot,
				...scope
			};
		}
		case "principal-axes":
			return { type: "principal-axes", massWeighted: draft.massWeighted, pivot, ...scope };
		case "mirror": {
			if (draft.mirrorMode === "atoms") {
				const refs = references();
				if (refs.length !== 3) throw new Error("镜面须指定三个原子。");
				return {
					type: "mirror",
					normal: normal(difference(refs[0], refs[1]), difference(refs[0], refs[2])),
					pivot: [refs[0].x, refs[0].y, refs[0].z],
					...scope
				};
			}
			return {
				type: "mirror",
				normal:
					draft.mirrorMode === "xy"
						? [0, 0, 1]
						: draft.mirrorMode === "xz"
							? [0, 1, 0]
							: draft.mirrorMode === "yz"
								? [1, 0, 0]
								: v(draft.axis, "镜面法向"),
				pivot,
				...scope
			};
		}
		case "invert":
			return { type: "invert", pivot, ...scope };
		case "scale":
			return { type: "scale", factors: v(draft.factors, "缩放比例"), pivot, ...scope };
		case "reorder": {
			const order = indices(draft.order, structure);
			if (order.length !== structure.atoms.length)
				throw new Error("重新编号须包含全部原子，且每个编号只出现一次。");
			return {
				type: "reorder",
				atomIds: order.map((index) => {
					const id = structure.atoms[index].id;
					if (!id) throw new Error("当前原子缺少稳定身份。");
					return id;
				})
			};
		}
		case "crop":
			return {
				type: "crop",
				min: v(draft.cropMin, "裁剪下限"),
				max: v(draft.cropMax, "裁剪上限"),
				space: draft.cropSpace
			};
		case "wrap":
			return { type: "wrap" };
		case "finite-cluster":
			return { type: "finite-cluster", keepCell: draft.keepCell };
		case "axes": {
			const order = v(draft.axes, "晶胞轴顺序");
			if (new Set(order).size !== 3 || order.some((value) => ![1, 2, 3].includes(value)))
				throw new Error("晶胞轴顺序须为1、2、3的排列。");
			return {
				type: "axes",
				order: order.map((value) => value - 1) as [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2],
				signs: v(draft.signs, "晶胞轴方向")
			};
		}
	}
}

export const geometryTransformTasks: { id: GeometryTransformTask; title: string; group: string }[] =
	[
		{ id: "translate", title: "平移", group: "位置与朝向" },
		{ id: "center", title: "居中", group: "位置与朝向" },
		{ id: "rotate", title: "旋转", group: "位置与朝向" },
		{ id: "align", title: "方向对齐", group: "位置与朝向" },
		{ id: "principal-axes", title: "主轴对齐", group: "位置与朝向" },
		{ id: "mirror", title: "镜像", group: "几何变换" },
		{ id: "invert", title: "反演", group: "几何变换" },
		{ id: "scale", title: "缩放", group: "几何变换" },
		{ id: "crop", title: "裁剪", group: "原子整理" },
		{ id: "reorder", title: "重新编号", group: "原子整理" }
	];
export function newGeometryDraft(
	operation: GeometryTransformOperation = "translate"
): GeometryTransformDraft {
	return {
		...initialGeometryTransformDraft,
		operation,
		pivotMode: "geometry",
		centerTarget: "origin",
		alignmentSource: "vector",
		targetDirection: "0 0 1",
		mirrorMode: "xy",
		scaleMode: "uniform"
	};
}
export default function GeometryTransformPanel(props: GeometryTransformPanelProps) {
	const [localDraft, setLocalDraft] = useState<GeometryTransformDraft>(() =>
		newGeometryDraft(props.operation)
	);
	const draft = props.draft ?? localDraft;
	const setDraft = (change: GeometryTransformDraft | ((current: GeometryTransformDraft) => GeometryTransformDraft)) => {
		const next = typeof change === "function" ? change(draft) : change;
		if (props.onDraftChange) props.onDraftChange(next); else setLocalDraft(next);
	};
	const [chosen, setChosen] = useState<GeometryTransformTask | null>(props.operation ?? null);
	const structure = props.document.draft.structure;
	const operation = props.operation ?? chosen;
	const activeDraft = {
		...draft,
		operation: operation ?? draft.operation,
		order: draft.order || structure.atoms.map((_, index) => index + 1).join(" ")
	};
	const key = JSON.stringify([activeDraft, props.document.selection.atomIds]);
	const preview = useStructureTransformPreview(props, key, () =>
		buildGeometryTransformEdit(activeDraft, structure, props.document.selection.atomIds)
	);
	useEffect(
		() => { if (!props.draft) setLocalDraft(newGeometryDraft(operation ?? "translate")); },
		[props.document.id]
	);
	useEffect(() => {
		if (props.previewActive === false) return;
		if (!preview.live || !preview.displayCandidate) {
			props.onPreviewPresentationChange?.(null);
			return;
		}
		let guides: NonNullable<
			import("./structure-transform-panel").TransformPreviewPresentation["guides"]
		> = {referenceStructure:structure};
		try {
			const edit = buildGeometryTransformEdit(
				activeDraft,
				structure,
				props.document.selection.atomIds
			);
			if ("pivot" in edit && edit.pivot) guides.points = [{ position: edit.pivot }];
			if (edit.type === "rotate")
				guides.vectors = [{ origin: edit.pivot ?? [0, 0, 0], vector: edit.axis }];
			if (edit.type === "mirror")
				guides.planes = [{ center: edit.pivot ?? [0, 0, 0], normal: edit.normal }];
			if (edit.type === "crop") {
				guides.box = { min: edit.min, max: edit.max, space: edit.space ?? "cartesian" };
				const retained = new Set(preview.displayCandidate.structure.atoms.map((atom) => atom.id));
				guides.dimAtomIds = structure.atoms
					.filter((atom) => !retained.has(atom.id))
					.map((atom) => atom.id!);
			}
			if (edit.type === "align")
				guides.vectors = [
					{ origin: edit.pivot ?? [0, 0, 0], vector: edit.from },
					{ origin: edit.pivot ?? [0, 0, 0], vector: edit.to }
				];
			if (edit.type === "center") guides.points = [{ position: edit.target ?? [0, 0, 0] }];
		} catch {
			/* invalid drafts have no candidate */
		}
		props.onPreviewPresentationChange?.({
			mode: "single",
			source: structure,
			candidate: preview.displayCandidate,
			guides
		});
		return () => props.onPreviewPresentationChange?.(null);
	}, [preview.displayCandidate, preview.live, props.previewActive]);
	const set = <K extends keyof GeometryTransformDraft>(name: K, value: GeometryTransformDraft[K]) =>
		setDraft((current) => ({ ...current, [name]: value }));
	const vector = (name: keyof GeometryTransformDraft, label: string) => (
		<TransformVectorFields
			label={label}
			value={String(draft[name])}
			onChange={(value) => set(name, value as never)}
		/>
	);
	const select = <K extends keyof GeometryTransformDraft>(
		name: K,
		label: string,
		options: readonly (readonly [string, string])[]
	) => (
		<label>
			{label}
			<select
				aria-label={label}
				value={String(draft[name])}
				onChange={(event) => set(name, event.target.value as never)}
			>
				{options.map(([value, title]) => (
					<option key={value} value={value}>
						{title}
					</option>
				))}
			</select>
		</label>
	);
	function reference(
		name: "bond" | "pivotAtom" | "referenceAtoms",
		label: string,
		count: 1 | 2 | 3
	) {
		let ids: string[] = [];
		try {
			ids = indices(String(draft[name] ?? ""), structure).map(
				(index) => structure.atoms[index].id!
			);
		} catch {
			/* incomplete draft */
		}
		const common = {
			structure,
			rowId: `transform-${name}`,
			label,
			atomIds: ids,
			onConfirm: (values: string[]) => {
				if (values.length !== count) throw new Error(`请指定${count}个参考原子。`);
				set(
					name,
					values.map((id) => structure.atoms.findIndex((atom) => atom.id === id) + 1).join(" ")
				);
			}
		};
		return props.selectionPort ? (
			<InteractiveSelectionField
				{...common}
				captureOwner={props.selectionPort.owner}
				contextKey={props.selectionPort.contextKey}
				analysisPurpose="advanced-region"
				kind={count === 1 ? "atoms" : "coordinate"}
				onRequestAnalysisSelection={(intent) => props.selectionPort!.requestSelection(intent)}
			/>
		) : (
			<InteractiveSelectionField
				{...common}
				engine="gaussian"
				purpose="frozen-atoms"
				contextKey={`${props.document.id}:${props.document.revision}:${operation}`}
				kind={count === 1 ? "atoms" : "coordinate"}
				onPick={
					props.onReferenceCapture
						? (request) =>
								props.onReferenceCapture!({
									count,
									label,
									onConfirm: (values) =>
										request.onApply(
											values.map((id) => structure.atoms.findIndex((atom) => atom.id === id))
										)
								})
						: undefined
				}
			/>
		);
	}
	const pivotFields = (
		<>
			<div className="structure-transform-row">
				{select("pivotMode", "变换中心", [
					["geometry", "几何中心"],
					["mass", "质心"],
					["atom", "指定原子"],
					["custom", "自定义XYZ"]
				])}
				{draft.pivotMode === "custom" && vector("pivot", "中心 / Å")}
			</div>
			{draft.pivotMode === "atom" && reference("pivotAtom", "中心参考", 1)}
		</>
	);
	const scoped = !["reorder", "crop", "wrap", "finite-cluster", "axes"].includes(draft.operation);
	const fullScopeLabel =
		structure.cell &&
		["rotate", "matrix", "align", "principal-axes", "mirror", "invert", "scale"].includes(
			draft.operation
		)
			? "全模型（含晶胞）"
			: "全部原子";
	const order = (() => {
		try {
			return indices(
				draft.order || structure.atoms.map((_, index) => index + 1).join(" "),
				structure
			);
		} catch {
			return [];
		}
	})();
	function moveOrder(index: number, delta: number) {
		const next = [...order],
			target = index + delta;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		set("order", next.map((value) => value + 1).join(" "));
	}
	if (!props.open) return null;
	return (
		<TransformToolSurface
			title={geometryTransformTasks.find((task) => task.id === operation)?.title ?? "几何变换"}
			testId="geometry-transform-panel"
			onClose={preview.close}
			embedded={props.embedded}
		>
			{!operation ? (
				<>
					{[...new Set(geometryTransformTasks.map((task) => task.group))].map((group) => (
						<section key={group}>
							<h3>{group}</h3>
							<div className="structure-transform-task-grid">
								{geometryTransformTasks
									.filter((task) => task.group === group)
									.map((task) => (
										<button
											className="task-card"
											type="button"
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
						</section>
					))}
				</>
			) : (
				<>
					<fieldset disabled={props.disabled || preview.busy}>
						<div className="structure-transform-row">
							{scoped && (
								<label>
									对象
									<select
										aria-label="几何变换对象"
										value={draft.scope}
										onChange={(event) => set("scope", event.target.value as "all" | "selected")}
									>
										<option value="all">
											{fullScopeLabel}（{structure.atoms.length}）
										</option>
										<option value="selected">
											选中原子（{props.document.selection.atomIds.length}）
										</option>
									</select>
								</label>
							)}
						</div>
						{operation === "translate" && (
							<div className="structure-transform-row">{vector("delta", "平移 / Å")}</div>
						)}
						{operation === "center" && (
							<div className="structure-transform-row">
								{select("centerMode", "中心定义", [
									["geometry", "几何中心"],
									["mass", "质心"]
								])}
								{select(
									"centerTarget",
									"目标",
									structure.cell
										? [
												["origin", "原点"],
												["cell", "晶胞中心"],
												["custom", "自定义XYZ"]
											]
										: [
												["origin", "原点"],
												["custom", "自定义XYZ"]
											]
								)}
								{draft.centerTarget === "custom" && vector("pivot", "目标 / Å")}
							</div>
						)}
						{operation === "rotate" && (
							<>
								<div className="structure-transform-row">
									{select("rotationMode", "旋转方式", [
										["axis", "X/Y/Z轴"],
										["vector", "自定义向量"],
										["bond", "原子对"],
										["matrix", "旋转矩阵"]
									])}
									{draft.rotationMode === "axis" &&
										select("axis", "轴", [
											["1 0 0", "X"],
											["0 1 0", "Y"],
											["0 0 1", "Z"]
										])}
									{draft.rotationMode === "vector" && vector("axis", "轴方向")}
								</div>
								{draft.rotationMode === "bond" && reference("bond", "旋转轴", 2)}
								{draft.rotationMode === "matrix" ? (
									<div className="structure-transform-row">
										{draft.matrix.map((value, index) => (
											<TransformVectorFields
												key={index}
												label={`矩阵行${index + 1}`}
												value={value}
												onChange={(next) =>
													set(
														"matrix",
														draft.matrix.map((row, i) =>
															i === index ? next : row
														) as GeometryTransformDraft["matrix"]
													)
												}
											/>
										))}
									</div>
								) : (
									<div className="structure-transform-row">
										<label>
											角度 / °
											<input
												aria-label="旋转角度滑杆"
												type="range"
												min="-180"
												max="180"
												step="1"
												value={Number(draft.degrees) || 0}
												onChange={(event) => set("degrees", event.target.value)}
											/>
											<NumericInput
												aria-label="旋转角度"

												value={draft.degrees}
												onChange={(event) => set("degrees", event.target.value)}
											/>
										</label>
									</div>
								)}
							</>
						)}
						{operation === "align" && (
							<>
								<div className="structure-transform-row">
									{select("alignmentSource", "源方向", [
										["pair", "原子对方向"],
										["vector", "自定义向量"],
										["plane", "三原子平面"]
									])}
									{draft.alignmentSource === "vector" && vector("from", "源方向")}
									{select(
										"targetDirection",
										"目标方向",
										draft.alignmentSource === "plane"
											? [
													["0 0 1", "XY平面"],
													["0 1 0", "XZ平面"],
													["1 0 0", "YZ平面"],
													["custom", "自定义法向"]
												]
											: [
													["1 0 0", "X轴"],
													["0 1 0", "Y轴"],
													["0 0 1", "Z轴"],
													["custom", "自定义方向"]
												]
									)}
									{(!draft.targetDirection || draft.targetDirection === "custom") &&
										vector("to", "目标方向")}
								</div>
								{draft.alignmentSource !== "vector" &&
									reference(
										"referenceAtoms",
										"源方向参考",
										draft.alignmentSource === "plane" ? 3 : 2
									)}
							</>
						)}
						{operation === "principal-axes" && (
							<div className="structure-transform-row">
								<label>
									分布
									<select
										aria-label="主轴加权"
										value={draft.massWeighted ? "mass" : "geometry"}
										onChange={(event) => set("massWeighted", event.target.value === "mass")}
									>
										<option value="geometry">几何分布</option>
										<option value="mass">质量加权</option>
									</select>
								</label>
							</div>
						)}
						{operation === "mirror" && (
							<>
								<div className="structure-transform-row">
									{select("mirrorMode", "镜面", [
										["xy", "平行XY"],
										["xz", "平行XZ"],
										["yz", "平行YZ"],
										["normal", "自定义法向"],
										["atoms", "三原子平面"]
									])}
									{draft.mirrorMode === "normal" && vector("axis", "镜面法向")}
								</div>
								{draft.mirrorMode === "atoms" && reference("referenceAtoms", "镜面参考", 3)}
							</>
						)}
						{operation === "scale" && (
							<div className="structure-transform-row">
								{select("scaleMode", "缩放", [
									["uniform", "等比例"],
									["axes", "XYZ分轴"]
								])}
								{draft.scaleMode === "axes" ? (
									vector("factors", "倍率")
								) : (
									<label>
										倍率
										<NumericInput

											step="any"
											min="0"
											aria-label="缩放倍率"
											value={draft.factors.split(" ")[0]}
											onChange={(event) =>
												set("factors", Array(3).fill(event.target.value).join(" "))
											}
										/>
									</label>
								)}
							</div>
						)}
						{["rotate", "align", "principal-axes", "mirror", "invert", "scale"].includes(
							operation
						) &&
							!(operation === "rotate" && draft.rotationMode === "bond") &&
							!(operation === "mirror" && draft.mirrorMode === "atoms") &&
							pivotFields}
						{operation === "crop" && (
							<>
								<div className="structure-transform-row">
									{select(
										"cropSpace",
										"坐标",
										structure.cell
											? [
													["cartesian", "XYZ / Å"],
													["fractional", "分数坐标"]
												]
											: [["cartesian", "XYZ / Å"]]
									)}
									{vector("cropMin", "下限")}
									{vector("cropMax", "上限")}
								</div>
								{preview.candidate && (
									<p>
										保留 {preview.candidate.structure.atoms.length} · 移除{" "}
										{structure.atoms.length - preview.candidate.structure.atoms.length}
									</p>
								)}
							</>
						)}
						{operation === "reorder" && (
							<>
								<div className="structure-transform-row">
									<label className="structure-transform-wide">
										完整原编号顺序
										<input
											aria-label="新原子编号顺序"
											value={draft.order || structure.atoms.map((_, index) => index + 1).join(" ")}
											onChange={(event) => set("order", event.target.value)}
										/>
									</label>
								</div>
								<table className="structure-transform-order">
									<thead>
										<tr>
											<th>原编号</th>
											<th>元素</th>
											<th>新编号</th>
											<th>移动</th>
										</tr>
									</thead>
									<tbody>
										{order.map((old, index) => (
											<tr key={structure.atoms[old].id}>
												<td>{old + 1}</td>
												<td>{structure.atoms[old].element}</td>
												<td>{index + 1}</td>
												<td>
													<button
														type="button"
														aria-label={`原子${old + 1}上移`}
														disabled={!index}
														onClick={() => moveOrder(index, -1)}
													>
														↑
													</button>
													<button
														type="button"
														aria-label={`原子${old + 1}下移`}
														disabled={index === order.length - 1}
														onClick={() => moveOrder(index, 1)}
													>
														↓
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</>
						)}
					</fieldset>
					<TransformPreviewFooter preview={preview} disabled={props.disabled} />
				</>
			)}
		</TransformToolSurface>
	);
}
