/** Publication errors describe replica synchronization, never the outcome of
 * the scientific task that owns the original model or result. */
export interface WorkspacePublicationIssue {
  id: string;
  documentId: string;
  documentEpoch?: string;
  operationId: string;
  reason: 'registration' | 'publication';
  message: string;
  details: string;
  dismissed: boolean;
  resolved: boolean;
}

export function createWorkspacePublicationErrors(documentId: string) {
  let operationId = 'synchronize', documentEpoch: string | undefined, sequence = 0;
  let current: WorkspacePublicationIssue | undefined;
  // Keep dismissal by cause within the current real operation. A successful
  // poll does not create a new operation or revive an already dismissed cause.
  const causes = new Map<string, WorkspacePublicationIssue>();
  return {
    get: () => current,
    operation: () => operationId,
    setDocumentEpoch(value: string) { documentEpoch = value; },
    setOperation(value: string) {
      if (operationId === value) return false;
      operationId = value; causes.clear(); current = undefined; return true;
    },
    report(reason: WorkspacePublicationIssue['reason'], cause: unknown, expectedOperation = operationId) {
      if (expectedOperation !== operationId) return current;
      const details = cause instanceof Error ? cause.message : String(cause);
      const key = JSON.stringify([reason, cause instanceof Error ? cause.name : typeof cause, details]);
      const prior = causes.get(key);
      current = prior ? { ...prior, resolved: false } : {
        id: `${documentId}:publication:${++sequence}`, documentId, documentEpoch, operationId, reason,
        message: reason === 'registration' ? '模型共享连接未完成。' : '模型显示同步未完成。',
        details, dismissed: false, resolved: false,
      };
      causes.set(key, current); return current;
    },
    resolve(expectedOperation = operationId) { if (expectedOperation === operationId && current && !current.resolved) current = { ...current, resolved: true }; },
    dismiss(id: string) {
      if (!current || current.id !== id || current.dismissed) return false;
      current = { ...current, dismissed: true };
      for (const [key, issue] of causes) if (issue.id === id) causes.set(key, current);
      return true;
    },
  };
}
