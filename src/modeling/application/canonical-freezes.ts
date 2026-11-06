import type { GaussianSettings, Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';
import { defaultTaskOptions, coordinateAction, coordinateAtoms } from '../../core/tasks';
import { resolveCoordinateDrafts } from '../../core/coordinate-drafts';
import type { ModelCoordinate, ModelCoordinateObject, ModelDocument, SharedModelConstraints } from '../contracts';
import { emptySharedConstraints, mergeModelCoordinates, modelCoordinateKey, validateCoordinateObject } from '../constraints';

/** Confirmed canonical rows use stable IDs, while scans and incomplete drafts
 * remain task definitions. A task switch cannot recreate deleted freezes. */
export function canonicalFreezeRows(structure: Structure, rows: readonly ModelCoordinate[], objects: readonly ModelCoordinateObject[] = []) {
  const knownObjects = [...objects], frozen: ModelCoordinate[] = [];
  for (const row of rows) {
    if (row.action !== 'freeze') continue;
    const key = modelCoordinateKey(row);
    const existing = knownObjects.find(object => modelCoordinateKey(object) === key);
    const object: ModelCoordinateObject = existing ?? { id: row.objectId ?? `freeze-object:${key}`, type: row.type, atomIds: [...row.atomIds], ...(row.images?{images:structuredClone(row.images)}:{}) };
    validateCoordinateObject(object, structure);
    const sameId = knownObjects.find(value => value.id === object.id);
    if (sameId && modelCoordinateKey(sameId) !== key) throw new Error('冻结内坐标对象身份已绑定另一组原子。');
    if (!existing) knownObjects.push(object);
    frozen.push({ id: `shared-freeze:${object.id}`, objectId: object.id, type: row.type, atomIds: [...row.atomIds], ...(row.images?{images:structuredClone(row.images)}:{}), action: 'freeze', steps: 1, increment: null,
      ...(row.value === undefined ? {} : { value: row.value, source: 'orca' as const }) });
  }
  return { coordinates: mergeModelCoordinates(frozen, []), coordinateObjects: knownObjects };
}

/** Used only for legacy document restoration. Disabled private definitions
 * must be filtered by their engine bridge before arriving at this boundary. */
export function migrateCanonicalFreezes(document: ModelDocument): void {
  if (document.sharedConstraints?.canonical) {
    document.draft.assignments.frozenAtomIds = [];
    document.internalCoordinates = (document.internalCoordinates ?? []).filter(row => row.action !== 'freeze');
    return;
  }
  const shared = document.sharedConstraints ?? emptySharedConstraints();
  const migrated = canonicalFreezeRows(document.draft.structure, [...(document.internalCoordinates ?? []).filter(row => row.action === 'freeze'), ...shared.coordinates], document.coordinateObjects);
  document.sharedConstraints = { canonical: true,...(shared.enabled===undefined?{}:{enabled:shared.enabled}), frozenAtomIds: [...new Set([...shared.frozenAtomIds, ...document.draft.assignments.frozenAtomIds])], coordinates: migrated.coordinates };
  document.coordinateObjects = migrated.coordinateObjects;
  document.draft.assignments.frozenAtomIds = [];
  document.internalCoordinates = (document.internalCoordinates ?? []).filter(row => row.action !== 'freeze');
}

export function gaussianFreezeDefinitions(structure: Structure | null, settings: GaussianSettings): SharedModelConstraints {
  const options = settings.taskOptions ?? defaultTaskOptions();
  if (!structure || options.freezeEnabled === false || !options.constraintsEnabled&&options.freezeEnabled!==true) return emptySharedConstraints();
  const resolved=resolveCoordinateDrafts({...settings,task:'opt',taskOptions:{...options,freezeEnabled:true,coordinates:options.coordinates.map(row=>({...row,action:coordinateAction(row,settings.task)}))}});
  const coordinates = resolved.coordinates.filter(row => row.action === 'freeze').map(row => ({
    id: options.coordinateDrafts?.find(draft => {try{return draft.action === 'freeze' && draft.enabled && coordinateAtoms(draft.atomText).join(',') === row.atoms.join(',');}catch{return false;}})?.id,
    objectId: row.objectId, type: row.type, atomIds: row.atoms.map(number => structure.atoms[number - 1]?.id ?? ''), action: 'freeze' as const, steps: 1, increment: null,
  }));
  return { frozenAtomIds: options.frozenAtoms.map(number => structure.atoms[number - 1]?.id ?? ''), coordinates };
}
export function orcaFreezeDefinitions(structure: Structure | null, settings: OrcaSettings): SharedModelConstraints {
  if (!structure || settings.freezeEnabled === false) return emptySharedConstraints();
  const known = new Set(structure.atoms.map(atom => atom.id));
  const rows = settings.task === 'md' ? settings.md.constraints : settings.constraints;
  return { frozenAtomIds: settings.frozenAtomIds.filter(id => known.has(id)), coordinates: rows.flatMap(row => {
    if (row.action !== 'freeze' || row.atomIds.length !== { B: 2, A: 3, D: 4 }[row.type] || new Set(row.atomIds).size !== row.atomIds.length || row.atomIds.some(id => !known.has(id))) return [];
    if (row.value !== undefined && (!Number.isFinite(row.value) || row.type === 'B' && row.value <= 0 || row.type === 'A' && (row.value <= 0 || row.value >= 180))) return [];
    return [{ type: row.type, atomIds: [...row.atomIds], objectId: row.objectId, action: 'freeze' as const, source: 'orca' as const, value: row.value, steps: 1, increment: null }];
  }) };
}
export function freezeDefinitionSignature(shared:SharedModelConstraints):string {
  return JSON.stringify([[...shared.frozenAtomIds].sort(),shared.coordinates.map(row=>[modelCoordinateKey(row),row.value??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}
/** The Gaussian current-value editor cannot silently erase an ORCA target in
 * an unchanged, object-bound coordinate while editing the atom freeze set. */
export function preserveCanonicalFreezeTargets(definitions:SharedModelConstraints,shared?:SharedModelConstraints):SharedModelConstraints {
  return {...definitions,coordinates:definitions.coordinates.map(row=>{
    const old=shared?.coordinates.find(value=>value.objectId===row.objectId&&modelCoordinateKey(value)===modelCoordinateKey(row));
    return old?.value!==undefined?{...row,value:old.value,source:old.source}:row;
  })};
}

/** Form projection never publishes engine-owned freeze copies back to Store. */
export function projectCanonicalGaussianFreezes(structure: Structure | null, settings: GaussianSettings, shared: SharedModelConstraints): GaussianSettings {
  const options = settings.taskOptions ?? defaultTaskOptions(), numbers = new Map(structure?.atoms.map((atom, index) => [atom.id, index + 1]) ?? []);
  const drafts = options.coordinateDrafts ?? options.coordinates.map((row, index) => ({ id: `legacy-${index + 1}`, type: row.type, action: coordinateAction(row, settings.task), atomText: row.atoms.join(','), stepsText: String(row.steps), incrementText: row.increment === null ? '' : String(row.increment), enabled: true, objectId: row.objectId }));
  // Incomplete rows are editing state only. Retained disabled historical rows
  // are kept inactive and never turned into the canonical confirmed set.
  const retained = drafts.filter(row => {
    if(row.action!=='freeze')return true;
    if(shared.coordinates.some(value=>value.id===row.id||Boolean(row.objectId)&&value.objectId===row.objectId))return false;
    return !row.enabled||resolveCoordinateDrafts({...settings,task:'opt',taskOptions:{...options,freezeEnabled:true,coordinateDrafts:[row]}}).errors.length>0;
  });
  const hasFreeze=Boolean(shared.frozenAtomIds.length||shared.coordinates.length||retained.some(row=>row.action==='freeze'&&row.enabled));
  const canonical=shared.coordinates.map(row=>({id:row.id!,objectId:row.objectId,type:row.type,action:'freeze' as const,atomText:row.atomIds.map(id=>numbers.get(id)??0).join(','),stepsText:'1',incrementText:'',enabled:true}));
  const used=new Set<number>();
  const projectedDrafts=drafts.flatMap(row=>{
    const index=canonical.findIndex(value=>value.id===row.id||Boolean(row.objectId)&&value.objectId===row.objectId);
    if(index>=0){if(used.has(index))return[];used.add(index);return[canonical[index]];}
    return retained.includes(row)?[row]:[];
  });
  projectedDrafts.push(...canonical.filter((_row,index)=>!used.has(index)));
  return { ...settings, taskOptions: { ...options, constraintsEnabled: hasFreeze, freezeEnabled: shared.enabled===false?false:undefined, inheritModelFreeze: undefined,
    frozenAtoms: shared.frozenAtomIds.map(id => numbers.get(id) ?? 0), inactiveFrozenAtoms: options.inactiveFrozenAtoms,
    coordinates: options.coordinates.filter(row => coordinateAction(row, settings.task) !== 'freeze'),
    coordinateDrafts: projectedDrafts,
  } };
}
export function projectCanonicalOrcaFreezes(structure: Structure | null, settings: OrcaSettings, shared: SharedModelConstraints): OrcaSettings {
  const rows = settings.task === 'md' ? settings.md.constraints : settings.constraints;
  const retained = rows.filter(row => row.action !== 'freeze' || !row.atomIds.length);
  const canonical = shared.coordinates.map(row => ({ type: row.type, atomIds: [...row.atomIds], objectId: row.objectId, action: 'freeze' as const, ...(row.value === undefined ? {} : { value: row.value }) }));
  return { ...settings, freezeEnabled: shared.enabled!==false, inheritModelFreeze: undefined, frozenAtomIds: [...shared.frozenAtomIds],
    constraints: settings.task === 'md' ? settings.constraints.filter(row => row.action !== 'freeze') : [...retained, ...canonical],
    md: { ...settings.md, constraints: settings.task === 'md' ? [...retained, ...canonical] : settings.md.constraints.filter(row => row.action !== 'freeze') },
  };
}
