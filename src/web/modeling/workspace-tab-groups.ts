import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';

export interface TabGroupPresentation {
  groups: Record<string, { label: string; collapsed: boolean }>;
  members: Record<string, string>;
}

export const emptyTabGroupPresentation: TabGroupPresentation = { groups: {}, members: {} };

export function scientificTabGroup(entry: WorkspaceDocumentEntry | undefined): string | undefined {
  return entry?.pesGroup?.groupId ?? entry?.conformerGroup?.taskId;
}

export function tabGroupId(entry: WorkspaceDocumentEntry | undefined, presentation: TabGroupPresentation): string | undefined {
  return scientificTabGroup(entry) ?? (entry && presentation.members[entry.id]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function restoreTabGroupPresentation(value: unknown, documents: readonly WorkspaceDocumentEntry[]): TabGroupPresentation {
  const saved = record(value);
  const nativeGroups = new Set(documents.map(scientificTabGroup));
  const groups: TabGroupPresentation['groups'] = Object.fromEntries(Object.entries(record(saved.groups)).flatMap(([id, item]) => {
    const row = record(item);
    return id.startsWith('tab-group-') && !nativeGroups.has(id) && typeof row.label === 'string' && row.label.trim() &&
      typeof row.collapsed === 'boolean' ? [[id, { label: row.label, collapsed: row.collapsed }]] : [];
  }));
  // Scientific groups can hydrate after document restoration. Their saved node
  // links identify the group independently of the PES reader's readiness.
  const pesGroups = new Set(documents.flatMap(entry => entry.pesGroup ? [entry.pesGroup.groupId] : []));
  const members = record(saved.members);
  return { groups, members: Object.fromEntries(documents.flatMap(entry => {
    const group = members[entry.id];
    return !scientificTabGroup(entry) && typeof group === 'string' && (Object.hasOwn(groups, group) || pesGroups.has(group))
      ? [[entry.id, group]] : [];
  })) };
}

export function moveWorkspaceTabItems(order: readonly string[], moved: readonly string[], target?: string, after = false): string[] {
  if (target && moved.includes(target)) return [...order];
  const next = order.filter(id => !moved.includes(id));
  const index = target === undefined ? -1 : next.indexOf(target);
  next.splice(index < 0 ? next.length : index + Number(after), 0, ...moved);
  return next;
}
