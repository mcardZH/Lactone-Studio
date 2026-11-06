export type WorkspaceSnapshotJSONKind = 'snapshot' | 'envelope' | 'viewport' | 'document' | 'display-metadata';
export function copyWorkspaceSnapshotJSON<T>(value:T,kind?:WorkspaceSnapshotJSONKind):T;
export function copyWorkspaceCommandJSON<T>(value:T,kind?:'command'|'request'|'event'):T;
