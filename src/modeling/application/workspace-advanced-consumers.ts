import type { WorkspaceRegistry } from '../workspace-registry';
import type { AdvancedController } from '../advanced/controller';
import type { AdvancedFrameSource } from '../advanced/frame-source';

const retainedStatuses=new Set(['queued','running','stopping','checkpoint']);

/** Source snapshots let a run continue independently, but an active consumer
 * still protects the source document from an implicit creation-history close. */
export function bindWorkspaceAdvancedConsumers(registry:WorkspaceRegistry,controller:Pick<AdvancedController,'getSnapshot'|'subscribe'>):()=>void {
  const releases=new Map<string,()=>void>();
  let disposed=false,reconciling=false;
  function reconcile(){
    // registerConsumer/release publish registry changes synchronously. Those
    // notifications describe this reconciliation, rather than another task.
    if(disposed||reconciling)return;
    reconciling=true;
    try{
      const desired=new Map<string,{documentId:string;reason:string}>(),state=controller.getSnapshot();
      const documents=new Map(registry.getSnapshot().documents.map(entry=>[entry.id,entry]));
      if(!state.disposed)for(const task of state.tasks){
        const sources:Array<[string,AdvancedFrameSource|undefined]>=[['source',task.spec.source]];
        if(task.spec.kind==='path')sources.push(['product',task.spec.productSource]);
        if(task.spec.kind==='docking')sources.push(['partner',task.spec.partnerSource]);
        for(const run of task.runs)if(retainedStatuses.has(run.status))for(const [role,source] of sources){
          if(!source)continue;
          const {documentId,documentEpoch}=source.ref,document=documents.get(documentId);
          if(!document||document.epoch!==documentEpoch)continue;
          desired.set(`advanced:${task.id}:${run.id}:${role}:${documentId}:${documentEpoch}`,
            {documentId,reason:'派生结构仍被高级任务使用，请先结束该任务。'});
        }
      }
      for(const [key,release] of releases)if(!desired.has(key)){releases.delete(key);release();}
      for(const [key,value] of desired)if(!releases.has(key))releases.set(key,registry.registerConsumer(value.documentId,key,value.reason));
    }finally{reconciling=false;}
  }
  const unsubscribeController=controller.subscribe(reconcile),unsubscribeRegistry=registry.subscribe(reconcile);
  reconcile();
  return ()=>{
    if(disposed)return;disposed=true;unsubscribeController();unsubscribeRegistry();
    for(const release of releases.values())release();releases.clear();
  };
}
