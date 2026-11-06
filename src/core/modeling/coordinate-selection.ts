import type { ModelCoordinateObject, ModelDocument } from '../../modeling/contracts';
import { modelCoordinateKey } from '../../modeling/constraints';

/** One identity projection for visible/selectable formal or task B/A/D objects.
 * Pending automatic measurement is view-local and is intentionally absent.
 * This read never materializes an object or mutates a scientific task. */
export function coordinateSelectionObjects(document: Pick<ModelDocument, 'coordinateObjects' | 'internalCoordinates' | 'sharedConstraints'>): ModelCoordinateObject[] {
  const result = (document.coordinateObjects ?? []).map(object => structuredClone(object));
  for (const row of [...(document.internalCoordinates ?? []), ...(document.sharedConstraints?.coordinates ?? [])]) {
    if (result.some(object => modelCoordinateKey(object) === modelCoordinateKey(row))) continue;
    result.push({ id: row.objectId ?? (row.images?.some(image=>image.some(Boolean))?`coordinate-${modelCoordinateKey(row)}`:`coordinate-${row.type}-${row.atomIds.join('-')}`), type: row.type, atomIds: [...row.atomIds],...(row.images?{images:structuredClone(row.images)}:{}) });
  }
  return result;
}
