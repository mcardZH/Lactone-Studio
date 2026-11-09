import type {ModelCommand} from '../../modeling/contracts';
import type {AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {WorkspaceDocumentEntry} from '../../modeling/workspace-registry';
import {conformerInitialDocument} from './workspace-conformer-initial-owner';
import {workspaceSourceGeometryKey} from './workspace-source-validity';

/** Freeze commands are distinct from real geometry edits and never open a
 * result-copy prompt. The shell decides permission from the owning page role. */
export function isWorkspaceFreezeCommand(command:ModelCommand):boolean{
 return ['set-shared-atom-freeze','set-shared-freezes-enabled','replace-shared-atom-freezes','replace-shared-coordinate-freezes','set-shared-coordinate-freeze','clear-shared-freezes','delete-source-constraint'].includes(command.type);
}
interface ConformerPageEvidence {trajectory?:unknown;conformerGroup?:{role:string};legacyResult?:unknown;result?:unknown}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'?value as Record<string,unknown>:undefined;
/** A generic trajectory field is not a conformer discriminator. Legacy pages
 * without the role marker need matching typed result and binding evidence. */
export function isConformerWorkspaceResult(entry:ConformerPageEvidence):boolean{
 if(entry.conformerGroup)return entry.conformerGroup.role==='collection';
 const binding=object(entry.trajectory),identity=object(binding?.identity),ids=binding?.frameIds;
 if(!identity||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id))return false;
 const fields=['taskId','runId','stageId','collectionId'];
 if(fields.some(key=>typeof identity[key]!=='string'||!identity[key]))return false;
 return [entry.legacyResult,entry.result].some(value=>{const result=object(value),candidate=object(result?.identity),frameIds=result?.frameIds;
  return !!candidate&&fields.every(key=>candidate[key]===identity[key])&&Array.isArray(frameIds)&&frameIds.length===ids.length&&frameIds.every((id,index)=>id===ids[index]);});
}
export function workspaceFreezeEditingAllowed(entry:ConformerPageEvidence):boolean{
 return !isConformerWorkspaceResult(entry);
}

/** A denied F hold still owns its pointer gesture. Safe selection prevents a
 * click from falling through to an already selected modeling tool. `used`
 * also prevents release from becoming a fluorine element tap. */
export function readOnlyFreezeHold(key:string,freezeKey:string,allowed:boolean|undefined){
 return allowed===false&&key===freezeKey?{key,mode:'select' as const,used:true}:null;
}

/** Card edits and F edit the same Store metadata. No controller protection
 * transaction is involved, so existing runs/results retain their snapshots. */
export function commitConformerInitialFreezes(input:{task:AdvancedTaskRecord|undefined;documents:readonly WorkspaceDocumentEntry[];activeDocumentId:string|null;source:AdvancedFrameSource;atomIds:readonly string[];blocked?:boolean}):boolean{
 const entry=conformerInitialDocument(input.task,input.documents),source=input.source;
 if(input.blocked||!entry||entry.id!==input.activeDocumentId||entry.conformerGroup?.role!=='initial'||entry.trajectory)throw Error('仅当前构象初始结构页可修改冻结原子。');
 if(entry.store.hasTransaction?.())throw Error('请先确认或取消初始结构的几何预览。');
 const document=entry.store.getSnapshot();
 if(source.ref.taskId||source.ref.runId||source.ref.collectionId||source.ref.frameId||source.ref.documentId!==entry.id||source.ref.documentEpoch!==entry.epoch||source.ref.revision!==document.revision||source.structure.charge!==document.draft.structure.charge||source.structure.multiplicity!==document.draft.structure.multiplicity||workspaceSourceGeometryKey(source.structure)!==workspaceSourceGeometryKey(document.draft.structure))throw Error('冻结所属初始结构已变化，请重新选择。');
 const known=new Set(document.draft.structure.atoms.map(atom=>atom.id)),ids=[...input.atomIds];
 if(new Set(ids).size!==ids.length||ids.some(id=>!known.has(id)))throw Error('冻结原子选择含缺失或重复身份。');
 const previous=document.sharedConstraints?.frozenAtomIds??[];
 if(previous.length===ids.length&&ids.every(id=>previous.includes(id))&&(!ids.length||document.sharedConstraints?.enabled!==false))return true;
 const commands:ModelCommand[]=[{type:'replace-shared-atom-freezes',atomIds:ids}];
 if(ids.length&&document.sharedConstraints?.enabled===false)commands.push({type:'set-shared-freezes-enabled',enabled:true});
 if(entry.store.executeBatch)entry.store.executeBatch(commands,'修改构象初始冻结');
 else{entry.store.beginTransaction('修改构象初始冻结');try{for(const command of commands)entry.store.execute(command);entry.store.endTransaction();}catch(error){entry.store.cancelTransaction();throw error;}}
 return true;
}
