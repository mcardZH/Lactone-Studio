import { cross3, dot3, norm3 } from '../../core/periodic';
import type { Bond, Structure, Vector3 } from '../../core/types';
import type { CellFramePresentation } from './render/geometry';

export interface StructureLibraryPreviewSnapshot {
  structure: Structure;
  sourceAtomCount: number;
  displayAtomCount: number;
  repeats: readonly [number, number] | null;
  cellPresentation: CellFramePresentation;
}

/** Library presentation only. The source and the model-loading snapshot are
 * never edited, and this finite neighborhood must never become an import. */
export function structureLibraryPreviewSnapshot(source: Structure): StructureLibraryPreviewSnapshot {
  const structure = structuredClone(source), sourceAtomCount = source.atoms.length;
  const axes = structure.cell?.pbc.flatMap((periodic, axis) => periodic ? [axis] : []) ?? [];
  if (!structure.cell || axes.length !== 2 || !sourceAtomCount)
    return { structure, sourceAtomCount, displayAtomCount: sourceAtomCount, repeats: null, cellPresentation: 'full-box' };
  const cell = structure.cell, [u, v] = axes;
  const cross = cross3(cell.vectors[u], cell.vectors[v]), length = norm3(cross);
  if (!Number.isFinite(length) || length < 1e-10)
    return { structure, sourceAtomCount, displayAtomCount: sourceAtomCount, repeats: null, cellPresentation: 'full-box' };
  const normal = cross.map(value => value / length) as Vector3;
  const heights = source.atoms.map(atom => dot3([atom.x, atom.y, atom.z], normal));
  const centre = (Math.min(...heights) + Math.max(...heights)) / 2;
  const origin: Vector3 = cell.origin ?? [0, 0, 0], delta = centre - dot3(origin, normal);
  // Move just the display reference plane along its normal. Atomic coordinates,
  // in-plane origin, lattice vectors and true periodic directions stay intact.
  cell.origin = origin.map((value, axis) => value + delta * normal[axis]) as Vector3;
  if (sourceAtomCount * 9 > 10000)
    return { structure, sourceAtomCount, displayAtomCount: sourceAtomCount, repeats: null, cellPresentation: 'periodic-plane' };

  const images = [-1, 0, 1].flatMap(i => [-1, 0, 1].map(j => {
    const image: Vector3 = [0, 0, 0]; image[u] = i; image[v] = j; return image;
  }));
  const imageKey = (image: Vector3) => image.join(',');
  const offsets = new Map(images.map((image, index) => [imageKey(image), index * sourceAtomCount]));
  structure.atoms = images.flatMap(image => {
    const translation = [0, 1, 2].map(axis => image.reduce((sum, value, vector) => sum + value * cell.vectors[vector][axis], 0));
    return source.atoms.map(atom => ({ ...atom,
      id: image.some(Boolean) ? `${atom.id}:library-image:${imageKey(image)}` : atom.id,
      x: atom.x + translation[0], y: atom.y + translation[1], z: atom.z + translation[2],
    }));
  });
  const bonds: Bond[] = [];
  for (const image of images) for (const sourceBond of source.bonds ?? []) {
    const target = image.map((value, axis) => value + (sourceBond.image?.[axis] ?? 0)) as Vector3;
    const targetOffset = offsets.get(imageKey(target));
    if (targetOffset === undefined) continue;
    const { image: _periodicImage, ...bond } = sourceBond;
    bonds.push({ ...bond, a: offsets.get(imageKey(image))! + sourceBond.a, b: targetOffset + sourceBond.b });
  }
  structure.bonds = bonds;
  structure.sourceAtomIds = structure.atoms.map(atom => atom.id!);
  delete structure.molfile;
  return { structure, sourceAtomCount, displayAtomCount: structure.atoms.length, repeats: [3, 3], cellPresentation: 'periodic-plane' };
}

export function structureLibraryPreviewSummary(preview: StructureLibraryPreviewSnapshot): string {
  return `${preview.structure.cell ? '来源胞' : '分子'} ${preview.sourceAtomCount} 个原子${preview.repeats ? ` · ${preview.repeats.join(' × ')} 显示邻域 ${preview.displayAtomCount} 个原子` : ''}`;
}
