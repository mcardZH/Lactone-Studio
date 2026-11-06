import type { Structure } from '../../core/types';
import { getBuilderTemplate } from '../../core/builder-templates';
import { getElementPreset } from '../../core/modeling/element-presets';
import { createModelStore } from '../../core/modeling/model-store';
import type { AttachmentPort, ClipboardPayload } from '../../modeling/contracts';
import { fragmentPreviewDocument } from './Fragment3DPreview';

export type ActiveStructurePreviewSource =
  | { kind: 'element'; presetId: string }
  | { kind: 'template'; templateId: string }
  | { kind: 'copy'; payload: ClipboardPayload; label?: string; sourceKey?: string }
  | { kind: 'copy'; snapshot: Structure; attachmentPorts?: readonly AttachmentPort[]; sourceKey: string; label?: string };
export interface ActiveStructurePreviewModel {
  kind: ActiveStructurePreviewSource['kind']; key: string; label: string;
  structure: Structure; attachmentPorts: AttachmentPort[];
  payload: ClipboardPayload; defaultActiveAtomIndex: number;
}

/** Build once per stable preset/template/copy identity in the workspace's
 * useMemo. A private, disposable model store executes the actual production
 * placement transaction; this view model never receives the current store,
 * selection, history or engine context, and owns no hydrogen algorithm. */
export function createActiveStructurePreview(source: ActiveStructurePreviewSource): ActiveStructurePreviewModel {
  let payload: ClipboardPayload, label: string, key: string, defaultActiveAtomIndex = 0;
  if (source.kind === 'copy') {
    if ('payload' in source) {
      payload = structuredClone(source.payload);
      label = source.label ?? payload.fragment.structure.name ?? '复制片段';
      key = `copy:${source.sourceKey ?? payload.sourceDocumentId}`;
    } else {
      payload = { schema: 'sciyue-model-fragment', version: 1, sourceDocumentId: source.sourceKey, fragment: {
        structure: structuredClone(source.snapshot), assignments: { layers: [], basis: [], fragments: [], frozenAtomIds: [] },
        auxiliaryRelations: [], deletedBonds: [], attachmentPorts: structuredClone([...(source.attachmentPorts ?? [])]),
      } };
      label = source.label ?? source.snapshot.name ?? '复制片段'; key = `copy:${source.sourceKey}`;
    }
  } else {
    const temporary = createModelStore();
    if (source.kind === 'element') {
      const preset = getElementPreset(source.presetId);
      temporary.execute({ type: 'place-element', element: preset.element, presetId: source.presetId, position: [0, 0, 0] });
      label = `${preset.element} · ${preset.label}`; key = `element:${source.presetId}`;
    } else {
      const template = getBuilderTemplate(source.templateId);
      if (!template) throw new Error('未知结构预览模板。');
      temporary.execute({ type: 'place-fragment', templateId: source.templateId, position: [0, 0, 0] });
      label = template.label; key = `template:${source.templateId}`;
      defaultActiveAtomIndex = template.connectionAnchor;
    }
    payload = temporary.copy('all');
  }
  const structure = payload.fragment.structure, attachmentPorts = payload.fragment.attachmentPorts ?? [];
  // The read adapter checks identities, finite coordinates, real bonds and
  // port ownership before the model is offered as an interactive preview.
  fragmentPreviewDocument(structure, key, attachmentPorts);
  return { kind: source.kind, key, label, structure, attachmentPorts, payload, defaultActiveAtomIndex };
}

/** A pointer choice belongs to the exact preview object present at press.
 * Same-key replacements and A -> B -> A switches cannot select another seed. */
export function activeStructurePreviewChoice(preview: ActiveStructurePreviewModel, start: ActiveStructurePreviewModel, index: number): number | null {
  return preview === start && Number.isSafeInteger(index) && index >= 0 && index < preview.structure.atoms.length ? index : null;
}
