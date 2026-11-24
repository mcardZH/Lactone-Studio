import type { DisplaySettings, ModelDocument } from '../../../modeling/contracts';
import { FREEZE_COLOR, type DisplayCoordinate, type ViewerHighlights } from '../../../core/display-highlights';
import { fragmentColor, type MoleculeRegion } from '../../../core/regions';
import { getFrozenAtomIds } from '../../../core/modeling';
import { effectiveModelCoordinates, modelCoordinateKey } from '../../../modeling/constraints';
import { validatePeriodicEndpointImages } from '../../../core/periodic';
import type { Vector3 } from '../../../core/types';

export function modelHighlights(document: ModelDocument, incoming: ViewerHighlights = {}, displayFrozenAtomIds?: readonly string[]): ViewerHighlights {
  const draft = document.draft;
  let index: Map<string,number> | undefined;
  const currentIndex = (id:string) => (index ??= new Map(draft.structure.atoms.map((atom,i)=>[atom.id!,i]))).get(id);
  const idsToIndices = (ids:readonly string[]) => ids.flatMap(id => { const now=currentIndex(id);return now===undefined?[]:[now]; });
  const mapped = (values: number[]) => values.flatMap(i => { const now = currentIndex(draft.baseAtomIds[i]); return now === undefined ? [] : [now]; });
  const result: ViewerHighlights = {};
  for (const category of ['basis', 'layers', 'fragments'] as const) {
    const own = draft.assignments[category];
    result[category] = own.length ? own.map((entry, i) => ({ id: entry.id, label: entry.label ?? entry.basis ?? (category === 'layers' ? entry.kind?.toUpperCase() : undefined) ?? entry.id, color: fragmentColor(i + (category === 'basis' ? 5 : category === 'layers' ? 10 : 0)), atomIndices: idsToIndices(entry.atomIds) })) : (incoming[category] ?? []).map(region => ({ ...region, atomIndices: mapped(region.atomIndices) }));
  }
  // A protection overlay owns only the visual IDs. Empty is an intentional
  // clear; it must neither inherit old frame freezes nor modify model locks.
  result.frozenAtoms = displayFrozenAtomIds === undefined
    ? [...new Set([...idsToIndices(getFrozenAtomIds(document)), ...mapped(incoming.frozenAtoms ?? [])])]
    : [...new Set(idsToIndices(displayFrozenAtomIds))];
  result.scan = []; result.frozenCoordinates = [];
  const keyOf = (type:'B'|'A'|'D', values: number[],images?:Vector3[]) => modelCoordinateKey({type,atomIds:values.map(value=>draft.structure.atoms[value]?.id!),images});
  const ownedGeometry = new Set<string>(), seen = { scan: new Set<string>(), frozenCoordinates: new Set<string>() };
  // The document's stable IDs and explicit F/S action are authoritative. A
  // legacy numeric overlay must never reclassify an imported scan as frozen.
  for (const [i, coordinate] of effectiveModelCoordinates(document).entries()) {
    const values = idsToIndices(coordinate.atomIds);
    const count = coordinate.type === 'B' ? 2 : coordinate.type === 'A' ? 3 : 4;
    if (values.length !== count || values.length !== coordinate.atomIds.length) continue;
    try{validatePeriodicEndpointImages(draft.structure,coordinate.atomIds,coordinate.images);}catch{continue;}
    const category = coordinate.action === 'scan' ? 'scan' : 'frozenCoordinates', key = keyOf(coordinate.type, values,coordinate.images);
    ownedGeometry.add(key);
    if (seen[category].has(key)) continue;
    seen[category].add(key);
    result[category]!.push({ id: coordinate.id ?? `document-coordinate-${i}`, type: coordinate.type, atoms: values,...(coordinate.images?{images:coordinate.images.map(image=>[...image] as Vector3)}:{}), label: coordinate.action === 'scan' ? '扫描' : '冻结' });
  }
  // Imported scans are source evidence, not the current task's scan marks.
  // The importer resolves a source D once into an ordinary stable-ID object.
  for (const category of ['scan', 'frozenCoordinates'] as const) for (const item of incoming[category] ?? []) {
    const values = mapped(item.atoms);
    if (values.length !== item.atoms.length) continue;
    try{validatePeriodicEndpointImages(draft.structure,values.map(value=>draft.structure.atoms[value]?.id!),item.images);}catch{continue;}
    const key=keyOf(item.type,values,item.images);if(ownedGeometry.has(key)||seen[category].has(key))continue;
    seen[category].add(key); result[category]!.push({ ...item, atoms: values } as DisplayCoordinate);
  }
  return result;
}
export function colorRegions(settings: DisplaySettings, highlights: ViewerHighlights): MoleculeRegion[] {
  if (settings.colorMode === 'elements') return [];
  if (settings.colorMode === 'frozen') return highlights.frozenAtoms?.length ? [{ id: 'frozen', label: '冻结设置', color: FREEZE_COLOR, atomIndices: highlights.frozenAtoms }] : [];
  return highlights[settings.colorMode] ?? [];
}
