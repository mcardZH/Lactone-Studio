import { pickerStructureIdentity } from '../../core/geometry-guides';
import type { PesCard, PesGeometry, PesGroup } from './contracts';

export const scanSourceKey = (value: Pick<PesGeometry, 'source'>) => JSON.stringify([
  value.source?.groupId, value.source?.nodeId, value.source?.runId, value.source?.seriesId, value.source?.frameId, value.source?.recordId,
]);

export function samePesScanSource(a: PesGeometry, b: PesGeometry): boolean {
  return a.documentId === b.documentId && a.revision === b.revision && scanSourceKey(a) === scanSourceKey(b) &&
    pickerStructureIdentity(a.structure) === pickerStructureIdentity(b.structure) &&
    JSON.stringify(a.structure.cell) === JSON.stringify(b.structure.cell);
}

export function scanCardDraft(group: PesGroup): PesCard | undefined {
  return group.cardDrafts?.['sella-scan'] ?? Object.values(group.cardDrafts ?? {}).find(card => card.kind === 'scan');
}
