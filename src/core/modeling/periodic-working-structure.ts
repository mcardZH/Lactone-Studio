import type { Structure } from '../types';
import { cellInverse } from '../periodic';
import type { ModelDocument, ModelProjectReplayState, ModelStoreProjectState } from './contracts';

/** Adapt editable work models only. Raw file readers and result objects retain
 * their original scientific periodicity and all source calculation conditions. */
export function periodicWorkingStructure(source: Structure, { preserveInvalidCell = false } = {}): Structure {
  const cell = source.cell;
  if (!cell || source.periodicSource) return source;
  try {
    if (!Array.isArray(cell.pbc) || cell.pbc.length !== 3 || !cell.pbc.every(axis => typeof axis === 'boolean')) {
      throw new Error('晶胞周期轴声明无效。');
    }
    // An explicit F F F represents a finite structure with a stored box.
    if (!cell.pbc.some(Boolean)) return source;
    const finiteVector = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    if (!Array.isArray(cell.vectors) || cell.vectors.length !== 3 || !cell.vectors.every(finiteVector)
      || cell.origin !== undefined && !finiteVector(cell.origin)) {
      throw new Error('晶胞无效，周期工作态需要完整有限的三维晶胞。');
    }
    cellInverse(cell);
  } catch (error) {
    if (preserveInvalidCell) return source;
    throw error;
  }
  if (cell.pbc.every(Boolean) && source.dimension !== 2 && cell.pbcProvenance?.kind !== 'unconfirmed') return source;

  const structure = structuredClone(source);
  structure.periodicWorkingSource ??= {
    structureId: source.id, name: source.name, format: source.format,
    cell: structuredClone(cell), atoms: structuredClone(source.atoms), coordinateUnit: 'angstrom',
  };
  structure.cell!.pbc = [true, true, true];
  structure.cell!.pbcProvenance = {
    kind: 'format-defined', evidence: 'Ester Studio三维周期工作表示；原来源晶胞、坐标与PBC独立保存在periodicWorkingSource。',
  };
  structure.dimension = 3;
  return structure;
}

/** Normalize editable snapshots in a private, validated project clone. The
 * Store retains ownership of its saved-content key and history transactions. */
export function normalizeRestoredPeriodicProjectState(state: ModelStoreProjectState): void {
  const normalize = (source: Structure) => periodicWorkingStructure(source, { preserveInvalidCell: true });
  const normalizeDocument = (document: ModelDocument) => {
    document.draft.structure = normalize(document.draft.structure);
    if (document.cellCheckpoint) document.cellCheckpoint.structure = normalize(document.cellCheckpoint.structure);
  };
  const normalizeReplay = (entry: ModelProjectReplayState) => {
    if (entry.kind === 'structure') normalizeDocument(entry.document);
  };

  normalizeDocument(state.document);
  state.baseline.structure = normalize(state.baseline.structure);
  for (const entry of [...state.past, ...state.future]) {
    if (entry.kind !== 'linked') normalizeReplay(entry);
    else for (const member of entry.token.members) {
      normalizeReplay(member.before);
      normalizeReplay(member.after);
    }
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyStructure = (value: unknown): value is Structure => record(value) && typeof value.id === 'string'
  && typeof value.name === 'string' && typeof value.format === 'string' && Array.isArray(value.atoms) && Array.isArray(value.notes)
  && (value.charge === null || Number.isInteger(value.charge)) && (value.multiplicity === null || Number.isInteger(value.multiplicity));
const keyAssignments = (value: unknown) => record(value) && [value.layers, value.basis, value.fragments, value.frozenAtomIds].every(Array.isArray);

function keyParts(text: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeInnerPeriodicKey(parts: unknown[] | undefined, original: string): string | undefined {
  if (!parts || !keyStructure(parts[0]) || !keyAssignments(parts[1])) return undefined;
  const modelKey = parts.length === 12 && [2, 3, 4, 5, 7, 8].every(index => Array.isArray(parts[index]))
    && record(parts[6]) && (parts[9] === null || record(parts[9]))
    && typeof parts[10] === 'boolean' && (parts[11] === null || typeof parts[11] === 'string');
  const derivedKey = parts.length === 10 && typeof parts[2] === 'boolean'
    && [3, 5, 6, 7].every(index => parts[index] === null || Array.isArray(parts[index]))
    && (parts[4] === null || record(parts[4])) && Array.isArray(parts[8]) && Array.isArray(parts[9]);
  if (!modelKey && !derivedKey) return undefined;
  const structure = periodicWorkingStructure(parts[0], { preserveInvalidCell: true });
  if (structure === parts[0]) return original;
  parts[0] = structure;
  return JSON.stringify(parts);
}

/** Adapt only the persisted model and derived equality keys. Their optional
 * outer tuple stores a cell checkpoint alongside the serialized inner key. */
export function normalizePeriodicModelContentKey(content: string): string {
  const parts = keyParts(content);
  if (!parts || parts.length !== 2 || typeof parts[0] !== 'string') return normalizeInnerPeriodicKey(parts, content) ?? content;

  const [inner, checkpoint] = parts;
  const normalizedInner = normalizeInnerPeriodicKey(keyParts(inner), inner);
  if (normalizedInner === undefined) return content;
  if (checkpoint === null) return normalizedInner === inner ? content : JSON.stringify([normalizedInner, null]);
  if (!record(checkpoint) || !keyStructure(checkpoint.structure) || !keyAssignments(checkpoint.assignments)
    || !Array.isArray(checkpoint.auxiliaryRelations) || !Array.isArray(checkpoint.deletedBonds)) return content;
  const structure = periodicWorkingStructure(checkpoint.structure, { preserveInvalidCell: true });
  return normalizedInner === inner && structure === checkpoint.structure
    ? content : JSON.stringify([normalizedInner, { ...checkpoint, structure }]);
}
