/** Pure state used by the controlled editor. No editor mutation occurs here. */
export interface Point2 {
	x: number;
	y: number;
}
export function fixedBondEnd(start: Point2, cursor: Point2, length: number): Point2 {
	const dx = cursor.x - start.x,
		dy = cursor.y - start.y,
		norm = Math.hypot(dx, dy);
	return norm < 1e-6
		? { x: start.x + length * Math.cos(-Math.PI / 6), y: start.y + length * Math.sin(-Math.PI / 6) }
		: { x: start.x + (dx / norm) * length, y: start.y + (dy / norm) * length };
}
/** Choose a chemical drawing continuation from local adjacency, in either
 * coordinate convention. A terminal single-bond chain turns by 60 degrees
 * (120 degrees at the vertex); occupied directions and nearby nodes repel it. */
export function continuedBondEnd(
	start: Point2,
	neighbors: Point2[],
	nearby: Point2[],
	length: number
): Point2 {
	if (!neighbors.length) return fixedBondEnd(start, start, length);
	const angles = neighbors.map((p) => Math.atan2(p.y - start.y, p.x - start.x));
	let candidates: number[];
	if (angles.length === 1)
		candidates = [angles[0] + (2 * Math.PI) / 3, angles[0] - (2 * Math.PI) / 3];
	else {
		const sorted = angles.map((a) => (a + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
		const gaps = sorted.map((a, i) => ({
			angle: a,
			gap: sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 2 * Math.PI : 0) - a
		}));
		const largest = Math.max(...gaps.map((g) => g.gap));
		// Local angular compatibility comes first. Clearance only chooses among
		// equally open sectors, never distorts a standard trigonal third bond.
		candidates = gaps.filter((g) => g.gap >= largest - 1e-6).map((g) => g.angle + g.gap / 2);
	}
	let best = start,
		score = -Infinity;
	for (const angle of candidates) {
		const p = { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
		const separation = Math.min(...angles.map((a) => 1 - Math.cos(angle - a)));
		const clearance = Math.min(4, ...nearby.map((q) => Math.hypot(q.x - p.x, q.y - p.y) / length));
		// Prefer the flatter of equivalent continuations, keeping ordinary chains
		// in a repeatable zig-zag rather than curling back onto themselves.
		const value = clearance * 3 + separation - Math.abs(Math.sin(angle)) * 0.01;
		if (value > score + 1e-9) {
			best = p;
			score = value;
		}
	}
	return best;
}
/** Alternating +/-30 degree segments about the dragged axis: every segment
 * has standard length and every internal angle is 120 degrees. */
export function zigzagChain(start: Point2, axis: Point2, length: number, count: number): Point2[] {
	const angle = Math.atan2(axis.y - start.y, axis.x - start.x),
		points = [{ ...start }];
	for (let i = 0; i < count; i++) {
		const p = points.at(-1)!,
			a = angle + (i % 2 === 0 ? Math.PI / 6 : -Math.PI / 6);
		points.push({ x: p.x + length * Math.cos(a), y: p.y + length * Math.sin(a) });
	}
	return points;
}
export function detachedTerminalCarbons(
	atoms: { id: number; label: string; charge?: number; [key: string]: unknown }[],
	bonds: { id: number; begin: number; end: number }[],
	removedBondIds: number[]
): number[] {
	const removed = new Set(removedBondIds);
	return atoms
		.filter((a) => {
			const edges = bonds.filter((b) => b.begin === a.id || b.end === a.id);
			return (
				a.label === "C" &&
				!(a.charge ?? 0) &&
				edges.length === 1 &&
				removed.has(edges[0].id) &&
				![
					"isotope",
					"alias",
					"atomList",
					"rglabel",
					"radical",
					"aam",
					"stereoLabel",
					"stereoParity",
					"cip"
				].some((key) => Boolean(a[key])) &&
				!(
					a.queryProperties &&
					Object.values(a.queryProperties as object).some(
						(value) => value !== null && value !== undefined
					)
				) &&
				!(typeof a.explicitValence === "number" && a.explicitValence >= 0) &&
				![
					a.hCount,
					a.implicitHCount,
					a.ringBondCount,
					a.substitutionCount,
					a.unsaturatedAtom,
					a.attachmentPoints,
					a.invRet,
					a.exactChangeFlag
				].some((value) => typeof value === "number" && value > 0)
			);
		})
		.map((a) => a.id);
}
export function transformPoint(p: Point2, center: Point2, scale: number, angle: number): Point2 {
	const x = (p.x - center.x) * scale,
		y = (p.y - center.y) * scale;
	return {
		x: center.x + x * Math.cos(angle) - y * Math.sin(angle),
		y: center.y + x * Math.sin(angle) + y * Math.cos(angle)
	};
}
export function segmentDistance(p: Point2, a: Point2, b: Point2) {
	const dx = b.x - a.x,
		dy = b.y - a.y;
	const t = Math.max(
		0,
		Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
	);
	return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
/** A held symbol is committed only after its keys are released. No time window. */
export class HeldElement {
	readonly keys = new Set<string>();
	symbol = "";
	consumed = false;
	press(key: string, valid: (symbol: string) => boolean) {
		const letter = key.toLowerCase();
		if (this.keys.has(letter)) return this.symbol;
		this.keys.add(letter);
		if (!this.symbol) this.symbol = letter.toUpperCase();
		else if (this.keys.size > 1) {
			const candidate = this.symbol[0] + letter;
			if (valid(candidate)) this.symbol = candidate;
		}
		return this.symbol;
	}
	release(key: string) {
		this.keys.delete(key.toLowerCase());
		if (this.keys.size) return null;
		const value = this.consumed ? null : this.symbol;
		this.clear();
		return value;
	}
	clear() {
		this.keys.clear();
		this.symbol = "";
		this.consumed = false;
	}
}
