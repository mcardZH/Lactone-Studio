import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eraser } from "lucide-react";
import {
	Action,
	Atom,
	Vec2,
	Elements,
	CoordinateTransformation,
	SupportedFormat,
	fromAtomAddition,
	fromAtomsAttrs,
	fromBondAddition,
	fromBondsAttrs,
	fromFragmentDeletion,
	fromMultipleMove,
	fromNewCanvas,
	type Ketcher,
	type EditorSelection
} from "ketcher-core";
import {
	applyGroup,
	graphToKet,
	placeRing,
	readKetGraph,
	cloneGraph,
	addAtom,
	addBond,
	edgeBetween,
	validateGraphEdit,
	valenceWarnings,
	type EditGraph
} from "../../modeling/two-d/editing";
import {
	fixedBondEnd,
	continuedBondEnd,
	zigzagChain,
	detachedTerminalCarbons,
	transformPoint,
	HeldElement,
	type Point2
} from "./two-d-gesture";
import {
	applyTwoDDisplayOptions,
	nativeEditorApi,
	performTwoDHistory,
	zoomTwoDViewport,
	bindTwoDNativeKeyboardScope
} from "./two-d-ketcher-api";

type Hit = { atom?: number; bond?: number };
type Tool =
	| "move"
	| "select"
	| "delete"
	| "bond"
	| "chain"
	| "element"
	| "charge+"
	| "charge-"
	| "ring"
	| "group";
type Ring = Parameters<typeof placeRing>[1]["template"];
const rings: [Ring, string][] = [
	["benzene", "苯"],
	["cyclopropane", "环丙烷"],
	["cyclobutane", "环丁烷"],
	["cyclopentane", "环戊烷"],
	["cyclopentadiene", "环戊二烯"],
	["cyclohexane", "环己烷"],
	["cycloheptane", "环庚烷"],
	["cyclooctane", "环辛烷"]
];
const bonds = [
	{ name: "单键", type: 1, stereo: 0, icon: "—" },
	{ name: "双键", type: 2, stereo: 0, icon: "═" },
	{ name: "三键", type: 3, stereo: 0, icon: "≡" },
	{ name: "实楔", type: 1, stereo: 1, icon: "◀" },
	{ name: "虚楔", type: 1, stereo: 6, icon: "◁" }
];
export function TwoDIcon({ name }: { name: string }) {
	if (name === "delete") return <Eraser size={24} strokeWidth={1.65} aria-hidden="true" />;
	const paths: Record<string, string> = {
		select: "M5 3v16l4-5 4 7 3-2-4-6 6-1Z",
		chain: "m2 16 5-8 5 8 5-8 5 8",
		plus: "M5 12h14M12 5v14",
		minus: "M5 12h14",
		open: "M3 19V5h7l2 3h9l-3 11ZM3 11h17",
		image: "M3 4h18v16H3ZM4 18l6-7 4 4 3-3 4 6M16 8h1",
		undo: "M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12",
		redo: "m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12",
		eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
		fit: "M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8Z",
		cube: "m12 2 9 5v10l-9 5-9-5V7ZM3 7l9 5 9-5M12 12v10",
		group: "M3 5h5v14H3M21 5h-5v14h5M10 8h4M10 12h4M10 16h4",
		more: "M4 12h1M11 12h1M18 12h1"
	};
	return (
		<svg
			viewBox="0 0 24 24"
			width="24"
			height="24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.65"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name] ?? paths.more} />
		</svg>
	);
}
interface Props {
	nativeReadyEpoch?: number;
	sourceEpoch?: number;
	editor: Ketcher;
	active: boolean;
	revision(): number;
	onError(message: string): void;
	onCancelReady(cancel: (() => void) | null): void;
	onHistoryChange?(history: { undo: number; redo: number }): void;
}
interface Gesture {
	epoch: number;
	pointer: number;
	revision: number;
	start: Point2;
	cursor: Point2;
	hit: Hit;
	target: Hit;
	tool: Tool;
	bond: number;
	element: string;
	ring: Ring;
	group: string;
	selection: EditorSelection;
	graph?: EditGraph;
	graphPromise?: Promise<EditGraph>;
	moved: boolean;
	shift?: boolean;
	immediateSelection?: boolean;
	transform?: { kind: "scale" | "rotate"; center: Point2; scale: number; angle: number };
}
type Preview = {
	ketCoordinates?: boolean;
	lines: [Point2, Point2, number][];
	labels?: { point: Point2; text: string }[];
	rect?: [Point2, Point2];
	error?: string;
};

/** The native canvas receives no drawing gestures in controlled mode. Its real
 * Struct/Action/selection/coordinate APIs remain the rendering and history owner. */
export default function TwoDInteractionLayer({
	nativeReadyEpoch = 0,
	sourceEpoch = 0,
	editor,
	active,
	revision,
	onError,
	onCancelReady,
	onHistoryChange
}: Props) {
	const [tool, setTool] = useState<Tool>("select"),
		[bond, setBond] = useState(0),
		[element, setElement] = useState("C");
	const [ring, setRing] = useState<Ring>("benzene"),
		[group, setGroup] = useState("COOH");
	const [preview, setPreview] = useState<Preview | null>(null),
		[hover, setHover] = useState<{ point: Point2; hit: Hit } | null>(null);
	const [label, setLabel] = useState<{
			atom: number;
			text: string;
			charge: string;
			chargeEdited?: boolean;
		} | null>(null),
		[labelError, setLabelError] = useState("");
	const [moreElements, setMoreElements] = useState(false),
		[groupOpen, setGroupOpen] = useState(false),
		[moreStructures, setMoreStructures] = useState(false);
	const [canvas, setCanvas] = useState<HTMLElement | null>(null);
	const [warnings, setWarnings] = useState<{ id: number; point: Point2; reason: string }[]>([]);
	const [warningDetail, setWarningDetail] = useState<number | null>(null);
	const [selectionEpoch, setSelectionEpoch] = useState(0);
	const pan = useRef<{ pointer: number; x: number; y: number; minX: number; minY: number } | null>(
		null
	);
	const gesture = useRef<Gesture | null>(null),
		held = useRef(new HeldElement());
	const heldTarget = useRef<{ hit: Hit; revision: number } | null>(null),
		hoverRef = useRef(hover);
	hoverRef.current = hover;
	const state = useRef({ tool, bond, element, ring, group });
	state.current = { tool, bond, element, ring, group };
	const host = useRef<HTMLDivElement>(null),
		serial = useRef(0);
	const current = useRef({ active, revision, onError, onHistoryChange });
	current.current = { active, revision, onError, onHistoryChange };
	function cancel(includeLabel = true) {
		serial.current++;
		gesture.current = null;
		pan.current = null;
		held.current.clear();
		heldTarget.current = null;
		setPreview(null);
		if (includeLabel) {
			setLabel(null);
			setLabelError("");
		}
	}
	function fail(error: unknown) {
		current.current.onError(error instanceof Error ? error.message : String(error));
	}
	function hitAt(point: Point2): Hit {
		const view = CoordinateTransformation.modelToView(
			new Vec2(point.x, point.y),
			editor.editor.render
		);
		const rect = editor.editor.render.clientArea.getBoundingClientRect();
		const hit = nativeEditorApi(editor).findItem(
			{ clientX: rect.left + view.x, clientY: rect.top + view.y },
			["atoms", "bonds"]
		);
		return hit?.map === "atoms" ? { atom: hit.id } : hit?.map === "bonds" ? { bond: hit.id } : {};
	}
	function point(event: { clientX: number; clientY: number }) {
		return CoordinateTransformation.pageToModel(event, editor.editor.render);
	}
	function length() {
		return 1; /* Ketcher model standard bond length (not render pixels). */
	}
	function atomPoint(id: number) {
		const p = editor.editor.struct().atoms.get(id)!.pp;
		return { x: p.x, y: p.y };
	}
	function nextBondEnd(g: Gesture) {
		const start = g.hit.atom === undefined ? g.start : atomPoint(g.hit.atom);
		if (g.moved) return fixedBondEnd(start, g.cursor, length());
		const neighbors: Point2[] = [],
			nearby: Point2[] = [];
		editor.editor.struct().atoms.forEach((a, id) => {
			if (id !== g.hit.atom) nearby.push(a.pp);
		});
		editor.editor.struct().bonds.forEach((b) => {
			if (b.begin === g.hit.atom) neighbors.push(atomPoint(b.end));
			if (b.end === g.hit.atom) neighbors.push(atomPoint(b.begin));
		});
		return continuedBondEnd(start, neighbors, nearby, length());
	}
	function selectionBounds(selection = editor.editor.explicitSelected()) {
		const points = (selection.atoms ?? []).map(atomPoint);
		if (!points.length) return null;
		return {
			min: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
			max: { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)) }
		};
	}
	function doAction(action: Action) {
		editor.editor.update(action);
		current.current.onHistoryChange?.(nativeEditorApi(editor).historySize());
	}
	function graphAtom(graph: EditGraph, id: number) {
		const atom = editor.editor.struct().atoms.get(id);
		if (!atom) throw new Error("目标原子已变化。");
		const candidates = graph.atoms.filter(
			(a) =>
				a.label === atom.label &&
				a.charge === (atom.charge ?? 0) &&
				Math.hypot(a.x - atom.pp.x, a.y + atom.pp.y) < 1e-5
		);
		if (candidates.length !== 1) throw new Error("重合原子无法唯一对应，请先移动目标后重试。");
		return candidates[0];
	}
	function graphBond(graph: EditGraph, id: number) {
		const bond = editor.editor.struct().bonds.get(id);
		if (!bond) throw new Error("目标键已变化。");
		const a = graphAtom(graph, bond.begin).id,
			b = graphAtom(graph, bond.end).id;
		const edge = edgeBetween(graph, a, b);
		if (!edge) throw new Error("目标键无法对应二维图。");
		return edge;
	}
	function stageBondGraph(g: Gesture, oxygen = false) {
		if (!g.graph) return;
		const graph = cloneGraph(g.graph);
		const props = bonds[g.bond];
		if (g.hit.bond !== undefined && !g.moved) {
			const edge = graphBond(graph, g.hit.bond);
			edge.order = props.type;
			edge.stereo = props.stereo;
			const result = validateGraphEdit(g.graph, graph, [edge.begin, edge.end], {
				allowHypervalence: true
			});
			return result;
		}
		let begin = g.hit.atom === undefined ? undefined : graphAtom(graph, g.hit.atom);
		let end =
			g.target.atom === undefined || g.target.atom === g.hit.atom || oxygen
				? undefined
				: graphAtom(graph, g.target.atom);
		const start = begin ?? { x: g.start.x, y: -g.start.y },
			endPoint = nextBondEnd(g),
			pos = { x: endPoint.x, y: -endPoint.y };
		const node = begin?.nodeKey ?? end?.nodeKey ?? "es-drawing-preflight";
		begin ??= addAtom(graph, node, "C", start);
		end ??= addAtom(graph, node, oxygen ? "O" : "C", pos);
		const existing = edgeBetween(graph, begin.id, end.id);
		if (existing) {
			existing.order = oxygen ? 2 : props.type;
			existing.stereo = oxygen ? 0 : props.stereo;
		} else {
			const edge = addBond(graph, begin, end, oxygen ? 2 : props.type);
			edge.stereo = oxygen ? 0 : props.stereo;
		}
		const result = validateGraphEdit(g.graph, graph, [begin.id, end.id], {
			allowHypervalence: true
		});
		return result;
	}
	function bondProblem(g: Gesture, oxygen = false): string | undefined {
		const result = stageBondGraph(g, oxygen);
		return result && !result.ok ? result.reason : undefined;
	}
	async function checkedBond(g: Gesture, oxygen = false) {
		g.graph ??= await (g.graphPromise ?? editor.getKet().then(readKetGraph));
		if (
			g.epoch !== serial.current ||
			g.revision !== current.current.revision() ||
			!current.current.active
		)
			return;
		const result = stageBondGraph(g, oxygen);
		if (result && !result.ok) throw new Error(result.reason);
		// A reliable aromatic source may require whole-conjugated-graph bond
		// redistribution. Consume that validated graph in this same action.
		if (result?.ok && g.graph?.bonds.some((b) => b.order === 4))
			await commitKet(graphToKet(result.graph), g.revision, g.epoch);
		else bondAction(g, oxygen);
	}
	async function commitKet(ket: string, expected: number, expectedEpoch = serial.current) {
		const struct = await editor.formatterFactory
			.create(SupportedFormat.ket)
			.getStructureFromStringAsync(ket);
		if (
			!current.current.active ||
			current.current.revision() !== expected ||
			expectedEpoch !== serial.current
		)
			return;
		doAction(fromNewCanvas(editor.editor.render.ctab, struct));
	}
	function deleteHit(hit: Hit) {
		const selection = editor.editor.explicitSelected();
		const selected = !!(selection.atoms?.length || selection.bonds?.length);
		const target = selected
			? selection
			: hit.atom !== undefined
				? { atoms: [hit.atom] }
				: hit.bond !== undefined
					? { bonds: [hit.bond] }
					: null;
		if (target) {
			const struct = editor.editor.struct(),
				atoms: Parameters<typeof detachedTerminalCarbons>[0] = [],
				edges: Parameters<typeof detachedTerminalCarbons>[1] = [];
			struct.atoms.forEach((atom, id) =>
				atoms.push({ ...atom, id, label: atom.label, charge: atom.charge ?? 0 })
			);
			struct.bonds.forEach((bond, id) => edges.push({ id, begin: bond.begin, end: bond.end }));
			const detached = detachedTerminalCarbons(atoms, edges, target.bonds ?? []);
			doAction(
				fromFragmentDeletion(editor.editor.render.ctab, {
					...target,
					atoms: [...new Set([...(target.atoms ?? []), ...detached])]
				})
			);
			editor.editor.selection(null);
		}
	}
	function chainGeometry(g: Gesture) {
		const start = g.hit.atom === undefined ? g.start : atomPoint(g.hit.atom);
		const count = Math.max(
			1,
			Math.round(
				Math.hypot(g.cursor.x - start.x, g.cursor.y - start.y) / ((length() * Math.sqrt(3)) / 2)
			)
		);
		let axis = g.cursor;
		if (!g.moved) {
			const end = nextBondEnd(g),
				dx = end.x - start.x,
				dy = end.y - start.y;
			axis = {
				x: start.x + dx * Math.cos(-Math.PI / 6) - dy * Math.sin(-Math.PI / 6),
				y: start.y + dx * Math.sin(-Math.PI / 6) + dy * Math.cos(-Math.PI / 6)
			};
		}
		return zigzagChain(start, axis, length(), count);
	}
	function bondAction(g: Gesture, oxygen = false) {
		const re = editor.editor.render.ctab,
			struct = editor.editor.struct(),
			props = bonds[g.bond];
		if (g.hit.bond !== undefined && !g.moved) {
			doAction(fromBondsAttrs(re, g.hit.bond, { type: props.type, stereo: props.stereo }));
			return;
		}
		const begin = g.hit.atom,
			target = g.target.atom;
		if (begin !== undefined && target === begin && g.moved) return;
		if (begin !== undefined && target !== undefined && begin !== target) {
			let existing: number | undefined;
			struct.bonds.forEach((b, id) => {
				if ((b.begin === begin && b.end === target) || (b.end === begin && b.begin === target))
					existing = id;
			});
			if (existing !== undefined) {
				doAction(fromBondsAttrs(re, existing, { type: props.type, stereo: props.stereo }));
				return;
			}
		}
		const start = begin === undefined ? g.start : atomPoint(begin),
			end = target !== undefined && target !== begin ? atomPoint(target) : nextBondEnd(g);
		const attrs = { type: oxygen ? 2 : props.type, stereo: oxygen ? 0 : props.stereo };
		doAction(
			fromBondAddition(
				re,
				attrs,
				begin ?? { label: "C" },
				target !== undefined && target !== begin && !oxygen
					? target
					: { label: oxygen ? "O" : "C" },
				new Vec2(start.x, start.y),
				new Vec2(end.x, end.y)
			)[0]
		);
	}
	function graphResult(g: Gesture) {
		if (!g.graph) return null;
		const atomId = g.hit.atom === undefined ? undefined : graphAtom(g.graph, g.hit.atom).id;
		const bondId = g.hit.bond === undefined ? undefined : graphBond(g.graph, g.hit.bond).id;
		const graphStart = { x: g.start.x, y: -g.start.y };
		const origin = atomId ? g.graph.atoms.find((a) => a.id === atomId)! : graphStart;
		const direction = g.moved ? { x: g.cursor.x - origin.x, y: -g.cursor.y - origin.y } : undefined;
		const sharedPhenyl =
			g.tool === "group" && g.group.trim().toLowerCase() === "ph" && bondId !== undefined;
		return g.tool === "ring" || sharedPhenyl
			? placeRing(g.graph, {
					template: sharedPhenyl ? "benzene" : g.ring,
					anchor: atomId ? { atomId } : bondId ? { bondId } : { position: graphStart },
					direction,
					bondLength: length(),
					allowHypervalence: true
				})
			: applyGroup(g.graph, {
					label: g.group,
					mode: atomId ? "attach" : "standalone",
					atomId,
					position: graphStart,
					direction,
					bondLength: length(),
					allowHypervalence: true
				});
	}
	function movedPoint(p: Point2, g: Gesture, dx: number, dy: number) {
		return g.transform
			? transformPoint(p, g.transform.center, g.transform.scale, g.transform.angle)
			: { x: p.x + dx, y: p.y + dy };
	}
	function draw(g: Gesture) {
		if (g.tool === "ring" || g.tool === "group") {
			const result = graphResult(g);
			if (!result) return;
			if (!result.ok) {
				setPreview({ lines: [], error: result.reason });
				return;
			}
			const atoms = new Map(result.graph.atoms.map((a) => [a.id, a]));
			setPreview({
				ketCoordinates: true,
				lines: result.graph.bonds.map((b) => [atoms.get(b.begin)!, atoms.get(b.end)!, b.order]),
				labels: result.graph.atoms
					.filter((a) => a.label !== "C")
					.map((a) => ({ point: a, text: a.label }))
			});
			return;
		}
		if (g.tool === "select") {
			setPreview({ lines: [], rect: [g.start, g.cursor] });
			return;
		}
		if (g.tool === "move") {
			const selected = new Set(g.selection.atoms ?? []);
			const dx = g.cursor.x - g.start.x,
				dy = g.cursor.y - g.start.y,
				struct = editor.editor.struct();
			const lines: Preview["lines"] = [];
			struct.bonds.forEach((b) => {
				const a = struct.atoms.get(b.begin)!,
					c = struct.atoms.get(b.end)!;
				if (selected.has(b.begin) || selected.has(b.end))
					lines.push([
						selected.has(b.begin) ? movedPoint(a.pp, g, dx, dy) : a.pp,
						selected.has(b.end) ? movedPoint(c.pp, g, dx, dy) : c.pp,
						b.type
					]);
			});
			setPreview({
				lines,
				labels:
					g.transform?.kind === "rotate"
						? [{ point: g.cursor, text: `${((g.transform.angle * 180) / Math.PI).toFixed(1)}°` }]
						: (g.selection.atoms ?? [])
								.filter((id) => !struct.atoms.get(id)!.neighbors.length)
								.map((id) => ({
									point: movedPoint(atomPoint(id), g, dx, dy),
									text: struct.atoms.get(id)!.label
								}))
			});
			return;
		}
		if (g.tool === "bond" || g.tool === "chain") {
			if (g.tool === "bond") {
				const problem = bondProblem(g);
				if (problem) {
					setPreview({ lines: [], error: problem });
					return;
				}
			}
			const start = g.hit.atom === undefined ? g.start : atomPoint(g.hit.atom);
			let end =
				g.target.atom !== undefined && g.target.atom !== g.hit.atom
					? atomPoint(g.target.atom)
					: fixedBondEnd(start, g.cursor, length());
			if (!g.moved) end = nextBondEnd(g);
			if (g.tool === "chain") {
				const points = chainGeometry(g),
					lines: Preview["lines"] = points.slice(1).map((p, i) => [points[i], p, 1]);
				setPreview({
					lines,
					labels: [{ point: points.at(-1)!, text: `新增${points.length - 1} C` }]
				});
			} else setPreview({ lines: [[start, end, bonds[g.bond].type]] });
			return;
		}
		if (g.tool === "element")
			setPreview({ lines: [], labels: [{ point: g.cursor, text: g.element }] });
	}
	function safeDraw(g: Gesture) {
		try {
			draw(g);
		} catch (error) {
			setPreview({ lines: [], error: error instanceof Error ? error.message : String(error) });
		}
	}
	async function commit(g: Gesture) {
		if (
			!current.current.active ||
			g.revision !== current.current.revision() ||
			g.epoch !== serial.current
		)
			return;
		const re = editor.editor.render.ctab;
		if (g.tool === "bond") await checkedBond(g);
		else if (g.tool === "element") {
			if (g.hit.atom !== undefined)
				doAction(fromAtomsAttrs(re, g.hit.atom, { label: g.element }, false));
			else
				doAction(
					fromAtomAddition(re, new Vec2(g.cursor.x, g.cursor.y), new Atom({ label: g.element }))
				);
		} else if (g.tool === "delete") deleteHit(g.hit);
		else if (g.tool === "charge+" || g.tool === "charge-") {
			if (g.hit.atom === undefined) return;
			const atom = editor.editor.struct().atoms.get(g.hit.atom)!;
			doAction(
				fromAtomsAttrs(
					re,
					g.hit.atom,
					{ charge: (atom.charge ?? 0) + (g.tool === "charge+" ? 1 : -1) },
					false
				)
			);
		} else if (g.tool === "select") {
			if (!g.moved && g.immediateSelection) return;
			const atoms: number[] = [],
				bonds: number[] = [];
			const a = g.start,
				b = g.cursor;
			editor.editor.struct().atoms.forEach((atom, id) => {
				if (
					atom.pp.x >= Math.min(a.x, b.x) &&
					atom.pp.x <= Math.max(a.x, b.x) &&
					atom.pp.y >= Math.min(a.y, b.y) &&
					atom.pp.y <= Math.max(a.y, b.y)
				)
					atoms.push(id);
			});
			if (!g.moved && g.hit.atom !== undefined) atoms.push(g.hit.atom);
			if (!g.moved && g.hit.bond !== undefined) bonds.push(g.hit.bond);
			if (g.shift) {
				const toggle = (before: number[] = [], found: number[]) => [
					...before.filter((id) => !found.includes(id)),
					...found.filter((id) => !before.includes(id))
				];
				editor.editor.selection({
					atoms: toggle(g.selection.atoms, atoms),
					bonds: toggle(g.selection.bonds, bonds)
				});
			} else editor.editor.selection({ atoms, bonds });
			setSelectionEpoch((value) => value + 1);
		} else if (g.tool === "move" && g.moved) {
			if (g.transform) {
				const action = new Action();
				for (const id of g.selection.atoms ?? []) {
					const p = atomPoint(id),
						q = movedPoint(p, g, 0, 0);
					action.mergeWith(fromMultipleMove(re, { atoms: [id] }, new Vec2(q.x - p.x, q.y - p.y)));
				}
				doAction(action);
			} else
				doAction(
					fromMultipleMove(
						re,
						g.selection,
						new Vec2(g.cursor.x - g.start.x, g.cursor.y - g.start.y)
					)
				);
			setSelectionEpoch((value) => value + 1);
		} else if (g.tool === "ring" || g.tool === "group") {
			if (!g.graph && g.graphPromise) g.graph = await g.graphPromise;
			const result = graphResult(g);
			if (!result) return;
			if (!result.ok) throw new Error(result.reason);
			await commitKet(graphToKet(result.graph), g.revision, g.epoch);
		} else if (g.tool === "chain") {
			g.graph ??= await editor.getKet().then(readKetGraph);
			if (
				g.epoch !== serial.current ||
				g.revision !== current.current.revision() ||
				!current.current.active
			)
				return;
			const problem = bondProblem({ ...g, bond: 0, target: {} });
			if (problem) throw new Error(problem);
			const points = chainGeometry(g),
				start = points[0];
			let begin: number | { label: string } = g.hit.atom ?? { label: "C" };
			let p = start;
			const action = new Action();
			for (let i = 1; i < points.length; i++) {
				const q = points[i];
				const [next, _aid, bid] = fromBondAddition(
					re,
					{ type: 1, stereo: 0 },
					begin,
					{ label: "C" },
					new Vec2(p.x, p.y),
					new Vec2(q.x, q.y)
				);
				action.mergeWith(next);
				begin = bid;
				p = q;
			}
			doAction(action);
		}
	}
	useEffect(() => {
		setCanvas(editor.editor.render.clientArea);
		applyTwoDDisplayOptions(editor);
		nativeEditorApi(editor).tool("select", "rectangle");
		return () => cancel();
	}, [editor]);
	useEffect(() => {
		try {
			return bindTwoDNativeKeyboardScope(editor, {
				root: () => host.current?.closest(".two-d-editor-window") ?? null,
				active: () => current.current.active,
				deferUntilOwned: true
			});
		} catch (error) {
			fail(error);
		}
	}, [editor, nativeReadyEpoch]);
	useEffect(() => {
		onCancelReady(cancel);
		return () => onCancelReady(null);
	}, [onCancelReady]);
	useEffect(() => {
		if (!active) cancel();
	}, [active]);
	useEffect(() => {
		cancel();
		setTool("select");
	}, [sourceEpoch]);
	useEffect(() => {
		let alive = true,
			sequence = 0;
		const refresh = async () => {
			const request = ++sequence;
			try {
				const graph = readKetGraph(await editor.getKet());
				if (!alive || request !== sequence) return;
				const reasons = new Map(valenceWarnings(graph).map((w) => [w.atomId, w.reason])),
					next: typeof warnings = [];
				editor.editor.struct().atoms.forEach((atom, id) => {
					const matches = graph.atoms.filter(
						(a) =>
							a.label === atom.label &&
							a.charge === (atom.charge ?? 0) &&
							Math.hypot(a.x - atom.pp.x, a.y + atom.pp.y) < 1e-5
					);
					const reason =
						(matches.length === 1 ? reasons.get(matches[0].id) : undefined) ??
						(atom.badConn
							? "二维编辑器提示该原子的价态异常，请核对元素、键级和显式氢；原图未修改。"
							: undefined);
					if (reason) next.push({ id, point: { x: atom.pp.x, y: atom.pp.y }, reason });
				});
				setWarnings(next);
			} catch {
				/* Existing source/read errors belong to the editor's error path. */
			}
		};
		const subscription = editor.editor.subscribe("change", refresh);
		void refresh();
		return () => {
			alive = false;
			sequence++;
			editor.editor.unsubscribe("change", subscription);
		};
	}, [editor, sourceEpoch]);
	useEffect(() => {
		const changed = () => setSelectionEpoch((value) => value + 1);
		const subscriber = editor.editor.subscribe("selectionChange", changed);
		const viewport = new MutationObserver(changed);
		viewport.observe(editor.editor.render.paper.canvas, {
			attributes: true,
			attributeFilter: ["viewBox"]
		});
		return () => {
			editor.editor.unsubscribe("selectionChange", subscriber);
			viewport.disconnect();
		};
	}, [editor]);
	useEffect(() => {
		if (!canvas) return;
		canvas.tabIndex = 0;
		canvas.setAttribute("data-testid", "two-d-controlled-canvas");
		canvas.setAttribute("aria-label", "二维绘图画布");
		const stop = (e: Event) => {
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		const down = (e: PointerEvent) => {
			if (!current.current.active) return;
			stop(e);
			canvas.focus({ preventScroll: true });
			if (e.button === 1) {
				const box = editor.editor.render.viewBox;
				pan.current = {
					pointer: e.pointerId,
					x: e.clientX,
					y: e.clientY,
					minX: box.minX,
					minY: box.minY
				};
				canvas.setPointerCapture(e.pointerId);
				return;
			}
			if (e.button !== 0 && e.button !== 2) return;
			const start = point(e),
				hit = hitAt(start),
				s = state.current;
			const selecting = held.current.keys.has("r") && held.current.symbol === "R";
			if (selecting) held.current.consumed = true;
			let selection = editor.editor.explicitSelected();
			const selectingTool = e.button === 0 && (selecting || s.tool === "select");
			const bounds = selectingTool ? selectionBounds(selection) : null;
			let transform: Gesture["transform"];
			if (bounds && !e.shiftKey) {
				const v1 = view(bounds.min),
					v2 = view(bounds.max),
					p = view(start);
				const a = { x: Math.min(v1.x, v2.x) - 12, y: Math.min(v1.y, v2.y) - 12 },
					b = { x: Math.max(v1.x, v2.x) + 12, y: Math.max(v1.y, v2.y) + 12 };
				const center = {
					x: (bounds.min.x + bounds.max.x) / 2,
					y: (bounds.min.y + bounds.max.y) / 2
				};
				const near = (x: number, y: number) => Math.hypot(p.x - x, p.y - y) <= 9;
				if (near((a.x + b.x) / 2, Math.min(a.y, b.y) - 28))
					transform = { kind: "rotate", center, scale: 1, angle: 0 };
				else if (
					[a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }].some((q) => near(q.x, q.y)) &&
					Math.hypot(start.x - center.x, start.y - center.y) > 0.01
				)
					transform = { kind: "scale", center, scale: 1, angle: 0 };
			}
			if (selectingTool && !transform && (hit.atom !== undefined || hit.bond !== undefined)) {
				// Use Ketcher's mature immediate click/Shift selection without ever
				// entering its live move, automatic fusion, or leave-to-commit path.
				const native = nativeEditorApi(editor).tool();
				native.mousedown(e);
				native.mouseup(e);
				editor.editor.rotateController.clean();
				selection = editor.editor.explicitSelected();
				setSelectionEpoch((value) => value + 1);
			}
			const inBounds =
				bounds &&
				start.x >= bounds.min.x &&
				start.x <= bounds.max.x &&
				start.y >= bounds.min.y &&
				start.y <= bounds.max.y;
			const moveSelection =
				selectingTool &&
				!e.shiftKey &&
				(transform || inBounds || hit.atom !== undefined || hit.bond !== undefined);
			const g: Gesture = {
				epoch: ++serial.current,
				pointer: e.pointerId,
				revision: current.current.revision(),
				start,
				cursor: start,
				hit,
				target: hit,
				tool:
					e.button === 2 ? "delete" : moveSelection ? "move" : selectingTool ? "select" : s.tool,
				bond: s.bond,
				element: s.element,
				ring: s.ring,
				group: s.group,
				selection,
				shift: e.shiftKey,
				immediateSelection: selectingTool && (hit.atom !== undefined || hit.bond !== undefined),
				transform,
				moved: false
			};
			gesture.current = g;
			canvas.setPointerCapture(e.pointerId);
			if (g.tool === "ring" || g.tool === "group" || g.tool === "bond") {
				const token = g.epoch;
				g.graphPromise = editor.getKet().then(readKetGraph);
				void g.graphPromise
					.then((graph) => {
						if (token !== serial.current || gesture.current !== g) return;
						g.graph = graph;
						safeDraw(g);
					})
					.catch(fail);
			} else safeDraw(g);
		};
		const move = (e: PointerEvent) => {
			if (!current.current.active) return;
			stop(e);
			if (pan.current?.pointer === e.pointerId) {
				const p = pan.current,
					render = editor.editor.render,
					zoom = render.options.zoom;
				render.setViewBox((previous) => ({
					...previous,
					minX: p.minX - (e.clientX - p.x) / zoom,
					minY: p.minY - (e.clientY - p.y) / zoom
				}));
				render.update(true);
				setSelectionEpoch((value) => value + 1);
				return;
			}
			const p = point(e),
				hit = hitAt(p);
			const nextHover = { point: p, hit };
			hoverRef.current = nextHover;
			setHover(nextHover);
			const g = gesture.current;
			if (!g) {
				nativeEditorApi(editor).hover(
					hit.atom !== undefined
						? { map: "atoms", id: hit.atom }
						: hit.bond !== undefined
							? { map: "bonds", id: hit.bond }
							: null,
					undefined,
					e
				);
				return;
			}
			g.cursor = p;
			g.target = hit;
			g.moved ||= Math.hypot(p.x - g.start.x, p.y - g.start.y) > 0.08;
			if (g.transform) {
				const t = g.transform,
					center = t.center;
				if (t.kind === "scale")
					t.scale = Math.max(
						0.05,
						Math.hypot(p.x - center.x, p.y - center.y) /
							Math.hypot(g.start.x - center.x, g.start.y - center.y)
					);
				else
					t.angle =
						Math.atan2(p.y - center.y, p.x - center.x) -
						Math.atan2(g.start.y - center.y, g.start.x - center.x);
			}
			safeDraw(g);
		};
		const up = (e: PointerEvent) => {
			if (!current.current.active) return;
			stop(e);
			if (pan.current?.pointer === e.pointerId) {
				pan.current = null;
				return;
			}
			const g = gesture.current;
			if (!g || g.pointer !== e.pointerId) return;
			const rect = canvas.getBoundingClientRect();
			gesture.current = null;
			setPreview(null);
			if (
				e.clientX < rect.left ||
				e.clientX > rect.right ||
				e.clientY < rect.top ||
				e.clientY > rect.bottom
			) {
				cancel();
				return;
			}
			g.cursor = point(e);
			g.target = hitAt(g.cursor);
			void commit(g).catch(fail);
		};
		const dbl = (e: MouseEvent) => {
			stop(e);
			if (state.current.tool !== "select") return;
			cancel();
			const h = hitAt(point(e));
			if (h.atom !== undefined) {
				const a = editor.editor.struct().atoms.get(h.atom)!;
				setLabel({ atom: h.atom, text: a.label, charge: String(a.charge ?? 0) });
				setLabelError("");
			} else if (h.bond !== undefined) {
				const struct = editor.editor.struct(),
					seed = struct.bonds.get(h.bond)!,
					atoms = new Set([seed.begin, seed.end]);
				let changed = true;
				while (changed) {
					changed = false;
					struct.bonds.forEach((b) => {
						if (atoms.has(b.begin) || atoms.has(b.end)) {
							if (!atoms.has(b.begin) || !atoms.has(b.end)) changed = true;
							atoms.add(b.begin);
							atoms.add(b.end);
						}
					});
				}
				const bonds: number[] = [];
				struct.bonds.forEach((b, id) => {
					if (atoms.has(b.begin) && atoms.has(b.end)) bonds.push(id);
				});
				editor.editor.selection({ atoms: [...atoms], bonds });
				setSelectionEpoch((value) => value + 1);
			}
		};
		const compatibility = (e: Event) => stop(e);
		const abort = () => cancel();
		const clearHover = () => {
			hoverRef.current = null;
			setHover(null);
			nativeEditorApi(editor).hover(null);
			heldTarget.current = null;
		};
		const blur = () => {
			clearHover();
			cancel(false);
		};
		const lostCapture = () => {
			if (gesture.current || pan.current) cancel();
		};
		const wheel = (e: WheelEvent) => {
			if (!current.current.active) return;
			stop(e);
			zoomTwoDViewport(
				editor,
				Math.max(0.1, Math.min(10, editor.editor.zoom() * Math.exp(-e.deltaY * 0.0015)))
			);
			setSelectionEpoch((value) => value + 1);
		};
		canvas.addEventListener("pointerdown", down, true);
		canvas.addEventListener("pointermove", move, true);
		canvas.addEventListener("pointerup", up, true);
		canvas.addEventListener("pointercancel", abort, true);
		canvas.addEventListener("lostpointercapture", lostCapture, true);
		canvas.addEventListener("dblclick", dbl, true);
		canvas.addEventListener("wheel", wheel, { capture: true, passive: false });
		canvas.addEventListener("blur", blur);
		canvas.addEventListener("pointerleave", clearHover);
		for (const name of ["mousedown", "mousemove", "mouseup", "click", "contextmenu"])
			canvas.addEventListener(name, compatibility, true);
		window.addEventListener("blur", abort);
		const visibility = () => {
			if (document.hidden) cancel();
		};
		document.addEventListener("visibilitychange", visibility);
		return () => {
			canvas.removeEventListener("pointerdown", down, true);
			canvas.removeEventListener("pointermove", move, true);
			canvas.removeEventListener("pointerup", up, true);
			canvas.removeEventListener("pointercancel", abort, true);
			canvas.removeEventListener("lostpointercapture", lostCapture, true);
			canvas.removeEventListener("dblclick", dbl, true);
			canvas.removeEventListener("wheel", wheel, true);
			canvas.removeEventListener("blur", blur);
			canvas.removeEventListener("pointerleave", clearHover);
			for (const name of ["mousedown", "mousemove", "mouseup", "click", "contextmenu"])
				canvas.removeEventListener(name, compatibility, true);
			window.removeEventListener("blur", abort);
			document.removeEventListener("visibilitychange", visibility);
			cancel();
		};
	}, [canvas, editor]);
	useEffect(() => {
		const scope = (e: KeyboardEvent) =>
			current.current.active &&
			!!host.current?.closest(".two-d-editor-window")?.contains(e.target as Node);
		const isInput = (e: KeyboardEvent) =>
			(e.target as HTMLElement)?.matches('input,textarea,select,[contenteditable="true"]');
		const key = (e: KeyboardEvent) => {
			if (!scope(e)) return;
			if ((e.target as HTMLElement)?.closest(".two-d-valence-warning,.two-d-valence-detail")) {
				e.stopImmediatePropagation();
				return;
			}
			if (isInput(e)) {
				return;
			}
			e.stopImmediatePropagation();
			const k = e.key.toLowerCase();
			if (e.isComposing) return;
			if ((e.ctrlKey || e.metaKey) && ["z", "y", "a"].includes(k)) {
				e.preventDefault();
				if (k === "a") {
					cancel();
					editor.editor.selection("all");
					editor.editor.rotateController.clean();
					setSelectionEpoch((value) => value + 1);
				} else if (gesture.current) cancel();
				else {
					const counts = performTwoDHistory(editor, k === "y" || e.shiftKey ? "redo" : "undo");
					current.current.onHistoryChange?.(counts);
				}
				return;
			}
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			e.preventDefault();
			if (e.repeat) return;
			if (k === "escape") {
				cancel();
				setLabel(null);
				editor.editor.selection(null);
				setTool("select");
				return;
			}
			if (k === "delete" || k === "backspace") {
				cancel();
				deleteHit(hoverRef.current?.hit ?? {});
				return;
			}
			if (gesture.current) return;
			if (/^[1-6]$/.test(k)) {
				if (k === "4") return;
				const h = hoverRef.current?.hit ?? {};
				if (k === "5" || k === "6") {
					if (h.bond === undefined) return;
					const position = hoverRef.current!.point,
						token = ++serial.current;
					const g = {
						epoch: token,
						revision: current.current.revision(),
						start: position,
						cursor: position,
						hit: h,
						target: h,
						tool: "ring",
						ring: k === "5" ? "cyclopentane" : "cyclohexane",
						moved: false
					} as Gesture;
					g.graphPromise = editor.getKet().then(readKetGraph);
					void commit(g).catch(fail);
					return;
				}
				setBond(Number(k) - 1);
				setTool("bond");
				if (h.bond !== undefined) {
					doAction(
						fromBondsAttrs(editor.editor.render.ctab, h.bond, { type: Number(k), stereo: 0 })
					);
				} else if (h.atom !== undefined && k !== "3") {
					const p = atomPoint(h.atom);
					const g = {
						epoch: serial.current,
						revision: current.current.revision(),
						start: p,
						cursor: p,
						hit: h,
						target: {},
						tool: "bond",
						bond: Number(k) - 1,
						moved: false
					} as Gesture;
					void checkedBond(g, k === "2").catch(fail);
				}
				return;
			}
			if (/^[a-z]$/.test(k)) {
				if (!held.current.keys.size)
					heldTarget.current = {
						hit: hoverRef.current?.hit ?? {},
						revision: current.current.revision()
					};
				const symbol = held.current.press(k, (s) => !!Elements.get(s));
				if (symbol !== "R" && Elements.get(symbol)) {
					setElement(symbol);
					setTool("element");
				}
				return;
			}
		};
		const release = (e: KeyboardEvent) => {
			if (!scope(e) || isInput(e)) return;
			if ((e.target as HTMLElement)?.closest(".two-d-valence-warning,.two-d-valence-detail"))
				return;
			e.stopImmediatePropagation();
			if (!/^[a-z]$/i.test(e.key)) return;
			const symbol = held.current.release(e.key),
				target = heldTarget.current;
			if (!symbol) return;
			if (symbol === "R") return;
			if (!Elements.get(symbol)) return;
			setElement(symbol);
			setTool("element");
			if (
				target?.hit.atom !== undefined &&
				target.revision === current.current.revision() &&
				hoverRef.current?.hit.atom === target.hit.atom
			) {
				doAction(
					fromAtomsAttrs(editor.editor.render.ctab, target.hit.atom, { label: symbol }, false)
				);
			}
			heldTarget.current = null;
		};
		window.addEventListener("keydown", key, true);
		window.addEventListener("keyup", release, true);
		return () => {
			window.removeEventListener("keydown", key, true);
			window.removeEventListener("keyup", release, true);
		};
	}, [editor]);
	function choose(next: Tool) {
		if (gesture.current) return;
		cancel();
		setTool(next);
		canvas?.focus({ preventScroll: true });
	}
	async function applyLabel() {
		if (!label) return;
		if (!/^[+-]?\d+$/.test(label.charge)) {
			setLabelError("形式电荷须为整数。");
			return;
		}
		try {
			const expected = revision(),
				ket = await editor.getKet(),
				graph = readKetGraph(ket);
			const atomId = graphAtom(graph, label.atom).id;
			if (!atomId) throw new Error("目标原子已变化。");
			const result = applyGroup(graph, {
				label: label.text,
				mode: "replace",
				atomId,
				bondLength: length(),
				formalCharge: label.chargeEdited ? Number(label.charge) : undefined,
				allowHypervalence: true
			});
			if (!result.ok) throw new Error(result.reason);
			await commitKet(graphToKet(result.graph), expected);
			setLabel(null);
		} catch (e) {
			setLabelError(e instanceof Error ? e.message : String(e));
		}
	}
	const view = (p: Point2, ketCoordinates = false) =>
		CoordinateTransformation.modelToView(
			new Vec2(p.x, ketCoordinates ? -p.y : p.y),
			editor.editor.render
		);
	// The epoch tracks native selection and viewport updates; coordinates stay
	// in Ketcher's model and are transformed only for this display overlay.
	void selectionEpoch;
	const selectedBounds = tool === "select" && !gesture.current ? selectionBounds() : null;
	const selectedRaw = selectedBounds
		? { a: view(selectedBounds.min), b: view(selectedBounds.max) }
		: null;
	const selectedView = selectedRaw
		? {
				a: {
					x: Math.min(selectedRaw.a.x, selectedRaw.b.x) - 12,
					y: Math.min(selectedRaw.a.y, selectedRaw.b.y) - 12
				},
				b: {
					x: Math.max(selectedRaw.a.x, selectedRaw.b.x) + 12,
					y: Math.max(selectedRaw.a.y, selectedRaw.b.y) + 12
				}
			}
		: null;
	const outer = host.current?.parentElement?.getBoundingClientRect(),
		inner = canvas?.getBoundingClientRect();
	const warningOrigin = {
		x: (inner?.left ?? 0) - (outer?.left ?? 0),
		y: (inner?.top ?? 0) - (outer?.top ?? 0)
	};
	const toolName =
		tool === "bond"
			? `${bonds[bond].name} · C`
			: tool === "element"
				? element
				: tool === "ring"
					? rings.find((r) => r[0] === ring)?.[1]
					: tool === "group"
						? group
						: tool === "chain"
							? "自动链"
							: tool === "move"
								? "移动"
								: tool === "select"
									? "选择"
									: tool === "delete"
										? "删除"
										: tool === "charge+"
											? "电荷＋"
											: "电荷－";
	return (
		<>
			<div className="two-d-controlled-left" ref={host} aria-label="二维工具">
				<button
					title="选择与移动（R）"
					aria-label="选择 R"
					aria-pressed={tool === "select"}
					onClick={() => choose("select")}
				>
					<TwoDIcon name="select" />
				</button>
				<button
					title="删除"
					aria-label="删除"
					aria-pressed={tool === "delete"}
					onClick={() => choose("delete")}
				>
					<TwoDIcon name="delete" />
				</button>
				<label>
					<span className="sr-only">键类型</span>
					<select
						aria-label="键类型"
						title={bonds[bond].name}
						value={bond}
						data-active={tool === "bond"}
						onClick={() => {
							if (!gesture.current) {
								cancel();
								setTool("bond");
							}
						}}
						onChange={(e) => {
							setBond(Number(e.target.value));
							choose("bond");
						}}
					>
						{bonds.map((b, i) => (
							<option key={b.name} value={i} title={b.name} aria-label={b.name}>
								{b.icon}
							</option>
						))}
					</select>
				</label>
				<button
					title="自动链"
					aria-label="自动链"
					aria-pressed={tool === "chain"}
					onClick={() => choose("chain")}
				>
					<TwoDIcon name="chain" />
				</button>
				<button
					title="形式电荷＋"
					aria-label="电荷＋"
					aria-pressed={tool === "charge+"}
					onClick={() => choose("charge+")}
				>
					<TwoDIcon name="plus" />
				</button>
				<button
					title="形式电荷－"
					aria-label="电荷－"
					aria-pressed={tool === "charge-"}
					onClick={() => choose("charge-")}
				>
					<TwoDIcon name="minus" />
				</button>
			</div>
			<div className="two-d-controlled-right" aria-label="元素">
				{["H", "C", "N", "O", "S", "P", "F", "Cl", "Br", "I", "B"].map((s) => (
					<button
						key={s}
						title={`元素 ${s}`}
						aria-label={s}
						aria-pressed={tool === "element" && element === s}
						onClick={() => {
							setElement(s);
							choose("element");
						}}
					>
						{s}
					</button>
				))}
				<button
					title="更多元素"
					aria-label="更多元素"
					onClick={() => setMoreElements(!moreElements)}
				>
					<TwoDIcon name="more" />
				</button>
				{moreElements && (
					<select
						aria-label="更多元素"
						value={element}
						onChange={(e) => {
							setElement(e.target.value);
							choose("element");
							setMoreElements(false);
						}}
					>
						{Elements.getAll().map((e) => (
							<option key={e.label}>{e.label}</option>
						))}
					</select>
				)}
			</div>
			<div className="two-d-controlled-bottom" aria-label="环和基团">
				{rings.map(([id, name]) => (
					<button
						title={name}
						aria-label={name}
						aria-pressed={tool === "ring" && ring === id}
						key={id}
						onClick={() => {
							setRing(id);
							choose("ring");
						}}
					>
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							aria-hidden="true"
						>
							{(() => {
								const n =
									id === "benzene" || id === "cyclohexane"
										? 6
										: id === "cyclopropane"
											? 3
											: id === "cyclobutane"
												? 4
												: id === "cycloheptane"
													? 7
													: id === "cyclooctane"
														? 8
														: 5;
								const points = Array.from({ length: n }, (_, i) => ({
									x: 12 + 9 * Math.cos((i * 2 * Math.PI) / n - Math.PI / 2),
									y: 12 + 9 * Math.sin((i * 2 * Math.PI) / n - Math.PI / 2)
								}));
								return (
									<>
										<polygon points={points.map((p) => `${p.x},${p.y}`).join(" ")} />
										{(id === "benzene" ? [0, 2, 4] : id === "cyclopentadiene" ? [0, 2] : []).map(
											(i) => (
												<line
													key={i}
													x1={12 + (points[i].x - 12) * 0.65}
													y1={12 + (points[i].y - 12) * 0.65}
													x2={12 + (points[(i + 1) % n].x - 12) * 0.65}
													y2={12 + (points[(i + 1) % n].y - 12) * 0.65}
												/>
											)
										)}
									</>
								);
							})()}
						</svg>
					</button>
				))}
				<button title="基团" aria-label="基团…" onClick={() => setGroupOpen(!groupOpen)}>
					<TwoDIcon name="group" />
				</button>
				<button
					title="更多结构"
					aria-label="更多结构…"
					onClick={() => setMoreStructures(!moreStructures)}
				>
					<TwoDIcon name="more" />
				</button>
				{moreStructures && (
					<select
						aria-label="更多结构"
						value={ring}
						onChange={(e) => {
							setRing(e.target.value as Ring);
							choose("ring");
							setMoreStructures(false);
						}}
					>
						{rings.map(([id, name]) => (
							<option key={id} value={id}>
								{name}
							</option>
						))}
					</select>
				)}
				{groupOpen && (
					<>
						<input aria-label="基团" value={group} onChange={(e) => setGroup(e.target.value)} />
						<button
							onClick={() => {
								choose("group");
								setGroupOpen(false);
							}}
						>
							使用
						</button>
					</>
				)}
			</div>
			{canvas &&
				createPortal(
					<svg className="two-d-gesture-preview" aria-hidden="true">
						{selectedView && (
							<g className="two-d-selection-handles">
								<rect
									x={Math.min(selectedView.a.x, selectedView.b.x)}
									y={Math.min(selectedView.a.y, selectedView.b.y)}
									width={Math.abs(selectedView.b.x - selectedView.a.x)}
									height={Math.abs(selectedView.b.y - selectedView.a.y)}
									fill="none"
									strokeDasharray="4 3"
								/>
								{[
									selectedView.a,
									selectedView.b,
									{ x: selectedView.a.x, y: selectedView.b.y },
									{ x: selectedView.b.x, y: selectedView.a.y }
								].map((p, i) => (
									<rect key={i} x={p.x - 4} y={p.y - 4} width="8" height="8" fill="white" />
								))}
								<line
									x1={(selectedView.a.x + selectedView.b.x) / 2}
									x2={(selectedView.a.x + selectedView.b.x) / 2}
									y1={Math.min(selectedView.a.y, selectedView.b.y)}
									y2={Math.min(selectedView.a.y, selectedView.b.y) - 28}
								/>
								<circle
									cx={(selectedView.a.x + selectedView.b.x) / 2}
									cy={Math.min(selectedView.a.y, selectedView.b.y) - 28}
									r="5"
									fill="white"
									stroke="#d5aa20"
									strokeWidth="2"
								/>
							</g>
						)}
						{hover && !preview && (
							<>
								<circle
									cx={view(hover.point).x}
									cy={view(hover.point).y}
									r={hover.hit.atom !== undefined ? 10 : 0}
									fill="none"
									stroke="#e1b424"
								/>
								<text x={view(hover.point).x + 14} y={view(hover.point).y - 12}>
									{held.current.symbol || toolName}
								</text>
							</>
						)}
						{preview?.lines.map(([a, b, order], i) => {
							const p = view(a, preview?.ketCoordinates),
								q = view(b, preview?.ketCoordinates);
							return (
								<g key={i}>
									{Array.from({ length: Math.min(3, order === 4 ? 1 : order) }, (_, j) => (
										<line
											key={j}
											x1={p.x}
											y1={p.y + (j - (order - 1) / 2) * 4}
											x2={q.x}
											y2={q.y + (j - (order - 1) / 2) * 4}
										/>
									))}
								</g>
							);
						})}
						{preview?.labels?.map((l, i) => (
							<text
								key={i}
								x={view(l.point, preview?.ketCoordinates).x + 5}
								y={view(l.point, preview?.ketCoordinates).y - 8}
							>
								{l.text}
							</text>
						))}
						{preview?.rect && (
							<rect
								x={Math.min(view(preview.rect[0]).x, view(preview.rect[1]).x)}
								y={Math.min(view(preview.rect[0]).y, view(preview.rect[1]).y)}
								width={Math.abs(view(preview.rect[1]).x - view(preview.rect[0]).x)}
								height={Math.abs(view(preview.rect[1]).y - view(preview.rect[0]).y)}
								fill="#ffdf5c33"
							/>
						)}
					</svg>,
					canvas
				)}
			{preview?.error && <div className="two-d-gesture-error">{preview.error}</div>}
			{warnings.map((w) => {
				const p = view(w.point);
				return (
					<button
						key={w.id}
						className="two-d-valence-warning"
						title="二维价态警告"
						aria-label={`原子${w.id}价态警告`}
						style={{ left: warningOrigin.x + p.x + 9, top: warningOrigin.y + p.y - 17 }}
						onClick={() => setWarningDetail((current) => (current === w.id ? null : w.id))}
					>
						!
					</button>
				);
			})}
			{warningDetail !== null && warnings.some((w) => w.id === warningDetail) && (
				<div className="two-d-valence-detail" role="status">
					{warnings.find((w) => w.id === warningDetail)!.reason}
					<button
						title="关闭价态说明"
						aria-label="关闭价态说明"
						onClick={() => setWarningDetail(null)}
					>
						×
					</button>
				</div>
			)}
			{label && (
				<div
					className="two-d-label-editor"
					role="dialog"
					aria-label="元素或基团"
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
						if (e.key === "Enter") {
							e.preventDefault();
							void applyLabel();
						}
						if (e.key === "Escape") {
							e.preventDefault();
							setLabel(null);
						}
					}}
				>
					<label>
						元素或基团
						<input
							autoFocus
							aria-label="元素或基团"
							value={label.text}
							onChange={(e) => setLabel({ ...label, text: e.target.value })}
						/>
					</label>
					<label>
						形式电荷
						<input
							aria-label="形式电荷"
							value={label.charge}
							onChange={(e) => setLabel({ ...label, charge: e.target.value, chargeEdited: true })}
						/>
					</label>
					<button onClick={() => void applyLabel()}>应用</button>
					<button onClick={() => setLabel(null)}>取消</button>
					{labelError && (
						<span role="alert">
							{labelError}
							<button aria-label="关闭错误" onClick={() => setLabelError("")}>
								×
							</button>
						</span>
					)}
				</div>
			)}
		</>
	);
}
