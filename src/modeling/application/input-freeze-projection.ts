import { inputFreezeDisplay, type InputFreezeCoordinate, type InputFreezeDisplay } from '../../core/input-freezes';
import { activeCoordinates, activeFrozenAtoms, coordinateAction, coordinateAtoms, defaultTaskOptions } from '../../core/tasks';
import { resolveCoordinateDrafts } from '../../core/coordinate-drafts';
import type { GaussianSettings, Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';
import type { SharedModelConstraints } from '../contracts';
import { applySharedGaussianConstraints } from './gaussian-bridge';
import { applySharedOrcaConstraints } from './orca-bridge';
import { modelCoordinateKey } from '../constraints';

const empty = (): InputFreezeDisplay['applied'] => ({ atomIds: [], coordinateObjectIds: [], coordinates: [] });
const objectIds = (values: { objectId?: string }[]) => values.flatMap(row => row.objectId ? [row.objectId] : []);
const knownIds = (structure: Structure, ids: string[]) => ids.filter(id => structure.atoms.some(atom => atom.id === id));
const coordinateTuples = (structure: Structure, values: { type: 'B' | 'A' | 'D'; atomIds: string[]; objectId?: string }[]): InputFreezeCoordinate[] => values.flatMap(row => {
  const count = { B: 2, A: 3, D: 4 }[row.type];
  if (!count || row.atomIds.length !== count || new Set(row.atomIds).size !== count || row.atomIds.some(id => !id || structure.atoms.filter(atom => atom.id === id).length !== 1)) return [];
  return [{ key: modelCoordinateKey(row), type: row.type, atomIds: [...row.atomIds], ...(row.objectId ? { objectId: row.objectId } : {}) }];
});

/** Task-input appearance only; shared/private model records remain unchanged. */
export function gaussianInputFreezeDisplay(structure: Structure | null, settings: GaussianSettings, shared?: SharedModelConstraints): InputFreezeDisplay {
  if (!structure) return { applied: empty(), inactive: empty() };
  const options = settings.taskOptions ?? defaultTaskOptions();
  const idsFromNumbers = (numbers: number[]) => numbers.flatMap(number => structure.atoms[number - 1]?.id ? [structure.atoms[number - 1].id!] : []);
  const privateObjects = options.coordinateDrafts === undefined
    ? objectIds(options.coordinates.filter(row => coordinateAction(row, settings.task) === 'freeze'))
    : objectIds(options.coordinateDrafts.filter(row => row.action === 'freeze'));
  const privateRows = options.coordinateDrafts === undefined
    ? options.coordinates.filter(row => coordinateAction(row, settings.task) === 'freeze').map(row => ({ type: row.type, atomIds: row.atoms.map(number => structure.atoms[number - 1]?.id ?? ''), objectId: row.objectId }))
    : options.coordinateDrafts.filter(row => row.action === 'freeze').flatMap(row => {
      try { return [{ type: row.type, atomIds: coordinateAtoms(row.atomText).map(number => structure.atoms[number - 1]?.id ?? ''), objectId: row.objectId }]; } catch { return []; }
    });
  const defined = shared?.canonical?{
    atomIds:knownIds(structure,shared.frozenAtomIds),coordinateObjectIds:objectIds(shared.coordinates),coordinates:coordinateTuples(structure,shared.coordinates),
  }:{
    atomIds: [...idsFromNumbers([...options.frozenAtoms, ...(options.inactiveFrozenAtoms ?? [])]), ...knownIds(structure, shared?.frozenAtomIds ?? [])],
    coordinateObjectIds: [...privateObjects, ...objectIds(shared?.coordinates ?? [])],
    coordinates: coordinateTuples(structure, [...privateRows, ...(shared?.coordinates ?? [])]),
  };
  const projected = applySharedGaussianConstraints(structure, settings, shared);
  const resolved = resolveCoordinateDrafts(projected.settings), frozen = activeFrozenAtoms({ settings: projected.settings });
  const freezeError = frozen.some(number => !structure.atoms[number - 1]) || new Set(frozen).size !== frozen.length;
  const applied = projected.errors.length || resolved.errors.length || freezeError ? empty() : {
    atomIds: idsFromNumbers(activeFrozenAtoms({ settings: projected.settings })),
    coordinateObjectIds: objectIds(activeCoordinates({ settings: projected.settings }).filter(row => coordinateAction(row, settings.task) === 'freeze')),
    coordinates: coordinateTuples(structure, activeCoordinates({ settings: projected.settings }).filter(row => coordinateAction(row, settings.task) === 'freeze').map(row => ({ type: row.type, atomIds: row.atoms.map(number => structure.atoms[number - 1]?.id ?? ''), objectId: row.objectId }))),
  };
  return inputFreezeDisplay(defined, applied);
}

/** MD activity scopes remain scientific regions, not task-freeze markers. */
export function orcaInputFreezeDisplay(structure: Structure | null, settings: OrcaSettings, shared?: SharedModelConstraints): InputFreezeDisplay {
  if (!structure) return { applied: empty(), inactive: empty() };
  const md = settings.task === 'md';
  const privateRows = md ? settings.md.constraints : settings.constraints;
  const defined = shared?.canonical?{
    atomIds:knownIds(structure,shared.frozenAtomIds),coordinateObjectIds:objectIds(shared.coordinates),coordinates:coordinateTuples(structure,shared.coordinates),
  }:{
    atomIds: [...knownIds(structure, settings.frozenAtomIds), ...knownIds(structure, shared?.frozenAtomIds ?? [])],
    coordinateObjectIds: [...objectIds(privateRows.filter(row => row.action === 'freeze')), ...objectIds(shared?.coordinates ?? [])],
    coordinates: coordinateTuples(structure, [...privateRows.filter(row => row.action === 'freeze'), ...(shared?.coordinates ?? [])]),
  };
  const projected = applySharedOrcaConstraints(structure, settings, shared);
  const effective = projected.settings;
  const supported = ['opt', 'optfreq', 'ts', 'scan', 'tdopt', 'md'].includes(settings.task);
  const freezeRows = (md ? effective.md.constraints : effective.constraints).filter(row => row.action === 'freeze');
  const activeMd = new Set(effective.md.activeAtomIds.length ? effective.md.activeAtomIds : structure.atoms.flatMap(atom => atom.id ? [atom.id] : []));
  const validRow = (row: typeof freezeRows[number]) => {
    const count = { B: 2, A: 3, D: 4 }[row.type];
    const validValue = row.value === undefined ? !md : Number.isFinite(row.value) && (row.type === 'B' ? row.value > 0 : row.type === 'A' ? row.value > 0 && row.value < 180 : true);
    if (md && row.atomIds.some(id => !activeMd.has(id))) return false;
    if (md && row.type === 'B' && (!(structure.bondSource === 'file' || structure.bondSource === 'drawn') || !structure.bonds?.some(bond => {
      const ids = [structure.atoms[bond.a]?.id, structure.atoms[bond.b]?.id];
      return row.atomIds.every(id => ids.includes(id));
    }))) return false;
    return row.atomIds.length === count && new Set(row.atomIds).size === count && knownIds(structure, row.atomIds).length === count && validValue;
  };
  const keys = effective.constraints.map(row => row.type + ':' + [row.atomIds.join(','), [...row.atomIds].reverse().join(',')].sort()[0]);
  const blocked = projected.errors.length || !supported || shared?.enabled===false || !shared?.canonical&&settings.freezeEnabled === false || freezeRows.some(row => !validRow(row))
    || (!md && knownIds(structure, effective.frozenAtomIds).length !== effective.frozenAtomIds.length)
    || (!md && new Set(keys).size !== keys.length)
    || (md && (effective.frozenAtomIds.length || effective.constraints.length || effective.md.constraints.some(row => row.action !== 'freeze')));
  const applied = blocked ? empty() : {
    atomIds: md ? knownIds(structure, shared?.frozenAtomIds ?? []).filter(id => !effective.md.activeAtomIds.includes(id) && (shared?.canonical||settings.inheritModelFreeze?.atoms !== false)) : knownIds(structure, effective.frozenAtomIds),
    coordinateObjectIds: objectIds(freezeRows),
    coordinates: coordinateTuples(structure, freezeRows),
  };
  return inputFreezeDisplay(defined, applied);
}
