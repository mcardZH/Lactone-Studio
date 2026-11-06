/** Pure editor test/drawing graphs. These are not calculated structures. KET
 * attributes remain attached to their original atoms/edges and document. */
export type EditPoint = { x: number; y: number };
export type KetProperties = Record<string, any>;
export interface EditAtom extends EditPoint {
	id: string;
	nodeKey: string;
	sourceIndex: number;
	label: string;
	charge: number;
	props: KetProperties;
}
export interface EditBond {
	id: string;
	nodeKey: string;
	sourceIndex: number;
	begin: string;
	end: string;
	/** KET types: aromatic is 4; query and fractional types remain unchanged. */
	order: number;
	stereo?: number;
	props: KetProperties;
}
export interface EditGraph {
	atoms: EditAtom[];
	bonds: EditBond[];
	document: KetProperties;
	/** Explicit source-node merges; original source document remains untouched. */
	mergedNodeKeys?: string[];
}
export type GraphEditResult =
	| { ok: true; graph: EditGraph; atomMap: Record<string, string>; bondMap: Record<string, string> }
	| { ok: false; graph: EditGraph; reason: string };
export const rejectEdit = (graph: EditGraph, reason: string): GraphEditResult => ({
	ok: false,
	graph,
	reason
});
export const acceptEdit = (
	graph: EditGraph,
	atomMap: Record<string, string> = {},
	bondMap: Record<string, string> = {}
): GraphEditResult => ({ ok: true, graph, atomMap, bondMap });
const object = (value: any): value is KetProperties =>
	!!value && typeof value === "object" && !Array.isArray(value);
export const cloneGraph = (graph: EditGraph): EditGraph => structuredClone(graph);
export const atomEdges = (graph: EditGraph, id: string) =>
	graph.bonds.filter((b) => b.begin === id || b.end === id);
export const opposite = (bond: EditBond, id: string) => (bond.begin === id ? bond.end : bond.begin);
export const edgeBetween = (graph: EditGraph, a: string, b: string) =>
	graph.bonds.find(
		(edge) => (edge.begin === a && edge.end === b) || (edge.begin === b && edge.end === a)
	);

export function readKetGraph(ket: string): EditGraph {
	const document = JSON.parse(ket);
	if (
		!object(document) ||
		!object(document.root) ||
		(document.root.nodes !== undefined && !Array.isArray(document.root.nodes))
	)
		throw new Error("二维KET根节点无效。");
	const graph: EditGraph = { atoms: [], bonds: [], document };
	const seen = new Set<string>();
	for (const ref of document.root.nodes ?? []) {
		const key = ref.$ref;
		if (typeof key !== "string" || document[key]?.type !== "molecule" || seen.has(key)) continue;
		seen.add(key);
		const node = document[key];
		if (!Array.isArray(node.atoms) || (node.bonds !== undefined && !Array.isArray(node.bonds)))
			throw new Error("二维分子原子或键列表无效。");
		node.atoms.forEach((a: any, i: number) => {
			if (
				!object(a) ||
				!Array.isArray(a.location) ||
				!a.location.slice(0, 2).every(Number.isFinite) ||
				a.location.length < 2 ||
				!Number.isSafeInteger(a.charge ?? 0)
			)
				throw new Error("二维原子坐标或电荷无效。");
			graph.atoms.push({
				id: `${key}:a:${i}`,
				nodeKey: key,
				sourceIndex: i,
				label: a.label ?? "*",
				x: a.location[0],
				y: a.location[1],
				charge: a.charge ?? 0,
				props: structuredClone(a)
			});
		});
		(node.bonds ?? []).forEach((b: any, i: number) => {
			if (
				!object(b) ||
				!Array.isArray(b.atoms) ||
				b.atoms.length !== 2 ||
				b.atoms.some((n: any) => !Number.isSafeInteger(n) || n < 0 || n >= node.atoms.length) ||
				b.atoms[0] === b.atoms[1]
			)
				throw new Error("二维键端点无效。");
			graph.bonds.push({
				id: `${key}:b:${i}`,
				nodeKey: key,
				sourceIndex: i,
				begin: `${key}:a:${b.atoms[0]}`,
				end: `${key}:a:${b.atoms[1]}`,
				order: b.type,
				...(b.stereo !== undefined ? { stereo: b.stereo } : {}),
				props: structuredClone(b)
			});
		});
	}
	return graph;
}

/** Existing atom/edge ordering is retained. Edits append entries, so sgroup,
 * stereo and mapping references do not need a lossy reconstruction. */
export function graphToKet(graph: EditGraph): string {
	const document = structuredClone(graph.document);
	const keys = new Set([
		...graph.atoms.map((a) => a.nodeKey),
		...graph.bonds.map((b) => b.nodeKey)
	]);
	document.root ??= {};
	document.root.nodes ??= [];
	if (graph.mergedNodeKeys?.length) {
		const removed = new Set(graph.mergedNodeKeys);
		document.root.nodes = document.root.nodes.filter((ref: any) => !removed.has(ref.$ref));
		for (const key of removed) delete document[key];
	}
	for (const key of keys) {
		const atoms = graph.atoms.filter((a) => a.nodeKey === key);
		const indices = new Map(atoms.map((a, i) => [a.id, i]));
		const old = document[key];
		if (!old) {
			document[key] = { type: "molecule" };
			document.root.nodes.push({ $ref: key });
		}
		document[key].atoms = atoms.map((a) => ({
			...structuredClone(a.props),
			label: a.label,
			location: [a.x, a.y, ...(Array.isArray(a.props.location) ? a.props.location.slice(2) : [0])],
			...(a.charge !== 0 || a.props.charge !== undefined ? { charge: a.charge } : {})
		}));
		document[key].bonds = graph.bonds
			.filter((b) => b.nodeKey === key)
			.map((b) => {
				if (!indices.has(b.begin) || !indices.has(b.end))
					throw new Error("不能把跨分子节点的键写入KET。");
				return {
					...structuredClone(b.props),
					atoms: [indices.get(b.begin), indices.get(b.end)],
					type: b.order,
					...(b.stereo !== undefined ? { stereo: b.stereo } : {})
				};
			});
	}
	return JSON.stringify(document);
}

/** Simple molecule nodes have no indexed sgroup/query/annotation tables to
 * migrate. Their atoms/edges can be merged reversibly in a single graph action.
 * Rich nodes require an explicit table migration rather than dropping fields. */
export function mergeSimpleMoleculeNodes(
	graph: EditGraph,
	target: string,
	source: string
): string | null {
	if (target === source) return null;
	for (const key of [target, source]) {
		const node = graph.document[key];
		if (node && Object.keys(node).some((k) => !["type", "atoms", "bonds"].includes(k)))
			return "跨节点融合涉及结构组或额外节点属性，须先核明确切引用迁移；原图已保留。";
	}
	for (const atom of graph.atoms) if (atom.nodeKey === source) atom.nodeKey = target;
	for (const bond of graph.bonds) if (bond.nodeKey === source) bond.nodeKey = target;
	graph.mergedNodeKeys = [...new Set([...(graph.mergedNodeKeys ?? []), source])];
	return null;
}

// Ketcher 3.18's actual KET schema requires molecule refs/keys to match molN.
// Internal atom IDs may stay arbitrary; root source node keys are not renamed.
export function nextNodeKey(graph: EditGraph): string {
	let i = 0;
	while (graph.document[`mol${i}`] || graph.atoms.some((a) => a.nodeKey === `mol${i}`)) i++;
	return `mol${i}`;
}
export function addAtom(
	graph: EditGraph,
	nodeKey: string,
	label: string,
	point: EditPoint,
	charge = 0,
	props: KetProperties = {}
): EditAtom {
	let i = 0;
	while (graph.atoms.some((a) => a.id === `${nodeKey}:new:a:${i}`)) i++;
	const atom = {
		id: `${nodeKey}:new:a:${i}`,
		nodeKey,
		sourceIndex: -1,
		label,
		...point,
		charge,
		props: structuredClone(props)
	};
	graph.atoms.push(atom);
	return atom;
}
export function addBond(graph: EditGraph, a: EditAtom, b: EditAtom, order: number): EditBond {
	let i = 0;
	while (graph.bonds.some((e) => e.id === `${a.nodeKey}:new:b:${i}`)) i++;
	const edge = {
		id: `${a.nodeKey}:new:b:${i}`,
		nodeKey: a.nodeKey,
		sourceIndex: -1,
		begin: a.id,
		end: b.id,
		order,
		props: {}
	};
	graph.bonds.push(edge);
	return edge;
}

/** Explicit source H counts and H atoms are never removed to admit an edit. */
export function atomValenceLimit(atom: EditAtom): number | undefined {
	const q = atom.charge;
	if (["C", "Si"].includes(atom.label)) return q === 0 ? 4 : Math.abs(q) === 1 ? 3 : undefined;
	if (atom.label === "H") return 1;
	if (atom.label === "B") return q === -1 ? 4 : 3;
	if (atom.label === "N") return q === 1 ? 4 : q === -1 ? 2 : 3;
	if (atom.label === "O") return q === 1 ? 3 : q === -1 ? 1 : 2;
	if (["F", "Cl", "Br", "I"].includes(atom.label)) return q === -1 ? 0 : 1;
	if (atom.label === "P") return 5;
	if (atom.label === "S") return 6;
	return undefined; // Do not invent a single valence rule for transition metals.
}
export interface ValenceWarning {
	atomId: string;
	reason: string;
}
export function valenceWarnings(
	graph: EditGraph,
	affectedIds?: Iterable<string>
): ValenceWarning[] {
	const ids = affectedIds ? new Set(affectedIds) : undefined,
		warnings: ValenceWarning[] = [];
	for (const atom of graph.atoms) {
		if (ids && !ids.has(atom.id)) continue;
		const edges = atomEdges(graph, atom.id);
		if (edges.some((b) => ![1, 2, 3].includes(b.order))) continue;
		const h = atom.props.implicitHCount ?? 0;
		if (!Number.isSafeInteger(h) || h < 0) continue;
		const valence = edges.reduce((n, b) => n + b.order, 0) + h,
			max = atomValenceLimit(atom);
		if (max !== undefined && valence > max)
			warnings.push({
				atomId: atom.id,
				reason: `${atom.label}的键级与显式氢合计${valence}，超过当前价态${max}；二维草稿已保留，生成三维前须修正。`
			});
		else if (
			atom.props.explicitValence !== undefined &&
			atom.props.explicitValence !== -1 &&
			valence > atom.props.explicitValence
		)
			warnings.push({
				atomId: atom.id,
				reason: "连接超过原子已有显式价态；二维草稿已保留，生成三维前须修正。"
			});
	}
	return warnings;
}
export function validateEditGraph(
	graph: EditGraph,
	affectedIds?: Iterable<string>,
	options: { allowHypervalence?: boolean } = {}
): string | null {
	const ids = affectedIds ? new Set(affectedIds) : undefined,
		edges = new Set<string>();
	for (const edge of graph.bonds) {
		const key = [edge.begin, edge.end].sort().join("\0");
		if (edge.begin === edge.end || edges.has(key)) return "存在重复键或自连接，原图已保留。";
		edges.add(key);
		if (
			!graph.atoms.some((a) => a.id === edge.begin) ||
			!graph.atoms.some((a) => a.id === edge.end)
		)
			return "化学键引用不存在的原子。";
	}
	for (const atom of graph.atoms) {
		if (ids && !ids.has(atom.id)) continue;
		if (!Number.isSafeInteger(atom.charge)) return "形式电荷必须是有效整数。";
		const bonds = atomEdges(graph, atom.id);
		if (
			bonds.some(
				(b) =>
					![1, 2, 3].includes(b.order) ||
					b.props.queryProperties ||
					b.props.topology ||
					b.props.customQuery
			)
		)
			return "此处包含未明确或查询键，不能保真执行该连接。";
		if (
			atom.props.queryProperties ||
			atom.props.atomList ||
			atom.props.rglabel ||
			atom.props.radical ||
			["hCount", "ringBondCount", "substitutionCount", "unsaturatedAtom"].some(
				(key) => atom.props[key] !== undefined
			)
		)
			return "此处包含查询原子或自由基，须先明确后再连接。";
		const h = atom.props.implicitHCount ?? 0;
		if (!Number.isSafeInteger(h) || h < 0) return "显式氢计数无效。";
		const valence = bonds.reduce((n, b) => n + b.order, 0) + h,
			max = atomValenceLimit(atom);
		if (!options.allowHypervalence && max !== undefined && valence > max)
			return `${atom.label}的连接与显式氢超过允许价态；不会删除氢或改变电荷。`;
		if (
			!options.allowHypervalence &&
			atom.props.explicitValence !== undefined &&
			atom.props.explicitValence !== -1 &&
			valence > atom.props.explicitValence
		)
			return "连接不符合原子已有显式价态。";
	}
	return null;
}
