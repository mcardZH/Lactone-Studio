import type { Bond, PeriodicCell, Structure, Vector3 } from '../types';
import type { FragmentSnapshot } from './contracts';
import { createBuilderDraft } from '../builder-draft';
import { cellInverse, minimumImage, validatePeriodicEndpointImages } from '../periodic';
import { clone, getConnectedComponent } from './graph';
import { InfinitePeriodicNetworkError, resolveFinitePeriodicFragment } from './periodic-modeling';
import { validateCoordinates } from './model-document-validation';
import { validateAttachmentPorts } from './attachment-ports';
import { emptySharedConstraints, validateSharedConstraints, validateGaussianBoundCoordinates } from '../../modeling/constraints';

type SourceConnection = Omit<Bond, 'a' | 'b'> & { atomIds: [string, string] };
export interface PeriodicAppendExtraction {
  schema: 'sciyue-finite-append/v1'; sourceDocumentId: string;
  source: Pick<Structure, 'id' | 'name' | 'format' | 'cell' | 'periodicSource' | 'sourceAtomIds' | 'libraryProvenance' | 'notes'>;
  components: { atomIds: string[]; mode: 'finite-unwrapped' | 'network-selection-cut' | 'explicit-finite-set' }[];
  sourceImages: Record<string, Vector3>;
  cuts: SourceConnection[];
  omittedImageMetadata: { kind: 'deleted-bond' | 'perception-issue'; atomIds: [string, string]; image: Vector3 }[];
}
const zero = (): Vector3 => [0, 0, 0];
const sourceConnection = (structure: Structure, bond: Bond): SourceConnection => {
  const { a, b, ...properties } = bond;
  return { ...clone(properties), atomIds: [structure.atoms[a].id!, structure.atoms[b].id!] };
};

/** A selection cut is a source fact, not a target-cell bond or an inferred
 * dangling valence. Keep the original lattice and both endpoint identities. */
export function periodicSelectionNote(structure: Structure, sourceDocumentId: string, selectedIds: readonly string[]): string {
  const chosen = new Set(selectedIds);
  return 'Ester Studio periodic selection: ' + JSON.stringify({ schema: 'sciyue-periodic-selection/v1', sourceDocumentId,
    sourceStructureId: structure.id, sourceName: structure.name, sourceCell: structure.cell,
    selectedAtomIds: [...selectedIds], cuts: (structure.bonds ?? []).filter(bond => chosen.has(structure.atoms[bond.a].id!) !== chosen.has(structure.atoms[bond.b].id!)).map(bond => sourceConnection(structure, bond)) });
}

/** Normalize only an independent append into an existing periodic document.
 * Source-cell images are resolved before the resulting finite atom set joins
 * the target's single PBC. No atom/H creation, connection inference or Store
 * write occurs. Unrepresentable active constraints reject the whole append. */
export function preparePeriodicAppendFragment(input: FragmentSnapshot, sourceDocumentId: string, targetCell: PeriodicCell): { fragment: FragmentSnapshot; extraction: PeriodicAppendExtraction } {
  const original = input.structure;
  if (typeof sourceDocumentId!=='string'||!sourceDocumentId.trim() || !original.atoms.length || original.atoms.some(atom => !atom.id) || new Set(original.atoms.map(atom => atom.id)).size !== original.atoms.length || !Array.isArray(original.bonds)) throw new Error('周期追加需要明确有限原子集、稳定身份和已有连接图。');
  cellInverse(targetCell); createBuilderDraft(original, input.assignments);
  validateCoordinates(input.internalCoordinates ?? [], original);
  validateSharedConstraints(input.sharedConstraints ?? emptySharedConstraints(), input.coordinateObjects ?? [], original);
  validateGaussianBoundCoordinates(input.gaussianBoundCoordinates ?? [], input.coordinateObjects ?? [], original);
  validateAttachmentPorts(input.attachmentPorts, original);
  const fragment = clone(input), structure = fragment.structure;
  const extraction: PeriodicAppendExtraction = { schema: 'sciyue-finite-append/v1', sourceDocumentId,
    source: clone({ id: original.id, name: original.name, format: original.format, cell: original.cell, periodicSource: original.periodicSource,
      sourceAtomIds: original.sourceAtomIds, libraryProvenance: original.libraryProvenance, notes: original.notes }),
    components: [], sourceImages: {}, cuts: [], omittedImageMetadata: [] };
  const positions = new Map<string, Vector3>(), networkIds = new Set<string>();
  for (const atom of original.atoms) {
    if (positions.has(atom.id!)) continue;
    let baseIds:string[];
    if (original.cell?.pbc.some(Boolean) && !original.periodicSource) {
      try {
        const finite = resolveFinitePeriodicFragment(original, atom.id!);
        extraction.components.push({ atomIds: finite.atomIds, mode: 'finite-unwrapped' });
        for (const id of finite.atomIds) { positions.set(id, finite.positions[id]); extraction.sourceImages[id] = finite.images[id]; }
        continue;
      } catch (error) { if (!(error instanceof InfinitePeriodicNetworkError)) throw error; }
      const ids = getConnectedComponent(original, atom.id!);
      extraction.components.push({ atomIds: ids, mode: 'network-selection-cut' });
      for (const id of ids) networkIds.add(id);
      baseIds=ids;
    } else {baseIds=getConnectedComponent(original,atom.id!);extraction.components.push({ atomIds:baseIds, mode: 'explicit-finite-set' });}
    for (const id of baseIds) {
      const source = original.atoms.find(value => value.id === id)!;
      positions.set(id, [source.x, source.y, source.z]); extraction.sourceImages[id] = zero();
    }
  }
  structure.atoms = structure.atoms.map(atom => { const p = positions.get(atom.id!)!; return { ...atom, x: p[0], y: p[1], z: p[2] }; });
  const transformedImage = (ids: readonly string[], images: readonly Vector3[]): Vector3[] => {
    validatePeriodicEndpointImages(original, ids, images);
    const first = extraction.sourceImages[ids[0]], origin = images[0];
    return ids.map((id, i) => images[i].map((value, axis) => value - extraction.sourceImages[id][axis] - origin[axis] + first[axis]) as Vector3);
  };
  structure.bonds = original.bonds.filter(bond => {
    const cut = networkIds.has(original.atoms[bond.a].id!) && bond.image?.some(Boolean);
    if (cut) extraction.cuts.push(sourceConnection(original, bond)); return !cut;
  }).map(bond => {
    const ids = [original.atoms[bond.a].id!, original.atoms[bond.b].id!], images = transformedImage(ids, [zero(), bond.image ?? zero()]);
    if (images[1].some(Boolean)) throw new Error('有限追加连接仍依赖源晶格，不能套入目标晶胞。');
    return { ...clone(bond), ...(bond.image ? { image: zero() } : {}) };
  });
  const implicitImages = (ids: readonly string[]): Vector3[] => {
    const result = [zero()];
    for (let i = 1; i < ids.length; i++) {
      const a = original.atoms.findIndex(atom => atom.id === ids[i - 1]), b = original.atoms.findIndex(atom => atom.id === ids[i]);
      const edges = original.bonds!.filter(edge => edge.a === a && edge.b === b || edge.a === b && edge.b === a);
      if (edges.length > 1) throw new Error('追加内坐标缺少唯一镜像身份，不能猜测周期路径。');
      if (!edges.length && original.cell?.pbc.some(Boolean) && minimumImage(original, a, b).image.some(Boolean)) throw new Error('追加内坐标需要明确源镜像端点，不能把最短像改成目标晶格。');
      const edge = edges[0], image = edge?.image ?? zero(), sign = edge?.a === b ? -1 : 1;
      result.push(result.at(-1)!.map((value, axis) => value + sign * image[axis]) as Vector3);
    }
    return result;
  };
  const mapCoordinate = <T extends { atomIds: string[]; images?: Vector3[] }>(row: T): T => {
    const images = transformedImage(row.atomIds, row.images ?? implicitImages(row.atomIds));
    if (images.some(image => image.some(Boolean))) throw new Error('源跨切口冻结或内坐标无法保留为有限追加；整次未提交。');
    const next = clone(row); if (row.images) next.images = images; return next;
  };
  fragment.internalCoordinates = (fragment.internalCoordinates ?? []).map(mapCoordinate);
  fragment.coordinateObjects = (fragment.coordinateObjects ?? []).map(mapCoordinate);
  fragment.gaussianBoundCoordinates = fragment.gaussianBoundCoordinates?.map(mapCoordinate);
  if (fragment.sharedConstraints) fragment.sharedConstraints.coordinates = fragment.sharedConstraints.coordinates.map(mapCoordinate);
  fragment.deletedBonds = fragment.deletedBonds.flatMap(row => {
    const image = row.image ?? zero(), images = transformedImage(row.atomIds, [zero(), image]);
    if (images[1].some(Boolean)) { extraction.omittedImageMetadata.push({ kind: 'deleted-bond', atomIds: row.atomIds, image: clone(image) }); return []; }
    return [{ atomIds: [...row.atomIds] as [string, string], ...(row.image ? { image: zero() } : {}) }];
  });
  structure.bondPerceptionIssues = structure.bondPerceptionIssues?.flatMap(row => {
    const image = row.image ?? zero(), images = transformedImage(row.atomIds, [zero(), image]);
    if (images[1].some(Boolean)) { extraction.omittedImageMetadata.push({ kind: 'perception-issue', atomIds: row.atomIds, image: clone(image) }); return []; }
    return [{ ...row, ...(row.image ? { image: zero() } : {}) }];
  });
  // These are now finite source atoms in the existing target's one lattice.
  // This also lets validation use the target periodic atom budget rather than
  // treating a large framework selection as a new isolated molecule.
  structure.cell = clone(targetCell); delete structure.periodicSource; delete structure.molfile; delete structure.preparation;
  validateCoordinates(fragment.internalCoordinates, structure);
  validateSharedConstraints(fragment.sharedConstraints ?? emptySharedConstraints(), fragment.coordinateObjects, structure);
  validateGaussianBoundCoordinates(fragment.gaussianBoundCoordinates ?? [], fragment.coordinateObjects, structure);
  return { fragment, extraction };
}

/** Notes are existing portable source records. Keep source identities separate
 * from newly allocated target IDs and record only actual extraction facts. */
export function periodicAppendNote(extraction: PeriodicAppendExtraction, idMap: Readonly<Record<string, string>>): string {
  return 'Ester Studio finite append: ' + JSON.stringify({ ...extraction, atomMapping: Object.entries(idMap).map(([sourceAtomId, atomId]) => ({ sourceAtomId, atomId, sourceImage: extraction.sourceImages[sourceAtomId] })) });
}
