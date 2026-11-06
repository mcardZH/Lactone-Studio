import type { BuilderAssignments } from '../builder-draft';
import { createBuilderDraft } from '../builder-draft';
import { builderCoordinateValue, builderVector } from '../builder-geometry';
import { fractionalToCartesian, cartesianToFractional, cellInverse } from '../periodic';
import type { Structure, Vector3 } from '../types';
import type { ModelDocument, StructureTransformCandidate, StructureTransformAtomMapping } from './contracts';
import { getFrozenAtomIds, clone, emptySelection } from './graph';
import { effectiveModelCoordinates } from '../../modeling/constraints';
import { MODEL_CONSTRAINT_TOLERANCE, validateExtras } from './model-document-validation';
import { updateBuilderStereo } from '../builder-stereo';

type Tuple = { atomIds: string[]; images?: Vector3[]; id?: string; objectId?: string; rowId?: string };
const zero = (): Vector3 => [0, 0, 0];
const identity = (): [Vector3, Vector3, Vector3] => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const vector = (v: unknown): v is Vector3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const sources = (entry: StructureTransformAtomMapping) => entry.sourceAtomIds ?? [entry.sourceAtomId];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Validates lineage and maps every model-owned field before any Store/history
 * mutation. The Store remains responsible for the source guard and atomic
 * publication, including linked members and inactive task contexts. */
export function mapStructureTransformDocument(document: ModelDocument, candidate: StructureTransformCandidate): ModelDocument {
  if (candidate.documentId !== document.id || candidate.expectedRevision !== document.revision) throw new Error('几何候选已过期或来自其它文档。');
  if (!candidate.operation || !Array.isArray(candidate.atomMapping) || !candidate.structure || candidate.structure.id !== document.draft.structure.id) throw new Error('几何候选身份或映射无效。');
  const original = document.draft.structure, sourceAtoms = new Map(original.atoms.map(atom => [atom.id!, atom])), structure = clone(candidate.structure);
  if (!structure.atoms.length || !Array.isArray(structure.bonds)) throw new Error('几何候选原子数超出本地范围或缺少明确连接图。');
  const targetAtoms = new Map(structure.atoms.map(atom => [atom.id!, atom])), byTarget = new Map<string, StructureTransformAtomMapping>();
  const bySource = new Map<string, StructureTransformAtomMapping[]>(), labels = new Set<string>();
  for (const entry of candidate.atomMapping) {
    if (!entry || !targetAtoms.has(entry.atomId) || byTarget.has(entry.atomId) || !sourceAtoms.has(entry.sourceAtomId) || !vector(entry.image) || !entry.image.every(Number.isSafeInteger)
      || entry.image.some((value, axis) => value !== 0 && !original.cell?.pbc[axis]) || entry.copyKey !== undefined && (typeof entry.copyKey !== 'string' || !entry.copyKey)) throw new Error('几何候选的原子来源、复制或镜像无效。');
    const ids = sources(entry);
    if (!Array.isArray(ids) || !ids.length || !ids.includes(entry.sourceAtomId) || new Set(ids).size !== ids.length || ids.some(id => !sourceAtoms.has(id))) throw new Error('并胞等价原子来源不完整。');
    const atom = targetAtoms.get(entry.atomId)!;
    if (ids.some(id => sourceAtoms.get(id)!.element !== atom.element || (sourceAtoms.get(id)!.formalCharge ?? 0) !== (atom.formalCharge ?? 0))) throw new Error('几何变换不能改变元素或形式电荷。');
    if (sourceAtoms.has(entry.atomId) && !ids.includes(entry.atomId)) throw new Error('几何候选不能把已有稳定ID分配给另一原子。');
    const label = JSON.stringify([entry.sourceAtomId, entry.image, entry.copyKey ?? '']);
    if (labels.has(label)) throw new Error('复制原子缺少唯一来源实例。'); labels.add(label);
    byTarget.set(entry.atomId, entry); for (const id of ids) { const entries = bySource.get(id) ?? []; entries.push(entry); bySource.set(id, entries); }
  }
  if (byTarget.size !== structure.atoms.length || targetAtoms.size !== structure.atoms.length) throw new Error('候选必须逐原子提供唯一完整来源映射。');
  structure.format ??= original.format; structure.notes ??= clone(original.notes);
  // Diagram/source-index projections are rebuilt by stable lineage, not by a
  // primitive/conventional cell's new array indices.
  if(original.layout2D)structure.layout2D=Object.fromEntries(structure.atoms.map(atom=>[atom.id!,clone(original.layout2D![byTarget.get(atom.id!)!.sourceAtomId]??{x:atom.x,y:atom.y})]));
  delete structure.mapping;
  const basis = candidate.latticeImageBasis ?? identity();
  if (basis.length !== 3 || basis.some(row => !vector(row))) throw new Error('晶格镜像变换必须为有限3×3矩阵。');
  if (structure.cell) cellInverse(structure.cell);
  // Validate the candidate graph/cell before mapping any metadata. Use a local
  // draft only; creation cannot infer a periodic graph or mutate a Store.
  // The candidate owns geometry/graph; source-owned contact and 2D metadata
  // are remapped below before full validation. They may still use source IDs.
  createBuilderDraft({ ...structure, bondPerceptionIssues: undefined, layout2D: undefined });
  const mapMembers = (ids: string[]) => structure.atoms.filter(atom => sources(byTarget.get(atom.id!)!).some(id => ids.includes(id))).map(atom => atom.id!);
  const assertMergeMembership = (rows: { atomIds: string[]; id?: string; name?: string }[]) => {
    for (const entry of candidate.atomMapping) {
      const signatures = sources(entry).map(id => rows.flatMap((row, index) => row.atomIds.includes(id) ? [row.id ?? row.name ?? index] : []));
      if (signatures.some(signature => !equal(signature, signatures[0]))) throw new Error('等价原子具有不同分组或区域定义，不能安全并胞。');
    }
  };
  const mapAssignments = (assignments: BuilderAssignments): BuilderAssignments => {
    const next = clone(assignments);
    for (const category of ['layers', 'basis', 'fragments'] as const) { assertMergeMembership(assignments[category]); next[category] = assignments[category].map(row => ({ ...clone(row), atomIds: mapMembers(row.atomIds) })); }
    next.frozenAtomIds = mapMembers(assignments.frozenAtomIds); return next;
  };
  const endpointImages = (row: Tuple): Vector3[] => {
    if (row.images) return row.images;
    const result = [zero()];
    for (let i = 1; i < row.atomIds.length; i++) {
      const a = original.atoms.findIndex(atom => atom.id === row.atomIds[i - 1]), b = original.atoms.findIndex(atom => atom.id === row.atomIds[i]);
      const edges = (original.bonds ?? []).filter(bond => bond.a === a && bond.b === b || bond.a === b && bond.b === a);
      if (edges.length > 1) throw new Error('内坐标缺少明确镜像，不能在多镜像连接中猜测。');
      const edge = edges[0], image = edge?.image ?? zero(), sign = edge?.a === b ? -1 : 1;
      result.push(result.at(-1)!.map((value, axis) => value + sign * image[axis]) as Vector3);
    }
    return result;
  };
  const outputImage = (offset: Vector3): Vector3 | null => {
    const image = [0, 1, 2].map(axis => basis.reduce((sum, column, sourceAxis) => sum + column[axis] * offset[sourceAxis], 0)) as Vector3;
    if (image.some((value, axis) => Math.abs(value - Math.round(value)) > 1e-7 || Math.round(value) !== 0 && !structure.cell?.pbc[axis])) return null;
    // The slab retains an XYZ periodic working cell, but surface-cut objects
    // cannot be recreated through its vacuum by an accidental integral c image.
    if (candidate.operation === 'slab' && Math.round(image[2]) !== 0) return null;
    return image.map(value => Math.round(value) || 0) as Vector3;
  };
  const sourceFractions = new Map<string, Vector3>();
  const fractional = (id: string): Vector3 => {
    let value = sourceFractions.get(id);
    if (!value) {
      const atom = sourceAtoms.get(id)!;
      value = original.cell ? cartesianToFractional(original.cell, [atom.x, atom.y, atom.z], false) : zero();
      sourceFractions.set(id, value);
    }
    return value;
  };
  // The native/general mapper remains the fallback. For an exact diagonal
  // supercell, integer copy residues identify every possible endpoint; final
  // floating-point/PBC checks below still decide acceptance and ordering.
  const repeats = basis.map((row, axis) => Math.round(1 / row[axis]));
  const indexedSupercell = candidate.operation === 'supercell'
    && repeats.every((repeat, axis) => Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 100
      && basis[axis].every((value, column) => value === (column === axis ? 1 / repeat : 0)))
    && candidate.atomMapping.every(entry => sources(entry).length === 1 && sources(entry)[0] === entry.sourceAtomId
      && entry.image.every(value => Math.abs(value) <= 100));
  const residueKey = (image: Vector3) => image.map((value, axis) => ((value % repeats[axis]) + repeats[axis]) % repeats[axis]).join(',');
  const copyIndices = new Map<string, Map<string, StructureTransformAtomMapping[]>>();
  if (indexedSupercell) for (const [id, entries] of bySource) {
    const index = new Map<string, StructureTransformAtomMapping[]>();
    for (const entry of entries) {
      const key = residueKey(entry.image), bucket = index.get(key) ?? [];
      bucket.push(entry); index.set(key, bucket);
    }
    copyIndices.set(id, index);
  }
  const mapTuple = <T extends Tuple>(row: T, required = false, discardCutRelation = false): T[] => {
    const sourceImages = endpointImages(row), roots = bySource.get(row.atomIds[0]) ?? [], results: T[] = [], seen = new Set<string>();
    if (!roots.length) { if (required) throw new Error('冻结或内坐标对象的来源已被删除，不能应用候选。'); return []; }
    // With these conservative magnitude bounds, roundoff in the unchanged
    // offset expression is < 16*eps*(2e5+2e4+200) < 1e-9. This cannot bridge
    // the >= 1/100 residual gap of a different integer copy class. Large or
    // unusual coordinates/images use the original exhaustive comparison.
    const useCopyIndex = indexedSupercell && sourceImages.length === row.atomIds.length
      && sourceImages.every(image => Array.isArray(image) && image.length === 3 && image.every(value => Number.isSafeInteger(value) && Math.abs(value) <= 10000))
      && row.atomIds.every(id => sourceAtoms.has(id) && fractional(id).every(value => Math.abs(value) <= 100000));
    for (const root of roots) {
      const entries: StructureTransformAtomMapping[] = [root], images: Vector3[] = [zero()];
      let complete = true;
      for (let i = 1; i < row.atomIds.length; i++) {
        const endpoints = useCopyIndex ? copyIndices.get(row.atomIds[i])?.get(residueKey(root.image.map((value, axis) => value + sourceImages[i][axis] - sourceImages[0][axis]) as Vector3)) ?? [] : bySource.get(row.atomIds[i]) ?? [];
        const candidates = endpoints.flatMap(entry => {
          if ((root.copyKey !== undefined || entry.copyKey !== undefined) && root.copyKey !== entry.copyKey) return [];
          const rootPrimary = fractional(root.sourceAtomId), sourceFirst = fractional(row.atomIds[0]), sourceEndpoint = fractional(row.atomIds[i]), endpointPrimary = fractional(entry.sourceAtomId);
          const image = outputImage(root.image.map((value, axis) => value + rootPrimary[axis] - sourceFirst[axis] + sourceEndpoint[axis] - endpointPrimary[axis] + sourceImages[i][axis] - sourceImages[0][axis] - entry.image[axis]) as Vector3);
          return image ? [{ entry, image }] : [];
        });
        // Prefer the same explicit source-cell copy. For a supercell the only
        // integer residual selects its other copy or a boundary output image.
        candidates.sort((a, b) => Math.hypot(...a.image) - Math.hypot(...b.image));
        if (!candidates.length) { complete = false; break; }
        if (candidates.length > 1 && equal(candidates[0].image, candidates[1].image) && candidates[0].entry.atomId !== candidates[1].entry.atomId) throw new Error('内坐标复制映射存在歧义。');
        entries.push(candidates[0].entry); images.push(candidates[0].image);
      }
      if (!complete) { if (required || !discardCutRelation && row.atomIds.some(id => bySource.has(id))) throw new Error('原子映射不能完整保留内坐标或连接对象。'); continue; }
      const atomIds = entries.map(entry => entry.atomId), key = JSON.stringify([atomIds, images]); if (seen.has(key)) continue; seen.add(key);
      const index = results.length, suffix = index ? `@${atomIds.join(',')}` : '', next = { ...clone(row), atomIds } as T;
      if (row.images || images.some(image => image.some(Boolean))) next.images = images; else delete next.images;
      if (next.id) next.id += suffix; if (next.objectId) next.objectId += suffix; if (next.rowId) next.rowId += suffix;
      results.push(next);
    }
    return results;
  };
  const next = clone(document); next.draft.structure = structure; next.draft.assignments = mapAssignments(document.draft.assignments);
  const inventoryChanged = original.atoms.length !== structure.atoms.length || original.atoms.some(atom => !targetAtoms.has(atom.id!)) || candidate.atomMapping.some(entry => sources(entry).length !== 1 || entry.sourceAtomId !== entry.atomId);
  if(inventoryChanged){structure.charge=null;structure.multiplicity=null;next.electronicStateConfirmed=false;}
  else {structure.charge=original.charge;structure.multiplicity=original.multiplicity;}
  assertMergeMembership(original.groups ?? []); structure.groups = original.groups?.map(group => ({ ...clone(group), atomIds: mapMembers(group.atomIds) })).filter(group => group.atomIds.length);
  assertMergeMembership(original.modelLayers ?? []); structure.modelLayers = original.modelLayers?.map(layer => ({ ...clone(layer), atomIds: mapMembers(layer.atomIds) }));
  structure.sourceAtomIds = clone(original.sourceAtomIds);
  structure.bondPerceptionIssues = original.bondPerceptionIssues?.flatMap(issue => {
    if (issue.atomIds.some(id => !bySource.has(id))) return [];
    return mapTuple({ ...issue, atomIds: [...issue.atomIds], images: [zero(), issue.image ?? zero()] }, false, candidate.operation === 'slab').map(({ atomIds, images, ...rest }) => ({ ...rest, atomIds: atomIds as [string, string], ...(images?.[1].some(Boolean) ? { image: images[1] } : { image: undefined }) }));
  });
  // Cartesian freezes are physical coordinates, not labels. New replicas use
  // their explicitly declared source translation; existing IDs stay exact.
  const frozen = new Set(getFrozenAtomIds(document));
  for (const sourceId of frozen) {
    const entries = bySource.get(sourceId); if (!entries?.length) throw new Error('几何候选删除了明确冻结原子。');
    for (const entry of entries) {
      const before = sourceAtoms.get(sourceId)!, atom = targetAtoms.get(entry.atomId)!;
      const shift = entry.atomId === sourceId ? zero() : original.cell ? fractionalToCartesian(original.cell, entry.image, false) : zero();
      const expected = [before.x + shift[0], before.y + shift[1], before.z + shift[2]];
      if ([atom.x, atom.y, atom.z].some((value, axis) => !Object.is(value, expected[axis]))) throw new Error('几何变换不能移动、合并或隐式解除明确冻结原子。');
    }
  }
  for (const entry of candidate.atomMapping) if (sources(entry).some(id => frozen.has(id)) && sources(entry).some(id => !frozen.has(id))) throw new Error('等价原子的冻结状态不同，不能安全并胞。');
  next.internalCoordinates = (document.internalCoordinates ?? []).flatMap(row => mapTuple(row, row.action === 'freeze'));
  next.coordinateObjects = (document.coordinateObjects ?? []).flatMap(row => mapTuple(row, true));
  next.gaussianBoundCoordinates = (document.gaussianBoundCoordinates ?? []).flatMap(row => mapTuple(row, true));
  if (next.sharedConstraints) { next.sharedConstraints.frozenAtomIds = mapMembers(next.sharedConstraints.frozenAtomIds); next.sharedConstraints.coordinates = document.sharedConstraints!.coordinates.flatMap(row => mapTuple(row, true)); }
  next.deletedBonds = document.deletedBonds.flatMap(row => mapTuple({ atomIds: row.atomIds, images: [zero(), row.image ?? zero()] })).map(row => ({ atomIds: row.atomIds as [string, string], ...(row.images?.[1].some(Boolean) ? { image: row.images[1] } : {}) }));
  next.auxiliaryRelations = document.auxiliaryRelations.flatMap(row => mapTuple({ ...row, atomIds: [row.a, row.b], images: undefined as Vector3[] | undefined })).map(({ atomIds, images, ...row }) => {
    if (images?.some(image => image.some(Boolean))) throw new Error('辅助关系无法无损映为跨胞对象。');
    return { ...row, a: atomIds[0], b: atomIds[1] };
  });
  next.attachmentPorts = (document.attachmentPorts ?? []).flatMap(port => (bySource.get(port.hostAtomId) ?? []).map((entry, index) => {
    const hasDirection = candidate.directionTransforms?.[entry.atomId] !== undefined;
    const unchangedFrame = equal(original.cell, structure.cell) && ['x','y','z'].every(axis => sourceAtoms.get(entry.sourceAtomId)![axis as 'x'|'y'|'z'] === targetAtoms.get(entry.atomId)![axis as 'x'|'y'|'z']);
    const translationOnly = ['translate','center','supercell','crop','reorder','wrap','finite-cluster','axes','vacuum','cell','p1'].includes(candidate.operation);
    if(!hasDirection&&!translationOnly&&!unchangedFrame)throw new Error('原生候选未提供待接端口的明确方向变换，不能静默保留旧方向。');
    const matrix = candidate.directionTransforms?.[entry.atomId] ?? identity();
    if (matrix.length !== 3 || matrix.some(row => !vector(row))) throw new Error('待接端口方向变换无效。');
    const direction = matrix.map(row => builderVector.dot(row, port.direction)) as Vector3, length = Math.hypot(...direction);
    if (!Number.isFinite(length) || length < 1e-10) throw new Error('待接端口方向变换退化。');
    return { ...clone(port), id: index ? `${port.id}@${entry.atomId}` : port.id, hostAtomId: entry.atomId, direction: direction.map(value => value / length) as Vector3 };
  }));
  next.selection = { ...emptySelection(), atomIds: mapMembers(document.selection.atomIds) };
  validateExtras(next);
  // Check every replica of each frozen B/A/D independently, including images.
  for (const row of effectiveModelCoordinates(document).filter(row => row.action === 'freeze')) {
    const before = builderCoordinateValue(original, row.type, row.atomIds, row.images);
    for (const mapped of mapTuple(row, true)) {
      const after = builderCoordinateValue(structure, row.type, mapped.atomIds, mapped.images), delta = row.type === 'D' ? Math.abs(((after - before + 540) % 360) - 180) : Math.abs(after - before);
      if ((row.type === 'B' ? delta : delta * Math.PI / 180) > (row.type === 'B' ? MODEL_CONSTRAINT_TOLERANCE.distanceAngstrom : MODEL_CONSTRAINT_TOLERANCE.angleRadians)) throw new Error('几何候选改变了明确冻结的内坐标。');
    }
  }
  // Deliberate transforms may change handedness, including when only a
  // neighbour of a centre moved. Recompute from the actual mapped graph/XYZ,
  // retaining the independent 2D layout and regenerating its existing wedges.
  // Renumbering is a pure identity projection and must not restyle stereo.
  if (candidate.operation !== 'reorder') {
    const annotated = new Set(structure.atoms.filter(atom => atom.stereoParity !== undefined).map(atom => atom.id!));
    for (const bond of structure.bonds ?? []) if (bond.stereo === 1 || bond.stereo === 6) {
      annotated.add(structure.atoms[bond.a].id!); annotated.add(structure.atoms[bond.b].id!);
    }
    if (annotated.size) next.draft.structure = updateBuilderStereo(structure, [...annotated]).structure;
  }
  return next;
}

/** The inactive Gaussian/ORCA projections participate in the same mapping and
 * rejection checks; they cannot be silently clipped by the active task. */
export function mapStructureTransformContext(document: ModelDocument, candidate: StructureTransformCandidate, context: { assignments: BuilderAssignments; coordinates: NonNullable<ModelDocument['internalCoordinates']> }) {
  const mapped = mapStructureTransformDocument({ ...document, draft: { ...document.draft, assignments: context.assignments }, internalCoordinates: context.coordinates }, candidate);
  return { assignments: mapped.draft.assignments, coordinates: mapped.internalCoordinates ?? [] };
}
