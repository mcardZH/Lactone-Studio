import type { ModelDocument } from '../../modeling/contracts';
import { assertStructureInteractionSource } from '../../results/interaction-structure-context';
import { AnalysisCardDeck, type AnalysisPage } from './PostprocessDisplayPanel';

/** This is an explicit display route, not a quantum result or runtime owner. */
export function currentStructureAnalysisActive(options: {
  documentId: string; activeDocumentId?: string | null; displayedDocumentId?: string | null;
  module: string; selected: boolean; hasResult: boolean; hasPostprocessDocument: boolean; blocked: boolean;
}): boolean {
  return options.module === 'analysis' && options.selected && !options.hasResult && !options.hasPostprocessDocument
    && !options.blocked && options.documentId === options.activeDocumentId && options.documentId === options.displayedDocumentId;
}

export function currentStructureAnalysisUnavailable(document: ModelDocument, page: AnalysisPage): string | undefined {
  if (page !== 'interaction') return '请载入当前模型的计算来源。';
  try { assertStructureInteractionSource(document.draft.structure); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export default function CurrentStructureAnalysisEntry(props: {
  document: ModelDocument; selected: boolean; onOpen(documentId: string): void;
}) {
  if (props.selected) return null;
  return <aside className="postprocess-display" aria-label="当前结构分析" data-testid="current-structure-analysis-entry" data-document-id={props.document.id}>
    <AnalysisCardDeck activeId={props.selected ? 'interaction' : undefined}
      unavailableReason={page => currentStructureAnalysisUnavailable(props.document, page)}
      onSelect={page => { if (!currentStructureAnalysisUnavailable(props.document, page)) props.onOpen(props.document.id); }}/>
  </aside>;
}
