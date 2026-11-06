import type { WorkspaceRegistry, WorkspaceDocumentEntry } from '../workspace-registry';
import type { WorkspaceDiscardPlan, WorkspaceDiscardTransaction } from '../workspace-contracts';

/** Structural projection of the controller-owned impact contract. This module
 * does not decide scientific ancestry or alter controller result records. */
export interface ConformerDiscardImpact {
  taskId:string;revision:string;scope:'task'|'initial'|'sampling'|'stage';
  initialIds:string[];collectionIds:string[];stageIds:string[];frameIds:string[];
}
export interface WorkspaceDiscardDataOwner { documentId:string;label:string;kind:string;revision?:string;hasData?:boolean }
export interface WorkspaceDiscardDependency { parentDocumentId:string;parentDocumentEpoch?:string;childDocumentId:string }
export interface WorkspaceDiscardImpact {
  rootDocumentId:string;registryPlan:WorkspaceDiscardPlan;conformerPlan?:ConformerDiscardImpact;
  documents:WorkspaceDiscardPlan['documents'];dataOwners:readonly WorkspaceDiscardDataOwner[];
  requiresConfirmation:boolean;impactLabels:readonly string[];
}
export function conformerDiscardSelection(entry:WorkspaceDocumentEntry):{taskId:string;initialId?:string;collectionId?:string}{
  if(entry.trajectory)return{taskId:entry.trajectory.identity.taskId,collectionId:entry.trajectory.identity.collectionId};
  const group=entry.conformerGroup;if(!group)throw Error('此文档没有构象任务归属。');
  if(group.role!=='initial')throw Error('构象集合缺少稳定集合身份，不能猜测丢弃范围。');
  return{taskId:group.taskId,...(group.initialId?{initialId:group.initialId}:{})};
}
export function planWorkspaceDiscard(registry:WorkspaceRegistry,rootDocumentId:string,options:{
  conformerPlan?:ConformerDiscardImpact;additionalDocumentIds?:readonly string[];
  dependencies?:readonly WorkspaceDiscardDependency[];dataOwners?:readonly WorkspaceDiscardDataOwner[];
}={}):WorkspaceDiscardImpact{
  const root=registry.document(rootDocumentId),entries=registry.getSnapshot().documents;
  const ids=new Set([rootDocumentId,...options.additionalDocumentIds??[]]),impact=options.conformerPlan;
  if(impact){
    if((root.trajectory?.identity.taskId??root.conformerGroup?.taskId)!==impact.taskId)throw Error('构象丢弃计划不属于当前文档。');
    const initialIds=new Set(impact.initialIds),collectionIds=new Set(impact.collectionIds),stageIds=new Set(impact.stageIds),frameIds=new Set(impact.frameIds);
    for(const entry of entries){
      const group=entry.conformerGroup,binding=entry.trajectory;
      if(group?.taskId!==impact.taskId&&binding?.identity.taskId!==impact.taskId)continue;
      const affectedInitial=group?.role==='initial'&&Boolean(group.initialId)&&initialIds.has(group.initialId!);
      const affectedCollection=binding&&(collectionIds.has(binding.identity.collectionId)||stageIds.has(binding.identity.stageId)||binding.frameIds.some(id=>frameIds.has(id)));
      if(impact.scope==='task'||affectedInitial||affectedCollection)ids.add(entry.id);
    }
  }
  // Explicit dependency edges come from the existing analysis/source owners.
  // Derived model ancestry is resolved by the registry using its actual epochs.
  let expanded=true;
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  while(expanded){expanded=false;
    for(const id of registry.planDiscardDocuments([...ids]).documentIds)if(!ids.has(id)){ids.add(id);expanded=true;}
    for(const edge of options.dependencies??[]){if(!ids.has(edge.parentDocumentId))continue;const parent=byId.get(edge.parentDocumentId);if(!parent||edge.parentDocumentEpoch&&parent.epoch!==edge.parentDocumentEpoch)continue;if(byId.has(edge.childDocumentId)&&!ids.has(edge.childDocumentId)){ids.add(edge.childDocumentId);expanded=true;}}
  }
  const registryPlan=registry.planDiscardDocuments([...ids]),dataOwners=Object.freeze((options.dataOwners??[]).filter(owner=>ids.has(owner.documentId)).map(owner=>Object.freeze({...owner})));
  const labels=[...registryPlan.documents.map(row=>row.label),...dataOwners.filter(owner=>owner.hasData!==false).map(owner=>owner.label)];
  if(impact)labels.push(impact.scope==='task'?'关联构象任务及其记录':impact.scope==='initial'?'该初猜的采样分支及优化后代':impact.scope==='sampling'?'全部采样批次及优化后代':'本级优化及更高级结果');
  return Object.freeze({rootDocumentId,registryPlan,...(impact?{conformerPlan:impact}:{}),documents:registryPlan.documents,dataOwners,requiresConfirmation:registryPlan.requiresConfirmation||Boolean(impact)||dataOwners.some(owner=>owner.hasData!==false),impactLabels:Object.freeze([...new Set(labels)])});
}
export interface WorkspaceDiscardExecution extends WorkspaceDiscardTransaction {
  status():{phase:'prepared'|'committed'|'commit-failed'|'cleanup-pending'|'released';pendingOwners:readonly string[]};
}
/** Every prepare/identity check completes before commit. The same JS turn
 * commits controller, data-owner and registry metadata; no IO is awaited until
 * logical ownership has retired. A cleanup failure never claims rollback. */
export async function prepareWorkspaceDiscard(impact:WorkspaceDiscardImpact,ports:{
  registry:WorkspaceRegistry;
  assertOwners?(impact:WorkspaceDiscardImpact):void;
  assertConformer?(plan:ConformerDiscardImpact):void;
  prepareConformer?(plan:ConformerDiscardImpact):WorkspaceDiscardTransaction|Promise<WorkspaceDiscardTransaction>;
  prepareOwners?(impact:WorkspaceDiscardImpact):readonly (WorkspaceDiscardTransaction&{ownerId?:string})[]|Promise<readonly (WorkspaceDiscardTransaction&{ownerId?:string})[]>;
}):Promise<WorkspaceDiscardExecution>{
  ports.registry.assertDiscardDocumentsCurrent(impact.registryPlan);
  ports.assertOwners?.(impact);
  if(impact.dataOwners.some(owner=>owner.hasData!==false)&&!ports.prepareOwners)throw Error('关联数据owner尚未就绪，未丢弃任何内容。');
  if(impact.conformerPlan&&!ports.prepareConformer)throw Error('构象任务owner尚未就绪，未丢弃任何内容。');
  if(impact.conformerPlan)ports.assertConformer?.(impact.conformerPlan);
  const parts:{id:string;transaction:WorkspaceDiscardTransaction;committed:boolean;released:boolean;producer?:boolean}[]=[];
  if(impact.conformerPlan)parts.push({id:`conformer:${impact.conformerPlan.taskId}`,transaction:await ports.prepareConformer!(impact.conformerPlan),committed:false,released:false,producer:true});
  for(const [index,owner]of(await ports.prepareOwners?.(impact)??[]).entries())parts.push({id:owner.ownerId??`document-owner:${index}`,transaction:owner,committed:false,released:false});
  parts.push({id:'workspace-registry',transaction:ports.registry.prepareDiscardDocuments(impact.registryPlan),committed:false,released:false});
  const coveredConsumers=new Set(parts.flatMap(part=>part.transaction.consumerIds??[]));
  const unknownConsumers=impact.registryPlan.documents.flatMap(row=>row.consumerIds.filter(id=>!coveredConsumers.has(id)&&!(impact.conformerPlan&&id.startsWith(`advanced:${impact.conformerPlan.taskId}:`))));
  if(unknownConsumers.length)throw Object.assign(Error('文档仍被计划范围外的下游owner使用，请先纳入其影响计划并结束对应任务。'),{code:'WORKSPACE_DISCARD_UNPLANNED_CONSUMER',consumerIds:unknownConsumers});
  let phase:ReturnType<WorkspaceDiscardExecution['status']>['phase']='prepared',inflight:Promise<void>|undefined;
  const assertCurrent=()=>{
    ports.registry.assertDiscardDocumentsCurrent(impact.registryPlan);
    ports.assertOwners?.(impact);
    if(impact.conformerPlan)ports.assertConformer?.(impact.conformerPlan);
    for(const part of parts)part.transaction.assertCurrent?.();
  };
  assertCurrent();
  return{
    assertCurrent,
    commit(){
      if(phase!=='prepared'){if(phase==='commit-failed')throw Error('丢弃提交曾失败，保留owner等待收尾；不能重复提交。');return;}
      assertCurrent();
      try{for(const part of parts){part.transaction.commit();part.committed=true;}phase='committed';}
      catch(error){phase='commit-failed';throw Object.assign(new Error('丢弃元数据提交未全部完成，已保留实际owner状态；未报告成功。',{cause:error}),{code:'WORKSPACE_DISCARD_COMMIT_FAILED',metadataCommitted:parts.some(part=>part.committed),committedOwners:parts.filter(part=>part.committed).map(part=>part.id)});}
    },
    release(){
      if(phase==='prepared')return Promise.reject(Error('丢弃尚未提交，不能释放当前内容。'));
      if(phase==='commit-failed')return Promise.reject(Object.assign(Error('丢弃元数据尚未全部提交，保留资源owner等待收尾；不能提前回收生产者缓存。'),{code:'WORKSPACE_DISCARD_COMMIT_FAILED',pendingOwners:parts.filter(part=>part.committed&&!part.released).map(part=>part.id)}));
      if(inflight)return inflight;
      inflight=(async()=>{
        const failures:unknown[]=[];
        const release=async(part:typeof parts[number])=>{try{await part.transaction.release();part.released=true;}catch(error){failures.push(error);}};
        // Stop readers/analysis IO before allowing producer cache reclamation.
        // A failed consumer keeps the producer lease pending for the same retry.
        await Promise.all(parts.filter(part=>!part.producer&&part.id!=='workspace-registry'&&part.committed&&!part.released).map(release));
        if(!failures.length)await Promise.all(parts.filter(part=>part.id==='workspace-registry'&&part.committed&&!part.released).map(release));
        if(!failures.length)await Promise.all(parts.filter(part=>part.producer&&part.committed&&!part.released).map(release));
        if(failures.length){phase='cleanup-pending';throw Object.assign(new AggregateError(failures,'内容已丢弃，部分owner资源仍待收尾；未报告全部释放。'),{code:'WORKSPACE_DISCARD_CLEANUP_PENDING',pendingOwners:parts.filter(part=>part.committed&&!part.released).map(part=>part.id)});}
        phase='released';
      })().finally(()=>{inflight=undefined;});return inflight;
    },
    status:()=>({phase,pendingOwners:parts.filter(part=>part.committed&&!part.released).map(part=>part.id)}),
  };
}
