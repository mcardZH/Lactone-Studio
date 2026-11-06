import { ELEMENTS } from "../../core/elements";
import {
	acceptEdit,
	addAtom,
	addBond,
	atomEdges,
	cloneGraph,
	edgeBetween,
	mergeSimpleMoleculeNodes,
	nextNodeKey,
	opposite,
	rejectEdit,
	validateEditGraph,
	type EditAtom,
	type EditGraph,
	type EditPoint,
	type GraphEditResult
} from "./editing-graph";
import { assignKekule, convertReliableAromaticGraph } from "./editing-kekule";
import { parseLabel, ringDefinition, type RingTemplateName } from "./editing-templates";
export * from "./editing-graph";
export * from "./editing-templates";
export { assignKekule, convertReliableAromaticGraph } from "./editing-kekule";

const unit = (direction?: EditPoint): EditPoint => {
	const x = direction?.x ?? 1,
		y = direction?.y ?? 0,
		n = Math.hypot(x, y);
	return n > 1e-9 ? { x: x / n, y: y / n } : { x: 1, y: 0 };
};
const validLength = (value: number) => Number.isFinite(value) && value > 0;
const hasAtomStereo = (graph: EditGraph, atom: EditAtom) =>
	atom.props.stereoParity ||
	atom.props.stereoLabel ||
	atom.props.cip ||
	atomEdges(graph, atom.id).some((b) => b.stereo);

export interface GroupEditOptions {
	label: string;
	mode: "attach" | "replace" | "standalone";
	atomId?: string;
	position?: EditPoint;
	direction?: EditPoint;
	bondLength: number;
	formalCharge?: number;
	allowHypervalence?: boolean;
}
/** Ring/template interior points away from existing external connections. */
export function outwardDirection(graph: EditGraph, atomId: string): EditPoint {
	const atom = graph.atoms.find((a) => a.id === atomId)!;
	const vectors = atomEdges(graph, atomId)
		.map((b) => graph.atoms.find((a) => a.id === opposite(b, atomId))!)
		.map((p) => unit({ x: p.x - atom.x, y: p.y - atom.y }));
	const sum = vectors.reduce((s, p) => ({ x: s.x - p.x, y: s.y - p.y }), { x: 0, y: 0 });
	if (Math.hypot(sum.x, sum.y) > 1e-7) return unit(sum);
	if (!vectors.length) return { x: 1, y: 0 };
	const sorted = vectors
		.map((v) => (Math.atan2(v.y, v.x) + 2 * Math.PI) % (2 * Math.PI))
		.sort((a, b) => a - b);
	let best = sorted[0],
		gap = -1;
	sorted.forEach((a, i) => {
		const g = sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 2 * Math.PI : 0) - a;
		if (g > gap + 1e-8) {
			gap = g;
			best = a + g / 2;
		}
	});
	return { x: Math.cos(best), y: Math.sin(best) };
}
/** The same immutable result is used by preview and commit. Failed operations
 * return the exact input graph, so illegal input cannot leak partial edits. */
export function applyGroup(input: EditGraph, options: GroupEditOptions): GraphEditResult {
	const label = parseLabel(options.label);
	if (!label.ok) return rejectEdit(input, label.reason);
	if (!validLength(options.bondLength)) return rejectEdit(input, "编辑器标准键长无效。");
	if (options.formalCharge !== undefined && !Number.isSafeInteger(options.formalCharge))
		return rejectEdit(input, "形式电荷必须是有效整数。");
	const graph = cloneGraph(input),
		anchor = graph.atoms.find((a) => a.id === options.atomId);
	if (options.mode !== "standalone" && !anchor)
		return rejectEdit(input, "原节点已变化，请重新选择。");
	const nodeKey = anchor?.nodeKey ?? nextNodeKey(graph),
		direction = unit(
			options.direction ?? (anchor ? outwardDirection(graph, anchor.id) : undefined)
		),
		length = options.bondLength;
	let position = options.position ?? { x: 0, y: 0 };
	if (anchor)
		position =
			options.mode === "attach"
				? { x: anchor.x + length * direction.x, y: anchor.y + length * direction.y }
				: { x: anchor.x, y: anchor.y };
	if (![position.x, position.y].every(Number.isFinite)) return rejectEdit(input, "放置位置无效。");
	if (
		anchor &&
		options.mode === "replace" &&
		(anchor.props.isotope || ["D", "T"].includes(anchor.label))
	)
		return rejectEdit(input, "同位素节点的标签替换需先明确质量含义；原图已保留。");
	const map: Record<string, string> = {},
		bondMap: Record<string, string> = {};
	if (label.kind === "element") {
		if (options.mode === "replace") {
			anchor!.label = label.element;
			anchor!.charge = options.formalCharge ?? anchor!.charge;
			// Do not keep a misleading abbreviation after explicit element editing.
			delete anchor!.props.alias;
			const problem = validateEditGraph(graph, [anchor!.id], options);
			return problem ? rejectEdit(input, problem) : acceptEdit(graph, { attachment: anchor!.id });
		}
		const atom = addAtom(graph, nodeKey, label.element, position, options.formalCharge ?? 0);
		map.attachment = atom.id;
		if (anchor) addBond(graph, anchor, atom, 1);
		const problem = validateEditGraph(graph, [atom.id, ...(anchor ? [anchor.id] : [])], options);
		return problem ? rejectEdit(input, problem) : acceptEdit(graph, map, bondMap);
	}
	const template = label.template;
	if (anchor && options.mode === "replace") {
		const edges = atomEdges(graph, anchor.id);
		if (
			edges.some((b) => ![1, 2, 3].includes(b.order)) ||
			(!options.allowHypervalence &&
				edges.reduce((n, b) => n + b.order, 0) > template.externalBondOrderMax)
		)
			return rejectEdit(input, `${template.name}连接点只允许一根外接单键；原有外接边全部保留。`);
		if (hasAtomStereo(graph, anchor))
			return rejectEdit(input, "该节点含立体定义，基团替换无法保证原邻居手性含义；原图已保留。");
		if (!options.allowHypervalence && (anchor.props.implicitHCount ?? 0) > 0)
			return rejectEdit(input, "该节点有显式氢计数，基团替换不能静默删除或重释这些氢。");
		if (
			anchor.charge !== 0 &&
			anchor.charge !== (template.atoms[template.attachment].charge ?? 0) &&
			options.formalCharge === undefined
		)
			return rejectEdit(input, "原节点有显式非零电荷；请明确连接原子电荷后再替换，原图已保留。");
		if (
			anchor.props.queryProperties ||
			anchor.props.atomList ||
			anchor.props.rglabel ||
			anchor.props.radical ||
			(!options.allowHypervalence &&
				anchor.props.explicitValence !== undefined &&
				anchor.props.explicitValence !== -1)
		)
			return rejectEdit(input, "该节点含查询、自由基或显式价态定义，须先明确后替换基团。");
	}
	const created: EditAtom[] = [];
	template.atoms.forEach((spec, i) => {
		const point = {
			x: position.x + length * (spec.x * direction.x - spec.y * direction.y),
			y: position.y + length * (spec.x * direction.y + spec.y * direction.x)
		};
		let atom: EditAtom;
		if (options.mode === "replace" && i === template.attachment) {
			atom = anchor!;
			atom.label = spec.label;
			atom.charge = spec.charge ?? 0;
			// Mapping metadata is retained; an old alias must not survive expansion.
			delete atom.props.alias;
		} else atom = addAtom(graph, nodeKey, spec.label, point, spec.charge ?? 0, spec.props);
		if (i === template.attachment && options.formalCharge !== undefined)
			atom.charge = options.formalCharge;
		map[String(i)] = atom.id;
		created.push(atom);
	});
	template.bonds.forEach((spec, i) => {
		bondMap[String(i)] = addBond(graph, created[spec.a], created[spec.b], spec.order).id;
	});
	map.attachment = created[template.attachment].id;
	if (anchor && options.mode === "attach")
		bondMap.attachment = addBond(graph, anchor, created[template.attachment], 1).id;
	const affected = [...created.map((a) => a.id), ...(anchor ? [anchor.id] : [])];
	const problem = validateEditGraph(graph, affected, options);
	return problem ? rejectEdit(input, problem) : acceptEdit(graph, map, bondMap);
}

export interface RingEditOptions {
	template: RingTemplateName;
	anchor: { atomId: string } | { bondId: string } | { position: EditPoint };
	/** Vector from anchor/midpoint toward the desired ring interior. */
	direction?: EditPoint;
	side?: 1 | -1;
	bondLength: number;
	/** Fraction of logical standard length, independent of screen zoom. */
	tolerance?: number;
	allowHypervalence?: boolean;
}
function polygon(a: EditPoint, b: EditPoint, size: number, side: 1 | -1): EditPoint[] {
	const points = [a, b];
	let dx = b.x - a.x,
		dy = b.y - a.y;
	const angle = (side * 2 * Math.PI) / size,
		c = Math.cos(angle),
		s = Math.sin(angle);
	while (points.length < size) {
		[dx, dy] = [dx * c - dy * s, dx * s + dy * c];
		const last = points.at(-1)!;
		points.push({ x: last.x + dx, y: last.y + dy });
	}
	return points;
}
function ringPlacementCost(
	graph: EditGraph,
	points: EditPoint[],
	sharedIds: Set<string>,
	length: number
): number {
	const cross = (a: EditPoint, b: EditPoint, c: EditPoint) =>
		(b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	const inside = (p: EditPoint) => {
		let hit = false;
		for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
			const a = points[i],
				b = points[j];
			if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
				hit = !hit;
		}
		return hit;
	};
	const occupied = graph.atoms.filter((a) => !sharedIds.has(a.id));
	let cost = 0;
	for (const a of occupied) {
		const distance =
			Math.min(...points.slice(2).map((p) => Math.hypot(p.x - a.x, p.y - a.y))) / length;
		if (distance < 0.12) cost += 100;
		else cost += Math.max(0, 0.9 - distance) ** 2;
		if (inside(a) && !points.some((p) => Math.hypot(p.x - a.x, p.y - a.y) < length * 0.12))
			cost += 40;
	}
	for (let i = 1; i < points.length; i++) {
		const a = points[i],
			b = points[(i + 1) % points.length];
		for (const edge of graph.bonds) {
			const c = graph.atoms.find((p) => p.id === edge.begin)!,
				d = graph.atoms.find((p) => p.id === edge.end)!;
			if ([a, b].some((p) => [c, d].some((q) => Math.hypot(p.x - q.x, p.y - q.y) < length * 0.12)))
				continue;
			if (cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10)
				cost += 200;
		}
	}
	return cost;
}
const mergeCompatible = (graph: EditGraph, atom: EditAtom) =>
	atom.label === "C" &&
	atom.charge === 0 &&
	!atom.props.isotope &&
	!atom.props.queryProperties &&
	!atom.props.atomList &&
	!atom.props.rglabel &&
	!atom.props.radical &&
	!atom.props.alias &&
	!["hCount", "ringBondCount", "substitutionCount", "unsaturatedAtom"].some(
		(key) => atom.props[key] !== undefined
	) &&
	!hasAtomStereo(graph, atom);

export function placeRing(input: EditGraph, options: RingEditOptions): GraphEditResult {
	if (!validLength(options.bondLength)) return rejectEdit(input, "编辑器标准键长无效。");
	let definition: ReturnType<typeof ringDefinition>;
	try {
		definition = ringDefinition(options.template);
	} catch {
		return rejectEdit(input, "未知环模板。");
	}
	const { size, orders } = definition,
		length = options.bondLength,
		tolerance = (options.tolerance ?? 0.12) * length;
	if (!(tolerance > 0 && tolerance < length * 0.4)) return rejectEdit(input, "局部融合容差无效。");
	const anchor = options.anchor;
	const anchorAtom =
		"atomId" in anchor ? input.atoms.find((a) => a.id === anchor.atomId) : undefined;
	const anchorBond =
		"bondId" in anchor ? input.bonds.find((b) => b.id === anchor.bondId) : undefined;
	if (("atomId" in options.anchor && !anchorAtom) || ("bondId" in options.anchor && !anchorBond))
		return rejectEdit(input, "环的目标已变化，请重新选择。");
	if (
		anchorBond &&
		(![1, 2, 4].includes(anchorBond.order) ||
			anchorBond.stereo ||
			anchorBond.props.queryProperties ||
			anchorBond.props.topology ||
			anchorBond.props.customQuery)
	)
		return rejectEdit(input, "该键不能保真作为共边融合目标。");
	let first: EditPoint,
		second: EditPoint,
		side: 1 | -1 = options.side ?? 1,
		firstId = anchorBond?.begin,
		secondId = anchorBond?.end;
	if (anchorBond) {
		first = input.atoms.find((a) => a.id === anchorBond.begin)!;
		second = input.atoms.find((a) => a.id === anchorBond.end)!;
		// Canonical geometric orientation makes tie-breaking independent of the
		// source serializer's begin/end order, without changing the original edge.
		if (first.x > second.x || (first.x === second.x && first.y > second.y)) {
			[first, second] = [second, first];
			[firstId, secondId] = [secondId, firstId];
		}
		if (Math.hypot(second.x - first.x, second.y - first.y) < length * 0.1)
			return rejectEdit(input, "共享边退化，不能确定新环。");
		if (options.direction) {
			const cross =
				(second.x - first.x) * options.direction.y - (second.y - first.y) * options.direction.x;
			if (Math.abs(cross) > 1e-8) side = cross > 0 ? 1 : -1;
		} else if (options.side === undefined) {
			const shared = new Set([anchorBond.begin, anchorBond.end]);
			const score = (sign: 1 | -1) =>
				ringPlacementCost(input, polygon(first, second, size, sign), shared, length);
			if (score(-1) < score(1)) side = -1;
		}
	} else {
		first = anchorAtom ?? ("position" in options.anchor ? options.anchor.position : { x: 0, y: 0 });
		const d = unit(
				options.direction ?? (anchorAtom ? outwardDirection(input, anchorAtom.id) : undefined)
			),
			angle = Math.atan2(d.y, d.x) - side * (Math.PI / 2 - Math.PI / size);
		second = { x: first.x + length * Math.cos(angle), y: first.y + length * Math.sin(angle) };
	}
	const points = polygon(first, second, size, side);
	if (points.some((p) => ![p.x, p.y].every(Number.isFinite)))
		return rejectEdit(input, "环放置坐标无效。");
	let graph = cloneGraph(input);
	const nodeKey = anchorAtom?.nodeKey ?? anchorBond?.nodeKey ?? nextNodeKey(graph),
		mapped: EditAtom[] = [],
		used = new Set<string>(),
		atomMap: Record<string, string> = {},
		bondMap: Record<string, string> = {};
	for (let i = 0; i < size; i++) {
		const fixed = i === 0 ? (anchorAtom?.id ?? firstId) : i === 1 ? secondId : undefined;
		const nearby = fixed
			? graph.atoms.filter((a) => a.id === fixed)
			: graph.atoms.filter((a) => Math.hypot(a.x - points[i].x, a.y - points[i].y) <= tolerance);
		if (nearby.length > 1) return rejectEdit(input, "局部有多个顶点对应同一环点，不能唯一融合。");
		let atom: EditAtom;
		if (nearby.length) {
			atom = nearby[0];
			if (used.has(atom.id)) return rejectEdit(input, "多个环点对应同一已有原子，不能一对一融合。");
			if (!mergeCompatible(graph, atom))
				return rejectEdit(input, "几何吻合原子的元素、电荷或立体定义与环模板不兼容。");
			if (atom.nodeKey !== nodeKey) {
				const problem = mergeSimpleMoleculeNodes(graph, nodeKey, atom.nodeKey);
				if (problem) return rejectEdit(input, problem);
			}
		} else atom = addAtom(graph, nodeKey, "C", points[i]);
		used.add(atom.id);
		mapped.push(atom);
		atomMap[String(i)] = atom.id;
	}
	for (let i = 0; i < size; i++) {
		const a = mapped[i],
			b = mapped[(i + 1) % size],
			old = edgeBetween(graph, a.id, b.id);
		if (old) {
			if (
				![1, 2, 4].includes(old.order) ||
				old.stereo ||
				old.props.queryProperties ||
				old.props.topology ||
				old.props.customQuery
			)
				return rejectEdit(input, "吻合边含不能保真融合的键型或立体属性。");
			// Existing edges retain their chemistry. Only the complete affected pi
			// graph below may change a necessary single/double assignment.
			bondMap[String(i)] = old.id;
		} else bondMap[String(i)] = addBond(graph, a, b, orders[i]).id;
	}
	const pi = definition.conjugated.map((i) => mapped[i].id);
	const kekule = assignKekule(
		graph,
		mapped.map((a) => a.id),
		pi
	);
	if (!kekule.ok) {
		// A concrete integer-bond drawing may remain a warned draft. An aromatic
		// source still requires a reliable assignment; never guess its bond graph.
		if (!options.allowHypervalence || graph.bonds.some((b) => b.order === 4))
			return rejectEdit(input, kekule.reason);
	} else graph = kekule.graph;
	const affected = new Set([
		...mapped.map((a) => a.id),
		...(kekule.ok ? kekule.affectedAtomIds : [])
	]);
	const problem = validateEditGraph(graph, affected, options);
	return problem ? rejectEdit(input, problem) : acceptEdit(graph, atomMap, bondMap);
}
export const applyRing = placeRing;

/** Native simple actions can call this after staging their candidate graph.
 * Known aromatic source is whole-graph converted; unknown half/query types
 * remain restricted rather than rounded or relabelled. */
export function validateGraphEdit(
	input: EditGraph,
	candidate: EditGraph,
	affectedIds: Iterable<string>,
	options: { allowHypervalence?: boolean } = {}
): GraphEditResult {
	const ids = [...affectedIds];
	for (const id of ids) {
		const atom = candidate.atoms.find((a) => a.id === id);
		if (atom && !ELEMENTS.includes(atom.label))
			return rejectEdit(input, "该节点尚未具体化为真实元素。");
	}
	const aromatic = convertReliableAromaticGraph(candidate);
	if (!aromatic.ok) return rejectEdit(input, aromatic.reason);
	const problem = validateEditGraph(
		aromatic.graph,
		new Set([...ids, ...aromatic.affectedAtomIds]),
		options
	);
	return problem ? rejectEdit(input, problem) : acceptEdit(aromatic.graph);
}
