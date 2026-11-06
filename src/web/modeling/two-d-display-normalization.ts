import {
	convertReliableAromaticGraph,
	graphToKet,
	readKetGraph,
	validateEditGraph
} from "../../modeling/two-d/editing";

/** A display representation only. The caller retains the original source/KET
 * and uses the actual formatter result as its unedited display baseline. */
export function normalizeTwoDDisplayKet(rawKet: string): {
	ket: string;
	converted: boolean;
	restriction?: string;
} {
	const graph = readKetGraph(rawKet);
	if (!graph.bonds.some((b) => b.order === 4)) return { ket: rawKet, converted: false };
	const result = convertReliableAromaticGraph(graph);
	if (!result.ok) return { ket: rawKet, converted: false, restriction: result.reason };
	const problem = validateEditGraph(result.graph, result.affectedAtomIds);
	if (problem) return { ket: rawKet, converted: false, restriction: problem };
	return { ket: graphToKet(result.graph), converted: true };
}

/** Generation consumes exactly the selected visible component. Unknown/query
 * and fractional bonds cannot slip through as aromatic order 1.5. */
export function assertTwoDSelectedGraph(ket: string): void {
	const input = readKetGraph(ket),
		normalized = convertReliableAromaticGraph(input);
	if (!normalized.ok) throw new Error(normalized.reason);
	const problem = validateEditGraph(normalized.graph);
	if (problem) throw new Error(problem);
	if (input.bonds.some((b) => b.order === 4))
		throw new Error("所选结构仍含未完成显示转换的芳香键；请先明确其单双键表示。");
}
