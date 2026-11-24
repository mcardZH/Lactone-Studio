import { memo } from 'react';
import { builderCovalentValence, builderDefaultValence } from '../../core/builder-geometry';
import type { BuilderTemplate } from '../../core/builder-templates';
import type { Bond } from '../../core/types';

type Point = { x: number; y: number };
const WIDTH = 120, HEIGHT = 68;
const subscripts = '₀₁₂₃₄₅₆₇₈₉';
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const indexText = (value: number, glyphs: string) => String(value).replace(/\d/g, digit => glyphs[Number(digit)]);

function skeletalCoordinates(template: BuilderTemplate) {
  const visible = template.atoms.flatMap((atom, index) => atom.element === 'H' ? [] : [{ atom, index }]);
  const raw = visible.map(({ atom, index }) => {
    const drawn = template.depiction?.[index];
    return drawn ? { x: drawn[0], y: -drawn[1] } : { x: atom.x + atom.z * .7, y: -atom.y + atom.z * .22 };
  });
  const xs = raw.map(point => point.x), ys = raw.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const scale = Math.min(26, (WIDTH - 28) / Math.max(right - left, 1), (HEIGHT - 20) / Math.max(bottom - top, 1));
  return new Map(visible.map(({ index }, i) => [index, {
    x: WIDTH / 2 + (raw[i].x - (left + right) / 2) * scale,
    y: HEIGHT / 2 + (raw[i].y - (top + bottom) / 2) * scale,
  }]));
}

/** The shortest alternate aromatic path gives the local ring interior,
 * including for a shared edge in a fused aromatic system. */
function aromaticInterior(bond: Bond, graph: readonly Bond[], points: ReadonlyMap<number, Point>): Point | undefined {
  const queue = [[bond.a]], visited = new Set([bond.a]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i], current = path.at(-1)!;
    for (const edge of graph) {
      if (edge === bond || !edge.aromatic) continue;
      const next = edge.a === current ? edge.b : edge.b === current ? edge.a : -1;
      if (!points.has(next) || visited.has(next)) continue;
      if (next === bond.b) {
        const cycle = [...path, next].map(index => points.get(index)!);
        return { x: cycle.reduce((sum, p) => sum + p.x, 0) / cycle.length, y: cycle.reduce((sum, p) => sum + p.y, 0) / cycle.length };
      }
      visited.add(next); queue.push([...path, next]);
    }
  }
}

function atomLabel(template: BuilderTemplate, index: number, isolated: boolean) {
  const atom = template.atoms[index];
  if (atom.element === 'C' && !atom.formalCharge && !isolated) return '';
  const openValence = index === template.connectionAnchor && !template.independentOnly ? 1 : 0;
  const explicitHydrogens = template.bonds.filter(bond => bond.a === index && template.atoms[bond.b].element === 'H' || bond.b === index && template.atoms[bond.a].element === 'H').length;
  const implicitHydrogens = Math.max(0, Math.floor(builderDefaultValence(atom) - builderCovalentValence(template, index) - openValence + 1e-6));
  const hydrogens = explicitHydrogens + implicitHydrogens;
  const charge = atom.formalCharge ?? 0;
  return atom.element + (hydrogens ? 'H' + (hydrogens === 1 ? '' : indexText(hydrogens, subscripts)) : '')
    + (charge ? (Math.abs(charge) > 1 ? indexText(Math.abs(charge), superscripts) : '') + (charge > 0 ? '⁺' : '⁻') : '');
}

export const FragmentSkeletalThumbnail = memo(function FragmentSkeletalThumbnail({ template }: { template: BuilderTemplate }) {
  const points = skeletalCoordinates(template);
  const labels = new Map([...points.keys()].map(index => [index, atomLabel(template, index, points.size === 1)]));
  const line = (a: Point, b: Point, offset: number, trim = 0) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1, dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
    return { x1: a.x - dy * offset + dx * trim, y1: a.y + dx * offset + dy * trim,
      x2: b.x - dy * offset - dx * trim, y2: b.y + dx * offset - dy * trim };
  };
  return <svg className="fragment-skeletal-thumbnail" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${template.label}键线式`}>
    <g stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" fill="none">
      {template.bonds.map((bond, index) => {
        const a = points.get(bond.a), b = points.get(bond.b);
        if (!a || !b) return null;
        const wedge = template.depictionWedges?.find(([start, end]) => start === bond.a && end === bond.b || start === bond.b && end === bond.a);
        if (wedge) {
          const from = points.get(wedge[0])!, to = points.get(wedge[1])!;
          const outer = line(from, to, 3), inner = line(from, to, -3);
          if (wedge[2] > 0) return <path key={index} fill="currentColor" stroke="none" data-bond-stereo="solid" d={`M${from.x},${from.y} L${outer.x2},${outer.y2} L${inner.x2},${inner.y2} Z`}/>;
          return <g key={index} data-bond-stereo="hashed">{[.23, .46, .69, .92].map(t => <line key={t}
            x1={from.x + (outer.x2 - from.x) * t} y1={from.y + (outer.y2 - from.y) * t}
            x2={from.x + (inner.x2 - from.x) * t} y2={from.y + (inner.y2 - from.y) * t}/>)}</g>;
        }
        if (bond.aromatic) {
          const centre = aromaticInterior(bond, template.bonds, points);
          const left = centre && (b.x - a.x) * (centre.y - a.y) - (b.y - a.y) * (centre.x - a.x);
          const trim = Math.min(3, Math.hypot(b.x - a.x, b.y - a.y) / 5);
          return <g key={index} data-bond-order="aromatic"><line {...line(a, b, 0)}/><line {...line(a, b, left && left < 0 ? -3.1 : 3.1, trim)}
            strokeWidth="1.15" strokeDasharray="2.4 2.1"/></g>;
        }
        const offsets = bond.order === 3 ? [-3.05, 0, 3.05] : bond.order === 2 ? [-1.65, 1.65] : [0];
        return <g key={index} data-bond-order={bond.order}>{offsets.map(offset => <line key={offset} {...line(a, b, offset)}/>)}</g>;
      })}
    </g>
    {[...labels].map(([index, label]) => label && <text key={index} x={points.get(index)!.x} y={points.get(index)!.y}
      dominantBaseline="central" textAnchor="middle">{label}</text>)}
  </svg>;
});
