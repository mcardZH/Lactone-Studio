import {
  augmentSourceCitationRegistry, collectCitations, exportCitationsBibtex, exportCitationsCsv, exportCitationsRis,
  type CitationCollection, type CitationDecisions, type CitationFact, type CitationRegistry,
} from '../../citations';
import { retainedCitationState } from './state';

export type WorkspaceCitationFormat = 'csv' | 'bib' | 'ris';

export function collectWorkspaceExportCitations(options: {
  registry: CitationRegistry;
  facts: readonly CitationFact[];
  retainedDocumentIds?: readonly string[];
  decisions: CitationDecisions;
  version: string;
  documentId?: string;
  warnings?: readonly string[];
}): CitationCollection {
  const { registry, facts, retainedDocumentIds, decisions, version, documentId, warnings = [] } = options;
  const validDecisions = retainedDocumentIds
    ? retainedCitationState({ inputReceipts: [], decisions }, new Set(retainedDocumentIds)).decisions
    : decisions;
  const collection = collectCitations({
    registry: augmentSourceCitationRegistry(registry, facts), facts, decisions: validDecisions,
    softwareVersion: version, scope: documentId === undefined ? undefined : { documentId },
  });
  for (const [index, message] of warnings.entries()) {
    collection.issues.push({ id: `metadata-unavailable:${index}`, code: 'missing-evidence', message });
  }
  return collection;
}

const serializers = { csv: exportCitationsCsv, bib: exportCitationsBibtex, ris: exportCitationsRis };

export function serializeWorkspaceCitations(collection: CitationCollection, format: WorkspaceCitationFormat): string {
  return serializers[format](collection);
}
