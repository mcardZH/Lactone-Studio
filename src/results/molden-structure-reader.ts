import type { Structure } from "../core/types";
import { elementSymbol } from "../core/elements";
import { scientificNumber, scientificRoundingInterval } from "./scientific-contracts";
import { outputLines } from "./optimization-reader";
import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from "./contracts";

export interface MoldenStructureRead {
	structure: Structure;
	unit: "AU" | "Angs";
	coordinateRoundingAngstrom: number[];
	coordinateRoundingByAxisAngstrom: [number, number, number][];
	sourceLines: number[];
	sourceLabels: string[];
}
const BOHR_ANGSTROM = 0.529177210903;
/** Shared Atoms-only portion of the existing Molden contract. This does not
 * parse basis/MO blocks, claim a producer/electronic state, or open a native session. */
class MoldenAtoms {
	private banner = false;
	private inAtoms = false;
	private sections = 0;
	private closedAtoms = false;
	private unit: "AU" | "Angs" | undefined;
	private atoms: Structure["atoms"] = [];
	private rounding: number[] = [];
	private axisRounding: [number, number, number][] = [];
	private lines: number[] = [];
	private labels: string[] = [];
	private damagedTail = false;
	constructor(
		private readonly name: string,
		private readonly id: string
	) {}
	consume(text: string, line: number) {
		if (/^\s*\[\s*Cell\s*\]\s*$/i.test(text))
			throw new Error("当前入口不支持Molden [Cell]，不能忽略晶胞读取为孤立分子。");
		if (this.damagedTail) return;
		if (text.includes("\0")) {
			if (this.closedAtoms) {
				this.damagedTail = true;
				return;
			}
			throw new Error("Molden文本含NUL，未读取为普通结构。");
		}
		if (/^\s*\[Molden Format\]\s*$/i.test(text)) {
			this.banner = true;
			this.inAtoms = false;
			return;
		}
		const section = text.match(/^\s*\[([^\]]+)\](.*)$/);
		if (section) {
			if (this.inAtoms) this.closedAtoms = true;
			this.inAtoms = /^atoms$/i.test(section[1].trim());
			if (this.inAtoms) {
				if (++this.sections !== 1) throw new Error("Molden有多份Atoms段，结构来源不唯一。");
				const unit = section[2].trim().toUpperCase();
				if (unit !== "AU" && unit !== "ANGS")
					throw new Error("Molden原子坐标须明确声明AU或Angs单位。");
				this.unit = unit === "AU" ? "AU" : "Angs";
			}
			return;
		}
		if (!this.inAtoms || !text.trim()) return;
		const row = text.trim().split(/\s+/);
		const ordinal = scientificNumber(row[1] ?? ""),
			nuclear = scientificNumber(row[2] ?? "");
		if (
			row.length !== 6 ||
			!Number.isSafeInteger(ordinal) ||
			ordinal !== this.atoms.length + 1 ||
			!Number.isSafeInteger(nuclear) ||
			nuclear! < 1
		)
			throw new Error("Molden原子序号、元素或核电荷不一致。");
		const element = elementSymbol(String(nuclear));
		let labelElement: string | undefined;
		try {
			labelElement = elementSymbol(row[0]);
		} catch {
			/* Atom names may be labels, e.g. C1. Nuclear Z stays explicit. */
		}
		if (labelElement && labelElement !== element) throw new Error("Molden元素标签与核电荷冲突。");
		const coordinates = row.slice(3).map(scientificNumber),
			rounding = row.slice(3).map(scientificRoundingInterval);
		if (
			coordinates.some((value) => value === null) ||
			rounding.some((value) => value === undefined)
		)
			throw new Error("Molden原子坐标无效或不完整。");
		const factor = this.unit === "AU" ? BOHR_ANGSTROM : 1;
		this.atoms.push({
			id: `${this.id}:atom:${this.atoms.length + 1}`,
			sourceIndex: this.atoms.length + 1,
			element,
			x: coordinates[0]! * factor,
			y: coordinates[1]! * factor,
			z: coordinates[2]! * factor
		});
		this.rounding.push(Math.max(...(rounding as number[])) * factor);
		this.axisRounding.push(rounding.map((value) => value! * factor) as [number, number, number]);
		this.lines.push(line);
		this.labels.push(row[0]);
	}
	finish(): MoldenStructureRead {
		if (!this.banner || !this.unit || !this.atoms.length || !this.closedAtoms)
			throw new Error("Molden没有唯一、闭合且声明单位的完整普通原子结构。");
		return {
			structure: {
				id: `${this.id}:structure`,
				name: this.name,
				format: "molden",
				atoms: this.atoms,
				charge: null,
				multiplicity: null,
				dimension: 3,
				sourceAtomIds: this.atoms.map((atom) => atom.id!),
				notes: [
					"读取Molden原始Atoms结构；电荷、多重度、总能量和波函数能力未由Atoms段推定。",
					...(this.damagedTail
						? ["Molden尾部损坏；仅保留此前闭合的完整Atoms结构，未接入波函数能力。"]
						: [])
				]
			},
			unit: this.unit,
			coordinateRoundingAngstrom: this.rounding,
			coordinateRoundingByAxisAngstrom: this.axisRounding,
			sourceLines: this.lines,
			sourceLabels: this.labels
		};
	}
}
export function parseMoldenStructure(
	text: string,
	name: string,
	sourceId = name
): MoldenStructureRead {
	const reader = new MoldenAtoms(name, sourceId);
	text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.forEach((line, index) => reader.consume(line, index + 1));
	return reader.finish();
}
export async function readMoldenStructure(
	file: ResultInputFile,
	options: ResultReadOptions = {}
): Promise<MoldenStructureRead> {
	const reader = new MoldenAtoms(file.name, file.id);
	for await (const line of outputLines(file, options)) {
		assertResultNotAborted(options.signal);
		reader.consume(line.text, line.number);
	}
	return reader.finish();
}
