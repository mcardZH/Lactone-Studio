import type { ModelStore } from '../../modeling/contracts';
import type { WorkspaceActivationStamp } from '../../modeling/workspace-contracts';

export interface ClipboardPreviewIdentity {
  alive:boolean; active?:boolean; store:ModelStore; generation:number;
  intentEpoch:number; contextIdentity:string;
  activationStamp?():WorkspaceActivationStamp;
  assertActivation?(stamp:WorkspaceActivationStamp):void;
}
/** A pending private clipboard read may publish a preview only to the exact
 * still-current document, task, activation and tool intent that requested it. */
export function createClipboardPreviewGuard(read:()=>ClipboardPreviewIdentity):()=>void {
  const before={...read()},source=before.store.getSnapshot(),lease=before.activationStamp?.();
  const check=()=>{
    const now=read(),current=now.store.getSnapshot();
    if(!now.alive||now.active===false||now.store!==before.store||now.generation!==before.generation
      ||now.intentEpoch!==before.intentEpoch||now.contextIdentity!==before.contextIdentity
      ||current.id!==source.id||current.revision!==source.revision)
      throw new Error('模型或任务上下文已变化，请重新读取复制片段。');
    if(lease){try{if(!now.assertActivation)throw new Error('Missing activation guard');now.assertActivation(lease);}catch{throw new Error('模型或任务上下文已变化，请重新读取复制片段。');}}
  };
  check();return check;
}
