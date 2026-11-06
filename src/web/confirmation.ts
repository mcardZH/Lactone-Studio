/** Synchronous guards must stay synchronous: a Promise here could admit a
 * scientific edit before the user's answer. Native confirmation is the host
 * exception to app-styled dialogs; callers retain their transaction checks. */
export function confirmSynchronousOperation(message: string, ownerDocument?: Document | null): boolean {
  const realm = ownerDocument ? ownerDocument.defaultView : typeof window === 'undefined' ? undefined : window;
  if (!realm || realm.closed || typeof realm.confirm !== 'function') return false;
  return realm.confirm(message) === true;
}

export const ANALYSIS_INVALIDATION_CONFIRMATION = '此操作会改变计算来源对应的结构或电子态，当前后处理信息将失效。撤销该修改后可恢复。是否继续？';
