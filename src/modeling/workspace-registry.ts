import { createModelStore,getModelStoreProjectLinkGroups,restoreModelStoreProjectLinks } from '../core/modeling/model-store';
import {createLinkedModels,type LinkedModels} from './application/linked-models';
import { newModelId } from '../core/modeling/hydrogen-policy';
import type { Structure } from '../core/types';
import {initialBaseElectronicState} from '../core/base-electronic-state';
import { prepareDerivedStructure, derivedDocumentContent } from '../core/modeling/derived-structure-document';
import { periodicWorkingStructure } from '../core/modeling/periodic-working-structure';
import type { StructureTransformCandidate, ModelStoreProjectState, ModelProjectLinkGroup } from '../core/modeling/contracts';
import type { FragmentSnapshot,ModelStore } from './contracts';
import type { TrajectoryResult } from '../results/contracts';
import type { ResultInputIntent } from '../results/continuation';
import type { JsonValue, WorkspaceActivationStamp, WorkspaceDocumentSnapshot, WorkspaceInputTask, WorkspaceInputTaskStamp, WorkspaceModule, WorkspaceTaskSource, WorkspaceViewKind, WorkspaceTrajectoryIdentity, WorkspaceTrajectoryBinding, WorkspaceConformerGroup, WorkspaceDiscardPlan, WorkspaceDiscardTransaction } from './workspace-contracts';

type RuntimePhase='idle'|'starting'|'running'|'pausing'|'paused'|'stopping'|'completed'|'stopped'|'error';
const busyPhases=new Set<RuntimePhase>(['starting','running','pausing','paused','stopping']);
const clone=<T>(value:T):T=>structuredClone(value);
const freezeJSON=<T>(value:T):T=>{if(value!==null&&typeof value==='object'){for(const part of Object.values(value))freezeJSON(part);Object.freeze(value);}return value;};
export const workspaceDocumentLabel=(name:string)=>name.replace(/^.*[\\/]/,'').replace(/\.[^.]+$/,'')||'task';
export const workspaceTrajectoryKey=(identity:WorkspaceTrajectoryIdentity)=>JSON.stringify([identity.taskId,identity.collectionId]);
export interface WorkspaceDocumentEntry {
  readonly id:string; readonly epoch:string; readonly store:ModelStore;
  readonly initialElectronicState:Readonly<{charge:number;multiplicity:number}>;
  label:string; electronicStateConfirmed:boolean;
  drafts:{gaussian?:JsonValue;orca?:JsonValue};inputDirty:{gaussian:boolean;orca:boolean};
  runtime:{ownerId:string|null;phase:RuntimePhase};
  publicationSerial:number;sourceEpoch:number;
  /** Result frames are read-only observations, excluded from input/model ownership. */
  result?:TrajectoryResult;
  /** Existing collection/trajectory tools, with a separate editable working model. */
  legacyResult?:TrajectoryResult;
  trajectory?:WorkspaceTrajectoryBinding;
  /** Presentation membership only; the controller remains the scientific owner. */
  conformerGroup?:Readonly<WorkspaceConformerGroup>;
  /** Original single-point result stays outside Store/Undo; the matching Store
   * token controls availability while this attachment remains recoverable. */
  analysisBinding?:{id:string;result:TrajectoryResult};
  /** One-shot initialization of a newly extracted editable input owner. */
  initialInput?:ResultInputIntent;
  derivation?:{parentDocumentId:string;parentDocumentEpoch:string;parentRevision:number;operation:string;sourceStructure:Structure;atomMapping:StructureTransformCandidate['atomMapping']};
}
export interface WorkspaceViewEntry {
  id:string;documentId:string;kind:WorkspaceViewKind;windowId:string;
  /** Camera and display values stay view-local, never in the model or task source. */
  presentation:JsonValue;
  module:WorkspaceModule;
}
export interface WorkspaceRegistrySnapshot {
  version:number;activationEpoch:number;activeViewId:string|null;module:WorkspaceModule;
  inputTask:WorkspaceInputTask|null;
  documents:readonly WorkspaceDocumentEntry[];views:readonly WorkspaceViewEntry[];
}
export interface WorkspaceProjectAttachments {result?:string;legacyResult?:string;analysisBinding?:{id:string;resultId:string}}
export interface WorkspaceProjectDocument {
  id:string;epoch:string;label:string;initialElectronicState:WorkspaceDocumentEntry['initialElectronicState'];
  model:ModelStoreProjectState;drafts:WorkspaceDocumentEntry['drafts'];inputDirty:WorkspaceDocumentEntry['inputDirty'];
  publicationSerial:number;sourceEpoch:number;initialInput?:ResultInputIntent;
  derivation?:WorkspaceDocumentEntry['derivation'];trajectory?:WorkspaceTrajectoryBinding;conformerGroup?:Readonly<WorkspaceConformerGroup>;
  trajectoryBaseline?:{revision:number;content:string};
  attachments:WorkspaceProjectAttachments;savedRuntimePhase:RuntimePhase;
}
export interface WorkspaceProjectCreation {
  documentId:string;views:WorkspaceViewEntry[];parentViewId:string;parentId:string;parentEpoch:string;baseline:string;contexts:string;parentContent:string;
}
/** The complete ownership graph, independent of which document is mounted. */
export interface WorkspaceProjectState {
  schema:'sciyue-workspace-project';version:1;
  activationEpoch:number;activeViewId:string|null;module:WorkspaceModule;taskSerial:number;
  inputActivationEpoch:number;inputTask:WorkspaceInputTask|null;documentInputTasks:WorkspaceInputTask[];
  previousInputTask:WorkspaceInputTask|null;borrowedInputTask:WorkspaceInputTask|null;
  documents:WorkspaceProjectDocument[];detachedDocuments:WorkspaceProjectDocument[];views:WorkspaceViewEntry[];
  creations:WorkspaceProjectCreation[];creationRedo:WorkspaceProjectCreation[];
  linkedGroups:ModelProjectLinkGroup[];
}
export interface WorkspaceProjectRestoreOptions {
  results?:ReadonlyMap<string,Pick<WorkspaceDocumentEntry,'result'|'legacyResult'|'analysisBinding'>>;
}
export function createWorkspaceRegistry() {
  const documents=new Map<string,WorkspaceDocumentEntry>(),views=new Map<string,WorkspaceViewEntry>();
  const unsubscribers=new Map<string,()=>void>(),listeners=new Set<()=>void>();
  const consumers=new Map<string,Map<string,string>>();
  const projectAttachmentRefs=new Map<string,WorkspaceProjectAttachments>();
  type DiscardLease={roots:string[];entries:WorkspaceDocumentEntry[];models:ReturnType<ModelStore['getSnapshot']>[];drafts:string[];consumers:Set<string>[];sourceEpochs:number[];resultKeys:string[]};
  const discardPlans=new WeakMap<WorkspaceDiscardPlan,DiscardLease>();
  const pendingDiscards=new Map<string,{documentIds:readonly string[];remaining:Set<TrajectoryResult>;release():Promise<void>}>();
  const releasedResults=new WeakSet<TrajectoryResult>(),releasingResults=new WeakMap<TrajectoryResult,Promise<void>>();
  function releaseResult(result:TrajectoryResult):Promise<void>{
    if(releasedResults.has(result))return Promise.resolve();const active=releasingResults.get(result);if(active)return active;
    const operation=Promise.resolve().then(()=>result.dispose()).then(()=>{releasedResults.add(result);}).finally(()=>{releasingResults.delete(result);});releasingResults.set(result,operation);return operation;
  }
  let restoredLinkedModels:LinkedModels|null=null;
  const trajectoryBaselines=new WeakMap<WorkspaceDocumentEntry,{revision:number;content:string}>();
  type Creation={entry:WorkspaceDocumentEntry;views:WorkspaceViewEntry[];parentViewId:string;parentId:string;parentEpoch:string;baseline:string;contexts:string;parentContent:string};
  const creations:Creation[]=[],creationRedo:Creation[]=[];
  let batchDepth=0,batchPending=false;
  let activeViewId:string|null=null,activationEpoch=0,version=0,module:WorkspaceModule='modeling',taskSerial=0;
  let restoredActivationFloor=0;
  let inputTask:WorkspaceInputTask|null=null,inputActivationEpoch=0;
  const documentInputTasks=new Map<string,WorkspaceInputTask>();
  let previousInputTask:WorkspaceInputTask|null=null,borrowedInputTask:WorkspaceInputTask|null=null;
  function retainInputTask(){if(inputTask)documentInputTasks.set(inputTask.documentId,inputTask);}
  function selectDocumentInputTask(documentId:string){if(borrowedInputTask){inputTask=borrowedInputTask;return;}if(inputTask&&inputTask.documentId!==documentId)previousInputTask=inputTask;retainInputTask();const target=documents.get(documentId);inputTask=target&&!readOnlyResult(target)?documentInputTasks.get(documentId)??null:null;if(inputTask){inputTask=Object.freeze({...inputTask,activationEpoch:++inputActivationEpoch});retainInputTask();}}
  let state:WorkspaceRegistrySnapshot={version,activationEpoch,activeViewId,module,inputTask,documents:[],views:[]};
  function emit(){if(batchDepth){batchPending=true;return;}state=Object.freeze({version:++version,activationEpoch,activeViewId,module,inputTask,documents:Object.freeze([...documents.values()].map(entry=>Object.freeze({...entry,drafts:Object.freeze({...entry.drafts}),inputDirty:Object.freeze({...entry.inputDirty}),runtime:Object.freeze({...entry.runtime})}))),views:Object.freeze([...views.values()].map(entry=>Object.freeze({...entry})))});for(const listener of listeners)listener();}
  function batch<T>(operation:()=>T):T{batchDepth++;try{return operation();}finally{if(--batchDepth===0&&batchPending){batchPending=false;emit();}}}
  function subscribeDocument(entry:WorkspaceDocumentEntry){
    const sourceKey=()=>{const value=entry.store.getSnapshot();return JSON.stringify([value.id,value.revision,value.draft.structure.charge,value.draft.structure.multiplicity,value.electronicStateConfirmed===true]);};
    let previousSourceKey=sourceKey();
    unsubscribers.set(entry.id,entry.store.subscribe(()=>{const nextKey=sourceKey();if(nextKey!==previousSourceKey){previousSourceKey=nextKey;entry.sourceEpoch++;}emit();}));
  }
  function document(id:string){const found=documents.get(id);if(!found)throw new Error('模型文档已关闭或不存在。');return found;}
  function readOnlyResult(entry:WorkspaceDocumentEntry){return Boolean(entry.result||projectAttachmentRefs.get(entry.id)?.result);}
  function editableDocument(id:string){const entry=document(id);if(readOnlyResult(entry))throw new Error('结果为只读；请先提取所需帧为新模型。');return entry;}
  function assertInputTaskIdle(entry:WorkspaceDocumentEntry){if(busyPhases.has(entry.runtime.phase)||entry.store.isRuntimeSessionActive?.()||entry.store.hasTransaction?.())throw new Error('原输入任务或新来源仍在运行、暂停或编辑，请先结束后再新建输入任务。');}
  function assertCurrentInputTaskIdle(){if(inputTask)assertInputTaskIdle(editableDocument(inputTask.documentId));}
  function beginInputTaskInternal(documentId:string,publish=true){
    const target=editableDocument(documentId),previous=inputTask?editableDocument(inputTask.documentId):undefined;
    assertInputTaskIdle(target);
    target.drafts={};target.inputDirty={gaussian:false,orca:false};
    retainInputTask();
    borrowedInputTask=null;inputTask=Object.freeze({id:newModelId(),documentId,activationEpoch:++inputActivationEpoch});
    retainInputTask();if(publish)emit();return inputTask;
  }
  function beginInputTask(documentId:string){return beginInputTaskInternal(documentId);}
  /** Borrow a fresh input owner without replacing or resetting the ordinary draft. */
  function borrowInputTask(documentId:string){
    const target=editableDocument(documentId);assertInputTaskIdle(target);assertCurrentInputTaskIdle();
    const candidate=!inputTask||inputTask.documentId===documentId?previousInputTask:inputTask;
    const previous=candidate&&documents.has(candidate.documentId)?candidate:null;
    if(previous)assertInputTaskIdle(editableDocument(previous.documentId));
    inputTask=Object.freeze({id:newModelId(),documentId,activationEpoch:++inputActivationEpoch});borrowedInputTask=inputTask;
    const taskId=inputTask.id;emit();return Object.freeze({taskId,documentId,previous});
  }
  function releaseBorrowedInputTask(borrowed:{taskId:string;documentId:string;previous:WorkspaceInputTask|null}){
    // A newer explicit task owns the input page; an old completion cannot replace it.
    if(inputTask&&inputTask.id!==borrowed.taskId)return;
    borrowedInputTask=null;
    if(borrowed.previous&&documents.has(borrowed.previous.documentId))inputTask=Object.freeze({...borrowed.previous,activationEpoch:++inputActivationEpoch});
    else inputTask=null;
    emit();
  }
  /** Publish the representative and its input owner together, or restore the
   * original workspace without leaving an orphan representative behind. */
  function addBorrowedInputDocument(fragment:FragmentSnapshot,label:string){
    assertCurrentInputTaskIdle();
    const previous={activeViewId,module,inputTask,previousInputTask,borrowedInputTask};
    return batch(()=>{
      let entry:WorkspaceDocumentEntry|undefined;
      try{
        entry=addDocument(fragment.structure,label,fragment);
        const input=borrowInputTask(entry.id);if(activeViewId)view(activeViewId).module='input';module='input';activationEpoch++;emit();return {entry,input};
      }catch(error){
        if(entry&&documents.has(entry.id))closeDocument(entry.id,true);
        ({activeViewId,module,inputTask,previousInputTask,borrowedInputTask}=previous);
        activationEpoch++;emit();throw error;
      }
    });
  }
  function ensureInputTaskInternal(publish=true){
    if(borrowedInputTask)return inputTask=borrowedInputTask;
    const currentView=activeViewId?views.get(activeViewId):undefined,current=currentView?documents.get(currentView.documentId):undefined;
    if(!current||readOnlyResult(current))return null;
    if(inputTask?.documentId===current.id)return inputTask;
    selectDocumentInputTask(current.id);
    return inputTask??beginInputTaskInternal(current.id,publish);
  }
  function ensureInputTask(){return ensureInputTaskInternal();}
  function inputStamp():WorkspaceInputTaskStamp{
    if(!inputTask)throw new Error('没有当前输入任务，请先选择可编辑模型并新建输入任务。');
    const current=editableDocument(inputTask.documentId);
    return {taskId:inputTask.id,documentId:current.id,documentEpoch:current.epoch,revision:current.store.getSnapshot().revision,activationEpoch:inputTask.activationEpoch};
  }
  function assertInputIdentityCurrent(stamp:WorkspaceInputTaskStamp){
    const current=documents.get(stamp.documentId);
    if(module!=='input'||!inputTask||inputTask.id!==stamp.taskId||inputTask.documentId!==stamp.documentId||inputTask.activationEpoch!==stamp.activationEpoch||!current||readOnlyResult(current)||current.epoch!==stamp.documentEpoch)throw new Error('输入任务、来源或输入模块上下文已变化，请重新操作。');
    return current;
  }
  function assertInputCurrent(stamp:WorkspaceInputTaskStamp){const current=assertInputIdentityCurrent(stamp);if(current.store.getSnapshot().revision!==stamp.revision)throw new Error('输入来源模型修订已变化，请重新操作。');return current;}
  function view(id:string){const found=views.get(id);if(!found)throw new Error('结构视图已关闭或不存在。');return found;}
  function activate(id:string){const target=view(id);if(activeViewId!==id){activeViewId=id;module=target.module;selectDocumentInputTask(target.documentId);if(module==='input')ensureInputTaskInternal(false);activationEpoch++;emit();}}
  function addView(documentId:string,kind:WorkspaceViewKind='tab',windowId='local'){
    document(documentId);const entry:WorkspaceViewEntry={id:newModelId(),documentId,kind,windowId,presentation:null,module};views.set(entry.id,entry);emit();return entry;
  }
  function addDocument(structure:Structure|null=null,label?:string,fragment?:FragmentSnapshot,result?:TrajectoryResult,initialInput?:ResultInputIntent,activateNew=true,analysisBinding?:WorkspaceDocumentEntry['analysisBinding'],preparedStore?:ModelStore){
    if(label===undefined){if(structure?.name)label=workspaceDocumentLabel(structure.name);else{const used=new Set([...documents.values()].map(entry=>entry.label));do{label=`task${++taskSerial}`;}while(used.has(label));}}
    if(structure)structure=periodicWorkingStructure(structure);
    const initialStructure=structure??{id:newModelId(),name:label,format:'builder' as const,atoms:[],bonds:[],charge:null,multiplicity:null,notes:[],dimension:3 as const};
    const store=preparedStore??createModelStore(initialStructure,fragment?.assignments,fragment?.internalCoordinates,fragment,analysisBinding?.id),id=store.getSnapshot().id;
    if(documents.has(id))throw new Error('模型文档身份已存在，未重复发布。');
    if(!structure){store.setElectronicState(0,1);store.markApplied();}
    const entry:WorkspaceDocumentEntry={id,epoch:newModelId(),store,label,initialElectronicState:Object.freeze(initialBaseElectronicState(initialStructure)),get electronicStateConfirmed(){return store.getSnapshot().electronicStateConfirmed===true;},drafts:{},inputDirty:{gaussian:false,orca:false},runtime:{ownerId:null,phase:'idle'},publicationSerial:0,sourceEpoch:0,...(result?{result}:{}),...(analysisBinding?{analysisBinding}:{}),...(initialInput?{initialInput:clone(initialInput)}:{})};
    documents.set(id,entry);subscribeDocument(entry);const first=addView(id);if(activateNew)activate(first.id);return entry;
  }
  /** Allocate a private store identity for source/asset preparation. No tab,
   * activation, dirty change or subscriber is published until commit succeeds. */
  function prepareFragmentDocument(input:FragmentSnapshot,label=workspaceDocumentLabel(input.structure.name)){
    const fragment=clone(input);fragment.structure=periodicWorkingStructure(fragment.structure);
    const store=createModelStore(fragment.structure,fragment.assignments,fragment.internalCoordinates,fragment);
    const id=store.getSnapshot().id;let phase:'prepared'|'committed'|'cancelled'='prepared';
    return {id,
      commit(){
        if(phase!=='prepared')throw new Error('待提交模型已发布或取消。');
        const entry=batch(()=>addDocument(fragment.structure,label,fragment,undefined,undefined,true,undefined,store));
        phase='committed';return entry;
      },
      cancel(){if(phase==='committed')throw new Error('已发布模型不能按临时草稿取消。');phase='cancelled';},
      state:()=>phase,
    };
  }
  const contextKey=(entry:WorkspaceDocumentEntry)=>JSON.stringify([entry.store.getContext('gaussian'),entry.store.getContext('orca')]);
  /** Independent working copy for a pending edit. Source attachments and native
   * owners are deliberately not cloned; original atom identities are retained. */
  function copyForModeling(stamp:WorkspaceActivationStamp){
    const parent=assertCurrent(stamp),source=parent.store.getSnapshot();
    const contexts={gaussian:parent.store.getContext('gaussian'),orca:parent.store.getContext('orca')};
    const activeScope=JSON.stringify(contexts.orca)===JSON.stringify({assignments:source.draft.assignments,coordinates:source.internalCoordinates??[]})?'orca':'gaussian';
    const used=new Set([...documents.values()].map(entry=>entry.label));let label=parent.label+'-建模',serial=2;while(used.has(label))label=parent.label+'-建模-'+serial++;
    const fragment:FragmentSnapshot=clone({structure:parent.store.getPendingScientificEditBase?.()??source.draft.structure,assignments:source.draft.assignments,auxiliaryRelations:source.auxiliaryRelations,deletedBonds:source.deletedBonds,attachmentPorts:source.attachmentPorts,internalCoordinates:source.internalCoordinates,sharedConstraints:source.sharedConstraints,coordinateObjects:source.coordinateObjects,gaussianBoundCoordinates:source.gaussianBoundCoordinates});
    return batch(()=>{
      const child=addDocument(fragment.structure,label,fragment,undefined,undefined,false);
      for(const item of views.values())if(item.documentId===child.id)item.module='modeling';
      try{
        for(const engine of ['gaussian','orca'] as const){const context=contexts[engine];if(context)child.store.synchronizeContext(context.assignments,context.coordinates,engine);}
        child.store.synchronizeContext(fragment.assignments,fragment.internalCoordinates??[],activeScope);
        if(source.gaussianBasisState)child.store.synchronizeGaussianBasisState?.(clone(source.gaussianBasisState));
        const structure=fragment.structure,sameElectronicSource=structure.charge===source.draft.structure.charge&&structure.multiplicity===source.draft.structure.multiplicity&&JSON.stringify(structure.atoms.map(atom=>[atom.id,atom.element]))===JSON.stringify(source.draft.structure.atoms.map(atom=>[atom.id,atom.element]));
        if(structure.charge!==null&&structure.multiplicity!==null)child.store.setElectronicState(structure.charge,structure.multiplicity,sameElectronicSource&&source.electronicStateConfirmed===true);
        child.store.select(clone(source.selection));
        child.drafts=clone(parent.drafts);child.inputDirty=clone(parent.inputDirty);
        emit();return child;
      }catch(error){closeDocument(child.id,true);throw error;}
    });
  }
  function deriveDocument(stamp:WorkspaceActivationStamp,candidate:StructureTransformCandidate,operationLabel=candidate.operation){
    const parent=assertCurrent(stamp);editableDocument(parent.id);assertInputTaskIdle(parent);
    const source=parent.store.getSnapshot();
    const contexts={gaussian:parent.store.getContext('gaussian'),orca:parent.store.getContext('orca')};
    const activeScope=JSON.stringify(contexts.orca)===JSON.stringify({assignments:source.draft.assignments,coordinates:source.internalCoordinates??[]})?'orca':'gaussian';
    const prepared=prepareDerivedStructure(source,candidate,contexts);
    const root=`${parent.label}-${operationLabel.trim()||candidate.operation}`,used=new Set([...documents.values()].map(entry=>entry.label));
    let label=root,suffix=2;while(used.has(label))label=`${root}-${suffix++}`;
    prepared.fragment.structure.id=newModelId();prepared.fragment.structure.name=label;
    return batch(()=>{
      const child=addDocument(prepared.fragment.structure,label,prepared.fragment);
      try{
      for(const engine of ['gaussian','orca'] as const){const context=prepared.contexts[engine];if(context)child.store.synchronizeContext(context.assignments,context.coordinates,engine);}
      // Restore the active source projection after mapping inactive contexts.
      child.store.synchronizeContext(prepared.fragment.assignments,prepared.fragment.internalCoordinates??[],activeScope);
      const electronic=child.store.getSnapshot().draft.structure;
      if(electronic.charge!==null&&electronic.multiplicity!==null)child.store.setElectronicState(electronic.charge,electronic.multiplicity,prepared.electronicStateConfirmed);
      child.derivation=freezeJSON({parentDocumentId:parent.id,parentDocumentEpoch:parent.epoch,parentRevision:source.revision,
        operation:candidate.operation,sourceStructure:clone(source.draft.structure),atomMapping:clone(candidate.atomMapping)});
      creations.push({entry:child,views:[...views.values()].filter(view=>view.documentId===child.id),parentViewId:stamp.viewId,parentId:parent.id,parentEpoch:parent.epoch,
        baseline:derivedDocumentContent(child.store.getSnapshot()),contexts:contextKey(child),parentContent:derivedDocumentContent(source)});
      creationRedo.length=0;emit();return child;
      }catch(error){closeDocument(child.id,true);activeViewId=stamp.viewId;activationEpoch++;emit();throw error;}
    });
  }
  function derivedCreationBlockReason(id:string):string|null{
    const entry=document(id),creation=creations.find(item=>item.entry.id===id);
    if(!creation)return null;
    if(entry.store.hasTransaction?.()||entry.store.isRuntimeSessionActive?.()||busyPhases.has(entry.runtime.phase))return '派生结构仍在编辑或运行，请先结束当前操作。';
    if(entry.store.getSnapshot().canUndo)return '请先撤销派生结构的后续编辑。';
    if(derivedDocumentContent(entry.store.getSnapshot())!==creation.baseline||contextKey(entry)!==creation.contexts)return '派生结构仍有未撤销的结构、电子态或输入定义修改。';
    if(entry.inputDirty.gaussian||entry.inputDirty.orca||inputTask?.documentId===id)return '派生结构仍被输入任务使用，请先结束或切换该输入任务。';
    if(consumers.get(id)?.size)return [...consumers.get(id)!.values()][0];
    if([...documents.values()].some(child=>child.derivation?.parentDocumentId===id))return '派生结构仍有下游结构，请先撤销或关闭下游结构。';
    if([...views.values()].some(item=>item.documentId===id&&item.kind==='floating'))return '派生结构仍在独立窗口中，请先停靠该窗口。';
    const parent=documents.get(creation.parentId);if(!parent||parent.epoch!==creation.parentEpoch)return '父结构已关闭，不能撤销本次派生创建。';
    return null;
  }
  function historyDocument(id?:string){return id?editableDocument(id):activeViewId?editableDocument(view(activeViewId).documentId):undefined;}
  function undo(id?:string):boolean{
    const entry=historyDocument(id);if(!entry)return false;
    if(entry.store.getSnapshot().canUndo){entry.store.undo();return true;}
    const index=creations.findIndex(item=>item.entry.id===entry.id);if(index<0)return false;
    const reason=derivedCreationBlockReason(entry.id);if(reason)throw new Error(reason);
    return batch(()=>{
      const creation=creations[index];creation.views=[...views.values()].filter(item=>item.documentId===entry.id);
      unsubscribers.get(entry.id)?.();unsubscribers.delete(entry.id);documents.delete(entry.id);
      for(const item of creation.views)views.delete(item.id);
      if(!views.has(creation.parentViewId))creation.parentViewId=addView(creation.parentId).id;
      activeViewId=creation.parentViewId;module=view(activeViewId).module;activationEpoch++;creations.splice(index,1);creationRedo.push(creation);emit();return true;
    });
  }
  function redo(id?:string):boolean{
    const entry=historyDocument(id);if(!entry)return false;
    const creation=creationRedo.at(-1);
    if(creation&&creation.parentId===entry.id){
      if(entry.epoch!==creation.parentEpoch||derivedDocumentContent(entry.store.getSnapshot())!==creation.parentContent)throw new Error('父结构已修改，不能重做旧的派生创建。');
      if(derivedDocumentContent(creation.entry.store.getSnapshot())!==creation.baseline||contextKey(creation.entry)!==creation.contexts)throw new Error('已关闭的派生结构已变化，不能重做旧的派生创建。');
      assertInputTaskIdle(entry);
      return batch(()=>{documents.set(creation.entry.id,creation.entry);subscribeDocument(creation.entry);for(const item of creation.views)views.set(item.id,item);
        activeViewId=creation.views[0].id;module=view(activeViewId).module;activationEpoch++;creationRedo.pop();creations.push(creation);emit();return true;});
    }
    if(entry.store.getSnapshot().canRedo){entry.store.redo();return true;}return false;
  }
  function canUndo(id?:string){const entry=historyDocument(id);return Boolean(entry&&(entry.store.getSnapshot().canUndo||creations.some(item=>item.entry.id===entry.id)));}
  function canRedo(id?:string){const entry=historyDocument(id);return Boolean(entry&&(entry.store.getSnapshot().canRedo||creationRedo.at(-1)?.parentId===entry.id));}
  function registerConsumer(id:string,consumerId:string,reason='派生结构仍被下游任务使用，请先结束该任务。'){
    document(id);const owned=consumers.get(id)??new Map<string,string>();if(owned.has(consumerId))throw new Error('下游消费者身份已注册。');owned.set(consumerId,reason);consumers.set(id,owned);emit();
    return ()=>{if(consumers.get(id)!==owned)return;owned.delete(consumerId);if(!owned.size)consumers.delete(id);emit();};
  }
  function focusFallback(){activeViewId=null;const fallback=views.keys().next().value;if(fallback)activate(fallback);else{retainInputTask();inputTask=null;inputActivationEpoch++;activationEpoch++;}}
  function closeView(id:string){view(id);views.delete(id);if(activeViewId===id)focusFallback();emit();}
  /** Replace an explicitly confirmed analysis source, never an editable Store.
   * Source/cache disposal remains with the analysis attachment owner. */
  function replaceResultDocument(id:string,result:TrajectoryResult){const entry=document(id);if(!entry.result)throw new Error('只有结果文档可替换分析来源。');entry.result=result;entry.label=workspaceDocumentLabel(result.label);entry.sourceEpoch++;emit();}
  function addAnalysisDocument(result:TrajectoryResult,resolvedStructure:Structure,bindingId:string,activateNew=true,initialModule?:WorkspaceModule){
    if(!initialModule||activateNew)return addDocument(resolvedStructure,workspaceDocumentLabel(result.label),undefined,undefined,undefined,activateNew,{id:bindingId,result});
    return batch(()=>{const entry=addDocument(resolvedStructure,workspaceDocumentLabel(result.label),undefined,undefined,undefined,activateNew,{id:bindingId,result});
      for(const value of views.values())if(value.documentId===entry.id)value.module=initialModule;emit();return entry;});
  }
  function addEditableResultDocument(result:TrajectoryResult,resolvedStructure:Structure,activateNew=true){
    const entry=addAnalysisDocument(result,resolvedStructure,`trajectory:${result.id}`,activateNew);entry.legacyResult=result;emit();return entry;
  }
  const trajectoryWorkingContent=(model:ReturnType<ModelStore['getSnapshot']>)=>JSON.stringify([derivedDocumentContent(model),model.cellCheckpoint??null]);
  function rememberTrajectoryBaseline(entry:WorkspaceDocumentEntry){const model=entry.store.getSnapshot();trajectoryBaselines.set(entry,{revision:model.revision,content:trajectoryWorkingContent(model)});}
  function trajectoryHasUnsavedEdits(entry:WorkspaceDocumentEntry){
    if(entry.inputDirty.gaussian||entry.inputDirty.orca)return true;
    const model=entry.store.getSnapshot();if(!model.draft.dirty)return false;
    const baseline=trajectoryBaselines.get(entry);
    // Mounting an input form passively initializes gaussianBasisState and can
    // mark a source dirty without a model command. It is safe only while every
    // other retained field, scientific revision and analysis binding still match.
    // Explicit basis commands increment revision; input edits have their own flag.
    return !baseline||model.revision!==baseline.revision||!analysisAvailable(entry.id)||trajectoryWorkingContent(model)!==baseline.content;
  }
  /** A stage collection keeps its tab across runs. Reopening the same revision
   * preserves browsing and edits; an actual collection update replaces its attachment. */
  function openTrajectoryDocument(result:TrajectoryResult,identity:WorkspaceTrajectoryIdentity,frameIds:readonly string[],activateNew=true){
    if(Object.values(identity).some(value=>typeof value!=='string'||!value)||frameIds.length!==result.frames.length||frameIds.some(id=>!id)||new Set(frameIds).size!==frameIds.length||!result.initialStructure)throw new Error('轨迹集合或帧身份不完整。');
    const key=workspaceTrajectoryKey(identity),existing=[...documents.values()].find(entry=>entry.trajectory&&workspaceTrajectoryKey(entry.trajectory.identity)===key);
    if(existing)return batch(()=>{
      if(existing.legacyResult?.id!==result.id){
        if(trajectoryHasUnsavedEdits(existing))throw new Error('轨迹页面有未保存的模型或输入修改，请先保存为独立建模页再更新集合。');
        replaceAnalysisDocument(existing.id,result,result.initialStructure,`trajectory:${result.id}`);
        rememberTrajectoryBaseline(existing);
        existing.legacyResult=result;
        existing.trajectory={identity:freezeJSON(clone(identity)),frameIds:Object.freeze([...frameIds]),currentFrameId:frameIds.includes(existing.trajectory!.currentFrameId)?existing.trajectory!.currentFrameId:frameIds[0]??''};emit();
      }
      if(activateNew){const target=[...views.values()].find(item=>item.documentId===existing.id)??addView(existing.id);activate(target.id);}return existing;
    });
    return batch(()=>{
      const entry=addEditableResultDocument(result,result.initialStructure,activateNew);
      rememberTrajectoryBaseline(entry);
      entry.trajectory={identity:freezeJSON(clone(identity)),frameIds:Object.freeze([...frameIds]),currentFrameId:frameIds[0]??''};
      entry.conformerGroup={taskId:identity.taskId,role:'collection'};
      emit();return entry;
    });
  }
  function selectTrajectoryFrame(id:string,frameId:string){
    const entry=document(id),binding=entry.trajectory;
    if(!binding||!binding.frameIds.includes(frameId))throw new Error('轨迹帧不属于当前文档。');
    if(binding.currentFrameId!==frameId){entry.trajectory={...binding,currentFrameId:frameId};emit();}
  }
  function replaceAnalysisDocument(id:string,result:TrajectoryResult,resolvedStructure:Structure,bindingId:string){
    resolvedStructure=periodicWorkingStructure(resolvedStructure);
    const entry=editableDocument(id);if(!entry.analysisBinding)throw new Error('只有后处理模型可替换分析来源。');
    assertInputTaskIdle(entry);
    const previous=entry.analysisBinding,label=entry.label;
    entry.analysisBinding={id:bindingId,result};entry.label=workspaceDocumentLabel(result.label);
    try{entry.store.replaceAnalysisSource!(resolvedStructure,bindingId);}catch(error){entry.analysisBinding=previous;entry.label=label;throw error;}
  }
  function analysisAvailable(id:string){const entry=documents.get(id);return Boolean(entry?.analysisBinding&&entry.store.getSnapshot().analysisBindingId===entry.analysisBinding.id);}
  /** Register applicability only. Existing graphs, labels, history and source
   * attachments remain owned by their original document/source. */
  function bindExistingAnalysis(id:string,bindingId:string){
    const entry=editableDocument(id),snapshot=entry.store.getSnapshot();assertInputTaskIdle(entry);
    const token=snapshot.analysisBindingId??bindingId;
    if(!entry.store.bindAnalysisContext?.(token,snapshot.id,snapshot.revision))throw Error('来源模型已修改，未关联迟到的分析。');
    return token;
  }
  function closeDocument(id:string,discardUnsaved=false){
    const entry=document(id);
    if(busyPhases.has(entry.runtime.phase))throw new Error('文档仍在运行或暂停，请先停止并取得真实结束回执。');
    if((entry.store.getSnapshot().draft.dirty||entry.inputDirty.gaussian||entry.inputDirty.orca)&&!discardUnsaved)throw new Error('模型或输入草稿有未保存修改，请明确确认关闭。');
    unsubscribers.get(id)?.();unsubscribers.delete(id);documents.delete(id);
    consumers.delete(id);
    projectAttachmentRefs.delete(id);
    for(const history of [creations,creationRedo])for(let index=history.length-1;index>=0;index--)if(history[index].entry.id===id||history[index].parentId===id)history.splice(index,1);
    documentInputTasks.delete(id);if(inputTask?.documentId===id)inputTask=null;
    if(previousInputTask?.documentId===id)previousInputTask=null;
    if(borrowedInputTask?.documentId===id)borrowedInputTask=null;
    for(const item of [...views.values()])if(item.documentId===id)views.delete(item.id);
    if(activeViewId&&!views.has(activeViewId))focusFallback();emit();
    entry.store.setScientificEditGuard?.(null);
    const candidates=new Set([entry.result,entry.legacyResult,entry.analysisBinding?.result].filter((result):result is TrajectoryResult=>Boolean(result)));
    const live=new Set([...documents.values()].flatMap(other=>[other.result,other.legacyResult,other.analysisBinding?.result]));
    return Promise.all([...candidates].filter(result=>!live.has(result)).map(releaseResult)).then(()=>undefined);
  }
  const discardResultKey=(entry:WorkspaceDocumentEntry)=>JSON.stringify([entry.result?.id,entry.legacyResult?.id,entry.analysisBinding?.id,entry.analysisBinding?.result.id,entry.trajectory,entry.conformerGroup,projectAttachmentRefs.get(entry.id)]);
  function discardDescendants(roots:readonly string[]){
    const ids=new Set(roots),children=new Map<string,string[]>();for(const id of ids)document(id);
    for(const child of documents.values()){const parent=child.derivation&&documents.get(child.derivation.parentDocumentId);if(!parent||child.derivation!.parentDocumentEpoch!==parent.epoch)continue;const rows=children.get(parent.id)??[];rows.push(child.id);children.set(parent.id,rows);}
    for(const id of ids)for(const childId of children.get(id)??[])ids.add(childId);
    return [...ids];
  }
  function planDiscardDocuments(rootDocumentIds:readonly string[]):WorkspaceDiscardPlan{
    if(!Array.isArray(rootDocumentIds)||!rootDocumentIds.length||rootDocumentIds.some(id=>typeof id!=='string'||!id))throw Error('丢弃范围必须包含明确的文档身份。');
    const roots=[...new Set(rootDocumentIds)],entries=discardDescendants(roots).map(document);
    const rows=entries.map(entry=>Object.freeze({id:entry.id,epoch:entry.epoch,revision:entry.store.getSnapshot().revision,sourceEpoch:entry.sourceEpoch,label:entry.label,
      hasData:Boolean(entry.result||entry.legacyResult||entry.analysisBinding||Object.keys(projectAttachmentRefs.get(entry.id)??{}).length),readOnly:readOnlyResult(entry),consumerIds:Object.freeze([...consumers.get(entry.id)?.keys()??[]]),consumerReasons:Object.freeze([...consumers.get(entry.id)?.values()??[]])}));
    const plan:WorkspaceDiscardPlan=Object.freeze({id:newModelId(),rootDocumentIds:Object.freeze(roots),documentIds:Object.freeze(entries.map(entry=>entry.id)),documents:Object.freeze(rows),requiresConfirmation:rows.length>1||rows.some(row=>row.hasData||row.consumerReasons.length>0)});
    discardPlans.set(plan,{roots,entries,models:entries.map(entry=>entry.store.getSnapshot()),drafts:entries.map(entry=>JSON.stringify([entry.drafts,entry.inputDirty])),consumers:entries.map(entry=>new Set(consumers.get(entry.id)?.keys())),sourceEpochs:entries.map(entry=>entry.sourceEpoch),resultKeys:entries.map(discardResultKey)});
    return plan;
  }
  function assertDiscardDocumentsCurrent(plan:WorkspaceDiscardPlan){
    const lease=discardPlans.get(plan);if(!lease)throw Error('丢弃计划不是当前工作区签发的确认范围，请重新确认。');
    const currentIds=discardDescendants(lease.roots);
    const plannedIds=new Set(plan.documentIds);
    if(currentIds.length!==plannedIds.size||currentIds.some(id=>!plannedIds.has(id)))throw Error('待丢弃的下游范围已变化，请重新确认完整影响。');
    lease.entries.forEach((entry,index)=>{
      const current=documents.get(entry.id);
      if(current!==entry||current.epoch!==plan.documents[index].epoch||current.sourceEpoch!==lease.sourceEpochs[index]||current.store.getSnapshot()!==lease.models[index]||JSON.stringify([current.drafts,current.inputDirty])!==lease.drafts[index]||discardResultKey(current)!==lease.resultKeys[index])throw Error('待丢弃的文档、来源或结果已变化，请重新确认。');
      if([...consumers.get(entry.id)?.keys()??[]].some(id=>!lease.consumers[index].has(id)))throw Error('待丢弃文档新增了下游使用者，请重新确认。');
      assertInputTaskIdle(current);
    });return lease;
  }
  function prepareDiscardDocuments(plan:WorkspaceDiscardPlan):WorkspaceDiscardTransaction{
    const lease=assertDiscardDocumentsCurrent(plan);let committed=false,inflight:Promise<void>|undefined;
    const remaining=new Set(lease.entries.flatMap(entry=>[entry.result,entry.legacyResult,entry.analysisBinding?.result].filter((result):result is TrajectoryResult=>Boolean(result))));
    const transaction:WorkspaceDiscardTransaction={
      assertCurrent:()=>{if(!committed)assertDiscardDocumentsCurrent(plan);},
      commit(){
        if(committed)return;assertDiscardDocumentsCurrent(plan);
        batch(()=>{
          const retiring=new Set(plan.documentIds);
          for(const entry of lease.entries){unsubscribers.get(entry.id)?.();unsubscribers.delete(entry.id);documents.delete(entry.id);consumers.delete(entry.id);projectAttachmentRefs.delete(entry.id);documentInputTasks.delete(entry.id);entry.store.setScientificEditGuard?.(null);}
          for(const history of [creations,creationRedo])for(let index=history.length-1;index>=0;index--)if(retiring.has(history[index].entry.id)||retiring.has(history[index].parentId))history.splice(index,1);
          for(const [id,item]of views)if(retiring.has(item.documentId))views.delete(id);
          if(inputTask&&retiring.has(inputTask.documentId))inputTask=null;if(previousInputTask&&retiring.has(previousInputTask.documentId))previousInputTask=null;if(borrowedInputTask&&retiring.has(borrowedInputTask.documentId))borrowedInputTask=null;
          if(activeViewId&&!views.has(activeViewId))focusFallback();committed=true;
          discardPlans.delete(plan);lease.entries=[];lease.models=[];lease.drafts=[];lease.consumers=[];lease.sourceEpochs=[];lease.resultKeys=[];
          pendingDiscards.set(plan.id,{documentIds:plan.documentIds,remaining,release:transaction.release});emit();
        });
      },
      release(){
        if(!committed)return Promise.reject(Error('丢弃尚未提交，不能释放仍在使用的结果。'));
        if(inflight)return inflight;
        inflight=(async()=>{
          const live=new Set([...documents.values()].flatMap(entry=>[entry.result,entry.legacyResult,entry.analysisBinding?.result]));
          const failures:unknown[]=[];
          await Promise.all([...remaining].map(async result=>{if(live.has(result)){remaining.delete(result);return;}try{await releaseResult(result);remaining.delete(result);}catch(error){failures.push(error);}}));
          if(!remaining.size)pendingDiscards.delete(plan.id);
          if(failures.length)throw Object.assign(new AggregateError(failures,'内容已丢弃，但部分结果资源尚未释放；保留待收尾owner。'),{code:'WORKSPACE_DISCARD_CLEANUP_PENDING',documentIds:plan.documentIds,pendingResults:[...remaining].map(result=>result.id)});
        })().finally(()=>{inflight=undefined;});return inflight;
      },
    };return transaction;
  }
  function stamp():WorkspaceActivationStamp{
    if(!activeViewId)throw new Error('没有活动结构视图。');const currentView=view(activeViewId),current=document(currentView.documentId);
    return {documentId:current.id,documentEpoch:current.epoch,revision:current.store.getSnapshot().revision,viewId:currentView.id,activationEpoch};
  }
  function assertIdentityCurrent(stamp:WorkspaceActivationStamp){
    const current=documents.get(stamp.documentId),currentView=views.get(stamp.viewId);
    if(!current||!currentView||current.epoch!==stamp.documentEpoch||currentView.documentId!==current.id
      ||activeViewId!==stamp.viewId||activationEpoch!==stamp.activationEpoch)throw new Error('结构、视图或活动上下文已变化，请重新操作。');
    return current;
  }
  function assertCurrent(stamp:WorkspaceActivationStamp){const current=assertIdentityCurrent(stamp);if(current.store.getSnapshot().revision!==stamp.revision)throw new Error('模型修订已变化，请重新操作。');return current;}
  function assertRuntimeCurrent(stamp:WorkspaceActivationStamp){const current=documents.get(stamp.documentId);if(stamp.activationEpoch<restoredActivationFloor||!current||current.epoch!==stamp.documentEpoch||current.store.getSnapshot().revision!==stamp.revision)throw new Error('运行所属文档或模型修订已变化。');return current;}
  function source(id:string):WorkspaceTaskSource{
    const entry=document(id);if(readOnlyResult(entry))throw new Error('请先提取结果帧为新模型，再选择为输入来源。');const model=entry.store.getSnapshot(),structure=clone(model.draft.structure);
    return {documentId:id,documentEpoch:entry.epoch,sourceEpoch:entry.sourceEpoch,revision:model.revision,label:entry.label,structure,charge:structure.charge??0,multiplicity:structure.multiplicity??1,confirmed:entry.electronicStateConfirmed,geometryUnits:'angstrom'};
  }
  function sourceIsCurrent(bound:WorkspaceTaskSource){const current=documents.get(bound.documentId);return Boolean(current&&!readOnlyResult(current)&&current.epoch===bound.documentEpoch&&current.sourceEpoch===bound.sourceEpoch&&current.store.getSnapshot().revision===bound.revision);}
  function setDraft(id:string,engine:'gaussian'|'orca',value:JsonValue,dirty=true){
    const entry=editableDocument(id);
    let taskSeeded=false;
    if(!documentInputTasks.has(id)){
      const seeded=Object.freeze({id:newModelId(),documentId:id,activationEpoch:++inputActivationEpoch});
      documentInputTasks.set(id,seeded);
      if(!borrowedInputTask&&!inputTask&&activeViewId&&views.get(activeViewId)?.documentId===id){
        inputTask=seeded;
        taskSeeded=true;
      }
    }
    if(JSON.stringify(entry.drafts[engine])===JSON.stringify(value)&&entry.inputDirty[engine]===dirty){
      if(taskSeeded)emit();
      return;
    }
    entry.drafts[engine]=freezeJSON(clone(value));entry.inputDirty[engine]=dirty;emit();
  }
  function claimRuntime(id:string,ownerId:string){if(typeof ownerId!=='string'||!ownerId.length||ownerId.length>200||!/^[-a-zA-Z0-9_.:]+$/.test(ownerId))throw new Error('运行协调者身份无效。');const entry=editableDocument(id);if(entry.runtime.ownerId&&entry.runtime.ownerId!==ownerId)throw new Error('文档已有唯一运行协调者。');if(entry.runtime.ownerId===ownerId)return;entry.runtime.ownerId=ownerId;emit();}
  function runtimePhase(id:string,ownerId:string,phase:RuntimePhase){const entry=document(id);if(entry.runtime.ownerId!==ownerId)throw new Error('运行协调者身份不匹配。');entry.runtime.phase=phase;emit();}
  function releaseRuntime(id:string,ownerId:string){const entry=document(id);if(entry.runtime.ownerId!==ownerId||busyPhases.has(entry.runtime.phase))throw new Error('运行尚未结束或协调者不匹配。');entry.runtime.ownerId=null;emit();}
  function nextPublication(id:string):WorkspaceDocumentSnapshot{
    const entry=document(id);if(readOnlyResult(entry))throw new Error('结果文档不能作为可编辑模型发布。');const snapshot=clone(entry.store.getSnapshot());snapshot.draft.past=[];snapshot.draft.future=[];
    const contexts={gaussian:entry.store.getContext('gaussian'),orca:entry.store.getContext('orca')};
    // Native transport forbids undefined and functions; omission is explicit JSON.
    return JSON.parse(JSON.stringify({schema:'sciyue-workspace-document',version:1,documentEpoch:entry.epoch,publicationSerial:++entry.publicationSerial,document:snapshot,contexts,metadata:{label:entry.label,electronicStateConfirmed:entry.electronicStateConfirmed,sourceEpoch:entry.sourceEpoch,inputDirty:entry.inputDirty},ui:entry.drafts,runtime:entry.runtime})) as WorkspaceDocumentSnapshot;
  }
  function exportProjectState(options?:{saved?:boolean}):WorkspaceProjectState{
    retainInputTask();
    const encodeDocument=(entry:WorkspaceDocumentEntry):WorkspaceProjectDocument=>({
      id:entry.id,epoch:entry.epoch,label:entry.label,initialElectronicState:clone(entry.initialElectronicState),
      model:entry.store.exportProjectState!(options),drafts:clone(entry.drafts),inputDirty:options?.saved?{gaussian:false,orca:false}:clone(entry.inputDirty),
      publicationSerial:entry.publicationSerial,sourceEpoch:entry.sourceEpoch,initialInput:entry.initialInput,
      derivation:entry.derivation,trajectory:entry.trajectory,conformerGroup:entry.conformerGroup,trajectoryBaseline:trajectoryBaselines.get(entry),savedRuntimePhase:entry.runtime.phase,
      attachments:{...projectAttachmentRefs.get(entry.id),...(entry.result?{result:entry.result.id}:{}),...(entry.legacyResult?{legacyResult:entry.legacyResult.id}:{}),...(entry.analysisBinding?{analysisBinding:{id:entry.analysisBinding.id,resultId:entry.analysisBinding.result.id}}:{})},
    });
    const encodeCreation=({entry,...rest}:Creation):WorkspaceProjectCreation=>({documentId:entry.id,...rest});
    const detached=new Map(creationRedo.filter(item=>!documents.has(item.entry.id)).map(item=>[item.entry.id,item.entry]));
    const graph:WorkspaceProjectState=JSON.parse(JSON.stringify({schema:'sciyue-workspace-project',version:1,activationEpoch,activeViewId,module,taskSerial,inputActivationEpoch,inputTask,
      documentInputTasks:[...documentInputTasks.values()],previousInputTask,borrowedInputTask,
      documents:[...documents.values()].map(encodeDocument),detachedDocuments:[...detached.values()].map(encodeDocument),views:[...views.values()],creations:creations.map(encodeCreation),creationRedo:creationRedo.map(encodeCreation),linkedGroups:getModelStoreProjectLinkGroups([...documents.values()].map(entry=>entry.store))}));
    // A bounded cutoff must never leave only half of a shared history step.
    const all=new Map([...graph.documents,...graph.detachedDocuments].map(entry=>[entry.id,entry.model]));let changed=true;
    while(changed){changed=false;for(const model of all.values())for(const direction of ['past','future'] as const){
      const entries=model[direction],scan=direction==='past'?[...entries].reverse():entries;
      const bad=scan.find(entry=>entry.kind==='linked'&&entry.token.members.some(member=>all.has(member.documentId)&&!all.get(member.documentId)![direction].some(peer=>peer.kind==='linked'&&peer.token.id===entry.token.id)));
      if(bad){const index=entries.indexOf(bad),kept=direction==='past'?entries.slice(index+1):entries.slice(0,index);model[direction]=kept;model.history[direction==='past'?'omittedPast':'omittedFuture']+=entries.length-kept.length;changed=true;}
    }}
    for(const model of all.values()){model.document.canUndo=model.past.length>0;model.document.canRedo=model.future.length>0;}
    return graph;
  }
  async function restoreProjectState(saved:WorkspaceProjectState,options:WorkspaceProjectRestoreOptions={}):Promise<void>{
    for(const entry of documents.values())if(busyPhases.has(entry.runtime.phase)||entry.store.isRuntimeSessionActive?.()||entry.store.hasTransaction?.())throw new Error('请先结束当前项目的运行或编辑，再恢复项目。');
    if(saved?.schema!=='sciyue-workspace-project'||saved.version!==1)throw new Error('项目工作区格式或版本无效。');
    const data=clone(saved),validModules=new Set<WorkspaceModule>(['modeling','advanced-modeling','input','advanced','analysis','plot']);
    const integer=(value:number)=>Number.isSafeInteger(value)&&value>=0;
    if(!validModules.has(data.module)||![data.activationEpoch,data.inputActivationEpoch,data.taskSerial].every(integer)||![data.documents,data.detachedDocuments,data.views,data.documentInputTasks,data.creations,data.creationRedo,data.linkedGroups].every(Array.isArray))throw new Error('项目工作区索引无效。');
    const prepared=new Map<string,WorkspaceDocumentEntry>(),preparedViews=new Map<string,WorkspaceViewEntry>(),preparedRefs=new Map<string,WorkspaceProjectAttachments>();
    const activeIds=new Set(data.documents.map(entry=>entry.id));
    for(const value of [...data.documents,...data.detachedDocuments]){
      if(!value.id||typeof value.id!=='string'||!value.epoch||typeof value.epoch!=='string'||typeof value.label!=='string'||prepared.has(value.id)||!integer(value.publicationSerial)||!integer(value.sourceEpoch)||value.model?.document.id!==value.id||!value.initialElectronicState||!Number.isInteger(value.initialElectronicState.charge)||!Number.isInteger(value.initialElectronicState.multiplicity)||value.initialElectronicState.multiplicity<1)throw new Error('项目文档身份或初始状态无效。');
      const store=createModelStore();store.restoreProjectState!(value.model,{deferLinkedHistory:true});
      const attachments=value.attachments??{},actual=options.results?.get(value.id);
      if(actual?.result&&actual.result.id!==attachments.result||actual?.legacyResult&&actual.legacyResult.id!==attachments.legacyResult||actual?.analysisBinding&&(actual.analysisBinding.id!==attachments.analysisBinding?.id||actual.analysisBinding.result.id!==attachments.analysisBinding.resultId))throw new Error('项目结果附件与文档身份不一致。');
      const entry:WorkspaceDocumentEntry={id:value.id,epoch:value.epoch,store,label:value.label,initialElectronicState:Object.freeze(clone(value.initialElectronicState)),
        get electronicStateConfirmed(){return store.getSnapshot().electronicStateConfirmed===true;},drafts:clone(value.drafts),inputDirty:clone(value.inputDirty),runtime:{ownerId:null,phase:'idle'},publicationSerial:value.publicationSerial,sourceEpoch:value.sourceEpoch,
        ...(value.initialInput?{initialInput:freezeJSON(clone(value.initialInput))}:{}),...(value.derivation?{derivation:freezeJSON(clone(value.derivation))}:{}),...(value.trajectory?{trajectory:freezeJSON(clone(value.trajectory))}:{}),...(value.conformerGroup?{conformerGroup:freezeJSON(clone(value.conformerGroup))}:{}),...actual};
      if(entry.trajectory&&(!entry.trajectory.frameIds.length||new Set(entry.trajectory.frameIds).size!==entry.trajectory.frameIds.length||!entry.trajectory.frameIds.includes(entry.trajectory.currentFrameId)))throw new Error('项目轨迹帧身份无效。');
      if(value.trajectoryBaseline){if(!integer(value.trajectoryBaseline.revision)||typeof value.trajectoryBaseline.content!=='string')throw new Error('项目轨迹编辑基线无效。');trajectoryBaselines.set(entry,clone(value.trajectoryBaseline));}
      prepared.set(entry.id,entry);preparedRefs.set(entry.id,clone(attachments));
    }
    const checkView=(value:WorkspaceViewEntry,allowed:Set<string>)=>{if(!value.id||typeof value.id!=='string'||!allowed.has(value.documentId)||!['tab','comparison','floating'].includes(value.kind)||typeof value.windowId!=='string'||!validModules.has(value.module))throw new Error('项目视图归属无效。');};
    for(const value of data.views){checkView(value,activeIds);if(preparedViews.has(value.id))throw new Error('项目视图身份重复。');preparedViews.set(value.id,clone(value));}
    if(data.activeViewId!==null&&!preparedViews.has(data.activeViewId))throw new Error('项目活动视图不存在。');
    if(data.activeViewId&&preparedViews.get(data.activeViewId)!.module!==data.module)throw new Error('项目模块与活动视图不一致。');
    const checkTask=(value:WorkspaceInputTask|null)=>{if(value&&(!value.id||typeof value.id!=='string'||!prepared.has(value.documentId)||preparedRefs.get(value.documentId)?.result||!integer(value.activationEpoch)))throw new Error('项目输入任务归属无效。');};
    for(const task of [...data.documentInputTasks,data.inputTask,data.previousInputTask,data.borrowedInputTask])checkTask(task);
    const preparedTasks=new Map<string,WorkspaceInputTask>();for(const task of data.documentInputTasks){if(preparedTasks.has(task.documentId))throw new Error('项目输入文档有重复任务。');preparedTasks.set(task.documentId,Object.freeze(clone(task)));}
    const decodeCreation=(value:WorkspaceProjectCreation):Creation=>{
      const entry=prepared.get(value.documentId);if(!entry||!prepared.has(value.parentId)||prepared.get(value.parentId)!.epoch!==value.parentEpoch||![value.baseline,value.contexts,value.parentContent,value.parentViewId].every(part=>typeof part==='string'))throw new Error('项目派生历史归属无效。');
      for(const view of value.views){checkView(view,new Set([entry.id]));}
      const {documentId:_,...rest}=value;return {...clone(rest),entry};
    };
    const preparedCreations=data.creations.map(decodeCreation),preparedRedo=data.creationRedo.map(decodeCreation);
    if(preparedCreations.some(item=>!activeIds.has(item.entry.id))||preparedRedo.some(item=>activeIds.has(item.entry.id)))throw new Error('项目派生历史状态不一致。');
    if(data.linkedGroups.length>1)throw new Error('一个工作区目前仅支持一个活动模型关联组。');
    let preparedLinked:LinkedModels|null=null;
    try{
      for(const group of data.linkedGroups){
        if(!group.id||!group.documentIds.includes(group.referenceDocumentId)||group.documentIds.some(id=>!activeIds.has(id)||preparedRefs.get(id)?.result)||group.confirmedOrder!==null&&(!Array.isArray(group.confirmedOrder)||group.confirmedOrder.length!==group.documentIds.length))throw new Error('项目模型关联组归属无效。');
        preparedLinked=createLinkedModels(group.documentIds.map(id=>({store:prepared.get(id)!.store,isPresent:()=>documents.get(id)?.store===prepared.get(id)!.store,canEdit:()=>{const entry=documents.get(id);return Boolean(entry&&!busyPhases.has(entry.runtime.phase)&&!entry.store.isRuntimeSessionActive?.());}})),group.referenceDocumentId,{id:group.id,confirmedOrder:group.confirmedOrder});
      }
      restoreModelStoreProjectLinks([...prepared.values()].map(entry=>entry.store),(id,store)=>documents.get(id)?.store===store);
    }catch(error){preparedLinked?.dispose();throw error;}
    // All validation precedes the single graph replacement and publication.
    const oldEntries=[...documents.values()],retainedResults=new Set([...prepared.values()].flatMap(entry=>[entry.result,entry.legacyResult,entry.analysisBinding?.result].filter((result):result is TrajectoryResult=>Boolean(result))));
    batch(()=>{
      for(const unsubscribe of unsubscribers.values())unsubscribe();unsubscribers.clear();documents.clear();views.clear();consumers.clear();projectAttachmentRefs.clear();
      restoredLinkedModels?.dispose();restoredLinkedModels=preparedLinked;
      for(const id of activeIds){const entry=prepared.get(id)!;documents.set(id,entry);subscribeDocument(entry);}
      for(const [id,refs] of preparedRefs)projectAttachmentRefs.set(id,refs);
      for(const [id,value] of preparedViews)views.set(id,value);
      creations.splice(0,creations.length,...preparedCreations);creationRedo.splice(0,creationRedo.length,...preparedRedo);
      activeViewId=data.activeViewId;module=data.module;activationEpoch=Math.max(activationEpoch,data.activationEpoch)+1;taskSerial=data.taskSerial;
      restoredActivationFloor=activationEpoch;
      inputActivationEpoch=Math.max(inputActivationEpoch,data.inputActivationEpoch)+1;
      documentInputTasks.clear();for(const [id,task] of preparedTasks)documentInputTasks.set(id,task);
      inputTask=data.inputTask?Object.freeze({...data.inputTask,activationEpoch:inputActivationEpoch}):null;
      previousInputTask=data.previousInputTask?Object.freeze(clone(data.previousInputTask)):null;borrowedInputTask=data.borrowedInputTask?Object.freeze({...data.borrowedInputTask,activationEpoch:inputActivationEpoch}):null;
      if(inputTask&&!borrowedInputTask)documentInputTasks.set(inputTask.documentId,inputTask);
      emit();
    });
    const release=new Set(oldEntries.flatMap(entry=>{entry.store.setScientificEditGuard?.(null);return [entry.result,entry.legacyResult,entry.analysisBinding?.result].filter((result):result is TrajectoryResult=>Boolean(result)&&!retainedResults.has(result!));}));
    const outcomes=await Promise.allSettled([...release].map(releaseResult));
    for(const outcome of outcomes)if(outcome.status==='rejected')console.warn('项目已恢复，但旧结果资源释放失败。',outcome.reason);
  }
  return {
    getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    exportProjectState,restoreProjectState,
    adoptRestoredLinkedModels(){const group=restoredLinkedModels;restoredLinkedModels=null;return group;},
    addDocument,addBorrowedInputDocument,copyForModeling,deriveDocument,undo,redo,canUndo,canRedo,derivedCreationBlockReason,registerConsumer,planDiscardDocuments,assertDiscardDocumentsCurrent,prepareDiscardDocuments,
    pendingDiscardResources:()=>[...pendingDiscards].map(([id,value])=>({id,documentIds:value.documentIds,pendingResults:[...value.remaining].map(result=>result.id)})),
    releasePendingDiscards:()=>Promise.all([...pendingDiscards.values()].map(value=>value.release())).then(()=>undefined),
    addSourceDocument(structure:Structure){const entry=addDocument(structure,workspaceDocumentLabel(structure.name),undefined,undefined,undefined,false),initial=initialBaseElectronicState(structure);entry.store.setElectronicState(initial.charge,initial.multiplicity,false);return entry;},addPreparedInput(structure:Structure,intent:ResultInputIntent){return addDocument(structure,structure.name,undefined,undefined,intent);},addResultDocument(result:TrajectoryResult){return addDocument(null,workspaceDocumentLabel(result.label),undefined,result);},addFragmentDocument(fragment:FragmentSnapshot,label=workspaceDocumentLabel(fragment.structure.name)){return addDocument(fragment.structure,label,fragment);},prepareFragmentDocument,addView,activate,closeView,closeDocument,document,view,stamp,assertCurrent,assertIdentityCurrent,source,sourceIsCurrent,setDraft,claimRuntime,runtimePhase,releaseRuntime,nextPublication,
    beginInputTask,borrowInputTask,releaseBorrowedInputTask,ensureInputTask,inputStamp,assertInputIdentityCurrent,assertInputCurrent,assertCurrentInputTaskIdle,replaceResultDocument,addAnalysisDocument,addEditableResultDocument,openTrajectoryDocument,selectTrajectoryFrame,replaceAnalysisDocument,analysisAvailable,bindExistingAnalysis,
    setModule(next:WorkspaceModule){
      const previousModule=module,hadTask=inputTask!==null,created=next==='input'?ensureInputTaskInternal(false):null;
      if(activeViewId)view(activeViewId).module=next;
      if(module!==next){module=next;activationEpoch++;if(inputTask&&hadTask&&(previousModule==='input'||next==='input'))inputTask=Object.freeze({...inputTask,activationEpoch:++inputActivationEpoch});emit();}
      else if(created)emit();
    },
    invalidateActivation(){activationEpoch++;emit();},assertRuntimeCurrent,
    rename(id:string,label:string){document(id).label=label;emit();},
    bindConformerGroup(id:string,taskId:string,role:'initial'|'collection',initialId?:string,initialIndex?:number){const entry=document(id);if(entry.conformerGroup&&entry.conformerGroup.taskId!==taskId)throw Error('原标签已属于另一构象任务。');entry.conformerGroup=Object.freeze(role==='initial'?{taskId,role,initialId,initialIndex}:{taskId,role});const snapshot=entry.store.getSnapshot();entry.store.bindAnalysisContext?.(snapshot.analysisBindingId??`conformer:${taskId}:${id}`,snapshot.id,snapshot.revision);emit();},
    confirmElectronicState(id:string,confirmed:boolean){const entry=editableDocument(id),structure=entry.store.getSnapshot().draft.structure;if(entry.electronicStateConfirmed!==confirmed)entry.store.setElectronicState(structure.charge??0,structure.multiplicity??1,confirmed);},
    setPresentation(id:string,value:JsonValue){view(id).presentation=freezeJSON(clone(value));emit();},
    changeContainer(id:string,kind:WorkspaceViewKind,windowId:string){const entry=view(id);entry.kind=kind;entry.windowId=windowId;activationEpoch++;emit();},
    dispose(){for(const entry of documents.values())if(busyPhases.has(entry.runtime.phase))throw new Error('运行文档不能被视图清理隐式销毁。');restoredLinkedModels?.dispose();restoredLinkedModels=null;projectAttachmentRefs.clear();const ownedResults=new Set([...documents.values()].flatMap(entry=>{entry.store.setScientificEditGuard?.(null);return [entry.result,entry.legacyResult,entry.analysisBinding?.result].filter((result):result is TrajectoryResult=>Boolean(result));}));const releases=[...ownedResults].map(releaseResult);for(const pending of pendingDiscards.values())releases.push(Promise.resolve().then(()=>pending.release()));for(const unsubscribe of unsubscribers.values())unsubscribe();unsubscribers.clear();documents.clear();views.clear();creations.length=0;creationRedo.length=0;consumers.clear();activeViewId=null;inputTask=null;documentInputTasks.clear();activationEpoch++;emit();listeners.clear();return Promise.all(releases).then(()=>undefined);},
  };
}
export type WorkspaceRegistry=ReturnType<typeof createWorkspaceRegistry>;
