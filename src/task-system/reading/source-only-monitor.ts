import type { Structure } from "../../core/types";
import { elementSymbol } from "../../core/elements";
import { parseStructures } from "../../core/parsers";
import type { ManagedSourceSummaryView } from "../contracts";
import type { MonitorGeometry, TaskMonitorResultView } from "../application-contracts";
import {
	assertResultNotAborted,
	type ResultInputFile,
	type TrajectoryResult
} from "../../results/contracts";
import { recognizeResultSource } from "../../results/source-recognition";
import { readXyzTrajectory } from "../../results/xyz-reader";
import { readFchkScientificResult } from "../../results/fchk-scientific-reader";
import { readHessScientificResult } from "../../results/hess-scientific-reader";
import { readMoldenStructure } from "../../results/molden-structure-reader";
import { readMolecularCube } from "../../results/cube-reader";
import { emptyScientificData } from "../../results/scientific-contracts";
import { readScientificResults } from "../../results/scientific-reader";

export interface MonitorSourceFile {
	artifactId: string;
	sourceId?: string;
	name: string;
	byteSize: number;
	sha256?: string;
	roles: readonly string[];
	format?: string | null;
}
/** Fill only missing display identities from this result's prepared frames.
 * Geometry, explicit graphs and existing identities remain source facts. */
export function alignSourceInitialStructure(structure: Structure, frames: readonly MonitorGeometry[]): Structure {
	const first = frames[0];
	if (!first) return structure;
	const validFrame = (frame: MonitorGeometry) => frame.atoms.length === structure.atoms.length &&
		frame.atoms.every((atom, index) => typeof atom.id === "string" && atom.id.length > 0 &&
			atom.element === structure.atoms[index].element && [atom.x, atom.y, atom.z].every(Number.isFinite)) &&
		new Set(frame.atoms.map(atom => atom.id)).size === frame.atoms.length;
	if (!validFrame(first) || frames.some(frame => !validFrame(frame) || frame.atoms.some((atom, index) => atom.id !== first.atoms[index].id)) ||
		structure.atoms.some((atom, index) => ![atom.x, atom.y, atom.z].every(Number.isFinite) || atom.id !== undefined && atom.id !== first.atoms[index].id))
		throw new Error("来源初始结构与已准备轨迹的原子身份或顺序不一致。");
	return { ...structure, atoms: structure.atoms.map((atom, index) => atom.id === undefined ? { ...atom, id: first.atoms[index].id } : atom) };
}
export { recognizeResultSource as recognizeMonitorSource };
/** Only an atomically saved source projection with its exact source role and
 * hash/version binding is accepted. Marker summaries never enter this path. */
export function validateSourceMonitorSummary(
	summary: ManagedSourceSummaryView | undefined,
	sourceSetId: string,
	sourceVersion: string,
	files: readonly MonitorSourceFile[]
): MonitorSourceFile | null {
	if (!summary) return null;
	if (
		summary.schema !== 1 ||
		summary.sourceSetId !== sourceSetId ||
		summary.sourceVersion !== sourceVersion ||
		!/^[a-f0-9]{64}$/.test(summary.sourceSha256) ||
		typeof summary.sourceId !== "string" ||
		!summary.sourceId ||
		typeof summary.engineId !== "string" ||
		typeof summary.taskKind !== "string" ||
		(summary.method !== undefined && typeof summary.method !== "string") ||
		(summary.capabilities !== undefined &&
			(!Array.isArray(summary.capabilities) ||
				summary.capabilities.some((value) => typeof value !== "string")))
	)
		throw new Error("已保存结构投影与来源集合版本不一致。");
	const matches = files.filter(
		(file) =>
			file.sourceId === summary.sourceId &&
			file.sha256 === summary.sourceSha256 &&
			file.roles.some((role) =>
				["primary-output", "wavefunction", "structure", "trajectory", "modes"].includes(role)
			)
	);
	if (matches.length !== 1) throw new Error("已保存结构投影缺少唯一、同SHA且角色相容的原始来源。");
	const structure = summary.structure;
	const ids = structure?.atoms?.flatMap((atom) => (atom.id === undefined ? [] : [atom.id])) ?? [],
		cell = structure?.cell;
	if (
		!structure?.atoms?.length ||
		!Array.isArray(structure.notes) ||
		structure.atoms.some((atom) => {
			try {
				return (
					elementSymbol(atom.element) !== atom.element ||
					!["x", "y", "z"].every((axis) => Number.isFinite(atom[axis as "x"]))
				);
			} catch {
				return true;
			}
		}) ||
		ids.some((id) => typeof id !== "string" || !id) ||
		new Set(ids).size !== ids.length ||
		(cell &&
			(cell.vectors.length !== 3 ||
				cell.vectors.some(
					(row) => row.length !== 3 || row.some((value) => !Number.isFinite(value))
				) ||
				cell.pbc.length !== 3 ||
				cell.pbc.some((value) => typeof value !== "boolean"))) ||
		(structure.charge !== null && !Number.isSafeInteger(structure.charge)) ||
		(structure.multiplicity !== null &&
			(!Number.isSafeInteger(structure.multiplicity) || structure.multiplicity < 1)) ||
		(summary.energy !== null &&
			(!Number.isFinite(summary.energy?.value) ||
				typeof summary.energy?.unit !== "string" ||
				!summary.energy.unit.trim())) ||
		!Number.isSafeInteger(summary.frameIndex) ||
		summary.frameIndex < 0 ||
		(summary.sourceFrameIndex !== null &&
			(!Number.isSafeInteger(summary.sourceFrameIndex) || summary.sourceFrameIndex < 0))
	)
		throw new Error("已保存结构投影包含无效或缺失的科学字段。");
	return matches[0];
}
function singleStructure(
	structure: Structure,
	source: TrajectoryResult["source"],
	options: {
		line?: number;
		energy?: { value: number; unit: string } | null;
		summary?: ManagedSourceSummaryView;
	} = {}
): TrajectoryResult {
	const science = emptyScientificData(),
		task = options.summary?.taskKind;
	science.tasks =
		task === "optfreq"
			? ["opt", "freq"]
			: task &&
				  [
						"sp",
						"opt",
						"freq",
						"ts",
						"irc",
						"scan",
						"neb",
						"td",
						"tdopt",
						"nmr",
						"stable"
				  ].includes(task)
				? [task as (typeof science.tasks)[number]]
				: ["unknown"];
	science.source = { id: source.id, name: source.name };
	if (options.summary?.method) structure.notes.push(`已保存来源方法：${options.summary.method}。`);
	if (options.summary?.capabilities?.length)
		structure.notes.push(
			`来源能力：${options.summary.capabilities.join("、")}；本页仅显示结构和已有能量。`
		);
	return {
		id: `${source.id}:structure`,
		label: options.summary?.method
			? `${structure.name} · ${options.summary.method}`
			: structure.name,
		engine: "structure",
		kind:
			task && ["opt", "ts", "irc", "scan", "neb", "trajectory"].includes(task)
				? "optimization"
				: "calculation",
		source,
		jobIndex: 0,
		status: "unknown",
		messages: [],
		scientific: science,
		initialStructure: structure,
		frames: [
			{
				index: 0,
				sourceStep: null,
				time: null,
				energy: options.energy ?? null,
				convergence: [],
				sourceLine: options.line ?? 0,
				...(options.summary?.sourceFrameIndex === null ||
				options.summary?.sourceFrameIndex === undefined
					? {}
					: { sourceFrameIndex: options.summary.sourceFrameIndex }),
				label: options.summary ? "已保存完整结构" : "已保存结构"
			}
		],
		async getFrame(index, signal) {
			assertResultNotAborted(signal);
			if (index !== 0) throw new Error("结构帧序号越界。");
			return structuredClone(structure);
		},
		dispose() {}
	};
}
export async function readSourceOnlyMonitor(input: {
	taskId: string;
	sourceSetId: string;
	sourceVersion: string;
	files: readonly MonitorSourceFile[];
	summary?: ManagedSourceSummaryView;
	file?: ResultInputFile;
	format?: string | null;
	signal?: AbortSignal;
	onProgress?(completed: number, total: number): void;
	onPreparedFrames?(completed: number, total: number): void;
}) {
	const file = input.file,
		identity = file
			? await recognizeResultSource(file, { signal: input.signal, onProgress: input.onProgress })
			: undefined,
		candidate = validateSourceMonitorSummary(
			input.summary,
			input.sourceSetId,
			input.sourceVersion,
			input.files
		),
		// A bound last-frame projection is still only one frame. Only actual
		// single-structure wavefunction sources may use it instead of full reading.
		saved =
			candidate?.roles.includes("wavefunction") &&
			["molden", "fchk"].includes(identity?.format ?? candidate.format ?? "")
				? candidate
				: null;
	if (identity?.status === "conflict") throw new Error(identity.message);
	const sourceId = JSON.stringify([
		input.taskId,
		input.sourceSetId,
		input.sourceVersion,
		saved?.sha256 ?? file?.id
	]);
	let results: TrajectoryResult[] = [];
	try {
		if (saved && input.summary) {
			const summary = input.summary,
				software = ["gaussian", "orca", "xtb", "cp2k"].includes(summary.engineId)
					? (summary.engineId as "gaussian" | "orca" | "xtb" | "cp2k")
					: "unknown";
			results = [
				singleStructure(
					structuredClone(summary.structure) as Structure,
					{ id: sourceId, name: saved.name, size: saved.byteSize, sha256: saved.sha256, software },
					{ energy: summary.energy, summary }
				)
			];
		} else {
			if (!file) throw new Error("来源任务没有可读取的原始文件或可靠已保存投影。");
			const options = { signal: input.signal, onProgress: input.onProgress },
				kind = identity ?? (await recognizeResultSource(file, options));
			if (kind.format === "output" && ["gaussian", "orca"].includes(kind.software))
				results = await readScientificResults(file, options);
			else if (kind.format === "xyz") results = await readXyzTrajectory(file, options);
			else if (kind.format === "fchk") results = await readFchkScientificResult(file, options);
			else if (kind.format === "hess") results = await readHessScientificResult(file, options);
			else if (kind.format === "molden") {
				const read = await readMoldenStructure(file, options);
				results = [
					singleStructure(
						read.structure,
						{ id: file.id, name: file.name, size: file.size, software: kind.software },
						{ line: read.sourceLines[0] }
					)
				];
			} else if (input.format === "cube") {
				const cube = await readMolecularCube(file, { signal: input.signal }),
					factor = cube.grid.coordinateUnit === "bohr" ? 0.529177210903 : 1;
				const structure: Structure = {
					id: file.id,
					name: file.name,
					format: "cube",
					charge: null,
					multiplicity: null,
					notes: [],
					atoms: cube.atoms.map((atom) => ({
						id: `${file.id}:atom:${atom.sourceIndex}`,
						sourceIndex: atom.sourceIndex,
						element: elementSymbol(String(atom.atomicNumber)),
						x: atom.position[0] * factor,
						y: atom.position[1] * factor,
						z: atom.position[2] * factor
					}))
				};
				results = [singleStructure(structure, { id: file.id, name: file.name, size: file.size })];
			} else {
				if (kind.format === "output")
					throw new Error("此来源输出应使用对应的公共科学输出读取入口。");
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					await file.readRange(0, file.size, input.signal)
				);
				results = parseStructures(text, file.name).map((structure) =>
					singleStructure(structure, { id: file.id, name: file.name, size: file.size })
				);
			}
		}
		const frames: MonitorGeometry[] = [],
			views: TaskMonitorResultView[] = [];
		for (const result of results) {
			const indices: number[] = [];
			for (const frame of result.frames) {
				assertResultNotAborted(input.signal);
				const structure = await result.getFrame(frame.index, input.signal);
				if (!structure.atoms.length) throw new Error("来源结果没有完整普通原子结构。");
				indices.push(frames.length);
				frames.push({
					sourceKey: sourceId,
					frameId: JSON.stringify([sourceId, result.id, frame.index, frame.sourceLine]),
					atoms: structure.atoms.map((atom, index) => ({
						...atom,
						id: atom.id ?? `${sourceId}:atom:${index + 1}`
					})),
					...(structure.bonds !== undefined
						? { bonds: structure.bonds.map((bond) => ({ ...bond })) }
						: {}),
					...(structure.cell ? { cell: structuredClone(structure.cell) } : {})
				});
				input.onPreparedFrames?.(
					frames.length,
					results.reduce((sum, item) => sum + item.frames.length, 0)
				);
			}
			const { getFrame: _get, dispose: _dispose, ...data } = result;
			const prepared = indices.map(index => frames[index]);
			views.push({ result: { ...data, initialStructure: alignSourceInitialStructure(data.initialStructure, prepared) }, geometryIndices: indices });
		}
		const energyRows = results.flatMap((result) =>
			result.frames
				.filter((frame) => frame.energy)
				.map((frame) => [
					result.label,
					String(frame.index + 1),
					String(frame.energy!.value),
					frame.energy!.unit
				])
		);
		return {
			collectionId: sourceId,
			revision: JSON.stringify([sourceId, frames.length, "source-only-v1"]),
			sourceGeneration: 1,
			sourceRevision: 1,
			prepared: true as const,
			frames,
			results: views,
			cards: energyRows.length
				? [
						{
							kind: "energy",
							title: "能量",
							columns: ["来源", "帧", "能量", "单位"],
							rows: energyRows,
							sourceLabel: "原始来源或已保存同帧结果"
						}
					]
				: [],
			notices: results.flatMap(
				(result) =>
					result.scientific?.notices.map((message, index) => ({
						id: `${result.id}:${index}`,
						message,
						severity: "warning"
					})) ?? []
			),
			stage: input.summary?.taskKind ?? results[0]?.scientific?.tasks.join(" / ") ?? "structure",
			iteration: null
		};
	} finally {
		await Promise.all(results.map((result) => result.dispose()));
	}
}
