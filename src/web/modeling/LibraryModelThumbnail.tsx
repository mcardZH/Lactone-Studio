import { useLayoutEffect, useRef } from 'react';
import type { Structure, Vector3 } from '../../core/types';
import { elementColor } from './render/element-colors';
import { bondConnectionOnly, bondPathSections, cellSegments, type CellFramePresentation } from './render/geometry';

const WIDTH = 180, HEIGHT = 110;
const yaw = .62, pitch = .43;
const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
type Point = { x: number; y: number; depth: number };
const project = ([x, y, z]: Vector3): Point => {
  const u = cy * x + sy * z, v = -sy * x + cy * z;
  return { x: u, y: -cp * y + sp * v, depth: cp * v + sp * y };
};
const interpolate = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, depth: a.depth + (b.depth - a.depth) * t,
});

type ThumbnailSegment = { start: Point; end: Point; color: string; order: number; dashed: boolean };
export function libraryThumbnailGeometry(
  structure: Structure, elementColors?: Record<string, string>, cellPresentation: CellFramePresentation = 'full-box',
) {
  const atoms = structure.atoms.map(atom => ({ ...project([atom.x, atom.y, atom.z]), element: atom.element,
    color: elementColor(atom.element, elementColors) }));
  const frame = structure.cell ? cellSegments(structure.cell, cellPresentation).map(
    ([a, b]) => [project(a), project(b)] as const) : [];
  const segments = (structure.bonds ?? []).flatMap(bond => {
    const source = atoms[bond.a], target = atoms[bond.b];
    if (!source || !target) return [];
    const connection = bondConnectionOnly(bond);
    const order = connection || bond.aromatic ? 1 : bond.order;
    return bondPathSections(structure.atoms, bond, structure.cell).flatMap(({ start, end, t0, t1 }) => {
      const a = project(start), b = project(end);
      // Split colour at the midpoint of the real connection, including when
      // its visible sections straddle a cell boundary.
      const half = (.5 - t0) / (t1 - t0);
      const middle = interpolate(a, b, Math.max(0, Math.min(1, half)));
      return [
        ...(half > 1e-8 ? [{ start: a, end: middle, color: source.color, order, dashed: connection }] : []),
        ...(half < 1 - 1e-8 ? [{ start: middle, end: b, color: target.color, order, dashed: connection }] : []),
      ];
    });
  });
  return { atoms, frame, segments };
}

function drawThumbnail(canvas: HTMLCanvasElement, structure: Structure, elementColors: Record<string, string> | undefined,
  cellPresentation: CellFramePresentation | undefined, activeAtomIndex: number | undefined) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  const { atoms, frame, segments } = libraryThumbnailGeometry(structure, elementColors, cellPresentation);
  if (!atoms.length && !frame.length) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const measure = (point: Point) => { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); };
  for (const atom of atoms) measure(atom);
  for (const [a, b] of frame) { measure(a); measure(b); }
  for (const { start, end } of segments) { measure(start); measure(end); }
  const scale = Math.min(structure.cell ? 18 : 34, (WIDTH - 20) / Math.max(maxX - minX, 1), (HEIGHT - 19) / Math.max(maxY - minY, 1));
  const place = ({ x, y }: Point) => ({ x: WIDTH / 2 + (x - (minX + maxX) / 2) * scale, y: HEIGHT / 2 + (y - (minY + maxY) / 2) * scale });
  const stroke = (a: Point, b: Point, color: string, width: number, offsets = [0], dashed = false) => {
    const start = place(a), end = place(b), dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (length < .01) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dashed ? [1.3, 1.4] : []);
    ctx.beginPath();
    for (const offset of offsets) {
      const x = -dy * offset / length, y = dx * offset / length;
      ctx.moveTo(start.x + x, start.y + y); ctx.lineTo(end.x + x, end.y + y);
    }
    ctx.stroke();
  };
  const frameColor = canvas.ownerDocument.defaultView?.getComputedStyle(canvas).color || '#67788a';
  const radius = Math.max(1.1, Math.min(structure.cell ? 6.5 : 10, scale * .5, 32 / Math.sqrt(Math.max(1, atoms.length))));
  const atomRadius = (element: string) => element === 'H' ? radius * .72 : radius;
  ctx.lineCap = 'round';
  type Feature = { depth: number; kind: 'atom'; atom: typeof atoms[number] } | { depth: number; kind: 'segment'; segment: ThumbnailSegment };
  const features: Feature[] = [
    ...atoms.map(atom => ({ depth: atom.depth, kind: 'atom' as const, atom })),
    ...segments.map(segment => ({ depth: (segment.start.depth + segment.end.depth) / 2, kind: 'segment' as const, segment })),
  ];
  ctx.globalAlpha = .52;
  for (const [a, b] of frame) stroke(a, b, frameColor, .85);
  ctx.globalAlpha = 1;
  for (const feature of features.sort((a, b) => a.depth - b.depth)) {
    if (feature.kind === 'segment') {
      const { start, end, color, order, dashed } = feature.segment;
      const width = Math.max(.65, Math.min(2.2, radius * .52));
      const offsets = order === 3 ? [-width, 0, width] : order === 2 ? [-width * .65, width * .65] : [0];
      stroke(start, end, color, width, offsets, dashed);
    } else {
      const { atom } = feature, { x, y } = place(atom), r = atomRadius(atom.element);
      const gloss = ctx.createRadialGradient(x - r * .34, y - r * .43, 0, x, y, r);
      gloss.addColorStop(0, '#f8fcff'); gloss.addColorStop(.53, atom.color); gloss.addColorStop(1, '#455769');
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = gloss; ctx.fill();
    }
  }
  const active = activeAtomIndex === undefined ? undefined : atoms[activeAtomIndex];
  if (active) {
    const { x, y } = place(active);
    ctx.beginPath(); ctx.arc(x, y, atomRadius(active.element) + 2, 0, 2 * Math.PI);
    ctx.strokeStyle = '#168bd2'; ctx.setLineDash([]); ctx.lineWidth = 1.1; ctx.stroke();
  }
  return true;
}

export function LibraryModelThumbnail({ structure, label, elementColors, cellPresentation, sourceAtomCount, activeAtomIndex }: {
  structure: Structure; label: string; elementColors?: Record<string, string>; cellPresentation?: CellFramePresentation;
  sourceAtomCount?: number; activeAtomIndex?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (canvas.current) canvas.current.dataset.ready = String(drawThumbnail(canvas.current, structure, elementColors, cellPresentation, activeAtomIndex));
  }, [structure, elementColors, cellPresentation, activeAtomIndex]);
  return <canvas ref={canvas} className="library-model-thumbnail" width={WIDTH * 2} height={HEIGHT * 2} role="img" aria-label={label}
    data-atom-count={sourceAtomCount ?? structure.atoms.length} data-display-atom-count={structure.atoms.length} data-bond-count={structure.bonds?.length ?? 0}
    data-hydrogen-count={structure.atoms.filter(atom => atom.element === 'H').length} data-cell={structure.cell ? cellPresentation ?? 'full-box' : undefined}/>;
}
