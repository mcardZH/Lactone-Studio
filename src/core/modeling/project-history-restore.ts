import { createBuilderDraft } from '../builder-draft';
import type { ModelDocument, ModelProjectContext, ModelProjectHistoryEntry, ModelProjectLinkedToken, ModelProjectReplayState, ModelStoreProjectState } from './contracts';
import { cleanDocument, validateCoordinates, validateExtras } from './model-document-validation';
import {validateFrameBondOverrides,frameBondIdentityKey} from './frame-bond-overrides';

type Direction = 'past' | 'future';
const directions = ['past', 'future'] as const;
export const modelHistorySaveBudget = { maxEntries: 100, maxBytes: 8 * 1024 * 1024 };

export function assertPlainProjectModel(value: unknown): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('项目模型含无效数值。');
    return;
  }
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype))
    throw new Error('项目模型不能包含运行对象。');
  for (const part of Object.values(value)) assertPlainProjectModel(part);
}

/** Preserve the writer's existing ordering and independent contiguous cutoffs. */
export function selectProjectHistory(
  pastLength: number,
  futureLength: number,
  readEntry: (direction: Direction, index: number) => ModelProjectHistoryEntry | undefined,
) {
  const { maxEntries, maxBytes } = modelHistorySaveBudget;
  const kept: Record<Direction, ModelProjectHistoryEntry[]> = { past: [], future: [] };
  const blocked = new Set<Direction>(), encoder = new TextEncoder();
  let count = 0, bytes = 0;
  for (let index = 0; index < Math.max(pastLength, futureLength) && count < maxEntries; index++) {
    for (const direction of directions) {
      if (blocked.has(direction)) continue;
      const entry = readEntry(direction, index);
      if (entry === undefined) continue;
      const size = encoder.encode(JSON.stringify(entry)).byteLength;
      if (bytes + size > maxBytes || count >= maxEntries) { blocked.add(direction); continue; }
      kept[direction].push(entry);
      bytes += size;
      count++;
    }
  }
  kept.past.reverse();
  return kept;
}

export function checkProjectModelDocument(value: ModelDocument): void {
  validateFrameBondOverrides(value?.frameBondOverrides);
  if(value?.analysisFrameBondOrigin){if(typeof value.analysisFrameBondOrigin.bindingId!=='string'||!value.analysisFrameBondOrigin.bindingId)throw Error('项目显示键初始来源绑定无效。');frameBondIdentityKey(value.analysisFrameBondOrigin.identity);}
  if (!value || typeof value.id !== 'string' || !value.id || !Number.isInteger(value.revision) || value.revision < 0)
    throw new Error('项目模型身份或修订无效。');
  const structure = value.draft?.structure;
  if (!structure || structure.atoms.some(atom => !atom.id || ![atom.x,atom.y,atom.z].every(Number.isFinite))
    || new Set(structure.atoms.map(atom => atom.id)).size !== structure.atoms.length)
    throw new Error('项目模型原子身份或坐标无效。');
  createBuilderDraft(structure,value.draft.assignments);
  validateExtras(value);
  if (!value.draft.createdFrom || typeof value.draft.createdFrom !== 'object') throw new Error('项目模型继承记录无效。');
  cleanDocument(structuredClone(value));
}

export function checkProjectModelContexts(value: Record<string,ModelProjectContext>, model: ModelDocument): void {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'gaussian' && key !== 'orca'))
    throw new Error('项目输入上下文无效。');
  const ids = new Set(model.draft.structure.atoms.map(atom => atom.id));
  for (const context of Object.values(value)) {
    if ([...context.assignments.layers,...context.assignments.basis,...context.assignments.fragments].some(region => region.atomIds.some(id => !ids.has(id)))
      || context.assignments.frozenAtomIds.some(id => !ids.has(id))) throw new Error('项目输入上下文引用失效原子。');
    validateCoordinates(context.coordinates,model.draft.structure);
  }
}

function checkProjectReplay(entry: ModelProjectReplayState, documentId: string): void {
  if (entry.kind === 'structure') {
    checkProjectModelDocument(entry.document);
    if (entry.document.id !== documentId) throw new Error('项目历史引用另一模型。');
    checkProjectModelContexts(entry.contexts,entry.document);
  } else if (entry.kind !== 'selection' || !entry.selection || !Array.isArray(entry.selection.atomIds)
    || !Array.isArray(entry.selection.bonds) || !Array.isArray(entry.selection.auxiliaryIds)) {
    throw new Error('项目模型历史无效。');
  }
}

export function checkProjectHistoryEntry(entry: ModelProjectHistoryEntry, documentId: string): void {
  if (entry.kind !== 'linked') { checkProjectReplay(entry,documentId); return; }
  const { token } = entry;
  if (!token.id || !token.groupId || !['structure','selection'].includes(token.kind) || !Array.isArray(token.members))
    throw new Error('项目关联历史无效。');
  for (const member of token.members) for (const state of [member.before,member.after]) {
    if (state.kind !== token.kind) throw new Error('项目关联历史类型不一致。');
    checkProjectReplay(state,member.documentId);
  }
}

/** Project a legacy oversized history into replayable nearest sequences. The
 * caller retains the original before replacing any model with its projection. */
export function prepareRestoredModelStoreHistories(models: readonly ModelStoreProjectState[]): { models: ModelStoreProjectState[]; limited: boolean } {
  if (models.some(model => !model?.document?.id || !Array.isArray(model.past) || !Array.isArray(model.future)))
    return { models: [...models], limited: false };
  const candidates = models.map(model => {
    const kept = selectProjectHistory(model.past.length, model.future.length, (direction,index) =>
      direction === 'past' ? model.past[model.past.length - index - 1] : model.future[index]);
    return { model, kept };
  });
  const limited = candidates.some(({model,kept}) => kept.past.length !== model.past.length || kept.future.length !== model.future.length);
  if (!limited) return { models: [...models], limited: false };

  const tokenDirections = new Map<string,Direction>();
  const ambiguousTokens = new Set<string>();
  for (const {kept} of candidates) {
    const seen = new Set<string>();
    for (const direction of directions) for (const entry of kept[direction]) {
      if (entry?.kind !== 'linked' || typeof entry.token?.id !== 'string') continue;
      const id = entry.token.id, previous = tokenDirections.get(id);
      if (seen.has(id) || previous && previous !== direction) ambiguousTokens.add(id);
      seen.add(id);
      tokenDirections.set(id,direction);
    }
  }

  for (const direction of directions) {
    const cursors = new Map(candidates.map(({model,kept}) => [model.document.id, {
      entries: direction === 'past' ? [...kept.past].reverse() : kept.future,
      used: 0,
    }]));
    const tokenSignatures = new Map<ModelProjectLinkedToken,string>();
    const signature = (token: ModelProjectLinkedToken) => {
      if (!tokenSignatures.has(token)) tokenSignatures.set(token,JSON.stringify(token));
      return tokenSignatures.get(token);
    };
    const replayable = new Set<ModelProjectHistoryEntry>();
    for (const [id,cursor] of cursors) for (const entry of cursor.entries) {
      try { assertPlainProjectModel(entry); checkProjectHistoryEntry(entry,id); replayable.add(entry); }
      catch { break; }
    }
    const applied = new Set<string>();
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const [id,cursor] of cursors) {
        const next = cursor.entries[cursor.used];
        if (!replayable.has(next)) continue;
        if (next.kind !== 'linked') { cursor.used++; advanced = true; continue; }
        const token = next.token, memberIds = token.members.map(member => member.documentId);
        if (ambiguousTokens.has(token.id) || applied.has(token.id) || memberIds.length < 2 || new Set(memberIds).size !== memberIds.length || !memberIds.includes(id)) continue;
        const members = memberIds.map(memberId => cursors.get(memberId));
        if (!members.every(member => {
          const entry = member?.entries[member.used];
          return entry?.kind === 'linked' && replayable.has(entry) && entry.token.id === token.id && signature(entry.token) === signature(token);
        })) continue;
        members.forEach(member => { member!.used++; });
        applied.add(token.id);
        advanced = true;
      }
    }
    for (const {model,kept} of candidates) {
      const cursor = cursors.get(model.document.id)!;
      const replay = cursor.entries.slice(0,cursor.used);
      kept[direction] = direction === 'past' ? replay.reverse() : replay;
    }
  }
  return { limited, models: candidates.map(({model,kept}) => {
    const omittedPast = model.past.length - kept.past.length, omittedFuture = model.future.length - kept.future.length;
    if (!omittedPast && !omittedFuture) return model;
    const previous = model.document.projectHistoryLimited;
    const projectHistoryLimited = { omittedPast: (previous?.omittedPast ?? 0) + omittedPast, omittedFuture: (previous?.omittedFuture ?? 0) + omittedFuture };
    return { ...model, ...kept, document: { ...model.document, projectHistoryLimited, canUndo: kept.past.length > 0, canRedo: kept.future.length > 0 },
      history: { ...model.history, omittedPast: (model.history?.omittedPast ?? 0) + omittedPast, omittedFuture: (model.history?.omittedFuture ?? 0) + omittedFuture } };
  }) };
}
