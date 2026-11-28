import type { ModelDocument } from '../../modeling/contracts';
import { assertStructureInteractionSource,createStructureAnalysisContext } from '../../results/interaction-structure-context';
import {hirshfeldClusterFromStructure} from '../../results/hirshfeld-presentation';
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
  if (page !== 'interaction' && page !== 'surface') return '请载入当前模型的计算来源。';
  try {
    if(page==='surface')hirshfeldClusterFromStructure(document.draft.structure,createStructureAnalysisContext(document));
    else assertStructureInteractionSource(document.draft.structure);
  }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export default function CurrentStructureAnalysisEntry(props: {
  document: ModelDocument; selected: boolean; onOpen(documentId: string, page?:'surface'): void;
}) {
  if (props.selected) return null;
  return <section className="analysis-workspace" aria-label="当前结构分析" data-testid="current-structure-analysis-entry" data-document-id={props.document.id}>
    <AnalysisCardDeck
      unavailableReason={page => currentStructureAnalysisUnavailable(props.document, page)}
      onSelect={page => { if (!currentStructureAnalysisUnavailable(props.document, page)) {
        if(page==='surface')props.onOpen(props.document.id,'surface');
        else props.onOpen(props.document.id);
      } }}/>
  </section>;
}
