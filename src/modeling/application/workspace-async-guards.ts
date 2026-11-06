import type { ModelStore } from '../contracts';
import type { WorkspaceActivationStamp } from '../workspace-contracts';

export interface WorkspaceAsyncIdentity {
  alive: boolean; generation: number; store: ModelStore; active?: boolean;
  activationStamp?(): WorkspaceActivationStamp;
  assertActivation?(stamp: WorkspaceActivationStamp): void;
}

/** Lifetime/activation guard only. A native pause may still accept a final
 * frame; callers seal revision and request identity at their own boundary. */
export function createWorkspaceAsyncGuard(read: () => WorkspaceAsyncIdentity): () => void {
  const source = { ...read() }, documentId = source.store.getSnapshot().id, lease = source.activationStamp?.();
  const assertCurrent = () => {
    const current = read();
    if (!current.alive || current.active === false || source.generation !== current.generation || source.store !== current.store || documentId !== current.store.getSnapshot().id) throw new Error('保存期间文档或活动视图已变化，请重新保存。');
    if (lease) {
      if (!current.assertActivation) throw new Error('保存活动身份校验不可用，请重新保存。');
      current.assertActivation(lease);
    }
  };
  assertCurrent(); return assertCurrent;
}

/** Personal fragment operations additionally require the exact source
 * revision and an editable owner; they cannot use save's pause exception. */
export function createPersonalFragmentContextGuard(read: () => WorkspaceAsyncIdentity, assertEditable: () => void): () => void {
  const assertLifetime = createWorkspaceAsyncGuard(read), source = read().store.getSnapshot();
  const guard = () => {
    assertLifetime(); const current = read().store.getSnapshot();
    if (current.id !== source.id || current.revision !== source.revision) throw new Error('个人片段操作期间模型修订已变化，请重新操作。');
    assertEditable();
  };
  guard(); return guard;
}
