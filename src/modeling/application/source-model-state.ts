import type { Structure } from '../../core/types';
import type { OrcaInputSourceMeta } from '../../core/orca/types';
import type { ModelCoordinate, ModelCoordinateObject, SharedModelConstraints } from '../contracts';
import { modelCoordinateKey } from '../constraints';

export interface SourceModelState {
  internalCoordinates: ModelCoordinate[];
  sharedConstraints: SharedModelConstraints;
  coordinateObjects: ModelCoordinateObject[];
}

export function validateSourceAtomIdentity(structure: Pick<Structure, 'sourceAtomIds'>): void {
  const ids = structure.sourceAtomIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)) throw new Error('来源中心稳定身份映射缺失或重复。');
}

/** Call only at the actual raw-file import boundary, before any model edits.
 * Restored snapshots retain an existing map, including deleted source IDs. */
export function bindImportedSourceAtomIds(structure: Structure): Structure {
  if (!structure.gaussianSource && !structure.orcaSource) return structure;
  if (structure.sourceAtomIds !== undefined) { validateSourceAtomIdentity(structure); return structure.gaussianSource ? { ...structure, sourceRoute: undefined } : structure; }
  const bound = { ...structure, sourceAtomIds: structure.atoms.map(atom => atom.id!), ...(structure.gaussianSource ? { sourceRoute: undefined } : {}) };
  validateSourceAtomIdentity(bound); return bound;
}

/** Resolve source-order centers once, against the actual imported structure.
 * Later edits retain these IDs; the old center number never selects a replacement. */
export function sourceAtomIds(structure: Structure, numbers: readonly number[]): string[] {
  validateSourceAtomIdentity(structure);
  const centers = structure.sourceAtomIds ?? structure.atoms.map(atom => atom.id);
  const ids = numbers.map(number => {
    const id = Number.isSafeInteger(number) && number > 0 ? centers[number - 1] : undefined;
    if (!id) throw new Error('来源原子中心引用无效，不能按当前序号猜测恢复。');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('来源原子中心引用重复。');
  return ids;
}

/** File metadata is evidence, not executable task definitions. Only current-value
 * freezes become model locks; a source D scan becomes an ordinary observation. */
export function sourceModelState(structure: Structure): SourceModelState {
  const sharedConstraints: SharedModelConstraints = { canonical:true,frozenAtomIds: [], coordinates: [] }, coordinateObjects: ModelCoordinateObject[] = [];
  const known = new Set(structure.atoms.map(atom => atom.id));
  const sources = [
    ...(structure.gaussianSource ? [{ engine: 'gaussian', source: structure.gaussianSource }] : []),
    ...(structure.orcaSource ? [{ engine: 'orca', source: structure.orcaSource }] : []),
  ];
  for (const { engine, source } of sources) {
    sharedConstraints.frozenAtomIds.push(...sourceAtomIds(structure, source.frozenAtoms ?? []).filter(id => known.has(id)));
    for (const [index, row] of (source.coordinates ?? []).entries()) {
      if (row.action !== 'freeze' && row.action !== 'scan') throw new Error('来源内坐标F/S语义不完整，不能猜测恢复。');
      if (row.action === 'scan' && row.type !== 'D') continue;
      const atomIds = sourceAtomIds(structure, row.atoms), count = { B: 2, A: 3, D: 4 }[row.type];
      if (!count || atomIds.length !== count) throw new Error('来源内坐标类型或原子数无效。');
      if (atomIds.some(id => !known.has(id))) continue;
      const key = modelCoordinateKey({ type: row.type, atomIds });
      let object = coordinateObjects.find(candidate => modelCoordinateKey(candidate) === key);
      if (!object) {
        object = { id: `source-object:${engine}:${source.id}:${index}`, type: row.type, atomIds };
        coordinateObjects.push(object);
      }
      if (row.action === 'scan') continue;
      if (!sharedConstraints.coordinates.some(candidate => modelCoordinateKey(candidate) === key)) {
        sharedConstraints.coordinates.push({ id: `source-freeze:${object.id}`, objectId: object.id,
          type: object.type, atomIds: [...object.atomIds], action: 'freeze', steps: 1, increment: null,
          ...('value' in row&&row.value!==undefined?{value:row.value,source:'orca' as const}:{}) });
      }
    }
  }
  sharedConstraints.frozenAtomIds = [...new Set(sharedConstraints.frozenAtomIds)];
  return { internalCoordinates: [], sharedConstraints, coordinateObjects };
}

/** Validate retained source evidence as data before restoring it from SDF.
 * The original source can outlive deleted atoms, so center bounds are checked
 * only when explicitly projecting it against the imported geometry. */
export function validateOrcaModelSource(source: OrcaInputSourceMeta): void {
  const text = (value: unknown): value is string => typeof value === 'string';
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
  const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  if (!source || source.schema !== 1 || !text(source.id) || !source.id || !text(source.fileName) || !Number.isSafeInteger(source.jobIndex) || source.jobIndex < 0
    || !text(source.rawInput) || !strings(source.keywords) || !Number.isSafeInteger(source.charge) || !Number.isSafeInteger(source.multiplicity) || source.multiplicity < 1
    || !keys(source, ['schema', 'id', 'fileName', 'jobIndex', 'rawInput', 'keywords', 'charge', 'multiplicity', 'level', 'frozenAtoms', 'coordinates', 'issues', 'unsupported'])) throw new Error('ORCA来源元数据身份或格式无效。');
  const level = source.level;
  if (!level || !keys(level, ['method', 'methodKeyword', 'basis', 'basisKeyword', 'ecpKeywords', 'dispersion', 'unrestricted', 'solvent'])
    || !strings(level.ecpKeywords) || ![null, 'none', 'd3', 'd3bj', 'd4', 'builtin'].includes(level.dispersion)
    || ['method', 'methodKeyword', 'basis', 'basisKeyword'].some(key => level[key as keyof typeof level] !== undefined && !text(level[key as keyof typeof level]))
    || level.unrestricted !== undefined && typeof level.unrestricted !== 'boolean'
    || level.solvent !== undefined && (!level.solvent || !keys(level.solvent, ['model', 'name', 'raw']) || !['cpcm', 'smd'].includes(level.solvent.model) || !text(level.solvent.name) || !text(level.solvent.raw))) throw new Error('ORCA来源级别元数据无效。');
  if (!Array.isArray(source.frozenAtoms) || source.frozenAtoms.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(source.frozenAtoms).size !== source.frozenAtoms.length
    || !Array.isArray(source.coordinates) || source.coordinates.some(row => !row || !keys(row, ['type', 'atoms', 'action', 'value', 'raw']) || !['B', 'A', 'D'].includes(row.type)
      || !['freeze', 'scan'].includes(row.action) || !text(row.raw) || !Array.isArray(row.atoms) || row.atoms.length !== { B: 2, A: 3, D: 4 }[row.type]
      || row.atoms.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(row.atoms).size !== row.atoms.length
      || row.value !== undefined && (!Number.isFinite(row.value) || row.action !== 'freeze' || row.type === 'B' && row.value <= 0 || row.type === 'A' && (row.value <= 0 || row.value >= 180)))
    || !strings(source.unsupported) || !Array.isArray(source.issues) || source.issues.some(issue => !issue || !keys(issue, ['code', 'message', 'field', 'severity', 'raw'])
      || !text(issue.code) || !text(issue.message) || !['missing', 'unsupported', 'conflict', 'warning'].includes(issue.severity)
      || issue.field !== undefined && !text(issue.field) || issue.raw !== undefined && !text(issue.raw))) throw new Error('ORCA来源冻结/扫描证据无效。');
}
