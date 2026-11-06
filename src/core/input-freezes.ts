import type { OrcaSettings } from './orca/types';

/** Derived writer input only. Never store this projection over the task's retained definitions. */
export function projectOrcaFreezeSettings(settings: OrcaSettings): OrcaSettings {
  if (settings.freezeEnabled !== false) return settings;
  return { ...settings, frozenAtomIds: [], constraints: settings.constraints.filter(row => row.action !== 'freeze'),
    md: { ...settings.md, constraints: settings.md.constraints.filter(row => row.action !== 'freeze') } };
}

export interface InputFreezeCoordinate {
  key: string;
  type: 'B' | 'A' | 'D';
  atomIds: string[];
  objectId?: string;
}
export interface InputFreezeDisplay {
  applied: { atomIds: string[]; coordinateObjectIds: string[]; coordinates?: InputFreezeCoordinate[] };
  inactive: { atomIds: string[]; coordinateObjectIds: string[]; coordinates?: InputFreezeCoordinate[] };
}

/** IDs only. An inactive input marker must never be used as a model/forcefield lock. */
export function inputFreezeDisplay(defined: InputFreezeDisplay['applied'], applied: InputFreezeDisplay['applied']): InputFreezeDisplay {
  const unique = (values: string[]) => [...new Set(values)];
  const uniqueCoordinates = (values: InputFreezeCoordinate[]) => {
    const rows = new Map<string, InputFreezeCoordinate>();
    for (const row of values) if (!rows.has(row.key) || !rows.get(row.key)!.objectId && row.objectId) rows.set(row.key, { ...row, atomIds: [...row.atomIds] });
    return [...rows.values()];
  };
  const activeRows = uniqueCoordinates(applied.coordinates ?? []), definedRows = uniqueCoordinates(defined.coordinates ?? []);
  const activeKeys = new Set(activeRows.map(row => row.key));
  const active = { atomIds: unique(applied.atomIds), coordinateObjectIds: unique([
    ...applied.coordinateObjectIds, ...definedRows.flatMap(row => activeKeys.has(row.key) && row.objectId ? [row.objectId] : []),
  ]), ...(applied.coordinates ? { coordinates: activeRows } : {}) };
  return { applied: active, inactive: {
    atomIds: unique(defined.atomIds).filter(id => !active.atomIds.includes(id)),
    coordinateObjectIds: unique(defined.coordinateObjectIds).filter(id => !active.coordinateObjectIds.includes(id)),
    ...(defined.coordinates ? { coordinates: definedRows.filter(row => !activeKeys.has(row.key)) } : {}),
  } };
}
