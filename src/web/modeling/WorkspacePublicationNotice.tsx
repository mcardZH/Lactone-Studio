import { useCallback, useSyncExternalStore } from 'react';
import type { WorkspaceBridgeState } from '../../modeling/platform/workspace-bridge';
import { DismissibleNotice } from '../DismissibleNotice';

export interface WorkspacePublicationNoticeAdapter {
  getState(): Pick<WorkspaceBridgeState, 'status' | 'publicationIssue'>;
  subscribeState(listener: () => void): () => void;
  dismissPublicationIssue(issueId: string): void;
}

/** Mount in the owning document's region. Dismissal belongs to the adapter so
 * switching pages or remounting this presentation cannot revive the notice. */
export default function WorkspacePublicationNotice({ adapter, documentId, documentEpoch, label }: {
  adapter: WorkspacePublicationNoticeAdapter;
  documentId: string;
  documentEpoch: string;
  label: string;
}) {
  const subscribe = useCallback((listener: () => void) => adapter.subscribeState(listener), [adapter]);
  const snapshot = useCallback(() => adapter.getState(), [adapter]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot), issue = state.publicationIssue;
  if (state.status === 'disposed' || !issue || issue.documentId !== documentId || issue.documentEpoch !== documentEpoch || issue.dismissed || issue.resolved) return null;
  return <DismissibleNotice key={issue.id} identity={issue.id} role="status" className="workspace-publication-notice"
    aria-label={`${label}的显示同步提示`} onDismiss={() => adapter.dismissPublicationIssue(issue.id)}>
    <strong>{label}</strong><span>：{issue.message}</span>
    <details><summary>查看详情</summary><div>{issue.details}</div></details>
  </DismissibleNotice>;
}
