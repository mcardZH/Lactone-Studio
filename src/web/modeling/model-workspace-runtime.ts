import type { ChemistryJob, ModelStore } from '../../modeling/contracts';
import type { WorkspaceActivationStamp } from '../../modeling/workspace-contracts';

export interface WorkspaceRuntimeOwner {
  store: ModelStore;
  documentId: string;
  generation: number;
  lease?: WorkspaceActivationStamp;
}
interface WorkspaceRuntimeCurrent {
  alive: boolean;
  generation: number;
  store: ModelStore;
  active?: boolean;
  assertRuntimeCurrent?(stamp: WorkspaceActivationStamp): void;
  assertActivationIdentity?(stamp: WorkspaceActivationStamp): void;
}

/** This guard owns only document lifetime. Its fixed document ID/epoch are
 * checked against the registry's CURRENT revision so the controller's own
 * accepted frame and subsequent bond stage remain valid. Original native
 * request stamps, geometry, electronic state and constraints are still checked
 * independently by the controller/Store; this lease never replaces them. */
export function assertModelWorkspaceRuntimeOwner(owner: WorkspaceRuntimeOwner, current: WorkspaceRuntimeCurrent) {
  if (!current.alive || owner.store !== current.store || owner.documentId !== current.store.getSnapshot().id
    || owner.generation !== current.generation) throw new Error('运行所属文档已变化，未继续应用结果。');
  if (current.assertRuntimeCurrent) {
    if (!owner.lease) throw new Error('运行缺少固定文档身份。');
    current.assertRuntimeCurrent({ ...owner.lease, revision: current.store.getSnapshot().revision });
  } else {
    if (current.active === false) throw new Error('运行期间活动视图已变化。');
    if (owner.lease) current.assertActivationIdentity?.(owner.lease);
  }
}

/** Visibility cancels only unowned legacy views. Workspace owners survive tab,
 * module and unrelated-document close transitions; import has its own guard. */
export function deactivateModelWorkspaceRuntime(hasOwner: boolean, cancelLegacyRuntime: () => void) {
  if (!hasOwner) cancelLegacyRuntime();
}

export function modelWorkspaceRuntimeBusy(source: {
  xtb: { getSnapshot(): { running: boolean } };
  dynamics: { getSnapshot(): { status: string; termination?: { status: string } } };
  optimization: { readonly busy: boolean };
  task: ChemistryJob | null;
  pendingJobs: number;
  pendingImports: number;
  savePending: boolean;
  store: ModelStore;
}): boolean {
  const dynamics = source.dynamics.getSnapshot();
  return source.xtb.getSnapshot().running || ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(dynamics.status)
    || dynamics.termination?.status === 'pending' || source.optimization.busy || !!source.task || source.pendingJobs > 0
    || source.pendingImports > 0 || source.savePending || source.store.isRuntimeSessionActive?.() === true;
}
