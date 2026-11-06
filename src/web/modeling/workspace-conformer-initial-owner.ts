import type {AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {workspaceSourceGeometryKey} from './workspace-source-validity';

/** Initial group membership is the live owner. Historical sources can point to
 * a copied predecessor, including two initial records with the same geometry. */
export function conformerInitialDocument(task:AdvancedTaskRecord|undefined,documents:readonly WorkspaceDocumentEntry[],initialId=task?.mixedSampling?.selectedInitialGuessId):WorkspaceDocumentEntry|undefined {
  if(!task)return;
  const candidates=documents.filter(entry=>entry.conformerGroup?.taskId===task.id&&entry.conformerGroup.role==='initial'&&!entry.trajectory);
  const matching=initialId?candidates.filter(entry=>entry.conformerGroup?.role==='initial'&&entry.conformerGroup.initialId===initialId):candidates;
  if(matching.length>1)throw Error('本任务初始结构页归属不唯一，请先核对初猜身份。');
  if(matching.length===1)return matching[0];
  // A sole old unlabelled initial is unambiguous; never choose a different
  // explicitly labelled initial, or guess among several historical pages.
  if(candidates.length===1&&candidates[0].conformerGroup?.role==='initial'&&!candidates[0].conformerGroup.initialId)return candidates[0];
}

/** Confirmation is bound to task + selected initial + current document, not
 * whichever result or sibling initial happens to be the active view. */
export function assertConformerInitialElectronicOwner(task:AdvancedTaskRecord|undefined,documents:readonly WorkspaceDocumentEntry[],initialId:string,source:AdvancedFrameSource):WorkspaceDocumentEntry {
  if(!task||task.mixedSampling?.selectedInitialGuessId!==initialId)throw Error('本次搜索选择的初猜已变化，请重新确认。');
  const entry=conformerInitialDocument(task,documents,initialId);
  if(!entry)throw Error('本任务初始结构页已关闭，不能取用其他页面作为初始来源。');
  if(entry.store.hasTransaction?.())throw Error('请先确认或取消初始结构的几何预览。');
  const document=entry.store.getSnapshot();
  if(source.ref.taskId||source.ref.runId||source.ref.collectionId||source.ref.frameId||source.ref.documentId!==entry.id||source.ref.documentEpoch!==entry.epoch||source.ref.revision!==document.revision||source.structure.charge!==document.draft.structure.charge||source.structure.multiplicity!==document.draft.structure.multiplicity||workspaceSourceGeometryKey(source.structure)!==workspaceSourceGeometryKey(document.draft.structure))throw Error('初始帧在确认期间已变化，请重新确认。');
  return entry;
}
